/**
 * Ledger postings for payroll.
 *
 * A payroll run is one balanced journal: the gross wage is debited to the
 * salary-expense default and the credits go to salary payable (net), TDS, SSF,
 * employee advances and employee loans. Paying the run debits salary payable
 * and credits the till or bank. Every control-account line carries the
 * EMPLOYEE subledger party, so the generic reconciliation and the employee
 * ledger read the same rows the journal wrote — nothing here keeps a second
 * payroll balance.
 *
 * The caller owns the transaction: the run row, its lines, the journal and its
 * subledger rows commit or roll back together, exactly like invoice and payment
 * postings. Accounts come from the chart's posting roles; a role a run actually
 * uses must be mapped or the run is refused, never posted with a guessed code.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { ACCOUNTS_BY_POSTING_ROLES_SQL, type PostingRole } from '../models/accounting.repo';
import { postJournal, type AccountingClient, type JournalLineInput } from './accounting.service';

interface PostingAccount {
  id: string;
  code: string;
  name: string;
  isControl: boolean;
  subledgerType: string;
}

type PayrollAccountRole = Extract<
  PostingRole,
  | 'SALARY_EXPENSE'
  | 'SALARY_PAYABLE'
  | 'TDS_PAYABLE'
  | 'SSF_PAYABLE'
  | 'EMPLOYEE_ADVANCE'
  | 'EMPLOYEE_LOAN'
  | 'CASH'
  | 'BANK'
>;

export interface PayrollPostingLine {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  gross: number | string;
  tds: number | string;
  ssf: number | string;
  advance: number | string;
  loan: number | string;
  net: number | string;
}

export interface PayrollRunPostingInput {
  runId: string;
  runNo: string;
  branchId: string;
  periodKey: string;
  dateAD: string;
  lines: PayrollPostingLine[];
  actor?: string | null;
}

export interface PayrollPaymentPostingInput {
  runId: string;
  runNo: string;
  branchId: string;
  periodKey: string;
  dateAD: string;
  paymentMethod?: string | null;
  lines: PayrollPostingLine[];
  actor?: string | null;
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

/** CASH is the till; every other method already settles through the bank. */
function settlementRole(paymentMethod: string | null | undefined): 'CASH' | 'BANK' {
  return String(paymentMethod || 'CASH').trim().toUpperCase() === 'CASH' ? 'CASH' : 'BANK';
}

async function loadPayrollAccounts(
  client: AccountingClient,
  roles: readonly PayrollAccountRole[]
): Promise<Record<string, PostingAccount>> {
  const rows = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [roles])).rows;
  const byRole: Record<string, PostingAccount> = {};
  for (const row of rows) {
    if (row.postingRole) byRole[row.postingRole] = row;
  }
  return byRole;
}

function needAccount(
  accounts: Record<string, PostingAccount>,
  role: PayrollAccountRole,
  subject: string
): PostingAccount {
  const account = accounts[role];
  if (!account) {
    throw new ApiError(
      400,
      `Accounting is not configured for ${subject}: no active account has the ${role} posting default. Map it in Accounting → Posting defaults, then post the payroll run again.`
    );
  }
  return account;
}

function ordinaryLine(
  account: PostingAccount,
  debit: number,
  credit: number,
  memo: string
): JournalLineInput {
  return { accountId: account.id, debit, credit, memo };
}

function employeeLine(
  account: PostingAccount,
  line: PayrollPostingLine,
  amount: number,
  memo: string
): JournalLineInput {
  return {
    accountId: account.id,
    debit: 0,
    credit: amount,
    memo,
    subledgerType: 'EMPLOYEE',
    partyId: line.employeeId,
    partyName: line.employeeName,
  };
}

/**
 * Debit the gross wage, credit every deduction and the net payable. Returns the
 * posted journal; the caller links it to the run row in the same transaction.
 */
