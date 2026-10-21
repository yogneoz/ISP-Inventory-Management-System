/**
 * Refused replacements must leave a trail (real PostgreSQL, HTTP layer).
 *
 * PROVES that a replacement that is refused — whether the exchange dialogs
 * refuse it locally (they resolve the unit first) or the server's gate/duplicate
 * check refuses the submitted attempt — writes exactly one audit row naming:
 *  - the serial the operator tried to use,
 *  - the register's ACTUAL status and branch (the server re-resolves the unit;
 *    it never records the client's description of it),
 *  - the actor (audit_logs.user_email / user_name),
 *  - and the reason it was refused.
 *
 * Also proves the report endpoint is limited to the exchange audience: an AUDITOR
 * gets 403 and writes nothing, so the trail cannot be polluted by roles that
 * cannot exchange in the first place.
 *
 * Fixtures use an "rfa-" id prefix and "RFA-" serials, removed in after().
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
  setPermissionMatrix,
} from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

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

const BRANCH = 'rfa-branch';
const TAKEN_SERIAL = 'RFA-TAKEN';
const OLD_SERIAL = 'RFA-OLD';
const UNKNOWN_SERIAL = 'RFA-NEVER-RECEIVED';
const AUDITOR_SERIAL = 'RFA-AUDITOR-ONLY';
const OTHER_BRANCH = 'rfa-other-branch';

const TECH_EMAIL = 'rfa-tech@example.com';
const ADMIN_EMAIL = 'rfa-admin@example.com';
const AUDITOR_EMAIL = 'rfa-auditor@example.com';

const user = (id: string, email: string, role: string) => ({
  id, email, name: `RFA ${role}`, role, branchId: BRANCH,
  allowedBranchIds: [BRANCH], canSwitchUser: false,
}) as any;

const TECH = user('rfa-tech', TECH_EMAIL, 'FIELD_TECHNICIAN');
const ADMIN = user('rfa-admin', ADMIN_EMAIL, 'SUPER_ADMIN');
const AUDITOR = user('rfa-auditor', AUDITOR_EMAIL, 'AUDITOR');
// An auditor of a DIFFERENT branch: allowed on the audit screen, but must not
// see this branch's unit history.
const OTHER_AUDITOR = {
  id: 'rfa-other-auditor',
  email: 'rfa-other@example.com',
  name: 'RFA Other Auditor',
  role: 'AUDITOR',
  branchId: OTHER_BRANCH,
  allowedBranchIds: [OTHER_BRANCH],
  canSwitchUser: false,
} as any;

describe('refused replacements are audited with the register\'s own facts', () => {
  let pool = probePool!;
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const techToken = issueAuthToken(TECH);
  const adminToken = issueAuthToken(ADMIN);
  const auditorToken = issueAuthToken(AUDITOR);
  const otherBranchToken = issueAuthToken(OTHER_AUDITOR);
  let origCdr: any[] = [];
  let productName = '';

  before(async () => {
    origCdr = [...customerDeviceRecords];
    // The route gate reads the server-side matrix; give it the boot defaults.
    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    if (!dbReachable) return;

    await pool.query("DELETE FROM audit_logs WHERE user_email LIKE 'rfa-%@example.com'");
    await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'RFA-%'");
    await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'rfa-%' OR device_serial LIKE 'RFA-%'");
    await pool.query('DELETE FROM branches WHERE id = $1', [BRANCH]);

    // A real seeded product: the handlers resolve products through the in-memory
    // catalogue hydrated at boot, so an invented row would be invisible to them.
    const product = (
      await pool.query("SELECT name FROM products WHERE tracking_type <> 'QUANTITY_ONLY' ORDER BY id LIMIT 1")
    ).rows[0];
    assert.ok(product, 'seed data must provide a serial-tracked product');
    productName = product.name;

    await pool.query(
      "INSERT INTO branches (id, code, name, location) VALUES ($1, 'RFABR', 'RFA Test Branch', 'T')",
      [BRANCH]
    );
    await pool.query(
      `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_name, branch_id, status, source_type)
       VALUES ('rfa-sl-taken', $1, 'RFA-PON-TAKEN', 'AA:BB:CC:00:0A:01', $2, $3, 'CUSTOMER_ASSIGNED', 'PURCHASE'),
              ('rfa-sl-old', $4, 'RFA-PON-OLD', 'AA:BB:CC:00:0A:00', $2, $3, 'CUSTOMER_ASSIGNED', 'PURCHASE')`,
      [TAKEN_SERIAL, productName, BRANCH, OLD_SERIAL]
    );
    await pool.query(
      `INSERT INTO customer_device_records
         (id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, status, notes)
       VALUES ('rfa-cdr', 'RFA Customer', 'RFAC', $1, $2, $3, 'RFA-PON-OLD', 'RENTAL', 'rfa fixture')`,
      [BRANCH, productName, OLD_SERIAL]
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
    if (dbReachable) {
      await pool.query("DELETE FROM audit_logs WHERE user_email LIKE 'rfa-%@example.com'");
      await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'RFA-%'");
      await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'rfa-%' OR device_serial LIKE 'RFA-%'");
      await pool.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
      await pool.end();
    }
  });

  async function post(path: string, body: unknown, token: string) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* 204 has no body */ }
    return { status: res.status, json };
  }

  async function get(path: string, token: string) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      headers: { authorization: 'Bearer ' + token },
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  }

  const reportRefusal = (serial: string, token: string, reason?: string) =>
    post('/api/customer-devices/exchange/refusal', {
      serial,
      reason: reason || `Refusal recorded by the test for ${serial}.`,
      branchId: BRANCH,
    }, token);

  const auditRows = async (serial: string) =>
    (await pool.query(
      `SELECT user_email, user_name, action, module, details, branch_id
         FROM audit_logs
        WHERE action = 'DEVICE_EXCHANGE_REFUSED' AND details LIKE $1
        ORDER BY timestamp_ad`,
      [`%${serial}%`]
    )).rows;

  test('a dialog refusal records the serial, its real status and branch, and the actor', { skip: skipNoDb }, async () => {
    const { status } = await reportRefusal(TAKEN_SERIAL, techToken);
    assert.equal(status, 204, 'reporting a refusal is a no-op that always succeeds');

    const rows = await auditRows(TAKEN_SERIAL);
    assert.equal(rows.length, 1, 'exactly one audit row per refused attempt');
    assert.equal(rows[0].action, 'DEVICE_EXCHANGE_REFUSED');
    assert.equal(rows[0].module, 'CPE_MANAGEMENT');
    assert.equal(rows[0].user_email, TECH_EMAIL, 'the actor is the signed-in operator');
    assert.equal(rows[0].branch_id, BRANCH);
    // The status comes from the register, not from the request.
    assert.match(rows[0].details, /register status CUSTOMER_ASSIGNED/);
    assert.match(rows[0].details, new RegExp(`at branch ${BRANCH}`));
  });

  test('a serial the register has never seen is recorded as UNKNOWN', { skip: skipNoDb }, async () => {
    const { status } = await reportRefusal(UNKNOWN_SERIAL, techToken);
    assert.equal(status, 204);

    const rows = await auditRows(UNKNOWN_SERIAL);
    assert.equal(rows.length, 1);
    assert.match(rows[0].details, /register status UNKNOWN/);
  });

  test('a role that cannot exchange cannot write refusal evidence either', { skip: skipNoDb }, async () => {
    const { status } = await reportRefusal(AUDITOR_SERIAL, auditorToken);
    assert.equal(status, 403, 'AUDITOR is outside the exchange audience');
    assert.equal((await auditRows(AUDITOR_SERIAL)).length, 0, 'a 403 must write nothing');
  });

  test('a server-side gate refusal is audited by the endpoint that refused it', { skip: skipNoDb }, async () => {
    const { status, json } = await post('/api/customer-devices/exchange', {
      oldDeviceId: 'rfa-cdr',
      exchangeReason: 'rfa audit probe',
      oldDeviceAction: 'KEEP',
      newProductName: productName,
      newDeviceSerial: TAKEN_SERIAL,
      newPonSerial: 'RFA-PON-TAKEN',
      notes: '',
      branchId: BRANCH,
    }, adminToken);
    assert.equal(status, 400, `expected the register gate to refuse, got ${status} ${JSON.stringify(json)}`);

    const rows = await auditRows(TAKEN_SERIAL);
    // One row from the dialog report above, one from this refused submission.
    assert.equal(rows.length, 2);
    const submitRow = rows.find((r) => r.user_email === ADMIN_EMAIL);
    assert.ok(submitRow, 'the submitting operator must be recorded');
    assert.match(submitRow.details, /register status CUSTOMER_ASSIGNED/);
    assert.match(String(submitRow.details), /not IN_STOCK/);
  });

  test('a duplicate refusal (409) is audited too, not only the gate', { skip: skipNoDb }, async () => {
    // OLD_SERIAL is already on a customer record, so the duplicate check refuses
    // before the register gate ever runs.
    const { status } = await post('/api/customer-devices/exchange', {
      oldDeviceId: 'rfa-cdr',
      exchangeReason: 'rfa duplicate probe',
      oldDeviceAction: 'KEEP',
      newProductName: productName,
      newDeviceSerial: OLD_SERIAL,
      newPonSerial: 'RFA-PON-OLD',
      notes: '',
      branchId: BRANCH,
    }, adminToken);
    assert.equal(status, 409);

    const rows = await auditRows(OLD_SERIAL);
    const duplicateRow = rows.find((r) => /already registered/.test(String(r.details)));
    assert.ok(duplicateRow, 'the duplicate refusal must be in the audit trail');
    assert.equal(duplicateRow.user_email, ADMIN_EMAIL);
  });

  // -------------------------------------------------------------------------
  // The Audit Trail screen's serial focus: one unit, every event, in order.
  // -------------------------------------------------------------------------

  test('a serial read returns every event for that unit, newest first', { skip: skipNoDb }, async () => {
    const { status, json } = await get(
      '/api/audit-trail?serial=' + encodeURIComponent(TAKEN_SERIAL),
      adminToken
    );
    assert.equal(status, 200);
    const rows = json as any[];
    // The two refusals recorded above (dialog report + refused submission) and
    // nothing belonging to another serial.
    assert.ok(rows.length >= 2, `expected at least the two refusals, got ${rows.length}`);
    assert.ok(rows.every((row) => String(row.details).includes(TAKEN_SERIAL)), 'rows are scoped to the serial');
    assert.ok(
      rows.filter((row) => row.action === 'DEVICE_EXCHANGE_REFUSED').length >= 2,
      'both refused attempts on the unit are visible in one read'
    );
    const stamps = rows.map((row) => Date.parse(row.timestampAD));
    assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a), 'newest event first');
  });

  test('the serial read is limited to the audit-screen audience', { skip: skipNoDb }, async () => {
    const { status } = await get(
      '/api/audit-trail?serial=' + encodeURIComponent(TAKEN_SERIAL),
      techToken
    );
    assert.equal(status, 403, 'FIELD_TECHNICIAN has no admin-audit operation');
  });

  test('a branch-scoped reader cannot read another branch\'s unit trail', { skip: skipNoDb }, async () => {
    const own = await get('/api/audit-trail?serial=' + encodeURIComponent(TAKEN_SERIAL), otherBranchToken);
    assert.equal(own.status, 200);
    assert.deepEqual(own.json, [], 'the unit belongs to another branch');

    const explicit = await get(
      '/api/audit-trail?branchId=' + encodeURIComponent(BRANCH) + '&serial=' + encodeURIComponent(TAKEN_SERIAL),
      otherBranchToken
    );
    assert.equal(explicit.status, 403, 'asking for a foreign branch is refused, not silently scoped');
  });
});
