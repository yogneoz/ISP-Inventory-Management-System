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
import { getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import {
  BRANCH_EXISTS_SQL,
  JOURNAL_FIND_BY_SOURCE_SQL,
} from '../models/accounting.repo';
import {
  EMPLOYEE_BY_CODE_SQL,
  EMPLOYEE_BY_ID_SQL,
  EMPLOYEE_INSERT_SQL,
  EMPLOYEE_LEDGER_ACCOUNT_BALANCES_SQL,
  EMPLOYEE_LEDGER_ENTRIES_SQL,
  EMPLOYEE_UPDATE_SQL,
  EMPLOYEES_BY_IDS_SQL,
  PAYROLL_EMPLOYEE_PERIOD_CONFLICTS_SQL,
  PAYROLL_LINES_BY_RUN_SQL,
  PAYROLL_LINE_INSERT_SQL,
  PAYROLL_RUN_BY_BRANCH_PERIOD_SQL,
  PAYROLL_RUN_BY_ID_SQL,
  PAYROLL_RUN_INSERT_SQL,
  PAYROLL_RUN_LOCK_ROW_SQL,
  PAYROLL_RUN_LOCK_SQL,
  PAYROLL_RUN_SET_JOURNAL_SQL,
  PAYROLL_RUN_SET_PAID_SQL,
  buildEmployeeListQuery,
  buildPayrollRunListQuery,
  employeeInsertParams,
  payrollLineInsertParams,
  payrollRunInsertParams,
} from '../models/payroll.repo';
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

/** A payroll journal is one balanced document; 1 + 5×190 stays under the cap. */
const PAYROLL_EMPLOYEES_PER_RUN_MAX = 190;

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
  });
  return res.json((await pgPool.query(sql, params)).rows);
}

/** POST /api/employees */
export async function post_employee(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'This account is not assigned to any branch.');

  const employeeCode = normalizeEmployeeCode(req.body?.employeeCode);
  const name = text(req.body?.name, 200);
  const branchId = text(req.body?.branchId, 50);
  if (!name) throw new ApiError(400, 'Employee name is required.');
  if (!branchId || branchId === 'ALL') throw new ApiError(400, 'A concrete branch is required for an employee.');
  if (!assertInScope(scope, branchId, res)) return;

  const employee = await withTransaction(async (client) => {
    if (!(await client.query(BRANCH_EXISTS_SQL, [branchId])).rows[0]) {
      throw new ApiError(400, `Branch ${branchId} does not exist.`);
    }
    if ((await client.query(EMPLOYEE_BY_CODE_SQL, [employeeCode])).rows[0]) {
      throw new ApiError(409, `Employee code ${employeeCode} already exists.`);
    }
    const id = `emp-${crypto.randomUUID()}`;
    const created = (
      await client.query(
        EMPLOYEE_INSERT_SQL,
        employeeInsertParams({
          id,
          employeeCode,
          name,
          branchId,
          department: optionalText(req.body?.department, 120),
          designation: optionalText(req.body?.designation, 120),
          panNumber: optionalText(req.body?.panNumber, 50),
          ssfNumber: optionalText(req.body?.ssfNumber, 50),
          bankAccount: optionalText(req.body?.bankAccount, 80),
          isActive: typeof req.body?.isActive === 'boolean' ? req.body.isActive : true,
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
    return created;
  }).catch((err) => {
    if (isUniqueViolation(err)) throw new ApiError(409, `Employee code ${employeeCode} already exists.`);
    throw err;
  });
  return res.status(201).json(employee);
}

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
    const updated = (
      await client.query(EMPLOYEE_UPDATE_SQL, [
        id,
        has('name') ? text(req.body.name, 200) || null : null,
        has('department') ? optionalText(req.body.department, 120) : null,
        has('designation') ? optionalText(req.body.designation, 120) : null,
        has('panNumber') ? optionalText(req.body.panNumber, 50) : null,
        has('ssfNumber') ? optionalText(req.body.ssfNumber, 50) : null,
        has('bankAccount') ? optionalText(req.body.bankAccount, 80) : null,
        typeof req.body?.isActive === 'boolean' ? req.body.isActive : null,
        actorOf(req),
      ])
    ).rows[0];
    await logAuditEvent(
      req,
      'UPDATE_EMPLOYEE',
      'ACCOUNTING',
      `Updated employee ${updated.employeeCode} ${updated.name} (${updated.isActive ? 'active' : 'inactive'})`,
      String(updated.branchId),
      client
    );
    return updated;
  });
  if (!employee) return; // assertInScope already wrote the 403
  return res.json(employee);
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
    employee,
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

/** GET /api/payroll-runs?branchId=&periodKey=&status= */
export async function get_payrollRuns(req: any, res: Response): Promise<any> {
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

  const lines: PayrollPostingLine[] = [];
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

/** POST /api/payroll-runs/:id/pay — clear salary payable for every net line. */
export async function post_payrollPayment(req: any, res: Response): Promise<any> {
  requireDb();
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
    await client.query(PAYROLL_RUN_SET_PAID_SQL, [id, journal.id, dateAD, paymentMethod]);
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
