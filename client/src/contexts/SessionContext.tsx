/**
 * Session values — the ONE owner of who is signed in and the session-level
 * settings that travel with the app shell.
 *
 * A3 moved these out of App.tsx: the 3,000-line root used to hold them in
 * `useState` and pass them down through handlers, so any future root split
 * (AppRoutes, screen extraction) had to thread six values through props. The
 * provider owns the state; App and the shell read it with `useSession()`.
 *
 * Screens still receive values as props for now (A3 changes ownership, not the
 * screen interfaces), so no screen may read these from a prop AND this context:
 * tests/sessionScopeContexts.test.ts fails if a feature screen imports it.
 */
import React, { createContext, useContext, useMemo, useState } from 'react';
import type { User } from '../types';
import { loadUserSession } from '../utils/sessionCache';

export interface SessionContextValue {
  currentUser: User | null;
  setCurrentUser: React.Dispatch<React.SetStateAction<User | null>>;
  rootUser: User | null;
  setRootUser: React.Dispatch<React.SetStateAction<User | null>>;
  /** Server RBAC matrix; null until bootstrap (or a successful re-read) fills it. */
  permissionsMatrix: Record<string, Record<string, boolean>> | null;
  setPermissionsMatrix: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, boolean>> | null>
  >;
  /** Server-held app_settings (company-wide switches such as blind count). */
  appSettings: Record<string, string>;
  setAppSettings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  dateMode: 'BS' | 'AD';
  setDateMode: React.Dispatch<React.SetStateAction<'BS' | 'AD'>>;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    return loadUserSession().currentUser;
  });

  const [rootUser, setRootUser] = useState<User | null>(() => {
    return loadUserSession().rootUser;
  });

  const [permissionsMatrix, setPermissionsMatrix] = useState<Record<
    string,
    Record<string, boolean>
  > | null>(null);

  // Server-held app_settings, e.g. the company-wide blind stock-audit toggle.
  // Replaced wholesale on every bootstrap; never read from browser storage.
  const [appSettings, setAppSettings] = useState<Record<string, string>>({});

  const [dateMode, setDateMode] = useState<'BS' | 'AD'>(() => {
    // PAINT-TIME MIRROR ONLY. The saved value lives in the server-side
    // user_preferences table (see hydrateUserPreferences); this read just
    // avoids a wrong first frame while bootstrap loads, and is overwritten by
    // the server value as soon as it arrives.
    const saved = localStorage.getItem('inventory_date_mode');
    return saved === 'AD' ? 'AD' : 'BS';
  });

  const value = useMemo<SessionContextValue>(
    () => ({
      currentUser,
      setCurrentUser,
      rootUser,
      setRootUser,
      permissionsMatrix,
      setPermissionsMatrix,
      appSettings,
      setAppSettings,
      dateMode,
      setDateMode,
    }),
    [currentUser, rootUser, permissionsMatrix, appSettings, dateMode]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return context;
}
