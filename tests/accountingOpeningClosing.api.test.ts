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
import { postOpeningBalances as postOpeningBalancesClient } from '../client/src/services/api/accounting';
import { setAuthToken } from '../client/src/services/api/http';
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
const GL_BR = 'OCGL';
const CLIENT_BR = 'OCUI';
const CUSTOMER_BR = 'OCCUST';
const STOCK_BR = 'OCSTOCK';
const VENDOR_BR = 'OCVEND';
const MIX_BR = 'OCMIX';
const STOCK_PRODUCT_ID = 'OC-PROD-1';
const SUPPLIER_A = 'OC-SUP-A';
const SUPPLIER_B = 'OC-SUP-B';
const CUSTOMER_ID = 'OC-CUST-1';
const CUSTOMER_NAME = 'Opening Customer';
const OTHER_BRANCH = 'WH001';
const FY_ID = 'oc-fy-2079-80';
const FY_CODE = '2079-80';
const FY_START = '2022-07-17';
const FY_END = '2023-07-16';
const OPENING_DATE = '2022-07-17';
const PERIOD_KEY = '2022-07';
const AS_OF = '2023-07-16';
const REVENUE_DATE = '2022-08-12';
const EXPENSE_DATE = '2022-09-12';
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
  inventory: string;
  apControl: string;
}

