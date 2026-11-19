/**
 * fiscal mutations, lifted out of App.tsx.
 *
 * Each wrapper is the same call the root made inline: hit the API, then
 * refresh the shell. They live in a hook so the render code only wires
 * the returned handlers to screens.
 */
import { api } from '../services/api';
import type { ActionDeps } from './actionDeps';

export function useFiscalActions({ refreshAllData, currentUser, financialSummary }: ActionDeps) {
  const handleSetCurrentFiscalYear = async (id: string) => {
    await api.setCurrentFiscalYear(id);
    refreshAllData();
  };

  const handleCreateFiscalYear = async (input: {
    code: string;
    startDateAD: string;
    endDateAD: string;
    startDateBS: string;
    endDateBS: string;
  }) => {
    const created = await api.createFiscalYear(input);
    await refreshAllData();
    return created;
  };

  const handleDeleteFiscalYear = async (id: string) => {
    const result = await api.deleteFiscalYear(id);
    await refreshAllData();
    return result;
  };

  const handleCloseFiscalYear = async (
    id: string,
    credentials?: { adminEmail: string; adminPassword: string }
  ) => {
    await api.closeFiscalYear(id, credentials);
    await refreshAllData();
  };

  const handleReopenFiscalYear = async (
    id: string,
    credentials?: { adminEmail: string; adminPassword: string }
  ) => {
    await api.reopenFiscalYear(id, credentials);
    await refreshAllData();
  };

  const handleInitializeFiscalYearOpeningStock = async (id: string) => {
    const result = await api.initializeFiscalYearOpeningStock(id);
    await refreshAllData();
    return result;
  };

  const handleRollForwardVendorOpenings = async (id: string) => {
    const result = await api.rollForwardVendorOpenings(id);
    await refreshAllData();
    return result;
  };


  return {
    handleSetCurrentFiscalYear,
    handleCreateFiscalYear,
    handleDeleteFiscalYear,
    handleCloseFiscalYear,
    handleReopenFiscalYear,
    handleInitializeFiscalYearOpeningStock,
    handleRollForwardVendorOpenings,
  };
}
