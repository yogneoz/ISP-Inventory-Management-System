/**
 * SER-1 / D2 — pure lifecycle mapping and demo-mode mirror tests.
 *
 * The real-DB HTTP cases live in tests/serialGateHttp.test.ts (issue + reversal
 * through the real endpoints). This file pins the rule itself:
 *   - PULLOUT → IN_TRANSIT, CONSUMABLE_ISSUE → CONSUMED, STOCK_OUT → SOLD;
 *   - a DAMAGED_STOCK line is never issued from the usable register;
 *   - the mirror flips only IN_STOCK units at the operation's branch;
 *   - a reversal restores only units still attributed to that operation;
 *   - a received pullout lands at the destination branch.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  damagedStockSerialKeys,
  issueOperationSerialsInMemory,
  issueStatusForOperation,
  receivePulloutSerialsInMemory,
  restoreOperationSerialsInMemory,
  type SerializableOperation,
} from '../server/src/services/serialOperationLifecycle.service';

const OP = {
  id: 'op-1',
  type: 'PULLOUT',
  branchId: 'b1',
  referenceNumber: 'PLT-1',
  items: [
    { productId: 'p1', quantity: 1, deviceSerials: [{ deviceSerial: 'SN-1' }] },
    { productId: 'p1', quantity: 1, condition: 'DAMAGED_STOCK', deviceSerials: [{ deviceSerial: 'SN-DMG' }] },
  ],
} as SerializableOperation;

const row = (serial: string, status = 'IN_STOCK', branchId = 'b1', extra: Record<string, any> = {}) => ({
  deviceSerial: serial,
  branchId,
  status,
  historyJson: '[]',
  sourceId: '',
  ...extra,
});

describe('SER-1 operation serial lifecycle', () => {
  test('maps each operation type to its register state', () => {
    assert.equal(issueStatusForOperation('PULLOUT'), 'IN_TRANSIT');
    assert.equal(issueStatusForOperation('consumable_issue'), 'CONSUMED');
    assert.equal(issueStatusForOperation('STOCK_OUT'), 'SOLD');
    assert.equal(issueStatusForOperation('DAMAGE'), null);
    assert.equal(issueStatusForOperation(undefined), null);
  });

  test('damaged-stock lines are excluded from the usable issue', () => {
    assert.deepEqual([...damagedStockSerialKeys(OP.items)], ['sn-dmg']);
  });

  test('issue flips only IN_STOCK units at the operation branch', () => {
    const rows = [
      row('SN-1'),
      row('SN-1-BRANCH', 'IN_STOCK', 'b2'),
      row('SN-1-SOLD', 'SOLD'),
      row('SN-DMG'),
    ];
    const entries = [
      { deviceSerial: 'SN-1', ponSerial: '', macAddress: '', productId: 'p1', productName: 'ONU' },
      { deviceSerial: 'SN-1-BRANCH', ponSerial: '', macAddress: '', productId: 'p1', productName: 'ONU' },
      { deviceSerial: 'SN-1-SOLD', ponSerial: '', macAddress: '', productId: 'p1', productName: 'ONU' },
      { deviceSerial: 'SN-DMG', ponSerial: '', macAddress: '', productId: 'p1', productName: 'ONU' },
    ];
    const out = issueOperationSerialsInMemory(rows, entries, OP, '2026-10-25');
    assert.equal(out[0].status, 'IN_TRANSIT');
    assert.equal(out[0].sourceId, 'op-1');
    assert.equal(out[1].status, 'IN_STOCK', 'another branch must not be issued');
    assert.equal(out[2].status, 'SOLD', 'an already issued unit must not be re-issued');
    assert.equal(out[3].status, 'IN_STOCK', 'a damaged-stock line is not issued from usable stock');
    assert.match(String(out[0].historyJson), /PLT-1/);
  });

  test('reversal restores only units this operation still holds', () => {
    const rows = [
      row('SN-1', 'IN_TRANSIT', 'b1', { sourceId: 'op-1' }),
      row('SN-MOVED', 'CUSTOMER_ASSIGNED', 'b1', { sourceId: 'op-1' }),
      row('SN-OTHER', 'IN_TRANSIT', 'b1', { sourceId: 'op-2' }),
    ];
    const out = restoreOperationSerialsInMemory(rows, OP, 'wrong dispatch', 'tester', '2026-10-25');
    assert.equal(out[0].status, 'IN_STOCK');
    assert.equal(out[1].status, 'CUSTOMER_ASSIGNED', 'a unit that moved on is never dragged back');
    assert.equal(out[2].status, 'IN_TRANSIT', 'another operation’s unit is untouched');
  });

  test('consumable issue issues CONSUMED and reverses to IN_STOCK', () => {
    const op = { ...OP, type: 'CONSUMABLE_ISSUE' } as SerializableOperation;
    const issued = issueOperationSerialsInMemory(
      [row('SN-C')],
      [{ deviceSerial: 'SN-C', ponSerial: '', macAddress: '', productId: 'p1', productName: 'ONU' }],
      op,
      '2026-10-25'
    );
    assert.equal(issued[0].status, 'CONSUMED');
    const restored = restoreOperationSerialsInMemory(issued, op, 'returned', 'tester', '2026-10-25');
    assert.equal(restored[0].status, 'IN_STOCK');
  });

  test('product sale issues SOLD and receipt lands a pullout at the destination', () => {
    const sale = { ...OP, type: 'STOCK_OUT' } as SerializableOperation;
    const sold = issueOperationSerialsInMemory(
      [row('SN-S')],
      [{ deviceSerial: 'SN-S', ponSerial: '', macAddress: '', productId: 'p1', productName: 'ONU' }],
      sale,
      '2026-10-25'
    );
    assert.equal(sold[0].status, 'SOLD');

    const inTransit = issueOperationSerialsInMemory(
      [row('SN-R')],
      [{ deviceSerial: 'SN-R', ponSerial: '', macAddress: '', productId: 'p1', productName: 'ONU' }],
      OP,
      '2026-10-25'
    );
    const received = receivePulloutSerialsInMemory(inTransit, OP, 'wh1', '2026-10-25');
    assert.equal(received[0].status, 'IN_STOCK');
    assert.equal(received[0].branchId, 'wh1');
  });
});
