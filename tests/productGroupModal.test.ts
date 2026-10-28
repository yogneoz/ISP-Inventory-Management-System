/**
 * The product modal is database-linked (render test).
 *
 * The screenshot this change started from showed a modal whose group select was
 * three hard-coded names, whose category list contained the FILTER sentinel
 * "ALL" (so a new SKU could be saved with category 'ALL' or an empty string),
 * whose unit list was six hard-coded symbols, and which offered a "＋ Type
 * Custom" escape hatch that wrote free text onto the product.
 *
 * PROVES:
 *   1. Product groups come from the managed list — a custom group is offered and
 *      the hard-coded "Fixed Asset" name is not.
 *   2. No "Type Custom" control exists anywhere in the modal.
 *   3. The category select has no 'ALL' option and starts on a disabled
 *      placeholder, so an untouched form cannot submit an empty category.
 *   4. Units come from the UoM table, and there is exactly ONE unit control
 *      (the old form bound "Unit" and "Default Unit" to the same state).
 *   5. The VAT field shows where its default comes from.
 *   6. Editing a product whose category/unit predates the master table keeps the
 *      stored value visible instead of silently rewriting it.
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
  id: 'u-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'SUPER_ADMIN',
  branchId: 'br-a',
} as any;

const groups = [
  { id: 'pg-fixed', code: 'FIXED_ASSET', name: 'Capital Equipment', behavior: 'FIXED_ASSET', sortOrder: 30, active: true, isSystem: true, productCount: 0 },
  { id: 'pg-network', code: 'NETWORK_EQUIPMENT', name: 'Network Equipment', behavior: 'STOCK_ITEM', sortOrder: 50, active: true, isSystem: false, productCount: 0 },
] as any[];

const uoms = [
  { id: 'uom-1', name: 'Pieces', symbol: 'Pcs', type: 'Count', isBaseUnit: true },
  { id: 'uom-2', name: 'Meters', symbol: 'Mtr', type: 'Length', isBaseUnit: true },
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

/** The modal overlay, scoped so the page's own filter selects never match. */
function modalOf(container: HTMLElement): HTMLElement {
  const heading = [...container.querySelectorAll('h3')].find((node) =>
    /Create New Product SKU|Edit Product SKU Specification/.test(node.textContent || '')
  );
  assert.ok(heading, 'the product modal must be open');
  const modal = heading.closest('.fixed') as HTMLElement | null;
  assert.ok(modal, 'the modal overlay must exist');
  return modal!;
}

function optionValues(root: HTMLElement): string[] {
  return [...root.querySelectorAll('option')].map((option) => (option as HTMLOptionElement).value);
}

describe('product modal is database-linked', () => {
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
    api.getProducts = async () => [] as any;
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

  const mountScreen = async () => {
    const tree = mountTree(
      createElement(
        DialogProvider as any,
        null,
        createElement(ProductManagement, {
          currentUser: user,
          stock: [],
          selectedBranchId: 'ALL',
          onCreateProduct: async () => {},
          onUpdateProduct: async () => {},
          onDeleteProduct: async () => {},
          searchQuery: '',
          mode: 'product-master',
        } as any)
      )
    );
    await settle();
    return tree;
  };

  test('groups come from the managed table and every unit/group field is single-sourced', async () => {
    const tree = await mountScreen();
    try {
      const add = findButton(tree.container, /Add New Product SKU/);
      assert.ok(add, 'a Super Admin must see the add button');
      inAct(() => add!.click());
      await settle();

      const modal = modalOf(tree.container);
      const values = optionValues(modal);

      // 1. Managed groups only — the custom group appears, the old literal does not.
      assert.ok(values.includes('Network Equipment'), 'the custom stock group must be offered');
      assert.ok(values.includes('Capital Equipment'), 'the renamed asset group must be offered');
      assert.ok(!values.includes('Fixed Asset'), 'the hard-coded group name must not come back');

      // 2. The custom-category escape hatch is gone.
      assert.doesNotMatch(modal.textContent || '', /Type Custom/i);
      assert.ok(!values.includes('__ADD_NEW_CUSTOM__'));

      // 3. No filter sentinel, and a disabled placeholder blocks an empty submit.
      assert.ok(!values.includes('ALL'), 'the category select must not offer the filter sentinel');
      const categorySelect = [...modal.querySelectorAll('select')].find((select) =>
        [...select.querySelectorAll('option')].some((option) => (option as HTMLOptionElement).value === 'Routers')
      ) as HTMLSelectElement | undefined;
      assert.ok(categorySelect, 'the category select must list DB categories');
      const placeholder = categorySelect!.querySelector('option[value=""]') as HTMLOptionElement | null;
      assert.ok(placeholder?.disabled, 'an untouched category must be a disabled placeholder');
      assert.equal(categorySelect!.getAttribute('required'), '', 'the category select must be required');

      // 4. Units come from UoM, and exactly one control owns the unit value.
      assert.ok(values.includes('Pcs') && values.includes('Mtr'), 'unit options must come from the UoM table');
      assert.ok(!values.includes('Kg'), 'the old hard-coded unit list must be gone');
      assert.doesNotMatch(modal.textContent || '', /Default Unit/, 'the duplicated unit field must be removed');
      const unitControls = [...modal.querySelectorAll('select')].filter((select) =>
        [...select.querySelectorAll('option')].some((option) => (option as HTMLOptionElement).value === 'Pcs')
      );
      assert.equal(unitControls.length, 1, 'the unit must be edited in exactly one place');

      // 5. VAT states its source.
      assert.match(modal.textContent || '', /Company default: 15%/);
    } finally {
      tree.unmount();
    }
  });

  test('editing legacy category/unit values keeps them visible instead of rewriting them', async () => {
    api.getProducts = async () =>
      [
        {
          id: 'p-1',
          sku: 'LEG-1',
          barcode: 'LEG-1',
          name: 'Legacy Router',
          category: 'Legacy Cat',
          productGroup: 'Network Equipment',
          unit: 'Box',
          costPrice: 10,
          sellingPrice: 20,
          taxRate: 13,
          minReorderLevel: 5,
          requiresSerialTracking: true,
        },
      ] as any;

    const tree = await mountScreen();
    try {
      const edit = tree.container.querySelector('button[title="Edit Product Specification"]') as HTMLButtonElement | null;
      assert.ok(edit, 'the catalog row must expose its edit action');
      inAct(() => edit!.click());
      await settle();

      const modal = modalOf(tree.container);
      const selects = [...modal.querySelectorAll('select')] as HTMLSelectElement[];

      const categorySelect = selects.find((select) =>
        [...select.querySelectorAll('option')].some((option) => (option as HTMLOptionElement).value === 'Routers')
      );
      assert.equal(categorySelect?.value, 'Legacy Cat', 'the stored category must stay selected');
      assert.match(categorySelect?.textContent || '', /not in category list/, 'the legacy value must be labelled, not hidden');

      const unitSelect = selects.find((select) =>
        [...select.querySelectorAll('option')].some((option) => (option as HTMLOptionElement).value === 'Mtr')
      );
      assert.equal(unitSelect?.value, 'Box', 'the stored unit must stay selected');
      assert.match(unitSelect?.textContent || '', /not in UoM list/, 'the legacy unit must be labelled, not hidden');
    } finally {
      tree.unmount();
    }
  });
});
