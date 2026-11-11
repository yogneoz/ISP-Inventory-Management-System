/**
 * Payroll HTTP surface: employee master, posted payroll runs, run payment and
 * the employee ledger.
 *
 * The run's amounts are entered or imported — this module deliberately does not
 * calculate salary. What it does guarantee is the ledger contract: a run row,
 * its per-employee lines, one balanced journal with EMPLOYEE subledger rows and
 * the audit row commit together, and a payment clears salary payable in the
 * same way. A closed period, a duplicate branch+period run or an employee
 * already paid for the month refuses the whole write, leaving nothing behind.
 *
 * Branch scope is resolved from the session, never trusted from the body alone.
 * The app-level guard already covers `/employees/:id` and `/payroll-runs/:id`;
 * the controller repeats the check so a future route registration cannot widen
 * payroll silently.
 */
import crypto from 'crypto';
import type { Response } from 'express';
import {
  getPgConnected,
  permissionMatrix,
  pgPool,
  setUsers,
  users,
  withReplaced,
  userPermissionOverrides,
  userPermissionSetGrants,
} from '../app';
import { effectivePermission } from '../services/permissionOverrides.service';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq, hashPassword } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import {
  BRANCH_EXISTS_SQL,
  JOURNAL_BY_ID_SQL,
  JOURNAL_FIND_BY_SOURCE_SQL,
} from '../models/accounting.repo';
import {
  EMPLOYEE_BY_CODE_SQL,
  EMPLOYEE_BY_ID_SQL,
  EMPLOYEE_INSERT_SQL,
  EMPLOYEE_LINKED_TO_USER_SQL,
  EMPLOYEE_LEDGER_ACCOUNT_BALANCES_SQL,
  EMPLOYEE_LEDGER_ENTRIES_SQL,
  EMPLOYEE_SET_USER_SQL,
  EMPLOYEE_PROFILE_PHOTO_SQL,
  EMPLOYEE_UPDATE_SQL,
  EMPLOYEE_USER_OPTIONS_SQL,
  HR_USER_BY_ID_SQL,
  EMPLOYEES_BY_IDS_SQL,
  PAYROLL_EMPLOYEE_PERIOD_CONFLICTS_SQL,
  PAYROLL_LINES_BY_RUN_SQL,
  PAYROLL_LINES_FOR_OUTPUT_SQL,
  PAYROLL_LINE_INSERT_SQL,
  PAYROLL_RUN_BY_BRANCH_PERIOD_SQL,
  PAYROLL_RUN_BY_ID_SQL,
  PAYROLL_RUN_DELETE_DRAFT_SQL,
  PAYROLL_RUN_DRAFT_INSERT_SQL,
  PAYROLL_RUN_INSERT_SQL,
  PAYROLL_RUN_LOCK_ROW_SQL,
  PAYROLL_RUN_LOCK_SQL,
  PAYROLL_RUN_SET_APPROVED_SQL,
  PAYROLL_RUN_SET_JOURNAL_SQL,
  PAYROLL_RUN_SET_PAID_SQL,
  PAYROLL_RUN_SET_POSTED_SQL,
  BRANCH_NAME_BY_ID_SQL,
  buildEmployeeListQuery,
  buildEmployeePickerQuery,
  buildPayrollPostingsQuery,
  buildPayrollRunListQuery,
  employeeInsertParams,
  payrollDraftInsertParams,
  payrollLineInsertParams,
  payrollRunInsertParams,
} from '../models/payroll.repo';
import { USER_INSERT_TEMP_PASSWORD_SQL } from '../models/admin.repo';
import { USER_RESTORE_SQL, USER_SUSPEND_SQL } from '../models/auth.repo';
import {
  HR_PAYROLL_ADJUSTMENTS_BY_BRANCH_PERIOD_SQL,
  HR_PAYROLL_INPUT_LIST_SQL,
} from '../models/hrPayrollInputs.repo';
import {
  HR_SALARY_COMPONENTS_BY_SALARY_IDS_SQL,
  HR_SALARY_EFFECTIVE_LIST_SQL,
} from '../models/hrSalary.repo';
import {
  HR_STATUTORY_CONFIG_BY_YEAR_SQL,
  HR_STATUTORY_FISCAL_YEAR_FOR_DATE_SQL,
  HR_STATUTORY_SLABS_BY_CONFIG_IDS_SQL,
} from '../models/hrStatutory.repo';
import {
  isAccountingDate,
  isUniqueViolation,
  periodBounds,
  periodKeyForDate,
} from '../services/accounting.service';
import {
  postPayrollPaymentJournal,
  postPayrollRunJournal,
  type PayrollPostingLine,
} from '../services/payrollPosting.service';
import {
  buildPayrollDraft,
  type PayrollDraftStructure,
} from '../services/payrollDraft.service';
import {
  buildPayrollBankFile,
  buildPayrollOutput,
  buildPayrollReconciliation,
  isPayrollOutputReady,
  type PayrollJournalSummary,
  type PayrollOutput,
} from '../services/payrollOutput.service';
import { bsDateOrThrow } from '../utils/bsDate';
import { issueNextDocNumber } from '../utils/docNumber';
import { roundMoney } from '../utils/money';

interface PayrollScope {
  /** A concrete filter branch; undefined means all branches (global only). */
  branchId?: string;
  /** Allowed branches, or null for a global account. */
  allowed: Set<string> | null;
  /** A branch account with no assigned branch may act on nothing. */
  empty?: boolean;
}

/**
 * A payroll journal is one balanced document; 1 + 6×190 = 1141 stays under the
 * 1500-line cap (`MAX_JOURNAL_LINES`). Exported so a test can keep the two
 * limits in step: adding a posted line per employee must not outgrow the ledger.
 */
export const PAYROLL_EMPLOYEES_PER_RUN_MAX = 190;

function holdsPermission(req: any, operation: string): boolean {
  const user = req.user || getUserFromReq(req);
  return effectivePermission(
    user,
    operation,
    permissionMatrix,
    userPermissionOverrides,
    userPermissionSetGrants
  );
}

/** HR prepares the month; a payroll manager (or the legacy HR grant) may do it. */
function requirePrepare(req: any): void {
  if (!holdsPermission(req, 'hr-employee-manage') && !holdsPermission(req, 'gl-payroll-manage')) {
    throw new ApiError(
      403,
      'Payroll preparation requires the HR employee-manage or payroll-manage permission.'
    );
  }
}

/**
 * Run reads are Finance (gl-view) or the HR/payroll manager grants. HR must be
 * able to see and follow the draft it prepared; approval stays Finance-only.
 */
export function requirePayrollRead(req: any): void {
  if (
    !holdsPermission(req, 'gl-view') &&
    !holdsPermission(req, 'hr-employee-manage') &&
    !holdsPermission(req, 'gl-payroll-manage')
  ) {
    throw new ApiError(403, 'Payroll run reads require the ledger-view or payroll-manage permission.');
  }
}

