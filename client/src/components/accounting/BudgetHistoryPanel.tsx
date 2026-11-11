/**
 * Budget revision history. Versions are immutable prior-state snapshots; a
 * restore appends another snapshot and never rewrites an older row. Reads stay
 * visible while the budget is locked, but every write (including restore) waits
 * for an unlock.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, RotateCcw } from 'lucide-react';
import { api } from '../../services/api';
import type {
  BudgetHistoryResponse,
  BudgetResponse,
  BudgetVersionDetail,
  BudgetVersionSource,
} from '../../services/api/accounting';
import { formatMoney } from '../../utils/nprFormat';

interface BudgetHistoryPanelProps {
  fiscalYearId: string;
  branchId: string;
  canManage: boolean;
  locked: boolean;
  refreshToken: number;
  onRestored: (budget: BudgetResponse) => void;
}

const sourceLabels: Record<BudgetVersionSource, string> = {
  BASELINE: 'Baseline',
  SAVE: 'Manual save',
  COPY: 'Copy',
  COPY_REPLACE: 'Copy with replace',
  IMPORT: 'CSV import',
  IMPORT_REPLACE: 'CSV import with replace',
  RESTORE: 'Restore',
};

function sourceLabel(source: BudgetVersionSource): string {
  return sourceLabels[source] || source;
}

const panelClass =
  'rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60';

export const BudgetHistoryPanel: React.FC<BudgetHistoryPanelProps> = ({
  fiscalYearId,
  branchId,
  canManage,
  locked,
  refreshToken,
  onRestored,
}) => {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<BudgetHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<BudgetVersionDetail | null>(null);
  const [versionLoading, setVersionLoading] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState('');
  const [writeError, setWriteError] = useState('');

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setHistory(
        await api.getAccountingBudgetHistory({
          fiscalYearId,
          branchId,
        })
      );
    } catch (err: any) {
      setError(err?.message || 'Could not load the budget history.');
    } finally {
      setLoading(false);
    }
  }, [fiscalYearId, branchId]);

  useEffect(() => {
    if (!open) return;
    void loadHistory();
  }, [open, refreshToken, loadHistory]);

  const openVersion = async (versionId: string) => {
    setVersionLoading(versionId);
    setWriteError('');
    setNotice('');
    try {
      const result = await api.getAccountingBudgetVersion({
        fiscalYearId,
        branchId,
        versionId,
      });
      setSelected(result.version);
    } catch (err: any) {
      setWriteError(err?.message || 'Could not load this budget version.');
    } finally {
      setVersionLoading('');
    }
  };

  const restore = async () => {
    if (!selected || !canManage || locked) return;
    setRestoring(true);
    setWriteError('');
    setNotice('');
    try {
      const result = await api.restoreAccountingBudgetVersion({
        fiscalYearId,
        branchId,
        versionId: selected.id,
      });
      onRestored(result.budget);
      setNotice(
        `Restored version ${result.restoredVersion}. The previous lines were saved as version ${result.snapshot.version}.`
      );
      setSelected(null);
      await loadHistory();
    } catch (err: any) {
      setWriteError(err?.message || 'This budget version could not be restored.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <section className={panelClass}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-800 dark:text-slate-100">
            <History className="h-4 w-4" /> Budget history
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            Every save, copy, import and restore keeps the prior lines as an immutable version.
          </p>
        </div>
        <button
          type="button"
          aria-label="Budget history"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {open ? 'Hide history' : 'View history'}
        </button>
      </div>

      {open && (
        <div className="mt-3">
          {loading && !history ? (
            <p className="text-xs text-slate-400">Loading budget versions…</p>
          ) : error ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : history && history.versions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
              No budget versions exist yet. Saving or importing this budget will create the first
              version.
            </p>
          ) : history ? (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-[11px]">
                <thead>
                  <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-400 dark:border-slate-700 dark:text-slate-500">
                    <th className="px-2 py-2 font-semibold">Version</th>
                    <th className="px-2 py-2 font-semibold">When</th>
                    <th className="px-2 py-2 font-semibold">Who</th>
                    <th className="px-2 py-2 font-semibold">Produced by</th>
                    <th className="px-2 py-2 text-right font-semibold">Lines</th>
                    <th className="px-2 py-2 text-right font-semibold">Total</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {history.versions.map((version) => (
                    <tr
                      key={version.id}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                    >
                      <td className="px-2 py-2 font-mono font-semibold text-slate-700 dark:text-slate-200">
                        v{version.version}
                      </td>
                      <td className="px-2 py-2 text-slate-500 dark:text-slate-400">
                        {new Date(version.createdAt).toLocaleString()}
                      </td>
                      <td className="px-2 py-2 text-slate-600 dark:text-slate-300">
                        {version.actor || 'System'}
                      </td>
                      <td className="px-2 py-2">
                        <span className="font-medium text-slate-700 dark:text-slate-200">
                          {sourceLabel(version.source)}
                        </span>
                        {version.sourceDetail && (
                          <span className="ml-1 text-slate-400">· {version.sourceDetail}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                        {version.lineCount}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-slate-600 dark:text-slate-300">
                        {formatMoney(version.totalAmount)}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          aria-label={`View budget version ${version.version}`}
                          disabled={versionLoading === version.id}
                          onClick={() => void openVersion(version.id)}
                          className="rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-400 dark:hover:bg-indigo-950/30"
                        >
                          {versionLoading === version.id ? 'Loading…' : 'View lines'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {locked && (
            <p
              role="status"
              className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200"
            >
              History stays readable while the budget is locked. Unlock it before restoring a
              version.
            </p>
          )}

          {notice && (
            <p
              role="status"
              className="mt-2 flex items-start gap-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
            >
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" /> {notice}
            </p>
          )}
          {writeError && (
            <p
              role="status"
              className="mt-2 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-[10px] text-rose-700 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-200"
            >
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {writeError}
            </p>
          )}

          {selected && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/30">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    Version {selected.version} lines
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                    {sourceLabel(selected.source)}
                    {selected.sourceDetail ? ` · ${selected.sourceDetail}` : ''} ·{' '}
                    {selected.actor || 'System'} · {new Date(selected.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {canManage && (
                    <button
                      type="button"
                      aria-label={`Restore budget version ${selected.version}`}
                      onClick={() => void restore()}
                      disabled={locked || restoring}
                      title={locked ? 'Unlock the budget before restoring a version.' : undefined}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[10px] font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {restoring ? 'Restoring…' : `Restore version ${selected.version}`}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="rounded-lg px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                  >
                    Close
                  </button>
                </div>
              </div>

              {selected.lines.length === 0 ? (
                <p className="mt-2 rounded-lg border border-dashed border-slate-200 px-2.5 py-2 text-[10px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  This version has no budget lines (the initial empty baseline).
                </p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full border-collapse text-left text-[11px]">
                    <thead>
                      <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-400 dark:border-slate-700 dark:text-slate-500">
                        <th className="px-2 py-1.5 font-semibold">Period</th>
                        <th className="px-2 py-1.5 font-semibold">Account</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.lines.map((line) => (
                        <tr
                          key={`${line.periodKey}-${line.accountId}`}
                          className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                        >
                          <td className="px-2 py-1.5 font-mono text-slate-600 dark:text-slate-300">
                            {line.periodKey}
                          </td>
                          <td className="px-2 py-1.5 text-slate-700 dark:text-slate-200">
                            {line.code ? `${line.code} · ` : ''}
                            {line.name || line.accountId}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-slate-600 dark:text-slate-300">
                            {formatMoney(line.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
