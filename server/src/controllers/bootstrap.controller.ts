/**
 * Bootstrap controller — HTTP orchestration for the bootstrap domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { adoptSharedStateVersion } from '../state/bootstrapVersion';
import {
  APP_SETTING_KEYS,
  APP_SETTINGS_SELECT_SQL,
  USER_PREFERENCE_KEYS,
  USER_PREFERENCES_SELECT_SQL,
  rowsToRecord,
} from '../models/settings.repo';
import { PERMISSION_MATRIX_SELECT_SQL, rowsToPermissionMatrix } from '../models/permissions.repo';
import { fetchBootstrapFirstPaint, fetchBootstrapSlice } from '../models/bootstrap.repo';
import { BOOTSTRAP_TABLES } from '../models/columnMappings';
import { fetchFinancialSummaryFromDb } from '../services/financialSummary.service';
import { getPgConnected, fetchFiscalYears, pgPool, pickCurrentFiscalYear, selectBootstrapFiscalYear, toCalendarDate, fetchOperationalData, fetchOpeningStock, products, approvalRequests, branches, fiscalYears, suppliers, users, categories, companyProfile, getDataVersion, assetRegister, locationRecords, getUserFromReq, permissionMatrix, userPermissionOverrides, userPermissionSetGrants } from '../app';
import { classifyDbFailure, noteDbFailure } from '../../db';
import { dbBreaker } from '../observability/dbBreaker';
import { ApiError } from '../errors/ApiError';
import { DbBusyError, DbUnavailableError } from '../errors/dbErrors';
import { effectivePermission } from '../services/permissionOverrides.service';

/**
 * AUTHZ-11: the Activities Log screen is gated on `admin-audit`, but the
 * bootstrap payload carried every audit row to every signed-in role, and
 * `bootstrap/local?key=auditLogs` served them on demand. Only that screen
 * consumes the array, so an ungranted role gets an empty one — a 403 would
 * make the client's targeted refresh treat the slice as failed and fall back
 * to a full bootstrap on every audit event.
 */
/**
 * OPS-2: weak validator over the payload version and the request's personal
 * scope. It is computed BEFORE the first query so a 304 costs no database
 * work. The fiscal-year component is the *requested* selector, not the
 * resolved year: resolving the default year would itself require a query.
 * Every successful write bumps stateVersion (shared through Redis when workers
 * share a store), and user.ver covers role, branch scope, switch permission,
 * status and password, so the only way to change the payload without changing
 * this value is an out-of-band SQL edit; a restart or any later write
 * revalidates.
 */
async function bootstrapEtag(user: any, branchId?: string, fiscalYearId?: string): Promise<string> {
  const version = await adoptSharedStateVersion();
  const scope = `${user?.id || ''}|${user?.ver ?? ''}|${branchId || ''}|${fiscalYearId || ''}`;
  return `W/"${version}-${createHash('sha1').update(scope).digest('hex')}"`;
}

/** RFC 9110 If-None-Match uses weak comparison; '*' matches anything. */
function ifNoneMatchMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const values = Array.isArray(header) ? header : [header];
  return values.some((value) =>
    value
      .split(',')
      .map((candidate) => candidate.trim())
      .some((candidate) => candidate === '*' || candidate === etag)
  );
}

function canReadAuditLogs(user: any): boolean {
  if (!user?.email) return false;
  // Resolver, not the raw role row: a per-user grant of `admin-audit` must
  // reveal the trail, and a deny must hide it even for a role that has it.
  return effectivePermission(user, 'admin-audit', permissionMatrix, userPermissionOverrides, userPermissionSetGrants);
}

/**
 * The team list is other people's identities: names, e-mails, roles and
 * branches. Only accounts that can act on another login need it — the profile
 * switcher (`can_switch_user`) and user administration. Everyone else gets an
 * empty array, so the list never rides the payload of a role that cannot use
 * it. The employee picker those screens use reads
 * GET /api/employees/user-options instead, which is manage-gated.
 */
function canReadUserList(user: any): boolean {
  if (!user?.email) return false;
  if (user.canSwitchUser) return true;
  return effectivePermission(
    user,
    'admin-users',
    permissionMatrix,
    userPermissionOverrides,
    userPermissionSetGrants
  );
}

/**
 * One guard for every place a `users` slice can leave the server: the full
 * payload, the targeted live slice and the operational-cache fallback all
 * answer with the same empty list when the caller cannot act on other logins.
 */
function gateUserSlice(key: string, value: unknown, req: any): unknown {
  if (key !== 'users') return value;
  return canReadUserList(getUserFromReq(req)) ? value : [];
}

