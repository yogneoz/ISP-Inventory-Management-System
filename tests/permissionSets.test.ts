/**
 * Reusable permission sets — phase 2 (docs/permission-overrides-plan.md).
 *
 * PROVES
 *   1. The resolver layers sets correctly: a set grant opens an operation the
 *      role denies, an explicit per-user deny still wins over a set grant, an
 *      expired override falls back to the set, unknown operations never open,
 *      and Super Admin ignores sets.
 *   2. The schema declares all three tables with cascades and the case-
 *      insensitive unique name index.
 *   3. HTTP (DB-gated): only SUPER_ADMIN can manage definitions; create/list/
 *      update/delete work; duplicate names and unknown operations are 400/409;
 *      membership replace makes /api/permissions/me reflect the grants for that
 *      user only; an explicit deny wins; clearing membership and deleting a set
 *      remove the grants; a Super Admin target is refused; every write is
 *      audited.
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
  setUserPermissionOverrides,
  setUserPermissionSetGrants,
  userPermissionOverrides as liveOverrides,
  userPermissionSetGrants as liveSetGrants,
} from '../server/src/state/runtimeState';
import {
  effectiveOperations,
  effectivePermission,
} from '../server/src/services/permissionOverrides.service';
import type {
  UserPermissionOverrideMap,
  UserPermissionSetGrantMap,
} from '../server/src/models/permissions.repo';

dotenv.config();

// ---------------------------------------------------------------------------
// Resolver (no database)
// ---------------------------------------------------------------------------

const MATRIX: Record<string, Record<string, boolean>> = {
  'op-allowed': { BRANCH_MANAGER: true, ACCOUNTANT: false },
  'op-denied': { BRANCH_MANAGER: false, ACCOUNTANT: false },
};

const branchManager = { id: 'u-set-resolver', role: 'BRANCH_MANAGER' };

const overridesWith = (
  entries: Array<[string, 'grant' | 'deny', string | null]>
): UserPermissionOverrideMap =>
  new Map([
    [
      String(branchManager.id),
      new Map(entries.map(([operation, effect, expiresAt]) => [operation, { effect, expiresAt }])),
    ],
  ]);

const setGrantsWith = (operations: string[]): UserPermissionSetGrantMap =>
  new Map([[String(branchManager.id), new Set(operations)]]);

describe('permission set resolver', () => {
  test('a set grant opens an operation the role denies', () => {
    assert.equal(
      effectivePermission(branchManager, 'op-denied', MATRIX, new Map(), setGrantsWith(['op-denied'])),
      true
    );
    assert.deepEqual(
      effectiveOperations(branchManager, MATRIX, new Map(), setGrantsWith(['op-denied'])),
      ['op-allowed', 'op-denied'],
      'the effective set is the union of role rows and set grants'
    );
  });

  test('an explicit deny wins over a set grant', () => {
    assert.equal(
      effectivePermission(
        branchManager,
        'op-denied',
        MATRIX,
        overridesWith([['op-denied', 'deny', null]]),
        setGrantsWith(['op-denied'])
      ),
      false
    );
  });

  test('an expired override falls back to the set grant', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.equal(
      effectivePermission(
        branchManager,
        'op-denied',
        MATRIX,
        overridesWith([['op-denied', 'deny', past]]),
        setGrantsWith(['op-denied'])
      ),
      true,
      'the lapsed deny is ignored, so the set still applies'
    );
  });

  test('a set grant for an unknown operation never opens a gate', () => {
    assert.equal(
      effectivePermission(
        branchManager,
        'not-an-operation',
        MATRIX,
        new Map(),
        setGrantsWith(['not-an-operation'])
      ),
      false
    );
  });

  test('Super Admin ignores set grants and overrides', () => {
    const admin = { id: 'u-set-admin', role: 'SUPER_ADMIN' };
    assert.equal(
      effectivePermission(admin, 'op-denied', MATRIX, overridesWith([['op-denied', 'deny', null]]), setGrantsWith([])),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Middleware — the routes enforce the set-aware resolver
// ---------------------------------------------------------------------------

function fakeResponse() {
  const state: { status: number } = { status: 200 };
  const res: any = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json() {
      return res;
    },
  };
  return { res, state };
}

describe('permission-set middleware enforcement', () => {
  test('a set grant reaches the handler; an explicit deny closes it again', async () => {
    const previousMatrix = liveMatrix;
    const previousOverrides = liveOverrides;
    const previousSetGrants = liveSetGrants;
    try {
      setPermissionMatrix({ 'set-gate': { BRANCH_MANAGER: false } });
      setUserPermissionOverrides(new Map());
      setUserPermissionSetGrants(new Map());
      const req: any = {
        user: { id: 'set-mw-user', email: 'set-mw@example.com', role: 'BRANCH_MANAGER', branchId: 'B1' },
        body: {},
        query: {},
      };

      const denied = fakeResponse();
      let nextCalls = 0;
      await requirePermissionAny('set-gate')(req, denied.res, () => {
        nextCalls += 1;
      });
      assert.equal(denied.state.status, 403, 'the role alone is denied');
      assert.equal(nextCalls, 0);

      setUserPermissionSetGrants(
        new Map([['set-mw-user', new Set(['set-gate'])]]) 
      );
      const granted = fakeResponse();
      await requirePermissionAny('set-gate')(req, granted.res, () => {
        nextCalls += 1;
      });
      assert.equal(nextCalls, 1, 'the set grant must reach the handler');
      assert.equal(granted.state.status, 200);

      setUserPermissionOverrides(
        new Map([['set-mw-user', new Map([['set-gate', { effect: 'deny', expiresAt: null }]])]])
      );
      await requirePermissionAny('set-gate')(req, denied.res, () => {
        nextCalls += 1;
      });
      assert.equal(denied.state.status, 403, 'an explicit deny wins over the set');
      assert.equal(nextCalls, 1);
    } finally {
      setPermissionMatrix(previousMatrix);
      setUserPermissionOverrides(previousOverrides);
      setUserPermissionSetGrants(previousSetGrants);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('permission-set schema', () => {
  const schema = fs.readFileSync(path.resolve('scripts/schema.sql'), 'utf8');

  test('the three tables, their cascades and the unique name index are declared', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS permission_sets/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS permission_set_grants/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS permission_set_members/);
    assert.match(
      schema,
      /set_id VARCHAR\(50\) NOT NULL REFERENCES permission_sets\(id\) ON DELETE CASCADE/,
      'deleting a set must remove its grants and memberships'
    );
    assert.match(
      schema,
      /user_id VARCHAR\(50\) NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
      'deleting a user must remove their memberships'
    );
    assert.match(schema, /uq_permission_sets_name_lower ON permission_sets \(LOWER\(name\)\)/);
    assert.match(schema, /PRIMARY KEY \(set_id, operation_id\)/);
    assert.match(schema, /PRIMARY KEY \(user_id, set_id\)/);
  });
});

// ---------------------------------------------------------------------------
// HTTP layer (needs PostgreSQL)
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let dbReachable = false;

async function needsDb(t: any): Promise<boolean> {
  if (dbReachable) return true;
  t.skip('needs a reachable PostgreSQL (requirePostgres gate)');
  return false;
}

const RUN = `${process.pid}-${Date.now()}`;
const SET_NAME = `PSET Vendor Desk ${RUN}`;
const TARGET = {
  id: `pset-target-${RUN}`,
  email: `pset-target-${RUN}@example.com`,
  name: 'PSET Target',
  role: 'BRANCH_MANAGER',
  branchId: null,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
const OTHER = {
  id: `pset-other-${RUN}`,
  email: `pset-other-${RUN}@example.com`,
  name: 'PSET Other',
  role: 'BRANCH_MANAGER',
  branchId: null,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
const SUPER_TARGET = {
  id: `pset-super-${RUN}`,
  email: `pset-super-target-${RUN}@example.com`,
  name: 'PSET Super Target',
  role: 'SUPER_ADMIN',
  branchId: null,
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;
const SUPER_CALLER = {
  id: `pset-caller-${RUN}`,
  email: `pset-caller-${RUN}@example.com`,
  name: 'PSET Super Caller',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('permission-set API', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let setId = '';
  const targetToken = issueAuthToken(TARGET);
  const otherToken = issueAuthToken(OTHER);
  const superToken = issueAuthToken(SUPER_CALLER);

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

  async function meOperations(token: string): Promise<string[]> {
    const res = await call('GET', '/api/permissions/me', token);
    assert.equal(res.status, 200);
    return res.json.operations;
  }

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

    await pool!.query("DELETE FROM permission_sets WHERE name LIKE 'PSET %'");
    await pool!.query("DELETE FROM user_permission_overrides WHERE user_id LIKE 'pset-%'");
    await pool!.query("DELETE FROM audit_logs WHERE user_email = $1", [SUPER_CALLER.email]);
    await pool!.query("DELETE FROM users WHERE id LIKE 'pset-%'");

    const password = hashPassword('PsetTest@1');
    for (const user of [TARGET, OTHER, SUPER_TARGET]) {
      await pool!.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [user.id, user.email, password, user.name, user.role, user.branchId, user.allowedBranchIds]
      );
    }

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
      await pool.query("DELETE FROM permission_sets WHERE name LIKE 'PSET %'");
      await pool.query("DELETE FROM user_permission_overrides WHERE user_id LIKE 'pset-%'");
      await pool.query("DELETE FROM audit_logs WHERE user_email = $1", [SUPER_CALLER.email]);
      await pool.query("DELETE FROM users WHERE id LIKE 'pset-%'");
      await pool.end();
    }
  });

  test('non-Super-Admins cannot read or write sets', async (t) => {
    if (!(await needsDb(t))) return;
    assert.equal((await call('GET', '/api/permission-sets', targetToken)).status, 403);
    assert.equal(
      (await call('POST', '/api/permission-sets', targetToken, { name: 'Nope', grants: [] })).status,
      403
    );
    assert.equal(
      (await call('PUT', `/api/users/${TARGET.id}/permission-sets`, targetToken, { setIds: [] }))
        .status,
      403
    );
  });

  test('invalid definitions are rejected', async (t) => {
    if (!(await needsDb(t))) return;
    const noName = await call('POST', '/api/permission-sets', superToken, { grants: [] });
    assert.equal(noName.status, 400);
    assert.match(String(noName.json?.message), /name.*required/i);

    const unknownOperation = await call('POST', '/api/permission-sets', superToken, {
      name: `${SET_NAME} bad`,
      grants: ['not-an-operation'],
    });
    assert.equal(unknownOperation.status, 400);
    assert.match(String(unknownOperation.json?.message), /not a known operation/i);

    const extraKey = await call('POST', '/api/permission-sets', superToken, {
      name: `${SET_NAME} extra`,
      grants: [],
      applyToRole: true,
    });
    assert.equal(extraKey.status, 400);
    assert.match(String(extraKey.json?.message), /unknown field/i);
  });

  test('a set can be created and listed with its grants', async (t) => {
    if (!(await needsDb(t))) return;
    const created = await call('POST', '/api/permission-sets', superToken, {
      name: SET_NAME,
      description: 'shared vendor desk grants',
      grants: ['inv-pay'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    setId = created.json.set.id;
    assert.equal(created.json.set.name, SET_NAME);
    assert.deepEqual(created.json.set.grants, ['inv-pay']);
    assert.deepEqual(created.json.set.members, []);

    const list = await call('GET', '/api/permission-sets', superToken);
    assert.equal(list.status, 200);
    const stored = list.json.sets.find((set: any) => set.id === setId);
    assert.ok(stored);
    assert.deepEqual(stored.grants, ['inv-pay']);

    const duplicate = await call('POST', '/api/permission-sets', superToken, {
      name: SET_NAME.toUpperCase(),
      grants: [],
    });
    assert.equal(duplicate.status, 409, 'names are unique case-insensitively');
  });

  test('assigning the set grants the operation to that user only', async (t) => {
    if (!(await needsDb(t))) return;
    assert.equal((await meOperations(targetToken)).includes('inv-pay'), false, 'role denies inv-pay');
    assert.equal((await meOperations(otherToken)).includes('inv-pay'), false);

    const assigned = await call('PUT', `/api/users/${TARGET.id}/permission-sets`, superToken, {
      setIds: [setId],
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.json));
    assert.deepEqual(assigned.json.setIds, [setId]);
    assert.equal(assigned.json.operations.includes('inv-pay'), true, 'the response is set-aware');

    assert.equal((await meOperations(targetToken)).includes('inv-pay'), true, 'the target sees it');
    assert.equal((await meOperations(otherToken)).includes('inv-pay'), false, 'another user does not');

    const adminRead = await call('GET', `/api/users/${TARGET.id}/permission-overrides`, superToken);
    assert.equal(adminRead.status, 200);
    assert.deepEqual(adminRead.json.setIds, [setId]);
    assert.equal(adminRead.json.operations.includes('inv-pay'), true);

    const audit = await pool!.query(
      "SELECT action, details FROM audit_logs WHERE user_email = $1 AND action = 'ASSIGN_USER_PERMISSION_SETS' ORDER BY timestamp_ad DESC LIMIT 1",
      [SUPER_CALLER.email]
    );
    assert.equal(audit.rows[0]?.action, 'ASSIGN_USER_PERMISSION_SETS');
    assert.match(String(audit.rows[0]?.details), /PSET Vendor Desk/);
  });

  test('an explicit deny still wins over the set grant', async (t) => {
    if (!(await needsDb(t))) return;
    const write = await call('PUT', `/api/users/${TARGET.id}/permission-overrides`, superToken, {
      overrides: [{ operationId: 'inv-pay', effect: 'deny', reason: 'set grant denied for audit' }],
    });
    assert.equal(write.status, 200);
    assert.equal(write.json.operations.includes('inv-pay'), false, 'deny beats a set grant');
    assert.equal((await meOperations(targetToken)).includes('inv-pay'), false);

    // Clearing the exception restores the set grant, proving the deny — not a
    // removed membership — was the reason it disappeared.
    const cleared = await call('PUT', `/api/users/${TARGET.id}/permission-overrides`, superToken, {
      overrides: [],
    });
    assert.equal(cleared.status, 200);
    assert.equal((await meOperations(targetToken)).includes('inv-pay'), true);
  });

  test('updating a set changes every member immediately', async (t) => {
    if (!(await needsDb(t))) return;
    const updated = await call('PUT', `/api/permission-sets/${setId}`, superToken, {
      name: SET_NAME,
      description: 'now covers voided vendor bills',
      grants: ['inv-delete'],
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.deepEqual(updated.json.set.grants, ['inv-delete']);

    const operations = await meOperations(targetToken);
    assert.equal(operations.includes('inv-delete'), true, 'the new grant applies');
    assert.equal(operations.includes('inv-pay'), false, 'the removed grant is gone');
  });

  test('unknown sets, unknown users and a Super Admin target are refused', async (t) => {
    if (!(await needsDb(t))) return;
    const unknownSet = await call('PUT', `/api/users/${TARGET.id}/permission-sets`, superToken, {
      setIds: ['no-such-set'],
    });
    assert.equal(unknownSet.status, 400);
    assert.match(String(unknownSet.json?.message), /Unknown permission set/i);

    const unknownUser = await call(
      'PUT',
      `/api/users/pset-no-such-user/permission-sets`,
      superToken,
      { setIds: [] }
    );
    assert.equal(unknownUser.status, 404);

    const superTarget = await call(
      'PUT',
      `/api/users/${SUPER_TARGET.id}/permission-sets`,
      superToken,
      { setIds: [setId] }
    );
    assert.equal(superTarget.status, 400);
    assert.match(String(superTarget.json?.message), /Super Admin always has every operation/i);
  });

  test('clearing membership removes the set grants', async (t) => {
    if (!(await needsDb(t))) return;
    const cleared = await call('PUT', `/api/users/${TARGET.id}/permission-sets`, superToken, {
      setIds: [],
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json.setIds, []);
    assert.equal((await meOperations(targetToken)).includes('inv-delete'), false);

    const memberships = await pool!.query(
      'SELECT COUNT(*)::int AS n FROM permission_set_members WHERE user_id = $1',
      [TARGET.id]
    );
    assert.equal(memberships.rows[0].n, 0);
  });

  test('deleting a set removes its definitions, grants and memberships', async (t) => {
    if (!(await needsDb(t))) return;
    await call('PUT', `/api/users/${TARGET.id}/permission-sets`, superToken, { setIds: [setId] });
    assert.equal((await meOperations(targetToken)).includes('inv-delete'), true);

    const deleted = await call('DELETE', `/api/permission-sets/${setId}`, superToken);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    assert.equal((await meOperations(targetToken)).includes('inv-delete'), false);

    const leftover = await pool!.query(
      'SELECT (SELECT COUNT(*)::int FROM permission_set_grants WHERE set_id = $1) AS grants, ' +
        '(SELECT COUNT(*)::int FROM permission_set_members WHERE set_id = $1) AS members',
      [setId]
    );
    assert.deepEqual(leftover.rows[0], { grants: 0, members: 0 });

    const missing = await call('DELETE', `/api/permission-sets/${setId}`, superToken);
    assert.equal(missing.status, 404);
  });
});
