import express from 'express';
// BS calendar moved to config/bsCalendar.ts — re-exported for route files that import from '../app'
export { NEPALI_MONTHS_EN_SERVER, NEPALI_MONTHS_NP_SERVER, DAYS_OF_WEEK_EN_SERVER, DAYS_OF_WEEK_NP_SERVER, DEFAULT_BS_YEARS_SERVER, inMemoryBsCalendarYears, inMemoryBsDayRecords, setInMemoryBsCalendarYears, setInMemoryBsDayRecords, generateInMemoryBsDayRecords, detectDateTypeMismatch, findBsDayRecordForAdDate, hydrateBsCalendarFromDb, buildBsDayRecordsForYear } from './config/bsCalendar';

import type { SharedStateAccessors } from './sharedState';
import { VendorOpeningBalanceRow } from './sharedState';
import { registerSyncRoutes } from './routes/sync.routes';
import { registerPermissionsRoutes } from './routes/permissions.routes';
import { registerBootstrapRoutes } from './routes/bootstrap.routes';
import { registerMiscRoutes } from './routes/misc.routes';
import { registerAdminRoutes } from './routes/admin.routes';
import { registerAuthRoutes } from './routes/auth.routes';
import { registerMasterdataRoutes } from './routes/masterdata.routes';
import { registerInventoryRoutes } from './routes/inventory.routes';
import { registerProcurementRoutes } from './routes/procurement.routes';
import { registerShipmentsRoutes } from './routes/shipments.routes';
import { registerReportsRoutes } from './routes/reports.routes';
import { errorHandler } from './errors/errorHandler';
export { ApiError } from './errors/ApiError';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  User,
  Supplier,
  Branch,
  Product,
  CompanyProfile,
  InventoryStock,
  Asset,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  StockOperation,
  FiscalYear,
  AuditLog,
  TransactionLog,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  Category,
  UnitOfMeasure,
  LocationRecord,
  DocumentNumberConfig,
  DamageRecord,
  SerialLog,
  VendorPayment,
  VendorPaymentMethod,
  VendorPaymentStatus,
} from '../../client/src/types';
import { calculateFixedAssetValues } from '../../client/src/utils/depreciation';
import { DEFAULT_PERMISSIONS_MATRIX } from '../../client/src/utils/permissionMatrixData';

dotenv.config();

import { pgPool, realPoolInstance, setIsPgConnected, getIsPgConnected, ensurePostgresConnection } from '../db';
import { withPrepended, withAppended, withReplaced, withSorted, mutable } from './utils/copyHelpers';
export { withPrepended, withAppended, withReplaced, withSorted, mutable } from './utils/copyHelpers';
import { hashPassword, verifyPassword, issueAuthToken, getUserFromReq, verifyAuthToken } from './middleware/auth';
import { authenticateUser, requireAuth, requirePostgres, enforceFiscalYearWriteAccess, requireRole, enforceOperationalPermissions, enforceBranchAccess, requirePermission } from './middleware';
export { hashPassword, verifyPassword, issueAuthToken, getUserFromReq, verifyAuthToken } from './middleware/auth';
export { authenticateUser, requireAuth, requirePostgres, enforceFiscalYearWriteAccess, requireRole, enforceOperationalPermissions, enforceBranchAccess, requirePermission } from './middleware';

import { INITIAL_COMPANY_PROFILE, INITIAL_DOCUMENT_NUMBER_CONFIGS, INITIAL_MASTER_UOM, INITIAL_MASTER_LOCATIONS, INITIAL_MASTER_BRANCHES, INITIAL_MASTER_FISCAL_YEARS, INITIAL_MASTER_SUPPLIERS, EXAMPLE_USER_PASSWORD, INITIAL_EXAMPLE_USERS } from './config/seedData';
export { INITIAL_COMPANY_PROFILE, INITIAL_DOCUMENT_NUMBER_CONFIGS, INITIAL_MASTER_UOM, INITIAL_MASTER_LOCATIONS, INITIAL_MASTER_BRANCHES, INITIAL_MASTER_FISCAL_YEARS, INITIAL_MASTER_SUPPLIERS, EXAMPLE_USER_PASSWORD, INITIAL_EXAMPLE_USERS } from './config/seedData';

import { NEPALI_MONTHS_EN_SERVER, NEPALI_MONTHS_NP_SERVER, DAYS_OF_WEEK_EN_SERVER, DAYS_OF_WEEK_NP_SERVER, DEFAULT_BS_YEARS_SERVER, inMemoryBsCalendarYears, inMemoryBsDayRecords, setInMemoryBsCalendarYears, setInMemoryBsDayRecords, generateInMemoryBsDayRecords, detectDateTypeMismatch, findBsDayRecordForAdDate, hydrateBsCalendarFromDb, buildBsDayRecordsForYear } from './config/bsCalendar';

// Re-exported for server/routes/*.routes.ts (they import shared runtime
// symbols from this module rather than from each other).
export { pgPool, realPoolInstance, ensurePostgresConnection, setIsPgConnected } from '../db';
import { fetchFiscalYears, fetchOperationalData, fetchOpeningStock, parseSerialHistory } from './models/bootstrap.repo';
// Re-exported for server/routes/bootstrap.routes.ts
export { fetchFiscalYears, fetchOperationalData, fetchOpeningStock, parseSerialHistory } from './models/bootstrap.repo';
import {
  parseSerialHistory as parseSerialHistoryValue,
  buildOldValueExclusions,
  renameSerialsInJsonbItems,
  renameSerialsInShipmentItems,
  applyInMemorySerialRename,
  findInMemorySerialClash,
  buildSerialLogRenameStep,
  cascadeRenameJsonbTables,
  CDR_DUP_EXTRA_FRAGMENTS,
} from './services/serials.service';
import {
  applyDualEdit,
  generateParkTag,
  validateDualEditPayload,
} from './services/serialEditCapture.service';
import {
  buildDamageRecordInsert,
  quarantineSerialsInDb,
  quarantineInMemorySerials,
  restoreSerialsInDb,
  restoreInMemorySerials,
  deriveDamageItems,
  validateReversalAvailability,
  buildReversalLedgerWithStock,
  mirrorReversal,
} from './services/damage.service';
let isPgConnected = false;

// In-memory permission matrix (populated at startup from PostgreSQL).
export let permissionMatrix: Record<string, Record<string, boolean>> = { ...DEFAULT_PERMISSIONS_MATRIX };

export const VALID_ROLES = new Set([
  'SUPER_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK',
  'ACCOUNTANT', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN', 'AUDITOR',
]);

export function validateRole(role: unknown): string {
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    throw new Error(`Invalid role '${role}'. Must be one of: ${[...VALID_ROLES].join(', ')}.`);
  }
  return role;
}

export const PORT = Number.parseInt(process.env.PORT || '3000', 10);

// ==========================================
// RUNTIME STATE & POSTGRESQL DATA HYDRATION
// ==========================================

// (Operational cache declarations live below, right after
// refreshOperationalCache; they cover users, suppliers, uomList, branches,
// fiscalYears and all operational tables.)

// Runtime state seeded from config/seedData.ts constants:
export let companyProfile: CompanyProfile = { ...INITIAL_COMPANY_PROFILE };
export let docNumberConfigs: DocumentNumberConfig[] = JSON.parse(JSON.stringify(INITIAL_DOCUMENT_NUMBER_CONFIGS));

// ---------------------------------------------------------------------------
// Operational cache — PostgreSQL is the single source of truth.
// These arrays are NOT hand-maintained mirrors. They are declared `readonly`
// so the typechecker rejects any in-place mirror mutation: after every
// PostgreSQL write path commits, it calls `await refreshOperationalCache()`,
// which re-reads ALL cache tables straight from the database through the
// bootstrap repository's column mappings (one serialized fan-out). Reads
// served from these arrays therefore always reflect PostgreSQL, and a
// accidentally-missed refresh self-heals on the next write. Non-PG demo mode
// (isPgConnected === false) keeps the legacy in-memory behavior by REASSIGNING
// the arrays (spread), never mutating them.
// ---------------------------------------------------------------------------
let refreshChain: Promise<void> = Promise.resolve();

export async function refreshOperationalCache(): Promise<void> {
  if (!isPgConnected) return;
  const run = refreshChain.then(async () => {
    try {
      const client = await pgPool.connect();
      try {
        for (const load of CACHE_LOADS) {
          try {
            const result = await client.query(load.query);
            load.apply(result.rows);
          } catch (e: any) {
            console.warn(`Operational cache refresh skipped for ${load.name}:`, e?.message || e);
          }
        }
      } finally {
        client.release();
      }
    } catch (err: any) {
      // Never crash a write because the follow-up read failed; the next
      // write's refresh will converge the cache.
      console.error('Operational cache refresh failed:', err?.message || err);
    }
  });
  refreshChain = run;
  return run;
}

// ---------------------------------------------------------------------------
// Shared-state accessors for server/routes/*.routes.ts — ESM imports are
// read-only bindings, so route modules mutate shared state through these.
// (isPgConnected accessors get unique names: db.ts already exports
// getIsPgConnected/setIsPgConnected which server.ts imports.)
// ---------------------------------------------------------------------------
// Shared-state accessors (typed contract in ./sharedState). Controllers and
// route files import these to mutate app-owned runtime state; the assertion
// below makes the compiler verify every signature against the contract.
export function setUsers(value: readonly User[]): void { users = value; }
export function setSuppliers(value: readonly Supplier[]): void { suppliers = value; }
export function setUomList(value: readonly UnitOfMeasure[]): void { uomList = value; }
export function setLocationRecords(value: readonly LocationRecord[]): void { locationRecords = value; }
export function setBranches(value: readonly Branch[]): void { branches = value; }
export function setFiscalYears(value: readonly FiscalYear[]): void { fiscalYears = value; }
export function setProducts(value: readonly Product[]): void { products = value; }
export function setCategories(value: readonly Category[]): void { categories = value; }
export function setInventoryStock(value: readonly InventoryStock[]): void { inventoryStock = value; }
export function setAssetRegister(value: readonly Asset[]): void { assetRegister = value; }
export function setCustomerDeviceRecords(value: readonly CustomerDeviceRecord[]): void { customerDeviceRecords = value; }
export function setCustomerMasterRecords(value: readonly CustomerRecord[]): void { customerMasterRecords = value; }
export function setPurchaseOrders(value: readonly PurchaseOrder[]): void { purchaseOrders = value; }
export function setPurchaseInvoices(value: readonly PurchaseInvoice[]): void { purchaseInvoices = value; }
export function setShipments(value: readonly Shipment[]): void { shipments = value; }
export function setStockOperations(value: readonly StockOperation[]): void { stockOperations = value; }
export function setAuditTrail(value: readonly AuditLog[]): void { auditTrail = value; }
export function setTransactionLogs(value: readonly TransactionLog[]): void { transactionLogs = value; }
export function setApprovalRequests(value: readonly ApprovalRequest[]): void { approvalRequests = value; }
export function setDamageRecords(value: readonly DamageRecord[]): void { damageRecords = value; }
export function setSerialLogs(value: readonly SerialLog[]): void { serialLogs = value; }
export function setVendorPayments(value: readonly VendorPayment[]): void { vendorPayments = value; }
export function setVendorOpeningBalances(value: readonly VendorOpeningBalanceRow[]): void { vendorOpeningBalances = value; }
export function setDocNumberConfigs(value: DocumentNumberConfig[]): void { docNumberConfigs = value; }
export function setPermissionMatrix(value: Record<string, Record<string, boolean>>): void { permissionMatrix = value; }
export function setCompanyProfile(value: CompanyProfile): void { companyProfile = value; }
export function setPgConnected(v: boolean): void { isPgConnected = v; }
export function setActiveUser(value: User): void { activeUser = value; }
export function getPgConnected(): boolean { return isPgConnected; }
export function getActiveUser(): User | null { return activeUser; }
export function getDataVersion(): number { return dataVersion; }
export function setDataVersion(v: number): void { dataVersion = v; }

// Compile-time conformance: every accessor must match SharedStateAccessors.
const sharedStateAccessors: SharedStateAccessors = {
  setUsers,
  setSuppliers,
  setUomList,
  setLocationRecords,
  setBranches,
  setFiscalYears,
  setProducts,
  setCategories,
  setInventoryStock,
  setAssetRegister,
  setCustomerDeviceRecords,
  setCustomerMasterRecords,
  setPurchaseOrders,
  setPurchaseInvoices,
  setShipments,
  setStockOperations,
  setAuditTrail,
  setTransactionLogs,
  setApprovalRequests,
  setDamageRecords,
  setSerialLogs,
  setVendorPayments,
  setVendorOpeningBalances,
  setDocNumberConfigs,
  setPermissionMatrix,
  setCompanyProfile,
  setPgConnected,
  setActiveUser,
  getPgConnected,
  getActiveUser,
  getDataVersion,
  setDataVersion,
};
export { sharedStateAccessors };

// Operational arrays initialized empty by default (refreshed from PostgreSQL
// at boot and after every write; see refreshOperationalCache above).
export let users: readonly User[] = [];
export let suppliers: readonly Supplier[] = [];
export let uomList: readonly UnitOfMeasure[] = [];
export let locationRecords: readonly LocationRecord[] = [];
export let branches: readonly Branch[] = [];
export let fiscalYears: readonly FiscalYear[] = [];
export let products: readonly Product[] = [];
export let categories: readonly Category[] = [];
export let inventoryStock: readonly InventoryStock[] = [];
export let assetRegister: readonly Asset[] = [];
export let customerDeviceRecords: readonly CustomerDeviceRecord[] = [];
export let customerMasterRecords: readonly CustomerRecord[] = [];
export let purchaseOrders: readonly PurchaseOrder[] = [];
export let purchaseInvoices: readonly PurchaseInvoice[] = [];
export let shipments: readonly Shipment[] = [];
export let stockOperations: readonly StockOperation[] = [];
export let auditTrail: readonly AuditLog[] = [];
export let transactionLogs: readonly TransactionLog[] = [];
export let approvalRequests: readonly ApprovalRequest[] = [];
export let damageRecords: readonly DamageRecord[] = [];
export let serialLogs: readonly SerialLog[] = [];
export let vendorPayments: readonly VendorPayment[] = [];
export let vendorOpeningBalances: readonly VendorOpeningBalanceRow[] = [];

// Standard Transaction ID Generator
// Pattern: {BRANCH_CODE}-{OP_TYPE}-{YYYYMMDD}-{0001}
// Daily counter resets automatically at 12:00 AM (midnight) per branch & operation type
const transactionSequenceMap: Record<string, { lastDateStr: string; count: number }> = {};

export function generateStandardTransactionId(branchIdOrCode: string, opType: string, customDate?: Date): string {
  const br = branches.find((b) => b.id === branchIdOrCode || b.code === branchIdOrCode);
  const branchCode = br?.code || branchIdOrCode || 'WH001';

  const opPrefixMap: Record<string, string> = {
    'PO': 'PO',
    'PURCHASE_ORDER': 'PO',
    'PURCHASE_INVOICE': 'PI',
    'INV': 'PI',
    'PI': 'PI',
    'TRF': 'TRF',
    'TRANSFER': 'TRF',
    'SHIPMENT': 'TRF',
    'SALE': 'SALE',
    'STOCK_OUT': 'SALE',
    'CON': 'CON',
    'CONSUMABLE_ISSUE': 'CON',
    'DMG': 'DMG',
    'DAMAGE': 'DMG',
    'DSP': 'DSP',
    'DISPOSAL': 'DSP',
    'PLT': 'PLT',
    'PULLOUT': 'PLT',
  };
  const opCode = opPrefixMap[opType.toUpperCase()] || opType.toUpperCase().slice(0, 4);

  const d = customDate || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  const seqKey = `${branchCode}:${opCode}:${dateStr}`;

  if (!transactionSequenceMap[seqKey] || transactionSequenceMap[seqKey].lastDateStr !== dateStr) {
    transactionSequenceMap[seqKey] = { lastDateStr: dateStr, count: 1 };
  } else {
    transactionSequenceMap[seqKey].count += 1;
  }

  const counterStr = String(transactionSequenceMap[seqKey].count).padStart(4, '0');
  return `${branchCode}-${opCode}-${dateStr}-${counterStr}`;
}

// ---------------------------------------------------------------------------
// STRICT PER-BRANCH DAILY DOCUMENT NUMBERING (audit-safe)
// ---------------------------------------------------------------------------
// Produces the canonical, branch-scoped, daily-reset document number used by
// every operational document in the system:
//
//   {DOC_TYPE}-{BRANCH_CODE}-{YYYYMMDD}{NNNN}
//   e.g. PO-BRC01-202609150001   (4-digit counter, rolls to 5 digits at 9999)
//   e.g. ST-BRH01-2026091510002  (branch transfers / shipments)
//
// The counter is a database row in `document_sequence_daily` keyed by
// (branch, doc_type, date). Issuing is atomic:
//   INSERT ... ON CONFLICT (branch_id, doc_type, date_ad)
//   DO UPDATE SET next_number = document_sequence_daily.next_number + 1
//   RETURNING next_number
// so two concurrent users (or server restarts) can never receive the same
// number. Because the key includes the calendar date, the counter resets to 1
// automatically each day with no fiscal-year reset and no reuse across days.
//
// When PostgreSQL is unreachable we fall back to the in-memory legacy
// generator ONLY so a DB outage never blocks creating documents; once the DB
// returns the real sequences resume.
const DOC_TYPE_CODE_MAP: Record<string, string> = {
  'PO': 'PO',
  'PURCHASE_ORDER': 'PO',
  'PURCHASE_INVOICE': 'PI',
  'INV': 'PI',
  'PI': 'PI',
  'BILL': 'PI',
  'TRF': 'ST',
  'TRANSFER': 'ST',
  'SHIPMENT': 'ST',
  'ST': 'ST',
  'SALE': 'SALE',
  'STOCK_OUT': 'SALE',
  'INVOICE': 'INV',
  'SALES_INVOICE': 'INV',
  'CON': 'CON',
  'CONSUMABLE_ISSUE': 'CON',
  'DMG': 'DMG',
  'DAMAGE': 'DMG',
  'DSP': 'DSP',
  'DISPOSAL': 'DSP',
  'PLT': 'PLT',
  'PULLOUT': 'PLT',
  'SA': 'SA',
  'STOCK_ADJUSTMENT': 'SA',
  'GRN': 'GRN',
  'DN': 'DN',
  'QUO': 'QUO',
  'CN': 'CN',
  'EXC': 'EXC',
  'WC': 'WC',
  'FAA': 'FAA',
  'FAR': 'FAR',
  'JV': 'JV',
  'PV': 'PV',
  'RV': 'RV',
  'CP': 'CP',
  'CR': 'CR',
  'BP': 'BP',
  'BR': 'BR',
  'DC': 'DC',
};

