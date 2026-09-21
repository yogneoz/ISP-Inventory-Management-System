// API middleware chain: authentication, PostgreSQL gate, fiscal-year write
// lock, RBAC, matrix-based operation permissions, and branch access scoping.
// Extracted verbatim from app.ts (isPgConnected now read via accessors).
import { pgPool, realPoolInstance, ensurePostgresConnection, getIsPgConnected, setIsPgConnected } from '../../db';
import { branches, permissionMatrix, getPgConnected, setPgConnected } from '../app';
import { getUserFromReq, verifyAuthToken } from './auth';

/**
 * Express Authentication Middleware
 * Resolves authenticated user details from headers/session and attaches to request
 */
export function authenticateUser(req: any, _res: any, next: any) {
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  req.user = token ? verifyAuthToken(token) : null;
  next();
}

export async function requirePostgres(req: any, res: any, next: any) {
  // Keep the diagnostic endpoint reachable while the database is down.
  if (req.path === '/db/status') return next();

  if (!getPgConnected() || !getIsPgConnected()) {
    const isReconnected = await ensurePostgresConnection();
    setPgConnected(isReconnected);
    setIsPgConnected(isReconnected);
  }

  if (!getPgConnected() || !getIsPgConnected() || !realPoolInstance) {
    return res.status(503).json({
      message: 'PostgreSQL is unavailable. Start the database and verify the connection settings before using the application.',
    });
  }
  next();
}

/**
 * Fiscal year chosen in the UI is a view context. Mutations against a closed
 * context are restricted to the two roles permitted to make audited changes.
 */
export async function enforceFiscalYearWriteAccess(req: any, res: any, next: any) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.path.startsWith('/auth/') || req.path.startsWith('/fiscal-years/') || req.path.startsWith('/sync/')) return next();

  const fiscalYearId = typeof req.headers['x-fiscal-year-id'] === 'string' ? req.headers['x-fiscal-year-id'] : '';
  if (!fiscalYearId) return next();

  try {
    const result = await pgPool.query('SELECT is_closed AS "isClosed" FROM fiscal_years WHERE id = $1;', [fiscalYearId]);
    const fiscalYear = result.rows[0];
    if (!fiscalYear?.isClosed) return next();

    const role = (req.user || getUserFromReq(req)).role;
    if (role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER') return next();
    return res.status(423).json({
      message: 'This fiscal year is closed. Only Super Admin or Inventory Manager can make an audited adjustment.',
    });
  } catch (error: any) {
    return res.status(503).json({ message: `Unable to verify fiscal-year access: ${error.message}` });
  }
}

/**
 * Authentication Enforcer Middleware
 */
export function requireAuth(req: any, res: any, next: any) {
  const user = req.user;
  if (!user || !user.email) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required to access endpoint' });
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
  if (req.path === '/bootstrap') {
    const requestedBootstrapBranch = req.query?.branchId;
    if (typeof requestedBootstrapBranch !== 'string' || requestedBootstrapBranch === 'ALL' || requestedBootstrapBranch !== user.branchId) {
      return res.status(403).json({ message: 'Forbidden: bootstrap must be scoped to the authenticated user branch.' });
    }
  }
  const branchScopedReadPaths = ['/stock', '/assets', '/purchase-orders', '/purchase-invoices', '/vendor-payments', '/shipments', '/stock-operations', '/customer-devices', '/customers', '/approval-requests', '/locations'];
  if (req.method === 'GET' && branchScopedReadPaths.some((path) => req.path === path || req.path.startsWith(`${path}/`))) {
    if (req.query?.branchId !== user.branchId && !(user.allowedBranchIds || []).includes(req.query?.branchId)) {
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
  if (getPgConnected() && req.params?.id) {
    const resourceTables: Array<[string, string, string[]]> = [
      ['/stock', 'inventory_stock', ['branch_id']],
      ['/assets', 'fixed_assets', ['branch_id']],
      ['/purchase-orders', 'purchase_orders', ['branch_id']],
      ['/purchase-invoices', 'purchase_invoices', ['branch_id']],
      ['/vendor-payments', 'vendor_payments', ['branch_id']],
      ['/shipments', 'shipments', ['source_branch_id', 'destination_branch_id']],
      ['/stock-operations', 'stock_operations', ['branch_id', 'destination_warehouse_id']],
      ['/customer-devices', 'customer_device_records', ['branch_id']],
      ['/serial-log', 'serial_log', ['branch_id']],
      ['/customers', 'customer_records', ['branch_id']],
      ['/approval-requests', 'approval_requests', ['branch_id']],
      ['/locations', 'locations', ['branch_id']],
    ];
    const resource = resourceTables.find(([prefix]) => req.path === `${prefix}/${req.params.id}` || req.path.startsWith(`${prefix}/${req.params.id}/`));
    if (resource) {
      const columns = resource[2].join(', ');
      const lookup = resource[1] === 'shipments' ? 'id = $1 OR tracking_code = $1' : 'id = $1';
      const result = await pgPool.query(`SELECT ${columns} FROM ${resource[1]} WHERE ${lookup} LIMIT 1`, [req.params.id]);
      const row = result.rows[0];
      if (row && !resource[2].some((column) => allowed.has(row[column]))) {
        return res.status(403).json({ message: 'Forbidden: this record belongs to another branch.' });
      }
    }
  }
  next();
}

/**
 * Matrix-based operation permission middleware.
 * Checks the user's role against the server-side permission matrix,
 * then enforces branch-level procurement/warehouse-transfer flags.
 * SUPER_ADMIN bypasses the matrix but is still bound by branch flags.
 */
export function requirePermission(operationId: string) {
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
    const allowWarehouseTransfer = restrictedBranches.every((branch) => branch.allowWarehouseTransfer !== false);

    if (role === 'SUPER_ADMIN') {
      if (
        allowProcurement === false &&
        (operationId === 'po-create' || operationId === 'po-receive' || operationId === 'inv-create' || operationId === 'inv-pay')
      ) {
        return res.status(403).json({ message: `Forbidden: procurement is disabled on branch '${branchId}'.` });
      }
      if (
        allowWarehouseTransfer === false &&
        (operationId === 'wh-restrict-transfer' || operationId === 'branch-transfer-create')
      ) {
        return res.status(403).json({ message: `Forbidden: warehouse transfer is restricted on branch '${branchId}'.` });
      }
      return next();
    }

    const opRow = permissionMatrix[operationId];
    if (!opRow || !opRow[role]) {
      return res.status(403).json({
        message: `Forbidden: role '${role}' is not permitted for operation '${operationId}'.`,
      });
    }

    if (allowProcurement === false && (operationId === 'po-create' || operationId === 'po-receive' || operationId === 'inv-create' || operationId === 'inv-pay')) {
      return res.status(403).json({ message: `Forbidden: procurement is disabled on branch '${branchId}'.` });
    }
    if (allowWarehouseTransfer === false && (operationId === 'wh-restrict-transfer' || operationId === 'branch-transfer-create')) {
      return res.status(403).json({ message: `Forbidden: warehouse transfer is restricted on branch '${branchId}'.` });
    }

    req.user = user;
    next();
  };
}
