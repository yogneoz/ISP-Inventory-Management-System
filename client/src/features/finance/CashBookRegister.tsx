/**
 * Cash & Bank Book register — every posted cash/bank movement with a running
 * balance, under the `gl-view` gate.
 */
import React, { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { CashBookResponse } from '../../services/api/accounting';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { CashBookView } from '../../components/accounting/CashBookView';

export const CashBookRegister: React.FC<AccountingScreenProps> = ({
  branches,
  dateMode,
  currentUser,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const [data, setData] = useState<CashBookResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const activationKey = useActivationKey('accounting-cash-book');
  const isVisible = useTabActive('accounting-cash-book') && scope.allowed;

  useEffect(() => {
    if (!isVisible) return;
    let live = true;
    setLoading(true);
    setError('');
    void api.getCashBook(scope.query)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || 'Failed to load the cash and bank book.');
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

  return (
    <AccountingRegisterShell
      title="Cash & Bank Book"
      description="Every posted cash and bank movement with a running balance for the selected branch and date."
      icon={<Wallet className="h-5 w-5 text-indigo-500" />}
      registerName="cash and bank book"
      scope={scope}
      dateMode={dateMode}
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      {data ? (
        <CashBookView data={data} dateMode={dateMode} />
      ) : (
        !loading &&
        !error && <RegisterEmpty message="No cash and bank book has been loaded yet." />
      )}
    </AccountingRegisterShell>
  );
};

export default CashBookRegister;
