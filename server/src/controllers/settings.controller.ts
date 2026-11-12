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
  APP_SETTING_DELETE_SQL,
  APP_SETTING_KEYS,
  APP_SETTING_UPSERT_SQL,
  APP_SETTINGS_SELECT_SQL,
  USER_PREFERENCE_KEYS,
  USER_PREFERENCE_UPSERT_SQL,
  USER_PREFERENCES_SELECT_SQL,
  rowsToRecord,
  validateAppSettings,
  validateCompanyOverviewCardOrder,
  validateUserPreferences,
} from '../models/settings.repo';
import {
  DEFAULT_COMPANY_OVERVIEW_CARD_ORDER,
  parseCompanyOverviewCardOrders,
} from '../../../shared/companyOverview';

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
/**
 * Saves the calling role's Company Overview card order. The order is shared by
 * every account with that role, so the role comes from the authenticated user
 * and never from the request body. Any other role's saved order is preserved.
 */
export async function put_company_overview_card_order(req: any, res: Response): Promise<any> {
  try {
    const user = getUserFromReq(req);
    if (!user?.id || !user.role) {
      res.status(401).json({ message: 'Unauthorized: Authentication required.' });
      return;
    }
    const validated = validateCompanyOverviewCardOrder(req.body?.cardOrder);
    if (!validated.ok) {
      res.status(400).json({ message: validated.error });
      return;
    }

    const currentRes = await pgPool.query(APP_SETTINGS_SELECT_SQL);
    const current = rowsToRecord(currentRes.rows, APP_SETTING_KEYS);
    const byRole = parseCompanyOverviewCardOrders(current.companyOverviewCardOrderByRole);
    byRole[user.role] = validated.value;
    const cardOrderByRole = JSON.stringify(byRole);
    const updatedBy = user.email || 'unknown';

    await withTransaction(async (client) => {
      await client.query(APP_SETTING_UPSERT_SQL, [
        'companyOverviewCardOrderByRole',
        cardOrderByRole,
        updatedBy,
      ]);
    });

    // Let every session re-read the settings slice, so another member of the
    // same role sees the new order without a reload.
    broadcastChange({ type: 'APP_SETTINGS_UPDATED', entity: 'SETTINGS' });
    res.json({
      message: `Company Overview order saved for the ${user.role} role.`,
      cardOrder: validated.value,
      cardOrderByRole,
    });
    return;
  } catch (err: any) {
    res.status(500).json({ message: `Unable to save the card order: ${err.message}` });
    return;
  }
}

/**
 * Clears the calling role's saved Company Overview order, restoring the
 * built-in sequence for that role only. Other roles keep their saved orders.
 */
export async function delete_company_overview_card_order(req: any, res: Response): Promise<any> {
  try {
    const user = getUserFromReq(req);
    if (!user?.id || !user.role) {
      res.status(401).json({ message: 'Unauthorized: Authentication required.' });
      return;
    }

    const currentRes = await pgPool.query(APP_SETTINGS_SELECT_SQL);
    const current = rowsToRecord(currentRes.rows, APP_SETTING_KEYS);
    const byRole = parseCompanyOverviewCardOrders(current.companyOverviewCardOrderByRole);
    delete byRole[user.role];
    const cardOrderByRole = JSON.stringify(byRole);
    const updatedBy = user.email || 'unknown';

    await withTransaction(async (client) => {
      if (Object.keys(byRole).length === 0) {
        await client.query(APP_SETTING_DELETE_SQL, ['companyOverviewCardOrderByRole']);
      } else {
        await client.query(APP_SETTING_UPSERT_SQL, [
          'companyOverviewCardOrderByRole',
          cardOrderByRole,
          updatedBy,
        ]);
      }
    });

    broadcastChange({ type: 'APP_SETTINGS_UPDATED', entity: 'SETTINGS' });
    res.json({
      message: `Company Overview order reset to default for the ${user.role} role.`,
      cardOrder: [...DEFAULT_COMPANY_OVERVIEW_CARD_ORDER],
      cardOrderByRole,
    });
    return;
  } catch (err: any) {
    res.status(500).json({ message: `Unable to reset the card order: ${err.message}` });
    return;
  }
}

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
