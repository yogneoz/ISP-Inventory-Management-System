/**
 * Branch-scope registry — the ONE declarative list of which API resources are
 * bound to a branch, used by `enforceBranchAccess` for both its collection
 * filter rules and its by-id record lookup.
 *
 * Why a registry: the by-id rules used to be an inline array in the middleware.
 * A new branch-scoped table could be added to the schema and the routes and
 * simply be forgotten here, leaving its records reachable across branches —
 * exactly the class of bug the authorization audit found (AUTHZ-1). Now
 * `tests/branchScopeRegistry.test.ts` parses `scripts/schema.sql`: every table
 * that carries a branch column must be either listed in
 * `BRANCH_SCOPED_RESOURCES` (guarded by id) or in `BRANCH_SCOPE_EXEMPTIONS`
 * with a written reason. Adding a branch column to the schema therefore fails
 * CI until the decision is made explicitly.
 *
 * This module deliberately imports nothing, so the schema test can load it
 * without booting the server.
 */

/** Columns that bind a row to a branch (`destination_warehouse_id` references branches too). */
export const BRANCH_SCOPE_COLUMNS = ['branch_id', 'source_branch_id', 'destination_branch_id', 'destination_warehouse_id'] as const;

export interface BranchScopedResource {
  /** URL prefix, app-relative (the middleware runs under `/api`). */
  prefix: string;
  /** Table whose rows carry the branch columns. */
  table: string;
  /** Columns whose value identifies the owning branch. */
  columns: readonly string[];
  /** SQL predicate matching the record id in the path; defaults to `id = $1`. */
  idLookup?: string;
}

export interface BranchScopeExemption {
  /** Schema table that carries a branch column but needs no by-id guard. */
  table: string;
  /** Where its branch protection comes from instead, or why it needs none. */
  reason: string;
}

/**
 * Resources whose records are looked up by the id (or tracking code) in the
 * path: a row outside the account's allowed branches is refused.
 */
export const BRANCH_SCOPED_RESOURCES: readonly BranchScopedResource[] = [
  { prefix: '/stock', table: 'inventory_stock', columns: ['branch_id'] },
  { prefix: '/assets', table: 'fixed_assets', columns: ['branch_id'] },
  { prefix: '/purchase-orders', table: 'purchase_orders', columns: ['branch_id'] },
  { prefix: '/purchase-invoices', table: 'purchase_invoices', columns: ['branch_id'] },
  { prefix: '/vendor-payments', table: 'vendor_payments', columns: ['branch_id'] },
  {
    prefix: '/shipments',
    table: 'shipments',
    columns: ['source_branch_id', 'destination_branch_id'],
    idLookup: 'id = $1 OR tracking_code = $1',
  },
  { prefix: '/stock-operations', table: 'stock_operations', columns: ['branch_id', 'destination_warehouse_id'] },
  { prefix: '/customer-devices', table: 'customer_device_records', columns: ['branch_id'] },
  { prefix: '/serial-log', table: 'serial_log', columns: ['branch_id'] },
  { prefix: '/customers', table: 'customer_records', columns: ['branch_id'] },
  { prefix: '/sales-invoices', table: 'sales_invoices', columns: ['branch_id'] },
  { prefix: '/sales-returns', table: 'sales_returns', columns: ['branch_id'] },
  { prefix: '/purchase-returns', table: 'purchase_returns', columns: ['branch_id'] },
  { prefix: '/customer-payments', table: 'customer_payments', columns: ['branch_id'] },
  { prefix: '/approval-requests', table: 'approval_requests', columns: ['branch_id'] },
  { prefix: '/locations', table: 'locations', columns: ['branch_id'] },
  // Warranty coverage rows are branch custody: correcting one by id must not
  // reach another branch's register (WTY-2). The list reads name their own
  // scope in the controller, so they are not in BRANCH_SCOPED_READ_PATHS.
  { prefix: '/warranties', table: 'warranty_coverages', columns: ['branch_id'] },
];

/**
 * Tables with a branch column that are NOT by-id guarded here. Each needs a
 * reason; `tests/branchScopeRegistry.test.ts` fails on a schema table that is
 * in neither list and on an exemption without one.
 */
export const BRANCH_SCOPE_EXEMPTIONS: readonly BranchScopeExemption[] = [
  {
    table: 'users',
    reason:
      'Administrative records: writes are gated by the `admin-users` operation (Super/Head Office Admin) and reads arrive through the role-filtered bootstrap payload. A head office admin manages accounts across branches, so a per-branch by-id refusal would block the feature, and no branch-scoped /users/:id read exists.',
  },
  {
    table: 'damage_records',
    reason:
      'Written by the guarded stock-operation/damage service and read through the branch-scoped bootstrap slice; there is no /damage-records/:id route.',
  },
  {
    table: 'fiscal_year_opening_stock',
    reason:
      "Batch fiscal-year register (product × branch): the GET filters and the PUT refuses rows outside the actor's allowed branches in fiscal.routes.ts. The path id is the fiscal year, not a row id, so the by-id lookup does not apply.",
  },
  {
    table: 'vendor_opening_balances',
    reason:
      "Batch fiscal-year register (supplier × branch): the GET filters and the PUT refuses rows outside the actor's allowed branches in fiscal.routes.ts. The path id is the fiscal year, not a row id, so the by-id lookup does not apply.",
  },
  {
    table: 'audit_logs',
    reason:
      'Read through GET /api/audit-trail, gated by `admin-audit` and scoped to the actor’s allowed branches in misc.controller; bootstrap slices follow the same gate (AUTHZ-11). No :id route.',
  },
  {
    table: 'transaction_logs',
    reason:
      'Read-only movement ledger served by GET /api/transaction-logs, which resolves the actor’s allowed branches in SQL (misc.controller); no by-id route.',
  },
  {
    table: 'document_sequence_daily',
    reason:
      'Internal document-number counters keyed by branch + document type + day. Written only by the numbering service inside server-side transactions and never addressed by a record id.',
  },
];

/** Resource prefixes where a list read must name an authorized branch. */
export const BRANCH_SCOPED_READ_PATHS: readonly string[] = [
  '/stock',
  '/assets',
  '/purchase-orders',
  '/purchase-invoices',
  '/vendor-payments',
  '/shipments',
  '/stock-operations',
  '/customer-devices',
  '/customers',
  '/sales-invoices',
  '/sales-returns',
  '/purchase-returns',
  '/approval-requests',
  '/locations',
];

/**
 * Path segments directly under a resource prefix that are NOT record ids, so
 * the by-id lookup must not run for them.
 */
export const COLLECTION_SEGMENTS: ReadonlySet<string> = new Set([
  'page',
  'overview',
  'available',
  'lookup',
  'warranty',
  'vendor',
  'seller',
  'exchange',
  'refusal',
  'bulk',
  'bulk-reorder-levels',
  'reconcile-audit',
]);

/** Finds the guarded resource for a path, matching whole segments only. */
export function findBranchScopedResource(path: string): BranchScopedResource | undefined {
  return BRANCH_SCOPED_RESOURCES.find(
    (resource) => path === resource.prefix || path.startsWith(`${resource.prefix}/`)
  );
}

/**
 * The branches an account may act on, or `null` when it is global (Super Admin,
 * Head Office Admin, or a signed `branchId` of 'ALL'). An account with no
 * branch assignment gets an empty set: it may act on no branch rather than all.
 */
export function allowedBranchScope(user: any): Set<string> | null {
  if (!user) return new Set();
  if (user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN') return null;
  if (user.branchId === 'ALL') return null;
  return new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
}
