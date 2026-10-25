/**
 * Customer Device Serials — normalized MAC conflicts and dead status
 * vocabulary (CPE-2), HTTP layer against real PostgreSQL.
 *
 * BEFORE: CDR_DUPLICATE_CHECK_SQL checked device_serial and pon_serial only.
 * A MAC owned by another row reached uq_customer_device_mac_address and
 * surfaced as a raw 500 from create or exchange. DISCONNECTED / RETURNED were
 * still accepted as new writes even though the live flow only produces
 * ROUTER_COLLECTED / REFUND / IN_STOCK.
 *
 * WHAT IS PINNED:
 *  1. create with the same MAC in a different (separator-less) spelling -> 409
 *     naming the MAC field, no customer-device row, no serial flip, no stock;
 *  2. create with a genuinely new MAC still succeeds and moves stock once;
 *  3. exchange with a conflicting MAC -> 409, old rental untouched, replacement
 *     unit still IN_STOCK, stock unchanged;
 *  4. exchange with a genuinely new MAC still succeeds;
 *  5. PATCH to a legacy DISCONNECTED status is refused (400) and writes nothing.
 *
 * Fixtures use a "cmc-" id prefix / "CMC-" serials, removed in after().
 * Skips without a reachable PostgreSQL (the CI service container provides one).
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
import { ensureBsDayRecords, todayAd } from './fixtures/referenceData';

dotenv.config();

let probePool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    probePool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await probePool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  probePool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH = 'cmc-branch';
const PRODUCT_ID = 'cmc-prod';
const PRODUCT_SKU = 'CMCSKU';
const PRODUCT_NAME = 'CMC Fixture Router';
const OLD_CDR = 'cmc-old';
const MAC_OWNER_CDR = 'cmc-mac-owner';
const STOCK_ID = 'cmc-stock';
const INITIAL_STOCK = 5;
const CONFLICT_MAC = 'A4:C3:F0:B1:D2:E3';

const SUPER_USER = {
  id: 'cmc-super', email: 'cmc-super@example.com', name: 'CMC Test',
  role: 'SUPER_ADMIN', branchId: BRANCH,
  allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;

describe('CPE MAC conflicts and legacy status vocabulary', () => {
  let pool = probePool!;
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);
  let origCdr: any[] = [];
  const origProducts = [...products];

  before(async () => {
    origCdr = [...customerDeviceRecords];
    if (!dbReachable) return;

    await cleanup();
    await ensureBsDayRecords(pool, [todayAd()]);

    await pool.query(
      'INSERT INTO branches (id, code, name, location) VALUES ($1, $2, $3, $4)',
      [BRANCH, 'CMCB', 'CMC Test Branch', 'T']
    );
    await pool.query(
      `INSERT INTO products
         (id, sku, name, category, product_group, unit, cost_price, selling_price,
          requires_serial_tracking, tracking_type)
       VALUES ($1, $2, $3, 'Equipment', 'Product Item', 'Pcs', 100, 150, TRUE, 'SERIAL_ONLY')`,
      [PRODUCT_ID, PRODUCT_SKU, PRODUCT_NAME]
    );
    setProducts([
      ...origProducts,
      {
        id: PRODUCT_ID,
        sku: PRODUCT_SKU,
        name: PRODUCT_NAME,
        costPrice: 100,
        sellingPrice: 150,
        requiresSerialTracking: true,
        trackingType: 'SERIAL_ONLY',
      } as any,
    ] as any);

    await pool.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
       VALUES ($1, $2, $3, $4, 0, 0, 0)`,
      [STOCK_ID, PRODUCT_ID, BRANCH, INITIAL_STOCK]
    );

    await pool.query(
      `INSERT INTO customer_device_records
         (id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, mac_address, status, notes)
       VALUES
         ($1, 'CMC Old Customer', 'CMC-OLD', $2, $5, 'CMC-OLD', 'CMC-PON-OLD', NULL, 'RENTAL', 'cmc fixture'),
         ($3, 'CMC Mac Owner', 'CMC-MAC', $2, $5, 'CMC-MAC-OWNER', 'CMC-PON-MAC', $4, 'RENTAL', 'cmc fixture')`,
      [OLD_CDR, BRANCH, MAC_OWNER_CDR, CONFLICT_MAC, PRODUCT_NAME]
    );

    await pool.query(
      `INSERT INTO serial_log
         (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, status, source_type)
       VALUES
         ('cmc-sl-old',    'CMC-OLD',    'CMC-PON-OLD',    NULL,     $1, $2, $3, 'CUSTOMER_ASSIGNED', 'PURCHASE'),
         ('cmc-sl-assign', 'CMC-ASSIGN', 'CMC-PON-ASSIGN', NULL,     $1, $2, $3, 'IN_STOCK',          'PURCHASE'),
         ('cmc-sl-blank',  'CMC-REPL-BLANK', 'CMC-PON-BLANK', $4,   $1, $2, $3, 'IN_STOCK',          'PURCHASE'),
         ('cmc-sl-repl',   'CMC-REPL',   'CMC-PON-REPL',   '00:11:22:33:44:55', $1, $2, $3, 'IN_STOCK', 'PURCHASE')`,
      [PRODUCT_ID, PRODUCT_NAME, BRANCH, CONFLICT_MAC]
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
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup() {
    await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'CMC-%'");
    await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'cmc-%' OR device_serial LIKE 'CMC-%'");
    await pool.query("DELETE FROM transaction_logs WHERE reference_doc_id LIKE 'CMC%'");
    await pool.query("DELETE FROM customer_records WHERE customer_id LIKE 'CMC%'");
    await pool.query('DELETE FROM inventory_stock WHERE id = $1', [STOCK_ID]);
    await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT_ID]);
    await pool.query("DELETE FROM audit_logs WHERE user_email LIKE 'cmc-%'");
    await pool.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
  }

  async function call(method: 'POST' | 'PATCH', path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  async function stockQoh(): Promise<number> {
    const r = await pool.query('SELECT quantity_on_hand FROM inventory_stock WHERE id = $1', [STOCK_ID]);
    return Number(r.rows[0]?.quantity_on_hand);
  }

  async function serialStatus(serial: string): Promise<string | undefined> {
    const r = await pool.query('SELECT status FROM serial_log WHERE device_serial = $1', [serial]);
    return r.rows[0]?.status;
  }

  const createBody = (over: Record<string, unknown> = {}) => ({
    id: 'cmc-created',
    customerName: 'CMC Created Customer',
    customerCode: 'CMC-CREATED',
    branchId: BRANCH,
    productName: PRODUCT_NAME,
    deviceSerial: 'CMC-ASSIGN',
    ponSerial: 'CMC-PON-ASSIGN',
    macAddress: '00:11:22:33:44:66',
    status: 'RENTAL',
    ...over,
  });

  test('create with a separator-less duplicate MAC is a readable 409 and writes nothing', { skip: skipNoDb }, async () => {
    const res = await call('POST', '/api/customer-devices', createBody({ macAddress: 'a4c3f0b1d2e3' }));
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.match(String(res.json?.message || ''), /MAC address/i, 'the 409 must name the MAC field');
    assert.equal(await serialStatus('CMC-ASSIGN'), 'IN_STOCK', 'refused create must not flip the register');
    assert.equal(await stockQoh(), INITIAL_STOCK, 'refused create must not move stock');
    const row = await pool.query("SELECT 1 FROM customer_device_records WHERE id = 'cmc-created'");
    assert.equal(row.rowCount, 0, 'refused create must not write a customer-device row');
  });

  test('create with a genuinely new MAC still succeeds', { skip: skipNoDb }, async () => {
    const res = await call('POST', '/api/customer-devices', createBody());
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(await serialStatus('CMC-ASSIGN'), 'CUSTOMER_ASSIGNED');
    assert.equal(await stockQoh(), INITIAL_STOCK - 1, 'one assignment consumes exactly one unit');
    const row = await pool.query("SELECT mac_address FROM customer_device_records WHERE id = 'cmc-created'");
    assert.equal(row.rows[0]?.mac_address, '00:11:22:33:44:66');
  });

  test('PATCH to a legacy DISCONNECTED status is refused and writes nothing', { skip: skipNoDb }, async () => {
    const res = await call('PATCH', `/api/customer-devices/${OLD_CDR}/status`, { status: 'DISCONNECTED' });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(String(res.json?.message || ''), /legacy read-only/i);
    const row = await pool.query('SELECT status FROM customer_device_records WHERE id = $1', [OLD_CDR]);
    assert.equal(row.rows[0]?.status, 'RENTAL', 'a refused transition must leave the record untouched');
    assert.equal(await serialStatus('CMC-OLD'), 'CUSTOMER_ASSIGNED', 'and must leave its serial untouched');
  });

  test('a legacy status cannot enter the approval queue', { skip: skipNoDb }, async () => {
    const res = await call('POST', '/api/approval-requests', {
      type: 'CUSTOMER_DEVICE_STATUS',
      targetId: OLD_CDR,
      customerName: 'CMC Old Customer',
      deviceSerial: 'CMC-OLD',
      requestedStatus: 'DISCONNECTED',
      requestedByRole: 'FRONT_DESK',
      branchId: BRANCH,
      reason: 'CPE-2 legacy vocabulary test',
    });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(String(res.json?.message || ''), /legacy read-only/i);
    const pending = await pool.query(
      "SELECT 1 FROM approval_requests WHERE target_id = $1 AND status = 'PENDING'",
      [OLD_CDR]
    );
    assert.equal(pending.rowCount, 0, 'a refused submission must not create a request row');
  });

  const exchangeBody = (over: Record<string, unknown> = {}) => ({
    oldDeviceId: OLD_CDR,
    exchangeReason: 'CPE-2 MAC conflict test',
    oldDeviceAction: 'KEEP',
    newProductName: PRODUCT_NAME,
    newDeviceSerial: 'CMC-REPL',
    newPonSerial: 'CMC-PON-REPL',
    newMacAddress: '00:11:22:33:44:55',
    notes: '',
    branchId: BRANCH,
    ...over,
  });

  test('exchange with a duplicate MAC is a readable 409 and leaves both units in place', { skip: skipNoDb }, async () => {
    const res = await call('POST', '/api/customer-devices/exchange', exchangeBody({ newMacAddress: 'a4c3f0b1d2e3' }));
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.match(String(res.json?.message || ''), /MAC address/i);

    const oldRow = await pool.query('SELECT status FROM customer_device_records WHERE id = $1', [OLD_CDR]);
    assert.equal(oldRow.rows[0]?.status, 'RENTAL', 'a refused exchange must leave the old rental open');
    assert.equal(await serialStatus('CMC-REPL'), 'IN_STOCK', 'the replacement must stay in stock');
    assert.equal(await stockQoh(), INITIAL_STOCK - 1, 'a refused exchange must not move stock');
    const replacement = await pool.query("SELECT 1 FROM customer_device_records WHERE device_serial = 'CMC-REPL'");
    assert.equal(replacement.rowCount, 0, 'no replacement row may be written');
  });

  test('exchange with a blank MAC hydrates the register identity before the conflict probe', { skip: skipNoDb }, async () => {
    // The replacement serial's register row carries the conflicting MAC. An
    // exchange that sends only the serial must still be refused 409, not reach
    // the unique index after hydration.
    const res = await call('POST', '/api/customer-devices/exchange', exchangeBody({
      newDeviceSerial: 'CMC-REPL-BLANK',
      newPonSerial: 'CMC-PON-BLANK',
      newMacAddress: undefined,
    }));
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.match(String(res.json?.message || ''), /MAC address/i);
    assert.equal(await serialStatus('CMC-REPL-BLANK'), 'IN_STOCK');
    const oldRow = await pool.query('SELECT status FROM customer_device_records WHERE id = $1', [OLD_CDR]);
    assert.equal(oldRow.rows[0]?.status, 'RENTAL');
  });

  test('exchange with a genuinely new MAC still succeeds', { skip: skipNoDb }, async () => {
    const stockBeforeExchange = await stockQoh();
    const res = await call('POST', '/api/customer-devices/exchange', exchangeBody());
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const oldRow = await pool.query('SELECT status FROM customer_device_records WHERE id = $1', [OLD_CDR]);
    assert.equal(oldRow.rows[0]?.status, 'EXCHANGED');
    assert.equal(await serialStatus('CMC-REPL'), 'CUSTOMER_ASSIGNED');
    const replacement = await pool.query(
      "SELECT status, mac_address FROM customer_device_records WHERE device_serial = 'CMC-REPL'"
    );
    assert.equal(replacement.rows[0]?.status, 'RENTAL');
    assert.equal(replacement.rows[0]?.mac_address, '00:11:22:33:44:55');
    assert.equal(
      await stockQoh(),
      stockBeforeExchange - 1,
      'KEEP adds no disposition credit, but the replacement still leaves branch stock (CPE-3)'
    );
  });
});
