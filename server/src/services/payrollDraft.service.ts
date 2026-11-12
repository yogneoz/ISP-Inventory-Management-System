/**
 * Generated payroll draft.
 *
 * A draft is a snapshot, not a projection: payable/LOP days, overtime, the
 * prorated basic, the employee and employer SSF split and TDS are written onto
 * each line when Finance prepares the month. Later attendance corrections or
 * a statutory-rate edit therefore cannot silently rewrite an approved run.
 *
 * Formula:
 *   lopDeduction = monthlyGross × lopDays / daysInMonth
 *   overtime     = overtimeHours × structure.overtimeRate
 *   gross        = monthlyGross − lopDeduction + overtime + incentive + arrears
 *   basic        = structure BASIC × (monthlyGross − lopDeduction) / monthlyGross
 *   employee SSF = basic × configured employee rate
 *   taxable      = gross − employee SSF
 *   TDS          = 0 when SSF-eligible (SSF includes salary tax), otherwise
 *                  progressive configured monthly slabs
 *   net          = gross − employee SSF − TDS − advance − loan
 *
 * Incentives and arrears are one-off period earnings, so they add to gross and
 * taxable pay after the monthly salary has been prorated for LOP. Advances and
 * loan installments are period recoveries and reduce net only. Employer SSF is
 * a company cost and is stored for reporting, not deducted from the employee or
 * credited by the payroll journal.
 */
import { ApiError } from '../errors/ApiError';
import { round2 } from './statutoryCalc.service';
import { calculateStatutory, type StatutorySlabInput } from './statutoryCalc.service';

export interface PayrollDraftInput {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  bankName?: string | null;
  bankAccount?: string | null;
  branchId: string;
  payableDays: number | string;
  lopDays: number | string;
  overtimeHours: number | string;
  incentiveAmount?: number | string;
  arrearsAmount?: number | string;
  advanceAmount?: number | string;
  loanAmount?: number | string;
}

export interface PayrollDraftComponent {
  componentCode: string;
  componentName?: string;
  kind: string;
  amount: number | string;
}

export interface PayrollDraftStructure {
  id: string;
  employeeId: string;
  ssfEligible: boolean;
  overtimeRate: number | string;
  components: PayrollDraftComponent[];
}

export interface PayrollDraftConfig {
  id: string;
  fiscalYearCode?: string;
  employeeSsfPercent: number | string;
  employerSsfPercent: number | string;
  slabs: StatutorySlabInput[];
}

export interface PayrollDraftLine {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  bankName: string | null;
  bankAccount: string | null;
  salaryId: string;
  basicAmount: number;
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
  /** The rates the two SSF shares were computed at, snapshotted onto the line. */
  employeeSsfPercent: number;
  employerSsfPercent: number;
  advance: number;
  loan: number;
  net: number;
}

export interface PayrollDraftTotals {
  gross: number;
  tds: number;
  ssf: number;
  advance: number;
  loan: number;
  incentive: number;
  arrears: number;
  net: number;
}

export interface PayrollDraft {
  lines: PayrollDraftLine[];
  totals: PayrollDraftTotals;
  statutoryConfigId: string;
  fiscalYearCode: string | null;
}

