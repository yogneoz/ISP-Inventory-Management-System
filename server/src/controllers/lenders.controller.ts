/**
 * Lender master, loan register and lender statement.
 *
 * Lenders are not suppliers: they are a LENDER subledger party under the
 * LOAN_PAYABLE control account. The master owns identity and agreement terms;
 * every statement figure is read from posted `gl_subledger_entries`, so the
 * screen cannot disagree with the ledger.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { allowedBranchScope } from '../middleware/branchScope';
import { resolveBranchScope } from './accounting.controller';
import { logAuditEvent } from '../services/audit.service';
import { postJournal } from '../services/accounting.service';
import { ACCOUNT_BY_ID_SQL } from '../models/accounting.repo';
import { bsDateOrThrow } from '../utils/bsDate';
import { booleanFlag } from '../utils/booleanFlag';
import { issueNextDocNumber } from '../utils/docNumber';
import { roundMoney } from '../utils/money';
import {
  parseTdsExemptionReason,
  tdsExemptionRequiresReference,
} from '../utils/tdsExemption';
import { ACCOUNTING_MASTER_BRANCH_EXISTS_SQL } from '../models/accountingMasters.repo';
import {
  LENDER_BOOK_ACCOUNT_UPDATE_SQL,
  LENDER_BOOK_BY_CODE_SQL,
  LENDER_BOOK_BY_PARTY_SQL,
  LENDER_BOOK_DELETE_SQL,
  LENDER_BOOK_INSERT_SQL,
  LENDER_BOOK_UPDATE_SQL,
  LENDER_BY_CODE_SQL,
  LENDER_BY_ID_SQL,
  LENDER_CONTROL_GL_BALANCE_SQL,
  LENDER_CONTROL_SUBLEDGER_BALANCE_SQL,
  LENDER_DELETE_SQL,
  LENDER_INSERT_SQL,
  LENDER_INTEREST_ACCOUNT_SQL,
  LENDER_INTEREST_PAYABLE_ACCOUNT_SQL,
  LENDER_LEDGER_COUNT_SQL,
  LENDER_LIST_SQL,
  LENDER_LOAN_COUNT_SQL,
  LENDER_OPEN_LOAN_COUNT_SQL,
  LENDER_PARTY_OPTIONS_SQL,
  LENDER_PARTY_BALANCE_SQL,
  LENDER_REPAYMENT_LEDGER_TOTALS_SQL,
  LENDER_STATEMENT_ENTRIES_SQL,
  LENDER_STATEMENT_OPENING_SQL,
  LENDER_TDS_ACCOUNT_SQL,
  LENDER_TDS_WORKLIST_SQL,
  LENDER_UNASSIGNED_BALANCE_SQL,
  LENDER_UPDATE_SQL,
  LOAN_ACCRUAL_BY_ID_SQL,
  LOAN_ACCRUAL_COUNT_SQL,
  LOAN_ACCRUAL_INSERT_SQL,
  LOAN_ACCRUAL_LAST_SQL,
  LOAN_ACCRUAL_LIST_SQL,
  LOAN_ACCRUAL_OVERLAP_SQL,
  LOAN_ACCRUAL_SUM_SQL,
  LOAN_BY_ID_SQL,
  LOAN_INSERT_SQL,
  LOAN_LIST_SQL,
  LOAN_INSTALLMENT_DELETE_SQL,
  LOAN_INSTALLMENT_INSERT_SQL,
  LOAN_INSTALLMENT_LIST_SQL,
  LOAN_INSTALLMENT_LOCK_SQL,
  LOAN_INSTALLMENT_UPDATE_SQL,
  LOAN_INTEREST_PAYABLE_APPLIED_SQL,
  LOAN_LOCK_SQL,
  LOAN_PAYABLE_ACCOUNT_BY_ID_SQL,
  LOAN_PAYABLE_ACCOUNT_SQL,
  LOAN_STATUS_UPDATE_SQL,
  LOAN_TRANSACTION_BY_ID_SQL,
  LOAN_TRANSACTION_INSERT_SQL,
  LOAN_TRANSACTION_TDS_EVIDENCE_ROW_SQL,
  LOAN_TRANSACTION_TDS_EVIDENCE_UPDATE_SQL,
  LOAN_TRANSACTION_LIST_SQL,
  LOAN_REPAYMENT_COUNT_SQL,
  LOAN_TRANSACTION_SUM_SQL,
  LOAN_UPDATE_SQL,
  LENDER_TDS_REPORT_SQL,
} from '../models/lender.repo';

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
const LENDER_TYPES = new Set(['OWNER', 'RELATED_PARTY', 'OTHER']);
const REPAYMENT_FREQUENCIES = new Set(['LUMP_SUM', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL']);
const LOAN_STATUSES = new Set(['OPEN', 'CLOSED', 'CANCELLED']);
const SECURITY_TYPES = new Set(['UNSECURED', 'SECURED']);

interface LenderRow {
  id: string;
  code: string;
  name: string;
  lenderType: string;
  panNumber: string | null;
  registrationNumber: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  defaultCashAccountId: string | null;
  defaultInterestAccountId: string | null;
  defaultTdsAccountId: string | null;
  defaultLoanAccountId: string | null;
  active: boolean;
  bookId: string | null;
  bookCode: string | null;
  loanCount?: number;
  openPrincipal?: number;
  bookBalance?: number;
}

interface LoanRow {
  id: string;
  loanNumber: string;
  lenderId: string;
  branchId: string;
  principal: number;
  interestRate: number;
  startDateAD: string;
  maturityDateAD: string | null;
  repaymentFrequency: string;
  installmentAmount: number | null;
  securityType: string;
  status: string;
  agreementReference: string | null;
  notes: string | null;
  tdsApplicable: boolean;
  tdsExemptionReason: string | null;
  tdsExemptionReference: string | null;
  fundedPrincipal?: number;
  repaidPrincipal?: number;
  interestPaid?: number;
  tdsWithheld?: number;
  interestAccrued?: number;
  lastTransactionDateAD?: string | null;
  lastAccrualDateAD?: string | null;
  installmentCount?: number;
  nextDueDateAD?: string | null;
  nextDueAmount?: number | null;
  overdueInstallments?: number;
  scheduledPrincipal?: number;
  scheduledPrincipalPaid?: number;
  scheduledInterest?: number;
  scheduledInterestPaid?: number;
}

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function integer(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A PATCH may deliberately clear a nullable field; null must not fall back. */
function pick(body: Record<string, any>, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback;
}

function dateOnly(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, `${label} must be a valid calendar date (YYYY-MM-DD).`);
  }
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ApiError(400, `${label} must be a valid calendar date (YYYY-MM-DD).`);
  }
  return date;
}

function optionalDate(value: unknown, label: string): string | null {
  return text(value, 10) ? dateOnly(value, label) : null;
}

function isoDateOrNull(value: unknown): string | null {
  return text(value, 10) ? dateOnly(value, 'Date') : null;
}

function requireDb(): void {
  if (!getPgConnected()) {
    throw new ApiError(503, 'The lender register requires the accounting database.');
  }
}

function actorOf(req: any): string | null {
  return req?.user?.email || req?.user?.name || null;
}

function todayAD(): string {
  return new Date().toISOString().slice(0, 10);
}

function loanResponse(row: any) {
  if (!row) return row;
  const fundedPrincipal = money(row.fundedPrincipal);
  const repaidPrincipal = money(row.repaidPrincipal);
  const outstandingPrincipal = money(Math.max(0, fundedPrincipal - repaidPrincipal));
  const overdueInstallments = integer(row.overdueInstallments);
  const hasSchedule = integer(row.installmentCount) > 0;
  return {
    ...row,
    principal: money(row.principal),
    interestRate: Number(row.interestRate),
    installmentAmount: row.installmentAmount === null ? null : money(row.installmentAmount),
    fundedPrincipal,
    repaidPrincipal,
    outstandingPrincipal,
    interestPaid: money(row.interestPaid),
    tdsWithheld: money(row.tdsWithheld),
    interestAccrued: money(row.interestAccrued),
    scheduledPrincipal: money(row.scheduledPrincipal),
    scheduledPrincipalPaid: money(row.scheduledPrincipalPaid),
    scheduledInterest: money(row.scheduledInterest),
    scheduledInterestPaid: money(row.scheduledInterestPaid),
    nextDueAmount: row.nextDueAmount === null || row.nextDueAmount === undefined
      ? null
      : money(row.nextDueAmount),
    overdue:
      row.status === 'OPEN' &&
      (overdueInstallments > 0 ||
        (!hasSchedule &&
          Boolean(row.maturityDateAD) &&
          String(row.maturityDateAD).slice(0, 10) < todayAD() &&
          outstandingPrincipal > 0.004)),
  };
}

function loanTransactionResponse(row: any) {
  if (!row) return row;
  return {
    ...row,
    principalAmount: money(row.principalAmount),
    interestAmount: money(row.interestAmount),
    tdsAmount: money(row.tdsAmount),
    interestPayableApplied: money(row.interestPayableApplied),
    cashAmount: money(row.cashAmount),
  };
}

