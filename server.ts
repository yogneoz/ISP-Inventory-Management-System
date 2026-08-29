import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
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
} from './src/types';

dotenv.config();

import { pgPool, realPoolInstance, setIsPgConnected, getIsPgConnected } from './server/db';
let isPgConnected = false;

const app = express();
app.use(express.json());

// Routes reachable without authentication, hoisted to module scope so the Set
// is not re-allocated on every request.
const PUBLIC_ROUTES = new Set([
  '/auth/setup-status',
  '/auth/setup-superadmin',
  '/auth/forgot-password',
  '/auth/login',
  '/db/status',
  '/health',
  '/sync/stream',
  '/sync/version',
]);

// Health & Control Plane Endpoints FIRST before any other routes or middleware
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global Backend Authentication Middleware for all API routes
app.use('/api', authenticateUser);
app.use('/api', (req, res, next) => {
  if (PUBLIC_ROUTES.has(req.path)) return next();
  return requireAuth(req, res, next);
});
app.use('/api', requirePostgres);

const PORT = Number.parseInt(process.env.PORT || '3000', 10);

// ==========================================
// RUNTIME STATE & POSTGRESQL DATA HYDRATION
// ==========================================

// Runtime mirrors hydrated from PostgreSQL for request processing and broadcasts.
let users: User[] = [];
let suppliers: Supplier[] = [];
let uomList: UnitOfMeasure[] = [];
let locationRecords: LocationRecord[] = [];
let branches: Branch[] = [];
let fiscalYears: FiscalYear[] = [];

const INITIAL_COMPANY_PROFILE: CompanyProfile = {
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

let companyProfile: CompanyProfile = { ...INITIAL_COMPANY_PROFILE };

const INITIAL_DOCUMENT_NUMBER_CONFIGS: DocumentNumberConfig[] = [
  { id: 'PO', documentType: 'Purchase Order', prefix: 'PO-2081-', suffix: '', minDigits: 4, startingNumber: 1001, nextNumber: 1001, resetEveryFiscalYear: true, notes: 'Used for vendor purchase requisitions and official purchase orders.' },
  { id: 'PI', documentType: 'Purchase Invoice / Bill', prefix: 'PI-2081-', suffix: '', minDigits: 4, startingNumber: 5001, nextNumber: 5001, resetEveryFiscalYear: true, notes: 'Used for supplier purchase invoices and tax bills.' },
  { id: 'GRN', documentType: 'Goods Receipt Note (GRN)', prefix: 'GRN-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used when warehouse receives inbound stock shipments.' },
  { id: 'DN', documentType: 'Purchase Return & Debit Note', prefix: 'DN-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for returning defective goods to vendors and supplier debit notes.' },
  { id: 'INV', documentType: 'Sales & POS Invoice', prefix: 'INV-2081-', suffix: '', minDigits: 5, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for POS sales bills and customer sales tax invoices.' },
  { id: 'QUO', documentType: 'Sales Quotation & Proforma Invoice', prefix: 'QUO-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for issuing formal price quotes and proforma invoices to clients.' },
  { id: 'CN', documentType: 'Sales Return & Credit Note', prefix: 'CN-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for customer product returns and VAT credit note adjustments.' },
  { id: 'ST', documentType: 'Inter-Branch Stock Transfer', prefix: 'ST-2081-', suffix: '', minDigits: 4, startingNumber: 101, nextNumber: 101, resetEveryFiscalYear: true, notes: 'Used for branch-to-branch stock transfers and dispatches.' },
  { id: 'SA', documentType: 'Stock Adjustment & Audit', prefix: 'SA-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used during physical stock audits and inventory reconciliations.' },
  { id: 'DC', documentType: 'Damage & Pullout Claim', prefix: 'DC-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for damaged stock write-offs and pullout dispatches.' },
  { id: 'CPI', documentType: 'Consumable Product Issue', prefix: 'CPI-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for internal material consumption, office supplies, and store use requisitions.' },
  { id: 'EXC', documentType: 'Device Exchange & Replacement', prefix: 'EXC-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for customer device trade-ins, replacement swaps, and exchange vouchers.' },
  { id: 'WC', documentType: 'Warranty Service & Repair Slip', prefix: 'WC-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for customer repair jobs, device service intake, and warranty claims.' },
  { id: 'FAA', documentType: 'Fixed Asset Assignment & Transfer', prefix: 'FAA-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: 'Used for assigning company assets to staff, custody handovers, and department transfers.' },
  { id: 'FAR', documentType: 'Fixed Asset Capitalization & Register', prefix: 'FAR-2081-', suffix: '', minDigits: 4, startingNumber: 101, nextNumber: 101, resetEveryFiscalYear: true, notes: 'Used for logging newly capitalized fixed assets into company asset register.' },
  { id: 'JV', documentType: 'Journal Voucher', prefix: 'JV-2081-', suffix: '', minDigits: 4, startingNumber: 1001, nextNumber: 1001, resetEveryFiscalYear: true, notes: 'Used for manual general ledger transactions and depreciation entries.' },
  { id: 'PV', documentType: 'Payment Disbursement Voucher', prefix: 'PV-2081-', suffix: '', minDigits: 4, startingNumber: 1001, nextNumber: 1001, resetEveryFiscalYear: true, notes: 'Used for supplier bill payments, operational expenses, and bank disbursements.' },
  { id: 'RV', documentType: 'Cash & Bank Receipt Voucher', prefix: 'RV-2081-', suffix: '', minDigits: 4, startingNumber: 1001, nextNumber: 1001, resetEveryFiscalYear: true, notes: 'Used for customer payments, advance collections, and bank deposits.' },
];

let docNumberConfigs: DocumentNumberConfig[] = JSON.parse(JSON.stringify(INITIAL_DOCUMENT_NUMBER_CONFIGS));

// Master Initial Seed Specifications for PostgreSQL database initialization
const INITIAL_MASTER_UOM: UnitOfMeasure[] = [
  { id: 'uom-1', name: 'Pieces', symbol: 'Pcs', type: 'Count', isBaseUnit: true },
  { id: 'uom-2', name: 'Meters', symbol: 'Mtr', type: 'Length', isBaseUnit: true },
  { id: 'uom-3', name: 'Rolls', symbol: 'Roll', type: 'Package', isBaseUnit: false },
  { id: 'uom-4', name: 'Boxes', symbol: 'Box', type: 'Package', isBaseUnit: false },
  { id: 'uom-5', name: 'Sets', symbol: 'Set', type: 'Count', isBaseUnit: true },
];

const INITIAL_MASTER_LOCATIONS: LocationRecord[] = [
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

const INITIAL_MASTER_BRANCHES: Branch[] = [
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

const INITIAL_MASTER_FISCAL_YEARS: FiscalYear[] = [
  { id: 'fy-1', code: '2080-81', startDateAD: '2023-07-17', endDateAD: '2024-07-15', startDateBS: '2080-04-01 BS', endDateBS: '2080-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-2', code: '2081-82', startDateAD: '2024-07-16', endDateAD: '2025-07-15', startDateBS: '2081-04-01 BS', endDateBS: '2081-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-3', code: '2082-83', startDateAD: '2025-07-16', endDateAD: '2026-07-15', startDateBS: '2082-04-01 BS', endDateBS: '2082-12-31 BS', isCurrent: true, isClosed: false },
  { id: 'fy-4', code: '2083-84', startDateAD: '2026-07-16', endDateAD: '2027-07-15', startDateBS: '2083-04-01 BS', endDateBS: '2083-12-31 BS', isCurrent: false, isClosed: false },
];

const INITIAL_MASTER_SUPPLIERS: Supplier[] = [
  {
    id: 'sup-1',
    supplierCode: 'SUP-1001',
    name: 'Apex Trade & Telecom Supplies Pvt. Ltd.',
    contactPerson: 'Ramesh Adhikari',
    phone: '+977-1-4265890',
    email: 'orders@apextelecom.com.np',
    address: 'Putalisadak, Kathmandu, Nepal',
    panVatNumber: '300129841',
    rating: 4.8,
  },
  {
    id: 'sup-2',
    supplierCode: 'SUP-1002',
    name: 'Himalayan Tech Distributors Pvt. Ltd.',
    contactPerson: 'Sanjay Thapa',
    phone: '+977-1-4412390',
    email: 'sales@himalayantech.com.np',
    address: 'New Road, Kathmandu, Nepal',
    panVatNumber: '302918273',
    rating: 4.7,
  },
  {
    id: 'sup-3',
    supplierCode: 'SUP-1003',
    name: 'Nepal Optical & Fiber Optics Importers',
    contactPerson: 'Binod Shrestha',
    phone: '+977-1-4432100',
    email: 'info@nepaloptical.com.np',
    address: 'Morang, Koshi Province, Nepal',
    panVatNumber: '601239845',
    rating: 4.9,
  },
  {
    id: 'sup-4',
    supplierCode: 'SUP-1004',
    name: 'IZone Cablenet Hardware Suppliers',
    contactPerson: 'Prakash Karki',
    phone: '+977-021-540200',
    email: 'procurement@izonehardware.com.np',
    address: 'Urlabari, Morang, Nepal',
    panVatNumber: '602819384',
    rating: 5.0,
  },
  {
    id: 'sup-5',
    supplierCode: 'SUP-1005',
    name: 'Broadlink Fiber Importers Pvt. Ltd.',
    contactPerson: 'Deepak Sharma',
    phone: '+977-1-4109823',
    email: 'imports@broadlinkfiber.com.np',
    address: 'Biratnagar, Koshi Province, Nepal',
    panVatNumber: '301829304',
    rating: 4.6,
  },
];

// Operational arrays initialized empty by default
let products: Product[] = [];
let categories: Category[] = [];
let inventoryStock: InventoryStock[] = [];
let assetRegister: Asset[] = [];
let customerDeviceRecords: CustomerDeviceRecord[] = [];
let customerMasterRecords: CustomerRecord[] = [];
let purchaseOrders: PurchaseOrder[] = [];
let purchaseInvoices: PurchaseInvoice[] = [];
let shipments: Shipment[] = [];
let stockOperations: StockOperation[] = [];
let auditTrail: AuditLog[] = [];
let transactionLogs: TransactionLog[] = [];
let approvalRequests: ApprovalRequest[] = [];

// Standard Transaction ID Generator
// Pattern: {BRANCH_CODE}-{OP_TYPE}-{YYYYMMDD}-{0001}
// Daily counter resets automatically at 12:00 AM (midnight) per branch & operation type
const transactionSequenceMap: Record<string, { lastDateStr: string; count: number }> = {};

function generateStandardTransactionId(branchIdOrCode: string, opType: string, customDate?: Date): string {
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
function generateDemoDataset() {
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

// Active user session mirror; authentication always reads PostgreSQL.
let activeUser: User | null = null;

const PASSWORD_HASH_PREFIX = 'scrypt$';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${PASSWORD_HASH_PREFIX}${salt}$${derivedKey.toString('hex')}`;
}

function verifyPassword(password: string, storedPassword: string): { valid: boolean; upgradedHash?: string } {
  if (!storedPassword) return { valid: false };

  if (!storedPassword.startsWith(PASSWORD_HASH_PREFIX)) {
    return { valid: password === storedPassword, upgradedHash: password === storedPassword ? hashPassword(password) : undefined };
  }

  const [, salt, storedHash] = storedPassword.split('$');
  if (!salt || !storedHash) return { valid: false };

  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const expectedHash = Buffer.from(storedHash, 'hex');
    return {
      valid: expectedHash.length === derivedKey.length && crypto.timingSafeEqual(expectedHash, derivedKey),
    };
  } catch (_err) {
    return { valid: false };
  }
}

// Extract triggering user details from request headers or body or activeUser
function getUserFromReq(req: any) {
  const email =
    (req.headers['x-user-email'] as string) ||
    req.body?.userEmail ||
    req.body?.user?.email ||
    req.body?.currentUser?.email ||
    activeUser?.email ||
    '';
  const name =
    (req.headers['x-user-name'] as string) ||
    req.body?.userName ||
    req.body?.user?.name ||
    req.body?.currentUser?.name ||
    activeUser?.name ||
    '';
  const role =
    (req.headers['x-user-role'] as string) ||
    req.body?.userRole ||
    req.body?.user?.role ||
    activeUser?.role ||
    '';
  const branchId =
    (req.headers['x-user-branch'] as string) ||
    req.body?.branchId ||
    req.body?.user?.branchId ||
    activeUser?.branchId ||
    '';

  return { email, name, role, branchId };
}

/**
 * Explicit Database Transaction Runner
 * Executes a sequence of SQL queries inside an explicit BEGIN...COMMIT / ROLLBACK block
 */
async function withTransaction<T>(
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
 * Express Authentication Middleware
 * Resolves authenticated user details from headers/session and attaches to request
 */
function authenticateUser(req: any, _res: any, next: any) {
  req.user = getUserFromReq(req);
  next();
}

function requirePostgres(_req: any, res: any, next: any) {
  if (!isPgConnected || !getIsPgConnected() || !realPoolInstance) {
    return res.status(503).json({
      message: 'PostgreSQL is unavailable. Start the database and verify the connection settings before using the application.',
    });
  }
  next();
}

/**
 * Authentication Enforcer Middleware
 */
function requireAuth(req: any, res: any, next: any) {
  const user = req.user || getUserFromReq(req);
  if (!user || !user.email) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required to access endpoint' });
  }
  req.user = user;
  next();
}

/**
 * Role-Based Access Control Middleware
 */
function requireRole(...allowedRoles: string[]) {
  return (req: any, res: any, next: any) => {
    const user = req.user || getUserFromReq(req);
    if (!user || !user.email) {
      return res.status(401).json({ message: 'Unauthorized: Authentication required' });
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role) && user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        message: `Forbidden: Access restricted. Role '${user.role}' lacks sufficient privileges for this operational action. Required role: ${allowedRoles.join(' or ')}`,
      });
    }
    req.user = user;
    next();
  };
}

function logAuditEvent(
  req: any,
  action: string,
  module: string,
  details: string,
  overrideBranchId?: string
) {
  const u = getUserFromReq(req);
  const auditItem: AuditLog = {
    id: `aud-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    userEmail: u.email,
    userName: u.name,
    action,
    module: module as AuditLog['module'],
    details,
    timestampAD: new Date().toISOString(),
    timestampBS: '2083-04-16 BS',
    branchId: overrideBranchId || u.branchId,
  };

  auditTrail.unshift(auditItem);

  // Broadcast event to all active real-time SSE client connections
  broadcastChange({
    type: action,
    entity: module,
    branchId: auditItem.branchId,
  });

  // Async persist to Postgres if available
  pgPool
    .query(
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
        auditItem.branchId,
      ]
    )
    .catch(() => {});

  return auditItem;
}

// ==========================================
// REAL-TIME SYNC & BROADCAST ENGINE (SSE)
// ==========================================
let dataVersion = Date.now();
const sseClients = new Set<express.Response>();

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
app.get('/api/sync/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial handshake with current server state version
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', dataVersion, timestamp: new Date().toISOString() })}\n\n`);

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_e) {
      clearInterval(keepAliveTimer);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    sseClients.delete(res);
  });
});

app.get('/api/sync/version', (req, res) => {
  res.json({ dataVersion, timestamp: new Date().toISOString() });
});

// ==========================================
// UNIFIED BATCH BOOTSTRAP ENDPOINT (1-ROUNDTRIP SYNC)
// ==========================================
app.get('/api/bootstrap', async (req, res) => {
  const { branchId } = req.query;
  const bId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;

  if (isPgConnected) {
    try {
      const [
        bRes, pRes, sRes, aRes, dRes, cRes, poRes, piRes, shRes, opRes, fyRes, auditRes, txnRes, supRes, uRes, appRes, catRes, uomRes, locRes, compDbRes
      ] = await Promise.all([
        pgPool.query('SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches'),
        pgPool.query('SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products'),
        pgPool.query('SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAd", acquisition_date_bs AS "acquisitionDateBs", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo" FROM fixed_assets' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAd", issued_date_bs AS "issuedDateBs", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount" FROM customer_records' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS", expected_delivery_date_ad AS "expectedDeliveryDateAD", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", amount_paid AS "amountPaid", items FROM purchase_invoices' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAd", dispatch_date_bs AS "dispatchDateBs", estimated_arrival_ad AS "estimatedArrivalAd", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAd", received_date_bs AS "receivedDateBs", has_discrepancy AS "hasDiscrepancy" FROM shipments' + (bId ? ' WHERE source_branch_id = $1 OR destination_branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAd", date_bs AS "dateBs", fiscal_year AS "fiscalYear", status, items FROM stock_operations' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, code, start_date_ad AS "startDateAd", end_date_ad AS "endDateAd", start_date_bs AS "startDateBs", end_date_bs AS "endDateBs", is_current AS "isCurrent", is_closed AS "isClosed" FROM fiscal_years'),
        pgPool.query('SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs ORDER BY timestamp_ad DESC LIMIT 200'),
        pgPool.query('SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs ORDER BY timestamp_ad DESC LIMIT 300'),
        pgPool.query('SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers'),
        pgPool.query('SELECT id, email, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users'),
        pgPool.query('SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status, requested_at_ad AS "requestedAtAd", requested_at_bs AS "requestedAtBs" FROM approval_requests' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, name, code, description FROM categories ORDER BY name ASC'),
        pgPool.query('SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC'),
        pgPool.query('SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1'),
      ]);

      const pgStock = sRes.rows;
      const pgProducts = pRes.rows;
      const pgAssets = aRes.rows;
      const pgInvoices = piRes.rows;
      const pgOps = opRes.rows;
      const pgFiscalYears = fyRes.rows;

      // Index products by id once so the valuation below is O(stock + products)
      // instead of the previous O(stock * products) repeated find().
      const productCostById = new Map<string, number>();
      for (const p of pgProducts) {
        productCostById.set(p.id, Number(p.costPrice || 0));
      }
      const totalInventoryAssetValue = pgStock.reduce((sum: number, item: any) => {
        const cost = productCostById.get(item.productId) || 0;
        return sum + cost * Number(item.quantityOnHand || 0);
      }, 0);

      const totalFixedAssetValue = pgAssets.reduce((sum: number, a: any) => sum + Number(a.netBookValue || 0), 0);
      const totalAccountsPayable = pgInvoices.reduce(
        (sum: number, inv: any) => sum + Math.max(0, Number(inv.grandTotal || 0) - Number(inv.amountPaid || 0)),
        0
      );
      const totalDamageLossValue = pgOps.reduce((sum: number, op: any) => sum + Number(op.totalValue || 0), 0);
      const totalVatInputTax = pgInvoices.reduce((sum: number, inv: any) => sum + Number(inv.vatAmount || 0), 0);
      const currentFy = pgFiscalYears.find((f: any) => f.isCurrent)?.code || '2082/83';

      const financialSummary = {
        totalInventoryAssetValue,
        totalFixedAssetValue,
        totalAccountsPayable,
        totalCostOfGoodsSold: 450000,
        totalDamageLossValue,
        totalVatInputTax,
        currentFiscalYear: currentFy,
      };

      res.setHeader('Cache-Control', 'private, no-cache');
      return res.json({
        branches: bRes.rows,
        products: pgProducts,
        stock: pgStock,
        assets: pgAssets,
        customerDevices: dRes.rows,
        customers: cRes.rows,
        purchaseOrders: poRes.rows,
        purchaseInvoices: pgInvoices,
        shipments: shRes.rows,
        stockOperations: pgOps,
        fiscalYears: pgFiscalYears,
        auditLogs: auditRes.rows,
        transactionLogs: txnRes.rows,
        financialSummary,
        suppliers: supRes.rows,
        users: uRes.rows,
        approvalRequests: appRes.rows,
        categories: catRes.rows,
        uom: uomRes.rows,
        locations: locRes.rows,
        companyProfile: compDbRes.rows[0] || companyProfile,
        postgresDatabaseStatus: {
          isConnected: true,
          host: process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
          database: process.env.POSTGRES_DB || 'inventory_db',
          user: process.env.POSTGRES_USER || 'inventory_user',
          engine: 'PostgreSQL Server (External/Self-Hosted)'
        },
        serverTime: new Date().toISOString(),
        dataVersion,
      });
    } catch (pgErr: any) {
      isPgConnected = false;
      setIsPgConnected(false);
      console.error('PostgreSQL bootstrap query failed:', pgErr?.message || pgErr);
      return res.status(503).json({
        message: 'PostgreSQL became unavailable while loading application data. Restart the database and try again.',
      });
    }
  }
  return res.status(503).json({
    message: 'PostgreSQL is unavailable. Start the database and try again.',
  });

});

// Database Health & Connection Check Endpoint
app.get('/api/db/status', async (req, res) => {
  let isConnected = false;
  let errorDetails = '';
  let tableCount = 0;

  if (realPoolInstance) {
    try {
      const client = await realPoolInstance.connect();
      const testRes = await client.query('SELECT current_database(), version(), (SELECT count(*) FROM information_schema.tables WHERE table_schema = \'public\') as tables');
      client.release();
      isConnected = true;
      isPgConnected = true;
      tableCount = parseInt(testRes.rows[0]?.tables || '0', 10);
    } catch (err: any) {
      isConnected = false;
      errorDetails = err?.message || 'Failed to connect to PostgreSQL server';
    }
  }

  res.json({
    isConnected,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'inventory_db',
    user: process.env.POSTGRES_USER || 'inventory_user',
    tableCount,
    errorDetails,
  });
});

// ==========================================
// API REST ENDPOINTS
// ==========================================

// Clear Demo/Dummy Data Endpoint
app.post('/api/admin/clear-demo-data', async (req, res) => {
  try {
    if (isPgConnected) {
      await pgPool.query(`
        TRUNCATE TABLE 
          approval_requests,
          customer_device_records,
          customer_records,
          purchase_invoices,
          purchase_orders,
          shipments,
          stock_operations,
          inventory_stock,
          fixed_assets,
          products,
          categories,
          suppliers,
          audit_logs,
          transaction_logs
        CASCADE;
      `);
    }

    // Operational tables to clear
    products.length = 0;
    inventoryStock.length = 0;
    assetRegister.length = 0;
    customerDeviceRecords.length = 0;
    customerMasterRecords.length = 0;
    purchaseOrders.length = 0;
    purchaseInvoices.length = 0;
    shipments.length = 0;
    stockOperations.length = 0;
    auditTrail.length = 0;
    transactionLogs.length = 0;
    approvalRequests.length = 0;
    suppliers.length = 0;
    // Operational data is cleared in PostgreSQL while users, branches, and fiscal years remain intact.

    dataVersion++;
    sseClients.forEach((client) => {
      try {
        client.write(`data: ${JSON.stringify({ type: 'DEMO_DATA_CLEARED', dataVersion, timestamp: new Date().toISOString() })}\n\n`);
      } catch (_e) {}
    });

    return res.json({
      message: 'All demo and dummy operational data cleared successfully. Master users, branches, and fiscal years are intact.',
      userCount: users.length,
      superAdminCount: users.filter((u) => u.role === 'SUPER_ADMIN').length,
    });
  } catch (err: any) {
    console.error('Error clearing demo data:', err);
    return res.status(500).json({ message: 'Failed to clear demo data: ' + (err?.message || err) });
  }
});

// Auth Login
app.get('/api/auth/setup-status', async (req, res) => {
  if (isPgConnected) {
    try {
      const { rows } = await pgPool.query('SELECT COUNT(*) AS count, COUNT(CASE WHEN role = \'SUPER_ADMIN\' THEN 1 END) AS sa_count FROM users');
      const count = parseInt(rows[0]?.count || '0', 10);
      const saCount = parseInt(rows[0]?.sa_count || '0', 10);
      return res.json({
        isFirstLaunch: count === 0 || saCount === 0,
        userCount: count,
        hasSuperAdmin: saCount > 0,
      });
    } catch (_err) {}
  }
  const hasSA = users.some((u) => u.role === 'SUPER_ADMIN');
  const userCount = users.length;
  res.json({
    isFirstLaunch: userCount === 0 || !hasSA,
    userCount,
    hasSuperAdmin: hasSA,
  });
});

app.post('/api/auth/setup-superadmin', async (req, res) => {
  const { name, email, password, branchId } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  const hqBranchId = branchId || branches[0]?.id || 'WH001';
  const cleanEmail = email.trim().toLowerCase();
  const allowedBranches = branches.map((b) => b.id);
  let targetId = `usr-sa-${Date.now()}`;

  if (isPgConnected) {
    try {
      const dbCheck = await pgPool.query(
        `SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"
         FROM users
         WHERE LOWER(email) = LOWER($1) OR role = 'SUPER_ADMIN'
         ORDER BY created_at ASC LIMIT 1`,
        [cleanEmail]
      );

      let savedUser: User;
      if (dbCheck.rows.length > 0) {
        targetId = dbCheck.rows[0].id;
        const upRes = await pgPool.query(
          `UPDATE users SET
             email = $1,
             password = $2,
             name = $3,
             role = 'SUPER_ADMIN',
             branch_id = $4,
             allowed_branch_ids = $5,
             can_switch_user = true
           WHERE id = $6
           RETURNING id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"`,
          [cleanEmail, hashPassword(password), name.trim(), hqBranchId, allowedBranches, targetId]
        );
        savedUser = upRes.rows[0];
        if (!savedUser) {
          const retryRes = await pgPool.query(
            `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
             VALUES ($1, $2, $3, $4, 'SUPER_ADMIN', $5, $6, true)
             ON CONFLICT (email) DO UPDATE SET
               password = EXCLUDED.password,
               name = EXCLUDED.name,
               role = 'SUPER_ADMIN',
               branch_id = EXCLUDED.branch_id,
               allowed_branch_ids = EXCLUDED.allowed_branch_ids,
               can_switch_user = true
             RETURNING id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"`,
            [targetId, cleanEmail, hashPassword(password), name.trim(), hqBranchId, allowedBranches]
          );
          savedUser = retryRes.rows[0];
        }
      } else {
        const insRes = await pgPool.query(
          `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
           VALUES ($1, $2, $3, $4, 'SUPER_ADMIN', $5, $6, true)
           ON CONFLICT (email) DO UPDATE SET
             password = EXCLUDED.password,
             name = EXCLUDED.name,
             role = 'SUPER_ADMIN',
             branch_id = EXCLUDED.branch_id,
             allowed_branch_ids = EXCLUDED.allowed_branch_ids,
             can_switch_user = true
           RETURNING id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser"`,
          [targetId, cleanEmail, hashPassword(password), name.trim(), hqBranchId, allowedBranches]
        );
        savedUser = insRes.rows[0];
      }

      if (!savedUser) {
        throw new Error('Database did not return the Super Admin record after setup. Verify the users table schema and database connection.');
      }

      const idx = users.findIndex((u) => u.id === savedUser.id || u.email.toLowerCase() === cleanEmail || u.role === 'SUPER_ADMIN');
      if (idx !== -1) users[idx] = savedUser;
      else users.unshift(savedUser);

      activeUser = savedUser;
      logAuditEvent(req, 'CREATE_SUPER_ADMIN', 'AUTH', `Super Admin account initialized/updated: ${name} (${cleanEmail})`);

      const { password: _, ...userWithoutPass } = savedUser;
      return res.status(201).json({ user: userWithoutPass, token: `session-token-${savedUser.id}` });
    } catch (err: any) {
      console.error('Error setting up Super Admin in DB:', err);
      return res.status(503).json({
        message: 'Unable to set up Super Admin because PostgreSQL is unavailable. Try again when the database is online.',
      });
    }
  }

  const existingUser = users.find((u) => u.email.toLowerCase() === cleanEmail || u.role === 'SUPER_ADMIN');
  const localUser: User = {
    id: existingUser?.id || targetId,
    email: cleanEmail,
    password: hashPassword(password),
    name: name.trim(),
    role: 'SUPER_ADMIN',
    branchId: hqBranchId,
    allowedBranchIds: allowedBranches,
    canSwitchUser: true,
  };
  if (existingUser) users[users.indexOf(existingUser)] = localUser;
  else users.unshift(localUser);
  activeUser = localUser;
  const { password: _, ...localUserWithoutPass } = localUser;
  return res.status(201).json({ user: localUserWithoutPass, token: `session-token-${localUser.id}` });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  const user = users.find((u) => u.email.toLowerCase() === (email || '').toLowerCase().trim());
  
  if (!user) {
    return res.status(404).json({ message: 'No registered user account found with this email address.' });
  }

  const adminUser = users.find((u) => u.role === 'SUPER_ADMIN') || users[0];
  logAuditEvent(req, 'FORGOT_PASSWORD_REQUEST', 'AUTH', `Password reset request submitted for ${user.name} (${user.email})`);

  res.json({
    success: true,
    userName: user.name,
    adminEmail: adminUser?.email || 'superadmin@izone.net.np',
    message: `Reset request logged for ${user.name}. Please contact your System Administrator (${adminUser?.email || 'superadmin@izone.net.np'}) or ask your Manager to reset your password in User & Staff Management.`,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  try {
    if (isPgConnected) {
      const dbRes = await pgPool.query(
        'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users WHERE LOWER(email) = LOWER($1)',
        [cleanEmail]
      );
      const dbUser = dbRes.rows[0];
      const passwordCheck = dbUser ? verifyPassword(String(password || ''), dbUser.password) : { valid: false };
      if (!dbUser || !passwordCheck.valid) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }

      if (passwordCheck.upgradedHash) {
        await pgPool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [passwordCheck.upgradedHash, dbUser.id]);
        dbUser.password = passwordCheck.upgradedHash;
      }
      activeUser = dbUser;
      const { password: _, ...userWithoutPass } = dbUser;
      return res.json({ user: userWithoutPass, token: `session-token-${dbUser.id}` });
    }

    const localUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
    const passwordCheck = localUser ? verifyPassword(String(password || ''), localUser.password || '') : { valid: false };
    if (!localUser || !passwordCheck.valid) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    if (passwordCheck.upgradedHash) localUser.password = passwordCheck.upgradedHash;
    activeUser = localUser;
    const { password: _, ...userWithoutPass } = localUser;
    return res.json({ user: userWithoutPass, token: `session-token-${localUser.id}` });
  } catch (err: any) {
    console.error('PostgreSQL login query failed:', err?.message || err);
    return res.status(503).json({
      message: 'Unable to verify credentials because PostgreSQL is unavailable. Try again when the database is online.',
    });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!activeUser) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  const { password: _, ...userWithoutPass } = activeUser;
  res.json(userWithoutPass);
});

// Profile Switching Endpoint
app.post('/api/auth/switch-profile', (req, res) => {
  const { targetUserId } = req.body;
  const user = users.find((u) => u.id === targetUserId || u.email === targetUserId);
  if (!user) {
    return res.status(404).json({ message: 'Target user profile not found.' });
  }

  const previousUser = activeUser;
  activeUser = user;

  auditTrail.unshift({
    id: `aud-${Date.now()}`,
    userEmail: user.email,
    userName: user.name,
    action: 'PROFILE_SWITCHED',
    module: 'AUTH',
    details: `Session profile switched from ${previousUser?.email || 'System'} (${previousUser?.role}) to ${user.email} (${user.role})`,
    timestampAD: new Date().toISOString(),
    timestampBS: '2083-04-16 BS',
  });

  const { password: _, ...userWithoutPass } = user;
  res.json({ user: userWithoutPass, token: `session-token-${user.id}` });
});

// Profile Update Endpoint
app.put('/api/auth/profile', (req, res) => {
  const authenticatedUser = activeUser;
  if (!authenticatedUser) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  const { name, email, branchId, newPassword } = req.body;

  const idx = users.findIndex((u) => u.id === authenticatedUser.id);
  if (idx !== -1) {
    if (name) users[idx].name = name;
    if (email) users[idx].email = email;
    if (branchId) users[idx].branchId = branchId;
    if (newPassword) users[idx].password = hashPassword(newPassword);
    activeUser = users[idx];

    if (newPassword && isPgConnected) {
      pgPool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [users[idx].password, users[idx].id])
        .catch((err) => console.error('Error updating profile password:', err));
    }
  }

  const responseUser = idx !== -1 ? users[idx] : authenticatedUser;
  const { password: _, ...userWithoutPass } = responseUser;
  res.json(userWithoutPass);
});

// UOM (Unit of Measure)
app.get('/api/uom', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query('SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC');
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching UOM from DB:', err);
    }
  }
  res.json(uomList);
});

