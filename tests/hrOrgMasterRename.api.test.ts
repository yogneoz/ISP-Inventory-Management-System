/**
 * Org masters ↔ employees: the catalogue link survives a rename.
 *
 * Employees keep the department text they were saved with (payroll history and
 * printed documents read it) and also store the catalogue id. That id is what
 * the Org Masters employee list filters on, so renaming a master must not
 * detach its people. This suite proves the whole chain over real HTTP against
 * PostgreSQL:
 *
 *   1. creating an employee with a department name resolves the id,
 *   2. `GET /api/employees?departmentId=` finds that employee,
 *   3. renaming the master leaves the employee listed under the same id,
 *   4. the employee's stored text is untouched by the rename,
 *   5. the grouped tab headcount grows by exactly one.
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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH_ID = 'org-link-test-branch';
const EMPLOYEE_PREFIX = 'ORG-LINK-';

const ADMIN = {
  id: 'org-link-admin',
  email: 'org-link-admin@example.com',
  name: 'Org Link Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('org masters keep their employees across a rename', { skip: skipNoDb }, () => {
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
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  const get = (path: string) => request('GET', path);
  const post = (path: string, body: unknown) => request('POST', path, body);
  const patch = (path: string, body: unknown) => request('PATCH', path, body);

  async function cleanup() {
    if (!pool) return;
    await pool.query(`DELETE FROM employees WHERE employee_code LIKE '${EMPLOYEE_PREFIX}%'`);
    await pool.query(`DELETE FROM hr_org_masters WHERE code IN ('OL-OPS')`);
    await pool.query('DELETE FROM branches WHERE id = $1', [BRANCH_ID]);
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'ORGLNK', 'Org Link Test Branch', 'Test')`,
      [BRANCH_ID]
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

  test('a renamed department still lists its employees through the catalogue id', async () => {
    const beforeCounts = await get('/api/hr/org-masters/headcounts');
    assert.equal(beforeCounts.status, 200, JSON.stringify(beforeCounts.json));

    const createdMaster = await post('/api/hr/org-masters', {
      kind: 'DEPARTMENT',
      name: 'Org Link Operations',
      code: 'OL-OPS',
    });
    assert.equal(createdMaster.status, 201, JSON.stringify(createdMaster.json));
    const department = createdMaster.json;

    const employeeCode = EMPLOYEE_PREFIX + '1';
    const createdEmployee = await post('/api/employees', {
      employeeCode,
      name: 'Org Link Employee',
      branchId: BRANCH_ID,
      department: 'Org Link Operations',
    });
    assert.equal(createdEmployee.status, 201, JSON.stringify(createdEmployee.json));
    assert.equal(
      createdEmployee.json.departmentId,
      department.id,
      'the employee resolves the catalogue id from the stored department text'
    );

    const beforeRename = await get('/api/employees?departmentId=' + encodeURIComponent(department.id));
    assert.equal(beforeRename.status, 200, JSON.stringify(beforeRename.json));
    assert.deepEqual(
      beforeRename.json.map((row: any) => row.employeeCode),
      [employeeCode],
      'the id filter lists the employee before the rename'
    );

    const renamed = await patch('/api/hr/org-masters/' + encodeURIComponent(department.id), {
      name: 'Org Link Operations Renamed',
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    assert.equal(renamed.json.name, 'Org Link Operations Renamed');

    const afterRename = await get('/api/employees?departmentId=' + encodeURIComponent(department.id));
    assert.equal(afterRename.status, 200, JSON.stringify(afterRename.json));
    assert.deepEqual(
      afterRename.json.map((row: any) => row.employeeCode),
      [employeeCode],
      'the renamed department still owns its employee'
    );
    assert.equal(
      afterRename.json[0].department,
      'Org Link Operations',
      "the employee's stored text is history and must not be rewritten by a rename"
    );

    const afterCounts = await get('/api/hr/org-masters/headcounts');
    assert.equal(afterCounts.status, 200, JSON.stringify(afterCounts.json));
    assert.equal(
      afterCounts.json.DEPARTMENT,
      beforeCounts.json.DEPARTMENT + 1,
      'the grouped headcount includes the linked employee'
    );
  });
});
