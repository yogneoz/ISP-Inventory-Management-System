/**
 * WTY-5 seller warranty capture — the promise we make to the customer is
 * written where the unit leaves us, and retired when it comes back.
 *
 * Real HTTP + PostgreSQL, because every claim is transactional:
 *
 *   1. issuing a rental CPE writes one SELLER row keyed by the device record,
 *      with the customer, branch and issue-date basis;
 *   2. switching the warranty off writes no row, and switching it on with a
 *      blank expiry refuses the issue (no CDR is created);
 *   3. the register read returns the STORED promise, not issued date + 12;
 *   4. collection retires the current row while keeping its history;
 *   5. an exchange retires the old unit's row and starts the replacement's;
 *   6. a retail sale writes one SOLD_PRODUCT row per sold serial, and a
 *      reversal retires exactly that operation's rows;
 *   7. a sales invoice captures its own source, and cancelling it retires them.
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

const BRANCH = 'w5-branch';
const PRODUCT = 'w5-prod';
const ZERO = 'w5-zero';
const today = new Date().toISOString().split('T')[0];

const product: Product = {
  id: PRODUCT,
  sku: 'W5-SKU',
  barcode: 'W5-SKU',
  name: 'W5 Router',
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

const zeroProduct: Product = {
  ...product,
  id: ZERO,
  sku: 'W5-ZERO',
  barcode: 'W5-ZERO',
  name: 'W5 No-Warranty Router',
  sellerWarrantyMonths: 0,
} as Product;

const ADMIN = {
  id: 'w5-admin',
  email: 'w5-admin@example.com',
  name: 'W5 Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('seller warranty capture (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const originalProducts = [...products];

  async function cleanup() {
    await pool!.query("DELETE FROM warranty_coverages WHERE serial_number LIKE 'W5-%'");
    await pool!.query("DELETE FROM customer_device_records WHERE device_serial LIKE 'W5-%'");
    await pool!.query("DELETE FROM sales_invoices WHERE id LIKE 'w5-si-%'");
    await pool!.query("DELETE FROM stock_operations WHERE id LIKE 'w5-op-%'");
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'W5-%'");
    await pool!.query('DELETE FROM transaction_logs WHERE product_id IN ($1, $2)', [PRODUCT, ZERO]);
    await pool!.query('DELETE FROM inventory_stock WHERE product_id IN ($1, $2)', [PRODUCT, ZERO]);
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%W5-%'");
    await pool!.query('DELETE FROM products WHERE id IN ($1, $2)', [PRODUCT, ZERO]);
    await pool!.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
  }

  before(async () => {
    await ensureReferenceData(pool!, today);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'W5B', 'W5 Seller Branch', 'T')`,
      [BRANCH]
    );
    for (const entry of [product, zeroProduct]) {
      await pool!.query(
        `INSERT INTO products
          (id, name, sku, category, product_group, unit, cost_price, selling_price,
           requires_serial_tracking, tracking_type, vendor_warranty_months, seller_warranty_months)
         VALUES ($1, $2, $3, 'Equipment', 'Product Item', 'Pcs', 100, 150, TRUE, 'SERIAL_ONLY', 24, $4)`,
        [entry.id, entry.name, entry.sku, entry.sellerWarrantyMonths]
      );
    }
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
       VALUES ('w5-stock', $1, $2, 20, 0, 0, 0, 1)`,
      [PRODUCT, BRANCH]
    );
    setProducts([...originalProducts, product, zeroProduct]);

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

  async function call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is itself a finding */ }
    return { status: res.status, json };
  }

  /** One IN_STOCK register row, so the gates accept the unit. */
  async function stockUnit(serial: string, pon: string, productId = PRODUCT) {
    await pool!.query(
      `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, status, source_type, history_json)
       VALUES ($1, $2, $3, NULL, $4, 'W5 Router', $5, 'IN_STOCK', 'PURCHASE', '[]')`,
      [`w5-sl-${serial}`, serial, pon, productId, BRANCH]
    );
  }

  async function coverages(serial: string) {
    const { rows } = await pool!.query(
      `SELECT coverage_type AS "coverageType", item_category AS "itemCategory",
              serial_number AS "serialNumber", device_record_id AS "deviceRecordId",
              branch_id AS "branchId", party_name AS "partyName", party_id AS "partyId",
              source_type AS "sourceType", source_id AS "sourceId",
              start_date_ad AS "startDateAD", end_date_ad AS "endDateAD",
              term_months AS "termMonths", start_basis AS "startBasis",
              is_current AS "isCurrent"
         FROM warranty_coverages WHERE serial_number = $1 ORDER BY created_at ASC`,
      [serial]
    );
    return rows;
  }

  test('issuing a rental CPE writes the customer promise keyed by the device record', async () => {
    await stockUnit('W5-ASN-1', 'W5-ASN-1-PON');
    const res = await call('POST', '/api/customer-devices', {
      id: 'w5-cdr-a',
      customerId: 'w5-cust',
      customerName: 'W5 Customer',
      customerCode: 'CUS-W5',
      contactPhone: '9800000000',
      installationAddress: 'Kathmandu',
      branchId: BRANCH,
      productName: product.name,
      deviceSerial: 'W5-ASN-1',
      ponSerial: 'W5-ASN-1-PON',
      status: 'RENTAL',
      issuedDateAD: today,
      issuedDateBS: '2083-07-13',
      sellerWarrantyEndDateAD: '2031-01-31',
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const [row] = await coverages('W5-ASN-1');
    assert.ok(row, 'the issued unit must carry a SELLER coverage');
    assert.equal(row.coverageType, 'SELLER');
    assert.equal(row.itemCategory, 'CPE');
    assert.equal(row.deviceRecordId, 'w5-cdr-a');
    assert.equal(row.branchId, BRANCH);
    assert.equal(row.partyName, 'W5 Customer');
    assert.equal(row.sourceType, 'CUSTOMER_DEVICE');
    assert.equal(row.sourceId, 'w5-cdr-a');
    assert.equal(row.startDateAD, today);
    assert.equal(row.endDateAD, '2031-01-31', 'the exact contract date wins over the 12-month term');
    assert.equal(row.startBasis, 'ISSUE_DATE');
    assert.equal(row.isCurrent, true);
  });

  test('covered off writes no row; covered on with a blank date is refused', async () => {
    await stockUnit('W5-ASN-2', 'W5-ASN-2-PON');
    const off = await call('POST', '/api/customer-devices', {
      id: 'w5-cdr-off',
      customerId: 'w5-cust',
      customerName: 'W5 Customer',
      customerCode: 'CUS-W5',
      contactPhone: '9800000000',
      installationAddress: 'Kathmandu',
      branchId: BRANCH,
      productName: product.name,
      deviceSerial: 'W5-ASN-2',
      ponSerial: 'W5-ASN-2-PON',
      status: 'RENTAL',
      issuedDateAD: today,
      issuedDateBS: '2083-07-13',
      sellerWarrantyCovered: false,
    });
    assert.equal(off.status, 201, JSON.stringify(off.json));
    assert.deepEqual(await coverages('W5-ASN-2'), [], 'a declared-none unit gets no invented expiry');

    await stockUnit('W5-ASN-3', 'W5-ASN-3-PON');
    const blank = await call('POST', '/api/customer-devices', {
      id: 'w5-cdr-blank',
      customerId: 'w5-cust',
      customerName: 'W5 Customer',
      customerCode: 'CUS-W5',
      contactPhone: '9800000000',
      installationAddress: 'Kathmandu',
      branchId: BRANCH,
      productName: product.name,
      deviceSerial: 'W5-ASN-3',
      ponSerial: 'W5-ASN-3-PON',
      status: 'RENTAL',
      issuedDateAD: today,
      issuedDateBS: '2083-07-13',
      sellerWarrantyCovered: true,
    });
    assert.equal(blank.status, 400, JSON.stringify(blank.json));
    assert.match(String(blank.json?.message), /required, or turn the warranty off/i);
    assert.deepEqual(await coverages('W5-ASN-3'), [], 'a refused issue writes nothing');

    const cdr = await pool!.query("SELECT count(*)::int AS n FROM customer_device_records WHERE id = 'w5-cdr-blank'");
    assert.equal(Number(cdr.rows[0].n), 0, 'the refused assignment must not create a device row');
  });

  test('the register read returns the stored promise, not issued date + 12', async () => {
    const res = await call('GET', '/api/customer-devices/page?query=W5-ASN-1');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const row = (res.json?.data || []).find((entry: any) => entry.deviceSerial === 'W5-ASN-1');
    assert.ok(row, 'the register must return the assigned unit');
    assert.equal(row.sellerWarrantyStartDateAD, today);
    assert.equal(row.sellerWarrantyEndDateAD, '2031-01-31');
    assert.equal(row.sellerWarrantyState, 'VALID', 'the stored end date decides the state');
  });

  test('collection retires the current promise and keeps its history', async () => {
    const res = await call('PATCH', '/api/customer-devices/w5-cdr-a/status', { status: 'ROUTER_COLLECTED' });
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const rows = await coverages('W5-ASN-1');
    assert.equal(rows.length, 1, 'the period stays as history');
    assert.equal(rows[0].isCurrent, false, 'a collected unit is no longer promised');
  });

  test('an exchange retires the old unit and starts the replacement', async () => {
    await stockUnit('W5-EX-OLD', 'W5-EX-OLD-PON');
    await stockUnit('W5-EX-NEW', 'W5-EX-NEW-PON');
    const issued = await call('POST', '/api/customer-devices', {
      id: 'w5-cdr-ex',
      customerId: 'w5-cust',
      customerName: 'W5 Customer',
      customerCode: 'CUS-W5',
      contactPhone: '9800000000',
      installationAddress: 'Kathmandu',
      branchId: BRANCH,
      productName: product.name,
      deviceSerial: 'W5-EX-OLD',
      ponSerial: 'W5-EX-OLD-PON',
      status: 'RENTAL',
      issuedDateAD: today,
      issuedDateBS: '2083-07-13',
      sellerWarrantyEndDateAD: addCalendarMonths(today, 12),
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));

    const exchanged = await call('POST', '/api/customer-devices/exchange', {
      oldDeviceId: 'w5-cdr-ex',
      exchangeReason: 'Defective / Hardware Fault',
      oldDeviceAction: 'RESTOCK',
      newProductName: product.name,
      newDeviceSerial: 'W5-EX-NEW',
      newPonSerial: 'W5-EX-NEW-PON',
      branchId: BRANCH,
      sellerWarrantyEndDateAD: '2030-06-30',
    });
    assert.ok([200, 201].includes(exchanged.status), JSON.stringify(exchanged.json));

    const oldRows = await coverages('W5-EX-OLD');
    assert.equal(oldRows.filter((row) => row.isCurrent).length, 0, 'the replaced unit stops being current');

    const [newRow] = await coverages('W5-EX-NEW');
    assert.ok(newRow, 'the replacement must carry its own promise');
    assert.equal(newRow.coverageType, 'SELLER');
    assert.equal(newRow.sourceType, 'CUSTOMER_EXCHANGE');
    assert.equal(newRow.endDateAD, '2030-06-30');
    assert.equal(newRow.isCurrent, true);
    assert.equal(newRow.partyName, 'W5 Customer');
  });

  test('a retail sale writes one row per sold serial, and a reversal retires it', async () => {
    await stockUnit('W5-SALE-1', 'W5-SALE-1-PON');
    const sale = await call('POST', '/api/stock-operations', {
      id: 'w5-op-sale',
      type: 'STOCK_OUT',
      branchId: BRANCH,
      customerId: 'w5-cust',
      customerName: 'W5 Customer',
      reason: 'W5 retail sale',
      status: 'LOGGED',
      items: [{
        productId: PRODUCT,
        productName: product.name,
        sku: product.sku,
        quantity: 1,
        unitCost: 100,
        deviceSerials: [{ deviceSerial: 'W5-SALE-1', ponSerial: 'W5-SALE-1-PON' }],
        sellerWarrantyEndDateAD: '2029-12-31',
      }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.json));

    const [row] = await coverages('W5-SALE-1');
    assert.ok(row, 'the sold serial must carry a SELLER coverage');
    assert.equal(row.itemCategory, 'SOLD_PRODUCT');
    assert.equal(row.sourceType, 'STOCK_OPERATION');
    assert.equal(row.sourceId, 'w5-op-sale');
    assert.equal(row.endDateAD, '2029-12-31');
    assert.equal(row.startBasis, 'SALE_DATE');
    assert.equal(row.isCurrent, true);

    const reversed = await call('POST', '/api/stock-operations/w5-op-sale/reverse-stock-out', {
      reason: 'W5 sale reversed in the test',
    });
    assert.equal(reversed.status, 200, JSON.stringify(reversed.json));

    const [after] = await coverages('W5-SALE-1');
    assert.equal(after.isCurrent, false, 'a reversed sale no longer promises a warranty');
  });

  test('a sales invoice captures its own source, and cancelling retires it', async () => {
    await stockUnit('W5-SINV-1', 'W5-SINV-1-PON');
    const inv = await call('POST', '/api/sales-invoices', {
      id: 'w5-si-1',
      invoiceNumber: 'W5-INV-1',
      customerName: 'W5 Customer',
      branchId: BRANCH,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      items: [{
        productId: PRODUCT,
        productName: product.name,
        sku: product.sku,
        unit: 'Pcs',
        quantity: 1,
        unitPrice: 150,
        discount: 0,
        taxRate: 0,
        isTaxExempt: true,
        subtotal: 150,
        taxAmount: 0,
        total: 150,
        deviceSerials: [{ deviceSerial: 'W5-SINV-1', ponSerial: 'W5-SINV-1-PON' }],
        sellerWarrantyEndDateAD: '2030-12-31',
      }],
    });
    assert.equal(inv.status, 201, JSON.stringify(inv.json));

    const [row] = await coverages('W5-SINV-1');
    assert.ok(row, 'the sold serial must carry a SELLER coverage');
    assert.equal(row.sourceType, 'SALES_INVOICE');
    assert.equal(row.sourceId, 'w5-si-1');
    assert.equal(row.endDateAD, '2030-12-31');

    const cancelled = await call('POST', '/api/sales-invoices/w5-si-1/cancel', { reason: 'W5 cancel' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));

    const [after] = await coverages('W5-SINV-1');
    assert.equal(after.isCurrent, false, 'a cancelled invoice no longer promises a warranty');
  });
});
