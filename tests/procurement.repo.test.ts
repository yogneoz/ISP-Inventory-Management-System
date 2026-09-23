/**
 * Unit tests for the procurement repo query builders (node:test).
 * Verifies SQL text and param ordering without a live database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPoListSql,
  poUpsertParams,
  poUpdateParams,
  poIncomingStockParams,
  buildPiListSql,
  buildPurchaseOrderPagedQuery,
  buildPurchaseOrderAggregateQuery,
  buildPurchaseOrderStatusCountQuery,
  buildPurchaseInvoicePagedQuery,
  buildPurchaseInvoiceAggregateQuery,
  buildPurchaseInvoiceStatusCountQuery,
  piUpsertParams,
  piReceiveStockParams,
  piTxnLogParams,
  buildVendorPaymentWhere,
  vpInsertParams,
  ledgerNameParams,
  PO_SELECT_COLUMNS,
} from '../server/src/models/procurement.repo';

describe('buildPoListSql', () => {
  test('adds a branch filter and one param for a concrete branchId', () => {
    const { sql, params } = buildPoListSql('WH001');
    assert.match(sql, / WHERE branch_id = \$1 ORDER BY created_at DESC$/);
    assert.deepEqual(params, ['WH001']);
  });

  test('no filter for ALL or missing branchId', () => {
    for (const branchId of ['ALL', undefined]) {
      const { sql, params } = buildPoListSql(branchId);
      assert.match(sql, / ORDER BY created_at DESC$/);
      assert.ok(!sql.includes(' WHERE '));
      assert.deepEqual(params, []);
    }
  });

  test('selects all aliased columns', () => {
    const { sql } = buildPoListSql();
    for (const alias of ['"poNumber"', '"orderDateAD"', '"subtotalAmount"', PO_SELECT_COLUMNS.split(' ')[0]]) {
      assert.ok(sql.includes(alias), `missing ${alias}`);
    }
  });
});

describe('poUpsertParams', () => {
  test('fills 14 columns with documented defaults', () => {
    const po = {
      id: 'po-1', poNumber: 'PO-1', branchId: 'WH001',
      orderDateAd: '2026-01-01', orderDateBs: '2083-04-10 BS',
      subtotalAmount: 100, taxAmount: 13, totalAmount: 113,
    };
    assert.deepEqual(poUpsertParams(po, '[]'), [
      'po-1', 'PO-1', null, 'Vendor', 'WH001', '2026-01-01', '2083-04-10 BS',
      null, 'DRAFT', 100, 13, 113, '', '[]',
    ]);
  });

  test('keeps provided supplier and status; accepts both expectedDelivery spellings', () => {
    const base = { id: 'p', poNumber: 'n', subtotalAmount: 0, taxAmount: 0, totalAmount: 0, orderDateAd: '', orderDateBs: '' };
    assert.equal(poUpsertParams({ ...base, supplierId: 's1', supplierName: 'Acme', status: 'APPROVED' }, '[]')[3], 'Acme');
    assert.equal(poUpsertParams({ ...base, expectedDeliveryDateAD: '2026-02-01' }, '[]')[7], '2026-02-01');
    assert.equal(poUpsertParams({ ...base, expectedDeliveryDateAd: '2026-02-02' }, '[]')[7], '2026-02-02');
  });

  test('poUpdateParams appends the id last', () => {
    const po = { supplierName: 'Acme', branchId: 'WH001', status: 'APPROVED', subtotalAmount: 1, taxAmount: 0, totalAmount: 1, notes: 'n' };
    assert.deepEqual(poUpdateParams(po, '[{}]', 'po-9'), ['Acme', 'WH001', 'APPROVED', 1, 0, 1, 'n', '[{}]', 'po-9']);
  });

  test('poIncomingStockParams builds deterministic stock id and coerces quantity', () => {
    assert.deepEqual(
      poIncomingStockParams('WH001', { productId: 'p1', quantity: '5' }),
      ['stk-wh001-p1', 'p1', 'WH001', 5]
    );
    assert.equal(poIncomingStockParams('WH001', { productId: 'p1' })[3], 0);
  });
});

describe('buildPiListSql', () => {
  test('filters by branch and orders by created_at DESC', () => {
    const { sql, params } = buildPiListSql('BR02');
    assert.match(sql, / FROM purchase_invoices WHERE branch_id = \$1 ORDER BY created_at DESC$/);
    assert.deepEqual(params, ['BR02']);
    const unfiltered = buildPiListSql('ALL');
    assert.ok(!unfiltered.sql.includes(' WHERE '));
    assert.deepEqual(unfiltered.params, []);
  });
});

describe('piUpsertParams', () => {
  test('fills 20 columns with documented defaults', () => {
    const inv = {
      id: 'inv-1', invoiceNumber: 'PI-1', branchId: 'WH001',
      invoiceDateAD: '2026-01-01', invoiceDateBS: '2083-04-10 BS',
      taxableAmount: 100, vatAmount: 13, nonTaxableAmount: 0, grandTotal: 113,
    };
    assert.deepEqual(piUpsertParams(inv, '[]'), [
      'inv-1', 'PI-1', null, null, undefined, 'Vendor', 'WH001', '2026-01-01', '2083-04-10 BS',
      null, null, 100, 13, 0, 113, 'UNPAID', 'CREDIT', 0, '', '[]',
    ]);
  });

  test('passes supplierId through raw (controller resolves it before calling)', () => {
    assert.equal(piUpsertParams({ id: 'i', invoiceNumber: 'n', branchId: 'b', supplierId: 's1' }, '[]')[4], 's1');
  });

  test('resolves poReferenceId from poId fallback', () => {
    assert.equal(piUpsertParams({ id: 'i', invoiceNumber: 'n', branchId: 'b', poId: 'po-1' }, '[]')[2], 'po-1');
  });

  test('piReceiveStockParams builds deterministic stock id with min level 5 in SQL', () => {
    assert.deepEqual(
      piReceiveStockParams('BR01', { productId: 'p2', quantity: 3 }),
      ['stk-br01-p2', 'p2', 'BR01', 3]
    );
  });

  test('piTxnLogParams emits a PURCHASE_INVOICE log row with item defaults', () => {
    const inv = { invoiceNumber: 'PI-7', invoiceDateAD: '2026-03-01', invoiceDateBS: 'bs' };
    const params = piTxnLogParams(inv, { productId: 'p1' }, 'WH001');
    // 12 binds: quantity_before is a literal 0 and quantity binds once ($8, $8)
    assert.equal(params.length, 12);
    assert.match(params[0] as string, /^txn-\d+-p1$/);
    assert.match(params[1] as string, /^TXN-\d{5}$/);
    assert.equal(params[9], 'PI-7');
    assert.equal(params[11], 'bs');
    const fallback = piTxnLogParams({ invoiceNumber: 'PI-8' }, { productId: 'p1' }, 'WH001');
    assert.match(fallback[10] as string, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fallback[11], '2083-04-16 BS');
  });
});

describe('buildVendorPaymentWhere', () => {
  test('empty filters produce no WHERE clause', () => {
    const { where, params } = buildVendorPaymentWhere({});
    assert.equal(where, '');
    assert.deepEqual(params, []);
  });

  test('equality filters are positional and skip empty values', () => {
    const { where, params } = buildVendorPaymentWhere({
      supplierId: 's1', invoiceId: '', branchId: 'ALL', status: 'POSTED', fiscalYearId: undefined,
    });
    assert.equal(where, ' WHERE supplier_id = $1 AND status = $2');
    assert.deepEqual(params, ['s1', 'POSTED']);
  });

  test('date range conditions are appended after equality filters', () => {
    const { where, params } = buildVendorPaymentWhere({
      branchId: 'WH001', fromAd: '2026-01-01T10:00:00Z', toAd: '2026-01-31T00:00:00Z',
    });
    assert.equal(where, ' WHERE branch_id = $1 AND payment_date_ad >= $2 AND payment_date_ad <= $3');
    assert.deepEqual(params, ['WH001', '2026-01-01', '2026-01-31']);
  });
});

describe('vendor payment params', () => {
  test('vpInsertParams passes 21 values with isDemo handled in SQL as FALSE', () => {
    const p = {
      id: 'vp-1', paymentNumber: 'CP-1', supplierName: 'Acme', branchId: 'WH001',
      paymentDateAD: '2026-01-01', paymentDateBS: 'bs', amount: 500, paymentMethod: 'CASH', status: 'POSTED', createdBy: 'a@b',
    };
    const params = vpInsertParams(p);
    assert.equal(params.length, 21);
    assert.deepEqual(params, [
      'vp-1', 'CP-1', null, 'Acme', 'WH001', undefined, undefined,
      '2026-01-01', 'bs', 500, 'CASH', undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, 'POSTED', 'a@b',
    ]);
  });

  test('ledgerNameParams builds the id/name/like triple', () => {
    assert.deepEqual(ledgerNameParams({ id: 's1', name: 'Acme' }), ['s1', 'Acme', '%Acme%']);
  });
});

describe('paged purchase-order queries', () => {
  test('WHERE builder filters branch, status, supplier, dates and searches items JSONB', () => {
    const { sql, params } = buildPurchaseOrderPagedQuery({
      branchId: 'WH001',
      status: 'SENT',
      supplier: 'acme pvt',
      query: 'onu',
      dateFromAD: '2026-09-01',
      dateToAD: '2026-09-30',
    }, { page: 2, pageSize: 20 });
    assert.match(sql, /WHERE 1=1 AND branch_id = \$1 AND status = \$2 AND LOWER\(supplier_name\) = \$3/);
    assert.match(sql, /AND \(LOWER\(po_number\) LIKE \$4 OR LOWER\(supplier_name\) LIKE \$4 OR LOWER\(items::text\) LIKE \$4\)/);
    assert.match(sql, /AND order_date_ad >= \$5::date AND order_date_ad <= \$6::date/);
    assert.match(sql, / ORDER BY created_at DESC LIMIT 20 OFFSET 20$/);
    assert.deepEqual(params, ['WH001', 'SENT', 'acme pvt', '%onu%', '2026-09-01', '2026-09-30']);
    assert.ok(!buildPurchaseOrderPagedQuery({}).sql.includes('LIMIT'));
    const clamped = buildPurchaseOrderPagedQuery({}, { page: -3, pageSize: 0 });
    assert.match(clamped.sql, /LIMIT 1 OFFSET 0$/);
  });

  test('aggregate sums pending/received values; status counts group by status', () => {
    const opts = { branchId: 'WH001', status: 'SENT' };
    const agg = buildPurchaseOrderAggregateQuery(opts);
    assert.match(agg.sql, /COUNT\(\*\)::int AS count/);
    assert.match(agg.sql, /SUM\(total_amount\) FILTER \(WHERE status <> 'RECEIVED' AND status <> 'CANCELLED'\)/);
    assert.match(agg.sql, /SUM\(total_amount\) FILTER \(WHERE status = 'RECEIVED'\)/);
    assert.deepEqual(agg.params, ['WH001', 'SENT']);
    const statusCount = buildPurchaseOrderStatusCountQuery(opts);
    assert.match(statusCount.sql, /FROM purchase_orders WHERE 1=1 AND branch_id = \$1 AND status = \$2 GROUP BY status$/);
    assert.deepEqual(statusCount.params, ['WH001', 'SENT']);
  });
});

describe('paged purchase-invoice queries', () => {
  test('WHERE builder filters payment status, supplier, dates and searches items JSONB', () => {
    const { sql, params } = buildPurchaseInvoicePagedQuery({
      branchId: 'BRH01',
      paymentStatus: 'PARTIAL',
      supplier: 'acme pvt',
      query: 'bill 42',
      dateFromAD: '2026-09-01',
    }, { page: 3, pageSize: 10 });
    assert.match(sql, /WHERE 1=1 AND branch_id = \$1 AND payment_status = \$2 AND LOWER\(supplier_name\) = \$3/);
    assert.match(sql, /AND \(LOWER\(invoice_number\) LIKE \$4 OR LOWER\(COALESCE\(vendor_bill_number, ''\)\) LIKE \$4 OR LOWER\(supplier_name\) LIKE \$4 OR LOWER\(items::text\) LIKE \$4\)/);
    assert.match(sql, /AND invoice_date_ad >= \$5::date/);
    assert.match(sql, / ORDER BY created_at DESC LIMIT 10 OFFSET 20$/);
    assert.deepEqual(params, ['BRH01', 'PARTIAL', 'acme pvt', '%bill 42%', '2026-09-01']);
  });

  test('aggregate sums taxable/vat/grand/unpaid; status counts group by payment_status', () => {
    const opts = { branchId: 'WH001' };
    const agg = buildPurchaseInvoiceAggregateQuery(opts);
    assert.match(agg.sql, /COALESCE\(SUM\(taxable_amount\), 0\)::float AS taxable_sum/);
    assert.match(agg.sql, /COALESCE\(SUM\(vat_amount\), 0\)::float AS vat_sum/);
    assert.match(agg.sql, /COALESCE\(SUM\(grand_total\), 0\)::float AS grand_sum/);
    assert.match(agg.sql, /COALESCE\(SUM\(grand_total - amount_paid\), 0\)::float AS unpaid_sum/);
    assert.deepEqual(agg.params, ['WH001']);
    const statusCount = buildPurchaseInvoiceStatusCountQuery(opts);
    assert.match(statusCount.sql, /SELECT payment_status AS status, COUNT\(\*\)::int AS count FROM purchase_invoices WHERE 1=1 AND branch_id = \$1 GROUP BY payment_status$/);
    assert.deepEqual(statusCount.params, ['WH001']);
  });
});
