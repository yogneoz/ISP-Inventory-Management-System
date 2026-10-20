/**
 * Shared serial gate (Slice 2 of the serial-register plan — see
 * docs/serial-register-audit.md).
 *
 * Slice 1 made `serial_log` the live register: posting a purchase invoice writes
 * the row for every received unit. Slice 2 makes the register the ONE authority
 * every consumer resolves against. Before this, each screen answered "is this
 * serial real, in stock, and mine?" its own way — sales matched `serial_log`,
 * stock operations matched the in-memory `customer_device_records` mirror, the
 * deploy path looked the serial up and then *silently skipped* the flip when it
 * was absent — so the same serial could be accepted by one endpoint and refused
 * by another, and a stale mirror decided the outcome.
 *
 * This module owns resolution and refusal, and nothing else:
 *
 *   resolve   — lock the unit's register row, then require that it exists, is
 *               consumable (IN_STOCK), sits at the acting branch, belongs to the
 *               product being drawn, and matches the PON (and MAC when given).
 *   refuse    — a typed, operator-readable reason. There is no silent skip.
 *
 * The lifecycle transition itself stays with the owning module (the sales claim
 * `SI_CLAIM_SERIAL_SQL`, the deploy flip `SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL`, the
 * damage quarantine), so each one keeps its own symmetric reversal and history
 * entry. The gate's lock is what makes those transitions race-safe.
 *
 * Everything here is pure except `resolveSerialGateInDb` / `resolveSerialGateInMemory`,
 * so the rules are unit-testable without a database.
 */
import { SERIAL_GATE_CONSUMABLE_STATUSES, SERIAL_GATE_LOCK_SQL } from '../models/inventory.repo';
import { macKey, normalizeMacAddress } from '../../../shared/macAddress';

/** Minimal DB/transaction client shape (pg's PoolClient is assignable). */
export interface SqlClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

/** A unit a screen is trying to draw from stock. */
export interface SerialGateEntry {
  deviceSerial: string;
  ponSerial: string;
  macAddress: string;
  productId: string;
  productName: string;
}

export interface SerialGatePlan {
  /** Entries in item order; empty when `error` is set. */
  entries: SerialGateEntry[];
  /** First shape/count failure, phrased for the operator; null when valid. */
  error: string | null;
}

/** Raised when an operation may not proceed; the controller maps `status`. */
export class SerialGateError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'SerialGateError';
  }
}

/** The product fields that decide whether a line carries serials. */
export interface SerialGateProduct {
  id?: string;
  name?: string;
  requiresSerialTracking?: boolean | null;
  trackingType?: string | null;
}

/** Case/trim key — the same key `uq_serial_log_device_serial` enforces. */
export function serialGateKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * The project-wide serial-tracking rule (matches the purchase planning, the
 * sales gate and the stock-ops gate): `QUANTITY_ONLY` never carries serials and
 * a product is tracked unless it explicitly opts out.
 */
export function isSerialTracked(product?: SerialGateProduct | null): boolean {
  if (!product) return false;
  if (String(product.trackingType || '') === 'QUANTITY_ONLY') return false;
  return product.requiresSerialTracking !== false;
}

/**
 * Legacy helper only — no endpoint demands a typed PON any more. The device
 * serial is the operation's only key: PON and MAC are resolved from the
 * register (see `hydrateSerialEntries`). Kept because trackers still ask
 * whether a product is a SERIAL_MAC_PON one.
 */
export function requiresPon(product?: SerialGateProduct | null): boolean {
  return String(product?.trackingType || '') === 'SERIAL_MAC_PON';
}

/**
 * Why a serial may not be drawn. Returned as data (not prose) so every caller
 * can phrase the refusal in its own terms while the RULE stays in one place.
 */
