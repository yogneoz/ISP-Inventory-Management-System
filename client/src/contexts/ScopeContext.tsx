/**
 * Scope values — the ONE owner of "which branch and fiscal year am I looking
 * at", plus the fiscal-year list every scope control renders.
 *
 * A3 moved these out of App.tsx so a route/screen refactor reads the current
 * scope from one place instead of receiving it through the root's props. The
 * default scope is identical to the old root state: all branches, no fiscal
 * year chosen until bootstrap resolves one.
 *
 * Screens keep their props for now; tests/sessionScopeContexts.test.ts fails if
 * a feature screen imports this context, which keeps prop-vs-context reads from
 * diverging during the incremental extraction.
 */
import React, { createContext, useContext, useMemo, useState } from 'react';
import type { FiscalYear } from '../types';

export interface ScopeContextValue {
  selectedBranchId: string;
  setSelectedBranchId: React.Dispatch<React.SetStateAction<string>>;
  /** '' until bootstrap resolves the current fiscal year. */
  selectedFiscalYearId: string;
  setSelectedFiscalYearId: React.Dispatch<React.SetStateAction<string>>;
  fiscalYears: FiscalYear[];
  setFiscalYears: React.Dispatch<React.SetStateAction<FiscalYear[]>>;
}

const ScopeContext = createContext<ScopeContextValue | undefined>(undefined);

export const ScopeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedBranchId, setSelectedBranchId] = useState<string>('ALL');
  const [selectedFiscalYearId, setSelectedFiscalYearId] = useState<string>('');
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);

  const value = useMemo<ScopeContextValue>(
    () => ({
      selectedBranchId,
      setSelectedBranchId,
      selectedFiscalYearId,
      setSelectedFiscalYearId,
      fiscalYears,
      setFiscalYears,
    }),
    [selectedBranchId, selectedFiscalYearId, fiscalYears]
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
};

export function useScope(): ScopeContextValue {
  const context = useContext(ScopeContext);
  if (!context) {
    throw new Error('useScope must be used inside <ScopeProvider>');
  }
  return context;
}
