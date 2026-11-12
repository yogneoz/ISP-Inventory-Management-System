// ---------------------------------------------------------------------------
// Settings / Preferences API
//
// Server-side home of the configuration that used to live only in browser
// localStorage (company-wide blind stock-audit toggle, theme, date mode, last
// active tab). Everything here is persisted in PostgreSQL, so clearing browser
// history/cookies can never change application behaviour — the browser copy is
// only ever a paint-time mirror that the server value overwrites on load.
// ---------------------------------------------------------------------------

import { fetchJson } from './http';
import type { CompanyOverviewCardId } from '../../../../shared/companyOverview';

export interface SettingsBundle {
  appSettings: Record<string, string>;
  preferences: Record<string, string>;
}

/** GET /api/settings — company-wide settings + the caller's own preferences. */
export async function getSettings(): Promise<SettingsBundle> {
  return fetchJson('/api/settings');
}

/** PUT /api/settings — write company-wide settings (SUPER_ADMIN only). */
export async function saveAppSettings(
  appSettings: Record<string, string>
): Promise<{ message: string; appSettings: Record<string, string> }> {
  return fetchJson('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings: appSettings }),
  });
}

/**
 * PUT /api/preferences — patch the caller's own preferences. Patch, not
 * replace: only the submitted keys are written, so a partial write can never
 * wipe the user's other preferences.
 */
export async function savePreferences(
  preferences: Record<string, string>
): Promise<{ message: string; preferences: Record<string, string> }> {
  return fetchJson('/api/preferences', {
    method: 'PUT',
    body: JSON.stringify({ preferences }),
  });
}

/**
 * PUT /api/company-overview/card-order — save the calling user's role order.
 * The server derives the role from the session, so this cannot reorder another
 * role's page.
 */
export async function saveCompanyOverviewCardOrder(
  cardOrder: CompanyOverviewCardId[]
): Promise<{
  message: string;
  cardOrder: CompanyOverviewCardId[];
  cardOrderByRole: string;
}> {
  return fetchJson('/api/company-overview/card-order', {
    method: 'PUT',
    body: JSON.stringify({ cardOrder }),
  });
}

/**
 * DELETE /api/company-overview/card-order — clear the calling role's saved
 * order and return that role to the built-in sequence. Other roles are kept.
 */
export async function resetCompanyOverviewCardOrder(): Promise<{
  message: string;
  cardOrder: CompanyOverviewCardId[];
  cardOrderByRole: string;
}> {
  return fetchJson('/api/company-overview/card-order', { method: 'DELETE' });
}
