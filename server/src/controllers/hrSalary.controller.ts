/**
 * Phase 2 payroll preparation: effective-dated salary structures.
 *
 * One structure is a header (employee, effective date, SSF eligibility, OT rate,
 * monthly TDS instruction) plus component lines. Basic and HR allowance are
 * created as BASIC/HRA lines from a monthly gross at the documented 60/40
 * default; a later structure supersedes an earlier one from its effective date,
 * while the older row is kept for payroll of earlier periods.
 *
 * Reads need `hr-employee-view` (or `hr-employee-manage` / the legacy
 * `gl-payroll-manage` grant). Writes need `hr-employee-manage` or the legacy
 * grant, repeated inside the controller so a bypassed route guard still refuses.
 * The branch comes from the employee, never the request; every list intersects
 * the caller's allowed branches and every by-id path refuses another branch.
 *
 * Every mutation writes its audit row in the same transaction.
 */
import crypto from 'crypto';
import type { Response } from 'express';
import {
  getPgConnected,
  permissionMatrix,
  pgPool,
  userPermissionOverrides,
  userPermissionSetGrants,
} from '../app';
import { effectivePermission } from '../services/permissionOverrides.service';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import { isAccountingDate, isUniqueViolation } from '../services/accounting.service';
import {
  HR_SALARY_BY_ID_SQL,
  HR_SALARY_COMPONENT_INSERT_SQL,
  HR_SALARY_COMPONENTS_BY_SALARY_IDS_SQL,
  HR_SALARY_COMPONENTS_DELETE_SQL,
  HR_SALARY_COMPONENT_KINDS,
  HR_SALARY_EFFECTIVE_LIST_SQL,
  HR_SALARY_EMPLOYEE_BY_ID_SQL,
  HR_SALARY_INSERT_SQL,
  HR_SALARY_LIST_SQL,
  HR_SALARY_UPDATE_SQL,
  type HrSalaryComponentKind,
} from '../models/hrSalary.repo';

const MAX_SALARY_COMPONENTS = 20;
const MAX_MONEY = 100_000_000;
const MAX_OT_RATE = 100_000;
const MAX_TDS_MONTHLY = 10_000_000;

interface HrBranchScope {
  /** A concrete filter branch; null means all branches (global only). */
  branchId: string | null;
  /** Allowed branches, or null for a global account. */
  allowed: Set<string> | null;
  empty: boolean;
}

interface SalaryEmployee {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  isActive: boolean;
  ssfEligible: boolean;
}

interface ComponentDraft {
  code: string;
  name: string;
  kind: HrSalaryComponentKind;
  amount: number;
  taxable: boolean;
  ssfApplicable: boolean;
  sortOrder: number;
}

function requireDb(): void {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function optionalText(value: unknown, max: number): string | null {
  const parsed = text(value, max);
  return parsed || null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The route already gates writes; repeating it closes a bypassed route edit. */
function requireManage(req: any): void {
  const user = req.user || getUserFromReq(req);
  const allowed =
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
    );
  if (!allowed) {
    throw new ApiError(403, 'Salary structures require the HR employee-manage permission.');
  }
}

function parseDate(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!date) throw new ApiError(400, `${label} is required.`);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return date;
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return parseDate(value, label);
}

function optionalMoney(
  value: unknown,
  label: string,
  min: number,
  max: number
): number | null {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    throw new ApiError(400, `${label} must be between ${min} and ${max}.`);
  }
  return Math.round(amount * 100) / 100;
}

function readScope(req: any): HrBranchScope {
  const user = req.user || getUserFromReq(req);
  const allowed = allowedBranchScope(user);
  const raw = text(req.query?.branchId, 50);
  if (allowed === null) {
    return { branchId: raw && raw !== 'ALL' ? raw : null, allowed: null, empty: false };
  }
  if (allowed.size === 0) return { branchId: null, allowed, empty: true };
  if (raw === 'ALL') {
    throw new ApiError(403, 'Forbidden: branch users cannot access all branches.');
  }
  if (raw && !allowed.has(raw)) {
    throw new ApiError(403, 'Forbidden: this account is not authorized for the requested branch.');
  }
  return {
    branchId: raw || user.branchId || [...allowed][0],
    allowed,
    empty: false,
  };
}

