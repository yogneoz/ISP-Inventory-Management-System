/**
 * Employee asset custody → installation, end to end over real HTTP + PostgreSQL.
 *
 * This is the chain the field team actually runs, and the one no test proved:
 *
 *   1. Assign Fixed Asset dispatches a serialised unit to a technician together
 *      with the visit that carries the customer: `fixed_assets` becomes IN_USE /
 *      EMPLOYEE with the work-order link and NO assignment date (so no warranty
 *      starts early), `serial_log` becomes IN_CUSTODY under that person, and
 *      branch stock is deducted exactly once;
 *   2. the technician's My Stock shows the unit with its customer and visit —
 *      on the web (`/api/employee-stock/assets`) and on the phone
 *      (`GET /api/v1/workplace/stock`, the contract's `assets` list);
 *   3. closing the visit installs it: the WEB completion and the MOBILE
 *      completion both leave `fixed_assets` ASSIGNED_TO_CUSTOMER with the
 *      completion date as `assignment_date`, `serial_log` CUSTOMER_ASSIGNED, a
 *      `cdr-asset-<id>` customer-device row, a SELLER warranty starting on that
 *      date, the employee's custody cleared, and branch stock still deducted
 *      once;
 *   4. a FIELD_TECHNICIAN is refused by `/api/employee-stock/loss` (the write-off
 *      is a manager's `custody-writeoff`); they may only report it, and a manager
 *      executes the pending approval into the LOSS movement;
 *   5. a front-desk deploy straight to a customer still behaves exactly as
 *      before (customer + device row + warranty from the assignment date).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import {
  setPermissionMatrix,
  setUserPermissionOverrides,
  setUserPermissionSetGrants,
  setUsers,
} from '../server/src/state/runtimeState';
import { ensureReferenceData, todayAd } from './fixtures/referenceData';
import { purgeAuditLogs } from './support/purgeAuditLogs';

dotenv.config();

const BRANCH = 'cac-branch';
const CUSTOMER = 'cac-customer';
const CUSTOMER_NAME = 'CAC Test Customer';
const TECH = 'cac-tech';
const PRODUCT = 'cac-product';
const WO_WEB = 'cac0aaaa-0000-4000-8000-000000000001';
const WO_MOBILE = 'cac0aaaa-0000-4000-8000-000000000002';
const WO_NUMBER_WEB = 'CAC-WO-1';
const WO_NUMBER_MOBILE = 'CAC-WO-2';
const UNIT_WEB = { id: 'cac-asset-web', tag: 'CAC-FA-1', serial: 'CAC-SN-1' };
const UNIT_MOBILE = { id: 'cac-asset-mobile', tag: 'CAC-FA-2', serial: 'CAC-SN-2' };
const UNIT_COUNTER = { id: 'cac-asset-counter', tag: 'CAC-FA-3', serial: 'CAC-SN-3' };
// Another branch, its technician and one of its visits: the PATCH dispatch must
// refuse them on this branch's asset, exactly as POST /api/assets does.
const OTHER_BRANCH = 'cac-branch-2';
const OTHER_TECH = 'cac-tech-2';
const WO_OTHER = 'cac0aaaa-0000-4000-8000-000000000003';
const WO_NUMBER_OTHER = 'CAC-WO-3';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (custody chain)';

// The counter role that owns Assign Fixed Asset (`assets-manage`). The global
// `/assets` role rule admits INVENTORY_MANAGER, and the register is that role's.
const DISPATCHER = {
  id: 'cac-dispatcher',
  email: 'cac-dispatcher@example.com',
  name: 'CAC Inventory Manager',
  role: 'INVENTORY_MANAGER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

// The branch manager who approves a custody write-off and closes the visit.
const APPROVER = {
  id: 'cac-approver',
  email: 'cac-approver@example.com',
  name: 'CAC Branch Manager',
  role: 'BRANCH_MANAGER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

// Read-only on the same ledger: sees My Stock, moves nothing.
const AUDITOR = {
  id: 'cac-auditor',
  email: 'cac-auditor@example.com',
  name: 'CAC Auditor',
  role: 'AUDITOR',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

// The counter: sees the register, hands nothing out (stock-deploy is false).
const FRONT_DESK = {
  id: 'cac-front-desk',
  email: 'cac-front-desk@example.com',
  name: 'CAC Front Desk',
  role: 'FRONT_DESK',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

// Finance: owns the asset register, owns no shelf. `stock-deploy` is false by
// product decision, so a deploy attempt must be refused here too.
const ACCOUNTANT = {
  id: 'cac-accountant',
  email: 'cac-accountant@example.com',
  name: 'CAC Accountant',
  role: 'ACCOUNTANT',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

const TECH_USER = {
  id: 'cac-tech-user',
  email: 'cac-tech@example.com',
  name: 'CAC Field Technician',
  role: 'FIELD_TECHNICIAN',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;

let server: http.Server | null = null;
let port = 0;
const dispatcherToken = issueAuthToken(DISPATCHER);
const approverToken = issueAuthToken(APPROVER);
const techToken = issueAuthToken(TECH_USER);
const auditorToken = issueAuthToken(AUDITOR);
const frontDeskToken = issueAuthToken(FRONT_DESK);
const accountantToken = issueAuthToken(ACCOUNTANT);
const TODAY = todayAd();
const SELLER_END = addMonthsAD(TODAY, 12);

function addMonthsAD(dateAD: string, months: number): string {
  const [year, month, day] = dateAD.split('-').map(Number);
  const stamp = new Date(Date.UTC(year, month - 1 + months, day));
  return stamp.toISOString().slice(0, 10);
}

async function call(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method || 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body is a finding, not a crash */
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function stockOnHand(): Promise<number> {
  const row = await pool!.query(
    'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
    [PRODUCT, BRANCH]
  );
  return Number(row.rows[0]?.quantity_on_hand ?? 0);
}

