/**
 * Role/permission core extracted from app.ts (backlog item #6 — app.ts
 * extraction). Role whitelist + validator and the type-aware permission
 * middleware for stock operations.
 */
import { requirePermission } from '../middleware';

export const VALID_ROLES = new Set([
  'SUPER_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK',
  'ACCOUNTANT', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN', 'AUDITOR',
]);

export function validateRole(role: unknown): string {
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    throw new Error(`Invalid role '${role}'. Must be one of: ${[...VALID_ROLES].join(', ')}.`);
  }
  return role;
}

/** Type-aware permission middleware for stock operations (maps operation type to matrix op). */
export function requireStockOperationPermission(req: any, res: any, next: any) {
  const opType = req.body?.type || 'DAMAGE';
  const opMap: Record<string, string> = {
    'PULLOUT': 'branch-pullout-dispatch',
    'STOCK_OUT': 'stock-out',
    'DAMAGE': 'branch-damage-mark',
    'DISPOSAL': 'stock-disposal-writeoff',
    'CONSUMABLE_ISSUE': 'stock-out',
    'MANUAL_ADJUSTMENT': 'stock-out',
  };
  const op = opMap[opType] || 'branch-pullout-dispatch';
  return requirePermission(op)(req, res, next);
}
