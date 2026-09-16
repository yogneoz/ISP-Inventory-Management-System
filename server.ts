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
  DamageRecord,
  VendorPayment,
  VendorPaymentMethod,
  VendorPaymentStatus,
} from './src/types';
import { calculateFixedAssetValues } from './src/utils/depreciation';

dotenv.config();

import { pgPool, realPoolInstance, setIsPgConnected, getIsPgConnected, ensurePostgresConnection } from './server/db';
let isPgConnected = false;

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

// EXAMPLE/DUMMY company profile (is_demo-labelled data). Replace via the
// Company Setup screen once real company details are available.
const INITIAL_COMPANY_PROFILE: CompanyProfile = {
  id: 'COMP-001',
  name: 'Inventory Management System',
  legalName: 'Inventory Management System (Demo)',
  tagline: 'Multi-Branch Inventory Management',
  address: 'Kathmandu, Nepal',
  city: 'Kathmandu',
  country: 'Nepal',
  phone: '',
  email: '',
  website: '',
  panVatNumber: '',
  registrationNumber: '',
  logoUrl: '',
  logoPreset: 'telecom',
  currencySymbol: 'Rs.',
  defaultTaxRate: 13,
  notes: 'Default company profile — configure real details in Company Setup.',
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
  // Cash & Bank Payment / Receipt Document Numbering
  { id: 'CP', documentType: 'Cash Payment', prefix: 'CP-2081-', suffix: '', minDigits: 4, startingNumber: 1001, nextNumber: 1002, resetEveryFiscalYear: true, notes: 'Used for cash payment disbursements to suppliers and vendors. (Starts after demo CP-2081-1001.)' },
  { id: 'CR', documentType: 'Cash Receive', prefix: 'CR-2081-', suffix: '', minDigits: 4, startingNumber: 1001, nextNumber: 1001, resetEveryFiscalYear: true, notes: 'Used for cash receipts received from customers.' },
  { id: 'BP', documentType: 'Bank Payment', prefix: 'BP-2081-', suffix: '', minDigits: 4, startingNumber: 1001, nextNumber: 1003, resetEveryFiscalYear: true, notes: 'Used for bank transfer and cheque payment disbursements to suppliers. (Starts after demo BP-2081-1001/1002.)' },
  { id: 'BR', documentType: 'Bank Receive', prefix: 'BR-2081-', suffix: '', minDigits: 4, startingNumber: 1001, nextNumber: 1001, resetEveryFiscalYear: true, notes: 'Used for bank transfer and cheque receipts received from customers.' },
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

// EXAMPLE/DUMMY locations (is_demo = TRUE). No real site data.
const INITIAL_MASTER_LOCATIONS: LocationRecord[] = [
  {
    id: 'LOC-1001',
    name: 'Example Location 1',
    type: 'POP_SERVER_ROOM',
    branchId: 'WH001',
    address: 'Example Street, Example City, Nepal',
    coordinates: { latitude: 0, longitude: 0 },
    contactPerson: 'Example Contact 1',
    contactPhone: '9800000001',
    notes: 'Dummy location for testing (example data).',
    activeAssetsCount: 0,
  },
  {
    id: 'LOC-1002',
    name: 'Example Location 2',
    type: 'POP_SERVER_ROOM',
    branchId: 'BRH01',
    address: 'Example Avenue, Example City, Nepal',
    coordinates: { latitude: 0, longitude: 0 },
    contactPerson: 'Example Contact 2',
    contactPhone: '9800000002',
    notes: 'Dummy location for testing (example data).',
    activeAssetsCount: 0,
  },
];

// EXAMPLE/DUMMY branch master (is_demo = TRUE). No real branch data —
// mirrors scripts/setup_db.js DEFAULT_BRANCHES.
const INITIAL_MASTER_BRANCHES: Branch[] = [
  { id: 'WH001', code: 'WH001', name: 'Branch 1 (Head Office)', location: 'Example Location 1', phone: '9800000000', isHeadquarters: true, active: true },
  { id: 'BRH01', code: 'BRH01', name: 'Branch 2', location: 'Example Location 2', phone: '9800000001', isHeadquarters: false, active: true },
];

const INITIAL_MASTER_FISCAL_YEARS: FiscalYear[] = [
  { id: 'fy-1', code: '2080-81', startDateAD: '2023-07-17', endDateAD: '2024-07-15', startDateBS: '2080-04-01 BS', endDateBS: '2080-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-2', code: '2081-82', startDateAD: '2024-07-16', endDateAD: '2025-07-15', startDateBS: '2081-04-01 BS', endDateBS: '2081-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-3', code: '2082-83', startDateAD: '2025-07-16', endDateAD: '2026-07-15', startDateBS: '2082-04-01 BS', endDateBS: '2082-12-31 BS', isCurrent: true, isClosed: false },
  { id: 'fy-4', code: '2083-84', startDateAD: '2026-07-16', endDateAD: '2027-07-15', startDateBS: '2083-04-01 BS', endDateBS: '2083-12-31 BS', isCurrent: false, isClosed: false },
];

// EXAMPLE/DUMMY suppliers (is_demo = TRUE). No real supplier data.
// Ids match scripts/demo_dataset.js DEMO_SUPPLIERS (demo-sup-*) so the seed
// rows are the SAME suppliers referenced by demo invoices/payments/POs.
const INITIAL_MASTER_SUPPLIERS: Supplier[] = [
  {
    id: 'demo-sup-1',
    supplierCode: 'SUP-1001',
    name: 'Example Supplier 1',
    contactPerson: 'Example Contact 1',
    phone: '+977-01-0000001',
    email: 'sales1@example.com',
    address: 'Example Street, Example City, Nepal',
    panVatNumber: '100000001',
    rating: 4.8,
  },
  {
    id: 'demo-sup-2',
    supplierCode: 'SUP-1002',
    name: 'Example Supplier 2',
    contactPerson: 'Example Contact 2',
    phone: '+977-01-0000002',
    email: 'sales2@example.com',
    address: 'Example Avenue, Example City, Nepal',
    panVatNumber: '200000002',
    rating: 4.7,
  },
  {
    id: 'demo-sup-3',
    supplierCode: 'SUP-1003',
    name: 'Example Supplier 3',
    contactPerson: 'Example Contact 3',
    phone: '+977-01-0000003',
    email: 'sales3@example.com',
    address: 'Example Road, Example City, Nepal',
    panVatNumber: '300000003',
    rating: 4.9,
  },
];

// EXAMPLE/DUMMY user accounts (is_demo = TRUE) so the application is fully
// testable out of the box after a fresh setup. Shared demo password: Demo@123
// (documented in README.md). Real users created in the app are unaffected
// (seeded with ON CONFLICT (email) DO NOTHING).
const EXAMPLE_USER_PASSWORD = 'Demo@123';
const INITIAL_EXAMPLE_USERS: Array<{
  id: string;
  email: string;
  name: string;
  role: User['role'];
  branchId: string;
  canSwitchUser: boolean;
}> = [
  { id: 'usr-ex-superadmin', email: 'superadmin@example.com', name: 'Super Admin', role: 'SUPER_ADMIN', branchId: 'WH001', canSwitchUser: true },
  { id: 'usr-ex-branch1', email: 'branch1@example.com', name: 'Branch 1 Manager', role: 'BRANCH_MANAGER', branchId: 'WH001', canSwitchUser: false },
  { id: 'usr-ex-branch2', email: 'branch2@example.com', name: 'Branch 2 Manager', role: 'BRANCH_MANAGER', branchId: 'BRH01', canSwitchUser: false },
  { id: 'usr-ex-inventory1', email: 'inventory1@example.com', name: 'Inventory Manager 1', role: 'INVENTORY_MANAGER', branchId: 'WH001', canSwitchUser: false },
  { id: 'usr-ex-accountant1', email: 'accountant1@example.com', name: 'Accountant 1', role: 'ACCOUNTANT', branchId: 'WH001', canSwitchUser: false },
  { id: 'usr-ex-frontdesk1', email: 'frontdesk1@example.com', name: 'Front Desk 1', role: 'FRONT_DESK', branchId: 'BRH01', canSwitchUser: false },
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
let damageRecords: DamageRecord[] = [];
let vendorPayments: VendorPayment[] = [];
let vendorOpeningBalances: any[] = [];

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

function normalizeDocTypeCode(docType: string): string {
  return DOC_TYPE_CODE_MAP[docType.toUpperCase()] || docType.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

// Formats a raw sequence with a flexible width: 4 digits normally, widening
// automatically once the counter exceeds 9999 (e.g. 10000 → "10000").
function padSequence(seqNum: number): string {
  return String(seqNum).padStart(4, '0');
}

/**
 * Issues the next document number for a branch + document type on the given
 * calendar day. When `client` is provided (inside an existing transaction) the
 * counter claim joins that transaction; otherwise a one-off connection is used.
 */
async function issueNextDocNumber(
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
function generateNextDocNumberForServer(docTypeId: string): string {
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
      .catch((e: any) => console.warn('PostgreSQL increment document_number_config notice:', e?.message));
  }

  return docNum;
}


// Active user session mirror; authentication always reads PostgreSQL.
let activeUser: User | null = null;

const PASSWORD_HASH_PREFIX = 'scrypt$';
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_TOKEN_TTL_SECONDS = 8 * 60 * 60;

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

/**
 * Issue a signed HMAC token for the given user.
 *
 * `sessionRoot` captures the profile that originally signed in (e.g. Super
 * Admin) when a privileged account impersonates another profile. The root
 * marker fields stamped into the token let the impersonated session verify
 * it may switch *back* to the root account, even though the active profile
 * itself has no switch permission. A null/self `sessionRoot` means the token
 * has no root marker (a fresh login or a collapsed switch-back session).
 */
function issueAuthToken(user: User, sessionRoot?: Partial<User> | null): string {
  const root = sessionRoot && sessionRoot.id && sessionRoot.id !== user.id ? sessionRoot : null;
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    branchId: user.branchId || '',
    allowedBranchIds: user.allowedBranchIds || [],
    canSwitchUser: Boolean(user.canSwitchUser),
    rootId: root?.id || '',
    rootEmail: root?.email || '',
    rootCanSwitchUser: Boolean(root?.canSwitchUser),
    rootRole: root?.role || '',
    exp: Math.floor(Date.now() / 1000) + AUTH_TOKEN_TTL_SECONDS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getUserFromReq(req: any): Partial<User> {
  return req.user || {};
}

function verifyAuthToken(token: string): Partial<User> | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.sub || !parsed.email || !parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return {
      id: parsed.sub,
      email: parsed.email,
      name: parsed.name || '',
      role: parsed.role,
      branchId: parsed.branchId || '',
      allowedBranchIds: Array.isArray(parsed.allowedBranchIds) ? parsed.allowedBranchIds : [],
      canSwitchUser: Boolean(parsed.canSwitchUser),
      rootId: parsed.rootId || '',
      rootEmail: parsed.rootEmail || '',
      rootCanSwitchUser: Boolean(parsed.rootCanSwitchUser),
      rootRole: parsed.rootRole || '',
    };
  } catch (_err) {
    return null;
  }
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
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  req.user = token ? verifyAuthToken(token) : null;
  next();
}

async function requirePostgres(req: any, res: any, next: any) {
  // Keep the diagnostic endpoint reachable while the database is down.
  if (req.path === '/db/status') return next();

  if (!isPgConnected || !getIsPgConnected()) {
    const isReconnected = await ensurePostgresConnection();
    isPgConnected = isReconnected;
    setIsPgConnected(isReconnected);
  }

  if (!isPgConnected || !getIsPgConnected() || !realPoolInstance) {
    return res.status(503).json({
      message: 'PostgreSQL is unavailable. Start the database and verify the connection settings before using the application.',
    });
  }
  next();
}

/**
 * Fiscal year chosen in the UI is a view context. Mutations against a closed
 * context are restricted to the two roles permitted to make audited changes.
 */
async function enforceFiscalYearWriteAccess(req: any, res: any, next: any) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.path.startsWith('/auth/') || req.path.startsWith('/fiscal-years/') || req.path.startsWith('/sync/')) return next();

  const fiscalYearId = typeof req.headers['x-fiscal-year-id'] === 'string' ? req.headers['x-fiscal-year-id'] : '';
  if (!fiscalYearId) return next();

  try {
    const result = await pgPool.query('SELECT is_closed AS "isClosed" FROM fiscal_years WHERE id = $1;', [fiscalYearId]);
    const fiscalYear = result.rows[0];
    if (!fiscalYear?.isClosed) return next();

    const role = (req.user || getUserFromReq(req)).role;
    if (role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER') return next();
    return res.status(423).json({
      message: 'This fiscal year is closed. Only Super Admin or Inventory Manager can make an audited adjustment.',
    });
  } catch (error: any) {
    return res.status(503).json({ message: `Unable to verify fiscal-year access: ${error.message}` });
  }
}

/**
 * Authentication Enforcer Middleware
 */
function requireAuth(req: any, res: any, next: any) {
  const user = req.user;
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

function enforceOperationalPermissions(req: any, res: any, next: any) {
  if (req.method === 'GET' || req.path.startsWith('/auth/') || req.path.startsWith('/sync/')) return next();
  const rules: Array<[string, string[]]> = [
    ['/admin/', ['SUPER_ADMIN']],
    ['/branches', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/users', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/company-profile', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/document-number-configs', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/bs-calendar/', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/suppliers', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER']],
    ['/products', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/categories', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/uom', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/locations', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/stock/', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'AUDITOR']],
    ['/assets', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT']],
    ['/purchase-invoices', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'ACCOUNTANT', 'PROCUREMENT_OFFICER']],
    ['/vendor-payments', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'ACCOUNTANT', 'PROCUREMENT_OFFICER']],
    ['/vendors/', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'ACCOUNTANT', 'PROCUREMENT_OFFICER']],
  ];
  const rule = rules.find(([prefix]) => req.path === prefix.slice(0, -1) || req.path.startsWith(prefix));
  if (rule && !rule[1].includes(req.user?.role)) {
    return res.status(403).json({ message: `Forbidden: role '${req.user?.role || 'unknown'}' cannot perform this operation.` });
  }
  next();
}

async function enforceBranchAccess(req: any, res: any, next: any) {
  const user = req.user;
  if (!user || user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN') return next();
  if (req.path === '/bootstrap') {
    const requestedBootstrapBranch = req.query?.branchId;
    if (typeof requestedBootstrapBranch !== 'string' || requestedBootstrapBranch === 'ALL' || requestedBootstrapBranch !== user.branchId) {
      return res.status(403).json({ message: 'Forbidden: bootstrap must be scoped to the authenticated user branch.' });
    }
  }
  const branchScopedReadPaths = ['/stock', '/assets', '/purchase-orders', '/purchase-invoices', '/vendor-payments', '/shipments', '/stock-operations', '/customer-devices', '/customers', '/approval-requests', '/locations'];
  if (req.method === 'GET' && branchScopedReadPaths.some((path) => req.path === path || req.path.startsWith(`${path}/`))) {
    if (req.query?.branchId !== user.branchId && !(user.allowedBranchIds || []).includes(req.query?.branchId)) {
      return res.status(403).json({ message: 'Forbidden: branch-scoped reads require an authorized branch filter.' });
    }
  }
  const requested = new Set<string>();
  for (const value of [req.query?.branchId, req.body?.branchId, req.body?.sourceBranchId, req.body?.destinationBranchId]) {
    if (typeof value === 'string' && value && value !== 'ALL') requested.add(value);
  }
  const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])]);
  if ([...requested].some((branchId) => !allowed.has(branchId))) {
    return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
  }
  if (requested.size === 0 && (req.query?.branchId === 'ALL' || req.body?.branchId === 'ALL')) {
    return res.status(403).json({ message: 'Forbidden: branch users cannot access all branches.' });
  }
  if (isPgConnected && req.params?.id) {
    const resourceTables: Array<[string, string, string[]]> = [
      ['/stock', 'inventory_stock', ['branch_id']],
      ['/assets', 'fixed_assets', ['branch_id']],
      ['/purchase-orders', 'purchase_orders', ['branch_id']],
      ['/purchase-invoices', 'purchase_invoices', ['branch_id']],
      ['/vendor-payments', 'vendor_payments', ['branch_id']],
      ['/shipments', 'shipments', ['source_branch_id', 'destination_branch_id']],
      ['/stock-operations', 'stock_operations', ['branch_id', 'destination_warehouse_id']],
      ['/customer-devices', 'customer_device_records', ['branch_id']],
      ['/customers', 'customer_records', ['branch_id']],
      ['/approval-requests', 'approval_requests', ['branch_id']],
      ['/locations', 'locations', ['branch_id']],
    ];
    const resource = resourceTables.find(([prefix]) => req.path === `${prefix}/${req.params.id}` || req.path.startsWith(`${prefix}/${req.params.id}/`));
    if (resource) {
      const columns = resource[2].join(', ');
      const lookup = resource[1] === 'shipments' ? 'id = $1 OR tracking_code = $1' : 'id = $1';
      const result = await pgPool.query(`SELECT ${columns} FROM ${resource[1]} WHERE ${lookup} LIMIT 1`, [req.params.id]);
      const row = result.rows[0];
      if (row && !resource[2].some((column) => allowed.has(row[column]))) {
        return res.status(403).json({ message: 'Forbidden: this record belongs to another branch.' });
      }
    }
  }
  next();
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
    userEmail: u.email || '',
    userName: u.name || '',
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
        // 'ALL' is the app-wide "all branches" sentinel, not a real branch id —
        // store NULL so the branch_id FK is never violated.
        auditItem.branchId && auditItem.branchId !== 'ALL' ? auditItem.branchId : null,
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

