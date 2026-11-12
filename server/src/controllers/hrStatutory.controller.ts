/**
 * Phase 2 statutory deductions: fiscal-year TDS slabs plus SSF rates.
 *
 * Configuration is company-wide, not branch data. Reads use the HR read grants
 * so every payroll reader can see the rules; creates and corrections require a
 * payroll/HR manager AND a global account, because a branch-bound user must not
 * rewrite a rate that applies to every branch. The controller repeats the
 * permission and global checks after the route guard.
 *
 * The computation endpoint resolves the employee's effective-dated structure
 * and the fiscal year containing the as-of date, then applies the configured
 * monthly slabs. Employee SSF (11% of BASIC by default) reduces taxable gross;
 * employer SSF is a company cost and does not. SSF-eligible employees have no
 * separate TDS because the contribution already includes salary tax. Missing
 * fiscal years or missing configurations are 422s, never a silent zero.
 *
 * Every config mutation and its audit row share one transaction.
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
  HR_SALARY_COMPONENTS_BY_SALARY_IDS_SQL,
} from '../models/hrSalary.repo';
import {
  HR_STATUTORY_CONFIG_BY_ID_SQL,
  HR_STATUTORY_CONFIG_BY_YEAR_SQL,
  HR_STATUTORY_CONFIG_INSERT_SQL,
  HR_STATUTORY_CONFIG_LIST_SQL,
  HR_STATUTORY_CONFIG_UPDATE_SQL,
  HR_STATUTORY_FISCAL_YEAR_BY_ID_SQL,
  HR_STATUTORY_FISCAL_YEAR_FOR_DATE_SQL,
  HR_STATUTORY_SLABS_BY_CONFIG_IDS_SQL,
  HR_STATUTORY_SLABS_DELETE_SQL,
  HR_STATUTORY_SLAB_INSERT_SQL,
} from '../models/hrStatutory.repo';
import { calculateStatutory } from '../services/statutoryCalc.service';

const MAX_SLABS = 20;
const MAX_SLAB_BOUND = 100_000_000;
const MAX_PERCENT = 100;

interface SlabDraft {
  slabOrder: number;
  lowerBound: number;
  upperBound: number | null;
  ratePercent: number;
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
    throw new ApiError(403, 'Statutory configuration requires the HR employee-manage permission.');
  }
}

/** A rate table applies to every branch, so only a global account may change it. */
function requireGlobalWrite(req: any): void {
  requireManage(req);
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed !== null) {
    throw new ApiError(
      403,
      'Statutory configuration is company-wide; a global payroll administrator must maintain it.'
    );
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseDate(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!date) throw new ApiError(400, `${label} is required.`);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return date;
}

function parsePercent(value: unknown, label: string, fallback?: number): number {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) {
    return fallback;
  }
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_PERCENT) {
    throw new ApiError(422, `${label} must be between 0 and ${MAX_PERCENT}.`);
  }
  return round2(rate);
}

function parseBound(value: unknown, label: string, allowNull = false): number | null {
  if (value === undefined || value === null || value === '') {
    if (allowNull) return null;
    throw new ApiError(422, `${label} is required.`);
  }
  const bound = Number(value);
  if (!Number.isFinite(bound) || bound < 0 || bound > MAX_SLAB_BOUND) {
    throw new ApiError(422, `${label} must be between 0 and ${MAX_SLAB_BOUND}.`);
  }
  return round2(bound);
}

/**
 * Sorts and validates one progressive monthly table:
 * starts at zero, every band meets the previous one exactly, only the last is
 * open-ended, and no two bands share a lower bound.
 */
