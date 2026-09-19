export interface CompanyProfile {
  id?: string;
  name: string;
  legalName?: string;
  tagline?: string;
  address: string;
  city?: string;
  country?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  website?: string;
  panVatNumber?: string;
  registrationNumber?: string;
  logoUrl?: string;
  logoPreset?: string;
  /** Display symbol, e.g. 'Rs.', '$', '€', '₹', '£'. */
  currencySymbol?: string;
  /** ISO 4217 currency code, e.g. 'NPR', 'USD', 'EUR', 'INR'. */
  currencyCode?: string;
  /** BCP-47 locale used for grouping/decimals, e.g. 'en-IN', 'en-US', 'de-DE'. */
  currencyLocale?: string;
  /** Whether the symbol is placed before or after the number. */
  currencyPosition?: 'before' | 'after';
  /** Decimal places used for precise money display. */
  currencyDecimals?: number;
  defaultTaxRate?: number;
  notes?: string;
}

export type UserRole =
  | 'SUPER_ADMIN'
  | 'INVENTORY_MANAGER'
  | 'BRANCH_MANAGER'
  | 'FRONT_DESK'
  | 'ACCOUNTANT'
  | 'HEAD_OFFICE_ADMIN'
  | 'PROCUREMENT_OFFICER'
  | 'FIELD_TECHNICIAN'
  | 'AUDITOR';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password?: string;
  branchId?: string;
  allowedBranchIds?: string[];
  avatarUrl?: string;
  canSwitchUser?: boolean;
  // Session root marker (set only when this profile is an impersonated child
  // of another account via profile switching). Lets a switched session switch
  // back to the account that originally signed in.
  rootId?: string;
  rootEmail?: string;
  rootCanSwitchUser?: boolean;
  rootRole?: string;
}

export interface Supplier {
  id: string;
  supplierCode?: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  panVatNumber: string;
  rating: number;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  location: string;
  phone: string;
  isHeadquarters: boolean;
  active: boolean;
  allowProcurement?: boolean;
  allowWarehouseTransfer?: boolean;
  isWarehouse?: boolean;
}

export interface Product {
  id: string;
  sku: string;
  barcode: string;
  name: string;
  category: string;
  productGroup?: 'Product Item' | 'Fixed Asset' | 'Consumable Item';
  unit: 'Pcs' | 'Box' | 'Kg' | 'Set' | 'Mtr' | 'Roll' | 'Pair' | string;
  costPrice: number;
  sellingPrice: number;
  taxRate: number; // e.g., 13 for 13% VAT
  minReorderLevel: number;
  requiresSerialTracking?: boolean;
  trackingType?: 'SERIAL_MAC_PON' | 'QUANTITY_ONLY';
  description?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'DISCONTINUED';
  imageUrl?: string;

  // Depreciation Settings (for productGroup === 'Fixed Asset')
  depreciationMethod?: 'STRAIGHT_LINE' | 'DECLINING_BALANCE' | 'WRITTEN_DOWN_VALUE';
  depreciationRate?: number; // Annual percentage e.g. 15 for 15%
  usefulLifeYears?: number; // Useful life in years e.g. 5
  salvageValuePercent?: number; // Salvage value % e.g. 10
}

export interface Category {
  id: string;
  name: string;
  code: string;
  description?: string;
  isSpecialTracked?: boolean;
  productCount?: number;
}

export interface UnitOfMeasure {
  id: string;
  name: string;
  symbol: string;
  type: 'Count' | 'Length' | 'Weight' | 'Volume' | 'Package';
  isBaseUnit?: boolean;
}

export interface InventoryStock {
  id: string;
  productId: string;
  branchId: string;
  quantityOnHand: number;
  damagedQty?: number;
  reservedQty: number;
  incomingQty: number;
  lastUpdated: string;
  minReorderLevel?: number;
}

