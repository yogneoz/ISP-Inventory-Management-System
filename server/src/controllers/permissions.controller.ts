/**
 * Permissions controller — HTTP orchestration for the permissions domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { permissionMatrix, pgPool, setPermissionMatrix, getUserFromReq } from '../app';
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
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM permission_matrix');
      const entries: Array<[string, string, boolean]> = [];
      for (const [opId, roles] of Object.entries(matrix)) {
        if (roles && typeof roles === 'object') {
          for (const [role, allowed] of Object.entries(roles as Record<string, boolean>)) {
            entries.push([opId, role, Boolean(allowed)]);
          }
        }
      }
      for (const [opId, role, allowed] of entries) {
        await client.query(
          'INSERT INTO permission_matrix (operation_id, role, allowed) VALUES ($1, $2, $3) ON CONFLICT (operation_id, role) DO UPDATE SET allowed = EXCLUDED.allowed',
          [opId, role, allowed]
        );
      }
      await client.query('COMMIT');
      setPermissionMatrix(JSON.parse(JSON.stringify(matrix)));
      console.log(`✅ Permission matrix updated by ${(getUserFromReq(req)).email || 'unknown'}.`);
      res.json({ message: 'Permission matrix updated successfully.', operationCount: Object.keys(matrix).length });
      return;
    } catch (txErr: any) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err: any) {
    res.status(500).json({ message: `Unable to update permissions: ${err.message}` });
    return;
  }

}

