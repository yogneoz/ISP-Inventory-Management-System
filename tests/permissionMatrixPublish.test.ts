/**
 * AUD-2 — the permission matrix reaches the authz read path only after the
 * write transaction has committed.
 *
 * The matrix has two homes: the `permission_matrix` table and the in-memory
 * copy `state/runtimeState.ts` exposes to the authz middleware, which reads it
 * per request. `put_permissions` used to publish that copy from inside its
 * BEGIN…COMMIT block, so a failing COMMIT answered 500 while the running
 * server had already begun enforcing the uncommitted grants — memory ahead of
 * the database until the next save or a restart.
 *
 * WHAT IS PINNED
 *   1. The rows are replaced in order: DELETE, then one UPSERT per entry.
 *   2. Nothing is published before the transaction resolves — the publish is
 *      strictly after COMMIT in the event order, never before.
 *   3. A failing COMMIT propagates the error and publishes NOTHING: the live
 *      `permissionMatrix` the middleware reads keeps the previous grants.
 *   4. A failure mid-write publishes nothing either.
 *   5. The published value is a defensive copy, so a caller that keeps
 *      mutating its payload cannot alter what the server enforces.
 *   6. Source guard — the controller delegates to the service and no longer
 *      calls `setPermissionMatrix` itself, so the publish cannot drift back
 *      inside the transaction.
 *
 * No database is needed: the service takes its transaction runner and publish
 * hook as dependencies (the `SerialBackfillDb` pattern). Cases 3 and 5 assert
 * against the REAL `permissionMatrix` binding the middleware reads.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { persistPermissionMatrix } from '../server/src/services/permissionMatrix.service';
import type {
  PermissionMatrixClient,
  PermissionMatrixDeps,
} from '../server/src/services/permissionMatrix.service';
import { permissionMatrix as liveMatrix, setPermissionMatrix } from '../server/src/state/runtimeState';

type Matrix = Record<string, Record<string, boolean>>;

/** A request-scoped client that records the statements it is asked to run. */
function recordingClient(log: string[]): PermissionMatrixClient {
  return {
    async query(text: string, params?: unknown[]) {
      log.push(params && params.length > 0 ? `${text} | ${JSON.stringify(params)}` : text);
      return { rows: [] };
    },
  };
}

/** Runner shaped like withTransaction: BEGIN, callback, COMMIT. */
function committingRunner(
  log: string[],
  client: PermissionMatrixClient
): PermissionMatrixDeps['runInTransaction'] {
  return async <T>(fn: (c: PermissionMatrixClient) => Promise<T>): Promise<T> => {
    log.push('BEGIN');
    const result = await fn(client);
    log.push('COMMIT');
    return result;
  };
}

describe('AUD-2 permission-matrix publish', () => {
  test('replaces the rows in order and publishes only after the commit', async () => {
    const log: string[] = [];
    const published: Matrix[] = [];
    const matrix: Matrix = {
      'wh-receive-pullouts': { SUPER_ADMIN: true, AUDITOR: false },
      'sales-create': { SUPER_ADMIN: true },
    };

    await persistPermissionMatrix(matrix, {
      runInTransaction: committingRunner(log, recordingClient(log)),
      publish: (m) => {
        log.push('publish');
        published.push(m);
      },
    });

    assert.equal(log[0], 'BEGIN');
    assert.equal(log[1], 'DELETE FROM permission_matrix');
    assert.match(log[2], /^INSERT INTO permission_matrix .* \| \["wh-receive-pullouts","SUPER_ADMIN",true\]$/);
    assert.match(log[3], /^INSERT INTO permission_matrix .* \| \["wh-receive-pullouts","AUDITOR",false\]$/);
    assert.match(log[4], /^INSERT INTO permission_matrix .* \| \["sales-create","SUPER_ADMIN",true\]$/);
    assert.equal(log[5], 'COMMIT');
    assert.equal(log[6], 'publish');
    assert.deepEqual(published, [matrix]);
  });

  test('a failed COMMIT publishes nothing and leaves the live matrix alone', async () => {
    const previousMatrix = liveMatrix;
    const baseline: Matrix = { 'op-baseline': { SUPER_ADMIN: true, AUDITOR: false } };
    setPermissionMatrix(JSON.parse(JSON.stringify(baseline)));

    try {
      const published: Matrix[] = [];
      const log = ['BEGIN'];
      const client = recordingClient(log);
      await assert.rejects(
        persistPermissionMatrix(
          { 'op-uncommitted': { SUPER_ADMIN: false } },
          {
            // Every statement succeeds; the COMMIT itself is what fails.
            runInTransaction: async <T>(fn: (c: PermissionMatrixClient) => Promise<T>): Promise<T> => {
              await fn(client);
              throw new Error('COMMIT failed: server closed the connection unexpectedly');
            },
            publish: (m) => published.push(m),
          }
        ),
        /COMMIT failed/
      );

      assert.equal(published.length, 0, 'nothing may be published when the COMMIT failed');
      assert.deepEqual(liveMatrix, baseline, 'the middleware must keep enforcing the committed grants');
      assert.equal(liveMatrix['op-uncommitted'], undefined);
    } finally {
      setPermissionMatrix(previousMatrix);
    }
  });

  test('a failure mid-write publishes nothing either', async () => {
    const published: Matrix[] = [];
    const failingClient: PermissionMatrixClient = {
      async query(text: string) {
        if (text.startsWith('INSERT')) throw new Error('upsert failed: deadlock detected');
        return { rows: [] };
      },
    };

    await assert.rejects(
      persistPermissionMatrix(
        { 'op-a': { SUPER_ADMIN: true } },
        {
          runInTransaction: committingRunner([], failingClient),
          publish: (m) => published.push(m),
        }
      ),
      /upsert failed/
    );

    assert.equal(published.length, 0);
  });

  test('publishes a defensive copy, not the caller payload', async () => {
    const previousMatrix = liveMatrix;
    const log: string[] = [];

    try {
      const payload: Matrix = { 'op-copy': { SUPER_ADMIN: true } };
      await persistPermissionMatrix(payload, {
        runInTransaction: committingRunner(log, recordingClient(log)),
        publish: setPermissionMatrix,
      });

      assert.deepEqual(liveMatrix, { 'op-copy': { SUPER_ADMIN: true } });

      // A caller that keeps mutating its own payload after the save must not
      // be able to change what the authz middleware enforces.
      payload['op-copy'].SUPER_ADMIN = false;
      payload['op-injected'] = { SUPER_ADMIN: true };
      assert.deepEqual(liveMatrix, { 'op-copy': { SUPER_ADMIN: true } });
    } finally {
      setPermissionMatrix(previousMatrix);
    }
  });

  test('the controller delegates the ordered publish to the service (source guard)', () => {
    const controller = fs.readFileSync(
      path.join('server/src/controllers/permissions.controller.ts'),
      'utf8'
    );
    assert.match(controller, /persistPermissionMatrix\(matrix,/);
    // The publish hook is passed by reference; calling it here is what would
    // put the in-memory matrix back inside (or ahead of) the transaction.
    assert.doesNotMatch(controller, /setPermissionMatrix\(/);
    assert.doesNotMatch(controller, /PERMISSION_MATRIX_UPSERT_SQL/);
  });
});
