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
 *    their mount fetch for the FIRST paint; when one needs re-fetch-on-
 *    re-activation (the keep-mounted replacement for "remount refetches
 *    me") it opts in with `useActivationKey(tabKey)` — a per-screen
 *    wiring decision, not a container behavior.
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
 * object) so the element only exists once its tab has been activated at
 * least once — hidden-but-mounted tabs keep rendering (and reacting to
 * fresh props) with display:none.
 */
export function KeepMounted({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  // `inert` (plus the display:none toggle) keeps hidden tabs out of the
  // a11y tree and blocks focus/interaction inside them. The React prop is
  // lowercase-boolean-safe in React 19; for older typings it is spread so
  // TS stays happy either way.
  return (
    <div
      style={visible ? undefined : { display: 'none' }}
      aria-hidden={!visible}
      {...(!visible ? ({ inert: '' } as Record<string, unknown>) : {})}
    >
      {children}
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
 * Reserved for the mount-refetch screens (ledgers, BS calendars, Category/
 * Uom/Locations, doc numbering, FinancialStatements) — wiring one up is a
 * per-screen decision (see MOUNT_REFETCH_NO_SSE_KEY in the test guards).
 */
export function useActivationKey(tabKey: string): number {
  const activeTab = useContext(ActiveTabContext);
  const wasEverVisible = useRef(false);
  const activation = useRef(0);
  if (activeTab === tabKey && !wasEverVisible.current) {
    wasEverVisible.current = true;
    activation.current = 1;
  } else if (activeTab === tabKey) {
    activation.current += 1;
  }
  return activation.current;
}
