/**
 * Purchase → serial register (Slice 1 of the serial-register plan — see
 * docs/serial-register-audit.md).
 *
 * Posting a purchase invoice is the ONE place a brand-new device serial may
 * enter the system: the server writes one `serial_log` row per received unit
 * inside the invoice's own transaction, so the register is live and the sales /
 * stock gates work without a server restart. Every other screen is pick-only.
 *
 * This module holds the pure half — planning and validating an invoice's
 * entries, and the demo-mode (PG-down) mirror write — so both halves are
 * unit-testable without a database. The transactional half lives in
 * procurement.controller.ts (`registerPurchaseSerials`).
 */

import { normalizeMacAddress } from '../../../shared/macAddress';

/** The product fields that decide whether a line carries serials. */
export interface SerialTrackedProduct {
  id?: string;
  name?: string;
  sku?: string;
  requiresSerialTracking?: boolean | null;
  trackingType?: string | null;
}

/** One register entry for one received unit. */
export interface PurchaseSerialEntry {
  deviceSerial: string;
  ponSerial: string | null;
  macAddress: string | null;
  productId: string;
  productName: string;
  branchId: string;
}

/** History entry appended to `serial_log.history_json`. */
export interface SerialHistoryEntry {
  status: string;
  sourceType: string;
  sourceId: string;
  dateAD: string;
  notes: string;
}

export interface PurchaseSerialPlan {
  /** Entries in invoice order; empty when `error` is set. */
  entries: PurchaseSerialEntry[];
  /** First validation failure, phrased for the operator; null when valid. */
  error: string | null;
}

/** Raised by the transactional half; the controller maps it to an HTTP status. */
export class SerialRegisterError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'SerialRegisterError';
  }
}

