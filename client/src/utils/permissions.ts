export { DEFAULT_PERMISSIONS_MATRIX };
import { UserRole, User, Branch, FiscalYear } from '../types';
import { APP_ROLES, INVENTORY_OPERATIONS, DEFAULT_PERMISSIONS_MATRIX } from './permissionMatrixData';

let serverMatrixCache: Record<string, Record<string, boolean>> | null = null;

export function setServerMatrix(matrix: Record<string, Record<string, boolean>> | null): void {
  serverMatrixCache = matrix;
}

export function getServerMatrix(): Record<string, Record<string, boolean>> | null {
  return serverMatrixCache;
}

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

export const isBranchAllowedForUser = (
  branchId: string,
  user: User | null | undefined,
  branches: Branch[]
): boolean => {
  if (!user) return false;
  if (canUserSeeAllBranches(user)) return true;
  if (branchId === 'ALL') return false;
  const allowedIds = getAllowedBranchIds(user, branches);
  return allowedIds.includes(branchId);
};

export const getPermissionsMatrix = (): Record<string, Record<string, boolean>> => {
  if (serverMatrixCache) {
    return serverMatrixCache;
  }
  try {
    const stored = localStorage.getItem('inventory_permissions_matrix');
    if (stored) {
      const parsed = JSON.parse(stored);
      const merged: Record<string, Record<string, boolean>> = { ...DEFAULT_PERMISSIONS_MATRIX };
      for (const [opId, roles] of Object.entries(parsed)) {
        if (roles && typeof roles === 'object') {
          merged[opId] = {
            ...(DEFAULT_PERMISSIONS_MATRIX[opId] || {}),
            ...(roles as Record<string, boolean>),
          };
        }
      }
      return merged;
    }
  } catch (e) {
    console.error('Error reading permissions matrix from localStorage', e);
  }
  return DEFAULT_PERMISSIONS_MATRIX;
};

export const savePermissionsMatrix = (matrix: Record<string, Record<string, boolean>>): void => {
  try {
    localStorage.setItem('inventory_permissions_matrix', JSON.stringify(matrix));
    window.dispatchEvent(new Event('inventory_permissions_updated'));
  } catch (e) {
    console.error('Error saving permissions matrix', e);
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

export function isOperationAllowedForRole(
  opId: string,
  role: string,
  branchAllowProcurement?: boolean,
  branchAllowWarehouseTransfer?: boolean
): boolean {
  if (!role) return false;

  if (role === 'SUPER_ADMIN') {
    if (
      branchAllowProcurement === false &&
      (opId === 'po-create' || opId === 'po-receive' || opId === 'inv-create' || opId === 'inv-pay')
    ) {
      return false;
    }
    if (
      branchAllowWarehouseTransfer === false &&
      (opId === 'wh-restrict-transfer' || opId === 'branch-transfer-create')
    ) {
      return false;
    }
    return true;
  }

  const matrix = getPermissionsMatrix();
  const opMap = matrix[opId] || DEFAULT_PERMISSIONS_MATRIX[opId];
  if (!opMap) return false;

  const allowed = Boolean(opMap[role]);
  if (!allowed) return false;

  if (
    branchAllowProcurement === false &&
    (opId === 'po-create' || opId === 'po-receive' || opId === 'inv-create' || opId === 'inv-pay')
  ) {
    return false;
  }
  if (
    branchAllowWarehouseTransfer === false &&
    (opId === 'wh-restrict-transfer' || opId === 'branch-transfer-create')
  ) {
    return false;
  }
  return true;
}

export const APP_ROLES_EXPORT = APP_ROLES;
export const INVENTORY_OPERATIONS_EXPORT = INVENTORY_OPERATIONS;

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
