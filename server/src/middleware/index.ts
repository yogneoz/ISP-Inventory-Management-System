// API middleware chain: authentication, PostgreSQL gate, fiscal-year write
// lock, RBAC, matrix-based operation permissions, and branch access scoping.
// Extracted verbatim from app.ts (isPgConnected now read via accessors).
import { pgPool, realPoolInstance, ensurePostgresConnection, getIsPgConnected } from '../../db';
import { dbBreaker } from '../observability/dbBreaker';
import { branches, users, permissionMatrix, userPermissionOverrides, userPermissionSetGrants, fiscalYears, logAuditEvent, getPgConnected } from '../app';
import { evaluateFiscalYearWriteGate } from './fiscalWriteGate';
import { effectivePermission } from '../services/permissionOverrides.service';
import { getUserFromReq, sessionStillValid, verifyAuthToken } from './auth';
import { isRedisSharedState } from '../state/sharedStore';
import { sessionStillValidShared } from '../state/sessionVersion';
import { BRANCH_SCOPED_READ_PATHS, COLLECTION_SEGMENTS, findBranchScopedResource } from './branchScope';
export { getUserFromReq } from './auth';
export { verifyPassword } from './auth';

/**
 * Express Authentication Middleware
 * Resolves authenticated user details from headers/session and attaches to request
 */
/**
 * Express Authentication Middleware
 * Resolves authenticated user details from headers/session and attaches to request
 */
export function authenticateUser(req: any, res: any, next: any) {
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const verified = token ? verifyAuthToken(token) : null;
  if (verified && !sessionStillValid(verified, users)) {
    // Distinguish a re-authentication demand from a missing/expired token so
    // the client can say why the session ended.
    req.sessionRevoked = true;
    req.user = null;
    next();
    return;
  }
  if (!verified || !isRedisSharedState()) {
    req.user = verified;
    next();
    return;
  }
  // Shared revocation is a security decision: if Redis is unavailable we
  // cannot prove the session was not revoked on another worker, so fail closed
  // instead of accepting it on a possibly stale local cache.
  void sessionStillValidShared(verified, users)
    .then((valid) => {
      req.sessionRevoked = !valid;
      req.user = valid ? verified : null;
      next();
    })
    .catch((err: any) => {
      console.error('Shared session check failed (failing closed):', err?.message || err);
      res.status(503).json({
        message: 'Session verification is temporarily unavailable. Retry shortly.',
        code: 'SHARED_STATE_UNAVAILABLE',
      });
    });
}

function databaseUnavailable(res: any, retryAfterSec: number) {
  res.setHeader('Retry-After', String(Math.max(1, retryAfterSec)));
  return res.status(503).json({
    message: 'The database is temporarily unavailable. Retry shortly.',
    code: 'DB_UNAVAILABLE',
  });
}

/**
 * Fail-closed PostgreSQL gate (OPS-1).
 *
 * Safe requests proceed; while the breaker is open this answers immediately
 * with 503 + Retry-After and never queues on a database that is not there.
 * The probe is single-flight inside ensurePostgresConnection: a burst of
 * requests produces one SELECT 1, not one per request.
 */
export async function requirePostgres(req: any, res: any, next: any) {
  // Keep the diagnostic endpoint reachable while the database is down.
  if (req.path === '/db/status') return next();

  const flagDown = !getPgConnected() || !getIsPgConnected();
  if (flagDown || dbBreaker.isOpen()) {
    const isReconnected = await ensurePostgresConnection();
    if (!isReconnected) {
      return databaseUnavailable(res, dbBreaker.retryAfterSeconds());
    }
  }

  if (!getPgConnected() || !getIsPgConnected() || !realPoolInstance) {
    return databaseUnavailable(res, dbBreaker.retryAfterSeconds());
  }
  next();
}

