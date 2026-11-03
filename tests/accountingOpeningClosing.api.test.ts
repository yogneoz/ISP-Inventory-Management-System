/**
 * Opening balances + year-end close — real Express app against PostgreSQL.
 *
 * These are the two foundation slices the accounting plan names before any
 * operational domain: a trial balance brought forward once per branch, and a
 * year-end close that moves income/expense into retained earnings. Both go
 * through the same `postJournal` helper as every other ledger write, so the
 * test drives the real routes and checks the ledger they leave behind.
 *
 * Isolation: the suite builds a THROWAWAY database from scripts/schema.sql and
 * points the real app at it before importing the server (db.ts reads
 * DATABASE_URL at module load). A shared-database version of this test closed a
 * fiscal year and left a branch's 13,000 on the books, which another suite's
 * company-wide balance-sheet assertion correctly saw. The year-end close is
 * intentionally company-wide, so the only honest place to prove it is a
 * database this file owns. `tests/fiscalYearFirstCreation.test.ts` uses the
 * same pattern.
 *
 * Pinned behavior:
 *   1. OPENING — an unbalanced set, a control line missing its customer party
 *      and a control line with the wrong party type are each refused with
 *      nothing written; a balanced set posts exactly one OPENING_BALANCE
 *      journal in the earliest open period; a second post is a 409.
 *   2. P&L — ordinary manual journals give the year a USD 3,000 result.
 *   3. CLOSE — the year-end route posts one journal per branch to retained
 *      earnings, marks the year closed, and leaves the trial balance balanced
 *      with current earnings at zero. The balance sheet total is unchanged:
 *      only the position of the result moves from current earnings to posted
 *      equity.
 *   4. REFUSAL — a second close (while closed, and again after a real reopen)
 *      is a 409 and writes nothing; a branch account cannot post opening
 *      balances for another branch; gl-post and SUPER_ADMIN gates hold.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// A cheap reachability probe decides whether the suite runs at all. The
// throwaway database itself is created inside before(); this only proves a
// PostgreSQL server is reachable so a database-less environment skips
// cleanly instead of failing on CREATE DATABASE.
let appDbReachable = false;
if (process.env.DATABASE_URL) {
  const probe = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    appDbReachable = true;
  } catch {
    appDbReachable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const skipNoDb = !appDbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const ROOT = path.resolve('.');
const SCHEMA_SQL_PATH = path.join(ROOT, 'scripts', 'schema.sql');
const TEST_DB = 'inventory_opening_closing_test';
const BR = 'OCBR';
const OTHER_BRANCH = 'WH001';
const FY_ID = 'oc-fy-2076-77';
const FY_CODE = '2076-77';
const FY_START = '2019-07-01';
const FY_END = '2020-06-30';
const OPENING_DATE = '2019-07-01';
const PERIOD_KEY = '2019-07';
const AS_OF = '2020-06-30';
const SUPER_ID = 'oc-super';
const SUPER_EMAIL = 'oc-super@example.com';
const SUPER_PASSWORD = 'OcOpening!2076';
const EXTRA_EQUITY_CODE = 'OCE-3100';

const USERS = {
  super: { id: SUPER_ID, email: SUPER_EMAIL, name: 'OC Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  accountant: { id: 'oc-accountant', email: 'oc-accountant@example.com', name: 'OC Accountant', role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  auditor: { id: 'oc-auditor', email: 'oc-auditor@example.com', name: 'OC Auditor', role: 'AUDITOR', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  otherBranch: { id: 'oc-other', email: 'oc-other@example.com', name: 'OC Other Branch', role: 'ACCOUNTANT', branchId: OTHER_BRANCH, allowedBranchIds: [OTHER_BRANCH], canSwitchUser: false },
} as const;

/** Parse DATABASE_URL and swap the database for the throwaway one. */
function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

interface Fixture {
  groupEquity: string;
  openingEquity: string;
  cash: string;
  receivable: string;
  sales: string;
  expense: string;
  retained: string;
}