export function normalizeDocTypeCode(docType: string): string {
  return DOC_TYPE_CODE_MAP[docType.toUpperCase()] || docType.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

// Formats a raw sequence with a flexible width: 4 digits normally, widening
// automatically once the counter exceeds 9999 (e.g. 10000 → "10000").
export function padSequence(seqNum: number): string {
  return String(seqNum).padStart(4, '0');
}

/**
 * Issues the next document number for a branch + document type on the given
 * calendar day. When `client` is provided (inside an existing transaction) the
 * counter claim joins that transaction; otherwise a one-off connection is used.
 */
export async function issueNextDocNumber(
  branchIdOrCode: string,
  docType: string,
  dateAd?: string,
  client?: any
): Promise<string> {
  const br = branches.find((b) => b.id === branchIdOrCode || b.code === branchIdOrCode);
  const branchCode = br?.code || branchIdOrCode || 'WH001';
  const branchId = br?.id || branchIdOrCode || 'WH001';
  // The admin-editable "doctype prefix" from document_number_configs is the
  // single source of the issued code (e.g. prefix "PO" -> "PO-BRC01-202609150001").
  // Only the leading letters/digits of the saved prefix are used, so legacy
  // values like "PO-2081-" still resolve to "PO". Unconfigured doc types
  // fall back to the built-in code map.
  const cfg = docNumberConfigs.find((c) => c.id === docType);
  const configuredPrefix = String(cfg?.prefix || '').trim();
  const opCode = configuredPrefix
    ? (configuredPrefix.match(/^[A-Z0-9]+/i)?.[0] || normalizeDocTypeCode(docType)).toUpperCase()
    : normalizeDocTypeCode(docType);
  const day = (dateAd || new Date().toISOString().split('T')[0]).slice(0, 10);

  if (!isPgConnected) {
    // DB is down — mirror the exact same format using the in-memory daily map
    // so callers never see a different shape (still per-branch + per-day).
    const dateStr = day.replace(/-/g, '');
    const seqKey = `${branchCode}:${opCode}:${dateStr}`;
    if (!transactionSequenceMap[seqKey] || transactionSequenceMap[seqKey].lastDateStr !== dateStr) {
      transactionSequenceMap[seqKey] = { lastDateStr: dateStr, count: 1 };
    } else {
      transactionSequenceMap[seqKey].count += 1;
    }
    return `${opCode}-${branchCode}-${dateStr}${String(transactionSequenceMap[seqKey].count).padStart(4, '0')}`;
  }

  try {
    const pool = client || pgPool;
    const result = await pool.query(
      `INSERT INTO document_sequence_daily (branch_id, doc_type, date_ad, next_number)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (branch_id, doc_type, date_ad)
       DO UPDATE SET
         next_number = document_sequence_daily.next_number + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING next_number;`,
      [branchId, opCode, day]
    );
    const issuedSeq = Number(result.rows[0]?.next_number);
    const seqStr = padSequence(issuedSeq);
    return `${opCode}-${branchCode}-${day.replace(/-/g, '')}${seqStr}`;
  } catch (e: any) {
    console.warn('issueNextDocNumber DB fallback:', e?.message);
    const dateStr = day.replace(/-/g, '');
    const seqKey = `${branchCode}:${opCode}:${dateStr}`;
    if (!transactionSequenceMap[seqKey] || transactionSequenceMap[seqKey].lastDateStr !== dateStr) {
      transactionSequenceMap[seqKey] = { lastDateStr: dateStr, count: 1 };
    } else {
      transactionSequenceMap[seqKey].count += 1;
    }
    return `${opCode}-${branchCode}-${dateStr}${String(transactionSequenceMap[seqKey].count).padStart(4, '0')}`;
  }
}

// Document Numbering System helper (server-side)
// Resolves the next voucher number from the document_number_configs master
// (same sequences shown in Fiscal Year Management > Document Numbering
// Initial Setup). Falls back to the legacy branch-based generator only when
// the requested doc type has not been configured yet.
export function generateNextDocNumberForServer(docTypeId: string): string {
  const config = docNumberConfigs.find((c) => c.id === docTypeId);
  if (!config) {
    return generateStandardTransactionId('WH001', docTypeId);
  }
  const seqNum = config.nextNumber;
  const paddedNum = String(seqNum).padStart(config.minDigits || 4, '0');
  const docNum = `${config.prefix || ''}${paddedNum}${config.suffix || ''}`;

  // Increment the in-memory sequence and persist to PostgreSQL best-effort
  // (async) so concurrent requests still see a monotonically increasing number.
  const idx = docNumberConfigs.findIndex((c) => c.id === docTypeId);
  if (idx !== -1) docNumberConfigs[idx].nextNumber = seqNum + 1;
  if (isPgConnected) {
    pgPool
      .query(
        `UPDATE document_number_configs SET next_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;`,
        [seqNum + 1, docTypeId]
      )
      .catch((e: any) => console.error('document_number_configs increment failed:', docTypeId, e?.message || e));
  }

  return docNum;
}


// Active user session mirror; authentication always reads PostgreSQL.
let activeUser: User | null = null;

/**
 * Explicit Database Transaction Runner
 * Executes a sequence of SQL queries inside an explicit BEGIN...COMMIT / ROLLBACK block
 */
export async function withTransaction<T>(
  callback: (client: any) => Promise<T>
): Promise<T> {
  let client: any = null;
  let inTransaction = false;
  try {
    client = await pgPool.connect();
    if (client) {
      await client.query('BEGIN');
      inTransaction = true;
    }
    const targetClient = client || pgPool;
    const result = await callback(targetClient);
    if (inTransaction && client) {
      await client.query('COMMIT');
    }
    return result;
  } catch (err) {
    if (inTransaction && client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.warn('Transaction rollback error:', rollbackErr);
      }
    }
    throw err;
  } finally {
    if (client && typeof client.release === 'function') {
      try {
        client.release();
      } catch (_e) {}
    }
  }
}

/**
 * Runs `fn` with a dedicated pooled connection (no transaction). Use when a
 * multi-statement read needs one consistent connection (e.g. cache hydration)
 * but atomicity is not required; use withTransaction for writes.
 */
export async function withConnection<T>(
  callback: (client: any) => Promise<T>
): Promise<T> {
  const client = await pgPool.connect();
  try {
    return await callback(client);
  } finally {
    if (client && typeof client.release === 'function') {
      try {
        client.release();
      } catch (_e) {}
    }
  }
}

export function logAuditEvent(
  req: any,
  action: string,
  module: string,
  details: string,
  overrideBranchId?: string,
  client?: any
): AuditLog | Promise<AuditLog> {
  const u = getUserFromReq(req);
  const auditItem: AuditLog = {
    id: `aud-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    userEmail: u.email || '',
    userName: u.name || '',
    action,
    module: module as AuditLog['module'],
    details,
    timestampAD: new Date().toISOString(),
    timestampBS: '2083-04-16 BS',
    branchId: overrideBranchId || u.branchId,
  };

  auditTrail = withPrepended(auditTrail, auditItem);

  // Broadcast event to all active real-time SSE client connections
  broadcastChange({
    type: action,
    entity: module,
    branchId: auditItem.branchId,
  });

  // Persist to Postgres. Two paths:
  //  - `client` provided: the INSERT runs (and is awaited by the caller) on
  //    the caller's transaction, so the audit row commits or rolls back
  //    together with the business action it records. Insert failures abort
  //    the transaction — an audited action is never committed unlogged.
  //  - no `client` (demo mode / non-transactional callers): fire-and-forget
  //    best-effort insert; failures are logged, never silently dropped.
  const insertAudit = async (executor: { query: (sql: string, params: any[]) => Promise<any> }) => {
    await executor.query(
      `INSERT INTO audit_logs (id, user_email, user_name, action, module, details, timestamp_ad, timestamp_bs, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        auditItem.id,
        auditItem.userEmail,
        auditItem.userName,
        auditItem.action,
        auditItem.module,
        auditItem.details,
        auditItem.timestampBS,
        // 'ALL' is the app-wide "all branches" sentinel, not a real branch id —
        // store NULL so the branch_id FK is never violated.
        auditItem.branchId && auditItem.branchId !== 'ALL' ? auditItem.branchId : null,
      ]
    );
    return auditItem;
  };

  if (client) return insertAudit(client);
  // Demo mode (PostgreSQL down): the register lives in memory only; skip the
  // pool insert instead of spamming connection errors for every event.
  if (isPgConnected) {
    insertAudit(pgPool).catch((e: any) => console.error('audit_logs persist failed:', auditItem.action, e?.message || e));
  }
  return auditItem;
}

// ==========================================
// REAL-TIME SYNC & BROADCAST ENGINE (SSE)
// ==========================================
let dataVersion = Date.now();
export const sseClients = new Set<express.Response>();

export function broadcastChange(event: { type: string; entity?: string; branchId?: string }) {
  dataVersion = Date.now();
  const payload = JSON.stringify({ ...event, dataVersion, timestamp: new Date().toISOString() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (_err) {
      sseClients.delete(client);
    }
  }
}

// SSE Live Event Stream Endpoint


// Normalizes a database date value (pg Date object, ISO datetime string, or
// 'YYYY-MM-DD' text) into a 'YYYY-MM-DD' calendar string so it can be safely
// compared against fiscal-year boundary dates. Returns '' when the value
// cannot be interpreted as a date.
export function toCalendarDate(value: any): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

// Resolves the active fiscal year for default views: prefers a year flagged
// current whose AD range contains today's date (guards against multiple rows
// being flagged is_current), falling back to the first flagged-current year.
export function pickCurrentFiscalYear(years: any[]): any | undefined {
  if (!years || years.length === 0) return undefined;
  const currentYears = years.filter((fy: any) => fy && fy.isCurrent);
  if (currentYears.length === 0) return undefined;
  const todayAD = toCalendarDate(new Date());
  const containsToday = (fy: any) => {
    const start = toCalendarDate(fy.startDateAD);
    const end = toCalendarDate(fy.endDateAD);
    return Boolean(start && end && todayAD >= start && todayAD <= end);
  };
  return currentYears.find(containsToday) || currentYears[0];
}

// Returns the fiscal-year code (e.g. '2083-84') whose AD range contains the
// given date, or '' when no fiscal year covers it. Used to stamp records with
// the correct fiscal year at write time instead of a stale hard-coded default.
export function getFiscalYearCodeForDate(dateValue: any): string {
  const dateStr = toCalendarDate(dateValue);
  if (!dateStr) return '';
  for (const fiscalYear of fiscalYears) {
    const start = toCalendarDate(fiscalYear.startDateAD);
    const end = toCalendarDate(fiscalYear.endDateAD);
    if (start && end && dateStr >= start && dateStr <= end) return fiscalYear.code;
  }
  return '';
}

// Resolve the fiscal_years.id (PK) for a given AD date. Used for FK columns
// like damage_records.fiscal_year_id, which references fiscal_years(id) —
// never store the human-readable fiscal year code there.
export function getFiscalYearIdForDate(dateValue: any): string | null {
  const dateStr = toCalendarDate(dateValue);
  if (!dateStr) return null;
  for (const fiscalYear of fiscalYears) {
    const start = toCalendarDate(fiscalYear.startDateAD);
    const end = toCalendarDate(fiscalYear.endDateAD);
    if (start && end && dateStr >= start && dateStr <= end) return fiscalYear.id || null;
  }
  return null;
}

// ==========================================
// TRADING SUMMARY HELPERS (Sales Revenue + Cost of Goods Sold)
// ==========================================
// A "customer sale" is a stock_operations row of type STOCK_OUT that carries
// priced line items in its items JSONB (created by the Product Sale form in
// Branch Operations). Asset-issue stock-outs (items JSONB = []) reclassify
// inventory into Fixed Assets — they are NOT sales and are excluded here.
//
// Revenue and COGS are both derived from the same underlying sale lines so
// the two figures always share one source and reconcile with the balance
// sheet's "Merchandise Inventory (At Valuation)" (cost × quantity-on-hand).
export function computeTradingFromOps(ops: readonly any[], productsList: readonly any[]) {
  let totalSalesRevenue = 0;
  let totalCostOfGoodsSold = 0;
  for (const op of ops || []) {
    if (op.type !== 'STOCK_OUT') continue;
    const lines = Array.isArray(op.items) ? op.items : [];
    for (const it of lines) {
      // Asset-issue stock-outs carry no priced lines; skip them.
      if (it.totalValue === undefined && it.sellingPrice === undefined) continue;
      const qty = Number(it.quantity) || 0;
      const revenue = Number(it.totalValue) || Math.max(
        0,
        qty * (Number(it.sellingPrice) || 0) - (Number(it.discount) || 0)
      );
      if (revenue > 0) totalSalesRevenue += revenue;
      if (qty > 0) {
        const prod = (productsList || []).find((p: any) => p.id === it.productId);
        // Prefer the cost captured on the sale line; fall back to the current
        // product cost so COGS matches the merchandise valuation basis.
        const unitCost = Number(it.unitCost) || (prod ? Number(prod.costPrice) : 0);
        totalCostOfGoodsSold += qty * unitCost;
      }
    }
  }
  return { totalSalesRevenue, totalCostOfGoodsSold };
}

// ==========================================
// PERMISSION MATRIX API (SUPER_ADMIN ONLY)
// ==========================================


// ==========================================
// UNIFIED BATCH BOOTSTRAP ENDPOINT (1-ROUNDTRIP SYNC)
// ==========================================

// Database Health & Connection Check Endpoint

// ==========================================
// API REST ENDPOINTS
// ==========================================

// Clear Demo/Dummy Data Endpoint
// Removes ONLY rows marked is_demo = TRUE (the dataset created by
// `npm run setup:pg`). Real business data (is_demo = FALSE), users,
// branches and fiscal years are never touched.

// Auth Login





// Profile Switching Endpoint

// Profile Update Endpoint

// UOM (Unit of Measure)




// Locations




// Company Profile API


// Branches




// Suppliers




// Users





// Products




// Categories API




// Stock

// Administrative repair actions. These update derived values only; source
// documents and transaction history remain unchanged.


// Regenerates the derived bs_day_records lookup table from the authoritative
// bs_calendar_years configuration. This is an idempotent repair/maintenance
// operation: it rebuilds every AD->BS day record from the stored start dates
// and month-length arrays, so drifted, missing, or stale day rows are restored
// to match the configuration. Source calendar config is never rewritten.

// Re-derives the fiscal_year_id foreign key on every dated transactional table
// from its own AD date column. This is a non-destructive repair: it only fills
// NULL / stale references (rows already pointing at a matching period are left
// untouched) by looking the date up in fiscal_years. No document is modified.




// Physical Stock Audit Direct Reconciliation

// Fixed Assets



// Purchase Orders





// Purchase Invoices




// POST /api/purchase-invoices/:id/reverse-payments — reverse all payments for a fully paid invoice

// ==========================================
// VENDOR PAYMENTS SUB-LEDGER
// ==========================================

export const VENDOR_PAYMENT_SELECT = `
  SELECT id, payment_number AS "paymentNumber", supplier_id AS "supplierId",
         supplier_name AS "supplierName", branch_id AS "branchId",
         invoice_id AS "invoiceId", invoice_number AS "invoiceNumber",
         payment_date_ad AS "paymentDateAD", payment_date_bs AS "paymentDateBS",
         amount, payment_method AS "paymentMethod",
         bank_name AS "bankName", bank_branch AS "bankBranch",
         account_number AS "accountNumber", cheque_number AS "chequeNumber",
         cheque_date_ad AS "chequeDateAD", cheque_date_bs AS "chequeDateBS",
         transaction_reference AS "transactionReference", notes, status,
         reversal_reason AS "reversalReason", reversed_by AS "reversedBy",
         reversed_at_ad AS "reversedAtAD", original_payment_id AS "originalPaymentId",
         fiscal_year_id AS "fiscalYearId", is_demo AS "isDemo",
         created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
  FROM vendor_payments`;

// GET /api/vendor-payments?supplierId=&invoiceId=&branchId=&status=&fromAd=&toAd=&fiscalYearId=

// GET /api/purchase-invoices/:id/payments — payment history for one invoice

// POST /api/vendor-payments — create a payment (sub-ledger entry)

// POST /api/vendor-payments/:id/reverse — reverse a posted payment

// Vendor ledger report: debits (invoices) + credits (payments) with running balance.
// GET /api/vendors/:supplierId/ledger?fromAd=&toAd=&fiscalYearId=&branchId=

// Resolves an existing supplier master row by vendor name, creating one on the
// fly for invoice-driven payments when no supplierId was supplied.
export function providerSupplierIdFromName(name: string): string | undefined {
  const clean = String(name || '').trim();
  if (!clean) return undefined;
  const matched = suppliers.find((s) => s.name.toLowerCase() === clean.toLowerCase()) ||
    suppliers.find((s) => s.name.toLowerCase().includes(clean.toLowerCase()));
  if (matched) return matched.id;
  return undefined;
}

// Shipments




// Deprecated alias for backwards compatibility

// Stock Operations (Pullout Bins, Damage Tagging & Adjustments)

/** Type-aware permission middleware for stock operations (maps operation type to matrix op). */
export function requireStockOperationPermission(req: any, res: any, next: any) {
  const opType = req.body?.type || 'DAMAGE';
  const opMap: Record<string, string> = {
    'PULLOUT': 'branch-pullout-dispatch',
    'STOCK_OUT': 'stock-out',
    'DAMAGE': 'branch-damage-mark',
    'DISPOSAL': 'stock-disposal-writeoff',
    'CONSUMABLE_ISSUE': 'stock-out',
    'MANUAL_ADJUSTMENT': 'stock-out',
  };
  const op = opMap[opType] || 'branch-pullout-dispatch';
  return requirePermission(op)(req, res, next);
}


// Reverse a DAMAGE stock operation (Super Admin / Inventory Manager only).
// Safe-guarded entry reversal: the caller must supply a reason which is kept
// on the audit trail. Units are moved back from damaged_qty to available
// quantity_on_hand at the original branch, damage_records rows are marked
// CANCELLED, and the stock operation status flips to CANCELLED.

// Receive Pullout Bin at Warehouse

// Fiscal Years





// Fiscal Years

// Create a new fiscal year directly in Postgres. SUPER_ADMIN only. A new period
// is never auto-activated: it starts open (is_closed = FALSE) and is normally
// made the active view once it goes live.



// Super Admin re-authorization gate: fiscal period lock/unlock requires verified
// Super Admin email + password (server-side check, independent of the session role).
export async function verifySuperAdminCredentials(
  emailInput: unknown,
  passwordInput: unknown
): Promise<{ ok: boolean; email?: string; message?: string }> {
  const cleanEmail = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
  const password = String(passwordInput || '');
  if (!cleanEmail || !password) {
    return { ok: false, message: 'Super Admin email and password are required to authorize this action.' };
  }

  if (isPgConnected) {
    try {
      const dbRes = await pgPool.query(
        'SELECT id, email, password, role FROM users WHERE LOWER(email) = LOWER($1)',
        [cleanEmail]
      );
      const dbUser = dbRes.rows[0];
      if (!dbUser || dbUser.role !== 'SUPER_ADMIN') {
        return { ok: false, message: 'Authorization failed: only a Super Admin account can lock or unlock a fiscal period.' };
      }
      const check = verifyPassword(password, dbUser.password);
      if (!check.valid) return { ok: false, message: 'Authorization failed: invalid Super Admin email or password.' };
      if (check.upgradedHash) {
        await pgPool
          .query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [
            check.upgradedHash,
            dbUser.id,
          ])
          .catch((e: any) => console.error('users password hash upgrade failed:', e?.message || e));
      }
      return { ok: true, email: dbUser.email };
    } catch (_err) {
      // fall through to the in-memory user list if the DB query fails
    }
  }

  const localUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
  if (!localUser || localUser.role !== 'SUPER_ADMIN') {
    return { ok: false, message: 'Authorization failed: only a Super Admin account can lock or unlock a fiscal period.' };
  }
  const check = verifyPassword(password, localUser.password || '');
  if (!check.valid) return { ok: false, message: 'Authorization failed: invalid Super Admin email or password.' };
  return { ok: true, email: localUser.email };
}




