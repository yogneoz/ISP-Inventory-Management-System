/**
 * Sales-invoice stock deduction — the H5 claim, executed instead of asserted.
 *
 * The audit finding: `post_salesInvoices` ran `SI_DEDUCT_STOCK_SQL` once per
 * line inside the invoice transaction, so an n-line invoice cost n sequential
 * round trips (each holding its stock row lock a little longer). The fix sums
 * the wanted quantity per product and deducts the whole invoice with one
 * `SI_DEDUCT_STOCK_BATCH_SQL` statement.
 *
 * Two things are pinned here, against the real development PostgreSQL:
 *
 *   1. STRUCTURE — a single invoice with N lines issues exactly ONE statement
 *      that updates `inventory_stock`, whatever N is. This is the mechanism, and
 *      it is deterministic: restoring the per-line loop makes this test red
 *      (measured: N statements). Every product's balance still moves by its own
 *      sold quantity, so "one statement" is not "some lines skipped".
 *   2. COST — the same deduction run both ways on this database, in a
 *      transaction that is rolled back, alternating the order and repeating:
 *      1 statement vs N. The medians are printed, not asserted (a wall-clock
 *      assertion on a shared workstation is a flake generator); the audit entry
 *      quotes this run's numbers and the conditions they were taken under.
 *
 * It runs against the shared development database because that is the database
 * the claim is about, and cleans up after itself: its branch, products, stock,
 * invoice, journals, movement rows and audit rows are all `sdb-`-prefixed and
 * removed in `after`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { ensureReferenceData } from './fixtures/referenceData';
import { purgeAuditLogs } from './support/purgeAuditLogs';
import { SI_DEDUCT_STOCK_BATCH_SQL, SI_DEDUCT_STOCK_SQL } from '../server/src/models/sales.repo';

dotenv.config();

const BR = 'sdb-branch';
const CUSTOMER = 'sdb-customer';
const LINE_COUNT = 40;
const OPENING_QTY = 1000;
const REPETITIONS = 9;
const productId = (index: number) => 'sdb-prod-' + String(index).padStart(2, '0');
const PRODUCT_IDS = Array.from({ length: LINE_COUNT }, (_unused, index) => productId(index));

const today = new Date().toISOString().split('T')[0];

const ADMIN = {
  id: 'sdb-admin',
  email: 'sdb-admin@example.com',
  name: 'SDB Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

/**
 * Counts every statement that updates `inventory_stock`, whoever issues it:
 * the per-line `SI_DEDUCT_STOCK_SQL` and the batched CTE both match. Patching
 * the driver's prototype is the only way to observe what the controller really
 * sends without adding a hook to production code.
 */
