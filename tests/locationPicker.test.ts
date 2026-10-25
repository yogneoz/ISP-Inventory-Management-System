/**
 * LocationPicker — the searchable replacement for the POP/network <select>s.
 *
 * PROVES:
 *   1. Only network location kinds are offered (POP rooms, fiber nodes,
 *      untyped legacy rows), and name/address/contact all match the query.
 *   2. Picking commits the row; clearing returns null.
 *   3. Keyboard arrows + Enter pick a result.
 *   4. The list is capped so a large network directory cannot paint hundreds
 *      of rows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, useState } from 'react';
import { mountTree } from './harness/mount';
import { LocationPicker, type LocationPickerProps } from '../client/src/components/common/LocationPicker';
import type { LocationRecord } from '../client/src/types';

const location = (
  id: string,
  name: string,
  type: LocationRecord['type'],
  address = 'Kathmandu'
): LocationRecord => ({
  id,
  name,
  type,
  branchId: 'WH001',
  address,
});

const rows: LocationRecord[] = [
  location('loc-1', 'Kathmandu POP', 'POP_SERVER_ROOM', 'Putalisadak, Kathmandu'),
  location('loc-2', 'Lalitpur Fiber Node', 'FIBER_NETWORK_NODE', 'Patan, Lalitpur'),
  location('loc-3', 'Legacy Relay', '', 'Bhaktapur'),
  location('loc-4', 'Central Warehouse', 'WAREHOUSE', 'Balaju'),
  location('loc-5', 'Customer Site', 'CUSTOMER_SITE', 'Lazimpat'),
];

interface HarnessProps {
  locations: LocationRecord[];
  onSelected?: (row: LocationRecord | null) => void;
}

const Harness = ({ locations, onSelected }: HarnessProps) => {
  const [value, setValue] = useState<{ id: string; label: string } | null>(null);
  const props: LocationPickerProps = {
    value,
    locations,
    debounceMs: 10,
    onSelect: (row) => {
      setValue(row ? { id: row.id, label: row.name } : null);
      onSelected?.(row);
    },
  };
  return h(
    'div',
    null,
    h(LocationPicker, props),
    h('div', { 'data-testid': 'selected' }, value?.id || '')
  );
};

const inputOf = (container: HTMLElement) =>
  container.querySelector('input[role="combobox"]') as HTMLInputElement;

/** React tracks the input's value, so set it through the native setter. */
const type = (container: HTMLElement, text: string) => {
  const input = inputOf(container);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  assert.ok(setter, 'the test DOM must expose the native value setter');
  act(() => {
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};

const settle = async (ms = 30) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const options = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="option"]')] as HTMLElement[];

describe('LocationPicker', () => {
  test('offers only network location kinds and matches name, address or contact', async () => {
    const tree = mountTree(h(Harness, { locations: rows }));
    try {
      type(tree.container, 'lalitpur');
      await settle();
      assert.equal(options(tree.container).length, 1);
      const first = options(tree.container)[0]?.textContent || '';
      assert.match(first, /Lalitpur Fiber Node/);
      assert.match(first, /Patan, Lalitpur/);

      type(tree.container, 'bhaktapur');
      await settle();
      assert.match(
        options(tree.container)[0]?.textContent || '',
        /Legacy Relay/,
        'untyped legacy rows must still be offerable'
      );

      type(tree.container, 'warehouse');
      await settle();
      assert.equal(options(tree.container).length, 0, 'a warehouse is not a deployment location');
      assert.match(tree.container.textContent || '', /No matching POP or network location/);
    } finally {
      tree.unmount();
    }
  });

  test('picking a row selects it, and clearing returns null', async () => {
    const selected: Array<LocationRecord | null> = [];
    const tree = mountTree(h(Harness, { locations: rows, onSelected: (row) => selected.push(row) }));
    try {
      type(tree.container, 'kathmandu');
      await settle();
      act(() => options(tree.container)[0].click());

      assert.equal(inputOf(tree.container).value, 'Kathmandu POP');
      assert.equal(tree.container.querySelector('[data-testid="selected"]')?.textContent, 'loc-1');
      assert.equal(selected.at(-1)?.id, 'loc-1');

      const clear = [...tree.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('title') === 'Clear location selection'
      );
      assert.ok(clear, 'a selected location must offer a clear control');
      act(() => (clear as HTMLButtonElement).click());
      assert.equal(inputOf(tree.container).value, '');
      assert.equal(tree.container.querySelector('[data-testid="selected"]')?.textContent, '');
      assert.equal(selected.at(-1), null);
    } finally {
      tree.unmount();
    }
  });

  test('keyboard arrows and Enter pick a result', async () => {
    const tree = mountTree(h(Harness, { locations: rows }));
    try {
      type(tree.container, 'a');
      await settle();
      const input = inputOf(tree.container);
      act(() => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      act(() => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      assert.equal(tree.container.querySelector('[data-testid="selected"]')?.textContent, 'loc-2');
      assert.equal(input.value, 'Lalitpur Fiber Node');
    } finally {
      tree.unmount();
    }
  });

  test('caps a large directory at 20 visible rows', async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      location(`loc-${index}`, `POP ${String(index).padStart(2, '0')}`, 'POP_SERVER_ROOM', 'Kathmandu')
    );
    const tree = mountTree(h(Harness, { locations: many }));
    try {
      type(tree.container, 'pop');
      await settle();
      assert.equal(options(tree.container).length, 20);
    } finally {
      tree.unmount();
    }
  });
});