// Case-insensitive matcher for serialized device records stored in JSONB
// (purchase_invoices.items, shipments.items, stock_operations.items) and for
// in-memory mirrors. A record matches when ANY of its three identifiers equals
// the corresponding old value; matched records get all three values replaced so
// the correction cascades everywhere the serial was recorded.
// Shared handler for editing serials across all inventory and customer records
export async function handleUpdateSerials(req: any, res: any) {
  try {
    const targetId = req.params?.id || req.body?.id;
    const {
      sourceType,
      sourceId,
      oldDeviceSerial: rawOldDeviceSerial,
      oldPonSerial: rawOldPonSerial,
      oldMacAddress: rawOldMacAddress,
      deviceSerial,
      ponSerial,
      macAddress,
    } = req.body;

    if (!deviceSerial || !ponSerial) {
      return res.status(400).json({ message: 'Device serial and PON serial are required.' });
    }

    const normalizedDeviceSerial = String(deviceSerial).trim().toUpperCase();
    const normalizedPonSerial = String(ponSerial).trim().toUpperCase();
    const normalizedMacAddress = macAddress ? String(macAddress).trim().toUpperCase() : null;

    let oldDeviceSerial = rawOldDeviceSerial ? String(rawOldDeviceSerial).trim().toUpperCase() : '';
    let oldPonSerial = rawOldPonSerial ? String(rawOldPonSerial).trim().toUpperCase() : '';
    let oldMacAddress = rawOldMacAddress ? String(rawOldMacAddress).trim().toUpperCase() : '';
    let matchedBranchId: string | undefined = req.body?.branchId;
    let customerName: string = 'Inventory Stock';

    // -----------------------------------------------------------------
    // AUTHORITATIVE DUPLICATE CHECK (all three serial types)
    // A user must never be allowed to save a device serial, PON serial, or
    // MAC address that already exists on a DIFFERENT device. The check is
    // case-insensitive and runs against every table that stores these
    // identifiers: serial_log, customer_device_records, fixed_assets.
    // -----------------------------------------------------------------
    const newValues: Array<{ field: string; value: string }> = [
      { field: 'Device Serial', value: normalizedDeviceSerial },
      { field: 'PON Serial', value: normalizedPonSerial },
      ...(normalizedMacAddress ? [{ field: 'MAC Address', value: normalizedMacAddress }] : []),
    ];

    if (isPgConnected) {
      // Exclude rows that belong to the device being edited itself: those are
      // identified by ANY of its old identifiers.
      const oldVals = [oldDeviceSerial, oldPonSerial, oldMacAddress].filter(Boolean);
      // NOTE: $1 is the searched value, so the old-value exclusion params
      // start at $2 (params are passed as [value, ...oldVals]).
      const exclusions = buildOldValueExclusions(oldVals);
      const exclusionClause = exclusions.deviceExclusion;
      const ponExclusion = exclusions.ponExclusion;
      const macExclusion = exclusions.macExclusion;
      const macNotNull = CDR_DUP_EXTRA_FRAGMENTS.macNotNull;
      // fixed_assets has no device_serial/pon_serial/mac_address columns — it
      // stores the serial as tag_number — so it needs its own exclusion clause.
      const assetExclusion = exclusions.assetExclusion;

      for (const { field, value } of newValues) {
        // serial_log — device serial + PON + MAC (unique index exists for device serial)
        const slResult = await pgPool.query(
          `SELECT device_serial AS "deviceSerial", product_name AS "productName", branch_id AS "branchId" FROM serial_log
           WHERE (lower(trim(device_serial)) = lower(trim($1)) OR lower(trim(pon_serial)) = lower(trim($1)) OR lower(trim(mac_address)) = lower(trim($1)))${exclusionClause}
           LIMIT 1`,
          [value, ...oldVals]
        );
        if (slResult.rows.length > 0) {
          const row = slResult.rows[0];
          return res.status(409).json({
            message: `${field} "${value}" already exists in the serial register on device "${row.deviceSerial}" (${row.productName || 'Unknown product'}). Please correct the ${field.toLowerCase()} before saving.`,
            field,
            value,
            conflictingDevice: row.deviceSerial,
          });
        }

        // customer_device_records — device serial + PON + MAC (unique indexes on all three)
        const cdrResult = await pgPool.query(
          `SELECT device_serial AS "deviceSerial", customer_name AS "customerName" FROM customer_device_records
           WHERE (lower(trim(device_serial)) = lower(trim($1)) OR lower(trim(pon_serial)) = lower(trim($1)) OR lower(trim(mac_address)) = lower(trim($1)))${exclusionClause}${ponExclusion}${macExclusion}${macNotNull}
           LIMIT 1`,
          [value, ...oldVals]
        );
        if (cdrResult.rows.length > 0) {
          const row = cdrResult.rows[0];
          return res.status(409).json({
            message: `${field} "${value}" is already assigned to customer device "${row.deviceSerial}" (${row.customerName || 'Unknown customer'}). Please correct the ${field.toLowerCase()} before saving.`,
            field,
            value,
            conflictingDevice: row.deviceSerial,
          });
        }

        // fixed_assets — device serial stored as tag_number
        const faResult = await pgPool.query(
          `SELECT tag_number AS "tagNumber", name FROM fixed_assets
           WHERE lower(trim(tag_number)) = lower(trim($1))${assetExclusion}
           LIMIT 1`,
          [value, ...oldVals]
        );
        if (faResult.rows.length > 0) {
          const row = faResult.rows[0];
          return res.status(409).json({
            message: `${field} "${value}" is already used by fixed asset "${row.tagNumber}" (${row.name || 'Unknown asset'}). Please correct the ${field.toLowerCase()} before saving.`,
            field,
            value,
            conflictingDevice: row.tagNumber,
          });
        }
      }
    }

    // 1. Try to find customer device record
    let customerRecord = customerDeviceRecords.find((c) => c.id === targetId || (oldDeviceSerial && c.deviceSerial === oldDeviceSerial));
    if (isPgConnected && !customerRecord && targetId && !targetId.startsWith('pi-') && !targetId.startsWith('ship-') && !targetId.startsWith('op-') && !targetId.startsWith('fa-')) {
      try {
        const r = await pgPool.query(
          `SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", 
                  branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", 
                  pon_serial AS "ponSerial", mac_address AS "macAddress", status FROM customer_device_records 
           WHERE id = $1 OR (device_serial = $2 AND $2 != '') LIMIT 1`,
          [targetId, oldDeviceSerial || '']
        );
        if (r.rows.length > 0) customerRecord = r.rows[0];
      } catch (_e) {}
    }

    if (customerRecord) {
      if (!oldDeviceSerial) oldDeviceSerial = customerRecord.deviceSerial;
      if (!oldPonSerial) oldPonSerial = customerRecord.ponSerial;
      if (!oldMacAddress) oldMacAddress = customerRecord.macAddress;
      if (!matchedBranchId) matchedBranchId = customerRecord.branchId;
      customerName = customerRecord.customerName || 'Customer Device';

      customerRecord.deviceSerial = normalizedDeviceSerial;
      customerRecord.ponSerial = normalizedPonSerial;
      customerRecord.macAddress = normalizedMacAddress;
    }

    // 2. If Fixed Asset
    if (targetId && (targetId.startsWith('fa-') || sourceType === 'FIXED_ASSET')) {
      const assetId = targetId.replace(/^fa-/, '');
      const asset = assetRegister.find((a) => a.id === assetId || a.tagNumber === oldDeviceSerial);
      if (asset) {
        if (!oldDeviceSerial) oldDeviceSerial = asset.tagNumber;
        if (!matchedBranchId) matchedBranchId = asset.branchId;
        asset.tagNumber = normalizedDeviceSerial;
      }
    }

    if (!oldDeviceSerial && targetId) {
      const parts = targetId.split('-');
      if (parts.length >= 3) {
        oldDeviceSerial = parts.slice(2).join('-');
      }
    }

    if (!oldDeviceSerial) {
      oldDeviceSerial = normalizedDeviceSerial;
    }

    // PostgreSQL Cascading Updates
    if (isPgConnected) {
      await withTransaction(async (client) => {
        // Update customer_device_records — match on id, device serial, PON, or
        // MAC (case-insensitive, trimmed). Each identifier only matches when
        // the corresponding old value is actually provided.
        await client.query(
          `UPDATE customer_device_records 
           SET device_serial = $1, pon_serial = $2, mac_address = $3 
           WHERE id = $4
              OR ($5 != '' AND lower(trim(device_serial)) = lower(trim($5)))
              OR ($6 != '' AND lower(trim(pon_serial)) = lower(trim($6)))
              OR ($7 != '' AND lower(trim(mac_address)) = lower(trim($7)))`,
          [normalizedDeviceSerial, normalizedPonSerial, normalizedMacAddress, targetId, oldDeviceSerial, oldPonSerial, oldMacAddress]
        );

        // Update fixed_assets
        const actualAssetId = targetId?.replace(/^fa-/, '');
        await client.query(
          `UPDATE fixed_assets SET tag_number = $1 WHERE id = $2 OR tag_number = $3`,
          [normalizedDeviceSerial, actualAssetId, oldDeviceSerial]
        );

        // Cascade renames across JSONB item lists (purchase_invoices,
        // shipments, stock_operations) — SQL + rename logic defined once in
        // server/services/serials.service.ts.
        await cascadeRenameJsonbTables(
          client,
          { oldDeviceSerial, oldPonSerial, oldMacAddress },
          { newDeviceSerial: normalizedDeviceSerial, newPonSerial: normalizedPonSerial, newMacAddress: normalizedMacAddress }
        );

        // Update shipments items JSONB — handled by cascadeRenameJsonbTables above.

        // Update stock_operations items JSONB — handled by cascadeRenameJsonbTables above.

        // Sync serial_log (one row per serial): reject duplicate, rename
        // existing. SQL + history-entry construction defined once in
        // server/services/serials.service.ts.
        const slStep = buildSerialLogRenameStep(
          {
            oldDeviceSerial,
            newDeviceSerial: normalizedDeviceSerial,
            newPonSerial: normalizedPonSerial,
            newMacAddress: normalizedMacAddress,
            targetId,
          },
          new Date().toISOString()
        );
        const oldRowRes = await client.query(slStep.selectOldSql, [oldDeviceSerial]);
        const newRowRes = await client.query(
          `SELECT id FROM serial_log WHERE lower(trim(device_serial)) = lower(trim($1)) LIMIT 1`,
          [normalizedDeviceSerial]
        );
        const oldRow = oldRowRes.rows[0];
        // Reject if a DIFFERENT serial_log row already holds the new device
        // serial, PON, or MAC (case-insensitive). The authoritative pre-check
        // above should have caught this, but re-verify inside the transaction
        // to protect against races between the pre-check and the commit.
        const oldVals = [oldDeviceSerial, oldPonSerial, oldMacAddress].filter(Boolean);
        const { notSelfDevice } = buildOldValueExclusions(oldVals);
        const newRow = newRowRes.rows[0] && (!oldRow || newRowRes.rows[0].id !== oldRow.id) ? newRowRes.rows[0] : null;
        const slPonClash = normalizedPonSerial
          ? (await client.query(
              `SELECT id FROM serial_log WHERE lower(trim(pon_serial)) = lower(trim($1))${notSelfDevice} LIMIT 1`,
              [normalizedPonSerial, ...oldVals]
            )).rows[0]
          : null;
        const slMacClash = normalizedMacAddress
          ? (await client.query(
              `SELECT id FROM serial_log WHERE lower(trim(mac_address)) = lower(trim($1))${notSelfDevice} LIMIT 1`,
              [normalizedMacAddress, ...oldVals]
            )).rows[0]
          : null;
        if (newRow || slPonClash || slMacClash) {
          const field = newRow ? 'Device Serial' : slPonClash ? 'PON Serial' : 'MAC Address';
          const value = newRow ? normalizedDeviceSerial : slPonClash ? normalizedPonSerial : normalizedMacAddress;
          const dupErr: any = new Error(`${field} "${value}" already exists in the serial register. Cannot save a duplicate.`);
          dupErr.status = 409;
          throw dupErr;
        }
        if (oldRow) {
          const history = [...parseSerialHistoryValue(oldRow.history_json), slStep.correctionEntry];
          await client.query(slStep.updateSql, slStep.updateParams(oldRow.id, history));
        } else {
          const slId = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await client.query(slStep.insertSql, slStep.insertParams(slId, matchedBranchId || null));
        }
      });
    }

    // In-memory updates for all sources — same case-insensitive semantics as
    // the PostgreSQL path so both stay in sync.
    customerDeviceRecords.forEach((c) => {
      if (
        c.id === targetId ||
        (!!oldDeviceSerial && String(c.deviceSerial || '').trim().toUpperCase() === oldDeviceSerial) ||
        (!!oldPonSerial && String(c.ponSerial || '').trim().toUpperCase() === oldPonSerial) ||
        (!!oldMacAddress && String(c.macAddress || '').trim().toUpperCase() === oldMacAddress)
      ) {
        c.deviceSerial = normalizedDeviceSerial;
        c.ponSerial = normalizedPonSerial;
        c.macAddress = normalizedMacAddress;
      }
    });

    const actualAssetId = targetId?.replace(/^fa-/, '');
    assetRegister.forEach((a) => {
      if (a.id === actualAssetId || a.tagNumber === oldDeviceSerial) {
        a.tagNumber = normalizedDeviceSerial;
      }
    });

    // In-memory JSONB mirrors (purchase invoices / shipments / stock
    // operations) — rename logic shared with the DB cascade via
    // server/services/serials.service.ts; deviceSerials lists are written
    // back per item to preserve the original in-place mutation semantics.
    const oldV = { oldDeviceSerial, oldPonSerial, oldMacAddress };
    const newV = {
      newDeviceSerial: normalizedDeviceSerial,
      newPonSerial: normalizedPonSerial,
      newMacAddress: normalizedMacAddress,
    };
    purchaseInvoices.forEach((inv: any) => {
      if (inv.items && Array.isArray(inv.items)) {
        const { items } = renameSerialsInJsonbItems(inv.items, oldV, newV);
        items.forEach((next: any, i: number) => {
          inv.items[i].deviceSerials = next.deviceSerials;
        });
      }
    });

    shipments.forEach((ship: any) => {
      if (ship.items && Array.isArray(ship.items)) {
        const { items } = renameSerialsInShipmentItems(ship.items, oldV, newV);
        items.forEach((next: any, i: number) => {
          ship.items[i].deviceSerials = next.deviceSerials;
          ship.items[i].receivedSerials = next.receivedSerials;
        });
      }
    });

    stockOperations.forEach((op: any) => {
      if (op.items && Array.isArray(op.items)) {
        const { items } = renameSerialsInJsonbItems(op.items, oldV, newV);
        items.forEach((next: any, i: number) => {
          op.items[i].deviceSerials = next.deviceSerials;
        });
      }
    });

    // In-memory serial_log sync (one row per serial, reject duplicate).
    {
      const nowIso = new Date().toISOString();
      // Reject if a different row already holds the target serial
      const clash = findInMemorySerialClash(serialLogs, normalizedDeviceSerial, oldDeviceSerial);
      if (clash) {
        // Already returned 409 from PG path; throw here for safety in non-PG mode
        const dupErr: any = new Error(`Serial number "${normalizedDeviceSerial}" already exists.`);
        dupErr.status = 409;
        throw dupErr;
      }
      serialLogs = applyInMemorySerialRename(serialLogs, {
        oldDeviceSerial,
        oldPonSerial,
        oldMacAddress,
        newDeviceSerial: normalizedDeviceSerial,
        newPonSerial: normalizedPonSerial,
        newMacAddress: normalizedMacAddress,
        targetId,
        branchId: matchedBranchId,
        nowIso,
      });
    }

    logAuditEvent(
      req,
      'EDIT_DEVICE_SERIALS',
      'CPE_MANAGEMENT',
      `Updated serial information: Device ${oldDeviceSerial}→${normalizedDeviceSerial}, PON ${oldPonSerial}→${normalizedPonSerial}, MAC ${oldMacAddress || 'N/A'}→${normalizedMacAddress || 'N/A'} (${customerName})`,
      matchedBranchId
    );

    broadcastChange({ type: 'SERIALS_UPDATED', entity: 'device-serials', branchId: matchedBranchId });

    res.json({
      success: true,
      message: 'Serial information updated successfully across all inventory records.',
      deviceSerial: normalizedDeviceSerial,
      ponSerial: normalizedPonSerial,
      macAddress: normalizedMacAddress,
      record: customerRecord,
    });
  } catch (err: any) {
    console.error('Error updating device serials:', err);
    const status = err.status || 500;
    res.status(status).json({ message: err.message || `Database error: ${err.message}` });
  }
}


