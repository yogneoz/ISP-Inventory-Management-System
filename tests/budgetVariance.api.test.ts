/**
 * Budgets and budget-vs-actual — real Express app against real PostgreSQL.
 *
 * The fixture creates a dedicated branch, a profit-and-loss chart slice and a
 * budget, then posts real journals through the public route. The assertions
 * pin the sign convention (`variance = budget - actual`, positive = remaining),
 * the percentage (`variance / budget * 100`, null when budget is zero) and the
 * four required shapes: budget with no actuals, actuals over budget, actuals
 * exactly on budget, and each side without the other. A final tie-out compares
 * the variance actuals with the profit-and-loss statement for the same branch
 * and window, proving both read the same POSTED journal lines.
 *
 * The suite owns a throwaway database because its ALL-branch reads are
 * company-wide totals: another parallel test posting a journal would otherwise
 * change those totals mid-run. A schema-only throwaway also makes the suite
 * independent of whichever fiscal-year row a dev database happens to hold.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase, type ThrowawayDatabase } from './fixtures/throwawayDatabase';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

dotenv.config();

const TEST_DB = 'inventory_budget_variance_test';
let pool: pg.Pool | null = null;
let throwaway: ThrowawayDatabase | null = null;
let dbReachable = false;
if (process.env.DATABASE_URL) {
  const probe = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    dbReachable = true;
  } catch {
    dbReachable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BR = 'BGTBR';
const OTHER = 'BGTBR2';
const FY_CODE = '2083-84';
const FROM = '2026-07-17';
const TO = '2026-10-31';
// The seeded dev database already owns every calendar-month period in this
// fiscal year, so the fixture uses its own 7-character key on the same dates
// instead of colliding with (or closing) the demo calendar.
const CLOSED_PERIOD_KEY = 'BGT-001';
const CLOSED_PERIOD_ID = 'bgt-period-2027-06';
const TARGET_FY_ID = 'bgt-fy-2084-85';
const TARGET_FY_CODE = 'BGT-2084-85';
const TARGET_PERIOD_KEYS = [
  '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12',
  '2028-01', '2028-02', '2028-03', '2028-04', '2028-05', '2028-06',
];
const SOURCE_PERIOD_KEYS = [
  '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
  '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06',
];

const USERS = {
  super: { id: 'bgt-super', email: 'bgt-super@example.com', name: 'BGT Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  accountant: { id: 'bgt-accountant', email: 'bgt-accountant@example.com', name: 'BGT Accountant', role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  auditor: { id: 'bgt-auditor', email: 'bgt-auditor@example.com', name: 'BGT Auditor', role: 'AUDITOR', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  noView: { id: 'bgt-frontdesk', email: 'bgt-frontdesk@example.com', name: 'BGT Front Desk', role: 'FRONT_DESK', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  noBranch: { id: 'bgt-empty', email: 'bgt-empty@example.com', name: 'BGT Empty', role: 'ACCOUNTANT', branchId: '', allowedBranchIds: [], canSwitchUser: false },
} as const;

let tokens = {} as Record<keyof typeof USERS, string>;
let resetPermissionMatrix: (() => void) | null = null;

describe('budget variance API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let fiscalYearId = '';
  let realFrom = FROM;
  let realTo = TO;
  let closedStartBS = '';
  let closedEndBS = '';
  const accounts: Record<string, string> = {};

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
    try { json = await res.json(); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  const get = (path: string, token?: string) => request('GET', path, token);
  const put = (path: string, token: string | undefined, body: unknown) => request('PUT', path, token, body);
  const post = (path: string, token: string | undefined, body: unknown) => request('POST', path, token, body);

  async function createGroup(code: string, name: string, accountType: string, statementGroup: string) {
    const res = await post('/api/accounting/groups', tokens.super, { code, name, accountType, statementGroup });
    assert.equal(res.status, 201, `group ${code}: ${JSON.stringify(res.json)}`);
    return res.json.id as string;
  }

  async function createAccount(input: Record<string, unknown>) {
    const res = await post('/api/accounting/accounts', tokens.super, input);
    assert.equal(res.status, 201, `account ${String(input.code)}: ${JSON.stringify(res.json)}`);
    return res.json.id as string;
  }

  async function postJournal(date: string, branchId: string, sourceId: string, memo: string, lines: unknown[]) {
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

  async function saveBudget(lines: unknown[]) {
    return put('/api/accounting/budgets', tokens.super, {
      fiscalYearId,
      branchId: BR,
      lines,
    });
  }

  async function saveBudgetFor(branchId: string, lines: unknown[], yearId = fiscalYearId) {
    return put('/api/accounting/budgets', tokens.super, {
      fiscalYearId: yearId,
      branchId,
      lines,
    });
  }

  function originalBudgetLines() {
    return [
      { periodKey: '2026-08', accountId: accounts.noActual, amount: 1000 },
      { periodKey: '2026-08', accountId: accounts.over, amount: 300 },
      { periodKey: '2026-09', accountId: accounts.over, amount: 200 },
      { periodKey: '2026-08', accountId: accounts.exact, amount: 400 },
      { periodKey: '2026-08', accountId: accounts.income, amount: 800 },
    ];
  }

  function rowsByCode(json: any) {
    return new Map<string, any>((json.rows || []).map((row: any) => [row.code, row]));
  }

  function varianceQuery(extra = '') {
    return `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&branchId=${BR}` +
      `&from=${realFrom}&to=${realTo}${extra}`;
  }

  async function cleanup() {
    if (!pool) return;
    await pool.query("DELETE FROM audit_logs WHERE details LIKE '%BGT Budget%'");
    await pool.query(
      'DELETE FROM gl_budgets WHERE fiscal_year_id IN (SELECT id FROM fiscal_years WHERE code = $1) AND branch_id IN ($2, $3)',
      [FY_CODE, BR, OTHER]
    );
    await pool.query('DELETE FROM gl_budgets WHERE fiscal_year_id = $1', [TARGET_FY_ID]);
    await pool.query('DELETE FROM gl_periods WHERE fiscal_year_id = $1', [TARGET_FY_ID]);
    await pool.query('DELETE FROM fiscal_years WHERE id = $1', [TARGET_FY_ID]);
    await pool.query("DELETE FROM gl_journals WHERE source_id LIKE 'bgt-%' OR memo LIKE 'BGT %'");
    await pool.query('DELETE FROM gl_periods WHERE id = $1', [CLOSED_PERIOD_ID]);
    await pool.query("DELETE FROM gl_accounts WHERE code LIKE 'BGT-%'");
    await pool.query("DELETE FROM gl_account_groups WHERE code LIKE 'BGT-%'");
    await pool.query('DELETE FROM branches WHERE id IN ($1, $2)', [BR, OTHER]);
  }

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) return;
    throwaway = await createThrowawayDatabase(base, TEST_DB);
    process.env.DATABASE_URL = throwaway.url;

    // Import the app only after pointing DATABASE_URL at the throwaway: db.ts
    // builds its pool from that variable at module load.
    const { createApp, registerAllRoutes } = await import('../server/src/app');
    const { realPoolInstance, ensurePostgresConnection } = await import('../server/db');
    realPoolInstance?.on?.('error', () => undefined);
    assert.equal(await ensurePostgresConnection(), true, 'the throwaway database must be reachable');
    const { ensureReferenceData, ensureBsDayRecords } = await import('./fixtures/referenceData');
    pool = throwaway.pool;

    await ensureReferenceData(pool, '2026-08-10');
    await cleanup();

    const fiscalYear = (
      await pool!.query(
        'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE code = $1 ORDER BY start_date_ad DESC LIMIT 1',
        [FY_CODE]
      )
    ).rows[0];
    assert.ok(fiscalYear, `fiscal year ${FY_CODE} must exist`);
    fiscalYearId = String(fiscalYear.id);
    realFrom = String(fiscalYear.startDateAD);
    realTo = TO;

    // Provision the full source-year period calendar. Copy-forward maps periods
    // by ordinal position, so relying on only the periods a journal happened to
    // create would make the July-to-August mapping depend on prior DB state.
    const sourcePeriods = SOURCE_PERIOD_KEYS.map((periodKey, index) => {
      const [year, month] = periodKey.split('-').map(Number);
      return {
        periodKey,
        startDate: index === 0 ? String(fiscalYear.startDateAD) : `${periodKey}-01`,
        endDate: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
      };
    });
    const sourceBsDates = await ensureBsDayRecords(pool!, [
      ...sourcePeriods.flatMap((period) => [period.startDate, period.endDate]),
      '2026-08-10', '2026-08-15', '2026-08-20', '2026-08-25', '2026-08-28', '2026-08-30',
      '2026-09-05',
      '2026-11-10',
    ]);
    closedStartBS = sourceBsDates.get('2027-06-01')!;
    closedEndBS = sourceBsDates.get('2027-06-30')!;
    assert.ok(closedStartBS && closedEndBS, 'the source-year June period needs BS bounds');
    for (const period of sourcePeriods) {
      const startBs = sourceBsDates.get(period.startDate);
      const endBs = sourceBsDates.get(period.endDate);
      assert.ok(startBs && endBs, `BS dates for source period ${period.periodKey}`);
      await pool!.query(
        `INSERT INTO gl_periods
           (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')`,
        [
          `bgt-source-${period.periodKey}`,
          fiscalYearId,
          period.periodKey,
          period.startDate,
          startBs,
          period.endDate,
          endBs,
        ]
      );
    }

    await pool!.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs)
       VALUES ($1, $2, '2027-07-01', '2028-06-30', '2084-07-01', '2085-06-30')`,
      [TARGET_FY_ID, TARGET_FY_CODE]
    );
    const targetPeriods = TARGET_PERIOD_KEYS.map((periodKey) => {
      const [year, month] = periodKey.split('-').map(Number);
      return {
        periodKey,
        startDate: `${periodKey}-01`,
        endDate: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
      };
    });
    const targetBsDates = await ensureBsDayRecords(
      pool!,
      targetPeriods.flatMap((period) => [period.startDate, period.endDate])
    );
    for (const period of targetPeriods) {
      const startBs = targetBsDates.get(period.startDate);
      const endBs = targetBsDates.get(period.endDate);
      assert.ok(startBs && endBs, `BS dates for target period ${period.periodKey}`);
      await pool!.query(
        `INSERT INTO gl_periods
           (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')`,
        [
          `bgt-target-${period.periodKey}`,
          TARGET_FY_ID,
          period.periodKey,
          period.startDate,
          startBs,
          period.endDate,
          endBs,
        ]
      );
    }

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
        ($1, 'BGTB', 'BGT Budget Branch', 'Test'),
        ($2, 'BGTB2', 'BGT Other Branch', 'Test')`,
      [BR, OTHER]
    );

    // These modules import db.ts at load time, so they must also come after
    // DATABASE_URL points at the throwaway.
    const { issueAuthToken } = await import('../server/src/middleware/auth');
    const { setPermissionMatrix } = await import('../server/src/state/runtimeState');
    tokens = Object.fromEntries(
      Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
    ) as Record<keyof typeof USERS, string>;
    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);
    resetPermissionMatrix = () => setPermissionMatrix({});

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    const assetGroup = await createGroup('BGT-AS', 'BGT Test Assets', 'ASSET', 'CURRENT_ASSET');
    const expenseGroup = await createGroup('BGT-EX', 'BGT Test Expenses', 'EXPENSE', 'OPERATING_EXPENSE');
    const incomeGroup = await createGroup('BGT-IN', 'BGT Test Income', 'INCOME', 'REVENUE');

    accounts.cash = await createAccount({ code: 'BGT-1010', name: 'BGT Test Cash', groupId: assetGroup });
    accounts.noActual = await createAccount({ code: 'BGT-6100', name: 'BGT Budget With No Actual', groupId: expenseGroup });
    accounts.over = await createAccount({ code: 'BGT-6200', name: 'BGT Over Budget Expense', groupId: expenseGroup });
    accounts.exact = await createAccount({ code: 'BGT-6300', name: 'BGT Exactly On Budget', groupId: expenseGroup });
    accounts.actualOnly = await createAccount({ code: 'BGT-6400', name: 'BGT Actual Without Budget', groupId: expenseGroup });
    accounts.income = await createAccount({ code: 'BGT-4100', name: 'BGT Revenue Target', groupId: incomeGroup });

    // Post real journals first: on a schema-only database this lazily creates
    // the monthly periods the budget save then validates against.
    await postJournal('2026-08-10', BR, 'bgt-j1', 'BGT over-budget August', [
      { accountId: accounts.over, debit: 400, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 400 },
    ]);
    await postJournal('2026-09-05', BR, 'bgt-j2', 'BGT over-budget September', [
      { accountId: accounts.over, debit: 300, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 300 },
    ]);
    await postJournal('2026-08-15', BR, 'bgt-j3', 'BGT exactly on budget', [
      { accountId: accounts.exact, debit: 400, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 400 },
    ]);
    await postJournal('2026-08-20', BR, 'bgt-j4', 'BGT actual without budget', [
      { accountId: accounts.actualOnly, debit: 250, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 250 },
    ]);
    await postJournal('2026-08-25', BR, 'bgt-j5', 'BGT income target', [
      { accountId: accounts.cash, debit: 900, credit: 0 },
      { accountId: accounts.income, debit: 0, credit: 900 },
    ]);
    await postJournal('2026-08-30', OTHER, 'bgt-j6', 'BGT other branch over-budget', [
      { accountId: accounts.over, debit: 1000, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 1000 },
    ]);
    await postJournal('2026-11-10', BR, 'bgt-j7', 'BGT outside budget window', [
      { accountId: accounts.over, debit: 50, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 50 },
    ]);

    const saved = await saveBudget([
      { periodKey: '2026-08', accountId: accounts.noActual, amount: 1000 },
      { periodKey: '2026-08', accountId: accounts.over, amount: 300 },
      { periodKey: '2026-09', accountId: accounts.over, amount: 200 },
      { periodKey: '2026-08', accountId: accounts.exact, amount: 400 },
      { periodKey: '2026-08', accountId: accounts.income, amount: 800 },
    ]);
    assert.equal(saved.status, 200, `seed budget: ${JSON.stringify(saved.json)}`);
  });

  after(async () => {
    if (close) await close();
    resetPermissionMatrix?.();
    if (pool) {
      try {
        await cleanup();
      } finally {
        await pool.end();
        pool = null;
      }
    }
    try {
      const db = await import('../server/db');
      if (db.realPoolInstance) await db.realPoolInstance.end();
    } catch {
      /* best effort — the drop below forces the issue if this fails */
    }
    if (throwaway) {
      await dropThrowawayDatabase(throwaway.adminPool, TEST_DB);
      throwaway = null;
    }
  });

  test('variance pins budget, actual, variance and percentage for every required case', async () => {
    const res = await get(varianceQuery(), tokens.super);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.fiscalYearId, fiscalYearId);
    assert.equal(res.json.branchId, BR);
    assert.equal(res.json.from, realFrom);
    assert.equal(res.json.to, realTo);

    const rows = rowsByCode(res.json);
    assert.deepEqual(
      (({ budget, actual, variance, variancePercent }) => ({ budget, actual, variance, variancePercent }))(rows.get('BGT-6100')),
      { budget: 1000, actual: 0, variance: 1000, variancePercent: 100 },
      'a budget with no postings is fully remaining'
    );
    assert.deepEqual(
      (({ budget, actual, variance, variancePercent }) => ({ budget, actual, variance, variancePercent }))(rows.get('BGT-6200')),
      { budget: 500, actual: 700, variance: -200, variancePercent: -40 },
      'actuals over budget produce a negative variance and negative percentage'
    );
    assert.deepEqual(
      (({ budget, actual, variance, variancePercent }) => ({ budget, actual, variance, variancePercent }))(rows.get('BGT-6300')),
      { budget: 400, actual: 400, variance: 0, variancePercent: 0 },
      'actuals exactly on budget produce zero variance and zero percent'
    );
    assert.deepEqual(
      (({ budget, actual, variance, variancePercent }) => ({ budget, actual, variance, variancePercent }))(rows.get('BGT-6400')),
      { budget: 0, actual: 250, variance: -250, variancePercent: null },
      'an actual without a budget reports budget 0 and no invented percentage'
    );
    assert.deepEqual(
      (({ budget, actual, variance, variancePercent }) => ({ budget, actual, variance, variancePercent }))(rows.get('BGT-4100')),
      { budget: 800, actual: 900, variance: -100, variancePercent: -12.5 },
      'income is credit-positive, matching the statement presentation'
    );
    assert.deepEqual(
      res.json.totals,
      { budget: 2700, actual: 2250, variance: 450, variancePercent: 16.67 },
      'totals sum the same rows, including budget-only and actual-only accounts'
    );
    assert.equal(res.json.rows.length, 5);
  });

  test('variance actuals tie to the posted profit-and-loss statement, and the window is inclusive', async () => {
    const variance = await get(varianceQuery(), tokens.super);
    assert.equal(variance.status, 200, JSON.stringify(variance.json));

    const pnl = await get(
      `/api/accounting/statements/profit-and-loss?branchId=${BR}&from=${realFrom}&to=${realTo}`,
      tokens.super
    );
    assert.equal(pnl.status, 200, JSON.stringify(pnl.json));
    const operatingExpense = pnl.json.sections.find(
      (section: any) => section.statementGroup === 'OPERATING_EXPENSE'
    );
    const revenue = pnl.json.sections.find((section: any) => section.statementGroup === 'REVENUE');
    assert.ok(operatingExpense && revenue, 'the P&L must expose both statement groups');

    const expenseActual = variance.json.rows
      .filter((row: any) => row.accountType === 'EXPENSE')
      .reduce((sum: number, row: any) => sum + row.actual, 0);
    const incomeActual = variance.json.rows
      .filter((row: any) => row.accountType === 'INCOME')
      .reduce((sum: number, row: any) => sum + row.actual, 0);

    assert.equal(expenseActual, 1350, '400 + 300 + 400 + 250');
    assert.equal(operatingExpense.amount, expenseActual, 'the variance expense actual must equal the P&L expense total');
    assert.equal(incomeActual, 900);
    assert.equal(revenue.amount, incomeActual, 'the variance income actual must equal the P&L revenue total');
    assert.equal(
      rowsByCode(variance.json).get('BGT-6200').actual,
      700,
      'the 50 posted after the window and the 1000 in another branch are excluded'
    );
  });

  test('branch utilisation cards group the same rows and tie to the variance totals', async () => {
    const all = await get(
      `/api/accounting/budgets/variance/utilisation?fiscalYearId=${fiscalYearId}&from=${realFrom}&to=${realTo}`,
      tokens.super
    );
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal(all.json.fiscalYearCode, FY_CODE);
    assert.equal(all.json.branchId, 'ALL');
    assert.equal(all.json.from, realFrom);
    assert.equal(all.json.to, realTo);

    const cards = new Map<string, any>(
      all.json.branches.map((branch: any) => [branch.branchId, branch])
    );
    assert.ok(cards.has(BR), 'the budgeted test branch must have a card');
    assert.ok(cards.has(OTHER), 'the actual-only test branch must have a card');
    assert.deepEqual(cards.get(BR), {
      branchId: BR,
      code: 'BGTB',
      name: 'BGT Budget Branch',
      budget: 2700,
      actual: 2250,
      variance: 450,
      variancePercent: 16.67,
      utilisationPercent: 83.33,
    });
    assert.deepEqual(cards.get(OTHER), {
      branchId: OTHER,
      code: 'BGTB2',
      name: 'BGT Other Branch',
      budget: 0,
      actual: 1000,
      variance: -1000,
      variancePercent: null,
      utilisationPercent: null,
    });
    const consolidatedVariance = await get(
      `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&from=${realFrom}&to=${realTo}`,
      tokens.super
    );
    assert.equal(consolidatedVariance.status, 200, JSON.stringify(consolidatedVariance.json));
    assert.deepEqual(
      all.json.totals,
      consolidatedVariance.json.totals,
      'the cards use the same consolidated totals as the variance report'
    );
    const cardBudget = Math.round(
      all.json.branches.reduce((sum: number, branch: any) => sum + branch.budget, 0) * 100
    ) / 100;
    const cardActual = Math.round(
      all.json.branches.reduce((sum: number, branch: any) => sum + branch.actual, 0) * 100
    ) / 100;
    assert.equal(all.json.tieOut.cardBudget, cardBudget);
    assert.equal(all.json.tieOut.cardActual, cardActual);
    assert.deepEqual(
      {
        budget: all.json.tieOut.budget,
        actual: all.json.tieOut.actual,
        budgetDifference: all.json.tieOut.budgetDifference,
        actualDifference: all.json.tieOut.actualDifference,
        reconciled: all.json.tieOut.reconciled,
      },
      {
        budget: all.json.totals.budget,
        actual: all.json.totals.actual,
        budgetDifference: 0,
        actualDifference: 0,
        reconciled: true,
      }
    );

    const scoped = await get(
      `/api/accounting/budgets/variance/utilisation?fiscalYearId=${fiscalYearId}&branchId=${BR}&from=${realFrom}&to=${realTo}`,
      tokens.super
    );
    assert.equal(scoped.status, 200, JSON.stringify(scoped.json));
    assert.deepEqual(scoped.json.branches.map((branch: any) => branch.branchId), [BR]);
    assert.equal(scoped.json.branches[0].actual, 2250, 'the other branch is excluded');
    assert.equal(scoped.json.tieOut.reconciled, true);

    const narrowed = await get(
      `/api/accounting/budgets/variance/utilisation?fiscalYearId=${fiscalYearId}&from=${realFrom}&to=2026-08-31`,
      tokens.super
    );
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.json));
    const narrowedVariance = await get(
      `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&from=${realFrom}&to=2026-08-31`,
      tokens.super
    );
    assert.equal(narrowedVariance.status, 200, JSON.stringify(narrowedVariance.json));
    assert.deepEqual(
      narrowed.json.totals,
      narrowedVariance.json.totals,
      'narrowing the window keeps the cards and variance on one definition'
    );
    const narrowedCards = new Map<string, any>(
      narrowed.json.branches.map((branch: any) => [branch.branchId, branch])
    );
    assert.deepEqual(narrowedCards.get(BR), {
      branchId: BR,
      code: 'BGTB',
      name: 'BGT Budget Branch',
      budget: 2500,
      actual: 1950,
      variance: 550,
      variancePercent: 22,
      utilisationPercent: 78,
    });
    assert.equal(narrowedCards.get(OTHER).actual, 1000, 'the other branch stays in the ALL cards');
    assert.equal(narrowed.json.tieOut.reconciled, true);

    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/utilisation?fiscalYearId=${fiscalYearId}&branchId=${OTHER}&from=${realFrom}&to=${realTo}`,
        tokens.accountant
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/utilisation?fiscalYearId=${fiscalYearId}&from=${realFrom}&to=${realTo}`,
        tokens.noView
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/utilisation?fiscalYearId=${fiscalYearId}&from=${realFrom}&to=${realTo}`,
        tokens.noBranch
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/utilisation?from=${realFrom}&to=${realTo}`,
        tokens.super
      )).status,
      400
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/utilisation?fiscalYearId=${fiscalYearId}&from=2026-02-30&to=${realTo}`,
        tokens.super
      )).status,
      400
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/utilisation?fiscalYearId=${fiscalYearId}&branchId=BGT-NOPE&from=${realFrom}&to=${realTo}`,
        tokens.super
      )).status,
      400
    );
  });

  test('variance account drill-down returns the posted lines behind actual and ties out', async () => {
    const drill = await get(
      `/api/accounting/budgets/variance/lines?fiscalYearId=${fiscalYearId}&branchId=${BR}&accountId=${accounts.over}&from=${realFrom}&to=${realTo}`,
      tokens.super
    );
    assert.equal(drill.status, 200, JSON.stringify(drill.json));
    assert.equal(drill.json.account.code, 'BGT-6200');
    assert.equal(drill.json.account.actual, 700);
    assert.equal(drill.json.entries.length, 2);
    assert.deepEqual(
      drill.json.entries.map((entry: any) => [entry.journalDateAD, entry.debit, entry.amount]),
      [
        ['2026-08-10', 400, 400],
        ['2026-09-05', 300, 300],
      ],
      'lines are date-ordered and use expense natural-side actuals'
    );
    assert.deepEqual(drill.json.totals, { debit: 700, credit: 0, actual: 700, entryCount: 2 });
    assert.deepEqual(drill.json.tieOut, {
      budget: 500,
      actual: 700,
      variance: -200,
      variancePercent: -40,
      lineActual: 700,
      difference: 0,
      reconciled: true,
    });
    assert.equal(drill.json.truncated, false);

    const consolidated = await get(
      `/api/accounting/budgets/variance/lines?fiscalYearId=${fiscalYearId}&accountId=${accounts.over}&from=${realFrom}&to=${realTo}`,
      tokens.super
    );
    assert.equal(consolidated.status, 200, JSON.stringify(consolidated.json));
    assert.equal(consolidated.json.branchId, 'ALL');
    assert.equal(consolidated.json.entries.length, 3, 'the other branch line joins the ALL drill-down');
    assert.equal(consolidated.json.totals.actual, 1700);
    assert.equal(consolidated.json.tieOut.reconciled, true);

    const paged = await get(
      `/api/accounting/budgets/variance/lines?fiscalYearId=${fiscalYearId}&branchId=${BR}&accountId=${accounts.over}&from=${realFrom}&to=${realTo}&limit=1`,
      tokens.super
    );
    assert.equal(paged.status, 200, JSON.stringify(paged.json));
    assert.equal(paged.json.entries.length, 1);
    assert.equal(paged.json.totals.entryCount, 2);
    assert.equal(paged.json.truncated, true);
    assert.equal(paged.json.tieOut.lineActual, 700, 'totals are computed before the page limit');

    const narrowed = await get(
      `/api/accounting/budgets/variance/lines?fiscalYearId=${fiscalYearId}&branchId=${BR}&accountId=${accounts.over}&from=${realFrom}&to=2026-08-31`,
      tokens.super
    );
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.json));
    assert.equal(narrowed.json.account.actual, 400, 'the variance actual follows the same narrowed window');
    assert.equal(narrowed.json.entries.length, 1);
    assert.deepEqual(narrowed.json.tieOut, {
      budget: 300,
      actual: 400,
      variance: -100,
      variancePercent: -33.33,
      lineActual: 400,
      difference: 0,
      reconciled: true,
    });
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/lines?fiscalYearId=${fiscalYearId}&branchId=${OTHER}&accountId=${accounts.over}&from=${realFrom}&to=${realTo}`,
        tokens.accountant
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/lines?fiscalYearId=${fiscalYearId}&branchId=${BR}&accountId=${accounts.over}&from=${realFrom}&to=${realTo}`,
        tokens.noView
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/lines?fiscalYearId=${fiscalYearId}&branchId=${BR}&accountId=missing&from=${realFrom}&to=${realTo}`,
        tokens.super
      )).status,
      404
    );
  });

  test('a consolidated read rolls every branch up while a branch read stays scoped', async () => {
    const all = await get(
      `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&from=${realFrom}&to=${realTo}`,
      tokens.super
    );
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal(all.json.branchId, 'ALL');
    assert.equal(rowsByCode(all.json).get('BGT-6200').actual, 1700, '700 in the budget branch + 1000 in the other branch');
    const companyBudget = Math.round(
      all.json.rows.reduce((sum: number, row: { budget: number }) => sum + Number(row.budget), 0) * 100
    ) / 100;
    assert.equal(
      all.json.totals.budget,
      companyBudget,
      'the company total sums every branch budget on the roll-up'
    );
    assert.ok(companyBudget >= 2700, 'the company roll-up includes the budget branch');

    const own = await get(
      `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&from=${realFrom}&to=${realTo}`,
      tokens.accountant
    );
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.branchId, BR, 'a branch account defaults to its own branch, never ALL');
    assert.equal(rowsByCode(own.json).get('BGT-6200').actual, 700);

    assert.equal(
      (await get(
        `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&branchId=${OTHER}&from=${realFrom}&to=${realTo}`,
        tokens.accountant
      )).status,
      403,
      'a branch account cannot read another branch'
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&branchId=ALL&from=${realFrom}&to=${realTo}`,
        tokens.accountant
      )).status,
      403,
      'a branch account cannot request the consolidated roll-up'
    );
  });

  test('the budget editor returns its own branch lines and pick lists', async () => {
    const res = await get(
      `/api/accounting/budgets?fiscalYearId=${fiscalYearId}`,
      tokens.accountant
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.branchId, BR);
    assert.equal(res.json.fiscalYearId, fiscalYearId);
    assert.equal(res.json.lines.length, 5);
    assert.ok(res.json.periods.some((period: any) => period.periodKey === '2026-08'));
    assert.ok(res.json.accounts.some((account: any) => account.code === 'BGT-6100'));
    assert.ok(
      !res.json.accounts.some((account: any) => account.code === 'BGT-1010'),
      'balance-sheet accounts are not budget options'
    );

    const line = res.json.lines.find((row: any) => row.accountId === accounts.over);
    assert.equal(line.code, 'BGT-6200');
    assert.equal(line.amount, 300);

    assert.equal(
      (await get(`/api/accounting/budgets?fiscalYearId=${fiscalYearId}`, tokens.super)).status,
      400,
      'a consolidated user must choose a concrete branch to edit'
    );
    assert.equal(
      (await get(`/api/accounting/budgets?fiscalYearId=${fiscalYearId}&branchId=${OTHER}`, tokens.accountant)).status,
      403
    );
  });

  test('a closed period reports actuals but refuses budget edits and keeps its stored line', async () => {
    await pool!.query(
      `INSERT INTO gl_periods (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs, status)
       VALUES ($1, $2, $3, '2027-06-01', $4, '2027-06-30', $5, 'OPEN')`,
      [CLOSED_PERIOD_ID, fiscalYearId, CLOSED_PERIOD_KEY, closedStartBS, closedEndBS]
    );

    const seeded = await saveBudget([
      { periodKey: '2026-08', accountId: accounts.noActual, amount: 1000 },
      { periodKey: '2026-08', accountId: accounts.over, amount: 300 },
      { periodKey: '2026-09', accountId: accounts.over, amount: 200 },
      { periodKey: '2026-08', accountId: accounts.exact, amount: 400 },
      { periodKey: '2026-08', accountId: accounts.income, amount: 800 },
      { periodKey: CLOSED_PERIOD_KEY, accountId: accounts.noActual, amount: 500 },
    ]);
    assert.equal(seeded.status, 200, JSON.stringify(seeded.json));

    const closed = await post(`/api/accounting/periods/${CLOSED_PERIOD_ID}/close`, tokens.super, {
      overrideReason: 'BGT TEST close without checklist',
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.json));
    assert.equal(closed.json.status, 'CLOSED');

    const changed = await saveBudget([
      { periodKey: CLOSED_PERIOD_KEY, accountId: accounts.noActual, amount: 600 },
    ]);
    assert.equal(changed.status, 409, 'a closed period cannot accept a changed budget');
    assert.match(changed.json.message, /closed/i);

    const removedOnly = await saveBudget([
      { periodKey: CLOSED_PERIOD_KEY, accountId: accounts.noActual, amount: 500 },
    ]);
    assert.equal(removedOnly.status, 200, JSON.stringify(removedOnly.json));
    assert.deepEqual(
      removedOnly.json.lines.map((line: any) => [line.periodKey, line.accountId, line.amount]),
      [[CLOSED_PERIOD_KEY, accounts.noActual, 500]],
      'omitting open-period lines deletes them, but the closed-period line survives'
    );

    const after = await get(`/api/accounting/budgets?fiscalYearId=${fiscalYearId}&branchId=${BR}`, tokens.super);
    assert.equal(after.status, 200, JSON.stringify(after.json));
    assert.ok(
      after.json.lines.some(
        (line: any) => line.periodKey === CLOSED_PERIOD_KEY && line.accountId === accounts.noActual && line.amount === 500
      ),
      'the closed-period budget line is still stored'
    );

    const variance = await get(
      `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&branchId=${BR}&from=2027-06-01&to=2027-06-30`,
      tokens.super
    );
    assert.equal(variance.status, 200, JSON.stringify(variance.json));
    assert.equal(
      rowsByCode(variance.json).get('BGT-6100').budget,
      500,
      'a closed period still reports its budget'
    );

    const reopened = await post(`/api/accounting/periods/${CLOSED_PERIOD_ID}/reopen`, tokens.super, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
  });

  test('validation, permissions and branch scope are enforced on the budget routes', async () => {
    assert.equal((await get(`/api/accounting/budgets?fiscalYearId=${fiscalYearId}`, undefined)).status, 401);
    assert.equal((await get(varianceQuery(), undefined)).status, 401);
    assert.equal((await get(`/api/accounting/budgets?fiscalYearId=${fiscalYearId}`, tokens.noView)).status, 403);
    assert.equal((await get(varianceQuery(), tokens.noView)).status, 403);
    assert.equal(
      (await put('/api/accounting/budgets', tokens.noView, { fiscalYearId, branchId: BR, lines: [] })).status,
      403,
      'writing a budget needs gl-chart-manage'
    );
    assert.equal(
      (await get(`/api/accounting/budgets?fiscalYearId=${fiscalYearId}`, tokens.noBranch)).status,
      400,
      'an account with no branch cannot read a budget'
    );
    assert.equal(
      (await get(`/api/accounting/budgets?fiscalYearId=missing&branchId=${BR}`, tokens.super)).status,
      404
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&branchId=${BR}&from=2026-02-30&to=${realTo}`,
        tokens.super
      )).status,
      400,
      'an impossible calendar date is refused'
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance?fiscalYearId=${fiscalYearId}&branchId=${BR}&from=${TO}&to=${FROM}`,
        tokens.super
      )).status,
      400,
      'a reversed window is refused'
    );

    const negative = await saveBudget([{ periodKey: '2026-08', accountId: accounts.noActual, amount: -1 }]);
    assert.equal(negative.status, 400);

    const duplicate = await saveBudget([
      { periodKey: '2026-08', accountId: accounts.noActual, amount: 10 },
      { periodKey: '2026-08', accountId: accounts.noActual, amount: 20 },
    ]);
    assert.equal(duplicate.status, 400);

    const asset = await saveBudget([{ periodKey: '2026-08', accountId: accounts.cash, amount: 10 }]);
    assert.equal(asset.status, 400, 'a balance-sheet account is not a budget account');

    const unknownPeriod = await saveBudget([{ periodKey: '2099-01', accountId: accounts.noActual, amount: 10 }]);
    assert.equal(unknownPeriod.status, 400);

    assert.equal(
      (await put('/api/accounting/budgets', tokens.accountant, {
        fiscalYearId,
        branchId: OTHER,
        lines: [],
      })).status,
      403,
      'a branch account cannot save another branch budget'
    );
    assert.equal(
      (await post('/api/accounting/budgets/copy', tokens.noView, {
        targetFiscalYearId: TARGET_FY_ID,
        branchId: BR,
      })).status,
      403,
      'copying a budget needs gl-chart-manage'
    );
    assert.equal(
      (await get(
        `/api/accounting/budgets/export?fiscalYearId=${TARGET_FY_ID}&branchId=${BR}`,
        tokens.noView
      )).status,
      403,
      'exporting a budget uses the ledger read gate'
    );
  });

  test('copy forward maps the previous budgeted year by month and reports the mapping', async () => {
    const reset = await saveBudget(originalBudgetLines());
    assert.equal(reset.status, 200, JSON.stringify(reset.json));

    const copied = await post('/api/accounting/budgets/copy', tokens.super, {
      targetFiscalYearId: TARGET_FY_ID,
      branchId: BR,
    });
    assert.equal(copied.status, 200, JSON.stringify(copied.json));
    assert.equal(copied.json.status, 'COPIED');
    assert.equal(copied.json.sourceFiscalYearCode, FY_CODE);
    assert.equal(copied.json.targetFiscalYearCode, TARGET_FY_CODE);
    assert.equal(copied.json.sourceLines, 5);
    assert.equal(copied.json.mappedLines, 5);
    assert.equal(copied.json.copiedLines, 5);
    assert.deepEqual(copied.json.skippedAccounts, []);

    const mapping = new Map(
      copied.json.periodMapping.map((entry: any) => [entry.sourcePeriodKey, entry.targetPeriodKey])
    );
    assert.equal(mapping.get('2026-08'), '2027-08');
    assert.equal(mapping.get('2026-09'), '2027-09');
    assert.equal(copied.json.budget.lines.length, 5);
    assert.equal(
      copied.json.budget.lines.reduce((sum: number, line: any) => sum + line.amount, 0),
      2700
    );
    assert.ok(
      copied.json.budget.lines.every((line: any) => TARGET_PERIOD_KEYS.includes(line.periodKey)),
      'target lines use target-year period keys, never source keys'
    );
  });

  test('copy is idempotent, refuses an implicit overwrite, and replaces only when asked', async () => {
    const unchanged = await post('/api/accounting/budgets/copy', tokens.super, {
      targetFiscalYearId: TARGET_FY_ID,
      branchId: BR,
    });
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.json));
    assert.equal(unchanged.json.status, 'UNCHANGED');
    assert.equal(unchanged.json.copiedLines, 0);
    assert.equal(unchanged.json.budget.lines.length, 5);

    const changed = await put('/api/accounting/budgets', tokens.super, {
      fiscalYearId: TARGET_FY_ID,
      branchId: BR,
      lines: [{ periodKey: '2027-08', accountId: accounts.noActual, amount: 999 }],
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));

    const refused = await post('/api/accounting/budgets/copy', tokens.super, {
      targetFiscalYearId: TARGET_FY_ID,
      branchId: BR,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.match(refused.json.message, /already has a budget/i);
    assert.equal(refused.json.status, undefined, 'a copy refusal is a normal HTTP error, not a partial copy');

    const stillChanged = await get(
      `/api/accounting/budgets?fiscalYearId=${TARGET_FY_ID}&branchId=${BR}`,
      tokens.super
    );
    assert.deepEqual(
      stillChanged.json.lines.map((line: any) => [line.periodKey, line.amount]),
      [['2027-08', 999]],
      'refusing the copy leaves the target exactly as it was'
    );

    const replaced = await post('/api/accounting/budgets/copy', tokens.super, {
      targetFiscalYearId: TARGET_FY_ID,
      branchId: BR,
      replace: true,
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    assert.equal(replaced.json.status, 'REPLACED');
    assert.equal(replaced.json.replacedExisting, true);
    assert.equal(replaced.json.copiedLines, 5);
    assert.equal(replaced.json.budget.lines.length, 5);

    const again = await post('/api/accounting/budgets/copy', tokens.super, {
      targetFiscalYearId: TARGET_FY_ID,
      branchId: BR,
    });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.status, 'UNCHANGED');
    assert.equal(again.json.budget.lines.length, 5);
    assert.equal(
      again.json.budget.lines.reduce((sum: number, line: any) => sum + line.amount, 0),
      2700,
      'repeating the copy cannot double-count lines'
    );
  });

  test('CSV import refuses the whole file and reports every bad row', async () => {
    const before = await get(
      `/api/accounting/budgets?fiscalYearId=${TARGET_FY_ID}&branchId=${BR}`,
      tokens.super
    );
    const csv = [
      'account_code,period_key,amount',
      'BGT-9999,2027-08,100',
      'BGT-6100,2099-01,100',
      'BGT-6100,2027-08,abc',
      'BGT-6100,2027-08,-5',
      'BGT-6100,2027-08,100',
      'BGT-6100,2027-08,200',
    ].join('\n');
    const imported = await post('/api/accounting/budgets/import', tokens.super, {
      fiscalYearId: TARGET_FY_ID,
      branchId: BR,
      csv,
      replace: true,
    });
    assert.equal(imported.status, 400, JSON.stringify(imported.json));
    assert.equal(imported.json.status, 'REFUSED');
    assert.equal(imported.json.importedLines, 0);
    assert.equal(imported.json.budget, null);
    assert.deepEqual(
      imported.json.errors.map((error: any) => error.row),
      [2, 3, 4, 5, 7],
      'every invalid row is reported, including the later duplicate row'
    );
    assert.match(imported.json.errors[0].message, /Unknown chart account/);
    assert.match(imported.json.errors[1].message, /does not belong to fiscal year/);
    assert.match(imported.json.errors[2].message, /not numeric/);
    assert.match(imported.json.errors[3].message, /cannot be negative/);
    assert.match(imported.json.errors[4].message, /Duplicate account\+period/);

    const after = await get(
      `/api/accounting/budgets?fiscalYearId=${TARGET_FY_ID}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(after.json.lines.length, before.json.lines.length);
    assert.equal(
      after.json.lines.reduce((sum: number, line: any) => sum + line.amount, 0),
      2700,
      'an invalid file writes nothing, including its otherwise-valid rows'
    );
  });

  test('a valid CSV import round-trips and is idempotent on a second apply', async () => {
    const csv = [
      'account_code,period_key,amount',
      'BGT-6100,2027-08,1000.50',
      'BGT-6200,2027-08,300',
    ].join('\r\n');
    const first = await post('/api/accounting/budgets/import', tokens.super, {
      fiscalYearId: TARGET_FY_ID,
      branchId: BR,
      csv,
      replace: true,
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.status, 'REPLACED');
    assert.equal(first.json.importedLines, 2);
    assert.equal(first.json.budget.lines.length, 2);
    assert.equal(
      first.json.budget.lines.reduce((sum: number, line: any) => sum + line.amount, 0),
      1300.5
    );

    const second = await post('/api/accounting/budgets/import', tokens.super, {
      fiscalYearId: TARGET_FY_ID,
      branchId: BR,
      csv,
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.status, 'UNCHANGED');
    assert.equal(second.json.importedLines, 0);
    assert.equal(second.json.budget.lines.length, 2, 'a repeated import creates no duplicate lines');
    assert.equal(
      second.json.budget.lines.reduce((sum: number, line: any) => sum + line.amount, 0),
      1300.5,
      'a repeated import leaves totals unchanged'
    );

    const exported = await fetch(
      `http://127.0.0.1:${port}/api/accounting/budgets/export?fiscalYearId=${TARGET_FY_ID}&branchId=${BR}`,
      { headers: { authorization: 'Bearer ' + tokens.super } }
    );
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type') || '', /text\/csv/);
    assert.match(exported.headers.get('content-disposition') || '', /budget-BGT-2084-85/);
    const body = await exported.text();
    assert.match(body, /^account_code,period_key,amount/);
    assert.match(body, /BGT-6100,2027-08,1000\.50/);
    assert.match(body, /BGT-6200,2027-08,300\.00/);
  });

  test('overspend alerts expose budgeted expense overruns with exact scope, window and pre-limit tie-out', async () => {
    const alertGroup = await createGroup('BGT-AL', 'BGT Alert Expenses', 'EXPENSE', 'OPERATING_EXPENSE');
    const secondOver = await createAccount({
      code: 'BGT-6500',
      name: 'BGT Second Over Budget',
      groupId: alertGroup,
    });
    await postJournal('2026-08-28', BR, 'bgt-j8', 'BGT second over-budget August', [
      { accountId: secondOver, debit: 250, credit: 0 },
      { accountId: accounts.cash, debit: 0, credit: 250 },
    ]);
    const seeded = await saveBudget([
      ...originalBudgetLines(),
      { periodKey: '2026-08', accountId: secondOver, amount: 100 },
    ]);
    assert.equal(seeded.status, 200, JSON.stringify(seeded.json));

    const alertPath = (branch = '', to = realTo, extra = '') =>
      `/api/accounting/budgets/variance/alerts?fiscalYearId=${fiscalYearId}` +
      `${branch ? `&branchId=${branch}` : ''}&from=${realFrom}&to=${to}${extra}`;

    const branch = await get(alertPath(BR), tokens.super);
    assert.equal(branch.status, 200, JSON.stringify(branch.json));
    assert.equal(branch.json.fiscalYearId, fiscalYearId);
    assert.equal(branch.json.fiscalYearCode, FY_CODE);
    assert.equal(branch.json.branchId, BR);
    assert.equal(branch.json.from, realFrom);
    assert.equal(branch.json.to, realTo);
    assert.equal(branch.json.limit, 5);
    assert.equal(branch.json.truncated, false);
    assert.deepEqual(branch.json.alerts, [
      {
        accountId: accounts.over,
        code: 'BGT-6200',
        name: 'BGT Over Budget Expense',
        accountType: 'EXPENSE',
        statementGroup: 'OPERATING_EXPENSE',
        budget: 500,
        actual: 700,
        variance: -200,
        variancePercent: -40,
        overBy: 200,
        overPercent: 40,
        utilisationPercent: 140,
      },
      {
        accountId: secondOver,
        code: 'BGT-6500',
        name: 'BGT Second Over Budget',
        accountType: 'EXPENSE',
        statementGroup: 'OPERATING_EXPENSE',
        budget: 100,
        actual: 250,
        variance: -150,
        variancePercent: -150,
        overBy: 150,
        overPercent: 150,
        utilisationPercent: 250,
      },
    ]);
    assert.deepEqual(branch.json.totals, {
      alertCount: 2,
      budget: 600,
      actual: 950,
      overBy: 350,
    });
    assert.deepEqual(branch.json.tieOut, {
      sourceBudget: 600,
      sourceActual: 950,
      alertBudget: 600,
      alertActual: 950,
      budgetDifference: 0,
      actualDifference: 0,
      reconciled: true,
    });

    const narrowed = await get(alertPath(BR, '2026-08-31'), tokens.super);
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.json));
    assert.deepEqual(
      narrowed.json.alerts.map((alert: any) => ({
        code: alert.code,
        budget: alert.budget,
        actual: alert.actual,
        overBy: alert.overBy,
        overPercent: alert.overPercent,
        utilisationPercent: alert.utilisationPercent,
      })),
      [
        {
          code: 'BGT-6500',
          budget: 100,
          actual: 250,
          overBy: 150,
          overPercent: 150,
          utilisationPercent: 250,
        },
        {
          code: 'BGT-6200',
          budget: 300,
          actual: 400,
          overBy: 100,
          overPercent: 33.33,
          utilisationPercent: 133.33,
        },
      ]
    );
    assert.deepEqual(narrowed.json.totals, {
      alertCount: 2,
      budget: 400,
      actual: 650,
      overBy: 250,
    });
    assert.deepEqual(narrowed.json.tieOut, {
      sourceBudget: 400,
      sourceActual: 650,
      alertBudget: 400,
      alertActual: 650,
      budgetDifference: 0,
      actualDifference: 0,
      reconciled: true,
    });

    const limited = await get(alertPath('', realTo, '&limit=1'), tokens.super);
    assert.equal(limited.status, 200, JSON.stringify(limited.json));
    assert.equal(limited.json.branchId, 'ALL');
    assert.equal(limited.json.alerts.length, 1);
    assert.deepEqual(limited.json.alerts[0], {
      accountId: accounts.over,
      code: 'BGT-6200',
      name: 'BGT Over Budget Expense',
      accountType: 'EXPENSE',
      statementGroup: 'OPERATING_EXPENSE',
      budget: 500,
      actual: 1700,
      variance: -1200,
      variancePercent: -240,
      overBy: 1200,
      overPercent: 240,
      utilisationPercent: 340,
    });
    assert.deepEqual(limited.json.totals, {
      alertCount: 2,
      budget: 600,
      actual: 1950,
      overBy: 1350,
    });
    assert.equal(limited.json.limit, 1);
    assert.equal(limited.json.truncated, true);
    assert.deepEqual(limited.json.tieOut, {
      sourceBudget: 600,
      sourceActual: 1950,
      alertBudget: 600,
      alertActual: 1950,
      budgetDifference: 0,
      actualDifference: 0,
      reconciled: true,
    });

    const own = await get(alertPath('', realTo), tokens.accountant);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.branchId, BR, 'a branch account defaults to its own branch');
    assert.deepEqual(own.json.alerts.map((alert: any) => alert.actual), [700, 250]);

    assert.equal((await get(alertPath(BR), undefined)).status, 401);
    assert.equal((await get(alertPath(BR), tokens.noView)).status, 403);
    assert.equal((await get(alertPath('', realTo), tokens.noBranch)).status, 403);
    assert.equal((await get(alertPath(OTHER), tokens.accountant)).status, 403);
    assert.equal((await get(alertPath('ALL'), tokens.accountant)).status, 403);
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/alerts?from=${realFrom}&to=${realTo}`,
        tokens.super
      )).status,
      400,
      'a fiscal year is required'
    );
    assert.equal((await get(alertPath(BR, '2026-02-30'), tokens.super)).status, 400);
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/alerts?fiscalYearId=${fiscalYearId}&branchId=${BR}&from=${realTo}&to=${realFrom}`,
        tokens.super
      )).status,
      400,
      'a reversed window is refused'
    );
    assert.equal((await get(alertPath('BGT-NOPE'), tokens.super)).status, 400);
    assert.equal(
      (await get(
        `/api/accounting/budgets/variance/alerts?fiscalYearId=missing&branchId=${BR}&from=${realFrom}&to=${realTo}`,
        tokens.super
      )).status,
      404
    );
  });

  test('an explicit budget lock blocks every write path, is audited and is reversible', async () => {
    const before = await get(
      `/api/accounting/budgets?fiscalYearId=${fiscalYearId}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(before.status, 200, JSON.stringify(before.json));
    assert.equal(before.json.locked, false);
    assert.equal(before.json.lockedBy, null);
    assert.equal(before.json.lockedAt, null);

    const locked = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId,
      branchId: BR,
      locked: true,
    });
    assert.equal(locked.status, 200, JSON.stringify(locked.json));
    assert.equal(locked.json.status, 'LOCKED');
    assert.equal(locked.json.budget.locked, true);
    assert.equal(locked.json.budget.lockedBy, 'bgt-super@example.com');
    assert.ok(locked.json.budget.lockedAt, 'the lock records when it was applied');

    const lockedRead = await get(
      `/api/accounting/budgets?fiscalYearId=${fiscalYearId}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(lockedRead.status, 200, JSON.stringify(lockedRead.json));
    assert.equal(lockedRead.json.locked, true);
    assert.equal(lockedRead.json.lines.length, 6, 'locking leaves every stored line in place');
    assert.equal((await get(varianceQuery(), tokens.super)).status, 200, 'variance remains readable');

    const blockedSave = await saveBudget(originalBudgetLines());
    assert.equal(blockedSave.status, 409, JSON.stringify(blockedSave.json));
    assert.match(blockedSave.json.message, /locked/i);

    const blockedImport = await post('/api/accounting/budgets/import', tokens.super, {
      fiscalYearId,
      branchId: BR,
      csv: 'account_code,period_key,amount\nBGT-6100,2026-08,123',
      replace: true,
    });
    assert.equal(blockedImport.status, 409, JSON.stringify(blockedImport.json));
    assert.match(JSON.stringify(blockedImport.json), /locked/i);

    const sameState = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId,
      branchId: BR,
      locked: true,
    });
    assert.equal(sameState.status, 200, JSON.stringify(sameState.json));
    assert.equal(sameState.json.status, 'UNCHANGED');

    assert.equal(
      (await post('/api/accounting/budgets/lock', undefined, { fiscalYearId, branchId: BR, locked: true })).status,
      401
    );
    assert.equal(
      (await post('/api/accounting/budgets/lock', tokens.noView, { fiscalYearId, branchId: BR, locked: true })).status,
      403
    );
    assert.equal(
      (await post('/api/accounting/budgets/lock', tokens.noBranch, { fiscalYearId, branchId: BR, locked: true })).status,
      403
    );
    assert.equal(
      (await post('/api/accounting/budgets/lock', tokens.accountant, { fiscalYearId, branchId: OTHER, locked: true })).status,
      403
    );
    assert.equal(
      (await post('/api/accounting/budgets/lock', tokens.super, { branchId: BR, locked: true })).status,
      400
    );
    assert.equal(
      (await post('/api/accounting/budgets/lock', tokens.super, { fiscalYearId, branchId: BR })).status,
      400
    );
    assert.equal(
      (await post('/api/accounting/budgets/lock', tokens.super, { fiscalYearId, branchId: BR, locked: 'yes' })).status,
      400
    );
    assert.equal(
      (await post('/api/accounting/budgets/lock', tokens.super, { fiscalYearId, branchId: OTHER, locked: true })).status,
      404,
      'a branch with no saved budget cannot be locked'
    );
    assert.equal(
      (await post('/api/accounting/budgets/lock', tokens.super, { fiscalYearId, branchId: 'ALL', locked: true })).status,
      400
    );

    const targetLock = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId: TARGET_FY_ID,
      branchId: BR,
      locked: true,
    });
    assert.equal(targetLock.status, 200, JSON.stringify(targetLock.json));
    assert.equal(targetLock.json.status, 'LOCKED');
    const blockedCopy = await post('/api/accounting/budgets/copy', tokens.super, {
      sourceFiscalYearId: fiscalYearId,
      targetFiscalYearId: TARGET_FY_ID,
      branchId: BR,
      replace: true,
    });
    assert.equal(blockedCopy.status, 409, JSON.stringify(blockedCopy.json));
    assert.match(blockedCopy.json.message, /locked/i);

    const targetUnlock = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId: TARGET_FY_ID,
      branchId: BR,
      locked: false,
    });
    assert.equal(targetUnlock.status, 200, JSON.stringify(targetUnlock.json));
    assert.equal(targetUnlock.json.status, 'UNLOCKED');

    const unlocked = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId,
      branchId: BR,
      locked: false,
    });
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked.json));
    assert.equal(unlocked.json.status, 'UNLOCKED');
    assert.equal(unlocked.json.budget.locked, false);
    assert.equal(unlocked.json.budget.lockedBy, null);
    assert.equal(unlocked.json.budget.lockedAt, null);

    const sameUnlock = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId,
      branchId: BR,
      locked: false,
    });
    assert.equal(sameUnlock.status, 200, JSON.stringify(sameUnlock.json));
    assert.equal(sameUnlock.json.status, 'UNCHANGED');

    const resumedSave = await saveBudget(originalBudgetLines());
    assert.equal(resumedSave.status, 200, JSON.stringify(resumedSave.json));
    assert.equal(resumedSave.json.locked, false);

    const audit = await pool!.query(
      `SELECT action FROM audit_logs
       WHERE action IN ('LOCK_GL_BUDGET', 'UNLOCK_GL_BUDGET')
         AND details LIKE '%BGT Budget Branch%'`
    );
    assert.equal(
      audit.rows.filter((row: any) => row.action === 'LOCK_GL_BUDGET').length,
      2,
      'the current and target budgets each recorded one lock'
    );
    assert.equal(
      audit.rows.filter((row: any) => row.action === 'UNLOCK_GL_BUDGET').length,
      2,
      'each unlock is audited too'
    );
  });

  test('budget history snapshots every write path, restores monotonically and refuses locked or unauthorised restores', async () => {
    await pool!.query('DELETE FROM gl_budgets WHERE fiscal_year_id = $1 AND branch_id = $2', [fiscalYearId, OTHER]);
    await pool!.query('DELETE FROM gl_budgets WHERE fiscal_year_id = $1 AND branch_id = $2', [TARGET_FY_ID, OTHER]);

    const historyPath = (yearId: string) =>
      `/api/accounting/budgets/history?fiscalYearId=${yearId}&branchId=${OTHER}`;
    const versionPath = (yearId: string, versionId: string) =>
      `/api/accounting/budgets/history/${encodeURIComponent(versionId)}?fiscalYearId=${yearId}&branchId=${OTHER}`;
    const restorePath = (yearId: string, versionId: string) =>
      `/api/accounting/budgets/history/${encodeURIComponent(versionId)}/restore`;

    const empty = await get(historyPath(fiscalYearId), tokens.super);
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.deepEqual(empty.json.versions, [], 'a branch with no budget has no versions');

    const initial = [
      { periodKey: '2026-08', accountId: accounts.noActual, amount: 1000 },
      { periodKey: '2026-09', accountId: accounts.over, amount: 200 },
    ];
    const created = await saveBudgetFor(OTHER, initial);
    assert.equal(created.status, 200, JSON.stringify(created.json));

    const baselineHistory = await get(historyPath(fiscalYearId), tokens.super);
    assert.equal(baselineHistory.status, 200, JSON.stringify(baselineHistory.json));
    assert.equal(baselineHistory.json.versions.length, 1);
    const baseline = baselineHistory.json.versions[0];
    assert.equal(baseline.version, 1);
    assert.equal(baseline.source, 'BASELINE');
    assert.equal(baseline.lineCount, 0);
    assert.equal(baseline.totalAmount, 0);
    assert.equal(baseline.actor, 'bgt-super@example.com');
    assert.ok(baseline.createdAt);
    const baselineDetail = await get(versionPath(fiscalYearId, baseline.id), tokens.super);
    assert.equal(baselineDetail.status, 200, JSON.stringify(baselineDetail.json));
    assert.deepEqual(baselineDetail.json.version.lines, [], 'the baseline is the explicit empty prior state');

    const changed = await saveBudgetFor(OTHER, [
      { periodKey: '2026-08', accountId: accounts.noActual, amount: 1100 },
      { periodKey: '2026-09', accountId: accounts.over, amount: 250 },
    ]);
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    const saveHistory = await get(historyPath(fiscalYearId), tokens.super);
    assert.equal(saveHistory.json.versions.length, 2);
    assert.equal(saveHistory.json.versions[0].version, 2);
    assert.equal(saveHistory.json.versions[0].source, 'SAVE');
    assert.equal(saveHistory.json.versions[0].lineCount, 2);
    assert.equal(saveHistory.json.versions[0].totalAmount, 1200);
    const saveDetail = await get(
      versionPath(fiscalYearId, saveHistory.json.versions[0].id),
      tokens.super
    );
    assert.equal(saveDetail.status, 200, JSON.stringify(saveDetail.json));
    assert.deepEqual(
      saveDetail.json.version.lines.map((line: any) => [
        line.periodKey,
        line.accountId,
        line.amount,
        line.code,
      ]),
      [
        ['2026-08', accounts.noActual, 1000, 'BGT-6100'],
        ['2026-09', accounts.over, 200, 'BGT-6200'],
      ],
      'the save snapshot preserves the prior lines and chart codes'
    );

    const copied = await post('/api/accounting/budgets/copy', tokens.super, {
      sourceFiscalYearId: fiscalYearId,
      targetFiscalYearId: TARGET_FY_ID,
      branchId: OTHER,
    });
    assert.equal(copied.status, 200, JSON.stringify(copied.json));
    assert.equal(copied.json.status, 'COPIED');
    const targetBaseline = await get(historyPath(TARGET_FY_ID), tokens.super);
    assert.equal(targetBaseline.status, 200, JSON.stringify(targetBaseline.json));
    assert.equal(targetBaseline.json.versions.length, 1);
    assert.equal(targetBaseline.json.versions[0].source, 'BASELINE');
    assert.equal(targetBaseline.json.versions[0].lineCount, 0);

    const targetSave = await saveBudgetFor(
      OTHER,
      [{ periodKey: '2027-08', accountId: accounts.noActual, amount: 777 }],
      TARGET_FY_ID
    );
    assert.equal(targetSave.status, 200, JSON.stringify(targetSave.json));
    const targetReplaced = await post('/api/accounting/budgets/copy', tokens.super, {
      sourceFiscalYearId: fiscalYearId,
      targetFiscalYearId: TARGET_FY_ID,
      branchId: OTHER,
      replace: true,
    });
    assert.equal(targetReplaced.status, 200, JSON.stringify(targetReplaced.json));
    assert.equal(targetReplaced.json.status, 'REPLACED');
    const targetHistory = await get(historyPath(TARGET_FY_ID), tokens.super);
    assert.equal(targetHistory.status, 200, JSON.stringify(targetHistory.json));
    assert.deepEqual(
      targetHistory.json.versions.map((version: any) => [version.version, version.source]),
      [
        [3, 'COPY_REPLACE'],
        [2, 'SAVE'],
        [1, 'BASELINE'],
      ]
    );
    const replaceSnapshot = await get(
      versionPath(TARGET_FY_ID, targetHistory.json.versions[0].id),
      tokens.super
    );
    assert.equal(replaceSnapshot.status, 200, JSON.stringify(replaceSnapshot.json));
    assert.deepEqual(
      replaceSnapshot.json.version.lines.map((line: any) => [line.periodKey, line.amount]),
      [['2027-08', 777]],
      'the explicit replace snapshot is the state that was replaced'
    );

    const imported = await post('/api/accounting/budgets/import', tokens.super, {
      fiscalYearId,
      branchId: OTHER,
      csv: 'account_code,period_key,amount\nBGT-6100,2026-08,222',
      replace: true,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    assert.equal(imported.json.status, 'REPLACED');
    const importHistory = await get(historyPath(fiscalYearId), tokens.super);
    assert.equal(importHistory.status, 200, JSON.stringify(importHistory.json));
    assert.deepEqual(
      importHistory.json.versions.map((version: any) => [version.version, version.source]),
      [
        [3, 'IMPORT_REPLACE'],
        [2, 'SAVE'],
        [1, 'BASELINE'],
      ]
    );
    assert.equal(importHistory.json.versions[0].lineCount, 2);
    assert.equal(importHistory.json.versions[0].totalAmount, 1350);

    const restoreTarget = importHistory.json.versions.find((version: any) => version.version === 2);
    assert.ok(restoreTarget, 'the prior saved version must be available');
    const restoreAuditBefore = await pool!.query(
      `SELECT count(*)::int AS count FROM audit_logs
       WHERE action = 'RESTORE_GL_BUDGET' AND details LIKE '%BGT Other Branch%'`
    );
    const restored = await post(
      restorePath(fiscalYearId, restoreTarget.id),
      tokens.super,
      { fiscalYearId, branchId: OTHER }
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.equal(restored.json.status, 'RESTORED');
    assert.equal(restored.json.restoredVersion, 2);
    assert.equal(restored.json.snapshot.version, 4);
    assert.equal(restored.json.snapshot.source, 'RESTORE');
    assert.deepEqual(
      restored.json.budget.lines.map((line: any) => [line.periodKey, line.amount]),
      [
        ['2026-08', 1000],
        ['2026-09', 200],
      ],
      'restore puts the selected version back as current lines'
    );
    const restoredHistory = await get(historyPath(fiscalYearId), tokens.super);
    assert.equal(restoredHistory.status, 200, JSON.stringify(restoredHistory.json));
    assert.deepEqual(
      restoredHistory.json.versions.map((version: any) => version.version),
      [4, 3, 2, 1],
      'restore appends a monotonic version instead of rewriting history'
    );
    assert.equal(restoredHistory.json.versions[0].source, 'RESTORE');

    const locked = await post('/api/accounting/budgets/lock', tokens.super, {
      fiscalYearId,
      branchId: OTHER,
      locked: true,
    });
    assert.equal(locked.status, 200, JSON.stringify(locked.json));
    const historyWhileLocked = await get(historyPath(fiscalYearId), tokens.super);
    assert.equal(historyWhileLocked.status, 200, JSON.stringify(historyWhileLocked.json));
    assert.equal(historyWhileLocked.json.versions.length, 4, 'history reads stay available while locked');
    const countBeforeBlockedRestore = historyWhileLocked.json.versions.length;
    const lockedRestore = await post(
      restorePath(fiscalYearId, restoreTarget.id),
      tokens.super,
      { fiscalYearId, branchId: OTHER }
    );
    assert.equal(lockedRestore.status, 409, JSON.stringify(lockedRestore.json));
    assert.match(lockedRestore.json.message, /locked/i);
    const afterLockedRestore = await get(historyPath(fiscalYearId), tokens.super);
    assert.equal(
      afterLockedRestore.json.versions.length,
      countBeforeBlockedRestore,
      'a refused locked restore writes no snapshot'
    );

    const deniedRestore = await post(
      restorePath(fiscalYearId, restoreTarget.id),
      tokens.noView,
      { fiscalYearId, branchId: OTHER }
    );
    assert.equal(deniedRestore.status, 403, 'restore needs gl-chart-manage');
    assert.equal(
      (await get(historyPath(fiscalYearId), tokens.noView)).status,
      403,
      'history uses the ledger read gate'
    );
    assert.equal(
      (await post(
        restorePath(fiscalYearId, restoreTarget.id),
        tokens.accountant,
        { fiscalYearId, branchId: OTHER }
      )).status,
      403,
      'a branch account cannot restore another branch'
    );
    const afterDeniedRestore = await get(historyPath(fiscalYearId), tokens.super);
    assert.equal(
      afterDeniedRestore.json.versions.length,
      countBeforeBlockedRestore,
      'permission and branch refusals write no snapshot'
    );

    const restoredAudit = await pool!.query(
      `SELECT count(*)::int AS count FROM audit_logs
       WHERE action = 'RESTORE_GL_BUDGET' AND details LIKE '%BGT Other Branch%'`
    );
    assert.equal(
      restoredAudit.rows[0].count - restoreAuditBefore.rows[0].count,
      1,
      'the successful restore adds exactly one audit row'
    );
  });
});