async function assetRow(id: string): Promise<any> {
  return (
    await pool!.query(
      `SELECT status, assigned_type AS "assignedType", assigned_employee_id AS "assignedEmployeeId",
              assigned_employee_name AS "assignedEmployeeName",
              assigned_work_order_id AS "assignedWorkOrderId",
              assigned_customer_id AS "assignedCustomerId",
              to_char(assignment_date_ad, 'YYYY-MM-DD') AS "assignmentDateAD"
         FROM fixed_assets WHERE id = $1`,
      [id]
    )
  ).rows[0];
}

async function serialRow(serial: string): Promise<any> {
  return (
    await pool!.query(
      `SELECT status, holder_employee_id AS "holderEmployeeId", customer_id AS "customerId"
         FROM serial_log WHERE lower(trim(device_serial)) = lower(trim($1))`,
      [serial]
    )
  ).rows[0];
}

async function heldQty(): Promise<number> {
  const row = await pool!.query(
    'SELECT COALESCE(SUM(quantity), 0)::int AS held FROM employee_stock_holdings WHERE employee_id = $1',
    [TECH]
  );
  return Number(row.rows[0].held);
}

/** The dispatch payload the Assign Fixed Asset panel sends for a technician. */
function dispatchBody(unit: { tag: string; serial: string }, workOrderId: string) {
  return {
    tagNumber: unit.tag,
    name: 'CAC ONU Router',
    category: 'Equipment',
    branchId: BRANCH,
    acquisitionDateAD: TODAY,
    acquisitionCost: 1000,
    depreciationMethod: 'STRAIGHT_LINE',
    depreciationRatePercent: 15,
    productId: PRODUCT,
    status: 'IN_USE',
    assignedType: 'EMPLOYEE',
    assignedEmployeeId: TECH,
    assignedWorkOrderId: workOrderId,
    deployFromStock: true,
    deviceSerial: unit.serial,
  };
}

