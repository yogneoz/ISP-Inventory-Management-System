/**
 * UI/UX low-priority fixes — the last three audit findings.
 *
 * PROVES (UIX-10/11/12):
 *   - the dashboard's low-stock hint wraps with a real gap instead of letting
 *     "Requires Action" collide into "View Reorder",
 *   - both ends of the warranty start-date range render as ONE filter group
 *     (labels bound to their inputs), so a narrow card wraps the pair together,
 *   - the fiscal-year trigger shows a status dot instead of the clipped
 *     "(Active)" suffix, while still naming the active year to a screen reader,
 *   - closing global search without picking a result restores the previously
 *     applied text; picking a result commits it.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement as h, useState } from 'react';
import { mountTree } from './harness/mount';
import { DarkModeProvider } from '../client/src/contexts/DarkModeContext';
import { AppShell } from '../client/src/components/layout/AppShell';
import { FiscalYearSelect } from '../client/src/components/common/FiscalYearSelect';
import { WarrantyRegister } from '../client/src/features/inventory/warranty/WarrantyRegister';
import { Dashboard } from '../client/src/features/dashboard/Dashboard';
import { api } from '../client/src/services/api';

const user = {
  id: 'u-low',
  email: 'low@example.com',
  name: 'Low Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: ['ALL'],
} as any;

const branches = [{ id: 'b1', code: 'B1', name: 'Main Branch', location: 'Kathmandu' }] as any[];

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('UIX-10 — the low-stock hint cannot collide', () => {
  const originalLogs = api.getTransactionLogs;
  const originalAssets = api.getFixedAssetOverview;
  const originalShipments = api.getShipmentOverview;

  beforeEach(() => {
    api.getTransactionLogs = (async () => ({ data: [], totalItems: 0 })) as any;
    api.getFixedAssetOverview = (async () => ({
      total: 0,
      counts: {},
      totals: { acquisitionCost: 0, accumulatedDepreciation: 0, netBookValue: 0 },
      closing: {
        activeCount: 0,
        annualDepreciation: 0,
        missingRateCount: 0,
        missingRateTags: [],
      },
    })) as any;
    api.getShipmentOverview = (async () => ({
      counts: {},
      total: 0,
      pending: [],
      recent: [],
      pendingCapped: false,
      scope: 'ALL',
    })) as any;
  });

  afterEach(() => {
    api.getTransactionLogs = originalLogs;
    api.getFixedAssetOverview = originalAssets;
    api.getShipmentOverview = originalShipments;
  });

  test('the hint row wraps with a gap and does not rely on justify-between', async () => {
    const tree = mountTree(
      h(Dashboard, {
        currentUser: user,
        products: [],
        stock: [],
        branches,
        pendingPurchaseOrders: [],
        financialSummary: {} as any,
        categories: [],
        selectedBranchId: 'ALL',
        dateMode: 'AD',
        onNavigateTab: () => {},
      } as any)
    );

    try {
      await settle();
      const label = [...tree.container.querySelectorAll('span')].find(
        (span) => (span.textContent || '').trim() === 'Requires Action'
      );
      assert.ok(label, 'the low-stock card must render its hint');
      const row = label!.parentElement as HTMLElement;
      assert.match(row.className, /\bflex-wrap\b/, 'the hint row must be allowed to wrap');
      assert.match(row.className, /\bgap-x-2\b/, 'wrapped hint text needs a real horizontal gap');
      assert.doesNotMatch(
        row.className,
        /\bjustify-between\b/,
        'justify-between alone is what let the two labels collide'
      );
      const view = [...row.children].find((child) =>
        /View Reorder/.test(child.textContent || '')
      ) as HTMLElement;
      assert.ok(view, 'the reorder affordance must stay in the hint');
      assert.match(view.className, /\bwhitespace-nowrap\b/);
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-12 — the fiscal-year trigger names the year without clipping', () => {
  test('an active year renders a dot and keeps the full code visible', () => {
    const tree = mountTree(
      h(FiscalYearSelect, {
        fiscalYears: [
          {
            id: 'fy1',
            code: '2083-84',
            name: '2083/84',
            startDateAD: '2026-04-14',
            endDateAD: '2027-04-13',
            isCurrent: true,
            isClosed: false,
          } as any,
        ],
        value: 'fy1',
        onChange: () => {},
      })
    );

    try {
      const trigger = tree.container.querySelector('button') as HTMLButtonElement;
      assert.ok(trigger, 'the fiscal-year selector must render a trigger');
      assert.match(trigger.textContent || '', /2083-84/);
      assert.doesNotMatch(
        trigger.textContent || '',
        /\(Active\)/,
        'the clipped " (Active)" suffix must not render as text'
      );
      const dot = trigger.querySelector('[title="Active fiscal year"]');
      assert.ok(dot, 'the active status must render as a labelled dot');
      assert.equal(dot!.querySelector('.rounded-full')?.getAttribute('aria-hidden'), 'true');
      assert.match(trigger.textContent || '', /active/i, 'screen readers must still hear the status');
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-11 — the warranty start range is one filter group', () => {
  const originalVendor = api.fetchVendorWarranties;
  const originalSeller = api.fetchSellerWarranties;

  beforeEach(() => {
    const empty = async () => ({
      data: [],
      totalItems: 0,
      counts: { total: 0, valid: 0, expiring: 0, expired: 0 },
    });
    api.fetchVendorWarranties = empty as any;
    api.fetchSellerWarranties = empty as any;
  });

  afterEach(() => {
    api.fetchVendorWarranties = originalVendor;
    api.fetchSellerWarranties = originalSeller;
  });

  test('both date fields and labels share one wrapping group', async () => {
    const tree = mountTree(
      h(WarrantyRegister, {
        coverageType: 'VENDOR',
        selectedBranchId: 'ALL',
        dateMode: 'AD',
        currentUser: user,
      } as any)
    );

    try {
      await settle();
      const group = tree.container.querySelector(
        '[role="group"][aria-label="Warranty start date range"]'
      ) as HTMLElement | null;
      assert.ok(group, 'the range must be a single labelled group');
      assert.match(group!.className, /\bflex\b/);

      const from = group!.querySelector('#warranty-filter-from') as HTMLElement | null;
      const to = group!.querySelector('#warranty-filter-to') as HTMLElement | null;
      assert.ok(from && to, 'both ends of the range must sit inside the group');
      assert.ok(
        group!.querySelector('label[for="warranty-filter-from"]'),
        'the start input must have its own bound label'
      );
      assert.ok(
        group!.querySelector('label[for="warranty-filter-to"]'),
        'the end input must have its own bound label'
      );
      assert.ok(
        from!.compareDocumentPosition(to!) & window.Node.DOCUMENT_POSITION_FOLLOWING,
        'the range must render start then end, adjacent in one unit'
      );
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-12 — global search only keeps a picked query', () => {
  const originalSearch = api.searchGlobal;

  beforeEach(() => {
    api.searchGlobal = (async () => ({
      results: {
        products: [],
        purchaseOrders: [],
        invoices: [],
        shipments: [],
        assets: [],
        customerDevices: [],
      },
    })) as any;
  });

  afterEach(() => {
    api.searchGlobal = originalSearch;
  });

  const shellProps = {
    companyProfile: null,
    currentUser: user,
    rootUser: null,
    users: [user],
    onSwitchBackToRoot: async () => {},
    onSwitchProfile: async () => {},
    onUpdateProfile: async () => {},
    onLogout: () => {},
    onLogin: async () => {},
    refreshAllData: () => {},
    permissionsVersion: 0,
    onToggleTheme: () => {},
    branches,
    selectedBranchId: 'ALL',
    onSelectBranch: () => {},
    dateMode: 'AD',
    onToggleDateMode: () => {},
    currentFiscalYear: '2083/84',
    fiscalYears: [],
    selectedFiscalYearId: '',
    onSelectFiscalYear: () => {},
    activeTab: 'dashboard',
    products: [],
    stock: [],
    purchaseOrders: [],
    purchaseInvoices: [],
    pendingPurchaseOrders: [],
    unpaidBillCount: 0,
    shipments: [],
    stockOperations: [],
    approvalRequests: [],
    suppliers: [
      {
        id: 'sup-1',
        name: 'ONU Supplier',
        code: 'SUP-1',
        contactPerson: 'Ram',
        phone: '9800000000',
        panVatNumber: '123',
      },
    ],
    bsCalendarCoverage: null,
    bsCalendarSeedTab: 'bs-calendar',
    banners: null,
    children: h('main', null, 'workspace'),
  } as any;

  function SearchShell({ onSelectTab }: { onSelectTab: (tab: any) => void }) {
    const [query, setQuery] = useState('');
    return h(AppShell, {
      ...shellProps,
      searchQuery: query,
      onSearchChange: setQuery,
      onSelectTab,
    });
  }

  test('closing without a pick restores the applied text; closing after a pick keeps it', async () => {
    const tabs: string[] = [];
    const tree = mountTree(
      h(
        DarkModeProvider,
        null,
        h(SearchShell, { onSelectTab: (tab: string) => tabs.push(tab) })
      )
    );

    try {
      await settle();
      const header = tree.container.querySelector(
        'input[data-shell-trigger="search"]'
      ) as HTMLInputElement;
      assert.ok(header, 'the header must expose the global-search input');

      // Type, then dismiss with the X: the launcher draft is not a filter.
      setInputValue(header, 'ONU');
      await settle();
      const modalInput = tree.container.querySelector(
        'input[aria-label="Search products and records"]'
      ) as HTMLInputElement | null;
      assert.ok(modalInput, 'typing in the header must open global search');
      const close = tree.container.querySelector(
        'button[aria-label="Close global search"]'
      ) as HTMLButtonElement;
      act(() => close.click());
      await settle();
      assert.equal(header.value, '', 'an unpicked launcher query must not linger in the header');
      assert.equal(
        tree.container.querySelector('input[aria-label="Search products and records"]'),
        null,
        'the dialog must actually close'
      );

      // Type and pick a result: the query is an applied filter and survives.
      setInputValue(header, 'ONU');
      await settle();
      const viewSuppliers = [...tree.container.querySelectorAll('button')].find((button) =>
        /View Suppliers/.test(button.textContent || '')
      ) as HTMLButtonElement | undefined;
      assert.ok(viewSuppliers, 'the matched supplier group must be pickable');
      act(() => viewSuppliers!.click());
      await settle();
      assert.equal(tabs.at(-1), 'suppliers', 'picking a result must navigate');
      assert.equal(header.value, 'ONU', 'a picked query must stay applied');

      // Reopen a committed search and dismiss it: the applied filter stays.
      act(() => header.click());
      await settle();
      const closeAgain = tree.container.querySelector(
        'button[aria-label="Close global search"]'
      ) as HTMLButtonElement;
      act(() => closeAgain.click());
      await settle();
      assert.equal(header.value, 'ONU', 'dismissing a committed search must not clear the filter');
    } finally {
      tree.unmount();
    }
  });
});
