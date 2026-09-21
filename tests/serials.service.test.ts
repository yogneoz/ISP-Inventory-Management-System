import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSerial,
  serialRecordMatches,
  parseSerialHistory,
  buildOldValueExclusions,
  renameSerialsInJsonbItems,
  renameSerialsInShipmentItems,
  applyInMemorySerialRename,
  findInMemorySerialClash,
  buildSerialLogRenameStep,
  cascadeRenameJsonbTables,
  CDR_DUP_EXTRA_FRAGMENTS,
  type SqlClient,
} from '../server/src/services/serials.service';

// ---------------------------------------------------------------------------
// normalizeSerial — canonical identity (trim + uppercase)
// ---------------------------------------------------------------------------
describe('normalizeSerial', () => {
  it('trims and uppercases', () => {
    assert.equal(normalizeSerial('  sn-onu001-0001 '), 'SN-ONU001-0001');
  });
  it('maps falsy values to empty string', () => {
    assert.equal(normalizeSerial(undefined), '');
    assert.equal(normalizeSerial(null), '');
    assert.equal(normalizeSerial(''), '');
    assert.equal(normalizeSerial(0), '');
  });
  it('stringifies non-strings', () => {
    assert.equal(normalizeSerial(12345), '12345');
  });
});

// ---------------------------------------------------------------------------
// serialRecordMatches — any-one-of three-identifier match (verbatim port)
// ---------------------------------------------------------------------------
describe('serialRecordMatches', () => {
  const serial = { deviceSerial: 'SN-1', ponSerial: 'PON-1', macAddress: 'AA:BB' };

  it('matches each identifier case-insensitively (trimmed)', () => {
    assert.equal(serialRecordMatches(serial, 'sn-1', '', ''), true);
    assert.equal(serialRecordMatches(serial, '', ' pon-1 ', ''), true);
    assert.equal(serialRecordMatches(serial, '', '', 'aa:bb'), true);
  });
  it('requires non-empty old values to participate', () => {
    assert.equal(serialRecordMatches({ deviceSerial: '', ponSerial: '', macAddress: '' }, '', '', ''), false);
  });
  it('returns false for null / non-object inputs', () => {
    assert.equal(serialRecordMatches(null, 'SN-1', '', ''), false);
    assert.equal(serialRecordMatches('SN-1', 'SN-1', '', ''), false);
    assert.equal(serialRecordMatches(undefined, 'SN-1', 'PON-1', 'AA:BB'), false);
  });
  it('does not match when all identifiers differ', () => {
    assert.equal(serialRecordMatches(serial, 'SN-2', 'PON-2', 'CC:DD'), false);
  });
});

// ---------------------------------------------------------------------------
// parseSerialHistory — JSONB history parsing (string or array)
// ---------------------------------------------------------------------------
describe('parseSerialHistory', () => {
  it('passes arrays through', () => {
    const arr = [{ status: 'IN_STOCK' }];
    assert.equal(parseSerialHistory(arr), arr);
  });
  it('parses JSON strings', () => {
    assert.deepEqual(parseSerialHistory('[{"status":"IN_STOCK"}]'), [{ status: 'IN_STOCK' }]);
  });
  it('returns [] for invalid JSON / null / numbers', () => {
    assert.deepEqual(parseSerialHistory('not-json'), []);
    assert.deepEqual(parseSerialHistory(null), []);
    assert.deepEqual(parseSerialHistory(42), []);
    assert.deepEqual(parseSerialHistory('null'), []);
  });
});

// ---------------------------------------------------------------------------
// buildOldValueExclusions — SQL fragment + placeholder numbering ($2+)
// ---------------------------------------------------------------------------
describe('buildOldValueExclusions', () => {
  it('produces empty fragments when there are no old values', () => {
    const e = buildOldValueExclusions([]);
    assert.equal(e.deviceExclusion, '');
    assert.equal(e.ponExclusion, '');
    assert.equal(e.macExclusion, '');
    assert.equal(e.assetExclusion, '');
    assert.equal(e.notSelfDevice, '');
  });
  it('numbers placeholders from $2 (value searched is $1)', () => {
    const e = buildOldValueExclusions(['SN-OLD', 'PON-OLD']);
    assert.equal(
      e.deviceExclusion,
      ' AND NOT (lower(trim(device_serial)) IN (lower(trim($2)), lower(trim($3))))'
    );
    assert.equal(e.assetExclusion, ' AND NOT (lower(trim(tag_number)) IN (lower(trim($2)), lower(trim($3))))');
    assert.equal(e.notSelfDevice, e.deviceExclusion);
  });
  it('covers all four columns for one old value', () => {
    const e = buildOldValueExclusions(['SN-OLD']);
    assert.equal(e.ponExclusion, ' AND NOT (lower(trim(pon_serial)) IN (lower(trim($2))))');
    assert.equal(e.macExclusion, ' AND NOT (lower(trim(mac_address)) IN (lower(trim($2))))');
  });
});