export type DamageReason = 'PHYSICAL_DAMAGE' | 'TRANSIT_DAMAGE' | 'STORAGE_DAMAGE' | 'EXPIRED' | 'RETURN_DAMAGE' | 'QUALITY_DEFECT' | 'OTHER';
export type DamageStatus = 'IDENTIFIED' | 'UNDER_REVIEW' | 'DISPOSED' | 'WRITTEN_OFF' | 'RETURNED_TO_SUPPLIER' | 'CANCELLED';
export type DisposalMethod = 'SCRAP_DESTRUCTION' | 'SALVAGE_E_WASTE' | 'VENDOR_RMA' | 'INSURANCE_CLAIM' | 'WRITE_OFF' | 'RETURN_TO_SUPPLIER' | 'AUCTION';

export interface DamageRecord {
  id: string;
  damageReference: string;
  productId: string;
  branchId: string;
  quantityDamaged: number;
  unitCost: number;
  totalCost: number;
  damageDateAD: string;
  damageDateBS: string;
  damageReason: DamageReason;
  status: DamageStatus;
  disposalDateAD?: string | null;
  disposalDateBS?: string | null;
  disposalMethod?: DisposalMethod | null;
  salvageValue?: number;
  glAccountCode?: string;
  writeOffLoss?: number;
  approvedBy?: string;
  notes?: string;
  fiscalYearId?: string;
  isDemo?: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type VendorPaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'ONLINE' | 'CARD' | 'OTHER';
export type VendorPaymentStatus = 'POSTED' | 'REVERSED' | 'VOIDED';

export interface VendorPayment {
  id: string;
  paymentNumber: string;
  supplierId: string;
  supplierName: string;
  branchId: string;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  paymentDateAD: string;
  paymentDateBS: string;
  amount: number;
  paymentMethod: VendorPaymentMethod;
  bankName?: string | null;
  bankBranch?: string | null;
  accountNumber?: string | null;
  chequeNumber?: string | null;
  chequeDateAD?: string | null;
  chequeDateBS?: string | null;
  transactionReference?: string | null;
  notes?: string | null;
  status: VendorPaymentStatus;
  reversalReason?: string | null;
  reversedBy?: string | null;
  reversedAtAD?: string | null;
  originalPaymentId?: string | null;
  fiscalYearId?: string;
  isDemo?: boolean;
  createdBy: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Asset {
  id: string;
  tagNumber: string;
  name: string;
  category: 'IT Equipment' | 'Furniture' | 'Machinery' | 'Vehicles' | 'Fixtures' | string;
  branchId: string;
  acquisitionDateAD: string;
  acquisitionDateBS: string;
  purchaseInvoiceDateAD?: string;
  purchaseInvoiceDateBS?: string;
  capitalizationDateAD?: string;
  placedInServiceDateAD?: string;
  acquisitionCost: number;
  depreciationMethod: 'STRAIGHT_LINE' | 'REDUCING_BALANCE' | 'DECLINING_BALANCE' | 'WRITTEN_DOWN_VALUE';
  depreciationRatePercent: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  status: 'ACTIVE' | 'MAINTENANCE' | 'DISPOSED' | 'IN_USE' | 'ASSIGNED_TO_CUSTOMER' | 'ASSIGNED_TO_LOCATION';
  disposalDateAD?: string;
  supplierName?: string;
  invoiceNo?: string;
  purchaseInvoiceId?: string;
  productId?: string;
  // Fixed Asset Assignment fields
  assignedType?: 'CUSTOMER' | 'LOCATION';
  assignedCustomerId?: string;
  assignedCustomerName?: string;
  assignedLocationId?: string;
  assignedLocationName?: string;
  assignmentDateAD?: string;
  assignmentDateBS?: string;
  assignmentNotes?: string;
}

export interface SerialLog {
  id: string;
  deviceSerial: string;
  ponSerial?: string;
  macAddress?: string;
  productId?: string;
  productName: string;
  branchId: string;
  branchName?: string;
  customerId?: string;
  customerName?: string;
  status: 'IN_STOCK' | 'IN_TRANSIT' | 'CUSTOMER_ASSIGNED' | 'POP_LOCATION_ASSIGNED' | 'DAMAGED' | 'RETURNED';
  sourceType: 'PURCHASE' | 'CUSTOMER_ASSIGN' | 'RETURN' | 'DAMAGE' | 'SHIPMENT' | 'STOCK_OP' | 'FIXED_ASSET' | 'SERIAL_CORRECTION' | 'STATUS_CHANGE';
  sourceId?: string;
  history: SerialLogEntry[];
  createdAt: string;
  updatedAt?: string;
  isDemo?: boolean;
}

export interface SerialLogEntry {
  status: string;
  sourceType: string;
  sourceId?: string;
  dateAD?: string;
  notes?: string;
}

export interface POLineItem {
  id: string;
  productId: string;
  productGroup?: Product['productGroup'];
  productName: string;
  sku: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  isTaxExempt?: boolean;
  taxRate: number;
  subtotal: number;
  taxAmount: number;
  total: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId?: string;
  supplierName: string;
  branchId: string;
  orderDateAD: string;
  orderDateBS: string;
  expectedDeliveryDateAD: string;
  status: 'DRAFT' | 'APPROVED' | 'SENT' | 'IN_PROGRESS' | 'PURCHASED' | 'RECEIVED' | 'CANCELLED';
  items: POLineItem[];
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
  notes?: string;
}

export interface DeviceSerialPair {
  deviceSerial: string;
  ponSerial?: string;
  macAddress?: string;
}

export interface PurchaseInvoiceItem {
  id: string;
  productId: string;
  productGroup?: Product['productGroup'];
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number; // Discount amount
  isTaxExempt: boolean;
  taxRate: number; // 13 or 0
  subtotal: number;
  taxAmount: number;
  total: number;
  deviceSerials?: DeviceSerialPair[];
}

export interface CustomerDeviceRecord {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  contactPhone: string;
  installationAddress: string;
  branchId: string;
  productName: string;
  deviceSerial: string;
  ponSerial: string;
  macAddress?: string;
  status: 'ACTIVE' | 'RENTAL' | 'DISCONNECTED' | 'ROUTER_COLLECTED' | 'IN_STOCK' | 'REFUND' | 'RETURNED' | 'EXCHANGED' | 'SOLD';
  issuedDateAD: string;
  issuedDateBS: string;
  disconnectedDateAD?: string;
  disconnectedDateBS?: string;
  warrantyMonths?: number;
  warrantyEndDateAD?: string;
  purchaseBillRef?: string;
  notes?: string;
}

export interface PurchaseInvoice {
  id: string;
  invoiceNumber: string;
  vendorBillNumber?: string;
  poReferenceId?: string;
  supplierId?: string;
  supplierName: string;
  branchId: string;
  invoiceDateAD: string;
  invoiceDateBS: string;
  dueDateAD: string;
  dueDateBS: string;
  paymentMethod?: 'CASH' | 'CREDIT' | 'BANK_TRANSFER' | 'CHEQUE';
  items?: PurchaseInvoiceItem[];
  subtotalAmount?: number;
  totalDiscount?: number;
  taxableAmount: number;
  vatAmount: number; // 13% VAT
  nonTaxableAmount: number;
  grandTotal: number;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID';
  amountPaid: number;
  notes?: string;
}

export interface ShipmentItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  quantitySent: number;
  costPrice?: number; // Returned by the API (products.cost_price join)
  quantityReceived?: number;
  deviceSerials?: { deviceSerial: string; ponSerial?: string }[];
  receivedSerials?: { deviceSerial: string; ponSerial?: string }[];
  itemDiscrepancyNotes?: string;
}

export interface Shipment {
  id: string;
  trackingCode: string;
  type: 'INTER_BRANCH' | 'SUPPLIER_INBOUND';
  sourceBranchId?: string;
  sourceBranchName?: string;
  destinationBranchId: string;
  destinationBranchName: string;
  dispatchDateAD: string;
  dispatchDateBS: string;
  estimatedArrivalAD: string;
  status: 'DISPATCHED' | 'IN_TRANSIT' | 'DELIVERED' | 'RECEIVED' | 'DISCREPANCY' | 'CANCELLED';
  items: ShipmentItem[];
  notes?: string;
  receivedDateAD?: string;
  receivedDateBS?: string;
  receivedByNotes?: string;
  hasDiscrepancy?: boolean;
}

export interface PulloutItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unit?: string;
  quantity: number;
  condition: 'OVERSTOCK' | 'DAMAGED_STOCK' | 'EXPIRED' | 'RECALLED';
  unitCost: number;
  totalValue: number;
  reason?: string;
  deviceSerials?: DeviceSerialPair[];
}

