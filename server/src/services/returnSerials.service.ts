/**
 * Return serials — one rule for both return flows.
 *
 * A return is the reverse of a document that already named its units, so the
 * operator should never type a unit's identity twice. The device serial is the
 * only thing scanned; MAC and PON are read from the serial register for the
 * document, not trusted from the browser. Everything here is pure except the
 * row loader, so the refusal wording and the checks are testable without a
 * database.
 *
 * The checks:
 *   1. a serial-tracked line supplies exactly one serial per unit;
 *   2. the same unit cannot appear twice in one return;
 *   3. every serial exists in `serial_log` and belongs to the line's product;
 *   4. it belongs to the original invoice's line (when that line recorded
 *      serials — legacy invoices may have none);
 *   5. it is in the state the return reverses: CUSTOMER_ASSIGNED for a sales
 *      return, IN_STOCK at the same branch for a purchase return.
 *
 * Check 5 is what keeps the register honest: an already-returned or
 * already-returned-to-vendor unit is refused instead of double-crediting stock
 * and rewriting a serial that no longer belongs to the document.
 */
import type { DeviceSerialPair } from '../../../client/src/types';

export interface ReturnSerialEntry {
  deviceSerial: string;
  ponSerial?: string;
  macAddress?: string;
}

export interface ReturnSerialLine {
  productId?: string;
  productName?: string;
  quantity?: unknown;
  deviceSerials?: unknown;
  [key: string]: unknown;
}

export interface SerialLogRow {
  deviceSerial: string;
  ponSerial?: string | null;
  macAddress?: string | null;
  productId?: string | null;
  productName?: string | null;
  branchId?: string | null;
  status?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
}

export type ReturnKind = 'PURCHASE' | 'SALES';