// ---------------------------------------------------------------------------
// renameSerialsInJsonbItems / renameSerialsInShipmentItems
// ---------------------------------------------------------------------------
describe('JSONB item renames', () => {
  const oldV = { oldDeviceSerial: 'SN-OLD', oldPonSerial: 'PON-OLD', oldMacAddress: '' };
  const newV = { newDeviceSerial: 'SN-NEW', newPonSerial: 'PON-NEW', newMacAddress: null };

  it('renames matching serials in deviceSerials and reports updated=true', () => {
    const items = [{ productId: 'p1', deviceSerials: [{ deviceSerial: 'sn-old', ponSerial: 'pon-old', macAddress: 'X' }] }];
    const { items: next, updated } = renameSerialsInJsonbItems(items, oldV, newV);
    assert.equal(updated, true);
    assert.deepEqual(next[0].deviceSerials[0], { deviceSerial: 'SN-NEW', ponSerial: 'PON-NEW', macAddress: null });
  });
  it('leaves non-matching serials untouched and reports updated=false', () => {
    const items = [{ productId: 'p1', deviceSerials: [{ deviceSerial: 'SN-OTHER', ponSerial: '', macAddress: '' }] }];
    const { items: next, updated } = renameSerialsInJsonbItems(items, oldV, newV);
    assert.equal(updated, false);
    assert.equal(next[0].deviceSerials[0].deviceSerial, 'SN-OTHER');
  });
  it('does not mutate the input array (pure)', () => {
    const items = [{ productId: 'p1', deviceSerials: [{ deviceSerial: 'SN-OLD', ponSerial: 'PON-OLD', macAddress: '' }] }];
    const before = JSON.stringify(items);
    renameSerialsInJsonbItems(items, oldV, newV);
    assert.equal(JSON.stringify(items), before);
  });
  it('shipment rename also rewrites receivedSerials', () => {
    const items = [
      {
        productId: 'p1',
        deviceSerials: [{ deviceSerial: 'SN-OLD', ponSerial: 'PON-OLD', macAddress: '' }],
        receivedSerials: [{ deviceSerial: 'SN-OLD', ponSerial: 'PON-OLD', macAddress: '' }],
      },
    ];
    const { items: next, updated } = renameSerialsInShipmentItems(items, oldV, newV);
    assert.equal(updated, true);
    assert.equal(next[0].deviceSerials[0].deviceSerial, 'SN-NEW');
    assert.equal(next[0].receivedSerials[0].deviceSerial, 'SN-NEW');
  });
  it('handles items without serial lists', () => {
    const { items: next, updated } = renameSerialsInJsonbItems([{ productId: 'p1' }], oldV, newV);
    assert.equal(updated, false);
    assert.deepEqual(next, [{ productId: 'p1' }]);
  });
});

// ---------------------------------------------------------------------------
// findInMemorySerialClash — duplicate rejection helper
// ---------------------------------------------------------------------------
describe('findInMemorySerialClash', () => {
  const logs = [
    { id: 'a', deviceSerial: 'SN-1' },
    { id: 'b', deviceSerial: 'sn-2' },
  ];
  it('finds a case-insensitive clash on the new serial', () => {
    assert.deepEqual(findInMemorySerialClash(logs, 'SN-2', 'SN-OLD'), { id: 'b' });
  });
  it('returns null when the rename is a no-op (old == new)', () => {
    assert.equal(findInMemorySerialClash(logs, 'SN-1', 'sn-1'), null);
  });
  it('returns null when no row holds the new serial', () => {
    assert.equal(findInMemorySerialClash(logs, 'SN-9', 'SN-OLD'), null);
  });
});

