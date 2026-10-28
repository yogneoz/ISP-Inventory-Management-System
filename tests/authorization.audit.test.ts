/**
 * Authorization audit (AUTHZ-1…11) — HTTP-layer regression tests on a real
 * Express app wired exactly as production, against real PostgreSQL. Skips
 * without a reachable database (the positive paths need requirePostgres).
 *
 * What this pins:
 *  - AUTHZ-1/2: the branch guard's by-id resource lookup actually runs. It
 *    used to read req.params in app-level middleware, where Express 4 always
 *    supplies {} — so every by-id branch rule was dead code.
 *  - AUTHZ-3: register list reads (sales invoices/returns, purchase returns)
 *    are branch-scoped like the other registers: a branch account cannot omit
 *    the filter and read every branch.
 *  - AUTHZ-4/5/6/7: reports, vendor ledger, direct stock rewrites, PO status
 *    and customer delete carry the operation gate their screen already has.
 *  - AUTHZ-8: a branch-scoped bootstrap slice defaults to the caller's branch
 *    instead of reading all of them; company-wide keys stay global.
 *  - AUTHZ-9: approval cancellation needs `workflow-approval-cancel`, and the
 *    actor is the verified session, never a body-supplied user object.
 *  - AUTHZ-11: the audit trail is gated on `admin-audit`, not shipped to
 *    every signed-in role through bootstrap.
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

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipPositive = !dbReachable && 'needs a reachable PostgreSQL';

const user = (over: Record<string, unknown>) => ({
  id: 'azq-user',
  email: 'azq-user@example.com',
  name: 'AZQ User',
  role: 'FRONT_DESK',
  branchId: 'azq-a',
  allowedBranchIds: ['azq-a'],
  canSwitchUser: false,
  ...over,
} as any);

const FD_A = user({ id: 'azq-fd-a', email: 'azq-fd-a@example.com', role: 'FRONT_DESK' });
const FD_OTHER = user({ id: 'azq-fd-other', email: 'azq-other@example.com', role: 'FRONT_DESK' });
const REQUESTER = user({ id: 'azq-req', email: 'azq-requester@example.com', role: 'FRONT_DESK' });
const ACCT_A = user({ id: 'azq-acct', email: 'azq-acct@example.com', role: 'ACCOUNTANT' });
const INV_MGR = user({ id: 'azq-inv', email: 'azq-inv@example.com', role: 'INVENTORY_MANAGER' });
const AUDITOR = user({ id: 'azq-aud', email: 'azq-aud@example.com', role: 'AUDITOR' });
const PROC = user({ id: 'azq-proc', email: 'azq-proc@example.com', role: 'PROCUREMENT_OFFICER' });
const HQ_WIDE = user({ id: 'azq-hq', email: 'azq-hq@example.com', role: 'INVENTORY_MANAGER', branchId: 'ALL', allowedBranchIds: [] });

const tokens = {
  fd: issueAuthToken(FD_A),
  other: issueAuthToken(FD_OTHER),
  requester: issueAuthToken(REQUESTER),
  acct: issueAuthToken(ACCT_A),
  inv: issueAuthToken(INV_MGR),
  auditor: issueAuthToken(AUDITOR),
  proc: issueAuthToken(PROC),
  hq: issueAuthToken(HQ_WIDE),
};

describe('authorization audit (AUTHZ-1…11)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;

  before(async () => {
    if (!dbReachable) return;

    // Clear leftovers from aborted runs, then seed idempotently.
    await pool!.query("DELETE FROM customer_payments WHERE id LIKE 'azq-%'");
    await pool!.query("DELETE FROM sales_returns WHERE id LIKE 'azq-%'");
    await pool!.query("DELETE FROM purchase_returns WHERE id LIKE 'azq-%'");
    await pool!.query("DELETE FROM sales_invoices WHERE id LIKE 'azq-%'");
    await pool!.query("DELETE FROM approval_requests WHERE id LIKE 'azq-%'");
    await pool!.query("DELETE FROM audit_logs WHERE id LIKE 'azq-%'");
    await pool!.query("DELETE FROM customer_records WHERE id LIKE 'azq-%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'azq-%'");

    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES " +
      "('azq-a', 'AZQA', 'AZQ Branch A', 'T'), ('azq-b', 'AZQB', 'AZQ Branch B', 'T')"
    );
    await pool!.query(
      "INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id) VALUES " +
      "('azq-cust-a', 'CUST-AZQ-A', 'AZQ Customer A', 'azq-a', '9800000001', 'azq-a'), " +
      "('azq-cust-b', 'CUST-AZQ-B', 'AZQ Customer B', 'azq-b', '9800000002', 'azq-b'), " +
      "('azq-cust-del', 'CUST-AZQ-DEL', 'AZQ Customer Delete', 'azq-del', '9800000003', 'azq-a')"
    );
    await pool!.query(
      "INSERT INTO sales_invoices (id, invoice_number, customer_name, branch_id, invoice_date_ad, invoice_date_bs, status) VALUES " +
      "('azq-si-b', 'AZQ-SI-B', 'AZQ Customer B', 'azq-b', '2026-10-01', '2083-06-15 BS', 'POSTED'), " +
      "('azq-si-hq', 'AZQ-SI-HQ', 'AZQ Customer B', 'azq-b', '2026-10-01', '2083-06-15 BS', 'POSTED')"
    );
    await pool!.query(
      "INSERT INTO sales_returns (id, return_number, customer_name, branch_id, return_date_ad, return_date_bs, status) VALUES " +
      "('azq-sr-b', 'AZQ-SR-B', 'AZQ Customer B', 'azq-b', '2026-10-02', '2083-06-16 BS', 'POSTED')"
    );
    await pool!.query(
      "INSERT INTO purchase_returns (id, return_number, supplier_name, branch_id, return_date_ad, return_date_bs, status) VALUES " +
      "('azq-pr-b', 'AZQ-PR-B', 'AZQ Supplier', 'azq-b', '2026-10-02', '2083-06-16 BS', 'POSTED')"
    );
    await pool!.query(
      "INSERT INTO customer_payments (id, payment_number, customer_name, branch_id, payment_date_ad, payment_date_bs, amount, status) VALUES " +
      "('azq-cp-b', 'AZQ-CP-B', 'AZQ Customer B', 'azq-b', '2026-10-03', '2083-06-17 BS', 10, 'POSTED')"
    );
    await pool!.query(
      "INSERT INTO approval_requests (id, request_number, type, requested_by_email, requested_by_name, requested_by_role, branch_id, reason, status) VALUES " +
      "('azq-ar-1', 'AZQ-AR-1', 'CANCEL_TRANSFER', 'azq-requester@example.com', 'AZQ Requester', 'FRONT_DESK', 'azq-a', 'test', 'PENDING')"
    );
    await pool!.query(
      "INSERT INTO audit_logs (id, user_email, user_name, action, module, details, timestamp_bs, branch_id) VALUES " +
      "('azq-audit-1', 'azq-aud@example.com', 'AZQ Auditor', 'AZQ test action', 'SYSTEM', 'audit gate fixture', '2083-06-15 BS', 'azq-a')"
    );

    // Tests never run dbBoot; seed the matrix the guarded routes read.
    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool && dbReachable) {
      await pool.query("DELETE FROM customer_payments WHERE id LIKE 'azq-%'");
      await pool.query("DELETE FROM sales_returns WHERE id LIKE 'azq-%'");
      await pool.query("DELETE FROM purchase_returns WHERE id LIKE 'azq-%'");
      await pool.query("DELETE FROM sales_invoices WHERE id LIKE 'azq-%'");
      await pool.query("DELETE FROM approval_requests WHERE id LIKE 'azq-%'");
      await pool.query("DELETE FROM audit_logs WHERE id LIKE 'azq-%'");
      await pool.query("DELETE FROM customer_records WHERE id LIKE 'azq-%'");
      await pool.query("DELETE FROM branches WHERE id LIKE 'azq-%'");
      await pool.end();
    }
  });

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* empty/non-JSON is fine */ }
    return { status: res.status, json };
  }

  test('AUTHZ-1: by-id branch rules are live — a branch account cannot cancel another branch’s invoice', { skip: skipPositive }, async () => {
    const res = await call('POST', '/api/sales-invoices/azq-si-b/cancel', tokens.fd, { reason: 'test' });
    assert.equal(res.status, 403, 'outer-branch invoice must be refused by the id lookup');
    assert.match(String(res.json?.message), /another branch/i);
  });

  test('AUTHZ-1: …and the same guard covers sales returns, purchase returns and customer payments', { skip: skipPositive }, async () => {
    const salesReturn = await call('POST', '/api/sales-returns/azq-sr-b/cancel', tokens.fd, { reason: 'test' });
    assert.equal(salesReturn.status, 403);
    const purchaseReturn = await call('POST', '/api/purchase-returns/azq-pr-b/cancel', tokens.acct, { reason: 'test' });
    assert.equal(purchaseReturn.status, 403);
    const payment = await call('POST', '/api/customer-payments/azq-cp-b/reverse', tokens.fd, { reason: 'test' });
    assert.equal(payment.status, 403);
  });

  test('AUTHZ-2: register lists require an authorized branch filter', { skip: skipPositive }, async () => {
    for (const path of ['/api/sales-invoices', '/api/sales-returns', '/api/purchase-returns']) {
      const missing = await call('GET', path, tokens.fd);
      assert.equal(missing.status, 403, `${path} must refuse a branch account with no branchId`);
      const own = await call('GET', `${path}?branchId=azq-a`, tokens.fd);
      assert.notEqual(own.status, 403, `${path} must accept the account's own branch`);
    }
  });

  test('AUTHZ-3: the ledger cannot read another branch’s customer', { skip: skipPositive }, async () => {
    const res = await call('GET', '/api/customers/azq-cust-b/ledger?branchId=azq-a', tokens.fd);
    assert.equal(res.status, 403, 'the customer record belongs to another branch');

    // The screen sends no branchId when its filter is ALL, so an own-branch
    // customer must still load: the record check, not a filter, is the guard.
    const own = await call('GET', '/api/customers/azq-cust-a/ledger', tokens.fd);
    assert.notEqual(own.status, 403, 'an own-branch customer ledger must not be over-blocked');
  });

  test('AUTHZ-4: financial statements are operation-gated', { skip: skipPositive }, async () => {
    const report = await call('GET', '/api/reports/financial-summary', tokens.fd);
    assert.equal(report.status, 403, 'FRONT_DESK lacks fin-statements');
    const reportAcct = await call('GET', '/api/reports/financial-summary', tokens.acct);
    assert.notEqual(reportAcct.status, 403, 'ACCOUNTANT holds fin-statements');
  });

  test('AUTHZ-5: the vendor ledger is operation-gated', { skip: skipPositive }, async () => {
    const vendor = await call('GET', '/api/vendors/azq-no-such-supplier/ledger', tokens.fd);
    assert.equal(vendor.status, 403, 'FRONT_DESK lacks inv-pay');
    const vendorAcct = await call('GET', '/api/vendors/azq-no-such-supplier/ledger', tokens.acct);
    assert.equal(vendorAcct.status, 404, 'ACCOUNTANT reaches the handler and gets a real 404');
  });

  test('AUTHZ-6: direct stock rewrites need the stock-level operation', { skip: skipPositive }, async () => {
    // AUDITOR passes the global write allowlist for /stock but holds no
    // stock-level write operation — this is the gate that used to be missing.
    const stock = await call('PATCH', '/api/stock/azq-no-such-stock', tokens.auditor, { quantityOnHand: 1 });
    assert.equal(stock.status, 403, 'AUDITOR must not rewrite stock levels');
    const stockMgr = await call('PATCH', '/api/stock/azq-no-such-stock', tokens.inv, { quantityOnHand: 1 });
    assert.equal(stockMgr.status, 404, 'INVENTORY_MANAGER reaches the handler');
  });

  test('AUTHZ-7: PO status needs a procurement operation', { skip: skipPositive }, async () => {
    const poAuditor = await call('PATCH', '/api/purchase-orders/azq-no-such-po/status', tokens.auditor, { status: 'APPROVED' });
    assert.equal(poAuditor.status, 403, 'AUDITOR holds neither po-create nor po-receive');
    const poProc = await call('PATCH', '/api/purchase-orders/azq-no-such-po/status', tokens.proc, { status: 'APPROVED' });
    assert.notEqual(poProc.status, 403, 'PROCUREMENT_OFFICER may move a PO');
  });

  test('AUTHZ-8: customer deletion needs customers-manage', { skip: skipPositive }, async () => {
    const auditor = await call('DELETE', '/api/customers/azq-cust-del', tokens.auditor);
    assert.equal(auditor.status, 403, 'AUDITOR must not delete a customer');
    const frontDesk = await call('DELETE', '/api/customers/azq-cust-del', tokens.fd);
    assert.equal(frontDesk.status, 200, 'FRONT_DESK holds customers-manage');
  });

  test('AUTHZ-9: approval cancellation needs the matrix operation, with the session actor', { skip: skipPositive }, async () => {
    const other = await call('POST', '/api/approval-requests/azq-ar-1/cancel', tokens.other, { reason: 'not mine' });
    assert.equal(other.status, 403, 'a non-requester without cancel rights must be refused');

    // The screen is driven by `workflow-approval-cancel`; being the requester
    // does not grant it (Branch Manager / Front Desk can never hold it).
    const requester = await call('POST', '/api/approval-requests/azq-ar-1/cancel', tokens.requester, { reason: 'mine' });
    assert.equal(requester.status, 403, 'requester identity alone is not a cancel right');

    const spoofedActor = await call('POST', '/api/approval-requests/azq-ar-1/cancel', tokens.inv, {
      reason: 'withdrawn',
      user: { email: 'spoof@example.com', name: 'Spoof', role: 'SUPER_ADMIN' },
    });
    assert.equal(spoofedActor.status, 200, 'INVENTORY_MANAGER holds workflow-approval-cancel');
    assert.equal(
      spoofedActor.json?.request?.processedByEmail,
      'azq-inv@example.com',
      'the audit actor is the verified session, not the body'
    );
  });

  test('AUTHZ-10: a branch-scoped bootstrap slice defaults to the caller’s branch', { skip: skipPositive }, async () => {
    const branchA = await call('GET', '/api/bootstrap/local?key=customers', tokens.fd);
    assert.equal(branchA.status, 200);
    const rowsA: any[] = branchA.json?.customers || [];
    assert.ok(rowsA.some((r) => r.id === 'azq-cust-a'), 'own-branch customer is present');
    assert.ok(!rowsA.some((r) => r.id === 'azq-cust-b'), 'the other branch’s customer must not be');
  });

  test('AUTHZ-1: an HQ-wide account is not over-blocked by the revived id lookup', { skip: skipPositive }, async () => {
    const res = await call('POST', '/api/sales-invoices/azq-si-hq/cancel', tokens.hq, { reason: 'hq check' });
    assert.notEqual(res.status, 403, 'branchId ALL is bound by operations, not by one branch');
  });

  test('AUTHZ-11: audit logs follow the admin-audit screen gate', { skip: skipPositive }, async () => {
    const frontDesk = await call('GET', '/api/bootstrap/local?key=auditLogs&branchId=azq-a', tokens.fd);
    assert.equal(frontDesk.status, 200, 'the slice stays a successful read (no full-refresh fallback)');
    assert.deepEqual(frontDesk.json?.auditLogs, [], 'FRONT_DESK must not receive the audit trail');

    const auditor = await call('GET', '/api/bootstrap/local?key=auditLogs&branchId=azq-a', tokens.auditor);
    assert.equal(auditor.status, 200);
    assert.ok(
      (auditor.json?.auditLogs || []).some((row: any) => row.id === 'azq-audit-1'),
      'AUDITOR holds admin-audit and receives the row'
    );
  });

  test('ALIGN-1: purchase-invoice delete matches the inv-delete matrix', { skip: skipPositive }, async () => {
    const acct = await call('DELETE', '/api/purchase-invoices/azq-no-such-invoice', tokens.acct);
    assert.equal(acct.status, 403, 'ACCOUNTANT no longer holds invoice deletion');
  });
});