/** Approval, posting and payment are Finance controls, never HR controls. */
function requirePost(req: any): void {
  if (!holdsPermission(req, 'gl-payroll-post')) {
    throw new ApiError(403, 'Payroll approval and posting require the payroll-post permission.');
  }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function requireDb(): void {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
}

/** The branch filter this request may use; writes a 403 and returns null when not. */
function resolveScope(req: any, res: Response): PayrollScope | null {
  const user = req.user;
  if (!user) {
    res.status(401).json({ message: 'Unauthorized: Authentication required' });
    return null;
  }
  const raw = text(req.query?.branchId ?? req.body?.branchId, 50);
  const allowed = allowedBranchScope(user);
  if (!allowed) {
    return { branchId: raw && raw !== 'ALL' ? raw : undefined, allowed: null };
  }
  if (allowed.size === 0) return { empty: true, allowed };
  if (raw === 'ALL') {
    res.status(403).json({ message: 'Forbidden: branch users cannot access all branches.' });
    return null;
  }
  if (raw && !allowed.has(raw)) {
    res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
    return null;
  }
  return { branchId: raw || user.branchId || [...allowed][0], allowed };
}

function assertInScope(scope: PayrollScope, branchId: string, res: Response): boolean {
  if (scope.allowed && !scope.allowed.has(branchId)) {
    res.status(403).json({ message: 'Forbidden: this record belongs to another branch.' });
    return false;
  }
  return true;
}

function nonNegativeAmount(value: unknown, field: string): number {
  const parsed = roundMoney(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, `${field} must be a non-negative amount.`);
  }
  if (parsed > 99_999_999_999.99) throw new ApiError(400, `${field} exceeds the ledger limit.`);
  return parsed;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = text(value, 10);
  if (!isAccountingDate(date)) throw new ApiError(400, `${field} must be a real date in YYYY-MM-DD form.`);
  return date;
}

function normalizeEmployeeCode(value: unknown): string {
  const code = text(value, 50).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(code)) {
    throw new ApiError(400, 'Employee code must be 1–50 letters, digits, dots, dashes, slashes or underscores.');
  }
  return code;
}

function optionalText(value: unknown, max: number): string | null {
  const parsed = text(value, max);
  return parsed || null;
}

/** Optional non-negative money value; an empty value means "not supplied". */
function optionalAmount(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = roundMoney(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, `${field} must be a non-negative amount.`);
  }
  if (parsed > 99_999_999_999.99) throw new ApiError(400, `${field} exceeds the ledger limit.`);
  return parsed;
}

/** Reads a boolean flag while leaving an omitted field as "not supplied". */
function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Fields a read-only HR caller must not receive; all are nullable on the wire. */
const EMPLOYEE_PII_FIELDS = [
  'dateOfBirthAD',
  'address',
  'personalContact',
  'emergencyContactPerson',
  'emergencyContactNumber',
  'personalEmail',
  'panNumber',
  'ssfNumber',
  'bankName',
  'bankAccount',
  'monthlySalary',
] as const;

/**
 * Full employee detail requires the manage grant. The legacy payroll grant is
 * explicitly treated as full access so existing payroll managers keep working;
 * `hr-employee-view` on its own never reveals the fields above.
 */
export function seesFullEmployeePii(req: any): boolean {
  const user = req.user || getUserFromReq(req);
  return (
    effectivePermission(
      user,
      'hr-employee-manage',
      permissionMatrix,
      userPermissionOverrides,
      userPermissionSetGrants
    ) ||
    effectivePermission(
      user,
      'gl-payroll-manage',
      permissionMatrix,
      userPermissionOverrides,
      userPermissionSetGrants
    )
  );
}

function presentEmployee(req: any, employee: any): any {
  if (!employee || seesFullEmployeePii(req)) return employee;
  const masked = { ...employee };
  for (const field of EMPLOYEE_PII_FIELDS) masked[field] = null;
  return masked;
}

/** A login account can be linked to only one employee, and must exist. */
async function assertEmployeeUserLinkable(
  client: any,
  userId: string,
  employeeId: string
): Promise<void> {
  if (!(await client.query(HR_USER_BY_ID_SQL, [userId])).rows[0]) {
    throw new ApiError(400, `User account ${userId} does not exist.`);
  }
  const linked = (await client.query(EMPLOYEE_LINKED_TO_USER_SQL, [userId, employeeId])).rows[0];
  if (linked) {
    throw new ApiError(409, `That user account is already linked to employee ${linked.employeeCode}.`);
  }
}

const EMPLOYEE_LOGIN_ROLES = new Set([
  'SUPER_ADMIN',
  'HEAD_OFFICE_ADMIN',
  'HR_MANAGER',
  'HR_OFFICER',
  'BRANCH_MANAGER',
  'INVENTORY_MANAGER',
  'ACCOUNTANT',
  'PROCUREMENT_OFFICER',
  'FIELD_TECHNICIAN',
  'FRONT_DESK',
  'AUDITOR',
]);

interface EmployeeLoginHandoff {
  email: string;
  role: string;
  temporaryPassword: string;
}

/**
 * Creates the login that belongs to this employee, in the employee's own
 * transaction. The account starts on a one-time password that HR reads once and
 * hands over; `must_change_password` blocks every screen but the password
 * change until the employee replaces it, so no administrator ever knows the
 * credential in use.
 */
async function createEmployeeLogin(
  client: any,
  req: any,
  target: { id: string; name: string; branchId: string; internalEmail?: string | null; personalEmail?: string | null },
  role: string
): Promise<EmployeeLoginHandoff> {
  const existing = (await client.query(EMPLOYEE_BY_ID_SQL, [target.id])).rows[0];
  if (existing?.userId) {
    throw new ApiError(409, `${existing.employeeCode} already has a login. Use the linked account instead.`);
  }
  if (existing && existing.isActive === false) {
    throw new ApiError(400, 'Reactivate the employee before creating a login for them.');
  }
  const email = String(target.internalEmail || target.personalEmail || '')
    .trim()
    .toLowerCase();
  if (!email) {
    throw new ApiError(400, 'Add an internal or personal e-mail before creating a login.');
  }
  if (!EMPLOYEE_LOGIN_ROLES.has(role)) {
    throw new ApiError(400, 'Choose a valid role for the new login.');
  }
  const temporaryPassword = crypto.randomBytes(12).toString('base64url').slice(0, 14);
  const userId = `usr-${crypto.randomUUID()}`;
  try {
    await client.query(USER_INSERT_TEMP_PASSWORD_SQL, [
      userId,
      email,
      hashPassword(temporaryPassword),
      target.name,
      role,
      target.branchId,
      [target.branchId],
    ]);
  } catch (err: any) {
    if (err?.code === '23505') throw new ApiError(409, `A login already exists for ${email}.`);
    throw err;
  }
  await client.query(EMPLOYEE_SET_USER_SQL, [target.id, userId, actorOf(req)]);
  await logAuditEvent(
    req,
    'CREATE_USER',
    'AUTH',
    `Created login ${email} (${role}, one-time password) for employee ${existing?.employeeCode || target.id}`,
    target.branchId,
    client
  );
  return { email, role, temporaryPassword };
}

/**
 * An employee's login follows their employment, in the same transaction as the
 * HR edit: deactivation suspends the account (the session fingerprint covers
 * status, so every token dies with it), reactivation restores it. A deliberate
 * lock or suspension stays: the SQL only moves active → inactive and back.
 */
async function syncEmployeeLoginStatus(
  client: any,
  req: any,
  employee: any,
  wasActive: boolean
): Promise<void> {
  if (!employee?.userId || Boolean(employee.isActive) === Boolean(wasActive)) return;
  const result = await client.query(employee.isActive ? USER_RESTORE_SQL : USER_SUSPEND_SQL, [
    employee.userId,
  ]);
  const row = result.rows[0];
  if (!row) return;
  const idx = users.findIndex((user) => user.id === employee.userId);
  if (idx !== -1) {
    setUsers(withReplaced(users, idx, { ...users[idx], status: row.status } as any));
  }
  await logAuditEvent(
    req,
    'UPDATE_USER',
    'AUTH',
    `${employee.isActive ? 'Restored' : 'Suspended'} the login of ${employee.employeeCode} ${employee.name} with the employee record`,
    String(employee.branchId),
    client
  );
}

/** GET /api/employees?branchId=&query=&activeOnly=1 */
export async function get_employees(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.json([]);
  const rawBranch = text(req.query?.branchId, 50);
  const options =
    rawBranch && rawBranch !== 'ALL'
      ? { branchId: rawBranch }
      : scope.allowed
        ? { branchScope: [...scope.allowed] }
        : {};
  const { sql, params } = buildEmployeeListQuery({
    ...options,
    query: text(req.query?.query, 100) || null,
    activeOnly: String(req.query?.activeOnly ?? '') === '1',
    limit: req.query?.limit ? Number(req.query.limit) : undefined,
  });
  const rows = (await pgPool.query(sql, params)).rows;
  return res.json(rows.map((row: any) => presentEmployee(req, row)));
}

