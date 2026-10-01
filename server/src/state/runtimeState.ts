/**
 * Shared runtime state extracted from app.ts (backlog item #6 — app.ts
 * extraction). Owns every mutable runtime value the controllers read and
 * write, the serialized operational-cache refresh, and the CACHE_LOADS list.
 *
 * The mutable values are declared `export let` IN THIS MODULE so ESM live
 * bindings work: app.ts re-exports them, and every consumer that historically
 * did `import { users } from '../app'` still observes updates. Only this
 * module may ASSIGN the bindings; everyone else mutates through the exported
 * setters.
 */
import { pgPool } from '../../db';
import { BOOTSTRAP_TABLES, buildCacheSelectSql } from '../models/columnMappings';
import {
  INITIAL_COMPANY_PROFILE,
  INITIAL_DOCUMENT_NUMBER_CONFIGS,
} from '../config/seedData';
import type {
  User, Supplier, Branch, Product, CompanyProfile, InventoryStock, Asset,
  PurchaseOrder, PurchaseInvoice, Shipment, StockOperation, FiscalYear,
  AuditLog, TransactionLog, CustomerDeviceRecord, CustomerRecord,
  ApprovalRequest, Category, UnitOfMeasure, LocationRecord,
  DocumentNumberConfig, DamageRecord, SerialLog, VendorPayment,
  SalesInvoice, PurchaseReturn, SalesReturn, CustomerPayment,
} from '../../../client/src/types';

// ---------------------------------------------------------------------------
// Runtime state seeded from config/seedData.ts constants:
// ---------------------------------------------------------------------------
export let companyProfile: CompanyProfile = { ...INITIAL_COMPANY_PROFILE };
export let docNumberConfigs: DocumentNumberConfig[] = JSON.parse(JSON.stringify(INITIAL_DOCUMENT_NUMBER_CONFIGS));

// Operational arrays initialized empty by default (refreshed from PostgreSQL
// at boot and after every write; see refreshOperationalCache below).
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
export let salesInvoices: readonly SalesInvoice[] = [];
export let purchaseReturns: readonly PurchaseReturn[] = [];
export let salesReturns: readonly SalesReturn[] = [];
export let shipments: readonly Shipment[] = [];
export let stockOperations: readonly StockOperation[] = [];
export let auditTrail: readonly AuditLog[] = [];
export let transactionLogs: readonly TransactionLog[] = [];
export let vendorPayments: readonly VendorPayment[] = [];
export let customerPayments: readonly CustomerPayment[] = [];
export let approvalRequests: readonly ApprovalRequest[] = [];
export let damageRecords: readonly DamageRecord[] = [];
export let serialLogs: readonly SerialLog[] = [];

// Active user session mirror; authentication always reads PostgreSQL.
export let activeUser: User | null = null;

// In-memory permission matrix (populated at startup from PostgreSQL).
export let permissionMatrix: Record<string, Record<string, boolean>> = {};

let isPgConnected = false;
let dataVersion = Date.now();

// ---------------------------------------------------------------------------
// Setters — the ONLY way other modules may change these bindings.
// ---------------------------------------------------------------------------
export function setCompanyProfile(value: CompanyProfile): void { companyProfile = value; }
export function setDocNumberConfigs(value: DocumentNumberConfig[]): void { docNumberConfigs = value; }
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
export function setSalesInvoices(value: readonly SalesInvoice[]): void { salesInvoices = value; }
export function setPurchaseReturns(value: readonly PurchaseReturn[]): void { purchaseReturns = value; }
export function setSalesReturns(value: readonly SalesReturn[]): void { salesReturns = value; }
export function setShipments(value: readonly Shipment[]): void { shipments = value; }
export function setStockOperations(value: readonly StockOperation[]): void { stockOperations = value; }
export function setAuditTrail(value: readonly AuditLog[]): void { auditTrail = value; }
export function setTransactionLogs(value: readonly TransactionLog[]): void { transactionLogs = value; }
export function setVendorPayments(value: readonly VendorPayment[]): void { vendorPayments = value; }
export function setCustomerPayments(value: readonly CustomerPayment[]): void { customerPayments = value; }
export function setApprovalRequests(value: readonly ApprovalRequest[]): void { approvalRequests = value; }
export function setDamageRecords(value: readonly DamageRecord[]): void { damageRecords = value; }
export function setSerialLogs(value: readonly SerialLog[]): void { serialLogs = value; }
export function setPermissionMatrix(value: Record<string, Record<string, boolean>>): void { permissionMatrix = value; }
export function setActiveUser(value: User): void { activeUser = value; }
export function setPgConnected(v: boolean): void { isPgConnected = v; }
export function getPgConnected(): boolean { return isPgConnected; }
export function getActiveUser(): User | null { return activeUser; }
export function getDataVersion(): number { return dataVersion; }
export function setDataVersion(v: number): void { dataVersion = v; }

