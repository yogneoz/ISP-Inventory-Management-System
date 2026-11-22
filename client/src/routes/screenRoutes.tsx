/**
 * The screen route table.
 *
 * A4: every tab is declared exactly once, in render order, as an `AppRoute`
 * entry from the `screenRoute` factory. The root builds the `ScreenRouteProps`
 * bundle from its data and callbacks and hands it here; `AppRoutes` owns the
 * keep-mounted wiring and the permission metadata rides on each entry.
 *
 * The bundle is one object rather than forty props because the table is the
 * bundle's only consumer: the root types the object once against the interface
 * below instead of redeclaring 90-odd members at the call site.
 */
import React, { type Dispatch, type SetStateAction } from 'react';

import { Dashboard } from '../features/dashboard/Dashboard';
import { ProductManagement } from '../features/inventory/ProductManagement';
import { StockOperations } from '../features/inventory/StockOperations';
import { PurchaseOrders } from '../features/procurement/PurchaseOrders';
import { ReceiveInboundWarehouse } from '../features/procurement/ReceiveInboundWarehouse';
import { SuppliersManagement } from '../features/procurement/SuppliersManagement';
import { BranchesManagement } from '../features/settings/BranchesManagement';
import { CompanySetupManagement } from '../features/settings/CompanySetupManagement';
import { LoginLocks } from '../features/settings/LoginLocks';
import { api } from '../services/api';

import {
  BranchStockTracking, FixedAssetRegister, CustomersManagement, CustomerMasterDirectory,
  SalesAgentsAreasManagement, SerialLogRegister, PurchaseInvoices, SalesInvoices, ReturnsRegister, Shipments,
  PhysicalStockAudit, DamagedStockTracking, ReorderStockTracking, StockValuation, StockMovementLedger,
  AssetDeployments, SupplierWarrantyRegister, FieldWorkOrders, SellerWarrantyRegister, CategoryManagement,
  ProductGroupManagement, UomManagement, ImportStock, ExportStock, TrialBalanceRegister,
  BsLedgerSummaryRegister, ProfitAndLossRegister, BranchConsolidatedRegister, BalanceSheetRegister,
  CashFlowRegister, CashBookRegister, RecurringCloseRegister, AgingRegister, ChartOfAccountsRegister,
  PostingRulesRegister, JournalEntry, CashBankEntry, PostedVouchers, PayrollPostingsRegister,
  SubledgersManagement, LendersManagement, BillTermsManagement, CostCentersManagement, EmployeeDirectory,
  EmployeeSelfService, EmployeePayslips, EmployeeLeave, EmployeeAttendance, EmployeeDocuments, Recruitment,
  Performance, Lifecycle, HrReports, AttendanceLeave, OrgMasters, OrgChart, Payroll,
  NarrationTemplatesManagement, DailyCashClose, FinanceDashboard, CompanyOverview, VatRegister,
  DepreciationRegister, AuditTrailReports, DocumentNumbering, OpeningStockManager, VendorOpeningBalances,
  VendorLedger, CustomerLedger, EmployeeLedger, FiscalYearClosingWizard, LocationsManagement,
  ImportCustomers, ClearDemoDataView, DataRecalculationMaintenance, BsCalendarUtility,
  NepaliFiscalManagement, PermissionManagementLazy, ApiKeysLazy, IntegrationPartnersLazy,
  UserPermissionsLazy, UsersManagementLazy,
  ApprovalWorkflowCenter, HelpDocumentationLazy
} from './lazyScreens';
import { screenRoute, type AppRoute } from './appRoutes';
import type { RecordRoute } from './appPaths';
import type {
  ApprovalRequest,
  Asset,
  CompanyProfile,
  FiscalYear,
  InventoryStock,
  Product,
  PurchaseInvoice,
  PurchaseOrder,
  PurchaseReturn,
  SalesInvoice,
  SalesReturn,
  Shipment,
  StockOperation,
  User,
} from '../types';
import type { NavTab } from '../components/layout/Sidebar';
import type { BsCalendarCoverageStatus } from '../utils/nepaliCalendar';
import type { RegisterRefreshKey } from '../utils/registerRefreshDomains';
import type { UserAccessFocusRequest } from '../features/settings/UserPermissions';
import type { OrderFormLine } from '../features/procurement/PurchaseOrders';

// DEV-ONLY: StatCard design-review gallery (hidden dev-statcard tab).
// Gated behind import.meta.env.DEV so the chunk is tree-shaken out of
// production builds entirely; the sidebar entry is gated the same way.
// `?.` because `import.meta.env` only exists under Vite: the A6 route-tree
// test loads this module under node:test (same guard as Sidebar).
const StatCardShowcase = import.meta.env?.DEV
  ? React.lazy(() => import('../features/dev/StatCardShowcase').then((m) => ({ default: m.StatCardShowcase })))
  : () => null;

