/**
 * SER-2 / decision D3 — the serial-register reconcile is an explicit
 * SUPER_ADMIN action, not a boot side effect.
 *
 * WHAT IS PINNED
 *   1. The pass converges the legacy sources: a purchase-invoice serial lands
 *      IN_STOCK/PURCHASE, a customer-device serial lands CUSTOMER_ASSIGNED, and
 *      a damaged stock operation upgrades the same serial to DAMAGED.
 *   2. Running it again inserts nothing new and duplicates no serial.
 *   3. A terminal manual status (RETURNED) is never downgraded by a later pass.
 *   4. `dbBoot` no longer calls the backfill — it only logs a pointer, and the
 *      boot module does not import the service. (This is the acceptance item
 *      "a fresh boot does not silently create serial rows"; the pass itself is
 *      covered behaviourally above, and boot's own path cannot insert rows
 *      without calling it.)
 *   5. Over real HTTP the new endpoint is 401 without a token, 403 for a
 *      non-SUPER_ADMIN role, and 200 for SUPER_ADMIN.
 *
 * Fixtures use the `sbr-` / `SBR-` prefixes (node --test runs files in
 * parallel, so every file owns a unique prefix). The database cases skip when
 * PostgreSQL is unreachable; the boot guard needs no database.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { backfillSerialLog } from '../server/src/services/serialBackfill.service';

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

const BRANCH = 'sbr-branch';
const PRODUCT = 'sbr-prod';
const PI_SERIAL = 'SBR-PI-1';
const DMG_SERIAL = 'SBR-DMG-1';
const CDR_SERIAL = 'SBR-CDR-1';

describe('SER-2 boot retirement (source guard)', () => {
  const root = process.cwd();
  const boot = readFileSync(path.join(root, 'server/src/boot/dbBoot.ts'), 'utf8');
  const routes = readFileSync(path.join(root, 'server/src/routes/admin.routes.ts'), 'utf8');

  test('boot does not call the serial backfill and only logs a pointer', () => {
    assert.doesNotMatch(boot, /await\s+backfillSerialLog\s*\(/, 'boot must not converge the register');
    assert.doesNotMatch(boot, /serialBackfill\.service/, 'boot must not import the backfill service');
    assert.match(boot, /boot does not backfill/, 'the boot log must tell the operator where the action lives');
  });

  test('the reconcile is exposed as a SUPER_ADMIN maintenance route', () => {
    const line = routes
      .split(/\r?\n/)
      .find((candidate) => candidate.includes('/api/admin/recalculate/serial-register'));
    assert.ok(line, 'the serial-register route must be registered');
    assert.match(line!, /requireRole\('SUPER_ADMIN'\)/, 'the route must be SUPER_ADMIN-gated');
  });
});

describe('SER-2 on-demand serial-register reconcile', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const acctToken = issueAuthToken({
    id: 'sbr-acct', email: 'sbr-acct@example.com', name: 'SBR Acct',
    role: 'ACCOUNTANT', branchId: 'WH001', allowedBranchIds: ['WH001'], canSwitchUser: false,
  } as any);
  const superToken = issueAuthToken({
    id: 'sbr-super', email: 'sbr-super@example.com', name: 'SBR Super',
    role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false,
  } as any);

  before(async () => {
    if (!dbReachable) return;
    await cleanup();
    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES ($1, 'SBRB', 'SBR Branch', 'T')",
      [BRANCH]
    );
    await pool!.query(
      "INSERT INTO products (id, sku, name, category, product_group) VALUES ($1, 'SBRSKU', 'SBR ONU', 'Test', 'Product Item')",
      [PRODUCT]
    );
    // One invoice serial, plus a unit that a DAMAGE operation will quarantine.
    await pool!.query(
      `INSERT INTO purchase_invoices (id, invoice_number, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, items)
       VALUES ('sbr-pi', 'SBR-INV-1', 'SBR Supplier', $1, '2026-09-01', '2083-05-16 BS', $2::jsonb)`,
      [BRANCH, JSON.stringify([
        { productId: PRODUCT, productName: 'SBR ONU', quantity: 2, deviceSerials: [{ deviceSerial: PI_SERIAL, ponSerial: 'SBR-PON-1' }, { deviceSerial: DMG_SERIAL }] },
      ])]
    );
    await pool!.query(
      `INSERT INTO stock_operations (id, reference_number, type, branch_id, branch_name, product_id, quantity_changed, reason, date_ad, date_bs, status, items)
       VALUES ('sbr-op', 'SBR-OP-1', 'DAMAGE', $1, 'SBR Branch', $2, 1, 'sbr fixture', '2026-09-02', '2083-05-17 BS', 'LOGGED', $3::jsonb)`,
      [BRANCH, PRODUCT, JSON.stringify([{ productId: PRODUCT, productName: 'SBR ONU', quantity: 1, deviceSerials: [{ deviceSerial: DMG_SERIAL }] }])]
    );
    // A customer assignment — the highest-priority source.
    await pool!.query(
      `INSERT INTO customer_device_records (id, customer_id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, status, issued_date_ad, issued_date_bs)
       VALUES ('sbr-cdr', 'sbr-cust', 'SBR Customer', 'SBRC', $1, 'SBR ONU', $2, 'SBR-PON-3', 'ACTIVE', '2026-09-03', '2083-05-18 BS')`,
      [BRANCH, CDR_SERIAL]
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
    if (pool && dbReachable) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup() {
    if (!pool) return;
    await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'SBR-%'");
    await pool.query("DELETE FROM customer_device_records WHERE id = 'sbr-cdr'");
    await pool.query("DELETE FROM stock_operations WHERE id = 'sbr-op'");
    await pool.query("DELETE FROM purchase_invoices WHERE id = 'sbr-pi'");
    await pool.query("DELETE FROM products WHERE id = 'sbr-prod'");
    await pool.query("DELETE FROM branches WHERE id = 'sbr-branch'");
  }

  async function serialRow(deviceSerial: string) {
    const r = await pool!.query(
      `SELECT status, source_type AS "sourceType", branch_id AS "branchId", customer_name AS "customerName", history_json AS "historyJson"
       FROM serial_log WHERE device_serial = $1`,
      [deviceSerial]
    );
    return r.rows[0];
  }

  async function serialCount(deviceSerial: string) {
    const r = await pool!.query('SELECT count(*)::int AS n FROM serial_log WHERE device_serial = $1', [deviceSerial]);
    return Number(r.rows[0].n);
  }

  async function post(path: string, token?: string) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is a finding */ }
    return { status: res.status, json };
  }

  test('converges invoice, damaged-operation and customer-device serials', { skip: skipNoDb }, async () => {
    const result = await backfillSerialLog(pool!);
    assert.ok(result.converged >= 3, `expected the three fixtures to converge, got ${result.converged}`);

    const invoice = await serialRow(PI_SERIAL);
    assert.equal(invoice?.status, 'IN_STOCK');
    assert.equal(invoice?.sourceType, 'PURCHASE');
    assert.equal(invoice?.branchId, BRANCH);
    assert.match(String(invoice?.historyJson), /Auto backfill/);

    const damaged = await serialRow(DMG_SERIAL);
    assert.equal(damaged?.status, 'DAMAGED', 'a damaged operation quarantines the unit');
    assert.equal(damaged?.sourceType, 'STOCK_OP');

    const assigned = await serialRow(CDR_SERIAL);
    assert.equal(assigned?.status, 'CUSTOMER_ASSIGNED');
    assert.equal(assigned?.sourceType, 'CUSTOMER_ASSIGN');
    assert.equal(assigned?.customerName, 'SBR Customer');
  });

  test('re-running inserts nothing and duplicates no serial', { skip: skipNoDb }, async () => {
    const before = {
      invoice: await serialRow(PI_SERIAL),
      damaged: await serialRow(DMG_SERIAL),
      assigned: await serialRow(CDR_SERIAL),
    };
    await backfillSerialLog(pool!);
    assert.equal(await serialCount(PI_SERIAL), 1);
    assert.equal(await serialCount(DMG_SERIAL), 1);
    assert.equal(await serialCount(CDR_SERIAL), 1);
    const after = {
      invoice: await serialRow(PI_SERIAL),
      damaged: await serialRow(DMG_SERIAL),
      assigned: await serialRow(CDR_SERIAL),
    };
    assert.deepEqual(after, before, 'a converged register must be stable');
  });

  test('a terminal manual status is never downgraded', { skip: skipNoDb }, async () => {
    await pool!.query("UPDATE serial_log SET status = 'RETURNED' WHERE device_serial = $1", [PI_SERIAL]);
    await backfillSerialLog(pool!);
    assert.equal((await serialRow(PI_SERIAL))?.status, 'RETURNED', 'RETURNED is manual and must survive a pass');
  });

  test('401 without a token, 403 for a non-SUPER_ADMIN role, 200 for SUPER_ADMIN', { skip: skipNoDb }, async () => {
    const anonymous = await post('/api/admin/recalculate/serial-register');
    assert.equal(anonymous.status, 401);

    const forbidden = await post('/api/admin/recalculate/serial-register', acctToken);
    assert.equal(forbidden.status, 403, 'only SUPER_ADMIN may converge the register');
    assert.match(String(forbidden.json?.message || ''), /Forbidden/i);

    const allowed = await post('/api/admin/recalculate/serial-register', superToken);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
    assert.equal(typeof allowed.json?.inserted, 'number');
    assert.equal(typeof allowed.json?.upgraded, 'number');
    assert.match(String(allowed.json?.message || ''), /serial/);
  });
});
