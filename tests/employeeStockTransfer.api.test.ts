/**
 * Employee custody transfer — the movement the CHECK reserved and no endpoint
 * wrote, now with the policy the parked item was waiting for.
 *
 * Pin:
 *   1. issuing 5 units then transferring 3 moves custody (A 5→2, B 0→3) in one
 *      transaction, and neither person's branch stock changes;
 *   2. the two appends share a transfer group, name the other person, and carry
 *      the reason;
 *   3. crossing branches is refused with the remedy named (409
 *      CROSS_BRANCH_TRANSFER) and writes nothing;
 *   4. transferring more than the giver holds is a 409 and leaves both
 *      projections untouched; a transfer to oneself is a 400, and a missing
 *      reason is a 400;
 *   5. the roster the custody screen picks people from is readable with
 *      `employee-stock-view` alone (the branch manager who issues and
 *      transfers does not hold `hr-employee-view`), stays branch-scoped, and
 *      is refused to a role without the custody view.
 */
import { purgeAuditLogs } from './support/purgeAuditLogs';
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
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (custody writes)';

const BRANCH = 'cst-test-branch';
const OTHER_BRANCH = 'cst-test-branch-2';
const PRODUCT = 'cst-test-product';
const EMP_A = 'cst-test-emp-a';
const EMP_B = 'cst-test-emp-b';
const EMP_C = 'cst-test-emp-c';

