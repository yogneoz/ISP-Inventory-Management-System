import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  isBcryptHash,
  validatePasswordStrength,
  extractBearerToken,
  normalizeRole,
  rolesMatch,
  toBsDateStamp,
  getTodayBsStamp,
  MIN_PASSWORD_LENGTH,
} from '../../server/lib/authUtils';

describe('authUtils', () => {
  describe('password hashing', () => {
    it('hashes passwords with bcrypt and verifies them', async () => {
      const plain = 'SecurePass@123';
      const hash = await hashPassword(plain);
      expect(isBcryptHash(hash)).toBe(true);
      expect(hash).not.toContain(plain);
      expect(await verifyPassword(plain, hash)).toBe(true);
      expect(await verifyPassword('wrong-password', hash)).toBe(false);
    });

    it('still verifies legacy plaintext during migration path', async () => {
      expect(await verifyPassword('legacy', 'legacy')).toBe(true);
      expect(await verifyPassword('legacy', 'nope')).toBe(false);
      expect(isBcryptHash('legacy')).toBe(false);
    });
  });

  describe('validatePasswordStrength', () => {
    it(`rejects passwords shorter than ${MIN_PASSWORD_LENGTH}`, () => {
      const r = validatePasswordStrength('short');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/at least/i);
    });

    it('accepts sufficiently long passwords', () => {
      expect(validatePasswordStrength('longenough').ok).toBe(true);
      expect(validatePasswordStrength('12345678').ok).toBe(true);
    });
  });

  describe('extractBearerToken', () => {
    it('reads Authorization Bearer tokens', () => {
      expect(
        extractBearerToken({ headers: { authorization: 'Bearer abcdef123' } })
      ).toBe('abcdef123');
      expect(
        extractBearerToken({ headers: { Authorization: 'bearer XYZ' } })
      ).toBe('XYZ');
    });

    it('falls back to x-session-token / x-auth-token', () => {
      expect(
        extractBearerToken({ headers: { 'x-session-token': 'sess-1' } })
      ).toBe('sess-1');
      expect(
        extractBearerToken({ headers: { 'x-auth-token': 'auth-1' } })
      ).toBe('auth-1');
    });

    it('returns null when missing', () => {
      expect(extractBearerToken({ headers: {} })).toBeNull();
      expect(extractBearerToken({})).toBeNull();
    });
  });

  describe('normalizeRole / rolesMatch', () => {
    it('maps legacy aliases onto canonical roles', () => {
      expect(normalizeRole('HEAD_OFFICE_ADMIN')).toBe('SUPER_ADMIN');
      expect(normalizeRole('PROCUREMENT_OFFICER')).toBe('INVENTORY_MANAGER');
      expect(normalizeRole('AUDITOR')).toBe('ACCOUNTANT');
      expect(normalizeRole('FIELD_TECHNICIAN')).toBe('FRONT_DESK');
      expect(normalizeRole('branch_manager')).toBe('BRANCH_MANAGER');
    });

    it('defaults unknown empty roles to FRONT_DESK', () => {
      expect(normalizeRole(null)).toBe('FRONT_DESK');
      expect(normalizeRole('')).toBe('FRONT_DESK');
    });

    it('lets SUPER_ADMIN match any allowed list', () => {
      expect(rolesMatch('SUPER_ADMIN', ['ACCOUNTANT'])).toBe(true);
      expect(rolesMatch('HEAD_OFFICE_ADMIN', ['BRANCH_MANAGER'])).toBe(true);
    });

    it('matches canonical and aliased roles correctly', () => {
      expect(rolesMatch('INVENTORY_MANAGER', ['PROCUREMENT_OFFICER'])).toBe(true);
      expect(rolesMatch('FRONT_DESK', ['INVENTORY_MANAGER'])).toBe(false);
      expect(rolesMatch('ACCOUNTANT', ['AUDITOR', 'ACCOUNTANT'])).toBe(true);
    });
  });

  describe('BS date stamps', () => {
    it('converts a known AD date inside the mapped calendar range', () => {
      // 2026-04-14 is Baisakh 1 2083 in the built-in anchors
      const stamp = toBsDateStamp('2026-04-14');
      expect(stamp).toMatch(/^2083-01-01 BS$/);
    });

    it('returns a stamped string for today', () => {
      const today = getTodayBsStamp();
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2} BS$/);
    });
  });
});