export interface SaleItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unit?: string;
  quantity: number;
  sellingPrice: number;
  discount: number;
  totalValue: number;
  deviceSerials?: DeviceSerialPair[];
  // Present on some stock-operation item payloads (e.g. pullout-style lines)
  condition?: PulloutItem['condition'];
  unitCost?: number;
}

export interface ConsumableIssueItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unit?: string;
  quantity: number;
  unitCost: number;
  totalValue: number;
  // Present on some stock-operation item payloads (e.g. serialized consumable lines)
  condition?: PulloutItem['condition'];
  deviceSerials?: DeviceSerialPair[];
}

export interface StockOperation {
  id: string;
  referenceNumber: string;
  type: 'PULLOUT' | 'DAMAGE' | 'DISPOSAL' | 'STOCK_OUT' | 'MANUAL_ADJUSTMENT' | 'CONSUMABLE_ISSUE';
  technicianName?: string;
  workOrderRef?: string;
  branchId: string;
  branchName?: string;
  destinationWarehouseId?: string;
  destinationWarehouseName?: string;
  productId?: string;
  productName?: string;
  quantityChanged?: number; // e.g. -5 or +10
  costPerUnit?: number;
  totalValue: number;
  reason: string;
  inspectorName: string;
  dateAD: string;
  dateBS: string;
  fiscalYear: string;
  status?: 'DISPATCHED' | 'RECEIVED' | 'LOGGED' | 'CANCELLED';
  items?: (PulloutItem | ConsumableIssueItem | SaleItem)[];
  // Customer Product Sale fields
  customerId?: string;
  customerName?: string;
  paymentMethod?: string;
  sellingUnitPrice?: number;
  // Disposal & Write-off fields
  disposalMethod?: 'SCRAP_DESTRUCTION' | 'SALVAGE_EWASTE' | 'VENDOR_RMA' | 'INSURANCE_CLAIM';
  salvageRecoveryAmount?: number;
  netWriteOffLoss?: number;
  glAccountCode?: string;
  // Damage record reversal (Super Admin & Inventory Manager only)
  reversalReason?: string;
  reversedBy?: string;
  reversedAtAD?: string;
  reversedAtBS?: string;
}

