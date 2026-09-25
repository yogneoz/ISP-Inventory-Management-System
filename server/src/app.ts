/**
 * app.ts — composition root + backward-compatible facade.
 *
 * Backlog item #6 (app.ts extraction): the 3,386-line monolith has been
 * decomposed into focused modules. This file keeps two jobs:
 *
 *  1. Composition root — binds the shared runtime state to the audit logger,
 *     SSE, doc numbering, boot module and route registration (the only place
 *     that knows all of them).
 *  2. Facade — re-exports every symbol that routes/controllers/middleware
 *     historically imported from '../app', so ZERO call sites changed.
 *
 * New code should import from the owning module, not from here:
 *   - shared state, accessors: ./state/runtimeState
 *   - transactions:            ./db/transactions
 *   - SSE:                     ./realtime/sse
 *   - audit:                   ./services/audit.service
 *   - doc numbers:             ./utils/docNumber, ./services/serverDocNumber
 *   - fiscal helpers:          ./utils/fiscalYear
 *   - trading summary:         ./utils/trading
 *   - schema/boot:             ./boot/dbBoot
 *   - role/permission core:    ./controllers/permissions.core
 *   - serial edit handler:     ./services/serialEdit.handler
 *   - super-admin re-auth:     ./services/superAdminAuth.service
 *   - vendor-payments SQL:     ./models/procurement.repo
 */
import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

import type { SharedStateAccessors } from './sharedState';
import { pgPool, realPoolInstance, ensurePostgresConnection, setIsPgConnected } from '../db';
import {
  withPrepended, withAppended, withReplaced, withSorted, mutable,
} from './utils/copyHelpers';
import {
  NEPALI_MONTHS_EN_SERVER, NEPALI_MONTHS_NP_SERVER, DAYS_OF_WEEK_EN_SERVER, DAYS_OF_WEEK_NP_SERVER,
  DEFAULT_BS_YEARS_SERVER, inMemoryBsCalendarYears, inMemoryBsDayRecords,
  setInMemoryBsCalendarYears, setInMemoryBsDayRecords, generateInMemoryBsDayRecords,
  detectDateTypeMismatch, findBsDayRecordForAdDate, hydrateBsCalendarFromDb, buildBsDayRecordsForYear,
} from './config/bsCalendar';
import {
  INITIAL_COMPANY_PROFILE, INITIAL_DOCUMENT_NUMBER_CONFIGS, INITIAL_MASTER_UOM,
  INITIAL_MASTER_LOCATIONS, INITIAL_MASTER_BRANCHES, INITIAL_MASTER_FISCAL_YEARS,
  INITIAL_MASTER_SUPPLIERS, EXAMPLE_USER_PASSWORD, INITIAL_EXAMPLE_USERS,
} from './config/seedData';
import { hashPassword, verifyPassword, issueAuthToken, getUserFromReq, verifyAuthToken } from './middleware/auth';
import {
  authenticateUser, requireAuth, requirePostgres, enforceFiscalYearWriteAccess,
  requireRole, enforceOperationalPermissions, enforceBranchAccess, requirePermission,
} from './middleware';
import { fetchFiscalYears, fetchOperationalData, fetchOpeningStock, parseSerialHistory } from './models/bootstrap.repo';
import { errorHandler } from './errors/errorHandler';
import { ApiError } from './errors/ApiError';
import { VENDOR_PAYMENT_SELECT } from './models/procurement.repo';

import { registerSyncRoutes } from './routes/sync.routes';
import { requireSseAuth } from './middleware/sseAuth';
import { sseConnectionLimit } from './middleware/sseRateLimit';
import { registerPermissionsRoutes } from './routes/permissions.routes';
import { registerBootstrapRoutes } from './routes/bootstrap.routes';
import { registerMiscRoutes } from './routes/misc.routes';
import { registerAdminRoutes } from './routes/admin.routes';
import { registerAuthRoutes } from './routes/auth.routes';
import { registerMasterdataRoutes } from './routes/masterdata.routes';
import { registerInventoryRoutes } from './routes/inventory.routes';
import { registerProcurementRoutes } from './routes/procurement.routes';
import { registerShipmentsRoutes } from './routes/shipments.routes';
import { registerReportsRoutes } from './routes/reports.routes';
import { registerLeftoverFiscalRoutes } from './routes/fiscal.routes';
import { setLogAuditEvent } from './routes/fiscal.auditAccess';
import { cacheRefreshHook } from './middleware/cacheRefreshHook';

