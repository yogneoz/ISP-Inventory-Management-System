import { UserRole, User, Branch } from '../types';

/**
 * Super admin and Stock Manager (INVENTORY_MANAGER) can see ALL branches.
 */
export const canUserSeeAllBranches = (user: User | null | undefined): boolean => {
  if (!user) return false;
  const role = user.role;
  return role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER';
};

/**
 * Returns array of branch IDs that the user is allowed to access.
 */
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

/**
 * Filters branches list to only those allowed for the user.
 */
export const getAllowedBranches = (user: User | null | undefined, branches: Branch[]): Branch[] => {
  if (!user) return [];
  if (canUserSeeAllBranches(user)) {
    return branches;
  }
  const allowedIds = getAllowedBranchIds(user, branches);
  return branches.filter((b) => allowedIds.includes(b.id));
};

/**
 * Checks if a specific branch ID is allowed for the user.
 */
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

export const DEFAULT_PERMISSIONS_MATRIX: Record<string, Record<UserRole, boolean>> = {
  // Procurement
  'po-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false },
  'po-receive': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false },
  'branch-procurement-control': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'inv-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true },
  'inv-pay': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true },

  // Warehouse
  'shipment-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false },
  'wh-receive-pullouts': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false },
  'wh-restrict-transfer': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'shipment-history': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true },

  // Branch operations
  'branch-transfer-create': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false },
  'branch-transfer-receive': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false },
  'branch-transfer-cancel-receive': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'branch-transfer-request-cancel': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'branch-pullout-dispatch': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false },
  'branch-damage-mark': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'stock-disposal-writeoff': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'branch-asset-assign': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true },
  'stock-out': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: false },

  // Inventory master
  'prod-view': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true },
  'prod-edit': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'uom-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'category-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'stock-import-export': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },

  // Financials & Assets
  'assets-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true },
  'fin-statements': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true },
  'vat-register': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true },
  'stock-valuation': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true },

  // Contacts
  'suppliers-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: false, ACCOUNTANT: true },
  'customers-manage': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: true, FRONT_DESK: true, ACCOUNTANT: true },

  // Admin & Approvals
  'auth-switch-user': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'workflow-approval': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'workflow-approval-cancel': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'admin-users': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'admin-branches': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: false },
  'admin-audit': { SUPER_ADMIN: true, INVENTORY_MANAGER: true, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true },
  'admin-fiscal': { SUPER_ADMIN: true, INVENTORY_MANAGER: false, BRANCH_MANAGER: false, FRONT_DESK: false, ACCOUNTANT: true },
};

export const getPermissionsMatrix = (): Record<string, Record<UserRole, boolean>> => {
  try {
    const stored = localStorage.getItem('izone_permissions_matrix');
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.error('Error reading permissions matrix from localStorage', e);
  }
  return DEFAULT_PERMISSIONS_MATRIX;
};

export const savePermissionsMatrix = (matrix: Record<string, Record<UserRole, boolean>>) => {
  try {
    localStorage.setItem('izone_permissions_matrix', JSON.stringify(matrix));
    // Dispatch custom event for real-time app update
    window.dispatchEvent(new Event('izone_permissions_updated'));
  } catch (e) {
    console.error('Error saving permissions matrix', e);
  }
};

export const isOperationAllowed = (
  opId: string,
  userRole?: UserRole | string | null,
  allowBranchProcurement?: boolean
): boolean => {
  if (!userRole) return false;

  // Check branch-level procurement restriction for procurement operations
  if (
    allowBranchProcurement === false &&
    (opId === 'po-create' || opId === 'po-receive' || opId === 'inv-create' || opId === 'inv-pay')
  ) {
    return false;
  }

  const roleKey = userRole as UserRole;

  // Super admin bypasses matrix EXCEPT for branch procurement restriction above
  if (roleKey === 'SUPER_ADMIN') {
    return true;
  }

  const matrix = getPermissionsMatrix();
  const opMap = matrix[opId];
  if (!opMap) return true; // Default allowed if not in matrix

  return opMap[roleKey] !== false;
};

/**
 * Checks if a user or the root user who initiated the session has switch user permission.
 */
export const canUserSwitchProfiles = (
  user: User | null | undefined,
  rootUser: User | null | undefined = null
): boolean => {
  // Check effective user (root user takes precedence if in a switched session)
  const effectiveUser = rootUser || user;
  if (!effectiveUser) return false;

  // Explicit flag on user profile takes top precedence
  if (effectiveUser.canSwitchUser !== undefined) {
    return Boolean(effectiveUser.canSwitchUser);
  }

  // Fallback to role-based permission
  return isOperationAllowed('auth-switch-user', effectiveUser.role);
};

/**
 * Checks if user is permitted to perform damaged stock disposal & financial write-off.
 * Only Super Admin and Inventory Manager can execute write-offs.
 */
export const canUserDisposeDamagedStock = (user: User | null | undefined): boolean => {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN' || user.role === 'INVENTORY_MANAGER') return true;
  return isOperationAllowed('stock-disposal-writeoff', user.role);
};

