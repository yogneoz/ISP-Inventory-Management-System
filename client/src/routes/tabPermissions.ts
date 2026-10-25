/**
 * Tab access metadata — the single table the sidebar, the root's navigation
 * guard and the route registry all agree on.
 *
 * A4 moved these out of App.tsx so a tab's permission is declared once, next to
 * the route it protects, instead of living in a root-local constant that only
 * the root can read. `isTabAccessible` is the root's old `canAccessTab` rule,
 * unchanged: dev-only tabs disappear outside Vite, the listed tabs are
 * SUPER_ADMIN-only, and everything else follows the RBAC matrix.
 */
import type { User } from '../types';
import type { NavTab } from '../components/layout/Sidebar';
import { isOperationAllowed } from '../utils/permissions';

/** RBAC operations a tab requires; a missing entry means no operation gate. */
export const TAB_PERMISSIONS: Record<string, string | string[]> = {
  'create-po': 'po-create',
  'create-purchase': 'inv-create',
  'create-shipment': 'shipment-create',
  'receive-shipment': 'wh-receive-pullouts',
  'shipment-list': 'shipment-history',
  pullout: 'branch-pullout-dispatch',
  'pullout-report': 'pullout-report-view',
  damage: 'branch-damage-mark',
  'receive-branch-transfer': 'branch-transfer-receive',
  'create-transfer': 'branch-transfer-create',
  'assign-asset': 'branch-asset-assign',
  'asset-deployments': 'branch-asset-assign',
  'stock-out': 'stock-out',
  'opening-stock': 'opening-stock-view',
  'category-management': 'category-manage',
  'uom-management': 'uom-manage',
  'product-master': 'prod-view',
  branches: 'admin-branches',
  suppliers: 'suppliers-manage',
  'import-stock': 'stock-import-export',
  'export-stock': 'stock-import-export',
  'stock-valuation': 'stock-valuation',
  'fixed-assets': 'assets-manage',
  'depreciation-register': 'assets-manage',
  approvals: ['workflow-approval', 'workflow-approval-cancel'],
  'workflow-approval': ['workflow-approval', 'workflow-approval-cancel'],
  'financial-statements': 'fin-statements',
  'vendor-ledger': 'inv-pay',
  'vendor-opening-balances': 'opening-stock-view',
  'vat-register': 'vat-register',
  users: 'admin-users',
  audit: 'admin-audit',
  'fiscal-year-management': 'admin-fiscal',
  'fiscal-year-closing': 'admin-fiscal',
  'nepali-fiscal': 'admin-fiscal',
  'bs-calendar': 'admin-fiscal',
};

/** Administrative tabs with no matrix operation: Super Admin only. */
export const SUPER_ADMIN_ONLY_TABS: readonly string[] = [
  'permissions',
  'import-customers',
  'data-recalculation',
  'clear-demo-data',
];

/**
 * The one access rule. `null` user means not signed in (login screen), where
 * only ungated tabs would pass — the root never renders the shell in that
 * state anyway.
 */
export function isTabAccessible(tab: NavTab, currentUser: User | null): boolean {
  // DEV-ONLY guard: the design-review gallery does not exist in production
  // builds. Without this, a stale localStorage tab could land a user on a
  // blank page; with it, the enforcement effect redirects to dashboard.
  if (tab === 'dev-statcard' && !import.meta.env?.DEV) return false;
  if (SUPER_ADMIN_ONLY_TABS.includes(tab)) return currentUser?.role === 'SUPER_ADMIN';
  const perm = TAB_PERMISSIONS[tab];
  if (!perm) return true;
  if (Array.isArray(perm)) return perm.some((op) => isOperationAllowed(op, currentUser?.role));
  return isOperationAllowed(perm, currentUser?.role);
}
