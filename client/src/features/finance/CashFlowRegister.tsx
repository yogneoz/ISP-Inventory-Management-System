/**
 * Cash Flow register — direct operating, investing and financing movements from
 * posted cash/bank journal lines, with branch and period filters.
 */
import React, { useEffect, useState } from 'react';
import { Waves } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { CashFlowResponse } from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { CashFlowView } from '../../components/accounting/CashFlowView';

export const CashFlowRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [fromDate, setFromDate] = useState('');
  const [data, setData] = useState<CashFlowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-cash-flow');
  const isVisible = useTabActive('accounting-cash-flow') && scope.allowed;

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    const query = fromDate ? { ...scope.query, from: fromDate } : scope.query;
    void api.getCashFlow(query)
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
  }, [isVisible, scope.branchId, scope.asOfDate, fromDate, activationKey, reloadKey]);

  return (
    <AccountingRegisterShell
      title="Cash Flow"
      description="Operating, investing and financing cash movements from posted journal lines. Leave the start blank to use the fiscal year."
      icon={<Waves className="h-5 w-5 text-indigo-500" />}
      registerName="cash flow"
      scope={scope}
      dateMode={dateMode}
      periodStart={{ value: fromDate, onChange: setFromDate }}
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {data ? (
        <CashFlowView data={data} />
      ) : (
        !loading &&
        !error && <RegisterEmpty message="No cash flow statement has been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default CashFlowRegister;
