// Session Cookie & Recent State Caching Engine for Instant Page Loading
import { BootstrapState, User } from '../types';

const LOGGED_USER_COOKIE = 'izone_auth_user';
const ROOT_USER_COOKIE = 'izone_root_user';
const RECENT_BOOTSTRAP_CACHE_KEY = 'izone_recent_bootstrap_cache_v2';

// ------------------------------------
// 1. COOKIE STORAGE HELPERS
// ------------------------------------

export function setCookie(name: string, value: string, days = 7) {
  try {
    const date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    const expires = `; expires=${date.toUTCString()}`;
    // Secure cookies with SameSite protection
    document.cookie = `${name}=${encodeURIComponent(value)}${expires}; path=/; SameSite=Lax`;
  } catch (_e) {
    // Fallback if cookies restricted
  }
}

export function getCookie(name: string): string | null {
  try {
    const nameEQ = `${name}=`;
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) === ' ') c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) === 0) {
        return decodeURIComponent(c.substring(nameEQ.length, c.length));
      }
    }
  } catch (_e) {
    // Fallback
  }
  return null;
}

export function eraseCookie(name: string) {
  try {
    document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax`;
  } catch (_e) {
    // Fallback
  }
}

// Save logged-in user in Cookie (and mirrored localStorage backup for cross-context)
export function saveUserSession(currentUser: User | null, rootUser: User | null) {
  if (currentUser) {
    // Sanitize user: ensure no password field could ever be serialized
    const { password: _, ...safeCurrent } = currentUser as any;
    const str = JSON.stringify(safeCurrent);
    setCookie(LOGGED_USER_COOKIE, str, 7);
    localStorage.setItem(LOGGED_USER_COOKIE, str);
  } else {
    eraseCookie(LOGGED_USER_COOKIE);
    localStorage.removeItem(LOGGED_USER_COOKIE);
  }

  if (rootUser) {
    const { password: _, ...safeRoot } = rootUser as any;
    const str = JSON.stringify(safeRoot);
    setCookie(ROOT_USER_COOKIE, str, 7);
    localStorage.setItem(ROOT_USER_COOKIE, str);
  } else {
    eraseCookie(ROOT_USER_COOKIE);
    localStorage.removeItem(ROOT_USER_COOKIE);
  }
}

// Load logged-in user session from Cookie or localStorage backup
export function loadUserSession(): { currentUser: User | null; rootUser: User | null } {
  let currentUser: User | null = null;
  let rootUser: User | null = null;

  try {
    const currentStr = getCookie(LOGGED_USER_COOKIE) || localStorage.getItem(LOGGED_USER_COOKIE);
    if (currentStr) currentUser = JSON.parse(currentStr);

    const rootStr = getCookie(ROOT_USER_COOKIE) || localStorage.getItem(ROOT_USER_COOKIE);
    if (rootStr) rootUser = JSON.parse(rootStr);
  } catch (_e) {
    // Ignore parse errors
  }

  return { currentUser, rootUser };
}

export function clearUserSession() {
  eraseCookie(LOGGED_USER_COOKIE);
  eraseCookie(ROOT_USER_COOKIE);
  localStorage.removeItem(LOGGED_USER_COOKIE);
  localStorage.removeItem(ROOT_USER_COOKIE);
  localStorage.removeItem('izone_logged_user');
  localStorage.removeItem('izone_root_user');
  try {
    sessionStorage.clear();
  } catch (_e) {}
}

// ------------------------------------
// 2. RECENT DATA CACHE FOR INSTANT LOADING
// ------------------------------------

export function saveRecentBootstrapCache(data: BootstrapState) {
  try {
    localStorage.setItem(RECENT_BOOTSTRAP_CACHE_KEY, JSON.stringify(data));
  } catch (_e) {
    // Quota reached or storage disabled
  }
}

export function loadRecentBootstrapCache(): BootstrapState | null {
  try {
    const cached = localStorage.getItem(RECENT_BOOTSTRAP_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (_e) {
    // Return null on failure
  }
  return null;
}

export function clearRecentBootstrapCache() {
  localStorage.removeItem(RECENT_BOOTSTRAP_CACHE_KEY);
}
