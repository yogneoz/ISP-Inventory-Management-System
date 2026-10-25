/**
 * SER-1 — serial lifecycle for stock operations (decision D2).
 *
 * Before this module, a PULLOUT / CONSUMABLE_ISSUE / STOCK_OUT operation
 * validated its device serials through the shared gate and then left them
 * IN_STOCK. The unit was physically gone but still sellable and deployable.
 *
 * One owner now maps the operation type to its register state and owns the
 * transition plus its symmetric reversal:
 *
 *   PULLOUT           IN_STOCK → IN_TRANSIT  (received at the destination, or
 *                                            reversed back to the source)
 *   CONSUMABLE_ISSUE  IN_STOCK → CONSUMED    (reversal → IN_STOCK)
 *   STOCK_OUT         IN_STOCK → SOLD        (reversal → IN_STOCK)
 *
 * Every write is scoped to the operation: source_type/source_id point at the
 * stock operation, and a reversal only restores rows it can prove that same
 * operation issued. Historical rows are deliberately not guessed.
 */
import type { SerialGateEntry } from './serialGate.service';
import { serialGateKey } from './serialGate.service';
import {
  SERIAL_LOG_ISSUE_ON_OPERATION_SQL,
  SERIAL_LOG_RECEIVE_PULLOUT_SQL,
  SERIAL_LOG_RESTORE_ON_OPERATION_REVERSAL_SQL,
} from '../models/inventory.repo';
import { parseHistoryJson } from './cdrSerialSync';
import { OperationError } from '../utils/operationError';

export type OperationIssueStatus = 'IN_TRANSIT' | 'CONSUMED' | 'SOLD';

/** The register state an operation type issues its units into, or null. */
export function issueStatusForOperation(opType: unknown): OperationIssueStatus | null {
  switch (String(opType || '').trim().toUpperCase()) {
    case 'PULLOUT':
      return 'IN_TRANSIT';
    case 'CONSUMABLE_ISSUE':
      return 'CONSUMED';
    case 'STOCK_OUT':
      return 'SOLD';
    default:
      return null;
  }
}

/** Minimal operation shape this module needs (DB row or in-memory mirror). */
export interface SerializableOperation {
  id: string;
  type?: string;
  branchId?: string;
  referenceNumber?: string;
  items?: any[];
  deviceSerials?: any[];
}

interface HistoryRow {
  status: string;
  sourceType: 'STOCK_OP';
  sourceId: string;
  dateAD: string;
  notes: string;
}

export function operationHistoryEntry(
  status: string,
  op: SerializableOperation,
  dateAD: string,
  notes: string
): string {
  const row: HistoryRow = {
    status,
    sourceType: 'STOCK_OP',
    sourceId: op.id,
    dateAD,
    notes,
  };
  return JSON.stringify([row]);
}

/** Serial keys listed on a DAMAGED_STOCK line (those units stay in DAMAGED). */
export function damagedStockSerialKeys(items: readonly any[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const item of items || []) {
    if (String(item?.condition || '').toUpperCase() !== 'DAMAGED_STOCK') continue;
    for (const serial of serialsOfItem(item)) keys.add(serialGateKey(serial));
  }
  return keys;
}

/** Every serial an operation line names, as plain strings. */
export function serialsOfItem(item: any): string[] {
  const raw = Array.isArray(item?.deviceSerials) ? item.deviceSerials : [];
  return raw
    .map((entry: any) =>
      String(typeof entry === 'string' ? entry : entry?.deviceSerial || '').trim()
    )
    .filter(Boolean);
}

/** Every serial an operation names across its lines. */
export function operationSerials(op: SerializableOperation): string[] {
  const items = Array.isArray(op.items) && op.items.length > 0
    ? op.items
    : [{ deviceSerials: op.deviceSerials }];
  return items.flatMap((item) => serialsOfItem(item));
}

/**
 * Issues the gate-resolved units. The gate has already locked each row, so a
 * refused UPDATE is a genuine race or a bug; throwing rolls the whole stock
 * operation back instead of leaving the register half-moved.
 */
export async function issueOperationSerialsInDb(
  client: any,
  entries: readonly SerialGateEntry[],
  op: SerializableOperation,
  timestampAD: string
): Promise<string[]> {
  const status = issueStatusForOperation(op.type);
  if (!status || entries.length === 0) return [];
  const branchId = String(op.branchId || '');
  const damaged = damagedStockSerialKeys(op.items);
  const issued: string[] = [];
  for (const entry of entries) {
    if (damaged.has(serialGateKey(entry.deviceSerial))) continue;
    const result = await client.query(SERIAL_LOG_ISSUE_ON_OPERATION_SQL, [
      status,
      op.id,
      operationHistoryEntry(
        status,
        op,
        timestampAD,
        `Issued by stock operation ${op.referenceNumber || op.id} (${op.type})`
      ),
      timestampAD,
      entry.deviceSerial,
      branchId,
    ]);
    if (result.rowCount !== 1) {
      throw new OperationError(
        409,
        `Device serial ${entry.deviceSerial} changed state before this operation could be posted. Nothing was saved; please retry.`
      );
    }
    issued.push(entry.deviceSerial);
  }
  return issued;
}

/**
 * Reverses this operation's own units. Only rows still in the issue status and
 * still attributed to this operation are restored, so a unit that has since
 * moved (sold, deployed, transferred) is never dragged back into stock.
 */
