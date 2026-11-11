/**
 * F1 Employee Profile.
 *
 * The whole payload is personal data — father and grandfather names, both
 * addresses, the emergency contact's address and relation, blood group, medical
 * history, accident/case notes and the declaration. A caller who may only view
 * the masked employee master therefore gets the masked shape (null scalars, no
 * child rows, `masked: true`), and only the manage grant can write it.
 *
 * Branch custody is read from the employee row, never from the request: a row
 * outside the caller's branches is reported as missing so the endpoint cannot be
 * used to probe another branch's employee ids. The app-level branch guard over
 * `/employees/:id` commonly answers first with 403; this check is the second
 * line of defence for any path that reaches the controller.
 *
 * PUT is a whole-profile replace: the scalar columns are written and each
 * repeating block is deleted and re-inserted from the request in one
 * transaction, so a half-saved form cannot be read back. An omitted field is
 * cleared, which is what the form the officer just submitted means.
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
import { isAccountingDate } from '../services/accounting.service';
import {
  HR_BLOOD_GROUPS,
  HR_EXPERIENCE_BY_EMPLOYEE_SQL,
  HR_EXPERIENCE_DELETE_SQL,
  HR_EXPERIENCE_INSERT_SQL,
  HR_FAMILY_BY_EMPLOYEE_SQL,
  HR_FAMILY_DELETE_SQL,
  HR_FAMILY_INSERT_SQL,
  HR_PROFILE_EMPLOYEE_SQL,
  HR_PROFILE_LIMITS,
  HR_PROFILE_UPDATE_SQL,
  HR_QUALIFICATION_BY_EMPLOYEE_SQL,
  HR_QUALIFICATION_DELETE_SQL,
  HR_QUALIFICATION_INSERT_SQL,
  HR_REFERENCE_BY_EMPLOYEE_SQL,
  HR_REFERENCE_DELETE_SQL,
  HR_REFERENCE_INSERT_SQL,
} from '../models/hrEmployeeProfile.repo';

/** Anything that can run a parameterised query: the pool or a transaction. */
interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
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

/** Same gate as the employee master: manage (or the legacy payroll grant) sees PII. */
function seesFullProfilePii(req: any): boolean {
  return holdsPermission(req, 'hr-employee-manage') || holdsPermission(req, 'gl-payroll-manage');
}

function requireManage(req: any): void {
  if (!seesFullProfilePii(req)) {
    throw new ApiError(403, 'The employee profile requires the HR manage permission.');
  }
}

function requireEmployeeId(req: any): string {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An employee id is required.');
  return id;
}

async function loadEmployee(req: any, employeeId: string): Promise<any> {
  const employee = (await pgPool.query(HR_PROFILE_EMPLOYEE_SQL, [employeeId])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed && !allowed.has(String(employee.branchId))) {
    throw new ApiError(404, 'Employee not found.');
  }
  return employee;
}

function optionalText(value: unknown, max: number): string | null {
  const parsed = text(value, max);
  return parsed || null;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = text(value, 10);
  if (!isAccountingDate(parsed)) {
    throw new ApiError(400, `${field} must be a real date in YYYY-MM-DD form.`);
  }
  return parsed;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, `${field} must be a whole number between ${min} and ${max}.`);
  }
  return parsed;
}

function optionalPercentage(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new ApiError(400, `${field} must be a number between 0 and 100.`);
  }
  return Math.round(parsed * 100) / 100;
}

function optionalBloodGroup(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = text(value, 10).toUpperCase();
  if (!(HR_BLOOD_GROUPS as readonly string[]).includes(parsed)) {
    throw new ApiError(400, `Blood group must be one of: ${HR_BLOOD_GROUPS.join(', ')}.`);
  }
  return parsed;
}

/** A bounded list of row objects; a non-object row is a bad request, not a gap. */
function boundedRows(value: unknown, max: number, label: string): any[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiError(400, `${label} must be a list.`);
  if (value.length > max) {
    throw new ApiError(400, `${label} accepts at most ${max} rows.`);
  }
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ApiError(400, `Every ${label} row must be an object.`);
    }
    return row as any;
  });
}

function rowText(row: any, key: string, field: string, max: number): string {
  const parsed = text(row?.[key], max);
  if (!parsed) throw new ApiError(400, `${field} is required on every row.`);
  return parsed;
}

interface ParsedProfile {
  scalars: {
    fatherName: string | null;
    grandfatherName: string | null;
    permanentAddress: string | null;
    localAddress: string | null;
    emergencyContactAddress: string | null;
    emergencyContactRelation: string | null;
    bloodGroup: string | null;
    medicalConditions: string | null;
    medicalDetails: string | null;
    accidentDetails: string | null;
    caseDetails: string | null;
    declarationDateAD: string | null;
    declarationName: string | null;
  };
  familyMembers: Array<{
    name: string;
    age: number | null;
    occupation: string | null;
    relation: string | null;
  }>;
  experience: Array<{
    organization: string;
    fromAD: string | null;
    toAD: string | null;
    designation: string | null;
  }>;
  qualifications: Array<{
    examPassed: string;
    boardUniversity: string | null;
    percentage: number | null;
  }>;
  references: Array<{
    name: string;
    organization: string | null;
    contact: string | null;
    relation: string | null;
  }>;
}

