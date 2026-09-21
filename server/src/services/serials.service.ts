/**
 * Serial identity service — pure, unit-testable logic for the serial rename
 * cascade (previously inline in server.ts `handleUpdateSerials` and the dual
 * edit endpoint). No HTTP, no global state: everything is passed in.
 *
 * Serial identity rule (case-insensitive): two serial values are the same
 * identifier when their trimmed, uppercased forms are equal.
 */
import type { SerialLog } from '../../../client/src/types';

/** Minimal DB client surface (satisfied by pg clients from withTransaction). */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** Canonical serial normalization: trim + uppercase, empty string when falsy. */
export function normalizeSerial(v: unknown): string {
  return String(v || '').trim().toUpperCase();
}

/**
 * From server.ts: decides whether a serial_log / JSONB `deviceSerials` entry
 * matches any of the three old identifiers (any-one-of semantics; each old
 * identifier only participates when non-empty). Both sides are normalized
 * (trim + uppercase) — this also covers the server.ts fallback where an old
 * identifier is taken verbatim from a DB row rather than the request.
 */
export function serialRecordMatches(
  serial: any,
  oldDeviceSerial: string,
  oldPonSerial: string,
  oldMacAddress: string
): boolean {
  if (!serial || typeof serial !== 'object') return false;
  const ds = String(serial.deviceSerial || '').trim().toUpperCase();
  const ps = String(serial.ponSerial || '').trim().toUpperCase();
  const ms = String(serial.macAddress || '').trim().toUpperCase();
  const od = normalizeSerial(oldDeviceSerial);
  const op = normalizeSerial(oldPonSerial);
  const om = normalizeSerial(oldMacAddress);
  return (
    (!!od && ds === od) ||
    (!!op && ps === op) ||
    (!!om && ms === om)
  );
}

/** Parse a serial_log history_json value (string or array) into an array. */
export function parseSerialHistory(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v || '[]');
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * SQL exclusion fragments shared by the authoritative duplicate pre-check and
 * the in-transaction re-verify. `oldVals` are the device's previous identifiers
 * (already normalized); placeholder numbering starts at $2 because $1 is the
 * searched value. Produce '' when there are no old values.
 */
export function buildOldValueExclusions(oldVals: string[]): {
  deviceExclusion: string;
  ponExclusion: string;
  macExclusion: string;
  assetExclusion: string;
  /** serial_log device-serial exclusion (same shape as deviceExclusion). */
  notSelfDevice: string;
} {
  const placeholders = oldVals.map((_, i) => `lower(trim($${i + 2}))`).join(', ');
  const clause = (col: string) =>
    oldVals.length ? ` AND NOT (${col} IN (${placeholders}))` : '';
  return {
    deviceExclusion: clause('lower(trim(device_serial))'),
    ponExclusion: clause('lower(trim(pon_serial))'),
    macExclusion: clause('lower(trim(mac_address))'),
    assetExclusion: clause('lower(trim(tag_number))'),
    notSelfDevice: clause('lower(trim(device_serial))'),
  };
}

/** Extra WHERE fragments used by the customer_device_records duplicate check. */
export const CDR_DUP_EXTRA_FRAGMENTS = {
  macNotNull: ' AND mac_address IS NOT NULL',
};

export interface SerialRenameInput {
  oldDeviceSerial: string;
  oldPonSerial: string;
  oldMacAddress: string;
  newDeviceSerial: string;
  newPonSerial: string;
  newMacAddress: string | null;
}

export interface RenamedItemsResult {
  items: any[];
  updated: boolean;
}

/**
 * Pure JSONB rename over an operation's items array — renames matching serials
 * in each item's `deviceSerials` (and optionally `receivedSerials`) lists and
 * returns the new array plus whether anything changed. Used for the
 * purchase_invoices / shipments / stock_operations cascades.
 */
export function renameSerialsInJsonbItems(
  items: any[],
  oldV: Pick<SerialRenameInput, 'oldDeviceSerial' | 'oldPonSerial' | 'oldMacAddress'>,
  newV: Pick<SerialRenameInput, 'newDeviceSerial' | 'newPonSerial' | 'newMacAddress'>
): RenamedItemsResult {
  let updated = false;
  const renameList = (list: any[]): any[] =>
    list.map((serial: any) => {
      if (serialRecordMatches(serial, oldV.oldDeviceSerial, oldV.oldPonSerial, oldV.oldMacAddress)) {
        updated = true;
        return {
          ...serial,
          deviceSerial: newV.newDeviceSerial,
          ponSerial: newV.newPonSerial,
          macAddress: newV.newMacAddress,
        };
      }
      return serial;
    });

  const next = items.map((item: any) => {
    if (item.deviceSerials && Array.isArray(item.deviceSerials)) {
      return { ...item, deviceSerials: renameList(item.deviceSerials) };
    }
    return item;
  });
  return { items: next, updated };
}