/** Forwarded from bootstrap.routes.ts (get_bootstrap). */
export async function get_bootstrap(req: any, res: Response): Promise<any> {
const { branchId, fiscalYearId } = req.query;
  const bId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;
  const fId = typeof fiscalYearId === 'string' && fiscalYearId.trim() !== '' ? fiscalYearId : undefined;
  const bootstrapUser = getUserFromReq(req);

  // Compute the validator before any query and answer a matching conditional
  // request immediately. Compression must never see a 304 body, and the ETag
  // must exist before res.json() runs.
  const etag = await bootstrapEtag(bootstrapUser, bId, fId);
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Authorization, Accept-Encoding');
  res.setHeader('Cache-Control', 'private, no-cache');
  if (ifNoneMatchMatches(req.headers?.['if-none-match'], etag)) {
    res.status(304).end();
    return;
  }

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

      // SCALE-2: first paint reads only the shell rows. Products, stock,
      // suppliers and the rest of the master tables are deferred slices or
      // paged registers, so their size no longer scales the login payload.
      const data = await fetchBootstrapFirstPaint(pgPool, {
        branchId: bId,
        fiscalYearId: selectedFiscalYear.id,
        fiscalYearStartAD: fyStartAD,
        fiscalYearEndAD: fyEndAD,
      });

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
      const [appSettingsRes, userPrefsRes] = await Promise.all([
        pgPool.query(APP_SETTINGS_SELECT_SQL),
        bootstrapUser.id
          ? pgPool.query(USER_PREFERENCES_SELECT_SQL, [bootstrapUser.id])
          : Promise.resolve({ rows: [] as Array<{ key: string; value: string }> }),
      ]);

      return res.json({
        branches: data.branches,
        fiscalYears: pgFiscalYears,
        financialSummary,
        // The team list is other people's identities: names, e-mails, roles and
        // branches. Only accounts that can act on another login need it — the
        // profile switcher (can_switch_user) and user administration. Everyone
        // else gets an empty list; the employee picker they use reads
        // GET /api/employees/user-options instead, which is manage-gated.
        users: canReadUserList(bootstrapUser) ? data.users : [],
        companyProfile: data.companyProfile[0] || companyProfile,
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
        //   - customers         → GET /api/customers          (VOL-4a: paged, searchable,
        //                          branch-scoped; the pickers read ≤20 matches and the
        //                          directory pages; no screen holds the national table)
        //   - customerDevices   → GET /api/customer-devices/page (VOL-4b: the register
        //                          pages, /overview feeds its KPIs, /warranty unions CPE
        //                          and fixed assets with a computed warranty state)
        //   - assets            → GET /api/fixed-assets/page (ASSET-1: both asset
        //                          registers page, /overview feeds the dashboard,
        //                          statements and closing wizard, /available feeds the
        //                          deployment pickers, /lookup resolves one row; the
        //                          table grows with the installed base and never ages
        //                          out by fiscal year, so it never enters first paint)
        //   - purchaseReturns  → GET /api/purchase-returns and
        //                          /api/bootstrap/local?key=purchaseReturns (OPS-3:
        //                          the register pages; the deferred slice keeps the
        //                          returnable-quantity calculation complete)
        //   - salesReturns     → GET /api/sales-returns and
        //                          /api/bootstrap/local?key=salesReturns (OPS-3)
        //   - auditLogs        → GET /api/bootstrap/local?key=auditLogs (OPS-3:
        //                          the Activities Log hydrates after bootstrap;
        //                          the 200-row cap stays in the mapping, so the
        //                          login payload no longer carries the trail)
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
      // Classify, never blanket-flip the flag: a query error is not an outage,
      // and only an availability category earns a retryable 503. The typed
      // errors carry Retry-After and a stable code; the central handler emits
      // them, so the driver text never reaches the caller.
      const kind = classifyDbFailure(pgErr, true);
      noteDbFailure(kind);
      console.error('PostgreSQL bootstrap query failed:', pgErr?.message || pgErr);
      if (pgErr instanceof ApiError && pgErr.status === 503) throw pgErr;
      if (kind === 'pool_acquire_timeout' || kind === 'statement_timeout') throw new DbBusyError();
      if (kind === 'connect_timeout' || kind === 'server_unreachable' || kind === 'socket_dropped') {
        throw new DbUnavailableError();
      }
      return res.status(500).json({
        message: 'The application data could not be loaded. The server log has the details.',
      });
    }
  }
  res.setHeader('Retry-After', String(Math.max(1, dbBreaker.retryAfterSeconds())));
  return res.status(503).json({
    message: 'The database is temporarily unavailable. Retry shortly.',
    code: 'DB_UNAVAILABLE',
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
    if (key === 'auditLogs' && !canReadAuditLogs(getUserFromReq(req))) {
      return res.json({ dataVersion: getDataVersion(), auditLogs: [] });
    }
    const { branchId, fiscalYearId } = req.query;
    let bId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;

    // AUTHZ-10: the slice endpoint's branch filter was optional for branch
    // accounts, so `?key=customers` with no branchId read every branch — the
    // same gap Round 7 measured on the retired device slice. The full
    // `/bootstrap` read has always required the caller's own branch; a slice
    // of a branch-scoped table (or the computed financial summary) now
    // defaults to that branch instead of all of them. Company-wide keys
    // (products, suppliers, settings, …) keep their global read.
    const sliceUser = getUserFromReq(req) as any;
    const sliceGlobalViewer =
      !sliceUser?.email ||
      sliceUser.role === 'SUPER_ADMIN' ||
      sliceUser.role === 'HEAD_OFFICE_ADMIN' ||
      sliceUser.branchId === 'ALL';
    if (!sliceGlobalViewer) {
      const mapping = (BOOTSTRAP_TABLES as Record<string, any>)[key];
      const branchScopedKey =
        key === 'financialSummary' ||
        Boolean(mapping?.scope?.branchCol || mapping?.scope?.branchOrCols);
      if (branchScopedKey && !bId) bId = String(sliceUser.branchId || '') || undefined;
    }
    const fId = typeof fiscalYearId === 'string' && fiscalYearId.trim() !== '' ? fiscalYearId : undefined;

    // CDR-2: the customerDevices slice is RETIRED, not missing. It answered the
    // whole customer_device_records table (no LIMIT, and its branch/fiscal-year
    // scope came from the caller) to a cached pre-VOL-4b bundle that no current
    // screen can call; its mapping now feeds the operational cache alone
    // (CACHE_ONLY_TABLES). Answer definitively — never a 200 with rows, and not
    // a 503, which would read as "retry" for a permanent retirement.
    if (key === 'customerDevices') {
      return res.status(410).json({
        message:
          'The customerDevices bootstrap slice was retired (CDR-2, 2026-10-27). ' +
          'Read devices from GET /api/customer-devices/page (counts from /overview, warranty from /warranty).',
        sliceRetired: true,
      });
    }

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
        return res.json({ dataVersion: getDataVersion(), [key]: gateUserSlice(key, slice, req) });
      }
    } catch (sliceErr: any) {
      // No table mapping for this key (or the live read failed): fall back
      // to the operational-data query, then the operational cache — the
      // pre-#7 behavior — so an unknown key can never 500 a refresh.
      console.warn(`bootstrap/local live read failed for ${key}:`, sliceErr?.message || sliceErr);
      // BOOT-1/ASSET-1/OPS-3 removed these from the operational fan-out, so
      // there is no fallback data for them. Answer honestly instead of a
      // payload with only dataVersion, which the client would treat as empty.
      if ([
        'purchaseOrders', 'purchaseInvoices', 'stockOperations', 'vendorPayments',
        'customers', 'assets', 'purchaseReturns', 'salesReturns', 'auditLogs',
      ].includes(key)) {
        return res.status(503).json({
          message: `Could not read ${key} from PostgreSQL. Retry shortly; the rows on screen are unchanged.`,
        });
      }
    }

    const data = await fetchOperationalData(pgPool, scope as any);
    const operationalSlice = (data as any)[key];
    if (operationalSlice !== undefined) {
      return res.json({
        dataVersion: getDataVersion(),
        [key]: gateUserSlice(key, operationalSlice, req),
      });
    }

    // Last resort: the operational cache mirrors (covers unmapped keys).
    // H1 (audit 2026-11-28): `auditLogs` was listed here and `auditTrail` is
    // NOT a hydrating cache - OPS-3 took the audit trail off the boot fan-out -
    // so the key would have answered `[]`, which the client stores as "the
    // audit trail is empty", instead of the 503 above. It is removed rather
    // than left as a trap. `assets` deliberately stays: it is pinned by
    // tests/fixedAssetsOffBootstrap.test.ts as the compatibility answer an
    // older client bundle still gets, and the live slice read runs first.
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
    };
    return res.json({
      dataVersion: getDataVersion(),
      [key]: gateUserSlice(key, cacheSlices[key], req),
    });
  } catch (err: any) {
    res.status(500).json({ message: `Bootstrap local slice failed: ${err.message}` });
  }
}