/** GET /api/employees/search?branchId=&query=&limit= */
export async function search_employees(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.json([]);
  const rawBranch = text(req.query?.branchId, 50);
  const options =
    rawBranch && rawBranch !== 'ALL'
      ? { branchId: rawBranch }
      : scope.allowed
        ? { branchScope: [...scope.allowed] }
        : {};
  const { sql, params } = buildEmployeePickerQuery({
    ...options,
    query: text(req.query?.query, 100) || null,
    limit: req.query?.limit ? Number(req.query.limit) : undefined,
  });
  return res.json((await pgPool.query(sql, params)).rows);
}

/** GET /api/employees/user-options — active accounts available for linking. */
export async function get_employeeUserOptions(_req: any, res: Response): Promise<any> {
  requireDb();
  return res.json((await pgPool.query(EMPLOYEE_USER_OPTIONS_SQL)).rows);
}

/** GET /api/employees/:id — the employee detail read, masked for hr-view-only. */
export async function get_employee(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(404, 'Employee not found.');
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An employee id is required.');

  const employee = (await pgPool.query(EMPLOYEE_BY_ID_SQL, [id])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  if (!assertInScope(scope, String(employee.branchId), res)) return;
  return res.json(presentEmployee(req, employee));
}

/** POST /api/employees */
export async function post_employee(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'This account is not assigned to any branch.');

  const employeeCode = normalizeEmployeeCode(req.body?.employeeCode);
  const userId = optionalText(req.body?.userId, 50);
  const name = text(req.body?.name, 200);
  const branchId = text(req.body?.branchId, 50);
  if (!name) throw new ApiError(400, 'Employee name is required.');
  if (!branchId || branchId === 'ALL') throw new ApiError(400, 'A concrete branch is required for an employee.');
  if (!assertInScope(scope, branchId, res)) return;
  const joiningDateAD = optionalDate(req.body?.joiningDateAD, 'Joining date');
  const separationDateAD = optionalDate(req.body?.separationDateAD, 'Separation date');
  if (joiningDateAD && separationDateAD && separationDateAD < joiningDateAD) {
    throw new ApiError(400, 'Separation date must be on or after the joining date.');
  }

  let employeeLogin: EmployeeLoginHandoff | null = null;
  const employee = await withTransaction(async (client) => {
    if (!(await client.query(BRANCH_EXISTS_SQL, [branchId])).rows[0]) {
      throw new ApiError(400, `Branch ${branchId} does not exist.`);
    }
    if ((await client.query(EMPLOYEE_BY_CODE_SQL, [employeeCode])).rows[0]) {
      throw new ApiError(409, `Employee code ${employeeCode} already exists.`);
    }
    if (userId) await assertEmployeeUserLinkable(client, userId, '');
    const id = `emp-${crypto.randomUUID()}`;
    const created = (
      await client.query(
        EMPLOYEE_INSERT_SQL,
        employeeInsertParams({
          id,
          employeeCode,
          name,
          branchId,
          userId,
          department: optionalText(req.body?.department, 120),
          designation: optionalText(req.body?.designation, 120),
          panNumber: optionalText(req.body?.panNumber, 50),
          ssfNumber: optionalText(req.body?.ssfNumber, 50),
          bankAccount: optionalText(req.body?.bankAccount, 80),
          bankName: optionalText(req.body?.bankName, 150),
          employmentType: optionalText(req.body?.employmentType, 30),
          joiningDateAD,
          dateOfBirthAD: optionalDate(req.body?.dateOfBirthAD, 'Date of birth'),
          contractExpiryAD: optionalDate(req.body?.contractExpiryAD, 'Contract expiry'),
          separationDateAD,
          designationCode: optionalText(req.body?.designationCode, 30),
          workStation: optionalText(req.body?.workStation, 150),
          address: optionalText(req.body?.address, 500),
          personalContact: optionalText(req.body?.personalContact, 30),
          emergencyContactPerson: optionalText(req.body?.emergencyContactPerson, 150),
          emergencyContactNumber: optionalText(req.body?.emergencyContactNumber, 30),
          internalEmail: optionalText(req.body?.internalEmail, 150),
          personalEmail: optionalText(req.body?.personalEmail, 150),
          monthlySalary: optionalAmount(req.body?.monthlySalary, 'Monthly salary'),
          ssfEligible: optionalBoolean(req.body?.ssfEligible) ?? false,
          // A record created with a separation date starts closed: the person
          // is no longer employed, so the login (if any) must not start open.
          isActive:
            separationDateAD && req.body?.isActive !== true
              ? false
              : typeof req.body?.isActive === 'boolean'
                ? req.body.isActive
                : true,
          createdBy: actorOf(req),
        })
      )
    ).rows[0];
    await logAuditEvent(
      req,
      'CREATE_EMPLOYEE',
      'ACCOUNTING',
      `Created employee ${created.employeeCode} ${created.name} at ${branchId}`,
      branchId,
      client
    );
    if (req.body?.createLogin === true) {
      employeeLogin = await createEmployeeLogin(
        client,
        req,
        created,
        String(req.body?.loginRole || 'FRONT_DESK')
      );
    }
    return created;
  }).catch((err) => {
    if (isUniqueViolation(err)) throw new ApiError(409, `Employee code ${employeeCode} already exists.`);
    throw err;
  });
  return res.status(201).json({ ...employee, login: employeeLogin });
}

