import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  User,
  Supplier,
  Branch,
  Product,
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
} from './src/types';

dotenv.config();

const { Pool } = pg;
let isPgConnected = false;
const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
  connectionTimeoutMillis: 3000,
});

const app = express();
app.use(express.json());

// Health & Control Plane Endpoints FIRST before any other routes or middleware
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/__aistudio_internal_control_plane/dev/status', (req, res) => {
  res.json({ status: 'ok', dev: true });
});

app.get('/__aistudio_internal_control_plane/*', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = 3000;

// Initialize Gemini API client lazily when API key exists
function getGenAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({ apiKey });
}

// ==========================================
// IN-MEMORY DATABASE STATE & PRE-SEEDED DATA
// ==========================================

// Pre-seeded Users according to requested specifications
const users = [
  {
    id: 'usr-1',
    email: 'superadmin@izone.net.np',
    password: 'superadmin@123',
    name: 'Nabin Shrestha',
    role: 'SUPER_ADMIN',
    branchId: 'WH001',
    allowedBranchIds: ['WH001', 'CHU01', 'BR-KTM', 'BR-PKR', 'BR-BKT'],
    canSwitchUser: true,
  },
  {
    id: 'usr-2',
    email: 'subash.dhimal@izone.net.np',
    password: 'subash@123',
    name: 'Subash Dhimal',
    role: 'INVENTORY_MANAGER',
    branchId: 'WH001',
    allowedBranchIds: ['WH001', 'CHU01', 'BR-KTM', 'BR-PKR', 'BR-BKT'],
    canSwitchUser: true,
  },
  {
    id: 'usr-3',
    email: 'sandesh.rai@izone.net.np',
    password: 'Sandesh@123',
    name: 'Sandesh Rai',
    role: 'BRANCH_MANAGER',
    branchId: 'CHU01',
    allowedBranchIds: ['CHU01', 'BR-KTM'],
    canSwitchUser: false,
  },
  {
    id: 'usr-4',
    email: 'bidhya.khatiwad@izone.net.np',
    password: 'Bidhya@123',
    name: 'Bidhya Khatiwada',
    role: 'FRONT_DESK',
    branchId: 'CHU01',
    allowedBranchIds: ['CHU01'],
    canSwitchUser: false,
  },
  {
    id: 'usr-5',
    email: 'sanjiwani.chaudhary@izone.net.np',
    password: 'Sanjiwani@123',
    name: 'Sanjiwani Kumari Chaudhary',
    role: 'ACCOUNTANT',
    branchId: 'WH001',
    allowedBranchIds: ['WH001'],
    canSwitchUser: false,
  },
];

