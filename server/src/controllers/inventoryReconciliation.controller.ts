/**
 * ACC-4 inventory-to-finance reconciliation HTTP surface.
 *
 * The report is read-only and branch-scoped: a branch account is pinned to its
 * own branch, while a global account may request one branch or the whole
 * company. It is the same read the period-close guard performs.
 */
import type { Response } from 'express';
import { pgPool } from '../app';
import { readInventoryReconciliation } from '../services/inventoryReconciliation.service';
import { resolveBranchScope } from './accounting.controller';

/** GET /api/accounting/inventory-reconciliation */
export async function get_inventoryReconciliation(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const report = await readInventoryReconciliation(pgPool, {
    branchId: scope.branchId || null,
    from: req.query?.from,
    to: req.query?.to,
    asOf: req.query?.asOf,
  });
  return res.json(report);
}
