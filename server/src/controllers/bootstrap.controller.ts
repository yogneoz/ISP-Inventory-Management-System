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
import { fetchFinancialSummaryFromDb } from '../services/financialSummary.service';
import { getPgConnected, fetchFiscalYears, pgPool, pickCurrentFiscalYear, selectBootstrapFiscalYear, toCalendarDate, fetchOperationalData, fetchOpeningStock, products, approvalRequests, branches, fiscalYears, suppliers, users, categories, companyProfile, getDataVersion, setPgConnected, setIsPgConnected, assetRegister, auditTrail, locationRecords, getUserFromReq } from '../app';
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
      //
      // A fiscal year is a PRECONDITION of this payload, and failing to resolve
      // one is a configuration problem: answer it with a status and a message
      // that name the real cause. Before this, an unresolvable year fell
      // through to `selectedFiscalYear.id` and threw a TypeError that the catch
      // below retold as "PostgreSQL became unavailable" — a 503 blaming the
      // database for an empty fiscal_years table.
      const fiscalYearScope = selectBootstrapFiscalYear(pgFiscalYears, fId);
      if (!fiscalYearScope.ok) {
        if (fiscalYearScope.reason === 'not-found') {
          return res.status(400).json({
            message:
              `Fiscal year '${fiscalYearScope.requestedId}' does not exist. ` +
              'Pick a fiscal year that is configured (GET /api/fiscal-years) and reload.',
            fiscalYearNotFound: true,
          });
        }
        // Both messages must name a screen the UI actually shows. They used to
        // say "Fiscal Year Management", which is not a nav label anywhere — the
        // tab that carries that key is labelled "Document Numbering Setup", and
        // the fiscal-year form lives in "Fiscal Year Closing Wizard". An operator
        // reading the old text had nowhere to go. tests/fiscalYearFirstCreation
        // .test.ts asserts both labels against Sidebar.tsx, so a rename here or
        // in the nav fails instead of quietly sending the next operator hunting.
        return res.status(409).json({
          message:
            fiscalYearScope.reason === 'none-configured'
              ? 'No fiscal year is configured, so there is nothing to scope application data to. ' +
                'Create one in Fiscal Year Closing Wizard (Add Fiscal Year), then reload.'
              : 'No fiscal year is flagged as current, so there is no default view to load. ' +
                'Open Fiscal Year Closing Wizard and set a year active, then reload.',
          noCurrentFiscalYear: true,
        });
      }
      // Established above: from here on the year exists, so it is safe to read.
      const selectedFiscalYear = fiscalYearScope.fiscalYear;
      const fyStartAD = toCalendarDate(selectedFiscalYear.startDateAD);
      const fyEndAD = toCalendarDate(selectedFiscalYear.endDateAD);

      const data = await fetchOperationalData(pgPool, {
        branchId: bId,
        fiscalYearId: selectedFiscalYear.id,
        fiscalYearStartAD: fyStartAD,
        fiscalYearEndAD: fyEndAD,
      });

      let pgStock = data.stock;
      if (!selectedFiscalYear.isCurrent) {
        pgStock = await fetchOpeningStock(pgPool, selectedFiscalYear.id, bId);
      }
      // Fiscal-year and branch scoping is applied in the repository queries
      // (see buildScopedWhere), so no JavaScript date filtering is needed here.
      const pgProducts = data.products;
      const pgAssets = data.assets;
      const pgCustomerDevices = data.customerDevices;
      const pgAuditLogs = data.auditLogs;
      const pgApprovalRequests = data.approvalRequests;

      // BOOT-1: the full bootstrap now uses the same aggregate producer as
      // GET /api/bootstrap/local?key=financialSummary. It used to load the
      // whole fiscal year's purchase invoices and stock operations just to
      // compute this object, then drop those arrays from the response — at
      // national volume the dominant cost of a login. The SQL aggregates read
      // only the columns they need; no item JSON leaves PostgreSQL.
      const financialSummary = await fetchFinancialSummaryFromDb(pgPool, {
        branchId: bId,
        fiscalYearId: selectedFiscalYear.id,
        fiscalYearStartAD: fyStartAD,
        fiscalYearEndAD: fyEndAD,
        // The current year's CODE is reported separately from the view scope:
        // an explicit past-year request still reports which year is current,
        // and '' when none is flagged (never a stale hard-coded default).
        currentFiscalYear: pickCurrentFiscalYear(pgFiscalYears)?.code || '',
        useOpeningStock: !selectedFiscalYear.isCurrent,
      });

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
        purchaseReturns: data.purchaseReturns,
        salesReturns: data.salesReturns,
        fiscalYears: pgFiscalYears,
        auditLogs: pgAuditLogs,
        financialSummary,
        suppliers: data.suppliers,
        users: data.users,
        approvalRequests: pgApprovalRequests,
        categories: data.categories,
        uom: data.uom,
        locations: data.locations,
        companyProfile: data.companyProfile[0] || companyProfile,
        damageRecords: data.damageRecords,
        // Tables trimmed from the bootstrap payload (each is served by its
        // own paged/filterable list endpoint instead, so large ledgers are
        // never loaded wholesale into the first-paint payload):
        //   - serialLogs        → GET /api/serial-log        (paged envelope; register self-fetches)
        //   - stockOperations   → GET /api/stock-operations   (paged envelope; register self-fetches)
        //   - purchaseOrders    → GET /api/purchase-orders    (paged envelope; register self-fetches)
        //   - purchaseInvoices  → GET /api/purchase-invoices  (paged envelope; register self-fetches)
        //   - salesInvoices     → GET /api/sales-invoices     (paged/searchable; register + returns picker)
        //   - vendorPayments    → GET /api/vendor-payments    (BOOT-1: the client never read this array)
        //   - shipments         → GET /api/shipments/page     (VOL-3: register pages;
        //                          GET /api/shipments/overview feeds the shell,
        //                          dashboard and notification counts)
        // Their remaining wholesale consumers (dashboard/notification KPIs,
        // the FY closing wizard, the PI PO dropdown, the movement ledger,
        // StockOperations' panels, global search) are served by the client's
        // deferred slice hydration right after bootstrap —
        // GET /api/bootstrap/local?key=<slice>, the same endpoint the SSE
        // targeted refresh uses — so freshness is identical while first
        // paint gets a lighter payload. financialSummary above is computed
        // server-side from aggregate SQL over the same tables (SUM-1 for
        // trading, BOOT-1 for the whole object), so no item JSON leaves
        // PostgreSQL. See README "Paged Register Endpoints".
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

    // financialSummary is COMPUTED, not a table: it is derived from stock,
    // assets, invoices, payments, returns and sale lines. Serving it through
    // the operational-data fallback below would re-read every ledger for one
    // small object, so it has a dedicated aggregate path with the same
    // branch/FY scope and the same rules as the full bootstrap (DF-05).
    if (key === 'financialSummary') {
      const pgFiscalYears = await fetchFiscalYears(pgPool);
      const fiscalYearScope = selectBootstrapFiscalYear(pgFiscalYears, fId);
      if (!fiscalYearScope.ok) {
        if (fiscalYearScope.reason === 'not-found') {
          return res.status(400).json({
            message: `Fiscal year '${fiscalYearScope.requestedId}' does not exist.`,
            fiscalYearNotFound: true,
          });
        }
        return res.status(409).json({
          message:
            'No fiscal year is flagged as current, so the financial summary cannot be scoped. ' +
            'Open Fiscal Year Closing Wizard and set a year active, then retry.',
          noCurrentFiscalYear: true,
        });
      }
      const selectedFiscalYear = fiscalYearScope.fiscalYear;
      const currentFy = pickCurrentFiscalYear(pgFiscalYears);
      const summary = await fetchFinancialSummaryFromDb(pgPool, {
        branchId: bId,
        fiscalYearId: selectedFiscalYear.id,
        fiscalYearStartAD: toCalendarDate(selectedFiscalYear.startDateAD),
        fiscalYearEndAD: toCalendarDate(selectedFiscalYear.endDateAD),
        currentFiscalYear: currentFy?.code || '',
        useOpeningStock: !selectedFiscalYear.isCurrent,
      });
      return res.json({ dataVersion: getDataVersion(), financialSummary: summary });
    }

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
      // BOOT-1 removed these four from the operational fan-out, so there is
      // no fallback data for them. Answer honestly instead of a payload with
      // only dataVersion, which the client would treat as an empty ledger.
      if (['purchaseOrders', 'purchaseInvoices', 'stockOperations', 'vendorPayments'].includes(key)) {
        return res.status(503).json({
          message: `Could not read ${key} from PostgreSQL. Retry shortly; the rows on screen are unchanged.`,
        });
      }
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
