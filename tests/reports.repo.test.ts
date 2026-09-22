/**
 * Unit tests for the reports repo query builders (node:test).
 * Verifies SQL text, scope accumulation, and param ordering without a
 * live database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFiscalYearScope,
  appendBranchScope,
  appendAdDateRangeScope,
  whereClause,
  buildInventoryValueQuery,
  buildFixedAssetValueQuery,
  buildPurchaseInvoiceTotalsQuery,
  buildVendorOpeningBalanceQuery,
  buildVendorPaymentsQuery,
  buildDamageLossQuery,
  buildStockOutOpsQuery,
  PRODUCT_COST_PRICE_SQL,
} from '../server/src/models/reports.repo';

describe('reports.repo', () => {
  describe('scope accumulators', () => {
    test('appendFiscalYearScope pushes the id and binds the next placeholder', () => {
      const conds: string[] = [];
      const params: unknown[] = [];
      appendFiscalYearScope(conds, params, 'FY-1');
      assert.deepEqual(conds, ['fiscal_year_id = $1']);
      assert.deepEqual(params, ['FY-1']);
    });

    test('appendBranchScope skips empty branch selections', () => {
      const conds: string[] = [];
      const params: unknown[] = [];
      appendBranchScope(conds, params, undefined);
      assert.deepEqual(conds, []);
      assert.deepEqual(params, []);
    });

    test('appendAdDateRangeScope binds start before end on the given column', () => {
      const conds: string[] = [];
      const params: unknown[] = [];
      appendAdDateRangeScope(conds, params, 'date_ad', '2082-01-01', '2082-12-30');
      assert.deepEqual(conds, ['date_ad >= $1', 'date_ad <= $2']);
      assert.deepEqual(params, ['2082-01-01', '2082-12-30']);
    });

    test('whereClause joins with AND and yields empty string unscoped', () => {
      assert.equal(whereClause([]), '');
      assert.equal(whereClause(['a = $1', 'b = $2']), ' WHERE a = $1 AND b = $2');
    });
  });

  describe('inventory value', () => {
    test('opening-stock path scopes fiscal_year_id first, then branch', () => {
      const { sql, params } = buildInventoryValueQuery({
        useOpeningStock: true,
        fiscalYearId: 'FY-9',
        branchId: 'BR-1',
      });
      assert.match(sql, /FROM fiscal_year_opening_stock os/);
      assert.match(sql, /WHERE os\.fiscal_year_id = \$1/);
      assert.match(sql, /AND os\.branch_id = \$2/);
      assert.deepEqual(params, ['FY-9', 'BR-1']);
    });

    test('live-stock path joins products and filters branch only', () => {
      const { sql, params } = buildInventoryValueQuery({ useOpeningStock: false, branchId: 'BR-2' });
      assert.match(sql, /FROM inventory_stock s/);
      assert.match(sql, /JOIN products p ON s\.product_id = p\.id/);
      assert.match(sql, /WHERE s\.branch_id = \$1/);
      assert.deepEqual(params, ['BR-2']);
    });

    test('unscoped live-stock path emits no WHERE clause', () => {
      const { sql, params } = buildInventoryValueQuery({ useOpeningStock: false });
      assert.doesNotMatch(sql, /WHERE/);
      assert.deepEqual(params, []);
    });
  });

  describe('fixed asset value', () => {
    test('branch scope adds a single placeholder', () => {
      const { sql, params } = buildFixedAssetValueQuery(true, 'BR-3');
      assert.equal(sql, 'SELECT SUM(net_book_value) AS total FROM fixed_assets WHERE branch_id = $1');
      assert.deepEqual(params, ['BR-3']);
    });

    test('unscoped variant passes no params', () => {
      const { sql, params } = buildFixedAssetValueQuery(false);
      assert.equal(sql, 'SELECT SUM(net_book_value) AS total FROM fixed_assets');
      assert.deepEqual(params, []);
    });
  });

  describe('accounts payable components', () => {
    test('purchase invoice totals scope FY then branch', () => {
      const { sql, params } = buildPurchaseInvoiceTotalsQuery({ fiscalYearId: 'FY-1', branchId: 'BR-1' });
      assert.match(sql, /SELECT SUM\(grand_total\) AS total_invoiced, SUM\(vat_amount\) AS total_vat FROM purchase_invoices/);
      assert.match(sql, /WHERE fiscal_year_id = \$1 AND branch_id = \$2/);
      assert.deepEqual(params, ['FY-1', 'BR-1']);
    });

    test('vendor opening balances use COALESCE with a float cast', () => {
      const { sql } = buildVendorOpeningBalanceQuery({ fiscalYearId: 'FY-1' });
      assert.match(sql, /COALESCE\(SUM\(opening_balance\), 0\)::float AS total_ob FROM vendor_opening_balances/);
      assert.match(sql, /WHERE fiscal_year_id = \$1/);
    });

    test('vendor payments filter the payment_date_ad range and POSTED status', () => {
      const { sql, params } = buildVendorPaymentsQuery({
        startDateAD: '2082-01-01',
        endDateAD: '2082-12-30',
        branchId: 'BR-5',
      });
      assert.match(sql, /payment_date_ad >= \$1/);
      assert.match(sql, /payment_date_ad <= \$2/);
      assert.match(sql, /branch_id = \$3/);
      assert.match(sql, /status = 'POSTED'/);
      assert.deepEqual(params, ['2082-01-01', '2082-12-30', 'BR-5']);
    });

    test('vendor payments without a range still require POSTED status', () => {
      const { sql, params } = buildVendorPaymentsQuery({});
      assert.equal(sql, "SELECT COALESCE(SUM(amount), 0)::float AS total_paid FROM vendor_payments WHERE status = 'POSTED'");
      assert.deepEqual(params, []);
    });
  });

  describe('damage loss and sales', () => {
    test('damage loss sums total_value over stock_operations in scope', () => {
      const { sql, params } = buildDamageLossQuery({ fiscalYearId: 'FY-2', branchId: 'BR-2' });
      assert.match(sql, /SELECT SUM\(total_value\) AS total FROM stock_operations/);
      assert.deepEqual(params, ['FY-2', 'BR-2']);
    });

    test('stock-out ops always constrain type and range date_ad', () => {
      const { sql, params } = buildStockOutOpsQuery({
        startDateAD: '2081-01-01',
        endDateAD: '2081-12-30',
      });
      assert.equal(
        sql,
        "SELECT items FROM stock_operations WHERE type = 'STOCK_OUT' AND date_ad >= $1 AND date_ad <= $2"
      );
      assert.deepEqual(params, ['2081-01-01', '2081-12-30']);
    });

    test('stock-out ops keep the type constraint even fully unscoped', () => {
      const { sql, params } = buildStockOutOpsQuery({});
      assert.match(sql, /type = 'STOCK_OUT'/);
      assert.deepEqual(params, []);
    });
  });

  test('PRODUCT_COST_PRICE_SQL aliases cost_price to costPrice', () => {
    assert.equal(PRODUCT_COST_PRICE_SQL, 'SELECT id, cost_price AS "costPrice" FROM products');
  });
});