export type SerialGateViolation =
  | { code: 'DUPLICATE'; deviceSerial: string }
  | { code: 'UNKNOWN'; deviceSerial: string }
  | { code: 'WRONG_STATUS'; deviceSerial: string; status: string }
  | { code: 'WRONG_BRANCH'; deviceSerial: string; branchId: string }
  | { code: 'WRONG_PRODUCT'; deviceSerial: string }
  | { code: 'PON_REQUIRED'; deviceSerial: string }
  | { code: 'PON_MISMATCH'; deviceSerial: string; ponSerial: string }
  | { code: 'MAC_MISMATCH'; deviceSerial: string; macAddress: string };

/** One register row as the gate sees it. */
export interface SerialGateRow {
  deviceSerial?: unknown;
  ponSerial?: unknown;
  macAddress?: unknown;
  productId?: unknown;
  branchId?: unknown;
  status?: unknown;
}

export interface SerialGateRules {
  /** Branch the units are being drawn from. */
  branchId: string;
  /** Human label for that branch, used in refusals. */
  branchLabel?: string;
  /** Require the register row's product to equal the entry's product. */
  matchProduct?: boolean;
  /** Require a PON value and require it to match the register row. */
  requirePon?: boolean;
  /**
   * Match the PON whenever the caller supplied one, without requiring it.
   * Used by the screens whose PON is operator-entered on some products and
   * absent on others: a typed PON is always checked against the register, a
   * blank one is not demanded.
   */
  matchPonWhenProvided?: boolean;
  /** Match the MAC whenever the caller supplied one. */
  matchMac?: boolean;
  /** Statuses a unit may be drawn from (defaults to IN_STOCK only). */
  allowedStatuses?: readonly string[];
}

/**
 * Plans and shape-validates the units an operation will draw from one or more
 * lines: serial-tracked lines must supply exactly one device serial per unit,
 * and a device serial may appear only once across the whole operation.
 *
 * The DEVICE SERIAL is the only field an operator types (one-field UX): PON and
 * MAC are filled from the register rows by `hydrateSerialEntries` before the
 * gate rules run, so nothing here demands a typed PON or MAC. A line for a
 * product the catalog does not know is treated as serial-tracked when the
 * operator typed serials, so deliberately entered identity is never silently
 * dropped.
 */
export function planSerialGateEntries(
  items: Array<Record<string, any>>,
  products: SerialGateProduct[]
): SerialGatePlan {
  const entries: SerialGateEntry[] = [];
  const seen = new Set<string>();

  for (const item of items || []) {
    const product = (products || []).find((p) => p.id === item?.productId);
    const raw = Array.isArray(item?.deviceSerials) ? item.deviceSerials : [];
    const pairs = raw
      .map((s: any) => ({
        deviceSerial: String(typeof s === 'string' ? s : s?.deviceSerial || '').trim(),
        ponSerial: String(typeof s === 'string' ? '' : s?.ponSerial || '').trim(),
        macAddress: String(typeof s === 'string' ? '' : s?.macAddress || '').trim(),
      }))
      .filter((p) => p.deviceSerial.length > 0);
    const serialized = product ? isSerialTracked(product) : pairs.length > 0;
    if (!serialized && pairs.length === 0) continue;

    const name = String(item?.productName || product?.name || item?.productId || 'Item');
    const qty = Math.abs(Number(item?.quantity) || 0);
    if (serialized && pairs.length !== qty) {
      return {
        entries: [],
        error: `${name} is serial-tracked: ${qty} device serial(s) required, ${pairs.length} provided.`,
      };
    }
    for (const pair of pairs) {
      const key = serialGateKey(pair.deviceSerial);
      if (seen.has(key)) {
        return { entries: [], error: `Duplicate device serial ${pair.deviceSerial}.` };
      }
      seen.add(key);
      entries.push({
        deviceSerial: pair.deviceSerial,
        ponSerial: pair.ponSerial,
        macAddress: normalizeMacAddress(pair.macAddress),
        productId: String(item?.productId || ''),
        productName: name,
      });
    }
  }

  return { entries, error: null };
}

