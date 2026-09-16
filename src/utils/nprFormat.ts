/**
 * Centralized, config-driven Money Formatting Utility
 *
 * Provides consistent formatting for all monetary values across the application.
 * Unlike the old NPR-only `formatNPR`, this module is *globally configurable* so
 * open-source installers around the world can set their own currency code,
 * symbol, grouping locale, symbol position and decimal precision — all from
 * Company Setup.
 *
 * Design decisions:
 * - Default currency is Nepalese Rupee (NPR) so existing behavior is unchanged.
 * - Formatting reads an app-wide `CurrencyConfig`. Set it once when the company
 *   profile loads (`setCurrencyConfig`) and every call site stays untouched.
 * - Integer values: {symbol} 1,234,567 (no decimals for whole numbers)
 * - Decimal values: {symbol} 1,234,567.89 (respects currencyDecimals)
 * - Zero/negative: {symbol} 0 / {symbol} -1,234.56
 * - Null/undefined/NaN: {symbol} 0
 *
 * Deprecation aliases (formatNPR*) are kept for backwards compatibility — the
 * names still exist but honour the *active* currency configuration.
 */

export interface CurrencyConfig {
  /** ISO 4217 code, e.g. 'NPR', 'USD', 'EUR', 'INR', 'GBP'. */
  code: string;
  /** Display symbol, e.g. 'Rs.', '$', '€', '₹', '£'. */
  symbol: string;
  /** BCP-47 locale used for grouping/decimals, e.g. 'en-IN', 'en-US', 'de-DE'. */
  locale: string;
  /** Whether the symbol is placed before ('$ 1,234') or after ('1,234 $') the number. */
  position: 'before' | 'after';
  /** Number of decimal places used for precise money display. */
  decimals: number;
}

export const DEFAULT_CURRENCY_CONFIG: CurrencyConfig = {
  code: 'NPR',
  symbol: 'NPR',
  locale: 'en-IN',
  position: 'before',
  decimals: 2,
};

/**
 * Maps a common currency code to sensible defaults.
 * Used by the Company Setup currency picker and to keep configurations sane
 * when a user only picks a code.
 */
export const CURRENCY_PRESETS: Record<string, Partial<CurrencyConfig>> = {
  NPR: { code: 'NPR', symbol: 'NPR', locale: 'en-IN', decimals: 2 },
  USD: { code: 'USD', symbol: '$', locale: 'en-US', decimals: 2 },
  EUR: { code: 'EUR', symbol: '€', locale: 'de-DE', decimals: 2 },
  GBP: { code: 'GBP', symbol: '£', locale: 'en-GB', decimals: 2 },
  INR: { code: 'INR', symbol: '₹', locale: 'en-IN', decimals: 2 },
  AUD: { code: 'AUD', symbol: 'A$', locale: 'en-AU', decimals: 2 },
  CAD: { code: 'CAD', symbol: 'C$', locale: 'en-CA', decimals: 2 },
  JPY: { code: 'JPY', symbol: '¥', locale: 'ja-JP', decimals: 0 },
  CNY: { code: 'CNY', symbol: '¥', locale: 'zh-CN', decimals: 2 },
  KRW: { code: 'KRW', symbol: '₩', locale: 'ko-KR', decimals: 0 },
  AED: { code: 'AED', symbol: 'د.إ', locale: 'ar-AE', decimals: 2 },
  SAR: { code: 'SAR', symbol: '﷼', locale: 'ar-SA', decimals: 2 },
  PKR: { code: 'PKR', symbol: '₨', locale: 'en-PK', decimals: 2 },
  BDT: { code: 'BDT', symbol: '৳', locale: 'en-BD', decimals: 2 },
  LKR: { code: 'LKR', symbol: 'Rs', locale: 'en-LK', decimals: 2 },
  THB: { code: 'THB', symbol: '฿', locale: 'th-TH', decimals: 2 },
  SGD: { code: 'SGD', symbol: 'S$', locale: 'en-SG', decimals: 2 },
  MYR: { code: 'MYR', symbol: 'RM', locale: 'en-MY', decimals: 2 },
  VND: { code: 'VND', symbol: '₫', locale: 'vi-VN', decimals: 0 },
  ZAR: { code: 'ZAR', symbol: 'R', locale: 'en-ZA', decimals: 2 },
  NGN: { code: 'NGN', symbol: '₦', locale: 'en-NG', decimals: 2 },
  BWP: { code: 'BWP', symbol: 'P', locale: 'en-BW', decimals: 2 },
};

/** Build a valid CurrencyConfig from partials (safe against missing pieces). */
export function resolveCurrencyConfig(partial?: Partial<CurrencyConfig>): CurrencyConfig {
  const preset = partial?.code ? CURRENCY_PRESETS[partial.code] : undefined;
  return {
    ...DEFAULT_CURRENCY_CONFIG,
    ...(preset || {}),
    ...(partial || {}),
  };
}

