/**
 * URL state for the Users & Staff access filters.
 *
 * A filter link must name the screen as well as the two controls; otherwise
 * the recipient lands on whatever tab their own preference saved. The screen
 * now has a canonical path (`/settings/users`), so these helpers keep the path
 * and query string stable while preserving unrelated params and the hash.
 */

import { pathForTab, recordFromPath, TAB_URL_PARAM } from '../routes/appPaths';

export { TAB_URL_PARAM };
export const ACCESS_FILTER_URL_PARAM = 'access';
export const OPERATION_FILTER_URL_PARAM = 'operation';

export type AccessFilterScope = 'all' | 'exceptions';

export interface AccessFilterUrlState {
  accessFilter: AccessFilterScope;
  operationFilter: string;
}

/** Reads the two filter params; unknown values fall back to no filter. */
export function readAccessFilterUrl(search: string): AccessFilterUrlState {
  const params = new URLSearchParams(search);
  return {
    accessFilter: params.get(ACCESS_FILTER_URL_PARAM) === 'exceptions' ? 'exceptions' : 'all',
    operationFilter: (params.get(OPERATION_FILTER_URL_PARAM) || '').trim(),
  };
}

/**
 * Mirrors the filters into the address bar with `replaceState` (a select is not
 * a navigation, so it must not fill the Back stack). It also owns the Users
 * path so a copied link opens that screen even when both filters are at their
 * defaults. The old `?tab=users` stamp is removed.
 */
export function syncAccessFilterUrl(
  accessFilter: AccessFilterScope,
  operationFilter: string
): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (accessFilter === 'exceptions') {
      url.searchParams.set(ACCESS_FILTER_URL_PARAM, 'exceptions');
    } else {
      url.searchParams.delete(ACCESS_FILTER_URL_PARAM);
    }
    if (operationFilter) {
      url.searchParams.set(OPERATION_FILTER_URL_PARAM, operationFilter);
    } else {
      url.searchParams.delete(OPERATION_FILTER_URL_PARAM);
    }
    // Keep a Users record path (`/settings/users/:id/edit`) intact while its
    // filters change; otherwise the filter effect would close the open editor.
    const record = recordFromPath(window.location.pathname);
    if (!record || record.tab !== 'users') url.pathname = pathForTab('users');
    url.searchParams.delete(TAB_URL_PARAM);

    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, '', next);
  } catch {
    // History can be unavailable in an embedded/sandboxed context. The
    // in-memory filters still work; only the shareable URL is lost.
  }
}
