/**
 * Settings controller — HTTP orchestration for the app-settings and
 * user-preferences domain (the server-side home of what used to live only in
 * browser localStorage: the company-wide blind stock-audit toggle, theme,
 * date mode and the last active tab).
 *
 * Query text and payload validation live in ../models/settings.repo.ts; this
 * layer only does auth/HTTP concerns, following permissions.controller.ts.
 */
import type { Response } from 'express';
import { getUserFromReq, pgPool, withTransaction, broadcastChange } from '../app';
import {
  APP_SETTING_KEYS,
  APP_SETTING_UPSERT_SQL,
  APP_SETTINGS_SELECT_SQL,
  USER_PREFERENCE_KEYS,
  USER_PREFERENCE_UPSERT_SQL,
  USER_PREFERENCES_SELECT_SQL,
  rowsToRecord,
  validateAppSettings,
  validateUserPreferences,
} from '../models/settings.repo';

/** Reads the company-wide settings plus the calling user's own preferences. */
export async function get_settings(req: any, res: Response): Promise<any> {
  const user = getUserFromReq(req);
  const [settingsRes, prefsRes] = await Promise.all([
    pgPool.query(APP_SETTINGS_SELECT_SQL),
    user.id ? pgPool.query(USER_PREFERENCES_SELECT_SQL, [user.id]) : Promise.resolve({ rows: [] }),
  ]);
  res.json({
    appSettings: rowsToRecord(settingsRes.rows, APP_SETTING_KEYS),
    preferences: rowsToRecord(prefsRes.rows, USER_PREFERENCE_KEYS),
  });
  return;
}

/**
 * Writes the submitted company-wide settings (whitelisted keys only).
 * SUPER_ADMIN is enforced by the route; unknown/malformed keys are a 400 so
 * a typo can never look like it saved.
 */
export async function put_settings(req: any, res: Response): Promise<any> {
  try {
    const validated = validateAppSettings(req.body?.settings ?? req.body);
    if (!validated.ok) {
      res.status(400).json({ message: validated.error });
      return;
    }
    const user = getUserFromReq(req);
    const updatedBy = user.email || 'unknown';

    await withTransaction(async (client) => {
      for (const key of APP_SETTING_KEYS) {
        if (validated.value[key] === undefined) continue;
        await client.query(APP_SETTING_UPSERT_SQL, [key, validated.value[key], updatedBy]);
      }
    });

    const settingsRes = await pgPool.query(APP_SETTINGS_SELECT_SQL);
    const appSettings = rowsToRecord(settingsRes.rows, APP_SETTING_KEYS);
    // Company-wide settings are only company-wide if every connected client
    // hears about them: emit the SETTINGS domain so the other sessions'
    // appSettings slice re-fetches without a manual reload.
    broadcastChange({ type: 'APP_SETTINGS_UPDATED', entity: 'SETTINGS' });
    console.log(`✅ Application settings updated by ${updatedBy}: ${Object.keys(validated.value).join(', ')}`);
    res.json({ message: 'Settings updated successfully.', appSettings });
    return;
  } catch (err: any) {
    res.status(500).json({ message: `Unable to update settings: ${err.message}` });
    return;
  }
}

/**
 * Patches the calling user's own preferences. Semantics are a PATCH, not a
 * replace: only the submitted keys are written, so a late or partial write
 * (e.g. just { theme }) can never wipe the user's other preferences.
 */
export async function put_preferences(req: any, res: Response): Promise<any> {
  try {
    const user = getUserFromReq(req);
    if (!user.id) {
      res.status(401).json({ message: 'Unauthorized: Authentication required.' });
      return;
    }
    const validated = validateUserPreferences(req.body?.preferences ?? req.body);
    if (!validated.ok) {
      res.status(400).json({ message: validated.error });
      return;
    }

    const keys = USER_PREFERENCE_KEYS.filter((key) => validated.value[key] !== undefined);
    if (keys.length > 0) {
      await withTransaction(async (client) => {
        for (const key of keys) {
          await client.query(USER_PREFERENCE_UPSERT_SQL, [user.id, key, validated.value[key]]);
        }
      });
    }

    const prefsRes = await pgPool.query(USER_PREFERENCES_SELECT_SQL, [user.id]);
    res.json({ message: 'Preferences saved.', preferences: rowsToRecord(prefsRes.rows, USER_PREFERENCE_KEYS) });
    return;
  } catch (err: any) {
    res.status(500).json({ message: `Unable to save preferences: ${err.message}` });
    return;
  }
}