/** Everything the table builds its elements from — the root's props bundle. */
export type ScreenRouteProps = [
  NavTab, // activeTab
  Record<string, string>, // appSettings
  string, // assetReportAsOfDateAD
  BsCalendarCoverageStatus | null, // bsCalendarCoverage
  "bs-calendar" | "nepali-fiscal", // bsCalendarSeedTab
  CompanyProfile | null, // companyProfile
  User, // currentUser
  "BS" | "AD", // dateMode
  FiscalYear[], // fiscalYears
  (key: string, value: string) => void, // handleAppSettingChange
  (id: string) => Promise<void>, // handleApprovePurchaseReturn
  (id: string) => Promise<void>, // handleApproveSalesReturn
  (updates: { stockId: string; minReorderLevel: number; }[]) => Promise<void>, // handleBulkUpdateStockReorderLevels
  (id: string, reason?: string) => Promise<void>, // handleCancelApprovalRequest
  (id: string, reason: string) => Promise<void>, // handleCancelPurchaseReturn
  (id: string, reason?: string) => Promise<void>, // handleCancelReceiveShipment
  (id: string, reason?: string) => Promise<void>, // handleCancelSalesInvoice
  (id: string, reason: string) => Promise<void>, // handleCancelSalesReturn
  (id: string, credentials?: { adminEmail: string; adminPassword: string; }) => Promise<void>, // handleCloseFiscalYear
  (requestData: Omit<ApprovalRequest, "id" | "requestNumber" | "status" | "requestedAtAD" | "requestedAtBS">) => Promise<void>, // handleCreateApprovalRequest
  (asset: Omit<Asset, "id" | "netBookValue" | "accumulatedDepreciation"> & { supplierWarrantyEndDateAD?: string; supplierWarrantyCovered?: boolean; }) => Promise<void>, // handleCreateAsset
  (input: { code: string; startDateAD: string; endDateAD: string; startDateBS: string; endDateBS: string; }) => Promise<FiscalYear>, // handleCreateFiscalYear
  (inv: Omit<PurchaseInvoice, "id" | "invoiceNumber">) => Promise<void>, // handleCreateInvoice
  (op: Partial<StockOperation>) => Promise<void>, // handleCreateOperation
  (po: Omit<PurchaseOrder, "id" | "poNumber" | "subtotalAmount" | "taxAmount" | "totalAmount">) => Promise<void>, // handleCreatePO
  (prod: Omit<Product, "id">) => Promise<void>, // handleCreateProduct
  (payload: any) => Promise<any>, // handleCreatePurchaseReturn
  (inv: Omit<SalesInvoice, "id" | "invoiceNumber">) => Promise<void>, // handleCreateSalesInvoice
  (payload: any) => Promise<SalesReturn>, // handleCreateSalesReturn
  (id: string) => Promise<{ message: string; id: string; }>, // handleDeleteFiscalYear
  (invoiceId: string) => Promise<void>, // handleDeleteInvoice
  (poId: string) => Promise<void>, // handleDeletePO
  (id: string) => Promise<void>, // handleDeleteProduct
  (key: string, branchId?: string) => Promise<Shipment | null>, // handleFindShipment
  () => void, // handleGroupLowStockPO
  (tab: string) => void, // handleHelpNavigateTab
  (id: string) => Promise<{ targetFiscalYear: FiscalYear; recordsCreated: number; manualRowsPreserved?: number; }>, // handleInitializeFiscalYearOpeningStock
  () => void, // handleLogout
  (id: string, status: "APPROVED" | "REJECTED", rejectionReason?: string) => Promise<void>, // handleProcessApprovalRequest
  (id: string) => Promise<void>, // handleReceiveOperation
  (id: string, verificationData?: { receivedItems?: { itemId: string; quantityReceived: number; receivedSerials?: { deviceSerial: string; ponSerial?: string; }[]; itemDiscrepancyNotes?: string; }[]; receivedByNotes?: string; }) => Promise<void>, // handleReceiveShipment
  (invoice: SalesInvoice, amount: number, paymentMethod: string, settlementAccountId?: string, wallet?: { providerCode: string; providerTransactionId: string; feeAmount: number; }) => Promise<void>, // handleRecordCustomerPayment
  (id: string, amount: number, paymentMethod?: string, details?: { bankName?: string; bankBranch?: string; accountNumber?: string; chequeNumber?: string; transactionReference?: string; settlementAccountId?: string; paymentDateAD?: string; }) => Promise<void>, // handleRecordPayment
  (record: RecordRoute | null) => void, // handleRecordRouteChange
  (id: string, credentials?: { adminEmail: string; adminPassword: string; }) => Promise<void>, // handleReopenFiscalYear
  (invoiceId: string, reason: string) => Promise<void>, // handleReverseInvoicePayments
  (paymentId: string, reason: string) => Promise<void>, // handleReversePayment
  (id: string, reason?: string) => Promise<void>, // handleReverseStockOperation
  (id: string) => Promise<{ targetFiscalYear: FiscalYear; recordsCreated: number; manualRowsPreserved?: number; }>, // handleRollForwardVendorOpenings
  (bId: string) => void, // handleSelectBranch
  (tab: NavTab) => void, // handleSelectTab
  (id: string) => Promise<void>, // handleSetCurrentFiscalYear
  (id: string, updates: Asset["status"] | Partial<Asset>) => Promise<void>, // handleUpdateAssetStatus
  (poId: string, poData: Partial<PurchaseOrder>) => Promise<void>, // handleUpdatePO
  (poId: string, status: string) => Promise<void>, // handleUpdatePOStatus
  (id: string, prod: Partial<Product>) => Promise<void>, // handleUpdateProduct
  (stockId: string, newQty: number, reason: string, damagedQty?: number, changeType?: string) => Promise<void>, // handleUpdateStockLevel
  (stockId: string, minReorderLevel: number) => Promise<void>, // handleUpdateStockReorderLevel
  { tab: "vendor-ledger" | "customer-ledger" | "employee-ledger"; partyId: string; partyLabel?: string | undefined; token: number; } | null, // ledgerPartyFocus
  (branchId?: string) => Promise<void>, // loadSellableSerials
  (userId: string, operationId?: string) => void, // openUserAccess
  Record<string, Record<string, boolean>> | null, // permissionsMatrix
  OrderFormLine[], // prepopulatedPOLines
  { pendingPurchaseOrders: PurchaseOrder[]; unpaidInvoiceCount: number; loading: boolean; error: string; }, // procurementPending
  Product[], // products
  PurchaseInvoice[], // purchaseInvoices
  PurchaseOrder[], // purchaseOrders
  PurchaseReturn[], // purchaseReturns
  RecordRoute | null, // recordRoute
  () => Promise<void>, // refreshAllData
  Record<RegisterRefreshKey, number>, // registerRefresh
  (fiscalYears: FiscalYear[]) => FiscalYear | undefined, // resolveDefaultFiscalYear
  SalesReturn[], // salesReturns
  string, // searchQuery
  string, // selectedBranchId
  FiscalYear | undefined, // selectedFiscalYear
  string, // selectedFiscalYearId
  string, // sellableSerialsError
  boolean, // sellableSerialsLoading
  Dispatch<SetStateAction<NavTab>>, // setActiveTab
  Dispatch<SetStateAction<Record<string, string>>>, // setAppSettings
  Dispatch<SetStateAction<string | null>>, // setLoginNotice
  Dispatch<SetStateAction<string>>, // setSearchQuery
  Dispatch<SetStateAction<string>>, // setSelectedBranchId
  Dispatch<SetStateAction<string>>, // setSelectedFiscalYearId
  string, // settingsBackfillError
  boolean, // settingsBackfillLoading
  Shipment[], // shipments
  InventoryStock[], // stock
  StockOperation[], // stockOperations
  UserAccessFocusRequest | null, // userAccessFocus
];

