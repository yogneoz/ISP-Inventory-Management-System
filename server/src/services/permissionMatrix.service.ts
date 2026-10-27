/**
 * Permission-matrix persistence — AUD-2.
 *
 * The matrix has two homes: the `permission_matrix` table (source of truth)
 * and the in-memory copy the authz middleware reads on every request
 * (`state/runtimeState.ts`, published through `setPermissionMatrix`).
 *
 * The replace used to publish the in-memory copy from INSIDE its
 * BEGIN…COMMIT block, so the running server began enforcing new grants before
 * the write was durable: a failing COMMIT answered 500 to the caller while
 * memory had already changed, leaving the database and the enforcement path
 * disagreeing until the next successful save or a restart.
 *
 * The sequence is therefore owned here, in order: replace the rows inside the
 * transaction, and only once it resolves publish the committed matrix to the
 * read path. `runInTransaction` and `publish` are injected (following
 * `SerialBackfillDb` in ./serialBackfill.service.ts), so the failed-COMMIT
 * path is testable against fakes instead of a live PostgreSQL.
 */
import {
  PERMISSION_MATRIX_DELETE_ALL_SQL,
  PERMISSION_MATRIX_UPSERT_SQL,
  permissionMatrixEntries,
  permissionMatrixUpsertParams,
} from '../models/permissions.repo';

/** Minimal client surface; the pooled transaction client satisfies it. */
export interface PermissionMatrixClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

/** The two steps the controller supplies from ../app. */
export interface PermissionMatrixDeps {
  /** Runs `fn` inside BEGIN…COMMIT; rejects when the transaction or COMMIT fails. */
  runInTransaction: <T>(fn: (client: PermissionMatrixClient) => Promise<T>) => Promise<T>;
  /** Publishes a COMMITTED matrix to the authz read path. */
  publish: (matrix: Record<string, Record<string, boolean>>) => void;
}

/**
 * Replace the matrix table with `matrix`, publishing it in memory only after
 * the transaction has committed. Rejects with the transaction's own error and
 * leaves the read path untouched (the table itself is rolled back).
 */
export async function persistPermissionMatrix(
  matrix: Record<string, Record<string, boolean>>,
  deps: PermissionMatrixDeps
): Promise<void> {
  await deps.runInTransaction(async (client) => {
    await client.query(PERMISSION_MATRIX_DELETE_ALL_SQL);
    for (const entry of permissionMatrixEntries(matrix)) {
      await client.query(PERMISSION_MATRIX_UPSERT_SQL, permissionMatrixUpsertParams(entry));
    }
  });
  // AUD-2: strictly after the COMMIT. The in-memory matrix is what the authz
  // middleware enforces per request, so it must never run ahead of the table.
  // The copy keeps the previous defensive semantics: callers hand in their
  // request payload, which they may keep mutating.
  deps.publish(JSON.parse(JSON.stringify(matrix)));
}
