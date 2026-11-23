/**
 * External partner integration (`/api/partner/v1/*`) — real HTTP + PostgreSQL.
 *
 * The subscription portal's three calls are the ones this suite drives:
 *
 *   1. customer upsert creates once and re-syncs without duplicating;
 *   2. a subscription period becomes a SERVICE invoice (never a sales invoice),
 *      idempotent on the period, posted to AR when the chart is configured;
 *   3. stock consumption is a guarded decrement that records a CONFLICT instead
 *      of going negative, and a re-sent external id changes nothing;
 *   4. an API key that is not bound to a partner is refused;
 *   5. every ingest leaves an inbox row, accepted or refused.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { createApiKey } from '../server/src/services/apiKeys.service';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    // A waiting checkout must fail loudly rather than stall the suite: with the
    // delivery test running alongside the app's own pool, an exhausted pool used
    // to hang the whole file with no output at all.
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 20000,
    });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH = 'int-test-branch';
const OTHER_BRANCH = 'int-test-branch-2';
const PARTNER = 'int-test-partner';
const CUSTOMER_EXT = 'PORTAL-CUST-1';

describe('partner integration API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let secret = '';
  let unboundSecret = '';
  let adminToken = '';
  let staffToken = '';
  let keyId = '';
  let unboundKeyId = '';
  let stockProduct: string | null = null;

  async function request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    apiKey?: string | null
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(apiKey === null ? {} : { 'x-api-key': apiKey || secret }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* tolerated; a non-JSON body is reported by the assertion */
    }
    return { status: res.status, json };
  }

  /** The governance routes take a human session, never the partner's API key. */
  async function adminRequest(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    token: string | null = adminToken
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: 'Bearer ' + token }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is reported by the assertion that follows */
    }
    return { status: res.status, json };
  }

  async function cleanup() {
    await pool!.query("DELETE FROM integration_delivery_attempts WHERE outbox_id IN (SELECT id FROM integration_outbox WHERE partner_id = $1)", [PARTNER]);
    await pool!.query('DELETE FROM integration_outbox WHERE partner_id = $1', [PARTNER]);
    await pool!.query('DELETE FROM integration_inbox WHERE partner_id = $1', [PARTNER]);
    await pool!.query('DELETE FROM stock_consumption_events WHERE partner_id = $1', [PARTNER]);
    await pool!.query('DELETE FROM service_invoice_lines WHERE invoice_id LIKE \'sinv-%\' AND invoice_id IN (SELECT id FROM service_invoices WHERE partner_id = $1)', [PARTNER]);
    await pool!.query('DELETE FROM service_invoices WHERE partner_id = $1', [PARTNER]);
    await pool!.query('DELETE FROM external_refs WHERE partner_id = $1', [PARTNER]);
    await pool!.query("DELETE FROM customer_records WHERE customer_id LIKE 'PORTAL-CUST%'");
    await pool!.query('DELETE FROM integration_partners WHERE id = $1', [PARTNER]);
    await pool!.query("DELETE FROM idempotency_keys WHERE scope LIKE 'partner.%'");
    // api_key_audit_logs is append-only by trigger (and deliberately has no FK
    // to api_keys), so teardown leaves the audit trail in place.
    await pool!.query("DELETE FROM api_keys WHERE name LIKE 'int-test%'");
    await pool!.query("DELETE FROM inventory_stock WHERE id LIKE 'int-test-stock%'");
    await pool!.query("DELETE FROM products WHERE id = 'int-test-product'");
    // The posted service invoice leaves a journal behind; clear it before the
    // branch it hangs from (gl_journals.branch_id is ON DELETE RESTRICT). Posted
    // ledger rows are immutable, so the fixture purge uses the switch the ledger
    // itself documents for test cleanup rather than editing production rows.
    const purge = await pool!.connect();
    try {
      await purge.query("SELECT set_config('inventory.allow_ledger_purge', 'on', false)");
      await purge.query(
        "DELETE FROM gl_subledger_entries WHERE subledger_id IN (SELECT id FROM gl_subledgers WHERE party_id LIKE 'PORTAL-CUST%')"
      );
      await purge.query("DELETE FROM gl_subledgers WHERE party_id LIKE 'PORTAL-CUST%'");
      // Both fixture branches: the cross-branch subscription test proves a
      // write into the other branch is refused, and the run that reproduced
      // the hole before the fix left a journal there.
      await purge.query(
        'DELETE FROM gl_journal_lines WHERE journal_id IN (SELECT id FROM gl_journals WHERE branch_id IN ($1, $2))',
        [BRANCH, OTHER_BRANCH]
      );
      await purge.query('DELETE FROM gl_journals WHERE branch_id IN ($1, $2)', [BRANCH, OTHER_BRANCH]);
    } finally {
      purge.release();
    }
    await pool!.query("DELETE FROM employees WHERE id = 'int-test-emp-hr'");
    await pool!.query(
      "DELETE FROM integration_outbox WHERE partner_id IN (SELECT id FROM integration_partners WHERE code = 'INTADMIN')"
    );
    await pool!.query("DELETE FROM integration_partners WHERE code = 'INTADMIN'");
    await pool!.query("DELETE FROM branches WHERE id IN ($1, $2)", [BRANCH, OTHER_BRANCH]);
  }

  before(async () => {
    await cleanup();
    // The app's pool wrapper refuses until boot has proven the database is
    // reachable (`isPgConnected`). Every other API suite does the same before it
    // drives a service that writes through pgPool; without it createApiKey
    // throws DbUnavailableError and the first test is cancelled.
    const { ensurePostgresConnection } = await import('../server/db');
    assert.equal(await ensurePostgresConnection(), true, 'the dev database must be reachable');
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'INTT', 'Integration Test Branch', 'Test'),
                                                                 ($2, 'INTT2', 'Integration Other Branch', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    // One employee for the HR push, carrying PAN and bank values on purpose:
    // the allowlist test asserts neither ever reaches the partner payload.
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, department, designation,
                              pan_number, bank_account, bank_name, joining_date_ad)
       VALUES ('int-test-emp-hr', 'INT-EMP-1', 'Integration Test Employee', $1, 'Field Ops',
               'Technician', 'PAN-LEAK', 'BANK-LEAK', 'Leak Bank', '2025-01-01')
       ON CONFLICT (id) DO NOTHING`,
      [BRANCH]
    );

    const issued = await createApiKey(
      {
        name: 'int-test-partner-key',
        operations: ['customers-manage', 'sales-invoice-create', 'stock-out'],
        readOnly: false,
        branchIds: [BRANCH],
        rpmLimit: 6000,
        expiresInDays: 30,
      },
      { id: 'int-test-admin', email: 'int-test-admin@example.com' }
    );
    if ('error' in issued) throw new Error('could not issue the partner key: ' + issued.error);
    secret = issued.secret;
    keyId = issued.key.id;

    const unbound = await createApiKey(
      {
        name: 'int-test-unbound-key',
        operations: ['customers-manage'],
        readOnly: false,
        branchIds: [BRANCH],
        rpmLimit: 6000,
        expiresInDays: 30,
      },
      { id: 'int-test-admin', email: 'int-test-admin@example.com' }
    );
    if ('error' in unbound) throw new Error('could not issue the unbound key: ' + unbound.error);
    unboundSecret = unbound.secret;
    unboundKeyId = unbound.key.id;

    await pool!.query(
      `INSERT INTO integration_partners (id, code, name, api_key_id, allowed_events)
       VALUES ($1, 'INTTEST', 'Integration Test Portal', $2, ARRAY['inventory.stock_changed']::text[])`,
      [PARTNER, keyId]
    );

    const chart = await pool!.query(
      `SELECT posting_role, code FROM gl_accounts
        WHERE is_active AND posting_role IN ('AR_CONTROL', 'SALES', 'TAX_OUTPUT')`
    );
    const roles = new Set(chart.rows.map((row: any) => row.posting_role));
    assert.ok(roles.has('AR_CONTROL') && roles.has('SALES'), 'the chart needs AR_CONTROL and SALES defaults');
    assert.ok(roles.has('TAX_OUTPUT'), 'the chart needs a TAX_OUTPUT default for the taxed subscription');

    // The suite owns the stock fixture: a portal consumption needs a product
    // that exists and a branch quantity to consume.
    const existing = await pool!.query('SELECT id FROM products LIMIT 1');
    if (existing.rows[0]) {
      stockProduct = existing.rows[0].id;
    } else {
      await pool!.query(
        `INSERT INTO products (id, sku, name, category, product_group, unit, cost_price, selling_price)
         VALUES ('int-test-product', 'INT-TEST-SKU', 'Integration Test Router', 'CPE', 'Product Item', 'Pcs', 100, 150)
         ON CONFLICT (id) DO NOTHING`
      );
      stockProduct = 'int-test-product';
    }
    assert.ok(stockProduct, 'the suite must have a product to stock');

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    adminToken = issueAuthToken({
      id: 'int-test-super',
      email: 'int-test-super@example.com',
      name: 'INT Test Super',
      role: 'SUPER_ADMIN',
      branchId: 'ALL',
      allowedBranchIds: ['ALL'],
      canSwitchUser: false,
    } as any);
    staffToken = issueAuthToken({
      id: 'int-test-staff',
      email: 'int-test-staff@example.com',
      name: 'INT Test Staff',
      role: 'CASHIER',
      branchId: BRANCH,
      allowedBranchIds: [BRANCH],
      canSwitchUser: false,
    } as any);
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
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('an unbound API key is refused', async () => {
    const refused = await request(
      'POST',
      '/api/partner/v1/customers',
      { externalId: 'X', name: 'X', contactNumber: '1', branchCode: 'INTT' },
      unboundSecret
    );
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'PARTNER_NOT_REGISTERED');
  });

  test('a key scoped to one branch cannot ingest into another', async () => {
    // The key is bound to BRANCH only. `branchCode` is the field the portal
    // sends, and the app-level branch guard inspects `branchId`, so this is the
    // path that used to slip through.
    const refused = await request('POST', '/api/partner/v1/customers', {
      externalId: 'PORTAL-CUST-CROSS',
      name: 'Cross Branch',
      contactNumber: '9800000000',
      branchCode: 'INTT2',
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'PARTNER_BRANCH_SCOPE');

    const written = await pool!.query('SELECT id FROM customer_records WHERE customer_id = $1', [
      'PORTAL-CUST-CROSS',
    ]);
    assert.equal(written.rowCount, 0, 'a refused cross-branch ingest writes no customer');

    const inbox = await pool!.query(
      "SELECT verdict, error_code FROM integration_inbox WHERE partner_id = $1 AND kind = 'CUSTOMER' ORDER BY received_at DESC LIMIT 1",
      [PARTNER]
    );
    assert.equal(inbox.rows[0].verdict, 'REFUSED', 'the refusal still leaves an inbox row');
    assert.equal(inbox.rows[0].error_code, 'PARTNER_BRANCH_SCOPE');
  });

  test('a subscription cannot inherit a customer branch outside the key scope', async () => {
    // The ERP already files this customer under the OTHER branch and the
    // partner holds a ref for it (linked before this key's scope narrowed) —
    // so nothing in the body names the branch that would receive the invoice.
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ('int-test-cust-other', 'PORTAL-CUST-EXISTING', 'Existing Other Branch Customer',
               '9800000009', $1, 'ACTIVE')`,
      [OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO external_refs (partner_id, entity, external_id, internal_id)
       VALUES ($1, 'CUSTOMER', 'PORTAL-CUST-EXISTING', 'int-test-cust-other')`,
      [PARTNER]
    );

    // No branchId in the body: the service resolves the branch from the linked
    // customer, which is exactly the branch the key is not scoped for.
    const refused = await request('POST', '/api/partner/v1/subscriptions', {
      externalSubscriptionId: 'SUB-CROSS-BRANCH',
      customerExternalId: 'PORTAL-CUST-EXISTING',
      planName: '100 Mbps Home',
      durationDays: 30,
      serviceFromAD: '2026-12-01',
      serviceToAD: '2026-12-30',
      subtotal: 1500,
      taxAmount: 195,
      invoiceDateAD: '2026-12-01',
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'PARTNER_BRANCH_SCOPE');

    const written = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM service_invoices
        WHERE partner_id = $1 AND external_subscription_id = $2`,
      [PARTNER, 'SUB-CROSS-BRANCH']
    );
    assert.equal(written.rows[0].n, 0, 'a customer-derived branch outside the key scope writes no invoice');

    const inbox = await pool!.query(
      `SELECT verdict, error_code FROM integration_inbox
        WHERE partner_id = $1 AND kind = 'SUBSCRIPTION'
        ORDER BY received_at DESC LIMIT 1`,
      [PARTNER]
    );
    assert.equal(inbox.rows[0].verdict, 'REFUSED', 'the refusal still leaves an inbox row');
    assert.equal(inbox.rows[0].error_code, 'PARTNER_BRANCH_SCOPE');
  });

  test('a linked customer filed in another branch is not re-synced by the key', async () => {
    // The partner already holds a ref for this customer (it was linked while the
    // key's scope allowed it, or the scope was narrowed since). The portal
    // re-sends the customer naming its OWN branchCode — in scope — and the
    // service would update the row the ref points at, in the other branch.
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ('int-test-cust-linked', 'PORTAL-CUST-LINKED', 'Linked Other Branch Customer',
               '9800000010', $1, 'ACTIVE')`,
      [OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO external_refs (partner_id, entity, external_id, internal_id)
       VALUES ($1, 'CUSTOMER', 'PORTAL-CUST-LINKED', 'int-test-cust-linked')`,
      [PARTNER]
    );

    const refused = await request('POST', '/api/partner/v1/customers', {
      externalId: 'PORTAL-CUST-LINKED',
      name: 'Linked Other Branch Customer',
      contactNumber: '9800000011',
      branchCode: 'INTT',
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'PARTNER_BRANCH_SCOPE');

    const row = (
      await pool!.query('SELECT contact_number, branch_id FROM customer_records WHERE id = $1', [
        'int-test-cust-linked',
      ])
    ).rows[0];
    assert.equal(row.branch_id, OTHER_BRANCH);
    assert.equal(row.contact_number, '9800000010', 'the out-of-scope customer is untouched');

    const inbox = await pool!.query(
      `SELECT verdict, error_code FROM integration_inbox
        WHERE partner_id = $1 AND kind = 'CUSTOMER'
        ORDER BY received_at DESC LIMIT 1`,
      [PARTNER]
    );
    assert.equal(inbox.rows[0].verdict, 'REFUSED');
    assert.equal(inbox.rows[0].error_code, 'PARTNER_BRANCH_SCOPE');
  });

  test('a stock consumption naming another branch is refused before the decrement', async () => {
    // The other branch HAS stock, so an unchecked ingest would apply rather
    // than answer CONFLICT — the refusal must come from the key scope.
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost)
       VALUES ('int-test-stock-2', $1, $2, 5, 100)`,
      [stockProduct, OTHER_BRANCH]
    );
    const product = (await pool!.query('SELECT sku FROM products WHERE id = $1', [stockProduct])).rows[0];
    const refused = await request('POST', '/api/partner/v1/stock/consumptions', {
      externalId: 'CONS-CROSS-BRANCH',
      sku: product.sku,
      branchCode: 'INTT2',
      quantity: 2,
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'PARTNER_BRANCH_SCOPE');

    const events = await pool!.query(
      'SELECT COUNT(*)::int AS n FROM stock_consumption_events WHERE partner_id = $1 AND external_id = $2',
      [PARTNER, 'CONS-CROSS-BRANCH']
    );
    assert.equal(events.rows[0].n, 0, 'a refused consumption writes no event');
    const stock = await pool!.query('SELECT quantity_on_hand FROM inventory_stock WHERE id = $1', [
      'int-test-stock-2',
    ]);
    assert.equal(Number(stock.rows[0].quantity_on_hand), 5, 'the other branch stock is untouched');

    const inbox = await pool!.query(
      `SELECT verdict, error_code FROM integration_inbox
        WHERE partner_id = $1 AND kind = 'STOCK_CONSUMPTION'
        ORDER BY received_at DESC LIMIT 1`,
      [PARTNER]
    );
    assert.equal(inbox.rows[0].verdict, 'REFUSED');
    assert.equal(inbox.rows[0].error_code, 'PARTNER_BRANCH_SCOPE');
  });

  test('a customer is created once and re-synced without duplicating', async () => {
    const created = await request('POST', '/api/partner/v1/customers', {
      externalId: CUSTOMER_EXT,
      name: 'Portal Customer',
      contactNumber: '9800000001',
      branchCode: 'INTT',
      email: 'portal@example.com',
      idempotencyKey: 'int-test-cust-1',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.created, true);
    assert.equal(created.json.customerCode, CUSTOMER_EXT);

    const replay = await request('POST', '/api/partner/v1/customers', {
      externalId: CUSTOMER_EXT,
      name: 'Portal Customer',
      contactNumber: '9800000001',
      branchCode: 'INTT',
      email: 'portal@example.com',
      idempotencyKey: 'int-test-cust-1',
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);

    const resync = await request('POST', '/api/partner/v1/customers', {
      externalId: CUSTOMER_EXT,
      name: 'Portal Customer RENAMED',
      contactNumber: '9800000002',
      branchCode: 'INTT',
    });
    assert.equal(resync.status, 200, JSON.stringify(resync.json));
    assert.equal(resync.json.created, false);
    assert.equal(resync.json.contactNumber, '9800000002', 'the contact the portal owns is updated');

    const count = await pool!.query(
      "SELECT COUNT(*)::int AS n FROM customer_records WHERE customer_id = $1",
      [CUSTOMER_EXT]
    );
    assert.equal(count.rows[0].n, 1, 'one customer row, not two');
    const name = await pool!.query(
      'SELECT customer_name FROM customer_records WHERE customer_id = $1',
      [CUSTOMER_EXT]
    );
    assert.equal(name.rows[0].customer_name, 'Portal Customer', 'a local name is not overwritten');

    const inbox = await pool!.query(
      'SELECT COUNT(*)::int AS n FROM integration_inbox WHERE partner_id = $1 AND kind = $2',
      [PARTNER, 'CUSTOMER']
    );
    assert.ok(inbox.rows[0].n >= 3, 'every attempt leaves an inbox row');
  });

  test('a subscription becomes a service invoice, never a sales invoice', async () => {
    const body = {
      externalSubscriptionId: 'SUB-1',
      customerExternalId: CUSTOMER_EXT,
      planName: '100 Mbps Home',
      durationDays: 30,
      serviceFromAD: '2026-11-01',
      serviceToAD: '2026-11-30',
      subtotal: 1500,
      taxAmount: 195,
      invoiceDateAD: '2026-11-01',
      idempotencyKey: 'int-test-sub-1',
    };
    const created = await request('POST', '/api/partner/v1/subscriptions', body);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.match(created.json.invoiceNumber, /^SINV-\d{6}$/);
    assert.equal(created.json.total, 1695);
    assert.ok(created.json.journalId, 'the service invoice posts a journal');

    // Same idempotency key: the stored response is replayed, not re-run.
    const again = await request('POST', '/api/partner/v1/subscriptions', body);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.replayed, true, 'the same key replays the stored response');
    assert.equal(again.json.invoiceNumber, created.json.invoiceNumber);

    // No idempotency key at all: the period itself is the natural key, so the
    // second send still returns the invoice that already covers 2026-11-01.
    const { idempotencyKey: _omit, ...periodOnly } = body;
    const periodAgain = await request('POST', '/api/partner/v1/subscriptions', periodOnly);
    assert.equal(periodAgain.status, 200, JSON.stringify(periodAgain.json));
    assert.equal(periodAgain.json.created, false, 'the same period is not billed twice');
    assert.equal(periodAgain.json.invoiceNumber, created.json.invoiceNumber);

    const invoices = await pool!.query(
      'SELECT COUNT(*)::int AS n FROM service_invoices WHERE partner_id = $1',
      [PARTNER]
    );
    assert.equal(invoices.rows[0].n, 1);

    const salesInvoices = await pool!.query(
      "SELECT COUNT(*)::int AS n FROM sales_invoices WHERE invoice_number LIKE 'SINV-%'"
    );
    assert.equal(salesInvoices.rows[0].n, 0, 'no service document is written as a stock sale');
  });

  test('stock consumption applies, replays and refuses to go negative', async () => {
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost)
       VALUES ('int-test-stock-1', $1, $2, 10, 100)`,
      [stockProduct, BRANCH]
    );
    const product = await pool!.query('SELECT sku FROM products WHERE id = $1', [stockProduct]);

    const applied = await request('POST', '/api/partner/v1/stock/consumptions', {
      externalId: 'CONS-1',
      sku: product.rows[0].sku,
      branchCode: 'INTT',
      quantity: 4,
      idempotencyKey: 'int-test-cons-1',
    });
    assert.equal(applied.status, 201, JSON.stringify(applied.json));
    assert.equal(applied.json.status, 'APPLIED');
    assert.equal(applied.json.quantityOnHand, 6);

    const replay = await request('POST', '/api/partner/v1/stock/consumptions', {
      externalId: 'CONS-1',
      sku: product.rows[0].sku,
      branchCode: 'INTT',
      quantity: 4,
      idempotencyKey: 'int-test-cons-1',
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true);

    const stocked = await pool!.query(
      "SELECT quantity_on_hand FROM inventory_stock WHERE id = 'int-test-stock-1'"
    );
    assert.equal(stocked.rows[0].quantity_on_hand, 6, 'only one decrement happened');

    const conflict = await request('POST', '/api/partner/v1/stock/consumptions', {
      externalId: 'CONS-2',
      sku: product.rows[0].sku,
      branchCode: 'INTT',
      quantity: 50,
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.json));
    assert.equal(conflict.json.status, 'CONFLICT');
    assert.match(conflict.json.conflictReason, /only 6 unit/i);

    const after = await pool!.query(
      "SELECT quantity_on_hand FROM inventory_stock WHERE id = 'int-test-stock-1'"
    );
    assert.equal(after.rows[0].quantity_on_hand, 6, 'a refused consumption changes no stock');

    const queued = await pool!.query(
      "SELECT COUNT(*)::int AS n FROM integration_outbox WHERE partner_id = $1",
      [PARTNER]
    );
    assert.ok(queued.rows[0].n >= 2, 'consumption events are queued for the portal');
  });

  test('outbox delivery is signed, backs off after a failure and dead-letters', async () => {
    const crypto = await import('node:crypto');
    const { deliverOutbox } = await import('../server/src/services/integration.service');
    const SECRET = 'int-test-webhook-secret';

    // The consumption step already queued real events, so delivery is driven from
    // those rows instead of fabricating outbox fixtures.
    const queued = await pool!.query(
      `SELECT id FROM integration_outbox
        WHERE partner_id = $1 AND status IN ('PENDING', 'FAILED')
        ORDER BY created_at LIMIT 2`,
      [PARTNER]
    );
    assert.ok(queued.rows.length >= 2, 'the consumption step queues events for the portal');
    const firstRow = queued.rows[0];
    const secondRow = queued.rows[1];

    let failMode = true;
    const received: Array<{ headers: any; raw: string }> = [];
    const sockets = new Set<any>();
    const receiver = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received.push({ headers: req.headers, raw });
        res.statusCode = failMode ? 500 : 200;
        res.end(failMode ? 'try later' : 'ok');
      });
    });
    receiver.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      receiver.once('error', reject);
      receiver.listen(0, '127.0.0.1', resolve);
    });
    const hookPort = (receiver.address() as any).port;

    try {
      await pool!.query(
        'UPDATE integration_partners SET webhook_url = $2, webhook_secret = $3 WHERE id = $1',
        [PARTNER, `http://127.0.0.1:${hookPort}/hook`, SECRET]
      );

      // The endpoint is down: the row records the attempt and backs off.
      await deliverOutbox(10);
      assert.ok(received.length >= 1, 'the portal endpoint was called');

      const signature = String(received[0].headers['x-isp-signature'] || '');
      const expected =
        'sha256=' + crypto.createHmac('sha256', SECRET).update(received[0].raw).digest('hex');
      assert.equal(signature, expected, 'the delivery carries a valid HMAC of the raw body');
      assert.ok(received[0].headers['x-isp-event'], 'the event name travels with the delivery');

      const backedOff = (
        await pool!.query(
          'SELECT status, attempts, next_attempt_at > now() AS later FROM integration_outbox WHERE id = $1',
          [firstRow.id]
        )
      ).rows[0];
      assert.equal(backedOff.status, 'FAILED');
      assert.equal(backedOff.attempts, 1);
      assert.equal(backedOff.later, true, 'a failed delivery backs off instead of looping');

      // The endpoint recovers: the same row is delivered on its next attempt.
      failMode = false;
      await pool!.query(
        'UPDATE integration_outbox SET next_attempt_at = now() WHERE partner_id = $1',
        [PARTNER]
      );
      const second = await deliverOutbox(10);
      assert.ok(second.delivered >= 1, JSON.stringify(second));
      const deliveredRow = (
        await pool!.query('SELECT status, delivered_at FROM integration_outbox WHERE id = $1', [
          firstRow.id,
        ])
      ).rows[0];
      assert.equal(deliveredRow.status, 'DELIVERED');
      assert.ok(deliveredRow.delivered_at, 'delivery is timestamped');
      const attempts = await pool!.query(
        'SELECT COUNT(*)::int AS n FROM integration_delivery_attempts WHERE outbox_id = $1',
        [firstRow.id]
      );
      assert.ok(attempts.rows[0].n >= 2, 'both attempts are recorded');

      // A spent attempt budget is terminal: the row stops retrying.
      await pool!.query(
        "UPDATE integration_outbox SET status = 'FAILED', attempts = 7, next_attempt_at = now() WHERE id = $1",
        [secondRow.id]
      );
      await pool!.query('UPDATE integration_partners SET webhook_url = NULL WHERE id = $1', [PARTNER]);
      await deliverOutbox(10);
      const dead = (
        await pool!.query('SELECT status, attempts FROM integration_outbox WHERE id = $1', [
          secondRow.id,
        ])
      ).rows[0];
      assert.equal(dead.status, 'DEAD', 'a spent budget is terminal');
      assert.equal(dead.attempts, 8);
    } finally {
      // undici keeps its socket alive, and server.close() waits for it: drop the
      // connections first or the test hangs until the runner's timeout.
      // A keep-alive socket can outlive the last response, and close() then never
      // calls back; destroy what the listener still holds and bound the wait.
      for (const socket of sockets) socket.destroy();
      (receiver as any).closeAllConnections?.();
      await Promise.race([
        new Promise<void>((done) => receiver.close(() => done)),
        new Promise<void>((done) => setTimeout(done, 1000)),
      ]);
    }
  });
  /**
   * The admin console's whole surface, driven over HTTP the way the screen
   * drives it: the same `:id` the list returns, the same bodies the form posts.
   * A push addressed by code instead of id used to 404 every partner row.
   */
  test('the admin endpoints list, create, patch, inspect, replay, drain and push', async () => {
    const partnerKeys = [
      'allowed_events',
      'api_key_id',
      'code',
      'contract_version',
      'created_at',
      'dead_events',
      'id',
      'name',
      'pending_events',
      'status',
    ].sort();
    const outboxKeys = [
      'attempts',
      'created_at',
      'delivered_at',
      'entity',
      'entity_id',
      'event',
      'id',
      'last_error',
      'next_attempt_at',
      'partner_code',
      'status',
    ].sort();

    // --- gating: the partner key is not a session, and a cashier is not an admin
    const anonymous = await adminRequest('GET', '/api/admin/integration/partners', undefined, null);
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.json));
    const staff = await adminRequest('GET', '/api/admin/integration/partners', undefined, staffToken);
    assert.equal(staff.status, 403, JSON.stringify(staff.json));

    // --- list: the documented field set, with the queue counters
    const list = await adminRequest('GET', '/api/admin/integration/partners');
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.ok(Array.isArray(list.json));
    const row = list.json.find((candidate: any) => candidate.id === PARTNER);
    assert.ok(row, 'the registered partner is listed');
    assert.deepEqual(Object.keys(row).sort(), partnerKeys, 'the admin read returns exactly the documented fields');
    assert.equal(row.code, 'INTTEST');
    assert.equal(row.contract_version, 'v1');
    assert.ok(
      row.pending_events + row.dead_events >= 1,
      'the queue counters see the events the ingest left behind'
    );
    assert.ok(row.dead_events >= 1, 'the dead-lettered delivery is counted as dead');

    // --- create + patch: the same bodies the screen posts
    const created = await adminRequest('POST', '/api/admin/integration/partners', {
      code: 'INTADMIN',
      name: 'Admin Created Portal',
      apiKeyId: unboundKeyId,
      contractVersion: 'v1',
      allowedEvents: ['hr.employee_changed'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.code, 'INTADMIN');
    assert.ok(created.json.id, 'the create response carries the id PATCH and push use');

    const patched = await adminRequest(
      'PATCH',
      `/api/admin/integration/partners/${encodeURIComponent(created.json.id)}`,
      { name: 'Admin Renamed Portal', status: 'SUSPENDED' }
    );
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.name, 'Admin Renamed Portal');
    assert.equal(patched.json.status, 'SUSPENDED', 'the enable/disable switch is the status field');
    assert.equal(patched.json.webhook_url, null, 'an omitted webhook keeps its stored value');

    const unknownPatch = await adminRequest('PATCH', '/api/admin/integration/partners/partner-missing', {
      name: 'nobody',
    });
    assert.equal(unknownPatch.status, 404, JSON.stringify(unknownPatch.json));

    // --- outbox: filter by status, with attempts and the backoff timestamp
    const deadList = await adminRequest('GET', '/api/admin/integration/outbox?status=DEAD&limit=10');
    assert.equal(deadList.status, 200, JSON.stringify(deadList.json));
    const deadRow = deadList.json.find((candidate: any) => candidate.status === 'DEAD');
    assert.ok(deadRow, 'the dead-lettered row from the delivery test is visible');
    assert.deepEqual(Object.keys(deadRow).sort(), outboxKeys, 'the queue view returns exactly the documented fields');
    assert.equal(deadRow.partner_code, 'INTTEST');
    assert.equal(deadRow.attempts, 8);
    assert.ok(deadRow.next_attempt_at, 'the retry timestamp is part of the row');

    // --- replay: DEAD becomes PENDING, and a replay of a live row is refused
    const replayed = await adminRequest(
      'POST',
      `/api/admin/integration/outbox/${encodeURIComponent(deadRow.id)}/replay`
    );
    assert.equal(replayed.status, 200, JSON.stringify(replayed.json));
    assert.equal(replayed.json.status, 'PENDING');
    const replayAgain = await adminRequest(
      'POST',
      `/api/admin/integration/outbox/${encodeURIComponent(deadRow.id)}/replay`
    );
    assert.equal(replayAgain.status, 409, JSON.stringify(replayAgain.json));
    assert.match(String(replayAgain.json.message), /PENDING/);

    // --- drain: the counters the screen renders
    const drained = await adminRequest('POST', '/api/admin/integration/deliver', { limit: 5 });
    assert.equal(drained.status, 200, JSON.stringify(drained.json));
    assert.equal(typeof drained.json.delivered, 'number');
    assert.equal(typeof drained.json.failed, 'number');
    assert.equal(typeof drained.json.skipped, 'number');
    assert.ok(
      drained.json.failed >= 1,
      'a partner without a webhook records a failed attempt instead of dropping the event'
    );

    // --- pushes addressed by id, once with a cursor round-trip
    const pushedStock = await adminRequest('POST', `/api/admin/integration/partners/${PARTNER}/push/stock`, {
      branchId: BRANCH,
      limit: 5,
    });
    assert.equal(pushedStock.status, 201, JSON.stringify(pushedStock.json));
    assert.equal(pushedStock.json.partner, 'INTTEST');
    assert.ok(pushedStock.json.queued >= 1, 'the branch stock row is queued');
    assert.ok(pushedStock.json.nextCursor, 'the cursor resumes after the last product');

    const pushedStockAgain = await adminRequest(
      'POST',
      `/api/admin/integration/partners/${PARTNER}/push/stock`,
      { branchId: BRANCH, cursor: pushedStock.json.nextCursor, limit: 5 }
    );
    assert.equal(pushedStockAgain.status, 201, JSON.stringify(pushedStockAgain.json));
    assert.equal(pushedStockAgain.json.queued, 0, 'past the last product the push is empty');
    assert.equal(pushedStockAgain.json.nextCursor, null);

    const pushedHr = await adminRequest('POST', `/api/admin/integration/partners/${PARTNER}/push/hr`, {
      branchId: BRANCH,
      limit: 5,
    });
    assert.equal(pushedHr.status, 201, JSON.stringify(pushedHr.json));
    assert.equal(pushedHr.json.partner, 'INTTEST');
    assert.equal(pushedHr.json.queued, 1, 'the branch employee is queued');

    const hrPayload = (
      await pool!.query(
        `SELECT payload FROM integration_outbox
          WHERE partner_id = $1 AND event = 'hr.employee_changed'
          ORDER BY created_at DESC LIMIT 1`,
        [PARTNER]
      )
    ).rows[0].payload;
    assert.equal(hrPayload.name, 'Integration Test Employee');
    for (const forbidden of ['pan', 'panNumber', 'bank', 'bankAccount', 'salary', 'dateOfBirth']) {
      assert.equal(
        Object.keys(hrPayload).some((key) => key.toLowerCase().includes(forbidden.toLowerCase())),
        false,
        `the HR payload must not carry ${forbidden}: ${JSON.stringify(hrPayload)}`
      );
    }
    assert.equal(
      JSON.stringify(hrPayload).includes('PAN-LEAK') || JSON.stringify(hrPayload).includes('BANK-LEAK'),
      false,
      'no PAN or bank value leaves through the partner channel'
    );

    const missingPush = await adminRequest(
      'POST',
      '/api/admin/integration/partners/partner-missing/push/stock',
      { branchId: BRANCH }
    );
    assert.equal(missingPush.status, 404, JSON.stringify(missingPush.json));
  });
});
