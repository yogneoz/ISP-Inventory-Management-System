/**
 * Payroll reads and writes: the employee master, posted runs, their
 * per-employee lines and the employee-ledger projection.
 *
 * The ledger itself stays generic: a payroll run writes EMPLOYEE subledger
 * rows through `postJournal`, and the employee ledger here only reads those
 * rows back. There is no payroll-specific balance table to keep in sync.
 *
 * Every SQL string lives in this model (the no-inline-SQL gate); the
 * controller owns validation and the transaction.
 */

export const EMPLOYEE_COLUMNS = `id,
  employee_code AS "employeeCode",
  name,
  branch_id AS "branchId",
  department,
  designation,
  pan_number AS "panNumber",
  ssf_number AS "ssfNumber",
  bank_account AS "bankAccount",
  is_active AS "isActive",
  is_demo AS "isDemo",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

/** Bounded register read; a branch with more staff pages through the filter. */
export const EMPLOYEE_LIST_MAX = 1000;

export interface EmployeeListOptions {
  /** A single branch id, or 'ALL'. Ignored when `branchScope` is present. */
  branchId?: string | null;
  /** Explicit allowed-branch list; an empty list means no rows. */
  branchScope?: string[] | null;
  query?: string | null;
  activeOnly?: boolean;
}

/** Shared WHERE for the employee list and its count-free bounded read. */
export function buildEmployeeWhere(opts: EmployeeListOptions = {}): {
  whereSql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (Array.isArray(opts.branchScope)) {
    if (opts.branchScope.length === 0) {
      conditions.push('FALSE');
    } else {
      params.push(opts.branchScope);
      conditions.push(`branch_id = ANY($${params.length}::varchar[])`);
    }
  } else if (opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conditions.push(`branch_id = $${params.length}`);
  }

  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  if (query) {
    params.push(`%${query.toLowerCase()}%`);
    conditions.push(
      `lower(employee_code || ' ' || name || ' ' || COALESCE(pan_number, '') || ' ' || COALESCE(ssf_number, '')) LIKE $${params.length}`
    );
  }
  if (opts.activeOnly) conditions.push('is_active = TRUE');

  return {
    whereSql: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export function buildEmployeeListQuery(opts: EmployeeListOptions = {}) {
  const { whereSql, params } = buildEmployeeWhere(opts);
  return {
    sql: `SELECT ${EMPLOYEE_COLUMNS} FROM employees${whereSql} ORDER BY employee_code ASC LIMIT ${EMPLOYEE_LIST_MAX}`,
    params,
  };
}

export const EMPLOYEE_BY_ID_SQL = `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = $1`;

export const EMPLOYEE_BY_CODE_SQL = `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE employee_code = $1`;

/** `$1` is a text[] of ids; an empty array safely returns no rows. */
export const EMPLOYEES_BY_IDS_SQL = `SELECT ${EMPLOYEE_COLUMNS}
FROM employees
WHERE id = ANY($1::varchar[])
ORDER BY employee_code ASC`;

export const EMPLOYEE_INSERT_SQL = `INSERT INTO employees (
  id, employee_code, name, branch_id, department, designation, pan_number,
  ssf_number, bank_account, is_active, is_demo, created_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, $11)
RETURNING ${EMPLOYEE_COLUMNS}`;

export interface EmployeeInsertInput {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  department: string | null;
  designation: string | null;
  panNumber: string | null;
  ssfNumber: string | null;
  bankAccount: string | null;
  isActive: boolean;
  createdBy: string | null;
}

export function employeeInsertParams(input: EmployeeInsertInput): unknown[] {
  return [
    input.id,
    input.employeeCode,
    input.name,
    input.branchId,
    input.department,
    input.designation,
    input.panNumber,
    input.ssfNumber,
    input.bankAccount,
    input.isActive,
    input.createdBy,
  ];
}

/**
 * PATCH keeps every field it is not given: a missing property is null in the
 * parameter list and COALESCE leaves the stored value alone. Branch and code
 * are immutable because payroll history is filed under them.
 */
export const EMPLOYEE_UPDATE_SQL = `UPDATE employees SET
  name = COALESCE($2, name),
  department = COALESCE($3, department),
  designation = COALESCE($4, designation),
  pan_number = COALESCE($5, pan_number),
  ssf_number = COALESCE($6, ssf_number),
  bank_account = COALESCE($7, bank_account),
  is_active = COALESCE($8, is_active),
  updated_by = COALESCE($9, updated_by),
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING ${EMPLOYEE_COLUMNS}`;

/**
 * One employee's employee-subledger movements. The subledger is the generic
 * `gl_subledger_entries` table written by every payroll journal, so this is a
 * real ledger read, not a second balance store.
 */
export const EMPLOYEE_LEDGER_ENTRIES_SQL = `SELECT
  s.id,
  j.journal_no AS "journalNo",
  j.journal_date_ad::text AS "journalDateAD",
  j.source_type AS "sourceType",
  j.memo,
  a.id AS "accountId",
  a.code AS "accountCode",
  a.name AS "accountName",
  g.account_type AS "accountType",
  s.debit::numeric AS debit,
  s.credit::numeric AS credit