/**
 * Closed-fiscal-year write gate.
 *
 * The year is derived from the DOCUMENT's own date (fiscalWriteGate), never from
 * the `x-fiscal-year-id` view header: that header was caller-supplied, so
 * omitting it skipped the check and made the IRD period lock advisory. A closed
 * year now refuses every write except a Super Admin override, which must carry
 * a written reason and is audit-logged here.
 */
export async function enforceFiscalYearWriteAccess(req: any, res: any, next: any) {
  const role = (req.user || getUserFromReq(req)).role;
  const verdict = evaluateFiscalYearWriteGate({
    method: req.method,
    path: req.path,
    body: req.body,
    role,
    fiscalYears,
  });

  if (verdict.kind === 'allow') return next();

  if (verdict.kind === 'closed') {
    return res.status(423).json({
      message: verdict.requiresReason
        ? `Fiscal year ${verdict.fiscalYearCode} is closed. Posting into it needs a Super Admin override with a written reason (at least 10 characters).`
        : `Fiscal year ${verdict.fiscalYearCode} is closed. Only a Super Admin can post an audited adjustment into it.`,
      fiscalYearClosed: true,
      requiresOverrideReason: verdict.requiresReason,
      fiscalYearCode: verdict.fiscalYearCode,
    });
  }

  // Super Admin override: record who wrote into a locked period and why before
  // the write proceeds. The audit row is best-effort — a logging failure must
  // not silently convert the operator's authorized action into a 500.
  const audit = logAuditEvent(
    req,
    'CLOSED_PERIOD_OVERRIDE',
    'FISCAL_YEAR',
    `Super Admin wrote into closed fiscal year ${verdict.fiscalYearCode} via ${req.method} ${req.path}` +
      `${verdict.dateAD ? ` (document date ${verdict.dateAD})` : ' (no document date — current year)'}: ${verdict.reason}`
  );
  if (audit && typeof (audit as any).then === 'function') {
    await (audit as any).catch(() => undefined);
  }
  return next();
}

/**
 * Authentication Enforcer Middleware
 */
export function requireAuth(req: any, res: any, next: any) {
  const user = req.user;
  if (!user || !user.email) {
    return res.status(401).json({
      message: req.sessionRevoked
        ? 'Your session is no longer valid — your account, role or password changed. Sign in again.'
        : 'Unauthorized: Authentication required to access endpoint',
      sessionRevoked: Boolean(req.sessionRevoked),
    });
  }
  // A login created from the employee directory starts on a one-time password.
  // Until the employee replaces it, only the endpoints needed to sign in, read
  // their own account and change it are reachable — no data access at all.
  if ((user as any).mustChangePassword) {
    const path = String(req.path || '');
    const allowed =
      path.endsWith('/auth/me') || path.endsWith('/auth/profile') || path.endsWith('/auth/logout');
    if (!allowed) {
      return res.status(403).json({
        message: 'Set a new password before using the application.',
        mustChangePassword: true,
      });
    }
  }
  req.user = user;
  next();
}

