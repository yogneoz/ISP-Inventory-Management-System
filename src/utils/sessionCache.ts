// Session & User State Caching Engine for Enterprise Single Page Application
import { BootstrapState, User } from '../types';

const LOGGED_USER_STORAGE_KEY = 'izone_auth_user';
const ROOT_USER_STORAGE_KEY = 'izone_root_user';
const AUTH_TOKEN_STORAGE_KEY = 'izone_auth_token';
const LOGGED_OUT_FLAG_KEY = 'izone_session_logged_out';
const RECENT_BOOTSTRAP_CACHE_KEY = 'izone_recent_bootstrap_cache_v2';
// v3: scoped per user+branch+fiscal-year with freshness TTL. v2 key retained
// only for one-shot migration & purge.
const BOOTSTRAP_CACHE_V3_PREFIX = 'izone_bootstrap_v3';
export const BOOTSTRAP_CACHE_MAX_AGE_MS = 2 * 60 * 1000; // 2 minutes

export interface ScopedBootstrapCacheEntry {
  v: 3;
  savedAt: number;
  dataVersion?: number;
  data: BootstrapState;
}

function scopedBootstrapKey(userId?: string, branchId?: string, fiscalYearId?: string): string {
  return `${BOOTSTRAP_CACHE_V3_PREFIX}:${userId || 'anon'}:${branchId || 'ALL'}:${fiscalYearId || 'current'}`;
}

// ------------------------------------
// 1. COOKIE STORAGE HELPERS (Legacy & Fallback)
// ------------------------------------

export function eraseCookie(name: string) {
  try {
    const paths = ['/', ''];
    const domains = ['', window.location.hostname, `.${window.location.hostname}`];
    
    paths.forEach((path) => {
      domains.forEach((domain) => {
        const domainStr = domain ? `; domain=${domain}` : '';
        const pathStr = path ? `; path=${path}` : '';
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:01 GMT${pathStr}${domainStr}; SameSite=Lax`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:01 GMT${pathStr}${domainStr}; SameSite=None; Secure`;
      });
    });
  } catch (_e) {
    // Fallback
  }
}

// ------------------------------------
// 2. PRIMARY USER SESSION STORAGE
// ------------------------------------

// Save logged-in user in localStorage
export function saveUserSession(currentUser: User | null, rootUser: User | null, token?: string | null) {
  if (currentUser) {
    // Clear logged-out marker
    try {
      localStorage.removeItem(LOGGED_OUT_FLAG_KEY);
    } catch (_e) {}

    // Sanitize user: ensure no password field could ever be serialized
    const { password: _, ...safeCurrent } = currentUser as any;
    const str = JSON.stringify(safeCurrent);
    try {
      localStorage.setItem(LOGGED_USER_STORAGE_KEY, str);
      if (token) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } catch (_e) {}
  } else {
    try {
      localStorage.removeItem(LOGGED_USER_STORAGE_KEY);
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
      localStorage.setItem(LOGGED_OUT_FLAG_KEY, 'true');
    } catch (_e) {}
    eraseCookie(LOGGED_USER_STORAGE_KEY);
  }

  if (rootUser) {
    const { password: _, ...safeRoot } = rootUser as any;
    const str = JSON.stringify(safeRoot);
    try {
      localStorage.setItem(ROOT_USER_STORAGE_KEY, str);
    } catch (_e) {}
  } else {
    try {
      localStorage.removeItem(ROOT_USER_STORAGE_KEY);
    } catch (_e) {}
    eraseCookie(ROOT_USER_STORAGE_KEY);
  }
}

// Load logged-in user session with strict check against logged-out state
export function loadUserSession(): { currentUser: User | null; rootUser: User | null; token: string | null } {
  let currentUser: User | null = null;
  let rootUser: User | null = null;

  try {
    // If explicitly logged out, never restore from stale storage
    const isLoggedOut = localStorage.getItem(LOGGED_OUT_FLAG_KEY);
    if (isLoggedOut === 'true') {
      return { currentUser: null, rootUser: null, token: null };
    }

    const currentStr = localStorage.getItem(LOGGED_USER_STORAGE_KEY);
    if (currentStr) {
      currentUser = JSON.parse(currentStr);
    }

    const rootStr = localStorage.getItem(ROOT_USER_STORAGE_KEY);
    if (rootStr) {
      rootUser = JSON.parse(rootStr);
    }
  } catch (_e) {
    // Ignore parse errors
  }

  return { currentUser, rootUser, token: localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) };
}

