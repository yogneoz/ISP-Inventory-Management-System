/**
 * In-memory application state + JSON persistence.
 */
import fs from 'fs';
import path from 'path';
import type {
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
} from '../src/types';

import { hashPassword, isBcryptHash, normalizeRole } from './lib/authUtils';

export let users: User[] = [];
export let suppliers: Supplier[] = [];
export let uomList: UnitOfMeasure[] = [];
export let locationRecords: LocationRecord[] = [];
export let branches: Branch[] = [];
export let fiscalYears: FiscalYear[] = [];

export const INITIAL_COMPANY_PROFILE: CompanyProfile = {
  id: 'COMP-001',
  name: 'IZONE DIGITAL NETWORK PVT. LTD.',
  legalName: 'iZone Digital Network Private Limited',
  tagline: 'High Speed Fiber & Enterprise Communication System',
  address: 'Urlabari-07, Morang, Koshi Province, Nepal',
  city: 'Urlabari',
  country: 'Nepal',
  phone: '+977-021-540123 / 9800000000',
  email: 'info@izone.com.np',
  website: 'https://izone.com.np',
  panVatNumber: '609823412',
  registrationNumber: 'REG-2075-88412',
  logoUrl: '',
  logoPreset: 'telecom',
  currencySymbol: 'Rs.',
  defaultTaxRate: 13,
  notes: 'Head Office & Central Procurement Warehouse System',
};

export let companyProfile: CompanyProfile = { ...INITIAL_COMPANY_PROFILE };

// Master Initial Seed Specifications for PostgreSQL database initialization
export const INITIAL_MASTER_UOM: UnitOfMeasure[] = [
  { id: 'uom-1', name: 'Pieces', symbol: 'Pcs', type: 'Count', isBaseUnit: true },
  { id: 'uom-2', name: 'Meters', symbol: 'Mtr', type: 'Length', isBaseUnit: true },
  { id: 'uom-3', name: 'Rolls', symbol: 'Roll', type: 'Package', isBaseUnit: false },
  { id: 'uom-4', name: 'Boxes', symbol: 'Box', type: 'Package', isBaseUnit: false },
  { id: 'uom-5', name: 'Sets', symbol: 'Set', type: 'Count', isBaseUnit: true },
];

export const INITIAL_MASTER_LOCATIONS: LocationRecord[] = [
  {
    id: 'LOC-1001',
    name: 'Main Server Room - HQ',
    type: 'POP_SERVER_ROOM',
    branchId: 'WH001',
    address: 'Urlabari Central Station',
    coordinates: { latitude: 26.6664, longitude: 87.625 },
    contactPerson: 'Shrestha Admin',
    contactPhone: '9800000000',
    notes: 'Primary POP hub for Urlabari Region',
    activeAssetsCount: 12,
  },
];

export const INITIAL_MASTER_BRANCHES: Branch[] = [
  { id: 'WH001', code: 'WH001', name: 'Head Office', location: 'Urlabari', phone: '9800000000', isHeadquarters: true, active: true },
  { id: 'BRC01', code: 'BRC01', name: 'Biratchowk', location: 'Biratchowk', phone: '9800000001', isHeadquarters: false, active: true },
  { id: 'BTM01', code: 'BTM01', name: 'Birtamode', location: 'Birtamode', phone: '9800000002', isHeadquarters: false, active: true },
  { id: 'CHU01', code: 'CHU01', name: 'Chulachuli', location: 'Chulachuli', phone: '9800000003', isHeadquarters: false, active: true },
  { id: 'DHU01', code: 'DHU01', name: 'Dudhe', location: 'Dudhe', phone: '9800000004', isHeadquarters: false, active: true },
  { id: 'INR01', code: 'INR01', name: 'Inaruwa', location: 'Inaruwa', phone: '9800000005', isHeadquarters: false, active: true },
  { id: 'ITH01', code: 'ITH01', name: 'Itahari', location: 'Itahari', phone: '9800000006', isHeadquarters: false, active: true },
  { id: 'JTR01', code: 'JTR01', name: 'Jitpur', location: 'Jitpur', phone: '9800000007', isHeadquarters: false, active: true },
  { id: 'HLE01', code: 'HLE01', name: 'Hile', location: 'Hile', phone: '9800000008', isHeadquarters: false, active: true },
  { id: 'LTG01', code: 'LTG01', name: 'Letang', location: 'Letang', phone: '9800000009', isHeadquarters: false, active: true },
  { id: 'MDL01', code: 'MDL01', name: 'Madhumalla', location: 'Madhumalla', phone: '9800000010', isHeadquarters: false, active: true },
  { id: 'PTH01', code: 'PTH01', name: 'Pathari', location: 'Pathari', phone: '9800000011', isHeadquarters: false, active: true },
  { id: 'PDM01', code: 'PDM01', name: 'Phidim', location: 'Phidim', phone: '9800000012', isHeadquarters: false, active: true },
  { id: 'RJB01', code: 'RJB01', name: 'Rajbiraj', location: 'Rajbiraj', phone: '9800000013', isHeadquarters: false, active: true },
  { id: 'RML01', code: 'RML01', name: 'Ramailo', location: 'Ramailo', phone: '9800000014', isHeadquarters: false, active: true },
  { id: 'RTW01', code: 'RTW01', name: 'Ratuwamai', location: 'Ratuwamai', phone: '9800000015', isHeadquarters: false, active: true },
  { id: 'SHV01', code: 'SHV01', name: 'Shivasatakshi', location: 'Shivasatakshi', phone: '9800000016', isHeadquarters: false, active: true },
  { id: 'TND01', code: 'TND01', name: 'Tandi', location: 'Tandi', phone: '9800000017', isHeadquarters: false, active: true },
  { id: 'URL01', code: 'URL01', name: 'Urlabari', location: 'Urlabari', phone: '9800000018', isHeadquarters: false, active: true },
];

