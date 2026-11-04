/**
 * Payment documents → ledger → cash book, driven through the real HTTP routes
 * against PostgreSQL.
 *
 * This is the gate for the pass that made cash move through the ledger. Until a
 * receipt or a payment writes a journal, the trial balance and every control
 * account are blind where money actually changes hands. The claims pinned here
 * are transactional and tied to the statements, so repository-level tests
 * cannot see a half-written payment or a cash book that disagrees with the
 * balance sheet:
 *
 *   1. a cash customer receipt debits the till / credits AR, settles the
 *      customer's subledger and marks the invoice paid;
 *   2. a bank vendor payment debits AP / credits the bank, settles the
 *      supplier's subledger and updates the bill;
 *   3. the cash/bank book's opening, receipts, payments and closing come from
 *      those same posted lines, and its closing total equals the balance
 *      sheet's cash+bank figure for the branch and date;
 *   4. reversing each payment posts a linked contra journal (never deleting the
 *      original), restores the invoice balances and returns the book and the
 *      control accounts to their pre-payment positions;
 *   5. a posting failure after the payment row is written rolls the row, the
 *      journal and the audit entry back together;
 *   6. a missing settlement default is named, and the read route keeps the
 *      usual gl-view gate, branch scope and date validation.
 *
 * The dedicated PCB branch keeps the branch-scoped figures isolated from the
 * invoice and statement suites that post on the same day. The opening journal
 * (2026-09-01) deliberately sits before the cash-book window so the opening
 * figure is exercised, not assumed to be zero.
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
  postCustomerReceiptLedger,
  postVendorPaymentLedger,
} from '../server/src/services/paymentPosting.service';

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

const BR = 'pcb-branch';
const OTHER = 'WH001';
const PRODUCT = 'pcb-prod';
const CUSTOMER = 'pcb-customer';
const today = new Date().toISOString().split('T')[0];
const OPENING_DATE = '2026-09-01';
/** The cash-book window starts after the opening journal and before the payments. */
const FROM = '2026-10-01';

