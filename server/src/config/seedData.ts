// Seed constants: default company profile, document numbering, master data
// (UoM, locations, branches, fiscal years, suppliers) and demo user accounts.
// Extracted verbatim from app.ts. Runtime state declarations remain in app.ts.
import type { CompanyProfile, DocumentNumberConfig, UnitOfMeasure, LocationRecord, Branch, FiscalYear, Supplier, User } from '../../../client/src/types';

// EXAMPLE/DUMMY company profile (is_demo-labelled data). Replace via the
// Company Setup screen once real company details are available.
export const INITIAL_COMPANY_PROFILE: CompanyProfile = {
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
  currencySymbol: 'NPR',
  currencyCode: 'NPR',
  currencyLocale: 'en-IN',
  currencyPosition: 'before',
  currencyDecimals: 2,
  defaultTaxRate: 13,
  notes: 'Default company profile — configure real details in Company Setup.',
};


export const INITIAL_DOCUMENT_NUMBER_CONFIGS: DocumentNumberConfig[] = [
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


// Master Initial Seed Specifications for PostgreSQL database initialization
export const INITIAL_MASTER_UOM: UnitOfMeasure[] = [
  { id: 'uom-1', name: 'Pieces', symbol: 'Pcs', type: 'Count', isBaseUnit: true },
  { id: 'uom-2', name: 'Meters', symbol: 'Mtr', type: 'Length', isBaseUnit: true },
  { id: 'uom-3', name: 'Rolls', symbol: 'Roll', type: 'Package', isBaseUnit: false },
  { id: 'uom-4', name: 'Boxes', symbol: 'Box', type: 'Package', isBaseUnit: false },
  { id: 'uom-5', name: 'Sets', symbol: 'Set', type: 'Count', isBaseUnit: true },
];

// EXAMPLE/DUMMY locations (is_demo = TRUE). No real site data.
export const INITIAL_MASTER_LOCATIONS: LocationRecord[] = [
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
export const INITIAL_MASTER_BRANCHES: Branch[] = [
  { id: 'WH001', code: 'WH001', name: 'Branch 1 (Head Office)', location: 'Example Location 1', phone: '9800000000', isHeadquarters: true, active: true },
  { id: 'BRH01', code: 'BRH01', name: 'Branch 2', location: 'Example Location 2', phone: '9800000001', isHeadquarters: false, active: true },
];

export const INITIAL_MASTER_FISCAL_YEARS: FiscalYear[] = [
  { id: 'fy-1', code: '2080-81', startDateAD: '2023-07-17', endDateAD: '2024-07-15', startDateBS: '2080-04-01 BS', endDateBS: '2080-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-2', code: '2081-82', startDateAD: '2024-07-16', endDateAD: '2025-07-15', startDateBS: '2081-04-01 BS', endDateBS: '2081-12-31 BS', isCurrent: false, isClosed: true },
  { id: 'fy-3', code: '2082-83', startDateAD: '2025-07-16', endDateAD: '2026-07-15', startDateBS: '2082-04-01 BS', endDateBS: '2082-12-31 BS', isCurrent: true, isClosed: false },
  { id: 'fy-4', code: '2083-84', startDateAD: '2026-07-16', endDateAD: '2027-07-15', startDateBS: '2083-04-01 BS', endDateBS: '2083-12-31 BS', isCurrent: false, isClosed: false },
];

// EXAMPLE/DUMMY suppliers (is_demo = TRUE). No real supplier data.
// Ids match scripts/demo_dataset.js DEMO_SUPPLIERS (demo-sup-*) so the seed
// rows are the SAME suppliers referenced by demo invoices/payments/POs.
export const INITIAL_MASTER_SUPPLIERS: Supplier[] = [
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
export const EXAMPLE_USER_PASSWORD = 'Demo@123';
export const INITIAL_EXAMPLE_USERS: Array<{
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
