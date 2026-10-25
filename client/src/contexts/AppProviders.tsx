/**
 * The app's provider composition, in one place.
 *
 * main.tsx renders `<AppProviders><App /></AppProviders>` and the A6 route-tree
 * harness renders the same component, so a provider added here can never exist
 * in the browser but be missing from the test (the failure mode that made the
 * first A6 attempt crash on `useDialog`).
 *
 * Order matters only where a provider consumes another: Session and Scope are
 * independent of the theme/dialog layer, so the shell-level providers wrap
 * them. StrictMode stays in main.tsx — tests deliberately render without it so
 * effects run once and render counts are deterministic.
 */
import React from 'react';
import { DarkModeProvider } from './DarkModeContext';
import { SessionProvider } from './SessionContext';
import { ScopeProvider } from './ScopeContext';
import { DialogProvider } from '../components/common/DialogProvider';

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <DarkModeProvider>
    <SessionProvider>
      <ScopeProvider>
        <DialogProvider>{children}</DialogProvider>
      </ScopeProvider>
    </SessionProvider>
  </DarkModeProvider>
);
