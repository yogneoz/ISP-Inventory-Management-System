import { purgeAuditLogs } from './support/purgeAuditLogs';
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
import { businessDateAD } from '../shared/businessDate';
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
const today = businessDateAD();
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
    await pool!.query('DELETE FROM document_number_retirements WHERE branch_id = $1', [BR]);
    await pool!.query("DELETE FROM transaction_logs WHERE product_id LIKE 'pcb-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'pcb-%'");
    await pool!.query("DELETE FROM customer_records WHERE id LIKE 'pcb-%'");
    await purgeAuditLogs(pool!, 'DELETE FROM audit_logs WHERE branch_id = $1', [BR]);
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
      invoiceNumber: 'PI-2083-PCB-PI-1',
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
      invoiceNumber: 'INV-2083-PCB-SI-1',
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

  test('a customer receipt cannot exceed the invoice open balance', async () => {
    const receipt = await post('/api/customer-payments', {
      invoiceId: 'pcb-si-1',
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 340,
      paymentMethod: 'CASH',
      notes: 'PCB overpayment attempt',
    });
    assert.equal(receipt.status, 400, JSON.stringify(receipt.json));
    assert.match(String(receipt.json.message), /exceeds the 339\.00 still open/);
    // REC-1: the refusal names the excess and the lane that can carry it.
    assert.match(String(receipt.json.message), /by 1\.00/);
    assert.match(String(receipt.json.message), /unapplied advance/);

    const invoice = await pool!.query(
      'SELECT amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus" FROM sales_invoices WHERE id = $1',
      ['pcb-si-1']
    );
    assert.equal(Number(invoice.rows[0].amountPaid), 0, 'the refused receipt must not change the invoice');
    assert.equal(invoice.rows[0].paymentStatus, 'UNPAID');

    const payments = await pool!.query(
      'SELECT count(*)::int AS n FROM customer_payments WHERE invoice_id = $1',
      ['pcb-si-1']
    );
    assert.equal(Number(payments.rows[0].n), 0, 'the refused receipt must not leave a payment row');
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
      paymentNumber: 'CR-CLIENT-OVERRIDE',
      notes: 'PCB receipt',
    });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.json));
    assert.equal(receipt.json.status, 'POSTED');
    assert.match(String(receipt.json.paymentNumber), /^CR-[A-Za-z0-9_-]+-\d{8}\d{4}$/);
    assert.notEqual(receipt.json.paymentNumber, 'CR-CLIENT-OVERRIDE');
    receiptId = String(receipt.json.id);
    assert.ok(receiptId);

    const [journal] = await journalFor('CUSTOMER_PAYMENT', receiptId);
    assert.ok(journal, 'the receipt must write a journal in its own transaction');
    assert.equal(journal.status, 'POSTED');
    assert.equal(journal.branchId, BR);

    const lines = await journalLines(journal.id);
    assert.equal(lines.find((line) => line.code === '2310')?.debit, 339, 'cash is debited');
    assert.equal(lines.find((line) => line.code === '2110')?.credit, 339, 'AR control is credited');

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
    assert.equal(lines.find((line) => line.code === '5010')?.debit, 217, 'AP control is debited');
    assert.equal(lines.find((line) => line.code === '2320')?.credit, 217, 'the bank is credited');

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

    const cash = book.json.accounts.find((account: any) => account.code === '2310');
    const bank = book.json.accounts.find((account: any) => account.code === '2320');
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

    const cashRow = trial.json.accounts.find((account: any) => account.code === '2310');
    assert.equal(cashRow.openingDebit, 100);
    assert.equal(cashRow.periodDebit, 339);
    assert.equal(cashRow.closingDebit, 439);
    const bankRow = trial.json.accounts.find((account: any) => account.code === '2320');
    assert.equal(bankRow.periodCredit, 217);
    assert.equal(bankRow.closingCredit, 217);
    assert.equal(trial.json.accounts.find((account: any) => account.code === '2110').closingBalance, 0);
    assert.equal(trial.json.accounts.find((account: any) => account.code === '5010').closingCredit, 913);

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
    assert.equal(receiptLines.find((line) => line.code === '2310')?.credit, 339);
    assert.equal(receiptLines.find((line) => line.code === '2110')?.debit, 339);
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
    assert.equal(paymentLines.find((line) => line.code === '5010')?.credit, 217);
    assert.equal(paymentLines.find((line) => line.code === '2320')?.debit, 217);
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
    assert.equal(book.json.accounts.find((account: any) => account.code === '2310').closing, 100);
    assert.equal(book.json.accounts.find((account: any) => account.code === '2320').closing, 0);

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

  test('the customer statement reads posted opening, manual and unapplied rows and ties to AR', async () => {
    // Opening balance and a manual adjustment live only in the subledger; the
    // old statement rebuilt from invoices/payments and could not show either.
    const opening = await post('/api/accounting/journals', {
      journalDateAD: '2026-10-02',
      branchId: BR,
      sourceType: 'OPENING_BALANCE',
      sourceId: 'pcb-open-ar',
      memo: 'PCB customer opening receivable',
      lines: [
        { accountId: accounts.ar, debit: 50, credit: 0, subledgerType: 'CUSTOMER', partyId: CUSTOMER, partyName: 'PCB Customer' },
        { accountId: accounts.revenue, debit: 0, credit: 50 },
      ],
    });
    assert.equal(opening.status, 201, JSON.stringify(opening.json));

    const adjustment = await post('/api/accounting/journals', {
      journalDateAD: today,
      branchId: BR,
      sourceType: 'MANUAL',
      sourceId: 'pcb-adj-ar',
      memo: 'PCB customer manual adjustment',
      lines: [
        { accountId: accounts.ar, debit: 25, credit: 0, subledgerType: 'CUSTOMER', partyId: CUSTOMER, partyName: 'PCB Customer' },
        { accountId: accounts.revenue, debit: 0, credit: 25 },
      ],
    });
    assert.equal(adjustment.status, 201, JSON.stringify(adjustment.json));

    // An unapplied receipt is a customer advance: credit AR with no invoice.
    const advance = await post('/api/customer-payments', {
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 30,
      paymentMethod: 'CASH',
      notes: 'PCB unapplied advance',
    });
    assert.equal(advance.status, 201, JSON.stringify(advance.json));

    const statement = await get(
      `/api/customers/${encodeURIComponent(CUSTOMER)}/ledger?from=2026-10-01&to=${today}&branchId=${BR}`
    );
    assert.equal(statement.status, 200, JSON.stringify(statement.json));
    assert.equal(statement.json.openingBalance, 0);
    assert.equal(statement.json.totalDebit, 339 + 339 + 50 + 25, 'invoice, reversal, opening and manual');
    assert.equal(statement.json.totalCredit, 339 + 30, 'receipt plus unapplied advance');
    assert.equal(statement.json.closingBalance, 384);
    assert.deepEqual(
      statement.json.ledger.map((line: any) => line.type).sort(),
      ['ADJUSTMENT', 'INVOICE', 'OPENING', 'PAYMENT', 'PAYMENT', 'PAYMENT']
    );
    assert.equal(statement.json.tieOut.partyBalance, 384);
    assert.equal(statement.json.tieOut.controlBalance, 384);
    assert.equal(statement.json.tieOut.subledgerBalance, 384);
    assert.equal(statement.json.tieOut.difference, 0);
    assert.equal(statement.json.tieOut.status, 'RECONCILED');
  });

  test('posted journals, lines and subledger rows reject direct changes', async () => {
    const journal = await post('/api/accounting/journals', {
      journalDateAD: today,
      branchId: BR,
      sourceType: 'MANUAL',
      sourceId: 'pcb-immutable',
      memo: 'PCB immutable probe',
      lines: [
        { accountId: accounts.ar, debit: 1, credit: 0, subledgerType: 'CUSTOMER', partyId: CUSTOMER, partyName: 'PCB Customer' },
        { accountId: accounts.revenue, debit: 0, credit: 1 },
      ],
    });
    assert.equal(journal.status, 201, JSON.stringify(journal.json));
    const journalId = String(journal.json.id);

    // The suite's own pool carries the test-runner cleanup bypass. This client
    // deliberately drops it, so it behaves like an application connection.
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.delete('options');
    const raw = new pg.Client({ connectionString: url.toString() });
    await raw.connect();
    try {
      await assert.rejects(
        raw.query("UPDATE gl_journals SET memo = 'changed' WHERE id = $1", [journalId]),
        /append-only.*UPDATE/i
      );
      await assert.rejects(
        raw.query('UPDATE gl_journal_lines SET memo = $2 WHERE journal_id = $1', [journalId, 'changed']),
        /append-only.*UPDATE/i
      );
      await assert.rejects(
        raw.query('UPDATE gl_subledger_entries SET debit = debit WHERE journal_id = $1', [journalId]),
        /append-only.*UPDATE/i
      );
      await assert.rejects(
        raw.query('DELETE FROM gl_journal_lines WHERE journal_id = $1', [journalId]),
        /append-only.*DELETE/i
      );
      await assert.rejects(
        raw.query('DELETE FROM gl_subledger_entries WHERE journal_id = $1', [journalId]),
        /append-only.*DELETE/i
      );
      await assert.rejects(
        raw.query('DELETE FROM gl_journals WHERE id = $1', [journalId]),
        /append-only.*DELETE/i
      );

      // The documented cleanup path is explicit and session-local.
      await raw.query("SELECT set_config('inventory.allow_ledger_purge', 'on', false)");
      const removed = await raw.query('DELETE FROM gl_journals WHERE id = $1', [journalId]);
      assert.equal(removed.rowCount, 1);
      const lines = await raw.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE journal_id = $1', [journalId]);
      assert.equal(Number(lines.rows[0].n), 0, 'the journal delete cascades its lines under the maintenance bypass');
    } finally {
      await raw.end();
    }
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
    const defaultCash = chart.json.find((account: any) => account.code === '2310');
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
    assert.equal(lines.find((line) => line.code === '2310')?.debit, undefined, 'the default till is untouched');
    assert.equal(lines.find((line) => line.code === '2110')?.credit, 25, 'AR control is still credited');

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
    assert.equal(book.json.accounts.find((account: any) => account.code === '2310').closing, 130, 'the unapplied advance remains in the till');
    assert.equal(book.json.closing, 155, 'the book total includes the extra till');

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
    assert.equal(own.json.closing, 155, 'the extra till receipt and unapplied advance remain in the book');

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

  test('one receipt allocates across invoices, leaves excess unapplied, and reverses every allocation', async () => {
    const first = await post('/api/sales-invoices', {
      id: 'pcb-si-alloc-a',
      invoiceNumber: 'INV-2083-PCB-SI-ALLOC-A',
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [invoiceLine({ quantity: 1, unitPrice: 100 })],
    });
    const second = await post('/api/sales-invoices', {
      id: 'pcb-si-alloc-b',
      invoiceNumber: 'INV-2083-PCB-SI-ALLOC-B',
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [invoiceLine({ quantity: 2, unitPrice: 100 })],
    });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(second.status, 201, JSON.stringify(second.json));

    const receipt = await post('/api/customer-payments', {
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 200,
      paymentMethod: 'CASH',
      notes: 'PCB multi-invoice allocation',
      allocations: [
        { invoiceId: 'pcb-si-alloc-a', amount: 100 },
        { invoiceId: 'pcb-si-alloc-b', amount: 100 },
      ],
    });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.json));
    assert.equal(receipt.json.allocations.length, 2);
    assert.equal(receipt.json.invoiceId, null, 'a multi-invoice receipt has no single invoice header');

    const allocated = await pool!.query(
      `SELECT id, amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus"
         FROM sales_invoices
        WHERE id IN ('pcb-si-alloc-a', 'pcb-si-alloc-b')
        ORDER BY id`
    );
    assert.deepEqual(
      allocated.rows.map((row) => [row.id, Number(row.amountPaid), row.paymentStatus]),
      [
        ['pcb-si-alloc-a', 100, 'PARTIAL'],
        ['pcb-si-alloc-b', 100, 'PARTIAL'],
      ]
    );

    const refused = await post('/api/customer-payments', {
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 100,
      paymentMethod: 'CASH',
      notes: 'PCB over-allocated receipt',
      allocations: [
        { invoiceId: 'pcb-si-alloc-a', amount: 100 },
        { invoiceId: 'pcb-si-alloc-b', amount: 1 },
      ],
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    const refusedRows = await pool!.query(
      "SELECT count(*)::int AS n FROM customer_payments WHERE notes = 'PCB over-allocated receipt'"
    );
    assert.equal(Number(refusedRows.rows[0].n), 0, 'an over-allocated receipt must not leave a header');

    const advance = await post('/api/customer-payments', {
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 50,
      paymentMethod: 'CASH',
      notes: 'PCB unapplied advance',
    });
    assert.equal(advance.status, 201, JSON.stringify(advance.json));
    assert.deepEqual(advance.json.allocations, []);
    const afterAdvance = await pool!.query(
      `SELECT amount_paid::numeric AS "amountPaid" FROM sales_invoices WHERE id = 'pcb-si-alloc-a'`
    );
    assert.equal(Number(afterAdvance.rows[0].amountPaid), 100, 'an unapplied advance must not touch an invoice');

    const reversed = await post(
      `/api/customer-payments/${receipt.json.id}/reverse`,
      { reason: 'PCB allocation reversal' },
      tokens.super
    );
    assert.equal(reversed.status, 200, JSON.stringify(reversed.json));
    const restored = await pool!.query(
      `SELECT id, amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus"
         FROM sales_invoices
        WHERE id IN ('pcb-si-alloc-a', 'pcb-si-alloc-b')
        ORDER BY id`
    );
    assert.deepEqual(
      restored.rows.map((row) => [row.id, Number(row.amountPaid), row.paymentStatus]),
      [
        ['pcb-si-alloc-a', 0, 'UNPAID'],
        ['pcb-si-alloc-b', 0, 'UNPAID'],
      ]
    );
  });

  test('two concurrent receipts and two concurrent reversals cannot double- or over-allocate one invoice', async () => {
    const invoice = await post('/api/sales-invoices', {
      id: 'pcb-si-race',
      invoiceNumber: 'INV-2083-PCB-SI-RACE',
      customerId: CUSTOMER,
      customerName: 'PCB Customer',
      branchId: BR,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [invoiceLine({ quantity: 1, unitPrice: 100 })],
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.json));
    assert.equal(invoice.json.grandTotal, 113);

    // Both requests target the same 113 open balance. The FOR UPDATE lock +
    // in-transaction balance check must let exactly one through; a stale
    // pre-read implementation would post both and set amount_paid to 226.
    const [first, second] = await Promise.all([
      post('/api/customer-payments', {
        invoiceId: 'pcb-si-race',
        customerId: CUSTOMER,
        customerName: 'PCB Customer',
        branchId: BR,
        paymentDateAD: today,
        amount: 113,
        paymentMethod: 'CASH',
        notes: 'PCB race receipt A',
      }),
      post('/api/customer-payments', {
        invoiceId: 'pcb-si-race',
        customerId: CUSTOMER,
        customerName: 'PCB Customer',
        branchId: BR,
        paymentDateAD: today,
        amount: 113,
        paymentMethod: 'CASH',
        notes: 'PCB race receipt B',
      }),
    ]);
    const receiptStatuses = [first.status, second.status].sort();
    assert.equal(
      receiptStatuses.filter((status) => status === 201).length,
      1,
      `exactly one receipt must win: ${JSON.stringify([first.json, second.json])}`
    );
    assert.ok(
      receiptStatuses.every((status) => status === 201 || status === 400 || status === 409),
      `the losing receipt must be a clean refusal, not a second posting: ${receiptStatuses.join(',')}`
    );

    const afterReceipts = await pool!.query(
      `SELECT id, amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus"
         FROM sales_invoices WHERE id = 'pcb-si-race'`
    );
    assert.equal(Number(afterReceipts.rows[0].amountPaid), 113, 'the invoice is paid once, not twice');
    assert.equal(afterReceipts.rows[0].paymentStatus, 'PAID');
    const receiptRows = await pool!.query(
      "SELECT id, status FROM customer_payments WHERE invoice_id = 'pcb-si-race'"
    );
    assert.equal(receiptRows.rows.length, 1, 'the losing request must not leave a payment header');
    assert.equal(receiptRows.rows[0].status, 'POSTED');
    const winningReceiptId = String(receiptRows.rows[0].id);
    assert.equal((await journalFor('CUSTOMER_PAYMENT', winningReceiptId)).length, 1);

    // Two simultaneous reversals of the same posted receipt: the status guard
    // must flip POSTED once. The invoice is restored once, not twice.
    const [reverseA, reverseB] = await Promise.all([
      post(`/api/customer-payments/${winningReceiptId}/reverse`, { reason: 'PCB race reversal A' }),
      post(`/api/customer-payments/${winningReceiptId}/reverse`, { reason: 'PCB race reversal B' }),
    ]);
    const reverseStatuses = [reverseA.status, reverseB.status].sort();
    assert.equal(reverseStatuses.filter((status) => status === 200).length, 1, JSON.stringify([reverseA.json, reverseB.json]));
    assert.ok(
      reverseStatuses.every((status) => status === 200 || status === 400 || status === 409),
      `unexpected reversal statuses: ${reverseStatuses.join(',')}`
    );

    const restored = await pool!.query(
      `SELECT amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus"
         FROM sales_invoices WHERE id = 'pcb-si-race'`
    );
    assert.equal(Number(restored.rows[0].amountPaid), 0, 'the reversal restores the open balance exactly once');
    assert.equal(restored.rows[0].paymentStatus, 'UNPAID');
    const reversals = await journalFor('CUSTOMER_PAYMENT_REVERSAL', winningReceiptId);
    assert.equal(reversals.length, 1, 'exactly one contra journal may be posted');
  });
  test('a partly applied receipt keeps its remainder an advance and does not claim the invoice', async () => {
    // This test runs after every cash-book assertion, so its stock use cannot
    // starve them; top the row up rather than assuming what earlier tests left.
    await pool!.query(
      'UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + 20 WHERE product_id = $1 AND branch_id = $2',
      [PRODUCT, BR]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ('pcb-part-customer', 'pcb-part-customer', 'PCB Part Customer', '9800000001', $1, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [BR]
    );
    const invoice = await post('/api/sales-invoices', {
      id: 'pcb-si-part',
      invoiceNumber: 'INV-2083-PCB-SI-PART',
      customerId: 'pcb-part-customer',
      customerName: 'PCB Part Customer',
      branchId: BR,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [invoiceLine({ quantity: 4, unitPrice: 100, taxRate: 0, isTaxExempt: true })],
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.json));

    const receipt = await post('/api/customer-payments', {
      customerId: 'pcb-part-customer',
      customerName: 'PCB Part Customer',
      branchId: BR,
      paymentDateAD: today,
      amount: 300,
      paymentMethod: 'CASH',
      notes: 'PCB partly applied receipt',
      allocations: [{ invoiceId: 'pcb-si-part', amount: 250 }],
    });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.json));
    assert.deepEqual(receipt.json.allocations, [
      { invoiceId: 'pcb-si-part', invoiceNumber: 'INV-2083-PCB-SI-PART', amount: 250 },
    ]);
    assert.equal(
      receipt.json.invoiceId,
      null,
      'the 50 unapplied remainder means the receipt did not settle this invoice'
    );

    const row = await pool!.query(
      'SELECT amount_paid::numeric AS "amountPaid", payment_status AS "paymentStatus" FROM sales_invoices WHERE id = $1',
      ['pcb-si-part']
    );
    assert.equal(Number(row.rows[0].amountPaid), 250, 'only the allocated part reaches the invoice');
    assert.equal(row.rows[0].paymentStatus, 'PARTIAL');

    // The cash side is the whole 300; the extra 50 is the customer's advance.
    const journal = await journalFor('CUSTOMER_PAYMENT', String(receipt.json.id));
    assert.equal(journal.length, 1);
    const legs = await journalLines(journal[0].id);
    assert.equal(legs[0].debit, 300);
    assert.equal(legs[1].credit, 300);
  });

  test('the receive-from-ledger list is filtered in SQL, so settled pages cannot hide it', async () => {
    // The Customer Ledger dialog asks for open invoices with a keyset page. A
    // client-side filter over one page of every invoice loses an older open
    // invoice behind newer settled ones; `openOnly` moves the decision into SQL.
    await pool!.query(
      'UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + 20 WHERE product_id = $1 AND branch_id = $2',
      [PRODUCT, BR]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ('pcb-open-customer', 'pcb-open-customer', 'PCB Open Customer', '9800000002', $1, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [BR]
    );
    await post('/api/sales-invoices', {
      id: 'pcb-open-a',
      invoiceNumber: 'INV-2083-PCB-OPEN-A',
      customerId: 'pcb-open-customer',
      customerName: 'PCB Open Customer',
      branchId: BR,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [invoiceLine({ quantity: 1, unitPrice: 100 })],
    });
    for (const suffix of ['b', 'c']) {
      const created = await post('/api/sales-invoices', {
        id: `pcb-open-${suffix}`,
        invoiceNumber: `INV-2083-PCB-OPEN-${suffix.toUpperCase()}`,
        customerId: 'pcb-open-customer',
        customerName: 'PCB Open Customer',
        branchId: BR,
        invoiceDateAD: today,
        paymentMethod: 'CREDIT',
        paymentStatus: 'UNPAID',
        amountPaid: 0,
        items: [invoiceLine({ quantity: 1, unitPrice: 100 })],
      });
      assert.equal(created.status, 201, JSON.stringify(created.json));
    }
    // A is the oldest invoice and still open; B and C are newer and settled.
    await pool!.query(
      "UPDATE sales_invoices SET created_at = CURRENT_TIMESTAMP - INTERVAL '3 days' WHERE id = 'pcb-open-a'"
    );
    await pool!.query(
      "UPDATE sales_invoices SET amount_paid = grand_total, payment_status = 'PAID' WHERE id IN ('pcb-open-b', 'pcb-open-c')"
    );

    const page = await get(
      `/api/sales-invoices?customerId=pcb-open-customer&branchId=${BR}&limit=2`
    );
    assert.equal(page.status, 200, JSON.stringify(page.json));
    assert.deepEqual(page.json.items.map((row: any) => row.id).sort(), ['pcb-open-b', 'pcb-open-c']);

    const open = await get(
      `/api/sales-invoices?customerId=pcb-open-customer&branchId=${BR}&openOnly=1&limit=2`
    );
    assert.equal(open.status, 200, JSON.stringify(open.json));
    assert.deepEqual(open.json.items.map((row: any) => row.id), ['pcb-open-a']);
    assert.equal(Number(open.json.items[0].amountPaid), 0);
  });

});