export const INITIAL_MASTER_FISCAL_YEARS: FiscalYear[] = [
  { id: 'fy-1', code: '2080-81', startDateAD: '2023-07-17', endDateAD: '2024-07-15', startDateBS: '2080-04-01 BS', endDateBS: '2080-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-2', code: '2081-82', startDateAD: '2024-07-16', endDateAD: '2025-07-15', startDateBS: '2081-04-01 BS', endDateBS: '2081-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-3', code: '2082-83', startDateAD: '2025-07-16', endDateAD: '2026-07-15', startDateBS: '2082-04-01 BS', endDateBS: '2082-12-31 BS', isCurrent: true, isClosed: false },
  { id: 'fy-4', code: '2083-84', startDateAD: '2026-07-16', endDateAD: '2027-07-15', startDateBS: '2083-04-01 BS', endDateBS: '2083-12-31 BS', isCurrent: false, isClosed: false },
];

// Operational arrays initialized empty by default
export let products: Product[] = [];
export let categories: Category[] = [];
export let inventoryStock: InventoryStock[] = [];
export let assetRegister: Asset[] = [];
export let customerDeviceRecords: CustomerDeviceRecord[] = [];
export let customerMasterRecords: CustomerRecord[] = [];
export let purchaseOrders: PurchaseOrder[] = [];
export let purchaseInvoices: PurchaseInvoice[] = [];
export let shipments: Shipment[] = [];
export let stockOperations: StockOperation[] = [];
export let auditTrail: AuditLog[] = [];
export let transactionLogs: TransactionLog[] = [];
export let approvalRequests: ApprovalRequest[] = [];
export let isDemoDataCleared = false;

// Standard Transaction ID Generator
// Pattern: {BRANCH_CODE}-{OP_TYPE}-{YYYYMMDD}-{0001}
// Daily counter resets automatically at 12:00 AM (midnight) per branch & operation type
export const transactionSequenceMap: Record<string, { lastDateStr: string; count: number }> = {};

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

