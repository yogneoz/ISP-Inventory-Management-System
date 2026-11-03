/**
 * AR / AP Aging register — open documents by days past due, reconciled to the
 * control account. The AR/AP switch belongs to this register; both sides read
 * the same posted subledger as before.
 */
import React, { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { AgingResponse, AgingType } from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { AgingView } from '../../components/accounting/AgingView';

export const AgingRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [agingType, setAgingType] = useState<AgingType>('AR');
  const [data, setData] = useState<AgingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-aging');
  const isVisible = useTabActive('accounting-aging') && scope.allowed;

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void api.getAging({
        type: agingType,
        branchId: scope.query.branchId,
        asOf: scope.asOfDate,
      })
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load the aging report.');
        setData(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, scope.branchId, scope.asOfDate, agingType, activationKey, reloadKey]);

  // A previous type's response must never render under the new AR/AP header
  // while the refetch is in flight.
  const visible = data?.type === agingType ? data : null;

  return (
    <AccountingRegisterShell
      title="AR / AP Aging"
      description="Open documents by days past due, with unapplied credits kept visible and the total tied to the control account."
      icon={<Clock className="h-5 w-5 text-indigo-500" />}
      registerName="aging report"
      scope={scope}
      dateMode={dateMode}
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {visible ? (
        <AgingView
          data={visible}
          type={agingType}
          onTypeChange={setAgingType}
          dateMode={dateMode}
        />
      ) : (
        !loading && !error && <RegisterEmpty message="No aging report has been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default AgingRegister;
