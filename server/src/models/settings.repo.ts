/**
 * Repository for the application-settings & user-preferences domain.
 *
 * Two key/value tables back everything the client used to keep only in
 * browser localStorage:
 *   - app_settings      — company-wide configuration (SUPER_ADMIN writable),
 *                         e.g. the company-wide blind stock-audit toggle and
 *                         the role-level Company Overview card order.
 *   - user_preferences  — per-user UI preferences (theme, date mode, last
 *                         active tab), written by the owning user.
 *
 * This module owns ALL query text for the domain plus the whitelist/type
 * validation used by the controller, so settings.controller.ts stays free of
 * SQL and of payload-shape logic (same split as permissions.repo.ts).
 */
import {
  COMPANY_OVERVIEW_CARD_IDS,
  type CompanyOverviewCardId,
  parseCompanyOverviewCardOrders,
} from '../../../shared/companyOverview';

// ---------------------------------------------------------------------------
// Query text
// ---------------------------------------------------------------------------

export const APP_SETTINGS_SELECT_SQL =
  'SELECT setting_key AS "key", setting_value AS "value" FROM app_settings ORDER BY setting_key';

export const APP_SETTING_UPSERT_SQL =
  'INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES ($1, $2, $3) ' +
  'ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, ' +
  'updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP';

export const APP_SETTING_DELETE_SQL =
  'DELETE FROM app_settings WHERE setting_key = $1';

export const USER_PREFERENCES_SELECT_SQL =
  'SELECT pref_key AS "key", pref_value AS "value" FROM user_preferences WHERE user_id = $1 ORDER BY pref_key';

/** Patch semantics: only the submitted keys are written/removed. */
export const USER_PREFERENCE_UPSERT_SQL =
  'INSERT INTO user_preferences (user_id, pref_key, pref_value) VALUES ($1, $2, $3) ' +
  'ON CONFLICT (user_id, pref_key) DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = CURRENT_TIMESTAMP';

// ---------------------------------------------------------------------------
// Whitelists — the ONLY keys the two tables may ever contain
// ---------------------------------------------------------------------------

export const APP_SETTING_KEYS = [
  'companyWideBlindCount',
  'companyOverviewCardOrderByRole',
] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];

export const USER_PREFERENCE_KEYS = [
  'theme',
  'dateMode',
  'activeTab',
  'orgChartLayout',
  'orgChartViewport',
  'orgChartLinkRoutes',
] as const;
export type UserPreferenceKey = (typeof USER_PREFERENCE_KEYS)[number];

// ---------------------------------------------------------------------------
// Row → object
// ---------------------------------------------------------------------------

interface KeyedRow {
  key: string;
  value: string;
}

