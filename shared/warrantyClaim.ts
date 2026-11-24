import { businessDateAD } from './businessDate';
/**
 * Warranty claim / RMA lifecycle, shared by the API and the register.
 *
 * The transition table is the single source of truth: the server refuses any
 * edge that is absent here, and the detail panel only offers the edges this
 * function returns. Keeping the rules in `shared/` means the browser cannot
 * present an action the server will reject.
 */

export type WarrantyClaimStatus =
  | 'REPORTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SENT_TO_VENDOR'
  | 'REPLACED'
  | 'REPAIRED'
  | 'CREDITED'
  | 'CLOSED';

export type WarrantyClaimResolution = 'REPLACED' | 'REPAIRED' | 'CREDITED';

export const WARRANTY_CLAIM_STATUSES: readonly WarrantyClaimStatus[] = [
  'REPORTED',
  'APPROVED',
  'REJECTED',
  'SENT_TO_VENDOR',
  'REPLACED',
  'REPAIRED',
  'CREDITED',
  'CLOSED',
];

export const WARRANTY_CLAIM_OPEN_STATUSES: readonly WarrantyClaimStatus[] = [
  'REPORTED',
  'APPROVED',
  'SENT_TO_VENDOR',
  'REPLACED',
  'REPAIRED',
  'CREDITED',
];

export const WARRANTY_CLAIM_RESOLVED_STATUSES: readonly WarrantyClaimResolution[] = [
  'REPLACED',
  'REPAIRED',
  'CREDITED',
];

export const WARRANTY_CLAIM_TRANSITIONS: Readonly<
  Record<WarrantyClaimStatus, readonly WarrantyClaimStatus[]>
> = {
  REPORTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['SENT_TO_VENDOR'],
  REJECTED: [],
  SENT_TO_VENDOR: ['REPLACED', 'REPAIRED', 'CREDITED'],
  REPLACED: ['CLOSED'],
  REPAIRED: ['CLOSED'],
  CREDITED: ['CLOSED'],
  CLOSED: [],
};

export const WARRANTY_CLAIM_STATUS_LABELS: Readonly<Record<WarrantyClaimStatus, string>> = {
  REPORTED: 'Reported',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SENT_TO_VENDOR: 'Sent to vendor',
  REPLACED: 'Replaced',
  REPAIRED: 'Repaired',
  CREDITED: 'Credited',
  CLOSED: 'Closed',
};

export function isWarrantyClaimStatus(value: unknown): value is WarrantyClaimStatus {
  return typeof value === 'string' && WARRANTY_CLAIM_STATUSES.includes(value.trim().toUpperCase() as WarrantyClaimStatus);
}

export function normalizeWarrantyClaimStatus(value: unknown): WarrantyClaimStatus | null {
  return isWarrantyClaimStatus(value)
    ? (value.trim().toUpperCase() as WarrantyClaimStatus)
    : null;
}

export function nextWarrantyClaimStatuses(status: WarrantyClaimStatus): WarrantyClaimStatus[] {
  return [...(WARRANTY_CLAIM_TRANSITIONS[status] || [])];
}

export function canTransitionWarrantyClaim(
  from: WarrantyClaimStatus,
  to: WarrantyClaimStatus
): boolean {
  return (WARRANTY_CLAIM_TRANSITIONS[from] || []).includes(to);
}

export function isWarrantyClaimResolution(value: unknown): value is WarrantyClaimResolution {
  return typeof value === 'string' && WARRANTY_CLAIM_RESOLVED_STATUSES.includes(value.trim().toUpperCase() as WarrantyClaimResolution);
}

/** A resolved claim may be closed; an unresolved or rejected claim may not. */
export function canCloseWarrantyClaim(status: WarrantyClaimStatus): boolean {
  return canTransitionWarrantyClaim(status, 'CLOSED');
}

/** Whole days from the report date to the close date (today while open). */
export function warrantyClaimSlaDays(
  reportedDateAD: string,
  closedDateAD?: string | null,
  todayAD?: string
): number {
  const start = Date.parse(`${String(reportedDateAD).slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(
    `${String(closedDateAD || todayAD || businessDateAD()).slice(0, 10)}T00:00:00Z`
  );
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}
