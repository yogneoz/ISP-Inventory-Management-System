import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * One custody ledger behind every person-directed form — real HTTP + PostgreSQL.
 *
 * PROVES:
 *   1. a CONSUMABLE_ISSUE names an employee and writes BOTH books once: the
 *      branch shelf leaves by the custody ledger and the person's holding rises
 *      (the document used to deduct stock and write nothing else, so the phone,
 *      My Stock and offboarding could not see the units at all);
 *   2. the document carries the same employee and `custody_group_id` as its
 *      movements, so the pair is one queryable fact rather than two guesses;
 *   3. a typed name without an employee is refused (400 EMPLOYEE_REQUIRED) and
 *      writes nothing, and an employee of another branch is refused too — a
 *      name is not an identity, and custody cannot cross a branch shelf;
 *   4. reversing the issue returns the units through custody (holding down,
 *      shelf up) instead of crediting the shelf a second time;
 *   5. the tie-out read reports zero drift between the log, the projection and
 *      the shelf, which is what makes a future divergence visible;
 *   6. a counted stock audit writes off a shortfall as a LOSS (reason
 *      mandatory) and issues a surplus, and re-counts at the holding write
 *      nothing;
 *   7. the phone's work-order completion consumes through the same ledger core,
 *      so the projections the technician reads are rebuilt in the same
 *      transaction, and a consumption the holding cannot cover is a 409 that
 *      leaves the order open.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setBranches, setInventoryStock, setPermissionMatrix, setProducts } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { ensureReferenceData } from './fixtures/referenceData';
import { completeWorkOrder } from '../server/src/services/mobile.service';

dotenv.config();

const BR = 'soc-branch';
const DEST = 'soc-dest';
const PRODUCT = 'soc-prod';
const PRODUCT_NAME = 'SOC Drop Cable';
const EMP = 'soc-emp';
const EMP_OTHER = 'soc-emp-other';
const WO_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WO_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WO_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CPE = 'soc-cpe';
const CPE_NAME = 'SOC CPE Router';
const CPE_SN_1 = 'SOC-CPE-SN-1';
const CPE_SN_2 = 'SOC-CPE-SN-2';
const TODAY = new Date().toISOString().split('T')[0];
const START_QTY = 10;

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (custody documents)';