function normalizeSlabs(value: unknown): SlabDraft[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(422, 'At least one TDS slab is required.');
  }
  if (value.length > MAX_SLABS) {
    throw new ApiError(422, `A TDS table can contain at most ${MAX_SLABS} slabs.`);
  }
  const parsed = value.map((raw: any, index: number) => {
    const lowerBound = parseBound(raw?.lowerBound, `Slab ${index + 1} lower bound`);
    if (lowerBound === null) {
      throw new ApiError(422, `Slab ${index + 1} lower bound is required.`);
    }
    const upperBound = parseBound(raw?.upperBound, `Slab ${index + 1} upper bound`, true);
    const ratePercent = parsePercent(raw?.ratePercent, `Slab ${index + 1} rate`);
    if (upperBound !== null && upperBound <= lowerBound) {
      throw new ApiError(422, `Slab ${index + 1} upper bound must be greater than its lower bound.`);
    }
    return { lowerBound, upperBound, ratePercent };
  });

  parsed.sort((a, b) => a.lowerBound - b.lowerBound);
  const seen = new Set<number>();
  for (const slab of parsed) {
    if (seen.has(slab.lowerBound)) {
      throw new ApiError(422, `Two TDS slabs start at ${slab.lowerBound}.`);
    }
    seen.add(slab.lowerBound);
  }
  if (parsed[0].lowerBound !== 0) {
    throw new ApiError(422, 'The first TDS slab must start at 0.');
  }

  let openEnded = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const slab = parsed[index];
    if (slab.upperBound === null) {
      openEnded += 1;
      if (index !== parsed.length - 1) {
        throw new ApiError(422, 'Only the last TDS slab may be open-ended.');
      }
      continue;
    }
    if (index === parsed.length - 1) {
      throw new ApiError(422, 'The last TDS slab must be open-ended (no upper bound).');
    }
    const next = parsed[index + 1];
    if (next.lowerBound !== slab.upperBound) {
      throw new ApiError(
        422,
        next.lowerBound > slab.upperBound
          ? `TDS slabs have a gap between ${slab.upperBound} and ${next.lowerBound}.`
          : `TDS slabs overlap between ${next.lowerBound} and ${slab.upperBound}.`
      );
    }
  }
  if (openEnded !== 1) {
    throw new ApiError(422, 'Exactly one open-ended top TDS slab is required.');
  }

  return parsed.map((slab, index) => ({
    ...slab,
    slabOrder: index + 1,
  }));
}

async function configsWithSlabs(rows: any[]): Promise<any[]> {
  if (rows.length === 0) return [];
  const slabs = (
    await pgPool.query(
      HR_STATUTORY_SLABS_BY_CONFIG_IDS_SQL,
      [rows.map((row: any) => String(row.id))]
    )
  ).rows;
  const grouped = new Map<string, any[]>();
  for (const slab of slabs) {
    const list = grouped.get(String(slab.configId)) || [];
    list.push({
      ...slab,
      lowerBound: Number(slab.lowerBound ?? 0),
      upperBound: slab.upperBound === null ? null : Number(slab.upperBound),
      ratePercent: Number(slab.ratePercent ?? 0),
    });
    grouped.set(String(slab.configId), list);
  }
  return rows.map((row) => ({
    ...row,
    employeeSsfPercent: Number(row.employeeSsfPercent ?? 0),
    employerSsfPercent: Number(row.employerSsfPercent ?? 0),
    slabs: grouped.get(String(row.id)) || [],
  }));
}

async function configById(id: string): Promise<any> {
  const row = (await pgPool.query(HR_STATUTORY_CONFIG_BY_ID_SQL, [id])).rows[0];
  if (!row) throw new ApiError(404, 'Statutory configuration not found.');
  return (await configsWithSlabs([row]))[0];
}

async function insertSlabs(client: any, configId: string, slabs: SlabDraft[]): Promise<void> {
  for (const slab of slabs) {
    await client.query(HR_STATUTORY_SLAB_INSERT_SQL, [
      `hr-tds-slab-${crypto.randomUUID()}`,
      configId,
      slab.slabOrder,
      slab.lowerBound,
      slab.upperBound,
      slab.ratePercent,
    ]);
  }
}

/** GET /api/hr/statutory-configs?fiscalYearId= */
export async function get_hrStatutoryConfigs(req: any, res: Response): Promise<any> {
  requireDb();
  const fiscalYearId = optionalText(req.query?.fiscalYearId, 50);
  const rows = (await pgPool.query(HR_STATUTORY_CONFIG_LIST_SQL, [fiscalYearId])).rows;
  return res.json(await configsWithSlabs(rows));
}

/** GET /api/hr/statutory-configs/:id */
export async function get_hrStatutoryConfig(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A statutory configuration id is required.');
  return res.json(await configById(id));
}