// ---------------------------------------------------------------------------
// applyInMemorySerialRename — in-memory register sync
// ---------------------------------------------------------------------------
describe('applyInMemorySerialRename', () => {
  const base = {
    oldPonSerial: 'PON-OLD',
    oldMacAddress: '',
    newDeviceSerial: 'SN-NEW',
    newPonSerial: 'PON-NEW',
    newMacAddress: null as string | null,
    targetId: 'cd-1',
    branchId: 'WH001',
    nowIso: '2026-09-20T10:00:00.000Z',
  };

  it('renames the matching row and appends a SERIAL_CORRECTION history entry', () => {
    const logs: any[] = [
      { id: 'sl-1', deviceSerial: 'SN-OLD', ponSerial: 'PON-OLD', macAddress: null, history: [{ status: 'IN_STOCK' }], updatedAt: '' },
      { id: 'sl-2', deviceSerial: 'SN-OTHER', history: [] },
    ];
    const next = applyInMemorySerialRename(logs as any, { ...base, oldDeviceSerial: 'SN-OLD' });
    assert.equal(next.length, 2);
    assert.equal(next[0].deviceSerial, 'SN-NEW');
    assert.equal(next[0].ponSerial, 'PON-NEW');
    assert.equal(next[0].history.length, 2);
    assert.equal(next[0].history[1].status, 'SERIAL_CORRECTION');
    assert.equal(next[0].history[1].notes, 'SN-OLD→SN-NEW');
    assert.equal(next[0].updatedAt, base.nowIso);
    assert.equal(next[1].deviceSerial, 'SN-OTHER');
  });
  it('renames only the FIRST matching row when duplicates exist', () => {
    const logs: any[] = [
      { id: 'sl-1', deviceSerial: 'SN-OLD', history: [] },
      { id: 'sl-2', deviceSerial: 'SN-OLD', history: [] },
    ];
    const next = applyInMemorySerialRename(logs as any, { ...base, oldDeviceSerial: 'SN-OLD' });
    assert.equal(next[0].deviceSerial, 'SN-NEW');
    assert.equal(next[1].deviceSerial, 'SN-OLD');
  });
  it('unshifts a fresh IN_STOCK row when no row matched (correction of a register gap)', () => {
    const logs: any[] = [{ id: 'sl-2', deviceSerial: 'SN-OTHER', history: [] }];
    const next = applyInMemorySerialRename(logs as any, { ...base, oldDeviceSerial: 'SN-GHOST' });
    assert.equal(next.length, 2);
    assert.equal(next[0].deviceSerial, 'SN-NEW');
    assert.equal(next[0].status, 'IN_STOCK');
    assert.equal(next[0].sourceType, 'SERIAL_CORRECTION');
    assert.equal(next[0].branchId, 'WH001');
    assert.equal(next[0].history.length, 1);
  });
  it('does not mutate the input array', () => {
    const logs: any[] = [{ id: 'sl-1', deviceSerial: 'SN-OLD', history: [] }];
    const snapshot = JSON.stringify(logs);
    applyInMemorySerialRename(logs as any, { ...base, oldDeviceSerial: 'SN-OLD' });
    assert.equal(JSON.stringify(logs), snapshot);
  });
});

// ---------------------------------------------------------------------------
// buildSerialLogRenameStep — SQL builder for the DB rename/create
// ---------------------------------------------------------------------------
describe('buildSerialLogRenameStep', () => {
  const step = buildSerialLogRenameStep(
    {
      oldDeviceSerial: 'SN-OLD',
      newDeviceSerial: 'SN-NEW',
      newPonSerial: 'PON-NEW',
      newMacAddress: 'AA:BB',
      targetId: 'cd-9',
    },
    '2026-09-20T10:00:00.000Z'
  );

  it('builds a correction entry with the arrow notation and target id', () => {
    assert.deepEqual(step.correctionEntry, {
      status: 'SERIAL_CORRECTION',
      sourceType: 'SERIAL_CORRECTION',
      sourceId: 'cd-9',
      dateAD: '2026-09-20',
      notes: 'SN-OLD→SN-NEW',
    });
  });
  it('updateParams carries the new values + serialized history + row id', () => {
    const params = step.updateParams('sl-7', [{ status: 'IN_STOCK' }]);
    assert.deepEqual(params, ['SN-NEW', 'PON-NEW', 'AA:BB', '[{"status":"IN_STOCK"}]', 'sl-7']);
  });
  it('insertParams carries the generated id, branch and correction history', () => {
    const params = step.insertParams('sl-8', 'WH001');
    assert.deepEqual(params, [
      'sl-8',
      'SN-NEW',
      'PON-NEW',
      'AA:BB',
      null,
      'WH001',
      'cd-9',
      JSON.stringify([step.correctionEntry]),
    ]);
  });
  it('updateSql / insertSql mention the right tables and columns', () => {
    assert.match(step.updateSql, /UPDATE serial_log SET device_serial = \$1/);
    assert.match(step.insertSql, /INSERT INTO serial_log/);
    assert.match(step.selectOldSql, /lower\(trim\(device_serial\)\) = lower\(trim\(\$1\)\)/);
  });
});

