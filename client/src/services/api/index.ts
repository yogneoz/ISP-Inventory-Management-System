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
import * as finance from './finance';
import * as admin from './admin';
import * as settings from './settings';

export { API_BASE, fetchJson, setAuthToken, setUserContext, setFiscalYearContext } from './http';
export { subscribeToSyncStream } from './sync';
export { safeParseHistory } from './inventory';

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
  updateStockLevel: inventory.updateStockLevel,
  updateStockReorderLevel: inventory.updateStockReorderLevel,
  bulkUpdateStockReorderLevels: inventory.bulkUpdateStockReorderLevels,
  reconcileStockAudit: inventory.reconcileStockAudit,
  createAsset: inventory.createAsset,
  updateAssetStatus: inventory.updateAssetStatus,

  // Admin recalculation / repair utilities
  recalculateFixedAssets: admin.recalculateFixedAssets,
  recalculateLiveStock: admin.recalculateLiveStock,
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

  // Financial Summary
  getFinancialSummary: finance.getFinancialSummary,

  // Customer Devices & Serial Numbers
  getCustomerDevices: inventory.getCustomerDevices,
  createCustomerDevice: inventory.createCustomerDevice,
  updateCustomerDeviceStatus: inventory.updateCustomerDeviceStatus,
  exchangeCustomerDevice: inventory.exchangeCustomerDevice,
  updateDeviceSerials: inventory.updateDeviceSerials,
  lookupSerial: inventory.lookupSerial,
  updateDeviceSerialsDual: inventory.updateDeviceSerialsDual,

  // Customer Master Database (paged server-side reads)
  getCustomers: inventory.getCustomers,
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

  // Clear Demo Data
  clearDemoData: admin.clearDemoData,

  // Categories API
  getCategories: admin.getCategories,
  createCategory: admin.createCategory,
  updateCategory: admin.updateCategory,
  deleteCategory: admin.deleteCategory,

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

  // Server-side settings & user preferences (replaces browser localStorage)
  getSettings: settings.getSettings,
  saveAppSettings: settings.saveAppSettings,
  savePreferences: settings.savePreferences,
};