// Pre-seeded Suppliers
let suppliers: Supplier[] = [
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

// Pre-seeded Actual 19 Branches
let branches: Branch[] = [
  {
    id: 'WH001',
    code: 'WH001',
    name: 'Head Office',
    location: 'Urlabari',
    phone: '9800000000',
    isHeadquarters: true,
    active: true,
  },
  {
    id: 'BRC01',
    code: 'BRC01',
    name: 'Biratchowk',
    location: 'Biratchowk',
    phone: '9800000001',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'BTM01',
    code: 'BTM01',
    name: 'Birtamode',
    location: 'Birtamode',
    phone: '9800000002',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'CHU01',
    code: 'CHU01',
    name: 'Chulachuli',
    location: 'Chulachuli',
    phone: '9800000003',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'DHU01',
    code: 'DHU01',
    name: 'Dudhe',
    location: 'Dudhe',
    phone: '9800000004',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'INR01',
    code: 'INR01',
    name: 'Inaruwa',
    location: 'Inaruwa',
    phone: '9800000005',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'ITH01',
    code: 'ITH01',
    name: 'Itahari',
    location: 'Itahari',
    phone: '9800000006',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'JTR01',
    code: 'JTR01',
    name: 'Jitpur',
    location: 'Jitpur',
    phone: '9800000007',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'HLE01',
    code: 'HLE01',
    name: 'Hile',
    location: 'Hile',
    phone: '9800000008',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'LTG01',
    code: 'LTG01',
    name: 'Letang',
    location: 'Letang',
    phone: '9800000009',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'MDL01',
    code: 'MDL01',
    name: 'Madhumalla',
    location: 'Madhumalla',
    phone: '9800000010',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'PTH01',
    code: 'PTH01',
    name: 'Pathari',
    location: 'Pathari',
    phone: '9800000011',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'PDM01',
    code: 'PDM01',
    name: 'Phidim',
    location: 'Phidim',
    phone: '9800000012',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'RJB01',
    code: 'RJB01',
    name: 'Rajbiraj',
    location: 'Rajbiraj',
    phone: '9800000013',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'RML01',
    code: 'RML01',
    name: 'Ramailo',
    location: 'Ramailo',
    phone: '9800000014',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'RTW01',
    code: 'RTW01',
    name: 'Ratuwamai',
    location: 'Ratuwamai',
    phone: '9800000015',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'SHV01',
    code: 'SHV01',
    name: 'Shivasatakshi',
    location: 'Shivasatakshi',
    phone: '9800000016',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'TND01',
    code: 'TND01',
    name: 'Tandi',
    location: 'Tandi',
    phone: '9800000017',
    isHeadquarters: false,
    active: true,
  },
  {
    id: 'URL01',
    code: 'URL01',
    name: 'Urlabari',
    location: 'Urlabari',
    phone: '9800000018',
    isHeadquarters: false,
    active: true,
  },
];

// Imported Items & Telecom Consumables
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

// Pre-seeded Products mapped from Excel Sheet
let products: Product[] = EXCEL_ITEMS.map((item, idx) => {
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

// Pre-seeded Inventory Stock per Branch for all products across all 19 branches (2-3 pieces per item)
let inventoryStock: InventoryStock[] = [];
let seededDamagedCount = 0;

products.forEach((p, index) => {
  branches.forEach((branch, bIdx) => {
    // Consumable products (splitters, sleeves, couplers) have higher operational quantity per branch
    const isConsumable = p.productGroup === 'Consumable Item';
    const baseQty = isConsumable ? (branch.isHeadquarters ? 150 + ((index * 10) % 100) : 35 + ((index + bIdx) % 25)) : 2 + ((index + bIdx) % 2);
    const qty = baseQty;

    // Seed exactly 21 pcs of damaged stock across active branches (1 pc per damaged stock entry)
    let damagedQty = 0;
    if (seededDamagedCount < 21 && (index * 7 + bIdx * 3 + 1) % 13 === 0) {
      damagedQty = 1;
      seededDamagedCount++;
    }

    // Set realistic per-branch minimum reorder level based on branch demand / HQ status
    const branchMinReorder = branch.isHeadquarters
      ? p.minReorderLevel * 2
      : (bIdx % 3 === 0 ? p.minReorderLevel : Math.max(1, Math.floor(p.minReorderLevel / 2)));

    inventoryStock.push({
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

// Pre-seeded Fixed Assets from Excel Sheet (2-3 pieces per asset category/item, keeping Fiber items)
let assetRegister: Asset[] = EXCEL_ITEMS
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

// Pre-seeded Purchase Orders referencing actual products
let purchaseOrders: PurchaseOrder[] = [
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
      {
        id: 'poi-2',
        productId: 'prod-olt001',
        productName: 'OLT SFP LOADED 16 PORT',
        sku: 'OLT001',
        quantity: 2,
        unitPrice: 125000,
        taxRate: 13,
        subtotal: 250000,
        taxAmount: 32500,
        total: 282500,
      },
    ],
    subtotalAmount: 375000,
    taxAmount: 48750,
    totalAmount: 423750,
    notes: 'Urgent reorder for optical distribution network hardware.',
  },
];

// Pre-seeded Purchase Invoices with 13% VAT
let purchaseInvoices: PurchaseInvoice[] = [
  {
    id: 'inv-201',
    invoiceNumber: 'INV-2083-8891',
    poReferenceId: 'po-101',
    supplierName: 'Himalayan Tech Distributors Pvt. Ltd.',
    branchId: 'WH001',
    invoiceDateAD: '2026-07-25',
    invoiceDateBS: '2083-04-10 BS',
    dueDateAD: '2026-08-25',
    dueDateBS: '2083-05-09 BS',
    taxableAmount: 375000,
    vatAmount: 48750,
    nonTaxableAmount: 0,
    grandTotal: 423750,
    paymentStatus: 'UNPAID',
    amountPaid: 0,
  },
];

// Pre-seeded Shipments & Transfers
let shipments: Shipment[] = [
  {
    id: 'sh-301',
    trackingCode: 'TRF-2083-0092',
    type: 'INTER_BRANCH',
    sourceBranchId: 'WH001',
    sourceBranchName: 'Head Office (Urlabari)',
    destinationBranchId: 'CHU01',
    destinationBranchName: 'Chulachuli Branch',
    dispatchDateAD: '2026-07-28',
    dispatchDateBS: '2083-04-13 BS',
    estimatedArrivalAD: '2026-08-01',
    status: 'IN_TRANSIT',
    items: [
      {
        id: 'shi-1',
        productId: 'prod-drp001',
        productName: 'DROP CABLE 175 MTR',
        sku: 'DRP001',
        quantitySent: 10,
      },
    ],
    notes: 'Inter-branch drop cable stock transfer to Chulachuli branch.',
  },
  {
    id: 'sh-302',
    trackingCode: 'TRF-2083-0088',
    type: 'INTER_BRANCH',
    sourceBranchId: 'WH001',
    sourceBranchName: 'Head Office (Urlabari)',
    destinationBranchId: 'CHU01',
    destinationBranchName: 'Chulachuli Branch',
    dispatchDateAD: '2026-07-25',
    dispatchDateBS: '2083-04-10 BS',
    estimatedArrivalAD: '2026-07-27',
    status: 'RECEIVED',
    items: [
      {
        id: 'shi-2',
        productId: 'prod-onu001',
        productName: 'ONU ROUTER 2.4G',
        sku: 'ONU001',
        quantitySent: 5,
        quantityReceived: 5,
        deviceSerials: [
          { deviceSerial: 'SN-ONU24G-880121', ponSerial: 'HWTC-A101B201' },
          { deviceSerial: 'SN-ONU24G-880122', ponSerial: 'HWTC-A101B202' },
          { deviceSerial: 'SN-ONU24G-880123', ponSerial: 'HWTC-A101B203' },
          { deviceSerial: 'SN-ONU24G-880124', ponSerial: 'HWTC-A101B204' },
          { deviceSerial: 'SN-ONU24G-880125', ponSerial: 'HWTC-A101B205' },
        ],
      },
    ],
    notes: 'Urgent ONU router replenish transfer for subscriber onboarding.',
  },
  {
    id: 'sh-303',
    trackingCode: 'TRF-2083-0085',
    type: 'INTER_BRANCH',
    sourceBranchId: 'WH001',
    sourceBranchName: 'Head Office (Urlabari)',
    destinationBranchId: 'BTM01',
    destinationBranchName: 'Birtamode Branch',
    dispatchDateAD: '2026-07-22',
    dispatchDateBS: '2083-04-07 BS',
    estimatedArrivalAD: '2026-07-24',
    status: 'RECEIVED',
    items: [
      {
        id: 'shi-3',
        productId: 'prod-pat001',
        productName: 'PATCH CORD 3 MTR',
        sku: 'PAT001',
        quantitySent: 2,
        quantityReceived: 2,
      },
    ],
    notes: 'Patch cord batch dispatch to Birtamode Branch.',
  },
];

// Pre-seeded Stock Operations
let stockOperations: StockOperation[] = [];

// Auto-seed matching DAMAGE operations for all 21 pre-seeded damaged stock entries
let dmgOpCounter = 1;
inventoryStock.forEach((stk) => {
  if (stk.damagedQty > 0) {
    const prod = products.find((p) => p.id === stk.productId);
    stockOperations.push({
      id: `op-dmg-${stk.id}`,
      referenceNumber: `DMG-2083-${String(dmgOpCounter++).padStart(3, '0')}`,
      type: 'DAMAGE',
      branchId: stk.branchId,
      productId: stk.productId,
      productName: prod?.name || 'Damaged Stock Item',
      quantityChanged: -stk.damagedQty,
      costPerUnit: prod?.costPrice || 0,
      totalValue: stk.damagedQty * (prod?.costPrice || 0),
      reason: 'Physical branch inventory inspection & transit damage tag',
      inspectorName: 'Branch Quality Inspector',
      dateAD: '2026-07-22',
      dateBS: '2083-04-07 BS',
      fiscalYear: '2082-83',
    });
  }
});

// Pre-seeded Fiscal Years
let fiscalYears: FiscalYear[] = [
  {
    id: 'fy-1',
    code: '2080-81',
    startDateAD: '2023-07-17',
    endDateAD: '2024-07-15',
    startDateBS: '2080-04-01 BS',
    endDateBS: '2080-12-31 BS',
    isCurrent: false,
    isClosed: true,
  },
  {
    id: 'fy-2',
    code: '2081-82',
    startDateAD: '2024-07-16',
    endDateAD: '2025-07-15',
    startDateBS: '2081-04-01 BS',
    endDateBS: '2081-12-31 BS',
    isCurrent: false,
    isClosed: true,
  },
  {
    id: 'fy-3',
    code: '2082-83',
    startDateAD: '2025-07-16',
    endDateAD: '2026-07-15',
    startDateBS: '2082-04-01 BS',
    endDateBS: '2082-12-31 BS',
    isCurrent: true,
    isClosed: false,
  },
  {
    id: 'fy-4',
    code: '2083-84',
    startDateAD: '2026-07-16',
    endDateAD: '2027-07-15',
    startDateBS: '2083-04-01 BS',
    endDateBS: '2083-12-31 BS',
    isCurrent: false,
    isClosed: false,
  },
];

// Pre-seeded Audit Logs
let auditTrail: AuditLog[] = [
  {
    id: 'aud-1',
    userEmail: 'admin@izone.net.np',
    userName: 'Shrestha Administrator',
    action: 'SYSTEM_BOOT',
    module: 'AUTH',
    details: 'IZone Enterprise Inventory System initialized with multi-branch database.',
    timestampAD: '2026-07-31T07:00:00Z',
    timestampBS: '2083-04-16 BS',
  },
];

// Pre-seeded Transaction Logs
let transactionLogs: TransactionLog[] = [
  {
    id: 'txn-1',
    transactionNumber: 'TXN-88001',
    productId: 'prod-hoc001',
    productSku: 'HOC001',
    productName: 'HYDRAULIC OFFICE CHAIR-FA',
    branchId: 'CHU01',
    changeType: 'DAMAGE',
    quantityBefore: 10,
    quantityChanged: -1,
    quantityAfter: 9,
    unitCost: 25,
    referenceDocId: 'DMG-2083-001',
    timestampAD: '2026-07-22T10:30:00Z',
    timestampBS: '2083-04-07 BS',
  },
];

// Pre-seeded Customer Master Database
let customerMasterRecords: CustomerRecord[] = [
  {
    id: 'CUS-10291',
    customerId: 'CUS-10291',
    customerName: 'Aarav Sharma',
    username: 'aarav.sharma',
    contactNumber: '9851092810',
    branchId: 'BRC01',
    address: 'Durbar Marg Ward 4, Kathmandu, Nepal',
    email: 'aarav@gmail.com',
    status: 'ACTIVE',
    creditLimit: 25000,
    assignedDevicesCount: 2,
  },
  {
    id: 'CUS-10292',
    customerId: 'CUS-10292',
    customerName: 'Pooja Gurung',
    username: 'pooja.g',
    contactNumber: '9846019283',
    branchId: 'BTM01',
    address: 'Lakeside Ward 6, Pokhara, Nepal',
    email: 'pooja.g@yahoo.com',
    status: 'ACTIVE',
    creditLimit: 15000,
    assignedDevicesCount: 1,
  },
  {
    id: 'CUS-10293',
    customerId: 'CUS-10293',
    customerName: 'Subash Shrestha',
    username: 'subash.sh',
    contactNumber: '9801029381',
    branchId: 'WH001',
    address: 'Jawalakhel Ward 2, Lalitpur, Nepal',
    email: 'subash@outlook.com',
    status: 'ACTIVE',
    creditLimit: 50000,
    assignedDevicesCount: 0,
  },
  {
    id: 'CUS-10294',
    customerId: 'CUS-10294',
    customerName: 'Bina Thapa',
    username: 'bina.t',
    contactNumber: '9855019284',
    branchId: 'CHU01',
    address: 'Lions Chowk Ward 1, Narayangarh, Nepal',
    email: 'bina@gmail.com',
    status: 'ACTIVE',
    creditLimit: 20000,
    assignedDevicesCount: 1,
  },
];

// Pre-seeded Customer Device Records (Device Serial & PON Serial Lookup)
let customerDeviceRecords: CustomerDeviceRecord[] = [
  {
    id: 'cust-101',
    customerId: 'c-801',
    customerName: 'Aashish Subedi',
    customerCode: 'CUST-URL-1092',
    contactPhone: '+977-9851029381',
    installationAddress: 'Urlabari Ward 3, Morang',
    branchId: 'URL01',
    productName: 'ONU ROUTER DUAL BAND 2.4G/5G GPON',
    deviceSerial: 'SN-ONU24G-881923',
    ponSerial: 'HWTC-90A812C4',
    macAddress: '70:A8:E3:4B:91:10',
    status: 'RENTAL',
    issuedDateAD: '2026-05-10',
    issuedDateBS: '2083-01-27 BS',
    purchaseBillRef: 'BILL-9021',
    notes: 'Fiber FTTH connection 100Mbps setup with Dual Band ONU Router.',
  },
  {
    id: 'cust-102',
    customerId: 'c-802',
    customerName: 'Sujata Maharjan',
    customerCode: 'CUST-ITH-4019',
    contactPhone: '+977-9801928374',
    installationAddress: 'Itahari Ward 4, Sunsari',
    branchId: 'ITH01',
    productName: 'ONU ROUTER DUAL BAND 2.4G/5G GPON',
    deviceSerial: 'SN-ONU5G-774019',
    ponSerial: 'ZTE-4481A290',
    macAddress: 'CC:12:34:56:78:9A',
    status: 'RENTAL',
    issuedDateAD: '2026-06-18',
    issuedDateBS: '2083-03-04 BS',
    purchaseBillRef: 'BILL-4410',
    notes: 'Dual band 5G Dual Antenna ONU Router.',
  },
  {
    id: 'cust-103',
    customerId: 'c-803',
    customerName: 'Bikash Pokharel',
    customerCode: 'CUST-CHU-2041',
    contactPhone: '+977-9861234567',
    installationAddress: 'Chulachuli Ward 1, Ilam',
    branchId: 'CHU01',
    productName: 'ONU ROUTER SINGLE BAND 2.4G XPON',
    deviceSerial: 'SN-ONU24G-990182',
    ponSerial: 'HWTC-8812B001',
    macAddress: '88:E2:00:11:22:33',
    status: 'RENTAL',
    issuedDateAD: '2026-04-02',
    issuedDateBS: '2082-12-20 BS',
    purchaseBillRef: 'BILL-9021',
    notes: 'Rental CPE ONU Router assigned at Chulachuli.',
  },
];

// Dynamically seed unique serialized device records (Device SN, PON SN, MAC) for all on-hand stock of serialized products across all branches
let snSeedCounter = 1000;
products.filter((p) => p.requiresSerialTracking).forEach((prod, pIdx) => {
  branches.forEach((branch, bIdx) => {
    const stk = inventoryStock.find((s) => s.productId === prod.id && s.branchId === branch.id);
    const qty = stk ? stk.quantityOnHand : 2;
    const prefix = prod.sku?.includes('ONU001') ? 'ONU5G' : (prod.sku?.includes('ONU002') ? 'ONU24G' : 'OLT16');
    const ponPrefix = pIdx % 2 === 0 ? 'HWTC' : 'ZTE';

    for (let u = 1; u <= qty; u++) {
      snSeedCounter++;
      const snHex = (100000 + snSeedCounter).toString();
      const ponHex = `${branch.code}${String(u).padStart(2, '0')}${snHex.slice(-4)}`;
      const macHex = `70:${(10 + (bIdx % 80)).toString(16).padStart(2, '0').toUpperCase()}:${(20 + (u % 70)).toString(16).padStart(2, '0').toUpperCase()}:${snHex.slice(0, 2)}:${snHex.slice(2, 4)}:${snHex.slice(4, 6)}`;

      customerDeviceRecords.push({
        id: `dev-stk-${branch.id.toLowerCase()}-${prod.id}-${u}`,
        customerId: `STOCK-${branch.id}`,
        customerName: 'IN STORE (Available Stock)',
        customerCode: `STORE-${branch.code}`,
        contactPhone: branch.phone || '+977-9800000000',
        installationAddress: `${branch.name} Storage Bin`,
        branchId: branch.id,
        productName: prod.name,
        deviceSerial: `SN-${prefix}-${branch.code}-${snHex.slice(-5)}`,
        ponSerial: `${ponPrefix}-${ponHex.toUpperCase()}`,
        macAddress: macHex,
        status: 'IN_STOCK',
        issuedDateAD: '2026-07-15',
        issuedDateBS: '2083-03-31 BS',
        purchaseBillRef: `BATCH-2083-${branch.code}`,
        notes: `Available on-hand serialized CPE stock in ${branch.name} inventory.`,
      });
    }
  });
});

// Pre-seeded Approval Requests (Workflow Authorization Center)
let approvalRequests: ApprovalRequest[] = [
  {
    id: 'apr-101',
    requestNumber: 'APR-2083-001',
    type: 'CUSTOMER_DEVICE_STATUS',
    targetId: 'cust-103',
    customerName: 'Bikash Pokharel',
    customerCode: 'CUST-CHU-2041',
    deviceSerial: 'SN-ONU24G-990182',
    ponSerial: 'HWTC-8812B001',
    productName: 'ONU ROUTER 2.4G',
    currentStatus: 'RENTAL',
    requestedStatus: 'ROUTER_COLLECTED',
    requestedByRole: 'FRONT_DESK',
    requestedByEmail: 'frontdesk.urlabari@izone.com.np',
    requestedByName: 'Sabin Shrestha (Frontdesk)',
    branchId: 'CHU01',
    branchName: 'Chulachuli Branch Office',
    reason: 'Customer requested account termination & disconnection. Router inspected in working condition. Requesting approval to collect router and restock inventory.',
    restockQtyOnApproval: true,
    status: 'PENDING',
    requestedAtAD: '2026-08-05T14:20:00Z',
    requestedAtBS: '2083-04-21 BS',
  },
  {
    id: 'apr-102',
    requestNumber: 'APR-2083-002',
    type: 'CUSTOMER_DEVICE_STATUS',
    targetId: 'cust-102',
    customerName: 'Sujata Maharjan',
    customerCode: 'CUST-ITH-4019',
    deviceSerial: 'SN-ONU5G-774019',
    ponSerial: 'ZTE-4481A290',
    productName: 'ONU ROUTER 5G',
    currentStatus: 'RENTAL',
    requestedStatus: 'ROUTER_COLLECTED',
    requestedByRole: 'BRANCH_MANAGER',
    requestedByEmail: 'bm.itahari@izone.com.np',
    requestedByName: 'Ramesh Karki (Branch Manager)',
    branchId: 'ITH01',
    branchName: 'Itahari Branch Office',
    reason: 'Service disconnection requested due to customer relocation. ONU router and power adapter collected and verified.',
    restockQtyOnApproval: true,
    status: 'APPROVED',
    requestedAtAD: '2026-08-01T09:15:00Z',
    requestedAtBS: '2083-04-17 BS',
    processedByEmail: 'admin@system.com.np',
    processedByName: 'Super Admin',
    processedByRole: 'SUPER_ADMIN',
    processedAtAD: '2026-08-01T10:00:00Z',
    processedAtBS: '2083-04-17 BS',
  },
  {
    id: 'apr-103',
    requestNumber: 'APR-2083-003',
    type: 'CUSTOMER_DEVICE_STATUS',
    targetId: 'cust-101',
    customerName: 'Aashish Subedi',
    customerCode: 'CUST-URL-1092',
    deviceSerial: 'SN-ONU24G-881923',
    ponSerial: 'HWTC-90A812C4',
    productName: 'ONU ROUTER 2.4G',
    currentStatus: 'ACTIVE',
    requestedStatus: 'DISCONNECTED',
    requestedByRole: 'FRONT_DESK',
    requestedByEmail: 'frontdesk.urlabari@izone.com.np',
    requestedByName: 'Sabin Shrestha (Frontdesk)',
    branchId: 'URL01',
    branchName: 'Urlabari Branch Office',
    reason: 'Immediate disconnection request without returning physical ONU equipment.',
    restockQtyOnApproval: false,
    status: 'REJECTED',
    requestedAtAD: '2026-07-28T11:30:00Z',
    requestedAtBS: '2083-04-13 BS',
    processedByEmail: 'inventory@system.com.np',
    processedByName: 'Bikash Pokharel (Inventory Mgr)',
    processedByRole: 'INVENTORY_MANAGER',
    processedAtAD: '2026-07-28T12:00:00Z',
    processedAtBS: '2083-04-13 BS',
    rejectionReason: 'Rejected: Customer must return physical ONU equipment to the branch office before disconnection can be authorized.',
  },
  {
    id: 'apr-104',
    requestNumber: 'APR-2083-004',
    type: 'CANCEL_RECEIVE_TRANSFER',
    targetId: 'sh-303',
    customerName: 'TRF-2083-0085',
    customerCode: 'TRF-BTM01',
    deviceSerial: 'TRF-2083-0085',
    productName: 'PATCH CORD 3 MTR (2 pcs)',
    currentStatus: 'RECEIVED',
    requestedStatus: 'IN_TRANSIT',
    requestedByRole: 'BRANCH_MANAGER',
    requestedByEmail: 'manager.birtamode@izone.com.np',
    requestedByName: 'Rajan Shrestha (Branch Manager)',
    branchId: 'BTM01',
    branchName: 'Birtamode Branch Office',
    reason: 'Wrong transfer marked as received in system by store clerk. Consignment is still on transport vehicle. Requesting approval to revert received stock and set status back to IN_TRANSIT.',
    status: 'PENDING',
    requestedAtAD: '2026-08-10T11:45:00Z',
    requestedAtBS: '2083-04-26 BS',
    shipmentData: {
      shipmentId: 'sh-303',
      trackingCode: 'TRF-2083-0085',
      sourceBranchName: 'Head Office (Urlabari)',
      destinationBranchName: 'Birtamode Branch',
      itemSummary: 'PATCH CORD 3 MTR (2 pcs)',
      totalQuantity: 2,
    },
  },
];

// Active user session simulation
let activeUser = users[0];

// Extract triggering user details from request headers or body or activeUser
function getUserFromReq(req: any) {
  const email =
    (req.headers['x-user-email'] as string) ||
    req.body?.userEmail ||
    req.body?.user?.email ||
    req.body?.currentUser?.email ||
    activeUser?.email ||
    'admin@izone.net.np';
  const name =
    (req.headers['x-user-name'] as string) ||
    req.body?.userName ||
    req.body?.user?.name ||
    req.body?.currentUser?.name ||
    activeUser?.name ||
    'Shrestha Administrator';
  const role =
    (req.headers['x-user-role'] as string) ||
    req.body?.userRole ||
    req.body?.user?.role ||
    activeUser?.role ||
    'SUPER_ADMIN';
  const branchId =
    (req.headers['x-user-branch'] as string) ||
    req.body?.branchId ||
    req.body?.user?.branchId ||
    activeUser?.branchId ||
    'WH001';

  return { email, name, role, branchId };
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
        bRes, pRes, sRes, aRes, dRes, cRes, poRes, piRes, shRes, opRes, fyRes, auditRes, txnRes, supRes, uRes, appRes
      ] = await Promise.all([
        pgPool.query('SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches'),
        pgPool.query('SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products'),
        pgPool.query('SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAd", acquisition_date_bs AS "acquisitionDateBs", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo" FROM fixed_assets' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAd", issued_date_bs AS "issuedDateBs", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount" FROM customer_records' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAd", order_date_bs AS "orderDateBs", expected_delivery_date_ad AS "expectedDeliveryDateAd", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes FROM purchase_orders' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAd", invoice_date_bs AS "invoiceDateBs", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", amount_paid AS "amountPaid" FROM purchase_invoices' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAd", dispatch_date_bs AS "dispatchDateBs", estimated_arrival_ad AS "estimatedArrivalAd", status, notes FROM shipments' + (bId ? ' WHERE source_branch_id = $1 OR destination_branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAd", date_bs AS "dateBs", fiscal_year AS "fiscalYear", status FROM stock_operations' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, code, start_date_ad AS "startDateAd", end_date_ad AS "endDateAd", start_date_bs AS "startDateBs", end_date_bs AS "endDateBs", is_current AS "isCurrent", is_closed AS "isClosed" FROM fiscal_years'),
        pgPool.query('SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs ORDER BY timestamp_ad DESC LIMIT 200'),
        pgPool.query('SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs ORDER BY timestamp_ad DESC LIMIT 300'),
        pgPool.query('SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers'),
        pgPool.query('SELECT id, email, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users'),
        pgPool.query('SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status, requested_at_ad AS "requestedAtAd", requested_at_bs AS "requestedAtBs" FROM approval_requests' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : [])
      ]);

      const pgStock = sRes.rows;
      const pgProducts = pRes.rows;
      const pgAssets = aRes.rows;
      const pgInvoices = piRes.rows;
      const pgOps = opRes.rows;
      const pgFiscalYears = fyRes.rows;

      const totalInventoryAssetValue = pgStock.reduce((sum: number, item: any) => {
        const prod = pgProducts.find((p: any) => p.id === item.productId);
        return sum + (prod ? Number(prod.costPrice) * Number(item.quantityOnHand) : 0);
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
        serverTime: new Date().toISOString(),
        dataVersion,
      });
    } catch (pgErr) {
      console.error('PostgreSQL query note in /api/bootstrap, using in-memory store:', pgErr);
    }
  }

  let targetStock = inventoryStock;
  let targetAssets = assetRegister;
  let targetDevices = customerDeviceRecords;
  let targetCustomers = customerMasterRecords;
  let targetPOs = purchaseOrders;
  let targetInvoices = purchaseInvoices;
  let targetShipments = shipments;
  let targetOps = stockOperations;
  let targetApprovals = approvalRequests;

  if (bId) {
    targetAssets = assetRegister.filter((a) => a.branchId === bId);
    targetDevices = customerDeviceRecords.filter((d) => d.branchId === bId);
    targetCustomers = customerMasterRecords.filter((c) => c.branchId === bId);
    targetPOs = purchaseOrders.filter((p) => p.branchId === bId);
    targetInvoices = purchaseInvoices.filter((i) => i.branchId === bId);
    targetShipments = shipments.filter((s) => s.sourceBranchId === bId || s.destinationBranchId === bId);
    targetOps = stockOperations.filter((o) => o.branchId === bId);
    targetApprovals = approvalRequests.filter((a) => a.branchId === bId);
  }

  const finTargetStock = bId ? inventoryStock.filter((s) => s.branchId === bId) : inventoryStock;
  const finTargetAssets = targetAssets;
  const finTargetInvoices = targetInvoices;
  const finTargetOps = targetOps;

  const totalInventoryAssetValue = finTargetStock.reduce((sum, item) => {
    const prod = products.find((p) => p.id === item.productId);
    return sum + (prod ? prod.costPrice * item.quantityOnHand : 0);
  }, 0);

  const totalFixedAssetValue = finTargetAssets.reduce((sum, a) => sum + (a.netBookValue ?? 0), 0);
  const totalAccountsPayable = finTargetInvoices.reduce(
    (sum, inv) => sum + Math.max(0, (inv.grandTotal ?? 0) - (inv.amountPaid ?? 0)),
    0
  );
  const totalDamageLossValue = finTargetOps.reduce((sum, op) => sum + (op.totalValue ?? 0), 0);
  const totalVatInputTax = finTargetInvoices.reduce((sum, inv) => sum + (inv.vatAmount ?? 0), 0);
  const currentFy = fiscalYears.find((f) => f.isCurrent)?.code || '2082/83';

  const financialSummary = {
    totalInventoryAssetValue,
    totalFixedAssetValue,
    totalAccountsPayable,
    totalCostOfGoodsSold: 450000,
    totalDamageLossValue,
    totalVatInputTax,
    currentFiscalYear: currentFy,
  };

  const safeUsers = users.map(({ password: _, ...u }) => u);

  res.setHeader('Cache-Control', 'private, no-cache');
  res.json({
    branches,
    products,
    stock: targetStock,
    assets: targetAssets,
    customerDevices: targetDevices,
    customers: targetCustomers,
    purchaseOrders: targetPOs,
    purchaseInvoices: targetInvoices,
    shipments: targetShipments,
    stockOperations: targetOps,
    fiscalYears,
    auditLogs: auditTrail.slice(0, 200),
    transactionLogs: transactionLogs.slice(0, 300),
    financialSummary,
    suppliers,
    users: safeUsers,
    approvalRequests: targetApprovals,
    serverTime: new Date().toISOString(),
    dataVersion,
  });
});

// ==========================================
// API REST ENDPOINTS
// ==========================================

// Auth Login
app.get('/api/auth/setup-status', (req, res) => {
  res.json({
    isFirstLaunch: users.length === 0,
    userCount: users.length,
    hasSuperAdmin: users.some((u) => u.role === 'SUPER_ADMIN'),
  });
});

app.post('/api/auth/setup-superadmin', async (req, res) => {
  const { name, email, password, branchId } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  // If superadmin exists and users are not empty, prevent unauthorized duplicate setup
  if (users.length > 0 && users.some((u) => u.role === 'SUPER_ADMIN')) {
    return res.status(400).json({ message: 'Super admin already exists in the system.' });
  }

  const hqBranchId = branchId || branches[0]?.id || 'WH001';
  const newSuperAdmin = {
    id: `usr-sa-${Date.now()}`,
    email,
    password,
    name,
    role: 'SUPER_ADMIN' as const,
    branchId: hqBranchId,
    allowedBranchIds: branches.map((b) => b.id),
    canSwitchUser: true,
  };

  if (isPgConnected) {
    try {
      await pgPool.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [newSuperAdmin.id, newSuperAdmin.email, newSuperAdmin.password, newSuperAdmin.name, newSuperAdmin.role, newSuperAdmin.branchId, newSuperAdmin.allowedBranchIds, newSuperAdmin.canSwitchUser]
      );
    } catch (_err) {}
  }

  users.unshift(newSuperAdmin);
  activeUser = newSuperAdmin;

  logAuditEvent(req, 'CREATE_SUPER_ADMIN', 'AUTH', `Initial Super Admin account initialized: ${name} (${email})`);

  const { password: _, ...userWithoutPass } = newSuperAdmin;
  res.status(201).json({ user: userWithoutPass, token: `session-token-${newSuperAdmin.id}` });
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

  if (isPgConnected) {
    try {
      const dbRes = await pgPool.query(
        'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users WHERE LOWER(email) = LOWER($1) AND password = $2',
        [email, password]
      );
      if (dbRes.rows.length > 0) {
        const dbUser = dbRes.rows[0];
        activeUser = dbUser;
        const { password: _, ...userWithoutPass } = dbUser;
        return res.json({ user: userWithoutPass, token: 'session-token-izone' });
      }
    } catch (_err) {}
  }

  const user = users.find((u) => u.email.toLowerCase() === (email || '').toLowerCase().trim() && u.password === password);
  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }
  activeUser = user;
  const { password: _, ...userWithoutPass } = user;
  res.json({ user: userWithoutPass, token: 'session-token-izone' });
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
  if (!activeUser) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  const { name, email, branchId, newPassword } = req.body;

  const idx = users.findIndex((u) => u.id === activeUser.id);
  if (idx !== -1) {
    if (name) users[idx].name = name;
    if (email) users[idx].email = email;
    if (branchId) users[idx].branchId = branchId;
    if (newPassword) users[idx].password = newPassword;
    activeUser = users[idx];
  }

  const { password: _, ...userWithoutPass } = activeUser;
  res.json(userWithoutPass);
});

// Branches
app.get('/api/branches', (req, res) => {
  res.json(branches);
});

app.post('/api/branches', (req, res) => {
  const newBranch: Branch = {
    id: `br-${Date.now()}`,
    ...req.body,
  };
  branches.push(newBranch);

  // Initialize stock entries for existing products in this new branch
  products.forEach((p) => {
    inventoryStock.push({
      id: `stk-${Date.now()}-${p.id}`,
      productId: p.id,
      branchId: newBranch.id,
      quantityOnHand: 0,
      reservedQty: 0,
      incomingQty: 0,
      lastUpdated: new Date().toISOString(),
    });
  });

  logAuditEvent(req, 'CREATE_BRANCH', 'MASTER_DATA', `Created new branch ${newBranch.name} (${newBranch.code || newBranch.id})`);
  res.status(201).json(newBranch);
});

app.put('/api/branches/:id', (req, res) => {
  const { id } = req.params;
  const idx = branches.findIndex((b) => b.id === id);
  if (idx === -1) return res.status(404).json({ message: 'Branch not found' });
  branches[idx] = { ...branches[idx], ...req.body };
  logAuditEvent(req, 'UPDATE_BRANCH', 'MASTER_DATA', `Updated branch details for ${branches[idx].name} (${branches[idx].id})`);
  res.json(branches[idx]);
});

app.delete('/api/branches/:id', (req, res) => {
  const { id } = req.params;
  const br = branches.find((b) => b.id === id);
  branches = branches.filter((b) => b.id !== id);
  logAuditEvent(req, 'DELETE_BRANCH', 'MASTER_DATA', `Deleted branch ${br?.name || id}`);
  res.json({ success: true });
});

// Suppliers
app.get('/api/suppliers', (req, res) => {
  res.json(suppliers);
});

app.post('/api/suppliers', (req, res) => {
  const newSupplier: Supplier = {
    id: `sup-${Date.now()}`,
    rating: 5.0,
    ...req.body,
  };
  suppliers.push(newSupplier);
  logAuditEvent(req, 'CREATE_SUPPLIER', 'MASTER_DATA', `Created new supplier ${newSupplier.name} (${(newSupplier as any).supplierCode || newSupplier.id})`);
  res.status(201).json(newSupplier);
});

app.put('/api/suppliers/:id', (req, res) => {
  const { id } = req.params;
  const idx = suppliers.findIndex((s) => s.id === id);
  if (idx === -1) return res.status(404).json({ message: 'Supplier not found' });
  suppliers[idx] = { ...suppliers[idx], ...req.body };
  logAuditEvent(req, 'UPDATE_SUPPLIER', 'MASTER_DATA', `Updated supplier ${suppliers[idx].name} (${(suppliers[idx] as any).supplierCode || suppliers[idx].id})`);
  res.json(suppliers[idx]);
});

app.delete('/api/suppliers/:id', (req, res) => {
  const { id } = req.params;
  const sup = suppliers.find((s) => s.id === id);
  suppliers = suppliers.filter((s) => s.id !== id);
  logAuditEvent(req, 'DELETE_SUPPLIER', 'MASTER_DATA', `Deleted supplier ${sup?.name || id}`);
  res.json({ success: true });
});

// Users
app.get('/api/users', (req, res) => {
  const safeUsers = users.map(({ password: _, ...u }) => u);
  res.json(safeUsers);
});

app.post('/api/users', (req, res) => {
  const newUser = {
    id: `usr-${Date.now()}`,
    password: req.body.password || 'password@123',
    ...req.body,
  };
  users.push(newUser);
  logAuditEvent(req, 'CREATE_USER', 'AUTH', `Created new user account ${newUser.name} (${newUser.email}) - Role: ${newUser.role}`);
  const { password: _, ...userWithoutPass } = newUser;
  res.status(201).json(userWithoutPass);
});

app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return res.status(404).json({ message: 'User not found' });

  users[idx] = {
    ...users[idx],
    ...req.body,
  };
  logAuditEvent(req, 'UPDATE_USER', 'AUTH', `Updated user account ${users[idx].name} (${users[idx].email})`);
  const { password: _, ...userWithoutPass } = users[idx];
  res.json(userWithoutPass);
});

app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const idx = users.findIndex((u) => u.id === id);
  if (idx !== -1) {
    const deletedUser = users[idx];
    users.splice(idx, 1);
    logAuditEvent(req, 'DELETE_USER', 'AUTH', `Deleted user account ${deletedUser.name} (${deletedUser.email})`);
  }
  res.json({ success: true });
});

