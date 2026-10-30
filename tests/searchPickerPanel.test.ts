/**
 * Search-picker result panel — the list is not sized like the form field.
 *
 * WHY
 * Every directory picker used to open a list exactly as wide as its input. In a
 * two-column form that is 160-260 px, so a customer's name, code, phone and
 * address were ellipsized by `truncate` — the row hid the very data the operator
 * had just searched for. Shrinking the font would not help: the phone and
 * address shared one `truncate` line.
 *
 * THE POLICY
 *   - the list is at least 320 px wide, even when the field is narrower;
 *   - it never exceeds the field's own width above that, nor 480 px, nor the
 *     space between the viewport gutters;
 *   - a field near the right edge shifts the list left instead of running off
 *     screen;
 *   - rows wrap (`break-words`) instead of truncating at any width.
 *
 * PROVES:
 *   1. A narrow field opens a list at the readable floor, still aligned to it.
 *   2. A wide field is capped by the maximum, not stretched to page width.
 *   3. A field near the right edge shifts the list so it fits on screen.
 *   4. A viewport narrower than the floor keeps both gutters.
 *   5. Rendered customer rows carry the name, code, phone and address with no
 *      ellipsis class, in a panel wider than the field.
 *   6-7. The row renderers that used to ellipsize — customer, location, the
 *      returns invoice picker and the two supplier dropdowns — never
 *      reintroduce `truncate`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement as h, useState } from 'react';
import { mountTree } from './harness/mount';
import {
  SEARCH_PANEL_MAX_WIDTH,
  SEARCH_PANEL_MIN_WIDTH,
  computeSearchPanelBox,
} from '../client/src/components/common/SearchPicker';
import { CustomerPicker } from '../client/src/components/common/CustomerPicker';
import type { CustomerRecord } from '../client/src/types';

const VIEWPORT = { width: 1400, height: 900 };

const customer: CustomerRecord = {
  id: 'c-1',
  customerId: 'CUS-1042',
  customerName: 'Kathmandu Network Supplies and Service Centre',
  username: 'kathmandu.supplies',
  contactNumber: '9801234567',
  branchId: 'WH001',
  address: 'Ward 10, New Baneshwor, Kathmandu',
  status: 'ACTIVE',
};

describe('SearchPicker panel box', () => {
  test('a narrow field opens a panel at the readable floor, aligned to it', () => {
    assert.deepEqual(
      computeSearchPanelBox({ left: 100, width: 160 }, VIEWPORT),
      { width: SEARCH_PANEL_MIN_WIDTH, left: 100 }
    );
  });

  test('a wide field is capped by the panel maximum', () => {
    assert.deepEqual(
      computeSearchPanelBox({ left: 100, width: 700 }, VIEWPORT),
      { width: SEARCH_PANEL_MAX_WIDTH, left: 100 }
    );
  });

  test('a field near the right edge shifts the panel to stay on screen', () => {
    const { width, left } = computeSearchPanelBox({ left: 1200, width: 160 }, VIEWPORT);
    assert.equal(width, SEARCH_PANEL_MIN_WIDTH);
    assert.ok(
      left + width <= VIEWPORT.width - 8,
      `panel ${left}+${width} must end before the right gutter`
    );
    assert.equal(left, VIEWPORT.width - SEARCH_PANEL_MIN_WIDTH - 8);
  });

  test('a viewport narrower than the floor keeps both gutters', () => {
    assert.deepEqual(computeSearchPanelBox({ left: 20, width: 160 }, { width: 300, height: 640 }), {
      width: 284,
      left: 8,
    });
  });
});

const Harness = () => {
  const [value, setValue] = useState<{ id: string; label: string } | null>(null);
  return h(CustomerPicker, {
    value,
    search: async () => [customer],
    debounceMs: 5,
    onSelect: (row) => setValue(row ? { id: row.id, label: row.customerName } : null),
  });
};

const settle = async (ms = 30) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

describe('SearchPicker result rows', () => {
  test('customer results are wider than the field and show every field', async () => {
    const tree = mountTree(h(Harness));
    try {
      const input = tree.container.querySelector('input[role="combobox"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      assert.ok(setter);
      act(() => {
        input.focus();
        setter.call(input, 'kathmandu');
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await settle();

      const listbox = tree.container.querySelector('[role="listbox"]') as HTMLElement;
      assert.ok(listbox, 'the result list must render');
      assert.equal(
        listbox.style.width,
        `${SEARCH_PANEL_MIN_WIDTH}px`,
        'the list must use the readable floor, not the field width'
      );

      const row = listbox.querySelector('[role="option"]') as HTMLElement;
      assert.ok(row);
      const text = row.textContent || '';
      assert.match(text, /Kathmandu Network Supplies/);
      assert.match(text, /CUS-1042/);
      assert.match(text, /9801234567/);
      assert.match(text, /New Baneshwor, Kathmandu/);
      assert.equal(
        row.querySelectorAll('.truncate').length,
        0,
        'a result row must wrap, never ellipsize'
      );
    } finally {
      tree.unmount();
    }
  });

  test('the search-result rows wrap instead of truncating', () => {
    const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
    for (const file of [
      'client/src/components/common/CustomerPicker.tsx',
      'client/src/components/common/LocationPicker.tsx',
    ]) {
      assert.doesNotMatch(read(file), /\btruncate\b/, `${file} must not clip result rows`);
    }

    const returns = read('client/src/features/sales/ReturnsRegister.tsx');
    const start = returns.indexOf('renderOption={(inv)');
    assert.ok(start > 0, 'ReturnsRegister lost its invoice picker rows');
    const block = returns.slice(start, start + 900);
    assert.match(block, /break-words/, 'the invoice row must wrap');
    assert.doesNotMatch(block, /\btruncate\b/, 'the invoice row must not clip');

    // The two forms with a bespoke supplier dropdown (they do not use
    // SearchPicker): the vendor name is the identifying data, so it wraps too.
    for (const file of [
      'client/src/features/procurement/PurchaseInvoiceForm.tsx',
      'client/src/features/procurement/PurchaseOrderForm.tsx',
    ]) {
      const source = read(file);
      const dropdown = source.indexOf('filteredSuppliers.map');
      assert.ok(dropdown > 0, `${file} lost its supplier dropdown rows`);
      const rows = source.slice(dropdown, dropdown + 1600);
      assert.match(rows, /break-words/, `${file} must wrap the supplier name`);
      assert.doesNotMatch(rows, /\btruncate\b/, `${file} must not clip the supplier row`);
    }
  });
});
