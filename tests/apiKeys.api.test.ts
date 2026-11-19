/**
 * Round 14 Part C — partner API keys over the real request path.
 *
 * PROVES, against a real Express app and real PostgreSQL:
 *   1. `POST /api/admin/api-keys` returns the full `isp_live_…` secret exactly
 *      once; the row holds only `sha256(secret half)`, the plaintext appears
 *      nowhere in the row, and no list/read response ever carries it again.
 *   2. A key whose scope contains `gl-view` — and which never receives the
 *      Super Admin override — reads the genuinely gated trial balance (200),
 *      while a key without that operation is refused (403 API_KEY_SCOPE).
 *   3. A read-only key is refused on a non-GET before RBAC runs
 *      (403 API_KEY_READ_ONLY), even though its operation list would allow the
 *      route.
 *   4. Revocation stops the key immediately (401 API_KEY_REVOKED) and an
 *      expired key is refused even while `is_active` is still true
 *      (401 API_KEY_EXPIRED).
 *   5. Rotation issues a different secret; the old secret keeps working during
 *      its grace window and the new one works at once.
 *   6. Create, rotate and revoke require `admin-api-keys`: an authenticated
 *      account without it is refused, and no key row is created by the attempt.
 *
 * Why this file exists: the delivery was demonstrated with curl against a live
 * server. A demonstration proves the behaviour once; this suite proves it every
 * run, so the read-only short-circuit or the revocation check cannot be removed
 * silently.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix, setUsers } from '../server/src/state/runtimeState';
import { ensureReferenceData } from './fixtures/referenceData';

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

const ADMIN = {
  id: 'apikey-admin', email: 'apikey-admin@example.com', name: 'API Key Admin',
  role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false,
} as any;
const ACCOUNTANT = {
  id: 'apikey-accountant', email: 'apikey-accountant@example.com', name: 'API Key Accountant',
  role: 'ACCOUNTANT', branchId: 'WH001', allowedBranchIds: ['WH001'], canSwitchUser: false,
} as any;

/** The admin token is minted from the same identity the matrix is set for. */
const adminToken = issueAuthToken(ADMIN);
const accountantToken = issueAuthToken(ACCOUNTANT);

const GATED_GET = '/api/accounting/statements/trial-balance';
const RW_POST = '/api/locations';

