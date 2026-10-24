/**
 * Why a replacement serial was refused — in the operator's terms.
 *
 * Both exchange entry points (Customers → Device Serials modal and Stock
 * Operations → Device Exchange & Replacement) used to refuse with one generic
 * sentence: "must be an IN_STOCK unit of this branch in the serial register".
 * That sentence is true and useless: it names neither the serial the operator
 * scanned, nor the state the register actually holds, nor the branch, so a
 * technician cannot tell a typo from a unit sitting at the other branch from one
 * a colleague just assigned to a customer.
 *
 * The SERVER already phrases its refusals that way (`describeGateViolation` in
 * serialGate.service). This module is the client mirror of that phrasing, in ONE
 * place, so the two dialogs cannot drift apart again.
 */

/** The identity fields of a register row both callers can supply. */
export interface SerialCandidate {
  deviceSerial?: string | null;
  ponSerial?: string | null;
  macAddress?: string | null;
  productName?: string | null;
  branchId?: string | null;
  customerName?: string | null;
  status?: string | null;
}

/** Register status → the wording operators see in the Serial Log Register. */
const STATUS_LABELS: Record<string, string> = {
  IN_STOCK: 'IN STOCK',
  IN_TRANSIT: 'IN TRANSIT',
  CUSTOMER_ASSIGNED: 'CUSTOMER ASSIGNED',
  POP_LOCATION_ASSIGNED: 'POP LOCATION ASSIGNED',
  DAMAGED: 'DAMAGED',
  RETURNED: 'RETURNED',
  SOLD: 'SOLD',
  RETURNED_TO_VENDOR: 'RETURNED TO VENDOR',
};

export function serialStatusLabel(status?: string | null): string {
  const key = String(status || '').trim().toUpperCase();
  if (!key) return 'UNKNOWN';
  return STATUS_LABELS[key] || key.replace(/_/g, ' ');
}

/**
 * The HTTP status a rejected client call carries, or 0 when it has none.
 * `fetchJson` attaches `status` to every non-2xx rejection (services/api/http),
 * and a network drop rejects with a TypeError and no status at all.
 */
export function apiErrorStatus(error: unknown): number {
  const status = Number((error as { status?: unknown } | null | undefined)?.status);
  return Number.isFinite(status) && status > 0 ? status : 0;
}

/**
 * A 404 from the exchange lookup is the register's definitive "no such row".
 * Anything else — 500, a 503 database-down, 403, a dropped request — means the
 * register could not be consulted, which is NOT the same fact as "this unit
 * does not exist" (DF-15). Callers must not collapse the two.
 */
export function isSerialLookupNotFound(error: unknown): boolean {
  return apiErrorStatus(error) === 404;
}

/**
 * Copy for a lookup that failed for any reason other than a real 404. Shared so
 * both exchange dialogs and the inline serial field say the same thing.
 */
export const SERIAL_LOOKUP_FAILED_MESSAGE =
  'Could not check the serial register — the server may be unavailable. Try again.';

export interface ReplacementRefusalContext {
  /** The serial the operator typed or scanned. */
  serial: string;
  /** The register row for it, if any (cache first, server lookup second). */
  row?: SerialCandidate | null;
  /** Branch the exchange draws from. */
  branchId?: string | null;
  /** Human name for that branch, so the message never says "this branch". */
  branchName?: string | null;
  /** Product the replacement must be, when the screen enforces it. */
  productName?: string | null;
}

/**
 * One sentence an operator can act on: which serial, what state it is in, which
 * branch holds it, and the rule that refused it.
 */
export function describeReplacementRefusal({
  serial,
  row,
  branchId,
  branchName,
  productName,
}: ReplacementRefusalContext): string {
  const label = String(serial || '').trim() || 'That serial';
  const branch = String(branchName || branchId || '').trim();
  const at = branch ? ` at ${branch}` : '';

  if (!row) {
    // The branch is already named in `at`; repeating it here read as a stutter.
    return `${label} is not in the serial register${at} — a replacement must first be received into stock${branch ? ' there' : ' at this branch'}.`;
  }

  const status = String(row.status || '').trim().toUpperCase();
  if (status && status !== 'IN_STOCK') {
    const holder = row.customerName ? ` to ${row.customerName}` : '';
    return `${label} is ${serialStatusLabel(status)}${at}${holder} — only IN_STOCK units can be issued as a replacement.`;
  }

  if (branchId && row.branchId && String(row.branchId) !== String(branchId)) {
    return `${label} is IN_STOCK at ${row.branchId}, not ${branch}. Pick a unit from this branch.`;
  }

  if (productName && row.productName && row.productName.trim().toLowerCase() !== productName.trim().toLowerCase()) {
    return `${label} is a ${row.productName}, not the ${productName} this exchange needs.`;
  }

  return `${label} cannot be issued as a replacement${at}. Check the serial register for this unit.`;
}
