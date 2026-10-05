/**
 * Repository for the application-settings & user-preferences domain.
 *
 * Two key/value tables back everything the client used to keep only in
 * browser localStorage:
 *   - app_settings      — company-wide configuration (SUPER_ADMIN writable),
 *                         e.g. the company-wide blind stock-audit toggle.
 *   - user_preferences  — per-user UI preferences (theme, date mode, last
 *                         active tab), written by the owning user.
 *
 * This module owns ALL query text for the domain plus the whitelist/type
 * validation used by the controller, so settings.controller.ts stays free of
 * SQL and of payload-shape logic (same split as permissions.repo.ts).
 */

// ---------------------------------------------------------------------------
// Query text
// ---------------------------------------------------------------------------

export const APP_SETTINGS_SELECT_SQL =
  'SELECT setting_key AS "key", setting_value AS "value" FROM app_settings ORDER BY setting_key';

export const APP_SETTING_UPSERT_SQL =
  'INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES ($1, $2, $3) ' +
  'ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, ' +
  'updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP';

export const USER_PREFERENCES_SELECT_SQL =
  'SELECT pref_key AS "key", pref_value AS "value" FROM user_preferences WHERE user_id = $1 ORDER BY pref_key';

/** Patch semantics: only the submitted keys are written/removed. */
export const USER_PREFERENCE_UPSERT_SQL =
  'INSERT INTO user_preferences (user_id, pref_key, pref_value) VALUES ($1, $2, $3) ' +
  'ON CONFLICT (user_id, pref_key) DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = CURRENT_TIMESTAMP';

export const USER_PREFERENCE_DELETE_SQL = 'DELETE FROM user_preferences WHERE user_id = $1 AND pref_key = $2';

// ---------------------------------------------------------------------------
// Whitelists — the ONLY keys the two tables may ever contain
// ---------------------------------------------------------------------------

export const APP_SETTING_KEYS = ['companyWideBlindCount'] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];

export const USER_PREFERENCE_KEYS = ['theme', 'dateMode', 'activeTab'] as const;
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
  return { ok: true, value };
}

/**
 * Validates a PUT /api/preferences payload (the caller's own preferences).
 * Each known key is type-checked; unknown keys are rejected.
 */
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
  return { ok: true, value };
}