function loanInstallmentResponse(row: any) {
  if (!row) return row;
  const principalDue = money(row.principalDue);
  const interestDue = money(row.interestDue);
  const principalPaid = money(row.principalPaid);
  const interestPaid = money(row.interestPaid);
  const outstanding = money(
    Math.max(0, principalDue - principalPaid) + Math.max(0, interestDue - interestPaid)
  );
  const overdue = outstanding > 0.004 && String(row.dueDateAD).slice(0, 10) < todayAD();
  return {
    ...row,
    principalDue,
    interestDue,
    principalPaid,
    interestPaid,
    tdsPaid: money(row.tdsPaid),
    outstanding,
    overdue,
    status:
      outstanding <= 0.004
        ? 'PAID'
        : principalPaid + interestPaid > 0.004
          ? 'PARTIAL'
          : overdue
            ? 'OVERDUE'
            : 'PENDING',
  };
}

function loanAccrualResponse(row: any) {
  if (!row) return row;
  return {
    ...row,
    principalBase: money(row.principalBase),
    annualRate: Number(row.annualRate),
    days: integer(row.days),
    interestAmount: money(row.interestAmount),
  };
}

const FREQUENCY_MONTHS: Record<string, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  HALF_YEARLY: 6,
  ANNUAL: 12,
};

function addMonthsAD(dateAD: string, months: number): string {
  const [year, month, day] = dateAD.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function monthSpan(startAD: string, endAD: string): number {
  const [sy, sm, sd] = startAD.split('-').map(Number);
  const [ey, em, ed] = endAD.split('-').map(Number);
  let months = (ey - sy) * 12 + (em - sm);
  if (ed < sd) months -= 1;
  return Math.max(0, months);
}

function inclusiveDays(fromAD: string, toAD: string): number {
  const from = Date.parse(`${fromAD}T00:00:00Z`);
  const to = Date.parse(`${toAD}T00:00:00Z`);
  return Math.floor((to - from) / 86_400_000) + 1;
}

/**
 * Builds the contractual due dates. Principal is split by the agreed
 * installment amount when one exists, otherwise evenly; interest is the
 * scheduled period interest on the reducing principal. Actual TDS is recorded
 * by repayments, not planned here.
 */
function buildScheduleRows(loan: LoanRow): Array<{
  sequence: number;
  dueDateAD: string;
  principalDue: number;
  interestDue: number;
}> {
  const principal = money(loan.principal);
  if (principal <= 0) return [];
  const months = FREQUENCY_MONTHS[loan.repaymentFrequency] || 0;
  const amountDue = money(loan.installmentAmount || 0);
  let count = 1;
  if (months > 0) {
    if (amountDue > 0) count = Math.max(1, Math.ceil(principal / amountDue));
    else if (loan.maturityDateAD) count = Math.max(1, Math.ceil(monthSpan(loan.startDateAD, loan.maturityDateAD) / months));
    else count = 1;
  }
  if (loan.maturityDateAD && months > 0) {
    count = Math.min(
      count,
      Math.max(1, Math.ceil(monthSpan(loan.startDateAD, loan.maturityDateAD) / months))
    );
  }
  count = Math.min(Math.max(count, 1), 120);

  const rows: Array<{ sequence: number; dueDateAD: string; principalDue: number; interestDue: number }> = [];
  let remaining = principal;
  let outstanding = principal;
  for (let index = 1; index <= count; index += 1) {
    let dueDateAD: string;
    if (months > 0) {
      dueDateAD = addMonthsAD(loan.startDateAD, index * months);
      if (loan.maturityDateAD && dueDateAD > loan.maturityDateAD) dueDateAD = loan.maturityDateAD;
    } else {
      dueDateAD = loan.maturityDateAD || loan.startDateAD;
    }
    const planned = index === count ? remaining : amountDue > 0 ? Math.min(amountDue, remaining) : money(principal / count);
    const principalDue = money(Math.min(remaining, Math.max(0, planned)));
    remaining = money(remaining - principalDue);
    const periodMonths = months > 0 ? months : Math.max(1, monthSpan(loan.startDateAD, dueDateAD));
    const interestDue = money((outstanding * (Number(loan.interestRate) || 0) * periodMonths) / 1200);
    outstanding = money(Math.max(0, outstanding - principalDue));
    rows.push({ sequence: index, dueDateAD, principalDue, interestDue });
  }
  return rows;
}

async function writeLoanSchedule(client: any, loan: LoanRow): Promise<void> {
  await client.query(LOAN_INSTALLMENT_DELETE_SQL, [loan.id]);
  for (const row of buildScheduleRows(loan)) {
    const dueDateBS = await bsDateOrThrow(row.dueDateAD, client);
    await client.query(LOAN_INSTALLMENT_INSERT_SQL, [
      `lin-${crypto.randomUUID()}`,
      loan.id,
      row.sequence,
      row.dueDateAD,
      dueDateBS,
      row.principalDue,
      row.interestDue,
    ]);
  }
}

/** Apply a repayment FIFO to the open installments. */
async function allocateRepayment(
  client: any,
  loanId: string,
  principal: number,
  interest: number,
  tds: number
): Promise<void> {
  const rows = (await client.query(LOAN_INSTALLMENT_LOCK_SQL, [loanId])).rows as any[];
  let remainingPrincipal = money(principal);
  let remainingInterest = money(interest);
  let remainingTds = money(tds);
  for (const row of rows) {
    if (remainingPrincipal <= 0.004 && remainingInterest <= 0.004 && remainingTds <= 0.004) break;
    const principalApplied = money(
      Math.min(remainingPrincipal, money(money(row.principalDue) - money(row.principalPaid)))
    );
    const interestApplied = money(
      Math.min(remainingInterest, money(money(row.interestDue) - money(row.interestPaid)))
    );
    const tdsApplied = money(
      Math.min(
        remainingTds,
        money(money(row.interestDue) - money(row.tdsPaid)),
        money(row.interestDue) - money(row.interestPaid) + interestApplied
      )
    );
    if (principalApplied <= 0 && interestApplied <= 0 && tdsApplied <= 0) continue;
    await client.query(LOAN_INSTALLMENT_UPDATE_SQL, [
      row.id,
      money(money(row.principalPaid) + principalApplied),
      money(money(row.interestPaid) + interestApplied),
      money(money(row.tdsPaid) + tdsApplied),
    ]);
    remainingPrincipal = money(remainingPrincipal - principalApplied);
    remainingInterest = money(remainingInterest - interestApplied);
    remainingTds = money(remainingTds - tdsApplied);
  }
}

async function accruedInterestAvailable(client: any, loanId: string): Promise<number> {
  const accrued = money((await client.query(LOAN_ACCRUAL_SUM_SQL, [loanId])).rows[0]?.accrued);
  const applied = money(
    (await client.query(LOAN_INTEREST_PAYABLE_APPLIED_SQL, [loanId])).rows[0]?.applied
  );
  return money(Math.max(0, accrued - applied));
}

function assertBranchAllowed(req: any, branchId: string | null): void {
  const allowed = allowedBranchScope(req.user);
  if (allowed && branchId && !allowed.has(branchId)) {
    throw new ApiError(403, 'Forbidden: this account is not authorized for the requested branch.');
  }
}

async function branchExists(branchId: string): Promise<boolean> {
  return Boolean((await pgPool.query(ACCOUNTING_MASTER_BRANCH_EXISTS_SQL, [branchId])).rows[0]);
}

async function loadAccount(client: any, id: string): Promise<any | null> {
  return (await client.query(ACCOUNT_BY_ID_SQL, [id])).rows[0] || null;
}

function assertUsableDefaultAccount(
  account: any,
  label: string,
  predicate: (account: any) => boolean,
  expectation: string
): void {
  if (!account || !account.isActive) {
    throw new ApiError(400, `${label} must be an active chart account.`);
  }
  if (!predicate(account)) {
    throw new ApiError(400, `${label} must be ${expectation}.`);
  }
}

/** Validate the optional lender defaults so a later document cannot inherit a bad account. */
async function validateLenderAccounts(lender: {
  defaultCashAccountId: string | null;
  defaultInterestAccountId: string | null;
  defaultTdsAccountId: string | null;
  defaultLoanAccountId: string | null;
}): Promise<void> {
  if (lender.defaultCashAccountId) {
    const account = await loadAccount(pgPool, lender.defaultCashAccountId);
    assertUsableDefaultAccount(
      account,
      'Default cash/bank account',
      (row) => ['CASH', 'BANK', 'WALLET'].includes(String(row.accountKind)),
      'a cash, bank or wallet ledger'
    );
  }
  if (lender.defaultInterestAccountId) {
    const account = await loadAccount(pgPool, lender.defaultInterestAccountId);
    assertUsableDefaultAccount(
      account,
      'Default interest account',
      (row) => row.accountType === 'EXPENSE' && !row.isControl,
      'an active non-control expense account'
    );
  }
  if (lender.defaultTdsAccountId) {
    const account = await loadAccount(pgPool, lender.defaultTdsAccountId);
    assertUsableDefaultAccount(
      account,
      'Default TDS account',
      (row) => row.accountType === 'LIABILITY' && !row.isControl,
      'an active non-control liability account'
    );
  }
  if (lender.defaultLoanAccountId) {
    const account = await loadAccount(pgPool, lender.defaultLoanAccountId);
    assertUsableDefaultAccount(
      account,
      'Default Loan Payable account',
      (row) =>
        row.isControl &&
        row.postingRole === 'LOAN_PAYABLE' &&
        row.subledgerType === 'LENDER',
      'an active LENDER control with the LOAN_PAYABLE posting role'
    );
  }
}

function lenderCode(value: unknown): string {
  const code = text(value, 30).toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new ApiError(400, 'Lender code is required: 1–30 letters, digits, hyphens or underscores.');
  }
  return code;
}

