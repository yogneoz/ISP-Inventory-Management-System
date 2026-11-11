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
  user_id AS "userId",
  department,
  designation,
  pan_number AS "panNumber",
  ssf_number AS "ssfNumber",
  bank_account AS "bankAccount",
  bank_name AS "bankName",
  employment_type AS "employmentType",
  joining_date_ad::text AS "joiningDateAD",
  date_of_birth_ad::text AS "dateOfBirthAD",
  contract_expiry_ad::text AS "contractExpiryAD",
  separation_date_ad::text AS "separationDateAD",
  designation_code AS "designationCode",
  work_station AS "workStation",
  address,
  personal_contact AS "personalContact",
  emergency_contact_person AS "emergencyContactPerson",
  emergency_contact_number AS "emergencyContactNumber",
  internal_email AS "internalEmail",
  personal_email AS "personalEmail",
  monthly_salary AS "monthlySalary",
  ssf_eligible AS "ssfEligible",
  profile_photo AS "profilePhoto",
  is_active AS "isActive",
  is_demo AS "isDemo",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

/**
 * The voucher picker needs a name and code, not payroll identifiers or bank
 * details. Keep this projection separate from the full employee master.
 */
export const EMPLOYEE_PICKER_COLUMNS = `id,
  employee_code AS "employeeCode",
  name,
  branch_id AS "branchId",
  department,
  designation,
  is_active AS "isActive"`;

/** Bounded register read; a branch with more staff pages through the filter. */
export const EMPLOYEE_LIST_MAX = 1000;
/** A picker page is deliberately much smaller than the master register. */
export const EMPLOYEE_PICKER_MAX = 50;

