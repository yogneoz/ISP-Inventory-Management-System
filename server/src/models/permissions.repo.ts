/**
 * Repository for the permissions domain — the permission-matrix transaction
 * SQL lives here, following the same pattern as ./inventory.repo.ts and
 * ./auth.repo.ts.
 *
 * permissions.controller.ts keeps only HTTP concerns (payload validation,
 * cache refresh, response bodies); query text is defined once in this layer.
 */

/** Wipes all matrix rows inside the replace transaction. */
export const PERMISSION_MATRIX_DELETE_ALL_SQL = 'DELETE FROM permission_matrix';

/** Upserts one (operation_id, role) grant. Executed per entry in the tx. */
export const PERMISSION_MATRIX_UPSERT_SQL =
  'INSERT INTO permission_matrix (operation_id, role, allowed) VALUES ($1, $2, $3) ON CONFLICT (operation_id, role) DO UPDATE SET allowed = EXCLUDED.allowed';

/** Flattens a client matrix object into ordered upsert rows. */
export function permissionMatrixEntries(
  matrix: Record<string, Record<string, boolean>>
): Array<[string, string, boolean]> {
  const entries: Array<[string, string, boolean]> = [];
  for (const [opId, roles] of Object.entries(matrix)) {
    if (roles && typeof roles === 'object') {
      for (const [role, allowed] of Object.entries(roles as Record<string, boolean>)) {
        entries.push([opId, role, Boolean(allowed)]);
      }
    }
  }
  return entries;
}

export function permissionMatrixUpsertParams(entry: [string, string, boolean]): unknown[] {
  return [entry[0], entry[1], entry[2]];
}
