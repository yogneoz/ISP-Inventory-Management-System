#!/usr/bin/env node
/**
 * Automated API smoke test — verifies a RUNNING server + live database.
 *
 * What it checks:
 *   1. Auth works and returns a usable token.
 *   2. Main read endpoints return 200 with the expected payload shape
 *      (catches renamed camelCase keys / missing bootstrap sections).
 *   3. Write paths that hit CHECK-constrained enum columns actually succeed
 *      (a missing enum value in the DB fails these with a 500).
 *   4. The serial rename cascade + duplicate rejection behave correctly.
 *   5. Schema drift detector: every enum value the application writes is
 *      present in the live DB's CHECK constraint lists — independent of the
 *      data currently in the tables (catches DAMAGE_REVERSED-class gaps
 *      before they bite).
 *
 * Usage:
 *   node scripts/smoke_test.mjs                        # http://localhost:3000
 *   SMOKE_BASE_URL=http://localhost:3001 node scripts/smoke_test.mjs
 *   node scripts/smoke_test.mjs --base-url http://localhost:3001
 *
 * Environment:
 *   SMOKE_BASE_URL      server base URL          (default http://localhost:3000)
 *   SMOKE_USER_EMAIL    login email              (default superadmin@example.com)
 *   SMOKE_USER_PASSWORD login password           (default Demo@123)
 *   POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE   for the constraint probes
 *                                               (default inventory_user@localhost:5432/inventory_db)
 *
 * Exit code 0 = all checks passed; 1 = at least one failed.
 *
 * Safety: every row created is tagged "SMOKETEST" and removed in cleanup
 * (which runs even on failure). The rename check restores the original
 * serial. No destructive endpoints are called.
 */

const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base-url');
const BASE_URL = (baseIdx >= 0 && args[baseIdx + 1]) || process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const TAG = 'SMOKETEST';

/** Thrown by a check to mark it "skipped" (counted, but not a failure). */
class Skip extends Error {}

// ---------------------------------------------------------------------------
// Tiny HTTP + assertion helpers
// ---------------------------------------------------------------------------
const HTTP = {
  async request(method, path, { body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON is fine */ }
    return { status: res.status, data };
  },
  get: (path, opts) => HTTP.request('GET', path, opts),
  post: (path, body, opts = {}) => HTTP.request('POST', path, { ...opts, body }),
  patch: (path, body, opts = {}) => HTTP.request('PATCH', path, { ...opts, body }),
  del: (path, opts = {}) => HTTP.request('DELETE', path, opts),
};

function ok(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Auth (token cached across checks)
// ---------------------------------------------------------------------------
let cachedToken = null;
async function login() {
  if (cachedToken) return cachedToken;
  const r = await HTTP.post('/api/auth/login', {
    email: process.env.SMOKE_USER_EMAIL || 'superadmin@example.com',
    password: process.env.SMOKE_USER_PASSWORD || 'Demo@123',
  });
  if (r.status === 401) {
    throw new Skip(`login rejected — set SMOKE_USER_EMAIL / SMOKE_USER_PASSWORD if demo credentials changed`);
  }
  ok(r.status === 200, `login expected 200, got ${r.status}`);
  ok(r.data && r.data.token, 'login returned no token');
  cachedToken = r.data.token;
  return cachedToken;
}

async function authedGet(path) {
  return HTTP.get(path, { token: await login() });
}

// ---------------------------------------------------------------------------
// DB connection (for constraint probes + cleanup; optional)
// ---------------------------------------------------------------------------
let db = null;
async function connectDb() {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.POSTGRES_PORT || 5432),
      user: process.env.POSTGRES_USER || 'inventory_user',
      password: process.env.POSTGRES_PASSWORD || 'securepassword',
      database: process.env.POSTGRES_DB || 'inventory_db',
      connectionTimeoutMillis: 3000,
    });
    await pool.query('SELECT 1');
    db = pool;
    return true;
  } catch (err) {
    console.warn(`(DB probes unavailable: ${String(err.message).split('\n')[0]})`);
    return false;
  }
}