// Optional Helper to generate sample demo dataset when explicitly requested (e.g., SEED_DUMMY_DATA=true)
export function generateDemoDataset() {
  const EXCEL_ITEMS = [
    { code: 'SPL001', group: 'CONSUMABLE ITEM', type: 'Splitter', name: 'PLC Fiber Optic Splitter 1x8 SC/APC', uom: 'Pcs', qty: 50, val: 450 },
    { code: 'SPL002', group: 'CONSUMABLE ITEM', type: 'Splitter', name: 'PLC Fiber Optic Splitter 1x16 SC/APC', uom: 'Pcs', qty: 30, val: 850 },
    { code: 'SLV001', group: 'CONSUMABLE ITEM', type: 'Sleeves', name: 'Fiber Fusion Protection Sleeve 60mm (Pack of 100)', uom: 'Box', qty: 100, val: 250 },
    { code: 'CPL001', group: 'CONSUMABLE ITEM', type: 'Coupler', name: 'Fiber Optic Coupler SC/APC Simplex Adapter', uom: 'Pcs', qty: 200, val: 35 },
    { code: 'FCN001', group: 'CONSUMABLE ITEM', type: 'Fast Connector', name: 'Fast Connector SC/UPC Fiber Optical', uom: 'Pcs', qty: 150, val: 45 },
    { code: 'PTC001', group: 'CONSUMABLE ITEM', type: 'Patch Cord', name: 'Fiber Patch Cord SC/APC-SC/APC 3M Simplex', uom: 'Pcs', qty: 80, val: 180 },
    { code: 'ADP001', group: 'CONSUMABLE ITEM', type: 'Adaptor', name: '0 DB ADAPTAR SC/APC', uom: 'Pcs', qty: 100, val: 25 },
    { code: 'DRP002', group: 'CONSUMABLE ITEM', type: 'Drop Cable', name: 'DROP CABLE 100 MTR ROLL', uom: 'Roll', qty: 20, val: 2500 },
    { code: 'FIB003', group: 'CONSUMABLE ITEM', type: 'Fiber', name: '4 CORE OPTICAL FIBER CABLE', uom: 'Mtr', qty: 500, val: 45 },
    { code: 'CAR004', group: 'FIXED ASSET', type: 'Olt Card', name: 'OLT CARD GPON 16-PORT Chassis Module', uom: 'Pcs', qty: 2, val: 125000 },
    { code: 'ONU001', group: 'PRODUCT ITEM', type: 'Onu Router', name: 'ONU ROUTER DUAL BAND 2.4G/5G GPON', uom: 'Pcs', qty: 25, val: 3200 },
    { code: 'ONU002', group: 'PRODUCT ITEM', type: 'Onu Router', name: 'ONU ROUTER SINGLE BAND 2.4G XPON', uom: 'Pcs', qty: 40, val: 1850 },
  ];

  const NON_SERIALIZED_CATEGORIES = [
    'Drop Cable', 'Cat6 Cable', 'Fiber', 'Dac Cable', 'Patch Cord',
    'Fast Connector', 'Coupler', 'Splitter', 'Distribution Box',
    'Av Jack', 'Binding Wire', 'Adaptor', 'Sleeves', 'Tiffin Bod', 'Cassettte'
  ];

  const demoSuppliers: Supplier[] = [
    {
      id: 'sup-1',
      name: 'Himalayan Tech Distributors Pvt. Ltd.',
      contactPerson: 'Ramesh Adhikari',
      phone: '+977-1-4265890',
      email: 'orders@himalayantech.com.np',
      address: 'Putalisadak, Kathmandu',
      panVatNumber: '302918273',
      rating: 4.8,
    },
    {
      id: 'sup-2',
      name: 'Nepal Optical & Fiber Optics Importers',
      contactPerson: 'Sunita Sharma',
      phone: '+977-1-5541209',
      email: 'sales@nepaloptics.com.np',
      address: 'Patan Industrial Estate, Lalitpur',
      panVatNumber: '601239845',
      rating: 4.6,
    },
    {
      id: 'sup-3',
      name: 'Apex Networking Hardware Traders',
      contactPerson: 'Binod Shrestha',
      phone: '+977-1-4432100',
      email: 'info@apexnet.com.np',
      address: 'New Road, Kathmandu',
      panVatNumber: '300129841',
      rating: 4.9,
    },
  ];

  const demoProducts: Product[] = EXCEL_ITEMS.map((item, idx) => {
    const isConsumableOrCable =
      item.group === 'CONSUMABLE ITEM' ||
      NON_SERIALIZED_CATEGORIES.includes(item.type) ||
      ['Mtr', 'Roll', 'Box'].includes(item.uom) ||
      item.name.includes('CABLE') ||
      item.name.includes('WIRE') ||
      item.name.includes('CONNECTOR') ||
      item.name.includes('SPLITTER') ||
      item.name.includes('SLEEVE') ||
      item.name.includes('COUPLER') ||
      item.name.includes('ADAPTAR');

    const requiresSerialTracking = !isConsumableOrCable && item.group !== 'CONSUMABLE ITEM';

    let productGroup: 'Product Item' | 'Fixed Asset' | 'Consumable Item' = 'Product Item';
    if (item.group === 'FIXED ASSET') {
      productGroup = 'Fixed Asset';
    } else if (isConsumableOrCable) {
      productGroup = 'Consumable Item';
    }

    return {
      id: `prod-${item.code.toLowerCase()}`,
      sku: item.code,
      barcode: `890${String(100000000 + idx).slice(1)}`,
      name: item.name,
      category: item.type,
      productGroup,
      unit: item.uom,
      costPrice: item.val > 0 ? item.val : 1500,
      sellingPrice: item.val > 0 ? Math.round(item.val * 1.25) : 1875,
      taxRate: 13,
      minReorderLevel: productGroup === 'Consumable Item' ? 20 : (productGroup === 'Fixed Asset' ? 0 : 5),
      requiresSerialTracking,
      trackingType: requiresSerialTracking ? 'SERIAL_MAC_PON' : 'QUANTITY_ONLY',
      description: `[${productGroup}] ${item.type} - ${item.name}`,
      ...(productGroup === 'Fixed Asset'
        ? {
            depreciationMethod: 'STRAIGHT_LINE' as const,
            depreciationRate: 15,
            usefulLifeYears: 5,
            salvageValuePercent: 10,
          }
        : {}),
    };
  });

  const demoInventoryStock: InventoryStock[] = [];
  let seededDamagedCount = 0;

  demoProducts.forEach((p, index) => {
    branches.forEach((branch, bIdx) => {
      const isConsumable = p.productGroup === 'Consumable Item';
      const baseQty = isConsumable ? (branch.isHeadquarters ? 150 + ((index * 10) % 100) : 35 + ((index + bIdx) % 25)) : 2 + ((index + bIdx) % 2);
      const qty = baseQty;

      let damagedQty = 0;
      if (seededDamagedCount < 21 && (index * 7 + bIdx * 3 + 1) % 13 === 0) {
        damagedQty = 1;
        seededDamagedCount++;
      }

      const branchMinReorder = branch.isHeadquarters
        ? p.minReorderLevel * 2
        : (bIdx % 3 === 0 ? p.minReorderLevel : Math.max(1, Math.floor(p.minReorderLevel / 2)));

      demoInventoryStock.push({
        id: `stk-${branch.id.toLowerCase()}-${p.id}`,
        productId: p.id,
        branchId: branch.id,
        quantityOnHand: qty,
        damagedQty: damagedQty,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: branchMinReorder,
        lastUpdated: new Date().toISOString(),
      });
    });
  });

  const demoAssetRegister: Asset[] = EXCEL_ITEMS
    .filter((item) => item.group === 'FIXED ASSET')
    .map((item, idx) => {
      let cat: Asset['category'] = 'IT Equipment';
      if (item.type === 'Furniture') cat = 'Furniture';
      else if (item.type === 'Air Conditioner' || item.type === 'Tiffin Bod') cat = 'Fixtures';
      else if (item.type === 'Fiber Fusion Splicer' || item.type === 'Cutter' || item.type === 'Ladder') cat = 'Machinery';

      const cost = item.val > 0 ? item.val * 1000 : 25000;
      const accum = Math.round(cost * 0.15);
      const assignedBranch = branches[idx % branches.length].id;

      return {
        id: `ast-${item.code.toLowerCase()}`,
        tagNumber: `AST-${item.code}`,
        name: item.name,
        category: cat,
        branchId: assignedBranch,
        acquisitionDateAD: '2024-04-15',
        acquisitionDateBS: '2081-01-03 BS',
        acquisitionCost: cost,
        depreciationMethod: 'STRAIGHT_LINE',
        depreciationRatePercent: 15,
        accumulatedDepreciation: accum,
        netBookValue: cost - accum,
        status: 'ACTIVE',
      };
    });

  const demoPurchaseOrders: PurchaseOrder[] = [
    {
      id: 'po-101',
      poNumber: 'PO-2083-001',
      supplierName: 'Himalayan Tech Distributors Pvt. Ltd.',
      branchId: 'WH001',
      orderDateAD: '2026-07-20',
      orderDateBS: '2083-04-05 BS',
      expectedDeliveryDateAD: '2026-08-05',
      status: 'SENT',
      items: [
        {
          id: 'poi-1',
          productId: 'prod-onu001',
          productName: 'ONU ROUTER 2.4G',
          sku: 'ONU001',
          quantity: 50,
          unitPrice: 2500,
          taxRate: 13,
          subtotal: 125000,
          taxAmount: 16250,
          total: 141250,
        },
      ],
      subtotalAmount: 125000,
      taxAmount: 16250,
      totalAmount: 141250,
      notes: 'Sample purchase order.',
    },
  ];

  const demoPurchaseInvoices: PurchaseInvoice[] = [];
  const demoShipments: Shipment[] = [];
  const demoStockOperations: StockOperation[] = [];
  const demoAuditTrail: AuditLog[] = [];
  const demoTransactionLogs: TransactionLog[] = [];
  const demoCustomerMasterRecords: CustomerRecord[] = [];
  const demoCustomerDeviceRecords: CustomerDeviceRecord[] = [];
  const demoApprovalRequests: ApprovalRequest[] = [];

  return {
    suppliers: demoSuppliers,
    products: demoProducts,
    inventoryStock: demoInventoryStock,
    assetRegister: demoAssetRegister,
    purchaseOrders: demoPurchaseOrders,
    purchaseInvoices: demoPurchaseInvoices,
    shipments: demoShipments,
    stockOperations: demoStockOperations,
    auditTrail: demoAuditTrail,
    transactionLogs: demoTransactionLogs,
    customerMasterRecords: demoCustomerMasterRecords,
    customerDeviceRecords: demoCustomerDeviceRecords,
    approvalRequests: demoApprovalRequests,
  };
}