describe('opening balances and year-end close API (real HTTP + throwaway PostgreSQL)', { skip: skipNoDb }, () => {
  let adminPool: pg.Pool | null = null;
  let dbPool: pg.Pool | null = null;
  let dbReachable = false;
  let port = 0;
  let closeServer: (() => Promise<void>) | null = null;
  let tokens = {} as Record<keyof typeof USERS, string>;
  const accounts = {} as Fixture;

  async function request(method: 'GET' | 'POST' | 'PUT', pathName: string, token?: string, body?: unknown) {
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
  const put = (pathName: string, token: string | undefined, body: unknown) => request('PUT', pathName, token, body);

  function line(accountId: string, debit: number, credit: number, extra: Record<string, unknown> = {}) {
    return { accountId, debit, credit, ...extra };
  }

  function opening(lines: unknown[], branchId = BR) {
    return post('/api/accounting/opening-balances', tokens.super, { branchId, lines });
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

    const { ensureBsDayRecords, ensureReferenceData } = await import('./fixtures/referenceData');
    const { hashPassword, issueAuthToken } = await import('../server/src/middleware/auth');
    const { setPermissionMatrix } = await import('../server/src/state/runtimeState');
    const { DEFAULT_PERMISSIONS_MATRIX } = await import('../client/src/utils/permissionMatrixData');

    // Branch master, the seeded 2083-84 year and the default chart. The suite
    // owns a 2079-80 year so its close cannot touch shared history.
    await ensureReferenceData(dbPool);
    await dbPool.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'Opening Closing Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [BR]
    );
    await dbPool.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'Opening GL Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [GL_BR]
    );
    await dbPool.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'Opening Client Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [CLIENT_BR]
    );
    await dbPool.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'Opening Customer Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [CUSTOMER_BR]
    );
    await dbPool.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'Opening Stock Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [STOCK_BR]
    );
    await dbPool.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'Opening Vendor Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [VENDOR_BR]
    );
    await dbPool.query(
      `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
       VALUES ($1, $1, 'Opening Mixed Branch', 'Test', TRUE, TRUE, TRUE, FALSE)`,
      [MIX_BR]
    );
    await dbPool.query(
      `INSERT INTO suppliers (id, supplier_code, name, status, is_demo)
       VALUES ($1, $1, 'Opening Supplier A', 'ACTIVE', FALSE),
              ($2, $2, 'Opening Supplier B', 'ACTIVE', FALSE)`,
      [SUPPLIER_A, SUPPLIER_B]
    );
    await dbPool.query(
      `INSERT INTO products (
         id, sku, name, category, product_group, unit, cost_price, selling_price, tax_rate, status, is_demo
       ) VALUES ($1, $1, 'Opening Stock Product', 'Test', 'Product Item', 'Pcs', 25, 30, 13, 'ACTIVE', FALSE)`,
      [STOCK_PRODUCT_ID]
    );
    await dbPool.query(
      `INSERT INTO customer_records (
         id, customer_id, customer_name, contact_number, branch_id, address, status, is_demo
       ) VALUES ('oc-customer-record', $1, $2, '9800000000', $3, 'Test', 'ACTIVE', FALSE)`,
      [CUSTOMER_ID, CUSTOMER_NAME, CUSTOMER_BR]
    );
    await dbPool.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
       VALUES ($1, $2, $3, $4, '2079-04-01 BS', '2080-03-31 BS', FALSE, FALSE, FALSE)`,
      [FY_ID, FY_CODE, FY_START, FY_END]
    );
    // The period and every voucher date below must resolve on the seeded BS
    // calendar before the ledger accepts a dual-dated write.
    await ensureBsDayRecords(dbPool, [
      '2022-07-01',
      FY_START,
      '2022-07-31',
      '2022-08-01',
      REVENUE_DATE,
      '2022-08-31',
      '2022-09-01',
      EXPENSE_DATE,
      '2022-09-30',
      '2023-07-01',
      FY_END,
      '2023-07-31',
    ]);
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
    accounts.inventory = defaults.json.defaults.INVENTORY.accountId;
    accounts.apControl = defaults.json.defaults.AP_CONTROL.accountId;

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

  test('a balanced GL opening posts into the earliest open period and a re-save replaces it', async () => {
    const res = await opening(
      [
        line(accounts.cash, 10000, 0, { memo: 'Opening cash' }),
        line(accounts.openingEquity, 0, 10000, { memo: 'Opening equity' }),
      ],
      GL_BR
    );
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.branchId, GL_BR);
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
    assert.equal(stored.rows[0].sourceId, `gl-opening:${GL_BR}`);

    const audit = await dbPool!.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'POST_OPENING_BALANCES' AND details LIKE '%OCGL%'"
    );
    assert.equal(Number(audit.rows[0].count), 1, 'the opening post and its audit row commit together');

    const second = await opening(
      [
        line(accounts.cash, 10000, 0),
        line(accounts.openingEquity, 0, 10000),
      ],
      GL_BR
    );
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(second.json.totalDebit, 10000);
    assert.notEqual(second.json.id, res.json.id, 'the re-save posts a new journal');
    assert.equal(
      await journalCount(
        "branch_id = $1 AND source_type = 'OPENING_BALANCE' AND source_id = $2",
        [GL_BR, `gl-opening:${GL_BR}`]
      ),
      2,
      'the re-save keeps the original and its replacement'
    );
    assert.equal(
      await journalCount(
        "branch_id = $1 AND source_type IN ('OPENING_BALANCE', 'OPENING_BALANCE_REVERSAL')",
        [GL_BR]
      ),
      3,
      'the GL re-save posts one linked reversal and one replacement'
    );
    const glSlot = await dbPool!.query(
      "SELECT journal_id FROM gl_opening_balance_slots WHERE branch_id = $1 AND source_key = 'gl'",
      [GL_BR]
    );
    assert.equal(glSlot.rows[0]?.journal_id, second.json.id, 'the GL slot points at the current replacement');

    // Keep the close fixture on its original branch with one clean opening:
    // replacement history intentionally adds gross debit/credit to the close
    // snapshot, and the close assertions below track BR's opening once.
    const brOpening = await opening([
      line(accounts.cash, 10000, 0, { memo: 'Opening cash' }),
      line(accounts.openingEquity, 0, 10000, { memo: 'Opening equity' }),
    ]);
    assert.equal(brOpening.status, 201, JSON.stringify(brOpening.json));

    const trial = await trialBalance();
    assert.equal(trial.balanced, true);
    assert.equal(trial.totals.debit, trial.totals.credit);
  });

  test('the Opening Balances client helper reaches the real opening-balances route', async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url =
        typeof input === 'string' && input.startsWith('/')
          ? `http://127.0.0.1:${port}${input}`
          : input;
      return nativeFetch(url, init);
    }) as typeof fetch;
    setAuthToken(tokens.super);
    try {
      const journal = await postOpeningBalancesClient({
        branchId: CLIENT_BR,
        lines: [
          { accountId: accounts.cash, debit: 750, credit: 0 },
          { accountId: accounts.openingEquity, debit: 0, credit: 750 },
        ],
      });
      assert.equal(journal.branchId, CLIENT_BR);
      assert.equal(journal.sourceType, 'OPENING_BALANCE');
      assert.equal(journal.periodKey, PERIOD_KEY);
      assert.equal(journal.totalDebit, 750);
    } finally {
      globalThis.fetch = nativeFetch;
      setAuthToken(null);
    }

    const stored = await dbPool!.query(
      `SELECT COUNT(*)::int AS count FROM gl_journals
       WHERE branch_id = $1 AND source_type = 'OPENING_BALANCE'`,
      [CLIENT_BR]
    );
    assert.equal(Number(stored.rows[0].count), 1, 'the client helper must leave a posted opening journal');
  });

  test('a customer opening balance posts through the AR control with its party subledger row', async () => {
    const res = await post('/api/accounting/opening-balances', tokens.super, {
      branchId: CUSTOMER_BR,
      register: 'CUSTOMER',
      lines: [
        {
          accountId: accounts.receivable,
          debit: 1500,
          credit: 0,
          subledgerType: 'CUSTOMER',
          partyId: CUSTOMER_ID,
          partyName: CUSTOMER_NAME,
          memo: 'Opening receivable',
        },
        {
          accountId: accounts.retained,
          debit: 0,
          credit: 1500,
          memo: 'Opening balance equity offset',
        },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.sourceType, 'OPENING_BALANCE');
    assert.equal(res.json.branchId, CUSTOMER_BR);
    assert.equal(res.json.periodKey, PERIOD_KEY);

    const stored = await dbPool!.query(
      `SELECT se.party_id AS "partyId", se.party_name AS "partyName",
              se.debit::float AS debit, se.credit::float AS credit,
              se.branch_id AS "branchId", a.code AS "accountCode"
       FROM gl_subledger_entries se
       JOIN gl_accounts a ON a.id = se.account_id
       JOIN gl_journals j ON j.id = se.journal_id
       WHERE j.id = $1 AND se.party_id = $2`,
      [res.json.id, CUSTOMER_ID]
    );
    assert.equal(stored.rowCount, 1);
    assert.deepEqual(stored.rows[0], {
      partyId: CUSTOMER_ID,
      partyName: CUSTOMER_NAME,
      debit: 1500,
      credit: 0,
      branchId: CUSTOMER_BR,
      accountCode: '1100',
    });

    const replacement = await post('/api/accounting/opening-balances', tokens.super, {
      branchId: CUSTOMER_BR,
      register: 'CUSTOMER',
      lines: [
        {
          accountId: accounts.receivable,
          debit: 50,
          credit: 0,
          subledgerType: 'CUSTOMER',
          partyId: CUSTOMER_ID,
          partyName: CUSTOMER_NAME,
        },
        { accountId: accounts.retained, debit: 0, credit: 50 },
      ],
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.json));

    const count = await dbPool!.query(
      `SELECT COUNT(*)::int AS count FROM gl_journals
       WHERE branch_id = $1 AND source_type = 'OPENING_BALANCE'`,
      [CUSTOMER_BR]
    );
    assert.equal(Number(count.rows[0].count), 2, 'the customer re-save keeps its original and replacement');
    const active = await dbPool!.query(
      `SELECT COUNT(*)::int AS count FROM gl_journals j
       WHERE j.branch_id = $1 AND j.source_type = 'OPENING_BALANCE'
         AND j.source_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM gl_journals r WHERE r.reversal_of_id = j.id AND r.status = 'POSTED'
         )`,
      [CUSTOMER_BR, `customer-opening:${CUSTOMER_BR}`]
    );
    assert.equal(Number(active.rows[0].count), 1, 'the customer register keeps exactly one active opening');
  });

  test('stock opening rows post one balanced journal at the register valuation, and a re-save replaces it', async () => {
    const first = await put(`/api/fiscal-years/${FY_ID}/opening-stock`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [
        {
          productId: STOCK_PRODUCT_ID,
          branchId: STOCK_BR,
          quantityOnHand: 10,
          damagedQty: 2,
          unitCost: 25,
        },
      ],
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.journals.length, 1, 'the branch gets one stock opening journal');
    assert.equal(first.json.journals[0].branchId, STOCK_BR);
    assert.equal(first.json.journals[0].totalValue, 250);

    const firstLines = await dbPool!.query(
      `SELECT a.id, COALESCE(SUM(l.debit), 0)::float AS debit,
              COALESCE(SUM(l.credit), 0)::float AS credit
       FROM gl_journal_lines l
       JOIN gl_journals j ON j.id = l.journal_id
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE j.journal_no = $1
       GROUP BY a.id`,
      [first.json.journals[0].journalNo]
    );
    const firstByAccount = new Map(firstLines.rows.map((row: any) => [String(row.id), row]));
    assert.equal(firstByAccount.get(accounts.inventory)?.debit, 250, 'Dr Inventory equals the valuation');
    assert.equal(firstByAccount.get(accounts.inventory)?.credit, 0);
    assert.equal(firstByAccount.get(accounts.retained)?.credit, 250, 'Cr opening equity equals the valuation');
    assert.equal(firstByAccount.get(accounts.retained)?.debit, 0);

    const openingRow = await dbPool!.query(
      `SELECT quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty",
              unit_cost::float AS "unitCost"
       FROM fiscal_year_opening_stock
       WHERE fiscal_year_id = $1 AND product_id = $2 AND branch_id = $3`,
      [FY_ID, STOCK_PRODUCT_ID, STOCK_BR]
    );
    assert.deepEqual(openingRow.rows[0], { quantityOnHand: 10, damagedQty: 2, unitCost: 25 });

    // Damaged units stay inside quantity on hand: 12 × 30 = 360, not 9 × 30.
    const second = await put(`/api/fiscal-years/${FY_ID}/opening-stock`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [
        {
          productId: STOCK_PRODUCT_ID,
          branchId: STOCK_BR,
          quantityOnHand: 12,
          damagedQty: 3,
          unitCost: 30,
        },
      ],
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.journals.length, 1);
    assert.equal(second.json.journals[0].totalValue, 360);

    const net = await dbPool!.query(
      `SELECT
         COALESCE(SUM(CASE WHEN l.account_id = $2 THEN l.debit - l.credit ELSE 0 END), 0)::float AS inventory,
         COALESCE(SUM(CASE WHEN l.account_id = $3 THEN l.debit - l.credit ELSE 0 END), 0)::float AS equity
       FROM gl_journal_lines l
       JOIN gl_journals j ON j.id = l.journal_id
       WHERE j.branch_id = $1`,
      [STOCK_BR, accounts.inventory, accounts.retained]
    );
    assert.equal(net.rows[0].inventory, 360, 'the replacement nets Dr Inventory to the current valuation');
    assert.equal(net.rows[0].equity, -360, 'the replacement nets Cr opening equity to the current valuation');

    const active = await dbPool!.query(
      `SELECT COUNT(*)::int AS count
       FROM gl_journals j
       WHERE j.branch_id = $1 AND j.source_type = 'OPENING_BALANCE'
         AND j.source_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM gl_journals r
           WHERE r.reversal_of_id = j.id AND r.status = 'POSTED'
         )`,
      [STOCK_BR, `stock-opening:${STOCK_BR}`]
    );
    assert.equal(Number(active.rows[0].count), 1, 'a re-save leaves exactly one active stock opening');

    const allStockJournals = await journalCount(
      "branch_id = $1 AND source_type IN ('OPENING_BALANCE', 'OPENING_BALANCE_REVERSAL')",
      [STOCK_BR]
    );
    assert.equal(allStockJournals, 3, 'the replacement keeps the original, its reversal and the new journal');

    const invalidOffset = await put(`/api/fiscal-years/${FY_ID}/opening-stock`, tokens.super, {
      offsetAccountId: 'oc-missing-equity',
      rows: [
        {
          productId: STOCK_PRODUCT_ID,
          branchId: STOCK_BR,
          quantityOnHand: 99,
          damagedQty: 0,
          unitCost: 99,
        },
      ],
    });
    assert.equal(invalidOffset.status, 400, JSON.stringify(invalidOffset.json));
    assert.match(invalidOffset.json.message, /does not exist/i);
    const afterFailure = await dbPool!.query(
      `SELECT quantity_on_hand AS "quantityOnHand", unit_cost::float AS "unitCost"
       FROM fiscal_year_opening_stock
       WHERE fiscal_year_id = $1 AND product_id = $2 AND branch_id = $3`,
      [FY_ID, STOCK_PRODUCT_ID, STOCK_BR]
    );
    assert.deepEqual(afterFailure.rows[0], { quantityOnHand: 12, unitCost: 30 });
  });

  test('vendor opening rows post AP control and equity, and a re-save reverses then replaces them', async () => {
    const first = await put(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [
        { supplierId: SUPPLIER_A, branchId: VENDOR_BR, openingBalance: 1000 },
        { supplierId: SUPPLIER_B, branchId: VENDOR_BR, openingBalance: -300 },
      ],
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.journals.length, 1, 'the branch gets one vendor opening journal');
    assert.equal(first.json.journals[0].branchId, VENDOR_BR);
    assert.equal(first.json.journals[0].totalValue, 1000);

    const firstLines = await dbPool!.query(
      `SELECT a.id, COALESCE(SUM(l.debit), 0)::float AS debit,
              COALESCE(SUM(l.credit), 0)::float AS credit
       FROM gl_journal_lines l
       JOIN gl_journals j ON j.id = l.journal_id
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE j.journal_no = $1
       GROUP BY a.id`,
      [first.json.journals[0].journalNo]
    );
    const firstByAccount = new Map(firstLines.rows.map((row: any) => [String(row.id), row]));
    assert.equal(firstByAccount.get(accounts.apControl)?.credit, 1000, 'payables credit AP control');
    assert.equal(firstByAccount.get(accounts.apControl)?.debit, 300, 'advances debit AP control');
    assert.equal(firstByAccount.get(accounts.retained)?.debit, 700, 'the signed net lands in opening equity');
    assert.equal(firstByAccount.get(accounts.retained)?.credit, 0);

    const supplierLines = await dbPool!.query(
      `SELECT party_id AS "partyId", COALESCE(SUM(debit), 0)::float AS debit,
              COALESCE(SUM(credit), 0)::float AS credit
       FROM gl_subledger_entries
       WHERE journal_id = (SELECT id FROM gl_journals WHERE journal_no = $1)
         AND subledger_type = 'SUPPLIER'
       GROUP BY party_id`,
      [first.json.journals[0].journalNo]
    );
    const bySupplier = new Map(supplierLines.rows.map((row: any) => [String(row.partyId), row]));
    assert.equal(bySupplier.get(SUPPLIER_A)?.credit, 1000);
    assert.equal(bySupplier.get(SUPPLIER_B)?.debit, 300);

    const second = await put(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [
        { supplierId: SUPPLIER_A, branchId: VENDOR_BR, openingBalance: 400 },
        { supplierId: SUPPLIER_B, branchId: VENDOR_BR, openingBalance: -100 },
      ],
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.journals.length, 1);
    assert.equal(second.json.journals[0].totalValue, 400);

    const net = await dbPool!.query(
      `SELECT
         COALESCE(SUM(CASE WHEN l.account_id = $2 THEN l.debit - l.credit ELSE 0 END), 0)::float AS ap,
         COALESCE(SUM(CASE WHEN l.account_id = $3 THEN l.debit - l.credit ELSE 0 END), 0)::float AS equity
       FROM gl_journal_lines l
       JOIN gl_journals j ON j.id = l.journal_id
       WHERE j.branch_id = $1`,
      [VENDOR_BR, accounts.apControl, accounts.retained]
    );
    assert.equal(net.rows[0].ap, -300, 'the replacement nets AP to the register net payable');
    assert.equal(net.rows[0].equity, 300, 'the replacement nets opening equity to the same signed net');

    const active = await dbPool!.query(
      `SELECT COUNT(*)::int AS count
       FROM gl_journals j
       WHERE j.branch_id = $1 AND j.source_type = 'OPENING_BALANCE'
         AND j.source_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM gl_journals r
           WHERE r.reversal_of_id = j.id AND r.status = 'POSTED'
         )`,
      [VENDOR_BR, `vendor-opening:${VENDOR_BR}`]
    );
    assert.equal(Number(active.rows[0].count), 1, 'a re-save leaves exactly one active vendor opening');
    assert.equal(
      await journalCount(
        "branch_id = $1 AND source_type IN ('OPENING_BALANCE', 'OPENING_BALANCE_REVERSAL')",
        [VENDOR_BR]
      ),
      3,
      'the replacement keeps the original, its reversal and the new journal'
    );

    const invalidOffset = await put(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super, {
      offsetAccountId: 'oc-missing-equity',
      rows: [{ supplierId: SUPPLIER_A, branchId: VENDOR_BR, openingBalance: 999 }],
    });
    assert.equal(invalidOffset.status, 400, JSON.stringify(invalidOffset.json));
    assert.match(invalidOffset.json.message, /does not exist/i);
    const afterFailure = await dbPool!.query(
      `SELECT supplier_id AS "supplierId", opening_balance::float AS "openingBalance"
       FROM vendor_opening_balances
       WHERE fiscal_year_id = $1 AND branch_id = $2
       ORDER BY supplier_id`,
      [FY_ID, VENDOR_BR]
    );
    assert.deepEqual(
      afterFailure.rows,
      [
        { supplierId: SUPPLIER_A, openingBalance: 400 },
        { supplierId: SUPPLIER_B, openingBalance: -100 },
      ],
      'a failed post rolls the row upserts back with the journal'
    );

    const removed = await put(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [{ supplierId: SUPPLIER_B, branchId: VENDOR_BR, openingBalance: -100 }],
      removed: [{ supplierId: SUPPLIER_A, branchId: VENDOR_BR }],
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.applied, 2, 'one update and one removal are applied');
    assert.equal(removed.json.journals[0].totalValue, 100, 'only the remaining advance is posted');

    const register = await get(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super);
    assert.equal(register.status, 200, JSON.stringify(register.json));
    assert.equal(register.json.rows.length, 1);
    assert.equal(register.json.rows[0].supplierId, SUPPLIER_B);
    assert.equal(register.json.rows[0].ledgerBalance, 0, 'the read-only AP reference excludes opening journals');
    assert.equal(
      await journalCount(
        "branch_id = $1 AND source_type IN ('OPENING_BALANCE', 'OPENING_BALANCE_REVERSAL')",
        [VENDOR_BR]
      ),
      5,
      'removing a supplier reverses and replaces the branch opening too'
    );
  });

  test('GL, stock and vendor openings coexist for one branch and replace only their own register', async () => {
    const gl = await post('/api/accounting/opening-balances', tokens.super, {
      branchId: MIX_BR,
      register: 'GL',
      lines: [
        line(accounts.cash, 2000, 0, { memo: 'Mixed branch opening cash' }),
        line(accounts.retained, 0, 2000, { memo: 'Mixed branch opening equity' }),
      ],
    });
    assert.equal(gl.status, 201, JSON.stringify(gl.json));

    const stock = await put(`/api/fiscal-years/${FY_ID}/opening-stock`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [
        { productId: STOCK_PRODUCT_ID, branchId: MIX_BR, quantityOnHand: 5, damagedQty: 0, unitCost: 10 },
      ],
    });
    assert.equal(stock.status, 200, JSON.stringify(stock.json));
    assert.equal(stock.json.journals[0].totalValue, 50);

    const vendor = await put(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [{ supplierId: SUPPLIER_A, branchId: MIX_BR, openingBalance: 300 }],
    });
    assert.equal(vendor.status, 200, JSON.stringify(vendor.json));
    assert.equal(vendor.json.journals[0].totalValue, 300);

    const counts = await dbPool!.query(
      `SELECT source_id AS "sourceId", COUNT(*)::int AS total
       FROM gl_journals
       WHERE branch_id = $1 AND source_type = 'OPENING_BALANCE'
       GROUP BY source_id ORDER BY source_id`,
      [MIX_BR]
    );
    assert.deepEqual(counts.rows, [
      { sourceId: `gl-opening:${MIX_BR}`, total: 1 },
      { sourceId: `stock-opening:${MIX_BR}`, total: 1 },
      { sourceId: `vendor-opening:${MIX_BR}`, total: 1 },
    ]);
    const slots = await dbPool!.query(
      `SELECT source_key AS "sourceKey", journal_id AS "journalId"
       FROM gl_opening_balance_slots WHERE branch_id = $1 ORDER BY source_key`,
      [MIX_BR]
    );
    assert.deepEqual(
      slots.rows.map((row: any) => row.sourceKey),
      ['gl', 'stock', 'vendor'],
      'each register owns one active slot'
    );
    const stockSlotBefore = slots.rows.find((row: any) => row.sourceKey === 'stock')?.journalId;
    const glSlotBefore = slots.rows.find((row: any) => row.sourceKey === 'gl')?.journalId;

    // Re-save only Vendors. GL and Stock keep their exact active journals.
    const vendorResave = await put(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [{ supplierId: SUPPLIER_A, branchId: MIX_BR, openingBalance: 450 }],
    });
    assert.equal(vendorResave.status, 200, JSON.stringify(vendorResave.json));
    assert.equal(vendorResave.json.journals[0].totalValue, 450);
    const slotsAfter = await dbPool!.query(
      `SELECT source_key AS "sourceKey", journal_id AS "journalId"
       FROM gl_opening_balance_slots WHERE branch_id = $1 ORDER BY source_key`,
      [MIX_BR]
    );
    assert.equal(
      slotsAfter.rows.find((row: any) => row.sourceKey === 'stock')?.journalId,
      stockSlotBefore,
      'a vendor re-save does not touch the stock slot'
    );
    assert.equal(
      slotsAfter.rows.find((row: any) => row.sourceKey === 'gl')?.journalId,
      glSlotBefore,
      'a vendor re-save does not touch the GL slot'
    );
    assert.equal(
      await journalCount(
        "branch_id = $1 AND source_type = 'OPENING_BALANCE' AND source_id = $2",
        [MIX_BR, `vendor-opening:${MIX_BR}`]
      ),
      2,
      'vendor history keeps the original and replacement'
    );
    assert.equal(
      await journalCount(
        "branch_id = $1 AND source_type = 'OPENING_BALANCE_REVERSAL' AND reversal_of_id IN (SELECT id FROM gl_journals WHERE branch_id = $1 AND source_id = $2)",
        [MIX_BR, `vendor-opening:${MIX_BR}`]
      ),
      1,
      'vendor re-save adds exactly one reversal'
    );

    // A failed vendor save rolls back its rows and leaves the other registers' slots intact.
    const invalid = await put(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super, {
      offsetAccountId: 'oc-missing-equity',
      rows: [{ supplierId: SUPPLIER_A, branchId: MIX_BR, openingBalance: 999 }],
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
    const slotsAfterFailure = await dbPool!.query(
      `SELECT source_key AS "sourceKey", journal_id AS "journalId"
       FROM gl_opening_balance_slots WHERE branch_id = $1 ORDER BY source_key`,
      [MIX_BR]
    );
    assert.deepEqual(slotsAfterFailure.rows, slotsAfter.rows, 'the failed vendor save disturbed no register');

    const removed = await put(`/api/fiscal-years/${FY_ID}/vendor-opening-balances`, tokens.super, {
      offsetAccountId: accounts.retained,
      rows: [],
      removed: [{ supplierId: SUPPLIER_A, branchId: MIX_BR }],
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.journals.length, 0, 'removing the last vendor leaves no active vendor journal');
    const finalSlots = await dbPool!.query(
      `SELECT source_key AS "sourceKey" FROM gl_opening_balance_slots WHERE branch_id = $1 ORDER BY source_key`,
      [MIX_BR]
    );
    assert.deepEqual(finalSlots.rows.map((row: any) => row.sourceKey), ['gl', 'stock']);
    assert.equal(
      await journalCount(
        "branch_id = $1 AND source_type = 'OPENING_BALANCE' AND source_id = $2",
        [MIX_BR, `gl-opening:${MIX_BR}`]
      ),
      1,
      'the GL opening stays active after the vendor removal'
    );
    assert.equal(
      await journalCount(
        "branch_id = $1 AND source_type = 'OPENING_BALANCE' AND source_id = $2",
        [MIX_BR, `stock-opening:${MIX_BR}`]
      ),
      1,
      'the stock opening stays active after the vendor removal'
    );
  });

  test('the year-end close moves the result into retained earnings and leaves the trial balance balanced', async () => {
    const revenue = await post('/api/accounting/journals', tokens.accountant, {
      journalDateAD: REVENUE_DATE,
      branchId: BR,
      memo: 'OC TEST sale',
      lines: [line(accounts.cash, 5000, 0), line(accounts.sales, 0, 5000)],
    });
    assert.equal(revenue.status, 201, JSON.stringify(revenue.json));

    const expense = await post('/api/accounting/journals', tokens.accountant, {
      journalDateAD: EXPENSE_DATE,
      branchId: BR,
      memo: 'OC TEST expense',
      lines: [line(accounts.expense, 2000, 0), line(accounts.cash, 0, 2000)],
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.json));

    // The two journals are in different calendar months, so their rows must
    // be in different monthly partitions. The line rows follow their header.
    const journalParts = await dbPool!.query(
      `SELECT id, tableoid::regclass::text AS partition
       FROM gl_journals WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[revenue.json.id, expense.json.id]]
    );
    assert.equal(journalParts.rowCount, 2);
    assert.notEqual(
      journalParts.rows[0].partition,
      journalParts.rows[1].partition,
      'journals in different months must not share a partition'
    );
    const lineParts = await dbPool!.query(
      `SELECT DISTINCT journal_id, journal_date_bs, tableoid::regclass::text AS partition
       FROM gl_journal_lines WHERE journal_id = ANY($1::varchar[])`,
      [[revenue.json.id, expense.json.id]]
    );
    assert.equal(lineParts.rowCount, 2);
    assert.notEqual(lineParts.rows[0].partition, lineParts.rows[1].partition);
    assert.match(lineParts.rows[0].journal_date_bs, /^\d{4}-\d{2}-\d{2} BS$/);
    assert.match(lineParts.rows[1].journal_date_bs, /^\d{4}-\d{2}-\d{2} BS$/);

    // The composite FK is real: a line cannot name a journal that does not
    // exist, even when a date is supplied.
    await assert.rejects(
      () =>
        dbPool!.query(
          `INSERT INTO gl_journal_lines
             (id, journal_id, journal_date_ad, journal_date_bs, line_no, account_id, branch_id, debit, credit)
           VALUES ('partition-orphan', 'missing-journal', $1::date, '2080-01-01 BS', 1, $2, $3, 1, 0)`,
          [REVENUE_DATE, accounts.cash, BR]
        ),
      (error: any) => error?.code === '23503'
    );

    // The BS-native summary groups the same posted lines by Nepali month and
    // quarter; no client-side date conversion is involved.
    const bsSummary = await get(
      `/api/accounting/statements/bs-summary?from=${REVENUE_DATE}&to=${EXPENSE_DATE}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(bsSummary.status, 200, JSON.stringify(bsSummary.json));
    assert.equal(bsSummary.json.months.length, 2, JSON.stringify(bsSummary.json));
    assert.ok(bsSummary.json.months.every((month: any) => /^Q[1-4]$/.test(month.quarter)));
    assert.ok(bsSummary.json.months.every((month: any) => month.bsMonthName && month.bsMonthNameNp));
    assert.equal(bsSummary.json.quarters.length, 1, JSON.stringify(bsSummary.json.quarters));
    assert.equal(bsSummary.json.totals.debit, 7000);
    assert.equal(bsSummary.json.totals.credit, 7000);
    assert.equal(bsSummary.json.totals.balance, 0);

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

    // The close also writes the bounded, immutable snapshot that year-end
    // reporting uses instead of rescanning the ledger. The branch accountant
    // can read its own branch; a foreign branch request and anonymous request
    // are refused.
    const snapshot = await get(
      `/api/accounting/fiscal-years/${FY_ID}/balances`,
      tokens.accountant
    );
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.json));
    assert.equal(snapshot.json.branchId, BR);
    assert.equal(snapshot.json.fiscalYear.isClosed, true);
    assert.equal(snapshot.json.rows.length, 5, 'one row per account that carries a balance');
    const snapByAccount = new Map(
      snapshot.json.rows.map((row: any) => [row.accountId, row])
    );
    const cashSnap: any = snapByAccount.get(accounts.cash);
    const salesSnap: any = snapByAccount.get(accounts.sales);
    const expenseSnap: any = snapByAccount.get(accounts.expense);
    const retainedSnap: any = snapByAccount.get(accounts.retained);
    assert.equal(cashSnap.preCloseBalance, 13000);
    assert.equal(cashSnap.postCloseBalance, 13000, 'closing does not change assets');
    assert.equal(salesSnap.preCloseCredit, 5000);
    assert.equal(salesSnap.closeDebit, 5000);
    assert.equal(salesSnap.postCloseBalance, 0);
    assert.equal(expenseSnap.preCloseDebit, 2000);
    assert.equal(expenseSnap.closeCredit, 2000);
    assert.equal(expenseSnap.postCloseBalance, 0);
    assert.equal(retainedSnap.preCloseBalance, 0);
    assert.equal(retainedSnap.closeCredit, 3000);
    // Signed like the trial balance: debit-positive, so an equity credit is
    // negative and the post-close column sums to zero.
    assert.equal(retainedSnap.postCloseBalance, -3000);
    assert.equal(snapshot.json.totals.preCloseDebit, 17000);
    assert.equal(snapshot.json.totals.preCloseCredit, 17000);
    assert.equal(snapshot.json.totals.postCloseBalance, 0);
    assert.deepEqual(snapshot.json.balanced, { preClose: true, postClose: true });

    const foreignBranch = await get(
      `/api/accounting/fiscal-years/${FY_ID}/balances?branchId=${BR}`,
      tokens.otherBranch
    );
    assert.equal(foreignBranch.status, 403, JSON.stringify(foreignBranch.json));
    const anonymousSnapshot = await get(`/api/accounting/fiscal-years/${FY_ID}/balances`);
    assert.equal(anonymousSnapshot.status, 401);

    // The snapshot is evidence: an in-place UPDATE or DELETE is refused by the
    // database, not merely avoided by application code. The suite's shared
    // connection deliberately carries `inventory.allow_ledger_purge=on` for
    // fixture cleanup, so prove the production guard on a separate connection
    // that does not carry that test-only option.
    const immutableUrl = new URL(process.env.DATABASE_URL!);
    immutableUrl.searchParams.delete('options');
    const immutableClient = new pg.Client({ connectionString: immutableUrl.toString() });
    await immutableClient.connect();
    try {
      await assert.rejects(
        () =>
          immutableClient.query(
            'UPDATE fiscal_year_balances SET post_close_balance = 0 WHERE fiscal_year_id = $1',
            [FY_ID]
          ),
        (error: any) => error?.code === '23514' && /immutable/.test(String(error.message))
      );
      await assert.rejects(
        () =>
          immutableClient.query('DELETE FROM fiscal_year_balances WHERE fiscal_year_id = $1', [
            FY_ID,
          ]),
        (error: any) => error?.code === '23514' && /immutable/.test(String(error.message))
      );
    } finally {
      await immutableClient.end();
    }

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
