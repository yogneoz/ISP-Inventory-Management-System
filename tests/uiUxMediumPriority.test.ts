/**
 * UI/UX medium-priority fixes — the three findings that changed what an
 * operator sees on a posting/review screen.
 *
 * PROVES:
 *   - the header bell, Notification Center and Clear All read one alert list,
 *     including order alerts and the shared dismissed ids (UIX-4),
 *   - the bell has a real accessible name instead of its badge number,
 *   - Create Purchase Bill starts with NO supplier and NO fabricated bill
 *     number, and both controls stay required (UIX-6),
 *   - the purchase-bill action cell is pinned to the right edge and dates
 *     render compactly with the full BS/AD pair in the tooltip (UIX-5).
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement as h } from 'react';
import { mountTree } from './harness/mount';
import { DarkModeProvider } from '../client/src/contexts/DarkModeContext';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { AppShell } from '../client/src/components/layout/AppShell';
import { Sidebar } from '../client/src/components/layout/Sidebar';
import { LoginModal } from '../client/src/components/common/LoginModal';
import { PurchaseInvoiceForm } from '../client/src/features/procurement/PurchaseInvoiceForm';
import { PurchaseInvoices } from '../client/src/features/procurement/PurchaseInvoices';
import { api } from '../client/src/services/api';
import { formatDualDate } from '../client/src/utils/nepaliCalendar';

const user = {
  id: 'u-medium',
  email: 'medium@example.com',
  name: 'Medium Admin',
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

describe('UIX-7/9 — the rail fits its labels and names the active page', () => {
  test('long labels truncate with a tooltip and the active item exposes aria-current', () => {
    const baseProps = {
      companyProfile: null,
      currentUser: user,
      branches,
      selectedBranchId: 'ALL',
      onSelectBranch: () => {},
      fiscalYears: [],
      selectedFiscalYearId: '',
      onSelectFiscalYear: () => {},
      lowStockCount: 0,
      pendingPoCount: 0,
      pendingBillCount: 0,
      inTransitShipmentCount: 0,
      onCloseMobile: () => {},
    } as any;
    const tree = mountTree(
      h(Sidebar, {
        ...baseProps,
        activeTab: 'purchase-list',
        onSelectTab: () => {},
      })
    );

    try {
      const current = [...tree.container.querySelectorAll('[aria-current="page"]')];
      assert.equal(current.length, 1, 'exactly one navigation item may be current');
      const active = current[0] as HTMLButtonElement;
      assert.match(active.textContent || '', /Purchase Bills Register/);

      const label = active.querySelector('span') as HTMLSpanElement;
      assert.match(label.className, /\btruncate\b/, 'a long menu label must not wrap the rail');
      assert.equal(label.getAttribute('title'), 'Purchase Bills Register');

      // The group holding the current page is expanded and says so.
      const expandedGroup = [...tree.container.querySelectorAll('button[aria-expanded="true"]')].find(
        (button) => /Procurement & Purchasing/.test(button.textContent || '')
      );
      assert.ok(expandedGroup, 'the active group must be expanded');

      tree.rerender(
        h(Sidebar, {
          ...baseProps,
          activeTab: 'help-documentation',
          onSelectTab: () => {},
        })
      );
      const moved = [...tree.container.querySelectorAll('[aria-current="page"]')];
      assert.equal(moved.length, 1);
      assert.match(moved[0].textContent || '', /Help Center & Manual/);
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-8 — login keyboard order and error announcement', () => {
  const original = api.getSetupStatus;

  beforeEach(() => {
    api.getSetupStatus = (async () => ({
      hasSuperAdmin: true,
      userCount: 1,
      isFirstLaunch: false,
    })) as any;
  });

  afterEach(() => {
    api.getSetupStatus = original;
  });

  test('password precedes Forgot Password in DOM and a failure is a described live alert', async () => {
    const tree = mountTree(
      h(LoginModal, {
        onLoginSuccess: async () => {
          throw new Error('Invalid email or password.');
        },
      })
    );

    try {
      await settle();
      const form = tree.container.querySelector('form') as HTMLFormElement;
      const email = tree.container.querySelector('#login-email') as HTMLInputElement;
      const password = tree.container.querySelector('#login-password') as HTMLInputElement;
      const forgot = [...tree.container.querySelectorAll('button')].find((button) =>
        /Forgot Password\?/.test(button.textContent || '')
      ) as HTMLButtonElement;
      assert.ok(form && email && password && forgot, 'the login form must render its controls');

      const focusables = [...form.querySelectorAll<HTMLElement>('input, button')];
      assert.ok(
        focusables.indexOf(password) < focusables.indexOf(forgot),
        'Tab must reach the password field before Forgot Password'
      );
      assert.equal(
        tree.container.querySelector('label[for="login-password"]')?.textContent?.trim(),
        'Password'
      );

      setInputValue(email, 'operator@example.com');
      setInputValue(password, 'wrong-password');
      await act(async () => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const alert = tree.container.querySelector('[role="alert"]') as HTMLElement | null;
      assert.ok(alert, 'a failed sign-in must be announced as an alert');
      assert.equal(alert!.id, 'login-error');
      assert.match(alert!.textContent || '', /Invalid email or password/);
      assert.equal(email.getAttribute('aria-invalid'), 'true');
      assert.equal(password.getAttribute('aria-invalid'), 'true');
      assert.equal(email.getAttribute('aria-describedby'), 'login-error');
      assert.equal(password.getAttribute('aria-describedby'), 'login-error');
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-4 — one notification source for badge, drawer and Clear All', () => {
  test('order alerts are counted once and dismissing/Clear All move every surface together', async () => {
    const product = {
      id: 'p1',
      name: 'Low Router',
      sku: 'LR-1',
      category: 'Routers',
      unit: 'Pcs',
      sellingPrice: 100,
      costPrice: 50,
      minReorderLevel: 5,
      trackingType: 'QUANTITY_ONLY',
      requiresSerialTracking: false,
    } as any;
    const stock = [
      { id: 's1', productId: 'p1', branchId: 'b1', quantityOnHand: 1, minReorderLevel: 5 },
    ] as any[];
    const purchaseOrder = {
      id: 'po1',
      poNumber: 'PO-1',
      supplierName: 'Acme Supplier',
      status: 'SENT',
      totalAmount: 1000,
      branchId: 'b1',
      orderDateAD: '2026-10-01',
      items: [],
    } as any;

    const tree = mountTree(
      h(
        DarkModeProvider,
        null,
        h(AppShell, {
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
          currentFiscalYear: '2082/83',
          fiscalYears: [],
          selectedFiscalYearId: '',
          onSelectFiscalYear: () => {},
          activeTab: 'dashboard',
          onSelectTab: () => {},
          searchQuery: '',
          onSearchChange: () => {},
          products: [product],
          stock,
          purchaseOrders: [purchaseOrder],
          purchaseInvoices: [],
          pendingPurchaseOrders: [purchaseOrder],
          unpaidBillCount: 0,
          shipments: [],
          stockOperations: [],
          approvalRequests: [],
          suppliers: [],
          bsCalendarCoverage: null,
          bsCalendarSeedTab: 'bs-calendar',
          banners: null,
          children: h('main', null, 'workspace'),
        } as any)
      )
    );

    try {
      const bell = tree.container.querySelector(
        '[data-shell-trigger="notifications"]'
      ) as HTMLButtonElement | null;
      assert.ok(bell, 'the header must render the notification bell');
      assert.equal(
        bell!.getAttribute('aria-label'),
        'Notifications, 2 active',
        'the bell must name itself with the count, and include the order alert'
      );

      act(() => bell!.click());
      await settle();
      assert.match(
        tree.container.textContent || '',
        /2 Active/,
        'the drawer must show the same two alerts the bell announced'
      );
      assert.match(tree.container.textContent || '', /PO-1/);

      const dismiss = tree.container.querySelector(
        'button[title="Dismiss"]'
      ) as HTMLButtonElement | null;
      assert.ok(dismiss, 'the drawer must offer a dismiss action');
      act(() => dismiss!.click());
      await settle();
      assert.equal(
        bell!.getAttribute('aria-label'),
        'Notifications, 1 active',
        'dismissing one alert must move the bell count too'
      );
      assert.match(tree.container.textContent || '', /1 Active/);

      const clearAll = [...tree.container.querySelectorAll('button')].find(
        (button) => (button.textContent || '').trim() === 'Clear All'
      ) as HTMLButtonElement;
      assert.ok(clearAll, 'Clear All must be available while an alert remains');
      act(() => clearAll.click());
      await settle();
      assert.equal(bell!.getAttribute('aria-label'), 'Notifications, none active');
      assert.match(tree.container.textContent || '', /All caught up!/);
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-6 — Create Purchase Bill has no fabricated defaults', () => {
  const original = api.getPurchaseOrders;

  beforeEach(() => {
    api.getPurchaseOrders = (async () => ({
      data: [],
      totalItems: 0,
      page: 1,
      pageSize: 200,
    })) as any;
  });

  afterEach(() => {
    api.getPurchaseOrders = original;
  });

  test('supplier and vendor bill number start empty and stay required', async () => {
    const tree = mountTree(
      h(
        DialogProvider as any,
        null,
        h(PurchaseInvoiceForm, {
          currentUser: user,
          products: [],
          branches,
          suppliers: [
            { id: 'sup1', name: 'Example Supplier 1' },
            { id: 'sup2', name: 'Other Supplier' },
          ] as any[],
          selectedBranchId: 'b1',
          fiscalYearStartAD: '2026-07-17',
          fiscalYearEndAD: '2027-07-16',
          dateMode: 'AD',
          onCreateInvoice: async () => {},
          onSaved: () => {},
          onClose: () => {},
        } as any)
      )
    );

    try {
      await settle();
      const supplier = tree.container.querySelector('#pi-supplier-input') as HTMLInputElement | null;
      const billNumber = tree.container.querySelector(
        '#pi-vendor-bill-number'
      ) as HTMLInputElement | null;
      assert.ok(supplier, 'the form must render the supplier picker');
      assert.ok(billNumber, 'the form must render the vendor bill number');

      assert.equal(supplier!.value, '', 'no supplier may be preselected');
      assert.match(
        supplier!.getAttribute('placeholder') || '',
        /Select supplier/,
        'the empty state must ask the operator to select'
      );
      assert.equal(supplier!.required, true, 'the supplier remains required');

      assert.equal(billNumber!.value, '', 'no bill number may be fabricated');
      assert.match(
        billNumber!.getAttribute('placeholder') || '',
        /supplier's bill/i,
        'the placeholder must describe the supplier document'
      );
      assert.equal(billNumber!.required, true, 'the supplier bill number remains required');
    } finally {
      tree.unmount();
    }
  });
});

describe('UIX-5 — purchase-bill actions stay reachable', () => {
  const original = api.getPurchaseInvoices;

  beforeEach(() => {
    const invoice = {
      id: 'inv1',
      invoiceNumber: 'PI-1',
      vendorBillNumber: 'VB-1',
      supplierName: 'Acme Supplier',
      branchId: 'b1',
      poReferenceId: '',
      invoiceDateAD: '2026-10-01',
      taxableAmount: 100,
      vatAmount: 13,
      grandTotal: 113,
      amountPaid: 0,
      paymentStatus: 'UNPAID',
      items: [{ productName: 'Router', quantity: 1 }],
    } as any;
    api.getPurchaseInvoices = (async () => ({
      data: [invoice],
      totalItems: 1,
      sums: { taxable: 100, vat: 13, grand: 113, unpaid: 113 },
    })) as any;
  });

  afterEach(() => {
    api.getPurchaseInvoices = original;
  });

  test('the action cell is sticky at the right edge and dates stay one line', async () => {
    const tree = mountTree(
      h(
        DialogProvider as any,
        null,
        h(PurchaseInvoices, {
          companyProfile: null,
          currentUser: user,
          invoices: [],
          products: [],
          branches,
          suppliers: [],
          stock: [],
          purchaseOrders: [],
          selectedBranchId: 'ALL',
          fiscalYearStartAD: '2026-07-17',
          fiscalYearEndAD: '2027-07-16',
          dateMode: 'AD',
          onCreateInvoice: async () => {},
          onRecordPayment: async () => {},
          onDeleteInvoice: async () => {},
        } as any)
      )
    );

    try {
      await settle();
      const view = tree.container.querySelector(
        'button[aria-label="View bill PI-1"]'
      ) as HTMLButtonElement | null;
      assert.ok(view, 'the row must render its view action');
      const actionCell = view!.closest('td') as HTMLTableCellElement;
      assert.match(actionCell.className, /\bsticky\b/);
      assert.match(actionCell.className, /\bright-0\b/);
      assert.ok(
        tree.container.querySelector('button[aria-label="View products on PI-1"]'),
        'the products action must render in the same pinned cell'
      );

      const fullDate = formatDualDate('2026-10-01', 'AD');
      const dateCell = [...tree.container.querySelectorAll('td')].find(
        (cell) => (cell.querySelector('[title]') as HTMLElement | null)?.getAttribute('title') === fullDate
      ) as HTMLTableCellElement | undefined;
      assert.ok(dateCell, 'the bill date cell must carry the full BS/AD pair in its tooltip');
      assert.equal(
        (dateCell!.querySelector('[title]') as HTMLElement).textContent,
        fullDate.split(' (')[0],
        'the visible cell must show the compact primary date'
      );
    } finally {
      tree.unmount();
    }
  });
});