function daysInPeriod(periodKey: string): number {
  const [year, month] = periodKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function buildPayrollDraft(input: {
  periodKey: string;
  inputs: PayrollDraftInput[];
  structures: Map<string, PayrollDraftStructure>;
  config: PayrollDraftConfig;
  maxEmployees: number;
}): PayrollDraft {
  if (input.inputs.length === 0) {
    throw new ApiError(422, 'Payroll cannot be generated: there are no active employees in this branch.');
  }
  if (input.inputs.length > input.maxEmployees) {
    throw new ApiError(
      422,
      `Payroll holds at most ${input.maxEmployees} employees. Split the branch or contact an administrator.`
    );
  }

  const missing = input.inputs
    .filter((employee) => !input.structures.has(employee.employeeId))
    .map((employee) => employee.employeeCode);
  if (missing.length > 0) {
    throw new ApiError(
      422,
      `No salary structure is effective for: ${missing.join(', ')}. Add one before generating payroll.`
    );
  }

  const daysInMonth = daysInPeriod(input.periodKey);
  const lines: PayrollDraftLine[] = input.inputs.map((employee) => {
    const structure = input.structures.get(employee.employeeId)!;
    const earnings = structure.components
      .filter((component) => component.kind === 'EARNING')
      .reduce((sum, component) => round2(sum + Number(component.amount || 0)), 0);
    if (earnings <= 0) {
      throw new ApiError(
        422,
        `Salary structure for ${employee.employeeCode} has no earning components.`
      );
    }
    const basicAmount = round2(
      Number(
        structure.components.find((component) => component.componentCode === 'BASIC')?.amount ?? 0
      )
    );
    if (basicAmount <= 0) {
      throw new ApiError(
        422,
        `Salary structure for ${employee.employeeCode} has no BASIC component.`
      );
    }

    const lopDays = Math.min(
      daysInMonth,
      Math.max(0, round2(Number(employee.lopDays) || 0))
    );
    const lopDeduction = round2((earnings * lopDays) / daysInMonth);
    const reducedGross = round2(Math.max(0, earnings - lopDeduction));
    const overtimeHours = Math.max(0, round2(Number(employee.overtimeHours) || 0));
    const overtimeAmount = round2(overtimeHours * Number(structure.overtimeRate || 0));
    const incentive = Math.max(0, round2(Number(employee.incentiveAmount) || 0));
    const arrears = Math.max(0, round2(Number(employee.arrearsAmount) || 0));
    const advance = Math.max(0, round2(Number(employee.advanceAmount) || 0));
    const loan = Math.max(0, round2(Number(employee.loanAmount) || 0));
    const gross = round2(reducedGross + overtimeAmount + incentive + arrears);
    const proratedBasic = round2((basicAmount * reducedGross) / earnings);
    const statutory = calculateStatutory({
      monthlyGross: gross,
      // Incentives and arrears are one-off period earnings: they belong in the
      // year's taxable income once, not twelve times, so TDS annualises the
      // recurring salary and taxes these at the marginal annual rate.
      oneOffEarnings: round2(incentive + arrears),
      basicAmount: proratedBasic,
      ssfEligible: Boolean(structure.ssfEligible),
      employeeSsfPercent: Number(input.config.employeeSsfPercent),
      employerSsfPercent: Number(input.config.employerSsfPercent),
      slabs: input.config.slabs,
    });
    const net = round2(gross - statutory.employeeSsf - statutory.monthlyTds - advance - loan);
    if (net < 0) {
      throw new ApiError(
        422,
        `Deductions exceed gross pay for ${employee.employeeCode}. Check the salary structure, SSF eligibility and recovery inputs.`
      );
    }

    return {
      employeeId: employee.employeeId,
      employeeCode: employee.employeeCode,
      employeeName: employee.employeeName,
      bankName: employee.bankName?.trim() || null,
      bankAccount: employee.bankAccount?.trim() || null,
      salaryId: structure.id,
      basicAmount: proratedBasic,
      payableDays: round2(Number(employee.payableDays) || 0),
      lopDays,
      lopDeduction,
      overtimeHours,
      overtimeAmount,
      incentive,
      arrears,
      gross,
      tds: statutory.monthlyTds,
      ssf: statutory.employeeSsf,
      employerSsf: statutory.employerSsf,
      // Snapshot the rates alongside the amounts. The statutory configuration
      // can be edited after this draft is prepared (and legitimately must not
      // change a prepared run), so the line has to carry the rates it was paid
      // at for the SSF tie-out to recompute the contribution exactly.
      employeeSsfPercent: Number(input.config.employeeSsfPercent),
      employerSsfPercent: Number(input.config.employerSsfPercent),
      advance,
      loan,
      net,
    };
  });

  const totals = lines.reduce(
    (sum, line) => ({
      gross: round2(sum.gross + line.gross),
      tds: round2(sum.tds + line.tds),
      ssf: round2(sum.ssf + line.ssf),
      advance: round2(sum.advance + line.advance),
      loan: round2(sum.loan + line.loan),
      incentive: round2(sum.incentive + line.incentive),
      arrears: round2(sum.arrears + line.arrears),
      net: round2(sum.net + line.net),
    }),
    {
      gross: 0,
      tds: 0,
      ssf: 0,
      advance: 0,
      loan: 0,
      incentive: 0,
      arrears: 0,
      net: 0,
    }
  );
  if (totals.gross <= 0) {
    throw new ApiError(422, 'Payroll has no positive gross wage to prepare.');
  }

  return {
    lines,
    totals,
    statutoryConfigId: input.config.id,
    fiscalYearCode: input.config.fiscalYearCode || null,
  };
}
