import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../services/api';
import { useDialog } from '../../components/common/DialogProvider';
import {
  useActivationKey,
} from '../../components/common/KeepMounted';
import type { BsIntegrityFinding, BsIntegrityReport } from '../../types';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  Wrench,
} from 'lucide-react';

/**
 * Calendar Health — the in-app face of the BS calendar integrity engine
 * (server/src/services/bsCalendarIntegrity.service.ts, the same code behind
 * `npm run audit:bs-dates` and the boot check).
 *
 * It answers the two questions an operator actually has after a calendar scare:
 * "is what we store the published patro?" and "what can I fix from here?". Every
 * finding says whether the correct value is DERIVABLE — those rows get a Fix
 * button, and the rest state what has to be supplied by hand. Nothing on this
 * panel invents a date: applying runs the engine's own fixes inside one
 * transaction and re-audits, and the remaining count it shows afterward is the
 * fresh audit, not an assumption.
 */
interface BsCalendarHealthPanelProps {
  /** Whether the current user may write (the API enforces this anyway). */
  canManage: boolean;
  /** Called after a successful repair so the parent re-reads its year table. */
  onRepaired?: () => Promise<void> | void;
}

const SEVERITY_STYLES: Record<BsIntegrityFinding['severity'], string> = {
  error: 'bg-rose-50 border-rose-200 text-rose-800 dark:bg-rose-950/50 dark:border-rose-500/40 dark:text-rose-300',
  warning:
    'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/50 dark:border-amber-500/40 dark:text-amber-300',
};

