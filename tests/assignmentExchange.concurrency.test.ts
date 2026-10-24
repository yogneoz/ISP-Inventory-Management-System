/**
 * Customer assignment vs device exchange, one serial, both at once (real
 * PostgreSQL, HTTP layer).
 *
 * Two different operators can plausibly reach for the same IN_STOCK unit at the
 * same moment: one assigning it to a new customer, one swapping it in as a
 * replacement. Each path gates the unit through the same serial-register rule
 * (`resolveSerialGateInDb` under `FOR UPDATE`), so the register row must
 * serialize them — exactly one request may take the unit.
 *
 * PROVES, whichever request wins:
 *  - exactly one 201, one refusal (400 from the register gate, or 409 from the
 *    duplicate check when the loser arrives after the winner committed);
 *  - exactly ONE customer-device row names the serial, attributed to the winner;
 *  - the register holds it as CUSTOMER_ASSIGNED;
 *  - branch stock is decremented exactly once when the ASSIGNMENT won, and not
 *    at all when the EXCHANGE won (an exchange draws from stock that was already
 *    decremented when the unit was received, and only the old unit's disposition
 *    moves stock);
 *  - the loser leaves no trace: the old rental record stays RENTAL if the
 *    exchange lost.
 *
 * Fixtures use an "asx-" id prefix and "ASX-" serials, removed in after().
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

const BRANCH = 'asx-branch';
const SERIAL = 'ASX-SN';
const INITIAL_STOCK = 4;

// This suite's own product. CI's database is schema-only — no seeded catalogue
// exists there — so the fixture row and its in-memory entry are provisioned by
// the suite and removed again in after().
const PRODUCT_ID = 'asx-prod';
const PRODUCT_SKU = 'ASXSKU';
const PRODUCT_NAME = 'ASX Fixture Router';

const SUPER_USER = {
  id: 'asx-super', email: 'asx-super@example.com', name: 'ASX Test',
  role: 'SUPER_ADMIN', branchId: BRANCH,
  allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;

describe('assignment vs exchange on one serial: exactly one may claim it', () => {
  let pool = probePool!;
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);
  let origCdr: any[] = [];
  const origProducts = [...products];
  const productName = PRODUCT_NAME;

  before(async () => {
    origCdr = [...customerDeviceRecords];
    if (!dbReachable) return;

    await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'ASX-%'");
    await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'asx-%' OR device_serial LIKE 'ASX-%'");
    await pool.query("DELETE FROM inventory_stock WHERE id = 'asx-stock'");
    await pool.query("DELETE FROM branches WHERE id = $1", [BRANCH]);

    await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT_ID]);

    // A serial-tracked product of this suite's own, in the database AND in the
    // in-memory catalogue the handlers resolve products through.
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
      "INSERT INTO branches (id, code, name, location) VALUES ($1, 'ASXBR', 'ASX Test Branch', 'T')",
      [BRANCH]
    );
    await pool.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
       VALUES ('asx-stock', $1, $2, $3, 0, 0, 0)`,
      [PRODUCT_ID, BRANCH, INITIAL_STOCK]
    );
    await pool.query(
      `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, status, source_type) VALUES
       ('asx-sl-new', $4, 'ASX-PON', 'AA:BB:CC:00:00:01', $1, $2, $3, 'IN_STOCK', 'PURCHASE'),
       ('asx-sl-old', 'ASX-OLD', 'ASX-OLDPON', 'AA:BB:CC:00:00:00', $1, $2, $3, 'CUSTOMER_ASSIGNED', 'PURCHASE')`,
      [PRODUCT_ID, PRODUCT_NAME, BRANCH, SERIAL]
    );
    await pool.query(
      `INSERT INTO customer_device_records
         (id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, status, notes)
       VALUES ('asx-cdr', 'Exchange Customer', 'ASXC', $1, $2, 'ASX-OLD', 'ASX-OLDPON', 'RENTAL', 'asx fixture')`,
      [BRANCH, PRODUCT_NAME]
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
    if (dbReachable) {
      await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'ASX-%'");
      await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'asx-%' OR device_serial LIKE 'ASX-%'");
      await pool.query("DELETE FROM inventory_stock WHERE id = 'asx-stock'");
      await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT_ID]);
      await pool.query("DELETE FROM branches WHERE id = $1", [BRANCH]);
      await pool.end();
    }
  });

  async function call(method: string, path: string, body?: unknown) {
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

  /** POST /api/customer-devices — assign the contested unit to a new customer. */
  const assign = () => call('POST', '/api/customer-devices', {
    id: 'asx-assign',
    customerName: 'Assign Customer',
    customerCode: 'ASX001',
    branchId: BRANCH,
    productName,
    deviceSerial: SERIAL,
    ponSerial: 'ASX-PON',
    status: 'RENTAL',
    issuedDateAD: '2026-10-20',
  });

  /** POST /api/customer-devices/exchange — swap the contested unit in. */
  const exchange = () => call('POST', '/api/customer-devices/exchange', {
    oldDeviceId: 'asx-cdr',
    exchangeReason: 'concurrency test',
    oldDeviceAction: 'KEEP',
    newProductName: productName,
    newDeviceSerial: SERIAL,
    newPonSerial: 'ASX-PON',
    notes: '',
    branchId: BRANCH,
  });

  test('exactly one of assignment/exchange wins the serial', { skip: skipNoDb }, async () => {
    const [assigned, exchanged] = await Promise.all([assign(), exchange()]);

    const statuses = [assigned.status, exchanged.status];
    assert.equal(
      statuses.filter((s) => s === 201).length,
      1,
      `expected exactly one winner, got ${JSON.stringify(statuses)}`
    );

    const assignmentWon = assigned.status === 201;
    const loser = assignmentWon ? exchanged : assigned;
    // Which guard refuses the loser depends on the interleaving, and both are
    // correct: the register gate (no longer IN_STOCK) when they overlap, or the
    // duplicate check (a customer record already names it) when the loser
    // arrives after the winner committed.
    assert.ok([400, 409].includes(loser.status), `loser must be refused, got ${loser.status} ${JSON.stringify(loser.json)}`);

    // One customer record for the contested serial, owned by the winner.
    const cdr = await pool.query(
      'SELECT customer_name FROM customer_device_records WHERE device_serial = $1',
      [SERIAL]
    );
    assert.equal(cdr.rowCount, 1, 'the serial must belong to exactly one customer record');
    assert.equal(cdr.rows[0].customer_name, assignmentWon ? 'Assign Customer' : 'Exchange Customer');

    const register = await pool.query('SELECT status FROM serial_log WHERE device_serial = $1', [SERIAL]);
    assert.equal(register.rows[0]?.status, 'CUSTOMER_ASSIGNED');

    // Stock moves once for an assignment and not at all for an exchange.
    const stock = await pool.query("SELECT quantity_on_hand FROM inventory_stock WHERE id = 'asx-stock'");
    assert.equal(
      Number(stock.rows[0]?.quantity_on_hand),
      assignmentWon ? INITIAL_STOCK - 1 : INITIAL_STOCK,
      assignmentWon ? 'a won assignment must consume exactly one unit' : 'a won exchange must not consume branch stock'
    );

    // The loser leaves no trace on its own record.
    const oldRow = await pool.query("SELECT status FROM customer_device_records WHERE id = 'asx-cdr'");
    assert.equal(
      oldRow.rows[0]?.status,
      assignmentWon ? 'RENTAL' : 'EXCHANGED',
      assignmentWon ? 'a refused exchange must leave the old rental open' : 'a winning exchange must close the old rental'
    );
  });
});