/** Split `isp_live_<prefix>_<secret>` into the stored prefix and the secret. */
function splitToken(token: string): { prefix: string; secret: string } {
  assert.match(token, /^isp_live_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/, 'the secret is a full isp_live token');
  const rest = token.slice('isp_live_'.length);
  const separator = rest.indexOf('_');
  return { prefix: rest.slice(0, separator), secret: rest.slice(separator + 1) };
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('API keys — minting, scope, read-only, revocation, expiry, rotation, RBAC', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const createdKeyIds: string[] = [];

  before(async () => {
    await ensureReferenceData(pool!);
    setUsers([ADMIN, ACCOUNTANT]);
    // SUPER_ADMIN is true by rule; the matrix still names the operations so the
    // non-admin denial is a matrix decision, not a missing row.
    setPermissionMatrix({
      'admin-api-keys': { SUPER_ADMIN: true, ACCOUNTANT: false },
      'gl-view': { SUPER_ADMIN: true, ACCOUNTANT: true },
    } as any);

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });
  });

  after(async () => {
    if (close) await close();
    setUsers([]);
    setPermissionMatrix({});
    if (pool) {
      // The audit table is append-only for the application; the suite cleans up
      // its own rows the way the ledger suites do, under the transaction-local
      // purge switch, so a re-run starts from a known state.
      const client = await pool.connect().catch(() => null);
      if (client) {
        try {
          await client.query("SELECT set_config('inventory.allow_ledger_purge', 'on', false)");
          for (const id of [...createdKeyIds].reverse()) {
            await client.query('DELETE FROM api_key_audit_logs WHERE api_key_id = $1', [id]);
            await client.query('DELETE FROM api_keys WHERE id = $1', [id]);
          }
        } finally {
          client.release();
        }
      }
      await pool.end().catch(() => undefined);
    }
  });

  const request = async (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { token?: string; apiKey?: string; body?: unknown } = {}
  ) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.apiKey) headers['X-API-Key'] = options.apiKey;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, headers: response.headers, body, text };
  };

  const createKey = async (overrides: Record<string, unknown> = {}) => {
    const response = await request('POST', '/api/admin/api-keys', {
      token: adminToken,
      body: {
        name: `apikey-test ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`,
        operations: ['gl-view'],
        readOnly: true,
        expiresInDays: 30,
        ...overrides,
      },
    });
    if (response.body?.key?.id) createdKeyIds.push(response.body.key.id);
    return response;
  };

  test('creation returns the plaintext once; the row stores only its sha256 hash', async () => {
    const created = await createKey();
    assert.equal(created.status, 201, created.text);
    assert.match(created.body.secret, /^isp_live_/, 'the response carries the full token');
    assert.equal(created.body.key.prefix, splitToken(created.body.secret).prefix, 'the listed prefix is the token prefix');
    assert.match(created.body.key.prefix, /^[A-Za-z0-9]+$/, 'the prefix must not contain the _ separator, or the token cannot be split');
    assert.match(created.body.warning, /never be shown again/i);

    const { prefix, secret } = splitToken(created.body.secret);
    const row = await pool!.query(
      `SELECT key_prefix, secret_hash, operations, read_only, is_active FROM api_keys WHERE id = $1`,
      [created.body.key.id]
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].key_prefix, prefix);
    assert.equal(row.rows[0].secret_hash, sha256Hex(secret), 'the stored hash is sha256 of the secret half');
    assert.notEqual(row.rows[0].secret_hash, sha256Hex(created.body.secret), 'the stored hash is NOT the whole token');
    assert.deepEqual(row.rows[0].operations, ['gl-view']);
    assert.equal(row.rows[0].read_only, true);
    assert.equal(row.rows[0].is_active, true);

    const plaintextRows = await pool!.query(
      `SELECT count(*)::int AS hits FROM api_keys WHERE row_to_json(api_keys)::text LIKE '%' || $1 || '%'`,
      [secret]
    );
    assert.equal(plaintextRows.rows[0].hits, 0, 'the plaintext secret is nowhere in the row');

    const list = await request('GET', '/api/admin/api-keys', { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.text.includes(prefix), 'the list shows the prefix');
    assert.ok(!list.text.includes(secret), 'the list never returns the secret');
    assert.ok(!/secret_hash|"secret"|keyHash/i.test(list.text), 'the list exposes no hash or secret field');
  });

  test('a scoped key reads the gl-view-gated trial balance; an out-of-scope key is refused', async () => {
    const scoped = await createKey({ name: 'apikey-test scoped' });
    assert.equal(scoped.status, 201);

    const allowed = await request('GET', GATED_GET, { apiKey: scoped.body.secret });
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal(allowed.body.statement, 'TRIAL_BALANCE');

    const narrowed = await createKey({ name: 'apikey-test audit scope', operations: ['admin-audit'], readOnly: false });
    assert.equal(narrowed.status, 201);
    const denied = await request('GET', GATED_GET, { apiKey: narrowed.body.secret });
    assert.equal(denied.status, 403, 'an operation outside the key scope is refused');
    assert.equal(denied.body.code, 'API_KEY_SCOPE');

    // No Super Admin override: an admin minted this key, yet it is not
    // SUPER_ADMIN, so an operation outside its list is still refused.
    const adminScoped = await createKey({ name: 'apikey-test admin op', operations: ['admin-audit'], readOnly: true });
    assert.equal(adminScoped.status, 201);
    const adminDenied = await request('GET', '/api/accounting/accounts', { apiKey: adminScoped.body.secret });
    assert.equal(adminDenied.status, 403, 'a minted key does not inherit the minter role');
    assert.equal(adminDenied.body.code, 'API_KEY_SCOPE');
  });

  test('a read-only key is refused on a non-GET before RBAC, whatever its operations', async () => {
    // The key is deliberately scoped to a write-ish operation set and marked
    // read-only: the refusal must come from the read-only switch, not from the
    // operation list, which is why the code is API_KEY_READ_ONLY.
    const readOnly = await createKey({ name: 'apikey-test read-only', operations: ['admin-api-keys'], readOnly: true });
    assert.equal(readOnly.status, 201);

    const refused = await request('POST', RW_POST, {
      apiKey: readOnly.body.secret,
      body: { name: 'should not be created' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'API_KEY_READ_ONLY');

    // GET with the same key still works where its scope allows it.
    const read = await request('GET', '/api/locations', { apiKey: readOnly.body.secret });
    assert.notEqual(read.status, 403, 'the same key is not blocked from reads');
  });

  test('revocation stops the key on the next request', async () => {
    const created = await createKey({ name: 'apikey-test revoked' });
    assert.equal(created.status, 201);
    const secret = created.body.secret;

    const before = await request('GET', GATED_GET, { apiKey: secret });
    assert.equal(before.status, 200);

    const revoked = await request('DELETE', `/api/admin/api-keys/${created.body.key.id}`, { token: adminToken });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.key.status, 'Revoked');

    const after = await request('GET', GATED_GET, { apiKey: secret });
    assert.equal(after.status, 401);
    assert.equal(after.body.code, 'API_KEY_REVOKED');

    const row = await pool!.query('SELECT is_active, revoked_by FROM api_keys WHERE id = $1', [created.body.key.id]);
    assert.equal(row.rows[0].is_active, false);
    assert.equal(row.rows[0].revoked_by, ADMIN.id);
  });

  test('an expired key is refused even while the active flag is still true', async () => {
    const created = await createKey({ name: 'apikey-test expired' });
    assert.equal(created.status, 201);
    const secret = created.body.secret;

    const alive = await request('GET', GATED_GET, { apiKey: secret });
    assert.equal(alive.status, 200);

    await pool!.query(`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`, [created.body.key.id]);
    const expired = await request('GET', GATED_GET, { apiKey: secret });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, 'API_KEY_EXPIRED');

    const row = await pool!.query('SELECT is_active FROM api_keys WHERE id = $1', [created.body.key.id]);
    assert.equal(row.rows[0].is_active, true, 'expiry is checked, not just the revocation flag');
  });

  test('rotation issues a new secret; the old one keeps its grace window', async () => {
    const created = await createKey({ name: 'apikey-test rotate' });
    assert.equal(created.status, 201);
    const oldSecret = created.body.secret;

    const rotated = await request('POST', `/api/admin/api-keys/${created.body.key.id}/rotate`, {
      token: adminToken,
      body: { graceHours: 24 },
    });
    assert.equal(rotated.status, 200, rotated.text);
    assert.match(rotated.body.secret, /^isp_live_/);
    assert.notEqual(rotated.body.secret, oldSecret, 'rotation must issue a different secret');
    assert.equal(rotated.body.key.rotatedFrom, created.body.key.id);
    createdKeyIds.push(rotated.body.key.id);

    const oldStillWorks = await request('GET', GATED_GET, { apiKey: oldSecret });
    assert.equal(oldStillWorks.status, 200, 'the previous secret serves its grace window');
    const newWorks = await request('GET', GATED_GET, { apiKey: rotated.body.secret });
    assert.equal(newWorks.status, 200);

    const oldRow = await pool!.query('SELECT expires_at FROM api_keys WHERE id = $1', [created.body.key.id]);
    assert.ok(oldRow.rows[0].expires_at, 'the old key received a grace expiry');
  });

  test('create, rotate and revoke require the admin-api-keys permission', async () => {
    const created = await createKey({ name: 'apikey-test rbac' });
    assert.equal(created.status, 201);
    const targetId = created.body.key.id;

    const listDenied = await request('GET', '/api/admin/api-keys', { token: accountantToken });
    assert.equal(listDenied.status, 403, 'a role without admin-api-keys cannot even list keys');

    const createDenied = await request('POST', '/api/admin/api-keys', {
      token: accountantToken,
      body: { name: 'denied', operations: ['gl-view'], readOnly: true },
    });
    assert.equal(createDenied.status, 403);

    const rotateDenied = await request('POST', `/api/admin/api-keys/${targetId}/rotate`, {
      token: accountantToken,
      body: { graceHours: 24 },
    });
    assert.equal(rotateDenied.status, 403);

    const revokeDenied = await request('DELETE', `/api/admin/api-keys/${targetId}`, { token: accountantToken });
    assert.equal(revokeDenied.status, 403);

    const row = await pool!.query('SELECT is_active FROM api_keys WHERE id = $1', [targetId]);
    assert.equal(row.rows[0].is_active, true, 'the refused calls changed nothing');

    const keysForDeniedName = await pool!.query(`SELECT count(*)::int AS hits FROM api_keys WHERE name = 'denied'`);
    assert.equal(keysForDeniedName.rows[0].hits, 0, 'the refused create wrote no row');
  });
});
