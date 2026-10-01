/**
 * Unit tests for the returns-module repo query builders (node:test).
 *
 * Verifies the SQL text and param ordering for sales invoices, purchase
 * returns (debit notes) and sales returns (credit notes) without a live
 * database — same conventions as tests/procurement.repo.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPurchaseReturnListSql,
  prInsertParams,
  prTxnLogParams,
  PR_SELECT_COLUMNS,
  PR_INSERT_SQL,
  PR_DEDUCT_STOCK_SQL,
  PR_RETURNED_QTY_SQL,
  PR_CANCEL_SQL,
  PR_TXN_LOG_SQL,
  PR_SERIAL_FLIP_SQL,
  PR_POST_DRAFT_SQL,
  PR_CANCEL_DRAFT_SQL,
} from '../server/src/models/procurement.repo';
import {
  buildSalesInvoiceListSql,
  siInsertParams,
  siTxnLogParams,
  buildSalesReturnListSql,
  srInsertParams,
  srRestockParams,
  srTxnLogParams,
  SI_INSERT_SQL,
  SI_DEDUCT_STOCK_SQL,
  SI_TXN_LOG_SQL,
  SR_INSERT_SQL,
  SR_RESTOCK_SQL,
  SR_RETURNED_QTY_SQL,
  SR_CANCEL_SQL,
  SR_TXN_LOG_SQL,
  SR_SELECT_COLUMNS,
  LEDGER_CUSTOMER_INVOICES_SQL,
  LEDGER_CUSTOMER_RETURNS_SQL,
  SR_SERIAL_FLIP_SQL,
  SR_DAMAGE_INSERT_SQL,
  srDamageInsertParams,
  SR_DAMAGE_CANCEL_SQL,
  SR_POST_DRAFT_SQL,
  SR_CANCEL_DRAFT_SQL,
} from '../server/src/models/sales.repo';
import { LEDGER_RETURNS_SQL } from '../server/src/models/procurement.repo';

describe('purchase returns repo', () => {
  test('list SQL filters by branch and orders by created_at DESC', () => {
    const filtered = buildPurchaseReturnListSql('WH001');
    assert.match(filtered.sql, / WHERE branch_id = \$1 ORDER BY created_at DESC$/);
    assert.deepEqual(filtered.params, ['WH001']);

    for (const branchId of ['ALL', undefined]) {
      const { sql, params } = buildPurchaseReturnListSql(branchId);
      assert.ok(!sql.includes(' WHERE '));
      assert.match(sql, / ORDER BY created_at DESC$/);
      assert.deepEqual(params, []);
    }
  });

  test('insert SQL has 17 columns/params and param builder maps them in order', () => {
    assert.equal((PR_INSERT_SQL.match(/\$\d+/g) || []).length, 17);
    const ret = {
      id: 'pr-1', returnNumber: 'DN-BRC01-202609010001',
      originalInvoiceId: 'inv-1', originalInvoiceNumber: 'PI-BRC01-202609010001',
      supplierId: 'sup-1', supplierName: 'Vendor', branchId: 'WH001',
      returnDateAD: '2026-09-01', returnDateBS: '2083-05-18 BS',
      reason: 'DEFECTIVE', notes: 'n', taxableAmount: 100, vatAmount: 13,
      nonTaxableAmount: 0, grandTotal: 113, status: 'POSTED',
    };
    const p = prInsertParams(ret, '[]');
    assert.equal(p.length, 17);
    assert.equal(p[0], 'pr-1');
    assert.equal(p[1], 'DN-BRC01-202609010001');
    assert.equal(p[9], 'DEFECTIVE');
    assert.equal(p[15], 'POSTED');
    assert.equal(p[16], '[]');
  });

  test('over-return guard aggregates posted returns per (invoice, product)', () => {
    assert.match(PR_RETURNED_QTY_SQL, /jsonb_array_elements\(items\)/);
    assert.match(PR_RETURNED_QTY_SQL, /status = 'POSTED'/);
    assert.match(PR_RETURNED_QTY_SQL, /original_invoice_id = \$1/);
    assert.match(PR_RETURNED_QTY_SQL, /item->>'productId' = \$2/);
  });

  test('stock deduction guards on quantity_on_hand', () => {
    assert.match(PR_DEDUCT_STOCK_SQL, /quantity_on_hand >= \$1/);
    assert.match(PR_DEDUCT_STOCK_SQL, /quantity_on_hand = quantity_on_hand - \$1/);
  });

  test('cancel flips status only when still POSTED', () => {
    assert.match(PR_CANCEL_SQL, /status = 'CANCELLED'/);
    assert.match(PR_CANCEL_SQL, /status = 'POSTED'/);
  });

  test('txn log rows use the PURCHASE_RETURN change type with negative quantity', () => {
    const p = prTxnLogParams(
      { returnNumber: 'DN-1', returnDateAD: '2026-09-01' },
      { productId: 'p1', sku: 'S1', productName: 'P1', quantity: 3, unitPrice: 10 },
      'WH001', 2
    );
    assert.equal(p[6], 'PURCHASE_RETURN');
    assert.equal(p[7], -3);
    assert.match(PR_TXN_LOG_SQL, /change_type/);
  });

  test('serial flips target RETURNED_TO_VENDOR and append history entries', () => {
    assert.match(PR_SERIAL_FLIP_SQL, /status = \$2/);
    assert.match(PR_SERIAL_FLIP_SQL, /device_serial = ANY\(\$1::text\[\]\)/);
    assert.match(PR_SERIAL_FLIP_SQL, /history_json/);
    assert.match(PR_SERIAL_FLIP_SQL, /jsonb/);
  });

  test('approval gating: DRAFT → POSTED flip is status-guarded', () => {
    assert.match(PR_POST_DRAFT_SQL, /status = 'POSTED'/);
    assert.match(PR_POST_DRAFT_SQL, /status = 'DRAFT'/);
    assert.match(PR_CANCEL_DRAFT_SQL, /status = 'CANCELLED'/);
    assert.match(PR_CANCEL_DRAFT_SQL, /status = 'DRAFT'/);
  });
});

describe('sales invoices repo', () => {
  test('list SQL filters by branch and orders by created_at DESC', () => {
    const filtered = buildSalesInvoiceListSql('BR002');
    assert.match(filtered.sql, / WHERE branch_id = \$1 ORDER BY created_at DESC$/);
    assert.deepEqual(filtered.params, ['BR002']);
  });

  test('insert SQL has 18 columns/params and param builder maps them in order', () => {
    assert.equal((SI_INSERT_SQL.match(/\$\d+/g) || []).length, 18);
    const inv = {
      id: 'si-1', invoiceNumber: 'INV-BRC01-202609010001',
      customerId: 'cus-1', customerName: 'Customer', branchId: 'WH001',
      invoiceDateAD: '2026-09-01', invoiceDateBS: '2083-05-18 BS',
      taxableAmount: 200, vatAmount: 26, nonTaxableAmount: 0,
      grandTotal: 226, paymentStatus: 'PAID', paymentMethod: 'CASH', amountPaid: 226,
    };
    const p = siInsertParams(inv, '[]');
    assert.equal(p.length, 18);
    assert.equal(p[0], 'si-1');
    assert.equal(p[12], 226);
    assert.equal(p[13], 'PAID');
    assert.equal(p[17], '[]');
  });

  test('selling deducts stock with a no-negative-stock guard', () => {
    assert.match(SI_DEDUCT_STOCK_SQL, /quantity_on_hand >= \$1/);
    assert.match(SI_DEDUCT_STOCK_SQL, /quantity_on_hand = quantity_on_hand - \$1/);
    assert.match(SI_TXN_LOG_SQL, /change_type/);
  });

  test('txn log rows use the SALES_INVOICE change type with negative quantity', () => {
    const p = siTxnLogParams(
      { invoiceNumber: 'INV-1', invoiceDateAD: '2026-09-01' },
      { productId: 'p1', sku: 'S1', productName: 'P1', quantity: 2, unitPrice: 5 },
      'WH001', 0
    );
    assert.equal(p[6], 'SALES_INVOICE');
    assert.equal(p[7], -2);
  });
});

describe('sales returns repo', () => {
  test('list SQL filters by branch and orders by created_at DESC', () => {
    const filtered = buildSalesReturnListSql('BR002');
    assert.match(filtered.sql, / WHERE branch_id = \$1 ORDER BY created_at DESC$/);
    assert.deepEqual(filtered.params, ['BR002']);
  });

  test('insert SQL has 18 columns/params; restockable defaults to TRUE', () => {
    assert.equal((SR_INSERT_SQL.match(/\$\d+/g) || []).length, 18);
    const ret = {
      id: 'sr-1', returnNumber: 'CN-BRC01-202609010001',
      originalInvoiceId: 'si-1', originalInvoiceNumber: 'INV-BRC01-202609010001',
      customerId: 'cus-1', customerName: 'Customer', branchId: 'WH001',
      returnDateAD: '2026-09-01', returnDateBS: '2083-05-18 BS',
      reason: 'WRONG_ITEM', taxableAmount: 100, vatAmount: 13,
      nonTaxableAmount: 0, grandTotal: 113, status: 'POSTED',
    };
    const withFlag = srInsertParams({ ...ret, restockable: false }, '[]');
    assert.equal(withFlag[10], false);
    const withoutFlag = srInsertParams(ret, '[]');
    assert.equal(withoutFlag[10], true);
  });

  test('restock upserts stock additively with a deterministic id', () => {
    assert.match(SR_RESTOCK_SQL, /ON CONFLICT \(product_id, branch_id\)/);
    assert.match(SR_RESTOCK_SQL, /quantity_on_hand = inventory_stock\.quantity_on_hand \+ \$4/);
    const p = srRestockParams('WH001', { productId: 'p1', quantity: 4 });
    assert.equal(p[0], 'stk-wh001-p1');
    assert.equal(p[3], 4);
  });

  test('over-return guard aggregates posted returns per (invoice, product)', () => {
    assert.match(SR_RETURNED_QTY_SQL, /jsonb_array_elements\(items\)/);
    assert.match(SR_RETURNED_QTY_SQL, /status = 'POSTED'/);
    assert.match(SR_RETURNED_QTY_SQL, /original_invoice_id = \$1/);
    assert.match(SR_RETURNED_QTY_SQL, /item->>'productId' = \$2/);
  });

  test('cancel flips status only when still POSTED', () => {
    assert.match(SR_CANCEL_SQL, /status = 'CANCELLED'/);
    assert.match(SR_CANCEL_SQL, /status = 'POSTED'/);
  });

  test('txn log rows use the SALES_RETURN change type with positive quantity', () => {
    const p = srTxnLogParams(
      { returnNumber: 'CN-1', returnDateAD: '2026-09-01' },
      { productId: 'p1', sku: 'S1', productName: 'P1', quantity: 2, unitPrice: 8 },
      'WH001', 1
    );
    assert.equal(p[6], 'SALES_RETURN');
    assert.equal(p[7], 2);
    assert.match(SR_TXN_LOG_SQL, /change_type/);
  });

  test('select projections expose camelCase columns', () => {
    assert.match(PR_SELECT_COLUMNS, /return_number AS "returnNumber"/);
    assert.match(PR_SELECT_COLUMNS, /grand_total AS "grandTotal"/);
    assert.match(SR_SELECT_COLUMNS, /return_number AS "returnNumber"/);
    assert.match(SR_SELECT_COLUMNS, /restockable/);
    assert.match(SR_SELECT_COLUMNS, /grand_total AS "grandTotal"/);
  });

  test('ledger SQL: purchase-return debit notes reduce the vendor payable', () => {
    assert.match(LEDGER_RETURNS_SQL, /status = 'POSTED'/);
    assert.match(LEDGER_RETURNS_SQL, /supplier_id = \$1/);
    assert.match(LEDGER_RETURNS_SQL, /grand_total AS "grandTotal"/);
  });

  test('ledger SQL: customer receivables match by FK with legacy name fallback', () => {
    assert.match(LEDGER_CUSTOMER_INVOICES_SQL, /customer_id = \$1/);
    assert.match(LEDGER_CUSTOMER_INVOICES_SQL, /amount_paid AS "amountPaid"/);
    assert.match(LEDGER_CUSTOMER_RETURNS_SQL, /status = 'POSTED'/);
    assert.match(LEDGER_CUSTOMER_RETURNS_SQL, /customer_id = \$1/);
    assert.match(LEDGER_CUSTOMER_RETURNS_SQL, /grand_total AS "grandTotal"/);
  });

  test('serial flips: sales returns restock units to IN_STOCK and clear the customer', () => {
    assert.match(SR_SERIAL_FLIP_SQL, /status = \$2/);
    assert.match(SR_SERIAL_FLIP_SQL, /customer_id = NULL/);
    assert.match(SR_SERIAL_FLIP_SQL, /history_json/);
  });

  test('non-restockable returns route units to the damage register (RETURN_DAMAGE)', () => {
    assert.match(SR_DAMAGE_INSERT_SQL, /'RETURN_DAMAGE'/);
    assert.match(SR_DAMAGE_INSERT_SQL, /'IDENTIFIED'/);
    const p = srDamageInsertParams(
      { id: 'sr-1', returnNumber: 'CN-WH001-202609010001', returnDateAD: '2026-09-01', returnDateBS: '2083-05-18 BS', notes: '' },
      { productId: 'p1', quantity: 2, unitPrice: 100 },
      'WH001',
      'CN-WH001-202609010001-SR-0',
      'tester@example.com'
    );
    assert.equal(p[1], 'CN-WH001-202609010001-SR-0');
    assert.equal(p[4], 2);
    assert.equal(p[6], 200);
    // Cancel only touches IDENTIFIED rows of the same return.
    assert.match(SR_DAMAGE_CANCEL_SQL, /LIKE \$1/);
    assert.match(SR_DAMAGE_CANCEL_SQL, /status = 'IDENTIFIED'/);
  });

  test('sales approval gating: DRAFT → POSTED flip is status-guarded', () => {
    assert.match(SR_POST_DRAFT_SQL, /status = 'POSTED'/);
    assert.match(SR_POST_DRAFT_SQL, /status = 'DRAFT'/);
    assert.match(SR_CANCEL_DRAFT_SQL, /status = 'DRAFT'/);
  });
});
