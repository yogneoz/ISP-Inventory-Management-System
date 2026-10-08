/**
 * Bootstrap controller — HTTP orchestration for the bootstrap domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import {
  APP_SETTING_KEYS,
  APP_SETTINGS_SELECT_SQL,
  USER_PREFERENCE_KEYS,
  USER_PREFERENCES_SELECT_SQL,
  rowsToRecord,
} from '../models/settings.repo';
import { PERMISSION_MATRIX_SELECT_SQL, rowsToPermissionMatrix } from '../models/permissions.repo';
import { fetchBootstrapSlice } from '../models/bootstrap.repo';
import { getPgConnected, fetchFiscalYears, pgPool, pickCurrentFiscalYear, toCalendarDate, fetchOperationalData, fetchOpeningStock, products, purchaseOrders, purchaseInvoices, shipments, stockOperations, transactionLogs, approvalRequests, vendorPayments, computeTradingFromOps, branches, fiscalYears, suppliers, users, categories, companyProfile, damageRecords, serialLogs, getDataVersion, setPgConnected, setIsPgConnected, inventoryStock, assetRegister, customerDeviceRecords, customerMasterRecords, auditTrail, locationRecords, getUserFromReq } from '../app';
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
      // Posted purchase returns (debit notes) reduce the payable exactly like
      // payments, so the dashboard AP reconciles with the Vendor Ledger's
      // opening + invoices − payments − returns formula.
      const postedPurchaseReturns = (data.purchaseReturns || [])
        .filter((r: any) => r.status === 'POSTED')
        .reduce((sum: number, r: any) => sum + Number(r.grandTotal || 0), 0);
      const totalAccountsPayable = vendorOpeningBalTotal + currentPeriodInvoiceTotal - postedPayments - postedPurchaseReturns;
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

      // Server-side settings + the calling user's preferences. These replace
      // the browser-localStorage copies (company-wide blind stock-audit toggle,
      // theme, date mode, last active tab), so clearing browser storage can
      // never change how the application behaves.
      const bootstrapUser = getUserFromReq(req);
      const [appSettingsRes, userPrefsRes] = await Promise.all([
        pgPool.query(APP_SETTINGS_SELECT_SQL),
        bootstrapUser.id
          ? pgPool.query(USER_PREFERENCES_SELECT_SQL, [bootstrapUser.id])
          : Promise.resolve({ rows: [] as Array<{ key: string; value: string }> }),
      ]);

      res.setHeader('Cache-Control', 'private, no-cache');
      return res.json({
        branches: data.branches,
        products: pgProducts,
        stock: pgStock,
        assets: pgAssets,
        customerDevices: pgCustomerDevices,
        customers: data.customers,
        salesInvoices: data.salesInvoices,
        purchaseReturns: data.purchaseReturns,
        salesReturns: data.salesReturns,
        shipments: pgShipments,
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
        // never loaded wholesale into the first-paint payload):
        //   - serialLogs        → GET /api/serial-log        (paged envelope; register self-fetches)
        //   - stockOperations   → GET /api/stock-operations   (paged envelope; register self-fetches)
        //   - purchaseOrders    → GET /api/purchase-orders    (paged envelope; register self-fetches)
        //   - purchaseInvoices  → GET /api/purchase-invoices  (paged envelope; register self-fetches)
        // Their remaining wholesale consumers (dashboard/notification KPIs,
        // the FY closing wizard, the PI PO dropdown, the movement ledger,
        // StockOperations' panels, global search) are served by the client's
        // deferred slice hydration right after bootstrap —
        // GET /api/bootstrap/local?key=<slice>, the same endpoint the SSE
        // targeted refresh uses — so freshness is identical while first
        // paint gets a lighter payload. financialSummary above still
        // COMPUTES from these three tables server-side; only the rows are
        // not shipped. See README "Paged Register Endpoints".
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
        // Mirror-drift fix (#7): the matrix is read live from PostgreSQL
        // (same source the permission middleware enforces), never from the
        // in-memory startup mirror — a manual DB edit or a second server
        // instance can never be served stale.
        permissionsMatrix: rowsToPermissionMatrix(
          (await pgPool.query(PERMISSION_MATRIX_SELECT_SQL)).rows
        ),
        appSettings: rowsToRecord(appSettingsRes.rows, APP_SETTING_KEYS),
        userPreferences: rowsToRecord(userPrefsRes.rows, USER_PREFERENCE_KEYS),
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

/**
 * Targeted-refresh endpoint backing the client's SSE domain handling:
 * GET /api/bootstrap/local?key=<bootstrapSliceKey>[&branchId=...][&fiscalYearId=...]
 * Returns just ONE slice of the bootstrap payload (plus its dataVersion), so
 * a real-time event can refresh a single domain instead of re-downloading
 * the entire bootstrap. Keys map to the same slice names the bootstrap
 * response uses, so the client can feed the result straight into its
 * existing applyBootstrapData-style setters.
 */
