/**
 * A3 probe: reads every value the two contexts own and can move them.
 *
 * Mounted through the same `AppProviders` composition main.tsx uses, so the
 * test proves the provider tree (not just the modules) is wired.
 */
import './dom';
import React from 'react';
import { AppProviders } from '../../client/src/contexts/AppProviders';
import { useSession } from '../../client/src/contexts/SessionContext';
import { useScope } from '../../client/src/contexts/ScopeContext';
import type { FiscalYear } from '../../client/src/types';
import { mountTree, type MountedTree } from './mount';

/** Mounts the probe inside the exact provider composition the app uses. */
export function mountSessionScopeProbe(): MountedTree {
  return mountTree(
    <AppProviders>
      <SessionScopeProbe />
    </AppProviders>
  );
}

export const SessionScopeProbe: React.FC = () => {
  const { currentUser, dateMode, setDateMode, appSettings, setAppSettings } = useSession();
  const { selectedBranchId, setSelectedBranchId, fiscalYears, setFiscalYears } = useScope();

  return (
    <div>
      <span data-testid="who">{currentUser?.email || 'none'}</span>
      <span data-testid="mode">{dateMode}</span>
      <span data-testid="branch">{selectedBranchId}</span>
      <span data-testid="fys">{fiscalYears.length}</span>
      <span data-testid="blind">{appSettings.companyWideBlindCount || 'unset'}</span>
      <button
        data-testid="change"
        onClick={() => {
          setDateMode('AD');
          setSelectedBranchId('WH001');
          setFiscalYears([{ id: 'fy-probe', name: '2083/84' } as unknown as FiscalYear]);
          setAppSettings((prev) => ({ ...prev, companyWideBlindCount: 'true' }));
        }}
      >
        change
      </button>
    </div>
  );
};