function assertWriteBranch(req: any, branchId: string): void {
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed && !allowed.has(branchId)) {
    throw new ApiError(403, 'Forbidden: this record belongs to another branch.');
  }
}

async function loadEmployee(employeeId: string): Promise<SalaryEmployee> {
  const employee = (await pgPool.query(HR_SALARY_EMPLOYEE_BY_ID_SQL, [employeeId])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  return employee;
}

async function assertEmployeeReadable(req: any, employeeId: string): Promise<void> {
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (!allowed) return;
  const employee = await loadEmployee(employeeId);
  if (!allowed.has(String(employee.branchId))) {
    throw new ApiError(403, 'Forbidden: this employee belongs to another branch.');
  }
}

async function loadSalary(id: string): Promise<any> {
  const row = (await pgPool.query(HR_SALARY_BY_ID_SQL, [id])).rows[0];
  if (!row) throw new ApiError(404, 'Salary structure not found.');
  return row;
}

async function componentsFor(salaryIds: string[]): Promise<Map<string, any[]>> {
  const grouped = new Map<string, any[]>();
  if (salaryIds.length === 0) return grouped;
  const rows = (
    await pgPool.query(HR_SALARY_COMPONENTS_BY_SALARY_IDS_SQL, [salaryIds])
  ).rows;
  for (const row of rows) {
    const list = grouped.get(String(row.salaryId)) || [];
    list.push({ ...row, amount: Number(row.amount ?? 0) });
    grouped.set(String(row.salaryId), list);
  }
  return grouped;
}

function salaryResponse(row: any, components: any[]): any {
  const basic = components.find((component) => component.componentCode === 'BASIC');
  const hra = components.find((component) => component.componentCode === 'HRA');
  const monthlyGross = components
    .filter((component) => component.kind === 'EARNING')
    .reduce((sum, component) => sum + Number(component.amount ?? 0), 0);
  return {
    ...row,
    overtimeRate: Number(row.overtimeRate ?? 0),
    tdsMonthly: Number(row.tdsMonthly ?? 0),
    basicAmount: Number(basic?.amount ?? 0),
    hraAmount: Number(hra?.amount ?? 0),
    monthlyGross: Math.round(monthlyGross * 100) / 100,
    components,
  };
}

async function withComponents(row: any): Promise<any> {
  const components = (await componentsFor([String(row.id)])).get(String(row.id)) || [];
  return salaryResponse(row, components);
}

function normalizeComponents(value: unknown): ComponentDraft[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, 'Components must be an array.');
  }
  if (value.length === 0 || value.length > MAX_SALARY_COMPONENTS) {
    throw new ApiError(
      400,
      `A salary structure needs between 1 and ${MAX_SALARY_COMPONENTS} components.`
    );
  }
  const seen = new Set<string>();
  const components: ComponentDraft[] = value.map((raw: any, index: number) => {
    const code = text(raw?.code ?? raw?.componentCode, 30).toUpperCase();
    if (!code) throw new ApiError(400, 'Every component needs a code.');
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,29}$/.test(code)) {
      throw new ApiError(
        400,
        'Component codes must be 1–30 letters, digits, dots, dashes, slashes or underscores.'
      );
    }
    if (seen.has(code)) {
      throw new ApiError(400, `Component ${code} appears twice.`);
    }
    seen.add(code);
    const kindRaw = text(raw?.kind, 24).toUpperCase() || 'EARNING';
    if (!(HR_SALARY_COMPONENT_KINDS as readonly string[]).includes(kindRaw)) {
      throw new ApiError(
        400,
        `Component kind must be one of: ${HR_SALARY_COMPONENT_KINDS.join(', ')}.`
      );
    }
    const amount = optionalMoney(raw?.amount, `Component ${code} amount`, 0, MAX_MONEY);
    if (amount === null) throw new ApiError(400, `Component ${code} needs an amount.`);
    const sort = Number(raw?.sortOrder);
    return {
      code,
      name: text(raw?.name ?? raw?.componentName, 120) || code,
      kind: kindRaw as HrSalaryComponentKind,
      amount,
      taxable: parseBoolean(raw?.taxable ?? raw?.isTaxable, true),
      ssfApplicable: parseBoolean(raw?.ssfApplicable ?? raw?.isSsfApplicable, false),
      sortOrder: Number.isFinite(sort) ? Math.trunc(sort) : index * 10,
    };
  });
  if (!components.some((component) => component.kind === 'EARNING')) {
    throw new ApiError(400, 'A salary structure needs at least one earning component.');
  }
  return components;
}