function parseLender(body: Record<string, any>, existing?: LenderRow) {
  const code = existing?.code || lenderCode(body.code);
  const name = text(body.name ?? existing?.name, 150);
  if (!name) throw new ApiError(400, 'Lender name is required.');
  const lenderType = text(body.lenderType ?? existing?.lenderType ?? 'OTHER', 20).toUpperCase();
  if (!LENDER_TYPES.has(lenderType)) {
    throw new ApiError(400, 'Lender type must be OWNER, RELATED_PARTY or OTHER.');
  }
  return {
    id: existing?.id || `lnd-${crypto.randomUUID()}`,
    code,
    name,
    lenderType,
    panNumber: text(pick(body, 'panNumber', existing?.panNumber), 50) || null,
    registrationNumber:
      text(pick(body, 'registrationNumber', existing?.registrationNumber), 50) || null,
    phone: text(pick(body, 'phone', existing?.phone), 50) || null,
    address: text(pick(body, 'address', existing?.address), 1000) || null,
    notes: text(pick(body, 'notes', existing?.notes), 1000) || null,
    defaultCashAccountId:
      text(pick(body, 'defaultCashAccountId', existing?.defaultCashAccountId), 50) || null,
    defaultInterestAccountId:
      text(pick(body, 'defaultInterestAccountId', existing?.defaultInterestAccountId), 50) ||
      null,
    defaultTdsAccountId:
      text(pick(body, 'defaultTdsAccountId', existing?.defaultTdsAccountId), 50) || null,
    defaultLoanAccountId:
      text(pick(body, 'defaultLoanAccountId', existing?.defaultLoanAccountId), 50) || null,
    active: booleanFlag(body.active, existing?.active ?? true),
  };
}

function parseLoan(body: Record<string, any>, existing?: LoanRow) {
  const principal = roundMoney(Number(body.principal ?? existing?.principal));
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new ApiError(400, 'Loan principal must be a positive amount.');
  }
  const interestRate = Number(body.interestRate ?? existing?.interestRate ?? 0);
  if (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 100) {
    throw new ApiError(400, 'Interest rate must be between 0 and 100 percent.');
  }
  const startDateAD = dateOnly(body.startDateAD ?? existing?.startDateAD, 'Loan start date');
  const maturityDateAD = optionalDate(
    pick(body, 'maturityDateAD', existing?.maturityDateAD),
    'Loan maturity date'
  );
  if (maturityDateAD && maturityDateAD < startDateAD) {
    throw new ApiError(400, 'Loan maturity date cannot be before its start date.');
  }
  const repaymentFrequency = text(
    body.repaymentFrequency ?? existing?.repaymentFrequency ?? 'LUMP_SUM',
    20
  ).toUpperCase();
  if (!REPAYMENT_FREQUENCIES.has(repaymentFrequency)) {
    throw new ApiError(400, 'Choose a valid repayment frequency.');
  }
  const installmentRaw = pick(body, 'installmentAmount', existing?.installmentAmount);
  const installmentAmount =
    installmentRaw === null || installmentRaw === undefined || String(installmentRaw).trim() === ''
      ? null
      : roundMoney(Number(installmentRaw));
  if (installmentAmount !== null && (!Number.isFinite(installmentAmount) || installmentAmount < 0)) {
    throw new ApiError(400, 'Installment amount must be zero or a positive amount.');
  }
  const securityType = text(body.securityType ?? existing?.securityType ?? 'UNSECURED', 20).toUpperCase();
  if (!SECURITY_TYPES.has(securityType)) {
    throw new ApiError(400, 'Security type must be UNSECURED or SECURED.');
  }
  const status = text(body.status ?? existing?.status ?? 'OPEN', 20).toUpperCase();
  if (!LOAN_STATUSES.has(status)) {
    throw new ApiError(400, 'Loan status must be OPEN, CLOSED or CANCELLED.');
  }

  const tdsApplicable = booleanFlag(
    pick(body, 'tdsApplicable', existing?.tdsApplicable ?? true),
    existing?.tdsApplicable ?? true
  );
  const reasonRaw = text(
    pick(body, 'tdsExemptionReason', existing?.tdsExemptionReason),
    30
  ).toUpperCase();
  const tdsExemptionReason = reasonRaw ? parseTdsExemptionReason(reasonRaw) : null;
  if (reasonRaw && !tdsExemptionReason) {
    throw new ApiError(
      400,
      'TDS exemption reason must be RESIDENT_BANK, RESIDENT_FI, INTER_COOP, NO_INTEREST, TREATY, EXEMPT_INCOME or OTHER.'
    );
  }
  let tdsExemptionReference =
    text(pick(body, 'tdsExemptionReference', existing?.tdsExemptionReference), 500) || null;
  if (tdsApplicable) {
    if (tdsExemptionReason || tdsExemptionReference) {
      throw new ApiError(
        400,
        'A TDS-applicable loan cannot carry an exemption reason or reference; mark TDS not applicable first.'
      );
    }
    tdsExemptionReference = null;
  } else {
    if (!tdsExemptionReason) {
      throw new ApiError(
        400,
        'Choose a TDS exemption reason when the loan is not TDS-applicable.'
      );
    }
    if (tdsExemptionRequiresReference(tdsExemptionReason) && !tdsExemptionReference) {
      throw new ApiError(
        400,
        'Record the certificate, agreement clause or notification relied on for this TDS exemption.'
      );
    }
  }

  return {
    principal,
    interestRate: Math.round(interestRate * 10000) / 10000,
    startDateAD,
    maturityDateAD,
    repaymentFrequency,
    installmentAmount,
    securityType,
    status,
    agreementReference: text(pick(body, 'agreementReference', existing?.agreementReference), 100) || null,
    notes: text(pick(body, 'notes', existing?.notes), 1000) || null,
    tdsApplicable,
    tdsExemptionReason,
    tdsExemptionReference,
  };
}

async function readLender(id: string, branchId: string | null = null): Promise<LenderRow | null> {
  return ((await pgPool.query(LENDER_BY_ID_SQL, [id, branchId])).rows[0] as LenderRow) || null;
}

