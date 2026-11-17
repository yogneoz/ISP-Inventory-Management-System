/**
 * Shared runtime state.
 *
 * PostgreSQL is the source of truth for every transaction. This module keeps
 * only small reference data in memory (branches, users, fiscal periods,
 * company profile, product catalogue, units, locations, suppliers, categories,
 * product groups and the bounded current stock projection). Customers,
 * invoices, returns, payments, audit/transaction logs, approvals, damage,
 * devices, assets, purchase orders, shipments and serial history are read from
 * PostgreSQL through bounded repository queries instead of being hydrated
 * wholesale at boot or after a write.
 *
 * The mutable values are declared `export let` IN THIS MODULE so ESM live
 * bindings work: app.ts re-exports them, and every consumer that historically
 * did `import { users } from '../app'` still observes updates.
 */
import { BOOTSTRAP_TABLES, buildCacheSelectSql } from '../models/columnMappings';
// A3: the setters below are the single choke point every master-data write goes
// through, so this is where "this cache was rewritten" is announced.
import { notifyReferenceCacheWrite } from './cacheWriteHook';
import {
  INITIAL_BILL_TERMS,
  INITIAL_COMPANY_PROFILE,
  INITIAL_DOCUMENT_NUMBER_CONFIGS,
} from '../config/seedData';
import type {
  User, Supplier, Branch, Product, CompanyProfile, InventoryStock, Asset,
  PurchaseOrder, PurchaseInvoice, Shipment, StockOperation, FiscalYear,
  AuditLog, TransactionLog, CustomerDeviceRecord, CustomerRecord,
  ApprovalRequest, Category, UnitOfMeasure, LocationRecord,
  DocumentNumberConfig, DamageRecord, SerialLog, VendorPayment,
  SalesInvoice, PurchaseReturn, SalesReturn, CustomerPayment, ProductGroup,
  WarrantyCoverageRecord, BillTerm, CostCenter, NarrationTemplate, Area, SalesAgent,
} from '../../../client/src/types';
import { INITIAL_PRODUCT_GROUPS } from '../config/seedData';
import type {
  UserPermissionOverrideMap,
  UserPermissionSetGrantMap,
} from '../models/permissions.repo';

// Reference state seeded from config/seedData.ts constants.
export let companyProfile: CompanyProfile = { ...INITIAL_COMPANY_PROFILE };
export let docNumberConfigs: DocumentNumberConfig[] = JSON.parse(JSON.stringify(INITIAL_DOCUMENT_NUMBER_CONFIGS));

export let users: readonly User[] = [];
export let suppliers: readonly Supplier[] = [];
export let uomList: readonly UnitOfMeasure[] = [];
export let locationRecords: readonly LocationRecord[] = [];
export let branches: readonly Branch[] = [];
export let fiscalYears: readonly FiscalYear[] = [];
export let products: readonly Product[] = [];
export let categories: readonly Category[] = [];
export let productGroups: readonly ProductGroup[] = INITIAL_PRODUCT_GROUPS.map((g) => ({ ...g }));
export let billTerms: readonly BillTerm[] = INITIAL_BILL_TERMS.map((t) => ({ ...t }));
export let costCenters: readonly CostCenter[] = [];
export let narrationTemplates: readonly NarrationTemplate[] = [];
export let areas: readonly Area[] = [];
export let salesAgents: readonly SalesAgent[] = [];
export let inventoryStock: readonly InventoryStock[] = [];

// Transactional mirrors retained only for PG-down demo mode and for the
// response of a write in this process. They are deliberately NOT hydrated
// from PostgreSQL and never drive a PG-connected read.
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
export let warrantyCoverages: readonly WarrantyCoverageRecord[] = [];

export let activeUser: User | null = null;
export let permissionMatrix: Record<string, Record<string, boolean>> = {};
export let userPermissionOverrides: UserPermissionOverrideMap = new Map();
export let userPermissionSetGrants: UserPermissionSetGrantMap = new Map();

let isPgConnected = false;
let dataVersion = Date.now();
/**
 * Version of the bootstrap payload's *content*, independent of dataVersion
 * (which SSE/sync keeps for its own invalidation contract). Every successful
 * non-GET bumps it once, so an ETag derived from it cannot claim "not
 * modified" after a write. This binding is the worker-local mirror; with Redis
 * configured `state/bootstrapVersion.ts` keeps it in step with the shared
 * counter, so a write on one worker invalidates the validator on all of them.
 */
let stateVersion = Date.now();

