/**
 * WTY-6 — the two warranty registers and the retirement of the old directory.
 *
 * PROVES:
 *   1. RENDER: each register shows the server's stored dates and its KPI
 *      population, and its default status filter is ALL. The retired screen
 *      defaulted to VALID, which is how a populated register showed an empty
 *      table in the reported screenshot.
 *   2. FILTERS/PAGING: search, status, category/type, the start-date range,
 *      the branch and the page all travel to the real API contract.
 *   3. EMPTY STATES: "nothing captured" and "filters match nothing" are
 *      different messages, and both name the applied filters.
 *   4. CORRECTION: the edit dialog saves a corrected expiry through
 *      PATCH /api/warranties/:id and refetches; a reversed range is refused
 *      inline without a request; a 403 is surfaced as a permission refusal.
 *   5. PERMISSION: a role without `warranty-edit` gets no Edit control.
 *   6. SOURCE: WarrantyProducts.tsx, its tab, its route and
 *      GET /api/customer-devices/warranty are gone, and both new tabs are
 *      gated by `warranty-view`.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React, { act, createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { SupplierWarrantyRegister } from '../client/src/features/inventory/SupplierWarrantyRegister';
import { SellerWarrantyRegister } from '../client/src/features/inventory/SellerWarrantyRegister';
import { api } from '../client/src/services/api';
import type { WarrantyCoveragePage, WarrantyCoverageRow } from '../client/src/types';

const ROOT = path.resolve('.');

const inventoryManager = {
  id: 'u-w6',
  email: 'w6@example.com',
  name: 'W6 Manager',
  role: 'INVENTORY_MANAGER',
  branchId: 'br-a',
} as any;

const frontDesk = {
  id: 'u-w6-fd',
  email: 'w6-fd@example.com',
  name: 'W6 Front Desk',
  role: 'FRONT_DESK',
  branchId: 'br-a',
} as any;

const rows: WarrantyCoverageRow[] = [
  {
    id: 'cov-v1',
    coverageType: 'VENDOR',
    itemCategory: 'CPE',
    productId: 'p-1',
    productName: 'Fiber Router X',
    serialNumber: 'SN-SUP-1',
    branchId: 'br-a',
    branchName: 'Main Branch',
    partyName: 'Acme Networks',
    sourceType: 'PURCHASE_INVOICE',
    sourceId: 'pi-1',
    sourceNumber: 'PI-1001',
    startDateAD: '2026-01-15',
    endDateAD: '2027-01-15',
    termMonths: 12,
    startBasis: 'INVOICE_DATE',
    warrantyState: 'VALID',
    daysRemaining: 200,
    notes: null,
    isDemo: false,
  },
  {
    id: 'cov-v2',
    coverageType: 'VENDOR',
    itemCategory: 'FIXED_ASSET',
    productId: null,
    productName: 'Core Switch',
    serialNumber: 'TAG-FA-9',
    branchId: 'br-a',
    branchName: 'Main Branch',
    partyName: 'Himalayan IT',
    sourceType: 'FIXED_ASSET',
    sourceId: 'fa-1',
    sourceNumber: 'FA-77',
    startDateAD: '2024-05-01',
    endDateAD: '2025-05-01',
    termMonths: 12,
    startBasis: 'ACQUISITION_DATE',
    warrantyState: 'EXPIRED',
    daysRemaining: -120,
    notes: null,
    isDemo: false,
  },
];

const sellerRows: WarrantyCoverageRow[] = [
  {
    id: 'cov-s1',
    coverageType: 'SELLER',
    itemCategory: 'CPE',
    productId: 'p-2',
    productName: 'ONT Unit',
    serialNumber: 'SN-SEL-1',
    branchId: 'br-a',
    branchName: 'Main Branch',
    partyName: 'Ram Bahadur',
    sourceType: 'CUSTOMER_ASSIGNMENT',
    sourceId: 'cdr-1',
    sourceNumber: 'CPE-001',
    startDateAD: '2026-02-01',
    endDateAD: '2026-03-03',
    termMonths: 12,
    startBasis: 'ISSUE_DATE',
    warrantyState: 'EXPIRING_SOON',
    daysRemaining: 20,
    notes: 'Customer keeps the router.',
    isDemo: false,
  },
];

function pageOf(data: WarrantyCoverageRow[], over: Partial<WarrantyCoveragePage> = {}): WarrantyCoveragePage {
  return {
    data,
    page: 1,
    pageSize: 15,
    totalItems: data.length,
    counts: {
      total: data.length,
      valid: data.filter((row) => row.warrantyState === 'VALID').length,
      expiring: data.filter((row) => row.warrantyState === 'EXPIRING_SOON').length,
      expired: data.filter((row) => row.warrantyState === 'EXPIRED').length,
    },
    ...over,
  };
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  inAct(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function changeSelect(select: HTMLSelectElement, value: string) {
  inAct(() => {
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function button(container: HTMLElement, label: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((node) =>
    label.test(node.getAttribute('aria-label') || node.textContent || '')
  ) as HTMLButtonElement | undefined;
}

describe('warranty registers', () => {
  const real = {
    vendor: api.fetchVendorWarranties,
    seller: api.fetchSellerWarranties,
    update: api.updateWarrantyCoverage,
  };
  let vendorCalls: any[] = [];
  let sellerCalls: any[] = [];
  let updates: any[] = [];

  beforeEach(() => {
    vendorCalls = [];
    sellerCalls = [];
    updates = [];
    api.fetchVendorWarranties = (async (params: any, page: number, pageSize: number) => {
      vendorCalls.push({ params, page, pageSize });
      return pageOf(rows);
    }) as any;
    api.fetchSellerWarranties = (async (params: any, page: number, pageSize: number) => {
      sellerCalls.push({ params, page, pageSize });
      return pageOf(sellerRows);
    }) as any;
    api.updateWarrantyCoverage = (async (id: string, input: any) => {
      updates.push({ id, input });
      return { ...rows[0], ...input } as any;
    }) as any;
  });

  afterEach(() => {
    api.fetchVendorWarranties = real.vendor;
    api.fetchSellerWarranties = real.seller;
    api.updateWarrantyCoverage = real.update;
  });

  const mountVendor = async (currentUser: any = inventoryManager, refreshKey = 0) => {
    const tree = mountTree(
      createElement(SupplierWarrantyRegister, {
        selectedBranchId: 'br-a',
        dateMode: 'AD',
        currentUser,
        refreshKey,
      } as any)
    );
    await settle();
    return tree;
  };

  const mountSeller = async (currentUser: any = inventoryManager) => {
    const tree = mountTree(
      createElement(SellerWarrantyRegister, {
        selectedBranchId: 'br-a',
        dateMode: 'AD',
        currentUser,
        refreshKey: 0,
      } as any)
    );
    await settle();
    return tree;
  };

  test('a register shows stored covered units, both sides, and defaults to every status', async () => {
    const tree = await mountVendor();
    try {
      const text = tree.container.textContent || '';
      assert.match(text, /Suppliers Warranty/);
      assert.match(text, /Covered units/);
      assert.match(text, /Fiber Router X/);
      assert.match(text, /SN-SUP-1/);
      assert.match(text, /Acme Networks/);
      assert.match(text, /Purchase invoice/);
      assert.match(text, /PI-1001/);
      assert.match(text, /TAG-FA-9/, 'a fixed asset row must show its tag');
      assert.match(text, /Expired \(120 days ago\)/);

      // The default must not be VALID: this is the screenshot regression.
      const status = tree.container.querySelector('select[aria-label="Warranty status"]') as HTMLSelectElement;
      assert.ok(status, 'the status filter must exist');
      assert.equal(status.value, 'ALL', 'the register must open on every status');
      assert.equal(vendorCalls.length, 1, 'one server read on mount');
      assert.equal(vendorCalls[0].params.status, undefined, 'ALL must not send a status filter');
      assert.equal(vendorCalls[0].params.branchId, 'br-a', 'the header branch must scope the read');
    } finally {
      tree.unmount();
    }
  });

  test('the KPIs describe the whole filtered population, not the page on screen', async () => {
    api.fetchVendorWarranties = (async () => ({
      data: rows.slice(0, 1),
      page: 1,
      pageSize: 15,
      totalItems: 7,
      counts: { total: 7, valid: 4, expiring: 2, expired: 1 },
    })) as any;
    const tree = await mountVendor();
    try {
      const text = tree.container.textContent || '';
      assert.match(text, /Whole filtered population/);
      assert.match(text, /7 of 7 coverage records/);
      assert.match(text, /7/, 'the covered-unit KPI must be the population');
      assert.match(text, /4/);
    } finally {
      tree.unmount();
    }
  });

  test('search, status, type, date range and paging all round-trip to the server', async () => {
    api.fetchSellerWarranties = (async (params: any, page: number, pageSize: number) => {
      sellerCalls.push({ params, page, pageSize });
      return pageOf(sellerRows, { totalItems: 40 });
    }) as any;
    const tree = await mountSeller();
    try {
      const search = tree.container.querySelector(
        'input[placeholder*="Search customer"]'
      ) as HTMLInputElement | null;
      assert.ok(search, 'the seller register must offer a customer search');
      setInput(search!, 'Ram');
      inAct(() => {
        search!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await settle();

      changeSelect(tree.container.querySelector('select[aria-label="Warranty status"]') as HTMLSelectElement, 'EXPIRED');
      await settle();
      changeSelect(tree.container.querySelector('select[aria-label="Warranty type"]') as HTMLSelectElement, 'SOLD_PRODUCT');
      await settle();

      const from = tree.container.querySelector('#warranty-filter-from') as HTMLInputElement | null;
      assert.ok(from, 'the start-date range must be filterable');
      setInput(from!, '2026-01-01');
      await settle();

      const last = sellerCalls[sellerCalls.length - 1];
      assert.equal(last.params.query, 'Ram');
      assert.equal(last.params.status, 'EXPIRED');
      assert.equal(last.params.category, 'SOLD_PRODUCT');
      assert.equal(last.params.startFrom, '2026-01-01');
      assert.equal(last.params.branchId, 'br-a');

      const next = button(tree.container, /Next page/);
      assert.ok(next, 'a 40-row population must page');
      inAct(() => next!.click());
      await settle();
      assert.equal(sellerCalls[sellerCalls.length - 1].page, 2, 'Next must ask the server for page 2');
    } finally {
      tree.unmount();
    }
  });

  test('empty states differ and both name the applied filters', async () => {
    api.fetchVendorWarranties = (async () => pageOf([], { totalItems: 0 })) as any;
    const emptyTree = await mountVendor();
    try {
      const text = emptyTree.container.textContent || '';
      assert.match(text, /No supplier warranty coverage has been captured yet\./);
      assert.match(text, /Status: All statuses/);
      assert.match(text, /Category: All categories/);
    } finally {
      emptyTree.unmount();
    }

    const filtered = await mountVendor();
    try {
      changeSelect(filtered.container.querySelector('select[aria-label="Warranty status"]') as HTMLSelectElement, 'EXPIRED');
      await settle();
      const text = filtered.container.textContent || '';
      assert.match(text, /No coverage matches the applied filters\./);
      assert.match(text, /Status: Expired/);
      assert.doesNotMatch(text, /No supplier warranty coverage has been captured yet\./);
    } finally {
      filtered.unmount();
    }
  });

  test('a correction saves the exact dates, refetches, and refuses a reversed range', async () => {
    const tree = await mountVendor();
    try {
      const edit = button(tree.container, /^Correct warranty dates/);
      assert.ok(edit, 'an account with warranty-edit must see the correction control');
      inAct(() => edit!.click());
      await settle();

      const modal = tree.container.querySelector('[data-testid="warranty-edit-modal"]') as HTMLElement | null;
      assert.ok(modal, 'the shared correction dialog must open');
      assert.match(modal!.textContent || '', /Term snapshot: 12 months/);

      const end = modal!.querySelector('#warranty-end-date') as HTMLInputElement;
      const start = modal!.querySelector('#warranty-start-date') as HTMLInputElement;
      assert.equal(start.value, '2026-01-15');
      assert.equal(end.value, '2027-01-15');

      // Reversed range: refused inline, no PATCH.
      setInput(end, '2025-12-31');
      await settle();
      assert.match(modal!.textContent || '', /cannot be before the start date/);
      inAct(() => button(modal!, /Save correction/)!.click());
      await settle();
      assert.equal(updates.length, 0, 'a reversed range must never reach the API');

      setInput(end, '2028-06-30');
      await settle();
      inAct(() => button(modal!, /Save correction/)!.click());
      await settle();

      assert.equal(updates.length, 1);
      assert.equal(updates[0].id, 'cov-v1');
      assert.equal(updates[0].input.startDateAD, '2026-01-15');
      assert.equal(updates[0].input.endDateAD, '2028-06-30');
      assert.equal(updates[0].input.termMonths, 12);
      assert.ok(vendorCalls.length >= 2, 'a supersede must refetch the page rather than patch the old row');
      assert.equal(
        tree.container.querySelector('[data-testid="warranty-edit-modal"]'),
        null,
        'the dialog closes only after the refetch is triggered'
      );
    } finally {
      tree.unmount();
    }
  });

  test('a 403 from the correction API is surfaced as a permission refusal', async () => {
    api.updateWarrantyCoverage = (async () => {
      throw Object.assign(new Error('Forbidden: this coverage is outside your branch scope.'), { status: 403 });
    }) as any;
    const tree = await mountVendor();
    try {
      inAct(() => button(tree.container, /^Correct warranty dates/)!.click());
      await settle();
      const modal = tree.container.querySelector('[data-testid="warranty-edit-modal"]') as HTMLElement;
      setInput(modal.querySelector('#warranty-end-date') as HTMLInputElement, '2028-01-15');
      inAct(() => button(modal, /Save correction/)!.click());
      await settle();
      const text = modal.textContent || '';
      assert.match(text, /may not correct warranty dates/i);
      assert.match(text, /Forbidden/);
    } finally {
      tree.unmount();
    }
  });

  test('an account without warranty-edit sees no Edit control', async () => {
    const tree = await mountVendor(frontDesk);
    try {
      assert.equal(
        button(tree.container, /^Correct warranty dates/),
        undefined,
        'a view-only role must not be offered a correction'
      );
      assert.match(tree.container.textContent || '', /Read only/);
    } finally {
      tree.unmount();
    }
  });
});

describe('retired warranty directory', () => {
  const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

  test('the screen, its client read, its route and its endpoint are gone', () => {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'client/src/features/inventory/WarrantyProducts.tsx')),
      false,
      'WarrantyProducts.tsx is back — it invents a 12-month expiry and defaults to VALID'
    );
    assert.doesNotMatch(read('client/src/App.tsx'), /WarrantyProducts|warranty-products/);
    assert.doesNotMatch(read('client/src/components/layout/Sidebar.tsx'), /View Warranty Products|warranty-products/);
    assert.doesNotMatch(read('server/src/routes/inventory.routes.ts'), /customer-devices\/warranty/);
    assert.doesNotMatch(read('server/src/controllers/inventory.controller.ts'), /get_customerDevicesWarranty/);
    assert.doesNotMatch(read('server/src/models/inventory.repo.ts'), /buildWarrantyDirectoryQuery|WARRANTY_ITEMS_CTE/);
    assert.doesNotMatch(read('client/src/services/api/inventory.ts'), /getCustomerDeviceWarranty|WarrantyDirectory/);
  });

  test('both new tabs exist, are routed, and are gated by warranty-view', () => {
    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.match(sidebar, /'supplier-warranty'/);
    assert.match(sidebar, /'seller-warranty'/);
    assert.match(sidebar, /label: 'Suppliers Warranty'/);
    assert.match(sidebar, /label: 'Sellers Warranty'/);

    const routes = read('client/src/App.tsx');
    assert.match(routes, /screenRoute\('supplier-warranty'/);
    assert.match(routes, /screenRoute\('seller-warranty'/);

    const permissions = read('client/src/routes/tabPermissions.ts');
    assert.match(permissions, /'supplier-warranty': 'warranty-view'/);
    assert.match(permissions, /'seller-warranty': 'warranty-view'/);
  });

  test('the two client reads and the correction go through the WTY-1 API', () => {
    const client = read('client/src/services/api/warranty.ts');
    assert.match(client, /\/api\/warranties\/vendor/);
    assert.match(client, /\/api\/warranties\/seller/);
    assert.match(client, /method: 'PATCH'/);
    assert.match(read('client/src/services/api/index.ts'), /fetchVendorWarranties: warranty\.fetchVendorWarranties/);
  });
});