const USERS = {
  super: { id: 'pcb-super', email: 'pcb-super@example.com', name: 'PCB Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  accountant: { id: 'pcb-accountant', email: 'pcb-accountant@example.com', name: 'PCB Accountant', role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  auditor: { id: 'pcb-auditor', email: 'pcb-auditor@example.com', name: 'PCB Auditor', role: 'AUDITOR', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  noView: { id: 'pcb-frontdesk', email: 'pcb-frontdesk@example.com', name: 'PCB Front Desk', role: 'FRONT_DESK', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  empty: { id: 'pcb-empty', email: 'pcb-empty@example.com', name: 'PCB Empty', role: 'ACCOUNTANT', branchId: '', allowedBranchIds: [], canSwitchUser: false },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

interface AccountFixture {
  cash: string;
  bank: string;
  ar: string;
  ap: string;
  revenue: string;
}

describe('payment documents and the cash/bank book (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const accounts = {} as AccountFixture;
  let receiptId = '';
  let paymentId = '';

  async function request(method: 'GET' | 'POST', path: string, token?: string, body?: unknown) {
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

  const get = (path: string, token: string = tokens.super) => request('GET', path, token);
  const post = (path: string, body: unknown, token: string = tokens.super) => request('POST', path, token, body);

  async function cleanup() {
    // Journals first: their branch FK is RESTRICT. Every PCB journal belongs to
    // this suite, so the branch is a safe cleanup key.
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM customer_payments WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM vendor_payments WHERE branch_id = $1', [BR]);
    await pool!.query("DELETE FROM gl_accounts WHERE code LIKE 'PCB-%'");
    await pool!.query('DELETE FROM sales_invoices WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM purchase_invoices WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM inventory_stock WHERE branch_id = $1', [BR]);
    await pool!.query("DELETE FROM transaction_logs WHERE product_id LIKE 'pcb-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'pcb-%'");
    await pool!.query("DELETE FROM customer_records WHERE id LIKE 'pcb-%'");
    await pool!.query('DELETE FROM audit_logs WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM branches WHERE id = $1', [BR]);
  }

  async function journalFor(sourceType: string, sourceId: string) {
    const { rows } = await pool!.query(
      `SELECT id, journal_no AS "journalNo", status, branch_id AS "branchId",
              source_type AS "sourceType", source_id AS "sourceId",
              reversal_of_id AS "reversalOfId"
         FROM gl_journals
        WHERE source_type = $1 AND source_id = $2
        ORDER BY posted_at ASC, journal_no ASC`,
      [sourceType, sourceId]
    );
    return rows;
  }

  async function journalLines(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT a.code, l.debit::numeric AS debit, l.credit::numeric AS credit
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
        WHERE l.journal_id = $1
        ORDER BY l.line_no ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function subledgerRows(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT subledger_type AS "subledgerType", party_id AS "partyId", party_name AS "partyName",
              debit::numeric AS debit, credit::numeric AS credit
         FROM gl_subledger_entries
        WHERE journal_id = $1
        ORDER BY created_at ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function reconcile(accountId: string) {
    const res = await get(`/api/accounting/reconciliations?accountId=${encodeURIComponent(accountId)}&branchId=${BR}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  }

  function invoiceLine(overrides: Record<string, any> = {}) {
    return {
      productId: PRODUCT,
      productName: 'PCB Router',
      sku: 'PCB-SKU',
      unit: 'Pcs',
      quantity: 1,
      unitPrice: 100,
      discount: 0,
      taxRate: 13,
      isTaxExempt: false,
      ...overrides,
    };
  }

  before(async () => {
    await ensureReferenceData(pool!, today);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'PCBB', 'PCB Payments Branch', 'Test')`,
      [BR]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ($1, $1, 'PCB Customer', '9800000000', $2, 'ACTIVE')`,
      [CUSTOMER, BR]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, 'PCB Router', 'PCB-SKU', 'Equipment', 'Product Item', 'Pcs', 90, 150, FALSE, 'QUANTITY_ONLY')`,
      [PRODUCT]
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
    accounts.cash = defaults.json.defaults.CASH.accountId;
    accounts.bank = defaults.json.defaults.BANK.accountId;
    accounts.ar = defaults.json.defaults.AR_CONTROL.accountId;
    accounts.ap = defaults.json.defaults.AP_CONTROL.accountId;
    accounts.revenue = defaults.json.defaults.SALES.accountId;
    assert.ok(accounts.cash && accounts.bank && accounts.ar && accounts.ap && accounts.revenue);

    // A cash balance before the book window, so the opening figure is real.
    const opening = await post('/api/accounting/journals', {
      journalDateAD: OPENING_DATE,
      branchId: BR,
      sourceId: 'pcb-open',
      memo: 'PCB opening cash',
      lines: [
        { accountId: accounts.cash, debit: 100, credit: 0 },
        { accountId: accounts.revenue, debit: 0, credit: 100 },
      ],
    });
    assert.equal(opening.status, 201, JSON.stringify(opening.json));

    // A supplier bill funds AP and inventory: 10 × 100 + 13% VAT = 1130.
    const purchase = await post('/api/purchase-invoices', {
      id: 'pcb-pi-1',
      invoiceNumber: 'PCB-PI-1',
      branchId: BR,
      invoiceDateAD: today,
      supplierName: 'PCB Supplier',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      items: [invoiceLine({ quantity: 10, unitPrice: 100 })],
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.json));
    assert.equal(purchase.json.grandTotal, 1130);

    // A customer sale funds AR and stock relief: 2 × 150 + 13% VAT = 339.
    const sale = await post('/api/sales-invoices', {
      id: 'pcb-si-1',
      invoiceNumber: 'PCB-SI-1',
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [invoiceLine({ quantity: 2, unitPrice: 150 })],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.json));
    assert.equal(sale.json.grandTotal, 339);
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('a cash customer receipt posts till/AR and settles the invoice', async () => {
    const receipt = await post('/api/customer-payments', {
      invoiceId: 'pcb-si-1',
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 339,
      paymentMethod: 'CASH',
      notes: 'PCB receipt',
    });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.json));
    assert.equal(receipt.json.status, 'POSTED');
    receiptId = String(receipt.json.id);
    assert.ok(receiptId);

    const [journal] = await journalFor('CUSTOMER_PAYMENT', receiptId);
    assert.ok(journal, 'the receipt must write a journal in its own transaction');
    assert.equal(journal.status, 'POSTED');
    assert.equal(journal.branchId, BR);

    const lines = await journalLines(journal.id);
    assert.equal(lines.find((line) => line.code === '1010')?.debit, 339, 'cash is debited');
    assert.equal(lines.find((line) => line.code === '1100')?.credit, 339, 'AR control is credited');

    const subledger = await subledgerRows(journal.id);
    assert.equal(subledger.length, 1);
    assert.equal(subledger[0].subledgerType, 'CUSTOMER');
    assert.equal(subledger[0].partyId, CUSTOMER);
    assert.equal(subledger[0].credit, 339);

    const invoice = await pool!.query(
      'SELECT amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus" FROM sales_invoices WHERE id = $1',
      ['pcb-si-1']
    );
    assert.equal(Number(invoice.rows[0].amountPaid), 339);
    assert.equal(invoice.rows[0].paymentStatus, 'PAID');

    const ar = await reconcile(accounts.ar);
    assert.equal(ar.glBalance, 0);
    assert.equal(ar.subledgerBalance, 0);
    assert.equal(ar.status, 'RECONCILED');

    const audit = await pool!.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'RECORD_CUSTOMER_PAYMENT' AND branch_id = $1",
      [BR]
    );
    assert.equal(Number(audit.rows[0].n), 1, 'the receipt audit row commits with the payment');
  });

  test('a bank vendor payment posts AP/bank and applies to the bill', async () => {
    const payment = await post('/api/vendor-payments', {
      invoiceId: 'pcb-pi-1',
      branchId: BR,
      supplierName: 'PCB Supplier',
      paymentDateAD: today,
      amount: 217,
      paymentMethod: 'BANK_TRANSFER',
      bankName: 'PCB Bank',
      transactionReference: 'PCB-TXN-1',
      notes: 'PCB payment',
    });
    assert.equal(payment.status, 201, JSON.stringify(payment.json));
    assert.equal(payment.json.status, 'POSTED');
    paymentId = String(payment.json.id);
    assert.ok(paymentId);

    const [journal] = await journalFor('VENDOR_PAYMENT', paymentId);
    assert.ok(journal, 'the payment must write a journal in its own transaction');
    assert.equal(journal.status, 'POSTED');
    assert.equal(journal.branchId, BR);

    const lines = await journalLines(journal.id);
    assert.equal(lines.find((line) => line.code === '2100')?.debit, 217, 'AP control is debited');
    assert.equal(lines.find((line) => line.code === '1020')?.credit, 217, 'the bank is credited');

    const subledger = await subledgerRows(journal.id);
    assert.equal(subledger.length, 1);
    assert.equal(subledger[0].subledgerType, 'SUPPLIER');
    assert.equal(subledger[0].partyName, 'PCB Supplier');
    assert.equal(subledger[0].debit, 217);

    const invoice = await pool!.query(
      'SELECT amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus" FROM purchase_invoices WHERE id = $1',
      ['pcb-pi-1']
    );
    assert.equal(Number(invoice.rows[0].amountPaid), 217);
    assert.equal(invoice.rows[0].paymentStatus, 'PARTIAL');

    const ap = await reconcile(accounts.ap);
    assert.equal(ap.glBalance, -913, '1130 credited by the bill less 217 paid');
    assert.equal(ap.subledgerBalance, -913);
    assert.equal(ap.status, 'RECONCILED');

    const audit = await pool!.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'RECORD_VENDOR_PAYMENT' AND branch_id = $1",
      [BR]
    );
    assert.equal(Number(audit.rows[0].n), 1, 'the payment audit row commits with the payment');
  });

  test('the cash book ties to the trial balance and the balance sheet cash total', async () => {
    const book = await get(`/api/accounting/cash-book?from=${FROM}&to=${today}&branchId=${BR}`);
    assert.equal(book.status, 200, JSON.stringify(book.json));
    assert.equal(book.json.book, 'CASH_BANK');
    assert.equal(book.json.branchId, BR);
    assert.equal(book.json.from, FROM);
    assert.equal(book.json.to, today);

    assert.equal(book.json.opening, 100, 'the opening journal sits before the window');
    assert.equal(book.json.receipts, 339);
    assert.equal(book.json.payments, 217);
    assert.equal(book.json.closing, 222);

    const cash = book.json.accounts.find((account: any) => account.code === '1010');
    const bank = book.json.accounts.find((account: any) => account.code === '1020');
    assert.equal(cash.opening, 100);
    assert.equal(cash.receipts, 339);
    assert.equal(cash.payments, 0);
    assert.equal(cash.closing, 439);
    assert.equal(cash.entries.length, 1);
    assert.equal(cash.entries[0].type, 'RECEIPT');
    assert.equal(cash.entries[0].balance, 439, 'the entry balance includes the opening figure');
    assert.equal(bank.opening, 0);
    assert.equal(bank.receipts, 0);
    assert.equal(bank.payments, 217);
    assert.equal(bank.closing, -217);
    assert.equal(bank.entries.length, 1);
    assert.equal(bank.entries[0].type, 'PAYMENT');
    assert.equal(bank.entries[0].balance, -217);

    const sheet = await get(`/api/accounting/statements/balance-sheet?asOf=${today}&branchId=${BR}`);
    assert.equal(sheet.status, 200, JSON.stringify(sheet.json));
    assert.equal(sheet.json.cashAndBank, book.json.closing, 'the book and the sheet must agree');
    assert.equal(sheet.json.cashAndBank, 222);
    assert.equal(sheet.json.balanced, true);

    const trial = await get(
      `/api/accounting/statements/trial-balance?from=${FROM}&to=${today}&branchId=${BR}`
    );
    assert.equal(trial.status, 200, JSON.stringify(trial.json));
    assert.equal(trial.json.balanced, true);
    assert.equal(trial.json.controlsReconciled, true);

    const cashRow = trial.json.accounts.find((account: any) => account.code === '1010');
    assert.equal(cashRow.openingDebit, 100);
    assert.equal(cashRow.periodDebit, 339);
    assert.equal(cashRow.closingDebit, 439);
    const bankRow = trial.json.accounts.find((account: any) => account.code === '1020');
    assert.equal(bankRow.periodCredit, 217);
    assert.equal(bankRow.closingCredit, 217);
    assert.equal(trial.json.accounts.find((account: any) => account.code === '1100').closingBalance, 0);
    assert.equal(trial.json.accounts.find((account: any) => account.code === '2100').closingCredit, 913);

    const defaulted = await get(`/api/accounting/cash-book?asOf=${today}&branchId=${BR}`);
    assert.equal(defaulted.status, 200, JSON.stringify(defaulted.json));
    assert.equal(defaulted.json.from, '2026-07-17', 'an as-of call opens at the fiscal-year boundary');
    assert.equal(defaulted.json.opening, 0);
    assert.equal(defaulted.json.receipts, 439, 'the opening journal falls inside the default window');
    assert.equal(defaulted.json.payments, 217);
    assert.equal(defaulted.json.closing, 222);
  });

  test('reversing each payment posts a contra journal and restores the book', async () => {
    const receiptReverse = await post(`/api/customer-payments/${encodeURIComponent(receiptId)}/reverse`, {
      reason: 'PCB receipt reversal',
    });
    assert.equal(receiptReverse.status, 200, JSON.stringify(receiptReverse.json));
    assert.equal(receiptReverse.json.status, 'REVERSED');

    const paymentReverse = await post(`/api/vendor-payments/${encodeURIComponent(paymentId)}/reverse`, {
      reason: 'PCB payment reversal',
    });
    assert.equal(paymentReverse.status, 200, JSON.stringify(paymentReverse.json));

    const [originalReceipt] = await journalFor('CUSTOMER_PAYMENT', receiptId);
    const [receiptContra] = await journalFor('CUSTOMER_PAYMENT_REVERSAL', receiptId);
    assert.equal(originalReceipt.status, 'POSTED', 'the original receipt rows stay for the audit trail');
    assert.ok(receiptContra, 'the receipt reversal must post a contra journal');
    assert.equal(receiptContra.reversalOfId, originalReceipt.id);
    const receiptLines = await journalLines(receiptContra.id);
    assert.equal(receiptLines.find((line) => line.code === '1010')?.credit, 339);
    assert.equal(receiptLines.find((line) => line.code === '1100')?.debit, 339);
    const receiptSubledger = await subledgerRows(receiptContra.id);
    assert.equal(receiptSubledger[0].subledgerType, 'CUSTOMER');
    assert.equal(receiptSubledger[0].partyId, CUSTOMER);
    assert.equal(receiptSubledger[0].debit, 339);

    const [originalPayment] = await journalFor('VENDOR_PAYMENT', paymentId);
    const [paymentContra] = await journalFor('VENDOR_PAYMENT_REVERSAL', paymentId);
    assert.equal(originalPayment.status, 'POSTED');
    assert.ok(paymentContra, 'the vendor reversal must post a contra journal');
    assert.equal(paymentContra.reversalOfId, originalPayment.id);
    const paymentLines = await journalLines(paymentContra.id);
    assert.equal(paymentLines.find((line) => line.code === '2100')?.credit, 217);
    assert.equal(paymentLines.find((line) => line.code === '1020')?.debit, 217);
    const paymentSubledger = await subledgerRows(paymentContra.id);
    assert.equal(paymentSubledger[0].subledgerType, 'SUPPLIER');
    assert.equal(paymentSubledger[0].credit, 217);

    const invoices = await pool!.query(
      `SELECT id, amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus"
         FROM sales_invoices WHERE id = 'pcb-si-1'
        UNION ALL
       SELECT id, amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus"
         FROM purchase_invoices WHERE id = 'pcb-pi-1'`
    );
    for (const invoice of invoices.rows) {
      assert.equal(Number(invoice.amountPaid), 0, `${invoice.id} must return to unpaid`);
      assert.equal(invoice.paymentStatus, 'UNPAID');
    }

    // Reversing the receipt un-settles the invoice: AR returns to the 339 the
    // sale created, while the receipt's cash/AR contra nets the receipt itself.
    const ar = await reconcile(accounts.ar);
    assert.equal(ar.glBalance, 339);
    assert.equal(ar.subledgerBalance, 339);
    assert.equal(ar.status, 'RECONCILED');
    const ap = await reconcile(accounts.ap);
    assert.equal(ap.glBalance, -1130);
    assert.equal(ap.subledgerBalance, -1130);
    assert.equal(ap.status, 'RECONCILED');

    const book = await get(`/api/accounting/cash-book?from=${FROM}&to=${today}&branchId=${BR}`);
    assert.equal(book.status, 200, JSON.stringify(book.json));
    assert.equal(book.json.opening, 100);
    assert.equal(book.json.receipts, 556, 'the receipt and the bank-side contra are both receipts');
    assert.equal(book.json.payments, 556);
    assert.equal(book.json.closing, 100, 'only the opening cash remains');
    assert.equal(book.json.accounts.find((account: any) => account.code === '1010').closing, 100);
    assert.equal(book.json.accounts.find((account: any) => account.code === '1020').closing, 0);

    const sheet = await get(`/api/accounting/statements/balance-sheet?asOf=${today}&branchId=${BR}`);
    assert.equal(sheet.status, 200, JSON.stringify(sheet.json));
    assert.equal(sheet.json.cashAndBank, 100);
    assert.equal(sheet.json.balanced, true);

    const audits = await pool!.query(
      `SELECT action, count(*)::int AS n
         FROM audit_logs
        WHERE branch_id = $1 AND action IN ('REVERSE_CUSTOMER_PAYMENT', 'REVERSE_VENDOR_PAYMENT')
        GROUP BY action`,
      [BR]
    );
    assert.equal(audits.rows.length, 2);
    assert.ok(audits.rows.every((row) => Number(row.n) === 1));
  });

  test('a posting failure rolls the receipt, journal and audit back together', async () => {
    const journalsBefore = await pool!.query('SELECT count(*)::int AS n FROM gl_journals WHERE branch_id = $1', [BR]);
    const auditsBefore = await pool!.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE branch_id = $1 AND action = 'RECORD_CUSTOMER_PAYMENT'",
      [BR]
    );

    const refused = await post('/api/customer-payments', {
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 100_000_000_000,
      paymentMethod: 'CASH',
      notes: 'PCB rollback receipt',
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.match(String(refused.json?.message), /ledger limit/i);

    const payment = await pool!.query(
      "SELECT count(*)::int AS n FROM customer_payments WHERE notes = 'PCB rollback receipt'"
    );
    assert.equal(Number(payment.rows[0].n), 0, 'no half-written receipt may survive');
    const journalsAfter = await pool!.query('SELECT count(*)::int AS n FROM gl_journals WHERE branch_id = $1', [BR]);
    assert.equal(Number(journalsAfter.rows[0].n), Number(journalsBefore.rows[0].n), 'no journal may survive');
    const auditsAfter = await pool!.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE branch_id = $1 AND action = 'RECORD_CUSTOMER_PAYMENT'",
      [BR]
    );
    assert.equal(
      Number(auditsAfter.rows[0].n),
      Number(auditsBefore.rows[0].n),
      'no audit row may claim the refused receipt was recorded'
    );
  });

  test('a payment can settle through a non-default cash ledger', async () => {
    const chart = await get('/api/accounting/accounts');
    assert.equal(chart.status, 200, JSON.stringify(chart.json));
    const defaultCash = chart.json.find((account: any) => account.code === '1010');
    assert.ok(defaultCash, 'the seeded cash ledger is required');

    const extra = await post('/api/accounting/accounts', {
      code: 'PCB-1021',
      name: 'PCB Petty Cash',
      groupId: defaultCash.groupId,
      accountKind: 'CASH',
    });
    assert.equal(extra.status, 201, JSON.stringify(extra.json));
    assert.equal(extra.json.accountKind, 'CASH');
    assert.equal(extra.json.postingRole, null, 'the extra till is not the CASH default');

    const receipt = await post('/api/customer-payments', {
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 25,
      paymentMethod: 'CASH',
      settlementAccountId: extra.json.id,
      notes: 'PCB extra till receipt',
    });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.json));
    assert.equal(receipt.json.settlementAccountId, extra.json.id);

    const [journal] = await journalFor('CUSTOMER_PAYMENT', String(receipt.json.id));
    assert.ok(journal, 'the selected till must still post a journal');
    const lines = await journalLines(journal.id);
    assert.equal(lines.find((line) => line.code === 'PCB-1021')?.debit, 25, 'the chosen till is debited');
    assert.equal(lines.find((line) => line.code === '1010')?.debit, undefined, 'the default till is untouched');
    assert.equal(lines.find((line) => line.code === '1100')?.credit, 25, 'AR control is still credited');

    const stored = await pool!.query(
      'SELECT settlement_account_id AS "settlementAccountId" FROM customer_payments WHERE id = $1',
      [receipt.json.id]
    );
    assert.equal(stored.rows[0].settlementAccountId, extra.json.id, 'the payment row records the chosen till');

    const book = await get(`/api/accounting/cash-book?from=${FROM}&to=${today}&branchId=${BR}`);
    assert.equal(book.status, 200, JSON.stringify(book.json));
    const extraBook = book.json.accounts.find((account: any) => account.code === 'PCB-1021');
    assert.ok(extraBook, 'the extra cash ledger must appear in the cash book');
    assert.equal(extraBook.opening, 0);
    assert.equal(extraBook.receipts, 25);
    assert.equal(extraBook.closing, 25);
    assert.equal(book.json.accounts.find((account: any) => account.code === '1010').closing, 100);
    assert.equal(book.json.closing, 125, 'the book total includes the extra till');

    const wrongKind = await post('/api/customer-payments', {
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 1,
      paymentMethod: 'BANK_TRANSFER',
      settlementAccountId: extra.json.id,
      notes: 'PCB wrong-kind receipt',
    });
    assert.equal(wrongKind.status, 400, JSON.stringify(wrongKind.json));
    assert.match(String(wrongKind.json?.message), /must settle through a BANK ledger/i);
    const refused = await pool!.query(
      "SELECT count(*)::int AS n FROM customer_payments WHERE notes = 'PCB wrong-kind receipt'"
    );
    assert.equal(Number(refused.rows[0].n), 0, 'a wrong-kind settlement must roll the receipt back');
  });

  test('missing settlement defaults are named, and the read route keeps its scope', async () => {
    const emptyChart = { query: async () => ({ rows: [] }) };
    await assert.rejects(
      postCustomerReceiptLedger(emptyChart as any, {
        receipt: {
          id: 'pcb-nocfg',
          paymentNumber: 'CR-NOCFG',
          branchId: BR,
          paymentDateAD: today,
          amount: 10,
          paymentMethod: 'CASH',
          customerName: 'PCB Customer',
        },
      }),
      /no active account has the AR_CONTROL, CASH posting default/
    );
    await assert.rejects(
      postVendorPaymentLedger(emptyChart as any, {
        payment: {
          id: 'pcb-nocfg-v',
          paymentNumber: 'BP-NOCFG',
          branchId: BR,
          paymentDateAD: today,
          amount: 10,
          paymentMethod: 'CHEQUE',
          supplierName: 'PCB Supplier',
        },
      }),
      /no active account has the AP_CONTROL, BANK posting default/
    );

    const own = await get(`/api/accounting/cash-book?asOf=${today}`, tokens.accountant);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.branchId, BR, 'a branch account defaults to its own branch');
    assert.equal(own.json.closing, 125, 'the extra till receipt remains in the book');

    assert.equal(
      (await get(`/api/accounting/cash-book?asOf=${today}&branchId=${OTHER}`, tokens.accountant)).status,
      403
    );
    assert.equal(
      (await get(`/api/accounting/cash-book?asOf=${today}&branchId=ALL`, tokens.accountant)).status,
      403
    );

    const empty = await get(`/api/accounting/cash-book?asOf=${today}`, tokens.empty);
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.equal(empty.json.branchId, null);
    assert.deepEqual(
      {
        accounts: empty.json.accounts,
        opening: empty.json.opening,
        receipts: empty.json.receipts,
        payments: empty.json.payments,
        closing: empty.json.closing,
      },
      { accounts: [], opening: 0, receipts: 0, payments: 0, closing: 0 }
    );

    assert.equal((await get(`/api/accounting/cash-book?asOf=${today}`, tokens.auditor)).status, 200);
    assert.equal((await get(`/api/accounting/cash-book?asOf=${today}`, tokens.noView)).status, 403);
    assert.equal((await request('GET', `/api/accounting/cash-book?asOf=${today}`)).status, 401);

    assert.equal(
      (await get('/api/accounting/cash-book?asOf=2026-02-30', tokens.super)).status,
      400,
      'an impossible calendar date is refused'
    );
    assert.equal(
      (await get(`/api/accounting/cash-book?asOf=${today}&to=2026-10-01`, tokens.super)).status,
      400,
      'asOf and to may not disagree'
    );
    assert.equal(
      (await get(`/api/accounting/cash-book?from=${today}&to=2026-10-01`, tokens.super)).status,
      400,
      'a reversed range is refused'
    );
  });
});