/** Mirrors the client's PROFILE_PHOTO_MAX_BYTES; the self-service route enforces the same limit. */
const EMPLOYEE_PHOTO_MAX_BYTES = 150 * 1024;
const EMPLOYEE_PHOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** PATCH /api/employees/:id */
export async function patch_employee(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An employee id is required.');

  const employee = await withTransaction(async (client) => {
    const existing = (await client.query(EMPLOYEE_BY_ID_SQL, [id])).rows[0];
    if (!existing) throw new ApiError(404, 'Employee not found.');
    if (!assertInScope(scope, String(existing.branchId), res)) return null;

    const has = (key: string) => Object.prototype.hasOwnProperty.call(req.body || {}, key);
    // Photo first: this statement is what can set NULL, and the COALESCE update
    // below then returns the stored row with the new picture already in it.
    if (has('profilePhoto')) {
      const raw = req.body.profilePhoto;
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== 'string' || !EMPLOYEE_PHOTO_DATA_URL.test(raw)) {
          throw new ApiError(400, 'The profile photo must be a JPEG, PNG or WebP data URL.');
        }
        const base64 = raw.slice(raw.indexOf(',') + 1);
        const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
        const bytes = Math.floor((base64.length * 3) / 4) - padding;
        if (bytes > EMPLOYEE_PHOTO_MAX_BYTES) {
          throw new ApiError(413, 'The profile photo is larger than 150 KB after resizing.');
        }
      }
      await client.query(EMPLOYEE_PROFILE_PHOTO_SQL, [id, raw ?? null]);
    }

    const nextJoiningDateAD = has('joiningDateAD')
      ? optionalDate(req.body.joiningDateAD, 'Joining date')
      : existing.joiningDateAD;
    const nextSeparationDateAD = has('separationDateAD')
      ? optionalDate(req.body.separationDateAD, 'Separation date')
      : existing.separationDateAD;
    if (nextJoiningDateAD && nextSeparationDateAD && nextSeparationDateAD < nextJoiningDateAD) {
      throw new ApiError(400, 'Separation date must be on or after the joining date.');
    }
    // A separation date closes the employment relationship, so the record is
    // deactivated in the same update — which also suspends the linked login
    // below. An explicit isActive:true in the same request wins, so a date
    // entered by mistake can be corrected without a second call; clearing the
    // date never re-opens access on its own.
    const separated = has('separationDateAD') && Boolean(nextSeparationDateAD);
    const requestedActive = typeof req.body?.isActive === 'boolean' ? req.body.isActive : null;
    const nextActive = separated && requestedActive !== true ? false : requestedActive;
    let updated = (
      await client.query(EMPLOYEE_UPDATE_SQL, [
        id,
        has('name') ? text(req.body.name, 200) || null : null,
        has('department') ? optionalText(req.body.department, 120) : null,
        has('designation') ? optionalText(req.body.designation, 120) : null,
        has('panNumber') ? optionalText(req.body.panNumber, 50) : null,
        has('ssfNumber') ? optionalText(req.body.ssfNumber, 50) : null,
        has('bankAccount') ? optionalText(req.body.bankAccount, 80) : null,
        nextActive,
        has('bankName') ? optionalText(req.body.bankName, 150) : null,
        has('employmentType') ? optionalText(req.body.employmentType, 30) : null,
        has('joiningDateAD') ? optionalDate(req.body.joiningDateAD, 'Joining date') : null,
        has('dateOfBirthAD') ? optionalDate(req.body.dateOfBirthAD, 'Date of birth') : null,
        has('contractExpiryAD') ? optionalDate(req.body.contractExpiryAD, 'Contract expiry') : null,
        has('designationCode') ? optionalText(req.body.designationCode, 30) : null,
        has('workStation') ? optionalText(req.body.workStation, 150) : null,
        has('address') ? optionalText(req.body.address, 500) : null,
        has('personalContact') ? optionalText(req.body.personalContact, 30) : null,
        has('emergencyContactPerson') ? optionalText(req.body.emergencyContactPerson, 150) : null,
        has('emergencyContactNumber') ? optionalText(req.body.emergencyContactNumber, 30) : null,
        has('internalEmail') ? optionalText(req.body.internalEmail, 150) : null,
        has('personalEmail') ? optionalText(req.body.personalEmail, 150) : null,
        has('monthlySalary') ? optionalAmount(req.body.monthlySalary, 'Monthly salary') : null,
        has('ssfEligible') ? optionalBoolean(req.body.ssfEligible) : null,
        actorOf(req),
        has('separationDateAD'),
        nextSeparationDateAD,
      ])
    ).rows[0];
    if (has('userId')) {
      const userId = optionalText(req.body.userId, 50);
      if (userId) await assertEmployeeUserLinkable(client, userId, id);
      updated = (await client.query(EMPLOYEE_SET_USER_SQL, [id, userId, actorOf(req)])).rows[0];
      await logAuditEvent(
        req,
        userId ? 'LINK_EMPLOYEE_USER' : 'UNLINK_EMPLOYEE_USER',
        'ACCOUNTING',
        `${userId ? 'Linked' : 'Unlinked'} employee ${updated.employeeCode} ${updated.name}${userId ? ` to user ${userId}` : ''}`,
        String(updated.branchId),
        client
      );
    }
    await logAuditEvent(
      req,
      'UPDATE_EMPLOYEE',
      'ACCOUNTING',
      `Updated employee ${updated.employeeCode} ${updated.name} (${updated.isActive ? 'active' : 'inactive'})`,
      String(updated.branchId),
      client
    );
    await syncEmployeeLoginStatus(client, req, updated, existing.isActive);
    const login =
      req.body?.createLogin === true
        ? await createEmployeeLogin(
            client,
            req,
            { ...updated, internalEmail: updated.internalEmail ?? req.body?.internalEmail },
            String(req.body?.loginRole || 'FRONT_DESK')
          )
        : null;
    return { row: updated, login };
  });
  if (!employee) return; // assertInScope already wrote the 403
  return res.json({ ...employee.row, login: employee.login });
}

/** GET /api/employees/:id/ledger?branchId=&from=&to= */
export async function get_employeeLedger(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An employee id is required.');

  const employee = (await pgPool.query(EMPLOYEE_BY_ID_SQL, [id])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  if (!assertInScope(scope, String(employee.branchId), res)) return;

  const rawBranch = text(req.query?.branchId, 50);
  const branchId = rawBranch && rawBranch !== 'ALL' ? rawBranch : String(employee.branchId);
  if (!assertInScope(scope, branchId, res)) return;
  const from = optionalDate(req.query?.from, 'from');
  const to = optionalDate(req.query?.to, 'to');
  if (from && to && from > to) throw new ApiError(400, 'from must not be after to.');

  const [entries, accountRows] = await Promise.all([
    pgPool.query(EMPLOYEE_LEDGER_ENTRIES_SQL, [id, branchId, from, to]),
    pgPool.query(EMPLOYEE_LEDGER_ACCOUNT_BALANCES_SQL, [id, branchId, from, to]),
  ]);
  const lines = entries.rows.map((row: any) => ({
    ...row,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }));
  const accounts = accountRows.rows.map((row: any) => {
    const balance = roundMoney(Number(row.balance));
    return {
      ...row,
      debit: Number(row.debit),
      credit: Number(row.credit),
      balance,
      // The employee ledger can present a liability in its natural direction
      // without re-deriving the account type client-side.
      presentedBalance:
        row.accountType === 'ASSET' || row.accountType === 'EXPENSE'
          ? balance
          : roundMoney(-balance),
    };
  });
  return res.json({
    employee: presentEmployee(req, employee),
    branchId,
    from,
    to,
    accounts,
    entries: lines,
    totals: {
      debit: roundMoney(lines.reduce((sum: number, line: any) => sum + line.debit, 0)),
      credit: roundMoney(lines.reduce((sum: number, line: any) => sum + line.credit, 0)),
    },
  });
}

/**
 * GET /api/payroll-runs/postings?branchId=&from=&to=&query= — the Finance
 * payroll-postings register. It is deliberately stricter than a run read:
 * `gl-view` only, POSTED/PAID runs only, and no employee PII or write path.
 */
export async function get_payrollPostings(req: any, res: Response): Promise<any> {
  requireDb();
  if (!holdsPermission(req, 'gl-view')) {
    throw new ApiError(403, 'The payroll-postings register requires the ledger-view permission.');
  }
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.json([]);

  const rawBranch = text(req.query?.branchId, 50);
  const options =
    rawBranch && rawBranch !== 'ALL'
      ? { branchId: rawBranch }
      : scope.allowed
        ? { branchScope: [...scope.allowed] }
        : {};
  const from = text(req.query?.from, 10);
  const to = text(req.query?.to, 10);
  if (from && !isAccountingDate(from)) {
    throw new ApiError(400, 'from must be a real date in YYYY-MM-DD form.');
  }
  if (to && !isAccountingDate(to)) {
    throw new ApiError(400, 'to must be a real date in YYYY-MM-DD form.');
  }
  if (from && to && from > to) {
    throw new ApiError(400, 'from cannot be later than to.');
  }

  const { sql, params } = buildPayrollPostingsQuery({
    ...options,
    from: from || null,
    to: to || null,
    query: text(req.query?.query, 80) || null,
  });
  return res.json((await pgPool.query(sql, params)).rows);
}

/** GET /api/payroll-runs?branchId=&periodKey=&status= */
export async function get_payrollRuns(req: any, res: Response): Promise<any> {
  requireDb();
  requirePayrollRead(req);
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.json([]);
  const rawBranch = text(req.query?.branchId, 50);
  const options =
    rawBranch && rawBranch !== 'ALL'
      ? { branchId: rawBranch }
      : scope.allowed
        ? { branchScope: [...scope.allowed] }
        : {};
  const { sql, params } = buildPayrollRunListQuery({
    ...options,
    periodKey: text(req.query?.periodKey, 7) || null,
    status: text(req.query?.status, 10) || null,
  });
  return res.json((await pgPool.query(sql, params)).rows);
}

/** GET /api/payroll-runs/:id */
export async function get_payrollRun(req: any, res: Response): Promise<any> {
  requireDb();
  requirePayrollRead(req);
  const scope = resolveScope(req, res);
  if (!scope) return;
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A payroll run id is required.');
  const run = (await pgPool.query(PAYROLL_RUN_BY_ID_SQL, [id])).rows[0];
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  if (!assertInScope(scope, String(run.branchId), res)) return;
  const lines = (await pgPool.query(PAYROLL_LINES_BY_RUN_SQL, [id])).rows;
  return res.json({ ...run, lines });
}

interface LoadedPayrollOutput {
  run: any;
  lines: any[];
  output: PayrollOutput;
  journal: PayrollJournalSummary | null;
  paymentJournal: PayrollJournalSummary | null;
}

async function payrollJournalSummary(
  journalId: string | null | undefined
): Promise<PayrollJournalSummary | null> {
  if (!journalId) return null;
  const row = (await pgPool.query(JOURNAL_BY_ID_SQL, [journalId])).rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    journalNo: String(row.journalNo),
    status: String(row.status),
    journalDateAD: row.journalDateAD ? String(row.journalDateAD).slice(0, 10) : null,
    totalDebit: roundMoney(Number(row.totalDebit)),
    totalCredit: roundMoney(Number(row.totalCredit)),
  };
}

