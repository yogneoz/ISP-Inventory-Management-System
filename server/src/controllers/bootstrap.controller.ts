/**
 * Bootstrap controller — HTTP orchestration for the bootstrap domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, fetchFiscalYears, pgPool, pickCurrentFiscalYear, toCalendarDate, fetchOperationalData, fetchOpeningStock, products, purchaseOrders, purchaseInvoices, shipments, stockOperations, transactionLogs, approvalRequests, vendorPayments, computeTradingFromOps, branches, fiscalYears, suppliers, users, categories, companyProfile, damageRecords, serialLogs, getDataVersion, permissionMatrix, setPgConnected, setIsPgConnected } from '../app';
/** Forwarded from bootstrap.routes.ts (get_bootstrap). */
export async function get_bootstrap(req: any, res: Response): Promise<any> {
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
        // Tables trimmed from the bootstrap payload (each is served by its
        // own paged/filterable list endpoint instead, so large ledgers are
        // never loaded wholesale into the client):
        //   - serialLogs        → GET /api/serial-log        (paged envelope)
        //   - stockOperations   → GET /api/stock-operations   (paged envelope)  [register only; consumers still use bootstrap]
        //   - purchaseOrders    → GET /api/purchase-orders    (paged envelope)  [register only; consumers still use bootstrap]
        //   - purchaseInvoices  → GET /api/purchase-invoices  (paged envelope)  [register only; consumers still use bootstrap]
        // serialLogs is the only one fully removed so far — the other three
        // still ship because non-register consumers (dashboard KPIs, the FY
        // closing wizard, the PI PO dropdown, the movement ledger) read them
        // from bootstrap state. See README "Paged Register Endpoints".
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


}

