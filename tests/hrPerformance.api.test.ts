import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * Phase 4 performance API — real HTTP + PostgreSQL.
 *
 * The fixture creates a branch-scoped cycle, weights it with goals, collects
 * 360 feedback and signs it off. It then proves the plan's acceptance rule:
 * sign-off locks every later cycle/goal/feedback write. A second manager
 * proves branch custody and the validation cases prove the schema-facing
 * guarantees (real dates, one feedback row per reviewer/subject, self-feedback
 * identity, and the DRAFT→OPEN→feedback order).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 2000,
    });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH_A = 'hr-perf-br-a';
const BRANCH_B = 'hr-perf-br-b';

const MANAGER_A = {
  id: 'hr-perf-user-a',
  email: 'hr-perf-a@example.com',
  name: 'Performance Manager A',
  role: 'HR_MANAGER',
  branchId: BRANCH_A,
  allowedBranchIds: [BRANCH_A],
  canSwitchUser: false,
} as any;

const MANAGER_B = {
  id: 'hr-perf-user-b',
  email: 'hr-perf-b@example.com',
  name: 'Performance Manager B',
  role: 'HR_MANAGER',
  branchId: BRANCH_B,
  allowedBranchIds: [BRANCH_B],
  canSwitchUser: false,
} as any;