export function clearUserSession() {
  try {
    localStorage.setItem(LOGGED_OUT_FLAG_KEY, 'true');
    localStorage.removeItem(LOGGED_USER_STORAGE_KEY);
    localStorage.removeItem(ROOT_USER_STORAGE_KEY);
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    localStorage.removeItem('izone_logged_user');
    localStorage.removeItem('izone_root_user');
    localStorage.removeItem(RECENT_BOOTSTRAP_CACHE_KEY);
    sessionStorage.clear();
  } catch (_e) {}

  // Erase any lingering cookies
  eraseCookie(LOGGED_USER_STORAGE_KEY);
  eraseCookie(ROOT_USER_STORAGE_KEY);
  eraseCookie('izone_auth_user');
  eraseCookie('izone_root_user');
  eraseCookie('izone_logged_user');
}

// ------------------------------------
// 3. RECENT DATA CACHE FOR INSTANT LOADING
// ------------------------------------
// Cache is scoped per (user, branch, fiscal year) so one user can never see
// another user's / another view's numbers. A freshness TTL + server
// dataVersion guard decide whether the cached snapshot may be shown while the
// real API fetch completes.

export function saveRecentBootstrapCache(
  data: BootstrapState,
  scope?: { userId?: string; branchId?: string; fiscalYearId?: string }
) {
  try {
    // Only cache if not in logged-out state
    if (localStorage.getItem(LOGGED_OUT_FLAG_KEY) === 'true') return;
    if (!data || !data.dataVersion) return;

    const entry: ScopedBootstrapCacheEntry = {
      v: 3,
      savedAt: Date.now(),
      dataVersion: data.dataVersion,
      data,
    };
    localStorage.setItem(scopedBootstrapKey(scope?.userId, scope?.branchId, scope?.fiscalYearId), JSON.stringify(entry));
  } catch (_e) {
    // Quota reached or storage disabled
  }
}

export function loadRecentBootstrapCache(
  scope?: { userId?: string; branchId?: string; fiscalYearId?: string },
  opts?: { maxAgeMs?: number; mustHaveDataVersion?: number }
): BootstrapState | null {
  try {
    if (localStorage.getItem(LOGGED_OUT_FLAG_KEY) === 'true') {
      return null;
    }
    // v3 scoped entry for this user+branch+FY view.
    const raw = localStorage.getItem(scopedBootstrapKey(scope?.userId, scope?.branchId, scope?.fiscalYearId));
    if (raw) {
      const entry = JSON.parse(raw) as ScopedBootstrapCacheEntry;
      if (entry && entry.v === 3 && entry.data) {
        // TTL guard: only trust a snapshot that is fresh enough.
        const maxAgeMs = opts?.maxAgeMs ?? BOOTSTRAP_CACHE_MAX_AGE_MS;
        if (Date.now() - entry.savedAt <= maxAgeMs) {
          // dataVersion guard: if the caller knows the server is newer, skip.
          if (opts?.mustHaveDataVersion !== undefined && entry.dataVersion !== opts.mustHaveDataVersion) {
            return null;
          }
          return entry.data;
        }
      }
    }
  } catch (_e) {
    // Fall through to legacy migration below
  }

  // Legacy migration: one-shot read of the old unscoped v2 key. Import the
  // data but never re-write it under the old key again.
  try {
    if (localStorage.getItem(LOGGED_OUT_FLAG_KEY) === 'true') return null;
    const legacyRaw = localStorage.getItem(RECENT_BOOTSTRAP_CACHE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as BootstrapState;
      localStorage.removeItem(RECENT_BOOTSTRAP_CACHE_KEY);
      return legacy;
    }
  } catch (_e) {
    // Ignore
  }
  return null;
}

export function clearRecentBootstrapCache() {
  try {
    // Remove legacy key plus every scoped v3 key.
    localStorage.removeItem(RECENT_BOOTSTRAP_CACHE_KEY);
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(BOOTSTRAP_CACHE_V3_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (_e) {}
}

