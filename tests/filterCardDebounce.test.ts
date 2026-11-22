/**
 * FilterCard — the table is filtered only by a committed search.
 *
 * Typing must never re-query a register: a new search is a new keyset walk, so
 * it restarts at page 1 and re-reads the register's totals. The settle timer is
 * kept for the preview read only; the table changes on Enter, the always-visible
 * Filter button, or Clear. Committing the term the table already uses (trimmed
 * comparison) is a no-op.
 *
 * PROVES:
 *   1. ENTER — applies the typed text immediately, exactly once.
 *   2. CLEAR — applies "" immediately, exactly once.
 *   3. A SQUARE SETTLE — feeds the preview and never the table.
 *   4. FILTER BUTTON — commits the typed text (and cancels the pending preview).
 *   5. SAME TERM — committing it re-queries nothing.
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
import { FilterCard, type SearchPreviewItem } from '../client/src/components/common/FilterCard';

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

const filterButtonOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Filter'
  ) ?? null;

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

  test('a settle asks the preview and never the table', async () => {
    const applied: string[] = [];
    const asked: string[] = [];
    const tree = mountTree(
      h(FilterCard, {
        searchPlaceholder: 'Search',
        onSearchApply: (query: string) => applied.push(query),
        searchValue: '',
        onClearAll: () => {},
        hasActiveFilters: false,
        debounceMs: DEBOUNCE_MS,
        fetchPreview: (query: string) => {
          asked.push(query);
          return Promise.resolve([]);
        },
      })
    );

    act(() => typeInto(inputOf(tree.container), 'router'));
    assert.deepEqual(applied, [], 'nothing is applied during the pause');
    await act(pause);
    assert.deepEqual(applied, [], 'a settle must not re-query the table (it resets the walk)');
    assert.deepEqual(asked, ['router'], 'the settle asks the preview for the typed term');

    tree.unmount();
  });
});

describe('FilterCard — the table filters only when the search is committed', () => {
  test('a settle previews, the Filter button commits, and the applied term is never re-queried', async () => {
    const applied: string[] = [];
    // searchValue stays what the table is already filtered by; the card owns the
    // input buffer, exactly as a register wires it.
    const tree = mountTree(
      h(FilterCard, {
        searchPlaceholder: 'Search',
        onSearchApply: (query: string) => applied.push(query),
        searchValue: 'onu',
        onClearAll: () => {},
        hasActiveFilters: false,
      })
    );
    const input = inputOf(tree.container);

    // The commit control is always on screen (disabled when there is nothing to
    // commit), so revealing it never reflows the header row.
    const filterButton = filterButtonOf(tree.container);
    assert.ok(filterButton, 'the Filter button is always rendered');
    assert.equal(filterButton!.disabled, true, 'nothing to filter yet: the table already uses "onu"');

    act(() => typeInto(input, 'on'));
    assert.equal(filterButtonOf(tree.container)!.disabled, false, 'typing arms the commit control');

    // Past the default settle window: the preview is asked, the table is not.
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    assert.deepEqual(applied, [], 'a settle must not reset the walk: only a commit filters the table');

    act(() => {
      filterButtonOf(tree.container)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.deepEqual(applied, ['on'], 'the Filter button commits the typed term');

    // Back to the applied term: a commit is a no-op, however it is submitted.
    act(() => typeInto(input, 'onu '));
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    assert.equal(
      filterButtonOf(tree.container)!.disabled,
      true,
      'a trailing space is the same term: nothing to commit'
    );
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.deepEqual(applied, ['on'], 'committing the term the table already uses re-queries nothing');

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
    assert.deepEqual(applied, [], 'the table waits for a commit, not a pause');

    await act(pause);
    assert.deepEqual(applied, [], 'the pause never reaches the table');
    assert.deepEqual(drafts, ['', 'router'], 'no duplicate draft is reported by a settle');

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

    assert.deepEqual(drafts, ['alpha', ''], 'Clear all filters reset the export sink too');

    tree.unmount();
  });
});

describe('FilterCard — the settled draft previews matches under the box', () => {
  test('matches overlay the card, picking one commits it, and nothing else moves', async () => {
    const applied: string[] = [];
    const asked: string[] = [];
    let release: ((items: SearchPreviewItem[]) => void) | null = null;
    const tree = mountTree(
      h(FilterCard, {
        searchPlaceholder: 'Search',
        onSearchApply: (query: string) => applied.push(query),
        searchValue: '',
        onClearAll: () => {},
        hasActiveFilters: false,
        debounceMs: DEBOUNCE_MS,
        fetchPreview: (query: string) =>
          new Promise<SearchPreviewItem[]>((resolve) => {
            asked.push(query);
            release = resolve;
          }),
      })
    );
    const container = tree.container;
    const input = inputOf(container);

    act(() => typeInto(input, 'onu'));
    assert.deepEqual(asked, [], 'typing alone asks for nothing');
    assert.equal(container.querySelector('[role="listbox"]'), null, 'no list before the settle');

    await act(pause);
    assert.deepEqual(asked, ['onu'], 'the settled draft is the preview term');
    assert.deepEqual(applied, [], 'the table is untouched by the preview');
    assert.ok(container.querySelector('[role="listbox"]'), 'the list opens as an overlay');

    await act(async () => {
      release!([
        { id: 's1', label: 'ONU-100', detail: 'ONU Router · BR-1', meta: 'IN_STOCK' },
        { id: 's2', label: 'ONU-200', detail: 'ONU Router · BR-2', meta: 'SOLD' },
      ]);
    });
    const options = Array.from(container.querySelectorAll('[role="option"]')) as HTMLElement[];
    assert.equal(options.length, 2, 'every match gets a row');
    assert.match(options[0].textContent || '', /ONU-100/);
    assert.match(options[0].textContent || '', /IN_STOCK/);
    assert.deepEqual(applied, [], 'showing matches still filters nothing');

    act(() => {
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.deepEqual(applied, ['ONU-100'], 'picking a match commits it, once');
    assert.equal(input.value, 'ONU-100', 'the box shows the picked term');
    assert.equal(container.querySelector('[role="listbox"]'), null, 'the list closes on pick');

    tree.unmount();
  });
});
