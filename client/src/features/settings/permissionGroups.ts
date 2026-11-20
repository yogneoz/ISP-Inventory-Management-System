/**
 * The permission catalogue shared by the role matrix, the per-user editor and
 * the user-management filters. Kept out of the lazy Permission Management
 * screen so importing the catalogue cannot pull that whole screen into the
 * startup bundle.
 */
import type { ElementType } from 'react';
import {
  ShoppingBag,
  Warehouse,
  ArrowRightLeft,
  Package,
  Building,
  Landmark,
  Users,
  Briefcase,
  ShieldCheck,
} from 'lucide-react';
import { DEFAULT_PERMISSIONS_MATRIX } from '../../utils/permissionMatrixData';

/** Shared with the per-user exception editor so both screens name operations identically. */
export interface PermissionOperation {
  id: string;
  operationName: string;
  description: string;
  permissions: Record<string, boolean>;
}

export interface PermissionGroup {
  id: string;
  category: string;
  icon: ElementType;
  color: string;
  bgColor: string;
  borderColor: string;
  description: string;
  operations: PermissionOperation[];
}

export const DEFAULT_GROUPS: PermissionGroup[] = [
  {
    id: 'procurement',
    category: 'Procurement & Purchasing',
    icon: ShoppingBag,
    color: 'text-amber-600 dark:text-amber-400',
    bgColor: 'bg-amber-50 dark:bg-amber-950/30',
    borderColor: 'border-amber-200 dark:border-amber-900',
    description: 'Purchase orders, vendor inbound stock receiving, and procurement permissions control',
    operations: [
      {
        id: 'po-create',
        operationName: 'Create Purchase Orders (PO)',
        description: 'Generate multi-item purchase orders to suppliers and vendors',
        permissions: DEFAULT_PERMISSIONS_MATRIX['po-create'],
      },
      {
        id: 'po-receive',
        operationName: 'Receive Inbound PO Stock',
        description: 'Accept stock deliveries from vendors and update branch inventory on hand',
        permissions: DEFAULT_PERMISSIONS_MATRIX['po-receive'],
      },
      {
        id: 'branch-procurement-control',
        operationName: 'Branch Procurement Permission Control',
        description: 'Enable or disable procurement and purchasing capabilities per branch',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-procurement-control'],
      },
      {
        id: 'inv-create',
        operationName: 'Record Purchase Tax Invoices',
        description: 'Entry of vendor bills with bill-wise VAT taxation and credit tracking',
        permissions: DEFAULT_PERMISSIONS_MATRIX['inv-create'],
      },
      {
        id: 'inv-pay',
        operationName: 'Process Vendor Payment Settlements',
        description: 'Record credit settlements, bank transfers, and partial invoice payments',
        permissions: DEFAULT_PERMISSIONS_MATRIX['inv-pay'],
      },
      {
        id: 'purchase-return-create',
        operationName: 'Create Purchase Returns',
        description: 'Raise, post and cancel supplier returns (debit notes) against received bills, reversing stock, payable and input VAT in one transaction',
        permissions: DEFAULT_PERMISSIONS_MATRIX['purchase-return-create'],
      },
      {
        id: 'po-delete',
        operationName: 'Delete Purchase Orders (PO)',
        description: 'Delete eligible purchase orders and reverse outstanding incoming quantities',
        permissions: DEFAULT_PERMISSIONS_MATRIX['po-delete'],
      },
      {
        id: 'inv-delete',
        operationName: 'Delete Purchase Invoices (PI)',
        description: 'Delete eligible purchase invoices and reverse their inventory entries',
        permissions: DEFAULT_PERMISSIONS_MATRIX['inv-delete'],
      },
    ],
  },
  {
    id: 'warehouse',
    category: 'Warehouse Logistics & Dispatch',
    icon: Warehouse,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-950/30',
    borderColor: 'border-blue-200 dark:border-blue-900',
    description: 'Central warehouse shipment dispatch, pullout receiving, and transfer tracking',
    operations: [
      {
        id: 'shipment-create',
        operationName: 'Create Warehouse Shipment Dispatch',
        description: 'Dispatch stock shipments from Central HQ Warehouse to regional branches',
        permissions: DEFAULT_PERMISSIONS_MATRIX['shipment-create'],
      },
      {
        id: 'shipment-cancel',
        operationName: 'Cancel Outbound Shipment',
        description: 'Cancel an in-transit warehouse dispatch before the destination branch receives it, restoring the source stock',
        permissions: DEFAULT_PERMISSIONS_MATRIX['shipment-cancel'],
      },
      {
        id: 'wh-receive-pullouts',
        operationName: 'Receive Branch Stock Pullouts',
        description: 'Receive overstock or damaged stock pullouts sent back from branch stores',
        permissions: DEFAULT_PERMISSIONS_MATRIX['wh-receive-pullouts'],
      },
      {
        id: 'wh-restrict-transfer',
        operationName: 'Warehouse Transfer Restriction Rule',
        description: 'Issue inter-branch transfers from the central warehouse; destinations limited to branches with warehouse-transfer receiving enabled',
        permissions: DEFAULT_PERMISSIONS_MATRIX['wh-restrict-transfer'],
      },
      {
        id: 'shipment-history',
        operationName: 'View Shipment & Dispatch History',
        description: 'Audit shipment transfer codes, tracking logs, and in-transit statuses',
        permissions: DEFAULT_PERMISSIONS_MATRIX['shipment-history'],
      },
      {
        id: 'pullout-report-view',
        operationName: 'View Warehouse Pullout Report',
        description: 'Read-only branch register of pullout bins dispatched to HQ with their receiving status',
        permissions: DEFAULT_PERMISSIONS_MATRIX['pullout-report-view'],
      },
    ],
  },
  {
    id: 'branch-ops',
    category: 'Sales & Branch Operations',
    icon: ArrowRightLeft,
    color: 'text-indigo-600 dark:text-indigo-400',
    bgColor: 'bg-indigo-50 dark:bg-indigo-950/30',
    borderColor: 'border-indigo-200 dark:border-indigo-900',
    description: 'Customer sales invoices and returns, inter-store transfers with serial tracking, stock pullouts, damage labeling, stock issues and branch assets',
    operations: [
      {
        id: 'sales-invoice-create',
        operationName: 'Create Sales Invoices',
        description: 'Issue, print and void customer tax invoices, and record or reverse customer payments',
        permissions: DEFAULT_PERMISSIONS_MATRIX['sales-invoice-create'],
      },
      {
        id: 'sales-return-create',
        operationName: 'Create Sales Returns',
        description: 'Raise, post and cancel customer sales returns, restoring the returned stock and customer balance',
        permissions: DEFAULT_PERMISSIONS_MATRIX['sales-return-create'],
      },
      {
        id: 'branch-transfer-create',
        operationName: 'Create Inter-Branch Stock Transfer',
        description: 'Initiate stock transfers between store branches with serial tracking intact',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-transfer-create'],
      },
      {
        id: 'branch-transfer-receive',
        operationName: 'Receive Inter-Branch Stock Transfer',
        description: 'Acknowledge received stock transfers sent from another branch store',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-transfer-receive'],
      },
      {
        id: 'branch-transfer-cancel-receive',
        operationName: 'Cancel Received Branch Transfer',
        description: 'Cancel or rollback an acknowledged inter-branch transfer delivery',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-transfer-cancel-receive'],
      },
      {
        id: 'branch-transfer-request-cancel',
        operationName: 'Request Transfer Dispatch Cancellation',
        description: 'Submit cancellation requests for outbound in-transit transfers',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-transfer-request-cancel'],
      },
      {
        id: 'branch-pullout-dispatch',
        operationName: 'Dispatch Stock Pullout to HQ',
        description: 'Send overstock or damaged inventory back to Central HQ Warehouse',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-pullout-dispatch'],
      },
      {
        id: 'branch-damage-mark',
        operationName: 'Label & Record Damaged Stock',
        description: 'Flag damaged or broken inventory for inspection or write-off',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-damage-mark'],
      },
      {
        id: 'stock-disposal-writeoff',
        operationName: 'Stock Disposal & Financial Write-Off',
        description: 'Approve and execute permanent inventory scrap disposal, salvage recovery, and balance sheet write-off entries',
        permissions: DEFAULT_PERMISSIONS_MATRIX['stock-disposal-writeoff'],
      },
      {
        id: 'branch-asset-assign',
        operationName: 'Assign Fixed Assets to Branch Staff',
        description: 'Allocate branch equipment, devices, and tools to specific personnel',
        permissions: DEFAULT_PERMISSIONS_MATRIX['branch-asset-assign'],
      },
      {
        id: 'stock-out',
        operationName: 'Stock Issues & Stock-Out Reversal',
        description: 'Issue consumables, post manual stock reductions, and reverse a posted stock-out',
        permissions: DEFAULT_PERMISSIONS_MATRIX['stock-out'],
      },
      {
        id: 'consumable-issue-reverse',
        operationName: 'Reverse Consumable Issue Record',
        description: 'Undo a logged consumable issue — returns the issued units to branch stock, marks the record CANCELLED and writes a reversal to the audit trail',
        permissions: DEFAULT_PERMISSIONS_MATRIX['consumable-issue-reverse'],
      },
      {
        id: 'employee-stock-view',
        operationName: 'View Employee Stock Custody',
        description: 'Read what each employee still holds — the My Stock panel and the Equipment section on an employee profile. Moving units in or out stays with the stock-issue and consumable controls.',
        permissions: DEFAULT_PERMISSIONS_MATRIX['employee-stock-view'],
      },
    ],
  },
  {
    id: 'inventory-master',
    category: 'Inventory & Product Master',
    icon: Package,
    color: 'text-emerald-600 dark:text-emerald-400',
    bgColor: 'bg-emerald-50 dark:bg-emerald-950/30',
    borderColor: 'border-emerald-200 dark:border-emerald-900',
    description: 'Product catalog, SKUs, barcode management, UOM, categories, and stock balances',
    operations: [
      {
        id: 'prod-view',
        operationName: 'View Product Catalog & Branch Balances',
        description: 'Access product SKUs, serial numbers, selling prices, and branch stock on hand',
        permissions: DEFAULT_PERMISSIONS_MATRIX['prod-view'],
      },
      {
        id: 'prod-edit',
        operationName: 'Create & Edit Products & SKUs',
        description: 'Add new inventory items, set cost rates, barcodes, and reorder thresholds',
        permissions: DEFAULT_PERMISSIONS_MATRIX['prod-edit'],
      },
      {
        id: 'uom-manage',
        operationName: 'Manage Units of Measure (UOM)',
        description: 'Define units of measurement and unit conversion factors',
        permissions: DEFAULT_PERMISSIONS_MATRIX['uom-manage'],
      },
      {
        id: 'category-manage',
        operationName: 'Manage Categories & Subcategories',
        description: 'Define product hierarchy, classification trees, and subcategories',
        permissions: DEFAULT_PERMISSIONS_MATRIX['category-manage'],
      },
      {
        id: 'product-group-manage',
        operationName: 'Manage Product Groups',
        description: 'Define the catalog groups operators can assign to a product, and the fixed behaviour (stock item, consumable, or depreciating fixed asset) each one maps to',
        permissions: DEFAULT_PERMISSIONS_MATRIX['product-group-manage'],
      },
      {
        id: 'warranty-view',
        operationName: 'View Suppliers & Sellers Warranty Registers',
        description: 'Read the inbound supplier warranty and outbound seller warranty registers, including expiry state and source document',
        permissions: DEFAULT_PERMISSIONS_MATRIX['warranty-view'],
      },
      {
        id: 'warranty-edit',
        operationName: 'Correct Warranty Dates',
        description: 'Correct a stored warranty start, expiry or note when the supplier or customer contract differs from the computed default',
        permissions: DEFAULT_PERMISSIONS_MATRIX['warranty-edit'],
      },
      {
        id: 'field-work-order',
        operationName: 'Field Work Orders (Technician Visits)',
        description: 'Raise, assign and close installation, service and disconnection visits, capturing the connection and equipment details recorded on site',
        permissions: DEFAULT_PERMISSIONS_MATRIX['field-work-order'],
      },
      {
        id: 'edit-device-serials',
        operationName: 'Edit Device Serial Numbers (Serial/PON/MAC)',
        description: 'Edit serial numbers, PON serials, and MAC addresses for customer devices with cascading updates to all source tables',
        permissions: DEFAULT_PERMISSIONS_MATRIX['edit-device-serials'],
      },
      {
        id: 'stock-import-export',
        operationName: 'Import & Export Inventory Records',
        description: 'Bulk upload stock via CSV/Excel or export inventory valuation reports',
        permissions: DEFAULT_PERMISSIONS_MATRIX['stock-import-export'],
      },
      {
        id: 'opening-stock-view',
        operationName: 'View Fiscal Year Opening Register',
        description: 'Inspect per-product, per-branch opening stock and per-supplier opening balance posted at fiscal year closing',
        permissions: DEFAULT_PERMISSIONS_MATRIX['opening-stock-view'],
      },
      {
        id: 'opening-stock-edit',
        operationName: 'Adjust Fiscal Year Opening Register',
        description: 'Manually correct opening stock quantity, damaged quantity, unit cost, and vendor opening balances while the fiscal year remains open',
        permissions: DEFAULT_PERMISSIONS_MATRIX['opening-stock-edit'],
      },
    ],
  },
  {
    id: 'financials',
    category: 'Finance & Accounting',
    icon: Building,
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-50 dark:bg-purple-950/30',
    borderColor: 'border-purple-200 dark:border-purple-900',
    description: 'Voucher entry, ledger review, statements, tax, stock valuation and the fixed-asset register',
    operations: [
      {
        id: 'assets-view',
        operationName: 'View Fixed Asset Register',
        description: 'Read the fixed-asset register, depreciation schedule and asset totals without the ability to capitalise or dispose an asset',
        permissions: DEFAULT_PERMISSIONS_MATRIX['assets-view'],
      },
      {
        id: 'assets-manage',
        operationName: 'Manage Fixed Asset Register & Depreciation',
        description: 'Register capital assets, track depreciation rates, and handle disposals',
        permissions: DEFAULT_PERMISSIONS_MATRIX['assets-manage'],
      },
      {
        id: 'fin-statements',
        operationName: 'Open Finance Dashboard',
        description: 'Access the ledger-backed Finance Dashboard (profitability, cash and bank, working capital, cash movement, AR/AP aging and control health)',
        permissions: DEFAULT_PERMISSIONS_MATRIX['fin-statements'],
      },
      {
        id: 'vat-register',
        operationName: 'View VAT Tax Register',
        description: 'Audit purchase VAT tax credits, vendor tax invoices, and IRD reporting',
        permissions: DEFAULT_PERMISSIONS_MATRIX['vat-register'],
      },
      {
        id: 'stock-valuation',
        operationName: 'Stock Valuation & Movement Ledger',
        description: 'Inspect FIFO/Weighted Average stock valuations and transaction ledgers',
        permissions: DEFAULT_PERMISSIONS_MATRIX['stock-valuation'],
      },
      {
        id: 'gl-view',
        operationName: 'View Finance & Accounting Registers',
        description: 'Read the voucher register, trial balance, P&L, balance sheet, cash & bank book, AR/AP aging, chart of accounts, general ledger master, subledgers, bill terms, cost centres, narrations, posting defaults and control-account reconciliations',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-view'],
      },
      {
        id: 'gl-post',
        operationName: 'Post Journal & Cash/Bank Vouchers',
        description: 'Post balanced manual journals and cash/bank vouchers; opening balances, payroll runs and the daily cash close have their own controls',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-post'],
      },
      {
        id: 'gl-reverse',
        operationName: 'Reverse Posted Vouchers',
        description: 'Reverse an eligible manual or cash/bank voucher through a linked contra entry; the original stays posted and a second reversal is refused',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-reverse'],
      },
      {
        id: 'gl-chart-manage',
        operationName: 'Maintain Chart of Accounts & Posting Defaults',
        description: 'Create groups, sub-groups and ledgers, set posting defaults, and repair missing default chart entries',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-chart-manage'],
      },
      {
        id: 'gl-close',
        operationName: 'Close & Reopen Accounting Periods',
        description: 'Open monthly accounting periods, close them to block postings, and reopen with an audit trail',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-close'],
      },
      {
        id: 'fin-depreciation-post',
        operationName: 'Post Fixed-Asset Depreciation',
        description: 'Run and post the period depreciation journal for fixed assets; reading the statements does not grant this write',
        permissions: DEFAULT_PERMISSIONS_MATRIX['fin-depreciation-post'],
      },
    ],
  },
  {
    id: 'finance-controls',
    category: 'Finance Controls & Period-End',
    icon: Landmark,
    color: 'text-indigo-600 dark:text-indigo-400',
    bgColor: 'bg-indigo-50 dark:bg-indigo-950/30',
    borderColor: 'border-indigo-200 dark:border-indigo-900',
    description: 'Granular finance maintenance and period-end controls: chart, subledgers, dimensions, bill terms, payroll, cash close and opening balances',
    operations: [
      {
        id: 'gl-subledger-manage',
        operationName: 'Maintain Subledger Books',
        description: 'Create, rebind and retire subledger books under control accounts, and generate missing party books',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-subledger-manage'],
      },
      {
        id: 'gl-dimension-manage',
        operationName: 'Maintain Cost Centres & Narrations',
        description: 'Maintain cost centres and quick-pick narration templates used by journal lines',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-dimension-manage'],
      },
      {
        id: 'gl-bill-terms-manage',
        operationName: 'Maintain Bill Terms',
        description: 'Maintain bill-wise settlement terms used by parties and posted invoices',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-bill-terms-manage'],
      },
      {
        id: 'gl-payroll-manage',
        operationName: 'Maintain Employee Master (Legacy Gate)',
        description: 'Legacy payroll-master maintenance still accepted by the employee routes; prefer the People & HR grants below',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-payroll-manage'],
      },
      {
        id: 'gl-payroll-post',
        operationName: 'Post & Pay Payroll Runs',
        description: 'Post a payroll run journal and record its payment; does not grant manual-journal or cash-close posting',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-payroll-post'],
      },
      {
        id: 'gl-cash-close',
        operationName: 'Close & Reopen Daily Cash Position',
        description: 'Close and reopen the counted daily cash position; does not grant manual-journal posting',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-cash-close'],
      },
      {
        id: 'gl-opening-post',
        operationName: 'Post Opening Balances',
        description: 'Post the branch opening trial balance into the earliest open period',
        permissions: DEFAULT_PERMISSIONS_MATRIX['gl-opening-post'],
      },
    ],
  },
  {
    id: 'people-hr',
    category: 'People & HR',
    icon: Users,
    color: 'text-emerald-600 dark:text-emerald-400',
    bgColor: 'bg-emerald-50 dark:bg-emerald-950/30',
    borderColor: 'border-emerald-200 dark:border-emerald-900',
    description: 'Employee master access and the login-account link used by future self-service; payroll posting stays under Finance Controls',
    operations: [
      {
        id: 'hr-employee-view',
        operationName: 'Read Employee Master & PII',
        description: 'Read employee identity, contact, statutory and bank details in the directory',
        permissions: DEFAULT_PERMISSIONS_MATRIX['hr-employee-view'],
      },
      {
        id: 'hr-employee-manage',
        operationName: 'Maintain Employee Master & Account Link',
        description: 'Add, edit, deactivate and link employees; one login account can map to one employee',
        permissions: DEFAULT_PERMISSIONS_MATRIX['hr-employee-manage'],
      },
      {
        id: 'hr-attendance-manage',
        operationName: 'Maintain Attendance, Shifts, Holidays & Leave Types',
        description: 'Add or correct daily attendance, import the biometric CSV, and maintain the shift, holiday and leave-type catalogues',
        permissions: DEFAULT_PERMISSIONS_MATRIX['hr-attendance-manage'],
      },
      {
        id: 'hr-self-service',
        operationName: 'Use Employee Self-Service',
        description: 'Read your own linked employee profile; never another employee and never a company-wide view',
        permissions: DEFAULT_PERMISSIONS_MATRIX['hr-self-service'],
      },
    ],
  },
  {
    id: 'contacts',
    category: 'Suppliers & Customers',
    icon: Briefcase,
    color: 'text-rose-600 dark:text-rose-400',
    bgColor: 'bg-rose-50 dark:bg-rose-950/30',
    borderColor: 'border-rose-200 dark:border-rose-900',
    description: 'Vendor master directory, PAN/VAT registrations, and customer profiles',
    operations: [
      {
        id: 'suppliers-manage',
        operationName: 'Manage Vendor Directory & PAN/VAT',
        description: 'Add and edit vendor records, verified tax IDs, and credit terms',
        permissions: DEFAULT_PERMISSIONS_MATRIX['suppliers-manage'],
      },
      {
        id: 'customers-manage',
        operationName: 'Manage Customer Profiles & Limits',
        description: 'Maintain customer contact details, credit limits, and sales history',
        permissions: DEFAULT_PERMISSIONS_MATRIX['customers-manage'],
      },
    ],
  },
  {
    id: 'administration',
    category: 'System Administration & Security',
    icon: ShieldCheck,
    color: 'text-cyan-600 dark:text-cyan-400',
    bgColor: 'bg-cyan-50 dark:bg-cyan-950/30',
    borderColor: 'border-cyan-200 dark:border-cyan-900',
    description: 'User management, branch permissions control, system audit logs, and fiscal year settings',
    operations: [
      {
        id: 'auth-switch-user',
        operationName: 'Switch User Login / Session Profile',
        description: 'Allow switching active user profile and operational identity without full re-authentication',
        permissions: DEFAULT_PERMISSIONS_MATRIX['auth-switch-user'],
      },
      {
        id: 'workflow-approval',
        operationName: 'Process Workflow Approvals (Authorize/Reject)',
        description: 'Review, approve, or reject customer device status transitions and transfer cancellations',
        permissions: DEFAULT_PERMISSIONS_MATRIX['workflow-approval'],
      },
      {
        id: 'workflow-approval-cancel',
        operationName: 'Cancel Workflow Approval Requests',
        description: 'Cancel or withdraw pending workflow approval requests (restricted from Branch Managers & Front Desk)',
        permissions: DEFAULT_PERMISSIONS_MATRIX['workflow-approval-cancel'],
      },
      {
        id: 'admin-users',
        operationName: 'User Management & Role Assignment',
        description: 'Create user accounts, set role permissions, and assign branch affiliations',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-users'],
      },
      {
        id: 'admin-branches',
        operationName: 'Branch Management & Branch Controls',
        description: 'Create new branches, configure HQ status, and set branch permissions',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-branches'],
      },
      {
        id: 'admin-audit',
        operationName: 'View Audit Trail & Transaction Logs',
        description: 'Inspect detailed system transaction logs, user actions, and timestamps',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-audit'],
      },
      {
        id: 'admin-fiscal',
        operationName: 'Nepali Fiscal Year Management',
        description: 'Manage Bikram Sambat (BS) fiscal calendars, year-end closings, and dates',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-fiscal'],
      },
      {
        id: 'admin-api-keys',
        operationName: 'API Key Management (Partner Integrations)',
        description: 'Issue, rotate and revoke scoped API keys that another application uses to read or write data; view key usage, expiry and revocation history',
        permissions: DEFAULT_PERMISSIONS_MATRIX['admin-api-keys'],
      },
    ],
  },
];