export async function restoreOperationSerialsInDb(
  client: any,
  op: SerializableOperation,
  reason: string,
  reversedBy: string,
  timestampAD: string
): Promise<string[]> {
  const status = issueStatusForOperation(op.type);
  if (!status) return [];
  const result = await client.query(SERIAL_LOG_RESTORE_ON_OPERATION_REVERSAL_SQL, [
    op.id,
    operationHistoryEntry(
      'IN_STOCK',
      op,
      timestampAD,
      `Restored — ${op.type} ${op.referenceNumber || op.id} reversed by ${reversedBy}: ${reason}`
    ),
    timestampAD,
    status,
    String(op.branchId || ''),
  ]);
  return (result.rows || []).map((row: any) => String(row.deviceSerial || '')).filter(Boolean);
}

/** Lands a received pullout's in-transit units at the destination warehouse. */
export async function receivePulloutSerialsInDb(
  client: any,
  op: SerializableOperation,
  destinationId: string,
  timestampAD: string
): Promise<string[]> {
  if (String(op.type || '').toUpperCase() !== 'PULLOUT') return [];
  const result = await client.query(SERIAL_LOG_RECEIVE_PULLOUT_SQL, [
    destinationId,
    op.id,
    operationHistoryEntry(
      'IN_STOCK',
      op,
      timestampAD,
      `Received at ${destinationId} — pullout ${op.referenceNumber || op.id}`
    ),
    timestampAD,
  ]);
  return (result.rows || []).map((row: any) => String(row.deviceSerial || '')).filter(Boolean);
}

// ---------------------------------------------------------------------------
// In-memory twins (PG-down demo mode) — same semantics as the SQL above.
// ---------------------------------------------------------------------------

type MirrorRow = {
  deviceSerial?: string;
  branchId?: string;
  customerId?: string | null;
  customerName?: string | null;
  status?: string;
  sourceType?: string;
  sourceId?: string;
  historyJson?: unknown;
  updatedAt?: string;
};

function appendHistory(prev: unknown, entry: string): string {
  return JSON.stringify([...parseHistoryJson(prev), ...parseHistoryJson(entry)]);
}

export function issueOperationSerialsInMemory<T extends MirrorRow>(
  rows: readonly T[],
  entries: readonly SerialGateEntry[],
  op: SerializableOperation,
  timestampAD: string
): T[] {
  const status = issueStatusForOperation(op.type);
  if (!status || entries.length === 0) return [...rows];
  const branchId = String(op.branchId || '');
  const damaged = damagedStockSerialKeys(op.items);
  const byKey = new Map(entries.map((entry) => [serialGateKey(entry.deviceSerial), entry]));
  return rows.map((row) => {
    const key = serialGateKey(row.deviceSerial);
    const entry = byKey.get(key);
    if (!entry || damaged.has(key)) return row;
    if (String(row.status || '') !== 'IN_STOCK' || String(row.branchId || '') !== branchId) return row;
    return {
      ...row,
      status,
      sourceType: 'STOCK_OP',
      sourceId: op.id,
      historyJson: appendHistory(
        row.historyJson,
        operationHistoryEntry(
          status,
          op,
          timestampAD,
          `Issued by stock operation ${op.referenceNumber || op.id} (${op.type})`
        )
      ),
      updatedAt: timestampAD,
    };
  });
}

export function restoreOperationSerialsInMemory<T extends MirrorRow>(
  rows: readonly T[],
  op: SerializableOperation,
  reason: string,
  reversedBy: string,
  timestampAD: string
): T[] {
  const status = issueStatusForOperation(op.type);
  if (!status) return [...rows];
  return rows.map((row) => {
    if (String(row.sourceId || '') !== String(op.id)) return row;
    if (String(row.status || '') !== status) return row;
    if (String(row.branchId || '') !== String(op.branchId || '')) return row;
    return {
      ...row,
      status: 'IN_STOCK',
      customerId: null,
      customerName: null,
      sourceType: 'STOCK_OP',
      sourceId: op.id,
      historyJson: appendHistory(
        row.historyJson,
        operationHistoryEntry(
          'IN_STOCK',
          op,
          timestampAD,
          `Restored — ${op.type} ${op.referenceNumber || op.id} reversed by ${reversedBy}: ${reason}`
        )
      ),
      updatedAt: timestampAD,
    };
  });
}

export function receivePulloutSerialsInMemory<T extends MirrorRow>(
  rows: readonly T[],
  op: SerializableOperation,
  destinationId: string,
  timestampAD: string
): T[] {
  if (String(op.type || '').toUpperCase() !== 'PULLOUT') return [...rows];
  return rows.map((row) => {
    if (String(row.sourceId || '') !== String(op.id)) return row;
    if (String(row.status || '') !== 'IN_TRANSIT') return row;
    return {
      ...row,
      status: 'IN_STOCK',
      branchId: destinationId,
      sourceType: 'STOCK_OP',
      sourceId: op.id,
      historyJson: appendHistory(
        row.historyJson,
        operationHistoryEntry(
          'IN_STOCK',
          op,
          timestampAD,
          `Received at ${destinationId} — pullout ${op.referenceNumber || op.id}`
        )
      ),
      updatedAt: timestampAD,
    };
  });
}