/** POST /api/assets as the counter role; the register mints the asset id. */
async function dispatchAsset(
  unit: { tag: string; serial: string },
  workOrderId: string
): Promise<any> {
  const res = await call('/api/assets', dispatcherToken, {
    method: 'POST',
    body: dispatchBody(unit, workOrderId),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.tagNumber, unit.tag);
  assert.ok(res.body.id, 'the register returns the id it minted');
  return res.body;
}

describe('employee asset custody → installation (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  before(async () => {
    await ensureReferenceData(pool!);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'CAC', 'Custody chain branch', 'Kathmandu')`,
      [BRANCH]
    );
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'CAC2', 'Custody chain other branch', 'Kathmandu')`,
      [OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id)
       VALUES ($1, 'CAC-CUST-1', $2, '9800000099', $3)`,
      [CUSTOMER, CUSTOMER_NAME, BRANCH]
    );
    await pool!.query(
      `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
       VALUES ($1, $2, 'x', $3, 'FIELD_TECHNICIAN', $4, ARRAY[$5::text]::text[], 'active')`,
      [TECH_USER.id, TECH_USER.email, TECH_USER.name, BRANCH, BRANCH]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
       VALUES ($1, 'CAC-EMP-1', 'CAC Field Technician', $2, $3, 'Field')`,
      [TECH, BRANCH, TECH_USER.id]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, department)
       VALUES ($1, 'CAC-EMP-2', 'CAC Other Branch Tech', $2, 'Field')`,
      [OTHER_TECH, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO products
         (id, name, sku, category, product_group, unit, cost_price, selling_price,
          requires_serial_tracking, tracking_type, seller_warranty_months)
       VALUES ($1, 'CAC ONU Router', 'CAC-SKU-1', 'CPE', 'Product Item', 'Pcs', 1000, 1500, TRUE, 'SERIAL_MAC_PON', 12)`,
      [PRODUCT]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ($1, $2, $3, 10, 1000, 1)`,
      [`stk-${BRANCH}-${PRODUCT}`, PRODUCT, BRANCH]
    );
    for (const [index, unit] of [UNIT_WEB, UNIT_MOBILE, UNIT_COUNTER].entries()) {
      await pool!.query(
        `INSERT INTO serial_log
           (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, status, source_type, created_at)
         VALUES ($1, $2, $3, NULL, $4, 'CAC ONU Router', $5, 'IN_STOCK', 'PURCHASE', now())`,
        [`cac-sl-${index}`, unit.serial, `CAC-PON-${index}`, PRODUCT, BRANCH]
      );
    }
    // An ACTIVE unit that never went through the POST deploy path. The status
    // PATCH must read its row from PostgreSQL: ASSET-1 removed `assets` from
    // the boot payload the in-memory register used to be fed from.
    await pool!.query(
      `INSERT INTO fixed_assets
         (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs,
          acquisition_cost, depreciation_method, depreciation_rate_percent,
          accumulated_depreciation, net_book_value, status, product_id, device_serial)
       VALUES ('cac-asset-idle', 'CAC-FA-20', 'CAC Idle Unit', 'Equipment', $1, $2, '2083-08-10',
               1000, 'STRAIGHT_LINE', 15, 0, 1000, 'ACTIVE', $3, 'CAC-SN-4')`,
      [BRANCH, TODAY, PRODUCT]
    );
    // The serial that identity follows: an IN_STOCK unit at the branch, so the
    // PATCH dispatch has a register row to move into custody.
    await pool!.query(
      `INSERT INTO serial_log
         (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, status, source_type, created_at)
       VALUES ('cac-sl-4', 'CAC-SN-4', 'CAC-PON-4', NULL, $1, 'CAC ONU Router', $2, 'IN_STOCK', 'PURCHASE', now())`,
      [PRODUCT, BRANCH]
    );
    await pool!.query(
      `INSERT INTO field_work_orders
         (id, work_order_no, branch_id, customer_id, kind, status, technician_id, technician_name,
          scheduled_date_ad, notes, created_by, row_version)
       VALUES ($1, $3, $5, $6, 'INSTALL', 'ASSIGNED', $7, 'CAC Field Technician', $8, '', 'test', 1),
              ($2, $4, $5, $6, 'INSTALL', 'ASSIGNED', $7, 'CAC Field Technician', $8, '', 'test', 1)`,
      [WO_WEB, WO_MOBILE, WO_NUMBER_WEB, WO_NUMBER_MOBILE, BRANCH, CUSTOMER, TECH, TODAY]
    );
    await pool!.query(
      `INSERT INTO field_work_orders
         (id, work_order_no, branch_id, customer_id, kind, status, technician_id, technician_name,
          scheduled_date_ad, notes, created_by, row_version)
       VALUES ($1, $2, $3, $4, 'INSTALL', 'ASSIGNED', $5, 'CAC Other Branch Tech', $6, '', 'test', 1)`,
      [WO_OTHER, WO_NUMBER_OTHER, OTHER_BRANCH, CUSTOMER, OTHER_TECH, TODAY]
    );

    setUsers([DISPATCHER, APPROVER, TECH_USER, AUDITOR, FRONT_DESK, ACCOUNTANT]);
    setPermissionMatrix({
      'assets-manage': {
        INVENTORY_MANAGER: true,
        BRANCH_MANAGER: true,
        ACCOUNTANT: true,
        FIELD_TECHNICIAN: false,
        AUDITOR: false,
        FRONT_DESK: false,
      },
      'assets-view': {
        INVENTORY_MANAGER: true,
        BRANCH_MANAGER: true,
        ACCOUNTANT: true,
        FIELD_TECHNICIAN: false,
        AUDITOR: true,
        FRONT_DESK: false,
      },
      'employee-stock-view': {
        INVENTORY_MANAGER: true,
        BRANCH_MANAGER: true,
        FIELD_TECHNICIAN: true,
        AUDITOR: true,
        FRONT_DESK: true,
      },
      'stock-out': { INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FIELD_TECHNICIAN: true, AUDITOR: false, FRONT_DESK: true },
      'consumable-issue-reverse': { BRANCH_MANAGER: true, INVENTORY_MANAGER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
      'custody-writeoff': { INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FIELD_TECHNICIAN: false, AUDITOR: false },
      // The deploy cell, as the matrix seeds it: the counter and the technician
      // are false, the manager and the dispatcher are true.
      'stock-deploy': {
        INVENTORY_MANAGER: true,
        BRANCH_MANAGER: true,
        FIELD_TECHNICIAN: false,
        AUDITOR: false,
        FRONT_DESK: false,
        ACCOUNTANT: false,
      },
      'field-work-order': { INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FIELD_TECHNICIAN: true, AUDITOR: false },
    } as any);

    const app = createApp();
    registerAllRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        (server as any).closeAllConnections?.();
        server!.close(() => resolve());
      });
    }
    if (pool) {
      await cleanup();
      await pool.end();
    }
    setUsers([]);
    setPermissionMatrix({});
    setUserPermissionOverrides(new Map());
    setUserPermissionSetGrants(new Map());
  });

  async function cleanup() {
    await pool!.query("DELETE FROM warranty_coverages WHERE serial_number LIKE 'CAC-SN-%' OR serial_number LIKE 'CAC-FA-%'");
    await pool!.query("DELETE FROM customer_device_records WHERE device_serial LIKE 'CAC-SN-%'");
    await pool!.query("DELETE FROM fixed_assets WHERE tag_number LIKE 'CAC-FA-%'");
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'CAC-SN-%'");
    await pool!.query("DELETE FROM field_work_orders WHERE work_order_no LIKE 'CAC-WO-%'");
    await pool!.query("DELETE FROM approval_requests WHERE id LIKE 'apr-custody-%'");
    await pool!.query("DELETE FROM employee_stock_movement_serials WHERE device_serial LIKE 'CAC-SN-%'");
    await pool!.query('DELETE FROM employee_stock_movements WHERE employee_id = $1', [TECH]);
    await pool!.query('DELETE FROM employee_stock_holdings WHERE employee_id = $1', [TECH]);
    await pool!.query('DELETE FROM inventory_stock WHERE product_id = $1', [PRODUCT]);
    await pool!.query('DELETE FROM transaction_logs WHERE product_id = $1', [PRODUCT]);
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = $1', [BRANCH]);
    await pool!.query('DELETE FROM document_number_retirements WHERE branch_id = $1', [BRANCH]);
    await purgeAuditLogs(pool!, 'DELETE FROM audit_logs WHERE branch_id = $1', [BRANCH]);
    await pool!.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
    await pool!.query('DELETE FROM employees WHERE id = ANY($1::text[])', [[TECH, OTHER_TECH]]);
    await pool!.query('DELETE FROM users WHERE id = $1', [TECH_USER.id]);
    await pool!.query('DELETE FROM customer_records WHERE id = $1', [CUSTOMER]);
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::text[])', [[BRANCH, OTHER_BRANCH]]);
  }

  test('Assign Fixed Asset dispatches a unit to a technician, once, with the visit', async () => {
    const before = await stockOnHand();
    const asset = await dispatchAsset(UNIT_WEB, WO_WEB);
    assert.equal(await stockOnHand(), before - 1, 'branch stock is deducted exactly once');

    const row = await assetRow(asset.id);
    assert.equal(row.status, 'IN_USE');
    assert.equal(row.assignedType, 'EMPLOYEE');
    assert.equal(row.assignedEmployeeId, TECH);
    assert.equal(row.assignedEmployeeName, 'CAC Field Technician');
    assert.equal(row.assignedWorkOrderId, WO_WEB);
    assert.equal(row.assignedCustomerId, null, 'the customer is named by the visit, not the dispatch');
    assert.equal(row.assignmentDateAD, null, 'no assignment date: nothing may start a warranty yet');

    const serial = await serialRow(UNIT_WEB.serial);
    assert.equal(serial.status, 'IN_CUSTODY');
    assert.equal(serial.holderEmployeeId, TECH);
  });

  test('the technician sees the unit with its customer and visit, on web and phone', async () => {
    const assetId = (
      await pool!.query('SELECT id FROM fixed_assets WHERE tag_number = $1', [UNIT_WEB.tag])
    ).rows[0].id;

    const mine = await call(`/api/employee-stock/assets?employeeId=${TECH}`, techToken);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.headers.get('cache-control'), 'private, no-store');
    const row = mine.body.find((entry: any) => entry.assetId === assetId);
    assert.ok(row, 'the dispatched unit is in My Stock as an asset');
    assert.equal(row.customerName, CUSTOMER_NAME);
    assert.equal(row.workOrderNo, WO_NUMBER_WEB);
    assert.equal(row.deviceSerial, UNIT_WEB.serial);

    const van = await call('/api/v1/workplace/stock', techToken);
    assert.equal(van.status, 200, JSON.stringify(van.body));
    // The contract (`docs/contracts/mobile-v1.md`) promises this shape.
    assert.ok(Array.isArray(van.body.assets), 'the van lists whole units');
    const onPhone = van.body.assets.find((entry: any) => entry.assetId === assetId);
    assert.ok(onPhone, 'the phone sees the unit it was dispatched');
    for (const field of [
      'assetId',
      'tagNumber',
      'productName',
      'deviceSerial',
      'workOrderId',
      'workOrderNo',
      'customerId',
      'customerName',
      'scheduledDateAD',
    ]) {
      assert.ok(field in onPhone, `van asset is missing ${field}`);
    }
    assert.equal(onPhone.customerName, CUSTOMER_NAME);
    assert.equal(onPhone.workOrderNo, WO_NUMBER_WEB);
  });

  test('the web completion installs the unit: asset, serial, device row and warranty in one act', async () => {
    const assetId = (
      await pool!.query('SELECT id FROM fixed_assets WHERE tag_number = $1', [UNIT_WEB.tag])
    ).rows[0].id;
    const before = await stockOnHand();
    const res = await call(`/api/field-work-orders/${WO_WEB}/complete`, approverToken, {
      method: 'POST',
      body: { completionNotes: 'ONU installed and tested', installedAssetId: assetId },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'COMPLETED');
    assert.equal(res.body.installedAsset.customerName, CUSTOMER_NAME);
    assert.equal(res.body.installedAsset.warrantyStartDateAD, TODAY);

    const asset = await assetRow(assetId);
    assert.equal(asset.status, 'ASSIGNED_TO_CUSTOMER');
    assert.equal(asset.assignedType, 'CUSTOMER');
    assert.equal(asset.assignedCustomerId, CUSTOMER);
    assert.equal(asset.assignmentDateAD, TODAY, 'the completion date is the assignment (and warranty) date');
    assert.equal(asset.assignedEmployeeId, null, 'the unit left the technician');
    assert.equal(asset.assignedWorkOrderId, WO_WEB, 'the visit that installed it stays on the record');

    const serial = await serialRow(UNIT_WEB.serial);
    assert.equal(serial.status, 'CUSTOMER_ASSIGNED');
    assert.equal(serial.holderEmployeeId, null);
    assert.equal(serial.customerId, CUSTOMER);

    const cdr = await pool!.query(
      `SELECT status, customer_id AS "customerId", device_serial AS "deviceSerial",
              to_char(issued_date_ad, 'YYYY-MM-DD') AS "issuedDateAD", notes
         FROM customer_device_records WHERE id = $1`,
      [`cdr-asset-${assetId}`]
    );
    assert.equal(cdr.rows[0]?.status, 'RENTAL');
    assert.equal(cdr.rows[0]?.deviceSerial, UNIT_WEB.serial);
    assert.equal(cdr.rows[0]?.issuedDateAD, TODAY);
    assert.match(String(cdr.rows[0]?.notes || ''), new RegExp(UNIT_WEB.tag));

    const coverage = await pool!.query(
      `SELECT coverage_type AS "coverageType", to_char(start_date_ad, 'YYYY-MM-DD') AS "startDateAD",
              start_basis AS "startBasis", is_current AS "isCurrent"
         FROM warranty_coverages
        WHERE serial_number = $1 AND coverage_type = 'SELLER'`,
      [UNIT_WEB.serial]
    );
    assert.equal(coverage.rows.length, 1, 'one seller period for the unit');
    assert.equal(coverage.rows[0].startDateAD, TODAY, 'warranty starts on the installation date');
    assert.equal(coverage.rows[0].startBasis, 'ISSUE_DATE');
    assert.equal(coverage.rows[0].isCurrent, true);

    assert.equal(await stockOnHand(), before, 'installation does not touch branch stock again');

    const mine = await call(`/api/employee-stock/assets?employeeId=${TECH}`, techToken);
    assert.equal(
      mine.body.some((entry: any) => entry.assetId === assetId),
      false,
      'an installed unit leaves the technician custody list'
    );
  });

  test('the mobile completion installs the unit it carried, with the same end state', async () => {
    const minted = await dispatchAsset(UNIT_MOBILE, WO_MOBILE);
    const assetId = minted.id;
    const before = await stockOnHand();

    const res = await call(`/api/v1/workplace/jobs/${WO_MOBILE}/complete`, techToken, {
      method: 'POST',
      body: { baseVersion: 1, notes: 'Installed from the van', serialUsed: UNIT_MOBILE.serial },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.resultStatus, 'CLOSED');
    assert.equal(res.body.installedAssets.length, 1);
    assert.equal(res.body.installedAssets[0].assetId, assetId);
    assert.equal(res.body.installedAssets[0].customerName, CUSTOMER_NAME);
    assert.equal(res.body.installedAssets[0].warrantyStartDateAD, TODAY);

    const asset = await assetRow(assetId);
    assert.equal(asset.status, 'ASSIGNED_TO_CUSTOMER');
    assert.equal(asset.assignedCustomerId, CUSTOMER);
    assert.equal(asset.assignmentDateAD, TODAY);
    assert.equal(asset.assignedEmployeeId, null);

    const serial = await serialRow(UNIT_MOBILE.serial);
    assert.equal(serial.status, 'CUSTOMER_ASSIGNED');
    assert.equal(serial.customerId, CUSTOMER);

    const cdr = await pool!.query('SELECT status FROM customer_device_records WHERE id = $1', [
      `cdr-asset-${assetId}`,
    ]);
    assert.equal(cdr.rows[0]?.status, 'RENTAL');
    const coverage = await pool!.query(
      `SELECT to_char(start_date_ad, 'YYYY-MM-DD') AS "startDateAD"
         FROM warranty_coverages WHERE serial_number = $1 AND coverage_type = 'SELLER'`,
      [UNIT_MOBILE.serial]
    );
    assert.equal(coverage.rows[0]?.startDateAD, TODAY);
    assert.equal(await stockOnHand(), before, 'the install does not deduct stock a second time');
  });

  test('a technician cannot write off held stock; a manager can, and a report waits for one', async () => {
    const issued = await call('/api/employee-stock/issue', approverToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 2, reason: 'Van restock' },
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal(await heldQty(), 2);

    const refused = await call('/api/employee-stock/loss', techToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'Dropped' },
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(await heldQty(), 2, 'a refused write-off changes nothing');

    const reported = await call('/api/employee-stock/loss-report', techToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'Dropped into a drain' },
    });
    assert.equal(reported.status, 201, JSON.stringify(reported.body));
    assert.equal(reported.body.status, 'PENDING');
    assert.equal(await heldQty(), 2, 'reporting is not writing off');

    const approved = await call(
      `/api/approval-requests/${reported.body.requestId}/process`,
      approverToken,
      { method: 'POST', body: { status: 'APPROVED' } }
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(await heldQty(), 1, 'the manager approval executes the LOSS movement');

    const writtenOff = await call('/api/employee-stock/loss', approverToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'Water damage confirmed' },
    });
    assert.equal(writtenOff.status, 201, JSON.stringify(writtenOff.body));
    assert.equal(await heldQty(), 0);
  });

  test('no deploy grant, no shelf departure — the holder, the counter and finance are all refused', async () => {
    const before = await stockOnHand();

    const refusalPaths: Array<[string, string, unknown]> = [
      [
        '/api/employee-stock/issue',
        'issue',
        { employeeId: TECH, productId: PRODUCT, quantity: 1, serials: [UNIT_COUNTER.serial] },
      ],
      ['/api/employee-stock/install', 'install', { assetId: UNIT_MOBILE.id, employeeId: TECH, workOrderId: WO_MOBILE }],
      ['/api/employee-stock/loss', 'loss', { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'x' }],
      ['/api/employee-stock/audit', 'audit', { employeeId: TECH, productId: PRODUCT, countedQuantity: 1 }],
    ];

    // The three /api/assets deployment branches: employee dispatch, POP, customer.
    const deployBranches = [
      dispatchBody({ tag: 'CAC-FA-10', serial: UNIT_COUNTER.serial }, WO_WEB),
      {
        tagNumber: 'CAC-FA-11',
        name: 'CAC ONU Router',
        category: 'Equipment',
        branchId: BRANCH,
        acquisitionDateAD: TODAY,
        acquisitionCost: 100,
        productId: PRODUCT,
        status: 'ASSIGNED_TO_LOCATION',
        assignedType: 'LOCATION',
        assignedLocationId: 'loc-pop-1',
        assignedLocationName: 'CAC POP 1',
        assignmentDateAD: TODAY,
        deployFromStock: true,
        deviceSerial: UNIT_COUNTER.serial,
      },
      {
        tagNumber: 'CAC-FA-12',
        name: 'CAC ONU Router',
        category: 'Equipment',
        branchId: BRANCH,
        acquisitionDateAD: TODAY,
        acquisitionCost: 100,
        productId: PRODUCT,
        status: 'ASSIGNED_TO_CUSTOMER',
        assignedType: 'CUSTOMER',
        assignedCustomerId: CUSTOMER,
        assignedCustomerName: CUSTOMER_NAME,
        assignmentDateAD: TODAY,
        deployFromStock: true,
        deviceSerial: UNIT_COUNTER.serial,
        sellerWarrantyCovered: false,
      },
    ];

    for (const [label, token] of [
      ['technician', techToken],
      ['front desk', frontDeskToken],
      ['accountant', accountantToken],
    ] as const) {
      for (const [path, name, payload] of refusalPaths) {
        const res = await call(path, token, { method: 'POST', body: payload });
        assert.equal(res.status, 403, `${label} must be refused by ${name}`);
      }
      for (const body of deployBranches) {
        const res = await call('/api/assets', token, { method: 'POST', body });
        assert.equal(res.status, 403, `${label} must not deploy ${body.status}`);
      }
    }
    assert.equal(await stockOnHand(), before, 'no refused attempt moved a single unit');

    // A PATCH is the Assign Fixed Asset panel's path for a unit that is already
    // in the register. Finance may maintain the register, but not deploy
    // through it (`assets-manage` without `stock-deploy`).
    const patchDispatch = {
      status: 'IN_USE',
      assignedType: 'EMPLOYEE',
      assignedEmployeeId: TECH,
      assignedEmployeeName: 'CAC Field Technician',
      assignedWorkOrderId: WO_WEB,
    };
    const accountantPatch = await call('/api/assets/cac-asset-idle/status', accountantToken, {
      method: 'PATCH',
      body: patchDispatch,
    });
    assert.equal(accountantPatch.status, 403, 'the accountant cannot dispatch through the PATCH');
    assert.equal((await assetRow('cac-asset-idle')).status, 'ACTIVE');
    assert.equal((await serialRow('CAC-SN-4')).status, 'IN_STOCK');

    // Finance keeps the register it already had: reading it, and registering a
    // ledger asset that deploys nothing, both stay allowed.
    const register = await call(`/api/fixed-assets/page?branchId=${BRANCH}`, accountantToken);
    assert.equal(register.status, 200, 'the accountant can still read the asset register');

    const ledgerAsset = await call('/api/assets', accountantToken, {
      method: 'POST',
      body: {
        tagNumber: 'CAC-FA-6',
        name: 'CAC Spare Unit',
        category: 'Equipment',
        branchId: BRANCH,
        acquisitionDateAD: TODAY,
        acquisitionCost: 500,
        status: 'ACTIVE',
      },
    });
    assert.equal(ledgerAsset.status, 201, 'registering a non-deploying asset is not a deployment');
    assert.equal(await stockOnHand(), before, 'and it consumed no stock');

    const techLedger = await call('/api/assets', techToken, {
      method: 'POST',
      body: {
        tagNumber: 'CAC-FA-7',
        name: 'CAC Spare Unit',
        category: 'Equipment',
        branchId: BRANCH,
        acquisitionDateAD: TODAY,
        acquisitionCost: 500,
        status: 'ACTIVE',
      },
    });
    assert.equal(techLedger.status, 403, 'a technician holds no asset-register write either');

    // The PATCH dispatch enforces the same branch rules POST /api/assets does:
    // another branch's technician, or another branch's visit, cannot receive
    // this branch's unit. Both refusals leave the register untouched.
    const foreignEmployee = await call('/api/assets/cac-asset-idle/status', dispatcherToken, {
      method: 'PATCH',
      body: { ...patchDispatch, assignedEmployeeId: OTHER_TECH, assignedEmployeeName: 'CAC Other Branch Tech' },
    });
    assert.equal(foreignEmployee.status, 400, JSON.stringify(foreignEmployee.body));
    assert.match(String(foreignEmployee.body?.message), /not in the branch/i);
    assert.equal((await assetRow('cac-asset-idle')).status, 'ACTIVE');
    assert.equal((await serialRow('CAC-SN-4')).status, 'IN_STOCK');

    const foreignWorkOrder = await call('/api/assets/cac-asset-idle/status', dispatcherToken, {
      method: 'PATCH',
      body: { ...patchDispatch, assignedWorkOrderId: WO_OTHER },
    });
    assert.equal(foreignWorkOrder.status, 400, JSON.stringify(foreignWorkOrder.body));
    assert.match(String(foreignWorkOrder.body?.message), /not in the branch/i);
    assert.equal((await assetRow('cac-asset-idle')).status, 'ACTIVE');
    assert.equal((await serialRow('CAC-SN-4')).status, 'IN_STOCK');

    // The same PATCH as the dispatcher is a real dispatch: the asset row is
    // read from PostgreSQL (the boot payload no longer carries `assets`) and the
    // serial moves into the technician's custody — the state an install leaves.
    const dispatchedPatch = await call('/api/assets/cac-asset-idle/status', dispatcherToken, {
      method: 'PATCH',
      body: patchDispatch,
    });
    assert.equal(dispatchedPatch.status, 200, JSON.stringify(dispatchedPatch.body));
    const idleDispatched = await assetRow('cac-asset-idle');
    assert.equal(idleDispatched.status, 'IN_USE');
    assert.equal(idleDispatched.assignedType, 'EMPLOYEE');
    assert.equal(idleDispatched.assignedEmployeeId, TECH);
    assert.equal(idleDispatched.assignedWorkOrderId, WO_WEB);
    assert.equal((await serialRow('CAC-SN-4')).status, 'IN_CUSTODY');
    assert.equal((await serialRow('CAC-SN-4')).holderEmployeeId, TECH);

    // Returning it through the same PATCH releases the holder and puts the
    // serial back IN_STOCK. This unit never drew branch stock, so nothing is
    // credited — but the custody state must not be left behind.
    const returnedPatch = await call('/api/assets/cac-asset-idle/status', dispatcherToken, {
      method: 'PATCH',
      body: { status: 'ACTIVE', assignmentNotes: 'Returned by the technician' },
    });
    assert.equal(returnedPatch.status, 200, JSON.stringify(returnedPatch.body));
    assert.equal((await assetRow('cac-asset-idle')).status, 'ACTIVE');
    assert.equal((await serialRow('CAC-SN-4')).status, 'IN_STOCK');
    assert.equal((await serialRow('CAC-SN-4')).holderEmployeeId, null);
    assert.equal(await stockOnHand(), before, 'a non-stock asset credits nothing on return');

    // The manager path still reaches the shared install service (which refuses
    // this already-installed unit on its own merits, not on permissions).
    const managerInstall = await call('/api/employee-stock/install', approverToken, {
      method: 'POST',
      body: { assetId: UNIT_MOBILE.id, employeeId: TECH, workOrderId: WO_MOBILE },
    });
    assert.notEqual(managerInstall.status, 403, 'the manager deploy path is open');
    assert.ok(managerInstall.status >= 400, 'and the service still refuses an unheld unit');
  });

  test('a per-user grant or a permission-set grant opens deploy, and removing it closes it', async () => {
    const before = await stockOnHand();

    setUserPermissionOverrides(
      new Map([[TECH_USER.id, new Map([['stock-deploy', { effect: 'grant' as const, expiresAt: null }]])]])
    );
    const granted = await call('/api/employee-stock/issue', techToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'granted once' },
    });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    assert.equal(await stockOnHand(), before - 1, 'the granted deploy did move a unit');

    setUserPermissionOverrides(new Map());
    const revoked = await call('/api/employee-stock/issue', techToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'after revoke' },
    });
    assert.equal(revoked.status, 403, 'removing the grant closes the path again');
    assert.equal(await stockOnHand(), before - 1, 'and the refused attempt moved nothing');

    // A permission set is the other matrix-adjacent grant path the resolver
    // honours; it must open the same gate for the counter, and close with it.
    setUserPermissionSetGrants(new Map([[FRONT_DESK.id, new Set(['stock-deploy'])]]));
    const deskGranted = await call('/api/employee-stock/issue', frontDeskToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'set grant' },
    });
    assert.equal(deskGranted.status, 201, JSON.stringify(deskGranted.body));

    setUserPermissionSetGrants(new Map());
    const deskRevoked = await call('/api/employee-stock/issue', frontDeskToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1 },
    });
    assert.equal(deskRevoked.status, 403, 'the set grant was the only thing opening it');
  });

  test('executing a custody loss needs the deploy authority, not just the approval role', async () => {
    const issued = await call('/api/employee-stock/issue', approverToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'approval test' },
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const before = await heldQty();

    const reported = await call('/api/employee-stock/loss-report', techToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'cracked casing' },
    });
    assert.equal(reported.status, 201, JSON.stringify(reported.body));

    // The auditor may process approvals by role list but holds neither
    // `custody-writeoff` nor `stock-deploy`, so the matrix refuses execution.
    const auditor = await call(
      `/api/approval-requests/${reported.body.requestId}/process`,
      auditorToken,
      { method: 'POST', body: { status: 'APPROVED' } }
    );
    assert.equal(auditor.status, 403, JSON.stringify(auditor.body));
    assert.equal(await heldQty(), before, 'a refused approval executes nothing');

    const manager = await call(
      `/api/approval-requests/${reported.body.requestId}/process`,
      approverToken,
      { method: 'POST', body: { status: 'APPROVED' } }
    );
    assert.equal(manager.status, 200, JSON.stringify(manager.body));
    assert.equal(await heldQty(), before - 1, 'the manager executes the write-off once');
  });

  test('a read-only auditor sees My Stock but can neither install a unit nor file a loss claim', async () => {
    const mine = await call(`/api/employee-stock/assets?employeeId=${TECH}`, auditorToken);
    assert.equal(mine.status, 200, 'the audit read grant is intact');

    const install = await call('/api/employee-stock/install', auditorToken, {
      method: 'POST',
      body: { assetId: UNIT_WEB.id, employeeId: TECH, workOrderId: WO_WEB },
    });
    assert.equal(install.status, 403, 'installing moves an asset: the read grant is not enough');

    const report = await call('/api/employee-stock/loss-report', auditorToken, {
      method: 'POST',
      body: { employeeId: TECH, productId: PRODUCT, quantity: 1, reason: 'audit test' },
    });
    assert.equal(report.status, 403, 'filing a stock claim is a stock control, not a read');
  });

  test('the permission matrix, not a hidden role list, decides who may deploy an asset', async () => {
    // A branch manager holds `assets-manage` in the matrix but used to be
    // refused by the legacy `/assets` role list — the two must agree.
    const manager = await call('/api/assets', approverToken, {
      method: 'POST',
      body: {
        tagNumber: 'CAC-FA-4',
        name: 'CAC Spare Unit',
        category: 'Equipment',
        branchId: BRANCH,
        acquisitionDateAD: TODAY,
        acquisitionCost: 500,
        status: 'ACTIVE',
      },
    });
    assert.equal(manager.status, 201, JSON.stringify(manager.body));

    const technician = await call('/api/assets', techToken, {
      method: 'POST',
      body: {
        tagNumber: 'CAC-FA-5',
        name: 'CAC Spare Unit',
        category: 'Equipment',
        branchId: BRANCH,
        acquisitionDateAD: TODAY,
        acquisitionCost: 500,
        status: 'ACTIVE',
      },
    });
    assert.equal(technician.status, 403, 'the matrix denies assets-manage to a technician');
  });

  test('a front-desk deploy straight to a customer still behaves as before', async () => {
    const before = await stockOnHand();
    const res = await call('/api/assets', dispatcherToken, {
      method: 'POST',
      body: {
        tagNumber: UNIT_COUNTER.tag,
        name: 'CAC ONU Router',
        category: 'Equipment',
        branchId: BRANCH,
        acquisitionDateAD: TODAY,
        acquisitionCost: 1000,
        depreciationMethod: 'STRAIGHT_LINE',
        depreciationRatePercent: 15,
        productId: PRODUCT,
        status: 'ASSIGNED_TO_CUSTOMER',
        assignedType: 'CUSTOMER',
        assignedCustomerId: CUSTOMER,
        assignedCustomerName: CUSTOMER_NAME,
        assignmentDateAD: TODAY,
        deployFromStock: true,
        deviceSerial: UNIT_COUNTER.serial,
        sellerWarrantyCovered: true,
        sellerWarrantyEndDateAD: SELLER_END,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await stockOnHand(), before - 1);
    const assetId = res.body.id;

    const asset = await assetRow(assetId);
    assert.equal(asset.status, 'ASSIGNED_TO_CUSTOMER');
    assert.equal(asset.assignedCustomerId, CUSTOMER);
    assert.equal(asset.assignmentDateAD, TODAY);
    assert.equal(asset.assignedEmployeeId, null);

    const serial = await serialRow(UNIT_COUNTER.serial);
    assert.equal(serial.status, 'CUSTOMER_ASSIGNED');

    const cdr = await pool!.query(
      `SELECT status, to_char(issued_date_ad, 'YYYY-MM-DD') AS "issuedDateAD"
         FROM customer_device_records WHERE id = $1`,
      [`cdr-asset-${assetId}`]
    );
    assert.equal(cdr.rows[0]?.status, 'RENTAL');
    assert.equal(cdr.rows[0]?.issuedDateAD, TODAY);

    const coverage = await pool!.query(
      `SELECT to_char(start_date_ad, 'YYYY-MM-DD') AS "startDateAD", start_basis AS "startBasis"
         FROM warranty_coverages WHERE serial_number = $1 AND coverage_type = 'SELLER'`,
      [UNIT_COUNTER.serial]
    );
    assert.equal(coverage.rows[0]?.startDateAD, TODAY);
    assert.equal(coverage.rows[0]?.startBasis, 'ISSUE_DATE');
  });
});
