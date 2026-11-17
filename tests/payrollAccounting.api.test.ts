import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * Payroll → ledger, driven through the real HTTP routes against PostgreSQL.
 *
 * Payroll is the last operational domain that had no ledger presence. The
 * claims pinned here are the ones a payroll row without a journal cannot meet:
 *
 *   1. the employee master is a branch-scoped, separately addressable record;
 *   2. a posted run writes one balanced journal — salary cost debited (gross
 *      wages plus the employer SSF share), net/TDS/employee SSF/employer
 *      SSF/advance/loan credited — plus EMPLOYEE subledger rows;
 *   3. TDS and SSF control accounts reconcile to those subledger rows per
 *      employee, and the employee ledger reads the same entries;
 *   4. a second run for the same branch+period is refused with nothing written;
 *   5. paying the run clears salary payable per employee against cash and the
 *      payment cannot be repeated;
 *   6. a closed period refuses the run and rolls the whole document back.
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
import { ensureBsDayRecords, ensureReferenceData } from './fixtures/referenceData';

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

const BR = 'pay-test-branch';
/** Second branch used to prove attendance/holiday reads and writes are scoped. */
const ATT_BRANCH = 'pay-test-branch-att';
/** Third branch used to prove leave requests and balances are scoped. */
const LV_BRANCH = 'pay-test-branch-lv';
/** Fourth branch used to prove payroll inputs are branch-scoped. */
const PI_BRANCH = 'pay-test-branch-pi';
/** Destination for the employee branch-transfer history test. */
const TR_BRANCH = 'pay-test-branch-tr';
const RUN_DATE = '2026-09-30';
const PERIOD = '2026-09';
/** Far enough from every other suite's month that closing it cannot leak. */
const CLOSED_PERIOD = '2027-06';
const CLOSED_RUN_DATE = '2027-06-30';
const LINK_USER_ID = 'payt-link-user';
const ORG_CODE = 'PAYT-ORG-DEPT';

const ADMIN = {
  id: 'pay-admin',
  email: 'pay-admin@example.com',
  name: 'PAY Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const INVENTORY_MANAGER = {
  id: 'pay-inv-manager',
  email: 'pay-inv-manager@example.com',
  name: 'PAY Inventory Manager',
  role: 'INVENTORY_MANAGER',
  branchId: BR,
  allowedBranchIds: [BR],
  canSwitchUser: false,
} as any;

