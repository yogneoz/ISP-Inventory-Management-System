// ---------------------------------------------------------------------------
// API client barrel
//
// The former 1,264-line api.ts is now split into per-domain modules so that
// unrelated workflows never collide in one file:
//
//   http.ts        — request pipeline: auth/fiscal-year headers, GET dedup,
//                    401 handling, context setters
//   auth.ts        — login, setup, profiles
//   bootstrap.ts   — unified bootstrap state fetch
//   inventory.ts   — stock, assets, stock operations, serials, customers,
//                    approvals, document numbering, audit/transaction logs
//   procurement.ts — branches, suppliers, users, products, purchase orders
//                    and invoices, vendor payments, shipments
//   finance.ts     — fiscal years, opening stock, BS calendar, summaries
//   admin.ts       — company profile, permissions, categories, UoM,
//                    locations, recalculation utilities
//   search.ts      — bounded global quick search (TRIM-1)
//   settings.ts    — server-side app settings & per-user preferences
//                    (replaces the browser-localStorage copies)
//   sync.ts        — SSE live-sync subscription
//
// This module preserves the original public surface: the single `api` object
// plus every named export, so existing `import { api } from '../services/api'`
// call sites continue to work unchanged.
// ---------------------------------------------------------------------------

import * as auth from './auth';
import * as bootstrap from './bootstrap';
import * as inventory from './inventory';
import * as procurement from './procurement';
import * as sales from './sales';
import * as salesMasters from './salesMasters';
import * as finance from './finance';
import * as accounting from './accounting';
import * as admin from './admin';
import * as search from './search';
import * as settings from './settings';
import * as warranty from './warranty';

export { API_BASE, fetchJson, setAuthToken, setUserContext, setFiscalYearContext, setActiveBranchContext, getActiveBranchId } from './http';
export { subscribeToSyncStream, getSyncVersion, broadcastLogoutToOtherTabs } from './sync';
export type { SyncRelayMessage } from './sync';
export type {
  EffectivePermissionsResponse,
  OperationPermissionOverrideUser,
  OperationPermissionOverridesResponse,
  PermissionOverrideEffect,
  PermissionSetInput,
  PermissionSetSummary,
  UserAccessSummariesResponse,
  UserAccessSummary,
  UserPermissionOverrideInput,
  UserPermissionOverrideRow,
  UserPermissionOverridesResponse,
  UserPermissionSetsResponse,
} from './admin';
export { safeParseHistory } from './inventory';
export type { WarrantyRegisterQuery, WarrantyCorrectionInput } from './warranty';
export type {
  AccountingAccount,
  AccountingAccountInput,
  AccountingAccountPatch,
  AccountingEmployee,
  AccountingGroup,
  AccountingGroupInput,
  AccountingGroupPatch,
  AccountingJournal,
  AccountingJournalInput,
  AccountingJournalLine,
  AccountingJournalLineInput,
  AccountingJournalListQuery,
  AccountingJournalListResponse,
  AccountingJournalReversalInput,
  AccountingJournalSubledgerEntry,
  AgingBucketKey,
  AgingParty,
  AgingResponse,
  AgingType,
  BalanceSheetResponse,
  CashBookAccount,
  CashBookEntry,
  CashBookResponse,
  CashCloseBranch,
  CashCloseBranchResponse,
  CashCloseRecord,
  CashPositionResponse,
  CashPositionTotals,
  ControlAgreement,
  ControlReconciliationResponse,
  PostingDefault,
  PostingDefaultsResponse,
  ProfitAndLossResponse,
  StatementQuery,
  StatementSection,
  TrialBalanceAccount,
  TrialBalanceAccountLine,
  TrialBalanceAccountLinesQuery,
  TrialBalanceAccountLinesResponse,
  TrialBalanceGroup,
  TrialBalanceGroupLine,
  TrialBalanceGroupLinesQuery,
  TrialBalanceGroupLinesResponse,
  TrialBalanceGroupSummary,
  TrialBalanceResponse,
} from './accounting';

