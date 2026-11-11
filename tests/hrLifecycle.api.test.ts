/**
 * Phase 4 onboarding/offboarding API — real HTTP + PostgreSQL.
 *
 * The fixture links employees to user accounts and assigns fixed assets before
 * starting a checklist. It proves the two rules the plan cares about:
 *   1. Offboarding surfaces the employee's real assigned assets and linked
 *      account, and completing those items reconciles both records.
 *   2. A checklist derives its branch from the employee (never the request
 *      body), requires every required item before completion, and locks every
 *      later write once completed.
 *
 * It also exercises branch custody, cross-branch asset refusal, duplicate
 * active checklists, filter refusal, and the audit trail.
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
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 2000,
    });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BRANCH_A = 'hr-life-br-a';
const BRANCH_B = 'hr-life-br-b';

const MANAGER_A = {
  id: 'hr-life-user-manager-a',
  email: 'hr-life-manager-a@example.com',
  name: 'Lifecycle Manager A',
  role: 'HR_MANAGER',
  branchId: BRANCH_A,
  allowedBranchIds: [BRANCH_A],
  canSwitchUser: false,
} as any;

const MANAGER_B = {
  id: 'hr-life-user-manager-b',
  email: 'hr-life-manager-b@example.com',
  name: 'Lifecycle Manager B',
  role: 'HR_MANAGER',
  branchId: BRANCH_B,
  allowedBranchIds: [BRANCH_B],
  canSwitchUser: false,
} as any;

describe('HR lifecycle API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const managerAToken = issueAuthToken(MANAGER_A);
  const managerBToken = issueAuthToken(MANAGER_B);
  let employeeA1: any;
  let employeeA2: any;
  let employeeB: any;
  let onboardingId = '';
  let offboardingId = '';
  let onboardingAssetId = '';
  let assignedAssetId = '';
  let assignedAssetId2 = '';
  let inactiveUserId = '';
  let activeUserId = '';

  async function cleanup() {
    await pool!.query('DELETE FROM hr_lifecycle_checklists WHERE branch_id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
    await pool!.query('DELETE FROM fixed_assets WHERE id LIKE $1', ['hr-life-asset-%']);
    await pool!.query(
      'DELETE FROM employees WHERE branch_id = ANY($1::varchar[]) AND employee_code LIKE $2',
      [[BRANCH_A, BRANCH_B], 'LIFE-%']
    );
    await pool!.query('DELETE FROM users WHERE id LIKE $1', ['hr-life-user-%']);
    await pool!.query('DELETE FROM audit_logs WHERE branch_id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
  }

  async function request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    auth: string | null,
    payload?: unknown
  ) {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bearer ${auth}`;
    let body: string | undefined;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON errors are asserted by status/message */
    }
    return { status: res.status, json, headers: res.headers, text };
  }

  function employeeBody(code: string, branchId: string, userId?: string) {
    return {
      employeeCode: code,
      name: `Lifecycle Employee ${code}`,
      branchId,
      department: 'Operations',
      designation: 'Technician',
      joiningDateAD: '2026-01-01',
      monthlySalary: 50000,
      ...(userId ? { userId } : {}),
    };
  }

  async function insertAsset(input: {
    id: string;
    tag: string;
    branchId: string;
    status: string;
    assignedEmployeeId?: string | null;
    assignedEmployeeName?: string | null;
  }) {
    await pool!.query(
      `INSERT INTO fixed_assets (
         id, tag_number, name, category, branch_id,
         acquisition_date_ad, acquisition_date_bs, acquisition_cost, net_book_value,
         status, assigned_type, assigned_employee_id, assigned_employee_name,
         assignment_date_ad, assignment_date_bs, is_demo
       ) VALUES ($1, $2, $3, 'Equipment', $4,
         '2025-07-17', '2082-04-01 BS', 1000, 900,
         $5, $6, $7, $8, $9, $10, FALSE)`,
      [
        input.id,
        input.tag,
        `Asset ${input.tag}`,
        input.branchId,
        input.status,
        input.assignedEmployeeId ? 'EMPLOYEE' : null,
        input.assignedEmployeeId || null,
        input.assignedEmployeeName || null,
        input.assignedEmployeeId ? '2026-10-01' : null,
        input.assignedEmployeeId ? '2083-06-15 BS' : null,
      ]
    );
  }

  function itemByAction(detail: any, action: string) {
    const item = detail.items.find((row: any) => row.action === action);
    assert.ok(item, `expected a generated ${action} item`);
    return item;
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'LFA', 'Lifecycle Branch A', 'Test'),
              ($2, 'LFB', 'Lifecycle Branch B', 'Test')`,
      [BRANCH_A, BRANCH_B]
    );
    inactiveUserId = 'hr-life-user-a1-account';
    activeUserId = 'hr-life-user-a2-account';
    for (const [id, email, name, branchId, status] of [
      [inactiveUserId, 'life-a1@example.com', 'Lifecycle A1 Account', BRANCH_A, 'inactive'],
      [activeUserId, 'life-a2@example.com', 'Lifecycle A2 Account', BRANCH_A, 'active'],
    ]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, 'FRONT_DESK', $4, ARRAY[$6]::text[], $5)`,
        [id, email, name, branchId, status, branchId]
      );
    }

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

    employeeA1 = (
      await request(
        'POST',
        '/api/employees',
        managerAToken,
        employeeBody('LIFE-001', BRANCH_A, inactiveUserId)
      )
    ).json;
    employeeA2 = (
      await request(
        'POST',
        '/api/employees',
        managerAToken,
        employeeBody('LIFE-002', BRANCH_A, activeUserId)
      )
    ).json;
    employeeB = (
      await request('POST', '/api/employees', managerBToken, employeeBody('LIFE-003', BRANCH_B))
    ).json;
    assert.ok(employeeA1?.id && employeeA2?.id && employeeB?.id, 'employee fixtures must exist');

    onboardingAssetId = 'hr-life-asset-onboarding';
    assignedAssetId = 'hr-life-asset-assigned';
    await insertAsset({
      id: onboardingAssetId,
      tag: 'LIFE-ASSET-001',
      branchId: BRANCH_A,
      status: 'ACTIVE',
    });
    await insertAsset({
      id: assignedAssetId,
      tag: 'LIFE-ASSET-002',
      branchId: BRANCH_A,
      status: 'IN_USE',
      assignedEmployeeId: employeeA2.id,
      assignedEmployeeName: employeeA2.name,
    });
    assignedAssetId2 = 'hr-life-asset-assigned-2';
    await insertAsset({
      id: assignedAssetId2,
      tag: 'LIFE-ASSET-004',
      branchId: BRANCH_A,
      status: 'IN_USE',
      assignedEmployeeId: employeeA2.id,
      assignedEmployeeName: employeeA2.name,
    });
    await insertAsset({
      id: 'hr-life-asset-customer',
      tag: 'LIFE-ASSET-003',
      branchId: BRANCH_A,
      status: 'ACTIVE',
    });
    await pool!.query(
      `UPDATE fixed_assets
       SET assigned_type = 'CUSTOMER', assigned_customer_id = 'hr-life-customer-1',
           assigned_customer_name = 'Lifecycle Customer'
       WHERE id = 'hr-life-asset-customer'`
    );
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('onboarding derives branch custody, issues an asset, activates the linked account and locks on completion', async () => {
    const created = await request('POST', '/api/hr/lifecycle-checklists', managerAToken, {
      employeeId: employeeA1.id,
      type: 'ONBOARDING',
      effectiveDateAD: '2026-11-01',
      notes: 'Start the network operations induction.',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    onboardingId = created.json.id;
    assert.equal(created.json.branchId, BRANCH_A);
    assert.equal(created.json.branchName, 'Lifecycle Branch A');
    assert.equal(created.json.status, 'DRAFT');
    assert.equal(created.json.checklistType, 'ONBOARDING');
    assert.equal(created.json.checklistNo.startsWith('ONB-'), true);
    assert.equal(created.json.accountStatus, 'inactive');
    assert.equal(created.json.requiredPendingCount, 3);
    itemByAction(created.json, 'ACTIVATE_ACCOUNT');

    const foreignBranchClaim = await request('POST', '/api/hr/lifecycle-checklists', managerAToken, {
      employeeId: employeeA1.id,
      type: 'OFFBOARDING',
      effectiveDateAD: '2026-11-01',
      // A browser cannot move the checklist: the employee's branch wins.
      branchId: BRANCH_B,
    });
    assert.equal(foreignBranchClaim.status, 403);

    const duplicate = await request('POST', '/api/hr/lifecycle-checklists', managerAToken, {
      employeeId: employeeA1.id,
      type: 'ONBOARDING',
      effectiveDateAD: '2026-11-02',
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.json.message, /active onboarding checklist already exists/i);

    const detail = await request(
      'GET',
      `/api/hr/lifecycle-checklists/${onboardingId}`,
      managerAToken
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get('cache-control'), 'private, no-store');
    assert.equal(detail.json.items.length, 3);

    const pendingItem = detail.json.items[0];
    const beforeOpen = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/items/${pendingItem.id}/complete`,
      managerAToken,
      {}
    );
    assert.equal(beforeOpen.status, 409);
    assert.match(beforeOpen.json.message, /open the checklist/i);

    const opened = await request(
      'PATCH',
      `/api/hr/lifecycle-checklists/${onboardingId}`,
      managerAToken,
      { status: 'OPEN' }
    );
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.equal(opened.json.status, 'OPEN');

    const reopenAsDraft = await request(
      'PATCH',
      `/api/hr/lifecycle-checklists/${onboardingId}`,
      managerAToken,
      { status: 'DRAFT' }
    );
    assert.equal(reopenAsDraft.status, 409);
    assert.match(reopenAsDraft.json.message, /cannot return to draft/i);

    const directComplete = await request(
      'PATCH',
      `/api/hr/lifecycle-checklists/${onboardingId}`,
      managerAToken,
      { status: 'COMPLETED' }
    );
    assert.equal(directComplete.status, 400);
    assert.match(directComplete.json.message, /use the complete action/i);

    const crossBranchAsset = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/items`,
      managerAToken,
      {
        category: 'ASSET',
        title: 'Foreign asset',
        assetId: assignedAssetId,
      }
    );
    assert.equal(crossBranchAsset.status, 409);
    assert.match(crossBranchAsset.json.message, /already assigned to another employee/i);

    const customerCustody = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/items`,
      managerAToken,
      {
        category: 'ASSET',
        title: 'Customer-owned asset',
        assetId: 'hr-life-asset-customer',
      }
    );
    assert.equal(customerCustody.status, 409, JSON.stringify(customerCustody.json));
    assert.match(customerCustody.json.message, /customer or location/i);

    const assetItem = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/items`,
      managerAToken,
      {
        category: 'ASSET',
        title: 'Issue onboarding laptop',
        description: 'Issue the standard field laptop.',
        assetId: onboardingAssetId,
      }
    );
    assert.equal(assetItem.status, 201, JSON.stringify(assetItem.json));
    assert.equal(assetItem.json.action, 'ISSUE_ASSET');
    assert.equal(assetItem.json.assetTagNumber, 'LIFE-ASSET-001');

    await pool!.query(
      `UPDATE fixed_assets
       SET assigned_type = 'CUSTOMER', assigned_customer_id = 'hr-life-customer-1',
           assigned_customer_name = 'Lifecycle Customer'
       WHERE id = $1`,
      [onboardingAssetId]
    );
    const custodyChanged = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/items/${assetItem.json.id}/complete`,
      managerAToken,
      {}
    );
    assert.equal(custodyChanged.status, 409, JSON.stringify(custodyChanged.json));
    assert.match(custodyChanged.json.message, /customer or location/i);
    await pool!.query(
      `UPDATE fixed_assets
       SET assigned_type = NULL, assigned_customer_id = NULL, assigned_customer_name = NULL
       WHERE id = $1`,
      [onboardingAssetId]
    );

    const duplicateAssetItem = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/items`,
      managerAToken,
      {
        category: 'ASSET',
        title: 'Issue it twice',
        assetId: onboardingAssetId,
      }
    );
    assert.equal(duplicateAssetItem.status, 409);

    const blockedComplete = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/complete`,
      managerAToken,
      {}
    );
    assert.equal(blockedComplete.status, 409);
    assert.match(blockedComplete.json.message, /required item/i);

    let current = (
      await request('GET', `/api/hr/lifecycle-checklists/${onboardingId}`, managerAToken)
    ).json;
    assert.equal(current.requiredPendingCount, 4);
    for (const item of current.items.filter((row: any) => row.required)) {
      const completed = await request(
        'POST',
        `/api/hr/lifecycle-checklists/${onboardingId}/items/${item.id}/complete`,
        managerAToken,
        {}
      );
      assert.equal(completed.status, 200, `${item.title}: ${JSON.stringify(completed.json)}`);
    }

    const assetRow = (
      await pool!.query(
        `SELECT status, assigned_type, assigned_employee_id, assigned_employee_name,
                assignment_date_ad::text AS assignment_date_ad
         FROM fixed_assets WHERE id = $1`,
        [onboardingAssetId]
      )
    ).rows[0];
    assert.equal(assetRow.status, 'IN_USE');
    assert.equal(assetRow.assigned_type, 'EMPLOYEE');
    assert.equal(assetRow.assigned_employee_id, employeeA1.id);
    assert.equal(assetRow.assigned_employee_name, employeeA1.name);
    assert.equal(assetRow.assignment_date_ad, '2026-11-01');

    const accountRow = (
      await pool!.query('SELECT status FROM users WHERE id = $1', [inactiveUserId])
    ).rows[0];
    assert.equal(accountRow.status, 'active');

    const completed = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/complete`,
      managerAToken,
      {}
    );
    assert.equal(completed.status, 200, JSON.stringify(completed.json));
    assert.equal(completed.json.status, 'COMPLETED');
    assert.equal(completed.json.completedBy, MANAGER_A.email);
    assert.ok(completed.json.completedAt);
    assert.equal(completed.json.requiredPendingCount, 0);
    assert.equal(completed.json.doneCount, 4);

    const lockedPatch = await request(
      'PATCH',
      `/api/hr/lifecycle-checklists/${onboardingId}`,
      managerAToken,
      { notes: 'Should not change' }
    );
    assert.equal(lockedPatch.status, 409);
    assert.match(lockedPatch.json.message, /completed and is locked/i);

    const lockedAdd = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/items`,
      managerAToken,
      { category: 'OTHER', title: 'Late item' }
    );
    assert.equal(lockedAdd.status, 409);

    const lockedItem = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${onboardingId}/items/${pendingItem.id}/complete`,
      managerAToken,
      {}
    );
    assert.equal(lockedItem.status, 409);

    const list = await request(
      'GET',
      `/api/hr/lifecycle-checklists?branchId=${BRANCH_A}&type=ONBOARDING`,
      managerAToken
    );
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'private, no-store');
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].itemCount, 4);
    assert.equal(list.json[0].doneCount, 4);

    const audit = await pool!.query(
      `SELECT action FROM audit_logs
       WHERE branch_id = $1 AND action LIKE 'COMPLETE_HR_LIFECYCLE%'
       ORDER BY timestamp_ad ASC`,
      [BRANCH_A]
    );
    assert.equal(
      audit.rows.filter((row) => row.action === 'COMPLETE_HR_LIFECYCLE_ITEM').length,
      4
    );
    assert.equal(
      audit.rows.filter((row) => row.action === 'COMPLETE_HR_LIFECYCLE_CHECKLIST').length,
      1
    );
  });

  test('offboarding generates and reconciles assigned assets and the linked account, while optional items stay optional', async () => {
    const created = await request('POST', '/api/hr/lifecycle-checklists', managerAToken, {
      employeeId: employeeA2.id,
      type: 'OFFBOARDING',
      effectiveDateAD: '2026-11-15',
      notes: 'Return branch equipment before the exit date.',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    offboardingId = created.json.id;
    assert.equal(created.json.branchId, BRANCH_A);
    assert.equal(created.json.items.length, 5);
    assert.equal(created.json.assetCount, 2);
    assert.equal(created.json.pendingAssetCount, 2);
    assert.equal(
      created.json.items.filter((row: any) => row.action === 'RETURN_ASSET').length,
      2
    );
    itemByAction(created.json, 'RETURN_ASSET');
    itemByAction(created.json, 'DEACTIVATE_ACCOUNT');

    const opened = await request(
      'PATCH',
      `/api/hr/lifecycle-checklists/${offboardingId}`,
      managerAToken,
      { status: 'OPEN' }
    );
    assert.equal(opened.status, 200, JSON.stringify(opened.json));

    const optional = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${offboardingId}/items`,
      managerAToken,
      {
        category: 'OTHER',
        title: 'Optional exit survey',
        required: false,
      }
    );
    assert.equal(optional.status, 201, JSON.stringify(optional.json));
    assert.equal(optional.json.required, false);

    const current = (
      await request('GET', `/api/hr/lifecycle-checklists/${offboardingId}`, managerAToken)
    ).json;
    for (const item of current.items.filter((row: any) => row.required)) {
      const completed = await request(
        'POST',
        `/api/hr/lifecycle-checklists/${offboardingId}/items/${item.id}/complete`,
        managerAToken,
        {}
      );
      assert.equal(completed.status, 200, `${item.title}: ${JSON.stringify(completed.json)}`);
    }

    for (const assetId of [assignedAssetId, assignedAssetId2]) {
      const assetRow = (
        await pool!.query(
          `SELECT status, assigned_type, assigned_employee_id, assignment_date_ad, assignment_notes
           FROM fixed_assets WHERE id = $1`,
          [assetId]
        )
      ).rows[0];
      assert.equal(assetRow.status, 'ACTIVE');
      assert.equal(assetRow.assigned_type, null);
      assert.equal(assetRow.assigned_employee_id, null);
      assert.equal(assetRow.assignment_date_ad, null);
      assert.match(assetRow.assignment_notes, /Returned via lifecycle checklist/);
    }

    const accountRow = (
      await pool!.query('SELECT status FROM users WHERE id = $1', [activeUserId])
    ).rows[0];
    assert.equal(accountRow.status, 'inactive');

    const completed = await request(
      'POST',
      `/api/hr/lifecycle-checklists/${offboardingId}/complete`,
      managerAToken,
      {}
    );
    assert.equal(completed.status, 200, JSON.stringify(completed.json));
    assert.equal(completed.json.status, 'COMPLETED');

    const detail = (
      await request('GET', `/api/hr/lifecycle-checklists/${offboardingId}`, managerAToken)
    ).json;
    assert.equal(detail.itemCount, 6);
    assert.equal(detail.doneCount, 5);
    assert.equal(detail.requiredPendingCount, 0);
    assert.equal(detail.items.find((row: any) => row.required === false).status, 'PENDING');
    assert.equal(detail.availableAssets.length, 0);
  });

  test('branch custody refuses foreign reads/writes and cross-branch asset reconciliation', async () => {
    const foreignRead = await request(
      'GET',
      `/api/hr/lifecycle-checklists/${onboardingId}`,
      managerBToken
    );
    assert.equal(foreignRead.status, 403);

    const foreignList = await request(
      'GET',
      `/api/hr/lifecycle-checklists?branchId=${BRANCH_A}`,
      managerBToken
    );
    assert.equal(foreignList.status, 403);

    const ownList = await request('GET', '/api/hr/lifecycle-checklists', managerBToken);
    assert.equal(ownList.status, 200);
    assert.deepEqual(ownList.json, []);

    const foreignCreate = await request('POST', '/api/hr/lifecycle-checklists', managerBToken, {
      employeeId: employeeA1.id,
      type: 'OFFBOARDING',
      effectiveDateAD: '2026-11-15',
    });
    assert.equal(foreignCreate.status, 403);

    const foreignPatch = await request(
      'PATCH',
      `/api/hr/lifecycle-checklists/${onboardingId}`,
      managerBToken,
      { notes: 'Direct edit' }
    );
    assert.equal(foreignPatch.status, 403);

    const badFilter = await request(
      'GET',
      '/api/hr/lifecycle-checklists?owner=me',
      managerAToken
    );
    assert.equal(badFilter.status, 403);

    const repeatedFilter = await request(
      'GET',
      '/api/hr/lifecycle-checklists?branchId=hr-life-br-a&branchId=hr-life-br-b',
      managerAToken
    );
    assert.equal(repeatedFilter.status, 403);

    const allBranches = await request(
      'GET',
      '/api/hr/lifecycle-checklists?branchId=ALL',
      managerAToken
    );
    assert.equal(allBranches.status, 403);

    const baselineMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    const attendanceMatrix = JSON.parse(JSON.stringify(baselineMatrix));
    attendanceMatrix['hr-employee-view'].HEAD_OFFICE_ADMIN = false;
    attendanceMatrix['gl-payroll-manage'].HEAD_OFFICE_ADMIN = false;
    attendanceMatrix['hr-attendance-manage'].HEAD_OFFICE_ADMIN = true;
    setPermissionMatrix(attendanceMatrix);
    let attendanceRead: Awaited<ReturnType<typeof request>>;
    try {
      attendanceRead = await request(
        'GET',
        '/api/hr/lifecycle-checklists',
        issueAuthToken({
          ...MANAGER_A,
          id: 'hr-life-user-attendance-only',
          email: 'hr-life-attendance-only@example.com',
          role: 'HEAD_OFFICE_ADMIN',
        })
      );
    } finally {
      setPermissionMatrix(baselineMatrix);
    }
    assert.equal(attendanceRead.status, 403, JSON.stringify(attendanceRead.json));

    await pool!.query(
      `INSERT INTO fixed_assets (
         id, tag_number, name, category, branch_id,
         acquisition_date_ad, acquisition_date_bs, acquisition_cost, net_book_value,
         status, assigned_type, assigned_employee_id, assigned_employee_name,
         assignment_date_ad, assignment_date_bs, is_demo
       ) VALUES ('hr-life-asset-bad', 'LIFE-ASSET-BAD', 'Cross-branch asset', 'Equipment', $1,
         '2025-07-17', '2082-04-01 BS', 1000, 900, 'IN_USE', 'EMPLOYEE', $2, $3,
         '2026-10-01', '2083-06-15 BS', FALSE)`,
      [BRANCH_A, employeeB.id, employeeB.name]
    );

    const crossBranchOffboarding = await request(
      'POST',
      '/api/hr/lifecycle-checklists',
      managerBToken,
      {
        employeeId: employeeB.id,
        type: 'OFFBOARDING',
        effectiveDateAD: '2026-11-20',
      }
    );
    assert.equal(crossBranchOffboarding.status, 409);
    assert.match(crossBranchOffboarding.json.message, /belongs to another branch/i);
  });
});
