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

export function calculateFixedAssetValues(input: FixedAssetDepreciationInput) {
  const acquisitionCost = Math.max(toNumber(input.acquisitionCost), 0);
  const rate = Math.max(toNumber(input.depreciationRatePercent), 0);
  const storedAccumulated = toNumber(input.accumulatedDepreciation);
  const storedNetBookValue = toNumber(input.netBookValue);
  const acquisitionDate = parseDate(input.acquisitionDateAD) ?? new Date(0);
  const asOfDate = parseDate(input.asOfDateAD) ?? acquisitionDate;

  const method = input.depreciationMethod || 'STRAIGHT_LINE';
  const isReducingBalance = method !== 'STRAIGHT_LINE';
  const monthsElapsed = Math.max(
    0,
    (asOfDate.getFullYear() - acquisitionDate.getFullYear()) * 12 +
      (asOfDate.getMonth() - acquisitionDate.getMonth()) +
      (asOfDate.getDate() >= acquisitionDate.getDate() ? 0 : -1)
  );

  let annualDepreciation = 0;
  let accumulatedDepreciation = storedAccumulated;

  if (acquisitionCost > 0 && rate > 0) {
    if (isReducingBalance) {
      const elapsedYears = monthsElapsed / 12;
      const multiplier = Math.pow(1 - rate / 100, elapsedYears);
      accumulatedDepreciation = Math.max(acquisitionCost * (1 - multiplier), 0);
      annualDepreciation = acquisitionCost * rate / 100;
    } else {
      accumulatedDepreciation = (acquisitionCost * rate * monthsElapsed) / (100 * 12);
      annualDepreciation = (acquisitionCost * rate) / 100;
    }
  }

  const netBookValue = acquisitionCost > 0
    ? Math.max(acquisitionCost - accumulatedDepreciation, 0)
    : storedNetBookValue;

  return {
    acquisitionCost,
    annualDepreciation,
    accumulatedDepreciation,
    netBookValue,
  };
}