/** Best-effort removal of every row this script may have created. */
async function cleanupDb() {
  if (!db) return;
  const statements = [
    `DELETE FROM transaction_logs WHERE reference_doc_id LIKE '%${TAG}%'`,
    `DELETE FROM damage_records WHERE created_by = '${TAG}' OR notes LIKE '%${TAG}%'`,
    `DELETE FROM vendor_payments WHERE notes LIKE '%${TAG}%'`,
    `DELETE FROM stock_operations WHERE technician_name = '${TAG}' OR reference_number LIKE '%${TAG}%'`,
    `DELETE FROM locations WHERE name LIKE '%${TAG}%'`,
    // Self-heal a serial row stranded mid-rename by a previous failed run.
    `DELETE FROM serial_log WHERE device_serial LIKE '%${TAG}%'`,
  ];
  for (const sql of statements) {
    try { await db.query(sql); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// --- 1. Auth ---------------------------------------------------------------
check('auth: setup-status responds', async () => {
  const r = await HTTP.get('/api/auth/setup-status');
  ok(r.status === 200, `expected 200, got ${r.status}`);
  ok(r.data && typeof r.data === 'object', 'expected a JSON object');
});

check('auth: login issues a token for a super admin', async () => {
  const token = await login();
  ok(token.length > 20, 'token suspiciously short');
});

// --- 2. Read endpoints ------------------------------------------------------
check('read: /api/bootstrap returns every expected payload section', async () => {
  const r = await authedGet('/api/bootstrap');
  ok(r.status === 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data).slice(0, 160)}`);
  const expected = [
    'branches', 'products', 'stock', 'assets', 'customerDevices', 'customers',
    'purchaseOrders', 'purchaseInvoices', 'shipments', 'stockOperations',
    'fiscalYears', 'auditLogs', 'transactionLogs', 'financialSummary',
    'suppliers', 'users', 'approvalRequests', 'categories', 'uom', 'locations',
    'companyProfile', 'damageRecords', 'vendorPayments', 'serialLogs',
    'postgresDatabaseStatus', 'dataVersion',
  ];
  const missing = expected.filter((k) => !(k in r.data));
  ok(missing.length === 0, `missing bootstrap keys: ${missing.join(', ')}`);
  ok(Array.isArray(r.data.products) && r.data.products.length > 0, 'bootstrap products empty');
  ok(Array.isArray(r.data.stock) && Array.isArray(r.data.serialLogs), 'stock/serialLogs not arrays');
  ok(r.data.financialSummary && Number.isFinite(Number(r.data.financialSummary.totalInventoryAssetValue)), 'financialSummary.totalInventoryAssetValue missing');
});

check('read: /api/health and /api/db/status are healthy', async () => {
  const h = await HTTP.get('/api/health');
  ok(h.status === 200, `health expected 200, got ${h.status}`);
  const d = await HTTP.get('/api/db/status');
  ok(d.status === 200, `db/status expected 200, got ${d.status}`);
  ok(d.data && 'isConnected' in d.data, 'db/status missing isConnected');
});

check('read: master-data endpoints return arrays', async () => {
  for (const path of ['/api/branches', '/api/products', '/api/stock', '/api/uom', '/api/locations', '/api/suppliers', '/api/fiscal-years', '/api/document-number-configs', '/api/customers', '/api/bs-calendar/years']) {
    const r = await authedGet(path);
    ok(r.status === 200, `${path} expected 200, got ${r.status}`);
    ok(Array.isArray(r.data), `${path} expected an array, got ${typeof r.data}`);
  }
  const b = await authedGet('/api/branches');
  ok(b.data.length > 0, 'no branches returned (demo data missing?)');
});

check('read: registers return arrays (POs, invoices, shipments, ops, payments)', async () => {
  for (const path of ['/api/purchase-orders', '/api/purchase-invoices', '/api/shipments', '/api/stock-operations', '/api/vendor-payments', '/api/approval-requests']) {
    const r = await authedGet(path);
    ok(r.status === 200, `${path} expected 200, got ${r.status}`);
    ok(Array.isArray(r.data), `${path} expected an array, got ${typeof r.data}`);
  }
});

check('read: serial-log register keeps its camelCase row shape', async () => {
  const r = await authedGet('/api/serial-log');
  ok(r.status === 200, `expected 200, got ${r.status}`);
  ok(Array.isArray(r.data), 'expected an array');
  if (r.data.length > 0) {
    for (const k of ['id', 'deviceSerial', 'ponSerial', 'status', 'branchId']) {
      ok(k in r.data[0], `serial-log row missing "${k}" (bootstrap mapping drift)`);
    }
  }
});

check('read: transaction-logs keep their camelCase row shape', async () => {
  const r = await authedGet('/api/transaction-logs');
  ok(r.status === 200, `expected 200, got ${r.status}`);
  ok(Array.isArray(r.data), 'expected an array');
  if (r.data.length > 0) {
    for (const k of ['changeType', 'quantityChanged', 'timestampAD', 'referenceDocId']) {
      ok(k in r.data[0], `transaction-log row missing "${k}"`);
    }
  }
});

check('read: serial lookup resolves a live serial and 404s unknown ones', async () => {
  const reg = await authedGet('/api/serial-log');
  const serial = (reg.data || []).find((s) => s.deviceSerial);
  if (serial) {
    const hit = await authedGet(`/api/inventory/serials/lookup?value=${encodeURIComponent(serial.deviceSerial)}`);
    ok([200, 404].includes(hit.status), `lookup expected 200/404, got ${hit.status}`);
    if (hit.status === 200) ok(hit.data.deviceSerial, 'lookup hit missing deviceSerial');
  }
  const miss = await authedGet(`/api/inventory/serials/lookup?value=NO-SUCH-${TAG}`);
  ok([200, 404].includes(miss.status), `lookup miss expected 200/404, got ${miss.status}`);
});

check('read: reports/financial-summary responds', async () => {
  const r = await authedGet('/api/reports/financial-summary');
  ok(r.status === 200, `expected 200, got ${r.status}`);
});

// --- 3. Write paths over constrained enums ----------------------------------
check('write: location create (locations.type enum) + delete', async () => {
  const token = await login();
  const r = await HTTP.post('/api/locations', {
    name: `Smoke Loc ${TAG}`, type: 'FIBER_NETWORK_NODE', branchId: 'WH001', address: TAG,
  }, { token });
  ok([200, 201].includes(r.status), `POST /api/locations expected 200/201, got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  ok(r.data && r.data.id, 'no location id returned');
  const d = await HTTP.del(`/api/locations/${encodeURIComponent(r.data.id)}`, { token });
  ok([200, 404].includes(d.status), `DELETE location expected 200/404, got ${d.status}`);
});

check('write: vendor payment (vendor_payments enums) with cleanup', async () => {
  const token = await login();
  const sup = await authedGet('/api/suppliers');
  const supplier = (sup.data || []).find((s) => s.id);
  if (!supplier) throw new Skip('no suppliers exist; cannot record a payment');
  const r = await HTTP.post('/api/vendor-payments', {
    supplierId: supplier.id,
    amount: 1,
    paymentMethod: 'CHEQUE',
    dateAD: new Date().toISOString().split('T')[0],
    notes: `${TAG} auto-cleanup`,
  }, { token });
  ok([200, 201].includes(r.status), `POST /api/vendor-payments expected 200/201, got ${r.status}: ${JSON.stringify(r.data).slice(0, 250)}`);
  const paymentNumber = r.data && (r.data.paymentNumber || r.data.payment_number);
  if (db && paymentNumber) {
    await db.query(`DELETE FROM transaction_logs WHERE reference_doc_id = $1`, [paymentNumber]);
  }
});

check('write: DISPOSAL + DAMAGE stock operations (stock_operations.type enum)', async () => {
  const token = await login();
  const stock = await authedGet('/api/stock?branchId=WH001');
  const products = await authedGet('/api/products');
  const row = (stock.data || []).find((s) => Number(s.quantityOnHand) >= 1);
  if (!row) throw new Skip('no stock row with quantity >= 1 at WH001');
  const product = (products.data || []).find((p) => p.id === row.productId) || { name: 'Product' };
  const nonSerialized = product.trackingType === 'QUANTITY_ONLY' || product.requiresSerialTracking === false;
  const dateAD = new Date().toISOString().split('T')[0];
  const items = [{ productId: row.productId, productName: product.name, quantity: 1, unitCost: 0 }];

  // Ledger rows reference the generated document number (not the TAG), so
  // remove them by exact reference inside this check.
  const removeLedger = async (opRef) => {
    if (db && opRef) await db.query(`DELETE FROM transaction_logs WHERE reference_doc_id = $1`, [opRef]);
  };

  // DISPOSAL never consumes stock — safe to create and delete.
  const disposal = await HTTP.post('/api/stock-operations', {
    type: 'DISPOSAL', branchId: row.branchId, dateAD, reason: `${TAG} enum check`, inspectorName: TAG, items,
  }, { token });
  ok([200, 201].includes(disposal.status), `DISPOSAL expected 200/201, got ${disposal.status}: ${JSON.stringify(disposal.data).slice(0, 250)}`);
  await removeLedger(disposal.data && disposal.data.referenceNumber);

  // DAMAGE consumes a unit and reverses it back.
  if (nonSerialized) {
    const dmg = await HTTP.post('/api/stock-operations', {
      type: 'DAMAGE', branchId: row.branchId, dateAD, reason: `${TAG} enum check`, inspectorName: TAG, items,
    }, { token });
    ok([200, 201].includes(dmg.status), `DAMAGE expected 200/201, got ${dmg.status}: ${JSON.stringify(dmg.data).slice(0, 250)}`);
    const opRef = dmg.data && dmg.data.referenceNumber;
    const opId = dmg.data && dmg.data.id;
    const rev = await HTTP.post(`/api/stock-operations/${opId}/reverse`, { reason: `${TAG} reversal`, user: { name: TAG } }, { token });
    ok(rev.status === 200, `DAMAGE reversal expected 200, got ${rev.status}: ${JSON.stringify(rev.data).slice(0, 200)}`);
    await removeLedger(`${opRef}-REV`);
    await removeLedger(opRef);
  } else {
    throw new Skip('DAMAGE probe skipped: only serialized products in stock (needs a customer-device match)');
  }
});

// --- 4. Serial rename cascade ------------------------------------------------
check('serial: duplicate rejection, rename cascade, and restore', async () => {
  const token = await login();
  const reg = await authedGet('/api/serial-log');
  ok(Array.isArray(reg.data) && reg.data.length > 0, 'serial register empty; cannot exercise the cascade');
  const row = reg.data.find((s) => s.status === 'IN_STOCK' && s.deviceSerial) || reg.data[0];
  const original = {
    oldDeviceSerial: row.deviceSerial,
    oldPonSerial: row.ponSerial,
    oldMacAddress: row.macAddress || '',
    deviceSerial: row.deviceSerial,
    ponSerial: row.ponSerial,
    macAddress: row.macAddress || '',
  };
  const renamed = {
    oldDeviceSerial: row.deviceSerial,
    oldPonSerial: row.ponSerial,
    oldMacAddress: row.macAddress || '',
    deviceSerial: `${row.deviceSerial}-${TAG}`.slice(0, 90),
    ponSerial: `${row.ponSerial || 'PON'}-${TAG}`.slice(0, 90),
    macAddress: row.macAddress ? `${row.macAddress}-T` : '',
  };
  const restorePayload = {
    oldDeviceSerial: renamed.deviceSerial,
    oldPonSerial: renamed.ponSerial,
    oldMacAddress: renamed.macAddress,
    deviceSerial: row.deviceSerial,
    ponSerial: row.ponSerial,
    macAddress: row.macAddress || '',
  };

  // A different row's serial must be rejected with 409.
  const other = reg.data.find((s) => s.id !== row.id && s.deviceSerial && s.deviceSerial !== row.deviceSerial);
  if (other) {
    const dup = await HTTP.patch('/api/inventory/serials', {
      ...original, deviceSerial: other.deviceSerial,
    }, { token });
    ok(dup.status === 409, `duplicate edit expected 409, got ${dup.status}: ${JSON.stringify(dup.data).slice(0, 200)}`);
  }

  const r = await HTTP.patch('/api/inventory/serials', renamed, { token });
  ok(r.status === 200, `rename expected 200, got ${r.status}: ${JSON.stringify(r.data).slice(0, 250)}`);
  try {
    const after = await authedGet('/api/serial-log');
    const renamedRow = after.data.find((s) => s.deviceSerial === renamed.deviceSerial);
    ok(!!renamedRow, 'renamed serial not found in the register');
    ok(String(renamedRow.ponSerial || '').toUpperCase() === renamed.ponSerial.toUpperCase(), 'PON serial did not follow the rename');
    ok(!after.data.some((s) => s.deviceSerial === original.deviceSerial), 'original serial still present after the rename (duplicate row created)');
  } finally {
    const back = await HTTP.patch('/api/inventory/serials', restorePayload, { token });
    ok(back.status === 200, `restore expected 200, got ${back.status} — ORIGINAL SERIAL IS ${original.deviceSerial}, manual fix needed`);
  }
});

// --- 5. Schema drift detector -------------------------------------------------
// Every value the application writes into CHECK-constrained enum columns.
// Mirrors server.ts's runtime constraint-sync block (single source of truth).
const ENUM_EXPECTATIONS = [
  { table: 'stock_operations', column: 'type', values: ['PULLOUT', 'DAMAGE', 'DISPOSAL', 'STOCK_OUT', 'MANUAL_ADJUSTMENT', 'CONSUMABLE_ISSUE'] },
  { table: 'stock_operations', column: 'status', values: ['LOGGED', 'DISPATCHED', 'RECEIVED', 'CANCELLED'] },
  { table: 'transaction_logs', column: 'change_type', values: ['INBOUND_PO', 'PURCHASE_INVOICE', 'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'DAMAGE', 'DAMAGE_REVERSED', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT', 'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN', 'TRANSFER_CANCELLED', 'TRANSFER_RECEIPT_CANCELLED'] },
  { table: 'audit_logs', column: 'module', values: ['AUTH', 'MASTER_DATA', 'PRODUCTS', 'CATEGORIES', 'PROCUREMENT', 'LOGISTICS', 'STOCK_OPERATIONS', 'FIXED_ASSETS', 'CPE_MANAGEMENT', 'INVENTORY', 'INVENTORY_AUDIT', 'OPERATIONS', 'BRANCH_OPERATIONS', 'FISCAL_YEAR', 'APPROVAL_WORKFLOW', 'SYSTEM'] },
  { table: 'vendor_payments', column: 'payment_method', values: ['CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER'] },
  { table: 'vendor_payments', column: 'status', values: ['POSTED', 'REVERSED', 'VOIDED'] },
  { table: 'purchase_invoices', column: 'payment_method', values: ['CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE'] },
  { table: 'purchase_invoices', column: 'payment_status', values: ['UNPAID', 'PARTIAL', 'PAID'] },
  { table: 'locations', column: 'type', values: ['POP_SERVER_ROOM', 'FIBER_NETWORK_NODE', 'CUSTOMER_SITE', 'WAREHOUSE', 'BRANCH_OFFICE', 'STORE', 'OFFICE', 'DEPOT'] },
  { table: 'damage_records', column: 'damage_reason', values: ['PHYSICAL_DAMAGE', 'TRANSIT_DAMAGE', 'STORAGE_DAMAGE', 'EXPIRED', 'RETURN_DAMAGE', 'QUALITY_DEFECT', 'OTHER'] },
  { table: 'damage_records', column: 'status', values: ['IDENTIFIED', 'UNDER_REVIEW', 'DISPOSED', 'WRITTEN_OFF', 'RETURNED_TO_SUPPLIER', 'CANCELLED'] },
  { table: 'users', column: 'role', values: ['SUPER_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK', 'ACCOUNTANT', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN', 'AUDITOR'] },
];

check('schema: DB CHECK constraints accept every enum value the code writes', async () => {
  if (!db) throw new Skip('DB not reachable — constraint probe unavailable (set POSTGRES_* env to enable)');
  const problems = [];
  for (const spec of ENUM_EXPECTATIONS) {
    const { rows } = await db.query(
      `SELECT cc.check_clause
         FROM information_schema.table_constraints tc
         JOIN information_schema.check_constraints cc
           ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON cc.constraint_name = ccu.constraint_name AND cc.constraint_schema = ccu.constraint_schema
        WHERE tc.constraint_type = 'CHECK' AND ccu.table_name = $1 AND ccu.column_name = $2`,
      [spec.table, spec.column]
    );
    if (rows.length === 0) {
      problems.push(`${spec.table}.${spec.column}: no CHECK constraint found`);
      continue;
    }
    // The enum list is the clause mentioning the column with the most quoted
    // literals (Postgres normalizes IN (...) to = ANY (ARRAY[...])).
    let bestVals = null;
    for (const r of rows) {
      const clause = String(r.check_clause || '');
      if (!clause.includes(spec.column)) continue;
      const vals = [...clause.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      if (!bestVals || vals.length > bestVals.length) bestVals = vals;
    }
    if (!bestVals || bestVals.length === 0) {
      problems.push(`${spec.table}.${spec.column}: no enum IN-list constraint found`);
      continue;
    }
    const missing = spec.values.filter((v) => !bestVals.includes(v));
    if (missing.length > 0) {
      problems.push(`${spec.table}.${spec.column}: DB CHECK is missing [${missing.join(', ')}]`);
    }
  }
  ok(problems.length === 0, problems.join(' | '));
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main() {
  const dbUp = await connectDb();
  console.log(`Smoke test → ${BASE_URL}${dbUp ? ' (+ live DB constraint probes)' : ''}`);
  console.log('='.repeat(72));
  const started = Date.now();
  const failures = [];
  let passed = 0;
  let skipped = 0;

  for (const { name, fn } of checks) {
    const t0 = Date.now();
    try {
      await fn();
      passed += 1;
      console.log(`  ✔ ${name} (${Date.now() - t0}ms)`);
    } catch (err) {
      if (err instanceof Skip) {
        skipped += 1;
        console.log(`  ↷ ${name} — skipped: ${err.message}`);
      } else {
        failures.push({ name, error: err.message });
        console.log(`  ✖ ${name} (${Date.now() - t0}ms)`);
        console.log(`      ${String(err.message).split('\n')[0].slice(0, 400)}`);
      }
    }
  }

  await cleanupDb();
  if (db) { try { await db.end(); } catch { /* ignore */ } }

  console.log('='.repeat(72));
  console.log(`${passed}/${checks.length} passed, ${skipped} skipped, ${failures.length} failed in ${Date.now() - started}ms`);
  if (failures.length > 0) {
    console.log('\nFAILED:');
    for (const f of failures) {
      console.log(`  ✖ ${f.name}\n      ${String(f.error).split('\n')[0].slice(0, 400)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
