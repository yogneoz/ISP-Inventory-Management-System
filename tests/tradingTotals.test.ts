/**
 * SUM-1 — the SQL trading aggregate and the pure rule must agree.
 *
 * The financial-summary slice used to select every STOCK_OUT `items` document
 * for the fiscal year/branch and parse it in Node on each refresh. The slice
 * now gets two numbers from one PostgreSQL aggregate
 * (`buildTradingTotalsQuery`); the full bootstrap still uses the pure
 * `computeTradingFromOps` rule. This suite feeds the same fixture rows through
 * both and proves they produce the same revenue and COGS, including the
 * awkward cases the rule has: a zero/missing `totalValue`, an asset-issue line
 * with no price fields, a discount larger than the line, a missing product
 * cost, numeric strings, negative quantities and a multi-line operation.
 *
 * Runs against a real PostgreSQL (skipped with a named reason when the DB is
 * unreachable), using a private branch/product fixture that is removed after.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { buildTradingTotalsQuery } from '../server/src/models/reports.repo';
import { computeTradingFromOps } from '../server/src/utils/trading';

dotenv.config();

const BRANCH = 'sum1-branch';
const OTHER_BRANCH = 'sum1-branch-2';
const PRODUCT = 'sum1-prod';
const DATE = '2090-06-15';
const START = '2090-01-01';
const END = '2090-12-31';

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

interface FixtureOp {
  id: string;
  type: string;
  branchId: string;
  dateAD: string;
  items: unknown;
}

const OPS: FixtureOp[] = [
  {
    id: 'sum1-op-1',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: 2, totalValue: 400, unitCost: 100 }],
  },
  {
    // totalValue is the string "0": Number("0") is falsy, so the selling-price
    // fallback applies. COGS has no unitCost, so the product cost (20) is used.
    id: 'sum1-op-2',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: 3, totalValue: '0', sellingPrice: 50, discount: 10 }],
  },
  {
    // Asset-issue shape: no totalValue and no sellingPrice -> skipped, including
    // its quantity (it must not contribute COGS).
    id: 'sum1-op-3',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: 5 }],
  },
  {
    // Deleted/unknown product and a zero unitCost: revenue counts, COGS is 0.
    id: 'sum1-op-4',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: 'sum1-missing', quantity: 1, totalValue: 250, unitCost: 0 }],
  },
  {
    // The discount swallows the line: revenue is 0, but COGS still accrues for
    // the positive quantity.
    id: 'sum1-op-5',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: 2, sellingPrice: 100, discount: 500, unitCost: 10 }],
  },
  {
    // Negative quantity: revenue from totalValue counts, COGS does not.
    id: 'sum1-op-6',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: -1, totalValue: 50 }],
  },
  {
    // JSON null totalValue is NOT undefined: the line is not skipped, the value
    // falls back to sellingPrice, and COGS uses the product cost.
    id: 'sum1-op-7',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: 1, totalValue: null, sellingPrice: 30 }],
  },
  {
    // Numeric strings are accepted by Number(...) in the pure rule; the SQL
    // safe-cast must accept them too.
    id: 'sum1-op-8',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: '2', sellingPrice: '25.5', discount: '0.5', unitCost: '5' }],
  },
  {
    // Two lines in one operation: both count.
    id: 'sum1-op-9',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: [
      { productId: PRODUCT, quantity: 1, totalValue: 10 },
      { productId: PRODUCT, quantity: 2, sellingPrice: 5 },
    ],
  },
  {
    // Not a sale: the query's type filter must exclude it.
    id: 'sum1-op-10',
    type: 'DAMAGE',
    branchId: BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: 99, totalValue: 999 }],
  },
  {
    // Another branch in the same date range: the branch scope must exclude it.
    id: 'sum1-op-11',
    type: 'STOCK_OUT',
    branchId: OTHER_BRANCH,
    dateAD: DATE,
    items: [{ productId: PRODUCT, quantity: 1, totalValue: 1000 }],
  },
  {
    // Malformed items (not an array): the pure rule treats it as no lines and
    // the SQL must not throw on jsonb_to_recordset.
    id: 'sum1-op-12',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: DATE,
    items: { note: 'not an array' },
  },
  {
    // Outside the date range: the scope must exclude it.
    id: 'sum1-op-13',
    type: 'STOCK_OUT',
    branchId: BRANCH,
    dateAD: '2089-12-31',
    items: [{ productId: PRODUCT, quantity: 1, totalValue: 5000 }],
  },
];

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query("DELETE FROM stock_operations WHERE id LIKE 'sum1-%'");
  await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
  await pool.query('DELETE FROM branches WHERE id IN ($1, $2)', [BRANCH, OTHER_BRANCH]);
}

describe('SUM-1 — SQL trading totals equal the pure rule', () => {
  before(async () => {
    if (!dbReachable || !pool) return;
    await cleanup();
    await pool.query(
      'INSERT INTO branches (id, code, name, location) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
      [BRANCH, 'SUM1', 'SUM-1 Fixture Branch', 'test', OTHER_BRANCH, 'SUM1B', 'SUM-1 Other Branch', 'test']
    );
    await pool.query(
      `INSERT INTO products (id, sku, name, category, product_group, unit, cost_price, selling_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [PRODUCT, 'SUM1-SKU', 'SUM-1 Fixture Product', 'Fixture', 'Product Item', 'Pcs', 20, 30]
    );
    for (const op of OPS) {
      await pool.query(
        `INSERT INTO stock_operations
           (id, reference_number, type, branch_id, quantity_changed, total_value, reason, date_ad, date_bs, items)
         VALUES ($1, $2, $3, $4, 0, 0, $5, $6, '2090-01-01', $7::jsonb)`,
        [op.id, `SUM1-${op.id}`, op.type, op.branchId, 'SUM-1 parity fixture', op.dateAD, JSON.stringify(op.items)]
      );
    }
  });

  after(async () => {
    if (pool && dbReachable) {
      await cleanup().catch(() => undefined);
      await pool.end();
    }
  });

  test('the SQL aggregate equals the pure rule on the parity matrix', { skip: skipNoDb }, async () => {
    const { sql, params } = buildTradingTotalsQuery({
      startDateAD: START,
      endDateAD: END,
      branchId: BRANCH,
    });
    const result = await pool!.query(sql, params);
    assert.equal(result.rows.length, 1, 'the aggregate must return exactly one row');

    const rows = await pool!.query(
      `SELECT type, items FROM stock_operations
        WHERE branch_id = $1 AND date_ad >= $2 AND date_ad <= $3`,
      [BRANCH, START, END]
    );
    const expected = computeTradingFromOps(rows.rows, [{ id: PRODUCT, costPrice: 20 }]);
    const actual = result.rows[0];

    const close = (a: number, b: number, label: string) =>
      assert.ok(
        Math.abs(a - b) < 1e-9,
        `${label}: SQL ${a} must equal the pure rule ${b}`
      );
    close(Number(actual.total_revenue), expected.totalSalesRevenue, 'revenue');
    close(Number(actual.total_cogs), expected.totalCostOfGoodsSold, 'COGS');

    // The whole point: the slice no longer ships the line documents.
    assert.deepEqual(Object.keys(actual).sort(), ['total_cogs', 'total_revenue']);
  });

  test('the aggregate is scoped to one branch and one date range', { skip: skipNoDb }, async () => {
    const { sql, params } = buildTradingTotalsQuery({
      startDateAD: START,
      endDateAD: END,
      branchId: OTHER_BRANCH,
    });
    const result = await pool!.query(sql, params);
    assert.equal(Number(result.rows[0].total_revenue), 1000, 'only the other branch row');
    assert.equal(Number(result.rows[0].total_cogs), 20, 'the other branch product cost');
  });
});
