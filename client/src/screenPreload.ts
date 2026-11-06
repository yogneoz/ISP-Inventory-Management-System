/**
 * Saved-tab screen preloader.
 *
 * `React.lazy` starts the screen's chunk when the route first renders, which
 * means a reload paints the workspace's "Loading module..." fallback while the
 * chunk downloads. The boot splash is already on screen at that point, so the
 * app can start the saved tab's import BEFORE mounting React and let the splash
 * cover the download. The fallback then has nothing left to wait for.
 *
 * Keep this map in step with the lazy declarations in App.tsx: it is the same
 * module path, just imported earlier. Eager screens (Dashboard, Product
 * Management, Stock Operations, ...) need no entry because they are already in
 * the startup graph. tests/screenPreload.test.ts cross-checks the tabs.
 */
export const ACTIVE_TAB_STORAGE_KEY = 'inventory_active_tab';

export type ScreenModuleLoader = () => Promise<unknown>;

// Tabs sharing one lazy screen share one loader, so the path is written once.
const loadPurchaseInvoices = () => import('./features/procurement/PurchaseInvoices');
const loadSalesInvoices = () => import('./features/sales/SalesInvoices');
const loadReturnsRegister = () => import('./features/sales/ReturnsRegister');
const loadShipments = () => import('./features/procurement/Shipments');

export const SCREEN_PRELOADERS: Readonly<Record<string, ScreenModuleLoader>> = {
  approvals: () => import('./features/settings/ApprovalWorkflowCenter'),
  'opening-stock': () => import('./features/finance/OpeningStockManager'),
  'category-management': () => import('./features/inventory/CategoryManagement'),
  'product-group-management': () => import('./features/inventory/ProductGroupManagement'),
  'uom-management': () => import('./features/inventory/UomManagement'),
  'import-stock': () => import('./features/inventory/ImportStock'),
  'export-stock': () => import('./features/inventory/ExportStock'),
  'branch-stock': () => import('./features/inventory/BranchStockTracking'),
  'reorder-stock': () => import('./features/inventory/ReorderStockTracking'),
  'damaged-stock': () => import('./features/inventory/DamagedStockTracking'),
  'stock-valuation': () => import('./features/inventory/StockValuation'),
  'stock-ledger': () => import('./features/inventory/StockMovementLedger'),
  'physical-stock-audit': () => import('./features/inventory/PhysicalStockAudit'),
  'fixed-assets': () => import('./features/finance/FixedAssetRegister'),
  customers: () => import('./features/sales/CustomerMasterDirectory'),
  'sales-agents-areas': () => import('./features/sales/SalesAgentsAreasManagement'),
  'customer-devices': () => import('./features/sales/CustomersManagement'),
  'complete-serial-inventory': () => import('./features/inventory/SerialLogRegister'),
  locations: () => import('./features/settings/LocationsManagement'),
  permissions: () => import('./features/settings/PermissionManagement'),
  'user-permissions': () => import('./features/settings/UserPermissions'),
  'import-customers': () => import('./features/sales/ImportCustomers'),
  'create-purchase': loadPurchaseInvoices,
  'purchase-list': loadPurchaseInvoices,
  'create-sale': loadSalesInvoices,
  'sales-list': loadSalesInvoices,
  'purchase-returns': loadReturnsRegister,
  'create-purchase-return': loadReturnsRegister,
  'sales-returns': loadReturnsRegister,
  'create-sales-return': loadReturnsRegister,
  'create-shipment': loadShipments,
  'shipment-list': loadShipments,
  'asset-deployments': () => import('./features/inventory/AssetDeployments'),
  'supplier-warranty': () => import('./features/inventory/SupplierWarrantyRegister'),
  'seller-warranty': () => import('./features/inventory/SellerWarrantyRegister'),
  'clear-demo-data': () => import('./components/common/ClearDemoDataView'),
  accounting: () => import('./features/finance/TrialBalanceRegister'),
  'accounting-profit-loss': () => import('./features/finance/ProfitAndLossRegister'),
  'accounting-balance-sheet': () => import('./features/finance/BalanceSheetRegister'),
  'accounting-cash-flow': () => import('./features/finance/CashFlowRegister'),
  'accounting-cash-book': () => import('./features/finance/CashBookRegister'),
  'accounting-aging': () => import('./features/finance/AgingRegister'),
  'journal-entry': () => import('./features/finance/VoucherEntries'),
  'cash-bank-entry': () => import('./features/finance/VoucherEntries'),
  'accounting-chart': () => import('./features/finance/ChartOfAccountsRegister'),
  'general-ledger': () => import('./features/finance/GeneralLedgerMaster'),
  subledgers: () => import('./features/finance/SubledgersManagement'),
  'bill-terms': () => import('./features/finance/BillTermsManagement'),
  'cost-centers': () => import('./features/finance/CostCentersManagement'),
  'narration-templates': () => import('./features/finance/NarrationTemplatesManagement'),
  'cash-position': () => import('./features/finance/DailyCashClose'),
  'financial-statements': () => import('./features/finance/FinancialStatements'),
  'vendor-ledger': () => import('./features/finance/VendorLedger'),
  'customer-ledger': () => import('./features/finance/CustomerLedger'),
  'vendor-opening-balances': () => import('./features/finance/VendorOpeningBalances'),
  'vat-register': () => import('./features/finance/VatRegister'),
  'depreciation-register': () => import('./features/finance/DepreciationRegister'),
  audit: () => import('./features/finance/AuditTrailReports'),
  'data-recalculation': () => import('./features/settings/DataRecalculationMaintenance'),
  'fiscal-year-closing': () => import('./features/finance/FiscalYearClosingWizard'),
  'bs-calendar': () => import('./features/finance/BsCalendarUtility'),
  'fiscal-year-management': () => import('./features/finance/DocumentNumbering'),
  'nepali-fiscal': () => import('./features/finance/NepaliFiscalManagement'),
  'help-documentation': () => import('./components/common/HelpDocumentation'),
  // Dev-only screen; the tab is hidden in production, and importing the chunk
  // there would ship a screen no user can open.
  ...(import.meta.env?.DEV
    ? { 'dev-statcard': () => import('./features/dev/StatCardShowcase') }
    : {}),
};

/** Start the saved tab's chunk. Unknown/eager tabs resolve to undefined. */
export function preloadScreenModule(
  tab: string | null | undefined
): Promise<unknown> | undefined {
  if (!tab) return undefined;
  return SCREEN_PRELOADERS[tab]?.();
}
