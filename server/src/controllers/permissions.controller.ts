/**
 * Permissions controller — HTTP orchestration for the permissions domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { permissionMatrix, setPermissionMatrix, getUserFromReq, withTransaction } from '../app';
import {
  PERMISSION_MATRIX_DELETE_ALL_SQL,
  PERMISSION_MATRIX_UPSERT_SQL,
  permissionMatrixEntries,
  permissionMatrixUpsertParams,
} from '../models/permissions.repo';
/** Forwarded from permissions.routes.ts (get_permissions). */
export async function get_permissions(req: any, res: Response): Promise<any> {
res.json({ matrix: permissionMatrix });
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
    res.json({ message: 'Permission matrix updated successfully.', operationCount: Object.keys(matrix).length });
    return;
  } catch (err: any) {
    res.status(500).json({ message: `Unable to update permissions: ${err.message}` });
    return;
  }

}

