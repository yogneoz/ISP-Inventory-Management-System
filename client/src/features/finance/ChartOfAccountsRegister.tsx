/**
 * Chart & Defaults register — the chart of accounts, the posting-role defaults
 * each posting service relies on, and control-account reconciliation. Accounts
 * and groups can be added, edited, retired and (when unused) deleted here under
 * the `gl-manage` gate; posted history is never rewritten.
 */
import React, { useEffect, useState } from 'react';
import { ListTree } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import type { ControlReconciliationResponse } from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { ChartView } from '../../components/accounting/ChartView';
import type { ChartState } from '../../components/accounting/ChartView';

const EMPTY_CHART: ChartState = {
  groups: [],
  accounts: [],
  defaults: {},
  reconciliations: [],
  reconciliationErrors: {},
};

export const ChartOfAccountsRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [chart, setChart] = useState<ChartState>(EMPTY_CHART);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-chart');
  const isVisible = useTabActive('accounting-chart') && scope.allowed;
  const canManage = isOperationAllowed('gl-manage', currentUser?.role);

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const [groups, accounts, defaults] = await Promise.all([
          api.getAccountingGroups(),
          api.getAccountingAccounts(true),
          api.getPostingDefaults(),
        ]);
        const controlAccounts = accounts.filter((account) => account.isControl);
        const settled = await Promise.allSettled(
          controlAccounts.map((account) =>
            api.getControlReconciliation(
              account.id,
              scope.branchId === 'ALL' ? undefined : scope.branchId
            )
          )
        );
        if (!live) return;
        const reconciliations: ControlReconciliationResponse[] = [];
        const reconciliationErrors: Record<string, string> = {};
        settled.forEach((result, index) => {
          if (result.status === 'fulfilled') reconciliations.push(result.value);
          else {
            reconciliationErrors[controlAccounts[index].id] =
              result.reason?.message || 'Reconciliation could not be read.';
          }
        });
        setChart({
          groups,
          accounts,
          defaults: defaults.defaults || {},
          reconciliations,
          reconciliationErrors,
        });
        setLoaded(true);
      } catch (err: any) {
        if (!live) return;
        setError(err?.message || 'Failed to load the chart of accounts.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, scope.branchId, activationKey, reloadKey]);

  return (
    <AccountingRegisterShell
      title="Chart & Defaults"
      description="Ledger accounts, posting-role defaults and control-account reconciliation for the selected branch."
      icon={<ListTree className="h-5 w-5 text-indigo-500" />}
      registerName="chart of accounts"
      scope={scope}
      dateMode={dateMode}
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {loaded ? (
        <ChartView
          state={chart}
          branchId={scope.branchId}
          loading={loading}
          canManage={canManage}
          onChanged={() => setReloadKey((key) => key + 1)}
        />
      ) : (
        !loading &&
        !error && <RegisterEmpty message="No chart of accounts has been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default ChartOfAccountsRegister;