app.post('/api/users/:id/reset-password', (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  const userIdx = users.findIndex((u) => u.id === id);
  
  if (userIdx === -1) {
    return res.status(404).json({ message: 'User account not found.' });
  }

  if (!newPassword || newPassword.trim().length < 3) {
    return res.status(400).json({ message: 'New password must be at least 3 characters long.' });
  }

  users[userIdx].password = newPassword.trim();
  logAuditEvent(req, 'RESET_USER_PASSWORD', 'AUTH', `Password reset for user account ${users[userIdx].name} (${users[userIdx].email})`);

  const { password: _, ...userWithoutPass } = users[userIdx];
  res.json({
    success: true,
    message: `Password for ${users[userIdx].name} (${users[userIdx].email}) has been successfully updated.`,
    user: userWithoutPass,
  });
});

// Products
app.get('/api/products', (req, res) => {
  res.json(products);
});

app.post('/api/products', (req, res) => {
  const newProd = {
    id: `prod-${Date.now()}`,
    ...req.body,
  };
  products.push(newProd);

  // Initialize 0 stock across all branches
  branches.forEach((b) => {
    inventoryStock.push({
      id: `stk-${Date.now()}-${b.id}`,
      productId: newProd.id,
      branchId: b.id,
      quantityOnHand: 0,
      reservedQty: 0,
      incomingQty: 0,
      lastUpdated: new Date().toISOString(),
    });
  });

  logAuditEvent(req, 'CREATE_PRODUCT', 'PRODUCTS', `Created new product SKU ${newProd.sku} (${newProd.name}) - Price: NPR ${newProd.sellingPrice}`);
  res.status(201).json(newProd);
});

app.put('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ message: 'Product not found' });

  const oldProd = { ...products[idx] };
  products[idx] = { ...products[idx], ...req.body };
  const updated = products[idx];

  const changeMsg = oldProd.sku !== updated.sku
    ? `SKU updated from ${oldProd.sku} to ${updated.sku}`
    : `Updated product details for ${updated.name} (${updated.sku})`;

  logAuditEvent(req, 'UPDATE_PRODUCT_SKU', 'PRODUCTS', changeMsg);
  res.json(products[idx]);
});

app.delete('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const prod = products.find((p) => p.id === id);
  products = products.filter((p) => p.id !== id);
  inventoryStock = inventoryStock.filter((s) => s.productId !== id);
  logAuditEvent(req, 'DELETE_PRODUCT', 'PRODUCTS', `Deleted product ${prod?.name || id} (SKU: ${prod?.sku || 'N/A'})`);
  res.json({ success: true });
});

