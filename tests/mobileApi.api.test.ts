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
const SHIFT = 'mob-test-shift';
const FENCE_LAT = 27.7172;
const FENCE_LNG = 85.324;

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
    await pool!.query("DELETE FROM employee_location_breadcrumbs WHERE employee_id LIKE 'mob-test-emp%'");
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
    for (const user of [USER, USER_OTHER]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7]::text[], 'active')`,
        [user.id, user.email, user.password, user.name, user.role, user.branchId, user.branchId]
      );
    }
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
       VALUES ($1, 'MOB-001', 'Mobile Test Employee', $2, $3, 'Field'),
              ($4, 'MOB-002', 'Mobile Other Employee', $5, $6, 'Field')`,
      [EMP, BRANCH, USER.id, EMP_OTHER, OTHER_BRANCH, USER_OTHER.id]
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

    const outside = await request('POST', '/api/v1/workplace/attendance/punch', {
      ...punch,
      action: 'CLOCK_OUT',
      latitude: FENCE_LAT + 0.02,
      longitude: FENCE_LNG,
      punchTime: '18:05',
      idempotencyKey: 'mob-test-punch-2',
    });
    assert.equal(outside.status, 422, JSON.stringify(outside.json));
    assert.match(outside.json.message, /geofence/i);

    const boot = await request('GET', '/api/v1/workplace/bootstrap');
    assert.equal(boot.json.punchState, 'CLOCKED_IN');
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
});
