/**
 * Phase 4 recruitment API — real HTTP + PostgreSQL.
 *
 * The fixture drives one complete requisition → candidate → interview → offer
 * → hire flow, then proves the two safety rules the plan calls out: a candidate
 * cannot become an employee before its offer is ACCEPTED, and a branch account
 * cannot read or write another branch. Resume bytes are uploaded through the
 * raw-body route and read back byte-for-byte.
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

const BRANCH_A = 'hr-rec-br-a';
const BRANCH_B = 'hr-rec-br-b';

const MANAGER_A = {
  id: 'hr-rec-user-a',
  email: 'hr-rec-a@example.com',
  name: 'Recruitment Manager A',
  role: 'HR_MANAGER',
  branchId: BRANCH_A,
  allowedBranchIds: [BRANCH_A],
  canSwitchUser: false,
} as any;

const MANAGER_B = {
  id: 'hr-rec-user-b',
  email: 'hr-rec-b@example.com',
  name: 'Recruitment Manager B',
  role: 'HR_MANAGER',
  branchId: BRANCH_B,
  allowedBranchIds: [BRANCH_B],
  canSwitchUser: false,
} as any;

describe('HR recruitment API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const managerAToken = issueAuthToken(MANAGER_A);
  const managerBToken = issueAuthToken(MANAGER_B);
  let requisitionAId = '';
  let candidateAId = '';
  let candidateWithoutOfferId = '';

  async function cleanup() {
    await pool!.query(
      'DELETE FROM hr_recruitment_interviews WHERE branch_id = ANY($1::varchar[])',
      [[BRANCH_A, BRANCH_B]]
    );
    await pool!.query(
      'DELETE FROM hr_recruitment_offers WHERE branch_id = ANY($1::varchar[])',
      [[BRANCH_A, BRANCH_B]]
    );
    await pool!.query(
      'DELETE FROM hr_recruitment_candidates WHERE branch_id = ANY($1::varchar[])',
      [[BRANCH_A, BRANCH_B]]
    );
    await pool!.query(
      'DELETE FROM hr_recruitment_requisitions WHERE branch_id = ANY($1::varchar[])',
      [[BRANCH_A, BRANCH_B]]
    );
    await pool!.query(
      'DELETE FROM employees WHERE branch_id = ANY($1::varchar[]) AND employee_code LIKE $2',
      [[BRANCH_A, BRANCH_B], 'HRREC-%']
    );
    await pool!.query('DELETE FROM users WHERE id LIKE $1', ['hr-rec-user-%']);
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [
      [BRANCH_A, BRANCH_B],
    ]);
  }

  async function request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    auth: string | null,
    payload?: unknown,
    contentType?: string
  ) {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bearer ${auth}`;
    let body: any;
    if (payload !== undefined) {
      if (Buffer.isBuffer(payload)) {
        body = payload;
        headers['Content-Type'] = contentType || 'application/octet-stream';
      } else if (typeof payload === 'string') {
        body = payload;
        headers['Content-Type'] = contentType || 'text/plain';
      } else {
        body = JSON.stringify(payload);
        headers['Content-Type'] = 'application/json';
      }
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

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'RECA', 'Recruitment Branch A', 'Test'),
              ($2, 'RECB', 'Recruitment Branch B', 'Test')`,
      [BRANCH_A, BRANCH_B]
    );
    for (const user of [MANAGER_A, MANAGER_B]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, $4, $5, ARRAY[$6]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId, user.branchId]
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
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('saves requisition, candidate, interview, offer and only hires an accepted offer', async () => {
    const requisition = await request(
      'POST',
      '/api/hr/recruitment/requisitions',
      managerAToken,
      {
        branchId: BRANCH_A,
        title: 'Network Engineer',
        department: 'Operations',
        designation: 'Network Engineer',
        employmentType: 'FULL_TIME',
        openings: 2,
        status: 'OPEN',
        openedOnAD: '2026-11-01',
        closesOnAD: '2026-12-31',
        description: 'Field and branch network support.',
      }
    );
    assert.equal(requisition.status, 201, JSON.stringify(requisition.json));
    requisitionAId = requisition.json.id;
    assert.equal(requisition.json.requisitionNo.startsWith('REQ-'), true);
    assert.equal(requisition.json.branchId, BRANCH_A);
    assert.equal(requisition.json.status, 'OPEN');
    assert.equal(requisition.json.candidateCount, 0);
    assert.equal(requisition.json.hiredCount, 0);

    const candidate = await request(
      'POST',
      '/api/hr/recruitment/candidates',
      managerAToken,
      {
        requisitionId: requisitionAId,
        name: 'Recruitment Candidate A',
        email: 'hr-rec-candidate-a@example.com',
        phone: '9800000001',
        source: 'Referral',
      }
    );
    assert.equal(candidate.status, 201, JSON.stringify(candidate.json));
    candidateAId = candidate.json.id;
    assert.equal(candidate.json.branchId, BRANCH_A, 'the candidate inherits the requisition branch');
    assert.equal(candidate.json.status, 'NEW');
    assert.equal(candidate.json.hasResume, false);

    const interview = await request(
      'POST',
      '/api/hr/recruitment/interviews',
      managerAToken,
      {
        candidateId: candidateAId,
        roundName: 'Technical',
        scheduledOnAD: '2026-11-15',
        interviewer: 'Recruitment Manager A',
        mode: 'VIDEO',
        status: 'COMPLETED',
        rating: 4,
      }
    );
    assert.equal(interview.status, 201, JSON.stringify(interview.json));
    assert.equal(interview.json.branchId, BRANCH_A);
    assert.equal(interview.json.rating, 4);

    const afterInterview = await request(
      'GET',
      `/api/hr/recruitment/candidates?requisitionId=${requisitionAId}`,
      managerAToken
    );
    assert.equal(afterInterview.status, 200, JSON.stringify(afterInterview.json));
    assert.equal(afterInterview.headers.get('cache-control'), 'private, no-store');
    assert.equal(afterInterview.json.length, 1);
    assert.equal(afterInterview.json[0].status, 'INTERVIEW');
    assert.equal(afterInterview.json[0].interviewCount, 1);

    const offer = await request('POST', '/api/hr/recruitment/offers', managerAToken, {
      candidateId: candidateAId,
      positionTitle: 'Network Engineer',
      monthlySalary: 50_000,
      startDateAD: '2026-12-01',
      offeredOnAD: '2026-11-16',
      status: 'DRAFT',
    });
    assert.equal(offer.status, 201, JSON.stringify(offer.json));
    assert.equal(offer.json.branchId, BRANCH_A);
    assert.equal(offer.json.monthlySalary, 50_000);
    assert.equal(offer.json.status, 'DRAFT');

    const refusedBeforeAcceptance = await request(
      'POST',
      `/api/hr/recruitment/candidates/${candidateAId}/hire`,
      managerAToken,
      { employeeCode: 'HRREC-1001' }
    );
    assert.equal(refusedBeforeAcceptance.status, 409, JSON.stringify(refusedBeforeAcceptance.json));
    assert.match(refusedBeforeAcceptance.json.message, /offer must be accepted/i);
    const employeeBefore = await pool!.query(
      'SELECT id FROM employees WHERE employee_code = $1',
      ['HRREC-1001']
    );
    assert.equal(employeeBefore.rowCount, 0, 'a refused hire creates no employee');

    const sent = await request(
      'PATCH',
      `/api/hr/recruitment/offers/${offer.json.id}`,
      managerAToken,
      { status: 'SENT' }
    );
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.status, 'SENT');

    const accepted = await request(
      'PATCH',
      `/api/hr/recruitment/offers/${offer.json.id}`,
      managerAToken,
      { status: 'ACCEPTED' }
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.status, 'ACCEPTED');
    assert.match(accepted.json.respondedOnAD, /^\d{4}-\d{2}-\d{2}$/);

    const finalAgain = await request(
      'PATCH',
      `/api/hr/recruitment/offers/${offer.json.id}`,
      managerAToken,
      { status: 'ACCEPTED' }
    );
    assert.equal(finalAgain.status, 409, 'an accepted offer is final');

    const hired = await request(
      'POST',
      `/api/hr/recruitment/candidates/${candidateAId}/hire`,
      managerAToken,
      { employeeCode: 'HRREC-1001' }
    );
    assert.equal(hired.status, 201, JSON.stringify(hired.json));
    assert.equal(hired.json.employeeCode, 'HRREC-1001');
    assert.equal(hired.json.branchId, BRANCH_A);
    assert.equal(hired.json.joiningDateAD, '2026-12-01');
    assert.equal(hired.json.monthlySalary, 50_000);

    const employee = (
      await pool!.query(
        `SELECT branch_id, department, designation, monthly_salary, joining_date_ad::text, is_active
         FROM employees WHERE employee_code = $1`,
        ['HRREC-1001']
      )
    ).rows[0];
    assert.equal(employee.branch_id, BRANCH_A);
    assert.equal(employee.department, 'Operations');
    assert.equal(employee.designation, 'Network Engineer');
    assert.equal(Number(employee.monthly_salary), 50_000);
    assert.equal(employee.joining_date_ad, '2026-12-01');
    assert.equal(employee.is_active, true);

    const hiredCandidate = await request(
      'GET',
      `/api/hr/recruitment/candidates?requisitionId=${requisitionAId}`,
      managerAToken
    );
    assert.equal(hiredCandidate.status, 200);
    assert.equal(hiredCandidate.json[0].status, 'HIRED');
    assert.equal(hiredCandidate.json[0].hiredEmployeeCode, 'HRREC-1001');

    const hireAgain = await request(
      'POST',
      `/api/hr/recruitment/candidates/${candidateAId}/hire`,
      managerAToken,
      { employeeCode: 'HRREC-1002' }
    );
    assert.equal(hireAgain.status, 409, 'a candidate is converted once');
  });

  test('refuses cross-branch reads/writes, widening ALL, repeated or unknown filters and bad dates', async () => {
    const branchBDefaults = await request(
      'GET',
      '/api/hr/recruitment/requisitions',
      managerBToken
    );
    assert.equal(branchBDefaults.status, 200, JSON.stringify(branchBDefaults.json));
    assert.deepEqual(branchBDefaults.json, [], 'manager B cannot see branch A requisitions');

    const crossBranchCandidate = await request(
      'GET',
      `/api/hr/recruitment/candidates?branchId=${BRANCH_A}`,
      managerBToken
    );
    assert.equal(crossBranchCandidate.status, 403);

    const crossBranchWrite = await request(
      'POST',
      '/api/hr/recruitment/candidates',
      managerBToken,
      { requisitionId: requisitionAId, name: 'Cross Branch Candidate' }
    );
    assert.equal(crossBranchWrite.status, 403);

    const crossBranchPatch = await request(
      'PATCH',
      `/api/hr/recruitment/candidates/${candidateAId}`,
      managerBToken,
      { status: 'SCREENING' }
    );
    assert.equal(crossBranchPatch.status, 403);

    const allBranches = await request(
      'GET',
      `/api/hr/recruitment/candidates?branchId=ALL`,
      managerAToken
    );
    assert.equal(allBranches.status, 403);
    assert.match(allBranches.json.message, /all branches/i);

    const unknownFilter = await request(
      'GET',
      `/api/hr/recruitment/candidates?employeeId=hr-rec-user-a`,
      managerAToken
    );
    assert.equal(unknownFilter.status, 403);

    const repeated = await request(
      'GET',
      `/api/hr/recruitment/candidates?branchId=${BRANCH_A}&branchId=${BRANCH_B}`,
      managerAToken
    );
    assert.equal(repeated.status, 403);

    const badStatus = await request(
      'GET',
      '/api/hr/recruitment/candidates?status=NOT_A_STAGE',
      managerAToken
    );
    assert.equal(badStatus.status, 400);

    const badDates = await request(
      'POST',
      '/api/hr/recruitment/requisitions',
      managerAToken,
      {
        branchId: BRANCH_A,
        title: 'Reversed Dates',
        status: 'OPEN',
        openedOnAD: '2026-12-31',
        closesOnAD: '2026-01-01',
      }
    );
    assert.equal(badDates.status, 400);
    assert.match(badDates.json.message, /Closes date/i);

    const noOfferCandidate = await request(
      'POST',
      '/api/hr/recruitment/candidates',
      managerAToken,
      {
        requisitionId: requisitionAId,
        name: 'Recruitment Candidate No Offer',
        email: 'hr-rec-candidate-no-offer@example.com',
      }
    );
    assert.equal(noOfferCandidate.status, 201, JSON.stringify(noOfferCandidate.json));
    candidateWithoutOfferId = noOfferCandidate.json.id;

    const refusedNoOffer = await request(
      'POST',
      `/api/hr/recruitment/candidates/${candidateWithoutOfferId}/hire`,
      managerAToken,
      { employeeCode: 'HRREC-2001' }
    );
    assert.equal(refusedNoOffer.status, 409);
    assert.match(refusedNoOffer.json.message, /without a completed offer/i);

    const unassignedBranch = await request(
      'GET',
      `/api/hr/recruitment/candidates?branchId=${BRANCH_B}`,
      managerAToken
    );
    assert.equal(unassignedBranch.status, 403);
  });

  test('stores a resume as bounded bytes and only serves it to the owning branch manager', async () => {
    const bytes = Buffer.from('%PDF-1.4 recruitment resume fixture\n%%EOF\n');
    const upload = await request(
      'POST',
      `/api/hr/recruitment/candidates/${candidateWithoutOfferId}/resume?fileName=resume.pdf`,
      managerAToken,
      bytes,
      'application/pdf'
    );
    assert.equal(upload.status, 201, JSON.stringify(upload.json));
    assert.equal(upload.json.hasResume, true);
    assert.equal(upload.json.resumeFileName, 'resume.pdf');
    assert.equal(upload.json.resumeMimeType, 'application/pdf');
    assert.equal(upload.json.resumeByteSize, bytes.length);
    assert.equal(upload.headers.get('cache-control'), 'private, no-store');

    const metadata = await request(
      'GET',
      `/api/hr/recruitment/candidates/${candidateWithoutOfferId}/resume`,
      managerAToken
    );
    assert.equal(metadata.status, 200, JSON.stringify(metadata.json));
    assert.equal(metadata.json.fileName, 'resume.pdf');
    assert.equal(metadata.json.byteSize, bytes.length);

    const content = await fetch(
      `http://127.0.0.1:${port}/api/hr/recruitment/candidates/${candidateWithoutOfferId}/resume/content`,
      { headers: { authorization: `Bearer ${managerAToken}` } }
    );
    assert.equal(content.status, 200);
    assert.equal(content.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);

    const crossBranch = await request(
      'GET',
      `/api/hr/recruitment/candidates/${candidateWithoutOfferId}/resume/content`,
      managerBToken
    );
    assert.equal(crossBranch.status, 403);

    const wrongType = await request(
      'POST',
      `/api/hr/recruitment/candidates/${candidateWithoutOfferId}/resume?fileName=resume.txt`,
      managerAToken,
      'not a resume',
      'text/plain'
    );
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.json.message, /PDF, DOC or DOCX/i);
  });
});
