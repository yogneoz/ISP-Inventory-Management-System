/**
 * Unit tests for the settings/preferences repository layer
 * (server/src/models/settings.repo.ts).
 *
 * The server is the ONLY authority for application settings and user
 * preferences — the browser-localStorage copies these tables replaced are
 * gone, so what the API accepts is what decides whether a preference or a
 * company-wide toggle can be persisted at all. These tests pin:
 *
 *   1. the whitelists (only known keys may ever reach the tables),
 *   2. value validation (booleans for app settings, enum/shape checks for
 *      preferences — including hostile "preference" payloads),
 *   3. row → record mapping that drops anything outside the whitelist.
 *
 * Pure functions: no database required.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_SETTING_KEYS,
  USER_PREFERENCE_KEYS,
  rowsToRecord,
  validateAppSettings,
  validateUserPreferences,
} from '../server/src/models/settings.repo';

describe('settings.repo — whitelists', () => {
  test('only the company-wide blind-count toggle is a company setting', () => {
    assert.deepEqual([...APP_SETTING_KEYS], ['companyWideBlindCount']);
  });

  test('the only per-user preferences are theme, dateMode and activeTab', () => {
    assert.deepEqual([...USER_PREFERENCE_KEYS], ['theme', 'dateMode', 'activeTab']);
  });
});

describe('settings.repo — validateAppSettings', () => {
  test('accepts a real boolean and stores it as its string form', () => {
    const result = validateAppSettings({ companyWideBlindCount: true });
    assert.deepEqual(result, { ok: true, value: { companyWideBlindCount: 'true' } });
    assert.deepEqual(validateAppSettings({ companyWideBlindCount: false }), {
      ok: true,
      value: { companyWideBlindCount: 'false' },
    });
  });

  test('accepts the already-string form a client round-trip produces', () => {
    assert.deepEqual(validateAppSettings({ companyWideBlindCount: 'true' }), {
      ok: true,
      value: { companyWideBlindCount: 'true' },
    });
  });

  test('rejects a non-boolean value instead of storing garbage', () => {
    const result = validateAppSettings({ companyWideBlindCount: 'yes' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /true or false/);
  });

  test('rejects unknown keys so a typo can never look like it saved', () => {
    const result = validateAppSettings({ companyWideBlindCount: true, evilFlag: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /Unknown setting 'evilFlag'/);
  });

  test('rejects non-object payloads (arrays, primitives, null)', () => {
    for (const payload of [['companyWideBlindCount'], 'true', 42, null, undefined]) {
      const result = validateAppSettings(payload);
      assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} must be rejected`);
    }
  });

  test('an empty patch is a valid no-op', () => {
    assert.deepEqual(validateAppSettings({}), { ok: true, value: {} });
  });
});

describe('settings.repo — validateUserPreferences', () => {
  test('accepts the three supported preferences', () => {
    const result = validateUserPreferences({ theme: 'dark', dateMode: 'AD', activeTab: 'sales-invoices' });
    assert.deepEqual(result, {
      ok: true,
      value: { theme: 'dark', dateMode: 'AD', activeTab: 'sales-invoices' },
    });
  });

  test('accepts a partial patch (only the submitted key is written)', () => {
    assert.deepEqual(validateUserPreferences({ theme: 'light' }), {
      ok: true,
      value: { theme: 'light' },
    });
  });

  test('rejects out-of-range enum values', () => {
    assert.equal(validateUserPreferences({ theme: 'neon' }).ok, false);
    assert.equal(validateUserPreferences({ dateMode: 'BS-' }).ok, false);
  });

  test('rejects an activeTab that is not a navigation id', () => {
    for (const activeTab of ['', 'DROP TABLE users;--', 'has space', 'UPPER', 'x'.repeat(65)]) {
      const result = validateUserPreferences({ activeTab });
      assert.equal(result.ok, false, `activeTab ${JSON.stringify(activeTab)} must be rejected`);
    }
  });

  test('rejects unknown preference keys', () => {
    const result = validateUserPreferences({ isAdmin: 'true' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /Unknown preference 'isAdmin'/);
  });

  test('rejects non-object payloads', () => {
    assert.equal(validateUserPreferences(['theme']).ok, false);
    assert.equal(validateUserPreferences('dark').ok, false);
    assert.equal(validateUserPreferences(null).ok, false);
  });
});

describe('settings.repo — rowsToRecord', () => {
  test('maps rows and drops keys outside the whitelist', () => {
    const rows = [
      { key: 'companyWideBlindCount', value: 'true' },
      { key: 'legacy_leftover', value: 'should not leak' },
    ];
    assert.deepEqual(rowsToRecord(rows, APP_SETTING_KEYS), { companyWideBlindCount: 'true' });
  });

  test('tolerates an empty/absent result set (fresh install)', () => {
    assert.deepEqual(rowsToRecord(undefined, USER_PREFERENCE_KEYS), {});
    assert.deepEqual(rowsToRecord([], USER_PREFERENCE_KEYS), {});
  });

  test('drops rows whose value is not a string', () => {
    const rows = [{ key: 'theme', value: 42 as unknown as string }];
    assert.deepEqual(rowsToRecord(rows, USER_PREFERENCE_KEYS), {});
  });
});