export interface DocumentNumberConfig {
  id: string; // e.g., 'PO', 'PI', 'INV', 'GRN', 'ST', 'SA', 'JV', 'DC'
  documentType: string;
  prefix: string;
  suffix: string;
  minDigits: number;
  startingNumber: number;
  nextNumber: number;
  resetEveryFiscalYear: boolean;
  notes?: string;
}

export interface FiscalYear {
  id: string;
  code: string; // e.g. "2080/81", "2081/82", "2082/83"
  startDateAD: string;
  endDateAD: string;
  startDateBS: string;
  endDateBS: string;
  isCurrent: boolean;
  isClosed: boolean;
  isDemo?: boolean;
}

export interface FiscalYearOpeningStockRow {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  branchId: string;
  branchName: string;
  quantityOnHand: number;
  damagedQty: number;
  unitCost: number;
  sourceType: string; // 'FISCAL_CLOSE' | 'MANUAL_ADJUSTMENT'
  sourceReference: string | null;
  postedAt: string | null;
  postedBy: string | null;
  /** Current live quantity in inventory_stock (reference only, not editable here). */
  liveQty: number;
  liveDamagedQty: number;
}

export interface FiscalYearOpeningStockResponse {
  fiscalYear: FiscalYear;
  rows: FiscalYearOpeningStockRow[];
  stats: {
    totalRows: number;
    manualAdjustments: number;
    zeroQtyRows: number;
    totalUnits: number;
    totalValue: number;
  };
}

