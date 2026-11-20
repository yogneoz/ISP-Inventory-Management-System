/**
 * Offboarding cannot be completed while the employee still holds stock.
 *
 * PROVES, against a real Express app and real PostgreSQL:
 *   1. the offboarding checklist's custody item is derived from the live
 *      holdings on every read (units, products and quantities), for an
 *      employee who holds stock;
 *   2. completing the checklist — with every stored required item already
 *      done — is refused with the typed 409 (`EMPLOYEE_STOCK_HELD`) and
 *      writes nothing: the checklist stays OPEN with no completion stamp,
 *      and no audit row claims a completion;
 *   3. the block is cleared only by the custody API: returning the units makes
 *      the derived item satisfied and the same completion then succeeds;
 *   4. branch scope holds on the completion path — another branch's account
 *      cannot complete (or read) this employee's offboarding.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix, setUsers } from '../server/src/state/runtimeState';

dotenv.config();

const BRANCH = 'OC-TEST-BR';
const OTHER_BRANCH = 'OC-TEST-OTHER';
const EMPLOYEE = 'OC-TEST-EMP';
const PRODUCT = 'OC-TEST-PROD';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (offboarding custody)';

const HR = {
  id: 'oc-hr', email: 'oc-hr@example.com', name: 'HR Manager',
  role: 'BRANCH_MANAGER', branchId: BRANCH, allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;
const OUTSIDER = {
  id: 'oc-outsider', email: 'oc-outsider@example.com', name: 'Other Branch',
  role: 'BRANCH_MANAGER', branchId: OTHER_BRANCH, allowedBranchIds: [OTHER_BRANCH], canSwitchUser: false,
} as any;

let server: http.Server | null = null;
let port = 0;

async function call(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

const post = (path: string, token: string, body: unknown) =>
  call(path, token, { method: 'POST', body: JSON.stringify(body) });

async function checklistRow(id: string) {
  const result = await pool!.query(
    'SELECT status, completed_at, completed_by FROM hr_lifecycle_checklists WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

describe('offboarding blocked by issued stock (API)', { skip: skipNoDb }, () => {
  let checklistId = '';

  before(async () => {
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'OC1', 'Offboarding branch', 'Kathmandu')
       ON CONFLICT (id) DO NOTHING`,
      [BRANCH]
    );
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'OC2', 'Other offboarding branch', 'Pokhara')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id) VALUES ($1, 'OC-EMP-1', 'Leaving Tech', $2)
       ON CONFLICT (id) DO NOTHING`,
      [EMPLOYEE, BRANCH]
    );
    await pool!.query(
      `INSERT INTO products (id, sku, name, category, product_group) VALUES ($1, 'OC-PROD-1', 'ONT to return', 'Devices', 'Product Item')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand) VALUES ($1, $2, $3, 10)
       ON CONFLICT (product_id, branch_id) DO UPDATE SET quantity_on_hand = 10`,
      [`stk-${BRANCH.toLowerCase()}-${PRODUCT}`, PRODUCT, BRANCH]
    );
    await pool!.query('DELETE FROM hr_lifecycle_checklists WHERE employee_id = $1', [EMPLOYEE]);
    await pool!.query('DELETE FROM employee_stock_movements WHERE employee_id = $1', [EMPLOYEE]);
    await pool!.query('DELETE FROM employee_stock_holdings WHERE employee_id = $1', [EMPLOYEE]);

    setUsers([HR, OUTSIDER]);
    setPermissionMatrix({
      'hr-employee-view': { BRANCH_MANAGER: true },
      'hr-employee-manage': { BRANCH_MANAGER: true },
      'employee-stock-view': { BRANCH_MANAGER: true },
      'stock-out': { BRANCH_MANAGER: true },
      'consumable-issue-reverse': { BRANCH_MANAGER: true },
    } as any);

    const app = createApp();
    registerAllRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => { (server as any).closeAllConnections?.(); server!.close(() => resolve()); });
    if (pool) {
      await pool.query('DELETE FROM hr_lifecycle_checklists WHERE employee_id = $1', [EMPLOYEE]);
      await pool.query('DELETE FROM employee_stock_movements WHERE employee_id = $1', [EMPLOYEE]);
      await pool.query('DELETE FROM employee_stock_holdings WHERE employee_id = $1', [EMPLOYEE]);
      await pool.query('DELETE FROM inventory_stock WHERE product_id = $1', [PRODUCT]);
      await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
      await pool.query('DELETE FROM employees WHERE id = $1', [EMPLOYEE]);
      await pool.query('DELETE FROM branches WHERE id = ANY($1::text[])', [[BRANCH, OTHER_BRANCH]]);
    }
    setUsers([]);
    setPermissionMatrix({});
  });

  test('the checklist derives its custody item from the live holdings', async () => {
    const token = issueAuthToken(HR);
    const issued = await post('/api/employee-stock/issue', token, {
      employeeId: EMPLOYEE,
      productId: PRODUCT,
      quantity: 2,
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));

    const created = await post('/api/hr/lifecycle-checklists', token, {
      employeeId: EMPLOYEE,
      type: 'OFFBOARDING',
      effectiveDateAD: '2026-11-30',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    checklistId = created.body.id;
    assert.equal(created.body.custody.units, 2);
    assert.equal(created.body.custody.items, 1);
    assert.equal(created.body.custody.products[0].product_name, 'ONT to return');
    assert.equal(created.body.custody.products[0].quantity, 2);
    assert.equal(created.headers.get('cache-control'), 'private, no-store');

    const opened = await call(`/api/hr/lifecycle-checklists/${checklistId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'OPEN' }),
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));

    // Clear every stored required item so the only thing left is custody.
    const detail = await call(`/api/hr/lifecycle-checklists/${checklistId}`, token);
    for (const item of detail.body.items.filter((row: any) => row.required && row.status === 'PENDING')) {
      const done = await post(`/api/hr/lifecycle-checklists/${checklistId}/items/${item.id}/complete`, token, {});
      assert.equal(done.status, 200, JSON.stringify(done.body));
    }
  });

  test('completion is refused with the typed 409 and writes nothing', async () => {
    const token = issueAuthToken(HR);
    const refused = await post(`/api/hr/lifecycle-checklists/${checklistId}/complete`, token, {});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'EMPLOYEE_STOCK_HELD');
    assert.match(refused.body.message, /still issued/);

    const row = await checklistRow(checklistId);
    assert.equal(row.status, 'OPEN', 'a refused completion does not close the checklist');
    assert.equal(row.completed_at, null);
    assert.equal(row.completed_by, null);
    const held = await pool!.query(
      'SELECT COALESCE(SUM(quantity), 0)::int AS units FROM employee_stock_holdings WHERE employee_id = $1',
      [EMPLOYEE]
    );
    assert.equal(held.rows[0].units, 2, 'the refusal left the custody rows untouched');
  });

  test('another branch cannot complete (or read) this offboarding', async () => {
    const outsider = issueAuthToken(OUTSIDER);
    const read = await call(`/api/hr/lifecycle-checklists/${checklistId}`, outsider);
    assert.equal(read.status, 403);
    const complete = await post(`/api/hr/lifecycle-checklists/${checklistId}/complete`, outsider, {});
    assert.equal(complete.status, 403);
  });

  test('returning the units clears the block and the completion succeeds', async () => {
    const token = issueAuthToken(HR);
    const returned = await post('/api/employee-stock/return', token, {
      employeeId: EMPLOYEE,
      productId: PRODUCT,
      quantity: 2,
    });
    assert.equal(returned.status, 201, JSON.stringify(returned.body));

    const detail = await call(`/api/hr/lifecycle-checklists/${checklistId}`, token);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.custody.units, 0);
    assert.deepEqual(detail.body.custody.products, []);

    const completed = await post(`/api/hr/lifecycle-checklists/${checklistId}/complete`, token, {});
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.status, 'COMPLETED');

    const row = await checklistRow(checklistId);
    assert.equal(row.status, 'COMPLETED');
    assert.ok(row.completed_at);
    assert.equal(row.completed_by, 'oc-hr@example.com');
  });
});
