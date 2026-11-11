/**
 * The one progressive TDS/SSF calculation.
 *
 * A salary preview and a generated payroll draft must never disagree about the
 * Finance Act in force. Both pass the resolved fiscal-year configuration here:
 * employee SSF reduces taxable gross, employer SSF is a company cost, and the
 * monthly slabs are applied progressively. Callers only add presentation.
 *
 * TDS is ANNUALISED. The configured slabs are monthly bands, and a month's
 * withholding is one twelfth of the liability its annual income creates — not
 * the liability of that single month taken in isolation. The two agree exactly
 * for a constant salary (scaling income and every band by 12 is linear), and
 * they diverge wherever they should: a month carrying an incentive or arrears
 * would otherwise be taxed at the wrong band.
 *
 * One-off period earnings (incentive, arrears) are not annualised — they happened
 * once. They are added to the year's projected taxable income and taxed at the
 * marginal annual rate they cause, which is what "withheld at source" means for
 * a bonus. Overtime is treated as recurring because it is earned every month.
 */
export interface StatutorySlabInput {
  lowerBound: number;
  upperBound: number | null;
  ratePercent: number;
}

export interface StatutoryCalculationInput {
  monthlyGross: number;
  /**
   * The part of `monthlyGross` that will NOT recur next month (incentive,
   * arrears). Defaults to 0, which keeps a plain salary calculation unchanged.
   */
  oneOffEarnings?: number;
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

/** Salary is withheld over twelve months. */
export const TDS_ANNUALISATION_MONTHS = 12;

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

/**
 * The configured slabs expressed as ANNUAL bands. A monthly band list is the
 * same policy divided by twelve, so annualising is a pure scale — which is why
 * a constant salary keeps exactly the withholding it had before.
 */
export function annualiseSlabs(slabs: StatutorySlabInput[]): StatutorySlabInput[] {
  return (slabs || []).map((slab) => ({
    lowerBound: round2(Number(slab.lowerBound ?? 0) * TDS_ANNUALISATION_MONTHS),
    upperBound:
      slab.upperBound === null || slab.upperBound === undefined
        ? null
        : round2(Number(slab.upperBound) * TDS_ANNUALISATION_MONTHS),
    ratePercent: Number(slab.ratePercent ?? 0),
  }));
}

export interface AnnualisedTdsInput {
  /** Taxable income that recurs every month (already net of employee SSF). */
  monthlyTaxableRecurring: number;
  /** Taxable income earned only in this period (incentive + arrears). */
  oneOffTaxable?: number;
  slabs: StatutorySlabInput[];
}

export interface AnnualisedTdsResult {
  /** What to withhold this month. */
  monthlyTds: number;
  /** The liability the year's projected income creates. */
  annualTds: number;
  /** The recurring salary's annual liability, before one-off income. */
  annualRecurringTds: number;
  /** The marginal tax the one-off income itself causes. */
  oneOffTds: number;
  /** Annual bands with the one-off income included (the marginal view). */
  appliedAnnualSlabs: StatutorySlabResult[];
  /** Monthly-band breakdown of the recurring salary, for display. */
  appliedMonthlySlabs: StatutorySlabResult[];
}

/**
 * Annualised withholding: one twelfth of the recurring salary's annual
 * liability, plus the marginal annual tax caused by this period's one-off
 * earnings. Returns 0 when there is no positive income to tax.
 */
export function annualisedTds(input: AnnualisedTdsInput): AnnualisedTdsResult {
  const monthlyTaxableRecurring = Math.max(0, round2(Number(input.monthlyTaxableRecurring) || 0));
  const oneOffTaxable = Math.max(0, round2(Number(input.oneOffTaxable) || 0));
  const slabs = input.slabs || [];
  const annualSlabs = annualiseSlabs(slabs);

  const annualRecurringIncome = round2(monthlyTaxableRecurring * TDS_ANNUALISATION_MONTHS);
  const recurring = progressiveTds(annualRecurringIncome, annualSlabs);
  const withOneOff = progressiveTds(round2(annualRecurringIncome + oneOffTaxable), annualSlabs);
  const oneOffTds = round2(withOneOff.total - recurring.total);
  const monthlyTds = round2(recurring.total / TDS_ANNUALISATION_MONTHS + oneOffTds);

  return {
    monthlyTds,
    annualTds: round2(withOneOff.total),
    annualRecurringTds: recurring.total,
    oneOffTds,
    appliedAnnualSlabs: withOneOff.applied,
    appliedMonthlySlabs: progressiveTds(monthlyTaxableRecurring, slabs).applied,
  };
}

export function calculateStatutory(input: StatutoryCalculationInput): StatutoryCalculation {
  const monthlyGross = round2(Number(input.monthlyGross) || 0);
  const basicAmount = round2(Number(input.basicAmount) || 0);
  const employeeSsfPercent = Number(input.employeeSsfPercent) || 0;
  const employerSsfPercent = Number(input.employerSsfPercent) || 0;
  // One-off earnings cannot exceed the period's gross.
  const oneOffEarnings = Math.min(
    monthlyGross,
    Math.max(0, round2(Number(input.oneOffEarnings) || 0))
  );
  const recurringGross = round2(Math.max(0, monthlyGross - oneOffEarnings));

  const employeeSsf = input.ssfEligible
    ? round2((basicAmount * employeeSsfPercent) / 100)
    : 0;
  const employerSsf = input.ssfEligible
    ? round2((basicAmount * employerSsfPercent) / 100)
    : 0;

  // Employee SSF is withheld every month, so it reduces the recurring base.
  const monthlyTaxableRecurring = round2(Math.max(0, recurringGross - employeeSsf));
  const taxableGross = round2(Math.max(0, monthlyGross - employeeSsf));
  const tds = annualisedTds({
    monthlyTaxableRecurring,
    oneOffTaxable: oneOffEarnings,
    slabs: input.slabs,
  });

  return {
    employeeSsf,
    employerSsf,
    totalSsf: round2(employeeSsf + employerSsf),
    taxableGross,
    monthlyTds: tds.monthlyTds,
    annualTds: tds.annualTds,
    netAfterStatutory: round2(monthlyGross - employeeSsf - tds.monthlyTds),
    // The month's own band breakdown: what the recurring salary is taxed
    // through. The one-off's marginal tax is reported by `annualTds`.
    slabs: tds.appliedMonthlySlabs,
  };
}