/**
 * Role-Based Access Control Middleware
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: any, res: any, next: any) => {
    const user = req.user || getUserFromReq(req);
    if (!user || !user.email) {
      return res.status(401).json({ message: 'Unauthorized: Authentication required' });
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role) && user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        message: `Forbidden: Access restricted. Role '${user.role}' lacks sufficient privileges for this operational action. Required role: ${allowedRoles.join(' or ')}`,
      });
    }
    req.user = user;
    next();
  };
}

export function enforceOperationalPermissions(req: any, res: any, next: any) {
  if (req.method === 'GET' || req.path.startsWith('/auth/') || req.path.startsWith('/sync/')) return next();
  const rules: Array<[string, string[]]> = [
    ['/admin/', ['SUPER_ADMIN']],
    ['/branches', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/users', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/company-profile', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/document-number-configs', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/bs-calendar/', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']],
    ['/suppliers', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER']],
    ['/products', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/categories', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/product-groups', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/uom', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/locations', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER']],
    ['/stock/', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'AUDITOR']],
    ['/assets', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT']],
    ['/purchase-invoices', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'ACCOUNTANT', 'PROCUREMENT_OFFICER']],
    ['/vendor-payments', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'ACCOUNTANT', 'PROCUREMENT_OFFICER']],
    ['/vendors/', ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'ACCOUNTANT', 'PROCUREMENT_OFFICER']],
  ];
  const rule = rules.find(([prefix]) => req.path === prefix.slice(0, -1) || req.path.startsWith(prefix));
  if (rule && !rule[1].includes(req.user?.role)) {
    return res.status(403).json({ message: `Forbidden: role '${req.user?.role || 'unknown'}' cannot perform this operation.` });
  }
  next();
}

export async function enforceBranchAccess(req: any, res: any, next: any) {
  const user = req.user;
  if (!user || user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN') return next();
  // A signed `branchId` of 'ALL' is the HQ-wide account shape the shipment
  // handlers already recognise (shipments.controller.ts). It is bound by the
  // operation matrix, not by one branch, so the per-branch checks below would
  // deny it the scope it exists to have.
  if (user.branchId === 'ALL') return next();
  if (req.path === '/bootstrap') {
    const requestedBootstrapBranch = req.query?.branchId;
    // The primary branch plus every explicitly assigned branch. A multi-branch
    // user must be able to bootstrap the branch they switch the header to;
    // ALL stays reserved for global accounts (checked above).
    const bootstrapBranches = new Set(
      [user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean)
    );
    if (
      typeof requestedBootstrapBranch !== 'string' ||
      requestedBootstrapBranch === 'ALL' ||
      !bootstrapBranches.has(requestedBootstrapBranch)
    ) {
      return res.status(403).json({ message: 'Forbidden: bootstrap must be scoped to the authenticated user branch.' });
    }
  }
  const scopedRead = BRANCH_SCOPED_READ_PATHS.find((path) => req.path === path || req.path.startsWith(`${path}/`));
  if (req.method === 'GET' && scopedRead) {
    // The filter requirement is a COLLECTION rule (a list with no branchId
    // would read every branch). A one-record path is scoped by the id check
    // below instead, and its query branch only narrows the record's lines: the
    // customer ledger deliberately defaults to ALL for a customer's history,
    // so demanding a filter here would 403 the ledger screen for branch users.
    const firstSegment = req.path.slice(scopedRead.length + 1).split('/')[0] || '';
    const isCollectionPath = !firstSegment || COLLECTION_SEGMENTS.has(firstSegment);
    if (isCollectionPath && req.query?.branchId !== user.branchId && !(user.allowedBranchIds || []).includes(req.query?.branchId)) {
      return res.status(403).json({ message: 'Forbidden: branch-scoped reads require an authorized branch filter.' });
    }
  }
  const requested = new Set<string>();
  for (const value of [req.query?.branchId, req.body?.branchId, req.body?.sourceBranchId, req.body?.destinationBranchId]) {
    if (typeof value === 'string' && value && value !== 'ALL') requested.add(value);
  }
  const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])]);
  if ([...requested].some((branchId) => !allowed.has(branchId))) {
    return res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
  }
  if (requested.size === 0 && (req.query?.branchId === 'ALL' || req.body?.branchId === 'ALL')) {
    return res.status(403).json({ message: 'Forbidden: branch users cannot access all branches.' });
  }
  if (getPgConnected()) {
    // The table list, its branch columns and the id predicate live in the
    // declarative registry (./branchScope) so the schema test can prove that a
    // new branch-scoped table is either guarded here or explicitly exempted.
    // The id is parsed from the path, not read from req.params: this runs in
    // an app-level `app.use('/api', …)`, and Express 4 resets req.params for
    // middleware layers (a probe against the installed version returns {}).
    // The old `req.params?.id` check never ran for any table, so every
    // by-id branch rule below was dead code; the shipment authz suite had
    // recorded the symptom (VERIFY-001) without this fix.
    const resource = findBranchScopedResource(req.path);
    if (resource) {
      const { prefix, table, columns, idLookup } = resource;
      const resourceId = decodeURIComponent(req.path.slice(prefix.length + 1).split('/')[0] || '');
      if (resourceId && !COLLECTION_SEGMENTS.has(resourceId)) {
        const lookup = idLookup || 'id = $1';
        const result = await pgPool.query(`SELECT ${columns.join(', ')} FROM ${table} WHERE ${lookup} LIMIT 1`, [resourceId]);
        const row = result.rows[0];
        if (row && !columns.some((column) => allowed.has(row[column]))) {
          return res.status(403).json({ message: 'Forbidden: this record belongs to another branch.' });
        }
      }
    }
  }
  next();
}

/**
 * Matrix-based operation permission middleware accepting ANY of the listed
 * operations (OR semantics). Checks the user's role against the server-side
 * permission matrix, then enforces branch-level procurement/warehouse-transfer
 * flags. SUPER_ADMIN bypasses the matrix but is still bound by branch flags.
 */