async function uniqueLenderBookCode(client: any, source: string): Promise<string> {
  const stem = source
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'LENDER';
  const base = `LEN-${stem}`.slice(0, 27);
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`.slice(0, 30);
    if (!(await client.query(LENDER_BOOK_BY_CODE_SQL, [candidate])).rows[0]) return candidate;
  }
  throw new ApiError(409, 'Could not allocate a unique lender subledger code.');
}

/** Creates the lender's party book when the chart has a Loan Payable control. */
async function ensureLenderBook(
  client: any,
  lender: {
    id: string;
    code: string;
    name: string;
    active: boolean;
    defaultLoanAccountId?: string | null;
  }
): Promise<string | null> {
  const existing = (await client.query(LENDER_BOOK_BY_PARTY_SQL, [lender.id])).rows[0];
  const preferredAccount = lender.defaultLoanAccountId
    ? (await client.query(LOAN_PAYABLE_ACCOUNT_BY_ID_SQL, [lender.defaultLoanAccountId])).rows[0]
    : null;
  if (existing) {
    await client.query(LENDER_BOOK_UPDATE_SQL, [existing.id, `Loan Payable — ${lender.name}`, lender.active]);
    if (preferredAccount && preferredAccount.id !== existing.mainAccountId) {
      const used = Number(
        (await client.query(LENDER_LEDGER_COUNT_SQL, [lender.id])).rows[0]?.count || 0
      );
      if (used > 0) {
        throw new ApiError(
          409,
          'The lender already has posted Loan Payable rows; keep its current Loan Payable control account.'
        );
      }
      await client.query(LENDER_BOOK_ACCOUNT_UPDATE_SQL, [existing.id, preferredAccount.id]);
    }
    return existing.id as string;
  }
  const control = preferredAccount || (await client.query(LOAN_PAYABLE_ACCOUNT_SQL)).rows[0];
  if (!control) return null;
  const id = `gls-${crypto.randomUUID()}`;
  const code = await uniqueLenderBookCode(client, lender.code);
  await client.query(LENDER_BOOK_INSERT_SQL, [
    id,
    code,
    `Loan Payable — ${lender.name}`,
    control.id,
    lender.id,
    `Lender book for ${lender.code} ${lender.name}`,
    lender.active,
  ]);
  return id;
}

/**
 * GET /api/accounting/lenders/options — bounded party picker for Journal Entry.
 * A manual voucher poster needs the lender name/id but not the master balance.
 */
export async function get_lenderOptions(_req: any, res: Response): Promise<any> {
  requireDb();
  const rows = (await pgPool.query(LENDER_PARTY_OPTIONS_SQL)).rows;
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(rows);
}

/** GET /api/accounting/lenders */
export async function get_lenders(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const includeInactive = String(req.query?.includeInactive ?? '1') !== '0';
  const q = text(req.query?.q, 100);
  const rows = (
    (await pgPool.query(LENDER_LIST_SQL, [q ? `%${q}%` : null, scope.branchId || null]))
      .rows as LenderRow[]
  )
    .filter((row) => includeInactive || row.active)
    .map((row) => ({
      ...row,
      loanCount: integer(row.loanCount),
      openPrincipal: money(row.openPrincipal),
      bookBalance: money(row.bookBalance),
    }));
  return res.json(rows);
}

/** POST /api/accounting/lenders */
export async function post_lender(req: any, res: Response): Promise<any> {
  requireDb();
  const lender = parseLender(req.body || {});
  await validateLenderAccounts(lender);
  const saved = await withTransaction(async (client) => {
    const duplicate = (await client.query(LENDER_BY_CODE_SQL, [lender.code])).rows[0];
    if (duplicate) throw new ApiError(409, `Lender code '${lender.code}' is already in use.`);
    await client.query(LENDER_INSERT_SQL, [
      lender.id,
      lender.code,
      lender.name,
      lender.lenderType,
      lender.panNumber,
      lender.registrationNumber,
      lender.phone,
      lender.address,
      lender.notes,
      lender.defaultCashAccountId,
      lender.defaultInterestAccountId,
      lender.defaultTdsAccountId,
      lender.defaultLoanAccountId,
      lender.active,
    ]);
    await ensureLenderBook(client, lender);
    await logAuditEvent(
      req,
      'CREATE_LENDER',
      'ACCOUNTING',
      `Created lender ${lender.code} ${lender.name} (${lender.lenderType})`,
      undefined,
      client
    );
    return lender;
  });
  const row = await readLender(saved.id);
  return res.status(201).json({
    ...row,
    loanCount: integer(row?.loanCount),
    openPrincipal: money(row?.openPrincipal),
    bookBalance: money(row?.bookBalance),
  });
}

/** PATCH /api/accounting/lenders/:id */
export async function patch_lender(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A lender id is required.');
  const existing = await readLender(id);
  if (!existing) throw new ApiError(404, 'Lender not found.');
  const lender = parseLender(req.body || {}, existing);
  await validateLenderAccounts(lender);
  if (existing.active && !lender.active) {
    const openLoans = Number(
      (await pgPool.query(LENDER_OPEN_LOAN_COUNT_SQL, [id])).rows[0]?.count || 0
    );
    if (openLoans > 0) {
      throw new ApiError(409, 'Close or cancel this lender’s open loans before retiring the lender.');
    }
  }
  await withTransaction(async (client) => {
    await client.query(LENDER_UPDATE_SQL, [
      id,
      lender.name,
      lender.lenderType,
      lender.panNumber,
      lender.registrationNumber,
      lender.phone,
      lender.address,
      lender.notes,
      lender.defaultCashAccountId,
      lender.defaultInterestAccountId,
      lender.defaultTdsAccountId,
      lender.defaultLoanAccountId,
      lender.active,
    ]);
    const book = (await client.query(LENDER_BOOK_BY_PARTY_SQL, [id])).rows[0];
    if (book) {
      await client.query(LENDER_BOOK_UPDATE_SQL, [book.id, `Loan Payable — ${lender.name}`, lender.active]);
    } else if (lender.active) {
      await ensureLenderBook(client, lender);
    }
    await logAuditEvent(
      req,
      'UPDATE_LENDER',
      'ACCOUNTING',
      `Updated lender ${lender.code} ${lender.name} (${lender.active ? 'active' : 'retired'})`,
      undefined,
      client
    );
  });
  const row = await readLender(id);
  return res.json({
    ...row,
    loanCount: integer(row?.loanCount),
    openPrincipal: money(row?.openPrincipal),
    bookBalance: money(row?.bookBalance),
  });
}

/** DELETE /api/accounting/lenders/:id — only an unused lender can be removed. */
export async function delete_lender(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A lender id is required.');
  const existing = await readLender(id);
  if (!existing) throw new ApiError(404, 'Lender not found.');
  const [loans, ledger] = await Promise.all([
    pgPool.query(LENDER_LOAN_COUNT_SQL, [id]),
    pgPool.query(LENDER_LEDGER_COUNT_SQL, [id]),
  ]);
  if (Number(loans.rows[0]?.count) > 0 || Number(ledger.rows[0]?.count) > 0) {
    throw new ApiError(
      409,
      'This lender has loans or posted Loan Payable rows. Retire it instead of deleting it.'
    );
  }
  await withTransaction(async (client) => {
    const book = (await client.query(LENDER_BOOK_BY_PARTY_SQL, [id])).rows[0];
    if (book) await client.query(LENDER_BOOK_DELETE_SQL, [book.id]);
    await client.query(LENDER_DELETE_SQL, [id]);
    await logAuditEvent(
      req,
      'DELETE_LENDER',
      'ACCOUNTING',
      `Deleted lender ${existing.code} ${existing.name}`,
      undefined,
      client
    );
  });
  return res.json({ deleted: true, id });
}

/** GET /api/accounting/loans?lenderId=&status= */
export async function get_loans(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const lenderId = text(req.query?.lenderId, 50) || null;
  const status = text(req.query?.status, 20).toUpperCase() || null;
  const overdueOnly = String(req.query?.overdue ?? '') === '1';
  if (status && !LOAN_STATUSES.has(status)) {
    throw new ApiError(400, 'Loan status must be OPEN, CLOSED or CANCELLED.');
  }
  const rows = (
    await pgPool.query(LOAN_LIST_SQL, [lenderId, status, scope.branchId || null])
  )
    .rows.map((row: any) => loanResponse(row))
    .filter((row: any) => !overdueOnly || row.overdue);
  return res.json(rows);
}

/** POST /api/accounting/loans */
export async function post_loan(req: any, res: Response): Promise<any> {
  requireDb();
  const body = req.body || {};
  const lenderId = text(body.lenderId, 50);
  if (!lenderId) throw new ApiError(400, 'Choose the lender for this loan.');
  const lender = await readLender(lenderId);
  if (!lender) throw new ApiError(404, 'Lender not found.');
  if (!lender.active) throw new ApiError(409, 'This lender is retired; reactivate it before adding a loan.');
  const branchId = text(body.branchId, 50);
  if (!branchId) throw new ApiError(400, 'Choose the branch that received the loan.');
  assertBranchAllowed(req, branchId);
  if (!(await branchExists(branchId))) throw new ApiError(400, `Branch ${branchId} does not exist.`);
  const loan = parseLoan(body);
  const saved = await withTransaction(async (client) => {
    const loanNumber = await issueNextDocNumber(branchId, 'LOAN', loan.startDateAD, client);
    const startDateBS = await bsDateOrThrow(loan.startDateAD, client);
    const maturityDateBS = loan.maturityDateAD
      ? await bsDateOrThrow(loan.maturityDateAD, client)
      : null;
    const id = `loan-${crypto.randomUUID()}`;
    await client.query(LOAN_INSERT_SQL, [
      id,
      loanNumber,
      lenderId,
      branchId,
      loan.principal,
      loan.interestRate,
      loan.startDateAD,
      startDateBS,
      loan.maturityDateAD,
      maturityDateBS,
      loan.repaymentFrequency,
      loan.installmentAmount,
      loan.securityType,
      loan.status,
      loan.agreementReference,
      loan.notes,
      loan.tdsApplicable,
      loan.tdsExemptionReason,
      loan.tdsExemptionReference,
      actorOf(req),
    ]);
    const savedLoan = (await client.query(LOAN_BY_ID_SQL, [id])).rows[0] as LoanRow;
    await writeLoanSchedule(client, savedLoan);
    await logAuditEvent(
      req,
      'CREATE_LOAN',
      'ACCOUNTING',
      `Registered loan ${loanNumber} for lender ${lender.code} ${lender.name} (${loan.principal})`,
      undefined,
      client
    );
    return id;
  });
  return res.status(201).json(
    loanResponse((await pgPool.query(LOAN_BY_ID_SQL, [saved])).rows[0])
  );
}

/** PATCH /api/accounting/loans/:id — correct the registered terms/status. */
export async function patch_loan(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A loan id is required.');
  const existing = (await pgPool.query(LOAN_BY_ID_SQL, [id])).rows[0] as LoanRow | undefined;
  if (!existing) throw new ApiError(404, 'Loan not found.');
  assertBranchAllowed(req, existing.branchId);
  const loan = parseLoan(req.body || {}, existing);
  const sums = (await pgPool.query(LOAN_TRANSACTION_SUM_SQL, [id])).rows[0] || {};
  if (money(sums.funded) > loan.principal + 0.004) {
    throw new ApiError(409, 'Loan principal cannot be reduced below the amount already received.');
  }
  if (money(sums.repaid) > loan.principal + 0.004) {
    throw new ApiError(409, 'Loan principal cannot be reduced below the amount already repaid.');
  }
  const [repaymentCount, accrualCount] = await Promise.all([
    pgPool.query(LOAN_REPAYMENT_COUNT_SQL, [id]),
    pgPool.query(LOAN_ACCRUAL_COUNT_SQL, [id]),
  ]);
  const financialChanged =
    money(existing.principal) !== money(loan.principal) ||
    Number(existing.interestRate) !== Number(loan.interestRate) ||
    existing.startDateAD !== loan.startDateAD ||
    (existing.maturityDateAD || null) !== (loan.maturityDateAD || null) ||
    existing.repaymentFrequency !== loan.repaymentFrequency ||
    (existing.installmentAmount === null ? null : money(existing.installmentAmount)) !==
      (loan.installmentAmount === null ? null : money(loan.installmentAmount));
  if (
    financialChanged &&
    (Number(repaymentCount.rows[0]?.count) > 0 || Number(accrualCount.rows[0]?.count) > 0)
  ) {
    throw new ApiError(
      409,
      'Financial terms cannot change after repayments or interest accruals; reverse the documents first.'
    );
  }
  await withTransaction(async (client) => {
    const startDateBS = await bsDateOrThrow(loan.startDateAD, client);
    const maturityDateBS = loan.maturityDateAD
      ? await bsDateOrThrow(loan.maturityDateAD, client)
      : null;
    await client.query(LOAN_UPDATE_SQL, [
      id,
      loan.principal,
      loan.interestRate,
      loan.startDateAD,
      startDateBS,
      loan.maturityDateAD,
      maturityDateBS,
      loan.repaymentFrequency,
      loan.installmentAmount,
      loan.securityType,
      loan.status,
      loan.agreementReference,
      loan.notes,
      loan.tdsApplicable,
      loan.tdsExemptionReason,
      loan.tdsExemptionReference,
    ]);
    if (Number(repaymentCount.rows[0]?.count) === 0) {
      const savedLoan = (await client.query(LOAN_BY_ID_SQL, [id])).rows[0] as LoanRow;
      await writeLoanSchedule(client, savedLoan);
    }
    await logAuditEvent(
      req,
      'UPDATE_LOAN',
      'ACCOUNTING',
      `Updated loan ${existing.loanNumber} (${loan.status})`,
      undefined,
      client
    );
  });
  return res.json(loanResponse((await pgPool.query(LOAN_BY_ID_SQL, [id])).rows[0]));
}

async function requireCashAccount(client: any, accountId: string, branchId: string) {
  const account = await loadAccount(client, accountId);
  assertUsableDefaultAccount(
    account,
    'Cash/bank account',
    (row) => ['CASH', 'BANK', 'WALLET'].includes(String(row.accountKind)),
    'a cash, bank or wallet ledger'
  );
  if (account.branchId && account.branchId !== branchId) {
    throw new ApiError(400, `Cash/bank account ${account.code} belongs to another branch.`);
  }
  return account;
}

async function requireLoanAccount(client: any, lender: LenderRow) {
  const id =
    lender.defaultLoanAccountId ||
    (await client.query(LOAN_PAYABLE_ACCOUNT_SQL)).rows[0]?.id;
  if (!id) throw new ApiError(400, 'The chart has no active Loan Payable control account.');
  const account = await loadAccount(client, id);
  assertUsableDefaultAccount(
    account,
    'Loan Payable account',
    (row) =>
      row.isControl && row.postingRole === 'LOAN_PAYABLE' && row.subledgerType === 'LENDER',
    'an active LENDER control with the LOAN_PAYABLE posting role'
  );
  return account;
}

async function requireInterestAccount(client: any, lender: LenderRow, explicitId: string | null) {
  const id =
    explicitId ||
    lender.defaultInterestAccountId ||
    (await client.query(LENDER_INTEREST_ACCOUNT_SQL)).rows[0]?.id;
  if (!id) throw new ApiError(400, 'Choose an interest expense account for this repayment.');
  const account = await loadAccount(client, id);
  assertUsableDefaultAccount(
    account,
    'Interest account',
    (row) => row.accountType === 'EXPENSE' && !row.isControl,
    'an active non-control expense account'
  );
  return account;
}

async function requireTdsAccount(client: any, lender: LenderRow, explicitId: string | null) {
  const id =
    explicitId ||
    lender.defaultTdsAccountId ||
    (await client.query(LENDER_TDS_ACCOUNT_SQL)).rows[0]?.id;
  if (!id) throw new ApiError(400, 'Choose a TDS payable account for this repayment.');
  const account = await loadAccount(client, id);
  assertUsableDefaultAccount(
    account,
    'TDS account',
    (row) => row.accountType === 'LIABILITY' && !row.isControl,
    'an active non-control liability account'
  );
  return account;
}

async function requireInterestPayableAccount(client: any): Promise<any> {
  const id = (await client.query(LENDER_INTEREST_PAYABLE_ACCOUNT_SQL)).rows[0]?.id;
  if (!id) {
    throw new ApiError(400, 'The chart has no active Interest Payable — Lender account (2370).');
  }
  const account = await loadAccount(client, id);
  assertUsableDefaultAccount(
    account,
    'Interest Payable — Lender account',
    (row) => row.accountType === 'LIABILITY' && !row.isControl,
    'an active non-control liability account'
  );
  return account;
}

/** Read and lock one loan for a receipt/repayment, enforcing the session branch. */
async function loanForWrite(client: any, req: any, loanId: string): Promise<any> {
  await client.query(LOAN_LOCK_SQL, [loanId]);
  const row = (await client.query(LOAN_BY_ID_SQL, [loanId])).rows[0];
  if (!row) throw new ApiError(404, 'Loan not found.');
  assertBranchAllowed(req, row.branchId);
  return row;
}

/** GET /api/accounting/loans/:id — one agreement plus its receipts/repayments. */
export async function get_loan(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A loan id is required.');
  const loan = (await pgPool.query(LOAN_BY_ID_SQL, [id])).rows[0];
  if (!loan) throw new ApiError(404, 'Loan not found.');
  assertBranchAllowed(req, loan.branchId);
  const [transactions, installments, accruals] = await Promise.all([
    pgPool.query(LOAN_TRANSACTION_LIST_SQL, [id]),
    pgPool.query(LOAN_INSTALLMENT_LIST_SQL, [id]),
    pgPool.query(LOAN_ACCRUAL_LIST_SQL, [id]),
  ]);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    loan: loanResponse(loan),
    transactions: transactions.rows.map(loanTransactionResponse),
    installments: installments.rows.map(loanInstallmentResponse),
    accruals: accruals.rows.map(loanAccrualResponse),
  });
}

/** GET /api/accounting/loans/:id/transactions */
export async function get_loanTransactions(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A loan id is required.');
  const loan = (await pgPool.query(LOAN_BY_ID_SQL, [id])).rows[0];
  if (!loan) throw new ApiError(404, 'Loan not found.');
  assertBranchAllowed(req, loan.branchId);
  const rows = (await pgPool.query(LOAN_TRANSACTION_LIST_SQL, [id])).rows.map(
    loanTransactionResponse
  );
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(rows);
}

/**
 * POST /api/accounting/loans/:id/receipts
 * Dr Cash/Bank, Cr Loan Payable (the lender's LENDER book).
 */
export async function post_loanReceipt(req: any, res: Response): Promise<any> {
  requireDb();
  const loanId = text(req.params?.id, 50);
  if (!loanId) throw new ApiError(400, 'A loan id is required.');
  const body = req.body || {};
  const result = await withTransaction(async (client) => {
    const loan = await loanForWrite(client, req, loanId);
    if (loan.status !== 'OPEN') {
      throw new ApiError(409, `Only an open loan can receive funds (this loan is ${loan.status}).`);
    }
    const lender = (await client.query(LENDER_BY_ID_SQL, [loan.lenderId, null])).rows[0] as
      | LenderRow
      | undefined;
    if (!lender) throw new ApiError(404, 'Lender not found.');
    if (!lender.active) throw new ApiError(409, 'This lender is retired.');
    const sums = (await client.query(LOAN_TRANSACTION_SUM_SQL, [loanId])).rows[0] || {};
    const funded = money(sums.funded);
    const remaining = money(money(loan.principal) - funded);
    if (remaining <= 0) throw new ApiError(409, 'This loan has already been fully received.');
    const amount = roundMoney(
      body.principal === undefined || body.principal === null || String(body.principal).trim() === ''
        ? remaining
        : Number(body.principal)
    );
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, 'Receipt amount must be a positive amount.');
    }
    if (amount > remaining + 0.004) {
      throw new ApiError(400, `Receipt exceeds the undisbursed principal of ${remaining.toFixed(2)}.`);
    }
    const dateAD = dateOnly(body.dateAD ?? todayAD(), 'Receipt date');
    const cashAccountId = text(body.cashAccountId, 50) || lender.defaultCashAccountId;
    if (!cashAccountId) {
      throw new ApiError(400, 'Choose the cash/bank account that received the loan.');
    }
    const cashAccount = await requireCashAccount(client, cashAccountId, loan.branchId);
    const loanAccount = await requireLoanAccount(client, lender);
    const dateBS = await bsDateOrThrow(dateAD, client);
    const id = `lnt-${crypto.randomUUID()}`;
    const txnNumber = await issueNextDocNumber(loan.branchId, 'LOAN_RECEIPT', dateAD, client);
    const journal = await postJournal(client, {
      journalDateAD: dateAD,
      branchId: loan.branchId,
      memo: `Loan receipt ${loan.loanNumber} — ${lender.name}`,
      sourceType: 'LOAN_RECEIPT',
      sourceId: id,
      voucherType: 'LOAN_RECEIPT',
      referenceNo: text(body.referenceNo, 100) || txnNumber,
      chequeNo: text(body.chequeNo, 100) || null,
      chequeDateAD: optionalDate(body.chequeDateAD, 'Cheque date'),
      actor: actorOf(req),
      lines: [
        {
          accountId: cashAccount.id,
          debit: amount,
          credit: 0,
          memo: `Loan received — ${loan.loanNumber}`,
        },
        {
          accountId: loanAccount.id,
          debit: 0,
          credit: amount,
          memo: `Loan payable — ${lender.name}`,
          subledgerType: 'LENDER',
          partyId: lender.id,
          partyName: lender.name,
        },
      ],
    });
    await client.query(LOAN_TRANSACTION_INSERT_SQL, [
      id,
      txnNumber,
      loanId,
      lender.id,
      loan.branchId,
      'RECEIPT',
      dateAD,
      dateBS,
      amount,
      0,
      0,
      amount,
      cashAccount.id,
      null,
      null,
      text(body.chequeNo, 100) || null,
      text(body.referenceNo, 100) || null,
      text(body.notes, 1000) || null,
      journal.id,
      actorOf(req),
      0,
      null,
      null,
    ]);
    await logAuditEvent(
      req,
      'LOAN_RECEIPT',
      'ACCOUNTING',
      `Received ${amount.toFixed(2)} for loan ${loan.loanNumber} from ${lender.code} ${lender.name}`,
      undefined,
      client
    );
    const saved = (await client.query(LOAN_TRANSACTION_BY_ID_SQL, [id])).rows[0];
    const current = (await client.query(LOAN_BY_ID_SQL, [loanId])).rows[0];
    return {
      transaction: loanTransactionResponse(saved),
      loan: loanResponse(current),
    };
  });
  return res.status(201).json(result);
}

/**
 * POST /api/accounting/loans/:id/repayments
 * Dr Loan Payable (principal), Dr Interest Expense, Cr TDS Payable (if any),
 * Cr Cash/Bank for the net paid amount.
 */
export async function post_loanRepayment(req: any, res: Response): Promise<any> {
  requireDb();
  const loanId = text(req.params?.id, 50);
  if (!loanId) throw new ApiError(400, 'A loan id is required.');
  const body = req.body || {};
  const result = await withTransaction(async (client) => {
    const loan = await loanForWrite(client, req, loanId);
    if (loan.status === 'CANCELLED') {
      throw new ApiError(409, 'A cancelled loan cannot be repaid.');
    }
    const lender = (await client.query(LENDER_BY_ID_SQL, [loan.lenderId, null])).rows[0] as
      | LenderRow
      | undefined;
    if (!lender) throw new ApiError(404, 'Lender not found.');
    const sums = (await client.query(LOAN_TRANSACTION_SUM_SQL, [loanId])).rows[0] || {};
    const funded = money(sums.funded);
    const repaid = money(sums.repaid);
    const outstanding = money(funded - repaid);
    if (funded <= 0) throw new ApiError(409, 'Receive the loan before recording a repayment.');
    if (outstanding <= 0) throw new ApiError(409, 'This loan is already fully repaid.');
    const principal = roundMoney(
      body.principal === undefined || body.principal === null || String(body.principal).trim() === ''
        ? outstanding
        : Number(body.principal)
    );
    if (!Number.isFinite(principal) || principal <= 0) {
      throw new ApiError(400, 'Repayment principal must be a positive amount.');
    }
    if (principal > outstanding + 0.004) {
      throw new ApiError(400, `Repayment principal exceeds the outstanding ${outstanding.toFixed(2)}.`);
    }
    const interest = roundMoney(Number(body.interestAmount ?? body.interest ?? 0) || 0);
    const tds = roundMoney(Number(body.tdsAmount ?? body.tds ?? 0) || 0);
    if (interest < 0) throw new ApiError(400, 'Interest must be zero or a positive amount.');
    if (tds < 0) throw new ApiError(400, 'TDS must be zero or a positive amount.');
    if (tds > interest + 0.004) {
      throw new ApiError(400, 'TDS cannot exceed the interest on this repayment.');
    }

    const reasonRaw = text(body.tdsExemptionReason, 30).toUpperCase();
    let exemptionReason = reasonRaw ? parseTdsExemptionReason(reasonRaw) : null;
    if (reasonRaw && !exemptionReason) {
      throw new ApiError(
        400,
        'TDS exemption reason must be RESIDENT_BANK, RESIDENT_FI, INTER_COOP, NO_INTEREST, TREATY, EXEMPT_INCOME or OTHER.'
      );
    }
    let exemptionReference = text(body.tdsExemptionReference, 500) || null;
    if (exemptionReference && !exemptionReason && tds <= 0.004) {
      throw new ApiError(400, 'Choose a TDS exemption reason for the recorded reference.');
    }
    if (!loan.tdsApplicable) {
      const loanReason = parseTdsExemptionReason(loan.tdsExemptionReason);
      if (exemptionReason && loanReason && exemptionReason !== loanReason) {
        throw new ApiError(
          400,
          'The repayment exemption reason must match the exemption recorded on the loan.'
        );
      }
      exemptionReason = exemptionReason || loanReason;
      exemptionReference = exemptionReference || loan.tdsExemptionReference;
    }
    if (tds > 0.004) {
      if (exemptionReason) {
        throw new ApiError(
          409,
          'TDS was withheld on this repayment; an exemption reason cannot also be recorded.'
        );
      }
      exemptionReference = null;
    } else if (interest > 0.004) {
      if (!exemptionReason) {
        throw new ApiError(
          400,
          'A zero-TDS repayment with interest requires an exemption reason on the loan or the repayment.'
        );
      }
      if (exemptionReason === 'NO_INTEREST') {
        throw new ApiError(400, 'NO_INTEREST applies only when the repayment pays no interest.');
      }
      if (tdsExemptionRequiresReference(exemptionReason) && !exemptionReference) {
        throw new ApiError(
          400,
          'Record the certificate, agreement clause or notification relied on for this TDS exemption.'
        );
      }
    }
    const cashAmount = roundMoney(principal + interest - tds);
    if (cashAmount <= 0) {
      throw new ApiError(400, 'The net cash paid must be a positive amount.');
    }
    const dateAD = dateOnly(body.dateAD ?? todayAD(), 'Repayment date');
    const cashAccountId = text(body.cashAccountId, 50) || lender.defaultCashAccountId;
    if (!cashAccountId) {
      throw new ApiError(400, 'Choose the cash/bank account that paid the repayment.');
    }
    const cashAccount = await requireCashAccount(client, cashAccountId, loan.branchId);
    const loanAccount = await requireLoanAccount(client, lender);
    const accruedAvailable = await accruedInterestAvailable(client, loanId);
    const interestPayableApplied = money(Math.min(interest, accruedAvailable));
    const unaccruedInterest = money(interest - interestPayableApplied);
    const interestAccount =
      unaccruedInterest > 0
        ? await requireInterestAccount(client, lender, text(body.interestAccountId, 50) || null)
        : null;
    const interestPayableAccount =
      interestPayableApplied > 0 ? await requireInterestPayableAccount(client) : null;
    const tdsAccount =
      tds > 0 ? await requireTdsAccount(client, lender, text(body.tdsAccountId, 50) || null) : null;
    const dateBS = await bsDateOrThrow(dateAD, client);
    const id = `lnt-${crypto.randomUUID()}`;
    const txnNumber = await issueNextDocNumber(loan.branchId, 'LOAN_REPAYMENT', dateAD, client);
    const lines: any[] = [
      {
        accountId: loanAccount.id,
        debit: principal,
        credit: 0,
        memo: `Loan principal repaid — ${loan.loanNumber}`,
        subledgerType: 'LENDER',
        partyId: lender.id,
        partyName: lender.name,
      },
    ];
    if (interestPayableAccount) {
      lines.push({
        accountId: interestPayableAccount.id,
        debit: interestPayableApplied,
        credit: 0,
        memo: `Accrued interest cleared — ${loan.loanNumber}`,
      });
    }
    if (interestAccount && unaccruedInterest > 0) {
      lines.push({
        accountId: interestAccount.id,
        debit: unaccruedInterest,
        credit: 0,
        memo: `Interest on ${loan.loanNumber}`,
      });
    }
    if (tdsAccount) {
      lines.push({
        accountId: tdsAccount.id,
        debit: 0,
        credit: tds,
        memo: `TDS withheld on interest — ${loan.loanNumber}`,
      });
    }
    lines.push({
      accountId: cashAccount.id,
      debit: 0,
      credit: cashAmount,
      memo: `Loan repayment — ${loan.loanNumber}`,
    });
    const journal = await postJournal(client, {
      journalDateAD: dateAD,
      branchId: loan.branchId,
      memo: `Loan repayment ${loan.loanNumber} — ${lender.name}`,
      sourceType: 'LOAN_REPAYMENT',
      sourceId: id,
      voucherType: 'LOAN_REPAYMENT',
      referenceNo: text(body.referenceNo, 100) || txnNumber,
      chequeNo: text(body.chequeNo, 100) || null,
      chequeDateAD: optionalDate(body.chequeDateAD, 'Cheque date'),
      actor: actorOf(req),
      lines,
    });
    await client.query(LOAN_TRANSACTION_INSERT_SQL, [
      id,
      txnNumber,
      loanId,
      lender.id,
      loan.branchId,
      'REPAYMENT',
      dateAD,
      dateBS,
      principal,
      interest,
      tds,
      cashAmount,
      cashAccount.id,
      interestAccount?.id || null,
      tdsAccount?.id || null,
      text(body.chequeNo, 100) || null,
      text(body.referenceNo, 100) || null,
      text(body.notes, 1000) || null,
      journal.id,
      actorOf(req),
      interestPayableApplied,
      exemptionReason,
      exemptionReference,
    ]);
    await allocateRepayment(client, loanId, principal, interest, tds);
    const updatedSums = (await client.query(LOAN_TRANSACTION_SUM_SQL, [loanId])).rows[0] || {};
    const newOutstanding = money(money(updatedSums.funded) - money(updatedSums.repaid));
    if (newOutstanding <= 0.004) {
      await client.query(LOAN_STATUS_UPDATE_SQL, [loanId, 'CLOSED']);
    }
    await logAuditEvent(
      req,
      'LOAN_REPAYMENT',
      'ACCOUNTING',
      `Repaid ${principal.toFixed(2)} principal + ${interest.toFixed(2)} interest (TDS ${tds.toFixed(2)}${
        exemptionReason ? `; exempt ${exemptionReason}` : ''
      }) for loan ${loan.loanNumber}`,
      undefined,
      client
    );
    const saved = (await client.query(LOAN_TRANSACTION_BY_ID_SQL, [id])).rows[0];
    const current = (await client.query(LOAN_BY_ID_SQL, [loanId])).rows[0];
    return {
      transaction: loanTransactionResponse(saved),
      loan: loanResponse(current),
    };
  });
  return res.status(201).json(result);
}

/**
 * POST /api/accounting/loans/:id/interest-accruals
 * Dr Interest Expense — Borrowings, Cr Interest Payable — Lender.
 */
export async function post_loanInterestAccrual(req: any, res: Response): Promise<any> {
  requireDb();
  const loanId = text(req.params?.id, 50);
  if (!loanId) throw new ApiError(400, 'A loan id is required.');
  const body = req.body || {};
  const result = await withTransaction(async (client) => {
    const loan = await loanForWrite(client, req, loanId);
    if (loan.status !== 'OPEN') {
      throw new ApiError(409, `Only an open loan can accrue interest (this loan is ${loan.status}).`);
    }
    const lender = (await client.query(LENDER_BY_ID_SQL, [loan.lenderId, null])).rows[0] as
      | LenderRow
      | undefined;
    if (!lender) throw new ApiError(404, 'Lender not found.');
    const sums = (await client.query(LOAN_TRANSACTION_SUM_SQL, [loanId])).rows[0] || {};
    const principalBase = money(money(sums.funded) - money(sums.repaid));
    if (principalBase <= 0) {
      throw new ApiError(409, 'Receive the loan before accruing interest.');
    }
    const last = (await client.query(LOAN_ACCRUAL_LAST_SQL, [loanId])).rows[0]?.last as
      | string
      | null;
    const defaultFrom = last
      ? new Date(Date.parse(`${String(last).slice(0, 10)}T00:00:00Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10)
      : loan.startDateAD;
    const fromAD = dateOnly(body.fromAD ?? defaultFrom, 'Accrual start date');
    const toAD = dateOnly(body.toAD ?? todayAD(), 'Accrual end date');
    if (toAD < fromAD) throw new ApiError(400, 'The accrual end date must not be before its start.');
    const overlap = (await client.query(LOAN_ACCRUAL_OVERLAP_SQL, [loanId, fromAD, toAD])).rows[0];
    if (overlap) {
      throw new ApiError(
        409,
        `This period overlaps accrual ${overlap.accrual_number}. Choose a later period.`
      );
    }
    const days = inclusiveDays(fromAD, toAD);
    const annualRate = Number(loan.interestRate) || 0;
    const interest = roundMoney((principalBase * annualRate * days) / 36_500);
    if (interest <= 0) {
      throw new ApiError(400, 'This period produces no interest to accrue.');
    }
    const fromDateBS = await bsDateOrThrow(fromAD, client);
    const toDateBS = await bsDateOrThrow(toAD, client);
    const interestAccount = await requireInterestAccount(client, lender, null);
    const payableAccount = await requireInterestPayableAccount(client);
    const id = `lna-${crypto.randomUUID()}`;
    const accrualNumber = await issueNextDocNumber(loan.branchId, 'LOAN_ACCRUAL', toAD, client);
    const journal = await postJournal(client, {
      journalDateAD: toAD,
      branchId: loan.branchId,
      memo: `Interest accrual ${loan.loanNumber} — ${lender.name}`,
      sourceType: 'LOAN_INTEREST_ACCRUAL',
      sourceId: id,
      voucherType: 'LOAN_ACCRUAL',
      referenceNo: accrualNumber,
      actor: actorOf(req),
      lines: [
        {
          accountId: interestAccount.id,
          debit: interest,
          credit: 0,
          memo: `Interest accrued ${fromAD} to ${toAD} — ${loan.loanNumber}`,
        },
        {
          accountId: payableAccount.id,
          debit: 0,
          credit: interest,
          memo: `Interest payable — ${lender.name}`,
        },
      ],
    });
    await client.query(LOAN_ACCRUAL_INSERT_SQL, [
      id,
      accrualNumber,
      loanId,
      lender.id,
      loan.branchId,
      fromAD,
      fromDateBS,
      toAD,
      toDateBS,
      principalBase,
      annualRate,
      days,
      interest,
      journal.id,
      actorOf(req),
    ]);
    await logAuditEvent(
      req,
      'LOAN_INTEREST_ACCRUAL',
      'ACCOUNTING',
      `Accrued ${interest.toFixed(2)} interest for loan ${loan.loanNumber} (${fromAD} to ${toAD})`,
      undefined,
      client
    );
    const saved = (await client.query(LOAN_ACCRUAL_BY_ID_SQL, [id])).rows[0];
    const current = (await client.query(LOAN_BY_ID_SQL, [loanId])).rows[0];
    return {
      accrual: loanAccrualResponse(saved),
      loan: loanResponse(current),
    };
  });
  return res.status(201).json(result);
}

