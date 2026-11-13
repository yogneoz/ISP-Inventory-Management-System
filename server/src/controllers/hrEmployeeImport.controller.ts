/**
 * Employee master-sheet import.
 *
 * One endpoint, two phases over the same validated rows:
 *   - DRY_RUN parses and validates only. It performs SELECTs and returns per-row
 *     actions/errors, so the database is left untouched.
 *   - COMMIT re-validates the same CSV and writes every valid row in one
 *     transaction, then writes one audit row in that same transaction. Invalid
 *     rows are skipped and reported with their sheet row number.
 *
 * Idempotency comes from matching `employees.employee_code` (the sheet's HRMS
 * ID): an existing code updates that employee instead of inserting a duplicate.
 * The branch is never moved through an import — a code that exists in another
 * branch is reported and skipped, preserving payroll history and branch custody.
 */
import crypto from 'crypto';
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import { isAccountingDate } from '../services/accounting.service';
import { parseCsv } from '../services/csvImport';
import { roundMoney } from '../utils/money';
import {
  EMPLOYEE_INSERT_SQL,
  EMPLOYEE_UPDATE_SQL,
  employeeInsertParams,
} from '../models/payroll.repo';
import {
  HR_IMPORT_BRANCHES_SQL,
  HR_IMPORT_EMPLOYEES_BY_CODE_SQL,
  HR_IMPORT_WORK_STATIONS_SQL,
  type ImportLookupRow,
} from '../models/hrEmployeeImport.repo';

const IMPORT_MAX_ROWS = 1000;
const IMPORT_MAX_CSV_CHARS = 512 * 1024;
const MONEY_MAX = 99_999_999_999.99;

type ImportMode = 'DRY_RUN' | 'COMMIT';
type ImportAction = 'CREATE' | 'UPDATE' | 'SKIP';

interface ImportRecord {
  existingId: string | null;
  employeeCode: string;
  name: string;
  branchId: string;
  department: string | null;
  designation: string | null;
  designationCode: string | null;
  employmentType: string | null;
  joiningDateAD: string | null;
  dateOfBirthAD: string | null;
  contractExpiryAD: string | null;
  workStation: string | null;
  address: string | null;
  personalContact: string | null;
  emergencyContactPerson: string | null;
  emergencyContactNumber: string | null;
  internalEmail: string | null;
  personalEmail: string | null;
  panNumber: string | null;
  ssfNumber: string | null;
  bankName: string | null;
  bankAccount: string | null;
  monthlySalary: number | null;
  /** null means the column was absent, so an update keeps the stored value. */
  ssfEligible: boolean | null;
  isActive: boolean | null;
}

interface ImportRow {
  rowNumber: number;
  employeeCode: string | null;
  name: string | null;
  action: ImportAction;
  errors: string[];
  record?: ImportRecord;
}

/** Header aliases accept the business sheet's wording and plain CSV exports. */
const HEADER_ALIASES: Record<string, string[]> = {
  employeeCode: ['hrmsid', 'employeecode', 'employeecodehrms', 'code'],
  name: ['fullname', 'employeename', 'name'],
  branch: ['branch', 'branchname', 'branchcode'],
  department: ['department', 'dept'],
  designation: ['designation'],
  designationCode: ['designationcode', 'desigcode'],
  employmentType: ['employmenttype', 'type'],
  status: ['employmentstatus', 'status', 'activeinactive', 'isactive'],
  joiningDate: ['joiningdate', 'joiningdatead', 'dateofjoining'],
  dateOfBirth: ['dateofbirth', 'dob', 'dateofbirthad'],
  contractExpiry: ['contractexpiry', 'contractexpirydate', 'contractexpiryad'],
  workStation: ['workstation', 'workstationname'],
  address: ['address', 'permanentaddress', 'localaddress'],
  personalContact: ['personalcontact', 'personalcontactno', 'mobile', 'mobileno', 'phone'],
  emergencyContactPerson: ['emergencycontactperson', 'emergencycontact', 'iceperson'],
  emergencyContactNumber: ['emergencycontactnumber', 'emergencycontactno', 'icenumber'],
  internalEmail: ['internalmailid', 'internalemail', 'officialemail'],
  personalEmail: ['referencemailid', 'referenceemail', 'personalemail'],
  bankName: ['bankname'],
  bankAccount: ['bankaccount', 'bankaccountno', 'accountnumber'],
  panNumber: ['pan', 'pannumber', 'panno'],
  ssfNumber: ['ssfnumber', 'ssfno'],
  ssfEligible: ['ssfeligible', 'ssf'],
  monthlySalary: ['salary', 'monthlysalary'],
};