// ==========================================
// PERSISTENT JSON STORE HELPER
// ==========================================
export const DATA_FILE_PATH = path.join(process.cwd(), '.data_store.json');

export function saveDataStore() {
  try {
    const payload = {
      isDemoDataCleared,
      users,
      branches,
      suppliers,
      companyProfile,
      fiscalYears,
      uomList,
      locationRecords,
      products,
      inventoryStock,
      assetRegister,
      customerDeviceRecords,
      customerMasterRecords,
      purchaseOrders,
      purchaseInvoices,
      shipments,
      stockOperations,
      auditTrail,
      transactionLogs,
      approvalRequests,
    };
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.error('Data persistence note:', err);
  }
}

export function loadDataStore() {
  try {
    if (fs.existsSync(DATA_FILE_PATH)) {
      const raw = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
      const data = JSON.parse(raw);
      if (typeof data.isDemoDataCleared === 'boolean') {
        isDemoDataCleared = data.isDemoDataCleared;
      }
      if (data.companyProfile && typeof data.companyProfile === 'object') {
        companyProfile = { ...companyProfile, ...data.companyProfile };
      }
      if (Array.isArray(data.users) && data.users.length > 0) users = data.users;
      if (Array.isArray(data.branches) && data.branches.length > 0) branches = data.branches;
      if (Array.isArray(data.suppliers)) suppliers = data.suppliers;
      if (Array.isArray(data.fiscalYears) && data.fiscalYears.length > 0) fiscalYears = data.fiscalYears;
      if (Array.isArray(data.uomList) && data.uomList.length > 0) uomList = data.uomList;
      if (Array.isArray(data.locationRecords) && data.locationRecords.length > 0) locationRecords = data.locationRecords;
      if (Array.isArray(data.products)) products = data.products;
      if (Array.isArray(data.inventoryStock)) inventoryStock = data.inventoryStock;
      if (Array.isArray(data.assetRegister)) assetRegister = data.assetRegister;
      if (Array.isArray(data.customerDeviceRecords)) customerDeviceRecords = data.customerDeviceRecords;
      if (Array.isArray(data.customerMasterRecords)) customerMasterRecords = data.customerMasterRecords;
      if (Array.isArray(data.purchaseOrders)) purchaseOrders = data.purchaseOrders;
      if (Array.isArray(data.purchaseInvoices)) purchaseInvoices = data.purchaseInvoices;
      if (Array.isArray(data.shipments)) shipments = data.shipments;
      if (Array.isArray(data.stockOperations)) stockOperations = data.stockOperations;
      if (Array.isArray(data.auditTrail)) auditTrail = data.auditTrail;
      if (Array.isArray(data.transactionLogs)) transactionLogs = data.transactionLogs;
      if (Array.isArray(data.approvalRequests)) approvalRequests = data.approvalRequests;
      
      if (branches.length === 0) branches = [...INITIAL_MASTER_BRANCHES];
      if (fiscalYears.length === 0) fiscalYears = [...INITIAL_MASTER_FISCAL_YEARS];
      if (uomList.length === 0) uomList = [...INITIAL_MASTER_UOM];
      if (locationRecords.length === 0) locationRecords = [...INITIAL_MASTER_LOCATIONS];
      console.log('✅ Persistent database store loaded successfully with', users.length, 'registered users. isDemoDataCleared:', isDemoDataCleared);
    } else {
      branches = [...INITIAL_MASTER_BRANCHES];
      fiscalYears = [...INITIAL_MASTER_FISCAL_YEARS];
      uomList = [...INITIAL_MASTER_UOM];
      locationRecords = [...INITIAL_MASTER_LOCATIONS];
      // If data store file does not exist, check if SEED_DUMMY_DATA=true is explicitly set
      if (process.env.SEED_DUMMY_DATA === 'true') {
        console.log('🌱 Initializing sample demo dataset...');
        const demo = generateDemoDataset();
        suppliers = demo.suppliers;
        products = demo.products;
        inventoryStock = demo.inventoryStock;
        assetRegister = demo.assetRegister;
        purchaseOrders = demo.purchaseOrders;
        purchaseInvoices = demo.purchaseInvoices;
        shipments = demo.shipments;
        stockOperations = demo.stockOperations;
        auditTrail = demo.auditTrail;
        transactionLogs = demo.transactionLogs;
        customerMasterRecords = demo.customerMasterRecords;
        customerDeviceRecords = demo.customerDeviceRecords;
        approvalRequests = demo.approvalRequests;
        isDemoDataCleared = false;
      } else {
        isDemoDataCleared = true;
      }
      saveDataStore();
    }
  } catch (err) {
    console.error('Error loading persistent data store:', err);
  }
}