/**
 * Basic 60% / HR allowance 40% is the documented default. A caller can supply
 * the two amounts instead of a gross, or its own component list.
 */
function defaultComponents(body: any): ComponentDraft[] {
  const gross = optionalMoney(body?.monthlyGross, 'Monthly gross', 0, MAX_MONEY);
  const basicInput = optionalMoney(body?.basicAmount, 'Basic amount', 0, MAX_MONEY);
  const hraInput = optionalMoney(body?.hraAmount, 'HR allowance', 0, MAX_MONEY);
  if (gross === null && basicInput === null && hraInput === null) {
    throw new ApiError(400, 'Provide monthlyGross, basicAmount/hraAmount, or components.');
  }
  let basic = basicInput;
  let hra = hraInput;
  if (gross !== null) {
    if (basic === null) basic = Math.round(gross * 0.6 * 100) / 100;
    if (hra === null) hra = Math.round((gross - basic) * 100) / 100;
  }
  basic = basic ?? 0;
  hra = hra ?? 0;
  return [
    {
      code: 'BASIC',
      name: 'Basic Salary',
      kind: 'EARNING',
      amount: basic,
      taxable: true,
      ssfApplicable: true,
      sortOrder: 10,
    },
    {
      code: 'HRA',
      name: 'HR Allowance',
      kind: 'EARNING',
      amount: hra,
      taxable: true,
      ssfApplicable: true,
      sortOrder: 20,
    },
  ];
}

async function insertComponents(
  client: any,
  salaryId: string,
  components: ComponentDraft[]
): Promise<void> {
  for (const component of components) {
    await client.query(HR_SALARY_COMPONENT_INSERT_SQL, [
      `hr-salary-comp-${crypto.randomUUID()}`,
      salaryId,
      component.code,
      component.name,
      component.kind,
      component.amount,
      component.taxable,
      component.ssfApplicable,
      component.sortOrder,
    ]);
  }
}

/** GET /api/hr/employee-salaries?branchId=&employeeId=&asOf= */
export async function get_hrSalaryStructures(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = readScope(req);
  if (scope.empty) return res.json([]);
  const employeeId = optionalText(req.query?.employeeId, 50);
  if (employeeId) await assertEmployeeReadable(req, employeeId);
  const asOf = optionalDate(req.query?.asOf, 'As-of date');

  const params: any[] = [
    scope.branchId,
    scope.allowed ? [...scope.allowed] : null,
    employeeId,
  ];
  const rows = asOf
    ? (
        await pgPool.query(HR_SALARY_EFFECTIVE_LIST_SQL, [...params, asOf])
      ).rows
    : (await pgPool.query(HR_SALARY_LIST_SQL, params)).rows;

  const components = await componentsFor(rows.map((row: any) => String(row.id)));
  return res.json(
    rows.map((row: any) =>
      salaryResponse(row, components.get(String(row.id)) || [])
    )
  );
}

/** GET /api/hr/employee-salaries/:id */
export async function get_hrSalaryStructure(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A salary structure id is required.');
  const row = await loadSalary(id);
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed && !allowed.has(String(row.branchId))) {
    throw new ApiError(403, 'Forbidden: this salary structure belongs to another branch.');
  }
  return res.json(await withComponents(row));
}

