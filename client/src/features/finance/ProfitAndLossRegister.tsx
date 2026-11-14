/**
 * Profit & Loss register — income and expenses for the period, posted from the
 * ledger. Registered under Finance & Accounting with the `gl-view` gate.
 */
import React, { useEffect, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { ProfitAndLossResponse, StatementGroupBlock } from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { ProfitAndLossView } from '../../components/accounting/ProfitAndLossView';
import { TradingAccountView } from '../../components/accounting/TradingAccountView';
import {
  ComparativeToggle,
  ProfitAndLossViewToggle,
  StatementFormatToggle,
  type ProfitAndLossReportView,
} from '../../components/accounting/StatementViewControls';
import type { StatementFormat } from '../../components/accounting/statementTFormat';
import { precedingEqualWindow } from '../../utils/comparativePeriod';
import { StatementGroupDrilldown } from '../../components/accounting/StatementGroupDrilldown';

export const ProfitAndLossRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<ProfitAndLossResponse | null>(null);
  const [openGroup, setOpenGroup] = useState<StatementGroupBlock | null>(null);
  const [view, setView] = useState<ProfitAndLossReportView>('PROFIT_AND_LOSS');
  const [format, setFormat] = useState<StatementFormat>('NORMAL');
  const [comparative, setComparative] = useState(false);
  const [prior, setPrior] = useState<ProfitAndLossResponse | null>(null);
  const [priorLoading, setPriorLoading] = useState(false);
  const [priorError, setPriorError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-profit-loss');
  const isVisible = useTabActive('accounting-profit-loss') && scope.allowed;

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void api.getProfitAndLoss(scope.query)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load the profit and loss statement.');
        setData(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, scope.branchId, scope.asOfDate, activationKey, reloadKey]);

  useEffect(() => {
    if (!comparative || !data) {
      setPrior(null);
      setPriorError('');
      setPriorLoading(false);
      return;
    }
    const window = precedingEqualWindow(data.from, data.to);
    if (!window) {
      setPrior(null);
      setPriorError('This report has no period start, so a prior period cannot be derived.');
      setPriorLoading(false);
      return;
    }
    let live = true;
    setPriorLoading(true);
    setPriorError('');
    setPrior(null);
    void api.getProfitAndLoss({
      branchId: scope.query.branchId,
      from: window.from,
      to: window.to,
    })
      .then((next) => {
        if (live) setPrior(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setPrior(null);
        setPriorError(err?.message || 'The prior profit and loss statement could not be loaded.');
      })
      .finally(() => {
        if (live) setPriorLoading(false);
      });
    return () => {
      live = false;
    };
  }, [comparative, data, scope.query.branchId]);

  // A refreshed statement, a new report or a new presentation no longer shows
  // the same group in the same context; close the old drill-down.
  useEffect(() => {
    setOpenGroup(null);
  }, [data, view, format, comparative]);

  return (
    <AccountingRegisterShell
      title="Profit & Loss"
      description="Income, cost of sales and operating expenses for the period, from posted journal lines."
      icon={<TrendingUp className="h-5 w-5 text-indigo-500" />}
      registerName="profit and loss"
      scope={scope}
      dateMode={dateMode}
      loading={loading}
      error={error}
      headerActions={
        <>
          <ComparativeToggle enabled={comparative} onChange={setComparative} />
          <ProfitAndLossViewToggle view={view} onChange={setView} />
          <StatementFormatToggle format={format} onChange={setFormat} />
        </>
      }
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {data ? (
        <>
          {view === 'TRADING' ? (
            <TradingAccountView
              data={data}
              format={format}
              comparative={comparative}
              prior={prior}
              priorLoading={priorLoading}
              priorError={priorError}
              onOpenGroup={setOpenGroup}
            />
          ) : (
            <ProfitAndLossView
              data={data}
              format={format}
              comparative={comparative}
              prior={prior}
              priorLoading={priorLoading}
              priorError={priorError}
              onOpenGroup={setOpenGroup}
            />
          )}
          {openGroup && (
            <StatementGroupDrilldown
              group={openGroup}
              statement="PROFIT_AND_LOSS"
              branchId={data.branchId}
              from={data.from}
              to={data.to}
              onClose={() => setOpenGroup(null)}
            />
          )}
        </>
      ) : (
        !loading &&
        !error && <RegisterEmpty message="No profit and loss statement has been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default ProfitAndLossRegister;
