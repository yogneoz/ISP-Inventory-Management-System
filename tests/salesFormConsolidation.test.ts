/**
 * Sales form consolidation — one counter-sale form, with the seller warranty
 * that used to live only on the retired Product Sale screen.
 *
 * PROVES:
 *   1. The Product Sale screen is gone: no panel file, route, stock-operation
 *      tab or menu entry, so the same sale cannot be posted two ways.
 *   2. Create Sales Invoice is the surviving counter-sale form and carries an
 *      in-card header plus the explicit seller-warranty switch/expiry.
 *   3. The switch behaves as a declaration: off removes the date, on prefills
 *      the product's seller term from today's invoice date.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React, { act, createElement } from 'react';
import { mountTree } from './harness/mount';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { DarkModeProvider } from '../client/src/contexts/DarkModeContext';
import { SalesInvoices, buildSalesInvoiceExportRows } from '../client/src/features/sales/SalesInvoices';
import { api } from '../client/src/services/api';
import { warrantyEndFor } from '../client/src/utils/warrantyCapture';
import { summarizeSalesWarranty } from '../client/src/utils/salesWarranty';
import { localTodayAD } from '../client/src/utils/localDate';

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const user = {
  id: 'u-sales',
  email: 'sales@example.com',
  name: 'Sales Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: ['ALL'],
} as any;

const branches = [
  { id: 'b1', code: 'B1', name: 'Main Branch', location: 'Kathmandu' },
] as any[];

const products = [
  {
    id: 'p1',
    sku: 'ONU-1',
    barcode: 'ONU-1',
    name: 'ONU Router',
    category: 'Devices',
    unit: 'Pcs',
    costPrice: 700,
    sellingPrice: 1000,
    taxRate: 13,
    minReorderLevel: 1,
    requiresSerialTracking: true,
    trackingType: 'SERIAL_MAC_PON',
    sellerWarrantyMonths: 12,
  },
] as any[];

const stock = [
  { id: 's1', productId: 'p1', branchId: 'b1', quantityOnHand: 5, reservedQty: 0, incomingQty: 0, lastUpdated: '2026-10-30' },
] as any[];

const serials = [
  {
    id: 'sl1',
    deviceSerial: 'SN-1',
    ponSerial: 'PON-1',
    productId: 'p1',
    productName: 'ONU Router',
    branchId: 'b1',
    status: 'IN_STOCK',
    sourceType: 'PURCHASE',
    history: [],
    createdAt: '2026-10-30',
  },
] as any[];

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function findButton(container: HTMLElement, pattern: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    pattern.test((button.textContent || '').trim())
  ) as HTMLButtonElement | undefined;
}

describe('sales form consolidation', () => {
  test('the retired Product Sale screen has no panel, route, tab or menu entry', () => {
    assert.equal(
      fs.existsSync(path.join(root, 'client/src/features/inventory/stockops/ProductSalePanel.tsx')),
      false,
      'the duplicate retail-sale panel must be deleted, not merely unrouted'
    );

    const app = read('client/src/App.tsx');
    assert.doesNotMatch(app, /screenRoute\('stock-out'/);
    assert.doesNotMatch(app, /initialType="STOCK_OUT"/);

    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.doesNotMatch(sidebar, /id: 'stock-out'/);
    assert.doesNotMatch(sidebar, /Product Sale to Customer/);

    const stockOps = read('client/src/features/inventory/StockOperations.tsx');
    assert.doesNotMatch(stockOps, /ProductSalePanel|PRODUCT_SALE/);

    const tabBar = read('client/src/features/inventory/stockops/StockOperationsTabBar.tsx');
    assert.doesNotMatch(tabBar, /Product Sale|PRODUCT_SALE|saleOperations/);

    // The stock-out permission stays: it still gates consumable/manual issues
    // and reverses operations posted before the screen was retired.
    assert.match(read('server/src/controllers/permissions.core.ts'), /'STOCK_OUT': 'stock-out'/);
  });

  test('Create Sales Invoice is the counter-sale form and names its document in-card', () => {
    const src = read('client/src/features/sales/SalesInvoices.tsx');
    assert.match(src, /<h3[^>]*>[\s\S]*?Create Sales Invoice[\s\S]*?<\/h3>/, 'the create card needs its own header');
    assert.match(src, /Tax Invoice/);
    assert.match(src, /Sellers warranty covered/);
    assert.match(src, /warrantyEndFieldError\(/);
    assert.match(src, /sellerWarrantyCovered: l\.sellerWarrantyCovered/);
    assert.match(src, /sellerWarrantyEndDateAD: l\.sellerWarrantyEndDateAD/);
  });

  test('the register summary never invents one expiry when lines disagree', () => {
    const line = (overrides: Record<string, unknown>) => ({
      id: 'item',
      productId: 'p1',
      productName: 'ONU Router',
      sku: 'ONU-1',
      unit: 'Pcs',
      quantity: 1,
      unitPrice: 1000,
      deviceSerials: [{ deviceSerial: 'SN-1' }],
      ...overrides,
    }) as any;

    assert.equal(summarizeSalesWarranty([]).state, 'NONE');
    assert.equal(
      summarizeSalesWarranty([line({ sellerWarrantyCovered: true, sellerWarrantyEndDateAD: '2027-10-30' })]).state,
      'COVERED'
    );
    assert.equal(
      summarizeSalesWarranty([line({ sellerWarrantyCovered: false })]).state,
      'NOT_COVERED'
    );
    assert.equal(
      summarizeSalesWarranty([line({})]).state,
      'NOT_RECORDED',
      'a legacy serialised line with no captured promise must not look covered or explicitly uncovered'
    );

    const multiple = summarizeSalesWarranty([
      line({ sellerWarrantyEndDateAD: '2028-01-02' }),
      line({ sellerWarrantyEndDateAD: '2027-10-30' }),
    ]);
    assert.equal(multiple.state, 'MULTIPLE');
    assert.equal(multiple.endDateAD, '2027-10-30', 'the earliest expiry is shown, not the latest');
    assert.equal(multiple.dateCount, 2);

    const mixed = summarizeSalesWarranty([
      line({ sellerWarrantyEndDateAD: '2027-10-30' }),
      line({ sellerWarrantyCovered: false }),
    ]);
    assert.equal(mixed.state, 'MIXED');
    assert.equal(mixed.endDateAD, '2027-10-30', 'mixed invoices still show the covered date');
    assert.equal(mixed.coveredCount, 1);
    assert.equal(mixed.uncoveredCount, 1);
  });

  test('the CSV export carries the seller warranty beside every invoice line', () => {
    const invoice = {
      id: 'inv-export',
      invoiceNumber: 'INV-EXPORT-1',
      customerName: 'Sita Customer',
      branchId: 'b1',
      invoiceDateAD: '2026-10-30',
      invoiceDateBS: '2083-07-13',
      paymentStatus: 'PAID',
      paymentMethod: 'CASH',
      amountPaid: 2260,
      status: 'POSTED',
      items: [
        {
          id: 'e1', productId: 'p1', productName: 'ONU Router', sku: 'ONU-1', unit: 'Pcs',
          quantity: 1, unitPrice: 1000, taxAmount: 130, total: 1130,
          deviceSerials: [{ deviceSerial: 'SN-1' }],
          sellerWarrantyCovered: true, sellerWarrantyEndDateAD: '2027-10-30',
        },
        {
          id: 'e2', productId: 'p2', productName: 'Power Adapter', sku: 'ADP-1', unit: 'Pcs',
          quantity: 1, unitPrice: 1000, taxAmount: 130, total: 1130,
          deviceSerials: [{ deviceSerial: 'SN-2' }], sellerWarrantyCovered: false,
        },
        {
          id: 'e3', productId: 'p3', productName: 'Patch Cord', sku: 'PC-1', unit: 'Pcs',
          quantity: 2, unitPrice: 50, taxAmount: 13, total: 113,
        },
      ],
    } as any;

    const rows = buildSalesInvoiceExportRows([invoice], branches);
    assert.equal(rows.length, 3, 'one export row per invoice line');
    assert.equal(rows[0].sellerWarrantyCoverage, 'Covered');
    assert.equal(rows[0].sellerWarrantyEndDateAD, '2027-10-30');
    assert.ok(rows[0].sellerWarrantyEndDateBS, 'the export also carries the BS expiry');
    assert.equal(rows[1].sellerWarrantyCoverage, 'Not covered');
    assert.equal(rows[1].sellerWarrantyEndDateAD, '');
    assert.equal(rows[2].sellerWarrantyCoverage, '', 'a quantity-only line has no warranty claim');
    assert.equal(rows[0].branchName, 'Main Branch');
    assert.equal(rows[0].documentStatus, 'Posted');
  });

  test('the register summarises seller warranty and the detail shows the line promise', async () => {
    const realGet = api.getSalesInvoices;
    const invoice = {
      id: 'inv1',
      invoiceNumber: 'INV-1',
      customerId: 'c1',
      customerName: 'Ram Customer',
      branchId: 'b1',
      invoiceDateAD: '2026-10-30',
      invoiceDateBS: '',
      taxableAmount: 2000,
      vatAmount: 260,
      nonTaxableAmount: 0,
      grandTotal: 2260,
      paymentStatus: 'PAID',
      paymentMethod: 'CASH',
      amountPaid: 2260,
      status: 'POSTED',
      items: [
        {
          id: 'i1', productId: 'p1', productName: 'ONU Router', sku: 'ONU-1', unit: 'Pcs',
          quantity: 1, unitPrice: 1000, taxAmount: 130, total: 1130,
          deviceSerials: [{ deviceSerial: 'SN-1', ponSerial: 'PON-1', macAddress: '' }],
          sellerWarrantyCovered: true, sellerWarrantyEndDateAD: '2027-10-30',
        },
        {
          id: 'i2', productId: 'p2', productName: 'Power Adapter', sku: 'ADP-1', unit: 'Pcs',
          quantity: 1, unitPrice: 1000, taxAmount: 130, total: 1130,
          deviceSerials: [{ deviceSerial: 'SN-2', ponSerial: '', macAddress: '' }],
          sellerWarrantyCovered: false,
        },
      ],
    };
    api.getSalesInvoices = async () => ({ data: [invoice], totalItems: 1 }) as any;

    const tree = mountTree(
      createElement(
        DarkModeProvider,
        null,
        createElement(
          DialogProvider,
          null,
          createElement(SalesInvoices, {
            currentUser: user,
            products,
            branches,
            stock,
            selectedBranchId: 'b1',
            dateMode: 'AD',
            activeTab: 'sales-list',
            onCreateInvoice: async () => {},
          } as any)
        )
      )
    );
    try {
      await settle();
      const registerText = String(tree.container.textContent);
      assert.match(registerText, /Seller warranty/, 'the register needs a seller-warranty column');
      assert.match(registerText, /Export CSV/, 'the register needs a CSV export action');
      assert.match(registerText, /Mixed/);
      assert.match(registerText, /1 covered · 1 none/, 'zero buckets should not clutter the summary');
      assert.match(registerText, /covered to 2027-10-30/, 'the mixed summary still names the covered expiry');
      assert.doesNotMatch(registerText, /0 not recorded/);

      const view = [...tree.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('title') === 'View'
      ) as HTMLButtonElement | undefined;
      assert.ok(view, 'the invoice row needs its View action');
      act(() => view!.click());
      await settle();

      const detailText = String(tree.container.textContent);
      assert.match(detailText, /Print Invoice/, 'the detail view must offer the printable layout');
      assert.match(detailText, /Export Invoice CSV/, 'the detail view must export its own lines');
      assert.match(detailText, /Posted/, 'the detail view must name the document lifecycle state');
      assert.match(detailText, /Covered/);
      assert.match(detailText, /2027-10-30/);
      assert.match(detailText, /No warranty/);
      assert.match(detailText, /Seller warranty/, 'the detail table keeps the warranty column heading');
    } finally {
      tree.unmount();
      api.getSalesInvoices = realGet;
    }
  });

  test('the seller-warranty switch prefills, turns off cleanly and turns back on', async () => {
    const realGet = api.getSalesInvoices;
    api.getSalesInvoices = async () => ({ data: [], totalItems: 0 }) as any;
    const tree = mountTree(
      createElement(
        DarkModeProvider,
        null,
        createElement(
          DialogProvider,
          null,
          createElement(SalesInvoices, {
            currentUser: user,
            products,
            branches,
            stock,
            inventorySerials: serials,
            selectedBranchId: 'b1',
            dateMode: 'AD',
            activeTab: 'create-sale',
            onCreateInvoice: async () => {},
          } as any)
        )
      )
    );
    try {
      await settle();

      const headers = [...tree.container.querySelectorAll('h3')].map((h) => (h.textContent || '').trim());
      assert.ok(
        headers.some((text) => text === 'Create Sales Invoice'),
        `the create card must render its own heading, saw: ${headers.join(' | ')}`
      );

      const add = tree.container.querySelector('#sale-add-line') as HTMLButtonElement | null;
      assert.ok(add, 'the create form must offer Add Product to Invoice');
      assert.equal(add!.disabled, false, 'a sellable in-stock product must enable the add button');
      act(() => add!.click());
      await settle();
      assert.ok(
        tree.container.querySelector('table'),
        `adding a line must render the line table; inputs: ${[...tree.container.querySelectorAll('input')]
          .map((i) => i.id || i.type)
          .join(',')}`
      );

      const toggle = tree.container.querySelector(
        'input[id^="sale-warranty-covered-"]'
      ) as HTMLInputElement | null;
      assert.ok(toggle, 'a serialised line must expose the seller-warranty switch');
      assert.equal(toggle!.checked, true, 'a product with a seller term starts covered');

      // The form starts with one blank row, so the added line's index is not 0.
      const suffix = toggle!.id.replace('sale-warranty-covered-', '');
      const expirySelector = `#sale-warranty-${suffix}`;
      const expiry = tree.container.querySelector(expirySelector) as HTMLInputElement | null;
      assert.ok(expiry, 'a covered line shows its expiry');
      assert.equal(
        expiry!.value,
        warrantyEndFor(localTodayAD(), 12),
        'the expiry prefills from the invoice date + the product seller term'
      );

      act(() => toggle!.click());
      await settle();
      assert.equal(tree.container.querySelector(expirySelector), null, 'off removes the date');
      assert.match(String(tree.container.textContent), /No seller warranty/);

      act(() => toggle!.click());
      await settle();
      const restored = tree.container.querySelector(expirySelector) as HTMLInputElement | null;
      assert.ok(restored, 'turning coverage back on restores the date field');
      assert.equal(restored!.value, warrantyEndFor(localTodayAD(), 12));
    } finally {
      tree.unmount();
      api.getSalesInvoices = realGet;
    }
  });
});
