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
 *   5. Single-open accordion: opening a group closes the previous one, clicking
 *      the open group collapses the rail, and the header control restores the
 *      current page's group.
 *   6. Menu search subtitles name Group · Section.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { Sidebar } from '../client/src/components/layout/Sidebar';

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
      'financial-statements', 'vendor-ledger', 'customer-ledger', 'vendor-opening-balances',
      'vat-register', 'fixed-assets', 'depreciation-register',
    ],
  },
  'inventory-setup': {
    sections: ['Products', 'Parties', 'Organisation'],
    items: [
      'product-master', 'category-management', 'product-group-management', 'uom-management',
      'customers', 'import-customers', 'suppliers',
      'locations', 'branches',
    ],
  },
  admin: {
    sections: ['Setup', 'Governance'],
    items: [
      'company-setup', 'users', 'permissions', 'fiscal-year-management',
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
        'locations',
      ]);
    } finally {
      tree.unmount();
    }
  });

  test('single-open accordion keeps one group open and restores it from the header', () => {
    const tree = render(admin, 'dashboard');
    const openHeaders = () =>
      tree.container.querySelectorAll('[data-nav-group] button[aria-expanded="true"]').length;
    try {
      assert.equal(openHeaders(), 1, 'the active page group starts open');

      inAct(() => groupButton(tree, 'inventory').click());
      assert.equal(groupButton(tree, 'inventory').getAttribute('aria-expanded'), 'true');
      assert.equal(groupButton(tree, 'dashboard').getAttribute('aria-expanded'), 'false');
      assert.equal(openHeaders(), 1, 'opening Inventory must close Overview');

      inAct(() => groupButton(tree, 'inventory').click());
      assert.equal(openHeaders(), 0, 'clicking the open group collapses the rail');

      const expand = tree.container.querySelector(
        'button[title="Expand the menu group for the current page"]'
      ) as HTMLButtonElement | null;
      assert.ok(expand, 'header control must offer to restore the active page group');
      inAct(() => expand!.click());
      assert.equal(groupButton(tree, 'dashboard').getAttribute('aria-expanded'), 'true');

      const collapse = tree.container.querySelector(
        'button[title="Collapse the open menu group"]'
      ) as HTMLButtonElement | null;
      assert.ok(collapse, 'header control must offer to collapse');
      inAct(() => collapse!.click());
      assert.equal(openHeaders(), 0);
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
