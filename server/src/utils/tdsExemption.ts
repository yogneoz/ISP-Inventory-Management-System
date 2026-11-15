/**
 * Fixed TDS exemption reasons for lender interest.
 *
 * A loan is TDS-applicable by default. When it is not, the reason must come
 * from this set so the register can be filtered, audited and reconciled.
 * `NO_INTEREST` is the only reason that does not require external evidence;
 * every other reason relies on a certificate, agreement clause, notification
 * or similar document.
 */
export const TDS_EXEMPTION_REASONS = [
  'RESIDENT_BANK',
  'RESIDENT_FI',
  'INTER_COOP',
  'NO_INTEREST',
  'TREATY',
  'EXEMPT_INCOME',
  'OTHER',
] as const;

export type TdsExemptionReason = (typeof TDS_EXEMPTION_REASONS)[number];

const TDS_EXEMPTION_REASON_SET = new Set<string>(TDS_EXEMPTION_REASONS);

export function parseTdsExemptionReason(value: unknown): TdsExemptionReason | null {
  const reason = String(value ?? '').trim().toUpperCase();
  return TDS_EXEMPTION_REASON_SET.has(reason) ? (reason as TdsExemptionReason) : null;
}

export function tdsExemptionRequiresReference(reason: TdsExemptionReason | null): boolean {
  return Boolean(reason && reason !== 'NO_INTEREST');
}
