import React, { useState } from 'react';
import { AlertTriangle, Calculator, CheckCircle2, Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../../services/api';
import { FiscalYear, User } from '../../types';

interface DataRecalculationMaintenanceProps {
  currentUser: User | null;
  fiscalYears: FiscalYear[];
  onRefreshData?: () => Promise<void>;
}

type Operation = 'assets' | 'opening-stock' | 'stock';

const operations: Array<{
  id: Operation;
  title: string;
  description: string;
  warning: string;
  icon: React.ElementType;
}> = [
  {
    id: 'assets',
    title: 'Recalculate Fixed Assets',
    description: 'Rebuild accumulated depreciation and net book value from acquisition date, cost, rate, and method.',
    warning: 'This updates only derived fixed-asset values. It does not change acquisition cost, purchase date, or asset status.',
    icon: Calculator,
  },
  {
    id: 'opening-stock',
    title: 'Rebuild Opening Stock',
    description: 'Generate the next fiscal year opening register from a closed fiscal year, preserving manual adjustments.',
    warning: 'Choose the closed source year. The operation creates or refreshes the following year and does not alter transaction history.',
    icon: Database,
  },
  {
    id: 'stock',
    title: 'Recalculate Live Stock',
    description: 'Restore live quantities from the latest reliable stock transaction for each product and branch.',
    warning: 'Only records with usable transaction history are changed. Stock without transaction history is left untouched.',
    icon: RefreshCw,
  },
];

export const DataRecalculationMaintenance: React.FC<DataRecalculationMaintenanceProps> = ({
  currentUser,
  fiscalYears,
  onRefreshData,
}) => {
  const [busy, setBusy] = useState<Operation | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [sourceFiscalYearId, setSourceFiscalYearId] = useState<string>(
    fiscalYears.find((fiscalYear) => fiscalYear.isClosed)?.id || ''
  );

  const runOperation = async (operation: Operation) => {
    if (currentUser?.role !== 'SUPER_ADMIN') return;
    if (operation === 'opening-stock' && !sourceFiscalYearId) {
      setMessage({ type: 'error', text: 'Select a closed source fiscal year first.' });
      return;
    }
    const definition = operations.find((item) => item.id === operation);
    if (!window.confirm(`Run “${definition?.title}”? ${definition?.warning}`)) return;

    setBusy(operation);
    setMessage(null);
    try {
      let resultMessage = 'Recalculation completed successfully.';
      if (operation === 'assets') {
        const result = await api.recalculateFixedAssets();
        resultMessage = result.message;
      } else if (operation === 'stock') {
        const result = await api.recalculateLiveStock();
        resultMessage = result.message;
      } else {
        const result = await api.initializeFiscalYearOpeningStock(sourceFiscalYearId);
        resultMessage = `${result.recordsCreated} opening-stock record(s) prepared for FY ${result.targetFiscalYear.code}${result.manualRowsPreserved ? `; ${result.manualRowsPreserved} manual adjustment row(s) preserved.` : '.'}`;
      }
      setMessage({ type: 'success', text: resultMessage });
      await onRefreshData?.();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'The recalculation could not be completed.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-5 bg-white border-slate-200 text-slate-900 shadow-xs dark:bg-slate-900/80 dark:border-slate-800 dark:text-slate-100`}>
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-amber-500/10 p-2.5 text-amber-500"><ShieldCheck className="h-5 w-5" /></div>
          <div>
            <h2 className="text-lg font-bold">Data Recalculation & Repair</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Super Admin maintenance tools for rebuilding derived values. Raw documents and transaction history are never rewritten.</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
        <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>Run these actions after correcting dates, costs, or imported data. Each operation is audited and should be run during a controlled maintenance window.</span></div>
      </div>

      {message && (
        <div className={`rounded-xl border p-3 text-xs font-semibold ${message.type === 'success' ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300'}`}>
          <div className="flex items-center gap-2">{message.type === 'success' && <CheckCircle2 className="h-4 w-4" />}{message.text}</div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {operations.map((operation) => {
          const Icon = operation.icon;
          const isBusy = busy === operation.id;
          return (
            <div key={operation.id} className={`rounded-2xl border p-5 bg-white border-slate-200 text-slate-900 shadow-xs dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-100`}>
              <div className="mb-3 flex items-center gap-2"><Icon className="h-5 w-5 text-indigo-500" /><h3 className="font-bold text-sm">{operation.title}</h3></div>
              <p className="min-h-16 text-xs leading-5 text-slate-500 dark:text-slate-400">{operation.description}</p>
              {operation.id === 'opening-stock' && (
                  <select value={sourceFiscalYearId} onChange={(event) => setSourceFiscalYearId(event.target.value)} className={`mb-3 w-full rounded-xl border px-3 py-2 text-xs border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white`}>
                  <option value="">Select closed source year…</option>
                  {fiscalYears.filter((fiscalYear) => fiscalYear.isClosed).map((fiscalYear) => <option key={fiscalYear.id} value={fiscalYear.id}>FY {fiscalYear.code} — closed</option>)}
                </select>
              )}
              <button type="button" onClick={() => runOperation(operation.id)} disabled={Boolean(busy)} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} />{isBusy ? 'Running…' : 'Run recalculation'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