/**
 * One posted-run read for payslips, the register and the printable PDF. It
 * repeats the run read gate and branch check, then derives every figure from
 * the stored line snapshots. Drafts and approved runs stop here with a clear
 * 409 before any employee record is read.
 */
export async function loadPayrollOutput(
  req: any,
  res: Response
): Promise<LoadedPayrollOutput | null> {
  requireDb();
  // Payslips and the transfer register contain employee and bank data; never
  // let a browser or shared proxy cache them across sessions.
  res.set('Cache-Control', 'private, no-store');
  requirePayrollRead(req);
  const scope = resolveScope(req, res);
  if (!scope) return null;
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A payroll run id is required.');
  const runRow = (await pgPool.query(PAYROLL_RUN_BY_ID_SQL, [id])).rows[0];
  if (!runRow) throw new ApiError(404, 'Payroll run not found.');
  if (!assertInScope(scope, String(runRow.branchId), res)) return null;
  if (!isPayrollOutputReady(runRow.status)) {
    throw new ApiError(
      409,
      `Payroll run ${runRow.runNo} is ${runRow.status}; payslips and the register are available only after posting.`
    );
  }

  const lines = (await pgPool.query(PAYROLL_LINES_FOR_OUTPUT_SQL, [id])).rows;
  const employeeIds = [...new Set(lines.map((line: any) => String(line.employeeId)))];
  const employees = employeeIds.length
    ? (await pgPool.query(EMPLOYEES_BY_IDS_SQL, [employeeIds])).rows
    : [];
  const branch = (await pgPool.query(BRANCH_NAME_BY_ID_SQL, [runRow.branchId])).rows[0];
  const fiscalYear = (
    await pgPool.query(HR_STATUTORY_FISCAL_YEAR_FOR_DATE_SQL, [runRow.runDateAD])
  ).rows[0];
  const run = {
    ...runRow,
    branchName: branch?.name || runRow.branchId,
    fiscalYearCode: fiscalYear?.code || null,
  };
  return {
    run,
    lines,
    output: buildPayrollOutput(run, lines, employees, seesFullEmployeePii(req)),
    journal: await payrollJournalSummary(run.journalId),
    paymentJournal: await payrollJournalSummary(run.paidJournalId),
  };
}

function payrollOutputMeta(loaded: LoadedPayrollOutput) {
  return {
    ...loaded.run,
    totals: loaded.output.totals,
    statutory: loaded.output.statutory,
    journal: loaded.journal,
    paymentJournal: loaded.paymentJournal,
    reconciliation: buildPayrollReconciliation(
      loaded.run,
      loaded.output,
      loaded.journal,
      loaded.paymentJournal
    ),
    generatedAt: new Date().toISOString(),
  };
}

/** GET /api/payroll-runs/:id/payslips — posted-only JSON payslips. */
export async function get_payrollRunPayslips(req: any, res: Response): Promise<any> {
  const loaded = await loadPayrollOutput(req, res);
  if (!loaded) return;
  return res.json({ ...payrollOutputMeta(loaded), payslips: loaded.output.payslips });
}