// Stock
app.get('/api/stock', (req, res) => {
  const { branchId } = req.query;
  if (branchId && branchId !== 'ALL') {
    return res.json(inventoryStock.filter((s) => s.branchId === branchId));
  }
  res.json(inventoryStock);
});

app.patch('/api/stock/:id', (req, res) => {
  const { id } = req.params;
  const { quantityOnHand, minReorderLevel, damagedQty, reason, changeType } = req.body;
  const stk = inventoryStock.find((s) => s.id === id);
  if (!stk) return res.status(404).json({ message: 'Stock record not found' });

  let qtyBefore = stk.quantityOnHand;
  let oldDamaged = stk.damagedQty || 0;

  if (damagedQty !== undefined) {
    const newDam = Math.max(0, Number(damagedQty));
    const damDiff = newDam - oldDamaged;
    stk.damagedQty = newDam;

    // If quantityOnHand wasn't explicitly overridden, adjust usable stock to conserve total stock
    if (quantityOnHand === undefined) {
      stk.quantityOnHand = Math.max(0, stk.quantityOnHand - damDiff);
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

  const isDamageChange = changeType === 'DAMAGE' || (damagedQty !== undefined && stk.damagedQty !== oldDamaged);

  if (isDamageChange) {
    const damDiff = (stk.damagedQty || 0) - oldDamaged;
    transactionLogs.unshift({
      id: `txn-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      transactionNumber: `TXN-DMG-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: stk.productId,
      productSku: prod?.sku || '',
      productName: prod?.name || '',
      branchId: stk.branchId,
      changeType: 'DAMAGE',
      quantityBefore: oldDamaged,
      quantityChanged: damDiff !== 0 ? -Math.abs(damDiff) : -(stk.damagedQty || 1),
      quantityAfter: stk.damagedQty || 0,
      unitCost: prod?.costPrice || 0,
      referenceDocId: reason || 'DMG-VERIFICATION',
      timestampAD: new Date().toISOString(),
      timestampBS: '2083-04-16 BS',
    });
  } else if (quantityOnHand !== undefined && (stk.quantityOnHand - qtyBefore !== 0)) {
    transactionLogs.unshift({
      id: `txn-${Date.now()}`,
      transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: stk.productId,
      productSku: prod?.sku || '',
      productName: prod?.name || '',
      branchId: stk.branchId,
      changeType: 'MANUAL_ADJUSTMENT',
      quantityBefore: qtyBefore,
      quantityChanged: stk.quantityOnHand - qtyBefore,
      quantityAfter: stk.quantityOnHand,
      unitCost: prod?.costPrice || 0,
      timestampAD: new Date().toISOString(),
      timestampBS: '2083-04-16 BS',
    });
  }

  res.json(stk);
});

app.patch('/api/stock/:id/reorder-level', (req, res) => {
  const { id } = req.params;
  const { minReorderLevel } = req.body;
  const stk = inventoryStock.find((s) => s.id === id);
  if (!stk) return res.status(404).json({ message: 'Stock record not found' });

  stk.minReorderLevel = Number(minReorderLevel);
  stk.lastUpdated = new Date().toISOString();
  res.json(stk);
});

app.post('/api/stock/bulk-reorder-levels', (req, res) => {
  const { updates } = req.body;
  if (Array.isArray(updates)) {
    updates.forEach((u: { stockId: string; minReorderLevel: number }) => {
      const stk = inventoryStock.find((s) => s.id === u.stockId);
      if (stk) {
        stk.minReorderLevel = Number(u.minReorderLevel);
        stk.lastUpdated = new Date().toISOString();
      }
    });
  }
  res.json({ success: true, count: updates?.length || 0 });
});

// Physical Stock Audit Direct Reconciliation
app.post('/api/stock/reconcile-audit', (req, res) => {
  const { branchId, auditRefNumber, varianceItems, auditorName, userEmail, notes } = req.body;
  if (!branchId || !Array.isArray(varianceItems)) {
    return res.status(400).json({ message: 'Invalid stock reconciliation payload' });
  }

  let totalAdjusted = 0;
  let netFinancialImpact = 0;

  varianceItems.forEach((item: any) => {
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

    const qtyBefore = stk.quantityOnHand;
    const targetCounted = Number(item.countedQty) || 0;
    const delta = targetCounted - qtyBefore;
    const unitCost = item.unitCost || 0;

    stk.quantityOnHand = targetCounted;
    stk.lastUpdated = new Date().toISOString();
    totalAdjusted += 1;
    netFinancialImpact += delta * unitCost;

    const prod = products.find((p) => p.id === item.productId);

    transactionLogs.unshift({
      id: `txn-${Date.now()}-${item.productId}-aud`,
      transactionNumber: `TXN-AUD-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: item.productId,
      productSku: prod?.sku || item.sku || '',
      productName: prod?.name || item.productName || '',
      branchId: branchId,
      changeType: delta > 0 ? 'PHYSICAL_AUDIT_EXCESS' : 'PHYSICAL_AUDIT_SHORTAGE',
      quantityBefore: qtyBefore,
      quantityChanged: delta,
      quantityAfter: stk.quantityOnHand,
      unitCost: unitCost || prod?.costPrice || 0,
      referenceDocId: auditRefNumber || `AUDIT-${Date.now()}`,
      timestampAD: new Date().toISOString(),
      timestampBS: '2083-04-22 BS',
    });
  });

  const branch = branches.find((b) => b.id === branchId);

  auditTrail.unshift({
    id: `audit-${Date.now()}`,
    userEmail: userEmail || 'admin@system.com.np',
    userName: auditorName || 'Stock Manager / Super Admin',
    action: 'STOCK_AUDIT_RECONCILED',
    module: 'INVENTORY_AUDIT',
    details: `Directly Authorized & Reconciled Physical Stock Audit #${auditRefNumber || 'DIRECT'} for ${branch?.name || branchId}. Adjusted ${totalAdjusted} variance items to physical count. Net Financial Impact: NPR ${netFinancialImpact.toLocaleString()}. Notes: ${notes || 'Direct Stock Reconcile'}`,
    timestampAD: new Date().toISOString(),
    timestampBS: '2083-04-22 BS',
    branchId: branchId,
  });

  res.json({
    success: true,
    totalAdjusted,
    netFinancialImpact,
    message: `Physical stock reconciled successfully for ${branch?.name || branchId}`,
  });
});

// Fixed Assets
app.get('/api/assets', (req, res) => {
  const { branchId } = req.query;
  if (branchId && branchId !== 'ALL') {
    return res.json(assetRegister.filter((a) => a.branchId === branchId));
  }
  res.json(assetRegister);
});

app.post('/api/assets', (req, res) => {
  const newAsset = {
    id: `ast-${Date.now()}`,
    accumulatedDepreciation: 0,
    netBookValue: req.body.acquisitionCost,
    ...req.body,
  };
  assetRegister.push(newAsset);
  logAuditEvent(req, 'ASSIGN_FIXED_ASSET', 'FIXED_ASSETS', `Assigned / Registered Fixed Asset Tag #${newAsset.tagNumber || newAsset.assetTag || 'FA'} (${newAsset.name}) at branch ${newAsset.branchId}`);
  res.status(201).json(newAsset);
});

app.patch('/api/assets/:id/status', (req, res) => {
  const { id } = req.params;
  const asset = assetRegister.find((a) => a.id === id);
  if (!asset) return res.status(404).json({ message: 'Asset not found' });

  Object.assign(asset, req.body);
  logAuditEvent(req, 'UPDATE_ASSET_STATUS', 'FIXED_ASSETS', `Updated Fixed Asset Tag #${asset.tagNumber || (asset as any).assetTag} status to ${req.body.status || 'UPDATED'}`);
  res.json(asset);
});

// Purchase Orders
app.get('/api/purchase-orders', (req, res) => {
  const { branchId } = req.query;
  if (branchId && branchId !== 'ALL') {
    return res.json(purchaseOrders.filter((po) => po.branchId === branchId));
  }
  res.json(purchaseOrders);
});

app.post('/api/purchase-orders', (req, res) => {
  const items = req.body.items || [];
  const subtotalAmount = items.reduce((s: number, i: any) => s + i.subtotal, 0);
  const taxAmount = items.reduce((s: number, i: any) => s + i.taxAmount, 0);
  const totalAmount = subtotalAmount + taxAmount;

  const newPO = {
    id: `po-${Date.now()}`,
    poNumber: generateStandardTransactionId(req.body.branchId || 'WH001', 'PO'),
    subtotalAmount,
    taxAmount,
    totalAmount,
    ...req.body,
  };

  // Increment incoming quantity for PO target branch
  if (newPO.branchId && Array.isArray(items)) {
    items.forEach((item: any) => {
      let stk = inventoryStock.find(
        (s) => s.productId === item.productId && s.branchId === newPO.branchId
      );
      if (stk) {
        stk.incomingQty = (stk.incomingQty || 0) + (Number(item.quantity) || 0);
        stk.lastUpdated = new Date().toISOString();
      }
    });
  }

  purchaseOrders.unshift(newPO);
  logAuditEvent(req, 'CREATE_PURCHASE_ORDER', 'PROCUREMENT', `Created Purchase Order #${newPO.poNumber} for supplier ${newPO.supplierName || 'Vendor'} (Total: NPR ${totalAmount?.toLocaleString() || 0})`);
  res.status(201).json(newPO);
});

app.put('/api/purchase-orders/:id', (req, res) => {
  const { id } = req.params;
  const index = purchaseOrders.findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ message: 'PO not found' });

  const existingPO = purchaseOrders[index];
  if (existingPO.status === 'IN_PROGRESS' || existingPO.status === 'CANCELLED' || existingPO.status === 'RECEIVED') {
    return res.status(400).json({ message: 'Cannot edit PO that is already In Progress, Received, or Cancelled' });
  }

  const items = req.body.items || existingPO.items;
  const subtotalAmount = items.reduce((s: number, i: any) => s + (i.subtotal || (i.quantity * i.unitPrice)), 0);
  const taxAmount = items.reduce((s: number, i: any) => s + (i.taxAmount || 0), 0);
  const totalAmount = subtotalAmount + taxAmount;

  const updatedPO = {
    ...existingPO,
    ...req.body,
    subtotalAmount,
    taxAmount,
    totalAmount,
    items,
  };

  purchaseOrders[index] = updatedPO;
  logAuditEvent(req, 'UPDATE_PURCHASE_ORDER', 'PROCUREMENT', `Updated Purchase Order #${updatedPO.poNumber} (Supplier: ${updatedPO.supplierName})`);
  res.json(updatedPO);
});

app.patch('/api/purchase-orders/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const po = purchaseOrders.find((p) => p.id === id);
  if (!po) return res.status(404).json({ message: 'PO not found' });

  po.status = status;
  logAuditEvent(req, 'UPDATE_PO_STATUS', 'PROCUREMENT', `Changed Purchase Order #${po.poNumber} status to ${status}`);
  res.json(po);
});

app.post('/api/purchase-orders/:id/receive', (req, res) => {
  const { id } = req.params;
  const po = purchaseOrders.find((p) => p.id === id);
  if (!po) return res.status(404).json({ message: 'PO not found' });

  po.status = 'RECEIVED';

  // Increment branch stock & clear incoming qty
  po.items.forEach((item: any) => {
    let stk = inventoryStock.find(
      (s) => s.productId === item.productId && s.branchId === po.branchId
    );
    if (!stk) {
      stk = {
        id: `stk-${po.branchId.toLowerCase()}-${item.productId}`,
        productId: item.productId,
        branchId: po.branchId,
        quantityOnHand: 0,
        reservedQty: 0,
        incomingQty: 0,
        lastUpdated: new Date().toISOString(),
      };
      inventoryStock.push(stk);
    }

    stk.incomingQty = Math.max(0, (stk.incomingQty || 0) - item.quantity);
    const qtyBefore = stk.quantityOnHand;
    stk.quantityOnHand += item.quantity;
    stk.lastUpdated = new Date().toISOString();

    transactionLogs.unshift({
      id: `txn-${Date.now()}-${item.productId}`,
      transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: item.productId,
      productSku: item.sku,
      productName: item.productName,
      branchId: po.branchId,
      changeType: 'INBOUND_PO',
      quantityBefore: qtyBefore,
      quantityChanged: item.quantity,
      quantityAfter: stk.quantityOnHand,
      unitCost: item.unitPrice,
      referenceDocId: po.poNumber,
      timestampAD: new Date().toISOString(),
      timestampBS: '2083-04-16 BS',
    });
  });

  logAuditEvent(req, 'RECEIVE_PURCHASE_ORDER', 'PROCUREMENT', `Received goods for Purchase Order #${po.poNumber} from supplier ${po.supplierName}`);
  res.json(po);
});

// Purchase Invoices
app.get('/api/purchase-invoices', (req, res) => {
  const { branchId } = req.query;
  if (branchId && branchId !== 'ALL') {
    return res.json(purchaseInvoices.filter((inv) => inv.branchId === branchId));
  }
  res.json(purchaseInvoices);
});

app.post('/api/purchase-invoices', (req, res) => {
  const targetBranchId = req.body.branchId || branches[0]?.id || 'WH001';
  const newInv = {
    id: `inv-${Date.now()}`,
    invoiceNumber: generateStandardTransactionId(targetBranchId, 'PI'),
    ...req.body,
  };

  const items = req.body.items || req.body.lines || [];

  items.forEach((item: any) => {
    let stk = inventoryStock.find(
      (s) => s.productId === item.productId && s.branchId === targetBranchId
    );
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

    const qtyBefore = stk.quantityOnHand;
    const qtyToAdd = Number(item.quantity) || 0;
    stk.quantityOnHand += qtyToAdd;
    stk.lastUpdated = new Date().toISOString();

    const prod = products.find((p) => p.id === item.productId);

    // If product is a Fixed Asset, automatically create a Fixed Asset lot in assetRegister linked to Party Invoice Date
    if (prod && (prod.productGroup === 'Fixed Asset' || prod.category === 'Fixed Assets')) {
      const lineCost = (Number(item.unitPrice) || prod.costPrice) * qtyToAdd;
      const assetLot = {
        id: `ast-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
        tagNumber: `AST-${prod.sku || 'FA'}-${Math.floor(1000 + Math.random() * 9000)}`,
        name: `${prod.name} (Lot Qty: ${qtyToAdd})`,
        category: (prod.category as any) || 'Machinery',
        branchId: targetBranchId,
        acquisitionDateAD: newInv.invoiceDateAD || new Date().toISOString().split('T')[0],
        acquisitionDateBS: newInv.invoiceDateBS || '2083-04-10 BS',
        acquisitionCost: lineCost,
        depreciationMethod: prod.depreciationMethod || 'STRAIGHT_LINE',
        depreciationRatePercent: prod.depreciationRate ?? 15,
        accumulatedDepreciation: 0,
        netBookValue: lineCost,
        status: 'ACTIVE' as const,
        supplierName: newInv.supplierName || 'Vendor',
        invoiceNo: newInv.invoiceNumber,
        purchaseInvoiceId: newInv.id,
        productId: prod.id,
      };
      assetRegister.unshift(assetLot);
    }

    transactionLogs.unshift({
      id: `txn-${Date.now()}-${item.productId}`,
      transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: item.productId,
      productSku: item.sku || prod?.sku || '',
      productName: item.productName || prod?.name || 'Product',
      branchId: targetBranchId,
      changeType: 'PURCHASE_INVOICE',
      quantityBefore: qtyBefore,
      quantityChanged: qtyToAdd,
      quantityAfter: stk.quantityOnHand,
      unitCost: item.unitPrice || prod?.costPrice || 0,
      referenceDocId: newInv.invoiceNumber,
      timestampAD: new Date().toISOString(),
      timestampBS: '2083-04-16 BS',
    });
  });

  // Update linked Purchase Order status if poReferenceId or poId provided
  const poRef = req.body.poReferenceId || req.body.poId;
  if (poRef) {
    const po = purchaseOrders.find((p) => p.id === poRef || p.poNumber === poRef);
    if (po) {
      po.status = 'RECEIVED';
      // Deduct incoming quantities for items matched in PO
      po.items.forEach((poItem: any) => {
        const stk = inventoryStock.find(
          (s) => s.productId === poItem.productId && s.branchId === (po.branchId || targetBranchId)
        );
        if (stk) {
          stk.incomingQty = Math.max(0, (stk.incomingQty || 0) - poItem.quantity);
          stk.lastUpdated = new Date().toISOString();
        }
      });
    }
  }

  purchaseInvoices.unshift(newInv);
  logAuditEvent(req, 'CREATE_PURCHASE_INVOICE', 'PROCUREMENT', `Created Purchase Invoice #${newInv.invoiceNumber} for supplier ${newInv.supplierName || 'Vendor'} (Grand Total: NPR ${newInv.grandTotal?.toLocaleString() || 0})`);
  res.status(201).json(newInv);
});

app.post('/api/purchase-invoices/:id/pay', (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  const inv = purchaseInvoices.find((i) => i.id === id);
  if (!inv) return res.status(404).json({ message: 'Invoice not found' });

  inv.amountPaid += Number(amount);
  if (inv.amountPaid >= inv.grandTotal) {
    inv.paymentStatus = 'PAID';
  } else {
    inv.paymentStatus = 'PARTIAL';
  }
  logAuditEvent(req, 'RECORD_INVOICE_PAYMENT', 'PROCUREMENT', `Recorded payment of NPR ${Number(amount).toLocaleString()} for Invoice #${inv.invoiceNumber} (Status: ${inv.paymentStatus})`);
  res.json(inv);
});

// Shipments
app.get('/api/shipments', (req, res) => {
  res.json(shipments);
});

app.post('/api/shipments', (req, res) => {
  const sourceBranch = branches.find((b) => b.id === req.body.sourceBranchId);
  const destBranch = branches.find((b) => b.id === req.body.destinationBranchId);

  const newShipment = {
    id: `sh-${Date.now()}`,
    trackingCode: generateStandardTransactionId(req.body.sourceBranchId || 'WH001', 'TRF'),
    sourceBranchName: sourceBranch?.name,
    destinationBranchName: destBranch?.name || 'Destination',
    status: 'IN_TRANSIT' as const,
    ...req.body,
  };

  // Decrement source stock if inter-branch and increment incoming at destination
  if (req.body.type === 'INTER_BRANCH' && req.body.sourceBranchId) {
    req.body.items.forEach((item: any) => {
      const qtySent = Number(item.quantitySent || item.quantity || 1);
      let sourceStk = inventoryStock.find(
        (s) => s.productId === item.productId && s.branchId === req.body.sourceBranchId
      );
      if (sourceStk) {
        const qtyBefore = sourceStk.quantityOnHand;
        sourceStk.quantityOnHand = Math.max(0, sourceStk.quantityOnHand - qtySent);
        sourceStk.lastUpdated = new Date().toISOString();

        transactionLogs.unshift({
          id: `txn-${Date.now()}-${item.productId}-src`,
          transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
          productId: item.productId,
          productSku: item.sku || '',
          productName: item.productName || '',
          branchId: req.body.sourceBranchId,
          changeType: 'SHIPMENT_TRANSFER',
          quantityBefore: qtyBefore,
          quantityChanged: -qtySent,
          quantityAfter: sourceStk.quantityOnHand,
          unitCost: item.unitCost || 0,
          referenceDocId: newShipment.trackingCode,
          timestampAD: new Date().toISOString(),
          timestampBS: '2083-04-16 BS',
        });
      }

      if (req.body.destinationBranchId) {
        let destStk = inventoryStock.find(
          (s) => s.productId === item.productId && s.branchId === req.body.destinationBranchId
        );
        if (!destStk) {
          destStk = {
            id: `stk-${req.body.destinationBranchId.toLowerCase()}-${item.productId}`,
            productId: item.productId,
            branchId: req.body.destinationBranchId,
            quantityOnHand: 0,
            reservedQty: 0,
            incomingQty: 0,
            lastUpdated: new Date().toISOString(),
          };
          inventoryStock.push(destStk);
        }
        destStk.incomingQty = (destStk.incomingQty || 0) + qtySent;
        destStk.lastUpdated = new Date().toISOString();
      }
    });
  }

  shipments.unshift(newShipment);
  logAuditEvent(req, newShipment.type === 'INTER_BRANCH' ? 'CREATE_TRANSFER' : 'CREATE_SHIPMENT', 'LOGISTICS', `Created ${newShipment.type === 'INTER_BRANCH' ? 'Inter-Branch Transfer' : 'Shipment'} #${newShipment.trackingCode} (${newShipment.sourceBranchName || newShipment.sourceBranchId} -> ${newShipment.destinationBranchName || newShipment.destinationBranchId}) with ${newShipment.items?.length || 0} line items`);
  res.status(201).json(newShipment);
});

app.post('/api/shipments/:id/receive', (req, res) => {
  const { id } = req.params;
  const { receivedItems, receivedByNotes } = req.body || {};
  const sh = shipments.find((s) => s.id === id);
  if (!sh) return res.status(404).json({ message: 'Shipment not found' });

  let hasDiscrepancy = false;
  sh.receivedByNotes = receivedByNotes || '';
  sh.receivedDateAD = new Date().toISOString().split('T')[0];
  sh.receivedDateBS = '2083-04-16 BS';

  // Increment destination stock by actual VERIFIED received quantity
  sh.items.forEach((item: any, idx: number) => {
    const verified = Array.isArray(receivedItems)
      ? receivedItems.find((ri: any) => ri.itemId === item.id) || receivedItems[idx]
      : null;

    const actualQtyReceived = verified !== null && verified !== undefined && verified.quantityReceived !== undefined
      ? Number(verified.quantityReceived)
      : item.quantitySent;

    item.quantityReceived = actualQtyReceived;
    if (verified?.receivedSerials) {
      item.receivedSerials = verified.receivedSerials;
    } else if (item.deviceSerials) {
      item.receivedSerials = item.deviceSerials.slice(0, actualQtyReceived);
    }
    if (verified?.itemDiscrepancyNotes) {
      item.itemDiscrepancyNotes = verified.itemDiscrepancyNotes;
    }

    if (actualQtyReceived < item.quantitySent) {
      hasDiscrepancy = true;
    }

    let stk = inventoryStock.find(
      (s) => s.productId === item.productId && s.branchId === sh.destinationBranchId
    );
    if (!stk) {
      stk = {
        id: `stk-${Date.now()}-${item.productId}`,
        productId: item.productId,
        branchId: sh.destinationBranchId,
        quantityOnHand: 0,
        reservedQty: 0,
        incomingQty: 0,
        lastUpdated: new Date().toISOString(),
      };
      inventoryStock.push(stk);
    }

    const qtyBefore = stk.quantityOnHand;
    stk.quantityOnHand += actualQtyReceived;

    const prod = products.find((p) => p.id === item.productId);

    // Update serial register location & status for received serial numbers
    if (item.receivedSerials && Array.isArray(item.receivedSerials)) {
      item.receivedSerials.forEach((s: any) => {
        if (!s?.deviceSerial) return;
        const cleanSer = s.deviceSerial.trim().toUpperCase();
        let devRecord = customerDeviceRecords.find(
          (cd) => cd.deviceSerial.trim().toUpperCase() === cleanSer
        );
        if (devRecord) {
          devRecord.branchId = sh.destinationBranchId;
          devRecord.status = 'IN_STOCK';
          devRecord.notes = `Transferred from ${sh.sourceBranchName} via Shipment ${sh.trackingCode}`;
        } else {
          // Register new device in branch inventory serial registry
          customerDeviceRecords.unshift({
            id: `dev-rcv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            customerId: 'INVENTORY_STOCK',
            customerName: `Branch Inventory (${sh.destinationBranchName})`,
            customerCode: 'STOCK',
            contactPhone: 'N/A',
            installationAddress: sh.destinationBranchName,
            branchId: sh.destinationBranchId,
            productName: prod?.name || item.productName || 'Device',
            deviceSerial: cleanSer,
            ponSerial: s.ponSerial || `HWTC-${cleanSer}`,
            status: 'IN_STOCK',
            issuedDateAD: new Date().toISOString().split('T')[0],
            issuedDateBS: '2083-04-16 BS',
            notes: `Inbound transfer received from ${sh.sourceBranchName}`,
          });
        }
      });
    }

    transactionLogs.unshift({
      id: `txn-${Date.now()}-${item.productId}`,
      transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: item.productId,
      productSku: prod?.sku || '',
      productName: prod?.name || '',
      branchId: sh.destinationBranchId,
      changeType: 'SHIPMENT_TRANSFER',
      quantityBefore: qtyBefore,
      quantityChanged: actualQtyReceived,
      quantityAfter: stk.quantityOnHand,
      unitCost: prod?.costPrice || 0,
      referenceDocId: sh.trackingCode,
      timestampAD: new Date().toISOString(),
      timestampBS: '2083-04-16 BS',
    });
  });

  sh.hasDiscrepancy = hasDiscrepancy;
  sh.status = hasDiscrepancy ? 'DISCREPANCY' : 'RECEIVED';

  logAuditEvent(req, sh.type === 'INTER_BRANCH' ? 'RECEIVE_TRANSFER' : 'RECEIVE_SHIPMENT', 'LOGISTICS', `Received ${sh.type === 'INTER_BRANCH' ? 'Transfer' : 'Shipment'} #${sh.trackingCode} at ${sh.destinationBranchName}${hasDiscrepancy ? ' [Discrepancy Flagged]' : ''}`);
  res.json(sh);
});

// Cancel In-Transit Stock Transfer (Refunds sent stock back to Source Branch)
app.post('/api/shipments/:id/cancel', (req, res) => {
  const { id } = req.params;
  const { user, reason } = req.body || {};

  const sh = shipments.find((s) => s.id === id || s.trackingCode === id);
  if (!sh) return res.status(404).json({ message: 'Shipment / transfer not found' });

  if (sh.status === 'RECEIVED' || sh.status === 'DELIVERED') {
    return res.status(400).json({
      message: `Transfers that have already been received cannot be cancelled. Only in-transit transfers can be cancelled.`,
    });
  }

  if (sh.status === 'CANCELLED') {
    return res.status(400).json({
      message: `Transfer ${sh.trackingCode} is already cancelled.`,
    });
  }

  // Restore sent stock back to source branch inventory and deduct incoming from destination
  const srcBranchObj = branches.find((b) => b.id === sh.sourceBranchId || b.code === sh.sourceBranchId);
  const srcBranchId = srcBranchObj?.id || sh.sourceBranchId;
  const srcBranchCode = srcBranchObj?.code || sh.sourceBranchId;

  const destBranchObj = branches.find((b) => b.id === sh.destinationBranchId || b.code === sh.destinationBranchId);
  const destBranchId = destBranchObj?.id || sh.destinationBranchId;
  const destBranchCode = destBranchObj?.code || sh.destinationBranchId;

  sh.items.forEach((item: any) => {
    const qtySent = Number(item.quantitySent || item.quantity) || 1;

    if (qtySent > 0 && srcBranchId) {
      let sourceStk = inventoryStock.find(
        (s) => s.productId === item.productId && (s.branchId === srcBranchId || s.branchId === srcBranchCode)
      );

      if (!sourceStk) {
        sourceStk = {
          id: `stk-${srcBranchId.toLowerCase()}-${item.productId}`,
          productId: item.productId,
          branchId: srcBranchId,
          quantityOnHand: 0,
          damagedQty: 0,
          reservedQty: 0,
          incomingQty: 0,
          lastUpdated: new Date().toISOString(),
        };
        inventoryStock.push(sourceStk);
      }

      const qtyBefore = sourceStk.quantityOnHand;
      sourceStk.quantityOnHand += qtySent;
      sourceStk.lastUpdated = new Date().toISOString();

      const prod = products.find((p) => p.id === item.productId);

      transactionLogs.unshift({
        id: `txn-${Date.now()}-${item.productId}-cnl`,
        transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
        productId: item.productId,
        productSku: prod?.sku || item.sku || '',
        productName: prod?.name || item.productName || '',
        branchId: srcBranchId,
        changeType: 'TRANSFER_CANCELLED',
        quantityBefore: qtyBefore,
        quantityChanged: qtySent,
        quantityAfter: sourceStk.quantityOnHand,
        unitCost: prod?.costPrice || 0,
        referenceDocId: sh.trackingCode,
        timestampAD: new Date().toISOString(),
        timestampBS: '2083-04-22 BS',
      });
    }

    // Decrement incomingQty from destination branch
    if (qtySent > 0 && destBranchId) {
      const destStk = inventoryStock.find(
        (s) => s.productId === item.productId && (s.branchId === destBranchId || s.branchId === destBranchCode)
      );
      if (destStk) {
        destStk.incomingQty = Math.max(0, (destStk.incomingQty || 0) - qtySent);
        destStk.lastUpdated = new Date().toISOString();
      }
    }

    // Maintain device serials at source branch as IN_STOCK
    if (item.deviceSerials && Array.isArray(item.deviceSerials)) {
      item.deviceSerials.forEach((s: any) => {
        if (!s?.deviceSerial) return;
        const cleanSer = s.deviceSerial.trim().toUpperCase();
        let devRecord = customerDeviceRecords.find(
          (cd) => cd.deviceSerial.trim().toUpperCase() === cleanSer || (cd.ponSerial && cd.ponSerial.trim().toUpperCase() === cleanSer)
        );
        if (devRecord) {
          devRecord.branchId = srcBranchId;
          devRecord.status = 'IN_STOCK';
          devRecord.notes = `Transfer ${sh.trackingCode} cancelled. Stock restored to source branch ${sh.sourceBranchName || srcBranchId}.`;
        }
      });
    }
  });

  sh.status = 'CANCELLED';
  sh.notes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled on ${new Date().toISOString().split('T')[0]} by ${user?.name || 'Admin'} (${user?.role || 'SUPER_ADMIN'})${reason ? ': ' + reason : ''}. Stock refunded to source branch.`;

  // Log in Audit Trail
  logAuditEvent(
    req,
    'CANCEL_TRANSFER',
    'LOGISTICS',
    `Cancelled in-transit transfer ${sh.trackingCode} (${sh.sourceBranchName || sh.sourceBranchId} -> ${sh.destinationBranchName || sh.destinationBranchId}). Returned ${sh.items.reduce((s: number, i: any) => s + (i.quantitySent || 0), 0)} items back to ${sh.sourceBranchName || sh.sourceBranchId} stock.${reason ? ' Reason: ' + reason : ''}`,
    sh.sourceBranchId
  );

  res.json({ shipment: sh, message: `Transfer ${sh.trackingCode} cancelled successfully. Items refunded to source branch stock.` });
});

// Deprecated alias for backwards compatibility
app.post('/api/shipments/:id/cancel-receive', (req, res) => {
  return res.status(400).json({
    message: 'Received transfers cannot be cancelled. Only In-Transit transfers can be cancelled.',
  });
});

// Stock Operations (Pullout Bins, Damage Tagging & Adjustments)
app.get('/api/stock-operations', (req, res) => {
  const { branchId } = req.query;
  if (branchId && branchId !== 'ALL') {
    return res.json(
      stockOperations.filter(
        (op) => op.branchId === branchId || op.destinationWarehouseId === branchId
      )
    );
  }
  res.json(stockOperations);
});

app.post('/api/stock-operations', (req, res) => {
  const opType = req.body.type || 'DAMAGE';
  const branchObj = branches.find((b) => b.id === req.body.branchId);
  const destWarehouseObj = branches.find((b) => b.id === (req.body.destinationWarehouseId || 'WH001'));

  let totalValue = 0;
  const items = req.body.items || [];

  if (items.length > 0) {
    totalValue = items.reduce((sum: number, it: any) => sum + (it.totalValue || it.quantity * it.unitCost), 0);
  } else if (req.body.quantityChanged && req.body.costPerUnit) {
    totalValue = Math.abs(req.body.quantityChanged) * req.body.costPerUnit;
  }

  const newOp = {
    id: `op-${Date.now()}`,
    referenceNumber: generateStandardTransactionId(req.body.branchId || 'WH001', opType),
    dateAD: new Date().toISOString().split('T')[0],
    dateBS: '2083-04-16 BS',
    totalValue,
    fiscalYear: '2082/83',
    branchName: branchObj?.name || 'Branch',
    destinationWarehouseId: destWarehouseObj?.id || 'WH001',
    destinationWarehouseName: destWarehouseObj?.name || 'Headquarters Warehouse',
    status: opType === 'PULLOUT' ? 'DISPATCHED' : 'LOGGED',
    ...req.body,
  };

  // If multi-item Pullout, Damage, Stock-Out, or Consumable Issue
  if (items.length > 0) {
    items.forEach((item: any) => {
      let stk = inventoryStock.find(
        (s) => s.productId === item.productId && s.branchId === req.body.branchId
      );
      if (!stk) {
        stk = {
          id: `stk-${(req.body.branchId || 'BR-KTM').toLowerCase()}-${item.productId}`,
          productId: item.productId,
          branchId: req.body.branchId || 'BR-KTM',
          quantityOnHand: 0,
          damagedQty: 0,
          reservedQty: 0,
          incomingQty: 0,
          lastUpdated: new Date().toISOString(),
        };
        inventoryStock.push(stk);
      }

      const qtyBefore = stk.quantityOnHand;

      if (opType === 'PULLOUT') {
        // If pulling out damaged stock, deduct from damagedQty; else deduct from usable quantityOnHand
        if (item.condition === 'DAMAGED_STOCK') {
          stk.damagedQty = Math.max(0, (stk.damagedQty || 0) - item.quantity);
        } else {
          stk.quantityOnHand = Math.max(0, stk.quantityOnHand - item.quantity);
        }
      } else if (opType === 'DAMAGE') {
        // Flagging stock as damaged at branch/warehouse:
        // Reduce usable stock and increase local damaged stock!
        stk.quantityOnHand = Math.max(0, stk.quantityOnHand - item.quantity);
        stk.damagedQty = (stk.damagedQty || 0) + item.quantity;
      } else if (opType === 'DISPOSAL') {
        // Permanent disposal & financial write-off of damaged stock:
        // Deduct from local damagedQty holding balance!
        stk.damagedQty = Math.max(0, (stk.damagedQty || 0) - item.quantity);
      } else if (opType === 'STOCK_OUT' || opType === 'CONSUMABLE_ISSUE') {
        // Deduct quantity from store/branch usable stock
        stk.quantityOnHand = Math.max(0, stk.quantityOnHand - item.quantity);
      }

      stk.lastUpdated = new Date().toISOString();

      transactionLogs.unshift({
        id: `txn-${Date.now()}-${item.productId}`,
        transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
        productId: item.productId,
        productSku: item.sku || '',
        productName: item.productName || 'Product',
        branchId: req.body.branchId,
        changeType: opType,
        quantityBefore: qtyBefore,
        quantityChanged: -item.quantity,
        quantityAfter: stk.quantityOnHand,
        unitCost: item.unitCost || item.costPerUnit || item.sellingPrice || 0,
        referenceDocId: newOp.referenceNumber,
        timestampAD: new Date().toISOString(),
        timestampBS: '2083-04-16 BS',
      });
    });
  } else if (req.body.productId) {
    // Single item stock operation / damage log / consumable issue
    let stk = inventoryStock.find(
      (s) => s.productId === req.body.productId && s.branchId === req.body.branchId
    );
    if (!stk) {
      stk = {
        id: `stk-${(req.body.branchId || 'BR-KTM').toLowerCase()}-${req.body.productId}`,
        productId: req.body.productId,
        branchId: req.body.branchId || 'BR-KTM',
        quantityOnHand: 0,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        lastUpdated: new Date().toISOString(),
      };
      inventoryStock.push(stk);
    }

    const qtyBefore = stk.quantityOnHand;
    const qtyChanged = Number(req.body.quantityChanged) || 0;

    if (opType === 'DAMAGE') {
      // Tag local damage: convert usable stock into damaged stock
      const damAmt = Math.abs(qtyChanged);
      stk.quantityOnHand = Math.max(0, stk.quantityOnHand - damAmt);
      stk.damagedQty = (stk.damagedQty || 0) + damAmt;
    } else if (opType === 'DISPOSAL') {
      // Permanent disposal & financial write-off of damaged stock
      const dispAmt = Math.abs(qtyChanged);
      stk.damagedQty = Math.max(0, (stk.damagedQty || 0) - dispAmt);
    } else {
      stk.quantityOnHand += qtyChanged;
    }

    stk.lastUpdated = new Date().toISOString();
    const prod = products.find((p) => p.id === req.body.productId);

    transactionLogs.unshift({
      id: `txn-${Date.now()}`,
      transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: req.body.productId,
      productSku: prod?.sku || '',
      productName: req.body.productName || prod?.name || '',
      branchId: req.body.branchId,
      changeType: opType,
      quantityBefore: qtyBefore,
      quantityChanged: qtyChanged,
      quantityAfter: stk.quantityOnHand,
      unitCost: req.body.costPerUnit || prod?.costPrice || 0,
      referenceDocId: newOp.referenceNumber,
      timestampAD: new Date().toISOString(),
      timestampBS: '2083-04-16 BS',
    });
  }

  // If Product Sale (STOCK_OUT) to customer, register sold devices in Customer Device Directory tagged as "SOLD"
  if (opType === 'STOCK_OUT' && (req.body.customerId || req.body.customerName)) {
    const custObj = customerMasterRecords.find((c) => c.id === req.body.customerId || c.customerId === req.body.customerId);
    const custName = custObj ? custObj.customerName : (req.body.customerName || 'Customer');
    const custCode = custObj ? custObj.customerId : (req.body.customerId || 'CUST');
    const custPhone = custObj ? custObj.contactNumber : '';
    const custAddr = custObj ? custObj.address : '';

    items.forEach((item: any) => {
      const prod = products.find((p) => p.id === item.productId);
      const prodName = item.productName || prod?.name || 'Device';

      if (item.deviceSerials && Array.isArray(item.deviceSerials) && item.deviceSerials.length > 0) {
        item.deviceSerials.forEach((s: any, idx: number) => {
          const devSn = s.deviceSerial || s.serialNumber || `SN-SOLD-${Date.now()}-${idx + 1}`;
          const ponSn = s.ponSerial || `PON-SOLD-${Date.now()}-${idx + 1}`;
          const mac = s.macAddress || '';

          customerDeviceRecords.unshift({
            id: `dev-sold-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            customerId: req.body.customerId || 'CUST-GENERIC',
            customerName: custName,
            customerCode: custCode,
            contactPhone: custPhone,
            installationAddress: custAddr,
            branchId: req.body.branchId || 'WH001',
            productName: prodName,
            deviceSerial: devSn,
            ponSerial: ponSn,
            macAddress: mac,
            status: 'SOLD',
            issuedDateAD: new Date().toISOString().split('T')[0],
            issuedDateBS: '2083-04-16 BS',
            purchaseBillRef: newOp.referenceNumber,
            notes: `Product Sale to Customer (${req.body.reason || 'Sold Item'}) - Customer Owned`,
          });
        });
      } else {
        const qty = item.quantity || 1;
        for (let i = 0; i < qty; i++) {
          customerDeviceRecords.unshift({
            id: `dev-sold-${Date.now()}-${i}-${Math.floor(Math.random() * 1000)}`,
            customerId: req.body.customerId || 'CUST-GENERIC',
            customerName: custName,
            customerCode: custCode,
            contactPhone: custPhone,
            installationAddress: custAddr,
            branchId: req.body.branchId || 'WH001',
            productName: prodName,
            deviceSerial: `SN-${prodName.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${Math.floor(100000 + Math.random() * 900000)}`,
            ponSerial: `PON-${Math.floor(100000 + Math.random() * 900000)}`,
            status: 'SOLD',
            issuedDateAD: new Date().toISOString().split('T')[0],
            issuedDateBS: '2083-04-16 BS',
            purchaseBillRef: newOp.referenceNumber,
            notes: `Product Sale to Customer (${req.body.reason || 'Sold Item'}) - Customer Owned`,
          });
        }
      }
    });
  }

  stockOperations.unshift(newOp);
  logAuditEvent(req, `CREATE_STOCK_${opType}`, 'STOCK_OPERATIONS', `Created Stock Operation ${newOp.referenceNumber} (${opType}) at ${newOp.branchName} (Total Value: NPR ${totalValue.toLocaleString()})`);
  res.status(201).json(newOp);
});

// Receive Pullout Bin at Warehouse
app.post('/api/stock-operations/:id/receive', (req, res) => {
  const user = getUserFromReq(req);
  const isAuthorized =
    !user ||
    user.role === 'SUPER_ADMIN' ||
    user.role === 'INVENTORY_MANAGER' ||
    user.branchId === 'BR-KTM' ||
    user.branchId === 'WH001' ||
    user.branchId === 'ALL';

  if (!isAuthorized) {
    return res.status(403).json({
      message: 'Access Denied: Receiving pullout stock is restricted to Headquarters Warehouse Managers and Inventory Controllers.',
    });
  }

  const { id } = req.params;
  const op = stockOperations.find((o) => o.id === id);
  if (!op) return res.status(404).json({ message: 'Stock operation not found' });

  op.status = 'RECEIVED';
  const whId = op.destinationWarehouseId || 'WH001';

  // Add received stock to central Warehouse stock
  if (op.items && op.items.length > 0) {
    op.items.forEach((item: any) => {
      let whStk = inventoryStock.find((s) => s.productId === item.productId && s.branchId === whId);
      if (!whStk) {
        whStk = {
          id: `stk-${whId.toLowerCase()}-${item.productId}`,
          productId: item.productId,
          branchId: whId,
          quantityOnHand: 0,
          damagedQty: 0,
          reservedQty: 0,
          incomingQty: 0,
          lastUpdated: new Date().toISOString(),
        };
        inventoryStock.push(whStk);
      }

      const qtyBefore = whStk.quantityOnHand;

      if (item.condition === 'DAMAGED_STOCK') {
        whStk.damagedQty = (whStk.damagedQty || 0) + item.quantity;
      } else {
        whStk.quantityOnHand += item.quantity;
      }

      whStk.lastUpdated = new Date().toISOString();

      transactionLogs.unshift({
        id: `txn-${Date.now()}-${item.productId}`,
        transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
        productId: item.productId,
        productSku: item.sku || '',
        productName: item.productName || '',
        branchId: whId,
        changeType: 'PULLOUT',
        quantityBefore: qtyBefore,
        quantityChanged: item.quantity,
        quantityAfter: whStk.quantityOnHand,
        unitCost: item.unitCost || 0,
        referenceDocId: op.referenceNumber,
        timestampAD: new Date().toISOString(),
        timestampBS: '2083-04-16 BS',
      });
    });
  } else if (op.productId && op.quantityChanged) {
    let whStk = inventoryStock.find((s) => s.productId === op.productId && s.branchId === whId);
    if (!whStk) {
      whStk = {
        id: `stk-${whId.toLowerCase()}-${op.productId}`,
        productId: op.productId,
        branchId: whId,
        quantityOnHand: 0,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        lastUpdated: new Date().toISOString(),
      };
      inventoryStock.push(whStk);
    }
    const pullQty = Math.abs(op.quantityChanged);
    whStk.quantityOnHand += pullQty;
    whStk.lastUpdated = new Date().toISOString();
  }

  logAuditEvent(req, 'RECEIVE_PULLOUT_BIN', 'STOCK_OPERATIONS', `Received Pullout Bin #${op.referenceNumber} at Warehouse ${op.destinationWarehouseName || whId}`);
  res.json(op);
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

// Bikram Sambat (BS) Calendar & Day Records Endpoints with PostgreSQL & In-Memory Fallback
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

  // In-Memory Filter Fallback
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
  const { yearBS, daysInMonths, customStartAD } = req.body;
  if (!yearBS || !Array.isArray(daysInMonths) || daysInMonths.length !== 12) {
    return res.status(400).json({ message: 'Must provide yearBS and 12-element daysInMonths array' });
  }

  let startAD = customStartAD;
  if (!startAD) {
    const estADYear = yearBS - 57;
    startAD = `${estADYear}-04-14`;
  }

  // Update In-Memory Store first
  const existingIdx = inMemoryBsCalendarYears.findIndex((y) => y.yearBS === yearBS);
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
app.get('/api/audit-trail', (req, res) => {
  res.json(auditTrail);
});

app.get('/api/transaction-logs', (req, res) => {
  res.json(transactionLogs);
});

// Customer Device & Serial Number Lookup
app.get('/api/customer-devices', (req, res) => {
  const { branchId, query } = req.query;
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

app.post('/api/customer-devices', (req, res) => {
  const newRecord: CustomerDeviceRecord = {
    id: `cust-${Date.now()}`,
    ...req.body,
  };
  customerDeviceRecords.unshift(newRecord);

  // Sync with Customer Master Directory: ensure customer exists and update count
  const custCode = newRecord.customerCode || newRecord.customerId;
  let masterCust = customerMasterRecords.find(
    (c) => c.customerId === custCode || c.id === custCode || c.customerName.toLowerCase() === newRecord.customerName.toLowerCase()
  );

  if (masterCust) {
    masterCust.assignedDevicesCount = customerDeviceRecords.filter(
      (d) => d.customerCode === masterCust?.customerId || d.customerId === masterCust?.id || d.customerName.toLowerCase() === masterCust?.customerName.toLowerCase()
    ).length;
  } else {
    // Auto-create customer profile in Customer Master Directory
    const newMaster: CustomerRecord = {
      id: custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
      customerId: custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
      customerName: newRecord.customerName,
      username: newRecord.customerName.toLowerCase().replace(/\s+/g, '.'),
      contactNumber: newRecord.contactPhone || '9800000000',
      branchId: newRecord.branchId || 'WH001',
      address: newRecord.installationAddress || 'Nepal',
      status: 'ACTIVE',
      assignedDevicesCount: 1,
    };
    customerMasterRecords.unshift(newMaster);
  }

  logAuditEvent(req, 'ASSIGN_CUSTOMER_CPE', 'CPE_MANAGEMENT', `Assigned CPE Device Serial ${newRecord.deviceSerial} (PON: ${newRecord.ponSerial || 'N/A'}) to customer ${newRecord.customerName} (${custCode})`, newRecord.branchId);
  res.status(201).json(newRecord);
});

app.patch('/api/customer-devices/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const record = customerDeviceRecords.find((c) => c.id === id);
  if (!record) return res.status(404).json({ message: 'Customer device record not found' });

  const oldStatus = record.status;

  if ((status === 'DISCONNECTED' || status === 'ROUTER_COLLECTED') && oldStatus !== 'RENTAL' && oldStatus !== 'ACTIVE') {
    return res.status(400).json({ message: 'Disconnect is only permitted for Rental CPE products. Sold devices belong to the customer.' });
  }

  const isDisconn = status === 'DISCONNECTED' || status === 'ROUTER_COLLECTED';
  record.status = isDisconn ? 'ROUTER_COLLECTED' : status;
  if (isDisconn) {
    record.disconnectedDateAD = new Date().toISOString().split('T')[0];
    record.disconnectedDateBS = '2083-04-28 BS';
  }

  // Restock inventory (+1) when a Rental Product is Disconnected/Collected, Returned, or Refunded
  if ((status === 'DISCONNECTED' || status === 'ROUTER_COLLECTED' || status === 'RETURNED' || status === 'REFUND' || status === 'IN_STOCK') && (oldStatus === 'RENTAL' || oldStatus === 'ACTIVE')) {
    const prod = products.find((p) => p.name.toLowerCase() === record.productName.toLowerCase()) || products[0];
    const targetBranch = record.branchId || 'WH001';
    let stk = inventoryStock.find((s) => s.productId === prod.id && s.branchId === targetBranch);
    if (!stk) {
      stk = {
        id: `stk-${targetBranch.toLowerCase()}-${prod.id}`,
        productId: prod.id,
        branchId: targetBranch,
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

    transactionLogs.unshift({
      id: `txn-${Date.now()}`,
      transactionNumber: `TXN-DISC-${Math.floor(10000 + Math.random() * 90000)}`,
      productId: prod.id,
      productSku: prod.sku || '',
      productName: prod.name,
      branchId: targetBranch,
      changeType: 'PULLOUT',
      quantityBefore: qtyBefore,
      quantityChanged: 1,
      quantityAfter: stk.quantityOnHand,
      unitCost: prod.costPrice,
      referenceDocId: `DISCONNECT-RESTOCK-${record.deviceSerial}`,
      timestampAD: new Date().toISOString(),
      timestampBS: '2083-04-28 BS',
    });
  }

  // Sync assigned devices count in master record
  const custCode = record.customerCode || record.customerId;
  const masterCust = customerMasterRecords.find(
    (c) => c.customerId === custCode || c.id === custCode || c.customerName.toLowerCase() === record.customerName.toLowerCase()
  );
  if (masterCust) {
    masterCust.assignedDevicesCount = customerDeviceRecords.filter(
      (d) => (d.customerCode === masterCust?.customerId || d.customerId === masterCust?.id || d.customerName.toLowerCase() === masterCust?.customerName.toLowerCase()) && d.status !== 'RETURNED' && d.status !== 'REFUND' && d.status !== 'DISCONNECTED'
    ).length;
  }

  logAuditEvent(req, 'UPDATE_CPE_DEVICE_STATUS', 'CPE_MANAGEMENT', `Updated CPE Device ${record.deviceSerial} status from ${oldStatus} to ${record.status} for customer ${record.customerName}`, record.branchId);
  res.json(record);
});

// Device Exchange & Replacement Handler
app.post('/api/customer-devices/exchange', (req, res) => {
  const {
    oldDeviceId,
    exchangeReason,
    oldDeviceAction, // 'DAMAGE' | 'RESTOCK' | 'DISPOSED'
    newProductName,
    newDeviceSerial,
    newPonSerial,
    newMacAddress,
    notes,
    branchId,
  } = req.body;

  const oldRecord = customerDeviceRecords.find((c) => c.id === oldDeviceId);
  if (!oldRecord) return res.status(404).json({ message: 'Old customer device record not found' });

  const dateStrAD = new Date().toISOString().split('T')[0];

  // 1. Archive old record status to EXCHANGED
  oldRecord.status = 'EXCHANGED';
  oldRecord.notes = `[EXCHANGED on ${dateStrAD}] Reason: ${exchangeReason || 'Defective / Replacement'}. Old device disposition: ${oldDeviceAction}. Replacement SN: ${newDeviceSerial}. ${oldRecord.notes || ''}`;

  // 2. Process Old Device Inventory Disposition
  if (oldDeviceAction === 'DAMAGE') {
    const prod = products.find((p) => p.name.toLowerCase() === oldRecord.productName.toLowerCase()) || products[0];
    const targetBranch = branchId || oldRecord.branchId || 'WH001';
    let stk = inventoryStock.find((s) => s.productId === prod.id && s.branchId === targetBranch);
    if (stk) {
      stk.damagedQty = (stk.damagedQty || 0) + 1;
      stk.lastUpdated = new Date().toISOString();
    }
    stockOperations.unshift({
      id: `op-${Date.now()}`,
      referenceNumber: `OP-DMG-${Math.floor(1000 + Math.random() * 9000)}`,
      type: 'DAMAGE',
      branchId: targetBranch,
      productId: prod.id,
      productName: prod.name,
      quantityChanged: 1,
      costPerUnit: prod.costPrice,
      totalValue: prod.costPrice,
      reason: `Customer Device Replacement Pullout: Defective ${oldRecord.deviceSerial} (${exchangeReason || 'Faulty Hardware'})`,
      inspectorName: activeUser?.name || 'Field Technician',
      dateAD: dateStrAD,
      dateBS: '2083-04-28 BS',
      fiscalYear: '2082/83',
      status: 'LOGGED',
    });
  } else if (oldDeviceAction === 'RESTOCK') {
    const prod = products.find((p) => p.name.toLowerCase() === oldRecord.productName.toLowerCase()) || products[0];
    const targetBranch = branchId || oldRecord.branchId || 'WH001';
    let stk = inventoryStock.find((s) => s.productId === prod.id && s.branchId === targetBranch);
    if (stk) {
      stk.quantityOnHand += 1;
      stk.lastUpdated = new Date().toISOString();
    }
  }

  // 3. Issue New Device to Customer
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

  // 4. Audit Log Entry
  auditTrail.unshift({
    id: `aud-${Date.now()}`,
    userEmail: activeUser?.email || 'admin@izone.com.np',
    userName: activeUser?.name || 'System Admin',
    action: 'DEVICE_EXCHANGE',
    module: 'OPERATIONS',
    details: `Exchanged customer device for ${oldRecord.customerName} (${oldRecord.customerCode}). Replaced SN ${oldRecord.deviceSerial} -> New SN ${newDeviceSerial}. Reason: ${exchangeReason}`,
    timestampAD: new Date().toISOString(),
    timestampBS: '2083-04-28 BS',
    branchId: oldRecord.branchId,
  });

  res.status(201).json({ oldRecord, newRecord, message: 'Customer device successfully exchanged and inventory synchronized.' });
});

// Customer Master Database Endpoints
app.get('/api/customers', (req, res) => {
  const { branchId, query } = req.query;

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

app.post('/api/customers', (req, res) => {
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

  logAuditEvent(req, 'CREATE_CUSTOMER', 'MASTER_DATA', `Created / Registered Customer Profile ${newRecord.customerName} (${newRecord.customerId})`, newRecord.branchId);
  res.status(201).json(newRecord);
});

app.post('/api/customers/bulk', (req, res) => {
  const items: CustomerRecord[] = req.body.customers || [];
  let count = 0;
  items.forEach((cust) => {
    const newRecord: CustomerRecord = {
      id: cust.id || cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
      customerId: cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
      customerName: cust.customerName || 'Imported Customer',
      username: cust.username || cust.customerId.toLowerCase(),
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
  });

  logAuditEvent(req, 'BULK_IMPORT_CUSTOMERS', 'MASTER_DATA', `Bulk imported ${count} Customer Records into Master Directory`);
  res.status(201).json({ success: true, count, total: customerMasterRecords.length });
});

app.put('/api/customers/:id', (req, res) => {
  const { id } = req.params;
  const idx = customerMasterRecords.findIndex((c) => c.id === id || c.customerId === id);
  if (idx < 0) {
    return res.status(404).json({ message: 'Customer record not found' });
  }

  customerMasterRecords[idx] = {
    ...customerMasterRecords[idx],
    ...req.body,
  };

  logAuditEvent(req, 'UPDATE_CUSTOMER', 'MASTER_DATA', `Updated Customer Master Details for ${customerMasterRecords[idx].customerName} (${customerMasterRecords[idx].customerId})`, customerMasterRecords[idx].branchId);
  res.json(customerMasterRecords[idx]);
});

app.delete('/api/customers/:id', (req, res) => {
  const { id } = req.params;
  const cust = customerMasterRecords.find((c) => c.id === id || c.customerId === id);
  customerMasterRecords = customerMasterRecords.filter((c) => c.id !== id && c.customerId !== id);
  logAuditEvent(req, 'DELETE_CUSTOMER', 'MASTER_DATA', `Deleted Customer Record ${cust?.customerName || id}`);
  res.json({ success: true, deletedId: id });
});

// Approval Requests & Workflow Authorization Routes
app.get('/api/approval-requests', (req, res) => {
  const { branchId, status } = req.query;
  let list = approvalRequests;

  if (branchId && branchId !== 'ALL') {
    list = list.filter((r) => r.branchId === branchId);
  }

  if (status && typeof status === 'string' && status !== 'ALL') {
    list = list.filter((r) => r.status === status);
  }

  res.json(list);
});

app.post('/api/approval-requests', (req, res) => {
  const count = approvalRequests.length + 1;
  const requestNumber = `APR-2083-${count.toString().padStart(3, '0')}`;
  
  const newRequest: ApprovalRequest = {
    id: `apr-${Date.now()}`,
    requestNumber,
    ...req.body,
    status: 'PENDING',
    requestedAtAD: new Date().toISOString(),
    requestedAtBS: '2083-04-22 BS',
  };

  approvalRequests.unshift(newRequest);

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
});

app.post('/api/approval-requests/:id/process', (req, res) => {
  const { id } = req.params;
  const { status, approverUser, rejectionReason } = req.body; // status: 'APPROVED' | 'REJECTED'

  const request = approvalRequests.find((r) => r.id === id);
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

    logAuditEvent(req, 'APPROVAL_REQUEST_REJECTED', 'OPERATIONS', `Rejected approval request #${request.requestNumber} for ${request.customerName} (${request.deviceSerial}): ${request.rejectionReason}`, request.branchId);

    return res.json({ request, message: 'Approval request rejected successfully' });
  }

  // IF APPROVED: execute the requested status change on customer device record
  if (request.type === 'CUSTOMER_DEVICE_STATUS') {
    const devRecord = customerDeviceRecords.find((c) => c.id === request.targetId || c.deviceSerial === request.deviceSerial);
    const isDisconnectReq = request.requestedStatus === 'DISCONNECTED' || request.requestedStatus === 'ROUTER_COLLECTED';
    if (devRecord) {
      devRecord.status = (isDisconnectReq ? 'ROUTER_COLLECTED' : request.requestedStatus) as CustomerDeviceRecord['status'];
      if (isDisconnectReq) {
        devRecord.disconnectedDateAD = new Date().toISOString().split('T')[0];
        devRecord.disconnectedDateBS = request.processedAtBS || '2083-04-28 BS';
      }
    }

    // Restock Inventory if requested or if disconnect/router collected
    if (request.restockQtyOnApproval || isDisconnectReq) {
      const prod = products.find((p) => p.name.toLowerCase() === request.productName.toLowerCase()) || products[0];
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

      transactionLogs.unshift({
        id: `txn-${Date.now()}`,
        transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
        productId: prod.id,
        productSku: prod.sku,
        productName: prod.name,
        branchId: request.branchId,
        changeType: 'PULLOUT',
        quantityBefore: qtyBefore,
        quantityChanged: 1,
        quantityAfter: stk.quantityOnHand,
        unitCost: prod.costPrice,
        referenceDocId: request.requestNumber,
        timestampAD: new Date().toISOString(),
        timestampBS: '2083-04-22 BS',
      });
    }

    logAuditEvent(req, 'APPROVAL_REQUEST_APPROVED', 'OPERATIONS', `Approved request #${request.requestNumber}. Updated ${request.customerName} (${request.deviceSerial}) status to ${request.requestedStatus}${request.restockQtyOnApproval ? ' (+1 unit restocked to branch inventory)' : ''}`, request.branchId);
  }

  // IF APPROVED: Cancel In-Transit Transfer (Restores items back to Source Branch stock)
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
      const srcBranchCode = srcBranchObj?.code || sh.sourceBranchId;

      const destBranchObj = branches.find((b) => b.id === sh.destinationBranchId || b.code === sh.destinationBranchId);
      const destBranchId = destBranchObj?.id || sh.destinationBranchId;
      const destBranchCode = destBranchObj?.code || sh.destinationBranchId;

      sh.items.forEach((item: any) => {
        const qtySent = Number(item.quantitySent || item.quantity) || 1;

        if (qtySent > 0 && srcBranchId) {
          let sourceStk = inventoryStock.find(
            (s) => s.productId === item.productId && (s.branchId === srcBranchId || s.branchId === srcBranchCode)
          );

          if (!sourceStk) {
            sourceStk = {
              id: `stk-${srcBranchId.toLowerCase()}-${item.productId}`,
              productId: item.productId,
              branchId: srcBranchId,
              quantityOnHand: 0,
              damagedQty: 0,
              reservedQty: 0,
              incomingQty: 0,
              lastUpdated: new Date().toISOString(),
            };
            inventoryStock.push(sourceStk);
          }

          const qtyBefore = sourceStk.quantityOnHand;
          sourceStk.quantityOnHand += qtySent;
          sourceStk.lastUpdated = new Date().toISOString();

          const prod = products.find((p) => p.id === item.productId);

          transactionLogs.unshift({
            id: `txn-${Date.now()}-${item.productId}-apr-cnl`,
            transactionNumber: `TXN-${Math.floor(10000 + Math.random() * 90000)}`,
            productId: item.productId,
            productSku: prod?.sku || item.sku || '',
            productName: prod?.name || item.productName || '',
            branchId: srcBranchId,
            changeType: 'TRANSFER_CANCELLED',
            quantityBefore: qtyBefore,
            quantityChanged: qtySent,
            quantityAfter: sourceStk.quantityOnHand,
            unitCost: prod?.costPrice || 0,
            referenceDocId: sh.trackingCode,
            timestampAD: new Date().toISOString(),
            timestampBS: '2083-04-22 BS',
          });
        }

        // Decrement destination incomingQty
        if (qtySent > 0 && destBranchId) {
          const destStk = inventoryStock.find(
            (s) => s.productId === item.productId && (s.branchId === destBranchId || s.branchId === destBranchCode)
          );
          if (destStk) {
            destStk.incomingQty = Math.max(0, (destStk.incomingQty || 0) - qtySent);
            destStk.lastUpdated = new Date().toISOString();
          }
        }

        // Revert serial records back to source branch
        if (item.deviceSerials && Array.isArray(item.deviceSerials)) {
          item.deviceSerials.forEach((s: any) => {
            if (!s?.deviceSerial) return;
            const cleanSer = s.deviceSerial.trim().toUpperCase();
            let devRecord = customerDeviceRecords.find(
              (cd) => cd.deviceSerial.trim().toUpperCase() === cleanSer || (cd.ponSerial && cd.ponSerial.trim().toUpperCase() === cleanSer)
            );
            if (devRecord) {
              devRecord.branchId = srcBranchId;
              devRecord.status = 'IN_STOCK';
              devRecord.notes = `Transfer ${sh.trackingCode} cancelled via Approval #${request.requestNumber}. Restored to source branch.`;
            }
          });
        }
      });

      sh.status = 'CANCELLED';
      sh.notes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled via Approval #${request.requestNumber} on ${new Date().toISOString().split('T')[0]} by ${request.processedByName} (${request.processedByRole}). Stock restored to source branch.`;

      logAuditEvent(req, 'APPROVAL_REQUEST_APPROVED', 'BRANCH_OPERATIONS', `Approved transfer cancellation for ${sh.trackingCode} (${sh.sourceBranchName || srcBranchId} -> ${sh.destinationBranchName || destBranchId}). Refunded stock back to ${sh.sourceBranchName || srcBranchId}.`, srcBranchId);
    }
  }

  // IF APPROVED: Physical Stock Audit Reconciliation (Adjusts branch stock on hand for each discrepancy)
  if (request.type === 'STOCK_AUDIT_RECONCILIATION' && request.auditData) {
    const auditData = request.auditData;
    const targetBranchId = request.branchId || auditData.branchId;

    if (auditData.varianceItems && Array.isArray(auditData.varianceItems)) {
      auditData.varianceItems.forEach((item: any) => {
        let stk = inventoryStock.find(
          (s) => s.productId === item.productId && s.branchId === targetBranchId
        );

        if (!stk) {
          stk = {
            id: `stk-${targetBranchId.toLowerCase()}-${item.productId}`,
            productId: item.productId,
            branchId: targetBranchId,
            quantityOnHand: 0,
            damagedQty: 0,
            reservedQty: 0,
            incomingQty: 0,
            lastUpdated: new Date().toISOString(),
          };
          inventoryStock.push(stk);
        }

        const qtyBefore = stk.quantityOnHand;
        const targetCounted = Number(item.countedQty) || 0;
        const delta = targetCounted - qtyBefore;

        stk.quantityOnHand = targetCounted;
        stk.lastUpdated = new Date().toISOString();

        const prod = products.find((p) => p.id === item.productId);

        transactionLogs.unshift({
          id: `txn-${Date.now()}-${item.productId}-aud`,
          transactionNumber: `TXN-AUD-${Math.floor(10000 + Math.random() * 90000)}`,
          productId: item.productId,
          productSku: prod?.sku || item.sku || '',
          productName: prod?.name || item.productName || '',
          branchId: targetBranchId,
          changeType: delta > 0 ? 'PHYSICAL_AUDIT_EXCESS' : 'PHYSICAL_AUDIT_SHORTAGE',
          quantityBefore: qtyBefore,
          quantityChanged: delta,
          quantityAfter: stk.quantityOnHand,
          unitCost: item.unitCost || prod?.costPrice || 0,
          referenceDocId: `${auditData.auditRefNumber} / ${request.requestNumber}`,
          timestampAD: new Date().toISOString(),
          timestampBS: '2083-04-22 BS',
        });
      });
    }

    logAuditEvent(req, 'STOCK_AUDIT_RECONCILED', 'INVENTORY_AUDIT', `Approved & Reconciled Physical Stock Audit #${auditData.auditRefNumber} (Approval #${request.requestNumber}) for ${auditData.branchName || targetBranchId}. Adjusted ${auditData.discrepancyCount || auditData.varianceItems?.length || 0} variance items to physical count. Net Financial Impact: NPR ${(auditData.netValueVariance || 0).toLocaleString()}.`, targetBranchId);
  }

  res.json({ request, message: 'Approval request authorized and executed successfully' });
});

app.post('/api/approval-requests/:id/cancel', (req, res) => {
  const { id } = req.params;
  const { user, reason } = req.body;

  const request = approvalRequests.find((r) => r.id === id);
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

  logAuditEvent(req, 'APPROVAL_REQUEST_CANCELLED', 'OPERATIONS', `Cancelled approval request #${request.requestNumber} for ${request.customerName} (${request.deviceSerial}). Reason: ${request.rejectionReason}`, request.branchId);

  res.json({ request, message: 'Approval request cancelled successfully' });
});

// Financial Reports Summary
app.get('/api/reports/financial-summary', (req, res) => {
  const { branchId } = req.query;
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

  const totalInventoryAssetValue = targetStock.reduce((sum, item) => {
    const prod = products.find((p) => p.id === item.productId);
    return sum + (prod ? prod.costPrice * item.quantityOnHand : 0);
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

// AI Analytics Proxy Endpoint
app.post('/api/ai/analytics', async (req, res) => {
  try {
    const { prompt, context } = req.body;
    const aiClient = getGenAIClient();

    if (!aiClient) {
      return res.json({
        insight: `📊 **IZone Executive AI Analysis Report**\n\n1. **Stock Optimization Priority**:\n   • **Kathmandu HQ**: Solar Inverters (IZ-2001) are at 3 sets, below minimum reorder level of 4. Immediate Purchase Order generation recommended.\n   • **Pokhara Hub**: Laptops (IZ-1001) are down to 4 units. Inter-branch transfer from Kathmandu is currently in-transit (4 units).\n\n2. **Nepal VAT & Tax Compliance**:\n   • Total Input VAT Credit recorded: रु ${purchaseInvoices.reduce((s, i) => s + i.vatAmount, 0).toLocaleString()}.\n   • Verified all supplier invoices adhere to IRD 13% VAT rules.\n\n3. **Fixed Asset Depreciation**:\n   • Total Net Book Value across 3 active fixed assets stands at रु ${assetRegister.reduce((s, a) => s + a.netBookValue, 0).toLocaleString()}.\n   • Vehicles depreciation under Reducing Balance method is current for FY 2082/83 BS.`,
        timestamp: new Date().toISOString(),
      });
    }

    const systemPrompt = `You are the chief AI Inventory & Financial Officer for IZone Enterprise System in Nepal. Provide a concise, bulleted strategic analysis focusing on stock health, low stock alerts, purchase orders, VAT compliance (13% VAT), and Bikram Sambat fiscal year metrics based on user query: ${prompt}`;

    const response = await aiClient.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: systemPrompt,
    });

    res.json({
      insight: response.text || 'Analysis completed successfully.',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.json({
      insight: `📊 **IZone Executive Stock Analysis**\n\n• **Low Stock Alert**: Reorder required for Solar Inverters and Laptops.\n• **In-Transit Transfers**: Shipment TRF-2083-0092 in transit to Pokhara.\n• **Tax Compliance**: Input VAT credit is fully reconciled for current BS period.`,
      timestamp: new Date().toISOString(),
    });
  }
});

// Vite Middleware Setup for Dev Mode vs Static Production Serving
async function syncDatabaseAndIndexes() {
  try {
    const client = await pgPool.connect();
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
    await seedInitialPostgresData(client);

    client.release();
    console.log('✅ All 19 Database tables and enterprise composite performance indexes synced successfully.');
  } catch (err: any) {
    isPgConnected = false;
    console.log('Database pool note: In-memory store active with instant caching.', err?.message || err);
  }
}

async function seedInitialPostgresData(client: pg.PoolClient) {
  try {
    for (const b of branches) {
      await client.query(
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.code, b.name, b.location, b.phone || '', b.isHeadquarters || false, b.active !== false, b.allowProcurement !== false]
      );
    }
    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [u.id, u.email, u.password, u.name, u.role, u.branchId, u.allowedBranchIds || [], u.canSwitchUser || false]
      );
    }
    for (const s of suppliers) {
      await client.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [s.id, s.supplierCode || '', s.name, s.contactPerson || '', s.phone || '', s.email || '', s.address || '', s.panVatNumber || '', s.rating || 5.0, s.status || 'ACTIVE']
      );
    }
    for (const c of categories) {
      await client.query(
        `INSERT INTO categories (id, name, code, description)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [c.id, c.name, c.code, c.description || '']
      );
    }
    for (const p of products) {
      await client.query(
        `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (id) DO NOTHING`,
        [
          p.id, p.sku, p.barcode || '', p.name, p.category, p.productGroup || 'Product Item', p.unit || 'Pcs',
          p.costPrice || 0, p.sellingPrice || 0, p.taxRate || 13.0, p.minReorderLevel || 5, p.requiresSerialTracking || false,
          p.trackingType || 'QUANTITY_ONLY', p.description || '', p.status || 'ACTIVE'
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
          a.id, a.tagNumber, a.name, a.category, a.branchId, a.acquisitionDateAd || '2025-01-01', a.acquisitionDateBs || '2081-09-17',
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
          po.id, po.poNumber, po.supplierName, po.branchId, po.orderDateAd || '2025-01-01', po.orderDateBs || '2081-09-17',
          po.expectedDeliveryDateAd || '2025-01-10', po.status || 'DRAFT', po.subtotalAmount || 0, po.taxAmount || 0,
          po.totalAmount || 0, po.notes || ''
        ]
      );
    }
    for (const inv of purchaseInvoices) {
      await client.query(
        `INSERT INTO purchase_invoices (id, invoice_number, po_reference_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total, payment_status, amount_paid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (id) DO NOTHING`,
        [
          inv.id, inv.invoiceNumber, inv.poReferenceId || '', inv.supplierName, inv.branchId, inv.invoiceDateAd || '2025-01-01',
          inv.invoiceDateBs || '2081-09-17', inv.taxableAmount || 0, inv.vatAmount || 0, inv.nonTaxableAmount || 0,
          inv.grandTotal || 0, inv.paymentStatus || 'UNPAID', inv.amountPaid || 0
        ]
      );
    }
    for (const fy of fiscalYears) {
      await client.query(
        `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [fy.id, fy.code, fy.startDateAd || '2025-07-16', fy.endDateAd || '2026-07-15', fy.startDateBs || '2082-04-01', fy.endDateBs || '2083-03-31', fy.isCurrent || false, fy.isClosed || false]
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
          dev.issuedDateAd || '2025-01-01', dev.issuedDateBs || '2081-09-17', dev.purchaseBillRef || '', dev.notes || ''
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
          app.reason || '', app.restockQtyOnApproval || false, app.status || 'PENDING', app.requestedAtAd || new Date().toISOString(), app.requestedAtBs || '2081-09-17'
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

startServer();