export const BsCalendarHealthPanel: React.FC<BsCalendarHealthPanelProps> = ({ canManage, onRepaired }) => {
  const { confirm: confirmDialog } = useDialog();
  const [report, setReport] = useState<BsIntegrityReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const activationKey = useActivationKey('bs-calendar');

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await api.getBsCalendarIntegrity();
      setReport(result);
    } catch (err: any) {
      setStatus({ type: 'error', message: `Unable to audit the BS calendar: ${err.message}` });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [activationKey, load]);

  const applyFixes = async (finding: BsIntegrityFinding | null) => {
    const fixesAll = finding === null;
    const label = fixesAll ? 'every derivable correction' : finding.fixAction || finding.title;
    const ok = await confirmDialog(
      `Apply ${label}?${
        fixesAll
          ? ' Only findings whose correct value can be derived from the patro reference (or from the row\'s own AD date) are written; everything else is left untouched and reported.'
          : ' The value written is derived by the server, never taken from the browser.'
      }`,
      { title: 'Repair BS Calendar', confirmLabel: 'Apply' }
    );
    if (!ok) return;

    setBusyId(finding?.id ?? '__all__');
    setStatus(null);
    try {
      const result = await api.applyBsCalendarIntegrity(finding ? [finding.id] : undefined);
      setReport(result.report);
      setStatus({
        type: result.applied.length > 0 ? 'success' : 'error',
        message:
          result.message +
          (result.skipped.length > 0
            ? ` Skipped: ${result.skipped.map((s) => `${s.id} (${s.reason})`).join('; ')}`
            : ''),
      });
      if (result.applied.length > 0) await onRepaired?.();
    } catch (err: any) {
      setStatus({ type: 'error', message: `Repair failed: ${err.message}` });
    } finally {
      setBusyId(null);
    }
  };

  const summary = report?.summary;
  const fixable = report?.findings.filter((f) => f.fixable) ?? [];
  const reportedOnly = report?.findings.filter((f) => !f.fixable) ?? [];
  const healthy = Boolean(summary && summary.total === 0);

  return (
    <div
      className={`rounded-2xl border p-5 shadow-xl space-y-4 bg-white border-slate-200 shadow-2xs dark:bg-[#0f1218] dark:border-slate-800`}
    >
      <div className={`flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b pb-3 border-slate-200 dark:border-slate-800`}>
        <div className="flex items-center gap-2.5">
          <div
            className={`p-2 rounded-xl border ${
              healthy
                ? 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
                : 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/20'
            }`}
          >
            <Stethoscope className="h-5 w-5" />
          </div>
          <div>
            <h3 className={`font-bold text-base text-slate-900 dark:text-white`}>Calendar Health</h3>
            <p className={`text-xs text-slate-500 dark:text-slate-400`}>
              Every stored BS date checked against the published patro (reference data), the day table, and the fiscal
              years derived from it.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={load}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold bg-white hover:bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-300 dark:border-slate-700 cursor-pointer disabled:opacity-60"
          >
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Re-check
          </button>
          {canManage && fixable.length > 0 && (
            <button
              type="button"
              onClick={() => applyFixes(null)}
              disabled={busyId !== null}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white cursor-pointer"
            >
              {busyId === '__all__' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wrench className="h-3.5 w-3.5" />
              )}
              Fix all {fixable.length} derivable
            </button>
          )}
        </div>
      </div>

      {isLoading && !report && (
        <p className={`text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2`}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Auditing the stored calendar…
        </p>
      )}

      {report && summary && (
        <>
          <div className={`flex items-start gap-2 p-3 rounded-xl border text-xs font-medium ${healthy ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/60 dark:border-emerald-500/40 dark:text-emerald-300' : 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/50 dark:border-amber-500/40 dark:text-amber-300'}`}>
            {healthy ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
            <div className="space-y-1">
              <p>
                {healthy
                  ? 'The stored calendar matches the patro reference: no finding to fix.'
                  : `${summary.total} finding(s): ${summary.fixable} derivable from the patro reference, ${
                      summary.total - summary.fixable
                    } requiring data only you can supply.`}
              </p>
              <p className="font-mono text-[11px] opacity-90">
                {summary.yearsSeeded} year(s) seeded · {summary.yearsCoveredByPatro} verified by the patro ·{' '}
                {summary.dayRows} day row(s) (patro days {summary.patroDays}) · {summary.storedBsValuesChecked} stored BS
                value(s) checked
              </p>
              {summary.provisionalYears.length > 0 && (
                <p className="font-mono text-[11px]">
                  Provisional (not verified by the patro data): BS {summary.provisionalYears.join(', ')}
                </p>
              )}
              {summary.yearsMissingFromDb.length > 0 && (
                <p className="font-mono text-[11px]">
                  Patro years missing from the database: BS {summary.yearsMissingFromDb.join(', ')}
                </p>
              )}
              <p className="text-[11px] opacity-80">
                Audited {new Date(report.generatedAt).toLocaleString()}
              </p>
            </div>
          </div>

          {report.findings.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-[11px]">
                <thead className={`font-bold border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800`}>
                  <tr>
                    <th className="px-2.5 py-1.5">Finding</th>
                    <th className="px-2.5 py-1.5">Stored</th>
                    <th className="px-2.5 py-1.5">Correct</th>
                    <th className="px-2.5 py-1.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-200 text-slate-700 dark:divide-slate-800 dark:text-slate-300`}>
                  {report.findings.map((finding) => (
                    <tr key={finding.id} className="align-top">
                      <td className="p-2.5">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold mr-1.5 ${SEVERITY_STYLES[finding.severity]}`}
                        >
                          {finding.severity === 'error' ? 'ERROR' : 'WARN'}
                        </span>
                        <span className="font-bold">{finding.title}</span>
                        <p className="text-[11px] mt-1 opacity-80">{finding.detail}</p>
                        <p className="text-[10px] mt-1 font-mono opacity-60">
                          {finding.kind}
                          {finding.target ? ` · ${finding.target}${finding.targetId ? ` #${finding.targetId}` : ''}` : ''}
                        </p>
                      </td>
                      <td className="p-2.5 font-mono text-[10px] break-all">{finding.current ?? '—'}</td>
                      <td className="p-2.5 font-mono text-[10px] break-all">{finding.expected ?? '—'}</td>
                      <td className="p-2.5 text-right whitespace-nowrap">
                        {finding.fixable && canManage ? (
                          <button
                            type="button"
                            title={finding.fixAction}
                            onClick={() => applyFixes(finding)}
                            disabled={busyId !== null}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-bold text-[11px] cursor-pointer"
                          >
                            {busyId === finding.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Wrench className="h-3 w-3" />
                            )}
                            Fix
                          </button>
                        ) : (
                          <span className="text-[10px] opacity-70">
                            {finding.fixable ? 'needs calendar write access' : 'cannot be derived — fix by hand'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {reportedOnly.length > 0 && (
            <p className={`text-[11px] text-slate-500 dark:text-slate-400`}>
              {reportedOnly.length} finding(s) are reported rather than repaired: the calendar cannot derive a correct
              value for them (a year the unpublished patro does not cover, or a date with no AD counterpart). They stay
              visible here until the data is supplied by hand.
            </p>
          )}
        </>
      )}

      {status && (
        <div
          className={`p-3 rounded-xl border text-xs font-medium flex items-center gap-2 ${
            status.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/60 dark:border-emerald-500/40 dark:text-emerald-300'
              : 'bg-rose-50 border-rose-200 text-rose-800 dark:bg-rose-950/60 dark:border-rose-500/40 dark:text-rose-300'
          }`}
        >
          {status.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
};