// Setters — the ONLY way other modules may change these bindings.
export function setCompanyProfile(value: CompanyProfile): void { companyProfile = value; notifyReferenceCacheWrite('companyProfile'); }
export function setDocNumberConfigs(value: DocumentNumberConfig[]): void { docNumberConfigs = value; }
export function setUsers(value: readonly User[]): void { users = value; notifyReferenceCacheWrite('users'); }
export function setSuppliers(value: readonly Supplier[]): void { suppliers = value; notifyReferenceCacheWrite('suppliers'); }
export function setUomList(value: readonly UnitOfMeasure[]): void { uomList = value; notifyReferenceCacheWrite('uom'); }
export function setLocationRecords(value: readonly LocationRecord[]): void { locationRecords = value; notifyReferenceCacheWrite('locations'); }
export function setBranches(value: readonly Branch[]): void { branches = value; notifyReferenceCacheWrite('branches'); }
export function setFiscalYears(value: readonly FiscalYear[]): void { fiscalYears = value; notifyReferenceCacheWrite('fiscalYears'); }
export function setProducts(value: readonly Product[]): void { products = value; notifyReferenceCacheWrite('products'); }
export function setCategories(value: readonly Category[]): void { categories = value; notifyReferenceCacheWrite('categories'); }
export function setProductGroups(value: readonly ProductGroup[]): void { productGroups = value; notifyReferenceCacheWrite('product_groups'); }
export function setBillTerms(value: readonly BillTerm[]): void { billTerms = value; }
export function setCostCenters(value: readonly CostCenter[]): void { costCenters = value; }
export function setNarrationTemplates(value: readonly NarrationTemplate[]): void { narrationTemplates = value; }
export function setAreas(value: readonly Area[]): void { areas = value; }
export function setSalesAgents(value: readonly SalesAgent[]): void { salesAgents = value; }
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
export function setWarrantyCoverages(value: readonly WarrantyCoverageRecord[]): void { warrantyCoverages = value; }
export function setPermissionMatrix(value: Record<string, Record<string, boolean>>): void { permissionMatrix = value; }
export function setUserPermissionOverrides(value: UserPermissionOverrideMap): void { userPermissionOverrides = value; }
export function setUserPermissionSetGrants(value: UserPermissionSetGrantMap): void { userPermissionSetGrants = value; }
export function setActiveUser(value: User): void { activeUser = value; }
export function setPgConnected(v: boolean): void { isPgConnected = v; }
export function getPgConnected(): boolean { return isPgConnected; }
export function getActiveUser(): User | null { return activeUser; }
export function getDataVersion(): number { return dataVersion; }
export function setDataVersion(v: number): void { dataVersion = v; }
export function getStateVersion(): number { return stateVersion; }
export function setStateVersion(v: number): void { stateVersion = v; }
export function bumpStateVersion(): void { stateVersion += 1; }

// ---------------------------------------------------------------------------
// Reference-only hydration.
//
// This is the complete set of tables loaded at boot. Everything else is a
// transaction read through a repository query at the point of use. The stock
// projection is bounded by product × branch and carries current quantity, not
// history; it is the one non-master table retained because the stock gates need
// a consistent current balance without a round-trip per line.
// ---------------------------------------------------------------------------
export const CACHE_LOADS: Array<{ name: string; query: string; apply: (rows: any[]) => void }> = [
  { name: 'branches', query: buildCacheSelectSql(BOOTSTRAP_TABLES.branches), apply: (rows) => { if (rows.length > 0) branches = rows as any; } },
  { name: 'users', query: buildCacheSelectSql(BOOTSTRAP_TABLES.users), apply: (rows) => { if (rows.length > 0) users = rows as any; } },
  { name: 'uom', query: buildCacheSelectSql(BOOTSTRAP_TABLES.uom), apply: (rows) => { if (rows.length > 0) uomList = rows as any; } },
  { name: 'locations', query: buildCacheSelectSql(BOOTSTRAP_TABLES.locations), apply: (rows) => { if (rows.length > 0) locationRecords = rows as any; } },
  { name: 'suppliers', query: buildCacheSelectSql(BOOTSTRAP_TABLES.suppliers), apply: (rows) => { if (rows.length > 0) suppliers = rows as any; } },
  { name: 'fiscalYears', query: buildCacheSelectSql(BOOTSTRAP_TABLES.fiscalYears), apply: (rows) => { if (rows.length > 0) fiscalYears = rows as any; } },
  { name: 'companyProfile', query: buildCacheSelectSql(BOOTSTRAP_TABLES.companyProfile), apply: (rows) => { if (rows.length > 0) companyProfile = rows[0]; } },
  { name: 'products', query: buildCacheSelectSql(BOOTSTRAP_TABLES.products), apply: (rows) => { products = rows as any; } },
  { name: 'categories', query: buildCacheSelectSql(BOOTSTRAP_TABLES.categories), apply: (rows) => { categories = rows as any; } },
  { name: 'product_groups', query: buildCacheSelectSql(BOOTSTRAP_TABLES.productGroups), apply: (rows) => { if (rows.length > 0) productGroups = rows as any; } },
  { name: 'inventory_stock', query: buildCacheSelectSql(BOOTSTRAP_TABLES.stock), apply: (rows) => { inventoryStock = rows as any; } },
];

/** Boot-time reference hydration. Transactions are never read here. */
export async function hydrateOperationalData(client: any) {
  for (const load of CACHE_LOADS) {
    try {
      const result = await client.query(load.query);
      load.apply(result.rows);
    } catch (e: any) {
      console.warn(`Reference cache hydration skipped for ${load.name}:`, e?.message || e);
    }
  }
  console.log(
    `✅ Reference caches hydrated from PostgreSQL: ` +
    `${branches.length} branches, ${users.length} users, ${products.length} products, ` +
    `${inventoryStock.length} stock rows. Transactional data is read on demand.`
  );
}
