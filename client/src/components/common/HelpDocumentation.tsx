import React, { useState } from 'react';
import { getDefaultTaxRate } from '../../utils/taxConfig';
import {
  BookOpen,
  HelpCircle,
  Keyboard,
  Workflow,
  Search,
  Download,
  Printer,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Cpu,
  RefreshCw,
  Zap,
  ArrowRight,
  ShieldCheck,
  Building2,
  Calendar,
  Smartphone,
  Receipt,
  RotateCcw,
  Sliders,
  FileSpreadsheet,
  Users,
  Eye,
  Layers,
  Terminal,
  ListOrdered,
  ClipboardList,
  AlertTriangle,
} from 'lucide-react';
import { User } from '../../types';

interface HelpDocumentationProps {
  currentUser: User | null;
  onOpenBarcodeModal?: () => void;
  onOpenSearchModal?: () => void;
  onNavigateTab?: (tab: string) => void;
}

type HelpTab = 'guides' | 'manual' | 'workflows' | 'shortcuts' | 'faq' | 'system-diagnostics';

interface WorkflowStep {
  step: number;
  title: string;
  role: string;
  description: string;
  actionTab?: string;
  keyOutputs: string[];
}

interface ProcessWorkflow {
  id: string;
  title: string;
  category: string;
  description: string;
  steps: WorkflowStep[];
}

/** A task-oriented user-manual guide: numbered steps with exact screen names. */
interface UserGuide {
  id: string;
  title: string;
  goal: string;
  /** Role/permission prerequisite, if any. */
  requires?: string;
  /** Optional caution shown before the steps. */
  caution?: string;
  steps: string[];
  result: string;
}

