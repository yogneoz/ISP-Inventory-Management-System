/**
 * Purchase → serial register (Slice 1 of the serial-register plan).
 *
 * Pins the pure half of "posting a purchase invoice registers its received
 * units": the planning/validation rules that decide what an invoice may
 * register, and the demo-mode mirror write. The transactional half
 * (procurement.controller.ts `registerPurchaseSerials`) is exercised live.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SerialRegisterError,
  applyRegisterEntryToMirror,
  findMirrorRowBySerial,
  isSerialTrackedProduct,
  planPurchaseSerialEntries,
  purchaseRegisterHistoryEntry,
  requiresMac,
  serialKey,
} from '../server/src/services/serialRegister.service';

const ONU = { id: 'p-onu', name: 'ONU ROUTER', requiresSerialTracking: true, trackingType: 'SERIAL_MAC_PON' };
const FIBER = { id: 'p-fiber', name: 'FIBER CABLE', requiresSerialTracking: false, trackingType: 'QUANTITY_ONLY' };

const pair = (deviceSerial: string, ponSerial = '', macAddress = '') => ({ deviceSerial, ponSerial, macAddress });

describe('isSerialTrackedProduct / requiresMac', () => {
  test('QUANTITY_ONLY products are never serial-tracked', () => {
    assert.equal(isSerialTrackedProduct(FIBER), false);
    assert.equal(requiresMac(FIBER), false);
  });

  test('a product is tracked unless it explicitly opts out', () => {
    assert.equal(isSerialTrackedProduct(ONU), true);
    assert.equal(isSerialTrackedProduct({ id: 'x', requiresSerialTracking: true }), true);
    assert.equal(isSerialTrackedProduct({ id: 'x', requiresSerialTracking: false }), false);
    assert.equal(isSerialTrackedProduct({ id: 'x', trackingType: 'SERIAL_ONLY' }), true);
    assert.equal(isSerialTrackedProduct(undefined), false);
  });

  test('MAC is mandatory only for SERIAL_MAC_PON (PON is optional everywhere)', () => {
    assert.equal(requiresMac(ONU), true);
    assert.equal(requiresMac({ id: 'x', trackingType: 'SERIAL_ONLY' }), false);
  });
});

describe('serialKey', () => {
  test('case and trim insensitive, matching uq_serial_log_device_serial', () => {
    assert.equal(serialKey(' sn-1 '), 'SN-1');
    assert.equal(serialKey(undefined), '');
    assert.equal(serialKey('sn-1'), serialKey(' SN-1 '));
  });
});

describe('planPurchaseSerialEntries', () => {
  test('registers one entry per unit of a serial-tracked line', () => {
    const plan = planPurchaseSerialEntries(
      [
        { productId: 'p-onu', productName: 'ONU ROUTER', quantity: 2, deviceSerials: [pair('SN-1', 'PON-1', 'AA'), pair('SN-2', 'PON-2', 'BB')] },
      ],
      [ONU],
      'WH001'
    );
    assert.equal(plan.error, null);
    assert.deepEqual(plan.entries, [
      { deviceSerial: 'SN-1', ponSerial: 'PON-1', macAddress: 'AA', productId: 'p-onu', productName: 'ONU ROUTER', branchId: 'WH001' },
      { deviceSerial: 'SN-2', ponSerial: 'PON-2', macAddress: 'BB', productId: 'p-onu', productName: 'ONU ROUTER', branchId: 'WH001' },
    ]);
  });

  test('quantity-tracked lines carry no entries and need no serials', () => {
    const plan = planPurchaseSerialEntries(
      [{ productId: 'p-fiber', productName: 'FIBER CABLE', quantity: 500, deviceSerials: [] }],
      [FIBER],
      'WH001'
    );
    assert.equal(plan.error, null);
    assert.deepEqual(plan.entries, []);
  });

  test('serial-count mismatch is refused with the operator-facing message', () => {
    const plan = planPurchaseSerialEntries(
      [{ productId: 'p-onu', productName: 'ONU ROUTER', quantity: 2, deviceSerials: [pair('SN-1', 'PON-1', 'AA')] }],
      [ONU],
      'WH001'
    );
    assert.equal(plan.entries.length, 0);
    assert.match(plan.error || '', /serial-tracked: 2 device serial\(s\) required, 1 provided/);
  });

  test('a blank device serial cannot satisfy a unit', () => {
    const plan = planPurchaseSerialEntries(
      [{ productId: 'p-onu', productName: 'ONU ROUTER', quantity: 1, deviceSerials: [pair('   ', 'PON-1', 'AA')] }],
      [ONU],
      'WH001'
    );
    assert.equal(plan.entries.length, 0);
    assert.match(plan.error || '', /1 device serial\(s\) required, 0 provided/);
  });

  test('a duplicate device serial anywhere in the invoice is refused', () => {
    const plan = planPurchaseSerialEntries(
      [
        { productId: 'p-onu', productName: 'ONU ROUTER', quantity: 1, deviceSerials: [pair('SN-1', 'PON-1', 'AA')] },
        { productId: 'p-onu', productName: 'ONU ROUTER', quantity: 1, deviceSerials: [pair(' sn-1 ', 'PON-2', 'BB')] },
      ],
      [ONU],
      'WH001'
    );
    assert.equal(plan.entries.length, 0);
    assert.match(plan.error || '', /Duplicate device serial sn-1 on this purchase invoice/);
  });

  test('duplicate PON and duplicate MAC are refused too (MAC compared canonically)', () => {
    const dupPon = planPurchaseSerialEntries(
      [
        { productId: 'p-onu', quantity: 1, deviceSerials: [pair('SN-1', 'PON-1', 'AA')] },
        { productId: 'p-onu', quantity: 1, deviceSerials: [pair('SN-2', 'pon-1', 'BB')] },
      ],
      [ONU],
      'WH001'
    );
    assert.match(dupPon.error || '', /Duplicate PON serial pon-1/);

    const dupMac = planPurchaseSerialEntries(
      [
        { productId: 'p-onu', quantity: 1, deviceSerials: [pair('SN-1', 'PON-1', '00-11-22-33-44-55')] },
        { productId: 'p-onu', quantity: 1, deviceSerials: [pair('SN-2', 'PON-2', '001122334455')] },
      ],
      [ONU],
      'WH001'
    );
    assert.match(dupMac.error || '', /Duplicate MAC address 00:11:22:33:44:55/);
  });

  test('SERIAL_MAC_PON requires MAC per unit and stores a blank PON as null', () => {
    const noPon = planPurchaseSerialEntries(
      [{ productId: 'p-onu', quantity: 1, deviceSerials: [pair('SN-1', '', 'AA')] }],
      [ONU],
      'WH001'
    );
    assert.equal(noPon.error, null);
    assert.equal(noPon.entries[0].ponSerial, null);
    assert.equal(noPon.entries[0].macAddress, 'AA');

    const noMac = planPurchaseSerialEntries(
      [{ productId: 'p-onu', quantity: 1, deviceSerials: [pair('SN-1', 'PON-1', '')] }],
      [ONU],
      'WH001'
    );
    assert.match(noMac.error || '', /MAC address is required for device serial SN-1/);

    // A MAC scanned without separators is stored canonically, so the register
    // never holds two spellings of one device.
    const barcodeMac = planPurchaseSerialEntries(
      [{ productId: 'p-onu', quantity: 1, deviceSerials: [pair('SN-3', 'PON-3', 'a4c3f0b1d2e3')] }],
      [ONU],
      'WH001'
    );
    assert.equal(barcodeMac.error, null);
    assert.equal(barcodeMac.entries[0].macAddress, 'A4:C3:F0:B1:D2:E3');

    // SERIAL_ONLY: device serial alone is enough.
    const serialOnly = planPurchaseSerialEntries(
      [{ productId: 'p-sn', quantity: 1, deviceSerials: [pair('SN-9')] }],
      [{ id: 'p-sn', name: 'SERIAL ONLY', requiresSerialTracking: true, trackingType: 'SERIAL_ONLY' }],
      'WH001'
    );
    assert.equal(serialOnly.error, null);
    assert.deepEqual(serialOnly.entries[0], {
      deviceSerial: 'SN-9', ponSerial: null, macAddress: null, productId: 'p-sn', productName: 'SERIAL ONLY', branchId: 'WH001',
    });
  });

  test('a product the catalog does not know keeps deliberately typed serials', () => {
    const plan = planPurchaseSerialEntries(
      [{ productId: 'p-unknown', productName: 'LEGACY ONU', quantity: 1, deviceSerials: [pair('SN-7')] }],
      [],
      'WH001'
    );
    assert.equal(plan.error, null);
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].deviceSerial, 'SN-7');
  });

  test('an unknown product with no serials registers nothing (never invents units)', () => {
    const plan = planPurchaseSerialEntries(
      [{ productId: 'p-unknown', productName: 'LEGACY ONU', quantity: 3, deviceSerials: [] }],
      [],
      'WH001'
    );
    assert.equal(plan.error, null);
    assert.deepEqual(plan.entries, []);
  });
});

describe('purchaseRegisterHistoryEntry', () => {
  test('records IN_STOCK from PURCHASE with the invoice reference', () => {
    assert.deepEqual(purchaseRegisterHistoryEntry({ id: 'inv-1', invoiceNumber: 'PI-WH001-0001' }, '2026-10-13T10:00:00Z'), {
      status: 'IN_STOCK',
      sourceType: 'PURCHASE',
      sourceId: 'inv-1',
      dateAD: '2026-10-13',
      notes: 'Received on purchase invoice PI-WH001-0001',
    });
  });
});

describe('applyRegisterEntryToMirror (demo mode)', () => {
  const entry = {
    deviceSerial: 'SN-1', ponSerial: 'PON-1', macAddress: 'AA',
    productId: 'p-onu', productName: 'ONU ROUTER', branchId: 'WH001',
  };
  const ctx = {
    id: 'sl-new', timestamp: '2026-10-13T00:00:00Z', sourceId: 'inv-1',
    history: purchaseRegisterHistoryEntry({ id: 'inv-1', invoiceNumber: 'PI-1' }, '2026-10-13'),
  };

  test('an unseen serial is prepended as IN_STOCK', () => {
    const { rows, action } = applyRegisterEntryToMirror([], entry, ctx);
    assert.equal(action, 'INSERTED');
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as any).deviceSerial, 'SN-1');
    assert.equal((rows[0] as any).status, 'IN_STOCK');
    assert.equal((rows[0] as any).sourceType, 'PURCHASE');
    assert.equal((rows[0] as any).sourceId, 'inv-1');
    assert.deepEqual((rows[0] as any).history, [ctx.history]);
  });

  test('case/trim-insensitive lookup finds the existing row', () => {
    const existing = [{ deviceSerial: ' sn-1 ', status: 'IN_STOCK', id: 'sl-1' }];
    const { action } = applyRegisterEntryToMirror(existing, entry, ctx);
    assert.equal(action, 'DUPLICATE');
  });

  test('a unit the vendor took back is re-activated in place, keeping its id and history', () => {
    const existing = [{ deviceSerial: 'SN-1', status: 'RETURNED_TO_VENDOR', id: 'sl-old', history: [{ status: 'RETURNED_TO_VENDOR' }] }];
    const { rows, action } = applyRegisterEntryToMirror(existing, entry, ctx);
    assert.equal(action, 'REACTIVATED');
    assert.equal((rows[0] as any).id, 'sl-old');
    assert.equal((rows[0] as any).status, 'IN_STOCK');
    assert.equal((rows[0] as any).sourceId, 'inv-1');
    assert.equal((rows[0] as any).history.length, 2);
  });

  test('a unit that already sits in the register is refused, never cleared', () => {
    for (const status of ['IN_STOCK', 'CUSTOMER_ASSIGNED', 'DAMAGED', 'IN_TRANSIT']) {
      const existing = [{ deviceSerial: 'SN-1', status, id: 'sl-1', customerName: 'Example Customer' }];
      const { rows, action } = applyRegisterEntryToMirror(existing, entry, ctx);
      assert.equal(action, 'DUPLICATE', status);
      assert.equal((rows[0] as any).status, status);
      assert.equal((rows[0] as any).customerName, 'Example Customer');
    }
  });

  test('findMirrorRowBySerial is the single lookup both paths share', () => {
    const rows = [{ deviceSerial: 'SN-1', status: 'IN_STOCK' }];
    assert.equal(findMirrorRowBySerial(rows, ' sn-1 ')?.deviceSerial, 'SN-1');
    assert.equal(findMirrorRowBySerial(rows, 'SN-2'), undefined);
  });
});

describe('SerialRegisterError', () => {
  test('carries the HTTP status the controller must answer with', () => {
    const err = new SerialRegisterError(409, 'already registered');
    assert.equal(err.status, 409);
    assert.equal(err.message, 'already registered');
    assert.equal(err.name, 'SerialRegisterError');
    assert.ok(err instanceof Error);
  });
});