FROM gl_subledger_entries s
JOIN gl_journals j ON j.id = s.journal_id
JOIN gl_accounts a ON a.id = s.account_id
JOIN gl_account_groups g ON g.id = a.group_id
WHERE s.subledger_type = 'EMPLOYEE'
  AND s.party_id = $1
  AND ($2::varchar IS NULL OR s.branch_id = $2)
  AND ($3::date IS NULL OR s.entry_date_ad >= $3)
  AND ($4::date IS NULL OR s.entry_date_ad <= $4)
ORDER BY s.entry_date_ad ASC, j.journal_no ASC, a.code ASC, s.id ASC`;

export const EMPLOYEE_LEDGER_ACCOUNT_BALANCES_SQL = `SELECT
  a.id AS "accountId",
  a.code,
  a.name,
  g.account_type AS "accountType",
  a.posting_role AS "postingRole",
  COALESCE(SUM(s.debit), 0)::numeric AS debit,
  COALESCE(SUM(s.credit), 0)::numeric AS credit,
  COALESCE(SUM(s.debit - s.credit), 0)::numeric AS balance
FROM gl_subledger_entries s
JOIN gl_accounts a ON a.id = s.account_id
JOIN gl_account_groups g ON g.id = a.group_id
WHERE s.subledger_type = 'EMPLOYEE'
  AND s.party_id = $1
  AND ($2::varchar IS NULL OR s.branch_id = $2)
  AND ($3::date IS NULL OR s.entry_date_ad >= $3)
  AND ($4::date IS NULL OR s.entry_date_ad <= $4)
GROUP BY a.id, a.code, a.name, g.account_type, a.posting_role
ORDER BY a.code ASC`;

export const PAYROLL_RUN_COLUMNS = `id,
  run_no AS "runNo",
  branch_id AS "branchId",
  period_key AS "periodKey",
  run_date_ad::text AS "runDateAD",
  gross_total::numeric AS "grossTotal",
  tds_total::numeric AS "tdsTotal",
  ssf_total::numeric AS "ssfTotal",
  advance_total::numeric AS "advanceTotal",
  loan_total::numeric AS "loanTotal",
  net_total::numeric AS "netTotal",
  status,
  journal_id AS "journalId",
  paid_journal_id AS "paidJournalId",
  paid_date_ad::text AS "paidDateAD",
  payment_method AS "paymentMethod",
  posted_by AS "postedBy",
  paid_at AS "paidAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export const PAYROLL_LINE_COLUMNS = `id,
  run_id AS "runId",
  employee_id AS "employeeId",
  employee_code AS "employeeCode",
  employee_name AS "employeeName",
  period_key AS "periodKey",
  gross_amount::numeric AS "gross",
  tds_amount::numeric AS "tds",
  ssf_amount::numeric AS "ssf",
  advance_deduction::numeric AS "advance",
  loan_deduction::numeric AS "loan",
  net_amount::numeric AS "net"`;

export const PAYROLL_RUNS_MAX = 200;

export interface PayrollRunListOptions {
  branchId?: string | null;
  branchScope?: string[] | null;
  periodKey?: string | null;
  status?: string | null;
}

export function buildPayrollRunWhere(opts: PayrollRunListOptions = {}): {
  whereSql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (Array.isArray(opts.branchScope)) {
    if (opts.branchScope.length === 0) {
      conditions.push('FALSE');
    } else {
      params.push(opts.branchScope);
      conditions.push(`branch_id = ANY($${params.length}::varchar[])`);
    }
  } else if (opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conditions.push(`branch_id = $${params.length}`);
  }
  if (opts.periodKey) {
    params.push(opts.periodKey);
    conditions.push(`period_key = $${params.length}`);
  }
  const status = typeof opts.status === 'string' ? opts.status.trim().toUpperCase() : '';
  if (status === 'POSTED' || status === 'PAID') {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  return {
    whereSql: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export function buildPayrollRunListQuery(opts: PayrollRunListOptions = {}) {
  const { whereSql, params } = buildPayrollRunWhere(opts);
  return {
    sql: `SELECT ${PAYROLL_RUN_COLUMNS} FROM payroll_runs${whereSql}
      ORDER BY run_date_ad DESC, run_no DESC
      LIMIT ${PAYROLL_RUNS_MAX}`,
    params,
  };
}

export const PAYROLL_RUN_BY_ID_SQL = `SELECT ${PAYROLL_RUN_COLUMNS}
FROM payroll_runs WHERE id = $1`;

/** Row lock for a payment retry; also returns the current status. */
export const PAYROLL_RUN_LOCK_ROW_SQL = `SELECT ${PAYROLL_RUN_COLUMNS}
FROM payroll_runs WHERE id = $1 FOR UPDATE`;

export const PAYROLL_RUN_BY_BRANCH_PERIOD_SQL = `SELECT ${PAYROLL_RUN_COLUMNS}
FROM payroll_runs WHERE branch_id = $1 AND period_key = $2`;

export const PAYROLL_LINES_BY_RUN_SQL = `SELECT ${PAYROLL_LINE_COLUMNS}
FROM payroll_run_lines
WHERE run_id = $1
ORDER BY employee_code ASC, id ASC`;

/**
 * The employee-period guard. A line exists only after its run committed, so
 * this is the durable "already paid for this month" fact; the unique index
 * (employee_id, period_key) closes the concurrent-insert race.
 */
export const PAYROLL_EMPLOYEE_PERIOD_CONFLICTS_SQL = `SELECT
  l.employee_id AS "employeeId",
  l.employee_code AS "employeeCode",
  r.run_no AS "runNo"
