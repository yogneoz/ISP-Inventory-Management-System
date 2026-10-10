import React, { createContext, useContext, useMemo, useRef } from 'react';

/**
 * Keep-mounted tab container (tab-switch churn refactor, 2026-10-05).
 *
 * Every tab renders ONCE inside this container and stays mounted for the
 * session; switching tabs only toggles `display`, so React state, scroll
 * positions, form inputs and (for lazy tabs) the fetched code chunk all
 * survive a switch — no remount, no re-download of the same chunk, no
 * lost form state. Tabs that have never been active are still NOT rendered
 * (nothing is mounted for tabs the user never opens).
 *
 * The container is deliberately dumb: it mounts, hides and re-shows.
 * Everything about DATA freshness is decided by the screens themselves:
 *
 *  - Props-driven screens (the vast majority) are inherently live — every
 *    bootstrap-slice prop update re-renders them in place, exactly as the
 *    SSE targeted refreshes did before. No change needed.
 *  - Paged, SSE-wired registers already carry their registerRefresh keys —
 *    the App SSE handler bumps the counter, the effect re-runs while the
 *    tab is hidden. Already correct, no change needed.
 *  - Self-fetching screens (mount/selection-fetched lists, ledgers) keep
 *    their mount fetch for the FIRST paint and opt in to re-fetch-on-
 *    re-activation with `useActivationKey(tabKey)` — all 11 of them
 *    (MOUNT_REFETCH_NO_SSE_KEY in the test guards) are wired this way,
 *    which replaces their old "remount refetches me" behavior.
 */

/** Which tab (key) is currently visible; null while the boot overlay shows. */
const ActiveTabContext = createContext<string | null>(null);

/** Flags: has this tab ever been visible? Is it visible RIGHT NOW? */
const TabMountContext = createContext<Record<string, boolean>>({});

export function KeepMountedRoot({
  activeTab,
  children,
}: {
  activeTab: string | null;
  children: (flags: Record<string, boolean>) => React.ReactNode;
}) {
  const mountedRef = useRef<Set<string>>(new Set());
  if (activeTab) mountedRef.current.add(activeTab);
  // Stable flags object: only the two contexts re-render on tab switch.
  const flags = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const tab of mountedRef.current) out[tab] = tab === activeTab;
    return out;
  }, [activeTab]);
  return (
    <ActiveTabContext.Provider value={activeTab}>
      <TabMountContext.Provider value={flags}>
        {children(flags)}
      </TabMountContext.Provider>
    </ActiveTabContext.Provider>
  );
}

/**
 * Wraps one tab's element. `visible` comes from the render site (the flags
 * object). Children are NOT rendered until the tab's FIRST activation —
 * so a never-opened tab costs nothing (no chunk fetch, no mount, no screen
 * fetch). After that first activation the element stays mounted and is
 * merely hidden (display:none + aria-hidden + inert), so hidden tabs keep
 * rendering (and reacting to fresh props) without remounting on switch.
 */
export function KeepMounted({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  // Once the tab has been visible once, keep its children mounted forever
  // (until the whole app unmounts). Before that, render nothing — a lazy
  // child would otherwise fetch its chunk and mount at startup, mounting
  // all 67 screens on page load.
  const everVisible = useRef(visible);
  if (visible) everVisible.current = true;
  // `inert` (plus the display:none toggle) keeps hidden tabs out of the
  // a11y tree and blocks focus/interaction inside them. React 19 models
  // `inert` as a real BOOLEAN attribute: passing an empty string logs
  // "Received an empty string for a boolean attribute `inert`" on every
  // hidden tab AND is treated as false — so the flag was a no-op.
  return (
    <div
      style={visible ? undefined : { display: 'none' }}
      aria-hidden={!visible}
      inert={!visible}
    >
      {everVisible.current ? children : null}
    </div>
  );
}

/**
 * For SELF-FETCHING screens: an activation key that changes on first mount
 * AND on every re-activation after being hidden — the keep-mounted
 * replacement for "remount refetches me". An effect with `[activationKey]`
 * deps refetches on mount and each re-activation; screens that only want
 * the original mount-once behavior keep their `[]` deps and are untouched.
 *
 * The counter only moves on a HIDDEN → VISIBLE transition (and the first
 * activation), never on ordinary re-renders while the tab is visible —
 * otherwise any state update while visible would tick the key and refetch
 * in a loop (observed live: CategoryManagement refetching /api/categories
 * continuously until this was fixed).
 *
 * All 11 mount-refetch screens (ledgers, BS calendars, Category/Uom/
 * Locations, doc numbering, FinancialStatements — see
 * MOUNT_REFETCH_NO_SSE_KEY + MOUNT_REFETCH_ACTIVATION_TABS in the test
 * guards) pass their activation key into their fetch effect's deps.
 */
export function useActivationKey(tabKey: string): number {
  const activeTab = useContext(ActiveTabContext);
  const wasEverVisible = useRef(false);
  const activation = useRef(0);
  const prevActive = useRef(false);
  const isActive = activeTab === tabKey;
  if (isActive && !wasEverVisible.current) {
    // First activation: mount → 1 (the effect's initial run).
    wasEverVisible.current = true;
    prevActive.current = true;
    activation.current = 1;
  } else if (isActive && !prevActive.current) {
    // Re-activation after being hidden: refetch.
    prevActive.current = true;
    activation.current += 1;
  } else if (!isActive) {
    prevActive.current = false;
  }
  return activation.current;
}