// Active user session simulation


export let activeUser: User | null = null;

/** Replace entire collections (used by clear-demo-data / load). */
export function replaceCollection<K extends keyof StoreCollections>(key: K, value: StoreCollections[K]) {
  switch (key) {
    case 'users': users = value as User[]; break;
    case 'suppliers': suppliers = value as Supplier[]; break;
    case 'products': products = value as Product[]; break;
    case 'categories': categories = value as Category[]; break;
    case 'inventoryStock': inventoryStock = value as InventoryStock[]; break;
    case 'assetRegister': assetRegister = value as Asset[]; break;
    case 'customerDeviceRecords': customerDeviceRecords = value as CustomerDeviceRecord[]; break;
    case 'customerMasterRecords': customerMasterRecords = value as CustomerRecord[]; break;
    case 'purchaseOrders': purchaseOrders = value as PurchaseOrder[]; break;
    case 'purchaseInvoices': purchaseInvoices = value as PurchaseInvoice[]; break;
    case 'shipments': shipments = value as Shipment[]; break;
    case 'stockOperations': stockOperations = value as StockOperation[]; break;
    case 'auditTrail': auditTrail = value as AuditLog[]; break;
    case 'transactionLogs': transactionLogs = value as TransactionLog[]; break;
    case 'approvalRequests': approvalRequests = value as ApprovalRequest[]; break;
    case 'uomList': uomList = value as UnitOfMeasure[]; break;
    case 'locationRecords': locationRecords = value as LocationRecord[]; break;
    case 'branches': branches = value as Branch[]; break;
    case 'fiscalYears': fiscalYears = value as FiscalYear[]; break;
    default: break;
  }
}

