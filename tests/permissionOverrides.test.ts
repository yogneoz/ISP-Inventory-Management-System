/**
 * Per-user permission overrides — phase 1 (docs/permission-overrides-plan.md).
 *
 * PROVES
 *   1. The resolver: a user grant opens an operation the role denies, a deny
 *      closes one the role allows, an absent row inherits the role, Super Admin
 *      is immutable, an expired override lapses, and an unknown operation id
 *      never opens a gate.
 *   2. The real permission middleware (`requirePermissionAny`) enforces the
 *      resolver, not the raw role row — a grant reaches the handler and a deny
 *      returns 403.
 *   3. The replace transaction writes DELETE + one UPSERT per override and
 *      publishes the authz map only after COMMIT; a failed commit publishes
 *      nothing.
 *   4. HTTP layer (`createApp` + `registerAllRoutes`, DB-gated): SUPER_ADMIN can
 *      read and replace a user's overrides, `/api/permissions/me` reflects the
 *      grant for that user only, invalid payloads are 400, a Super Admin target
 *      is refused, and a non-Super-Admin caller is 403. The operation drill-down
 *      lists only direct exceptions that change the saved role answer.
 *
 * The schema side is pinned by tests/schema.drift.guard.test.ts and
 * tests/schemaSource.parity.test.ts (42 tables), plus the source check below
 * that the table keeps its ON DELETE CASCADE.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';

import { createApp, registerAllRoutes } from '../server/src/app';
import { hashPassword, issueAuthToken } from '../server/src/middleware/auth';
import { requirePermissionAny } from '../server/src/middleware';
import {
  permissionMatrix as liveMatrix,
  setPermissionMatrix,
  userPermissionOverrides as liveOverrides,
  setUserPermissionOverrides,
} from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import {
  effectiveOperations,
  effectivePermission,
  persistUserPermissionOverrides,
  replaceUserOverrides,
  roleBaseAllowed,
} from '../server/src/services/permissionOverrides.service';
import type { UserPermissionOverrideMap } from '../server/src/models/permissions.repo';

dotenv.config();

// ---------------------------------------------------------------------------
// Resolver (no database)
// ---------------------------------------------------------------------------

const MATRIX: Record<string, Record<string, boolean>> = {
  'op-allowed': { BRANCH_MANAGER: true, ACCOUNTANT: false },
  'op-denied': { BRANCH_MANAGER: false, ACCOUNTANT: false },
};

const branchManager = { id: 'u-resolver', role: 'BRANCH_MANAGER' };

function overrideMap(
  entries: Array<[string, 'grant' | 'deny', string | null]>
): UserPermissionOverrideMap {
  return new Map([
    [
      String(branchManager.id),
      new Map(
        entries.map(([operation, effect, expiresAt]) => [operation, { effect, expiresAt }])
      ),
    ],
  ]);
}

describe('permission override resolver', () => {
  test('no row inherits the role matrix', () => {
    const empty: UserPermissionOverrideMap = new Map();
    assert.equal(effectivePermission(branchManager, 'op-allowed', MATRIX, empty), true);
    assert.equal(effectivePermission(branchManager, 'op-denied', MATRIX, empty), false);
    assert.equal(roleBaseAllowed(branchManager, 'op-denied', MATRIX), false);
  });

  test('a grant opens an operation the role denies', () => {
    const overrides = overrideMap([['op-denied', 'grant', null]]);
    assert.equal(effectivePermission(branchManager, 'op-denied', MATRIX, overrides), true);
    assert.deepEqual(
      effectiveOperations(branchManager, MATRIX, overrides),
      ['op-allowed', 'op-denied'],
      'the effective set is the union, not just the role rows'
    );
  });

  test('a deny closes an operation the role allows', () => {
    const overrides = overrideMap([['op-allowed', 'deny', null]]);
    assert.equal(effectivePermission(branchManager, 'op-allowed', MATRIX, overrides), false);
    assert.deepEqual(
      effectiveOperations(branchManager, MATRIX, overrides),
      [],
      'both operations are now denied: one by the role, one by the override'
    );
  });

  test('a grant to one user never leaks to another user with the same role', () => {
    const matrix = { 'inv-pay': { FRONT_DESK: false, SUPER_ADMIN: true } };
    const frontDeskA = { id: 'fd-a', role: 'FRONT_DESK' };
    const frontDeskB = { id: 'fd-b', role: 'FRONT_DESK' };
    const overrides: UserPermissionOverrideMap = new Map([
      ['fd-a', new Map([['inv-pay', { effect: 'grant' as const, expiresAt: null }]])],
    ]);

    assert.equal(effectivePermission(frontDeskA, 'inv-pay', matrix, overrides), true);
    assert.equal(effectivePermission(frontDeskB, 'inv-pay', matrix, overrides), false);
    assert.deepEqual(effectiveOperations(frontDeskA, matrix, overrides), ['inv-pay']);
    assert.deepEqual(effectiveOperations(frontDeskB, matrix, overrides), []);
  });

  test('Super Admin ignores both a grant and a deny', () => {
    const admin = { id: 'u-admin', role: 'SUPER_ADMIN' };
    const empty: UserPermissionOverrideMap = new Map();
    assert.equal(effectivePermission(admin, 'op-denied', MATRIX, empty), true);
    assert.equal(
      effectivePermission(admin, 'op-allowed', MATRIX, overrideMap([['op-allowed', 'deny', null]])),
      true,
      'an override must never lock the owner out'
    );
  });

  test('an expired override lapses in both directions', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.equal(
      effectivePermission(branchManager, 'op-denied', MATRIX, overrideMap([['op-denied', 'grant', past]])),
      false,
      'an expired grant falls back to the role (denied)'
    );
    assert.equal(
      effectivePermission(branchManager, 'op-allowed', MATRIX, overrideMap([['op-allowed', 'deny', past]])),
      true,
      'an expired deny falls back to the role (allowed)'
    );
  });

  test('a future-dated override still applies', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    assert.equal(
      effectivePermission(branchManager, 'op-denied', MATRIX, overrideMap([['op-denied', 'grant', future]])),
      true
    );
  });

  test('a grant for an unknown operation never opens a gate', () => {
    assert.equal(
      effectivePermission(branchManager, 'not-an-operation', MATRIX, overrideMap([['not-an-operation', 'grant', null]])),
      false
    );
  });

  test('a grant for a catalogue operation applies before the matrix has a row', () => {
    // The plan allows granting a newly added operation before the role matrix
    // catches up. The catalogue, not the matrix, decides what is known.
    const emptyMatrix: Record<string, Record<string, boolean>> = {};
    assert.equal(
      effectivePermission(
        branchManager,
        'inv-pay',
        emptyMatrix,
        overrideMap([['inv-pay', 'grant', null]])
      ),
      true
    );
  });

  test('replaceUserOverrides returns a new map and clears on an empty replacement', () => {
    const original = overrideMap([['op-denied', 'grant', null]]);
    const cleared = replaceUserOverrides(original, String(branchManager.id), []);
    assert.equal(cleared.has(String(branchManager.id)), false);
    assert.equal(original.has(String(branchManager.id)), true, 'the published map is never mutated');

    const replaced = replaceUserOverrides(original, String(branchManager.id), [
      { operationId: 'op-allowed', effect: 'deny', reason: 'test', expiresAt: null },
    ]);
    assert.equal(replaced.get(String(branchManager.id))?.has('op-denied'), false);
    assert.equal(replaced.get(String(branchManager.id))?.get('op-allowed')?.effect, 'deny');
    assert.equal(original.get(String(branchManager.id))?.has('op-allowed'), false);
  });
});

// ---------------------------------------------------------------------------
// Middleware — the resolver is what the routes actually enforce
// ---------------------------------------------------------------------------

function fakeResponse() {
  const state: { status: number; body: any } = { status: 200, body: null };
  const res: any = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: any) {
      state.body = body;
      return res;
    },
  };
  return { res, state };
}

describe('permission middleware honours overrides', () => {
  test('a grant reaches the handler and a deny is refused', async () => {
    const previousMatrix = liveMatrix;
    const previousOverrides = liveOverrides;
    try {
      setPermissionMatrix({ 'perm-gate': { BRANCH_MANAGER: false } });
      setUserPermissionOverrides(new Map());
      const req: any = {
        user: { id: 'mw-user', email: 'mw@example.com', role: 'BRANCH_MANAGER', branchId: 'B1' },
        body: {},
        query: {},
      };

      const denied = fakeResponse();
      let nextCalls = 0;
      await requirePermissionAny('perm-gate')(req, denied.res, () => {
        nextCalls += 1;
      });
      assert.equal(denied.state.status, 403, 'the role alone is still denied');
      assert.equal(nextCalls, 0);

      setUserPermissionOverrides(
        new Map([['mw-user', new Map([['perm-gate', { effect: 'grant', expiresAt: null }]])]])
      );
      const granted = fakeResponse();
      await requirePermissionAny('perm-gate')(req, granted.res, () => {
        nextCalls += 1;
      });
      assert.equal(nextCalls, 1, 'the grant must reach the handler');
      assert.equal(granted.state.status, 200);

      setPermissionMatrix({ 'perm-gate': { BRANCH_MANAGER: true } });
      setUserPermissionOverrides(
        new Map([['mw-user', new Map([['perm-gate', { effect: 'deny', expiresAt: null }]])]])
      );
      const overridden = fakeResponse();
      await requirePermissionAny('perm-gate')(req, overridden.res, () => {
        nextCalls += 1;
      });
      assert.equal(overridden.state.status, 403, 'a deny closes an operation the role allows');
      assert.equal(nextCalls, 1);
    } finally {
      setPermissionMatrix(previousMatrix);
      setUserPermissionOverrides(previousOverrides);
    }
  });
});

// ---------------------------------------------------------------------------
// Replace transaction — publish only after COMMIT
// ---------------------------------------------------------------------------

describe('persistUserPermissionOverrides', () => {
  const record = {
    operationId: 'inv-pay',
    effect: 'grant' as const,
    reason: 'settles vendor bills',
    expiresAt: null,
  };

  test('deletes, upserts each override, then publishes after COMMIT', async () => {
    const log: string[] = [];
    const client = {
      async query(text: string, params?: unknown[]) {
        log.push(params ? `${text} | ${JSON.stringify(params)}` : text);
        return {};
      },
    };
    await persistUserPermissionOverrides('u-write', [record], {
      runInTransaction: async (fn) => {
        log.push('BEGIN');
        const result = await fn(client);
        log.push('COMMIT');
        return result;
      },
      publish: (userId, records) => log.push(`publish:${userId}:${records.length}`),
    });

    assert.equal(log[0], 'BEGIN');
    assert.equal(log[1], 'DELETE FROM user_permission_overrides WHERE user_id = $1 | ["u-write"]');
    assert.match(log[2], /^INSERT INTO user_permission_overrides .* \| \["u-write","inv-pay","grant","settles vendor bills",null\]$/);
    assert.equal(log[3], 'COMMIT');
    assert.equal(log[4], 'publish:u-write:1');
  });

  test('a failed COMMIT publishes nothing', async () => {
    let published = false;
    await assert.rejects(
      persistUserPermissionOverrides('u-write', [record], {
        runInTransaction: async (fn) => {
          await fn({ query: async () => ({}) });
          throw new Error('commit failed');
        },
        publish: () => {
          published = true;
        },
      }),
      /commit failed/
    );
    assert.equal(published, false, 'the authz map must never run ahead of the table');
  });

  test('the schema keeps the cascade and the effect constraint', () => {
    const schema = fs.readFileSync(path.resolve('scripts/schema.sql'), 'utf8');
    const block = schema.slice(
      schema.indexOf('CREATE TABLE IF NOT EXISTS user_permission_overrides'),
      schema.indexOf('CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user')
    );
    assert.match(block, /CREATE TABLE IF NOT EXISTS user_permission_overrides/);
    assert.match(block, /user_id VARCHAR\(50\) NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(block, /effect VARCHAR\(10\) NOT NULL CHECK \(effect IN \('grant', 'deny'\)\)/);
    assert.match(block, /reason TEXT NOT NULL/);
    assert.match(block, /expires_at TIMESTAMP WITH TIME ZONE/);
    assert.match(block, /PRIMARY KEY \(user_id, operation_id\)/);
  });
});

// ---------------------------------------------------------------------------
// HTTP layer (needs PostgreSQL for requirePostgres + the users table)
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let dbReachable = false;

/**
 * Skips a test (rather than failing) when no database was reachable in
 * `before`. Kept out of the top-level module body deliberately: a top-level
 * `await` delays registration of this suite, and `--test-force-exit` then ends
 * the run with the suite never having existed.
 */
