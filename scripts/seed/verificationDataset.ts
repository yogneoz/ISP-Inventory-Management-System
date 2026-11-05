// ============================================================================
// Verification dataset — the ONE source for the data `npm run seed:verify`
// (and `npm run setup:pg`) writes.
//
// It replaces the old `scripts/demo_dataset.js`. That file had drifted into a
// spreadsheet import (hundreds of SKUs, 125,000-rupee OLT cards, 50-unit
// consumable lots) whose totals could not be checked by hand, so the app could
// be "full" without a single balance anyone could verify. This dataset is the
// opposite: small, deliberately round, and its numbers are asserted at the end
// of every seed (see verifyTargets()).
//
// What it contains, per the verification brief:
//   * exactly two fiscal years — 2082-83 and 2083-84 — with documents in both;
//   * four branches, 20 customers each (80), 3 vendors each, 9 users;
//   * 20 stocked products (serial ONUs/routers, consumables, fixed-asset
//     equipment) with exactly 5 pieces per branch at a cost under 100, and 5
//     service products in the "Service Item" group with NO stock at all;
//   * purchase invoices, sales invoices, receipts, vendor payments, opening
//     stock, serial register rows and a full double-entry ledger;
//   * a trial balance that lands on the brief's figures:
//       Accounts Receivable 10,000   Accounts Payable 15,000
//       Inventory           20,000   Cash + Bank      10,000
//       Equity (capital)    50,000   Fixed assets     24,000
//       Prepaid & deposits   5,000
//
// Why the numbers balance (per branch, ×4 branches):
//   opening capital 12,500 = cash 5,250 + prepaid 1,250 + fixed assets 6,000
//   purchases   7,000  (20 products × 7 pcs × 50)  → AP 7,000
//   sales       3,600  (20 products × 2 pcs × 90)  + services 9,000
//   COGS        2,000  (40 pcs × 50) → closing stock 5,000
//   expenses    9,600  (rent 2,400 + salaries 7,200 over the two years)
//   receipts   10,100  → AR 2,500;  vendor payments 3,250 → AP 3,750
//   cash       5,250 + 10,100 − 3,250 − 9,600 = 2,500
//   profit    12,600 − 2,000 − 9,600 = 1,000
//   assets 2,500+5,000+2,500+1,250+6,000 = 17,250 = 3,750 AP + 12,500 capital
//                                             + 1,000 profit
// Every row is is_demo = TRUE, so the app's "Clear Demo Data" can still remove
// it (see server/src/models/admin.repo.ts DEMO_DATA_TABLES).
// ============================================================================
import fs from 'node:fs';
import { DEFAULT_CHART_ACCOUNTS, DEFAULT_CHART_GROUPS } from '../../server/src/config/defaultChart';
import { INITIAL_DOCUMENT_NUMBER_CONFIGS } from '../../server/src/config/seedData';

/** Round figures the brief asks the trial balance to show (whole company). */
export const TARGETS = {
  accountsReceivable: 10_000,
  accountsPayable: 15_000,
  inventory: 20_000,
  cashAndBank: 10_000,
  equity: 50_000,
  fixedAssets: 24_000,
  prepaid: 5_000,
  piecesPerProductPerBranch: 5,
  maxUnitCost: 100,
} as const;

const BRANCH_COUNT = 4;
const CUSTOMERS_PER_BRANCH = 20;
const VENDORS_PER_BRANCH = 3;
const UNIT_COST = 50; // < 100, so every stock line multiplies without decimals
const SELL_PRICE = 90;
const PURCHASED_PER_PRODUCT = 7; // 5 stay on hand, 2 are sold
const SOLD_PER_PRODUCT = 2;

export const BRANCHES = [
  { id: 'BR-KTM', code: 'KTM', name: 'Kathmandu (Head Office)', location: 'Kathmandu', phone: '9801000001', isHeadquarters: true },
  { id: 'BR-PKR', code: 'PKR', name: 'Pokhara Branch', location: 'Pokhara', phone: '9801000002', isHeadquarters: false },
  { id: 'BR-BTL', code: 'BTL', name: 'Butwal Branch', location: 'Butwal', phone: '9801000003', isHeadquarters: false },
  { id: 'BR-DHN', code: 'DHN', name: 'Dharan Branch', location: 'Dharan', phone: '9801000004', isHeadquarters: false },
] as const;

/** The two fiscal years the brief asks for; 2083-84 is the current one today. */
export const FISCAL_YEARS = [
  { id: 'fy-2082', code: '2082-83', startDateAD: '2025-07-17', endDateAD: '2026-07-16', startDateBS: '2082-04-01 BS', endDateBS: '2083-03-32 BS', isCurrent: false },
  { id: 'fy-2083', code: '2083-84', startDateAD: '2026-07-17', endDateAD: '2027-07-16', startDateBS: '2083-04-01 BS', endDateBS: '2084-03-32 BS', isCurrent: true },
] as const;

const BS_CALENDAR_YEARS = JSON.parse(
  fs.readFileSync(new URL('../../shared/bsCalendarYears.json', import.meta.url), 'utf8')
).years as { yearBS: number; daysInMonths: number[]; startAD: string }[];

/** AD -> 'YYYY-MM-DD BS' from the repository's one canonical BS calendar. */
export function bsLabel(adDate: string): string {
  for (const year of BS_CALENDAR_YEARS) {
    if (adDate < year.startAD) continue;
    let running = new Date(`${year.startAD}T00:00:00Z`);
    for (let monthIdx = 0; monthIdx < year.daysInMonths.length; monthIdx += 1) {
      const days = year.daysInMonths[monthIdx];
      const end = new Date(running.getTime() + (days - 1) * 86_400_000).toISOString().slice(0, 10);
      if (adDate <= end) {
        const day = Math.round((Date.parse(`${adDate}T00:00:00Z`) - running.getTime()) / 86_400_000) + 1;
        return `${year.yearBS}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')} BS`;
      }
      running = new Date(running.getTime() + days * 86_400_000);
    }
  }
  throw new Error(`Verification dataset: ${adDate} is outside the bundled BS calendar`);
}