const USER_GUIDES: UserGuide[] = [
  {
    id: 'daily-ops',
    title: 'Daily Operations',
    goal: 'Sign in, set your working branch and date mode, and find any product in seconds.',
    steps: [
      'Open the app and sign in with your email and password on the login screen.',
      'Use the "Select Branch" dropdown in the top header to choose your branch — or "All Branches (Consolidated)" if your role allows it.',
      'Check the FY (fiscal year) selector beside it shows the correct BS year (e.g. 2083-84 Active). All reports and ledgers respect this year.',
      'Press Alt + D (or click the date chip in the header) to switch every timestamp between Bikram Sambat and AD.',
      'Find a product fast: press Ctrl + K (or the header search box) and type the product name or SKU; press Alt + B to open the barcode scanner and scan an item directly.',
      'Navigate using the left sidebar: click a group name (e.g. "Inventory & Stock") to expand its menu items inline; click it again to collapse. Press / to jump into sidebar menu search.',
      'Use the "EXPAND / COLLAPSE MENU" header button on the sidebar to open or close all groups at once.',
      'When finished, click your avatar (top-right) and sign out — especially on shared computers.',
    ],
    result: 'You are working in the right branch, fiscal year, and date format, and can reach any screen or product within a couple of clicks.',
  },
  {
    id: 'stock-ops',
    title: 'Stock In / Out & Transfers',
    goal: 'Record goods coming in, going out, and moving between branches.',
    requires: 'Store Incharge or Branch Manager permissions for your branch.',
    steps: [
      'Open Inventory & Stock → Stock Operations (the 11-tab stock workspace).',
      'Stock IN: use the inward tab, pick the supplier invoice (or enter a manual entry), select products with quantities, and submit. Each line updates quantityOnHand and writes a Stock Movement Ledger entry.',
      'Stock OUT: use the outward tab, choose the destination/purpose, add product lines, and submit. Stock cannot go negative — the server rejects the write if quantity is insufficient.',
      'Branch Transfer: fill the transfer form (source branch = yours, destination branch, product lines). The destination branch receives it in their Inward/shipments view — both sides get ledger entries.',
      'Verify everything in Inventory & Stock → Stock Movement Ledger: filter by product, branch, or date; export to CSV for records.',
    ],
    result: 'Every physical movement has a matching ledger entry with before/after quantities and full audit trail.',
  },
  {
    id: 'stock-audit',
    title: 'Physical Stock Count Audit',
    goal: 'Run a blind stock count, get manager approval on variances, and let the system adjust stock automatically.',
    requires: 'Store Incharge to count; Branch Manager (or higher) to approve.',
    caution: 'Adjustments only apply AFTER manager approval. Never edit stock directly to "fix" a count.',
    steps: [
      'Open Inventory & Stock → the Physical/Blind Stock Audit tab in Stock Operations.',
      'Start a new count for your branch. The count sheet hides system quantities (blind count) so you record only what you physically see.',
      'Count each product and enter the physical quantity. Save the sheet — you can leave and resume it.',
      'Submit the count for approval. The system compares physical vs system quantities and creates variance entries per product.',
      'The Branch Manager opens Overview → Workflow Approval Center, reviews each variance with its reason, and approves or rejects.',
      'On approval the system automatically adjusts inventory_stock and posts a Stock Adjustment entry in the Stock Movement Ledger — no manual stock edits needed.',
      'Check the result in the ledger (filter: changeType = adjustment) and in Stock Valuation.',
    ],
    result: 'System stock matches the physical count, with a documented, approved audit trail for every difference.',
  },
  {
    id: 'purchasing',
    title: 'Purchasing End-to-End (PO → Invoice → Payment)',
    goal: 'Raise a purchase order, receive the goods, book the VAT invoice, and track what you owe the supplier.',
    requires: 'Procurement permissions; Branch Manager for PO approval.',
    steps: [
      'Procurement & Purchasing → Purchase Orders: create a PO — supplier, branch, product lines with quantities and agreed prices. Submit it for approval.',
      'The approver opens Overview → Workflow Approval Center and approves the PO (status becomes approved; the supplier can now deliver).',
      'When goods arrive: receive against the PO (Inbound/Receiving). Quantities are checked in, stock increases at the receiving branch, and the movement ledger records the inward.',
      'Procurement & Purchasing → Purchase Invoices: book the supplier\'s VAT invoice against the received PO/P items — grand total and VAT amount feed the VAT register and vendor payables.',
      'Track what you owe: Finance & Accounting → Vendor Ledger & Payments. Record each payment against the invoice; outstanding balance = opening balances + invoices − payments.',
      'If the supplier needs a starting balance (from before the system), use Vendor Opening Balances to post it for the fiscal year.',
    ],
    result: 'Goods received, VAT input tax captured, and supplier payable balance always reconcilable in the vendor ledger.',
  },
  {
    id: 'sales-devices',
    title: 'Selling Products & Managing Customer Devices',
    goal: 'Sell stock over the counter and manage ISP hardware (ONU/router) assigned to customers.',
    requires: 'Branch Operations permissions; ISP Field Tech for device assignment.',
    steps: [
      'Branch Operations → Sell Product: pick the customer (or quick-create one), add product lines, confirm. Stock is deducted at your branch and revenue/COGS feed the Financial Overview trading summary.',
      'ISP hardware: Overview → Serial Log Register records every ONU/router unit with its Device Serial, PON Serial and MAC address when it arrives.',
      'Overview → Customer Device Serials: assign a unit to a customer (status IN_STOCK → ACTIVE or RENTAL). The customer\'s device history stays attached to them.',
      'Defective unit? Log the return in Customer Device Serials — a manager must authorize the restock/exchange before the replacement goes out (Overview → Device Exchange & Replacement).',
      'Warranty: Overview → View Warranty Products to see units still under warranty and their coverage dates.',
    ],
    result: 'Every sold item and every customer-installed device is traceable by serial, with warranty and exchange history.',
  },
  {
    id: 'approvals',
    title: 'Working the Approval Center',
    goal: 'Process pending requests — stock adjustments, POs, device returns, refunds — with a full audit trail.',
    requires: 'Approver permissions (Branch Manager or role-specific).',
    steps: [
      'Open Overview → Workflow Approval Center. The badge in the sidebar shows your pending count.',
      'Each request shows what is proposed, who raised it, and when. Open it to inspect the before/after values (e.g. counted vs system quantity for a stock variance).',
      'Approve: the system performs the action immediately and records who approved it and when. Reject: the requester is notified and nothing changes.',
      'Stock-count variances: approval is what actually adjusts inventory — see the Physical Stock Count Audit guide.',
      'All decisions are permanent entries in Administration & Governance → Audit Activities Log.',
    ],
    result: 'Every sensitive action happened because someone specific approved it — and the log proves it.',
  },
  {
    id: 'financial-overview',
    title: 'Reading the Financial Overview & VAT Register',
    goal: 'Get management figures for a branch or the whole company, and print them with sources & limitations.',
    requires: 'Accountant or Super Admin (fin-statements permission).',
    caution: 'These are MANAGEMENT figures from operational registers — not statutory accounting. The printed cover note says exactly what is and isn\'t included.',
    steps: [
      'Open Finance & Accounting → Financial Overview.',
      'Statement view: pick the entity from "Statement of" — a single branch or All Branches (Consolidated). The table always shows period columns for the header\'s fiscal year.',
      'Click "Compare with <prior year>" to add prior-year closing columns and a signed variance column (+green / −red).',
      'Switch to the "Branch Comparison" tab to see every branch as a ROW with KPI columns (assets, payables, net position, revenue…) and a CONSOLIDATED row — this is the branch-vs-branch report.',
      'Print Statement: the printout includes a cover note listing data sources and limitations — hand it to management as-is.',
      'VAT: Finance & Accounting → VAT Sales & Purchase Register shows claimable input tax credit from purchase invoices for the selected fiscal year.',
      'Depreciation: the Depreciation Register computes SLM/WDV per asset from its placed-in-service date; the Tax Depreciation Schedule shows the yearly amounts.',
    ],
    result: 'Reliable management numbers per branch or group, printed with an honest cover note; VAT input tax ready to hand to your accountant.',
  },
  {
    id: 'year-end',
    title: 'Fiscal Year Closing (6-Step Wizard)',
    goal: 'Close a BS fiscal year: verify data, lock valuation, roll balances forward, and lock the period.',
    requires: 'Super Admin. Do this shortly after the BS year ends, before users post into the new year heavily.',
    caution: 'Closing locks the prior period against edits. Only Super Admin can unlock, and every unlock is audited.',
    steps: [
      'Administration & Governance → Fiscal Year Closing Wizard. Enter the admin PIN/password when asked.',
      'Step 1 — Pre-Closing Audit & Diagnostics: the wizard runs live data checks (unposted movements, incomplete counts, VAT register) and flags anything to fix first.',
      'Step 2 — Asset Depreciation & Stock Valuation Lock: review computed annual depreciation and closing stock value; confirm to lock the valuation basis.',
      'Step 3 — Financial Summary & Surplus Estimate: review real posted sales − COGS − schedule depreciation. This is a management estimate — the system posts no ledger entries.',
      'Step 4 — Opening Balances Roll-Forward: stock quantities/costs carry into the new fiscal year\'s opening stock.',
      'Step 5 — Close Vendor Ledgers: vendor opening balances roll forward so payables continue correctly into the new year.',
      'Step 6 — Lock Period & Closing Snapshot: set the fiscal lock and download the closing snapshot (.txt). It is UNAUDITED — for statutory/tax filing, hand your records to a professional accountant.',
      'After closing: verify the new FY is Active in the header selector and opening stock looks right in Inventory & Stock → Opening Stock Manager.',
    ],
    result: 'The old BS year is locked with an audit trail, and the new year starts with correct opening balances.',
  },
  {
    id: 'admin-users',
    title: 'Admin: Users, Branches & Data Tools',
    goal: 'Manage staff accounts, branches, and the repair/data tools — safely.',
    requires: 'Super Admin.',
    caution: 'User accounts, branch deactivation and Clear Demo Data affect live access and data. Double-check before confirming.',
    steps: [
      'Create staff: Administration & Governance → User Management (within Master Data & Directories / Admin groups) — name, email, role, home branch. The user gets the shared demo password policy initially; they change it from their profile.',
      'Roles: the 9 fixed roles (SUPER_ADMIN, BRANCH_MANAGER, INVENTORY_MANAGER, …) map to a permission matrix — see Help → Interactive User Manual chapter 2 for who can do what.',
      'Branches: create a new branch with its code; deactivate (never delete) a branch that closes — history stays intact.',
      'Audit: Administration & Governance → Audit Activities Log shows every user action with IP, AD+BS timestamps and before/after values. Filter by user or module.',
      'Repairs: Data Recalculation & Repair re-derives fixed-asset depreciation and other persisted values from source records. Use after correcting source data — it records its own audit entry.',
      'Danger zone: Clear Demo Data wipes demo transactions. NEVER run this on a live database — it exists for demo resets only.',
      'Session security: for sensitive roles, avoid "Keep me logged in" on shared machines; the header avatar menu signs the current session out.',
    ],
    result: 'Staff have correct access, branches reflect reality, and you can prove who did what — without ever hand-editing data.',
  },
];

