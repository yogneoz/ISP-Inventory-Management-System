/**
 * Cash, Bank & Wallet book register — each custody view reads its own ledger
 * kind under the `gl-view` gate. Cash is a branch till; bank and wallet are
 * company balances with the selected branch's movement shown separately.
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
import { WalletReconciliationPanel } from '../../components/accounting/WalletReconciliationPanel';
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
  const [view, setView] = useState<'CASH' | 'BANK' | 'WALLET' | 'RECONCILE' | 'WALLET_RECONCILE'>('CASH');
  const activationKey = useActivationKey('accounting-cash-book');
  const isVisible = useTabActive('accounting-cash-book') && scope.allowed;

  useEffect(() => {
    if (!isVisible || view === 'RECONCILE' || view === 'WALLET_RECONCILE') return;
    let live = true;
    setLoading(true);
    setError('');
    const request =
      view === 'BANK'
        ? api.getBankPosition(scope.query)
        : api.getCashBook({ ...scope.query, kind: view });
    void request
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: any) => {
        if (!live) return;
        setError(err?.message || `Failed to load the ${view.toLowerCase()} book.`);
        setData(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, view, scope.branchId, scope.asOfDate, activationKey, reloadKey]);

  const title =
    view === 'RECONCILE'
      ? 'Bank Reconciliation'
      : view === 'WALLET_RECONCILE'
        ? 'Provider Reconciliation'
        : view === 'CASH'
          ? 'Cash Book'
          : view === 'BANK'
            ? 'Bank Book'
            : 'Wallet Clearing Book';
  const description =
    view === 'RECONCILE'
      ? 'Reconcile one bank account company-wide: import its statement, match every branch’s posted bank-ledger lines and lock the period.'
      : view === 'WALLET_RECONCILE'
        ? 'Settle provider clearing to bank net plus fee, then import the provider statement and match its net deposits to settlements.'
        : view === 'CASH'
          ? 'Every posted branch cash movement with a running till balance.'
          : view === 'BANK'
            ? 'Company balance per bank account with the selected branch’s movement shown separately.'
            : 'Provider clearing balances awaiting settlement, with each branch’s wallet movement shown separately.';
  const isReconciliation = view === 'RECONCILE' || view === 'WALLET_RECONCILE';
  return (
    <>
    <AccountingRegisterShell
      title={title}
      description={description}
      icon={<Wallet className="h-5 w-5 text-indigo-500" />}
      registerName={isReconciliation ? `${view.toLowerCase()} workspace` : `${view.toLowerCase()} book`}
      scope={scope}
      dateMode={dateMode}
      loading={isReconciliation ? false : loading}
      error={isReconciliation ? '' : error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      <div role="tablist" aria-label="Cash, bank and wallet views" className="mb-3 inline-flex flex-wrap rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-slate-900/60">
        {([
          ['CASH', 'Cash book'],
          ['BANK', 'Bank book'],
          ['WALLET', 'Wallet clearing'],
          ['RECONCILE', 'Bank reconciliation'],
          ['WALLET_RECONCILE', 'Provider reconciliation'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${view === key ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-800 dark:text-indigo-300' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'RECONCILE' ? (
        <BankReconciliationPanel
          branchId={scope.branchId}
          to={scope.asOfDate}
          dateMode={dateMode}
          currentUser={currentUser}
        />
      ) : view === 'WALLET_RECONCILE' ? (
        <WalletReconciliationPanel
          branchId={scope.branchId}
          to={scope.asOfDate}
          dateMode={dateMode}
          currentUser={currentUser}
        />
      ) : data ? (
        <CashBookView data={data} dateMode={dateMode} onOpenVoucher={setDetailId} />
      ) : (
        !loading &&
        !error && <RegisterEmpty message={`No ${title.toLowerCase()} has been loaded yet.`} />
      )}
    </AccountingRegisterShell>
    {detailId && <VoucherDetailDialog journalId={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
};

export default CashBookRegister;