function addDays(dateAD: string, days: number): string {
  return new Date(Date.parse(`${dateAD}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function compact(dateAD: string): string {
  return dateAD.replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------

const UOMS = [
  { id: 'uom-pcs', name: 'Pieces', symbol: 'Pcs', type: 'Count', isBaseUnit: true },
  { id: 'uom-box', name: 'Box', symbol: 'Box', type: 'Count', isBaseUnit: false },
  { id: 'uom-roll', name: 'Roll', symbol: 'Roll', type: 'Count', isBaseUnit: false },
  { id: 'uom-mtr', name: 'Meter', symbol: 'Mtr', type: 'Length', isBaseUnit: true },
  { id: 'uom-month', name: 'Month', symbol: 'Month', type: 'Time', isBaseUnit: true },
];

const PRODUCT_GROUPS = [
  { id: 'pg-serial', code: 'SER', name: 'Serial Device', behavior: 'STOCK_ITEM', sortOrder: 10, isSystem: false },
  { id: 'pg-consumable', code: 'CON', name: 'Consumable Item', behavior: 'CONSUMABLE', sortOrder: 20, isSystem: false },
  { id: 'pg-fixed', code: 'FA', name: 'Fixed Asset', behavior: 'FIXED_ASSET', sortOrder: 30, isSystem: false },
  // product_groups.behavior only allows STOCK_ITEM / CONSUMABLE / FIXED_ASSET,
  // so the service group carries STOCK_ITEM behaviour but its products are
  // QUANTITY_ONLY, priced per month, and never get an inventory_stock row.
  { id: 'pg-service', code: 'SVC', name: 'Service Item', behavior: 'STOCK_ITEM', sortOrder: 40, isSystem: false },
];

const CATEGORIES = [
  { id: 'cat-serial', code: 'SER', name: 'Serial Device', description: 'Devices tracked one row per serial.', isSpecialTracked: true },
  { id: 'cat-consumable', code: 'CON', name: 'Consumable', description: 'Cable, connectors and other quantity-only stock.', isSpecialTracked: false },
  { id: 'cat-fixed', code: 'FA', name: 'Fixed Asset', description: 'Capitalisable equipment held in branch stock.', isSpecialTracked: false },
  { id: 'cat-service', code: 'SVC', name: 'Service', description: 'Subscription and service plans — never stocked.', isSpecialTracked: false },
];

type StockProduct = {
  id: string; sku: string; name: string; category: string; productGroup: string;
  unit: string; trackingType: 'SERIAL_MAC_PON' | 'QUANTITY_ONLY'; requiresSerial: boolean;
  depreciation?: { method: string; rate: number; life: number };
};

/** 20 stocked products: 6 serial devices, 10 consumables, 4 fixed-asset units. */
export const STOCK_PRODUCTS: StockProduct[] = [
  { id: 'prd-onu-100', sku: 'ONU-100', name: 'ONU Router 1-Port GPON', category: 'Serial Device', productGroup: 'Serial Device', unit: 'Pcs', trackingType: 'SERIAL_MAC_PON', requiresSerial: true },
  { id: 'prd-onu-200', sku: 'ONU-200', name: 'ONU Router Dual-Band GPON', category: 'Serial Device', productGroup: 'Serial Device', unit: 'Pcs', trackingType: 'SERIAL_MAC_PON', requiresSerial: true },
  { id: 'prd-onu-300', sku: 'ONU-300', name: 'ONU Router XPON AC1200', category: 'Serial Device', productGroup: 'Serial Device', unit: 'Pcs', trackingType: 'SERIAL_MAC_PON', requiresSerial: true },
  { id: 'prd-rtr-100', sku: 'RTR-100', name: 'WiFi Router N300', category: 'Serial Device', productGroup: 'Serial Device', unit: 'Pcs', trackingType: 'SERIAL_MAC_PON', requiresSerial: true },
  { id: 'prd-rtr-200', sku: 'RTR-200', name: 'WiFi Router AC1200', category: 'Serial Device', productGroup: 'Serial Device', unit: 'Pcs', trackingType: 'SERIAL_MAC_PON', requiresSerial: true },
  { id: 'prd-swt-008', sku: 'SWT-008', name: '8-Port Gigabit Switch', category: 'Serial Device', productGroup: 'Serial Device', unit: 'Pcs', trackingType: 'SERIAL_MAC_PON', requiresSerial: true },

  { id: 'prd-cbl-drop', sku: 'CBL-DROP', name: 'Drop Cable 100m Roll', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Roll', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-cbl-patch', sku: 'CBL-PATCH', name: 'Patch Cord SC/APC 3m', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-spl-108', sku: 'SPL-108', name: 'PLC Splitter 1x8 SC/APC', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-spl-116', sku: 'SPL-116', name: 'PLC Splitter 1x16 SC/APC', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-con-fast', sku: 'CON-FAST', name: 'Fast Connector SC/UPC', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-adp-sc', sku: 'ADP-SC', name: 'SC/APC Adaptor', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-slp-60', sku: 'SLP-60', name: 'Fusion Protection Sleeve 60mm', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-cpl-sc', sku: 'CPL-SC', name: 'SC/APC Coupler', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-box-8p', sku: 'BOX-8P', name: '8-Port Distribution Box', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false },
  { id: 'prd-clp-100', sku: 'CLP-100', name: 'Cable Clip Pack (100 pcs)', category: 'Consumable', productGroup: 'Consumable Item', unit: 'Box', trackingType: 'QUANTITY_ONLY', requiresSerial: false },

  { id: 'prd-olt-16', sku: 'OLT-16', name: 'OLT Card GPON 16-Port', category: 'Fixed Asset', productGroup: 'Fixed Asset', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false, depreciation: { method: 'STRAIGHT_LINE', rate: 15, life: 5 } },
  { id: 'prd-ups-3k', sku: 'UPS-3K', name: 'Online UPS 3kVA', category: 'Fixed Asset', productGroup: 'Fixed Asset', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false, depreciation: { method: 'STRAIGHT_LINE', rate: 15, life: 5 } },
  { id: 'prd-swt-24', sku: 'SWT-24', name: '24-Port Managed Switch', category: 'Fixed Asset', productGroup: 'Fixed Asset', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false, depreciation: { method: 'STRAIGHT_LINE', rate: 15, life: 5 } },
  { id: 'prd-fus-spl', sku: 'FUS-SPL', name: 'Fiber Fusion Splicer', category: 'Fixed Asset', productGroup: 'Fixed Asset', unit: 'Pcs', trackingType: 'QUANTITY_ONLY', requiresSerial: false, depreciation: { method: 'STRAIGHT_LINE', rate: 15, life: 5 } },
];

/** 5 service plans in the "Service Item" group — priced per month, never stocked. */
export const SERVICE_PRODUCTS = [
  { id: 'prd-svc-80', sku: 'SVC-80', name: 'Unlimited 80Mbps', price: 900 },
  { id: 'prd-svc-150', sku: 'SVC-150', name: 'Unlimited 150Mbps', price: 1500 },
  { id: 'prd-svc-200', sku: 'SVC-200', name: 'Unlimited 200Mbps', price: 2000 },
  { id: 'prd-svc-static', sku: 'SVC-STATIC', name: 'Static IP Add-on', price: 500 },
  { id: 'prd-svc-router', sku: 'SVC-ROUTER', name: 'Router Rental', price: 200 },
];

const USERS = [
  { id: 'usr-super', email: 'superadmin@example.com', name: 'Super Admin', role: 'SUPER_ADMIN', branchId: 'BR-KTM', allBranches: true, canSwitchUser: true },
  { id: 'usr-ktm-manager', email: 'ktm.manager@example.com', name: 'Kathmandu Branch Manager', role: 'BRANCH_MANAGER', branchId: 'BR-KTM', allBranches: false, canSwitchUser: false },
  { id: 'usr-pkr-manager', email: 'pkr.manager@example.com', name: 'Pokhara Branch Manager', role: 'BRANCH_MANAGER', branchId: 'BR-PKR', allBranches: false, canSwitchUser: false },
  { id: 'usr-btl-manager', email: 'btl.manager@example.com', name: 'Butwal Branch Manager', role: 'BRANCH_MANAGER', branchId: 'BR-BTL', allBranches: false, canSwitchUser: false },
  { id: 'usr-dhn-manager', email: 'dhn.manager@example.com', name: 'Dharan Branch Manager', role: 'BRANCH_MANAGER', branchId: 'BR-DHN', allBranches: false, canSwitchUser: false },
  { id: 'usr-accountant', email: 'accountant@example.com', name: 'Head Office Accountant', role: 'ACCOUNTANT', branchId: 'BR-KTM', allBranches: true, canSwitchUser: false },
  { id: 'usr-inventory', email: 'inventory@example.com', name: 'Inventory Manager', role: 'INVENTORY_MANAGER', branchId: 'BR-KTM', allBranches: true, canSwitchUser: false },
  { id: 'usr-frontdesk', email: 'frontdesk@example.com', name: 'Front Desk', role: 'FRONT_DESK', branchId: 'BR-KTM', allBranches: false, canSwitchUser: false },
  { id: 'usr-auditor', email: 'auditor@example.com', name: 'Internal Auditor', role: 'AUDITOR', branchId: 'BR-KTM', allBranches: true, canSwitchUser: false },
];

const BILL_TERMS = [
  { id: 'bt-15', code: 'NET15', name: 'Net 15 days', dueDays: 15, discountDays: null, discountPercent: null },
  { id: 'bt-30', code: 'NET30', name: 'Net 30 days', dueDays: 30, discountDays: null, discountPercent: null },
  { id: 'bt-due', code: 'DUE', name: 'Due on receipt', dueDays: 0, discountDays: null, discountPercent: null },
];

/** The chart the ledger posts to: the app's default chart plus two accounts the
 *  verification brief needs (share capital and prepaid & deposits). The server's
 *  ensureDefaultChart() is idempotent by code, so it fills any defaults this
 *  list does not name without duplicating these. */
export const EXTRA_CHART_ACCOUNTS = [
  { code: '1400', name: 'Prepaid & Deposits', groupCode: '1000', description: 'Rent deposits and prepaid expenses.', isControl: false, subledgerType: 'NONE', postingRole: null },
  { code: '3010', name: 'Share Capital', groupCode: '3000', description: 'Capital introduced by the owners.', isControl: false, subledgerType: 'NONE', postingRole: null },
  { code: '4020', name: 'Service Revenue', groupCode: '4000', description: 'Internet subscription and service-plan revenue.', isControl: false, subledgerType: 'NONE', postingRole: null },
];

// ---------------------------------------------------------------------------
// Operations schedule (same dates in every branch, so the totals are easy to
// recompute by hand; only the ids and party names differ).
// ---------------------------------------------------------------------------

// Two bills in each fiscal year. The FY2 bills sit just before the first FY2
// sale so stock is never sold before it was bought (the 20 products map to the
// bills in order: bill 1-2 cover the FY1 sales, bill 3-4 the FY2 sales).
const PURCHASE_DATES = ['2025-08-05', '2025-10-12', '2026-07-18', '2026-07-19'];
const STOCK_SALE_DATES = ['2025-09-05', '2025-11-15', '2026-01-20', '2026-03-12', '2026-05-18', '2026-07-20', '2026-08-15', '2026-09-10', '2026-10-05', '2026-11-01'];
const SERVICE_SALES = [
  { date: '2025-07-25', amount: 900 },
  { date: '2025-10-25', amount: 900 },
  { date: '2026-01-25', amount: 900 },
  { date: '2026-04-25', amount: 1500 },
  { date: '2026-07-25', amount: 900 },
  { date: '2026-08-25', amount: 900 },
  { date: '2026-09-25', amount: 1500 },
  { date: '2026-10-25', amount: 1500 },
];
const RECEIPT_DATES = ['2025-10-05', '2026-01-15', '2026-04-20', '2026-10-10'];
const RECEIPT_AMOUNT = 2525;
const VENDOR_PAYMENTS = [
  { date: '2025-11-05', amount: 1500 },
  { date: '2026-03-05', amount: 1750 },
];
const EXPENSES = [
  { date: '2025-08-31', account: '6100', memo: 'Office rent — Bhadra 2082', amount: 1200 },
  { date: '2026-01-31', account: '6400', memo: 'Staff salary — Magh 2082', amount: 3600 },
  { date: '2026-09-30', account: '6100', memo: 'Office rent — Bhadra 2083', amount: 1200 },
  { date: '2026-10-31', account: '6400', memo: 'Staff salary — Kartik 2083', amount: 3600 },
];
const UNIT_FIXED_ASSETS = [
  { suffix: 'OFFICE', name: 'Office Furniture & Equipment', cost: 4000, category: 'Furniture' },
  { suffix: 'AC', name: 'Air Conditioner 1.5 Ton', cost: 2000, category: 'Fixtures' },
];

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface VerificationDataset {
  company: any;
  branches: any[];
  fiscalYears: any[];
  periods: any[];
  users: any[];
  uoms: any[];
  documentConfigs: any[];
  chartGroups: any[];
  chartAccounts: any[];
  billTerms: any[];
  areas: any[];
  agents: any[];
  locations: any[];
  productGroups: any[];
  categories: any[];
  products: any[];
  customers: any[];
  suppliers: any[];
  fixedAssets: any[];
  inventoryStock: any[];
  transactionLogs: any[];
  serialLogs: any[];
  purchaseInvoices: any[];
  salesInvoices: any[];
  customerPayments: any[];
  vendorPayments: any[];
  journals: any[];
  journalLines: any[];
  subledgerEntries: any[];
  targets: typeof TARGETS;
}

export function buildVerificationDataset(): VerificationDataset {
  const chartGroups = [...DEFAULT_CHART_GROUPS.map((g) => ({ ...g }))];
  const chartAccounts = [
    ...DEFAULT_CHART_ACCOUNTS.map((a) => ({ ...a })),
    ...EXTRA_CHART_ACCOUNTS.map((a) => ({ ...a })),
  ];

  const customers: any[] = [];
  const suppliers: any[] = [];
  const areas: any[] = [];
  const agents: any[] = [];
  const locations: any[] = [];

  for (const branch of BRANCHES) {
    for (let n = 1; n <= 2; n += 1) {
      areas.push({
        id: `area-${branch.code.toLowerCase()}-${n}`,
        code: `${branch.code}-A${n}`,
        name: `${branch.location} Zone ${n}`,
        parentId: null,
        branchId: branch.id,
        active: true,
        isDemo: true,
      });
    }
    agents.push({
      id: `agt-${branch.code.toLowerCase()}`,
      code: `${branch.code}-AG1`,
      name: `${branch.location} Sales Agent`,
      phone: `98020${String(BRANCHES.indexOf(branch)).padStart(5, '0')}`,
      email: `agent.${branch.code.toLowerCase()}@example.com`,
      areaId: areas[areas.length - 2].id,
      commissionRate: 2,
      active: true,
      isDemo: true,
    });
    locations.push({
      id: `loc-${branch.code.toLowerCase()}`,
      name: `${branch.name} — POP Server Room`,
      type: 'POP_SERVER_ROOM',
      branchId: branch.id,
      address: `${branch.location}, Nepal`,
      coordinates: { latitude: 0, longitude: 0 },
      contactPerson: `${branch.location} NOC`,
      contactPhone: branch.phone,
      notes: 'Verification dataset location.',
      activeAssetsCount: 0,
      isDemo: true,
    });

    for (let n = 1; n <= CUSTOMERS_PER_BRANCH; n += 1) {
      const nn = String(n).padStart(2, '0');
      // sales_invoices.customer_id REFERENCES customer_records(id), so the id
      // and the business code are the same string: either lookup resolves.
      customers.push({
        id: `CUS-${branch.code}-${nn}`,
        customerId: `CUS-${branch.code}-${nn}`,
        customerName: `${branch.location} Customer ${nn}`,
        username: `cust-${branch.code.toLowerCase()}-${nn}`,
        contactNumber: `98${String(BRANCHES.indexOf(branch) + 1)}${String(n).padStart(6, '0')}`,
        branchId: branch.id,
        address: `${branch.location} Ward ${((n - 1) % 10) + 1}, Nepal`,
        email: `customer.${nn}.${branch.code.toLowerCase()}@example.com`,
        status: 'ACTIVE',
        creditLimit: 5000,
        assignedDevicesCount: 0,
        billTermsId: BILL_TERMS[(n - 1) % BILL_TERMS.length].id,
        areaId: areas[areas.length - (n % 2 === 0 ? 1 : 2)].id,
        agentId: agents[agents.length - 1].id,
        isDemo: true,
      });
    }

    for (let n = 1; n <= VENDORS_PER_BRANCH; n += 1) {
      suppliers.push({
        id: `V-${branch.code}-${n}`,
        supplierCode: `V-${branch.code}-${n}`,
        name: `${branch.location} Vendor ${n}`,
        contactPerson: `${branch.location} Vendor ${n} Contact`,
        phone: `+977-1-${String(4000000 + BRANCHES.indexOf(branch) * 10 + n)}`,
        email: `vendor${n}.${branch.code.toLowerCase()}@example.com`,
        address: `${branch.location}, Nepal`,
        panVatNumber: `30${BRANCHES.indexOf(branch)}000${n}0`,
        rating: 4.5,
        status: 'ACTIVE',
        branchId: branch.id, // used to group vendors per branch; not a suppliers column
        billTermsId: BILL_TERMS[1].id,
        isDemo: true,
      });
    }
  }

  const products: any[] = [
    ...STOCK_PRODUCTS.map((p) => ({
      id: p.id,
      sku: p.sku,
      barcode: null,
      name: p.name,
      category: p.category,
      productGroup: p.productGroup,
      unit: p.unit,
      costPrice: UNIT_COST,
      sellingPrice: SELL_PRICE,
      taxRate: 0, // VAT stays out of the verification figures, so totals are exact
      minReorderLevel: TARGETS.piecesPerProductPerBranch,
      requiresSerialTracking: p.requiresSerial,
      trackingType: p.trackingType,
      description: `${p.productGroup} — verification dataset`,
      depreciationMethod: p.depreciation?.method ?? null,
      depreciationRate: p.depreciation?.rate ?? null,
      usefulLifeYears: p.depreciation?.life ?? null,
      status: 'ACTIVE',
      vendorWarrantyMonths: p.requiresSerial ? 12 : 0,
      sellerWarrantyMonths: p.requiresSerial ? 12 : 0,
      isDemo: true,
    })),
    ...SERVICE_PRODUCTS.map((p) => ({
      id: p.id,
      sku: p.sku,
      barcode: null,
      name: p.name,
      category: 'Service',
      productGroup: 'Service Item',
      unit: 'Month',
      costPrice: 0,
      sellingPrice: p.price,
      taxRate: 0,
      minReorderLevel: 0,
      requiresSerialTracking: false,
      trackingType: 'QUANTITY_ONLY',
      description: 'Service Item — billed per month, never stocked.',
      depreciationMethod: null,
      depreciationRate: null,
      usefulLifeYears: null,
      status: 'ACTIVE',
      vendorWarrantyMonths: 0,
      sellerWarrantyMonths: 0,
      isDemo: true,
    })),
  ];

  // ------------------------- stock, purchases, sales ----------------------
  const inventoryStock: any[] = [];
  const transactionLogs: any[] = [];
  const serialLogs: any[] = [];
  const purchaseInvoices: any[] = [];
  const salesInvoices: any[] = [];
  const fixedAssets: any[] = [];

  for (const branch of BRANCHES) {
    const branchProducts = STOCK_PRODUCTS;
    const branchSuppliers = suppliers.filter((s) => s.branchId === branch.id);
    const branchCustomers = customers.filter((c) => c.branchId === branch.id);
    const branchCode = branch.code.toLowerCase();

    // 4 purchase bills × 5 products × 7 pcs × 50 = 7,000 per branch.
    for (let bill = 0; bill < PURCHASE_DATES.length; bill += 1) {
      const date = PURCHASE_DATES[bill];
      const supplier = branchSuppliers[bill % branchSuppliers.length];
      const items = [] as any[];
      for (let offset = 0; offset < 5; offset += 1) {
        const product = branchProducts[bill * 5 + offset];
        items.push({
          id: `pii-${branchCode}-${bill + 1}-${offset + 1}`,
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          quantity: PURCHASED_PER_PRODUCT,
          unitPrice: UNIT_COST,
          taxRate: 0,
          subtotal: PURCHASED_PER_PRODUCT * UNIT_COST,
          taxAmount: 0,
          total: PURCHASED_PER_PRODUCT * UNIT_COST,
        });
      }
      const taxable = items.reduce((sum, i) => sum + i.subtotal, 0); // 1,750
      const invoiceId = `pi-${branchCode}-${bill + 1}`;
      purchaseInvoices.push({
        id: invoiceId,
        invoiceNumber: `PI-${branch.code}-${compact(date)}${String(bill + 1).padStart(4, '0')}`,
        poReferenceId: null,
        vendorBillNumber: `BILL-${branch.code}-${bill + 1}`,
        supplierId: supplier.id,
        supplierName: supplier.name,
        branchId: branch.id,
        invoiceDateAD: date,
        invoiceDateBS: bsLabel(date),
        dueDateAD: addDays(date, 15),
        dueDateBS: bsLabel(addDays(date, 15)),
        taxableAmount: taxable,
        vatAmount: 0,
        nonTaxableAmount: 0,
        grandTotal: taxable,
        paymentStatus: 'UNPAID',
        paymentMethod: 'CREDIT',
        amountPaid: 0,
        notes: 'Verification purchase bill (5 products × 7 pcs).',
        items,
        fiscalYearId: date <= FISCAL_YEARS[0].endDateAD ? FISCAL_YEARS[0].id : FISCAL_YEARS[1].id,
        billTermsId: BILL_TERMS[1].id,
        isDemo: true,
        createdBy: 'seed:verify',
      });
    }

    // 10 stock invoices × 2 products × 2 pcs × 90 = 3,600 per branch.
    for (let sale = 0; sale < STOCK_SALE_DATES.length; sale += 1) {
      const date = STOCK_SALE_DATES[sale];
      const customer = branchCustomers[sale]; // customers 1..10 buy hardware
      const items = [] as any[];
      for (let offset = 0; offset < 2; offset += 1) {
        const product = branchProducts[sale * 2 + offset];
        // The 2 sold units are the last two serials purchased for the product,
        // so the serial register and the invoice name the same hardware.
        const serialNumbers = product.requiresSerial
          ? Array.from({ length: SOLD_PER_PRODUCT }, (_, unit) =>
              `SN-${product.sku}-${branch.code}-${String(PURCHASED_PER_PRODUCT - SOLD_PER_PRODUCT + unit + 1).padStart(2, '0')}`
            )
          : [];
        items.push({
          id: `sii-${branchCode}-${sale + 1}-${offset + 1}`,
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          quantity: SOLD_PER_PRODUCT,
          unitPrice: SELL_PRICE,
          taxRate: 0,
          subtotal: SOLD_PER_PRODUCT * SELL_PRICE,
          taxAmount: 0,
          total: SOLD_PER_PRODUCT * SELL_PRICE,
          serialNumbers,
        });
      }
      const taxable = items.reduce((sum, i) => sum + i.subtotal, 0); // 360
      salesInvoices.push({
        id: `si-${branchCode}-${sale + 1}`,
        invoiceNumber: `INV-${branch.code}-${compact(date)}${String(sale + 1).padStart(4, '0')}`,
        customerId: customer.customerId,
        customerName: customer.customerName,
        branchId: branch.id,
        invoiceDateAD: date,
        invoiceDateBS: bsLabel(date),
        dueDateAD: addDays(date, 15),
        dueDateBS: bsLabel(addDays(date, 15)),
        taxableAmount: taxable,
        vatAmount: 0,
        nonTaxableAmount: 0,
        grandTotal: taxable,
        paymentStatus: 'UNPAID',
        paymentMethod: 'CASH',
        amountPaid: 0,
        notes: 'Verification hardware sale (2 products × 2 pcs).',
        items,
        fiscalYearId: date <= FISCAL_YEARS[0].endDateAD ? FISCAL_YEARS[0].id : FISCAL_YEARS[1].id,
        status: 'POSTED',
        billTermsId: customer.billTermsId,
        areaId: customer.areaId,
        areaName: areas.find((a) => a.id === customer.areaId)?.name ?? null,
        agentId: customer.agentId,
        agentName: agents.find((a) => a.id === customer.agentId)?.name ?? null,
        isDemo: true,
        createdBy: 'seed:verify',
      });
    }

    // 8 service invoices per branch: 5 × 900 + 3 × 1,500 = 9,000, no stock.
    SERVICE_SALES.forEach((sale, idx) => {
      const plan = sale.amount === 900 ? SERVICE_PRODUCTS[0] : SERVICE_PRODUCTS[1];
      const customer = branchCustomers[10 + (idx % 8)]; // customers 11..18 subscribe
      salesInvoices.push({
        id: `si-${branchCode}-svc-${idx + 1}`,
        invoiceNumber: `INV-${branch.code}-${compact(sale.date)}${String(100 + idx).padStart(4, '0')}`,
        customerId: customer.customerId,
        customerName: customer.customerName,
        branchId: branch.id,
        invoiceDateAD: sale.date,
        invoiceDateBS: bsLabel(sale.date),
        dueDateAD: sale.date,
        dueDateBS: bsLabel(sale.date),
        taxableAmount: sale.amount,
        vatAmount: 0,
        nonTaxableAmount: 0,
        grandTotal: sale.amount,
        paymentStatus: 'UNPAID',
        paymentMethod: 'CASH',
        amountPaid: 0,
        notes: `Verification subscription — ${plan.name}.`,
        items: [
          {
            id: `sii-${branchCode}-svc-${idx + 1}`,
            productId: plan.id,
            productName: plan.name,
            sku: plan.sku,
            quantity: 1,
            unitPrice: sale.amount,
            taxRate: 0,
            subtotal: sale.amount,
            taxAmount: 0,
            total: sale.amount,
            serialNumbers: [],
          },
        ],
        fiscalYearId: sale.date <= FISCAL_YEARS[0].endDateAD ? FISCAL_YEARS[0].id : FISCAL_YEARS[1].id,
        status: 'POSTED',
        billTermsId: customer.billTermsId,
        areaId: customer.areaId,
        areaName: areas.find((a) => a.id === customer.areaId)?.name ?? null,
        agentId: customer.agentId,
        agentName: agents.find((a) => a.id === customer.agentId)?.name ?? null,
        isDemo: true,
        createdBy: 'seed:verify',
      });
    });

    // Inventory: exactly 5 pcs of every stock product (service plans get none).
    for (const product of branchProducts) {
      inventoryStock.push({
        id: `stk-${branchCode}-${product.id}`,
        productId: product.id,
        branchId: branch.id,
        quantityOnHand: TARGETS.piecesPerProductPerBranch,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: TARGETS.piecesPerProductPerBranch,
        averageCost: UNIT_COST,
        isDemo: true,
        createdBy: 'seed:verify',
      });

      const purchaseDate = PURCHASE_DATES[Math.floor(branchProducts.indexOf(product) / 5)];
      const saleDate = STOCK_SALE_DATES[Math.floor(branchProducts.indexOf(product) / 2)];
      transactionLogs.push({
        id: `txn-${branchCode}-${product.id}-in`,
        transactionNumber: `TXN-${branch.code}-IN-${product.sku}`,
        productId: product.id,
        productSku: product.sku,
        productName: product.name,
        branchId: branch.id,
        changeType: 'PURCHASE_INVOICE',
        quantityBefore: 0,
        quantityChanged: PURCHASED_PER_PRODUCT,
        quantityAfter: PURCHASED_PER_PRODUCT,
        unitCost: UNIT_COST,
        referenceDocId: `pi-${branchCode}-${Math.floor(branchProducts.indexOf(product) / 5) + 1}`,
        timestampAD: `${purchaseDate}T10:00:00Z`,
        timestampBS: bsLabel(purchaseDate),
        fiscalYearId: purchaseDate <= FISCAL_YEARS[0].endDateAD ? FISCAL_YEARS[0].id : FISCAL_YEARS[1].id,
        isDemo: true,
        createdBy: 'seed:verify',
      });
      transactionLogs.push({
        id: `txn-${branchCode}-${product.id}-out`,
        transactionNumber: `TXN-${branch.code}-OUT-${product.sku}`,
        productId: product.id,
        productSku: product.sku,
        productName: product.name,
        branchId: branch.id,
        changeType: 'SALES_INVOICE',
        quantityBefore: PURCHASED_PER_PRODUCT,
        quantityChanged: -SOLD_PER_PRODUCT,
        quantityAfter: PURCHASED_PER_PRODUCT - SOLD_PER_PRODUCT,
        unitCost: UNIT_COST,
        referenceDocId: `si-${branchCode}-${Math.floor(branchProducts.indexOf(product) / 2) + 1}`,
        timestampAD: `${saleDate}T12:00:00Z`,
        timestampBS: bsLabel(saleDate),
        fiscalYearId: saleDate <= FISCAL_YEARS[0].endDateAD ? FISCAL_YEARS[0].id : FISCAL_YEARS[1].id,
        isDemo: true,
        createdBy: 'seed:verify',
      });

      if (product.requiresSerial) {
        const sale = salesInvoices.find(
          (inv) => inv.branchId === branch.id && inv.items.some((item: any) => item.productId === product.id && item.serialNumbers.length)
        );
        const soldSerials = new Set<string>(
          sale ? sale.items.flatMap((item: any) => item.serialNumbers) : []
        );
        for (let unit = 1; unit <= PURCHASED_PER_PRODUCT; unit += 1) {
          const serial = `SN-${product.sku}-${branch.code}-${String(unit).padStart(2, '0')}`;
          const isSold = soldSerials.has(serial);
          serialLogs.push({
            id: `sl-${branchCode}-${product.sku}-${unit}`,
            deviceSerial: serial,
            ponSerial: `PON-${serial}`,
            macAddress: `HWTC-${compact(branch.code + product.sku).slice(0, 4)}${String(unit).padStart(4, '0')}`,
            productId: product.id,
            productName: product.name,
            branchId: branch.id,
            customerId: isSold ? sale.customerId : null,
            customerName: isSold ? sale.customerName : null,
            status: isSold ? 'SOLD' : 'IN_STOCK',
            sourceType: isSold ? 'SALE' : 'PURCHASE',
            sourceId: isSold ? sale.id : `pi-${branchCode}-${Math.floor(branchProducts.indexOf(product) / 5) + 1}`,
            history: isSold
              ? [{ status: 'IN_STOCK', sourceType: 'PURCHASE', dateAD: purchaseDate }, { status: 'SOLD', sourceType: 'SALE', dateAD: sale.invoiceDateAD }]
              : [{ status: 'IN_STOCK', sourceType: 'PURCHASE', dateAD: purchaseDate }],
            fiscalYearId: purchaseDate <= FISCAL_YEARS[0].endDateAD ? FISCAL_YEARS[0].id : FISCAL_YEARS[1].id,
            isDemo: true,
            createdBy: 'seed:verify',
          });
        }
      }
    }

    // Two capitalised assets per branch = 6,000, matching the opening entry.
    UNIT_FIXED_ASSETS.forEach((item, idx) => {
      const acquiredOn = '2025-08-01';
      fixedAssets.push({
        id: `fa-${branchCode}-${idx + 1}`,
        tagNumber: `FA-${branch.code}-${String(idx + 1).padStart(3, '0')}`,
        name: item.name,
        category: item.category,
        branchId: branch.id,
        acquisitionDateAD: acquiredOn,
        acquisitionDateBS: bsLabel(acquiredOn),
        purchaseInvoiceDateAD: acquiredOn,
        purchaseInvoiceDateBS: bsLabel(acquiredOn),
        capitalizationDateAD: acquiredOn,
        placedInServiceDateAD: acquiredOn,
        acquisitionCost: item.cost,
        depreciationMethod: 'STRAIGHT_LINE',
        depreciationRatePercent: 15,
        accumulatedDepreciation: 0,
        netBookValue: item.cost,
        status: 'ACTIVE',
        supplierName: null,
        invoiceNo: null,
        productId: null,
        fiscalYearId: FISCAL_YEARS[0].id,
        isDemo: true,
        createdBy: 'seed:verify',
      });
    });
  }

  // ------------------------- FIFO settlement ------------------------------
  const customerPayments: any[] = [];
  const vendorPayments: any[] = [];

  for (const branch of BRANCHES) {
    const branchCode = branch.code.toLowerCase();
    const branchSales = salesInvoices
      .filter((inv) => inv.branchId === branch.id)
      .sort((a, b) => a.invoiceDateAD.localeCompare(b.invoiceDateAD) || a.invoiceNumber.localeCompare(b.invoiceNumber));
    let cursor = 0;
    let outstanding = branchSales[0] ? branchSales[0].grandTotal : 0;
    RECEIPT_DATES.forEach((date, idx) => {
      let remaining = RECEIPT_AMOUNT;
      const firstInvoice = branchSales[cursor];
      while (remaining > 0 && cursor < branchSales.length) {
        const invoice = branchSales[cursor];
        const applied = Math.min(remaining, outstanding);
        invoice.amountPaid += applied;
        remaining -= applied;
        outstanding -= applied;
        if (outstanding <= 0) {
          cursor += 1;
          outstanding = branchSales[cursor] ? branchSales[cursor].grandTotal : 0;
        }
      }
      customerPayments.push({
        id: `cp-${branchCode}-${idx + 1}`,
        paymentNumber: `CR-${branch.code}-${compact(date)}${String(idx + 1).padStart(4, '0')}`,
        customerId: firstInvoice.customerId,
        customerName: firstInvoice.customerName,
        branchId: branch.id,
        invoiceId: firstInvoice.id,
        invoiceNumber: firstInvoice.invoiceNumber,
        paymentDateAD: date,
        paymentDateBS: bsLabel(date),
        amount: RECEIPT_AMOUNT,
        paymentMethod: idx % 2 === 0 ? 'CASH' : 'BANK_TRANSFER',
        notes: 'Verification customer receipt (allocated FIFO).',
        status: 'POSTED',
        fiscalYearId: date <= FISCAL_YEARS[0].endDateAD ? FISCAL_YEARS[0].id : FISCAL_YEARS[1].id,
        isDemo: true,
        createdBy: 'seed:verify',
      });
    });

    const branchPurchases = purchaseInvoices
      .filter((inv) => inv.branchId === branch.id)
      .sort((a, b) => a.invoiceDateAD.localeCompare(b.invoiceDateAD) || a.invoiceNumber.localeCompare(b.invoiceNumber));
    let purchaseCursor = 0;
    let purchaseOutstanding = branchPurchases[0] ? branchPurchases[0].grandTotal : 0;
    VENDOR_PAYMENTS.forEach((payment, idx) => {
      let remaining = payment.amount;
      const firstInvoice = branchPurchases[purchaseCursor];
      while (remaining > 0 && purchaseCursor < branchPurchases.length) {
        const invoice = branchPurchases[purchaseCursor];
        const applied = Math.min(remaining, purchaseOutstanding);
        invoice.amountPaid += applied;
        remaining -= applied;
        purchaseOutstanding -= applied;
        if (purchaseOutstanding <= 0) {
          purchaseCursor += 1;
          purchaseOutstanding = branchPurchases[purchaseCursor] ? branchPurchases[purchaseCursor].grandTotal : 0;
        }
      }
      vendorPayments.push({
        id: `vp-${branchCode}-${idx + 1}`,
        paymentNumber: `BP-${branch.code}-${compact(payment.date)}${String(idx + 1).padStart(4, '0')}`,
        supplierId: firstInvoice.supplierId,
        supplierName: firstInvoice.supplierName,
        branchId: branch.id,
        invoiceId: firstInvoice.id,
        invoiceNumber: firstInvoice.invoiceNumber,
        paymentDateAD: payment.date,
        paymentDateBS: bsLabel(payment.date),
        amount: payment.amount,
        paymentMethod: 'BANK_TRANSFER',
        notes: 'Verification vendor payment (allocated FIFO).',
        status: 'POSTED',
        fiscalYearId: payment.date <= FISCAL_YEARS[0].endDateAD ? FISCAL_YEARS[0].id : FISCAL_YEARS[1].id,
        isDemo: true,
        createdBy: 'seed:verify',
      });
    });
  }

  for (const invoice of [...purchaseInvoices, ...salesInvoices]) {
    invoice.paymentStatus = invoice.amountPaid <= 0 ? 'UNPAID' : invoice.amountPaid >= invoice.grandTotal ? 'PAID' : 'PARTIAL';
  }

  // ------------------------- ledger ---------------------------------------
  const periods = [] as any[];
  for (const fy of FISCAL_YEARS) {
    let cursorDate = new Date(`${fy.startDateAD}T00:00:00Z`);
    const end = new Date(`${fy.endDateAD}T00:00:00Z`);
    while (cursorDate <= end) {
      const year = cursorDate.getUTCFullYear();
      const month = cursorDate.getUTCMonth() + 1;
      const periodKey = `${year}-${String(month).padStart(2, '0')}`;
      const startDate = `${periodKey}-01`;
      const endDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      periods.push({
        // Not the app's `glp-` prefix: suites that clean up "their" glp-
        // period for a month (tests/accounting.api.test.ts) delete by
        // `period_key` + `id LIKE 'glp-%'`, and the seeded journals that live
        // in that month would make that DELETE hit the journals RESTRICT FK.
        id: `vfy-period-${fy.id}-${periodKey}`,
        fiscalYearId: fy.id,
        periodKey,
        startDateAD: startDate,
        endDateAD: endDate < fy.startDateAD ? fy.startDateAD : endDate > fy.endDateAD ? fy.endDateAD : endDate,
        status: 'OPEN',
      });
      cursorDate = new Date(Date.UTC(year, month, 1));
    }
  }
  const periodFor = (date: string) => periods.find((p) => date >= p.startDateAD && date <= p.endDateAD)!;
  const fiscalYearFor = (date: string) => FISCAL_YEARS.find((fy) => date >= fy.startDateAD && date <= fy.endDateAD)!;

  const journals: any[] = [];
  const journalLines: any[] = [];
  const subledgerEntries: any[] = [];
  let journalSeq = 0;
  let lineSeq = 0;
  let subSeq = 0;

  const post = (args: {
    branchId: string;
    date: string;
    sourceType: string;
    sourceId: string | null;
    memo: string;
    lines: { code: string; debit?: number; credit?: number; memo?: string; partyId?: string; partyName?: string }[];
  }) => {
    journalSeq += 1;
    const fy = fiscalYearFor(args.date);
    const period = periodFor(args.date);
    const journalId = `glj-${String(journalSeq).padStart(5, '0')}`;
    const journalNo = `JV-${BRANCHES.find((b) => b.id === args.branchId)!.code}-${compact(args.date)}${String(journalSeq).padStart(4, '0')}`;
    journals.push({
      id: journalId,
      journalNo,
      journalDateAD: args.date,
      fiscalYearId: fy.id,
      periodId: period.id,
      branchId: args.branchId,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      memo: args.memo,
      status: 'POSTED',
      postedBy: 'seed:verify',
      isDemo: true,
    });
    args.lines.forEach((line) => {
      lineSeq += 1;
      const lineId = `gll-${String(lineSeq).padStart(6, '0')}`;
      journalLines.push({
        id: lineId,
        journalId,
        lineNo: lineSeq,
        accountCode: line.code,
        branchId: args.branchId,
        debit: line.debit ?? 0,
        credit: line.credit ?? 0,
        memo: line.memo ?? args.memo,
      });
      if (line.partyId) {
        subSeq += 1;
        const account = chartAccounts.find((a) => a.code === line.code)!;
        subledgerEntries.push({
          id: `gls-${String(subSeq).padStart(6, '0')}`,
          journalId,
          journalLineId: lineId,
          accountCode: line.code,
          subledgerType: account.subledgerType,
          partyId: line.partyId,
          partyName: line.partyName,
          branchId: args.branchId,
          entryDateAD: args.date,
          debit: line.debit ?? 0,
          credit: line.credit ?? 0,
        });
      }
    });
  };

  for (const branch of BRANCHES) {
    // Opening position: 12,500 capital = 5,250 cash + 1,250 prepaid + 6,000 assets.
    post({
      branchId: branch.id,
      date: '2025-07-17',
      sourceType: 'OPENING',
      sourceId: null,
      memo: 'Opening balance — Shrawan 1, 2082',
      lines: [
        { code: '1010', debit: 5250, memo: 'Opening cash' },
        { code: '1400', debit: 1250, memo: 'Office rent deposit' },
        { code: '1520', debit: 6000, memo: 'Office furniture and air conditioner' },
        { code: '3010', credit: 12500, memo: 'Capital introduced' },
      ],
    });

    purchaseInvoices.filter((inv) => inv.branchId === branch.id).forEach((invoice) => {
      post({
        branchId: branch.id,
        date: invoice.invoiceDateAD,
        sourceType: 'PURCHASE_INVOICE',
        sourceId: invoice.id,
        memo: `Purchase bill ${invoice.invoiceNumber} — ${invoice.supplierName}`,
        lines: [
          { code: '1200', debit: invoice.grandTotal, memo: 'Stock received' },
          { code: '2100', credit: invoice.grandTotal, memo: 'Vendor payable', partyId: invoice.supplierId, partyName: invoice.supplierName },
        ],
      });
    });

    salesInvoices.filter((inv) => inv.branchId === branch.id).forEach((invoice) => {
      const isService = invoice.items.every((item: any) => SERVICE_PRODUCTS.some((p) => p.id === item.productId));
      const revenueCode = isService ? '4020' : '4000';
      post({
        branchId: branch.id,
        date: invoice.invoiceDateAD,
        sourceType: 'SALES_INVOICE',
        sourceId: invoice.id,
        memo: `Sales invoice ${invoice.invoiceNumber} — ${invoice.customerName}`,
        lines: [
          { code: '1100', debit: invoice.grandTotal, memo: 'Customer receivable', partyId: invoice.customerId, partyName: invoice.customerName },
          { code: revenueCode, credit: invoice.grandTotal, memo: isService ? 'Service revenue' : 'Hardware revenue' },
        ],
      });
      if (!isService) {
        const cogs = invoice.items.reduce((sum: number, item: any) => sum + item.quantity * UNIT_COST, 0);
        post({
          branchId: branch.id,
          date: invoice.invoiceDateAD,
          sourceType: 'COGS',
          sourceId: invoice.id,
          memo: `Cost of goods sold — ${invoice.invoiceNumber}`,
          lines: [
            { code: '5000', debit: cogs, memo: 'Cost of goods sold' },
            { code: '1200', credit: cogs, memo: 'Stock issued' },
          ],
        });
      }
    });

    customerPayments.filter((p) => p.branchId === branch.id).forEach((payment) => {
      post({
        branchId: branch.id,
        date: payment.paymentDateAD,
        sourceType: 'CUSTOMER_RECEIPT',
        sourceId: payment.id,
        memo: `Customer receipt ${payment.paymentNumber}`,
        lines: [
          { code: '1020', debit: payment.amount, memo: 'Bank deposit' },
          { code: '1100', credit: payment.amount, memo: 'Receivable settled', partyId: payment.customerId, partyName: payment.customerName },
        ],
      });
    });

    vendorPayments.filter((p) => p.branchId === branch.id).forEach((payment) => {
      post({
        branchId: branch.id,
        date: payment.paymentDateAD,
        sourceType: 'VENDOR_PAYMENT',
        sourceId: payment.id,
        memo: `Vendor payment ${payment.paymentNumber}`,
        lines: [
          { code: '2100', debit: payment.amount, memo: 'Payable settled', partyId: payment.supplierId, partyName: payment.supplierName },
          { code: '1020', credit: payment.amount, memo: 'Bank payment' },
        ],
      });
    });

    EXPENSES.forEach((expense) => {
      post({
        branchId: branch.id,
        date: expense.date,
        sourceType: 'EXPENSE',
        sourceId: null,
        memo: expense.memo,
        lines: [
          { code: expense.account, debit: expense.amount, memo: expense.memo },
          { code: '1020', credit: expense.amount, memo: 'Paid from bank' },
        ],
      });
    });
  }

  return {
    company: {
      id: 'COMP-001',
      name: 'Example Fiber ISP',
      legalName: 'Example Fiber ISP Pvt. Ltd.',
      tagline: 'Verification dataset',
      address: 'Kathmandu, Nepal',
      city: 'Kathmandu',
      country: 'Nepal',
      phone: '+977-1-4000000',
      email: 'info@example.com',
      panVatNumber: '300000000',
      currencySymbol: 'NPR',
      currencyCode: 'NPR',
      currencyLocale: 'en-IN',
      currencyPosition: 'before',
      currencyDecimals: 2,
      defaultTaxRate: 0,
      notes: 'Seeded by scripts/seed_verification_data.ts for application verification.',
    },
    branches: BRANCHES.map((b) => ({ ...b, active: true, allowProcurement: true, allowWarehouseTransfer: true, isDemo: true })),
    fiscalYears: FISCAL_YEARS.map((fy) => ({ ...fy, isClosed: false, isProvisional: false, isDemo: true })),
    periods,
    users: USERS.map((u) => ({
      ...u,
      allowedBranchIds: u.allBranches ? BRANCHES.map((b) => b.id) : [u.branchId],
      status: 'active',
      isDemo: true,
    })),
    uoms: UOMS,
    documentConfigs: INITIAL_DOCUMENT_NUMBER_CONFIGS.map((c) => ({ ...c })),
    chartGroups,
    chartAccounts,
    billTerms: BILL_TERMS.map((b) => ({ ...b, active: true, isDemo: true })),
    areas,
    agents,
    locations,
    productGroups: PRODUCT_GROUPS.map((g) => ({ ...g, active: true, isDemo: true })),
    categories: CATEGORIES.map((c) => ({ ...c, isDemo: true })),
    products,
    customers,
    suppliers,
    fixedAssets,
    inventoryStock,
    transactionLogs,
    serialLogs,
    purchaseInvoices,
    salesInvoices,
    customerPayments,
    vendorPayments,
    journals,
    journalLines,
    subledgerEntries,
    targets: TARGETS,
  };
}

/** Human-readable unit checks the brief asks for; the seeder throws on any miss. */
export function checkDatasetInvariants(dataset: VerificationDataset): string[] {
  const errors: string[] = [];
  const stockProducts = dataset.products.filter((p) => p.productGroup !== 'Service Item');

  for (const branch of dataset.branches) {
    const branchStock = dataset.inventoryStock.filter((s) => s.branchId === branch.id);
    if (branchStock.length !== stockProducts.length) {
      errors.push(`${branch.code}: ${branchStock.length} stock rows, expected ${stockProducts.length}`);
    }
    for (const row of branchStock) {
      if (row.quantityOnHand !== TARGETS.piecesPerProductPerBranch) {
        errors.push(`${branch.code}/${row.productId}: ${row.quantityOnHand} pcs, expected ${TARGETS.piecesPerProductPerBranch}`);
      }
      if (row.averageCost >= TARGETS.maxUnitCost) {
        errors.push(`${branch.code}/${row.productId}: cost ${row.averageCost} is not below ${TARGETS.maxUnitCost}`);
      }
    }
    const customersInBranch = dataset.customers.filter((c) => c.branchId === branch.id);
    if (customersInBranch.length !== CUSTOMERS_PER_BRANCH) {
      errors.push(`${branch.code}: ${customersInBranch.length} customers, expected ${CUSTOMERS_PER_BRANCH}`);
    }
    const serviceStock = dataset.inventoryStock.filter(
      (s) => s.branchId === branch.id && dataset.products.find((p) => p.id === s.productId)?.productGroup === 'Service Item'
    );
    if (serviceStock.length > 0) errors.push(`${branch.code}: service items must not hold stock`);
  }

  if (dataset.branches.length !== BRANCH_COUNT) errors.push(`${dataset.branches.length} branches, expected ${BRANCH_COUNT}`);
  if (dataset.fiscalYears.length !== 2) errors.push(`${dataset.fiscalYears.length} fiscal years, expected exactly 2`);

  // The ledger must balance, per branch and overall.
  const byBranch = new Map<string, number>();
  for (const line of dataset.journalLines) {
    const delta = (line.debit || 0) - (line.credit || 0);
    byBranch.set(line.branchId, (byBranch.get(line.branchId) || 0) + delta);
  }
  for (const [branchId, delta] of byBranch) {
    if (Math.abs(delta) > 0.005) errors.push(`${branchId}: journal lines are off by ${delta}`);
  }

  // ...and land on the figures the brief names.
  const balance = (code: string) =>
    dataset.journalLines
      .filter((line) => line.accountCode === code)
      .reduce((sum, line) => sum + (line.debit || 0) - (line.credit || 0), 0);
  const actual = {
    accountsReceivable: balance('1100'),
    accountsPayable: -balance('2100'),
    inventory: balance('1200'),
    cashAndBank: balance('1010') + balance('1020'),
    equity: -balance('3010'),
    fixedAssets: balance('1520'),
    prepaid: balance('1400'),
  };
  const expected: Record<string, number> = {
    accountsReceivable: TARGETS.accountsReceivable,
    accountsPayable: TARGETS.accountsPayable,
    inventory: TARGETS.inventory,
    cashAndBank: TARGETS.cashAndBank,
    equity: TARGETS.equity,
    fixedAssets: TARGETS.fixedAssets,
    prepaid: TARGETS.prepaid,
  };
  for (const key of Object.keys(expected)) {
    if (Math.abs((actual as any)[key] - expected[key]) > 0.005) {
      errors.push(`${key}: ledger shows ${(actual as any)[key]}, target ${expected[key]}`);
    }
  }
  return errors;
}
