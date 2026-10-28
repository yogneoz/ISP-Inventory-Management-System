export { DEFAULT_PERMISSIONS_MATRIX };
import { UserRole, User, Branch, FiscalYear } from '../types';
import { DEFAULT_PERMISSIONS_MATRIX } from './permissionMatrixData';

// In-memory copy of the server's permission matrix. Filled ONLY by
// applyServerMatrix() (bootstrap payload or a confirmed PUT /api/permissions) —
// there is deliberately no setter and no browser-storage fallback.
let serverMatrixCache: Record<string, Record<string, boolean>> | null = null;

export const CAN_SEE_ALL_BRANCHES_ROLES = new Set([
  'SUPER_ADMIN',
  'INVENTORY_MANAGER',
  'HEAD_OFFICE_ADMIN',
]);

export const canUserSeeAllBranches = (user: User | null | undefined): boolean => {
  if (!user) return false;
  return CAN_SEE_ALL_BRANCHES_ROLES.has(user.role);
};

export const getAllowedBranchIds = (user: User | null | undefined, branches: Branch[]): string[] => {
  if (!user) return [];
  if (canUserSeeAllBranches(user)) {
    return branches.map((b) => b.id);
  }
  if (user.allowedBranchIds && user.allowedBranchIds.length > 0) {
    return user.allowedBranchIds;
  }
  if (user.branchId && user.branchId !== 'ALL') {
    return [user.branchId];
  }
  return branches.length > 0 ? [branches[0].id] : [];
};

export const getAllowedBranches = (user: User | null | undefined, branches: Branch[]): Branch[] => {
  if (!user) return [];
  if (canUserSeeAllBranches(user)) {
    return branches;
  }
  const allowedIds = getAllowedBranchIds(user, branches);
  return branches.filter((b) => allowedIds.includes(b.id));
};

/**
 * Branches a screen may OFFER for selection, mirroring the server's branch
 * contract (`allowedBranchScope` in server/src/middleware/branchScope.ts):
 * Super Admin, Head Office Admin and a signed `branchId` of 'ALL' are global;
 * every other account is limited to its own branch plus its explicitly allowed
 * ones.
 *
 * Deliberately stricter than canUserSeeAllBranches, which treats every
 * INVENTORY_MANAGER as global for display: the server only treats one as global
 * when the signed branch is 'ALL'. Offering the extra branches would present
 * options whose submissions the server refuses.
 */
export const getScopedBranches = (user: User | null | undefined, branches: Branch[]): Branch[] => {
  if (!user) return [];
  if (user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN' || user.branchId === 'ALL') {
    return branches;
  }
  const ids = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
  return branches.filter((b) => ids.has(b.id));
};

/**
 * The permission matrix is SERVER DATA (permission_matrix table, served by
 * GET /api/bootstrap and GET/PUT /api/permissions) and is never read from or
 * written to browser storage: a localStorage copy could be edited by anyone
 * with devtools and would silently disappear — or worse, resurface stale —
 * when browser history/cookies are cleared.
 *
 * Before bootstrap lands, `serverMatrixCache` is null and the compiled
 * defaults are used for that first paint; every authoritative read after
 * bootstrap comes from the server.
 */
export const getPermissionsMatrix = (): Record<string, Record<string, boolean>> => {
  if (serverMatrixCache && Object.keys(serverMatrixCache).length > 0) {
    return serverMatrixCache;
  }
  return DEFAULT_PERMISSIONS_MATRIX;
};

/**
 * Applies a matrix the server has confirmed (bootstrap payload or a
 * successful PUT /api/permissions) and notifies the app so every
 * `isOperationAllowed` consumer re-evaluates.
 */
export const applyServerMatrix = (matrix: Record<string, Record<string, boolean>>): void => {
  serverMatrixCache = matrix;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('inventory_permissions_updated'));
  }
};

export const isOperationAllowed = (
  opId: string,
  userRole?: UserRole | string | null,
  allowBranchProcurement?: boolean,
  allowWarehouseTransfer?: boolean
): boolean => {
  if (!userRole) return false;

  if (
    allowBranchProcurement === false &&
    (opId === 'po-create' || opId === 'po-receive' || opId === 'inv-create' || opId === 'inv-pay')
  ) {
    return false;
  }

  if (allowWarehouseTransfer === false && (opId === 'wh-restrict-transfer' || opId === 'branch-transfer-create')) {
    return false;
  }

  if (userRole === 'SUPER_ADMIN') {
    return true;
  }

  const matrix = getPermissionsMatrix();
  const opMap = matrix[opId] || DEFAULT_PERMISSIONS_MATRIX[opId];
  if (!opMap) return false;

  return Boolean(opMap[userRole as string]);
};

export const canUserSwitchProfiles = (
  user: User | null | undefined,
  rootUser: User | null | undefined = null
): boolean => {
  const effectiveUser = rootUser || user;
  if (!effectiveUser) return false;
  if (effectiveUser.canSwitchUser !== undefined) {
    return Boolean(effectiveUser.canSwitchUser);
  }
  return isOperationAllowed('auth-switch-user', effectiveUser.role);
};

export const canUserDisposeDamagedStock = (user: User | null | undefined): boolean => {
  if (!user) return false;
  return isOperationAllowed('stock-disposal-writeoff', user.role);
};

export function filterFiscalYears(fiscalYears: FiscalYear[]): FiscalYear[] {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  return fiscalYears.filter((fy) => {
    if (fy.isClosed) return true;
    if (fy.isCurrent) return true;
    if (fy.startDateAD && fy.endDateAD) {
      return todayStr >= fy.startDateAD && todayStr <= fy.endDateAD;
    }
    return false;
  });
}
