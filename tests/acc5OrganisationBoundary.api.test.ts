/**
 * ACC-5 — organisation, HR and permissions boundary.
 *
 * The claims are driven through real HTTP + PostgreSQL:
 *   1. a branch default and an employee default flow into payroll salary-cost
 *      lines, in that order, and an explicit line centre is preserved;
 *   2. an invalid centre is refused instead of being silently replaced;
 *   3. HR writes cannot post to the ledger or grant a finance permission;
 *   4. revoking a permission changes access, never the posted employee ledger;
 *   5. inventory adjustment, payment and period close remain separately gated.
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
import { ensureReferenceData } from './fixtures/referenceData';

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

const RUN_DATE = '2026-11-30';
const PERIOD = '2026-11';
const EXPLICIT_PERIOD = '2026-10';

const ADMIN = {
  id: 'acc5-admin',
  email: 'acc5-admin@example.com',
  name: 'ACC5 Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const HR_MANAGER = {
  id: 'acc5-hr',
  email: 'acc5-hr@example.com',
  name: 'ACC5 HR Manager',
  role: 'HR_MANAGER',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const AUDITOR = {
  id: 'acc5-auditor',
  email: 'acc5-auditor@example.com',
  name: 'ACC5 Auditor',
  role: 'AUDITOR',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const INVENTORY_MANAGER = {
  id: 'acc5-inv',
  email: 'acc5-inv@example.com',
  name: 'ACC5 Inventory Manager',
  role: 'INVENTORY_MANAGER',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const BRANCH_MANAGER = {
  id: 'acc5-branch-manager',
  email: 'acc5-branch-manager@example.com',
  name: 'ACC5 Branch Manager',
  role: 'BRANCH_MANAGER',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('organisation defaults and HR/finance boundary (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const hrToken = issueAuthToken(HR_MANAGER);
  const auditorToken = issueAuthToken(AUDITOR);
  const inventoryToken = issueAuthToken(INVENTORY_MANAGER);
  const branchManagerToken = issueAuthToken(BRANCH_MANAGER);

  let branchA = '';
  let branchB = '';
  let centerA = '';
  let centerB = '';
  let sharedCenter = '';
  let employeeA = '';
  let employeeB = '';
  let journalA = '';
  let explicitJournal = '';

  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    auth = adminToken
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + auth,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  const get = (path: string, auth = adminToken) => request('GET', path, undefined, auth);
  const post = (path: string, body: unknown, auth = adminToken) => request('POST', path, body, auth);
  const put = (path: string, body: unknown, auth = adminToken) => request('PUT', path, body, auth);
  const patch = (path: string, body: unknown, auth = adminToken) => request('PATCH', path, body, auth);

  async function createBranch(code: string, name: string) {
    const created = await post('/api/branches', {
      code,
      name,
      location: 'ACC5 Test',
      phone: '+977-1-4200000',
      active: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    return created.json.id as string;
  }

  async function setBranchDefault(branchId: string, centerId: string | null) {
    const branch = (await get('/api/branches')).json?.find?.(
      (row: any) => row.id === branchId
    );
    // The branch list is the read surface; the PUT carries every field because
    // the admin route is a full replacement, not a sparse PATCH.
    const existing = branch || {};
    return put(`/api/branches/${branchId}`, {
      code: existing.code,
      name: existing.name,
      location: existing.location,
      phone: existing.phone || '',
      isHeadquarters: Boolean(existing.isHeadquarters),
      active: existing.active !== false,
      allowProcurement: existing.allowProcurement !== false,
      allowWarehouseTransfer: existing.allowWarehouseTransfer !== false,
      defaultCostCenterId: centerId,
    });
  }

  async function createEmployee(code: string, branchId: string, defaultCostCenterId?: string | null) {
    const created = await post('/api/employees', {
      employeeCode: code,
      name: `ACC5 ${code}`,
      branchId,
      defaultCostCenterId: defaultCostCenterId ?? null,
      employmentType: 'Permanent',
      joiningDateAD: '2025-01-01',
      monthlySalary: 1000,
      ssfEligible: false,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    return created.json;
  }

  async function payroll(branchId: string, lines: any[], period = PERIOD, dateAD = RUN_DATE) {
    const created = await post('/api/payroll-runs', {
      branchId,
      periodKey: period,
      runDateAD: dateAD,
      lines,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    return created.json;
  }

  async function salaryCostLines(journalId: string) {
    const result = await pool!.query(
      `SELECT l.cost_center_id AS "costCenterId",
              cc.code AS "costCenterCode",
              l.debit::numeric AS debit
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
         LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id
        WHERE l.journal_id = $1 AND a.posting_role = 'SALARY_EXPENSE'
        ORDER BY l.line_no ASC`,
      [journalId]
    );
    return result.rows.map((row: any) => ({ ...row, debit: Number(row.debit) }));
  }

  async function journalSnapshot(journalId: string) {
    const result = await pool!.query(
      `SELECT j.id, j.branch_id AS "branchId",
              COALESCE(SUM(l.debit), 0)::numeric AS "totalDebit",
              COALESCE(SUM(l.credit), 0)::numeric AS "totalCredit",
              COUNT(l.id)::int AS "lineCount",
              COALESCE(SUM(l.debit), 0)::numeric AS "debitSum"
         FROM gl_journals j
         LEFT JOIN gl_journal_lines l ON l.journal_id = j.id
        WHERE j.id = $1
        GROUP BY j.id, j.branch_id`,
      [journalId]
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          branchId: row.branchId,
          totalDebit: Number(row.totalDebit),
          totalCredit: Number(row.totalCredit),
          lineCount: Number(row.lineCount),
          debitSum: Number(row.debitSum),
        }
      : null;
  }

  before(async () => {
    await ensureReferenceData(pool!, RUN_DATE);
    await ensureReferenceData(pool!, '2026-10-31');
    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);

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

    const suffix = String(Date.now()).slice(-6);
    branchA = await createBranch(`A5A${suffix}`, 'ACC5 Branch A');
    branchB = await createBranch(`A5B${suffix}`, 'ACC5 Branch B');

    const center = async (code: string, branchId: string | null) => {
      const created = await post('/api/accounting/cost-centers', {
        code,
        name: `ACC5 ${code}`,
        branchId,
        active: true,
      });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      return created.json.id as string;
    };
    centerA = await center(`A5CA${suffix}`, branchA);
    centerB = await center(`A5CB${suffix}`, branchB);
    sharedCenter = await center(`A5CS${suffix}`, null);

    const updatedA = await setBranchDefault(branchA, centerA);
    assert.equal(updatedA.status, 200, JSON.stringify(updatedA.json));
    const updatedB = await setBranchDefault(branchB, centerB);
    assert.equal(updatedB.status, 200, JSON.stringify(updatedB.json));
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await pool.query(
        `DELETE FROM gl_journals WHERE branch_id IN (SELECT id FROM branches WHERE code LIKE 'A5%') OR source_id LIKE 'acc5-%'`
      );
      await pool.query(
        `DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_runs WHERE branch_id IN (SELECT id FROM branches WHERE code LIKE 'A5%'))`
      );
      await pool.query(
        `DELETE FROM payroll_runs WHERE branch_id IN (SELECT id FROM branches WHERE code LIKE 'A5%')`
      );
      await pool.query(
        `DELETE FROM employees WHERE branch_id IN (SELECT id FROM branches WHERE code LIKE 'A5%')`
      );
      await pool.query(
        `UPDATE branches SET default_cost_center_id = NULL WHERE code LIKE 'A5%'`
      );
      await pool.query(`DELETE FROM cost_centers WHERE code LIKE 'A5C%'`);
      await pool.query(`DELETE FROM branches WHERE code LIKE 'A5%'`);
      await pool.query(`DELETE FROM users WHERE email LIKE 'acc5-%@example.com'`);
      await pool.end();
    }
  });

  test('branch and employee defaults split payroll cost; explicit line centre wins', async () => {
    const a = await createEmployee('ACC5-001', branchA);
    const b = await createEmployee('ACC5-002', branchA, sharedCenter);
    employeeA = a.id;
    employeeB = b.id;
    assert.equal(a.defaultCostCenterId, null);
    assert.equal(b.defaultCostCenterId, sharedCenter);

    const runA = await payroll(branchA, [
      { employeeId: a.id, gross: 1000, tds: 0, ssf: 0, advance: 0, loan: 0 },
      { employeeId: b.id, gross: 2000, tds: 0, ssf: 0, advance: 0, loan: 0 },
    ]);
    journalA = runA.journal.id;
    const linesA = await salaryCostLines(journalA);
    assert.deepEqual(
      linesA.map((line) => [line.costCenterId, line.debit]),
      [
        [centerA, 1000],
        [sharedCenter, 2000],
      ],
      'employee default beats branch default; no employee default falls back to the branch'
    );
    assert.equal((await journalSnapshot(journalA))?.branchId, branchA);

    const c = await createEmployee('ACC5-003', branchB);
    const runB = await payroll(branchB, [
      { employeeId: c.id, gross: 3000, tds: 0, ssf: 0, advance: 0, loan: 0 },
    ]);
    const linesB = await salaryCostLines(runB.journal.id);
    assert.deepEqual(linesB.map((line) => [line.costCenterId, line.debit]), [[centerB, 3000]]);

    // A different period for the same branch: the operator's explicit centre
    // must survive even though the employee's stored default is the shared one.
    const runExplicit = await payroll(
      branchA,
      [{ employeeId: b.id, gross: 500, tds: 0, ssf: 0, advance: 0, loan: 0, costCenterId: centerA }],
      EXPLICIT_PERIOD,
      '2026-10-30'
    );
    explicitJournal = runExplicit.journal.id;
    const explicitLines = await salaryCostLines(explicitJournal);
    assert.deepEqual(explicitLines.map((line) => [line.costCenterId, line.debit]), [[centerA, 500]]);

    const invalidEmployee = await post('/api/employees', {
      employeeCode: 'ACC5-BAD',
      name: 'ACC5 Bad Default',
      branchId: branchA,
      defaultCostCenterId: centerB,
      joiningDateAD: '2026-01-01',
    });
    assert.equal(invalidEmployee.status, 400, JSON.stringify(invalidEmployee.json));
    assert.match(invalidEmployee.json.message, /default cost centre/i);

    const invalidBranch = await put(`/api/branches/${branchA}`, {
      code: 'A5INVALID',
      name: 'ACC5 Invalid Branch',
      location: 'Test',
      defaultCostCenterId: centerB,
    });
    assert.equal(invalidBranch.status, 400, JSON.stringify(invalidBranch.json));
    assert.match(invalidBranch.json.message, /default cost centre/i);
  });

  test('HR cannot grant a finance permission and cannot rewrite a posted journal', async () => {
    const before = await journalSnapshot(journalA);
    assert.ok(before && before.lineCount > 0);

    const hrEmployee = await createEmployee('ACC5-HR1', branchA);
    const withLogin = await post('/api/employees', {
      employeeCode: 'ACC5-HR2',
      name: 'ACC5 HR Login',
      branchId: branchA,
      internalEmail: `acc5-hr-login-${Date.now()}@example.com`,
      joiningDateAD: '2026-01-01',
      createLogin: true,
      loginRole: 'FRONT_DESK',
    });
    assert.equal(withLogin.status, 201, JSON.stringify(withLogin.json));
    assert.ok(withLogin.json.login);

    const hrGrant = await post(
      '/api/employees',
      {
        employeeCode: 'ACC5-HR3',
        name: 'ACC5 HR Grant',
        branchId: branchA,
        internalEmail: `acc5-hr-grant-${Date.now()}@example.com`,
        joiningDateAD: '2026-01-01',
        createLogin: true,
        loginRole: 'ACCOUNTANT',
      },
      hrToken
    );
    assert.equal(hrGrant.status, 403, JSON.stringify(hrGrant.json));

    const hrRoleChange = await patch(
      `/api/employees/${withLogin.json.id}`,
      { loginRole: 'ACCOUNTANT' },
      hrToken
    );
    assert.equal(hrRoleChange.status, 403, JSON.stringify(hrRoleChange.json));

    const hrJournal = await post(
      '/api/accounting/journals',
      {
        journalDateAD: RUN_DATE,
        branchId: branchA,
        memo: 'HR must not post',
        lines: [],
      },
      hrToken
    );
    assert.equal(hrJournal.status, 403, JSON.stringify(hrJournal.json));

    const hrFinanceOperations = await Promise.all([
      post(`/api/accounting/periods/missing/close`, {}, hrToken),
      patch(`/api/stock/missing`, { quantityOnHand: 1 }, hrToken),
      post('/api/vendor-payments', {}, hrToken),
    ]);
    for (const refused of hrFinanceOperations) {
      assert.equal(refused.status, 403, JSON.stringify(refused.json));
    }

    const hrEdit = await patch(
      `/api/employees/${hrEmployee.id}`,
      { name: 'ACC5 HR Renamed', journalId: journalA, lines: [{ debit: 1, credit: 1 }] },
      hrToken
    );
    assert.equal(hrEdit.status, 200, JSON.stringify(hrEdit.json));
    assert.equal(hrEdit.json.name, 'ACC5 HR Renamed');

    const after = await journalSnapshot(journalA);
    assert.deepEqual(after, before, 'an HR employee write must not touch a posted journal');
  });

  test('a permission change changes access but never rewrites the employee ledger', async () => {
    const ledgerBefore = await get(`/api/employees/${employeeA}/ledger?branchId=${branchA}`, auditorToken);
    assert.equal(ledgerBefore.status, 200, JSON.stringify(ledgerBefore.json));
    const journalBefore = await journalSnapshot(journalA);
    assert.ok(journalBefore);

    const refusals = await Promise.all([
      post(`/api/accounting/periods/missing/close`, {}, auditorToken),
      patch(`/api/stock/missing`, { quantityOnHand: 1 }, auditorToken),
      post('/api/vendor-payments', {}, auditorToken),
    ]);
    for (const refused of refusals) {
      assert.equal(refused.status, 403, JSON.stringify(refused.json));
    }

    const inventoryClose = await post(`/api/accounting/periods/missing/close`, {}, inventoryToken);
    assert.equal(inventoryClose.status, 403, JSON.stringify(inventoryClose.json));
    const managerEmployee = await patch(`/api/employees/${employeeA}`, { name: 'Nope' }, branchManagerToken);
    assert.equal(managerEmployee.status, 403, JSON.stringify(managerEmployee.json));

    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    matrix['gl-view'].AUDITOR = false;
    const changed = await put('/api/permissions', { matrix });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    try {
      const revoked = await get(`/api/employees/${employeeA}/ledger?branchId=${branchA}`, auditorToken);
      assert.equal(revoked.status, 403, JSON.stringify(revoked.json));
      assert.deepEqual(await journalSnapshot(journalA), journalBefore);
      const ledgerRows = await pool!.query(
        `SELECT COUNT(*)::int AS count FROM gl_subledger_entries WHERE party_id = $1`,
        [employeeA]
      );
      assert.ok(Number(ledgerRows.rows[0].count) >= 1, 'the employee ledger rows remain in PostgreSQL');
    } finally {
      const restored = await put('/api/permissions', {
        matrix: JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)),
      });
      assert.equal(restored.status, 200, JSON.stringify(restored.json));
    }

    const ledgerAfter = await get(`/api/employees/${employeeA}/ledger?branchId=${branchA}`, auditorToken);
    assert.equal(ledgerAfter.status, 200, JSON.stringify(ledgerAfter.json));
    assert.deepEqual(ledgerAfter.json.totals, ledgerBefore.json.totals);
  });
});