// Extracted modules (see header comment for the full map).
export {
  companyProfile, docNumberConfigs, users, suppliers, uomList, locationRecords,
  branches, fiscalYears, products, categories, inventoryStock, assetRegister,
  customerDeviceRecords, customerMasterRecords, purchaseOrders, purchaseInvoices,
  shipments, stockOperations, auditTrail, transactionLogs, vendorPayments,
  approvalRequests, damageRecords, serialLogs, activeUser, permissionMatrix,
  setCompanyProfile, setDocNumberConfigs, setUsers, setSuppliers, setUomList,
  setLocationRecords, setBranches, setFiscalYears, setProducts, setCategories,
  setInventoryStock, setAssetRegister, setPurchaseOrders, setPurchaseInvoices,
  setShipments, setStockOperations, setAuditTrail, setTransactionLogs,
  setCustomerDeviceRecords, setCustomerMasterRecords,
  setVendorPayments, setApprovalRequests, setDamageRecords, setSerialLogs,
  setPermissionMatrix, setActiveUser, setPgConnected, getPgConnected,
  getActiveUser, getDataVersion, setDataVersion, CACHE_LOADS,
  hydrateOperationalData, refreshOperationalCache,
} from './state/runtimeState';
export { withTransaction, withConnection } from './db/transactions';
export { sseClients, broadcastChange } from './realtime/sse';
export { logAuditEvent } from './services/audit.service';
export { generateStandardTransactionId, normalizeDocTypeCode, padSequence, issueNextDocNumber } from './utils/docNumber';
export { generateNextDocNumberForServer } from './services/serverDocNumber';
export { toCalendarDate, pickCurrentFiscalYear } from './utils/fiscalYear';
export { computeTradingFromOps } from './utils/trading';
export { syncDatabaseAndIndexes } from './boot/dbBoot';
export { VALID_ROLES, validateRole, requireStockOperationPermission } from './controllers/permissions.core';
export { handleUpdateSerials, runSerialEditCapture } from './services/serialEdit.handler';
export { verifySuperAdminCredentials } from './services/superAdminAuth.service';

import { getFiscalYearCodeForDate as _getFYCode, getFiscalYearIdForDate as _getFYId } from './utils/fiscalYear';
import { fiscalYears } from './state/runtimeState';

export {
  ApiError,
  withPrepended, withAppended, withReplaced, withSorted, mutable,
  hashPassword, verifyPassword, issueAuthToken, getUserFromReq, verifyAuthToken,
  authenticateUser, requireAuth, requirePostgres, enforceFiscalYearWriteAccess,
  requireRole, enforceOperationalPermissions, enforceBranchAccess, requirePermission,
  INITIAL_COMPANY_PROFILE, INITIAL_DOCUMENT_NUMBER_CONFIGS, INITIAL_MASTER_UOM,
  INITIAL_MASTER_LOCATIONS, INITIAL_MASTER_BRANCHES, INITIAL_MASTER_FISCAL_YEARS,
  INITIAL_MASTER_SUPPLIERS, EXAMPLE_USER_PASSWORD, INITIAL_EXAMPLE_USERS,
  NEPALI_MONTHS_EN_SERVER, NEPALI_MONTHS_NP_SERVER, DAYS_OF_WEEK_EN_SERVER,
  DAYS_OF_WEEK_NP_SERVER, DEFAULT_BS_YEARS_SERVER, inMemoryBsCalendarYears,
  inMemoryBsDayRecords, setInMemoryBsCalendarYears, setInMemoryBsDayRecords,
  generateInMemoryBsDayRecords, detectDateTypeMismatch, findBsDayRecordForAdDate,
  hydrateBsCalendarFromDb, buildBsDayRecordsForYear,
  // Re-exported for server/routes/*.routes.ts (they import shared runtime
  // symbols from this module rather than from each other).
  pgPool, realPoolInstance, ensurePostgresConnection, setIsPgConnected,
  fetchFiscalYears, fetchOperationalData, fetchOpeningStock, parseSerialHistory,
  VENDOR_PAYMENT_SELECT,
};