/** GET /api/accounting/lenders/tds-worklist?from=&to=&branchId= */
export async function get_lenderTdsWorklist(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  const empty = {
    from: null,
    to: null,
    branchId: 'ALL',
    entries: [],
    totals: { count: 0, principal: 0, interest: 0, cash: 0 },
  };
  if (scope.empty) return res.json(empty);
  const from = isoDateOrNull(req.query?.from);
  const to = isoDateOrNull(req.query?.to);
  if (from && to && from > to) throw new ApiError(400, 'The from date must not be after the to date.');
  const branchId = scope.branchId || null;
  const rows = (
    await pgPool.query(LENDER_TDS_WORKLIST_SQL, [from, to, branchId])
  ).rows as any[];
  const entries = rows.map((row) => ({
    ...row,
    principalAmount: money(row.principalAmount),
    interestAmount: money(row.interestAmount),
    tdsAmount: money(row.tdsAmount),
    cashAmount: money(row.cashAmount),
  }));
  const total = (key: 'principalAmount' | 'interestAmount' | 'cashAmount') =>
    money(entries.reduce((sum, row) => sum + row[key], 0));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    from,
    to,
    branchId: branchId || 'ALL',
    entries,
    totals: {
      count: entries.length,
      principal: total('principalAmount'),
      interest: total('interestAmount'),
      cash: total('cashAmount'),
    },
  });
}

