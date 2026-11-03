/**
 * Trial Balance register — the first accounting register.
 *
 * Same figures as the former Accounting Workspace tab, now a screen of its own
 * with its own branch/as-of scope and `gl-view` gate.
 */
import React, { useEffect, useState } from 'react';
import { Scale } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { TrialBalanceResponse } from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { TrialBalanceView } from '../../components/accounting/TrialBalanceView';
import {
  TrialBalanceDrilldown,
  type TrialBalanceDrilldownTarget,
} from '../../components/accounting/TrialBalanceDrilldown';

export const TrialBalanceRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<TrialBalanceResponse | null>(null);
  const [drilldown, setDrilldown] = useState<TrialBalanceDrilldownTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting');
  const isVisible = useTabActive('accounting') && scope.allowed;

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void api.getTrialBalance(scope.query)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load the trial balance.');
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

  // A refreshed trial balance is a new set of figures; close a drill-down
  // opened from the previous response rather than comparing it with a stale
  // group subtotal.
  useEffect(() => {
    setDrilldown(null);
  }, [data]);

  return (
    <AccountingRegisterShell
      title="Trial Balance"
      description="Opening, period and closing debit/credit by account for the selected branch and date."
      icon={<Scale className="h-5 w-5 text-indigo-500" />}
      registerName="trial balance"
      scope={scope}
      dateMode={dateMode}
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {data ? (
        <>
          <TrialBalanceView
            data={data}
            onOpenGroup={(group) => setDrilldown({ kind: 'GROUP', group })}
            onOpenAccount={(account) => setDrilldown({ kind: 'ACCOUNT', account })}
          />
          {drilldown && (
            <TrialBalanceDrilldown
              target={drilldown}
              branchId={data.branchId}
              from={data.from}
              to={data.to}
              onClose={() => setDrilldown(null)}
            />
          )}
        </>
      ) : (
        !loading &&
        !error && <RegisterEmpty message="No trial balance has been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default TrialBalanceRegister;
