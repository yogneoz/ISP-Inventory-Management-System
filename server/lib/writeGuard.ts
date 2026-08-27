/**
 * Durable write helpers for PostgreSQL-primary mode.
 *
 * Pattern for mutation routes:
 *   1. snapshot relevant store collections
 *   2. mutate memory
 *   3. writeThroughPg(...)  — throws if Postgres primary write fails
 *   4. saveDataStore + respond success
 *   5. on catch: restoreSnapshot + sendWriteFailure
 *
 * When Postgres is offline (pg-mem / memory mode), writeThroughPg is a no-op
 * and memory + JSON remain the working store.
 */
import type { Response } from 'express';
import * as store from '../store';
import { isPgConnected, isDurableSqlBackend } from './db';

export type SnapshotKey =
  | 'users'
  | 'suppliers'
  | 'products'
  | 'categories'
  | 'inventoryStock'
  | 'assetRegister'
  | 'customerDeviceRecords'
  | 'customerMasterRecords'
  | 'purchaseOrders'
  | 'purchaseInvoices'
  | 'shipments'
  | 'stockOperations'
  | 'auditTrail'
  | 'transactionLogs'
  | 'approvalRequests'
  | 'uomList'
  | 'locationRecords'
  | 'branches'
  | 'fiscalYears'
  | 'companyProfile';

export type StoreSnapshot = {
  collections: Partial<Record<SnapshotKey, any>>;
};

const COLLECTION_GETTERS: Record<Exclude<SnapshotKey, 'companyProfile'>, () => any[]> = {
  users: () => store.users,
  suppliers: () => store.suppliers,
  products: () => store.products,
  categories: () => store.categories,
  inventoryStock: () => store.inventoryStock,
  assetRegister: () => store.assetRegister,
  customerDeviceRecords: () => store.customerDeviceRecords,
  customerMasterRecords: () => store.customerMasterRecords,
  purchaseOrders: () => store.purchaseOrders,
  purchaseInvoices: () => store.purchaseInvoices,
  shipments: () => store.shipments,
  stockOperations: () => store.stockOperations,
  auditTrail: () => store.auditTrail,
  transactionLogs: () => store.transactionLogs,
  approvalRequests: () => store.approvalRequests,
  uomList: () => store.uomList,
  locationRecords: () => store.locationRecords,
  branches: () => store.branches,
  fiscalYears: () => store.fiscalYears,
};

function deepClone<T>(value: T): T {
  // structuredClone is available on Node 18+
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** Take a deep snapshot of one or more store collections (and optional company profile). */
export function snapshotStore(keys: SnapshotKey[]): StoreSnapshot {
  const collections: StoreSnapshot['collections'] = {};
  for (const key of keys) {
    if (key === 'companyProfile') {
      collections.companyProfile = deepClone(store.companyProfile);
    } else {
      collections[key] = deepClone(COLLECTION_GETTERS[key]());
    }
  }
  return { collections };
}

/** Restore store collections from a prior snapshot (best-effort rollback). */
export function restoreSnapshot(snapshot: StoreSnapshot | null | undefined): void {
  if (!snapshot?.collections) return;
  for (const [key, value] of Object.entries(snapshot.collections)) {
    if (key === 'companyProfile' && value) {
      store.setCompanyProfile(value);
      continue;
    }
    if (Array.isArray(value)) {
      store.replaceCollection(key as any, deepClone(value));
    }
  }
}

export class DurableWriteError extends Error {
  readonly statusCode: number = 503;
  readonly code = 'DURABLE_WRITE_FAILED';
  readonly operation: string;
  readonly causeMessage: string;
  readonly durable: boolean = true;

  constructor(operation: string, cause: unknown) {
    const causeMessage =
      cause instanceof Error
        ? cause.message
        : typeof cause === 'string'
          ? cause
          : 'Unknown database error';
    super(
      `Failed to persist "${operation}" to PostgreSQL primary database. The change was not saved. ${causeMessage}`
    );
    this.name = 'DurableWriteError';
    this.operation = operation;
    this.causeMessage = causeMessage;
  }
}

export function isDurableWriteError(err: unknown): err is DurableWriteError {
  return err instanceof DurableWriteError;
}

/**
 * Execute a PostgreSQL write when the primary backend is connected.
 * - Postgres mode: runs `sqlWork` and rethrows as DurableWriteError on failure.
 * - Offline modes: skips SQL (returns wroteToPg=false); caller keeps memory path.
 */
export async function writeThroughPg(
  operation: string,
  sqlWork: () => Promise<void>
): Promise<{ wroteToPg: boolean }> {
  if (!isPgConnected || !isDurableSqlBackend()) {
    return { wroteToPg: false };
  }
  try {
    await sqlWork();
    return { wroteToPg: true };
  } catch (err) {
    throw new DurableWriteError(operation, err);
  }
}

/**
 * Convenience: snapshot → run mutator (memory + optional PG via writeThroughPg inside) →
 * on DurableWriteError restore snapshot.
 *
 * Prefer calling snapshot/writeThrough/restore explicitly in complex handlers.
 */
export async function runDurableMutation<T>(options: {
  operation: string;
  collections: SnapshotKey[];
  mutate: () => Promise<T> | T;
}): Promise<T> {
  const snap = snapshotStore(options.collections);
  try {
    return await options.mutate();
  } catch (err) {
    restoreSnapshot(snap);
    throw err;
  }
}

/** Standard JSON error response for failed writes. */
export function sendWriteFailure(
  res: Response,
  err: unknown,
  operation?: string
): Response {
  if (isDurableWriteError(err)) {
    return res.status(err.statusCode).json({
      message: err.message,
      code: err.code,
      operation: err.operation,
      durable: true,
      detail: err.causeMessage,
    });
  }

  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unexpected server error';

  // If we are supposed to be on durable PG and something else blew up mid-write,
  // still signal that the write may not be durable.
  if (isPgConnected) {
    return res.status(503).json({
      message: `Database error while processing ${operation || 'write'}: ${message}`,
      code: 'DURABLE_WRITE_FAILED',
      operation: operation || 'unknown',
      durable: true,
      detail: message,
    });
  }

  return res.status(500).json({
    message: `Database error: ${message}`,
    code: 'WRITE_FAILED',
    operation: operation || 'unknown',
    durable: false,
  });
}

/** Persist JSON mirror after a successful durable (or memory-only) write. */
export function commitLocalMirror(): void {
  store.saveDataStore();
}
