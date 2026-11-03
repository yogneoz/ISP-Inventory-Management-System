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
import { StatementGroupDrilldown } from '../../components/accounting/StatementGroupDrilldown';

export const ProfitAndLossRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<ProfitAndLossResponse | null>(null);
  const [openGroup, setOpenGroup] = useState<StatementGroupBlock | null>(null);
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

  // A refreshed statement is a new set of figures; close a drill-down opened
  // from the previous response rather than comparing it with a stale subtotal.
  useEffect(() => {
    setOpenGroup(null);
  }, [data]);

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
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {data ? (
        <>
          <ProfitAndLossView data={data} onOpenGroup={setOpenGroup} />
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
