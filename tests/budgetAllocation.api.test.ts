/**
 * Cost-centre allocation API — real Express app against real PostgreSQL.
 *
 * The fixture owns a branch, two expense groups, four expense accounts, two
 * branch cost centres and a small FY budget. It posts three tagged expense
 * lines and one untagged line, then proves:
 *
 *   - DEFAULT rules apply to groups without an override;
 *   - an OPERATING_EXPENSE override replaces only that group;
 *   - the exact 100% and branch/centre validation refusals are honest;
 *   - department budgets are allocated in cents without losing a rupee;
 *   - tagged actuals are never re-spread, and untagged actuals stay explicit;
 *   - the department tie-out equals the budget-vs-actual expense totals.
 *
 * The fiscal year is resolved by code so the suite works against both a booted
 * database (`fy-2083`) and a schema-only CI database (`fy-4`).
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
import { ensureBsDayRecords, ensureReferenceData } from './fixtures/referenceData';

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

const BR = 'BGA';
const OTHER = 'BGB';
const FY_CODE = '2083-84';
const FROM = '2026-07-17';
const TO = '2027-07-16';
const USERS = {
  super: {
    id: 'bga-super',
    email: 'bga-super@example.com',
    name: 'BGA Super',
    role: 'SUPER_ADMIN',
    branchId: 'ALL',
    allowedBranchIds: [],
    canSwitchUser: false,
  },
  accountant: {
    id: 'bga-accountant',
    email: 'bga-accountant@example.com',
    name: 'BGA Accountant',
    role: 'ACCOUNTANT',
    branchId: BR,
    allowedBranchIds: [BR],
    canSwitchUser: false,
  },
  noView: {
    id: 'bga-frontdesk',
    email: 'bga-frontdesk@example.com',
    name: 'BGA Front Desk',
    role: 'FRONT_DESK',
    branchId: BR,
    allowedBranchIds: [BR],
    canSwitchUser: false,
  },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

describe('budget allocation API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let fiscalYearId = '';
  let realFrom = FROM;
  let realTo = TO;
  const accounts: Record<string, string> = {};
  const centres: Record<string, string> = {};

  async function request(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    token?: string,
    body?: unknown
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
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

  const get = (path: string, token?: string) => request('GET', path, token);
  const put = (path: string, token: string | undefined, body: unknown) =>
    request('PUT', path, token, body);
  const post = (path: string, token: string | undefined, body: unknown) =>
    request('POST', path, token, body);

  async function createGroup(
    code: string,
    name: string,
    statementGroup: string,
    accountType = 'EXPENSE'
  ) {
    const res = await post('/api/accounting/groups', tokens.super, {
      code,
      name,
      accountType,
      statementGroup,
    });
    assert.equal(res.status, 201, `group ${code}: ${JSON.stringify(res.json)}`);
    return res.json.id as string;
  }

  async function createAccount(input: Record<string, unknown>) {
    const res = await post('/api/accounting/accounts', tokens.super, input);
    assert.equal(res.status, 201, `account ${String(input.code)}: ${JSON.stringify(res.json)}`);
    return res.json.id as string;
  }

  async function createCentre(code: string, name: string, branchId: string) {
    const res = await post('/api/accounting/cost-centers', tokens.super, {
      code,
      name,
      branchId,
    });
    assert.equal(res.status, 201, `cost centre ${code}: ${JSON.stringify(res.json)}`);
    return res.json.id as string;
  }

  async function postJournal(
    date: string,
    branchId: string,
    sourceId: string,
    memo: string,
    lines: unknown[]
  ) {
    const res = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: date,
      branchId,
      sourceId,
      memo,
      lines,
    });
    assert.equal(res.status, 201, `journal ${sourceId}: ${JSON.stringify(res.json)}`);
    return res.json;
  }

  function allocationPath(extra = '') {
    return `/api/accounting/budgets/allocation?fiscalYearId=${fiscalYearId}&branchId=${BR}${extra}`;
  }

  function departmentPath(extra = '') {
    return `/api/accounting/budgets/variance/departments?fiscalYearId=${fiscalYearId}&branchId=${BR}${extra}`;
  }

  function rulesDefault(cc1 = 60, cc2 = 40) {
    return [
      { accountGroup: 'DEFAULT', costCenterId: centres.cc1, percentage: cc1 },
      { accountGroup: 'DEFAULT', costCenterId: centres.cc2, percentage: cc2 },
    ];
  }

  function rulesWithOverride(cc1 = 60, cc2 = 40, op1 = 25, op2 = 75) {
    return [
      ...rulesDefault(cc1, cc2),
      { accountGroup: 'OPERATING_EXPENSE', costCenterId: centres.cc1, percentage: op1 },
      { accountGroup: 'OPERATING_EXPENSE', costCenterId: centres.cc2, percentage: op2 },
    ];
  }

  async function saveAllocation(token: string | undefined, rules: unknown[]) {
    return put('/api/accounting/budgets/allocation', token, {
      fiscalYearId,
      branchId: BR,
      rules,
    });
  }

  async function cleanup() {
    if (!pool) return;
    await pool.query("DELETE FROM audit_logs WHERE details LIKE '%BGA Allocation%'");
    await pool.query('DELETE FROM gl_budget_allocation_profiles WHERE branch_id IN ($1, $2)', [
      BR,
      OTHER,
    ]);
    await pool.query(
      'DELETE FROM gl_budgets WHERE fiscal_year_id IN (SELECT id FROM fiscal_years WHERE code = $1) AND branch_id IN ($2, $3)',
      [FY_CODE, BR, OTHER]
    );
    await pool.query("DELETE FROM gl_journals WHERE source_id LIKE 'bga-%' OR memo LIKE 'BGA %'");
    await pool.query("DELETE FROM gl_accounts WHERE code LIKE 'BGA-%'");
    await pool.query("DELETE FROM gl_account_groups WHERE code LIKE 'BGA-%'");
    await pool.query("DELETE FROM cost_centers WHERE code LIKE 'BGA-%'");
    await pool.query('DELETE FROM branches WHERE id IN ($1, $2)', [BR, OTHER]);
  }

  before(async () => {
    await ensureReferenceData(pool!, '2026-08-10');
    await ensureBsDayRecords(pool!, ['2026-08-10', '2026-08-15', '2026-08-20', '2026-08-25']);

    const fiscalYear = (
      await pool!.query(
        'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE code = $1 ORDER BY start_date_ad DESC LIMIT 1',
        [FY_CODE]
      )
    ).rows[0];
    assert.ok(fiscalYear, `fiscal year ${FY_CODE} must exist`);
    fiscalYearId = String(fiscalYear.id);
    realFrom = String(fiscalYear.startDateAD);
    realTo = String(fiscalYear.endDateAD);

    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
        ($1, 'BGAB', 'BGA Allocation Branch', 'Test'),
        ($2, 'BGBB', 'BGA Other Branch', 'Test')`,
      [BR, OTHER]
    );

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

    const assetGroup = await createGroup('BGA-AS', 'BGA Test Assets', 'CURRENT_ASSET', 'ASSET');
    const opexGroup = await createGroup('BGA-OE', 'BGA Operating Expenses', 'OPERATING_EXPENSE');
    const cosGroup = await createGroup('BGA-COS', 'BGA Cost of Sales', 'COST_OF_SALES');
    accounts.cash = await createAccount({
      code: 'BGA-1010',
      name: 'BGA Test Cash',
      groupId: assetGroup,
    });
    accounts.op1 = await createAccount({
      code: 'BGA-6100',
      name: 'BGA NOC Expense',
      groupId: opexGroup,
    });
    accounts.op2 = await createAccount({
      code: 'BGA-6200',
      name: 'BGA Field Expense',
      groupId: opexGroup,
    });
    accounts.cos = await createAccount({
      code: 'BGA-5000',
      name: 'BGA Bandwidth Cost',
      groupId: cosGroup,
    });

    centres.cc1 = await createCentre('BGA-CC1', 'BGA NOC', BR);
    centres.cc2 = await createCentre('BGA-CC2', 'BGA Field Ops', BR);
    centres.other = await createCentre('BGA-CC3', 'BGA Other Centre', OTHER);

    await postJournal('2026-08-10', BR, 'bga-j1', 'BGA tagged NOC expense', [
      { accountId: accounts.op1, costCenterId: centres.cc1, debit: 100, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 100 },
    ]);
    await postJournal('2026-08-15', BR, 'bga-j2', 'BGA tagged field expense', [
      { accountId: accounts.op2, costCenterId: centres.cc2, debit: 50, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 50 },
    ]);
    await postJournal('2026-08-20', BR, 'bga-j3', 'BGA tagged bandwidth cost', [
      { accountId: accounts.cos, costCenterId: centres.cc1, debit: 40, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 40 },
    ]);
    await postJournal('2026-08-25', BR, 'bga-j4', 'BGA untagged expense', [
      { accountId: accounts.op1, debit: 25, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 25 },
    ]);
    await postJournal('2026-08-25', OTHER, 'bga-j5', 'BGA other branch expense', [
      { accountId: accounts.op1, debit: 999, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 999 },
    ]);

    const budget = await put('/api/accounting/budgets', tokens.super, {
      fiscalYearId,
      branchId: BR,
      lines: [
        { periodKey: '2026-08', accountId: accounts.op1, amount: 600 },
        { periodKey: '2026-09', accountId: accounts.op2, amount: 400 },
        { periodKey: '2026-08', accountId: accounts.cos, amount: 500 },
      ],
    });
    assert.equal(budget.status, 200, `seed budget: ${JSON.stringify(budget.json)}`);
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('starts without a profile and refuses consolidated allocation reads', async () => {
    const read = await get(allocationPath(), tokens.super);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.equal(read.json.status, 'MISSING');
    assert.equal(read.json.profileId, null);
    assert.equal(read.json.totalExpenseBudget, 1500);
    assert.equal(read.json.groups.find((g: any) => g.accountGroup === 'OPERATING_EXPENSE').budget, 1000);
    assert.equal(read.json.groups.find((g: any) => g.accountGroup === 'COST_OF_SALES').budget, 500);
    assert.ok(read.json.centres.some((centre: any) => centre.id === centres.cc1));

    const all = await get(
      `/api/accounting/budgets/allocation?fiscalYearId=${fiscalYearId}&branchId=ALL`,
      tokens.super
    );
    assert.equal(all.status, 400);
    assert.match(all.json.message, /Choose a branch/i);
  });

  test('saves a branch default plus an operating-expense override', async () => {
    const saved = await saveAllocation(tokens.super, rulesWithOverride());
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.status, 'READY');
    assert.equal(saved.json.rules.length, 4);
    const defaultRules = saved.json.rules.filter((r: any) => r.accountGroup === 'DEFAULT');
    assert.deepEqual(defaultRules.map((r: any) => r.percentageBp), [6000, 4000]);
    const opexRules = saved.json.rules.filter((r: any) => r.accountGroup === 'OPERATING_EXPENSE');
    assert.deepEqual(opexRules.map((r: any) => r.percentageBp), [2500, 7500]);

    const opex = saved.json.groups.find((g: any) => g.accountGroup === 'OPERATING_EXPENSE');
    assert.equal(opex.hasOverride, true);
    assert.equal(opex.rules.length, 2);
    const cos = saved.json.groups.find((g: any) => g.accountGroup === 'COST_OF_SALES');
    assert.equal(cos.hasOverride, false);
    assert.deepEqual(cos.rules.map((r: any) => r.costCenterId), [centres.cc1, centres.cc2]);
    assert.equal(saved.json.locked, false);
  });

  test('department preview allocates group budgets and keeps untagged actual explicit', async () => {
    const read = await get(departmentPath(`&from=${realFrom}&to=${realTo}`), tokens.super);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.equal(read.json.status, 'READY');
    assert.deepEqual(read.json.totals, {
      expenseBudget: 1500,
      allocatedBudget: 1500,
      expenseActual: 215,
      taggedActual: 190,
      unallocatedActual: 25,
    });
    assert.deepEqual(read.json.coverage, {
      totalExpenseLines: 4,
      taggedExpenseLines: 3,
      untaggedExpenseLines: 1,
      taggedPercent: 75,
    });
    assert.deepEqual(read.json.unallocated, { actual: 25, lineCount: 1 });
    assert.deepEqual(read.json.tieOut, {
      budgetDifference: 0,
      actualDifference: 0,
      reconciled: true,
    });

    const cc1 = read.json.departments.find((d: any) => d.costCenterId === centres.cc1);
    const cc2 = read.json.departments.find((d: any) => d.costCenterId === centres.cc2);
    assert.ok(cc1 && cc2);
    assert.deepEqual(
      {
        budget: cc1.budget,
        actual: cc1.actual,
        variance: cc1.variance,
        variancePercent: cc1.variancePercent,
        utilisationPercent: cc1.utilisationPercent,
        lineCount: cc1.lineCount,
        inAllocation: cc1.inAllocation,
      },
      {
        budget: 550,
        actual: 140,
        variance: 410,
        variancePercent: 74.55,
        utilisationPercent: 25.45,
        lineCount: 2,
        inAllocation: true,
      }
    );
    assert.deepEqual(
      {
        budget: cc2.budget,
        actual: cc2.actual,
        variance: cc2.variance,
        variancePercent: cc2.variancePercent,
        utilisationPercent: cc2.utilisationPercent,
        lineCount: cc2.lineCount,
        inAllocation: cc2.inAllocation,
      },
      {
        budget: 950,
        actual: 50,
        variance: 900,
        variancePercent: 94.74,
        utilisationPercent: 5.26,
        lineCount: 1,
        inAllocation: true,
      }
    );
    assert.ok(!read.json.departments.some((d: any) => d.costCenterId === centres.other));
  });

  test('refuses incomplete totals, duplicate centres, foreign branches and unknown groups', async () => {
    const incomplete = await saveAllocation(tokens.super, rulesDefault(59.99, 40));
    assert.equal(incomplete.status, 400, JSON.stringify(incomplete.json));
    assert.match(incomplete.json.message, /100%/);

    const duplicate = await saveAllocation(tokens.super, [
      { accountGroup: 'DEFAULT', costCenterId: centres.cc1, percentage: 60 },
      { accountGroup: 'DEFAULT', costCenterId: centres.cc1, percentage: 40 },
    ]);
    assert.equal(duplicate.status, 400, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /twice/);

    const foreign = await saveAllocation(tokens.super, [
      { accountGroup: 'DEFAULT', costCenterId: centres.other, percentage: 100 },
    ]);
    assert.equal(foreign.status, 400, JSON.stringify(foreign.json));
    assert.match(foreign.json.message, /does not exist in this branch/);

    const unknownGroup = await saveAllocation(tokens.super, [
      ...rulesDefault(),
      { accountGroup: 'NOT_A_GROUP', costCenterId: centres.cc1, percentage: 100 },
    ]);
    assert.equal(unknownGroup.status, 400, JSON.stringify(unknownGroup.json));
    assert.match(unknownGroup.json.message, /not an expense statement group/);

    const noDefault = await saveAllocation(tokens.super, [
      { accountGroup: 'OPERATING_EXPENSE', costCenterId: centres.cc1, percentage: 100 },
    ]);
    assert.equal(noDefault.status, 400, JSON.stringify(noDefault.json));
    assert.match(noDefault.json.message, /branch default/i);

    const still = await get(allocationPath(), tokens.super);
    assert.equal(still.status, 200);
    assert.equal(still.json.rules.length, 4, 'refused saves must not change the stored profile');
  });

  test('enforces permission and branch scope on reads and writes', async () => {
    assert.equal((await get(allocationPath(), tokens.noView)).status, 403);
    assert.equal((await get(departmentPath(), tokens.noView)).status, 403);
    assert.equal((await saveAllocation(tokens.noView, rulesWithOverride())).status, 403);

    const foreignWrite = await put('/api/accounting/budgets/allocation', tokens.accountant, {
      fiscalYearId,
      branchId: OTHER,
      rules: rulesWithOverride(),
    });
    assert.equal(foreignWrite.status, 403, JSON.stringify(foreignWrite.json));

    const ownRead = await get(allocationPath(), tokens.accountant);
    assert.equal(ownRead.status, 200, JSON.stringify(ownRead.json));
  });

  test('a locked budget refuses allocation changes and unlocking restores them', async () => {
    const locked = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId,
      branchId: BR,
      locked: true,
    });
    assert.equal(locked.status, 200, JSON.stringify(locked.json));

    const refused = await saveAllocation(tokens.super, rulesWithOverride(50, 50, 50, 50));
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.match(refused.json.message, /locked/i);

    const unlocked = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId,
      branchId: BR,
      locked: false,
    });
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked.json));

    const saved = await saveAllocation(tokens.super, rulesWithOverride(50, 50, 50, 50));
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(
      saved.json.rules.filter((r: any) => r.accountGroup === 'DEFAULT').map((r: any) => r.percentageBp),
      [5000, 5000]
    );
  });

  test('writes an audit row for each accepted allocation save', async () => {
    const audit = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'SAVE_GL_BUDGET_ALLOCATION' AND details LIKE '%BGA Allocation%'"
    );
    assert.ok(audit.rows[0].count >= 2, 'accepted saves must be audited');
  });

  test('the seeded KTM branch preview shows tagged department actuals and reconciles', async () => {
    const seeded = await pool!.query(
      "SELECT 1 FROM branches b JOIN gl_budget_allocation_profiles p ON p.branch_id = b.id WHERE b.id = 'BR-KTM' AND p.fiscal_year_id = $1",
      [fiscalYearId]
    );
    if (!seeded.rowCount) return; // schema-only CI has no canonical demo seed

    const profile = await get(
      `/api/accounting/budgets/allocation?fiscalYearId=${fiscalYearId}&branchId=BR-KTM`,
      tokens.super
    );
    assert.equal(profile.status, 200, JSON.stringify(profile.json));
    assert.equal(profile.json.status, 'READY');
    assert.equal(profile.json.rules.length, 5);

    const preview = await get(
      `/api/accounting/budgets/variance/departments?fiscalYearId=${fiscalYearId}&branchId=BR-KTM&from=${realFrom}&to=${realTo}`,
      tokens.super
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.status, 'READY');
    assert.equal(preview.json.totals.expenseActual, 172700);
    assert.equal(preview.json.totals.taggedActual, 172700);
    // The verification dataset includes a 100 credit reclassification (demo-health-difference),
    // so the net expense actual is 172,700. The demo budget is 80,000 per month (30,000 + 50,000). The
    // preview counts the monthly budgets whose period BEGINS inside the
    // window, and FY 2083-84 starts on 2026-07-17 while the July period begins
    // on 2026-07-01 — so eleven periods, not twelve: 11 x 80,000.
    assert.equal(preview.json.totals.allocatedBudget, 880000);
    assert.equal(preview.json.totals.unallocatedActual, 0, 'every demo expense line is tagged');
    assert.equal(preview.json.tieOut.budgetDifference, 0);
    assert.equal(preview.json.tieOut.actualDifference, 0);
    assert.equal(preview.json.tieOut.reconciled, true);

    const departments = new Map<string, any>(
      preview.json.departments.map((department: any) => [department.code, department])
    );
    assert.deepEqual(
      ['CC-01-EXEC', 'CC-02-FIN', 'CC-03-OPS', 'CC-04-COMM', 'CC-05-CX'].map((code) =>
        [departments.get(code)?.actual, departments.get(code)?.budget]
      ),
      [
        [0, 88000],
        [1100, 176000],
        [171600, 352000],
        [0, 132000],
        [0, 132000],
      ],
      'the demo branch shows real actuals under the seeded cost centres'
    );
  });
});
