/**
 * URL ↔ workspace routing, lifted out of App.tsx.
 *
 * The path is the address of a screen: the initial route is resolved once from
 * the pathname/`?tab=`/saved tab, navigation pushes a history entry, a record
 * (the detail page below a register) is its own entry, and Back/Forward resolve
 * the entry back to a tab and record. App.tsx now only renders `activeTab` and
 * passes the callbacks to the sidebar and screens.
 *
 * The history mode ref is intentionally exposed: redirects (the permission
 * guard, preference hydration) must replace the current entry rather than push
 * one, so Back cannot bounce between redirected screens.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import type { NavTab } from '../components/layout/Sidebar';
import {
  type InitialTabRoute,
  type RecordRoute,
  canonicalLocationUrl,
  canonicalTab,
  isRecordRouteForTab,
  resolveInitialTab,
} from '../routes/appPaths';
import { ACTIVE_TAB_STORAGE_KEY } from '../utils/tabStorage';

/** Saved-tab mirror. Storage can be blocked; a deep link must still work then. */
function readSavedTab(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface AppRouting {
  activeTab: NavTab;
  setActiveTab: React.Dispatch<React.SetStateAction<NavTab>>;
  activeTabRef: React.MutableRefObject<NavTab>;
  recordRoute: RecordRoute | null;
  setRecordRoute: React.Dispatch<React.SetStateAction<RecordRoute | null>>;
  recordRouteRef: React.MutableRefObject<RecordRoute | null>;
  /** `push` for a real navigation, `replace` for a redirect or a restoration. */
  urlHistoryModeRef: React.MutableRefObject<'replace' | 'push'>;
  /** Set when the first paint came from a shared URL, so hydration must not override it. */
  urlTabPendingRef: React.MutableRefObject<boolean>;
  handleSelectTab: (tab: NavTab) => void;
  handleRecordRouteChange: (record: RecordRoute | null) => void;
}

export function useAppRouting(): AppRouting {
  // A canonical path (or a legacy `?tab=` link) wins once over the saved tab.
  // `urlTabPendingRef` keeps the first server-preference hydration from
  // replacing a shared deep link before the user sees it.
  const [initialRoute] = useState<InitialTabRoute>(() => {
    try {
      return resolveInitialTab(window.location.pathname, window.location.search, readSavedTab());
    } catch {
      // URL unavailable (embedded/sandboxed contexts): start home.
      return { tab: 'dashboard', fromUrl: false, source: 'default' };
    }
  });
  const [activeTab, setActiveTab] = useState<NavTab>(initialRoute.tab);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // The open record below the active register. The path (not React state) is
  // the address; this state exists only to render the screen and write the URL.
  const [recordRoute, setRecordRoute] = useState<RecordRoute | null>(initialRoute.record ?? null);
  const recordRouteRef = useRef(recordRoute);
  recordRouteRef.current = recordRoute;

  // The first URL write replaces whatever was in the address bar; navigation
  // after it pushes a new history entry. Redirects (permission guard, legacy
  // URL cleanup) opt back into `replace` so Back does not bounce indefinitely.
  const urlHistoryModeRef = useRef<'replace' | 'push'>('replace');
  const urlTabPendingRef = useRef(initialRoute.fromUrl);

  // Sidebar/header navigation. Normalise retired ids (workflow-approval) and
  // push a history entry so Back returns to the screen the user left. A tab
  // click always closes any record child of the previous screen.
  const handleSelectTab = (tab: NavTab) => {
    urlHistoryModeRef.current = 'push';
    setRecordRoute(null);
    setActiveTab(canonicalTab(tab));
  };

  // A screen asking to open/close one record. Same-tab, so it is a history
  // entry of its own: Back returns from a record to its register.
  const handleRecordRouteChange = React.useCallback((record: RecordRoute | null) => {
    urlHistoryModeRef.current = 'push';
    setRecordRoute(record);
  }, []);

  // Back/Forward is a first-class navigation path: resolve the entry to a tab
  // and record, then let the permission guard decide whether that tab may
  // stay. A legacy or malformed entry is rewritten in place instead of
  // creating a new history entry.
  React.useEffect(() => {
    const handlePopState = () => {
      let nextTab: NavTab = 'dashboard';
      let nextRecord: RecordRoute | null = null;
      try {
        const route = resolveInitialTab(window.location.pathname, window.location.search, readSavedTab());
        nextTab = route.tab;
        nextRecord = route.record ?? null;
      } catch {
        // Keep the safe default.
      }

      const sameScreen =
        nextTab === activeTabRef.current &&
        JSON.stringify(nextRecord) === JSON.stringify(recordRouteRef.current);
      if (sameScreen) {
        // Same screen/record, different spelling/legacy params: canonicalise
        // in place because a state update would not re-run the URL effect.
        try {
          const target = canonicalLocationUrl(nextTab, nextRecord, window.location.href);
          const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          if (target !== current) window.history.replaceState(null, '', target);
        } catch {
          // History unavailable; the screen is still correct.
        }
        urlHistoryModeRef.current = 'push';
        return;
      }

      // A history entry is already a navigation: the effect must not push a
      // second entry for the same screen.
      urlHistoryModeRef.current = 'replace';
      setRecordRoute(nextRecord);
      setActiveTab(nextTab);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Keep the address bar in step with the workspace. The canonical path names
  // the screen and, when open, its record; the Users register owns its two
  // filter params and every other screen drops them. A legacy `?tab=` is
  // removed on the first write.
  //
  // Layout effect so the URL changes in the same commit as the screen: a
  // shared link never paints one screen under another screen's path.
  useLayoutEffect(() => {
    try {
      const next = canonicalLocationUrl(activeTab, recordRoute, window.location.href);
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (next !== current) {
        if (urlHistoryModeRef.current === 'push') window.history.pushState(null, '', next);
        else window.history.replaceState(null, '', next);
      }
    } catch {
      // History can be unavailable in an embedded/sandboxed context; tab
      // navigation itself still works.
    } finally {
      urlHistoryModeRef.current = 'push';
    }
  }, [activeTab, recordRoute]);

  // Internal navigation still calls setActiveTab directly in places. A record
  // belongs to exactly one register, so leaving that register closes it rather
  // than letting a later return resurrect a stale detail page.
  React.useEffect(() => {
    if (recordRoute && !isRecordRouteForTab(activeTab, recordRoute)) {
      setRecordRoute(null);
    }
  }, [activeTab, recordRoute]);

  return {
    activeTab,
    setActiveTab,
    activeTabRef,
    recordRoute,
    setRecordRoute,
    recordRouteRef,
    urlHistoryModeRef,
    urlTabPendingRef,
    handleSelectTab,
    handleRecordRouteChange,
  };
}
