/**
 * UI/UX high-priority fixes — behaviour, not source shape.
 *
 * The audit found three things a keyboard or phone user could not do:
 *   1. change the company-wide branch/FY view once the header controls hide,
 *   2. keep focus inside a shell overlay while tabbing,
 *   3. open a search result / dashboard card without a mouse.
 *
 * PROVES:
 *   - the mobile drawer renders the same branch/FY scope and forwards changes,
 *   - Global Search and the Notification Center are labelled modal dialogs and
 *     wrap Tab at both ends,
 *   - a search result is a real <button> and activates through its click path,
 *   - the shared row helper activates on Enter/Space but ignores events from
 *     controls nested inside the row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { Sidebar } from '../client/src/components/layout/Sidebar';
import { GlobalSearchModal } from '../client/src/components/common/GlobalSearchModal';
import { NotificationCenter } from '../client/src/components/common/NotificationCenter';
import { api } from '../client/src/services/api';
import { getRowActivationProps } from '../client/src/utils/interactiveRow';

const branches = [
  { id: 'br-hq', code: 'HQ', name: 'Head Office', location: 'Kathmandu', isHeadquarters: true },
  { id: 'br-two', code: 'B2', name: 'Branch Two', location: 'Pokhara' },
] as any[];

const fiscalYears = [
  { id: 'fy-2', code: '2082/83', startDateAD: '2025-07-17', endDateAD: '2026-07-16', isCurrent: true },
  { id: 'fy-1', code: '2081/82', startDateAD: '2024-07-16', endDateAD: '2025-07-16', isClosed: true },
] as any[];

const admin = {
  id: 'u-admin',
  name: 'Admin',
  email: 'admin@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: ['ALL'],
} as any;

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

function buttonByText(container: HTMLElement, pattern: RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((node) =>
    pattern.test((node.textContent || '').trim())
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `expected a button matching ${pattern}`);
  return button;
}

describe('UIX-1 — mobile view scope', () => {
  test('the drawer renders branch and fiscal-year controls and forwards both changes', async () => {
    const selectedBranches: string[] = [];
    const selectedYears: string[] = [];
    const tree = mountTree(
      createElement(Sidebar, {
        companyProfile: null,
        currentUser: admin,
        branches,
        selectedBranchId: 'br-hq',
        onSelectBranch: (id: string) => selectedBranches.push(id),
        fiscalYears,
        selectedFiscalYearId: 'fy-2',
        onSelectFiscalYear: (id: string) => selectedYears.push(id),
        activeTab: 'dashboard',
        onSelectTab: () => {},
        lowStockCount: 0,
        pendingPoCount: 0,
        pendingBillCount: 0,
        inTransitShipmentCount: 0,
        onCloseMobile: () => {},
      } as any)
    );

    try {
      const branchSelect = tree.container.querySelector('#drawer-branch-scope') as HTMLSelectElement | null;
      assert.ok(branchSelect, 'the mobile drawer must render a branch selector');
      assert.equal(branchSelect!.value, 'br-hq');
      assert.deepEqual(
        [...branchSelect!.options].map((option) => option.value),
        ['ALL', 'br-hq', 'br-two'],
        'the drawer must offer the same branch scope as the desktop header'
      );

      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value'
      )!.set!;
      inAct(() => {
        setter.call(branchSelect, 'br-two');
        branchSelect!.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      assert.deepEqual(selectedBranches, ['br-two'], 'branch changes must reach the shell');

      const fyTrigger = buttonByText(tree.container, /2082\/83/);
      inAct(() => fyTrigger.click());
      await settle();
      assert.ok(
        tree.container.querySelector('[role="listbox"]'),
        'the drawer fiscal-year control must open its listbox'
      );
      const olderYear = buttonByText(tree.container, /2081\/82/);
      inAct(() => olderYear.click());
      assert.deepEqual(selectedYears, ['fy-1'], 'fiscal-year changes must reach the shell');
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-2 — shell overlays are modal dialogs', () => {
  test('Global Search is labelled, starts on its input and wraps Tab', async () => {
    const tree = mountTree(
      createElement(GlobalSearchModal, {
        isOpen: true,
        onClose: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        suppliers: [],
        branches: [],
        selectedBranchId: 'ALL',
        onSelectResult: () => {},
      })
    );

    try {
      await settle();
      const dialog = tree.container.querySelector('[role="dialog"]') as HTMLElement | null;
      assert.ok(dialog, 'the overlay must expose role=dialog');
      assert.equal(dialog!.getAttribute('aria-modal'), 'true');
      const labelId = dialog!.getAttribute('aria-labelledby') || '';
      assert.ok(labelId, 'the dialog needs an accessible name');
      assert.match(document.getElementById(labelId)?.textContent || '', /Global search/);

      const input = dialog!.querySelector('input') as HTMLInputElement;
      assert.equal(document.activeElement, input, 'focus must enter the dialog on open');

      const close = dialog!.querySelector(
        'button[aria-label="Close global search"]'
      ) as HTMLButtonElement | null;
      assert.ok(close, 'the close control needs an accessible name');

      inAct(() => {
        input.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
        );
      });
      assert.equal(document.activeElement, close, 'Shift+Tab on the first control wraps to the last');

      inAct(() => {
        close!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      });
      assert.equal(document.activeElement, input, 'Tab on the last control wraps to the first');
    } finally {
      tree.unmount();
    }
  });

  test('the Notification Center is a labelled drawer and traps focus', async () => {
    const tree = mountTree(
      createElement(NotificationCenter, {
        isOpen: true,
        onClose: () => {},
        alerts: [],
        onSelectTab: () => {},
      } as any)
    );

    try {
      await settle();
      const dialog = tree.container.querySelector('[role="dialog"]') as HTMLElement | null;
      assert.ok(dialog, 'the drawer must expose role=dialog');
      assert.equal(dialog!.getAttribute('aria-modal'), 'true');
      const labelId = dialog!.getAttribute('aria-labelledby') || '';
      assert.match(
        document.getElementById(labelId)?.textContent || '',
        /Notification Center/,
        'the dialog must be named by its visible heading'
      );

      const close = dialog!.querySelector(
        'button[aria-label="Close notifications"]'
      ) as HTMLButtonElement | null;
      assert.ok(close);
      assert.equal(document.activeElement, close, 'focus must start on the drawer close control');

      const last = [...dialog!.querySelectorAll('button')].at(-1) as HTMLButtonElement;
      inAct(() => {
        last.focus();
        last.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
        );
      });
      assert.equal(document.activeElement, close, 'Tab on the last control wraps to the first');
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-3 — clickable results and rows are keyboard operable', () => {
  test('a global-search result card is a native button that follows the click path', async () => {
    const original = api.searchGlobal;
    const selected: Array<[string, string | undefined]> = [];
    api.searchGlobal = (async () => ({
      query: 'router',
      results: {
        products: [
          {
            id: 'p-1',
            name: 'Warranty Router',
            sku: 'RTR-1',
            category: 'Routers',
            sellingPrice: 100,
            stockQty: 3,
            unit: 'Pcs',
          },
        ],
        purchaseOrders: [],
        invoices: [],
        shipments: [],
        assets: [],
        customerDevices: [],
      },
      total: 1,
      limit: 10,
    })) as any;

    const tree = mountTree(
      createElement(GlobalSearchModal, {
        isOpen: true,
        onClose: () => {},
        searchQuery: 'router',
        onSearchChange: () => {},
        suppliers: [],
        branches: [],
        selectedBranchId: 'ALL',
        onSelectResult: (tab: string, text?: string) => selected.push([tab, text]),
      } as any)
    );

    try {
      await settle(320);
      const result = buttonByText(tree.container, /Warranty Router/);
      assert.equal(result.tagName, 'BUTTON', 'a result must be focusable as a real button');
      inAct(() => result.click());
      assert.deepEqual(selected, [['all-stock', 'RTR-1']], 'activation must run the normal result path');
    } finally {
      tree.unmount();
      api.searchGlobal = original;
    }
  });

  test('row activation handles Enter/Space but ignores events from nested controls', () => {
    let activations = 0;
    const props = getRowActivationProps(() => {
      activations += 1;
    }, 'Low stock row', true);
    assert.equal(props.tabIndex, 0, 'rows need an explicit tab stop');
    assert.equal(props['aria-expanded'], true);

    const row = document.createElement('tr');
    const fire = (key: string, target: HTMLElement) => {
      let prevented = false;
      props.onKeyDown!({
        key,
        target,
        currentTarget: row,
        preventDefault: () => {
          prevented = true;
        },
      } as any);
      return prevented;
    };

    assert.equal(fire('Enter', row), true, 'Enter must activate the row and prevent scrolling');
    assert.equal(fire(' ', row), true, 'Space must activate the row');
    assert.equal(activations, 2);

    const nestedButton = document.createElement('button');
    fire('Enter', nestedButton);
    assert.equal(activations, 2, 'a nested control must not trigger the row twice');
  });
});
