/**
 * Warranty register CSV projection — pure, no DOM, no database.
 *
 * The export must be the whole filtered population in the register's own
 * wording, and it must carry both calendars for both dates: AD is the stored
 * authority and BS is derived, never invented. These tests pin the projection
 * so a future label or column edit cannot quietly drop the BS column, rename a
 * supplier to a customer, or ship a retired unit's meaningless day count.
 *
 * PROVES:
 *   1. Start and expiry travel as AD and derived BS; a missing date stays blank.
 *   2. State, category and source wording match what the register renders.
 *   3. A retired row says why and by which document and has no day count;
 *      an active row keeps its signed count.
 *   4. The column list and the projected keys agree, and the party column is
 *      named for the side that owes the promise.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { WarrantyCoverageRow } from '../client/src/types';
import {
  buildWarrantyExportRows,
  warrantyCategoryLabel,
  warrantyExportColumns,
  warrantyRetiredLabel,
  warrantySourceLabel,
} from '../client/src/utils/warrantyExport';

function row(overrides: Partial<WarrantyCoverageRow> = {}): WarrantyCoverageRow {
  return {
    id: 'wc-1',
    coverageType: 'VENDOR',
    itemCategory: 'CPE',
    productName: 'Router X',
    serialNumber: 'SN-1',
    branchId: 'BRH01',
    branchName: 'Head Office',
    partyName: 'Supplier A',
    sourceType: 'PURCHASE_INVOICE',
    sourceNumber: 'PI-1',
    startDateAD: '2026-09-01',
    endDateAD: '2027-09-01',
    termMonths: 12,
    startBasis: 'INVOICE_DATE',
    warrantyState: 'VALID',
    daysRemaining: 306,
    notes: null,
    retiredReason: null,
    retiredRef: null,
    ...overrides,
  };
}

describe('warranty CSV projection', () => {
  test('start and expiry travel as AD and derived BS', () => {
    const [out] = buildWarrantyExportRows([row()], true);
    assert.equal(out.startAD, '2026-09-01');
    assert.equal(out.expiryAD, '2027-09-01');
    for (const bs of [out.startBS, out.expiryBS]) {
      assert.match(bs, /^20\d{2}-\d{2}-\d{2}$/, `BS must be a BS date, got ${bs}`);
      assert.doesNotMatch(bs, /^202[67]-/, 'a BS column must never carry the AD value');
    }
    // The register's dual-date renderer uses the same conversion, so the file
    // and the screen agree on the day.
    assert.notEqual(out.startBS, out.startAD);
  });

  test('a missing date is blank, not "-" or a fabricated day', () => {
    const [out] = buildWarrantyExportRows([row({ startDateAD: '', endDateAD: '' })], true);
    assert.equal(out.startAD, '');
    assert.equal(out.startBS, '');
    assert.equal(out.expiryAD, '');
    assert.equal(out.expiryBS, '');
  });

  test('state wording matches the register pill', () => {
    const labels = (['VALID', 'EXPIRING_SOON', 'EXPIRED', 'RETURNED'] as const).map(
      (warrantyState) => buildWarrantyExportRows([row({ warrantyState })], true)[0].state
    );
    assert.deepEqual(labels, [
      'Valid',
      'Expiring soon (within 30 days)',
      'Expired',
      'Returned (retired)',
    ]);
  });

  test('a retired row names the reason and the document, and drops the day count', () => {
    const [out] = buildWarrantyExportRows(
      [
        row({
          warrantyState: 'RETURNED',
          retiredReason: 'SALES_RETURN',
          retiredRef: 'CN-WH001-202609010001',
          daysRemaining: 120,
        }),
      ],
      true
    );
    assert.equal(out.retired, 'Returned by customer · CN-WH001-202609010001');
    assert.equal(out.daysRemaining, '', 'a retired row has no meaningful countdown');
  });

  test('an active row keeps its signed day count', () => {
    const [expired] = buildWarrantyExportRows([row({ warrantyState: 'EXPIRED', daysRemaining: -5 })], true);
    assert.equal(expired.daysRemaining, '-5');
    assert.equal(expired.retired, '');
    const [valued] = buildWarrantyExportRows([row({ daysRemaining: 0 })], true);
    assert.equal(valued.daysRemaining, '0');
  });

  test('category, source and party wording follow the side', () => {
    assert.equal(warrantyCategoryLabel('CPE', true), 'Customer CPE');
    assert.equal(warrantyCategoryLabel('CPE', false), 'Rental CPE');
    assert.equal(warrantyCategoryLabel('FIXED_ASSET', true), 'Fixed asset');
    assert.equal(warrantyCategoryLabel('SOLD_PRODUCT', false), 'Sold product');
    assert.equal(warrantyCategoryLabel('SOMETHING', true), 'SOMETHING');

    assert.equal(warrantySourceLabel('PURCHASE_INVOICE'), 'Purchase invoice');
    assert.equal(warrantySourceLabel('SALES_INVOICE'), 'Sales invoice');
    assert.equal(warrantySourceLabel('UNKNOWN'), 'UNKNOWN');
    assert.equal(warrantySourceLabel(null), '');

    const vendorColumns = warrantyExportColumns(true).map((column) => column.label);
    const sellerColumns = warrantyExportColumns(false).map((column) => column.label);
    assert.ok(vendorColumns.includes('Supplier'));
    assert.ok(sellerColumns.includes('Customer / Assignee'));
    assert.ok(!vendorColumns.includes('Customer / Assignee'));
  });

  test('both registers export the coverage dates, both expiries and the state', () => {
    for (const isVendor of [true, false]) {
      const labels = warrantyExportColumns(isVendor).map((column) => column.label);
      for (const label of [
        'Coverage Start (AD)',
        'Coverage Start (BS)',
        'Warranty Expiry (AD)',
        'Warranty Expiry (BS)',
        'Warranty State',
      ]) {
        assert.ok(labels.includes(label), `${isVendor ? 'vendor' : 'seller'} export must carry ${label}`);
      }
    }
  });

  test('the column list and the projected keys agree', () => {
    const [out] = buildWarrantyExportRows([row()], true);
    const keys = Object.keys(out).sort();
    const columns = warrantyExportColumns(true)
      .map((column) => String(column.key))
      .sort();
    assert.deepEqual(columns, keys, 'a projected field without a column would be dropped silently');
  });

  test('retired wording is empty for a current row and reason-only without a reference', () => {
    assert.equal(warrantyRetiredLabel(row()), '');
    assert.equal(
      warrantyRetiredLabel(
        row({ warrantyState: 'RETURNED', retiredReason: 'PURCHASE_RETURN', retiredRef: null })
      ),
      'Returned to supplier'
    );
    assert.equal(
      warrantyRetiredLabel(row({ warrantyState: 'RETURNED', retiredReason: null, retiredRef: 'wc-9' })),
      'Retired · wc-9'
    );
  });
});

/**
 * The projection is only worth anything if the button reads the unpaged set.
 * One source contract per layer: the browser asks for `all`, the API forwards
 * it, and the server answers it with the export builder — not the page builder.
 * Without these the export could silently become the visible page again.
 */
describe('warranty export wiring', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

  test('the register requests every filtered row and maps it through the projection', () => {
    const source = read('client/src/features/inventory/warranty/WarrantyRegister.tsx');
    assert.match(source, /all: true/);
    assert.match(source, /buildWarrantyExportRows\(/);
    assert.match(source, /warrantyExportColumns\(/);
    assert.match(source, /Exporting…|Export CSV/);
  });

  test('the API client forwards all=1', () => {
    const source = read('client/src/services/api/warranty.ts');
    assert.match(source, /all\?: boolean/);
    assert.match(source, /if \(params\.all\) search\.append\('all', '1'\)/);
  });

  test('the server answers all=1 with the unpaged builder on both paths', () => {
    const source = read('server/src/controllers/warranty.controller.ts');
    assert.match(source, /const wantsAll = String\(req\.query\?\.all \?\? ''\) === '1'/);
    assert.match(source, /wantsAll\s*\? buildWarrantyExportQuery\(opts\)\s*: buildWarrantyPageQuery\(opts, page, pageSize\)/);
    assert.match(source, /buildWarrantyMirrorPage\(opts, wantsAll \? 1 : page, wantsAll \? Number\.MAX_SAFE_INTEGER : pageSize\)/);
  });
});