type StoreCollections = {
  users: User[];
  suppliers: Supplier[];
  products: Product[];
  categories: Category[];
  inventoryStock: InventoryStock[];
  assetRegister: Asset[];
  customerDeviceRecords: CustomerDeviceRecord[];
  customerMasterRecords: CustomerRecord[];
  purchaseOrders: PurchaseOrder[];
  purchaseInvoices: PurchaseInvoice[];
  shipments: Shipment[];
  stockOperations: StockOperation[];
  auditTrail: AuditLog[];
  transactionLogs: TransactionLog[];
  approvalRequests: ApprovalRequest[];
  uomList: UnitOfMeasure[];
  locationRecords: LocationRecord[];
  branches: Branch[];
  fiscalYears: FiscalYear[];
};

export function setCompanyProfile(profile: CompanyProfile) {
  companyProfile = profile;
}

export function setIsDemoDataCleared(value: boolean) {
  isDemoDataCleared = value;
}

export function setActiveUser(user: User | null) {
  activeUser = user;
}

/** Startup: load store and migrate legacy plaintext passwords. */
export async function initializeStore() {
  loadDataStore();
  let changed = false;
  for (const u of users) {
    if (u.password && !isBcryptHash(u.password)) {
      try {
        u.password = await hashPassword(u.password);
        changed = true;
      } catch (_e) {}
    }
    if (u.role) u.role = normalizeRole(u.role) as User['role'];
  }
  if (changed) {
    saveDataStore();
    console.log('🔐 Migrated legacy plaintext passwords to bcrypt hashes.');
  }
}