/** GET /api/payroll-runs/:id/payslips/:employeeId — one employee payslip. */
export async function get_payrollRunPayslip(req: any, res: Response): Promise<any> {
  const loaded = await loadPayrollOutput(req, res);
  if (!loaded) return;
  const employeeId = text(req.params?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee id or code is required.');
  const payslip = loaded.output.payslips.find(
    (row) => row.employeeId === employeeId || row.employeeCode === employeeId
  );
  if (!payslip) throw new ApiError(404, 'This employee is not part of the payroll run.');
  return res.json({ ...payrollOutputMeta(loaded), payslip });
}

/** GET /api/payroll-runs/:id/register — posted-only transfer register. */
export async function get_payrollRunRegister(req: any, res: Response): Promise<any> {
  const loaded = await loadPayrollOutput(req, res);
  if (!loaded) return;
  return res.json({ ...payrollOutputMeta(loaded), rows: loaded.output.registerRows });
}

/**
 * GET /api/payroll-runs/:id/bank-file — manage-only CSV for a bank transfer.
 * This is the one output that necessarily contains every beneficiary account,
 * so it refuses a masked projection outright. The shared posted-only loader
 * still supplies the run, branch and snapshot checks; no ledger row is written.
 */
export async function get_payrollRunBankFile(req: any, res: Response): Promise<any> {
  if (!seesFullEmployeePii(req)) {
    throw new ApiError(
      403,
      'The bank file requires employee-manage or payroll-manage permission.'
    );
  }
  const loaded = await loadPayrollOutput(req, res);
  if (!loaded) return;
  if (!loaded.output.registerRows.length) {
    throw new ApiError(409, `Payroll run ${loaded.run.runNo} has no employees to pay.`);
  }
  const file = buildPayrollBankFile(loaded.run, loaded.output);
  if (file.missingBankCodes.length) {
    throw new ApiError(
      409,
      `Cannot build a bank file for ${loaded.run.runNo}; missing bank name or account for: ${file.missingBankCodes.join(', ')}.`
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(file.csv);
}

/**
 * POST /api/payroll-runs
 * Body: { branchId, periodKey, runDateAD?, lines: [{ employeeId, gross, tds, ssf, advance, loan }] }
 */
export async function post_payrollRun(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  const branchId = text(req.body?.branchId, 50);
  if (!branchId || branchId === 'ALL') throw new ApiError(400, 'Name the branch whose payroll should post.');
  if (!assertInScope(scope, branchId, res)) return;

  const { periodKey, endDateAD } = periodBounds(req.body?.periodKey);
  const runDateAD = optionalDate(req.body?.runDateAD, 'runDateAD') || endDateAD;
  if (periodKeyForDate(runDateAD) !== periodKey) {
    throw new ApiError(400, `runDateAD must fall inside ${periodKey}.`);
  }
  const runDateBS = await bsDateOrThrow(runDateAD);

  const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (rawLines.length === 0) throw new ApiError(400, 'A payroll run needs at least one employee line.');
  if (rawLines.length > PAYROLL_EMPLOYEES_PER_RUN_MAX) {
    throw new ApiError(
      400,
      `A payroll run holds at most ${PAYROLL_EMPLOYEES_PER_RUN_MAX} employees. Split larger payrolls by branch or period.`
    );
  }
  const employeeIds = rawLines.map((line: any) => text(line?.employeeId, 50));
  if (employeeIds.some((id: string) => !id)) throw new ApiError(400, 'Every payroll line needs an employeeId.');
  if (new Set(employeeIds).size !== employeeIds.length) {
    throw new ApiError(400, 'A payroll run cannot list the same employee twice.');
  }

  const employees = (await pgPool.query(EMPLOYEES_BY_IDS_SQL, [employeeIds])).rows;
  const byId = new Map<string, any>(employees.map((employee: any) => [String(employee.id), employee]));
  const missing = employeeIds.filter((id: string) => !byId.has(id));
  if (missing.length > 0) throw new ApiError(400, `Employee not found: ${missing.join(', ')}.`);

  const lines: (PayrollPostingLine & {
    bankName: string | null;
    bankAccount: string | null;
  })[] = [];
  for (const raw of rawLines) {
    const employee = byId.get(text(raw?.employeeId, 50))!;
    if (!employee.isActive) {
      throw new ApiError(400, `Employee ${employee.employeeCode} is inactive and cannot be paid.`);
    }
    if (String(employee.branchId) !== branchId) {
      throw new ApiError(
        400,
        `Employee ${employee.employeeCode} belongs to branch ${employee.branchId}, not ${branchId}.`
      );
    }
    const gross = nonNegativeAmount(raw?.gross, `Gross for ${employee.employeeCode}`);
    if (gross <= 0) throw new ApiError(400, `Gross for ${employee.employeeCode} must be positive.`);
    const tds = nonNegativeAmount(raw?.tds, `TDS for ${employee.employeeCode}`);
    const ssf = nonNegativeAmount(raw?.ssf, `SSF for ${employee.employeeCode}`);
    const advance = nonNegativeAmount(raw?.advance, `Advance for ${employee.employeeCode}`);
    const loan = nonNegativeAmount(raw?.loan, `Loan for ${employee.employeeCode}`);
    const deductions = roundMoney(tds + ssf + advance + loan);
    if (deductions > gross + 0.005) {
      throw new ApiError(
        400,
        `Deductions for ${employee.employeeCode} (${deductions.toFixed(2)}) exceed gross (${gross.toFixed(2)}).`
      );
    }
    lines.push({
      employeeId: String(employee.id),
      employeeCode: String(employee.employeeCode),
      employeeName: String(employee.name),
      bankName: employee.bankName?.trim() || null,
      bankAccount: employee.bankAccount?.trim() || null,
      gross,
      tds,
      ssf,
      advance,
      loan,
      net: roundMoney(gross - deductions),
    });
  }

  const totals = {
    gross: roundMoney(lines.reduce((sum, line) => sum + Number(line.gross), 0)),
    tds: roundMoney(lines.reduce((sum, line) => sum + Number(line.tds), 0)),
    ssf: roundMoney(lines.reduce((sum, line) => sum + Number(line.ssf), 0)),
    advance: roundMoney(lines.reduce((sum, line) => sum + Number(line.advance), 0)),
    loan: roundMoney(lines.reduce((sum, line) => sum + Number(line.loan), 0)),
    net: roundMoney(lines.reduce((sum, line) => sum + Number(line.net), 0)),
  };
  if (totals.gross <= 0) throw new ApiError(400, 'The payroll run has no gross wage to post.');

  const created = await withTransaction(async (client) => {
    // The duplicate checks and the insert are serialized per branch+month, so
    // two concurrent submissions cannot both pass the "not posted yet" test.
    await client.query(PAYROLL_RUN_LOCK_SQL, [`payroll:${branchId}:${periodKey}`]);

    const existing = (
      await client.query(PAYROLL_RUN_BY_BRANCH_PERIOD_SQL, [branchId, periodKey])
    ).rows[0];
    if (existing) {
      throw new ApiError(
        409,
        `Payroll for ${periodKey} is already posted for ${branchId} (run ${existing.runNo}). Posting again would pay the month twice.`
      );
    }
    const conflicts = (
      await client.query(PAYROLL_EMPLOYEE_PERIOD_CONFLICTS_SQL, [periodKey, employeeIds])
    ).rows;
    if (conflicts.length > 0) {
      const who = conflicts
        .map((row: any) => `${row.employeeCode} (run ${row.runNo})`)
        .join(', ');
      throw new ApiError(
        409,
        `Payroll for ${periodKey} is already posted for ${who}. Posting again would pay the same employee twice.`
      );
    }

    const runNo = await issueNextDocNumber(branchId, 'PAYROLL_RUN', runDateAD, client);
    const runId = `payrun-${crypto.randomUUID()}`;
    await client.query(
      PAYROLL_RUN_INSERT_SQL,
      payrollRunInsertParams({
        id: runId,
        runNo,
        branchId,
        periodKey,
        runDateAD,
        runDateBS,
        grossTotal: totals.gross,
        tdsTotal: totals.tds,
        ssfTotal: totals.ssf,
        advanceTotal: totals.advance,
        loanTotal: totals.loan,
        netTotal: totals.net,
        postedBy: actorOf(req),
      })
    );
    for (const line of lines) {
      await client.query(
        PAYROLL_LINE_INSERT_SQL,
        payrollLineInsertParams({
          id: `payline-${crypto.randomUUID()}`,
          runId,
          employeeId: line.employeeId,
          employeeCode: line.employeeCode,
          employeeName: line.employeeName,
          periodKey,
          gross: Number(line.gross),
          tds: Number(line.tds),
          ssf: Number(line.ssf),
          advance: Number(line.advance),
          loan: Number(line.loan),
          net: Number(line.net),
          bankName: line.bankName,
          bankAccount: line.bankAccount,
        })
      );
    }

    const journal = await postPayrollRunJournal(client, {
      runId,
      runNo,
      branchId,
      periodKey,
      dateAD: runDateAD,
      lines,
      actor: actorOf(req),
    });
    await client.query(PAYROLL_RUN_SET_JOURNAL_SQL, [runId, journal.id]);
    const run = (await client.query(PAYROLL_RUN_BY_ID_SQL, [runId])).rows[0];
    await logAuditEvent(
      req,
      'POST_PAYROLL_RUN',
      'ACCOUNTING',
      `Posted payroll run ${runNo} for ${periodKey} at ${branchId}: gross NPR ${totals.gross.toFixed(2)}, net NPR ${totals.net.toFixed(2)} (journal ${journal.journalNo}).`,
      branchId,
      client
    );
    return { run, journal, lines: (await client.query(PAYROLL_LINES_BY_RUN_SQL, [runId])).rows };
  }).catch((err) => {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, `Payroll for ${periodKey} is already posted for ${branchId}.`);
    }
    throw err;
  });

  return res.status(201).json({
    ...created.run,
    journal: created.journal,
    journalNo: created.journal.journalNo,
    lines: created.lines,
  });
}

/**
 * POST /api/payroll-runs/draft
 *
 * Generates one DRAFT for a branch+month from the facts already maintained by
 * HR: active employees, their effective-dated structure, payroll-input days/
 * overtime, and the fiscal year's TDS/SSF configuration. Nothing is posted to
 * the ledger yet, so abandoning the draft leaves the books untouched.
 */
export async function post_payrollRunDraft(req: any, res: Response): Promise<any> {
  requireDb();
  requirePrepare(req);
  const scope = resolveScope(req, res);
  if (!scope) return;
  const branchId = text(req.body?.branchId, 50);
  if (!branchId || branchId === 'ALL') {
    throw new ApiError(400, 'Name the branch whose payroll should be prepared.');
  }
  if (!assertInScope(scope, branchId, res)) return;

  const { periodKey, endDateAD: runDateAD } = periodBounds(req.body?.periodKey);
  const runDateBS = await bsDateOrThrow(runDateAD);
  const runNo = `DRAFT-${crypto.randomUUID()}`;

  const created = await withTransaction(async (client) => {
    await client.query(PAYROLL_RUN_LOCK_SQL, [`payroll:${branchId}:${periodKey}`]);
    if (!(await client.query(BRANCH_EXISTS_SQL, [branchId])).rows[0]) {
      throw new ApiError(400, `Branch ${branchId} does not exist.`);
    }
    const existing = (
      await client.query(PAYROLL_RUN_BY_BRANCH_PERIOD_SQL, [branchId, periodKey])
    ).rows[0];
    if (existing) {
      throw new ApiError(
        409,
        `Payroll for ${periodKey} already exists for ${branchId} (run ${existing.runNo}, status ${existing.status}). Discard a draft or open the existing run instead.`
      );
    }

    const fiscalYear = (
      await client.query(HR_STATUTORY_FISCAL_YEAR_FOR_DATE_SQL, [runDateAD])
    ).rows[0];
    if (!fiscalYear) throw new ApiError(422, `No fiscal year covers ${runDateAD}.`);
    const config = (
      await client.query(HR_STATUTORY_CONFIG_BY_YEAR_SQL, [fiscalYear.id])
    ).rows[0];
    if (!config) {
      throw new ApiError(
        422,
        `No statutory configuration exists for fiscal year ${fiscalYear.code}. Configure TDS/SSF before generating payroll.`
      );
    }
    const slabs = (
      await client.query(HR_STATUTORY_SLABS_BY_CONFIG_IDS_SQL, [[String(config.id)]])
    ).rows;

    const inputRows = (
      await client.query(HR_PAYROLL_INPUT_LIST_SQL, [
        `${periodKey}-01`,
        runDateAD,
        branchId,
        null,
        null,
        periodKey,
      ])
    ).rows;
    const inputEmployeeIds = inputRows.map((row: any) => String(row.employeeId));
    const employeeBankRows = inputEmployeeIds.length
      ? (await client.query(EMPLOYEES_BY_IDS_SQL, [inputEmployeeIds])).rows
      : [];
    const bankByEmployee = new Map<string, any>(
      employeeBankRows.map((employee: any) => [String(employee.id), employee])
    );
    const adjustmentRows = (
      await client.query(HR_PAYROLL_ADJUSTMENTS_BY_BRANCH_PERIOD_SQL, [periodKey, branchId])
    ).rows;
    const adjustments = new Map<string, any>(
      adjustmentRows.map((row: any) => [String(row.employeeId), row])
    );
    const inputs = inputRows.map((row: any) => {
      const adjustment = adjustments.get(String(row.employeeId));
      const bank = bankByEmployee.get(String(row.employeeId));
      return {
        ...row,
        bankName: bank?.bankName ?? null,
        bankAccount: bank?.bankAccount ?? null,
        incentiveAmount: adjustment?.incentiveAmount ?? 0,
        arrearsAmount: adjustment?.arrearsAmount ?? 0,
        advanceAmount: adjustment?.advanceAmount ?? 0,
        loanAmount: adjustment?.loanAmount ?? 0,
      };
    });
    const salaryRows = (
      await client.query(HR_SALARY_EFFECTIVE_LIST_SQL, [branchId, null, null, runDateAD])
    ).rows;
    const salaryIds = salaryRows.map((row: any) => String(row.id));
    const componentRows = salaryIds.length
      ? (await client.query(HR_SALARY_COMPONENTS_BY_SALARY_IDS_SQL, [salaryIds])).rows
      : [];
    const componentsBySalary = new Map<string, any[]>();
    for (const component of componentRows) {
      const list = componentsBySalary.get(String(component.salaryId)) || [];
      list.push(component);
      componentsBySalary.set(String(component.salaryId), list);
    }
    const structures = new Map<string, PayrollDraftStructure>();
    for (const salary of salaryRows) {
      structures.set(String(salary.employeeId), {
        id: String(salary.id),
        employeeId: String(salary.employeeId),
        ssfEligible: Boolean(salary.ssfEligible),
        overtimeRate: Number(salary.overtimeRate ?? 0),
        components: componentsBySalary.get(String(salary.id)) || [],
      });
    }

    const draft = buildPayrollDraft({
      periodKey,
      inputs,
      structures,
      config: {
        id: String(config.id),
        fiscalYearCode: String(fiscalYear.code),
        employeeSsfPercent: config.employeeSsfPercent,
        employerSsfPercent: config.employerSsfPercent,
        slabs: slabs.map((slab: any) => ({
          lowerBound: Number(slab.lowerBound),
          upperBound: slab.upperBound === null ? null : Number(slab.upperBound),
          ratePercent: Number(slab.ratePercent),
        })),
      },
      maxEmployees: PAYROLL_EMPLOYEES_PER_RUN_MAX,
    });

    const runId = `payrun-${crypto.randomUUID()}`;
    await client.query(
      PAYROLL_RUN_DRAFT_INSERT_SQL,
      payrollDraftInsertParams({
        id: runId,
        runNo,
        branchId,
        periodKey,
        runDateAD,
        runDateBS,
        grossTotal: draft.totals.gross,
        tdsTotal: draft.totals.tds,
        ssfTotal: draft.totals.ssf,
        advanceTotal: draft.totals.advance,
        loanTotal: draft.totals.loan,
        incentiveTotal: draft.totals.incentive,
        arrearsTotal: draft.totals.arrears,
        netTotal: draft.totals.net,
        preparedBy: actorOf(req),
        statutoryConfigId: draft.statutoryConfigId,
      })
    );
    for (const line of draft.lines) {
      await client.query(
        PAYROLL_LINE_INSERT_SQL,
        payrollLineInsertParams({
          id: `payline-${crypto.randomUUID()}`,
          runId,
          employeeId: line.employeeId,
          employeeCode: line.employeeCode,
          employeeName: line.employeeName,
          bankName: line.bankName,
          bankAccount: line.bankAccount,
          periodKey,
          salaryId: line.salaryId,
          basicAmount: line.basicAmount,
          payableDays: line.payableDays,
          lopDays: line.lopDays,
          lopDeduction: line.lopDeduction,
          overtimeHours: line.overtimeHours,
          overtimeAmount: line.overtimeAmount,
          incentive: line.incentive,
          arrears: line.arrears,
          gross: line.gross,
          tds: line.tds,
          ssf: line.ssf,
          employerSsf: line.employerSsf,
          employeeSsfPercent: line.employeeSsfPercent,
          employerSsfPercent: line.employerSsfPercent,
          advance: line.advance,
          loan: line.loan,
          net: line.net,
        })
      );
    }

    const run = (await client.query(PAYROLL_RUN_BY_ID_SQL, [runId])).rows[0];
    const lines = (await client.query(PAYROLL_LINES_BY_RUN_SQL, [runId])).rows;
    await logAuditEvent(
      req,
      'CREATE_PAYROLL_RUN_DRAFT',
      'ACCOUNTING',
      `Prepared payroll draft ${runNo} for ${periodKey} at ${branchId}: ${draft.lines.length} employees, gross NPR ${draft.totals.gross.toFixed(2)}, net NPR ${draft.totals.net.toFixed(2)}, FY ${draft.fiscalYearCode}.`,
      branchId,
      client
    );
    return { run, lines, fiscalYearCode: draft.fiscalYearCode };
  }).catch((err) => {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, `Payroll for ${periodKey} already exists for ${branchId}.`);
    }
    throw err;
  });

  return res.status(201).json({
    ...created.run,
    fiscalYearCode: created.fiscalYearCode,
    lines: created.lines,
  });
}

