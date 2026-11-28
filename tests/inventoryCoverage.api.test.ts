import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * ACC-4 — inventory is part of Finance.
 *
 * This suite drives real purchase, sale and stock-correction routes against
 * PostgreSQL and then reads the reconciliation report through HTTP:
 *
 *   1. a purchase bill and a sale each move both the stock register and the
 *      INVENTORY control, and the branch report ties exactly;
 *   2. the sale's COGS ties to the movement rows that recorded its issue cost;
 *   3. a direct stock correction ties inventory and stock expense;
 *   4. a repeated (source_type, source_id) posting is refused instead of
 *      double-posting the same stock event;
 *   5. the close guard refuses a non-zero inventory difference unless an
 *      explicit override reason is recorded;
 *   6. every inventory source type used by a posting service is declared in
 *      the registry, and every declared source names its reversal path.
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
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { ensureBsDayRecords, ensureReferenceData } from './fixtures/referenceData';
import { businessDateAD } from '../shared/businessDate';
import {
  INVENTORY_SOURCE_REGISTRY,
  inventorySourceTypes,
} from '../server/src/services/inventoryPostingRegistry';

dotenv.config();

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

const BR = 'iv-branch';
const OTHER_BRANCH = 'iv-other';
const PRODUCT = 'iv-prod';
const UNBACKED = 'iv-unbacked';
const CUSTOMER = 'iv-customer';
// The business day is Kathmandu's calendar day: that is what the posting
// services stamp and what the reconciliation report reads back. Formatting the
// machine clock instead names yesterday between 00:00 and 05:45 Nepal time, and
// names today at 23:xx UTC while the ledger rows already sit on tomorrow.
const TODAY = businessDateAD();
const CLOSE_PERIOD = '2027-06';