const ADMIN = {
  id: 'soc-admin',
  email: 'soc-admin@example.com',
  name: 'SOC Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

/** The same branch, a technician's role: `stock-out` yes, `stock-deploy` no. */
const TECH = {
  ...ADMIN,
  id: 'soc-tech',
  email: 'soc-tech@example.com',
  name: 'SOC Field Tech',
  role: 'FIELD_TECHNICIAN',
} as any;

describe('stock operation custody (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const techToken = issueAuthToken(TECH);
  let issuedOpId = '';
  let issuedGroupId = '';

  async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  const get = (path: string) => request('GET', path);
  const post = (path: string, body: unknown) => request('POST', path, body);

  async function cleanup() {
    await pool!.query('DELETE FROM employee_stock_movements WHERE employee_id = ANY($1::text[])', [[EMP, EMP_OTHER]]);
    await pool!.query('DELETE FROM employee_stock_holdings WHERE employee_id = ANY($1::text[])', [[EMP, EMP_OTHER]]);
    await pool!.query("DELETE FROM field_work_orders WHERE work_order_no LIKE 'SOC-WO-%'");
    await pool!.query('DELETE FROM gl_journal_lines WHERE journal_id IN (SELECT id FROM gl_journals WHERE branch_id = $1)', [BR]);
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM stock_operations WHERE branch_id = $1', [BR]);
    await pool!.query('DELETE FROM transaction_logs WHERE product_id = $1', [PRODUCT]);
    await pool!.query('DELETE FROM inventory_stock WHERE product_id = $1', [PRODUCT]);
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'SOC-CPE-%'");
    await pool!.query('DELETE FROM inventory_stock WHERE product_id = $1', [CPE]);
    await pool!.query('DELETE FROM products WHERE id = $1', [CPE]);
    await pool!.query("DELETE FROM customer_records WHERE id LIKE 'soc-cust-%'");
    await pool!.query('DELETE FROM employees WHERE id = ANY($1::text[])', [[EMP, EMP_OTHER]]);
    await purgeAuditLogs(pool!, 'DELETE FROM audit_logs WHERE branch_id = $1'.replace('$1', `'${BR}'`));
    await pool!.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
    await pool!.query('DELETE FROM branches WHERE id IN ($1, $2)', [BR, DEST]);
  }

  async function stockQty(): Promise<number> {
    const { rows } = await pool!.query(
      'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      [PRODUCT, BR]
    );
    return Number(rows[0]?.quantity_on_hand ?? 0);
  }

  async function heldQty(): Promise<number> {
    const { rows } = await pool!.query(
      'SELECT COALESCE(SUM(quantity), 0)::int AS held FROM employee_stock_holdings WHERE employee_id = $1 AND product_id = $2',
      [EMP, PRODUCT]
    );
    return Number(rows[0].held);
  }

  async function movements(type?: string) {
    const { rows } = await pool!.query(
      `SELECT id, movement_type AS "type", quantity, work_order_id AS "workOrderId",
              custody_group_id AS "custodyGroupId", reason
         FROM employee_stock_movements
        WHERE employee_id = $1 AND product_id = $2
        ${type ? 'AND movement_type = $3' : ''}
        ORDER BY created_at ASC, id ASC`,
      type ? [EMP, PRODUCT, type] : [EMP, PRODUCT]
    );
    return rows;
  }

  /** Keep the live mirror in step with SQL writes, so the route's pre-flight
   *  availability check sees the same balance the transaction will. */
  async function syncMirror() {
    const quantity = await stockQty();
    setInventoryStock([
      {
        id: `stk-${BR.toLowerCase()}-${PRODUCT}`,
        productId: PRODUCT,
        branchId: BR,
        quantityOnHand: quantity,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: 5,
        lastUpdated: new Date().toISOString(),
      },
    ]);
  }

  async function issue(quantity: number, extra: Record<string, unknown> = {}) {
    const res = await post('/api/stock-operations', {
      type: 'CONSUMABLE_ISSUE',
      branchId: BR,
      dateAD: TODAY,
      destinationWarehouseId: 'WH001',
      employeeId: EMP,
      reason: 'SOC field kit',
      items: [{ productId: PRODUCT, productName: PRODUCT_NAME, quantity, unitCost: 75 }],
      ...extra,
    });
    if (res.status === 201) await syncMirror();
    return res;
  }

  before(async () => {
    const { ensurePostgresConnection } = await import('../server/db');
    await ensureReferenceData(pool!, TODAY);
    assert.equal(await ensurePostgresConnection(), true, 'the dev database must be reachable');
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
         ($1, 'SOCB', 'SOC Custody Branch', 'Test'),
         ($2, 'SOCD', 'SOC Other Branch', 'Test')`,
      [BR, DEST]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id) VALUES
         ($1, 'SOC-EMP-1', 'Custody Test Tech', $3),
         ($2, 'SOC-EMP-2', 'Other Branch Tech', $4)`,
      [EMP, EMP_OTHER, BR, DEST]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, $2, 'SOC-SKU', 'Consumables', 'Product Item', 'Mtr', 75, 110, FALSE, 'QUANTITY_ONLY')`,
      [PRODUCT, PRODUCT_NAME]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ($1, $2, $3, $4, 75, 5)`,
      [`stk-${BR.toLowerCase()}-${PRODUCT}`, PRODUCT, BR, START_QTY]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id)
       VALUES ('soc-cust-1', 'SOC-CUST-1', 'SOC Test Customer', '9800000000', $1)`,
      [BR]
    );

    setBranches([
      { id: BR, code: 'SOCB', name: 'SOC Custody Branch', location: 'Test' } as any,
      { id: DEST, code: 'SOCD', name: 'SOC Other Branch', location: 'Test' } as any,
    ]);
    setProducts([
      {
        id: PRODUCT,
        name: PRODUCT_NAME,
        sku: 'SOC-SKU',
        category: 'Consumables',
        productGroup: 'Product Item',
        unit: 'Mtr',
        costPrice: 75,
        sellingPrice: 110,
        requiresSerialTracking: false,
        trackingType: 'QUANTITY_ONLY',
      } as any,
    ]);
    await syncMirror();

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
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('an issue writes the shelf, the ledger and the document exactly once', async () => {
    // A technician holds `stock-out` to write units down, but issuing stock to a
    // person is a deployment (`stock-deploy`), so the very same document must be
    // refused for them and move nothing.
    const refused = await fetch('http://127.0.0.1:' + port + '/api/stock-operations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + techToken },
      body: JSON.stringify({
        type: 'CONSUMABLE_ISSUE',
        branchId: BR,
        dateAD: TODAY,
        destinationWarehouseId: 'WH001',
        employeeId: EMP,
        items: [{ productId: PRODUCT, productName: PRODUCT_NAME, quantity: 1, unitCost: 75 }],
      }),
    });
    assert.equal(refused.status, 403, 'a technician may not deploy stock from the issue form');
    assert.equal(await stockQty(), START_QTY, 'a refused issue moves the shelf by nothing');

    const res = await issue(3);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    issuedOpId = res.json.id;
    issuedGroupId = res.json.custodyGroupId;
    assert.ok(issuedGroupId, 'the document names the group its movements share');
    assert.equal(res.json.employeeId, EMP);
    assert.equal(res.json.technicianName, 'Custody Test Tech', 'the display name comes from the employee, not the form');

    assert.equal(await stockQty(), START_QTY - 3, 'the branch shelf left by exactly one issue');
    assert.equal(await heldQty(), 3, 'the person holds what the shelf gave up');

    const rows = await movements('ISSUE');
    assert.equal(rows.length, 1, 'one movement for one document');
    assert.equal(rows[0].quantity, 3);
    assert.equal(rows[0].custodyGroupId, issuedGroupId);

    const doc = await pool!.query(
      'SELECT employee_id, custody_group_id, status FROM stock_operations WHERE id = $1',
      [issuedOpId]
    );
    assert.equal(doc.rows[0].employee_id, EMP);
    assert.equal(doc.rows[0].custody_group_id, issuedGroupId);
    assert.equal(doc.rows[0].status, 'LOGGED');
  });

  test('a typed name without an employee is refused and writes nothing', async () => {
    const res = await issue(1, { employeeId: undefined, technicianName: 'Field Splicing Technician' });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.code, 'EMPLOYEE_REQUIRED');
    assert.equal(await stockQty(), START_QTY - 3, 'the shelf did not move');
    assert.equal((await movements('ISSUE')).length, 1, 'no second movement was written');
  });

  test('an employee of another branch is refused', async () => {
    const res = await issue(1, { employeeId: EMP_OTHER });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.code, 'EMPLOYEE_OUTSIDE_BRANCH');
    assert.equal(await stockQty(), START_QTY - 3);
  });

  test('reversing an issue returns custody instead of crediting the shelf twice', async () => {
    const res = await post(`/api/stock-operations/${issuedOpId}/reverse-consumable`, {
      reason: 'SOC units came back to the store',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(await stockQty(), START_QTY, 'the shelf is restored once, by the RETURN');
    assert.equal(await heldQty(), 0, 'the person no longer holds the units');

    const returns = await movements('RETURN');
    assert.equal(returns.length, 1);
    assert.equal(returns[0].quantity, 3);
    assert.equal(returns[0].custodyGroupId, issuedGroupId, 'the reversal is queryable as the same document');

    const doc = await pool!.query('SELECT status FROM stock_operations WHERE id = $1', [issuedOpId]);
    assert.equal(doc.rows[0].status, 'CANCELLED');
  });

  test('the tie-out shows the log, the projection and the shelf agreeing', async () => {
    const res = await get(`/api/employee-stock/tieout?productId=${PRODUCT}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.rows.length, 1);
    const row = res.json.rows[0];
    assert.equal(row.employeeId, EMP);
    assert.equal(row.issued, 3);
    assert.equal(row.returned, 3);
    assert.equal(row.held, 0);
    assert.equal(row.movementSum, 0);
    assert.equal(row.drift, 0, 'the projection is rebuilt from the log');
    assert.equal(row.branchOnHand, START_QTY, 'the shelf is back where it started');
    assert.equal(res.json.totals.drift, 0);
  });

  test('a counted audit writes off a shortfall and issues a surplus', async () => {
    const issued = await issue(4);
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    assert.equal(await heldQty(), 4);

    const short = await post('/api/employee-stock/audit', {
      employeeId: EMP,
      reason: 'Monthly van count',
      items: [{ productId: PRODUCT, countedQuantity: 1 }],
    });
    assert.equal(short.status, 201, JSON.stringify(short.json));
    assert.equal(short.json.movements.length, 1);
    assert.equal(short.json.movements[0].movement_type, 'LOSS');
    assert.equal(await heldQty(), 1, 'the missing units left custody');
    assert.equal(await stockQty(), START_QTY - 4, 'a write-off does not put units back on the shelf');

    const noReason = await post('/api/employee-stock/audit', {
      employeeId: EMP,
      items: [{ productId: PRODUCT, countedQuantity: 1 }],
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.json.code, 'REASON_REQUIRED');

    const surplus = await post('/api/employee-stock/audit', {
      employeeId: EMP,
      reason: 'Found two more drums in the van',
      items: [{ productId: PRODUCT, countedQuantity: 3 }],
    });
    assert.equal(surplus.status, 201, JSON.stringify(surplus.json));
    assert.equal(surplus.json.movements[0].movement_type, 'ISSUE');
    assert.equal(await heldQty(), 3);
    assert.equal(await stockQty(), START_QTY - 6, 'a surplus came off the shelf');

    const unchanged = await post('/api/employee-stock/audit', {
      employeeId: EMP,
      reason: 'Second count agrees',
      items: [{ productId: PRODUCT, countedQuantity: 3 }],
    });
    assert.equal(unchanged.status, 201, JSON.stringify(unchanged.json));
    assert.equal(unchanged.json.movements.length, 0, 'a line at the holding writes nothing');
    assert.equal(await heldQty(), 3);
  });

  test('a shortage is refused before anything is written', async () => {
    const before = (await movements()).length;
    const res = await issue(100, { referenceNumber: 'SOC-OVER-1' });
    assert.ok(res.status === 400 || res.status === 409, `expected a refusal, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(await stockQty(), START_QTY - 6, 'the shelf is untouched');
    assert.equal((await movements()).length, before, 'no movement was written');
    const doc = await pool!.query("SELECT COUNT(*)::int AS n FROM stock_operations WHERE reference_number = 'SOC-OVER-1'");
    assert.equal(doc.rows[0].n, 0, 'the refused document rolled back with its transaction');
  });

  test("the phone's completion consumes through the ledger and rebuilds the projection", async () => {
    await pool!.query(
      `INSERT INTO field_work_orders
         (id, work_order_no, branch_id, customer_id, kind, status, technician_id, technician_name,
          scheduled_date_ad, created_by, row_version)
       VALUES
         ($3, 'SOC-WO-1', $1, 'soc-cust-1', 'INSTALL', 'ASSIGNED', $2, 'Custody Test Tech', CURRENT_DATE, 'soc-test', 1),
         ($4, 'SOC-WO-2', $1, 'soc-cust-1', 'SERVICE', 'ASSIGNED', $2, 'Custody Test Tech', CURRENT_DATE, 'soc-test', 1)`,
      [BR, EMP, WO_1, WO_2]
    );
    const employee = { id: EMP, branch_id: BR, employee_code: 'SOC-EMP-1' };
    const req = { user: { email: 'soc-tech@example.com' } } as any;

    const done = await completeWorkOrder(req, employee, WO_1, {
      baseVersion: 1,
      completionNotes: 'Drop installed',
      consumedCableMeters: 3,
      consumedProductId: PRODUCT,
    });
    assert.equal(done.resultStatus, 'CLOSED');
    assert.equal(await heldQty(), 0, 'the units the phone used left the projection');
    const consumptions = await movements('CONSUME');
    assert.equal(consumptions.length, 1);
    assert.equal(consumptions[0].quantity, 3);
    assert.equal(consumptions[0].workOrderId, WO_1, 'the consumption names the visit');

    await assert.rejects(
      () =>
        completeWorkOrder(req, employee, WO_2, {
          baseVersion: 1,
          consumedCableMeters: 1,
          consumedProductId: PRODUCT,
        }),
      (error: any) => error?.status === 409 && error?.code === 'INSUFFICIENT_HOLDING'
    );
    const open = await pool!.query('SELECT status, row_version FROM field_work_orders WHERE id = $1', [WO_2]);
    assert.equal(open.rows[0].status, 'ASSIGNED', 'a refused consumption leaves the visit open');
    assert.equal(open.rows[0].row_version, 1);
  });

  /** A received, serial-tracked CPE with two units in this branch. */
  async function seedCpe() {
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, $2, 'SOC-CPE-SKU', 'CPE', 'Product Item', 'Pcs', 2500, 3200, TRUE, 'SERIAL_MAC_PON')`,
      [CPE, CPE_NAME]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ($1, $2, $3, 2, 2500, 1)`,
      [`stk-${BR.toLowerCase()}-${CPE}`, CPE, BR]
    );
    await pool!.query(
      `INSERT INTO serial_log
         (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, status, source_type, created_at)
       VALUES ('soc-sl-1', $1, 'SOC-PON-1', 'AA:BB:CC:00:01:01', $3, $4, $5, 'IN_STOCK', 'PURCHASE', now()),
              ('soc-sl-2', $2, 'SOC-PON-2', 'AA:BB:CC:00:01:02', $3, $4, $5, 'IN_STOCK', 'PURCHASE', now())`,
      [CPE_SN_1, CPE_SN_2, CPE, CPE_NAME, BR]
    );
    const stock = await pool!.query(
      'SELECT product_id, quantity_on_hand FROM inventory_stock WHERE branch_id = $1',
      [BR]
    );
    setInventoryStock(
      stock.rows.map((row: any) => ({
        id: `stk-${BR}-${row.product_id}`,
        productId: row.product_id,
        branchId: BR,
        quantityOnHand: Number(row.quantity_on_hand),
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: 1,
        lastUpdated: new Date().toISOString(),
      }))
    );
  }

  async function serialRow(deviceSerial: string) {
    const { rows } = await pool!.query(
      `SELECT status, holder_employee_id AS "holder", customer_id AS "customerId",
              customer_name AS "customerName", source_type AS "sourceType"
         FROM serial_log WHERE device_serial = $1`,
      [deviceSerial]
    );
    return rows[0];
  }

  test('a CPE issued to a technician is installed at the work order customer', async () => {
    await seedCpe();
    const issued = await post('/api/stock-operations', {
      type: 'CONSUMABLE_ISSUE',
      branchId: BR,
      dateAD: TODAY,
      destinationWarehouseId: 'WH001',
      employeeId: EMP,
      reason: 'CPE for install',
      items: [
        {
          productId: CPE,
          productName: CPE_NAME,
          quantity: 1,
          unitCost: 2500,
          deviceSerials: [{ deviceSerial: CPE_SN_1 }],
        },
      ],
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));

    const held = await serialRow(CPE_SN_1);
    assert.equal(held.status, 'IN_CUSTODY', 'issue puts the device in the technician\u2019s hands');
    assert.equal(held.holder, EMP, 'the register names the person holding it');
    assert.equal(held.customerId, null, 'nobody is its customer yet');

    await pool!.query(
      `INSERT INTO field_work_orders
         (id, work_order_no, branch_id, customer_id, kind, status, technician_id, technician_name,
          scheduled_date_ad, created_by, row_version)
       VALUES ($3, 'SOC-WO-3', $1, 'soc-cust-1', 'INSTALL', 'ASSIGNED', $2, 'Custody Test Tech', CURRENT_DATE, 'soc-test', 1)`,
      [BR, EMP, WO_3]
    );
    const employee = { id: EMP, branch_id: BR, employee_code: 'SOC-EMP-1' };
    const done = await completeWorkOrder({ user: { email: 'soc-tech@example.com' } } as any, employee, WO_3, {
      baseVersion: 1,
      serialUsed: CPE_SN_1,
      consumedProductId: CPE,
    });
    assert.equal(done.resultStatus, 'CLOSED');

    const installed = await serialRow(CPE_SN_1);
    assert.equal(installed.status, 'CUSTOMER_ASSIGNED', 'installation is when the customer sees the unit');
    assert.equal(installed.holder, null, 'nobody holds an installed unit');
    assert.equal(installed.customerId, 'soc-cust-1');
    assert.equal(installed.customerName, 'SOC Test Customer');
    assert.equal(installed.sourceType, 'WORK_ORDER', 'the work order is the installing document');

    const cpeHeld = await pool!.query(
      'SELECT COALESCE(SUM(quantity), 0)::int AS held FROM employee_stock_holdings WHERE employee_id = $1 AND product_id = $2',
      [EMP, CPE]
    );
    assert.equal(cpeHeld.rows[0].held, 0, 'the van no longer holds the installed unit');

    const linked = await pool!.query(
      `SELECT s.device_serial
         FROM employee_stock_movement_serials s
         JOIN employee_stock_movements m ON m.id = s.movement_id
        WHERE m.employee_id = $1 AND m.product_id = $2 AND m.movement_type = 'CONSUME'`,
      [EMP, CPE]
    );
    assert.deepEqual(linked.rows.map((row: any) => row.device_serial), [CPE_SN_1], 'the movement names its unit');

    const reversal = await post(`/api/stock-operations/${issued.json.id}/reverse-consumable`, {
      reason: 'undo after install',
    });
    assert.equal(reversal.status, 409, 'an installed unit cannot be pulled back by reversing the issue');
    assert.equal((await serialRow(CPE_SN_1)).status, 'CUSTOMER_ASSIGNED');
  });

  test('the custody panel issues, refuses and returns a serial', async () => {
    const issued = await post('/api/employee-stock/issue', {
      employeeId: EMP,
      productId: CPE,
      quantity: 1,
      deviceSerials: [CPE_SN_2],
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    assert.equal((await serialRow(CPE_SN_2)).status, 'IN_CUSTODY');

    const refused = await post('/api/employee-stock/consume', {
      employeeId: EMP,
      productId: CPE,
      quantity: 1,
      deviceSerials: [CPE_SN_1],
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'SERIAL_NOT_IN_CUSTODY', 'an installed unit is not in anyone\u2019s custody');

    const stillHeld = await pool!.query(
      'SELECT COALESCE(SUM(quantity), 0)::int AS held FROM employee_stock_holdings WHERE employee_id = $1 AND product_id = $2',
      [EMP, CPE]
    );
    assert.equal(stillHeld.rows[0].held, 1, 'the refused consume rolled its movement back');

    const returned = await post('/api/employee-stock/return', {
      employeeId: EMP,
      productId: CPE,
      quantity: 1,
      deviceSerials: [CPE_SN_2],
    });
    assert.equal(returned.status, 201, JSON.stringify(returned.json));
    const back = await serialRow(CPE_SN_2);
    assert.equal(back.status, 'IN_STOCK', 'a returned device is sellable and deployable again');
    assert.equal(back.holder, null);
  });
});