// Production executor for the dual-edit orchestration (see
// server/services/serialEditCapture.service.ts): runs one single-device
// serial correction through handleUpdateSerials and captures the JSON
// response instead of writing to a real HTTP response.
export function runSerialEditCapture(user: any, body: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve) => {
    const req = { user, body, params: {}, query: {} };
    let capturedStatus = 200;
    const res = {
      status(code: number) { capturedStatus = code; return this; },
      json(data: any) { resolve({ status: capturedStatus, data }); },
    };
    Promise.resolve(handleUpdateSerials(req, res)).catch(() => resolve({ status: 500, data: { message: 'Internal error' } }));
  });
}

// ---------------------------------------------------------------------------
// Dual serial correction — validation, park-then-apply step planning and
// sequenced execution live in server/services/serialEditCapture.service.ts;
// this endpoint keeps HTTP concerns only.
// ---------------------------------------------------------------------------

// Device Exchange & Replacement Handler

// Customer Master Database Endpoints





// Approval Requests & Workflow Authorization Routes




// Serial Log — consolidated serial device inventory (one row per unique serial)


// Financial Reports Summary

// Company Profile REST Endpoints


// Vite Middleware Setup for Dev Mode vs Static Production Serving
export async function syncDatabaseAndIndexes() {
  if (!realPoolInstance) {
    isPgConnected = false;
    setIsPgConnected(false);
    throw new Error('PostgreSQL connection is not configured. Set DATABASE_URL or POSTGRES_HOST.');
  }

  try {
    const client = await pgPool.connect();
    if (!client) {
      isPgConnected = false;
      setIsPgConnected(false);
      throw new Error('PostgreSQL connection could not be established.');
    }
    console.log('PostgreSQL Pool connected successfully. Syncing full database schema (28 tables) & creating high-throughput performance indexes...');

    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      -- 1. Branches
      CREATE TABLE IF NOT EXISTS branches (
        id VARCHAR(50) PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(150) NOT NULL,
        location VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        is_headquarters BOOLEAN DEFAULT FALSE,
        active BOOLEAN DEFAULT TRUE,
        allow_procurement BOOLEAN DEFAULT TRUE,
        allow_warehouse_transfer BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 2. Users
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(50) PRIMARY KEY,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(150) NOT NULL,
        role VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
        allowed_branch_ids TEXT[],
        can_switch_user BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 3. Suppliers
      CREATE TABLE IF NOT EXISTS suppliers (
        id VARCHAR(50) PRIMARY KEY,
        supplier_code VARCHAR(50),
        name VARCHAR(200) NOT NULL,
        contact_person VARCHAR(150),
        phone VARCHAR(50),
        email VARCHAR(150),
        address TEXT,
        pan_vat_number VARCHAR(50),
        rating NUMERIC(3, 1) DEFAULT 5.0,
        status VARCHAR(20) DEFAULT 'ACTIVE',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 4. Categories
      CREATE TABLE IF NOT EXISTS categories (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(150) UNIQUE NOT NULL,
        code VARCHAR(30) UNIQUE NOT NULL,
        description TEXT,
        is_special_tracked BOOLEAN NOT NULL DEFAULT FALSE
      );

      -- 5. Products
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(50) PRIMARY KEY,
        sku VARCHAR(100) UNIQUE NOT NULL,
        barcode VARCHAR(100),
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        product_group VARCHAR(50) DEFAULT 'Product Item',
        unit VARCHAR(30) DEFAULT 'Pcs',
        cost_price NUMERIC(12, 2) DEFAULT 0.00,
        selling_price NUMERIC(12, 2) DEFAULT 0.00,
        tax_rate NUMERIC(5, 2) DEFAULT 13.00,
        min_reorder_level INT DEFAULT 5,
        requires_serial_tracking BOOLEAN DEFAULT FALSE,
        tracking_type VARCHAR(50) DEFAULT 'QUANTITY_ONLY',
        description TEXT,
        depreciation_method VARCHAR(50),
        depreciation_rate NUMERIC(5, 2),
        useful_life_years INT,
        salvage_value_percent NUMERIC(5, 2),
        status VARCHAR(20) DEFAULT 'ACTIVE',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 6. Inventory Stock
      CREATE TABLE IF NOT EXISTS inventory_stock (
        id VARCHAR(100) PRIMARY KEY,
        product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        quantity_on_hand INT DEFAULT 0,
        damaged_qty INT DEFAULT 0,
        reserved_qty INT DEFAULT 0,
        incoming_qty INT DEFAULT 0,
        min_reorder_level INT DEFAULT 5,
        last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_product_branch UNIQUE (product_id, branch_id)
      );

      -- 7. Damage Records (damage lifecycle: identified -> disposed/written-off)
      CREATE TABLE IF NOT EXISTS damage_records (
        id VARCHAR(50) PRIMARY KEY,
        damage_reference VARCHAR(100) UNIQUE NOT NULL,
        product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        quantity_damaged INT NOT NULL CHECK (quantity_damaged > 0),
        unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
        total_cost NUMERIC(15, 2) NOT NULL DEFAULT 0,
        damage_date_ad DATE NOT NULL,
        damage_date_bs VARCHAR(20) NOT NULL,
        damage_reason VARCHAR(100) NOT NULL CHECK (damage_reason IN ('PHYSICAL_DAMAGE', 'TRANSIT_DAMAGE', 'STORAGE_DAMAGE', 'EXPIRED', 'RETURN_DAMAGE', 'QUALITY_DEFECT', 'OTHER')),
        status VARCHAR(30) NOT NULL DEFAULT 'IDENTIFIED' CHECK (status IN ('IDENTIFIED', 'UNDER_REVIEW', 'DISPOSED', 'WRITTEN_OFF', 'RETURNED_TO_SUPPLIER', 'CANCELLED')),
        disposal_date_ad DATE,
        disposal_date_bs VARCHAR(20),
        disposal_method VARCHAR(50) CHECK (disposal_method IN ('SCRAP_DESTRUCTION', 'SALVAGE_E_WASTE', 'VENDOR_RMA', 'INSURANCE_CLAIM', 'WRITE_OFF', 'RETURN_TO_SUPPLIER', 'AUCTION')),
        salvage_value NUMERIC(15, 2) DEFAULT 0,
        gl_account_code VARCHAR(100),
        write_off_loss NUMERIC(15, 2) DEFAULT 0,
        approved_by VARCHAR(150),
        notes TEXT,
        fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(150),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_damage_records_product ON damage_records(product_id);
      CREATE INDEX IF NOT EXISTS idx_damage_records_branch ON damage_records(branch_id);
      CREATE INDEX IF NOT EXISTS idx_damage_records_status ON damage_records(status);
      CREATE INDEX IF NOT EXISTS idx_damage_records_fiscal_year ON damage_records(fiscal_year_id);
      CREATE INDEX IF NOT EXISTS idx_damage_records_demo ON damage_records(id) WHERE is_demo = TRUE;

      -- 8. Fixed Assets
      CREATE TABLE IF NOT EXISTS fixed_assets (
        id VARCHAR(50) PRIMARY KEY,
        tag_number VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        acquisition_date_ad DATE NOT NULL,
        acquisition_date_bs VARCHAR(20) NOT NULL,
        purchase_invoice_date_ad DATE,
        purchase_invoice_date_bs VARCHAR(20),
        capitalization_date_ad DATE,
        placed_in_service_date_ad DATE,
        acquisition_cost NUMERIC(12, 2) NOT NULL,
        depreciation_method VARCHAR(50) DEFAULT 'STRAIGHT_LINE',
        depreciation_rate_percent NUMERIC(5, 2) DEFAULT 15.00,
        accumulated_depreciation NUMERIC(12, 2) DEFAULT 0.00,
        net_book_value NUMERIC(12, 2) NOT NULL,
        status VARCHAR(30) DEFAULT 'ACTIVE',
        supplier_name VARCHAR(200),
        invoice_no VARCHAR(100),
        purchase_invoice_id VARCHAR(50),
        product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 8. Purchase Orders
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id VARCHAR(50) PRIMARY KEY,
        po_number VARCHAR(100) UNIQUE NOT NULL,
        supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier_name VARCHAR(200) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        order_date_ad DATE NOT NULL,
        order_date_bs VARCHAR(20) NOT NULL,
        expected_delivery_date_ad DATE,
        status VARCHAR(30) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'SENT', 'IN_PROGRESS', 'PURCHASED', 'RECEIVED', 'CANCELLED')),
        subtotal_amount NUMERIC(14, 2) DEFAULT 0.00,
        tax_amount NUMERIC(14, 2) DEFAULT 0.00,
        total_amount NUMERIC(14, 2) DEFAULT 0.00,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 9. Purchase Invoices
      CREATE TABLE IF NOT EXISTS purchase_invoices (
        id VARCHAR(50) PRIMARY KEY,
        invoice_number VARCHAR(100) UNIQUE NOT NULL,
        po_reference_id VARCHAR(50),
        vendor_bill_number VARCHAR(100),
        supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier_name VARCHAR(200) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        invoice_date_ad DATE NOT NULL,
        invoice_date_bs VARCHAR(20) NOT NULL,
        due_date_ad DATE,
        due_date_bs VARCHAR(20),
        taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
        vat_amount NUMERIC(14, 2) DEFAULT 0.00,
        non_taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
        grand_total NUMERIC(14, 2) DEFAULT 0.00,
        payment_status VARCHAR(30) DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PARTIAL', 'PAID')),
        payment_method VARCHAR(30) DEFAULT 'CREDIT' CHECK (payment_method IN ('CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE')),
        amount_paid NUMERIC(14, 2) DEFAULT 0.00,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 10. Shipments
      CREATE TABLE IF NOT EXISTS shipments (
        id VARCHAR(50) PRIMARY KEY,
        tracking_code VARCHAR(100) UNIQUE NOT NULL,
        type VARCHAR(50) DEFAULT 'INTER_BRANCH',
        source_branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
        source_branch_name VARCHAR(150),
        destination_branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        destination_branch_name VARCHAR(150),
        dispatch_date_ad DATE NOT NULL,
        dispatch_date_bs VARCHAR(20) NOT NULL,
        estimated_arrival_ad DATE,
        status VARCHAR(30) DEFAULT 'IN_TRANSIT',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 11. Stock Operations
      CREATE TABLE IF NOT EXISTS stock_operations (
        id VARCHAR(50) PRIMARY KEY,
        reference_number VARCHAR(100) UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        technician_name VARCHAR(150),
        work_order_ref VARCHAR(100),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        branch_name VARCHAR(150),
        destination_warehouse_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
        destination_warehouse_name VARCHAR(150),
        product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
        quantity_changed INT DEFAULT 0,
        cost_per_unit NUMERIC(12, 2) DEFAULT 0.00,
        total_value NUMERIC(12, 2) DEFAULT 0.00,
        reason TEXT NOT NULL,
        inspector_name VARCHAR(150),
        date_ad DATE NOT NULL,
        date_bs VARCHAR(20) NOT NULL,
        fiscal_year VARCHAR(20) DEFAULT '2082/83',
        status VARCHAR(30) DEFAULT 'LOGGED',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 12. Fiscal Years
      CREATE TABLE IF NOT EXISTS fiscal_years (
        id VARCHAR(50) PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        start_date_ad DATE NOT NULL,
        end_date_ad DATE NOT NULL,
        start_date_bs VARCHAR(20) NOT NULL,
        end_date_bs VARCHAR(20) NOT NULL,
        is_current BOOLEAN DEFAULT FALSE,
        is_closed BOOLEAN DEFAULT FALSE,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE
      );

      -- 13. Audit Trail
      CREATE TABLE IF NOT EXISTS audit_logs (
        id VARCHAR(50) PRIMARY KEY,
        user_email VARCHAR(150) NOT NULL,
        user_name VARCHAR(150) NOT NULL,
        action VARCHAR(100) NOT NULL,
        module VARCHAR(50) NOT NULL,
        details TEXT,
        timestamp_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        timestamp_bs VARCHAR(20),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL
      );

      -- 14. Transaction Logs
      CREATE TABLE IF NOT EXISTS transaction_logs (
        id VARCHAR(100) PRIMARY KEY,
        transaction_number VARCHAR(100) NOT NULL,
        product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
        product_sku VARCHAR(100),
        product_name VARCHAR(255),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        change_type VARCHAR(50) NOT NULL,
        quantity_before INT NOT NULL,
        quantity_changed INT NOT NULL,
        quantity_after INT NOT NULL,
        unit_cost NUMERIC(12, 2) DEFAULT 0.00,
        reference_doc_id VARCHAR(100),
        timestamp_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        timestamp_bs VARCHAR(20)
      );

      -- 15. Customer Records
      CREATE TABLE IF NOT EXISTS customer_records (
        id VARCHAR(50) PRIMARY KEY,
        customer_id VARCHAR(50) UNIQUE NOT NULL,
        customer_name VARCHAR(200) NOT NULL,
        username VARCHAR(100),
        contact_number VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        address TEXT,
        email VARCHAR(150),
        status VARCHAR(30) DEFAULT 'ACTIVE',
        credit_limit NUMERIC(12, 2) DEFAULT 0.00,
        assigned_devices_count INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 16. Customer Device Records
      CREATE TABLE IF NOT EXISTS customer_device_records (
        id VARCHAR(50) PRIMARY KEY,
        customer_id VARCHAR(50),
        customer_name VARCHAR(200) NOT NULL,
        customer_code VARCHAR(50) NOT NULL,
        contact_phone VARCHAR(50),
        installation_address TEXT,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        product_name VARCHAR(255) NOT NULL,
        device_serial VARCHAR(100) NOT NULL,
        pon_serial VARCHAR(100) NOT NULL,
        mac_address VARCHAR(100),
        status VARCHAR(30) DEFAULT 'ACTIVE',
        issued_date_ad DATE,
        issued_date_bs VARCHAR(20),
        purchase_bill_ref VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 16b. Serial Log (one row per unique serial, consolidated view)
      CREATE TABLE IF NOT EXISTS serial_log (
        id VARCHAR(50) PRIMARY KEY,
        device_serial VARCHAR(100) NOT NULL,
        pon_serial VARCHAR(100),
        mac_address VARCHAR(100),
        product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        customer_id VARCHAR(50),
        customer_name VARCHAR(200),
        status VARCHAR(30) NOT NULL DEFAULT 'IN_STOCK',
        source_type VARCHAR(30) NOT NULL DEFAULT 'PURCHASE',
        source_id VARCHAR(50),
        history_json TEXT DEFAULT '[]',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE
      );

      -- 17. Approval Requests
      CREATE TABLE IF NOT EXISTS approval_requests (
        id VARCHAR(50) PRIMARY KEY,
        request_number VARCHAR(100) UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        target_id VARCHAR(50),
        customer_name VARCHAR(200),
        customer_code VARCHAR(50),
        device_serial VARCHAR(100),
        pon_serial VARCHAR(100),
        product_name VARCHAR(255),
        current_status VARCHAR(30),
        requested_status VARCHAR(30),
        requested_by_role VARCHAR(50),
        requested_by_email VARCHAR(150),
        requested_by_name VARCHAR(150),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        branch_name VARCHAR(150),
        reason TEXT NOT NULL,
        restock_qty_on_approval BOOLEAN DEFAULT FALSE,
        status VARCHAR(30) DEFAULT 'PENDING',
        requested_at_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        requested_at_bs VARCHAR(20),
        processed_by_email VARCHAR(150),
        processed_by_name VARCHAR(150),
        processed_by_role VARCHAR(50),
        processed_at_ad TIMESTAMP WITH TIME ZONE,
        processed_at_bs VARCHAR(20),
        rejection_reason TEXT
      );

      -- 18. BS Calendar Years
      CREATE TABLE IF NOT EXISTS bs_calendar_years (
        year_bs INT PRIMARY KEY,
        days_in_months INT[] NOT NULL,
        start_ad DATE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 19. BS Day Records
      CREATE TABLE IF NOT EXISTS bs_day_records (
        ad_date DATE PRIMARY KEY,
        bs_date VARCHAR(20) NOT NULL,
        bs_year INT NOT NULL,
        bs_month INT NOT NULL,
        bs_month_name VARCHAR(50) NOT NULL,
        bs_month_name_np VARCHAR(50) NOT NULL,
        bs_day INT NOT NULL,
        day_of_week_name VARCHAR(30) NOT NULL,
        day_of_week_name_np VARCHAR(30) NOT NULL,
        fiscal_year VARCHAR(20) NOT NULL,
        quarter VARCHAR(10) NOT NULL,
        is_weekend BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 20. UOM (Unit of Measure)
      CREATE TABLE IF NOT EXISTS uom (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        symbol VARCHAR(30) NOT NULL,
        type VARCHAR(50) DEFAULT 'Count',
        is_base_unit BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 21. Locations
      CREATE TABLE IF NOT EXISTS locations (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        type VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        address TEXT,
        coordinates JSONB,
        contact_person VARCHAR(150),
        contact_phone VARCHAR(50),
        notes TEXT,
        active_assets_count INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 22. Company Profile
      CREATE TABLE IF NOT EXISTS company_profile (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        legal_name VARCHAR(255),
        tagline VARCHAR(255),
        address TEXT NOT NULL,
        city VARCHAR(100),
        country VARCHAR(100),
        postal_code VARCHAR(30),
        phone VARCHAR(100),
        email VARCHAR(100),
        website VARCHAR(100),
        pan_vat_number VARCHAR(100),
        registration_number VARCHAR(100),
        logo_url TEXT,
        logo_preset VARCHAR(50),
        currency_symbol VARCHAR(20),
        currency_code VARCHAR(10) DEFAULT 'NPR',
        currency_locale VARCHAR(20) DEFAULT 'en-IN',
        currency_position VARCHAR(10) DEFAULT 'before',
        currency_decimals INT DEFAULT 2,
        default_tax_rate NUMERIC,
        notes TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 23. Document Numbering Configurations
      CREATE TABLE IF NOT EXISTS document_number_configs (
        id VARCHAR(50) PRIMARY KEY,
        document_type VARCHAR(150) NOT NULL,
        prefix VARCHAR(50) DEFAULT '',
        suffix VARCHAR(50) DEFAULT '',
        min_digits INT DEFAULT 4,
        starting_number INT DEFAULT 1,
        next_number INT DEFAULT 1,
        reset_every_fiscal_year BOOLEAN DEFAULT TRUE,
        notes TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 23b. Daily Document Sequence Counters (per branch, per doc type, per day)
      CREATE TABLE IF NOT EXISTS document_sequence_daily (
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        doc_type VARCHAR(20) NOT NULL,
        date_ad DATE NOT NULL,
        next_number INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (branch_id, doc_type, date_ad)
      );
      CREATE INDEX IF NOT EXISTS idx_document_sequence_daily_branch ON document_sequence_daily(branch_id);
      CREATE INDEX IF NOT EXISTS idx_document_sequence_daily_date ON document_sequence_daily(date_ad);

      -- SCHEMA MIGRATION SAFE ALTERS
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS vendor_bill_number VARCHAR(100);
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) DEFAULT 'CREDIT';
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_by_notes TEXT;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_date_ad DATE;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_date_bs VARCHAR(20);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS has_discrepancy BOOLEAN DEFAULT FALSE;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS items JSONB;
      -- Currency & locale columns for globally-configurable money formatting.
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS postal_code VARCHAR(30);
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10) DEFAULT 'NPR';
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS currency_locale VARCHAR(20) DEFAULT 'en-IN';
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS currency_position VARCHAR(10) DEFAULT 'before';
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS currency_decimals INT DEFAULT 2;
      -- Backfill an existing profile that only had the old symbol column.
      UPDATE company_profile SET
        currency_code = 'NPR',
        currency_locale = 'en-IN',
        currency_position = 'before',
        currency_decimals = 2
        WHERE currency_code IS NULL OR currency_code = '';
      -- Drop the stale hard-coded fiscal-year default (fiscal year is now
      -- derived from the record date at write time).
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_operations' AND column_name = 'fiscal_year' AND column_default IS NOT NULL) THEN
          ALTER TABLE stock_operations ALTER COLUMN fiscal_year DROP DEFAULT;
        END IF;
      END $$;
      ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_module_check;
      ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_module_check CHECK (module IN (
        'AUTH', 'MASTER_DATA', 'PRODUCTS', 'CATEGORIES', 'PROCUREMENT', 'LOGISTICS',
        'STOCK_OPERATIONS', 'FIXED_ASSETS', 'CPE_MANAGEMENT', 'INVENTORY', 'INVENTORY_AUDIT',
        'OPERATIONS', 'BRANCH_OPERATIONS', 'FISCAL_YEAR', 'APPROVAL_WORKFLOW', 'SYSTEM'
      ));
      CREATE TABLE IF NOT EXISTS fiscal_year_opening_stock (
        id VARCHAR(100) PRIMARY KEY,
        fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
        product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        quantity_on_hand INT NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
        damaged_qty INT NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
        unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
        source_type VARCHAR(30) NOT NULL DEFAULT 'FISCAL_CLOSE',
        source_reference VARCHAR(100),
        posted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        posted_by VARCHAR(150),
        UNIQUE (fiscal_year_id, product_id, branch_id)
      );

      -- 24. Fiscal-Year Vendor Opening Balances (Vendor Ledger roll-forward)
      CREATE TABLE IF NOT EXISTS vendor_opening_balances (
        id VARCHAR(100) PRIMARY KEY,
        fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
        supplier_id VARCHAR(50) NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        opening_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
        source_type VARCHAR(30) NOT NULL DEFAULT 'FISCAL_CLOSE',
        source_reference VARCHAR(100),
        posted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        posted_by VARCHAR(150),
        is_demo BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(150),
        UNIQUE (fiscal_year_id, supplier_id, branch_id)
      );

      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS source_type VARCHAR(30) NOT NULL DEFAULT 'FISCAL_CLOSE';
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS source_reference VARCHAR(100);
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS posted_by VARCHAR(150);
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      CREATE INDEX IF NOT EXISTS idx_vendor_opening_fy ON vendor_opening_balances(fiscal_year_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_opening_supplier ON vendor_opening_balances(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_opening_branch ON vendor_opening_balances(branch_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_opening_demo ON vendor_opening_balances(id) WHERE is_demo = TRUE;

      -- HIGH-THROUGHPUT COMPOSITE PERFORMANCE INDEXES --
      CREATE INDEX IF NOT EXISTS idx_branches_code ON branches(code);
      CREATE INDEX IF NOT EXISTS idx_branches_active ON branches(active);

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);

      CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group);

      CREATE INDEX IF NOT EXISTS idx_stock_prod_branch ON inventory_stock(product_id, branch_id);
      CREATE INDEX IF NOT EXISTS idx_stock_branch ON inventory_stock(branch_id);
      CREATE INDEX IF NOT EXISTS idx_stock_reorder ON inventory_stock(quantity_on_hand, min_reorder_level);

      CREATE INDEX IF NOT EXISTS idx_assets_tag ON fixed_assets(tag_number);
      CREATE INDEX IF NOT EXISTS idx_assets_branch ON fixed_assets(branch_id);
      CREATE INDEX IF NOT EXISTS idx_assets_status ON fixed_assets(status);

      CREATE INDEX IF NOT EXISTS idx_orders_num ON purchase_orders(po_number);
      CREATE INDEX IF NOT EXISTS idx_orders_branch ON purchase_orders(branch_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON purchase_orders(status);

      CREATE INDEX IF NOT EXISTS idx_invoices_num ON purchase_invoices(invoice_number);
      CREATE INDEX IF NOT EXISTS idx_invoices_branch ON purchase_invoices(branch_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON purchase_invoices(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON purchase_invoices(payment_status);

      CREATE INDEX IF NOT EXISTS idx_shipments_track ON shipments(tracking_code);
      CREATE INDEX IF NOT EXISTS idx_shipments_src_dst ON shipments(source_branch_id, destination_branch_id);
      CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);

      CREATE INDEX IF NOT EXISTS idx_stock_ops_ref ON stock_operations(reference_number);
      CREATE INDEX IF NOT EXISTS idx_stock_ops_branch ON stock_operations(branch_id);
      CREATE INDEX IF NOT EXISTS idx_stock_ops_type ON stock_operations(type);

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp_ad DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_email);
      CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module);
      CREATE INDEX IF NOT EXISTS idx_audit_branch ON audit_logs(branch_id);

      CREATE INDEX IF NOT EXISTS idx_txn_product ON transaction_logs(product_id);
      CREATE INDEX IF NOT EXISTS idx_txn_branch ON transaction_logs(branch_id);
      CREATE INDEX IF NOT EXISTS idx_txn_timestamp ON transaction_logs(timestamp_ad DESC);

      CREATE INDEX IF NOT EXISTS idx_customers_id ON customer_records(customer_id);
      CREATE INDEX IF NOT EXISTS idx_customers_branch ON customer_records(branch_id);

      CREATE INDEX IF NOT EXISTS idx_device_serials ON customer_device_records(device_serial, pon_serial, mac_address);
      CREATE INDEX IF NOT EXISTS idx_device_branch ON customer_device_records(branch_id, status);

      CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status, branch_id);
      CREATE INDEX IF NOT EXISTS idx_approval_type ON approval_requests(type);

      CREATE INDEX IF NOT EXISTS idx_bs_days_date ON bs_day_records(bs_date);
      CREATE INDEX IF NOT EXISTS idx_bs_days_ym ON bs_day_records(bs_year, bs_month);

      -- Exactly one fiscal year may be flagged current (prevents the
      -- ambiguous-default bug where two rows had is_current = TRUE).
      DROP INDEX IF EXISTS uq_fiscal_years_single_current;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_years_single_current ON fiscal_years ((is_current)) WHERE is_current = TRUE;

      -- Fiscal-year/branch scoped bootstrap query support
      CREATE INDEX IF NOT EXISTS idx_po_branch_order_date ON purchase_orders(branch_id, order_date_ad);
      CREATE INDEX IF NOT EXISTS idx_pi_branch_invoice_date ON purchase_invoices(branch_id, invoice_date_ad);
      CREATE INDEX IF NOT EXISTS idx_shipments_dispatch_date ON shipments(dispatch_date_ad);
      CREATE INDEX IF NOT EXISTS idx_assets_acquisition_date ON fixed_assets(acquisition_date_ad);
      CREATE INDEX IF NOT EXISTS idx_devices_issued_date ON customer_device_records(issued_date_ad);
      CREATE INDEX IF NOT EXISTS idx_stock_ops_date ON stock_operations(date_ad);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp_ad DESC);

      -- v3.0 enterprise migration: demo tracking (is_demo), audit columns
      -- (created_by/updated_by/updated_at) and fiscal_year_id FKs tying every
      -- transactional document to the fiscal_years master table.
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_special_tracked BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE fiscal_years ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS purchase_invoice_date_ad DATE;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS purchase_invoice_date_bs VARCHAR(20);
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS capitalization_date_ad DATE;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS placed_in_service_date_ad DATE;
      UPDATE fixed_assets SET purchase_invoice_date_ad = acquisition_date_ad WHERE purchase_invoice_date_ad IS NULL;
      UPDATE fixed_assets SET purchase_invoice_date_bs = acquisition_date_bs WHERE purchase_invoice_date_bs IS NULL;
      UPDATE fixed_assets SET capitalization_date_ad = acquisition_date_ad WHERE capitalization_date_ad IS NULL;
      UPDATE fixed_assets SET placed_in_service_date_ad = acquisition_date_ad WHERE placed_in_service_date_ad IS NULL;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      -- 24. Vendor Payments Sub-ledger
      CREATE TABLE IF NOT EXISTS vendor_payments (
        id VARCHAR(50) PRIMARY KEY,
        payment_number VARCHAR(100) UNIQUE NOT NULL,
        supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier_name VARCHAR(200) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
        invoice_id VARCHAR(50) REFERENCES purchase_invoices(id) ON DELETE SET NULL,
        invoice_number VARCHAR(100),
        payment_date_ad DATE NOT NULL,
        payment_date_bs VARCHAR(20),
        amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
        payment_method VARCHAR(30) DEFAULT 'CASH' CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER')),
        bank_name VARCHAR(150),
        bank_branch VARCHAR(150),
        account_number VARCHAR(100),
        cheque_number VARCHAR(100),
        cheque_date_ad DATE,
        cheque_date_bs VARCHAR(20),
        transaction_reference VARCHAR(200),
        notes TEXT,
        status VARCHAR(30) DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED', 'VOIDED')),
        reversal_reason TEXT,
        reversed_by VARCHAR(150),
        reversed_at_ad TIMESTAMP WITH TIME ZONE,
        original_payment_id VARCHAR(50) REFERENCES vendor_payments(id) ON DELETE SET NULL,
        fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(150),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_supplier ON vendor_payments(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_branch ON vendor_payments(branch_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_invoice ON vendor_payments(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_date ON vendor_payments(payment_date_ad);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_status ON vendor_payments(status);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_fiscal_year ON vendor_payments(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_demo ON vendor_payments(id) WHERE is_demo = TRUE;
      -- 29. Permission Matrix (server-side authority for role-based operation gating)
      CREATE TABLE IF NOT EXISTS permission_matrix (
        operation_id VARCHAR(60) NOT NULL,
        role VARCHAR(40) NOT NULL,
        allowed BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (operation_id, role)
      );
      CREATE INDEX IF NOT EXISTS idx_permission_matrix_role ON permission_matrix(role);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE fiscal_year_opening_stock ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE fiscal_year_opening_stock ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE transaction_logs ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE transaction_logs ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE transaction_logs ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      -- stock_operations.type: the disposal write-off flow posts type
      -- 'DISPOSAL' (DamagedStockTracking disposal modal). Existing databases
      -- created before DISPOSAL shipped carry a CHECK without it.
      ALTER TABLE stock_operations DROP CONSTRAINT IF EXISTS stock_operations_type_check;
      ALTER TABLE stock_operations ADD CONSTRAINT stock_operations_type_check CHECK (
        type IN ('PULLOUT', 'DAMAGE', 'DISPOSAL', 'STOCK_OUT', 'MANUAL_ADJUSTMENT', 'CONSUMABLE_ISSUE')
      );
      -- vendor_payments.payment_method: the invoice payment UI offers CREDIT
      -- ("Credit / Adjustment") and forwards it to the vendor sub-ledger.
      ALTER TABLE vendor_payments DROP CONSTRAINT IF EXISTS vendor_payments_payment_method_check;
      ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_payment_method_check CHECK (
        payment_method IN ('CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER')
      );
      -- locations.type: the Locations form offers FIBER_NETWORK_NODE,
      -- CUSTOMER_SITE and BRANCH_OFFICE — keep the DB check in sync.
      ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_type_check;
      ALTER TABLE locations ADD CONSTRAINT locations_type_check CHECK (
        type IN ('POP_SERVER_ROOM', 'FIBER_NETWORK_NODE', 'CUSTOMER_SITE', 'WAREHOUSE', 'BRANCH_OFFICE', 'STORE', 'OFFICE', 'DEPOT')
      );
      -- Allow the extended stock-movement event types used by the operational
      -- modules (Stock Operations, Damage Disposal, Product Stock-Out). Fresh
      -- installs already get the new list from the CREATE TABLE above; this is
      -- a no-op rewrite on databases created before the extended set shipped.
      ALTER TABLE transaction_logs DROP CONSTRAINT IF EXISTS transaction_logs_change_type_check;
      ALTER TABLE transaction_logs ADD CONSTRAINT transaction_logs_change_type_check CHECK (
        change_type IN ('INBOUND_PO', 'PURCHASE_INVOICE', 'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT',
          'DAMAGE', 'DAMAGE_REVERSED', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT',
          'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN',
          'TRANSFER_CANCELLED', 'TRANSFER_RECEIPT_CANCELLED')
      );
      ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE bs_day_records ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      -- is_demo labelling for master tables seeded with example/dummy data
      -- (Nepali/BS calendar tables are real reference data and never carry it)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE branches ADD COLUMN IF NOT EXISTS allow_warehouse_transfer BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE locations ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      -- v3.0 partial indexes: demo-row fast paths and fiscal-year scoping
      CREATE INDEX IF NOT EXISTS idx_suppliers_demo ON suppliers(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_categories_demo ON categories(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_products_demo ON products(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_inventory_stock_demo ON inventory_stock(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_demo ON fixed_assets(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_demo ON purchase_orders(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_purchase_invoices_demo ON purchase_invoices(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_shipments_demo ON shipments(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_stock_operations_demo ON stock_operations(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_audit_logs_demo ON audit_logs(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_transaction_logs_demo ON transaction_logs(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_customer_records_demo ON customer_records(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_customer_device_records_demo ON customer_device_records(id) WHERE is_demo = TRUE;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_device_serial ON customer_device_records ((lower(trim(device_serial)))) WHERE trim(device_serial) <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_pon_serial ON customer_device_records ((lower(trim(pon_serial)))) WHERE trim(pon_serial) <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_mac_address ON customer_device_records ((lower(trim(mac_address)))) WHERE mac_address IS NOT NULL AND trim(mac_address) <> '';
      CREATE INDEX IF NOT EXISTS idx_approval_requests_demo ON approval_requests(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_fiscal_year_id ON fixed_assets(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_purchase_invoice_id ON fixed_assets(purchase_invoice_id) WHERE purchase_invoice_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_invoice_date ON fixed_assets(branch_id, purchase_invoice_date_ad);
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_service_date ON fixed_assets(branch_id, placed_in_service_date_ad);
      CREATE INDEX IF NOT EXISTS idx_fiscal_years_start_date ON fiscal_years(start_date_ad DESC);
      CREATE INDEX IF NOT EXISTS idx_fiscal_years_demo ON fiscal_years(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_fiscal_year_id ON purchase_orders(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_purchase_invoices_fiscal_year_id ON purchase_invoices(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_shipments_fiscal_year_id ON shipments(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_stock_operations_fiscal_year_id ON stock_operations(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audit_logs_fiscal_year_id ON audit_logs(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_transaction_logs_fiscal_year_id ON transaction_logs(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_customer_device_records_fiscal_year_id ON customer_device_records(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_approval_requests_fiscal_year_id ON approval_requests(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_bs_day_records_fiscal_year_id ON bs_day_records(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE OR REPLACE FUNCTION assign_fiscal_year_id_from_date()
      RETURNS trigger AS $$
      DECLARE date_value DATE;
      BEGIN
        IF NEW.fiscal_year_id IS NULL THEN
          date_value := (to_jsonb(NEW) ->> TG_ARGV[0])::DATE;
          SELECT id INTO NEW.fiscal_year_id FROM fiscal_years
          WHERE start_date_ad <= date_value AND end_date_ad >= date_value
          ORDER BY start_date_ad DESC LIMIT 1;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE OR REPLACE TRIGGER trg_fixed_assets_fiscal_year BEFORE INSERT OR UPDATE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('acquisition_date_ad');
      CREATE OR REPLACE TRIGGER trg_purchase_orders_fiscal_year BEFORE INSERT OR UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('order_date_ad');
      CREATE OR REPLACE TRIGGER trg_purchase_invoices_fiscal_year BEFORE INSERT OR UPDATE ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('invoice_date_ad');
      CREATE OR REPLACE TRIGGER trg_shipments_fiscal_year BEFORE INSERT OR UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('dispatch_date_ad');
      CREATE OR REPLACE TRIGGER trg_stock_operations_fiscal_year BEFORE INSERT OR UPDATE ON stock_operations FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('date_ad');
      CREATE OR REPLACE TRIGGER trg_audit_logs_fiscal_year BEFORE INSERT OR UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('timestamp_ad');
      CREATE OR REPLACE TRIGGER trg_transaction_logs_fiscal_year BEFORE INSERT OR UPDATE ON transaction_logs FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('timestamp_ad');
      CREATE OR REPLACE TRIGGER trg_customer_devices_fiscal_year BEFORE INSERT OR UPDATE ON customer_device_records FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('issued_date_ad');
      CREATE OR REPLACE TRIGGER trg_approval_requests_fiscal_year BEFORE INSERT OR UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('requested_at_ad');
      CREATE OR REPLACE TRIGGER trg_vendor_payments_fiscal_year BEFORE INSERT OR UPDATE ON vendor_payments FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('payment_date_ad');
      UPDATE fixed_assets SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE acquisition_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE purchase_orders SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE order_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE purchase_invoices SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE invoice_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE shipments SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE dispatch_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE stock_operations SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE customer_device_records SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE issued_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE vendor_payments SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE payment_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;

      -- Serial Log ALTER TABLE additions
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_serial_log_demo ON serial_log(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_serial_log_device_serial ON serial_log((lower(trim(device_serial))));
      CREATE INDEX IF NOT EXISTS idx_serial_log_branch ON serial_log(branch_id) WHERE branch_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_serial_log_status ON serial_log(status);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_serial_log_device_serial ON serial_log ((lower(trim(device_serial)))) WHERE trim(device_serial) <> '';
    `);

    isPgConnected = true;
    setIsPgConnected(true);
    await seedInitialPostgresData(client);
    await hydrateOperationalData(client);
    await backfillSerialLog(client);
    await loadPermissionMatrixFromDb(client);
    await hydrateBsCalendarFromDb(client);

    client.release();
    console.log('✅ All 29 Database tables and enterprise composite performance indexes synced successfully on PostgreSQL.');
  } catch (err: any) {
    isPgConnected = false;
    setIsPgConnected(false);
    throw new Error(`PostgreSQL startup failed: ${err?.message || err}`);
  }
}

async function seedInitialPostgresData(client: pg.PoolClient) {
  try {
    for (const b of INITIAL_MASTER_BRANCHES) {
      await client.query(
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement, allow_warehouse_transfer, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.code, b.name, b.location, b.phone || '', b.isHeadquarters || false, b.active !== false, b.allowProcurement !== false, b.allowWarehouseTransfer !== false]
      );
    }
    for (const fy of INITIAL_MASTER_FISCAL_YEARS) {
      await client.query(
        `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (id) DO NOTHING`,
        [fy.id, fy.code, fy.startDateAD || '2025-07-16', fy.endDateAD || '2026-07-15', fy.startDateBS || '2082-04-01', fy.endDateBS || '2083-03-31', fy.isCurrent || false, fy.isClosed || false]
      );
    }
    // Seed Company Profile if empty
    await client.query(
      `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, postal_code, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, currency_code, currency_locale, currency_position, currency_decimals, default_tax_rate, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) ON CONFLICT (id) DO NOTHING`,
      [
        INITIAL_COMPANY_PROFILE.id,
        INITIAL_COMPANY_PROFILE.name,
        INITIAL_COMPANY_PROFILE.legalName,
        INITIAL_COMPANY_PROFILE.tagline,
        INITIAL_COMPANY_PROFILE.address,
        INITIAL_COMPANY_PROFILE.city,
        INITIAL_COMPANY_PROFILE.country,
        INITIAL_COMPANY_PROFILE.postalCode || '',
        INITIAL_COMPANY_PROFILE.phone,
        INITIAL_COMPANY_PROFILE.email,
        INITIAL_COMPANY_PROFILE.website,
        INITIAL_COMPANY_PROFILE.panVatNumber,
        INITIAL_COMPANY_PROFILE.registrationNumber,
        INITIAL_COMPANY_PROFILE.logoUrl,
        INITIAL_COMPANY_PROFILE.logoPreset,
        INITIAL_COMPANY_PROFILE.currencySymbol,
        INITIAL_COMPANY_PROFILE.currencyCode || 'NPR',
        INITIAL_COMPANY_PROFILE.currencyLocale || 'en-IN',
        INITIAL_COMPANY_PROFILE.currencyPosition || 'before',
        INITIAL_COMPANY_PROFILE.currencyDecimals ?? 2,
        INITIAL_COMPANY_PROFILE.defaultTaxRate,
        INITIAL_COMPANY_PROFILE.notes,
      ]
    );

    for (const u of INITIAL_MASTER_UOM) {
      await client.query(
        `INSERT INTO uom (id, name, symbol, type, is_base_unit)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
        [u.id, u.name, u.symbol, u.type, u.isBaseUnit]
      );
    }
    for (const l of INITIAL_MASTER_LOCATIONS) {
      await client.query(
        `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE) ON CONFLICT (id) DO NOTHING`,
        [l.id, l.name, l.type, l.branchId, l.address, JSON.stringify(l.coordinates), l.contactPerson, l.contactPhone, l.notes, l.activeAssetsCount]
      );
    }

    for (const s of INITIAL_MASTER_SUPPLIERS) {
      const sup = s as any;
      await client.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE) ON CONFLICT (id) DO NOTHING`,
        [sup.id, sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', sup.rating || 5.0, sup.status || 'ACTIVE']
      );
    }

    // Example/dummy user accounts (is_demo = TRUE) so the app is testable out
    // of the box after a fresh setup. Never overwrite existing accounts.
    for (const eu of INITIAL_EXAMPLE_USERS) {
      const allowedBranchIds = eu.role === 'SUPER_ADMIN' ? INITIAL_MASTER_BRANCHES.map((b) => b.id) : [eu.branchId];
      await client.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (email) DO NOTHING`,
        [eu.id, eu.email, hashPassword(EXAMPLE_USER_PASSWORD), eu.name, eu.role, eu.branchId, allowedBranchIds, eu.canSwitchUser]
      );
    }

for (const cfg of INITIAL_DOCUMENT_NUMBER_CONFIGS) {
      await client.query(
        `INSERT INTO document_number_configs (id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
         [cfg.id, cfg.documentType, cfg.prefix || '', cfg.suffix || '', cfg.minDigits || 4, cfg.startingNumber || 1, cfg.nextNumber || 1, cfg.resetEveryFiscalYear !== false, cfg.notes || '']
       );
     }

     // Seed the server-side permission matrix from the canonical defaults.
     // Idempotent: only insert operations/roles that are missing so a restart
     // never silently reverts matrix customizations made via the API.
     const matrixEntries: Array<[string, string, boolean]> = [];
     for (const [opId, roles] of Object.entries(DEFAULT_PERMISSIONS_MATRIX)) {
       for (const [role, allowed] of Object.entries(roles)) {
         matrixEntries.push([opId, role, allowed]);
       }
     }
     for (const [opId, role, allowed] of matrixEntries) {
       await client.query(
         `INSERT INTO permission_matrix (operation_id, role, allowed) VALUES ($1, $2, $3) ON CONFLICT (operation_id, role) DO NOTHING`,
         [opId, role, allowed]
       );
     }

     // Master data (branches, users, uom, locations, suppliers, fiscal years,
     // company profile) is hydrated by hydrateOperationalData / CACHE_LOADS —
     // called right after this seed function.
    const docCfgRes = await client.query('SELECT id, document_type AS "documentType", prefix, suffix, min_digits AS "minDigits", starting_number AS "startingNumber", next_number AS "nextNumber", reset_every_fiscal_year AS "resetEveryFiscalYear", notes FROM document_number_configs ORDER BY id ASC');
    if (docCfgRes.rows.length > 0) docNumberConfigs = docCfgRes.rows;

    console.log('✅ Master data seeded and hydrated. Operational data is always served from PostgreSQL (single source of truth).');
  } catch (seedErr: any) {
    console.log('PostgreSQL initial seed note:', seedErr?.message || seedErr);
  }
}

// Load the server-side permission matrix into memory from PostgreSQL.
async function loadPermissionMatrixFromDb(client: pg.PoolClient): Promise<void> {
  const result = await client.query('SELECT operation_id, role, allowed FROM permission_matrix');
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const row of result.rows) {
    const opId = row.operation_id as string;
    const role = row.role as string;
    if (!matrix[opId]) matrix[opId] = {};
    matrix[opId][role] = Boolean(row.allowed);
  }
  permissionMatrix = matrix;
  console.log(`✅ Server-side permission matrix loaded: ${Object.keys(matrix).length} operations mapped.`);
}

// The ONE list of operational cache loads: every cache array below is read
// from PostgreSQL through exactly this list — at boot (hydrateOperationalData)
// and after every committed write (refreshOperationalCache). Adding a cached
// column or table means editing its entry here and nowhere else.
export const CACHE_LOADS: Array<{ name: string; query: string; apply: (rows: any[]) => void }> = [
  {
    name: 'branches',
    query: 'SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement", allow_warehouse_transfer AS "allowWarehouseTransfer" FROM branches ORDER BY code',
    apply: (rows) => { if (rows.length > 0) branches = rows; },
  },
  {
// Password hashes ride along in the users cache: the login endpoint
// authenticates from this array.
    name: 'users',
    query: 'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC',
    apply: (rows) => { if (rows.length > 0) users = rows; },
  },
  {
    name: 'uom',
    query: 'SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC',
    apply: (rows) => { if (rows.length > 0) uomList = rows; },
  },
  {
    name: 'locations',
    query: 'SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations ORDER BY name ASC',
    apply: (rows) => { if (rows.length > 0) locationRecords = rows; },
  },
  {
    name: 'suppliers',
    query: 'SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC',
    apply: (rows) => { if (rows.length > 0) suppliers = rows; },
  },
  {
    name: 'fiscal_years',
    query: 'SELECT id, code, start_date_ad AS "startDateAD", end_date_ad AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo" FROM fiscal_years ORDER BY start_date_ad DESC',
    apply: (rows) => { if (rows.length > 0) fiscalYears = rows; },
  },
  {
    name: 'company_profile',
    query: 'SELECT id, name, legal_name AS "legalName", tagline, address, city, country, postal_code AS "postalCode", phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", currency_code AS "currencyCode", currency_locale AS "currencyLocale", currency_position AS "currencyPosition", currency_decimals AS "currencyDecimals", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1',
    apply: (rows) => { if (rows.length > 0) companyProfile = rows[0]; },
  },
  {
    name: 'products',
    query: 'SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products',
    apply: (rows) => { products = rows; },
  },
  {
    name: 'categories',
    query: 'SELECT id, name, code, description, is_special_tracked AS "isSpecialTracked" FROM categories ORDER BY name ASC',
    apply: (rows) => { categories = rows; },
  },
  {
    name: 'inventory_stock',
    query: 'SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock',
    apply: (rows) => { inventoryStock = rows; },
  },
  {
    name: 'fixed_assets',
    query: 'SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo", purchase_invoice_id AS "purchaseInvoiceId", product_id AS "productId" FROM fixed_assets',
    apply: (rows) => { assetRegister = rows; },
  },
  {
    name: 'purchase_orders',
    query: 'SELECT id, po_number AS "poNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS", expected_delivery_date_ad AS "expectedDeliveryDateAD", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders',
    apply: (rows) => { purchaseOrders = rows; },
  },
  {
    name: 'purchase_invoices',
    query: 'SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", amount_paid AS "amountPaid", items FROM purchase_invoices',
    apply: (rows) => { purchaseInvoices = rows; },
  },
  {
    name: 'shipments',
    query: 'SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS", estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAD", received_date_bs AS "receivedDateBS", has_discrepancy AS "hasDiscrepancy" FROM shipments',
    apply: (rows) => { shipments = rows; },
  },
  {
    name: 'stock_operations',
    query: 'SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAD", date_bs AS "dateBS", fiscal_year AS "fiscalYear", status, items FROM stock_operations',
    apply: (rows) => { stockOperations = rows; },
  },
  {
    name: 'audit_logs',
    query: 'SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs ORDER BY timestamp_ad DESC',
    apply: (rows) => { auditTrail = rows; },
  },
  {
    name: 'transaction_logs',
    query: 'SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs ORDER BY timestamp_ad DESC',
    apply: (rows) => { transactionLogs = rows; },
  },
  {
    name: 'customer_records',
    query: 'SELECT id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount" FROM customer_records',
    apply: (rows) => { customerMasterRecords = rows; },
  },
  {
    name: 'customer_device_records',
    query: 'SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAD", issued_date_bs AS "issuedDateBS", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records',
    apply: (rows) => { customerDeviceRecords = rows; },
  },
  {
    name: 'vendor_payments',
    query: 'SELECT id, payment_number AS "paymentNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_id AS "invoiceId", invoice_number AS "invoiceNumber", payment_date_ad AS "paymentDateAD", payment_date_bs AS "paymentDateBS", amount, payment_method AS "paymentMethod", bank_name AS "bankName", bank_branch AS "bankBranch", account_number AS "accountNumber", cheque_number AS "chequeNumber", cheque_date_ad AS "chequeDateAD", cheque_date_bs AS "chequeDateBS", transaction_reference AS "transactionReference", notes, status, reversal_reason AS "reversalReason", reversed_by AS "reversedBy", reversed_at_ad AS "reversedAtAD", original_payment_id AS "originalPaymentId", fiscal_year_id AS "fiscalYearId", is_demo AS "isDemo", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt" FROM vendor_payments ORDER BY payment_date_ad DESC, created_at DESC',
    apply: (rows) => { vendorPayments = rows; },
  },
  {
    name: 'serial_log',
    query: 'SELECT id, device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", product_id AS "productId", product_name AS "productName", branch_id AS "branchId", customer_id AS "customerId", customer_name AS "customerName", status, source_type AS "sourceType", source_id AS "sourceId", history_json AS "historyJson", created_at AS "createdAt", updated_at AS "updatedAt" FROM serial_log ORDER BY created_at DESC',
    apply: (rows) => {
        serialLogs = rows.map((r: any) => ({
          ...r,
          history: (() => { try { return typeof r.historyJson === 'string' ? JSON.parse(r.historyJson || '[]') : (r.historyJson || []); } catch { return []; } })(),
        }));
  },
  },
  {
    name: 'vendor_opening_balances',
    query: 'SELECT id, fiscal_year_id AS "fiscalYearId", supplier_id AS "supplierId", branch_id AS "branchId", opening_balance::float AS "openingBalance", source_type AS "sourceType", source_reference AS "sourceReference", posted_at::text AS "postedAt", posted_by AS "postedBy" FROM vendor_opening_balances',
    apply: (rows) => { vendorOpeningBalances = rows; },
  },
];

// Boot-time hydration runs the same CACHE_LOADS list on the startup client.
export async function hydrateOperationalData(client: pg.PoolClient) {
  for (const load of CACHE_LOADS) {
    try {
      const result = await client.query(load.query);
      load.apply(result.rows);
    } catch (e: any) {
      console.warn(`Operational cache hydration skipped for ${load.name}:`, e?.message || e);
    }
  }
  console.log(
    `✅ Operational caches hydrated from PostgreSQL: ` +
    `${products.length} products, ${inventoryStock.length} stock rows, ${purchaseOrders.length} POs, ` +
    `${purchaseInvoices.length} invoices, ${shipments.length} shipments, ${stockOperations.length} stock ops, ` +
    `${vendorPayments.length} vendor payments, ${vendorOpeningBalances.length} vendor opening balances.`
  );
}

// Serial-log backfill: converges every legacy serial source (purchase invoices,
// shipments, stock operations, serial-tracked fixed assets, customer devices)
// into ONE row per unique device_serial. Later/priority sources win; terminal
// manual states (DAMAGED, CUSTOMER_ASSIGNED, RETURNED, POP_LOCATION_ASSIGNED)
// are never downgraded by the backfill.
async function backfillSerialLog(client: pg.PoolClient) {
  try {
    const asArray = (v: any): any[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
      return [];
    };
    const keyOf = (s: any) => String(s || '').trim().toLowerCase();
    const isoDate = (d: any) => { const s = String(d || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10); };

    type Cand = {
      deviceSerial: string; ponSerial?: string; macAddress?: string;
      productId?: string; productName?: string; branchId?: string;
      customerId?: string; customerName?: string;
      status: string; sourceType: string; sourceId?: string; dateAD?: string;
    };
    const merged = new Map<string, Cand>();
    const put = (c: Cand, force = false) => {
      const k = keyOf(c.deviceSerial);
      if (!k) return;
      const prev = merged.get(k);
      if (!prev) { merged.set(k, c); return; }
      // DAMAGED always wins; otherwise later (higher-priority) sources win.
      if (c.status === 'DAMAGED' || force || prev.status === 'IN_STOCK' || prev.status === 'IN_TRANSIT') {
        merged.set(k, {
          ...c,
          ponSerial: c.ponSerial || prev.ponSerial,
          macAddress: c.macAddress || prev.macAddress,
          productId: c.productId || prev.productId,
          productName: c.productName || prev.productName,
          branchId: c.branchId || prev.branchId,
        });
      }
    };

    // 1. Purchase invoices → IN_STOCK
    const piRes = await client.query('SELECT id, branch_id, invoice_date_ad, items FROM purchase_invoices');
    for (const inv of piRes.rows) {
      for (const item of asArray(inv.items)) {
        for (const s of asArray(item.deviceSerials)) {
          if (!keyOf(s.deviceSerial)) continue;
          put({
            deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
            productId: item.productId, productName: item.productName || item.sku,
            branchId: inv.branch_id, status: 'IN_STOCK', sourceType: 'PURCHASE',
            sourceId: inv.id, dateAD: isoDate(inv.invoice_date_ad),
          });
        }
      }
    }

    // 2. Shipments → IN_TRANSIT (dispatched) or IN_STOCK (received)
    const shRes = await client.query('SELECT id, status, destination_branch_id, dispatch_date_ad, items FROM shipments');
    for (const sh of shRes.rows) {
      const inTransit = sh.status === 'DISPATCHED' || sh.status === 'IN_TRANSIT';
      for (const item of asArray(sh.items)) {
        const list = sh.status === 'RECEIVED' ? asArray(item.receivedSerials) : asArray(item.deviceSerials);
        for (const s of list) {
          if (!keyOf(s.deviceSerial)) continue;
          put({
            deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
            productId: item.productId, productName: item.productName,
            branchId: sh.destination_branch_id, status: inTransit ? 'IN_TRANSIT' : 'IN_STOCK',
            sourceType: 'SHIPMENT', sourceId: sh.id, dateAD: isoDate(sh.dispatch_date_ad),
          });
        }
      }
    }

    // 3. Stock operations → DAMAGED or IN_STOCK
    const opRes = await client.query('SELECT id, type, branch_id, date_ad, items FROM stock_operations');
    for (const op of opRes.rows) {
      const damaged = op.type === 'DAMAGE' || op.type === 'DISPOSAL';
      for (const item of asArray(op.items)) {
        for (const s of asArray(item.deviceSerials)) {
          if (!keyOf(s.deviceSerial)) continue;
          put({
            deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
            productId: item.productId, productName: item.productName,
            branchId: op.branch_id, status: damaged ? 'DAMAGED' : 'IN_STOCK',
            sourceType: 'STOCK_OP', sourceId: op.id, dateAD: isoDate(op.date_ad),
          });
        }
      }
    }

    // 4. Serial-tracked fixed assets → POP_LOCATION_ASSIGNED
    const faRes = await client.query(
      `SELECT fa.id, fa.tag_number, fa.name, fa.branch_id, fa.product_id, fa.placed_in_service_date_ad, fa.acquisition_date_ad
       FROM fixed_assets fa LEFT JOIN products p ON p.id = fa.product_id
       WHERE fa.status = 'ACTIVE' AND (p.requires_serial_tracking = TRUE OR p.tracking_type IS DISTINCT FROM 'QUANTITY_ONLY' OR fa.product_id IS NULL)`
    );
    for (const fa of faRes.rows) {
      if (!keyOf(fa.tag_number)) continue;
      put({
        deviceSerial: String(fa.tag_number).trim(), ponSerial: String(fa.tag_number).trim(),
        productId: fa.product_id, productName: fa.name, branchId: fa.branch_id,
        status: 'POP_LOCATION_ASSIGNED', sourceType: 'FIXED_ASSET', sourceId: fa.id,
        dateAD: isoDate(fa.placed_in_service_date_ad || fa.acquisition_date_ad),
      }, true);
    }

    // 5. Customer devices → CUSTOMER_ASSIGNED (highest priority, wins over purchase/stock)
    const cdRes = await client.query(
      'SELECT id, customer_id, customer_name, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad FROM customer_device_records'
    );
    for (const d of cdRes.rows) {
      if (!keyOf(d.device_serial)) continue;
      let st = 'CUSTOMER_ASSIGNED';
      if (d.status === 'ROUTER_COLLECTED' || d.status === 'DISCONNECTED' || d.status === 'IN_STOCK') st = 'IN_STOCK';
      else if (d.status === 'DAMAGED' || d.status === 'DAMAGED_STOCK') st = 'DAMAGED';
      put({
        deviceSerial: String(d.device_serial).trim(), ponSerial: d.pon_serial, macAddress: d.mac_address,
        productName: d.product_name, branchId: d.branch_id,
        customerId: d.customer_id, customerName: d.customer_name,
        status: st, sourceType: 'CUSTOMER_ASSIGN', sourceId: d.id, dateAD: isoDate(d.issued_date_ad),
      }, true);
    }

    if (merged.size === 0) return;

    const existingRes = await client.query('SELECT id, device_serial, status, history_json FROM serial_log');
    const existing = new Map<string, any>();
    for (const r of existingRes.rows) existing.set(keyOf(r.device_serial), r);

    let inserted = 0, updated = 0;
    for (const [, c] of merged) {
      const k = keyOf(c.deviceSerial);
      const row = existing.get(k);
      const entry = { status: c.status, sourceType: c.sourceType, sourceId: c.sourceId || null, dateAD: c.dateAD, notes: 'Auto backfill' };
      if (!row) {
        const id = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await client.query(
          `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, customer_id, customer_name, status, source_type, source_id, history_json, created_at, updated_at, is_demo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,FALSE) ON CONFLICT DO NOTHING`,
          [id, c.deviceSerial, c.ponSerial || null, c.macAddress || null, c.productId || null, c.productName || null,
            c.branchId || null, c.customerId || null, c.customerName || null, c.status, c.sourceType, c.sourceId || null,
            JSON.stringify([entry]), `${c.dateAD}T00:00:00Z`, new Date().toISOString()]
        );
        inserted++;
      } else if ((row.status === 'IN_STOCK' || row.status === 'IN_TRANSIT') && row.status !== c.status) {
        // Upgrade transient states only — never downgrade manual/terminal states.
        let history: any[] = [];
        try { history = JSON.parse(row.history_json || '[]'); } catch { history = []; }
        history.push(entry);
        await client.query(
          `UPDATE serial_log SET status = $1, customer_id = COALESCE($2, customer_id), customer_name = COALESCE($3, customer_name),
            pon_serial = COALESCE($4, pon_serial), mac_address = COALESCE($5, mac_address),
            product_name = COALESCE($6, product_name), branch_id = COALESCE($7, branch_id),
            source_type = $8, source_id = COALESCE($9, source_id), history_json = $10, updated_at = NOW() WHERE id = $11`,
          [c.status, c.customerId || null, c.customerName || null, c.ponSerial || null, c.macAddress || null,
            c.productName || null, c.branchId || null, c.sourceType, c.sourceId || null, JSON.stringify(history), row.id]
        );
        updated++;
      }
    }

    // Refresh the in-memory register so the API serves converged rows immediately.
    const fresh = await client.query(
      'SELECT id, device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", product_id AS "productId", product_name AS "productName", branch_id AS "branchId", customer_id AS "customerId", customer_name AS "customerName", status, source_type AS "sourceType", source_id AS "sourceId", history_json AS "historyJson", created_at AS "createdAt", updated_at AS "updatedAt" FROM serial_log ORDER BY created_at DESC'
    );
    serialLogs = fresh.rows.map((r: any) => {
      let history: any[] = [];
      try { history = typeof r.historyJson === 'string' ? JSON.parse(r.historyJson || '[]') : (r.historyJson || []); } catch { history = []; }
      const { historyJson, ...rest } = r;
      return { ...rest, history };
    });
    if (inserted > 0 || updated > 0) {
      console.log(`✅ Serial-log backfill converged ${merged.size} unique serials (${inserted} inserted, ${updated} upgraded).`);
    }
  } catch (e: any) {
    console.warn('Serial-log backfill skipped:', e?.message || e);
  }
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

// Health & Control Plane Endpoints FIRST before any other routes or middleware
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global Backend Authentication Middleware for all API routes
app.use('/api', authenticateUser);

app.use('/api', (req, res, next) => {
  const publicRoutes = new Set([
    '/auth/setup-status',
    '/auth/setup-superadmin',
    '/auth/forgot-password',
    '/auth/login',
    '/db/status',
    '/health',
    '/sync/stream',
    '/sync/version',
  ]);
  if (publicRoutes.has(req.path)) return next();
  return requireAuth(req, res, next);
});
app.use('/api', requirePostgres);
app.use('/api', enforceFiscalYearWriteAccess);
app.use('/api', enforceOperationalPermissions);
app.use('/api', enforceBranchAccess);

// Cache-refresh hook: on ANY successful mutating API call, re-read every
// cache table from PostgreSQL (via CACHE_LOADS) BEFORE the response is sent.
// This replaces all hand-maintained mirror writes — the arrays can never
// drift from the database because they are re-derived from it after each
// write, and the caller's very next read already sees the committed state.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || !isPgConnected) return next();
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    if (res.statusCode >= 400) return originalJson(body);
    // Serialized through refreshChain so overlapping writes never run
    // concurrent fan-outs; failures are swallowed inside the refresh.
    const refreshStartedAt = Date.now();
    return refreshOperationalCache().then(() => {
      // Expose the refresh cost to clients/proxies (visible in DevTools and
      // consumed by scripts/smoke_test.mjs-style benchmarks).
      res.setHeader('Server-Timing', `cache-refresh;dur=${Date.now() - refreshStartedAt}`);
      return originalJson(body);
    });
  };
  next();
});

  return app;
}


function registerLeftoverFiscalRoutes(expressApp: express.Express) {
// ========== FISCAL-YEAR OPENING STOCK — REGISTER VIEW & MANUAL ADJUSTMENT ==========

// View the full opening-stock register for a fiscal year: every product × branch row
// (including zero-quantity rows) joined with product/branch names and the current live
// stock as a reference, plus summary stats.
expressApp.get(
  '/api/fiscal-years/:id/opening-stock',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const fyRes = await pgPool.query(
        `SELECT id, code,
                start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                is_current AS "isCurrent", is_closed AS "isClosed"
         FROM fiscal_years WHERE id = $1`,
        [id]
      );
      const fy = fyRes.rows[0];
      if (!fy) return res.status(404).json({ message: 'Fiscal year not found.' });

      const rowsRes = await pgPool.query(
        `SELECT 'opening-' || o.fiscal_year_id || '-' || o.product_id || '-' || o.branch_id AS id,
                o.product_id AS "productId",
                COALESCE(p.name, 'Deleted product') AS "productName",
                COALESCE(p.sku, '-') AS "productSku",
                o.branch_id AS "branchId",
                COALESCE(b.name, 'Deleted branch') AS "branchName",
                o.quantity_on_hand AS "quantityOnHand",
                o.damaged_qty AS "damagedQty",
                o.unit_cost::float AS "unitCost",
                o.source_type AS "sourceType",
                o.source_reference AS "sourceReference",
                o.posted_at::text AS "postedAt",
                o.posted_by AS "postedBy",
                COALESCE(s.quantity_on_hand, 0) AS "liveQty",
                COALESCE(s.damaged_qty, 0) AS "liveDamagedQty"
         FROM fiscal_year_opening_stock o
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN branches b ON b.id = o.branch_id
         LEFT JOIN inventory_stock s ON s.product_id = o.product_id AND s.branch_id = o.branch_id
         WHERE o.fiscal_year_id = $1
         ORDER BY p.name ASC, b.name ASC`,
        [id]
      );

      const rows = rowsRes.rows;
      const stats = {
        totalRows: rows.length,
        manualAdjustments: rows.filter((r: any) => r.sourceType === 'MANUAL_ADJUSTMENT').length,
        zeroQtyRows: rows.filter((r: any) => Number(r.quantityOnHand) === 0).length,
        totalUnits: rows.reduce((sum: number, r: any) => sum + Number(r.quantityOnHand), 0),
        totalValue: rows.reduce((sum: number, r: any) => sum + Number(r.quantityOnHand) * Number(r.unitCost), 0),
      };

      return res.json({ fiscalYear: fy, rows, stats });
    } catch (error: any) {
      console.error('Error fetching fiscal-year opening stock register:', error);
      return res.status(500).json({ message: `Unable to load fiscal-year opening stock: ${error.message}` });
    }
  }
);

// Manual opening-stock adjustment (batch). Allowed only while the fiscal year is OPEN —
// closed years are period-locked and require Super Admin reopen first. Existing rows are
// updated in place; missing product × branch combinations are created. Every touched row
// is re-stamped as MANUAL_ADJUSTMENT with the authorizing user, and an audit entry
// records old -> new values.
expressApp.put(
  '/api/fiscal-years/:id/opening-stock',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER'),
  async (req, res) => {
    const { id } = req.params;
    const user = getUserFromReq(req);
    const incoming: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];

    try {
      const fyRes = await pgPool.query('SELECT id, code, is_closed AS "isClosed" FROM fiscal_years WHERE id = $1', [id]);
      const fy = fyRes.rows[0];
      if (!fy) return res.status(404).json({ message: 'Fiscal year not found.' });
      if (fy.isClosed) {
        return res.status(403).json({
          message:
            'This fiscal year is closed and period-locked. Reopen it with Super Admin authorization before adjusting opening stock.',
        });
      }
      if (incoming.length === 0) {
        return res.status(400).json({ message: 'No opening-stock rows were provided to adjust.' });
      }

      const [prodRes, branchRes] = await Promise.all([
        pgPool.query('SELECT id, name FROM products'),
        pgPool.query('SELECT id, name FROM branches'),
      ]);
      const productNameById = new Map<string, string>(prodRes.rows.map((r: any) => [r.id, r.name]));
      const branchNameById = new Map<string, string>(branchRes.rows.map((r: any) => [r.id, r.name]));

      // ---- Validate every row BEFORE writing anything (all-or-nothing) ----
      const updates: Array<{
        productId: string;
        branchId: string;
        quantityOnHand: number;
        damagedQty: number;
        unitCost: number;
      }> = [];

      for (const item of incoming) {
        const productId = String(item?.productId || '').trim();
        const branchId = String(item?.branchId || '').trim();
        const quantityOnHand = Number(item?.quantityOnHand);
        const damagedQty = Number(item?.damagedQty ?? 0);
        const unitCost = Number(item?.unitCost ?? 0);
        const label = `${productNameById.get(productId) || productId || 'unknown product'} @ ${
          branchNameById.get(branchId) || branchId || 'unknown branch'
        }`;

        if (!productId || !productNameById.has(productId)) {
          return res.status(400).json({ message: `Invalid product reference in opening-stock adjustment: ${label}` });
        }
        if (!branchId || !branchNameById.has(branchId)) {
          return res.status(400).json({ message: `Invalid branch reference in opening-stock adjustment: ${label}` });
        }
        if (!Number.isInteger(quantityOnHand) || quantityOnHand < 0) {
          return res.status(400).json({ message: `Quantity on hand must be a whole number >= 0 for ${label}.` });
        }
        if (!Number.isInteger(damagedQty) || damagedQty < 0) {
          return res.status(400).json({ message: `Damaged quantity must be a whole number >= 0 for ${label}.` });
        }
        if (damagedQty > quantityOnHand) {
          return res.status(400).json({ message: `Damaged quantity cannot exceed quantity on hand for ${label}.` });
        }
        if (Number.isNaN(unitCost) || unitCost < 0) {
          return res.status(400).json({ message: `Unit cost must be a number >= 0 for ${label}.` });
        }

        updates.push({ productId, branchId, quantityOnHand, damagedQty, unitCost });
      }

      // ---- Apply inside one transaction; capture old values for the audit trail ----
      const result = await withTransaction(async (client) => {
        const changeLog: string[] = [];
        let createdCount = 0;

        for (const u of updates) {
          const beforeRes = await client.query(
            `SELECT quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", unit_cost::float AS "unitCost"
             FROM fiscal_year_opening_stock
             WHERE fiscal_year_id = $1 AND product_id = $2 AND branch_id = $3`,
            [id, u.productId, u.branchId]
          );
          const before = beforeRes.rows[0];

          const afterRes = await client.query(
            `INSERT INTO fiscal_year_opening_stock (
               id, fiscal_year_id, product_id, branch_id, quantity_on_hand, damaged_qty, unit_cost,
               source_type, source_reference, posted_at, posted_by
             )
             VALUES (
               'open-' || $1::text || '-' || $2 || '-' || $3,
               $1, $2, $3, $4, $5, $6,
               'MANUAL_ADJUSTMENT', 'MANUAL_ADJUSTMENT', CURRENT_TIMESTAMP, $7
             )
             ON CONFLICT (fiscal_year_id, product_id, branch_id) DO UPDATE SET
               quantity_on_hand = EXCLUDED.quantity_on_hand,
               damaged_qty = EXCLUDED.damaged_qty,
               unit_cost = EXCLUDED.unit_cost,
               source_type = 'MANUAL_ADJUSTMENT',
               source_reference = 'MANUAL_ADJUSTMENT',
               posted_at = CURRENT_TIMESTAMP,
               posted_by = EXCLUDED.posted_by
             RETURNING id`,
            [id, u.productId, u.branchId, u.quantityOnHand, u.damagedQty, u.unitCost, user.email || 'system']
          );

          if (!afterRes.rowCount) continue;
          if (!before) createdCount++;
          changeLog.push(
            `${before ? 'updated' : 'created'} ${productNameById.get(u.productId)} @ ${branchNameById.get(u.branchId)}: ` +
              `qty ${before ? before.quantityOnHand : '—'} -> ${u.quantityOnHand}, ` +
              `damaged ${before ? before.damagedQty : '—'} -> ${u.damagedQty}, ` +
              `cost NPR ${before ? before.unitCost : '—'} -> NPR ${u.unitCost}`
          );
        }

        return { appliedCount: changeLog.length, createdCount, changeLog };
      });

    if (result.appliedCount > 0) {
      const details =
        `Adjusted ${result.appliedCount} opening-stock row(s) for fiscal year ${fy.code}` +
        (result.createdCount ? ` (${result.createdCount} created)` : '') +
        ` [${result.changeLog.slice(0, 15).join('; ')}${result.changeLog.length > 15 ? ' …' : ''}] ` +
        `(by ${user.email || 'system'})`;
      logAuditEvent(req, 'ADJUST_FISCAL_OPENING_STOCK', 'FISCAL_YEAR', details);
    }

      return res.json({
        applied: result.appliedCount,
        created: result.createdCount,
        message: `${result.appliedCount} opening-stock row(s) saved for fiscal year ${fy.code}.`,
      });
    } catch (error: any) {
      console.error('Error adjusting fiscal-year opening stock:', error);
      return res.status(500).json({ message: `Unable to adjust fiscal-year opening stock: ${error.message}` });
    }
  }
);

// ========== FISCAL-YEAR VENDOR OPENING BALANCES (Vendor Ledger roll-forward) ==========

// View the vendor opening balance register for a fiscal year: every supplier ×
// branch row (including zero rows) with names, source, and audit fields.
expressApp.get(
  '/api/fiscal-years/:id/vendor-opening-balances',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const fyRes = await pgPool.query(
        `SELECT id, code,
                start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                is_current AS "isCurrent", is_closed AS "isClosed"
         FROM fiscal_years WHERE id = $1`,
        [id]
      );
      const fy = fyRes.rows[0];
      if (!fy) return res.status(404).json({ message: 'Fiscal year not found.' });

      const rowsRes = await pgPool.query(
        `SELECT 'vopen-' || o.fiscal_year_id || '-' || o.supplier_id || '-' || o.branch_id AS id,
                o.supplier_id AS "supplierId",
                COALESCE(s.name, 'Deleted supplier') AS "supplierName",
                COALESCE(s.supplier_code, '-') AS "supplierCode",
                o.branch_id AS "branchId",
                COALESCE(b.name, 'Deleted branch') AS "branchName",
                o.opening_balance::float AS "openingBalance",
                o.source_type AS "sourceType",
                o.source_reference AS "sourceReference",
                o.posted_at::text AS "postedAt",
                o.posted_by AS "postedBy"
         FROM vendor_opening_balances o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN branches b ON b.id = o.branch_id
         WHERE o.fiscal_year_id = $1
         ORDER BY s.name ASC, b.name ASC`,
        [id]
      );

      const rows = rowsRes.rows;
      const stats = {
        totalRows: rows.length,
        manualAdjustments: rows.filter((r: any) => r.sourceType === 'MANUAL_ADJUSTMENT').length,
        zeroRows: rows.filter((r: any) => Number(r.openingBalance) === 0).length,
        totalDebitOpening: rows.reduce(
          (sum: number, r: any) => sum + (Number(r.openingBalance) > 0 ? Number(r.openingBalance) : 0),
          0
        ),
        totalCreditOpening: rows.reduce(
          (sum: number, r: any) => sum + (Number(r.openingBalance) < 0 ? Math.abs(Number(r.openingBalance)) : 0),
          0
        ),
      };

      return res.json({ fiscalYear: fy, rows, stats });
    } catch (error: any) {
      console.error('Error fetching vendor opening balances register:', error);
      return res.status(500).json({ message: `Unable to load vendor opening balances: ${error.message}` });
    }
  }
);

// Manual vendor opening balance adjustment (batch). Allowed only while the fiscal
// year is OPEN — closed years are period-locked and require Super Admin reopen.
// Every touched row is re-stamped as MANUAL_ADJUSTMENT with the authorizing user.
expressApp.put(
  '/api/fiscal-years/:id/vendor-opening-balances',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'),
  async (req, res) => {
    const { id } = req.params;
    const user = getUserFromReq(req);
    const incoming: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];

    try {
      const fyRes = await pgPool.query('SELECT id, code, is_closed AS "isClosed" FROM fiscal_years WHERE id = $1', [id]);
      const fy = fyRes.rows[0];
      if (!fy) return res.status(404).json({ message: 'Fiscal year not found.' });
      if (fy.isClosed) {
        return res.status(403).json({
          message:
            'This fiscal year is closed and period-locked. Reopen it with Super Admin authorization before adjusting vendor opening balances.',
        });
      }
      if (incoming.length === 0) {
        return res.status(400).json({ message: 'No vendor opening-balance rows were provided to adjust.' });
      }

      const [supRes, branchRes] = await Promise.all([
        pgPool.query('SELECT id, name FROM suppliers'),
        pgPool.query('SELECT id, name FROM branches'),
      ]);
      const supplierNameById = new Map<string, string>(supRes.rows.map((r: any) => [r.id, r.name]));
      const branchNameById = new Map<string, string>(branchRes.rows.map((r: any) => [r.id, r.name]));

      // ---- Validate every row BEFORE writing anything (all-or-nothing) ----
      const updates: Array<{ supplierId: string; branchId: string; openingBalance: number }> = [];

      for (const item of incoming) {
        const supplierId = String(item?.supplierId || '').trim();
        const branchId = String(item?.branchId || '').trim();
        const openingBalance = Number(item?.openingBalance ?? 0);
        const label = `${supplierNameById.get(supplierId) || supplierId || 'unknown supplier'} @ ${
          branchNameById.get(branchId) || branchId || 'unknown branch'
        }`;

        if (!supplierId || !supplierNameById.has(supplierId)) {
          return res.status(400).json({ message: `Invalid supplier reference in vendor opening-balance adjustment: ${label}` });
        }
        if (!branchId || !branchNameById.has(branchId)) {
          return res.status(400).json({ message: `Invalid branch reference in vendor opening-balance adjustment: ${label}` });
        }
        if (Number.isNaN(openingBalance)) {
          return res.status(400).json({ message: `Opening balance must be a number for ${label}.` });
        }

        updates.push({ supplierId, branchId, openingBalance });
      }

      const result = await withTransaction(async (client) => {
        const changeLog: string[] = [];
        let createdCount = 0;

        for (const u of updates) {
          const beforeRes = await client.query(
            `SELECT opening_balance::float AS "openingBalance"
             FROM vendor_opening_balances
             WHERE fiscal_year_id = $1 AND supplier_id = $2 AND branch_id = $3`,
            [id, u.supplierId, u.branchId]
          );
          const before = beforeRes.rows[0];

          const afterRes = await client.query(
            `INSERT INTO vendor_opening_balances (
               id, fiscal_year_id, supplier_id, branch_id, opening_balance,
               source_type, source_reference, posted_at, posted_by
             )
             VALUES (
               'vopen-' || $1::text || '-' || $2 || '-' || $3,
               $1, $2, $3, $4,
               'MANUAL_ADJUSTMENT', 'MANUAL_ADJUSTMENT', CURRENT_TIMESTAMP, $5
             )
             ON CONFLICT (fiscal_year_id, supplier_id, branch_id) DO UPDATE SET
               opening_balance = EXCLUDED.opening_balance,
               source_type = 'MANUAL_ADJUSTMENT',
               source_reference = 'MANUAL_ADJUSTMENT',
               posted_at = CURRENT_TIMESTAMP,
               posted_by = EXCLUDED.posted_by
             RETURNING id`,
            [id, u.supplierId, u.branchId, u.openingBalance, user.email || 'system']
          );

          if (!afterRes.rowCount) continue;
          if (!before) createdCount++;
          const fmt = (v: number) => `NPR ${v.toLocaleString()}`;
          changeLog.push(
            `${before ? 'updated' : 'created'} ${supplierNameById.get(u.supplierId)} @ ${branchNameById.get(u.branchId)}: ` +
              `${before ? fmt(Number(before.openingBalance)) : '—'} -> ${fmt(u.openingBalance)}`
          );
        }

        return { appliedCount: changeLog.length, createdCount, changeLog };
      });

      if (result.appliedCount > 0) {
        const details =
          `Adjusted ${result.appliedCount} vendor opening-balance row(s) for fiscal year ${fy.code}` +
          (result.createdCount ? ` (${result.createdCount} created)` : '') +
          ` [${result.changeLog.slice(0, 15).join('; ')}${result.changeLog.length > 15 ? ' …' : ''}] ` +
          `(by ${user.email || 'system'})`;
        logAuditEvent(req, 'ADJUST_VENDOR_OPENING_BALANCE', 'FISCAL_YEAR', details);
      }

      return res.json({
        applied: result.appliedCount,
        created: result.createdCount,
        message: `${result.appliedCount} vendor opening-balance row(s) saved for fiscal year ${fy.code}.`,
      });
    } catch (error: any) {
      console.error('Error adjusting vendor opening balances:', error);
      return res.status(500).json({ message: `Unable to adjust vendor opening balances: ${error.message}` });
    }
  }
);

// Close the vendor ledger for a source fiscal year and roll each supplier × branch
// closing balance forward into the next fiscal year's opening balance. The closing
// balance is the net of all invoices (debits) minus posted payments (credits)
// dated within the source fiscal year, plus any persisted opening balance carried
// into that source year. Manual rows on the target year are preserved (not
// overwritten) — matching the opening-stock roll-forward policy.
expressApp.post(
  '/api/fiscal-years/:id/roll-forward-vendor-openings',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const result = await withTransaction(async (client) => {
        const sourceResult = await client.query(
          'SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD", is_closed AS "isClosed" FROM fiscal_years WHERE id = $1 FOR UPDATE;',
          [id]
        );
        const sourceFiscalYear = sourceResult.rows[0];
        if (!sourceFiscalYear) {
          const error: any = new Error('Source fiscal year not found.');
          error.statusCode = 404;
          throw error;
        }
        if (!sourceFiscalYear.isClosed) {
          const error: any = new Error('Close and lock the source fiscal year before rolling forward vendor opening balances.');
          error.statusCode = 400;
          throw error;
        }

        const targetResult = await client.query(
          `SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                  start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                  is_current AS "isCurrent", is_closed AS "isClosed"
           FROM fiscal_years WHERE start_date_ad > $1 ORDER BY start_date_ad ASC LIMIT 1 FOR UPDATE;`,
          [sourceFiscalYear.startDateAD]
        );
        const targetFiscalYear = targetResult.rows[0];
        if (!targetFiscalYear) {
          const error: any = new Error('Create the next fiscal year before rolling forward vendor opening balances.');
          error.statusCode = 400;
          throw error;
        }

        const existingRes = await client.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE source_type = 'MANUAL_ADJUSTMENT')::int AS manual
           FROM vendor_opening_balances WHERE fiscal_year_id = $1`,
          [targetFiscalYear.id]
        );
        const manualRowsPreserved = existingRes.rows[0]?.manual || 0;

        const inserted = await client.query(
          `INSERT INTO vendor_opening_balances (
             id, fiscal_year_id, supplier_id, branch_id, opening_balance, source_type, source_reference, posted_by
           )
           WITH ledger AS (
             SELECT
               COALESCE(inv.supplier_id, o.supplier_id) AS supplier_id,
               COALESCE(inv.branch_id, o.branch_id) AS branch_id,
               COALESCE(o.opening_balance, 0)
                 + COALESCE(SUM(inv.grand_total), 0)
                 - COALESCE(
                     (SELECT COALESCE(SUM(p.amount), 0) FROM vendor_payments p
                      WHERE p.supplier_id = COALESCE(inv.supplier_id, o.supplier_id)
                        AND p.branch_id = COALESCE(inv.branch_id, o.branch_id)
                        AND p.status = 'POSTED'
                        AND p.payment_date_ad >= $2::date
                        AND p.payment_date_ad <= $3::date),
                     0
                   ) AS closing_balance
             FROM (
               SELECT DISTINCT supplier_id, branch_id
               FROM (
                 SELECT supplier_id, branch_id FROM purchase_invoices
                 WHERE invoice_date_ad >= $2::date AND invoice_date_ad <= $3::date
                 UNION
                 SELECT supplier_id, branch_id FROM vendor_payments
                 WHERE payment_date_ad >= $2::date AND payment_date_ad <= $3::date
               ) t1
             ) drv
             LEFT JOIN purchase_invoices inv
               ON inv.supplier_id = drv.supplier_id
              AND inv.branch_id = drv.branch_id
              AND inv.invoice_date_ad >= $2::date
              AND inv.invoice_date_ad <= $3::date
             LEFT JOIN vendor_opening_balances o
               ON o.fiscal_year_id = $1
              AND o.supplier_id = drv.supplier_id
              AND o.branch_id = drv.branch_id
             GROUP BY inv.supplier_id, inv.branch_id, o.supplier_id, o.branch_id, o.opening_balance
           )
           SELECT
             'vopen-' || $4 || '-' || ledger.supplier_id || '-' || ledger.branch_id,
             $4,
             ledger.supplier_id,
             ledger.branch_id,
             ROUND(ledger.closing_balance, 2),
             'FISCAL_CLOSE',
             $5,
             $6
           FROM ledger
           WHERE ledger.supplier_id IS NOT NULL AND ledger.branch_id IS NOT NULL
           ON CONFLICT (fiscal_year_id, supplier_id, branch_id) DO UPDATE SET
             opening_balance = EXCLUDED.opening_balance,
             source_type = EXCLUDED.source_type,
             source_reference = EXCLUDED.source_reference,
             posted_at = CURRENT_TIMESTAMP,
             posted_by = EXCLUDED.posted_by
           WHERE vendor_opening_balances.source_type <> 'MANUAL_ADJUSTMENT'
           RETURNING id;`,
          [
            targetFiscalYear.id,
            sourceFiscalYear.startDateAD,
            sourceFiscalYear.endDateAD,
            targetFiscalYear.id,
            sourceFiscalYear.code,
            getUserFromReq(req).email || 'system',
          ]
        );

        return { targetFiscalYear, recordsCreated: inserted.rowCount || 0, manualRowsPreserved };
      });

      logAuditEvent(
        req,
        'ROLLFORWARD_VENDOR_OPENINGS',
        'FISCAL_YEAR',
        `Rolled forward ${result.recordsCreated} vendor opening-balance record(s) into ${result.targetFiscalYear.code}${
          result.manualRowsPreserved ? `; ${result.manualRowsPreserved} manual adjustment row(s) preserved` : ''
        }`
      );
      return res.json(result);
    } catch (error: any) {
      if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
      console.error('Error rolling forward vendor opening balances:', error);
      return res.status(500).json({ message: `Unable to roll forward vendor opening balances: ${error.message}` });
    }
  }
);
}

export function registerAllRoutes(expressApp: express.Express) {
  registerLeftoverFiscalRoutes(expressApp);
  registerSyncRoutes(expressApp);
  registerPermissionsRoutes(expressApp);
  registerBootstrapRoutes(expressApp);
  registerMiscRoutes(expressApp);
  registerAdminRoutes(expressApp);
  registerAuthRoutes(expressApp);
  registerMasterdataRoutes(expressApp);
  registerInventoryRoutes(expressApp);
  registerProcurementRoutes(expressApp);
  registerShipmentsRoutes(expressApp);
  registerReportsRoutes(expressApp);

  // Central structured-error handler must be registered LAST so every route's
  // thrown ApiError is converted to a standard JSON response.
  expressApp.use(errorHandler);
}