/**
 * Fills each entry's PON/MAC from its register row when the caller sent a
 * blank. The register is the authority for a unit's identity, so a screen that
 * captures only the device serial still resolves the full record before any
 * rule runs — and a caller that DID type a PON/MAC keeps it, so the mismatch
 * checks below remain real defence in depth.
 */
export function hydrateSerialEntries(
  entries: readonly SerialGateEntry[],
  rowsByKey: Map<string, SerialGateRow>
): SerialGateEntry[] {
  return entries.map((entry) => {
    const row = rowsByKey.get(serialGateKey(entry.deviceSerial));
    if (!row) return entry;
    return {
      ...entry,
      ponSerial: entry.ponSerial || String(row.ponSerial ?? '').trim(),
      macAddress: macKey(entry.macAddress || row.macAddress),
    };
  });
}

/** Register rows keyed by `serialGateKey(device_serial)` for violation checks. */
export function indexGateRows(rows: readonly SerialGateRow[]): Map<string, SerialGateRow> {
  const byKey = new Map<string, SerialGateRow>();
  for (const row of rows) byKey.set(serialGateKey(row?.deviceSerial), row);
  return byKey;
}

/**
 * The gate rule itself: the first reason (if any) that these units may not be
 * drawn. Pure — takes the register rows as data, so both the DB path and the
 * in-memory mirror path enforce byte-for-byte the same rule.
 */
export function findGateViolation(
  entries: readonly SerialGateEntry[],
  rowsByKey: Map<string, SerialGateRow>,
  rules: SerialGateRules
): SerialGateViolation | null {
  const allowed = (rules.allowedStatuses || SERIAL_GATE_CONSUMABLE_STATUSES).map((s) => String(s));
  const seen = new Set<string>();

  for (const entry of entries) {
    const key = serialGateKey(entry.deviceSerial);
    if (seen.has(key)) return { code: 'DUPLICATE', deviceSerial: entry.deviceSerial };
    seen.add(key);

    const row = rowsByKey.get(key);
    if (!row) return { code: 'UNKNOWN', deviceSerial: entry.deviceSerial };

    const status = String(row.status || '');
    if (!allowed.includes(status)) {
      return { code: 'WRONG_STATUS', deviceSerial: entry.deviceSerial, status };
    }
    if (rules.branchId && String(row.branchId || '') !== String(rules.branchId)) {
      return { code: 'WRONG_BRANCH', deviceSerial: entry.deviceSerial, branchId: String(row.branchId || '') };
    }
    if (rules.matchProduct !== false && row.productId && String(row.productId) !== entry.productId) {
      return { code: 'WRONG_PRODUCT', deviceSerial: entry.deviceSerial };
    }
    if (rules.requirePon) {
      if (!entry.ponSerial) return { code: 'PON_REQUIRED', deviceSerial: entry.deviceSerial };
    }
    if ((rules.requirePon || rules.matchPonWhenProvided) && entry.ponSerial) {
      if (String(row.ponSerial || '').trim().toUpperCase() !== entry.ponSerial.trim().toUpperCase()) {
        return { code: 'PON_MISMATCH', deviceSerial: entry.deviceSerial, ponSerial: entry.ponSerial };
      }
    }
    if (rules.matchMac !== false && entry.macAddress) {
      if (macKey(row.macAddress) !== macKey(entry.macAddress)) {
        return { code: 'MAC_MISMATCH', deviceSerial: entry.deviceSerial, macAddress: entry.macAddress };
      }
    }
  }

  return null;
}

/**
 * Operator-readable refusal. `action` is what the caller was trying to do
 * ("sold", "deployed", "marked damaged", …) and `productName` disambiguates
 * when a screen handles several lines at once.
 */
