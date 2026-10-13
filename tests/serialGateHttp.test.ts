/**
 * Shared serial gate — HTTP-layer proof (Slice 2 of the serial-register plan).
 *
 * PROVES, on a real Express app wired exactly as production (createApp +
 * registerAllRoutes) against real PostgreSQL, that a serial-touching endpoint
 * RESOLVES its units against the register instead of consulting its own mirror:
 *
 *  1. an unknown serial is refused (400) with the register's own reason — the
 *     old stock-operations check accepted anything the in-memory
 *     `customer_device_records` mirror happened to contain, and the deploy path
 *     silently skipped the flip when the serial was absent;
 *  2. a unit that has already moved on (CUSTOMER_ASSIGNED) is refused by state;
 *  3. a unit held at another branch is refused by branch;
 *  4. a valid IN_STOCK unit at the acting branch posts, and the stock moves;
 *  5. a refused operation moves NOTHING — no stock_operations row, no
 *     fixed_assets row, stock untouched.
 *
 * Fixtures use an "sg-" id prefix / "SG" serials, seeded in BOTH the database and
 * the in-memory mirrors and removed in after(). Skips without a reachable
 * PostgreSQL (DATABASE_URL) or without a seeded BS day record to date the
 * operation with.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  createApp,
  registerAllRoutes,
  branches,
  products,
  inventoryStock,
  setBranches,
  setProducts,
  setInventoryStock,
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

const SUPER_USER = {
  id: 'sg-super', email: 'sg-super@example.com', name: 'SG Test',
  role: 'SUPER_ADMIN', branchId: 'sg-branch',
  allowedBranchIds: ['sg-branch', 'sg-branch-2'], canSwitchUser: false,
} as any;

const BRANCH = 'sg-branch';
const OTHER_BRANCH = 'sg-branch-2';
const PRODUCT = 'sg-prod';
const IN_STOCK = 'SG-IN-STOCK';
const ASSIGNED = 'SG-ASSIGNED';
const OTHER_BRANCH_SERIAL = 'SG-OTHER-BRANCH';
const PON = 'SG-PON';

describe('shared serial gate (HTTP layer)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);
  let opDateAD = '';
  let skippable: string | undefined;
  const origBranches = [...branches];
  const origProducts = [...products];
  const origStock = [...inventoryStock];

  before(async () => {
    if (!dbReachable) return;
    await cleanup();

    // The stock-operation controller dates every row through bs_day_records
    // (the BS gate). Reuse a seeded day rather than inventing one, so the
    // calendar stays the single source of truth.
    const day = await pool!.query(
      "SELECT ad_date FROM bs_day_records WHERE ad_date IS NOT NULL ORDER BY ad_date DESC LIMIT 1"
    );
    opDateAD = day.rows[0]?.ad_date ? String(day.rows[0].ad_date).slice(0, 10) : '';
    if (!opDateAD) {
      skippable = 'needs a seeded bs_day_records row to date the operation';
      return;
    }

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
       ('${BRANCH}', 'SGB', 'SG Gate Branch', 'T'),
       ('${OTHER_BRANCH}', 'SGB2', 'SG Other Branch', 'T')`
    );
    await pool!.query(
      `INSERT INTO products (id, name, sku, category, product_group, unit, cost_price, selling_price, requires_serial_tracking, tracking_type)
       VALUES ('${PRODUCT}', 'SG ONU', 'SGONU', 'Equipment', 'Product Item', 'Pcs', 100, 150, TRUE, 'SERIAL_ONLY')`
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
       VALUES ('sg-stock', '${PRODUCT}', '${BRANCH}', 5, 0, 0, 0, 1),
              ('sg-stock-2', '${PRODUCT}', '${OTHER_BRANCH}', 5, 0, 0, 0, 1)`
    );
    await pool!.query(
      `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, status, source_type, history_json)
       VALUES
       ('sg-sl-in',      '${IN_STOCK}',           '${PON}', 'SG:MAC:1', '${PRODUCT}', 'SG ONU', '${BRANCH}',       'IN_STOCK',          'PURCHASE', '[]'),
       ('sg-sl-assigned','${ASSIGNED}',           '${PON}-A', 'SG:MAC:2', '${PRODUCT}', 'SG ONU', '${BRANCH}',       'CUSTOMER_ASSIGNED', 'SALES_INVOICE', '[]'),
       ('sg-sl-other',   '${OTHER_BRANCH_SERIAL}', '${PON}-B', 'SG:MAC:3', '${PRODUCT}', 'SG ONU', '${OTHER_BRANCH}', 'IN_STOCK',          'PURCHASE', '[]')`
    );

    // The controller's pre-flight reads the mirrors, so the fixtures must exist
    // there too (otherwise the request never reaches the gate).
    setBranches([
      ...origBranches,
      { id: BRANCH, code: 'SGB', name: 'SG Gate Branch', location: 'T' } as any,
      { id: OTHER_BRANCH, code: 'SGB2', name: 'SG Other Branch', location: 'T' } as any,
    ] as any);
    setProducts([
      ...origProducts,
      {
        id: PRODUCT, name: 'SG ONU', sku: 'SGONU', costPrice: 100, sellingPrice: 150,
        requiresSerialTracking: true, trackingType: 'SERIAL_ONLY',
      } as any,
    ] as any);
    setInventoryStock([
      ...origStock,
      { id: 'sg-stock', productId: PRODUCT, branchId: BRANCH, quantityOnHand: 5, damagedQty: 0, reservedQty: 0, incomingQty: 0, minReorderLevel: 1, lastUpdated: '' } as any,
      { id: 'sg-stock-2', productId: PRODUCT, branchId: OTHER_BRANCH, quantityOnHand: 5, damagedQty: 0, reservedQty: 0, incomingQty: 0, minReorderLevel: 1, lastUpdated: '' } as any,
    ] as any);

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
    setBranches(origBranches as any);
    setProducts(origProducts as any);
    setInventoryStock(origStock as any);
    if (pool && dbReachable) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup() {
    if (!pool) return;
    await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'SG-%'");
    await pool.query("DELETE FROM stock_operations WHERE id LIKE 'sg-op%' OR reference_number LIKE 'sg%'");
    await pool.query("DELETE FROM fixed_assets WHERE id LIKE 'sg-%' OR tag_number LIKE 'SG-%'");
    await pool.query("DELETE FROM transaction_logs WHERE reference_doc_id LIKE 'SG-%'");
    await pool.query("DELETE FROM inventory_stock WHERE id LIKE 'sg-%'");
    await pool.query("DELETE FROM products WHERE id = 'sg-prod'");
    await pool.query("DELETE FROM branches WHERE id LIKE 'sg-branch%'");
  }

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  /** A PULLOUT drawing exactly one unit, from the branch, with this serial. */
  const pullout = (deviceSerial: string, branchId = BRANCH) => ({
    type: 'PULLOUT',
    branchId,
    dateAD: opDateAD,
    reason: 'sg gate test',
    items: [{
      productId: PRODUCT,
      productName: 'SG ONU',
      quantity: 1,
      deviceSerials: [{ deviceSerial, ponSerial: PON }],
    }],
  });

  const stockOnHand = async (branchId = BRANCH) => {
    const r = await pool!.query(
      'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      [PRODUCT, branchId]
    );
    return Number(r.rows[0]?.quantity_on_hand);
  };

  const opCount = async () => {
    const r = await pool!.query("SELECT count(*)::int AS n FROM stock_operations WHERE branch_id LIKE 'sg-branch%'");
    return Number(r.rows[0].n);
  };

  test('unknown serial is refused and moves no stock', { skip: skipNoDb || skippable }, async () => {
    const before = await stockOnHand();
    const opsBefore = await opCount();
    const { status, json } = await call('POST', '/api/stock-operations', pullout('SG-NEVER-RECEIVED'));
    assert.equal(status, 400);
    assert.match(String(json?.message), /not in the serial register/);
    assert.equal(await stockOnHand(), before, 'a refused operation must not move stock');
    assert.equal(await opCount(), opsBefore, 'a refused operation must not be recorded');
  });

  test('a unit that already moved on is refused by state', { skip: skipNoDb || skippable }, async () => {
    const { status, json } = await call('POST', '/api/stock-operations', pullout(ASSIGNED));
    assert.equal(status, 400);
    assert.match(String(json?.message), /CUSTOMER_ASSIGNED \(not IN_STOCK\)/);
  });

  test('a unit held at another branch is refused by branch', { skip: skipNoDb || skippable }, async () => {
    const { status, json } = await call('POST', '/api/stock-operations', pullout(OTHER_BRANCH_SERIAL));
    assert.equal(status, 400);
    assert.match(String(json?.message), /held at branch/);
  });

  test('an IN_STOCK unit at the acting branch posts and consumes the stock', { skip: skipNoDb || skippable }, async () => {
    const before = await stockOnHand();
    const { status, json } = await call('POST', '/api/stock-operations', pullout(IN_STOCK));
    assert.equal(status, 201);
    assert.ok(json?.referenceNumber, 'the operation must be numbered');
    assert.equal(await stockOnHand(), before - 1, 'the unit must leave branch stock');
  });

  test('deploy-from-stock refuses an unknown serial instead of silently skipping', { skip: skipNoDb || skippable }, async () => {
    const before = await stockOnHand();
    const { status, json } = await call('POST', '/api/assets', {
      tagNumber: 'SG-TAG-GHOST',
      name: 'SG ONU',
      branchId: BRANCH,
      productId: PRODUCT,
      status: 'ASSIGNED_TO_LOCATION',
      deployFromStock: true,
      deviceSerial: 'SG-GHOST-DEPLOY',
      acquisitionDateAD: opDateAD,
      acquisitionCost: 100,
    });
    assert.equal(status, 400);
    assert.match(String(json?.message), /not in the serial register/);
    assert.equal(await stockOnHand(), before, 'a refused deploy must not deduct stock');
    const assets = await pool!.query("SELECT count(*)::int AS n FROM fixed_assets WHERE tag_number = 'SG-TAG-GHOST'");
    assert.equal(Number(assets.rows[0].n), 0, 'a refused deploy must not create the asset');
  });
});