export function requirePermissionAny(...operationIds: string[]) {
  return async (req: any, res: any, next: any) => {
    const user = req.user || getUserFromReq(req);
    if (!user || !user.email) {
      return res.status(401).json({ message: 'Unauthorized: Authentication required' });
    }
    const role = user.role;

    // Branch-level procurement/warehouse-transfer restriction. Evaluate both
    // the source and destination branches so a shipment/transfer dispatched
    // FROM a restricted branch is blocked even if the destination is open.
    const branchId = req.body?.branchId || req.body?.destinationBranchId || '';
    const sourceBranchId = req.body?.sourceBranchId || '';
    const relevantBranchIds = Array.from(new Set([branchId, sourceBranchId].filter(Boolean)));
    const restrictedBranches = relevantBranchIds.map((id) => branches.find((b) => b.id === id)).filter(Boolean) as Array<typeof branches[number]>;
    const allowProcurement = restrictedBranches.every((branch) => branch.allowProcurement !== false);
    const allowWarehouseTransfer = restrictedBranches.every((branch) => branch.allowWarehouseTransfer !== false);    const procurementOps = ['po-create', 'po-receive', 'inv-create', 'inv-pay'];
    const warehouseTransferOps = ['wh-restrict-transfer', 'branch-transfer-create'];
    const touchesProcurement = operationIds.some((id) => procurementOps.includes(id));
    const touchesWarehouseTransfer = operationIds.some((id) => warehouseTransferOps.includes(id));

    if (role === 'SUPER_ADMIN') {
      if (allowProcurement === false && touchesProcurement) {
        return res.status(403).json({ message: `Forbidden: procurement is disabled on branch '${branchId}'.` });
      }
      if (allowWarehouseTransfer === false && touchesWarehouseTransfer) {
        return res.status(403).json({ message: `Forbidden: warehouse transfer is restricted on branch '${branchId}'.` });
      }
      return next();
    }

    // One resolver for the role matrix AND the per-user exception layer. A
    // grant can open an operation the role lacks; a deny closes one it has.
    // Checking `permissionMatrix[operationId][role]` directly here would
    // silently ignore overrides for every gated route.
    const allowedByMatrix = operationIds.some((operationId) =>
      effectivePermission(user, operationId, permissionMatrix, userPermissionOverrides, userPermissionSetGrants)
    );
    if (!allowedByMatrix) {
      return res.status(403).json({
        message: `Forbidden: role '${role}' is not permitted for operation '${operationIds.join("' or '")}'.`,
      });
    }

    if (allowProcurement === false && touchesProcurement) {
      return res.status(403).json({ message: `Forbidden: procurement is disabled on branch '${branchId}'.` });
    }
    if (allowWarehouseTransfer === false && touchesWarehouseTransfer) {
      return res.status(403).json({ message: `Forbidden: warehouse transfer is restricted on branch '${branchId}'.` });
    }

    req.user = user;
    next();
  };
}

/** Single-operation convenience wrapper over requirePermissionAny. */
export function requirePermission(operationId: string) {
  return requirePermissionAny(operationId);
}
