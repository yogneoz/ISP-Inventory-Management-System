/**
 * Permission-gate regressions — the two holes the HR audit closed.
 *
 * 1. `POST /api/users/:id/reset-password` had no route gate, so any signed-in
 *    account could set another account's password (including a super admin's).
 *    Pinned two ways: a real HTTP request from a FRONT_DESK token is refused by
 *    the route middleware, and the same token on a super-admin route reaches
 *    the controller (400 for a too-short password) proving the refusal is the
 *    permission gate and not a broken token.
 * 2. The bootstrap payload and its targeted slice shipped `users` — other
 *    people's names, e-mails, roles and branches — to every signed-in role.
 *    The payload now answers with an empty list unless the caller can act on
 *    another login. The gate is pinned at the source because the payload path
 *    needs a live PostgreSQL, and a silently dropped gate would look exactly
 *    like a working app.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  createApp,
  getPgConnected,
  pgPool,
  registerAllRoutes,
  setUsers,
  users,
  withPrepended,
} from '../server/src/app';
import { hashPassword, issueAuthToken, verifyPassword } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { USER_DELETE_SQL, USER_INSERT_TEMP_PASSWORD_SQL } from '../server/src/models/admin.repo';
import { USER_FIND_BY_ID_OR_EMAIL_SQL } from '../server/src/models/auth.repo';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const token = (over: Record<string, unknown>) =>
  issueAuthToken({
    id: 'pg-user',
    email: 'pg-user@example.com',
    name: 'PG User',
    role: 'FRONT_DESK',
    branchId: 'WH001',
    allowedBranchIds: ['WH001'],
    canSwitchUser: false,
    ...over,
  } as any);

function startServer(app: import('express').Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as any).port,
        close: () =>
          new Promise<void>((done) => {
            (server as any).closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

interface Reply {
  status: number;
  body: any;
}

function post(port: number, url: string, bearer: string, payload: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${bearer}` } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('password reset for another account', () => {
  test('a front-desk token cannot reset anyone password through the admin route', async () => {
    setPermissionMatrix(DEFAULT_PERMISSIONS_MATRIX as any);
    const app = createApp();
    registerAllRoutes(app);
    const server = await startServer(app);
    try {
      const reply = await post(
        server.port,
        '/api/users/pg-someone/reset-password',
        token({ id: 'pg-frontdesk', email: 'pg-frontdesk@example.com', role: 'FRONT_DESK' }),
        { newPassword: 'Something@123' }
      );
      assert.equal(reply.status, 403, `front desk must be refused, got ${reply.status} ${JSON.stringify(reply.body)}`);
      assert.match(String(reply.body?.message || ''), /Forbidden/i);
    } finally {
      await server.close();
    }
  });

  test('the same route lets an administrator reach the controller', async () => {
    setPermissionMatrix(DEFAULT_PERMISSIONS_MATRIX as any);
    const app = createApp();
    registerAllRoutes(app);
    const server = await startServer(app);
    try {
      // A too-short password is refused by the controller: 400 rather than 403
      // proves the permission gate let the request through.
      const reply = await post(
        server.port,
        '/api/users/pg-someone/reset-password',
        token({ id: 'pg-admin', email: 'pg-admin@example.com', role: 'SUPER_ADMIN' }),
        { newPassword: 'x' }
      );
      assert.equal(reply.status, 400, `administrator must reach the handler, got ${reply.status} ${JSON.stringify(reply.body)}`);
    } finally {
      await server.close();
    }
  });

  test('the admin route carries the admin-users gate in source', () => {
    const routes = read('server/src/routes/admin.routes.ts');
    const line = routes
      .split('\n')
      .find((row) => row.includes('/api/users/:id/reset-password'));
    assert.ok(line, 'the reset-password route must exist');
    assert.match(line!, /requirePermission\('admin-users'\)/, 'reset-password must stay gated on admin-users');
  });

  test('the login-lock report and release routes carry the admin-users gate in source', () => {
    const routes = read('server/src/routes/auth.routes.ts');
    for (const path of ['/api/auth/rate-limit', '/api/auth/rate-limit/release']) {
      const line = routes.split('\n').find((row) => row.includes(`'${path}'`));
      assert.ok(line, `the ${path} route must exist`);
      assert.match(line!, /requirePermission\('admin-users'\)/, `${path} must stay gated on admin-users`);
    }
  });
});

describe('bootstrap user list', () => {
  test('the payload only carries users when the caller may act on other logins', () => {
    const source = read('server/src/controllers/bootstrap.controller.ts');
    assert.match(
      source,
      /users: canReadUserList\(bootstrapUser\) \? data\.users : \[\]/,
      'the full bootstrap must gate its users array'
    );
    assert.match(source, /function canReadUserList/, 'the gate helper must exist');
    assert.match(source, /if \(user\.canSwitchUser\) return true;/, 'profile switching must open the list');
    assert.match(
      source,
      /effectivePermission\(\s*user,\s*'admin-users'/,
      'user administration must open the list through the permission resolver'
    );
  });

  test('every targeted-slice path applies the same gate', () => {
    const source = read('server/src/controllers/bootstrap.controller.ts');
    assert.match(source, /function gateUserSlice\(key: string, value: unknown, req: any\)/, 'the slice gate must exist');
    const wrapped = source.match(/gateUserSlice\(key, /g) || [];
    assert.equal(wrapped.length, 3, 'the live, operational and cache slice returns must all pass through the gate');
  });
});

// Shared HTTP helper for the tests below (GET, PUT and POST through one path).
function send(
  port: number,
  url: string,
  bearer: string,
  method: 'GET' | 'POST' | 'PUT',
  payload?: unknown
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: url,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${bearer}`,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * A login created from the employee record: must_change_password starts TRUE,
 * exactly as USER_INSERT_TEMP_PASSWORD_SQL writes it. Seeded into PostgreSQL
 * when it is reachable, otherwise into the in-memory user cache the same
 * controllers read, so the pins run in both modes.
 */