const REQUIRED_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'employeeCode', label: 'HRMS ID' },
  { key: 'name', label: 'Full Name' },
  { key: 'branch', label: 'Branch' },
];

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

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function headerIndexes(header: string[]): Record<string, number> {
  const normalized = header.map(normalizeHeader);
  const indexes: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const at = normalized.findIndex((value) => aliases.includes(value));
    if (at >= 0) indexes[field] = at;
  }
  return indexes;
}

/** A mapping body is `{ "sheet value": "system value" }`; keys are matched loosely. */
function parseMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, mapped] of Object.entries(value as Record<string, unknown>)) {
    if (typeof mapped !== 'string') continue;
    const cleanKey = key.trim().toLowerCase();
    const cleanValue = mapped.trim();
    if (cleanKey && cleanValue) map[cleanKey] = cleanValue;
  }
  return map;
}

function keyedLookup(rows: ImportLookupRow[]): Map<string, ImportLookupRow> {
  const lookup = new Map<string, ImportLookupRow>();
  for (const row of rows) {
    for (const key of [row.id, row.code, row.name]) {
      if (key) lookup.set(String(key).trim().toLowerCase(), row);
    }
  }
  return lookup;
}

function cleanText(
  value: string,
  label: string,
  max: number,
  errors: string[]
): string | null {
  const clean = value.trim();
  if (!clean) return null;
  if (clean.length > max) {
    errors.push(`${label} is longer than ${max} characters.`);
    return null;
  }
  return clean;
}

/** Accepts ISO dates and the sheet's DD/MM/YYYY or DD-MM-YYYY form. */
function importDate(value: string, label: string, errors: string[]): string | null {
  const clean = value.trim();
  if (!clean) return null;
  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(clean);
  const iso = dayFirst
    ? `${dayFirst[3]}-${dayFirst[2].padStart(2, '0')}-${dayFirst[1].padStart(2, '0')}`
    : clean;
  if (!isAccountingDate(iso)) {
    errors.push(`${label} "${clean}" is not a real date (use YYYY-MM-DD).`);
    return null;
  }
  return iso;
}

function importAmount(value: string, label: string, errors: string[]): number | null {
  const clean = value.trim();
  if (!clean) return null;
  const normalized = clean.replace(/,/g, '').replace(/^(npr|rs\.?)/i, '').trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0 || amount > MONEY_MAX) {
    errors.push(`${label} "${clean}" must be a non-negative amount.`);
    return null;
  }
  return roundMoney(amount);
}

function importBoolean(value: string, label: string, errors: string[]): boolean | null {
  const clean = value.trim().toLowerCase();
  if (!clean) return null;
  if (['active', 'true', 'yes', 'y', '1'].includes(clean)) return true;
  if (['inactive', 'false', 'no', 'n', '0'].includes(clean)) return false;
  errors.push(`${label} "${value.trim()}" must be Active or Inactive.`);
  return null;
}

