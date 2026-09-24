export type DepreciationMethod =
  | 'STRAIGHT_LINE'
  | 'REDUCING_BALANCE'
  | 'DECLINING_BALANCE'
  | 'WRITTEN_DOWN_VALUE';

export interface FixedAssetDepreciationInput {
  acquisitionCost?: number;
  acquisitionDateAD?: string;
  asOfDateAD?: string;
  depreciationMethod?: string;
  depreciationRatePercent?: number;
  accumulatedDepreciation?: number;
  netBookValue?: number;
}

const toNumber = (value: number | undefined, fallback = 0) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
};

const parseDate = (value?: string) => {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Whole months elapsed between two dates, partial month truncated. */
function monthsElapsedBetween(acquisitionDate: Date, asOfDate: Date): number {
  return Math.max(
    0,
    (asOfDate.getFullYear() - acquisitionDate.getFullYear()) * 12 +
      (asOfDate.getMonth() - acquisitionDate.getMonth()) +
      (asOfDate.getDate() >= acquisitionDate.getDate() ? 0 : -1)
  );
}

export function calculateFixedAssetValues(input: FixedAssetDepreciationInput) {
  const acquisitionCost = Math.max(toNumber(input.acquisitionCost), 0);
  const rate = Math.max(toNumber(input.depreciationRatePercent), 0);
  const storedAccumulated = toNumber(input.accumulatedDepreciation);
  const storedNetBookValue = toNumber(input.netBookValue);
  const acquisitionDate = parseDate(input.acquisitionDateAD) ?? new Date(0);
  const asOfDate = parseDate(input.asOfDateAD) ?? acquisitionDate;

  const method = input.depreciationMethod || 'STRAIGHT_LINE';
  const isReducingBalance = method !== 'STRAIGHT_LINE';
  const monthsElapsed = monthsElapsedBetween(acquisitionDate, asOfDate);

  if (acquisitionCost <= 0 || rate <= 0) {
    // No depreciable basis: keep stored values verbatim.
    return {
      acquisitionCost,
      annualDepreciation: 0,
      accumulatedDepreciation: storedAccumulated,
      netBookValue: acquisitionCost > 0 ? Math.max(acquisitionCost - storedAccumulated, 0) : storedNetBookValue,
    };
  }

  // Current-year charge = the value destroyed by the most recent completed
  // YEAR of service: F(t) − F(t−12 months), where F is the accumulated-
  // depreciation function. Computed identically for every method, so the
  // annual column is honest for declining methods too (their charge shrinks
  // every year) instead of reporting the constant first-year amount.
  const annualDepreciation = isReducingBalance
    ? Math.max(
        0,
        acquisitionCost * (1 - Math.pow(1 - rate / 100, Math.max(0, monthsElapsed) / 12)) -
          acquisitionCost * (1 - Math.pow(1 - rate / 100, Math.max(0, monthsElapsed - 12) / 12))
      )
    : (acquisitionCost * rate) / 100;

  let accumulatedDepreciation: number;
  if (isReducingBalance) {
    // Reducing-balance is a compounding formula on the acquisition cost: the
    // formula value IS the accumulated depreciation at any point in time, so
    // it is authoritative. A stored value that disagrees would imply an
    // adjustment outside the method's own rules; the formula value wins so
    // the register stays internally consistent (and the current-year charge
    // above ties exactly to the accumulated figure).
    const formulaAccumulated = Math.max(acquisitionCost * (1 - Math.pow(1 - rate / 100, monthsElapsed / 12)), 0);
    accumulatedDepreciation = formulaAccumulated;
  } else {
    // Straight line accrues linearly by whole months from acquisition.
    accumulatedDepreciation = (acquisitionCost * rate * monthsElapsed) / (100 * 12);
  }

  // Never exceed the cost (a fully depreciated asset holds at salvage 0).
  accumulatedDepreciation = Math.min(Math.max(accumulatedDepreciation, 0), acquisitionCost);

  const netBookValue = Math.max(acquisitionCost - accumulatedDepreciation, 0);

  return {
    acquisitionCost,
    annualDepreciation,
    accumulatedDepreciation,
    netBookValue,
  };
}