/** Serials are compared case-insensitively and trimmed, never re-cased in place. */
export function returnSerialKey(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

/** One stored entry, accepting the legacy bare-string form. */
export function normalizeReturnSerialEntry(raw: unknown): ReturnSerialEntry | null {
  if (typeof raw === 'string') {
    const deviceSerial = raw.trim();
    return deviceSerial ? { deviceSerial } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const deviceSerial = String(value.deviceSerial ?? '').trim();
  if (!deviceSerial) return null;
  return {
    deviceSerial,
    ponSerial: String(value.ponSerial ?? '').trim() || undefined,
    macAddress: String(value.macAddress ?? '').trim() || undefined,
  };
}

/** The serial entries a return line carries, in operator order. */
export function returnLineSerials(item: ReturnSerialLine): ReturnSerialEntry[] {
  return (Array.isArray(item.deviceSerials) ? item.deviceSerials : [])
    .map(normalizeReturnSerialEntry)
    .filter((entry): entry is ReturnSerialEntry => entry !== null);
}

/** Flat list of every device serial in a return (one entry per unit). */
export function collectReturnSerials(items: ReturnSerialLine[]): string[] {
  return items.flatMap((item) => returnLineSerials(item).map((entry) => entry.deviceSerial));
}

/**
 * Shape check before any document exists: the count must match the units being
 * returned, and no unit may be listed twice. `isSerialTracked` lets the caller
 * keep the product rule in one place (the controllers' shared predicate).
 */
export function validateReturnSerialCounts(
  items: ReturnSerialLine[],
  isSerialTracked: (productId: string | undefined) => boolean
): string | null {
  const seen = new Map<string, string>();
  for (const item of items) {
    const name = item.productName || item.productId || 'item';
    const qty = Math.abs(Number(item.quantity)) || 0;
    if (isSerialTracked(item.productId)) {
      const serials = returnLineSerials(item);
      if (serials.length !== qty) {
        return `${name} is serial-tracked: ${qty} serial(s) required, ${serials.length} provided.`;
      }
    }
    for (const entry of returnLineSerials(item)) {
      const key = returnSerialKey(entry.deviceSerial);
      const previous = seen.get(key);
      if (previous) {
        return `Device serial ${entry.deviceSerial} appears twice in this return (${previous} and ${name}).`;
      }
      seen.set(key, name);
    }
  }
  return null;
}

const requiredStatus = (kind: ReturnKind): string =>
  kind === 'SALES' ? 'CUSTOMER_ASSIGNED' : 'IN_STOCK';

/** What a returned unit must be, in words the operator can act on. */
function describeRequiredState(kind: ReturnKind): string {
  return kind === 'SALES'
    ? 'sold on a sales invoice (CUSTOMER_ASSIGNED)'
    : 'IN_STOCK at the return branch';
}

/** The unit serials the original invoice recorded for one product line. */
export function invoiceSerialKeys(invoiceItems: any[], productId: string | undefined): Set<string> {
  if (!productId) return new Set();
  const line = (invoiceItems || []).find((item) => item?.productId === productId);
  if (!line) return new Set();
  return new Set(
    (Array.isArray(line.deviceSerials) ? line.deviceSerials : [])
      .map((raw: unknown) => returnSerialKey(normalizeReturnSerialEntry(raw)?.deviceSerial))
      .filter(Boolean)
  );
}

/**
 * Register-side validation. `rows` is keyed by `returnSerialKey` so the lookup
 * is case-insensitive; a serial the register does not hold is refused by name.
 */
export function validateReturnSerialsAgainstRegister(
  items: ReturnSerialLine[],
  rows: Map<string, SerialLogRow>,
  ctx: { kind: ReturnKind; invoiceItems: any[]; branchId: string }
): string | null {
  const expectedStatus = requiredStatus(ctx.kind);
  for (const item of items) {
    const name = item.productName || item.productId || 'item';
    const keys = returnLineSerials(item).map((entry) => returnSerialKey(entry.deviceSerial));
    if (keys.length === 0) continue;

    const invoiceKeys = invoiceSerialKeys(ctx.invoiceItems, item.productId);
    for (const key of keys) {
      const row = rows.get(key);
      if (!row) {
        return `Device serial ${key} is not in the serial register — it cannot be returned.`;
      }
      if (item.productId && row.productId && String(row.productId) !== String(item.productId)) {
        return `Device serial ${key} belongs to ${row.productName || row.productId}, not ${name}.`;
      }
      if (invoiceKeys.size > 0 && !invoiceKeys.has(key)) {
        return `Device serial ${key} is not on the original invoice line for ${name}.`;
      }
      if (String(row.status || '').toUpperCase() !== expectedStatus) {
        return (
          `Device serial ${key} is ${row.status || 'in an unknown state'}; a return needs it ` +
          `${describeRequiredState(ctx.kind)}.`
        );
      }
      if (row.branchId && ctx.branchId && String(row.branchId) !== String(ctx.branchId)) {
        return `Device serial ${key} is held at branch ${row.branchId}, not ${ctx.branchId}.`;
      }
    }
  }
  return null;
}

/**
 * Writes the register's MAC/PON onto each returned unit, so the return document
 * carries the identity the register holds instead of whatever the browser sent.
 * Entries the register does not know keep their device serial only (the
 * validation above has already refused those, so this is a safety net).
 */
export function hydrateReturnSerialEntries(
  items: ReturnSerialLine[],
  rows: Map<string, SerialLogRow>
): void {
  for (const item of items) {
    if (!Array.isArray(item.deviceSerials)) continue;
    item.deviceSerials = returnLineSerials(item).map((entry) => {
      const row = rows.get(returnSerialKey(entry.deviceSerial));
      if (!row) return entry;
      const hydrated: DeviceSerialPair = {
        deviceSerial: String(row.deviceSerial || entry.deviceSerial).trim(),
        macAddress: String(row.macAddress ?? '').trim() || undefined,
        ponSerial: String(row.ponSerial ?? '').trim() || undefined,
      };
      return hydrated;
    });
  }
}

/**
 * Register rows reconstructed from an invoice's own lines. Used only when
 * PostgreSQL is down (demo mode): the invoice is then the sole authority, and
 * hydrating from it keeps the return document's MAC/PON identical to what the
 * sale recorded instead of accepting whatever the browser sent.
 */
export function serialRowsFromInvoiceItems(invoiceItems: any[]): Map<string, SerialLogRow> {
  const rows = new Map<string, SerialLogRow>();
  for (const line of invoiceItems || []) {
    for (const raw of Array.isArray(line?.deviceSerials) ? line.deviceSerials : []) {
      const entry = normalizeReturnSerialEntry(raw);
      if (!entry) continue;
      rows.set(returnSerialKey(entry.deviceSerial), {
        deviceSerial: entry.deviceSerial,
        ponSerial: entry.ponSerial || null,
        macAddress: entry.macAddress || null,
        productId: line.productId || null,
        productName: line.productName || null,
        branchId: null,
        status: null,
      });
    }
  }
  return rows;
}

/** Serial-log rows for a return's units, keyed by the case-insensitive serial. */
export const RETURN_SERIAL_ROWS_SQL = `SELECT device_serial AS "deviceSerial",
  pon_serial AS "ponSerial",
  mac_address AS "macAddress",
  product_id AS "productId",
  product_name AS "productName",
  branch_id AS "branchId",
  status,
  source_type AS "sourceType",
  source_id AS "sourceId"
 FROM serial_log
 WHERE lower(trim(device_serial)) = ANY($1::text[])`;

/**
 * Loads the register rows for a set of serials. Empty input performs no query,
 * so a quantity-only return never touches the serial register.
 */
export async function loadReturnSerialRows(
  executor: { query: (sql: string, params?: any[]) => Promise<any> },
  serials: string[]
): Promise<Map<string, SerialLogRow>> {
  const keys = [...new Set(serials.map((serial) => returnSerialKey(serial)).filter(Boolean))].map(
    (serial) => serial.toLowerCase()
  );
  const rows = new Map<string, SerialLogRow>();
  if (keys.length === 0) return rows;
  const result = await executor.query(RETURN_SERIAL_ROWS_SQL, [keys]);
  for (const row of result.rows || []) {
    rows.set(returnSerialKey(row.deviceSerial), row as SerialLogRow);
  }
  return rows;
}
