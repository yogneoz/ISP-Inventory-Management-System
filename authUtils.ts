/**
 * Server-side auth helpers: password hashing, session tokens, BS date stamps.
 * Kept outside src/ so the Express bundle can import it cleanly.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const MIN_PASSWORD_LENGTH = 8;

export { MIN_PASSWORD_LENGTH };

export interface SessionRecord {
  token: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  branchId?: string;
  allowedBranchIds?: string[];
  canSwitchUser?: boolean;
  createdAt: number;
  expiresAt: number;
  rootUserId?: string; // original user when profile-switched
}

const sessions = new Map<string, SessionRecord>();

/** Built-in BS year anchors (Baisakh 1 AD) for live date conversion on the server. */
const BS_YEAR_ANCHORS: { yearBS: number; startAD: string; daysInMonths: number[] }[] = [
  { yearBS: 2078, startAD: '2021-04-14', daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30] },
  { yearBS: 2079, startAD: '2022-04-14', daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  { yearBS: 2080, startAD: '2023-04-14', daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30] },
  { yearBS: 2081, startAD: '2024-04-13', daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  { yearBS: 2082, startAD: '2025-04-14', daysInMonths: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30] },
  { yearBS: 2083, startAD: '2026-04-14', daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  { yearBS: 2084, startAD: '2027-04-14', daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
  { yearBS: 2085, startAD: '2028-04-13', daysInMonths: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30] },
];

export function isBcryptHash(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string') return false;
  return /^\$2[aby]?\$\d{2}\$/.test(value);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, stored: string | undefined | null): Promise<boolean> {
  if (!plain || !stored) return false;
  if (isBcryptHash(stored)) {
    try {
      return await bcrypt.compare(plain, stored);
    } catch {
      return false;
    }
  }
  // Legacy plaintext fallback (one-time migration path)
  return plain === stored;
}

export function validatePasswordStrength(password: string): { ok: boolean; message?: string } {
  if (!password || password.trim().length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    };
  }
  return { ok: true };
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function createSession(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  branchId?: string;
  allowedBranchIds?: string[];
  canSwitchUser?: boolean;
}, rootUserId?: string): SessionRecord {
  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const record: SessionRecord = {
    token,
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    branchId: user.branchId,
    allowedBranchIds: user.allowedBranchIds,
    canSwitchUser: user.canSwitchUser,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    rootUserId: rootUserId || user.id,
  };
  sessions.set(token, record);
  return record;
}

export function getSession(token: string | undefined | null): SessionRecord | null {
  if (!token) return null;
  pruneExpiredSessions();
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  // Sliding expiry on activity
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

export function destroySession(token: string | undefined | null): void {
  if (!token) return;
  sessions.delete(token);
}

export function destroyUserSessions(userId: string): void {
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId || session.rootUserId === userId) {
      sessions.delete(token);
    }
  }
}

export function extractBearerToken(req: { headers?: Record<string, any> }): string | null {
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const headerToken = req.headers?.['x-session-token'] || req.headers?.['x-auth-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();
  return null;
}

/**
 * Convert an AD date (Date or ISO string) to a BS stamp like "2083-04-16 BS".
 */
export function toBsDateStamp(adInput?: string | Date | null): string {
  try {
    const adDate =
      adInput instanceof Date
        ? adInput
        : new Date((adInput || new Date().toISOString()).split('T')[0]);
    if (isNaN(adDate.getTime())) {
      return fallbackBsEstimate(new Date());
    }

    const targetUtc = Date.UTC(adDate.getUTCFullYear(), adDate.getUTCMonth(), adDate.getUTCDate());

    let selected = BS_YEAR_ANCHORS[0];
    for (const anchor of BS_YEAR_ANCHORS) {
      const start = new Date(anchor.startAD + 'T00:00:00Z').getTime();
      if (targetUtc >= start) selected = anchor;
      else break;
    }

    const startMs = new Date(selected.startAD + 'T00:00:00Z').getTime();
    let dayOffset = Math.floor((targetUtc - startMs) / 86400000);
    if (dayOffset < 0) return fallbackBsEstimate(adDate);

    let monthBS = 1;
    for (let i = 0; i < 12; i++) {
      const dim = selected.daysInMonths[i] || 30;
      if (dayOffset < dim) {
        monthBS = i + 1;
        const dayBS = dayOffset + 1;
        const mm = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
        const dd = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
        return `${selected.yearBS}-${mm}-${dd} BS`;
      }
      dayOffset -= dim;
    }

    // Overflow into next year estimate
    return fallbackBsEstimate(adDate);
  } catch {
    return fallbackBsEstimate(new Date());
  }
}

function fallbackBsEstimate(adDate: Date): string {
  const y = adDate.getUTCFullYear() + 57;
  const m = adDate.getUTCMonth() + 1;
  const d = adDate.getUTCDate();
  const mm = m < 10 ? `0${m}` : `${m}`;
  const dd = d < 10 ? `0${d}` : `${d}`;
  return `${y}-${mm}-${dd} BS`;
}

export function getTodayBsStamp(): string {
  return toBsDateStamp(new Date());
}

/** Canonical application roles (aligned with frontend UserRole). */
export const APP_ROLES = [
  'SUPER_ADMIN',
  'INVENTORY_MANAGER',
  'BRANCH_MANAGER',
  'FRONT_DESK',
  'ACCOUNTANT',
] as const;

export type AppRole = (typeof APP_ROLES)[number];

/**
 * Map legacy / alias role names used in older server guards onto canonical roles.
 */
export function normalizeRole(role: string | undefined | null): string {
  if (!role) return 'FRONT_DESK';
  const r = String(role).trim().toUpperCase();
  const aliases: Record<string, string> = {
    HEAD_OFFICE_ADMIN: 'SUPER_ADMIN',
    HEAD_OFFICE: 'SUPER_ADMIN',
    ADMIN: 'SUPER_ADMIN',
    STOCK_MANAGER: 'INVENTORY_MANAGER',
    PROCUREMENT_OFFICER: 'INVENTORY_MANAGER',
    PROCUREMENT: 'INVENTORY_MANAGER',
    AUDITOR: 'ACCOUNTANT',
    FIELD_TECHNICIAN: 'FRONT_DESK',
    TECHNICIAN: 'FRONT_DESK',
  };
  if (aliases[r]) return aliases[r];
  if ((APP_ROLES as readonly string[]).includes(r)) return r;
  return r;
}

export function rolesMatch(userRole: string, allowed: string[]): boolean {
  const normalizedUser = normalizeRole(userRole);
  if (normalizedUser === 'SUPER_ADMIN') return true;
  const normalizedAllowed = allowed.map(normalizeRole);
  return normalizedAllowed.includes(normalizedUser);
}
