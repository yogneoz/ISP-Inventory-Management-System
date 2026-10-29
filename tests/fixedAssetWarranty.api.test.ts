/**
 * WTY-4 fixed-asset capture — an asset carries its supplier warranty from the
 * moment it is registered, keyed by its tag, and loses only its CURRENT row
 * when it is disposed.
 *
 * Real HTTP + PostgreSQL, because the claim is about what the register row
 * becomes after real writes:
 *
 *   1. create stores one VENDOR row with the linked product's term (24 months)
 *      or the 12-month fallback when no product is linked;
 *   2. a typed expiry wins;
 *   3. a reversed expiry refuses the asset (and writes nothing);
 *   4. re-saving the asset (the edit path) supersedes the prior period, so the
 *      register never shows two current rows for one tag;
 *   5. disposal retires the current row while keeping its history.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes, products, setProducts } from '../server/src/app';
import type { Product } from '../client/src/types';
import { issueAuthToken } from '../server/src/middleware/auth';
import { ensureReferenceData } from './fixtures/referenceData';
import { addCalendarMonths } from '../shared/warrantyTerm';

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

const BRANCH = 'w4a-branch';
const PRODUCT = 'w4a-prod';
const today = new Date().toISOString().split('T')[0];

const product = {
  id: PRODUCT,
  sku: 'W4A-SKU',
  barcode: 'W4A-SKU',
  name: 'W4A Router',
  category: 'Equipment',
  productGroup: 'Product Item',
  unit: 'Pcs',
  costPrice: 100,
  sellingPrice: 150,
  taxRate: 0,
  minReorderLevel: 1,
  requiresSerialTracking: false,
  trackingType: 'QUANTITY_ONLY',
  vendorWarrantyMonths: 24,
} as Product;

const ADMIN = {
  id: 'w4a-admin',
  email: 'w4a-admin@example.com',
  name: 'W4A Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('fixed-asset supplier warranty (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const originalProducts = [...products];

  async function cleanup() {
    await pool!.query("DELETE FROM warranty_coverages WHERE serial_number LIKE 'W4A-TAG-%'");
    await pool!.query("DELETE FROM fixed_assets WHERE id LIKE 'w4a-asset-%'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%W4A-TAG-%'");
    await pool!.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
    await pool!.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
  }

  before(async () => {
    await ensureReferenceData(pool!, today);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'W4AB', 'W4A Asset Branch', 'T')`,
      [BRANCH]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type, vendor_warranty_months, seller_warranty_months)
       VALUES ($1, 'W4A Router', 'W4A-SKU', 'Equipment', 'Product Item', 'Pcs', 100, 150, FALSE, 'QUANTITY_ONLY', 24, 12)`,
      [PRODUCT]
    );
    setProducts([...originalProducts, product]);

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
    setProducts(originalProducts);
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function call(method: 'POST' | 'PATCH', path: string, body: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is itself a finding */ }
    return { status: res.status, json };
  }

  function assetBody(tag: string, extra: Record<string, any> = {}) {
    return {
      id: `w4a-asset-${tag.toLowerCase()}`,
      tagNumber: tag,
      name: 'W4A Asset',
      category: 'IT Equipment',
      branchId: BRANCH,
      acquisitionDateAD: today,
      acquisitionCost: 100,
      supplierName: 'W4A Supplier',
      ...extra,
    };
  }

  async function coverage(tag: string) {
    const { rows } = await pool!.query(
      `SELECT coverage_type AS "coverageType", item_category AS "itemCategory",
              serial_number AS "serialNumber", asset_id AS "assetId",
              branch_id AS "branchId", party_name AS "partyName",
              source_type AS "sourceType", source_id AS "sourceId",
              start_date_ad AS "startDateAD", end_date_ad AS "endDateAD",
              term_months AS "termMonths", start_basis AS "startBasis",
              is_current AS "isCurrent"
         FROM warranty_coverages WHERE serial_number = $1 ORDER BY created_at ASC`,
      [tag]
    );
    return rows;
  }

  test('create stores the linked product term keyed by the asset tag', async () => {
    const res = await call('POST', '/api/assets', assetBody('W4A-TAG-1', { productId: PRODUCT }));
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const [row] = await coverage('W4A-TAG-1');
    assert.ok(row, 'the asset must carry a supplier coverage');
    assert.equal(row.coverageType, 'VENDOR');
    assert.equal(row.itemCategory, 'FIXED_ASSET');
    assert.equal(row.assetId, 'w4a-asset-w4a-tag-1');
    assert.equal(row.branchId, BRANCH);
    assert.equal(row.partyName, 'W4A Supplier');
    assert.equal(row.sourceType, 'FIXED_ASSET');
    assert.equal(row.sourceId, 'w4a-asset-w4a-tag-1');
    assert.equal(row.startDateAD, today);
    assert.equal(row.endDateAD, addCalendarMonths(today, 24));
    assert.equal(Number(row.termMonths), 24);
    assert.equal(row.startBasis, 'ACQUISITION_DATE');
    assert.equal(row.isCurrent, true);
  });

  test('an unlinked product falls back to 12 months, and a typed date wins', async () => {
    const fallback = await call('POST', '/api/assets', assetBody('W4A-TAG-2'));
    assert.equal(fallback.status, 201, JSON.stringify(fallback.json));
    const [twelve] = await coverage('W4A-TAG-2');
    assert.equal(twelve.endDateAD, addCalendarMonths(today, 12));
    assert.equal(Number(twelve.termMonths), 12);

    const typed = await call('POST', '/api/assets', assetBody('W4A-TAG-3', {
      supplierWarrantyEndDateAD: '2031-06-30',
    }));
    assert.equal(typed.status, 201, JSON.stringify(typed.json));
    const [row] = await coverage('W4A-TAG-3');
    assert.equal(row.endDateAD, '2031-06-30', 'the typed contract date is authoritative');
  });

  test('a reversed expiry refuses the asset and writes neither row', async () => {
    const res = await call('POST', '/api/assets', assetBody('W4A-TAG-BAD', {
      supplierWarrantyEndDateAD: '2019-01-01',
    }));
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(String(res.json?.message), /on or after the warranty start date/i);

    assert.deepEqual(await coverage('W4A-TAG-BAD'), []);
    const asset = await pool!.query("SELECT count(*)::int AS n FROM fixed_assets WHERE tag_number = 'W4A-TAG-BAD'");
    assert.equal(Number(asset.rows[0].n), 0, 'a refused asset must not exist');
  });

  test('re-saving the asset supersedes its prior period instead of adding a second current row', async () => {
    const res = await call('POST', '/api/assets', assetBody('W4A-TAG-1', {
      productId: PRODUCT,
      supplierWarrantyEndDateAD: '2032-01-31',
    }));
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const rows = await coverage('W4A-TAG-1');
    assert.equal(rows.length, 2, 'the old period stays as history');
    assert.equal(rows.filter((row) => row.isCurrent).length, 1, 'exactly one current row');
    assert.equal(rows[rows.length - 1].endDateAD, '2032-01-31');
  });

  test('disposal retires the current row and keeps its history', async () => {
    const res = await call('PATCH', '/api/assets/w4a-asset-w4a-tag-1/status', { status: 'DISPOSED' });
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const rows = await coverage('W4A-TAG-1');
    assert.equal(rows.filter((row) => row.isCurrent).length, 0, 'a disposed asset is not a current obligation');
    assert.equal(rows.length, 2, 'disposal keeps the coverage history');
  });
});
