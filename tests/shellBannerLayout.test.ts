/**
 * The shell's notice strip — the layout that put "POSTGRESQL UNREACHABLE" under
 * the sidebar and the fiscal-year list under the notice.
 *
 * Two independent mistakes made that happen, and neither shows up in a
 * component test because they are about the shell's stacking and geometry:
 *
 *   1. the banner stack was `fixed inset-x-0` (well, `absolute inset-x-0` on the
 *      full-width header block), so it started at x=0 and the sidebar — a
 *      static flex sibling that paints later — covered its left edge;
 *   2. the stack sat at the same z as the header's own popovers and came later
 *      in the DOM, so an open fiscal-year dropdown rendered underneath it.
 *
 * These are source pins on purpose: the fix is one class string, and a future
 * "tidy up the banner" edit would silently bring both defects back.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

describe('shell banner layout', () => {
  const shell = read('client/src/components/layout/AppShell.tsx');
  const sidebar = read('client/src/components/layout/Sidebar.tsx');
  const css = read('client/src/index.css');

  const bannerStack = (() => {
    const match = /id="shell-banner-stack"[\s\S]{0,900}?className="([^"]+)"/.exec(shell);
    assert.ok(match, 'the shell must render the banner stack');
    return match![1];
  })();

  test('the notice starts where the workspace does, not under the sidebar', () => {
    assert.match(
      bannerStack,
      /md:left-\[var\(--sidebar-width/,
      'the stack must be offset by the sidebar width on desktop; inset-x-0 alone put its first line behind the menu'
    );
    assert.match(css, /--sidebar-width:\s*\d+px/, 'the first paint needs the sidebar width before the effect runs');
    assert.match(
      sidebar,
      /setProperty\(\s*'--sidebar-width'/,
      'Sidebar owns the resizable width, so it publishes the variable the shell reads'
    );
  });

  test('the notice paints below the header popovers', () => {
    assert.match(bannerStack, /\bz-20\b/, 'the stack must sit below the header (z-30)');
    assert.doesNotMatch(
      bannerStack,
      /\bz-(?:3[0-9]|[4-9][0-9])\b/,
      'a z at or above the header puts the notice on top of the fiscal-year list again'
    );
    assert.match(
      shell,
      /relative z-30[^"]*"\s*>[\s\S]{0,400}?<Header/,
      'the header block keeps the shell’s raised stacking context'
    );
    assert.match(
      read('client/src/components/layout/Header.tsx'),
      /sticky top-0 z-30/,
      'the header keeps its own context above the notice'
    );
  });
});