export async function postPayrollRunJournal(
  client: AccountingClient,
  input: PayrollRunPostingInput
) {
  const accounts = await loadPayrollAccounts(client, [
    'SALARY_EXPENSE',
    'SALARY_PAYABLE',
    'TDS_PAYABLE',
    'SSF_PAYABLE',
    'EMPLOYEE_ADVANCE',
    'EMPLOYEE_LOAN',
  ]);
  const salaryExpense = needAccount(accounts, 'SALARY_EXPENSE', 'payroll runs');
  const salaryPayable = needAccount(accounts, 'SALARY_PAYABLE', 'payroll runs');

  const memo = `Payroll run ${input.runNo} for ${input.periodKey}`;
  const lines: JournalLineInput[] = [];
  let totalGross = 0;
  let totalCredits = 0;

  for (const line of input.lines) {
    const gross = money(line.gross);
    const tds = money(line.tds);
    const ssf = money(line.ssf);
    const advance = money(line.advance);
    const loan = money(line.loan);
    const net = money(line.net);
    if (gross <= 0) continue;
    if (Math.abs(roundMoney(gross - tds - ssf - advance - loan - net)) >= 0.005) {
      throw new ApiError(
        400,
        `Payroll line for ${line.employeeCode} does not add up: net must equal gross less TDS, SSF, advances and loans.`
      );
    }

    totalGross = roundMoney(totalGross + gross);

    for (const [amount, role, label] of [
      [tds, 'TDS_PAYABLE', 'TDS withheld'],
      [ssf, 'SSF_PAYABLE', 'SSF withheld'],
      [advance, 'EMPLOYEE_ADVANCE', 'advance recovered'],
      [loan, 'EMPLOYEE_LOAN', 'loan recovered'],
      [net, 'SALARY_PAYABLE', 'net salary payable'],
    ] as const) {
      if (amount <= 0) continue;
      const account = needAccount(accounts, role, `payroll runs (${label})`);
      lines.push(employeeLine(account, line, amount, `${memo} — ${line.employeeCode} ${label}`));
      totalCredits = roundMoney(totalCredits + amount);
    }
  }

  if (totalGross <= 0) {
    throw new ApiError(400, 'A payroll run needs at least one employee with a positive gross wage.');
  }
  // One gross-wage debit for the run, before the per-employee credits. The
  // detail lives in payroll_run_lines and in each subledger line's memo.
  lines.unshift(ordinaryLine(salaryExpense, totalGross, 0, `${memo} — gross wages`));
  if (Math.abs(totalGross - totalCredits) >= 0.005) {
    throw new ApiError(
      400,
      `Payroll journal is not balanced: gross ${totalGross.toFixed(2)} ≠ deductions and net ${totalCredits.toFixed(2)}.`
    );
  }

  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.branchId,
    memo,
    sourceType: 'PAYROLL_RUN',
    sourceId: input.runId,
    actor: input.actor || null,
    lines,
  });
}

/**
 * Debit each employee's net salary payable, credit the till/bank once for the
 * run total. Returns null when there is nothing to pay (a fully deducted run).
 */
export async function postPayrollPaymentJournal(
  client: AccountingClient,
  input: PayrollPaymentPostingInput
) {
  const role = settlementRole(input.paymentMethod);
  const accounts = await loadPayrollAccounts(client, ['SALARY_PAYABLE', role]);
  const salaryPayable = needAccount(accounts, 'SALARY_PAYABLE', 'payroll payments');
  const settlement = needAccount(accounts, role, 'payroll payments');

  const memo = `Salary payment for ${input.runNo} (${input.periodKey})`;
  const lines: JournalLineInput[] = [];
  let totalNet = 0;
  for (const line of input.lines) {
    const net = money(line.net);
    if (net <= 0) continue;
    lines.push({
      accountId: salaryPayable.id,
      debit: net,
      credit: 0,
      memo: `${memo} — ${line.employeeCode} net salary`,
      subledgerType: 'EMPLOYEE',
      partyId: line.employeeId,
      partyName: line.employeeName,
    });
    totalNet = roundMoney(totalNet + net);
  }
  if (totalNet <= 0) return null;

  lines.push(ordinaryLine(settlement, 0, totalNet, memo));
  return postJournal(client, {
    journalDateAD: input.dateAD,
    branchId: input.branchId,
    memo,
    sourceType: 'PAYROLL_PAYMENT',
    sourceId: input.runId,
    actor: input.actor || null,
    lines,
  });
}