/** The 110 tabs, in render order. */
export function buildScreenRoutes(props: ScreenRouteProps): AppRoute[] {
  const [
   activeTab, appSettings, assetReportAsOfDateAD, bsCalendarCoverage, bsCalendarSeedTab, companyProfile, currentUser, dateMode,
   fiscalYears, handleAppSettingChange, handleApprovePurchaseReturn, handleApproveSalesReturn, handleBulkUpdateStockReorderLevels, handleCancelApprovalRequest, handleCancelPurchaseReturn, handleCancelReceiveShipment,
   handleCancelSalesInvoice, handleCancelSalesReturn, handleCloseFiscalYear, handleCreateApprovalRequest, handleCreateAsset, handleCreateFiscalYear, handleCreateInvoice, handleCreateOperation,
   handleCreatePO, handleCreateProduct, handleCreatePurchaseReturn, handleCreateSalesInvoice, handleCreateSalesReturn, handleDeleteFiscalYear, handleDeleteInvoice, handleDeletePO,
   handleDeleteProduct, handleFindShipment, handleGroupLowStockPO, handleHelpNavigateTab, handleInitializeFiscalYearOpeningStock, handleLogout, handleProcessApprovalRequest, handleReceiveOperation,
   handleReceiveShipment, handleRecordCustomerPayment, handleRecordPayment, handleRecordRouteChange, handleReopenFiscalYear, handleReverseInvoicePayments, handleReversePayment, handleReverseStockOperation,
   handleRollForwardVendorOpenings, handleSelectBranch, handleSelectTab, handleSetCurrentFiscalYear, handleUpdateAssetStatus, handleUpdatePO, handleUpdatePOStatus, handleUpdateProduct,
   handleUpdateStockLevel, handleUpdateStockReorderLevel, ledgerPartyFocus, loadSellableSerials, openUserAccess, permissionsMatrix, prepopulatedPOLines, procurementPending,
   products, purchaseInvoices, purchaseOrders, purchaseReturns, recordRoute, refreshAllData, registerRefresh, resolveDefaultFiscalYear,
   salesReturns, searchQuery, selectedBranchId, selectedFiscalYear, selectedFiscalYearId, sellableSerialsError, sellableSerialsLoading, setActiveTab,
   setAppSettings, setLoginNotice, setSearchQuery, setSelectedBranchId, setSelectedFiscalYearId, settingsBackfillError, settingsBackfillLoading, shipments,
   stock, stockOperations, userAccessFocus,
  ] = props;

  return [
    screenRoute('company-overview', (
        <CompanyOverview
          currentUser={currentUser}
          pendingPurchaseOrders={procurementPending.pendingPurchaseOrders}
          unpaidInvoiceCount={procurementPending.unpaidInvoiceCount}
          selectedBranchId={selectedBranchId}
          fiscalYearId={selectedFiscalYear?.id}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          cardOrderByRole={appSettings.companyOverviewCardOrderByRole}
          onCardOrderSaved={(raw) =>
            setAppSettings((prev) => ({ ...prev, companyOverviewCardOrderByRole: raw }))
          }
          onNavigateTab={setActiveTab}
        />
    )),
    screenRoute('dashboard', (
      <Dashboard
        currentUser={currentUser}
        pendingPurchaseOrders={procurementPending.pendingPurchaseOrders}
        selectedBranchId={selectedBranchId}
        fiscalYearId={selectedFiscalYear?.id}
        fiscalYearStartAD={selectedFiscalYear?.startDateAD}
        fiscalYearEndAD={selectedFiscalYear?.endDateAD}
        sseRefreshKey={registerRefresh.transactionLog}
        dateMode={dateMode}
        asOfDateAD={assetReportAsOfDateAD}
        onNavigateTab={setActiveTab}
        onSelectBranch={handleSelectBranch}
        onGroupLowStockPO={handleGroupLowStockPO}
        onUpdateStockLevel={handleUpdateStockLevel}
        bsCalendarCoverage={bsCalendarCoverage}
        bsCalendarSeedTab={bsCalendarSeedTab}
      />
    )),
    screenRoute('approvals', (
        <ApprovalWorkflowCenter
          currentUser={currentUser}
          dateMode={dateMode}
          onProcessApproval={handleProcessApprovalRequest}
          onCancelApproval={handleCancelApprovalRequest}
          onNavigateToStockAudit={(branchId) => {
            if (branchId && branchId !== 'ALL') {
              setSelectedBranchId(branchId);
            }
            setActiveTab('physical-stock-audit');
          }}
        />
    )),
    screenRoute('all-stock', (
      <ProductManagement
        currentUser={currentUser}
        selectedBranchId={selectedBranchId}
        onCreateProduct={handleCreateProduct}
        onUpdateProduct={handleUpdateProduct}
        onDeleteProduct={handleDeleteProduct}
        searchQuery={searchQuery}
        mode="all-stock"
      />
    )),
    screenRoute('product-master', (
      <ProductManagement
        currentUser={currentUser}
        selectedBranchId={selectedBranchId}
        onCreateProduct={handleCreateProduct}
        onUpdateProduct={handleUpdateProduct}
        onDeleteProduct={handleDeleteProduct}
        searchQuery={searchQuery}
        mode="product-master"
      />
    )),
    screenRoute('opening-stock', (
        <OpeningStockManager
          currentUser={currentUser}
          fiscalYears={fiscalYears}
          onRefreshData={refreshAllData}
          selectedFiscalYearId={selectedFiscalYearId}
          onSelectFiscalYear={setSelectedFiscalYearId}
        />
    )),
    screenRoute('category-management', (
        <CategoryManagement
          currentUser={currentUser}
        />
    )),
    screenRoute('product-group-management', (
        <ProductGroupManagement
          currentUser={currentUser}
        />
    )),
    screenRoute('uom-management', (
        <UomManagement
          currentUser={currentUser}
        />
    )),
    screenRoute('import-stock', (
        <ImportStock
          onCreateProduct={handleCreateProduct}
          onUpdateProduct={handleUpdateProduct}
          onRefreshData={refreshAllData}
        />
    )),
    screenRoute('export-stock', (
        <ExportStock
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
        />
    )),
    screenRoute('branch-stock', (
        <BranchStockTracking
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
          onUpdateStockLevel={handleUpdateStockLevel}
        />
    )),
    screenRoute('reorder-stock', (
        <ReorderStockTracking
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
          onUpdateStockLevel={handleUpdateStockLevel}
          onUpdateStockReorderLevel={handleUpdateStockReorderLevel}
          onBulkUpdateStockReorderLevels={handleBulkUpdateStockReorderLevels}
          onGroupLowStockPO={handleGroupLowStockPO}
          onNavigateTab={setActiveTab}
        />
    )),
    screenRoute('damaged-stock', (
        <DamagedStockTracking
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          onUpdateStockLevel={handleUpdateStockLevel}
          onCreateOperation={handleCreateOperation}
          onReverseStockOperation={handleReverseStockOperation}
          onNavigateTab={setActiveTab}
        />
    )),
    screenRoute('stock-valuation', (
        <StockValuation
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
        />
    )),
    screenRoute('stock-ledger', (
        <StockMovementLedger
          shipments={shipments}
          selectedBranchId={selectedBranchId}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          sseRefreshKey={registerRefresh.transactionLog}
          dateMode={dateMode}
        />
    )),
    screenRoute('physical-stock-audit', (
        <PhysicalStockAudit
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          onUpdateStockLevel={handleUpdateStockLevel}
          onReconcileStockAudit={async (payload) => {
            await api.reconcileStockAudit(payload);
            await refreshAllData();
          }}
          onRequestApproval={handleCreateApprovalRequest}
          onCancelApproval={handleCancelApprovalRequest}
          onProcessApproval={handleProcessApprovalRequest}
          onNavigateTab={setActiveTab}
          companyWideBlindCount={appSettings.companyWideBlindCount === 'true'}
          // Unknown settings must not present the toggle as a known
          // "off": disable it until the read above succeeds (DF-17).
          settingsUnknown={Boolean(settingsBackfillError) || settingsBackfillLoading}
          onCompanyWideBlindCountChange={(next) =>
            handleAppSettingChange('companyWideBlindCount', next ? 'true' : 'false')
          }
        />
    )),
    screenRoute('fixed-assets', (
        <FixedAssetRegister
          currentUser={currentUser}
          refreshToken={registerRefresh.fixedAssets}
          selectedBranchId={selectedBranchId}
          asOfDateAD={assetReportAsOfDateAD}
          dateMode={dateMode}
          onCreateAsset={handleCreateAsset}
          onUpdateAssetStatus={handleUpdateAssetStatus}
          recordRoute={activeTab === 'fixed-assets' ? recordRoute : null}
          onRecordRouteChange={handleRecordRouteChange}
        />
    )),
    screenRoute('dev-statcard', (
        <StatCardShowcase />
    ), { enabled: Boolean(import.meta.env?.DEV) }),
    screenRoute('customers', (
        <CustomerMasterDirectory
          currentUser={currentUser}
          refreshKey={registerRefresh.customerDevices}
          onCustomersChanged={refreshAllData}
          onNavigateToImport={() => setActiveTab('import-customers')}
          onSelectTab={(tab, filter) => {
            setActiveTab(tab as any);
            if (filter) setSearchQuery(filter);
          }}
          recordRoute={activeTab === 'customers' ? recordRoute : null}
          onRecordRouteChange={handleRecordRouteChange}
        />
    )),
    screenRoute('sales-agents-areas', (
        <SalesAgentsAreasManagement currentUser={currentUser} />
    )),
    screenRoute('customer-devices', (
        <CustomersManagement
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          onCreateCustomerDevice={async (newRecord) => {
            await api.createCustomerDevice(newRecord);
            await refreshAllData();
          }}
          onUpdateStatus={async (id, status) => {
            await api.updateCustomerDeviceStatus(id, status);
            await refreshAllData();
          }}
          onExchangeSuccess={refreshAllData}
          onRequestApproval={handleCreateApprovalRequest}
          onCancelApproval={handleCancelApprovalRequest}
          onNavigateToMaster={() => setActiveTab('customers')}
          sseRefreshKey={registerRefresh.customerDevices}
        />
    )),
    screenRoute('complete-serial-inventory', (
        <SerialLogRegister
          selectedBranchId={selectedBranchId}
          currentUser={currentUser}
          dateMode={dateMode}
          onRefreshData={refreshAllData}
          refreshKey={registerRefresh.serialLog}
        />
    )),
    screenRoute('locations', (
        <LocationsManagement
          currentUser={currentUser}
        />
    )),
    screenRoute('import-customers', (
        <ImportCustomers
          onImportCustomersSuccess={async (newCustomers) => {
            await api.bulkImportCustomers(newCustomers);
            await refreshAllData();
          }}
        />
    )),
    screenRoute('create-po', (
      <PurchaseOrders
        currentUser={currentUser}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        activeTab="create-po"
        prepopulatedLines={prepopulatedPOLines}
        onCreatePO={handleCreatePO}
        onUpdatePO={handleUpdatePO}
        onUpdatePOStatus={handleUpdatePOStatus}
        onDeletePO={handleDeletePO}
        sseRefreshKey={registerRefresh.purchaseOrders}
        onNavigateTab={handleSelectTab}
      />
    )),
    screenRoute('po-list', (
      <PurchaseOrders
        currentUser={currentUser}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        activeTab="po-list"
        prepopulatedLines={prepopulatedPOLines}
        onCreatePO={handleCreatePO}
        onUpdatePO={handleUpdatePO}
        onUpdatePOStatus={handleUpdatePOStatus}
        onDeletePO={handleDeletePO}
        sseRefreshKey={registerRefresh.purchaseOrders}
        recordRoute={activeTab === 'po-list' ? recordRoute : null}
        onRecordRouteChange={handleRecordRouteChange}
        onNavigateTab={handleSelectTab}
      />
    )),
    screenRoute('create-purchase', (
        <PurchaseInvoices
          currentUser={currentUser}
          invoices={purchaseInvoices}
          selectedBranchId={selectedBranchId}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          dateMode={dateMode}
          activeTab="create-purchase"
          onCreateInvoice={handleCreateInvoice}
          onRecordPayment={handleRecordPayment}
          onReversePayment={handleReversePayment}
          onReverseInvoicePayments={handleReverseInvoicePayments}
          onDeleteInvoice={handleDeleteInvoice}
          sseRefreshKey={registerRefresh.purchaseInvoices}
          onNavigateTab={handleSelectTab}
        />
    )),
    screenRoute('purchase-list', (
        <PurchaseInvoices
          currentUser={currentUser}
          invoices={purchaseInvoices}
          selectedBranchId={selectedBranchId}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          dateMode={dateMode}
          activeTab="purchase-list"
          onCreateInvoice={handleCreateInvoice}
          onRecordPayment={handleRecordPayment}
          onReversePayment={handleReversePayment}
          onReverseInvoicePayments={handleReverseInvoicePayments}
          onDeleteInvoice={handleDeleteInvoice}
          sseRefreshKey={registerRefresh.purchaseInvoices}
          recordRoute={activeTab === 'purchase-list' ? recordRoute : null}
          onRecordRouteChange={handleRecordRouteChange}
          onNavigateTab={handleSelectTab}
        />
    )),
    screenRoute('create-sale', (
        <SalesInvoices
          currentUser={currentUser}
          inventorySerialsError={sellableSerialsError}
          inventorySerialsLoading={sellableSerialsLoading}
          onRetryInventorySerials={() => void loadSellableSerials(selectedBranchId)}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.salesInvoices}
          activeTab="create-sale"
          onCreateInvoice={handleCreateSalesInvoice}
          onRecordPayment={handleRecordCustomerPayment}
          onCancelInvoice={handleCancelSalesInvoice}
          onNavigateTab={handleSelectTab}
        />
    )),
    screenRoute('sales-list', (
        <SalesInvoices
          currentUser={currentUser}
          inventorySerialsError={sellableSerialsError}
          inventorySerialsLoading={sellableSerialsLoading}
          onRetryInventorySerials={() => void loadSellableSerials(selectedBranchId)}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.salesInvoices}
          activeTab="sales-list"
          onCreateInvoice={handleCreateSalesInvoice}
          onRecordPayment={handleRecordCustomerPayment}
          onCancelInvoice={handleCancelSalesInvoice}
          recordRoute={activeTab === 'sales-list' ? recordRoute : null}
          onRecordRouteChange={handleRecordRouteChange}
          onNavigateTab={handleSelectTab}
        />
    )),
    screenRoute('purchase-returns', (
        <ReturnsRegister
          kind="PURCHASE"
          currentUser={currentUser}
          returns={purchaseReturns}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.returnsRegister}
          onCreateReturn={handleCreatePurchaseReturn}
          onCancelReturn={handleCancelPurchaseReturn}
          onApproveReturn={handleApprovePurchaseReturn}
          recordRoute={activeTab === 'purchase-returns' ? recordRoute : null}
          onRecordRouteChange={handleRecordRouteChange}
        />
    )),
    screenRoute('create-purchase-return', (
        <ReturnsRegister
          kind="PURCHASE"
          currentUser={currentUser}
          returns={purchaseReturns}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          autoOpenCreate
          sseRefreshKey={registerRefresh.returnsRegister}
          onCreateReturn={handleCreatePurchaseReturn}
          onCancelReturn={handleCancelPurchaseReturn}
          onApproveReturn={handleApprovePurchaseReturn}
        />
    )),
    screenRoute('sales-returns', (
        <ReturnsRegister
          kind="SALES"
          currentUser={currentUser}
          returns={salesReturns}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.returnsRegister}
          onCreateReturn={handleCreateSalesReturn}
          onCancelReturn={handleCancelSalesReturn}
          onApproveReturn={handleApproveSalesReturn}
          recordRoute={activeTab === 'sales-returns' ? recordRoute : null}
          onRecordRouteChange={handleRecordRouteChange}
        />
    )),
    screenRoute('create-sales-return', (
        <ReturnsRegister
          kind="SALES"
          currentUser={currentUser}
          returns={salesReturns}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          autoOpenCreate
          sseRefreshKey={registerRefresh.returnsRegister}
          onCreateReturn={handleCreateSalesReturn}
          onCancelReturn={handleCancelSalesReturn}
          onApproveReturn={handleApproveSalesReturn}
        />
    )),
    screenRoute('create-shipment', (
        <Shipments
          currentUser={currentUser}
          activeTab="create-shipment"
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          onCreateShipment={async (sh) => {
            await api.createShipment(sh);
            refreshAllData();
          }}
          onReceiveShipment={handleReceiveShipment}
          onCancelReceiveShipment={handleCancelReceiveShipment}
          onRequestApproval={handleCreateApprovalRequest}
          onCancelApproval={handleCancelApprovalRequest}
          shipmentsRefresh={registerRefresh.shipments}
        />
    )),
    screenRoute('create-transfer', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="CREATE_TRANSFER"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onCreateShipment={async (sh) => {
          await api.createShipment(sh);
          refreshAllData();
        }}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
        onRequestApproval={handleCreateApprovalRequest}
        onCancelApproval={handleCancelApprovalRequest}
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('receive-shipment', (
      <ReceiveInboundWarehouse
        currentUser={currentUser}
        operations={stockOperations}
        shipments={shipments}
        dateMode={dateMode}
        onReceiveOperation={handleReceiveOperation}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
      />
    )),
    screenRoute('receive-branch-transfer', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="RECEIVE_TRANSFER"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onCreateShipment={async (sh) => {
          await api.createShipment(sh);
          refreshAllData();
        }}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
        onRequestApproval={handleCreateApprovalRequest}
        onCancelApproval={handleCancelApprovalRequest}
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
        recordRoute={activeTab === 'receive-branch-transfer' ? recordRoute : null}
        onRecordRouteChange={handleRecordRouteChange}
        onFindShipment={handleFindShipment}
      />
    )),
    screenRoute('shipment-list', (
        <Shipments
          currentUser={currentUser}
          activeTab={activeTab}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          onCreateShipment={async (sh) => {
            await api.createShipment(sh);
            refreshAllData();
          }}
          onReceiveShipment={handleReceiveShipment}
          onCancelReceiveShipment={handleCancelReceiveShipment}
          onRequestApproval={handleCreateApprovalRequest}
          onCancelApproval={handleCancelApprovalRequest}
          shipmentsRefresh={registerRefresh.shipments}
          recordRoute={activeTab === 'shipment-list' ? recordRoute : null}
          onRecordRouteChange={handleRecordRouteChange}
          onFindShipment={handleFindShipment}
        />
    )),
    screenRoute('pullout', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="PULLOUT"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onCreateShipment={async (sh) => {
          await api.createShipment(sh);
          refreshAllData();
        }}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
        onRequestApproval={handleCreateApprovalRequest}
        onCancelApproval={handleCancelApprovalRequest}
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('damage', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="DAMAGE"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onCreateShipment={async (sh) => {
          await api.createShipment(sh);
          refreshAllData();
        }}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
        onRequestApproval={handleCreateApprovalRequest}
        onCancelApproval={handleCancelApprovalRequest}
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('pullout-report', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="PULLOUT_REPORT"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onReverseOperation={handleReverseStockOperation}
      />
    )),
    screenRoute('damage-report', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="DAMAGE_REPORT"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReverseOperation={handleReverseStockOperation}
      />
    )),
    screenRoute('assign-asset', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="ASSIGN_ASSET"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onCreateShipment={async (sh) => {
          await api.createShipment(sh);
          refreshAllData();
        }}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
        onRequestApproval={handleCreateApprovalRequest}
        onCancelApproval={handleCancelApprovalRequest}
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('asset-deployments', (
        <AssetDeployments
          refreshToken={registerRefresh.fixedAssets}
          currentUser={currentUser}
          dateMode={dateMode}
          onUnassignAsset={handleUpdateAssetStatus}
        />
    )),
    screenRoute('consumable-issue', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="CONSUMABLE_ISSUE"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onCreateShipment={async (sh) => {
          await api.createShipment(sh);
          refreshAllData();
        }}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
        onRequestApproval={handleCreateApprovalRequest}
        onCancelApproval={handleCancelApprovalRequest}
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('consumables-register', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="CONSUMABLES_REGISTER"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onCreateShipment={async (sh) => {
          await api.createShipment(sh);
          refreshAllData();
        }}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
        onRequestApproval={handleCreateApprovalRequest}
        onCancelApproval={handleCancelApprovalRequest}
        onReverseOperation={handleReverseStockOperation}
        onReverseConsumableIssue={async (id, reason) => {
          await api.reverseConsumableIssue(id, reason, currentUser);
          refreshAllData();
        }}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('device-exchange', (
      <StockOperations
        onRefreshData={refreshAllData}
        operations={stockOperations}
        selectedBranchId={selectedBranchId}
        dateMode={dateMode}
        initialType="DEVICE_EXCHANGE"
        autoOpenModal={false}
        currentUser={currentUser}
        shipments={shipments}
        sseRefreshKey={registerRefresh.consumableRegister}
        onCreateOperation={handleCreateOperation}
        onReceiveOperation={handleReceiveOperation}
        onCreateShipment={async (sh) => {
          await api.createShipment(sh);
          refreshAllData();
        }}
        onReceiveShipment={handleReceiveShipment}
        onCancelReceiveShipment={handleCancelReceiveShipment}
        onRequestApproval={handleCreateApprovalRequest}
        onCancelApproval={handleCancelApprovalRequest}
        onReverseOperation={handleReverseStockOperation}
        onUpdateAssetStatus={handleUpdateAssetStatus}
      />
    )),
    screenRoute('supplier-warranty', (
        <SupplierWarrantyRegister
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          currentUser={currentUser}
          refreshKey={registerRefresh.customerDevices}
        />
    )),
    screenRoute('field-work-orders', (
        <FieldWorkOrders
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          currentUser={currentUser}
          refreshKey={registerRefresh.customerDevices}
        />
    )),
    screenRoute('seller-warranty', (
        <SellerWarrantyRegister
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          currentUser={currentUser}
          refreshKey={registerRefresh.customerDevices}
        />
    )),
    screenRoute('branches', (
      <BranchesManagement
        currentUser={currentUser}
        onCreateBranch={async (b) => {
          await api.createBranch(b);
          refreshAllData();
        }}
        onUpdateBranch={async (id, b) => {
          await api.updateBranch(id, b);
          refreshAllData();
        }}
        onDeleteBranch={async (id) => {
          await api.deleteBranch(id);
          refreshAllData();
        }}
      />
    )),
    screenRoute('suppliers', (
      <SuppliersManagement
        currentUser={currentUser}
        onCreateSupplier={async (s) => {
          const created = await api.createSupplier(s);
          refreshAllData();
          return created;
        }}
        onUpdateSupplier={async (id, s) => {
          await api.updateSupplier(id, s);
          refreshAllData();
        }}
        onDeleteSupplier={async (id) => {
          await api.deleteSupplier(id);
          refreshAllData();
        }}
      />
    )),
    screenRoute('users', (
      <UsersManagementLazy
        currentUser={currentUser}
        onCreateUser={async (u) => {
          await api.createUser(u);
          refreshAllData();
        }}
        onUpdateUser={async (id, u) => {
          await api.updateUser(id, u);
          refreshAllData();
        }}
        onResetPassword={async (id, newPass) => {
          await api.resetUserPassword(id, newPass);
          refreshAllData();
        }}
        onDeleteUser={async (id) => {
          await api.deleteUser(id);
          refreshAllData();
        }}
        onManageAccess={openUserAccess}
        recordRoute={activeTab === 'users' ? recordRoute : null}
        onRecordRouteChange={handleRecordRouteChange}
      />
    )),
    screenRoute('api-keys', (
      <ApiKeysLazy currentUser={currentUser} />
    )),
    // The partner row and its delivery queue sit beside the keys they bind, and
    // are gated by the same `admin-api-keys` operation.
    screenRoute('integration-partners', (
      <IntegrationPartnersLazy currentUser={currentUser} />
    )),
    screenRoute('login-locks', (
      <LoginLocks currentUser={currentUser} />
    )),
    screenRoute('permissions', (
        <PermissionManagementLazy
          currentUser={currentUser}
          permissionsMatrix={permissionsMatrix}
          onOpenUserAccess={(target) => {
            if (target) openUserAccess(target.userId, target.operationId);
            else setActiveTab('user-permissions');
          }}
        />
    )),
    screenRoute('user-permissions',
        <UserPermissionsLazy
          currentUser={currentUser}
          dateMode={dateMode}
          focusRequest={userAccessFocus}
          onOpenRoleDefaults={() => setActiveTab('permissions')}
        />
    ),
    screenRoute('company-setup', (
      <CompanySetupManagement
        currentUser={currentUser}
        initialProfile={companyProfile}
        onUpdateCompanyProfile={async (updatedProfile) => {
          await api.updateCompanyProfile(updatedProfile);
          await refreshAllData();
          return true;
        }}
        onSave={async (updatedProfile) => {
          await api.updateCompanyProfile(updatedProfile);
          await refreshAllData();
          return true;
        }}
      />
    )),
    screenRoute('clear-demo-data', (
        <ClearDemoDataView
          currentUser={currentUser}
          productCount={products.length}
          stockCount={stock.length}
          poCount={purchaseOrders.length}
          invoiceCount={purchaseInvoices.length}
          onClearDemoData={async () => {
            const result = await api.clearDemoData();
            await refreshAllData();
            // The demo Super Admin rows were just deleted — usually
            // including the account this session is signed in as.
            // Authorization is derived from the signed token (8h TTL)
            // with no per-request user lookup, so staying signed in
            // would mean acting as a user that no longer exists; the
            // real next step is the first-launch setup, which
            // LoginModal opens by itself once no Super Admin is left.
            if (result.superAdminCount === 0) {
              setLoginNotice(
                'Demo data was cleared, including the demo Super Admin accounts. Create your own Super Admin account to continue.'
              );
            }
            return result;
          }}
          needsFiscalYear={!fiscalYears.some((fy) => fy.isCurrent)}
          onNavigateFiscalYears={() => setActiveTab('fiscal-year-closing')}
          onSignedOut={handleLogout}
          onNavigateDashboard={() => setActiveTab('dashboard')}
        />
    )),
    screenRoute('accounting', (
        <TrialBalanceRegister dateMode={dateMode} currentUser={currentUser} fiscalYearStartAD={selectedFiscalYear?.startDateAD} />
    )),
    screenRoute('accounting-bs-summary', (
        <BsLedgerSummaryRegister
          dateMode={dateMode}
          currentUser={currentUser}
        />
    )),
    screenRoute('accounting-profit-loss', (
        <ProfitAndLossRegister dateMode={dateMode} currentUser={currentUser} fiscalYearStartAD={selectedFiscalYear?.startDateAD} />
    )),
    screenRoute('accounting-branch-consolidated', (
        <BranchConsolidatedRegister dateMode={dateMode} currentUser={currentUser} fiscalYearStartAD={selectedFiscalYear?.startDateAD} />
    )),
    screenRoute('accounting-balance-sheet', (
        <BalanceSheetRegister dateMode={dateMode} currentUser={currentUser} fiscalYearStartAD={selectedFiscalYear?.startDateAD} />
    )),
    screenRoute('accounting-cash-flow', (
        <CashFlowRegister dateMode={dateMode} currentUser={currentUser} />
    )),
    screenRoute('accounting-cash-book', (
        <CashBookRegister dateMode={dateMode} currentUser={currentUser} />
    )),
    screenRoute('recurring-close', (
        <RecurringCloseRegister currentUser={currentUser} />
    )),
    screenRoute('accounting-aging', (
        <AgingRegister dateMode={dateMode} currentUser={currentUser} />
    )),
    screenRoute('journal-entry', (
        <JournalEntry currentUser={currentUser} />
    )),
    screenRoute('cash-bank-entry', (
        <CashBankEntry currentUser={currentUser} />
    )),
    screenRoute('posted-vouchers', (
        <PostedVouchers
          currentUser={currentUser}
          sseRefreshKey={registerRefresh.transactionLog}
          dateMode={dateMode}
        />
    )),
    screenRoute('finance-payroll-postings', (
        <PayrollPostingsRegister currentUser={currentUser} dateMode={dateMode} />
    )),
    screenRoute('accounting-chart', (
        <ChartOfAccountsRegister dateMode={dateMode} currentUser={currentUser} />
    )),
    screenRoute('posting-rules', (
        <PostingRulesRegister
          dateMode={dateMode}
          currentUser={currentUser}
        />
    )),
    screenRoute('subledgers', (
        <SubledgersManagement
          currentUser={currentUser}
          dateMode={dateMode}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
        />
    )),
    screenRoute('lenders', (
        <LendersManagement
          currentUser={currentUser}
          dateMode={dateMode}
        />
    )),
    screenRoute('bill-terms', (
        <BillTermsManagement currentUser={currentUser} />
    )),
    screenRoute('cost-centers', (
        <CostCentersManagement currentUser={currentUser} />
    )),
    screenRoute('employees', (
        <EmployeeDirectory
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
        />
    )),
    screenRoute('hr-self-service', (
        <EmployeeSelfService currentUser={currentUser} />
    )),
    screenRoute('hr-self-payslips', (
        <EmployeePayslips currentUser={currentUser} />
    )),
    screenRoute('hr-self-leave', (
        <EmployeeLeave currentUser={currentUser} />
    )),
    screenRoute('hr-self-attendance', (
        <EmployeeAttendance currentUser={currentUser} />
    )),
    screenRoute('hr-self-documents', (
        <EmployeeDocuments currentUser={currentUser} />
    )),
    screenRoute('hr-attendance', (
        <AttendanceLeave
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
        />
    )),
    screenRoute('hr-payroll', (
        <Payroll currentUser={currentUser} fiscalYears={fiscalYears} />
    )),
    screenRoute('hr-reports', (
        <HrReports currentUser={currentUser} />
    )),
    screenRoute('hr-recruitment', (
        <Recruitment
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
        />
    )),
    screenRoute('hr-performance', (
        <Performance
          currentUser={currentUser}
          selectedBranchId={selectedBranchId}
        />
    )),
    screenRoute('hr-lifecycle', (
        <Lifecycle user={currentUser} branchId={selectedBranchId} />
    )),
    screenRoute('hr-org-masters', (
        <OrgMasters currentUser={currentUser} />
    )),
    screenRoute('org-chart', (
        <OrgChart currentUser={currentUser} />
    )),
    screenRoute('narration-templates', (
        <NarrationTemplatesManagement currentUser={currentUser} />
    )),
    screenRoute('cash-position', (
        <DailyCashClose dateMode={dateMode} currentUser={currentUser} />
    )),
    screenRoute('financial-statements', (
        <FinanceDashboard
          dateMode={dateMode}
          currentUser={currentUser}
          fiscalYears={fiscalYears}
          currentFiscalYear={selectedFiscalYear || resolveDefaultFiscalYear(fiscalYears) || null}
          refreshToken={Object.values(registerRefresh).reduce((sum, value) => sum + value, 0)}
          onNavigateTab={handleSelectTab}
        />
    )),
    screenRoute('vendor-ledger', (
        <VendorLedger
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.purchaseInvoices}
          focusRequest={ledgerPartyFocus?.tab === 'vendor-ledger' ? ledgerPartyFocus : null}
        />
    )),
    screenRoute('customer-ledger', (
        <CustomerLedger
          dateMode={dateMode}
          sseRefreshKey={registerRefresh.salesInvoices}
          returnsRefreshKey={registerRefresh.returnsRegister}
          focusRequest={ledgerPartyFocus?.tab === 'customer-ledger' ? ledgerPartyFocus : null}
        />
    )),
    screenRoute('employee-ledger', (
        <EmployeeLedger
          dateMode={dateMode}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          focusRequest={ledgerPartyFocus?.tab === 'employee-ledger' ? ledgerPartyFocus : null}
        />
    )),
    screenRoute('vendor-opening-balances', (
        <VendorOpeningBalances
          currentUser={currentUser}
          fiscalYears={fiscalYears}
          onRefreshData={refreshAllData}
          selectedFiscalYearId={selectedFiscalYearId}
          onSelectFiscalYear={setSelectedFiscalYearId}
        />
    )),
    screenRoute('vat-register', (
        <VatRegister
          invoices={purchaseInvoices}
          dateMode={dateMode}
        />
    )),
    screenRoute('depreciation-register', (
        <DepreciationRegister
          refreshToken={registerRefresh.fixedAssets}
          selectedBranchId={selectedBranchId}
          asOfDateAD={assetReportAsOfDateAD}
          dateMode={dateMode}
        />
    )),
    screenRoute('audit', (
        <AuditTrailReports
          invoices={purchaseInvoices}
          selectedBranchId={selectedBranchId}
          fiscalYearStartAD={selectedFiscalYear?.startDateAD}
          fiscalYearEndAD={selectedFiscalYear?.endDateAD}
          sseRefreshKey={registerRefresh.transactionLog}
          dateMode={dateMode}
        />
    )),
    screenRoute('data-recalculation', (
        <DataRecalculationMaintenance
          currentUser={currentUser}
          fiscalYears={fiscalYears}
          onRefreshData={refreshAllData}
        />
    )),
    screenRoute('fiscal-year-closing', (
        <FiscalYearClosingWizard
          fiscalYears={fiscalYears}
          onSetCurrentFiscalYear={handleSetCurrentFiscalYear}
          onCloseFiscalYear={handleCloseFiscalYear}
          onReopenFiscalYear={handleReopenFiscalYear}
          onCreateFiscalYear={handleCreateFiscalYear}
          onDeleteFiscalYear={handleDeleteFiscalYear}
          onInitializeOpeningStock={handleInitializeFiscalYearOpeningStock}
          onRollForwardVendorOpenings={handleRollForwardVendorOpenings}
          dateMode={dateMode}
          refreshToken={registerRefresh.fixedAssets}
          branchId={selectedBranchId}
          sseRefreshKey={registerRefresh.purchaseOrders + registerRefresh.purchaseInvoices}
          currentUser={currentUser}
          onRefreshData={refreshAllData}
          selectedFiscalYearId={selectedFiscalYearId}
          onSelectFiscalYear={setSelectedFiscalYearId}
          onNavigateTab={setActiveTab}
        />
    )),
    screenRoute('bs-calendar', (
        <BsCalendarUtility
          currentUser={currentUser}
        />
    )),
    screenRoute('fiscal-year-management', (
        <DocumentNumbering />
    )),
    screenRoute('nepali-fiscal', (
        <NepaliFiscalManagement
          fiscalYears={fiscalYears}
          onSetCurrentFiscalYear={handleSetCurrentFiscalYear}
          dateMode={dateMode}
        />
    )),
    screenRoute('help-documentation', (
        <HelpDocumentationLazy
          currentUser={currentUser}
          onNavigateTab={handleHelpNavigateTab}
        />
    )),
  ];
}
