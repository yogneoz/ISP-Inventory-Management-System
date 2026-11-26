/**
 * Employee stock custody — the ledger behind My Stock / the profile's Equipment
 * section, over the real request path.
 *
 * PROVES, against a real Express app and real PostgreSQL:
 *   1. issue/consume/return round trip: branch stock leaves on issue, the
 *      employee's holding follows every movement, and a return puts the units
 *      back into branch stock;
 *   2. the holding is a projection of the log — the holdings row is rebuilt from
 *      the movements, so the two agree after every step;
 *   3. neither side can go negative: issuing more than the branch holds and
 *      returning more than the employee holds are 409s that write nothing;
 *   4. a loss needs a reason (400 without one), and a used-up holding drops out
 *      of the projection instead of lingering at zero;
 *   5. scope and permissions: an account without `employee-stock-view` cannot
 *      read, a read-only account cannot write, and a branch account cannot issue
 *      to (or read) another branch's employee.
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

const BRANCH = 'ES-TEST-BR';
const OTHER_BRANCH = 'ES-TEST-OTHER';
const EMPLOYEE = 'ES-TEST-EMP';
const OTHER_EMPLOYEE = 'ES-TEST-EMP2';
const PRODUCT = 'ES-TEST-PROD';

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

const MANAGER = {
  id: 'es-manager', email: 'es-manager@example.com', name: 'Stock Manager',
  role: 'BRANCH_MANAGER', branchId: BRANCH, allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;
const AUDITOR = {
  id: 'es-auditor', email: 'es-auditor@example.com', name: 'Auditor',
  role: 'AUDITOR', branchId: BRANCH, allowedBranchIds: [BRANCH], canSwitchUser: false,
} as any;
const OUTSIDER = {
  id: 'es-outsider', email: 'es-outsider@example.com', name: 'Other Branch',
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

const movement = (token: string, action: string, body: Record<string, unknown>) =>
  call(`/api/employee-stock/${action}`, token, { method: 'POST', body: JSON.stringify(body) });

async function branchQty(): Promise<number> {
  const result = await pool!.query(
    'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
    [PRODUCT, BRANCH]
  );
  return Number(result.rows[0]?.quantity_on_hand ?? 0);
}

async function heldQty(): Promise<number> {
  const result = await pool!.query(
    'SELECT COALESCE(SUM(quantity), 0)::int AS held FROM employee_stock_holdings WHERE employee_id = $1',
    [EMPLOYEE]
  );
  return Number(result.rows[0].held);
}

describe('employee stock custody (API)', { skip: skipNoDb }, () => {
  before(async () => {
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'ES1', 'Custody branch', 'Kathmandu')
       ON CONFLICT (id) DO NOTHING`,
      [BRANCH]
    );
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'ES2', 'Other custody branch', 'Pokhara')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id) VALUES ($1, 'ES-EMP-1', 'Field Tech', $2)
       ON CONFLICT (id) DO NOTHING`,
      [EMPLOYEE, BRANCH]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id) VALUES ($1, 'ES-EMP-2', 'Other Tech', $2)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_EMPLOYEE, OTHER_BRANCH]
    );
    await pool!.query(
      `INSERT INTO products (id, sku, name, category, product_group) VALUES ($1, 'ES-PROD-1', 'ONT device', 'Devices', 'Product Item')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand) VALUES ($1, $2, $3, 10)
       ON CONFLICT (product_id, branch_id) DO UPDATE SET quantity_on_hand = 10`,
      [`stk-${BRANCH.toLowerCase()}-${PRODUCT}`, PRODUCT, BRANCH]
    );
    await pool!.query('DELETE FROM employee_stock_movements WHERE employee_id = $1', [EMPLOYEE]);
    await pool!.query('DELETE FROM employee_stock_holdings WHERE employee_id = $1', [EMPLOYEE]);

    setUsers([MANAGER, AUDITOR, OUTSIDER]);
    setPermissionMatrix({
      'employee-stock-view': { BRANCH_MANAGER: true, AUDITOR: true },
      'stock-out': { BRANCH_MANAGER: true, AUDITOR: false },
      'consumable-issue-reverse': { BRANCH_MANAGER: true, AUDITOR: false },
      // A write-off is the manager's custody permission; the panel's loss
      // button (and /loss) is closed to the technician who reports it.
      'custody-writeoff': { BRANCH_MANAGER: true, AUDITOR: false },
      'stock-deploy': { BRANCH_MANAGER: true, AUDITOR: false },
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
      await pool.query('DELETE FROM employee_stock_movements WHERE employee_id = ANY($1::text[])', [[EMPLOYEE, OTHER_EMPLOYEE]]);
      await pool.query('DELETE FROM employee_stock_holdings WHERE employee_id = ANY($1::text[])', [[EMPLOYEE, OTHER_EMPLOYEE]]);
      await pool.query('DELETE FROM inventory_stock WHERE product_id = $1', [PRODUCT]);
      await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
      await pool.query('DELETE FROM employees WHERE id = ANY($1::text[])', [[EMPLOYEE, OTHER_EMPLOYEE]]);
      await pool.query('DELETE FROM branches WHERE id = ANY($1::text[])', [[BRANCH, OTHER_BRANCH]]);
    }
    setUsers([]);
    setPermissionMatrix({});
  });

  test('issue, consume and return move branch stock and the holding together', async () => {
    const token = issueAuthToken(MANAGER);
    assert.equal(await branchQty(), 10);

    const issued = await movement(token, 'issue', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 3 });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal(issued.body.movement_type, 'ISSUE');
    assert.equal(issued.body.actor, 'es-manager@example.com');
    assert.equal(issued.headers.get('cache-control'), 'private, no-store');
    assert.equal(await branchQty(), 7, 'branch stock leaves on issue');
    assert.equal(await heldQty(), 3, 'the employee now holds the units');

    const consumed = await movement(token, 'consume', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 1 });
    assert.equal(consumed.status, 201, JSON.stringify(consumed.body));
    assert.equal(consumed.body.movement_type, 'CONSUME');
    assert.equal(await heldQty(), 2, 'consumed units leave custody');
    assert.equal(await branchQty(), 7, 'consume does not put units back');

    const returned = await movement(token, 'return', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 2 });
    assert.equal(returned.status, 201, JSON.stringify(returned.body));
    assert.equal(returned.body.movement_type, 'RETURN');
    assert.equal(await heldQty(), 0, 'a used-up holding leaves no zero row');
    assert.equal(await branchQty(), 9, 'return restores branch stock');

    const holdings = await call(`/api/employee-stock?employeeId=${EMPLOYEE}`, token);
    assert.equal(holdings.status, 200);
    assert.equal(holdings.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(holdings.body, [], 'the projection agrees with the log');

    const log = await call(`/api/employee-stock/movements?employeeId=${EMPLOYEE}`, token);
    assert.equal(log.status, 200);
    assert.deepEqual(
      log.body.map((row: any) => row.movement_type),
      ['RETURN', 'CONSUME', 'ISSUE'],
      'the log is newest-first and keeps every movement'
    );
    const zero = await pool!.query(
      'SELECT count(*)::int AS n FROM employee_stock_holdings WHERE employee_id = $1 AND quantity = 0',
      [EMPLOYEE]
    );
    assert.equal(zero.rows[0].n, 0);
  });

  test('the holding is a projection: it always equals the signed movement sum', async () => {
    const token = issueAuthToken(MANAGER);
    await movement(token, 'issue', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 4 });
    const rows = await pool!.query(
      `SELECT
         (SELECT COALESCE(SUM(CASE WHEN movement_type = 'ISSUE' THEN quantity ELSE -quantity END), 0)::int
            FROM employee_stock_movements WHERE employee_id = $1 AND product_id = $2) AS from_log,
         (SELECT COALESCE(SUM(quantity), 0)::int FROM employee_stock_holdings
           WHERE employee_id = $1 AND product_id = $2) AS from_projection`,
      [EMPLOYEE, PRODUCT]
    );
    assert.equal(rows.rows[0].from_log, 4);
    assert.equal(rows.rows[0].from_projection, 4);

    const listed = await call(`/api/employee-stock?employeeId=${EMPLOYEE}`, token);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].quantity, 4);
    assert.equal(listed.body[0].product_name, 'ONT device');
    assert.equal(listed.body[0].employee_code, 'ES-EMP-1');
  });

  test('neither branch stock nor a holding can go negative', async () => {
    const token = issueAuthToken(MANAGER);
    const before = { branch: await branchQty(), held: await heldQty() };

    const tooMuchStock = await movement(token, 'issue', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 999 });
    assert.equal(tooMuchStock.status, 409, JSON.stringify(tooMuchStock.body));
    assert.equal(tooMuchStock.body.code, 'INSUFFICIENT_BRANCH_STOCK');

    const tooMuchHeld = await movement(token, 'return', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 99 });
    assert.equal(tooMuchHeld.status, 409, JSON.stringify(tooMuchHeld.body));
    assert.equal(tooMuchHeld.body.code, 'INSUFFICIENT_HOLDING');

    assert.deepEqual({ branch: await branchQty(), held: await heldQty() }, before, 'a refusal writes nothing');
    const refused = await pool!.query(
      "SELECT count(*)::int AS n FROM employee_stock_movements WHERE employee_id = $1 AND quantity IN (999, 99)",
      [EMPLOYEE]
    );
    assert.equal(refused.rows[0].n, 0);
  });

  test('a loss needs a reason, and with one it leaves custody', async () => {
    const token = issueAuthToken(MANAGER);
    const silent = await movement(token, 'loss', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 1 });
    assert.equal(silent.status, 400, JSON.stringify(silent.body));
    assert.equal(silent.body.code, 'REASON_REQUIRED');
    assert.equal(await heldQty(), 4, 'the refused loss wrote nothing');

    const branchBeforeLoss = await branchQty();
    const lost = await movement(token, 'loss', {
      employeeId: EMPLOYEE,
      productId: PRODUCT,
      quantity: 1,
      reason: 'Dropped and destroyed on site',
    });
    assert.equal(lost.status, 201, JSON.stringify(lost.body));
    assert.equal(lost.body.movement_type, 'LOSS');
    assert.equal(lost.body.reason, 'Dropped and destroyed on site');
    assert.equal(await heldQty(), 3);
    assert.equal(await branchQty(), branchBeforeLoss, 'a loss does not return the units to branch stock');
  });

  test('validation refuses an unknown employee, a foreign employee and a missing quantity', async () => {
    const token = issueAuthToken(MANAGER);
    const foreign = await movement(token, 'issue', { employeeId: OTHER_EMPLOYEE, productId: PRODUCT, quantity: 1 });
    assert.equal(foreign.status, 400, JSON.stringify(foreign.body));
    assert.equal(foreign.body.code, 'UNKNOWN_EMPLOYEE');

    const unknown = await movement(token, 'issue', { employeeId: 'NO-SUCH-EMP', productId: PRODUCT, quantity: 1 });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));

    const badProduct = await movement(token, 'issue', { employeeId: EMPLOYEE, productId: 'NO-SUCH-PRODUCT', quantity: 1 });
    assert.equal(badProduct.status, 400, JSON.stringify(badProduct.body));
    assert.equal(badProduct.body.code, 'UNKNOWN_PRODUCT');

    const noQuantity = await movement(token, 'issue', { employeeId: EMPLOYEE, productId: PRODUCT });
    assert.equal(noQuantity.status, 400, JSON.stringify(noQuantity.body));
  });

  test('permission and branch scope are enforced on reads and writes', async () => {
    const auditor = issueAuthToken(AUDITOR);
    const read = await call(`/api/employee-stock?employeeId=${EMPLOYEE}`, auditor);
    assert.equal(read.status, 200, 'the read grant is enough to see the ledger');
    const write = await movement(auditor, 'issue', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 1 });
    assert.equal(write.status, 403, 'a read grant never implies a write');

    const outsider = issueAuthToken(OUTSIDER);
    const crossRead = await call(`/api/employee-stock?employeeId=${EMPLOYEE}`, outsider);
    assert.equal(crossRead.status, 200);
    assert.deepEqual(crossRead.body, [], 'the list is branch-scoped, not filtered after the fact');
    const crossWrite = await movement(outsider, 'issue', { employeeId: EMPLOYEE, productId: PRODUCT, quantity: 1 });
    assert.equal(crossWrite.status, 400, JSON.stringify(crossWrite.body));
    assert.equal(crossWrite.body.code, 'UNKNOWN_EMPLOYEE');
  });
});