describe('HR performance API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const managerAToken = issueAuthToken(MANAGER_A);
  const managerBToken = issueAuthToken(MANAGER_B);
  let employeeA1: any;
  let employeeA2: any;
  let employeeB: any;
  let employeeB2: any;
  let cycleAId = '';
  let goalAId = '';

  async function cleanup() {
    await pool!.query('DELETE FROM hr_review_feedback WHERE branch_id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
    await pool!.query('DELETE FROM hr_goals WHERE branch_id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
    await pool!.query('DELETE FROM hr_review_cycles WHERE branch_id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
    await purgeAuditLogs(pool!, 'DELETE FROM audit_logs WHERE branch_id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
    await pool!.query(
      'DELETE FROM employees WHERE branch_id = ANY($1::varchar[]) AND employee_code LIKE $2',
      [[BRANCH_A, BRANCH_B], 'PERF-%']
    );
    await pool!.query('DELETE FROM users WHERE id LIKE $1', ['hr-perf-user-%']);
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
  }

  async function request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    auth: string | null,
    payload?: unknown
  ) {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bearer ${auth}`;
    let body: string | undefined;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON errors are asserted by status/message */
    }
    return { status: res.status, json, headers: res.headers, text };
  }

  function employeeBody(code: string, branchId: string) {
    return {
      employeeCode: code,
      name: `Performance Employee ${code}`,
      branchId,
      department: 'Operations',
      designation: 'Analyst',
      joiningDateAD: '2026-01-01',
      monthlySalary: 50000,
    };
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'PFA', 'Performance Branch A', 'Test'),
              ($2, 'PFB', 'Performance Branch B', 'Test')`,
      [BRANCH_A, BRANCH_B]
    );
    for (const user of [MANAGER_A, MANAGER_B]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, $4, $5, ARRAY[$6]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId, user.branchId]
      );
    }

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

    employeeA1 = (await request('POST', '/api/employees', managerAToken, employeeBody('PERF-001', BRANCH_A))).json;
    employeeA2 = (await request('POST', '/api/employees', managerAToken, employeeBody('PERF-002', BRANCH_A))).json;
    employeeB = (await request('POST', '/api/employees', managerBToken, employeeBody('PERF-003', BRANCH_B))).json;
    employeeB2 = (await request('POST', '/api/employees', managerBToken, employeeBody('PERF-004', BRANCH_B))).json;
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('creates a cycle, goals and 360 feedback, then locks every write after sign-off', async () => {
    const cycle = await request('POST', '/api/hr/performance/cycles', managerAToken, {
      branchId: BRANCH_A,
      name: 'FY 2083/84 Annual Review',
      periodStartAD: '2026-04-01',
      periodEndAD: '2027-03-31',
      status: 'DRAFT',
      instructions: 'Complete goals before the review meeting.',
    });
    assert.equal(cycle.status, 201, JSON.stringify(cycle.json));
    cycleAId = cycle.json.id;
    assert.equal(cycle.json.cycleNo.startsWith('CYCLE-'), true);
    assert.equal(cycle.json.branchId, BRANCH_A);
    assert.equal(cycle.json.status, 'DRAFT');
    assert.equal(cycle.json.goalCount, 0);

    const opened = await request('PATCH', `/api/hr/performance/cycles/${cycleAId}`, managerAToken, {
      status: 'OPEN',
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.equal(opened.json.status, 'OPEN');

    const goal = await request('POST', '/api/hr/performance/goals', managerAToken, {
      cycleId: cycleAId,
      employeeId: employeeA1.id,
      title: 'Reduce branch downtime',
      description: 'Keep core network availability above target.',
      weight: 60,
      targetValue: '99.5% uptime',
      managerRating: 4.5,
      finalRating: 4.5,
      status: 'COMPLETED',
    });
    assert.equal(goal.status, 201, JSON.stringify(goal.json));
    goalAId = goal.json.id;
    assert.equal(goal.json.branchId, BRANCH_A);
    assert.equal(goal.json.employeeCode, 'PERF-001');
    assert.equal(goal.json.weight, 60);
    assert.equal(goal.json.finalRating, 4.5);

    const feedback = await request('POST', '/api/hr/performance/feedback', managerAToken, {
      cycleId: cycleAId,
      employeeId: employeeA1.id,
      reviewerEmployeeId: employeeA2.id,
      relationship: 'PEER',
      rating: 4,
      strengths: 'Reliable incident response',
      improvements: 'Document the runbook',
      comments: 'Strong technical partner.',
    });
    assert.equal(feedback.status, 201, JSON.stringify(feedback.json));
    assert.equal(feedback.json.branchId, BRANCH_A);
    assert.equal(feedback.json.employeeName, 'Performance Employee PERF-001');
    assert.equal(feedback.json.reviewerEmployeeName, 'Performance Employee PERF-002');

    const cycles = await request('GET', `/api/hr/performance/cycles?branchId=${BRANCH_A}`, managerAToken);
    assert.equal(cycles.status, 200);
    assert.equal(cycles.headers.get('cache-control'), 'private, no-store');
    assert.equal(cycles.json.length, 1);
    assert.equal(cycles.json[0].goalCount, 1);
    assert.equal(cycles.json[0].employeeCount, 1);
    assert.equal(cycles.json[0].feedbackCount, 1);

    const goals = await request(
      'GET',
      `/api/hr/performance/goals?cycleId=${cycleAId}&employeeId=${employeeA1.id}`,
      managerAToken
    );
    assert.equal(goals.status, 200);
    assert.equal(goals.json.length, 1);
    assert.equal(goals.json[0].cycleStatus, 'OPEN');

    const signOff = await request(
      'POST',
      `/api/hr/performance/cycles/${cycleAId}/sign-off`,
      managerAToken,
      {}
    );
    assert.equal(signOff.status, 200, JSON.stringify(signOff.json));
    assert.equal(signOff.json.status, 'SIGNED_OFF');
    assert.equal(signOff.json.signedOffBy, MANAGER_A.email);
    assert.ok(signOff.json.signedOffAt);

    const lockedCycle = await request(
      'PATCH',
      `/api/hr/performance/cycles/${cycleAId}`,
      managerAToken,
      { name: 'Should not change' }
    );
    assert.equal(lockedCycle.status, 409);
    assert.match(lockedCycle.json.message, /signed off and is locked/i);

    const lockedGoal = await request(
      'POST',
      '/api/hr/performance/goals',
      managerAToken,
      { cycleId: cycleAId, employeeId: employeeA1.id, title: 'Late goal', weight: 20 }
    );
    assert.equal(lockedGoal.status, 409);
    assert.match(lockedGoal.json.message, /signed off and is locked/i);

    const lockedGoalEdit = await request(
      'PATCH',
      `/api/hr/performance/goals/${goalAId}`,
      managerAToken,
      { title: 'Late edit' }
    );
    assert.equal(lockedGoalEdit.status, 409);

    const lockedFeedback = await request(
      'POST',
      '/api/hr/performance/feedback',
      managerAToken,
      {
        cycleId: cycleAId,
        employeeId: employeeA1.id,
        reviewerEmployeeId: employeeA1.id,
        relationship: 'SELF',
        rating: 5,
      }
    );
    assert.equal(lockedFeedback.status, 409);
    assert.match(lockedFeedback.json.message, /signed off and is locked/i);

    const row = (
      await pool!.query(
        `SELECT status, signed_off_by, signed_off_at
         FROM hr_review_cycles WHERE id = $1`,
        [cycleAId]
      )
    ).rows[0];
    assert.equal(row.status, 'SIGNED_OFF');
    assert.ok(row.signed_off_at);
  });

  test('refuses another branch, widening ALL, unknown/repeated filters and direct cross-branch edits', async () => {
    const foreignRead = await request(
      'GET',
      `/api/hr/performance/cycles?branchId=${BRANCH_A}`,
      managerBToken
    );
    assert.equal(foreignRead.status, 403);

    const ownRead = await request('GET', '/api/hr/performance/cycles', managerBToken);
    assert.equal(ownRead.status, 200);
    assert.deepEqual(ownRead.json, []);

    const foreignCreate = await request('POST', '/api/hr/performance/cycles', managerBToken, {
      branchId: BRANCH_A,
      name: 'Foreign cycle',
      periodStartAD: '2026-01-01',
      periodEndAD: '2026-12-31',
    });
    assert.equal(foreignCreate.status, 403);

    const foreignGoal = await request('POST', '/api/hr/performance/goals', managerBToken, {
      cycleId: cycleAId,
      employeeId: employeeB.id,
      title: 'Foreign goal',
      weight: 50,
    });
    assert.equal(foreignGoal.status, 403);

    const foreignFeedback = await request('POST', '/api/hr/performance/feedback', managerBToken, {
      cycleId: cycleAId,
      employeeId: employeeA1.id,
      reviewerEmployeeId: employeeA2.id,
      relationship: 'PEER',
      rating: 4,
    });
    assert.equal(foreignFeedback.status, 403);

    const directCycle = await request(
      'PATCH',
      `/api/hr/performance/cycles/${cycleAId}`,
      managerBToken,
      { name: 'Direct edit' }
    );
    assert.equal(directCycle.status, 403);

    const validStatus = await request('GET', '/api/hr/performance/cycles?status=OPEN', managerAToken);
    assert.equal(validStatus.status, 200);

    for (const query of ['?status=OPEN&status=DRAFT', '?branchId=ALL', '?owner=me']) {
      const refused = await request('GET', `/api/hr/performance/cycles${query}`, managerAToken);
      assert.equal(refused.status, 403, `${query} must be refused`);
    }
  });

  test('validates dates, cycle ordering, duplicate goals and self-feedback identity', async () => {
    const badDate = await request('POST', '/api/hr/performance/cycles', managerBToken, {
      branchId: BRANCH_B,
      name: 'Bad date cycle',
      periodStartAD: '2026-02-30',
      periodEndAD: '2026-03-31',
    });
    assert.equal(badDate.status, 400);

    const backwards = await request('POST', '/api/hr/performance/cycles', managerBToken, {
      branchId: BRANCH_B,
      name: 'Backwards cycle',
      periodStartAD: '2026-12-31',
      periodEndAD: '2026-01-01',
    });
    assert.equal(backwards.status, 400);

    const directSignOff = await request('POST', '/api/hr/performance/cycles', managerBToken, {
      branchId: BRANCH_B,
      name: 'Already closed',
      periodStartAD: '2026-01-01',
      periodEndAD: '2026-12-31',
      status: 'SIGNED_OFF',
    });
    assert.equal(directSignOff.status, 400);

    const draft = await request('POST', '/api/hr/performance/cycles', managerBToken, {
      branchId: BRANCH_B,
      name: 'Draft cycle B',
      periodStartAD: '2026-01-01',
      periodEndAD: '2026-12-31',
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));

    const feedbackTooEarly = await request('POST', '/api/hr/performance/feedback', managerBToken, {
      cycleId: draft.json.id,
      employeeId: employeeB.id,
      reviewerEmployeeId: employeeB.id,
      relationship: 'SELF',
      rating: 4,
    });
    assert.equal(feedbackTooEarly.status, 409);
    assert.match(feedbackTooEarly.json.message, /open the cycle/i);

    const foreignEmployeeGoal = await request('POST', '/api/hr/performance/goals', managerBToken, {
      cycleId: draft.json.id,
      employeeId: employeeA1.id,
      title: 'Wrong branch employee',
      weight: 50,
    });
    assert.equal(foreignEmployeeGoal.status, 400);

    const firstGoal = await request('POST', '/api/hr/performance/goals', managerBToken, {
      cycleId: draft.json.id,
      employeeId: employeeB.id,
      title: 'Improve dispatch accuracy',
      weight: 50,
    });
    assert.equal(firstGoal.status, 201, JSON.stringify(firstGoal.json));

    const duplicateGoal = await request('POST', '/api/hr/performance/goals', managerBToken, {
      cycleId: draft.json.id,
      employeeId: employeeB.id,
      title: 'improve dispatch accuracy',
      weight: 25,
    });
    assert.equal(duplicateGoal.status, 409);

    const opened = await request('PATCH', `/api/hr/performance/cycles/${draft.json.id}`, managerBToken, {
      status: 'OPEN',
    });
    assert.equal(opened.status, 200);

    const selfMismatch = await request('POST', '/api/hr/performance/feedback', managerBToken, {
      cycleId: draft.json.id,
      employeeId: employeeB.id,
      reviewerEmployeeId: employeeB2.id,
      relationship: 'SELF',
      rating: 4,
    });
    assert.equal(selfMismatch.status, 400);
    assert.match(selfMismatch.json.message, /self feedback/i);
  });
});