async function needsDb(t: any): Promise<boolean> {
  if (dbReachable) return true;
  t.skip('needs a reachable PostgreSQL (requirePostgres gate)');
  return false;
}

const TARGET = {
  id: 'pov-target',
  email: 'pov-target@example.com',
  name: 'POV Target',
  role: 'BRANCH_MANAGER',
  // Permissions do not depend on a branch, and users.branch_id is nullable.
  // These fixtures deliberately avoid creating or deleting a branch row: the
  // node test runner executes files concurrently against the same database, so
  // a temporary branch here would be cached by another suite's boot and then
  // deleted underneath it (a real FK failure seen in productWarranty.api).
  branchId: null,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
const SUPER_TARGET = {
  id: 'pov-super-target',
  email: 'pov-super-target@example.com',
  name: 'POV Super Target',
  role: 'SUPER_ADMIN',
  branchId: null,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
const ACCOUNTANT = {
  id: 'pov-acct',
  email: 'pov-acct@example.com',
  name: 'POV Accountant',
  role: 'ACCOUNTANT',
  branchId: null,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
// The caller is Super Admin (the write endpoints are SUPER_ADMIN-only). It does
// not need a database row: the token is verified by signature and role.
const SUPER_CALLER = {
  id: 'pov-super-caller',
  email: 'pov-super@example.com',
  name: 'POV Super Caller',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('per-user permission override API', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const targetToken = issueAuthToken(TARGET);
  const superToken = issueAuthToken(SUPER_CALLER);
  const accountantToken = issueAuthToken(ACCOUNTANT);

  before(async () => {
    if (!process.env.DATABASE_URL) return;
    try {
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
      if (pool) await pool.end().catch(() => undefined);
      pool = null;
      return;
    }

    await pool!.query("DELETE FROM user_permission_overrides WHERE user_id LIKE 'pov-%'");
    await pool!.query("DELETE FROM audit_logs WHERE user_email = 'pov-super@example.com'");
    await pool!.query("DELETE FROM users WHERE id LIKE 'pov-%'");

    const password = hashPassword('PovTest@1');
    for (const user of [TARGET, SUPER_TARGET, ACCOUNTANT]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [user.id, user.email, password, user.name, user.role, user.branchId, user.allowedBranchIds]
      );
    }

    // The matrix is seeded by dbBoot in the app; these routes read the table
    // live, and tests never boot the server. The resolver's catalogue union is
    // what lets a grant work on a schema-only database (CI) with no matrix rows.
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
    if (pool && dbReachable) {
      await pool.query("DELETE FROM user_permission_overrides WHERE user_id LIKE 'pov-%'");
      await pool.query("DELETE FROM audit_logs WHERE user_email = 'pov-super@example.com'");
      await pool.query("DELETE FROM users WHERE id LIKE 'pov-%'");
      await pool.end();
    }
  });

  async function call(method: string, url: string, token: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* empty/non-JSON is fine */
    }
    return { status: res.status, json };
  }

  test('the effective set for a user is role-derived before any override', async (t) => {
    if (!(await needsDb(t))) return;
    const res = await call('GET', '/api/permissions/me', targetToken);
    assert.equal(res.status, 200);
    assert.equal(res.json.role, 'BRANCH_MANAGER');
    assert.ok(Array.isArray(res.json.operations));
    assert.equal(res.json.operations.includes('inv-pay'), false, 'the role default is denied');
    assert.ok(res.json.version >= 1);
  });

  test('a non-Super-Admin cannot read or write overrides', async (t) => {
    if (!(await needsDb(t))) return;
    const read = await call('GET', '/api/users/pov-target/permission-overrides', accountantToken);
    assert.equal(read.status, 403);
    const summaryRead = await call('GET', '/api/users/access-summary', accountantToken);
    assert.equal(summaryRead.status, 403);
    const write = await call('PUT', '/api/users/pov-target/permission-overrides', accountantToken, {
      overrides: [],
    });
    assert.equal(write.status, 403);
  });

  test('invalid payloads are rejected before anything is written', async (t) => {
    if (!(await needsDb(t))) return;
    const unknownOperation = await call('PUT', '/api/users/pov-target/permission-overrides', superToken, {
      overrides: [{ operationId: 'not-an-operation', effect: 'grant', reason: 'test' }],
    });
    assert.equal(unknownOperation.status, 400);
    assert.match(String(unknownOperation.json?.message), /not a known operation/i);

    const missingReason = await call('PUT', '/api/users/pov-target/permission-overrides', superToken, {
      overrides: [{ operationId: 'inv-pay', effect: 'grant' }],
    });
    assert.equal(missingReason.status, 400);
    assert.match(String(missingReason.json?.message), /reason is required/i);

    const extraKey = await call('PUT', '/api/users/pov-target/permission-overrides', superToken, {
      overrides: [],
      applyToRole: true,
    });
    assert.equal(extraKey.status, 400);
    assert.match(String(extraKey.json?.message), /unknown field/i);

    const pastExpiry = await call('PUT', '/api/users/pov-target/permission-overrides', superToken, {
      overrides: [
        {
          operationId: 'inv-pay',
          effect: 'grant',
          reason: 'test',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    assert.equal(pastExpiry.status, 400);
    assert.match(String(pastExpiry.json?.message), /future/i);

    const stored = await pool!.query(
      "SELECT COUNT(*)::int AS n FROM user_permission_overrides WHERE user_id = 'pov-target'"
    );
    assert.equal(stored.rows[0].n, 0, 'no rejected payload may leave a row behind');
  });

  test('a Super Admin target is refused', async (t) => {
    if (!(await needsDb(t))) return;
    const res = await call(
      'PUT',
      `/api/users/${SUPER_TARGET.id}/permission-overrides`,
      superToken,
      { overrides: [] }
    );
    assert.equal(res.status, 400);
    assert.match(String(res.json?.message), /Super Admin always has every operation/i);
  });

  test('an unknown user is a 404', async (t) => {
    if (!(await needsDb(t))) return;
    const res = await call('GET', '/api/users/pov-no-such-user/permission-overrides', superToken);
    assert.equal(res.status, 404);
  });

  test('a grant is persisted, returned by the admin read and reflected in /me', async (t) => {
    if (!(await needsDb(t))) return;
    const write = await call('PUT', '/api/users/pov-target/permission-overrides', superToken, {
      overrides: [
        { operationId: 'inv-delete', effect: 'grant', reason: 'deletes voided vendor bills' },
        { operationId: 'fin-statements', effect: 'deny', reason: 'segregation of duties' },
      ],
    });
    assert.equal(write.status, 200, JSON.stringify(write.json));
    assert.equal(write.json.userId, 'pov-target');
    assert.equal(write.json.role, 'BRANCH_MANAGER');
    assert.equal(write.json.base['inv-delete'], false, 'the role still denies inv-delete');
    assert.equal(write.json.operations.includes('inv-delete'), true, 'the grant is applied');
    assert.equal(write.json.operations.includes('fin-statements'), false, 'the deny is applied');
    assert.equal(write.json.overrides.length, 2);
    assert.equal(write.json.overrides.find((o: any) => o.operationId === 'inv-delete').expired, false);

    const adminRead = await call('GET', '/api/users/pov-target/permission-overrides', superToken);
    assert.equal(adminRead.status, 200);
    assert.equal(adminRead.json.overrides.length, 2);
    assert.equal(adminRead.json.operations.includes('inv-delete'), true);

    // The Users register reads every card from ONE bulk summary; the counts
    // must reflect the two active exceptions just committed.
    const summaries = await call('GET', '/api/users/access-summary', superToken);
    assert.equal(summaries.status, 200, JSON.stringify(summaries.json));
    assert.equal(summaries.json.total, Object.keys(DEFAULT_PERMISSIONS_MATRIX).length);
    const targetSummary = summaries.json.users.find((row: any) => row.userId === 'pov-target');
    assert.ok(targetSummary, 'the bulk summary must include the target account');
    assert.equal(targetSummary.role, 'BRANCH_MANAGER');
    assert.equal(targetSummary.grants, 1);
    assert.equal(targetSummary.denies, 1);
    assert.equal(targetSummary.setCount, 0);
    assert.ok(
      targetSummary.effective >= 0 && targetSummary.effective <= summaries.json.total,
      'the effective count must fit the catalogue denominator'
    );
    // The register's access filter reads this list, so it must be the same
    // effective answer the authz path resolves: the grant appears and the
    // personal deny does not.
    assert.ok(Array.isArray(targetSummary.operations));
    assert.equal(targetSummary.operations.includes('inv-delete'), true);
    assert.equal(targetSummary.operations.includes('fin-statements'), false);

    const me = await call('GET', '/api/permissions/me', targetToken);
    assert.equal(me.status, 200);
    assert.equal(me.json.operations.includes('inv-delete'), true, 'the target sees the grant');
    assert.equal(me.json.operations.includes('fin-statements'), false, 'the target does not see the deny');

    const other = await call('GET', '/api/permissions/me', accountantToken);
    assert.equal(other.json.operations.includes('inv-delete'), false, 'another user must not inherit the grant');

    const stored = await pool!.query(
      "SELECT operation_id, effect, reason FROM user_permission_overrides WHERE user_id = 'pov-target' ORDER BY operation_id"
    );
    assert.deepEqual(stored.rows, [
      { operation_id: 'fin-statements', effect: 'deny', reason: 'segregation of duties' },
      { operation_id: 'inv-delete', effect: 'grant', reason: 'deletes voided vendor bills' },
    ]);

    const audit = await pool!.query(
      "SELECT action, details FROM audit_logs WHERE user_email = 'pov-super@example.com' AND action = 'UPDATE_USER_PERMISSIONS' ORDER BY timestamp_ad DESC LIMIT 1"
    );
    assert.equal(audit.rows[0]?.action, 'UPDATE_USER_PERMISSIONS');
    assert.match(String(audit.rows[0]?.details), /grant inv-delete/);
    assert.match(String(audit.rows[0]?.details), /deletes voided vendor bills/);
  });

  test('the operation drill-down returns only users whose exception changes the role answer', async (t) => {
    if (!(await needsDb(t))) return;
    const previousMatrix = liveMatrix;
    setPermissionMatrix({
      'inv-delete': { BRANCH_MANAGER: false, ACCOUNTANT: false },
      'fin-statements': { BRANCH_MANAGER: false, ACCOUNTANT: false },
    });
    try {
      const grants = await call(
        'GET',
        '/api/permissions/operation-overrides?operationId=inv-delete&role=BRANCH_MANAGER',
        superToken
      );
      assert.equal(grants.status, 200);
      assert.equal(grants.json.roleAllowed, false);
      assert.equal(grants.json.users.length, 1);
      assert.equal(grants.json.users[0].userId, TARGET.id);
      assert.equal(grants.json.users[0].effect, 'grant');
      assert.equal(grants.json.users[0].name, TARGET.name);
      assert.equal(grants.json.users[0].reason, 'deletes voided vendor bills');

      // The deny for fin-statements matches the role's own denial, so it is not
      // a difference and must not be listed.
      const sameAnswer = await call(
        'GET',
        '/api/permissions/operation-overrides?operationId=fin-statements&role=BRANCH_MANAGER',
        superToken
      );
      assert.equal(sameAnswer.status, 200);
      assert.deepEqual(sameAnswer.json.users, []);

      // A different role has no row for this operation.
      const otherRole = await call(
        'GET',
        '/api/permissions/operation-overrides?operationId=inv-delete&role=ACCOUNTANT',
        superToken
      );
      assert.equal(otherRole.status, 200);
      assert.deepEqual(otherRole.json.users, []);

      const forbidden = await call(
        'GET',
        '/api/permissions/operation-overrides?operationId=inv-delete&role=BRANCH_MANAGER',
        accountantToken
      );
      assert.equal(forbidden.status, 403);

      const unknownOperation = await call(
        'GET',
        '/api/permissions/operation-overrides?operationId=not-an-operation&role=BRANCH_MANAGER',
        superToken
      );
      assert.equal(unknownOperation.status, 400);

      const unknownRole = await call(
        'GET',
        '/api/permissions/operation-overrides?operationId=inv-delete&role=NOT_A_ROLE',
        superToken
      );
      assert.equal(unknownRole.status, 400);
    } finally {
      setPermissionMatrix(previousMatrix);
    }
  });

  test('replacing with an empty list clears the exceptions', async (t) => {
    if (!(await needsDb(t))) return;
    const write = await call('PUT', '/api/users/pov-target/permission-overrides', superToken, {
      overrides: [],
    });
    assert.equal(write.status, 200);
    assert.deepEqual(write.json.overrides, []);

    const me = await call('GET', '/api/permissions/me', targetToken);
    assert.equal(me.json.operations.includes('inv-delete'), false, 'cleared grants no longer apply');

    const stored = await pool!.query(
      "SELECT COUNT(*)::int AS n FROM user_permission_overrides WHERE user_id = 'pov-target'"
    );
    assert.equal(stored.rows[0].n, 0);
  });

  test('the matrix source of truth still declares the catalogue', () => {
    assert.ok(Object.keys(DEFAULT_PERMISSIONS_MATRIX).length >= 50);
    assert.equal(typeof DEFAULT_PERMISSIONS_MATRIX['inv-pay'], 'object');
  });
});
