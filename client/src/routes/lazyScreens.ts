/**
 * Every lazily-loaded screen, declared once.
 *
 * App.tsx used to open with ~230 lines of `React.lazy(...)` declarations before
 * any component code. They live here instead: the route table imports names,
 * and the screen chunks stay identical (each `import()` is still dynamic, so
 * the bundle split is unchanged). Keep this file free of app state — it is
 * imported by the route tree and must stay safe under `node:test`.
 */
import React from 'react';

export const BranchStockTracking = React.lazy(() =>
  import('../features/inventory/BranchStockTracking').then((m) => ({ default: m.BranchStockTracking }))
);
export const FixedAssetRegister = React.lazy(() =>
  import('../features/finance/FixedAssetRegister').then((m) => ({ default: m.FixedAssetRegister }))
);
export const CustomersManagement = React.lazy(() =>
  import('../features/sales/CustomersManagement').then((m) => ({ default: m.CustomersManagement }))
);
export const CustomerMasterDirectory = React.lazy(() =>
  import('../features/sales/CustomerMasterDirectory').then((m) => ({ default: m.CustomerMasterDirectory }))
);
export const SalesAgentsAreasManagement = React.lazy(() =>
  import('../features/sales/SalesAgentsAreasManagement').then((m) => ({ default: m.SalesAgentsAreasManagement }))
);
export const SerialLogRegister = React.lazy(() =>
  import('../features/inventory/SerialLogRegister').then((m) => ({ default: m.SerialLogRegister }))
);
export const PurchaseInvoices = React.lazy(() =>
  import('../features/procurement/PurchaseInvoices').then((m) => ({ default: m.PurchaseInvoices }))
);
export const SalesInvoices = React.lazy(() =>
  import('../features/sales/SalesInvoices').then((m) => ({ default: m.SalesInvoices }))
);
export const ReturnsRegister = React.lazy(() =>
  import('../features/sales/ReturnsRegister').then((m) => ({ default: m.ReturnsRegister }))
);
export const Shipments = React.lazy(() =>
  import('../features/procurement/Shipments').then((m) => ({ default: m.Shipments }))
);
export const PhysicalStockAudit = React.lazy(() =>
  import('../features/inventory/PhysicalStockAudit').then((m) => ({ default: m.PhysicalStockAudit }))
);
export const DamagedStockTracking = React.lazy(() =>
  import('../features/inventory/DamagedStockTracking').then((m) => ({ default: m.DamagedStockTracking }))
);
export const ReorderStockTracking = React.lazy(() =>
  import('../features/inventory/ReorderStockTracking').then((m) => ({ default: m.ReorderStockTracking }))
);
export const StockValuation = React.lazy(() =>
  import('../features/inventory/StockValuation').then((m) => ({ default: m.StockValuation }))
);
export const StockMovementLedger = React.lazy(() =>
  import('../features/inventory/StockMovementLedger').then((m) => ({ default: m.StockMovementLedger }))
);
export const AssetDeployments = React.lazy(() =>
  import('../features/inventory/AssetDeployments').then((m) => ({ default: m.AssetDeployments }))
);
export const SupplierWarrantyRegister = React.lazy(() =>
  import('../features/inventory/SupplierWarrantyRegister').then((m) => ({
    default: m.SupplierWarrantyRegister,
  }))
);
export const FieldWorkOrders = React.lazy(() =>
  import('../features/sales/FieldWorkOrders').then((m) => ({ default: m.FieldWorkOrders }))
);
export const SellerWarrantyRegister = React.lazy(() =>
  import('../features/inventory/SellerWarrantyRegister').then((m) => ({
    default: m.SellerWarrantyRegister,
  }))
);
export const CategoryManagement = React.lazy(() =>
  import('../features/inventory/CategoryManagement').then((m) => ({ default: m.CategoryManagement }))
);
export const ProductGroupManagement = React.lazy(() =>
  import('../features/inventory/ProductGroupManagement').then((m) => ({ default: m.ProductGroupManagement }))
);
export const UomManagement = React.lazy(() =>
  import('../features/inventory/UomManagement').then((m) => ({ default: m.UomManagement }))
);
export const ImportStock = React.lazy(() =>
  import('../features/inventory/ImportStock').then((m) => ({ default: m.ImportStock }))
);
export const ExportStock = React.lazy(() =>
  import('../features/inventory/ExportStock').then((m) => ({ default: m.ExportStock }))
);
export const TrialBalanceRegister = React.lazy(() =>
  import('../features/finance/TrialBalanceRegister').then((m) => ({ default: m.TrialBalanceRegister }))
);
export const BsLedgerSummaryRegister = React.lazy(() =>
  import('../features/finance/BsLedgerSummaryRegister').then((m) => ({
    default: m.BsLedgerSummaryRegister,
  }))
);
export const ProfitAndLossRegister = React.lazy(() =>
  import('../features/finance/ProfitAndLossRegister').then((m) => ({ default: m.ProfitAndLossRegister }))
);
export const BranchConsolidatedRegister = React.lazy(() =>
  import('../features/finance/BranchConsolidatedRegister').then((m) => ({ default: m.BranchConsolidatedRegister }))
);
export const BalanceSheetRegister = React.lazy(() =>
  import('../features/finance/BalanceSheetRegister').then((m) => ({ default: m.BalanceSheetRegister }))
);
export const CashFlowRegister = React.lazy(() =>
  import('../features/finance/CashFlowRegister').then((m) => ({ default: m.CashFlowRegister }))
);
export const CashBookRegister = React.lazy(() =>
  import('../features/finance/CashBookRegister').then((m) => ({ default: m.CashBookRegister }))
);
export const RecurringCloseRegister = React.lazy(() =>
  import('../features/finance/RecurringCloseRegister').then((m) => ({
    default: m.RecurringCloseRegister,
  }))
);
export const AgingRegister = React.lazy(() =>
  import('../features/finance/AgingRegister').then((m) => ({ default: m.AgingRegister }))
);
export const ChartOfAccountsRegister = React.lazy(() =>
  import('../features/finance/ChartOfAccountsRegister').then((m) => ({ default: m.ChartOfAccountsRegister }))
);
export const PostingRulesRegister = React.lazy(() =>
  import('../features/finance/PostingRulesRegister').then((m) => ({ default: m.PostingRulesRegister }))
);
export const JournalEntry = React.lazy(() =>
  import('../features/finance/VoucherEntries').then((m) => ({ default: m.JournalEntry }))
);
export const CashBankEntry = React.lazy(() =>
  import('../features/finance/VoucherEntries').then((m) => ({ default: m.CashBankEntry }))
);
export const PostedVouchers = React.lazy(() =>
  import('../features/finance/PostedVouchers').then((m) => ({ default: m.PostedVouchers }))
);
export const PayrollPostingsRegister = React.lazy(() =>
  import('../features/finance/PayrollPostingsRegister').then((m) => ({
    default: m.PayrollPostingsRegister,
  }))
);
export const SubledgersManagement = React.lazy(() =>
  import('../features/finance/SubledgersManagement').then((m) => ({ default: m.SubledgersManagement }))
);
export const LendersManagement = React.lazy(() =>
  import('../features/finance/LendersManagement').then((m) => ({ default: m.LendersManagement }))
);
export const BillTermsManagement = React.lazy(() =>
  import('../features/finance/BillTermsManagement').then((m) => ({ default: m.BillTermsManagement }))
);
export const CostCentersManagement = React.lazy(() =>
  import('../features/finance/CostCentersManagement').then((m) => ({ default: m.CostCentersManagement }))
);
export const EmployeeDirectory = React.lazy(() =>
  import('../features/hr/EmployeeDirectory').then((m) => ({ default: m.EmployeeDirectory }))
);
export const EmployeeSelfService = React.lazy(() => import('../features/hr/EmployeeSelfService'));
export const EmployeePayslips = React.lazy(() => import('../features/hr/EmployeePayslips'));
export const EmployeeLeave = React.lazy(() => import('../features/hr/EmployeeLeave'));
export const EmployeeAttendance = React.lazy(() => import('../features/hr/EmployeeAttendance'));
export const EmployeeDocuments = React.lazy(() => import('../features/hr/EmployeeDocuments'));
export const Recruitment = React.lazy(() => import('../features/hr/Recruitment'));
export const Performance = React.lazy(() => import('../features/hr/Performance'));
export const Lifecycle = React.lazy(() => import('../features/hr/Lifecycle'));
export const HrReports = React.lazy(() => import('../features/hr/HrReports'));
export const AttendanceLeave = React.lazy(() =>
  import('../features/hr/AttendanceLeave').then((m) => ({ default: m.AttendanceLeave }))
);
export const OrgMasters = React.lazy(() =>
  import('../features/hr/OrgMasters').then((m) => ({ default: m.OrgMasters }))
);
export const OrgChart = React.lazy(() =>
  import('../features/hr/OrgChart').then((m) => ({ default: m.OrgChart }))
);
export const Payroll = React.lazy(() =>
  import('../features/hr/Payroll').then((m) => ({ default: m.Payroll }))
);
export const NarrationTemplatesManagement = React.lazy(() =>
  import('../features/finance/NarrationTemplatesManagement').then((m) => ({ default: m.NarrationTemplatesManagement }))
);
export const DailyCashClose = React.lazy(() =>
  import('../features/finance/DailyCashClose').then((m) => ({ default: m.DailyCashClose }))
);
export const FinanceDashboard = React.lazy(() =>
  import('../features/finance/FinanceDashboard').then((m) => ({ default: m.FinanceDashboard }))
);
export const CompanyOverview = React.lazy(() =>
  import('../features/dashboard/CompanyOverview').then((m) => ({ default: m.CompanyOverview }))
);
export const VatRegister = React.lazy(() =>
  import('../features/finance/VatRegister').then((m) => ({ default: m.VatRegister }))
);
export const DepreciationRegister = React.lazy(() =>
  import('../features/finance/DepreciationRegister').then((m) => ({ default: m.DepreciationRegister }))
);
export const AuditTrailReports = React.lazy(() =>
  import('../features/finance/AuditTrailReports').then((m) => ({ default: m.AuditTrailReports }))
);
export const DocumentNumbering = React.lazy(() =>
  import('../features/finance/DocumentNumbering').then((m) => ({ default: m.DocumentNumbering }))
);
export const OpeningStockManager = React.lazy(() =>
  import('../features/finance/OpeningStockManager').then((m) => ({ default: m.OpeningStockManager }))
);
export const VendorOpeningBalances = React.lazy(() =>
  import('../features/finance/VendorOpeningBalances').then((m) => ({ default: m.VendorOpeningBalances }))
);
export const VendorLedger = React.lazy(() =>
  import('../features/finance/VendorLedger').then((m) => ({ default: m.VendorLedger }))
);
export const CustomerLedger = React.lazy(() =>
  import('../features/finance/CustomerLedger').then((m) => ({ default: m.CustomerLedger }))
);
export const EmployeeLedger = React.lazy(() =>
  import('../features/finance/EmployeeLedger').then((m) => ({ default: m.EmployeeLedger }))
);
export const FiscalYearClosingWizard = React.lazy(() =>
  import('../features/finance/FiscalYearClosingWizard').then((m) => ({ default: m.FiscalYearClosingWizard }))
);
export const LocationsManagement = React.lazy(() =>
  import('../features/settings/LocationsManagement').then((m) => ({ default: m.LocationsManagement }))
);
export const ImportCustomers = React.lazy(() =>
  import('../features/sales/ImportCustomers').then((m) => ({ default: m.ImportCustomers }))
);
export const ClearDemoDataView = React.lazy(() =>
  import('../components/common/ClearDemoDataView').then((m) => ({ default: m.ClearDemoDataView }))
);
export const DataRecalculationMaintenance = React.lazy(() =>
  import('../features/settings/DataRecalculationMaintenance').then((m) => ({ default: m.DataRecalculationMaintenance }))
);
export const BsCalendarUtility = React.lazy(() =>
  import('../features/finance/BsCalendarUtility').then((m) => ({
    default: m.BsCalendarUtility,
  }))
);
export const NepaliFiscalManagement = React.lazy(() =>
  import('../features/finance/NepaliFiscalManagement').then((m) => ({
    default: m.NepaliFiscalManagement,
  }))
);
export const PermissionManagementLazy = React.lazy(() =>
  import('../features/settings/PermissionManagement').then((m) => ({ default: m.PermissionManagement }))
);
export const ApiKeysLazy = React.lazy(() =>
  import('../features/settings/ApiKeys').then((m) => ({ default: m.ApiKeys }))
);
export const UserPermissionsLazy = React.lazy(() =>
  import('../features/settings/UserPermissions').then((m) => ({ default: m.UserPermissions }))
);
export const ApprovalWorkflowCenter = React.lazy(() =>
  import('../features/settings/ApprovalWorkflowCenter').then((m) => ({ default: m.ApprovalWorkflowCenter }))
);
export const HelpDocumentationLazy = React.lazy(() =>
  import('../components/common/HelpDocumentation').then((m) => ({ default: m.HelpDocumentation }))
);