/** POST /api/hr/employee-salaries */
export async function post_hrSalaryStructure(req: any, res: Response): Promise<any> {
  requireDb();
  requireManage(req);
  const employeeId = text(req.body?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee is required.');
  const employee = await loadEmployee(employeeId);
  assertWriteBranch(req, String(employee.branchId));
  const effectiveFrom = parseDate(req.body?.effectiveFrom, 'Effective date');

  const components = Array.isArray(req.body?.components)
    ? normalizeComponents(req.body.components)
    : defaultComponents(req.body);
  const ssfEligible = parseBoolean(req.body?.ssfEligible, Boolean(employee.ssfEligible));
  const overtimeRate =
    optionalMoney(req.body?.overtimeRate, 'Overtime rate', 0, MAX_OT_RATE) ?? 0;
  const tdsMonthly =
    optionalMoney(req.body?.tdsMonthly, 'Monthly TDS', 0, MAX_TDS_MONTHLY) ?? 0;
  const notes = optionalText(req.body?.notes, 500);

  try {
    const id = await withTransaction(async (client) => {
      const salaryId = `hr-salary-${crypto.randomUUID()}`;
      await client.query(HR_SALARY_INSERT_SQL, [
        salaryId,
        employeeId,
        employee.branchId,
        effectiveFrom,
        ssfEligible,
        overtimeRate,
        tdsMonthly,
        notes,
        actorOf(req),
      ]);
      await insertComponents(client, salaryId, components);
      await logAuditEvent(
        req,
        'CREATE_HR_SALARY_STRUCTURE',
        'ACCOUNTING',
        `Set salary structure for ${employee.employeeCode} effective ${effectiveFrom} (${components
          .filter((component) => component.kind === 'EARNING')
          .map((component) => `${component.code} ${component.amount}`)
          .join(', ')})`,
        String(employee.branchId),
        client
      );
      return salaryId;
    });
    const row = (await pgPool.query(HR_SALARY_BY_ID_SQL, [id])).rows[0];
    return res.status(201).json(await withComponents(row));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        409,
        'A salary structure already exists for that employee and effective date.'
      );
    }
    throw err;
  }
}

/** PATCH /api/hr/employee-salaries/:id */
export async function patch_hrSalaryStructure(req: any, res: Response): Promise<any> {
  requireDb();
  requireManage(req);
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A salary structure id is required.');
  const existing = await loadSalary(id);
  assertWriteBranch(req, String(existing.branchId));

  if (
    req.body?.employeeId !== undefined &&
    text(req.body.employeeId, 50) !== String(existing.employeeId)
  ) {
    throw new ApiError(
      400,
      'The employee and effective date are immutable; add a new structure instead.'
    );
  }
  if (
    req.body?.effectiveFrom !== undefined &&
    text(req.body.effectiveFrom, 10) !== String(existing.effectiveFrom)
  ) {
    throw new ApiError(
      400,
      'The employee and effective date are immutable; add a new structure instead.'
    );
  }

  const ssfEligible =
    req.body?.ssfEligible === undefined
      ? Boolean(existing.ssfEligible)
      : parseBoolean(req.body.ssfEligible, Boolean(existing.ssfEligible));
  const overtimeRate =
    optionalMoney(req.body?.overtimeRate, 'Overtime rate', 0, MAX_OT_RATE) ??
    Number(existing.overtimeRate ?? 0);
  const tdsMonthly =
    optionalMoney(req.body?.tdsMonthly, 'Monthly TDS', 0, MAX_TDS_MONTHLY) ??
    Number(existing.tdsMonthly ?? 0);
  const notes =
    req.body?.notes === undefined ? existing.notes : optionalText(req.body.notes, 500);
  const components =
    req.body?.components === undefined ? null : normalizeComponents(req.body.components);

  await withTransaction(async (client) => {
    await client.query(HR_SALARY_UPDATE_SQL, [
      id,
      ssfEligible,
      overtimeRate,
      tdsMonthly,
      notes,
      actorOf(req),
    ]);
    if (components) {
      await client.query(HR_SALARY_COMPONENTS_DELETE_SQL, [id]);
      await insertComponents(client, id, components);
    }
    await logAuditEvent(
      req,
      'UPDATE_HR_SALARY_STRUCTURE',
      'ACCOUNTING',
      `Updated salary structure for ${existing.employeeCode} effective ${existing.effectiveFrom}`,
      String(existing.branchId),
      client
    );
  });

  const row = (await pgPool.query(HR_SALARY_BY_ID_SQL, [id])).rows[0];
  return res.json(await withComponents(row));
}