/** Case/trim key — the same key `uq_serial_log_device_serial` enforces. */
export function serialKey(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

/**
 * The project-wide serial-tracking rule (matches the sales gate and the stock
 * ops gate): `QUANTITY_ONLY` products never carry serials, and a product is
 * tracked unless it explicitly opts out.
 */
export function isSerialTrackedProduct(product?: SerialTrackedProduct | null): boolean {
  if (!product) return false;
  if (String(product.trackingType || '') === 'QUANTITY_ONLY') return false;
  return product.requiresSerialTracking !== false;
}

/**
 * MAC is mandatory for SERIAL_MAC_PON products. PON is optional: several ONU
 * models ship without one printed, and the field stays available so an
 * operator can record it when the device does carry one.
 */
export function requiresMac(product?: SerialTrackedProduct | null): boolean {
  return String(product?.trackingType || '') === 'SERIAL_MAC_PON';
}

/**
 * Plans and validates the register entries for an invoice's lines.
 *
 * Rejections (the invoice must post nothing): a serial-tracked line whose
 * device-serial count does not equal its quantity, a missing MAC on a
 * SERIAL_MAC_PON product, and a device serial / PON / MAC repeated within the
 * invoice. PON is optional and stored as null when blank. Lines for a product
 * the catalog does not know are treated as serial-tracked when the operator
 * typed serials, so deliberately entered identity is never silently dropped.
 */
export function planPurchaseSerialEntries(
  items: Array<Record<string, any>>,
  products: SerialTrackedProduct[],
  branchId: string
): PurchaseSerialPlan {
  const entries: PurchaseSerialEntry[] = [];
  const seenDevice = new Set<string>();
  const seenPon = new Set<string>();
  const seenMac = new Set<string>();

  for (const item of items || []) {
    const product = (products || []).find((p) => p.id === item?.productId);
    const raw = Array.isArray(item?.deviceSerials) ? item.deviceSerials : [];
    const pairs = raw
      .map((s: any) => ({
        deviceSerial: String(typeof s === 'string' ? s : s?.deviceSerial || '').trim(),
        ponSerial: String(typeof s === 'string' ? '' : s?.ponSerial || '').trim(),
        macAddress: normalizeMacAddress(typeof s === 'string' ? '' : s?.macAddress || ''),
      }))
      .filter((p) => p.deviceSerial.length > 0);
    const serialized = product ? isSerialTrackedProduct(product) : pairs.length > 0;
    if (!serialized) continue;

    const name = String(item?.productName || product?.name || item?.productId || 'Item');
    const qty = Math.abs(Number(item?.quantity) || 0);
    if (pairs.length !== qty) {
      return {
        entries: [],
        error: `${name} is serial-tracked: ${qty} device serial(s) required, ${pairs.length} provided.`,
      };
    }

    const strict = requiresMac(product);
    for (const pair of pairs) {
      const deviceKey = serialKey(pair.deviceSerial);
      if (seenDevice.has(deviceKey)) {
        return { entries: [], error: `Duplicate device serial ${pair.deviceSerial} on this purchase invoice.` };
      }
      seenDevice.add(deviceKey);
      if (strict && !pair.macAddress) {
        return { entries: [], error: `MAC address is required for device serial ${pair.deviceSerial}.` };
      }
      if (pair.ponSerial) {
        const ponKey = serialKey(pair.ponSerial);
        if (seenPon.has(ponKey)) {
          return { entries: [], error: `Duplicate PON serial ${pair.ponSerial} on this purchase invoice.` };
        }
        seenPon.add(ponKey);
      }
      if (pair.macAddress) {
        // pair.macAddress is already canonical here, so a plain serial key is
        // enough for intra-bill duplicates.
        const macDuplicateKey = serialKey(pair.macAddress);
        if (seenMac.has(macDuplicateKey)) {
          return { entries: [], error: `Duplicate MAC address ${pair.macAddress} on this purchase invoice.` };
        }
        seenMac.add(macDuplicateKey);
      }
      entries.push({
        deviceSerial: pair.deviceSerial,
        ponSerial: pair.ponSerial || null,
        macAddress: normalizeMacAddress(pair.macAddress) || null,
        productId: String(item?.productId || ''),
        productName: name,
        branchId,
      });
    }
  }

  return { entries, error: null };
}

/** The register history entry a purchase receipt appends. */
export function purchaseRegisterHistoryEntry(
  inv: { id: string; invoiceNumber?: string },
  dateAD: string
): SerialHistoryEntry {
  return {
    status: 'IN_STOCK',
    sourceType: 'PURCHASE',
    sourceId: inv.id,
    dateAD: String(dateAD || '').split('T')[0],
    notes: `Received on purchase invoice ${inv.invoiceNumber || inv.id}`,
  };
}

export type SerialRegisterMirrorAction = 'INSERTED' | 'REACTIVATED' | 'DUPLICATE';

export interface SerialRegisterMirrorContext {
  id: string;
  timestamp: string;
  history: SerialHistoryEntry;
  sourceId: string;
}

/**
 * Demo-mode (PG-down) twin of the transactional register write, mirroring
 * procurement.controller.ts's sequence: an unseen serial is INSERTed, a row the
 * vendor took back (`RETURNED_TO_VENDOR`) is re-activated in place keeping its
 * id and history, and anything else is a DUPLICATE the caller must refuse.
 * Returns a NEW array, so the caller's state write stays explicit.
 */
export function applyRegisterEntryToMirror<T extends object>(
  rows: readonly T[],
  entry: PurchaseSerialEntry,
  ctx: SerialRegisterMirrorContext
): { rows: T[]; action: SerialRegisterMirrorAction } {
  const key = serialKey(entry.deviceSerial);
  const idx = rows.findIndex((r) => serialKey((r as any).deviceSerial) === key);
  const fields = {
    deviceSerial: entry.deviceSerial,
    ponSerial: entry.ponSerial ?? undefined,
    macAddress: entry.macAddress ?? undefined,
    productId: entry.productId || undefined,
    productName: entry.productName,
    branchId: entry.branchId,
    customerId: undefined,
    customerName: undefined,
    status: 'IN_STOCK',
    sourceType: 'PURCHASE',
    sourceId: ctx.sourceId,
  };

  if (idx < 0) {
    const row = {
      ...fields,
      id: ctx.id,
      history: [ctx.history],
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    } as unknown as T;
    return { rows: [row, ...rows], action: 'INSERTED' };
  }

  const existing = rows[idx] as any;
  if (String(existing.status || '') !== 'RETURNED_TO_VENDOR') {
    return { rows: [...rows], action: 'DUPLICATE' };
  }

  const next = [...rows];
  next[idx] = {
    ...(existing as object),
    ...fields,
    id: existing.id ?? ctx.id,
    history: [...(Array.isArray(existing.history) ? existing.history : []), ctx.history],
    updatedAt: ctx.timestamp,
  } as T;
  return { rows: next, action: 'REACTIVATED' };
}

/** The in-memory register row a serial already owns, if any. */
export function findMirrorRowBySerial<T extends object>(
  rows: readonly T[],
  deviceSerial: string
): T | undefined {
  const key = serialKey(deviceSerial);
  return rows.find((r) => serialKey((r as any).deviceSerial) === key);
}
