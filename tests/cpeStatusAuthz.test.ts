/**
 * CPE status PATCH authorization — HTTP-layer integration tests on a real
 * Express app wired exactly as production (createApp + registerAllRoutes)
 * against real PostgreSQL. Fixtures use a "csa-" prefix (unique per file:
 * node --test runs files in parallel, so a shared prefix would let another
 * file's DELETE wipe these rows). Skips without a reachable PostgreSQL.
 *
 * WHY THIS FILE EXISTS (CPE-1):
 * PATCH /api/customer-devices/:id/status had no route gate. The global
 * operation middleware has no customer-devices rule, so any authenticated role
 * that could reach the branch could flip a device to REFUND/IN_STOCK and rewrite
 * its serial_log row without the approval/restock workflow. The route is now
 * restricted to the CPE manager audience, with the existing branch middleware
 * still rejecting a foreign-branch record BEFORE the handler runs.
 *
 * WHAT IS PINNED:
 *   1. no token -> 401;
 *   2. authenticated FRONT_DESK (holds customers-manage, but must use approval)
 *      -> 403 with neither row changed;
 *   3. allowed BRANCH_MANAGER + another branch's record -> 403, unchanged;
 *   4. allowed INVENTORY_MANAGER -> 200, customer-device and serial_log rows
 *      both move (REFUND/IN_STOCK, customer attribution cleared), and CPE-3's
 *      linked fixed asset returns to ACTIVE with exactly one stock credit.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  createApp,
  registerAllRoutes,
  customerDeviceRecords,
  setCustomerDeviceRecords,
  products,
  setProducts,
} from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';

dotenv.config();

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

const BRANCH_A = 'csa-a';
const BRANCH_B = 'csa-b';
const CDR_A = 'csa-cdr-a';
const CDR_B = 'csa-cdr-b';
const SERIAL_A = 'CSA-SN-A';
const SERIAL_B = 'CSA-SN-B';
const PRODUCT_A = 'csa-prod';
const ASSET_A = 'csa-asset-a';
const TAG_A = 'CSA-TAG-A';

const user = (id: string, role: string, branchId: string) => ({
  id,
  email: `${id}@example.com`,
  name: id,
  role,
  branchId,
  allowedBranchIds: [branchId],
  canSwitchUser: false,
}) as any;

const INV_USER = user('csa-inv', 'INVENTORY_MANAGER', BRANCH_A);
const BM_USER = user('csa-bm', 'BRANCH_MANAGER', BRANCH_A);
const FD_USER = user('csa-fd', 'FRONT_DESK', BRANCH_A);

describe('CPE status PATCH authorization', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let origCdr: any[] = [];
  let origProducts: any[] = [];
  const invToken = issueAuthToken(INV_USER);
  const bmToken = issueAuthToken(BM_USER);
  const fdToken = issueAuthToken(FD_USER);

  before(async () => {
    origCdr = [...customerDeviceRecords];
    origProducts = [...products];
    if (!dbReachable) return;

    await pool!.query("DELETE FROM transaction_logs WHERE id LIKE 'csa-%' OR reference_doc_id LIKE 'CSA-%'");
    await pool!.query("DELETE FROM fixed_assets WHERE id LIKE 'csa-%' OR tag_number LIKE 'CSA-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE id LIKE 'csa-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'csa-%'");
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'CSA-%'");
    await pool!.query("DELETE FROM customer_device_records WHERE id LIKE 'csa-%' OR device_serial LIKE 'CSA-%'");
    await pool!.query("DELETE FROM branches WHERE id IN ('csa-a', 'csa-b')");

    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES " +
      "('csa-a', 'CSAA', 'CPE Auth A', 'T'), " +
      "('csa-b', 'CSAB', 'CPE Auth B', 'T')"
    );
    await pool!.query(
      `INSERT INTO customer_device_records
         (id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, status, notes)
       VALUES
         ('${CDR_A}', 'CPE Customer A', 'CSA-A', '${BRANCH_A}', 'CPE Router', '${SERIAL_A}', 'CSA-PON-A', 'RENTAL', 'cpe auth fixture'),
         ('${CDR_B}', 'CPE Customer B', 'CSA-B', '${BRANCH_B}', 'CPE Router', '${SERIAL_B}', 'CSA-PON-B', 'RENTAL', 'cpe auth fixture')`
    );
    await pool!.query(
      `INSERT INTO serial_log
         (id, device_serial, pon_serial, product_name, branch_id, customer_id, customer_name, status, source_type)
       VALUES
         ('csa-sl-a', '${SERIAL_A}', 'CSA-PON-A', 'CPE Router', '${BRANCH_A}', '${CDR_A}', 'CPE Customer A', 'CUSTOMER_ASSIGNED', 'CUSTOMER_DEVICE'),
         ('csa-sl-b', '${SERIAL_B}', 'CSA-PON-B', 'CPE Router', '${BRANCH_B}', '${CDR_B}', 'CPE Customer B', 'CUSTOMER_ASSIGNED', 'CUSTOMER_DEVICE')`
    );

    // CPE-3: the linked asset and the deployment's stock-out proof. The
    // product is pushed into the live catalogue so the controller resolves it
    // exactly as it would for a real product; the credit is keyed on the asset.
    await pool!.query(
      `INSERT INTO products (id, sku, name, category, product_group, unit, cost_price, selling_price)
       VALUES ('${PRODUCT_A}', 'CSA-SKU-A', 'CPE Router', 'CPE', 'Fixed Asset', 'Pcs', 100, 150)`
    );
    setProducts([
      ...products,
      {
        id: PRODUCT_A,
        sku: 'CSA-SKU-A',
        name: 'CPE Router',
        category: 'CPE',
        productGroup: 'Fixed Asset',
        unit: 'Pcs',
        costPrice: 100,
        sellingPrice: 150,
      } as any,
    ]);
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand)
       VALUES ('csa-stk-a', '${PRODUCT_A}', '${BRANCH_A}', 0)`
    );
    await pool!.query(
      `INSERT INTO transaction_logs
         (id, transaction_number, product_id, product_name, branch_id, change_type,
          quantity_before, quantity_changed, quantity_after, reference_doc_id, timestamp_bs)
       VALUES ('csa-deploy-a', 'CSA-DEPLOY-A', '${PRODUCT_A}', 'CPE Router', '${BRANCH_A}',
               'STOCK_OUT', 1, -1, 0, '${TAG_A}', '2082-07-09 BS')`
    );
    await pool!.query(
      `INSERT INTO fixed_assets
         (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs,
          acquisition_cost, net_book_value, status, product_id, assigned_type,
          assigned_customer_id, assigned_customer_name, assignment_date_ad, assignment_date_bs,
          assignment_notes, device_serial)
       VALUES ('${ASSET_A}', '${TAG_A}', 'CPE Router', 'IT Equipment', '${BRANCH_A}',
               '2026-01-01', '2082-09-17', 100, 100, 'ASSIGNED_TO_CUSTOMER', '${PRODUCT_A}',
               'CUSTOMER', '${CDR_A}', 'CPE Customer A', '2026-01-01', '2082-09-17',
               'cpe auth fixture', '${SERIAL_A}')`
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
    setCustomerDeviceRecords(origCdr as any);
    setProducts(origProducts as any);
    if (pool && dbReachable) {
      await pool.query("DELETE FROM transaction_logs WHERE id LIKE 'csa-%' OR reference_doc_id LIKE 'CSA-%'");
      await pool.query("DELETE FROM fixed_assets WHERE id LIKE 'csa-%' OR tag_number LIKE 'CSA-%'");
      await pool.query("DELETE FROM inventory_stock WHERE id LIKE 'csa-%'");
      await pool.query("DELETE FROM products WHERE id LIKE 'csa-%'");
      await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'CSA-%'");
      await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'csa-%' OR device_serial LIKE 'CSA-%'");
      await pool.query("DELETE FROM audit_logs WHERE user_email LIKE 'csa-%'");
      await pool.query("DELETE FROM branches WHERE id IN ('csa-a', 'csa-b')");
      await pool.end();
    }
  });

  async function call(path: string, token?: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  async function cdrStatus(id: string): Promise<string | undefined> {
    const res = await pool!.query('SELECT status FROM customer_device_records WHERE id = $1', [id]);
    return res.rows[0]?.status;
  }

  async function serialState(serial: string): Promise<{ status?: string; customerId?: string | null } | undefined> {
    const res = await pool!.query(
      'SELECT status, customer_id AS "customerId" FROM serial_log WHERE device_serial = $1',
      [serial]
    );
    return res.rows[0];
  }

  test('no bearer token is 401 and changes nothing', { skip: skipNoDb }, async () => {
    const res = await call(`/api/customer-devices/${CDR_A}/status`, undefined, { status: 'REFUND' });
    assert.equal(res.status, 401);
    assert.equal(await cdrStatus(CDR_A), 'RENTAL');
    assert.equal((await serialState(SERIAL_A))?.status, 'CUSTOMER_ASSIGNED');
  });

  test('FRONT_DESK holds customers-manage but cannot bypass the approval workflow', { skip: skipNoDb }, async () => {
    const res = await call(`/api/customer-devices/${CDR_A}/status`, fdToken, { status: 'REFUND' });
    assert.equal(res.status, 403, 'a direct status flip must need the CPE manager audience');
    assert.match(String(res.json?.message || ''), /Forbidden/i);
    assert.equal(await cdrStatus(CDR_A), 'RENTAL', 'the customer device must not move');
    assert.equal((await serialState(SERIAL_A))?.status, 'CUSTOMER_ASSIGNED', 'the serial must not move');
  });

  test('an allowed role still cannot patch another branch record', { skip: skipNoDb }, async () => {
    const res = await call(`/api/customer-devices/${CDR_B}/status`, bmToken, { status: 'REFUND' });
    assert.equal(res.status, 403, 'branch scoping must run before the handler');
    assert.match(String(res.json?.message || ''), /another branch/i);
    assert.equal(await cdrStatus(CDR_B), 'RENTAL', 'the foreign-branch customer device must not move');
    assert.equal((await serialState(SERIAL_B))?.status, 'CUSTOMER_ASSIGNED', 'the foreign-branch serial must not move');
  });

  test('INVENTORY_MANAGER may execute the status change and every surface moves', { skip: skipNoDb }, async () => {
    const res = await call(`/api/customer-devices/${CDR_A}/status`, invToken, { status: 'REFUND' });
    assert.equal(res.status, 200, res.json?.message || 'allowed status patch must succeed');
    assert.equal(res.json?.status, 'REFUND');
    assert.equal(await cdrStatus(CDR_A), 'REFUND', 'the customer device must carry the new status');
    const serial = await serialState(SERIAL_A);
    assert.equal(serial?.status, 'IN_STOCK', 'a refund must free the unit in serial_log');
    assert.equal(serial?.customerId, null, 'IN_STOCK clears the customer attribution');

    // CPE-3/D1: the linked fixed asset and branch stock move in the same
    // transaction, and the credit is keyed on the asset id.
    const asset = await pool!.query(
      'SELECT status, device_serial, assigned_customer_id, assignment_notes FROM fixed_assets WHERE id = $1',
      [ASSET_A]
    );
    assert.equal(asset.rows[0]?.status, 'ACTIVE', 'a collection returns the asset to ACTIVE');
    assert.equal(asset.rows[0]?.device_serial, null, 'the collected serial must leave the asset');
    assert.equal(asset.rows[0]?.assigned_customer_id, null, 'the assignment is cleared');
    assert.match(String(asset.rows[0]?.assignment_notes), /COLLECTED 2026-/);

    const stock = await pool!.query(
      'SELECT quantity_on_hand FROM inventory_stock WHERE id = $1',
      ['csa-stk-a']
    );
    assert.equal(Number(stock.rows[0]?.quantity_on_hand), 1, 'exactly one unit is credited');
    const ledger = await pool!.query(
      "SELECT id FROM transaction_logs WHERE id = 'txn-cpe-collect-csa-asset-a'"
    );
    assert.equal(ledger.rowCount, 1, 'the collection ledger is keyed on the fixed asset id');
  });
});