async function seedOneTimeLogin(): Promise<{ id: string; email: string; password: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const id = `usr-gate-${stamp}`;
  const email = `gate-${stamp}@example.com`;
  const password = 'OneTime@12345';
  const hash = hashPassword(password);
  if (getPgConnected()) {
    await pgPool.query(USER_INSERT_TEMP_PASSWORD_SQL, [
      id,
      email,
      hash,
      'One-Time Login',
      'FRONT_DESK',
      null,
      [],
    ]);
  } else {
    setUsers(
      withPrepended(users, {
        id,
        email,
        password: hash,
        name: 'One-Time Login',
        role: 'FRONT_DESK',
        branchId: '',
        allowedBranchIds: [],
        canSwitchUser: false,
        status: 'active',
        mustChangePassword: true,
      } as any)
    );
  }
  return { id, email, password };
}

async function storedFlag(id: string): Promise<boolean | undefined> {
  if (getPgConnected()) {
    const row = (await pgPool.query(USER_FIND_BY_ID_OR_EMAIL_SQL, [id, ''])).rows[0];
    return row ? Boolean(row.mustChangePassword) : undefined;
  }
  return users.find((row) => row.id === id)?.mustChangePassword;
}

async function discardSeeded(id: string): Promise<void> {
  if (getPgConnected()) {
    await pgPool.query(USER_DELETE_SQL, [id]);
    return;
  }
  setUsers(users.filter((row) => row.id !== id));
}

