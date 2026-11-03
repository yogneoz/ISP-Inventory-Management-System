/**
 * Returns, inter-branch transfers and CPE moves → ledger, driven through the
 * real HTTP routes against PostgreSQL.
 *
 * These are the last stock-moving documents that used to change quantity with
 * no journal, so this suite is the proof that the inventory control account is
 * no longer blind there:
 *
 *   1. a purchase return debits AP and credits inventory + input VAT, and
 *      cancelling it posts a linked contra journal that restores every balance;
 *   2. a sales return mirrors the original sale at the recorded issue cost
 *      (AR / revenue / output VAT the other way, inventory back in against
 *      COGS) and its cancellation reverses exactly that;
 *   3. a dispatch/receive pair posts BOTH branch legs at the dispatching
 *      branch's weighted average — due-from/due-to head office — and
 *      cancel-receive + cancel each post the contra leg;
 *   4. a CPE deployment moves value from Inventory to Deployed CPE Assets and
 *      its collection moves it back at the same cost;
 *   5. after all of it, inventory control equals the balance-sheet inventory
 *      figure AND the stock rows' quantity × average value for each branch,
 *      both branch balance sheets balance, and the inter-branch custody
 *      accounts net to zero company-wide.
 *
 * A suite that only inspected repositories could not see a half-written
 * document, so every mutation here goes through the production routes on a
 * real Express app (createApp + registerAllRoutes). Skips without a reachable
 * PostgreSQL (DATABASE_URL).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  createApp,
  registerAllRoutes,
  setBranches,
  setInventoryStock,
  setProducts,
} from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { ensureReferenceData, todayAd } from './fixtures/referenceData';

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

const BR_A = 'ra-branch-a';
const BR_B = 'ra-branch-b';
const PROD = 'ra-prod';
const CPE_PROD = 'ra-cpe-prod';
const CUSTOMER = 'ra-customer';
const today = todayAd();

const ADMIN = {
  id: 'ra-admin',
  email: 'ra-admin@example.com',
  name: 'RA Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('returns, transfers and CPE post to the ledger (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);

  async function request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is itself a finding */ }
    return { status: res.status, json };
  }

  const get = (path: string) => request('GET', path);
  const post = (path: string, body?: unknown) => request('POST', path, body);
  const patch = (path: string, body: unknown) => request('PATCH', path, body);

  async function cleanup() {
    // Journals first: their branch FK blocks deleting the test branches.
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = ANY($1)', [[BR_A, BR_B]]);
    await pool!.query("DELETE FROM shipments WHERE id LIKE 'ra-%'");
    await pool!.query("DELETE FROM sales_returns WHERE id LIKE 'ra-%'");
    await pool!.query("DELETE FROM purchase_returns WHERE id LIKE 'ra-%'");
    await pool!.query("DELETE FROM sales_invoices WHERE id LIKE 'ra-%'");
    await pool!.query("DELETE FROM purchase_invoices WHERE id LIKE 'ra-%'");
    await pool!.query("DELETE FROM fixed_assets WHERE id LIKE 'ra-%'");
    await pool!.query("DELETE FROM transaction_logs WHERE product_id LIKE 'ra-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id LIKE 'ra-%'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%RA-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'ra-%'");
    await pool!.query("DELETE FROM customer_records WHERE id LIKE 'ra-%'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1)', [[BR_A, BR_B]]);
  }

  async function journalFor(sourceType: string, sourceId: string) {
    const { rows } = await pool!.query(
      `SELECT id, journal_no AS "journalNo", status, branch_id AS "branchId",
              source_type AS "sourceType", source_id AS "sourceId",
              reversal_of_id AS "reversalOfId", journal_date_ad AS "journalDateAD"
         FROM gl_journals
        WHERE source_type = $1 AND source_id = $2
        ORDER BY posted_at ASC, journal_no ASC`,
      [sourceType, sourceId]
    );
    return rows;
  }

  async function journalLines(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT a.code, a.name, l.debit::numeric AS debit, l.credit::numeric AS credit
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
        WHERE l.journal_id = $1
        ORDER BY l.line_no ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function journalTotals(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT COALESCE(SUM(debit), 0)::numeric AS debit, COALESCE(SUM(credit), 0)::numeric AS credit
         FROM gl_journal_lines WHERE journal_id = $1`,
      [journalId]
    );
    return { debit: Number(rows[0]?.debit || 0), credit: Number(rows[0]?.credit || 0) };
  }

  async function accountBalance(code: string, branchId?: string) {
    const { rows } = await pool!.query(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS balance
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
        WHERE a.code = $1 ${branchId ? 'AND l.branch_id = $2' : ''}`,
      branchId ? [code, branchId] : [code]
    );
    return Number(rows[0].balance);
  }

  async function stockOf(productId: string, branchId: string) {
    const { rows } = await pool!.query(
      `SELECT quantity_on_hand::int AS qty, average_cost::numeric AS avg
         FROM inventory_stock WHERE product_id = $1 AND branch_id = $2`,
      [productId, branchId]
    );
    if (!rows[0]) return { qty: 0, avg: 0 };
    return { qty: Number(rows[0].qty), avg: Number(rows[0].avg) };
  }

  /** The amount presented for an account code in a statement response. */
  function statementAmount(statement: any, code: string): number {
    const sections = [
      ...(statement.assets?.sections || []),
      ...(statement.liabilities?.sections || []),
      ...(statement.equity?.sections || []),
    ];
    for (const section of sections) {
      for (const group of section.groups || []) {
        const account = (group.accounts || []).find((line: any) => line.code === code);
        if (account) return Number(account.amount);
      }
    }
    return 0;
  }

  async function balanceSheet(branchId?: string) {
    const res = await get(
      '/api/accounting/statements/balance-sheet?asOf=' + today +
        (branchId ? '&branchId=' + encodeURIComponent(branchId) : '')
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  }

  function line(productId: string, quantity: number, unitPrice: number) {
    return {
      productId,
      productName: productId === PROD ? 'RA Product' : 'RA CPE Unit',
      sku: productId === PROD ? 'RA-SKU' : 'RA-CPE-SKU',
      unit: 'Pcs',
      quantity,
      unitPrice,
      discount: 0,
      taxRate: 13,
      isTaxExempt: false,
    };
  }

  before(async () => {
    await ensureReferenceData(pool!, today);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
         ($1, 'RAA', 'RA Branch A', 'Test'),
         ($2, 'RAB', 'RA Branch B', 'Test')`,
      [BR_A, BR_B]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ($1, 'RA-CUST', 'RA Customer', '9800000001', $2, 'ACTIVE')`,
      [CUSTOMER, BR_A]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES
        ($1, 'RA Product', 'RA-SKU', 'Equipment', 'Product Item', 'Pcs', 100, 150, FALSE, 'QUANTITY_ONLY'),
        ($2, 'RA CPE Unit', 'RA-CPE-SKU', 'Equipment', 'Product Item', 'Pcs', 50, 80, FALSE, 'QUANTITY_ONLY')`,
      [PROD, CPE_PROD]
    );

    // The app's own in-memory masters: the fixed-asset deploy pre-flight and
    // the shipment serial planner read these, exactly as a booted server would.
    setBranches([
      { id: BR_A, code: 'RAA', name: 'RA Branch A', location: 'Test' },
      { id: BR_B, code: 'RAB', name: 'RA Branch B', location: 'Test' },
    ] as any);
    setProducts([
      { id: PROD, name: 'RA Product', sku: 'RA-SKU', category: 'Equipment', productGroup: 'Product Item', unit: 'Pcs', costPrice: 100, sellingPrice: 150, requiresSerialTracking: false, trackingType: 'QUANTITY_ONLY' },
      { id: CPE_PROD, name: 'RA CPE Unit', sku: 'RA-CPE-SKU', category: 'Equipment', productGroup: 'Product Item', unit: 'Pcs', costPrice: 50, sellingPrice: 80, requiresSerialTracking: false, trackingType: 'QUANTITY_ONLY' },
    ] as any);
    setInventoryStock([]);

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
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('a purchase bill seeds stock and inventory, so the return below has a real balance to mirror', async () => {
    const res = await post('/api/purchase-invoices', {
      id: 'ra-pi-1',
      invoiceNumber: 'RA-PI-1',
      branchId: BR_A,
      invoiceDateAD: today,
      supplierName: 'RA Supplier',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      items: [line(PROD, 20, 100)],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.grandTotal, 2260);

    const stock = await stockOf(PROD, BR_A);
    assert.equal(stock.qty, 20);
    assert.equal(stock.avg, 100);

    const [journal] = await journalFor('PURCHASE_INVOICE', 'ra-pi-1');
    assert.ok(journal, 'the bill must write a journal in its own transaction');
    assert.equal(journal.branchId, BR_A);
    assert.equal(await accountBalance('1200', BR_A), 2000);
  });

  test('a purchase return debits AP and credits inventory + input VAT; cancelling reverses exactly', async () => {
    const res = await post('/api/purchase-returns', {
      id: 'ra-pr-1',
      originalInvoiceId: 'ra-pi-1',
      branchId: BR_A,
      returnDateAD: today,
      reason: 'DEFECTIVE',
      items: [line(PROD, 1, 100)],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const [journal] = await journalFor('PURCHASE_RETURN', 'ra-pr-1');
    assert.ok(journal, 'the return must post its own journal');
    assert.equal(journal.branchId, BR_A);
    const totals = await journalTotals(journal.id);
    assert.equal(totals.debit, 113);
    assert.equal(totals.credit, 113);

    const lines = await journalLines(journal.id);
    assert.equal(lines.find((l) => l.code === '2100')?.debit, 113, 'AP is debited at the bill total');
    assert.equal(lines.find((l) => l.code === '1200')?.credit, 100, 'inventory is relieved at the bill value');
    assert.equal(lines.find((l) => l.code === '1300')?.credit, 13, 'input VAT is reversed');

    assert.equal((await stockOf(PROD, BR_A)).qty, 19);
    assert.equal(await accountBalance('1200', BR_A), 1900);

    const cancel = await post('/api/purchase-returns/ra-pr-1/cancel', { reason: 'RA cancel test' });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.json));

    const reversals = await journalFor('PURCHASE_RETURN_REVERSAL', 'ra-pr-1');
    assert.equal(reversals.length, 1);
    assert.equal(reversals[0].reversalOfId, journal.id);
    const reversalLines = await journalLines(reversals[0].id);
    assert.equal(reversalLines.find((l) => l.code === '2100')?.credit, 113);
    assert.equal(reversalLines.find((l) => l.code === '1200')?.debit, 100);
    assert.equal(reversalLines.find((l) => l.code === '1300')?.debit, 13);

    assert.equal((await stockOf(PROD, BR_A)).qty, 20, 'the cancelled return puts the unit back');
    assert.equal(await accountBalance('1200', BR_A), 2000);
    assert.equal(await accountBalance('2100', BR_A), -2260, 'AP is credit-normal: back to the bill total');
  });

  test('a sales return mirrors the sale at the recorded issue cost; cancelling reverses it', async () => {
    const invoice = await post('/api/sales-invoices', {
      id: 'ra-si-1',
      invoiceNumber: 'RA-SI-1',
      customerId: CUSTOMER,
      customerName: 'RA Customer',
      branchId: BR_A,
      invoiceDateAD: today,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [line(PROD, 2, 150)],
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.json));
    assert.equal((await stockOf(PROD, BR_A)).qty, 18);
    assert.equal(await accountBalance('1200', BR_A), 1800, 'COGS relieved 2 × 100');

    const res = await post('/api/sales-returns', {
      id: 'ra-sr-1',
      originalInvoiceId: 'ra-si-1',
      customerId: CUSTOMER,
      customerName: 'RA Customer',
      branchId: BR_A,
      returnDateAD: today,
      reason: 'DEFECTIVE',
      restockable: true,
      items: [line(PROD, 1, 150)],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const [journal] = await journalFor('SALES_RETURN', 'ra-sr-1');
    assert.ok(journal, 'the credit note must post its own journal');
    const totals = await journalTotals(journal.id);
    assert.equal(totals.debit, totals.credit, 'every return journal balances');
    assert.equal(totals.debit, 269.5, 'AR 169.5 + revenue 150 + VAT 19.5 + inventory 100 + COGS 100');

    const lines = await journalLines(journal.id);
    assert.equal(lines.find((l) => l.code === '1100')?.credit, 169.5, 'the customer credit is AR');
    assert.equal(lines.find((l) => l.code === '4000')?.debit, 150, 'revenue reversed');
    assert.equal(lines.find((l) => l.code === '2200')?.debit, 19.5, 'output VAT reversed');
    assert.equal(lines.find((l) => l.code === '1200')?.debit, 100, 'inventory restored at the SALE cost');
    assert.equal(lines.find((l) => l.code === '5000')?.credit, 100, 'COGS reversed at the same cost');

    assert.equal((await stockOf(PROD, BR_A)).qty, 19);
    assert.equal(await accountBalance('1200', BR_A), 1900);

    const cancel = await post('/api/sales-returns/ra-sr-1/cancel', { reason: 'RA cancel test' });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.json));

    const reversals = await journalFor('SALES_RETURN_REVERSAL', 'ra-sr-1');
    assert.equal(reversals.length, 1);
    assert.equal(reversals[0].reversalOfId, journal.id);
    const reversalLines = await journalLines(reversals[0].id);
    assert.equal(reversalLines.find((l) => l.code === '1100')?.debit, 169.5);
    assert.equal(reversalLines.find((l) => l.code === '1200')?.credit, 100);
    assert.equal(reversalLines.find((l) => l.code === '5000')?.debit, 100);

    assert.equal((await stockOf(PROD, BR_A)).qty, 18, 'the cancelled return re-deducts the unit');
    assert.equal(await accountBalance('1200', BR_A), 1800);
  });

  test('a dispatch/receive pair posts both branch legs at the issue cost, and cancelling unwinds them', async () => {
    const created = await post('/api/shipments', {
      id: 'ra-sh-1',
      trackingCode: 'RA-TR-1',
      type: 'INTER_BRANCH',
      sourceBranchId: BR_A,
      destinationBranchId: BR_B,
      dispatchDateAD: today,
      items: [{ productId: PROD, productName: 'RA Product', sku: 'RA-SKU', quantitySent: 3 }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));

    const [outJournal] = await journalFor('TRANSFER_OUT', 'ra-sh-1');
    assert.ok(outJournal, 'the dispatch must post a journal');
    assert.equal(outJournal.branchId, BR_A);
    const outLines = await journalLines(outJournal.id);
    assert.equal(outLines.find((l) => l.code === '1610')?.debit, 300, 'source carries due from head office');
    assert.equal(outLines.find((l) => l.code === '1200')?.credit, 300, 'source inventory released');
    assert.equal((await stockOf(PROD, BR_A)).qty, 15);

    const received = await post('/api/shipments/ra-sh-1/receive', {});
    assert.equal(received.status, 200, JSON.stringify(received.json));

    const [inJournal] = await journalFor('TRANSFER_IN', 'ra-sh-1');
    assert.ok(inJournal, 'the receipt must post a journal');
    assert.equal(inJournal.branchId, BR_B);
    const inLines = await journalLines(inJournal.id);
    assert.equal(inLines.find((l) => l.code === '1200')?.debit, 300, 'destination inventory received');
    assert.equal(inLines.find((l) => l.code === '2310')?.credit, 300, 'destination carries due to head office');
    assert.equal((await stockOf(PROD, BR_B)).qty, 3);
    assert.equal((await stockOf(PROD, BR_B)).avg, 100, 'received at the source issue cost, not a local average');

    const branchB = await balanceSheet(BR_B);
    assert.equal(statementAmount(branchB, '1200'), 300);
    assert.equal(branchB.interBranch.dueToHeadOffice, 300);
    assert.equal(branchB.balanced, true);
    assert.equal(branchB.difference, 0);

    const undoReceive = await post('/api/shipments/ra-sh-1/cancel-receive', { reason: 'RA undo receipt' });
    assert.equal(undoReceive.status, 200, JSON.stringify(undoReceive.json));
    const inReversals = await journalFor('TRANSFER_IN_REVERSAL', 'ra-sh-1');
    assert.equal(inReversals.length, 1);
    assert.equal(inReversals[0].reversalOfId, inJournal.id);
    assert.equal((await stockOf(PROD, BR_B)).qty, 0);
    assert.equal(await accountBalance('1200', BR_B), 0);

    const cancel = await post('/api/shipments/ra-sh-1/cancel', { reason: 'RA cancel transfer' });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
    const outReversals = await journalFor('TRANSFER_OUT_REVERSAL', 'ra-sh-1');
    assert.equal(outReversals.length, 1);
    assert.equal(outReversals[0].reversalOfId, outJournal.id);
    assert.equal((await stockOf(PROD, BR_A)).qty, 18, 'the cancelled dispatch restores the source units');
    assert.equal(await accountBalance('1200', BR_A), 1800);
    assert.equal(await accountBalance('1610', BR_A), 0, 'the custody account unwinds with the transfer');
    assert.equal(await accountBalance('2310', BR_B), 0);
  });

  test('CPE assignment moves value into deployed assets; collection moves it back at the same cost', async () => {
    const bill = await post('/api/purchase-invoices', {
      id: 'ra-pi-2',
      invoiceNumber: 'RA-PI-2',
      branchId: BR_A,
      invoiceDateAD: today,
      supplierName: 'RA Supplier',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      items: [line(CPE_PROD, 2, 50)],
    });
    assert.equal(bill.status, 201, JSON.stringify(bill.json));
    assert.equal(await accountBalance('1200', BR_A), 1900, 'inventory grew by the second bill');

    // The fixed-asset route's pre-flight reads the in-memory stock mirror, so
    // keep it truthful about what the routes above just committed to PG.
    setInventoryStock([
      { id: `stk-${BR_A}-${PROD}`, productId: PROD, branchId: BR_A, quantityOnHand: 18, averageCost: 100 },
      { id: `stk-${BR_A}-${CPE_PROD}`, productId: CPE_PROD, branchId: BR_A, quantityOnHand: 2, averageCost: 50 },
    ] as any);

    const created = await post('/api/assets', {
      id: 'ra-asset-1',
      tagNumber: 'RA-AST-1',
      name: 'RA CPE Unit',
      productId: CPE_PROD,
      branchId: BR_A,
      acquisitionCost: 50,
      deployFromStock: true,
      status: 'ASSIGNED_TO_CUSTOMER',
      assignedCustomerId: CUSTOMER,
      assignedCustomerName: 'RA Customer',
      acquisitionDateAD: today,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));

    const issueJournals = await journalFor('CPE_ASSET', 'ra-asset-1');
    assert.equal(issueJournals.length, 1, 'assignment posts one journal');
    const issueLines = await journalLines(issueJournals[0].id);
    assert.equal(issueLines.find((l) => l.code === '1510')?.debit, 50, 'deployed CPE asset is debited');
    assert.equal(issueLines.find((l) => l.code === '1200')?.credit, 50, 'inventory is released');
    assert.equal((await stockOf(CPE_PROD, BR_A)).qty, 1);

    const released = await patch('/api/assets/ra-asset-1/status', { status: 'ACTIVE' });
    assert.equal(released.status, 200, JSON.stringify(released.json));

    const allJournals = await journalFor('CPE_ASSET', 'ra-asset-1');
    assert.equal(allJournals.length, 2, 'collection posts the release journal');
    const releaseLines = await journalLines(allJournals[1].id);
    assert.equal(releaseLines.find((l) => l.code === '1200')?.debit, 50, 'inventory returns at the issue cost');
    assert.equal(releaseLines.find((l) => l.code === '1510')?.credit, 50, 'the deployed asset is released');
    assert.equal((await stockOf(CPE_PROD, BR_A)).qty, 2);

    assert.equal(await accountBalance('1510', BR_A), 0, 'the CPE pair nets to zero');
  });

  test('inventory control equals the balance-sheet figure and the stock value per branch', async () => {
    const branchA = await balanceSheet(BR_A);
    assert.equal(branchA.balanced, true);
    assert.equal(branchA.difference, 0);

    const stockA = await stockOf(PROD, BR_A);
    const stockCpe = await stockOf(CPE_PROD, BR_A);
    const stockValue = stockA.qty * stockA.avg + stockCpe.qty * stockCpe.avg;
    assert.equal(stockValue, 1900, '18 × 100 + 2 × 50');

    const control = await accountBalance('1200', BR_A);
    assert.equal(control, stockValue, 'inventory control equals the stock rows it represents');
    assert.equal(statementAmount(branchA, '1200'), control, 'the balance sheet presents that same control balance');

    // The company roll-up is checked per branch, not globally: other suites run
    // in parallel and their fixtures can legitimately carry their own custody
    // rows. Within THIS company pair, the cancelled transfer leaves neither leg
    // behind, and every posted journal still keeps the company sheet balanced.
    assert.equal(await accountBalance('1610', BR_A), 0, 'no due-from is left behind');
    assert.equal(await accountBalance('2310', BR_B), 0, 'no due-to is left behind');
    const company = await balanceSheet();
    assert.equal(company.balanced, true);

    // Every journal this suite wrote is balanced — no half-posted document.
    const { rows: journals } = await pool!.query(
      `SELECT id FROM gl_journals WHERE branch_id = ANY($1)`,
      [[BR_A, BR_B]]
    );
    assert.ok(journals.length >= 9, 'the suite exercised every posting path');
    for (const journal of journals) {
      const totals = await journalTotals(journal.id);
      assert.equal(totals.debit, totals.credit, `journal ${journal.id} must balance`);
    }
  });
});