app.post('/api/uom', async (req, res) => {
  try {
    const newUom: UnitOfMeasure = {
      id: req.body.id || `uom-${Date.now()}`,
      name: req.body.name || 'Unit',
      symbol: req.body.symbol || 'Unit',
      type: req.body.type || 'Count',
      isBaseUnit: Boolean(req.body.isBaseUnit),
    };
    const idx = uomList.findIndex((u) => u.id === newUom.id || u.name === newUom.name);
    if (idx >= 0) uomList[idx] = newUom;
    else uomList.push(newUom);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO uom (id, name, symbol, type, is_base_unit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           symbol = EXCLUDED.symbol,
           type = EXCLUDED.type,
           is_base_unit = EXCLUDED.is_base_unit;`,
        [newUom.id, newUom.name, newUom.symbol, newUom.type, newUom.isBaseUnit]
      );
    }
    logAuditEvent(req, 'CREATE_UOM', 'MASTER_DATA', `Created/updated Unit of Measure ${newUom.name} (${newUom.symbol})`);
    res.status(201).json(newUom);
  } catch (err: any) {
    console.error('Error creating UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/uom/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = uomList.findIndex((u) => u.id === id);
    if (idx >= 0) uomList[idx] = { ...uomList[idx], ...req.body };
    const uom = uomList[idx] || req.body;

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE uom SET name = $1, symbol = $2, type = $3, is_base_unit = $4 WHERE id = $5;`,
        [uom.name, uom.symbol, uom.type, Boolean(uom.isBaseUnit), id]
      );
    }
    logAuditEvent(req, 'UPDATE_UOM', 'MASTER_DATA', `Updated UOM ${uom.name}`);
    res.json(uom);
  } catch (err: any) {
    console.error('Error updating UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/uom/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const uom = uomList.find((u) => u.id === id);
    uomList = uomList.filter((u) => u.id !== id);

    if (isPgConnected) {
      await pgPool.query('DELETE FROM uom WHERE id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_UOM', 'MASTER_DATA', `Deleted UOM ${uom?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Locations
app.get('/api/locations', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q = 'SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations' +
                (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') + ' ORDER BY name ASC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching locations from DB:', err);
    }
  }
  let list = locationRecords;
  if (branchId && branchId !== 'ALL') list = list.filter((l) => l.branchId === branchId);
  res.json(list);
});

app.post('/api/locations', async (req, res) => {
  try {
    const newLoc: LocationRecord = {
      id: req.body.id || `LOC-${Math.floor(1000 + Math.random() * 9000)}`,
      name: req.body.name || 'New Location',
      type: req.body.type || 'POP_SERVER_ROOM',
      branchId: req.body.branchId || 'BR-KTM',
      address: req.body.address || '',
      coordinates: req.body.coordinates || { latitude: 27.7172, longitude: 85.324 },
      contactPerson: req.body.contactPerson || '',
      contactPhone: req.body.contactPhone || '',
      notes: req.body.notes || '',
      activeAssetsCount: req.body.activeAssetsCount || 0,
    };
    const idx = locationRecords.findIndex((l) => l.id === newLoc.id);
    if (idx >= 0) locationRecords[idx] = newLoc;
    else locationRecords.unshift(newLoc);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           branch_id = EXCLUDED.branch_id,
           address = EXCLUDED.address,
           coordinates = EXCLUDED.coordinates,
           contact_person = EXCLUDED.contact_person,
           contact_phone = EXCLUDED.contact_phone,
           notes = EXCLUDED.notes,
           active_assets_count = EXCLUDED.active_assets_count;`,
        [
          newLoc.id,
          newLoc.name,
          newLoc.type,
          newLoc.branchId,
          newLoc.address,
          JSON.stringify(newLoc.coordinates),
          newLoc.contactPerson,
          newLoc.contactPhone,
          newLoc.notes,
          newLoc.activeAssetsCount,
        ]
      );
    }
    logAuditEvent(req, 'CREATE_LOCATION', 'MASTER_DATA', `Created/updated location ${newLoc.name} (${newLoc.id})`, newLoc.branchId);
    res.status(201).json(newLoc);
  } catch (err: any) {
    console.error('Error creating location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/locations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = locationRecords.findIndex((l) => l.id === id);
    if (idx >= 0) locationRecords[idx] = { ...locationRecords[idx], ...req.body };
    const loc = locationRecords[idx] || req.body;

    if (isPgConnected && loc) {
      await pgPool.query(
        `UPDATE locations SET
           name = $1, type = $2, branch_id = $3, address = $4, coordinates = $5, contact_person = $6, contact_phone = $7, notes = $8, active_assets_count = $9
         WHERE id = $10;`,
        [
          loc.name,
          loc.type,
          loc.branchId,
          loc.address,
          JSON.stringify(loc.coordinates),
          loc.contactPerson,
          loc.contactPhone,
          loc.notes,
          loc.activeAssetsCount,
          id,
        ]
      );
    }
    logAuditEvent(req, 'UPDATE_LOCATION', 'MASTER_DATA', `Updated location details for ${loc.name} (${id})`, loc.branchId);
    res.json(loc);
  } catch (err: any) {
    console.error('Error updating location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/locations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const loc = locationRecords.find((l) => l.id === id);
    locationRecords = locationRecords.filter((l) => l.id !== id);

    if (isPgConnected) {
      await pgPool.query('DELETE FROM locations WHERE id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_LOCATION', 'MASTER_DATA', `Deleted location ${loc?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Company Profile API
app.get('/api/company-profile', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query('SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1');
      if (r.rows.length > 0) {
        companyProfile = r.rows[0];
        return res.json(r.rows[0]);
      }
    } catch (err) {
      console.error('Error fetching company profile from DB:', err);
    }
  }
  res.json(companyProfile);
});

app.put('/api/company-profile', async (req, res) => {
  try {
    companyProfile = { ...companyProfile, ...req.body };
    if (!companyProfile.id) companyProfile.id = 'COMP-001';

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, default_tax_rate, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           legal_name = EXCLUDED.legal_name,
           tagline = EXCLUDED.tagline,
           address = EXCLUDED.address,
           city = EXCLUDED.city,
           country = EXCLUDED.country,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           website = EXCLUDED.website,
           pan_vat_number = EXCLUDED.pan_vat_number,
           registration_number = EXCLUDED.registration_number,
           logo_url = EXCLUDED.logo_url,
           logo_preset = EXCLUDED.logo_preset,
           currency_symbol = EXCLUDED.currency_symbol,
           default_tax_rate = EXCLUDED.default_tax_rate,
           notes = EXCLUDED.notes,
           updated_at = CURRENT_TIMESTAMP;`,
        [
          companyProfile.id,
          companyProfile.name,
          companyProfile.legalName || '',
          companyProfile.tagline || '',
          companyProfile.address,
          companyProfile.city || '',
          companyProfile.country || '',
          companyProfile.phone || '',
          companyProfile.email || '',
          companyProfile.website || '',
          companyProfile.panVatNumber || '',
          companyProfile.registrationNumber || '',
          companyProfile.logoUrl || '',
          companyProfile.logoPreset || 'telecom',
          companyProfile.currencySymbol || 'Rs.',
          companyProfile.defaultTaxRate ?? 13,
          companyProfile.notes || '',
        ]
      );
    }
    logAuditEvent(req, 'UPDATE_COMPANY_PROFILE', 'MASTER_DATA', `Updated Company Master Details: ${companyProfile.name}`);
    dataVersion++;
    res.json(companyProfile);
  } catch (err: any) {
    console.error('Error updating company profile:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Branches
app.get('/api/branches', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query('SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches ORDER BY name ASC');
      return res.json(r.rows);
    } catch (err) {
      console.error('Error querying branches from DB:', err);
    }
  }
  res.json(branches);
});

app.post('/api/branches', async (req, res) => {
  try {
    const newBranch: Branch = {
      id: req.body.id || `br-${Date.now()}`,
      code: req.body.code || `BR-${Math.floor(100 + Math.random() * 900)}`,
      name: req.body.name || 'New Branch',
      location: req.body.location || 'Nepal',
      phone: req.body.phone || '',
      isHeadquarters: Boolean(req.body.isHeadquarters),
      active: req.body.active !== false,
      allowProcurement: req.body.allowProcurement !== false,
    };
    const idx = branches.findIndex((b) => b.id === newBranch.id);
    if (idx >= 0) branches[idx] = newBranch;
    else branches.push(newBranch);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code,
           name = EXCLUDED.name,
           location = EXCLUDED.location,
           phone = EXCLUDED.phone,
           is_headquarters = EXCLUDED.is_headquarters,
           active = EXCLUDED.active,
           allow_procurement = EXCLUDED.allow_procurement;`,
        [newBranch.id, newBranch.code, newBranch.name, newBranch.location, newBranch.phone, newBranch.isHeadquarters, newBranch.active, newBranch.allowProcurement]
      );
    }
    logAuditEvent(req, 'CREATE_BRANCH', 'MASTER_DATA', `Created new branch ${newBranch.name} (${newBranch.code || newBranch.id})`);
    res.status(201).json(newBranch);
  } catch (err: any) {
    console.error('Error creating branch:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/branches/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = branches.findIndex((b) => b.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Branch not found' });
    branches[idx] = { ...branches[idx], ...req.body };
    const b = branches[idx];

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE branches SET
           code = $1, name = $2, location = $3, phone = $4, is_headquarters = $5, active = $6, allow_procurement = $7
         WHERE id = $8;`,
        [b.code, b.name, b.location, b.phone || '', Boolean(b.isHeadquarters), b.active !== false, b.allowProcurement !== false, id]
      );
    }
    logAuditEvent(req, 'UPDATE_BRANCH', 'MASTER_DATA', `Updated branch details for ${b.name} (${b.id})`);
    res.json(b);
  } catch (err: any) {
    console.error('Error updating branch:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/branches/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const br = branches.find((b) => b.id === id);
    branches = branches.filter((b) => b.id !== id);

    if (isPgConnected) {
      await pgPool.query('DELETE FROM branches WHERE id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_BRANCH', 'MASTER_DATA', `Deleted branch ${br?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting branch:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Suppliers
app.get('/api/suppliers', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query('SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC');
      return res.json(r.rows);
    } catch (err) {
      console.error('Error querying suppliers from DB:', err);
    }
  }
  res.json(suppliers);
});

app.post('/api/suppliers', async (req, res) => {
  try {
    const newSupplier: Supplier = {
      id: req.body.id || `sup-${Date.now()}`,
      supplierCode: req.body.supplierCode || `SUP-${Math.floor(1000 + Math.random() * 9000)}`,
      name: req.body.name || 'New Supplier',
      contactPerson: req.body.contactPerson || '',
      phone: req.body.phone || '',
      email: req.body.email || '',
      address: req.body.address || '',
      panVatNumber: req.body.panVatNumber || '',
      rating: Number(req.body.rating) || 5.0,
      status: req.body.status || 'ACTIVE',
    } as any;
    suppliers.push(newSupplier);

    if (isPgConnected) {
      const sup = newSupplier as any;
      await pgPool.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           supplier_code = EXCLUDED.supplier_code,
           name = EXCLUDED.name,
           contact_person = EXCLUDED.contact_person,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           address = EXCLUDED.address,
           pan_vat_number = EXCLUDED.pan_vat_number,
           rating = EXCLUDED.rating,
           status = EXCLUDED.status;`,
        [sup.id, sup.supplierCode, sup.name, sup.contactPerson, sup.phone, sup.email, sup.address, sup.panVatNumber, sup.rating, sup.status]
      );
    }
    logAuditEvent(req, 'CREATE_SUPPLIER', 'MASTER_DATA', `Created new supplier ${newSupplier.name}`);
    res.status(201).json(newSupplier);
  } catch (err: any) {
    console.error('Error creating supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/suppliers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = suppliers.findIndex((s) => s.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Supplier not found' });
    suppliers[idx] = { ...suppliers[idx], ...req.body };
    const sup = suppliers[idx] as any;

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE suppliers SET
           supplier_code = $1, name = $2, contact_person = $3, phone = $4, email = $5, address = $6, pan_vat_number = $7, rating = $8, status = $9
         WHERE id = $10;`,
        [sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', Number(sup.rating) || 5.0, sup.status || 'ACTIVE', id]
      );
    }
    logAuditEvent(req, 'UPDATE_SUPPLIER', 'MASTER_DATA', `Updated supplier ${sup.name} (${id})`);
    res.json(sup);
  } catch (err: any) {
    console.error('Error updating supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/suppliers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sup = suppliers.find((s) => s.id === id);
    suppliers = suppliers.filter((s) => s.id !== id);

    if (isPgConnected) {
      await pgPool.query('DELETE FROM suppliers WHERE id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_SUPPLIER', 'MASTER_DATA', `Deleted supplier ${sup?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Users
app.get('/api/users', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query(
        'SELECT id, email, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC'
      );
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching users from DB:', err);
    }
  }
  const safeUsers = users.map(({ password: _, ...u }) => u);
  res.json(safeUsers);
});

app.post('/api/users', async (req, res) => {
  try {
    const newUser = {
      id: req.body.id || `usr-${Date.now()}`,
      ...req.body,
      password: hashPassword(String(req.body.password || 'password@123')),
    };
    const idx = users.findIndex((u) => u.id === newUser.id || u.email === newUser.email);
    if (idx >= 0) users[idx] = newUser;
    else users.push(newUser);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           role = EXCLUDED.role,
           branch_id = EXCLUDED.branch_id,
           allowed_branch_ids = EXCLUDED.allowed_branch_ids,
           can_switch_user = EXCLUDED.can_switch_user,
           password = EXCLUDED.password;`,
        [
          newUser.id,
          newUser.email,
          newUser.password,
          newUser.name,
          newUser.role,
          newUser.branchId || null,
          newUser.allowedBranchIds || null,
          !!newUser.canSwitchUser,
        ]
      );
    }
    logAuditEvent(req, 'CREATE_USER', 'AUTH', `Created new user account ${newUser.name} (${newUser.email}) - Role: ${newUser.role}`);
    const { password: _, ...userWithoutPass } = newUser;
    res.status(201).json(userWithoutPass);
  } catch (err: any) {
    console.error('Error creating user:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let idx = users.findIndex((u) => u.id === id);

    if (idx === -1 && isPgConnected) {
      const r = await pgPool.query('SELECT * FROM users WHERE id = $1', [id]);
      if (r.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    }

    const updatedUser = {
      ...(users[idx] || {}),
      ...req.body,
      id,
    };
    if (req.body.password) updatedUser.password = hashPassword(String(req.body.password));
    if (idx !== -1) users[idx] = updatedUser;

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE users SET
           email = $1,
           name = $2,
           role = $3,
           branch_id = $4,
           allowed_branch_ids = $5,
           can_switch_user = $6,
           password = COALESCE($7, password)
         WHERE id = $8`,
        [
          updatedUser.email,
          updatedUser.name,
          updatedUser.role,
          updatedUser.branchId || null,
          updatedUser.allowedBranchIds || null,
          !!updatedUser.canSwitchUser,
          req.body.password ? updatedUser.password : null,
          id,
        ]
      );
    }
    logAuditEvent(req, 'UPDATE_USER', 'AUTH', `Updated user account ${updatedUser.name} (${updatedUser.email})`);
    const { password: _, ...userWithoutPass } = updatedUser;
    res.json(userWithoutPass);
  } catch (err: any) {
    console.error('Error updating user:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = users.findIndex((u) => u.id === id);
    let deletedEmail = '';
    let deletedName = '';

    if (idx !== -1) {
      deletedEmail = users[idx].email;
      deletedName = users[idx].name;
      users.splice(idx, 1);
    }

    if (isPgConnected) {
      const r = await pgPool.query('DELETE FROM users WHERE id = $1 RETURNING email, name', [id]);
      if (r.rows.length > 0) {
        deletedEmail = r.rows[0].email;
        deletedName = r.rows[0].name;
      }
    }
    logAuditEvent(req, 'DELETE_USER', 'AUTH', `Deleted user account ${deletedName || id} (${deletedEmail || id})`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting user:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/users/:id/reset-password', async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const userIdx = users.findIndex((u) => u.id === id);

    if (!newPassword || newPassword.trim().length < 3) {
      return res.status(400).json({ message: 'New password must be at least 3 characters long.' });
    }

    if (userIdx !== -1) {
      users[userIdx].password = hashPassword(newPassword.trim());
    }

    let targetEmail = users[userIdx]?.email || id;
    let targetName = users[userIdx]?.name || id;

    if (isPgConnected) {
      const r = await pgPool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING email, name', [hashPassword(newPassword.trim()), id]);
      if (r.rows.length > 0) {
        targetEmail = r.rows[0].email;
        targetName = r.rows[0].name;
      }
    }
    logAuditEvent(req, 'RESET_USER_PASSWORD', 'AUTH', `Password reset for user account ${targetName} (${targetEmail})`);

    const userWithoutPass = userIdx !== -1 ? (({ password, ...rest }) => rest)(users[userIdx]) : { id, email: targetEmail, name: targetName };
    res.json({
      success: true,
      message: `Password for ${targetName} (${targetEmail}) has been successfully updated.`,
      user: userWithoutPass,
    });
  } catch (err: any) {
    console.error('Error resetting user password:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Products
app.get('/api/products', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query(
        'SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products ORDER BY created_at DESC'
      );
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching products from DB:', err);
    }
  }
  res.json(products);
});

app.post('/api/products', async (req, res) => {
  try {
    const newProd = {
      id: `prod-${Date.now()}`,
      sku: req.body.sku || `SKU-${Date.now()}`,
      barcode: req.body.barcode || '',
      name: req.body.name || 'Untitled Product',
      category: req.body.category || 'General',
      productGroup: req.body.productGroup || 'Product Item',
      unit: req.body.unit || 'Pcs',
      costPrice: Number(req.body.costPrice) || 0,
      sellingPrice: Number(req.body.sellingPrice) || 0,
      taxRate: Number(req.body.taxRate) || 13,
      minReorderLevel: Number(req.body.minReorderLevel) || 5,
      requiresSerialTracking: Boolean(req.body.requiresSerialTracking),
      trackingType: req.body.trackingType || 'QUANTITY_ONLY',
      description: req.body.description || '',
      status: req.body.status || 'ACTIVE',
    };
    products.push(newProd);

    // Initialize 0 stock across all branches
    const newStockItems: any[] = [];
    branches.forEach((b) => {
      const stkItem = {
        id: `stk-${Date.now()}-${b.id}`,
        productId: newProd.id,
        branchId: b.id,
        quantityOnHand: 0,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: newProd.minReorderLevel,
        lastUpdated: new Date().toISOString(),
      };
      inventoryStock.push(stkItem);
      newStockItems.push(stkItem);
    });

    // PostgreSQL database insertion
    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           sku = EXCLUDED.sku,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           selling_price = EXCLUDED.selling_price;`,
        [
          newProd.id,
          newProd.sku,
          newProd.barcode,
          newProd.name,
          newProd.category,
          newProd.productGroup,
          newProd.unit,
          newProd.costPrice,
          newProd.sellingPrice,
          newProd.taxRate,
          newProd.minReorderLevel,
          newProd.requiresSerialTracking,
          newProd.trackingType,
          newProd.description,
          newProd.status,
        ]
      );

      for (const stk of newStockItems) {
        await pgPool.query(
          `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING;`,
          [stk.id, stk.productId, stk.branchId, stk.quantityOnHand, stk.damagedQty, stk.reservedQty, stk.incomingQty, stk.minReorderLevel]
        );
      }
    }
    logAuditEvent(req, 'CREATE_PRODUCT', 'PRODUCTS', `Created new product SKU ${newProd.sku} (${newProd.name}) - Price: NPR ${newProd.sellingPrice}`);
    res.status(201).json(newProd);
  } catch (err: any) {
    console.error('Error creating product in database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = products.findIndex((p) => p.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Product not found' });

    const oldProd = { ...products[idx] };
    products[idx] = { ...products[idx], ...req.body };
    const updated = products[idx];

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE products SET
           sku = $1,
           barcode = $2,
           name = $3,
           category = $4,
           product_group = $5,
           unit = $6,
           cost_price = $7,
           selling_price = $8,
           tax_rate = $9,
           min_reorder_level = $10,
           requires_serial_tracking = $11,
           tracking_type = $12,
           description = $13,
           status = $14
         WHERE id = $15;`,
        [
          updated.sku,
          updated.barcode || '',
          updated.name,
          updated.category,
          updated.productGroup || 'Product Item',
          updated.unit || 'Pcs',
          Number(updated.costPrice) || 0,
          Number(updated.sellingPrice) || 0,
          Number(updated.taxRate) || 13,
          Number(updated.minReorderLevel) || 5,
          Boolean(updated.requiresSerialTracking),
          updated.trackingType || 'QUANTITY_ONLY',
          updated.description || '',
          updated.status || 'ACTIVE',
          id,
        ]
      );
    }
    const changeMsg = oldProd.sku !== updated.sku
      ? `SKU updated from ${oldProd.sku} to ${updated.sku}`
      : `Updated product details for ${updated.name} (${updated.sku})`;

    logAuditEvent(req, 'UPDATE_PRODUCT_SKU', 'PRODUCTS', changeMsg);
    res.json(products[idx]);
  } catch (err: any) {
    console.error('Error updating product in database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const prod = products.find((p) => p.id === id);
    products = products.filter((p) => p.id !== id);
    inventoryStock = inventoryStock.filter((s) => s.productId !== id);

    if (isPgConnected) {
      await pgPool.query('DELETE FROM products WHERE id = $1;', [id]);
    }
    logAuditEvent(req, 'DELETE_PRODUCT', 'PRODUCTS', `Deleted product ${prod?.name || id} (SKU: ${prod?.sku || 'N/A'})`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting product from database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Categories API
app.get('/api/categories', async (req, res) => {
  if (isPgConnected) {
    try {
      const { rows } = await pgPool.query('SELECT id, name, code, description FROM categories ORDER BY name ASC');
      return res.json(rows);
    } catch (err: any) {
      console.warn('Database note on GET /api/categories:', err?.message || err);
    }
  }
  res.json(categories);
});

app.post('/api/categories', async (req, res) => {
  try {
    const newCat: Category = {
      id: req.body.id || `cat-${Date.now()}`,
      name: req.body.name || 'New Category',
      code: req.body.code || `CAT-${Date.now().toString().slice(-4)}`,
      description: req.body.description || '',
    };
    const existingIdx = categories.findIndex((c) => c.id === newCat.id || c.name.toLowerCase() === newCat.name.toLowerCase());
    if (existingIdx !== -1) {
      categories[existingIdx] = newCat;
    } else {
      categories.push(newCat);
    }

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO categories (id, name, code, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           description = EXCLUDED.description;`,
        [newCat.id, newCat.name, newCat.code, newCat.description]
      );
    }
    logAuditEvent(req, 'CREATE_CATEGORY', 'CATEGORIES', `Created category ${newCat.name} (${newCat.code})`);
    res.status(201).json(newCat);
  } catch (err: any) {
    console.error('Error creating category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = categories.findIndex((c) => c.id === id);
    if (idx !== -1) {
      categories[idx] = { ...categories[idx], ...req.body };
    }
    const updated = categories[idx] || { id, ...req.body };

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE categories SET name = $1, code = $2, description = $3 WHERE id = $4;`,
        [updated.name, updated.code, updated.description, id]
      );
    }
    logAuditEvent(req, 'UPDATE_CATEGORY', 'CATEGORIES', `Updated category ${updated.name}`);
    res.json(updated);
  } catch (err: any) {
    console.error('Error updating category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cat = categories.find((c) => c.id === id);
    categories = categories.filter((c) => c.id !== id);

    if (isPgConnected) {
      await pgPool.query('DELETE FROM categories WHERE id = $1;', [id]);
    }
    logAuditEvent(req, 'DELETE_CATEGORY', 'CATEGORIES', `Deleted category ${cat?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Stock
app.get('/api/stock', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      let sql = `SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel", last_updated AS "lastUpdated" FROM inventory_stock`;
      const params: any[] = [];
      if (branchId && branchId !== 'ALL') {
        sql += ` WHERE branch_id = $1`;
        params.push(branchId);
      }
      sql += ` ORDER BY branch_id, product_id`;
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching stock from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(inventoryStock.filter((s) => s.branchId === branchId));
  }
  res.json(inventoryStock);
});

app.patch('/api/stock/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantityOnHand, minReorderLevel, damagedQty, reason, changeType } = req.body;
    let stk = inventoryStock.find((s) => s.id === id);

    if (isPgConnected && !stk) {
      const r = await pgPool.query(
        'SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock WHERE id = $1',
        [id]
      );
      if (r.rows.length > 0) stk = r.rows[0];
    }
    if (!stk) return res.status(404).json({ message: 'Stock record not found' });

    let qtyBefore = stk.quantityOnHand || 0;
    let oldDamaged = stk.damagedQty || 0;

    if (damagedQty !== undefined) {
      const newDam = Math.max(0, Number(damagedQty));
      const damDiff = newDam - oldDamaged;
      stk.damagedQty = newDam;

      if (quantityOnHand === undefined) {
        stk.quantityOnHand = Math.max(0, (stk.quantityOnHand || 0) - damDiff);
      } else {
        stk.quantityOnHand = Number(quantityOnHand);
      }
    } else if (quantityOnHand !== undefined) {
      stk.quantityOnHand = Number(quantityOnHand);
    }
    if (minReorderLevel !== undefined) {
      stk.minReorderLevel = Number(minReorderLevel);
    }
    stk.lastUpdated = new Date().toISOString();

    const prod = products.find((p) => p.id === stk.productId);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           quantity_on_hand = EXCLUDED.quantity_on_hand,
           damaged_qty = EXCLUDED.damaged_qty,
           min_reorder_level = EXCLUDED.min_reorder_level,
           last_updated = NOW();`,
        [stk.id, stk.productId, stk.branchId, stk.quantityOnHand || 0, stk.damagedQty || 0, stk.reservedQty || 0, stk.incomingQty || 0, stk.minReorderLevel || 5]
      );
    }

    const isDamageChange = changeType === 'DAMAGE' || (damagedQty !== undefined && stk.damagedQty !== oldDamaged);

    if (isDamageChange) {
      const damDiff = (stk.damagedQty || 0) - oldDamaged;
      const newTxn = {
        id: `txn-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
        transactionNumber: `TXN-DMG-${Math.floor(10000 + Math.random() * 90000)}`,
        productId: stk.productId,
        productSku: prod?.sku || '',
        productName: prod?.name || '',
        branchId: stk.branchId,
        changeType: 'DAMAGE' as const,
        quantityBefore: oldDamaged,
        quantityChanged: damDiff !== 0 ? -Math.abs(damDiff) : -(stk.damagedQty || 1),
        quantityAfter: stk.damagedQty || 0,
        unitCost: prod?.costPrice || 0,
        referenceDocId: reason || 'DMG-VERIFICATION',
        timestampAD: new Date().toISOString(),
        timestampBS: '2083-04-16 BS',
      };
      transactionLogs.unshift(newTxn);

      if (isPgConnected) {
        await pgPool.query(
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
          [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
        );
      }
    } else if (quantityOnHand !== undefined && (stk.quantityOnHand - qtyBefore !== 0)) {
      const newTxn: TransactionLog = {
        id: `txn-${Date.now()}`,
        transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
        productId: stk.productId,
        productSku: prod?.sku || '',
        productName: prod?.name || '',
        branchId: stk.branchId,
        changeType: 'MANUAL_ADJUSTMENT' as const,
        quantityBefore: qtyBefore,
        quantityChanged: stk.quantityOnHand - qtyBefore,
        quantityAfter: stk.quantityOnHand,
        unitCost: prod?.costPrice || 0,
        referenceDocId: reason || 'STOCK_ADJUSTMENT',
        timestampAD: new Date().toISOString(),
        timestampBS: '2083-04-16 BS',
      };
      transactionLogs.unshift(newTxn);

      if (isPgConnected) {
        await pgPool.query(
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
          [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
        );
      }
    }
    res.json(stk);
  } catch (err: any) {
    console.error('Error updating stock level:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.patch('/api/stock/:id/reorder-level', async (req, res) => {
  try {
    const { id } = req.params;
    const { minReorderLevel, productId, branchId } = req.body;
    let stk = inventoryStock.find((s) => s.id === id);

    if (!stk && (productId || req.body.productId) && (branchId || req.body.branchId)) {
      const pId = productId || req.body.productId;
      const bId = branchId || req.body.branchId;
      stk = inventoryStock.find((s) => s.productId === pId && s.branchId === bId);
    }

    if (!stk) {
      let pId = productId || req.body.productId;
      let bId = branchId || req.body.branchId;

      if (!pId || !bId) {
        const parts = id.split('-');
        if (parts.length >= 3) {
          if (products.some((p) => p.id === parts[1])) {
            pId = parts[1];
            bId = parts[2];
          } else if (branches.some((b) => b.id === parts[2])) {
            pId = parts[1];
            bId = parts[2];
          }
        }
      }

      if (!pId) pId = products[0]?.id;
      if (!bId) bId = branches[0]?.id;

      if (pId && bId) {
        stk = {
          id: id.startsWith('stk-') ? id : `stk-${bId.toLowerCase()}-${pId}`,
          productId: pId,
          branchId: bId,
          quantityOnHand: 0,
          damagedQty: 0,
          reservedQty: 0,
          incomingQty: 0,
          minReorderLevel: Number(minReorderLevel) || 5,
          lastUpdated: new Date().toISOString(),
        };
        inventoryStock.push(stk);
      }
    }

    if (!stk) {
      return res.status(404).json({ message: 'Stock record not found' });
    }

    stk.minReorderLevel = Number(minReorderLevel);
    stk.lastUpdated = new Date().toISOString();

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET min_reorder_level = $8`,
        [
          stk.id,
          stk.productId,
          stk.branchId,
          stk.quantityOnHand || 0,
          stk.damagedQty || 0,
          stk.reservedQty || 0,
          stk.incomingQty || 0,
          stk.minReorderLevel,
        ]
      );
    }
    broadcastChange({ type: 'STOCK_UPDATED', entity: 'stock', branchId: stk.branchId });
    res.json(stk);
  } catch (err: any) {
    console.error('Error setting reorder level:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/stock/bulk-reorder-levels', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER'), async (req, res) => {
  try {
    const { updates } = req.body;
    if (Array.isArray(updates)) {
      if (isPgConnected) {
        await withTransaction(async (client) => {
          for (const u of updates) {
            let stk = inventoryStock.find((s) => s.id === u.stockId);
            if (!stk && u.productId && u.branchId) {
              stk = inventoryStock.find((s) => s.productId === u.productId && s.branchId === u.branchId);
            }
            if (!stk && u.productId && u.branchId) {
              stk = {
                id: u.stockId || `stk-${u.branchId.toLowerCase()}-${u.productId}`,
                productId: u.productId,
                branchId: u.branchId,
                quantityOnHand: 0,
                damagedQty: 0,
                reservedQty: 0,
                incomingQty: 0,
                minReorderLevel: Number(u.minReorderLevel),
                lastUpdated: new Date().toISOString(),
              };
              inventoryStock.push(stk);
            }
            if (stk) {
              stk.minReorderLevel = Number(u.minReorderLevel);
              stk.lastUpdated = new Date().toISOString();

              await client.query(
                `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO UPDATE SET min_reorder_level = $8`,
                [
                  stk.id,
                  stk.productId,
                  stk.branchId,
                  stk.quantityOnHand || 0,
                  stk.damagedQty || 0,
                  stk.reservedQty || 0,
                  stk.incomingQty || 0,
                  stk.minReorderLevel,
                ]
              );
            }
          }

        });
      } else {
        for (const u of updates) {
          let stk = inventoryStock.find((s) => s.id === u.stockId);
          if (!stk && u.productId && u.branchId) {
            stk = inventoryStock.find((s) => s.productId === u.productId && s.branchId === u.branchId);
          }
          if (stk) {
            stk.minReorderLevel = Number(u.minReorderLevel);
            stk.lastUpdated = new Date().toISOString();
          }
        }
      }
      broadcastChange({ type: 'STOCK_UPDATED', entity: 'stock' });
    }
    res.json({ success: true, count: updates?.length || 0 });
  } catch (err: any) {
    console.error('Error bulk updating reorder levels:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Physical Stock Audit Direct Reconciliation
app.post('/api/stock/reconcile-audit', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'AUDITOR'), async (req, res) => {
  try {
    const { branchId, auditRefNumber, varianceItems, auditorName, userEmail, notes } = req.body;
    if (!branchId || !Array.isArray(varianceItems)) {
      return res.status(400).json({ message: 'Invalid stock reconciliation payload' });
    }

    let totalAdjusted = 0;
    let netFinancialImpact = 0;

    if (isPgConnected) {
      await withTransaction(async (client) => {
        for (const item of varianceItems) {
          let stk = inventoryStock.find(
            (s) => s.productId === item.productId && s.branchId === branchId
          );

          if (!stk) {
            stk = {
              id: `stk-${branchId.toLowerCase()}-${item.productId}`,
              productId: item.productId,
              branchId: branchId,
              quantityOnHand: 0,
              damagedQty: 0,
              reservedQty: 0,
              incomingQty: 0,
              lastUpdated: new Date().toISOString(),
            };
            inventoryStock.push(stk);
          }

          const qtyBefore = stk.quantityOnHand || 0;
          const targetCounted = Number(item.countedQty) || 0;
          const delta = targetCounted - qtyBefore;
          const unitCost = item.unitCost || 0;

          stk.quantityOnHand = targetCounted;
          stk.lastUpdated = new Date().toISOString();
          totalAdjusted += 1;
          netFinancialImpact += delta * unitCost;

          const prod = products.find((p) => p.id === item.productId);

          await client.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand;`,
            [stk.id, stk.productId, stk.branchId, stk.quantityOnHand, stk.damagedQty || 0, stk.reservedQty || 0, stk.incomingQty || 0]
          );

          const newTxn: TransactionLog = {
            id: `txn-${Date.now()}-${item.productId}-aud`,
            transactionNumber: `TXN-AUD-${Math.floor(10000 + Math.random() * 90000)}`,
            productId: item.productId,
            productSku: prod?.sku || item.sku || '',
            productName: prod?.name || item.productName || '',
            branchId: branchId,
            changeType: (delta > 0 ? 'PHYSICAL_AUDIT_EXCESS' : 'PHYSICAL_AUDIT_SHORTAGE') as TransactionLog['changeType'],
            quantityBefore: qtyBefore,
            quantityChanged: delta,
            quantityAfter: stk.quantityOnHand,
            unitCost: unitCost || prod?.costPrice || 0,
            referenceDocId: auditRefNumber || `AUDIT-${Date.now()}`,
            timestampAD: new Date().toISOString(),
            timestampBS: '2083-04-22 BS',
          };
          transactionLogs.unshift(newTxn);

          await client.query(
            `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
            [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
          );
        }
      });
    } else {
      for (const item of varianceItems) {
        let stk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === branchId);
        if (stk) {
          const qtyBefore = stk.quantityOnHand || 0;
          const targetCounted = Number(item.countedQty) || 0;
          const delta = targetCounted - qtyBefore;
          stk.quantityOnHand = targetCounted;
          stk.lastUpdated = new Date().toISOString();
          totalAdjusted += 1;
          netFinancialImpact += delta * (item.unitCost || 0);
        }
      }
    }

    const branch = branches.find((b) => b.id === branchId);

    logAuditEvent(
      req,
      'STOCK_AUDIT_RECONCILED',
      'INVENTORY_AUDIT',
      `Directly Authorized & Reconciled Physical Stock Audit #${auditRefNumber || 'DIRECT'} for ${branch?.name || branchId}. Adjusted ${totalAdjusted} variance items to physical count. Net Financial Impact: NPR ${netFinancialImpact.toLocaleString()}. Notes: ${notes || 'Direct Stock Reconcile'}`,
      branchId
    );
    res.json({
      success: true,
      totalAdjusted,
      netFinancialImpact,
      message: `Physical stock reconciled successfully for ${branch?.name || branchId}`,
    });
  } catch (err: any) {
    console.error('Error reconciling stock audit:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Fixed Assets
app.get('/api/assets', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q =
        'SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAd", acquisition_date_bs AS "acquisitionDateBs", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo", purchase_invoice_id AS "purchaseInvoiceId", product_id AS "productId" FROM fixed_assets' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching assets from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(assetRegister.filter((a) => a.branchId === branchId));
  }
  res.json(assetRegister);
});

app.post('/api/assets', async (req, res) => {
  try {
    const tagNum = req.body.tagNumber || req.body.assetTag || `AST-${Math.floor(1000 + Math.random() * 9000)}`;
    const newAsset = {
      id: req.body.id || `ast-${Date.now()}`,
      tagNumber: tagNum,
      name: req.body.name || 'Fixed Asset',
      category: req.body.category || 'Equipment',
      branchId: req.body.branchId || 'WH001',
      acquisitionDateAd: req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      acquisitionDateBs: req.body.acquisitionDateBS || req.body.acquisitionDateBs || '2083-04-10 BS',
      acquisitionCost: Number(req.body.acquisitionCost) || 0,
      depreciationMethod: req.body.depreciationMethod || 'STRAIGHT_LINE',
      depreciationRatePercent: Number(req.body.depreciationRatePercent || req.body.depreciationRate) || 15,
      accumulatedDepreciation: Number(req.body.accumulatedDepreciation) || 0,
      netBookValue: Number(req.body.netBookValue ?? req.body.acquisitionCost) || 0,
      status: req.body.status || 'ACTIVE',
      supplierName: req.body.supplierName || '',
      invoiceNo: req.body.invoiceNo || '',
      purchaseInvoiceId: req.body.purchaseInvoiceId || null,
      productId: req.body.productId || null,
    };
    const idx = assetRegister.findIndex((a) => a.id === newAsset.id);
    if (idx >= 0) assetRegister[idx] = newAsset as any;
    else assetRegister.unshift(newAsset as any);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO fixed_assets (
           id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, acquisition_cost, depreciation_method, depreciation_rate_percent, accumulated_depreciation, net_book_value, status, supplier_name, invoice_no, purchase_invoice_id, product_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           tag_number = EXCLUDED.tag_number,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           branch_id = EXCLUDED.branch_id,
           acquisition_cost = EXCLUDED.acquisition_cost,
           net_book_value = EXCLUDED.net_book_value,
           status = EXCLUDED.status;`,
        [
          newAsset.id,
          newAsset.tagNumber,
          newAsset.name,
          newAsset.category,
          newAsset.branchId,
          newAsset.acquisitionDateAd,
          newAsset.acquisitionDateBs,
          newAsset.acquisitionCost,
          newAsset.depreciationMethod,
          newAsset.depreciationRatePercent,
          newAsset.accumulatedDepreciation,
          newAsset.netBookValue,
          newAsset.status,
          newAsset.supplierName,
          newAsset.invoiceNo,
          newAsset.purchaseInvoiceId,
          newAsset.productId,
        ]
      );
    }
    logAuditEvent(req, 'ASSIGN_FIXED_ASSET', 'FIXED_ASSETS', `Assigned / Registered Fixed Asset Tag #${newAsset.tagNumber} (${newAsset.name}) at branch ${newAsset.branchId}`);
    res.status(201).json(newAsset);
  } catch (err: any) {
    console.error('Error creating fixed asset:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.patch('/api/assets/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const asset = assetRegister.find((a) => a.id === id);
    if (asset) Object.assign(asset, req.body);

    if (isPgConnected) {
      await pgPool.query('UPDATE fixed_assets SET status = $1 WHERE id = $2', [req.body.status || 'ACTIVE', id]);
    }
    logAuditEvent(req, 'UPDATE_ASSET_STATUS', 'FIXED_ASSETS', `Updated Fixed Asset status to ${req.body.status || 'UPDATED'}`);
    res.json(asset || req.body);
  } catch (err: any) {
    console.error('Error updating asset status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Purchase Orders
app.get('/api/purchase-orders', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q =
        'SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS", expected_delivery_date_ad AS "expectedDeliveryDateAD", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching POs from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(purchaseOrders.filter((po) => po.branchId === branchId));
  }
  res.json(purchaseOrders);
});

app.post('/api/purchase-orders', async (req, res) => {
  try {
    const items = req.body.items || [];
    const subtotalAmount = items.reduce((s: number, i: any) => s + (i.subtotal || (i.quantity * (i.unitPrice || 0))), 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.taxAmount || 0), 0);
    const totalAmount = subtotalAmount + taxAmount;

    const newPO = {
      id: req.body.id || `po-${Date.now()}`,
      poNumber: req.body.poNumber || generateStandardTransactionId(req.body.branchId || 'WH001', 'PO'),
      subtotalAmount,
      taxAmount,
      totalAmount,
      orderDateAd: req.body.orderDateAD || req.body.orderDateAd || new Date().toISOString().split('T')[0],
      orderDateBs: req.body.orderDateBS || req.body.orderDateBs || '2083-04-10 BS',
      ...req.body,
    };

    const idx = purchaseOrders.findIndex((p) => p.id === newPO.id);
    if (idx >= 0) purchaseOrders[idx] = newPO;
    else purchaseOrders.unshift(newPO);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO purchase_orders (
           id, po_number, supplier_name, branch_id, order_date_ad, order_date_bs, expected_delivery_date_ad, status, subtotal_amount, tax_amount, total_amount, notes, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           subtotal_amount = EXCLUDED.subtotal_amount,
           tax_amount = EXCLUDED.tax_amount,
           total_amount = EXCLUDED.total_amount,
           notes = EXCLUDED.notes,
           items = EXCLUDED.items;`,
        [
          newPO.id,
          newPO.poNumber,
          newPO.supplierName || 'Vendor',
          newPO.branchId || 'WH001',
          newPO.orderDateAd,
          newPO.orderDateBs,
          newPO.expectedDeliveryDateAD || newPO.expectedDeliveryDateAd || null,
          newPO.status || 'DRAFT',
          newPO.subtotalAmount,
          newPO.taxAmount,
          newPO.totalAmount,
          newPO.notes || '',
          JSON.stringify(items),
        ]
      );

      if (newPO.branchId && Array.isArray(items)) {
        for (const item of items) {
          await pgPool.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
             VALUES ($1, $2, $3, 0, $4)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               incoming_qty = inventory_stock.incoming_qty + EXCLUDED.incoming_qty,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${newPO.branchId.toLowerCase()}-${item.productId}`, item.productId, newPO.branchId, Number(item.quantity) || 0]
          );
        }
      }
    }

    if (newPO.branchId && Array.isArray(items)) {
      items.forEach((item: any) => {
        let stk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === newPO.branchId);
        if (stk) {
          stk.incomingQty = (stk.incomingQty || 0) + (Number(item.quantity) || 0);
          stk.lastUpdated = new Date().toISOString();
        }
      });
    }
    logAuditEvent(req, 'CREATE_PURCHASE_ORDER', 'PROCUREMENT', `Created Purchase Order #${newPO.poNumber} for supplier ${newPO.supplierName || 'Vendor'}`);
    res.status(201).json(newPO);
  } catch (err: any) {
    console.error('Error creating purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/purchase-orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const index = purchaseOrders.findIndex((p) => p.id === id);
    const existingPO = purchaseOrders[index];

    const items = req.body.items || existingPO?.items || [];
    const subtotalAmount = items.reduce((s: number, i: any) => s + (i.subtotal || (i.quantity * i.unitPrice)), 0);
    const taxAmount = items.reduce((s: number, i: any) => s + (i.taxAmount || 0), 0);
    const totalAmount = subtotalAmount + taxAmount;

    const updatedPO = {
      ...(existingPO || {}),
      ...req.body,
      subtotalAmount,
      taxAmount,
      totalAmount,
      items,
    };
    if (index >= 0) purchaseOrders[index] = updatedPO;

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE purchase_orders SET
           supplier_name = $1, branch_id = $2, status = $3, subtotal_amount = $4, tax_amount = $5, total_amount = $6, notes = $7, items = $8
         WHERE id = $9;`,
        [
          updatedPO.supplierName,
          updatedPO.branchId,
          updatedPO.status,
          updatedPO.subtotalAmount,
          updatedPO.taxAmount,
          updatedPO.totalAmount,
          updatedPO.notes,
          JSON.stringify(items),
          id,
        ]
      );
    }
    logAuditEvent(req, 'UPDATE_PURCHASE_ORDER', 'PROCUREMENT', `Updated Purchase Order #${updatedPO.poNumber}`);
    res.json(updatedPO);
  } catch (err: any) {
    console.error('Error updating purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/purchase-orders/:id', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER'), async (req, res) => {
  try {
    const { id } = req.params;
    let po: any = purchaseOrders.find((entry) => entry.id === id);
    if (isPgConnected && !po) {
      const result = await pgPool.query('SELECT id, po_number AS "poNumber", status, items, branch_id AS "branchId" FROM purchase_orders WHERE id = $1', [id]);
      po = result.rows[0];
    }
    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });
    if (['RECEIVED', 'IN_PROGRESS'].includes(po.status)) {
      return res.status(409).json({ message: 'Received or in-progress purchase orders cannot be deleted.' });
    }

    const linkedInvoice = purchaseInvoices.some((invoice) => invoice.poReferenceId === po.id || invoice.poReferenceId === po.poNumber);
    if (linkedInvoice) return res.status(409).json({ message: 'Delete the linked Purchase Invoice before deleting this Purchase Order.' });

    const items = typeof po.items === 'string' ? JSON.parse(po.items) : (po.items || []);
    if (isPgConnected) {
      await withTransaction(async (client) => {
        for (const item of items) {
          await client.query(
            `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP
             WHERE product_id = $2 AND branch_id = $3`,
            [Number(item.quantity) || 0, item.productId, po.branchId]
          );
        }
        await client.query('DELETE FROM purchase_orders WHERE id = $1', [id]);
      });
    }

    purchaseOrders = purchaseOrders.filter((entry) => entry.id !== id);
    inventoryStock.forEach((stock) => {
      if (stock.branchId !== po.branchId) return;
      const item = items.find((entry: any) => entry.productId === stock.productId);
      if (item) stock.incomingQty = Math.max(0, (stock.incomingQty || 0) - (Number(item.quantity) || 0));
    });
    logAuditEvent(req, 'DELETE_PURCHASE_ORDER', 'PROCUREMENT', `Deleted Purchase Order #${po.poNumber}`);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Error deleting purchase order:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.patch('/api/purchase-orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const po = purchaseOrders.find((p) => p.id === id);
    if (po) po.status = status;

    if (isPgConnected) {
      await pgPool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', [status, id]);
    }
    logAuditEvent(req, 'UPDATE_PO_STATUS', 'PROCUREMENT', `Changed Purchase Order status to ${status}`);
    res.json(po || req.body);
  } catch (err: any) {
    console.error('Error updating PO status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/purchase-orders/:id/receive', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'PROCUREMENT_OFFICER'), async (req, res) => {
  try {
    const { id } = req.params;
    let po = purchaseOrders.find((p) => p.id === id);

    if (isPgConnected) {
      const r = await pgPool.query('SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", status, items FROM purchase_orders WHERE id = $1', [id]);
      if (r.rows.length > 0) po = r.rows[0];
    }
    if (!po) return res.status(404).json({ message: 'PO not found' });

    po.status = 'RECEIVED';

    if (isPgConnected) {
      await withTransaction(async (client) => {
        await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', ['RECEIVED', id]);

        const items = typeof po.items === 'string' ? JSON.parse(po.items) : (po.items || []);
        for (const item of items) {
          await client.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               incoming_qty = GREATEST(0, inventory_stock.incoming_qty - $4),
               quantity_on_hand = inventory_stock.quantity_on_hand + $4,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${po.branchId.toLowerCase()}-${item.productId}`, item.productId, po.branchId, Number(item.quantity) || 0]
          );

          const txnId = `txn-${Date.now()}-${item.productId}`;
          const txnNum = `TXN-${Math.floor(10000 + Math.random() * 90000)}`;
          await client.query(
            `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_bs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11)`,
            [txnId, txnNum, item.productId, item.sku || '', item.productName || '', po.branchId, 'INBOUND_PO', Number(item.quantity) || 0, item.unitPrice || 0, po.poNumber, '2083-04-16 BS']
          );
        }
      });
    }

    if (po.items && Array.isArray(po.items)) {
      po.items.forEach((item: any) => {
        let stk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === po.branchId);
        if (stk) {
          stk.incomingQty = Math.max(0, (stk.incomingQty || 0) - item.quantity);
          stk.quantityOnHand += item.quantity;
          stk.lastUpdated = new Date().toISOString();
        }
      });
    }
    logAuditEvent(req, 'RECEIVE_PURCHASE_ORDER', 'PROCUREMENT', `Received goods for Purchase Order #${po.poNumber}`);
    res.json(po);
  } catch (err: any) {
    console.error('Error receiving PO:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Purchase Invoices
app.get('/api/purchase-invoices', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q =
        'SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", amount_paid AS "amountPaid", items FROM purchase_invoices' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching purchase invoices from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(purchaseInvoices.filter((inv) => inv.branchId === branchId));
  }
  res.json(purchaseInvoices);
});

app.post('/api/purchase-invoices', async (req, res) => {
  try {
    const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
    const newInv = {
      id: req.body.id || `inv-${Date.now()}`,
      invoiceNumber: req.body.invoiceNumber || generateStandardTransactionId(targetBranchId, 'PI'),
      invoiceDateAD: req.body.invoiceDateAD || req.body.invoiceDateAd || new Date().toISOString().split('T')[0],
      invoiceDateBS: req.body.invoiceDateBS || req.body.invoiceDateBs || '2083-04-10 BS',
      ...req.body,
    };
    const items = req.body.items || req.body.lines || [];
    const poReference = newInv.poReferenceId || req.body.poId;
    if (poReference) {
      let linkedPO = purchaseOrders.find((po) => po.id === poReference || po.poNumber === poReference);
      if (!linkedPO && isPgConnected) {
        const poResult = await pgPool.query(
          'SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", status, items FROM purchase_orders WHERE id = $1 OR po_number = $1 LIMIT 1',
          [poReference]
        );
        linkedPO = poResult.rows[0];
        if (linkedPO && typeof linkedPO.items === 'string') linkedPO.items = JSON.parse(linkedPO.items);
      }
      if (!linkedPO) return res.status(400).json({ message: 'The selected Purchase Order was not found.' });

      const poItems = new Map(linkedPO.items.map((item) => [item.productId, item]));
      const invoiceItems = new Map(items.map((item: any) => [item.productId, item]));
      const exceeding = items.find((item: any) => Number(item.quantity) > Number(poItems.get(item.productId)?.quantity || 0));
      const quantityMismatch = items.find((item: any) => Number(item.quantity) !== Number(poItems.get(item.productId)?.quantity || 0));
      const missing = linkedPO.items.find((item) => !invoiceItems.has(item.productId));
      const extra = items.find((item: any) => !poItems.has(item.productId));
      const typeMismatch = items.find((item: any) => {
        const poItem = poItems.get(item.productId);
        const product = products.find((entry) => entry.id === item.productId);
        return poItem && (item.productGroup || product?.productGroup) !== (poItem.productGroup || product?.productGroup);
      });
      if (exceeding) return res.status(400).json({ message: `Quantity exceeding PO for ${exceeding.productName || exceeding.productId}. Ordered quantity: ${poItems.get(exceeding.productId)?.quantity || 0}.` });
      if (missing) return res.status(400).json({ message: `PO product missing from vendor bill: ${missing.productName}.` });
      if (extra) return res.status(400).json({ message: `Product not present in selected Purchase Order: ${extra.productName || extra.productId}.` });
      if (typeMismatch) return res.status(400).json({ message: `Product type does not match the selected Purchase Order: ${typeMismatch.productName || typeMismatch.productId}.` });
      if (quantityMismatch) return res.status(400).json({ message: `Quantity must match the selected Purchase Order for ${quantityMismatch.productName || quantityMismatch.productId}.` });
      if (invoiceItems.size !== poItems.size) return res.status(400).json({ message: 'Purchase Order and vendor bill products must match exactly.' });
    }

    const idx = purchaseInvoices.findIndex((i) => i.id === newInv.id);
    if (idx >= 0) purchaseInvoices[idx] = newInv;
    else purchaseInvoices.unshift(newInv);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO purchase_invoices (
           id, invoice_number, po_reference_id, vendor_bill_number, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, due_date_ad, due_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total, payment_status, amount_paid, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           payment_status = EXCLUDED.payment_status,
           amount_paid = EXCLUDED.amount_paid;`,
        [
          newInv.id,
          newInv.invoiceNumber,
          newInv.poReferenceId || newInv.poId || null,
          newInv.vendorBillNumber || null,
          newInv.supplierName || 'Vendor',
          targetBranchId,
          newInv.invoiceDateAD,
          newInv.invoiceDateBS,
          newInv.dueDateAD || newInv.dueDateAd || null,
          newInv.dueDateBS || newInv.dueDateBs || null,
          Number(newInv.taxableAmount) || 0,
          Number(newInv.vatAmount) || 0,
          Number(newInv.nonTaxableAmount) || 0,
          Number(newInv.grandTotal) || 0,
          newInv.paymentStatus || 'UNPAID',
          Number(newInv.amountPaid) || 0,
          JSON.stringify(items),
        ]
      );

      for (const item of items) {
        const qtyToAdd = Number(item.quantity) || 0;
        await pgPool.query(
          `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, min_reorder_level)
           VALUES ($1, $2, $3, $4, 5)
           ON CONFLICT (product_id, branch_id) DO UPDATE SET
             quantity_on_hand = inventory_stock.quantity_on_hand + $4,
             last_updated = CURRENT_TIMESTAMP;`,
          [`stk-${targetBranchId.toLowerCase()}-${item.productId}`, item.productId, targetBranchId, qtyToAdd]
        );

        await pgPool.query(
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11)`,
          [`txn-${Date.now()}-${item.productId}`, `TXN-${Math.floor(10000 + Math.random() * 90000)}`, item.productId, item.sku || '', item.productName || 'Product', targetBranchId, 'PURCHASE_INVOICE', qtyToAdd, Number(item.unitPrice) || 0, newInv.invoiceNumber, '2083-04-16 BS']
        );
      }

      const poRef = newInv.poReferenceId || req.body.poId;
      if (poRef) {
        await pgPool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 OR po_number = $2', ['RECEIVED', poRef]);
      }
    }

    items.forEach((item: any) => {
      let stk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === targetBranchId);
      if (!stk) {
        stk = {
          id: `stk-${targetBranchId.toLowerCase()}-${item.productId}`,
          productId: item.productId,
          branchId: targetBranchId,
          quantityOnHand: 0,
          damagedQty: 0,
          reservedQty: 0,
          incomingQty: 0,
          minReorderLevel: 5,
          lastUpdated: new Date().toISOString(),
        };
        inventoryStock.push(stk);
      }
      stk.quantityOnHand += Number(item.quantity) || 0;
      stk.lastUpdated = new Date().toISOString();
    });
    logAuditEvent(req, 'CREATE_PURCHASE_INVOICE', 'PROCUREMENT', `Created Purchase Invoice #${newInv.invoiceNumber}`);
    res.status(201).json(newInv);
  } catch (err: any) {
    console.error('Error creating purchase invoice:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/purchase-invoices/:id', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'ACCOUNTANT', 'PROCUREMENT_OFFICER'), async (req, res) => {
  try {
    const { id } = req.params;
    let invoice: any = purchaseInvoices.find((entry) => entry.id === id);
    if (isPgConnected && !invoice) {
      const result = await pgPool.query('SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", branch_id AS "branchId", items FROM purchase_invoices WHERE id = $1', [id]);
      invoice = result.rows[0];
    }
    if (!invoice) return res.status(404).json({ message: 'Purchase Invoice not found' });

    const items = typeof invoice.items === 'string' ? JSON.parse(invoice.items) : (invoice.items || []);
    const quantities = new Map<string, number>();
    const serials = items.flatMap((item: any) => (item.deviceSerials || []).map((serial: any) => serial.deviceSerial).filter(Boolean));
    items.forEach((item: any) => quantities.set(item.productId, (quantities.get(item.productId) || 0) + (Number(item.quantity) || 0)));

    const purchaseRefs = [invoice.vendorBillNumber, invoice.invoiceNumber].filter(Boolean);
    const localAssignedSerial = customerDeviceRecords.some(
      (record) => serials.includes(record.deviceSerial) && purchaseRefs.includes(record.purchaseBillRef || '') && record.status !== 'IN_STOCK'
    );
    if (localAssignedSerial) return res.status(409).json({ message: 'This invoice has serial devices that are already assigned or consumed and cannot be deleted.' });

    if (isPgConnected) {
      await withTransaction(async (client) => {
        if (serials.length > 0 && purchaseRefs.length > 0) {
          const assigned = await client.query(
            `SELECT 1 FROM customer_device_records
             WHERE device_serial = ANY($1::text[]) AND purchase_bill_ref = ANY($2::text[]) AND status <> 'IN_STOCK' LIMIT 1`,
            [serials, purchaseRefs]
          );
          if (assigned.rowCount) throw new Error('This invoice has serial devices that are already assigned or consumed and cannot be deleted.');
        }
        for (const [productId, quantity] of quantities) {
          const updated = await client.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
             WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1`,
            [quantity, productId, invoice.branchId]
          );
          if (updated.rowCount !== 1) throw new Error(`Insufficient stock to reverse invoice item ${productId}.`);
        }
        if (serials.length > 0 && purchaseRefs.length > 0) {
          await client.query(
            `DELETE FROM customer_device_records
             WHERE device_serial = ANY($1::text[]) AND purchase_bill_ref = ANY($2::text[]) AND status = 'IN_STOCK'`,
            [serials, purchaseRefs]
          );
        }
        await client.query('DELETE FROM purchase_invoices WHERE id = $1', [id]);
        if (invoice.poReferenceId) {
          await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 OR po_number = $2', ['APPROVED', invoice.poReferenceId]);
        }
      });
    }

    purchaseInvoices = purchaseInvoices.filter((entry) => entry.id !== id);
    inventoryStock.forEach((stock) => {
      if (stock.branchId !== invoice.branchId) return;
      const quantity = quantities.get(stock.productId);
      if (quantity) stock.quantityOnHand = Math.max(0, stock.quantityOnHand - quantity);
    });
    customerDeviceRecords = customerDeviceRecords.filter(
      (record) => !(serials.includes(record.deviceSerial) && purchaseRefs.includes(record.purchaseBillRef || '') && record.status === 'IN_STOCK')
    );
    const linkedPO = purchaseOrders.find((entry) => entry.id === invoice.poReferenceId || entry.poNumber === invoice.poReferenceId);
    if (linkedPO) linkedPO.status = 'APPROVED';
    logAuditEvent(req, 'DELETE_PURCHASE_INVOICE', 'PROCUREMENT', `Deleted Purchase Invoice #${invoice.invoiceNumber} and reversed its stock`);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Error deleting purchase invoice:', err);
    res.status(409).json({ message: err.message || 'Unable to delete purchase invoice.' });
  }
});

app.post('/api/purchase-invoices/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const inv = purchaseInvoices.find((i) => i.id === id);
    if (inv) {
      inv.amountPaid += Number(amount);
      inv.paymentStatus = inv.amountPaid >= inv.grandTotal ? 'PAID' : 'PARTIAL';
    }

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE purchase_invoices SET
           amount_paid = amount_paid + $1,
           payment_status = CASE WHEN (amount_paid + $1) >= grand_total THEN 'PAID' ELSE 'PARTIAL' END
         WHERE id = $2;`,
        [Number(amount), id]
      );
    }
    logAuditEvent(req, 'RECORD_INVOICE_PAYMENT', 'PROCUREMENT', `Recorded payment of NPR ${Number(amount).toLocaleString()} for Invoice`);
    res.json(inv || { message: 'Payment recorded' });
  } catch (err: any) {
    console.error('Error recording payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Shipments
app.get('/api/shipments', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query(
        'SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAd", dispatch_date_bs AS "dispatchDateBs", estimated_arrival_ad AS "estimatedArrivalAd", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAd", received_date_bs AS "receivedDateBs", has_discrepancy AS "hasDiscrepancy" FROM shipments ORDER BY created_at DESC'
      );
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching shipments from DB:', err);
    }
  }
  res.json(shipments);
});

app.post('/api/shipments', async (req, res) => {
  try {
    const sourceBranch = branches.find((b) => b.id === req.body.sourceBranchId);
    const destBranch = branches.find((b) => b.id === req.body.destinationBranchId);

    const newShipment = {
      id: req.body.id || `sh-${Date.now()}`,
      trackingCode: req.body.trackingCode || generateStandardTransactionId(req.body.sourceBranchId || 'WH001', 'TRF'),
      sourceBranchName: sourceBranch?.name || req.body.sourceBranchName || 'Source',
      destinationBranchName: destBranch?.name || req.body.destinationBranchName || 'Destination',
      dispatchDateAD: req.body.dispatchDateAD || req.body.dispatchDateAd || new Date().toISOString().split('T')[0],
      dispatchDateBS: req.body.dispatchDateBS || req.body.dispatchDateBs || '2083-04-10 BS',
      status: req.body.status || 'IN_TRANSIT',
      items: req.body.items || [],
      ...req.body,
    };

    const idx = shipments.findIndex((s) => s.id === newShipment.id);
    if (idx >= 0) shipments[idx] = newShipment;
    else shipments.unshift(newShipment);

    if (isPgConnected) {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO shipments (
             id, tracking_code, type, source_branch_id, source_branch_name, destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, estimated_arrival_ad, status, notes, items
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             items = EXCLUDED.items;`,
          [
            newShipment.id,
            newShipment.trackingCode,
            newShipment.type || 'INTER_BRANCH',
            newShipment.sourceBranchId,
            newShipment.sourceBranchName,
            newShipment.destinationBranchId,
            newShipment.destinationBranchName,
            newShipment.dispatchDateAD,
            newShipment.dispatchDateBS,
            newShipment.estimatedArrivalAD || newShipment.estimatedArrivalAd || null,
            newShipment.status,
            newShipment.notes || '',
            JSON.stringify(newShipment.items),
          ]
        );

        if (newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
          for (const item of newShipment.items) {
            const qtySent = Number(item.quantitySent || item.quantity || 1);
            await client.query(
              `UPDATE inventory_stock SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
              [qtySent, item.productId, newShipment.sourceBranchId]
            );

            if (newShipment.destinationBranchId) {
              await client.query(
                `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
                 VALUES ($1, $2, $3, 0, $4)
                 ON CONFLICT (product_id, branch_id) DO UPDATE SET
                   incoming_qty = inventory_stock.incoming_qty + $4,
                   last_updated = CURRENT_TIMESTAMP;`,
                [`stk-${newShipment.destinationBranchId.toLowerCase()}-${item.productId}`, item.productId, newShipment.destinationBranchId, qtySent]
              );
            }
          }
        }
      });
    }

    if (newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
      newShipment.items.forEach((item: any) => {
        const qtySent = Number(item.quantitySent || item.quantity || 1);
        let sourceStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === newShipment.sourceBranchId);
        if (sourceStk) {
          sourceStk.quantityOnHand = Math.max(0, sourceStk.quantityOnHand - qtySent);
          sourceStk.lastUpdated = new Date().toISOString();
        }
        if (newShipment.destinationBranchId) {
          let destStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === newShipment.destinationBranchId);
          if (destStk) {
            destStk.incomingQty = (destStk.incomingQty || 0) + qtySent;
            destStk.lastUpdated = new Date().toISOString();
          }
        }
      });
    }
    logAuditEvent(req, 'CREATE_SHIPMENT', 'LOGISTICS', `Created Shipment #${newShipment.trackingCode}`);
    res.status(201).json(newShipment);
  } catch (err: any) {
    console.error('Error creating shipment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/shipments/:id/receive', async (req, res) => {
  try {
    const { id } = req.params;
    const { receivedItems, receivedByNotes } = req.body || {};
    let sh = shipments.find((s) => s.id === id);
    if (!sh) return res.status(404).json({ message: 'Shipment not found' });

    let hasDiscrepancy = false;
    sh.receivedByNotes = receivedByNotes || '';
    sh.receivedDateAD = new Date().toISOString().split('T')[0];
    sh.receivedDateBS = '2083-04-16 BS';

    sh.items.forEach((item: any, idx: number) => {
      const verified = Array.isArray(receivedItems)
        ? receivedItems.find((ri: any) => ri.itemId === item.id) || receivedItems[idx]
        : null;
      const actualQtyReceived = verified !== null && verified !== undefined && verified.quantityReceived !== undefined
        ? Number(verified.quantityReceived)
        : (item.quantitySent || item.quantity || 1);

      item.quantityReceived = actualQtyReceived;
      if (actualQtyReceived < (item.quantitySent || item.quantity || 1)) hasDiscrepancy = true;
    });

    sh.hasDiscrepancy = hasDiscrepancy;
    sh.status = hasDiscrepancy ? 'DISCREPANCY' : 'RECEIVED';

    if (isPgConnected) {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE shipments SET status = $1, received_by_notes = $2, received_date_ad = CURRENT_DATE, received_date_bs = $3, has_discrepancy = $4, items = $5 WHERE id = $6`,
          [sh.status, sh.receivedByNotes, sh.receivedDateBS, hasDiscrepancy, JSON.stringify(sh.items), id]
        );

        for (const item of sh.items) {
          const actualQtyReceived = item.quantityReceived || item.quantitySent || 1;
          await client.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               incoming_qty = GREATEST(0, inventory_stock.incoming_qty - $4),
               quantity_on_hand = inventory_stock.quantity_on_hand + $4,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${sh.destinationBranchId.toLowerCase()}-${item.productId}`, item.productId, sh.destinationBranchId, actualQtyReceived]
          );
        }
      });
    }
    logAuditEvent(req, 'RECEIVE_SHIPMENT', 'LOGISTICS', `Received Shipment #${sh.trackingCode}`);
    res.json(sh);
  } catch (err: any) {
    console.error('Error receiving shipment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/shipments/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, reason } = req.body || {};

    let sh = shipments.find((s) => s.id === id || s.trackingCode === id);
    if (!sh) return res.status(404).json({ message: 'Shipment / transfer not found' });
    if (sh.status === 'RECEIVED' || sh.status === 'DELIVERED') {
      return res.status(400).json({ message: 'Transfers that have already been received cannot be cancelled.' });
    }
    if (sh.status === 'CANCELLED') {
      return res.status(400).json({ message: `Transfer ${sh.trackingCode} is already cancelled.` });
    }

    sh.status = 'CANCELLED';
    sh.notes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled by ${user?.name || 'Admin'}${reason ? ': ' + reason : ''}`;

    if (isPgConnected) {
      await pgPool.query('UPDATE shipments SET status = $1, notes = $2 WHERE id = $3 OR tracking_code = $3', ['CANCELLED', sh.notes, id]);

      for (const item of sh.items) {
        const qtySent = Number(item.quantitySent || (item as any).quantity) || 1;
        if (qtySent > 0 && sh.sourceBranchId) {
          await pgPool.query(
            `UPDATE inventory_stock SET quantity_on_hand = inventory_stock.quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
            [qtySent, item.productId, sh.sourceBranchId]
          );
        }
        if (qtySent > 0 && sh.destinationBranchId) {
          await pgPool.query(
            `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
            [qtySent, item.productId, sh.destinationBranchId]
          );
        }
      }
    }
    logAuditEvent(req, 'CANCEL_TRANSFER', 'LOGISTICS', `Cancelled transfer ${sh.trackingCode}`);
    res.json({ shipment: sh, message: `Transfer ${sh.trackingCode} cancelled successfully.` });
  } catch (err: any) {
    console.error('Error cancelling transfer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Deprecated alias for backwards compatibility
app.post('/api/shipments/:id/cancel-receive', (req, res) => {
  return res.status(400).json({
    message: 'Received transfers cannot be cancelled. Only In-Transit transfers can be cancelled.',
  });
});

// Stock Operations (Pullout Bins, Damage Tagging & Adjustments)
app.get('/api/stock-operations', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q =
        'SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAd", date_bs AS "dateBs", fiscal_year AS "fiscalYear", status, items FROM stock_operations' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1 OR destination_warehouse_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching stock ops from DB:', err);
    }
  }
  if (branchId && branchId !== 'ALL') {
    return res.json(
      stockOperations.filter((op) => op.branchId === branchId || op.destinationWarehouseId === branchId)
    );
  }
  res.json(stockOperations);
});

app.post('/api/stock-operations', async (req, res) => {
  try {
    const opType = req.body.type || 'DAMAGE';
    const branchObj = branches.find((b) => b.id === req.body.branchId);
    const destWarehouseObj = branches.find((b) => b.id === (req.body.destinationWarehouseId || 'WH001'));
    const items = req.body.items || [];
    const operationItems = items.length > 0
      ? items
      : req.body.productId
      ? [{ productId: req.body.productId, productName: req.body.productName || '', quantity: Math.abs(Number(req.body.quantityChanged) || 0), deviceSerials: req.body.deviceSerials || [] }]
      : [];
    const stockConsumingType = ['DAMAGE', 'PULLOUT', 'STOCK_OUT', 'CONSUMABLE_ISSUE'].includes(opType);
    if (stockConsumingType) {
      for (const item of operationItems) {
        const product = products.find((entry) => entry.id === item.productId);
        const stockRecord = inventoryStock.find((entry) => entry.productId === item.productId && entry.branchId === req.body.branchId);
        const quantity = Number(item.quantity) || 0;
        const availableQuantity = item.condition === 'DAMAGED_STOCK'
          ? Number(stockRecord?.damagedQty) || 0
          : Number(stockRecord?.quantityOnHand) || 0;
        if (!stockRecord || quantity < 1 || availableQuantity < quantity) {
          return res.status(400).json({ message: `Insufficient inventory for ${item.productName || item.productId}. Available: ${availableQuantity}, requested: ${quantity}.` });
        }
        const isSerialized = product ? product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY' : true;
        if (isSerialized) {
          const serialEntries = item.deviceSerials || [];
          if (serialEntries.length < quantity) {
            return res.status(400).json({ message: `Serial/PON details are required for every unit of ${item.productName || item.productId}.` });
          }
          for (let index = 0; index < quantity; index += 1) {
            const serial = serialEntries[index];
            const device = customerDeviceRecords.find((entry) =>
              entry.deviceSerial?.trim().toUpperCase() === serial.deviceSerial?.trim().toUpperCase() &&
              entry.ponSerial?.trim().toUpperCase() === serial.ponSerial?.trim().toUpperCase() &&
              entry.branchId === req.body.branchId &&
              entry.status === 'IN_STOCK' &&
              (!product || entry.productName?.trim().toLowerCase() === product.name.trim().toLowerCase())
            );
            if (!device) {
              return res.status(400).json({ message: `Device Serial/PON must match an IN_STOCK inventory record for ${item.productName || item.productId}.` });
            }
          }
        }
      }
    }
    let totalValue = 0;
    if (items.length > 0) {
      totalValue = items.reduce((sum: number, it: any) => sum + (it.totalValue || it.quantity * (it.unitCost || 0)), 0);
    } else if (req.body.quantityChanged && req.body.costPerUnit) {
      totalValue = Math.abs(req.body.quantityChanged) * req.body.costPerUnit;
    }

    const newOp = {
      id: req.body.id || `op-${Date.now()}`,
      referenceNumber: req.body.referenceNumber || generateStandardTransactionId(req.body.branchId || 'WH001', opType),
      dateAD: req.body.dateAD || req.body.dateAd || new Date().toISOString().split('T')[0],
      dateBS: req.body.dateBS || req.body.dateBs || '2083-04-16 BS',
      totalValue,
      fiscalYear: req.body.fiscalYear || '2082/83',
      branchName: branchObj?.name || req.body.branchName || 'Branch',
      destinationWarehouseId: destWarehouseObj?.id || req.body.destinationWarehouseId || 'WH001',
      destinationWarehouseName: destWarehouseObj?.name || req.body.destinationWarehouseName || 'Headquarters Warehouse',
      status: opType === 'PULLOUT' ? 'DISPATCHED' : 'LOGGED',
      ...req.body,
    };

    const idx = stockOperations.findIndex((o) => o.id === newOp.id);
    if (idx >= 0) stockOperations[idx] = newOp;
    else stockOperations.unshift(newOp);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO stock_operations (
           id, reference_number, type, technician_name, work_order_ref, branch_id, branch_name, destination_warehouse_id, destination_warehouse_name, product_id, quantity_changed, cost_per_unit, total_value, reason, inspector_name, date_ad, date_bs, fiscal_year, status, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           items = EXCLUDED.items;`,
        [
          newOp.id,
          newOp.referenceNumber,
          opType,
          newOp.technicianName || null,
          newOp.workOrderRef || null,
          newOp.branchId || 'WH001',
          newOp.branchName,
          newOp.destinationWarehouseId,
          newOp.destinationWarehouseName,
          newOp.productId || null,
          Number(newOp.quantityChanged) || 0,
          Number(newOp.costPerUnit) || 0,
          totalValue,
          newOp.reason || '',
          newOp.inspectorName || null,
          newOp.dateAD,
          newOp.dateBS,
          newOp.fiscalYear,
          newOp.status,
          JSON.stringify(items),
        ]
      );

      for (const item of operationItems) {
        const qty = Number(item.quantity) || 1;
        if (opType === 'DAMAGE') {
          await pgPool.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, damaged_qty = damaged_qty + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
            [qty, item.productId, newOp.branchId]
          );
        } else if (opType === 'PULLOUT') {
          await pgPool.query(
            item.condition === 'DAMAGED_STOCK'
              ? `UPDATE inventory_stock SET damaged_qty = damaged_qty - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND damaged_qty >= $1;`
              : `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
            [qty, item.productId, newOp.branchId]
          );
        } else if (opType === 'STOCK_OUT' || opType === 'CONSUMABLE_ISSUE') {
          await pgPool.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
            [qty, item.productId, newOp.branchId]
          );
        }
      }
    }
    if (stockConsumingType) {
      for (const item of operationItems) {
        const stockRecord = inventoryStock.find((entry) => entry.productId === item.productId && entry.branchId === newOp.branchId);
        const quantity = Number(item.quantity) || 0;
        if (stockRecord) {
          if (opType === 'PULLOUT' && item.condition === 'DAMAGED_STOCK') {
            stockRecord.damagedQty = Math.max(0, (stockRecord.damagedQty || 0) - quantity);
          } else {
            stockRecord.quantityOnHand -= quantity;
          }
          if (opType === 'DAMAGE') stockRecord.damagedQty = (stockRecord.damagedQty || 0) + quantity;
          stockRecord.lastUpdated = new Date().toISOString();
        }
      }
    }
    logAuditEvent(req, `CREATE_STOCK_${opType}`, 'STOCK_OPERATIONS', `Created Stock Operation ${newOp.referenceNumber}`);
    res.status(201).json(newOp);
  } catch (err: any) {
    console.error('Error creating stock operation:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Receive Pullout Bin at Warehouse
app.post('/api/stock-operations/:id/receive', async (req, res) => {
  try {
    const { id } = req.params;
    let op = stockOperations.find((o) => o.id === id);
    if (op) op.status = 'RECEIVED';

    if (isPgConnected) {
      await pgPool.query('UPDATE stock_operations SET status = $1 WHERE id = $2', ['RECEIVED', id]);
      if (op) {
        const whId = op.destinationWarehouseId || 'WH001';
        const items = typeof op.items === 'string' ? JSON.parse(op.items) : (op.items || []);
        for (const item of items) {
          const qty = Number(item.quantity) || 1;
          await pgPool.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               quantity_on_hand = inventory_stock.quantity_on_hand + $4,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${whId.toLowerCase()}-${item.productId}`, item.productId, whId, qty]
          );
        }
      }
    }
    logAuditEvent(req, 'RECEIVE_PULLOUT_BIN', 'STOCK_OPERATIONS', `Received Pullout Bin`);
    res.json(op || { message: 'Stock operation received' });
  } catch (err: any) {
    console.error('Error receiving stock operation:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Fiscal Years
app.get('/api/document-number-configs', async (req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT id, document_type AS "documentType", prefix, suffix, min_digits AS "minDigits",
              starting_number AS "startingNumber", next_number AS "nextNumber",
              reset_every_fiscal_year AS "resetEveryFiscalYear", notes
       FROM document_number_configs ORDER BY id ASC;`
    );
    if (result.rows.length > 0) {
      docNumberConfigs = result.rows;
      return res.json(result.rows);
    }
  } catch (e: any) {
    if (e?.code !== 'ECONNREFUSED' && !e?.message?.includes('ECONNREFUSED')) {
      console.warn('PostgreSQL document_number_configs read notice:', e.message);
    }
  }
  res.json(docNumberConfigs);
});

app.put('/api/document-number-configs/:id', async (req, res) => {
  const { id } = req.params;
  const cfg = req.body;
  try {
    await pgPool.query(
      `UPDATE document_number_configs
       SET prefix = $1, suffix = $2, min_digits = $3, starting_number = $4,
           next_number = $5, reset_every_fiscal_year = $6, notes = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8;`,
      [cfg.prefix || '', cfg.suffix || '', cfg.minDigits || 4, cfg.startingNumber || 1, cfg.nextNumber || 1, cfg.resetEveryFiscalYear !== false, cfg.notes || '', id]
    );
  } catch (e: any) {
    console.warn('PostgreSQL update document_number_configs notice:', e.message);
  }

  const idx = docNumberConfigs.findIndex((c) => c.id === id);
  if (idx !== -1) {
    docNumberConfigs[idx] = { ...docNumberConfigs[idx], ...cfg };
  } else {
    docNumberConfigs.push(cfg);
  }
  res.json(docNumberConfigs.find((c) => c.id === id) || cfg);
});

app.put('/api/document-number-configs', async (req, res) => {
  const configs: DocumentNumberConfig[] = req.body;
  if (Array.isArray(configs)) {
    for (const cfg of configs) {
      try {
        await pgPool.query(
          `INSERT INTO document_number_configs (id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
             prefix = EXCLUDED.prefix,
             suffix = EXCLUDED.suffix,
             min_digits = EXCLUDED.min_digits,
             starting_number = EXCLUDED.starting_number,
             next_number = EXCLUDED.next_number,
             reset_every_fiscal_year = EXCLUDED.reset_every_fiscal_year,
             notes = EXCLUDED.notes,
             updated_at = CURRENT_TIMESTAMP;`,
          [cfg.id, cfg.documentType, cfg.prefix || '', cfg.suffix || '', cfg.minDigits || 4, cfg.startingNumber || 1, cfg.nextNumber || 1, cfg.resetEveryFiscalYear !== false, cfg.notes || '']
        );
      } catch (e: any) {
        console.warn(`PostgreSQL bulk update document_number_configs notice for ${cfg.id}:`, e.message);
      }
    }
    docNumberConfigs = configs;
  }
  res.json(docNumberConfigs);
});

app.post('/api/document-number-configs/generate-next', async (req, res) => {
  const { docTypeId, autoIncrement } = req.body;
  let config = docNumberConfigs.find((c) => c.id === docTypeId);

  try {
    const dbRes = await pgPool.query(
      `SELECT id, document_type AS "documentType", prefix, suffix, min_digits AS "minDigits",
              starting_number AS "startingNumber", next_number AS "nextNumber",
              reset_every_fiscal_year AS "resetEveryFiscalYear", notes
       FROM document_number_configs WHERE id = $1;`,
      [docTypeId]
    );
    if (dbRes.rows.length > 0) {
      config = dbRes.rows[0];
    }
  } catch (e: any) {
    console.warn('PostgreSQL read document_number_config notice:', e.message);
  }

  if (!config) {
    const fallbackSeq = Math.floor(1000 + Math.random() * 9000);
    return res.json({ documentNumber: `${docTypeId || 'DOC'}-2081-${fallbackSeq}`, seqNum: fallbackSeq });
  }

  const seqNum = config.nextNumber;
  const paddedNum = String(seqNum).padStart(config.minDigits || 4, '0');
  const formattedDocNum = `${config.prefix || ''}${paddedNum}${config.suffix || ''}`;

  if (autoIncrement !== false) {
    const nextSeq = seqNum + 1;
    try {
      await pgPool.query(
        `UPDATE document_number_configs SET next_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;`,
        [nextSeq, docTypeId]
      );
    } catch (e: any) {
      console.warn('PostgreSQL increment document_number_config notice:', e.message);
    }
    const idx = docNumberConfigs.findIndex((c) => c.id === docTypeId);
    if (idx !== -1) docNumberConfigs[idx].nextNumber = nextSeq;
  }

  res.json({ documentNumber: formattedDocNum, seqNum });
});

app.post('/api/document-number-configs/reset-counter', async (req, res) => {
  const { docTypeId, newStartNumber } = req.body;
  const idx = docNumberConfigs.findIndex((c) => c.id === docTypeId);
  const startNum = newStartNumber !== undefined ? Number(newStartNumber) : (idx !== -1 ? docNumberConfigs[idx].startingNumber : 1);

  try {
    await pgPool.query(
      `UPDATE document_number_configs SET next_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;`,
      [startNum, docTypeId]
    );
  } catch (e: any) {
    console.warn('PostgreSQL reset counter document_number_config notice:', e.message);
  }

  if (idx !== -1) {
    docNumberConfigs[idx].nextNumber = startNum;
  }

  res.json({ status: 'ok', docTypeId, nextNumber: startNum });
});

// Fiscal Years
app.get('/api/fiscal-years', async (req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
              start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
              is_current AS "isCurrent", is_closed AS "isClosed"
       FROM fiscal_years ORDER BY code ASC;`
    );
    if (result.rows.length > 0) {
      return res.json(result.rows);
    }
  } catch (e: any) {
    if (e?.code !== 'ECONNREFUSED' && !e?.message?.includes('ECONNREFUSED')) {
      console.warn('PostgreSQL fiscal_years read notice:', e.message);
    }
  }
  res.json(fiscalYears);
});

app.post('/api/fiscal-years/:id/set-current', async (req, res) => {
  const { id } = req.params;
  try {
    await pgPool.query('UPDATE fiscal_years SET is_current = FALSE;');
    await pgPool.query('UPDATE fiscal_years SET is_current = TRUE WHERE id = $1;', [id]);
  } catch (e: any) {
    console.warn('PostgreSQL set-current fiscal year notice:', e.message);
  }

  fiscalYears.forEach((fy) => {
    fy.isCurrent = fy.id === id;
  });
  res.json(fiscalYears);
});

// Bikram Sambat (BS) Calendar & Day Records Endpoints
const NEPALI_MONTHS_EN_SERVER = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
];

const NEPALI_MONTHS_NP_SERVER = [
  'वैशाख', 'जेठ', 'असार', 'श्रावण', 'भाद्र', 'असोज',
  'कार्तिक', 'मंसिर', 'पुस', 'माघ', 'फागुन', 'चैत'
];

const DAYS_OF_WEEK_EN_SERVER = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

const DAYS_OF_WEEK_NP_SERVER = [
  'आइतबार', 'सोमबार', 'मंगलबार', 'बुधबार', 'बिहीबार', 'शुक्रबार', 'शनिबार'
];

const DEFAULT_BS_YEARS_SERVER = [
  { yearBS: 2078, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2021-04-14' },
  { yearBS: 2079, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2022-04-14' },
  { yearBS: 2080, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2023-04-14' },
  { yearBS: 2081, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2024-04-13' },
  { yearBS: 2082, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2025-04-14' },
  { yearBS: 2083, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2026-04-14' },
  { yearBS: 2084, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2027-04-14' },
  { yearBS: 2085, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2028-04-13' },
];

let inMemoryBsCalendarYears = [...DEFAULT_BS_YEARS_SERVER];
let inMemoryBsDayRecords: any[] = [];

function generateInMemoryBsDayRecords() {
  const recordsMap = new Map<string, any>();
  for (const yData of inMemoryBsCalendarYears) {
    let runningDate = new Date(yData.startAD);
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const monthBS = monthIdx + 1;
      const daysInMonth = yData.daysInMonths[monthIdx] || 30;

      for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
        const adDateStr = runningDate.toISOString().split('T')[0];
        const dayOfWeekIndex = runningDate.getUTCDay();

        const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
        const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
        const bsDateStr = `${yData.yearBS}-${padMonth}-${padDay}`;

        let startYear = yData.yearBS;
        if (monthBS < 4) startYear = yData.yearBS - 1;
        const fyCode = `${startYear}-${String(startYear + 1).slice(-2)}`;

        let qtr = 'Q4';
        if (monthBS >= 4 && monthBS <= 6) qtr = 'Q1';
        else if (monthBS >= 7 && monthBS <= 9) qtr = 'Q2';
        else if (monthBS >= 10 && monthBS <= 12) qtr = 'Q3';

        recordsMap.set(adDateStr, {
          adDate: adDateStr,
          bsDate: bsDateStr,
          bsYear: yData.yearBS,
          bsMonth: monthBS,
          bsMonthName: NEPALI_MONTHS_EN_SERVER[monthIdx],
          bsMonthNameNp: NEPALI_MONTHS_NP_SERVER[monthIdx],
          bsDay: dayBS,
          dayOfWeekName: DAYS_OF_WEEK_EN_SERVER[dayOfWeekIndex],
          dayOfWeekNameNp: DAYS_OF_WEEK_NP_SERVER[dayOfWeekIndex],
          fiscalYear: fyCode,
          quarter: qtr,
          isWeekend: dayOfWeekIndex === 6,
        });

        runningDate.setDate(runningDate.getDate() + 1);
      }
    }
  }
  inMemoryBsDayRecords = Array.from(recordsMap.values());
}

// Initial generation of in-memory records
generateInMemoryBsDayRecords();

app.get('/api/bs-calendar/years', async (req, res) => {
  try {
    const result = await pgPool.query(
      'SELECT year_bs AS "yearBS", days_in_months AS "daysInMonths", start_ad::text AS "startAD" FROM bs_calendar_years ORDER BY year_bs ASC;'
    );
    if (result.rows.length > 0) {
      return res.json(result.rows);
    }
  } catch (_err) {
    // Silently fall back to inMemoryBsCalendarYears if PostgreSQL is unreachable
  }
  res.json(inMemoryBsCalendarYears);
});

app.get('/api/bs-calendar/days', async (req, res) => {
  const { yearBS, monthBS, search } = req.query;
  try {
    let querySql = `
      SELECT ad_date::text AS "adDate", bs_date AS "bsDate", bs_year AS "bsYear", bs_month AS "bsMonth",
             bs_month_name AS "bsMonthName", bs_month_name_np AS "bsMonthNameNp", bs_day AS "bsDay",
             day_of_week_name AS "dayOfWeekName", day_of_week_name_np AS "dayOfWeekNameNp",
             fiscal_year AS "fiscalYear", quarter, is_weekend AS "isWeekend"
      FROM bs_day_records
      WHERE 1=1
    `;
    const params: any[] = [];
    if (yearBS && yearBS !== 'ALL') {
      params.push(parseInt(yearBS as string, 10));
      querySql += ` AND bs_year = $${params.length}`;
    }
    if (monthBS && monthBS !== 'ALL') {
      params.push(parseInt(monthBS as string, 10));
      querySql += ` AND bs_month = $${params.length}`;
    }
    if (search && typeof search === 'string' && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      querySql += ` AND (
        LOWER(ad_date::text) LIKE $${params.length} OR
        LOWER(bs_date) LIKE $${params.length} OR
        LOWER(bs_month_name) LIKE $${params.length} OR
        LOWER(day_of_week_name) LIKE $${params.length} OR
        LOWER(fiscal_year) LIKE $${params.length}
      )`;
    }
    querySql += ` ORDER BY ad_date ASC LIMIT 500;`;

    const result = await pgPool.query(querySql, params);
    if (result.rows.length > 0) {
      return res.json(result.rows);
    }
  } catch (_err) {
    // Silently fall back to in-memory records below
  }

  // Database query result handling
  let filtered = [...inMemoryBsDayRecords];
  if (yearBS && yearBS !== 'ALL') {
    const targetYr = parseInt(yearBS as string, 10);
    filtered = filtered.filter((r) => r.bsYear === targetYr);
  }
  if (monthBS && monthBS !== 'ALL') {
    const targetMo = parseInt(monthBS as string, 10);
    filtered = filtered.filter((r) => r.bsMonth === targetMo);
  }
  if (search && typeof search === 'string' && search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.adDate.toLowerCase().includes(q) ||
        r.bsDate.toLowerCase().includes(q) ||
        r.bsMonthName.toLowerCase().includes(q) ||
        r.dayOfWeekName.toLowerCase().includes(q) ||
        r.fiscalYear.toLowerCase().includes(q)
    );
  }

  res.json(filtered.slice(0, 500));
});

app.post('/api/bs-calendar/seed', async (req, res) => {
  const { yearBS, daysInMonths, customStartAD, onlyIfNew } = req.body;
  if (!yearBS || !Array.isArray(daysInMonths) || daysInMonths.length !== 12) {
    return res.status(400).json({ message: 'Must provide yearBS and 12-element daysInMonths array' });
  }

  let startAD = customStartAD;
  if (!startAD) {
    const estADYear = yearBS - 57;
    startAD = `${estADYear}-04-14`;
  }

  // Check if year already exists if onlyIfNew flag is set
  const existingIdx = inMemoryBsCalendarYears.findIndex((y) => y.yearBS === yearBS);
  if (onlyIfNew && existingIdx >= 0) {
    return res.json({
      success: true,
      skipped: true,
      message: `BS Year ${yearBS} already exists in database. Skipped overwrite because 'onlyIfNew' was specified.`,
    });
  }
  if (existingIdx >= 0) {
    inMemoryBsCalendarYears[existingIdx] = { yearBS, daysInMonths, startAD };
  } else {
    inMemoryBsCalendarYears.push({ yearBS, daysInMonths, startAD });
    inMemoryBsCalendarYears.sort((a, b) => a.yearBS - b.yearBS);
  }
  generateInMemoryBsDayRecords();

  try {
    await pgPool.query(
      `INSERT INTO bs_calendar_years (year_bs, days_in_months, start_ad)
       VALUES ($1, $2, $3)
       ON CONFLICT (year_bs) DO UPDATE SET
         days_in_months = EXCLUDED.days_in_months,
         start_ad = EXCLUDED.start_ad;`,
      [yearBS, daysInMonths, startAD]
    );

    let runningDate = new Date(startAD);
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const monthBS = monthIdx + 1;
      const daysInMonth = daysInMonths[monthIdx] || 30;

      for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
        const adDateStr = runningDate.toISOString().split('T')[0];
        const dayOfWeekIndex = runningDate.getUTCDay();

        const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
        const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
        const bsDateStr = `${yearBS}-${padMonth}-${padDay}`;

        let startYear = yearBS;
        if (monthBS < 4) startYear = yearBS - 1;
        const fyCode = `${startYear}-${String(startYear + 1).slice(-2)}`;

        let qtr = 'Q4';
        if (monthBS >= 4 && monthBS <= 6) qtr = 'Q1';
        else if (monthBS >= 7 && monthBS <= 9) qtr = 'Q2';
        else if (monthBS >= 10 && monthBS <= 12) qtr = 'Q3';

        await pgPool.query(
          `INSERT INTO bs_day_records (
             ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
             bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, quarter, is_weekend
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (ad_date) DO UPDATE SET
             bs_date = EXCLUDED.bs_date,
             bs_year = EXCLUDED.bs_year,
             bs_month = EXCLUDED.bs_month,
             bs_month_name = EXCLUDED.bs_month_name,
             bs_month_name_np = EXCLUDED.bs_month_name_np,
             bs_day = EXCLUDED.bs_day,
             day_of_week_name = EXCLUDED.day_of_week_name,
             day_of_week_name_np = EXCLUDED.day_of_week_name_np,
             fiscal_year = EXCLUDED.fiscal_year,
             quarter = EXCLUDED.quarter,
             is_weekend = EXCLUDED.is_weekend;`,
          [
            adDateStr,
            bsDateStr,
            yearBS,
            monthBS,
            NEPALI_MONTHS_EN_SERVER[monthIdx],
            NEPALI_MONTHS_NP_SERVER[monthIdx],
            dayBS,
            DAYS_OF_WEEK_EN_SERVER[dayOfWeekIndex],
            DAYS_OF_WEEK_NP_SERVER[dayOfWeekIndex],
            fyCode,
            qtr,
            dayOfWeekIndex === 6
          ]
        );

        runningDate.setDate(runningDate.getDate() + 1);
      }
    }
  } catch (_err) {
    // Silently continue if PostgreSQL is disconnected; in-memory store is already updated
  }

  res.json({
    success: true,
    message: `Successfully seeded BS Year ${yearBS} and regenerated calendar day-by-day lookup table!`,
  });
});

app.post('/api/bs-calendar/sync-range', async (req, res) => {
  const { dayRecords } = req.body;
  if (!Array.isArray(dayRecords) || dayRecords.length === 0) {
    return res.status(400).json({ success: false, message: 'No day records provided to write to SQL database.' });
  }

  // Always sync to in-memory day records store
  const recordMap = new Map<string, any>();
  for (const r of inMemoryBsDayRecords) {
    recordMap.set(r.adDate, r);
  }
  for (const r of dayRecords) {
    recordMap.set(r.adDate, r);
  }
  inMemoryBsDayRecords = Array.from(recordMap.values());

  let insertedCount = dayRecords.length;
  try {
    for (const rec of dayRecords) {
      await pgPool.query(
        `INSERT INTO bs_day_records (
           ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
           bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, quarter, is_weekend
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (ad_date) DO UPDATE SET
           bs_date = EXCLUDED.bs_date,
           bs_year = EXCLUDED.bs_year,
           bs_month = EXCLUDED.bs_month,
           bs_month_name = EXCLUDED.bs_month_name,
           bs_month_name_np = EXCLUDED.bs_month_name_np,
           bs_day = EXCLUDED.bs_day,
           day_of_week_name = EXCLUDED.day_of_week_name,
           day_of_week_name_np = EXCLUDED.day_of_week_name_np,
           fiscal_year = EXCLUDED.fiscal_year,
           quarter = EXCLUDED.quarter,
           is_weekend = EXCLUDED.is_weekend;`,
        [
          rec.adDate,
          rec.bsDate,
          rec.bsYear,
          rec.bsMonth,
          rec.bsMonthName,
          rec.bsMonthNameNp,
          rec.bsDay,
          rec.dayOfWeekName,
          rec.dayOfWeekNameNp,
          rec.fiscalYear,
          rec.quarter,
          rec.isWeekend,
        ]
      );
    }
  } catch (_err) {
    // Continue cleanly using in-memory store
  }

  res.json({
    success: true,
    count: insertedCount,
    message: `Successfully written & updated ${insertedCount} daily conversion records in BSDayRecord database table!`,
  });
});

// Audit Trail & Transaction Logs
app.get('/api/audit-trail', async (req, res) => {
  const { branchId, limit } = req.query;
  if (isPgConnected) {
    try {
      let sql = `SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs`;
      const params: any[] = [];
      if (branchId && branchId !== 'ALL') {
        sql += ` WHERE branch_id = $1`;
        params.push(branchId);
      }
      sql += ` ORDER BY timestamp_ad DESC`;
      if (limit) {
        params.push(Number(limit));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching audit trail from DB:', err);
    }
  }
  let list = auditTrail;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((a) => a.branchId === branchId);
  }
  res.json(list);
});

app.get('/api/transaction-logs', async (req, res) => {
  const { branchId, productId, limit } = req.query;
  if (isPgConnected) {
    try {
      let sql = `SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs`;
      const params: any[] = [];
      const conds: string[] = [];

      if (branchId && branchId !== 'ALL') {
        params.push(branchId);
        conds.push(`branch_id = $${params.length}`);
      }
      if (productId && productId !== 'ALL') {
        params.push(productId);
        conds.push(`product_id = $${params.length}`);
      }
      if (conds.length > 0) {
        sql += ` WHERE ` + conds.join(' AND ');
      }
      sql += ` ORDER BY timestamp_ad DESC`;
      if (limit) {
        params.push(Number(limit));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching transaction logs from DB:', err);
    }
  }
  let list = transactionLogs;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((t) => t.branchId === branchId);
  }
  if (productId && productId !== 'ALL') {
    list = list.filter((t) => t.productId === productId);
  }
  res.json(list);
});

// Customer Device & Serial Number Lookup
app.get('/api/customer-devices', async (req, res) => {
  const { branchId, query } = req.query;

  if (isPgConnected) {
    try {
      let sql = `SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAd", issued_date_bs AS "issuedDateBs", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records`;
      const params: any[] = [];
      const conditions: string[] = [];

      if (branchId && branchId !== 'ALL') {
        params.push(branchId);
        conditions.push(`branch_id = $${params.length}`);
      }

      if (query && typeof query === 'string' && query.trim()) {
        params.push(`%${query.trim().toLowerCase()}%`);
        conditions.push(`(LOWER(device_serial) LIKE $${params.length} OR LOWER(pon_serial) LIKE $${params.length} OR LOWER(mac_address) LIKE $${params.length} OR LOWER(customer_name) LIKE $${params.length} OR LOWER(customer_code) LIKE $${params.length} OR LOWER(contact_phone) LIKE $${params.length})`);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY created_at DESC';

      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching customer devices from DB:', err);
    }
  }

  let list = customerDeviceRecords;

  if (branchId && branchId !== 'ALL') {
    list = list.filter((c) => c.branchId === branchId);
  }

  if (query && typeof query === 'string' && query.trim()) {
    const q = query.toLowerCase().trim();
    list = list.filter(
      (c) =>
        c.deviceSerial.toLowerCase().includes(q) ||
        c.ponSerial.toLowerCase().includes(q) ||
        (c.macAddress && c.macAddress.toLowerCase().includes(q)) ||
        c.customerName.toLowerCase().includes(q) ||
        c.customerCode.toLowerCase().includes(q) ||
        c.contactPhone.toLowerCase().includes(q)
    );
  }

  res.json(list);
});

app.post('/api/customer-devices', async (req, res) => {
  try {
    const newRecord: CustomerDeviceRecord = {
      id: req.body.id || `cust-${Date.now()}`,
      ...req.body,
    };
    const idx = customerDeviceRecords.findIndex((c) => c.id === newRecord.id);
    if (idx >= 0) customerDeviceRecords[idx] = newRecord;
    else customerDeviceRecords.unshift(newRecord);

    const custCode = newRecord.customerCode || newRecord.customerId;

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO customer_device_records (
           id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           branch_id = EXCLUDED.branch_id,
           notes = EXCLUDED.notes;`,
        [
          newRecord.id,
          newRecord.customerId || custCode,
          newRecord.customerName,
          custCode,
          newRecord.contactPhone || '',
          newRecord.installationAddress || '',
          newRecord.branchId || 'WH001',
          newRecord.productName,
          newRecord.deviceSerial,
          newRecord.ponSerial || newRecord.deviceSerial,
          newRecord.macAddress || null,
          newRecord.status || 'ACTIVE',
          newRecord.issuedDateAD || new Date().toISOString().split('T')[0],
          newRecord.issuedDateBS || '2083-04-16 BS',
          newRecord.purchaseBillRef || null,
          newRecord.notes || '',
        ]
      );

      await pgPool.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, status, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 1)
         ON CONFLICT (customer_id) DO UPDATE SET
           assigned_devices_count = customer_records.assigned_devices_count + 1;`,
        [
          custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          newRecord.customerName,
          newRecord.customerName.toLowerCase().replace(/\s+/g, '.'),
          newRecord.contactPhone || '9800000000',
          newRecord.branchId || 'WH001',
          newRecord.installationAddress || 'Nepal',
        ]
      );
    }
    logAuditEvent(req, 'ASSIGN_CUSTOMER_CPE', 'CPE_MANAGEMENT', `Assigned CPE Device Serial ${newRecord.deviceSerial} (PON: ${newRecord.ponSerial || 'N/A'}) to customer ${newRecord.customerName}`, newRecord.branchId);
    res.status(201).json(newRecord);
  } catch (err: any) {
    console.error('Error adding customer device:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.patch('/api/customer-devices/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    let record = customerDeviceRecords.find((c) => c.id === id);

    if (isPgConnected && !record) {
      const r = await pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", status FROM customer_device_records WHERE id = $1', [id]);
      if (r.rows.length > 0) record = r.rows[0];
    }
    if (!record) return res.status(404).json({ message: 'Customer device record not found' });

    const oldStatus = record.status;
    const isDisconn = status === 'DISCONNECTED' || status === 'ROUTER_COLLECTED';
    const newStatusStr = isDisconn ? 'ROUTER_COLLECTED' : status;

    record.status = newStatusStr;

    if (isPgConnected) {
      await pgPool.query('UPDATE customer_device_records SET status = $1 WHERE id = $2', [newStatusStr, id]);
    }
    logAuditEvent(req, 'UPDATE_CPE_DEVICE_STATUS', 'CPE_MANAGEMENT', `Updated CPE Device ${record.deviceSerial} status from ${oldStatus} to ${newStatusStr}`, record.branchId);
    res.json(record);
  } catch (err: any) {
    console.error('Error updating CPE device status:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Device Exchange & Replacement Handler
app.post('/api/customer-devices/exchange', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'FIELD_TECHNICIAN', 'BRANCH_MANAGER'), async (req, res) => {
  try {
    const {
      oldDeviceId,
      exchangeReason,
      oldDeviceAction,
      newProductName,
      newDeviceSerial,
      newPonSerial,
      newMacAddress,
      notes,
      branchId,
    } = req.body;

    let oldRecord = customerDeviceRecords.find((c) => c.id === oldDeviceId);
    if (isPgConnected && !oldRecord) {
      const r = await pgPool.query('SELECT * FROM customer_device_records WHERE id = $1', [oldDeviceId]);
      if (r.rows.length > 0) {
        const row = r.rows[0];
        oldRecord = {
          id: row.id,
          customerId: row.customer_id,
          customerName: row.customer_name,
          customerCode: row.customer_code,
          contactPhone: row.contact_phone,
          installationAddress: row.installation_address,
          branchId: row.branch_id,
          productName: row.product_name,
          deviceSerial: row.device_serial,
          ponSerial: row.pon_serial,
          macAddress: row.mac_address,
          status: row.status,
          issuedDateAD: row.issued_date_ad,
          issuedDateBS: row.issued_date_bs,
          purchaseBillRef: row.purchase_bill_ref,
          notes: row.notes,
        };
      }
    }

    if (!oldRecord) return res.status(404).json({ message: 'Old customer device record not found' });

    const dateStrAD = new Date().toISOString().split('T')[0];

    oldRecord.status = 'EXCHANGED';
    oldRecord.notes = `[EXCHANGED on ${dateStrAD}] Reason: ${exchangeReason || 'Defective / Replacement'}. Old device disposition: ${oldDeviceAction}. Replacement SN: ${newDeviceSerial}. ${oldRecord.notes || ''}`;

    const newRecord: CustomerDeviceRecord = {
      id: `cust-${Date.now()}`,
      customerId: oldRecord.customerId,
      customerName: oldRecord.customerName,
      customerCode: oldRecord.customerCode,
      contactPhone: oldRecord.contactPhone,
      installationAddress: oldRecord.installationAddress,
      branchId: branchId || oldRecord.branchId,
      productName: newProductName || oldRecord.productName,
      deviceSerial: newDeviceSerial,
      ponSerial: newPonSerial,
      macAddress: newMacAddress || undefined,
      status: 'RENTAL',
      issuedDateAD: dateStrAD,
      issuedDateBS: '2083-04-28 BS',
      purchaseBillRef: oldRecord.purchaseBillRef,
      notes: `[REPLACEMENT DEVICE] Replaced previous SN ${oldRecord.deviceSerial} on ${dateStrAD}. ${notes || ''}`,
    };

    customerDeviceRecords.unshift(newRecord);

    if (isPgConnected) {
      await withTransaction(async (client) => {
        await client.query('UPDATE customer_device_records SET status = $1, notes = $2 WHERE id = $3', ['EXCHANGED', oldRecord.notes, oldDeviceId]);

        await client.query(
          `INSERT INTO customer_device_records (
             id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`,
          [
            newRecord.id,
            newRecord.customerId,
            newRecord.customerName,
            newRecord.customerCode,
            newRecord.contactPhone || '',
            newRecord.installationAddress || '',
            newRecord.branchId || 'WH001',
            newRecord.productName,
            newRecord.deviceSerial,
            newRecord.ponSerial || newRecord.deviceSerial,
            newRecord.macAddress || null,
            newRecord.status,
            newRecord.issuedDateAD,
            newRecord.issuedDateBS,
            newRecord.purchaseBillRef || null,
            newRecord.notes,
          ]
        );
      });
    }
    logAuditEvent(req, 'DEVICE_EXCHANGE', 'CPE_MANAGEMENT', `Exchanged CPE Device for ${oldRecord.customerName}. Replaced SN ${oldRecord.deviceSerial} -> New SN ${newDeviceSerial}`, oldRecord.branchId);
    res.status(201).json({ oldRecord, newRecord, message: 'Customer device successfully exchanged and inventory synchronized.' });
  } catch (err: any) {
    console.error('Error exchanging customer device:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Customer Master Database Endpoints
app.get('/api/customers', async (req, res) => {
  const { branchId, query } = req.query;

  if (isPgConnected) {
    try {
      let sql = `SELECT id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount" FROM customer_records`;
      const params: any[] = [];
      const conditions: string[] = [];

      if (branchId && branchId !== 'ALL') {
        params.push(branchId);
        conditions.push(`branch_id = $${params.length}`);
      }

      if (query && typeof query === 'string' && query.trim()) {
        params.push(`%${query.trim().toLowerCase()}%`);
        conditions.push(`(LOWER(customer_id) LIKE $${params.length} OR LOWER(customer_name) LIKE $${params.length} OR LOWER(username) LIKE $${params.length} OR LOWER(contact_number) LIKE $${params.length} OR LOWER(email) LIKE $${params.length} OR LOWER(address) LIKE $${params.length})`);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY customer_name ASC';

      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching customers from DB:', err);
    }
  }

  // Dynamically calculate assignedDevicesCount from customerDeviceRecords
  customerMasterRecords.forEach((c) => {
    c.assignedDevicesCount = customerDeviceRecords.filter(
      (d) => d.customerCode === c.customerId || d.customerId === c.id || d.customerName.toLowerCase() === c.customerName.toLowerCase()
    ).length;
  });

  let list = customerMasterRecords;

  if (branchId && branchId !== 'ALL') {
    list = list.filter((c) => c.branchId === branchId);
  }

  if (query && typeof query === 'string' && query.trim()) {
    const q = query.toLowerCase().trim();
    list = list.filter(
      (c) =>
        c.customerId?.toLowerCase().includes(q) ||
        c.customerName?.toLowerCase().includes(q) ||
        c.username?.toLowerCase().includes(q) ||
        c.contactNumber?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.address?.toLowerCase().includes(q)
    );
  }

  res.json(list);
});

app.post('/api/customers', async (req, res) => {
  try {
    const body = req.body;
    const newRecord: CustomerRecord = {
      id: body.id || body.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
      customerId: body.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
      customerName: body.customerName || 'New Customer',
      username: body.username || (body.customerId ? body.customerId.toLowerCase() : 'user'),
      contactNumber: body.contactNumber || '9800000000',
      branchId: body.branchId || 'WH001',
      address: body.address || 'Nepal',
      email: body.email || '',
      status: body.status || 'ACTIVE',
      creditLimit: Number(body.creditLimit) || 0,
      assignedDevicesCount: 0,
    };

    const idx = customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
    if (idx >= 0) {
      customerMasterRecords[idx] = newRecord;
    } else {
      customerMasterRecords.unshift(newRecord);
    }

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           customer_name = EXCLUDED.customer_name,
           username = EXCLUDED.username,
           contact_number = EXCLUDED.contact_number,
           branch_id = EXCLUDED.branch_id,
           address = EXCLUDED.address,
           email = EXCLUDED.email,
           status = EXCLUDED.status,
           credit_limit = EXCLUDED.credit_limit;`,
        [
          newRecord.id,
          newRecord.customerId,
          newRecord.customerName,
          newRecord.username,
          newRecord.contactNumber,
          newRecord.branchId,
          newRecord.address,
          newRecord.email,
          newRecord.status,
          newRecord.creditLimit,
          newRecord.assignedDevicesCount,
        ]
      );
    }
    logAuditEvent(req, 'CREATE_CUSTOMER', 'MASTER_DATA', `Created / Registered Customer Profile ${newRecord.customerName} (${newRecord.customerId})`, newRecord.branchId);
    res.status(201).json(newRecord);
  } catch (err: any) {
    console.error('Error creating customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/customers/bulk', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'BRANCH_MANAGER'), async (req, res) => {
  try {
    const items: CustomerRecord[] = req.body.customers || [];
    let count = 0;

    if (isPgConnected) {
      await withTransaction(async (client) => {
        for (const cust of items) {
          const newRecord: CustomerRecord = {
            id: cust.id || cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
            customerId: cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
            customerName: cust.customerName || 'Imported Customer',
            username: cust.username || (cust.customerId ? cust.customerId.toLowerCase() : 'user'),
            contactNumber: cust.contactNumber || '9800000000',
            branchId: cust.branchId || 'WH001',
            address: cust.address || 'Nepal',
            email: cust.email || '',
            status: cust.status || 'ACTIVE',
            creditLimit: Number(cust.creditLimit) || 0,
            assignedDevicesCount: 0,
          };

          const idx = customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
          if (idx >= 0) {
            customerMasterRecords[idx] = newRecord;
          } else {
            customerMasterRecords.unshift(newRecord);
          }

          await client.query(
            `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET
               customer_id = EXCLUDED.customer_id,
               customer_name = EXCLUDED.customer_name,
               username = EXCLUDED.username,
               contact_number = EXCLUDED.contact_number,
               branch_id = EXCLUDED.branch_id,
               address = EXCLUDED.address,
               email = EXCLUDED.email,
               status = EXCLUDED.status,
               credit_limit = EXCLUDED.credit_limit;`,
            [
              newRecord.id,
              newRecord.customerId,
              newRecord.customerName,
              newRecord.username,
              newRecord.contactNumber,
              newRecord.branchId,
              newRecord.address,
              newRecord.email,
              newRecord.status,
              newRecord.creditLimit,
              newRecord.assignedDevicesCount,
            ]
          );
          count++;
        }
      });
    } else {
      for (const cust of items) {
        const newRecord: CustomerRecord = {
          id: cust.id || cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          customerId: cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          customerName: cust.customerName || 'Imported Customer',
          username: cust.username || (cust.customerId ? cust.customerId.toLowerCase() : 'user'),
          contactNumber: cust.contactNumber || '9800000000',
          branchId: cust.branchId || 'WH001',
          address: cust.address || 'Nepal',
          email: cust.email || '',
          status: cust.status || 'ACTIVE',
          creditLimit: Number(cust.creditLimit) || 0,
          assignedDevicesCount: 0,
        };

        const idx = customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
        if (idx >= 0) {
          customerMasterRecords[idx] = newRecord;
        } else {
          customerMasterRecords.unshift(newRecord);
        }
        count++;
      }
    }
    logAuditEvent(req, 'BULK_IMPORT_CUSTOMERS', 'MASTER_DATA', `Bulk imported ${count} Customer Records into Master Directory`);
    res.status(201).json({ success: true, count, total: customerMasterRecords.length });
  } catch (err: any) {
    console.error('Error bulk importing customers:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = customerMasterRecords.findIndex((c) => c.id === id || c.customerId === id);
    if (idx < 0) {
      return res.status(404).json({ message: 'Customer record not found' });
    }

    customerMasterRecords[idx] = {
      ...customerMasterRecords[idx],
      ...req.body,
    };
    const updated = customerMasterRecords[idx];

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE customer_records SET
           customer_id = $1, customer_name = $2, username = $3, contact_number = $4, branch_id = $5, address = $6, email = $7, status = $8, credit_limit = $9
         WHERE id = $10 OR customer_id = $10;`,
        [updated.customerId, updated.customerName, updated.username, updated.contactNumber, updated.branchId, updated.address, updated.email, updated.status, Number(updated.creditLimit) || 0, id]
      );
    }
    logAuditEvent(req, 'UPDATE_CUSTOMER', 'MASTER_DATA', `Updated Customer Master Details for ${updated.customerName} (${updated.customerId})`, updated.branchId);
    res.json(updated);
  } catch (err: any) {
    console.error('Error updating customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cust = customerMasterRecords.find((c) => c.id === id || c.customerId === id);
    customerMasterRecords = customerMasterRecords.filter((c) => c.id !== id && c.customerId !== id);

    if (isPgConnected) {
      await pgPool.query('DELETE FROM customer_records WHERE id = $1 OR customer_id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_CUSTOMER', 'MASTER_DATA', `Deleted Customer Record ${cust?.customerName || id}`);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Error deleting customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Approval Requests & Workflow Authorization Routes
app.get('/api/approval-requests', async (req, res) => {
  const { branchId, status } = req.query;
  if (isPgConnected) {
    try {
      let sql = `SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status, requested_at_ad AS "requestedAtAD", requested_at_bs AS "requestedAtBS", processed_by_email AS "processedByEmail", processed_by_name AS "processedByName", processed_by_role AS "processedByRole", processed_at_ad AS "processedAtAD", processed_at_bs AS "processedAtBS", rejection_reason AS "rejectionReason" FROM approval_requests`;
      const params: any[] = [];
      const conds: string[] = [];

      if (branchId && branchId !== 'ALL') {
        params.push(branchId);
        conds.push(`branch_id = $${params.length}`);
      }
      if (status && typeof status === 'string' && status !== 'ALL') {
        params.push(status);
        conds.push(`status = $${params.length}`);
      }
      if (conds.length > 0) {
        sql += ` WHERE ` + conds.join(' AND ');
      }
      sql += ` ORDER BY requested_at_ad DESC`;
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching approval requests from DB:', err);
    }
  }

  let list = approvalRequests;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((r) => r.branchId === branchId);
  }
  if (status && typeof status === 'string' && status !== 'ALL') {
    list = list.filter((r) => r.status === status);
  }
  res.json(list);
});

app.post('/api/approval-requests', async (req, res) => {
  try {
    const count = approvalRequests.length + 1;
    const requestNumber = req.body.requestNumber || `APR-2083-${count.toString().padStart(3, '0')}`;

    const newRequest: ApprovalRequest = {
      id: `apr-${Date.now()}`,
      requestNumber,
      ...req.body,
      status: 'PENDING',
      requestedAtAD: new Date().toISOString(),
      requestedAtBS: '2083-04-22 BS',
    };

    approvalRequests.unshift(newRequest);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO approval_requests (id, request_number, type, target_id, customer_name, customer_code, device_serial, pon_serial, product_name, current_status, requested_status, requested_by_role, requested_by_email, requested_by_name, branch_id, branch_name, reason, restock_qty_on_approval, status, requested_at_ad, requested_at_bs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), $20)`,
        [
          newRequest.id,
          newRequest.requestNumber,
          newRequest.type,
          newRequest.targetId || null,
          newRequest.customerName || '',
          newRequest.customerCode || '',
          newRequest.deviceSerial || '',
          newRequest.ponSerial || '',
          newRequest.productName || '',
          newRequest.currentStatus || 'ACTIVE',
          newRequest.requestedStatus || '',
          newRequest.requestedByRole || '',
          newRequest.requestedByEmail || '',
          newRequest.requestedByName || '',
          newRequest.branchId || null,
          newRequest.branchName || '',
          newRequest.reason || '',
          !!newRequest.restockQtyOnApproval,
          'PENDING',
          newRequest.requestedAtBS,
        ]
      );
    }

    // Log in Audit Trail
    const isTransferCancel = newRequest.type === 'CANCEL_TRANSFER' || newRequest.type === 'CANCEL_IN_TRANSIT_TRANSFER' || newRequest.type === 'CANCEL_RECEIVE_TRANSFER';
    const isStockAudit = newRequest.type === 'STOCK_AUDIT_RECONCILIATION';
    let logModule: AuditLog['module'] = 'OPERATIONS';
    let logDetails = `Submitted approval request #${newRequest.requestNumber} for ${newRequest.customerName} (${newRequest.deviceSerial}) status change to ${newRequest.requestedStatus}`;

    if (isTransferCancel) {
      logModule = 'BRANCH_OPERATIONS';
      logDetails = `Submitted approval request #${newRequest.requestNumber} to cancel in-transit transfer ${newRequest.customerName} (${newRequest.deviceSerial}) at ${newRequest.branchName || newRequest.branchId}. Reason: ${newRequest.reason}`;
    } else if (isStockAudit) {
      logModule = 'INVENTORY_AUDIT';
      logDetails = `Submitted Physical Stock Count Audit authorization request #${newRequest.requestNumber} for ${newRequest.branchName || newRequest.branchId} (${newRequest.auditData?.discrepancyCount || 0} variance items, Net Impact: NPR ${(newRequest.auditData?.netValueVariance || 0).toLocaleString()}). Reason: ${newRequest.reason}`;
    }

    logAuditEvent(req, 'APPROVAL_REQUEST_SUBMITTED', logModule, logDetails, newRequest.branchId);
    res.status(201).json(newRequest);
  } catch (err: any) {
    console.error('Error creating approval request:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/approval-requests/:id/process', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'BRANCH_MANAGER', 'AUDITOR'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, approverUser, rejectionReason } = req.body; // status: 'APPROVED' | 'REJECTED'

    let request = approvalRequests.find((r) => r.id === id);
    if (isPgConnected && !request) {
      const r = await pgPool.query(
        'SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status FROM approval_requests WHERE id = $1',
        [id]
      );
      if (r.rows.length > 0) request = r.rows[0];
    }
    if (!request) return res.status(404).json({ message: 'Approval request not found' });

    const currentU = getUserFromReq(req);
    request.status = status;
    request.processedByEmail = approverUser?.email || currentU.email;
    request.processedByName = approverUser?.name || currentU.name;
    request.processedByRole = approverUser?.role || currentU.role;
    request.processedAtAD = new Date().toISOString();
    request.processedAtBS = '2083-04-22 BS';

    if (status === 'REJECTED') {
      request.rejectionReason = rejectionReason || 'Request rejected by administrator';

      if (isPgConnected) {
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5, rejection_reason = $6 WHERE id = $7`,
            [status, request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, request.rejectionReason, id]
          );
        });
      }

      logAuditEvent(req, 'APPROVAL_REQUEST_REJECTED', 'OPERATIONS', `Rejected approval request #${request.requestNumber} for ${request.customerName} (${request.deviceSerial}): ${request.rejectionReason}`, request.branchId);
      return res.json({ request, message: 'Approval request rejected successfully' });
    }

    if (isPgConnected) {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5 WHERE id = $6`,
          [status, request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, id]
        );

        // IF APPROVED: execute the requested status change on customer device record
        if (request.type === 'CUSTOMER_DEVICE_STATUS') {
          const isDisconnectReq = request.requestedStatus === 'DISCONNECTED' || request.requestedStatus === 'ROUTER_COLLECTED';
          const targetStatus = isDisconnectReq ? 'ROUTER_COLLECTED' : request.requestedStatus;

          await client.query(
            `UPDATE customer_device_records SET status = $1 WHERE id = $2 OR device_serial = $3`,
            [targetStatus, request.targetId || '', request.deviceSerial || '']
          );

          if (request.restockQtyOnApproval || isDisconnectReq) {
            const prod = products.find((p) => p.name.toLowerCase() === request.productName?.toLowerCase()) || products[0];
            let stk = inventoryStock.find((s) => s.productId === prod.id && s.branchId === request.branchId);

            if (!stk) {
              stk = {
                id: `stk-${request.branchId.toLowerCase()}-${prod.id}`,
                productId: prod.id,
                branchId: request.branchId,
                quantityOnHand: 0,
                damagedQty: 0,
                reservedQty: 0,
                incomingQty: 0,
                lastUpdated: new Date().toISOString(),
              };
              inventoryStock.push(stk);
            }

            const qtyBefore = stk.quantityOnHand;
            stk.quantityOnHand += 1;
            stk.lastUpdated = new Date().toISOString();

            await client.query(
              `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (id) DO UPDATE SET quantity_on_hand = inventory_stock.quantity_on_hand + 1, last_updated = NOW();`,
              [stk.id, stk.productId, stk.branchId, stk.quantityOnHand, stk.damagedQty || 0, stk.reservedQty || 0, stk.incomingQty || 0]
            );

            const newTxn: TransactionLog = {
              id: `txn-${Date.now()}`,
              transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
              productId: prod.id,
              productSku: prod.sku,
              productName: prod.name,
              branchId: request.branchId,
              changeType: 'PULLOUT' as const,
              quantityBefore: qtyBefore,
              quantityChanged: 1,
              quantityAfter: stk.quantityOnHand,
              unitCost: prod.costPrice,
              referenceDocId: request.requestNumber,
              timestampAD: new Date().toISOString(),
              timestampBS: '2083-04-22 BS',
            };
            transactionLogs.unshift(newTxn);

            await client.query(
              `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13);`,
              [newTxn.id, newTxn.transactionNumber, newTxn.productId, newTxn.productSku, newTxn.productName, newTxn.branchId, newTxn.changeType, newTxn.quantityBefore, newTxn.quantityChanged, newTxn.quantityAfter, newTxn.unitCost, newTxn.referenceDocId, newTxn.timestampBS]
            );
          }
        }

        // IF APPROVED: Cancel In-Transit Transfer
        if (
          request.type === 'CANCEL_TRANSFER' ||
          request.type === 'CANCEL_IN_TRANSIT_TRANSFER' ||
          request.type === 'CANCEL_RECEIVE_TRANSFER' ||
          (request.type && request.type.toUpperCase().includes('CANCEL_TRANSFER'))
        ) {
          const targetId = (request.targetId || request.shipmentData?.shipmentId || '').trim();
          const code1 = (request.deviceSerial || '').trim().toUpperCase();
          const code2 = (request.customerName || '').trim().toUpperCase();
          const code3 = (request.shipmentData?.trackingCode || '').trim().toUpperCase();

          const sh = shipments.find(
            (s) =>
              (targetId && s.id === targetId) ||
              (code1 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code1) ||
              (code2 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code2) ||
              (code3 && s.trackingCode && s.trackingCode.trim().toUpperCase() === code3) ||
              (targetId && s.trackingCode && s.trackingCode.trim().toUpperCase() === targetId.toUpperCase())
          );

          if (sh && sh.status !== 'CANCELLED' && sh.status !== 'RECEIVED' && sh.status !== 'DELIVERED') {
            const srcBranchObj = branches.find((b) => b.id === sh.sourceBranchId || b.code === sh.sourceBranchId);
            const srcBranchId = srcBranchObj?.id || sh.sourceBranchId;
            const destBranchObj = branches.find((b) => b.id === sh.destinationBranchId || b.code === sh.destinationBranchId);
            const destBranchId = destBranchObj?.id || sh.destinationBranchId;

            for (const item of sh.items) {
              const qtySent = Number(item.quantitySent || (item as any).quantity) || 1;
              if (qtySent > 0 && srcBranchId) {
                await client.query(
                  `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
                  [qtySent, item.productId, srcBranchId]
                );
              }
              if (qtySent > 0 && destBranchId) {
                await client.query(
                  `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
                  [qtySent, item.productId, destBranchId]
                );
              }
            }

            sh.status = 'CANCELLED';
            sh.notes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled via Approval #${request.requestNumber} on ${new Date().toISOString().split('T')[0]} by ${request.processedByName} (${request.processedByRole}). Stock restored to source branch.`;

            await client.query('UPDATE shipments SET status = $1, notes = $2 WHERE id = $3', ['CANCELLED', sh.notes, sh.id]);
          }
        }

        // IF APPROVED: Physical Stock Audit Reconciliation
        if (request.type === 'STOCK_AUDIT_RECONCILIATION' && request.auditData) {
          const auditData = request.auditData;
          const targetBranchId = request.branchId || auditData.branchId;

          if (auditData.varianceItems && Array.isArray(auditData.varianceItems)) {
            for (const item of auditData.varianceItems) {
              const targetCounted = Number(item.countedQty) || 0;
              await client.query(
                `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand;`,
                [`stk-${targetBranchId.toLowerCase()}-${item.productId}`, item.productId, targetBranchId, targetCounted]
              );
            }
          }
        }
      });
    } else {
      // In-memory updates if PostgreSQL not connected
      if (request.type === 'CUSTOMER_DEVICE_STATUS') {
        const devRecord = customerDeviceRecords.find((c) => c.id === request.targetId || c.deviceSerial === request.deviceSerial);
        const isDisconnectReq = request.requestedStatus === 'DISCONNECTED' || request.requestedStatus === 'ROUTER_COLLECTED';
        const targetStatus = isDisconnectReq ? 'ROUTER_COLLECTED' : request.requestedStatus;
        if (devRecord) {
          devRecord.status = targetStatus as CustomerDeviceRecord['status'];
        }
      }
    }
    res.json({ request, message: 'Approval request authorized and executed successfully' });
  } catch (err: any) {
    console.error('Error processing approval request:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/approval-requests/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, reason } = req.body;

    let request = approvalRequests.find((r) => r.id === id);
    if (isPgConnected && !request) {
      const r = await pgPool.query('SELECT * FROM approval_requests WHERE id = $1', [id]);
      if (r.rows.length > 0) request = r.rows[0];
    }
    if (!request) return res.status(404).json({ message: 'Approval request not found' });

    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: `Cannot cancel a request that is already ${request.status}` });
    }

    const currentU = getUserFromReq(req);
    request.status = 'CANCELLED';
    request.processedByEmail = user?.email || currentU.email || request.requestedByEmail;
    request.processedByName = user?.name || currentU.name || request.requestedByName;
    request.processedByRole = user?.role || currentU.role || request.requestedByRole;
    request.processedAtAD = new Date().toISOString();
    request.processedAtBS = '2083-04-22 BS';
    request.rejectionReason = reason?.trim() || 'Request cancelled by user';

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE approval_requests SET status = $1, processed_by_email = $2, processed_by_name = $3, processed_by_role = $4, processed_at_ad = NOW(), processed_at_bs = $5, rejection_reason = $6 WHERE id = $7`,
        ['CANCELLED', request.processedByEmail, request.processedByName, request.processedByRole, request.processedAtBS, request.rejectionReason, id]
      );
    }

    logAuditEvent(req, 'APPROVAL_REQUEST_CANCELLED', 'OPERATIONS', `Cancelled approval request #${request.requestNumber} for ${request.customerName || id} (${request.deviceSerial || id}). Reason: ${request.rejectionReason}`, request.branchId);

    res.json({ request, message: 'Approval request cancelled successfully' });
  } catch (err: any) {
    console.error('Error cancelling approval request:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Financial Reports Summary
app.get('/api/reports/financial-summary', async (req, res) => {
  const { branchId } = req.query;

  if (isPgConnected) {
    try {
      const bParam = branchId && branchId !== 'ALL' ? [branchId] : [];
      const whereBranch = branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '';

      // Inventory Asset Value: SUM(quantity_on_hand * cost_price)
      const invRes = await pgPool.query(
        `SELECT SUM(s.quantity_on_hand * p.cost_price) AS total FROM inventory_stock s JOIN products p ON s.product_id = p.id` +
          (branchId && branchId !== 'ALL' ? ' WHERE s.branch_id = $1' : ''),
        bParam
      );
      const totalInventoryAssetValue = Number(invRes.rows[0]?.total || 0);

      // Fixed Asset Value
      const assetRes = await pgPool.query(
        `SELECT SUM(net_book_value) AS total FROM fixed_assets` + whereBranch,
        bParam
      );
      const totalFixedAssetValue = Number(assetRes.rows[0]?.total || 0);

      // Accounts Payable & VAT Input Tax
      const invPayRes = await pgPool.query(
        `SELECT SUM(GREATEST(0, grand_total - amount_paid)) AS total_ap, SUM(vat_amount) AS total_vat FROM purchase_invoices` + whereBranch,
        bParam
      );
      const totalAccountsPayable = Number(invPayRes.rows[0]?.total_ap || 0);
      const totalVatInputTax = Number(invPayRes.rows[0]?.total_vat || 0);

      // Damage Loss Value
      const opRes = await pgPool.query(
        `SELECT SUM(total_value) AS total FROM stock_operations` + whereBranch,
        bParam
      );
      const totalDamageLossValue = Number(opRes.rows[0]?.total || 0);

      const currentFy = fiscalYears.find((f) => f.isCurrent)?.code || '2082/83';

      return res.json({
        totalInventoryAssetValue,
        totalFixedAssetValue,
        totalAccountsPayable,
        totalCostOfGoodsSold: 450000,
        totalDamageLossValue,
        totalVatInputTax,
        currentFiscalYear: currentFy,
      });
    } catch (err) {
      console.error('Error fetching financial summary report from DB:', err);
    }
  }

  let targetStock = inventoryStock;
  let targetAssets = assetRegister;
  let targetInvoices = purchaseInvoices;
  let targetOps = stockOperations;

  if (branchId && branchId !== 'ALL') {
    targetStock = inventoryStock.filter((s) => s.branchId === branchId);
    targetAssets = assetRegister.filter((a) => a.branchId === branchId);
    targetInvoices = purchaseInvoices.filter((inv) => inv.branchId === branchId);
    targetOps = stockOperations.filter((op) => op.branchId === branchId);
  }

  const productCostById = new Map<string, number>();
  for (const p of products) {
    productCostById.set(p.id, Number(p.costPrice || 0));
  }
  const totalInventoryAssetValue = targetStock.reduce((sum, item) => {
    const cost = productCostById.get(item.productId) || 0;
    return sum + cost * (item.quantityOnHand || 0);
  }, 0);

  const totalFixedAssetValue = targetAssets.reduce(
    (sum, a) => sum + (a.netBookValue ?? 0),
    0
  );

  const totalAccountsPayable = targetInvoices.reduce(
    (sum, inv) => sum + Math.max(0, (inv.grandTotal ?? 0) - (inv.amountPaid ?? 0)),
    0
  );

  const totalDamageLossValue = targetOps.reduce(
    (sum, op) => sum + (op.totalValue ?? 0),
    0
  );

  const totalVatInputTax = targetInvoices.reduce(
    (sum, inv) => sum + (inv.vatAmount ?? 0),
    0
  );

  const currentFy = fiscalYears.find((f) => f.isCurrent)?.code || '2082/83';

  res.json({
    totalInventoryAssetValue,
    totalFixedAssetValue,
    totalAccountsPayable,
    totalCostOfGoodsSold: 450000,
    totalDamageLossValue,
    totalVatInputTax,
    currentFiscalYear: currentFy,
  });
});

// Company Profile REST Endpoints
app.get('/api/company-profile', async (req, res) => {
  try {
    if (isPgConnected) {
      const dbRes = await pgPool.query(
        `SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1`
      );
      if (dbRes.rows.length > 0) {
        return res.json(dbRes.rows[0]);
      }
    }
    res.json(companyProfile);
  } catch (err: any) {
    console.error('Error fetching company profile:', err);
    res.json(companyProfile);
  }
});

app.put('/api/company-profile', async (req, res) => {
  try {
    const updated = req.body;
    companyProfile = {
      ...companyProfile,
      ...updated,
    };

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, default_tax_rate, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           legal_name = EXCLUDED.legal_name,
           tagline = EXCLUDED.tagline,
           address = EXCLUDED.address,
           city = EXCLUDED.city,
           country = EXCLUDED.country,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           website = EXCLUDED.website,
           pan_vat_number = EXCLUDED.pan_vat_number,
           registration_number = EXCLUDED.registration_number,
           logo_url = EXCLUDED.logo_url,
           logo_preset = EXCLUDED.logo_preset,
           currency_symbol = EXCLUDED.currency_symbol,
           default_tax_rate = EXCLUDED.default_tax_rate,
           notes = EXCLUDED.notes`,
        [
          companyProfile.id || 'COMP-001',
          companyProfile.name,
          companyProfile.legalName || '',
          companyProfile.tagline || '',
          companyProfile.address,
          companyProfile.city || '',
          companyProfile.country || 'Nepal',
          companyProfile.phone || '',
          companyProfile.email || '',
          companyProfile.website || '',
          companyProfile.panVatNumber || '',
          companyProfile.registrationNumber || '',
          companyProfile.logoUrl || '',
          companyProfile.logoPreset || 'telecom',
          companyProfile.currencySymbol || 'Rs.',
          companyProfile.defaultTaxRate || 13,
          companyProfile.notes || '',
        ]
      );
    }

    logAuditEvent(
      req,
      'COMPANY_PROFILE_UPDATED',
      'SYSTEM',
      `Updated company profile details for ${companyProfile.name} (PAN: ${companyProfile.panVatNumber})`,
      'WH001'
    );
    broadcastChange({ type: 'COMPANY_PROFILE_UPDATED', entity: 'COMPANY_PROFILE' });

    res.json(companyProfile);
  } catch (err: any) {
    console.error('Error updating company profile:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Vite Middleware Setup for Dev Mode vs Static Production Serving
async function syncDatabaseAndIndexes() {
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
    console.log('PostgreSQL Pool connected successfully. Syncing full database schema (19 tables) & creating high-throughput performance indexes...');

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
        description TEXT
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

      -- 7. Fixed Assets
      CREATE TABLE IF NOT EXISTS fixed_assets (
        id VARCHAR(50) PRIMARY KEY,
        tag_number VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        acquisition_date_ad DATE NOT NULL,
        acquisition_date_bs VARCHAR(20) NOT NULL,
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
        supplier_name VARCHAR(200) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        order_date_ad DATE NOT NULL,
        order_date_bs VARCHAR(20) NOT NULL,
        expected_delivery_date_ad DATE,
        status VARCHAR(30) DEFAULT 'DRAFT',
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
        payment_status VARCHAR(30) DEFAULT 'UNPAID',
        amount_paid NUMERIC(14, 2) DEFAULT 0.00,
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
        is_closed BOOLEAN DEFAULT FALSE
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
        phone VARCHAR(100),
        email VARCHAR(100),
        website VARCHAR(100),
        pan_vat_number VARCHAR(100),
        registration_number VARCHAR(100),
        logo_url TEXT,
        logo_preset VARCHAR(50),
        currency_symbol VARCHAR(20),
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

      -- SCHEMA MIGRATION SAFE ALTERS
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS vendor_bill_number VARCHAR(100);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_by_notes TEXT;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_date_ad DATE;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_date_bs VARCHAR(20);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS has_discrepancy BOOLEAN DEFAULT FALSE;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS items JSONB;
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
    `);

    isPgConnected = true;
    setIsPgConnected(true);
    await seedInitialPostgresData(client);

    client.release();
    console.log('✅ All 19 Database tables and enterprise composite performance indexes synced successfully on PostgreSQL.');
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
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.code, b.name, b.location, b.phone || '', b.isHeadquarters || false, b.active !== false, b.allowProcurement !== false]
      );
    }
    for (const fy of INITIAL_MASTER_FISCAL_YEARS) {
      await client.query(
        `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [fy.id, fy.code, fy.startDateAD || '2025-07-16', fy.endDateAD || '2026-07-15', fy.startDateBS || '2082-04-01', fy.endDateBS || '2083-03-31', fy.isCurrent || false, fy.isClosed || false]
      );
    }
    // Seed Company Profile if empty
    await client.query(
      `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, default_tax_rate, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) ON CONFLICT (id) DO NOTHING`,
      [
        INITIAL_COMPANY_PROFILE.id,
        INITIAL_COMPANY_PROFILE.name,
        INITIAL_COMPANY_PROFILE.legalName,
        INITIAL_COMPANY_PROFILE.tagline,
        INITIAL_COMPANY_PROFILE.address,
        INITIAL_COMPANY_PROFILE.city,
        INITIAL_COMPANY_PROFILE.country,
        INITIAL_COMPANY_PROFILE.phone,
        INITIAL_COMPANY_PROFILE.email,
        INITIAL_COMPANY_PROFILE.website,
        INITIAL_COMPANY_PROFILE.panVatNumber,
        INITIAL_COMPANY_PROFILE.registrationNumber,
        INITIAL_COMPANY_PROFILE.logoUrl,
        INITIAL_COMPANY_PROFILE.logoPreset,
        INITIAL_COMPANY_PROFILE.currencySymbol,
        INITIAL_COMPANY_PROFILE.defaultTaxRate,
        INITIAL_COMPANY_PROFILE.notes,
      ]
    );

    for (const u of INITIAL_MASTER_UOM) {
      await client.query(
        `INSERT INTO uom (id, name, symbol, type, is_base_unit)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [u.id, u.name, u.symbol, u.type, u.isBaseUnit]
      );
    }
    for (const l of INITIAL_MASTER_LOCATIONS) {
      await client.query(
        `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [l.id, l.name, l.type, l.branchId, l.address, JSON.stringify(l.coordinates), l.contactPerson, l.contactPhone, l.notes, l.activeAssetsCount]
      );
    }

    for (const s of INITIAL_MASTER_SUPPLIERS) {
      const sup = s as any;
      await client.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [sup.id, sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', sup.rating || 5.0, sup.status || 'ACTIVE']
      );
    }

    for (const cfg of INITIAL_DOCUMENT_NUMBER_CONFIGS) {
      await client.query(
        `INSERT INTO document_number_configs (id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [cfg.id, cfg.documentType, cfg.prefix || '', cfg.suffix || '', cfg.minDigits || 4, cfg.startingNumber || 1, cfg.nextNumber || 1, cfg.resetEveryFiscalYear !== false, cfg.notes || '']
      );
    }

    if (users.length > 0) {
      for (const u of users) {
        await client.query(
          `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [u.id, u.email, u.password, u.name, u.role, u.branchId, u.allowedBranchIds || [], u.canSwitchUser || false]
        );
      }
    }

    // Hydrate all master data from PostgreSQL
    const bRes = await client.query('SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches ORDER BY code');
    if (bRes.rows.length > 0) branches = bRes.rows;

    const dbUsersRes = await client.query(
      'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC'
    );
    if (dbUsersRes.rows.length > 0) {
      users = dbUsersRes.rows;
    }

    const fyRes = await client.query('SELECT id, code, start_date_ad AS "startDateAD", end_date_ad AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed" FROM fiscal_years ORDER BY id');
    if (fyRes.rows.length > 0) fiscalYears = fyRes.rows;

    const uomRes = await client.query('SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC');
    if (uomRes.rows.length > 0) uomList = uomRes.rows;

    const locRes = await client.query('SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations ORDER BY name ASC');
    if (locRes.rows.length > 0) locationRecords = locRes.rows;

    const supDbRes = await client.query('SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC');
    if (supDbRes.rows.length > 0) suppliers = supDbRes.rows;

    const compRes = await client.query('SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1');
    if (compRes.rows.length > 0) companyProfile = compRes.rows[0];

    const docCfgRes = await client.query('SELECT id, document_type AS "documentType", prefix, suffix, min_digits AS "minDigits", starting_number AS "startingNumber", next_number AS "nextNumber", reset_every_fiscal_year AS "resetEveryFiscalYear", notes FROM document_number_configs ORDER BY id ASC');
    if (docCfgRes.rows.length > 0) docNumberConfigs = docCfgRes.rows;

    // Only populate operational sample inventory/orders if SEED_DUMMY_DATA=true is explicitly set
    if (process.env.SEED_DUMMY_DATA !== 'true') {
      console.log('ℹ️ Clean DB mode active (SEED_DUMMY_DATA is not set). Operational tables initialized empty.');
      return;
    }

    for (const s of suppliers) {
      const sup = s as any;
      await client.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [sup.id, sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', sup.rating || 5.0, sup.status || 'ACTIVE']
      );
    }
    const categoryList = Array.from(new Set(products.map((p) => p.category))).map((cat, idx) => ({
      id: `cat-${idx + 1}`,
      name: cat,
      code: cat.toUpperCase().replace(/\s+/g, '_').slice(0, 10),
      description: `${cat} Inventory Category`,
    }));
    for (const c of categoryList) {
      await client.query(
        `INSERT INTO categories (id, name, code, description)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [c.id, c.name, c.code, c.description]
      );
    }
    for (const p of products) {
      const prod = p as any;
      await client.query(
        `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (id) DO NOTHING`,
        [
          prod.id, prod.sku, prod.barcode || '', prod.name, prod.category, prod.productGroup || 'Product Item', prod.unit || 'Pcs',
          prod.costPrice || 0, prod.sellingPrice || 0, prod.taxRate || 13.0, prod.minReorderLevel || 5, prod.requiresSerialTracking || false,
          prod.trackingType || 'QUANTITY_ONLY', prod.description || '', prod.status || 'ACTIVE'
        ]
      );
    }
    for (const st of inventoryStock) {
      await client.query(
        `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [st.id, st.productId, st.branchId, st.quantityOnHand || 0, st.damagedQty || 0, st.reservedQty || 0, st.incomingQty || 0, st.minReorderLevel || 5]
      );
    }
    for (const a of assetRegister) {
      await client.query(
        `INSERT INTO fixed_assets (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, acquisition_cost, depreciation_method, depreciation_rate_percent, accumulated_depreciation, net_book_value, status, supplier_name, invoice_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (id) DO NOTHING`,
        [
          a.id, a.tagNumber, a.name, a.category, a.branchId, a.acquisitionDateAD || '2025-01-01', a.acquisitionDateBS || '2081-09-17',
          a.acquisitionCost || 0, a.depreciationMethod || 'STRAIGHT_LINE', a.depreciationRatePercent || 15.0,
          a.accumulatedDepreciation || 0, a.netBookValue || 0, a.status || 'ACTIVE', a.supplierName || '', a.invoiceNo || ''
        ]
      );
    }
    for (const po of purchaseOrders) {
      await client.query(
        `INSERT INTO purchase_orders (id, po_number, supplier_name, branch_id, order_date_ad, order_date_bs, expected_delivery_date_ad, status, subtotal_amount, tax_amount, total_amount, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
        [
          po.id, po.poNumber, po.supplierName, po.branchId, po.orderDateAD || '2025-01-01', po.orderDateBS || '2081-09-17',
          po.expectedDeliveryDateAD || '2025-01-10', po.status || 'DRAFT', po.subtotalAmount || 0, po.taxAmount || 0,
          po.totalAmount || 0, po.notes || ''
        ]
      );
    }
    for (const inv of purchaseInvoices) {
      await client.query(
        `INSERT INTO purchase_invoices (id, invoice_number, po_reference_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total, payment_status, amount_paid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (id) DO NOTHING`,
        [
          inv.id, inv.invoiceNumber, inv.poReferenceId || '', inv.supplierName, inv.branchId, inv.invoiceDateAD || '2025-01-01',
          inv.invoiceDateBS || '2081-09-17', inv.taxableAmount || 0, inv.vatAmount || 0, inv.nonTaxableAmount || 0,
          inv.grandTotal || 0, inv.paymentStatus || 'UNPAID', inv.amountPaid || 0
        ]
      );
    }
    for (const cust of customerMasterRecords) {
      await client.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
        [
          cust.id, cust.customerId, cust.customerName, cust.username || '', cust.contactNumber || '', cust.branchId,
          cust.address || '', cust.email || '', cust.status || 'ACTIVE', cust.creditLimit || 0, cust.assignedDevicesCount || 0
        ]
      );
    }
    for (const dev of customerDeviceRecords) {
      await client.query(
        `INSERT INTO customer_device_records (id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (id) DO NOTHING`,
        [
          dev.id, dev.customerId || '', dev.customerName, dev.customerCode, dev.contactPhone || '', dev.installationAddress || '',
          dev.branchId, dev.productName, dev.deviceSerial, dev.ponSerial, dev.macAddress || '', dev.status || 'ACTIVE',
          dev.issuedDateAD || '2025-01-01', dev.issuedDateBS || '2081-09-17', dev.purchaseBillRef || '', dev.notes || ''
        ]
      );
    }
    for (const app of approvalRequests) {
      await client.query(
        `INSERT INTO approval_requests (id, request_number, type, target_id, customer_name, customer_code, device_serial, pon_serial, product_name, current_status, requested_status, requested_by_role, requested_by_email, requested_by_name, branch_id, branch_name, reason, restock_qty_on_approval, status, requested_at_ad, requested_at_bs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) ON CONFLICT (id) DO NOTHING`,
        [
          app.id, app.requestNumber, app.type, app.targetId || '', app.customerName || '', app.customerCode || '',
          app.deviceSerial || '', app.ponSerial || '', app.productName || '', app.currentStatus || '', app.requestedStatus || '',
          app.requestedByRole || '', app.requestedByEmail || '', app.requestedByName || '', app.branchId, app.branchName || '',
          app.reason || '', app.restockQtyOnApproval || false, app.status || 'PENDING', app.requestedAtAD || new Date().toISOString(), app.requestedAtBS || '2081-09-17'
        ]
      );
    }
    console.log('✅ Initial PostgreSQL seed data loaded successfully.');
  } catch (seedErr: any) {
    console.log('PostgreSQL initial seed note:', seedErr?.message || seedErr);
  }
}

async function startServer() {
  await syncDatabaseAndIndexes();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`IZone Inventory System server running on http://localhost:${PORT}`);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

startServer().catch((err) => {
  console.error(err?.message || err);
  process.exitCode = 1;
});