/** Fiscal-year vendor opening balance (Vendor Ledger roll-forward). */
export interface VendorOpeningBalanceRow {
  id: string;
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  branchId: string;
  branchName: string;
  /** Signed: positive = payable (debit) owed to supplier, negative = advance/credit. */
  openingBalance: number;
  sourceType: string; // 'FISCAL_CLOSE' | 'MANUAL_ADJUSTMENT'
  sourceReference: string | null;
  postedAt: string | null;
  postedBy: string | null;
}

export interface VendorOpeningBalanceResponse {
  fiscalYear: FiscalYear;
  rows: VendorOpeningBalanceRow[];
  stats: {
    totalRows: number;
    manualAdjustments: number;
    zeroRows: number;
    totalDebitOpening: number;
    totalCreditOpening: number;
  };
}

export interface AuditLog {
  id: string;
  userEmail: string;
  userName: string;
  action: string;
  module: 'AUTH' | 'PRODUCTS' | 'STOCK' | 'ASSETS' | 'PURCHASE_ORDERS' | 'INVOICES' | 'SHIPMENTS' | 'OPERATIONS' | 'BRANCH_OPERATIONS' | 'FISCAL_YEAR' | 'INVENTORY_AUDIT' | 'APPROVAL_WORKFLOW';
  details: string;
  timestampAD: string;
  timestampBS: string;
  branchId?: string;
}

export interface TransactionLog {
  id: string;
  transactionNumber: string;
  productId: string;
  productSku: string;
  productName: string;
  branchId: string;
  changeType: 'INBOUND_PO' | 'SHIPMENT_TRANSFER' | 'TRANSFER_CANCELLED' | 'TRANSFER_RECEIPT_CANCELLED' | 'PULLOUT' | 'DAMAGE' | 'DAMAGE_REVERSED' | 'DISPOSAL' | 'STOCK_OUT' | 'MANUAL_ADJUSTMENT' | 'PURCHASE_INVOICE' | 'CONSUMABLE_ISSUE' | 'PHYSICAL_AUDIT_EXCESS' | 'PHYSICAL_AUDIT_SHORTAGE';
  quantityBefore: number;
  quantityChanged: number;
  quantityAfter: number;
  unitCost: number;
  referenceDocId?: string;
  timestampAD: string;
  timestampBS: string;
}

export interface FinancialSummary {
  totalInventoryAssetValue: number;
  totalFixedAssetValue: number;
  totalAccountsPayable: number;
  /** Net sales revenue from customer product sales (Branch Operations → Sell Product). */
  totalSalesRevenue?: number;
  totalCostOfGoodsSold: number;
  totalDamageLossValue: number;
  totalVatInputTax: number;
  currentFiscalYear: string;
  /** Set when the summary was requested for a specific fiscal year. */
  fiscalYearId?: string | null;
}

export interface LocationRecord {
  id: string;
  name: string;
  type: 'POP_SERVER_ROOM' | 'FIBER_NETWORK_NODE' | 'CUSTOMER_SITE' | 'WAREHOUSE' | 'BRANCH_OFFICE' | string;
  branchId: string;
  address: string;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  contactPerson?: string;
  contactPhone?: string;
  notes?: string;
  activeAssetsCount?: number;
}

