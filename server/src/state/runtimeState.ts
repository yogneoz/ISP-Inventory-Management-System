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
export let shipments: readonly Shipment[] = [];
export let stockOperations: readonly StockOperation[] = [];
export let auditTrail: readonly AuditLog[] = [];
export let transactionLogs: readonly TransactionLog[] = [];
export let vendorPayments: readonly VendorPayment[] = [];
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
export function setShipments(value: readonly Shipment[]): void { shipments = value; }
export function setStockOperations(value: readonly StockOperation[]): void { stockOperations = value; }
export function setAuditTrail(value: readonly AuditLog[]): void { auditTrail = value; }
export function setTransactionLogs(value: readonly TransactionLog[]): void { transactionLogs = value; }
export function setVendorPayments(value: readonly VendorPayment[]): void { vendorPayments = value; }
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

// The ONE list of operational cache loads: every cache array below is read
// from PostgreSQL through exactly this list — at boot (hydrateOperationalData)
// and after every committed write (refreshOperationalCache). Adding a cached
// column or table means editing its entry here and nowhere else.
export const CACHE_LOADS: Array<{ name: string; query: string; apply: (rows: any[]) => void }> = [
  {
    name: 'branches',
    query: 'SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement", allow_warehouse_transfer AS "allowWarehouseTransfer" FROM branches ORDER BY code',
    apply: (rows) => { if (rows.length > 0) branches = rows as any; },
  },
  {
    // Password hashes ride along in the users cache: the login endpoint
    // authenticates from this array.
    name: 'users',
    query: 'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC',
    apply: (rows) => { if (rows.length > 0) users = rows as any; },
  },
  {
    name: 'uom',
    query: 'SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC',
    apply: (rows) => { if (rows.length > 0) uomList = rows as any; },
  },
  {
    name: 'locations',
    query: 'SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations ORDER BY name ASC',
    apply: (rows) => { if (rows.length > 0) locationRecords = rows as any; },
  },
  {
    name: 'suppliers',
    query: 'SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC',
    apply: (rows) => { if (rows.length > 0) suppliers = rows as any; },
  },
  {
    name: 'fiscal_years',
    query: 'SELECT id, code, start_date_ad AS "startDateAD", end_date_ad AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo" FROM fiscal_years ORDER BY start_date_ad DESC',
    apply: (rows) => { if (rows.length > 0) fiscalYears = rows as any; },
  },
  {
    name: 'company_profile',
    query: 'SELECT id, name, legal_name AS "legalName", tagline, address, city, country, postal_code AS "postalCode", phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", currency_code AS "currencyCode", currency_locale AS "currencyLocale", currency_position AS "currencyPosition", currency_decimals AS "currencyDecimals", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1',
    apply: (rows) => { if (rows.length > 0) companyProfile = rows[0]; },
  },
  {
    name: 'products',
    query: 'SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products',
    apply: (rows) => { products = rows as any; },
  },
  {
    name: 'categories',
    query: 'SELECT id, name, code, description, is_special_tracked AS "isSpecialTracked" FROM categories ORDER BY name ASC',
    apply: (rows) => { categories = rows as any; },
  },
  {
    name: 'inventory_stock',
    query: 'SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock',
    apply: (rows) => { inventoryStock = rows as any; },
  },
  {
    name: 'fixed_assets',
    query: 'SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo", purchase_invoice_id AS "purchaseInvoiceId", product_id AS "productId" FROM fixed_assets',
    apply: (rows) => { assetRegister = rows as any; },
  },
  {
    name: 'purchase_orders',
    query: 'SELECT id, po_number AS "poNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS", expected_delivery_date_ad AS "expectedDeliveryDateAD", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders',
    apply: (rows) => { purchaseOrders = rows as any; },
  },
  {
    name: 'purchase_invoices',
    query: 'SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", amount_paid AS "amountPaid", items FROM purchase_invoices',
    apply: (rows) => { purchaseInvoices = rows as any; },
  },
  {
    name: 'shipments',
    query: 'SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS", estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAD", received_date_bs AS "receivedDateBS", has_discrepancy AS "hasDiscrepancy" FROM shipments',
    apply: (rows) => { shipments = rows as any; },
  },
  {
    name: 'stock_operations',
    query: 'SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAD", date_bs AS "dateBS", fiscal_year AS "fiscalYear", status, items FROM stock_operations',
    apply: (rows) => { stockOperations = rows as any; },
  },
  {
    name: 'audit_logs',
    query: 'SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs ORDER BY timestamp_ad DESC',
    apply: (rows) => { auditTrail = rows as any; },
  },
  {
    name: 'transaction_logs',
    query: 'SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs ORDER BY timestamp_ad DESC',
    apply: (rows) => { transactionLogs = rows as any; },
  },
  {
    name: 'customer_records',
    query: 'SELECT id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount" FROM customer_records',
    apply: (rows) => { customerMasterRecords = rows as any; },
  },
  {
    name: 'customer_device_records',
    query: 'SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAD", issued_date_bs AS "issuedDateBS", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records',
    apply: (rows) => { customerDeviceRecords = rows as any; },
  },
  {
    name: 'vendor_payments',
    query: 'SELECT id, payment_number AS "paymentNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_id AS "invoiceId", invoice_number AS "invoiceNumber", payment_date_ad AS "paymentDateAD", payment_date_bs AS "paymentDateBS", amount, payment_method AS "paymentMethod", bank_name AS "bankName", bank_branch AS "bankBranch", account_number AS "accountNumber", cheque_number AS "chequeNumber", cheque_date_ad AS "chequeDateAD", cheque_date_bs AS "chequeDateBS", transaction_reference AS "transactionReference", notes, status, reversal_reason AS "reversalReason", reversed_by AS "reversedBy", reversed_at_ad AS "reversedAtAD", original_payment_id AS "originalPaymentId", fiscal_year_id AS "fiscalYearId", is_demo AS "isDemo", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt" FROM vendor_payments ORDER BY payment_date_ad DESC, created_at DESC',
    apply: (rows) => { vendorPayments = rows as any; },
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
