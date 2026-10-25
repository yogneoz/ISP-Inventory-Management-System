/**
 * SearchPicker portal mode — used by the Consumable Issue table, whose
 * horizontal scroll container would clip an absolutely positioned list.
 *
 * PROVES the listbox leaves the screen's container, stays interactive, and a
 * click still commits the selection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, useState } from 'react';
import { mountTree } from './harness/mount';
import { CustomerPicker } from '../client/src/components/common/CustomerPicker';
import type { CustomerRecord } from '../client/src/types';

const customer: CustomerRecord = {
  id: 'c-1',
  customerId: 'CUS-1',
  customerName: 'Portal Customer',
  username: 'portal.customer',
  contactNumber: '9800000000',
  branchId: 'WH001',
  address: 'Kathmandu',
  status: 'ACTIVE',
};

const Harness = () => {
  const [value, setValue] = useState<{ id: string; label: string } | null>(null);
  return h(
    'div',
    { id: 'screen-container' },
    h(CustomerPicker, {
      value,
      search: async () => [customer],
      debounceMs: 5,
      portal: true,
      onSelect: (row) =>
        setValue(row ? { id: row.id, label: `${row.customerName} (${row.customerId})` } : null),
    }),
    h('div', { 'data-testid': 'selected' }, value?.id || '')
  );
};

const settle = async (ms = 30) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

test('portal picker renders and selects from document.body', async () => {
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
      setter.call(input, 'portal');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await settle();

    assert.equal(
      tree.container.querySelector('[role="listbox"]'),
      null,
      'the list must not live inside the clipping container'
    );
    const listbox = document.body.querySelector('[role="listbox"]');
    assert.ok(listbox, 'the list must be portalled to the body');
    const option = listbox.querySelector('[role="option"]') as HTMLElement;
    assert.ok(option, 'the matching row must render in the portal');
    assert.match(option.textContent || '', /Portal Customer/);

    act(() => option.click());
    assert.equal(tree.container.querySelector('[data-testid="selected"]')?.textContent, 'c-1');
    assert.equal(document.body.querySelector('[role="listbox"]'), null);
  } finally {
    tree.unmount();
  }
});