describe('opening balances and year-end close API (real HTTP + throwaway PostgreSQL)', { skip: skipNoDb }, () => {
  let adminPool: pg.Pool | null = null;
  let dbPool: pg.Pool | null = null;
  let dbReachable = false;
  let port = 0;
  let closeServer: (() => Promise<void>) | null = null;
  let tokens = {} as Record<keyof typeof USERS, string>;
  const accounts = {} as Fixture;

  async function request(method: 'GET' | 'POST', pathName: string, token?: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + pathName, {
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

  const get = (pathName: string, token?: string) => request('GET', pathName, token);
  const post = (pathName: string, token: string | undefined, body: unknown) => request('POST', pathName, token, body);

  function line(accountId: string, debit: number, credit: number, extra: Record<string, unknown> = {}) {
    return { accountId, debit, credit, ...extra };
  }

  function opening(lines: unknown[]) {
    return post('/api/accounting/opening-balances', tokens.super, { branchId: BR, lines });
  }

  async function journalCount(where: string, params: unknown[] = []) {
    const res = await dbPool!.query(
      `SELECT COUNT(*)::int AS count FROM gl_journals WHERE ${where}`,
      params
    );
    return Number(res.rows[0].count);
  }

  async function trialBalance(): Promise<any> {
    const res = await get(
      `/api/accounting/statements/trial-balance?branchId=${BR}&to=${AS_OF}`,
      tokens.super
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  }

  async function balanceSheet(): Promise<any> {
    const res = await get(
      `/api/accounting/statements/balance-sheet?branchId=${BR}&asOf=${AS_OF}`,
      tokens.super
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  }

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) return;
    const throwawayUrl = withDbName(base, TEST_DB);
    try {
      adminPool = new pg.Pool({
        connectionString: withDbName(base, 'postgres'),
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      adminPool.on('error', () => undefined);
      await adminPool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
      if (adminPool) await adminPool.end();
      adminPool = null;
      return;
    }

    // A stale throwaway from an earlier run can hold connections; nothing else
    // owns this database, so terminate and recreate it.
    await adminPool
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB]
      )
      .catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await adminPool.query(`CREATE DATABASE ${TEST_DB}`);

    const schemaClient = new pg.Client({ connectionString: throwawayUrl });
    await schemaClient.connect();
    try {
      await schemaClient.query(fs.readFileSync(SCHEMA_SQL_PATH, 'utf8'));
    } finally {
      await schemaClient.end();
    }

    dbPool = new pg.Pool({ connectionString: throwawayUrl, max: 4, connectionTimeoutMillis: 5000 });
    // Teardown drops this database; an idle client then receives a terminating
    // connection notice, which pg surfaces as an 'error' event. Absorb it here
    // (a failing query still rejects normally during the tests).
    dbPool.on('error', () => undefined);

    // Repoint the server at the throwaway BEFORE it is imported: db.ts builds
    // its pool from DATABASE_URL at module load.
    process.env.DATABASE_URL = throwawayUrl;
    const { createApp, registerAllRoutes } = await import('../server/src/app');
    const { realPoolInstance, ensurePostgresConnection } = await import('../server/db');
    realPoolInstance?.on?.('error', () => undefined);
    assert.equal(await ensurePostgresConnection(), true, 'the throwaway database must be reachable');

    const { ensureReferenceData } = await import('./fixtures/referenceData');
    const { hashPassword, issueAuthToken } = await import('../server/src/middleware/auth');
    const { setPermissionMatrix } = await import('../server/src/state/runtimeState');
    const { DEFAULT_PERMISSIONS_MATRIX } = await import('../client/src/utils/permissionMatrixData');

    // Branch master, the seeded 2083-84 year, the default chart and a BS row
    // for today — the reference data every dated write expects.
    await ensureReferenceData(dbPool);
    await dbPool.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'Opening Closing Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [BR]
    );
    await dbPool.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
       VALUES ($1, $2, $3, $4, '2076-04-01', '2076-03-31', FALSE, FALSE, FALSE)`,
      [FY_ID, FY_CODE, FY_START, FY_END]
    );
    await dbPool.query(
      `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status, is_demo)
       VALUES ($1, $2, $3, 'OC Super', 'SUPER_ADMIN', NULL, ARRAY[]::text[], 'active', FALSE)`,
      [SUPER_ID, SUPER_EMAIL, hashPassword(SUPER_PASSWORD)]
    );

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    tokens = Object.fromEntries(
      Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
    ) as Record<keyof typeof USERS, string>;

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    closeServer = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    // The earliest open month of the dedicated year must exist before the
    // opening post: the service otherwise falls back to the earliest open
    // fiscal year, which in a shared database another suite could own.
    const period = await post('/api/accounting/periods', tokens.super, { periodKey: PERIOD_KEY });
    assert.equal(period.status, 201, JSON.stringify(period.json));

    const defaults = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    accounts.cash = defaults.json.defaults.CASH.accountId;
    accounts.receivable = defaults.json.defaults.AR_CONTROL.accountId;
    accounts.sales = defaults.json.defaults.SALES.accountId;
    accounts.retained = defaults.json.defaults.RETAINED_EARNINGS.accountId;

    const groups = await get('/api/accounting/groups', tokens.super);
    const equityGroup = groups.json.find((group: any) => group.code === '3000');
    assert.ok(equityGroup, 'the seeded chart must carry the equity group');
    accounts.groupEquity = equityGroup.id;

    const createdEquity = await post('/api/accounting/accounts', tokens.super, {
      code: EXTRA_EQUITY_CODE,
      name: 'OC Opening Equity',
      groupId: accounts.groupEquity,
    });
    assert.equal(createdEquity.status, 201, JSON.stringify(createdEquity.json));
    accounts.openingEquity = createdEquity.json.id;

    const accountList = await get('/api/accounting/accounts', tokens.super);
    assert.equal(accountList.status, 200);
    const generalExpense = accountList.json.find((account: any) => account.code === '6100');
    assert.ok(generalExpense, 'the seeded chart must carry the general operating expense account');
    accounts.expense = generalExpense.id;
  });

  after(async () => {
    if (closeServer) await closeServer();
    // The server's pool holds a connection to the throwaway: ending it first
    // keeps the DROP from waiting on a backend.
    try {
      const db = await import('../server/db');
      if (db.realPoolInstance) await db.realPoolInstance.end();
    } catch {
      /* best effort — the terminate below forces the issue if this fails */
    }
    if (dbPool) await dbPool.end();
    if (adminPool && dbReachable) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      } catch {
        await adminPool
          .query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [TEST_DB]
          )
          .catch(() => undefined);
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
      }
      await adminPool.end();
    }
  });

  test('unbalanced, unpartied and mispartied opening sets are refused with nothing written', async () => {
    const unbalanced = await opening([
      line(accounts.cash, 1000, 0),
      line(accounts.openingEquity, 0, 900),
    ]);
    assert.equal(unbalanced.status, 400, JSON.stringify(unbalanced.json));
    assert.match(unbalanced.json.message, /not balanced/i);

    const missingParty = await opening([
      line(accounts.receivable, 400, 0),
      line(accounts.openingEquity, 0, 400),
    ]);
    assert.equal(missingParty.status, 400, JSON.stringify(missingParty.json));
    assert.match(missingParty.json.message, /requires a CUSTOMER subledger/i);

    const wrongParty = await opening([
      line(accounts.receivable, 400, 0, { subledgerType: 'SUPPLIER', partyName: 'OC Supplier' }),
      line(accounts.openingEquity, 0, 400),
    ]);
    assert.equal(wrongParty.status, 400, JSON.stringify(wrongParty.json));
    assert.match(wrongParty.json.message, /requires a CUSTOMER subledger/i);

    assert.equal(await journalCount('branch_id = $1', [BR]), 0, 'refused opening sets must write nothing');
  });

  test('a balanced opening set posts once into the earliest open period', async () => {
    const res = await opening([
      line(accounts.cash, 10000, 0, { memo: 'Opening cash' }),
      line(accounts.openingEquity, 0, 10000, { memo: 'Opening equity' }),
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.branchId, BR);
    assert.equal(res.json.sourceType, 'OPENING_BALANCE');
    assert.equal(res.json.journalDateAD, OPENING_DATE);
    assert.equal(res.json.totalDebit, 10000);
    assert.equal(res.json.totalCredit, 10000);
    assert.equal(res.json.lines.length, 2);

    const stored = await dbPool!.query(
      `SELECT j.id, j.journal_date_ad::text AS date, p.period_key AS "periodKey",
              j.fiscal_year_id AS "fiscalYearId", j.source_id AS "sourceId"
       FROM gl_journals j JOIN gl_periods p ON p.id = j.period_id
       WHERE j.id = $1`,
      [res.json.id]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].date, OPENING_DATE);
    assert.equal(stored.rows[0].periodKey, PERIOD_KEY);
    assert.equal(stored.rows[0].fiscalYearId, FY_ID);
    assert.equal(stored.rows[0].sourceId, BR);

    const audit = await dbPool!.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'POST_OPENING_BALANCES' AND details LIKE '%OCBR%'"
    );
    assert.equal(Number(audit.rows[0].count), 1, 'the opening post and its audit row commit together');

    const second = await opening([
      line(accounts.cash, 50, 0),
      line(accounts.openingEquity, 0, 50),
    ]);
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.match(second.json.message, /already been posted/i);
    assert.equal(
      await journalCount("source_type = 'OPENING_BALANCE' AND branch_id = $1", [BR]),
      1,
      'a refused second opening post must write nothing'
    );

    const trial = await trialBalance();
    assert.equal(trial.balanced, true);
    assert.equal(trial.totals.debit, trial.totals.credit);
  });

  test('the year-end close moves the result into retained earnings and leaves the trial balance balanced', async () => {
    const revenue = await post('/api/accounting/journals', tokens.accountant, {
      journalDateAD: '2019-08-12',
      branchId: BR,
      memo: 'OC TEST sale',
      lines: [line(accounts.cash, 5000, 0), line(accounts.sales, 0, 5000)],
    });
    assert.equal(revenue.status, 201, JSON.stringify(revenue.json));

    const expense = await post('/api/accounting/journals', tokens.accountant, {
      journalDateAD: '2019-09-12',
      branchId: BR,
      memo: 'OC TEST expense',
      lines: [line(accounts.expense, 2000, 0), line(accounts.cash, 0, 2000)],
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.json));

    const before = await balanceSheet();
    assert.equal(before.balanced, true);
    assert.equal(before.totalAssets, 13000);
    assert.equal(before.equity.postedTotal, 10000);
    assert.equal(before.equity.currentEarnings, 3000);
    assert.equal(before.totalEquity, 13000);
    assert.equal(before.totalLiabilitiesAndEquity, 13000);

    const closeRes = await post(`/api/fiscal-years/${FY_ID}/close`, tokens.super, {
      adminEmail: SUPER_EMAIL,
      adminPassword: SUPER_PASSWORD,
    });
    assert.equal(closeRes.status, 200, JSON.stringify(closeRes.json));
    assert.equal(closeRes.json.isClosed, true);

    const closeJournals = await journalCount(
      "source_type = 'YEAR_END_CLOSE' AND fiscal_year_id = $1",
      [FY_ID]
    );
    assert.equal(closeJournals, 1, 'one closing journal per branch with a P&L residue');

    const closedLines = await dbPool!.query(
      `SELECT a.code, SUM(l.debit)::numeric AS debit, SUM(l.credit)::numeric AS credit
       FROM gl_journal_lines l
       JOIN gl_journals j ON j.id = l.journal_id
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE j.fiscal_year_id = $1 AND j.source_type = 'YEAR_END_CLOSE'
       GROUP BY a.code ORDER BY a.code`,
      [FY_ID]
    );
    const byCode = new Map(closedLines.rows.map((row: any) => [row.code, row]));
    assert.equal(Number(byCode.get('4000')!.debit), 5000, 'revenue is debited to zero');
    assert.equal(Number(byCode.get('6100')!.credit), 2000, 'expense is credited to zero');
    assert.equal(Number(byCode.get('3000')!.credit), 3000, 'the net result lands in retained earnings');

    const trial = await trialBalance();
    assert.equal(trial.balanced, true);
    assert.equal(trial.totals.debit, trial.totals.credit);
    const salesRow = trial.accounts.find((account: any) => account.code === '4000');
    const expenseRow = trial.accounts.find((account: any) => account.code === '6100');
    assert.equal(salesRow.closingBalance, 0);
    assert.equal(expenseRow.closingBalance, 0);

    const afterClose = await balanceSheet();
    assert.equal(afterClose.balanced, true);
    assert.equal(
      afterClose.totalAssets,
      before.totalAssets,
      'closing moves the result, it does not change total assets'
    );
    assert.equal(afterClose.equity.currentEarnings, 0, 'current earnings are zero after the close');
    assert.equal(afterClose.equity.postedTotal, 13000, 'the result sits in posted equity (retained earnings)');
    assert.equal(afterClose.totalEquity, before.totalEquity);
  });

  test('a second close is refused with nothing written, even after a real reopen', async () => {
    const closedAgain = await post(`/api/fiscal-years/${FY_ID}/close`, tokens.super, {
      adminEmail: SUPER_EMAIL,
      adminPassword: SUPER_PASSWORD,
    });
    assert.equal(closedAgain.status, 409, JSON.stringify(closedAgain.json));
    assert.match(closedAgain.json.message, /already closed/i);
    assert.equal(
      await journalCount("source_type = 'YEAR_END_CLOSE' AND fiscal_year_id = $1", [FY_ID]),
      1
    );

    const journalsBefore = await journalCount('fiscal_year_id = $1', [FY_ID]);

    const reopen = await post(`/api/fiscal-years/${FY_ID}/reopen`, tokens.super, {
      adminEmail: SUPER_EMAIL,
      adminPassword: SUPER_PASSWORD,
    });
    assert.equal(reopen.status, 200, JSON.stringify(reopen.json));
    assert.equal(reopen.json.isClosed, false);

    const reClose = await post(`/api/fiscal-years/${FY_ID}/close`, tokens.super, {
      adminEmail: SUPER_EMAIL,
      adminPassword: SUPER_PASSWORD,
    });
    assert.equal(reClose.status, 409, JSON.stringify(reClose.json));
    assert.match(reClose.json.message, /already been posted/i);
    assert.equal(
      await journalCount('fiscal_year_id = $1', [FY_ID]),
      journalsBefore,
      'the refused re-close writes nothing'
    );
    assert.equal(
      await journalCount("source_type = 'YEAR_END_CLOSE' AND fiscal_year_id = $1", [FY_ID]),
      1
    );
  });

  test('branch scope and the gl-post / SUPER_ADMIN gates hold on both routes', async () => {
    const foreignOpening = await post('/api/accounting/opening-balances', tokens.otherBranch, {
      branchId: BR,
      lines: [line(accounts.cash, 10, 0), line(accounts.openingEquity, 0, 10)],
    });
    assert.equal(foreignOpening.status, 403, JSON.stringify(foreignOpening.json));
    assert.match(foreignOpening.json.message, /not authorized|outside your branch scope/i);

    const auditorOpening = await post('/api/accounting/opening-balances', tokens.auditor, {
      branchId: BR,
      lines: [line(accounts.cash, 10, 0), line(accounts.openingEquity, 0, 10)],
    });
    assert.equal(auditorOpening.status, 403, JSON.stringify(auditorOpening.json));

    const accountantClose = await post(`/api/fiscal-years/${FY_ID}/close`, tokens.accountant, {
      adminEmail: SUPER_EMAIL,
      adminPassword: SUPER_PASSWORD,
    });
    assert.equal(accountantClose.status, 403, JSON.stringify(accountantClose.json));

    const wrongPassword = await post(`/api/fiscal-years/${FY_ID}/close`, tokens.super, {
      adminEmail: SUPER_EMAIL,
      adminPassword: 'not-the-password',
    });
    assert.equal(wrongPassword.status, 403, JSON.stringify(wrongPassword.json));
    assert.match(wrongPassword.json.message, /authorization failed/i);
  });
});
