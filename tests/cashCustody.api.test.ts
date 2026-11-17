import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * ACC-2 — cash, bank and wallet custody over real HTTP + PostgreSQL.
 *
 * The claims a custody screen cannot fake:
 *   1. the daily cash close counts branch CASH ledgers only, never a bank or a
 *      provider clearing balance;
 *   2. the cash book is branch-scoped, while a bank/wallet book shows the
 *      external account's company balance and the selected branch's movement
 *      separately;
 *   3. a branch-owned ledger cannot receive a journal for another branch;
 *   4. wallet clearing ledgers carry their provider/settlement metadata and the
 *      default chart seeds one per supported provider;
 *   5. a branch accountant cannot create or edit another branch's custody
 *      account.
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

const BR_A = 'custody-test-a';
const BR_B = 'custody-test-b';
const DAY = '2026-08-19';
const BEFORE = '2026-08-18';
const PREFIX = 'CCT2';

const ADMIN = {
  id: 'custody-admin',
  email: 'custody-admin@example.com',
  name: 'Custody Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const ACCOUNTANT_B = {
  id: 'custody-accountant-b',
  email: 'custody-accountant-b@example.com',
  name: 'Custody Accountant B',
  role: 'ACCOUNTANT',
  branchId: BR_B,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('cash, bank and wallet custody (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const branchBToken = issueAuthToken(ACCOUNTANT_B);
  let cashA = '';
  let cashB = '';
  let bankShared = '';
  let bankB = '';
  let walletEsewa = '';
  let sales = '';
  let expense = '';

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
    await pool!.query('DELETE FROM daily_cash_closes WHERE branch_id = ANY($1::varchar[])', [[BR_A, BR_B]]);
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = ANY($1::varchar[])', [[BR_A, BR_B]]);
    await pool!.query('DELETE FROM gl_accounts WHERE code LIKE $1', [`${PREFIX}-%`]);
    await purgeAuditLogs(pool!, 'DELETE FROM audit_logs WHERE details LIKE $1', ['%custody-test%']);
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [[BR_A, BR_B]]);
  }

  async function account(input: Record<string, unknown>) {
    const res = await post('/api/accounting/accounts', {
      groupId: (await get('/api/accounting/groups')).json.find((group: any) => group.code === '1000').id,
      subledgerType: 'NONE',
      ...input,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
  }

  async function postingDefault(role: string) {
    const res = await get('/api/accounting/posting-defaults');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const found = res.json.defaults[role];
    assert.ok(found, `posting default ${role} must be seeded`);
    return found.accountId as string;
  }

  async function journal(branchId: string, lines: any[], memo: string) {
    const res = await post('/api/accounting/journals', {
      journalDateAD: DAY,
      branchId,
      memo,
      sourceId: `CUSTODY-${branchId}-${Math.random().toString(16).slice(2, 8)}`,
      lines,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
  }

  const line = (accountId: string, debit: number, credit: number, memo: string) => ({
    accountId,
    debit,
    credit,
    memo,
  });

  before(async () => {
    await ensureReferenceData(pool!, DAY);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
        ($1, 'CCTA2', 'Custody Test A', 'Kathmandu'),
        ($2, 'CCTB2', 'Custody Test B', 'Pokhara')`,
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

    sales = await postingDefault('SALES');
    expense = await postingDefault('SALARY_EXPENSE');

    cashA = (await account({
      code: `${PREFIX}-CASH-A`,
      name: 'Custody Test Till A',
      accountKind: 'CASH',
      branchId: BR_A,
    })).id;
    cashB = (await account({
      code: `${PREFIX}-CASH-B`,
      name: 'Custody Test Till B',
      accountKind: 'CASH',
      branchId: BR_B,
    })).id;
    bankShared = (await account({
      code: `${PREFIX}-BANK-S`,
      name: 'Custody Test Shared Bank',
      accountKind: 'BANK',
      branchId: null,
    })).id;
    bankB = (await account({
      code: `${PREFIX}-BANK-B`,
      name: 'Custody Test B Bank',
      accountKind: 'BANK',
      branchId: BR_B,
    })).id;
    walletEsewa = (await account({
      code: `${PREFIX}-ESEWA`,
      name: 'Custody Test eSewa Clearing',
      accountKind: 'WALLET',
      providerCode: 'ESEWA',
      merchantId: 'ESEWA-MERCHANT-1',
      settlementAccountId: bankShared,
    })).id;

    // A: 1,000 opening till, 200 in, 50 out, 500 bank deposit, 400 wallet.
    await post('/api/accounting/journals', {
      journalDateAD: BEFORE,
      branchId: BR_A,
      memo: 'Custody test opening',
      sourceId: 'CUSTODY-OPEN-A',
      lines: [line(cashA, 1000, 0, 'Opening float'), line(sales, 0, 1000, 'Opening float')],
    }).then((res) => assert.equal(res.status, 201, JSON.stringify(res.json)));
    await journal(BR_A, [line(cashA, 200, 0, 'Cash receipt'), line(sales, 0, 200, 'Cash receipt')], 'Custody test A receipt');
    await journal(BR_A, [line(expense, 50, 0, 'Petty cash'), line(cashA, 0, 50, 'Petty cash')], 'Custody test A payment');
    await journal(BR_A, [line(bankShared, 500, 0, 'Bank deposit'), line(sales, 0, 500, 'Bank deposit')], 'Custody test A bank');
    await journal(BR_A, [line(walletEsewa, 400, 0, 'Wallet receipt'), line(sales, 0, 400, 'Wallet receipt')], 'Custody test A wallet');

    // B: 300 till and 100 own-bank deposit; 50 into the shared bank.
    await journal(BR_B, [line(cashB, 300, 0, 'B cash receipt'), line(sales, 0, 300, 'B cash receipt')], 'Custody test B cash');
    await journal(BR_B, [line(bankB, 100, 0, 'B own-bank deposit'), line(sales, 0, 100, 'B own-bank deposit')], 'Custody test B bank');
    await journal(BR_B, [line(bankShared, 50, 0, 'B shared-bank deposit'), line(sales, 0, 50, 'B shared-bank deposit')], 'Custody test B shared');
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('daily cash close counts only branch CASH ledgers', async () => {
    const a = await get(`/api/accounting/cash-close?branchId=${BR_A}&dateAD=${DAY}`);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.branch.opening, 1000);
    assert.equal(a.json.branch.cashIn, 200);
    assert.equal(a.json.branch.cashOut, 50);
    assert.equal(a.json.branch.expectedClosing, 1150, 'bank 500 and wallet 400 must not enter the till count');

    const b = await get(`/api/accounting/cash-close?branchId=${BR_B}&dateAD=${DAY}`);
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.branch.expectedClosing, 300);

    const cash = await get(`/api/accounting/cash-book?branchId=${BR_A}&from=${DAY}&to=${DAY}&kind=CASH`);
    assert.equal(cash.status, 200, JSON.stringify(cash.json));
    assert.equal(cash.json.book, 'CASH');
    assert.equal(cash.json.closing, 1150);
    const cashIds = cash.json.accounts.map((row: any) => row.accountId);
    assert.ok(cashIds.includes(cashA), 'the branch till is in its own cash book');
    assert.ok(!cashIds.includes(cashB), 'another branch\'s till is not in this cash book');
  });

  test('bank book keeps the company balance separate from branch movement', async () => {
    const a = await get(
      `/api/accounting/bank-position?branchId=${BR_A}&from=${DAY}&to=${DAY}&accountId=${bankShared}`
    );
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.book, 'BANK');
    assert.equal(a.json.closing, 550, 'shared bank holds A 500 + B 50');
    assert.equal(a.json.branchMovement, 500, 'A branch movement is only its deposit');
    const shared = a.json.accounts[0];
    assert.equal(shared.accountKind, 'BANK');
    assert.equal(shared.isShared, true);
    assert.equal(shared.branchId, null);

    const b = await get(
      `/api/accounting/bank-position?branchId=${BR_B}&from=${DAY}&to=${DAY}&accountId=${bankShared}`
    );
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.closing, 550, 'the external bank balance does not change with the branch filter');
    assert.equal(b.json.branchMovement, 50);

    const owned = await get(
      `/api/accounting/bank-position?branchId=${BR_A}&from=${DAY}&to=${DAY}&accountId=${bankB}`
    );
    assert.equal(owned.status, 200, JSON.stringify(owned.json));
    assert.equal(owned.json.closing, 100);
    assert.equal(owned.json.branchMovement, 0);
    assert.equal(owned.json.accounts[0].branchId, BR_B);
    assert.equal(owned.json.accounts[0].branchCode, 'CCTB2');
  });

  test('wallet clearing exposes provider metadata and its own book', async () => {
    const book = await get(
      `/api/accounting/cash-book?branchId=${BR_A}&from=${DAY}&to=${DAY}&kind=WALLET&accountId=${walletEsewa}`
    );
    assert.equal(book.status, 200, JSON.stringify(book.json));
    assert.equal(book.json.book, 'WALLET');
    assert.equal(book.json.closing, 400);
    assert.equal(book.json.branchMovement, 400);
    assert.equal(book.json.accounts[0].providerCode, 'ESEWA');
    assert.equal(book.json.accounts[0].merchantId, 'ESEWA-MERCHANT-1');
    assert.equal(book.json.accounts[0].settlementAccountId, bankShared);

    const chart = await get('/api/accounting/accounts');
    assert.equal(chart.status, 200, JSON.stringify(chart.json));
    const wallets = chart.json.filter((row: any) => row.accountKind === 'WALLET');
    for (const provider of ['ESEWA', 'KHALTI', 'NEPAL_PAY']) {
      assert.ok(
        wallets.some((row: any) => row.providerCode === provider),
        `default chart must seed a ${provider} clearing ledger`
      );
    }
  });

  test('a branch-owned ledger refuses a journal for another branch', async () => {
    const refused = await post('/api/accounting/journals', {
      journalDateAD: DAY,
      branchId: BR_A,
      memo: 'Custody test wrong owner',
      sourceId: 'CUSTODY-WRONG-OWNER',
      lines: [line(bankB, 10, 0, 'Wrong branch'), line(sales, 0, 10, 'Wrong branch')],
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.match(refused.json.message, /belongs to branch/i);

    const shared = await post('/api/accounting/journals', {
      journalDateAD: DAY,
      branchId: BR_A,
      memo: 'Custody test shared bank',
      sourceId: 'CUSTODY-SHARED-OK',
      lines: [line(bankShared, 10, 0, 'Shared bank'), line(sales, 0, 10, 'Shared bank')],
    });
    assert.equal(shared.status, 201, JSON.stringify(shared.json));
  });

  test('wallet creation requires a provider and branch ownership stays scoped', async () => {
    const noProvider = await post('/api/accounting/accounts', {
      code: `${PREFIX}-NO-PROVIDER`,
      name: 'Custody Test Missing Provider',
      groupId: (await get('/api/accounting/groups')).json.find((group: any) => group.code === '1000').id,
      accountKind: 'WALLET',
      subledgerType: 'NONE',
    });
    assert.equal(noProvider.status, 400, JSON.stringify(noProvider.json));
    assert.match(noProvider.json.message, /provider/i);

    const foreign = await post('/api/accounting/accounts', {
      code: `${PREFIX}-FOREIGN`,
      name: 'Custody Test Foreign Till',
      groupId: (await get('/api/accounting/groups')).json.find((group: any) => group.code === '1000').id,
      accountKind: 'CASH',
      branchId: BR_A,
      subledgerType: 'NONE',
    }, branchBToken);
    assert.equal(foreign.status, 403, JSON.stringify(foreign.json));
  });
});
