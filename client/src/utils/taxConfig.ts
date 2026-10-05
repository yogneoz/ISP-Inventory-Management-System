/**
 * Company-wide default VAT rate, read from the SERVER-side company profile
 * (company_profile.default_tax_rate, editable in Company Setup) instead of a
 * hard-coded 13.
 *
 * App.tsx calls setDefaultTaxRate() whenever bootstrap delivers the profile,
 * so every form default and every "% VAT" label renders the configured rate.
 * 13 is Nepal's statutory VAT and is what applies only before the first
 * bootstrap lands (or when the profile carries no rate).
 */
let defaultTaxRate = 13;

/** Applies the server-configured rate; ignores missing/invalid/zero values. */
export function setDefaultTaxRate(rate?: number | null): void {
  const parsed = Number(rate);
  if (Number.isFinite(parsed) && parsed > 0) {
    defaultTaxRate = parsed;
  }
}

/** The configured default VAT rate percent (13 until the profile loads). */
export function getDefaultTaxRate(): number {
  return defaultTaxRate;
}
