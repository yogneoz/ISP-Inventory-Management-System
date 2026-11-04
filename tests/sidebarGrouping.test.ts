/**
 * Sidebar information architecture — the eight-group navigation restructure.
 *
 * PROVES:
 *   1. Eight domain groups, in work order, each with its own visible sections
 *      and items (Super Admin view).
 *   2. No tab has two homes: a duplicate would mark two rows current.
 *   3. Branch Operations is gone; its items are inventory registers/forms,
 *      Create Sales Invoice is the only counter-sale form and Device Exchange
 *      sits under Sales Forms.
 *   4. Permission filtering never leaves an empty section heading (Auditor has
 *      no Procurement "Forms"; Front Desk has no Inventory "Reports").
 *   5. Multi-open groups: opening one leaves the others alone, the header
 *      expands or collapses every group, and navigating only adds the active
 *      page's group.
 *   6. Menu search subtitles name Group · Section.
 *   7. The open-group set persists across remounts, including Collapse all;
 *      a first visit opens the active page's group.
 *   8. Stored ids for groups the current menu cannot render are ignored and
 *      healed; an all-stale set falls back to the active page's group.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, StrictMode } from 'react';
import { mountTree, inAct } from './harness/mount';
import {
  Sidebar,
  SIDEBAR_OPEN_GROUPS_STORAGE_KEY,
} from '../client/src/components/layout/Sidebar';

const admin = {
  id: 'u-admin', name: 'Admin', email: 'admin@example.com', role: 'SUPER_ADMIN',
  branchId: 'ALL', allowedBranchIds: ['ALL'],
} as any;
const auditor = {
  id: 'u-aud', name: 'Auditor', email: 'auditor@example.com', role: 'AUDITOR',
  branchId: 'ALL', allowedBranchIds: ['ALL'],
} as any;
const frontDesk = {
  id: 'u-fd', name: 'Front Desk', email: 'fd@example.com', role: 'FRONT_DESK', branchId: 'br-a',
} as any;

beforeEach(() => {
  localStorage.removeItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY);
});

const base = {
  companyProfile: null,
  currentUser: null,
  branches: [],
  selectedBranchId: 'ALL',
  onSelectBranch: () => {},
  fiscalYears: [],
  selectedFiscalYearId: '',
  onSelectFiscalYear: () => {},
  lowStockCount: 0,
  pendingPoCount: 0,
  pendingBillCount: 0,
  inTransitShipmentCount: 0,
  onSelectTab: () => {},
  onCloseMobile: () => {},
};

function render(user: any, activeTab = 'dashboard') {
  return mountTree(
    createElement(Sidebar, { ...base, currentUser: user, activeTab: activeTab as any } as any)
  );
}

function groupButton(tree: ReturnType<typeof render>, id: string): HTMLButtonElement {
  const button = tree.container.querySelector(`#nav-group-button-${id}`) as HTMLButtonElement | null;
  assert.ok(button, `group ${id} must render a header`);
  return button;
}

function readGroup(tree: ReturnType<typeof render>, id: string) {
  const button = groupButton(tree, id);
  // Opening another group closes this one, so re-open only when collapsed —
  // clicking an already-open group would collapse it before we can read it.
  if (button.getAttribute('aria-expanded') !== 'true') {
    inAct(() => button.click());
  }
  const wrapper = tree.container.querySelector(`[data-nav-group="${id}"]`) as HTMLElement;
  const sections: string[] = [];
  const items: Array<{ id: string; section: string | null }> = [];
  let current: string | null = null;
  for (const node of wrapper.querySelectorAll('[data-nav-section],[data-nav-item]')) {
    if (node.hasAttribute('data-nav-section')) {
      current = node.getAttribute('data-nav-section');
      sections.push(current!);
    } else {
      items.push({ id: node.getAttribute('data-nav-item')!, section: current });
    }
  }
  return { sections, items };
}

const EXPECTED: Record<string, { sections: string[]; items: string[] }> = {
  dashboard: {
    sections: [],
    items: ['dashboard', 'approvals'],
  },
  inventory: {
    sections: ['Registers', 'Forms', 'Reports & exports'],
    items: [
      'all-stock', 'branch-stock', 'stock-ledger', 'complete-serial-inventory',
      'damaged-stock', 'consumables-register', 'damage-report', 'asset-deployments',
      'consumable-issue', 'damage', 'assign-asset', 'physical-stock-audit',
      'reorder-stock', 'import-stock',
      'stock-valuation', 'export-stock',
    ],
  },
  procurement: {
    sections: ['Forms', 'Registers'],
    items: [
      'create-po', 'create-purchase', 'create-purchase-return',
      'po-list', 'purchase-list', 'purchase-returns', 'supplier-warranty',
    ],
  },
  sales: {
    sections: ['Forms', 'Registers'],
    items: [
      'create-sale', 'create-sales-return', 'device-exchange',
      'sales-list', 'sales-returns', 'customer-devices', 'seller-warranty',
    ],
  },
  logistics: {
    sections: ['Dispatch & transfers', 'Receiving & reports'],
    items: [
      'create-shipment', 'create-transfer', 'pullout',
      'receive-shipment', 'receive-branch-transfer', 'shipment-list', 'pullout-report',
    ],
  },
  finance: {
    sections: ['Statements & ledgers', 'Tax & assets'],
    items: [
      'accounting', 'accounting-profit-loss', 'accounting-balance-sheet', 'accounting-cash-book',
      'accounting-aging',
      'cash-position', 'financial-statements', 'vendor-ledger', 'customer-ledger', 'vendor-opening-balances',
      'vat-register', 'fixed-assets', 'depreciation-register',
    ],
  },
  'inventory-setup': {
    sections: ['Accounting', 'Products', 'Parties', 'Organisation'],
    items: [
      'accounting-chart', 'bill-terms', 'cost-centers', 'narration-templates', 'fiscal-year-management',
      'product-master', 'category-management', 'product-group-management', 'uom-management',
      'customers', 'sales-agents-areas', 'import-customers', 'suppliers',
      'locations', 'branches',
    ],
  },
  admin: {
    sections: ['Setup', 'Governance'],
    items: [
      'company-setup', 'users', 'permissions', 'user-permissions',
      'fiscal-year-closing', 'bs-calendar',
      'audit', 'data-recalculation', 'clear-demo-data',
    ],
  },
};

describe('sidebar grouping', () => {
  test('eight domain groups render in work order, each with its sections and items', () => {
    const tree = render(admin);
    try {
      const wrappers = [...tree.container.querySelectorAll('[data-nav-group]')];
      assert.deepEqual(
        wrappers.map((node) => node.getAttribute('data-nav-group')),
        Object.keys(EXPECTED),
        'group order must match the documented layout'
      );
      for (const [id, expected] of Object.entries(EXPECTED)) {
        const actual = readGroup(tree, id);
        assert.deepEqual(actual.sections, expected.sections, `${id}: sections`);
        assert.deepEqual(actual.items.map((item) => item.id), expected.items, `${id}: items`);
      }
    } finally {
      tree.unmount();
    }
  });

  test('no tab has two homes', () => {
    const tree = render(admin);
    try {
      const ids: string[] = [];
      for (const id of Object.keys(EXPECTED)) {
        ids.push(...readGroup(tree, id).items.map((item) => item.id));
      }
      const duplicates = [...new Set(ids.filter((id, idx) => ids.indexOf(id) !== idx))];
      assert.deepEqual(duplicates, [], `duplicated nav destinations: ${duplicates.join(', ')}`);
    } finally {
      tree.unmount();
    }
  });

  test('Branch Operations is gone and its tasks sit beside their domain peers', () => {
    const tree = render(admin);
    try {
      const titles = [...tree.container.querySelectorAll('[data-nav-group] button')].map(
        (node) => node.getAttribute('title') || ''
      );
      assert.equal(titles.includes('Branch Operations'), false, 'Branch Operations must not survive');
      assert.equal(titles.includes('Purchase Returns'), false, 'purchase returns belongs inside Procurement');

      const inventory = readGroup(tree, 'inventory');
      assert.deepEqual(
        inventory.items.filter((item) =>
          ['asset-deployments', 'consumable-issue', 'damage', 'assign-asset'].includes(item.id)
        ),
        [
          { id: 'asset-deployments', section: 'Registers' },
          { id: 'consumable-issue', section: 'Forms' },
          { id: 'damage', section: 'Forms' },
          { id: 'assign-asset', section: 'Forms' },
        ],
        'consumables, damage and asset assignment are stock actions, not a location menu'
      );

      const procurement = readGroup(tree, 'procurement');
      assert.equal(
        procurement.items.find((item) => item.id === 'purchase-returns')?.section,
        'Registers'
      );

      const sales = readGroup(tree, 'sales');
      assert.equal(sales.items.find((item) => item.id === 'create-sale')?.section, 'Forms');
      assert.equal(sales.items.find((item) => item.id === 'device-exchange')?.section, 'Forms');
      assert.equal(
        sales.items.some((item) => item.id === 'stock-out'),
        false,
        'the retired Product Sale screen must not keep a menu entry'
      );
    } finally {
      tree.unmount();
    }
  });

  test('permission filtering never leaves an empty section heading', () => {
    const tree = render(auditor, 'audit');
    try {
      // Auditor: read-only procurement, so "Forms" would be a heading over nothing.
      const procurement = readGroup(tree, 'procurement');
      assert.deepEqual(procurement.sections, ['Registers']);
      assert.deepEqual(
        procurement.items.map((item) => item.id),
        ['po-list', 'purchase-list', 'supplier-warranty']
      );

      // Auditor: no users/branches/fiscal setup, so Administration is the trail only.
      const adminGroup = readGroup(tree, 'admin');
      assert.deepEqual(adminGroup.sections, ['Governance']);
      assert.deepEqual(adminGroup.items.map((item) => item.id), ['audit']);
    } finally {
      tree.unmount();
    }
  });

  test('branch roles see a shorter stock group with no empty sections', () => {
    const tree = render(frontDesk, 'branch-stock');
    try {
      const inventory = readGroup(tree, 'inventory');
      assert.deepEqual(inventory.sections, ['Registers', 'Forms']);
      assert.deepEqual(inventory.items.map((item) => item.id), [
        'branch-stock',
        'stock-ledger',
        'complete-serial-inventory',
        'damaged-stock',
        'consumables-register',
        'damage-report',
        'consumable-issue',
        'physical-stock-audit',
        'reorder-stock',
      ]);

      // Front Desk is paid no finance, admin or product-setup access.
      assert.equal(tree.container.querySelector('[data-nav-group="finance"]'), null);
      assert.equal(tree.container.querySelector('[data-nav-group="admin"]'), null);

      const procurement = readGroup(tree, 'procurement');
      assert.deepEqual(procurement.items.map((item) => item.id), [
        'create-po',
        'po-list',
        'purchase-list',
        'supplier-warranty',
      ]);
      assert.equal(procurement.items.some((item) => item.id === 'suppliers'), false);

      const setup = readGroup(tree, 'inventory-setup');
      assert.deepEqual(setup.sections, ['Products', 'Parties', 'Organisation']);
      assert.deepEqual(setup.items.map((item) => item.id), [
        'product-master',
        'customers',
        'sales-agents-areas',
        'locations',
      ]);
    } finally {
      tree.unmount();
    }
  });

  test('groups open independently and the header expands or collapses all of them', () => {
    const tree = render(admin, 'dashboard');
    const openHeaders = () =>
      tree.container.querySelectorAll('[data-nav-group] button[aria-expanded="true"]').length;
    const allGroups = tree.container.querySelectorAll('[data-nav-group]');
    const expandAll = tree.container.querySelector(
      'button[aria-label="Expand all menu groups"]'
    ) as HTMLButtonElement;
    const collapseAll = tree.container.querySelector(
      'button[aria-label="Collapse all menu groups"]'
    ) as HTMLButtonElement;

    try {
      assert.ok(expandAll, 'the header offers Expand all');
      assert.ok(collapseAll, 'the header offers Collapse all');
      assert.equal(openHeaders(), 1, 'the active page group starts open');

      inAct(() => groupButton(tree, 'inventory').click());
      assert.equal(groupButton(tree, 'inventory').getAttribute('aria-expanded'), 'true');
      assert.equal(
        groupButton(tree, 'dashboard').getAttribute('aria-expanded'),
        'true',
        'opening Inventory must not close Overview'
      );
      assert.equal(openHeaders(), 2, 'groups open independently');

      inAct(() => groupButton(tree, 'procurement').click());
      assert.equal(openHeaders(), 3);

      inAct(() => groupButton(tree, 'inventory').click());
      assert.equal(openHeaders(), 2, 'closing one group leaves the others open');

      inAct(() => expandAll.click());
      assert.equal(openHeaders(), allGroups.length, 'Expand all opens every visible group');
      assert.equal(expandAll.disabled, true, 'Expand all is inert once everything is open');
      assert.equal(collapseAll.disabled, false);

      inAct(() => collapseAll.click());
      assert.equal(openHeaders(), 0, 'Collapse all closes every group');
      assert.equal(collapseAll.disabled, true);
      assert.equal(expandAll.disabled, false);

      // Navigating opens the destination group without resetting the rail.
      tree.rerender(createElement(Sidebar, { ...base, currentUser: admin, activeTab: 'purchase-list' } as any));
      assert.equal(groupButton(tree, 'procurement').getAttribute('aria-expanded'), 'true');
      assert.equal(openHeaders(), 1);

      inAct(() => groupButton(tree, 'inventory').click());
      tree.rerender(createElement(Sidebar, { ...base, currentUser: admin, activeTab: 'sales-list' } as any));
      assert.equal(groupButton(tree, 'sales').getAttribute('aria-expanded'), 'true');
      assert.equal(
        groupButton(tree, 'inventory').getAttribute('aria-expanded'),
        'true',
        'navigation adds the destination group instead of replacing the set'
      );
      assert.equal(openHeaders(), 3);
    } finally {
      tree.unmount();
    }
  });

  test('the open-group set survives a remount', () => {
    let tree = render(admin, 'dashboard');
    try {
      inAct(() => groupButton(tree, 'inventory').click());
      assert.deepEqual(
        new Set(JSON.parse(localStorage.getItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY) || '[]')),
        new Set(['dashboard', 'inventory']),
        'opening a group writes the whole set, not just the new id'
      );
    } finally {
      tree.unmount();
    }

    tree = render(admin, 'dashboard');
    try {
      assert.equal(groupButton(tree, 'dashboard').getAttribute('aria-expanded'), 'true');
      assert.equal(groupButton(tree, 'inventory').getAttribute('aria-expanded'), 'true');
      assert.equal(
        tree.container.querySelectorAll('[data-nav-group] button[aria-expanded="true"]').length,
        2,
        'the remounted rail restores both open groups'
      );
    } finally {
      tree.unmount();
    }
  });

  test('Collapse all persists an empty set across a remount', () => {
    let tree = render(admin, 'dashboard');
    try {
      const collapseAll = tree.container.querySelector(
        'button[aria-label="Collapse all menu groups"]'
      ) as HTMLButtonElement;
      inAct(() => collapseAll.click());
      assert.equal(
        localStorage.getItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY),
        '[]',
        'an explicit Collapse all is stored, not treated as first visit'
      );
    } finally {
      tree.unmount();
    }

    tree = render(admin, 'dashboard');
    try {
      assert.equal(
        tree.container.querySelectorAll('[data-nav-group] button[aria-expanded="true"]').length,
        0,
        'the stored empty set wins over the first-visit default'
      );

      // The permission matrix arriving after bootstrap is not navigation, and
      // must not reopen the active group over a persisted Collapse all.
      tree.rerender(
        createElement(Sidebar, {
          ...base,
          currentUser: admin,
          activeTab: 'dashboard',
          permissionsVersion: 1,
        } as any)
      );
      assert.equal(
        tree.container.querySelectorAll('[data-nav-group] button[aria-expanded="true"]').length,
        0,
        'a permissions refresh leaves the collapsed rail collapsed'
      );
    } finally {
      tree.unmount();
    }
  });

  test('StrictMode keeps the stored set, and malformed storage falls back', () => {
    localStorage.setItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY, '[]');
    const strict = mountTree(
      createElement(
        StrictMode,
        null,
        createElement(Sidebar, { ...base, currentUser: admin, activeTab: 'dashboard' } as any)
      )
    );
    try {
      assert.equal(
        strict.container.querySelectorAll('[data-nav-group] button[aria-expanded="true"]').length,
        0,
        'the double-invoked mount effect must not re-open the active group'
      );
    } finally {
      strict.unmount();
    }

    localStorage.setItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY, '{not json');
    const fallback = render(admin, 'dashboard');
    try {
      assert.equal(groupButton(fallback, 'dashboard').getAttribute('aria-expanded'), 'true');
      assert.equal(
        fallback.container.querySelectorAll('[data-nav-group] button[aria-expanded="true"]').length,
        1,
        'a first visit falls back to the active page group'
      );
    } finally {
      fallback.unmount();
    }
  });

  test('stored ids for groups that no longer exist are ignored and healed', () => {
    localStorage.setItem(
      SIDEBAR_OPEN_GROUPS_STORAGE_KEY,
      JSON.stringify(['dashboard', 'sales', 'removed-group'])
    );
    const tree = render(admin, 'dashboard');
    try {
      const open = tree.container.querySelectorAll(
        '[data-nav-group] button[aria-expanded="true"]'
      );
      assert.equal(open.length, 2, 'only the two real groups reopen');
      assert.equal(groupButton(tree, 'dashboard').getAttribute('aria-expanded'), 'true');
      assert.equal(groupButton(tree, 'sales').getAttribute('aria-expanded'), 'true');
      assert.deepEqual(
        JSON.parse(localStorage.getItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY) || 'null'),
        ['dashboard', 'sales'],
        'the mount-time persist rewrites storage without the stale id'
      );
    } finally {
      tree.unmount();
    }
  });

  test('a role cannot restore a group its menu does not render', () => {
    // The admin group is hidden from Front Desk, so an admin id saved by a
    // previous (wider) profile must not leave the rail looking empty.
    localStorage.setItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY, JSON.stringify(['admin']));
    const tree = render(frontDesk, 'dashboard');
    try {
      assert.equal(
        tree.container.querySelector('[data-nav-group="admin"]'),
        null,
        'Front Desk has no admin group to restore'
      );
      assert.equal(
        tree.container.querySelectorAll('[data-nav-group] button[aria-expanded="true"]').length,
        1,
        'an all-stale set falls back to the active page group'
      );
      assert.equal(groupButton(tree, 'dashboard').getAttribute('aria-expanded'), 'true');
      assert.deepEqual(
        JSON.parse(localStorage.getItem(SIDEBAR_OPEN_GROUPS_STORAGE_KEY) || 'null'),
        ['dashboard'],
        'storage heals to the visible fallback'
      );
    } finally {
      tree.unmount();
    }
  });

  test('menu search subtitles name the group and section', () => {
    const tree = render(admin);
    try {
      const input = tree.container.querySelector(
        'input[placeholder^="Search menu"]'
      ) as HTMLInputElement;
      assert.ok(input, 'the menu search input renders');
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!;
      inAct(() => {
        setValue.call(input, 'exchange');
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });

      const text = tree.container.textContent || '';
      assert.match(text, /Device Exchange & Replacement/);
      assert.match(text, /Sales & Customers · Forms/);
    } finally {
      tree.unmount();
    }
  });
});
