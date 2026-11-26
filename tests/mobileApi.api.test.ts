/**
 * Mobile client API (`/api/v1/*`) — real HTTP + PostgreSQL.
 *
 * These cases drive the routes the PulseHR app actually calls, and pin the
 * promises an offline-first client depends on:
 *
 *   1. login returns an access token, a rotating refresh token and the linked
 *      employee; a wrong password is a 401;
 *   2. bootstrap is 401 without a token and describes the employee's own
 *      roster, geofence and punch state;
 *   3. a punch inside the fence writes ONE attendance row (source MOBILE) and
 *      ONE proof row, and its audit trail; replaying the same idempotency key
 *      answers from the stored response instead of writing again;
 *   4. a punch outside the fence is refused, so the coordinates are evaluated
 *      server-side rather than taken from the client;
 *   5. a device binds to one employee and refuses a second;
 *   6. the sync cursor advances after a change;
 *   7. a re-sent breadcrumb batch stores nothing twice;
 *   8. a claim is created for the signed-in employee only;
 *   9. a delegation cannot cross branches.
 */
import { purgeAuditLogs } from './support/purgeAuditLogs';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { hashPassword, issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH = 'mob-test-branch';
const OTHER_BRANCH = 'mob-test-branch-2';
const EMP = 'mob-test-emp';
const EMP_OTHER = 'mob-test-emp-2';
const EMP_SUP = 'mob-test-emp-sup';
const SHIFT = 'mob-test-shift';
const FENCE_LAT = 27.7172;
const FENCE_LNG = 85.324;

// The completion fixture: two serialised CPE models, three visits and the
// customer they are installed at. `docs/contracts/mobile-v1.md` names this file
// as the fixture for `/api/v1/*`, so the closing route is exercised here rather
// than only through the service.
const CPE = 'mob-test-cpe';
const CPE_NAME = 'Mobile Test CPE Router';
const SPARE = 'mob-test-cpe-spare';
const SPARE_NAME = 'Mobile Test Spare Router';
const CUST = 'mob-test-cust';
const CUST_NAME = 'Mobile Test Customer';
const SN_TO_INSTALL = 'MOB-TEST-CPE-1';
const SN_STAYS_HELD = 'MOB-TEST-CPE-2';
const SN_COLLEAGUE = 'MOB-TEST-CPE-3';
const WO_PLAIN = 'a1b2c3d4-0000-4000-8000-000000000001';
const WO_INSTALL = 'a1b2c3d4-0000-4000-8000-000000000002';
const WO_REFUSED = 'a1b2c3d4-0000-4000-8000-000000000003';

const USER = {
  id: 'mob-test-user',
  email: 'mob-test@example.com',
  name: 'Mobile Test User',
  role: 'FRONT_DESK',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
  password: hashPassword('mobile-pass-123'),
} as any;

const USER_SUP = {
  id: 'mob-test-user-sup',
  email: 'mob-test-sup@example.com',
  name: 'Mobile Test Supervisor',
  role: 'FRONT_DESK',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
  password: hashPassword('mobile-pass-789'),
} as any;

const USER_OTHER = {
  id: 'mob-test-user-2',
  email: 'mob-test-2@example.com',
  name: 'Mobile Other User',
  role: 'FRONT_DESK',
  branchId: OTHER_BRANCH,
  allowedBranchIds: [OTHER_BRANCH],
  canSwitchUser: false,
  password: hashPassword('mobile-pass-456'),
} as any;

describe('mobile v1 API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(USER);
  const otherToken = issueAuthToken(USER_OTHER);
  const supToken = issueAuthToken(USER_SUP);
  const adminToken = issueAuthToken({ id: 'mob-test-admin', email: 'mob-test-admin@example.com', name: 'Mobile Test Admin', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false } as any);

  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    auth?: string | null
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(auth === null ? {} : { authorization: 'Bearer ' + (auth || token) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body must not be hidden, only tolerated */
    }
    return { status: res.status, json, headers: res.headers };
  }

  async function cleanup() {
    // Submitting a claim now enqueues its posting, and the outbox holds a branch
    // FK: it has to go before the claim and the branch it names.
    await pool!.query("DELETE FROM accounting_outbox WHERE branch_id LIKE 'mob-test-branch%'");
    await pool!.query("DELETE FROM employee_location_breadcrumbs WHERE employee_id LIKE 'mob-test-emp%'");
    // The completion fixture: movement links before the movements they hang
    // off, the register before the products it references, and the visits before
    // the employees they are assigned to.
    await pool!.query("DELETE FROM employee_stock_movement_serials WHERE device_serial LIKE 'MOB-TEST-CPE-%'");
    await pool!.query('DELETE FROM employee_stock_movements WHERE product_id = ANY($1::text[])', [[CPE, SPARE]]);
    await pool!.query('DELETE FROM employee_stock_holdings WHERE product_id = ANY($1::text[])', [[CPE, SPARE]]);
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'MOB-TEST-CPE-%'");
    await pool!.query("DELETE FROM field_work_orders WHERE work_order_no LIKE 'MOB-TEST-WO-%'");
    await pool!.query('DELETE FROM inventory_stock WHERE product_id = ANY($1::text[])', [[CPE, SPARE]]);
    await pool!.query('DELETE FROM products WHERE id = ANY($1::text[])', [[CPE, SPARE]]);
    await pool!.query('DELETE FROM customer_records WHERE id = $1', [CUST]);
    await pool!.query("DELETE FROM idempotency_keys WHERE scope = 'mobile.punch'");
    await pool!.query("DELETE FROM mobile_change_log WHERE employee_id LIKE 'mob-test-emp%'");
    await pool!.query("DELETE FROM hr_attendance_proofs WHERE attendance_id LIKE 'hr-att-%' AND attendance_id IN (SELECT id FROM hr_attendance WHERE employee_id LIKE 'mob-test-emp%')");
    await pool!.query("DELETE FROM hr_attendance WHERE employee_id LIKE 'mob-test-emp%'");
    await pool!.query("DELETE FROM hr_expense_claims WHERE employee_id LIKE 'mob-test-emp%'");
    await pool!.query("DELETE FROM hr_delegations WHERE delegator_employee_id LIKE 'mob-test-emp%'");
    await pool!.query("DELETE FROM mobile_fcm_tokens WHERE employee_id LIKE 'mob-test-emp%'");
    await pool!.query("DELETE FROM mobile_devices WHERE employee_id LIKE 'mob-test-emp%'");
    await pool!.query("DELETE FROM mobile_refresh_tokens WHERE user_id LIKE 'mob-test-user%'");
    await pool!.query("DELETE FROM employee_shift_roster WHERE employee_id LIKE 'mob-test-emp%'");
    await pool!.query("DELETE FROM employees WHERE id LIKE 'mob-test-emp%'");
    await pool!.query("DELETE FROM hr_shifts WHERE id = $1", [SHIFT]);
    await pool!.query("DELETE FROM users WHERE id LIKE 'mob-test-user%'");
    await pool!.query("DELETE FROM company_announcements WHERE id LIKE 'mob-test-ann%'");
    await pool!.query("DELETE FROM branch_geofences WHERE branch_id LIKE 'mob-test-branch%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'mob-test-branch%'");
    await purgeAuditLogs(pool!, "DELETE FROM audit_logs WHERE branch_id LIKE 'mob-test-branch%'");
  }

  before(async () => {
    await cleanup();
    // Services write through the app pool, which refuses until boot has proven
    // the database reachable; the other API suites set the same flag.
    const { ensurePostgresConnection } = await import('../server/db');
    assert.equal(await ensurePostgresConnection(), true, 'the dev database must be reachable');
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'MOBT', 'Mobile Test Branch', 'Test'), ($2, 'MOBT2', 'Mobile Other Branch', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO branch_geofences (branch_id, latitude, longitude, radius_meters)
       VALUES ($1, $2, $3, 100)`,
      [BRANCH, FENCE_LAT, FENCE_LNG]
    );
    for (const user of [USER, USER_OTHER, USER_SUP]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7]::text[], 'active')`,
        [user.id, user.email, user.password, user.name, user.role, user.branchId, user.branchId]
      );
    }
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
       VALUES ($1, 'MOB-001', 'Mobile Test Employee', $2, $3, 'Field'),
              ($4, 'MOB-002', 'Mobile Other Employee', $5, $6, 'Field'),
              ($7, 'MOB-003', 'Mobile Test Supervisor', $2, $8, 'Field')`,
      [EMP, BRANCH, USER.id, EMP_OTHER, OTHER_BRANCH, USER_OTHER.id, EMP_SUP, USER_SUP.id]
    );
    // --- the completion fixture -------------------------------------------------
    // Two serialised CPE products: the first the technician carries for the
    // install, the second a spare only the supervisor holds — the unit the phone
    // may not consume. `Product Item` is seeded by scripts/schema.sql in every
    // database, so the fixture needs no master-data setup of its own.
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id)
       VALUES ($1, 'MOB-CUST-1', $2, '9800000001', $3)`,
      [CUST, CUST_NAME, BRANCH]
    );
    await pool!.query(
      `INSERT INTO products
         (id, name, sku, category, product_group, unit, cost_price, selling_price,
          requires_serial_tracking, tracking_type)
       VALUES ($1, $2, 'MOB-CPE-SKU', 'CPE', 'Product Item', 'Pcs', 2500, 3200, TRUE, 'SERIAL_MAC_PON'),
              ($3, $4, 'MOB-SPARE-SKU', 'CPE', 'Product Item', 'Pcs', 1800, 2400, TRUE, 'SERIAL_MAC_PON')`,
      [CPE, CPE_NAME, SPARE, SPARE_NAME]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ($1, $2, $3, 5, 2500, 1), ($4, $5, $3, 2, 1800, 1)`,
      [`stk-${BRANCH}-${CPE}`, CPE, BRANCH, `stk-${BRANCH}-${SPARE}`, SPARE]
    );
    await pool!.query(
      `INSERT INTO serial_log
         (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, status, source_type, created_at)
       VALUES ('mob-test-sn-1', $1, 'MOB-PON-1', 'AA:BB:CC:00:02:01', $4, $5, $6, 'IN_STOCK', 'PURCHASE', now()),
              ('mob-test-sn-2', $2, 'MOB-PON-2', 'AA:BB:CC:00:02:02', $4, $5, $6, 'IN_STOCK', 'PURCHASE', now()),
              ('mob-test-sn-3', $3, 'MOB-PON-3', 'AA:BB:CC:00:02:03', $7, $8, $6, 'IN_STOCK', 'PURCHASE', now())`,
      [SN_TO_INSTALL, SN_STAYS_HELD, SN_COLLEAGUE, CPE, CPE_NAME, BRANCH, SPARE, SPARE_NAME]
    );
    await pool!.query(
      `INSERT INTO field_work_orders
         (id, work_order_no, branch_id, customer_id, kind, status, technician_id, technician_name,
          scheduled_date_ad, created_by, row_version)
       VALUES ($1, 'MOB-TEST-WO-1', $4, $5, 'SERVICE', 'ASSIGNED', $6, 'Mobile Test Employee', CURRENT_DATE, 'mob-test', 1),
              ($2, 'MOB-TEST-WO-2', $4, $5, 'INSTALL', 'ASSIGNED', $6, 'Mobile Test Employee', CURRENT_DATE, 'mob-test', 1),
              ($3, 'MOB-TEST-WO-3', $4, $5, 'INSTALL', 'ASSIGNED', $6, 'Mobile Test Employee', CURRENT_DATE, 'mob-test', 1)`,
      [WO_PLAIN, WO_INSTALL, WO_REFUSED, BRANCH, CUST, EMP]
    );
    // A supervisor's active delegation is what authorises a decision when the
    // role itself lacks hr-attendance-manage; before v2 it granted nothing.
    await pool!.query(
      `INSERT INTO hr_delegations (id, delegator_employee_id, delegate_employee_id, capabilities, start_date_ad, end_date_ad, created_by)
       VALUES ('mob-test-deleg-1', $1, $2, ARRAY['approve.expense', 'approve.attendance_ot']::text[], CURRENT_DATE, CURRENT_DATE + 7, 'mob-test')`,
      [EMP, EMP_SUP]
    );
    await pool!.query(
      `INSERT INTO hr_shifts (id, code, name, start_time, end_time)
       VALUES ($1, 'MOB-SHIFT', 'Mobile Day', '09:00', '18:00')`,
      [SHIFT]
    );
    await pool!.query(
      `INSERT INTO employee_shift_roster (id, employee_id, shift_id, branch_id, shift_date_ad)
       VALUES ('mob-test-roster-1', $1, $2, $3, CURRENT_DATE)`,
      [EMP, SHIFT, BRANCH]
    );
    await pool!.query(
      `INSERT INTO company_announcements (id, title, summary, category, published_at)
       VALUES ('mob-test-ann-1', 'Mobile notice', 'Seeded notice', 'GENERAL', now())`
    );

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () =>
      new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      });

    // Custody as the depot hands it out: the technician carries the unit that
    // will be installed, and the supervisor holds the spare the phone must not
    // consume. Issuing through the real endpoint means the register and the
    // holding projection start where a van load really leaves them.
    const carried = await request('POST', '/api/employee-stock/issue', {
      employeeId: EMP,
      productId: CPE,
      quantity: 2,
      deviceSerials: [SN_TO_INSTALL, SN_STAYS_HELD],
      reason: 'Van load for installs',
    }, adminToken);
    assert.equal(carried.status, 201, JSON.stringify(carried.json));
    const spare = await request('POST', '/api/employee-stock/issue', {
      employeeId: EMP_SUP,
      productId: SPARE,
      quantity: 1,
      deviceSerials: [SN_COLLEAGUE],
      reason: 'Supervisor spare',
    }, adminToken);
    assert.equal(spare.status, 201, JSON.stringify(spare.json));
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('login issues tokens for the linked employee and refuses a wrong password', async () => {
    const bad = await request('POST', '/api/v1/auth/login', {
      email: USER.email,
      password: 'wrong-password',
    }, null);
    assert.equal(bad.status, 401, JSON.stringify(bad.json));

    const good = await request('POST', '/api/v1/auth/login', {
      email: USER.email,
      password: 'mobile-pass-123',
      deviceId: 'mob-test-device',
    }, null);
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.ok(good.json.accessToken, 'an access token is returned');
    assert.ok(good.json.refreshToken, 'a refresh token is returned');
    assert.equal(good.json.employeeId, EMP, 'the linked employee is named');
    assert.equal(good.json.branchScope, BRANCH);
    assert.ok(Array.isArray(good.json.capabilities));
    assert.equal(good.headers.get('cache-control'), 'private, no-store');

    const rotated = await request('POST', '/api/v1/auth/refresh', {
      refreshToken: good.json.refreshToken,
    }, null);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.json));
    assert.notEqual(rotated.json.refreshToken, good.json.refreshToken, 'refresh rotates');

    const reused = await request('POST', '/api/v1/auth/refresh', {
      refreshToken: good.json.refreshToken,
    }, null);
    assert.equal(reused.status, 401, 'a spent refresh token cannot be replayed');
  });

  test('bootstrap needs a token and describes the own roster and fence', async () => {
    const denied = await request('GET', '/api/v1/workplace/bootstrap', undefined, null);
    assert.equal(denied.status, 401, JSON.stringify(denied.json));

    const boot = await request('GET', '/api/v1/workplace/bootstrap');
    assert.equal(boot.status, 200, JSON.stringify(boot.json));
    assert.equal(boot.json.punchState, 'NOT_CLOCKED_IN');
    assert.equal(boot.json.shifts.length, 1, 'the rostered seat is returned');
    assert.equal(boot.json.shifts[0].shiftCode, 'MOB-SHIFT');
    assert.equal(boot.json.shifts[0].startHour, 9);
    assert.equal(boot.json.geofence.configured, true);
    assert.equal(boot.json.geofence.radiusMeters, 100);
    assert.ok(boot.json.unreadNotices >= 1);
    assert.ok(Array.isArray(boot.json.capabilities));
    assert.ok(
      boot.json.workplaceCapabilities.includes('attendance.punch'),
      'the home screen is assembled from capability names'
    );
    assert.equal(typeof boot.json.needsAttention, 'number');
  });

  test('a punch writes one attendance row and one proof, and replays by key', async () => {
    const punch = {
      employeeId: EMP,
      branchId: BRANCH,
      attendanceDateAd: new Date().toISOString().slice(0, 10),
      action: 'CLOCK_IN',
      punchTime: '09:02',
      latitude: FENCE_LAT + 0.0001,
      longitude: FENCE_LNG,
      distanceMeters: 0,
      gpsAccuracyMeters: 8,
      wifiBssid: 'aa:bb:cc:dd:ee:ff',
      deviceTimeEpochMs: Date.now(),
      idempotencyKey: 'mob-test-punch-1',
    };

    const first = await request('POST', '/api/v1/workplace/attendance/punch', punch);
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.syncStatus, 'SYNCED');
    assert.equal(first.json.integrityStatus, 'VERIFIED');
    assert.equal(first.json.geofence.configured, true);
    assert.equal(first.json.geofence.inside, true);

    const rows = await pool!.query(
      "SELECT id, source, check_in_time FROM hr_attendance WHERE employee_id = $1",
      [EMP]
    );
    assert.equal(rows.rowCount, 1, 'exactly one attendance row');
    assert.equal(rows.rows[0].source, 'MOBILE', 'the punch is recorded as a mobile source');

    const proof = await pool!.query(
      'SELECT integrity_status, risk_score, inside_geofence FROM hr_attendance_proofs WHERE attendance_id = $1',
      [rows.rows[0].id]
    );
    assert.equal(proof.rowCount, 1, 'exactly one proof row');
    assert.equal(proof.rows[0].integrity_status, 'VERIFIED');
    assert.equal(proof.rows[0].inside_geofence, true);

    const replay = await request('POST', '/api/v1/workplace/attendance/punch', punch);
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true, 'the stored response is replayed');
    const stillOne = await pool!.query(
      'SELECT COUNT(*)::int AS n FROM hr_attendance WHERE employee_id = $1',
      [EMP]
    );
    assert.equal(stillOne.rows[0].n, 1, 'a replayed punch does not write a second row');

    // v2: a punch outside the fence is ACCEPTED and flagged, not refused. A
    // wrongly rejected punch costs the technician a day of pay.
    const outside = await request('POST', '/api/v1/workplace/attendance/punch', {
      ...punch,
      action: 'CLOCK_OUT',
      latitude: FENCE_LAT + 0.02,
      longitude: FENCE_LNG,
      punchTime: '18:05',
      idempotencyKey: 'mob-test-punch-2',
    });
    assert.equal(outside.status, 201, JSON.stringify(outside.json));
    assert.equal(outside.json.verdict, 'FLAGGED');
    assert.equal(outside.json.integrityStatus, 'SUSPECT');
    assert.equal(outside.json.geofence.inside, false, 'the server still says it is outside');
    assert.ok(outside.json.riskScore >= 40);

    // Scoped to this file's employee: the suite shards run against one database,
    // so a colleague's flagged punch from another file must not answer here.
    const flagged = await pool!.query(
      `SELECT p.verdict, p.inside_geofence
         FROM hr_attendance_proofs p
         JOIN hr_attendance a ON a.id = p.attendance_id
        WHERE a.employee_id = $1 AND p.integrity_status = 'SUSPECT'`,
      [EMP]
    );
    assert.equal(flagged.rowCount, 1, 'the flagged punch is stored, not dropped');
    assert.equal(flagged.rows[0].verdict, 'FLAGGED');
    assert.equal(flagged.rows[0].inside_geofence, false);

    const boot = await request('GET', '/api/v1/workplace/bootstrap');
    assert.equal(boot.json.punchState, 'CLOCKED_OUT');
  });

  test('a punch whose device clock is far off is held for review, not refused', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const held = await request('POST', '/api/v1/workplace/attendance/punch', {
      attendanceDateAd: tomorrow,
      action: 'CLOCK_IN',
      punchTime: '08:58',
      latitude: FENCE_LAT,
      longitude: FENCE_LNG,
      gpsAccuracyMeters: 7,
      deviceTimeEpochMs: Date.now() - 3 * 60 * 60 * 1000,
      idempotencyKey: 'mob-test-punch-held',
    });
    assert.equal(held.status, 201, JSON.stringify(held.json));
    assert.equal(held.json.verdict, 'HELD');
    assert.equal(held.json.integrityStatus, 'HELD');
    assert.match(held.json.heldReason, /clock/i);

    const proof = await pool!.query(
      'SELECT verdict, held_reason, clock_skew_ms FROM hr_attendance_proofs WHERE attendance_id = $1',
      [held.json.id]
    );
    assert.equal(proof.rowCount, 1);
    assert.equal(proof.rows[0].verdict, 'HELD');
    assert.ok(Number(proof.rows[0].clock_skew_ms) < -15 * 60 * 1000);
  });

  test('a device binds to one employee and refuses another', async () => {
    const bound = await request('POST', '/api/v1/devices/register', {
      deviceId: 'mob-test-device-1',
      employeeId: EMP,
      modelName: 'Pixel Test',
      appVersion: '2.0.0',
    });
    assert.equal(bound.status, 201, JSON.stringify(bound.json));
    assert.equal(bound.json.registered, true);

    const hijack = await request('POST', '/api/v1/devices/register', {
      deviceId: 'mob-test-device-1',
      employeeId: EMP,
      modelName: 'Other Phone',
    }, otherToken);
    assert.equal(hijack.status, 409, JSON.stringify(hijack.json));
  });

  test('a revoked device cannot sign in and sync reports it', async () => {
    // A password login admits the device it names.
    const login = await request('POST', '/api/v1/auth/login', {
      email: USER.email,
      password: 'mobile-pass-123',
      deviceId: 'mob-test-device-revoke',
    }, null);
    assert.equal(login.status, 200, JSON.stringify(login.json));

    const devices = await request('GET', '/api/admin/mobile-devices?employeeId=' + EMP, undefined, adminToken);
    assert.equal(devices.status, 200, JSON.stringify(devices.json));
    assert.ok(devices.json.devices.some((d: any) => d.deviceId === 'mob-test-device-revoke'));

    const revoked = await request('POST', '/api/admin/mobile-devices/mob-test-device-revoke/revoke', {}, adminToken);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));

    const again = await request('POST', '/api/v1/auth/login', {
      email: USER.email,
      password: 'mobile-pass-123',
      deviceId: 'mob-test-device-revoke',
    }, null);
    assert.equal(again.status, 403, JSON.stringify(again.json));
    assert.match(again.json.message, /revoked/i);

    const pull = await request(
      'GET',
      '/api/v1/sync/pull?updated_since=0&deviceId=mob-test-device-revoke'
    );
    assert.equal(pull.json.revokedDevice, true, 'sync tells the app to wipe itself');
  });

  test('sensitive reads need a fresh password, and the profile card never carries PAN or bank', async () => {
    const profile = await request('GET', '/api/v1/profile');
    assert.equal(profile.status, 200, JSON.stringify(profile.json));
    assert.equal(profile.json.panNumber, undefined, 'PAN is not in the everyday card');
    assert.equal(profile.json.bankAccount, undefined, 'bank details are not in the everyday card');
    assert.equal(profile.json.monthlySalary, undefined, 'salary is not in the everyday card');

    const denied = await request('GET', '/api/v1/hr/me/sensitive');
    assert.equal(denied.status, 401, JSON.stringify(denied.json));
    assert.equal(denied.json.code, 'REAUTH_REQUIRED');

    const wrong = await request('POST', '/api/v1/auth/re-auth', { password: 'nope' });
    assert.equal(wrong.status, 401);

    const elevation = await request('POST', '/api/v1/auth/re-auth', { password: 'mobile-pass-123' });
    assert.equal(elevation.status, 200, JSON.stringify(elevation.json));
    assert.ok(elevation.json.reAuthToken);
    assert.ok(elevation.json.expiresInSeconds > 0 && elevation.json.expiresInSeconds <= 300);

    const sensitive = await request('GET', '/api/v1/hr/me/sensitive', undefined, undefined);
    // Without the header, the session token alone is still refused.
    assert.equal(sensitive.status, 401);

    const res = await fetch('http://127.0.0.1:' + port + '/api/v1/hr/me/sensitive', {
      headers: {
        authorization: 'Bearer ' + token,
        'x-reauth-token': elevation.json.reAuthToken,
      },
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body: any = await res.json();
    assert.equal(body.employeeCode, 'MOB-001');
    assert.ok('panNumber' in body && 'bankAccount' in body);

    const payslipDenied = await request('GET', '/api/v1/payslips');
    assert.equal(payslipDenied.status, 401);
    assert.equal(payslipDenied.json.code, 'REAUTH_REQUIRED');
  });

  test('an FCM token registers idempotently', async () => {
    const first = await request('POST', '/api/v1/notifications/fcm-token', {
      fcmToken: 'mob-test-fcm-token',
      platform: 'ANDROID',
      topics: ['shifts'],
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.registered, true);
    const again = await request('POST', '/api/v1/notifications/fcm-token', {
      fcmToken: 'mob-test-fcm-token',
      platform: 'ANDROID',
      topics: ['shifts', 'approvals'],
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.topics, ['shifts', 'approvals']);
  });

  test('sync pull advances its cursor after a change', async () => {
    const pull = await request('GET', '/api/v1/sync/pull?updated_since=0');
    assert.equal(pull.status, 200, JSON.stringify(pull.json));
    assert.ok(pull.json.serverCursor > 0, 'a cursor is returned');
    assert.ok(
      pull.json.changes.some((change: any) => change.entity === 'ATTENDANCE'),
      'the punch is visible in the change feed'
    );
    const ahead = await request('GET', `/api/v1/sync/pull?updated_since=${pull.json.serverCursor}`);
    assert.equal(ahead.json.changes.length, 0, 'nothing new past the cursor');
  });

  test('an offline batch applies every action and retains the one it refuses', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const pushed = await request('POST', '/api/v1/sync/push', {
      deviceId: 'mob-test-device-1',
      actions: [
        {
          clientId: 'mob-q-1',
          kind: 'PUNCH',
          idempotencyKey: 'mob-push-punch-1',
          payload: {
            attendanceDateAd: tomorrow,
            action: 'CLOCK_IN',
            punchTime: '09:00',
            latitude: FENCE_LAT,
            longitude: FENCE_LNG,
            gpsAccuracyMeters: 9,
          },
        },
        {
          clientId: 'mob-q-2',
          kind: 'CLAIM',
          idempotencyKey: 'mob-push-claim-1',
          payload: { category: 'TRAVEL', amount: 300, description: 'bus to site' },
        },
        {
          clientId: 'mob-q-3',
          kind: 'CLAIM',
          idempotencyKey: 'mob-push-claim-bad',
          payload: { category: 'TRAVEL', amount: 0, description: 'lost receipt' },
        },
      ],
    });
    assert.equal(pushed.status, 200, JSON.stringify(pushed.json));
    assert.equal(pushed.json.receivedCount, 3);
    assert.equal(pushed.json.acceptedCount, 2, 'the good punch and claim still apply');
    assert.equal(pushed.json.rejectedCount, 1);
    const refused = pushed.json.results.find((item: any) => item.clientId === 'mob-q-3');
    assert.equal(refused.status, 'REJECTED');
    assert.equal(refused.code, 'VALIDATION_ERROR');
    assert.equal(refused.retryable, false);

    // The captured item is kept whole, so nothing from the site is lost.
    const retained = await pool!.query(
      "SELECT action_kind, code, payload, resolved_at FROM mobile_sync_rejections WHERE employee_id = $1 AND client_id = 'mob-q-3'",
      [EMP]
    );
    assert.equal(retained.rowCount, 1, 'the refused action is retained');
    assert.equal(retained.rows[0].action_kind, 'CLAIM');
    assert.equal(Number(retained.rows[0].payload.amount), 0, 'the payload travels with the rejection');
    assert.equal(retained.rows[0].resolved_at, null, 'it starts unresolved');

    const boot = await request('GET', '/api/v1/workplace/bootstrap');
    assert.ok(boot.json.needsAttention >= 1, 'bootstrap counts it for the Needs attention badge');
  });

  test('a re-sent breadcrumb batch stores each point once', async () => {
    const batch = {
      employeeId: EMP,
      deviceId: 'mob-test-device-1',
      idempotencyKey: 'mob-test-route-1',
      points: [
        {
          id: 'mob-test-pt-1',
          employeeId: EMP,
          sessionId: 'mob-test-session',
          eventType: 'WAYPOINT',
          latitude: FENCE_LAT,
          longitude: FENCE_LNG,
          accuracyMeters: 6,
          siteLabel: 'Pole 1',
          capturedAtEpochMs: Date.now(),
        },
        {
          id: 'mob-test-pt-2',
          employeeId: EMP,
          sessionId: 'mob-test-session',
          eventType: 'WAYPOINT',
          latitude: FENCE_LAT + 0.001,
          longitude: FENCE_LNG,
          accuracyMeters: 5,
          siteLabel: 'Pole 2',
          capturedAtEpochMs: Date.now(),
        },
      ],
    };
    const first = await request('POST', '/api/v1/workplace/location/batch', batch);
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.acceptedCount, 2);

    const again = await request('POST', '/api/v1/workplace/location/batch', batch);
    assert.equal(again.status, 201);
    assert.equal(again.json.acceptedCount, 0, 'the same point ids are not stored twice');
    const stored = await pool!.query(
      "SELECT COUNT(*)::int AS n FROM employee_location_breadcrumbs WHERE employee_id = $1",
      [EMP]
    );
    assert.equal(stored.rows[0].n, 2);
  });

  test('a claim belongs to the signed-in employee', async () => {
    const created = await request('POST', '/api/v1/workplace/claims', {
      claimId: 'mob-test-claim-1',
      employeeId: EMP,
      category: 'TRAVEL',
      amount: 1250.5,
      ticketCode: 'TCK-1',
      description: 'Site visit fuel',
      receiptAttached: true,
      idempotencyKey: 'mob-test-claim',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.status, 'SUBMITTED');

    const fetched = await request('GET', '/api/v1/workplace/claims/mob-test-claim-1');
    assert.equal(fetched.status, 200, JSON.stringify(fetched.json));

    const foreign = await request('POST', '/api/v1/workplace/claims', {
      claimId: 'mob-test-claim-2',
      employeeId: EMP_OTHER,
      category: 'TRAVEL',
      amount: 10,
    });
    assert.equal(foreign.status, 403, 'another employee id is refused');
  });

  test('a delegation cannot cross branches', async () => {
    const cross = await request('POST', '/api/v1/workplace/delegations', {
      delegateEmployeeId: EMP_OTHER,
      delegateName: 'Mobile Other Employee',
      endDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      capabilitiesCsv: 'APPROVE_LEAVE',
    });
    assert.equal(cross.status, 403, JSON.stringify(cross.json));

    const same = await request('POST', '/api/v1/workplace/delegations', {
      delegateEmployeeId: EMP,
      delegateName: 'Mobile Test Employee',
      endDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      capabilitiesCsv: 'APPROVE_LEAVE',
    });
    assert.equal(same.status, 400, 'delegating to yourself is refused');
  });

  test('the job queue and the van balance are the technician\'s own', async () => {
    const jobs = await request('GET', '/api/v1/workplace/jobs');
    assert.equal(jobs.status, 200, JSON.stringify(jobs.json));
    assert.ok(Array.isArray(jobs.json.jobs));
    assert.equal(jobs.json.count, jobs.json.jobs.length);

    const stock = await request('GET', '/api/v1/workplace/stock');
    assert.equal(stock.status, 200, JSON.stringify(stock.json));
    assert.ok(Array.isArray(stock.json.holdings));
    assert.equal(stock.json.vanLocation, 'MOBT');
  });

  test('a delegated supervisor decides the branch inbox, and nobody decides their own', async () => {
    const inbox = await request('GET', '/api/v1/workplace/approvals', undefined, supToken);
    assert.equal(inbox.status, 200, JSON.stringify(inbox.json));
    assert.ok(
      inbox.json.claims.some((claim: any) => claim.id === 'mob-test-claim-1'),
      'the submitted claim is in the branch inbox'
    );
    assert.ok(
      inbox.json.punches.some((punch: any) => punch.verdict === 'FLAGGED'),
      'the flagged punch needs a reviewer'
    );
    assert.equal(inbox.json.claims[0].employeeId, EMP);
    assert.deepEqual(inbox.json.delegations[0].capabilities.includes('approve.expense'), true);

    const decided = await request(
      'POST',
      '/api/v1/workplace/approvals/EXPENSE_CLAIM/mob-test-claim-1',
      { approve: true, note: 'Receipt checked' },
      supToken
    );
    assert.equal(decided.status, 200, JSON.stringify(decided.json));
    assert.equal(decided.json.status, 'APPROVED');
    assert.equal(decided.json.delegated, true, 'authority came from the delegation');

    const again = await request(
      'POST',
      '/api/v1/workplace/approvals/EXPENSE_CLAIM/mob-test-claim-1',
      { approve: false },
      supToken
    );
    assert.equal(again.status, 409, 'a decided claim cannot be rewritten');

    // The requester cannot approve their own claim, even holding the branch inbox.
    const own = await request('POST', '/api/v1/workplace/claims', {
      claimId: 'mob-test-claim-own',
      category: 'MEAL',
      amount: 50,
    });
    assert.equal(own.status, 201, JSON.stringify(own.json));
    // The requester's own token is refused even though the claim is theirs to see.
    const self = await request(
      'POST',
      '/api/v1/workplace/approvals/EXPENSE_CLAIM/mob-test-claim-own',
      { approve: true },
      token
    );
    assert.equal(self.status, 403, JSON.stringify(self.json));
    assert.match(self.json.message, /own claim/i);

    const punchReview = await request(
      'POST',
      '/api/v1/workplace/approvals/PUNCH/' + inbox.json.punches[0].attendanceId,
      { note: 'Called the technician; time confirmed' },
      supToken
    );
    assert.equal(punchReview.status, 200, JSON.stringify(punchReview.json));
    assert.ok(punchReview.json.reviewedAt);
    const reviewedPunch = await pool!.query(
      'SELECT reviewed_at, reviewed_by, verdict FROM hr_attendance_proofs WHERE attendance_id = $1',
      [inbox.json.punches[0].attendanceId]
    );
    assert.ok(reviewedPunch.rows[0].reviewed_at);
    assert.equal(
      reviewedPunch.rows[0].verdict,
      inbox.json.punches[0].verdict,
      'the verdict is never rewritten'
    );
  });

  test('a leave review without an explicit approve flag is refused, not defaulted', async () => {
    // The route bridges to the HR approve/reject handlers; a stripped body used
    // to fall through to REJECT. Refusing the call is the only safe answer.
    const missing = await request('POST', '/api/v1/leaves/requests/mob-any/review', {});
    assert.equal(missing.status, 400, JSON.stringify(missing.json));
    assert.equal(missing.json.code, 'VALIDATION_ERROR');
    assert.equal(missing.json.retryable, false);
    assert.equal(missing.json.details.field, 'approve');

    const stringy = await request('POST', '/api/v1/leaves/requests/mob-any/review', {
      approve: 'false',
    });
    assert.equal(stringy.status, 400, 'a truthy string is not a decision');
  });

  /** One work order row, as the closing screen's guards see it. */
  async function workOrder(id: string) {
    const { rows } = await pool!.query(
      `SELECT status, completion_notes, ont_serial, row_version, completed_at
         FROM field_work_orders WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  /** One device serial, as the register (and therefore the customer) sees it. */
  async function serial(deviceSerial: string) {
    const { rows } = await pool!.query(
      `SELECT status, holder_employee_id AS "holder", customer_id AS "customerId",
              customer_name AS "customerName", source_type AS "sourceType"
         FROM serial_log WHERE device_serial = $1`,
      [deviceSerial]
    );
    return rows[0];
  }

  async function heldUnits(productId: string): Promise<number> {
    const { rows } = await pool!.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS held
         FROM employee_stock_holdings WHERE employee_id = $1 AND product_id = $2`,
      [EMP, productId]
    );
    return Number(rows[0].held);
  }

  test('completing a visit needs no serials, keeps the documented note and refuses a stale version', async () => {
    const note = 'Line checked, no hardware consumed';
    const body = { baseVersion: 1, notes: note, idempotencyKey: `complete-${WO_PLAIN}-1` };
    const done = await request('POST', `/api/v1/workplace/jobs/${WO_PLAIN}/complete`, body);
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.deepEqual(
      Object.keys(done.json).sort(),
      ['baseVersion', 'installedAssets', 'message', 'resultStatus', 'workOrderId'],
      'the response is exactly the shape docs/contracts/mobile-v1.md documents'
    );
    assert.deepEqual(done.json.installedAssets, [], 'a visit with no held unit installs none');
    assert.equal(done.json.workOrderId, WO_PLAIN);
    assert.equal(done.json.resultStatus, 'CLOSED');
    assert.ok(done.json.message, 'the app shows this message verbatim');
    assert.equal(done.json.baseVersion, 2, 'the new version is handed back for the next edit');
    assert.ok(Array.isArray(done.json.installedAssets), 'the app iterates this list verbatim');
    assert.equal(done.headers.get('cache-control'), 'private, no-store');

    const closed = await workOrder(WO_PLAIN);
    assert.equal(closed.status, 'COMPLETED');
    assert.ok(closed.completed_at, 'a COMPLETED order always carries its stamp');
    assert.equal(closed.completion_notes, note, 'the contract calls the field `notes`; it must reach the visit');
    assert.equal(closed.ont_serial, null, 'no serial was named, so none is recorded');

    // The offline queue re-sends the version it downloaded; the server must not
    // close the visit twice or overwrite what the first close wrote.
    const replay = await request('POST', `/api/v1/workplace/jobs/${WO_PLAIN}/complete`, body);
    assert.equal(replay.status, 409, JSON.stringify(replay.json));
    assert.deepEqual(
      Object.keys(replay.json).sort(),
      ['message'],
      'a stale version carries no code: the contract\u2019s envelope is `{ message }` unless the refusal names a stable reason'
    );
    assert.match(replay.json.message, /changed since it was downloaded/i);
    assert.equal((await workOrder(WO_PLAIN)).row_version, 2, 'the refused replay changed nothing');

    // Somebody else's token cannot close this visit at all.
    const foreign = await request(
      'POST',
      `/api/v1/workplace/jobs/${WO_PLAIN}/complete`,
      { baseVersion: 2 },
      supToken
    );
    assert.equal(foreign.status, 404, JSON.stringify(foreign.json));
    assert.deepEqual(Object.keys(foreign.json).sort(), ['message'], 'a 404 is the bare envelope too');
    assert.match(foreign.json.message, /not assigned to you/i);
  });

  test('a consumedSerials install moves the unit from custody to the work order customer', async () => {
    const done = await request('POST', `/api/v1/workplace/jobs/${WO_INSTALL}/complete`, {
      baseVersion: 1,
      notes: 'CPE mounted, ONT online',
      serialUsed: SN_TO_INSTALL,
      consumedSerials: [SN_TO_INSTALL],
      consumedProductId: CPE,
      consumedCableMeters: 0,
      idempotencyKey: `complete-${WO_INSTALL}-1`,
    });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.resultStatus, 'CLOSED');
    assert.equal(done.json.baseVersion, 2);

    const installed = await serial(SN_TO_INSTALL);
    assert.equal(installed.status, 'CUSTOMER_ASSIGNED', 'the installed unit is now the customer\u2019s');
    assert.equal(installed.holder, null, 'nobody holds an installed unit');
    assert.equal(installed.customerId, CUST, 'the work order names the customer, not the phone');
    assert.equal(installed.customerName, CUST_NAME);
    assert.equal(installed.sourceType, 'WORK_ORDER', 'the visit is the installing document');

    const untouched = await serial(SN_STAYS_HELD);
    assert.equal(untouched.status, 'IN_CUSTODY', 'the unit the phone did not name stays on the van');
    assert.equal(untouched.holder, EMP);
    assert.equal(untouched.customerId, null);
    assert.equal(await heldUnits(CPE), 1, 'the van gave up exactly the installed unit');

    const linked = await pool!.query(
      `SELECT s.device_serial
         FROM employee_stock_movement_serials s
         JOIN employee_stock_movements m ON m.id = s.movement_id
        WHERE m.employee_id = $1 AND m.product_id = $2 AND m.movement_type = 'CONSUME'`,
      [EMP, CPE]
    );
    assert.deepEqual(linked.rows.map((row: any) => row.device_serial), [SN_TO_INSTALL], 'the movement names its unit');
    assert.equal((await workOrder(WO_INSTALL)).completion_notes, 'CPE mounted, ONT online');
  });

  test('a serial the technician does not hold is refused and leaves the visit open', async () => {
    const body = {
      baseVersion: 1,
      notes: 'Spare fitted',
      consumedSerials: [SN_COLLEAGUE],
      consumedProductId: SPARE,
      consumedCableMeters: 0,
      idempotencyKey: `complete-${WO_REFUSED}-1`,
    };
    const refused = await request('POST', `/api/v1/workplace/jobs/${WO_REFUSED}/complete`, body);
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.deepEqual(
      Object.keys(refused.json).sort(),
      ['code', 'message'],
      'a refusal with a stable reason adds exactly `code` to the envelope'
    );
    assert.equal(refused.json.code, 'INSUFFICIENT_HOLDING', 'the app prints this code');
    assert.match(refused.json.message, /does not hold that many units/i);

    const open = await workOrder(WO_REFUSED);
    assert.equal(open.status, 'ASSIGNED', 'a refused consumption leaves the visit open');
    assert.equal(open.row_version, 1);
    assert.equal(open.completed_at, null);
    const colleague = await serial(SN_COLLEAGUE);
    assert.equal(colleague.status, 'IN_CUSTODY', 'the refusal rolled the register back');
    assert.equal(colleague.holder, EMP_SUP, 'the unit never left the colleague holding it');
    assert.equal(colleague.customerId, null);
    const movements = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM employee_stock_movements WHERE employee_id = $1 AND product_id = $2`,
      [EMP, SPARE]
    );
    assert.equal(movements.rows[0].n, 0, 'no movement was written for the refused consumption');

    // The offline queue can also arrive without a version; that is a validation
    // answer, not a conflict, and it changes nothing either.
    const noVersion = await request('POST', `/api/v1/workplace/jobs/${WO_REFUSED}/complete`, {
      consumedSerials: [SN_COLLEAGUE],
      consumedProductId: SPARE,
    });
    assert.equal(noVersion.status, 400, JSON.stringify(noVersion.json));
    assert.deepEqual(Object.keys(noVersion.json).sort(), ['message'], 'a validation refusal is `{ message }`');
    assert.match(noVersion.json.message, /baseVersion is required/i);
    assert.equal((await workOrder(WO_REFUSED)).status, 'ASSIGNED');
  });
});
