/**
 * Customer Device Serials (customer_device_records) ↔ Serial Log Register
 * (serial_log) synchronisation.
 *
 * Audit finding: the CDR surface owns four lifecycle mutations — assignment
 * (post_customerDevices), direct status patch (patch_status2: collect /
 * reverse / refund), approval-executed status change (misc post_process) and
 * device exchange (post_exchange) — and until now NONE of them touched
 * serial_log. The register therefore kept reporting collected, refunded or
 * exchanged units as CUSTOMER_ASSIGNED (or assigned units as IN_STOCK),
 * so filtering the Serial Log Register by status disagreed with the Customer
 * Device Serials directory after every one of those actions.
 *
 * The two registers use different vocabularies; this module owns the mapping:
 *
 *   CDR status                    → serial_log status
 *   -------------------------------------------------------------
 *   ACTIVE / RENTAL / SUSPENDED / SOLD → CUSTOMER_ASSIGNED (with customer)
 *   ROUTER_COLLECTED / DISCONNECTED /
 *   RETURNED / REFUND / IN_STOCK      → IN_STOCK (customer cleared)
 *   EXCHANGED                         → handled by the exchange flow itself
 *                                       (old serial is restocked or damaged
 *                                       per oldDeviceAction, never mapped here)
 *
 * The serial flip is UPDATE-if-exists only: the register records units the
 * business actually received, so a CDR row naming a serial the register has
 * never seen must not fabricate a register entry.
 */
import type { TransactionLog } from '../../../client/src/types';

/**
 * CDR statuses that mean the customer currently holds the device. These are
 * the statuses a re-deployment must NOT overwrite: the register already
 * tracks that unit as out with a customer.
 */
export const ACTIVE_CDR_STATUSES = ['ACTIVE', 'RENTAL', 'SUSPENDED', 'SOLD'] as const;

/**
 * Result of a register write keyed on the device serial.
 *
 * - INSERTED the register had never seen this serial.
 * - REACTIVATED a closed row (collected / exchanged / refunded / in stock) was
 *   re-rented or took over an exchange, so its row was updated in place.
 * - ALREADY_ACTIVE an active row already tracks this serial; nothing changed.
 */
export type CdrRegisterAction = 'INSERTED' | 'REACTIVATED' | 'ALREADY_ACTIVE';

/** True when the status means a customer currently holds the device. */
export function isActiveCdrStatus(status: unknown): boolean {
  return (ACTIVE_CDR_STATUSES as readonly string[]).includes(
    String(status || '').trim().toUpperCase()
  );
}

/**
 * In-memory twin of the serial-keyed register write (demo mode / PG-down).
 * Mirrors CDR_SERIAL_ROW_SQL + CDR_REDEPLOY_BY_SERIAL_SQL + the plain insert:
 * a closed row for the same serial is replaced in place (customer_device_records
 * keeps one row per serial — a second row would fail the unique index), an
 * absent serial is prepended, and an active row is left alone.
 *
 * Returns a NEW array plus the action taken, so the demo path reports exactly
 * what the transactional path did.
 */
export function upsertCdrMirror<T extends { deviceSerial?: string; status?: string }>(
  rows: readonly T[],
  row: T
): { rows: T[]; action: CdrRegisterAction } {
  const key = String(row.deviceSerial || '').trim().toLowerCase();
  const idx = rows.findIndex(
    (r) => String(r.deviceSerial || '').trim().toLowerCase() === key
  );
  if (idx < 0) return { rows: [row, ...rows], action: 'INSERTED' };
  if (isActiveCdrStatus(rows[idx].status)) return { rows: [...rows], action: 'ALREADY_ACTIVE' };
  const next = [...rows];
  // Keep the register row's identity: only the rented-device state changes.
  next[idx] = { ...rows[idx], ...row, id: (rows[idx] as any).id ?? (row as any).id };
  return { rows: next, action: 'REACTIVATED' };
}

/** CDR status → serial_log status, or null when no automatic flip applies. */
export function serialStatusForCdrStatus(cdrStatus: string): string | null {
  switch (String(cdrStatus || '').toUpperCase()) {
    case 'ACTIVE':
    case 'RENTAL':
    case 'SUSPENDED':
    case 'SOLD':
      return 'CUSTOMER_ASSIGNED';
    case 'ROUTER_COLLECTED':
    case 'DISCONNECTED':
    case 'RETURNED':
    case 'REFUND':
    case 'IN_STOCK':
      return 'IN_STOCK';
    default:
      // EXCHANGED and unknown values are handled by their own flows.
      return null;
  }
}

/**
 * Device-exchange disposition → serial_log status for the OLD serial.
 * RESTOCK puts the unit back in service; DAMAGE and DISPOSED both leave it
 * out of service (the register displays DAMAGED as its out-of-service bucket;
 * the history entry carries the precise disposition note).
 */
export function serialStatusForExchangeAction(action: string): string {
  return String(action || '').toUpperCase() === 'RESTOCK' ? 'IN_STOCK' : 'DAMAGED';
}

/** History entry appended to serial_log.history_json by a CDR-driven flip. */
export function cdrHistoryEntry(
  status: string,
  sourceId: string,
  dateAD: string,
  notes: string
): string {
  return JSON.stringify([
    {
      status,
      sourceType: 'CUSTOMER_DEVICE',
      sourceId: sourceId || '',
      dateAD,
      notes,
    },
  ]);
}

/** Parses serial_log.history_json (string | array) into an array. */
export function parseHistoryJson(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Mirrors a CDR-driven serial flip on the in-memory serial_log register
 * (demo mode / PG-down). Returns a NEW array with the matching row replaced;
 * an unmatched serial leaves the array untouched (same update-if-exists
 * semantics as SERIAL_LOG_SYNC_ON_CDR_SQL).
 */
export function flipSerialMirror<T extends { deviceSerial?: string; historyJson?: unknown }>(
  rows: readonly T[],
  deviceSerial: string,
  status: string,
  customerId: string | null,
  customerName: string | null,
  historyEntry: string
): T[] {
  const key = String(deviceSerial || '').trim().toUpperCase();
  if (!key) return [...rows];
  const idx = rows.findIndex(
    (row) => String(row.deviceSerial || '').trim().toUpperCase() === key
  );
  if (idx < 0) return [...rows];
  const prev = rows[idx];
  const clearCustomer = status === 'IN_STOCK';
  const next = {
    ...prev,
    status,
    customerId: clearCustomer ? null : customerId ?? (prev as any).customerId ?? null,
    customerName: clearCustomer ? null : customerName ?? (prev as any).customerName ?? null,
    historyJson: JSON.stringify([
      ...parseHistoryJson((prev as any).historyJson),
      ...parseHistoryJson(historyEntry),
    ]),
    updatedAt: new Date().toISOString(),
  } as T;
  const copy = [...rows];
  copy[idx] = next;
  return copy;
}
