/**
 * A6 — route-tree smoke test.
 *
 * Renders the real App (shell + KeepMounted tab tree) with the api stubbed and
 * proves the contract every root refactor depends on: a tab switch HIDES the
 * screen, it never unmounts it, and local form state survives the round trip.
 * This is the behavioural gate A3/A4 were missing; it fails if a screen
 * remounts on tab switch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '../client/src/types';
import { inAct } from './harness/mount';
import {
  findInputByPlaceholder,
  installApiStubs,
  installEventSource,
  isHidden,
  mountAppRouteTree,
  navigateTab,
  seedSession,
  setInputValue,
  settle,
  settleUntil,
} from './harness/appRouteTreeProbe';

const PRODUCT_SEARCH_PLACEHOLDER =
  'Search fixed asset product or asset tag, then press Enter / pick from list...';

/** One transfer manifest shared by the two deep-link tests below. */
const DEEP_LINK_SHIPMENT = {
  id: 'shp-deep-1',
  trackingCode: 'TRK-DEEP-1',
  sourceBranchId: 'WH001',
  sourceBranchName: 'Warehouse',
  destinationBranchId: 'BRH01',
  destinationBranchName: 'Branch 2',
  dispatchDateAD: '2026-10-03',
  dispatchDateBS: '2083-06-17',
  status: 'IN_TRANSIT',
  notes: '',
  items: [
    {
      id: 'shp-line-1',
      productId: 'p-1',
      productName: 'Router',
      sku: 'ONU001',
      quantitySent: 2,
      costPrice: 500,
    },
  ],
};

/** The bounded lookup App hands both transfer screens. */
const SHIPMENT_DEEP_LINK_STUBS = {
  getShipmentPage: async () => ({
    data: [DEEP_LINK_SHIPMENT],
    totalItems: 1,
    page: 1,
    pageSize: 25,
  }),
  getShipmentOverview: async () => ({
    counts: { IN_TRANSIT: 1 },
    total: 1,
    pending: [DEEP_LINK_SHIPMENT],
    recent: [],
    pendingCapped: false,
  }),
};

