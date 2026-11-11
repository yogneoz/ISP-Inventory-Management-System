/**
 * Posted payroll outputs: payslips and a transfer register derived from the
 * immutable run-line snapshots. Nothing here reads or writes the ledger; the
 * controller supplies the linked journal totals so callers can prove that the
 * register reconciles to both the run and its posting.
 */
import { roundMoney } from '../utils/money';

export const PAYROLL_OUTPUT_STATUSES = ['POSTED', 'PAID'] as const;

export function isPayrollOutputReady(status: unknown): boolean {
  return typeof status === 'string' && PAYROLL_OUTPUT_STATUSES.includes(status as any);
}

export interface PayrollPayslip {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  panNumber: string | null;
  ssfNumber: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankStatus: 'READY' | 'MISSING';
  detailsRestricted: boolean;
  branchId: string;
  branchName: string;
  fiscalYearCode: string | null;
  runNo: string;
  periodKey: string;
  runDateAD: string;
  runDateBS: string | null;
  paidDateAD: string | null;
  paymentMethod: string | null;
  status: string;
  basicAmount: number;
  allowances: number;
  payableDays: number;
  lopDays: number;
  lopDeduction: number;
  overtimeHours: number;
  overtimeAmount: number;
  incentive: number;
  arrears: number;
  gross: number;
  tds: number;
  ssf: number;
  employerSsf: number;
  advance: number;
  loan: number;
  totalDeductions: number;
  employerCost: number;
  net: number;
}

export interface PayrollRegisterRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankStatus: 'READY' | 'MISSING';
  detailsRestricted: boolean;
  paymentMethod: string | null;
  incentive: number;
  arrears: number;
  gross: number;
  tds: number;
  ssf: number;
  employerSsf: number;
  advance: number;
  loan: number;
  totalDeductions: number;
  net: number;
}

export interface PayrollOutputTotals {
  employees: number;
  basic: number;
  allowances: number;
  overtime: number;
  incentive: number;
  arrears: number;
  lop: number;
  gross: number;
  tds: number;
  ssf: number;
  employerSsf: number;
  advance: number;
  loan: number;
  deductions: number;
  employerCost: number;
  net: number;
}

export interface PayrollStatutoryTotals {
  gross: number;
  tds: number;
  employeeSsf: number;
  employerSsf: number;
  net: number;
}

export interface PayrollOutput {
  payslips: PayrollPayslip[];
  registerRows: PayrollRegisterRow[];
  totals: PayrollOutputTotals;
  statutory: PayrollStatutoryTotals;
}

export interface PayrollJournalSummary {
  id: string;
  journalNo: string;
  status: string;
  journalDateAD: string | null;
  totalDebit: number;
  totalCredit: number;
}

export interface PayrollReconciliation {
  matchesRun: boolean;
  matchesJournal: boolean;
  paymentMatchesRun: boolean | null;
  runGross: number;
  runTds: number;
  runSsf: number;
  runIncentive: number;
  runArrears: number;
  runNet: number;
  registerGross: number;
  registerTds: number;
  registerSsf: number;
  registerIncentive: number;
  registerArrears: number;
  registerNet: number;
  journalDebit: number | null;
  journalCredit: number | null;
  paymentDebit: number | null;
  paymentCredit: number | null;
}

const amount = (value: unknown): number => roundMoney(Number(value) || 0);

function employeeProjection(employee: any, line: any, includeSensitive: boolean) {
  // Bank details come from the run-line snapshot written when the run was
  // prepared. A later employee-master edit must not change a posted payslip,
  // register or bank file.
  const bankName = line?.bankName?.trim() || null;
  const bankAccount = line?.bankAccount?.trim() || null;
  const bankReady = Boolean(bankAccount);
  return {
    department: employee?.department || null,
    designation: employee?.designation || null,
    panNumber: includeSensitive ? employee?.panNumber || null : null,
    ssfNumber: includeSensitive ? employee?.ssfNumber || null : null,
    bankName: includeSensitive ? bankName : null,
    bankAccount: includeSensitive ? bankAccount : null,
    bankStatus: (bankReady ? 'READY' : 'MISSING') as 'READY' | 'MISSING',
    detailsRestricted:
      !includeSensitive &&
      Boolean(employee?.panNumber || employee?.ssfNumber || bankName || bankAccount),
  };
}

