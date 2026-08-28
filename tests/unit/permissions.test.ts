import { describe, it, expect } from 'vitest';
import {
  canUserSeeAllBranches,
  getAllowedBranchIds,
  isBranchAllowedForUser,
  isOperationAllowed,
  canUserSwitchProfiles,
  canUserDisposeDamagedStock,
  DEFAULT_PERMISSIONS_MATRIX,
} from '../../src/utils/permissions';
import type { Branch, User } from '../../src/types';

const branches: Branch[] = [
  {
    id: 'WH001',
    code: 'WH001',
    name: 'HQ',
    location: 'Urlabari',
    phone: '1',
    isHeadquarters: true,
    active: true,
  },
  {
    id: 'ITH01',
    code: 'ITH01',
    name: 'Itahari',
    location: 'Itahari',
    phone: '2',
    isHeadquarters: false,
    active: true,
  },
];

function user(partial: Partial<User> & Pick<User, 'role'>): User {
  return {
    id: 'u1',
    email: 'u@test.local',
    name: 'User',
    ...partial,
  };
}

describe('permissions utils', () => {
  it('lets SUPER_ADMIN and INVENTORY_MANAGER see all branches', () => {
    expect(canUserSeeAllBranches(user({ role: 'SUPER_ADMIN' }))).toBe(true);
    expect(canUserSeeAllBranches(user({ role: 'INVENTORY_MANAGER' }))).toBe(true);
    expect(canUserSeeAllBranches(user({ role: 'BRANCH_MANAGER', branchId: 'ITH01' }))).toBe(
      false
    );
    expect(canUserSeeAllBranches(null)).toBe(false);
  });

  it('scopes branch managers to their branch / allow-list', () => {
    const bm = user({ role: 'BRANCH_MANAGER', branchId: 'ITH01' });
    expect(getAllowedBranchIds(bm, branches)).toEqual(['ITH01']);
    expect(isBranchAllowedForUser('ITH01', bm, branches)).toBe(true);
    expect(isBranchAllowedForUser('WH001', bm, branches)).toBe(false);
    expect(isBranchAllowedForUser('ALL', bm, branches)).toBe(false);

    const multi = user({
      role: 'FRONT_DESK',
      allowedBranchIds: ['WH001', 'ITH01'],
    });
    expect(getAllowedBranchIds(multi, branches).sort()).toEqual(['ITH01', 'WH001']);
  });

  it('enforces default operation matrix', () => {
    expect(isOperationAllowed('po-create', 'SUPER_ADMIN')).toBe(true);
    expect(isOperationAllowed('po-create', 'ACCOUNTANT')).toBe(false);
    expect(isOperationAllowed('inv-pay', 'ACCOUNTANT')).toBe(true);
    expect(isOperationAllowed('admin-users', 'BRANCH_MANAGER')).toBe(false);
    expect(isOperationAllowed('admin-users', 'SUPER_ADMIN')).toBe(true);
  });

  it('honors branch procurement lock even for super admin ops check', () => {
    // SUPER_ADMIN bypasses matrix but branch procurement restriction still applies
    expect(isOperationAllowed('po-create', 'SUPER_ADMIN', false)).toBe(false);
    expect(isOperationAllowed('po-create', 'INVENTORY_MANAGER', false)).toBe(false);
    expect(isOperationAllowed('po-create', 'INVENTORY_MANAGER', true)).toBe(true);
  });

  it('defaults unknown ops to allowed', () => {
    expect(isOperationAllowed('totally-unknown-op', 'FRONT_DESK')).toBe(true);
  });

  it('detects profile switch permission', () => {
    expect(
      canUserSwitchProfiles(user({ role: 'SUPER_ADMIN', canSwitchUser: true }))
    ).toBe(true);
    expect(
      canUserSwitchProfiles(user({ role: 'FRONT_DESK', canSwitchUser: false }))
    ).toBe(false);
    // explicit flag wins
    expect(
      canUserSwitchProfiles(user({ role: 'FRONT_DESK', canSwitchUser: true }))
    ).toBe(true);
  });

  it('restricts damaged stock disposal', () => {
    expect(canUserDisposeDamagedStock(user({ role: 'SUPER_ADMIN' }))).toBe(true);
    expect(canUserDisposeDamagedStock(user({ role: 'INVENTORY_MANAGER' }))).toBe(true);
    expect(canUserDisposeDamagedStock(user({ role: 'FRONT_DESK' }))).toBe(false);
    expect(canUserDisposeDamagedStock(null)).toBe(false);
  });

  it('ships a complete default matrix for known roles', () => {
    const roles = [
      'SUPER_ADMIN',
      'INVENTORY_MANAGER',
      'BRANCH_MANAGER',
      'FRONT_DESK',
      'ACCOUNTANT',
    ] as const;
    for (const op of Object.keys(DEFAULT_PERMISSIONS_MATRIX)) {
      for (const role of roles) {
        expect(typeof DEFAULT_PERMISSIONS_MATRIX[op][role]).toBe('boolean');
      }
    }
  });
});