test('A6: a tab switch hides the screen, keeps it mounted and preserves its draft', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('assign-asset');
  const restoreApi = installApiStubs();
  const tree = mountAppRouteTree();

  try {
    const mounted = await settleUntil(() =>
      Boolean(findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER))
    );
    assert.ok(mounted, 'the Assign Fixed Asset screen must mount in the real route tree');
    assert.equal(
      window.location.pathname,
      '/inventory/assets/assign',
      'the address bar must name the screen the workspace is showing'
    );
    assert.equal(window.location.search, '', 'the saved-tab load must not write ?tab=');

    const search = findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER);
    assert.ok(search, 'the product search input must exist');
    setInputValue(search, 'ONU ROUTER');
    await settle();
    assert.equal(search.value, 'ONU ROUTER', 'the controlled input must accept the draft');
    assert.equal(isHidden(search), false, 'the active tab must not read as hidden before the switch');

    // Navigate through the app's own event path (the toast "open tab" action).
    navigateTab('dashboard');
    await settle();
    assert.ok(
      isHidden(search),
      'a tab switch must hide the screen, not unmount it (KeepMounted)'
    );
    assert.equal(
      window.location.pathname,
      '/dashboard',
      'a tab switch must push the new screen path'
    );
    assert.ok(
      document.contains(search),
      'the hidden screen must stay in the document'
    );

    navigateTab('assign-asset');
    const visibleAgain = await settleUntil(() => !isHidden(search));
    assert.ok(visibleAgain, 'returning to the tab must show it again, not leave it hidden');

    const afterReturn = findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER);
    assert.equal(
      afterReturn,
      search,
      'returning to the tab must reuse the same DOM node — a remount would replace it'
    );
    assert.equal(afterReturn?.value, 'ONU ROUTER', 'the draft must survive the round trip');
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A6: a shared Users filter link opens its tab and restores both filters', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(
    null,
    '',
    '/?tab=users&access=exceptions&operation=inv-delete'
  );
  const restoreApi = installApiStubs();
  const tree = mountAppRouteTree();

  try {
    const mounted = await settleUntil(() =>
      (tree.container.textContent || '').includes('User Access & Role Administration')
    );
    assert.ok(mounted, 'the URL tab must mount Users over the saved tab and server preference');

    const access = tree.container.querySelector(
      'select[aria-label="Access filter"]'
    ) as HTMLSelectElement | null;
    const operation = tree.container.querySelector(
      'select[aria-label="Effective operation filter"]'
    ) as HTMLSelectElement | null;
    assert.ok(access, 'the Users screen must render its access filter');
    assert.ok(operation, 'the Users screen must render its operation filter');
    assert.equal(access!.value, 'exceptions', 'the shared access scope must be restored');
    assert.equal(operation!.value, 'inv-delete', 'the shared operation must be restored');

    let params = new URLSearchParams(window.location.search);
    assert.equal(window.location.pathname, '/settings/users', 'the legacy link must redirect to the path');
    assert.equal(params.get('tab'), null, 'the redirected URL must drop ?tab=');
    assert.equal(params.get('access'), 'exceptions');
    assert.equal(params.get('operation'), 'inv-delete');

    // Leaving Users must clean the screen-specific params; returning must put
    // the still-active filters back into the shareable URL.
    navigateTab('dashboard');
    await settle();
    params = new URLSearchParams(window.location.search);
    assert.equal(window.location.pathname, '/dashboard');
    assert.equal(params.get('access'), null);
    assert.equal(params.get('operation'), null);

    navigateTab('users');
    await settle();
    params = new URLSearchParams(window.location.search);
    assert.equal(window.location.pathname, '/settings/users');
    assert.equal(params.get('access'), 'exceptions');
    assert.equal(params.get('operation'), 'inv-delete');
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A7: a path deep link mounts its screen over the saved tab and preference', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/inventory/assets/assign');
  const restoreApi = installApiStubs();
  const tree = mountAppRouteTree();

  try {
    const mounted = await settleUntil(() =>
      Boolean(findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER))
    );
    assert.ok(mounted, 'a canonical path must mount the screen it names');
    assert.equal(window.location.pathname, '/inventory/assets/assign');
    assert.equal(window.location.search, '', 'a deep link must not grow a legacy tab parameter');
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A8: a record create link opens the Users editor and closing it returns to the register', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/settings/users/new');
  const restoreApi = installApiStubs();
  const tree = mountAppRouteTree();

  try {
    const opened = await settleUntil(() =>
      (tree.container.textContent || '').includes('Add System User')
    );
    assert.ok(opened, 'the create record path must open the user editor');
    assert.equal(window.location.pathname, '/settings/users/new', 'the editor must keep its record path');
    assert.equal(window.location.search, '', 'opening the editor must not add query state');

    const cancel = Array.from(tree.container.querySelectorAll('button')).find(
      (button) => (button.textContent || '').trim() === 'Cancel'
    ) as HTMLButtonElement | undefined;
    assert.ok(cancel, 'the user editor must render its Cancel action');
    inAct(() => cancel.click());
    await settle();

    assert.equal(window.location.pathname, '/settings/users', 'closing the editor must return to the register path');
    assert.equal(
      (tree.container.textContent || '').includes('Add System User'),
      false,
      'the closed editor must not remain rendered'
    );
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A8: a sales-invoice record link opens its detail and Back returns to the register', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/sales/invoices/INV-DEEP-1');
  const invoice = {
    id: 'si-deep-1',
    invoiceNumber: 'INV-DEEP-1',
    customerId: 'c-1',
    customerName: 'Deep Link Customer',
    branchId: 'WH001',
    invoiceDateAD: '2026-10-01',
    invoiceDateBS: '2083-06-15',
    taxableAmount: 1000,
    vatAmount: 130,
    nonTaxableAmount: 0,
    grandTotal: 1130,
    paymentStatus: 'UNPAID',
    paymentMethod: 'CASH',
    amountPaid: 0,
    status: 'POSTED',
    notes: '',
    items: [],
  };
  const restoreApi = installApiStubs({
    getSalesInvoices: async () => ({ data: [invoice], totalItems: 1, page: 1, pageSize: 25 }),
  });
  const tree = mountAppRouteTree();

  try {
    const opened = await settleUntil(() =>
      (tree.container.textContent || '').includes('Sales Invoice Detail')
    );
    assert.ok(opened, 'the invoice detail path must resolve the record, not just the register');
    assert.equal(window.location.pathname, '/sales/invoices/INV-DEEP-1');
    assert.ok(
      (tree.container.textContent || '').includes('INV-DEEP-1'),
      'the opened detail must name the invoice from the URL'
    );

    const back = Array.from(tree.container.querySelectorAll('button')).find(
      (button) => (button.textContent || '').trim() === 'Back to Register'
    ) as HTMLButtonElement | undefined;
    assert.ok(back, 'the record detail must expose its way back to the register');
    inAct(() => back.click());
    await settle();

    assert.equal(window.location.pathname, '/sales/invoices', 'closing the detail must return to the register path');
    assert.equal(
      (tree.container.textContent || '').includes('Sales Invoice Detail'),
      false,
      'the closed detail must not remain rendered'
    );
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A8: a fixed-asset create link opens the register form and Cancel clears the record path', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/inventory/assets/new');
  const restoreApi = installApiStubs({
    getFixedAssetPage: async () => ({ data: [], page: 1, pageSize: 15, totalItems: 0 }),
    getFixedAssetOverview: async () => ({
      total: 0,
      counts: {},
      totals: { acquisitionCost: 0, accumulatedDepreciation: 0, netBookValue: 0 },
      closing: {},
    }),
  });
  const tree = mountAppRouteTree();

  try {
    const opened = await settleUntil(() =>
      (tree.container.textContent || '').includes('Register New Fixed Asset')
    );
    assert.ok(opened, 'the fixed-asset create path must open the register form');
    assert.equal(window.location.pathname, '/inventory/assets/new');

    const cancel = Array.from(tree.container.querySelectorAll('button')).find(
      (button) => (button.textContent || '').trim() === 'Cancel'
    ) as HTMLButtonElement | undefined;
    assert.ok(cancel, 'the fixed-asset form must render its Cancel action');
    inAct(() => cancel.click());
    await settle();

    assert.equal(
      window.location.pathname,
      '/inventory/assets',
      'Cancel must clear the create record, not leave /new in the address bar'
    );
    assert.equal(
      (tree.container.textContent || '').includes('Register New Fixed Asset'),
      false,
      'the closed form must not remain rendered'
    );
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A7: Back/Forward resolves the path before rendering', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/dashboard');
  const restoreApi = installApiStubs();
  const tree = mountAppRouteTree();

  try {
    await settleUntil(() => window.location.pathname === '/dashboard');
    navigateTab('assign-asset');
    await settleUntil(
      () =>
        window.location.pathname === '/inventory/assets/assign' &&
        Boolean(findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER))
    );

    // Simulate a history entry moving to another screen. The App handler, not a
    // fresh mount, must resolve it back to the matching tab.
    inAct(() => {
      window.history.pushState(null, '', '/dashboard');
      window.dispatchEvent(new Event('popstate'));
    });
    const restored = await settleUntil(() => window.location.pathname === '/dashboard');
    assert.ok(restored, "Back/Forward must keep the entry's path");
    const productSearch = findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER);
    assert.ok(productSearch, 'the previous screen stays mounted while hidden');
    assert.equal(isHidden(productSearch), true, 'the path must actually switch the visible screen');
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A9: a sales-return record link opens its detail from the list endpoint', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/sales/returns/CN-DEEP-1');
  const salesReturn = {
    id: 'sr-deep-1',
    returnNumber: 'CN-DEEP-1',
    originalInvoiceId: 'si-deep-1',
    originalInvoiceNumber: 'INV-DEEP-1',
    customerId: 'CUS-DEEP-1',
    customerName: 'Deep Link Customer',
    branchId: 'WH001',
    returnDateAD: '2026-10-02',
    returnDateBS: '2083-06-16',
    reason: 'DEFECTIVE',
    restockable: true,
    taxableAmount: 500,
    vatAmount: 65,
    nonTaxableAmount: 0,
    grandTotal: 565,
    status: 'POSTED',
    items: [{ productId: 'p-1', productName: 'Router', quantity: 1, unitPrice: 500 }],
  };
  const restoreApi = installApiStubs({
    getSalesReturns: async () => ({ data: [salesReturn], totalItems: 1, page: 1, pageSize: 25 }),
  });
  const tree = mountAppRouteTree();

  try {
    const opened = await settleUntil(() =>
      (tree.container.textContent || '').includes('Sales Return Detail')
    );
    assert.ok(opened, 'the shared return path must resolve the record outside the loaded slices');
    assert.equal(window.location.pathname, '/sales/returns/CN-DEEP-1');
    assert.ok((tree.container.textContent || '').includes('CN-DEEP-1'));

    const back = Array.from(tree.container.querySelectorAll('button')).find(
      (button) => (button.textContent || '').trim() === 'Back to Register'
    ) as HTMLButtonElement | undefined;
    assert.ok(back, 'the return detail must expose its way back');
    inAct(() => back.click());
    await settle();
    assert.equal(window.location.pathname, '/sales/returns');
    assert.equal(
      (tree.container.textContent || '').includes('Sales Return Detail'),
      false,
      'the closed return detail must not remain rendered'
    );
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A9: a customer record link expands its hardware row and closing returns to the directory', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/sales/customers/CUS-DEEP-1');
  const customer = {
    id: 'CUS-DEEP-1',
    customerId: 'CUS-DEEP-1',
    customerName: 'Deep Link Customer',
    username: 'deep.customer',
    contactNumber: '9800000001',
    branchId: 'WH001',
    address: 'Kathmandu',
    email: 'deep@example.com',
    status: 'ACTIVE',
    creditLimit: 0,
    assignedDevicesCount: 0,
  };
  const restoreApi = installApiStubs({
    getCustomers: async () => ({
      data: [customer],
      totalItems: 1,
      page: 1,
      pageSize: 15,
      activeItems: 1,
      totalCreditLimit: 0,
    }),
    getCustomerDeviceOverview: async () => ({ total: 0 }),
    getCustomerDevicePage: async () => ({ data: [], totalItems: 0, page: 1, pageSize: 200 }),
  });
  const tree = mountAppRouteTree();

  try {
    const opened = await settleUntil(() =>
      (tree.container.textContent || '').includes('Hardware & Device Serials assigned to Deep Link Customer')
    );
    assert.ok(opened, 'the customer path must expand the record named by the URL');
    assert.equal(window.location.pathname, '/sales/customers/CUS-DEEP-1');

    const toggle = Array.from(tree.container.querySelectorAll('button')).find((button) =>
      (button.textContent || '').includes('Serials')
    ) as HTMLButtonElement | undefined;
    assert.ok(toggle, 'the customer row must expose its hardware toggle');
    inAct(() => toggle.click());
    await settle();

    assert.equal(window.location.pathname, '/sales/customers');
    assert.equal(
      (tree.container.textContent || '').includes('Hardware & Device Serials assigned to Deep Link Customer'),
      false,
      'collapsing the row must clear the record path and its panel'
    );
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A9: a shipment manifest link opens its manifest and closing returns to the register', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/purchasing/shipments/TRK-DEEP-1');
  const restoreApi = installApiStubs(SHIPMENT_DEEP_LINK_STUBS);
  const tree = mountAppRouteTree();

  try {
    const opened = await settleUntil(() =>
      (tree.container.textContent || '').includes('Stock Transfer Manifest — TRK-DEEP-1')
    );
    assert.ok(opened, 'the manifest path must resolve the transfer, not just the register');
    assert.equal(window.location.pathname, '/purchasing/shipments/TRK-DEEP-1');
    assert.ok(
      (tree.container.textContent || '').includes('ONU001'),
      'the manifest must list the line items of the transfer named by the URL'
    );

    const close = tree.container.querySelector(
      'button[aria-label="Close manifest"]'
    ) as HTMLButtonElement | null;
    assert.ok(close, 'the manifest must expose its close action');
    inAct(() => close!.click());
    await settle();

    assert.equal(
      window.location.pathname,
      '/purchasing/shipments',
      'closing the manifest must clear the record path and return to the register'
    );
    assert.equal(
      (tree.container.textContent || '').includes('Stock Transfer Manifest — TRK-DEEP-1'),
      false,
      'the closed manifest must not remain rendered'
    );
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A9: a transfer receipt link expands its manifest and collapsing returns to the receive lane', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard');
  window.history.replaceState(null, '', '/inventory/transfers/receive/TRK-DEEP-1');
  const restoreApi = installApiStubs(SHIPMENT_DEEP_LINK_STUBS);
  const tree = mountAppRouteTree();

  try {
    const opened = await settleUntil(() =>
      (tree.container.textContent || '').includes('Device Serials & MAC Tracking')
    );
    assert.ok(opened, 'the transfer receipt path must expand the record named by the URL');
    assert.equal(window.location.pathname, '/inventory/transfers/receive/TRK-DEEP-1');
    assert.ok(
      (tree.container.textContent || '').includes('TRK-DEEP-1'),
      'the expanded receipt must name the transfer from the URL'
    );

    const collapse = tree.container.querySelector(
      'button[title="Collapse item details"]'
    ) as HTMLButtonElement | null;
    assert.ok(collapse, 'the expanded receipt must expose its collapse action');
    inAct(() => collapse!.click());
    await settle();

    assert.equal(
      window.location.pathname,
      '/inventory/transfers/receive',
      'collapsing the receipt must clear the record path and stay on the receive lane'
    );
    assert.equal(
      (tree.container.textContent || '').includes('Device Serials & MAC Tracking'),
      false,
      'the collapsed receipt must not keep its itemized panel rendered'
    );
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});

test('A7: an unauthorized path is replaced by Dashboard, not left in the address bar', async () => {
  const originalUrl = window.location.href;
  const restoreEventSource = installEventSource();
  seedSession('dashboard', {
    id: 'u-branch',
    name: 'Branch Manager',
    email: 'branch@example.com',
    role: 'BRANCH_MANAGER',
    branchId: 'WH001',
    isActive: true,
  } as User);
  window.history.replaceState(null, '', '/settings/users');
  const restoreApi = installApiStubs();
  const tree = mountAppRouteTree();

  try {
    const redirected = await settleUntil(() => window.location.pathname === '/dashboard');
    assert.ok(redirected, 'the permission guard must redirect a forbidden deep link');
    assert.equal(
      (tree.container.textContent || '').includes('User Access & Role Administration'),
      false,
      'the forbidden screen must not remain visible'
    );
  } finally {
    tree.unmount();
    window.history.replaceState(null, '', originalUrl);
    restoreApi();
    restoreEventSource();
  }
});