export const HelpDocumentation: React.FC<HelpDocumentationProps> = ({
  currentUser,
  onOpenBarcodeModal,
  onOpenSearchModal,
  onNavigateTab,
}) => {
  const [activeTab, setActiveTab] = useState<HelpTab>('guides');
  const [activeGuideId, setActiveGuideId] = useState<string>(USER_GUIDES[0].id);
  const [manualSearch, setManualSearch] = useState('');
  const [activeChapter, setActiveChapter] = useState('overview');
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('procurement');
  const [copiedShortcut, setCopiedShortcut] = useState<string | null>(null);
  const [faqCategory, setFaqCategory] = useState<string>('all');
  const [faqSearch, setFaqSearch] = useState('');

  // Diagnostic state
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagResults, setDiagResults] = useState<{
    storageOk: boolean;
    authOk: boolean;
    networkOk: boolean;
    branchOk: boolean;
    timestamp: string;
  } | null>(null);

  const runDiagnostics = () => {
    setDiagRunning(true);
    setTimeout(() => {
      setDiagResults({
        storageOk: typeof window !== 'undefined' && window.localStorage !== undefined,
        authOk: Boolean(currentUser && currentUser.id),
        networkOk: navigator.onLine,
        branchOk: Boolean(currentUser?.branchId),
        timestamp: new Date().toLocaleTimeString(),
      });
      setDiagRunning(false);
    }, 600);
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedShortcut(code);
    setTimeout(() => setCopiedShortcut(null), 2000);
  };

  // 1. Manual Chapters Definition
  const manualChapters = [
    { id: 'overview', title: '1. System Overview & Core Architecture', icon: Layers },
    { id: 'roles', title: '2. User Roles & Permission Matrix', icon: ShieldCheck },
    { id: 'getting-started', title: '3. Getting Started, Setup & Staff Password Resets', icon: Zap },
    { id: 'inventory-ops', title: '4. Inventory, Barcode Scanner & Blind Stock Audit', icon: BookOpen },
    { id: 'isp-devices', title: '5. ISP Hardware & ONU Serial Tracking', icon: Smartphone },
    { id: 'approval-center', title: '6. Multi-Tier Approval Workflows', icon: CheckCircle2 },
    { id: 'purchasing', title: '7. Purchasing, Invoices & Shipments', icon: Receipt },
    { id: 'tax-depreciation', title: '8. Financials, VAT Register & Depreciation', icon: FileSpreadsheet },
    { id: 'fiscal-closing', title: '9. BS Calendar & Fiscal Year Closing Wizard', icon: Calendar },
    { id: 'troubleshooting', title: '10. FAQ & System Diagnostics', icon: HelpCircle },
  ];

  // 2. Interactive Workflows
  const workflows: ProcessWorkflow[] = [
    {
      id: 'procurement',
      title: 'Procurement to Inward Stock Intake',
      category: 'Procurement & Receiving',
      description: 'End-to-end purchasing cycle from vendor selection to stock ledger updating.',
      steps: [
        {
          step: 1,
          title: 'Create Purchase Order (PO)',
          role: 'Store Manager / Accountant',
          description: 'Select vendor, expected delivery date, line items, unit costs, and tax settings.',
          actionTab: 'create-po',
          keyOutputs: ['PO Reference #', 'Pending PO Inventory Counter'],
        },
        {
          step: 2,
          title: 'Manager PO Approval',
          role: 'Branch Manager / Super Admin',
          description: 'Review purchase order total. High-value POs trigger mandatory approval.',
          actionTab: 'approvals',
          keyOutputs: ['Approved PO Status', 'Vendor Notification'],
        },
        {
          step: 3,
          title: 'Inward Shipment Receiving',
          role: 'Store Incharge',
          description: 'Scan incoming serials/barcodes, verify quantities against bill, log discrepancy notes.',
          actionTab: 'receive-shipment',
          keyOutputs: ['Goods Received Note (GRN)', 'Inventory Stock Increase'],
        },
        {
          step: 4,
          title: 'Purchase Invoice Conversion',
          role: 'Accountant',
          description: 'Convert GRN into official VAT Purchase Invoice with vendor PAN/VAT details.',
          actionTab: 'create-purchase',
          keyOutputs: ['VAT Purchase Register Entry', 'Accounts Payable Ledger Update'],
        },
      ],
    },
    {
      id: 'stock-audit',
      title: 'Blind Stock Audit & Cycle Counting',
      category: 'Inventory Control',
      description: 'Unbiased physical inventory counting with hidden book balances and manager reconciliation.',
      steps: [
        {
          step: 1,
          title: 'Initiate Blind Audit Session',
          role: 'Inventory Manager / Auditor',
          description: 'Select branch location and activate "Blind Count Mode: ON" to hide expected book quantities from counting staff.',
          actionTab: 'physical-stock-audit',
          keyOutputs: ['Audit Session ID', 'Book Balances Hidden (Locked)'],
        },
        {
          step: 2,
          title: 'Physical Mobile Barcode Counting',
          role: 'Store Incharge / Floor Auditor',
          description: 'Scan shelf stock using smartphone camera or barcode reader to log counted physical quantities.',
          actionTab: 'physical-stock-audit',
          keyOutputs: ['Physical Count Records', 'Unbiased Stock Log'],
        },
        {
          step: 3,
          title: 'Unseal & Calculate Variances',
          role: 'Auditor / Store Manager',
          description: 'Click "Unseal & Reveal System Balances" to expose book numbers, variance quantities, and net valuation impact (NPR).',
          actionTab: 'physical-stock-audit',
          keyOutputs: ['Unsealed Variances', 'Audit Discrepancy Statement'],
        },
        {
          step: 4,
          title: 'Approval & Ledger Reconciliation',
          role: 'Branch Manager / Super Admin',
          description: 'Review variance justification and authorize stock adjustment in the Approval Center to update stock ledgers.',
          actionTab: 'approvals',
          keyOutputs: ['Reconciled Stock Ledger', 'Audit Compliance Entry'],
        },
      ],
    },
    {
      id: 'barcode-labeling',
      title: 'Barcode Scanning & Thermal Label Printing',
      category: 'Warehouse & Labeling',
      description: 'Scanning barcodes with mobile camera and printing thermal labels with prices and serial tags.',
      steps: [
        {
          step: 1,
          title: 'Launch Mobile Scanner Studio',
          role: 'All Warehouse & Branch Staff',
          description: 'Press Alt + B or click the Barcode Scanner icon in the header to launch camera scanner.',
          actionTab: 'barcode-scanner',
          keyOutputs: ['Camera Viewfinder Active', 'Flashlight / Torch Toggle'],
        },
        {
          step: 2,
          title: 'Scan Item or Hardware Tag',
          role: 'Store Incharge',
          description: 'Align barcode or QR code inside the viewfinder to fetch product SKU, category, and NPR price instantly.',
          actionTab: 'barcode-scanner',
          keyOutputs: ['Audio Beep Confirmation', 'Product Master Match'],
        },
        {
          step: 3,
          title: 'Configure Thermal Label Tag',
          role: 'Store Incharge / Labeling Tech',
          description: 'Switch to Thermal Tag Studio, select label dimensions (50x30, 38x25, 100x50), CODE128/QR, price, and serial tags.',
          actionTab: 'barcode-scanner',
          keyOutputs: ['Live Thermal Tag Preview', 'Print Quantity Selector'],
        },
        {
          step: 4,
          title: 'Thermal Printer Output',
          role: 'Store Incharge',
          description: 'Click Print to send formatted sticker labels directly to Zebra, Xprinter, or TSC thermal barcode printers.',
          actionTab: 'barcode-scanner',
          keyOutputs: ['Printed Barcode Stickers', 'Shelf Tag Placement'],
        },
      ],
    },
    {
      id: 'user-admin',
      title: 'User Access Setup & Password Recovery',
      category: 'Security & Access',
      description: 'First-time super admin provisioning, role-based branch assignments, and staff password resets.',
      steps: [
        {
          step: 1,
          title: 'Initial System Provisioning',
          role: 'Super Admin',
          description: 'On fresh launch, system detects empty database and opens Super Admin Setup to create root administrator credentials.',
          actionTab: 'users',
          keyOutputs: ['Root Super Admin Created', 'Global Access Granted'],
        },
        {
          step: 2,
          title: 'Add User & Assign Multi-Branch Access',
          role: 'Super Admin',
          description: 'Create staff user accounts with specific roles (Front Desk, Accountant, Branch Manager) and assign allowed branch permissions.',
          actionTab: 'users',
          keyOutputs: ['User Credentials Active', 'Branch Data Isolation Enforced'],
        },
        {
          step: 3,
          title: 'Staff Forgotten Password Request',
          role: 'Staff Member',
          description: 'Staff member requests password reset at login or notifies system administrator.',
          actionTab: 'users',
          keyOutputs: ['Reset Request Logged', 'Admin Action Prompt'],
        },
        {
          step: 4,
          title: 'Issue New Password & Auto-Generate',
          role: 'Super Admin',
          description: 'Super Admin opens User Access Administration, clicks Reset Pass, auto-generates strong password, and copies credentials.',
          actionTab: 'users',
          keyOutputs: ['Instant Password Reset', 'Audit Log Entry'],
        },
      ],
    },
    {
      id: 'isp-devices',
      title: 'ISP Customer Device Assignment & Returns',
      category: 'ISP Hardware Logistics',
      description: 'Serial tracking for Fiber ONUs, MAC addresses, router issues, and replacement approvals.',
      steps: [
        {
          step: 1,
          title: 'Serial Number Warehouse Intake',
          role: 'Store Incharge',
          description: 'Intake batch of Fiber ONUs/Routers with PON Serials and MAC addresses.',
          actionTab: 'import-stock',
          keyOutputs: ['Serials Registered as IN_STOCK', 'Hardware Inventory Updated'],
        },
        {
          step: 2,
          title: 'Assign to Customer Account',
          role: 'Front Desk / ISP Technician',
          description: 'Link hardware serial number to customer record during field installation.',
          actionTab: 'customer-devices',
          keyOutputs: ['Device Status ACTIVE', 'Customer Warranty Expiry Tracked'],
        },
        {
          step: 3,
          title: 'Initiate Disconnect / Router Collection',
          role: 'Front Desk / Technician',
          description: 'Submit customer disconnect request with reason and restock flag.',
          actionTab: 'customer-devices',
          keyOutputs: ['Approval Request Generated', 'Pending Disconnect Approval'],
        },
        {
          step: 4,
          title: 'Approval, Disconnect Date & Restock Action',
          role: 'Branch Manager / Super Admin',
          description: 'Manager approves disconnect. System automatically stamps Disconnected Date, sets status to Router Collected, and restocks store inventory.',
          actionTab: 'approvals',
          keyOutputs: ['Timestamped Disconnected Date (AD/BS)', 'Device Status ROUTER_COLLECTED', 'Restocked Hardware Ledger'],
        },
      ],
    },
    {
      id: 'fiscal-closing',
      title: 'Nepali BS Fiscal Year Closing & Period Lock',
      category: 'Accounting & Year-End',
      description: '6-step guided fiscal year closing wizard: diagnostics, valuation lock, estimated surplus, roll-forward, vendor ledgers, and period lock with an unaudited closing snapshot (management figures — not statutory).',
      steps: [
        {
          step: 1,
          title: 'Pre-Closing Audit & Financial Review',
          role: 'Accountant / Super Admin',
          description: 'Review the Financial Overview (management view), Stock Movement Ledger opening balances, and VAT registers. Note: figures are from operational registers — no trial balance or general ledger exists.',
          actionTab: 'financial-statements',
          keyOutputs: ['Reviewed Management Figures', 'Verified VAT Liability'],
        },
        {
          step: 2,
          title: 'Post Depreciation Schedule',
          role: 'Accountant',
          description: 'Execute tax depreciation calculation (SLM/WDV) for all active fixed assets.',
          actionTab: 'depreciation-register',
          keyOutputs: ['Depreciation Schedule Totals', 'Net Asset Book Value'],
        },
        {
          step: 3,
          title: 'Execute 6-Step Closing Wizard',
          role: 'Super Admin',
          description: 'Enter Admin PIN / Password to run diagnostics, lock stock valuation, review the estimated surplus (real posted sales − COGS − schedule depreciation — no retained-earnings transfer occurs), roll balances forward, close vendor ledgers, and lock the period.',
          actionTab: 'fiscal-year-closing',
          keyOutputs: ['Locked Fiscal Period', 'Unaudited Closing Snapshot (txt)'],
        },
        {
          step: 4,
          title: 'Unlock / Carry Forward Balances',
          role: 'Super Admin',
          description: 'Carry forward opening balances into new BS period. If audit edits are needed, Super Admin can click "Unlock Period" to perform adjustments.',
          actionTab: 'nepali-fiscal',
          keyOutputs: ['New Active BS Fiscal Period', 'Opening Stock Rollback Balances'],
        },
      ],
    },
  ];

  // 3. Keyboard Shortcuts Data
  const shortcuts = [
    { key: 'Alt + B', description: 'Open Barcode Scanner Modal', category: 'Inventory' },
    { key: 'Alt + S', description: 'Open Global System Search', category: 'Navigation' },
    { key: 'Alt + H', description: 'Open In-App Help & Documentation', category: 'Navigation' },
    { key: 'Alt + N', description: 'Toggle Notifications Drawer', category: 'Global' },
    { key: 'Alt + D', description: 'Toggle BS / AD Calendar Date Mode', category: 'Global' },
    { key: 'Esc', description: 'Close Active Modal or Dropdown', category: 'Global' },
    { key: 'Ctrl + P', description: 'Print Active Report / Invoice', category: 'Reports' },
  ];

  // 4. FAQ Items Data
  const faqItems = [
    {
      question: 'How do I switch between Gregorian (AD) and Bikram Sambat (BS) dates?',
      answer:
        'Click the Date Mode toggle button in the top header navigation bar or press Alt + D. The entire app instantly updates all timestamps across reports, invoices, and ledgers between AD and BS format.',
      category: 'General',
    },
    {
      question: 'What happens when a physical stock count audit reveals a deficit?',
      answer:
        'When a deficit is recorded in Physical Stock Audit, the auditor provides a reason. Upon manager approval in the Approval Center, the inventory stock is automatically reduced, and a Stock Adjustment entry is recorded in the Stock Movement Ledger.',
      category: 'Inventory',
    },
    {
      question: 'How are device serial numbers (ONU / Router) tracked for ISPs?',
      answer:
        'In Customer Device Serials, every hardware unit is tracked by its unique Device Serial, PON Serial, and MAC address. Status transitions from IN_STOCK to ACTIVE, RENTAL, or DISCONNECTED. Defective returns require manager authorization before restock.',
      category: 'ISP Hardware',
    },
    {
      question: 'Can a user view data from multiple branches simultaneously?',
      answer:
        'Users with SUPER_ADMIN or ACCOUNTANT permissions can select "All Branches (HQ Consolidated)" from the top branch selector dropdown to view consolidated financial and inventory reports.',
      category: 'Permissions',
    },
    {
      question: 'How do I run the Fiscal Year Closing for Nepali BS Year?',
      answer:
        'Super Admins can navigate to Administration -> Fiscal Year Closing Wizard. The wizard runs 6 guided steps: data diagnostics, valuation lock, estimated surplus (management figures), opening-balance roll-forward, vendor ledger close, and period lock with an unaudited closing snapshot. For statutory/tax filing, hand your records to a professional accountant.',
      category: 'Finance',
    },
    {
      question: 'Which date starts fixed-asset depreciation?',
      answer:
        'The Depreciation Register uses the placed-in-service date as the depreciation start date. Purchase invoice date is retained for invoice reporting, while capitalization date identifies when the asset entered the accounting register. Fixed assets are not calculated from opening-stock quantities.',
      category: 'Finance',
    },
    {
      question: 'How do I correct old or zero fixed-asset values?',
      answer:
        'As a Super Admin, open Administration & Governance -> Data Recalculation & Repair and run Recalculate Fixed Assets. The operation persists accumulated depreciation and net book value in PostgreSQL and records an audit entry. It does not rewrite purchase invoices or transaction history.',
      category: 'Administration',
    },
    {
      question: 'What is the difference between opening stock and fixed assets?',
      answer:
        'Opening stock carries product quantities and costs from a closed fiscal year into the next year. Fixed assets are individual capital records linked to products or invoices and depreciate from their placed-in-service dates. Use separate repair actions for each area.',
      category: 'Inventory',
    },
    {
      question: 'Where can I inspect system changes and user activity?',
      answer:
        'Navigate to Administration -> Audit Activities Log. The audit log immutably records all user actions, IP addresses, timestamps in AD and BS, and before/after value changes.',
      category: 'Security',
    },
  ];

  const filteredFaqs = faqItems.filter((item) => {
    const matchesCat = faqCategory === 'all' || (item?.category || '').toLowerCase().includes((faqCategory || '').toLowerCase());
    const matchesSearch =
      (item?.question || '').toLowerCase().includes(faqSearch.toLowerCase()) ||
      (item?.answer || '').toLowerCase().includes(faqSearch.toLowerCase());
    return matchesCat && matchesSearch;
  });

  const selectedWorkflow = workflows.find((w) => w.id === selectedWorkflowId) || workflows[0];

  return (
    <div className={`printable-document p-4 sm:p-6 min-h-screen bg-slate-50 text-slate-800 dark:bg-[#0f1218] dark:text-slate-100`}>
      {/* Top Banner Header */}
      <div className="mb-6 rounded-2xl bg-gradient-to-r from-indigo-900 via-indigo-800 to-slate-900 p-6 text-white shadow-lg border border-indigo-700/40 relative overflow-hidden">
        <div className="absolute right-0 top-0 -mr-16 -mt-16 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none"></div>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 relative z-10">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-indigo-500/20 px-3 py-1 text-xs font-semibold text-indigo-300 border border-indigo-400/30 mb-2">
              <BookOpen className="h-3.5 w-3.5 text-indigo-300" />
              <span>Enterprise Resource & Learning Hub</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-serif font-bold tracking-tight">
              In-App Help & Documentation Center
            </h1>
            <p className="mt-1 text-sm text-indigo-200/90 max-w-2xl">
              Complete operating guide, interactive workflow visualizers, shortcut key cheat sheets, and diagnostic self-tests for Enterprise ERP.
            </p>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 hover:bg-white/20 px-3.5 py-2.5 text-xs font-semibold text-white backdrop-blur-sm border border-white/20 transition-all cursor-pointer"
            >
              <Printer className="h-4 w-4" />
              <span>Print Manual</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs Bar */}
        <div className="mt-6 flex items-center gap-2 overflow-x-auto custom-scrollbar border-t border-indigo-700/50 pt-4">
          <button
            onClick={() => setActiveTab('guides')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'guides'
                ? 'bg-white text-indigo-950 shadow-md'
                : 'bg-white/10 text-indigo-100 hover:bg-white/20'
            }`}
          >
            <ListOrdered className="h-4 w-4" />
            <span>Step-by-Step Guides</span>
          </button>

          <button
            onClick={() => setActiveTab('manual')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'manual'
                ? 'bg-white text-indigo-950 shadow-md'
                : 'bg-white/10 text-indigo-100 hover:bg-white/20'
            }`}
          >
            <BookOpen className="h-4 w-4" />
            <span>Interactive User Manual</span>
          </button>

          <button
            onClick={() => setActiveTab('workflows')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'workflows'
                ? 'bg-white text-indigo-950 shadow-md'
                : 'bg-white/10 text-indigo-100 hover:bg-white/20'
            }`}
          >
            <Workflow className="h-4 w-4" />
            <span>Operating Workflows</span>
          </button>

          <button
            onClick={() => setActiveTab('shortcuts')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'shortcuts'
                ? 'bg-white text-indigo-950 shadow-md'
                : 'bg-white/10 text-indigo-100 hover:bg-white/20'
            }`}
          >
            <Keyboard className="h-4 w-4" />
            <span>Keyboard Shortcuts</span>
          </button>

          <button
            onClick={() => setActiveTab('faq')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'faq'
                ? 'bg-white text-indigo-950 shadow-md'
                : 'bg-white/10 text-indigo-100 hover:bg-white/20'
            }`}
          >
            <HelpCircle className="h-4 w-4" />
            <span>FAQ & Guide</span>
          </button>

          <button
            onClick={() => setActiveTab('system-diagnostics')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'system-diagnostics'
                ? 'bg-white text-indigo-950 shadow-md'
                : 'bg-white/10 text-indigo-100 hover:bg-white/20'
            }`}
          >
            <Cpu className="h-4 w-4" />
            <span>System Diagnostic Self-Test</span>
          </button>
        </div>
      </div>

      {/* TAB 0: STEP-BY-STEP GUIDES (task-oriented user manual) */}
      {activeTab === 'guides' && (() => {
        const guide = USER_GUIDES.find((g) => g.id === activeGuideId) || USER_GUIDES[0];
        return (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Guide sidebar */}
            <div className={`rounded-2xl p-4 border bg-white border-slate-200 shadow-sm dark:bg-[#151921] dark:border-slate-800`}>
              <p className="px-1 mb-2 text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                How do I…
              </p>
              <div className="space-y-1">
                {USER_GUIDES.map((g) => {
                  const isActive = g.id === guide.id;
                  return (
                    <button
                      key={g.id}
                      onClick={() => setActiveGuideId(g.id)}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-left ${
                        isActive
                          ? 'bg-indigo-50 text-indigo-900 border border-indigo-200 dark:bg-indigo-600/30 dark:text-indigo-300 dark:border-indigo-500/40'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60'
                      }`}
                    >
                      <span className="truncate">{g.title}</span>
                      <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 ${isActive ? 'text-indigo-500' : 'text-slate-400'}`} />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Guide reading pane */}
            <div className="lg:col-span-3 space-y-5">
              <div className={`rounded-2xl p-6 border bg-white border-slate-200 shadow-sm dark:bg-[#151921] dark:border-slate-800`}>
                <div className="flex items-center gap-3 border-b pb-3 border-slate-200 dark:border-slate-800">
                  <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                    <ClipboardList className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold font-serif">{guide.title}</h2>
                    <p className="text-xs text-slate-500">Step-by-step user guide</p>
                  </div>
                </div>

                <p className="text-sm text-slate-600 dark:text-slate-300">
                  <span className="font-bold text-slate-700 dark:text-slate-200">Goal: </span>
                  {guide.goal}
                </p>

                {guide.requires && (
                  <div className="p-3 rounded-xl border text-xs bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800 text-slate-600 dark:text-slate-300">
                    <span className="font-bold">Requires: </span>{guide.requires}
                  </div>
                )}
                {guide.caution && (
                  <div className="p-3 rounded-xl border text-xs flex items-start gap-2 bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-500/30 text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{guide.caution}</span>
                  </div>
                )}

                <ol className="space-y-3">
                  {guide.steps.map((s, i) => (
                    <li key={i} className="flex gap-3 text-sm">
                      <span className="shrink-0 h-6 w-6 rounded-full bg-indigo-600 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">
                        {i + 1}
                      </span>
                      <span className="text-slate-700 dark:text-slate-300 leading-relaxed">{s}</span>
                    </li>
                  ))}
                </ol>

                <div className="p-3 rounded-xl border text-xs flex items-start gap-2 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                  <span><span className="font-bold">Result: </span>{guide.result}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* TAB 1: INTERACTIVE USER MANUAL */}
      {activeTab === 'manual' && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Chapter Sidebar */}
          <div
            className={`rounded-2xl p-4 border bg-white border-slate-200 shadow-sm dark:bg-[#151921] dark:border-slate-800`}
          >
            <div className="mb-3 relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search manual chapters..."
                value={manualSearch}
                onChange={(e) => setManualSearch(e.target.value)}
                className={`w-full rounded-xl pl-9 pr-3 py-2 text-xs font-medium border outline-none transition-all bg-slate-50 border-slate-300 text-slate-800 focus:border-indigo-500 dark:bg-[#0b0d13] dark:border-slate-700 dark:text-slate-200 dark:focus:border-indigo-500`}
              />
            </div>

            <p className="px-1 mb-2 text-[11px] font-bold tracking-wider text-slate-400 uppercase">
              Table of Contents
            </p>

            <div className="space-y-1">
              {manualChapters
                .filter((ch) => (ch?.title || '').toLowerCase().includes((manualSearch || '').toLowerCase()))
                .map((ch) => {
                  const IconComp = ch.icon;
                  const isActive = activeChapter === ch.id;
                  return (
                    <button
                      key={ch.id}
                      onClick={() => setActiveChapter(ch.id)}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-left ${isActive ? 'bg-indigo-50 text-indigo-900 border border-indigo-200 dark:bg-indigo-600/30 dark:text-indigo-300 dark:border dark:border-indigo-500/40' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800/60'}`}
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <IconComp className={`h-4 w-4 flex-shrink-0 ${isActive ? 'text-indigo-500' : 'text-slate-400'}`} />
                        <span className="truncate">{ch.title}</span>
                      </div>
                      <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 ${isActive ? 'text-indigo-500' : 'text-slate-400'}`} />
                    </button>
                  );
                })}
            </div>
          </div>

          {/* Chapter Reading Pane */}
          <div
            className={`lg:col-span-3 rounded-2xl p-6 border bg-white border-slate-200 shadow-sm dark:bg-[#151921] dark:border-slate-800`}
          >
            {activeChapter === 'overview' && (
              <div className="space-y-5 text-sm leading-relaxed">
                <div className="flex items-center gap-3 border-b pb-3 border-slate-200 dark:border-slate-800">
                  <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                    <Layers className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold font-serif">1. System Overview & Core Architecture</h2>
                    <p className="text-xs text-slate-500">Enterprise ERP & Inventory Engine</p>
                  </div>
                </div>

                <p>
                  The Enterprise ERP system is built for multi-branch retail, hardware distribution, and ISP operations.
                  It combines high-frequency stock ledger entries, MAC/PON hardware serial tracking, dual calendar (BS & AD) timestamps, and multi-tier manager approvals into a single unified workspace.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-4">
                  <div className={`p-4 rounded-xl border bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
                    <h3 className="font-bold text-xs uppercase tracking-wider text-indigo-500 mb-2">Core Enterprise Modules</h3>
                    <ul className="space-y-1.5 text-xs">
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> Multi-Branch Inventory Matrix</li>
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> ONU / Router Serial Number Tracker</li>
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> Physical Stock Count Audit</li>
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> 6-Step BS Fiscal Year Closing Wizard</li>
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> Financial Overview (Management View)</li>
                    </ul>
                  </div>

                  <div className={`p-4 rounded-xl border bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
                    <h3 className="font-bold text-xs uppercase tracking-wider text-indigo-500 mb-2">Tax & Governance Standards</h3>
                    <ul className="space-y-1.5 text-xs">
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-indigo-500" /> {getDefaultTaxRate()}% Nepali VAT Register Engine</li>
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-indigo-500" /> SLM & WDV Tax Depreciation Register</li>
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-indigo-500" /> Role-Based Approval Gateways</li>
                      <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-indigo-500" /> Immutable System Audit Trail</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {activeChapter === 'roles' && (
              <div className="space-y-5 text-sm leading-relaxed">
                <div className="flex items-center gap-3 border-b pb-3 border-slate-200 dark:border-slate-800">
                  <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold font-serif">2. User Roles & Permission Matrix</h2>
                    <p className="text-xs text-slate-500">Security Access Governance</p>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className={`font-bold border-b bg-slate-100 border-slate-200 text-slate-700 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300`}>
                      <tr>
                        <th className="p-3">Role</th>
                        <th className="p-3">Scope</th>
                        <th className="p-3">Key Privileges</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      <tr>
                        <td className="p-3 font-bold text-indigo-500">SUPER_ADMIN</td>
                        <td className="p-3">Global System</td>
                        <td className="p-3">Full privileges, fiscal year closing, branch management, profile switching.</td>
                      </tr>
                      <tr>
                        <td className="p-3 font-bold text-blue-500">BRANCH_MANAGER</td>
                        <td className="p-3">Branch Level</td>
                        <td className="p-3">Stock transfer approvals, PO authorizations, stock count reconciliations.</td>
                      </tr>
                      <tr>
                        <td className="p-3 font-bold text-amber-500">STORE_INCHARGE</td>
                        <td className="p-3">Store/Warehouse</td>
                        <td className="p-3">Inward/outward logging, physical counts, barcode scanning, shipments receiving.</td>
                      </tr>
                      <tr>
                        <td className="p-3 font-bold text-emerald-500">ACCOUNTANT</td>
                        <td className="p-3">Finance & Tax</td>
                        <td className="p-3">VAT register, purchase invoices, depreciation schedules, financial overview (management view).</td>
                      </tr>
                      <tr>
                        <td className="p-3 font-bold text-purple-500">ISP_FIELD_TECH</td>
                        <td className="p-3">Field Services</td>
                        <td className="p-3">Assigning ONU/Router serials to customers, logging defective device returns.</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeChapter === 'getting-started' && (
              <div className="space-y-4 text-sm leading-relaxed">
                <h2 className="text-xl font-bold font-serif">3. Getting Started & Account Features</h2>
                <p>
                  The whole app is organized around one always-visible sidebar and a few header controls:
                </p>
                <div className="space-y-3">
                  <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <h4 className="font-bold text-xs text-indigo-500">Accordion Sidebar</h4>
                    <p className="text-xs text-slate-500">Click a group (e.g. "Inventory & Stock") to expand its menu items right below it; click again to collapse. The header button expands/collapses ALL groups at once, and the search box (or pressing /) filters items across every group.</p>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <h4 className="font-bold text-xs text-indigo-500">Branch & Fiscal Year Selectors</h4>
                    <p className="text-xs text-slate-500">The header "Select Branch" dropdown scopes everything you see to one branch or the consolidated view; the FY selector picks the BS fiscal year for all reports and ledgers.</p>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <h4 className="font-bold text-xs text-indigo-500">Dual Calendar System (BS & AD)</h4>
                    <p className="text-xs text-slate-500">Press Alt + D or click the date toggle in the header to switch all timestamps between Bikram Sambat and Gregorian dates.</p>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <h4 className="font-bold text-xs text-indigo-500">Global Search & Barcode</h4>
                    <p className="text-xs text-slate-500">Ctrl + K (or the header search box) finds any product by name/SKU; Alt + B opens the camera barcode scanner.</p>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <h4 className="font-bold text-xs text-indigo-500">Profile & Sign-out</h4>
                    <p className="text-xs text-slate-500">Click your avatar (top-right) for your profile and session controls. Sign out on shared computers.</p>
                  </div>
                </div>
                <p className="text-xs text-slate-500">For task walkthroughs ("how do I run a stock audit?"), open the <button onClick={() => setActiveTab('guides')} className="font-bold text-indigo-600 dark:text-indigo-400 cursor-pointer">Step-by-Step Guides</button> tab.</p>
              </div>
            )}

            {activeChapter === 'tax-depreciation' && (
              <div className="space-y-5 text-sm leading-relaxed">
                <div className="flex items-center gap-3 border-b pb-3 border-slate-200 dark:border-slate-800">
                  <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <FileSpreadsheet className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold font-serif">8. Financials, VAT Register & Depreciation</h2>
                    <p className="text-xs text-slate-500">Backend-persisted fixed-asset accounting</p>
                  </div>
                </div>
                <p>Fixed assets are maintained independently from inventory opening stock. The asset register stores the supplier invoice date, capitalization date, and placed-in-service date.</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className={`rounded-xl border p-3 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
                    <h4 className="font-bold text-xs text-indigo-500">Purchase Invoice Date</h4>
                    <p className="mt-1 text-xs text-slate-500">Used for invoice/datewise purchase reporting and linked to the source invoice.</p>
                  </div>
                  <div className={`rounded-xl border p-3 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
                    <h4 className="font-bold text-xs text-indigo-500">Capitalization Date</h4>
                    <p className="mt-1 text-xs text-slate-500">Identifies when the purchase entered the fixed-asset accounting register.</p>
                  </div>
                  <div className={`rounded-xl border p-3 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
                    <h4 className="font-bold text-xs text-indigo-500">Placed-in-Service Date</h4>
                    <p className="mt-1 text-xs text-slate-500">The date used as the start point for straight-line or reducing-balance depreciation.</p>
                  </div>
                </div>
                <div className={`rounded-xl border p-4 bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-500/30`}>
                  <h4 className="font-bold text-xs text-amber-700 dark:text-amber-300">Correcting persisted values</h4>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">Super Admins can open Administration & Governance → Data Recalculation & Repair and run Recalculate Fixed Assets. This writes accumulated depreciation and net book value to PostgreSQL and creates an audit entry.</p>
                </div>
                <button onClick={() => onNavigateTab?.('data-recalculation')} className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400 cursor-pointer"><span>Open Data Recalculation & Repair</span><ArrowRight className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {activeChapter !== 'overview' && activeChapter !== 'roles' && activeChapter !== 'getting-started' && activeChapter !== 'tax-depreciation' && (
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="flex items-center gap-3 border-b pb-3 border-slate-200 dark:border-slate-800">
                  <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                    <BookOpen className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold font-serif">
                      {manualChapters.find((c) => c.id === activeChapter)?.title}
                    </h2>
                    <p className="text-xs text-slate-500">Detailed Operating Documentation</p>
                  </div>
                </div>

                <p className="text-slate-600 dark:text-slate-300">
                  Refer to the full step-by-step documentation for this module below. You can navigate directly to the respective tab or run interactive workflows.
                </p>

                <div className="p-4 rounded-2xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-xs space-y-2">
                  <div className="font-bold text-indigo-900 dark:text-indigo-200 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-amber-500" />
                    <span>Quick Interactive Action</span>
                  </div>
                  <p className="text-slate-600 dark:text-slate-300">
                    Would you like to open the interactive workflow for this module?
                  </p>
                  <div className="pt-2 flex gap-2">
                    <button
                      onClick={() => setActiveTab('workflows')}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold text-xs hover:bg-indigo-500 transition-all cursor-pointer"
                    >
                      View Operating Workflows
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: OPERATING WORKFLOWS */}
      {activeTab === 'workflows' && (
        <div className="space-y-6">
          {/* Workflow Selector Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {workflows.map((wf) => {
              const isSelected = wf.id === selectedWorkflowId;
              return (
                <button
                  key={wf.id}
                  onClick={() => setSelectedWorkflowId(wf.id)}
                  className={`p-4 rounded-2xl border text-left transition-all cursor-pointer relative ${isSelected ? 'bg-gradient-to-br from-indigo-900 to-slate-900 text-white border-indigo-500 shadow-md ring-2 ring-indigo-500/50' : 'bg-white border-slate-200 text-slate-800 hover:border-slate-300 shadow-xs dark:bg-[#151921] dark:border-slate-800 dark:text-slate-300 dark:hover:border-slate-700'}`}
                >
                  <span
                    className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider mb-2 ${
                      isSelected
                        ? 'bg-indigo-500/30 text-indigo-300 border border-indigo-400/40'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                    }`}
                  >
                    {wf.category}
                  </span>
                  <h3 className="font-bold text-sm leading-snug">{wf.title}</h3>
                  <p
                    className={`mt-1 text-xs line-clamp-2 ${
                      isSelected ? 'text-indigo-200/80' : 'text-slate-500'
                    }`}
                  >
                    {wf.description}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Detailed Workflow Flowchart Steps */}
          <div
            className={`rounded-2xl p-6 border bg-white border-slate-200 shadow-sm dark:bg-[#151921] dark:border-slate-800`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b pb-4 mb-6 border-slate-200 dark:border-slate-800">
              <div>
                <span className="text-xs font-bold text-indigo-500 uppercase tracking-wider">
                  {selectedWorkflow.category}
                </span>
                <h2 className="text-xl font-bold font-serif">{selectedWorkflow.title}</h2>
                <p className="text-xs text-slate-500">{selectedWorkflow.description}</p>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-300/30">
                  {selectedWorkflow.steps.length} Sequential Steps
                </span>
              </div>
            </div>

            {/* Stepper Steps Display */}
            <div className="space-y-6">
              {selectedWorkflow.steps.map((st, idx) => (
                <div key={st.step} className="flex gap-4 relative">
                  {/* Step Connector Line */}
                  {idx < selectedWorkflow.steps.length - 1 && (
                    <div className="absolute left-5 top-10 bottom-0 w-0.5 bg-indigo-200 dark:bg-slate-800"></div>
                  )}

                  {/* Step Number Circle */}
                  <div className="flex-shrink-0 h-10 w-10 rounded-xl bg-indigo-600 text-white font-bold flex items-center justify-center text-sm shadow-md shadow-indigo-500/20 z-10">
                    {st.step}
                  </div>

                  {/* Step Info Card */}
                  <div
                    className={`flex-1 rounded-2xl p-4 border transition-all bg-slate-50 border-slate-200 dark:bg-slate-900/70 dark:border-slate-800`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                      <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100 flex items-center gap-2">
                        <span>{st.title}</span>
                      </h4>
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-300/30 w-fit">
                        <Users className="h-3 w-3" />
                        <span>{st.role}</span>
                      </span>
                    </div>

                    <p className="text-xs text-slate-600 dark:text-slate-300 mb-3 leading-relaxed">
                      {st.description}
                    </p>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200/80 dark:border-slate-800">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-bold text-slate-400">Key Deliverables:</span>
                        {st.keyOutputs.map((out) => (
                          <span
                            key={out}
                            className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20"
                          >
                            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                            <span>{out}</span>
                          </span>
                        ))}
                      </div>

                      {st.actionTab && (
                        <button
                          onClick={() => {
                            if (st.actionTab === 'barcode-scanner') {
                              if (onOpenBarcodeModal) {
                                onOpenBarcodeModal();
                              } else if (onNavigateTab) {
                                onNavigateTab('barcode-scanner');
                              }
                            } else if (st.actionTab === 'users-management' || st.actionTab === 'login') {
                              if (onNavigateTab) onNavigateTab('users');
                            } else if (onNavigateTab && st.actionTab) {
                              onNavigateTab(st.actionTab);
                            }
                          }}
                          className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 cursor-pointer transition-all"
                        >
                          <span>{st.actionTab === 'barcode-scanner' ? 'Launch Barcode Scanner' : 'Go to Module'}</span>
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: KEYBOARD SHORTCUTS CHEAT SHEET */}
      {activeTab === 'shortcuts' && (
        <div
          className={`rounded-2xl p-6 border bg-white border-slate-200 shadow-sm dark:bg-[#151921] dark:border-slate-800`}
        >
          <div className="flex items-center gap-3 border-b pb-4 mb-6 border-slate-200 dark:border-slate-800">
            <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400">
              <Keyboard className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif">Keyboard Shortcuts Cheat Sheet</h2>
              <p className="text-xs text-slate-500">Speed up your daily inventory and auditing workflow</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {shortcuts.map((sc) => (
              <div
                key={sc.key}
                className={`p-4 rounded-xl border flex items-center justify-between gap-3 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
              >
                <div>
                  <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 mb-1">
                    {sc.category}
                  </span>
                  <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">{sc.description}</p>
                </div>

                <div className="flex items-center gap-2">
                  <kbd className="px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white font-mono font-bold text-xs shadow-xs border border-indigo-400/30 whitespace-nowrap">
                    {sc.key}
                  </kbd>
                  <button
                    onClick={() => handleCopyCode(sc.key)}
                    className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-all cursor-pointer"
                    title="Copy Shortcut"
                  >
                    {copiedShortcut === sc.key ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: INTERACTIVE FAQ */}
      {activeTab === 'faq' && (
        <div className="space-y-6">
          <div
            className={`rounded-2xl p-6 border bg-white border-slate-200 shadow-sm dark:bg-[#151921] dark:border-slate-800`}
          >
            {/* Filter Search Header */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-6">
              <div className="relative w-full sm:w-80">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search questions or keywords..."
                  value={faqSearch}
                  onChange={(e) => setFaqSearch(e.target.value)}
                  className={`w-full rounded-xl pl-9 pr-3 py-2 text-xs font-medium border outline-none transition-all bg-slate-50 border-slate-300 text-slate-800 focus:border-indigo-500 dark:bg-[#0b0d13] dark:border-slate-700 dark:text-slate-200 dark:focus:border-indigo-500`}
                />
              </div>

              <div className="flex items-center gap-1 overflow-x-auto w-full sm:w-auto">
                {['all', 'General', 'Inventory', 'ISP Hardware', 'Finance', 'Permissions'].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setFaqCategory(cat)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold capitalize transition-all cursor-pointer whitespace-nowrap ${faqCategory === cat ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Questions List */}
            <div className="space-y-4">
              {filteredFaqs.map((faq, idx) => (
                <div
                  key={idx}
                  className={`p-4 rounded-2xl border transition-all bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
                >
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-500 mt-0.5">
                      <HelpCircle className="h-4 w-4" />
                    </div>
                    <div>
                      <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 mb-1">
                        {faq.category}
                      </span>
                      <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100 mb-1">
                        {faq.question}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        {faq.answer}
                      </p>
                    </div>
                  </div>
                </div>
              ))}

              {filteredFaqs.length === 0 && (
                <div className="text-center py-10 text-slate-400 text-xs">
                  No matching questions found for &quot;{faqSearch}&quot;.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: SYSTEM DIAGNOSTICS */}
      {activeTab === 'system-diagnostics' && (
        <div
          className={`rounded-2xl p-6 border bg-white border-slate-200 shadow-sm dark:bg-[#151921] dark:border-slate-800`}
        >
          <div className="flex items-center justify-between border-b pb-4 mb-6 border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
                <Cpu className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold font-serif">System Diagnostic Self-Test</h2>
                <p className="text-xs text-slate-500">Run quick health checks on local storage, session state, and network connectivity</p>
              </div>
            </div>

            <button
              onClick={runDiagnostics}
              disabled={diagRunning}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-md transition-all cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${diagRunning ? 'animate-spin' : ''}`} />
              <span>{diagRunning ? 'Running Test...' : 'Run Diagnostics'}</span>
            </button>
          </div>

          {!diagResults && !diagRunning && (
            <div className="text-center py-12 text-slate-500 text-xs">
              Click <span className="font-bold text-indigo-500">&quot;Run Diagnostics&quot;</span> above to evaluate browser compatibility, user authentication context, and active branch scope.
            </div>
          )}

          {diagResults && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-xs font-semibold text-indigo-900 dark:text-indigo-200 flex justify-between items-center">
                <span>Last Diagnostic Run Timestamp:</span>
                <span className="font-mono text-indigo-600 dark:text-indigo-400">{diagResults.timestamp}</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div
                  className={`p-4 rounded-xl border flex items-center justify-between ${
                    diagResults.storageOk
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-900 dark:text-emerald-200'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-900 dark:text-rose-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    <div>
                      <h4 className="font-bold text-xs">Browser Local Storage API</h4>
                      <p className="text-[11px] opacity-80">Local state persistence available</p>
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold uppercase">Pass</span>
                </div>

                <div
                  className={`p-4 rounded-xl border flex items-center justify-between ${
                    diagResults.authOk
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-900 dark:text-emerald-200'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-900 dark:text-amber-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <ShieldCheck className="h-5 w-5 text-indigo-500" />
                    <div>
                      <h4 className="font-bold text-xs">User Authentication Context</h4>
                      <p className="text-[11px] opacity-80">
                        {currentUser?.email || 'No user active'}
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold uppercase">
                    {diagResults.authOk ? 'Valid' : 'Guest'}
                  </span>
                </div>

                <div
                  className={`p-4 rounded-xl border flex items-center justify-between ${
                    diagResults.networkOk
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-900 dark:text-emerald-200'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-900 dark:text-rose-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Zap className="h-5 w-5 text-amber-500" />
                    <div>
                      <h4 className="font-bold text-xs">Network Connection Status</h4>
                      <p className="text-[11px] opacity-80">Online status active</p>
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold uppercase">Connected</span>
                </div>

                <div
                  className={`p-4 rounded-xl border flex items-center justify-between ${
                    diagResults.branchOk
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-900 dark:text-emerald-200'
                      : 'bg-indigo-500/10 border-indigo-500/30 text-indigo-900 dark:text-indigo-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Building2 className="h-5 w-5 text-indigo-500" />
                    <div>
                      <h4 className="font-bold text-xs">Active Branch Scope</h4>
                      <p className="text-[11px] opacity-80">
                        {currentUser?.branchId || 'All Branches (HQ)'}
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold uppercase">Active</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
