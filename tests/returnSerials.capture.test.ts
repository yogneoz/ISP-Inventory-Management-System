/**
 * Returns — per-unit serial capture (both purchase and sales returns).
 *
 * WHY
 * The return form used to offer one free-text box per line and split it on
 * commas. A barcode reader ends every read with Enter and never types a comma,
 * so a scan of three units produced one long serial with no MAC or PON. The
 * form now mirrors the purchase bill: one row per returned unit, each with
 * Device / MAC / PON, sized by the quantity.
 *
 * PROVES:
 *   1. Slots follow the quantity — raising adds empty units, lowering drops the
 *      tail, and an existing scan is never silently discarded.
 *   2. A return line starts from the invoice's own units, minus units a posted
 *      return already took back (case-insensitive), and falls back to empty
 *      slots for legacy lines that recorded no serials.
 *   3. A scanned value resolves against the invoice unit so MAC/PON fill in;
 *      duplicates are detected per slot.
 *   4. Submit is refused when a serial-tracked line is missing a unit or the
 *      same device appears twice.
 *   5. The screen itself has no comma box left and renders one row per unit.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  duplicateSerialSlotIndex,
  findInvoiceSerialUnit,
  fitReturnSerialSlots,
  invoiceSerialUnits,
  returnSerialKey,
  returnSerialProblems,
  seedReturnSerialSlots,
  type ReturnSerialSlot,
} from '../client/src/utils/returnSerials';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

const slot = (deviceSerial: string, macAddress = '', ponSerial = ''): ReturnSerialSlot => ({
  deviceSerial,
  macAddress,
  ponSerial,
});

const INVOICE = {
  items: [
    {
      productId: 'p1',
      productName: 'GPON ONU',
      quantity: 3,
      deviceSerials: [
        { deviceSerial: 'SN-1', macAddress: 'AABBCCDDEE01', ponSerial: 'PON-1' },
        { deviceSerial: 'SN-2', macAddress: 'AABBCCDDEE02', ponSerial: '' },
        { deviceSerial: 'SN-3', macAddress: '', ponSerial: 'PON-3' },
      ],
    },
    { productId: 'p2', productName: 'Router', quantity: 1, deviceSerials: ['SN-R1'] },
  ],
};

describe('return serial slots', () => {
  test('the quantity owns the slots: shrink drops the tail, grow adds an empty unit', () => {
    const three = [slot('SN-1'), slot('SN-2'), slot('SN-3')];

    const two = fitReturnSerialSlots(three, 2);
    assert.deepEqual(two.map((s) => s.deviceSerial), ['SN-1', 'SN-2']);

    const four = fitReturnSerialSlots(two, 4);
    assert.deepEqual(four.map((s) => s.deviceSerial), ['SN-1', 'SN-2', '', '']);
    assert.deepEqual(four[3], slot(''), 'a new unit starts empty');

    assert.deepEqual(three.map((s) => s.deviceSerial), ['SN-1', 'SN-2', 'SN-3']);
    assert.notEqual(two[0], three[0], 'slots are copied, never mutated in place');
    assert.deepEqual(fitReturnSerialSlots(undefined, 2), [slot(''), slot('')]);
  });

  test('invoice units accept the stored pair and the legacy bare string', () => {
    const units = invoiceSerialUnits(INVOICE.items, 'p1');
    assert.deepEqual(units[0], slot('SN-1', 'AABBCCDDEE01', 'PON-1'));
    assert.deepEqual(units[1], slot('SN-2', 'AABBCCDDEE02', ''));
    assert.deepEqual(invoiceSerialUnits(INVOICE.items, 'p2'), [slot('SN-R1')]);
    assert.deepEqual(invoiceSerialUnits(INVOICE.items, 'missing'), []);
  });

  test('seeding skips units a posted return already took back, case-insensitively', () => {
    const seeded = seedReturnSerialSlots({
      invoiceItems: INVOICE.items,
      productId: 'p1',
      quantity: 3,
      alreadyReturned: [' sn-2 '],
    });
    assert.deepEqual(seeded.map((s) => s.deviceSerial), ['SN-1', 'SN-3', '']);
    assert.deepEqual(
      seeded.map((s) => s.macAddress),
      ['AABBCCDDEE01', '', ''],
      'MAC rides along with the invoice unit'
    );
  });

  test('a scanned serial resolves to its invoice unit and duplicate slots are found', () => {
    const units = invoiceSerialUnits(INVOICE.items, 'p1');
    assert.equal(findInvoiceSerialUnit(units, ' sn-3 ')?.ponSerial, 'PON-3');
    assert.equal(findInvoiceSerialUnit(units, 'SN-9'), undefined);

    const slots = [slot('SN-1'), slot(' sn-1 '), slot('')];
    assert.equal(duplicateSerialSlotIndex(slots, 'SN-1', 0), 1);
    assert.equal(duplicateSerialSlotIndex(slots, 'SN-1', 1), 0);
    assert.equal(duplicateSerialSlotIndex(slots, 'SN-2', 0), -1);
    assert.equal(returnSerialKey(' sn-1 '), 'SN-1');
  });
});

describe('return serial submit problems', () => {
  const line = (patch: Partial<Parameters<typeof returnSerialProblems>[0][number]>) => ({
    productId: 'p1',
    productName: 'GPON ONU',
    quantity: 2,
    requiresSerials: true,
    deviceSerials: [slot('SN-1'), slot('SN-2')],
    ...patch,
  });

  test('a complete serial-tracked line passes, and quantity-only lines never block', () => {
    assert.equal(returnSerialProblems([line({})]), null);
    assert.equal(
      returnSerialProblems([line({ requiresSerials: false, deviceSerials: [] })]),
      null,
      'a quantity-only line is not asked for serials'
    );
  });

  test('a missing unit is refused with the count the operator needs', () => {
    const problem = returnSerialProblems([line({ deviceSerials: [slot('SN-1'), slot('')] })]);
    assert.match(problem || '', /2 device serial\(s\) required, 1 scanned/);
    assert.match(problem || '', /GPON ONU/);
  });

  test('the same device twice in one return is refused across lines', () => {
    const problem = returnSerialProblems([
      line({}),
      line({ productId: 'p3', productName: 'Second ONU', deviceSerials: [slot(' sn-2 '), slot('SN-9')] }),
    ]);
    assert.match(problem || '', /Device serial sn-2 is used twice/i);
  });
});

describe('the returns screen captures one serial row per unit', () => {
  const source = read('client/src/features/sales/ReturnsRegister.tsx');

  test('the comma-separated field is gone', () => {
    assert.doesNotMatch(source, /serialsText/);
    assert.doesNotMatch(source, /placeholder=.*comma/i, 'no placeholder may ask for a comma-separated list');
    assert.doesNotMatch(source, /\.split\(\/\[\\n,;\]\+\//, 'the form must not split free text on commas');
  });

  test('each unit renders Device, MAC and PON inputs with Enter chaining', () => {
    assert.match(source, /line\.deviceSerials\.map\(\(slot, sIdx\)/);
    assert.match(source, /id=\{`ret-serial-device-\$\{idx\}-\$\{sIdx\}`\}/);
    assert.match(source, /id=\{`ret-serial-mac-\$\{idx\}-\$\{sIdx\}`\}/);
    assert.match(source, /id=\{`ret-serial-pon-\$\{idx\}-\$\{sIdx\}`\}/);
    // Scanning device -> next unit when the invoice identified it; otherwise
    // the identity fields are walked in order.
    assert.match(source, /focusNextDeviceSlot\(idx, sIdx\)/);
    assert.match(source, /focusReturnField\(`ret-serial-mac-\$\{idx\}-\$\{sIdx\}`\)/);
    assert.match(source, /normalizeLineMac\(idx, sIdx\)/);
  });

  test('quantity resizes the rows and submit sends per-unit deviceSerials', () => {
    assert.match(source, /fitReturnSerialSlots\(l\.deviceSerials, quantity\)/);
    assert.match(source, /seedReturnSerialSlots\(/);
    assert.match(source, /returnSerialProblems\(validLines\)/);
    assert.match(source, /deviceSerials: serials/);
    assert.match(source, /macAddress: slot\.macAddress\.trim\(\) \|\| undefined/);
  });

  test('the detail view shows each unit identity', () => {
    assert.match(source, /function ReturnSerialsCell/);
    assert.match(source, /PON \{serial\.ponSerial\}/);
    assert.match(source, /MAC \{serial\.macAddress\}/);
    assert.match(source, /<ReturnSerialsCell item=\{it\} \/>/);
  });
});
