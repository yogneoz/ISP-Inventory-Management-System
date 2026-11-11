/**
 * Budget transfer service — copy a branch budget into another fiscal year,
 * import/export budget lines as CSV, and apply the same closed-period rules as
 * the normal budget save.
 *
 * Copy maps accounting periods by their ordinal position (the first month of
 * the source year to the first month of the target year), not by period key:
 * fiscal-year codes differ year to year. Source lines whose account is no
 * longer in the chart are reported instead of silently disappearing.
 *
 * CSV import is all-or-nothing. Every bad row is reported with its spreadsheet
 * row number; no lines are written until the whole file validates. Applying
 * the same file (or the same copy) twice is a no-op when the target already
 * holds exactly the mapped lines, so it cannot duplicate or double-count.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  BUDGET_ACCOUNTS_BY_CODES_SQL,
  BUDGET_BRANCH_SQL,
  BUDGET_FISCAL_YEAR_SQL,
  BUDGET_LINES_BY_SCOPE_SQL,
  BUDGET_PERIODS_BY_FISCAL_YEAR_SQL,
  BUDGET_PREVIOUS_FISCAL_YEAR_SQL,
  BUDGET_SOURCE_LINES_SQL,
  type BudgetAccountLookupRow,
  type BudgetBranchRow,
  type BudgetFiscalYearRow,
  type BudgetPeriodOption,
  type BudgetSourceLineRow,
} from '../models/budget.repo';
import { parseCsv } from './csvImport';
import type { AccountingClient } from './accounting.service';
import { readBudget, saveBudget, type BudgetEditorResponse } from './budget.service';

const MAX_AMOUNT = 999_999_999_999.99;
const MAX_CSV_ROWS = 5000;
const MAX_CSV_BYTES = 2_000_000;
const CSV_HEADER = ['account_code', 'period_key', 'amount'] as const;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function replaceRequested(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function periodKeyOf(period: { periodKey: string }): string {
  return String(period.periodKey);
}

async function loadFiscalYear(
  client: AccountingClient,
  fiscalYearId: string
): Promise<BudgetFiscalYearRow> {
  const row = (await client.query(BUDGET_FISCAL_YEAR_SQL, [fiscalYearId]))
    .rows[0] as BudgetFiscalYearRow | undefined;
  if (!row) throw new ApiError(404, 'Fiscal year not found.');
  return row;
}

async function loadTargetScope(
  client: AccountingClient,
  fiscalYearIdRaw: unknown,
  branchIdRaw: unknown
): Promise<{ fiscalYear: BudgetFiscalYearRow; branch: BudgetBranchRow }> {
  const fiscalYearId = text(fiscalYearIdRaw, 50);
  if (!fiscalYearId) throw new ApiError(400, 'A target fiscal year id is required.');
  const fiscalYear = await loadFiscalYear(client, fiscalYearId);

  const branchId = text(branchIdRaw, 50);
  if (!branchId) throw new ApiError(400, 'Choose a branch for the budget.');
  const branch = (await client.query(BUDGET_BRANCH_SQL, [branchId]))
    .rows[0] as BudgetBranchRow | undefined;
  if (!branch) throw new ApiError(400, `Branch ${branchId} does not exist.`);

  return { fiscalYear, branch };
}

async function loadPeriods(
  client: AccountingClient,
  fiscalYear: BudgetFiscalYearRow
): Promise<BudgetPeriodOption[]> {
  return (
    (await client.query(BUDGET_PERIODS_BY_FISCAL_YEAR_SQL, [fiscalYear.id]))
      .rows as any[]
  ).map((row) => ({
    periodKey: String(row.periodKey),
    startDateAD: String(row.startDateAD),
    endDateAD: String(row.endDateAD),
    status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
  }));
}

export type BudgetTransferStatus = 'COPIED' | 'REPLACED' | 'UNCHANGED';

interface WriteDecision<T extends 'COPIED' | 'IMPORTED'> {
  status: T | BudgetTransferStatus;
  budget: BudgetEditorResponse;
  replacedExisting: boolean;
}

async function commitMappedBudget<T extends 'COPIED' | 'IMPORTED'>(
  client: AccountingClient,
  target: BudgetFiscalYearRow,
  branch: BudgetBranchRow,
  periods: BudgetPeriodOption[],
  desired: Map<string, { periodKey: string; accountId: string; amount: number }>,
  replace: boolean,
  actor: string | null,
  createdStatus: T
): Promise<WriteDecision<T> & { createdStatus: T }> {
  const existingRows = (
    await client.query(BUDGET_LINES_BY_SCOPE_SQL, [target.id, branch.id])
  ).rows as any[];
  const closedPeriods = new Set(
    periods.filter((period) => period.status === 'CLOSED').map(periodKeyOf)
  );
  const effective = new Map(desired);
  for (const row of existingRows) {
    const key = `${String(row.periodKey)}|${String(row.accountId)}`;
    if (closedPeriods.has(String(row.periodKey)) && !effective.has(key)) {
      effective.set(key, {
        periodKey: String(row.periodKey),
        accountId: String(row.accountId),
        amount: money(row.amount),
      });
    }
  }

  let identical = existingRows.length === effective.size;
  if (identical) {
    for (const row of existingRows) {
      const key = `${String(row.periodKey)}|${String(row.accountId)}`;
      const line = effective.get(key);
      if (!line || money(line.amount) !== money(row.amount)) {
        identical = false;
        break;
      }
    }
  }

  if (existingRows.length > 0) {
    if (identical) {
      return {
        status: 'UNCHANGED',
        budget: await readBudget(client, target.id, branch.id),
        replacedExisting: false,
        createdStatus,
      };
    }
    if (!replace) {
      throw new ApiError(
        409,
        `Fiscal year ${target.code} already has a budget for ${branch.name}. ` +
          'Enable replace to overwrite its open-period lines, or choose another target year.'
      );
    }
    const budget = await saveBudget(
      client,
      {
        fiscalYearId: target.id,
        branchId: branch.id,
        lines: [...desired.values()],
      },
      actor,
      createdStatus === 'COPIED' ? 'COPY_REPLACE' : 'IMPORT_REPLACE',
      createdStatus === 'COPIED' ? 'Copy with replace' : 'CSV import with replace'
    );
    return { status: 'REPLACED', budget, replacedExisting: true, createdStatus };
  }

  const budget = await saveBudget(
    client,
    {
      fiscalYearId: target.id,
      branchId: branch.id,
      lines: [...desired.values()],
    },
    actor,
    createdStatus === 'COPIED' ? 'COPY' : 'IMPORT',
    createdStatus === 'COPIED' ? 'Copied budget' : 'CSV import'
  );
  return { status: createdStatus, budget, replacedExisting: false, createdStatus };
}

export interface BudgetPeriodMapping {
  sourcePeriodKey: string;
  targetPeriodKey: string;
  sourceStartDateAD: string;
  targetStartDateAD: string;
}

export interface BudgetSkippedAccount {
  accountId: string;
  code: string | null;
  name: string | null;
  reason: 'MISSING_FROM_CHART' | 'NOT_PROFIT_AND_LOSS';
}

export interface BudgetCopyInput {
  sourceFiscalYearId?: unknown;
  targetFiscalYearId?: unknown;
  branchId?: unknown;
  replace?: unknown;
}

export interface BudgetCopyResponse {
  status: BudgetTransferStatus;
  sourceFiscalYearId: string;
  sourceFiscalYearCode: string;
  targetFiscalYearId: string;
  targetFiscalYearCode: string;
  branchId: string;
  branchName: string;
  sourceLines: number;
  mappedLines: number;
  copiedLines: number;
  skippedAccounts: BudgetSkippedAccount[];
  periodMapping: BudgetPeriodMapping[];
  unmappedPeriods: string[];
  replacedExisting: boolean;
  budget: BudgetEditorResponse;
}

/** Copy a source-year budget into a target year, optionally replacing it. */
export async function copyBudget(
  client: AccountingClient,
  input: BudgetCopyInput,
  actor: string | null
): Promise<BudgetCopyResponse> {
  const { fiscalYear: target, branch } = await loadTargetScope(
    client,
    input.targetFiscalYearId,
    input.branchId
  );
  const targetPeriods = await loadPeriods(client, target);
  if (targetPeriods.length === 0) {
    throw new ApiError(
      409,
      `Fiscal year ${target.code} has no accounting periods yet. Open the fiscal year first.`
    );
  }

  const sourceFiscalYearId = text(input.sourceFiscalYearId, 50);
  let source: BudgetFiscalYearRow | null = null;
  if (sourceFiscalYearId) {
    source = await loadFiscalYear(client, sourceFiscalYearId);
  } else {
    source = ((await client.query(BUDGET_PREVIOUS_FISCAL_YEAR_SQL, [
      branch.id,
      target.startDateAD,
    ])).rows[0] || null) as BudgetFiscalYearRow | null;
    if (!source) {
      throw new ApiError(
        404,
        `No earlier budget exists for ${branch.name} to copy from.`
      );
    }
  }
  if (source.id === target.id) {
    throw new ApiError(400, 'The source and target fiscal years must be different.');
  }

  const sourcePeriods = await loadPeriods(client, source);
  const sourceLines = (
    await client.query(BUDGET_SOURCE_LINES_SQL, [source.id, branch.id])
  ).rows as BudgetSourceLineRow[];
  if (sourceLines.length === 0) {
    throw new ApiError(
      404,
      `No budget lines exist for ${branch.name} in fiscal year ${source.code}.`
    );
  }

  const periodMapping: BudgetPeriodMapping[] = [];
  const targetPeriodBySourceKey = new Map<string, BudgetPeriodOption>();
  const unmappedPeriods: string[] = [];
  sourcePeriods.forEach((sourcePeriod, index) => {
    const targetPeriod = targetPeriods[index];
    if (!targetPeriod) {
      unmappedPeriods.push(sourcePeriod.periodKey);
      return;
    }
    targetPeriodBySourceKey.set(sourcePeriod.periodKey, targetPeriod);
    periodMapping.push({
      sourcePeriodKey: sourcePeriod.periodKey,
      targetPeriodKey: targetPeriod.periodKey,
      sourceStartDateAD: sourcePeriod.startDateAD,
      targetStartDateAD: targetPeriod.startDateAD,
    });
  });

  const skipped = new Map<string, BudgetSkippedAccount>();
  const desired = new Map<
    string,
    { periodKey: string; accountId: string; amount: number }
  >();
  for (const line of sourceLines) {
    const targetPeriod = targetPeriodBySourceKey.get(line.periodKey);
    if (!targetPeriod) continue;
    const reason = !line.code
      ? 'MISSING_FROM_CHART'
      : line.accountType !== 'INCOME' && line.accountType !== 'EXPENSE'
        ? 'NOT_PROFIT_AND_LOSS'
        : null;
    if (reason) {
      skipped.set(line.accountId, {
        accountId: line.accountId,
        code: line.code,
        name: line.name,
        reason,
      });
      continue;
    }
    desired.set(`${targetPeriod.periodKey}|${line.accountId}`, {
      periodKey: targetPeriod.periodKey,
      accountId: line.accountId,
      amount: money(line.amount),
    });
  }
  if (desired.size === 0) {
    throw new ApiError(
      409,
      `No budget lines from fiscal year ${source.code} can be mapped to ${target.code}.`
    );
  }

  const decision = await commitMappedBudget(
    client,
    target,
    branch,
    targetPeriods,
    desired,
    replaceRequested(input.replace),
    actor,
    'COPIED'
  );

  return {
    status: decision.status,
    sourceFiscalYearId: source.id,
    sourceFiscalYearCode: source.code,
    targetFiscalYearId: target.id,
    targetFiscalYearCode: target.code,
    branchId: branch.id,
    branchName: branch.name,
    sourceLines: sourceLines.length,
    mappedLines: desired.size,
    copiedLines: decision.status === 'UNCHANGED' ? 0 : desired.size,
    skippedAccounts: [...skipped.values()],
    periodMapping,
    unmappedPeriods,
    replacedExisting: decision.replacedExisting,
    budget: decision.budget,
  };
}

