/**
 * A6 — route-tree smoke test.
 *
 * Renders the real App (shell + KeepMounted tab tree) with the api stubbed and
 * proves the contract every root refactor depends on: a tab switch HIDES the
 * screen, it never unmounts it, and local form state survives the round trip.
 * This is the behavioural gate A3/A4 were missing; it fails if a screen
 * remounts on tab switch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findInputByPlaceholder,
  installApiStubs,
  installEventSource,
  isHidden,
  mountAppRouteTree,
  navigateTab,
  seedSession,
  setInputValue,
  settle,
  settleUntil,
} from './harness/appRouteTreeProbe';

const PRODUCT_SEARCH_PLACEHOLDER =
  'Search fixed asset product or asset tag, then press Enter / pick from list...';

test('A6: a tab switch hides the screen, keeps it mounted and preserves its draft', async () => {
  const restoreEventSource = installEventSource();
  seedSession('assign-asset');
  const restoreApi = installApiStubs();
  const tree = mountAppRouteTree();

  try {
    const mounted = await settleUntil(() =>
      Boolean(findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER))
    );
    assert.ok(mounted, 'the Assign Fixed Asset screen must mount in the real route tree');

    const search = findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER);
    assert.ok(search, 'the product search input must exist');
    setInputValue(search, 'ONU ROUTER');
    await settle();
    assert.equal(search.value, 'ONU ROUTER', 'the controlled input must accept the draft');
    assert.equal(isHidden(search), false, 'the active tab must not read as hidden before the switch');

    // Navigate through the app's own event path (the toast "open tab" action).
    navigateTab('dashboard');
    await settle();
    assert.ok(
      isHidden(search),
      'a tab switch must hide the screen, not unmount it (KeepMounted)'
    );
    assert.ok(
      document.contains(search),
      'the hidden screen must stay in the document'
    );

    navigateTab('assign-asset');
    const visibleAgain = await settleUntil(() => !isHidden(search));
    assert.ok(visibleAgain, 'returning to the tab must show it again, not leave it hidden');

    const afterReturn = findInputByPlaceholder(tree.container, PRODUCT_SEARCH_PLACEHOLDER);
    assert.equal(
      afterReturn,
      search,
      'returning to the tab must reuse the same DOM node — a remount would replace it'
    );
    assert.equal(afterReturn?.value, 'ONU ROUTER', 'the draft must survive the round trip');
  } finally {
    tree.unmount();
    restoreApi();
    restoreEventSource();
  }
});