/** Separate account so a transfer can never be approved by its requester. */
const TRANSFER_MANAGER = {
  id: 'pay-hr-manager',
  email: 'pay-hr-manager@example.com',
  name: 'PAY HR Manager',
  role: 'HR_MANAGER',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('payroll run and payment posting (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const managerToken = issueAuthToken(INVENTORY_MANAGER);
  const transferManagerToken = issueAuthToken(TRANSFER_MANAGER);
  let emp1: any = null;
  let emp2: any = null;
  let run: any = null;
  let runDateBS = '';

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    auth = token
  ) {
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
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  const get = (path: string, auth = token) => request('GET', path, undefined, auth);
  const post = (path: string, body: unknown, auth = token) => request('POST', path, body, auth);
  const patch = (path: string, body: unknown, auth = token) =>
    request('PATCH', path, body, auth);

  async function uploadDocument(
    employeeId: string,
    bytes: Uint8Array,
    auth = token,
    query = 'type=CITIZENSHIP&fileName=test-document.pdf',
    mime = 'application/pdf'
  ) {
    const res = await fetch(
      'http://127.0.0.1:' + port + `/api/employees/${employeeId}/documents?${query}`,
      {
        method: 'POST',
        headers: { 'content-type': mime, authorization: 'Bearer ' + auth },
        body: bytes,
      }
    );
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  async function fetchDocument(employeeId: string, documentId: string, auth = token) {
    const res = await fetch(
      'http://127.0.0.1:' + port + `/api/employees/${employeeId}/documents/${documentId}/content`,
      { headers: { authorization: 'Bearer ' + auth } }
    );
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      disposition: res.headers.get('content-disposition'),
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  }

  async function deleteDocument(employeeId: string, documentId: string, auth = token) {
    const res = await fetch(
      'http://127.0.0.1:' + port + `/api/employees/${employeeId}/documents/${documentId}`,
      { method: 'DELETE', headers: { authorization: 'Bearer ' + auth } }
    );
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a 204 carries no body */
    }
    return { status: res.status, json };
  }

  async function cleanup() {
    await pool!.query(
      "DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_runs WHERE branch_id = $1)",
      [BR]
    );
    await pool!.query('DELETE FROM payroll_runs WHERE branch_id = $1', [BR]);
    await pool!.query(
      "DELETE FROM gl_journals WHERE branch_id = $1 AND source_type IN ('PAYROLL_RUN', 'PAYROLL_PAYMENT')",
      [BR]
    );
    // Attendance/holidays/leave reference both employees and branches, so they
    // go first; the HR catalogue is deleted by its test code prefix.
    const testBranches = [BR, ATT_BRANCH, LV_BRANCH, PI_BRANCH, TR_BRANCH];
    await pool!.query(
      "DELETE FROM hr_attendance WHERE branch_id = ANY($1::varchar[]) OR employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'PAYT-%')",
      [testBranches]
    );
    await pool!.query(
      "DELETE FROM hr_leave_requests WHERE branch_id = ANY($1::varchar[]) OR employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'PAYT-%')",
      [testBranches]
    );
    await pool!.query(
      "DELETE FROM hr_leave_balances WHERE branch_id = ANY($1::varchar[]) OR employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'PAYT-%')",
      [testBranches]
    );
    await pool!.query("DELETE FROM hr_employee_documents WHERE employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'PAYT-%')");
    await pool!.query("DELETE FROM employees WHERE employee_code LIKE 'PAYT-%'");
    await pool!.query('DELETE FROM hr_holidays WHERE branch_id = ANY($1::varchar[])', [testBranches]);
    await pool!.query("DELETE FROM hr_shifts WHERE code LIKE 'PAYT-%'");
    await pool!.query("DELETE FROM hr_leave_types WHERE code LIKE 'PAYT-%'");
    await pool!.query("DELETE FROM hr_org_masters WHERE code LIKE 'PAYT-ORG-%'");
    await pool!.query('DELETE FROM users WHERE id = $1', [LINK_USER_ID]);
    await purgeAuditLogs(pool!, "DELETE FROM audit_logs WHERE details LIKE '%pay-test-branch%'");
    await purgeAuditLogs(pool!, "DELETE FROM audit_logs WHERE action = 'IMPORT_EMPLOYEES'");
    await purgeAuditLogs(pool!, 
      `DELETE FROM audit_logs
        WHERE (branch_id = ANY($1::varchar[]) AND action IN (
          'CREATE_HR_HOLIDAY', 'DELETE_HR_HOLIDAY', 'UPSERT_HR_ATTENDANCE',
          'DELETE_HR_ATTENDANCE', 'IMPORT_HR_ATTENDANCE',
          'CREATE_HR_LEAVE_BALANCE', 'UPDATE_HR_LEAVE_BALANCE',
          'CREATE_HR_LEAVE_REQUEST', 'APPROVE_HR_LEAVE_REQUEST',
          'REJECT_HR_LEAVE_REQUEST', 'CANCEL_HR_LEAVE_REQUEST'
        ))
           OR (action IN (
          'CREATE_HR_SHIFT', 'UPDATE_HR_SHIFT', 'CREATE_HR_LEAVE_TYPE', 'UPDATE_HR_LEAVE_TYPE'
        ) AND details LIKE '%PAYT-%')`,
      [testBranches]
    );
    // Only remove a period this suite created. The canonical demo seed also
    // owns a 2027-06 period; deleting it by key orphaned that month's budget
    // lines and made the seeded KTM allocation preview under-count.
    await pool!.query(
      "DELETE FROM gl_periods WHERE period_key = $1 AND id LIKE 'glp-%'",
      [CLOSED_PERIOD]
    );
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [testBranches]);
  }

  async function journalFor(sourceType: string, sourceId: string) {
    const { rows } = await pool!.query(
      `SELECT id, journal_no AS "journalNo", status, branch_id AS "branchId",
              source_type AS "sourceType", source_id AS "sourceId",
              journal_date_ad::text AS "journalDateAD",
              journal_date_bs AS "journalDateBS"
         FROM gl_journals
        WHERE source_type = $1 AND source_id = $2
        ORDER BY posted_at ASC, journal_no ASC`,
      [sourceType, sourceId]
    );
    return rows;
  }

  async function journalLines(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT a.code, l.debit::numeric AS debit, l.credit::numeric AS credit
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
        WHERE l.journal_id = $1
        ORDER BY l.line_no ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function subledgerRows(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT a.code, s.party_id AS "partyId", s.party_name AS "partyName",
              s.debit::numeric AS debit, s.credit::numeric AS credit
         FROM gl_subledger_entries s
         JOIN gl_accounts a ON a.id = s.account_id
        WHERE s.journal_id = $1
        ORDER BY a.code ASC, s.party_id ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function jobCount(table: string, where: string, params: unknown[]): Promise<number> {
    const { rows } = await pool!.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params);
    return Number(rows[0].count);
  }

  function employeeBody(code: string, name: string) {
    return {
      employeeCode: code,
      name,
      branchId: BR,
      department: 'Field Operations',
      designation: 'Technician',
      panNumber: `PAN-${code}`,
      ssfNumber: `SSF-${code}`,
      employmentType: 'Non-PB',
      joiningDateAD: '2026-09-01',
      dateOfBirthAD: '1995-01-15',
      contractExpiryAD: '2027-09-01',
      separationDateAD: '2027-03-31',
      designationCode: 'TECH',
      workStation: 'Test Station',
      personalContact: '9800000001',
      emergencyContactPerson: 'Test Contact',
      emergencyContactNumber: '9800000002',
      internalEmail: `${code.toLowerCase()}@example.test`,
      personalEmail: `${code.toLowerCase()}.personal@example.test`,
      bankName: 'Test Bank',
      monthlySalary: 25000,
      ssfEligible: false,
    };
  }

  function runBody(period = PERIOD, dateAD = RUN_DATE) {
    return {
      branchId: BR,
      periodKey: period,
      runDateAD: dateAD,
      lines: [
        {
          employeeId: emp1.id,
          gross: 5000,
          tds: 500,
          ssf: 550,
          advance: 200,
          loan: 100,
        },
        {
          employeeId: emp2.id,
          gross: 4000,
          tds: 200,
          ssf: 440,
          advance: 0,
          loan: 0,
        },
      ],
    };
  }

  async function postingDefault(role: string) {
    const res = await get('/api/accounting/posting-defaults');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const found = res.json.defaults[role];
    assert.ok(found, `posting default ${role} must be seeded`);
    return found;
  }

  before(async () => {
    const reference = await ensureReferenceData(pool!, RUN_DATE);
    runDateBS = `${reference.bsDate} BS`;
    await ensureBsDayRecords(pool!, ['2027-06-01', CLOSED_RUN_DATE]);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'PAYB', 'PAY Test Branch', 'Test'),
              ($2, 'PAYBT', 'PAY Transfer Branch', 'Test'),
              ($3, 'PAYPI', 'PAY Payroll Inputs Branch', 'Test')`,
      [BR, TR_BRANCH, PI_BRANCH]
    );
    await pool!.query(
      `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
       VALUES ($1, $2, 'test-not-a-real-hash', 'PAY Linked User', 'HR_OFFICER', $3, ARRAY[$4]::text[], 'active')`,
      [LINK_USER_ID, 'pay-linked-user@example.test', BR, BR]
    );

    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);

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

  test('the employee master creates, lists and updates branch-scoped employees', async () => {
    const first = await post('/api/employees', employeeBody('PAYT-001', 'Pay Test One'));
    assert.equal(first.status, 201, JSON.stringify(first.json));
    emp1 = first.json;
    assert.equal(emp1.employeeCode, 'PAYT-001');
    assert.equal(emp1.branchId, BR);
    assert.equal(emp1.isActive, true);
    assert.equal(emp1.employmentType, 'Non-PB');
    assert.equal(emp1.joiningDateAD, '2026-09-01');
    assert.equal(emp1.dateOfBirthAD, '1995-01-15');
    assert.equal(emp1.contractExpiryAD, '2027-09-01');
    assert.equal(emp1.separationDateAD, '2027-03-31');
    assert.equal(emp1.designationCode, 'TECH');
    assert.equal(emp1.workStation, 'Test Station');
    assert.equal(emp1.emergencyContactPerson, 'Test Contact');
    assert.equal(emp1.bankName, 'Test Bank');
    assert.equal(Number(emp1.monthlySalary), 25000);
    assert.equal(emp1.ssfEligible, false);

    const second = await post('/api/employees', employeeBody('PAYT-002', 'Pay Test Two'));
    assert.equal(second.status, 201, JSON.stringify(second.json));
    emp2 = second.json;

    const duplicate = await post('/api/employees', employeeBody('PAYT-001', 'Duplicate Code'));
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /already exists/i);

    const list = await get(`/api/employees?branchId=${BR}`);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.length, 2);

    const updated = await patch(`/api/employees/${emp2.id}`, {
      designation: 'Senior Technician',
      employmentType: 'Probation',
      monthlySalary: 26000,
      separationDateAD: '2027-04-30',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.designation, 'Senior Technician');
    assert.equal(updated.json.employmentType, 'Probation');
    assert.equal(Number(updated.json.monthlySalary), 26000);
    assert.equal(updated.json.separationDateAD, '2027-04-30');
    assert.equal(updated.json.name, 'Pay Test Two');

    // Branch comes from Branch Management. An unknown target is refused before
    // anything is written; a same-branch patch is a no-op, but a different
    // branch can only move through a request plus manager approval.
    const unknownBranch = await patch(`/api/employees/${emp2.id}`, {
      branchId: 'no-such-branch',
    });
    assert.equal(unknownBranch.status, 400, JSON.stringify(unknownBranch.json));
    assert.match(unknownBranch.json.message, /Unknown branch/i);
    const sameBranch = await patch(`/api/employees/${emp2.id}`, { branchId: BR });
    assert.equal(sameBranch.status, 200, JSON.stringify(sameBranch.json));
    assert.equal(sameBranch.json.branchId, BR);
    const bypass = await patch(`/api/employees/${emp2.id}`, { branchId: TR_BRANCH });
    assert.equal(bypass.status, 400, JSON.stringify(bypass.json));
    assert.match(bypass.json.message, /transfer process and manager approval/i);

    // The dedicated transfer process records a named history event with an
    // effective date and reason; it is not parsed back out of audit-log text.
    const sameTransfer = await post(`/api/employees/${emp2.id}/transfer`, {
      branchId: BR,
      effectiveDateAD: '2026-09-30',
      reason: 'No move',
    });
    assert.equal(sameTransfer.status, 400, JSON.stringify(sameTransfer.json));
    const missingReason = await post(`/api/employees/${emp2.id}/transfer`, {
      branchId: TR_BRANCH,
      effectiveDateAD: '2026-09-30',
    });
    assert.equal(missingReason.status, 400, JSON.stringify(missingReason.json));
    assert.match(missingReason.json.message, /reason/i);

    // Stage one records a pending request and deliberately does not move the
    // employee; the same employee cannot accumulate two pending requests.
    const transferred = await post(`/api/employees/${emp2.id}/transfer`, {
      branchId: TR_BRANCH,
      effectiveDateAD: '2026-09-30',
      reason: 'Coverage at the transfer branch',
    });
    assert.equal(transferred.status, 200, JSON.stringify(transferred.json));
    assert.equal(transferred.json.employee.branchId, BR, 'the branch must not change yet');
    assert.equal(transferred.json.status, 'PENDING');
    assert.ok(transferred.json.transferId);
    const duplicateRequest = await post(`/api/employees/${emp2.id}/transfer`, {
      branchId: TR_BRANCH,
      effectiveDateAD: '2026-09-30',
      reason: 'Duplicate request',
    });
    assert.equal(duplicateRequest.status, 409, JSON.stringify(duplicateRequest.json));
    assert.match(duplicateRequest.json.message, /pending transfer/i);

    const history = await get(`/api/employees/${emp2.id}/profile`);
    assert.equal(history.status, 200, JSON.stringify(history.json));
    assert.equal(history.json.branchTransfers.length, 1, JSON.stringify(history.json.branchTransfers));
    const [pending] = history.json.branchTransfers;
    assert.equal(pending.fromBranchId, BR);
    assert.equal(pending.fromBranchName, 'PAY Test Branch');
    assert.equal(pending.toBranchId, TR_BRANCH);
    assert.equal(pending.toBranchName, 'PAY Transfer Branch');
    assert.equal(pending.transferredBy, ADMIN.email);
    assert.equal(pending.effectiveDateAD, '2026-09-30');
    assert.equal(pending.reason, 'Coverage at the transfer branch');
    assert.equal(pending.status, 'PENDING');

    // The requester cannot approve their own request, and a non-manager role
    // cannot decide one even with a manage grant.
    const selfApproval = await post(
      `/api/hr/branch-transfers/${transferred.json.transferId}/approve`,
      {}
    );
    assert.equal(selfApproval.status, 403, JSON.stringify(selfApproval.json));
    assert.match(selfApproval.json.message, /other than its requester/i);
    const wrongRole = await post(
      `/api/hr/branch-transfers/${transferred.json.transferId}/approve`,
      {},
      managerToken
    );
    assert.equal(wrongRole.status, 403, JSON.stringify(wrongRole.json));

    const approved = await post(
      `/api/hr/branch-transfers/${transferred.json.transferId}/approve`,
      {},
      transferManagerToken
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.employee.branchId, TR_BRANCH);
    assert.equal(approved.json.transfer.status, 'APPROVED');
    assert.equal(approved.json.transfer.approvedBy, TRANSFER_MANAGER.email);
    const afterApproval = await get(`/api/employees/${emp2.id}/profile`);
    assert.equal(afterApproval.status, 200, JSON.stringify(afterApproval.json));
    assert.equal(afterApproval.json.branchTransfers.length, 1);
    assert.equal(afterApproval.json.branchTransfers[0].status, 'APPROVED');
    assert.equal(
      afterApproval.json.branchTransfers[0].approvedBy,
      TRANSFER_MANAGER.email
    );
    const doubleDecision = await post(
      `/api/hr/branch-transfers/${transferred.json.transferId}/approve`,
      {},
      transferManagerToken
    );
    assert.equal(doubleDecision.status, 409, JSON.stringify(doubleDecision.json));

    // The directory log filters on either side of the move and by AD date.
    const log = await get(`/api/hr/branch-transfers?branchId=${TR_BRANCH}`);
    assert.equal(log.status, 200, JSON.stringify(log.json));
    assert.equal(log.json.length, 1, JSON.stringify(log.json));
    assert.equal(log.json[0].employeeCode, 'PAYT-002');
    assert.equal(log.json[0].employeeName, 'Pay Test Two');
    assert.equal(log.json[0].fromBranchName, 'PAY Test Branch');
    assert.equal(log.json[0].toBranchName, 'PAY Transfer Branch');
    assert.equal(log.json[0].reason, 'Coverage at the transfer branch');
    assert.equal(log.json[0].status, 'APPROVED');
    const insideDates = await get(
      `/api/hr/branch-transfers?dateFrom=2026-09-01&dateTo=2026-09-30`
    );
    assert.equal(insideDates.status, 200, JSON.stringify(insideDates.json));
    assert.equal(insideDates.json.length, 1, JSON.stringify(insideDates.json));
    const outsideDates = await get(
      `/api/hr/branch-transfers?dateFrom=2000-01-01&dateTo=2000-01-02`
    );
    assert.equal(outsideDates.status, 200, JSON.stringify(outsideDates.json));
    assert.deepEqual(outsideDates.json, []);
    assert.equal(
      (await get('/api/hr/branch-transfers?dateFrom=2026-02-30')).status,
      400,
      'an impossible AD date must be refused'
    );

    const movedBack = await post(`/api/employees/${emp2.id}/transfer`, {
      branchId: BR,
      effectiveDateAD: '2026-10-01',
      reason: 'Return to the base branch',
    });
    assert.equal(movedBack.status, 200, JSON.stringify(movedBack.json));
    assert.equal(movedBack.json.employee.branchId, TR_BRANCH, 'still awaiting approval');
    const movedBackApproved = await post(
      `/api/hr/branch-transfers/${movedBack.json.transferId}/approve`,
      {},
      transferManagerToken
    );
    assert.equal(movedBackApproved.status, 200, JSON.stringify(movedBackApproved.json));
    assert.equal(movedBackApproved.json.employee.branchId, BR);
    const afterReturn = await get(`/api/employees/${emp2.id}/profile`);
    assert.equal(afterReturn.status, 200, JSON.stringify(afterReturn.json));
    assert.equal(afterReturn.json.branchTransfers.length, 2);
    assert.equal(afterReturn.json.branchTransfers[0].fromBranchId, TR_BRANCH);
    assert.equal(afterReturn.json.branchTransfers[0].toBranchId, BR);
    assert.equal(afterReturn.json.branchTransfers[0].reason, 'Return to the base branch');
    assert.equal(afterReturn.json.branchTransfers[0].status, 'APPROVED');

    // A rejection is retained with its decision note and never moves anyone.
    const rejectedRequest = await post(`/api/employees/${emp2.id}/transfer`, {
      branchId: PI_BRANCH,
      effectiveDateAD: '2026-10-02',
      reason: 'Temporary coverage',
    });
    assert.equal(rejectedRequest.status, 200, JSON.stringify(rejectedRequest.json));
    const rejected = await post(
      `/api/hr/branch-transfers/${rejectedRequest.json.transferId}/reject`,
      { note: 'Coverage is no longer required' },
      transferManagerToken
    );
    assert.equal(rejected.status, 200, JSON.stringify(rejected.json));
    assert.equal(rejected.json.employee, null);
    assert.equal(rejected.json.transfer.status, 'REJECTED');
    assert.equal(rejected.json.transfer.decisionNote, 'Coverage is no longer required');
    const afterRejection = await get(`/api/employees/${emp2.id}`);
    assert.equal(afterRejection.status, 200, JSON.stringify(afterRejection.json));
    assert.equal(afterRejection.json.branchId, BR);
    const afterRejectionProfile = await get(`/api/employees/${emp2.id}/profile`);
    assert.equal(afterRejectionProfile.status, 200);
    assert.equal(afterRejectionProfile.json.branchTransfers.length, 3);
    assert.equal(afterRejectionProfile.json.branchTransfers[0].status, 'REJECTED');

    const afterLog = await get(`/api/hr/branch-transfers?branchId=${TR_BRANCH}`);
    assert.equal(afterLog.status, 200, JSON.stringify(afterLog.json));
    assert.equal(afterLog.json.length, 2, JSON.stringify(afterLog.json));
    assert.deepEqual(
      afterLog.json.map((row: any) => [row.fromBranchId, row.toBranchId]),
      [
        [TR_BRANCH, BR],
        [BR, TR_BRANCH],
      ]
    );

    const invalidSeparation = await patch(`/api/employees/${emp2.id}`, {
      separationDateAD: '2026-08-31',
    });
    assert.equal(invalidSeparation.status, 400, JSON.stringify(invalidSeparation.json));
    assert.match(invalidSeparation.json.message, /on or after the joining date/i);

    const clearedSeparation = await patch(`/api/employees/${emp2.id}`, {
      separationDateAD: null,
    });
    assert.equal(clearedSeparation.status, 200, JSON.stringify(clearedSeparation.json));
    assert.equal(clearedSeparation.json.separationDateAD, null);

    const search = await get(`/api/employees?branchId=${BR}&query=PAYT-002`);
    assert.equal(search.status, 200, JSON.stringify(search.json));
    assert.equal(search.json.length, 1);
    assert.equal(search.json[0].id, emp2.id);

    // The full master still supports the payroll identifiers a viewer may need.
    const byPan = await get(`/api/employees?branchId=${BR}&query=PAN-PAYT-001`);
    assert.equal(byPan.status, 200, JSON.stringify(byPan.json));
    assert.deepEqual(byPan.json.map((row: any) => row.employeeCode), ['PAYT-001']);

    const bySsf = await get(`/api/employees?branchId=${BR}&query=SSF-PAYT-002`);
    assert.equal(bySsf.status, 200, JSON.stringify(bySsf.json));
    assert.deepEqual(bySsf.json.map((row: any) => row.employeeCode), ['PAYT-002']);
  });

  test('the employee master links one login account and honors the hr-* gates', async () => {
    const options = await get('/api/employees/user-options');
    assert.equal(options.status, 200, JSON.stringify(options.json));
    assert.ok(
      options.json.some((row: any) => row.id === LINK_USER_ID && row.linked === false),
      'the unlinked test account must be offered'
    );

    const linked = await patch(`/api/employees/${emp1.id}`, { userId: LINK_USER_ID });
    assert.equal(linked.status, 200, JSON.stringify(linked.json));
    assert.equal(linked.json.userId, LINK_USER_ID);

    const duplicate = await patch(`/api/employees/${emp2.id}`, { userId: LINK_USER_ID });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /already linked/i);

    const afterLink = await get('/api/employees/user-options');
    assert.equal(afterLink.status, 200);
    assert.equal(afterLink.json.find((row: any) => row.id === LINK_USER_ID)?.linked, true);

    const unlinked = await patch(`/api/employees/${emp1.id}`, { userId: null });
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.json));
    assert.equal(unlinked.json.userId, null);

    const missing = await patch(`/api/employees/${emp1.id}`, { userId: 'missing-user' });
    assert.equal(missing.status, 400, JSON.stringify(missing.json));

    // An HR viewer can read the master but cannot write it without the manage
    // grant, and the legacy payroll grant is not silently implied.
    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    matrix['gl-payroll-manage'].AUDITOR = false;
    matrix['hr-employee-view'].AUDITOR = true;
    matrix['hr-employee-manage'].AUDITOR = false;
    setPermissionMatrix(matrix);
    try {
      const auditorToken = issueAuthToken({
        ...ADMIN,
        id: 'pay-auditor',
        email: 'pay-auditor@example.com',
        name: 'PAY Auditor',
        role: 'AUDITOR',
      });
      const read = await get(`/api/employees?branchId=${BR}`, auditorToken);
      assert.equal(read.status, 200, JSON.stringify(read.json));
      const write = await post(
        '/api/employees',
        employeeBody('PAYT-003', 'Pay Test Three'),
        auditorToken
      );
      assert.equal(write.status, 403, JSON.stringify(write.json));
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }
  });

  test('HR roles mask PII for view-only callers and keep full detail for managers', async () => {
    const hrManagerToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-hr-manager',
      email: 'pay-hr-manager@example.com',
      name: 'PAY HR Manager',
      role: 'HR_MANAGER',
    });
    const hrOfficerToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-hr-officer',
      email: 'pay-hr-officer@example.com',
      name: 'PAY HR Officer',
      role: 'HR_OFFICER',
    });
    const legacyPayrollToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-legacy-accountant',
      email: 'pay-legacy-accountant@example.com',
      name: 'PAY Legacy Accountant',
      role: 'ACCOUNTANT',
    });

    const managerList = await get(`/api/employees?branchId=${BR}`, hrManagerToken);
    assert.equal(managerList.status, 200, JSON.stringify(managerList.json));
    const managerRow = managerList.json.find((row: any) => row.id === emp1.id);
    assert.equal(managerRow.panNumber, 'PAN-PAYT-001');
    assert.equal(managerRow.bankName, 'Test Bank');
    assert.equal(Number(managerRow.monthlySalary), 25000);

    const officerList = await get(`/api/employees?branchId=${BR}`, hrOfficerToken);
    assert.equal(officerList.status, 200, JSON.stringify(officerList.json));
    const maskedRow = officerList.json.find((row: any) => row.id === emp1.id);
    assert.equal(maskedRow.name, 'Pay Test One');
    assert.equal(maskedRow.employeeCode, 'PAYT-001');
    for (const field of [
      'panNumber',
      'ssfNumber',
      'bankName',
      'monthlySalary',
      'personalContact',
      'personalEmail',
      'dateOfBirthAD',
      'emergencyContactPerson',
    ]) {
      assert.equal(maskedRow[field], null, `view-only list leaked ${field}`);
    }

    const officerDetail = await get(`/api/employees/${emp1.id}`, hrOfficerToken);
    assert.equal(officerDetail.status, 200, JSON.stringify(officerDetail.json));
    assert.equal(officerDetail.json.name, 'Pay Test One');
    assert.equal(officerDetail.json.panNumber, null);
    assert.equal(officerDetail.json.monthlySalary, null);

    const managerDetail = await get(`/api/employees/${emp1.id}`, hrManagerToken);
    assert.equal(managerDetail.status, 200, JSON.stringify(managerDetail.json));
    assert.equal(managerDetail.json.panNumber, 'PAN-PAYT-001');
    assert.equal(Number(managerDetail.json.monthlySalary), 25000);

    // The manager grant is a real write grant, not just a read-detail flag.
    const managerWrite = await patch(
      `/api/employees/${emp2.id}`,
      { designation: 'HR Manager Edit' },
      hrManagerToken
    );
    assert.equal(managerWrite.status, 200, JSON.stringify(managerWrite.json));
    assert.equal(managerWrite.json.designation, 'HR Manager Edit');

    // Legacy payroll managers are full-detail readers by explicit rule.
    const legacyDetail = await get(`/api/employees/${emp1.id}`, legacyPayrollToken);
    assert.equal(legacyDetail.status, 200, JSON.stringify(legacyDetail.json));
    assert.equal(legacyDetail.json.panNumber, 'PAN-PAYT-001');
    assert.equal(Number(legacyDetail.json.monthlySalary), 25000);

    // The account-options endpoint is manage-only and must not be a side door.
    const officerOptions = await get('/api/employees/user-options', hrOfficerToken);
    assert.equal(officerOptions.status, 403, JSON.stringify(officerOptions.json));
    const officerWrite = await post(
      '/api/employees',
      employeeBody('PAYT-003', 'Pay Test Three'),
      hrOfficerToken
    );
    assert.equal(officerWrite.status, 403, JSON.stringify(officerWrite.json));

    // A detail/ledger read must mask the embedded employee too.
    const withLedgerRead = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    withLedgerRead['gl-view'].HR_OFFICER = true;
    setPermissionMatrix(withLedgerRead);
    try {
      const ledger = await get(`/api/employees/${emp1.id}/ledger`, hrOfficerToken);
      assert.equal(ledger.status, 200, JSON.stringify(ledger.json));
      assert.equal(ledger.json.employee.panNumber, null);
      assert.equal(ledger.json.employee.monthlySalary, null);
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }
  });

  test('HR org masters are readable and maintainable behind the employee permissions', async () => {
    const initial = await get('/api/hr/org-masters');
    assert.equal(initial.status, 200, JSON.stringify(initial.json));

    const created = await post('/api/hr/org-masters', {
      kind: 'DEPARTMENT',
      name: 'Pay Test Department',
      code: ORG_CODE,
      isActive: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.kind, 'DEPARTMENT');
    assert.equal(created.json.code, ORG_CODE);
    assert.equal(created.json.isActive, true);

    const duplicateName = await post('/api/hr/org-masters', {
      kind: 'DEPARTMENT',
      name: 'Pay Test Department',
      code: `${ORG_CODE}-2`,
    });
    assert.equal(duplicateName.status, 409, JSON.stringify(duplicateName.json));

    const duplicateCode = await post('/api/hr/org-masters', {
      kind: 'DEPARTMENT',
      name: 'Pay Test Department Code Duplicate',
      code: ORG_CODE,
    });
    assert.equal(duplicateCode.status, 409, JSON.stringify(duplicateCode.json));

    const renamed = await patch(`/api/hr/org-masters/${created.json.id}`, {
      name: 'Pay Test Department Renamed',
      code: ORG_CODE,
      isActive: false,
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    assert.equal(renamed.json.name, 'Pay Test Department Renamed');
    assert.equal(renamed.json.isActive, false);

    const all = await get('/api/hr/org-masters?kind=DEPARTMENT');
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.ok(all.json.some((row: any) => row.id === created.json.id && row.isActive === false));
    const active = await get('/api/hr/org-masters?kind=DEPARTMENT&activeOnly=1');
    assert.equal(active.status, 200, JSON.stringify(active.json));
    assert.ok(!active.json.some((row: any) => row.id === created.json.id));

    const invalidKind = await post('/api/hr/org-masters', {
      kind: 'GRADE',
      name: 'Pay Test Invalid Kind',
      code: `${ORG_CODE}-BAD`,
    });
    assert.equal(invalidKind.status, 400, JSON.stringify(invalidKind.json));

    const hrOfficerToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-org-officer',
      email: 'pay-org-officer@example.com',
      name: 'PAY Org Officer',
      role: 'HR_OFFICER',
    });
    const officerRead = await get('/api/hr/org-masters', hrOfficerToken);
    assert.equal(officerRead.status, 200, JSON.stringify(officerRead.json));
    const officerWrite = await post(
      '/api/hr/org-masters',
      { kind: 'WORK_STATION', name: 'Pay Test Station', code: `${ORG_CODE}-WS` },
      hrOfficerToken
    );
    assert.equal(officerWrite.status, 403, JSON.stringify(officerWrite.json));
  });

  test('employee documents keep metadata readable and the bytes behind the manage grant', async () => {
    const hrOfficerToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-doc-officer',
      email: 'pay-doc-officer@example.com',
      name: 'PAY Doc Officer',
      role: 'HR_OFFICER',
    });
    const bytes = new Uint8Array(Buffer.from('%PDF-1.4\n% pay test document\n%%EOF\n'));

    const created = await uploadDocument(emp1.id, bytes);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.employeeId, emp1.id);
    assert.equal(created.json.docType, 'CITIZENSHIP');
    assert.equal(created.json.originalName, 'test-document.pdf');
    assert.equal(Number(created.json.byteSize), bytes.length);
    assert.equal(created.json.content, undefined, 'metadata must not embed the bytes');

    // The officer may see which documents exist...
    const officerList = await get(`/api/employees/${emp1.id}/documents`, hrOfficerToken);
    assert.equal(officerList.status, 200, JSON.stringify(officerList.json));
    assert.equal(officerList.json.length, 1);
    assert.equal(officerList.json[0].id, created.json.id);

    // ...but cannot read, replace or remove the PII inside them. A non-own
    // document is deliberately hidden as missing rather than confirming its id.
    assert.equal((await fetchDocument(emp1.id, created.json.id, hrOfficerToken)).status, 404);
    assert.equal((await uploadDocument(emp1.id, bytes, hrOfficerToken)).status, 403);
    assert.equal((await deleteDocument(emp1.id, created.json.id, hrOfficerToken)).status, 403);

    const downloaded = await fetchDocument(emp1.id, created.json.id);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.contentType, 'application/pdf');
    assert.match(downloaded.disposition || '', /attachment/);
    assert.deepEqual(downloaded.bytes, Buffer.from(bytes));

    const invalidType = await uploadDocument(
      emp1.id,
      bytes,
      token,
      'type=NOT_A_TYPE&fileName=invalid.pdf'
    );
    assert.equal(invalidType.status, 400, JSON.stringify(invalidType.json));

    const badMime = await uploadDocument(
      emp1.id,
      bytes,
      token,
      'type=OTHER&fileName=invalid.exe',
      'application/x-msdownload'
    );
    assert.equal(badMime.status, 400, JSON.stringify(badMime.json));

    const empty = await uploadDocument(
      emp1.id,
      new Uint8Array(0),
      token,
      'type=OTHER&fileName=empty.pdf'
    );
    assert.equal(empty.status, 400, JSON.stringify(empty.json));

    const oversized = await uploadDocument(
      emp1.id,
      new Uint8Array(5 * 1024 * 1024 + 1),
      token,
      'type=OTHER&fileName=large.pdf'
    );
    assert.equal(oversized.status, 413, JSON.stringify(oversized.json));

    const removed = await deleteDocument(emp1.id, created.json.id);
    assert.equal(removed.status, 204, JSON.stringify(removed.json));
    const afterDelete = await get(`/api/employees/${emp1.id}/documents`);
    assert.equal(afterDelete.status, 200);
    assert.deepEqual(afterDelete.json, []);
    assert.equal((await deleteDocument(emp1.id, created.json.id)).status, 404);
    assert.equal((await get('/api/employees/missing-employee/documents')).status, 404);
  });

  test('the employee picker searches code and name with a slim bounded page', async () => {
    const byCode = await get(`/api/employees/search?branchId=${BR}&query=PAYT-001`);
    assert.equal(byCode.status, 200, JSON.stringify(byCode.json));
    assert.deepEqual(byCode.json.map((row: any) => row.employeeCode), ['PAYT-001']);
    assert.deepEqual(
      Object.keys(byCode.json[0]).sort(),
      ['branchId', 'defaultCostCenterId', 'department', 'designation', 'employeeCode', 'id', 'isActive', 'name']
    );
    assert.equal(byCode.json[0].panNumber, undefined);
    assert.equal(byCode.json[0].ssfNumber, undefined);
    assert.equal(byCode.json[0].bankAccount, undefined);

    const byName = await get(`/api/employees/search?branchId=${BR}&query=Pay%20Test%20Two`);
    assert.equal(byName.status, 200, JSON.stringify(byName.json));
    assert.deepEqual(byName.json.map((row: any) => row.employeeCode), ['PAYT-002']);

    // The picker is for names and codes; a PAN/SSF probe cannot be used to
    // confirm which employee holds that number.
    const byPan = await get(`/api/employees/search?branchId=${BR}&query=PAN-PAYT-001`);
    assert.equal(byPan.status, 200);
    assert.deepEqual(byPan.json, []);
    const bySsf = await get(`/api/employees/search?branchId=${BR}&query=SSF-PAYT-002`);
    assert.equal(bySsf.status, 200);
    assert.deepEqual(bySsf.json, []);

    const bounded = await get(`/api/employees/search?branchId=${BR}&query=PAYT&limit=1`);
    assert.equal(bounded.status, 200, JSON.stringify(bounded.json));
    assert.equal(bounded.json.length, 1);
    assert.equal(bounded.json[0].employeeCode, 'PAYT-001');

    const empty = await get('/api/employees/search?branchId=NO-SUCH-BRANCH&query=PAYT');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, []);
  });

  test('a gl-post-only role can use the slim employee picker but not the employee master', async () => {
    const baseline = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    const postOnly = JSON.parse(JSON.stringify(baseline));
    postOnly['gl-view'].INVENTORY_MANAGER = false;
    postOnly['gl-post'].INVENTORY_MANAGER = true;
    try {
      setPermissionMatrix(postOnly);

      const search = await get(`/api/employees/search?branchId=${BR}&query=PAYT&limit=1`, managerToken);
      assert.equal(search.status, 200, JSON.stringify(search.json));
      assert.equal(search.json.length, 1);
      assert.equal(search.json[0].employeeCode, 'PAYT-001');
      assert.equal(search.json[0].panNumber, undefined);
      assert.equal(search.json[0].ssfNumber, undefined);
      assert.equal(search.json[0].bankAccount, undefined);

      // The picker is the only directory read a poster gets; the employee
      // master, payroll run and employee ledger remain gl-view reads.
      assert.equal((await get(`/api/employees?branchId=${BR}`, managerToken)).status, 403);
      assert.equal((await get(`/api/payroll-runs?branchId=${BR}`, managerToken)).status, 403);
      assert.equal((await get(`/api/employees/${emp1.id}/ledger?branchId=${BR}`, managerToken)).status, 403);
    } finally {
      setPermissionMatrix(baseline);
    }
  });

  test('a posted run writes the gross expense and every deduction to the ledger', async () => {
    const created = await post('/api/payroll-runs', runBody());
    assert.equal(created.status, 201, JSON.stringify(created.json));
    run = created.json;
    assert.equal(run.status, 'POSTED');
    assert.equal(run.runDateBS, runDateBS);
    assert.equal(Number(run.grossTotal), 9000);
    assert.equal(Number(run.tdsTotal), 700);
    assert.equal(Number(run.ssfTotal), 990);
    assert.equal(Number(run.advanceTotal), 200);
    assert.equal(Number(run.loanTotal), 100);
    assert.equal(Number(run.netTotal), 7010);
    assert.equal(run.lines.length, 2);
    assert.match(run.journalNo, /^MJ-/);

    const [journal] = await journalFor('PAYROLL_RUN', run.id);
    assert.ok(journal, 'a posted run must write its journal in the same transaction');
    assert.equal(journal.status, 'POSTED');
    assert.equal(journal.branchId, BR);
    assert.equal(journal.journalDateAD, RUN_DATE);
    assert.equal(journal.journalDateBS, runDateBS);

    const lines = await journalLines(journal.id);
    const byCode = (code: string) => lines.filter((line) => line.code === code);
    assert.equal(byCode('7110').length, 1, 'salary expense is one gross debit');
    assert.equal(byCode('7110')[0].debit, 9000);
    assert.deepEqual(byCode('5270').map((line) => line.credit).sort((a, b) => a - b), [3360, 3650]);
    assert.deepEqual(byCode('5220').map((line) => line.credit).sort((a, b) => a - b), [200, 500]);
    assert.deepEqual(byCode('5250').map((line) => line.credit).sort((a, b) => a - b), [440, 550]);
    assert.deepEqual(byCode('2140').map((line) => line.credit), [200]);
    assert.deepEqual(byCode('9020').map((line) => line.credit), [100]);
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 9000);
    assert.equal(lines.reduce((sum, line) => sum + line.credit, 0), 9000);

    const subledger = await subledgerRows(journal.id);
    assert.equal(subledger.length, 8, 'five deductions for emp1, three for emp2');
    assert.ok(subledger.every((row) => row.partyId === emp1.id || row.partyId === emp2.id));
    assert.deepEqual(
      subledger.filter((row) => row.code === '5220').map((row) => row.credit).sort((a, b) => a - b),
      [200, 500]
    );

    const detail = await get(`/api/payroll-runs/${run.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal(detail.json.lines.length, 2);
    assert.equal(detail.json.status, 'POSTED');

    const list = await get(`/api/payroll-runs?branchId=${BR}&periodKey=${PERIOD}`);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].id, run.id);
  });

  test('refuses TDS on an SSF-eligible employee', async () => {
    const ssfEmployee = (
      await post('/api/employees', {
        ...employeeBody('PAYT-SSF', 'Pay SSF Employee'),
        ssfEligible: true,
      })
    ).json;
    const refused = await post('/api/payroll-runs', {
      branchId: BR,
      periodKey: PERIOD,
      runDateAD: RUN_DATE,
      lines: [
        {
          employeeId: ssfEmployee.id,
          gross: 5000,
          tds: 500,
          ssf: 550,
          advance: 0,
          loan: 0,
        },
      ],
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.match(refused.json.message, /SSF-eligible/);
    assert.match(refused.json.message, /already includes salary tax/);
  });

  test('TDS and SSF reconcile per employee and the employee ledger reads the same entries', async () => {
    const [tds, ssf, payable, advance, loan] = await Promise.all([
      postingDefault('TDS_PAYABLE'),
      postingDefault('SSF_PAYABLE'),
      postingDefault('SALARY_PAYABLE'),
      postingDefault('EMPLOYEE_ADVANCE'),
      postingDefault('EMPLOYEE_LOAN'),
    ]);

    const tdsRecon = await get(`/api/accounting/reconciliations?accountId=${tds.accountId}&branchId=${BR}`);
    assert.equal(tdsRecon.status, 200, JSON.stringify(tdsRecon.json));
    assert.equal(tdsRecon.json.status, 'RECONCILED');
    assert.equal(tdsRecon.json.glBalance, -700);
    assert.equal(tdsRecon.json.subledgerBalance, -700);
    assert.deepEqual(
      tdsRecon.json.parties.map((party: any) => [party.partyId, party.balance]).sort(),
      [[emp1.id, -500], [emp2.id, -200]].sort()
    );

    const ssfRecon = await get(`/api/accounting/reconciliations?accountId=${ssf.accountId}&branchId=${BR}`);
    assert.equal(ssfRecon.status, 200, JSON.stringify(ssfRecon.json));
    assert.equal(ssfRecon.json.status, 'RECONCILED');
    assert.equal(ssfRecon.json.glBalance, -990);
    assert.deepEqual(
      ssfRecon.json.parties.map((party: any) => [party.partyId, party.balance]).sort(),
      [[emp1.id, -550], [emp2.id, -440]].sort()
    );

    const payableRecon = await get(`/api/accounting/reconciliations?accountId=${payable.accountId}&branchId=${BR}`);
    assert.equal(payableRecon.json.status, 'RECONCILED');
    assert.equal(payableRecon.json.glBalance, -7010);

    const advanceRecon = await get(`/api/accounting/reconciliations?accountId=${advance.accountId}&branchId=${BR}`);
    assert.equal(advanceRecon.json.glBalance, -200);
    const loanRecon = await get(`/api/accounting/reconciliations?accountId=${loan.accountId}&branchId=${BR}`);
    assert.equal(loanRecon.json.glBalance, -100);

    const ledger = await get(`/api/employees/${emp1.id}/ledger?branchId=${BR}`);
    assert.equal(ledger.status, 200, JSON.stringify(ledger.json));
    const account = (code: string) => ledger.json.accounts.find((row: any) => row.code === code);
    assert.equal(account('5270').balance, -3650);
    assert.equal(account('5220').balance, -500);
    assert.equal(account('5250').balance, -550);
    assert.equal(account('2140').balance, -200);
    assert.equal(account('9020').balance, -100);
    assert.equal(account('5270').presentedBalance, 3650, 'a liability presents in its natural direction');
    assert.equal(ledger.json.entries.length, 5);
    assert.equal(ledger.json.totals.debit, 0);
    assert.equal(ledger.json.totals.credit, 5000);
  });

  test('a duplicate run for the same month is refused and writes nothing', async () => {
    const beforeRuns = await jobCount('payroll_runs', 'branch_id = $1', [BR]);
    const beforeJournals = await jobCount(
      'gl_journals',
      "branch_id = $1 AND source_type = 'PAYROLL_RUN'",
      [BR]
    );

    const duplicate = await post('/api/payroll-runs', runBody());
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /already posted/i);

    assert.equal(await jobCount('payroll_runs', 'branch_id = $1', [BR]), beforeRuns);
    assert.equal(
      await jobCount('gl_journals', "branch_id = $1 AND source_type = 'PAYROLL_RUN'", [BR]),
      beforeJournals
    );
  });

  test('paying the run clears salary payable against cash, once', async () => {
    const paid = await post(`/api/payroll-runs/${run.id}/pay`, {
      paymentMethod: 'CASH',
      dateAD: RUN_DATE,
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    assert.equal(paid.json.status, 'PAID');
    assert.equal(paid.json.paidDateAD, RUN_DATE);
    assert.equal(paid.json.paidDateBS, runDateBS);
    assert.equal(paid.json.paymentMethod, 'CASH');
    assert.match(paid.json.journalNo, /^MJ-/);

    const [journal] = await journalFor('PAYROLL_PAYMENT', run.id);
    assert.ok(journal, 'the payment must write its own journal');
    const lines = await journalLines(journal.id);
    const byCode = (code: string) => lines.filter((line) => line.code === code);
    assert.deepEqual(byCode('5270').map((line) => line.debit).sort((a, b) => a - b), [3360, 3650]);
    assert.equal(byCode('2310').length, 1);
    assert.equal(byCode('2310')[0].credit, 7010);
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 7010);
    assert.equal(lines.reduce((sum, line) => sum + line.credit, 0), 7010);

    const subledger = await subledgerRows(journal.id);
    assert.equal(subledger.length, 2, 'one salary-payable settlement per employee');
    assert.ok(subledger.every((row) => row.credit === 0 && row.debit > 0));

    const payable = await postingDefault('SALARY_PAYABLE');
    const reconciled = await get(
      `/api/accounting/reconciliations?accountId=${payable.accountId}&branchId=${BR}`
    );
    assert.equal(reconciled.json.status, 'RECONCILED');
    assert.equal(reconciled.json.glBalance, 0);
    assert.equal(reconciled.json.subledgerBalance, 0);

    const ledger = await get(`/api/employees/${emp1.id}/ledger?branchId=${BR}`);
    assert.equal(ledger.json.accounts.find((row: any) => row.code === '5270').balance, 0);
    assert.equal(ledger.json.totals.debit, 3650);
    assert.equal(ledger.json.totals.credit, 5000);

    const detail = await get(`/api/payroll-runs/${run.id}`);
    assert.equal(detail.json.status, 'PAID');
    assert.equal(detail.json.paidJournalId, journal.id);
  });

  test('the employee ledger splits opening, period and closing balances per control account', async () => {
    const full = await get(`/api/employees/${emp1.id}/ledger?branchId=${BR}`);
    assert.equal(full.status, 200, JSON.stringify(full.json));
    assert.equal(full.json.currency, 'NPR');
    assert.equal(full.json.unlinkedCount, 0);
    assert.equal(full.json.totals.openingBalance, 0);
    assert.equal(full.json.totals.closingBalance, -1350);

    const account = (rows: any[], code: string) => rows.find((row: any) => row.code === code);
    const payable = account(full.json.accounts, '5270');
    assert.equal(payable.openingBalance, 0);
    assert.equal(payable.closingBalance, 0);
    assert.equal(payable.presentedClosingBalance, 0);

    const tds = account(full.json.accounts, '5220');
    assert.equal(tds.openingBalance, 0);
    assert.equal(tds.closingBalance, -500);
    assert.equal(tds.presentedClosingBalance, 500);

    const firstEntry = full.json.entries[0];
    assert.ok(firstEntry.journalId, 'the ledger line must name its journal');
    assert.equal(firstEntry.entryDateAD, RUN_DATE);
    assert.equal(firstEntry.entryDateBS, runDateBS);
    assert.equal(firstEntry.branchId, BR);
    assert.ok(firstEntry.voucherType, 'the ledger line must expose its voucher type');

    // A later window has no movements; everything before it is opening, and
    // closing is carried forward rather than dropped.
    const after = await get(
      `/api/employees/${emp1.id}/ledger?branchId=${BR}&from=2026-10-01&to=2026-10-31`
    );
    assert.equal(after.status, 200, JSON.stringify(after.json));
    assert.equal(after.json.entries.length, 0);
    assert.equal(after.json.totals.debit, 0);
    assert.equal(after.json.totals.credit, 0);
    assert.equal(after.json.totals.openingBalance, -1350);
    assert.equal(after.json.totals.closingBalance, -1350);
    assert.equal(account(after.json.accounts, '5220').presentedOpeningBalance, 500);
    assert.equal(account(after.json.accounts, '5220').presentedClosingBalance, 500);
  });

  test('a second payment is refused with no extra journal', async () => {
    const before = await jobCount(
      'gl_journals',
      "branch_id = $1 AND source_type = 'PAYROLL_PAYMENT'",
      [BR]
    );
    const again = await post(`/api/payroll-runs/${run.id}/pay`, {
      paymentMethod: 'CASH',
      dateAD: RUN_DATE,
    });
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.match(again.json.message, /already paid/i);
    assert.equal(
      await jobCount('gl_journals', "branch_id = $1 AND source_type = 'PAYROLL_PAYMENT'", [BR]),
      before
    );
  });

  test('a closed period refuses the run and rolls the whole document back', async () => {
    const opened = await post('/api/accounting/periods', { periodKey: CLOSED_PERIOD });
    let periodId: string | null = null;
    if (opened.status === 201) {
      periodId = opened.json.id;
    } else {
      const periods = await get('/api/accounting/periods');
      periodId = periods.json.find((row: any) => row.periodKey === CLOSED_PERIOD)?.id || null;
    }
    assert.ok(periodId, 'the closed-period test needs a period row');
    const closed = await post(`/api/accounting/periods/${periodId}/close`, {
      overrideReason: 'PAY TEST close without checklist',
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.json));
    assert.equal(closed.json.status, 'CLOSED');

    try {
      const refused = await post('/api/payroll-runs', runBody(CLOSED_PERIOD, CLOSED_RUN_DATE));
      assert.equal(refused.status, 409, JSON.stringify(refused.json));
      assert.match(refused.json.message, /closed/i);
      assert.equal(
        await jobCount('payroll_runs', 'branch_id = $1 AND period_key = $2', [BR, CLOSED_PERIOD]),
        0,
        'the refused run leaves no header behind'
      );
      assert.equal(
        await jobCount(
          'gl_journals',
          "branch_id = $1 AND source_type = 'PAYROLL_RUN' AND journal_date_ad = $2",
          [BR, CLOSED_RUN_DATE]
        ),
        0,
        'the refused run leaves no journal behind'
      );
    } finally {
      await post(`/api/accounting/periods/${periodId}/reopen`, {});
    }
  });

  test('payroll reads and writes are gated on the ledger permissions', async () => {
    const forbiddenRun = await post('/api/payroll-runs', runBody(), managerToken);
    assert.equal(forbiddenRun.status, 403, JSON.stringify(forbiddenRun.json));

    const forbiddenList = await get(`/api/employees?branchId=${BR}`, managerToken);
    assert.equal(forbiddenList.status, 403, JSON.stringify(forbiddenList.json));

    const forbiddenCreate = await post('/api/employees', employeeBody('PAYT-003', 'Pay Test Three'), managerToken);
    assert.equal(forbiddenCreate.status, 403, JSON.stringify(forbiddenCreate.json));
  });

  test('the master-sheet import previews without writing, then creates and updates idempotently', async () => {
    const station = await post('/api/hr/org-masters', {
      kind: 'WORK_STATION',
      name: 'PAY Import Station',
      code: 'PAYT-ORG-IMP-ST',
      isActive: true,
    });
    assert.equal(station.status, 201, JSON.stringify(station.json));

    const header =
      'HRMS ID,Full Name,Branch,Department,Designation,Employment Type,Employment Status,Joining Date,Work Station,Monthly Salary,PAN';
    const csv = [
      header,
      'PAYT-IMP-001,Import One,PAY Test Branch,Operations,Technician,Non-PB,Active,2026-10-01,PAY Import Station,"30,000",PAN-IMP-001',
      'PAYT-001,Pay Test One,PAY Test Branch,Operations,Senior Technician,Non-PB,Active,2026-09-01,PAY Import Station,"26,500",PAN-PAYT-001',
      'PAYT-IMP-002,Unknown Branch,No Such Branch,Operations,Technician,Non-PB,Active,2026-10-01,,,',
      'PAYT-IMP-003,Unknown Station,PAY Test Branch,Operations,Technician,Non-PB,Active,2026-10-01,Ghost Station,,',
      'PAYT-IMP-001,Duplicate Import,PAY Test Branch,Operations,Technician,Non-PB,Active,2026-10-01,,,',
      'PAYT-IMP-004,Bad Salary,PAY Test Branch,Operations,Technician,Non-PB,Active,2026-10-01,,not-a-number,',
    ].join('\n');

    const beforeEmployees = await jobCount('employees', 'branch_id = $1', [BR]);
    const beforeAudits = await jobCount('audit_logs', "action = 'IMPORT_EMPLOYEES'", []);
    const unchanged = await get(`/api/employees/${emp1.id}`);
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.json));

    const preview = await post('/api/hr/employees/import', { mode: 'DRY_RUN', csv });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.mode, 'DRY_RUN');
    assert.equal(preview.json.totalRows, 6);
    assert.equal(preview.json.created, 1, JSON.stringify(preview.json.rows));
    assert.equal(preview.json.updated, 1, JSON.stringify(preview.json.rows));
    assert.equal(preview.json.skipped, 4, JSON.stringify(preview.json.rows));
    const previewRow = (rowNumber: number) =>
      preview.json.rows.find((row: any) => row.rowNumber === rowNumber);
    assert.equal(previewRow(2).action, 'CREATE');
    assert.equal(previewRow(3).action, 'UPDATE');
    assert.equal(previewRow(4).action, 'SKIP');
    assert.match(previewRow(4).errors.join(' '), /unknown branch/i);
    assert.match(previewRow(5).errors.join(' '), /unknown work station/i);
    assert.match(previewRow(6).errors.join(' '), /duplicate/i);
    assert.match(previewRow(7).errors.join(' '), /salary/i);

    // A dry run is a read: no row, no audit and no field changed.
    assert.equal(await jobCount('employees', 'branch_id = $1', [BR]), beforeEmployees);
    assert.equal(await jobCount('audit_logs', "action = 'IMPORT_EMPLOYEES'", []), beforeAudits);
    const stillUnchanged = await get(`/api/employees/${emp1.id}`);
    assert.equal(stillUnchanged.json.designation, unchanged.json.designation);
    assert.equal(stillUnchanged.json.name, unchanged.json.name);

    const committed = await post('/api/hr/employees/import', { mode: 'COMMIT', csv });
    assert.equal(committed.status, 200, JSON.stringify(committed.json));
    assert.equal(committed.json.mode, 'COMMIT');
    assert.equal(committed.json.created, 1, JSON.stringify(committed.json.rows));
    assert.equal(committed.json.updated, 1, JSON.stringify(committed.json.rows));
    assert.equal(committed.json.skipped, 4, JSON.stringify(committed.json.rows));
    assert.equal(await jobCount('employees', 'branch_id = $1', [BR]), beforeEmployees + 1);
    assert.equal(
      await jobCount('audit_logs', "action = 'IMPORT_EMPLOYEES'", []),
      beforeAudits + 1
    );

    const imported = await get(`/api/employees?branchId=${BR}&query=PAYT-IMP-001`);
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    assert.equal(imported.json.length, 1);
    assert.equal(imported.json[0].name, 'Import One');
    assert.equal(imported.json[0].department, 'Operations');
    assert.equal(imported.json[0].workStation, 'PAY Import Station');
    assert.equal(Number(imported.json[0].monthlySalary), 30000);
    assert.equal(imported.json[0].panNumber, 'PAN-IMP-001');
    assert.equal(imported.json[0].isActive, true);

    const updated = await get(`/api/employees/${emp1.id}`);
    assert.equal(updated.json.designation, 'Senior Technician');
    assert.equal(Number(updated.json.monthlySalary), 26500);
    assert.equal(updated.json.workStation, 'PAY Import Station');

    // Re-importing the same sheet updates the same two employees: no duplicates.
    const afterCommit = await jobCount('employees', 'branch_id = $1', [BR]);
    const reimported = await post('/api/hr/employees/import', { mode: 'COMMIT', csv });
    assert.equal(reimported.status, 200, JSON.stringify(reimported.json));
    assert.equal(reimported.json.created, 0, JSON.stringify(reimported.json.rows));
    assert.equal(reimported.json.updated, 2, JSON.stringify(reimported.json.rows));
    assert.equal(reimported.json.skipped, 4, JSON.stringify(reimported.json.rows));
    assert.equal(await jobCount('employees', 'branch_id = $1', [BR]), afterCommit);

    // View-only HR cannot preview or commit.
    const officerToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-import-officer',
      email: 'pay-import-officer@example.com',
      name: 'PAY Import Officer',
      role: 'HR_OFFICER',
    });
    assert.equal(
      (await post('/api/hr/employees/import', { mode: 'DRY_RUN', csv }, officerToken)).status,
      403
    );
    assert.equal(
      (await post('/api/hr/employees/import', { mode: 'COMMIT', csv }, officerToken)).status,
      403
    );

    // The legacy payroll-manage grant still opens the import.
    const accountantToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-import-accountant',
      email: 'pay-import-accountant@example.com',
      name: 'PAY Import Accountant',
      role: 'ACCOUNTANT',
    });
    const legacyPreview = await post(
      '/api/hr/employees/import',
      { mode: 'DRY_RUN', csv },
      accountantToken
    );
    assert.equal(legacyPreview.status, 200, JSON.stringify(legacyPreview.json));

    // A branch-scoped manager cannot import a row for another branch.
    const otherBranchId = 'pay-test-branch-import';
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'PAYB2', 'PAY Test Branch Two', 'Test')
       ON CONFLICT (id) DO NOTHING`,
      [otherBranchId]
    );
    try {
      const scopedToken = issueAuthToken({
        ...ADMIN,
        id: 'pay-import-manager',
        email: 'pay-import-manager@example.com',
        name: 'PAY Import Manager',
        role: 'HR_MANAGER',
        branchId: BR,
        allowedBranchIds: [BR],
      });
      const scopedCsv = [
        'HRMS ID,Full Name,Branch',
        'PAYT-IMP-009,Scoped Import,PAY Test Branch Two',
      ].join('\n');
      const scoped = await post(
        '/api/hr/employees/import',
        { mode: 'DRY_RUN', csv: scopedCsv },
        scopedToken
      );
      assert.equal(scoped.status, 200, JSON.stringify(scoped.json));
      assert.equal(scoped.json.created, 0);
      assert.equal(scoped.json.skipped, 1);
      assert.match(scoped.json.rows[0].errors.join(' '), /allowed branches/i);
    } finally {
      await pool!.query('DELETE FROM branches WHERE id = $1', [otherBranchId]);
    }
  });

  test('attendance foundation: catalogues, branch holidays and an audited daily register', async () => {
    const officerToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-att-officer',
      email: 'pay-att-officer@example.com',
      name: 'PAY Attendance Officer',
      role: 'HR_OFFICER',
    });
    const accountantToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-att-accountant',
      email: 'pay-att-accountant@example.com',
      name: 'PAY Attendance Accountant',
      role: 'ACCOUNTANT',
    });

    // 1. Company-wide catalogues: unique by code and name, editable in place.
    const shift = await post('/api/hr/shifts', {
      name: 'PAY Test Day Shift',
      code: 'PAYT-SHIFT',
      startTime: '09:00',
      endTime: '18:00',
      graceMinutes: 10,
    });
    assert.equal(shift.status, 201, JSON.stringify(shift.json));
    assert.equal(shift.json.code, 'PAYT-SHIFT');
    assert.equal(shift.json.startTime, '09:00');
    assert.equal(shift.json.endTime, '18:00');
    assert.equal(shift.json.graceMinutes, 10);
    assert.equal(shift.json.isActive, true);

    const duplicateShift = await post('/api/hr/shifts', {
      name: 'PAY Test Day Shift Copy',
      code: 'PAYT-SHIFT',
      startTime: '10:00',
      endTime: '19:00',
    });
    assert.equal(duplicateShift.status, 409, JSON.stringify(duplicateShift.json));

    const badShift = await post('/api/hr/shifts', {
      name: 'PAY Bad Shift',
      code: 'PAYT-SHIFT-BAD',
      startTime: '9am',
      endTime: '18:00',
    });
    assert.equal(badShift.status, 400, JSON.stringify(badShift.json));

    const patchedShift = await patch(`/api/hr/shifts/${shift.json.id}`, {
      graceMinutes: 15,
      isActive: false,
    });
    assert.equal(patchedShift.status, 200, JSON.stringify(patchedShift.json));
    assert.equal(patchedShift.json.graceMinutes, 15);
    assert.equal(patchedShift.json.isActive, false);
    const activeShifts = await get('/api/hr/shifts?activeOnly=1');
    assert.equal(activeShifts.status, 200, JSON.stringify(activeShifts.json));
    assert.ok(
      !activeShifts.json.some((row: any) => row.id === shift.json.id),
      'an inactive shift must leave the active catalogue'
    );
    const reactivated = await patch(`/api/hr/shifts/${shift.json.id}`, { isActive: true });
    assert.equal(reactivated.status, 200, JSON.stringify(reactivated.json));

    const leaveType = await post('/api/hr/leave-types', {
      name: 'PAY Test Annual Leave',
      code: 'PAYT-LEAVE',
      annualQuotaDays: 15,
      isPaid: true,
    });
    assert.equal(leaveType.status, 201, JSON.stringify(leaveType.json));
    assert.equal(Number(leaveType.json.annualQuotaDays), 15);
    const duplicateLeave = await post('/api/hr/leave-types', {
      name: 'PAY Test Duplicate Leave',
      code: 'PAYT-LEAVE',
      annualQuotaDays: 5,
    });
    assert.equal(duplicateLeave.status, 409, JSON.stringify(duplicateLeave.json));
    const patchedLeave = await patch(`/api/hr/leave-types/${leaveType.json.id}`, {
      annualQuotaDays: 18,
      isPaid: false,
    });
    assert.equal(patchedLeave.status, 200, JSON.stringify(patchedLeave.json));
    assert.equal(Number(patchedLeave.json.annualQuotaDays), 18);
    assert.equal(patchedLeave.json.isPaid, false);

    // 2. Holidays are branch custody, unique per branch + date, stored with BS.
    const holiday = await post('/api/hr/holidays', {
      branchId: BR,
      holidayDateAD: '2026-09-20',
      name: 'PAY Test Holiday',
      isPaid: true,
    });
    assert.equal(holiday.status, 201, JSON.stringify(holiday.json));
    assert.equal(holiday.json.branchId, BR);
    assert.match(holiday.json.holidayDateBS, / BS$/);
    const duplicateHoliday = await post('/api/hr/holidays', {
      branchId: BR,
      holidayDateAD: '2026-09-20',
      name: 'PAY Test Holiday Duplicate',
    });
    assert.equal(duplicateHoliday.status, 409, JSON.stringify(duplicateHoliday.json));
    const holidays = await get(`/api/hr/holidays?branchId=${BR}&from=2026-09-01&to=2026-09-30`);
    assert.equal(holidays.status, 200, JSON.stringify(holidays.json));
    assert.ok(
      holidays.json.some(
        (row: any) => row.id === holiday.json.id && String(row.holidayDateBS).endsWith(' BS')
      )
    );

    // 3. A manual attendance save derives its branch from the employee and
    //    corrects the same employee/day instead of creating a second row.
    const manual = await post('/api/hr/attendance', {
      employeeId: emp1.id,
      attendanceDateAD: '2026-09-15',
      status: 'PRESENT',
      shiftId: shift.json.id,
      checkInTime: '09:05',
      checkOutTime: '18:10',
      overtimeHours: 1.5,
      notes: 'PAY test manual day',
    });
    assert.equal(manual.status, 201, JSON.stringify(manual.json));
    assert.equal(manual.json.branchId, BR, 'the branch comes from the employee, not the body');
    assert.equal(manual.json.employeeCode, 'PAYT-001');
    assert.equal(manual.json.shiftCode, 'PAYT-SHIFT');
    assert.equal(manual.json.status, 'PRESENT');
    assert.equal(Number(manual.json.overtimeHours), 1.5);
    assert.equal(manual.json.checkInTime, '09:05');
    assert.match(manual.json.attendanceDateBS, / BS$/);
    assert.equal(manual.json.source, 'MANUAL');

    const corrected = await post('/api/hr/attendance', {
      employeeId: emp1.id,
      attendanceDateAD: '2026-09-15',
      status: 'HALF_DAY',
      overtimeHours: 0,
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.json));
    assert.equal(corrected.json.id, manual.json.id);
    assert.equal(corrected.json.status, 'HALF_DAY');
    assert.equal(
      await jobCount('hr_attendance', 'employee_id = $1 AND attendance_date_ad = $2', [
        emp1.id,
        '2026-09-15',
      ]),
      1,
      'a second save corrects the day instead of duplicating it'
    );

    for (const [label, body] of [
      ['unknown shift', { employeeId: emp1.id, attendanceDateAD: '2026-09-15', status: 'PRESENT', shiftId: 'no-such-shift' }],
      ['impossible overtime', { employeeId: emp1.id, attendanceDateAD: '2026-09-15', status: 'PRESENT', overtimeHours: 25 }],
      ['bad clock', { employeeId: emp1.id, attendanceDateAD: '2026-09-15', status: 'PRESENT', checkInTime: '9am' }],
      ['unknown status', { employeeId: emp1.id, attendanceDateAD: '2026-09-15', status: 'SLEEPING' }],
      ['impossible date', { employeeId: emp1.id, attendanceDateAD: '2026-02-30', status: 'PRESENT' }],
      ['missing employee', { attendanceDateAD: '2026-09-15', status: 'PRESENT' }],
    ] as Array<[string, any]>) {
      const refused = await post('/api/hr/attendance', body);
      assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.json)}`);
    }

    const register = await get(
      `/api/hr/attendance?branchId=${BR}&from=2026-09-15&to=2026-09-15&employeeId=${emp1.id}&status=HALF_DAY`
    );
    assert.equal(register.status, 200, JSON.stringify(register.json));
    assert.equal(register.json.length, 1);
    assert.equal(register.json[0].employeeCode, 'PAYT-001');

    assert.equal(
      await jobCount('audit_logs', "action = 'UPSERT_HR_ATTENDANCE' AND branch_id = $1", [BR]),
      2,
      'each manual save writes its audit row in the same transaction'
    );
    assert.equal(
      await jobCount('audit_logs', "action = 'CREATE_HR_HOLIDAY' AND branch_id = $1", [BR]),
      1
    );
    assert.equal(
      await jobCount('audit_logs', "action = 'CREATE_HR_SHIFT' AND details LIKE '%PAYT-SHIFT%'", []),
      1
    );

    // 4. The CSV import upserts every valid row in one transaction and reports
    //    each bad row by sheet line; a re-import updates rather than duplicates.
    const csv = [
      'HRMS ID,Date,Status,Shift,Check-In,Check-Out,OT,Notes',
      'PAYT-002,2026-09-17,Present,PAYT-SHIFT,09:00,18:00,1.5,Imported day',
      'PAYT-001,2026-09-15,Absent,,,,,',
      'PAYT-NOPE,2026-09-17,Present,,,,,',
      'PAYT-001,2026-09-15,Present,,,,,',
      'PAYT-001,2026-13-01,Present,,,,,',
      'PAYT-001,2026-09-18,Sleeping,,,,,',
      'PAYT-001,2026-09-19,Present,GHOST SHIFT,,,,',
      'PAYT-002,2026-09-20,Present,,,25:99,,',
    ].join('\n');

    const beforeImportAudits = await jobCount(
      'audit_logs',
      "action = 'IMPORT_HR_ATTENDANCE' AND branch_id = $1",
      [BR]
    );
    const imported = await post('/api/hr/attendance/import', { csv });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    assert.equal(imported.json.totalRows, 8);
    assert.equal(imported.json.validRows, 2, JSON.stringify(imported.json.rows));
    assert.equal(imported.json.created, 1, JSON.stringify(imported.json.rows));
    assert.equal(imported.json.updated, 1, JSON.stringify(imported.json.rows));
    assert.equal(imported.json.skipped, 6, JSON.stringify(imported.json.rows));
    const importRow = (rowNumber: number) =>
      imported.json.rows.find((row: any) => row.rowNumber === rowNumber);
    assert.equal(importRow(2).action, 'CREATE');
    assert.equal(importRow(2).employeeName, 'Pay Test Two');
    assert.equal(importRow(3).action, 'UPDATE');
    assert.match(importRow(4).errors.join(' '), /unknown employee/i);
    assert.match(importRow(5).errors.join(' '), /duplicate/i);
    assert.match(importRow(6).errors.join(' '), /not a real date/i);
    assert.match(importRow(7).errors.join(' '), /must be one of/i);
    assert.match(importRow(8).errors.join(' '), /unknown shift/i);
    assert.match(importRow(9).errors.join(' '), /check-out time/i);

    assert.equal(
      await jobCount('audit_logs', "action = 'IMPORT_HR_ATTENDANCE' AND branch_id = $1", [BR]),
      beforeImportAudits + 1,
      'one audit row covers the whole imported sheet'
    );
    const importedDay = await get(
      `/api/hr/attendance?branchId=${BR}&employeeId=${emp2.id}&from=2026-09-17&to=2026-09-17`
    );
    assert.equal(importedDay.status, 200, JSON.stringify(importedDay.json));
    assert.equal(importedDay.json.length, 1);
    assert.equal(importedDay.json[0].source, 'IMPORT');
    assert.equal(Number(importedDay.json[0].overtimeHours), 1.5);
    assert.equal(importedDay.json[0].employeeName, 'Pay Test Two');

    for (const date of ['2026-09-18', '2026-09-19', '2026-09-20']) {
      assert.equal(
        await jobCount('hr_attendance', 'employee_id = $1 AND attendance_date_ad = $2', [
          emp1.id,
          date,
        ]),
        0,
        `the skipped ${date} row must not be written`
      );
    }

    const reimported = await post('/api/hr/attendance/import', { csv });
    assert.equal(reimported.status, 200, JSON.stringify(reimported.json));
    assert.equal(reimported.json.created, 0, JSON.stringify(reimported.json.rows));
    assert.equal(reimported.json.updated, 2, JSON.stringify(reimported.json.rows));
    assert.equal(reimported.json.skipped, 6);
    assert.equal(
      await jobCount('hr_attendance', 'employee_id = $1 AND attendance_date_ad = $2', [
        emp2.id,
        '2026-09-17',
      ]),
      1,
      're-import must not duplicate an employee day'
    );
    assert.equal(
      await jobCount('audit_logs', "action = 'IMPORT_HR_ATTENDANCE' AND branch_id = $1", [BR]),
      beforeImportAudits + 2
    );

    // The sheet is the record: the imported row replaces the manual correction.
    const reimportedDay = await get(
      `/api/hr/attendance?branchId=${BR}&employeeId=${emp1.id}&from=2026-09-15&to=2026-09-15`
    );
    assert.equal(reimportedDay.json[0].status, 'ABSENT');
    assert.equal(reimportedDay.json[0].source, 'IMPORT');
    assert.equal(reimportedDay.json[0].notes, null);

    assert.equal(
      (await post('/api/hr/attendance/import', { csv: 'HRMS ID,Date\nPAYT-001,2026-09-15' })).status,
      400,
      'a sheet without a status column is refused, not half-imported'
    );
    assert.equal((await post('/api/hr/attendance/import', { csv: '' })).status, 400);

    // 5. A branch-scoped manager cannot read or write another branch, and the
    //    company-wide catalogues stay usable.
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'PAYA', 'PAY Attendance Branch', 'Test')
       ON CONFLICT (id) DO NOTHING`,
      [ATT_BRANCH]
    );
    const otherEmployee = await post('/api/employees', {
      ...employeeBody('PAYT-900', 'Pay Test Other Branch'),
      branchId: ATT_BRANCH,
    });
    assert.equal(otherEmployee.status, 201, JSON.stringify(otherEmployee.json));
    const otherHoliday = await post('/api/hr/holidays', {
      branchId: ATT_BRANCH,
      holidayDateAD: '2026-09-20',
      name: 'PAY Test Other Holiday',
    });
    assert.equal(otherHoliday.status, 201, JSON.stringify(otherHoliday.json));

    const scopedToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-att-manager',
      email: 'pay-att-manager@example.com',
      name: 'PAY Attendance Manager',
      role: 'HR_MANAGER',
      branchId: BR,
      allowedBranchIds: [BR],
    });
    assert.equal((await get(`/api/hr/attendance?branchId=${ATT_BRANCH}`, scopedToken)).status, 403);
    assert.equal((await get(`/api/hr/holidays?branchId=${ATT_BRANCH}`, scopedToken)).status, 403);
    const scopedList = await get('/api/hr/attendance', scopedToken);
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.json));
    assert.ok(scopedList.json.length > 0);
    assert.ok(
      scopedList.json.every((row: any) => row.branchId === BR),
      'an unscoped read must stay inside the manager branch'
    );
    assert.ok(!scopedList.json.some((row: any) => row.employeeCode === 'PAYT-900'));
    assert.equal(
      (
        await post(
          '/api/hr/attendance',
          { employeeId: otherEmployee.json.id, attendanceDateAD: '2026-09-22', status: 'PRESENT' },
          scopedToken
        )
      ).status,
      403,
      'a manager must not record attendance for another branch employee'
    );
    assert.equal(
      (
        await post(
          '/api/hr/holidays',
          { branchId: ATT_BRANCH, holidayDateAD: '2026-09-23', name: 'PAY Scoped Holiday' },
          scopedToken
        )
      ).status,
      403
    );
    assert.equal(
      (await request('DELETE', `/api/hr/holidays/${otherHoliday.json.id}`, undefined, scopedToken)).status,
      403
    );
    assert.equal((await get('/api/hr/shifts', scopedToken)).status, 200);
    const scopedHoliday = await post(
      '/api/hr/holidays',
      { branchId: BR, holidayDateAD: '2026-09-21', name: 'PAY Scoped Own Holiday' },
      scopedToken
    );
    assert.equal(scopedHoliday.status, 201, JSON.stringify(scopedHoliday.json));

    // 6. A view-only HR officer reads every register and cannot write any of it;
    //    the legacy payroll grant still opens attendance writes.
    for (const path of [
      '/api/hr/shifts',
      '/api/hr/leave-types',
      `/api/hr/holidays?branchId=${BR}`,
      `/api/hr/attendance?branchId=${BR}`,
    ]) {
      const read = await get(path, officerToken);
      assert.equal(read.status, 200, `${path}: ${JSON.stringify(read.json)}`);
    }
    const officerWrites: Array<[string, () => Promise<{ status: number; json: any }>]> = [
      ['shift', () => post('/api/hr/shifts', { name: 'PAY Officer Shift', code: 'PAYT-OFF-SHIFT', startTime: '09:00', endTime: '18:00' }, officerToken)],
      ['leave type', () => post('/api/hr/leave-types', { name: 'PAY Officer Leave', code: 'PAYT-OFF-LEAVE' }, officerToken)],
      ['holiday', () => post('/api/hr/holidays', { branchId: BR, holidayDateAD: '2026-09-24', name: 'PAY Officer Holiday' }, officerToken)],
      ['attendance', () => post('/api/hr/attendance', { employeeId: emp1.id, attendanceDateAD: '2026-09-24', status: 'PRESENT' }, officerToken)],
      ['import', () => post('/api/hr/attendance/import', { csv }, officerToken)],
      ['attendance delete', () => request('DELETE', `/api/hr/attendance/${manual.json.id}`, undefined, officerToken)],
      ['holiday delete', () => request('DELETE', `/api/hr/holidays/${holiday.json.id}`, undefined, officerToken)],
    ];
    for (const [label, call] of officerWrites) {
      const refused = await call();
      assert.equal(refused.status, 403, `${label}: ${JSON.stringify(refused.json)}`);
    }

    const legacyDay = await post(
      '/api/hr/attendance',
      { employeeId: emp2.id, attendanceDateAD: '2026-09-22', status: 'PRESENT' },
      accountantToken
    );
    assert.equal(legacyDay.status, 201, JSON.stringify(legacyDay.json));

    // 7. Deletes are audited, and repeating one is a clean 404.
    assert.equal((await request('DELETE', `/api/hr/attendance/${manual.json.id}`)).status, 204);
    assert.equal((await request('DELETE', `/api/hr/attendance/${manual.json.id}`)).status, 404);
    assert.equal(
      await jobCount('audit_logs', "action = 'DELETE_HR_ATTENDANCE' AND branch_id = $1", [BR]),
      1
    );
    assert.equal((await request('DELETE', `/api/hr/holidays/${holiday.json.id}`)).status, 204);
    assert.equal((await request('DELETE', `/api/hr/holidays/${holiday.json.id}`)).status, 404);
  });

  test('leave balances and requests: approvals spend days, cancels return them, branches stay isolated', async () => {
    const officerToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-leave-officer',
      email: 'pay-leave-officer@example.com',
      name: 'PAY Leave Officer',
      role: 'HR_OFFICER',
    });
    const accountantToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-leave-accountant',
      email: 'pay-leave-accountant@example.com',
      name: 'PAY Leave Accountant',
      role: 'ACCOUNTANT',
    });

    const balanceFor = async (employeeId: string, status?: string) => {
      const query = new URLSearchParams({
        branchId: BR,
        year: '2026',
        employeeId,
        ...(status ? { status } : {}),
      });
      const res = await get(`/api/hr/leave-balances?${query.toString()}`);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      return res.json;
    };

    // 1. One balance row per employee + leave type + year; usage is derived.
    const leaveType = await post('/api/hr/leave-types', {
      name: 'PAY Test Leave Annual',
      code: 'PAYT-LV-ANN',
      annualQuotaDays: 15,
      isPaid: true,
    });
    assert.equal(leaveType.status, 201, JSON.stringify(leaveType.json));

    const balance = await post('/api/hr/leave-balances', {
      employeeId: emp1.id,
      leaveTypeId: leaveType.json.id,
      balanceYear: 2026,
      entitlementDays: 10,
      notes: 'annual entitlement',
    });
    assert.equal(balance.status, 201, JSON.stringify(balance.json));
    assert.equal(balance.json.employeeCode, 'PAYT-001');
    assert.equal(balance.json.branchId, BR, 'the balance branch comes from the employee');
    assert.equal(Number(balance.json.entitlementDays), 10);
    assert.equal(Number(balance.json.usedDays), 0);
    assert.equal(Number(balance.json.remainingDays), 10);

    const duplicateBalance = await post('/api/hr/leave-balances', {
      employeeId: emp1.id,
      leaveTypeId: leaveType.json.id,
      balanceYear: 2026,
      entitlementDays: 5,
    });
    assert.equal(duplicateBalance.status, 409, JSON.stringify(duplicateBalance.json));

    const invalidYear = await post('/api/hr/leave-balances', {
      employeeId: emp1.id,
      leaveTypeId: leaveType.json.id,
      balanceYear: 1999,
      entitlementDays: 5,
    });
    assert.equal(invalidYear.status, 400, JSON.stringify(invalidYear.json));

    const patchedBalance = await patch(`/api/hr/leave-balances/${balance.json.id}`, {
      adjustmentDays: 2,
      notes: 'carry over',
    });
    assert.equal(patchedBalance.status, 200, JSON.stringify(patchedBalance.json));
    assert.equal(Number(patchedBalance.json.adjustmentDays), 2);
    assert.equal(Number(patchedBalance.json.remainingDays), 12);
    assert.equal(
      await jobCount('audit_logs', "action = 'UPDATE_HR_LEAVE_BALANCE' AND branch_id = $1", [BR]),
      1
    );

    // 2. Request creation validates the range, the calendar year and overlaps.
    const created = await post('/api/hr/leave-requests', {
      employeeId: emp1.id,
      leaveTypeId: leaveType.json.id,
      startDateAD: '2026-10-05',
      endDateAD: '2026-10-06',
      reason: 'family function',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.match(created.json.requestNo, /^LR-2026-/);
    assert.equal(created.json.status, 'PENDING');
    assert.equal(created.json.branchId, BR);
    assert.equal(Number(created.json.daysCount), 2, 'the day count is inclusive');
    assert.match(created.json.startDateBS, / BS$/);
    assert.equal(
      await jobCount('audit_logs', "action = 'CREATE_HR_LEAVE_REQUEST' AND branch_id = $1", [BR]),
      1,
      'the create and its audit row commit together'
    );

    const overlap = await post('/api/hr/leave-requests', {
      employeeId: emp1.id,
      leaveTypeId: leaveType.json.id,
      startDateAD: '2026-10-06',
      endDateAD: '2026-10-07',
    });
    assert.equal(overlap.status, 409, JSON.stringify(overlap.json));
    assert.match(overlap.json.message, /already covers/i);

    for (const [label, body] of [
      ['reversed range', { employeeId: emp1.id, leaveTypeId: leaveType.json.id, startDateAD: '2026-10-10', endDateAD: '2026-10-09' }],
      ['cross-year range', { employeeId: emp1.id, leaveTypeId: leaveType.json.id, startDateAD: '2026-12-30', endDateAD: '2027-01-02' }],
      ['unknown leave type', { employeeId: emp1.id, leaveTypeId: 'no-such-type', startDateAD: '2026-11-01', endDateAD: '2026-11-02' }],
      ['missing employee', { leaveTypeId: leaveType.json.id, startDateAD: '2026-11-01', endDateAD: '2026-11-02' }],
      ['bad date', { employeeId: emp1.id, leaveTypeId: leaveType.json.id, startDateAD: '2026-02-30', endDateAD: '2026-03-01' }],
    ] as Array<[string, any]>) {
      const refused = await post('/api/hr/leave-requests', body);
      assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.json)}`);
    }
    assert.equal(
      await jobCount('audit_logs', "action = 'CREATE_HR_LEAVE_REQUEST' AND branch_id = $1", [BR]),
      1,
      'a rejected create writes no audit row'
    );

    const requestList = await get(
      `/api/hr/leave-requests?branchId=${BR}&employeeId=${emp1.id}&status=PENDING`
    );
    assert.equal(requestList.status, 200, JSON.stringify(requestList.json));
    assert.equal(requestList.json.length, 1);
    assert.equal(requestList.json[0].id, created.json.id);
    assert.equal(requestList.json[0].leaveTypeCode, 'PAYT-LV-ANN');

    // 3. Approval spends the balance; the transition is guarded.
    const approved = await post(`/api/hr/leave-requests/${created.json.id}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.status, 'APPROVED');
    assert.ok(approved.json.decidedBy, 'the approver is recorded');
    assert.ok(approved.json.decidedAt, 'the decision time is recorded');
    const afterApprove = await balanceFor(emp1.id);
    assert.equal(Number(afterApprove[0].usedDays), 2);
    assert.equal(Number(afterApprove[0].remainingDays), 10);
    assert.equal(
      await jobCount('audit_logs', "action = 'APPROVE_HR_LEAVE_REQUEST' AND branch_id = $1", [BR]),
      1
    );
    assert.equal(
      (await post(`/api/hr/leave-requests/${created.json.id}/approve`, {})).status,
      409,
      'a second approval must not spend the balance twice'
    );

    // 4. A rejection writes the decision but spends nothing.
    const toReject = await post('/api/hr/leave-requests', {
      employeeId: emp1.id,
      leaveTypeId: leaveType.json.id,
      startDateAD: '2026-11-02',
      endDateAD: '2026-11-03',
    });
    assert.equal(toReject.status, 201, JSON.stringify(toReject.json));
    const rejected = await post(`/api/hr/leave-requests/${toReject.json.id}/reject`, {
      note: 'team is on site',
    });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.json));
    assert.equal(rejected.json.status, 'REJECTED');
    assert.equal(rejected.json.decisionNote, 'team is on site');
    const afterReject = await balanceFor(emp1.id);
    assert.equal(Number(afterReject[0].usedDays), 2, 'a rejected request spends nothing');

    // 5. Cancelling an approved request returns its days, and a pending cancel
    //    is allowed without touching usage.
    const cancelled = await post(`/api/hr/leave-requests/${created.json.id}/cancel`, {});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
    assert.equal(cancelled.json.status, 'CANCELLED');
    const afterCancel = await balanceFor(emp1.id);
    assert.equal(Number(afterCancel[0].usedDays), 0, 'cancelling an approval returns the days');
    assert.equal(Number(afterCancel[0].remainingDays), 12);
    assert.equal(
      await jobCount('audit_logs', "action = 'CANCEL_HR_LEAVE_REQUEST' AND branch_id = $1", [BR]),
      1
    );

    const toCancel = await post('/api/hr/leave-requests', {
      employeeId: emp1.id,
      leaveTypeId: leaveType.json.id,
      startDateAD: '2026-11-10',
      endDateAD: '2026-11-10',
    });
    assert.equal((await post(`/api/hr/leave-requests/${toCancel.json.id}/cancel`, {})).status, 200);

    // 6. Approval refuses a request that exceeds the configured balance, and a
    //    request with no balance row at all.
    const emp2Balance = await post('/api/hr/leave-balances', {
      employeeId: emp2.id,
      leaveTypeId: leaveType.json.id,
      balanceYear: 2026,
      entitlementDays: 1,
    });
    assert.equal(emp2Balance.status, 201, JSON.stringify(emp2Balance.json));
    assert.equal(
      await jobCount('audit_logs', "action = 'CREATE_HR_LEAVE_BALANCE' AND branch_id = $1", [BR]),
      2
    );
    const tooBig = await post('/api/hr/leave-requests', {
      employeeId: emp2.id,
      leaveTypeId: leaveType.json.id,
      startDateAD: '2026-12-01',
      endDateAD: '2026-12-03',
    });
    assert.equal(tooBig.status, 201, JSON.stringify(tooBig.json));
    const insufficient = await post(`/api/hr/leave-requests/${tooBig.json.id}/approve`, {});
    assert.equal(insufficient.status, 409, JSON.stringify(insufficient.json));
    assert.match(insufficient.json.message, /insufficient leave balance/i);
    assert.equal(
      await jobCount('audit_logs', "action = 'APPROVE_HR_LEAVE_REQUEST' AND branch_id = $1", [BR]),
      1,
      'a refused approval writes no audit row'
    );
    const stillPending = await get(
      `/api/hr/leave-requests?branchId=${BR}&employeeId=${emp2.id}&status=PENDING`
    );
    assert.equal(stillPending.status, 200);
    assert.equal(stillPending.json.length, 1);
    assert.equal(stillPending.json[0].id, tooBig.json.id);

    const sickType = await post('/api/hr/leave-types', {
      name: 'PAY Test Sick Leave',
      code: 'PAYT-LV-SICK',
      annualQuotaDays: 5,
    });
    assert.equal(sickType.status, 201, JSON.stringify(sickType.json));
    const noBalance = await post('/api/hr/leave-requests', {
      employeeId: emp1.id,
      leaveTypeId: sickType.json.id,
      startDateAD: '2026-12-05',
      endDateAD: '2026-12-05',
    });
    assert.equal(noBalance.status, 201, JSON.stringify(noBalance.json));
    const noBalanceApproval = await post(`/api/hr/leave-requests/${noBalance.json.id}/approve`, {});
    assert.equal(noBalanceApproval.status, 409, JSON.stringify(noBalanceApproval.json));
    assert.match(noBalanceApproval.json.message, /balance is configured/i);
    assert.equal((await post(`/api/hr/leave-requests/${noBalance.json.id}/cancel`, {})).status, 200);

    // 7. Another branch's employees, balances and requests are invisible and
    //    unwritable to a branch-scoped manager.
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'PAYLV', 'PAY Leave Branch', 'Test')
       ON CONFLICT (id) DO NOTHING`,
      [LV_BRANCH]
    );
    const otherEmployee = await post('/api/employees', {
      ...employeeBody('PAYT-950', 'Pay Test Leave Branch'),
      branchId: LV_BRANCH,
    });
    assert.equal(otherEmployee.status, 201, JSON.stringify(otherEmployee.json));
    const otherBalance = await post('/api/hr/leave-balances', {
      employeeId: otherEmployee.json.id,
      leaveTypeId: leaveType.json.id,
      balanceYear: 2026,
      entitlementDays: 5,
    });
    assert.equal(otherBalance.status, 201, JSON.stringify(otherBalance.json));
    assert.equal(otherBalance.json.branchId, LV_BRANCH);
    const otherRequest = await post('/api/hr/leave-requests', {
      employeeId: otherEmployee.json.id,
      leaveTypeId: leaveType.json.id,
      startDateAD: '2026-10-05',
      endDateAD: '2026-10-05',
    });
    assert.equal(otherRequest.status, 201, JSON.stringify(otherRequest.json));
    assert.equal(otherRequest.json.branchId, LV_BRANCH);

    const scopedToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-leave-manager',
      email: 'pay-leave-manager@example.com',
      name: 'PAY Leave Manager',
      role: 'HR_MANAGER',
      branchId: BR,
      allowedBranchIds: [BR],
    });
    assert.equal(
      (await get(`/api/hr/leave-requests?branchId=${LV_BRANCH}`, scopedToken)).status,
      403
    );
    assert.equal(
      (await get(`/api/hr/leave-balances?branchId=${LV_BRANCH}`, scopedToken)).status,
      403
    );
    assert.equal(
      (await get(`/api/hr/leave-requests?employeeId=${otherEmployee.json.id}`, scopedToken)).status,
      403
    );
    assert.equal(
      (await get(`/api/hr/leave-balances?employeeId=${otherEmployee.json.id}`, scopedToken)).status,
      403
    );
    assert.equal(
      (
        await post(
          '/api/hr/leave-requests',
          {
            employeeId: otherEmployee.json.id,
            leaveTypeId: leaveType.json.id,
            startDateAD: '2026-11-01',
            endDateAD: '2026-11-01',
          },
          scopedToken
        )
      ).status,
      403
    );
    assert.equal(
      (
        await post(
          '/api/hr/leave-balances',
          {
            employeeId: otherEmployee.json.id,
            leaveTypeId: leaveType.json.id,
            balanceYear: 2027,
            entitlementDays: 5,
          },
          scopedToken
        )
      ).status,
      403
    );
    assert.equal(
      (await patch(`/api/hr/leave-balances/${otherBalance.json.id}`, { entitlementDays: 9 }, scopedToken))
        .status,
      403
    );
    assert.equal(
      (await post(`/api/hr/leave-requests/${otherRequest.json.id}/approve`, {}, scopedToken)).status,
      403
    );
    const scopedList = await get('/api/hr/leave-requests', scopedToken);
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.json));
    assert.ok(scopedList.json.length > 0);
    assert.ok(
      scopedList.json.every((row: any) => row.branchId === BR),
      'an unscoped read must stay inside the manager branch'
    );
    assert.ok(!scopedList.json.some((row: any) => row.employeeCode === 'PAYT-950'));

    // 8. A view-only HR officer reads lists but cannot write or decide.
    const officerTarget = await post('/api/hr/leave-requests', {
      employeeId: emp1.id,
      leaveTypeId: leaveType.json.id,
      startDateAD: '2026-12-15',
      endDateAD: '2026-12-15',
    });
    assert.equal(officerTarget.status, 201, JSON.stringify(officerTarget.json));
    for (const path of ['/api/hr/leave-requests', '/api/hr/leave-balances']) {
      assert.equal((await get(path, officerToken)).status, 200, `${path} must be readable`);
    }
    const officerWrites: Array<[string, () => Promise<{ status: number; json: any }>]> = [
      ['balance create', () => post('/api/hr/leave-balances', { employeeId: emp1.id, leaveTypeId: leaveType.json.id, balanceYear: 2027, entitlementDays: 5 }, officerToken)],
      ['balance edit', () => patch(`/api/hr/leave-balances/${balance.json.id}`, { entitlementDays: 11 }, officerToken)],
      ['request create', () => post('/api/hr/leave-requests', { employeeId: emp1.id, leaveTypeId: leaveType.json.id, startDateAD: '2026-12-28', endDateAD: '2026-12-28' }, officerToken)],
      ['approve', () => post(`/api/hr/leave-requests/${officerTarget.json.id}/approve`, {}, officerToken)],
      ['reject', () => post(`/api/hr/leave-requests/${officerTarget.json.id}/reject`, {}, officerToken)],
      ['cancel', () => post(`/api/hr/leave-requests/${officerTarget.json.id}/cancel`, {}, officerToken)],
    ];
    for (const [label, call] of officerWrites) {
      const refused = await call();
      assert.equal(refused.status, 403, `${label}: ${JSON.stringify(refused.json)}`);
    }
    assert.equal(
      (await get(`/api/hr/leave-requests?branchId=${BR}&status=PENDING`)).json.length >= 1,
      true
    );
    assert.equal((await post(`/api/hr/leave-requests/${officerTarget.json.id}/cancel`, {})).status, 200);

    // 9. The legacy payroll grant still opens leave writes, and usage follows.
    const legacyRequest = await post(
      '/api/hr/leave-requests',
      {
        employeeId: emp1.id,
        leaveTypeId: leaveType.json.id,
        startDateAD: '2026-12-20',
        endDateAD: '2026-12-20',
      },
      accountantToken
    );
    assert.equal(legacyRequest.status, 201, JSON.stringify(legacyRequest.json));
    const legacyApproved = await post(
      `/api/hr/leave-requests/${legacyRequest.json.id}/approve`,
      {},
      accountantToken
    );
    assert.equal(legacyApproved.status, 200, JSON.stringify(legacyApproved.json));
    assert.equal(legacyApproved.json.status, 'APPROVED');
    const afterLegacy = await balanceFor(emp1.id);
    assert.equal(Number(afterLegacy[0].usedDays), 1);
    assert.equal(Number(afterLegacy[0].remainingDays), 11);

    assert.equal((await post('/api/hr/leave-requests', { employeeId: 'missing-employee', leaveTypeId: leaveType.json.id, startDateAD: '2026-12-01', endDateAD: '2026-12-01' })).status, 404);
  });

  test('payroll inputs: payable, LOP and OT derive from attendance and approved leave', async () => {
    const officerToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-pi-officer',
      email: 'pay-pi-officer@example.com',
      name: 'PAY Payroll Inputs Officer',
      role: 'HR_OFFICER',
    });
    const accountantToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-pi-accountant',
      email: 'pay-pi-accountant@example.com',
      name: 'PAY Payroll Inputs Accountant',
      role: 'ACCOUNTANT',
    });
    const period = 'from=2026-07-01&to=2026-07-31';

    // 1. One paid and one unpaid leave type, each with a 2026 balance.
    const paidType = await post('/api/hr/leave-types', {
      name: 'PAY Test Payroll Paid Leave',
      code: 'PAYT-PI-PAID',
      annualQuotaDays: 30,
      isPaid: true,
    });
    assert.equal(paidType.status, 201, JSON.stringify(paidType.json));
    const unpaidType = await post('/api/hr/leave-types', {
      name: 'PAY Test Payroll Unpaid Leave',
      code: 'PAYT-PI-UNPAID',
      annualQuotaDays: 10,
      isPaid: false,
    });
    assert.equal(unpaidType.status, 201, JSON.stringify(unpaidType.json));
    for (const type of [paidType, unpaidType]) {
      const balance = await post('/api/hr/leave-balances', {
        employeeId: emp1.id,
        leaveTypeId: type.json.id,
        balanceYear: 2026,
        entitlementDays: 30,
      });
      assert.equal(balance.status, 201, JSON.stringify(balance.json));
    }

    // 2. The July register: present (with OT), absent, half day, holiday,
    //    weekend, a LEAVE-coded day and a present day covered by leave.
    const attendanceDays: Array<[string, string, number]> = [
      ['2026-07-01', 'PRESENT', 2],
      ['2026-07-02', 'PRESENT', 1.5],
      ['2026-07-03', 'ABSENT', 0],
      ['2026-07-04', 'HALF_DAY', 1],
      ['2026-07-05', 'HOLIDAY', 0],
      ['2026-07-06', 'WEEKEND', 0],
      ['2026-07-08', 'LEAVE', 0],
      ['2026-07-16', 'PRESENT', 0],
    ];
    for (const [date, status, ot] of attendanceDays) {
      const saved = await post('/api/hr/attendance', {
        employeeId: emp1.id,
        attendanceDateAD: date,
        status,
        overtimeHours: ot,
      });
      assert.equal(saved.status, 201, `${date}: ${JSON.stringify(saved.json)}`);
    }

    // 3. Approved leave: paid inside the period, unpaid inside, a request that
    //    starts before the period, one that ends after it, and one whose days
    //    are already covered by attendance. Pending and rejected stay out.
    const requestLeave = async (typeId: string, start: string, end: string) => {
      const saved = await post('/api/hr/leave-requests', {
        employeeId: emp1.id,
        leaveTypeId: typeId,
        startDateAD: start,
        endDateAD: end,
      });
      assert.equal(saved.status, 201, JSON.stringify(saved.json));
      return saved;
    };
    const approve = async (id: string) => {
      const approved = await post(`/api/hr/leave-requests/${id}/approve`, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.json));
    };

    const paidInside = await requestLeave(paidType.json.id, '2026-07-10', '2026-07-11');
    await approve(paidInside.json.id);
    const unpaidInside = await requestLeave(unpaidType.json.id, '2026-07-13', '2026-07-14');
    await approve(unpaidInside.json.id);
    // 3 days, but only 1 July day falls in the period and that day already has
    // an attendance row: it must contribute zero, not one and not three.
    const startsBefore = await requestLeave(paidType.json.id, '2026-06-29', '2026-07-01');
    await approve(startsBefore.json.id);
    // 2 of its 4 days fall in July (30–31) and both are unrecorded.
    const endsAfter = await requestLeave(paidType.json.id, '2026-07-30', '2026-08-02');
    await approve(endsAfter.json.id);
    // 16 July has attendance; only 17 July is filled by this request.
    const partlyRecorded = await requestLeave(paidType.json.id, '2026-07-16', '2026-07-17');
    await approve(partlyRecorded.json.id);
    const pending = await requestLeave(paidType.json.id, '2026-07-20', '2026-07-20');
    assert.equal(pending.json.status, 'PENDING');
    const rejected = await requestLeave(paidType.json.id, '2026-07-22', '2026-07-22');
    assert.equal(
      (await post(`/api/hr/leave-requests/${rejected.json.id}/reject`, {})).status,
      200
    );

    // 4. The derivation: 3 present + 0.5 half + 1 attendance leave + 1 holiday
    //    + 1 weekend + (2 + 2 + 1) paid leave = 11.5 payable; 1 absent + 0.5
    //    half + 2 unpaid leave = 3.5 LOP; 4.5 OT hours.
    const inputs = await get(
      `/api/hr/payroll-inputs?branchId=${BR}&${period}&employeeId=${emp1.id}`
    );
    assert.equal(inputs.status, 200, JSON.stringify(inputs.json));
    const row = inputs.json.find((entry: any) => entry.employeeId === emp1.id);
    assert.ok(row, 'the employee must have a payroll-input row');
    assert.equal(row.employeeCode, 'PAYT-001');
    assert.equal(row.branchId, BR);
    assert.equal(Number(row.presentDays), 3);
    assert.equal(Number(row.halfDays), 1);
    assert.equal(Number(row.absentDays), 1);
    assert.equal(Number(row.attendanceLeaveDays), 1);
    assert.equal(Number(row.holidayDays), 1);
    assert.equal(Number(row.weekendDays), 1);
    assert.equal(Number(row.paidLeaveDays), 5, 'approved paid leave, clipped and not double-counted');
    assert.equal(Number(row.unpaidLeaveDays), 2);
    assert.equal(Number(row.payableDays), 11.5);
    assert.equal(Number(row.lopDays), 3.5);
    assert.equal(Number(row.overtimeHours), 4.5);

    // A second employee with no July data still gets a zero row: September
    // attendance must stay outside the July period.
    const other = await get(
      `/api/hr/payroll-inputs?branchId=${BR}&${period}&employeeId=${emp2.id}`
    );
    assert.equal(other.status, 200, JSON.stringify(other.json));
    assert.equal(other.json.length, 1);
    assert.equal(Number(other.json[0].payableDays), 0);
    assert.equal(Number(other.json[0].lopDays), 0);
    assert.equal(Number(other.json[0].overtimeHours), 0);

    const roster = await get(`/api/hr/payroll-inputs?branchId=${BR}&${period}`);
    assert.equal(roster.status, 200, JSON.stringify(roster.json));
    assert.ok(roster.json.some((entry: any) => entry.employeeId === emp1.id));
    assert.ok(roster.json.some((entry: any) => entry.employeeId === emp2.id));

    for (const [label, query] of [
      ['missing from', `to=2026-07-31`],
      ['missing to', `from=2026-07-01`],
      ['reversed period', `from=2026-08-01&to=2026-07-01`],
      ['impossible date', `from=2026-02-30&to=2026-03-01`],
      ['over one year', `from=2026-01-01&to=2027-12-31`],
    ] as Array<[string, string]>) {
      const refused = await get(`/api/hr/payroll-inputs?branchId=${BR}&${query}`);
      assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.json)}`);
    }
    assert.equal(
      (await get(`/api/hr/payroll-inputs?branchId=${BR}&${period}&employeeId=no-such-employee`)).status,
      404
    );

    // 5. Branch scope: another branch's employee is invisible to a scoped
    //    manager, and a named out-of-scope employee is refused, not blanked.
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'PAYPI', 'PAY Payroll Inputs Branch', 'Test')
       ON CONFLICT (id) DO NOTHING`,
      [PI_BRANCH]
    );
    const outsideEmployee = await post('/api/employees', {
      ...employeeBody('PAYT-960', 'Pay Test Payroll Branch'),
      branchId: PI_BRANCH,
    });
    assert.equal(outsideEmployee.status, 201, JSON.stringify(outsideEmployee.json));
    const outsideDay = await post('/api/hr/attendance', {
      employeeId: outsideEmployee.json.id,
      attendanceDateAD: '2026-07-07',
      status: 'PRESENT',
      overtimeHours: 2,
    });
    assert.equal(outsideDay.status, 201, JSON.stringify(outsideDay.json));

    const scopedToken = issueAuthToken({
      ...ADMIN,
      id: 'pay-pi-manager',
      email: 'pay-pi-manager@example.com',
      name: 'PAY Payroll Inputs Manager',
      role: 'HR_MANAGER',
      branchId: BR,
      allowedBranchIds: [BR],
    });
    assert.equal(
      (await get(`/api/hr/payroll-inputs?branchId=${PI_BRANCH}&${period}`, scopedToken)).status,
      403
    );
    assert.equal(
      (
        await get(
          `/api/hr/payroll-inputs?${period}&employeeId=${outsideEmployee.json.id}`,
          scopedToken
        )
      ).status,
      403
    );
    const scopedRoster = await get(`/api/hr/payroll-inputs?${period}`, scopedToken);
    assert.equal(scopedRoster.status, 200, JSON.stringify(scopedRoster.json));
    assert.ok(scopedRoster.json.length > 0);
    assert.ok(scopedRoster.json.every((entry: any) => entry.branchId === BR));
    assert.ok(!scopedRoster.json.some((entry: any) => entry.employeeCode === 'PAYT-960'));
    const globalOutside = await get(`/api/hr/payroll-inputs?branchId=${PI_BRANCH}&${period}`);
    assert.equal(globalOutside.status, 200, JSON.stringify(globalOutside.json));
    const outsideRow = globalOutside.json.find(
      (entry: any) => entry.employeeId === outsideEmployee.json.id
    );
    assert.ok(outsideRow);
    assert.equal(Number(outsideRow.payableDays), 1);
    assert.equal(Number(outsideRow.overtimeHours), 2);

    // 6. Read grants: the view-only officer and the legacy payroll manager can
    //    read the projection; it has no write surface to gate.
    const auditsBeforeReads = await jobCount('audit_logs', 'branch_id = $1', [BR]);
    assert.equal((await get(`/api/hr/payroll-inputs?branchId=${BR}&${period}`, officerToken)).status, 200);
    assert.equal(
      (await get(`/api/hr/payroll-inputs?branchId=${BR}&${period}`, accountantToken)).status,
      200
    );
    assert.equal((await post('/api/hr/payroll-inputs', {}, officerToken)).status, 404);
    assert.equal((await post('/api/hr/payroll-inputs', {})).status, 404);

    // Reads must not write: the projection is derived, and no audit row is
    // created by any of the calls above.
    assert.equal(
      await jobCount('audit_logs', 'branch_id = $1', [BR]),
      auditsBeforeReads,
      'a read-only projection never writes an audit row'
    );
  });
});