// ---------------------------------------------------------------------------
// App-wide active configuration (module state; no React needed)
// ---------------------------------------------------------------------------

let activeConfig: CurrencyConfig = { ...DEFAULT_CURRENCY_CONFIG };

/** Set the active currency configuration (call once after profile load). */
export function setCurrencyConfig(partial: Partial<CurrencyConfig>): CurrencyConfig {
  activeConfig = resolveCurrencyConfig(partial);
  return activeConfig;
}

/** Reset back to the NPR default (e.g. on logout / test teardown). */
export function resetCurrencyConfig(): void {
  activeConfig = { ...DEFAULT_CURRENCY_CONFIG };
}

/** Read the currently active currency configuration. */
export function getCurrencyConfig(): CurrencyConfig {
  return activeConfig;
}

// ---------------------------------------------------------------------------
// Core formatter
// ---------------------------------------------------------------------------

function applySymbol(formattedNumber: string, negative: boolean): string {
  const sign = negative ? '-' : '';
  if (activeConfig.position === 'after') {
    return `${sign}${formattedNumber} ${activeConfig.symbol}`.trim();
  }
  return `${sign}${activeConfig.symbol} ${formattedNumber}`.trim();
}

function toLocale(num: number, minFrac: number, maxFrac: number): string {
  return num.toLocaleString(activeConfig.locale, {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  });
}

/**
 * Format a value as money with smart decimal handling.
 * - Whole numbers show no decimals; meaningful decimals show currencyDecimals.
 * - Alias maintained as `formatNPR()` for backwards compatibility.
 */
export function formatMoney(value: number | string | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return applySymbol(toLocale(0, 0, 0), false);

  const absNum = Math.abs(num);
  const isWhole = absNum === Math.floor(absNum) || absNum - Math.floor(absNum) < 0.005;
  const dec = isWhole ? 0 : Math.min(activeConfig.decimals, 6);

  const formatted = toLocale(absNum, dec, dec);
  return applySymbol(formatted, num < 0);
}

/**
 * Format as money with forced currencyDecimals places (for precise financial reports).
 * Alias maintained as `formatNPRPrecise()` for backwards compatibility.
 */
export function formatMoneyPrecise(value: number | string | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return applySymbol(toLocale(0, activeConfig.decimals, activeConfig.decimals), false);

  const dec = Math.min(activeConfig.decimals, 6);
  const formatted = toLocale(Math.abs(num), dec, dec);
  return applySymbol(formatted, num < 0);
}

/**
 * Format as money with no decimals (for summary cards, inventory valuation).
 * Alias maintained as `formatNPRInteger()` for backwards compatibility.
 */
export function formatMoneyInteger(value: number | string | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return applySymbol(toLocale(0, 0, 0), false);

  const formatted = toLocale(Math.round(Math.abs(num)), 0, 0);
  return applySymbol(formatted, num < 0);
}

/**
 * Format raw number for table cells (no currency prefix, for export/sorting).
 */
export function formatRawNumber(value: number | string | null | undefined): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Format number as compact string (e.g., "1.23 L" for lakhs, "1.23 Cr" for crores).
 * Useful for dashboard summary cards with limited space.
 */
export function formatMoneyCompact(value: number | string | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return applySymbol(toLocale(0, 0, 0), false);

  const sign = num < 0 ? '-' : '';
  const absNum = Math.abs(num);
  const base = `${activeConfig.symbol} `;
  if (absNum >= 1e7) {
    return `${sign}${base}${(absNum / 1e7).toFixed(2)} Cr`;
  }
  if (absNum >= 1e5) {
    return `${sign}${base}${(absNum / 1e5).toFixed(2)} L`;
  }
  if (absNum >= 1e3) {
    return `${sign}${base}${(absNum / 1e3).toFixed(1)} K`;
  }
  return formatMoney(num);
}

/**
 * Parse a string that might be in money format back to a number.
 * Strips any currency symbol/code, commas, and whitespace.
 */
export function parseMoney(value: string): number {
  if (!value) return 0;
  const cleaned = value
    .replace(/,/g, '')
    .replace(/[^\d.\-+]/g, '')
    .trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// ---------------------------------------------------------------------------
// Backwards-compatible aliases (deprecated but widely referenced)
// ---------------------------------------------------------------------------

/** @deprecated Use `formatMoney` — honours the active currency config. */
export const formatNPR = formatMoney;
/** @deprecated Use `formatMoneyPrecise` — honours the active currency config. */
export const formatNPRPrecise = formatMoneyPrecise;
/** @deprecated Use `formatMoneyInteger` — honours the active currency config. */
export const formatNPRInteger = formatMoneyInteger;
/** @deprecated Use `formatMoneyCompact` — honours the active currency config. */
export const formatNPRCompact = formatMoneyCompact;
/** @deprecated Use `parseMoney` — honours the active currency config. */
export const parseNPR = parseMoney;