/**
 * Stock-value journal integration, driven through the real stock-operation
 * routes against PostgreSQL.
 *
 * Stock documents used to move quantity without touching the ledger, so the
 * inventory control account could not reconcile and the weighted-average cost
 * was only visible on the purchase/sale paths. These tests pin the missing
 * half:
 *
 *   1. a manual adjustment, a damage and a pullout each post a balanced
 *      journal at the stock row's weighted average (not the product's standard
 *      cost), inside the same transaction that moves the units;
 *   2. the inventory account's trial-balance balance equals the inventory
 *      figure on the branch balance sheet after every movement;
 *   3. reversing a damage, a consumable issue and a pullout posts a linked
 *      contra journal and leaves the original journal and its lines intact —
 *      no orphan rows, no deleted audit trail;
 *   4. the raw stock row keeps its weighted average when quantity falls, so a
 *      later issue cannot drift to the product's standard cost.
 *
 * The opening stock value is posted as a manual journal first: this suite is
 * about *movements*, and a stock row that never entered the ledger would make
 * the control-account comparison meaningless.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import {
  approvalRequests as liveApprovalRequests,
  setBranches,
  setInventoryStock,
  setProducts,
} from '../server/src/state/runtimeState';
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

const BR = 'sa-branch';
const DEST = 'sa-dest';
const PRODUCT = 'sa-prod';
const PRODUCT_NAME = 'SA Router';
const START_QTY = 10;
const AVG_COST = 75;
const OPENING_VALUE = START_QTY * AVG_COST;
const TODAY = new Date().toISOString().split('T')[0];

const ADMIN = {
  id: 'sa-admin',
  email: 'sa-admin@example.com',
  name: 'SA Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('stock operations post value to the ledger (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  let inventoryAccountId = '';
  let inventoryCode = '';
  let stockExpenseCode = '';
  let retainedEarningsAccountId = '';

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
  const post = (path: string, body: unknown) => request('POST', path, body);
  const patch = (path: string, body: unknown) => request('PATCH', path, body);

  async function cleanup() {
    await pool!.query("DELETE FROM approval_requests WHERE request_number LIKE 'APR-SA-%'");
    await pool!.query('DELETE FROM gl_journals WHERE branch_id IN ($1, $2) OR LOWER(source_id) LIKE \'sa-%\' OR memo LIKE \'SA %\'', [BR, DEST]);
    await pool!.query("DELETE FROM stock_operations WHERE id LIKE 'sa-%'");
    await pool!.query('DELETE FROM damage_records WHERE branch_id = $1 OR id LIKE \'dmr-sa-%\' OR damage_reference LIKE \'SA-%\'', [BR]);
    await pool!.query("DELETE FROM transaction_logs WHERE product_id = $1", [PRODUCT]);
    await pool!.query("DELETE FROM inventory_stock WHERE product_id = $1", [PRODUCT]);
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%SA-%'");
    await pool!.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
    await pool!.query('DELETE FROM branches WHERE id IN ($1, $2)', [BR, DEST]);
  }

  async function stockRow() {
    const { rows } = await pool!.query(
      `SELECT quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty",
              average_cost::numeric AS "averageCost"
         FROM inventory_stock WHERE product_id = $1 AND branch_id = $2`,
      [PRODUCT, BR]
    );
    return {
      quantityOnHand: Number(rows[0]?.quantityOnHand ?? 0),
      damagedQty: Number(rows[0]?.damagedQty ?? 0),
      averageCost: Number(rows[0]?.averageCost ?? 0),
    };
  }

  /** Re-seed the live mirror after direct SQL/database writes, so the route's
   *  pre-flight availability check sees the same balance the transaction will. */
  async function syncMirror() {
    const row = await stockRow();
    setInventoryStock([
      {
        id: `stk-${BR.toLowerCase()}-${PRODUCT}`,
        productId: PRODUCT,
        branchId: BR,
        quantityOnHand: row.quantityOnHand,
        damagedQty: row.damagedQty,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: 5,
        lastUpdated: new Date().toISOString(),
      },
    ]);
  }

  async function journalsFor(sourceId: string) {
    const { rows } = await pool!.query(
      `SELECT id, source_type AS "sourceType", status,
              reversal_of_id AS "reversalOfId", journal_no AS "journalNo",
              journal_date_ad AS "journalDateAD"
         FROM gl_journals
        WHERE source_id = $1
        ORDER BY posted_at ASC, journal_no ASC`,
      [sourceId]
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
    return rows.map((row) => ({
      code: String(row.code),
      name: String(row.name),
      debit: Number(row.debit),
      credit: Number(row.credit),
    }));
  }

  function lineFor(lines: Array<{ code: string; debit: number; credit: number }>, code: string) {
    const line = lines.find((row) => row.code === code);
    assert.ok(line, `expected a journal line for account ${code}; got ${JSON.stringify(lines)}`);
    return line!;
  }

  /** One posted journal for a stock operation, with exactly the two expected
   *  value lines. Damage/pullout/adjustment all credit inventory and debit the
   *  branch's stock-expense default. */
  async function assertStockJournal(sourceId: string, amount: number, direction: 'decrease' | 'increase') {
    const journals = await journalsFor(sourceId);
    assert.equal(journals.length, 1, `expected one journal for ${sourceId}: ${JSON.stringify(journals)}`);
    assert.equal(journals[0].sourceType, 'STOCK_OPERATION');
    assert.equal(journals[0].status, 'POSTED');

    const lines = await journalLines(journals[0].id);
    assert.equal(lines.length, 2, `expected two value lines: ${JSON.stringify(lines)}`);
    const inventory = lineFor(lines, inventoryCode);
    const expense = lineFor(lines, stockExpenseCode);
    if (direction === 'decrease') {
      assert.equal(inventory.credit, amount, 'inventory is relieved at weighted average');
      assert.equal(inventory.debit, 0);
      assert.equal(expense.debit, amount, 'stock expense absorbs the relieved value');
      assert.equal(expense.credit, 0);
    } else {
      assert.equal(inventory.debit, amount, 'inventory is restored at weighted average');
      assert.equal(inventory.credit, 0);
      assert.equal(expense.credit, amount, 'stock expense is reversed');
      assert.equal(expense.debit, 0);
    }
    return journals[0];
  }

  async function trialBalance() {
    const res = await get(
      `/api/accounting/statements/trial-balance?branchId=${encodeURIComponent(BR)}&asOf=${TODAY}`
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  }

  async function balanceSheet() {
    const res = await get(
      `/api/accounting/statements/balance-sheet?branchId=${encodeURIComponent(BR)}&asOf=${TODAY}`
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  }

  async function assertInventoryTiesToStatements(expected: number) {
    const tb = await trialBalance();
    assert.equal(tb.balanced, true, 'trial balance debits must equal credits');
    const inventoryRow = tb.accounts.find((account: any) => account.code === inventoryCode);
    assert.ok(inventoryRow, `trial balance must include inventory ${inventoryCode}`);
    assert.equal(inventoryRow.closingBalance, expected);
    assert.equal(inventoryRow.closingDebit, expected);

    const bs = await balanceSheet();
    assert.equal(bs.balanced, true, 'balance sheet must balance');
    const bsInventory = bs.assets.sections
      .flatMap((section: any) => section.groups)
      .flatMap((group: any) => group.accounts)
      .find((account: any) => account.code === inventoryCode);
    assert.ok(bsInventory, 'balance sheet must present the inventory account');
    assert.equal(bsInventory.amount, expected, 'inventory control must equal the balance-sheet inventory figure');
  }

  async function postStockOperation(body: Record<string, unknown>) {
    const res = await post('/api/stock-operations', {
      branchId: BR,
      dateAD: TODAY,
      destinationWarehouseId: 'WH001',
      ...body,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    await syncMirror();
    return res.json;
  }

  before(async () => {
    await ensureReferenceData(pool!, TODAY);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
         ($1, 'SAB', 'SA Stock Branch', 'Test'),
         ($2, 'SAD', 'SA Destination Branch', 'Test')`,
      [BR, DEST]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, $2, 'SA-SKU', 'Equipment', 'Product Item', 'Pcs', 120, 180, FALSE, 'QUANTITY_ONLY')`,
      [PRODUCT, PRODUCT_NAME]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ($1, $2, $3, $4, $5, 5)`,
      [`stk-${BR.toLowerCase()}-${PRODUCT}`, PRODUCT, BR, START_QTY, AVG_COST]
    );

    setBranches([
      { id: BR, code: 'SAB', name: 'SA Stock Branch', location: 'Test' } as any,
      { id: DEST, code: 'SAD', name: 'SA Destination Branch', location: 'Test' } as any,
    ]);
    setProducts([
      {
        id: PRODUCT,
        name: PRODUCT_NAME,
        sku: 'SA-SKU',
        category: 'Equipment',
        productGroup: 'Product Item',
        unit: 'Pcs',
        costPrice: 120,
        sellingPrice: 180,
        requiresSerialTracking: false,
        trackingType: 'QUANTITY_ONLY',
      } as any,
    ]);
    await syncMirror();

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
    inventoryAccountId = defaults.json.defaults.INVENTORY.accountId;
    inventoryCode = defaults.json.defaults.INVENTORY.accountCode;
    stockExpenseCode = defaults.json.defaults.STOCK_EXPENSE.accountCode;
    retainedEarningsAccountId = defaults.json.defaults.RETAINED_EARNINGS.accountId;
    assert.ok(inventoryAccountId, 'the default chart must expose INVENTORY');
    assert.ok(stockExpenseCode, 'the default chart must expose STOCK_EXPENSE');
    assert.ok(retainedEarningsAccountId, 'the default chart must expose RETAINED_EARNINGS');

    // Opening stock value: this suite tests movements, so the existing row has
    // to start inside the ledger for the control-account comparison to mean
    // anything. A manual journal is the honest way to bring it in.
    const opening = await post('/api/accounting/journals', {
      journalDateAD: TODAY,
      branchId: BR,
      memo: 'SA opening stock value',
      lines: [
        { accountId: inventoryAccountId, debit: OPENING_VALUE, credit: 0, memo: 'SA opening stock' },
        { accountId: retainedEarningsAccountId, debit: 0, credit: OPENING_VALUE, memo: 'SA opening stock' },
      ],
    });
    assert.equal(opening.status, 201, JSON.stringify(opening.json));
    await assertInventoryTiesToStatements(OPENING_VALUE);
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('a negative manual adjustment relieves inventory at the weighted average, not the product cost', async () => {
    await postStockOperation({
      id: 'sa-adjust-down',
      referenceNumber: 'SA-ADJ-DOWN',
      type: 'MANUAL_ADJUSTMENT',
      items: [{ productId: PRODUCT, productName: PRODUCT_NAME, quantity: -2 }],
    });

    const row = await stockRow();
    assert.equal(row.quantityOnHand, START_QTY - 2);
    assert.equal(row.averageCost, AVG_COST, 'a quantity fall must not rewrite the weighted average');

    await assertStockJournal('sa-adjust-down', 2 * AVG_COST, 'decrease');
    await assertInventoryTiesToStatements(OPENING_VALUE - 2 * AVG_COST);
  });

  test('a positive manual adjustment restores inventory at the weighted average', async () => {
    await postStockOperation({
      id: 'sa-adjust-up',
      referenceNumber: 'SA-ADJ-UP',
      type: 'MANUAL_ADJUSTMENT',
      items: [{ productId: PRODUCT, productName: PRODUCT_NAME, quantity: 1 }],
    });

    const row = await stockRow();
    assert.equal(row.quantityOnHand, START_QTY - 1);
    assert.equal(row.averageCost, AVG_COST);

    await assertStockJournal('sa-adjust-up', AVG_COST, 'increase');
    await assertInventoryTiesToStatements(OPENING_VALUE - AVG_COST);
  });

  test('a damage moves one unit into the damaged pool and posts its value', async () => {
    await postStockOperation({
      id: 'sa-damage',
      referenceNumber: 'SA-DMG-1',
      type: 'DAMAGE',
      items: [{ productId: PRODUCT, productName: PRODUCT_NAME, quantity: 1 }],
    });

    const row = await stockRow();
    assert.equal(row.quantityOnHand, START_QTY - 2);
    assert.equal(row.damagedQty, 1);
    assert.equal(row.averageCost, AVG_COST);

    await assertStockJournal('sa-damage', AVG_COST, 'decrease');
    await assertInventoryTiesToStatements(OPENING_VALUE - 2 * AVG_COST);
  });

  test('a pullout relieves inventory at the weighted average', async () => {
    await postStockOperation({
      id: 'sa-pullout',
      referenceNumber: 'SA-PLT-1',
      type: 'PULLOUT',
      items: [{ productId: PRODUCT, productName: PRODUCT_NAME, quantity: 1, condition: 'USABLE' }],
    });

    const row = await stockRow();
    assert.equal(row.quantityOnHand, START_QTY - 3);
    assert.equal(row.averageCost, AVG_COST);

    await assertStockJournal('sa-pullout', AVG_COST, 'decrease');
    await assertInventoryTiesToStatements(OPENING_VALUE - 3 * AVG_COST);
  });

  test('reversing a damage posts a linked contra journal and leaves the original intact', async () => {
    const before = await stockRow();
    const res = await post('/api/stock-operations/sa-damage/reverse', { reason: 'SA damage reversed' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    await syncMirror();

    const row = await stockRow();
    assert.equal(row.quantityOnHand, before.quantityOnHand + 1);
    assert.equal(row.damagedQty, 0);

    const journals = await journalsFor('sa-damage');
    assert.equal(journals.length, 2, 'original plus one contra journal');
    const original = journals.find((journal) => journal.sourceType === 'STOCK_OPERATION');
    const reversal = journals.find((journal) => journal.sourceType === 'STOCK_OPERATION_REVERSAL');
    assert.ok(original, 'the original damage journal must not be deleted');
    assert.ok(reversal, 'the reversal must be a first-class journal');
    assert.equal(original!.status, 'POSTED', 'the original keeps its posted status');
    assert.equal(reversal!.reversalOfId, original!.id, 'the contra journal links to its original');

    const reversalLines = await journalLines(reversal!.id);
    const inventory = lineFor(reversalLines, inventoryCode);
    const expense = lineFor(reversalLines, stockExpenseCode);
    assert.equal(inventory.debit, AVG_COST);
    assert.equal(expense.credit, AVG_COST);

    // Original + reversal net to zero, so the unit is back in value as well as
    // quantity; no orphan rows remain for this source.
    const { rows } = await pool!.query(
      `SELECT COALESCE(SUM(l.debit), 0)::numeric AS debit, COALESCE(SUM(l.credit), 0)::numeric AS credit
         FROM gl_journal_lines l
         JOIN gl_journals j ON j.id = l.journal_id
        WHERE j.source_id = 'sa-damage'`
    );
    assert.equal(Number(rows[0].debit), Number(rows[0].credit));
    await assertInventoryTiesToStatements(OPENING_VALUE - 2 * AVG_COST);
  });

  test('a consumable issue posts value and its reversal removes that value again', async () => {
    await postStockOperation({
      id: 'sa-consumable',
      referenceNumber: 'SA-CON-1',
      type: 'CONSUMABLE_ISSUE',
      items: [{ productId: PRODUCT, productName: PRODUCT_NAME, quantity: 1 }],
    });
    const afterIssue = await stockRow();
    assert.equal(afterIssue.quantityOnHand, START_QTY - 3);
    await assertStockJournal('sa-consumable', AVG_COST, 'decrease');
    await assertInventoryTiesToStatements(OPENING_VALUE - 3 * AVG_COST);

    const res = await post('/api/stock-operations/sa-consumable/reverse-consumable', {
      reason: 'SA consumable returned',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    await syncMirror();

    assert.equal((await stockRow()).quantityOnHand, START_QTY - 2);
    const journals = await journalsFor('sa-consumable');
    assert.equal(journals.length, 2);
    assert.equal(journals.find((journal) => journal.sourceType === 'STOCK_OPERATION_REVERSAL')?.reversalOfId,
      journals.find((journal) => journal.sourceType === 'STOCK_OPERATION')?.id);
    await assertInventoryTiesToStatements(OPENING_VALUE - 2 * AVG_COST);
  });

  test('reversing a pullout restores both the units and their inventory value', async () => {
    const res = await post('/api/stock-operations/sa-pullout/reverse-pullout', {
      reason: 'SA pullout cancelled',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    await syncMirror();

    assert.equal((await stockRow()).quantityOnHand, START_QTY - 1);
    const journals = await journalsFor('sa-pullout');
    assert.equal(journals.length, 2);
    assert.equal(journals.find((journal) => journal.sourceType === 'STOCK_OPERATION_REVERSAL')?.reversalOfId,
      journals.find((journal) => journal.sourceType === 'STOCK_OPERATION')?.id);
    await assertInventoryTiesToStatements(OPENING_VALUE - AVG_COST);

    // The stock row's average never moved through issue or reversal.
    assert.equal((await stockRow()).averageCost, AVG_COST);
  });

  test('a physical audit count posts the difference at weighted average', async () => {
    const before = await stockRow();
    const res = await post('/api/stock/reconcile-audit', {
      branchId: BR,
      auditRefNumber: 'SA-AUDIT-1',
      varianceItems: [{ productId: PRODUCT, productName: PRODUCT_NAME, countedQty: 10, unitCost: 120 }],
      auditorName: 'SA Auditor',
      notes: 'SA audit increment',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    await syncMirror();

    const row = await stockRow();
    assert.equal(row.quantityOnHand, START_QTY);
    assert.equal(row.averageCost, AVG_COST, 'a count adjustment at WAC must not rewrite the average');
    assert.equal(row.quantityOnHand - before.quantityOnHand, 1);

    const journals = await journalsFor('SA-AUDIT-1');
    assert.equal(journals.length, 1, JSON.stringify(journals));
    assert.equal(journals[0].sourceType, 'STOCK_AUDIT');
    const lines = await journalLines(journals[0].id);
    assert.equal(lineFor(lines, inventoryCode).debit, AVG_COST);
    assert.equal(lineFor(lines, stockExpenseCode).credit, AVG_COST);

    await assertInventoryTiesToStatements(OPENING_VALUE);
  });

  test('a direct level correction posts the signed difference at weighted average', async () => {
    const res = await patch(`/api/stock/stk-${BR.toLowerCase()}-${PRODUCT}`, {
      quantityOnHand: 12,
      reason: 'SA direct level correction',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.quantityOnHand, 12);

    const row = await stockRow();
    assert.equal(row.quantityOnHand, 12);
    assert.equal(row.averageCost, AVG_COST, 'a level correction must not rewrite the weighted average');

    const { rows: journals } = await pool!.query(
      `SELECT id, source_id AS "sourceId", source_type AS "sourceType", status
         FROM gl_journals
        WHERE branch_id = $1 AND source_type = 'STOCK_ADJUSTMENT'
        ORDER BY posted_at DESC LIMIT 1`,
      [BR]
    );
    assert.equal(journals.length, 1, 'a level correction must leave one journal');
    assert.equal(journals[0].status, 'POSTED');

    const lines = await journalLines(journals[0].id);
    assert.equal(lineFor(lines, inventoryCode).debit, 2 * AVG_COST);
    assert.equal(lineFor(lines, stockExpenseCode).credit, 2 * AVG_COST);

    const { rows: txn } = await pool!.query(
      `SELECT quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged",
              quantity_after AS "quantityAfter"
         FROM transaction_logs
        WHERE product_id = $1 AND branch_id = $2 AND change_type = 'MANUAL_ADJUSTMENT'
        ORDER BY timestamp_ad DESC LIMIT 1`,
      [PRODUCT, BR]
    );
    assert.deepEqual(txn[0], { quantityBefore: 10, quantityChanged: 2, quantityAfter: 12 });

    await assertInventoryTiesToStatements(OPENING_VALUE + 2 * AVG_COST);
  });

  test('a direct level correction in a closed period rolls back quantity and journal together', async () => {
    const periods = await get('/api/accounting/periods');
    assert.equal(periods.status, 200, JSON.stringify(periods.json));
    const period = periods.json.find((entry: any) => entry.periodKey === TODAY.slice(0, 7));
    assert.ok(period, 'the opening journal must have created this month');

    const closed = await post(`/api/accounting/periods/${period.id}/close`, {});
    assert.equal(closed.status, 200, JSON.stringify(closed.json));
    assert.equal(closed.json.status, 'CLOSED');

    const before = await stockRow();
    const journalsBefore = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM gl_journals WHERE branch_id = $1 AND source_type = 'STOCK_ADJUSTMENT'",
      [BR]
    );

    const refused = await patch(`/api/stock/stk-${BR.toLowerCase()}-${PRODUCT}`, {
      quantityOnHand: 99,
      reason: 'SA closed period correction',
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.match(refused.json.message, /closed/i);

    const after = await stockRow();
    assert.deepEqual(after, before, 'a refused closed-period correction must not move the stock row');
    const journalsAfter = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM gl_journals WHERE branch_id = $1 AND source_type = 'STOCK_ADJUSTMENT'",
      [BR]
    );
    assert.equal(Number(journalsAfter.rows[0].count), Number(journalsBefore.rows[0].count));

    const reopened = await post(`/api/accounting/periods/${period.id}/reopen`, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    assert.equal(reopened.json.status, 'OPEN');
  });

  test('a reorder-only edit writes no stock-value journal and preserves zero', async () => {
    const before = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM gl_journals WHERE branch_id = $1 AND source_type = 'STOCK_ADJUSTMENT'",
      [BR]
    );
    const res = await patch(`/api/stock/stk-${BR.toLowerCase()}-${PRODUCT}`, {
      minReorderLevel: 0,
      reason: 'SA reorder level only',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.minReorderLevel, 0);

    const row = await pool!.query(
      'SELECT min_reorder_level AS "minReorderLevel" FROM inventory_stock WHERE id = $1',
      [`stk-${BR.toLowerCase()}-${PRODUCT}`]
    );
    assert.equal(Number(row.rows[0]?.minReorderLevel), 0);
    const after = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM gl_journals WHERE branch_id = $1 AND source_type = 'STOCK_ADJUSTMENT'",
      [BR]
    );
    assert.equal(Number(after.rows[0].count), Number(before.rows[0].count));
  });

  test('unknown and invalid level corrections write nothing', async () => {
    const missing = await patch('/api/stock/sa-no-such-stock', { quantityOnHand: 1 });
    assert.equal(missing.status, 404, JSON.stringify(missing.json));

    const negative = await patch(`/api/stock/stk-${BR.toLowerCase()}-${PRODUCT}`, { quantityOnHand: -1 });
    assert.equal(negative.status, 400, JSON.stringify(negative.json));
    assert.match(negative.json.message, /non-negative integer/i);
    assert.equal((await stockRow()).quantityOnHand, 12, 'a refused edit must not move quantity');
  });

  test('approving a pending stock audit posts the same weighted-average difference', async () => {
    const before = await stockRow();
    const countedQty = before.quantityOnHand + 1;
    const created = await post('/api/approval-requests', {
      requestNumber: 'APR-SA-AUDIT-1',
      type: 'STOCK_AUDIT_RECONCILIATION',
      targetId: 'SA-AUDIT-APPROVAL',
      customerName: 'SA Stock Audit',
      branchId: BR,
      branchName: 'SA Stock Branch',
      requestedByRole: 'BRANCH_MANAGER',
      requestedByEmail: 'sa-branch@example.com',
      requestedByName: 'SA Branch Manager',
      reason: 'SA approval audit',
      auditData: {
        auditRefNumber: 'SA-AUDIT-APPROVAL',
        varianceItems: [{ productId: PRODUCT, productName: PRODUCT_NAME, countedQty, unitCost: 999 }],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.deepEqual(created.json.auditData, {
      auditRefNumber: 'SA-AUDIT-APPROVAL',
      varianceItems: [{ productId: PRODUCT, productName: PRODUCT_NAME, countedQty, unitCost: 999 }],
    });
    assert.ok(
      liveApprovalRequests.find((entry) => entry.id === created.json.id)?.auditData,
      'the created request should be in the live approval queue with its audit data'
    );

    const approved = await post(`/api/approval-requests/${created.json.id}/process`, { status: 'APPROVED' });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.ok(approved.json.request.auditData, `auditData was dropped by the approval route: ${JSON.stringify(approved.json)}`);

    const row = await stockRow();
    assert.equal(row.quantityOnHand, countedQty);
    assert.equal(row.averageCost, AVG_COST, 'the approval uses the locked weighted average, not the entered cost');

    const journals = await journalsFor('SA-AUDIT-APPROVAL');
    assert.equal(journals.length, 1, JSON.stringify(journals));
    assert.equal(journals[0].sourceType, 'STOCK_AUDIT');
    const lines = await journalLines(journals[0].id);
    assert.equal(lineFor(lines, inventoryCode).debit, AVG_COST);
    assert.equal(lineFor(lines, stockExpenseCode).credit, AVG_COST);

    await assertInventoryTiesToStatements((before.quantityOnHand + 1) * AVG_COST);
  });

  test('receiving a pullout restores the value at the destination, not just the units', async () => {
    const before = await stockRow();
    await postStockOperation({
      id: 'sa-receive',
      referenceNumber: 'SA-RCV-1',
      type: 'PULLOUT',
      destinationWarehouseId: DEST,
      items: [{ productId: PRODUCT, productName: PRODUCT_NAME, quantity: 1, condition: 'USABLE' }],
    });
    assert.equal((await stockRow()).quantityOnHand, before.quantityOnHand - 1, 'dispatch leaves the source');

    const received = await post('/api/stock-operations/sa-receive/receive', {});
    assert.equal(received.status, 200, JSON.stringify(received.json));

    const dest = await pool!.query(
      `SELECT quantity_on_hand AS "quantityOnHand", average_cost::numeric AS "averageCost"
         FROM inventory_stock WHERE product_id = $1 AND branch_id = $2`,
      [PRODUCT, DEST]
    );
    assert.equal(Number(dest.rows[0]?.quantityOnHand), 1);
    assert.equal(Number(dest.rows[0]?.averageCost), AVG_COST, 'receipt materialises the source weighted average');

    const { rows: receiptJournals } = await pool!.query(
      `SELECT id FROM gl_journals
        WHERE source_id = 'sa-receive' AND source_type = 'STOCK_OPERATION_RECEIPT'`
    );
    assert.equal(receiptJournals.length, 1, 'receipt must post one value journal');
    const lines = await journalLines(receiptJournals[0].id);
    assert.equal(lineFor(lines, inventoryCode).debit, AVG_COST);
    assert.equal(lineFor(lines, stockExpenseCode).credit, AVG_COST);

    // Source relieved 75, destination restored 75: the branch P&L and the
    // company inventory account net to zero for the transfer.
    await assertInventoryTiesToStatements(before.quantityOnHand * AVG_COST - AVG_COST);
  });
});