export interface CustomerRecord {
  id: string;
  customerId: string;
  customerName: string;
  username: string;
  contactNumber: string;
  branchId: string;
  address: string;
  email?: string;
  status: 'ACTIVE' | 'INACTIVE';
  creditLimit?: number;
  assignedDevicesCount?: number;
}

export interface SystemState {
  currentUser: User | null;
  selectedBranchId: string; // 'ALL' or branch.id
  dateDisplayMode: 'BS' | 'AD';
}

export interface ApprovalRequest {
  id: string;
  requestNumber: string; // e.g. APR-2083-101
  type: 'CUSTOMER_DEVICE_STATUS' | 'CANCEL_TRANSFER' | 'CANCEL_IN_TRANSIT_TRANSFER' | 'STOCK_ADJUSTMENT' | 'STOCK_AUDIT_RECONCILIATION' | 'PURCHASE_OVERRIDE' | 'CANCEL_RECEIVE_TRANSFER' | string;
  targetId: string; // e.g. CustomerDeviceRecord.id, Shipment.id, or Audit Batch Ref
  customerName: string; // e.g. Customer Name, Transfer Tracking Code, or "Physical Stock Audit - WH001"
  customerCode?: string;
  deviceSerial: string; // e.g. Device Serial, Transfer Tracking Code, or Audit Ref No
  ponSerial?: string;
  productName: string; // e.g. Product Name, Transfer Items Summary, or Discrepancy Summary
  currentStatus: CustomerDeviceRecord['status'] | Shipment['status'] | string;
  requestedStatus: CustomerDeviceRecord['status'] | Shipment['status'] | string;
  requestedByRole: UserRole;
  requestedByEmail: string;
  requestedByName: string;
  branchId: string;
  branchName?: string;
  reason: string;
  restockQtyOnApproval?: boolean;
  shipmentData?: {
    shipmentId?: string;
    trackingCode: string;
    sourceBranchName?: string;
    destinationBranchName?: string;
    itemSummary?: string;
    totalQuantity?: number;
  };
  auditData?: {
    auditRefNumber: string;
    branchId: string;
    branchName: string;
    totalItems: number;
    discrepancyCount: number;
    shortageQty: number;
    excessQty: number;
    shortageValue: number;
    excessValue: number;
    netValueVariance: number;
    varianceItems: {
      productId: string;
      sku: string;
      productName: string;
      category: string;
      unit: string;
      unitCost: number;
      bookQty: number;
      countedQty: number;
      varianceQty: number;
      varianceValue: number;
      varianceReason: string;
    }[];
  };
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedAtAD: string;
  requestedAtBS: string;
  processedByEmail?: string;
  processedByName?: string;
  processedByRole?: UserRole;
  processedAtAD?: string;
  processedAtBS?: string;
  rejectionReason?: string;
}

export interface BootstrapState {
  branches: Branch[];
  products: Product[];
  stock: InventoryStock[];
  assets: Asset[];
  serialLogs: SerialLog[];
  customerDevices: CustomerDeviceRecord[];
  customers: CustomerRecord[];
  purchaseOrders: PurchaseOrder[];
  purchaseInvoices: PurchaseInvoice[];
  shipments: Shipment[];
  stockOperations: StockOperation[];
  fiscalYears: FiscalYear[];
  auditLogs: AuditLog[];
  transactionLogs: TransactionLog[];
  financialSummary: FinancialSummary;
  suppliers: Supplier[];
  users: Omit<User, 'password'>[];
  approvalRequests: ApprovalRequest[];
  categories?: Category[];
  uom?: UnitOfMeasure[];
  locations?: LocationRecord[];
  companyProfile?: CompanyProfile;
  damageRecords?: DamageRecord[];
  postgresDatabaseStatus?: {
    isConnected: boolean;
    host: string;
    port: number;
    database: string;
    user: string;
    engine?: string;
    errorDetails?: string;
  };
  serverTime: string;
  dataVersion: number;
  permissionsMatrix?: Record<string, Record<string, boolean>>;
}

