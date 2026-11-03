/**
 * Daily cash close — real HTTP routes against PostgreSQL.
 *
 * The claims this suite pins are the ones a cash screen can fake but a ledger
 * cannot:
 *
 *   1. the day's opening/in/out/expected closing are the posted cash/bank
 *      lines — the expected closing equals both the cash book and the balance
 *      sheet's cash-and-bank total for the same branch and date;
 *   2. closing with a counted figure records the variance (counted − expected);
 *   3. a second close of the same branch/day is refused and writes nothing;
 *   4. a closed day reopens and can be counted again without creating a second
 *      close record;
 *   5. the consolidated read sums every branch into a company total that ties
 *      to the all-branch balance sheet; and
 *   6. another branch's accountant and a role without the ledger gate are
 *      refused rather than shown or allowed to close someone else's cash.
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

const BR_A = 'cash-close-test-a';
const BR_B = 'cash-close-test-b';
const DAY_BEFORE = '2026-08-18';
const DAY = '2026-08-19';
const BRANCH_IDS = [BR_A, BR_B];

const ADMIN = {
  id: 'cash-close-admin',
  email: 'cash-close-admin@example.com',
  name: 'Cash Close Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const ACCOUNTANT_B = {
  id: 'cash-close-accountant-b',
  email: 'cash-close-accountant-b@example.com',
  name: 'Cash Close Accountant B',
  role: 'ACCOUNTANT',
  branchId: BR_B,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const MANAGER_NO_LEDGER = {
  id: 'cash-close-manager',
  email: 'cash-close-manager@example.com',
  name: 'Cash Close Inventory Manager',
  role: 'INVENTORY_MANAGER',
  branchId: BR_B,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('daily cash close (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const branchBToken = issueAuthToken(ACCOUNTANT_B);
  const managerToken = issueAuthToken(MANAGER_NO_LEDGER);
  let closeId = '';

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, auth = token) {
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
      /* a non-JSON response is itself a finding */
    }
    return { status: res.status, json };
  }
  const get = (path: string, auth = token) => request('GET', path, undefined, auth);
  const post = (path: string, body: unknown, auth = token) => request('POST', path, body, auth);

  async function cleanup() {
    await pool!.query('DELETE FROM daily_cash_closes WHERE branch_id = ANY($1::varchar[])', [BRANCH_IDS]);
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = ANY($1::varchar[])', [BRANCH_IDS]);
    await pool!.query('DELETE FROM audit_logs WHERE details LIKE $1', ['%cash-close-test%']);
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [BRANCH_IDS]);
  }

  async function postingDefault(role: string) {
    const res = await get('/api/accounting/posting-defaults');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const found = res.json.defaults[role];
    assert.ok(found, `posting default ${role} must be seeded`);
    return found;
  }

  async function journal(dateAD: string, branchId: string, lines: any[], memo: string) {
    const res = await post('/api/accounting/journals', {
      journalDateAD: dateAD,
      branchId,
      memo,
      sourceId: `CASH-CLOSE-${branchId}-${dateAD}-${Math.random().toString(16).slice(2, 8)}`,
      lines,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
  }

  before(async () => {
    await ensureReferenceData(pool!, DAY);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
        ($1, 'CCTA', 'Cash Close Test A', 'Kathmandu'),
        ($2, 'CCTB', 'Cash Close Test B', 'Pokhara')`,
      [BR_A, BR_B]
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

    const [cash, bank, sales, expense] = await Promise.all([
      postingDefault('CASH'),
      postingDefault('BANK'),
      postingDefault('SALES'),
      postingDefault('SALARY_EXPENSE'),
    ]);
    const line = (accountId: string, debit: number, credit: number, memo: string) => ({
      accountId,
      debit,
      credit,
      memo,
    });

    // A starts the day with 1,000 in the till.
    await journal(DAY_BEFORE, BR_A, [
      line(cash.accountId, 1000, 0, 'Opening till float'),
      line(sales.accountId, 0, 1000, 'Opening till float'),
    ], 'Cash close test opening');

    // A trades on the day: 300 cash in, 100 cash out, 500 banked.
    await journal(DAY, BR_A, [
      line(cash.accountId, 300, 0, 'Counter receipt'),
      line(sales.accountId, 0, 300, 'Counter receipt'),
    ], 'Cash close test receipts');
    await journal(DAY, BR_A, [
      line(expense.accountId, 100, 0, 'Petty expense'),
      line(cash.accountId, 0, 100, 'Petty expense'),
    ], 'Cash close test payment');
    await journal(DAY, BR_A, [
      line(bank.accountId, 500, 0, 'Bank deposit'),
      line(sales.accountId, 0, 500, 'Bank deposit'),
    ], 'Cash close test bank');

    // B trades independently: 200 cash and 50 bank on the same day.
    await journal(DAY, BR_B, [
      line(cash.accountId, 200, 0, 'B counter receipt'),
      line(sales.accountId, 0, 200, 'B counter receipt'),
    ], 'Cash close test B cash');
    await journal(DAY, BR_B, [
      line(bank.accountId, 50, 0, 'B bank receipt'),
      line(sales.accountId, 0, 50, 'B bank receipt'),
    ], 'Cash close test B bank');
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('the day figures come from posted lines and tie to the cash book and balance sheet', async () => {
    const res = await get(`/api/accounting/cash-close?branchId=${BR_A}&dateAD=${DAY}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.branchId, BR_A);
    assert.equal(res.json.branch.status, 'OPEN');
    assert.equal(res.json.branch.opening, 1000);
    assert.equal(res.json.branch.cashIn, 800);
    assert.equal(res.json.branch.cashOut, 100);
    assert.equal(res.json.branch.expectedClosing, 1700);
    assert.equal(res.json.branch.countedClosing, null);
    assert.equal(res.json.branch.variance, null);

    const book = await get(`/api/accounting/cash-book?branchId=${BR_A}&from=${DAY}&to=${DAY}`);
    assert.equal(book.status, 200, JSON.stringify(book.json));
    assert.equal(book.json.opening, 1000);
    assert.equal(book.json.receipts, 800);
    assert.equal(book.json.payments, 100);
    assert.equal(book.json.closing, 1700);

    const sheet = await get(`/api/accounting/statements/balance-sheet?branchId=${BR_A}&asOf=${DAY}`);
    assert.equal(sheet.status, 200, JSON.stringify(sheet.json));
    assert.equal(sheet.json.cashAndBank, 1700);
    assert.equal(res.json.branch.expectedClosing, book.json.closing);
    assert.equal(res.json.branch.expectedClosing, sheet.json.cashAndBank);
  });

  test('closing records the counted figure and its deliberate variance, once', async () => {
    const closed = await post('/api/accounting/cash-close', {
      branchId: BR_A,
      dateAD: DAY,
      countedClosing: 1650,
    });
    assert.equal(closed.status, 201, JSON.stringify(closed.json));
    assert.equal(closed.json.status, 'CLOSED');
    assert.equal(closed.json.expectedClosing, 1700);
    assert.equal(closed.json.countedClosing, 1650);
    assert.equal(closed.json.variance, -50);
    assert.equal(closed.json.branchId, BR_A);
    assert.equal(closed.json.businessDateAD, DAY);
    closeId = closed.json.id;
    assert.ok(closeId);

    const read = await get(`/api/accounting/cash-close?branchId=${BR_A}&dateAD=${DAY}`);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.equal(read.json.branch.status, 'CLOSED');
    assert.equal(read.json.branch.countedClosing, 1650);
    assert.equal(read.json.branch.variance, -50);
    assert.equal(read.json.branch.close.id, closeId);
    assert.equal(read.json.branch.close.expectedClosing, 1700);
    assert.equal(read.json.branch.stale, false);

    const before = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM daily_cash_closes WHERE branch_id = $1 AND business_date_ad = $2::date',
      [BR_A, DAY]
    );
    const again = await post('/api/accounting/cash-close', {
      branchId: BR_A,
      dateAD: DAY,
      countedClosing: 1700,
    });
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.match(again.json.message, /already closed/i);
    const after = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM daily_cash_closes WHERE branch_id = $1 AND business_date_ad = $2::date',
      [BR_A, DAY]
    );
    assert.equal(Number(before.rows[0].count), 1);
    assert.equal(Number(after.rows[0].count), 1, 'a refused second close must write nothing');
  });

  test('reopen lets the day be counted again on the same record', async () => {
    const reopened = await post(`/api/accounting/cash-close/${closeId}/reopen`, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    assert.equal(reopened.json.status, 'OPEN');
    assert.equal(reopened.json.id, closeId);
    assert.ok(reopened.json.reopenedAt);

    const live = await get(`/api/accounting/cash-close?branchId=${BR_A}&dateAD=${DAY}`);
    assert.equal(live.status, 200, JSON.stringify(live.json));
    assert.equal(live.json.branch.status, 'OPEN');
    assert.equal(
      live.json.branch.countedClosing,
      null,
      'a reopened day must not present its withdrawn count as current counted cash'
    );
    assert.equal(live.json.branch.variance, null);
    assert.equal(live.json.totals.countedClosing, 0);

    const again = await post(`/api/accounting/cash-close/${closeId}/reopen`, {});
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.match(again.json.message, /already open/i);

    const reclosed = await post('/api/accounting/cash-close', {
      branchId: BR_A,
      dateAD: DAY,
      countedClosing: 1700,
    });
    assert.equal(reclosed.status, 201, JSON.stringify(reclosed.json));
    assert.equal(reclosed.json.id, closeId, 're-closing updates the day instead of creating a second record');
    assert.equal(reclosed.json.status, 'CLOSED');
    assert.equal(reclosed.json.variance, 0);

    const rows = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM daily_cash_closes WHERE branch_id = $1 AND business_date_ad = $2::date',
      [BR_A, DAY]
    );
    assert.equal(Number(rows.rows[0].count), 1);
  });

  test('the consolidated read sums branches and ties to the all-branch balance sheet', async () => {
    const res = await get(`/api/accounting/cash-close/consolidated?dateAD=${DAY}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.branchId, 'ALL');
    const byBranch = new Map(res.json.branches.map((row: any) => [row.branchId, row]));
    const a: any = byBranch.get(BR_A);
    const b: any = byBranch.get(BR_B);
    assert.ok(a, 'branch A must be in the consolidated table');
    assert.ok(b, 'branch B must be in the consolidated table');
    assert.equal(a.status, 'CLOSED');
    assert.equal(a.expectedClosing, 1700);
    assert.equal(b.status, 'OPEN');
    assert.equal(b.expectedClosing, 250);
    assert.equal(b.cashIn, 250);

    const sum = (pick: (row: any) => number) =>
      res.json.branches.reduce((total: number, row: any) => total + pick(row), 0);
    assert.equal(res.json.totals.expectedClosing, sum((row) => row.expectedClosing));
    assert.equal(res.json.totals.cashIn, sum((row) => row.cashIn));
    assert.equal(res.json.totals.cashOut, sum((row) => row.cashOut));
    assert.equal(res.json.totals.closedBranches, res.json.branches.filter((row: any) => row.status === 'CLOSED').length);
    assert.ok(res.json.totals.closedBranches >= 1);

    const sheet = await get(`/api/accounting/statements/balance-sheet?asOf=${DAY}`);
    assert.equal(sheet.status, 200, JSON.stringify(sheet.json));
    assert.equal(res.json.totals.expectedClosing, sheet.json.cashAndBank);
  });

  test('a branch accountant sees only its branch and is refused another branch', async () => {
    const own = await get(`/api/accounting/cash-close?branchId=${BR_B}&dateAD=${DAY}`, branchBToken);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.branch.branchId, BR_B);
    assert.equal(own.json.branch.expectedClosing, 250);

    const other = await get(`/api/accounting/cash-close?branchId=${BR_A}&dateAD=${DAY}`, branchBToken);
    assert.equal(other.status, 403, JSON.stringify(other.json));

    const consolidated = await get(`/api/accounting/cash-close/consolidated?dateAD=${DAY}`, branchBToken);
    assert.equal(consolidated.status, 200, JSON.stringify(consolidated.json));
    assert.deepEqual(
      consolidated.json.branches.map((row: any) => row.branchId),
      [BR_B],
      'a branch account can only consolidate the branches it may see'
    );
    assert.equal(consolidated.json.totals.expectedClosing, 250);

    const refusedClose = await post('/api/accounting/cash-close', {
      branchId: BR_A,
      dateAD: DAY,
      countedClosing: 1700,
    }, branchBToken);
    assert.equal(refusedClose.status, 403, JSON.stringify(refusedClose.json));

    const refusedReopen = await post(`/api/accounting/cash-close/${closeId}/reopen`, {}, branchBToken);
    assert.equal(refusedReopen.status, 403, JSON.stringify(refusedReopen.json));

    const noLedger = await get(`/api/accounting/cash-close?branchId=${BR_B}&dateAD=${DAY}`, managerToken);
    assert.equal(noLedger.status, 403, JSON.stringify(noLedger.json));
  });

  test('invalid input is refused before any row is written', async () => {
    const missingCount = await post('/api/accounting/cash-close', {
      branchId: BR_B,
      dateAD: DAY,
    });
    assert.equal(missingCount.status, 400, JSON.stringify(missingCount.json));

    const negative = await post('/api/accounting/cash-close', {
      branchId: BR_B,
      dateAD: DAY,
      countedClosing: -1,
    });
    assert.equal(negative.status, 400, JSON.stringify(negative.json));

    const badDate = await get(`/api/accounting/cash-close?branchId=${BR_B}&dateAD=2026-02-30`);
    assert.equal(badDate.status, 400, JSON.stringify(badDate.json));

    const noBranch = await post('/api/accounting/cash-close', {
      countedClosing: 100,
      dateAD: DAY,
    });
    assert.equal(noBranch.status, 400, JSON.stringify(noBranch.json));

    const unknownBranch = await post('/api/accounting/cash-close', {
      branchId: 'cash-close-test-missing',
      dateAD: DAY,
      countedClosing: 100,
    });
    assert.equal(unknownBranch.status, 404, JSON.stringify(unknownBranch.json));

    const rows = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM daily_cash_closes WHERE branch_id = $1 AND business_date_ad = $2::date',
      [BR_B, DAY]
    );
    assert.equal(Number(rows.rows[0].count), 0, 'invalid input must not create a close');
  });
});
