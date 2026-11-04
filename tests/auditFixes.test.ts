/**
 * Audit (2026-11-04) fixes — unit + HTTP proof.
 *
 * Covers the behaviour each fix introduced, so a later refactor cannot quietly
 * restore the old one:
 *
 *  1. `booleanFlag` — `Boolean("false")` used to enable a record.
 *  2. The central error handler — a unique/FK violation is a 409 whose text
 *     never repeats the offending value, and other SQLSTATEs stay a 500 without
 *     leaking the database message.
 *  3. Forgot password — a known and an unknown address get the SAME response
 *     (no account enumeration, no administrator address disclosure).
 *  4. Session revocation — deactivating an account, changing its role or
 *     resetting its password ends an already-issued token instead of leaving it
 *     valid for the rest of its 8 hours, while a token for an account that was
 *     never in this database (the request-level test harnesses) still works.
 *  5. `fetchJson` — a 204 No Content resolves instead of throwing a parse error.
 *  6. `DEMO_DATA_TABLES` — the master-data tables are reachable by Clear Demo
 *     Data.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';

import { createApp, registerAllRoutes } from '../server/src/app';
import { hashPassword, issueAuthToken } from '../server/src/middleware/auth';
import { booleanFlag } from '../server/src/utils/booleanFlag';
import { errorHandler } from '../server/src/errors/errorHandler';
import { ApiError } from '../server/src/errors/ApiError';
import { DEMO_DATA_TABLES } from '../server/src/models/admin.repo';
import { USER_SELECT_COLUMNS } from '../server/src/models/auth.repo';
import { setUsers } from '../server/src/state/runtimeState';
import { users } from '../server/src/app';
import { fetchJson } from '../client/src/services/api/http';

dotenv.config();

let dbReachable = false;
let pool: pg.Pool | null = null;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

describe('boolean flags', () => {
  test('"false", "0" and "no" are false, not truthy strings', () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off', 'inactive', 0, false]) {
      assert.equal(booleanFlag(value, true), false, `${JSON.stringify(value)} must parse as false`);
    }
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', 'active', 1, true]) {
      assert.equal(booleanFlag(value, false), true, `${JSON.stringify(value)} must parse as true`);
    }
  });

  test('an absent or unreadable value keeps the existing one', () => {
    assert.equal(booleanFlag(undefined, true), true);
    assert.equal(booleanFlag(null, false), false);
    assert.equal(booleanFlag('', true), true);
    assert.equal(booleanFlag('maybe', false), false);
    assert.equal(booleanFlag({}, true), true);
  });
});

describe('central error handler', () => {
  function invoke(err: unknown): { status: number; body: any } {
    const res: any = {
      headersSent: false,
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.body = body; return this; },
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      errorHandler(err as any, {} as any, res as any, (() => {}) as any);
    } finally {
      console.error = originalError;
    }
    return { status: res.statusCode, body: res.body };
  }

  test('a unique violation is a 409 that never echoes the duplicate value', () => {
    const err: any = new Error(
      'duplicate key value violates unique constraint "areas_code_key"\nDETAIL:  Key (code)=(SM-AR-KTM) already exists.'
    );
    err.code = '23505';
    const { status, body } = invoke(err);
    assert.equal(status, 409);
    assert.doesNotMatch(String(body.message), /SM-AR-KTM|duplicate key|areas_code_key/);
  });

  test('a foreign-key violation is a 409, and other SQLSTATEs stay a 500 without the SQL text', () => {
    const fk: any = new Error('insert or update violates foreign key constraint "x_fkey"');
    fk.code = '23503';
    assert.equal(invoke(fk).status, 409);

    const other: any = new Error('column "secret_column" does not exist');
    other.code = '42703';
    const { status, body } = invoke(other);
    assert.equal(status, 500);
    assert.doesNotMatch(String(body.message), /secret_column/);
  });

  test('an ApiError still passes its own status and message through', () => {
    const { status, body } = invoke(new ApiError(400, 'Area name is required.'));
    assert.equal(status, 400);
    assert.equal(body.message, 'Area name is required.');
  });
});

describe('forgot-password does not disclose accounts', () => {
  const KNOWN = { id: 'audit-known-user', email: 'audit-known@example.com', name: 'Audit Known', role: 'FRONT_DESK', branchId: '', allowedBranchIds: [], canSwitchUser: false, password: 'x' } as any;

  before(() => {
    setUsers([...(users as any[]), KNOWN]);
  });

  test('known and unknown addresses get an identical body', { skip: skipNoDb }, async () => {
    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port));
    });
    const ask = async (email: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      return { status: res.status, json: await res.json() };
    };
    try {
      const known = await ask('audit-known@example.com');
      const unknown = await ask('audit-nobody@example.com');
      assert.equal(known.status, 200);
      assert.equal(unknown.status, 200, 'an unknown address must not 404');
      assert.deepEqual(Object.keys(known.json).sort(), Object.keys(unknown.json).sort());
      assert.equal(known.json.message, unknown.json.message);
      assert.doesNotMatch(JSON.stringify(known.json), /audit-known|Audit Known|superadmin/i);
    } finally {
      await new Promise<void>((done) => { (server as any).closeAllConnections?.(); server.close(() => done()); });
    }
  });
});

describe('session revocation', () => {
  const USER_ID = 'audit-revoke-user';
  const EMAIL = 'audit-revoke@example.com';

  async function readUser(): Promise<any> {
    const res = await pool!.query(`SELECT ${USER_SELECT_COLUMNS} FROM users WHERE id = $1`, [USER_ID]);
    return res.rows[0];
  }

  /** Mirror what a user edit does: the row changes, then the cache reloads. */
  async function refreshUserInCache(): Promise<any> {
    const row = await readUser();
    setUsers([...(users as any[]).filter((u: any) => u.id !== USER_ID), row]);
    return row;
  }

  async function me(port: number, token: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a 401 body is still JSON */ }
    return { status: res.status, json };
  }

  test('a role change, a password reset or deactivation ends the issued token', { skip: skipNoDb }, async () => {
    await pool!.query(
      `INSERT INTO users (id, name, email, password, role, status)
       VALUES ($1, 'Audit Revoke', $2, $3, 'FRONT_DESK', 'active')
       ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password, role = 'FRONT_DESK', status = 'active',
         branch_id = NULL, allowed_branch_ids = NULL, can_switch_user = FALSE`,
      [USER_ID, EMAIL, hashPassword('FirstPass@1')]
    );
    const row = await refreshUserInCache();
    const token = issueAuthToken(row);

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port));
    });

    try {
      assert.equal((await me(port, token)).status, 200, 'a fresh token must authenticate');

      // Role demotion/promotion.
      await pool!.query(`UPDATE users SET role = 'AUDITOR' WHERE id = $1`, [USER_ID]);
      await refreshUserInCache();
      const afterRole = await me(port, token);
      assert.equal(afterRole.status, 401);
      assert.equal(afterRole.json?.sessionRevoked, true);

      // The fingerprint compares the account's CURRENT state, so restoring the
      // exact earlier state (same role, password and status) makes an old token
      // match again. That is the documented trade-off of a stateless design:
      // a deliberate revert re-validates the session instead of needing a
      // revocation table, and any real change (the cases above and below) ends
      // it.
      await pool!.query(`UPDATE users SET role = 'FRONT_DESK' WHERE id = $1`, [USER_ID]);
      await refreshUserInCache();
      assert.equal((await me(port, token)).status, 200);

      // A password reset.
      const fresh = await refreshUserInCache();
      const liveToken = issueAuthToken(fresh);
      assert.equal((await me(port, liveToken)).status, 200);
      await pool!.query(`UPDATE users SET password = $2 WHERE id = $1`, [USER_ID, hashPassword('SecondPass@2')]);
      await refreshUserInCache();
      assert.equal((await me(port, liveToken)).status, 401);

      // Deactivation.
      const afterReset = await refreshUserInCache();
      const activeToken = issueAuthToken(afterReset);
      assert.equal((await me(port, activeToken)).status, 200);
      await pool!.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [USER_ID]);
      await refreshUserInCache();
      assert.equal((await me(port, activeToken)).status, 401);
    } finally {
      await new Promise<void>((done) => { (server as any).closeAllConnections?.(); server.close(() => done()); });
    }
  });

  test('a token for an account that is not in this database still authenticates', { skip: skipNoDb }, async () => {
    // The request-level tests (and a boot that has not hydrated the cache yet)
    // carry accounts that were never rows here. Refusing them would turn a
    // missing cache entry into a global 401.
    const token = issueAuthToken({
      id: 'audit-synthetic-user', email: 'audit-synthetic@example.com', name: 'Synthetic',
      role: 'FRONT_DESK', branchId: '', allowedBranchIds: [], canSwitchUser: false,
    } as any);
    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port));
    });
    try {
      assert.equal((await me(port, token)).status, 200);
    } finally {
      await new Promise<void>((done) => { (server as any).closeAllConnections?.(); server.close(() => done()); });
    }
  });

  after(async () => {
    if (pool) {
      await pool.query('DELETE FROM users WHERE id = $1', [USER_ID]);
      setUsers([...(users as any[]).filter((u: any) => u.id !== USER_ID)]);
    }
  });
});

describe('fetchJson (HTTP client)', () => {
  test('a 204 resolves to undefined instead of failing to parse', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as any;
    try {
      const result = await fetchJson('/api/customer-devices/exchange/refusal', { method: 'POST', body: '{}' });
      assert.equal(result, undefined);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a JSON body is still parsed', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
    try {
      const result = await fetchJson<any>('/api/settings');
      assert.deepEqual(result, { ok: true });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('demo-data cleanup list', () => {
  test('every master table with is_demo is reachable by Clear Demo Data', () => {
    const tables: readonly string[] = DEMO_DATA_TABLES;
    for (const table of ['areas', 'sales_agents', 'cost_centers', 'narration_templates', 'bill_terms']) {
      assert.ok(tables.includes(table), `${table} must be cleared by Clear Demo Data`);
    }
  });
});

test.after(async () => { await pool?.end(); });