/** POST /api/hr/statutory-configs */
export async function post_hrStatutoryConfig(req: any, res: Response): Promise<any> {
  requireDb();
  requireGlobalWrite(req);
  const fiscalYearId = text(req.body?.fiscalYearId, 50);
  if (!fiscalYearId) throw new ApiError(422, 'A fiscal year is required.');
  const fiscalYear = (await pgPool.query(HR_STATUTORY_FISCAL_YEAR_BY_ID_SQL, [fiscalYearId]))
    .rows[0];
  if (!fiscalYear) throw new ApiError(404, 'Fiscal year not found.');

  const existing = (
    await pgPool.query(HR_STATUTORY_CONFIG_BY_YEAR_SQL, [fiscalYearId])
  ).rows[0];
  if (existing) {
    throw new ApiError(
      422,
      `A statutory configuration already exists for fiscal year ${fiscalYear.code}.`
    );
  }

  const employeeSsfPercent = parsePercent(
    req.body?.employeeSsfPercent,
    'Employee SSF rate',
    11
  );
  const employerSsfPercent = parsePercent(
    req.body?.employerSsfPercent,
    'Employer SSF rate',
    20
  );
  const slabs = normalizeSlabs(req.body?.slabs);
  const notes = optionalText(req.body?.notes, 500);

  try {
    const id = await withTransaction(async (client) => {
      const configId = `hr-stat-${crypto.randomUUID()}`;
      await client.query(HR_STATUTORY_CONFIG_INSERT_SQL, [
        configId,
        fiscalYearId,
        employeeSsfPercent,
        employerSsfPercent,
        notes,
        actorOf(req),
      ]);
      await insertSlabs(client, configId, slabs);
      await logAuditEvent(
        req,
        'CREATE_HR_STATUTORY_CONFIG',
        'ACCOUNTING',
        `Created statutory configuration for FY ${fiscalYear.code}: SSF ${employeeSsfPercent}% / ${employerSsfPercent}%, ${slabs.length} TDS slabs`,
        undefined,
        client
      );
      return configId;
    });
    return res.status(201).json(await configById(id));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        422,
        `A statutory configuration already exists for fiscal year ${fiscalYear.code}.`
      );
    }
    throw err;
  }
}

/** PATCH /api/hr/statutory-configs/:id */
export async function patch_hrStatutoryConfig(req: any, res: Response): Promise<any> {
  requireDb();
  requireGlobalWrite(req);
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A statutory configuration id is required.');
  const existing = await configById(id);

  const employeeSsfPercent =
    req.body?.employeeSsfPercent === undefined
      ? Number(existing.employeeSsfPercent)
      : parsePercent(req.body.employeeSsfPercent, 'Employee SSF rate');
  const employerSsfPercent =
    req.body?.employerSsfPercent === undefined
      ? Number(existing.employerSsfPercent)
      : parsePercent(req.body.employerSsfPercent, 'Employer SSF rate');
  const notes =
    req.body?.notes === undefined ? existing.notes : optionalText(req.body.notes, 500);
  const slabs =
    req.body?.slabs === undefined ? null : normalizeSlabs(req.body.slabs);

  await withTransaction(async (client) => {
    await client.query(HR_STATUTORY_CONFIG_UPDATE_SQL, [
      id,
      employeeSsfPercent,
      employerSsfPercent,
      notes,
      actorOf(req),
    ]);
    if (slabs) {
      await client.query(HR_STATUTORY_SLABS_DELETE_SQL, [id]);
      await insertSlabs(client, id, slabs);
    }
    await logAuditEvent(
      req,
      'UPDATE_HR_STATUTORY_CONFIG',
      'ACCOUNTING',
      `Updated statutory configuration for FY ${existing.fiscalYearCode}: SSF ${employeeSsfPercent}% / ${employerSsfPercent}%`,
      undefined,
      client
    );
  });

  return res.json(await configById(id));
}

/**
 * GET /api/hr/employee-salaries/:id/statutory?asOf=YYYY-MM-DD
 *
 * Resolves the salary structure (must be effective on the date), the fiscal
 * year containing the date, and that year's configuration.
 */