// PORT must be a positive integer. A bare `|| '3000'` fallback is not
// enough: ambient environments can export PORT=0 (or empty/garbage), which
// parseInt happily accepts and app.listen(0) then binds an ephemeral port.
// Invalid values fall back to 3000 so the server is always reachable.
const PORT_PARSED = Number.parseInt(process.env.PORT || '3000', 10);
export const PORT = Number.isInteger(PORT_PARSED) && PORT_PARSED > 0 ? PORT_PARSED : 3000;

// Fiscal-year helpers that read the live fiscalYears cache.
export function getFiscalYearCodeForDate(dateValue: any): string {
  return _getFYCode(dateValue, fiscalYears);
}
export function getFiscalYearIdForDate(dateValue: any): string | null {
  return _getFYId(dateValue, fiscalYears);
}

// Resolves an existing supplier master row by vendor name, creating one on the
// fly for invoice-driven payments when no supplierId was supplied.
export function providerSupplierIdFromName(name: string): string | undefined {
  const clean = String(name || '').trim();
  if (!clean) return undefined;
  const matched = stateSuppliers.find((s) => s.name.toLowerCase() === clean.toLowerCase()) ||
    stateSuppliers.find((s) => s.name.toLowerCase().includes(clean.toLowerCase()));
  return matched?.id;
}
import { suppliers as stateSuppliers } from './state/runtimeState';

// Late-bound alias for route modules that must not import app.ts (import-cycle
// avoidance). fiscal.routes.ts reads the audit logger through this shim.
import { logAuditEvent } from './services/audit.service';
setLogAuditEvent(logAuditEvent);

// Compile-time conformance: every accessor must match SharedStateAccessors.
import {
  setUsers as _sUsers, setSuppliers as _sSuppliers, setUomList as _sUom,
  setLocationRecords as _sLoc, setBranches as _sBranches, setFiscalYears as _sFY,
  setProducts as _sProducts, setCategories as _sCats, setInventoryStock as _sStock,
  setAssetRegister as _sAssets, setCustomerDeviceRecords as _sCDR,
  setCustomerMasterRecords as _sCMR, setPurchaseOrders as _sPO,
  setPurchaseInvoices as _sPI, setShipments as _sShip, setStockOperations as _sOps,
  setAuditTrail as _sAudit, setTransactionLogs as _sTxn, setApprovalRequests as _sAppr,
  setDamageRecords as _sDmg, setSerialLogs as _sSerial, setVendorPayments as _sVP,
  setDocNumberConfigs as _sDocCfg, setPermissionMatrix as _sPerm,
  setCompanyProfile as _sProfile, setPgConnected as _sPg, setActiveUser as _sActive,
  getPgConnected as _gPg, getActiveUser as _gActive, getDataVersion as _gVer,
  setDataVersion as _sVer,
} from './state/runtimeState';

const sharedStateAccessors: SharedStateAccessors = {
  setUsers: _sUsers, setSuppliers: _sSuppliers, setUomList: _sUom, setLocationRecords: _sLoc,
  setBranches: _sBranches, setFiscalYears: _sFY, setProducts: _sProducts, setCategories: _sCats,
  setInventoryStock: _sStock, setAssetRegister: _sAssets, setCustomerDeviceRecords: _sCDR,
  setCustomerMasterRecords: _sCMR, setPurchaseOrders: _sPO, setPurchaseInvoices: _sPI,
  setShipments: _sShip, setStockOperations: _sOps, setAuditTrail: _sAudit,
  setTransactionLogs: _sTxn, setApprovalRequests: _sAppr, setDamageRecords: _sDmg,
  setSerialLogs: _sSerial, setVendorPayments: _sVP, setDocNumberConfigs: _sDocCfg,
  setPermissionMatrix: _sPerm, setCompanyProfile: _sProfile, setPgConnected: _sPg,
  setActiveUser: _sActive, getPgConnected: _gPg, getActiveUser: _gActive,
  getDataVersion: _gVer, setDataVersion: _sVer,
};
export { sharedStateAccessors };