// Normalizes a database date value (pg Date object, ISO datetime string, or
// 'YYYY-MM-DD' text) into a 'YYYY-MM-DD' calendar string so it can be safely
// compared against fiscal-year boundary dates. Returns '' when the value
// cannot be interpreted as a date.
function toCalendarDate(value: any): string {
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
function pickCurrentFiscalYear(years: any[]): any | undefined {
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
function getFiscalYearCodeForDate(dateValue: any): string {
  const dateStr = toCalendarDate(dateValue);
  if (!dateStr) return '';
  for (const fiscalYear of fiscalYears) {
    const start = toCalendarDate(fiscalYear.startDateAD);
    const end = toCalendarDate(fiscalYear.endDateAD);
    if (start && end && dateStr >= start && dateStr <= end) return fiscalYear.code;
  }
  return '';
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
function computeTradingFromOps(ops: any[], productsList: any[]) {
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
// UNIFIED BATCH BOOTSTRAP ENDPOINT (1-ROUNDTRIP SYNC)
// ==========================================
app.get('/api/bootstrap', async (req, res) => {
  const { branchId, fiscalYearId } = req.query;
  const bId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;
  const fId = typeof fiscalYearId === 'string' && fiscalYearId.trim() !== '' ? fiscalYearId : undefined;

  if (isPgConnected) {
    try {
      // Resolve the fiscal-year scope first so every operational table can be
      // filtered in SQL (branch + fiscal-year AD date range) instead of
      // fetching all rows and filtering them in JavaScript.
      const fyRes = await pgPool.query('SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo" FROM fiscal_years ORDER BY start_date_ad DESC');
      const pgFiscalYears = fyRes.rows;
      // Default view: the active fiscal year, so the app always shows records
      // from the current fiscal year. An explicit fiscalYearId query param
      // overrides this and filters the data to that fiscal year.
      const selectedFiscalYear = fId
        ? pgFiscalYears.find((fiscalYear: any) => fiscalYear.id === fId)
        : pickCurrentFiscalYear(pgFiscalYears);
      const fyStartAD = selectedFiscalYear ? toCalendarDate(selectedFiscalYear.startDateAD) : '';
      const fyEndAD = selectedFiscalYear ? toCalendarDate(selectedFiscalYear.endDateAD) : '';
      const hasFyScope = Boolean(fyStartAD && fyEndAD);

      // Builds a WHERE clause + params for one bootstrap query: optional
      // branch filter (single column, or an OR pair for shipments) and the
      // fiscal-year AD date range on the table's primary date column.
      const scoped = (opts: { branchCol?: string; branchOrCols?: [string, string]; dateCol?: string } = {}) => {
        const conds: string[] = [];
        const params: any[] = [];
        if (bId && opts.branchCol) {
          params.push(bId);
          conds.push(`${opts.branchCol} = $${params.length}`);
        }
        if (bId && opts.branchOrCols) {
          params.push(bId, bId);
          conds.push(`(${opts.branchOrCols[0]} = $${params.length - 1} OR ${opts.branchOrCols[1]} = $${params.length})`);
        }
        if (hasFyScope && opts.dateCol) {
          params.push(fyStartAD, fyEndAD);
          conds.push(`${opts.dateCol} >= $${params.length - 1}`);
          conds.push(`${opts.dateCol} <= $${params.length}`);
        }
        return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
      };

      const stockScope = scoped({ branchCol: 'branch_id' });
      // Fixed assets are long-term assets that persist across all fiscal years — do NOT
      // filter by acquisition_date_ad / fiscal year scope; only filter by branch.
      const assetScope = scoped({ branchCol: 'branch_id' });
      const deviceScope = scoped({ branchCol: 'branch_id', dateCol: 'issued_date_ad' });
      const customerScope = scoped({ branchCol: 'branch_id' });
      const poScope = scoped({ branchCol: 'branch_id', dateCol: 'order_date_ad' });
      const piScope = scoped({ branchCol: 'branch_id', dateCol: 'invoice_date_ad' });
      const shipmentScope = scoped({ branchOrCols: ['source_branch_id', 'destination_branch_id'], dateCol: 'dispatch_date_ad' });
      const opScope = scoped({ branchCol: 'branch_id', dateCol: 'date_ad' });
      const auditScope = scoped({ dateCol: 'timestamp_ad' });
      const txnScope = scoped({ dateCol: 'timestamp_ad' });
      const approvalScope = scoped({ branchCol: 'branch_id', dateCol: 'requested_at_ad' });
      const locationScope = scoped({ branchCol: 'branch_id' });

      const damageScope = scoped({ branchCol: 'branch_id', dateCol: 'damage_date_ad' });
      const vpScope = scoped({ branchCol: 'branch_id', dateCol: 'payment_date_ad' });

      const [
        bRes, pRes, sRes, aRes, dRes, cRes, poRes, piRes, shRes, opRes, auditRes, txnRes, supRes, uRes, appRes, catRes, uomRes, locRes, compDbRes, dmgRes, vpRes, vobRes
      ] = await Promise.all([
        pgPool.query('SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches'),
        pgPool.query('SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products'),
        pgPool.query(`SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock${stockScope.where}`, stockScope.params),
        pgPool.query(`SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS", purchase_invoice_date_ad AS "purchaseInvoiceDateAD", purchase_invoice_date_bs AS "purchaseInvoiceDateBS", capitalization_date_ad AS "capitalizationDateAD", placed_in_service_date_ad AS "placedInServiceDateAD", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo", purchase_invoice_id AS "purchaseInvoiceId" FROM fixed_assets${assetScope.where}`, assetScope.params),
        pgPool.query(`SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAD", issued_date_bs AS "issuedDateBS", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records${deviceScope.where}`, deviceScope.params),
        pgPool.query(`SELECT id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount" FROM customer_records${customerScope.where}`, customerScope.params),
        pgPool.query(`SELECT id, po_number AS "poNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS", expected_delivery_date_ad AS "expectedDeliveryDateAD", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders${poScope.where}`, poScope.params),
        pgPool.query(`SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", amount_paid AS "amountPaid", items FROM purchase_invoices${piScope.where}`, piScope.params),
        pgPool.query(`SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS", estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAD", received_date_bs AS "receivedDateBS", has_discrepancy AS "hasDiscrepancy" FROM shipments${shipmentScope.where}`, shipmentScope.params),
        pgPool.query(`SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAD", date_bs AS "dateBS", fiscal_year AS "fiscalYear", status, items FROM stock_operations${opScope.where}`, opScope.params),
        pgPool.query(`SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs${auditScope.where} ORDER BY timestamp_ad DESC LIMIT 200`, auditScope.params),
        pgPool.query(`SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs${txnScope.where} ORDER BY timestamp_ad DESC`, txnScope.params),
        pgPool.query('SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers'),
        pgPool.query('SELECT id, email, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users'),
        pgPool.query(`SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status, requested_at_ad AS "requestedAtAD", requested_at_bs AS "requestedAtBS", fiscal_year_id AS "fiscalYearId" FROM approval_requests${approvalScope.where}`, approvalScope.params),
        pgPool.query('SELECT id, name, code, description, is_special_tracked AS "isSpecialTracked" FROM categories ORDER BY name ASC'),
        pgPool.query('SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC'),
        pgPool.query(`SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations${locationScope.where}`, locationScope.params),
        pgPool.query('SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1'),
        pgPool.query(`SELECT id, damage_reference AS "damageReference", product_id AS "productId", branch_id AS "branchId", quantity_damaged AS "quantityDamaged", unit_cost AS "unitCost", total_cost AS "totalCost", damage_date_ad AS "damageDateAD", damage_date_bs AS "damageDateBS", damage_reason AS "damageReason", status, disposal_date_ad AS "disposalDateAD", disposal_date_bs AS "disposalDateBS", disposal_method AS "disposalMethod", salvage_value AS "salvageValue", gl_account_code AS "glAccountCode", write_off_loss AS "writeOffLoss", approved_by AS "approvedBy", notes, fiscal_year_id AS "fiscalYearId", is_demo AS "isDemo", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt" FROM damage_records${damageScope.where} ORDER BY damage_date_ad DESC`, damageScope.params),
        pgPool.query(`SELECT id, payment_number AS "paymentNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_id AS "invoiceId", invoice_number AS "invoiceNumber", payment_date_ad AS "paymentDateAD", payment_date_bs AS "paymentDateBS", amount, payment_method AS "paymentMethod", bank_name AS "bankName", bank_branch AS "bankBranch", account_number AS "accountNumber", cheque_number AS "chequeNumber", cheque_date_ad AS "chequeDateAD", cheque_date_bs AS "chequeDateBS", transaction_reference AS "transactionReference", notes, status, reversal_reason AS "reversalReason", reversed_by AS "reversedBy", reversed_at_ad AS "reversedAtAD", original_payment_id AS "originalPaymentId", fiscal_year_id AS "fiscalYearId", is_demo AS "isDemo", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt" FROM vendor_payments${vpScope.where} ORDER BY payment_date_ad DESC, created_at DESC`, vpScope.params),
        // Vendor Opening Balances (for correct Accounts Payable = opening + invoices − payments)
        pgPool.query(
          `SELECT COALESCE(SUM(opening_balance), 0)::float AS "totalOpeningBalance"
           FROM vendor_opening_balances
           WHERE fiscal_year_id = $1` + (bId ? ` AND branch_id = $2` : ''),
          bId ? [selectedFiscalYear.id, bId] : [selectedFiscalYear.id]
        ),
      ]);

      let pgStock = sRes.rows;
      if (selectedFiscalYear && !selectedFiscalYear.isCurrent) {
        const openingStockResult = await pgPool.query(
          `SELECT 'opening-' || fiscal_year_id || '-' || product_id || '-' || branch_id AS id,
                  product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand",
                  damaged_qty AS "damagedQty", 0 AS "reservedQty", 0 AS "incomingQty", 0 AS "minReorderLevel"
           FROM fiscal_year_opening_stock WHERE fiscal_year_id = $1${bId ? ' AND branch_id = $2' : ''};`,
          bId ? [selectedFiscalYear.id, bId] : [selectedFiscalYear.id]
        );
        pgStock = openingStockResult.rows;
      }
      // Fiscal-year and branch scoping is applied in the SQL queries above
      // (see scoped()), so no JavaScript date filtering is needed here.
      const pgProducts = pRes.rows;
      const pgAssets = aRes.rows;
      const pgCustomerDevices = dRes.rows;
      const pgPurchaseOrders = poRes.rows;
      const pgInvoices = piRes.rows;
      const pgShipments = shRes.rows;
      const pgOps = opRes.rows;
      const pgAuditLogs = auditRes.rows;
      const pgTransactionLogs = txnRes.rows;
      const pgApprovalRequests = appRes.rows;

      const totalInventoryAssetValue = pgStock.reduce((sum: number, item: any) => {
        const prod = pgProducts.find((p: any) => p.id === item.productId);
        return sum + (prod ? Number(prod.costPrice) * Number(item.quantityOnHand) : 0);
      }, 0);

      const totalFixedAssetValue = pgAssets.reduce((sum: number, a: any) => sum + Number(a.netBookValue || 0), 0);
      // Accounts Payable: opening balance (carry-forward from Vendor Opening Balances)
      // + current-period unpaid invoices − posted vendor payments.  This matches
      // the Vendor Ledger closing-balance formula so all three modules reconcile.
      const vendorOpeningBalTotal = Number(vobRes.rows[0]?.totalOpeningBalance || 0);
      // Sum full invoice grand totals, NOT (grandTotal − amountPaid): payments
      // are already subtracted once below via the posted vendor payments, so
      // subtracting amount_paid here too would double-count them.
      const currentPeriodInvoiceTotal = pgInvoices.reduce(
        (sum: number, inv: any) => sum + Number(inv.grandTotal || 0),
        0
      );
      const postedPayments = (vpRes.rows || [])
        .filter((p: any) => p.status === 'POSTED')
        .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
      const totalAccountsPayable = vendorOpeningBalTotal + currentPeriodInvoiceTotal - postedPayments;
      const totalDamageLossValue = pgOps.reduce((sum: number, op: any) => sum + Number(op.totalValue || 0), 0);
      const totalVatInputTax = pgInvoices.reduce((sum: number, inv: any) => sum + Number(inv.vatAmount || 0), 0);
      const currentFy = pickCurrentFiscalYear(pgFiscalYears)?.code || '';

      // Trading summary — sales revenue + COGS derived from the same priced
      // STOCK_OUT sale lines so Revenue − COGS = Gross Surplus reconciles to
      // the inventory-at-cost balance sheet.
      const tradingSummary = computeTradingFromOps(pgOps, pgProducts);
      const financialSummary = {
        totalInventoryAssetValue,
        totalFixedAssetValue,
        totalAccountsPayable,
        totalSalesRevenue: tradingSummary.totalSalesRevenue,
        totalCostOfGoodsSold: tradingSummary.totalCostOfGoodsSold,
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
        customerDevices: pgCustomerDevices,
        customers: cRes.rows,
        purchaseOrders: pgPurchaseOrders,
        purchaseInvoices: pgInvoices,
        shipments: pgShipments,
        stockOperations: pgOps,
        fiscalYears: pgFiscalYears,
        auditLogs: pgAuditLogs,
        transactionLogs: pgTransactionLogs,
        financialSummary,
        suppliers: supRes.rows,
        users: uRes.rows,
        approvalRequests: pgApprovalRequests,
        categories: catRes.rows,
        uom: uomRes.rows,
        locations: locRes.rows,
        companyProfile: compDbRes.rows[0] || companyProfile,
        damageRecords: dmgRes.rows,
        vendorPayments: vpRes.rows,
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
  let isConnected = await ensurePostgresConnection();
  let errorDetails = '';
  let tableCount = 0;

  if (isConnected && realPoolInstance) {
    try {
      const client = await realPoolInstance.connect();
      const testRes = await client.query('SELECT current_database(), version(), (SELECT count(*) FROM information_schema.tables WHERE table_schema = \'public\') as tables');
      client.release();
      isConnected = true;
      isPgConnected = true;
      setIsPgConnected(true);
      tableCount = parseInt(testRes.rows[0]?.tables || '0', 10);
    } catch (err: any) {
      isConnected = false;
      isPgConnected = false;
      setIsPgConnected(false);
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
// Removes ONLY rows marked is_demo = TRUE (the dataset created by
// `npm run setup:pg`). Real business data (is_demo = FALSE), users,
// branches and fiscal years are never touched.
app.post('/api/admin/clear-demo-data', async (req, res) => {
  try {
    // Child/detail tables first so their is_demo rows are counted before
    // parent rows are removed (FK cascades would otherwise hide them).
    const demoTables = [
      'transaction_logs',
      'audit_logs',
      'vendor_payments',
      'stock_operations',
      'approval_requests',
      'customer_device_records',
      'purchase_invoices',
      'shipments',
      'inventory_stock',
      'fixed_assets',
      'purchase_orders',
      'customer_records',
      'products',
      'categories',
      'suppliers',
      'fiscal_years',
    ];
    const removed: Record<string, number> = {};
    for (const table of demoTables) {
      const result = await pgPool.query(`DELETE FROM ${table} WHERE is_demo = TRUE`);
      removed[table] = result.rowCount || 0;
    }

    // Re-hydrate the runtime caches so memory matches the database again.
    const client = await pgPool.connect();
    try {
      await hydrateOperationalData(client);
    } finally {
      client.release();
    }

    dataVersion++;
    sseClients.forEach((client) => {
      try {
        client.write(`data: ${JSON.stringify({ type: 'DEMO_DATA_CLEARED', dataVersion, timestamp: new Date().toISOString() })}\n\n`);
      } catch (_e) {}
    });

    const totalRemoved = Object.values(removed).reduce((a, b) => a + b, 0);
    return res.json({
      message: `Demo data only removed (${totalRemoved} rows where is_demo = TRUE). Real data, users, and branches are intact.`,
      removedRows: removed,
      totalRemoved,
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
      const existingAdmin = await pgPool.query("SELECT 1 FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1");
      if (existingAdmin.rowCount) {
        return res.status(409).json({ message: 'Super Admin setup is already complete. Please sign in instead.' });
      }
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
      return res.status(201).json({ user: userWithoutPass, token: issueAuthToken(savedUser) });
    } catch (err: any) {
      console.error('Error setting up Super Admin in DB:', err);
      return res.status(503).json({
        message: 'Unable to set up Super Admin because PostgreSQL is unavailable. Try again when the database is online.',
      });
    }
  }

  if (users.some((u) => u.role === 'SUPER_ADMIN')) {
    return res.status(409).json({ message: 'Super Admin setup is already complete. Please sign in instead.' });
  }
  const existingUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
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
  return res.status(201).json({ user: localUserWithoutPass, token: issueAuthToken(localUser) });
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
    adminEmail: adminUser?.email || 'superadmin@example.com',
    message: `Reset request logged for ${user.name}. Please contact your System Administrator (${adminUser?.email || 'superadmin@example.com'}) or ask your Manager to reset your password in User & Staff Management.`,
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
      return res.json({ user: userWithoutPass, token: issueAuthToken(dbUser) });
    }

    const localUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
    const passwordCheck = localUser ? verifyPassword(String(password || ''), localUser.password || '') : { valid: false };
    if (!localUser || !passwordCheck.valid) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    if (passwordCheck.upgradedHash) localUser.password = passwordCheck.upgradedHash;
    activeUser = localUser;
    const { password: _, ...userWithoutPass } = localUser;
    return res.json({ user: userWithoutPass, token: issueAuthToken(localUser) });
  } catch (err: any) {
    console.error('PostgreSQL login query failed:', err?.message || err);
    return res.status(503).json({
      message: 'Unable to verify credentials because PostgreSQL is unavailable. Try again when the database is online.',
    });
  }
});

app.get('/api/auth/me', (req, res) => {
  const authenticatedUser = (req as any).user;
  if (!authenticatedUser) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  res.json(authenticatedUser);
});

// Profile Switching Endpoint
app.post('/api/auth/switch-profile', async (req, res) => {
  // A valid signed session and explicit switch permission are required.
  // After a server restart the browser may still hold a stale local session;
  // rejecting here forces a clean re-login instead of a broken switch.
  const activeProfile = (req as any).user;
  if (!activeProfile) {
    return res.status(401).json({ message: 'Not authenticated. Log in again to switch profiles.' });
  }

  // Authorization gate:
  //  - A profile that itself has switch permission may switch (canSwitchUser).
  //  - A profile that is SUPER_ADMIN may always switch.
  //  - An impersonated profile may switch *back* to its root (the account that
  //    initiated the session) when the root granted switching or is SUPER_ADMIN.
  const isActiveSuperAdmin = activeProfile.role === 'SUPER_ADMIN';
  const rootAllowed =
    Boolean(activeProfile.rootId) &&
    (Boolean(activeProfile.rootCanSwitchUser) || activeProfile.rootRole === 'SUPER_ADMIN');
  if (!activeProfile.canSwitchUser && !isActiveSuperAdmin && !rootAllowed) {
    return res.status(403).json({ message: 'Profile switching is not enabled for this account.' });
  }

  const { targetUserId } = req.body;
  const targetEmail = typeof req.body?.targetEmail === 'string' ? req.body.targetEmail.trim() : '';
  let user: any = null;

  // PostgreSQL is the source of truth for user profiles. The in-memory user
  // list can be stale (users created/edited after boot, or a data reset),
  // which previously caused "Target user profile not found" on switch.
  // The frontend sends the target email alongside the id so a re-created
  // account (new id after a demo data reset) can still be resolved.
  if (isPgConnected && (targetUserId || targetEmail)) {
    try {
      const dbRes = await pgPool.query(
        'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users WHERE id = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
        [String(targetUserId || ''), String(targetEmail || '')]
      );
      user = dbRes.rows[0] || null;
    } catch (err: any) {
      console.error('PostgreSQL switch-profile lookup failed:', err?.message || err);
    }
  }

  // Fallback to the in-memory mirror when PostgreSQL is unavailable.
  if (!user) {
    user =
      users.find((u) => u.id === targetUserId || u.email === targetUserId || u.email.toLowerCase() === targetEmail.toLowerCase()) || null;
  }

  if (!user) {
    return res.status(404).json({ message: 'Target user profile not found.' });
  }

  // Keep the in-memory user list in sync with the database row.
  const memIdx = users.findIndex((u) => u.id === user.id);
  if (memIdx >= 0) users[memIdx] = { ...users[memIdx], ...user };
  else users.push(user);

  const previousUser = activeProfile;
  activeUser = user;

  // Resolve the session root marker for the next token:
  //  - Switching back to the root collapses the marker to null (fresh root session).
  //  - Otherwise carry the existing root marker forward (preserves the chain).
  const rootId = previousUser?.rootId || '';
  const rootEmail = previousUser?.rootEmail || '';
  const targetIsRoot =
    Boolean(rootId) &&
    (user.id === rootId || (rootEmail && user.email?.toLowerCase() === rootEmail.toLowerCase()));
  const sessionRoot = targetIsRoot
    ? null
    : rootId
      ? { id: rootId, email: rootEmail, canSwitchUser: previousUser?.rootCanSwitchUser, role: previousUser?.rootRole }
      : previousUser?.id && previousUser.id !== user.id
        ? { id: previousUser.id, email: previousUser.email, canSwitchUser: previousUser.canSwitchUser, role: previousUser.role }
        : null;

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
  res.json({ user: userWithoutPass, token: issueAuthToken(user, sessionRoot) });
});

// Profile Update Endpoint
app.put('/api/auth/profile', (req, res) => {
  const authenticatedUser = (req as any).user;
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
      branchId: req.body.branchId || 'WH001',
      address: req.body.address || '',
      coordinates: req.body.coordinates || { latitude: 0, longitude: 0 },
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
      const { rows } = await pgPool.query(
        'SELECT id, name, code, description, is_special_tracked AS "isSpecialTracked" FROM categories ORDER BY name ASC'
      );
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
      isSpecialTracked: Boolean(req.body.isSpecialTracked),
    };
    const existingIdx = categories.findIndex((c) => c.id === newCat.id || c.name.toLowerCase() === newCat.name.toLowerCase());
    if (existingIdx !== -1) {
      categories[existingIdx] = newCat;
    } else {
      categories.push(newCat);
    }

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO categories (id, name, code, description, is_special_tracked)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           description = EXCLUDED.description,
           is_special_tracked = EXCLUDED.is_special_tracked;`,
        [newCat.id, newCat.name, newCat.code, newCat.description, newCat.isSpecialTracked]
      );
    }
    logAuditEvent(req, 'CREATE_CATEGORY', 'CATEGORIES', `Created category ${newCat.name} (${newCat.code})`);
    broadcastChange({ type: 'CATEGORY_CREATED', entity: 'categories' });
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
        `UPDATE categories
         SET name = $1,
             code = $2,
             description = $3,
             is_special_tracked = $4
         WHERE id = $5;`,
        [updated.name, updated.code, updated.description || '', Boolean(updated.isSpecialTracked), id]
      );
    }
    logAuditEvent(req, 'UPDATE_CATEGORY', 'CATEGORIES', `Updated category ${updated.name}`);
    broadcastChange({ type: 'CATEGORY_UPDATED', entity: 'categories' });
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
    broadcastChange({ type: 'CATEGORY_DELETED', entity: 'categories' });
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

// Administrative repair actions. These update derived values only; source
// documents and transaction history remain unchanged.
app.post('/api/admin/recalculate/fixed-assets', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const asOfDateAD = new Date().toISOString().slice(0, 10);
    let assetsToUpdate = assetRegister;
    if (isPgConnected) {
      const result = await pgPool.query(
        `SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId",
          acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS",
          purchase_invoice_date_ad AS "purchaseInvoiceDateAD", purchase_invoice_date_bs AS "purchaseInvoiceDateBS",
          capitalization_date_ad AS "capitalizationDateAD", placed_in_service_date_ad AS "placedInServiceDateAD",
                acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod",
                depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation",
                net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo"
         FROM fixed_assets`);
      assetsToUpdate = result.rows as Asset[];
    }

    for (const asset of assetsToUpdate) {
      const values = calculateFixedAssetValues({ ...asset, asOfDateAD });
      asset.accumulatedDepreciation = values.accumulatedDepreciation;
      asset.netBookValue = values.netBookValue;
      if (isPgConnected) {
        await pgPool.query(
          `UPDATE fixed_assets
           SET accumulated_depreciation = $1, net_book_value = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [values.accumulatedDepreciation, values.netBookValue, asset.id]
        );
      }
    }
    logAuditEvent(req, 'RECALCULATE_FIXED_ASSETS', 'SYSTEM', `Recalculated ${assetsToUpdate.length} fixed asset record(s) as of ${asOfDateAD}.`);
    res.json({ updated: assetsToUpdate.length, message: `Recalculated ${assetsToUpdate.length} fixed asset record(s) as of ${asOfDateAD}.` });
  } catch (error: any) {
    console.error('Error recalculating fixed assets:', error);
    res.status(500).json({ message: `Unable to recalculate fixed assets: ${error.message}` });
  }
});

app.post('/api/admin/recalculate/live-stock', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const latestByStock = new Map<string, { quantityAfter: number; timestampAD: string }>();
    transactionLogs
      .filter((log) => log.changeType !== 'DAMAGE')
      .forEach((log) => {
        const key = `${log.productId}:${log.branchId}`;
        const previous = latestByStock.get(key);
        if (!previous || String(log.timestampAD) > previous.timestampAD) {
          latestByStock.set(key, { quantityAfter: Number(log.quantityAfter) || 0, timestampAD: String(log.timestampAD) });
        }
      });

    let updated = 0;
    if (isPgConnected) {
      const result = await pgPool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (product_id, branch_id) product_id, branch_id, GREATEST(quantity_after, 0) AS quantity_after
           FROM transaction_logs
           WHERE change_type <> 'DAMAGE'
           ORDER BY product_id, branch_id, timestamp_ad DESC, id DESC
         )
         UPDATE inventory_stock s
         SET quantity_on_hand = latest.quantity_after, last_updated = CURRENT_TIMESTAMP
         FROM latest
         WHERE s.product_id = latest.product_id AND s.branch_id = latest.branch_id
         RETURNING s.id`);
      updated = result.rowCount || 0;
    } else {
      inventoryStock.forEach((stock) => {
        const latest = latestByStock.get(`${stock.productId}:${stock.branchId}`);
        if (latest) {
          stock.quantityOnHand = Math.max(0, latest.quantityAfter);
          stock.lastUpdated = new Date().toISOString();
          updated += 1;
        }
      });
    }
    logAuditEvent(req, 'RECALCULATE_LIVE_STOCK', 'SYSTEM', `Recalculated ${updated} live stock balance(s) from the latest non-damage transaction.`);
    res.json({ updated, message: `Recalculated ${updated} live stock balance(s) from transaction history.` });
  } catch (error: any) {
    console.error('Error recalculating live stock:', error);
    res.status(500).json({ message: `Unable to recalculate live stock: ${error.message}` });
  }
});

app.patch('/api/stock/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantityOnHand, minReorderLevel, damagedQty, reason, changeType } = req.body;
    for (const [field, value] of Object.entries({ quantityOnHand, minReorderLevel, damagedQty })) {
      if (value !== undefined && (!Number.isInteger(Number(value)) || Number(value) < 0)) {
        return res.status(400).json({ message: `${field} must be a non-negative integer.` });
      }
    }
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
    }

    // Manual damage adjustments (PATCH /api/stock/:id with a damagedQty
    // delta) also create/update a damage_records lifecycle entry so the
    // damage register stays in sync with the stock level.
    if (damagedQty !== undefined && Number(damagedQty) !== oldDamaged) {
      const affectedQty = isDamageChange && Number(damagedQty) > oldDamaged
        ? Number(damagedQty) - oldDamaged
        : oldDamaged - Number(damagedQty);
      const absAffected = Math.abs(affectedQty || 0);
      if (absAffected > 0) {
        const todayAD = new Date().toISOString().split('T')[0];
        const damageRef = `DMR-ADJ-${stk.id}-${Date.now()}`;
        const damageRecordId = `dmr-adj-${stk.id}-${Date.now()}`;
        const knownReason = (reason || 'Damaged stock balance verification').toUpperCase();
        const damageReason = ['PHYSICAL_DAMAGE', 'TRANSIT_DAMAGE', 'STORAGE_DAMAGE', 'EXPIRED', 'RETURN_DAMAGE', 'QUALITY_DEFECT', 'OTHER'].find((r) => knownReason.includes(r)) || 'OTHER';
        try {
          if (isPgConnected) {
            await pgPool.query(
              `INSERT INTO damage_records (
                 id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
                 damage_date_ad, damage_date_bs, damage_reason, status, salvage_value, gl_account_code,
                 write_off_loss, approved_by, notes, is_demo, created_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'IDENTIFIED', 0, 'GL-5120 (Loss on Inventory Scrap & Write-off)', 0, $11, $12, FALSE, $13)
               ON CONFLICT (id) DO NOTHING`,
              [
                damageRecordId,
                damageRef,
                stk.productId,
                stk.branchId,
                absAffected,
                prod?.costPrice || 0,
                (prod?.costPrice || 0) * absAffected,
                todayAD,
                '2083-04-16 BS',
                damageReason,
                getUserFromReq(req).name || 'Stock Manager',
                reason || 'Damaged stock balance verification',
                getUserFromReq(req).email || 'system',
              ]
            );
          }
          const existingIdx = damageRecords.findIndex((dr) => dr.id === damageRecordId || dr.damageReference === damageRef);
          if (existingIdx >= 0) {
            damageRecords[existingIdx] = {
              ...damageRecords[existingIdx],
              quantityDamaged: absAffected,
              status: 'IDENTIFIED',
              damageReason: damageReason as DamageRecord['damageReason'],
            };
          } else {
            damageRecords.unshift({
              id: damageRecordId,
              damageReference: damageRef,
              productId: stk.productId,
              branchId: stk.branchId,
              quantityDamaged: absAffected,
              unitCost: prod?.costPrice || 0,
              totalCost: (prod?.costPrice || 0) * absAffected,
              damageDateAD: todayAD,
              damageDateBS: '2083-04-16 BS',
              damageReason: damageReason as DamageRecord['damageReason'],
              status: 'IDENTIFIED',
              salvageValue: 0,
              glAccountCode: 'GL-5120 (Loss on Inventory Scrap & Write-off)',
              writeOffLoss: 0,
              approvedBy: getUserFromReq(req).name || 'Stock Manager',
              notes: reason || 'Damaged stock balance verification',
              isDemo: false,
              createdBy: getUserFromReq(req).email || 'system',
            } as DamageRecord);
          }
        } catch (drErr: any) {
          console.warn('Damage record sync notice:', drErr?.message || drErr);
        }
      }
    }

    if (!isDamageChange && quantityOnHand !== undefined && (stk.quantityOnHand - qtyBefore !== 0)) {
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
  } catch (err: any) {
    console.error('Error updating stock level:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.patch('/api/stock/:id/reorder-level', async (req, res) => {
  try {
    const { id } = req.params;
    const { minReorderLevel, productId, branchId } = req.body;
    if (!Number.isInteger(Number(minReorderLevel)) || Number(minReorderLevel) < 0) {
      return res.status(400).json({ message: 'Reorder level must be a non-negative integer.' });
    }
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

          // Physical audit reconciliation also records the damage lifecycle:
          // a negative shortage for a product that already has damaged stock is
          // reflected in the damage register so it shows up in the ledger.
          if (delta < 0 && Number(item.damagedQty ?? stk.damagedQty ?? 0) > 0) {
            const damageQtyRec = Number(item.damagedQty ?? stk.damagedQty ?? 0);
            await client.query(
              `INSERT INTO damage_records (
                 id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
                 damage_date_ad, damage_date_bs, damage_reason, status, salvage_value, gl_account_code,
                 write_off_loss, approved_by, notes, is_demo, created_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OTHER', 'IDENTIFIED', 0, 'GL-5120 (Loss on Inventory Scrap & Write-off)', 0, $10, $11, FALSE, $12)
               ON CONFLICT (id) DO NOTHING`,
              [
                `dmr-audit-${auditRefNumber || 'AUD'}-${item.productId}`,
                `AUDIT-${auditRefNumber || Date.now()}-${item.productId}`,
                item.productId,
                branchId,
                Math.min(damageQtyRec, Math.abs(delta)),
                unitCost || prod?.costPrice || 0,
                (unitCost || prod?.costPrice || 0) * Math.min(damageQtyRec, Math.abs(delta)),
                new Date().toISOString().split('T')[0],
                '2083-04-22 BS',
                auditorName || userEmail || 'AUDITOR',
                notes || `Physical audit shortage write-off (${auditRefNumber || 'DIRECT'})`,
                userEmail || 'system',
              ]
            );
          }
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
        'SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS", purchase_invoice_date_ad AS "purchaseInvoiceDateAD", purchase_invoice_date_bs AS "purchaseInvoiceDateBS", capitalization_date_ad AS "capitalizationDateAD", placed_in_service_date_ad AS "placedInServiceDateAD", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo", purchase_invoice_id AS "purchaseInvoiceId", product_id AS "productId" FROM fixed_assets' +
        (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') +
        ' ORDER BY created_at DESC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows.map((asset: any) => ({
        ...asset,
        ...calculateFixedAssetValues({
          ...asset,
          acquisitionDateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD,
          asOfDateAD: new Date().toISOString().slice(0, 10),
        }),
      })));
    } catch (err) {
      console.error('Error fetching assets from DB:', err);
    }
  }
  const filtered = branchId && branchId !== 'ALL'
    ? assetRegister.filter((a) => a.branchId === branchId)
    : assetRegister;
  return res.json(filtered.map((asset) => ({
    ...asset,
    ...calculateFixedAssetValues({
      ...asset,
      acquisitionDateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD,
      asOfDateAD: new Date().toISOString().slice(0, 10),
    }),
  })));
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
      acquisitionDateAD: req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      acquisitionDateBS: req.body.acquisitionDateBS || req.body.acquisitionDateBs || '2083-04-10 BS',
      purchaseInvoiceDateAD: req.body.purchaseInvoiceDateAD || req.body.purchaseInvoiceDateAd || req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      purchaseInvoiceDateBS: req.body.purchaseInvoiceDateBS || req.body.purchaseInvoiceDateBs || req.body.acquisitionDateBS || req.body.acquisitionDateBs || '2083-04-10 BS',
      capitalizationDateAD: req.body.capitalizationDateAD || req.body.capitalizationDateAd || req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      placedInServiceDateAD: req.body.placedInServiceDateAD || req.body.placedInServiceDateAd || req.body.acquisitionDateAD || req.body.acquisitionDateAd || new Date().toISOString().split('T')[0],
      acquisitionCost: Number(req.body.acquisitionCost) || 0,
      depreciationMethod: req.body.depreciationMethod || 'STRAIGHT_LINE',
      depreciationRatePercent: Number(req.body.depreciationRatePercent || req.body.depreciationRate) || 15,
      accumulatedDepreciation: 0,
      netBookValue: 0,
      status: req.body.status || 'ACTIVE',
      supplierName: req.body.supplierName || '',
      invoiceNo: req.body.invoiceNo || '',
      purchaseInvoiceId: req.body.purchaseInvoiceId || null,
      productId: req.body.productId || null,
    };

    const linkedInvoice = newAsset.purchaseInvoiceId
      ? purchaseInvoices.find((invoice) => invoice.id === newAsset.purchaseInvoiceId)
      : undefined;
    if (linkedInvoice && !req.body.purchaseInvoiceDateAD && !req.body.purchaseInvoiceDateAd) {
      newAsset.purchaseInvoiceDateAD = linkedInvoice.invoiceDateAD;
      newAsset.purchaseInvoiceDateBS = linkedInvoice.invoiceDateBS;
    }

    const computedValues = calculateFixedAssetValues({
      ...newAsset,
      acquisitionDateAD: newAsset.acquisitionDateAD,
    });
    newAsset.accumulatedDepreciation = computedValues.accumulatedDepreciation;
    newAsset.netBookValue = computedValues.netBookValue;
    const idx = assetRegister.findIndex((a) => a.id === newAsset.id);
    if (idx >= 0) assetRegister[idx] = newAsset as any;
    else assetRegister.unshift(newAsset as any);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO fixed_assets (
           id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, purchase_invoice_date_ad, purchase_invoice_date_bs, capitalization_date_ad, placed_in_service_date_ad, acquisition_cost, depreciation_method, depreciation_rate_percent, accumulated_depreciation, net_book_value, status, supplier_name, invoice_no, purchase_invoice_id, product_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         ON CONFLICT (id) DO UPDATE SET
           tag_number = EXCLUDED.tag_number,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           branch_id = EXCLUDED.branch_id,
          purchase_invoice_date_ad = EXCLUDED.purchase_invoice_date_ad,
          purchase_invoice_date_bs = EXCLUDED.purchase_invoice_date_bs,
          capitalization_date_ad = EXCLUDED.capitalization_date_ad,
          placed_in_service_date_ad = EXCLUDED.placed_in_service_date_ad,
           acquisition_cost = EXCLUDED.acquisition_cost,
           net_book_value = EXCLUDED.net_book_value,
           status = EXCLUDED.status;`,
        [
          newAsset.id,
          newAsset.tagNumber,
          newAsset.name,
          newAsset.category,
          newAsset.branchId,
          newAsset.acquisitionDateAD,
          newAsset.acquisitionDateBS,
          newAsset.purchaseInvoiceDateAD,
          newAsset.purchaseInvoiceDateBS,
          newAsset.capitalizationDateAD,
          newAsset.placedInServiceDateAD,
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
        'SELECT id, po_number AS "poNumber", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS", expected_delivery_date_ad AS "expectedDeliveryDateAD", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders' +
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

    const poBranchId = req.body.branchId || 'WH001';
    const poOrderDate = req.body.orderDateAD || req.body.orderDateAd || new Date().toISOString().split('T')[0];
    const poNumber = req.body.poNumber || (await issueNextDocNumber(poBranchId, 'PO', poOrderDate));

    const newPO = {
      id: req.body.id || `po-${Date.now()}`,
      poNumber,
      subtotalAmount,
      taxAmount,
      totalAmount,
      orderDateAd: poOrderDate,
      orderDateBs: req.body.orderDateBS || req.body.orderDateBs || '2083-04-10 BS',
      ...req.body,
    };

    const idx = purchaseOrders.findIndex((p) => p.id === newPO.id);
    if (idx >= 0) purchaseOrders[idx] = newPO;
    else purchaseOrders.unshift(newPO);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO purchase_orders (
           id, po_number, supplier_id, supplier_name, branch_id, order_date_ad, order_date_bs, expected_delivery_date_ad, status, subtotal_amount, tax_amount, total_amount, notes, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
          newPO.supplierId || null,
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

// Purchase Invoices
app.get('/api/purchase-invoices', async (req, res) => {
  const { branchId } = req.query;
  if (isPgConnected) {
    try {
      const q =
        'SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", supplier_id AS "supplierId", supplier_id AS "supplierId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS", due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", payment_method AS "paymentMethod", amount_paid AS "amountPaid", notes, items FROM purchase_invoices' +
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
    const invDate = req.body.invoiceDateAD || req.body.invoiceDateAd || new Date().toISOString().split('T')[0];
    const invoiceNumber = req.body.invoiceNumber || (await issueNextDocNumber(targetBranchId, 'PI', invDate));
    const newInv = {
      id: req.body.id || `inv-${Date.now()}`,
      invoiceNumber,
      invoiceDateAD: invDate,
      invoiceDateBS: req.body.invoiceDateBS || req.body.invoiceDateBs || '2083-04-10 BS',
      ...req.body,
    };
    const items = req.body.items || req.body.lines || [];
    // Guard: the vendor bill date (stored as dueDateAD) can never be after the purchase date
    if (newInv.dueDateAD && newInv.invoiceDateAD && newInv.dueDateAD > newInv.invoiceDateAD) {
      return res.status(400).json({ message: 'Vendor bill date cannot be after the purchase date.' });
    }
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

    let invoiceAlreadyExists = purchaseInvoices.some((invoice) => invoice.id === newInv.id || invoice.invoiceNumber === newInv.invoiceNumber);
    if (isPgConnected && !invoiceAlreadyExists) {
      const existing = await pgPool.query(
        'SELECT 1 FROM purchase_invoices WHERE id = $1 OR invoice_number = $2 LIMIT 1',
        [newInv.id, newInv.invoiceNumber]
      );
      invoiceAlreadyExists = existing.rowCount === 1;
    }
    const idx = purchaseInvoices.findIndex((i) => i.id === newInv.id);
    if (idx >= 0) purchaseInvoices[idx] = newInv;
    else purchaseInvoices.unshift(newInv);

    // Resolve supplierId from the selected supplier name for the sub-ledger FK
    const supplierId = req.body.supplierId || undefined;
    const supLookup = suppliers.find(
      (s) => s.id === supplierId || s.name.toLowerCase() === (newInv.supplierName || '').toLowerCase()
    );
    const resolvedSupplierId = supplierId || supLookup?.id || null;

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO purchase_invoices (
           id, invoice_number, po_reference_id, vendor_bill_number, supplier_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, due_date_ad, due_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total, payment_status, payment_method, amount_paid, notes, items
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (id) DO UPDATE SET
           payment_status = EXCLUDED.payment_status,
           payment_method = EXCLUDED.payment_method,
           amount_paid = EXCLUDED.amount_paid,
           notes = EXCLUDED.notes,
           items = EXCLUDED.items;`,
        [
          newInv.id,
          newInv.invoiceNumber,
          newInv.poReferenceId || newInv.poId || null,
          newInv.vendorBillNumber || null,
          resolvedSupplierId,
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
          newInv.paymentMethod || 'CREDIT',
          Number(newInv.amountPaid) || 0,
          newInv.notes || '',
          JSON.stringify(items),
        ]
      );

      if (!invoiceAlreadyExists) for (const item of items) {
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
          `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11, $12)`,
          [`txn-${Date.now()}-${item.productId}`, `TXN-${Math.floor(10000 + Math.random() * 90000)}`, item.productId, item.sku || '', item.productName || 'Product', targetBranchId, 'PURCHASE_INVOICE', qtyToAdd, Number(item.unitPrice) || 0, newInv.invoiceNumber, newInv.invoiceDateAD || new Date().toISOString(), newInv.invoiceDateBS || '2083-04-16 BS']
        );
      }

      const poRef = newInv.poReferenceId || req.body.poId;
      if (poRef) {
        await pgPool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2 OR po_number = $2', ['RECEIVED', poRef]);
      }
    }

    // Detect the PO used in this vendor bill and mark it RECEIVED (in-memory mirror for non-DB mode; DB mode is updated above)
    const billPoRef = newInv.poReferenceId || req.body.poId;
    const billLinkedPO = purchaseOrders.find((p) => p.id === billPoRef || p.poNumber === billPoRef);
    if (billLinkedPO) billLinkedPO.status = 'RECEIVED';

    if (!invoiceAlreadyExists) items.forEach((item: any) => {
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
      const result = await pgPool.query('SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", vendor_bill_number AS "vendorBillNumber", branch_id AS "branchId", notes, items FROM purchase_invoices WHERE id = $1', [id]);
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

// POST /api/purchase-invoices/:id/reverse-payments — reverse all payments for a fully paid invoice
app.post('/api/purchase-invoices/:id/reverse-payments', async (req, res) => {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ message: 'A reversal reason is required.' });
    }

    const inv = purchaseInvoices.find((i) => i.id === id);
    if (!inv) {
      return res.status(404).json({ message: 'Purchase invoice not found.' });
    }
    // A reversal is only meaningful once the bill is fully settled. Compute
    // from amounts (rather than trusting paymentStatus) so invoices with a
    // stale PARTIAL flag but a full amountPaid are still recognized.
    const grandTotal = Number(inv.grandTotal) || 0;
    const amountPaid = Number(inv.amountPaid) || 0;
    if (grandTotal <= 0 || amountPaid < grandTotal) {
      return res.status(409).json({ message: `Invoice #${inv.invoiceNumber} is not fully paid (status: ${inv.paymentStatus}, amount paid: ${amountPaid.toLocaleString()}).` });
    }

    // Find all POSTED payments for this invoice
    const paymentsToReverse = vendorPayments.filter((p) => p.invoiceId === id && p.status === 'POSTED');
    if (paymentsToReverse.length === 0) {
      return res.status(409).json({ message: `No posted payments found for invoice #${inv.invoiceNumber}.` });
    }
    // Capture the settled total BEFORE resetting it so the audit trail and
    // response can report the actual reversed amount.
    const reversedTotal = paymentsToReverse.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    if (isPgConnected) {
      await withTransaction(async (client) => {
        // Reverse all payments for this invoice
        for (const payment of paymentsToReverse) {
          await client.query(
            `UPDATE vendor_payments SET
               status = 'REVERSED',
               reversal_reason = $1,
               reversed_by = $2,
               reversed_at_ad = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [reason, getUserFromReq(req).email || 'system', payment.id]
          );
        }
        // Reset the invoice amount_paid and payment_status
        await client.query(
          `UPDATE purchase_invoices SET
             amount_paid = 0,
             payment_status = 'UNPAID'
           WHERE id = $1`,
          [id]
        );
      });
    }

    // Update in-memory state
    for (const payment of paymentsToReverse) {
      payment.status = 'REVERSED';
      payment.reversalReason = reason;
      payment.reversedBy = getUserFromReq(req).email || 'system';
      payment.reversedAtAD = new Date().toISOString();
    }
    inv.amountPaid = 0;
    inv.paymentStatus = 'UNPAID';

    logAuditEvent(
      req,
      'REVERSE_INVOICE_PAYMENTS',
      'PROCUREMENT',
      `Reversed ${paymentsToReverse.length} payment(s) totaling NPR ${reversedTotal.toLocaleString()} for Invoice #${inv.invoiceNumber} (${reason})`,
      inv.branchId
    );
    broadcastChange({ type: 'INVOICE_PAYMENTS_REVERSED', entity: 'purchase-invoices', branchId: inv.branchId });
    res.json({
      success: true,
      message: `Reversed ${paymentsToReverse.length} payment(s) totaling NPR ${reversedTotal.toLocaleString()} for Invoice #${inv.invoiceNumber}.`,
      reversedCount: paymentsToReverse.length,
      reversedTotal,
      invoiceId: inv.id,
    });
  } catch (err: any) {
    console.error('Error reversing invoice payments:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// ==========================================
// VENDOR PAYMENTS SUB-LEDGER
// ==========================================

const VENDOR_PAYMENT_SELECT = `
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
app.get('/api/vendor-payments', async (req, res) => {
  const { supplierId, invoiceId, branchId, status, fromAd, toAd, fiscalYearId } = req.query;
  if (isPgConnected) {
    try {
      const conds: string[] = [];
      const params: any[] = [];
      const push = (sql: string, value: any) => {
        if (value !== undefined && value !== null && value !== '') {
          params.push(value);
          conds.push(`${sql} = $${params.length}`);
        }
      };
      push('supplier_id', supplierId);
      push('invoice_id', invoiceId);
      push('branch_id', branchId && branchId !== 'ALL' ? branchId : undefined);
      push('status', status);
      push('fiscal_year_id', fiscalYearId);
      if (fromAd) {
        params.push(String(fromAd).split('T')[0]);
        conds.push(`payment_date_ad >= $${params.length}`);
      }
      if (toAd) {
        params.push(String(toAd).split('T')[0]);
        conds.push(`payment_date_ad <= $${params.length}`);
      }
      const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
      const r = await pgPool.query(`${VENDOR_PAYMENT_SELECT}${where} ORDER BY payment_date_ad DESC, created_at DESC`, params);
      return res.json(r.rows);
    } catch (err: any) {
      console.error('Error fetching vendor payments from DB:', err);
    }
  }
  let list = vendorPayments;
  if (supplierId) list = list.filter((p) => p.supplierId === String(supplierId));
  if (invoiceId) list = list.filter((p) => p.invoiceId === String(invoiceId));
  if (branchId && branchId !== 'ALL') list = list.filter((p) => p.branchId === String(branchId));
  if (status) list = list.filter((p) => p.status === String(status));
  if (fiscalYearId) list = list.filter((p) => p.fiscalYearId === String(fiscalYearId));
  if (fromAd) {
    const from = String(fromAd).split('T')[0];
    list = list.filter((p) => String(p.paymentDateAD || '').split('T')[0] >= from);
  }
  if (toAd) {
    const to = String(toAd).split('T')[0];
    list = list.filter((p) => String(p.paymentDateAD || '').split('T')[0] <= to);
  }
  res.json(list);
});

// GET /api/purchase-invoices/:id/payments — payment history for one invoice
app.get('/api/purchase-invoices/:id/payments', async (req, res) => {
  const { id } = req.params;
  if (isPgConnected) {
    try {
      const r = await pgPool.query(
        `${VENDOR_PAYMENT_SELECT} WHERE invoice_id = $1 ORDER BY payment_date_ad DESC, created_at DESC`,
        [id]
      );
      return res.json(r.rows);
    } catch (err: any) {
      console.error('Error fetching invoice payments from DB:', err);
    }
  }
  res.json(vendorPayments.filter((p) => p.invoiceId === id));
});

// POST /api/vendor-payments — create a payment (sub-ledger entry)
app.post('/api/vendor-payments', async (req, res) => {
  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Payment amount must be greater than 0.' });
    }

    // Resolve the invoice first so supplier + branch can be inherited from it.
    let linkedInvoice: any = body.invoiceId
      ? purchaseInvoices.find((inv) => inv.id === body.invoiceId || inv.invoiceNumber === body.invoiceId)
      : undefined;
    if (!linkedInvoice && body.invoiceId && isPgConnected) {
      const invRes = await pgPool.query(
        `SELECT id, invoice_number AS "invoiceNumber", supplier_name AS "supplierName",
                branch_id AS "branchId",
                invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS",
                grand_total AS "grandTotal", amount_paid AS "amountPaid"
         FROM purchase_invoices WHERE id = $1 OR invoice_number = $1 LIMIT 1`,
        [body.invoiceId]
      );
      linkedInvoice = invRes.rows[0];
    }

    // Resolve supplier: explicit supplierId, else supplierName, else from invoice.
    let supplierId: string | undefined = body.supplierId || undefined;
    let supplierName = body.supplierName || linkedInvoice?.supplierName || '';
    if (!supplierId && supplierName) {
      const matched = suppliers.find((s) =>
        s.name.toLowerCase() === String(supplierName).toLowerCase()
      ) || suppliers.find((s) =>
        String(supplierName).toLowerCase().includes(s.name.toLowerCase())
      );
      if (matched) supplierId = matched.id;
    }
    if (!supplierId && body.supplierName) {
      supplierId = providerSupplierIdFromName(String(body.supplierName));
    }
    if (!supplierId && supplierName) {
      supplierId = providerSupplierIdFromName(supplierName);
    }
    if (!supplierName && supplierId) {
      const sup = suppliers.find((s) => s.id === supplierId);
      supplierName = sup?.name || '';
    }
    if (!supplierName) {
      return res.status(400).json({ message: 'Supplier is required to record a vendor payment.' });
    }

    const branchId = body.branchId || linkedInvoice?.branchId || getUserFromReq(req).branchId || branches[0]?.id || 'WH001';
    const paymentDateAD = String(body.paymentDateAD || new Date().toISOString().split('T')[0]).split('T')[0];
    let paymentDateBS = body.paymentDateBS || linkedInvoice?.invoiceDateBS || '';
    try {
      const bsDay = await findBsDayRecordForAdDate(paymentDateAD);
      if (bsDay.found && bsDay.record?.bsDate) paymentDateBS = bsDay.record.bsDate;
    } catch (_e) {}
    if (!paymentDateBS) paymentDateBS = '2083-04-16 BS';

    const paymentMethod = (body.paymentMethod || 'CASH').toUpperCase();
    // Generate payment number from the daily per-branch sequence based on the
    // payment method: CP = Cash Payment, BP = Bank Payment
    // (transfer/cheque/card/online). Format: CP-BRC01-202609150001
    const payDocType = paymentMethod === 'CASH' ? 'CP' : 'BP';
    const paymentNumber = body.paymentNumber || (await issueNextDocNumber(branchId, payDocType, paymentDateAD));
    const id = `vp-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    const newPayment: VendorPayment = {
      id,
      paymentNumber,
      supplierId: supplierId || '',
      supplierName,
      branchId,
      invoiceId: linkedInvoice?.id || body.invoiceId || null,
      invoiceNumber: linkedInvoice?.invoiceNumber || body.invoiceNumber || null,
      paymentDateAD,
      paymentDateBS,
      amount,
      paymentMethod: paymentMethod as VendorPaymentMethod,
      bankName: body.bankName || null,
      bankBranch: body.bankBranch || null,
      accountNumber: body.accountNumber || null,
      chequeNumber: body.chequeNumber || null,
      chequeDateAD: body.chequeDateAD || null,
      chequeDateBS: body.chequeDateBS || null,
      transactionReference: body.transactionReference || null,
      notes: body.notes || null,
      status: 'POSTED',
      reversalReason: null,
      reversedBy: null,
      reversedAtAD: null,
      originalPaymentId: null,
      isDemo: false,
      createdBy: getUserFromReq(req).email || 'system',
    };

    vendorPayments.unshift(newPayment);

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO vendor_payments (
           id, payment_number, supplier_id, supplier_name, branch_id, invoice_id, invoice_number,
           payment_date_ad, payment_date_bs, amount, payment_method, bank_name, bank_branch,
           account_number, cheque_number, cheque_date_ad, cheque_date_bs, transaction_reference,
           notes, status, is_demo, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, FALSE, $21)
         ON CONFLICT (id) DO NOTHING`,
        [
          newPayment.id, newPayment.paymentNumber, newPayment.supplierId || null, newPayment.supplierName,
          newPayment.branchId, newPayment.invoiceId, newPayment.invoiceNumber,
          newPayment.paymentDateAD, newPayment.paymentDateBS, newPayment.amount, newPayment.paymentMethod,
          newPayment.bankName, newPayment.bankBranch, newPayment.accountNumber, newPayment.chequeNumber,
          newPayment.chequeDateAD, newPayment.chequeDateBS, newPayment.transactionReference,
          newPayment.notes, newPayment.status, newPayment.createdBy,
        ]
      );
    }
    logAuditEvent(
      req,
      'RECORD_VENDOR_PAYMENT',
      'PROCUREMENT',
      `Recorded vendor payment #${paymentNumber} of NPR ${amount.toLocaleString()} to ${supplierName} via ${paymentMethod}`,
      branchId
    );
    broadcastChange({ type: 'VENDOR_PAYMENT', entity: 'purchase-invoices', branchId });
    res.status(201).json(newPayment);
  } catch (err: any) {
    console.error('Error creating vendor payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// POST /api/vendor-payments/:id/reverse — reverse a posted payment
app.post('/api/vendor-payments/:id/reverse', async (req, res) => {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ message: 'A reversal reason is required.' });
    }
    const payment = vendorPayments.find((p) => p.id === id);
    if (!payment) {
      return res.status(404).json({ message: 'Vendor payment not found.' });
    }
    if (payment.status !== 'POSTED') {
      return res.status(409).json({ message: `Payment #${payment.paymentNumber} is already ${payment.status.toLowerCase()}.` });
    }

    if (isPgConnected) {
      await withTransaction(async (client) => {
        // Reverse the payment row.
        await client.query(
          `UPDATE vendor_payments SET
             status = 'REVERSED',
             reversal_reason = $1,
             reversed_by = $2,
             reversed_at_ad = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [reason, getUserFromReq(req).email || 'system', id]
        );
        // Undo the amount from the linked invoice so its balance is restored.
        if (payment.invoiceId) {
          await client.query(
            `UPDATE purchase_invoices SET
               amount_paid = GREATEST(0, amount_paid - $1),
               payment_status = CASE WHEN (amount_paid - $1) >= grand_total THEN 'PAID'
                                     WHEN (amount_paid - $1) > 0 THEN 'PARTIAL'
                                     ELSE 'UNPAID' END
             WHERE id = $2`,
            [Number(payment.amount) || 0, payment.invoiceId]
          );
        }
      });
    }

    payment.status = 'REVERSED';
    payment.reversalReason = reason;
    payment.reversedBy = getUserFromReq(req).email || 'system';
    payment.reversedAtAD = new Date().toISOString();

    // Mirror the invoice decrement in memory (only when not pg-connected).
    if (!isPgConnected && payment.invoiceId) {
      const inv = purchaseInvoices.find((i) => i.id === payment.invoiceId);
      if (inv) {
        inv.amountPaid = Math.max(0, Number(inv.amountPaid || 0) - Number(payment.amount || 0));
        inv.paymentStatus = inv.amountPaid >= (Number(inv.grandTotal) || 0) ? 'PAID' : inv.amountPaid > 0 ? 'PARTIAL' : 'UNPAID';
      }
    }

    logAuditEvent(
      req,
      'REVERSE_VENDOR_PAYMENT',
      'PROCUREMENT',
      `Reversed vendor payment #${payment.paymentNumber} of NPR ${Number(payment.amount || 0).toLocaleString()} (${reason})`,
      payment.branchId
    );
    broadcastChange({ type: 'VENDOR_PAYMENT_REVERSED', entity: 'purchase-invoices', branchId: payment.branchId });
    res.json({
      success: true,
      message: `Payment #${payment.paymentNumber} reversed.`,
      paymentId: payment.id,
    });
  } catch (err: any) {
    console.error('Error reversing vendor payment:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Vendor ledger report: debits (invoices) + credits (payments) with running balance.
// GET /api/vendors/:supplierId/ledger?fromAd=&toAd=&fiscalYearId=&branchId=
app.get('/api/vendors/:supplierId/ledger', async (req, res) => {
  try {
    const { supplierId } = req.params;
    const { fromAd, toAd, fiscalYearId, branchId } = req.query;
    const supplier = suppliers.find((s) => s.id === supplierId);
    if (!supplier) {
      return res.status(404).json({ message: 'Supplier not found.' });
    }

    const nameMatcher = (name: string) =>
      String(name || '').toLowerCase() === supplier.name.toLowerCase() ||
      String(name || '').toLowerCase().includes(supplier.name.toLowerCase()) ||
      supplier.name.toLowerCase().includes(String(name || '').toLowerCase());

    // Match invoices/payments by the exact supplier_id FK first (the reliable
    // route since duplicate supplier names can exist; e.g. demo vs real rows),
    // and fall back to name matching only for legacy rows without a supplier_id.
    const bySupplierId = (inv: any) =>
      inv.supplierId && inv.supplierId === supplier.id;
    const byLegacyName = (inv: any) => !inv.supplierId && nameMatcher(inv.supplierName);

    let invoices: any[] = purchaseInvoices.filter((inv) => bySupplierId(inv) || byLegacyName(inv));
    let payments: VendorPayment[] = vendorPayments.filter((p) =>
      (p.supplierId && p.supplierId === supplier.id) || byLegacyName(p)
    );

    if (isPgConnected) {
      try {
        const invRes = await pgPool.query(
          `SELECT id, invoice_number AS "invoiceNumber", supplier_id AS "supplierId", supplier_name AS "supplierName",
                  branch_id AS "branchId", invoice_date_ad AS "invoiceDateAD",
                  invoice_date_bs AS "invoiceDateBS", vat_amount AS "vatAmount",
                  grand_total AS "grandTotal", notes
           FROM purchase_invoices
           WHERE supplier_id = $1 OR (supplier_id IS NULL AND (LOWER(supplier_name) = LOWER($2) OR LOWER(supplier_name) LIKE LOWER($3)))`,
          [supplier.id, supplier.name, `%${supplier.name}%`]
        );
        invoices = invRes.rows;
        const payRes = await pgPool.query(
          `${VENDOR_PAYMENT_SELECT} WHERE supplier_id = $1 OR (supplier_id IS NULL OR supplier_id = '') AND (LOWER(supplier_name) = LOWER($2) OR LOWER(supplier_name) LIKE LOWER($3))`,
          [supplier.id, supplier.name, `%${supplier.name}%`]
        );
        payments = payRes.rows;
      } catch (err: any) {
        console.error('Vendor ledger DB query failed, using cache:', err?.message || err);
      }
    }

    // Apply branch + fiscal-year/date scoping.
    const from = String(fromAd || '').split('T')[0];
    const to = String(toAd || '').split('T')[0];
    const scopedDate = (date: any) => {
      const d = String(date || '').split('T')[0];
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    };
    const inScope = (branch: string | undefined, date: any) =>
      (!branchId || branchId === 'ALL' || branch === branchId) && scopedDate(date);

    const invoiceLines = invoices
      .filter((inv) => inScope(inv.branchId, inv.invoiceDateAD))
      .map((inv) => ({
        id: `inv-${inv.id}`,
        documentNumber: inv.invoiceNumber,
        dateAD: String(inv.invoiceDateAD || '').split('T')[0],
        dateBS: inv.invoiceDateBS || '',
        amount: Number(inv.grandTotal) || 0,
        vatAmount: Number(inv.vatAmount) || 0,
        type: 'INVOICE' as const,
        notes: inv.notes || `Purchase invoice ${inv.invoiceNumber}`,
        paymentMethod: undefined,
        debit: Number(inv.grandTotal) || 0,
        credit: 0,
      }));

    const paymentLines = payments
      .filter((p) => p.status === 'POSTED' && inScope(p.branchId, p.paymentDateAD))
      .map((p) => ({
        id: `pay-${p.id}`,
        documentNumber: p.paymentNumber,
        dateAD: String(p.paymentDateAD || '').split('T')[0],
        dateBS: p.paymentDateBS || '',
        amount: Number(p.amount) || 0,
        vatAmount: undefined,
        type: 'PAYMENT' as const,
        notes: p.notes || `Payment via ${p.paymentMethod}${p.chequeNumber ? ` (Chq ${p.chequeNumber})` : ''}`,
        paymentMethod: p.paymentMethod,
        debit: 0,
        credit: Number(p.amount) || 0,
      }));

    const allLines = [...invoiceLines, ...paymentLines].sort((a, b) =>
      a.dateAD === b.dateAD ? a.documentNumber.localeCompare(b.documentNumber) : a.dateAD.localeCompare(b.dateAD)
    );

    // Resolve the fiscal-year opening balance from the vendor_opening_balances
    // register. Priority: explicit fiscalYearId → a from-date that equals a known
    // fiscal year start → the current fiscal year. When a persisted opening
    // exists, it is the carry-forward of the previous year's closing balance.
    let fyStartAD = '';
    let persistedOpening = 0;
    let usedPersistedOpening = false;
    if (isPgConnected) {
      try {
        let fyRow: any = null;
        if (fiscalYearId) {
          const fyRes = await pgPool.query(
            'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE id = $1',
            [fiscalYearId]
          );
          fyRow = fyRes.rows[0] || null;
        } else if (from) {
          const fyRes = await pgPool.query(
            'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE start_date_ad = $1::date LIMIT 1',
            [from]
          );
          fyRow = fyRes.rows[0] || null;
        } else {
          const fyRes = await pgPool.query(
            'SELECT id, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE is_current = TRUE ORDER BY start_date_ad DESC LIMIT 1'
          );
          fyRow = fyRes.rows[0] || null;
        }
        if (fyRow) {
          fyStartAD = String(fyRow.startDateAD || '').split('T')[0];
          const obRes = await pgPool.query(
            `SELECT COALESCE(SUM(opening_balance), 0)::float AS total
             FROM vendor_opening_balances
             WHERE fiscal_year_id = $1 AND supplier_id = $2
               AND ($3::text IS NULL OR $3 = 'ALL' OR branch_id = $3)`,
            [fyRow.id, supplier.id, branchId === 'ALL' ? null : branchId]
          );
          persistedOpening = Number(obRes.rows[0]?.total) || 0;
          usedPersistedOpening = true;
        }
      } catch (err: any) {
        console.warn('Vendor ledger fiscal-year opening lookup failed, falling back to period-net:', err?.message || err);
      }
    }

    // Opening balance:
    //  - With a persisted fiscal-year opening: that carry-forward value, plus any
    //    net activity between the fiscal-year start and an explicit earlier
    //    cut-off (`from`). The ledger period then begins at `from`.
    //  - Without a persisted opening (legacy / no fiscal year configured): net
    //    (debits - credits) strictly before the `from` date.
    let openingBalance: number;
    let periodLines: typeof allLines;
    if (usedPersistedOpening && fyStartAD) {
      const periodStart = from && from > fyStartAD ? from : fyStartAD;
      openingBalance =
        persistedOpening +
        allLines
          .filter((line) => line.dateAD >= fyStartAD && line.dateAD < periodStart)
          .reduce((sum, line) => sum + line.debit - line.credit, 0);
      periodLines = allLines.filter((line) => line.dateAD >= periodStart);
    } else {
      openingBalance = allLines
        .filter((line) => from && line.dateAD < from)
        .reduce((sum, line) => sum + line.debit - line.credit, 0);
      periodLines = allLines.filter((line) => !from || line.dateAD >= from);
    }

    let running = openingBalance;
    const ledger = periodLines.map((line) => {
      running += line.debit - line.credit;
      return { ...line, balance: running };
    });

    const periodDebit = ledger.reduce((sum, line) => sum + line.debit, 0);
    const periodCredit = ledger.reduce((sum, line) => sum + line.credit, 0);

    res.json({
      supplier: { id: supplier.id, name: supplier.name },
      openingBalance,
      openingSource: usedPersistedOpening && fyStartAD ? 'FISCAL_YEAR_OPENING' : 'PERIOD_NET',
      fiscalYearStartAD: fyStartAD || null,
      totalDebit: periodDebit,
      totalCredit: periodCredit,
      closingBalance: openingBalance + periodDebit - periodCredit,
      ledger,
    });
  } catch (err: any) {
    console.error('Error building vendor ledger:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Resolves an existing supplier master row by vendor name, creating one on the
// fly for invoice-driven payments when no supplierId was supplied.
function providerSupplierIdFromName(name: string): string | undefined {
  const clean = String(name || '').trim();
  if (!clean) return undefined;
  const matched = suppliers.find((s) => s.name.toLowerCase() === clean.toLowerCase()) ||
    suppliers.find((s) => s.name.toLowerCase().includes(clean.toLowerCase()));
  if (matched) return matched.id;
  return undefined;
}

// Shipments
app.get('/api/shipments', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query(
        'SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS", estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAD", received_date_bs AS "receivedDateBS", has_discrepancy AS "hasDiscrepancy" FROM shipments ORDER BY created_at DESC'
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

    // BS calendar gate: a shipment dispatch may only be posted when its date
    // has a seeded BS day record in bs_day_records (Nepali date is mandatory).
    const rawDispatchDateAD = req.body.dispatchDateAD || req.body.dispatchDateAd;
    const dispatchDateMismatch = detectDateTypeMismatch(rawDispatchDateAD, 'dispatchDateAD');
    if (dispatchDateMismatch) {
      return res.status(400).json({ message: dispatchDateMismatch, dateTypeMismatch: true });
    }
    const dispatchDateAD = String(rawDispatchDateAD || new Date().toISOString().split('T')[0]).split('T')[0];
    const bsDayForShipment = await findBsDayRecordForAdDate(dispatchDateAD);
    if (!bsDayForShipment.found) {
      return res.status(400).json({
        message: `BS date is not available for ${dispatchDateAD}. Please contact your system administrator for BS month seeding.`,
        bsDateMissing: true,
      });
    }

    const sourceBranchId = req.body.sourceBranchId || branches[0]?.id || 'WH001';
    const trackingCode = req.body.trackingCode || (await issueNextDocNumber(sourceBranchId, 'ST', dispatchDateAD));

    const newShipment = {
      ...req.body,
      id: req.body.id || `sh-${Date.now()}`,
      trackingCode,
      sourceBranchName: sourceBranch?.name || req.body.sourceBranchName || 'Source',
      destinationBranchName: destBranch?.name || req.body.destinationBranchName || 'Destination',
      // Date integrity: the AD dispatch date stays in the AD column, and the BS
      // date is ALWAYS derived from the seeded bs_day_records DB record. A
      // client-supplied dispatchDateBS can never override it.
      dispatchDateAD,
      dispatchDateBS: `${bsDayForShipment.record.bsDate} BS`,
      status: req.body.status || 'IN_TRANSIT',
      items: req.body.items || [],
    };

    let shipmentAlreadyExists = shipments.some((s) => s.id === newShipment.id || s.trackingCode === newShipment.trackingCode);
    if (isPgConnected && !shipmentAlreadyExists) {
      const existing = await pgPool.query(
        'SELECT 1 FROM shipments WHERE id = $1 OR tracking_code = $2 LIMIT 1',
        [newShipment.id, newShipment.trackingCode]
      );
      shipmentAlreadyExists = existing.rowCount === 1;
    }

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

        if (!shipmentAlreadyExists && newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
          for (const item of newShipment.items) {
            const qtySent = Number(item.quantitySent || item.quantity || 1);
            const updated = await client.query(
              `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
               WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
              [qtySent, item.productId, newShipment.sourceBranchId]
            );
            if (updated.rowCount !== 1) throw new Error(`Insufficient stock for ${item.productName || item.productId}.`);

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

    if (!shipmentAlreadyExists && newShipment.type === 'INTER_BRANCH' && newShipment.sourceBranchId) {
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
    if (['RECEIVED', 'DELIVERED', 'CANCELLED'].includes(sh.status)) {
      return res.status(409).json({ message: `Shipment ${sh.trackingCode} is already ${sh.status.toLowerCase()} and cannot be received again.` });
    }

    let hasDiscrepancy = false;
    sh.receivedByNotes = receivedByNotes || '';
    sh.receivedDateAD = new Date().toISOString().split('T')[0];
    // Date integrity: the BS receipt date is ALWAYS derived from the seeded
    // bs_day_records row for the AD receipt date — a hardcoded or client-
    // supplied BS value is never stored in received_date_bs.
    const bsDayForReceipt = await findBsDayRecordForAdDate(sh.receivedDateAD);
    const receivedDateBS: string | null = bsDayForReceipt.found
      ? `${bsDayForReceipt.record.bsDate} BS`
      : null;
    sh.receivedDateBS = receivedDateBS || undefined;

    sh.items.forEach((item: any, idx: number) => {
      const verified = Array.isArray(receivedItems)
        ? receivedItems.find((ri: any) => ri.itemId === item.id) || receivedItems[idx]
        : null;
      const actualQtyReceived = verified !== null && verified !== undefined && verified.quantityReceived !== undefined
        ? Number(verified.quantityReceived)
        : (item.quantitySent || item.quantity || 1);
      if (!Number.isInteger(actualQtyReceived) || actualQtyReceived < 0) {
        throw new Error(`Received quantity for ${item.productName || item.productId} must be a non-negative integer.`);
      }

      item.quantityReceived = actualQtyReceived;
      if (actualQtyReceived < (item.quantitySent || item.quantity || 1)) hasDiscrepancy = true;
    });

    sh.hasDiscrepancy = hasDiscrepancy;
    sh.status = hasDiscrepancy ? 'DISCREPANCY' : 'RECEIVED';

    if (isPgConnected) {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE shipments SET status = $1, received_by_notes = $2, received_date_ad = CURRENT_DATE, received_date_bs = $3, has_discrepancy = $4, items = $5 WHERE id = $6`,
          [sh.status, sh.receivedByNotes, receivedDateBS, hasDiscrepancy, JSON.stringify(sh.items), id]
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

    const cancellationNotes = (sh.notes ? sh.notes + ' | ' : '') + `Transfer cancelled by ${user?.name || 'Admin'}${reason ? ': ' + reason : ''}`;

    if (isPgConnected) {
      await withTransaction(async (client) => {
        const current = await client.query('SELECT status, source_branch_id AS "sourceBranchId", destination_branch_id AS "destinationBranchId", items, notes FROM shipments WHERE id = $1 OR tracking_code = $1 FOR UPDATE', [id]);
        if (!current.rows[0]) throw new Error('Shipment / transfer not found.');
        if (['RECEIVED', 'DELIVERED'].includes(current.rows[0].status)) throw new Error('Transfers that have already been received cannot be cancelled.');
        if (current.rows[0].status === 'CANCELLED') throw new Error('This transfer is already cancelled.');
        const sourceBranchId = current.rows[0].sourceBranchId || sh.sourceBranchId;
        const destinationBranchId = current.rows[0].destinationBranchId || sh.destinationBranchId;
        const items = typeof current.rows[0].items === 'string' ? JSON.parse(current.rows[0].items) : (current.rows[0].items || sh.items);
        await client.query('UPDATE shipments SET status = $1, notes = $2 WHERE id = $3 OR tracking_code = $3', ['CANCELLED', cancellationNotes, id]);
        for (const item of items) {
          const qtySent = Number(item.quantitySent || item.quantity) || 1;
          if (qtySent > 0 && sourceBranchId) {
            await client.query(
              `UPDATE inventory_stock SET quantity_on_hand = inventory_stock.quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
              [qtySent, item.productId, sourceBranchId]
            );
          }
          if (qtySent > 0 && destinationBranchId) {
            await client.query(
              `UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;`,
              [qtySent, item.productId, destinationBranchId]
            );
          }
        }
      });
    }
    sh.status = 'CANCELLED';
    sh.notes = cancellationNotes;
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
        'SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAD", date_bs AS "dateBS", fiscal_year AS "fiscalYear", status, items FROM stock_operations' +
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

    // BS calendar gate: a stock operation may only be posted when its date has
    // a seeded BS day record in bs_day_records (Nepali date is mandatory).
    const rawOpDateAD = req.body.dateAD || req.body.dateAd;
    const opDateMismatch = detectDateTypeMismatch(rawOpDateAD, 'dateAD');
    if (opDateMismatch) {
      return res.status(400).json({ message: opDateMismatch, dateTypeMismatch: true });
    }
    const opDateAD = String(rawOpDateAD || new Date().toISOString().split('T')[0]).split('T')[0];
    const bsDayForOp = await findBsDayRecordForAdDate(opDateAD);
    if (!bsDayForOp.found) {
      return res.status(400).json({
        message: `BS date is not available for ${opDateAD}. Please contact your system administrator for BS month seeding.`,
        bsDateMissing: true,
      });
    }

    const opBranchId = req.body.branchId || 'WH001';
    // Map operation type to document type code for numbering:
    // DAMAGE → DMG, PULLOUT → PLT, STOCK_OUT → SALE, CONSUMABLE_ISSUE → CON,
    // MANUAL_ADJUSTMENT → SA, others → their first 4 letters.
    const opTypeDocMap: Record<string, string> = {
      DAMAGE: 'DMG',
      PULLOUT: 'PLT',
      STOCK_OUT: 'SALE',
      CONSUMABLE_ISSUE: 'CON',
      MANUAL_ADJUSTMENT: 'SA',
    };
    const docType = opTypeDocMap[opType] || opType.slice(0, 4).toUpperCase();
    const newOp = {
      ...req.body,
      id: req.body.id || `op-${Date.now()}`,
      referenceNumber: req.body.referenceNumber || (await issueNextDocNumber(opBranchId, docType, opDateAD)),
      // Date integrity: the AD date stays in the AD column, and the BS date is
      // ALWAYS derived from the seeded bs_day_records DB record for that AD
      // date. A client-supplied dateBS can never override it (prevents
      // BS-in-AD / AD-in-BS mismatches from reaching the database).
      dateAD: opDateAD,
      dateBS: `${bsDayForOp.record.bsDate} BS`,
      totalValue,
      fiscalYear: req.body.fiscalYear || getFiscalYearCodeForDate(opDateAD),
      branchName: branchObj?.name || req.body.branchName || 'Branch',
      destinationWarehouseId: destWarehouseObj?.id || req.body.destinationWarehouseId || 'WH001',
      destinationWarehouseName: destWarehouseObj?.name || req.body.destinationWarehouseName || 'Headquarters Warehouse',
      status: req.body.status || (opType === 'PULLOUT' ? 'DISPATCHED' : 'LOGGED'),
    };

    // Keep the movement ledger authoritative for stock operations as well as
    // purchase invoices and transfers. Pullouts from damaged stock do not
    // change available quantity_on_hand, so they are intentionally excluded
    // from this quantity ledger.
    const operationTransactions: TransactionLog[] = operationItems
      .filter((item: any) => !(opType === 'PULLOUT' && item.condition === 'DAMAGED_STOCK'))
      .map((item: any, index: number) => {
        const stockRecord = inventoryStock.find(
          (entry) => entry.productId === item.productId && entry.branchId === newOp.branchId
        );
        const product = products.find((entry) => entry.id === item.productId);
        const quantity = Number(item.quantity) || 1;
        const quantityBefore = Number(stockRecord?.quantityOnHand) || 0;
        // DAMAGE ops move units from usable to damaged, still consuming
        // quantity_on_hand; DISPOSAL / PULLOUT / STOCK_OUT consume stock too.
        const quantityChanged = -(opType === 'DAMAGE' ? quantity : Math.abs(quantity));
        return {
          id: `txn-${newOp.id}-${item.productId}-${index}`,
          transactionNumber: `${newOp.referenceNumber}-${index + 1}`,
          productId: item.productId,
          productSku: product?.sku || item.sku || '',
          productName: product?.name || item.productName || 'Product',
          branchId: newOp.branchId,
          changeType: (opType === 'DAMAGE' ? 'DAMAGE' : opType) as TransactionLog['changeType'],
          quantityBefore,
          quantityChanged,
          quantityAfter: Math.max(0, quantityBefore - quantity),
          unitCost: Number(item.unitCost ?? item.costPerUnit ?? newOp.costPerUnit) || product?.costPrice || 0,
          referenceDocId: newOp.referenceNumber,
          timestampAD: new Date(`${newOp.dateAD}T00:00:00.000Z`).toISOString(),
          timestampBS: newOp.dateBS,
        };
      });

    if (isPgConnected) {
      await withTransaction(async (client) => {
        await client.query(
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
          let result;
          if (opType === 'DAMAGE') {
            result = await client.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, damaged_qty = damaged_qty + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
            [qty, item.productId, newOp.branchId]
            );
          } else if (opType === 'PULLOUT') {
            result = await client.query(
            item.condition === 'DAMAGED_STOCK'
              ? `UPDATE inventory_stock SET damaged_qty = damaged_qty - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND damaged_qty >= $1;`
              : `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
              [qty, item.productId, newOp.branchId]
            );
          } else if (opType === 'STOCK_OUT' || opType === 'CONSUMABLE_ISSUE') {
            result = await client.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`,
              [qty, item.productId, newOp.branchId]
            );
          }
          if (stockConsumingType && result && result.rowCount !== 1) {
            throw new Error(`Stock changed before this operation could be posted for ${item.productName || item.productId}. Please retry.`);
          }
        }

        for (const txn of operationTransactions) {
          await client.query(
            `INSERT INTO transaction_logs (id, transaction_number, product_id, product_sku, product_name, branch_id, change_type, quantity_before, quantity_changed, quantity_after, unit_cost, reference_doc_id, timestamp_ad, timestamp_bs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (id) DO NOTHING`,
            [txn.id, txn.transactionNumber, txn.productId, txn.productSku, txn.productName, txn.branchId, txn.changeType, txn.quantityBefore, txn.quantityChanged, txn.quantityAfter, txn.unitCost, txn.referenceDocId, txn.timestampAD, txn.timestampBS]
          );
        }

        // Persist a damage_records lifecycle entry for every DAMAGE stock
        // operation, so the damage register (table 7b) always faithfully
        // reflects what was actually written to inventory_stock.
        if (opType === 'DAMAGE') {
          for (const item of operationItems) {
            const qty = Number(item.quantity) || 0;
            if (qty <= 0) continue;
            const product = products.find((entry) => entry.id === item.productId);
            const unitCost = Number(item.unitCost ?? item.costPerUnit ?? newOp.costPerUnit) || product?.costPrice || 0;
            const topReason = String(newOp.reason || 'Physical branch inventory inspection & transit damage tag').toUpperCase();
            const knownReason = ['PHYSICAL_DAMAGE', 'TRANSIT_DAMAGE', 'STORAGE_DAMAGE', 'EXPIRED', 'RETURN_DAMAGE', 'QUALITY_DEFECT', 'OTHER'].find((r) => topReason.includes(r));
            const damageReason = (knownReason || 'OTHER') as string;
            await client.query(
              `INSERT INTO damage_records (
                 id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
                 damage_date_ad, damage_date_bs, damage_reason, status, salvage_value, gl_account_code,
                 write_off_loss, approved_by, notes, fiscal_year_id, is_demo, created_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'IDENTIFIED', 0, 'GL-5120 (Loss on Inventory Scrap & Write-off)', 0, $11, $12, $13, FALSE, $14)
               ON CONFLICT (id) DO NOTHING`,
              [
                `dmr-${newOp.id}-${item.productId}`,
                `${newOp.referenceNumber}-${item.productId}`,
                item.productId,
                newOp.branchId,
                qty,
                unitCost,
                qty * unitCost,
                newOp.dateAD,
                newOp.dateBS,
                damageReason,
                newOp.inspectorName || null,
                newOp.reason || '',
                newOp.fiscalYear ? getFiscalYearCodeForDate(newOp.dateAD) : null,
                newOp.inspectorName || null,
              ]
            );
          }
        }
      });
    }
    const idx = stockOperations.findIndex((o) => o.id === newOp.id);
    if (idx >= 0) stockOperations[idx] = newOp;
    else stockOperations.unshift(newOp);
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
          if (opType === 'DAMAGE') {
            stockRecord.damagedQty = (stockRecord.damagedQty || 0) + quantity;
            // Keep the in-memory damage register in lock-step with the DB so
            // the Damaged Stock screen and ledger reflect it immediately.
            const damageRef = `${newOp.referenceNumber}-${item.productId}`;
            const existingDamage = damageRecords.find(
              (dr) => dr.damageReference === damageRef || dr.id === `dmr-${newOp.id}-${item.productId}`
            );
            if (!existingDamage) {
              damageRecords.unshift({
                id: `dmr-${newOp.id}-${item.productId}`,
                damageReference: damageRef,
                productId: item.productId,
                branchId: newOp.branchId,
                quantityDamaged: quantity,
                unitCost: Number(item.unitCost ?? item.costPerUnit ?? newOp.costPerUnit) || 0,
                totalCost: quantity * (Number(item.unitCost ?? item.costPerUnit ?? newOp.costPerUnit) || 0),
                damageDateAD: newOp.dateAD,
                damageDateBS: newOp.dateBS,
                damageReason: 'OTHER',
                status: 'IDENTIFIED',
                salvageValue: 0,
                glAccountCode: 'GL-5120 (Loss on Inventory Scrap & Write-off)',
                writeOffLoss: 0,
                approvedBy: newOp.inspectorName,
                notes: newOp.reason,
                fiscalYearId: newOp.fiscalYear ? getFiscalYearCodeForDate(newOp.dateAD) : undefined,
                isDemo: false,
                createdBy: newOp.inspectorName,
              } as DamageRecord);
            }
          }
          stockRecord.lastUpdated = new Date().toISOString();
        }
      }
    }
    for (const txn of operationTransactions) {
      const existingTxn = transactionLogs.find((entry) => entry.id === txn.id);
      if (!existingTxn) transactionLogs.unshift(txn);
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
    if (op && op.status === 'RECEIVED') {
      return res.status(409).json({ message: 'This stock operation has already been received.' });
    }

    if (isPgConnected) {
      await withTransaction(async (client) => {
        const current = await client.query('SELECT status, destination_warehouse_id AS "destinationWarehouseId", items FROM stock_operations WHERE id = $1 FOR UPDATE', [id]);
        if (!current.rows[0]) throw new Error('Stock operation not found.');
        if (current.rows[0].status === 'RECEIVED') throw new Error('This stock operation has already been received.');
        await client.query('UPDATE stock_operations SET status = $1 WHERE id = $2', ['RECEIVED', id]);
        const whId = current.rows[0].destinationWarehouseId || op?.destinationWarehouseId || 'WH001';
        const items = typeof current.rows[0].items === 'string' ? JSON.parse(current.rows[0].items) : (current.rows[0].items || op?.items || []);
        for (const item of items) {
          const qty = Number(item.quantity) || 1;
          await client.query(
            `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (product_id, branch_id) DO UPDATE SET
               quantity_on_hand = inventory_stock.quantity_on_hand + $4,
               last_updated = CURRENT_TIMESTAMP;`,
            [`stk-${whId.toLowerCase()}-${item.productId}`, item.productId, whId, qty]
          );
        }
      });
    }
    if (op) op.status = 'RECEIVED';
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
                    is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo"
             FROM fiscal_years ORDER BY start_date_ad DESC;`
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

// Create a new fiscal year directly in Postgres. SUPER_ADMIN only. A new period
// is never auto-activated: it starts open (is_closed = FALSE) and is normally
// made the active view once it goes live.
app.post('/api/fiscal-years', requireRole('SUPER_ADMIN'), async (req, res) => {
  const { code, startDateAD, endDateAD, startDateBS, endDateBS } = req.body || {};

  if (![code, startDateAD, endDateAD, startDateBS, endDateBS].every((v) => typeof v === 'string' && v.trim())) {
    return res.status(400).json({ message: 'Fiscal year code and all BS/AD period dates are required.' });
  }
  if (Number.isNaN(Date.parse(startDateAD)) || Number.isNaN(Date.parse(endDateAD)) || startDateAD > endDateAD) {
    return res.status(400).json({ message: 'Enter a valid AD period with an end date on or after the start date.' });
  }

  const cleanCode = code.trim();
  try {
    // Prevent overlapping fiscal periods so every AD date belongs to exactly one
    // fiscal year (the assign_fiscal_year_id_from_date trigger relies on this).
    const overlapCheck = await pgPool.query(
      `SELECT code FROM fiscal_years
       WHERE ($1::date BETWEEN start_date_ad AND end_date_ad)
          OR ($2::date BETWEEN start_date_ad AND end_date_ad)
          OR (start_date_ad BETWEEN $1::date AND $2::date)
       LIMIT 1;`,
      [startDateAD, endDateAD]
    );
    if (overlapCheck.rows[0]) {
      return res.status(409).json({
        message: `The new period overlaps with FY ${overlapCheck.rows[0].code}. Adjust the dates so every day belongs to exactly one fiscal year.`,
      });
    }

    const id = `fy-${crypto.randomUUID()}`;
    const result = await pgPool.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE, FALSE)
       RETURNING id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                 start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                 is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo";`,
      [id, cleanCode, startDateAD, endDateAD, startDateBS.trim(), endDateBS.trim()]
    );
    const newFiscalYear = result.rows[0];
    fiscalYears.push(newFiscalYear);
    fiscalYears.sort((a, b) => String(b.startDateAD).localeCompare(String(a.startDateAD)));
    logAuditEvent(req, 'CREATE_FISCAL_YEAR', 'FISCAL_YEAR', `Created fiscal year ${newFiscalYear.code}`);
    return res.status(201).json(newFiscalYear);
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ message: 'That fiscal year code already exists.' });
    console.error('Error creating fiscal year:', error);
    return res.status(500).json({ message: `Unable to create fiscal year: ${error.message}` });
  }
});

app.post('/api/fiscal-years/:id/set-current', requireRole('SUPER_ADMIN'), async (req, res) => {
  const { id } = req.params;
  try {
    // One transaction: clear the old flag first, then set the new one, so the
    // uq_fiscal_years_single_current index can never be violated mid-flight.
    await withTransaction(async (client) => {
      await client.query('UPDATE fiscal_years SET is_current = FALSE;');
      const result = await client.query('UPDATE fiscal_years SET is_current = TRUE WHERE id = $1 RETURNING id;', [id]);
      if (!result.rowCount) {
        const error: any = new Error('Fiscal year not found.');
        error.statusCode = 404;
        throw error;
      }
    });
  } catch (e: any) {
    if (e?.statusCode) return res.status(e.statusCode).json({ message: e.message });
    console.warn('PostgreSQL set-current fiscal year notice:', e.message);
  }

  fiscalYears.forEach((fy) => {
    fy.isCurrent = fy.id === id;
  });
  res.json(fiscalYears);
});

app.put('/api/fiscal-years/:id', requireRole('SUPER_ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { code, startDateAD, endDateAD, startDateBS, endDateBS } = req.body || {};
  const values = [code, startDateAD, endDateAD, startDateBS, endDateBS];

  if (!values.every((value) => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ message: 'Fiscal year code and all BS/AD period dates are required.' });
  }
  if (Number.isNaN(Date.parse(startDateAD)) || Number.isNaN(Date.parse(endDateAD)) || startDateAD > endDateAD) {
    return res.status(400).json({ message: 'Enter a valid AD period with an end date on or after the start date.' });
  }

  try {
    const result = await pgPool.query(
      `UPDATE fiscal_years
       SET code = $1, start_date_ad = $2, end_date_ad = $3, start_date_bs = $4, end_date_bs = $5
       WHERE id = $6
       RETURNING id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                 start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                 is_current AS "isCurrent", is_closed AS "isClosed";`,
      [code.trim(), startDateAD, endDateAD, startDateBS.trim(), endDateBS.trim(), id]
    );
    const fiscalYear = result.rows[0];
    if (!fiscalYear) return res.status(404).json({ message: 'Fiscal year not found.' });

    const index = fiscalYears.findIndex((item) => item.id === id);
    if (index >= 0) fiscalYears[index] = fiscalYear;
    logAuditEvent(req, 'UPDATE_FISCAL_YEAR', 'FISCAL_YEAR', `Updated fiscal year ${fiscalYear.code}`);
    return res.json(fiscalYear);
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ message: 'That fiscal year code already exists.' });
    console.error('Error updating fiscal year:', error);
    return res.status(500).json({ message: `Unable to update fiscal year: ${error.message}` });
  }
});

// Super Admin re-authorization gate: fiscal period lock/unlock requires verified
// Super Admin email + password (server-side check, independent of the session role).
async function verifySuperAdminCredentials(
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
          .catch(() => undefined);
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

app.post('/api/fiscal-years/:id/close', requireRole('SUPER_ADMIN'), async (req, res) => {
  const { id } = req.params;
  const authCheck = await verifySuperAdminCredentials(req.body?.adminEmail, req.body?.adminPassword);
  if (!authCheck.ok) return res.status(403).json({ message: authCheck.message });
  try {
    const result = await pgPool.query(
      `UPDATE fiscal_years
       SET is_closed = TRUE
       WHERE id = $1 AND end_date_ad < CURRENT_DATE
       RETURNING id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                 start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                 is_current AS "isCurrent", is_closed AS "isClosed";`,
      [id]
    );
    const fiscalYear = result.rows[0];
    if (!fiscalYear) {
      const existing = await pgPool.query('SELECT end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE id = $1;', [id]);
      if (!existing.rows[0]) return res.status(404).json({ message: 'Fiscal year not found.' });
      return res.status(400).json({ message: `Fiscal year closing is available only after ${existing.rows[0].endDateAD}.` });
    }

    const index = fiscalYears.findIndex((item) => item.id === id);
    if (index >= 0) fiscalYears[index] = fiscalYear;
    logAuditEvent(req, 'CLOSE_FISCAL_YEAR', 'FISCAL_YEAR', `Closed and locked fiscal year ${fiscalYear.code} (authorized by ${authCheck.email})`);
    return res.json(fiscalYear);
  } catch (error: any) {
    console.error('Error closing fiscal year:', error);
    return res.status(500).json({ message: `Unable to close fiscal year: ${error.message}` });
  }
});

app.post('/api/fiscal-years/:id/reopen', requireRole('SUPER_ADMIN'), async (req, res) => {
  const { id } = req.params;
  const authCheck = await verifySuperAdminCredentials(req.body?.adminEmail, req.body?.adminPassword);
  if (!authCheck.ok) return res.status(403).json({ message: authCheck.message });
  try {
    const result = await pgPool.query(
      `UPDATE fiscal_years SET is_closed = FALSE WHERE id = $1
       RETURNING id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                 start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                 is_current AS "isCurrent", is_closed AS "isClosed";`,
      [id]
    );
    const fiscalYear = result.rows[0];
    if (!fiscalYear) return res.status(404).json({ message: 'Fiscal year not found.' });
    const index = fiscalYears.findIndex((item) => item.id === id);
    if (index >= 0) fiscalYears[index] = fiscalYear;
    logAuditEvent(req, 'REOPEN_FISCAL_YEAR', 'FISCAL_YEAR', `Reopened fiscal year ${fiscalYear.code} (authorized by ${authCheck.email})`);
    return res.json(fiscalYear);
  } catch (error: any) {
    console.error('Error reopening fiscal year:', error);
    return res.status(500).json({ message: `Unable to reopen fiscal year: ${error.message}` });
  }
});

app.post('/api/fiscal-years/:id/initialize-opening-stock', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await withTransaction(async (client) => {
      const sourceResult = await client.query(
        'SELECT id, code, end_date_ad, is_closed FROM fiscal_years WHERE id = $1 FOR UPDATE;',
        [id]
      );
      const sourceFiscalYear = sourceResult.rows[0];
      if (!sourceFiscalYear) {
        const error: any = new Error('Source fiscal year not found.');
        error.statusCode = 404;
        throw error;
      }
      if (!sourceFiscalYear.is_closed) {
        const error: any = new Error('Close and lock the source fiscal year before creating opening stock.');
        error.statusCode = 400;
        throw error;
      }

      const targetResult = await client.query(
        `SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                is_current AS "isCurrent", is_closed AS "isClosed"
         FROM fiscal_years WHERE start_date_ad > $1 ORDER BY start_date_ad ASC LIMIT 1 FOR UPDATE;`,
        [sourceFiscalYear.end_date_ad]
      );
      const targetFiscalYear = targetResult.rows[0];
      if (!targetFiscalYear) {
        const error: any = new Error('Create the next fiscal year before initializing its opening stock.');
        error.statusCode = 400;
        throw error;
      }

      // Enterprise rule: rows that were manually adjusted after the original close
      // (source_type = 'MANUAL_ADJUSTMENT') are posted, corrected opening balances and
      // must survive a re-initialization. Only closing-generated rows get refreshed.
      const existingRes = await client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE source_type = 'MANUAL_ADJUSTMENT')::int AS manual
         FROM fiscal_year_opening_stock WHERE fiscal_year_id = $1`,
        [targetFiscalYear.id]
      );
      const manualRowsPreserved = existingRes.rows[0]?.manual || 0;

      const inserted = await client.query(
        `INSERT INTO fiscal_year_opening_stock (
           id, fiscal_year_id, product_id, branch_id, quantity_on_hand, damaged_qty, unit_cost, source_type, source_reference, posted_by
         )
         SELECT
           'open-' || $1 || '-' || products.id || '-' || branches.id,
           $1, products.id, branches.id,
           COALESCE(inventory_stock.quantity_on_hand, 0),
           COALESCE(inventory_stock.damaged_qty, 0),
           COALESCE(products.cost_price, 0),
           'FISCAL_CLOSE', $2, $3
         FROM products
         CROSS JOIN branches
         LEFT JOIN inventory_stock
           ON inventory_stock.product_id = products.id
          AND inventory_stock.branch_id = branches.id
         WHERE branches.active = TRUE
         ON CONFLICT (fiscal_year_id, product_id, branch_id) DO UPDATE SET
           quantity_on_hand = EXCLUDED.quantity_on_hand,
           damaged_qty = EXCLUDED.damaged_qty,
           unit_cost = EXCLUDED.unit_cost,
           source_type = EXCLUDED.source_type,
           source_reference = EXCLUDED.source_reference,
           posted_at = CURRENT_TIMESTAMP,
           posted_by = EXCLUDED.posted_by
         WHERE fiscal_year_opening_stock.source_type <> 'MANUAL_ADJUSTMENT'
         RETURNING id;`,
        [targetFiscalYear.id, sourceFiscalYear.code, getUserFromReq(req).email || 'system']
      );
      return { targetFiscalYear, recordsCreated: inserted.rowCount || 0, manualRowsPreserved };
    });

    logAuditEvent(
      req,
      'INITIALIZE_FISCAL_OPENING_STOCK',
      'FISCAL_YEAR',
      `Initialized ${result.recordsCreated} opening-stock records for ${result.targetFiscalYear.code}${
        result.manualRowsPreserved ? `; ${result.manualRowsPreserved} manual adjustment row(s) preserved` : ''
      }`
    );
    return res.json(result);
  } catch (error: any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.error('Error initializing fiscal-year opening stock:', error);
    return res.status(500).json({ message: `Unable to initialize fiscal-year opening stock: ${error.message}` });
  }
});

// ========== FISCAL-YEAR OPENING STOCK — REGISTER VIEW & MANUAL ADJUSTMENT ==========

// View the full opening-stock register for a fiscal year: every product × branch row
// (including zero-quantity rows) joined with product/branch names and the current live
// stock as a reference, plus summary stats.
app.get(
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
app.put(
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
app.get(
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
app.put(
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
app.post(
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

app.delete('/api/fiscal-years/:id', requireRole('SUPER_ADMIN'), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await withTransaction(async (client) => {
      const fiscalYearResult = await client.query(
        'SELECT id, code, is_current AS "isCurrent", is_closed AS "isClosed" FROM fiscal_years WHERE id = $1 FOR UPDATE;',
        [id]
      );
      const fiscalYear = fiscalYearResult.rows[0];

      if (!fiscalYear) {
        const error: any = new Error('Fiscal year not found.');
        error.statusCode = 404;
        throw error;
      }

      if (fiscalYear.isCurrent) {
        const error: any = new Error('The active fiscal year cannot be deleted. Set another fiscal year as active first.');
        error.statusCode = 400;
        throw error;
      }

      // Safety guard: a fiscal year that already carries ANY business records
      // (invoices, stock operations, opening balances, audit/transaction logs,
      // device records, etc.) must never be deleted. Only a completely empty
      // period created by mistake can be removed. bs_day_records are excluded:
      // they are auto-generated calendar reference rows (FK ON DELETE SET NULL)
      // that exist for every period, not business records belonging to the FY.
      const referenceTables: Array<[table: string, label: string]> = [
        ['purchase_invoices', 'purchase invoices'],
        ['purchase_orders', 'purchase orders'],
        ['shipments', 'shipments'],
        ['stock_operations', 'stock operations'],
        ['damage_records', 'damage records'],
        ['fixed_assets', 'fixed assets'],
        ['vendor_payments', 'vendor payments'],
        ['audit_logs', 'audit logs'],
        ['transaction_logs', 'transaction logs'],
        ['customer_device_records', 'customer device records'],
        ['approval_requests', 'approval requests'],
        ['fiscal_year_opening_stock', 'opening-stock records'],
        ['vendor_opening_balances', 'vendor opening-balance records'],
      ];
      const tableCounts: Array<{ label: string; count: number }> = [];

      for (const [table, label] of referenceTables) {
        try {
          const countResult = await client.query(
            `SELECT COUNT(*)::int AS count FROM ${table} WHERE fiscal_year_id = $1;`,
            [id]
          );
          const count = Number(countResult.rows[0]?.count || 0);
          if (count > 0) tableCounts.push({ label, count });
        } catch (countError: any) {
          // The table may not exist in older deployments — skip it rather than
          // failing the whole deletion check.
          if (countError?.code !== '42P01') throw countError;
        }
      }

      if (tableCounts.length > 0) {
        const summary = tableCounts.map((t) => `${t.label} (${t.count})`).join(', ');
        const error: any = new Error(
          `Fiscal year ${fiscalYear.code} cannot be deleted because it already contains records: ${summary}. Only a fiscal year with no records can be removed.`
        );
        error.statusCode = 400;
        throw error;
      }

      await client.query('DELETE FROM fiscal_years WHERE id = $1;', [id]);
      return fiscalYear;
    });

    fiscalYears = fiscalYears.filter((fiscalYear) => fiscalYear.id !== id);
    logAuditEvent(req, 'DELETE_FISCAL_YEAR', 'FISCAL_YEAR', `Deleted fiscal year ${result.code} (no records existed)`);
    return res.json({ message: `Fiscal year ${result.code} deleted successfully.`, id });
  } catch (error: any) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error('Error deleting fiscal year:', error);
    return res.status(500).json({ message: `Unable to delete fiscal year: ${error.message}` });
  }
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

/**
 * Date-type integrity guard.
 *
 * Detects when a BS (Nepali) date string has been submitted in an AD date
 * field (or vice versa) so calendar mismatches can never reach the database:
 *  - values containing the "BS" suffix are rejected for AD fields
 *  - a 4-digit year >= 2060 (BS years are 2078-2099, AD dates here are 2015-2059)
 *    is treated as a BS date sent in the wrong field
 *  - malformed date strings are rejected
 *
 * Returns a human-readable error message, or null when the value is a valid AD date.
 */
function detectDateTypeMismatch(raw: unknown, fieldName: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/\bBS\b/i.test(s)) {
    return `Date type mismatch: "${s}" is a BS (Nepali) date but was sent in AD field "${fieldName}". AD fields must contain a Gregorian (AD) date like 2026-08-30. Send the matching BS value only in the corresponding ${fieldName}BS field.`;
  }
  const m = s.split('T')[0].match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    return `Date type mismatch: "${s}" in field "${fieldName}" is not a valid AD date (expected YYYY-MM-DD Gregorian format).`;
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (year >= 2060) {
    return `Date type mismatch: "${s}" looks like a BS (Nepali) date (year ${year}) but was sent in AD field "${fieldName}". Convert it to its Gregorian (AD) equivalent first, e.g. send dateAD=2026-08-30 and dateBS=2083-05-14 BS.`;
  }
  if (year < 2015) {
    return `Date type mismatch: "${s}" in field "${fieldName}" is not a plausible AD date (AD year must be between 2015 and 2059). If it is a BS date, convert it to AD before submitting.`;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return `Date type mismatch: "${s}" in field "${fieldName}" is not a valid AD date (month/day out of range).`;
  }
  return null;
}

/**
 * Resolves the exact BS day record for an AD date. PostgreSQL's bs_day_records
 * table is authoritative; the in-memory cache is only consulted while
 * PostgreSQL is unreachable. Returns found=false when the date has never been
 * seeded (e.g. its BS month array is missing) so callers can block operations.
 */
async function findBsDayRecordForAdDate(adDateStr: string): Promise<{
  found: boolean;
  record: any | null;
  source: 'postgres' | 'memory';
}> {
  const target = String(adDateStr || '').split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    return { found: false, record: null, source: 'memory' };
  }

  try {
    const result = await pgPool.query(
      `SELECT ad_date::text AS "adDate", bs_date AS "bsDate", bs_year AS "bsYear", bs_month AS "bsMonth",
              bs_month_name AS "bsMonthName", bs_month_name_np AS "bsMonthNameNp", bs_day AS "bsDay",
              day_of_week_name AS "dayOfWeekName", day_of_week_name_np AS "dayOfWeekNameNp",
              fiscal_year AS "fiscalYear", quarter, is_weekend AS "isWeekend"
       FROM bs_day_records
       WHERE ad_date = $1`,
      [target]
    );
    if (result.rows.length > 0) {
      return { found: true, record: result.rows[0], source: 'postgres' };
    }
    // Database reachable but no row exists for this date -> genuinely unseeded
    return { found: false, record: null, source: 'postgres' };
  } catch (_err) {
    // PostgreSQL unreachable -> fall back to the in-memory calendar cache
    const memoryRecord = inMemoryBsDayRecords.find((r) => r.adDate === target) || null;
    return { found: memoryRecord !== null, record: memoryRecord, source: 'memory' };
  }
}

// Refreshes the in-memory BS-calendar fallback cache from PostgreSQL, which is
// the authoritative store for bs_calendar_years / bs_day_records. Called at
// startup so the cache (used only while PostgreSQL is unreachable) starts in
// sync with the database instead of the built-in defaults.
async function hydrateBsCalendarFromDb(client: any) {
  try {
    const yrRes = await client.query(
      'SELECT year_bs AS "yearBS", days_in_months AS "daysInMonths", start_ad::text AS "startAD" FROM bs_calendar_years ORDER BY year_bs ASC'
    );
    if (yrRes.rows.length > 0) inMemoryBsCalendarYears = yrRes.rows;
    const dayRes = await client.query(
      `SELECT ad_date::text AS "adDate", bs_date AS "bsDate", bs_year AS "bsYear", bs_month AS "bsMonth",
              bs_month_name AS "bsMonthName", bs_month_name_np AS "bsMonthNameNp", bs_day AS "bsDay",
              day_of_week_name AS "dayOfWeekName", day_of_week_name_np AS "dayOfWeekNameNp",
              fiscal_year AS "fiscalYear", quarter, is_weekend AS "isWeekend"
       FROM bs_day_records ORDER BY ad_date ASC`
    );
    if (dayRes.rows.length > 0) inMemoryBsDayRecords = dayRes.rows;
  } catch (e: any) {
    console.warn('BS calendar hydration from PostgreSQL skipped; using built-in calendar:', e?.message || e);
  }
}

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

// Single-day lookup against bs_day_records. Used by the stock-operations gate
// to verify that a Nepali (BS) date exists for the operation date before any
// stock movement is allowed.
app.get('/api/bs-calendar/day', async (req, res) => {
  try {
    const adDate = String(req.query.adDate || '');
    const result = await findBsDayRecordForAdDate(adDate);
    if (result.found) {
      return res.json({ found: true, source: result.source, record: result.record });
    }
    return res.json({
      found: false,
      source: result.source,
      adDate: adDate.split('T')[0] || null,
      message: 'BS date is not available. Please contact your system administrator for BS month seeding.',
    });
  } catch (err: any) {
    console.error('Error looking up BS day record:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
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
      pgSynced: true,
      message: `BS Year ${yearBS} already exists in database. Skipped overwrite because 'onlyIfNew' was specified.`,
    });
  }

  // PostgreSQL is the authoritative store for the calendar: write there first.
  // The in-memory store below is only a fallback cache for when PostgreSQL is
  // unreachable, so it is refreshed after the database write attempt.
  let pgSynced = false;
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
    pgSynced = true;
  } catch (_err) {
    // PostgreSQL is unreachable; continue with the in-memory fallback cache only
  }

  if (existingIdx >= 0) {
    inMemoryBsCalendarYears[existingIdx] = { yearBS, daysInMonths, startAD };
  } else {
    inMemoryBsCalendarYears.push({ yearBS, daysInMonths, startAD });
    inMemoryBsCalendarYears.sort((a, b) => a.yearBS - b.yearBS);
  }
  generateInMemoryBsDayRecords();

  res.json({
    success: true,
    pgSynced,
    message: pgSynced
      ? `Successfully seeded BS Year ${yearBS} and regenerated calendar day-by-day lookup table in PostgreSQL (bs_day_records)!`
      : `Seeded BS Year ${yearBS} in the in-memory calendar only — PostgreSQL was unreachable, so bs_day_records was not updated. Re-run the seed after the database is back.`,
  });
});

// Bulk (multi-year) seed endpoint - accepts array of { yearBS, daysInMonths, customStartAD? }
app.post('/api/bs-calendar/seed-bulk', async (req, res) => {
  const { years, onlyIfNew } = req.body;
  if (!Array.isArray(years) || years.length === 0) {
    return res.status(400).json({ success: false, message: 'Must provide non-empty years array' });
  }

  let pgSynced = false;
  let seededCount = 0;
  const skippedYears: number[] = [];
  const errors: string[] = [];

  try {
    for (const item of years) {
      const { yearBS, daysInMonths, customStartAD } = item;
      if (!yearBS || !Array.isArray(daysInMonths) || daysInMonths.length !== 12) {
        errors.push(`Year ${yearBS}: invalid payload`);
        continue;
      }

      let startAD = customStartAD;
      if (!startAD) {
        const estADYear = yearBS - 57;
        startAD = `${estADYear}-04-14`;
      }

      const existingIdx = inMemoryBsCalendarYears.findIndex((y) => y.yearBS === yearBS);
      if (onlyIfNew && existingIdx >= 0) {
        skippedYears.push(yearBS);
        continue;
      }

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

      if (existingIdx >= 0) {
        inMemoryBsCalendarYears[existingIdx] = { yearBS, daysInMonths, startAD };
      } else {
        inMemoryBsCalendarYears.push({ yearBS, daysInMonths, startAD });
      }
      seededCount++;
    }

    inMemoryBsCalendarYears.sort((a, b) => a.yearBS - b.yearBS);
    generateInMemoryBsDayRecords();
    pgSynced = true;
  } catch (_err) {
    // PostgreSQL is unreachable; in-memory fallback only
  }

  res.json({
    success: true,
    pgSynced,
    seededCount,
    skippedYears,
    message: pgSynced
      ? `Successfully seeded ${seededCount} BS year(s) and regenerated calendar day-by-day lookup table in PostgreSQL (bs_day_records)!${skippedYears.length ? ` Skipped ${skippedYears.length} existing year(s): ${skippedYears.join(', ')}` : ''}`
      : `Seeded ${seededCount} BS year(s) in the in-memory calendar only — PostgreSQL was unreachable. Re-run when database is back.${skippedYears.length ? ` Skipped ${skippedYears.length} existing year(s): ${skippedYears.join(', ')}` : ''}`,
  });
});

app.post('/api/bs-calendar/sync-range', async (req, res) => {
  const { dayRecords } = req.body;
  if (!Array.isArray(dayRecords) || dayRecords.length === 0) {
    return res.status(400).json({ success: false, message: 'No day records provided to write to SQL database.' });
  }

  // PostgreSQL is the authoritative store: write there first, then refresh the
  // in-memory fallback cache with the same records.
  let pgSynced = false;
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
    pgSynced = true;
  } catch (_err) {
    // PostgreSQL is unreachable; continue with the in-memory fallback cache only
  }

  const recordMap = new Map<string, any>();
  for (const r of inMemoryBsDayRecords) {
    recordMap.set(r.adDate, r);
  }
  for (const r of dayRecords) {
    recordMap.set(r.adDate, r);
  }
  inMemoryBsDayRecords = Array.from(recordMap.values());

  const insertedCount = dayRecords.length;
  res.json({
    success: true,
    pgSynced,
    count: insertedCount,
    message: pgSynced
      ? `Successfully written & updated ${insertedCount} daily conversion records in PostgreSQL bs_day_records table!`
      : `Kept ${insertedCount} daily conversion records in the in-memory calendar only — PostgreSQL was unreachable, so bs_day_records was not updated.`,
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
      let sql = `SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAD", issued_date_bs AS "issuedDateBS", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records`;
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
    const normalizedDeviceSerial = String(newRecord.deviceSerial || '').trim().toUpperCase();
    const normalizedPonSerial = String(newRecord.ponSerial || '').trim().toUpperCase();
    if (!normalizedDeviceSerial || !normalizedPonSerial) {
      return res.status(400).json({ message: 'Device serial and PON serial are required.' });
    }
    const duplicateLocal = customerDeviceRecords.find((record) =>
      record.id !== newRecord.id &&
      (String(record.deviceSerial || '').trim().toUpperCase() === normalizedDeviceSerial ||
        String(record.ponSerial || '').trim().toUpperCase() === normalizedPonSerial)
    );
    if (duplicateLocal) return res.status(409).json({ message: 'Device serial or PON serial is already registered.' });
    if (isPgConnected) {
      const duplicateDb = await pgPool.query(
        `SELECT 1 FROM customer_device_records
         WHERE id <> $1 AND (UPPER(TRIM(device_serial)) = $2 OR UPPER(TRIM(pon_serial)) = $3) LIMIT 1`,
        [newRecord.id, normalizedDeviceSerial, normalizedPonSerial]
      );
      if (duplicateDb.rowCount) return res.status(409).json({ message: 'Device serial or PON serial is already registered.' });
    }
    const custCode = newRecord.customerCode || newRecord.customerId;
    const branchId = newRecord.branchId || 'WH001';
    const nextStatus = newRecord.status || 'ACTIVE';
    const previousRecord = customerDeviceRecords.find((c) => c.id === newRecord.id);
    let previousStatus = previousRecord?.status;
    if (isPgConnected && !previousStatus) {
      const existingRecord = await pgPool.query('SELECT status FROM customer_device_records WHERE id = $1', [newRecord.id]);
      previousStatus = existingRecord.rows[0]?.status;
    }
    const wasAssigned = Boolean(previousStatus && previousStatus !== 'IN_STOCK');
    const isAssigned = nextStatus !== 'IN_STOCK';
    const assignmentDelta = (isAssigned ? 1 : 0) - (wasAssigned ? 1 : 0);
    const product = products.find((entry) => entry.name.trim().toLowerCase() === String(newRecord.productName || '').trim().toLowerCase());
    if (isAssigned && !product) return res.status(400).json({ message: 'A valid product is required when assigning a device.' });

    if (isPgConnected) {
      await withTransaction(async (client) => {
        if (assignmentDelta !== 0 && product) {
          const stockChange = assignmentDelta < 0 ? 1 : -1;
          const stockResult = await client.query(
            `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP
             WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $4
             RETURNING quantity_on_hand`,
            [stockChange, product.id, branchId, assignmentDelta > 0 ? 1 : 0]
          );
          if (stockResult.rowCount !== 1) throw new Error(`Insufficient available stock for ${newRecord.productName}.`);
        }
        await client.query(
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
          branchId,
          newRecord.productName,
          newRecord.deviceSerial,
          newRecord.ponSerial || newRecord.deviceSerial,
          newRecord.macAddress || null,
          nextStatus,
          newRecord.issuedDateAD || new Date().toISOString().split('T')[0],
          newRecord.issuedDateBS || '2083-04-16 BS',
          newRecord.purchaseBillRef || null,
          newRecord.notes || '',
          ]
        );

        const countDelta = assignmentDelta;
        await client.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, status, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)
         ON CONFLICT (customer_id) DO UPDATE SET
           assigned_devices_count = GREATEST(0, customer_records.assigned_devices_count + $8);`,
        [
          custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          newRecord.customerName,
          newRecord.customerName.toLowerCase().replace(/\s+/g, '.'),
          newRecord.contactPhone || '9800000000',
          newRecord.branchId || 'WH001',
          newRecord.installationAddress || 'Nepal',
          countDelta,
        ]
        );
      });
    } else if (assignmentDelta !== 0 && product) {
      const stockRecord = inventoryStock.find((entry) => entry.productId === product.id && entry.branchId === branchId);
      if (!stockRecord || (assignmentDelta > 0 && stockRecord.quantityOnHand < 1)) {
        return res.status(400).json({ message: `Insufficient available stock for ${newRecord.productName}.` });
      }
      stockRecord.quantityOnHand -= assignmentDelta;
      stockRecord.lastUpdated = new Date().toISOString();
    }
    const idx = customerDeviceRecords.findIndex((c) => c.id === newRecord.id);
    if (idx >= 0) customerDeviceRecords[idx] = { ...newRecord, status: nextStatus, branchId };
    else customerDeviceRecords.unshift({ ...newRecord, status: nextStatus, branchId });
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
  const { branchId, fiscalYearId } = req.query;

  if (isPgConnected) {
    try {
      const hasBranch = Boolean(branchId && branchId !== 'ALL');

      // Fiscal-year scoping: for any year OTHER than the current fiscal year,
      // inventory is valued from that year's opening-stock ledger
      // (fiscal_year_opening_stock) — the live inventory_stock balance only
      // represents the current fiscal year and must not be reported for
      // past/closed years.
      const currentFy = pickCurrentFiscalYear(fiscalYears) || null;
      const requestedFy = fiscalYearId
        ? fiscalYears.find((f) => f.id === fiscalYearId || f.code === fiscalYearId)
        : undefined;
      const useOpeningStock = Boolean(requestedFy && currentFy && requestedFy.id !== currentFy.id);

      // Inventory Asset Value: SUM(quantity * cost_price)
      const invParams: any[] = [];
      let invSql: string;
      if (useOpeningStock) {
        invSql = `SELECT SUM(os.quantity_on_hand * p.cost_price) AS total
                  FROM fiscal_year_opening_stock os
                  JOIN products p ON os.product_id = p.id
                  WHERE os.fiscal_year_id = $1`;
        invParams.push(requestedFy!.id);
        if (hasBranch) {
          invParams.push(branchId);
          invSql += ` AND os.branch_id = $${invParams.length}`;
        }
      } else {
        invSql = `SELECT SUM(s.quantity_on_hand * p.cost_price) AS total
                  FROM inventory_stock s
                  JOIN products p ON s.product_id = p.id`;
        const conds: string[] = [];
        if (hasBranch) {
          invParams.push(branchId);
          conds.push(`s.branch_id = $${invParams.length}`);
        }
        if (conds.length) invSql += ` WHERE ${conds.join(' AND ')}`;
      }
      const invRes = await pgPool.query(invSql, invParams);
      const totalInventoryAssetValue = Number(invRes.rows[0]?.total || 0);

      // Fixed Asset Value (net book value is a live snapshot; the system does
      // not track per-fiscal-year NBV history)
      const assetRes = await pgPool.query(
        `SELECT SUM(net_book_value) AS total FROM fixed_assets` + (hasBranch ? ' WHERE branch_id = $1' : ''),
        hasBranch ? [branchId] : []
      );
      const totalFixedAssetValue = Number(assetRes.rows[0]?.total || 0);

      // Accounts Payable & VAT Input Tax (scoped to the selected fiscal year)
      // AP = opening balance (from vendor_opening_balances, i.e. the carry-forward
      // from the prior FY close) + current-period unpaid invoices − posted payments.
      const piConds: string[] = [];
      const piParams: any[] = [];
      if (requestedFy) {
        piParams.push(requestedFy.id);
        piConds.push(`fiscal_year_id = $${piParams.length}`);
      }
      if (hasBranch) {
        piParams.push(branchId);
        piConds.push(`branch_id = $${piParams.length}`);
      }
      const invPayRes = await pgPool.query(
        `SELECT SUM(grand_total) AS total_invoiced, SUM(vat_amount) AS total_vat FROM purchase_invoices` +
          (piConds.length ? ` WHERE ${piConds.join(' AND ')}` : ''),
        piParams
      );
      // Opening balance carry-forward (same FY + branch scope)
      const obParams: any[] = [];
      const obConds: string[] = [];
      if (requestedFy) {
        obParams.push(requestedFy.id);
        obConds.push(`fiscal_year_id = $${obParams.length}`);
      }
      if (hasBranch) {
        obParams.push(branchId);
        obConds.push(`branch_id = $${obParams.length}`);
      }
      const obRes = await pgPool.query(
        `SELECT COALESCE(SUM(opening_balance), 0)::float AS total_ob FROM vendor_opening_balances` +
          (obConds.length ? ` WHERE ${obConds.join(' AND ')}` : ''),
        obParams
      );
      // Posted vendor payments in the same scope. Note: vendor payments are
      // scoped by payment_date_ad date range (like the bootstrap endpoint),
      // because older payments may have a NULL fiscal_year_id.
      const vpConds: string[] = [];
      const vpParams: any[] = [];
      if (requestedFy) {
        vpParams.push(requestedFy.startDateAD, requestedFy.endDateAD);
        vpConds.push(`payment_date_ad >= $${vpParams.length - 1}`);
        vpConds.push(`payment_date_ad <= $${vpParams.length}`);
      }
      if (hasBranch) {
        vpParams.push(branchId);
        vpConds.push(`branch_id = $${vpParams.length}`);
      }
      vpConds.push(`status = 'POSTED'`);
      const vpPayRes = await pgPool.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total_paid FROM vendor_payments` +
          (vpConds.length ? ` WHERE ${vpConds.join(' AND ')}` : ''),
        vpParams
      );
      const vendorOpeningBal = Number(obRes.rows[0]?.total_ob || 0);
      const currentPeriodInvoiced = Number(invPayRes.rows[0]?.total_invoiced || 0);
      const postedPayments = Number(vpPayRes.rows[0]?.total_paid || 0);
      const totalAccountsPayable = vendorOpeningBal + currentPeriodInvoiced - postedPayments;
      const totalVatInputTax = Number(invPayRes.rows[0]?.total_vat || 0);

      // Damage Loss Value (scoped to the selected fiscal year)
      const opConds: string[] = [];
      const opParams: any[] = [];
      if (requestedFy) {
        opParams.push(requestedFy.id);
        opConds.push(`fiscal_year_id = $${opParams.length}`);
      }
      if (hasBranch) {
        opParams.push(branchId);
        opConds.push(`branch_id = $${opParams.length}`);
      }
      const opRes = await pgPool.query(
        `SELECT SUM(total_value) AS total FROM stock_operations` +
          (opConds.length ? ` WHERE ${opConds.join(' AND ')}` : ''),
        opParams
      );
      const totalDamageLossValue = Number(opRes.rows[0]?.total || 0);

      // Sales Revenue + Cost of Goods Sold: fetch the priced STOCK_OUT sale
      // operations in the same FY/branch scope as inventory, then derive both
      // numbers from the sale lines (identical logic to the bootstrap helper).
      const saleConds: string[] = [`type = 'STOCK_OUT'`];
      const saleParams: any[] = [];
      if (requestedFy) {
        saleParams.push(requestedFy.startDateAD, requestedFy.endDateAD);
        saleConds.push(`date_ad >= $${saleParams.length - 1}`);
        saleConds.push(`date_ad <= $${saleParams.length}`);
      }
      if (hasBranch) {
        saleParams.push(branchId);
        saleConds.push(`branch_id = $${saleParams.length}`);
      }
      const saleRes = await pgPool.query(
        `SELECT items FROM stock_operations` +
          (saleConds.length ? ` WHERE ${saleConds.join(' AND ')}` : ''),
        saleParams
      );
      const saleResRows: any[] = saleRes.rows || [];
      const saleLines = saleResRows.flatMap((r: any) => {
        const lines = Array.isArray(r.items) ? r.items : [];
        return lines.filter(
          (it: any) => it.totalValue !== undefined || it.sellingPrice !== undefined
        );
      });

      // Products are needed to resolve cost for lines that don't carry unitCost.
      const prodResForCogs = await pgPool.query(
        'SELECT id, cost_price AS "costPrice" FROM products'
      );
      const productsForCogs = prodResForCogs.rows;
      let totalSalesRevenue = 0;
      let totalCostOfGoodsSold = 0;
      for (const it of saleLines) {
        const qty = Number(it.quantity) || 0;
        const revenue = Number(it.totalValue) || Math.max(
          0,
          qty * (Number(it.sellingPrice) || 0) - (Number(it.discount) || 0)
        );
        if (revenue > 0) totalSalesRevenue += revenue;
        if (qty > 0) {
          const prod = productsForCogs.find((p: any) => p.id === it.productId);
          const unitCost = Number(it.unitCost) || (prod ? Number(prod.costPrice) : 0);
          totalCostOfGoodsSold += qty * unitCost;
        }
      }

      const currentFyCode = currentFy?.code || '2082/83';

      return res.json({
        totalInventoryAssetValue,
        totalFixedAssetValue,
        totalAccountsPayable,
        totalSalesRevenue,
        totalCostOfGoodsSold,
        totalDamageLossValue,
        totalVatInputTax,
        currentFiscalYear: requestedFy ? requestedFy.code : currentFyCode,
        fiscalYearId: requestedFy ? requestedFy.id : null,
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

  // In-memory fallback: derive the trading summary from the same STOCK_OUT
  // sale-op lines (identical rules as the Postgres path).
  const inMemTrading = computeTradingFromOps(targetOps, products);

  const currentFy = pickCurrentFiscalYear(fiscalYears)?.code || '2082/83';

  res.json({
    totalInventoryAssetValue,
    totalFixedAssetValue,
    totalAccountsPayable,
    totalSalesRevenue: inMemTrading.totalSalesRevenue,
    totalCostOfGoodsSold: inMemTrading.totalCostOfGoodsSold,
    totalDamageLossValue,
    totalVatInputTax,
    currentFiscalYear: currentFy,
    fiscalYearId: null,
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
        'STOCK_OPERATIONS', 'FIXED_ASSETS', 'CPE_MANAGEMENT', 'INVENTORY_AUDIT',
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
      -- Allow the extended stock-movement event types used by the operational
      -- modules (Stock Operations, Damage Disposal, Product Stock-Out). Fresh
      -- installs already get the new list from the CREATE TABLE above; this is
      -- a no-op rewrite on databases created before the extended set shipped.
      ALTER TABLE transaction_logs DROP CONSTRAINT IF EXISTS transaction_logs_change_type_check;
      ALTER TABLE transaction_logs ADD CONSTRAINT transaction_logs_change_type_check CHECK (
        change_type IN ('INBOUND_PO', 'PURCHASE_INVOICE', 'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT',
          'DAMAGE', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT',
          'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN')
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
    `);

    isPgConnected = true;
    setIsPgConnected(true);
    await seedInitialPostgresData(client);
    await hydrateOperationalData(client);
    await hydrateBsCalendarFromDb(client);

    client.release();
    console.log('✅ All 28 Database tables and enterprise composite performance indexes synced successfully on PostgreSQL.');
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
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.code, b.name, b.location, b.phone || '', b.isHeadquarters || false, b.active !== false, b.allowProcurement !== false]
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

    // Hydrate all master data from PostgreSQL
    const bRes = await client.query('SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches ORDER BY code');
    if (bRes.rows.length > 0) branches = bRes.rows;

    const dbUsersRes = await client.query(
      'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC'
    );
    if (dbUsersRes.rows.length > 0) {
      users = dbUsersRes.rows;
    }

    const fyRes = await client.query('SELECT id, code, start_date_ad AS "startDateAD", end_date_ad AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo" FROM fiscal_years ORDER BY start_date_ad DESC');
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

    console.log('✅ Master data seeded and hydrated. Operational data is always served from PostgreSQL (single source of truth).');
  } catch (seedErr: any) {
    console.log('PostgreSQL initial seed note:', seedErr?.message || seedErr);
  }
}

// Re-hydrates the operational runtime caches directly from PostgreSQL so the
// server always starts with a mirror of the database (PostgreSQL is the
// single source of truth). Each table is loaded independently; a failure on
// one table keeps the previously loaded caches intact.
async function hydrateOperationalData(client: pg.PoolClient) {
  const loads: Array<{ name: string; query: string; apply: (rows: any[]) => void }> = [
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
      name: 'vendor_opening_balances',
      query: 'SELECT id, fiscal_year_id AS "fiscalYearId", supplier_id AS "supplierId", branch_id AS "branchId", opening_balance::float AS "openingBalance", source_type AS "sourceType", source_reference AS "sourceReference", posted_at::text AS "postedAt", posted_by AS "postedBy" FROM vendor_opening_balances',
      apply: (rows) => { vendorOpeningBalances = rows; },
    },
  ];

  for (const load of loads) {
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


async function startServer() {
  await syncDatabaseAndIndexes();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Inventory Management System server running on http://localhost:${PORT}`);
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
