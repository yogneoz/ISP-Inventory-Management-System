/**
 * Cash Flow register — direct operating, investing and financing movements from
 * posted cash/bank journal lines, with branch and period filters.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Printer, Waves } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type {
  CashFlowForecastResponse,
  CashFlowResponse,
} from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { CashFlowView } from '../../components/accounting/CashFlowView';
import { CashFlowForecastView } from '../../components/accounting/CashFlowForecastView';
import { CashFlowForecastSources } from '../../components/accounting/CashFlowForecastSources';
import { useBootstrapData } from '../../contexts/AppProviders';

export const CashFlowRegister: React.FC<AccountingScreenProps> = ({
  dateMode,
  currentUser,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<CashFlowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState('');
  const [forecast, setForecast] = useState<CashFlowForecastResponse | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState('');
  const [forecastWeeks, setForecastWeeks] = useState(13);
  const [minimumCash, setMinimumCash] = useState('0');
  const [exportingForecast, setExportingForecast] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-cash-flow');
  const isVisible = useTabActive('accounting-cash-flow') && scope.allowed;

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void api.getCashFlow(scope.rangeQuery)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load the cash flow statement.');
        setData(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, scope.branchId, scope.asOfDate, scope.fromDate, activationKey, reloadKey]);

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setForecastLoading(true);
    setForecastError('');
    const minCash = Math.max(0, Number(minimumCash) || 0);
    void api.getCashFlowForecast({
      branchId: scope.query.branchId,
      asOf: scope.asOfDate,
      weeks: forecastWeeks,
      minCash,
    })
      .then((next) => {
        if (live) setForecast(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setForecastError(err?.message || 'Failed to load the forward cash-flow forecast.');
        setForecast(null);
      })
      .finally(() => {
        if (live) setForecastLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isVisible,
    scope.branchId,
    scope.asOfDate,
    forecastWeeks,
    minimumCash,
    activationKey,
    reloadKey,
  ]);

  /**
   * The server prints the same object this register renders, through the
   * authenticated statement route; fetch it as a blob so the PDF download
   * carries the session headers instead of opening an unauthenticated tab.
   */
  const exportForecast = async () => {
    setExportingForecast(true);
    setForecastError('');
    try {
      const blob = await api.getCashFlowForecastCsv({
        branchId: scope.query.branchId,
        asOf: scope.asOfDate,
        weeks: forecastWeeks,
        minCash: Math.max(0, Number(minimumCash) || 0),
      });
      if (typeof URL.createObjectURL !== 'function') {
        throw new Error('This browser cannot download the cash-flow forecast.');
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cash-flow-forecast-${scope.asOfDate}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setForecastError(err?.message || 'The cash-flow forecast could not be exported.');
    } finally {
      setExportingForecast(false);
    }
  };

  const printPdf = async () => {
    setPrinting(true);
    setPrintError('');
    try {
      const blob = await api.getCashFlowPdf(scope.rangeQuery);
      if (typeof URL.createObjectURL !== 'function') {
        throw new Error('This browser cannot open the cash-flow PDF.');
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cash-flow-${scope.asOfDate}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setPrintError(err?.message || 'The cash-flow PDF could not be generated.');
    } finally {
      setPrinting(false);
    }
  };

  return (
    <AccountingRegisterShell
      title="Cash Flow"
      description="Operating, investing and financing cash movements from posted journal lines. Leave the start blank to use the fiscal year."
      icon={<Waves className="h-5 w-5 text-indigo-500" />}
      registerName="cash flow"
      scope={scope}
      dateMode={dateMode}
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
      headerActions={
        <button
          type="button"
          onClick={printPdf}
          disabled={printing || loading}
          className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <Printer className={`h-3.5 w-3.5 text-slate-400 ${printing ? 'animate-pulse' : ''}`} />
          {printing ? 'Preparing PDF…' : 'Print / PDF'}
        </button>
      }
    >
      {printError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-xs text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{printError}</span>
        </div>
      )}
      <div className="space-y-4">
        {data ? (
          <CashFlowView data={data} />
        ) : (
          !loading &&
          !error && <RegisterEmpty message="No cash flow statement has been loaded yet." />
        )}
        <CashFlowForecastView
          data={forecast}
          loading={forecastLoading}
          error={forecastError}
          weeks={forecastWeeks}
          minCash={minimumCash}
          onWeeksChange={setForecastWeeks}
          onMinCashChange={setMinimumCash}
          onExport={exportForecast}
          onRetry={() => setReloadKey((key) => key + 1)}
          exporting={exportingForecast}
        />
        <CashFlowForecastSources
          forecast={forecast}
          branches={scope.scopedBranches}
          scopeBranchId={scope.branchId}
          dateMode={dateMode}
          currentUser={currentUser}
          onChanged={() => setReloadKey((key) => key + 1)}
        />
      </div>
    </AccountingRegisterShell>
  );
};

export default CashFlowRegister;
