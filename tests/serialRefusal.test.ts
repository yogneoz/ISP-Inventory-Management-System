/**
 * Replacement-refusal copy (client-side mirror of the server gate's phrasing).
 *
 * Both exchange dialogs used to answer a bad replacement with one generic
 * sentence that named nothing — not the serial, not the state, not the branch —
 * so the operator could not tell a typo from a unit held elsewhere. These tests
 * pin the four reasons apart, because "which reason" is exactly what the message
 * has to communicate. The last block pins the dialogs themselves: one shared
 * phrasing, the server lookup for serials the cached register cannot answer,
 * and exactly one place the refusal is shown.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { describeReplacementRefusal, serialStatusLabel } from '../client/src/utils/serialRefusal';

const read = (relativePath: string): string => fs.readFileSync(path.resolve(relativePath), 'utf8');

const BRANCH = 'Branch 1 (Head Office)';
const base = { serial: 'ONU002-0007', branchId: 'WH001', branchName: BRANCH };

describe('serialStatusLabel', () => {
  test('uses the register wording operators already see', () => {
    assert.equal(serialStatusLabel('CUSTOMER_ASSIGNED'), 'CUSTOMER ASSIGNED');
    assert.equal(serialStatusLabel('pop_location_assigned'), 'POP LOCATION ASSIGNED');
    assert.equal(serialStatusLabel('IN_STOCK'), 'IN STOCK');
  });

  test('falls back to a readable form for an unknown status and never returns undefined', () => {
    assert.equal(serialStatusLabel('SOME_NEW_STATE'), 'SOME NEW STATE');
    assert.equal(serialStatusLabel(''), 'UNKNOWN');
    assert.equal(serialStatusLabel(null), 'UNKNOWN');
  });
});

describe('describeReplacementRefusal', () => {
  test('unknown serial names the serial and the branch the unit must be received into', () => {
    const message = describeReplacementRefusal({ ...base, row: undefined });
    assert.match(message, /ONU002-0007 is not in the serial register at Branch 1 \(Head Office\)/);
    assert.match(message, /must first be received into stock there/);
    assert.doesNotMatch(message, /this branch/);
    assert.equal(
      message.match(/Branch 1 \(Head Office\)/g)?.length,
      1,
      'the branch must not be repeated in the same sentence'
    );
  });

  test('a unit held elsewhere states its real status instead of "not IN_STOCK" boilerplate', () => {
    const message = describeReplacementRefusal({
      ...base,
      row: { deviceSerial: 'ONU002-0007', status: 'CUSTOMER_ASSIGNED', customerName: 'Walk Customer' },
    });
    assert.match(message, /ONU002-0007 is CUSTOMER ASSIGNED at Branch 1 \(Head Office\) to Walk Customer/);
    assert.match(message, /only IN_STOCK units can be issued as a replacement/);
  });

  test('a unit at another branch names both branches', () => {
    const message = describeReplacementRefusal({
      ...base,
      row: { deviceSerial: 'ONU002-0007', status: 'IN_STOCK', branchId: 'BRH01' },
    });
    assert.match(message, /is IN_STOCK at BRH01, not Branch 1 \(Head Office\)/);
    assert.match(message, /Pick a unit from this branch/);
  });

  test('a different model names both products', () => {
    const message = describeReplacementRefusal({
      ...base,
      productName: 'ONU ROUTER SINGLE BAND 2.4G XPON',
      row: { deviceSerial: 'ONU002-0007', status: 'IN_STOCK', branchId: 'WH001', productName: 'ONLINE UPS 3KVA' },
    });
    assert.match(message, /is a ONLINE UPS 3KVA, not the ONU ROUTER SINGLE BAND 2\.4G XPON/);
  });

  test('a usable unit still returns a sentence rather than an empty string', () => {
    const message = describeReplacementRefusal({
      ...base,
      row: { deviceSerial: 'ONU002-0007', status: 'IN_STOCK', branchId: 'WH001' },
    });
    assert.match(message, /cannot be issued as a replacement at Branch 1 \(Head Office\)/);
  });
});

describe('both exchange dialogs share the refusal path', () => {
  const DIALOGS = [
    'client/src/features/inventory/stockops/DeviceExchangePanel.tsx',
    'client/src/features/sales/CustomersManagement.tsx',
  ] as const;

  for (const file of DIALOGS) {
    test(`${file}: one phrasing, server lookup, one refusal`, () => {
      const source = read(file);

      assert.match(
        source,
        /import \{ describeReplacementRefusal \} from '[^']*utils\/serialRefusal'/,
        'the dialog must use the shared refusal wording, not its own sentence'
      );
      assert.ok(
        source.includes('describeReplacementRefusal({'),
        'a refused replacement must be phrased with the shared helper'
      );
      assert.match(
        source,
        /api\.lookupExchangeSerial\(/,
        'a serial the cached register does not know must be resolved on the server'
      );
      assert.doesNotMatch(
        source,
        /api\.lookupSerial\(/,
        'the edit-modal lookup is gated by edit-device-serials, which exchange roles do not hold'
      );
      assert.ok(
        source.includes('{ silentErrorToast: true }'),
        'the refusal is already in the dialog — the global toast must not repeat it'
      );
    });
  }
});