FROM payroll_run_lines l
JOIN payroll_runs r ON r.id = l.run_id
WHERE l.period_key = $1
  AND l.employee_id = ANY($2::varchar[])
ORDER BY l.employee_code ASC`;

/** One branch+period at a time; the duplicate check runs under this lock. */
export const PAYROLL_RUN_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1))::text AS lock`;

export const PAYROLL_RUN_INSERT_SQL = `INSERT INTO payroll_runs (
  id, run_no, branch_id, period_key, run_date_ad, gross_total, tds_total,
  ssf_total, advance_total, loan_total, net_total, status, posted_by, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'POSTED', $12, FALSE)`;

export interface PayrollRunInsertInput {
  id: string;
  runNo: string;
  branchId: string;
  periodKey: string;
  runDateAD: string;
  grossTotal: number;
  tdsTotal: number;
  ssfTotal: number;
  advanceTotal: number;
  loanTotal: number;
  netTotal: number;
  postedBy: string | null;
}

export function payrollRunInsertParams(input: PayrollRunInsertInput): unknown[] {
  return [
    input.id,
    input.runNo,
    input.branchId,
    input.periodKey,
    input.runDateAD,
    input.grossTotal,
    input.tdsTotal,
    input.ssfTotal,
    input.advanceTotal,
    input.loanTotal,
    input.netTotal,
    input.postedBy,
  ];
}

export const PAYROLL_LINE_INSERT_SQL = `INSERT INTO payroll_run_lines (
  id, run_id, employee_id, employee_code, employee_name, period_key,
  gross_amount, tds_amount, ssf_amount, advance_deduction, loan_deduction,
  net_amount
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING ${PAYROLL_LINE_COLUMNS}`;

export interface PayrollLineInsertInput {
  id: string;
  runId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  periodKey: string;
  gross: number;
  tds: number;
  ssf: number;
  advance: number;
  loan: number;
  net: number;
}

export function payrollLineInsertParams(input: PayrollLineInsertInput): unknown[] {
  return [
    input.id,
    input.runId,
    input.employeeId,
    input.employeeCode,
    input.employeeName,
    input.periodKey,
    input.gross,
    input.tds,
    input.ssf,
    input.advance,
    input.loan,
    input.net,
  ];
}

export const PAYROLL_RUN_SET_JOURNAL_SQL = `UPDATE payroll_runs SET
  journal_id = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const PAYROLL_RUN_SET_PAID_SQL = `UPDATE payroll_runs SET
  status = 'PAID',
  paid_journal_id = $2,
  paid_date_ad = $3,
  payment_method = $4,
  paid_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;
