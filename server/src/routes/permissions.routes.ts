/**
 * Permissions routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerPermissionsRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import {
  getUserFromReq,
  permissionMatrix,
  requireRole,
  setPermissionMatrix,
} from '../app';
import { pgPool } from '../app';

export function registerPermissionsRoutes(app: Express) {
app.get('/api/permissions', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN'), (_req, res) => {
  return res.json({ matrix: permissionMatrix });
});

app.put('/api/permissions', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { matrix } = req.body as { matrix?: Record<string, Record<string, boolean>> };
    if (!matrix || typeof matrix !== 'object') {
      return res.status(400).json({ message: 'Invalid permission matrix payload.' });
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
      return res.json({ message: 'Permission matrix updated successfully.', operationCount: Object.keys(matrix).length });
    } catch (txErr: any) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err: any) {
    return res.status(500).json({ message: `Unable to update permissions: ${err.message}` });
  }
});

}
