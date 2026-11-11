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
import { BankReconciliationPanel } from '../../components/accounting/BankReconciliationPanel';
import { VoucherDetailDialog } from '../../components/accounting/VoucherDetailDialog';

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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [view, setView] = useState<'book' | 'reconcile'>('book');
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
    <>
    <AccountingRegisterShell
      title={view === 'book' ? 'Cash & Bank Book' : 'Bank Reconciliation'}
      description={
        view === 'book'
          ? 'Every posted cash and bank movement with a running balance for the selected branch and date.'
          : 'Reconcile one bank account company-wide: import its statement, match every branch’s posted bank-ledger lines and lock the period.'
      }
      icon={<Wallet className="h-5 w-5 text-indigo-500" />}
      registerName={view === 'book' ? 'cash and bank book' : 'bank reconciliation workspace'}
      scope={scope}
      dateMode={dateMode}
      loading={view === 'book' ? loading : false}
      error={view === 'book' ? error : ''}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      <div role="tablist" aria-label="Cash and bank views" className="mb-3 inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-slate-900/60">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'book'}
          onClick={() => setView('book')}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${view === 'book' ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-800 dark:text-indigo-300' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'}`}
        >
          Cash book
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'reconcile'}
          onClick={() => setView('reconcile')}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${view === 'reconcile' ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-800 dark:text-indigo-300' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'}`}
        >
          Bank reconciliation
        </button>
      </div>
      {view === 'reconcile' ? (
        <BankReconciliationPanel
          branchId={scope.branchId}
          to={scope.asOfDate}
          dateMode={dateMode}
          currentUser={currentUser}
        />
      ) : data ? (
        <CashBookView data={data} dateMode={dateMode} onOpenVoucher={setDetailId} />
      ) : (
        !loading &&
        !error && <RegisterEmpty message="No cash and bank book has been loaded yet." />
      )}
    </AccountingRegisterShell>
    {detailId && <VoucherDetailDialog journalId={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
};

export default CashBookRegister;