/** Rows → plain record, dropping anything outside the whitelist. */
export function rowsToRecord<T extends string>(
  rows: KeyedRow[] | undefined | null,
  allowed: readonly T[]
): Record<T, string> {
  const out = {} as Record<T, string>;
  for (const row of rows || []) {
    if ((allowed as readonly string[]).includes(row.key) && typeof row.value === 'string') {
      out[row.key as T] = row.value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload validation (client input → whitelisted, type-checked record)
// ---------------------------------------------------------------------------

export type ValidationResult<T extends string> =
  | { ok: true; value: Record<T, string> }
  | { ok: false; error: string };

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/**
 * Validates a PUT /api/settings payload. Unknown keys are rejected (not
 * silently dropped) so a typo can never look like it saved, and every value
 * is normalized to its stored string form.
 */
export function validateAppSettings(input: unknown): ValidationResult<AppSettingKey> {
  if (!isPlainObject(input)) return { ok: false, error: 'Settings payload must be an object.' };

  for (const key of Object.keys(input)) {
    if (!(APP_SETTING_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown setting '${key}'.` };
    }
  }

  const value = {} as Record<AppSettingKey, string>;
  const blind = input.companyWideBlindCount;
  if (blind !== undefined) {
    if (typeof blind === 'boolean') {
      value.companyWideBlindCount = blind ? 'true' : 'false';
    } else if (blind === 'true' || blind === 'false') {
      value.companyWideBlindCount = blind;
    } else {
      return { ok: false, error: "Setting 'companyWideBlindCount' must be true or false." };
    }
  }
  const cardOrderByRole = input.companyOverviewCardOrderByRole;
  if (cardOrderByRole !== undefined) {
    if (typeof cardOrderByRole !== 'string') {
      return { ok: false, error: "Setting 'companyOverviewCardOrderByRole' must be a JSON string." };
    }
    const orders = parseCompanyOverviewCardOrders(cardOrderByRole);
    if (Object.keys(orders).length === 0) {
      return {
        ok: false,
        error: "Setting 'companyOverviewCardOrderByRole' must map at least one role to card ids.",
      };
    }
    value.companyOverviewCardOrderByRole = JSON.stringify(orders);
  }
  return { ok: true, value };
}

/**
 * Strict validation for one role's card order: every catalogued card exactly once.
 * The dedicated route saves a complete order, so a truncated or duplicate
 * payload is a 400 rather than a surprise reordering on the next load.
 */
export function validateCompanyOverviewCardOrder(
  input: unknown
): { ok: true; value: CompanyOverviewCardId[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length !== COMPANY_OVERVIEW_CARD_IDS.length) {
    return {
      ok: false,
      error: `cardOrder must list all ${COMPANY_OVERVIEW_CARD_IDS.length} department cards.`,
    };
  }
  const seen = new Set<CompanyOverviewCardId>();
  for (const value of input) {
    if (
      typeof value !== 'string' ||
      !(COMPANY_OVERVIEW_CARD_IDS as readonly string[]).includes(value)
    ) {
      return { ok: false, error: `Unknown Company Overview card '${String(value)}'.` };
    }
    if (seen.has(value as CompanyOverviewCardId)) {
      return { ok: false, error: `Company Overview card '${value}' appears more than once.` };
    }
    seen.add(value as CompanyOverviewCardId);
  }
  return { ok: true, value: input as CompanyOverviewCardId[] };
}

/**
 * Validates a PUT /api/preferences payload (the caller's own preferences).
 * Each known key is type-checked; unknown keys are rejected.
 */
/**
 * The org-chart board stores each view's manual card offsets as JSON:
 *   { "departments": { "post:des-01": { "x": 24, "y": -10 } }, "branch:BR-01": {...} }
 * This validates, bounds and normalises it before it is written to
 * user_preferences, so a malformed or oversized payload is a 400 rather than
 * a value the board cannot read back.
 */
function validateOrgChartLayout(
  input: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof input !== 'string') {
    return { ok: false, error: "Preference 'orgChartLayout' must be a JSON string." };
  }
  if (input.length > 20000) {
    return { ok: false, error: "Preference 'orgChartLayout' exceeds the 20,000-character limit." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "Preference 'orgChartLayout' must be valid JSON." };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "Preference 'orgChartLayout' must be a JSON object of views." };
  }
  const views = Object.keys(parsed);
  if (views.length === 0 || views.length > 64) {
    return { ok: false, error: "Preference 'orgChartLayout' must hold between 1 and 64 board views." };
  }
  const out: Record<string, Record<string, { x: number; y: number }>> = {};
  for (const view of views) {
    if (!/^(departments|branch:[A-Za-z0-9_-]{1,64})$/.test(view)) {
      return { ok: false, error: `Preference 'orgChartLayout' has an unknown view '${view}'.` };
    }
    const offsets = parsed[view];
    if (!isPlainObject(offsets)) {
      return { ok: false, error: `Preference 'orgChartLayout' view '${view}' must be an object.` };
    }
    const cards = Object.keys(offsets);
    if (cards.length > 400) {
      return { ok: false, error: `Preference 'orgChartLayout' view '${view}' holds too many cards (max 400).` };
    }
    const normalized: Record<string, { x: number; y: number }> = {};
    for (const card of cards) {
      if (!/^[A-Za-z0-9:_-]{1,80}$/.test(card)) {
        return { ok: false, error: `Preference 'orgChartLayout' has an invalid card key '${card}'.` };
      }
      const offset = offsets[card];
      if (
        !isPlainObject(offset) ||
        typeof offset.x !== 'number' ||
        typeof offset.y !== 'number' ||
        !Number.isFinite(offset.x) ||
        !Number.isFinite(offset.y) ||
        Math.abs(offset.x) > 50000 ||
        Math.abs(offset.y) > 50000
      ) {
        return { ok: false, error: `Preference 'orgChartLayout' card '${card}' needs finite x/y offsets.` };
      }
      normalized[card] = { x: Math.round(offset.x), y: Math.round(offset.y) };
    }
    out[view] = normalized;
  }
  return { ok: true, value: JSON.stringify(out) };
}

/**
 * Zoom and pan per board, kept beside the card offsets:
 *   { "departments": { "zoom": 0.55, "x": 24, "y": 12 }, "branch:BR-01": {...} }
 * Restoring these is what makes a view switch or a fullscreen toggle return to
 * the framing the user left, instead of snapping back to a fresh Fit.
 */
function validateOrgChartViewport(
  input: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof input !== 'string') {
    return { ok: false, error: "Preference 'orgChartViewport' must be a JSON string." };
  }
  if (input.length > 20000) {
    return { ok: false, error: "Preference 'orgChartViewport' exceeds the 20,000-character limit." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "Preference 'orgChartViewport' must be valid JSON." };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "Preference 'orgChartViewport' must be a JSON object of views." };
  }
  const views = Object.keys(parsed);
  if (views.length === 0 || views.length > 64) {
    return { ok: false, error: "Preference 'orgChartViewport' must hold between 1 and 64 board views." };
  }
  const out: Record<string, { zoom: number; x: number; y: number }> = {};
  for (const view of views) {
    if (!/^(departments|branch:[A-Za-z0-9_-]{1,64})$/.test(view)) {
      return { ok: false, error: `Preference 'orgChartViewport' has an unknown view '${view}'.` };
    }
    const entry = parsed[view];
    if (!isPlainObject(entry)) {
      return { ok: false, error: `Preference 'orgChartViewport' view '${view}' must be an object.` };
    }
    if (
      typeof entry.zoom !== 'number' ||
      typeof entry.x !== 'number' ||
      typeof entry.y !== 'number' ||
      !Number.isFinite(entry.zoom) ||
      !Number.isFinite(entry.x) ||
      !Number.isFinite(entry.y) ||
      entry.zoom < 0.05 ||
      entry.zoom > 3 ||
      Math.abs(entry.x) > 50000 ||
      Math.abs(entry.y) > 50000
    ) {
      return {
        ok: false,
        error: `Preference 'orgChartViewport' view '${view}' needs a zoom in 0.05–3 and finite x/y pan.`,
      };
    }
    out[view] = {
      zoom: Math.round(entry.zoom * 1000) / 1000,
      x: Math.round(entry.x),
      y: Math.round(entry.y),
    };
  }
  return { ok: true, value: JSON.stringify(out) };
}

/**
 * Per-board connector lane adjustments. The key is the link's stable
 * `from->to` card-key pair, the value the distance its bend is moved from the
 * automatic route:
 *   { "departments": { "post:des-01->post:des-02": 12 } }
 */
function validateOrgChartLinkRoutes(
  input: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof input !== 'string') {
    return { ok: false, error: "Preference 'orgChartLinkRoutes' must be a JSON string." };
  }
  if (input.length > 20000) {
    return { ok: false, error: "Preference 'orgChartLinkRoutes' exceeds the 20,000-character limit." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "Preference 'orgChartLinkRoutes' must be valid JSON." };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "Preference 'orgChartLinkRoutes' must be a JSON object of views." };
  }
  const views = Object.keys(parsed);
  if (views.length === 0 || views.length > 64) {
    return { ok: false, error: "Preference 'orgChartLinkRoutes' must hold between 1 and 64 board views." };
  }
  const out: Record<string, Record<string, number>> = {};
  for (const view of views) {
    if (!/^(departments|branch:[A-Za-z0-9_-]{1,64})$/.test(view)) {
      return { ok: false, error: `Preference 'orgChartLinkRoutes' has an unknown view '${view}'.` };
    }
    const routes = parsed[view];
    if (!isPlainObject(routes)) {
      return { ok: false, error: `Preference 'orgChartLinkRoutes' view '${view}' must be an object.` };
    }
    const links = Object.keys(routes);
    if (links.length > 400) {
      return { ok: false, error: `Preference 'orgChartLinkRoutes' view '${view}' holds too many links (max 400).` };
    }
    const normalized: Record<string, number> = {};
    for (const link of links) {
      if (!/^[A-Za-z0-9:_-]{1,80}->[A-Za-z0-9:_-]{1,80}$/.test(link)) {
        return { ok: false, error: `Preference 'orgChartLinkRoutes' has an invalid link key '${link}'.` };
      }
      const lane = routes[link];
      if (typeof lane !== 'number' || !Number.isFinite(lane) || Math.abs(lane) > 50000) {
        return { ok: false, error: `Preference 'orgChartLinkRoutes' link '${link}' needs a finite lane offset.` };
      }
      normalized[link] = Math.round(lane);
    }
    out[view] = normalized;
  }
  return { ok: true, value: JSON.stringify(out) };
}

export function validateUserPreferences(input: unknown): ValidationResult<UserPreferenceKey> {
  if (!isPlainObject(input)) return { ok: false, error: 'Preferences payload must be an object.' };

  for (const key of Object.keys(input)) {
    if (!(USER_PREFERENCE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown preference '${key}'.` };
    }
  }

  const value = {} as Record<UserPreferenceKey, string>;
  const theme = input.theme;
  if (theme !== undefined) {
    if (theme !== 'dark' && theme !== 'light') return { ok: false, error: "Preference 'theme' must be 'dark' or 'light'." };
    value.theme = theme;
  }
  const dateMode = input.dateMode;
  if (dateMode !== undefined) {
    if (dateMode !== 'BS' && dateMode !== 'AD') return { ok: false, error: "Preference 'dateMode' must be 'BS' or 'AD'." };
    value.dateMode = dateMode;
  }
  const activeTab = input.activeTab;
  if (activeTab !== undefined) {
    if (typeof activeTab !== 'string' || !/^[a-z0-9-]{1,64}$/.test(activeTab)) {
      return { ok: false, error: "Preference 'activeTab' must be a valid navigation tab id (letters, digits, dashes; max 64)." };
    }
    value.activeTab = activeTab;
  }
  const orgChartLayout = input.orgChartLayout;
  if (orgChartLayout !== undefined) {
    const layout = validateOrgChartLayout(orgChartLayout);
    if (!layout.ok) return layout;
    value.orgChartLayout = layout.value;
  }
  const orgChartViewport = input.orgChartViewport;
  if (orgChartViewport !== undefined) {
    const viewport = validateOrgChartViewport(orgChartViewport);
    if (!viewport.ok) return viewport;
    value.orgChartViewport = viewport.value;
  }
  const orgChartLinkRoutes = input.orgChartLinkRoutes;
  if (orgChartLinkRoutes !== undefined) {
    const routes = validateOrgChartLinkRoutes(orgChartLinkRoutes);
    if (!routes.ok) return routes;
    value.orgChartLinkRoutes = routes.value;
  }
  return { ok: true, value };
}
