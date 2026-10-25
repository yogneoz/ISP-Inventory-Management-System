/**
 * Shared customer picker — the control that replaced the two inline copies
 * which filtered the full bootstrap customer array.
 *
 * PROVES:
 *   1. A query shorter than the minimum never reaches the server.
 *   2. Typing is debounced into one directory search and renders the matches.
 *   3. Picking a row (click or keyboard) calls onSelect and shows the label;
 *      clearing calls onSelect(null).
 *   4. A failed search is reported as a failure with Retry — never as "no
 *      matching customer" — and Retry issues the request again.
 *   5. A slow response for an older query cannot overwrite the newer query's
 *      results.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, useState } from 'react';
import { mountTree } from './harness/mount';
import {
  CustomerPicker,
  type CustomerPickerValue,
} from '../client/src/components/common/CustomerPicker';
import type { CustomerRecord } from '../client/src/types';

const customer = (id: string, name: string): CustomerRecord => ({
  id,
  customerId: `CUS-${id}`,
  customerName: name,
  username: name.toLowerCase().replace(/\s+/g, '.'),
  contactNumber: '9800000000',
  branchId: 'WH001',
  address: 'Kathmandu',
  status: 'ACTIVE',
});

const records = [customer('1', 'Example One'), customer('2', 'Example Two')];

const labelFor = (row: CustomerRecord) => `${row.customerName} (${row.customerId})`;

interface HarnessProps {
  search: (query: string) => Promise<CustomerRecord[]>;
  onSelected?: (row: CustomerRecord | null) => void;
}

const Harness = ({ search, onSelected }: HarnessProps) => {
  const [value, setValue] = useState<CustomerPickerValue | null>(null);
  return h(
    'div',
    null,
    h(CustomerPicker, {
      value,
      search,
      debounceMs: 10,
      minChars: 2,
      onSelect: (row) => {
        setValue(row ? { id: row.id, label: labelFor(row) } : null);
        onSelected?.(row);
      },
    }),
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

describe('CustomerPicker', () => {
  test('waits for the minimum query length, then debounces to one search', async () => {
    const calls: string[] = [];
    const search = async (query: string) => {
      calls.push(query);
      return records.filter((row) => row.customerName.toLowerCase().includes(query));
    };
    const tree = mountTree(h(Harness, { search }));
    try {
      type(tree.container, 'e');
      await settle();
      assert.deepEqual(calls, [], 'one character must not query the directory');
      assert.match(tree.container.textContent || '', /Type at least 2 characters/);

      type(tree.container, 'example');
      await settle();
      assert.deepEqual(calls, ['example'], 'the typed query must be sent once');
      assert.equal(options(tree.container).length, 2);
      assert.match(tree.container.textContent || '', /Example One/);
    } finally {
      tree.unmount();
    }
  });

  test('picking a row selects it, and clearing returns null', async () => {
    const selected: Array<CustomerRecord | null> = [];
    const search = async () => records;
    const tree = mountTree(h(Harness, { search, onSelected: (row) => selected.push(row) }));
    try {
      type(tree.container, 'example');
      await settle();

      act(() => options(tree.container)[0].click());
      assert.equal(inputOf(tree.container).value, 'Example One (CUS-1)');
      assert.equal(tree.container.querySelector('[data-testid="selected"]')?.textContent, '1');
      assert.equal(selected.at(-1)?.id, '1');
      assert.equal(options(tree.container).length, 0, 'the result list must close after a pick');

      // Re-focusing a selected field is not a new search: show guidance, not
      // the rows or spinner left over from the query that picked it.
      act(() => inputOf(tree.container).blur());
      act(() => inputOf(tree.container).focus());
      assert.match(tree.container.textContent || '', /Selected: Example One/);
      assert.equal(options(tree.container).length, 0);

      // A half-typed query is not a selection: Escape restores the committed
      // customer, and the parent keeps that FK.
      type(tree.container, 'Customer 9');
      act(() => {
        inputOf(tree.container).dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      assert.equal(inputOf(tree.container).value, 'Example One (CUS-1)');
      assert.equal(tree.container.querySelector('[data-testid="selected"]')?.textContent, '1');

      const clear = [...tree.container.querySelectorAll('button')].find(
        (button) => button.getAttribute('title') === 'Clear customer selection'
      );
      assert.ok(clear, 'a selected customer must offer a clear control');
      act(() => (clear as HTMLButtonElement).click());
      assert.equal(inputOf(tree.container).value, '');
      assert.equal(tree.container.querySelector('[data-testid="selected"]')?.textContent, '');
      assert.equal(selected.at(-1), null);
    } finally {
      tree.unmount();
    }
  });

  test('a failed search offers Retry instead of claiming no matches', async () => {
    let fail = true;
    const calls: string[] = [];
    const search = async (query: string) => {
      calls.push(query);
      if (fail) throw new Error('HTTP 503');
      return records;
    };
    const tree = mountTree(h(Harness, { search }));
    try {
      type(tree.container, 'example');
      await settle();
      const text = tree.container.textContent || '';
      assert.match(text, /Could not search the customer directory/);
      assert.match(text, /HTTP 503/);
      assert.match(text, /Retry/);
      assert.doesNotMatch(text, /No matching customer/);
      assert.equal(options(tree.container).length, 0);

      fail = false;
      const retry = [...tree.container.querySelectorAll('button')].find((button) =>
        (button.textContent || '').includes('Retry')
      );
      assert.ok(retry, 'the failure state must render a Retry button');
      act(() => (retry as HTMLButtonElement).click());
      await settle();

      assert.deepEqual(calls, ['example', 'example']);
      assert.equal(options(tree.container).length, 2);
      assert.match(tree.container.textContent || '', /Example One/);
    } finally {
      tree.unmount();
    }
  });

  test('keyboard arrows and Enter pick a result', async () => {
    const search = async () => records;
    const tree = mountTree(h(Harness, { search }));
    try {
      type(tree.container, 'example');
      await settle();
      const input = inputOf(tree.container);

      // The first row starts highlighted; ArrowDown moves to the second.
      act(() => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      act(() => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      assert.equal(tree.container.querySelector('[data-testid="selected"]')?.textContent, '2');
      assert.equal(input.value, 'Example Two (CUS-2)');
    } finally {
      tree.unmount();
    }
  });

  test('a slow older response cannot overwrite the current query', async () => {
    let resolveSlow: ((rows: CustomerRecord[]) => void) | undefined;
    const slow = new Promise<CustomerRecord[]>((resolve) => {
      resolveSlow = resolve;
    });
    const stale = customer('999', 'Stale Only');
    const search = async (query: string) => (query === 'al' ? slow : records);
    const tree = mountTree(h(Harness, { search }));
    try {
      type(tree.container, 'al');
      await settle(20);
      type(tree.container, 'alp');
      await settle(20);

      assert.match(tree.container.textContent || '', /Example One/);
      assert.doesNotMatch(tree.container.textContent || '', /Stale Only/);

      act(() => resolveSlow?.([stale]));
      await settle(10);

      assert.match(tree.container.textContent || '', /Example One/);
      assert.doesNotMatch(tree.container.textContent || '', /Stale Only/);
    } finally {
      tree.unmount();
    }
  });
});