// ---------------------------------------------------------------------------
// Express app factory (middleware pipeline unchanged).
// ---------------------------------------------------------------------------
export function createApp(): express.Express {
  const app = express();

  // Security headers (audit backlog #2). Helmet's defaults set CSP,
  // X-Content-Type-Options, X-Frame-Options, etc. CSP's default-src 'self'
  // is safe for the JSON API surface; the Vite-built client is served
  // separately (or via a reverse proxy). HSTS is DISABLED because this app
  // serves plain HTTP on the company's own LAN server — an HSTS header on an
  // http:// response is ignored by browsers and misleading; when TLS is
  // introduced (e.g. a reverse proxy), re-enable hsts or add the header at
  // the proxy.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'upgrade-insecure-requests': null, // allow plain-HTTP on the LAN
      },
    },
    strictTransportSecurity: false,
  }));

  // JSON body limit (audit backlog #2): honor JSON_BODY_LIMIT when set
  // (e.g. '25mb' for large PO/invoice item payloads), default 1mb —
  // express's default — otherwise. Rejects oversized bodies with 413.
  const jsonBodyLimit = process.env.JSON_BODY_LIMIT || '1mb';
  app.use(express.json({ limit: jsonBodyLimit }));

  // Health & Control Plane Endpoints FIRST before any other routes or middleware
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Global Backend Authentication Middleware for all API routes
  app.use('/api', authenticateUser);

  app.use('/api', (req, res, next) => {
    const publicRoutes = new Set([
      '/auth/setup-status',
      '/auth/setup-superadmin',
      '/auth/forgot-password',
      '/auth/login',
      '/db/status',
      '/health',
    ]);
    if (publicRoutes.has(req.path)) return next();
    // The sync routes are NOT public (audit backlog #2): they carry their own
    // SSE-capable auth that also accepts the token as a query parameter, since
    // EventSource cannot send headers. The stream additionally gets a
    // per-IP concurrent-connection cap (each open stream holds a socket, an
    // sseClients entry and a keep-alive timer).
    if (req.path === '/sync/stream') {
      return sseConnectionLimit(req, res, () => requireSseAuth(req, res, next));
    }
    if (req.path.startsWith('/sync/')) return requireSseAuth(req, res, next);
    return requireAuth(req, res, next);
  });
  app.use('/api', requirePostgres);
  app.use('/api', enforceFiscalYearWriteAccess);
  app.use('/api', enforceOperationalPermissions);
  app.use('/api', enforceBranchAccess);

  // Cache-refresh hook: on ANY successful mutating API call, re-read every
  // cache table from PostgreSQL (via CACHE_LOADS) BEFORE the response is sent.
  // (Hook implementation in ./middleware/cacheRefreshHook.)
  app.use('/api', cacheRefreshHook);

  return app;
}

export function registerAllRoutes(expressApp: express.Express) {
  registerLeftoverFiscalRoutes(expressApp);
  registerSyncRoutes(expressApp);
  registerPermissionsRoutes(expressApp);
  registerBootstrapRoutes(expressApp);
  registerMiscRoutes(expressApp);
  registerAdminRoutes(expressApp);
  registerAuthRoutes(expressApp);
  registerMasterdataRoutes(expressApp);
  registerInventoryRoutes(expressApp);
  registerProcurementRoutes(expressApp);
  registerShipmentsRoutes(expressApp);
  registerReportsRoutes(expressApp);

  // Central structured-error handler must be registered LAST so every route's
  // thrown ApiError is converted to a standard JSON response.
  expressApp.use(errorHandler);
}