/** Validates the whole PUT body before a single row is written. */
function parseProfile(body: any): ParsedProfile {
  const source = body && typeof body === 'object' ? body : {};

  const familyMembers = boundedRows(
    source.familyMembers,
    HR_PROFILE_LIMITS.familyMembers,
    'Family details'
  ).map((row) => ({
    name: rowText(row, 'name', 'A family member name', 200),
    age: optionalInteger(row.age, 'Family member age', 0, 150),
    occupation: optionalText(row.occupation, 150),
    relation: optionalText(row.relation, 80),
  }));

  const experience = boundedRows(
    source.experience,
    HR_PROFILE_LIMITS.experience,
    'Experience'
  ).map((row) => {
    const fromAD = optionalDate(row.fromAD, 'Experience start date');
    const toAD = optionalDate(row.toAD, 'Experience end date');
    if (fromAD && toAD && toAD < fromAD) {
      throw new ApiError(400, 'Experience end date must be on or after its start date.');
    }
    return {
      organization: rowText(row, 'organization', 'An organisation', 200),
      fromAD,
      toAD,
      designation: optionalText(row.designation, 150),
    };
  });

  const qualifications = boundedRows(
    source.qualifications,
    HR_PROFILE_LIMITS.qualifications,
    'Qualifications'
  ).map((row) => ({
    examPassed: rowText(row, 'examPassed', 'An exam passed', 200),
    boardUniversity: optionalText(row.boardUniversity, 200),
    percentage: optionalPercentage(row.percentage, 'Qualification percentage'),
  }));

  const references = boundedRows(
    source.references,
    HR_PROFILE_LIMITS.references,
    'References'
  ).map((row) => ({
    name: rowText(row, 'name', 'A reference name', 200),
    organization: optionalText(row.organization, 200),
    contact: optionalText(row.contact, 120),
    relation: optionalText(row.relation, 80),
  }));

  return {
    scalars: {
      fatherName: optionalText(source.fatherName, 200),
      grandfatherName: optionalText(source.grandfatherName, 200),
      permanentAddress: optionalText(source.permanentAddress, 2000),
      localAddress: optionalText(source.localAddress, 2000),
      emergencyContactAddress: optionalText(source.emergencyContactAddress, 2000),
      emergencyContactRelation: optionalText(source.emergencyContactRelation, 80),
      bloodGroup: optionalBloodGroup(source.bloodGroup),
      medicalConditions: optionalText(source.medicalConditions, 300),
      medicalDetails: optionalText(source.medicalDetails, 2000),
      accidentDetails: optionalText(source.accidentDetails, 2000),
      caseDetails: optionalText(source.caseDetails, 2000),
      declarationDateAD: optionalDate(source.declarationDateAD, 'Declaration date'),
      declarationName: optionalText(source.declarationName, 200),
    },
    familyMembers,
    experience,
    qualifications,
    references,
  };
}

/** The wire shape of the profile half of the response. */
function presentProfile(employee: any): ParsedProfile['scalars'] {
  return {
    fatherName: employee.fatherName ?? null,
    grandfatherName: employee.grandfatherName ?? null,
    permanentAddress: employee.permanentAddress ?? null,
    localAddress: employee.localAddress ?? null,
    emergencyContactAddress: employee.emergencyContactAddress ?? null,
    emergencyContactRelation: employee.emergencyContactRelation ?? null,
    bloodGroup: employee.bloodGroup ?? null,
    medicalConditions: employee.medicalConditions ?? null,
    medicalDetails: employee.medicalDetails ?? null,
    accidentDetails: employee.accidentDetails ?? null,
    caseDetails: employee.caseDetails ?? null,
    declarationDateAD: employee.declarationDateAD ?? null,
    declarationName: employee.declarationName ?? null,
  };
}

async function readCollections(queryable: Queryable, employeeId: string) {
  const [family, experience, qualifications, references] = await Promise.all([
    queryable.query(HR_FAMILY_BY_EMPLOYEE_SQL, [employeeId]),
    queryable.query(HR_EXPERIENCE_BY_EMPLOYEE_SQL, [employeeId]),
    queryable.query(HR_QUALIFICATION_BY_EMPLOYEE_SQL, [employeeId]),
    queryable.query(HR_REFERENCE_BY_EMPLOYEE_SQL, [employeeId]),
  ]);
  return {
    familyMembers: family.rows,
    experience: experience.rows,
    qualifications: qualifications.rows,
    references: references.rows,
  };
}