/** POST /api/payroll-runs/:id/approve — HR prepares, Finance approves. */
export async function post_payrollRunApprove(req: any, res: Response): Promise<any> {
  requireDb();
  requirePost(req);
  const scope = resolveScope(req, res);
  if (!scope) return;
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A payroll run id is required.');

  const approved = await withTransaction(async (client) => {
    const run = (await client.query(PAYROLL_RUN_LOCK_ROW_SQL, [id])).rows[0];
    if (!run) throw new ApiError(404, 'Payroll run not found.');
    if (!assertInScope(scope, String(run.branchId), res)) return null;
    if (String(run.status) !== 'DRAFT') {
      throw new ApiError(
        409,
        `Payroll run ${run.runNo} is ${run.status}; only a DRAFT can be approved.`
      );
    }
    const updated = (
      await client.query(PAYROLL_RUN_SET_APPROVED_SQL, [id, actorOf(req)])
    ).rows[0];
    const lines = (await client.query(PAYROLL_LINES_BY_RUN_SQL, [id])).rows;
    await logAuditEvent(
      req,
      'APPROVE_PAYROLL_RUN',
      'ACCOUNTING',
      `Approved payroll run ${run.runNo} for ${run.periodKey} at ${run.branchId}: gross NPR ${Number(run.grossTotal).toFixed(2)}, net NPR ${Number(run.netTotal).toFixed(2)}.`,
      String(run.branchId),
      client
    );
    return { ...updated, lines };
  });
  if (!approved) return;
  return res.json(approved);
}