/**
 * Pure JSONB rename for shipment items, which additionally carry
 * `receivedSerials` on each item.
 */
export function renameSerialsInShipmentItems(
  items: any[],
  oldV: Pick<SerialRenameInput, 'oldDeviceSerial' | 'oldPonSerial' | 'oldMacAddress'>,
  newV: Pick<SerialRenameInput, 'newDeviceSerial' | 'newPonSerial' | 'newMacAddress'>
): RenamedItemsResult {
  let updated = false;
  const renameList = (list: any[]): any[] =>
    list.map((serial: any) => {
      if (serialRecordMatches(serial, oldV.oldDeviceSerial, oldV.oldPonSerial, oldV.oldMacAddress)) {
        updated = true;
        return {
          ...serial,
          deviceSerial: newV.newDeviceSerial,
          ponSerial: newV.newPonSerial,
          macAddress: newV.newMacAddress,
        };
      }
      return serial;
    });

  const next = items.map((item: any) => {
    let itemNext = item;
    if (item.deviceSerials && Array.isArray(item.deviceSerials)) {
      itemNext = { ...itemNext, deviceSerials: renameList(item.deviceSerials) };
    }
    if (item.receivedSerials && Array.isArray(item.receivedSerials)) {
      itemNext = { ...itemNext, receivedSerials: renameList(item.receivedSerials) };
    }
    return itemNext;
  });
  return { items: next, updated };
}

/**
 * In-memory serial_log rename (mirror of the DB path). Returns a new array:
 * the matching row renamed with a SERIAL_CORRECTION history entry appended, or
 * — when no row matched — a fresh IN_STOCK row unshifted at the front.
 * Duplicate detection is the caller's concern (`findInMemorySerialClash`).
 */