export const api = {
  // Bootstrap
  getBootstrapState: bootstrap.getBootstrapState,
  getLocalFor: bootstrap.getLocalFor,

  // Auth
  getSetupStatus: auth.getSetupStatus,
  setupSuperAdmin: auth.setupSuperAdmin,
  forgotPassword: auth.forgotPassword,
  login: auth.login,
  switchProfile: auth.switchProfile,
  updateProfile: auth.updateProfile,

  // Branches / Suppliers / Users / Products (procurement masterdata)
  createBranch: procurement.createBranch,
  updateBranch: procurement.updateBranch,
  deleteBranch: procurement.deleteBranch,
  createSupplier: procurement.createSupplier,
  updateSupplier: procurement.updateSupplier,
  deleteSupplier: procurement.deleteSupplier,
  createUser: procurement.createUser,
  updateUser: procurement.updateUser,
  deleteUser: procurement.deleteUser,
  resetUserPassword: procurement.resetUserPassword,
  createProduct: procurement.createProduct,
  updateProduct: procurement.updateProduct,
  deleteProduct: procurement.deleteProduct,

  // Stock & assets
  getStock: inventory.getStock,
  updateStockLevel: inventory.updateStockLevel,
  updateStockReorderLevel: inventory.updateStockReorderLevel,
  bulkUpdateStockReorderLevels: inventory.bulkUpdateStockReorderLevels,
  reconcileStockAudit: inventory.reconcileStockAudit,
  createAsset: inventory.createAsset,
  updateAssetStatus: inventory.updateAssetStatus,
  getFixedAssetPage: inventory.getFixedAssetPage,
  getFixedAssetExport: inventory.getFixedAssetExport,
  getFixedAssetOverview: inventory.getFixedAssetOverview,
  getAvailableFixedAssets: inventory.getAvailableFixedAssets,
  lookupFixedAsset: inventory.lookupFixedAsset,

  // Admin recalculation / repair utilities
  recalculateFixedAssets: admin.recalculateFixedAssets,
  recalculateLiveStock: admin.recalculateLiveStock,
  recalculateLedgerBalances: admin.recalculateLedgerBalances,
  reconcileSerialRegister: admin.reconcileSerialRegister,
  rebuildBsDayRecords: admin.rebuildBsDayRecords,
  repairFiscalYearLinks: admin.repairFiscalYearLinks,

  // Purchase Orders
  getPurchaseOrders: procurement.getPurchaseOrders,
  createPurchaseOrder: procurement.createPurchaseOrder,
  updatePurchaseOrder: procurement.updatePurchaseOrder,
  updatePurchaseOrderStatus: procurement.updatePurchaseOrderStatus,
  deletePurchaseOrder: procurement.deletePurchaseOrder,

  // Purchase Invoices
  getPurchaseInvoices: procurement.getPurchaseInvoices,
  createPurchaseInvoice: procurement.createPurchaseInvoice,
  recordInvoicePayment: procurement.recordInvoicePayment,
  deletePurchaseInvoice: procurement.deletePurchaseInvoice,
  getInvoicePayments: procurement.getInvoicePayments,

  // Vendor Payments Sub-ledger
  createVendorPayment: procurement.createVendorPayment,
  reverseVendorPayment: procurement.reverseVendorPayment,
  reverseInvoicePayments: procurement.reverseInvoicePayments,
  getVendorLedger: procurement.getVendorLedger,

  // Sales territories and agents
  getAreas: salesMasters.getAreas,
  createArea: salesMasters.createArea,
  updateArea: salesMasters.updateArea,
  deleteArea: salesMasters.deleteArea,
  getSalesAgents: salesMasters.getSalesAgents,
  createSalesAgent: salesMasters.createSalesAgent,
  updateSalesAgent: salesMasters.updateSalesAgent,
  deleteSalesAgent: salesMasters.deleteSalesAgent,

  // Sales Invoices & Returns
  getSalesInvoices: sales.getSalesInvoices,
  createSalesInvoice: sales.createSalesInvoice,
  getPurchaseReturns: sales.getPurchaseReturns,
  createPurchaseReturn: sales.createPurchaseReturn,
  cancelPurchaseReturn: sales.cancelPurchaseReturn,
  postPurchaseReturn: sales.postPurchaseReturn,
  getSalesReturns: sales.getSalesReturns,
  createSalesReturn: sales.createSalesReturn,
  cancelSalesReturn: sales.cancelSalesReturn,
  cancelSalesInvoice: sales.cancelSalesInvoice,
  postSalesReturn: sales.postSalesReturn,
  createCustomerPayment: sales.createCustomerPayment,
  reverseCustomerPayment: sales.reverseCustomerPayment,
  getCustomerLedger: sales.getCustomerLedger,

  // Shipments
  getShipments: procurement.getShipments,
  getShipmentPage: procurement.getShipmentPage,
  getShipmentOverview: procurement.getShipmentOverview,
  createShipment: procurement.createShipment,
  receiveShipment: procurement.receiveShipment,
  cancelShipment: procurement.cancelShipment,
  cancelReceiveShipment: procurement.cancelReceiveShipment,

  // Stock Operations (Pullout, Damage, Stock Out)
  getStockOperations: inventory.getStockOperations,
  createStockOperation: inventory.createStockOperation,
  receiveStockOperation: inventory.receiveStockOperation,
  reverseStockOperation: inventory.reverseStockOperation,
  reverseConsumableIssue: inventory.reverseConsumableIssue,
  reversePulloutOperation: inventory.reversePulloutOperation,
  reverseStockOutOperation: inventory.reverseStockOutOperation,

  // Fiscal Years & finance
  setCurrentFiscalYear: finance.setCurrentFiscalYear,
  createFiscalYear: finance.createFiscalYear,
  closeFiscalYear: finance.closeFiscalYear,
  reopenFiscalYear: finance.reopenFiscalYear,
  initializeFiscalYearOpeningStock: finance.initializeFiscalYearOpeningStock,
  getFiscalYearOpeningStock: finance.getFiscalYearOpeningStock,
  adjustFiscalYearOpeningStock: finance.adjustFiscalYearOpeningStock,
  getVendorOpeningBalances: finance.getVendorOpeningBalances,
  adjustVendorOpeningBalances: finance.adjustVendorOpeningBalances,
  rollForwardVendorOpenings: finance.rollForwardVendorOpenings,
  deleteFiscalYear: finance.deleteFiscalYear,

  // Document Numbering Configurations
  getDocumentNumberConfigs: inventory.getDocumentNumberConfigs,
  updateDocumentNumberConfigs: inventory.updateDocumentNumberConfigs,
  createDocumentNumberConfig: inventory.createDocumentNumberConfig,
  updateDocumentNumberConfig: inventory.updateDocumentNumberConfig,

  // Financial Summary
  getFinancialSummary: finance.getFinancialSummary,

  // Accounting ledger (statements, cash book, chart and posting defaults)
  getAccountingGroups: accounting.getAccountingGroups,
  createAccountingGroup: accounting.createAccountingGroup,
  updateAccountingGroup: accounting.updateAccountingGroup,
  deleteAccountingGroup: accounting.deleteAccountingGroup,
  getAccountingAccounts: accounting.getAccountingAccounts,
  createAccountingAccount: accounting.createAccountingAccount,
  updateAccountingAccount: accounting.updateAccountingAccount,
  deleteAccountingAccount: accounting.deleteAccountingAccount,
  getAccountingSubledgers: accounting.getAccountingSubledgers,
  createAccountingSubledger: accounting.createAccountingSubledger,
  updateAccountingSubledger: accounting.updateAccountingSubledger,
  deleteAccountingSubledger: accounting.deleteAccountingSubledger,
  generateAccountingSubledgers: accounting.generateAccountingSubledgers,
  getAccountingSubledgerEntries: accounting.getAccountingSubledgerEntries,
  getAccountingEmployees: accounting.getAccountingEmployees,
  postAccountingJournal: accounting.postAccountingJournal,
  reverseAccountingJournal: accounting.reverseAccountingJournal,
  getAccountingJournal: accounting.getAccountingJournal,
  getAccountingJournals: accounting.getAccountingJournals,
  getChartHealth: accounting.getChartHealth,
  seedChartDefaults: accounting.seedChartDefaults,
  getSettlementAccounts: accounting.getSettlementAccounts,
  getPostingDefaults: accounting.getPostingDefaults,
  getBillTerms: accounting.getBillTerms,
  createBillTerm: accounting.createBillTerm,
  updateBillTerm: accounting.updateBillTerm,
  deleteBillTerm: accounting.deleteBillTerm,
  getCostCenters: accounting.getCostCenters,
  createCostCenter: accounting.createCostCenter,
  updateCostCenter: accounting.updateCostCenter,
  deleteCostCenter: accounting.deleteCostCenter,
  getNarrationTemplates: accounting.getNarrationTemplates,
  createNarrationTemplate: accounting.createNarrationTemplate,
  updateNarrationTemplate: accounting.updateNarrationTemplate,
  deleteNarrationTemplate: accounting.deleteNarrationTemplate,
  getTrialBalance: accounting.getTrialBalance,
  getProfitAndLoss: accounting.getProfitAndLoss,
  getBalanceSheet: accounting.getBalanceSheet,
  getCashFlow: accounting.getCashFlow,
  getStatementGroupLines: accounting.getStatementGroupLines,
  getTrialBalanceGroupLines: accounting.getTrialBalanceGroupLines,
  getTrialBalanceAccountLines: accounting.getTrialBalanceAccountLines,
  getCashBook: accounting.getCashBook,
  getAging: accounting.getAging,
  getDailyCashClose: accounting.getDailyCashClose,
  getDailyCashCloseConsolidated: accounting.getDailyCashCloseConsolidated,
  closeDailyCash: accounting.closeDailyCash,
  reopenDailyCashClose: accounting.reopenDailyCashClose,
  getControlReconciliation: accounting.getControlReconciliation,

  // Audit Trail (serial-scoped history)
  getAuditTrail: inventory.getAuditTrail,
  getTransactionLogs: inventory.getTransactionLogs,

  // Warranty registers (WTY-6): supplier-side and seller-side coverage
  fetchVendorWarranties: warranty.fetchVendorWarranties,
  fetchSellerWarranties: warranty.fetchSellerWarranties,
  updateWarrantyCoverage: warranty.updateWarrantyCoverage,

  // Customer Devices & Serial Numbers
  getCustomerDevicePage: inventory.getCustomerDevicePage,
  getCustomerDeviceExport: inventory.getCustomerDeviceExport,
  getCustomerDeviceOverview: inventory.getCustomerDeviceOverview,
  createCustomerDevice: inventory.createCustomerDevice,
  updateCustomerDeviceStatus: inventory.updateCustomerDeviceStatus,
  exchangeCustomerDevice: inventory.exchangeCustomerDevice,
  updateDeviceSerials: inventory.updateDeviceSerials,
  lookupSerial: inventory.lookupSerial,
  lookupExchangeSerial: inventory.lookupExchangeSerial,
  reportExchangeRefusal: inventory.reportExchangeRefusal,
  updateDeviceSerialsDual: inventory.updateDeviceSerialsDual,

  // Customer Master Database (paged server-side reads)
  getCustomers: inventory.getCustomers,
  searchCustomers: inventory.searchCustomers,
  searchGlobal: search.searchGlobal,
  getProducts: inventory.getProducts,
  createCustomer: inventory.createCustomer,
  bulkImportCustomers: inventory.bulkImportCustomers,
  updateCustomer: inventory.updateCustomer,
  deleteCustomer: inventory.deleteCustomer,

  // Serial Log Register (one row per unique serial)
  getSerialLogs: inventory.getSerialLogs,

  // Workflow Approval Requests
  createApprovalRequest: inventory.createApprovalRequest,
  processApprovalRequest: inventory.processApprovalRequest,
  cancelApprovalRequest: inventory.cancelApprovalRequest,

  // Bikram Sambat (BS) Calendar PostgreSQL API
  getBsCalendarYears: finance.getBsCalendarYears,
  getBsDayRecords: finance.getBsDayRecords,
  getBsDayRecordByAdDate: finance.getBsDayRecordByAdDate,
  seedBsCalendarYear: finance.seedBsCalendarYear,
  seedBsCalendarYearsBulk: finance.seedBsCalendarYearsBulk,
  syncBsDayRange: finance.syncBsDayRange,
  updateBsCalendarYear: finance.updateBsCalendarYear,
  getBsCalendarIntegrity: finance.getBsCalendarIntegrity,
  applyBsCalendarIntegrity: finance.applyBsCalendarIntegrity,

  // Clear Demo Data
  clearDemoData: admin.clearDemoData,

  // Categories API
  getCategories: admin.getCategories,
  createCategory: admin.createCategory,
  updateCategory: admin.updateCategory,
  deleteCategory: admin.deleteCategory,

  // Product Group API
  getProductGroups: admin.getProductGroups,
  createProductGroup: admin.createProductGroup,
  updateProductGroup: admin.updateProductGroup,
  deleteProductGroup: admin.deleteProductGroup,

  // UoM API
  getUoms: admin.getUoms,
  createUom: admin.createUom,
  updateUom: admin.updateUom,
  deleteUom: admin.deleteUom,

  // Locations API
  getLocations: admin.getLocations,
  createLocation: admin.createLocation,
  deleteLocation: admin.deleteLocation,

  // Company Profile API
  updateCompanyProfile: admin.updateCompanyProfile,

  // Permissions
  getPermissionsMatrix: admin.getPermissionsMatrix,
  savePermissionsMatrix: admin.savePermissionsMatrix,
  getMyPermissions: admin.getMyPermissions,
  getOperationPermissionOverrides: admin.getOperationPermissionOverrides,
  getUserAccessSummaries: admin.getUserAccessSummaries,
  getUserPermissionOverrides: admin.getUserPermissionOverrides,
  saveUserPermissionOverrides: admin.saveUserPermissionOverrides,
  getPermissionSets: admin.getPermissionSets,
  createPermissionSet: admin.createPermissionSet,
  updatePermissionSet: admin.updatePermissionSet,
  deletePermissionSet: admin.deletePermissionSet,
  saveUserPermissionSets: admin.saveUserPermissionSets,

  // Server-side settings & user preferences (replaces browser localStorage)
  getSettings: settings.getSettings,
  saveAppSettings: settings.saveAppSettings,
  savePreferences: settings.savePreferences,
};