export interface BudgetImportError {
  row: number;
  message: string;
}

export interface BudgetImportInput {
  fiscalYearId?: unknown;
  branchId?: unknown;
  csv?: unknown;
  replace?: unknown;
}

export interface BudgetImportResponse {
  status: 'IMPORTED' | 'REPLACED' | 'UNCHANGED' | 'REFUSED';
  httpStatus: number;
  importedLines: number;
  replacedExisting: boolean;
  errors: BudgetImportError[];
  budget: BudgetEditorResponse | null;
}

function refusedImport(
  httpStatus: number,
  errors: BudgetImportError[]
): BudgetImportResponse {
  return {
    status: 'REFUSED',
    httpStatus,
    importedLines: 0,
    replacedExisting: false,
    errors,
    budget: null,
  };
}

/** All-or-nothing CSV import. Every row is validated before any write. */
export async function importBudgetCsv(
  client: AccountingClient,
  input: BudgetImportInput,
  actor: string | null
): Promise<BudgetImportResponse> {
  const { fiscalYear: target, branch } = await loadTargetScope(
    client,
    input.fiscalYearId,
    input.branchId
  );
  const periods = await loadPeriods(client, target);
  if (periods.length === 0) {
    return refusedImport(409, [
      {
        row: 0,
        message: `Fiscal year ${target.code} has no accounting periods yet. Open the fiscal year first.`,
      },
    ]);
  }

  if (typeof input.csv !== 'string' || input.csv.trim() === '') {
    return refusedImport(400, [{ row: 0, message: 'A CSV file is required.' }]);
  }
  if (input.csv.length > MAX_CSV_BYTES) {
    return refusedImport(400, [
      { row: 0, message: 'The CSV file is too large. The limit is 2 MB.' },
    ]);
  }

  const rows = parseCsv(input.csv);
  if (rows.length === 0) {
    return refusedImport(400, [{ row: 1, message: 'The CSV file is empty.' }]);
  }
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  if (
    header.length !== CSV_HEADER.length ||
    !CSV_HEADER.every((column) => header.includes(column))
  ) {
    return refusedImport(400, [
      {
        row: 1,
        message: `The header must be exactly ${CSV_HEADER.join(',')}.`,
      },
    ]);
  }
  const accountIndex = header.indexOf('account_code');
  const periodIndex = header.indexOf('period_key');
  const amountIndex = header.indexOf('amount');
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    return refusedImport(400, [
      { row: 1, message: 'The CSV file has no data rows.' },
    ]);
  }
  if (dataRows.length > MAX_CSV_ROWS) {
    return refusedImport(400, [
      {
        row: 1,
        message: `A budget import can hold at most ${MAX_CSV_ROWS} data rows.`,
      },
    ]);
  }

  const accountCodes = [
    ...new Set(
      dataRows
        .map((row) => (row[accountIndex] || '').trim())
        .filter(Boolean)
    ),
  ];
  const accountRows = accountCodes.length
    ? ((await client.query(BUDGET_ACCOUNTS_BY_CODES_SQL, [accountCodes])).rows as BudgetAccountLookupRow[])
    : [];
  const accountByCode = new Map(
    accountRows.map((account) => [String(account.code), account])
  );
  const periodByKey = new Map(periods.map((period) => [period.periodKey, period]));

  const errors: BudgetImportError[] = [];
  const seen = new Map<string, number>();
  const parsed: Array<{
    row: number;
    periodKey: string;
    accountId: string;
    amount: number;
  }> = [];

  dataRows.forEach((cells, index) => {
    const row = index + 2;
    if (cells.length !== header.length) {
      errors.push({
        row,
        message: `Expected ${header.length} columns but found ${cells.length}.`,
      });
      return;
    }
    const accountCode = (cells[accountIndex] || '').trim();
    const periodKey = (cells[periodIndex] || '').trim();
    const amountRaw = (cells[amountIndex] || '').trim();
    let valid = true;

    const account = accountCode ? accountByCode.get(accountCode) : undefined;
    if (!accountCode) {
      errors.push({ row, message: 'Account code is required.' });
      valid = false;
    } else if (!account) {
      errors.push({
        row,
        message: `Unknown chart account "${accountCode}".`,
      });
      valid = false;
    } else if (!account.isActive) {
      errors.push({
        row,
        message: `Chart account ${accountCode} is inactive.`,
      });
      valid = false;
    } else if (account.accountType !== 'INCOME' && account.accountType !== 'EXPENSE') {
      errors.push({
        row,
        message: `Chart account ${accountCode} is not a profit-and-loss account.`,
      });
      valid = false;
    }

    const period = periodKey ? periodByKey.get(periodKey) : undefined;
    if (!periodKey) {
      errors.push({ row, message: 'Period key is required.' });
      valid = false;
    } else if (!period) {
      errors.push({
        row,
        message: `Period "${periodKey}" does not belong to fiscal year ${target.code}.`,
      });
      valid = false;
    }

    const parsedAmount =
      amountRaw === '' ? NaN : Number(amountRaw);
    if (!amountRaw || !Number.isFinite(parsedAmount)) {
      errors.push({
        row,
        message: `Amount "${amountRaw}" is not numeric.`,
      });
      valid = false;
    } else if (parsedAmount < 0) {
      errors.push({
        row,
        message: `Amount "${amountRaw}" cannot be negative.`,
      });
      valid = false;
    } else if (roundMoney(parsedAmount) > MAX_AMOUNT) {
      errors.push({
        row,
        message: `Amount "${amountRaw}" is too large.`,
      });
      valid = false;
    }

    if (!valid || !account || !period) return;
    const key = `${period.periodKey}|${account.id}`;
    const firstRow = seen.get(key);
    if (firstRow) {
      errors.push({
        row,
        message: `Duplicate account+period; row ${firstRow} already used ${accountCode} for ${periodKey}.`,
      });
      return;
    }
    seen.set(key, row);
    parsed.push({
      row,
      periodKey: period.periodKey,
      accountId: String(account.id),
      amount: roundMoney(parsedAmount),
    });
  });

  if (errors.length > 0) {
    return refusedImport(400, errors);
  }

  const existingRows = (
    await client.query(BUDGET_LINES_BY_SCOPE_SQL, [target.id, branch.id])
  ).rows as any[];
  const existingByKey = new Map(
    existingRows.map((row) => [
      `${String(row.periodKey)}|${String(row.accountId)}`,
      row,
    ])
  );
  for (const line of parsed) {
    const period = periodByKey.get(line.periodKey);
    if (period?.status !== 'CLOSED') continue;
    const current = existingByKey.get(`${line.periodKey}|${line.accountId}`);
    if (!current || money(current.amount) !== line.amount) {
      errors.push({
        row: line.row,
        message: `Accounting period ${line.periodKey} is closed. Reopen it before importing this line.`,
      });
    }
  }
  if (errors.length > 0) {
    return refusedImport(409, errors);
  }

  const desired = new Map(
    parsed.map((line) => [
      `${line.periodKey}|${line.accountId}`,
      {
        periodKey: line.periodKey,
        accountId: line.accountId,
        amount: line.amount,
      },
    ])
  );

  try {
    const decision = await commitMappedBudget(
      client,
      target,
      branch,
      periods,
      desired,
      replaceRequested(input.replace),
      actor,
      'IMPORTED'
    );
    return {
      status:
        decision.status === 'COPIED'
          ? 'IMPORTED'
          : decision.status === 'REPLACED'
            ? 'REPLACED'
            : 'UNCHANGED',
      httpStatus: 200,
      importedLines: decision.status === 'UNCHANGED' ? 0 : desired.size,
      replacedExisting: decision.replacedExisting,
      errors: [],
      budget: decision.budget,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      return refusedImport(409, [{ row: 0, message: err.message }]);
    }
    throw err;
  }
}

export interface BudgetCsvExport {
  filename: string;
  csv: string;
}

function csvCell(value: string | number): string {
  const raw = String(value);
  if (!/[",\r\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'budget';
}

/** Export exactly the column set the importer accepts, sorted for diffing. */
export async function exportBudgetCsv(
  client: AccountingClient,
  fiscalYearIdRaw: unknown,
  branchIdRaw: unknown
): Promise<BudgetCsvExport> {
  const { fiscalYear, branch } = await loadTargetScope(
    client,
    fiscalYearIdRaw,
    branchIdRaw
  );
  const budget = await readBudget(client, fiscalYear.id, branch.id);
  const lines = [...budget.lines].sort(
    (left, right) =>
      left.periodKey.localeCompare(right.periodKey) ||
      (left.code || '').localeCompare(right.code || '')
  );
  const csv = [
    CSV_HEADER.join(','),
    ...lines.map((line) =>
      [line.code || line.accountId, line.periodKey, line.amount.toFixed(2)]
        .map(csvCell)
        .join(',')
    ),
  ].join('\r\n') + '\r\n';
  return {
    filename: `budget-${safeFilenamePart(budget.fiscalYearCode)}-${safeFilenamePart(budget.branchName)}.csv`,
    csv,
  };
}
