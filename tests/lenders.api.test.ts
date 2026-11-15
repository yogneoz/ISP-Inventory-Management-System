/**
 * LEND-1 — lender master, loan register and lender statement over real HTTP.
 *
 * The statement is the important half: it must read the same posted
 * `gl_subledger_entries` rows the Loan Payable control uses, show the lender's
 * opening/movement/closing and prove the control reconciles. The test posts a
 * real journal after creating the lender, so a screen-only register cannot pass.
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
import {
  ensureDefaultChart,
  ensureDefaultSubledgers,
} from '../server/src/services/accountingSeed.service';

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
const OTHER_BRANCH = 'WH001';
const JOURNAL_DATE = '2026-08-15';
const PERIOD_KEY = '2026-08';
const LENDER_CODE = 'LNT-OWNER';
const UNUSED_CODE = 'LNT-UNUSED';

const USERS = {
  super: {
    id: 'lnt-super', email: 'lnt-super@example.com', name: 'LNT Super', role: 'SUPER_ADMIN',
    branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false,
  },
  accountant: {
    id: 'lnt-accountant', email: 'lnt-accountant@example.com', name: 'LNT Accountant',
    role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false,
  },
  auditor: {
    id: 'lnt-auditor', email: 'lnt-auditor@example.com', name: 'LNT Auditor', role: 'AUDITOR',
    branchId: BR, allowedBranchIds: [BR], canSwitchUser: false,
  },
  noView: {
    id: 'lnt-frontdesk', email: 'lnt-frontdesk@example.com', name: 'LNT Front Desk',
    role: 'FRONT_DESK', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false,
  },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

describe('lender master, loan register and statement API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let lenderId = '';
  let loanId = '';
  let loanNumber = '';
  let cashAccountId = '';
  let loanAccountId = '';

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
    try { json = await res.json(); } catch { /* non-JSON is a finding */ }
    return { status: res.status, json };
  }

  const get = (path: string, token?: string) => request('GET', path, token);
  const post = (path: string, token: string | undefined, body: unknown) => request('POST', path, token, body);
  const patch = (path: string, token: string | undefined, body: unknown) => request('PATCH', path, token, body);
  const del = (path: string, token?: string) => request('DELETE', path, token);

  async function openPeriod(): Promise<void> {
    const created = await post('/api/accounting/periods', tokens.super, { periodKey: PERIOD_KEY });
    if (created.status === 201) return;
    const existing = await pool!.query(
      `SELECT id, status FROM gl_periods WHERE period_key = $1 ORDER BY start_date_ad DESC LIMIT 1`,
      [PERIOD_KEY]
    );
    if (existing.rows[0]?.status === 'CLOSED') {
      const reopened = await post(
        `/api/accounting/periods/${existing.rows[0].id}/reopen`,
        tokens.super,
        {}
      );
      assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    }
  }

  async function cleanup(): Promise<void> {
    await pool!.query(
      `DELETE FROM loan_interest_accruals
        WHERE lender_id IN (SELECT id FROM lenders WHERE code LIKE 'LNT-%')`
    );
    await pool!.query(
      `DELETE FROM loan_installments
        WHERE loan_id IN (
          SELECT id FROM loans WHERE lender_id IN (SELECT id FROM lenders WHERE code LIKE 'LNT-%')
        )`
    );
    await pool!.query(
      `DELETE FROM loan_transactions
        WHERE lender_id IN (SELECT id FROM lenders WHERE code LIKE 'LNT-%')`
    );
    await pool!.query(
      `DELETE FROM gl_journals
        WHERE source_id LIKE 'LENDER-TEST-%'
           OR memo LIKE '%LENDER TEST%'
           OR id IN (
                SELECT journal_id FROM gl_subledger_entries
                 WHERE party_id IN (SELECT id FROM lenders WHERE code LIKE 'LNT-%')
              )`
    );
    await pool!.query(
      `DELETE FROM gl_subledger_entries
        WHERE party_id IN (SELECT id FROM lenders WHERE code LIKE 'LNT-%')`
    );
    await pool!.query(
      `DELETE FROM loans WHERE lender_id IN (SELECT id FROM lenders WHERE code LIKE 'LNT-%')`
    );
    await pool!.query(
      `DELETE FROM gl_subledgers WHERE party_id IN (SELECT id FROM lenders WHERE code LIKE 'LNT-%')`
    );
    await pool!.query(`DELETE FROM lenders WHERE code LIKE 'LNT-%'`);
    await pool!.query(
      `DELETE FROM audit_logs WHERE details LIKE '%LNT-%' OR details LIKE '%LENDER TEST%'`
    );
  }

  before(async () => {
    await ensureReferenceData(pool!, JOURNAL_DATE);
    await ensureDefaultChart(pool!);
    await ensureDefaultSubledgers(pool!);
    await cleanup();

    const bank = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(bank);

    const accounts = await pool!.query(
      `SELECT id, code, posting_role AS "postingRole", account_kind AS "accountKind"
         FROM gl_accounts
        WHERE is_active = TRUE AND (posting_role = 'LOAN_PAYABLE' OR posting_role = 'CASH')
        ORDER BY code ASC`
    );
    loanAccountId = accounts.rows.find((row) => row.postingRole === 'LOAN_PAYABLE')?.id || '';
    cashAccountId =
      accounts.rows.find((row) => row.postingRole === 'CASH')?.id ||
      accounts.rows.find((row) => row.accountKind === 'CASH')?.id ||
      '';
    assert.ok(loanAccountId, 'the seeded Loan Payable control account is required');
    assert.ok(cashAccountId, 'a cash ledger is required to post the borrowing');

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () =>
      new Promise<void>((done) => {
        server.close(() => done());
      });
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('creates the lender master and its LENDER book, refusing duplicate or malformed identity', async () => {
    const created = await post('/api/accounting/lenders', tokens.super, {
      code: LENDER_CODE,
      name: 'LENDER TEST Owner',
      lenderType: 'OWNER',
      panNumber: 'PAN-LNT-1',
      registrationNumber: 'REG-LNT-1',
      phone: '9800000000',
      address: 'Kathmandu',
      notes: 'LENDER TEST',
      defaultCashAccountId: cashAccountId,
      defaultInterestAccountId: 'gla-6700',
      defaultTdsAccountId: 'gla-2360',
      defaultLoanAccountId: loanAccountId,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.ok(created.json.id, 'lender id');
    assert.equal(created.json.code, LENDER_CODE);
    assert.equal(created.json.lenderType, 'OWNER');
    assert.equal(created.json.registrationNumber, 'REG-LNT-1');
    assert.equal(created.json.defaultCashAccountId, cashAccountId);
    assert.equal(created.json.defaultInterestAccountId, 'gla-6700');
    assert.equal(created.json.defaultTdsAccountId, 'gla-2360');
    assert.equal(created.json.defaultLoanAccountId, loanAccountId);
    assert.ok(created.json.bookId, 'creating a lender must create its LENDER party book');
    assert.match(created.json.bookCode, /^LEN-/);
    lenderId = created.json.id;

    const duplicate = await post('/api/accounting/lenders', tokens.super, {
      code: LENDER_CODE,
      name: 'LENDER TEST duplicate',
      lenderType: 'OTHER',
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));

    const badCode = await post('/api/accounting/lenders', tokens.super, {
      code: 'bad code!',
      name: 'LENDER TEST bad',
      lenderType: 'OWNER',
    });
    assert.equal(badCode.status, 400, JSON.stringify(badCode.json));

    const list = await get('/api/accounting/lenders?includeInactive=1', tokens.super);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const row = (list.json as any[]).find((item) => item.id === lenderId);
    assert.ok(row, 'the lender must appear in the master');
    assert.equal(row.bookId, created.json.bookId);
    assert.equal(row.loanCount, 0);
    assert.equal(row.bookBalance, 0);

    const unused = await post('/api/accounting/lenders', tokens.super, {
      code: UNUSED_CODE,
      name: 'LENDER TEST Unused',
      lenderType: 'OTHER',
    });
    assert.equal(unused.status, 201, JSON.stringify(unused.json));
    const removed = await del(`/api/accounting/lenders/${unused.json.id}`, tokens.super);
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    const gone = await pool!.query('SELECT COUNT(*)::int AS count FROM lenders WHERE code = $1', [UNUSED_CODE]);
    assert.equal(Number(gone.rows[0].count), 0);
  });

  test('registers loan terms and refuses a maturity before the start date', async () => {
    const created = await post('/api/accounting/loans', tokens.super, {
      lenderId,
      branchId: BR,
      principal: 500,
      interestRate: 8.5,
      startDateAD: '2026-08-01',
      maturityDateAD: '2027-07-31',
      repaymentFrequency: 'QUARTERLY',
      installmentAmount: 125,
      securityType: 'UNSECURED',
      status: 'OPEN',
      agreementReference: 'LENDER TEST AGREEMENT',
      notes: 'LENDER TEST loan',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.lenderId, lenderId);
    assert.equal(created.json.principal, 500);
    assert.equal(created.json.interestRate, 8.5);
    assert.equal(created.json.repaymentFrequency, 'QUARTERLY');
    assert.equal(created.json.status, 'OPEN');
    assert.match(created.json.loanNumber, /^LOAN-/);
    assert.equal(created.json.installmentCount, 4);
    assert.equal(created.json.nextDueDateAD, '2026-11-01');
    assert.equal(created.json.scheduledPrincipal, 500);
    loanId = created.json.id;
    loanNumber = created.json.loanNumber;

    const badDates = await post('/api/accounting/loans', tokens.super, {
      lenderId,
      branchId: BR,
      principal: 100,
      interestRate: 0,
      startDateAD: '2026-08-10',
      maturityDateAD: '2026-08-01',
      repaymentFrequency: 'LUMP_SUM',
      securityType: 'UNSECURED',
      status: 'OPEN',
    });
    assert.equal(badDates.status, 400, JSON.stringify(badDates.json));
    assert.match(badDates.json.message, /maturity/i);

    const updated = await patch(`/api/accounting/loans/${loanId}`, tokens.super, {
      interestRate: 9.25,
      installmentAmount: 125,
      status: 'OPEN',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.interestRate, 9.25);

    const list = await get(`/api/accounting/loans?lenderId=${lenderId}`, tokens.super);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].loanNumber, loanNumber);
  });

  test('receives the loan through the posting path and reconciles the lender statement', async () => {
    await openPeriod();

    const receipt = await post(`/api/accounting/loans/${loanId}/receipts`, tokens.super, {
      dateAD: JOURNAL_DATE,
      principal: 500,
      chequeNo: 'LNT-CHQ-1',
      referenceNo: 'LNT-REF-1',
    });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.json));
    assert.equal(receipt.json.transaction.txnType, 'RECEIPT');
    assert.equal(receipt.json.transaction.principalAmount, 500);
    assert.equal(receipt.json.transaction.cashAmount, 500);
    assert.equal(receipt.json.transaction.interestAmount, 0);
    assert.equal(receipt.json.transaction.cashAccountId, cashAccountId);
    assert.match(receipt.json.transaction.txnNumber, /^LR-/);
    assert.equal(receipt.json.loan.fundedPrincipal, 500);
    assert.equal(receipt.json.loan.outstandingPrincipal, 500);

    const stored = await pool!.query(
      `SELECT se.party_id, se.subledger_id, se.credit, j.source_type, j.status
         FROM gl_subledger_entries se
         JOIN gl_journals j ON j.id = se.journal_id
        WHERE se.journal_id = $1`,
      [receipt.json.transaction.journalId]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].party_id, lenderId);
    assert.ok(stored.rows[0].subledger_id, 'the posting must use the lender book');
    assert.equal(Number(stored.rows[0].credit), 500);
    assert.equal(stored.rows[0].source_type, 'LOAN_RECEIPT');
    assert.equal(stored.rows[0].status, 'POSTED');

    const duplicate = await post(`/api/accounting/loans/${loanId}/receipts`, tokens.super, {
      dateAD: JOURNAL_DATE,
      principal: 1,
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /fully received/i);

    const matured = await patch(`/api/accounting/loans/${loanId}`, tokens.super, {
      maturityDateAD: '2026-08-10',
    });
    assert.equal(matured.status, 200, JSON.stringify(matured.json));
    assert.equal(matured.json.overdue, true);
    assert.equal(matured.json.installmentCount, 1, 'a term change without repayments regenerates the schedule');
    assert.equal(matured.json.overdueInstallments, 1);
    const overdueList = await get(`/api/accounting/loans?lenderId=${lenderId}&overdue=1`, tokens.super);
    assert.equal(overdueList.status, 200, JSON.stringify(overdueList.json));
    assert.deepEqual(
      overdueList.json.map((loan: any) => loan.id),
      [loanId]
    );

    const statement = await get(
      `/api/accounting/lenders/${lenderId}/statement?from=2026-08-01&to=2026-08-31`,
      tokens.super
    );
    assert.equal(statement.status, 200, JSON.stringify(statement.json));
    assert.equal(statement.json.lender.code, LENDER_CODE);
    assert.ok(statement.json.book?.id, 'the statement must name the lender book');
    assert.equal(statement.json.control?.accountCode, '2350');
    assert.equal(statement.json.openingBalance, 0);
    assert.equal(statement.json.totals.debit, 0);
    assert.equal(statement.json.totals.credit, 500);
    assert.equal(statement.json.totals.closingBalance, 500);
    assert.equal(statement.json.entries.length, 1);
    assert.equal(statement.json.entries[0].credit, 500);
    assert.equal(statement.json.entries[0].partyId, lenderId);
    assert.equal(statement.json.tieOut.status, 'RECONCILED');
    assert.equal(statement.json.tieOut.difference, 0);
    assert.equal(statement.json.tieOut.booksDifference, 0);
    assert.equal(
      statement.json.tieOut.lenderBooksBalance,
      statement.json.tieOut.subledgerBalance - statement.json.tieOut.unassignedLenderBalance
    );
    assert.equal(statement.json.loans.length, 1);
    assert.equal(statement.json.loans[0].loanNumber, loanNumber);

    const master = await get('/api/accounting/lenders?includeInactive=1', tokens.super);
    const row = (master.json as any[]).find((item) => item.id === lenderId);
    assert.equal(row.bookBalance, 500);
    assert.equal(row.openPrincipal, 500);

    const history = await get(`/api/accounting/loans/${loanId}`, tokens.super);
    assert.equal(history.status, 200, JSON.stringify(history.json));
    assert.equal(history.json.transactions.length, 1);
    assert.equal(history.json.transactions[0].txnNumber, receipt.json.transaction.txnNumber);

    const blockedDelete = await del(`/api/accounting/lenders/${lenderId}`, tokens.super);
    assert.equal(blockedDelete.status, 409, JSON.stringify(blockedDelete.json));

    const accrual = await post(`/api/accounting/loans/${loanId}/interest-accruals`, tokens.super, {
      fromAD: '2026-08-01',
      toAD: '2026-08-10',
    });
    assert.equal(accrual.status, 201, JSON.stringify(accrual.json));
    assert.match(accrual.json.accrual.accrualNumber, /^LA-/);
    assert.equal(accrual.json.accrual.days, 10);
    assert.equal(accrual.json.accrual.principalBase, 500);
    assert.equal(accrual.json.accrual.interestAmount, 1.27);
    assert.equal(accrual.json.loan.interestAccrued, 1.27);

    const overlap = await post(`/api/accounting/loans/${loanId}/interest-accruals`, tokens.super, {
      fromAD: '2026-08-05',
      toAD: '2026-08-12',
    });
    assert.equal(overlap.status, 409, JSON.stringify(overlap.json));
    assert.match(overlap.json.message, /overlaps/i);

    const withSchedule = await get(`/api/accounting/loans/${loanId}`, tokens.super);
    assert.equal(withSchedule.status, 200, JSON.stringify(withSchedule.json));
    assert.equal(withSchedule.json.installments.length, 1);
    assert.equal(withSchedule.json.installments[0].principalDue, 500);
    assert.equal(withSchedule.json.installments[0].principalPaid, 0);
    assert.equal(withSchedule.json.installments[0].status, 'OVERDUE');
    assert.equal(withSchedule.json.accruals.length, 1);
    assert.equal(withSchedule.json.accruals[0].journalStatus, 'POSTED');

    const accrualJournal = await pool!.query(
      `SELECT account_id, debit, credit
         FROM gl_journal_lines
        WHERE journal_id = $1
        ORDER BY debit DESC, account_id`,
      [withSchedule.json.accruals[0].journalId]
    );
    const accrualLines = new Map(
      accrualJournal.rows.map((row) => [row.account_id, { debit: Number(row.debit), credit: Number(row.credit) }])
    );
    assert.deepEqual(accrualLines.get('gla-6700'), { debit: 1.27, credit: 0 });
    assert.deepEqual(accrualLines.get('gla-2370'), { debit: 0, credit: 1.27 });
  });

  test('repays principal, interest and TDS through the posting path and closes on full repayment', async () => {
    const invalidTds = await post(`/api/accounting/loans/${loanId}/repayments`, tokens.super, {
      dateAD: '2026-08-20',
      principal: 200,
      interestAmount: 20,
      tdsAmount: 25,
    });
    assert.equal(invalidTds.status, 400, JSON.stringify(invalidTds.json));
    assert.match(invalidTds.json.message, /TDS cannot exceed/i);

    const tooMuch = await post(`/api/accounting/loans/${loanId}/repayments`, tokens.super, {
      dateAD: '2026-08-20',
      principal: 501,
    });
    assert.equal(tooMuch.status, 400, JSON.stringify(tooMuch.json));
    assert.match(tooMuch.json.message, /exceeds the outstanding/i);

    const repayment = await post(`/api/accounting/loans/${loanId}/repayments`, tokens.super, {
      dateAD: '2026-08-20',
      principal: 200,
      interestAmount: 20,
      tdsAmount: 2,
      referenceNo: 'LNT-REPAY-1',
    });
    assert.equal(repayment.status, 201, JSON.stringify(repayment.json));
    assert.equal(repayment.json.transaction.txnType, 'REPAYMENT');
    assert.equal(repayment.json.transaction.principalAmount, 200);
    assert.equal(repayment.json.transaction.interestAmount, 20);
    assert.equal(repayment.json.transaction.tdsAmount, 2);
    assert.equal(repayment.json.transaction.cashAmount, 218);
    assert.equal(repayment.json.transaction.interestAccountId, 'gla-6700');
    assert.equal(repayment.json.transaction.tdsAccountId, 'gla-2360');
    assert.equal(repayment.json.transaction.interestPayableApplied, 1.27);
    assert.match(repayment.json.transaction.txnNumber, /^LP-/);
    assert.equal(repayment.json.loan.fundedPrincipal, 500);
    assert.equal(repayment.json.loan.repaidPrincipal, 200);
    assert.equal(repayment.json.loan.outstandingPrincipal, 300);
    assert.equal(repayment.json.loan.interestPaid, 20);
    assert.equal(repayment.json.loan.tdsWithheld, 2);
    assert.equal(repayment.json.loan.interestAccrued, 1.27);
    assert.equal(repayment.json.loan.status, 'OPEN');

    const journalLines = await pool!.query(
      `SELECT account_id, debit, credit
         FROM gl_journal_lines
        WHERE journal_id = $1
        ORDER BY debit DESC, account_id`,
      [repayment.json.transaction.journalId]
    );
    assert.equal(journalLines.rowCount, 5);
    const byAccount = new Map(
      journalLines.rows.map((row) => [row.account_id, { debit: Number(row.debit), credit: Number(row.credit) }])
    );
    assert.deepEqual(byAccount.get(loanAccountId), { debit: 200, credit: 0 });
    assert.deepEqual(byAccount.get('gla-2370'), { debit: 1.27, credit: 0 });
    assert.deepEqual(byAccount.get('gla-6700'), { debit: 18.73, credit: 0 });
    assert.deepEqual(byAccount.get('gla-2360'), { debit: 0, credit: 2 });
    assert.deepEqual(byAccount.get(cashAccountId), { debit: 0, credit: 218 });

    const finalStatement = await get(
      `/api/accounting/lenders/${lenderId}/statement?from=2026-08-01&to=2026-08-31`,
      tokens.super
    );
    assert.equal(finalStatement.status, 200, JSON.stringify(finalStatement.json));
    assert.equal(finalStatement.json.totals.debit, 200);
    assert.equal(finalStatement.json.totals.credit, 500);
    assert.equal(finalStatement.json.totals.closingBalance, 300);
    assert.equal(finalStatement.json.entries.length, 2);
    assert.equal(finalStatement.json.entries[0].dateBS !== null, true);
    assert.equal(finalStatement.json.tdsEntries.length, 1);
    assert.equal(finalStatement.json.tdsEntries[0].loanNumber, loanNumber);
    assert.equal(finalStatement.json.tdsEntries[0].interestAmount, 20);
    assert.equal(finalStatement.json.tdsEntries[0].tdsAmount, 2);
    assert.deepEqual(finalStatement.json.tdsTotals, { interest: 20, tds: 2, cash: 218 });

    const openingBeforeReceipt = await get(
      `/api/accounting/lenders/${lenderId}/statement?from=2026-08-16&to=2026-08-31`,
      tokens.super
    );
    assert.equal(openingBeforeReceipt.status, 200, JSON.stringify(openingBeforeReceipt.json));
    assert.equal(openingBeforeReceipt.json.openingBalance, 500);
    assert.equal(openingBeforeReceipt.json.totals.debit, 200);
    assert.equal(openingBeforeReceipt.json.totals.credit, 0);
    assert.equal(openingBeforeReceipt.json.totals.closingBalance, 300);

    const finalRepayment = await post(`/api/accounting/loans/${loanId}/repayments`, tokens.super, {
      dateAD: '2026-08-25',
      principal: 300,
      interestAmount: 0,
      tdsAmount: 0,
    });
    assert.equal(finalRepayment.status, 201, JSON.stringify(finalRepayment.json));
    assert.equal(finalRepayment.json.loan.outstandingPrincipal, 0);
    assert.equal(finalRepayment.json.loan.status, 'CLOSED');

    const overdue = await get('/api/accounting/loans?overdue=1', tokens.super);
    assert.equal(overdue.status, 200, JSON.stringify(overdue.json));
    assert.equal(overdue.json.some((loan: any) => loan.id === loanId), false);
  });

  test('retirement waits for open loans, and a branch account cannot touch another branch', async () => {
    const openLoan = await post('/api/accounting/loans', tokens.super, {
      lenderId,
      branchId: BR,
      principal: 50,
      interestRate: 1,
      startDateAD: '2026-08-01',
      repaymentFrequency: 'LUMP_SUM',
      securityType: 'UNSECURED',
      status: 'OPEN',
    });
    assert.equal(openLoan.status, 201, JSON.stringify(openLoan.json));

    const blockedRetire = await patch(`/api/accounting/lenders/${lenderId}`, tokens.super, {
      name: 'LENDER TEST Owner',
      active: false,
    });
    assert.equal(blockedRetire.status, 409, JSON.stringify(blockedRetire.json));

    const closed = await patch(`/api/accounting/loans/${openLoan.json.id}`, tokens.super, { status: 'CLOSED' });
    assert.equal(closed.status, 200, JSON.stringify(closed.json));
    assert.equal(closed.json.status, 'CLOSED');

    const options = await get('/api/accounting/lenders/options', tokens.accountant);
    assert.equal(options.status, 200, JSON.stringify(options.json));
    assert.ok((options.json as any[]).some((item) => item.id === lenderId));
    assert.equal((options.json as any[])[0].bookBalance, undefined, 'the picker must not expose balances');

    const wrongBranch = await post('/api/accounting/loans', tokens.accountant, {
      lenderId,
      branchId: OTHER_BRANCH,
      principal: 100,
      interestRate: 1,
      startDateAD: '2026-08-01',
      repaymentFrequency: 'LUMP_SUM',
      securityType: 'UNSECURED',
      status: 'OPEN',
    });
    assert.equal(wrongBranch.status, 403, JSON.stringify(wrongBranch.json));

    const retired = await patch(`/api/accounting/lenders/${lenderId}`, tokens.super, {
      name: 'LENDER TEST Owner',
      active: false,
    });
    assert.equal(retired.status, 200, JSON.stringify(retired.json));
    assert.equal(retired.json.active, false);

    const readOnly = await get('/api/accounting/lenders', tokens.auditor);
    assert.equal(readOnly.status, 200, JSON.stringify(readOnly.json));
    const auditorWrite = await post('/api/accounting/lenders', tokens.auditor, {
      code: 'LNT-AUDITOR',
      name: 'LENDER TEST Auditor',
      lenderType: 'OTHER',
    });
    assert.equal(auditorWrite.status, 403, JSON.stringify(auditorWrite.json));
    const auditorReceipt = await post(`/api/accounting/loans/${loanId}/receipts`, tokens.auditor, {
      dateAD: JOURNAL_DATE,
      principal: 1,
    });
    assert.equal(auditorReceipt.status, 403, JSON.stringify(auditorReceipt.json));
    const auditorRepayment = await post(`/api/accounting/loans/${loanId}/repayments`, tokens.auditor, {
      dateAD: JOURNAL_DATE,
      principal: 1,
    });
    assert.equal(auditorRepayment.status, 403, JSON.stringify(auditorRepayment.json));
    const auditorAccrual = await post(`/api/accounting/loans/${loanId}/interest-accruals`, tokens.auditor, {
      fromAD: '2026-08-21',
      toAD: '2026-08-22',
    });
    assert.equal(auditorAccrual.status, 403, JSON.stringify(auditorAccrual.json));

    const noView = await get('/api/accounting/lenders', tokens.noView);
    assert.equal(noView.status, 403, JSON.stringify(noView.json));
    const noViewLoan = await get(`/api/accounting/loans/${loanId}`, tokens.noView);
    assert.equal(noViewLoan.status, 403, JSON.stringify(noViewLoan.json));
    const noViewStatement = await get(
      `/api/accounting/lenders/${lenderId}/statement`,
      tokens.noView
    );
    assert.equal(noViewStatement.status, 403, JSON.stringify(noViewStatement.json));
  });
});