export async function get_hrSalaryStatutory(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A salary structure id is required.');
  const asOf = parseDate(req.query?.asOf, 'As-of date');

  const salary = (await pgPool.query(HR_SALARY_BY_ID_SQL, [id])).rows[0];
  if (!salary) throw new ApiError(404, 'Salary structure not found.');
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed && !allowed.has(String(salary.branchId))) {
    throw new ApiError(403, 'Forbidden: this salary structure belongs to another branch.');
  }
  if (String(salary.effectiveFrom) > asOf) {
    throw new ApiError(
      422,
      `This salary structure starts on ${salary.effectiveFrom}; it is not effective on ${asOf}.`
    );
  }

  const fiscalYear = (
    await pgPool.query(HR_STATUTORY_FISCAL_YEAR_FOR_DATE_SQL, [asOf])
  ).rows[0];
  if (!fiscalYear) {
    throw new ApiError(422, `No fiscal year covers ${asOf}.`);
  }
  const config = (
    await pgPool.query(HR_STATUTORY_CONFIG_BY_YEAR_SQL, [fiscalYear.id])
  ).rows[0];
  if (!config) {
    throw new ApiError(
      422,
      `No statutory configuration exists for fiscal year ${fiscalYear.code}.`
    );
  }
  const configWithSlabs = (await configsWithSlabs([config]))[0];

  const components = (
    await pgPool.query(HR_SALARY_COMPONENTS_BY_SALARY_IDS_SQL, [[id]])
  ).rows.map((component: any) => ({
    ...component,
    amount: Number(component.amount ?? 0),
  }));
  const monthlyGross = round2(
    components
      .filter((component: any) => component.kind === 'EARNING')
      .reduce((sum: number, component: any) => sum + Number(component.amount), 0)
  );
  const basic = round2(
    Number(
      components.find((component: any) => component.componentCode === 'BASIC')?.amount ?? 0
    )
  );
  const ssfEligible = Boolean(salary.ssfEligible);
  const employeeSsfPercent = Number(configWithSlabs.employeeSsfPercent);
  const employerSsfPercent = Number(configWithSlabs.employerSsfPercent);
  const statutory = calculateStatutory({
    monthlyGross,
    basicAmount: basic,
    ssfEligible,
    employeeSsfPercent,
    employerSsfPercent,
    slabs: configWithSlabs.slabs,
  });

  return res.json({
    structureId: salary.id,
    employeeId: salary.employeeId,
    employeeCode: salary.employeeCode,
    employeeName: salary.employeeName,
    branchId: salary.branchId,
    effectiveFrom: salary.effectiveFrom,
    asOf,
    fiscalYear: {
      id: fiscalYear.id,
      code: fiscalYear.code,
      startDateAD: fiscalYear.startDateAD,
      endDateAD: fiscalYear.endDateAD,
    },
    configId: configWithSlabs.id,
    basicAmount: basic,
    monthlyGross,
    ssfEligible,
    employeeSsfPercent,
    employerSsfPercent,
    employeeSsf: statutory.employeeSsf,
    employerSsf: statutory.employerSsf,
    totalSsf: statutory.totalSsf,
    taxableGross: statutory.taxableGross,
    monthlyTds: statutory.monthlyTds,
    annualTds: statutory.annualTds,
    netAfterStatutory: statutory.netAfterStatutory,
    slabs: statutory.slabs,
    lineItems: [
      ...components.map((component: any) => ({
        label: component.componentName,
        code: component.componentCode,
        kind: component.kind,
        amount: Number(component.amount),
      })),
      ...(ssfEligible
        ? [
            {
              label: `Employee SSF (${employeeSsfPercent}%)`,
              code: 'SSF_EMPLOYEE',
              kind: 'DEDUCTION',
              amount: -statutory.employeeSsf,
            },
            {
              label: `Employer SSF (${employerSsfPercent}%)`,
              code: 'SSF_EMPLOYER',
              kind: 'EMPLOYER_CONTRIBUTION',
              amount: statutory.employerSsf,
            },
          ]
        : []),
      {
        label: 'Monthly TDS',
        code: 'TDS',
        kind: 'DEDUCTION',
        amount: -statutory.monthlyTds,
      },
    ],
  });
}