const ADMIN = {
  id: 'iv-admin',
  email: 'iv-admin@example.com',
  name: 'IV Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('inventory-to-finance coverage (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);

  async function request(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is itself a finding */ }
    return { status: res.status, json };
  }

  const get = (url: string) => request('GET', url);
  const post = (url: string, body: unknown) => request('POST', url, body);
  const patch = (url: string, body: unknown) => request('PATCH', url, body);

  async function cleanup() {
    const client = await pool!.connect();
    try {
      // Posted ledgers are append-only. Test cleanup is the documented local
      // bypass; keeping it on this connection also lets a failed assertion
      // clean up after itself on the next run.
      await client.query("SELECT set_config('inventory.allow_ledger_purge', 'on', false)");
      await client.query("DELETE FROM gl_journals WHERE branch_id IN ($1, $2) OR source_id LIKE 'iv-%'", [BR, OTHER_BRANCH]);
      await client.query("DELETE FROM sales_invoices WHERE id LIKE 'iv-%'");
      await client.query("DELETE FROM purchase_invoices WHERE id LIKE 'iv-%'");
      await client.query("DELETE FROM customer_records WHERE id LIKE 'iv-%'");
      await client.query("DELETE FROM inventory_stock WHERE product_id LIKE 'iv-%'");
      await client.query("DELETE FROM transaction_logs WHERE product_id LIKE 'iv-%'");
      await purgeAuditLogs(client, "DELETE FROM audit_logs WHERE details LIKE '%IV-%'");
      await client.query("DELETE FROM products WHERE id LIKE 'iv-%'");
      await client.query('DELETE FROM branches WHERE id IN ($1, $2)', [BR, OTHER_BRANCH]);
    } finally {
      client.release();
    }
  }

  function invoiceLine(overrides: Record<string, any> = {}) {
    return {
      productId: PRODUCT,
      productName: 'IV Router',
      sku: 'IV-SKU',
      unit: 'Pcs',
      quantity: 1,
      unitPrice: 100,
      discount: 0,
      taxRate: 13,
      isTaxExempt: false,
      ...overrides,
    };
  }

  async function report(branchId = BR) {
    const res = await get(
      `/api/accounting/inventory-reconciliation?branchId=${encodeURIComponent(branchId)}&asOf=${TODAY}&from=${TODAY.slice(0, 7)}-01&to=${TODAY}`
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  }

  before(async () => {
    await ensureReferenceData(pool!, TODAY);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
        ($1, 'IVB', 'IV Ledger Branch', 'Test'),
        ($2, 'IVO', 'IV Other Branch', 'Test')`,
      [BR, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ($1, $1, 'IV Customer', '9800000001', $2, 'ACTIVE')`,
      [CUSTOMER, BR]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, 'IV Router', 'IV-SKU', 'Equipment', 'Product Item', 'Pcs', 90, 150, FALSE, 'QUANTITY_ONLY')`,
      [PRODUCT]
    );
    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);

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
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('purchase and sale keep the branch valuation equal to the INVENTORY control', async () => {
    const purchase = await post('/api/purchase-invoices', {
      id: 'iv-pi-1',
      invoiceNumber: 'PI-2083-IV-PI-1',
      branchId: BR,
      invoiceDateAD: TODAY,
      supplierName: 'IV Supplier',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      items: [invoiceLine({ quantity: 10, unitPrice: 100 })],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.json));

    let view = await report();
    assert.equal(view.totals.valuation, 1000, '10 units at the bill cost');
    assert.equal(view.totals.control, 1000, 'the bill debited INVENTORY at the same value');
    assert.equal(view.totals.difference, 0);
    assert.equal(view.totals.reconciled, true);
    assert.equal(view.branches.length, 1);
    assert.equal(view.branches[0].branchId, BR);
    assert.equal(view.branches[0].reconciled, true);
    assert.equal(view.products[0].quantity, 10);
    assert.equal(view.products[0].averageCost, 100);

    const sale = await post('/api/sales-invoices', {
      id: 'iv-si-1',
      invoiceNumber: 'INV-2083-IV-SI-1',
      customerId: CUSTOMER,
      customerName: 'IV Customer',
      branchId: BR,
      invoiceDateAD: TODAY,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [invoiceLine({ quantity: 2, unitPrice: 150 })],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.json));

    view = await report();
    assert.equal(view.totals.valuation, 800, 'two units issued at the moving average');
    assert.equal(view.totals.control, 800);
    assert.equal(view.totals.difference, 0);
    assert.equal(view.cogs.posted, 200, 'COGS is 2 × 100');
    assert.equal(view.cogs.sourceAmount, 200, 'the sale movement rows recorded the same issue cost');
    assert.equal(view.cogs.reconciled, true);
    assert.equal(view.stockExpense.posted, 0);

    const movement = await pool!.query(
      `SELECT -quantity_changed * unit_cost AS cost
         FROM transaction_logs
        WHERE product_id = $1 AND branch_id = $2 AND change_type = 'SALES_INVOICE'`,
      [PRODUCT, BR]
    );
    assert.equal(Number(movement.rows[0].cost), 200);
  });

  test('a stock correction ties inventory and stock expense, and a replayed source is refused', async () => {
    const stock = await pool!.query(
      `SELECT id FROM inventory_stock WHERE product_id = $1 AND branch_id = $2`,
      [PRODUCT, BR]
    );
    assert.ok(stock.rows[0]?.id, 'the purchase must have created the stock row');
    const adjusted = await patch(`/api/stock/${encodeURIComponent(stock.rows[0].id)}`, {
      quantityOnHand: 7,
      reason: 'IV coverage correction',
    });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.json));

    let view = await report();
    assert.equal(view.totals.valuation, 700, 'one more unit issued at the moving average');
    assert.equal(view.totals.control, 700);
    assert.equal(view.totals.difference, 0);
    assert.equal(view.stockExpense.posted, 100);
    assert.equal(view.stockExpense.sourceAmount, 100);
    assert.equal(view.stockExpense.reconciled, true);

    const accounts = await pool!.query(
      `SELECT a.id, a.posting_role AS role
         FROM gl_accounts a
        WHERE a.is_active = TRUE AND a.posting_role IN ('INVENTORY', 'RETAINED_EARNINGS')`
    );
    const inventory = accounts.rows.find((row: any) => row.role === 'INVENTORY');
    const equity = accounts.rows.find((row: any) => row.role === 'RETAINED_EARNINGS');
    assert.ok(inventory && equity);
    const body = {
      journalDateAD: TODAY,
      branchId: BR,
      memo: 'IV idempotency probe',
      sourceType: 'STOCK_ADJUSTMENT',
      sourceId: 'iv-idem-1',
      lines: [
        { accountId: inventory.id, debit: 10, credit: 0 },
        { accountId: equity.id, debit: 0, credit: 10 },
      ],
    };
    const first = await post('/api/accounting/journals', body);
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const replay = await post('/api/accounting/journals', body);
    assert.equal(replay.status, 409, JSON.stringify(replay.json));
    assert.match(replay.json.message, /already has posted journal/i);

    view = await report();
    assert.equal(view.totals.valuation, 700, 'the probe is a ledger-only journal; it does not move stock');
    assert.equal(view.totals.control, 710, 'the first probe posted once');
    assert.equal(view.totals.difference, -10, 'the replay did not post a second 10-unit journal');
  });

  test('the close guard refuses a non-zero inventory difference unless overridden', async () => {
    // An unbacked stock row makes the company-wide close tie fail for a reason
    // this suite owns, rather than depending on unrelated fixture data.
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, 'IV Unbacked', 'IV-UNBACKED', 'Equipment', 'Product Item', 'Pcs', 20, 30, FALSE, 'QUANTITY_ONLY')`,
      [UNBACKED]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ('iv-unbacked-stock', $1, $2, 5, 20, 1)`,
      [UNBACKED, BR]
    );

    const periods = await get('/api/accounting/periods');
    assert.equal(periods.status, 200, JSON.stringify(periods.json));
    let period = periods.json.find((entry: any) => entry.periodKey === CLOSE_PERIOD);
    if (!period) {
      // A schema-only CI database has only the periods the suite creates.
      // Seed the two BS bounds this period needs, then create it through the
      // same route an operator would use.
      await ensureBsDayRecords(pool!, [`${CLOSE_PERIOD}-01`, `${CLOSE_PERIOD}-30`]);
      const created = await post('/api/accounting/periods', { periodKey: CLOSE_PERIOD });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      period = created.json;
    }
    assert.ok(period, `the fixture must provide period ${CLOSE_PERIOD}`);
    if (period.status === 'CLOSED') {
      const reset = await post(`/api/accounting/periods/${period.id}/reopen`, {});
      assert.equal(reset.status, 200, JSON.stringify(reset.json));
    }
    const checklist = await get(`/api/accounting/periods/${period.id}/checklist`);
    assert.equal(checklist.status, 200, JSON.stringify(checklist.json));
    for (const task of checklist.json.tasks.filter((entry: any) => entry.required)) {
      const done = await patch(`/api/accounting/periods/${period.id}/checklist/${task.id}`, {
        status: 'DONE',
        note: 'IV close readiness',
      });
      assert.equal(done.status, 200, JSON.stringify(done.json));
    }

    const refused = await post(`/api/accounting/periods/${period.id}/close`, {});
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.match(refused.json.message, /inventory valuation does not equal/i);

    const overridden = await post(`/api/accounting/periods/${period.id}/close`, {
      overrideReason: 'IV test accepts an explained inventory difference',
    });
    assert.equal(overridden.status, 200, JSON.stringify(overridden.json));
    assert.equal(overridden.json.status, 'CLOSED');
    assert.equal(overridden.json.overridden, true);
    assert.equal(overridden.json.inventoryOverridden, true);
    assert.notEqual(overridden.json.inventoryDifference, 0);

    const reopened = await post(`/api/accounting/periods/${period.id}/reopen`, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    assert.equal(reopened.json.status, 'OPEN');
  });

  test('every inventory posting source is registered with a reversal path', () => {
    const serviceFiles = [
      'invoicePosting.service.ts',
      'returnPosting.service.ts',
      'stockPosting.service.ts',
      'stockLevelAdjustment.service.ts',
      'transferPosting.service.ts',
      'cpePosting.service.ts',
      'warrantyClaim.service.ts',
      'damage.service.ts',
      '../controllers/inventory.controller.ts',
    ];
    const found = new Set<string>();
    for (const file of serviceFiles) {
      const source = fs.readFileSync(path.join('server/src/services', file), 'utf8');
      for (const match of source.matchAll(/sourceType:\s*'([A-Z_]+)'/g)) {
        if (match[1].endsWith('_REVERSAL') || match[1].endsWith('_CANCELLED')) continue;
        if (!/^(STOCK_|CPE_|TRANSFER_|DAMAGE|PURCHASE_|SALES_)/.test(match[1])) continue;
        found.add(match[1]);
      }
    }
    const registered = new Set(inventorySourceTypes());
    for (const definition of INVENTORY_SOURCE_REGISTRY) {
      if (definition.reversalSourceType) registered.add(definition.reversalSourceType);
    }
    const missing = [...found].filter((sourceType) => !registered.has(sourceType));
    assert.deepEqual(missing, [], `inventory source types without a declared financial effect: ${missing.join(', ')}`);

    for (const definition of INVENTORY_SOURCE_REGISTRY) {
      assert.ok(definition.postingService, `${definition.sourceType} must name its posting service`);
      assert.ok(
        definition.reversalMode === 'DOCUMENT' ||
          definition.reversalMode === 'LIFECYCLE' ||
          definition.reversalSourceType,
        `${definition.sourceType} must declare how it is reversed`
      );
      assert.notEqual(definition.financialEffect.trim(), '', `${definition.sourceType} must declare its financial effect`);
    }
  });
});
