/**
 * MyWorkplace v2 — dispatch override rules and proof-of-work evidence, over the
 * real mobile routes against PostgreSQL.
 *
 * Pin:
 *   1. a normal dispatch (technician rostered, under the day's ceiling) assigns
 *      the job and records NO override;
 *   2. without a roster seat the dispatch is refused with `DISPATCH_RULE`, a
 *      reason shorter than 15 characters is a 400, and a supervisor's reason
 *      assigns the job while the order records the reason, the person and the
 *      waived rule (`NO_ROSTER_SEAT`);
 *   3. a non-supervisor cannot waive a rule even with a reason (403);
 *   4. a photo captured on site is stored once (content-addressed): the second
 *      send of the same bytes answers `inserted: false` with `count: 1`;
 *   5. bad evidence is refused (content type, future capture time) and another
 *      employee cannot attach evidence to a job that is not theirs.
 */
import { purgeAuditLogs } from './support/purgeAuditLogs';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (dispatch/evidence writes)';

const BRANCH = 'dsp-test-branch';
const CUSTOMER = 'dsp-test-customer';
const SHIFT = 'dsp-test-shift';
const EMP_MGR = 'dsp-test-emp-mgr';
const EMP_TECH = 'dsp-test-emp-tech';
const EMP_OTHER = 'dsp-test-emp-other';

