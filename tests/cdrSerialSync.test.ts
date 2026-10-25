/**
 * CDR ↔ Serial Log Register sync (customer device lifecycle audit).
 *
 * The Customer Device Serials directory owns four lifecycle mutations —
 * assignment, direct status patch (collect/reverse/refund), approval-executed
 * status change and device exchange — and every one of them must flip the
 * unit's serial_log row so the register's status filter agrees with the
 * customer directory. These tests pin the mapping, the UPDATE-if-exists SQL
 * and the demo-mode mirror flip.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  serialStatusForCdrStatus,
  serialStatusForExchangeAction,
  cdrHistoryEntry,
  parseHistoryJson,
  flipSerialMirror,
  isActiveCdrStatus,
  isLegacyCdrStatus,
  upsertCdrMirror,
} from '../server/src/services/cdrSerialSync';
import {
  SERIAL_LOG_SYNC_ON_CDR_SQL,
  serialLogCdrSyncParams,
} from '../server/src/models/inventory.repo';

describe('upsertCdrMirror (one register row per serial)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'cdr-new', customerName: 'Example Customer 1', deviceSerial: 'SN-ONU002-0004',
    ponSerial: 'PON-SN-ONU002-0004', status: 'RENTAL', notes: '[RENTAL CPE ASSET - Tag: FA-1]',
    ...over,
  });

  test('isActiveCdrStatus recognises every customer-holding status', () => {
    for (const status of ['ACTIVE', 'RENTAL', 'SUSPENDED', 'SOLD', ' rental ']) {
      assert.equal(isActiveCdrStatus(status), true, status);
    }
    for (const status of ['ROUTER_COLLECTED', 'EXCHANGED', 'REFUND', 'RETURNED', 'IN_STOCK', 'DISCONNECTED', '', null, undefined]) {
      assert.equal(isActiveCdrStatus(status), false, String(status));
    }
  });

  test('an unseen serial is prepended', () => {
    const { rows, action } = upsertCdrMirror([row({ deviceSerial: 'SN-OTHER' })], row());
    assert.equal(action, 'INSERTED');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].deviceSerial, 'SN-ONU002-0004');
  });

  test('a collected row is re-activated in place, keeping the register identity', () => {
    // Re-renting a collected unit must NOT add a second row for the same
    // serial: the live table rejects that (uq_customer_device_device_serial)
    // and would roll back the deployment transaction.
    const collected = row({ id: 'cdr-old', status: 'ROUTER_COLLECTED', customerName: 'Previous Customer' });
    const { rows, action } = upsertCdrMirror([collected], row({ customerName: 'Example Customer 2' }));
    assert.equal(action, 'REACTIVATED');
    assert.equal(rows.length, 1, 'the serial must never own two rows');
    assert.equal(rows[0].id, 'cdr-old', 'the original row id is preserved');
    assert.equal(rows[0].status, 'RENTAL');
    assert.equal(rows[0].customerName, 'Example Customer 2');
    assert.equal((collected as any).status, 'ROUTER_COLLECTED', 'input array is never mutated');
  });

  test('an active row already tracking the serial is left untouched', () => {
    const active = row({ id: 'cdr-active', status: 'RENTAL', customerName: 'Example Customer 1' });
    const { rows, action } = upsertCdrMirror([active], row({ customerName: 'Someone Else' }));
    assert.equal(action, 'ALREADY_ACTIVE');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customerName, 'Example Customer 1');
  });

  test('matching is case/trim-insensitive, like the unique index', () => {
    const { action } = upsertCdrMirror([row({ deviceSerial: ' sn-onu002-0004 ' })], row());
    assert.equal(action, 'ALREADY_ACTIVE');
  });

  test('a blank serial never matches an existing row', () => {
    const { rows, action } = upsertCdrMirror([row()], row({ deviceSerial: '' }));
    assert.equal(action, 'INSERTED');
    assert.equal(rows.length, 2);
  });
});

describe('serialStatusForCdrStatus', () => {
  test('customer-holding statuses map to CUSTOMER_ASSIGNED', () => {
    for (const status of ['ACTIVE', 'RENTAL', 'SUSPENDED', 'SOLD']) {
      assert.equal(serialStatusForCdrStatus(status), 'CUSTOMER_ASSIGNED', status);
    }
  });

  test('collected/returned statuses map to IN_STOCK', () => {
    for (const status of ['ROUTER_COLLECTED', 'REFUND', 'IN_STOCK']) {
      assert.equal(serialStatusForCdrStatus(status), 'IN_STOCK', status);
    }
  });

  test('legacy read-only statuses no longer enter the register mapping', () => {
    // CPE-2 counted zero live rows in DISCONNECTED/RETURNED and pruned the
    // vocabulary from every write path, so no new state can need this mapping.
    for (const status of ['DISCONNECTED', 'RETURNED', ' disconnected ']) {
      assert.equal(serialStatusForCdrStatus(status), null, status);
      assert.equal(isLegacyCdrStatus(status), true, status);
    }
  });

  test('EXCHANGED and unknown values never auto-flip', () => {
    assert.equal(serialStatusForCdrStatus('EXCHANGED'), null);
    assert.equal(serialStatusForCdrStatus(''), null);
    assert.equal(serialStatusForCdrStatus('GARBAGE'), null);
    assert.equal(isLegacyCdrStatus('ACTIVE'), false);
    assert.equal(isLegacyCdrStatus(''), false);
  });
});

describe('serialStatusForExchangeAction', () => {
  test('RESTOCK puts the old unit back IN_STOCK', () => {
    assert.equal(serialStatusForExchangeAction('RESTOCK'), 'IN_STOCK');
    assert.equal(serialStatusForExchangeAction('restock'), 'IN_STOCK');
  });

  test('DAMAGE and DISPOSED both leave the old unit out of service', () => {
    assert.equal(serialStatusForExchangeAction('DAMAGE'), 'DAMAGED');
    assert.equal(serialStatusForExchangeAction('DISPOSED'), 'DAMAGED');
    assert.equal(serialStatusForExchangeAction(''), 'DAMAGED');
  });
});

describe('SERIAL_LOG_SYNC_ON_CDR_SQL', () => {
  test('matches the register by case/trim-insensitive device serial (the unique-index key)', () => {
    assert.match(SERIAL_LOG_SYNC_ON_CDR_SQL, /lower\(trim\(device_serial\)\) = lower\(trim\(\$6::text\)\)/);
  });

  test('IN_STOCK clears customer attribution; other statuses keep/set it', () => {
    assert.match(
      SERIAL_LOG_SYNC_ON_CDR_SQL,
      /customer_id = CASE WHEN \$1::varchar = 'IN_STOCK' THEN NULL ELSE COALESCE\(\$2::varchar, customer_id\) END/
    );
    assert.match(
      SERIAL_LOG_SYNC_ON_CDR_SQL,
      /customer_name = CASE WHEN \$1::varchar = 'IN_STOCK' THEN NULL ELSE COALESCE\(\$3::varchar, customer_name\) END/
    );
    // The status bind doubles as the guard (no invented placeholder).
    assert.ok(!SERIAL_LOG_SYNC_ON_CDR_SQL.includes("status = 'IN_STOCK'"), 'status must come from $1, not a literal');
  });

  test('appends the history entry atomically as jsonb', () => {
    assert.match(SERIAL_LOG_SYNC_ON_CDR_SQL, /history_json = \(COALESCE\(NULLIF\(history_json, ''\), '\[\]'\)::jsonb \|\| \$5::jsonb\)::text/);
  });

  test('UPDATE-if-exists only: a serial the register never received is not fabricated', () => {
    assert.match(SERIAL_LOG_SYNC_ON_CDR_SQL, /^UPDATE serial_log/);
    assert.ok(!/INSERT/i.test(SERIAL_LOG_SYNC_ON_CDR_SQL), 'sync must never insert a register row');
  });

  test('serialLogCdrSyncParams binds status, customer, branch, history, serial in order', () => {
    const p = serialLogCdrSyncParams({
      status: 'IN_STOCK',
      customerId: 'c1',
      customerName: 'Cust',
      branchId: 'WH001',
      historyEntry: '[{"status":"IN_STOCK"}]',
      deviceSerial: ' SN-1 ',
    });
    assert.deepEqual(p, ['IN_STOCK', 'c1', 'Cust', 'WH001', '[{"status":"IN_STOCK"}]', ' SN-1 ']);
  });

  test('missing customer/branch binds default to NULL (COALESCE keeps the stored values)', () => {
    const p = serialLogCdrSyncParams({ status: 'CUSTOMER_ASSIGNED', historyEntry: '[]', deviceSerial: 'SN-2' });
    assert.equal(p[1], null);
    assert.equal(p[2], null);
    assert.equal(p[3], null);
  });
});

describe('cdrHistoryEntry', () => {
  test('produces a JSON array entry with status, source and date', () => {
    const parsed = parseHistoryJson(cdrHistoryEntry('IN_STOCK', 'op-1', '2026-10-11', 'Collected'));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].status, 'IN_STOCK');
    assert.equal(parsed[0].sourceType, 'CUSTOMER_DEVICE');
    assert.equal(parsed[0].sourceId, 'op-1');
    assert.equal(parsed[0].dateAD, '2026-10-11');
    assert.equal(parsed[0].notes, 'Collected');
  });
});

describe('flipSerialMirror (demo mode)', () => {
  const base = [
    { deviceSerial: 'SN-1', status: 'CUSTOMER_ASSIGNED', customerId: 'c1', customerName: 'Cust', historyJson: '[{"status":"CUSTOMER_ASSIGNED"}]' },
    { deviceSerial: ' sn-2 ', status: 'IN_STOCK', customerId: null, customerName: null, historyJson: '[]' },
  ];

  test('flips the matching row case/trim-insensitively and appends history', () => {
    const next = flipSerialMirror(base, 'sn-1', 'IN_STOCK', null, null, cdrHistoryEntry('IN_STOCK', 'x', '2026-10-11', 'Collected'));
    assert.equal(next[0].status, 'IN_STOCK');
    assert.equal(next[0].customerId, null, 'IN_STOCK clears the customer');
    assert.equal(next[0].customerName, null);
    const history = parseHistoryJson(next[0].historyJson);
    assert.equal(history.length, 2, 'original entry preserved, flip appended');
    assert.equal(history[1].status, 'IN_STOCK');
    assert.equal(next[1].status, 'IN_STOCK', 'untouched rows stay put');
  });

  test('customer-holding flip keeps/sets the customer attribution', () => {
    const next = flipSerialMirror(base, 'SN-2', 'CUSTOMER_ASSIGNED', 'c2', 'New Cust', '[]');
    assert.equal(next[1].status, 'CUSTOMER_ASSIGNED');
    assert.equal(next[1].customerId, 'c2');
    assert.equal(next[1].customerName, 'New Cust');
  });

  test('an unknown serial leaves the array unchanged (update-if-exists)', () => {
    const next = flipSerialMirror(base, 'SN-UNKNOWN', 'IN_STOCK', null, null, '[]');
    assert.deepEqual(next, base, 'no row added for a serial the register never received');
  });

  test('never mutates the input array', () => {
    const before = JSON.stringify(base);
    flipSerialMirror(base, 'SN-1', 'IN_STOCK', null, null, '[]');
    assert.equal(JSON.stringify(base), before);
  });

  test('corrupt history_json is replaced by a fresh array instead of throwing', () => {
    const broken = [{ deviceSerial: 'SN-3', status: 'IN_STOCK', historyJson: 'not-json' }];
    const next = flipSerialMirror(broken, 'SN-3', 'CUSTOMER_ASSIGNED', 'c1', 'Cust', '[]');
    assert.deepEqual(parseHistoryJson(next[0].historyJson), []);
  });
});