/**
 * PATCH /api/accounting/lenders/tds-worklist/:id
 * Records audit evidence for a legacy zero-TDS repayment. The journal, amounts
 * and tax already posted are untouched; only the explanation is stored.
 */
export async function patch_loanTdsEvidence(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A repayment id is required.');
  const body = req.body || {};
  const reasonRaw = text(body.tdsExemptionReason, 30).toUpperCase();
  const reason = parseTdsExemptionReason(reasonRaw);
  if (!reason) {
    throw new ApiError(
      400,
      'TDS exemption reason must be RESIDENT_BANK, RESIDENT_FI, INTER_COOP, NO_INTEREST, TREATY, EXEMPT_INCOME or OTHER.'
    );
  }
  if (reason === 'NO_INTEREST') {
    throw new ApiError(400, 'NO_INTEREST applies only to a repayment that paid no interest.');
  }
  const reference = text(body.tdsExemptionReference, 500);
  if (!reference) {
    throw new ApiError(
      400,
      'Record the certificate, agreement clause or notification relied on for this TDS exemption.'
    );
  }

  const updated = await withTransaction(async (client: any) => {
    const row = (await client.query(LOAN_TRANSACTION_TDS_EVIDENCE_ROW_SQL, [id])).rows[0];
    if (!row) throw new ApiError(404, 'Repayment not found.');
    assertBranchAllowed(req, row.branchId);
    if (row.txnType !== 'REPAYMENT') {
      throw new ApiError(409, 'Only lender repayments can carry TDS exemption evidence.');
    }
    if (row.journalStatus !== 'POSTED') {
      throw new ApiError(409, 'The repayment journal is not posted.');
    }
    if (money(row.interestAmount) <= 0.004) {
      throw new ApiError(409, 'This repayment paid no interest; no TDS evidence is required.');
    }
    if (money(row.tdsAmount) > 0.004) {
      throw new ApiError(409, 'This repayment already withheld TDS and cannot be marked exempt.');
    }
    if (row.tdsExemptionReason) {
      throw new ApiError(409, 'This repayment already has TDS exemption evidence.');
    }
    await client.query(LOAN_TRANSACTION_TDS_EVIDENCE_UPDATE_SQL, [id, reason, reference]);
    await logAuditEvent(
      req,
      'LOAN_TDS_EVIDENCE',
      'ACCOUNTING',
      `Recorded ${reason} evidence for zero-TDS repayment ${row.txnNumber} on loan ${row.loanNumber}: ${reference}`,
      undefined,
      client
    );
    return {
      ...row,
      tdsExemptionReason: reason,
      tdsExemptionReference: reference,
    };
  });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    entry: loanTransactionResponse(updated),
    tdsStatus: 'EXEMPT',
  });
}

