/**
 * The product form's warranty defaults (render test, WTY-3).
 *
 * The screenshot-driven product work made the group, category, unit and VAT
 * database-linked, but the two warranty terms were still fixed at 12. The
 * fields now carry real per-product defaults, and — because the form is the
 * only place an operator sets them — the browser must enforce the same rule as
 * the API before a request leaves the page.
 *
 * PROVES:
 *   1. A new SKU starts at 12/12 (the API's create default).
 *   2. Editing a product shows its stored terms, including 0.
 *   3. 121 is refused client-side, names the supplier field, and never calls
 *      the update handler.
 *   4. A valid correction submits both terms (0 included) and closes the modal.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { ProductManagement } from '../client/src/features/inventory/ProductManagement';
import { api } from '../client/src/services/api';
import { setDefaultTaxRate } from '../client/src/utils/taxConfig';
import { setProductGroups } from '../client/src/utils/productGroupBehavior';

const user = {
  id: 'u-wty',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'SUPER_ADMIN',
  branchId: 'br-a',
} as any;

const groups = [
  { id: 'pg-network', code: 'NETWORK_EQUIPMENT', name: 'Network Equipment', behavior: 'STOCK_ITEM', sortOrder: 50, active: true, isSystem: false, productCount: 0 },
] as any[];

const uoms = [{ id: 'uom-1', name: 'Pieces', symbol: 'Pcs', type: 'Count', isBaseUnit: true }] as any[];

const product = {
  id: 'p-warranty',
  sku: 'WRT-FORM-1',
  barcode: 'WRT-FORM-1',
  name: 'Warranty Router',
  category: 'Routers',
  productGroup: 'Network Equipment',
  unit: 'Pcs',
  costPrice: 100,
  sellingPrice: 150,
  taxRate: 13,
  minReorderLevel: 1,
  requiresSerialTracking: false,
  vendorWarrantyMonths: 24,
  sellerWarrantyMonths: 0,
} as any;

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

/** React's controlled-input change, via the native setter the tracker watches. */
function setNumberInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  inAct(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

/** The product modal, scoped so the dialog host's own live region never matches. */
function modalOf(container: HTMLElement): HTMLElement {
  const heading = [...container.querySelectorAll('h3')].find((node) =>
    /Create New Product SKU|Edit Product SKU Specification/.test(node.textContent || '')
  );
  assert.ok(heading, 'the product modal must be open');
  const modal = heading!.closest('.fixed') as HTMLElement | null;
  assert.ok(modal, 'the modal overlay must exist');
  return modal!;
}

function warrantyInputs(container: HTMLElement): { vendor: HTMLInputElement; seller: HTMLInputElement } {
  const vendor = container.querySelector('input[aria-label="Suppliers warranty months"]') as HTMLInputElement | null;
  const seller = container.querySelector('input[aria-label="Sellers warranty months"]') as HTMLInputElement | null;
  assert.ok(vendor, 'the supplier warranty field must be rendered');
  assert.ok(seller, 'the seller warranty field must be rendered');
  return { vendor: vendor!, seller: seller! };
}

describe('product form warranty defaults', () => {
  const real = {
    getCategories: api.getCategories,
    getProducts: api.getProducts,
    getProductGroups: api.getProductGroups,
    getUoms: api.getUoms,
  };

  beforeEach(() => {
    setDefaultTaxRate(15);
    setProductGroups(groups as any);
    api.getCategories = async () => [{ id: 'c1', name: 'Routers', code: 'RTR' }] as any;
    api.getProducts = async () => [product] as any;
    api.getProductGroups = async () => groups as any;
    api.getUoms = async () => uoms as any;
  });

  afterEach(() => {
    api.getCategories = real.getCategories;
    api.getProducts = real.getProducts;
    api.getProductGroups = real.getProductGroups;
    api.getUoms = real.getUoms;
    setDefaultTaxRate(13);
    setProductGroups(undefined);
  });

  async function mountScreen(onUpdateProduct: (id: string, payload: any) => Promise<void>) {
    const tree = mountTree(
      createElement(
        DialogProvider as any,
        null,
        createElement(ProductManagement, {
          currentUser: user,
          stock: [],
          selectedBranchId: 'ALL',
          onCreateProduct: async () => {},
          onUpdateProduct,
          onDeleteProduct: async () => {},
          searchQuery: '',
          mode: 'product-master',
        } as any)
      )
    );
    await settle();
    return tree;
  }

  test('a new SKU starts at 12/12', async () => {
    const tree = await mountScreen(async () => {});
    try {
      const add = findButton(tree.container, /Add New Product SKU/);
      assert.ok(add, 'a Super Admin must see the add action');
      inAct(() => add!.click());
      await settle();

      const { vendor, seller } = warrantyInputs(tree.container);
      assert.equal(vendor.value, '12');
      assert.equal(seller.value, '12');
    } finally {
      tree.unmount();
    }
  });

  test('editing shows the stored terms, refuses 121, then submits the correction', async () => {
    const calls: Array<{ id: string; payload: any }> = [];
    const tree = await mountScreen(async (id, payload) => {
      calls.push({ id, payload });
    });
    try {
      const edit = tree.container.querySelector('button[title="Edit Product Specification"]') as HTMLButtonElement | null;
      assert.ok(edit, 'the catalog row must expose its edit action');
      inAct(() => edit!.click());
      await settle();

      const { vendor, seller } = warrantyInputs(tree.container);
      assert.equal(vendor.value, '24', 'the stored supplier term must load');
      assert.equal(seller.value, '0', 'the stored seller term (0 = none) must load');

      // Out of range: blocked in the browser, named field, no request.
      setNumberInput(vendor, '121');
      const update = findButton(tree.container, /Update Product/);
      assert.ok(update, 'the modal must offer its submit action');
      inAct(() => update!.click());
      await settle();

      assert.equal(calls.length, 0, 'an invalid term must not reach the API');
      const alert = modalOf(tree.container).querySelector('[role="alert"]') as HTMLElement | null;
      assert.ok(alert, 'the block must be explained next to the fields');
      assert.match(alert!.textContent || '', /Suppliers warranty/i);
      assert.match(alert!.textContent || '', /whole number of months/i);

      // Valid: the payload carries both terms, including 0.
      setNumberInput(vendor, '3');
      assert.equal(modalOf(tree.container).querySelector('[role="alert"]'), null, 'editing clears the stale error');
      inAct(() => findButton(tree.container, /Update Product/)!.click());
      await settle();

      assert.equal(calls.length, 1, 'a valid edit submits once');
      assert.equal(calls[0].id, 'p-warranty');
      assert.equal(calls[0].payload.vendorWarrantyMonths, 3);
      assert.equal(calls[0].payload.sellerWarrantyMonths, 0);
      assert.equal(
        [...tree.container.querySelectorAll('h3')].some((node) => /Edit Product SKU Specification/.test(node.textContent || '')),
        false,
        'the modal closes after a successful save'
      );
    } finally {
      tree.unmount();
    }
  });
});
