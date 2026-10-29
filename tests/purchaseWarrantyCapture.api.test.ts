/**
 * WTY-4 purchase capture — the supplier warranty comes from the bill that
 * creates the unit, not from a later 12-month guess.
 *
 * These tests drive the real Express app against PostgreSQL, because the claim
 * is transactional: one VENDOR row per received serial, written in the same
 * transaction as the stock receipt, with the invoice date and supplier stored.
 * The cases that would pass a shallow implementation are the ones pinned here:
 *
 *   1. the product's own term (24 months) prefills the exact expiry;
 *   2. an operator-entered expiry wins over the product default;
 *   3. a reversed expiry refuses the bill and writes neither invoice nor row;
 *   4. a quantity-only line creates no coverage;
 *   5. a receipt that rolls back (duplicate serial) leaves no coverage;
 *   6. a purchase return supersedes exactly that invoice's rows.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes, products, setProducts } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { ensureReferenceData } from './fixtures/referenceData';
import { addCalendarMonths } from '../shared/warrantyTerm';
import type { Product } from '../client/src/types';

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

const BRANCH = 'w4-branch';
const PRODUCT = 'w4-prod';
const BULK = 'w4-bulk';
const today = new Date().toISOString().split('T')[0];

const product: Product = {
  id: PRODUCT,
  sku: 'W4-SKU',
  barcode: 'W4-SKU',
  name: 'W4 ONU',
  category: 'Equipment',
  productGroup: 'Product Item',
  unit: 'Pcs',
  costPrice: 100,
  sellingPrice: 150,
  taxRate: 0,
  minReorderLevel: 1,
  requiresSerialTracking: true,
  trackingType: undefined,
  vendorWarrantyMonths: 24,
  sellerWarrantyMonths: 12,
} as Product;

const bulkProduct: Product = {
  ...product,
  id: BULK,
  sku: 'W4-BULK',
  barcode: 'W4-BULK',
  name: 'W4 Cable',
  requiresSerialTracking: false,
  trackingType: 'QUANTITY_ONLY',
  vendorWarrantyMonths: 0,
} as Product;

const ADMIN = {
  id: 'w4-admin',
  email: 'w4-admin@example.com',
  name: 'W4 Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

function line(overrides: Record<string, any> = {}) {
  return {
    id: `w4-line-${Math.random().toString(36).slice(2, 8)}`,
    productId: PRODUCT,
    productName: product.name,
    sku: product.sku,
    unit: 'Pcs',
    quantity: 1,
    unitPrice: 100,
    discount: 0,
    isTaxExempt: true,
    taxRate: 0,
    subtotal: 100,
    taxAmount: 0,
    total: 100,
    ...overrides,
  };
}

function serial(value: string) {
  return [{ deviceSerial: value, ponSerial: `${value}-PON`, macAddress: '' }];
}

describe('purchase warranty capture (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const originalProducts = [...products];

  async function cleanup() {
    await pool!.query("DELETE FROM warranty_coverages WHERE serial_number LIKE 'W4-%'");
    await pool!.query("DELETE FROM purchase_returns WHERE id LIKE 'w4-ret-%'");
    await pool!.query("DELETE FROM purchase_invoices WHERE id LIKE 'w4-inv-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id IN ($1, $2)", [PRODUCT, BULK]);
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'W4-%'");
    await pool!.query("DELETE FROM transaction_logs WHERE product_id IN ($1, $2)", [PRODUCT, BULK]);
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%W4-%'");
    await pool!.query("DELETE FROM products WHERE id IN ($1, $2)", [PRODUCT, BULK]);
    await pool!.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
  }

  before(async () => {
    await ensureReferenceData(pool!, today);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'W4B', 'W4 Capture Branch', 'T')`,
      [BRANCH]
    );
    for (const entry of [product, bulkProduct]) {
      await pool!.query(
        `INSERT INTO products
          (id, name, sku, category, product_group, unit, cost_price, selling_price,
           requires_serial_tracking, tracking_type, vendor_warranty_months, seller_warranty_months)
         VALUES ($1, $2, $3, 'Equipment', 'Product Item', 'Pcs', 100, 150, $4, $5, $6, 12)`,
        [entry.id, entry.name, entry.sku, entry.requiresSerialTracking, entry.trackingType, entry.vendorWarrantyMonths]
      );
    }
    setProducts([...originalProducts, product, bulkProduct]);

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

  async function call(method: 'POST', path: string, body: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is itself a finding */ }
    return { status: res.status, json };
  }

  async function coverage(serialNumber: string) {
    const { rows } = await pool!.query(
      `SELECT coverage_type AS "coverageType", item_category AS "itemCategory",
              serial_number AS "serialNumber", branch_id AS "branchId",
              party_name AS "partyName", source_type AS "sourceType",
              source_id AS "sourceId", source_number AS "sourceNumber",
              start_date_ad AS "startDateAD", end_date_ad AS "endDateAD",
              term_months AS "termMonths", start_basis AS "startBasis",
              is_current AS "isCurrent"
         FROM warranty_coverages WHERE serial_number = $1 ORDER BY created_at ASC`,
      [serialNumber]
    );
    return rows;
  }

  function invoiceBody(id: string, items: any[], extra: Record<string, any> = {}) {
    return {
      id,
      invoiceNumber: `W4-${id.replace('w4-inv-', '').toUpperCase()}`,
      invoiceDateAD: today,
      branchId: BRANCH,
      supplierName: 'W4 Supplier',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      items,
      ...extra,
    };
  }

  test('a serialised receipt writes the product term from the invoice date', async () => {
    const res = await call('POST', '/api/purchase-invoices', invoiceBody('w4-inv-a', [
      line({ deviceSerials: serial('W4-A1') }),
    ]));
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const [row] = await coverage('W4-A1');
    assert.ok(row, 'the received serial must carry a VENDOR coverage');
    assert.equal(row.coverageType, 'VENDOR');
    assert.equal(row.itemCategory, 'CPE');
    assert.equal(row.branchId, BRANCH);
    assert.equal(row.partyName, 'W4 Supplier');
    assert.equal(row.sourceType, 'PURCHASE_INVOICE');
    assert.equal(row.sourceId, 'w4-inv-a');
    assert.equal(row.sourceNumber, res.json.invoiceNumber, 'the register names the bill that captured it');
    assert.equal(row.startDateAD, today);
    assert.equal(row.endDateAD, addCalendarMonths(today, 24), 'the product term prefills the expiry');
    assert.equal(Number(row.termMonths), 24);
    assert.equal(row.startBasis, 'INVOICE_DATE');
    assert.equal(row.isCurrent, true);
  });

  test('an operator-entered expiry wins over the product default', async () => {
    const explicit = '2030-12-31';
    const res = await call('POST', '/api/purchase-invoices', invoiceBody('w4-inv-b', [
      line({ deviceSerials: serial('W4-B1'), warrantyEndDateAD: explicit }),
    ]));
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const [row] = await coverage('W4-B1');
    assert.equal(row.endDateAD, explicit, 'the typed contract date is authoritative');
    assert.equal(Number(row.termMonths), 24, 'the product term is still snapshotted');
    assert.equal(row.startBasis, 'INVOICE_DATE');
  });

  test('a reversed expiry refuses the bill and writes neither invoice nor coverage', async () => {
    const res = await call('POST', '/api/purchase-invoices', invoiceBody('w4-inv-bad', [
      line({ deviceSerials: serial('W4-BAD1'), warrantyEndDateAD: '2020-01-01' }),
    ]));
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(String(res.json?.message), /on or after the warranty start date/i);

    assert.deepEqual(await coverage('W4-BAD1'), []);
    const inv = await pool!.query("SELECT count(*)::int AS n FROM purchase_invoices WHERE id = 'w4-inv-bad'");
    assert.equal(Number(inv.rows[0].n), 0, 'a refused bill must not exist');
  });

  test('a quantity-only line creates no per-unit coverage', async () => {
    const { rows } = await pool!.query("SELECT count(*)::int AS n FROM warranty_coverages WHERE serial_number LIKE 'W4-CABLE%'");
    assert.equal(Number(rows[0].n), 0);

    const res = await call('POST', '/api/purchase-invoices', invoiceBody('w4-inv-bulk', [
      line({ productId: BULK, productName: bulkProduct.name, sku: bulkProduct.sku, quantity: 2 }),
    ]));
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const afterRows = await pool!.query(
      "SELECT count(*)::int AS n FROM warranty_coverages WHERE product_id = $1",
      [BULK]
    );
    assert.equal(Number(afterRows.rows[0].n), 0, 'quantity-only lines carry no unit warranty');
  });

  test('a rolled-back receipt leaves no coverage for the units it planned', async () => {
    // First line would register W4-RB1; the second repeats W4-B1, which is
    // already IN_STOCK, so the transaction refuses and must roll back both.
    const res = await call('POST', '/api/purchase-invoices', invoiceBody('w4-inv-rb', [
      line({ deviceSerials: serial('W4-RB1') }),
      line({ deviceSerials: serial('W4-B1') }),
    ]));
    assert.ok(res.status >= 400, `a duplicate serial must refuse the bill (got ${res.status})`);

    assert.deepEqual(await coverage('W4-RB1'), []);
    const inv = await pool!.query("SELECT count(*)::int AS n FROM purchase_invoices WHERE id = 'w4-inv-rb'");
    assert.equal(Number(inv.rows[0].n), 0, 'nothing from the failed bill may persist');
  });

  test('a purchase return supersedes that invoice\'s rows and leaves other purchases current', async () => {
    const res = await call('POST', '/api/purchase-returns', {
      id: 'w4-ret-a',
      originalInvoiceId: 'w4-inv-a',
      branchId: BRANCH,
      returnDateAD: today,
      reason: 'DEFECTIVE',
      items: [line({ quantity: 1, deviceSerials: serial('W4-A1') })],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const [returned] = await coverage('W4-A1');
    assert.equal(returned.isCurrent, false, 'the returned unit stops being a current supplier obligation');

    const [other] = await coverage('W4-B1');
    assert.equal(other.isCurrent, true, 'another purchase keeps its current coverage');
  });
});