let stockStatements = 0;
const originalQuery = pg.Client.prototype.query;
(pg.Client.prototype as any).query = function countedQuery(this: any, ...args: any[]) {
  const first = args[0];
  const sql =
    typeof first === 'string' ? first : first && typeof first.text === 'string' ? first.text : '';
  if (/UPDATE\s+inventory_stock\b/i.test(sql)) stockStatements += 1;
  return (originalQuery as any).apply(this, args);
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

describe('sales-invoice stock deduction (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);

  async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }
  const post = (path: string, body: unknown) => request('POST', path, body);

  async function cleanup() {
    // Journals first: their branch foreign key blocks deleting the branch.
    await pool!.query("DELETE FROM gl_journals WHERE source_id LIKE 'sdb-%'");
    await pool!.query("DELETE FROM sales_invoices WHERE id LIKE 'sdb-%'");
    await pool!.query("DELETE FROM customer_records WHERE id LIKE 'sdb-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id LIKE 'sdb-%'");
    await pool!.query("DELETE FROM transaction_logs WHERE product_id LIKE 'sdb-%'");
    await purgeAuditLogs(pool!, "DELETE FROM audit_logs WHERE details LIKE '%SDB-%'");
    await pool!.query('DELETE FROM document_number_retirements WHERE branch_id = $1', [BR]);
    await pool!.query("DELETE FROM products WHERE id LIKE 'sdb-%'");
    await pool!.query('DELETE FROM branches WHERE id = $1', [BR]);
  }

  function balances(): Promise<Map<string, number>> {
    return pool!
      .query(
        `SELECT product_id, quantity_on_hand FROM inventory_stock
          WHERE product_id = ANY($1::text[]) ORDER BY product_id`,
        [PRODUCT_IDS]
      )
      .then((result) => new Map(result.rows.map((row: any) => [String(row.product_id), Number(row.quantity_on_hand)])));
  }

  before(async () => {
    await ensureReferenceData(pool!, today);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'SDB', 'SDB Batch Branch', 'Test')`,
      [BR]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ($1, $1, 'SDB Customer', '9800000000', $2, 'ACTIVE')`,
      [CUSTOMER, BR]
    );
    for (const [index, id] of PRODUCT_IDS.entries()) {
      const suffix = String(index).padStart(2, '0');
      await pool!.query(
        `INSERT INTO products
          (id, name, sku, category, product_group, unit, cost_price, selling_price,
           requires_serial_tracking, tracking_type)
         VALUES ($1, $2, $3, 'Equipment', 'Product Item', 'Pcs', 90, 150, FALSE, 'QUANTITY_ONLY')`,
        [id, 'SDB Product ' + suffix, 'SDB-SKU-' + suffix]
      );
      await pool!.query(
        `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
         VALUES ($1, $2, $3, $4, 10, 1)`,
        ['stk-' + id, id, BR, OPENING_QTY]
      );
    }

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () =>
      new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      });
  });

  after(async () => {
    (pg.Client.prototype as any).query = originalQuery;
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('one invoice deducts every product in exactly one stock statement', async () => {
    stockStatements = 0;
    const created = await post('/api/sales-invoices', {
      id: 'sdb-si-batch',
      invoiceNumber: 'INV-2083-SDB-BATCH',
      branchId: BR,
      invoiceDateAD: today,
      customerId: CUSTOMER,
      customerName: 'SDB Customer',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: PRODUCT_IDS.map((id, index) => {
        const suffix = String(index).padStart(2, '0');
        return {
          productId: id,
          productName: 'SDB Product ' + suffix,
          sku: 'SDB-SKU-' + suffix,
          unit: 'Pcs',
          quantity: 1,
          unitPrice: 100,
          discount: 0,
          taxRate: 13,
          isTaxExempt: false,
        };
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(
      stockStatements,
      1,
      'a ' + LINE_COUNT + '-line invoice must deduct stock in ONE statement, not ' + LINE_COUNT
    );

    const after = await balances();
    assert.equal(after.size, LINE_COUNT, 'every product on the invoice must have a stock row');
    for (const [id, quantity] of after) {
      assert.equal(quantity, OPENING_QTY - 1, 'product ' + id + ' must have moved by its own sold quantity');
    }
  });

  test('the batched statement one round trip costs, measured against the per-line loop', async () => {
    const before = await balances();
    const client = await pool!.connect();
    const samples: { batch: number[]; perLine: number[] } = { batch: [], perLine: [] };
    try {
      for (let rep = 0; rep < REPETITIONS; rep += 1) {
        const order: Array<'batch' | 'perLine'> = rep % 2 === 0 ? ['batch', 'perLine'] : ['perLine', 'batch'];
        for (const mode of order) {
          await client.query('BEGIN');
          await client.query("SET LOCAL statement_timeout = '20000ms'");
          const statementsBefore = stockStatements;
          const started = performance.now();
          if (mode === 'batch') {
            const result = await client.query(SI_DEDUCT_STOCK_BATCH_SQL, [
              PRODUCT_IDS,
              PRODUCT_IDS.map(() => 1),
              BR,
            ]);
            assert.equal(result.rowCount, LINE_COUNT, 'the batched deduction must match every product');
          } else {
            for (const id of PRODUCT_IDS) {
              const result = await client.query(SI_DEDUCT_STOCK_SQL, [1, id, BR]);
              assert.equal(result.rowCount, 1, 'the per-line deduction must match its own product');
            }
          }
          const ms = performance.now() - started;
          const statements = stockStatements - statementsBefore;
          await client.query('ROLLBACK');
          assert.equal(
            statements,
            mode === 'batch' ? 1 : LINE_COUNT,
            mode + ' must issue ' + (mode === 'batch' ? 1 : LINE_COUNT) + ' stock statement(s)'
          );
          samples[mode].push(ms);
        }
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Both variants ran inside rolled-back transactions, so the fixture is untouched.
    assert.deepEqual(await balances(), before, 'the measurement must leave every balance where it found it');

    const batchMs = median(samples.batch);
    const perLineMs = median(samples.perLine);
    console.log(
      'H5 measurement (' +
        LINE_COUNT +
        ' lines, ' +
        REPETITIONS +
        ' alternating repetitions, medians): batch ' +
        batchMs.toFixed(2) +
        ' ms / 1 statement, per-line ' +
        perLineMs.toFixed(2) +
        ' ms / ' +
        LINE_COUNT +
        ' statements, saved ' +
        (perLineMs - batchMs).toFixed(2) +
        ' ms per invoice'
    );
  });
});
