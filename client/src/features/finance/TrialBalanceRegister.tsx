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
  ComparativeToggle,
  TrialBalanceDetailToggle,
  type TrialBalanceDetail,
} from '../../components/accounting/StatementViewControls';
import { precedingEqualWindow } from '../../utils/comparativePeriod';
import {
  TrialBalanceDrilldown,
  type TrialBalanceDrilldownTarget,
} from '../../components/accounting/TrialBalanceDrilldown';
import { useBootstrapData } from '../../contexts/AppProviders';

export const TrialBalanceRegister: React.FC<AccountingScreenProps> = ({
  dateMode,
  currentUser,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<TrialBalanceResponse | null>(null);
  const [drilldown, setDrilldown] = useState<TrialBalanceDrilldownTarget | null>(null);
  const [detail, setDetail] = useState<TrialBalanceDetail>('DETAILED');
  const [comparative, setComparative] = useState(false);
  const [prior, setPrior] = useState<TrialBalanceResponse | null>(null);
  const [priorLoading, setPriorLoading] = useState(false);
  const [priorError, setPriorError] = useState('');
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
      setPriorError('This trial balance has no period start, so a prior period cannot be derived.');
      setPriorLoading(false);
      return;
    }
    let live = true;
    setPriorLoading(true);
    setPriorError('');
    setPrior(null);
    void api.getTrialBalance({
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
        setPriorError(err?.message || 'The prior trial balance could not be loaded.');
      })
      .finally(() => {
        if (live) setPriorLoading(false);
      });
    return () => {
      live = false;
    };
  }, [comparative, data, scope.query.branchId]);

  // A refreshed trial balance or a new level of detail closes a drill-down
  // opened from the previous presentation.
  useEffect(() => {
    setDrilldown(null);
  }, [data, detail, comparative]);

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
      headerActions={
        <>
          <ComparativeToggle enabled={comparative} onChange={setComparative} />
          <TrialBalanceDetailToggle detail={detail} onChange={setDetail} />
        </>
      }
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {data ? (
        <>
          <TrialBalanceView
            data={data}
            detail={detail}
            comparative={comparative}
            prior={prior}
            priorLoading={priorLoading}
            priorError={priorError}
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
