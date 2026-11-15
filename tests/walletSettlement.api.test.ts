/**
 * ACC-3 — wallet receipts, provider settlements and PSP reconciliation over
 * real HTTP + PostgreSQL.
 *
 * Claims:
 *   1. an ONLINE receipt debits wallet clearing at gross and credits AR;
 *   2. a provider transaction id cannot be recorded twice;
 *   3. a settlement debits bank net and fee expense, credits clearing gross;
 *   4. partial settlements leave only the remaining gross unsettled and the
 *      clearing balance equals that outstanding gross;
 *   5. importing a provider statement auto-matches its net deposit to the
 *      settlement, and a mismatched manual match is refused;
 *   6. an unsettled wallet receipt can be refunded through AR/clearing, while a
 *      settled receipt can be routed to chargeback expense with an audit reason.
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

const BR = 'wallet-test-branch';
const DAY = '2026-08-20';
const ADMIN = {
  id: 'wallet-test-admin',
  email: 'wallet-test-admin@example.com',
  name: 'Wallet Test Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
const BRANCH_USER = {
  id: 'wallet-test-branch-user',
  email: 'wallet-test-branch-user@example.com',
  name: 'Wallet Test Branch User',
  role: 'ACCOUNTANT',
  branchId: BR,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('wallet receipts, settlements and PSP reconciliation (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const branchToken = issueAuthToken(BRANCH_USER);
  let walletId = '';
  let khaltiId = '';
  let bankId = '';
  let firstPayment = '';
  let secondPayment = '';
  let firstSettlementId = '';
  let firstSettlementNumber = '';
  let walletJournalIds: string[] = [];

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
      /* non-JSON is a finding */
    }
    return { status: res.status, json };
  }
  const get = (path: string, auth = token) => request('GET', path, undefined, auth);
  const post = (path: string, body: unknown, auth = token) => request('POST', path, body, auth);

  async function cleanup() {
    await pool!.query('DELETE FROM bank_statement_lines WHERE bank_account_id = ANY($1::varchar[])', [[walletId, khaltiId].filter(Boolean)]);
    await pool!.query(
      'DELETE FROM payment_settlements WHERE customer_payment_id IN (SELECT id FROM customer_payments WHERE branch_id = $1)',
      [BR]
    );
    await pool!.query('DELETE FROM customer_payments WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM audit_logs WHERE details LIKE $1', ['%wallet-test%']);
    await pool!.query('DELETE FROM branches WHERE id = $1', [BR]);
    walletJournalIds = [];
  }

  before(async () => {
    await ensureReferenceData(pool!, DAY);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'WLT1', 'Wallet Test Branch', 'Kathmandu')`,
      [BR]
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

    const accounts = await get('/api/accounting/accounts');
    assert.equal(accounts.status, 200, JSON.stringify(accounts.json));
    walletId = accounts.json.find((row: any) => row.code === '9030').id;
    khaltiId = accounts.json.find((row: any) => row.code === '9040').id;
    bankId = accounts.json.find((row: any) => row.code === '2320').id;
    assert.ok(walletId && khaltiId && bankId, 'default wallet and bank ledgers must be seeded');
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('an ONLINE receipt posts gross to wallet clearing and refuses a duplicate provider id', async () => {
    const receipt = await post('/api/customer-payments', {
      customerName: 'Wallet Test Customer',
      branchId: BR,
      amount: 1000,
      paymentMethod: 'ONLINE',
      providerCode: 'ESEWA',
      providerTransactionId: 'ESEWA-WALLET-TEST-1',
      feeAmount: 10,
      settlementAccountId: walletId,
      paymentDateAD: DAY,
    });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.json));
    firstPayment = receipt.json.id;
    assert.equal(Number(receipt.json.grossAmount), 1000);
    assert.equal(Number(receipt.json.feeAmount), 10);
    assert.equal(Number(receipt.json.netAmount), 990);

    const stored = await pool!.query(
      'SELECT gross_amount, fee_amount, net_amount, provider_code, provider_transaction_id FROM customer_payments WHERE id = $1',
      [firstPayment]
    );
    assert.equal(Number(stored.rows[0].gross_amount), 1000);
    assert.equal(stored.rows[0].provider_code, 'ESEWA');

    const journal = await pool!.query(
      `SELECT j.id, j.source_type, l.account_id, l.debit, l.credit
       FROM gl_journals j JOIN gl_journal_lines l ON l.journal_id = j.id
       WHERE j.source_type = 'CUSTOMER_PAYMENT' AND j.source_id = $1 ORDER BY l.line_no`,
      [firstPayment]
    );
    assert.equal(journal.rows.length, 2);
    assert.equal(journal.rows[0].account_id, walletId);
    assert.equal(Number(journal.rows[0].debit), 1000);
    assert.equal(journal.rows[1].account_id, 'gla-2110');
    assert.equal(Number(journal.rows[1].credit), 1000);
    walletJournalIds.push(journal.rows[0].id);

    const duplicate = await post('/api/customer-payments', {
      customerName: 'Wallet Test Customer',
      branchId: BR,
      amount: 1000,
      paymentMethod: 'ONLINE',
      providerCode: 'ESEWA',
      providerTransactionId: 'ESEWA-WALLET-TEST-1',
      feeAmount: 10,
      settlementAccountId: walletId,
      paymentDateAD: DAY,
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));

    const wrongWallet = await post('/api/customer-payments', {
      customerName: 'Wallet Test Customer',
      branchId: BR,
      amount: 20,
      paymentMethod: 'ONLINE',
      providerCode: 'ESEWA',
      providerTransactionId: 'ESEWA-WALLET-TEST-WRONG',
      feeAmount: 0,
      settlementAccountId: khaltiId,
      paymentDateAD: DAY,
    });
    assert.equal(wrongWallet.status, 400, JSON.stringify(wrongWallet.json));
    assert.match(wrongWallet.json.message, /belongs to KHALTI/i);
  });

  test('partial settlement posts bank net plus fee and leaves the rest outstanding', async () => {
    const settled = await post('/api/accounting/wallet-settlements', {
      customerPaymentId: firstPayment,
      bankAccountId: bankId,
      settlementDateAD: DAY,
      grossAmount: 400,
      feeAmount: 4,
      providerReference: 'ESEWA-SET-1',
      from: DAY,
      to: DAY,
    });
    assert.equal(settled.status, 201, JSON.stringify(settled.json));
    firstSettlementId = settled.json.settlement.id;
    firstSettlementNumber = settled.json.settlement.settlementNumber;
    assert.equal(Number(settled.json.settlement.grossAmount), 400);
    assert.equal(Number(settled.json.settlement.feeAmount), 4);
    assert.equal(Number(settled.json.settlement.netAmount), 396);
    assert.equal(settled.json.workspace.summary.unsettledGross, 600);
    assert.equal(settled.json.workspace.summary.ledgerClosing, 600);
    assert.equal(settled.json.workspace.summary.reconciled, true);

    const journal = await pool!.query(
      `SELECT l.account_id, l.debit, l.credit
       FROM gl_journals j JOIN gl_journal_lines l ON l.journal_id = j.id
       WHERE j.source_type = 'PAYMENT_SETTLEMENT' AND j.source_id = $1 ORDER BY l.line_no`,
      [firstSettlementId]
    );
    assert.equal(journal.rows.length, 3);
    assert.equal(journal.rows[0].account_id, bankId);
    assert.equal(Number(journal.rows[0].debit), 396);
    assert.equal(Number(journal.rows[1].debit), 4);
    assert.equal(journal.rows[2].account_id, walletId);
    assert.equal(Number(journal.rows[2].credit), 400);

    const second = await post('/api/accounting/wallet-settlements', {
      customerPaymentId: firstPayment,
      bankAccountId: bankId,
      settlementDateAD: DAY,
      grossAmount: 600,
      feeAmount: 6,
      providerReference: 'ESEWA-SET-2',
      from: DAY,
      to: DAY,
    });
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(second.json.workspace.summary.unsettledGross, 0);
    assert.equal(second.json.workspace.summary.ledgerClosing, 0);
    assert.equal(second.json.workspace.summary.reconciled, true);
    assert.equal(second.json.workspace.summary.fees, 10);

    const tooMuch = await post('/api/accounting/wallet-settlements', {
      customerPaymentId: firstPayment,
      bankAccountId: bankId,
      settlementDateAD: DAY,
      grossAmount: 1,
      feeAmount: 0,
      from: DAY,
      to: DAY,
    });
    assert.equal(tooMuch.status, 409, JSON.stringify(tooMuch.json));
    assert.match(tooMuch.json.message, /left to settle/i);
  });

  test('provider statement import auto-matches net deposits and rejects a wrong manual match', async () => {
    const imported = await post('/api/accounting/wallet-reconciliation/import', {
      accountId: walletId,
      content: `date,description,reference,amount\n${DAY},eSewa settlement,ESEWA-SET-1,396\n`,
      format: 'CSV',
      from: DAY,
      to: DAY,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    assert.equal(imported.json.imported, 1);
    assert.equal(imported.json.autoMatched, 1, 'net 396 must match the first settlement');
    const matchedLine = imported.json.workspace.lines.find((line: any) => line.reference === 'ESEWA-SET-1');
    assert.ok(matchedLine);
    assert.equal(matchedLine.matchedSettlementNumber, firstSettlementNumber);

    const mismatch = await post('/api/accounting/wallet-reconciliation/import', {
      accountId: walletId,
      content: `date,description,reference,amount\n${DAY},unmatched provider line,NOPE,1\n`,
      format: 'CSV',
      from: DAY,
      to: DAY,
    });
    assert.equal(mismatch.status, 200, JSON.stringify(mismatch.json));
    assert.equal(mismatch.json.autoMatched, 0);
    const unmatched = mismatch.json.workspace.lines.find((line: any) => line.reference === 'NOPE');
    assert.ok(unmatched);

    const wrongMatch = await post(
      `/api/accounting/wallet-reconciliation/lines/${encodeURIComponent(unmatched.id)}/match`,
      { settlementId: firstSettlementId, accountId: walletId, from: DAY, to: DAY }
    );
    assert.equal(wrongMatch.status, 400, JSON.stringify(wrongMatch.json));
    assert.match(wrongMatch.json.message, /does not equal settlement net/i);

    const duplicateImport = await post('/api/accounting/wallet-reconciliation/import', {
      accountId: walletId,
      content: `date,description,reference,amount\n${DAY},eSewa settlement,ESEWA-SET-1,396\n`,
      format: 'CSV',
      from: DAY,
      to: DAY,
    });
    assert.equal(duplicateImport.status, 200, JSON.stringify(duplicateImport.json));
    assert.equal(duplicateImport.json.duplicates, 1);
  });

  test('refund reverses an unsettled wallet receipt; chargeback routes a settled one to expense', async () => {
    const refundable = await post('/api/customer-payments', {
      customerName: 'Wallet Refund Customer',
      branchId: BR,
      amount: 500,
      paymentMethod: 'ONLINE',
      providerCode: 'ESEWA',
      providerTransactionId: 'ESEWA-WALLET-REFUND',
      feeAmount: 5,
      settlementAccountId: walletId,
      paymentDateAD: DAY,
    });
    assert.equal(refundable.status, 201, JSON.stringify(refundable.json));
    secondPayment = refundable.json.id;

    const refund = await post(`/api/customer-payments/${encodeURIComponent(secondPayment)}/refund`, {
      reason: 'customer returned the router',
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.json));
    assert.equal(refund.json.status, 'REFUNDED');
    const refundJournal = await pool!.query(
      `SELECT j.source_type, l.account_id, l.debit, l.credit
       FROM gl_journals j JOIN gl_journal_lines l ON l.journal_id = j.id
       WHERE j.source_type = 'WALLET_REFUND' AND j.source_id = $1 ORDER BY l.line_no`,
      [secondPayment]
    );
    assert.equal(refundJournal.rows.length, 2);
    assert.equal(refundJournal.rows[0].account_id, 'gla-2110');
    assert.equal(Number(refundJournal.rows[0].debit), 500);
    assert.equal(refundJournal.rows[1].account_id, walletId);
    assert.equal(Number(refundJournal.rows[1].credit), 500);

    const settledRefund = await post(`/api/customer-payments/${encodeURIComponent(firstPayment)}/refund`, {
      reason: 'too late to refund',
    });
    assert.equal(settledRefund.status, 409, JSON.stringify(settledRefund.json));
    assert.match(settledRefund.json.message, /chargeback/i);

    const chargeback = await post(`/api/customer-payments/${encodeURIComponent(firstPayment)}/chargeback`, {
      reason: 'provider reversed the transaction',
    });
    assert.equal(chargeback.status, 200, JSON.stringify(chargeback.json));
    assert.equal(chargeback.json.status, 'CHARGEBACK');
    const chargebackJournal = await pool!.query(
      `SELECT j.source_type, a.code, l.debit, l.credit
       FROM gl_journals j JOIN gl_journal_lines l ON l.journal_id = j.id
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE j.source_type = 'WALLET_CHARGEBACK' AND j.source_id = $1 ORDER BY l.line_no`,
      [firstPayment]
    );
    assert.equal(chargebackJournal.rows.length, 2);
    assert.equal(chargebackJournal.rows[0].code, '7430');
    assert.equal(Number(chargebackJournal.rows[0].debit), 1000);
    assert.equal(chargebackJournal.rows[1].account_id ?? chargebackJournal.rows[1].code, '9030');
  });

  test('branch-scoped users cannot reconcile or settle provider clearing', async () => {
    const read = await get(`/api/accounting/wallet-reconciliation?from=${DAY}&to=${DAY}`, branchToken);
    assert.equal(read.status, 403, JSON.stringify(read.json));

    const settle = await post('/api/accounting/wallet-settlements', {
      customerPaymentId: firstPayment,
      bankAccountId: bankId,
      settlementDateAD: DAY,
      grossAmount: 1,
      feeAmount: 0,
    }, branchToken);
    assert.equal(settle.status, 403, JSON.stringify(settle.json));
  });
});
