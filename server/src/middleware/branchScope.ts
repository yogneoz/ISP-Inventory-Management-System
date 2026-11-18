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
  // Claims own the branch. The list/detail resolve the session scope in the
  // controller; this by-id entry closes a direct status PATCH from another
  // branch. Events are children of the guarded claim.
  { prefix: '/warranty-claims', table: 'warranty_claims', columns: ['branch_id'] },
  // Journals are branch-bound; the header carries the owning branch. Lines and
  // subledger entries are only reachable through their guarded header.
  { prefix: '/accounting/journals', table: 'gl_journals', columns: ['branch_id'] },
  // Forecast adjustments are branch-owned; the list filters by the caller's
  // scope and the by-id guard refuses an edit/delete from another branch.
  { prefix: '/accounting/cash-flow/manual-inputs', table: 'gl_cash_flow_manual_inputs', columns: ['branch_id'] },
  // Sales territories are branch custody when they name a branch; global areas
  // (NULL branch_id) are limited to global accounts by the controller.
  { prefix: '/sales/areas', table: 'areas', columns: ['branch_id'] },
  // Cost centres are master data but a branch-owned centre is branch custody:
  // a branch accountant must not edit another branch's centre by id. Global
  // centres (NULL branch_id) are intentionally handled by the controller's
  // create/update guard, which only lets global accounts use them.
  { prefix: '/accounting/cost-centers', table: 'cost_centers', columns: ['branch_id'] },
  // Payroll is branch custody: employees belong to a branch and runs are filed
  // under one. The employee-ledger path is guarded by the employee id parsed
  // from `/employees/:id/ledger`.
  { prefix: '/employees', table: 'employees', columns: ['branch_id'] },
  { prefix: '/payroll-runs', table: 'payroll_runs', columns: ['branch_id'] },
  // Attendance days and holidays are filed under one branch. The HR controllers
  // filter lists by the caller's allowedBranchScope; this by-id entry closes
  // the direct-delete path as well.
  { prefix: '/hr/attendance', table: 'hr_attendance', columns: ['branch_id'] },
  { prefix: '/hr/holidays', table: 'hr_holidays', columns: ['branch_id'] },
  // Leave balances and requests carry the employee's branch. The controllers
  // filter lists and refuse out-of-scope employees; these by-id entries close
  // the direct edit/decide paths as well.
  { prefix: '/hr/leave-balances', table: 'hr_leave_balances', columns: ['branch_id'] },
  { prefix: '/hr/leave-requests', table: 'hr_leave_requests', columns: ['branch_id'] },
  // Salary structures are filed under the employee's branch; a by-id edit must
  // not reach another branch's structure. Lists are filtered by the controller.
  { prefix: '/hr/employee-salaries', table: 'hr_employee_salary', columns: ['branch_id'] },
  // Recruitment is branch custody from the requisition down: candidates inherit
  // the requisition branch and interviews/offers inherit the candidate branch.
  // The controllers also intersect every list with allowedBranchScope; these
  // by-id entries close direct edits on another branch.
  { prefix: '/hr/recruitment/requisitions', table: 'hr_recruitment_requisitions', columns: ['branch_id'] },
  { prefix: '/hr/recruitment/candidates', table: 'hr_recruitment_candidates', columns: ['branch_id'] },
  { prefix: '/hr/recruitment/interviews', table: 'hr_recruitment_interviews', columns: ['branch_id'] },
  { prefix: '/hr/recruitment/offers', table: 'hr_recruitment_offers', columns: ['branch_id'] },
  // Performance follows the same custody: the cycle owns the branch and its
  // goals/feedback inherit it. These by-id entries close direct edits on a
  // cycle or child row from another branch.
  { prefix: '/hr/performance/cycles', table: 'hr_review_cycles', columns: ['branch_id'] },
  { prefix: '/hr/performance/goals', table: 'hr_goals', columns: ['branch_id'] },
  { prefix: '/hr/performance/feedback', table: 'hr_review_feedback', columns: ['branch_id'] },
  // Lifecycle checklists are branch custody derived from the employee. Items
  // live under this header and carry no branch column of their own.
  { prefix: '/hr/lifecycle-checklists', table: 'hr_lifecycle_checklists', columns: ['branch_id'] },
  // Daily cash closes are one row per branch and business day; the close
  // endpoint resolves the branch from the session, and the reopen path is
  // guarded by this by-id lookup as well.
  { prefix: '/accounting/cash-close', table: 'daily_cash_closes', columns: ['branch_id'] },
  // Loan agreements belong to the branch that received the money. The list
  // filters by the caller scope and POST validates its branch, while this by-id
  // entry closes a direct PATCH from another branch.
  { prefix: '/accounting/loans', table: 'loans', columns: ['branch_id'] },
  // Bank statement lines and reconciliation sessions are branch custody. The
  // Bank reconciliation is deliberately absent: a bank statement and its
  // period session belong to the bank account, not a branch. The controller
  // enforces company-wide scope instead.
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
    table: 'gl_recurring_templates',
    reason:
      'Branch-owned recurring templates are scoped in recurringClose.controller: the list filters by the caller branch, and detail/update/delete/run assert the template branch before acting. Generation posts through the branch-bound journal service.',
  },
  {
    table: 'fiscal_year_balances',
    reason:
      "Year-end close snapshots are addressed by fiscal year, never by a row id: GET /api/accounting/fiscal-years/:id/balances resolves the caller's branch scope in accounting.controller and applies it in SQL. No /fiscal-year-balances/:id route exists, so the by-id guard does not apply.",
  },
  {
    table: 'branch_stock_balances',
    reason:
      'Pre-aggregated stock positions (SCALE-3 read model): one row per branch and product, maintained by the transaction-log trigger and read only through branch-scoped SQL (BRANCH_STOCK_BALANCES_SQL / BRANCH_STOCK_VALUE_SQL in readModels.repo). There is no row-id route and no client-supplied branch, so the by-id guard has nothing to address.',
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
    table: 'gl_accounts',
    reason:
      'Custody ownership (NULL = shared, branch id = owned) is not a row-level branch guard: every branch must be able to read the shared chart for posting, and the chart list is the same master data for all branches. The controller (`post_account`/`patch_account`) refuses a branch-owned account outside the caller\'s allowed branches on create and edit, and `postJournal` refuses a journal line whose account owner differs from the journal branch.',
  },
  {
    table: 'gl_opening_balance_slots',
    reason:
      'Internal pointer to the active opening journal of one branch + Opening Balances register. It is written only inside the branch-guarded opening transaction after the register and branch are validated, has no route or row id, and is never accepted as client input.',
  },
  {
    table: 'hr_branch_plan',
    reason:
      'HR organisation catalogue/planning rows are read as a whole by the HR org chart and org-catalogue endpoints; branch_id is an optional link to Branch Management, and there is no /hr/branch-plan/:id route to guard. The catalogue read is gated by the HR view permissions.',
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
  {
    table: 'gl_journal_lines',
    reason:
      'Ledger lines are written and read only through a branch-guarded gl_journals header (the /accounting/journals registry entry); there is no by-id line route a caller could use to cross branches.',
  },
  {
    table: 'gl_subledger_entries',
    reason:
      'Generic subledger rows are created inside the same transaction as their guarded journal and are read through the reconciliation endpoint, which resolves branch scope from the session. No by-id route exists.',
  },
  {
    table: 'gl_budgets',
    reason:
      'Budgets are one header per fiscal year + branch and are addressed by that scope, never by a record id: GET/PUT /api/accounting/budgets resolve the branch from the session (or an authorized branch body) and the variance read applies the same scope in SQL. No by-id route exists.',
  },
  {
    table: 'gl_budget_allocation_profiles',
    reason:
      'Allocation profiles are one row per fiscal year + branch and are addressed only through /api/accounting/budgets/allocation, which resolves the branch from the session (or an authorized branch body) and applies the same scope in SQL. No by-id route exists.',
  },
  {
    table: 'document_number_retirements',
    reason:
      'Internal numbering audit rows are written and read only by the document-number service while it issues or voids a number; there is no route, no record id accepted from a client, and every caller already operates inside the branch-scoped document transaction.',
  },
  {
    table: 'loan_transactions',
    reason:
      'Receipts and repayments are child rows of a loan agreement: every route addresses the loan id under /accounting/loans, which the registry guards by looking up the loan branch, and the controller also calls assertBranchAllowed on the locked loan before reading or writing a transaction. No /loan-transactions/:id route exists.',
  },
  {
    table: 'loan_installments',
    reason:
      'Installments are child rows regenerated from the loan terms: they are read and allocated only through /accounting/loans/:id routes after loanForWrite locks and branch-checks the parent loan. No client-supplied installment id or standalone route exists.',
  },
  {
    table: 'loan_interest_accruals',
    reason:
      'Accruals are child documents of a loan: every read and write addresses the parent loan id under /accounting/loans/:id, which is branch-checked before posting, and each accrual also stores the parent branch. No /loan-interest-accruals/:id route exists.',
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
  '/employees',
  '/payroll-runs',
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
  'consolidated',
  // Generated payroll is a collection action (`POST /payroll-runs/draft`), not
  // a lookup of a run whose id happens to be "draft".
  'draft',
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
