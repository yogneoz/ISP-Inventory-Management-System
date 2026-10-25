/**
 * A4 — the typed route table and AppRoutes.
 *
 * The tab tree must be declared exactly once, the root must not own the
 * keep-mounted wiring, and the permission metadata must come from the same
 * table the navigation guard reads. The behavioural cases use a stub table so
 * they test AppRoutes itself, not a screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mountStubRoutes, stubRoutesElement } from './harness/appRoutesProbe';
import { NAV_TABS } from '../client/src/components/layout/Sidebar';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

test('A4: the tab tree is declared once, as a typed route table', () => {
  const app = read('client/src/App.tsx');

  assert.doesNotMatch(app, /<KeepMountedRoot/, 'the root must not own the keep-mounted container');
  assert.doesNotMatch(app, /<KeepMounted\b/, 'the root must not wrap tabs itself');
  assert.match(app, /const screenRoutes: AppRoute\[\] = \[/, 'App must declare the route table');
  assert.match(
    app,
    /<AppRoutes activeTab=\{activeTab\} routes=\{screenRoutes\} \/>/,
    'App must render the routes through AppRoutes'
  );

  const keys = [...app.matchAll(/screenRoute\('([^']+)'/g)].map((match) => match[1]);
  assert.equal(keys.length, 67, 'every tab must be declared in the table');
  assert.equal(new Set(keys).size, keys.length, 'a tab must not be declared twice');

  const navTabs = new Set(NAV_TABS as string[]);
  for (const key of keys) {
    assert.ok(navTabs.has(key), `${key} is not a NavTab — a stale route key would render a dead tab`);
  }
});

test('A4: permissions live with the routes, not in the root', () => {
  const app = read('client/src/App.tsx');
  const permissions = read('client/src/routes/tabPermissions.ts');
  const registry = read('client/src/routes/appRoutes.tsx');

  assert.ok(!app.includes("'po-create'"), 'the RBAC table must not stay in App');
  assert.match(
    app,
    /const canAccessTab = \(tab: NavTab\): boolean => isTabAccessible\(tab, currentUser\);/,
    'the root guard must delegate to the shared rule'
  );

  assert.match(permissions, /export const TAB_PERMISSIONS/, 'the operation table must be exported');
  assert.match(permissions, /export const SUPER_ADMIN_ONLY_TABS/, 'the admin-only list must be exported');
  assert.match(permissions, /export function isTabAccessible/, 'the one access rule must be exported');
  assert.match(permissions, /import\.meta\.env\?\.DEV/, 'the DEV-only gate must survive the move');

  assert.match(registry, /permission: TAB_PERMISSIONS\[key\]/, 'the route entry must carry its permission');
  assert.match(
    registry,
    /superAdminOnly: SUPER_ADMIN_ONLY_TABS\.includes\(key\)/,
    'the route entry must carry the Super-Admin flag'
  );
});

test('A4: AppRoutes is the only route-level keep-mounted renderer', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(process.cwd(), 'client/src'));

  const holders = files
    .filter((file) => !file.endsWith(path.join('components', 'common', 'KeepMounted.tsx')))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('KeepMountedRoot'))
    .map((file) => path.relative(process.cwd(), file).replace(/\\/g, '/'));

  assert.deepEqual(holders, ['client/src/routes/appRoutes.tsx'], 'only AppRoutes may wrap the route tree');
});

test('A4: a disabled route never renders, even when it is the active tab', () => {
  const tree = mountStubRoutes('dev-statcard');
  try {
    const text = tree.container.textContent || '';
    assert.equal(text.includes('dev-body'), false, 'enabled:false must keep the element unmounted');
    assert.equal(text.includes('dashboard-body'), false, 'a never-active tab must not mount');
  } finally {
    tree.unmount();
  }
});

test('A4: activating a route mounts it once and hides it on switch', () => {
  const tree = mountStubRoutes('dashboard');
  try {
    const dash = tree.container.querySelector('[data-testid="dash"]');
    assert.ok(dash, 'the active route must render');

    tree.rerender(stubRoutesElement('customers'));
    assert.ok(tree.container.querySelector('[data-testid="customers"]'), 'the next route must mount');
    assert.ok(document.contains(dash), 'the previous route must stay mounted while hidden');

    tree.rerender(stubRoutesElement('dashboard'));
    assert.equal(
      tree.container.querySelector('[data-testid="dash"]'),
      dash,
      'returning to a route must reuse the mounted node, not remount it'
    );
  } finally {
    tree.unmount();
  }
});
