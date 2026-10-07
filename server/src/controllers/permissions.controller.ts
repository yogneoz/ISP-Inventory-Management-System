/**
 * Permissions controller — HTTP orchestration for the permissions domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { pgPool, permissionMatrix, setPermissionMatrix, getUserFromReq, withTransaction, logAuditEvent } from '../app';
import {
  PERMISSION_MATRIX_DELETE_ALL_SQL,
  PERMISSION_MATRIX_SELECT_SQL,
  PERMISSION_MATRIX_UPSERT_SQL,
  permissionMatrixEntries,
  permissionMatrixUpsertParams,
  rowsToPermissionMatrix,
} from '../models/permissions.repo';
/** Forwarded from permissions.routes.ts (get_permissions). */
export async function get_permissions(req: any, res: Response): Promise<any> {
  // Mirror-drift rule (#7): the permission matrix is served LIVE from
  // PostgreSQL — the same SELECT the bootstrap slices use — so a manual DB
  // edit, a second server instance or a missed cache refresh can never be
  // served stale here either. The in-memory matrix is only the operational
  // cache the authz middleware reads per request, and the resilience
  // fallback if the live read fails.
  try {
    const matrix = rowsToPermissionMatrix(
      (await pgPool.query(PERMISSION_MATRIX_SELECT_SQL)).rows
    );
    res.json({ matrix });
  } catch (err: any) {
    console.warn('permissions live read failed, serving operational cache:', err?.message || err);
    res.json({ matrix: permissionMatrix });
  }
  return;
}

/** Forwarded from permissions.routes.ts (put_permissions). */
export async function put_permissions(req: any, res: Response): Promise<any> {
try {
    const { matrix } = req.body as { matrix?: Record<string, Record<string, boolean>> };
    if (!matrix || typeof matrix !== 'object') {
      res.status(400).json({ message: 'Invalid permission matrix payload.' });
      return;
    }
    await withTransaction(async (client) => {
      await client.query(PERMISSION_MATRIX_DELETE_ALL_SQL);
      const entries = permissionMatrixEntries(matrix);
      for (const entry of entries) {
        await client.query(PERMISSION_MATRIX_UPSERT_SQL, permissionMatrixUpsertParams(entry));
      }
      setPermissionMatrix(JSON.parse(JSON.stringify(matrix)));
    });
    console.log(`✅ Permission matrix updated by ${(getUserFromReq(req)).email || 'unknown'}.`);
    // Audit + broadcast: every connected client re-reads the matrix slice
    // (targeted PERMISSIONS domain) instead of acting on stale grants until
    // an unrelated reload. Also the first audit trail this table ever had.
    logAuditEvent(req, 'UPDATE_PERMISSION_MATRIX', 'PERMISSIONS', `Updated permission matrix (${Object.keys(matrix).length} role-operation rules).`);
    res.json({ message: 'Permission matrix updated successfully.', operationCount: Object.keys(matrix).length });
    return;
  } catch (err: any) {
    res.status(500).json({ message: `Unable to update permissions: ${err.message}` });
    return;
  }

}

