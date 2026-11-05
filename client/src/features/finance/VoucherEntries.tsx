/**
 * Manual voucher entry — Journal and Cash/Bank modes.
 *
 * Both screens post through the existing balanced-journal endpoint. The
 * journal form is a free multi-line Dr/Cr voucher; the cash/bank form adds one
 * settlement ledger and turns its Rec/Pay columns into the cash leg. Amounts
 * are converted to NPR at the voucher rate before posting, because the ledger
 * stores base-currency amounts only. The rate and source currency are kept on
 * the voucher for audit.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  Wallet,
  X,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import {
  VoucherDetailDialog,
  journalStatus,
  sourceLabel,
  statusBadgeClass,
} from '../../components/accounting/VoucherDetailDialog';
import { CustomerPicker } from '../../components/common/CustomerPicker';
import { btnGhost, btnPrimary, inputClass, labelClass } from '../../components/common/styleConstants';
import { getActiveBranchId, api } from '../../services/api';
import type {
  AccountingAccount,
  AccountingEmployee,
  AccountingJournal,
  SettlementAccount,
} from '../../services/api/accounting';
import type { Branch, Supplier, User } from '../../types';
import { localTodayAD } from '../../utils/localDate';
import { formatMoney } from '../../utils/nprFormat';
import {
  getScopedBranches,
  isOperationAllowed,
} from '../../utils/permissions';

type VoucherMode = 'JOURNAL' | 'CASH_BANK';

export interface VoucherEntryProps {
  branches: Branch[];
  currentUser?: User | null;
  suppliers?: Supplier[];
  /** App's transactionLog register counter: journal-writing mutations bump it. */
  sseRefreshKey?: number;
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

