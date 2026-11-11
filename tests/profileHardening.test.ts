/**
 * Self-service profile hardening (audit finding H2).
 *
 * `PUT /api/auth/profile` used to write nothing to PostgreSQL, accept any email
 * (including one another account signs in with), and never rotate the session.
 * These tests drive the controller against the real database and assert the
 * four properties that fix depends on:
 *
 *   1. email / branch / password changes require the current password;
 *   2. a wrong current password is refused;
 *   3. the edit lands in PostgreSQL (not just the in-memory cache);
 *   4. the tokens issued before the edit stop being valid.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pgPool, realPoolInstance, ensurePostgresConnection } from '../server/db';
// Namespace import: `users` is a mutable binding that setUsers replaces, so a
// destructured copy would keep comparing against the pre-edit cache.
import * as runtimeState from '../server/src/state/runtimeState';
import { put_profile } from '../server/src/controllers/auth.controller';
import {
  hashPassword,
  issueAuthToken,
  sessionStillValid,
  verifyAuthToken,
} from '../server/src/middleware/auth';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BRANCH = `PB-${RUN}`;
const USER_ID = `pu-${RUN}`;
const OTHER_ID = `po-${RUN}`;
const EMAIL = `profile-${RUN}@example.com`;
const OTHER_EMAIL = `other-${RUN}@example.com`;
const PASSWORD = 'current-pass-1';

let created = false;

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function fakeReq(user: any, body: any) {
  return {
    user,
    body,
    method: 'PUT',
    originalUrl: '/api/auth/profile',
    headers: {},
    ip: '127.0.0.1',
  } as any;
}

async function loadRow(id: string) {
  const { rows } = await pgPool.query(
    'SELECT id, name, email, branch_id, password, role FROM users WHERE id = $1',
    [id]
  );
  return rows[0];
}

function sessionUser(row: any, token: string) {
  const decoded = verifyAuthToken(token);
  assert.ok(decoded, 'the issued token must verify');
  return { ...decoded!, ...row };
}

describe('self-service profile hardening', () => {
  before(async () => {
    assert.equal(
      await ensurePostgresConnection(),
      true,
      'this suite needs the development PostgreSQL instance'
    );
    await pgPool.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, $2, 'Profile Test Branch', 'Test')`,
      [BRANCH, `P${RUN.slice(-6).toUpperCase()}`]
    );
    const hash = hashPassword(PASSWORD);
    await pgPool.query(
      `INSERT INTO users (id, name, email, password, role, branch_id, status)
       VALUES ($1, 'Original Name', $2, $3, 'ACCOUNTANT', $4, 'active'),
              ($5, 'Other Person', $6, $3, 'ACCOUNTANT', $4, 'active')`,
      [USER_ID, EMAIL, hash, BRANCH, OTHER_ID, OTHER_EMAIL]
    );
    runtimeState.setPgConnected(true);
    created = true;
  });

  after(async () => {
    if (created) {
      await pgPool.query('DELETE FROM audit_logs WHERE branch_id = $1', [BRANCH]);
      await pgPool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[USER_ID, OTHER_ID]]);
      await pgPool.query('DELETE FROM branches WHERE id = $1', [BRANCH]);
    }
    runtimeState.setPgConnected(false);
    // Close the shared pool so the runner exits on completion instead of
    // waiting out the 30s idle timeout.
    await realPoolInstance?.end?.();
  });

  test('a name-only edit needs no current password and persists', async () => {
    const row = await loadRow(USER_ID);
    const res = fakeRes();
    await put_profile(
      fakeReq({ ...row, branchId: row.branch_id }, { name: 'Renamed In Place' }),
      res
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Renamed In Place');
    assert.equal((await loadRow(USER_ID)).name, 'Renamed In Place');
  });

  test('changing the email without the current password is refused', async () => {
    const row = await loadRow(USER_ID);
    const res = fakeRes();
    await put_profile(
      fakeReq({ ...row, branchId: row.branch_id }, { email: `next-${RUN}@example.com` }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.currentPasswordRequired, true);
    assert.equal((await loadRow(USER_ID)).email, EMAIL, 'nothing may be written');
  });

  test('a wrong current password is refused with 401', async () => {
    const row = await loadRow(USER_ID);
    const res = fakeRes();
    await put_profile(
      fakeReq(
        { ...row, branchId: row.branch_id },
        { email: `next-${RUN}@example.com`, currentPassword: 'not-the-password' }
      ),
      res
    );
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.currentPasswordInvalid, true);
    assert.equal((await loadRow(USER_ID)).email, EMAIL);
  });

  test('an email already used by another account is refused with 409', async () => {
    const row = await loadRow(USER_ID);
    const res = fakeRes();
    await put_profile(
      fakeReq(
        { ...row, branchId: row.branch_id },
        { email: OTHER_EMAIL, currentPassword: PASSWORD }
      ),
      res
    );
    assert.equal(res.statusCode, 409);
    assert.equal((await loadRow(USER_ID)).email, EMAIL);
  });

  test('a new password under eight characters is refused', async () => {
    const row = await loadRow(USER_ID);
    const res = fakeRes();
    await put_profile(
      fakeReq({ ...row, branchId: row.branch_id }, { newPassword: 'short', currentPassword: PASSWORD }),
      res
    );
    assert.equal(res.statusCode, 400);
  });

  test('a verified email change commits and retires the previous token', async () => {
    const row = await loadRow(USER_ID);
    const beforeToken = issueAuthToken({ ...row, branchId: row.branch_id } as any);
    const beforeSession = sessionUser(row, beforeToken);

    const nextEmail = `changed-${RUN}@example.com`;
    const res = fakeRes();
    await put_profile(
      fakeReq(
        { ...row, branchId: row.branch_id },
        { name: 'Changed Name', email: nextEmail, currentPassword: PASSWORD }
      ),
      res
    );

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const saved = await loadRow(USER_ID);
    assert.equal(saved.name, 'Changed Name');
    assert.equal(saved.email, nextEmail);
    assert.equal(res.body.password, undefined, 'the response must never carry the hash');

    const fresh = sessionUser(saved, res.body.token);
    const users = runtimeState.users;
    assert.equal(
      sessionStillValid(fresh as any, users),
      true,
      'the token handed back to the caller must keep them signed in'
    );
    assert.equal(
      sessionStillValid(beforeSession as any, users),
      false,
      'the token minted before the email change must be dead'
    );
  });
});