// ---------------------------------------------------------------------------
// Operational cache — PostgreSQL is the single source of truth.
// These arrays are NOT hand-maintained mirrors. They are declared `readonly`
// so the typechecker rejects any in-place mirror mutation: after every
// PostgreSQL write path commits, it calls `await refreshOperationalCache()`,
// which re-reads ALL cache tables straight from the database through the
// bootstrap repository's column mappings (one serialized fan-out). Reads
// served from these arrays therefore always reflect PostgreSQL, and an
// accidentally-missed refresh self-heals on the next write. Non-PG demo mode
// (isPgConnected === false) keeps the legacy in-memory behavior by REASSIGNING
// the arrays, never mutating them.
// ---------------------------------------------------------------------------

// The ONE list of operational cache loads — GENERATED from the per-table
// column mappings in models/columnMappings.ts (single source of truth,
// duplication audit phase 3). Every entry carrying a `cache` block there
// becomes a cache load here: at boot (hydrateOperationalData) and after every
// committed write (refreshOperationalCache). Adding a cached column or table
// means editing its entry in columnMappings.ts and nowhere else. The only
// per-entry code here is the `apply` callback wiring the rows into the
// runtime arrays (kept `if (rows.length > 0)` so demo-mode in-memory state
// is not clobbered by an empty table). Note the cache tables deliberately
// have NO branch/fiscal-year WHERE scoping — the cache is a full mirror.
export const CACHE_LOADS: Array<{ name: string; query: string; apply: (rows: any[]) => void }> = [
  { name: 'branches', query: buildCacheSelectSql(BOOTSTRAP_TABLES.branches), apply: (rows) => { if (rows.length > 0) branches = rows as any; } },
  // Password hashes ride along in the users cache: the login endpoint
  // authenticates from this array.
  { name: 'users', query: buildCacheSelectSql(BOOTSTRAP_TABLES.users), apply: (rows) => { if (rows.length > 0) users = rows as any; } },
  { name: 'uom', query: buildCacheSelectSql(BOOTSTRAP_TABLES.uom), apply: (rows) => { if (rows.length > 0) uomList = rows as any; } },
  { name: 'locations', query: buildCacheSelectSql(BOOTSTRAP_TABLES.locations), apply: (rows) => { if (rows.length > 0) locationRecords = rows as any; } },
  { name: 'suppliers', query: buildCacheSelectSql(BOOTSTRAP_TABLES.suppliers), apply: (rows) => { if (rows.length > 0) suppliers = rows as any; } },
  { name: 'fiscalYears', query: buildCacheSelectSql(BOOTSTRAP_TABLES.fiscalYears), apply: (rows) => { if (rows.length > 0) fiscalYears = rows as any; } },
  { name: 'companyProfile', query: buildCacheSelectSql(BOOTSTRAP_TABLES.companyProfile), apply: (rows) => { if (rows.length > 0) companyProfile = rows[0]; } },
  { name: 'products', query: buildCacheSelectSql(BOOTSTRAP_TABLES.products), apply: (rows) => { products = rows as any; } },
  { name: 'categories', query: buildCacheSelectSql(BOOTSTRAP_TABLES.categories), apply: (rows) => { categories = rows as any; } },
  { name: 'inventory_stock', query: buildCacheSelectSql(BOOTSTRAP_TABLES.stock), apply: (rows) => { inventoryStock = rows as any; } },
  { name: 'fixed_assets', query: buildCacheSelectSql(BOOTSTRAP_TABLES.assets), apply: (rows) => { assetRegister = rows as any; } },
  { name: 'purchase_orders', query: buildCacheSelectSql(BOOTSTRAP_TABLES.purchaseOrders), apply: (rows) => { purchaseOrders = rows as any; } },
  { name: 'purchase_invoices', query: buildCacheSelectSql(BOOTSTRAP_TABLES.purchaseInvoices), apply: (rows) => { purchaseInvoices = rows as any; } },
  { name: 'shipments', query: buildCacheSelectSql(BOOTSTRAP_TABLES.shipments), apply: (rows) => { shipments = rows as any; } },
  { name: 'sales_invoices', query: buildCacheSelectSql(BOOTSTRAP_TABLES.salesInvoices), apply: (rows) => { salesInvoices = rows as any; } },
  { name: 'purchase_returns', query: buildCacheSelectSql(BOOTSTRAP_TABLES.purchaseReturns), apply: (rows) => { purchaseReturns = rows as any; } },
  { name: 'sales_returns', query: buildCacheSelectSql(BOOTSTRAP_TABLES.salesReturns), apply: (rows) => { salesReturns = rows as any; } },
  { name: 'stock_operations', query: buildCacheSelectSql(BOOTSTRAP_TABLES.stockOperations), apply: (rows) => { stockOperations = rows as any; } },
  { name: 'audit_logs', query: buildCacheSelectSql(BOOTSTRAP_TABLES.auditLogs), apply: (rows) => { auditTrail = rows as any; } },
  { name: 'transaction_logs', query: buildCacheSelectSql(BOOTSTRAP_TABLES.transactionLogs), apply: (rows) => { transactionLogs = rows as any; } },
  // The old hand-written list was missing these two: their caches were never
  // hydrated at boot and only grew through runtime appends. Generated from
  // the mappings, they hydrate like every other table.
  { name: 'approval_requests', query: buildCacheSelectSql(BOOTSTRAP_TABLES.approvalRequests), apply: (rows) => { if (rows.length > 0) approvalRequests = rows as any; } },
  { name: 'damage_records', query: buildCacheSelectSql(BOOTSTRAP_TABLES.damageRecords), apply: (rows) => { if (rows.length > 0) damageRecords = rows as any; } },
  { name: 'customer_records', query: buildCacheSelectSql(BOOTSTRAP_TABLES.customers), apply: (rows) => { customerMasterRecords = rows as any; } },
  { name: 'customer_device_records', query: buildCacheSelectSql(BOOTSTRAP_TABLES.customerDevices), apply: (rows) => { customerDeviceRecords = rows as any; } },
  { name: 'vendor_payments', query: buildCacheSelectSql(BOOTSTRAP_TABLES.vendorPayments), apply: (rows) => { vendorPayments = rows as any; } },
  { name: 'customer_payments', query: buildCacheSelectSql(BOOTSTRAP_TABLES.customerPayments), apply: (rows) => { customerPayments = rows as any; } },
  {
    name: 'serial_log',
    query: buildCacheSelectSql(BOOTSTRAP_TABLES.serialLogs),
    apply: (rows) => {
      serialLogs = rows.map((r: any) => ({
        ...r,
        history: (() => { try { return typeof r.historyJson === 'string' ? JSON.parse(r.historyJson || '[]') : (r.historyJson || []); } catch { return []; } })(),
      }));
    },
  },
];

// Boot-time hydration runs the same CACHE_LOADS list on the startup client.
export async function hydrateOperationalData(client: any) {
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
    `${vendorPayments.length} vendor payments.`
  );
}

let refreshChain: Promise<void> = Promise.resolve();

export async function refreshOperationalCache(): Promise<void> {
  if (!getPgConnected()) return;
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
