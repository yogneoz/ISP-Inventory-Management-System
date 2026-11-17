import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * Bank reconciliation through the real HTTP routes and PostgreSQL.
 *
 * The claims pinned here are the ones the corrected model names: a bank
 * statement belongs to one company bank account and one period; branches post
 * to that same account, so the book side combines them and branch attribution
 * appears on the book lines; re-importing the same statement creates no
 * duplicates; exact matching is audited and can be undone; a locked period
 * refuses unmatch/import/session changes until reopened with a reason; and a
 * branch-scoped user cannot reconcile the shared company account. Set
 * `ACCOUNTING_PROOF=1` to print the compact book/match/scope responses used by
 * the evidence run.
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

const BR = 'bkr-branch';
const OTHER = 'bkr-other';
const TEST_BANK = 'bkr-bank-account';
const TEST_BANK_CODE = 'BKRBANK';
const today = new Date().toISOString().split('T')[0];

const USERS = {
  super: { id: 'bkr-super', email: 'bkr-super@example.com', name: 'BKR Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  accountant: { id: 'bkr-accountant', email: 'bkr-accountant@example.com', name: 'BKR Accountant', role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  other: { id: 'bkr-other-user', email: 'bkr-other@example.com', name: 'BKR Other', role: 'ACCOUNTANT', branchId: OTHER, allowedBranchIds: [OTHER], canSwitchUser: false },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

const CSV = [
  'date,description,reference,amount',
  `${today},Customer deposit,DEP-1,500`,
  `${today},Vendor payment,PAY-1,-200`,
].join('\n');

describe('bank reconciliation (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let bankAccountId = TEST_BANK;
  let revenueAccountId = '';
  let firstLineId = '';
  let matchedJournalLineId = '';
  let otherLineId = '';
  let otherJournalLineId = '';
  let sessionId = '';

  async function request(method: 'GET' | 'POST', path: string, token?: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  const get = (path: string, token: string = tokens.super) => request('GET', path, token);
  const post = (path: string, body: unknown, token: string = tokens.super) => request('POST', path, token, body);

  function workspacePath(extra = '') {
    return `/api/accounting/bank-reconciliation?accountId=${bankAccountId}&from=${today}&to=${today}${extra}`;
  }

  async function cleanup() {
    await pool!.query('DELETE FROM bank_statement_lines WHERE bank_account_id = $1', [TEST_BANK]);
    await pool!.query('DELETE FROM bank_reconciliation_sessions WHERE bank_account_id = $1', [TEST_BANK]);
    await pool!.query(
      `DELETE FROM gl_journal_lines
       WHERE journal_id IN (SELECT id FROM gl_journals WHERE branch_id = ANY($1::varchar[]))`,
      [[BR, OTHER]]
    );
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = ANY($1::varchar[])', [[BR, OTHER]]);
    await purgeAuditLogs(pool!, 'DELETE FROM audit_logs WHERE user_email = ANY($1::varchar[])', [
      [USERS.super.email, USERS.accountant.email, USERS.other.email],
    ]);
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [[BR, OTHER]]);
    await pool!.query('DELETE FROM gl_accounts WHERE id = $1', [TEST_BANK]);
  }

  async function postJournal(branchId: string, sourceId: string, amount: number, memo: string) {
    const lines = amount >= 0
      ? [
          { accountId: bankAccountId, debit: amount, credit: 0 },
          { accountId: revenueAccountId, debit: 0, credit: amount },
        ]
      : [
          { accountId: bankAccountId, debit: 0, credit: Math.abs(amount) },
          { accountId: revenueAccountId, debit: Math.abs(amount), credit: 0 },
        ];
    const response = await post('/api/accounting/journals', {
      journalDateAD: today,
      branchId,
      sourceId,
      memo,
      lines,
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    return response;
  }

  before(async () => {
    await ensureReferenceData(pool!, today);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
        ($1, 'BKRB', 'Bank Reconciliation Branch', 'Test'),
        ($2, 'BKRO', 'Bank Reconciliation Other', 'Test')`,
      [BR, OTHER]
    );

    const bankGroup = (await pool!.query(
      `SELECT group_id FROM gl_accounts
       WHERE account_kind = 'BANK'
       ORDER BY CASE WHEN posting_role = 'BANK' THEN 0 ELSE 1 END
       LIMIT 1`
    )).rows[0] as { group_id: string } | undefined;
    assert.ok(bankGroup, 'a default bank ledger group is required for the test account');
    await pool!.query(
      `INSERT INTO gl_accounts (
         id, code, name, group_id, is_control, subledger_type, posting_role,
         account_kind, bank_name, bank_branch, account_number, is_active
       ) VALUES ($1, $2, 'BKR Test Bank', $3, FALSE, 'NONE', NULL, 'BANK', 'BKR Bank', 'Test', '000-BKR', TRUE)`,
      [TEST_BANK, TEST_BANK_CODE, bankGroup.group_id]
    );

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

    const defaults = await get('/api/accounting/posting-defaults');
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    revenueAccountId = defaults.json.defaults.SALES.accountId;
    assert.ok(bankAccountId && revenueAccountId);

    await postJournal(BR, 'bkr-deposit', 500, 'BKR customer deposit');
    await postJournal(OTHER, 'bkr-payment', -200, 'BKR vendor payment from another branch');
  });

  after(async () => {
    if (!pool) return;
    try { await cleanup(); } finally {
      await close?.();
      await pool.end();
    }
  });

  test('imports one account statement and combines every branch in the bank book', async () => {
    const first = await post('/api/accounting/bank-reconciliation/import', {
      accountId: bankAccountId,
      from: today,
      to: today,
      content: CSV,
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.imported, 2);
    assert.equal(first.json.duplicates, 0);
    assert.equal(first.json.workspace.statement.lineCount, 2);
    assert.equal(first.json.workspace.book.closingBalance, 300);
    assert.equal(first.json.workspace.statement.closingBalance, 300);
    assert.equal(first.json.workspace.difference, 0);
    assert.equal(first.json.workspace.reconciled, true);
    assert.equal(first.json.workspace.book.entries.length, 2);
    assert.deepEqual(
      first.json.workspace.book.entries.map((entry: any) => [entry.branchCode, entry.branchId]).sort(),
      [['BKRB', BR], ['BKRO', OTHER]].sort(),
      'the company bank book must include both branches with metadata'
    );
    assert.match(first.json.workspace.lines[0].statementDateBS, / BS$/);

    const duplicate = await post('/api/accounting/bank-reconciliation/import', {
      accountId: bankAccountId,
      from: today,
      to: today,
      content: CSV,
    });
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
    assert.equal(duplicate.json.imported, 0);
    assert.equal(duplicate.json.duplicates, 2);
    assert.equal(duplicate.json.workspace.statement.lineCount, 2);

    const workspace = await get(workspacePath());
    assert.equal(workspace.status, 200, JSON.stringify(workspace.json));
    const incoming = workspace.json.lines.find((line: any) => line.amount === 500);
    const outgoing = workspace.json.lines.find((line: any) => line.amount === -200);
    assert.ok(incoming && outgoing);
    firstLineId = incoming.id;
    otherLineId = outgoing.id;
    matchedJournalLineId = workspace.json.book.entries.find((entry: any) => entry.amount === 500).journalLineId;
    const otherBranchEntry = workspace.json.book.entries.find((entry: any) => entry.amount === -200);
    otherJournalLineId = otherBranchEntry.journalLineId;
    assert.equal(otherBranchEntry.branchCode, 'BKRO');
    assert.equal(otherBranchEntry.branchId, OTHER);
    assert.ok(matchedJournalLineId && otherJournalLineId);
    assert.equal(incoming.suggestedJournalLineId, matchedJournalLineId);

    if (process.env.ACCOUNTING_PROOF === '1') {
      console.log('BANK_BOOK_PROOF ' + JSON.stringify({
        accountId: bankAccountId,
        imported: first.json.imported,
        bookEntries: first.json.workspace.book.entries.map((entry: any) => ({
          branchId: entry.branchId,
          branchCode: entry.branchCode,
          branchName: entry.branchName,
          amount: entry.amount,
          journalLineId: entry.journalLineId,
        })),
      }));
    }
  });

  test('matches and unmatches an exact line and audits both', async () => {
    const matched = await post(
      `/api/accounting/bank-reconciliation/lines/${firstLineId}/match`,
      { accountId: bankAccountId, from: today, to: today, journalLineId: matchedJournalLineId }
    );
    assert.equal(matched.status, 200, JSON.stringify(matched.json));
    assert.equal(matched.json.journalNo.length > 0, true);
    assert.equal(matched.json.workspace.statement.matchedCount, 1);
    assert.equal(
      matched.json.workspace.book.entries.find((entry: any) => entry.journalLineId === matchedJournalLineId)
        .matchedStatementLineId,
      firstLineId
    );
    assert.equal(
      matched.json.workspace.lines.find((line: any) => line.id === firstLineId).matchedBranchCode,
      'BKRB'
    );

    const wrong = await post(
      `/api/accounting/bank-reconciliation/lines/${firstLineId}/match`,
      { accountId: bankAccountId, from: today, to: today, journalLineId: 'not-a-posted-line' }
    );
    assert.equal(wrong.status, 409, JSON.stringify(wrong.json));

    const unmatched = await post(
      `/api/accounting/bank-reconciliation/lines/${firstLineId}/unmatch`,
      { accountId: bankAccountId, from: today, to: today }
    );
    assert.equal(unmatched.status, 200, JSON.stringify(unmatched.json));
    assert.equal(unmatched.json.previousJournalLineId, matchedJournalLineId);
    assert.equal(unmatched.json.workspace.statement.matchedCount, 0);

    // The outgoing statement line belongs to the OTHER branch. Matching it
    // proves the account-level reconciliation can cross branch boundaries.
    const crossBranch = await post(
      `/api/accounting/bank-reconciliation/lines/${otherLineId}/match`,
      { accountId: bankAccountId, from: today, to: today, journalLineId: otherJournalLineId }
    );
    assert.equal(crossBranch.status, 200, JSON.stringify(crossBranch.json));
    assert.equal(crossBranch.json.workspace.statement.matchedCount, 1);
    assert.equal(
      crossBranch.json.workspace.lines.find((line: any) => line.id === otherLineId).matchedBranchCode,
      'BKRO'
    );
    const crossUnmatch = await post(
      `/api/accounting/bank-reconciliation/lines/${otherLineId}/unmatch`,
      { accountId: bankAccountId, from: today, to: today }
    );
    assert.equal(crossUnmatch.status, 200, JSON.stringify(crossUnmatch.json));

    if (process.env.ACCOUNTING_PROOF === '1') {
      console.log('BANK_MATCH_PROOF ' + JSON.stringify({
        status: crossBranch.status,
        lineId: otherLineId,
        journalLineId: otherJournalLineId,
        matchedBranchId: crossBranch.json.workspace.lines.find((line: any) => line.id === otherLineId).matchedBranchId,
        matchedBranchCode: crossBranch.json.workspace.lines.find((line: any) => line.id === otherLineId).matchedBranchCode,
        matchedBranchName: crossBranch.json.workspace.lines.find((line: any) => line.id === otherLineId).matchedBranchName,
      }));
    }

    const actions = await pool!.query(
      `SELECT action FROM audit_logs
       WHERE user_email = $1 AND action = ANY($2::varchar[])`,
      [USERS.super.email, ['MATCH_BANK_STATEMENT_LINE', 'UNMATCH_BANK_STATEMENT_LINE']]
    );
    assert.deepEqual(
      actions.rows.map((row) => row.action).sort(),
      [
        'MATCH_BANK_STATEMENT_LINE',
        'MATCH_BANK_STATEMENT_LINE',
        'UNMATCH_BANK_STATEMENT_LINE',
        'UNMATCH_BANK_STATEMENT_LINE',
      ],
      'both the same-branch and cross-branch match/unmatch are audited'
    );
  });

  test('locks the account period, refuses changes, then reopens with an audited reason', async () => {
    const saved = await post('/api/accounting/bank-reconciliation/sessions', {
      accountId: bankAccountId,
      from: today,
      to: today,
      openingStatementBalance: 0,
      closingStatementBalance: 300,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    sessionId = saved.json.session.id;
    assert.equal(saved.json.session.status, 'OPEN');
    assert.equal(saved.json.session.branchId, undefined, 'a session has no branch');
    assert.equal(saved.json.workspace.difference, 0);

    const locked = await post(`/api/accounting/bank-reconciliation/sessions/${sessionId}/lock`, {
      accountId: bankAccountId,
      from: today,
      to: today,
    });
    assert.equal(locked.status, 200, JSON.stringify(locked.json));
    assert.equal(locked.json.session.status, 'LOCKED');
    assert.equal(locked.json.changed, true);

    const matchAfterLock = await post(
      `/api/accounting/bank-reconciliation/lines/${firstLineId}/match`,
      { accountId: bankAccountId, from: today, to: today, journalLineId: matchedJournalLineId }
    );
    assert.equal(matchAfterLock.status, 409, JSON.stringify(matchAfterLock.json));

    const importAfterLock = await post('/api/accounting/bank-reconciliation/import', {
      accountId: bankAccountId,
      content: `${CSV}\n${today},Late line,LATE-1,1`,
    });
    assert.equal(importAfterLock.status, 409, JSON.stringify(importAfterLock.json));

    const saveAfterLock = await post('/api/accounting/bank-reconciliation/sessions', {
      accountId: bankAccountId,
      from: today,
      to: today,
      openingStatementBalance: 0,
      closingStatementBalance: 300,
    });
    assert.equal(saveAfterLock.status, 409, JSON.stringify(saveAfterLock.json));

    const reopened = await post(`/api/accounting/bank-reconciliation/sessions/${sessionId}/reopen`, {
      accountId: bankAccountId,
      from: today,
      to: today,
      reason: 'Bank charge correction',
    });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    assert.equal(reopened.json.session.status, 'OPEN');
    assert.equal(reopened.json.session.reopenReason, 'Bank charge correction');

    const rematch = await post(
      `/api/accounting/bank-reconciliation/lines/${firstLineId}/match`,
      { accountId: bankAccountId, from: today, to: today, journalLineId: matchedJournalLineId }
    );
    assert.equal(rematch.status, 200, JSON.stringify(rematch.json));

    const afterReopen = await post(
      `/api/accounting/bank-reconciliation/lines/${firstLineId}/unmatch`,
      { accountId: bankAccountId, from: today, to: today }
    );
    assert.equal(afterReopen.status, 200, JSON.stringify(afterReopen.json));

    const audits = await pool!.query(
      `SELECT action FROM audit_logs
       WHERE user_email = $1 AND action = ANY($2::varchar[])`,
      [USERS.super.email, [
        'IMPORT_BANK_STATEMENT',
        'SAVE_BANK_RECONCILIATION_SESSION',
        'LOCK_BANK_RECONCILIATION_SESSION',
        'REOPEN_BANK_RECONCILIATION_SESSION',
      ]]
    );
    const actions = audits.rows.map((row) => row.action);
    for (const expected of [
      'IMPORT_BANK_STATEMENT',
      'LOCK_BANK_RECONCILIATION_SESSION',
      'REOPEN_BANK_RECONCILIATION_SESSION',
      'SAVE_BANK_RECONCILIATION_SESSION',
    ]) {
      assert.ok(actions.includes(expected), `${expected} must be audited`);
    }
  });

  test('requires company scope and stores no branch on statements or sessions', async () => {
    const branchRead = await get(workspacePath(), tokens.accountant);
    assert.equal(branchRead.status, 403, JSON.stringify(branchRead.json));

    const branchMatch = await post(
      `/api/accounting/bank-reconciliation/lines/${firstLineId}/match`,
      { accountId: bankAccountId, from: today, to: today, journalLineId: matchedJournalLineId },
      tokens.other
    );
    assert.equal(branchMatch.status, 403, JSON.stringify(branchMatch.json));

    const concreteBranchForGlobal = await get(workspacePath(`&branchId=${BR}`));
    assert.equal(concreteBranchForGlobal.status, 403, JSON.stringify(concreteBranchForGlobal.json));

    const allBranches = await get(workspacePath('&branchId=ALL'));
    assert.equal(allBranches.status, 200, JSON.stringify(allBranches.json));
    assert.equal(allBranches.json.branchId, undefined);
    assert.deepEqual(
      allBranches.json.book.entries.map((entry: any) => entry.branchCode).sort(),
      ['BKRB', 'BKRO']
    );

    if (process.env.ACCOUNTING_PROOF === '1') {
      console.log('BANK_SCOPE_PROOF ' + JSON.stringify({
        branchRead: { status: branchRead.status, message: branchRead.json?.message },
        branchWrite: { status: branchMatch.status, message: branchMatch.json?.message },
        allBranchesRead: { status: allBranches.status, branchId: allBranches.json.branchId },
        allBranchesEntries: allBranches.json.book.entries.map((entry: any) => ({
          branchId: entry.branchId,
          branchCode: entry.branchCode,
          branchName: entry.branchName,
          amount: entry.amount,
        })),
      }));
    }

    for (const table of ['bank_statement_lines', 'bank_reconciliation_sessions']) {
      const columns = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'branch_id'`,
        [table]
      );
      assert.equal(columns.rowCount, 0, `${table} must not carry a branch`);
    }

    const uniqueIndexes = await pool!.query(
      `SELECT tablename, indexdef FROM pg_indexes
       WHERE tablename = ANY($1::text[]) AND indexdef ILIKE '%UNIQUE%'`,
      [['bank_statement_lines', 'bank_reconciliation_sessions']]
    );
    const indexDefs = uniqueIndexes.rows.map((row) => String(row.indexdef)).join('\n');
    assert.match(indexDefs, /\(bank_account_id, fingerprint\)/i, 'statement uniqueness is account + fingerprint');
    assert.match(
      indexDefs,
      /\(bank_account_id, period_start, period_end\)/i,
      'session uniqueness is account + period'
    );
    assert.doesNotMatch(indexDefs, /branch_id/i, 'no reconciliation uniqueness key may include a branch');
  });
});
