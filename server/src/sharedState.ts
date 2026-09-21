/**
 * Typed contract for the shared runtime state that lives in app.ts and is
 * mutated by controllers/routes across the server. Every accessor exported
 * by app.ts conforms to `SharedStateAccessors`, and app.ts declares its
 * accessor bundle with that type, so cross-module state writes are
 * typechecked instead of flowing through `any`.
 *
 * Domain element types come from the client's shared vocabulary
 * (client/src/types) — the single source of truth for the data model.
 */
import type {
  Asset,
  ApprovalRequest,
  AuditLog,
  Branch,
  Category,
  CompanyProfile,
  CustomerDeviceRecord,
  CustomerRecord,
  DamageRecord,
  DocumentNumberConfig,
  FiscalYear,
  InventoryStock,
  LocationRecord,
  Product,
  PurchaseInvoice,
  PurchaseOrder,
  SerialLog,
  Shipment,
  StockOperation,
  Supplier,
  TransactionLog,
  UnitOfMeasure,
  User,
  VendorPayment,
} from '../../client/src/types';

/**
 * vendor_opening_balances has no client-domain interface; the cache stores
 * the raw rows exactly as produced by the CACHE_LOADS query (column-aliased).
 */
export interface VendorOpeningBalanceRow {
  id: string;
  fiscalYearId: string;
  supplierId: string;
  branchId: string;
  openingBalance: number;
  sourceType: string | null;
  sourceReference: string | null;
  postedAt: string | null;
  postedBy: string | null;
  [key: string]: unknown;
}

export interface SharedStateAccessors {
  setUsers(value: readonly User[]): void;
  setSuppliers(value: readonly Supplier[]): void;
  setUomList(value: readonly UnitOfMeasure[]): void;
  setLocationRecords(value: readonly LocationRecord[]): void;
  setBranches(value: readonly Branch[]): void;
  setFiscalYears(value: readonly FiscalYear[]): void;
  setProducts(value: readonly Product[]): void;
  setCategories(value: readonly Category[]): void;
  setInventoryStock(value: readonly InventoryStock[]): void;
  setAssetRegister(value: readonly Asset[]): void;
  setCustomerDeviceRecords(value: readonly CustomerDeviceRecord[]): void;
  setCustomerMasterRecords(value: readonly CustomerRecord[]): void;
  setPurchaseOrders(value: readonly PurchaseOrder[]): void;
  setPurchaseInvoices(value: readonly PurchaseInvoice[]): void;
  setShipments(value: readonly Shipment[]): void;
  setStockOperations(value: readonly StockOperation[]): void;
  setAuditTrail(value: readonly AuditLog[]): void;
  setTransactionLogs(value: readonly TransactionLog[]): void;
  setApprovalRequests(value: readonly ApprovalRequest[]): void;
  setDamageRecords(value: readonly DamageRecord[]): void;
  setSerialLogs(value: readonly SerialLog[]): void;
  setVendorPayments(value: readonly VendorPayment[]): void;
  setVendorOpeningBalances(value: readonly VendorOpeningBalanceRow[]): void;
  setDocNumberConfigs(value: DocumentNumberConfig[]): void;
  setPermissionMatrix(value: Record<string, Record<string, boolean>>): void;
  setCompanyProfile(value: CompanyProfile): void;
  setActiveUser(value: User): void;
  getPgConnected(): boolean;
  setPgConnected(v: boolean): void;
  getActiveUser(): User | null;
  getDataVersion(): number;
  setDataVersion(v: number): void;
}