export interface EmployeeListOptions {
  /** A single branch id, or 'ALL'. Ignored when `branchScope` is present. */
  branchId?: string | null;
  /** Explicit allowed-branch list; an empty list means no rows. */
  branchScope?: string[] | null;
  query?: string | null;
  activeOnly?: boolean;
  /** Page size; clamped to the register ceiling. */
  limit?: number | null;
  /** Which fields a free-text query matches. Defaults to the full master. */
  queryFields?: 'master' | 'picker';
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
    const haystack =
      opts.queryFields === 'picker'
        ? `lower(employee_code || ' ' || name)`
        : `lower(employee_code || ' ' || name || ' ' || COALESCE(pan_number, '') || ' ' || COALESCE(ssf_number, ''))`;
    conditions.push(`${haystack} LIKE $${params.length}`);
  }
  if (opts.activeOnly) conditions.push('is_active = TRUE');

  return {
    whereSql: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export function buildEmployeeListQuery(opts: EmployeeListOptions = {}) {
  const { whereSql, params } = buildEmployeeWhere(opts);
  const limit = Math.min(
    EMPLOYEE_LIST_MAX,
    Math.max(1, Math.trunc(Number(opts.limit) || EMPLOYEE_LIST_MAX))
  );
  return {
    sql: `SELECT ${EMPLOYEE_COLUMNS} FROM employees${whereSql} ORDER BY employee_code ASC LIMIT ${limit}`,
    params,
  };
}

/**
 * Bounded slim employee lookup for the voucher picker: active rows only, a
 * code/name query, and a 20-row default capped at 50. It never selects PAN,
 * SSF or bank details.
 */
export function buildEmployeePickerQuery(opts: EmployeeListOptions = {}) {
  const { whereSql, params } = buildEmployeeWhere({
    ...opts,
    queryFields: 'picker',
    activeOnly: true,
  });
  const limit = Math.min(
    EMPLOYEE_PICKER_MAX,
    Math.max(1, Math.trunc(Number(opts.limit) || 20))
  );
  return {
    sql: `SELECT ${EMPLOYEE_PICKER_COLUMNS} FROM employees${whereSql} ORDER BY employee_code ASC LIMIT ${limit}`,
    params,
  };
}

export const EMPLOYEE_BY_ID_SQL = `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = $1`;

export const EMPLOYEE_BY_CODE_SQL = `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE employee_code = $1`;

/** A login account may be linked to at most one employee. */
export const HR_USER_BY_ID_SQL = 'SELECT id, email, name, role FROM users WHERE id = $1';

export const EMPLOYEE_LINKED_TO_USER_SQL = `SELECT id, employee_code AS "employeeCode"
FROM employees
WHERE user_id = $1 AND id <> $2
LIMIT 1`;

/** Link or unlink the ESS account; `$2` may be null to clear it. */
export const EMPLOYEE_SET_USER_SQL = `UPDATE employees SET
  user_id = $2,
  updated_by = COALESCE($3, updated_by),
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING ${EMPLOYEE_COLUMNS}`;

/** Bounded active-account list for the link picker; no password columns. */
export const EMPLOYEE_USER_OPTIONS_SQL = `SELECT
  u.id,
  u.name,
  u.email,
  u.role,
  (e.id IS NOT NULL) AS "linked"
FROM users u
LEFT JOIN employees e ON e.user_id = u.id
WHERE u.status = 'active'
ORDER BY LOWER(u.name) ASC, u.id ASC
LIMIT 500`;

/** `$1` is a text[] of ids; an empty array safely returns no rows. */
export const EMPLOYEES_BY_IDS_SQL = `SELECT ${EMPLOYEE_COLUMNS}
FROM employees
WHERE id = ANY($1::varchar[])
ORDER BY employee_code ASC`;

export const EMPLOYEE_INSERT_SQL = `INSERT INTO employees (
  id, employee_code, name, branch_id, department, designation, pan_number,
  ssf_number, bank_account, bank_name, employment_type, joining_date_ad,
  date_of_birth_ad, contract_expiry_ad, separation_date_ad, designation_code,
  work_station, address, personal_contact, emergency_contact_person,
  emergency_contact_number, internal_email, personal_email, monthly_salary,
  ssf_eligible, is_active, user_id, is_demo, created_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
  $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, FALSE, $28)
RETURNING ${EMPLOYEE_COLUMNS}`;

export interface EmployeeInsertInput {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  userId: string | null;
  department: string | null;
  designation: string | null;
  panNumber: string | null;
  ssfNumber: string | null;
  bankAccount: string | null;
  bankName: string | null;
  employmentType: string | null;
  joiningDateAD: string | null;
  dateOfBirthAD: string | null;
  contractExpiryAD: string | null;
  separationDateAD: string | null;
  designationCode: string | null;
  workStation: string | null;
  address: string | null;
  personalContact: string | null;
  emergencyContactPerson: string | null;
  emergencyContactNumber: string | null;
  internalEmail: string | null;
  personalEmail: string | null;
  monthlySalary: number | null;
  ssfEligible: boolean;
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
    input.bankName,
    input.employmentType,
    input.joiningDateAD,
    input.dateOfBirthAD,
    input.contractExpiryAD,
    input.separationDateAD,
    input.designationCode,
    input.workStation,
    input.address,
    input.personalContact,
    input.emergencyContactPerson,
    input.emergencyContactNumber,
    input.internalEmail,
    input.personalEmail,
    input.monthlySalary,
    input.ssfEligible,
    input.isActive,
    input.userId,
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
  bank_name = COALESCE($9, bank_name),
  employment_type = COALESCE($10, employment_type),
  joining_date_ad = COALESCE($11, joining_date_ad),
  date_of_birth_ad = COALESCE($12, date_of_birth_ad),
  contract_expiry_ad = COALESCE($13, contract_expiry_ad),
  designation_code = COALESCE($14, designation_code),
  work_station = COALESCE($15, work_station),
  address = COALESCE($16, address),
  personal_contact = COALESCE($17, personal_contact),
  emergency_contact_person = COALESCE($18, emergency_contact_person),
  emergency_contact_number = COALESCE($19, emergency_contact_number),
  internal_email = COALESCE($20, internal_email),
  personal_email = COALESCE($21, personal_email),
  monthly_salary = COALESCE($22, monthly_salary),
  ssf_eligible = COALESCE($23, ssf_eligible),
  updated_by = COALESCE($24, updated_by),
  separation_date_ad = CASE WHEN $25::boolean THEN $26::date ELSE separation_date_ad END,
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
  run_date_bs AS "runDateBS",
  gross_total::numeric AS "grossTotal",
  tds_total::numeric AS "tdsTotal",
  ssf_total::numeric AS "ssfTotal",
  advance_total::numeric AS "advanceTotal",
  loan_total::numeric AS "loanTotal",
  incentive_total::numeric AS "incentiveTotal",
  arrears_total::numeric AS "arrearsTotal",
  net_total::numeric AS "netTotal",
  status,
  journal_id AS "journalId",
  paid_journal_id AS "paidJournalId",
  paid_date_ad::text AS "paidDateAD",
  paid_date_bs AS "paidDateBS",
  payment_method AS "paymentMethod",
  posted_by AS "postedBy",
  prepared_by AS "preparedBy",
  prepared_at AS "preparedAt",
  approved_by AS "approvedBy",
  approved_at AS "approvedAt",
  statutory_config_id AS "statutoryConfigId",
  paid_at AS "paidAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export const PAYROLL_LINE_COLUMNS = `id,
  run_id AS "runId",
  employee_id AS "employeeId",
  employee_code AS "employeeCode",
  employee_name AS "employeeName",
  period_key AS "periodKey",
  salary_id AS "salaryId",
  basic_amount::numeric AS "basicAmount",
  payable_days::numeric AS "payableDays",
  lop_days::numeric AS "lopDays",
  lop_deduction::numeric AS "lopDeduction",
  overtime_hours::numeric AS "overtimeHours",
  overtime_amount::numeric AS "overtimeAmount",
  incentive_amount::numeric AS "incentive",
  arrears_amount::numeric AS "arrears",
  gross_amount::numeric AS "gross",
  tds_amount::numeric AS "tds",
  ssf_amount::numeric AS "ssf",
  employer_ssf_amount::numeric AS "employerSsf",
  advance_deduction::numeric AS "advance",
  loan_deduction::numeric AS "loan",
  net_amount::numeric AS "net"`;

/** Output-only line projection; bank details stay out of generic run payloads. */
export const PAYROLL_LINE_OUTPUT_COLUMNS = `${PAYROLL_LINE_COLUMNS},
  bank_name AS "bankName",
  bank_account AS "bankAccount"`;

export const PAYROLL_RUNS_MAX = 200;
/** The Finance postings register is a bounded read like the run list. */
export const PAYROLL_POSTINGS_MAX = 200;

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
  if (['DRAFT', 'APPROVED', 'POSTED', 'PAID'].includes(status)) {
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

export interface PayrollPostingsListOptions {
  branchId?: string | null;
  branchScope?: string[] | null;
  from?: string | null;
  to?: string | null;
  query?: string | null;
}

/**
 * Finance payroll-postings register: posted and paid runs only, with the
 * immutable run totals and the linked posting/payment journals. This is a
 * read-only projection; drafts and approved runs are deliberately excluded.
 */
export function buildPayrollPostingsQuery(opts: PayrollPostingsListOptions = {}) {
  const params: unknown[] = [];
  const conditions: string[] = [`r.status IN ('POSTED', 'PAID')`];

  if (Array.isArray(opts.branchScope)) {
    if (opts.branchScope.length === 0) {
      conditions.push('FALSE');
    } else {
      params.push(opts.branchScope);
      conditions.push(`r.branch_id = ANY($${params.length}::varchar[])`);
    }
  } else if (opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conditions.push(`r.branch_id = $${params.length}`);
  }

  if (opts.from) {
    params.push(opts.from);
    conditions.push(`r.run_date_ad >= $${params.length}::date`);
  }
  if (opts.to) {
    params.push(opts.to);
    conditions.push(`r.run_date_ad <= $${params.length}::date`);
  }

  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  if (query) {
    params.push(`%${query.toLowerCase()}%`);
    conditions.push(
      `(lower(r.run_no) LIKE $${params.length}
        OR lower(r.period_key) LIKE $${params.length}
        OR lower(COALESCE(b.name, '')) LIKE $${params.length})`
    );
  }

  return {
    sql: `SELECT
      r.id,
      r.run_no AS "runNo",
      r.branch_id AS "branchId",
      b.name AS "branchName",
      r.period_key AS "periodKey",
      r.run_date_ad::text AS "runDateAD",
      r.run_date_bs AS "runDateBS",
      r.gross_total::numeric AS "grossTotal",
      r.tds_total::numeric AS "tdsTotal",
      r.ssf_total::numeric AS "ssfTotal",
      r.advance_total::numeric AS "advanceTotal",
      r.loan_total::numeric AS "loanTotal",
      r.incentive_total::numeric AS "incentiveTotal",
      r.arrears_total::numeric AS "arrearsTotal",
      r.net_total::numeric AS "netTotal",
      r.status,
      r.journal_id AS "journalId",
      j.journal_no AS "journalNo",
      j.journal_date_ad::text AS "journalDateAD",
      j.status AS "journalStatus",
      COALESCE(jt.total_debit, 0)::numeric AS "journalDebit",
      COALESCE(jt.total_credit, 0)::numeric AS "journalCredit",
      r.paid_journal_id AS "paidJournalId",
      pj.journal_no AS "paymentJournalNo",
      pj.journal_date_ad::text AS "paymentJournalDateAD",
      pj.status AS "paymentJournalStatus",
      COALESCE(pt.total_debit, 0)::numeric AS "paymentDebit",
      COALESCE(pt.total_credit, 0)::numeric AS "paymentCredit",
      r.paid_date_ad::text AS "paidDateAD",
      r.paid_date_bs AS "paidDateBS",
      r.payment_method AS "paymentMethod",
      r.posted_by AS "postedBy",
      r.approved_by AS "approvedBy",
      r.paid_at AS "paidAt",
      (SELECT COUNT(*) FROM payroll_run_lines l WHERE l.run_id = r.id)::int AS "employeeCount"
    FROM payroll_runs r
    LEFT JOIN branches b ON b.id = r.branch_id
    LEFT JOIN gl_journals j ON j.id = r.journal_id
    LEFT JOIN gl_journals pj ON pj.id = r.paid_journal_id
    LEFT JOIN (
      SELECT journal_id, SUM(debit) AS total_debit, SUM(credit) AS total_credit
      FROM gl_journal_lines GROUP BY journal_id
    ) jt ON jt.journal_id = r.journal_id
    LEFT JOIN (
      SELECT journal_id, SUM(debit) AS total_debit, SUM(credit) AS total_credit
      FROM gl_journal_lines GROUP BY journal_id
    ) pt ON pt.journal_id = r.paid_journal_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY r.run_date_ad DESC, r.run_no DESC
    LIMIT ${PAYROLL_POSTINGS_MAX}`,
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

/** Posted payslips and bank files read the bank fields snapshotted on the line. */
export const PAYROLL_LINES_FOR_OUTPUT_SQL = `SELECT ${PAYROLL_LINE_OUTPUT_COLUMNS}
FROM payroll_run_lines
WHERE run_id = $1
ORDER BY employee_code ASC, id ASC`;

/** Human-readable branch name for a printable payroll output. */
export const BRANCH_NAME_BY_ID_SQL = `SELECT name
FROM branches WHERE id = $1`;

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
  id, run_no, branch_id, period_key, run_date_ad, run_date_bs, gross_total, tds_total,
  ssf_total, advance_total, loan_total, net_total, status, posted_by, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'POSTED', $13, FALSE)`;

/** A generated run starts DRAFT; its temporary number is replaced on posting. */
export const PAYROLL_RUN_DRAFT_INSERT_SQL = `INSERT INTO payroll_runs (
  id, run_no, branch_id, period_key, run_date_ad, run_date_bs, gross_total, tds_total,
  ssf_total, advance_total, loan_total, incentive_total, arrears_total, net_total,
  status, prepared_by, prepared_at, statutory_config_id, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
  'DRAFT', $15, CURRENT_TIMESTAMP, $16, FALSE)`;

export interface PayrollDraftInsertInput {
  id: string;
  runNo: string;
  branchId: string;
  periodKey: string;
  runDateAD: string;
  runDateBS: string;
  grossTotal: number;
  tdsTotal: number;
  ssfTotal: number;
  advanceTotal: number;
  loanTotal: number;
  incentiveTotal: number;
  arrearsTotal: number;
  netTotal: number;
  preparedBy: string | null;
  statutoryConfigId: string;
}

export function payrollDraftInsertParams(input: PayrollDraftInsertInput): unknown[] {
  return [
    input.id,
    input.runNo,
    input.branchId,
    input.periodKey,
    input.runDateAD,
    input.runDateBS,
    input.grossTotal,
    input.tdsTotal,
    input.ssfTotal,
    input.advanceTotal,
    input.loanTotal,
    input.incentiveTotal,
    input.arrearsTotal,
    input.netTotal,
    input.preparedBy,
    input.statutoryConfigId,
  ];
}

export interface PayrollRunInsertInput {
  id: string;
  runNo: string;
  branchId: string;
  periodKey: string;
  runDateAD: string;
  runDateBS: string;
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
    input.runDateBS,
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
  salary_id, basic_amount, payable_days, lop_days, lop_deduction, overtime_hours,
  overtime_amount, incentive_amount, arrears_amount, gross_amount, tds_amount,
  ssf_amount, employer_ssf_amount, advance_deduction, loan_deduction, net_amount,
  employee_ssf_percent, employer_ssf_percent,
  bank_name, bank_account
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
  $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
RETURNING ${PAYROLL_LINE_COLUMNS}`;

export interface PayrollLineInsertInput {
  id: string;
  runId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  periodKey: string;
  salaryId?: string | null;
  basicAmount?: number;
  payableDays?: number;
  lopDays?: number;
  lopDeduction?: number;
  overtimeHours?: number;
  overtimeAmount?: number;
  incentive?: number;
  arrears?: number;
  gross: number;
  tds: number;
  ssf: number;
  employerSsf?: number;
  /** The rates the shares were computed at; null on rows written before the snapshot existed. */
  employeeSsfPercent?: number | null;
  employerSsfPercent?: number | null;
  advance: number;
  loan: number;
  net: number;
  bankName?: string | null;
  bankAccount?: string | null;
}

export function payrollLineInsertParams(input: PayrollLineInsertInput): unknown[] {
  return [
    input.id,
    input.runId,
    input.employeeId,
    input.employeeCode,
    input.employeeName,
    input.periodKey,
    input.salaryId ?? null,
    input.basicAmount ?? 0,
    input.payableDays ?? 0,
    input.lopDays ?? 0,
    input.lopDeduction ?? 0,
    input.overtimeHours ?? 0,
    input.overtimeAmount ?? 0,
    input.incentive ?? 0,
    input.arrears ?? 0,
    input.gross,
    input.tds,
    input.ssf,
    input.employerSsf ?? 0,
    input.advance,
    input.loan,
    input.net,
    input.employeeSsfPercent ?? null,
    input.employerSsfPercent ?? null,
    input.bankName ?? null,
    input.bankAccount ?? null,
  ];
}

export const PAYROLL_RUN_SET_JOURNAL_SQL = `UPDATE payroll_runs SET
  journal_id = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const PAYROLL_RUN_SET_APPROVED_SQL = `UPDATE payroll_runs SET
  status = 'APPROVED',
  approved_by = $2,
  approved_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'DRAFT'
RETURNING ${PAYROLL_RUN_COLUMNS}`;

export const PAYROLL_RUN_SET_POSTED_SQL = `UPDATE payroll_runs SET
  status = 'POSTED',
  run_no = $2,
  journal_id = $3,
  posted_by = $4,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'APPROVED'
RETURNING ${PAYROLL_RUN_COLUMNS}`;

export const PAYROLL_RUN_DELETE_DRAFT_SQL = `DELETE FROM payroll_runs
WHERE id = $1 AND status = 'DRAFT'`;

export const PAYROLL_RUN_SET_PAID_SQL = `UPDATE payroll_runs SET
  status = 'PAID',
  paid_journal_id = $2,
  paid_date_ad = $3,
  paid_date_bs = $4,
  payment_method = $5,
  paid_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;
