/**
 * Startup paint — no spinner, no blank banner.
 *
 * Measured on a real reload (rAF trace): the cached payload was applied in a
 * useEffect, so the browser painted the shell's "Synchronizing multi-branch
 * inventory database..." spinner for ~190 ms before the cached rows replaced
 * it. Two background reads (company settings, procurement badges) then mounted
 * 31px "Loading..." notices that disappeared a frame later, which read as a
 * blank banner blinking under the header.
 *
 * These guards pin the three wiring decisions that remove those frames:
 *   1. the cache pre-hydration is a layout effect (state applied before paint),
 *   2. a cached payload cannot prove database reachability, so the offline
 *      banner can only come from a live response,
 *   3. shell-level background reads opt out of the loading notice, and an
 *      empty banner stack collapses instead of keeping its shadow.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

describe('startup paint', () => {
  test('cached bootstrap data is applied in a layout effect, before the browser paints', () => {
    const app = read('client/src/App.tsx');
    const cacheRead = app.indexOf('loadRecentBootstrapCache(cacheScopeRef.current');
    assert.ok(cacheRead > 0, 'App must pre-hydrate from the recent bootstrap cache');

    const layoutEffect = app.lastIndexOf('useLayoutEffect(', cacheRead);
    const passiveEffect = app.lastIndexOf('useEffect(', cacheRead);
    assert.ok(layoutEffect > 0, 'the cache pre-hydration must be a useLayoutEffect');
    assert.ok(
      layoutEffect > passiveEffect,
      'the cache pre-hydration must not run in a passive useEffect after paint'
    );
    assert.ok(
      app.slice(cacheRead, cacheRead + 900).includes('setLoading(false)'),
      'the cached frame must clear the shell spinner in the same effect'
    );
  });

  test('a cached payload cannot set the database banner', () => {
    const app = read('client/src/App.tsx');
    assert.match(
      app,
      /data\.postgresDatabaseStatus\s*&&\s*!options\.fromCache/,
      'only a live bootstrap response may mark the database state known'
    );
  });

  test('shell background reads are quiet and an empty banner stack is hidden', () => {
    const app = read('client/src/App.tsx');
    assert.match(
      app,
      /subject="company settings"[\s\S]{0,140}showLoading=\{false\}/,
      'the settings backfill must not paint a loading bar'
    );
    assert.match(
      app,
      /subject="open purchase orders and unpaid bills"[\s\S]{0,160}showLoading=\{false\}/,
      'the procurement badge read must not paint a loading bar'
    );

    const shell = read('client/src/components/layout/AppShell.tsx');
    assert.match(
      shell,
      /id="shell-banner-stack"[\s\S]{0,220}empty:hidden/,
      'an empty stack must not keep its shadow (the blank strip under the header)'
    );
  });
});