/** POST /api/hr/employees/import — body: { mode, csv, branchMap?, workStationMap? } */
export async function post_hrEmployeeImport(req: any, res: Response): Promise<any> {
  requireDb();

  const rawMode = text(req.body?.mode, 20).toUpperCase();
  if (rawMode && rawMode !== 'DRY_RUN' && rawMode !== 'COMMIT') {
    throw new ApiError(400, 'mode must be DRY_RUN or COMMIT.');
  }
  const mode: ImportMode = rawMode === 'COMMIT' ? 'COMMIT' : 'DRY_RUN';

  const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!csv.trim()) throw new ApiError(400, 'Provide the master-sheet CSV.');
  if (csv.length > IMPORT_MAX_CSV_CHARS) {
    throw new ApiError(413, 'The CSV exceeds 512 KB. Split the sheet and import it in parts.');
  }

  const branchMap = parseMap(req.body?.branchMap);
  const workStationMap = parseMap(req.body?.workStationMap);
  const table = parseCsv(csv);
  if (table.length < 2) {
    throw new ApiError(400, 'The CSV needs a header row and at least one employee row.');
  }
  const dataRows = table.slice(1);
  if (dataRows.length > IMPORT_MAX_ROWS) {
    throw new ApiError(400, `Import at most ${IMPORT_MAX_ROWS} rows at a time.`);
  }

  const columns = headerIndexes(table[0]);
  const missing = REQUIRED_COLUMNS.filter((column) => columns[column.key] === undefined);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `The CSV is missing required column(s): ${missing.map((column) => column.label).join(', ')}.`
    );
  }

  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  const [branchRows, stationRows] = await Promise.all([
    pgPool.query(HR_IMPORT_BRANCHES_SQL),
    pgPool.query(HR_IMPORT_WORK_STATIONS_SQL),
  ]);
  const branchByKey = keyedLookup(branchRows.rows as ImportLookupRow[]);
  const stationByKey = keyedLookup(stationRows.rows as ImportLookupRow[]);

  const raw = (row: string[], field: string): string =>
    columns[field] === undefined ? '' : String(row[columns[field]] ?? '').trim();

  // One bounded lookup gives idempotency without a query per row. Codes are
  // normalized to the same upper-case form the employee API stores.
  const codes = new Set<string>();
  for (const row of dataRows) {
    const code = raw(row, 'employeeCode').toUpperCase();
    if (/^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(code)) codes.add(code);
  }
  const existingRows =
    codes.size > 0
      ? (await pgPool.query(HR_IMPORT_EMPLOYEES_BY_CODE_SQL, [[...codes]])).rows
      : [];
  const existingByCode = new Map<string, any>(
    existingRows.map((row: any) => [String(row.employeeCode), row])
  );

  const seenCodes = new Map<string, number>();
  const rows: ImportRow[] = [];

  dataRows.forEach((row, index) => {
    const rowNumber = index + 2; // header is sheet row 1
    const errors: string[] = [];
    const employeeCode = raw(row, 'employeeCode').toUpperCase();

    if (!employeeCode) {
      errors.push('HRMS ID (employee code) is required.');
    } else if (!/^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(employeeCode)) {
      errors.push(
        `HRMS ID "${employeeCode}" may use only letters, digits, dots, dashes, slashes or underscores (max 50).`
      );
    }

    const nameRaw = raw(row, 'name');
    const name = nameRaw ? cleanText(nameRaw, 'Full Name', 200, errors) : null;
    if (!nameRaw) errors.push('Full Name is required.');

    const branchText = raw(row, 'branch');
    const mappedBranch = branchText
      ? branchMap[branchText.toLowerCase()] || branchText
      : '';
    const branch = mappedBranch ? branchByKey.get(mappedBranch.toLowerCase()) : undefined;
    if (!branchText) {
      errors.push('Branch is required.');
    } else if (!branch) {
      errors.push(
        `Unknown branch "${branchText}". Add the branch or map it to an existing branch.`
      );
    } else if (allowed && !allowed.has(String(branch.id))) {
      errors.push(`Branch "${branchText}" is outside your allowed branches.`);
    }

    const stationText = raw(row, 'workStation');
    const mappedStation = stationText
      ? workStationMap[stationText.toLowerCase()] || stationText
      : '';
    const station = mappedStation ? stationByKey.get(mappedStation.toLowerCase()) : undefined;
    if (stationText && !station) {
      errors.push(
        `Unknown work station "${stationText}". Add it in Org Masters or map it to one.`
      );
    }

    const department = cleanText(raw(row, 'department'), 'Department', 120, errors);
    const designation = cleanText(raw(row, 'designation'), 'Designation', 120, errors);
    const designationCode = cleanText(
      raw(row, 'designationCode'),
      'Designation code',
      30,
      errors
    );
    const employmentType = cleanText(
      raw(row, 'employmentType'),
      'Employment type',
      30,
      errors
    );
    const joiningDateAD = importDate(raw(row, 'joiningDate'), 'Joining date', errors);
    const dateOfBirthAD = importDate(raw(row, 'dateOfBirth'), 'Date of birth', errors);
    const contractExpiryAD = importDate(
      raw(row, 'contractExpiry'),
      'Contract expiry',
      errors
    );
    const address = cleanText(raw(row, 'address'), 'Address', 500, errors);
    const personalContact = cleanText(
      raw(row, 'personalContact'),
      'Personal contact',
      30,
      errors
    );
    const emergencyContactPerson = cleanText(
      raw(row, 'emergencyContactPerson'),
      'Emergency contact person',
      150,
      errors
    );
    const emergencyContactNumber = cleanText(
      raw(row, 'emergencyContactNumber'),
      'Emergency contact number',
      30,
      errors
    );
    const internalEmail = cleanText(
      raw(row, 'internalEmail'),
      'Internal e-mail',
      150,
      errors
    );
    const personalEmail = cleanText(
      raw(row, 'personalEmail'),
      'Personal/reference e-mail',
      150,
      errors
    );
    const bankName = cleanText(raw(row, 'bankName'), 'Bank name', 150, errors);
    const bankAccount = cleanText(raw(row, 'bankAccount'), 'Bank account', 80, errors);
    const panNumber = cleanText(raw(row, 'panNumber'), 'PAN', 50, errors);
    const ssfNumber = cleanText(raw(row, 'ssfNumber'), 'SSF number', 50, errors);
    const monthlySalary = importAmount(raw(row, 'monthlySalary'), 'Monthly salary', errors);
    const isActive = importBoolean(raw(row, 'status'), 'Employment status', errors);
    const ssfEligible = importBoolean(raw(row, 'ssfEligible'), 'SSF eligible', errors);

    if (employeeCode) {
      const firstRow = seenCodes.get(employeeCode);
      if (firstRow) {
        errors.push(
          `Duplicate HRMS ID ${employeeCode} in the file (first seen at sheet row ${firstRow}).`
        );
      } else {
        seenCodes.set(employeeCode, rowNumber);
      }
    }

    const existing = employeeCode ? existingByCode.get(employeeCode) : undefined;
    if (existing && branch && String(existing.branchId) !== String(branch.id)) {
      errors.push(
        `Employee ${employeeCode} already exists in another branch; change its branch in the directory instead.`
      );
    }

    const action: ImportAction = errors.length
      ? 'SKIP'
      : existing
        ? 'UPDATE'
        : 'CREATE';

    rows.push({
      rowNumber,
      employeeCode: employeeCode || null,
      name: name || null,
      action,
      errors,
      record:
        action === 'SKIP' || !branch || !name || !employeeCode
          ? undefined
          : {
              existingId: existing ? String(existing.id) : null,
              employeeCode,
              name,
              branchId: String(branch.id),
              department,
              designation,
              designationCode,
              employmentType,
              joiningDateAD,
              dateOfBirthAD,
              contractExpiryAD,
              workStation: station?.name ? String(station.name) : null,
              address,
              personalContact,
              emergencyContactPerson,
              emergencyContactNumber,
              internalEmail,
              personalEmail,
              panNumber,
              ssfNumber,
              bankName,
              bankAccount,
              monthlySalary,
              ssfEligible,
              isActive,
            },
    });
  });

  const created = rows.filter((row) => row.action === 'CREATE').length;
  const updated = rows.filter((row) => row.action === 'UPDATE').length;
  const skipped = rows.filter((row) => row.action === 'SKIP').length;

  if (mode === 'COMMIT') {
    await withTransaction(async (client) => {
      for (const row of rows) {
        const record = row.record;
        if (!record) continue;
        if (row.action === 'CREATE') {
          await client.query(
            EMPLOYEE_INSERT_SQL,
            employeeInsertParams({
              id: `emp-${crypto.randomUUID()}`,
              employeeCode: record.employeeCode,
              name: record.name,
              branchId: record.branchId,
              userId: null,
              department: record.department,
              designation: record.designation,
              panNumber: record.panNumber,
              ssfNumber: record.ssfNumber,
              bankAccount: record.bankAccount,
              bankName: record.bankName,
              employmentType: record.employmentType,
              joiningDateAD: record.joiningDateAD,
              dateOfBirthAD: record.dateOfBirthAD,
              contractExpiryAD: record.contractExpiryAD,
              separationDateAD: null,
              designationCode: record.designationCode,
              workStation: record.workStation,
              address: record.address,
              personalContact: record.personalContact,
              emergencyContactPerson: record.emergencyContactPerson,
              emergencyContactNumber: record.emergencyContactNumber,
              internalEmail: record.internalEmail,
              personalEmail: record.personalEmail,
              monthlySalary: record.monthlySalary,
              ssfEligible: record.ssfEligible ?? false,
              isActive: record.isActive ?? true,
              createdBy: actorOf(req),
              defaultCostCenterId: null,
            })
          );
        } else if (record.existingId) {
          await client.query(EMPLOYEE_UPDATE_SQL, [
            record.existingId,
            record.name,
            record.department,
            record.designation,
            record.panNumber,
            record.ssfNumber,
            record.bankAccount,
            record.isActive,
            record.bankName,
            record.employmentType,
            record.joiningDateAD,
            record.dateOfBirthAD,
            record.contractExpiryAD,
            record.designationCode,
            record.workStation,
            record.address,
            record.personalContact,
            record.emergencyContactPerson,
            record.emergencyContactNumber,
            record.internalEmail,
            record.personalEmail,
            record.monthlySalary,
            record.ssfEligible,
            actorOf(req),
            false,
            null,
          ]);
        }
      }
      await logAuditEvent(
        req,
        'IMPORT_EMPLOYEES',
        'ACCOUNTING',
        `Imported employee master sheet: ${created} created, ${updated} updated, ${skipped} skipped`,
        undefined,
        client
      );
    });
  }

  return res.json({
    mode,
    totalRows: dataRows.length,
    validRows: created + updated,
    created,
    updated,
    skipped,
    rows: rows.map((row) => ({
      rowNumber: row.rowNumber,
      employeeCode: row.employeeCode,
      name: row.name,
      action: row.action,
      errors: row.errors,
    })),
  });
}
