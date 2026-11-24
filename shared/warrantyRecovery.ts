import { businessDateAD } from './businessDate';
/**
 * Warranty recovery rules, shared by the API and the Recovery tab.
 *
 * Recovery is derived from the claim header and its posted vendor-credit
 * journal. Nothing here writes: the claim transition remains the authority for
 * expected/received credit and the journal remains the authority for the AP
 * credit that was actually posted.
 */

export const WARRANTY_RMA_AGING_BUCKETS = [
  { key: '0-7', label: '0–7 days', minDays: 0, maxDays: 7 },
  { key: '8-14', label: '8–14 days', minDays: 8, maxDays: 14 },
  { key: '15-30', label: '15–30 days', minDays: 15, maxDays: 30 },
  { key: '31+', label: '31+ days', minDays: 31, maxDays: null },
] as const;

export type WarrantyRmaAgingBucket = (typeof WARRANTY_RMA_AGING_BUCKETS)[number]['key'];

export type WarrantyRecoveryState =
  | 'NONE'
  | 'PENDING'
  | 'PARTIAL'
  | 'POSTING_MISMATCH'
  | 'RECONCILED';

export const WARRANTY_RECOVERY_STATE_LABELS: Readonly<Record<WarrantyRecoveryState, string>> = {
  NONE: 'No credit expected',
  PENDING: 'Credit pending',
  PARTIAL: 'Partial credit',
  POSTING_MISMATCH: 'Posting mismatch',
  RECONCILED: 'Reconciled',
};

export function warrantyRmaAgeDays(
  sentDateAD?: string | null,
  todayAD?: string
): number | null {
  if (!sentDateAD) return null;
  const start = Date.parse(`${String(sentDateAD).slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(
    `${String(todayAD || businessDateAD()).slice(0, 10)}T00:00:00Z`
  );
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

export function warrantyRmaAgingBucket(days: number | null | undefined): WarrantyRmaAgingBucket | null {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return null;
  const age = Math.max(0, Math.trunc(Number(days)));
  for (const bucket of WARRANTY_RMA_AGING_BUCKETS) {
    if (age >= bucket.minDays && (bucket.maxDays === null || age <= bucket.maxDays)) {
      return bucket.key;
    }
  }
  return null;
}

export function warrantyCreditShortfall(
  expectedCredit: unknown,
  receivedCredit: unknown
): number {
  const expected = Math.max(0, Number(expectedCredit) || 0);
  const received = Math.max(0, Number(receivedCredit) || 0);
  return Math.max(0, Math.round((expected - received) * 100) / 100);
}

/**
 * `POSTING_MISMATCH` means the claim says the vendor paid, but the linked
 * journal is absent or does not debit AP for the same amount. A partial credit
 * stays PARTIAL even when its posted amount matches the received amount.
 */
export function warrantyRecoveryState(input: {
  expectedCredit: unknown;
  receivedCredit: unknown;
  postedCredit?: unknown;
  journalId?: string | null;
}): WarrantyRecoveryState {
  const expected = Math.max(0, Number(input.expectedCredit) || 0);
  const received = Math.max(0, Number(input.receivedCredit) || 0);
  const posted = Math.max(0, Number(input.postedCredit) || 0);
  if (expected <= 0.005 && received <= 0.005) return 'NONE';
  if (warrantyCreditShortfall(expected, received) > 0.005) {
    return received > 0.005 ? 'PARTIAL' : 'PENDING';
  }
  if (received > 0.005 && (!input.journalId || Math.abs(posted - received) > 0.005)) {
    return 'POSTING_MISMATCH';
  }
  return 'RECONCILED';
}
