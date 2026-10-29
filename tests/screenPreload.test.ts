/**
 * Saved-tab chunk preload.
 *
 * A reload of a lazy tab painted the workspace's "Loading module..." fallback
 * for ~560 ms (measured in dev) while its chunk downloaded. main.tsx now reads
 * the saved tab, starts that module's import while the static boot splash is on
 * screen, and only mounts React after it settles (with a 3 s safety cap).
 *
 * These guards keep the map honest against App's lazy routes and pin the boot
 * ordering: preload first, createRoot second.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_TAB_STORAGE_KEY,
  SCREEN_PRELOADERS,
  preloadScreenModule,
} from '../client/src/screenPreload';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

/** Tab ids whose route is wrapped in React.Suspense (i.e. backed by lazy()). */
function lazyTabsFromApp(): string[] {
  const app = read('client/src/App.tsx');
  const starts = [...app.matchAll(/screenRoute\('([^']+)'/g)];
  const tabs: string[] = [];
  starts.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < starts.length ? starts[index + 1].index ?? app.length : app.length;
    if (app.slice(start, end).includes('React.Suspense')) tabs.push(match[1]);
  });
  return tabs;
}

describe('saved-tab screen preload', () => {
  test('every lazy route has a preloader (the dev-only gallery is gated)', () => {
    const lazyTabs = lazyTabsFromApp();
    assert.ok(lazyTabs.length >= 40, `expected the lazy route set, found ${lazyTabs.length}`);

    const expected = lazyTabs.filter((tab) => tab !== 'dev-statcard');
    assert.deepEqual(
      Object.keys(SCREEN_PRELOADERS).sort(),
      expected.sort(),
      'App added or removed a lazy screen without updating screenPreload.ts'
    );
  });

  test('eager and unknown tabs need no download', () => {
    assert.equal(preloadScreenModule('dashboard'), undefined);
    assert.equal(preloadScreenModule('all-stock'), undefined);
    assert.equal(preloadScreenModule('not-a-tab'), undefined);
    assert.equal(preloadScreenModule(null), undefined);
    assert.equal(preloadScreenModule(''), undefined);
  });

  test('main.tsx starts the saved tab without delaying boot, and covers the fallback', () => {
    const main = read('client/src/main.tsx');
    const app = read('client/src/App.tsx');
    const html = read('client/index.html');

    assert.match(
      main,
      /preloadScreenModule\(savedTab\(\)\)/,
      'main must start the saved tab module'
    );
    assert.match(
      main,
      /localStorage\.getItem\(ACTIVE_TAB_STORAGE_KEY\)/,
      'main must read the same saved-tab key App uses'
    );
    assert.ok(
      main.indexOf('void preloadSavedScreen()') < main.lastIndexOf('renderApp()'),
      'the chunk request must start before React is mounted'
    );
    assert.match(
      main,
      /BOOT_SPLASH_MAX_MS\s*=\s*8000/,
      'the splash must have a failure valve'
    );
    assert.match(
      main,
      /getElementById\('tab-loading-fallback'\)/,
      'the splash must wait for the lazy screen to replace its fallback'
    );
    assert.match(
      main,
      /getElementById\('app-sync-spinner'\)/,
      'the splash must also cover the shell bootstrap spinner'
    );

    assert.equal(ACTIVE_TAB_STORAGE_KEY, 'inventory_active_tab');
    assert.match(
      app,
      /import \{ ACTIVE_TAB_STORAGE_KEY \} from '\.\/screenPreload'/,
      'App must share the storage key with the preloader'
    );
    assert.doesNotMatch(
      app,
      /const ACTIVE_TAB_STORAGE_KEY\s*=/,
      'App must not keep a second literal for the saved-tab key'
    );

    // The splash must sit OUTSIDE #root, or React's first commit would remove
    // it before the lazy screen is ready.
    assert.ok(
      html.indexOf('id="boot-splash"') < html.indexOf('id="root"'),
      'the splash must be a sibling of #root'
    );
    assert.match(html, /<div id="root"><\/div>/);
    assert.match(app, /id="tab-loading-fallback"/);
    assert.match(app, /id="app-sync-spinner"/);
  });
});