export function applyInMemorySerialRename(
  serialLogs: readonly SerialLog[],
  input: SerialRenameInput & { targetId?: string | null; branchId?: string | null; nowIso: string }
): SerialLog[] {
  const { nowIso } = input;
  const correctionEntry = {
    status: 'SERIAL_CORRECTION',
    sourceType: 'SERIAL_CORRECTION',
    sourceId: input.targetId || null,
    dateAD: nowIso.slice(0, 10),
    notes: `${input.oldDeviceSerial}→${input.newDeviceSerial}`,
  } as any;
  const oldKey = normalizeSerial(input.oldDeviceSerial).toLowerCase();
  const kept: SerialLog[] = [];
  let found = false;
  for (const s of serialLogs) {
    const k = String(s.deviceSerial || '').trim().toLowerCase();
    if (k === oldKey && !found) {
      found = true;
      kept.push({
        ...s,
        deviceSerial: input.newDeviceSerial,
        ponSerial: input.newPonSerial,
        macAddress: input.newMacAddress,
        history: [...(s.history || []), correctionEntry],
        updatedAt: nowIso,
      } as SerialLog);
    } else {
      kept.push(s);
    }
  }
  if (!found) {
    kept.unshift({
      id: `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      deviceSerial: input.newDeviceSerial,
      ponSerial: input.newPonSerial,
      macAddress: input.newMacAddress,
      productName: '',
      branchId: input.branchId || '',
      status: 'IN_STOCK',
      sourceType: 'SERIAL_CORRECTION',
      sourceId: input.targetId,
      history: [correctionEntry],
      createdAt: nowIso,
      updatedAt: nowIso,
    } as SerialLog);
  }
  return kept;
}

/**
 * Find a serial_log row (DB row shape or in-memory SerialLog) that already
 * holds the target device serial under a different identity. Returns the clash
 * or null. Used both for the in-memory 409 and for race re-verification.
 */
export function findInMemorySerialClash(
  serialLogs: ReadonlyArray<Pick<SerialLog, 'deviceSerial' | 'id'>>,
  newDeviceSerial: string,
  oldDeviceSerial: string
): { id: string | undefined } | null {
  const newKey = normalizeSerial(newDeviceSerial).toLowerCase();
  const oldKey = normalizeSerial(oldDeviceSerial).toLowerCase();
  if (oldKey === newKey) return null;
  const clash = serialLogs.find(
    (s) => String(s.deviceSerial || '').trim().toLowerCase() === newKey
  );
  return clash ? { id: clash.id } : null;
}

/**
 * Build the SERIAL_CORRECTION history entry and the serial_log rename /
 * create SQL used inside the rename transaction. Pure — the caller executes.
 */
export function buildSerialLogRenameStep(
  input: Pick<SerialRenameInput, 'oldDeviceSerial' | 'newDeviceSerial' | 'newPonSerial' | 'newMacAddress'> & {
    targetId?: string | null;
  },
  nowIso: string
): {
  correctionEntry: Record<string, unknown>;
  selectOldSql: string;
  updateSql: string;
  insertSql: string;
  /** params for updateSql given the existing row id + history array */
  updateParams: (rowId: string, history: any[]) => unknown[];
  /** params for insertSql given a generated id */
  insertParams: (id: string, branchId: string | null) => unknown[];
} {
  const correctionEntry = {
    status: 'SERIAL_CORRECTION',
    sourceType: 'SERIAL_CORRECTION',
    sourceId: input.targetId || null,
    dateAD: nowIso.slice(0, 10),
    notes: `${input.oldDeviceSerial}→${input.newDeviceSerial}`,
  };
  return {
    correctionEntry,
    selectOldSql:
      'SELECT id, history_json, status, product_name, branch_id, customer_id, customer_name FROM serial_log WHERE lower(trim(device_serial)) = lower(trim($1)) LIMIT 1',
    updateSql:
      `UPDATE serial_log SET device_serial = $1, pon_serial = $2, mac_address = $3,\n` +
      `  history_json = $4, updated_at = NOW() WHERE id = $5`,
    insertSql:
      `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_name, branch_id, status, source_type, source_id, history_json, created_at, updated_at, is_demo)\n` +
      ` VALUES ($1,$2,$3,$4,$5,$6,'IN_STOCK','SERIAL_CORRECTION',$7,$8,NOW(),NOW(),FALSE) ON CONFLICT DO NOTHING`,
    updateParams: (rowId: string, history: any[]) => [
      input.newDeviceSerial,
      input.newPonSerial,
      input.newMacAddress,
      JSON.stringify(history),
      rowId,
    ],
    insertParams: (id: string, branchId: string | null) => [
      id,
      input.newDeviceSerial,
      input.newPonSerial,
      input.newMacAddress,
      null,
      branchId,
      input.targetId || null,
      JSON.stringify([correctionEntry]),
    ],
  };
}

/**
 * Cascade rename inside one transaction: purchase_invoices, shipments and
 * stock_operations JSONB items are updated when they reference any of the old
 * identifiers. Verbatim port of the inline block (conditional three-identifier
 * ILIKE pre-select keeps placeholder counts correct).
 */
export async function cascadeRenameJsonbTables(
  client: SqlClient,
  oldV: Pick<SerialRenameInput, 'oldDeviceSerial' | 'oldPonSerial' | 'oldMacAddress'>,
  newV: Pick<SerialRenameInput, 'newDeviceSerial' | 'newPonSerial' | 'newMacAddress'>
): Promise<void> {
  const ilikeFragments = [
    'items::text ILIKE $1',
    oldV.oldPonSerial ? 'items::text ILIKE $2' : '',
    oldV.oldMacAddress ? 'items::text ILIKE $3' : '',
  ].filter(Boolean);
  const params = [
    `%${oldV.oldDeviceSerial}%`,
    ...(oldV.oldPonSerial ? [`%${oldV.oldPonSerial}%`] : []),
    ...(oldV.oldMacAddress ? [`%${oldV.oldMacAddress}%`] : []),
  ];
  const where = ilikeFragments.join(' OR ');

  // purchase_invoices (deviceSerials only)
  const piResult = await client.query(
    `SELECT id, items FROM purchase_invoices WHERE ${where}`,
    params
  );
  for (const row of piResult.rows) {
    const { items, updated } = renameSerialsInJsonbItems(row.items || [], oldV, newV);
    if (updated) {
      await client.query(`UPDATE purchase_invoices SET items = $1 WHERE id = $2`, [
        JSON.stringify(items),
        row.id,
      ]);
    }
  }

  // shipments (deviceSerials + receivedSerials)
  const shipResult = await client.query(`SELECT id, items FROM shipments WHERE ${where}`, params);
  for (const row of shipResult.rows) {
    const { items, updated } = renameSerialsInShipmentItems(row.items || [], oldV, newV);
    if (updated) {
      await client.query(`UPDATE shipments SET items = $1 WHERE id = $2`, [
        JSON.stringify(items),
        row.id,
      ]);
    }
  }

  // stock_operations (deviceSerials only)
  const soResult = await client.query(
    `SELECT id, items FROM stock_operations WHERE ${where}`,
    params
  );
  for (const row of soResult.rows) {
    const { items, updated } = renameSerialsInJsonbItems(row.items || [], oldV, newV);
    if (updated) {
      await client.query(`UPDATE stock_operations SET items = $1 WHERE id = $2`, [
        JSON.stringify(items),
        row.id,
      ]);
    }
  }
}