describe('one-time-password login', () => {
  test('is refused on every endpoint except the account surface', async () => {
    const app = createApp();
    registerAllRoutes(app);
    const server = await startServer(app);
    const gated = token({
      id: 'pg-temp',
      email: 'pg-temp@example.com',
      mustChangePassword: true,
    });
    try {
      // A data endpoint is closed even though the token itself is valid.
      const data = await send(server.port, '/api/employees?branchId=WH001', gated, 'GET');
      assert.equal(data.status, 403, `expected the one-time gate, got ${data.status} ${JSON.stringify(data.body)}`);
      assert.equal(data.body?.mustChangePassword, true, 'the refusal must identify the password change as the reason');

      // Reading the account and changing it stay reachable, or the employee
      // could never satisfy the requirement.
      const me = await send(server.port, '/api/auth/me', gated, 'GET');
      assert.equal(me.status, 200, `auth/me must stay open, got ${me.status}`);
      const profile = await send(server.port, '/api/auth/profile', gated, 'PUT', {});
      assert.equal(profile.status, 200, `auth/profile must stay open, got ${profile.status} ${JSON.stringify(profile.body)}`);
    } finally {
      await server.close();
    }
  });

  test('an ordinary session is not caught by the gate', async () => {
    const app = createApp();
    registerAllRoutes(app);
    const server = await startServer(app);
    try {
      const reply = await send(
        server.port,
        '/api/employees?branchId=WH001',
        token({ id: 'pg-normal', email: 'pg-normal@example.com' }),
        'GET'
      );
      // The route's own role check, or a missing database, may still refuse
      // this token. What must never appear is the password gate's signature.
      assert.notEqual(
        reply.body?.mustChangePassword,
        true,
        `an ordinary token was gated: ${JSON.stringify(reply.body)}`
      );
      assert.doesNotMatch(String(reply.body?.message || ''), /Set a new password/i);
    } finally {
      await server.close();
    }
  });
});

describe('one-time password clears only on a password change', () => {
  test('signing in keeps the flag on the account', async () => {
    const seeded = await seedOneTimeLogin();
    const app = createApp();
    registerAllRoutes(app);
    const server = await startServer(app);
    try {
      const reply = await send(server.port, '/api/auth/login', '', 'POST', {
        email: seeded.email,
        password: seeded.password,
      });
      assert.equal(reply.status, 200, `login failed: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body?.user?.mustChangePassword, true, 'login must not clear the requirement');
      assert.equal(await storedFlag(seeded.id), true, 'the stored flag must survive a login');
    } finally {
      await server.close();
      await discardSeeded(seeded.id);
    }
  });

  test('changing the password clears it and is the only way to', async () => {
    const seeded = await seedOneTimeLogin();
    const app = createApp();
    registerAllRoutes(app);
    const server = await startServer(app);
    const bearer = token({
      id: seeded.id,
      email: seeded.email,
      mustChangePassword: true,
      password: hashPassword(seeded.password),
      status: 'active',
    });
    try {
      const changed = await send(server.port, '/api/auth/profile', bearer, 'PUT', {
        currentPassword: seeded.password,
        newPassword: 'Chosen@98765',
      });
      assert.equal(changed.status, 200, `password change failed: ${JSON.stringify(changed.body)}`);
      assert.equal(await storedFlag(seeded.id), false, 'the flag must clear once the password is replaced');

      // And the account can now sign in without the requirement following it.
      const reply = await send(server.port, '/api/auth/login', '', 'POST', {
        email: seeded.email,
        password: 'Chosen@98765',
      });
      assert.equal(reply.status, 200, `login with the chosen password failed: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body?.user?.mustChangePassword, false, 'the new session must not carry the requirement');
    } finally {
      await server.close();
      await discardSeeded(seeded.id);
    }
  });

  test('a profile edit without a password leaves it in place', async () => {
    const seeded = await seedOneTimeLogin();
    const app = createApp();
    registerAllRoutes(app);
    const server = await startServer(app);
    const bearer = token({
      id: seeded.id,
      email: seeded.email,
      mustChangePassword: true,
      password: hashPassword(seeded.password),
      status: 'active',
    });
    try {
      const renamed = await send(server.port, '/api/auth/profile', bearer, 'PUT', {
        name: 'Renamed One-Time Login',
      });
      assert.equal(renamed.status, 200, `profile edit failed: ${JSON.stringify(renamed.body)}`);
      assert.equal(await storedFlag(seeded.id), true, 'only a password change may clear the requirement');
    } finally {
      await server.close();
      await discardSeeded(seeded.id);
    }
  });
});
