/**
 * AR / AP aging API — real Express app against its own PostgreSQL database.
 *
 * The report exists to answer one question honestly: do the aged open items
 * agree with the control account they belong to? So the suite posts real
 * invoices, receipts and supplier payments through the manual-journal route,
 * then drives `GET /api/accounting/aging` and ties its net back to the same
 * control account the reconciliation route reads.
 *
 * A throwaway database (scripts/schema.sql only) is deliberate: the suite
 * creates branches and dated AR/AP journals that must not appear in another
 * suite's company-wide statements. See tests/fixtures/throwawayDatabase.ts.
 *
 * Pinned behavior:
 *   1. AR — an aged customer invoice lands in the right bucket, a fully paid
 *      customer's overpayment appears as an unapplied CREDIT row, and the
 *      aging net equals the AR control balance with zero difference.
 *   2. AP — a supplier invoice whose stored `due_date_ad` is the vendor-bill
 *      convention falls back to the invoice date, a partial payment reduces the
 *      oldest invoice, and an unmatched supplier payment stays visible.
 *   3. AS-OF — an earlier date excludes later documents and credits; the
 *      control balance moves with it, still with zero difference.
 *   4. BRANCH / CONSOLIDATED — a branch report contains only its branch, and
 *      the company roll-up equals the sum of the two branch control balances.
 *   5. GATES — gl-view, branch scope, type and date validation are enforced.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase, type ThrowawayDatabase } from './fixtures/throwawayDatabase';

dotenv.config();

const TEST_DB = 'inventory_accounting_aging_test';
const BR_A = 'AGBR';
const BR_B = 'AGB2';
const AS_OF = '2026-11-02';

// Cheap reachability probe so a database-less environment skips instead of
// failing on CREATE DATABASE. The throwaway itself is created in before().
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

const USERS = {
  super: { id: 'ag-super', email: 'ag-super@example.com', name: 'AG Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  accountantA: { id: 'ag-accountant-a', email: 'ag-accountant-a@example.com', name: 'AG Accountant A', role: 'ACCOUNTANT', branchId: BR_A, allowedBranchIds: [BR_A], canSwitchUser: false },
  auditor: { id: 'ag-auditor', email: 'ag-auditor@example.com', name: 'AG Auditor', role: 'AUDITOR', branchId: BR_A, allowedBranchIds: [BR_A], canSwitchUser: false },
  frontdesk: { id: 'ag-frontdesk', email: 'ag-frontdesk@example.com', name: 'AG Front Desk', role: 'FRONT_DESK', branchId: BR_A, allowedBranchIds: [BR_A], canSwitchUser: false },
  empty: { id: 'ag-empty', email: 'ag-empty@example.com', name: 'AG Empty', role: 'ACCOUNTANT', branchId: '', allowedBranchIds: [], canSwitchUser: false },
} as const;

describe('AR / AP aging API (real HTTP + throwaway PostgreSQL)', { skip: skipNoDb }, () => {
  let throwaway: ThrowawayDatabase | null = null;
  let port = 0;
  let closeServer: (() => Promise<void>) | null = null;
  let tokens = {} as Record<keyof typeof USERS, string>;
  let arId = '';
  let apId = '';
  let cashId = '';
  let salesId = '';
  let inventoryId = '';

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

  function customerLine(amount: number, partyId: string, partyName: string) {
    return line(arId, amount, 0, { subledgerType: 'CUSTOMER', partyId, partyName });
  }

  function supplierLine(amount: number, partyId: string, partyName: string) {
    return line(apId, 0, amount, { subledgerType: 'SUPPLIER', partyId, partyName });
  }

  async function postInvoice(input: {
    type: 'AR' | 'AP';
    id: string;
    partyId: string;
    partyName: string;
    branchId: string;
    invoiceDate: string;
    dueDate: string | null;
    amount: number;
  }) {
    const res = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: input.invoiceDate,
      branchId: input.branchId,
      memo: `${input.type} invoice ${input.id}`,
      sourceType: input.type === 'AR' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE',
      sourceId: input.id,
      lines:
        input.type === 'AR'
          ? [customerLine(input.amount, input.partyId, input.partyName), line(salesId, 0, input.amount)]
          : [line(inventoryId, input.amount, 0), supplierLine(input.amount, input.partyId, input.partyName)],
    });
    assert.equal(res.status, 201, `${input.id}: ${JSON.stringify(res.json)}`);
  }

  async function postReceipt(input: {
    id: string;
    branchId: string;
    date: string;
    amount: number;
    partyId: string;
    partyName: string;
  }) {
    const res = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: input.date,
      branchId: input.branchId,
      memo: `Receipt ${input.id}`,
      sourceType: 'CUSTOMER_PAYMENT',
      sourceId: input.id,
      lines: [line(cashId, input.amount, 0), line(arId, 0, input.amount, {
        subledgerType: 'CUSTOMER',
        partyId: input.partyId,
        partyName: input.partyName,
      })],
    });
    assert.equal(res.status, 201, `${input.id}: ${JSON.stringify(res.json)}`);
  }

  async function postSupplierPayment(input: {
    id: string;
    branchId: string;
    date: string;
    amount: number;
    partyId: string;
    partyName: string;
  }) {
    const res = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: input.date,
      branchId: input.branchId,
      memo: `Supplier payment ${input.id}`,
      sourceType: 'VENDOR_PAYMENT',
      sourceId: input.id,
      lines: [line(apId, input.amount, 0, {
        subledgerType: 'SUPPLIER',
        partyId: input.partyId,
        partyName: input.partyName,
      }), line(cashId, 0, input.amount)],
    });
    assert.equal(res.status, 201, `${input.id}: ${JSON.stringify(res.json)}`);
  }

  async function aging(type: 'AR' | 'AP', branchId?: string, asOf = AS_OF) {
    const params = new URLSearchParams({ type, asOf });
    if (branchId) params.set('branchId', branchId);
    return get(`/api/accounting/aging?${params.toString()}`, tokens.super);
  }

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) return;
    throwaway = await createThrowawayDatabase(base, TEST_DB);

    // Repoint the server at the throwaway BEFORE importing it: db.ts builds its
    // pool from DATABASE_URL at module load.
    process.env.DATABASE_URL = throwaway.url;
    const { createApp, registerAllRoutes } = await import('../server/src/app');
    const { realPoolInstance, ensurePostgresConnection } = await import('../server/db');
    realPoolInstance?.on?.('error', () => undefined);
    assert.equal(await ensurePostgresConnection(), true, 'the throwaway database must be reachable');

    const { ensureReferenceData } = await import('./fixtures/referenceData');
    const { issueAuthToken } = await import('../server/src/middleware/auth');
    const { setPermissionMatrix } = await import('../server/src/state/runtimeState');
    const { DEFAULT_PERMISSIONS_MATRIX } = await import('../client/src/utils/permissionMatrixData');

    await ensureReferenceData(throwaway.pool);
    for (const branchId of [BR_A, BR_B]) {
      await throwaway.pool.query(
        `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
         VALUES ($1, $1, $1, 'Test', TRUE, TRUE, TRUE, FALSE)`,
        [branchId]
      );
    }

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

    const defaults = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    arId = defaults.json.defaults.AR_CONTROL.accountId;
    apId = defaults.json.defaults.AP_CONTROL.accountId;
    cashId = defaults.json.defaults.CASH.accountId;
    salesId = defaults.json.defaults.SALES.accountId;
    inventoryId = defaults.json.defaults.INVENTORY.accountId;

    // Invoice metadata drives the document number and due date the aging read
    // joins; the money itself moves only through the journals below.
    await throwaway.pool.query(
      `INSERT INTO sales_invoices
         (id, invoice_number, customer_name, branch_id, invoice_date_ad, invoice_date_bs, due_date_ad, grand_total)
       VALUES
         ('ag-ar-1', 'AG-AR-1', 'Alpha Customer', $1, '2026-07-20', '2083-04-05', '2026-08-19', 1000),
         ('ag-ar-2', 'AG-AR-2', 'Alpha Customer', $1, '2026-07-25', '2083-04-10', '2026-08-24', 500),
         ('ag-ar-3', 'AG-AR-3', 'Beta Customer',  $1, '2026-10-15', '2083-06-29', '2026-10-20', 300),
         ('ag-ar-4', 'AG-AR-4', 'Beta Customer',  $1, '2026-07-18', '2083-04-03', NULL, 400),
         ('ag-ar-5', 'AG-AR-5', 'Gamma Customer', $2, '2026-09-10', '2083-05-25', '2026-09-15', 250)`,
      [BR_A, BR_B]
    );
    await throwaway.pool.query(
      `INSERT INTO purchase_invoices
         (id, invoice_number, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, due_date_ad, grand_total)
       VALUES
         ('ag-ap-1', 'AG-AP-1', 'Alpha Supplier', $1, '2026-09-01', '2083-05-16', '2026-09-01', 800),
         ('ag-ap-2', 'AG-AP-2', 'Alpha Supplier', $1, '2026-10-15', '2083-06-29', NULL, 200)`,
      [BR_A]
    );

    await postInvoice({ type: 'AR', id: 'ag-ar-1', partyId: 'CUST-A', partyName: 'Alpha Customer', branchId: BR_A, invoiceDate: '2026-07-20', dueDate: '2026-08-19', amount: 1000 });
    await postInvoice({ type: 'AR', id: 'ag-ar-2', partyId: 'CUST-A', partyName: 'Alpha Customer', branchId: BR_A, invoiceDate: '2026-07-25', dueDate: '2026-08-24', amount: 500 });
    await postInvoice({ type: 'AR', id: 'ag-ar-3', partyId: 'CUST-B', partyName: 'Beta Customer', branchId: BR_A, invoiceDate: '2026-10-15', dueDate: '2026-10-20', amount: 300 });
    await postInvoice({ type: 'AR', id: 'ag-ar-4', partyId: 'CUST-B', partyName: 'Beta Customer', branchId: BR_A, invoiceDate: '2026-07-18', dueDate: null, amount: 400 });
    await postInvoice({ type: 'AR', id: 'ag-ar-5', partyId: 'CUST-C', partyName: 'Gamma Customer', branchId: BR_B, invoiceDate: '2026-09-10', dueDate: '2026-09-15', amount: 250 });
    await postReceipt({ id: 'ag-cp-1', branchId: BR_A, date: '2026-10-25', amount: 1600, partyId: 'CUST-A', partyName: 'Alpha Customer' });

    await postInvoice({ type: 'AP', id: 'ag-ap-1', partyId: 'SUP-A', partyName: 'Alpha Supplier', branchId: BR_A, invoiceDate: '2026-09-01', dueDate: '2026-09-01', amount: 800 });
    await postInvoice({ type: 'AP', id: 'ag-ap-2', partyId: 'SUP-A', partyName: 'Alpha Supplier', branchId: BR_A, invoiceDate: '2026-10-15', dueDate: null, amount: 200 });
    await postSupplierPayment({ id: 'ag-vp-1', branchId: BR_A, date: '2026-10-20', amount: 300, partyId: 'SUP-A', partyName: 'Alpha Supplier' });
    await postSupplierPayment({ id: 'ag-vp-2', branchId: BR_A, date: '2026-10-22', amount: 100, partyId: 'SUP-B', partyName: 'Beta Supplier' });
  });

  after(async () => {
    if (closeServer) await closeServer();
    try {
      const db = await import('../server/db');
      if (db.realPoolInstance) await db.realPoolInstance.end();
    } catch {
      /* best effort — the drop below forces the issue if this fails */
    }
    if (throwaway) {
      await throwaway.pool.end().catch(() => undefined);
      await dropThrowawayDatabase(throwaway.adminPool, TEST_DB);
    }
  });

  test('receivable aging buckets the aged invoice and keeps an overpayment as an unapplied credit', async () => {
    const res = await aging('AR', BR_A);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const data = res.json;
    assert.equal(data.report, 'AR_AGING');
    assert.equal(data.type, 'AR');
    assert.equal(data.branchId, BR_A);
    assert.equal(data.account.postingRole, 'AR_CONTROL');

    // CUST-A: 1,500 of invoices, 1,600 receipt → 100 unapplied credit.
    // CUST-B: 300 due 2026-10-20 → 1–30; 400 dated 2026-07-18 → 90+.
    assert.equal(data.totals['DAYS_1_30'], 300);
    assert.equal(data.totals['DAYS_90_PLUS'], 400);
    assert.equal(data.totals.grossTotal, 700);
    assert.equal(data.totals.unappliedCredit, 100);
    assert.equal(data.totals.total, 600);
    assert.equal(data.totals.controlBalance, 600);
    assert.equal(data.totals.difference, 0);
    assert.equal(data.totals.reconciled, true);

    const alpha = data.parties.find((party: any) => party.partyId === 'CUST-A');
    assert.ok(alpha, 'the paid customer must still appear because of its open credit');
    assert.equal(alpha.grossTotal, 0);
    assert.equal(alpha.unappliedCredit, 100);
    assert.equal(alpha.total, -100);
    assert.equal(alpha.rows.length, 1);
    assert.equal(alpha.rows[0].kind, 'CREDIT');
    assert.equal(alpha.rows[0].amount, 100);
    assert.equal(alpha.rows[0].originalAmount, 1600);
    assert.equal(alpha.rows[0].allocatedAmount, 1500);
    assert.match(alpha.rows[0].journalNo, /^MJ-/);

    const beta = data.parties.find((party: any) => party.partyId === 'CUST-B');
    assert.ok(beta);
    assert.equal(beta.buckets['DAYS_1_30'], 300);
    assert.equal(beta.buckets['DAYS_90_PLUS'], 400);
    const aged = beta.rows.find((row: any) => row.documentNo === 'AG-AR-4');
    assert.ok(aged, 'the invoice without a due date must still be listed');
    assert.equal(aged.dueDateAD, '2026-07-18', 'no recorded terms means the invoice date is the due date');
    assert.equal(aged.daysPastDue, 107);
    assert.equal(aged.bucket, 'DAYS_90_PLUS');
    assert.equal(aged.termsDays, 0);

    const reconciled = await get(`/api/accounting/reconciliations?accountId=${arId}&branchId=${BR_A}`, tokens.super);
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.json));
    assert.equal(data.totals.controlBalance, reconciled.json.glBalance);
    assert.equal(reconciled.json.difference, 0);
  });

  test('payable aging reduces the oldest invoice and shows an unmatched supplier payment', async () => {
    const res = await aging('AP', BR_A);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const data = res.json;
    assert.equal(data.report, 'AP_AGING');

    // P1 800 − 300 FIFO payment → 500 in 61–90; P2 200 → 1–30.
    // SUP-B's 100 payment has no invoice, so it is an unapplied credit.
    assert.equal(data.totals['DAYS_61_90'], 500);
    assert.equal(data.totals['DAYS_1_30'], 200);
    assert.equal(data.totals.grossTotal, 700);
    assert.equal(data.totals.unappliedCredit, 100);
    assert.equal(data.totals.total, 600);
    assert.equal(data.totals.controlBalance, 600);
    assert.equal(data.totals.difference, 0);

    const alphaSupplier = data.parties.find((party: any) => party.partyId === 'SUP-A');
    assert.ok(alphaSupplier);
    const oldest = alphaSupplier.rows.find((row: any) => row.documentNo === 'AG-AP-1');
    assert.equal(oldest.originalAmount, 800);
    assert.equal(oldest.allocatedAmount, 300);
    assert.equal(oldest.amount, 500);
    // The stored value equals the invoice date (the vendor-bill convention),
    // so the report falls back to the invoice date rather than aging it early.
    assert.equal(oldest.dueDateAD, '2026-09-01');
    assert.equal(oldest.bucket, 'DAYS_61_90');

    const betaSupplier = data.parties.find((party: any) => party.partyId === 'SUP-B');
    assert.ok(betaSupplier, 'an unmatched payment must appear as its own party line');
    assert.equal(betaSupplier.rows.length, 1);
    assert.equal(betaSupplier.rows[0].kind, 'CREDIT');
    assert.equal(betaSupplier.rows[0].amount, 100);
    assert.equal(betaSupplier.unappliedCredit, 100);

    const reconciled = await get(`/api/accounting/reconciliations?accountId=${apId}&branchId=${BR_A}`, tokens.super);
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.json));
    // The control route reports the GL's debit-positive balance; AP's natural
    // payable side is the negation of it.
    assert.equal(data.totals.controlBalance, -reconciled.json.glBalance);
  });

  test('an as-of date excludes later documents and moves the control balance with it', async () => {
    const res = await aging('AR', BR_A, '2026-07-31');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const data = res.json;

    // Through 2026-07-31: two CUST-A invoices (not yet due) and the CUST-B
    // invoice dated 2026-07-18, which is 13 days past due.
    assert.equal(data.totals.CURRENT, 1500);
    assert.equal(data.totals['DAYS_1_30'], 400);
    assert.equal(data.totals.grossTotal, 1900);
    assert.equal(data.totals.unappliedCredit, 0);
    assert.equal(data.totals.total, 1900);
    assert.equal(data.totals.controlBalance, 1900);
    assert.equal(data.totals.difference, 0);
    assert.ok(!data.parties.some((party: any) => party.partyId === 'CUST-C'), 'a later branch document must be excluded');
  });

  test('a branch report is scoped and the company roll-up equals the branch controls', async () => {
    const branchB = await aging('AR', BR_B);
    assert.equal(branchB.status, 200, JSON.stringify(branchB.json));
    assert.equal(branchB.json.totals.total, 250);
    assert.equal(branchB.json.totals['DAYS_31_60'], 250);
    assert.equal(branchB.json.totals.controlBalance, 250);
    assert.equal(branchB.json.parties.length, 1);
    assert.equal(branchB.json.parties[0].partyId, 'CUST-C');

    const company = await aging('AR');
    assert.equal(company.status, 200, JSON.stringify(company.json));
    assert.equal(company.json.branchId, null);
    assert.equal(company.json.totals.total, 850);
    assert.equal(company.json.totals.controlBalance, 850);
    assert.equal(company.json.totals.difference, 0);
    assert.equal(
      company.json.totals.total,
      (await aging('AR', BR_A)).json.totals.total + branchB.json.totals.total
    );
  });

  test('permission, branch scope and validation are enforced', async () => {
    assert.equal((await get('/api/accounting/aging?type=AR', tokens.frontdesk)).status, 403);
    const foreign = await get(`/api/accounting/aging?type=AR&branchId=${BR_B}`, tokens.accountantA);
    assert.equal(foreign.status, 403, JSON.stringify(foreign.json));

    const invalidType = await get('/api/accounting/aging?type=GL', tokens.super);
    assert.equal(invalidType.status, 400, JSON.stringify(invalidType.json));
    assert.match(invalidType.json.message, /AR or AP/i);

    const invalidDate = await get('/api/accounting/aging?type=AR&asOf=2026-02-31', tokens.super);
    assert.equal(invalidDate.status, 400, JSON.stringify(invalidDate.json));

    const empty = await get('/api/accounting/aging?type=AR', tokens.empty);
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.deepEqual(empty.json.parties, []);
    assert.equal(empty.json.totals.total, 0);
    assert.equal(empty.json.totals.reconciled, true);

    assert.equal((await get('/api/accounting/aging?type=AR')).status, 401);
  });
});