export async function get_bootstrapLocal(req: any, res: Response): Promise<any> {
  try {
    const key = String(req.query.key || '');
    const { branchId, fiscalYearId } = req.query;
    const bId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;
    const fId = typeof fiscalYearId === 'string' && fiscalYearId.trim() !== '' ? fiscalYearId : undefined;

    // Mirror-drift fix (#7): every slice is read LIVE from PostgreSQL —
    // company-wide slices through their BOOTSTRAP_TABLES mapping and the
    // permission matrix through its own SELECT; nothing is served from the
    // in-memory mirrors, so a manual DB edit, a second server instance or a
    // missed cache refresh can never be served stale. appSettings keeps its
    // dedicated repo SELECT (it has no bootstrap-table mapping). The mirror
    // arrays remain only as the operational cache for OTHER controllers and
    // as a resilience fallback if the live read itself fails.
    const scope: Record<string, unknown> = { key };
    if (bId || fId) {
      const pgFiscalYears = await fetchFiscalYears(pgPool);
      const selectedFiscalYear = fId
        ? pgFiscalYears.find((fy: any) => fy.id === fId)
        : pickCurrentFiscalYear(pgFiscalYears);
      if (selectedFiscalYear) {
        scope.fiscalYearId = selectedFiscalYear.id;
        scope.fiscalYearStartAD = toCalendarDate(selectedFiscalYear.startDateAD);
        scope.fiscalYearEndAD = toCalendarDate(selectedFiscalYear.endDateAD);
      }
    }
    const scopeParams = {
      branchId: bId,
      fiscalYearId: scope.fiscalYearId as string | undefined,
      fiscalYearStartAD: scope.fiscalYearStartAD as string | undefined,
      fiscalYearEndAD: scope.fiscalYearEndAD as string | undefined,
    };

    // The permission matrix is not a bootstrap table — it folds from its
    // own (operation_id, role, allowed) rows.
    if (key === 'permissionsMatrix') {
      const matrix = rowsToPermissionMatrix(
        (await pgPool.query(PERMISSION_MATRIX_SELECT_SQL)).rows
      );
      return res.json({ dataVersion: getDataVersion(), permissionsMatrix: matrix });
    }

    // appSettings is not an in-memory mirror — it is read from PostgreSQL
    // (the same query the full bootstrap uses) so a just-committed
    // PUT /api/settings is visible to the targeted slice immediately.
    if (key === 'appSettings') {
      const appSettingsRes = await pgPool.query(APP_SETTINGS_SELECT_SQL);
      return res.json({
        dataVersion: getDataVersion(),
        appSettings: rowsToRecord(appSettingsRes.rows, APP_SETTING_KEYS),
      });
    }

    // Everything else with a BOOTSTRAP_TABLES mapping reads live. A slice
    // the operational-data query serves (branch/FY-scoped keys) or a
    // mapped company-wide key both resolve through here.
    try {
      const slice = await fetchBootstrapSlice(pgPool, key, scopeParams);
      if (slice !== undefined) {
        return res.json({ dataVersion: getDataVersion(), [key]: slice });
      }
    } catch (sliceErr: any) {
      // No table mapping for this key (or the live read failed): fall back
      // to the operational-data query, then the operational cache — the
      // pre-#7 behavior — so an unknown key can never 500 a refresh.
      console.warn(`bootstrap/local live read failed for ${key}:`, sliceErr?.message || sliceErr);
    }

    const data = await fetchOperationalData(pgPool, scope as any);
    const operationalSlice = (data as any)[key];
    if (operationalSlice !== undefined) {
      return res.json({ dataVersion: getDataVersion(), [key]: operationalSlice });
    }

    // Last resort: the operational cache mirrors (covers unmapped keys).
    const cacheSlices: Record<string, unknown> = {
      categories,
      companyProfile,
      locations: locationRecords,
      suppliers,
      users,
      products,
      branches,
      fiscalYears,
      approvalRequests,
      assets: assetRegister,
      auditLogs: auditTrail,
    };
    return res.json({ dataVersion: getDataVersion(), [key]: cacheSlices[key] });
  } catch (err: any) {
    res.status(500).json({ message: `Bootstrap local slice failed: ${err.message}` });
  }
}