function payslipFor(
  run: any,
  line: any,
  employee: any,
  includeSensitive: boolean
): PayrollPayslip {
  const basicAmount = amount(line.basicAmount);
  const overtimeAmount = amount(line.overtimeAmount);
  const incentive = amount(line.incentive);
  const arrears = amount(line.arrears);
  const lopDeduction = amount(line.lopDeduction);
  const gross = amount(line.gross);
  const tds = amount(line.tds);
  const ssf = amount(line.ssf);
  const employerSsf = amount(line.employerSsf);
  const advance = amount(line.advance);
  const loan = amount(line.loan);
  const net = amount(line.net);
  return {
    employeeId: String(line.employeeId),
    employeeCode: String(line.employeeCode),
    employeeName: String(line.employeeName),
    ...employeeProjection(employee, line, includeSensitive),
    branchId: String(run.branchId),
    branchName: String(run.branchName || run.branchId),
    fiscalYearCode: run.fiscalYearCode || null,
    runNo: String(run.runNo),
    periodKey: String(run.periodKey),
    runDateAD: String(run.runDateAD),
    runDateBS: run.runDateBS || null,
    paidDateAD: run.paidDateAD || null,
    paymentMethod: run.paymentMethod || null,
    status: String(run.status),
    basicAmount,
    allowances: roundMoney(
      gross - basicAmount - overtimeAmount - incentive - arrears + lopDeduction
    ),
    payableDays: amount(line.payableDays),
    lopDays: amount(line.lopDays),
    lopDeduction,
    overtimeHours: amount(line.overtimeHours),
    overtimeAmount,
    incentive,
    arrears,
    gross,
    tds,
    ssf,
    employerSsf,
    advance,
    loan,
    totalDeductions: roundMoney(tds + ssf + advance + loan),
    employerCost: roundMoney(gross + employerSsf),
    net,
  };
}

export function buildPayrollOutput(
  run: any,
  lines: any[],
  employees: any[],
  includeSensitive: boolean
): PayrollOutput {
  const byId = new Map(employees.map((employee) => [String(employee.id), employee]));
  const payslips = lines.map((line) =>
    payslipFor(run, line, byId.get(String(line.employeeId)), includeSensitive)
  );
  const totals = payslips.reduce<PayrollOutputTotals>(
    (sum, payslip) => ({
      employees: sum.employees + 1,
      basic: roundMoney(sum.basic + payslip.basicAmount),
      allowances: roundMoney(sum.allowances + payslip.allowances),
      overtime: roundMoney(sum.overtime + payslip.overtimeAmount),
      incentive: roundMoney(sum.incentive + payslip.incentive),
      arrears: roundMoney(sum.arrears + payslip.arrears),
      lop: roundMoney(sum.lop + payslip.lopDeduction),
      gross: roundMoney(sum.gross + payslip.gross),
      tds: roundMoney(sum.tds + payslip.tds),
      ssf: roundMoney(sum.ssf + payslip.ssf),
      employerSsf: roundMoney(sum.employerSsf + payslip.employerSsf),
      advance: roundMoney(sum.advance + payslip.advance),
      loan: roundMoney(sum.loan + payslip.loan),
      deductions: roundMoney(sum.deductions + payslip.totalDeductions),
      employerCost: roundMoney(sum.employerCost + payslip.employerCost),
      net: roundMoney(sum.net + payslip.net),
    }),
    {
      employees: 0,
      basic: 0,
      allowances: 0,
      overtime: 0,
      incentive: 0,
      arrears: 0,
      lop: 0,
      gross: 0,
      tds: 0,
      ssf: 0,
      employerSsf: 0,
      advance: 0,
      loan: 0,
      deductions: 0,
      employerCost: 0,
      net: 0,
    }
  );
  return {
    payslips,
    registerRows: payslips.map((payslip) => ({
      employeeId: payslip.employeeId,
      employeeCode: payslip.employeeCode,
      employeeName: payslip.employeeName,
      department: payslip.department,
      designation: payslip.designation,
      bankName: payslip.bankName,
      bankAccount: payslip.bankAccount,
      bankStatus: payslip.bankStatus,
      detailsRestricted: payslip.detailsRestricted,
      paymentMethod: payslip.paymentMethod,
      incentive: payslip.incentive,
      arrears: payslip.arrears,
      gross: payslip.gross,
      tds: payslip.tds,
      ssf: payslip.ssf,
      employerSsf: payslip.employerSsf,
      advance: payslip.advance,
      loan: payslip.loan,
      totalDeductions: payslip.totalDeductions,
      net: payslip.net,
    })),
    totals,
    statutory: {
      gross: totals.gross,
      tds: totals.tds,
      employeeSsf: totals.ssf,
      employerSsf: totals.employerSsf,
      net: totals.net,
    },
  };
}

