/**
 * Returns — server-side serial validation, guarded flips and warranty
 * retirement, plus the read side that shows a returned unit in the register.
 *
 * WHY
 * The register is the authority for a unit's identity. A return used to accept
 * whatever serials the browser sent (count only) and then flip them by exact
 * string with no state predicate: a serial sold on another invoice, already
 * returned, or held at another branch could be rewritten, while a
 * comma-separated blob made the correct 1:1 mapping unenforceable.
 *
 * PROVES:
 *   1. Entry normalisation accepts the stored pair and the legacy bare string.
 *   2. Count/duplicate validation matches units to serials before any write.
 *   3. Register validation refuses a serial that is missing, belongs to another
 *      product, is not on the original invoice, sits at another branch, or is
 *      in the wrong state for the return kind.
 *   4. Hydration writes the register's MAC/PON onto the returned units.
 *   5. Both flip statements are state-guarded and case-insensitive; they cannot
 *      rewrite a unit that moved on, and the caller can detect the miss.
 *   6. Warranty coverage is retired per returned serial with the document that
 *      did it — never deleted, never the whole invoice — and the register's
 *      Returned filter reads those rows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  collectReturnSerials,
  hydrateReturnSerialEntries,
  normalizeReturnSerialEntry,
  returnLineSerials,
  returnSerialKey,
  serialRowsFromInvoiceItems,
  validateReturnSerialCounts,
  validateReturnSerialsAgainstRegister,
  type SerialLogRow,
} from '../server/src/services/returnSerials.service';
import { SR_SERIAL_FLIP_SQL } from '../server/src/models/sales.repo';
import { PR_SERIAL_FLIP_SQL } from '../server/src/models/procurement.repo';
import {
  buildWarrantyPageQuery,
  buildWarrantySummaryQuery,
  WARRANTY_RETIRE_BY_SERIALS_SQL,
} from '../server/src/models/warranty.repo';
import { retireCoverageForSerialsMirror } from '../server/src/services/warranty.service';
import { setWarrantyCoverages, warrantyCoverages } from '../server/src/state/runtimeState';
import type { WarrantyCoverageRecord } from '../client/src/types';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

const rows = (entries: SerialLogRow[]) =>
  new Map(entries.map((row) => [returnSerialKey(row.deviceSerial), row]));

const INVOICE_ITEMS = [
  {
    productId: 'p1',
    productName: 'GPON ONU',
    deviceSerials: [
      { deviceSerial: 'SN-1', macAddress: 'AA:BB:CC:DD:EE:01', ponSerial: 'PON-1' },
      { deviceSerial: 'SN-3', macAddress: 'AA:BB:CC:DD:EE:03', ponSerial: '' },
      { deviceSerial: 'SN-4', macAddress: 'AA:BB:CC:DD:EE:04', ponSerial: '' },
    ],
  },
  { productId: 'p2', productName: 'Router', deviceSerials: ['SN-R1'] },
];

const REGISTER = rows([
  { deviceSerial: 'SN-1', productId: 'p1', productName: 'GPON ONU', status: 'CUSTOMER_ASSIGNED', branchId: 'WH001', macAddress: 'AA:BB:CC:DD:EE:01', ponSerial: 'PON-1' },
  { deviceSerial: 'SN-3', productId: 'p1', productName: 'GPON ONU', status: 'IN_STOCK', branchId: 'WH001', macAddress: 'AA:BB:CC:DD:EE:03', ponSerial: '' },
  { deviceSerial: 'SN-4', productId: 'p1', productName: 'GPON ONU', status: 'CUSTOMER_ASSIGNED', branchId: 'BRH01', macAddress: 'AA:BB:CC:DD:EE:04', ponSerial: '' },
  { deviceSerial: 'SN-R1', productId: 'p2', productName: 'Router', status: 'CUSTOMER_ASSIGNED', branchId: 'WH001', macAddress: '', ponSerial: '' },
  { deviceSerial: 'SN-OTHER', productId: 'p1', productName: 'GPON ONU', status: 'CUSTOMER_ASSIGNED', branchId: 'WH001', macAddress: '', ponSerial: '' },
]);

describe('return serial entries', () => {
  test('stored pairs and legacy bare strings normalise to one shape', () => {
    assert.deepEqual(normalizeReturnSerialEntry(' SN-1 '), { deviceSerial: 'SN-1' });
    assert.deepEqual(normalizeReturnSerialEntry({ deviceSerial: 'SN-2', macAddress: 'AA', ponSerial: '' }), {
      deviceSerial: 'SN-2',
      macAddress: 'AA',
      ponSerial: undefined,
    });
    assert.equal(normalizeReturnSerialEntry({ deviceSerial: '   ' }), null);
    assert.equal(normalizeReturnSerialEntry(null), null);

    const item = { deviceSerials: ['SN-1', { deviceSerial: 'SN-2', ponSerial: 'PON-2' }, 7] };
    assert.deepEqual(returnLineSerials(item).map((entry) => entry.deviceSerial), ['SN-1', 'SN-2']);
    assert.deepEqual(collectReturnSerials([item]), ['SN-1', 'SN-2']);
  });
});

describe('return serial count validation', () => {
  const tracked = (productId?: string) => productId === 'p1';

  test('one serial per unit, refused with the counts', () => {
    const short = validateReturnSerialCounts(
      [{ productId: 'p1', productName: 'GPON ONU', quantity: 2, deviceSerials: ['SN-1'] }],
      tracked
    );
    assert.match(short || '', /2 serial\(s\) required, 1 provided/);

    const exact = validateReturnSerialCounts(
      [{ productId: 'p1', productName: 'GPON ONU', quantity: 2, deviceSerials: ['SN-1', 'SN-2'] }],
      tracked
    );
    assert.equal(exact, null);
  });

  test('quantity-only products are not asked for serials', () => {
    assert.equal(
      validateReturnSerialCounts(
        [{ productId: 'p9', productName: 'Cable', quantity: 25, deviceSerials: [] }],
        tracked
      ),
      null
    );
  });

  test('the same unit twice is refused before anything is written', () => {
    const problem = validateReturnSerialCounts(
      [
        { productId: 'p1', productName: 'GPON ONU', quantity: 1, deviceSerials: ['SN-1'] },
        { productId: 'p1', productName: 'GPON ONU', quantity: 1, deviceSerials: [' sn-1 '] },
      ],
      tracked
    );
    assert.match(problem || '', /appears twice/);
    assert.match(problem || '', /sn-1/i);
  });
});

describe('register validation', () => {
  const salesCtx = { kind: 'SALES' as const, invoiceItems: INVOICE_ITEMS, branchId: 'WH001' };
  const purchaseCtx = { kind: 'PURCHASE' as const, invoiceItems: INVOICE_ITEMS, branchId: 'WH001' };
  const line = (deviceSerials: string[]) => ({
    productId: 'p1',
    productName: 'GPON ONU',
    quantity: deviceSerials.length,
    deviceSerials,
  });

  test('a sold unit on the invoice is accepted for a sales return', () => {
    assert.equal(validateReturnSerialsAgainstRegister([line(['SN-1'])], REGISTER, salesCtx), null);
  });

  test('a unit that is not IN_STOCK cannot be returned to the supplier', () => {
    const problem = validateReturnSerialsAgainstRegister([line(['SN-1'])], REGISTER, purchaseCtx);
    assert.match(problem || '', /CUSTOMER_ASSIGNED/);
    assert.match(problem || '', /IN_STOCK at the return branch/);
    assert.equal(validateReturnSerialsAgainstRegister([line(['SN-3'])], REGISTER, purchaseCtx), null);
  });

  test('an already restocked unit cannot be returned by a customer a second time', () => {
    const problem = validateReturnSerialsAgainstRegister([line(['SN-3'])], REGISTER, salesCtx);
    assert.match(problem || '', /SN-3 is IN_STOCK/);
    assert.match(problem || '', /CUSTOMER_ASSIGNED/);
  });

  test('missing, other-product, off-invoice and other-branch units are each named', () => {
    assert.match(
      validateReturnSerialsAgainstRegister([line(['SN-GHOST'])], REGISTER, salesCtx) || '',
      /not in the serial register/
    );
    assert.match(
      validateReturnSerialsAgainstRegister([line(['SN-R1'])], REGISTER, salesCtx) || '',
      /belongs to Router, not GPON ONU/
    );
    assert.match(
      validateReturnSerialsAgainstRegister([line(['SN-OTHER'])], REGISTER, salesCtx) || '',
      /not on the original invoice line/
    );
    assert.match(
      validateReturnSerialsAgainstRegister([line(['SN-4'])], REGISTER, salesCtx) || '',
      /held at branch BRH01/
    );
  });

  test('hydration writes the register MAC/PON onto each unit', () => {
    const items: any[] = [
      {
        productId: 'p1',
        productName: 'GPON ONU',
        quantity: 2,
        deviceSerials: [
          { deviceSerial: 'sn-1', macAddress: 'stale' },
          { deviceSerial: 'SN-3', ponSerial: 'stale' },
        ],
      },
    ];
    hydrateReturnSerialEntries(items, REGISTER);
    assert.deepEqual(items[0].deviceSerials, [
      { deviceSerial: 'SN-1', macAddress: 'AA:BB:CC:DD:EE:01', ponSerial: 'PON-1' },
      { deviceSerial: 'SN-3', macAddress: 'AA:BB:CC:DD:EE:03', ponSerial: undefined },
    ]);
  });

  test('the invoice mirror supplies identity when PostgreSQL is down', () => {
    const built = serialRowsFromInvoiceItems(INVOICE_ITEMS);
    assert.equal(built.get('SN-1')?.macAddress, 'AA:BB:CC:DD:EE:01');
    assert.equal(built.get('SN-R1')?.productId, 'p2');
  });
});

describe('the serial log flip is state-guarded', () => {
  test('both return kinds require the state they reverse', () => {
    for (const [name, sql] of [
      ['sales', SR_SERIAL_FLIP_SQL],
      ['purchase', PR_SERIAL_FLIP_SQL],
    ] as const) {
      const flat = normalize(sql);
      assert.match(flat, /lower\(trim\(device_serial\)\) = ANY\(\$1::text\[\]\)/, `${name} must match case-insensitively`);
      assert.match(flat, /status = ANY\(\$4::text\[\]\)/, `${name} must guard the current state`);
    }
  });
});

describe('coverage retirement on a return', () => {
  test('the statement records the reason and the document on the retired rows', () => {
    const flat = normalize(WARRANTY_RETIRE_BY_SERIALS_SQL);
    assert.match(flat, /coverage_type = \$1/);
    assert.match(flat, /serial_number = ANY\(\$2\)/);
    assert.match(flat, /retired_reason = \$3/);
    assert.match(flat, /retired_ref = \$4/);
    assert.match(flat, /is_current = TRUE/);
    assert.match(flat, /is_current = FALSE/);
    assert.doesNotMatch(flat, /DELETE/i, 'coverage history is retired, never deleted');
  });

  test('the register Returned filter reads retired rows, not the active population', () => {
    // The SELECT list carries `CASE WHEN w.is_current = FALSE THEN 'RETURNED'`,
    // so the population assertion has to look at the WHERE clause only.
    const whereOf = (sql: string) => normalize(sql).split(/ WHERE /)[1]?.split(/ ORDER BY /)[0] || '';

    const retired = buildWarrantyPageQuery({ coverageType: 'SELLER', status: 'RETURNED' }, 1, 10);
    assert.match(whereOf(retired.sql), /w\.is_current = FALSE/);
    assert.doesNotMatch(whereOf(retired.sql), /w\.is_current = TRUE/);

    const active = buildWarrantyPageQuery({ coverageType: 'SELLER' }, 1, 10);
    assert.match(whereOf(active.sql), /w\.is_current = TRUE/);
    assert.doesNotMatch(whereOf(active.sql), /w\.is_current = FALSE/);
  });

  test('the KPI date states count active coverage only', () => {
    const summary = normalize(buildWarrantySummaryQuery({ coverageType: 'SELLER' }).sql);
    assert.equal(
      (summary.match(/FILTER \(WHERE w\.is_current = TRUE AND/g) || []).length,
      3,
      'valid/expiring/expired must each exclude retired rows'
    );
  });

  test('the demo mirror retires only the matching side and serial, with its reason', () => {
    const coverage = (patch: Partial<WarrantyCoverageRecord>): WarrantyCoverageRecord => ({
      id: patch.id || 'wc-1',
      coverageType: 'SELLER',
      itemCategory: 'SOLD_PRODUCT',
      productName: 'GPON ONU',
      serialNumber: 'SN-1',
      sourceType: 'SALES_INVOICE',
      sourceNumber: 'SI-0001',
      startDateAD: '2026-01-01',
      endDateAD: '2027-01-01',
      startBasis: 'SALE_DATE',
      isCurrent: true,
      isDemo: true,
      ...patch,
    });

    setWarrantyCoverages([
      coverage({ id: 'wc-seller' }),
      coverage({ id: 'wc-vendor', coverageType: 'VENDOR', sourceType: 'PURCHASE_INVOICE' }),
      coverage({ id: 'wc-other', serialNumber: 'SN-2' }),
    ]);

    retireCoverageForSerialsMirror('SELLER', [' sn-1 '], {
      reason: 'SALES_RETURN',
      ref: 'CN-0007',
    });

    const byId = new Map((warrantyCoverages as WarrantyCoverageRecord[]).map((row) => [row.id, row]));
    assert.equal(byId.get('wc-seller')?.isCurrent, false);
    assert.equal(byId.get('wc-seller')?.retiredReason, 'SALES_RETURN');
    assert.equal(byId.get('wc-seller')?.retiredRef, 'CN-0007');
    assert.ok(byId.get('wc-seller')?.supersededAt, 'a retired row keeps when it was retired');
    assert.equal(byId.get('wc-vendor')?.isCurrent, true, 'the supplier side is untouched');
    assert.equal(byId.get('wc-other')?.isCurrent, true, 'another unit is untouched');

    setWarrantyCoverages([]);
  });

  test('the register screen offers the Returned filter and locks its rows', () => {
    const source = read('client/src/features/inventory/warranty/WarrantyRegister.tsx');
    assert.match(source, /value: 'RETURNED'/);
    assert.match(source, /Retired/);
    assert.match(source, /row\.warrantyState !== 'RETURNED'/);
  });
});
