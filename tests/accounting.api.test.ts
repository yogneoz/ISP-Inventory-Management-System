/**
 * Accounting ledger API — real Express app against real PostgreSQL.
 *
 * This is the gate for slice 1 of the accounting plan. It drives the actual
 * routes (not repositories or handlers in isolation) because four failures are
 * invisible to unit tests:
 *
 *   1. CHART — a group with a statement mapping outside its account type, a
 *      control account without a subledger, and a duplicate posting default must
 *      all be refused, while a valid chart round-trips with its mapping.
 *   2. POSTING — a manual journal must be balanced, one-sided and use active
 *      accounts. The successful posting writes header, lines and subledger
 *      entries together, with a durable journal number and an audit row.
 *   3. PERIOD — a closed month refuses the posting with 409 and writes nothing;
 *      reopening the same period allows it again.
 *   4. RECONCILIATION — the control account's GL balance must equal its
 *      subledger, and a deliberately altered subledger row must show a
 *      difference (so a hard-coded `difference: 0` cannot pass).
 *
 * Branch scope and permission gates are exercised on the same routes: a branch
 * accountant cannot read or post another branch, an empty-scope account gets an
 * empty ledger, and `gl-view`/`gl-post`/`gl-close` are enforced independently.
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
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BR = 'BRH01';
const WH = 'WH001';
/** A fixed month inside the seeded 2083-84 fiscal year (2026-07-17..2027-07-16). */
const JOURNAL_DATE = '2026-08-15';
const PERIOD_KEY = '2026-08';
const TEST_TAG = 'ACC TEST';