// ---------------------------------------------------------------------------
// cascadeRenameJsonbTables — SQL orchestration over a mock client
// ---------------------------------------------------------------------------
describe('cascadeRenameJsonbTables', () => {
  const oldV = { oldDeviceSerial: 'SN-OLD', oldPonSerial: 'PON-OLD', oldMacAddress: 'AA:BB' };
  const newV = { newDeviceSerial: 'SN-NEW', newPonSerial: 'PON-NEW', newMacAddress: 'CC:DD' };

  /** Mock SqlClient capturing executed SQL and returning queued results. */
  function mockClient(selectResults: Record<string, any[]>) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const client: SqlClient = {
      async query(sql: string, params: unknown[] = []) {
        executed.push({ sql, params });
        if (/^SELECT id, items FROM (\w+)/.test(sql)) {
          const table = sql.match(/^SELECT id, items FROM (\w+)/)![1];
          return { rows: selectResults[table] || [], rowCount: (selectResults[table] || []).length };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    return { client, executed };
  }

  it('pre-selects all three JSONB tables with ORed ILIKE clauses for three old identifiers', async () => {
    const { client, executed } = mockClient({});
    await cascadeRenameJsonbTables(client, oldV, newV);
    const selects = executed.filter((e) => e.sql.startsWith('SELECT id, items'));
    assert.equal(selects.length, 3);
    for (const s of selects) {
      assert.match(s.sql, /purchase_invoices|shipments|stock_operations/);
      assert.match(s.sql, /items::text ILIKE \$1 OR items::text ILIKE \$2 OR items::text ILIKE \$3/);
      assert.deepEqual(s.params, ['%SN-OLD%', '%PON-OLD%', '%AA:BB%']);
    }
  });

  it('updates purchase_invoices rows whose matching serial changed', async () => {
    const { client, executed } = mockClient({
      purchase_invoices: [
        {
          id: 'pi-1',
          items: [{ productId: 'p1', deviceSerials: [{ deviceSerial: 'SN-OLD', ponSerial: 'PON-OLD', macAddress: 'AA:BB' }] }],
        },
      ],
    });
    await cascadeRenameJsonbTables(client, oldV, newV);
    const updates = executed.filter((e) => e.sql.startsWith('UPDATE purchase_invoices'));
    assert.equal(updates.length, 1);
    const written = JSON.parse(updates[0].params[0] as string);
    assert.equal(written[0].deviceSerials[0].deviceSerial, 'SN-NEW');
    assert.deepEqual(updates[0].params[1], 'pi-1');
  });

  it('skips the UPDATE when nothing changed (updated=false)', async () => {
    const { client, executed } = mockClient({
      shipments: [{ id: 'ship-1', items: [{ productId: 'p1', deviceSerials: [{ deviceSerial: 'SN-OTHER', ponSerial: '', macAddress: '' }] }] }],
    });
    await cascadeRenameJsonbTables(client, oldV, newV);
    assert.equal(executed.filter((e) => e.sql.startsWith('UPDATE shipments')).length, 0);
  });

  it('omits the MAC ILIKE clause (and its param) when no old MAC is supplied', async () => {
    const { client, executed } = mockClient({});
    await cascadeRenameJsonbTables(
      client,
      { oldDeviceSerial: 'SN-OLD', oldPonSerial: '', oldMacAddress: '' },
      newV
    );
    const select = executed.find((e) => e.sql.startsWith('SELECT id, items'))!;
    assert.equal(select.sql.includes('ILIKE $3'), false);
    assert.deepEqual(select.params, ['%SN-OLD%']);
  });
});

// ---------------------------------------------------------------------------
// CDR_DUP_EXTRA_FRAGMENTS — shared WHERE fragments
// ---------------------------------------------------------------------------
describe('CDR_DUP_EXTRA_FRAGMENTS', () => {
  it('keeps the mac_address NOT NULL guard verbatim', () => {
    assert.equal(CDR_DUP_EXTRA_FRAGMENTS.macNotNull, ' AND mac_address IS NOT NULL');
  });
});