export interface PayrollBankFile {
  filename: string;
  csv: string;
  missingBankCodes: string[];
}

const quoted = (value: unknown): string =>
  `"${String(value ?? '').replace(/"/g, '""')}"`;

/**
 * A bank-ready, one-row-per-employee CSV. Accounts are always quoted so a
 * leading zero survives spreadsheet import; the amount stays numeric for the
 * bank's parser. The controller refuses the file when any beneficiary lacks a
 * bank name or account, rather than producing a silently incomplete batch.
 */
export function buildPayrollBankFile(run: any, output: PayrollOutput): PayrollBankFile {
  const rows = [...output.registerRows].sort((a, b) =>
    a.employeeCode.localeCompare(b.employeeCode)
  );
  const missingBankCodes = rows
    .filter((row) => !row.bankName?.trim() || !row.bankAccount?.trim())
    .map((row) => row.employeeCode);
  const narration = `Salary ${run.periodKey} ${run.runNo}`;
  const lines = [
    'Employee Code,Beneficiary Name,Bank Name,Bank Account Number,Amount (NPR),Narration',
    ...rows.map((row) =>
      [
        quoted(row.employeeCode),
        quoted(row.employeeName),
        quoted(row.bankName),
        quoted(row.bankAccount),
        row.net.toFixed(2),
        quoted(narration),
      ].join(',')
    ),
  ];
  const safeRunNo = String(run.runNo || run.id || 'run').replace(/[^A-Za-z0-9._-]+/g, '-');
  return {
    filename: `payroll-bank-file-${safeRunNo}.csv`,
    csv: `${lines.join('\r\n')}\r\n`,
    missingBankCodes,
  };
}

export function buildPayrollReconciliation(
  run: any,
  output: PayrollOutput,
  journal: PayrollJournalSummary | null,
  paymentJournal: PayrollJournalSummary | null
): PayrollReconciliation {
  const runGross = amount(run.grossTotal);
  const runTds = amount(run.tdsTotal);
  const runSsf = amount(run.ssfTotal);
  const runAdvance = amount(run.advanceTotal);
  const runLoan = amount(run.loanTotal);
  const runIncentive = amount(run.incentiveTotal);
  const runArrears = amount(run.arrearsTotal);
  const runNet = amount(run.netTotal);
  const matchesRun =
    output.totals.gross === runGross &&
    output.totals.tds === runTds &&
    output.totals.ssf === runSsf &&
    output.totals.advance === runAdvance &&
    output.totals.loan === runLoan &&
    output.totals.incentive === runIncentive &&
    output.totals.arrears === runArrears &&
    output.totals.net === runNet;
  // The posting debits the full salary cost — gross wages plus the employer's
  // SSF share — because that share is a company cost the fund is owed. The
  // reconciliation has to expect the same total the journal was built from, or
  // every run would read as "journal does not match" the moment employer SSF
  // exists.
  const expectedJournalTotal = roundMoney(runGross + output.totals.employerSsf);
  return {
    matchesRun,
    matchesJournal: Boolean(
      journal &&
        journal.totalDebit === expectedJournalTotal &&
        journal.totalCredit === expectedJournalTotal
    ),
    paymentMatchesRun: paymentJournal
      ? paymentJournal.totalDebit === runNet && paymentJournal.totalCredit === runNet
      : null,
    runGross,
    runTds,
    runSsf,
    runIncentive,
    runArrears,
    runNet,
    registerGross: output.totals.gross,
    registerTds: output.totals.tds,
    registerSsf: output.totals.ssf,
    registerIncentive: output.totals.incentive,
    registerArrears: output.totals.arrears,
    registerNet: output.totals.net,
    journalDebit: journal?.totalDebit ?? null,
    journalCredit: journal?.totalCredit ?? null,
    paymentDebit: paymentJournal?.totalDebit ?? null,
    paymentCredit: paymentJournal?.totalCredit ?? null,
  };
}
