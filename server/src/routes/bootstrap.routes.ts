/**
 * Bootstrap routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerBootstrapRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import {
  approvalRequests,
  branches,
  categories,
  companyProfile,
  computeTradingFromOps,
  damageRecords,
  fiscalYears,
  getDataVersion,
  getPgConnected,
  permissionMatrix,
  pickCurrentFiscalYear,
  products,
  purchaseInvoices,
  purchaseOrders,
  serialLogs,
  setPgConnected,
  shipments,
  stockOperations,
  suppliers,
  toCalendarDate,
  transactionLogs,
  users,
  vendorPayments,
} from '../app';
import { fetchOpeningStock, fetchOperationalData, parseSerialHistory, pgPool } from '../app';
import { fetchFiscalYears, setIsPgConnected } from '../app';

export function registerBootstrapRoutes(app: Express) {
app.get('/api/bootstrap', async (req, res) => {
  const { branchId, fiscalYearId } = req.query;
  const bId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;
  const fId = typeof fiscalYearId === 'string' && fiscalYearId.trim() !== '' ? fiscalYearId : undefined;

  if (getPgConnected()) {
    try {
      // All bootstrap SQL lives in the repository layer; column lists are
      // defined once per table in server/repositories/columnMappings.ts.
      const pgFiscalYears = await fetchFiscalYears(pgPool);
      // Default view: the active fiscal year, so the app always shows records
      // from the current fiscal year. An explicit fiscalYearId query param
      // overrides this and filters the data to that fiscal year.
      const selectedFiscalYear = fId
        ? pgFiscalYears.find((fiscalYear: any) => fiscalYear.id === fId)
        : pickCurrentFiscalYear(pgFiscalYears);
      const fyStartAD = selectedFiscalYear ? toCalendarDate(selectedFiscalYear.startDateAD) : '';
      const fyEndAD = selectedFiscalYear ? toCalendarDate(selectedFiscalYear.endDateAD) : '';

      const data = await fetchOperationalData(pgPool, {
        branchId: bId,
        fiscalYearId: selectedFiscalYear.id,
        fiscalYearStartAD: fyStartAD,
        fiscalYearEndAD: fyEndAD,
      });

      let pgStock = data.stock;
      if (selectedFiscalYear && !selectedFiscalYear.isCurrent) {
        pgStock = await fetchOpeningStock(pgPool, selectedFiscalYear.id, bId);
      }
      // Fiscal-year and branch scoping is applied in the repository queries
      // (see buildScopedWhere), so no JavaScript date filtering is needed here.
      const pgProducts = data.products;
      const pgAssets = data.assets;
      const pgCustomerDevices = data.customerDevices;
      const pgPurchaseOrders = data.purchaseOrders;
      const pgInvoices = data.purchaseInvoices;
      const pgShipments = data.shipments;
      const pgOps = data.stockOperations;
      const pgAuditLogs = data.auditLogs;
      const pgTransactionLogs = data.transactionLogs;
      const pgApprovalRequests = data.approvalRequests;
      const pgSerialLogs = parseSerialHistory(data.serialLogsRaw);

      const totalInventoryAssetValue = pgStock.reduce((sum: number, item: any) => {
        const prod = pgProducts.find((p: any) => p.id === item.productId);
        return sum + (prod ? Number(prod.costPrice) * Number(item.quantityOnHand) : 0);
      }, 0);

      const totalFixedAssetValue = pgAssets.reduce((sum: number, a: any) => sum + Number(a.netBookValue || 0), 0);
      // Accounts Payable: opening balance (carry-forward from Vendor Opening Balances)
      // + current-period unpaid invoices − posted vendor payments.  This matches
      // the Vendor Ledger closing-balance formula so all three modules reconcile.
      const vendorOpeningBalTotal = data.vendorOpeningBalanceTotal;
      // Sum full invoice grand totals, NOT (grandTotal − amountPaid): payments
      // are already subtracted once below via the posted vendor payments, so
      // subtracting amount_paid here too would double-count them.
      const currentPeriodInvoiceTotal = pgInvoices.reduce(
        (sum: number, inv: any) => sum + Number(inv.grandTotal || 0),
        0
      );
      const postedPayments = data.vendorPayments
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
        branches: data.branches,
        products: pgProducts,
        stock: pgStock,
        assets: pgAssets,
        customerDevices: pgCustomerDevices,
        customers: data.customers,
        purchaseOrders: pgPurchaseOrders,
        purchaseInvoices: pgInvoices,
        shipments: pgShipments,
        stockOperations: pgOps,
        fiscalYears: pgFiscalYears,
        auditLogs: pgAuditLogs,
        transactionLogs: pgTransactionLogs,
        financialSummary,
        suppliers: data.suppliers,
        users: data.users,
        approvalRequests: pgApprovalRequests,
        categories: data.categories,
        uom: data.uom,
        locations: data.locations,
        companyProfile: data.companyProfile[0] || companyProfile,
        damageRecords: data.damageRecords,
        vendorPayments: data.vendorPayments,
        serialLogs: pgSerialLogs,
        postgresDatabaseStatus: {
          isConnected: true,
          host: process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
          database: process.env.POSTGRES_DB || 'inventory_db',
          user: process.env.POSTGRES_USER || 'inventory_user',
          engine: 'PostgreSQL Server (External/Self-Hosted)'
        },
        serverTime: new Date().toISOString(),
        dataVersion: getDataVersion(),
        permissionsMatrix: permissionMatrix,
      });
    } catch (pgErr: any) {
      setPgConnected(false);
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

}
