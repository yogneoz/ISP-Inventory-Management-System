/**
 * SQL for employee branch-transfer requests and history.
 *
 * A transfer is an immutable event with a two-stage lifecycle: HR records a
 * PENDING request with its intended effective date and reason, then an
 * authorized manager approves it (moving the employee) or rejects it. The branch
 * names are snapshotted at request time so the record still reads correctly
 * after a branch is renamed. The employee id is the only foreign key; the from/to
 * branch ids are intentionally plain columns so deleting or renaming a branch
 * cannot erase the record of where the employee worked.
 */

export type BranchTransferStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export const HR_BRANCH_TRANSFER_INSERT_SQL = `INSERT INTO hr_employee_branch_transfers (
  id, employee_id, from_branch_id, from_branch_name,
  to_branch_id, to_branch_name, transferred_by,
  effective_date_ad, effective_date_bs, reason, status, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE)`;

/** A request can be decided only while pending and only once. */
export const HR_BRANCH_TRANSFER_DECIDE_SQL = `UPDATE hr_employee_branch_transfers
SET status = $2,
    approved_by = $3,
    approved_at = CURRENT_TIMESTAMP,
    decision_note = $4
WHERE id = $1 AND status = 'PENDING'`;

export const HR_BRANCH_TRANSFER_BY_ID_SQL = `SELECT
  id,
  employee_id AS "employeeId",
  from_branch_id AS "fromBranchId",
  from_branch_name AS "fromBranchName",
  to_branch_id AS "toBranchId",
  to_branch_name AS "toBranchName",
  transferred_by AS "transferredBy",
  effective_date_ad::text AS "effectiveDateAD",
  reason,
  status,
  approved_by AS "approvedBy",
  approved_at AS "approvedAt",
  decision_note AS "decisionNote",
  created_at AS "createdAt"
FROM hr_employee_branch_transfers
WHERE id = $1`;

export const HR_BRANCH_TRANSFER_LOCK_BY_ID_SQL = `${HR_BRANCH_TRANSFER_BY_ID_SQL} FOR UPDATE`;

export const HR_BRANCH_TRANSFER_PENDING_FOR_EMPLOYEE_SQL = `SELECT id
FROM hr_employee_branch_transfers
WHERE employee_id = $1 AND status = 'PENDING'
LIMIT 1`;

/** Newest first; a bounded read because the profile dialog is not an archive. */
export const HR_BRANCH_TRANSFERS_BY_EMPLOYEE_SQL = `SELECT
  id,
  from_branch_id AS "fromBranchId",
  from_branch_name AS "fromBranchName",
  to_branch_id AS "toBranchId",
  to_branch_name AS "toBranchName",
  transferred_by AS "transferredBy",
  effective_date_ad::text AS "effectiveDateAD",
  reason,
  status,
  approved_by AS "approvedBy",
  approved_at AS "approvedAt",
  decision_note AS "decisionNote",
  created_at AS "createdAt"
FROM hr_employee_branch_transfers
WHERE employee_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 50`;

export const HR_BRANCH_TRANSFER_LOG_MAX = 500;

export interface EmployeeBranchTransferLogFilters {
  /** A branch on either side of the move; null means the caller's whole scope. */
  branchId?: string | null;
  /** Explicit allowed branches when no single branch was selected. */
  branchScope?: string[] | null;
  /** Inclusive AD calendar dates in Nepal time. */
  dateFrom?: string | null;
  dateTo?: string | null;
}

/**
 * Directory-wide transfer log. A branch filter matches either side of the move,
 * so choosing Pokhara shows both arrivals and departures. Date bounds use the
 * Nepal calendar day because HR filters by the date on the office clock.
 */
export function buildEmployeeBranchTransferLogQuery(
  filters: EmployeeBranchTransferLogFilters = {}
) {
  const params: unknown[] = [];
  const where: string[] = [];

  if (filters.branchId) {
    params.push(filters.branchId);
    where.push(
      `(t.from_branch_id = $${params.length} OR t.to_branch_id = $${params.length})`
    );
  } else if (Array.isArray(filters.branchScope)) {
    if (filters.branchScope.length === 0) {
      where.push('FALSE');
    } else {
      params.push(filters.branchScope);
      where.push(
        `(t.from_branch_id = ANY($${params.length}::varchar[]) OR t.to_branch_id = ANY($${params.length}::varchar[]))`
      );
    }
  }

  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(
      `COALESCE(t.effective_date_ad, (t.created_at AT TIME ZONE 'Asia/Kathmandu')::date) >= $${params.length}::date`
    );
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(
      `COALESCE(t.effective_date_ad, (t.created_at AT TIME ZONE 'Asia/Kathmandu')::date) <= $${params.length}::date`
    );
  }

  return {
    sql: `SELECT
      t.id,
      t.employee_id AS "employeeId",
      e.employee_code AS "employeeCode",
      e.name AS "employeeName",
      t.from_branch_id AS "fromBranchId",
      t.from_branch_name AS "fromBranchName",
      t.to_branch_id AS "toBranchId",
      t.to_branch_name AS "toBranchName",
      t.transferred_by AS "transferredBy",
      t.effective_date_ad::text AS "effectiveDateAD",
      t.reason,
      t.status,
      t.approved_by AS "approvedBy",
      t.approved_at AS "approvedAt",
      t.decision_note AS "decisionNote",
      t.created_at AS "createdAt"
    FROM hr_employee_branch_transfers t
    JOIN employees e ON e.id = t.employee_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ${HR_BRANCH_TRANSFER_LOG_MAX}`,
    params,
  };
}
