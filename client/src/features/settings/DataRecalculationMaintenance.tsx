import React, { useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Calculator, CalendarDays, CheckCircle2, Database, Link2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../../services/api';
import { FiscalYear, User } from '../../types';
import { FiscalYearSelect } from '../../components/common/FiscalYearSelect';
import { useDialog } from '../../components/common/DialogProvider';

interface DataRecalculationMaintenanceProps {
  currentUser: User | null;
  fiscalYears: FiscalYear[];
  onRefreshData?: () => Promise<void>;
}

type Operation = 'assets' | 'opening-stock' | 'stock' | 'bs-calendar' | 'fy-links' | 'vendor-openings';

const operations: Array<{
  id: Operation;
  title: string;
  description: string;
  warning: string;
  icon: React.ElementType;
  needsClosedSourceYear?: boolean;
  needsClosedSourceLabel?: string;
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
    needsClosedSourceYear: true,
  },
  {
    id: 'stock',
    title: 'Recalculate Live Stock',
    description: 'Restore live quantities from the latest reliable stock transaction for each product and branch.',
    warning: 'Only records with usable transaction history are changed. Stock without transaction history is left untouched.',
    icon: RefreshCw,
  },
  {
    id: 'vendor-openings',
    title: 'Rebuild Vendor Opening Balances',
    description: 'Re-run the vendor accounts roll-forward from a closed fiscal year into its successor, preserving manual corrections.',
    warning: 'Choose the closed source year. Only closing-generated rows are refreshed; manually adjusted vendor balances survive.',
    icon: ArrowLeftRight,
    needsClosedSourceYear: true,
    needsClosedSourceLabel: 'Source Fiscal Year (closed)',
  },
  {
    id: 'bs-calendar',
    title: 'Rebuild BS Calendar Days',
    description: 'Regenerate the AD⇄BS day-by-day lookup table from the stored calendar year configuration.',
    warning: 'Source calendar config is never rewritten. Only the derived daily conversion table is rebuilt to repair drift or gaps.',
    icon: CalendarDays,
  },
  {
    id: 'fy-links',
    title: 'Repair Fiscal-Year Links',
    description: 'Re-link every dated record to its correct fiscal year so reports and closing scoping stay accurate.',
    warning: 'Only NULL or stale fiscal-year references are corrected from the row date. Raw documents are never modified.',
    icon: Link2,
  },
];

export const DataRecalculationMaintenance: React.FC<DataRecalculationMaintenanceProps> = ({
  currentUser,
  fiscalYears,
  onRefreshData,
}) => {
  const { confirm: confirmDialog } = useDialog();
  const [busy, setBusy] = useState<Operation | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [sourceFiscalYearId, setSourceFiscalYearId] = useState<string>(
    fiscalYears.find((fiscalYear) => fiscalYear.isClosed)?.id || ''
  );

  const runOperation = async (operation: Operation) => {
    if (currentUser?.role !== 'SUPER_ADMIN') return;
    if ((operation === 'opening-stock' || operation === 'vendor-openings') && !sourceFiscalYearId) {
      setMessage({ type: 'error', text: 'Select a closed source fiscal year first.' });
      return;
    }
    const definition = operations.find((item) => item.id === operation);
    const ok = await confirmDialog(`Run “${definition?.title}”? ${definition?.warning}`, {
      title: 'Run Recalculation',
      confirmLabel: 'Run',
    });
    if (!ok) return;

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
      } else if (operation === 'bs-calendar') {
        const result = await api.rebuildBsDayRecords();
        resultMessage = result.message;
      } else if (operation === 'fy-links') {
        const result = await api.repairFiscalYearLinks();
        resultMessage = `${result.message} (${result.totalFixed} row(s) fixed).`;
      } else if (operation === 'vendor-openings') {
        const result = await api.rollForwardVendorOpenings(sourceFiscalYearId);
        resultMessage = `${result.recordsCreated} vendor opening-balance record(s) prepared for FY ${result.targetFiscalYear.code}${result.manualRowsPreserved ? `; ${result.manualRowsPreserved} manual adjustment row(s) preserved.` : '.'}`;
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
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Super Admin maintenance tools for rebuilding derived values, regenerating the BS calendar, and repairing fiscal-year scoping. Raw documents and transaction history are never rewritten.</p>
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
              {operation.needsClosedSourceYear && (
                <div className="mb-3">
                  <span className="mb-1 block text-[10px] font-bold uppercase text-slate-400">{operation.needsClosedSourceLabel || 'Source Fiscal Year'}</span>
                  <FiscalYearSelect
                    fiscalYears={fiscalYears.filter((fiscalYear) => fiscalYear.isClosed)}
                    value={sourceFiscalYearId}
                    onChange={setSourceFiscalYearId}
                    pageSize={3}
                    showFyPrefix
                    placeholder="Select closed source year…"
                    triggerClassName="w-full rounded-xl border px-3 py-2 text-xs border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  />
                </div>
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