const USERS = {
  super: { id: 'acc-super', email: 'acc-super@example.com', name: 'ACC Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  accountant: { id: 'acc-accountant', email: 'acc-accountant@example.com', name: 'ACC Accountant', role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  auditor: { id: 'acc-auditor', email: 'acc-auditor@example.com', name: 'ACC Auditor', role: 'AUDITOR', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  noView: { id: 'acc-frontdesk', email: 'acc-frontdesk@example.com', name: 'ACC Front Desk', role: 'FRONT_DESK', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  empty: { id: 'acc-empty', email: 'acc-empty@example.com', name: 'ACC Empty', role: 'ACCOUNTANT', branchId: '', allowedBranchIds: [], canSwitchUser: false },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

interface AccountFixture {
  groupAsset: string;
  cash: string;
  receivable: string;
  payable: string;
  sales: string;
  expense: string;
}

describe('accounting ledger API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const accounts = {} as AccountFixture;

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  const post = (path: string, token: string | undefined, body: unknown) => request('POST', path, token, body);
  const patch = (path: string, token: string | undefined, body: unknown) => request('PATCH', path, token, body);
  const del = (path: string, token: string | undefined) => request('DELETE', path, token);

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

  function line(accountId: string, debit: number, credit: number, extra: Record<string, unknown> = {}) {
    return { accountId, debit, credit, ...extra };
  }

  before(async () => {
    await ensureReferenceData(pool!);
    // FK order: journals cascade lines/subledger; periods then accounts/groups.
    await pool!.query(
      "DELETE FROM gl_journals WHERE source_id LIKE 'ACC-TEST-%' OR memo LIKE 'ACC TEST%'"
    );
    await pool!.query("DELETE FROM gl_periods WHERE period_key = $1 AND id LIKE 'glp-%'", [PERIOD_KEY]);
    await pool!.query("DELETE FROM gl_accounts WHERE code LIKE 'ATC-%'");
    await pool!.query("DELETE FROM gl_account_groups WHERE code LIKE 'ATC-%'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%ACC TEST%' OR details LIKE '%ATC-%'");

    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    accounts.groupAsset = await createGroup('ATC-1000', 'ACC Current Assets', 'ASSET', 'CURRENT_ASSET');

    // The reference-data fixture seeds the default chart (the same chart a
    // fresh install gets at boot). Use those posting defaults for posting and
    // reconciliation instead of creating a second account for the same role,
    // which the unique posting-role index would correctly refuse.
    const seeded = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
    accounts.cash = seeded.json.defaults.CASH.accountId;
    accounts.receivable = seeded.json.defaults.AR_CONTROL.accountId;
    accounts.payable = seeded.json.defaults.AP_CONTROL.accountId;
    accounts.sales = seeded.json.defaults.SALES.accountId;

    accounts.expense = await createAccount({
      code: 'ATC-5000', name: 'ACC Office Expense', groupId: await createGroup('ATC-5000', 'ACC Expenses', 'EXPENSE', 'OPERATING_EXPENSE'),
    });
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await pool.query("DELETE FROM gl_journals WHERE source_id LIKE 'ACC-TEST-%' OR memo LIKE 'ACC TEST%'");
      await pool.query("DELETE FROM gl_periods WHERE period_key = $1 AND id LIKE 'glp-%'", [PERIOD_KEY]);
      await pool.query("DELETE FROM gl_accounts WHERE code LIKE 'ATC-%'");
      await pool.query("DELETE FROM gl_account_groups WHERE code LIKE 'ATC-%'");
      await pool.query("DELETE FROM audit_logs WHERE details LIKE '%ACC TEST%' OR details LIKE '%ATC-%'");
      await pool.end();
    }
  });

  test('the chart round-trips groups and accounts with statement mapping and posting defaults', async () => {
    const groups = await get('/api/accounting/groups', tokens.super);
    assert.equal(groups.status, 200);
    const asset = groups.json.find((group: any) => group.code === 'ATC-1000');
    assert.equal(asset.accountType, 'ASSET');
    assert.equal(asset.statementGroup, 'CURRENT_ASSET');
    assert.equal(asset.normalBalance, 'DEBIT');

    const accountsRes = await get('/api/accounting/accounts', tokens.super);
    assert.equal(accountsRes.status, 200);
    const receivable = accountsRes.json.find((account: any) => account.postingRole === 'AR_CONTROL');
    assert.ok(receivable, 'the seeded default chart must expose the AR control account');
    assert.equal(receivable.isControl, true);
    assert.equal(receivable.subledgerType, 'CUSTOMER');
    assert.equal(receivable.statementGroup, 'CURRENT_ASSET');
    assert.equal(receivable.accountType, 'ASSET');

    const defaults = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(defaults.status, 200);
    assert.equal(defaults.json.defaults.AR_CONTROL.accountId, accounts.receivable);
    assert.equal(defaults.json.defaults.AP_CONTROL.accountId, accounts.payable);
    assert.equal(defaults.json.defaults.CASH.accountId, accounts.cash);
    assert.equal(defaults.json.defaults.SALES.accountId, accounts.sales);
  });

  test('cash and bank ledgers are classified, may be multiple, and feed the settlement picker', async () => {
    const bank = await post('/api/accounting/accounts', tokens.super, {
      code: 'ATC-1021',
      name: 'ACC Collection Bank',
      groupId: accounts.groupAsset,
      accountKind: 'BANK',
      bankName: 'ACC Bank',
      bankBranch: 'Main',
      accountNumber: '0123456789',
      accountHolder: 'ACC Company',
      swiftCode: 'ACCSNPKA',
    });
    assert.equal(bank.status, 201, JSON.stringify(bank.json));
    assert.equal(bank.json.accountKind, 'BANK');
    assert.equal(bank.json.bankName, 'ACC Bank');
    assert.equal(bank.json.swiftCode, 'ACCSNPKA');
    assert.equal(bank.json.postingRole, null, 'an extra bank ledger must not steal the BANK default');

    const cash = await post('/api/accounting/accounts', tokens.super, {
      code: 'ATC-1011',
      name: 'ACC Petty Cash',
      groupId: accounts.groupAsset,
      accountKind: 'CASH',
    });
    assert.equal(cash.status, 201, JSON.stringify(cash.json));
    assert.equal(cash.json.accountKind, 'CASH');
    assert.equal(cash.json.postingRole, null);

    const defaults = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(defaults.status, 200);
    assert.notEqual(defaults.json.defaults.BANK.accountId, bank.json.id);
    assert.notEqual(defaults.json.defaults.CASH.accountId, cash.json.id);

    const picker = await get('/api/accounting/settlement-accounts', tokens.super);
    assert.equal(picker.status, 200, JSON.stringify(picker.json));
    const chosenBank = picker.json.find((account: any) => account.id === bank.json.id);
    const chosenCash = picker.json.find((account: any) => account.id === cash.json.id);
    assert.ok(chosenBank, 'the extra bank ledger must be available to payments');
    assert.ok(chosenCash, 'the extra cash ledger must be available to payments');
    assert.equal(chosenBank.accountKind, 'BANK');
    assert.equal(chosenBank.bankName, 'ACC Bank');
    assert.equal(chosenCash.accountKind, 'CASH');

    const mismatched = await post('/api/accounting/accounts', tokens.super, {
      code: 'ATC-BAD5',
      name: 'ACC Mismatched Cash',
      groupId: accounts.groupAsset,
      accountKind: 'CASH',
      postingRole: 'SALES',
    });
    assert.equal(mismatched.status, 400, JSON.stringify(mismatched.json));
    assert.match(mismatched.json.message, /cash ledger.*posting role/i);

    const bankDetailsOnOther = await post('/api/accounting/accounts', tokens.super, {
      code: 'ATC-BAD6',
      name: 'ACC Bank Details On Other',
      groupId: accounts.groupAsset,
      accountKind: 'OTHER',
      bankName: 'Not A Bank Ledger',
    });
    assert.equal(bankDetailsOnOther.status, 400, JSON.stringify(bankDetailsOnOther.json));
    assert.match(bankDetailsOnOther.json.message, /bank details/i);
  });

  test('invalid chart entries are refused and change nothing', async () => {
    const badMapping = await post('/api/accounting/groups', tokens.super, {
      code: 'ATC-BAD1', name: 'ACC Bad Mapping', accountType: 'ASSET', statementGroup: 'REVENUE',
    });
    assert.equal(badMapping.status, 400);
    assert.match(badMapping.json.message, /cannot belong/i);

    const controlWithoutSubledger = await post('/api/accounting/accounts', tokens.super, {
      code: 'ATC-BAD2', name: 'ACC Bad Control', groupId: accounts.groupAsset,
      isControl: true, subledgerType: 'NONE',
    });
    assert.equal(controlWithoutSubledger.status, 400);
    assert.match(controlWithoutSubledger.json.message, /control account/i);

    const ordinaryWithSubledger = await post('/api/accounting/accounts', tokens.super, {
      code: 'ATC-BAD3', name: 'ACC Bad Ordinary', groupId: accounts.groupAsset,
      isControl: false, subledgerType: 'CUSTOMER',
    });
    assert.equal(ordinaryWithSubledger.status, 400);

    const duplicateRole = await post('/api/accounting/accounts', tokens.super, {
      code: 'ATC-BAD4', name: 'ACC Duplicate Default', groupId: accounts.groupAsset, postingRole: 'CASH',
    });
    assert.equal(duplicateRole.status, 409);

    const duplicateCode = await get('/api/accounting/accounts', tokens.super);
    assert.ok(!duplicateCode.json.some((account: any) => account.code.startsWith('ATC-BAD')));
  });

  test('a posting-default can be changed through the account PATCH', async () => {
    // The seeded chart owns every posting role except INTER_BRANCH_CLEARING,
    // which has no default and no posting path. Assigning that role here keeps
    // the assertion real without moving a default another suite may be reading
    // from the same database at the same time.
    const res = await patch('/api/accounting/accounts/' + accounts.expense, tokens.super, {
      postingRole: 'INTER_BRANCH_CLEARING',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.postingRole, 'INTER_BRANCH_CLEARING');
    const defaults = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(defaults.json.defaults.INTER_BRANCH_CLEARING.accountId, accounts.expense);

    const cleared = await patch('/api/accounting/accounts/' + accounts.expense, tokens.super, { postingRole: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.json.postingRole, null);
  });

  test('chart maintenance adds, edits, retires and deletes with guards', async () => {
    const createdGroup = await post('/api/accounting/groups', tokens.super, {
      code: 'ATC-9000', name: 'ACC Vehicle Assets', accountType: 'ASSET', statementGroup: 'NON_CURRENT_ASSET', sortOrder: 30,
    });
    assert.equal(createdGroup.status, 201, JSON.stringify(createdGroup.json));
    assert.equal(createdGroup.json.accountType, 'ASSET');
    assert.equal(createdGroup.json.statementGroup, 'NON_CURRENT_ASSET');

    const duplicateGroup = await post('/api/accounting/groups', tokens.super, {
      code: 'ATC-9000', name: 'ACC Duplicate', accountType: 'ASSET', statementGroup: 'CURRENT_ASSET',
    });
    assert.equal(duplicateGroup.status, 409, JSON.stringify(duplicateGroup.json));

    const renamedGroup = await patch('/api/accounting/groups/' + createdGroup.json.id, tokens.super, {
      name: 'ACC Motor Vehicles', sortOrder: 12,
    });
    assert.equal(renamedGroup.status, 200, JSON.stringify(renamedGroup.json));
    assert.equal(renamedGroup.json.name, 'ACC Motor Vehicles');
    assert.equal(renamedGroup.json.sortOrder, 12);

    const immutableGroup = await patch('/api/accounting/groups/' + createdGroup.json.id, tokens.super, {
      statementGroup: 'CURRENT_ASSET',
    });
    assert.equal(immutableGroup.status, 400, JSON.stringify(immutableGroup.json));
    assert.match(immutableGroup.json.message, /cannot be changed/i);

    const createdAccount = await createAccount({
      code: 'ATC-9001', name: 'ACC Delivery Van', groupId: createdGroup.json.id,
    });
    const editedAccount = await patch('/api/accounting/accounts/' + createdAccount, tokens.super, {
      name: 'ACC Delivery Van 2026', groupId: accounts.groupAsset, description: 'ACC TEST van',
      postingRole: 'INTER_BRANCH_CLEARING',
    });
    assert.equal(editedAccount.status, 200, JSON.stringify(editedAccount.json));
    assert.equal(editedAccount.json.name, 'ACC Delivery Van 2026');
    assert.equal(editedAccount.json.groupId, accounts.groupAsset);
    assert.equal(editedAccount.json.description, 'ACC TEST van');
    assert.equal(editedAccount.json.postingRole, 'INTER_BRANCH_CLEARING');

    const immutableAccount = await patch('/api/accounting/accounts/' + createdAccount, tokens.super, {
      code: 'ATC-9009',
    });
    assert.equal(immutableAccount.status, 400, JSON.stringify(immutableAccount.json));
    assert.match(immutableAccount.json.message, /cannot be changed/i);

    // Retiring an account clears its posting role so nothing posts to a dead default.
    const retired = await patch('/api/accounting/accounts/' + createdAccount, tokens.super, { isActive: false });
    assert.equal(retired.status, 200, JSON.stringify(retired.json));
    assert.equal(retired.json.isActive, false);
    assert.equal(retired.json.postingRole, null);
    const activeList = await get('/api/accounting/accounts', tokens.super);
    assert.ok(!activeList.json.some((account: any) => account.code === 'ATC-9001'), 'inactive accounts leave the active list');
    const fullList = await get('/api/accounting/accounts?includeInactive=1', tokens.super);
    assert.ok(fullList.json.some((account: any) => account.code === 'ATC-9001'), 'includeInactive must still show the retired account');

    // An unused account can be deleted; a group with accounts cannot.
    const secondAccount = await createAccount({ code: 'ATC-9002', name: 'ACC Spare Van', groupId: createdGroup.json.id });
    const groupWithAccount = await del('/api/accounting/groups/' + createdGroup.json.id, tokens.super);
    assert.equal(groupWithAccount.status, 409, JSON.stringify(groupWithAccount.json));
    assert.match(groupWithAccount.json.message, /still has 1 account/i);

    const deletedSecond = await del('/api/accounting/accounts/' + secondAccount, tokens.super);
    assert.equal(deletedSecond.status, 200, JSON.stringify(deletedSecond.json));
    const deletedFirst = await del('/api/accounting/accounts/' + createdAccount, tokens.super);
    assert.equal(deletedFirst.status, 200, JSON.stringify(deletedFirst.json));
    const afterDelete = await get('/api/accounting/accounts?includeInactive=1', tokens.super);
    assert.ok(!afterDelete.json.some((account: any) => account.code === 'ATC-9001'), 'a deleted account is gone');

    const deletedGroup = await del('/api/accounting/groups/' + createdGroup.json.id, tokens.super);
    assert.equal(deletedGroup.status, 200, JSON.stringify(deletedGroup.json));
    assert.equal((await get('/api/accounting/groups', tokens.super)).json.some((group: any) => group.code === 'ATC-9000'), false);

    // Posted history is not configuration: it can be retired, never deleted.
    const posted = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: '2026-09-10',
      branchId: BR,
      memo: 'ACC TEST chart delete guard',
      sourceId: 'ACC-TEST-CHART-DELETE',
      lines: [line(accounts.expense, 100, 0), line(accounts.cash, 0, 100)],
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.json));
    const usedAccount = await del('/api/accounting/accounts/' + accounts.expense, tokens.super);
    assert.equal(usedAccount.status, 409, JSON.stringify(usedAccount.json));
    assert.match(usedAccount.json.message, /posted line/i);
    const roleAccount = await del('/api/accounting/accounts/' + accounts.cash, tokens.super);
    assert.equal(roleAccount.status, 409, JSON.stringify(roleAccount.json));
    assert.match(roleAccount.json.message, /posting role/i);

    // `gl-view` is not enough to maintain the chart.
    const auditorWrite = await del('/api/accounting/accounts/' + accounts.expense, tokens.auditor);
    assert.equal(auditorWrite.status, 403, JSON.stringify(auditorWrite.json));
    assert.equal((await del('/api/accounting/accounts/gla-missing', tokens.super)).status, 404);
  });

  test('group hierarchy nests one sub-group level and trial balance subtotals roll up', async () => {
    const parent = await post('/api/accounting/groups', tokens.super, {
      code: 'ATC-9100', name: 'ACC Hierarchy Assets', accountType: 'ASSET', statementGroup: 'CURRENT_ASSET', sortOrder: 5,
    });
    assert.equal(parent.status, 201, JSON.stringify(parent.json));
    assert.equal(parent.json.parentId, null);

    // A sub-group inherits the parent's accounting nature; no type is supplied.
    const child = await post('/api/accounting/groups', tokens.super, {
      parentId: parent.json.id, code: 'ATC-9110', name: 'ACC Cash & Bank', sortOrder: 6,
    });
    assert.equal(child.status, 201, JSON.stringify(child.json));
    assert.equal(child.json.parentId, parent.json.id);
    assert.equal(child.json.accountType, 'ASSET');
    assert.equal(child.json.statementGroup, 'CURRENT_ASSET');
    assert.equal(child.json.normalBalance, 'DEBIT');

    const thirdLevel = await post('/api/accounting/groups', tokens.super, {
      parentId: child.json.id, code: 'ATC-9120', name: 'ACC Too Deep',
    });
    assert.equal(thirdLevel.status, 400, JSON.stringify(thirdLevel.json));
    assert.match(thirdLevel.json.message, /cannot itself have sub-groups/i);

    const parentAccount = await createAccount({
      code: 'ATC-9101', name: 'ACC Hierarchy Parent Account', groupId: parent.json.id,
    });
    const childAccount = await createAccount({
      code: 'ATC-9102', name: 'ACC Hierarchy Child Account', groupId: child.json.id,
    });
    const emptyChild = await post('/api/accounting/groups', tokens.super, {
      parentId: parent.json.id, code: 'ATC-9130', name: 'ACC Empty Sub-group', sortOrder: 7,
    });
    assert.equal(emptyChild.status, 201, JSON.stringify(emptyChild.json));

    const listed = await get('/api/accounting/groups', tokens.super);
    assert.equal(listed.json.find((group: any) => group.code === 'ATC-9110').parentId, parent.json.id);

    const posted = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: '2026-09-11',
      branchId: BR,
      memo: 'ACC TEST group hierarchy',
      sourceId: 'ACC-TEST-GROUP-HIERARCHY',
      lines: [line(parentAccount, 500, 0), line(childAccount, 1000, 0), line(accounts.cash, 0, 1500)],
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.json));

    const trial = await get('/api/accounting/statements/trial-balance?from=2026-09-11&to=2026-09-11&branchId=' + BR, tokens.super);
    assert.equal(trial.status, 200, JSON.stringify(trial.json));
    const top = trial.json.groups.find((group: any) => group.code === 'ATC-9100');
    assert.ok(top, 'the parent group must appear in the trial balance tree');
    assert.equal(top.periodDebit, 1500, 'the parent subtotal must include its direct account and its sub-group');
    assert.equal(top.closingDebit, 1500);
    assert.deepEqual(top.accounts.map((account: any) => account.code), ['ATC-9101']);
    const sub = top.children.find((group: any) => group.code === 'ATC-9110');
    assert.ok(sub, 'the sub-group must nest under its parent');
    assert.equal(sub.periodDebit, 1000, 'the sub-group subtotal must include its own account');
    assert.deepEqual(sub.accounts.map((account: any) => account.code), ['ATC-9102']);
    assert.ok(!top.children.some((group: any) => group.code === 'ATC-9130'), 'an empty sub-group is pruned from the statement tree');

    // A group with any child or account is structural history, not editable hierarchy.
    const blockedDelete = await del('/api/accounting/groups/' + parent.json.id, tokens.super);
    assert.equal(blockedDelete.status, 409, JSON.stringify(blockedDelete.json));
    assert.match(blockedDelete.json.message, /1 account and 2 sub-groups/i);
    const blockedMove = await patch('/api/accounting/groups/' + child.json.id, tokens.super, { parentId: null });
    assert.equal(blockedMove.status, 409, JSON.stringify(blockedMove.json));
    assert.match(blockedMove.json.message, /still has 1 account/i);

    // An empty sub-group may move to the top level and then be removed.
    const moved = await patch('/api/accounting/groups/' + emptyChild.json.id, tokens.super, { parentId: null });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal(moved.json.parentId, null);
    assert.equal((await del('/api/accounting/groups/' + emptyChild.json.id, tokens.super)).status, 200);
  });

  test('a closed period refuses postings until it is reopened', async () => {
    const opened = await post('/api/accounting/periods', tokens.super, { periodKey: PERIOD_KEY });
    assert.equal(opened.status, 201, JSON.stringify(opened.json));
    assert.equal(opened.json.periodKey, PERIOD_KEY);
    assert.equal(opened.json.status, 'OPEN');
    assert.equal(opened.json.fiscalYearCode, '2083-84');

    const closed = await post(`/api/accounting/periods/${opened.json.id}/close`, tokens.super, {});
    assert.equal(closed.status, 200);
    assert.equal(closed.json.status, 'CLOSED');
    assert.ok(closed.json.closedAt);

    const refused = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST closed period',
      sourceId: 'ACC-TEST-CLOSED',
      lines: [line(accounts.cash, 500, 0), line(accounts.sales, 0, 500)],
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.match(refused.json.message, /closed/i);

    const afterAttempt = await pool!.query("SELECT COUNT(*)::int AS count FROM gl_journals WHERE source_id = 'ACC-TEST-CLOSED'");
    assert.equal(Number(afterAttempt.rows[0].count), 0, 'a refused closed-period post must write nothing');

    const reopened = await post(`/api/accounting/periods/${opened.json.id}/reopen`, tokens.super, {});
    assert.equal(reopened.status, 200);
    assert.equal(reopened.json.status, 'OPEN');
    assert.equal(reopened.json.closedAt, null);
  });

  test('an unbalanced or malformed journal is refused with no rows written', async () => {
    const unbalanced = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST unbalanced',
      sourceId: 'ACC-TEST-UNBAL',
      lines: [line(accounts.cash, 100, 0), line(accounts.sales, 0, 90)],
    });
    assert.equal(unbalanced.status, 400);
    assert.match(unbalanced.json.message, /not balanced/i);

    const bothSides = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST both sides',
      sourceId: 'ACC-TEST-BOTH',
      lines: [line(accounts.cash, 50, 10), line(accounts.sales, 0, 50)],
    });
    assert.equal(bothSides.status, 400);
    assert.match(bothSides.json.message, /exactly one/i);

    const missingSubledger = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST missing subledger',
      sourceId: 'ACC-TEST-NOSUB',
      lines: [line(accounts.receivable, 200, 0), line(accounts.sales, 0, 200)],
    });
    assert.equal(missingSubledger.status, 400);
    assert.match(missingSubledger.json.message, /requires a CUSTOMER subledger/i);

    const wrongSubledger = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST wrong subledger',
      sourceId: 'ACC-TEST-WRONGSUB',
      lines: [
        line(accounts.receivable, 200, 0, { subledgerType: 'SUPPLIER', partyName: 'ACC Supplier' }),
        line(accounts.sales, 0, 200),
      ],
    });
    assert.equal(wrongSubledger.status, 400);

    const rows = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM gl_journals WHERE source_id LIKE 'ACC-TEST-UNBAL' OR source_id LIKE 'ACC-TEST-BOTH' OR source_id LIKE 'ACC-TEST-NOSUB' OR source_id LIKE 'ACC-TEST-WRONGSUB'"
    );
    assert.equal(Number(rows.rows[0].count), 0);
  });

  test('a balanced manual journal posts header, lines, subledger and audit together', async () => {
    const res = await post('/api/accounting/journals', tokens.accountant, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST sale on account',
      sourceId: 'ACC-TEST-BAL',
      lines: [
        line(accounts.receivable, 1130, 0, {
          subledgerType: 'CUSTOMER', partyId: 'ACC-TEST-CUST-1', partyName: 'ACC Test Customer',
        }),
        line(accounts.sales, 0, 1130),
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.branchId, BR);
    assert.match(res.json.journalNo, /^MJ-2083-84-\d{5}$/);
    assert.equal(res.json.status, 'POSTED');
    assert.equal(res.json.totalDebit, 1130);
    assert.equal(res.json.totalCredit, 1130);
    assert.equal(res.json.lines.length, 2);
    assert.equal(res.json.subledgerEntries.length, 1);
    assert.equal(res.json.subledgerEntries[0].subledgerType, 'CUSTOMER');
    assert.equal(res.json.subledgerEntries[0].partyId, 'ACC-TEST-CUST-1');

    const stored = await pool!.query(
      `SELECT j.id, j.journal_no, j.posted_by, j.branch_id, j.status,
              (SELECT COUNT(*)::int FROM gl_journal_lines l WHERE l.journal_id = j.id) AS lines,
              (SELECT COUNT(*)::int FROM gl_subledger_entries s WHERE s.journal_id = j.id) AS subledger
       FROM gl_journals j WHERE j.id = $1`,
      [res.json.id]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].posted_by, 'acc-accountant@example.com');
    assert.equal(stored.rows[0].branch_id, BR);
    assert.equal(stored.rows[0].status, 'POSTED');
    assert.equal(Number(stored.rows[0].lines), 2);
    assert.equal(Number(stored.rows[0].subledger), 1);

    const audit = await pool!.query(
      "SELECT * FROM audit_logs WHERE action = 'POST_ACCOUNTING_JOURNAL' AND details LIKE $1",
      [`%${res.json.journalNo}%`]
    );
    assert.equal(audit.rowCount, 1, 'the posting and its audit row must commit together');

    const detail = await get('/api/accounting/journals/' + res.json.id, tokens.super);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.lines.length, 2);
    assert.equal(detail.json.subledgerEntries.length, 1);
  });

  test('a control account reconciles to its subledger and exposes a real difference', async () => {
    const listed = await get('/api/accounting/journals?query=ACC%20TEST%20sale%20on%20account', tokens.super);
    assert.equal(listed.status, 200);
    const journal = listed.json.data.find((row: any) => row.branchId === BR);
    assert.ok(journal, 'the posted journal must be listed');

    const reconciled = await get(
      `/api/accounting/reconciliations?accountId=${accounts.receivable}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.json));
    assert.equal(reconciled.json.subledgerType, 'CUSTOMER');
    assert.equal(reconciled.json.glBalance, 1130);
    assert.equal(reconciled.json.subledgerBalance, 1130);
    assert.equal(reconciled.json.difference, 0);
    assert.equal(reconciled.json.status, 'RECONCILED');

    // Altering the subledger alone must be visible: this is what catches a
    // hard-coded difference of zero. The GL side is untouched.
    await pool!.query(
      'UPDATE gl_subledger_entries SET debit = debit - 25 WHERE journal_id = $1',
      [journal.id]
    );
    const broken = await get(
      `/api/accounting/reconciliations?accountId=${accounts.receivable}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(broken.status, 200);
    assert.equal(broken.json.glBalance, 1130);
    assert.equal(broken.json.subledgerBalance, 1105);
    assert.equal(broken.json.difference, 25);
    assert.equal(broken.json.status, 'DIFFERENCE');
    assert.equal(broken.json.parties[0].partyId, 'ACC-TEST-CUST-1');

    await pool!.query(
      'UPDATE gl_subledger_entries SET debit = debit + 25 WHERE journal_id = $1',
      [journal.id]
    );
    const restored = await get(
      `/api/accounting/reconciliations?accountId=${accounts.receivable}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(restored.json.status, 'RECONCILED');

    const ordinary = await get(
      `/api/accounting/reconciliations?accountId=${accounts.cash}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(ordinary.status, 400);
    assert.match(ordinary.json.message, /not a control account/i);
  });

  test('a branch accountant sees and posts only its own branch', async () => {
    const brJournal = await post('/api/accounting/journals', tokens.accountant, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST branch journal',
      sourceId: 'ACC-TEST-BR',
      lines: [line(accounts.cash, 300, 0), line(accounts.sales, 0, 300)],
    });
    assert.equal(brJournal.status, 201, JSON.stringify(brJournal.json));

    const whJournal = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: JOURNAL_DATE,
      branchId: WH,
      memo: 'ACC TEST warehouse journal',
      sourceId: 'ACC-TEST-WH',
      lines: [line(accounts.cash, 700, 0), line(accounts.sales, 0, 700)],
    });
    assert.equal(whJournal.status, 201, JSON.stringify(whJournal.json));

    const own = await get('/api/accounting/journals?query=ACC%20TEST', tokens.accountant);
    assert.equal(own.status, 200);
    assert.ok(own.json.data.length > 0);
    assert.ok(own.json.data.every((row: any) => row.branchId === BR));
    assert.ok(!own.json.data.some((row: any) => row.branchId === WH));

    const forged = await get('/api/accounting/journals?branchId=' + WH, tokens.accountant);
    assert.equal(forged.status, 403);

    const foreignByPost = await post('/api/accounting/journals', tokens.accountant, {
      journalDateAD: JOURNAL_DATE,
      branchId: WH,
      memo: 'ACC TEST foreign post',
      sourceId: 'ACC-TEST-FOREIGN',
      lines: [line(accounts.cash, 10, 0), line(accounts.sales, 0, 10)],
    });
    assert.equal(foreignByPost.status, 403);

    const foreignRead = await get('/api/accounting/journals/' + whJournal.json.id, tokens.accountant);
    assert.equal(foreignRead.status, 403);

    const ownRead = await get('/api/accounting/journals/' + brJournal.json.id, tokens.accountant);
    assert.equal(ownRead.status, 200);
    assert.equal(ownRead.json.branchId, BR);
  });

  test('an account with no branch scope gets an empty ledger and cannot post', async () => {
    const listed = await get('/api/accounting/journals', tokens.empty);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.data, []);
    assert.equal(listed.json.totalItems, 0);

    const refused = await post('/api/accounting/journals', tokens.empty, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST no scope',
      lines: [line(accounts.cash, 10, 0), line(accounts.sales, 0, 10)],
    });
    assert.equal(refused.status, 403);
  });

  test('gl-view, gl-post and gl-close are enforced independently', async () => {
    assert.equal((await get('/api/accounting/accounts', tokens.noView)).status, 403);
    assert.equal((await get('/api/accounting/journals', tokens.noView)).status, 403);

    assert.equal((await get('/api/accounting/accounts', tokens.auditor)).status, 200);
    assert.equal((await get('/api/accounting/journals', tokens.auditor)).status, 200);

    const auditorPost = await post('/api/accounting/journals', tokens.auditor, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACC TEST auditor post',
      lines: [line(accounts.cash, 10, 0), line(accounts.sales, 0, 10)],
    });
    assert.equal(auditorPost.status, 403);

    const auditorClose = await post(`/api/accounting/periods/${PERIOD_KEY}/close`, tokens.auditor, {});
    assert.equal(auditorClose.status, 403);

    const unauthenticated = await get('/api/accounting/accounts');
    assert.equal(unauthenticated.status, 401);
  });
});