/** Voucher families the manual entry screens own and may reverse here. */
const REVERSIBLE_SOURCES = new Set(['MANUAL', 'CASH_RECEIPT', 'CASH_PAYMENT', 'CASH_BANK']);
const LIST_PAGE_SIZE = 25;

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
  sseRefreshKey = 0,
}) => {
  const isCash = mode === 'CASH_BANK';
  const tabKey = isCash ? 'cash-bank-entry' : 'journal-entry';
  const activationKey = useActivationKey(tabKey);
  const canView = isOperationAllowed('gl-view', currentUser?.role);
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
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [settlementAccounts, setSettlementAccounts] = useState<SettlementAccount[]>([]);
  const [employees, setEmployees] = useState<AccountingEmployee[]>([]);
  const [recent, setRecent] = useState<AccountingJournal[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [listPage, setListPage] = useState(1);
  const [listTotal, setListTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [reversalTarget, setReversalTarget] = useState<AccountingJournal | null>(null);
  const [reversalDate, setReversalDate] = useState(localTodayAD());
  const [reversalReason, setReversalReason] = useState('');
  const [reversalError, setReversalError] = useState('');
  const [reversing, setReversing] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!scopedBranches.some((branch) => branch.id === branchId)) {
      setBranchId(scopedBranches[0]?.id || '');
    }
  }, [branchId, scopedBranches]);

  useEffect(() => {
    if (currency === 'NPR' && exchangeRate !== '1') setExchangeRate('1');
  }, [currency, exchangeRate]);

  const loadJournals = useCallback(
    async (term: string, page: number) => {
      if (!branchId) {
        setRecent([]);
        setListTotal(0);
        setListPage(1);
        return;
      }
      setListLoading(true);
      try {
        const result = await api.getAccountingJournals({
          branchId,
          query: term || undefined,
          page,
          pageSize: LIST_PAGE_SIZE,
        });
        setRecent(result.data);
        setListTotal(result.totalItems);
        const lastPage = Math.max(1, Math.ceil(result.totalItems / LIST_PAGE_SIZE));
        if (page > lastPage) setListPage(lastPage);
      } catch (err: any) {
        setError(err?.message || 'The posted-voucher list could not be loaded.');
      } finally {
        setListLoading(false);
      }
    },
    [branchId]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const employeePromise = branchId
        ? api.getAccountingEmployees(branchId)
        : Promise.resolve([] as AccountingEmployee[]);
      const settlementPromise = isCash
        ? api.getSettlementAccounts()
        : Promise.resolve([] as SettlementAccount[]);

      const [accountRows, employeeRows, settlementRows] = await Promise.all([
        api.getAccountingAccounts(),
        employeePromise,
        settlementPromise,
      ]);

      setAccounts(accountRows.filter((account) => account.isActive));
      setEmployees(employeeRows);
      setSettlementAccounts(settlementRows);
    } catch (err: any) {
      setError(err?.message || 'The voucher screen could not load its ledgers.');
    } finally {
      setLoading(false);
    }
  }, [branchId, isCash, activationKey]);

  useEffect(() => {
    if (canView) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, load, activationKey]);

  useEffect(() => {
    if (canView) void loadJournals(searchTerm, listPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, loadJournals, searchTerm, listPage, activationKey, sseRefreshKey]);

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

  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  );

  const accountsSorted = useMemo(
    () => [...accounts].sort((left, right) => left.code.localeCompare(right.code)),
    [accounts]
  );

  const partyChoices = useMemo<Record<string, PartyChoice[]>>(
    () => ({
      SUPPLIER: suppliers.map((supplier) => ({
        value: supplier.id,
        label: supplier.supplierCode
          ? `${supplier.name} (${supplier.supplierCode})`
          : supplier.name,
        name: supplier.name,
      })),
      EMPLOYEE: employees.map((employee) => ({
        value: employee.id,
        label: `${employee.name} (${employee.employeeCode})`,
        name: employee.name,
      })),
      INTER_BRANCH: branches
        .filter((branch) => branch.active)
        .map((branch) => ({
          value: branch.id,
          label: `${branch.code} · ${branch.name}`,
          name: branch.name,
        })),
    }),
    [branches, employees, suppliers]
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
    setError('');
    setNotice('');
    if (!keepBranch) setBranchId(scopedBranches[0]?.id || '');
  };

  const updateLine = (key: string, patch: Partial<VoucherLine>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line))
    );
  };

  const chooseAccount = (line: VoucherLine, accountId: string) => {
    updateLine(line.key, {
      accountId,
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
      const account = accountsById.get(line.accountId);
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
      const cashAccount = accountsById.get(cashAccountId);
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
      setSearchInput('');
      setSearchTerm('');
      setListPage(1);
      if (searchTerm === '' && listPage === 1) void loadJournals('', 1);
    } catch (err: any) {
      setError(err?.message || 'The voucher could not be posted.');
    } finally {
      setSaving(false);
    }
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const term = searchInput.trim();
    setSearchTerm(term);
    setListPage(1);
    if (term === searchTerm && listPage === 1) void loadJournals(term, 1);
  };

  const clearSearch = () => {
    setSearchInput('');
    setSearchTerm('');
    setListPage(1);
    void loadJournals('', 1);
  };

  const openReversal = (journal: AccountingJournal) => {
    setReversalTarget(journal);
    setReversalDate(localTodayAD());
    setReversalReason('');
    setReversalError('');
  };

  const submitReversal = async () => {
    if (!reversalTarget) return;
    if (!reversalDate) {
      setReversalError('Choose the reversal date.');
      return;
    }
    if (!reversalReason.trim()) {
      setReversalError('Enter the reason for reversing this voucher.');
      return;
    }
    setReversing(true);
    setReversalError('');
    try {
      const reversal = await api.reverseAccountingJournal(reversalTarget.id, {
        journalDateAD: reversalDate,
        reason: reversalReason.trim(),
      });
      setNotice(`${reversalTarget.journalNo} reversed by ${reversal.journalNo}.`);
      setReversalTarget(null);
      setRefreshTick((tick) => tick + 1);
      await loadJournals(searchTerm, listPage);
    } catch (err: any) {
      setReversalError(err?.message || 'The voucher could not be reversed.');
    } finally {
      setReversing(false);
    }
  };

  if (!canView) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={isCash ? 'Cash & Bank Entry' : 'Journal Entry'}
          description="Post a balanced manual voucher into the general ledger."
          icon={isCash ? <Wallet className="h-5 w-5 text-indigo-500" /> : <BookOpen className="h-5 w-5 text-indigo-500" />}
        />
        <div className={errorBox}>
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view accounting ledgers.</span>
        </div>
      </div>
    );
  }

  const voucherTypes = isCash ? CASH_VOUCHER_TYPES : JOURNAL_VOUCHER_TYPES;
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
            <button
              type="button"
              onClick={() => {
                void load();
                void loadJournals(searchTerm, listPage);
              }}
              disabled={loading}
              className={btnGhost}
            >
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
      {!canPost && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
          You can review this form, but your role cannot post vouchers.
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
            <label className={labelClass} htmlFor={`${tabKey}-branch`}>Branch</label>
            <select
              id={`${tabKey}-branch`}
              className={inputClass}
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
            >
              <option value="">Choose branch…</option>
              {scopedBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>
              ))}
            </select>
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
            <label className={labelClass} htmlFor={`${tabKey}-voucher-type`}>Voucher Type</label>
            <select
              id={`${tabKey}-voucher-type`}
              className={inputClass}
              value={voucherType}
              onChange={(event) => setVoucherType(event.target.value)}
            >
              {voucherTypes.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
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
                <label className={labelClass} htmlFor={`${tabKey}-cash-account`}>Cash / Bank</label>
                <select
                  id={`${tabKey}-cash-account`}
                  className={inputClass}
                  value={cashAccountId}
                  onChange={(event) => setCashAccountId(event.target.value)}
                >
                  <option value="">Choose cash/bank ledger…</option>
                  {settlementAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.code} · {account.name}</option>
                  ))}
                </select>
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
            <label className={labelClass} htmlFor={`${tabKey}-currency`}>Currency</label>
            <select
              id={`${tabKey}-currency`}
              className={inputClass}
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCY_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
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
                const account = accountsById.get(line.accountId);
                const choices = account?.isControl
                  ? partyChoices[account.subledgerType] || []
                  : [];
                return (
                  <tr key={line.key} className="align-top">
                    <td className="px-2 py-2 font-mono text-slate-400">{index + 1}</td>
                    <td className="px-2 py-2">
                      <select
                        aria-label={`Line ${index + 1} ledger`}
                        className={cellInput}
                        value={line.accountId}
                        onChange={(event) => chooseAccount(line, event.target.value)}
                      >
                        <option value="">Choose ledger…</option>
                        {accountsSorted.map((option) => {
                          const category =
                            typeof option.masterProfile?.category === 'string'
                              ? option.masterProfile.category
                              : '';
                          return (
                            <option key={option.id} value={option.id}>
                              {option.code} · {option.name}{category ? ` · ${category}` : ''}
                            </option>
                          );
                        })}
                      </select>
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
                      ) : choices.length > 0 ? (
                        <select
                          aria-label={`Line ${index + 1} party`}
                          className={cellInput}
                          value={line.partyId}
                          onChange={(event) => chooseParty(line, event.target.value, choices)}
                        >
                          <option value="">Choose {account.subledgerType.toLowerCase()}…</option>
                          {choices.map((choice) => (
                            <option key={choice.value} value={choice.value}>{choice.label}</option>
                          ))}
                        </select>
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

      <section className={panel}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Posted vouchers</h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Search this branch&apos;s vouchers and reverse an eligible manual or cash/bank voucher with a contra entry.
            </p>
          </div>
          <span className="text-[11px] font-medium text-slate-400">
            {listTotal} voucher{listTotal === 1 ? '' : 's'}
          </span>
        </div>

        <form onSubmit={submitSearch} className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Voucher no., remarks or source reference"
              className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-[#0f1218] dark:text-white"
            />
          </div>
          <button type="submit" className={btnGhost} disabled={listLoading}>
            <Search className="h-4 w-4" /> Search
          </button>
          {(searchTerm || searchInput) && (
            <button type="button" className={btnGhost} onClick={clearSearch} disabled={listLoading}>
              <X className="h-4 w-4" /> Clear
            </button>
          )}
        </form>

        {listLoading && recent.length === 0 ? (
          <p className="px-1 py-4 text-xs text-slate-400">Loading vouchers…</p>
        ) : recent.length === 0 ? (
          <p className="px-1 py-4 text-xs text-slate-400">
            {searchTerm ? 'No voucher matches this search.' : 'No vouchers posted in this branch yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5">Voucher No.</th>
                  <th className="px-2 py-1.5">Type</th>
                  <th className="px-2 py-1.5">Remarks</th>
                  <th className="px-2 py-1.5 text-right">Debit</th>
                  <th className="px-2 py-1.5 text-right">Credit</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {recent.map((journal) => {
                  const reversalNo = journal.reversalJournalNo;
                  const status = journalStatus(journal);
                  const eligible =
                    canPost &&
                    !journal.reversalOfId &&
                    !reversalNo &&
                    journal.status === 'POSTED' &&
                    REVERSIBLE_SOURCES.has(journal.sourceType);
                  return (
                    <tr key={journal.id}>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-500">{journal.journalDateAD}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono font-semibold text-slate-700 dark:text-slate-200">
                        {journal.journalNo}
                        {journal.reversalOfNo && (
                          <span className="block font-sans text-[10px] font-normal text-slate-400">
                            of {journal.reversalOfNo}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-500">{sourceLabel(journal.sourceType)}</td>
                      <td className="max-w-[240px] truncate px-2 py-2 text-slate-500" title={journal.memo || ''}>{journal.memo || '—'}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatMoney(journal.totalDebit)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatMoney(journal.totalCredit)}</td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusBadgeClass(status)}`}
                          title={reversalNo ? `Reversed by ${reversalNo}` : undefined}
                        >
                          {status}
                        </span>
                        {reversalNo && (
                          <span className="mt-0.5 block font-mono text-[10px] text-slate-400">{reversalNo}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setDetailId(journal.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                            title="View voucher lines and any linked reversal"
                          >
                            <Eye className="h-3.5 w-3.5" /> View
                          </button>
                          <button
                            type="button"
                            onClick={() => openReversal(journal)}
                            disabled={!eligible}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-950/30 dark:disabled:border-slate-800 dark:disabled:text-slate-600"
                            title={eligible ? 'Reverse this voucher with a contra entry' : 'This voucher is not eligible for reversal'}
                          >
                            <Undo2 className="h-3.5 w-3.5" /> Reverse
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>
            Page {listPage} of {Math.max(1, Math.ceil(listTotal / LIST_PAGE_SIZE))}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className={btnGhost}
              disabled={listPage <= 1 || listLoading}
              onClick={() => setListPage((page) => Math.max(1, page - 1))}
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </button>
            <button
              type="button"
              className={btnGhost}
              disabled={listPage >= Math.max(1, Math.ceil(listTotal / LIST_PAGE_SIZE)) || listLoading}
              onClick={() => setListPage((page) => page + 1)}
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>

      {detailId && (
        <VoucherDetailDialog journalId={detailId} onClose={() => setDetailId(null)} />
      )}

      {reversalTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Reverse voucher</h3>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {reversalTarget.journalNo} · {formatMoney(reversalTarget.totalDebit)} · {reversalTarget.journalDateAD}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReversalTarget(null)}
                disabled={reversing}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-slate-800"
                aria-label="Close reversal dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              A contra voucher will be posted for the same amount with debits and credits swapped. The original stays
              posted and auditable; this action cannot be undone.
            </p>
            <label className={labelClass} htmlFor={`${tabKey}-reversal-date`}>Reversal date</label>
            <input
              id={`${tabKey}-reversal-date`}
              type="date"
              value={reversalDate}
              onChange={(event) => setReversalDate(event.target.value)}
              className={inputClass}
            />
            <label className={`${labelClass} mt-3`} htmlFor={`${tabKey}-reversal-reason`}>Reason</label>
            <textarea
              id={`${tabKey}-reversal-reason`}
              value={reversalReason}
              onChange={(event) => setReversalReason(event.target.value)}
              className={`${inputClass} min-h-[80px]`}
              placeholder="Why is this voucher being reversed?"
            />
            {reversalError && <div className={`${errorBox} mt-3`}>{reversalError}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={btnGhost} onClick={() => setReversalTarget(null)} disabled={reversing}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitReversal()}
                disabled={reversing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {reversing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                {reversing ? 'Reversing…' : 'Post reversal'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const JournalEntry: React.FC<VoucherEntryProps> = (props) => (
  <VoucherEntryScreen {...props} mode="JOURNAL" />
);

export const CashBankEntry: React.FC<VoucherEntryProps> = (props) => (
  <VoucherEntryScreen {...props} mode="CASH_BANK" />
);
