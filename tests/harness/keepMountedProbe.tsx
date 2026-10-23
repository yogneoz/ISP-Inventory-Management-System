/**
 * Render-count probe for A1 (kept-mounted screen memoisation).
 *
 * The tree mirrors the shape of App's tab area: a root that owns the data and
 * the "global search" box, one KeepMounted slot per tab, and screens that take
 * a data array plus inline-defined handlers — the exact prop shapes that made
 * every opened tab re-render on every keystroke.
 *
 * `memoized={false}` renders through `PlainSlot`, which is the pre-A1
 * KeepMounted verbatim (`{everVisible ? children : null}`); `memoized={true}`
 * uses the shipped container. Both paths run the same screens, so the two
 * render logs are directly comparable.
 */
import { createElement as h, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  KeepMounted,
  KeepMountedRoot,
  useActivationKey,
} from '../../client/src/components/common/KeepMounted';

export interface ProbeHandles {
  /** Set on every render, so the test can drive state updates inside act(). */
  api: {
    type: (query: string) => void;
    showTab: (tab: string) => void;
    setRows: (rows: number[]) => void;
  } | null;
  /** Screen body executions per screen name. */
  renders: Record<string, number>;
  /** Latest activation key observed per screen name. */
  activations: Record<string, number>;
  /** Screen clicks routed through the inline handler prop. */
  saves: number;
  /** Which screen names got which `rows` length, to prove data still flows. */
  rowLengths: Record<string, number>;
}

export function createProbeHandles(): ProbeHandles {
  return { api: null, renders: {}, activations: {}, saves: 0, rowLengths: {} };
}

/** Pre-A1 KeepMounted: mount on first visibility, then render children as-is. */
function PlainSlot({ visible, children }: { visible: boolean; children: ReactNode }) {
  const everVisible = useRef(visible);
  if (visible) everVisible.current = true;
  return h(
    'div',
    { style: visible ? undefined : { display: 'none' }, 'aria-hidden': !visible },
    everVisible.current ? children : null
  );
}

/** A screen with its own state, to prove memoisation never unmounts a tab. */
function StatefulScreen({ handles }: { handles: ProbeHandles }) {
  const [clicks, setClicks] = useState(0);
  handles.renders.stateful = (handles.renders.stateful ?? 0) + 1;
  return h(
    'div',
    null,
    h('span', { 'data-count': clicks }, `clicks=${clicks}`),
    h('button', { type: 'button', onClick: () => setClicks((n) => n + 1) }, 'increment')
  );
}

/** Two-tab tree used by the DOM/state survival test. */
export function StateProbe({ handles, memoized }: { handles: ProbeHandles; memoized: boolean }) {
  const [activeTab, setActiveTab] = useState('state-a');
  const [query, setQuery] = useState('');
  handles.api = {
    type: (next: string) => setQuery(next),
    showTab: (tab: string) => setActiveTab(tab),
    setRows: () => undefined,
  };
  const slot = (key: string, screen: ReactElement): ReactElement => {
    const visible = activeTab === key;
    return memoized
      ? h(KeepMounted, { key, visible, children: screen })
      : h(PlainSlot, { key, visible, children: screen });
  };
  return h(KeepMountedRoot, {
    activeTab,
    children: () =>
      h(
        'div',
        null,
        slot('state-a', h(StatefulScreen, { handles })),
        slot('state-b', h(Screen, { name: 'state-b', rows: [], onSave: () => undefined, handles })),
        // `query` is unused here but its state change is what forces a root
        // re-render in the survival test.
        h('span', { 'data-query': query })
      ),
  });
}

function Screen({
  name,
  rows,
  query,
  onSave,
  handles,
}: {
  name: string;
  rows: number[];
  query?: string;
  onSave: () => void;
  handles: ProbeHandles;
}) {
  const activation = useActivationKey(name);
  handles.renders[name] = (handles.renders[name] ?? 0) + 1;
  handles.activations[name] = activation;
  handles.rowLengths[name] = rows.length;
  return h(
    'div',
    { 'data-screen': name },
    `${name}|rows=${rows.length}|query=${query ?? ''}|activation=${activation}`
  );
}

export function Probe({
  memoized,
  handles,
  initialTab = 'dashboard',
}: {
  memoized: boolean;
  handles: ProbeHandles;
  initialTab?: string;
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<number[]>([1, 2, 3]);

  handles.api = {
    type: (next: string) => setQuery(next),
    showTab: (tab: string) => setActiveTab(tab),
    setRows: (next: number[]) => setRows(next),
  };

  // Same shape as App: a handler defined inline on every root render.
  const save = () => {
    handles.saves += 1;
  };

  const slot = (key: string, screen: ReactElement): ReactElement => {
    const visible = activeTab === key;
    return memoized
      ? h(KeepMounted, { key, visible, children: screen })
      : h(PlainSlot, { key, visible, children: screen });
  };

  return h(KeepMountedRoot, {
    activeTab,
    children: (flags: Record<string, boolean>) =>
      h(
        'div',
        null,
        slot('dashboard', h(Screen, { name: 'dashboard', rows, onSave: save, handles })),
        slot('sales', h(Screen, { name: 'sales', rows, onSave: save, handles })),
        slot('ledger', h(Screen, { name: 'ledger', rows, onSave: save, handles })),
        slot('search', h(Screen, { name: 'search', rows, query, onSave: save, handles })),
        // KeepMountedRoot's flags are part of the contract too: every tab is
        // driven by them in App, and the probe proves they stay in sync.
        h('span', { 'data-flags': Object.keys(flags).length })
      ),
  });
}
