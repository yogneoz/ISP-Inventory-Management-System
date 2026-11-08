/**
 * Manual voucher entry — Journal and Cash/Bank modes.
 *
 * Both screens post through the existing balanced-journal endpoint. The
 * journal form is a free multi-line Dr/Cr voucher; the cash/bank form adds one
 * settlement ledger and turns its Rec/Pay columns into the cash leg. Amounts
 * are converted to NPR at the voucher rate before posting, because the ledger
 * stores base-currency amounts only. The rate and source currency are kept on
 * the voucher for audit.
 *
 * The posted-voucher register lives on its own screen (PostedVouchers): this
 * form is only the posting surface, and every directory field is a search box
 * rather than a list of every ledger, employee or branch.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { CustomerPicker } from '../../components/common/CustomerPicker';
import { SearchPicker } from '../../components/common/SearchPicker';
import { SearchSelect, type SearchSelectOption } from '../../components/common/SearchSelect';
import { btnGhost, btnPrimary, inputClass, labelClass } from '../../components/common/styleConstants';
import { getActiveBranchId, api } from '../../services/api';
import type {
  AccountingAccount,
  AccountingEmployee,
  SettlementAccount,
} from '../../services/api/accounting';
import type { Branch, Supplier, User } from '../../types';
import { localTodayAD } from '../../utils/localDate';
import { formatMoney } from '../../utils/nprFormat';
import { getScopedBranches, isOperationAllowed } from '../../utils/permissions';

type VoucherMode = 'JOURNAL' | 'CASH_BANK';

export interface VoucherEntryProps {
  branches: Branch[];
  currentUser?: User | null;
  suppliers?: Supplier[];
}

interface VoucherLine {
  key: string;
  accountId: string;
  partyId: string;
  partyName: string;
  debit: string;
  credit: string;
  receipt: string;
  payment: string;
  memo: string;
}

interface PartyChoice {
  value: string;
  label: string;
  name: string;
}

const CURRENCY_OPTIONS = ['NPR', 'USD', 'EUR', 'INR', 'GBP'] as const;

const JOURNAL_VOUCHER_TYPES = [
  { value: 'MULTI_DEBIT_CREDIT', label: 'Multi Debit / Multi Credit' },
  { value: 'MULTI_DEBIT', label: 'Multi Debit / Single Credit' },
  { value: 'SINGLE_DEBIT', label: 'Single Debit / Multi Credit' },
  { value: 'SINGLE', label: 'Single Debit / Single Credit' },
] as const;

const CASH_VOUCHER_TYPES = [
  { value: 'CASH_BANK', label: 'Cash / Bank Voucher' },
  { value: 'CASH_RECEIPT', label: 'Cash / Bank Receipt' },
  { value: 'CASH_PAYMENT', label: 'Cash / Bank Payment' },
] as const;

const CURRENCY_CHOICES: SearchSelectOption[] = CURRENCY_OPTIONS.map((code) => ({
  value: code,
  label: code,
}));

let lineSequence = 0;

function blankLine(): VoucherLine {
  lineSequence += 1;
  return {
    key: `voucher-line-${lineSequence}`,
    accountId: '',
    partyId: '',
    partyName: '',
    debit: '',
    credit: '',
    receipt: '',
    payment: '',
    memo: '',
  };
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function amountOf(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const cellInput =
  'w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-[#0f1218] dark:text-white';
const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const noticeBox =
  'flex items-start gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300';

export const VoucherEntryScreen: React.FC<VoucherEntryProps & { mode: VoucherMode }> = ({
  mode,
  branches,
  currentUser,
  suppliers = [],
}) => {
  const isCash = mode === 'CASH_BANK';
  const tabKey = isCash ? 'cash-bank-entry' : 'journal-entry';
  const activationKey = useActivationKey(tabKey);
  const canPost = isOperationAllowed('gl-post', currentUser?.role);
  const scopedBranches = useMemo(
    () => getScopedBranches(currentUser, branches).filter((branch) => branch.active),
    [branches, currentUser]
  );

  const initialBranch = () => {
    const active = getActiveBranchId();
    if (active && scopedBranches.some((branch) => branch.id === active)) return active;
    if (
      currentUser?.branchId &&
      currentUser.branchId !== 'ALL' &&
      scopedBranches.some((branch) => branch.id === currentUser.branchId)
    ) {
      return currentUser.branchId;
    }
    return scopedBranches[0]?.id || '';
  };

  const defaultVoucherType = isCash ? 'CASH_BANK' : 'MULTI_DEBIT_CREDIT';
  const [branchId, setBranchId] = useState(initialBranch);
  const [journalDate, setJournalDate] = useState(localTodayAD);
  const [voucherType, setVoucherType] = useState(defaultVoucherType);
  const [voucherClass, setVoucherClass] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [referenceDate, setReferenceDate] = useState('');
  const [chequeNo, setChequeNo] = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [currency, setCurrency] = useState('NPR');
  const [exchangeRate, setExchangeRate] = useState('1');
  const [cashAccountId, setCashAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<VoucherLine[]>(() => [blankLine(), blankLine()]);
  const [knownAccounts, setKnownAccounts] = useState<Record<string, AccountingAccount>>({});
  const [settlementAccounts, setSettlementAccounts] = useState<SettlementAccount[]>([]);
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  const branchOptions = useMemo<SearchSelectOption[]>(
    () =>
      scopedBranches.map((branch) => ({
        value: branch.id,
        label: `${branch.code} · ${branch.name}`,
      })),
    [scopedBranches]
  );

  const cashAccountOptions = useMemo<SearchSelectOption[]>(
    () =>
      settlementAccounts.map((account) => ({
        value: account.id,
        label: `${account.code} · ${account.name}`,
        description: [account.bankName, account.accountNumber].filter(Boolean).join(' · ') || undefined,
      })),
    [settlementAccounts]
  );

  const supplierChoices = useMemo<PartyChoice[]>(
    () =>
      suppliers.map((supplier) => ({
        value: supplier.id,
        label: supplier.supplierCode
          ? `${supplier.name} (${supplier.supplierCode})`
          : supplier.name,
        name: supplier.name,
      })),
    [suppliers]
  );

  const branchPartyChoices = useMemo<PartyChoice[]>(
    () =>
      branches
        .filter((branch) => branch.active)
        .map((branch) => ({
          value: branch.id,
          label: `${branch.code} · ${branch.name}`,
          name: branch.name,
        })),
    [branches]
  );

  useEffect(() => {
    if (!scopedBranches.some((branch) => branch.id === branchId)) {
      setBranchId(scopedBranches[0]?.id || '');
    }
  }, [branchId, scopedBranches]);

  useEffect(() => {
    if (currency === 'NPR' && exchangeRate !== '1') setExchangeRate('1');
  }, [currency, exchangeRate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // The journal form needs no bulk directory reads: account rows arrive
      // from the search endpoint as the operator picks them, and employees are
      // searched per branch. Only the small cash/bank settlement list is loaded
      // eagerly so the default till is ready on the cash screen.
      if (isCash) {
        setSettlementAccounts(await api.getSettlementAccounts());
      } else {
        setSettlementAccounts([]);
      }
    } catch (err: any) {
      setError(err?.message || 'The voucher screen could not load its ledgers.');
    } finally {
      setLoading(false);
    }
  }, [isCash, activationKey]);

  useEffect(() => {
    if (!canPost) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPost, load, activationKey]);

  useEffect(() => {
    if (!isCash) return;
    setCashAccountId((current) =>
      current && settlementAccounts.some((account) => account.id === current)
        ? current
        : settlementAccounts[0]?.id || ''
    );
  }, [isCash, settlementAccounts]);

  useEffect(() => {
    if (!isCash || !cashAccountId || !branchId || !journalDate) {
      setCurrentBalance(null);
      return;
    }
    let alive = true;
    setBalanceLoading(true);
    api.getCashBook({ branchId, to: journalDate })
      .then((book) => {
        if (!alive) return;
        const row = book.accounts.find((account) => account.accountId === cashAccountId);
        setCurrentBalance(row ? Number(row.closing) : 0);
      })
      .catch(() => {
        if (alive) setCurrentBalance(null);
      })
      .finally(() => {
        if (alive) setBalanceLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isCash, cashAccountId, branchId, journalDate, refreshTick]);

  const rememberAccount = useCallback((account: AccountingAccount) => {
    setKnownAccounts((current) =>
      current[account.id] === account ? current : { ...current, [account.id]: account }
    );
  }, []);

  const searchEmployees = useCallback(
    (query: string) =>
      branchId ? api.getAccountingEmployees(branchId, query, 20) : Promise.resolve([]),
    [branchId]
  );

  const rate = Number(exchangeRate);
  const rateValue = Number.isFinite(rate) && rate > 0 ? rate : 1;

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let receipt = 0;
    let payment = 0;
    let debitNpr = 0;
    let creditNpr = 0;
    let receiptNpr = 0;
    let paymentNpr = 0;
    for (const line of lines) {
      const lineDebit = amountOf(line.debit);
      const lineCredit = amountOf(line.credit);
      const lineReceipt = amountOf(line.receipt);
      const linePayment = amountOf(line.payment);
      debit += lineDebit;
      credit += lineCredit;
      receipt += lineReceipt;
      payment += linePayment;
      debitNpr += roundMoney(lineDebit * rateValue);
      creditNpr += roundMoney(lineCredit * rateValue);
      receiptNpr += roundMoney(lineReceipt * rateValue);
      paymentNpr += roundMoney(linePayment * rateValue);
    }
    return {
      debit: roundMoney(debit),
      credit: roundMoney(credit),
      receipt: roundMoney(receipt),
      payment: roundMoney(payment),
      debitNpr: roundMoney(debitNpr),
      creditNpr: roundMoney(creditNpr),
      receiptNpr: roundMoney(receiptNpr),
      paymentNpr: roundMoney(paymentNpr),
      difference: roundMoney(debitNpr - creditNpr),
      net: roundMoney(receipt - payment),
      netNpr: roundMoney(receiptNpr - paymentNpr),
    };
  }, [lines, rateValue]);

  const resetEntry = (keepBranch = true) => {
    setJournalDate(localTodayAD());
    setVoucherType(defaultVoucherType);
    setVoucherClass('');
    setReferenceNo('');
    setReferenceDate('');
    setChequeNo('');
    setChequeDate('');
    setCurrency('NPR');
    setExchangeRate('1');
    setMemo('');
    setLines([blankLine(), blankLine()]);
    setKnownAccounts({});
    setError('');
    setNotice('');
    if (!keepBranch) setBranchId(scopedBranches[0]?.id || '');
  };

  const updateLine = (key: string, patch: Partial<VoucherLine>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line))
    );
  };

  const chooseAccount = (line: VoucherLine, account: AccountingAccount | null) => {
    if (account) rememberAccount(account);
    updateLine(line.key, {
      accountId: account?.id || '',
      partyId: '',
      partyName: '',
    });
  };

  const chooseParty = (line: VoucherLine, partyId: string, choices: PartyChoice[]) => {
    const choice = choices.find((option) => option.value === partyId);
    updateLine(line.key, {
      partyId,
      partyName: choice?.name || '',
    });
  };

  const addLine = () => setLines((current) => [...current, blankLine()]);

  const removeLine = (key: string) => {
    setLines((current) => (current.length <= 1 ? current : current.filter((line) => line.key !== key)));
  };

  const submit = async () => {
    setError('');
    setNotice('');
    if (!canPost) {
      setError('You do not have permission to post vouchers.');
      return;
    }
    if (!branchId) {
      setError('Choose the branch this voucher belongs to.');
      return;
    }
    if (!journalDate) {
      setError('Choose the voucher date.');
      return;
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      setError('Exchange rate must be a positive number.');
      return;
    }

    const usable = lines.filter((line) =>
      line.accountId &&
      (isCash
        ? amountOf(line.receipt) > 0 || amountOf(line.payment) > 0
        : amountOf(line.debit) > 0 || amountOf(line.credit) > 0)
    );

    if (isCash) {
      if (!cashAccountId) {
        setError('Choose the cash or bank ledger for this voucher.');
        return;
      }
      if (usable.length === 0) {
        setError('Add at least one receipt or payment line.');
        return;
      }
      if (usable.some((line) => line.accountId === cashAccountId)) {
        setError('The detail line must use a ledger other than the selected cash/bank ledger.');
        return;
      }
    } else if (usable.length < 2) {
      setError('A journal needs at least two lines with an account and an amount.');
      return;
    }

    const prepared: Array<{
      line: VoucherLine;
      account: AccountingAccount;
      debit: number;
      credit: number;
    }> = [];

    for (let index = 0; index < usable.length; index += 1) {
      const line = usable[index];
      const rowNo = lines.findIndex((row) => row.key === line.key) + 1;
      const account = knownAccounts[line.accountId];
      if (!account) {
        setError(`Line ${rowNo}: choose a valid ledger account.`);
        return;
      }
      if (account.isControl && !line.partyId.trim() && !line.partyName.trim()) {
        setError(`Line ${rowNo}: choose a subledger party for ${account.name}.`);
        return;
      }
      const debit = amountOf(line.debit);
      const credit = amountOf(line.credit);
      const receipt = amountOf(line.receipt);
      const payment = amountOf(line.payment);
      if (isCash) {
        if ((receipt > 0) === (payment > 0)) {
          setError(`Line ${rowNo}: enter exactly one of receipt or payment.`);
          return;
        }
      } else if ((debit > 0) === (credit > 0)) {
        setError(`Line ${rowNo}: enter exactly one of debit or credit.`);
        return;
      }
      prepared.push({
        line,
        account,
        debit: roundMoney(debit * rateValue),
        credit: roundMoney(credit * rateValue),
      });
    }

    const partyFor = (line: VoucherLine, account: AccountingAccount) =>
      account.isControl
        ? {
            subledgerType: account.subledgerType,
            partyId: line.partyId.trim() || null,
            partyName: line.partyName.trim() || line.partyId.trim() || null,
          }
        : {};

    let journalLines;
    let sourceType: string;

    if (isCash) {
      const cashAccount = settlementAccounts.find((account) => account.id === cashAccountId);
      if (!cashAccount) {
        setError('The selected cash/bank ledger is not available.');
        return;
      }
      const receiptNpr = prepared.reduce(
        (sum, row) => sum + roundMoney(amountOf(row.line.receipt) * rateValue),
        0
      );
      const paymentNpr = prepared.reduce(
        (sum, row) => sum + roundMoney(amountOf(row.line.payment) * rateValue),
        0
      );
      if (receiptNpr <= 0 && paymentNpr <= 0) {
        setError('The converted receipt and payment totals are both zero.');
        return;
      }
      if (prepared.some((row) => row.account.id === cashAccountId)) {
        setError('The detail line must use a ledger other than the selected cash/bank ledger.');
        return;
      }

      journalLines = [
        ...(receiptNpr > 0
          ? [
              {
                accountId: cashAccountId,
                debit: roundMoney(receiptNpr),
                credit: 0,
                memo: memo.trim() || 'Cash / bank receipt',
              },
            ]
          : []),
        ...(paymentNpr > 0
          ? [
              {
                accountId: cashAccountId,
                debit: 0,
                credit: roundMoney(paymentNpr),
                memo: memo.trim() || 'Cash / bank payment',
              },
            ]
          : []),
        ...prepared.map((row) => ({
          accountId: row.account.id,
          // A receipt debits the cash/bank ledger and credits its detail ledger;
          // a payment credits cash/bank and debits the detail ledger.
          debit: row.line.payment ? roundMoney(amountOf(row.line.payment) * rateValue) : 0,
          credit: row.line.receipt ? roundMoney(amountOf(row.line.receipt) * rateValue) : 0,
          memo: row.line.memo.trim() || null,
          ...partyFor(row.line, row.account),
        })),
      ];
      sourceType =
        receiptNpr > 0 && paymentNpr > 0
          ? 'CASH_BANK'
          : receiptNpr > 0
            ? 'CASH_RECEIPT'
            : 'CASH_PAYMENT';
    } else {
      journalLines = prepared.map((row) => ({
        accountId: row.account.id,
        debit: row.debit,
        credit: row.credit,
        memo: row.line.memo.trim() || null,
        ...partyFor(row.line, row.account),
      }));
      const debit = journalLines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
      const credit = journalLines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
      if (Math.abs(roundMoney(debit - credit)) >= 0.005) {
        setError(
          `The converted journal is out of balance by ${formatMoney(roundMoney(debit - credit))}. Adjust the amounts or rate.`
        );
        return;
      }
      sourceType = 'MANUAL';
    }

    setSaving(true);
    try {
      const posted = await api.postAccountingJournal({
        branchId,
        journalDateAD: journalDate,
        sourceType,
        voucherType,
        voucherClass: isCash ? null : voucherClass.trim() || null,
        referenceNo: isCash ? referenceNo.trim() || null : null,
        referenceDateAD: isCash ? referenceDate || null : null,
        chequeNo: isCash ? chequeNo.trim() || null : null,
        chequeDateAD: isCash ? chequeDate || null : null,
        currency,
        exchangeRate: rateValue,
        memo: memo.trim() || null,
        lines: journalLines,
      });
      setNotice(
        `${posted.journalNo} posted: debit ${formatMoney(posted.totalDebit)} = credit ${formatMoney(posted.totalCredit)}.`
      );
      setLines([blankLine(), blankLine()]);
      setMemo('');
      setVoucherClass('');
      setReferenceNo('');
      setReferenceDate('');
      setChequeNo('');
      setChequeDate('');
      setRefreshTick((tick) => tick + 1);
    } catch (err: any) {
      setError(err?.message || 'The voucher could not be posted.');
    } finally {
      setSaving(false);
    }
  };

  if (!canPost) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={isCash ? 'Cash & Bank Entry' : 'Journal Entry'}
          description="Post a balanced manual voucher into the general ledger."
          icon={isCash ? <Wallet className="h-5 w-5 text-indigo-500" /> : <BookOpen className="h-5 w-5 text-indigo-500" />}
        />
        <div className={errorBox}>
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to post vouchers.</span>
        </div>
      </div>
    );
  }

  const voucherTypes: readonly SearchSelectOption[] = isCash ? CASH_VOUCHER_TYPES : JOURNAL_VOUCHER_TYPES;
  const selectedCash = settlementAccounts.find((account) => account.id === cashAccountId);
  const newBalance = currentBalance == null ? null : roundMoney(currentBalance + totals.netNpr);

  return (
    <div className="space-y-4">
      <PageHeader
        title={isCash ? 'Cash & Bank Entry' : 'Journal Entry'}
        description={
          isCash
            ? 'Record money received or paid through a cash/bank ledger, with reference, cheque and exchange-rate details.'
            : 'Post a balanced multi-line journal with class, currency and exchange-rate details.'
        }
        icon={isCash ? <Wallet className="h-5 w-5 text-indigo-500" /> : <BookOpen className="h-5 w-5 text-indigo-500" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void load()} disabled={loading} className={btnGhost}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button type="button" onClick={() => resetEntry()} className={btnGhost}>
              <Plus className="h-4 w-4" /> New
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={saving || !canPost}
              className={btnPrimary}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {saving ? 'Posting…' : 'Post Voucher'}
            </button>
          </div>
        }
      />

      {error && (
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className={noticeBox} role="status">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {scopedBranches.length === 0 && (
        <div className={errorBox}>
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>No active branch is assigned to this account.</span>
        </div>
      )}

      <section className={panel}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className={labelClass}>Branch</label>
            <SearchSelect
              value={branchId}
              options={branchOptions}
              onChange={(next) => { if (next) setBranchId(next); }}
              allowClear={false}
              placeholder="Search branches…"
              ariaLabel={`${isCash ? 'Cash and bank' : 'Journal'} voucher branch`}
              emptyLabel="No branch matches this search."
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${tabKey}-date`}>Voucher Date (AD)</label>
            <input
              id={`${tabKey}-date`}
              type="date"
              className={inputClass}
              value={journalDate}
              onChange={(event) => setJournalDate(event.target.value)}
            />
          </div>
          <div>
            <label className={labelClass}>Voucher Type</label>
            <SearchSelect
              value={voucherType}
              options={voucherTypes}
              onChange={(next) => { if (next) setVoucherType(next); }}
              allowClear={false}
              placeholder="Search voucher types…"
              ariaLabel={`${isCash ? 'Cash and bank' : 'Journal'} voucher type`}
              emptyLabel="No voucher type matches this search."
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${tabKey}-voucher-no`}>Voucher No.</label>
            <input
              id={`${tabKey}-voucher-no`}
              className={`${inputClass} bg-slate-50 dark:bg-slate-800`}
              value="Auto-generated on post"
              readOnly
            />
          </div>

          {isCash ? (
            <>
              <div>
                <label className={labelClass}>Cash / Bank</label>
                <SearchSelect
                  value={cashAccountId}
                  options={cashAccountOptions}
                  onChange={(next) => { if (next) setCashAccountId(next); }}
                  allowClear={false}
                  placeholder="Search cash/bank ledgers…"
                  ariaLabel="Cash or bank ledger"
                  emptyLabel="No cash/bank ledger matches this search."
                />
              </div>
              <div>
                <label className={labelClass}>Current Balance</label>
                <div className="flex h-[38px] items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {balanceLoading
                    ? 'Reading…'
                    : currentBalance == null
                      ? '—'
                      : formatMoney(currentBalance)}
                </div>
                {selectedCash && currentBalance != null && newBalance != null && (
                  <p className="mt-1 text-[10px] text-slate-400">
                    After this voucher: {formatMoney(newBalance)}
                  </p>
                )}
              </div>
              <div>
                <label className={labelClass} htmlFor={`${tabKey}-reference-no`}>Ref Voucher</label>
                <input
                  id={`${tabKey}-reference-no`}
                  className={inputClass}
                  value={referenceNo}
                  onChange={(event) => setReferenceNo(event.target.value)}
                  placeholder="Reference voucher no."
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`${tabKey}-reference-date`}>Ref Date</label>
                <input
                  id={`${tabKey}-reference-date`}
                  type="date"
                  className={inputClass}
                  value={referenceDate}
                  onChange={(event) => setReferenceDate(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`${tabKey}-cheque-no`}>Cheque No.</label>
                <input
                  id={`${tabKey}-cheque-no`}
                  className={inputClass}
                  value={chequeNo}
                  onChange={(event) => setChequeNo(event.target.value)}
                  placeholder="Cheque / transaction no."
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`${tabKey}-cheque-date`}>Cheque Date</label>
                <input
                  id={`${tabKey}-cheque-date`}
                  type="date"
                  className={inputClass}
                  value={chequeDate}
                  onChange={(event) => setChequeDate(event.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor={`${tabKey}-class`}>Class</label>
              <input
                id={`${tabKey}-class`}
                className={inputClass}
                value={voucherClass}
                onChange={(event) => setVoucherClass(event.target.value)}
                placeholder="Optional voucher class, e.g. adjustment"
              />
            </div>
          )}

          <div>
            <label className={labelClass}>Currency</label>
            <SearchSelect
              value={currency}
              options={CURRENCY_CHOICES}
              onChange={(next) => { if (next) setCurrency(next); }}
              allowClear={false}
              placeholder="Search currencies…"
              ariaLabel={`${isCash ? 'Cash and bank' : 'Journal'} voucher currency`}
              emptyLabel="No currency matches this search."
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${tabKey}-rate`}>
              Rate {currency !== 'NPR' ? `(1 ${currency} in NPR)` : ''}
            </label>
            <input
              id={`${tabKey}-rate`}
              type="number"
              min="0"
              step="0.000001"
              className={inputClass}
              value={exchangeRate}
              disabled={currency === 'NPR'}
              onChange={(event) => setExchangeRate(event.target.value)}
            />
            {currency !== 'NPR' && (
              <p className="mt-1 text-[10px] text-slate-400">
                Ledger amounts are posted in NPR at this rate.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className={`${panel} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {isCash ? 'Receipt / Payment lines' : 'Journal lines'}
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {isCash
                ? 'Each line is a receipt into or payment from the selected cash/bank ledger.'
                : 'Debit and credit totals must agree before the journal can post.'}
            </p>
          </div>
          <button type="button" onClick={addLine} className={btnGhost} disabled={lines.length >= 100}>
            <Plus className="h-4 w-4" /> Add line
          </button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full min-w-[940px] text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/70 dark:text-slate-400">
              <tr>
                <th className="w-10 px-2 py-2">S.No</th>
                <th className="min-w-[230px] px-2 py-2">General Ledger</th>
                <th className="min-w-[190px] px-2 py-2">Sub Ledger / Party</th>
                <th className="w-[130px] px-2 py-2">{isCash ? 'Rec Amount' : 'Dr Amount'}</th>
                <th className="w-[130px] px-2 py-2">{isCash ? 'Pay Amount' : 'Cr Amount'}</th>
                <th className="min-w-[190px] px-2 py-2">Narration</th>
                <th className="w-12 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {lines.map((line, index) => {
                const account = knownAccounts[line.accountId];
                return (
                  <tr key={line.key} className="align-top">
                    <td className="px-2 py-2 font-mono text-slate-400">{index + 1}</td>
                    <td className="px-2 py-2">
                      <SearchPicker<AccountingAccount>
                        value={
                          account
                            ? { id: account.id, label: `${account.code} · ${account.name}` }
                            : null
                        }
                        onSelect={(next) => chooseAccount(line, next)}
                        search={api.searchAccountingAccounts}
                        itemKey={(row) => row.id}
                        itemLabel={(row) => `${row.code} · ${row.name}`}
                        placeholder="Search ledgers…"
                        inputClassName="h-8 text-[10px]"
                        ariaLabel={`Line ${index + 1} ledger`}
                        portal
                        labels={{
                          hint: 'Type a code or ledger name to search.',
                          loading: 'Searching ledgers…',
                          empty: 'No active ledger matches this search.',
                          error: 'Could not search the ledger chart.',
                        }}
                        renderOption={(row) => (
                          <div className="min-w-0 pr-2">
                            <div className="break-words text-xs font-semibold leading-snug text-slate-900 dark:text-white">
                              {row.code} · {row.name}
                            </div>
                            <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                              {row.groupCode} · {row.groupName}
                              {row.isControl ? ` · ${row.subledgerType} control` : ''}
                            </div>
                          </div>
                        )}
                      />
                    </td>
                    <td className="px-2 py-2">
                      {account?.isControl && account.subledgerType === 'CUSTOMER' ? (
                        <CustomerPicker
                          value={
                            line.partyId
                              ? { id: line.partyId, label: line.partyName || line.partyId }
                              : null
                          }
                          onSelect={(customer) =>
                            updateLine(line.key, {
                              partyId: customer?.id || '',
                              partyName: customer?.customerName || '',
                            })
                          }
                          search={api.searchCustomers}
                          placeholder="Search customer…"
                          inputClassName="h-8 text-[10px]"
                          ariaLabel={`Line ${index + 1} customer`}
                          portal
                        />
                      ) : !account?.isControl ? (
                        <span className="block px-2 py-1.5 text-[11px] text-slate-400">—</span>
                      ) : account.subledgerType === 'SUPPLIER' ? (
                        <SearchSelect
                          value={line.partyId}
                          options={supplierChoices}
                          onChange={(next) => chooseParty(line, next, supplierChoices)}
                          placeholder="Search suppliers…"
                          inputClassName="h-8 text-[10px]"
                          ariaLabel={`Line ${index + 1} supplier`}
                          portal
                          panelMinWidth={360}
                          emptyLabel="No supplier matches this search."
                        />
                      ) : account.subledgerType === 'INTER_BRANCH' ? (
                        <SearchSelect
                          value={line.partyId}
                          options={branchPartyChoices}
                          onChange={(next) => chooseParty(line, next, branchPartyChoices)}
                          placeholder="Search branches…"
                          inputClassName="h-8 text-[10px]"
                          ariaLabel={`Line ${index + 1} branch`}
                          portal
                          emptyLabel="No branch matches this search."
                        />
                      ) : account.subledgerType === 'EMPLOYEE' ? (
                        <SearchPicker<AccountingEmployee>
                          value={
                            line.partyId
                              ? { id: line.partyId, label: line.partyName || line.partyId }
                              : null
                          }
                          onSelect={(employee) =>
                            updateLine(line.key, {
                              partyId: employee?.id || '',
                              partyName: employee?.name || '',
                            })
                          }
                          search={searchEmployees}
                          itemKey={(row) => row.id}
                          itemLabel={(row) => `${row.name} (${row.employeeCode})`}
                          placeholder="Search employees…"
                          inputClassName="h-8 text-[10px]"
                          ariaLabel={`Line ${index + 1} employee`}
                          portal
                          labels={{
                            hint: 'Type a name or employee code to search this branch.',
                            loading: 'Searching employees…',
                            empty: 'No employee matches this search.',
                            error: 'Could not search the employee master.',
                          }}
                          renderOption={(row) => (
                            <div className="min-w-0 pr-2">
                              <div className="break-words text-xs font-semibold leading-snug text-slate-900 dark:text-white">
                                {row.name}{' '}
                                <span className="whitespace-nowrap font-mono text-[10px] text-slate-500 dark:text-slate-400">
                                  ({row.employeeCode})
                                </span>
                              </div>
                              {(row.department || row.designation) && (
                                <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                                  {[row.department, row.designation].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </div>
                          )}
                        />
                      ) : (
                        <input
                          aria-label={`Line ${index + 1} party`}
                          className={cellInput}
                          value={line.partyId}
                          onChange={(event) =>
                            updateLine(line.key, {
                              partyId: event.target.value,
                              partyName: event.target.value,
                            })
                          }
                          placeholder="Party id"
                        />
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        aria-label={`Line ${index + 1} ${isCash ? 'receipt' : 'debit'} amount`}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        className={`${cellInput} text-right`}
                        value={isCash ? line.receipt : line.debit}
                        onChange={(event) =>
                          isCash
                            ? updateLine(line.key, {
                                receipt: event.target.value,
                                payment: event.target.value ? '' : line.payment,
                              })
                            : updateLine(line.key, {
                                debit: event.target.value,
                                credit: event.target.value ? '' : line.credit,
                              })
                        }
                        placeholder="0.00"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        aria-label={`Line ${index + 1} ${isCash ? 'payment' : 'credit'} amount`}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        className={`${cellInput} text-right`}
                        value={isCash ? line.payment : line.credit}
                        onChange={(event) =>
                          isCash
                            ? updateLine(line.key, {
                                payment: event.target.value,
                                receipt: event.target.value ? '' : line.receipt,
                              })
                            : updateLine(line.key, {
                                credit: event.target.value,
                                debit: event.target.value ? '' : line.debit,
                              })
                        }
                        placeholder="0.00"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        aria-label={`Line ${index + 1} narration`}
                        className={cellInput}
                        value={line.memo}
                        onChange={(event) => updateLine(line.key, { memo: event.target.value })}
                        placeholder="Line narration"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        aria-label={`Remove line ${index + 1}`}
                        title="Remove line"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30 dark:hover:bg-rose-950/30"
                        onClick={() => removeLine(line.key)}
                        disabled={lines.length <= 1}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            {isCash ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <span className="text-slate-500">Total Receipts</span>
                <span className="text-right font-semibold">{formatMoney(totals.receipt)}</span>
                <span className="text-slate-500">Total Payments</span>
                <span className="text-right font-semibold">{formatMoney(totals.payment)}</span>
                <span className="border-t border-slate-200 pt-2 font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200">Net Amount</span>
                <span className={`border-t border-slate-200 pt-2 text-right font-bold dark:border-slate-700 ${totals.net < 0 ? 'text-rose-600' : 'text-emerald-700 dark:text-emerald-300'}`}>
                  {formatMoney(totals.net)}
                </span>
                <span className="text-slate-500">Net in NPR</span>
                <span className="text-right font-semibold">{formatMoney(totals.netNpr)}</span>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <span className="text-slate-500">Total Debit</span>
                <span className="text-right font-semibold">{formatMoney(totals.debit)}</span>
                <span className="text-slate-500">Total Credit</span>
                <span className="text-right font-semibold">{formatMoney(totals.credit)}</span>
                <span className="border-t border-slate-200 pt-2 font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200">Dr / Cr Difference</span>
                <span className={`border-t border-slate-200 pt-2 text-right font-bold dark:border-slate-700 ${Math.abs(totals.difference) < 0.005 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600'}`}>
                  {formatMoney(totals.difference)}
                </span>
                {currency !== 'NPR' && (
                  <>
                    <span className="text-slate-500">Posted in NPR</span>
                    <span className="text-right font-semibold">
                      {formatMoney(totals.debitNpr)} / {formatMoney(totals.creditNpr)}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          <div>
            <label className={labelClass} htmlFor={`${tabKey}-remarks`}>Remarks</label>
            <textarea
              id={`${tabKey}-remarks`}
              className={`${inputClass} min-h-[76px]`}
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              placeholder="Voucher narration or remarks"
            />
          </div>
        </div>
      </section>
    </div>
  );
};

export const JournalEntry: React.FC<VoucherEntryProps> = (props) => (
  <VoucherEntryScreen {...props} mode="JOURNAL" />
);

export const CashBankEntry: React.FC<VoucherEntryProps> = (props) => (
  <VoucherEntryScreen {...props} mode="CASH_BANK" />
);
