/**
 * A1 — measured before/after: kept-mounted screens and unrelated root state.
 *
 * A real `react-dom` render (jsdom) counts how many times each screen BODY runs.
 * The same probe tree is mounted twice:
 *
 *   - `memoized: false` → PlainSlot, the pre-A1 container (`{everVisible ? children : null}`)
 *   - `memoized: true`  → the shipped KeepMounted
 *
 * Scenario: visit every tab once (so all four are mounted and hidden, exactly
 * like App after a user has clicked around), then type 10 characters into the
 * "global search" state.
 *
 * Before A1 every keystroke re-rendered all four screens (40 screen renders).
 * After A1 only the screen that consumes the query re-renders (10), and the
 * counters are the same for a real data change and for tab switching — which is
 * the behaviour that must NOT change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { inAct, mountTree } from './harness/mount';
import { Probe, StateProbe, createProbeHandles } from './harness/keepMountedProbe';
import type { ProbeHandles } from './harness/keepMountedProbe';

const TABS = ['dashboard', 'sales', 'ledger', 'search'] as const;

interface Scenario {
  initial: Record<string, number>;
  afterVisits: Record<string, number>;
  afterTyping: Record<string, number>;
  afterRows: Record<string, number>;
  handles: ProbeHandles;
}

function scenario(memoized: boolean): Scenario {
  const handles = createProbeHandles();
  const tree = mountTree(h(Probe, { memoized, handles }));

  assert.ok(handles.api, 'the probe must expose its state setters');
  const api = () => handles.api!;

  const snapshot = () => ({ ...handles.renders });
  const initial = snapshot();

  // Visit every tab once, ending back on dashboard: all four are now mounted.
  for (const tab of ['sales', 'ledger', 'search', 'dashboard']) {
    inAct(() => api().showTab(tab));
  }
  const afterVisits = snapshot();

  for (let keystroke = 0; keystroke < 10; keystroke += 1) {
    inAct(() => api().type(`q${keystroke}`));
  }
  const afterTyping = snapshot();

  // A real data change must still reach every screen, hidden or not.
  inAct(() => api().setRows([1, 2, 3, 4]));
  const afterRows = snapshot();

  tree.unmount();
  return { initial, afterVisits, afterTyping, afterRows, handles };
}

const delta = (from: Record<string, number>, to: Record<string, number>, key: string) =>
  (to[key] ?? 0) - (from[key] ?? 0);

describe('A1 — typing in the global search box', () => {
  const before = scenario(false);
  const after = scenario(true);

  test('before A1 every opened screen re-rendered on every keystroke', () => {
    const renders = TABS.map((tab) => delta(before.afterVisits, before.afterTyping, tab));
    assert.deepEqual(renders, [10, 10, 10, 10]);
    assert.equal(
      renders.reduce((sum, n) => sum + n, 0),
      40,
      'baseline: 4 mounted screens × 10 keystrokes'
    );
  });

  test('after A1 only the screen consuming the query re-renders (shell only otherwise)', () => {
    const renders = TABS.map((tab) => delta(after.afterVisits, after.afterTyping, tab));
    assert.deepEqual(
      renders,
      [0, 0, 0, 10],
      'dashboard/sales/ledger must not re-render; the search screen still does'
    );
    assert.equal(
      renders.reduce((sum, n) => sum + n, 0),
      10,
      'after: 1 screen × 10 keystrokes (was 40)'
    );
  });

  test('the shells that must stay reactive still are: a rows change reaches all four screens', () => {
    for (const scenarioRun of [before, after]) {
      const renders = TABS.map((tab) => delta(scenarioRun.afterTyping, scenarioRun.afterRows, tab));
      assert.deepEqual(renders, [1, 1, 1, 1]);
      assert.deepEqual(scenarioRun.handles.rowLengths, {
        dashboard: 4,
        sales: 4,
        ledger: 4,
        search: 4,
      });
    }
  });
});

describe('A1 — tab switching is unchanged', () => {
  const before = scenario(false);
  const after = scenario(true);

  test('mount cost is identical: one render per screen on first activation', () => {
    for (const run of [before, after]) {
      for (const tab of TABS) {
        assert.equal(run.initial[tab] ?? 0, tab === 'dashboard' ? 1 : 0);
      }
    }
  });

  test('visiting every tab produces the same render counts with and without memoisation', () => {
    assert.deepEqual(after.afterVisits, before.afterVisits);
  });

  test('no screen remounts on a switch, and useActivationKey still ticks on re-activation', () => {
    assert.equal(after.handles.activations.dashboard, 2, 'dashboard: mount, then re-activated');
    assert.equal(after.handles.activations.sales, 1);
    assert.equal(after.handles.activations.ledger, 1);
    assert.equal(after.handles.activations.search, 1);

    // Same contract as before A1.
    assert.deepEqual(after.handles.activations, before.handles.activations);
  });

  test('a switch does not reset a screen’s internal state (keep-mounted contract)', () => {
    // The probe screens are stateless; the observable keep-mounted contract is
    // that their bodies ran the same number of times as before memoisation, so
    // nothing was re-mounted/discarded by the element cache.
    assert.equal(after.afterVisits.dashboard, before.afterVisits.dashboard);
  });
});

describe('A1 — the mounted DOM still reflects current props', () => {
  test('hidden screens are display:none and inert, visible one is not', () => {
    const handles = createProbeHandles();
    const tree = mountTree(h(Probe, { memoized: true, handles }));

    const slots = Array.from(tree.container.querySelectorAll('div[aria-hidden]'));
    const hidden = slots.filter((slot) => slot.getAttribute('aria-hidden') === 'true');
    const shown = slots.filter((slot) => slot.getAttribute('aria-hidden') !== 'true');

    assert.equal(shown.length, 1, 'exactly one tab is visible');
    assert.deepEqual(
      hidden.map((slot) => (slot as HTMLElement).style.display),
      hidden.map(() => 'none')
    );
    assert.equal(
      (shown[0] as HTMLElement).style.display,
      '',
      'the visible tab must not be display:none'
    );

    inAct(() => handles.api!.showTab('sales'));
    const visibleAfter = Array.from(tree.container.querySelectorAll('div[aria-hidden="false"]'));
    assert.equal(visibleAfter.length, 1);

    tree.unmount();
  });

  test('a screen’s own state survives root re-renders and tab switches', () => {
    const handles = createProbeHandles();
    const tree = mountTree(h(StateProbe, { memoized: true, handles }));
    const count = () => tree.container.querySelector('[data-count]')?.getAttribute('data-count');
    const increment = () => tree.container.querySelector('button')!;

    inAct(() => increment().click());
    inAct(() => increment().click());
    assert.equal(count(), '2', 'precondition: the screen owns its counter');

    // A root-level state change that does not touch this screen at all.
    inAct(() => handles.api!.type('abc'));
    assert.equal(count(), '2', 'a memoised root re-render must not reset screen state');

    // Leave the tab and come back: keep-mounted semantics, not a remount.
    inAct(() => handles.api!.showTab('state-b'));
    inAct(() => handles.api!.showTab('state-a'));
    assert.equal(count(), '2', 'switching away and back must not reset screen state');

    tree.unmount();
  });
});
