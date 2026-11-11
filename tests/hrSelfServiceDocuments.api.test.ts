/**
 * Phase 3 employee self-service — own document metadata and authenticated bytes.
 *
 * The fixture writes the vault rows directly and drives the real HTTP routes:
 *
 *   1. no token is 401; a denied role is 403 and cannot reach the bytes;
 *   2. only the employee linked to the caller's user id is returned;
 *   3. the expiry summary is derived from the same rows the screen receives;
 *   4. employee/user/document-id selectors, `branchId=ALL` and another branch
 *      are refused;
 *   5. the existing content route allows HR managers and a self-service caller
 *      only for their own employee, never another employee's document;
 *   6. there is no self-service upload/edit/delete route and reads mutate nothing.
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

const BRANCH = 'ess-doc-branch';
const OTHER_BRANCH = 'ess-doc-branch-2';

const ADMIN = {
  id: 'ess-doc-admin',
  email: 'ess-doc-admin@example.com',
  name: 'ESS Document Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

function employeeUser(id: string, branchId: string) {
  return {
    id,
    email: `${id}@example.com`,
    name: `ESS Documents User ${id}`,
    role: 'FRONT_DESK',
    branchId,
    allowedBranchIds: [branchId],
    canSwitchUser: false,
  } as any;
}

const USER_A = employeeUser('ess-doc-user-a', BRANCH);
const USER_B = employeeUser('ess-doc-user-b', BRANCH);
const USER_OTHER = employeeUser('ess-doc-user-other', OTHER_BRANCH);
const USER_CROSS = employeeUser('ess-doc-user-cross', BRANCH);

const DOCUMENT_KEYS = [
  'byteSize',
  'contentUrl',
  'docType',
  'expiresOnAD',
  'expiryStatus',
  'id',
  'issuedOnAD',
  'mimeType',
  'notes',
  'title',
  'uploadedAt',
  'uploadedBy',
].sort();

const SUMMARY_KEYS = ['expiredDocuments', 'expiringSoon', 'totalDocuments'].sort();

interface FixtureDocument {
  id: string;
  employeeId: string;
  docType: string;
  title: string;
  bytes: Buffer;
  expiryOffset: number | null;
  createdOffset: number;
}

const EXPIRED_BYTES = Buffer.from('ess-doc-expired-pdf-bytes');
const EXPIRING_BYTES = Buffer.from('ess-doc-expiring-pdf-bytes');
const VALID_BYTES = Buffer.from('ess-doc-valid-pdf-bytes');
const NO_EXPIRY_BYTES = Buffer.from('ess-doc-no-expiry-pdf-bytes');
const B_BYTES = Buffer.from('ess-doc-b-pdf-bytes');
const OTHER_BYTES = Buffer.from('ess-doc-other-pdf-bytes');

const DOCUMENTS: FixtureDocument[] = [
  {
    id: 'ess-doc-row-a-expired',
    employeeId: 'ess-doc-emp-a',
    docType: 'PAN_CARD',
    title: 'Expired PAN.pdf',
    bytes: EXPIRED_BYTES,
    expiryOffset: 1,
    createdOffset: 0,
  },
  {
    id: 'ess-doc-row-a-expiring',
    employeeId: 'ess-doc-emp-a',
    docType: 'CONTRACT',
    title: 'Expiring contract.pdf',
    bytes: EXPIRING_BYTES,
    expiryOffset: -10,
    createdOffset: 1,
  },
  {
    id: 'ess-doc-row-a-valid',
    employeeId: 'ess-doc-emp-a',
    docType: 'PASSPORT',
    title: 'Valid passport.pdf',
    bytes: VALID_BYTES,
    expiryOffset: -60,
    createdOffset: 2,
  },
  {
    id: 'ess-doc-row-a-no-expiry',
    employeeId: 'ess-doc-emp-a',
    docType: 'APPOINTMENT_LETTER',
    title: 'No-expiry letter.pdf',
    bytes: NO_EXPIRY_BYTES,
    expiryOffset: null,
    createdOffset: 3,
  },
  {
    id: 'ess-doc-row-b',
    employeeId: 'ess-doc-emp-b',
    docType: 'PASSPORT',
    title: 'B passport.pdf',
    bytes: B_BYTES,
    expiryOffset: -30,
    createdOffset: 1,
  },
  {
    id: 'ess-doc-row-other',
    employeeId: 'ess-doc-emp-other',
    docType: 'MEDICAL',
    title: 'Other branch medical.pdf',
    bytes: OTHER_BYTES,
    expiryOffset: -30,
    createdOffset: 1,
  },
  {
    id: 'ess-doc-row-cross',
    employeeId: 'ess-doc-emp-cross',
    docType: 'CITIZENSHIP',
    title: 'Cross-branch citizenship.pdf',
    bytes: OTHER_BYTES,
    expiryOffset: -30,
    createdOffset: 1,
  },
];

describe('employee self-service documents (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const adminToken = issueAuthToken(ADMIN);
  const userAToken = issueAuthToken(USER_A);
  const userBToken = issueAuthToken(USER_B);
  const otherToken = issueAuthToken(USER_OTHER);
  const crossToken = issueAuthToken(USER_CROSS);

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    auth?: string | null
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(auth === null ? {} : { authorization: 'Bearer ' + (auth || adminToken) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a 404 or 403 may still carry JSON; do not hide a non-JSON response */
    }
    return { status: res.status, json, headers: res.headers };
  }

  const get = (path: string, auth?: string | null) => request('GET', path, undefined, auth);

  async function content(path: string, auth: string | null = userAToken) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      headers: auth === null ? {} : { authorization: 'Bearer ' + auth },
    });
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      cacheControl: res.headers.get('cache-control'),
      disposition: res.headers.get('content-disposition'),
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  }

  async function documentCounts() {
    const { rows } = await pool!.query(
      `SELECT
         (SELECT COUNT(*)::int FROM hr_employee_documents WHERE id LIKE 'ess-doc-row-%') AS documents,
         (SELECT COUNT(*)::int FROM employees WHERE id LIKE 'ess-doc-emp-%') AS employees,
         (SELECT COUNT(*)::int FROM users WHERE id LIKE 'ess-doc-user-%' OR id = 'ess-doc-admin') AS users,
         (SELECT COUNT(*)::int FROM branches WHERE id LIKE 'ess-doc-branch%') AS branches`
    );
    return rows[0];
  }

  async function cleanup() {
    await pool!.query("DELETE FROM hr_employee_documents WHERE id LIKE 'ess-doc-row-%'");
    await pool!.query("DELETE FROM employees WHERE id LIKE 'ess-doc-emp-%'");
    await pool!.query("DELETE FROM users WHERE id LIKE 'ess-doc-user-%' OR id = 'ess-doc-admin'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [
      [BRANCH, OTHER_BRANCH],
    ]);
  }

  async function insertDocument(document: FixtureDocument) {
    await pool!.query(
      `INSERT INTO hr_employee_documents (
         id, employee_id, doc_type, original_name, mime_type, byte_size,
         storage_key, expires_on_ad, notes, content, uploaded_by, created_at
       ) VALUES (
         $1, $2, $3, $4, 'application/pdf', $5, $6,
         CURRENT_DATE - $7::int, $8, $9, 'ess-doc-fixture',
         CURRENT_TIMESTAMP - ($10::int * INTERVAL '1 day')
       )`,
      [
        document.id,
        document.employeeId,
        document.docType,
        document.title,
        document.bytes.length,
        `storage-${document.id}`,
        document.expiryOffset,
        document.expiryOffset === null ? null : 'Fixture document',
        document.bytes,
        document.createdOffset,
      ]
    );
  }

  before(async () => {
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location)
       VALUES ($1, 'ESSDOC', 'ESS Documents Test Branch', 'Test'),
              ($2, 'ESSDOC2', 'ESS Documents Other Branch', 'Test')`,
      [BRANCH, OTHER_BRANCH]
    );
    for (const user of [USER_A, USER_B, USER_OTHER, USER_CROSS]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
         VALUES ($1, $2, 'test-not-a-real-hash', $3, $4, $5, ARRAY[$6]::text[], 'active')`,
        [user.id, user.email, user.name, user.role, user.branchId, user.branchId]
      );
    }

    const employees = [
      ['ess-doc-emp-a', 'ESS-DOC-001', 'ESS Documents A', BRANCH, USER_A.id],
      ['ess-doc-emp-b', 'ESS-DOC-002', 'ESS Documents B', BRANCH, USER_B.id],
      ['ess-doc-emp-other', 'ESS-DOC-003', 'ESS Documents Other', OTHER_BRANCH, USER_OTHER.id],
      ['ess-doc-emp-cross', 'ESS-DOC-004', 'ESS Documents Cross', OTHER_BRANCH, USER_CROSS.id],
    ];
    for (const [id, code, name, branchId, userId] of employees) {
      await pool!.query(
        `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
         VALUES ($1, $2, $3, $4, $5, 'Operations')`,
        [id, code, name, branchId, userId]
      );
    }
    for (const document of DOCUMENTS) await insertDocument(document);

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

  test('401/403, then only the caller’s own metadata with a derived expiry summary', async () => {
    const beforeCounts = await documentCounts();
    const unauthenticated = await get('/api/hr/self-service/documents', null);
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.json));

    const deniedMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    deniedMatrix['hr-self-service'].FRONT_DESK = false;
    setPermissionMatrix(deniedMatrix);
    try {
      const denied = await get('/api/hr/self-service/documents', userAToken);
      assert.equal(denied.status, 403, 'a role without hr-self-service must be refused');
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }

    const own = await get('/api/hr/self-service/documents', userAToken);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Object.keys(own.json), ['expirySoonDays', 'summary', 'documents']);
    assert.equal(own.json.expirySoonDays, 30);
    assert.deepEqual(Object.keys(own.json.summary).sort(), SUMMARY_KEYS);
    assert.deepEqual(
      own.json.summary,
      { totalDocuments: 4, expiringSoon: 1, expiredDocuments: 1 },
      'summary counts the exact returned rows'
    );
    assert.equal(own.json.documents.length, 4, 'only employee A documents are returned');
    assert.deepEqual(
      own.json.documents.map((row: any) => row.id),
      [
        'ess-doc-row-a-expired',
        'ess-doc-row-a-expiring',
        'ess-doc-row-a-valid',
        'ess-doc-row-a-no-expiry',
      ],
      'documents are newest first'
    );
    assert.deepEqual(Object.keys(own.json.documents[0]).sort(), DOCUMENT_KEYS);
    assert.deepEqual(
      own.json.documents.map((row: any) => row.expiryStatus),
      ['EXPIRED', 'EXPIRING', 'VALID', 'NO_EXPIRY']
    );
    assert.equal(own.json.documents[0].title, 'Expired PAN.pdf');
    assert.equal(own.json.documents[0].issuedOnAD, null, 'the vault stores no issue date');
    assert.equal(
      own.json.documents[0].contentUrl,
      '/api/employees/ess-doc-emp-a/documents/ess-doc-row-a-expired/content'
    );
    assert.equal(own.json.documents[0].byteSize, EXPIRED_BYTES.length);
    assert.ok(own.json.documents[0].uploadedAt);

    const b = await get('/api/hr/self-service/documents', userBToken);
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.deepEqual(
      b.json.documents.map((row: any) => row.id),
      ['ess-doc-row-b'],
      'employee B never sees employee A documents'
    );
    assert.deepEqual(
      b.json.documents.map((row: any) => row.title),
      ['B passport.pdf']
    );

    const other = await get('/api/hr/self-service/documents', otherToken);
    assert.equal(other.status, 200);
    assert.deepEqual(
      other.json.documents.map((row: any) => row.id),
      ['ess-doc-row-other']
    );

    assert.deepEqual(await documentCounts(), beforeCounts, 'the reads must not mutate the vault');
  });

  test('employee, user, document-id and branch selectors are refused', async () => {
    const refused = [
      '/api/hr/self-service/documents?employeeId=ess-doc-emp-b',
      '/api/hr/self-service/documents?userId=ess-doc-user-b',
      '/api/hr/self-service/documents?user_id=ess-doc-user-b',
      '/api/hr/self-service/documents?documentId=ess-doc-row-b',
      '/api/hr/self-service/documents?documentIds=ess-doc-row-b',
      '/api/hr/self-service/documents?documentIds=ess-doc-row-b&documentIds=ess-doc-row-a-valid',
      '/api/hr/self-service/documents?document_ids=ess-doc-row-b',
      '/api/hr/self-service/documents?branchId=ALL',
      '/api/hr/self-service/documents?branchId=ess-doc-branch-2',
      '/api/hr/self-service/documents?branchId=ess-doc-branch&branchId=ess-doc-branch-2',
    ];
    for (const path of refused) {
      const response = await get(path, userAToken);
      assert.equal(response.status, 403, `${path} must be refused`);
    }

    const ownBranch = await get('/api/hr/self-service/documents?branchId=ess-doc-branch', userAToken);
    assert.equal(ownBranch.status, 200, 'naming the caller’s own branch is a redundant filter');
    assert.equal(ownBranch.json.documents.length, 4);

    const cross = await get('/api/hr/self-service/documents', crossToken);
    assert.equal(cross.status, 403, 'an employee link outside the session branch scope is refused');

    const noLink = await get('/api/hr/self-service/documents', adminToken);
    assert.equal(noLink.status, 404, 'no employee link is reported as missing');

    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const write = await request(method, '/api/hr/self-service/documents', {});
      assert.equal(write.status, 404, `there is no ${method} self-service document route`);
    }
  });

  test('the existing content route serves own bytes and refuses another employee', async () => {
    const own = await content(
      '/api/employees/ess-doc-emp-a/documents/ess-doc-row-a-expired/content'
    );
    assert.equal(own.status, 200);
    assert.equal(own.cacheControl, 'private, no-store');
    assert.equal(own.contentType, 'application/pdf');
    assert.match(own.disposition || '', /Expired PAN\.pdf/);
    assert.deepEqual(own.bytes, EXPIRED_BYTES);

    const anotherEmployeePath = await content(
      '/api/employees/ess-doc-emp-b/documents/ess-doc-row-b/content'
    );
    assert.equal(anotherEmployeePath.status, 404, 'A cannot read B’s document by B employee id');

    const borrowedEmployeePath = await content(
      '/api/employees/ess-doc-emp-a/documents/ess-doc-row-b/content'
    );
    assert.equal(borrowedEmployeePath.status, 404, 'A cannot borrow B’s document id');

    const reverse = await content(
      '/api/employees/ess-doc-emp-a/documents/ess-doc-row-a-valid/content',
      userBToken
    );
    assert.equal(reverse.status, 404, 'B cannot read A’s document');

    const unauthenticated = await content(
      '/api/employees/ess-doc-emp-a/documents/ess-doc-row-a-valid/content',
      null
    );
    assert.equal(unauthenticated.status, 401);

    const deniedMatrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    deniedMatrix['hr-self-service'].FRONT_DESK = false;
    setPermissionMatrix(deniedMatrix);
    try {
      const denied = await content(
        '/api/employees/ess-doc-emp-a/documents/ess-doc-row-a-valid/content'
      );
      assert.equal(denied.status, 403, 'no manage and no self-service means no bytes');
    } finally {
      setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    }

    const manager = await content(
      '/api/employees/ess-doc-emp-b/documents/ess-doc-row-b/content',
      adminToken
    );
    assert.equal(manager.status, 200, 'the existing HR-manage content access still works');
    assert.deepEqual(manager.bytes, B_BYTES);
  });
});
