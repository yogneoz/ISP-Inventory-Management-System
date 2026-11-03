/**
 * Phase 1 URL routing — the canonical tab → path table.
 *
 * The URL is now the address of a screen, not a mirror of React state. These
 * guards keep the table complete and unambiguous, and pin the legacy `?tab=`
 * input so old bookmarks keep working after the switch.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NAV_TABS, type NavTab } from '../client/src/components/layout/Sidebar';
import {
  APP_PATHS,
  RECORD_SCREENS,
  canonicalLocationUrl,
  canonicalTab,
  canonicalTabUrl,
  isRecordRouteForTab,
  pathForTab,
  recordFromPath,
  recordPathFor,
  resolveInitialTab,
  tabFromLegacyTabParam,
  tabFromLocation,
  tabFromPath,
} from '../client/src/routes/appPaths';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('canonical workspace paths', () => {
  test('every tab has a path, and every live screen owns exactly one path', () => {
    for (const tab of NAV_TABS) {
      const path = pathForTab(tab);
      assert.match(path, /^\/[a-z0-9/-]*$/, `${tab} must map to a canonical lowercase path`);
      assert.equal(path.endsWith('/'), false, `${tab} must not have a trailing slash`);
      assert.equal(APP_PATHS[tab], path, `${tab} must be declared in APP_PATHS`);
    }

    const liveTabs = NAV_TABS.filter((tab) => canonicalTab(tab) === tab);
    assert.equal(liveTabs.length, 76, '76 rendered screens, excluding the retired alias');
    const paths = liveTabs.map(pathForTab);
    assert.equal(new Set(paths).size, paths.length, 'two live screens cannot share a path');

    for (const tab of liveTabs) {
      assert.equal(tabFromPath(pathForTab(tab)), tab, `${pathForTab(tab)} must resolve back to ${tab}`);
    }
  });

  test('every route App renders is reachable by its canonical path', () => {
    const app = read('client/src/App.tsx');
    const routeKeys = [...app.matchAll(/screenRoute\('([^']+)'/g)].map((match) => match[1]);
    assert.equal(routeKeys.length, 76, 'the route table must still declare 76 screens');
    for (const key of routeKeys) {
      assert.equal(
        tabFromPath(pathForTab(key as NavTab)),
        key,
        `${key} is declared in App but its path does not resolve back to it`
      );
    }
  });

  test('the retired workflow-approval id aliases the live Approval Center', () => {
    assert.equal(pathForTab('workflow-approval'), '/approvals');
    assert.equal(canonicalTab('workflow-approval'), 'approvals');
    assert.equal(tabFromPath('/approvals'), 'approvals');
    assert.equal(
      resolveInitialTab('/', '?tab=workflow-approval', null).tab,
      'approvals',
      'old notification links must land on a live screen'
    );
  });

  test('path matching is case-insensitive and ignores a trailing slash', () => {
    assert.equal(tabFromPath('/Dashboard/'), 'dashboard');
    assert.equal(tabFromPath('/PURCHASING/INVOICES/NEW'), 'create-purchase');
    assert.equal(tabFromPath('/not-a-screen'), null);
  });
});

describe('record child paths', () => {
  test('every record register hangs off its tab canonical path', () => {
    for (const [tab, spec] of Object.entries(RECORD_SCREENS)) {
      assert.equal(spec.base, pathForTab(tab as NavTab), `${tab} record base must be its tab path`);
    }
  });

  test('detail, create and edit paths round-trip through the parser', () => {
    assert.deepEqual(recordFromPath('/sales/invoices/INV-2026-0001'), {
      tab: 'sales-list',
      record: { kind: 'detail', id: 'INV-2026-0001' },
    });
    assert.deepEqual(recordFromPath('/purchasing/invoices/PI-2026-0007'), {
      tab: 'purchase-list',
      record: { kind: 'detail', id: 'PI-2026-0007' },
    });
    assert.deepEqual(recordFromPath('/purchasing/orders/PO-2026-0003/edit'), {
      tab: 'po-list',
      record: { kind: 'edit', id: 'PO-2026-0003' },
    });
    assert.deepEqual(recordFromPath('/settings/users/new'), {
      tab: 'users',
      record: { kind: 'create' },
    });
    assert.deepEqual(recordFromPath('/settings/users/u-42/edit'), {
      tab: 'users',
      record: { kind: 'edit', id: 'u-42' },
    });
    assert.deepEqual(recordFromPath('/inventory/assets/new'), {
      tab: 'fixed-assets',
      record: { kind: 'create' },
    });
    assert.deepEqual(recordFromPath('/inventory/assets/AST-1001'), {
      tab: 'fixed-assets',
      record: { kind: 'detail', id: 'AST-1001' },
    });
    assert.deepEqual(recordFromPath('/sales/returns/CN-WH001-1'), {
      tab: 'sales-returns',
      record: { kind: 'detail', id: 'CN-WH001-1' },
    });
    assert.deepEqual(recordFromPath('/purchasing/returns/DN-WH001-1'), {
      tab: 'purchase-returns',
      record: { kind: 'detail', id: 'DN-WH001-1' },
    });
    assert.deepEqual(recordFromPath('/purchasing/shipments/TRF-BR-1001'), {
      tab: 'shipment-list',
      record: { kind: 'detail', id: 'TRF-BR-1001' },
    });
    assert.deepEqual(recordFromPath('/inventory/transfers/receive/TRF-BR-1001'), {
      tab: 'receive-branch-transfer',
      record: { kind: 'detail', id: 'TRF-BR-1001' },
    });
    assert.deepEqual(recordFromPath('/sales/customers/CUS-10291'), {
      tab: 'customers',
      record: { kind: 'detail', id: 'CUS-10291' },
    });

    assert.equal(
      recordPathFor('sales-list', { kind: 'detail', id: 'INV 1' }),
      '/sales/invoices/INV%201',
      'record ids must be escaped, not dropped'
    );
    assert.equal(
      recordPathFor('users', { kind: 'edit', id: 'u-42' }),
      '/settings/users/u-42/edit'
    );
    assert.equal(recordPathFor('users', { kind: 'create' }), '/settings/users/new');
  });

  test('a record id keeps its case while static child screens still win', () => {
    assert.equal(
      resolveInitialTab('/sales/invoices/INV-2026-0001', '', null).record?.kind,
      'detail'
    );
    assert.deepEqual(recordFromPath('/SALES/INVOICES/INV-2026-0001'), {
      tab: 'sales-list',
      record: { kind: 'detail', id: 'INV-2026-0001' },
    });

    assert.equal(tabFromPath('/inventory/assets/assign'), 'assign-asset');
    assert.equal(tabFromPath('/inventory/assets/deployments'), 'asset-deployments');
    assert.equal(tabFromPath('/sales/invoices/new'), 'create-sale');
    assert.equal(tabFromPath('/purchasing/invoices/new'), 'create-purchase');
    assert.equal(tabFromPath('/purchasing/orders/new'), 'create-po');
    assert.equal(tabFromPath('/sales/returns/new'), 'create-sales-return');
    assert.equal(tabFromPath('/purchasing/returns/new'), 'create-purchase-return');
    assert.equal(tabFromPath('/purchasing/shipments/receive'), 'receive-shipment');
    assert.equal(tabFromPath('/inventory/transfers/receive'), 'receive-branch-transfer');
    assert.equal(tabFromPath('/sales/customers/import'), 'import-customers');

    assert.equal(
      resolveInitialTab('/inventory/transfers/receive', '', null).record,
      undefined,
      'a static receive screen must not inherit a transfer record named receive'
    );
    assert.equal(
      resolveInitialTab('/sales/customers/import', '', null).record,
      undefined,
      'a static import screen must not inherit a customer record named import'
    );
  });

  test('unsupported record kinds do not invent a screen', () => {
    assert.equal(recordFromPath('/settings/users/u-42'), null, 'Users has no read-only detail screen');
    assert.equal(recordFromPath('/sales/invoices/INV-1/edit'), null, 'posted invoices are not editable');
    assert.equal(recordFromPath('/inventory/assets/AST-1/edit'), null, 'assets are not edited by URL');
    assert.equal(recordFromPath('/purchasing/orders/PO-1/extra'), null);
  });

  test('canonical URLs preserve the record, not just its register', () => {
    assert.equal(
      canonicalLocationUrl(
        'sales-list',
        { kind: 'detail', id: 'INV-1' },
        'http://localhost/sales/invoices?tab=sales-list&access=exceptions'
      ),
      '/sales/invoices/INV-1'
    );
    assert.equal(
      canonicalLocationUrl(
        'users',
        { kind: 'edit', id: 'u 1' },
        'http://localhost/settings/users?access=exceptions&operation=inv-delete'
      ),
      '/settings/users/u%201/edit?access=exceptions&operation=inv-delete'
    );
    assert.equal(
      canonicalLocationUrl('users', { kind: 'create' }, 'http://localhost/settings/users?access=exceptions'),
      '/settings/users/new?access=exceptions'
    );
    assert.equal(
      canonicalLocationUrl(
        'dashboard',
        { kind: 'detail', id: 'INV-1' },
        'http://localhost/dashboard'
      ),
      '/dashboard',
      'a record that does not belong to this screen cannot leak into its path'
    );
    assert.equal(isRecordRouteForTab('users', { kind: 'create' }), true);
    assert.equal(isRecordRouteForTab('sales-list', { kind: 'create' }), false);
  });

  test('a record path resolves to its tab for Back/Forward', () => {
    assert.equal(tabFromLocation('/purchasing/orders/PO-1', ''), 'po-list');
    assert.equal(tabFromLocation('/settings/users/new', ''), 'users');
    assert.equal(tabFromLocation('/inventory/assets/AST-1', ''), 'fixed-assets');
    assert.equal(tabFromLocation('/sales/returns/CN-1', ''), 'sales-returns');
    assert.equal(tabFromLocation('/purchasing/returns/DN-1', ''), 'purchase-returns');
    assert.equal(tabFromLocation('/purchasing/shipments/TRF-1', ''), 'shipment-list');
    assert.equal(tabFromLocation('/inventory/transfers/receive/TRF-1', ''), 'receive-branch-transfer');
    assert.equal(tabFromLocation('/sales/customers/CUS-1', ''), 'customers');
  });
});

describe('legacy ?tab= links and canonical URLs', () => {
  test('a legacy tab parameter resolves to its screen and is flagged as URL state', () => {
    const route = resolveInitialTab('/', '?tab=sales-list', 'dashboard');
    assert.deepEqual(route, { tab: 'sales-list', fromUrl: true, source: 'legacy-tab' });
    assert.equal(tabFromLegacyTabParam('?tab=sales-list'), 'sales-list');
    assert.equal(tabFromLegacyTabParam('?tab=gone'), null);
  });

  test('a canonical path wins over a conflicting legacy parameter', () => {
    assert.equal(
      resolveInitialTab('/sales/invoices', '?tab=users&access=exceptions', 'dashboard').tab,
      'sales-list'
    );
  });

  test('a root Users filter link still opens Users', () => {
    assert.deepEqual(resolveInitialTab('/', '?access=exceptions&operation=inv-delete', null), {
      tab: 'users',
      fromUrl: true,
      source: 'legacy-filters',
    });
    assert.equal(
      resolveInitialTab('/not-a-screen', '?access=exceptions', 'customers').tab,
      'customers',
      'filter params only imply Users on the root'
    );
  });

  test('saved state supplies the first screen only when the URL does not', () => {
    assert.deepEqual(resolveInitialTab('/', '', 'assign-asset'), {
      tab: 'assign-asset',
      fromUrl: false,
      source: 'saved',
    });
    assert.deepEqual(resolveInitialTab('/', '', 'removed-tab'), {
      tab: 'dashboard',
      fromUrl: false,
      source: 'default',
    });
  });

  test('canonicalisation keeps Users filters and drops them from every other screen', () => {
    assert.equal(
      canonicalTabUrl(
        'users',
        'http://localhost/?tab=users&access=exceptions&operation=inv-delete&view=cards#filters'
      ),
      '/settings/users?access=exceptions&operation=inv-delete&view=cards#filters'
    );
    assert.equal(
      canonicalTabUrl(
        'sales-list',
        'http://localhost/sales/invoices?tab=users&access=exceptions&operation=inv-delete'
      ),
      '/sales/invoices'
    );
    assert.equal(
      canonicalTabUrl('workflow-approval', 'http://localhost/?access=exceptions'),
      '/approvals'
    );
  });

  test('Back/Forward resolves paths and legacy tab entries through the same table', () => {
    assert.equal(tabFromLocation('/finance/ledger/vendors', ''), 'vendor-ledger');
    assert.equal(tabFromLocation('/', '?tab=help-documentation'), 'help-documentation');
    assert.equal(tabFromLocation('/not-a-screen', ''), null);
  });

  test('App writes paths, never the legacy parameter', () => {
    const app = read('client/src/App.tsx');
    const accessFilters = read('client/src/utils/accessFilterUrl.ts');
    assert.match(
      app,
      /canonicalLocationUrl\(activeTab, recordRoute/,
      'App must sync the address bar through the registry, record included'
    );
    assert.match(app, /handleRecordRouteChange/, 'a screen must be able to open/close its record path');
    assert.doesNotMatch(app, /searchParams\.set\(TAB_URL_PARAM/, 'App must not write ?tab=');
    assert.doesNotMatch(
      accessFilters,
      /searchParams\.set\(TAB_URL_PARAM/,
      'the Users filter sync must not stamp ?tab=users'
    );
    assert.match(
      accessFilters,
      /url\.pathname = pathForTab\('users'\)/,
      'the Users filter sync must own its canonical path'
    );
    assert.match(
      accessFilters,
      /recordFromPath\(window\.location\.pathname\)/,
      'the Users filter sync must not close an open record editor'
    );
  });
});
