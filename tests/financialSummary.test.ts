/**
 * financialSummary refresh path (DF-05).
 *
 * The summary was computed only inside GET /api/bootstrap, so another client's
 * sale/payment/purchase left this tab's closing-wizard totals and financial
 * statement fallback stale until a full reload.
 *
 * PROVES:
 *  1. RULE — one pure computation; inventory valuation, fixed assets, AP
 *     (opening + invoices − payments − posted returns), VAT, damage and
 *     trading revenue/COGS all move from their own inputs.
 *  2. SLICE — GET /api/bootstrap/local?key=financialSummary serves the same
 *     object the full bootstrap computes for the same branch/FY, reflects a
 *     write committed after the first read (no server cache), and does not
 *     leak another branch's rows.
 *  3. WIRING — the bootstrap and the slice share the rule; App re-fetches the
 *     slice for every domain whose mutations change it.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { computeFinancialSummary } from '../server/src/services/financialSummary.service';
import { fetchTable } from '../server/src/models/bootstrap.repo';
import { BOOTSTRAP_TABLES } from '../server/src/models/columnMappings';
import { ensureReferenceData } from './fixtures/referenceData';

dotenv.config();

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

const BASE_SOURCE = {
  stock: [{ productId: 'p1', quantityOnHand: 7 }],
  products: [{ id: 'p1', costPrice: 100 }],
  assets: [{ netBookValue: 500 }],
  purchaseInvoices: [{ grandTotal: 1130, vatAmount: 130 }],
  vendorPayments: [{ amount: 100, status: 'POSTED' }],
  purchaseReturns: [{ grandTotal: 300, status: 'POSTED' }],
  stockOperations: [
    { type: 'STOCK_OUT', totalValue: 400, items: [{ productId: 'p1', quantity: 2, totalValue: 400, unitCost: 100 }] },
  ],
  vendorOpeningBalanceTotal: 200,
  currentFiscalYear: '2082-83',
};

describe('financialSummary — one rule', () => {
  test('every number comes from its own inputs, AP net of returns', () => {
    assert.deepEqual(computeFinancialSummary(BASE_SOURCE), {
      totalInventoryAssetValue: 700,
      totalFixedAssetValue: 500,
      totalAccountsPayable: 930,
      totalSalesRevenue: 400,
      totalCostOfGoodsSold: 200,
      totalDamageLossValue: 400,
      totalVatInputTax: 130,
      currentFiscalYear: '2082-83',
    });
  });

  test('returns, unpaid payments and a missing product cost do not silently misstate totals', () => {
    const summary = computeFinancialSummary({
      ...BASE_SOURCE,
      stock: [
        { productId: 'p1', quantityOnHand: 2 },
        { productId: 'unknown', quantityOnHand: 100 }, // unresolved product → 0
      ],
      purchaseReturns: [{ grandTotal: 300, status: 'DRAFT' }], // not POSTED
      vendorPayments: [{ amount: 100, status: 'VOIDED' }], // not POSTED
      vendorOpeningBalanceTotal: 0,
    });
    assert.equal(summary.totalInventoryAssetValue, 200);
    assert.equal(summary.totalAccountsPayable, 1130, 'open + invoices, with no posted reductions');
  });

  test('a non-sale operation contributes no trading revenue or COGS', () => {
    const summary = computeFinancialSummary({
      ...BASE_SOURCE,
      stockOperations: [
        { type: 'DAMAGE', totalValue: 50, items: [{ productId: 'p1', quantity: 1, totalValue: 999 }] },
      ],
    });
    assert.equal(summary.totalDamageLossValue, 50);
    assert.equal(summary.totalSalesRevenue, 0);
    assert.equal(summary.totalCostOfGoodsSold, 0);
  });
});

describe('financialSummary — slice wiring', () => {
  test('the bootstrap and the slice share one rule', () => {
    const controller = read('server/src/controllers/bootstrap.controller.ts');
    assert.ok(
      controller.includes('fetchFinancialSummaryFromDb(pgPool, {'),
      'both the full bootstrap and the slice must use the aggregate SQL producer'
    );
    assert.ok(
      !controller.includes('computeFinancialSummary('),
      'the full bootstrap must not load ledger rows to feed the pure rule'
    );
    assert.ok(
      controller.includes("if (key === 'financialSummary')"),
      'bootstrap/local must serve the summary key'
    );
    assert.ok(
      !controller.includes('vendorOpeningBalTotal + currentPeriodInvoiceTotal'),
      'the bootstrap must not keep a second, inline AP formula'
    );
    const service = read('server/src/services/financialSummary.service.ts');
    assert.ok(
      service.includes('buildPurchaseReturnsTotalQuery'),
      'AP must subtract posted purchase returns on both paths'
    );
    assert.ok(
      service.includes('buildTradingTotalsQuery'),
      'the slice must aggregate trading totals in SQL, not parse item JSON in Node'
    );
    assert.ok(
      !service.includes('buildStockOutOpsQuery'),
      'the slice must not select the year of STOCK_OUT item documents'
    );
  });

  test('App re-fetches the summary for every domain that changes it', () => {
    const app = read('client/src/App.tsx');
    const block = app.slice(
      app.indexOf('const DOMAIN_STATE_KEYS'),
      app.indexOf('// Paged-register refresh counters')
    );
    assert.ok(block.length > 0, 'DOMAIN_STATE_KEYS must remain a single readable map');
    for (const domain of ['STOCK', 'STOCK_OPERATIONS', 'PROCUREMENT', 'SALES', 'SHIPMENTS', 'FISCAL', 'RECALC']) {
      const line = block.split('\n').find((l) => l.trim().startsWith(`${domain}:`));
      assert.ok(line, `${domain} must stay in DOMAIN_STATE_KEYS`);
      assert.ok(
        line!.includes("'financialSummary'"),
        `${domain} mutations change the summary, so its slice must be re-fetched`
      );
    }
    const slices = read('client/src/services/bootstrapSlices.ts');
    assert.ok(
      slices.includes("financialSummary: 'financial summary'"),
      'a failed summary refresh needs a readable notice label'
    );
  });
});

// ---------------------------------------------------------------------------
// Live HTTP: the slice and the bootstrap must agree, and the slice must be live
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH = 'df05-branch';
const EMPTY_BRANCH = 'df05-empty';
const SUPPLIER = 'df05-sup';
const PRODUCT = 'df05-prod';

const SUPER_USER = {
  id: 'df05-super', email: 'df05-super@example.com', name: 'DF05 Super',
  role: 'SUPER_ADMIN', branchId: BRANCH,
  allowedBranchIds: [BRANCH, EMPTY_BRANCH], canSwitchUser: false,
} as any;

const addDays = (adDate: string, days: number): string =>
  new Date(new Date(adDate + 'T00:00:00Z').getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);

describe('financialSummary — live slice against real PostgreSQL', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);
  let fiscalYear: { id: string; code: string; startDateAD: string; endDateAD: string };
  let bizDate = '';
  let currentCode = '';

  before(async () => {
    if (!dbReachable || !pool) return;
    await ensureReferenceData(pool);
    await cleanupFixtures();

    // Use whichever year the install currently treats as current, falling back
    // to the seeded current year row. Both endpoints read the flag live, so
    // the assertion holds even if another suite changes it mid-run.
    const fyRes = await pool.query(
      `SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD", is_current AS "isCurrent"
         FROM fiscal_years
        ORDER BY is_current DESC, start_date_ad DESC
        LIMIT 1`
    );
    fiscalYear = fyRes.rows[0];
    assert.ok(fiscalYear, 'the fiscal-year master must be provisioned');
    bizDate = addDays(fiscalYear.startDateAD, 30);
    const currentRes = await pool.query(
      `SELECT code FROM fiscal_years WHERE is_current = TRUE LIMIT 1`
    );
    currentCode = currentRes.rows[0]?.code || '';

    await pool.query(
      'INSERT INTO branches (id, code, name, location) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
      [BRANCH, 'DF05', 'DF05 Fixture Branch', 'test', EMPTY_BRANCH, 'DF05E', 'DF05 Empty Branch', 'test']
    );
    await pool.query(
      'INSERT INTO suppliers (id, supplier_code, name) VALUES ($1, $2, $3)',
      [SUPPLIER, 'DF05-SUP', 'DF05 Fixture Supplier']
    );
    await pool.query(
      `INSERT INTO products (id, sku, name, category, product_group, unit, cost_price, selling_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [PRODUCT, 'DF05-SKU', 'DF05 Fixture Product', 'Fixture', 'Product Item', 'Pcs', 100, 200]
    );
    // Both valuation paths: live stock when the year is current, opening stock
    // when it is not. Either way the summary must value 7 × 100.
    await pool.query(
      'INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand) VALUES ($1, $2, $3, $4)',
      ['df05-stock', PRODUCT, BRANCH, 7]
    );
    await pool.query(
      `INSERT INTO fiscal_year_opening_stock (id, fiscal_year_id, product_id, branch_id, quantity_on_hand, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['df05-opening', fiscalYear.id, PRODUCT, BRANCH, 7, 100]
    );
    await pool.query(
      `INSERT INTO fixed_assets (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, acquisition_cost, net_book_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ['df05-asset', 'DF05-TAG', 'DF05 Fixture Asset', 'Fixture', BRANCH, bizDate, '2082-01-01', 500, 500]
    );
    await pool.query(
      `INSERT INTO vendor_opening_balances (id, fiscal_year_id, supplier_id, branch_id, opening_balance)
       VALUES ($1, $2, $3, $4, $5)`,
      ['df05-ob', fiscalYear.id, SUPPLIER, BRANCH, 200]
    );
    await pool.query(
      `INSERT INTO purchase_invoices
         (id, invoice_number, supplier_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs,
          taxable_amount, vat_amount, grand_total, amount_paid, fiscal_year_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      ['df05-inv', 'DF05-INV-1', SUPPLIER, 'DF05 Fixture Supplier', BRANCH, bizDate, '2082-01-01', 1000, 130, 1130, 0, fiscalYear.id]
    );
    await pool.query(
      `INSERT INTO purchase_returns
         (id, return_number, supplier_id, supplier_name, branch_id, return_date_ad, return_date_bs,
          taxable_amount, vat_amount, grand_total, status, fiscal_year_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'POSTED', $11)`,
      ['df05-ret', 'DF05-RET-1', SUPPLIER, 'DF05 Fixture Supplier', BRANCH, bizDate, '2082-01-01', 300, 0, 300, fiscalYear.id]
    );
    await pool.query(
      `INSERT INTO vendor_payments
         (id, payment_number, supplier_id, supplier_name, branch_id, payment_date_ad, payment_date_bs, amount, status, fiscal_year_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'POSTED', $9)`,
      ['df05-pay', 'DF05-PAY-1', SUPPLIER, 'DF05 Fixture Supplier', BRANCH, bizDate, '2082-01-01', 100, fiscalYear.id]
    );
    await pool.query(
      `INSERT INTO stock_operations
         (id, reference_number, type, branch_id, quantity_changed, total_value, reason, date_ad, date_bs, fiscal_year_id, items)
       VALUES ($1, $2, 'STOCK_OUT', $3, -2, 400, 'DF05 fixture sale', $4, '2082-01-01', $5, $6::jsonb)`,
      [
        'df05-op',
        'DF05-SALE-1',
        BRANCH,
        bizDate,
        fiscalYear.id,
        JSON.stringify([{ productId: PRODUCT, quantity: 2, totalValue: 400, unitCost: 100 }]),
      ]
    );

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });
  });

  after(async () => {
    if (close) await close();
    if (pool && dbReachable) {
      await cleanupFixtures().catch(() => undefined);
      await pool.end();
    }
  });

  async function cleanupFixtures() {
    if (!pool) return;
    await pool.query("DELETE FROM stock_operations WHERE id LIKE 'df05-%'");
    await pool.query("DELETE FROM vendor_payments WHERE id LIKE 'df05-%'");
    await pool.query("DELETE FROM purchase_returns WHERE id LIKE 'df05-%'");
    await pool.query("DELETE FROM purchase_invoices WHERE id LIKE 'df05-%'");
    await pool.query("DELETE FROM vendor_opening_balances WHERE id LIKE 'df05-%'");
    await pool.query("DELETE FROM fiscal_year_opening_stock WHERE id LIKE 'df05-%'");
    await pool.query("DELETE FROM inventory_stock WHERE id LIKE 'df05-%'");
    await pool.query("DELETE FROM fixed_assets WHERE id LIKE 'df05-%'");
    await pool.query("DELETE FROM products WHERE id = $1", [PRODUCT]);
    await pool.query("DELETE FROM suppliers WHERE id = $1", [SUPPLIER]);
    await pool.query('DELETE FROM branches WHERE id IN ($1, $2)', [BRANCH, EMPTY_BRANCH]);
  }

  async function get(pathname: string, withToken = true) {
    const res = await fetch('http://127.0.0.1:' + port + pathname, {
      headers: withToken ? { authorization: 'Bearer ' + token } : {},
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  const scopeQuery = (branchId: string) =>
    `branchId=${branchId}&fiscalYearId=${fiscalYear.id}`;

  test('guard: no bearer token -> 401', { skip: skipNoDb }, async () => {
    const { status } = await get('/api/bootstrap/local?key=financialSummary&branchId=' + BRANCH, false);
    assert.equal(status, 401);
  });

  test('slice equals the full bootstrap for the same branch and fiscal year', { skip: skipNoDb }, async () => {
    const slice = await get('/api/bootstrap/local?key=financialSummary&' + scopeQuery(BRANCH));
    const full = await get('/api/bootstrap?' + scopeQuery(BRANCH));
    assert.equal(slice.status, 200, JSON.stringify(slice.json));
    assert.equal(full.status, 200, JSON.stringify(full.json));
    assert.ok(typeof slice.json?.dataVersion === 'number', 'slice must carry dataVersion');

    const expected = {
      totalInventoryAssetValue: 700,
      totalFixedAssetValue: 500,
      totalAccountsPayable: 930,
      totalSalesRevenue: 400,
      totalCostOfGoodsSold: 200,
      totalDamageLossValue: 400,
      totalVatInputTax: 130,
      currentFiscalYear: currentCode,
    };
    assert.deepEqual(slice.json.financialSummary, expected);
    assert.deepEqual(
      full.json.financialSummary,
      expected,
      'the bootstrap and the targeted slice must agree, not just both be plausible'
    );
  });

  test('full bootstrap summary equals the pure rule rebuilt from the same rows', { skip: skipNoDb }, async () => {
    const scope = {
      branchId: BRANCH,
      fiscalYearId: fiscalYear.id,
      fiscalYearStartAD: fiscalYear.startDateAD,
      fiscalYearEndAD: fiscalYear.endDateAD,
    };
    const [
      stock,
      products,
      assets,
      purchaseInvoices,
      vendorPayments,
      purchaseReturns,
      stockOperations,
    ] = await Promise.all([
      fetchTable(pool!, BOOTSTRAP_TABLES.stock, scope),
      fetchTable(pool!, BOOTSTRAP_TABLES.products, scope),
      fetchTable(pool!, BOOTSTRAP_TABLES.assets, scope),
      fetchTable(pool!, BOOTSTRAP_TABLES.purchaseInvoices, scope),
      fetchTable(pool!, BOOTSTRAP_TABLES.vendorPayments, scope),
      fetchTable(pool!, BOOTSTRAP_TABLES.purchaseReturns, scope),
      fetchTable(pool!, BOOTSTRAP_TABLES.stockOperations, scope),
    ]);
    const openingRes = await pool!.query(
      `SELECT COALESCE(SUM(opening_balance), 0)::float AS total
         FROM vendor_opening_balances
        WHERE fiscal_year_id = $1 AND branch_id = $2`,
      [fiscalYear.id, BRANCH]
    );
    const expected = computeFinancialSummary({
      stock,
      products,
      assets,
      purchaseInvoices,
      vendorPayments,
      purchaseReturns,
      stockOperations,
      vendorOpeningBalanceTotal: Number(openingRes.rows[0]?.total || 0),
      currentFiscalYear: currentCode,
    });

    const full = await get('/api/bootstrap?' + scopeQuery(BRANCH));
    assert.equal(full.status, 200, JSON.stringify(full.json));
    assert.deepEqual(
      full.json.financialSummary,
      expected,
      'the SQL producer must match the pure rule on the same rows, not only on hand-written fixtures'
    );
  });

  test('a write committed after the first read is visible on the next slice read', { skip: skipNoDb }, async () => {
    const first = await get('/api/bootstrap/local?key=financialSummary&' + scopeQuery(BRANCH));
    assert.equal(first.status, 200);
    assert.equal(first.json.financialSummary.totalAccountsPayable, 930);

    await pool!.query(
      `INSERT INTO purchase_invoices
         (id, invoice_number, supplier_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs,
          taxable_amount, vat_amount, grand_total, amount_paid, fiscal_year_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      ['df05-inv2', 'DF05-INV-2', SUPPLIER, 'DF05 Fixture Supplier', BRANCH, bizDate, '2082-01-01', 500, 0, 500, 0, fiscalYear.id]
    );

    const second = await get('/api/bootstrap/local?key=financialSummary&' + scopeQuery(BRANCH));
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(
      second.json.financialSummary.totalAccountsPayable,
      1430,
      'the slice must read live aggregates, never a cached summary'
    );
    assert.ok(
      second.json.dataVersion >= first.json.dataVersion,
      'the slice must report the server dataVersion it was computed under'
    );
  });

  test('another branch in the same fiscal year sees none of these rows', { skip: skipNoDb }, async () => {
    const { status, json } = await get(
      '/api/bootstrap/local?key=financialSummary&' + scopeQuery(EMPTY_BRANCH)
    );
    assert.equal(status, 200, JSON.stringify(json));
    assert.deepEqual(
      {
        inventory: json.financialSummary.totalInventoryAssetValue,
        assets: json.financialSummary.totalFixedAssetValue,
        ap: json.financialSummary.totalAccountsPayable,
        revenue: json.financialSummary.totalSalesRevenue,
        vat: json.financialSummary.totalVatInputTax,
      },
      { inventory: 0, assets: 0, ap: 0, revenue: 0, vat: 0 },
      'the summary must be branch-scoped, not the consolidated total'
    );
  });

  test('batch read: one request for every pair, each equal to its single read', { skip: skipNoDb }, async () => {
    const batch = await get(
      `/api/reports/financial-summaries?branchIds=${BRANCH},${EMPTY_BRANCH}&fiscalYearIds=${fiscalYear.id}`
    );
    assert.equal(batch.status, 200, JSON.stringify(batch.json));
    const summaries = batch.json?.summaries || {};
    assert.deepEqual(Object.keys(summaries).sort(), [
      `${BRANCH}|${fiscalYear.id}`,
      `${EMPTY_BRANCH}|${fiscalYear.id}`,
    ], 'the response must be keyed exactly as the caller asked');

    const single = await get(
      `/api/reports/financial-summary?branchId=${BRANCH}&fiscalYearId=${fiscalYear.id}`
    );
    assert.equal(single.status, 200, JSON.stringify(single.json));
    assert.deepEqual(
      summaries[`${BRANCH}|${fiscalYear.id}`],
      single.json,
      'the batch entry must be the same read as the single endpoint, not a second formula'
    );
    assert.deepEqual(
      {
        inventory: summaries[`${EMPTY_BRANCH}|${fiscalYear.id}`].totalInventoryAssetValue,
        assets: summaries[`${EMPTY_BRANCH}|${fiscalYear.id}`].totalFixedAssetValue,
        ap: summaries[`${EMPTY_BRANCH}|${fiscalYear.id}`].totalAccountsPayable,
        revenue: summaries[`${EMPTY_BRANCH}|${fiscalYear.id}`].totalSalesRevenue,
      },
      { inventory: 0, assets: 0, ap: 0, revenue: 0 },
      'a branch with no rows must still get its own zeroed entry'
    );
  });

  test('batch read: a posted purchase return lowers AP on the report path too', { skip: skipNoDb }, async () => {
    const batch = await get(
      `/api/reports/financial-summaries?branchIds=${BRANCH}&fiscalYearIds=${fiscalYear.id}`
    );
    const summary = batch.json.summaries[`${BRANCH}|${fiscalYear.id}`];
    // Fixture: opening 200 + invoices (1130 + the 500 inserted by the
    // write-freshness test) − posted payment 100 − posted return 300 = 1430.
    // The old inline SQL here omitted the return term and reported 1730.
    assert.equal(
      summary.totalAccountsPayable,
      1430,
      'the report path must subtract posted returns, exactly like the bootstrap slice'
    );
  });

  test('batch guard: no bearer token -> 401', { skip: skipNoDb }, async () => {
    const { status } = await get(
      `/api/reports/financial-summaries?branchIds=${BRANCH}&fiscalYearIds=${fiscalYear.id}`,
      false
    );
    assert.equal(status, 401);
  });
});