const MANAGER = {
  id: 'cst-test-user', email: 'cst-test@example.com', name: 'Custody Manager',
  role: 'BRANCH_MANAGER', branchId: BRANCH, allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;

describe('employee stock transfer (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(MANAGER);

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, auth: string = token) {
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
      /* tolerated */
    }
    return { status: res.status, json };
  }

  async function holdings(employeeId: string): Promise<number> {
    const rows = await pool!.query(
      `SELECT quantity FROM employee_stock_holdings WHERE employee_id = $1 AND product_id = $2`,
      [employeeId, PRODUCT]
    );
    return Number(rows.rows[0]?.quantity || 0);
  }

  async function cleanup() {
    await pool!.query("DELETE FROM employee_stock_holdings WHERE branch_id = ANY($1::text[])", [[BRANCH, OTHER_BRANCH]]);
    await pool!.query("DELETE FROM employee_stock_movements WHERE branch_id = ANY($1::text[])", [[BRANCH, OTHER_BRANCH]]);
    await pool!.query("DELETE FROM inventory_stock WHERE product_id = $1", [PRODUCT]);
    await pool!.query("DELETE FROM products WHERE id = $1", [PRODUCT]);
    await pool!.query("UPDATE employees SET user_id = NULL WHERE branch_id = ANY($1::text[])", [[BRANCH, OTHER_BRANCH]]);
    await pool!.query("DELETE FROM employees WHERE branch_id = ANY($1::text[])", [[BRANCH, OTHER_BRANCH]]);
    await pool!.query("DELETE FROM users WHERE id LIKE 'cst-test%'");
    await pool!.query("DELETE FROM branches WHERE id = ANY($1::text[])", [[BRANCH, OTHER_BRANCH]]);
    await purgeAuditLogs(pool!, "DELETE FROM audit_logs WHERE branch_id = ANY($1::text[])", [[BRANCH, OTHER_BRANCH]]);
  }

  before(async () => {
    await cleanup();
    const { ensurePostgresConnection } = await import('../server/db');
    assert.equal(await ensurePostgresConnection(), true, 'the dev database must be reachable');
    const group = await pool!.query('SELECT name FROM product_groups ORDER BY sort_order ASC LIMIT 1');
    assert.ok(group.rows[0], 'the chart needs at least one product group');
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'CST1', 'Custody Test', 'Test'), ($2, 'CST2', 'Custody Other', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
       VALUES ($1, $2, 'x', $3, 'BRANCH_MANAGER', $4, ARRAY[$4::varchar]::text[], 'active')`,
      [MANAGER.id, MANAGER.email, MANAGER.name, BRANCH]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
       VALUES ($1, 'CST-A', 'Custody A', $4, $6, 'Field'),
              ($2, 'CST-B', 'Custody B', $4, NULL, 'Field'),
              ($3, 'CST-C', 'Custody C', $5, NULL, 'Field')`,
      [EMP_A, EMP_B, EMP_C, BRANCH, OTHER_BRANCH, MANAGER.id]
    );
    await pool!.query(
      `INSERT INTO products (id, sku, name, category, product_group, unit)
       VALUES ($1, 'CST-SKU', 'Custody product', 'Test', $2, 'Pcs')`,
      [PRODUCT, group.rows[0].name]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty)
       VALUES ('cst-test-stock', $1, $2, 20, 0)`,
      [PRODUCT, BRANCH]
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
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('a transfer moves custody person to person inside one branch', async () => {
    const issued = await request('POST', '/api/employee-stock/issue', {
      employeeId: EMP_A,
      productId: PRODUCT,
      branchId: BRANCH,
      quantity: 5,
      reason: 'Van stock for the day',
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    assert.equal(await holdings(EMP_A), 5);

    const stockBefore = await pool!.query(
      'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      [PRODUCT, BRANCH]
    );

    const transferred = await request('POST', '/api/employee-stock/transfer', {
      fromEmployeeId: EMP_A,
      toEmployeeId: EMP_B,
      productId: PRODUCT,
      quantity: 3,
      reason: 'Handover before the night shift',
    });
    assert.equal(transferred.status, 201, JSON.stringify(transferred.json));
    assert.match(transferred.json.transferGroupId, /^[0-9a-f-]{36}$/);
    assert.equal(transferred.json.from.movement_type, 'TRANSFER_OUT');
    assert.equal(transferred.json.to.movement_type, 'TRANSFER_IN');
    assert.equal(transferred.json.from.counterparty_employee_id, EMP_B);
    assert.equal(transferred.json.to.counterparty_employee_id, EMP_A);
    assert.equal(transferred.json.from.transfer_group_id, transferred.json.transferGroupId);
    assert.equal(transferred.json.to.transfer_group_id, transferred.json.transferGroupId);
    assert.match(transferred.json.from.reason, /Handover/);

    assert.equal(await holdings(EMP_A), 2);
    assert.equal(await holdings(EMP_B), 3);

    const stockAfter = await pool!.query(
      'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      [PRODUCT, BRANCH]
    );
    assert.equal(
      Number(stockAfter.rows[0].quantity_on_hand),
      Number(stockBefore.rows[0].quantity_on_hand),
      'a transfer between two people never touches branch stock'
    );

    const log = await request('GET', `/api/employee-stock/movements?employeeId=${EMP_B}`);
    assert.equal(log.status, 200);
    assert.equal(log.json[0].movement_type, 'TRANSFER_IN');
    assert.equal(log.json[0].counterparty_name, 'Custody A');
  });

  test('crossing branches is refused with the remedy and writes nothing', async () => {
    const refused = await request('POST', '/api/employee-stock/transfer', {
      fromEmployeeId: EMP_A,
      toEmployeeId: EMP_C,
      productId: PRODUCT,
      quantity: 1,
      reason: 'Wrong branch on purpose',
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'CROSS_BRANCH_TRANSFER');
    assert.match(refused.json.message, /return the units to the source branch/);
    assert.equal(await holdings(EMP_A), 2);
    assert.equal(await holdings(EMP_C), 0);
  });

  test('over-transfer, self-transfer and a missing reason are refused without writes', async () => {
    const tooMany = await request('POST', '/api/employee-stock/transfer', {
      fromEmployeeId: EMP_A,
      toEmployeeId: EMP_B,
      productId: PRODUCT,
      quantity: 99,
      reason: 'More than I hold',
    });
    assert.equal(tooMany.status, 409, JSON.stringify(tooMany.json));
    assert.equal(tooMany.json.code, 'INSUFFICIENT_HOLDING');
    assert.equal(await holdings(EMP_A), 2);
    assert.equal(await holdings(EMP_B), 3);

    const self = await request('POST', '/api/employee-stock/transfer', {
      fromEmployeeId: EMP_A,
      toEmployeeId: EMP_A,
      productId: PRODUCT,
      quantity: 1,
      reason: 'Mistake in the dialog',
    });
    assert.equal(self.status, 400, JSON.stringify(self.json));
    assert.equal(self.json.code, 'SAME_EMPLOYEE');

    const noReason = await request('POST', '/api/employee-stock/transfer', {
      fromEmployeeId: EMP_A,
      toEmployeeId: EMP_B,
      productId: PRODUCT,
      quantity: 1,
    });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.json));
    assert.equal(noReason.json.code, 'REASON_REQUIRED');

    const movements = await pool!.query(
      "SELECT count(*)::int AS n FROM employee_stock_movements WHERE transfer_group_id IS NOT NULL AND branch_id = $1",
      [BRANCH]
    );
    assert.equal(movements.rows[0].n, 2, 'only the successful transfer wrote rows');
  });

  test('the custody roster is readable with employee-stock-view alone', async () => {
    // Issuing to a person and transferring between two people both need a
    // recipient list. Reading it through /api/employees demanded
    // hr-employee-view, which the branch manager who owns custody does not hold.
    const roster = await request('GET', '/api/employee-stock/employees');
    assert.equal(roster.status, 200, JSON.stringify(roster.json));
    const ids = (roster.json as any[]).map((row) => row.id);
    assert.ok(ids.includes(EMP_A), 'the branch roster names the employee who holds units');
    assert.ok(ids.includes(EMP_B), 'and the one who holds nothing yet — that is who a transfer is for');
    assert.ok(!ids.includes(EMP_C), "another branch's employee must not be listed");

    const accountant = issueAuthToken({
      ...MANAGER,
      id: 'cst-test-acct',
      email: 'cst-test-acct@example.com',
      role: 'ACCOUNTANT',
    } as any);
    const denied = await request('GET', '/api/employee-stock/employees', undefined, accountant);
    assert.equal(denied.status, 403, 'without employee-stock-view the roster is refused');
  });
});
