/**
 * Shared serial gate (Slice 2 of the serial-register plan).
 *
 * Pins the ONE rule every serial-touching endpoint now resolves against —
 * planning, refusal classification, and the refusal wording — plus the demo-mode
 * twin, so the database path and the in-memory path can never disagree.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SerialGateError,
  describeGateViolation,
  findGateViolation,
  hydrateSerialEntries,
  indexGateRows,
  isSerialTracked,
  planSerialGateEntries,
  requiresPon,
  resolveSerialGateInMemory,
  serialGateKey,
} from '../server/src/services/serialGate.service';

const ONU = { id: 'p-onu', name: 'ONU ROUTER', requiresSerialTracking: true, trackingType: 'SERIAL_MAC_PON' };
const SN_ONLY = { id: 'p-sn', name: 'PATCH CORD', requiresSerialTracking: true, trackingType: 'SERIAL_ONLY' };
const FIBER = { id: 'p-fiber', name: 'FIBER CABLE', requiresSerialTracking: false, trackingType: 'QUANTITY_ONLY' };

const pair = (deviceSerial: string, ponSerial = '', macAddress = '') => ({ deviceSerial, ponSerial, macAddress });

const row = (over: Record<string, unknown> = {}) => ({
  deviceSerial: 'SN-1', ponSerial: 'PON-1', macAddress: 'AA', productId: 'p-onu',
  branchId: 'WH001', status: 'IN_STOCK', ...over,
});

const RULES = { branchId: 'WH001' };
const CTX = { action: 'sold' };

describe('serial gate rules', () => {
  test('QUANTITY_ONLY is never serial-tracked; PON is mandatory only for SERIAL_MAC_PON', () => {
    assert.equal(isSerialTracked(FIBER), false);
    assert.equal(isSerialTracked(ONU), true);
    assert.equal(isSerialTracked({ requiresSerialTracking: null } as any), true);
    assert.equal(requiresPon(ONU), true);
    assert.equal(requiresPon(SN_ONLY), false);
  });

  test('serialKey matches the register index key (trim + lowercase)', () => {
    assert.equal(serialGateKey('  Sn-1 '), 'sn-1');
  });
});

describe('planSerialGateEntries', () => {
  test('a serial-tracked line must carry exactly one device serial per unit', () => {
    assert.equal(
      planSerialGateEntries([{ productId: 'p-onu', productName: 'ONU', quantity: 2, deviceSerials: [pair('SN-1', 'PON-1')] }], [ONU]).error,
      'ONU is serial-tracked: 2 device serial(s) required, 1 provided.'
    );
  });

  test('the DEVICE SERIAL is the only required field — PON/MAC are never demanded', () => {
    assert.equal(
      planSerialGateEntries([{ productId: 'p-onu', productName: 'ONU', quantity: 1, deviceSerials: [pair('SN-1')] }], [ONU]).error,
      null
    );
    assert.equal(
      planSerialGateEntries([{ productId: 'p-sn', productName: 'CORD', quantity: 1, deviceSerials: [pair('SN-9')] }], [SN_ONLY]).error,
      null
    );
  });

  test('a MAC scanned without separators is stored canonically', () => {
    const plan = planSerialGateEntries(
      [{ productId: 'p-onu', productName: 'ONU', quantity: 1, deviceSerials: [pair('SN-1', '', 'a4c3f0b1d2e3')] }],
      [ONU]
    );
    assert.equal(plan.error, null);
    assert.equal(plan.entries[0].macAddress, 'A4:C3:F0:B1:D2:E3');
  });

  test('a device serial repeated across lines is refused once, case-insensitively', () => {
    const plan = planSerialGateEntries([
      { productId: 'p-sn', productName: 'CORD', quantity: 1, deviceSerials: [pair('SN-1')] },
      { productId: 'p-sn', productName: 'CORD', quantity: 1, deviceSerials: [pair(' sn-1 ')] },
    ], [SN_ONLY]);
    // The planner trims each slot, so the refusal names the trimmed value.
    assert.equal(plan.error, 'Duplicate device serial sn-1.');
  });

  test('QUANTITY_ONLY lines are skipped entirely; unknown products with typed serials are kept', () => {
    const plan = planSerialGateEntries([
      { productId: 'p-fiber', productName: 'FIBER', quantity: 500, deviceSerials: [] },
      { productId: 'p-legacy', productName: 'LEGACY ONU', quantity: 1, deviceSerials: [pair('SN-7', 'PON-7')] },
    ], [FIBER]);
    assert.equal(plan.error, null);
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].deviceSerial, 'SN-7');
    assert.equal(plan.entries[0].productName, 'LEGACY ONU');
  });
});

describe('findGateViolation — the rule every endpoint shares', () => {
  const entries = (list: Array<[string, string?]>) =>
    list.map(([deviceSerial, ponSerial]) => ({
      deviceSerial, ponSerial: ponSerial || '', macAddress: '', productId: 'p-onu', productName: 'ONU',
    }));

  test('an unknown serial is UNKNOWN (the silent-skip this slice removed)', () => {
    const v = findGateViolation(entries([['SN-GHOST']]), indexGateRows([]), RULES);
    assert.deepEqual(v, { code: 'UNKNOWN', deviceSerial: 'SN-GHOST' });
  });

  test('a unit that has already moved is WRONG_STATUS and names the status', () => {
    const rows = indexGateRows([row({ status: 'CUSTOMER_ASSIGNED' })]);
    assert.deepEqual(findGateViolation(entries([['SN-1']]), rows, RULES), {
      code: 'WRONG_STATUS', deviceSerial: 'SN-1', status: 'CUSTOMER_ASSIGNED',
    });
  });

  test('a unit held at another branch is WRONG_BRANCH', () => {
    const rows = indexGateRows([row({ branchId: 'BRH01' })]);
    assert.deepEqual(findGateViolation(entries([['SN-1']]), rows, RULES), {
      code: 'WRONG_BRANCH', deviceSerial: 'SN-1', branchId: 'BRH01',
    });
  });

  test('a unit belonging to another product is WRONG_PRODUCT', () => {
    const rows = indexGateRows([row({ productId: 'p-other' })]);
    assert.equal(findGateViolation(entries([['SN-1']]), rows, RULES)?.code, 'WRONG_PRODUCT');
  });

  test('a PON/MAC the caller DID send is still checked; a blank one resolves from the register', () => {
    const rows = indexGateRows([row()]);
    assert.deepEqual(
      findGateViolation(entries([['SN-1', 'PON-WRONG']]), rows, { ...RULES, matchPonWhenProvided: true }),
      { code: 'PON_MISMATCH', deviceSerial: 'SN-1', ponSerial: 'PON-WRONG' }
    );
    assert.equal(findGateViolation(entries([['SN-1']]), rows, { ...RULES, matchPonWhenProvided: true }), null);
    // MAC: matched when given, never demanded, and compared canonically.
    const macRows = indexGateRows([row({ macAddress: 'AA:BB:CC:DD:EE:FF' })]);
    const withMac = entries([['SN-1']]).map((e) => ({ ...e, macAddress: 'AABBCCDDEEFF' }));
    assert.equal(findGateViolation(withMac, macRows, RULES), null);
    const wrongMac = entries([['SN-1']]).map((e) => ({ ...e, macAddress: 'AA:BB:CC:DD:EE:00' }));
    assert.equal(findGateViolation(wrongMac, macRows, RULES)?.code, 'MAC_MISMATCH');
    assert.equal(findGateViolation(entries([['SN-1']]), macRows, RULES), null);
  });

  test('hydration fills a blank PON/MAC from the register row (one-field UX)', () => {
    const rowsByKey = indexGateRows([row({ ponSerial: 'PON-1', macAddress: 'a4c3f0b1d2e3' })]);
    const [hydrated] = hydrateSerialEntries(
      [{ deviceSerial: 'sn-1', ponSerial: '', macAddress: '', productId: 'p-onu', productName: 'ONU' }],
      rowsByKey
    );
    assert.equal(hydrated.ponSerial, 'PON-1');
    assert.equal(hydrated.macAddress, 'A4C3F0B1D2E3');
    assert.equal(findGateViolation([hydrated], rowsByKey, RULES), null);
  });

  test('a clean set resolves', () => {
    const rows = indexGateRows([row()]);
    assert.equal(findGateViolation(entries([['SN-1', 'pon-1']]), rows, { ...RULES, matchPonWhenProvided: true }), null);
  });
});

describe('describeGateViolation', () => {
  test('phrases the register\'s own reason with the caller\'s action', () => {
    assert.equal(
      describeGateViolation({ code: 'UNKNOWN', deviceSerial: 'SN-X' }, { action: 'deployed', branchLabel: 'Head Office', productName: 'ONU' }),
      'Device serial SN-X is not in the serial register at Head Office for "ONU" — only IN_STOCK units can be deployed.'
    );
    assert.equal(
      describeGateViolation({ code: 'WRONG_STATUS', deviceSerial: 'SN-X', status: 'DAMAGED' }, { action: 'sold' }),
      'Device serial SN-X is DAMAGED (not IN_STOCK) — it cannot be sold.'
    );
    assert.equal(
      describeGateViolation({ code: 'WRONG_BRANCH', deviceSerial: 'SN-X', branchId: 'BRH01' }, { action: 'sold', branchLabel: 'Head Office' }),
      'Device serial SN-X is held at branch BRH01, not Head Office.'
    );
  });
});

describe('resolveSerialGateInMemory (demo mode twin)', () => {
  test('refuses with a SerialGateError carrying the HTTP status', () => {
    assert.throws(
      () => resolveSerialGateInMemory([], [{ deviceSerial: 'SN-1', ponSerial: '', macAddress: '', productId: 'p-onu', productName: 'ONU' }], RULES, CTX),
      (err: any) => err instanceof SerialGateError && err.status === 400 && /not in the serial register/.test(err.message)
    );
  });

  test('accepts a clean set and is a no-op for an empty request', () => {
    const rows = [row()];
    resolveSerialGateInMemory(rows, [{ deviceSerial: ' sn-1 ', ponSerial: '', macAddress: '', productId: 'p-onu', productName: 'ONU' }], RULES, CTX);
    resolveSerialGateInMemory(rows, [], RULES, CTX);
  });
});
