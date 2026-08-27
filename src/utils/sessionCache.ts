// Session & User State Caching Engine for Enterprise Single Page Application
import { BootstrapState, User } from '../types';

const LOGGED_USER_STORAGE_KEY = 'izone_auth_user';
const ROOT_USER_STORAGE_KEY = 'izone_root_user';
const AUTH_TOKEN_STORAGE_KEY = 'izone_auth_token';
const LOGGED_OUT_FLAG_KEY = 'izone_session_logged_out';
const RECENT_BOOTSTRAP_CACHE_KEY = 'izone_recent_bootstrap_cache_v2';

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

// Save auth bearer token
export function saveAuthToken(token: string | null) {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
      localStorage.removeItem(LOGGED_OUT_FLAG_KEY);
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  } catch (_e) {}
}

export function loadAuthToken(): string | null {
  try {
    if (localStorage.getItem(LOGGED_OUT_FLAG_KEY) === 'true') return null;
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch (_e) {
    return null;
  }
}

// Save logged-in user in localStorage
export function saveUserSession(
  currentUser: User | null,
  rootUser: User | null,
  token?: string | null
) {
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
    } catch (_e) {}
  } else {
    try {
      localStorage.removeItem(LOGGED_USER_STORAGE_KEY);
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

  if (token !== undefined) {
    saveAuthToken(token);
  }
}

// Load logged-in user session with strict check against logged-out state
export function loadUserSession(): { currentUser: User | null; rootUser: User | null } {
  let currentUser: User | null = null;
  let rootUser: User | null = null;

  try {
    // If explicitly logged out, never restore from stale storage
    const isLoggedOut = localStorage.getItem(LOGGED_OUT_FLAG_KEY);
    if (isLoggedOut === 'true') {
      return { currentUser: null, rootUser: null };
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

  return { currentUser, rootUser };
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

export function saveRecentBootstrapCache(data: BootstrapState) {
  try {
    // Only cache if not in logged-out state
    if (localStorage.getItem(LOGGED_OUT_FLAG_KEY) !== 'true') {
      localStorage.setItem(RECENT_BOOTSTRAP_CACHE_KEY, JSON.stringify(data));
    }
  } catch (_e) {
    // Quota reached or storage disabled
  }
}

export function loadRecentBootstrapCache(): BootstrapState | null {
  try {
    if (localStorage.getItem(LOGGED_OUT_FLAG_KEY) === 'true') {
      return null;
    }
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
  try {
    localStorage.removeItem(RECENT_BOOTSTRAP_CACHE_KEY);
  } catch (_e) {}
}

