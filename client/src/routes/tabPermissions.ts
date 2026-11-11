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

const HR_VIEW = ['hr-employee-view', 'gl-payroll-manage'];

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
  'opening-stock': 'opening-stock-view',
  'category-management': 'category-manage',
  'product-group-management': 'product-group-manage',
  'uom-management': 'uom-manage',
  'product-master': 'prod-view',
  'supplier-warranty': 'warranty-view',
  'seller-warranty': 'warranty-view',
  branches: 'admin-branches',
  suppliers: 'suppliers-manage',
  'sales-agents-areas': 'customers-manage',
  'import-stock': 'stock-import-export',
  'export-stock': 'stock-import-export',
  'stock-valuation': 'stock-valuation',
  'fixed-assets': 'assets-view',
  'depreciation-register': 'assets-view',
  approvals: ['workflow-approval', 'workflow-approval-cancel'],
  // Read with the HR view grant; legacy payroll managers keep access.
  employees: HR_VIEW,
  // Own-record self-service: any role holding the ESS grant, independent of
  // the employee-master and Finance payroll grants.
  'hr-self-service': 'hr-self-service',
  'hr-self-payslips': 'hr-self-service',
  'hr-self-leave': 'hr-self-service',
  'hr-self-attendance': 'hr-self-service',
  'hr-self-documents': 'hr-self-service',
  'hr-attendance': ['hr-employee-view', 'hr-attendance-manage', 'gl-payroll-manage'],
  // Salary is employee master data; the legacy payroll grant still opens it.
  'hr-payroll': ['hr-employee-view', 'hr-employee-manage', 'gl-payroll-manage'],
  // Read-only aggregates; same read grant as the employee directory.
  'hr-reports': HR_VIEW,
  // The pipeline is readable with the HR view grant; write controls inside the
  // screen stay behind hr-employee-manage / the legacy payroll grant.
  'hr-recruitment': HR_VIEW,
  // Appraisals share the recruitment read/write split; sign-off is refused
  // server-side without the manage grant even if the tab is open.
  'hr-performance': HR_VIEW,
  // Lifecycle reads share the HR view grant; asset/account actions are
  // rechecked server-side against the manage grant.
  'hr-lifecycle': HR_VIEW,
  'hr-org-masters': ['hr-employee-manage', 'gl-payroll-manage'],
  'workflow-approval': ['workflow-approval', 'workflow-approval-cancel'],
  accounting: 'gl-view',
  'accounting-profit-loss': 'gl-view',
  'accounting-balance-sheet': 'gl-view',
  'accounting-cash-flow': 'gl-view',
  'accounting-cash-book': 'gl-view',
  'recurring-close': 'gl-view',
  'accounting-aging': 'gl-view',
  // Entry forms are operation screens: a reader without gl-post cannot post,
  // so the screen is not offered at all. The read-only result lives on
  // Posted Vouchers under gl-view.
  'journal-entry': 'gl-post',
  'cash-bank-entry': 'gl-post',
  'posted-vouchers': 'gl-view',
  'finance-payroll-postings': 'gl-view',
  // Accounting masters are management screens; each is gated by the operation
  // that its buttons actually require.
  'accounting-chart': 'gl-chart-manage',
  'general-ledger': 'gl-chart-manage',
  'subledgers': 'gl-subledger-manage',
  'bill-terms': 'gl-bill-terms-manage',
  'cost-centers': 'gl-dimension-manage',
  'narration-templates': 'gl-dimension-manage',
  'cash-position': 'gl-view',
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
  'user-permissions',
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
