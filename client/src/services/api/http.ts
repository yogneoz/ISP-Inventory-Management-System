import type { User } from '../../types';

// ---------------------------------------------------------------------------
// Shared HTTP internals
//
// Extracted verbatim from the former monolithic api.ts so each domain module
// (auth, inventory, procurement, ...) can own its endpoints while the request
// pipeline — auth headers, fiscal-year context, GET deduplication, 401
// handling — stays in exactly one place.
// ---------------------------------------------------------------------------

export const API_BASE = (((import.meta as any).env?.VITE_API_BASE_URL as string) || '').replace(/\/$/, '');

let currentUserContext: User | null = null;
let currentFiscalYearId: string | null = null;
let authToken: string | null = typeof localStorage !== 'undefined' ? localStorage.getItem('inventory_auth_token') : null;

export const setAuthToken = (token: string | null) => {
  authToken = token;
};

export const setUserContext = (user: User | null) => {
  currentUserContext = user;
};

export const setFiscalYearContext = (fiscalYearId: string | null) => {
  currentFiscalYearId = fiscalYearId;
};

// ---------------------------------------------------------------------------
// Toast contract
//
// Every failed request carries a ready-to-render toast payload on its Error
// (`error.toast`), and mutations additionally broadcast it so the global
// <ToastHost/> can render it. Without this a rejection that no caller catches
// dies as an unhandled promise rejection and the UI silently does nothing —
// exactly the damage-tagging bug found in the 2026-10-10 walkthrough (the
// form neither saved nor explained why).
//
// Broadcast scope is deliberate:
//   - 401 is NOT toasted: the expired-session flow owns that message
//     (inventory_auth_expired → App forces logout).
//   - GETs are NOT toasted: they are background refreshes/polls whose failure
//     state the app already surfaces elsewhere, and toasting them would spam
//     a toast every poll while the database is down.
// ---------------------------------------------------------------------------
export const API_TOAST_EVENT = 'inventory_api_toast';

/** Tab-navigation request emitted by toast actions; App validates the target
 *  against the signed-in user's permissions before switching. */
export const NAVIGATE_TAB_EVENT = 'inventory_navigate_tab';

/**
 * Tabs that can actually repair an unseeded BS calendar, by role. The BS
 * Calendar Utility is Super-Admin-only in the sidebar; a Head Office Admin
 * reaches the same seeder on the Nepali Fiscal Management screen (the server
 * permits both roles to seed). Roles absent here cannot seed, so their toast
 * stays informational.
 */
export const BS_SEEDING_TAB_BY_ROLE: Record<string, string | undefined> = {
  SUPER_ADMIN: 'bs-calendar',
  HEAD_OFFICE_ADMIN: 'nepali-fiscal',
};

export function requestTabNavigation(tab: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NAVIGATE_TAB_EVENT, { detail: { tab } }));
}

export interface ApiToastAction {
  /** Button label, e.g. 'Open BS Calendar Utility'. */
  label: string;
  /** App tab the button navigates to (validated by App before switching). */
  tab: string;
}

export interface ApiToastIntent {
  message: string;
  status?: number;
  /** Optional fix-it action rendered as a button in the toast. */
  action?: ApiToastAction;
  /** Auto-dismiss delay; actionable toasts get longer so the button is
   *  actually reachable (default in ToastHost). */
  dismissAfterMs?: number;
}

// In-flight promise cache to deduplicate simultaneous duplicate requests
const inFlightRequests = new Map<string, Promise<any>>();

export async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const isGet = !options?.method || options.method === 'GET';
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const cacheKey = `${isGet ? 'GET' : 'MUT'}:${url}:${currentUserContext?.id || ''}:${currentUserContext?.branchId || ''}`;

  if (isGet && inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey)! as Promise<T>;
  }

  const userHeaders: Record<string, string> = {};
  if (authToken) userHeaders.Authorization = `Bearer ${authToken}`;
  if (currentFiscalYearId) userHeaders['x-fiscal-year-id'] = currentFiscalYearId;

  const promise = (async () => {
    try {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...userHeaders,
          ...options?.headers,
        },
        ...options,
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({ message: res.statusText }));
        const error = new Error(errorBody.message || `Request failed with status ${res.status}`);
        // Attach status code for 401 detection
        (error as any).status = res.status;
        // Toast intent (see the contract above): attach it to every failure,
        // broadcast it for failed mutations.
        const toastIntent: ApiToastIntent = { message: error.message, status: res.status };
        // Unseeded BS date: the server answers 400 bsDateMissing with a
        // machine-readable reason (bsDateReason: gap vs past the end of the
        // calendar). When the signed-in user can seed, give the toast a button
        // that opens that screen — telling an administrator to "contact your
        // system administrator for BS month seeding" is a dead end.
        if (errorBody?.bsDateMissing === true) {
          const seedingTab = BS_SEEDING_TAB_BY_ROLE[currentUserContext?.role || ''];
          if (seedingTab) {
            toastIntent.action = { label: 'Open BS Calendar Utility', tab: seedingTab };
            toastIntent.dismissAfterMs = 15_000;
          }
        }
        (error as any).toast = toastIntent;
        // Dispatch auth expiration event on 401 so App can force logout
        if (res.status === 401) {
          window.dispatchEvent(new CustomEvent('inventory_auth_expired', { detail: { message: error.message } }));
        } else if (!isGet && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(API_TOAST_EVENT, { detail: toastIntent }));
        }
        throw error;
      }
      return await res.json();
    } finally {
      if (isGet) {
        inFlightRequests.delete(cacheKey);
      }
    }
  })();

  if (isGet) {
    inFlightRequests.set(cacheKey, promise);
  }

  return promise;
}