export function describeGateViolation(
  violation: SerialGateViolation,
  ctx: { action: string; branchLabel?: string; productName?: string }
): string {
  const at = ctx.branchLabel ? ` at ${ctx.branchLabel}` : '';
  const forProduct = ctx.productName && ctx.productName !== 'Item' ? ` for "${ctx.productName}"` : '';
  switch (violation.code) {
    case 'DUPLICATE':
      return `Duplicate device serial ${violation.deviceSerial} on this request.`;
    case 'UNKNOWN':
      return `Device serial ${violation.deviceSerial} is not in the serial register${at}${forProduct} — only IN_STOCK units can be ${ctx.action}.`;
    case 'WRONG_STATUS':
      return `Device serial ${violation.deviceSerial} is ${violation.status} (not IN_STOCK) — it cannot be ${ctx.action}.`;
    case 'WRONG_BRANCH':
      return `Device serial ${violation.deviceSerial} is held at branch ${violation.branchId || 'unknown'}${ctx.branchLabel ? `, not ${ctx.branchLabel}` : ''}.`;
    case 'WRONG_PRODUCT':
      return `Device serial ${violation.deviceSerial} belongs to a different product${forProduct}.`;
    case 'PON_REQUIRED':
      return `PON serial is required for device serial ${violation.deviceSerial}.`;
    case 'PON_MISMATCH':
      return `PON serial ${violation.ponSerial} does not match the register for device serial ${violation.deviceSerial}.`;
    case 'MAC_MISMATCH':
      return `MAC address ${violation.macAddress} does not match the register for device serial ${violation.deviceSerial}.`;
  }
}

/**
 * Locks and resolves the entries inside the caller's transaction. Refuses (throws
 * `SerialGateError`) rather than returning a partial result: a caller that
 * continues past this has every unit verified and locked, so its own lifecycle
 * flip cannot race another consumer of the same serial.
 */
export async function resolveSerialGateInDb(
  client: SqlClient,
  entries: readonly SerialGateEntry[],
  rules: SerialGateRules,
  ctx: { action: string; productName?: (entry: SerialGateEntry) => string }
): Promise<void> {
  if (entries.length === 0) return;
  const keys = [...new Set(entries.map((e) => serialGateKey(e.deviceSerial)))];
  const locked = await client.query(SERIAL_GATE_LOCK_SQL, [keys]);
  const rowsByKey = indexGateRows(locked.rows as SerialGateRow[]);
  const hydrated = hydrateSerialEntries(entries, rowsByKey);
  const violation = findGateViolation(hydrated, rowsByKey, rules);
  if (violation) {
    const entry = hydrated.find((e) => serialGateKey(e.deviceSerial) === serialGateKey((violation as any).deviceSerial));
    throw new SerialGateError(
      400,
      describeGateViolation(violation, {
        action: ctx.action,
        branchLabel: rules.branchLabel,
        productName: ctx.productName ? ctx.productName(entry as SerialGateEntry) : entry?.productName,
      })
    );
  }
}

/**
 * Demo mode (PostgreSQL down) twin: the same rule, enforced against the
 * in-memory register. Throws `SerialGateError` with the same message shape, so
 * both modes refuse identically.
 */
export function resolveSerialGateInMemory(
  rows: readonly SerialGateRow[],
  entries: readonly SerialGateEntry[],
  rules: SerialGateRules,
  ctx: { action: string; productName?: (entry: SerialGateEntry) => string }
): void {
  if (entries.length === 0) return;
  const rowsByKey = indexGateRows(rows);
  const hydrated = hydrateSerialEntries(entries, rowsByKey);
  const violation = findGateViolation(hydrated, rowsByKey, rules);
  if (violation) {
    const entry = hydrated.find((e) => serialGateKey(e.deviceSerial) === serialGateKey((violation as any).deviceSerial));
    throw new SerialGateError(
      400,
      describeGateViolation(violation, {
        action: ctx.action,
        branchLabel: rules.branchLabel,
        productName: ctx.productName ? ctx.productName(entry as SerialGateEntry) : entry?.productName,
      })
    );
  }
}