function emptyProfile(): ParsedProfile['scalars'] {
  return {
    fatherName: null,
    grandfatherName: null,
    permanentAddress: null,
    localAddress: null,
    emergencyContactAddress: null,
    emergencyContactRelation: null,
    bloodGroup: null,
    medicalConditions: null,
    medicalDetails: null,
    accidentDetails: null,
    caseDetails: null,
    declarationDateAD: null,
    declarationName: null,
  };
}

/** GET /api/employees/:id/profile */
export async function get_hrEmployeeProfile(req: any, res: Response): Promise<any> {
  requireDb();
  const employee = await loadEmployee(req, requireEmployeeId(req));
  if (!seesFullProfilePii(req)) {
    return res.json({
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      name: employee.name,
      branchId: employee.branchId,
      masked: true,
      profile: emptyProfile(),
      familyMembers: [],
      experience: [],
      qualifications: [],
      references: [],
    });
  }
  const collections = await readCollections(pgPool, employee.id);
  return res.json({
    employeeId: employee.id,
    employeeCode: employee.employeeCode,
    name: employee.name,
    branchId: employee.branchId,
    masked: false,
    profile: presentProfile(employee),
    ...collections,
  });
}

/** PUT /api/employees/:id/profile */
export async function put_hrEmployeeProfile(req: any, res: Response): Promise<any> {
  requireDb();
  const employee = await loadEmployee(req, requireEmployeeId(req));
  requireManage(req);
  const parsed = parseProfile(req.body);

  const saved = await withTransaction(async (client) => {
    await client.query(HR_PROFILE_UPDATE_SQL, [
      employee.id,
      parsed.scalars.fatherName,
      parsed.scalars.grandfatherName,
      parsed.scalars.permanentAddress,
      parsed.scalars.localAddress,
      parsed.scalars.emergencyContactAddress,
      parsed.scalars.emergencyContactRelation,
      parsed.scalars.bloodGroup,
      parsed.scalars.medicalConditions,
      parsed.scalars.medicalDetails,
      parsed.scalars.accidentDetails,
      parsed.scalars.caseDetails,
      parsed.scalars.declarationDateAD,
      parsed.scalars.declarationName,
      actorOf(req),
    ]);

    await client.query(HR_FAMILY_DELETE_SQL, [employee.id]);
    for (const [index, row] of parsed.familyMembers.entries()) {
      await client.query(HR_FAMILY_INSERT_SQL, [
        `hr-fam-${crypto.randomUUID()}`,
        employee.id,
        index + 1,
        row.name,
        row.age,
        row.occupation,
        row.relation,
      ]);
    }

    await client.query(HR_EXPERIENCE_DELETE_SQL, [employee.id]);
    for (const [index, row] of parsed.experience.entries()) {
      await client.query(HR_EXPERIENCE_INSERT_SQL, [
        `hr-exp-${crypto.randomUUID()}`,
        employee.id,
        index + 1,
        row.organization,
        row.fromAD,
        row.toAD,
        row.designation,
      ]);
    }

    await client.query(HR_QUALIFICATION_DELETE_SQL, [employee.id]);
    for (const [index, row] of parsed.qualifications.entries()) {
      await client.query(HR_QUALIFICATION_INSERT_SQL, [
        `hr-qual-${crypto.randomUUID()}`,
        employee.id,
        index + 1,
        row.examPassed,
        row.boardUniversity,
        row.percentage,
      ]);
    }

    await client.query(HR_REFERENCE_DELETE_SQL, [employee.id]);
    for (const [index, row] of parsed.references.entries()) {
      await client.query(HR_REFERENCE_INSERT_SQL, [
        `hr-ref-${crypto.randomUUID()}`,
        employee.id,
        index + 1,
        row.name,
        row.organization,
        row.contact,
        row.relation,
      ]);
    }

    await logAuditEvent(
      req,
      'UPDATE_EMPLOYEE_PROFILE',
      'ACCOUNTING',
      `Updated the F1 profile for employee ${employee.employeeCode} ` +
        `(${parsed.familyMembers.length} family, ${parsed.experience.length} experience, ` +
        `${parsed.qualifications.length} qualification, ${parsed.references.length} reference row(s))`,
      String(employee.branchId),
      client
    );

    const updated = (await client.query(HR_PROFILE_EMPLOYEE_SQL, [employee.id])).rows[0];
    const collections = await readCollections(client, employee.id);
    return { updated, collections };
  });

  return res.json({
    employeeId: saved.updated.id,
    employeeCode: saved.updated.employeeCode,
    name: saved.updated.name,
    branchId: saved.updated.branchId,
    masked: false,
    profile: presentProfile(saved.updated),
    ...saved.collections,
  });
}
