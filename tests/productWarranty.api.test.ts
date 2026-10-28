/**
 * WTY-3 product warranty defaults — live HTTP against real PostgreSQL.
 *
 * A default is only useful if it survives the round trip. These tests create
 * and edit real products through the real routes and read the stored columns
 * back, because three silent failures are otherwise invisible:
 *
 *   1. VALIDATION — a fractional, negative, over-ceiling or non-numeric term
 *      must be a 400 that changes nothing. A clamp to 12 (the old repo helper)
 *      would look like success and quietly rewrite a negotiated term.
 *   2. OMISSION — an edit that does not mention a term must keep the stored
 *      value. The operational cache feeds the merge, so this also proves the
 *      product cache mapping actually carries both warranty columns; without
 *      them the omitted column resolved to the 12-month fallback.
 *   3. BOUNDS — 0 is a real value ("no warranty"), not "missing".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setCategories, setUomList } from '../server/src/state/runtimeState';
import { ensureReferenceData } from './fixtures/referenceData';

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

const CATEGORY = 'WRT3 Category';
const UOM_SYMBOL = 'WRT3-PCS';
const UOM_ID = 'wrt3-uom';
const CATEGORY_ID = 'wrt3-cat';

const SUPER = {
  id: 'wrt3-super',
  email: 'wrt3-super@example.com',
  name: 'WRT3 Super',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
};
const token = issueAuthToken(SUPER as any);

describe('product warranty defaults (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const createdIds: string[] = [];

  before(async () => {
    await ensureReferenceData(pool!);
    await pool!.query("DELETE FROM inventory_stock WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'WRT3-%')");
    await pool!.query("DELETE FROM products WHERE sku LIKE 'WRT3-%'");
    await pool!.query("DELETE FROM categories WHERE id = $1 OR code LIKE 'WRT3-%'", [CATEGORY_ID]);
    await pool!.query("DELETE FROM uom WHERE id = $1 OR symbol = $2", [UOM_ID, UOM_SYMBOL]);
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%WRT3-%'");

    // The controller resolves category/unit against its runtime caches; seed
    // both the cache and the DB so a save never has to invent master data.
    await pool!.query(
      "INSERT INTO categories (id, name, code, description, is_special_tracked) VALUES ($1, $2, 'WRT3', 'wrt3 fixture', FALSE)",
      [CATEGORY_ID, CATEGORY]
    );
    await pool!.query(
      "INSERT INTO uom (id, name, symbol, type, is_base_unit) VALUES ($1, 'WRT3 Pieces', $2, 'Count', TRUE)",
      [UOM_ID, UOM_SYMBOL]
    );
    setCategories([{ id: CATEGORY_ID, name: CATEGORY, code: 'WRT3', description: 'wrt3 fixture', isSpecialTracked: false }] as any);
    setUomList([{ id: UOM_ID, name: 'WRT3 Pieces', symbol: UOM_SYMBOL, type: 'Count', isBaseUnit: true }] as any);

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
    setCategories([]);
    setUomList([]);
    if (pool) {
      await pool.query("DELETE FROM inventory_stock WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'WRT3-%')");
      await pool.query("DELETE FROM products WHERE sku LIKE 'WRT3-%'");
      await pool.query("DELETE FROM categories WHERE id = $1 OR code LIKE 'WRT3-%'", [CATEGORY_ID]);
      await pool.query("DELETE FROM uom WHERE id = $1 OR symbol = $2", [UOM_ID, UOM_SYMBOL]);
      await pool.query("DELETE FROM audit_logs WHERE details LIKE '%WRT3-%'");
      await pool.end();
    }
  });

  async function request(method: 'POST' | 'PUT', path: string, body: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  const baseProduct = (sku: string, name: string) => ({
    name,
    sku,
    category: CATEGORY,
    unit: UOM_SYMBOL,
    productGroup: 'Product Item',
    costPrice: 100,
    sellingPrice: 150,
    taxRate: 13,
    minReorderLevel: 2,
  });

  async function create(body: Record<string, unknown>) {
    const res = await request('POST', '/api/products', body);
    if (res.status === 201 && res.json?.id) createdIds.push(res.json.id);
    return res;
  }

  async function stored(sku: string) {
    const { rows } = await pool!.query(
      'SELECT id, vendor_warranty_months AS vendor, seller_warranty_months AS seller FROM products WHERE sku = $1',
      [sku]
    );
    return rows[0];
  }

  test('a create that omits both terms stores 12/12', async () => {
    const res = await create(baseProduct('WRT3-DEF', 'WRT3 Default Terms'));
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.vendorWarrantyMonths, 12);
    assert.equal(res.json.sellerWarrantyMonths, 12);

    const row = await stored('WRT3-DEF');
    assert.equal(row.vendor, 12);
    assert.equal(row.seller, 12);
  });

  test('explicit 0 and 24 are stored as given (0 is a real "no warranty")', async () => {
    const res = await create({ ...baseProduct('WRT3-ZERO', 'WRT3 Zero Term'), vendorWarrantyMonths: 0, sellerWarrantyMonths: 24 });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.vendorWarrantyMonths, 0);
    assert.equal(res.json.sellerWarrantyMonths, 24);

    const row = await stored('WRT3-ZERO');
    assert.equal(row.vendor, 0);
    assert.equal(row.seller, 24);

    // The catalog read carries both columns back to the screen.
    const listed = await fetch('http://127.0.0.1:' + port + '/api/products', {
      headers: { authorization: 'Bearer ' + token },
    });
    const products = await listed.json();
    const zero = products.find((p: any) => p.sku === 'WRT3-ZERO');
    assert.equal(zero.vendorWarrantyMonths, 0);
    assert.equal(zero.sellerWarrantyMonths, 24);
  });

  test('invalid terms are a 400 and create nothing', async () => {
    const cases: Array<[string, unknown]> = [
      ['fraction', 1.5],
      ['fraction as text', '2.5'],
      ['negative', -1],
      ['above the ceiling', 121],
      ['not a number', 'abc'],
    ];
    for (const [label, value] of cases) {
      const sku = 'WRT3-BAD-' + label.replace(/\s+/g, '-').toUpperCase();
      const res = await create({ ...baseProduct(sku, 'WRT3 Bad ' + label), vendorWarrantyMonths: value });
      assert.equal(res.status, 400, `${label} must be refused`);
      assert.match(res.json.message, /0 and 120/, `${label} message`);
      assert.equal(await stored(sku), undefined, `${label} must not create a product`);
    }
  });

  test('an edit that omits one term keeps that column and updates the other', async () => {
    const created = await create({ ...baseProduct('WRT3-EDIT', 'WRT3 Edit Terms'), vendorWarrantyMonths: 0, sellerWarrantyMonths: 24 });
    assert.equal(created.status, 201);

    // Only the supplier term is mentioned: the seller term must survive the
    // cache merge (this is the regression the column mapping fixes).
    const first = await request('PUT', '/api/products/' + created.json.id, { vendorWarrantyMonths: 36 });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.vendorWarrantyMonths, 36);
    assert.equal(first.json.sellerWarrantyMonths, 24);

    const afterFirst = await stored('WRT3-EDIT');
    assert.equal(afterFirst.vendor, 36);
    assert.equal(afterFirst.seller, 24);

    const second = await request('PUT', '/api/products/' + created.json.id, { sellerWarrantyMonths: 6 });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.vendorWarrantyMonths, 36);
    assert.equal(second.json.sellerWarrantyMonths, 6);

    const afterSecond = await stored('WRT3-EDIT');
    assert.equal(afterSecond.vendor, 36);
    assert.equal(afterSecond.seller, 6);
  });

  test('null or blank on edit means "keep", not "reset to 12"', async () => {
    const { rows } = await pool!.query('SELECT id FROM products WHERE sku = $1', ['WRT3-EDIT']);
    for (const value of [null, '']) {
      const res = await request('PUT', '/api/products/' + rows[0].id, { vendorWarrantyMonths: value });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.vendorWarrantyMonths, 36, `value ${JSON.stringify(value)} must keep the stored term`);
    }
  });

  test('an invalid edit is a 400 and leaves the stored row untouched', async () => {
    const { rows } = await pool!.query('SELECT id FROM products WHERE sku = $1', ['WRT3-EDIT']);
    const before = await stored('WRT3-EDIT');
    for (const value of [1.5, -2, 121, 'abc']) {
      const res = await request('PUT', '/api/products/' + rows[0].id, { vendorWarrantyMonths: value });
      assert.equal(res.status, 400, `edit value ${String(value)} must be refused`);
      assert.match(res.json.message, /0 and 120/);
    }
    const afterRow = await stored('WRT3-EDIT');
    assert.deepEqual(afterRow, before, 'a rejected edit must not write anything');
  });
});
