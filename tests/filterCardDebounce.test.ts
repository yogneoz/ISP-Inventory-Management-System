/**
 * FilterCard — an immediate apply cancels the pending typing pause.
 *
 * FilterCard runs its search after a pause (`debounceMs`), while Enter and the
 * Clear button apply at once. Both immediate paths clear the pause timer before
 * applying; without that the search they already applied ran a second time a
 * moment later. It is the same duplicate-lookup shape that made the DF-15
 * serial test flaky (tests/df15SerialLookupFailure.test.ts), where the late
 * timer flipped a finished result back to "Checking…".
 *
 * PROVES:
 *   1. ENTER — applies the typed text immediately, exactly once; the cancelled
 *      pause never fires afterwards.
 *   2. CLEAR — applies "" immediately, exactly once; the cancelled pause never
 *      applies the stale typed text.
 *   3. TYPING — a pause with no immediate apply still reaches the table, so the
 *      behaviour guarded here is the cancel, not a removed feature.
 *
 * Timing is deterministic: typing and Enter/click happen in consecutive
 * synchronous act() calls, and a timer cannot run between them (JavaScript is
 * single-threaded), so the pause is always still pending when Enter or Clear
 * cancels it. The wait afterwards is what a leaked timer would need to fire.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h } from 'react';
import { mountTree } from './harness/mount';
import { FilterCard } from '../client/src/components/common/FilterCard';

const DEBOUNCE_MS = 40;
/** Comfortably past DEBOUNCE_MS: a timer left armed would have fired by now. */
const PAST_DEBOUNCE_MS = 160;

/**
 * Type into a controlled React input the way the browser does (input event).
 * The setter must come from the harness's jsdom constructor: `dom.ts` installs
 * `window` but not a global `HTMLInputElement`.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const InputCtor = (globalThis as any).window.HTMLInputElement as typeof HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(InputCtor.prototype, 'value')!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const pause = () => new Promise((resolve) => setTimeout(resolve, PAST_DEBOUNCE_MS));

function mountCard(applied: string[]) {
  return mountTree(
    h(FilterCard, {
      searchPlaceholder: 'Search',
      onSearchApply: (query: string) => applied.push(query),
      searchValue: '',
      onClearAll: () => {},
      hasActiveFilters: false,
      debounceMs: DEBOUNCE_MS,
    })
  );
}

const inputOf = (container: HTMLElement) =>
  container.querySelector('input[type="text"]') as HTMLInputElement;

const clearButtonOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.getAttribute('title') === 'Clear search'
  ) ?? null;

describe('FilterCard — an immediate apply cancels the pending pause', () => {
  test('Enter applies the typed text once and cancels the pause', async () => {
    const applied: string[] = [];
    const tree = mountCard(applied);
    const input = inputOf(tree.container);

    act(() => typeInto(input, 'router'));
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    assert.deepEqual(applied, ['router'], 'Enter applies the typed text immediately');
    await act(pause);
    assert.deepEqual(applied, ['router'], 'the cancelled pause must not apply it a second time');

    tree.unmount();
  });

  test('Clear applies the empty search once and never the stale text', async () => {
    const applied: string[] = [];
    const tree = mountCard(applied);

    act(() => typeInto(inputOf(tree.container), 'router'));
    const clear = clearButtonOf(tree.container);
    assert.ok(clear, 'the clear button appears once the draft has text');
    act(() => {
      clear!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    assert.deepEqual(applied, [''], 'Clear applies the empty search immediately');
    await act(pause);
    assert.deepEqual(applied, [''], 'the cancelled pause must not apply the stale typed text');

    tree.unmount();
  });

  test('typing with no immediate apply still reaches the table after the pause', async () => {
    const applied: string[] = [];
    const tree = mountCard(applied);

    act(() => typeInto(inputOf(tree.container), 'router'));
    assert.deepEqual(applied, [], 'nothing is applied during the pause');
    await act(pause);
    assert.deepEqual(applied, ['router'], 'the pause still applies a search the user did not submit');

    tree.unmount();
  });
});

describe('FilterCard — the live search draft is reported before it is applied', () => {
  const mountDraftCard = (
    drafts: string[],
    applied: string[],
    searchValue = ''
  ) =>
    mountTree(
      h(FilterCard, {
        searchPlaceholder: 'Search',
        onSearchApply: (query: string) => applied.push(query),
        onSearchDraftChange: (draft: string) => drafts.push(draft),
        searchValue,
        onClearAll: () => {},
        hasActiveFilters: false,
        debounceMs: DEBOUNCE_MS,
      })
    );

  test('typing reports the draft at once, before the pause applies it', async () => {
    const applied: string[] = [];
    const drafts: string[] = [];
    const tree = mountDraftCard(drafts, applied);
    assert.deepEqual(drafts, [''], 'the initial applied value is reported on mount');

    act(() => typeInto(inputOf(tree.container), 'router'));
    assert.deepEqual(drafts, ['', 'router'], 'an export sink sees the keystroke immediately');
    assert.deepEqual(applied, [], 'the table still waits for the pause');

    await act(pause);
    assert.deepEqual(applied, ['router'], 'the pause applies the same text afterwards');
    assert.deepEqual(drafts, ['', 'router'], 'applying it does not report a duplicate draft');

    tree.unmount();
  });

  test('Clear reports the empty draft with the immediate apply', () => {
    const applied: string[] = [];
    const drafts: string[] = [];
    const tree = mountDraftCard(drafts, applied);

    act(() => typeInto(inputOf(tree.container), 'router'));
    act(() => {
      clearButtonOf(tree.container)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    assert.deepEqual(applied, [''], 'Clear still applies immediately');
    assert.equal(drafts[drafts.length - 1], '', 'the export sink sees the cleared input');

    tree.unmount();
  });

  test('a searchValue reset from outside re-reports the draft', () => {
    const applied: string[] = [];
    const drafts: string[] = [];
    const tree = mountDraftCard(drafts, applied, 'alpha');
    assert.deepEqual(drafts, ['alpha'], 'mount reports the applied value the card starts with');

    tree.rerender(
      h(FilterCard, {
        searchPlaceholder: 'Search',
        onSearchApply: (query: string) => applied.push(query),
        onSearchDraftChange: (draft: string) => drafts.push(draft),
        searchValue: '',
        onClearAll: () => {},
        hasActiveFilters: false,
        debounceMs: DEBOUNCE_MS,
      })
    );

    assert.deepEqual(drafts, ['alpha', ''], 'Clear all filters resets the export sink too');

    tree.unmount();
  });
});
