/**
 * The one progressive TDS/SSF calculation.
 *
 * A salary preview and a generated payroll draft must never disagree about the
 * Finance Act in force. Both pass the resolved fiscal-year configuration here:
 * employee SSF reduces taxable gross, employer SSF is a company cost, and the
 * monthly slabs are applied progressively. Callers only add presentation.
 */

export interface StatutorySlabInput {
  lowerBound: number;
  upperBound: number | null;
  ratePercent: number;
}

export interface StatutoryCalculationInput {
  monthlyGross: number;
  basicAmount: number;
  ssfEligible: boolean;
  employeeSsfPercent: number;
  employerSsfPercent: number;
  slabs: StatutorySlabInput[];
}

export interface StatutorySlabResult extends StatutorySlabInput {
  taxableAmount: number;
  tdsAmount: number;
}

export interface StatutoryCalculation {
  employeeSsf: number;
  employerSsf: number;
  totalSsf: number;
  taxableGross: number;
  monthlyTds: number;
  annualTds: number;
  netAfterStatutory: number;
  slabs: StatutorySlabResult[];
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function progressiveTds(
  taxable: number,
  slabs: StatutorySlabInput[]
): { total: number; applied: StatutorySlabResult[] } {
  let total = 0;
  const applied = slabs.map((slab) => {
    const lower = Number(slab.lowerBound ?? 0);
    const upper = slab.upperBound === null ? null : Number(slab.upperBound);
    const rate = Number(slab.ratePercent ?? 0);
    const bandTop = upper === null ? taxable : Math.min(taxable, upper);
    const taxableAmount = taxable > lower ? round2(bandTop - lower) : 0;
    const tdsAmount = round2((taxableAmount * rate) / 100);
    total = round2(total + tdsAmount);
    return {
      lowerBound: lower,
      upperBound: upper,
      ratePercent: rate,
      taxableAmount,
      tdsAmount,
    };
  });
  return { total, applied };
}

export function calculateStatutory(input: StatutoryCalculationInput): StatutoryCalculation {
  const monthlyGross = round2(Number(input.monthlyGross) || 0);
  const basicAmount = round2(Number(input.basicAmount) || 0);
  const employeeSsfPercent = Number(input.employeeSsfPercent) || 0;
  const employerSsfPercent = Number(input.employerSsfPercent) || 0;
  const employeeSsf = input.ssfEligible
    ? round2((basicAmount * employeeSsfPercent) / 100)
    : 0;
  const employerSsf = input.ssfEligible
    ? round2((basicAmount * employerSsfPercent) / 100)
    : 0;
  const taxableGross = round2(Math.max(0, monthlyGross - employeeSsf));
  const tds = progressiveTds(taxableGross, input.slabs);
  const monthlyTds = tds.total;
  return {
    employeeSsf,
    employerSsf,
    totalSsf: round2(employeeSsf + employerSsf),
    taxableGross,
    monthlyTds,
    annualTds: round2(monthlyTds * 12),
    netAfterStatutory: round2(monthlyGross - employeeSsf - monthlyTds),
    slabs: tds.applied,
  };
}