const USER_MGR = {
  id: 'dsp-test-user-mgr', email: 'dsp-mgr@example.com', name: 'Dispatch Manager',
  role: 'BRANCH_MANAGER', branchId: BRANCH, allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;
const USER_TECH = {
  id: 'dsp-test-user-tech', email: 'dsp-tech@example.com', name: 'Dispatch Tech',
  role: 'FIELD_TECHNICIAN', branchId: BRANCH, allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('workplace dispatch override and evidence (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const managerToken = issueAuthToken(USER_MGR);
  const techToken = issueAuthToken(USER_TECH);
  let orderAssigned = '';
  let orderOpen = '';

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, auth?: string) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + (auth || managerToken),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* tolerated */
    }
    return { status: res.status, json };
  }

  async function insertOrder(status: string, technicianId: string | null, technicianName: string | null) {
    const row = (
      await pool!.query(
        `INSERT INTO field_work_orders
           (work_order_no, branch_id, customer_id, kind, status, technician_id,
            technician_name, scheduled_date_ad, notes, created_by)
         VALUES ('WO-DSP-' || nextval('field_work_order_no_seq'), $1, $2, 'SERVICE', $3, $4, $5,
                 CURRENT_DATE, '', 'dsp-test')
         RETURNING id`,
        [BRANCH, CUSTOMER, status, technicianId, technicianName]
      )
    ).rows[0];
    return String(row.id);
  }

  async function cleanup() {
    await pool!.query("DELETE FROM field_work_order_evidence WHERE branch_id = $1", [BRANCH]);
    await pool!.query("DELETE FROM field_work_orders WHERE branch_id = $1", [BRANCH]);
    await pool!.query("DELETE FROM customer_records WHERE id = $1", [CUSTOMER]);
    await pool!.query("DELETE FROM employee_shift_roster WHERE branch_id = $1", [BRANCH]);
    await pool!.query("DELETE FROM hr_shifts WHERE id = $1", [SHIFT]);
    await pool!.query("UPDATE employees SET user_id = NULL WHERE branch_id = $1", [BRANCH]);
    await pool!.query("DELETE FROM employees WHERE branch_id = $1", [BRANCH]);
    await pool!.query("DELETE FROM users WHERE id LIKE 'dsp-test-user-%'");
    await pool!.query("DELETE FROM branches WHERE id = $1", [BRANCH]);
    await purgeAuditLogs(pool!, "DELETE FROM audit_logs WHERE branch_id = $1", [BRANCH]);
  }

  before(async () => {
    await cleanup();
    const { ensurePostgresConnection } = await import('../server/db');
    assert.equal(await ensurePostgresConnection(), true, 'the dev database must be reachable');
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'DSPT', 'Dispatch Test', 'Test')`,
      [BRANCH]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, is_demo)
       VALUES ($1, $1, 'Dispatch Customer', '9800000000', $2, FALSE)`,
      [CUSTOMER, BRANCH]
    );
    for (const user of [USER_MGR, USER_TECH]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'x', $3, $4, $5, ARRAY[$5::varchar]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId]
      );
    }
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
       VALUES ($1, 'DSP-M', 'Dispatch Manager', $4, $5, 'Field'),
              ($2, 'DSP-T', 'Dispatch Tech', $4, $6, 'Field'),
              ($3, 'DSP-O', 'Other Tech', $4, NULL, 'Field')`,
      [EMP_MGR, EMP_TECH, EMP_OTHER, BRANCH, USER_MGR.id, USER_TECH.id]
    );
    await pool!.query(
      `INSERT INTO hr_shifts (id, code, name, start_time, end_time) VALUES ($1, 'DSP-SHIFT', 'Dispatch Day', '09:00', '18:00')`,
      [SHIFT]
    );
    await pool!.query(
      `INSERT INTO employee_shift_roster (id, employee_id, shift_id, branch_id, shift_date_ad)
       VALUES ('dsp-test-roster', $1, $2, $3, CURRENT_DATE)`,
      [EMP_TECH, SHIFT, BRANCH]
    );

    orderAssigned = await insertOrder('ASSIGNED', EMP_TECH, 'Dispatch Tech');
    orderOpen = await insertOrder('OPEN', null, null);

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

  test('a rostered technician under the cap is dispatched with no override recorded', async () => {
    const dispatched = await request('POST', `/api/v1/workplace/jobs/${orderOpen}/assign`, {
      technicianId: EMP_TECH,
    });
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.json));
    assert.equal(dispatched.json.status, 'ASSIGNED');
    assert.equal(dispatched.json.technicianId, EMP_TECH);
    assert.equal(dispatched.json.overridden, false);

    const stored = await pool!.query(
      `SELECT technician_id, dispatch_override_reason, dispatch_override_rules
         FROM field_work_orders WHERE id = $1`,
      [orderOpen]
    );
    assert.equal(stored.rows[0].technician_id, EMP_TECH);
    assert.equal(stored.rows[0].dispatch_override_reason, null);
    assert.deepEqual(stored.rows[0].dispatch_override_rules, []);
  });

  test('no roster seat refuses, a short reason is a 400, and a supervisor reason records the waiver', async () => {
    await pool!.query("DELETE FROM employee_shift_roster WHERE branch_id = $1", [BRANCH]);
    const order = await insertOrder('OPEN', null, null);

    const refused = await request('POST', `/api/v1/workplace/jobs/${order}/assign`, { technicianId: EMP_TECH });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'DISPATCH_RULE');
    assert.match(refused.json.message, /roster seat/);

    const shortReason = await request('POST', `/api/v1/workplace/jobs/${order}/assign`, {
      technicianId: EMP_TECH,
      overrideReason: 'too short',
    });
    assert.equal(shortReason.status, 400, JSON.stringify(shortReason.json));

    const overridden = await request('POST', `/api/v1/workplace/jobs/${order}/assign`, {
      technicianId: EMP_TECH,
      overrideReason: 'Emergency callout: customer offline since last night',
    });
    assert.equal(overridden.status, 200, JSON.stringify(overridden.json));
    assert.equal(overridden.json.overridden, true);
    assert.deepEqual(overridden.json.overrideRules, ['NO_ROSTER_SEAT']);

    const stored = await pool!.query(
      `SELECT dispatch_override_reason, dispatch_override_by, dispatch_override_at, dispatch_override_rules
         FROM field_work_orders WHERE id = $1`,
      [order]
    );
    assert.match(stored.rows[0].dispatch_override_reason, /Emergency callout/);
    assert.equal(stored.rows[0].dispatch_override_by, USER_MGR.email);
    assert.ok(stored.rows[0].dispatch_override_at);
    assert.deepEqual(stored.rows[0].dispatch_override_rules, ['NO_ROSTER_SEAT']);

    const audit = await pool!.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE branch_id = $1 AND action = 'MOBILE_DISPATCH_OVERRIDE'`,
      [BRANCH]
    );
    assert.equal(audit.rows[0].n, 1, 'the waiver is audited');
  });

  test('a technician cannot waive a dispatch rule', async () => {
    const order = await insertOrder('OPEN', null, null);
    const denied = await request(
      'POST',
      `/api/v1/workplace/jobs/${order}/assign`,
      { technicianId: EMP_TECH, overrideReason: 'I am allowed to decide this myself' },
      techToken
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
  });

  test('a capture is stored once and the second send of the same bytes replays it', async () => {
    const first = await request(
      'POST',
      `/api/v1/workplace/jobs/${orderAssigned}/evidence`,
      { kind: 'PHOTO', contentType: 'image/png', dataBase64: PNG_BASE64, caption: 'ONT installed' },
      techToken
    );
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.inserted, true);
    assert.equal(first.json.count, 1);
    assert.equal(first.json.kind, 'PHOTO');
    assert.match(first.json.sha256, /^[a-f0-9]{64}$/);

    const replay = await request(
      'POST',
      `/api/v1/workplace/jobs/${orderAssigned}/evidence`,
      { kind: 'PHOTO', contentType: 'image/png', dataBase64: PNG_BASE64 },
      techToken
    );
    assert.equal(replay.status, 201, JSON.stringify(replay.json));
    assert.equal(replay.json.inserted, false);
    assert.equal(replay.json.count, 1);
    assert.equal(replay.json.evidenceId, first.json.evidenceId);

    const list = await request('GET', `/api/v1/workplace/jobs/${orderAssigned}/evidence`, undefined, techToken);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.count, 1);
    assert.equal(list.json.evidence[0].caption, 'ONT installed');
  });

  test('the ceiling is 2 MiB of bytes, above the default JSON body limit', async () => {
    // A 1.5 MiB photo is ~2 MB of base64 on the wire: the evidence routes must
    // accept it (they carry their own body limit) or the declared 2 MiB ceiling
    // is unreachable — the generic 1 MB parser used to answer 413 first.
    const order = await insertOrder('OPEN', EMP_TECH, 'Dispatch Tech');
    const bytes = crypto.randomBytes(1_500_000);
    const stored = await request(
      'POST',
      `/api/v1/workplace/jobs/${order}/evidence`,
      { kind: 'PHOTO', contentType: 'image/png', dataBase64: bytes.toString('base64') },
      techToken
    );
    assert.equal(stored.status, 201, JSON.stringify(stored.json).slice(0, 200));
    assert.equal(stored.json.byteSize, 1_500_000);
    assert.equal(stored.json.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));

    const overCeiling = crypto.randomBytes(2 * 1024 * 1024 + 1);
    const refused = await request(
      'POST',
      `/api/v1/workplace/jobs/${order}/evidence`,
      { kind: 'PHOTO', contentType: 'image/png', dataBase64: overCeiling.toString('base64') },
      techToken
    );
    assert.equal(refused.status, 400, JSON.stringify(refused.json).slice(0, 200));
    assert.match(refused.json.message, /ceiling is 2097152/);
  });

  test('bad evidence is refused and another employee cannot attach to this job', async () => {
    const badType = await request(
      'POST',
      `/api/v1/workplace/jobs/${orderAssigned}/evidence`,
      { kind: 'PHOTO', contentType: 'application/pdf', dataBase64: PNG_BASE64 },
      techToken
    );
    assert.equal(badType.status, 400, JSON.stringify(badType.json));

    const future = await request(
      'POST',
      `/api/v1/workplace/jobs/${orderAssigned}/evidence`,
      {
        kind: 'SIGNATURE',
        contentType: 'image/png',
        dataBase64: PNG_BASE64,
        capturedAtEpochMs: Date.now() + 60 * 60 * 1000,
      },
      techToken
    );
    assert.equal(future.status, 400, JSON.stringify(future.json));
    assert.match(future.json.message, /ahead of the server/);

    const orderNotMine = await insertOrder('OPEN', EMP_OTHER, 'Other Tech');
    const notMine = await request(
      'POST',
      `/api/v1/workplace/jobs/${orderNotMine}/evidence`,
      { kind: 'PHOTO', contentType: 'image/png', dataBase64: PNG_BASE64 },
      techToken
    );
    assert.equal(notMine.status, 404, JSON.stringify(notMine.json));
  });
});