/** POST /api/payroll-runs/:id/post — post an approved draft to the ledger. */
export async function post_payrollRunPost(req: any, res: Response): Promise<any> {
  requireDb();
  requirePost(req);
  const scope = resolveScope(req, res);
  if (!scope) return;
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A payroll run id is required.');

  const posted = await withTransaction(async (client) => {
    const run = (await client.query(PAYROLL_RUN_LOCK_ROW_SQL, [id])).rows[0];
    if (!run) throw new ApiError(404, 'Payroll run not found.');
    if (!assertInScope(scope, String(run.branchId), res)) return null;
    if (String(run.status) === 'DRAFT') {
      throw new ApiError(409, `Payroll run ${run.runNo} must be approved before it can be posted.`);
    }
    if (String(run.status) !== 'APPROVED') {
      throw new ApiError(
        409,
        `Payroll run ${run.runNo} is ${run.status}; only an APPROVED run can be posted.`
      );
    }

    const lines = (await client.query(PAYROLL_LINES_BY_RUN_SQL, [id])).rows;
    const runNo = await issueNextDocNumber(
      String(run.branchId),
      'PAYROLL_RUN',
      String(run.runDateAD),
      client
    );
    const journal = await postPayrollRunJournal(client, {
      runId: id,
      runNo,
      branchId: String(run.branchId),
      periodKey: String(run.periodKey),
      dateAD: String(run.runDateAD),
      lines,
      actor: actorOf(req),
    });
    const updated = (
      await client.query(PAYROLL_RUN_SET_POSTED_SQL, [id, runNo, journal.id, actorOf(req)])
    ).rows[0];
    await logAuditEvent(
      req,
      'POST_PAYROLL_RUN',
      'ACCOUNTING',
      `Posted generated payroll run ${runNo} for ${run.periodKey} at ${run.branchId}: gross NPR ${Number(run.grossTotal).toFixed(2)}, net NPR ${Number(run.netTotal).toFixed(2)} (journal ${journal.journalNo}).`,
      String(run.branchId),
      client
    );
    return { ...updated, journal, journalNo: journal.journalNo, lines };
  });
  if (!posted) return;
  return res.json(posted);
}

/** DELETE /api/payroll-runs/:id — discard an unapproved DRAFT only. */
export async function delete_payrollRunDraft(req: any, res: Response): Promise<any> {
  requireDb();
  requirePrepare(req);
  const scope = resolveScope(req, res);
  if (!scope) return;
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A payroll run id is required.');

  const deleted = await withTransaction(async (client) => {
    const run = (await client.query(PAYROLL_RUN_LOCK_ROW_SQL, [id])).rows[0];
    if (!run) throw new ApiError(404, 'Payroll run not found.');
    if (!assertInScope(scope, String(run.branchId), res)) return false;
    if (String(run.status) !== 'DRAFT') {
      throw new ApiError(
        409,
        `Payroll run ${run.runNo} is ${run.status}; only a DRAFT can be discarded.`
      );
    }
    await client.query(PAYROLL_RUN_DELETE_DRAFT_SQL, [id]);
    await logAuditEvent(
      req,
      'DISCARD_PAYROLL_RUN_DRAFT',
      'ACCOUNTING',
      `Discarded payroll draft ${run.runNo} for ${run.periodKey} at ${run.branchId}.`,
      String(run.branchId),
      client
    );
    return true;
  });
  if (!deleted) return;
  return res.status(204).send();
}

/** POST /api/payroll-runs/:id/pay — clear salary payable for every net line. */
export async function post_payrollPayment(req: any, res: Response): Promise<any> {
  requireDb();
  requirePost(req);
  const scope = resolveScope(req, res);
  if (!scope) return;
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A payroll run id is required.');
  const paymentMethod = text(req.body?.paymentMethod, 30).toUpperCase() || 'CASH';
  const requestedDate = optionalDate(req.body?.dateAD, 'dateAD');

  const paid = await withTransaction(async (client) => {
    const run = (await client.query(PAYROLL_RUN_LOCK_ROW_SQL, [id])).rows[0];
    if (!run) throw new ApiError(404, 'Payroll run not found.');
    if (!assertInScope(scope, String(run.branchId), res)) return null;
    if (String(run.status) === 'PAID') {
      throw new ApiError(409, `Payroll run ${run.runNo} is already paid (journal ${run.paidJournalId}).`);
    }
    if (String(run.status) !== 'POSTED') {
      throw new ApiError(
        409,
        `Payroll run ${run.runNo} is ${run.status}; only a POSTED run can be paid.`
      );
    }
    const existingPayment = (
      await client.query(JOURNAL_FIND_BY_SOURCE_SQL, ['PAYROLL_PAYMENT', id])
    ).rows[0];
    if (existingPayment) {
      throw new ApiError(409, `Payroll run ${run.runNo} already has a payment journal (${existingPayment.journalNo}).`);
    }
    const dateAD = requestedDate || String(run.runDateAD);
    if (!isAccountingDate(dateAD)) {
      throw new ApiError(400, 'Payment date must be a real date in YYYY-MM-DD form.');
    }
    if (dateAD < String(run.runDateAD)) {
      throw new ApiError(400, `Payment date ${dateAD} cannot precede the run date ${run.runDateAD}.`);
    }
    const paidDateBS = await bsDateOrThrow(dateAD, client);

    const lines = (await client.query(PAYROLL_LINES_BY_RUN_SQL, [id])).rows;
    const journal = await postPayrollPaymentJournal(client, {
      runId: id,
      runNo: String(run.runNo),
      branchId: String(run.branchId),
      periodKey: String(run.periodKey),
      dateAD,
      paymentMethod,
      lines,
      actor: actorOf(req),
    });
    if (!journal) {
      throw new ApiError(400, 'This run has no net salary to pay: every employee line is fully deducted.');
    }
    await client.query(PAYROLL_RUN_SET_PAID_SQL, [id, journal.id, dateAD, paidDateBS, paymentMethod]);
    const updated = (await client.query(PAYROLL_RUN_BY_ID_SQL, [id])).rows[0];
    await logAuditEvent(
      req,
      'PAY_PAYROLL_RUN',
      'ACCOUNTING',
      `Paid payroll run ${run.runNo} for ${run.periodKey} at ${run.branchId}: net NPR ${Number(run.netTotal).toFixed(2)} via ${paymentMethod} (journal ${journal.journalNo}).`,
      String(run.branchId),
      client
    );
    return { run: updated, journal, lines };
  });

  if (!paid) return; // assertInScope already wrote the 403
  return res.json({
    ...paid.run,
    journal: paid.journal,
    journalNo: paid.journal.journalNo,
    lines: paid.lines,
  });
}
