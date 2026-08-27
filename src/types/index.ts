export interface CompanyProfile {
  id?: string;
  name: string;
  legalName?: string;
  tagline?: string;
  address: string;
  city?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
  panVatNumber?: string;
  registrationNumber?: string;
  logoUrl?: string;
  logoPreset?: string;
  currencySymbol?: string;
  defaultTaxRate?: number;
  notes?: string;
}

export type UserRole =
  | 'SUPER_ADMIN'
  | 'INVENTORY_MANAGER'
  | 'BRANCH_MANAGER'
  | 'FRONT_DESK'
  | 'ACCOUNTANT';

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

export interface Asset {
  id: string;
  tagNumber: string;
  name: string;
  category: 'IT Equipment' | 'Furniture' | 'Machinery' | 'Vehicles' | 'Fixtures' | string;
  branchId: string;
  acquisitionDateAD: string;
  acquisitionDateBS: string;
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

export interface POLineItem {
  id: string;
  productId: string;
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
  status?: 'DISPATCHED' | 'RECEIVED' | 'LOGGED';
  items?: PulloutItem[];
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
  changeType: 'INBOUND_PO' | 'SHIPMENT_TRANSFER' | 'TRANSFER_CANCELLED' | 'TRANSFER_RECEIPT_CANCELLED' | 'PULLOUT' | 'DAMAGE' | 'DISPOSAL' | 'STOCK_OUT' | 'MANUAL_ADJUSTMENT' | 'PURCHASE_INVOICE' | 'CONSUMABLE_ISSUE' | 'PHYSICAL_AUDIT_EXCESS' | 'PHYSICAL_AUDIT_SHORTAGE';
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
  totalCostOfGoodsSold: number;
  totalDamageLossValue: number;
  totalVatInputTax: number;
  currentFiscalYear: string;
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
  customerName: string; // e.g. Customer Name, Transfer Tracking Code, or "Physical Stock Audit - Kathmandu"
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
}