/** GET /api/accounting/lenders/:id/statement?from=&to=&branchId= */
export async function get_lenderStatement(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A lender id is required.');
  const branchId = scope.branchId || null;
  const lender = await readLender(id, branchId);
  if (!lender) throw new ApiError(404, 'Lender not found.');
  const from = isoDateOrNull(req.query?.from);
  const to = isoDateOrNull(req.query?.to);
  if (from && to && from > to) throw new ApiError(400, 'The from date must not be after the to date.');
  let control = (await pgPool.query(LOAN_PAYABLE_ACCOUNT_SQL)).rows[0] as
    | { id: string; code: string; name: string }
    | undefined;
  if (lender.defaultLoanAccountId) {
    const preferred = await loadAccount(pgPool, lender.defaultLoanAccountId);
    if (
      preferred &&
      preferred.isActive &&
      preferred.isControl &&
      preferred.postingRole === 'LOAN_PAYABLE' &&
      preferred.subledgerType === 'LENDER'
    ) {
      control = preferred;
    }
  }
  const book = lender.bookId
    ? { id: lender.bookId, code: lender.bookCode, name: `Loan Payable — ${lender.name}` }
    : null;

  const [
    openingResult,
    entriesResult,
    glResult,
    subledgerResult,
    partyResult,
    unassignedResult,
    loansResult,
    tdsResult,
    ledgerResult,
  ] = control
    ? await Promise.all([
        pgPool.query(LENDER_STATEMENT_OPENING_SQL, [control.id, id, book?.id || null, branchId, from]),
        pgPool.query(LENDER_STATEMENT_ENTRIES_SQL, [control.id, id, book?.id || null, branchId, from, to]),
        pgPool.query(LENDER_CONTROL_GL_BALANCE_SQL, [control.id, branchId, to]),
        pgPool.query(LENDER_CONTROL_SUBLEDGER_BALANCE_SQL, [control.id, branchId, to]),
        pgPool.query(LENDER_PARTY_BALANCE_SQL, [control.id, id, book?.id || null, branchId, to]),
        pgPool.query(LENDER_UNASSIGNED_BALANCE_SQL, [control.id, branchId, to]),
        pgPool.query(LOAN_LIST_SQL, [id, null, branchId]),
        pgPool.query(LENDER_TDS_REPORT_SQL, [id, from, to, branchId]),
        pgPool.query(LENDER_REPAYMENT_LEDGER_TOTALS_SQL, [id, from, to, branchId]),
      ])
    : [
        { rows: [{ opening: 0 }] },
        { rows: [] },
        { rows: [{ balance: 0 }] },
        { rows: [{ balance: 0 }] },
        { rows: [{ balance: 0 }] },
        { rows: [{ balance: 0 }] },
        { rows: [] },
        { rows: [] },
        { rows: [{ principal: 0, interest: 0, tds: 0, cash: 0 }] },
      ];

  const openingBalance = money(openingResult.rows[0]?.opening);
  let running = openingBalance;
  const entries = (entriesResult.rows as any[]).map((row) => {
    const debit = money(row.debit);
    const credit = money(row.credit);
    running = money(running + credit - debit);
    return {
      ...row,
      debit,
      credit,
      balance: running,
    };
  });
  const debit = money(entries.reduce((sum, row) => sum + row.debit, 0));
  const credit = money(entries.reduce((sum, row) => sum + row.credit, 0));
  const closingBalance = money(partyResult.rows[0]?.balance);
  const glBalance = money(glResult.rows[0]?.balance);
  const subledgerBalance = money(subledgerResult.rows[0]?.balance);
  const unassignedLenderBalance = money(unassignedResult.rows[0]?.balance);
  const lenderBooksBalance = money(subledgerBalance - unassignedLenderBalance);
  const difference = money(glBalance - subledgerBalance);
  const booksDifference = money(glBalance - lenderBooksBalance);
  const loans = (loansResult.rows as any[]).map(loanResponse);
  const tdsEntries = (tdsResult.rows as any[]).map((row) => {
    const interestAmount = money(row.interestAmount);
    const tdsAmount = money(row.tdsAmount);
    const exemptionReason = row.tdsExemptionReason || row.loanTdsExemptionReason || null;
    const exemptionReference =
      row.tdsExemptionReference || row.loanTdsExemptionReference || null;
    const tdsStatus =
      tdsAmount > 0.004
        ? 'WITHHELD'
        : interestAmount > 0.004
          ? exemptionReason
            ? 'EXEMPT'
            : 'UNEXPLAINED'
          : 'NO_INTEREST';
    return {
      ...row,
      principalAmount: money(row.principalAmount),
      interestAmount,
      tdsAmount,
      cashAmount: money(row.cashAmount),
      tdsStatus,
      exemptionReason,
      exemptionReference,
    };
  });
  const total = (key: 'principalAmount' | 'interestAmount' | 'tdsAmount' | 'cashAmount') =>
    money(tdsEntries.reduce((sum, row) => sum + row[key], 0));
  const withheldEntries = tdsEntries.filter((row) => row.tdsStatus === 'WITHHELD');
  const exemptEntries = tdsEntries.filter((row) => row.tdsStatus === 'EXEMPT');
  const unexplainedEntries = tdsEntries.filter((row) => row.tdsStatus === 'UNEXPLAINED');
  const noInterestEntries = tdsEntries.filter((row) => row.tdsStatus === 'NO_INTEREST');
  const ledger = ledgerResult.rows[0] || {};
  const ledgerPrincipal = money(ledger.principal);
  const ledgerInterest = money(ledger.interest);
  const ledgerTds = money(ledger.tds);
  const ledgerCash = money(ledger.cash);
  const tdsTotals = {
    principal: total('principalAmount'),
    interest: total('interestAmount'),
    tds: total('tdsAmount'),
    cash: total('cashAmount'),
    withheldInterest: money(
      withheldEntries.reduce((sum, row) => sum + row.interestAmount, 0)
    ),
    withheldTax: money(withheldEntries.reduce((sum, row) => sum + row.tdsAmount, 0)),
    exemptInterest: money(exemptEntries.reduce((sum, row) => sum + row.interestAmount, 0)),
    unexplainedInterest: money(
      unexplainedEntries.reduce((sum, row) => sum + row.interestAmount, 0)
    ),
    noInterestPrincipal: money(
      noInterestEntries.reduce((sum, row) => sum + row.principalAmount, 0)
    ),
    withheldCount: withheldEntries.length,
    exemptCount: exemptEntries.length,
    unexplainedCount: unexplainedEntries.length,
    noInterestCount: noInterestEntries.length,
    ledgerPrincipal,
    ledgerInterest,
    ledgerTds,
    ledgerCash,
    principalDifference: money(total('principalAmount') - ledgerPrincipal),
    interestDifference: money(total('interestAmount') - ledgerInterest),
    tdsDifference: money(total('tdsAmount') - ledgerTds),
    cashDifference: money(total('cashAmount') - ledgerCash),
    reconciled:
      Math.abs(total('principalAmount') - ledgerPrincipal) < 0.005 &&
      Math.abs(total('interestAmount') - ledgerInterest) < 0.005 &&
      Math.abs(total('tdsAmount') - ledgerTds) < 0.005 &&
      Math.abs(total('cashAmount') - ledgerCash) < 0.005,
  };

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    lender: {
      ...lender,
      loanCount: integer(lender.loanCount),
      openPrincipal: money(lender.openPrincipal),
      bookBalance: money(lender.bookBalance),
    },
    book,
    control: control
      ? {
          accountId: control.id,
          accountCode: control.code,
          accountName: control.name,
        }
      : null,
    from,
    to,
    branchId: branchId || 'ALL',
    openingBalance,
    entries,
    totals: { debit, credit, closingBalance },
    loans,
    tdsEntries,
    tdsTotals,
    tieOut: {
      glBalance,
      subledgerBalance,
      lenderBooksBalance,
      unassignedLenderBalance,
      difference,
      booksDifference,
      status:
        Math.abs(difference) < 0.005 && Math.abs(booksDifference) < 0.005
          ? 'RECONCILED'
          : 'DIFFERENCE',
    },
  });
}
