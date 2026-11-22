/**
 * Lenders — the LEND-1 Finance register.
 *
 * The master holds owner / related-party identity. The loan register holds the
 * agreement terms, and the statement reads posted Loan Payable subledger rows
 * for the lender's book. No figure is recalculated locally: the server owns the
 * ledger and tie-out, and this screen only presents it.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  Download,
  Edit2,
  HandCoins,
  Landmark,
  ListChecks,
  Loader2,
  Plus,
  Printer,
  RefreshCw,
  Trash2,
  Undo2,
  UserRound,
  X,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import {
  createLender,
  createLoan,
  deleteLender,
  getLenderStatement,
  getLenders,
  getLoan,
  getLoans,
  recordLoanInterestAccrual,
  recordLoanReceipt,
  recordLoanRepayment,
  reverseLoanInterestAccrual,
  reverseLoanTransaction,
  updateLender,
  updateLoan,
} from '../../services/api/lenders';
import type {
  LenderInput,
  LenderRecord,
  LenderStatement,
  LenderType,
  LoanInput,
  LoanInstallment,
  LoanInterestAccrual,
  LoanRecord,
  LoanRepaymentFrequency,
  LoanRepaymentInput,
  LoanStatus,
  LoanTdsEntry,
  LoanTransaction,
  TdsExemptionReason,
} from '../../services/api/lenders';
import { getAccountingAccounts, type AccountingAccount } from '../../services/api/accounting';
import { money } from '../../components/accounting/statementFormat';
import { exportToCSV, type CSVColumn } from '../../utils/exportUtils';
import type { Branch, CompanyProfile, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { printLenderTdsCertificate } from '../../utils/lenderTdsCertificate';
import { TDS_REASON_LABEL, TDS_REFERENCE_REQUIRED } from '../../utils/tdsExemption';
import { LenderTdsWorklist } from '../../components/accounting/LenderTdsWorklist';
import { PeriodRangeField } from '../../components/common/PeriodRangeField';
import { useBootstrapData } from '../../contexts/AppProviders';

interface LendersManagementProps {
  currentUser?: User | null;
  dateMode: 'BS' | 'AD';
}

interface LenderForm {
  code: string;
  name: string;
  lenderType: LenderType;
  panNumber: string;
  registrationNumber: string;
  phone: string;
  address: string;
  notes: string;
  defaultCashAccountId: string;
  defaultInterestAccountId: string;
  defaultTdsAccountId: string;
  defaultLoanAccountId: string;
  active: boolean;
}

interface LoanForm {
  branchId: string;
  principal: string;
  interestRate: string;
  startDateAD: string;
  maturityDateAD: string;
  repaymentFrequency: LoanRepaymentFrequency;
  installmentAmount: string;
  securityType: 'UNSECURED' | 'SECURED';
  status: LoanStatus;
  agreementReference: string;
  notes: string;
  tdsApplicable: boolean;
  tdsExemptionReason: '' | TdsExemptionReason;
  tdsExemptionReference: string;
}

interface LoanTxnForm {
  dateAD: string;
  principal: string;
  interestAmount: string;
  tdsAmount: string;
  cashAccountId: string;
  interestAccountId: string;
  tdsAccountId: string;
  tdsExemptionReason: '' | TdsExemptionReason;
  tdsExemptionReference: string;
  chequeNo: string;
  referenceNo: string;
  notes: string;
}

interface StatementExportRow {
  dateAD: string;
  dateBS: string;
  journalNo: string;
  memo: string;
  debit: number;
  credit: number;
  balance: number;
}

const EMPTY_LENDER: LenderForm = {
  code: '',
  name: '',
  lenderType: 'OTHER',
  panNumber: '',
  registrationNumber: '',
  phone: '',
  address: '',
  notes: '',
  defaultCashAccountId: '',
  defaultInterestAccountId: '',
  defaultTdsAccountId: '',
  defaultLoanAccountId: '',
  active: true,
};

const today = () => new Date().toISOString().slice(0, 10);

const addDays = (dateAD: string, days: number) => {
  const parsed = new Date(`${dateAD}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};

const emptyLoanTxn = (loan?: LoanRecord | null): LoanTxnForm => ({
  dateAD: today(),
  principal: loan ? String(loan.outstandingPrincipal || loan.principal) : '',
  interestAmount: '0',
  tdsAmount: '0',
  cashAccountId: '',
  interestAccountId: '',
  tdsAccountId: '',
  tdsExemptionReason: '',
  tdsExemptionReference: '',
  chequeNo: '',
  referenceNo: '',
  notes: '',
});

const emptyLoan = (branchId = ''): LoanForm => ({
  branchId,
  principal: '',
  interestRate: '0',
  startDateAD: today(),
  maturityDateAD: '',
  repaymentFrequency: 'LUMP_SUM',
  installmentAmount: '',
  securityType: 'UNSECURED',
  status: 'OPEN',
  agreementReference: '',
  notes: '',
  tdsApplicable: true,
  tdsExemptionReason: '',
  tdsExemptionReference: '',
});

const LENDER_TYPE_LABEL: Record<LenderType, string> = {
  OWNER: 'Owner',
  RELATED_PARTY: 'Related party',
  OTHER: 'Other',
};

const FREQUENCY_LABEL: Record<LoanRepaymentFrequency, string> = {
  LUMP_SUM: 'Lump sum',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half-yearly',
  ANNUAL: 'Annual',
};

const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:text-white';
const labelClass = 'mb-1 block text-[11px] font-semibold text-slate-600 dark:text-slate-300';
const panelClass =
  'rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]';

function statusBadge(status: LoanStatus) {
  if (status === 'OPEN') {
    return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300';
  }
  if (status === 'CLOSED') {
    return 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';
  }
  return 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300';
}

export const LendersManagement: React.FC<LendersManagementProps> = ({
  currentUser,
  dateMode,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches, companyProfile } = useBootstrapData();
  const { confirm: confirmDialog, alert: alertDialog, prompt: promptDialog } = useDialog();
  const canManage = isOperationAllowed('gl-subledger-manage', currentUser?.role);
  const canPost = isOperationAllowed('gl-post', currentUser?.role);
  const activationKey = useActivationKey('lenders');

  const [lenders, setLenders] = useState<LenderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [loans, setLoans] = useState<LoanRecord[]>([]);
  const [statement, setStatement] = useState<LenderStatement | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [loanStatusFilter, setLoanStatusFilter] = useState<'ALL' | LoanStatus>('ALL');
  const [loanOverdueOnly, setLoanOverdueOnly] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<'REGISTER' | 'TDS_WORKLIST'>('REGISTER');

  const [lenderModal, setLenderModal] = useState(false);
  const [editingLender, setEditingLender] = useState<LenderRecord | null>(null);
  const [lenderForm, setLenderForm] = useState<LenderForm>(EMPTY_LENDER);
  const [savingLender, setSavingLender] = useState(false);

  const [loanModal, setLoanModal] = useState(false);
  const [editingLoan, setEditingLoan] = useState<LoanRecord | null>(null);
  const [loanForm, setLoanForm] = useState<LoanForm>(emptyLoan());
  const [savingLoan, setSavingLoan] = useState(false);
  const [txnModal, setTxnModal] = useState(false);
  const [txnKind, setTxnKind] = useState<'RECEIPT' | 'REPAYMENT'>('RECEIPT');
  const [txnLoan, setTxnLoan] = useState<LoanRecord | null>(null);
  const [txnForm, setTxnForm] = useState<LoanTxnForm>(emptyLoanTxn());
  const [savingTxn, setSavingTxn] = useState(false);
  const [historyLoan, setHistoryLoan] = useState<LoanRecord | null>(null);
  const [historyRows, setHistoryRows] = useState<LoanTransaction[]>([]);
  const [historyInstallments, setHistoryInstallments] = useState<LoanInstallment[]>([]);
  const [historyAccruals, setHistoryAccruals] = useState<LoanInterestAccrual[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [accrualModal, setAccrualModal] = useState(false);
  const [accrualLoan, setAccrualLoan] = useState<LoanRecord | null>(null);
  const [accrualForm, setAccrualForm] = useState({ fromAD: today(), toAD: today() });
  const [savingAccrual, setSavingAccrual] = useState(false);

  const selected = useMemo(
    () => lenders.find((lender) => lender.id === selectedId) || null,
    [lenders, selectedId]
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return lenders;
    return lenders.filter(
      (lender) =>
        lender.code.toLowerCase().includes(needle) ||
        lender.name.toLowerCase().includes(needle) ||
        LENDER_TYPE_LABEL[lender.lenderType].toLowerCase().includes(needle)
    );
  }, [lenders, search]);

  const cashAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.isActive && ['CASH', 'BANK', 'WALLET'].includes(String(account.accountKind))
      ),
    [accounts]
  );
  const expenseAccounts = useMemo(
    () => accounts.filter((account) => account.isActive && !account.isControl && account.accountType === 'EXPENSE'),
    [accounts]
  );
  const liabilityAccounts = useMemo(
    () => accounts.filter((account) => account.isActive && !account.isControl && account.accountType === 'LIABILITY'),
    [accounts]
  );
  const loanAccounts = useMemo(
    () => accounts.filter((account) => account.isActive && account.isControl && account.postingRole === 'LOAN_PAYABLE'),
    [accounts]
  );

  const accountLabel = (account: AccountingAccount): string => `${account.code} · ${account.name}`;

  const loadLenders = async (keepSelection = true) => {
    setLoading(true);
    try {
      const rows = await getLenders(true);
      const list = Array.isArray(rows) ? rows : [];
      setLenders(list);
      setLoadError('');
      if (!keepSelection || !list.some((row) => row.id === selectedId)) {
        setSelectedId(list[0]?.id || '');
      }
    } catch (err: any) {
      setLoadError(err?.message || 'The lender master could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLenders();
    // Refetch on tab re-activation as well as first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);

  useEffect(() => {
    let cancelled = false;
    getAccountingAccounts(true)
      .then((rows) => {
        if (!cancelled) setAccounts(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activationKey]);

  const loadDetail = async (id: string) => {
    if (!id) {
      setLoans([]);
      setStatement(null);
      return;
    }
    setDetailLoading(true);
    setDetailError('');
    try {
      const [loanRows, statementRow] = await Promise.all([
        getLoans({
          lenderId: id,
          status: loanStatusFilter === 'ALL' ? undefined : loanStatusFilter,
          overdue: loanOverdueOnly,
        }),
        getLenderStatement(id, { from: from || undefined, to: to || undefined }),
      ]);
      setLoans(Array.isArray(loanRows) ? loanRows : []);
      setStatement(statementRow);
    } catch (err: any) {
      setDetailError(err?.message || 'The lender statement could not be read.');
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadDetail(selectedId);
    // The date range and the loan filters are part of the reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, from, to, loanStatusFilter, loanOverdueOnly, activationKey]);

  const openCreateLender = () => {
    setEditingLender(null);
    setLenderForm(EMPTY_LENDER);
    setLenderModal(true);
  };

  const openEditLender = (lender: LenderRecord) => {
    setEditingLender(lender);
    setLenderForm({
      code: lender.code,
      name: lender.name,
      lenderType: lender.lenderType,
      panNumber: lender.panNumber || '',
      registrationNumber: lender.registrationNumber || '',
      phone: lender.phone || '',
      address: lender.address || '',
      notes: lender.notes || '',
      defaultCashAccountId: lender.defaultCashAccountId || '',
      defaultInterestAccountId: lender.defaultInterestAccountId || '',
      defaultTdsAccountId: lender.defaultTdsAccountId || '',
      defaultLoanAccountId: lender.defaultLoanAccountId || '',
      active: lender.active,
    });
    setLenderModal(true);
  };

  const submitLender = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!lenderForm.code.trim()) {
      alertDialog('A lender code is required.');
      return;
    }
    if (!lenderForm.name.trim()) {
      alertDialog('A lender name is required.');
      return;
    }
    setSavingLender(true);
    try {
      const payload: LenderInput = {
        code: lenderForm.code.trim().toUpperCase(),
        name: lenderForm.name.trim(),
        lenderType: lenderForm.lenderType,
        panNumber: lenderForm.panNumber.trim() || null,
        registrationNumber: lenderForm.registrationNumber.trim() || null,
        phone: lenderForm.phone.trim() || null,
        address: lenderForm.address.trim() || null,
        notes: lenderForm.notes.trim() || null,
        defaultCashAccountId: lenderForm.defaultCashAccountId || null,
        defaultInterestAccountId: lenderForm.defaultInterestAccountId || null,
        defaultTdsAccountId: lenderForm.defaultTdsAccountId || null,
        defaultLoanAccountId: lenderForm.defaultLoanAccountId || null,
        active: lenderForm.active,
      };
      const saved = editingLender
        ? await updateLender(editingLender.id, payload)
        : await createLender(payload);
      setLenderModal(false);
      await loadLenders(true);
      setSelectedId(saved.id);
    } catch (err: any) {
      alertDialog(`Failed to save lender: ${err?.message || 'Database error'}`);
    } finally {
      setSavingLender(false);
    }
  };

  const removeLender = async (lender: LenderRecord) => {
    if (
      !(await confirmDialog(
        `Delete '${lender.name}'? A lender with loans or posted Loan Payable rows must be retired instead.`
      ))
    ) {
      return;
    }
    try {
      await deleteLender(lender.id);
      if (selectedId === lender.id) setSelectedId('');
      await loadLenders(false);
    } catch (err: any) {
      alertDialog(`Failed to delete lender: ${err?.message || 'Database error'}`);
    }
  };

  const openCreateLoan = () => {
    if (!selected) return;
    setEditingLoan(null);
    setLoanForm(emptyLoan(branches[0]?.id || ''));
    setLoanModal(true);
  };

  const openEditLoan = (loan: LoanRecord) => {
    setEditingLoan(loan);
    setLoanForm({
      branchId: loan.branchId,
      principal: String(loan.principal),
      interestRate: String(loan.interestRate),
      startDateAD: loan.startDateAD,
      maturityDateAD: loan.maturityDateAD || '',
      repaymentFrequency: loan.repaymentFrequency,
      installmentAmount: loan.installmentAmount === null ? '' : String(loan.installmentAmount),
      securityType: loan.securityType,
      status: loan.status,
      agreementReference: loan.agreementReference || '',
      notes: loan.notes || '',
      tdsApplicable: loan.tdsApplicable !== false,
      tdsExemptionReason: (loan.tdsExemptionReason || '') as '' | TdsExemptionReason,
      tdsExemptionReference: loan.tdsExemptionReference || '',
    });
    setLoanModal(true);
  };

  const submitLoan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (!loanForm.branchId) {
      alertDialog('Choose the branch that holds this loan.');
      return;
    }
    if (!(Number(loanForm.principal) > 0)) {
      alertDialog('Loan principal must be a positive amount.');
      return;
    }
    if (!loanForm.tdsApplicable && !loanForm.tdsExemptionReason) {
      alertDialog('Choose a TDS exemption reason for this loan.');
      return;
    }
    if (
      !loanForm.tdsApplicable &&
      loanForm.tdsExemptionReason &&
      TDS_REFERENCE_REQUIRED[loanForm.tdsExemptionReason] &&
      !loanForm.tdsExemptionReference.trim()
    ) {
      alertDialog('Record the certificate, agreement clause or notification relied on.');
      return;
    }
    setSavingLoan(true);
    try {
      const payload: LoanInput = {
        lenderId: selected.id,
        branchId: loanForm.branchId,
        principal: Number(loanForm.principal),
        interestRate: Number(loanForm.interestRate || 0),
        startDateAD: loanForm.startDateAD,
        maturityDateAD: loanForm.maturityDateAD || null,
        repaymentFrequency: loanForm.repaymentFrequency,
        installmentAmount:
          loanForm.installmentAmount === '' ? null : Number(loanForm.installmentAmount),
        securityType: loanForm.securityType,
        status: loanForm.status,
        agreementReference: loanForm.agreementReference.trim() || null,
        notes: loanForm.notes.trim() || null,
        tdsApplicable: loanForm.tdsApplicable,
        tdsExemptionReason: loanForm.tdsApplicable
          ? null
          : loanForm.tdsExemptionReason || null,
        tdsExemptionReference: loanForm.tdsApplicable
          ? null
          : loanForm.tdsExemptionReference.trim() || null,
      };
      if (editingLoan) await updateLoan(editingLoan.id, payload);
      else await createLoan(payload);
      setLoanModal(false);
      await loadDetail(selected.id);
      await loadLenders(true);
    } catch (err: any) {
      alertDialog(`Failed to save loan: ${err?.message || 'Database error'}`);
    } finally {
      setSavingLoan(false);
    }
  };

  const openReceipt = (loan: LoanRecord) => {
    if (!canPost || !selected) return;
    const remaining = Math.max(0, Number(loan.principal) - Number(loan.fundedPrincipal || 0));
    setTxnKind('RECEIPT');
    setTxnLoan(loan);
    setTxnForm({
      ...emptyLoanTxn(loan),
      principal: String(remaining),
      cashAccountId:
        selected.defaultCashAccountId || cashAccounts[0]?.id || '',
    });
    setTxnModal(true);
  };

  const openRepayment = (loan: LoanRecord) => {
    if (!canPost || !selected) return;
    setTxnKind('REPAYMENT');
    setTxnLoan(loan);
    setTxnForm({
      ...emptyLoanTxn(loan),
      cashAccountId: selected.defaultCashAccountId || cashAccounts[0]?.id || '',
      interestAccountId:
        selected.defaultInterestAccountId ||
        expenseAccounts.find((account) => account.code === '6700')?.id ||
        '',
      tdsAccountId:
        selected.defaultTdsAccountId ||
        liabilityAccounts.find((account) => account.code === '2360')?.id ||
        '',
      tdsExemptionReason: (loan.tdsApplicable === false
        ? loan.tdsExemptionReason || ''
        : '') as '' | TdsExemptionReason,
      tdsExemptionReference: loan.tdsApplicable === false ? loan.tdsExemptionReference || '' : '',
    });
    setTxnModal(true);
  };

  const submitLoanTxn = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!txnLoan || !selected) return;
    if (!(Number(txnForm.principal) > 0)) {
      alertDialog('Principal must be a positive amount.');
      return;
    }
    if (!txnForm.cashAccountId) {
      alertDialog('Choose the cash/bank account for this transaction.');
      return;
    }
    setSavingTxn(true);
    try {
      if (txnKind === 'RECEIPT') {
        await recordLoanReceipt(txnLoan.id, {
          dateAD: txnForm.dateAD,
          principal: Number(txnForm.principal),
          cashAccountId: txnForm.cashAccountId,
          chequeNo: txnForm.chequeNo.trim() || null,
          referenceNo: txnForm.referenceNo.trim() || null,
          notes: txnForm.notes.trim() || null,
        });
      } else {
        const interest = Number(txnForm.interestAmount || 0);
        const tds = Number(txnForm.tdsAmount || 0);
        const reason =
          txnForm.tdsExemptionReason ||
          (txnLoan.tdsApplicable === false ? txnLoan.tdsExemptionReason || '' : '');
        const reference =
          txnForm.tdsExemptionReference ||
          (txnLoan.tdsApplicable === false ? txnLoan.tdsExemptionReference || '' : '');
        if (interest > 0 && tds <= 0) {
          if (!reason) {
            alertDialog('A zero-TDS repayment with interest needs an exemption reason.');
            return;
          }
          if (TDS_REFERENCE_REQUIRED[reason] && !reference.trim()) {
            alertDialog('Record the certificate, agreement clause or notification relied on.');
            return;
          }
        }
        const payload: LoanRepaymentInput = {
          dateAD: txnForm.dateAD,
          principal: Number(txnForm.principal),
          interestAmount: interest,
          tdsAmount: tds,
          cashAccountId: txnForm.cashAccountId,
          interestAccountId: txnForm.interestAccountId || undefined,
          tdsAccountId: txnForm.tdsAccountId || undefined,
          tdsExemptionReason: reason || null,
          tdsExemptionReference: reference.trim() || null,
          chequeNo: txnForm.chequeNo.trim() || null,
          referenceNo: txnForm.referenceNo.trim() || null,
          notes: txnForm.notes.trim() || null,
        };
        await recordLoanRepayment(txnLoan.id, payload);
      }
      setTxnModal(false);
      await loadDetail(selected.id);
      await loadLenders(true);
    } catch (err: any) {
      alertDialog(`Failed to record ${txnKind === 'RECEIPT' ? 'receipt' : 'repayment'}: ${err?.message || 'Database error'}`);
    } finally {
      setSavingTxn(false);
    }
  };

  const openHistory = async (loan: LoanRecord) => {
    setHistoryLoan(loan);
    setHistoryRows([]);
    setHistoryInstallments([]);
    setHistoryAccruals([]);
    setHistoryLoading(true);
    try {
      const detail = await getLoan(loan.id);
      setHistoryRows(detail.transactions || []);
      setHistoryInstallments(detail.installments || []);
      setHistoryAccruals(detail.accruals || []);
    } catch (err: any) {
      alertDialog(`Failed to read loan history: ${err?.message || 'Database error'}`);
    } finally {
      setHistoryLoading(false);
    }
  };

  /** A posted receipt/repayment is corrected by a linked reversal, with a reason. */
  const reverseTransaction = async (row: LoanTransaction) => {
    if (!historyLoan) return;
    const reason = await promptDialog(
      `Reverse ${row.txnNumber} (${row.txnType.toLowerCase()} of ${money(row.principalAmount)} principal)? A linked contra journal is posted; the original stays visible.`,
      { title: 'Reverse loan document', placeholder: 'Why is this document being reversed?', confirmLabel: 'Post reversal' }
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      alertDialog('A reversal reason of at least 3 characters is required.');
      return;
    }
    try {
      const result = await reverseLoanTransaction(historyLoan.id, row.id, { reason: reason.trim() });
      const detail = await getLoan(historyLoan.id);
      setHistoryRows(detail.transactions || []);
      setHistoryInstallments(detail.installments || []);
      setHistoryAccruals(detail.accruals || []);
      setHistoryLoan(detail.loan || result.loan);
      await loadLenders(true);
      if (selected?.id === historyLoan.lenderId) await loadDetail(historyLoan.id);
    } catch (err: any) {
      alertDialog(`Failed to reverse the document: ${err?.message || 'Database error'}`);
    }
  };

  const reverseAccrual = async (accrual: LoanInterestAccrual) => {
    if (!historyLoan) return;
    const reason = await promptDialog(
      `Reverse accrual ${accrual.accrualNumber} of ${money(accrual.interestAmount)}? The contra journal clears the accrual; the original stays visible.`,
      { title: 'Reverse interest accrual', placeholder: 'Why is this accrual being reversed?', confirmLabel: 'Post reversal' }
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      alertDialog('A reversal reason of at least 3 characters is required.');
      return;
    }
    try {
      const result = await reverseLoanInterestAccrual(historyLoan.id, accrual.id, {
        reason: reason.trim(),
      });
      const detail = await getLoan(historyLoan.id);
      setHistoryRows(detail.transactions || []);
      setHistoryInstallments(detail.installments || []);
      setHistoryAccruals(detail.accruals || []);
      setHistoryLoan(detail.loan || result.loan);
      if (selected) await loadDetail(selected.id);
    } catch (err: any) {
      alertDialog(`Failed to reverse the accrual: ${err?.message || 'Database error'}`);
    }
  };

  const openAccrual = (loan: LoanRecord) => {
    if (!canPost) return;
    const fromAD = loan.lastAccrualDateAD
      ? addDays(loan.lastAccrualDateAD, 1)
      : loan.startDateAD;
    setAccrualLoan(loan);
    setAccrualForm({ fromAD, toAD: today() < fromAD ? fromAD : today() });
    setAccrualModal(true);
  };

  const submitAccrual = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!accrualLoan || !selected) return;
    if (!accrualForm.fromAD || !accrualForm.toAD) {
      alertDialog('Choose the interest accrual period.');
      return;
    }
    if (accrualForm.toAD < accrualForm.fromAD) {
      alertDialog('The accrual end date must not be before its start.');
      return;
    }
    setSavingAccrual(true);
    try {
      await recordLoanInterestAccrual(accrualLoan.id, {
        fromAD: accrualForm.fromAD,
        toAD: accrualForm.toAD,
      });
      setAccrualModal(false);
      await loadDetail(selected.id);
      await loadLenders(true);
      if (historyLoan?.id === accrualLoan.id) {
        const detail = await getLoan(accrualLoan.id);
        setHistoryRows(detail.transactions || []);
        setHistoryInstallments(detail.installments || []);
        setHistoryAccruals(detail.accruals || []);
        setHistoryLoan(detail.loan);
      }
    } catch (err: any) {
      alertDialog(`Failed to accrue interest: ${err?.message || 'Database error'}`);
    } finally {
      setSavingAccrual(false);
    }
  };

  const handlePrintCertificate = () => {
    if (!statement || statement.tdsEntries.length === 0) return;
    if (!printLenderTdsCertificate(statement, companyProfile)) {
      alertDialog('Allow pop-ups for this site to open the printable TDS certificate.');
    }
  };

  const handleExportTds = () => {
    if (!statement || statement.tdsEntries.length === 0) return;
    const rows: LoanTdsEntry[] = statement.tdsEntries;
    const columns: CSVColumn<LoanTdsEntry>[] = [
      { key: 'dateAD', label: 'Date (AD)' },
      { key: 'dateBS', label: 'Date (BS)' },
      { key: 'loanNumber', label: 'Loan' },
      { key: 'txnNumber', label: 'Repayment' },
      { key: 'journalNo', label: 'Journal No' },
      { key: 'tdsStatus', label: 'TDS Status' },
      { key: 'principalAmount', label: 'Principal (NPR)' },
      { key: 'interestAmount', label: 'Interest (NPR)' },
      { key: 'tdsAmount', label: 'TDS Withheld (NPR)' },
      { key: 'cashAmount', label: 'Net Cash (NPR)' },
      { key: 'exemptionReason', label: 'Exemption Reason' },
      { key: 'exemptionReference', label: 'Evidence / Reference' },
    ];
    exportToCSV({
      filename: `Lender_TDS_${statement.lender.code}`,
      data: rows,
      columns,
      reportTitle: `Lender TDS Withheld — ${statement.lender.name} (${statement.lender.code})`,
      branchName: statement.branchId,
    });
  };

  const handleExportStatement = () => {
    if (!statement) return;
    const rows: StatementExportRow[] = statement.entries.map((entry) => ({
      dateAD: entry.dateAD,
      dateBS: entry.dateBS || '',
      journalNo: entry.journalNo,
      memo: entry.memo,
      debit: entry.debit,
      credit: entry.credit,
      balance: entry.balance,
    }));
    const columns: CSVColumn<StatementExportRow>[] = [
      { key: 'dateAD', label: 'Date (AD)' },
      { key: 'dateBS', label: 'Date (BS)' },
      { key: 'journalNo', label: 'Journal No' },
      { key: 'memo', label: 'Narration' },
      { key: 'debit', label: 'Debit (NPR)' },
      { key: 'credit', label: 'Credit (NPR)' },
      { key: 'balance', label: 'Running Balance (NPR)' },
    ];
    exportToCSV({
      filename: `Lender_Statement_${statement.lender.code}`,
      data: rows,
      columns,
      reportTitle: `Lender Statement — ${statement.lender.name} (${statement.lender.code})`,
      branchName: statement.branchId,
    });
  };

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-4 overflow-hidden">
      <PageHeader
        title="Lenders"
        description={
          workspaceView === 'TDS_WORKLIST'
            ? 'Legacy zero-TDS repayments that still need audit evidence'
            : loadError && lenders.length === 0
              ? 'Lender register unavailable — retry below'
              : `${lenders.length} lenders · owner and related-party borrowing in the Loan Payable ledger`
        }
        icon={<Landmark className="h-5 w-5 text-indigo-500" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl border border-slate-300 p-0.5 dark:border-slate-700">
              <button
                type="button"
                onClick={() => setWorkspaceView('REGISTER')}
                className={`flex cursor-pointer items-center gap-1.5 rounded-[9px] px-2.5 py-1 text-[11px] font-semibold ${
                  workspaceView === 'REGISTER'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <Landmark className="h-3.5 w-3.5" /> Register
              </button>
              <button
                type="button"
                onClick={() => setWorkspaceView('TDS_WORKLIST')}
                className={`flex cursor-pointer items-center gap-1.5 rounded-[9px] px-2.5 py-1 text-[11px] font-semibold ${
                  workspaceView === 'TDS_WORKLIST'
                    ? 'bg-amber-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <ListChecks className="h-3.5 w-3.5" /> TDS cleanup
              </button>
            </div>
            {workspaceView === 'REGISTER' ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void loadLenders(true);
                    void loadDetail(selectedId);
                  }}
                  className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </button>
                {canManage ? (
                  <button
                    type="button"
                    onClick={openCreateLender}
                    className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-indigo-500"
                  >
                    <Plus className="h-4 w-4" /> Add Lender
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        }
      />

      {workspaceView === 'TDS_WORKLIST' ? (
        <LenderTdsWorklist currentUser={currentUser} dateMode={dateMode} />
      ) : (
        <>

      <FilterCard
        searchPlaceholder="Search code, name or lender type…"
        searchValue={search}
        onSearchApply={setSearch}
        hasActiveFilters={Boolean(search)}
        onClearAll={() => setSearch('')}
      />

      <LoadStateNotice
        subject="lenders"
        loading={loading}
        error={loadError}
        hasCachedRows={lenders.length > 0}
        onRetry={() => void loadLenders(true)}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden xl:grid-cols-12">
        <section className={`${panelClass} flex min-h-0 flex-col overflow-hidden xl:col-span-5`}>
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
              Lender master
            </h2>
            <span className="text-[10px] font-semibold text-slate-500">
              {filtered.length} of {lenders.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
                <tr>
                  <th className="px-2.5 py-1.5">Code / lender</th>
                  <th className="px-2.5 py-1.5">Type</th>
                  <th className="px-2.5 py-1.5 text-right">Loan balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="p-6 text-center text-slate-500">
                      {loading
                        ? 'Loading lenders…'
                        : loadError
                          ? 'The lender list could not be loaded — use Retry above.'
                          : lenders.length === 0
                            ? 'No lenders yet. Add the owner or related party before registering a loan.'
                            : 'No lenders match this search.'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((lender) => (
                    <tr
                      key={lender.id}
                      onClick={() => setSelectedId(lender.id)}
                      className={`cursor-pointer transition-colors ${
                        selectedId === lender.id
                          ? 'bg-indigo-50 dark:bg-indigo-950/30'
                          : 'hover:bg-slate-100 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <td className="px-2.5 py-2">
                        <div className="font-mono text-[10px] font-bold text-indigo-600 dark:text-indigo-400">
                          {lender.code}
                        </div>
                        <div className="font-bold text-slate-900 dark:text-white">{lender.name}</div>
                        <div className="text-[10px] text-slate-500">
                          {lender.loanCount} loan{lender.loanCount === 1 ? '' : 's'}
                          {!lender.active ? ' · retired' : ''}
                        </div>
                      </td>
                      <td className="px-2.5 py-2 text-slate-600 dark:text-slate-400">
                        {LENDER_TYPE_LABEL[lender.lenderType]}
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono font-bold text-slate-900 dark:text-white">
                        {money(lender.bookBalance)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={`${panelClass} flex min-h-0 flex-col overflow-hidden xl:col-span-7`}>
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-slate-500">
              <UserRound className="h-8 w-8 text-slate-300" />
              <p className="text-sm font-semibold">Choose a lender to see its loans and statement.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-slate-900 dark:text-white">{selected.name}</h2>
                    <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">
                      {LENDER_TYPE_LABEL[selected.lenderType]}
                    </span>
                    {!selected.active ? (
                      <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        Retired
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[10px] text-slate-500">
                    {selected.code}
                    {selected.panNumber ? ` · PAN ${selected.panNumber}` : ''}
                    {selected.phone ? ` · ${selected.phone}` : ''}
                  </p>
                </div>
                {canManage ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEditLender(selected)}
                      className="cursor-pointer rounded-lg p-1.5 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                      title={`Edit ${selected.name}`}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeLender(selected)}
                      className="cursor-pointer rounded-lg p-1.5 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                      title={`Delete ${selected.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-3">
                {detailError ? (
                  <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
                    {detailError}
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-800/60">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Lender book</p>
                    <p className="mt-0.5 font-mono text-xs font-bold text-slate-900 dark:text-white">
                      {selected.bookCode || 'Not created'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-800/60">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Open principal</p>
                    <p className="mt-0.5 font-mono text-xs font-bold text-slate-900 dark:text-white">
                      {money(selected.openPrincipal)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-800/60">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Posted balance</p>
                    <p className="mt-0.5 font-mono text-xs font-bold text-slate-900 dark:text-white">
                      {money(selected.bookBalance)}
                    </p>
                  </div>
                </div>

                {!selected.bookId ? (
                  <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    No LENDER book exists for this lender. Create the Loan Payable control account and
                    subledger book before posting borrowing journals.
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                    <BookOpen className="h-3.5 w-3.5" /> Loan register
                  </h3>
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className={labelClass}>Status</label>
                      <select
                        value={loanStatusFilter}
                        onChange={(event) =>
                          setLoanStatusFilter(event.target.value as 'ALL' | LoanStatus)
                        }
                        className={inputClass}
                      >
                        <option value="ALL">All statuses</option>
                        <option value="OPEN">Open</option>
                        <option value="CLOSED">Closed</option>
                        <option value="CANCELLED">Cancelled</option>
                      </select>
                    </div>
                    <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={loanOverdueOnly}
                        onChange={(event) => setLoanOverdueOnly(event.target.checked)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-rose-600"
                      />
                      Overdue
                    </label>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={openCreateLoan}
                        className="flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-indigo-500"
                      >
                        <Plus className="h-3 w-3" /> Add loan
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="mt-1.5 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full min-w-[1080px] border-collapse text-left text-[11px]">
                    <thead className="bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-[#12161f] dark:text-slate-400">
                      <tr>
                        <th className="px-2 py-1.5">Loan</th>
                        <th className="px-2 py-1.5">Branch</th>
                        <th className="px-2 py-1.5 text-right">Principal</th>
                        <th className="px-2 py-1.5 text-right">Funded</th>
                        <th className="px-2 py-1.5 text-right">Repaid</th>
                        <th className="px-2 py-1.5 text-right">Outstanding</th>
                        <th className="px-2 py-1.5 text-right">Rate</th>
                        <th className="px-2 py-1.5">Terms</th>
                        <th className="px-2 py-1.5">Next due</th>
                        <th className="px-2 py-1.5">Status</th>
                        <th className="px-2 py-1.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {loans.length === 0 ? (
                        <tr>
                          <td colSpan={11} className="p-4 text-center text-slate-500">
                            {detailLoading
                              ? 'Loading loan register…'
                              : loanStatusFilter !== 'ALL' || loanOverdueOnly
                                ? 'No loans match these filters.'
                                : 'No loans are registered for this lender.'}
                          </td>
                        </tr>
                      ) : (
                        loans.map((loan) => (
                          <tr key={loan.id}>
                            <td className="px-2 py-1.5">
                              <div className="font-mono text-[10px] font-bold text-indigo-600 dark:text-indigo-400">
                                {loan.loanNumber}
                              </div>
                              <div className="text-[10px] text-slate-500">
                                {loan.agreementReference || 'No agreement ref.'}
                              </div>
                            </td>
                            <td className="px-2 py-1.5 text-slate-600 dark:text-slate-400">
                              {loan.branchCode}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">{money(loan.principal)}</td>
                            <td className="px-2 py-1.5 text-right font-mono">{money(loan.fundedPrincipal)}</td>
                            <td className="px-2 py-1.5 text-right font-mono">{money(loan.repaidPrincipal)}</td>
                            <td className="px-2 py-1.5 text-right font-mono font-bold">
                              {money(loan.outstandingPrincipal)}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">
                              {Number(loan.interestRate).toFixed(2)}%
                              <div className="text-[10px] font-sans font-semibold text-slate-500">
                                {loan.tdsApplicable
                                  ? 'TDS 15%'
                                  : `TDS exempt · ${loan.tdsExemptionReason || 'reason missing'}`}
                              </div>
                            </td>
                            <td className="px-2 py-1.5 text-slate-600 dark:text-slate-400">
                              {loan.startDateAD}
                              {loan.maturityDateAD ? ` → ${loan.maturityDateAD}` : ''}
                              <div className="text-[10px] text-slate-500">
                                {FREQUENCY_LABEL[loan.repaymentFrequency]} · {loan.securityType}
                              </div>
                            </td>
                            <td className="px-2 py-1.5 text-slate-600 dark:text-slate-400">
                              {loan.nextDueDateAD ? (
                                <>
                                  <div className="font-mono text-[10px] font-bold">{loan.nextDueDateAD}</div>
                                  <div className="text-[10px] text-slate-500">
                                    {money(loan.nextDueAmount || 0)} · {loan.installmentCount} inst.
                                  </div>
                                  {loan.overdueInstallments > 0 ? (
                                    <div className="text-[10px] font-bold text-rose-600 dark:text-rose-400">
                                      {loan.overdueInstallments} overdue
                                    </div>
                                  ) : null}
                                </>
                              ) : (
                                <span className="text-slate-400">Settled</span>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <span
                                className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${statusBadge(loan.status)}`}
                              >
                                {loan.status}
                              </span>
                              {loan.overdue ? (
                                <span className="ml-1 inline-flex rounded-full border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                                  Overdue
                                </span>
                              ) : null}
                            </td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              {canPost && loan.status === 'OPEN' && loan.outstandingPrincipal > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => openAccrual(loan)}
                                  className="cursor-pointer rounded p-0.5 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40"
                                  title={`Accrue interest ${loan.loanNumber}`}
                                >
                                  <CalendarClock className="h-3 w-3" />
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void openHistory(loan)}
                                className="ml-1 cursor-pointer rounded p-0.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                                title={`History ${loan.loanNumber}`}
                              >
                                <BookOpen className="h-3 w-3" />
                              </button>
                              {canPost && loan.status === 'OPEN' && loan.fundedPrincipal < loan.principal ? (
                                <button
                                  type="button"
                                  onClick={() => openReceipt(loan)}
                                  className="ml-1 cursor-pointer rounded p-0.5 text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                                  title={`Receive ${loan.loanNumber}`}
                                >
                                  <HandCoins className="h-3 w-3" />
                                </button>
                              ) : null}
                              {canPost && loan.outstandingPrincipal > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => openRepayment(loan)}
                                  className="ml-1 cursor-pointer rounded p-0.5 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                                  title={`Repay ${loan.loanNumber}`}
                                >
                                  <Undo2 className="h-3 w-3" />
                                </button>
                              ) : null}
                              {canManage ? (
                                <button
                                  type="button"
                                  onClick={() => openEditLoan(loan)}
                                  className="ml-1 cursor-pointer rounded p-0.5 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                                  title={`Edit ${loan.loanNumber}`}
                                >
                                  <Edit2 className="h-3 w-3" />
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 flex flex-wrap items-end justify-between gap-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                    <Landmark className="h-3.5 w-3.5" /> Lender statement
                  </h3>
                  <div className="flex flex-wrap items-end gap-2">
                    <PeriodRangeField
                      from={from}
                      to={to}
                      onChange={(range) => {
                        setFrom(range.from);
                        setTo(range.to);
                      }}
                      label="Period (AD)"
                      startAriaLabel="Lender statement from"
                      endAriaLabel="Lender statement to"
                      requireEnd={false}
                      mode={dateMode}
                    />
                    <button
                      type="button"
                      onClick={() => void loadDetail(selected.id)}
                      className="flex h-9 cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <RefreshCw className="h-3 w-3" /> Reload
                    </button>
                    <button
                      type="button"
                      onClick={handleExportStatement}
                      disabled={!statement || statement.entries.length === 0}
                      className="flex h-9 cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Download className="h-3 w-3" /> CSV
                    </button>
                  </div>
                </div>

                {detailLoading && !statement ? (
                  <div className="flex items-center justify-center p-6 text-xs text-slate-500">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading statement…
                  </div>
                ) : statement ? (
                  <>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {[
                        ['Opening', statement.openingBalance],
                        ['Debit', statement.totals.debit],
                        ['Credit', statement.totals.credit],
                        ['Closing', statement.totals.closingBalance],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-800/60">
                          <p className="text-[10px] font-bold uppercase text-slate-500">{label}</p>
                          <p className="mt-0.5 font-mono text-xs font-bold text-slate-900 dark:text-white">
                            {money(Number(value))}
                          </p>
                        </div>
                      ))}
                    </div>

                    <div
                      className={`mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[11px] ${
                        statement.tieOut.status === 'RECONCILED'
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
                          : 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300'
                      }`}
                    >
                      <span>
                        Loan Payable control {statement.tieOut.status.toLowerCase()} · GL{' '}
                        {money(statement.tieOut.glBalance)} / subledger{' '}
                        {money(statement.tieOut.subledgerBalance)} / lender books{' '}
                        {money(statement.tieOut.lenderBooksBalance)}
                      </span>
                      <span className="font-mono font-bold">
                        Difference {money(statement.tieOut.difference)} · books{' '}
                        {money(statement.tieOut.booksDifference)}
                      </span>
                    </div>

                    <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                      <table className="w-full border-collapse text-left text-[11px]">
                        <thead className="bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-[#12161f] dark:text-slate-400">
                          <tr>
                            <th className="px-2 py-1.5">Date</th>
                            <th className="px-2 py-1.5">Journal</th>
                            <th className="px-2 py-1.5">Narration</th>
                            <th className="px-2 py-1.5 text-right">Debit</th>
                            <th className="px-2 py-1.5 text-right">Credit</th>
                            <th className="px-2 py-1.5 text-right">Balance</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {statement.entries.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="p-4 text-center text-slate-500">
                                No posted Loan Payable rows for this lender in the selected period.
                              </td>
                            </tr>
                          ) : (
                            statement.entries.map((entry) => (
                              <tr key={entry.id}>
                                <td className="px-2 py-1.5 text-slate-600 dark:text-slate-400">
                                  {entry.dateAD}
                                </td>
                                <td className="px-2 py-1.5 font-mono text-[10px] font-bold text-indigo-600 dark:text-indigo-400">
                                  {entry.journalNo}
                                </td>
                                <td className="px-2 py-1.5 text-slate-600 dark:text-slate-400">
                                  {entry.memo || '—'}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {entry.debit ? money(entry.debit) : '—'}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {entry.credit ? money(entry.credit) : '—'}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono font-bold">
                                  {money(entry.balance)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-2.5 py-2 dark:border-slate-800">
                        <div>
                          <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                            TDS register — lender interest
                          </h4>
                          <p className="text-[10px] text-slate-500">
                            Withheld interest {money(statement.tdsTotals.withheldInterest)} · tax{' '}
                            {money(statement.tdsTotals.withheldTax)} · exempt interest{' '}
                            {money(statement.tdsTotals.exemptInterest)} · unexplained{' '}
                            {money(statement.tdsTotals.unexplainedInterest)}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={handlePrintCertificate}
                            disabled={
                              !statement.tdsEntries.some((row) => row.tdsStatus === 'WITHHELD')
                            }
                            className="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-indigo-300 px-2 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
                          >
                            <Printer className="h-3 w-3" /> Certificate
                          </button>
                          <button
                            type="button"
                            onClick={handleExportTds}
                            disabled={statement.tdsEntries.length === 0}
                            className="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            <Download className="h-3 w-3" /> TDS CSV
                          </button>
                        </div>
                      </div>
                      <div
                        className={`mx-2.5 mt-2 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold ${
                          statement.tdsTotals.reconciled
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
                            : 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300'
                        }`}
                      >
                        {statement.tdsTotals.reconciled
                          ? 'Register reconciles to the posted repayment ledger'
                          : `Register differs from the repayment ledger — principal ${money(
                              statement.tdsTotals.principalDifference
                            )}, interest ${money(
                              statement.tdsTotals.interestDifference
                            )}, TDS ${money(statement.tdsTotals.tdsDifference)}, cash ${money(
                              statement.tdsTotals.cashDifference
                            )}`}
                      </div>
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full min-w-[900px] border-collapse text-left text-[11px]">
                          <thead className="bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-[#12161f] dark:text-slate-400">
                            <tr>
                              <th className="px-2 py-1.5">Date</th>
                              <th className="px-2 py-1.5">Loan</th>
                              <th className="px-2 py-1.5">Repayment</th>
                              <th className="px-2 py-1.5">Status</th>
                              <th className="px-2 py-1.5 text-right">Principal</th>
                              <th className="px-2 py-1.5 text-right">Interest</th>
                              <th className="px-2 py-1.5 text-right">TDS</th>
                              <th className="px-2 py-1.5 text-right">Net cash</th>
                              <th className="px-2 py-1.5">Reason / reference</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                            {statement.tdsEntries.length === 0 ? (
                              <tr>
                                <td colSpan={9} className="p-4 text-center text-slate-500">
                                  No repayments were posted for this lender in the period.
                                </td>
                              </tr>
                            ) : (
                              statement.tdsEntries.map((row) => (
                                <tr key={row.id}>
                                  <td className="px-2 py-1.5">{row.dateAD}</td>
                                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.loanNumber}</td>
                                  <td className="px-2 py-1.5 font-mono text-[10px]">
                                    {row.txnNumber}
                                    <div className="text-slate-500">{row.journalNo}</div>
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <span
                                      className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${
                                        row.tdsStatus === 'WITHHELD'
                                          ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300'
                                          : row.tdsStatus === 'EXEMPT'
                                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                                            : row.tdsStatus === 'UNEXPLAINED'
                                              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
                                              : 'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                                      }`}
                                    >
                                      {row.tdsStatus}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono">{money(row.principalAmount)}</td>
                                  <td className="px-2 py-1.5 text-right font-mono">{money(row.interestAmount)}</td>
                                  <td className="px-2 py-1.5 text-right font-mono font-bold">{money(row.tdsAmount)}</td>
                                  <td className="px-2 py-1.5 text-right font-mono">{money(row.cashAmount)}</td>
                                  <td className="px-2 py-1.5 text-slate-600 dark:text-slate-400">
                                    {row.exemptionReason ? (
                                      <>
                                        <div className="font-semibold">{row.exemptionReason}</div>
                                        <div className="text-[10px] text-slate-500">
                                          {row.exemptionReference || 'No reference'}
                                        </div>
                                      </>
                                    ) : row.tdsStatus === 'WITHHELD' ? (
                                      'Tax withheld'
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                          {statement.tdsEntries.length > 0 ? (
                            <tfoot className="border-t border-slate-300 bg-slate-50 font-bold dark:border-slate-700 dark:bg-slate-800/60">
                              <tr>
                                <td colSpan={4} className="px-2 py-1.5 text-right uppercase text-[10px]">
                                  Totals · {statement.tdsTotals.withheldCount} withheld ·{' '}
                                  {statement.tdsTotals.exemptCount} exempt
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {money(statement.tdsTotals.principal)}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {money(statement.tdsTotals.interest)}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {money(statement.tdsTotals.tds)}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {money(statement.tdsTotals.cash)}
                                </td>
                                <td className="px-2 py-1.5 text-[10px]">
                                  Ledger {money(statement.tdsTotals.ledgerInterest)} interest ·{' '}
                                  {money(statement.tdsTotals.ledgerTds)} TDS
                                </td>
                              </tr>
                            </tfoot>
                          ) : null}
                        </table>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">
                    {statement === null && !detailError
                      ? 'The statement needs a Loan Payable control account.'
                      : 'No statement data is available.'}
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
        </>
      )}

      {lenderModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={editingLender ? 'Edit Lender' : 'Add Lender'}
            onClose={() => setLenderModal(false)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold">{editingLender ? 'Edit Lender' : 'Add Lender'}</h3>
              <button
                type="button"
                onClick={() => setLenderModal(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={submitLender} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Code *</label>
                  <input
                    value={lenderForm.code}
                    disabled={Boolean(editingLender)}
                    onChange={(event) =>
                      setLenderForm({ ...lenderForm, code: event.target.value.toUpperCase() })
                    }
                    placeholder="OWNER-01"
                    className={`${inputClass} font-mono disabled:opacity-60`}
                  />
                </div>
                <div>
                  <label className={labelClass}>Name *</label>
                  <input
                    value={lenderForm.name}
                    onChange={(event) => setLenderForm({ ...lenderForm, name: event.target.value })}
                    placeholder="Promoter / related company"
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Lender type</label>
                  <select
                    value={lenderForm.lenderType}
                    onChange={(event) =>
                      setLenderForm({
                        ...lenderForm,
                        lenderType: event.target.value as LenderType,
                      })
                    }
                    className={inputClass}
                  >
                    <option value="OWNER">Owner</option>
                    <option value="RELATED_PARTY">Related party</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>PAN</label>
                  <input
                    value={lenderForm.panNumber}
                    onChange={(event) => setLenderForm({ ...lenderForm, panNumber: event.target.value })}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Registration / agreement no.</label>
                  <input
                    value={lenderForm.registrationNumber}
                    onChange={(event) =>
                      setLenderForm({ ...lenderForm, registrationNumber: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Phone</label>
                  <input
                    value={lenderForm.phone}
                    onChange={(event) => setLenderForm({ ...lenderForm, phone: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Address</label>
                  <input
                    value={lenderForm.address}
                    onChange={(event) => setLenderForm({ ...lenderForm, address: event.target.value })}
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Notes</label>
                <textarea
                  value={lenderForm.notes}
                  onChange={(event) => setLenderForm({ ...lenderForm, notes: event.target.value })}
                  rows={2}
                  className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                />
              </div>
              <div className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
                <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                  Default posting accounts
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Cash / bank</label>
                    <select
                      value={lenderForm.defaultCashAccountId}
                      onChange={(event) =>
                        setLenderForm({ ...lenderForm, defaultCashAccountId: event.target.value })
                      }
                      className={inputClass}
                    >
                      <option value="">Choose on each document</option>
                      {cashAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {accountLabel(account)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Loan Payable control</label>
                    <select
                      value={lenderForm.defaultLoanAccountId}
                      onChange={(event) =>
                        setLenderForm({ ...lenderForm, defaultLoanAccountId: event.target.value })
                      }
                      className={inputClass}
                    >
                      <option value="">Use the chart default</option>
                      {loanAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {accountLabel(account)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Interest expense</label>
                    <select
                      value={lenderForm.defaultInterestAccountId}
                      onChange={(event) =>
                        setLenderForm({ ...lenderForm, defaultInterestAccountId: event.target.value })
                      }
                      className={inputClass}
                    >
                      <option value="">Use Interest Expense 6700</option>
                      {expenseAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {accountLabel(account)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>TDS payable</label>
                    <select
                      value={lenderForm.defaultTdsAccountId}
                      onChange={(event) =>
                        setLenderForm({ ...lenderForm, defaultTdsAccountId: event.target.value })
                      }
                      className={inputClass}
                    >
                      <option value="">Use TDS Payable 2360</option>
                      {liabilityAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {accountLabel(account)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={lenderForm.active}
                  onChange={(event) => setLenderForm({ ...lenderForm, active: event.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                <span className="font-semibold">Active — available for new borrowing</span>
              </label>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setLenderModal(false)}
                  className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingLender}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingLender ? 'Saving…' : editingLender ? 'Save Changes' : 'Add Lender'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      ) : null}

      {txnModal && txnLoan && selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={txnKind === 'RECEIPT' ? 'Receive Loan' : 'Repay Loan'}
            onClose={() => setTxnModal(false)}
            className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">
                  {txnKind === 'RECEIPT' ? 'Receive loan' : 'Repay loan'}
                </h3>
                <p className="text-[10px] text-slate-500">
                  {txnLoan.loanNumber} · {selected.name} · outstanding {money(txnLoan.outstandingPrincipal)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTxnModal(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={submitLoanTxn} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Date *</label>
                  <input
                    type="date"
                    value={txnForm.dateAD}
                    onChange={(event) => setTxnForm({ ...txnForm, dateAD: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Principal *</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={txnForm.principal}
                    onChange={(event) => setTxnForm({ ...txnForm, principal: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Cash / bank *</label>
                  <select
                    value={txnForm.cashAccountId}
                    onChange={(event) =>
                      setTxnForm({ ...txnForm, cashAccountId: event.target.value })
                    }
                    className={inputClass}
                  >
                    <option value="">Choose account</option>
                    {cashAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {accountLabel(account)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {txnKind === 'REPAYMENT' ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelClass}>Interest</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={txnForm.interestAmount}
                        onChange={(event) =>
                          setTxnForm({ ...txnForm, interestAmount: event.target.value })
                        }
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>TDS withheld from interest</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={txnForm.tdsAmount}
                        onChange={(event) => setTxnForm({ ...txnForm, tdsAmount: event.target.value })}
                        className={inputClass}
                      />
                    </div>
                  </div>
                  {txnLoan.interestAccrued > 0 ? (
                    <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                      Accrued interest on this loan: {money(txnLoan.interestAccrued)}. Interest on
                      this repayment clears the accrued payable first; any excess goes to interest
                      expense.
                    </p>
                  ) : null}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelClass}>Interest account</label>
                      <select
                        value={txnForm.interestAccountId}
                        onChange={(event) =>
                          setTxnForm({ ...txnForm, interestAccountId: event.target.value })
                        }
                        className={inputClass}
                      >
                        <option value="">Choose expense account</option>
                        {expenseAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {accountLabel(account)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>TDS payable account</label>
                      <select
                        value={txnForm.tdsAccountId}
                        onChange={(event) =>
                          setTxnForm({ ...txnForm, tdsAccountId: event.target.value })
                        }
                        className={inputClass}
                      >
                        <option value="">Choose liability account</option>
                        {liabilityAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {accountLabel(account)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {Number(txnForm.tdsAmount || 0) <= 0 ? (
                    <div className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                        Zero-TDS evidence
                      </p>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label className={labelClass}>Exemption reason</label>
                          <select
                            value={txnForm.tdsExemptionReason}
                            onChange={(event) =>
                              setTxnForm({
                                ...txnForm,
                                tdsExemptionReason: event.target.value as
                                  | ''
                                  | TdsExemptionReason,
                              })
                            }
                            className={inputClass}
                          >
                            <option value="">TDS withheld / no exemption</option>
                            {Object.entries(TDS_REASON_LABEL).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={labelClass}>
                            Evidence / reference
                            {txnForm.tdsExemptionReason &&
                            TDS_REFERENCE_REQUIRED[txnForm.tdsExemptionReason]
                              ? ' *'
                              : ''}
                          </label>
                          <input
                            value={txnForm.tdsExemptionReference}
                            onChange={(event) =>
                              setTxnForm({
                                ...txnForm,
                                tdsExemptionReference: event.target.value,
                              })
                            }
                            placeholder="Certificate, agreement clause or notification"
                            className={inputClass}
                          />
                        </div>
                      </div>
                      {Number(txnForm.interestAmount || 0) > 0 ? (
                        <p className="mt-2 text-[10px] text-slate-500">
                          Positive interest with zero TDS is refused unless a reason is recorded
                          here or on the loan.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                    Net cash paid:{' '}
                    <span className="font-mono font-bold">
                      {money(
                        Number(txnForm.principal || 0) +
                          Number(txnForm.interestAmount || 0) -
                          Number(txnForm.tdsAmount || 0)
                      )}
                    </span>
                  </p>
                </>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Cheque no.</label>
                  <input
                    value={txnForm.chequeNo}
                    onChange={(event) => setTxnForm({ ...txnForm, chequeNo: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Reference no.</label>
                  <input
                    value={txnForm.referenceNo}
                    onChange={(event) => setTxnForm({ ...txnForm, referenceNo: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Notes</label>
                  <input
                    value={txnForm.notes}
                    onChange={(event) => setTxnForm({ ...txnForm, notes: event.target.value })}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setTxnModal(false)}
                  className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTxn}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingTxn ? 'Posting…' : txnKind === 'RECEIPT' ? 'Post Receipt' : 'Post Repayment'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      ) : null}

      {historyLoan ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={`Loan history — ${historyLoan.loanNumber}`}
            onClose={() => setHistoryLoan(null)}
            className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">Loan history</h3>
                <p className="text-[10px] text-slate-500">
                  {historyLoan.loanNumber} · principal {money(historyLoan.principal)} · outstanding{' '}
                  {money(historyLoan.outstandingPrincipal)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryLoan(null)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {historyLoading ? (
              <div className="flex items-center justify-center p-6 text-xs text-slate-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading history…
              </div>
            ) : (
              <div className="max-h-[72vh] space-y-4 overflow-y-auto pr-1">
                <section>
                  <div className="mb-1.5 flex items-center justify-between">
                    <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                      Installment schedule
                    </h4>
                    <span className="text-[10px] text-slate-500">
                      {historyInstallments.length} due date{historyInstallments.length === 1 ? '' : 's'}
                      {historyLoan.overdueInstallments > 0
                        ? ` · ${historyLoan.overdueInstallments} overdue`
                        : ''}
                    </span>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                    <table className="w-full min-w-[760px] text-left text-[11px]">
                      <thead className="bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-[#12161f] dark:text-slate-400">
                        <tr>
                          <th className="px-2 py-1.5">#</th>
                          <th className="px-2 py-1.5">Due date</th>
                          <th className="px-2 py-1.5 text-right">Principal due</th>
                          <th className="px-2 py-1.5 text-right">Principal paid</th>
                          <th className="px-2 py-1.5 text-right">Interest due</th>
                          <th className="px-2 py-1.5 text-right">Interest paid</th>
                          <th className="px-2 py-1.5 text-right">TDS</th>
                          <th className="px-2 py-1.5 text-right">Outstanding</th>
                          <th className="px-2 py-1.5">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {historyInstallments.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="p-4 text-center text-slate-500">
                              No schedule rows exist for this loan.
                            </td>
                          </tr>
                        ) : (
                          historyInstallments.map((row) => (
                            <tr key={row.id}>
                              <td className="px-2 py-1.5 font-mono">{row.sequenceNumber}</td>
                              <td className="px-2 py-1.5">
                                <div className="font-mono text-[10px] font-bold">{row.dueDateAD}</div>
                                <div className="text-[10px] text-slate-500">{row.dueDateBS}</div>
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.principalDue)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.principalPaid)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.interestDue)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.interestPaid)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.tdsPaid)}</td>
                              <td className="px-2 py-1.5 text-right font-mono font-bold">{money(row.outstanding)}</td>
                              <td className="px-2 py-1.5">
                                <span
                                  className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${
                                    row.status === 'PAID'
                                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                                      : row.status === 'OVERDUE'
                                        ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
                                        : row.status === 'PARTIAL'
                                          ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                                          : 'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                                  }`}
                                >
                                  {row.status}
                                </span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section>
                  <div className="mb-1.5 flex items-center justify-between">
                    <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                      Interest accruals
                    </h4>
                    <span className="text-[10px] text-slate-500">
                      Accrued {money(historyLoan.interestAccrued)} · paid {money(historyLoan.interestPaid)}
                    </span>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                    <table className="w-full min-w-[760px] text-left text-[11px]">
                      <thead className="bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-[#12161f] dark:text-slate-400">
                        <tr>
                          <th className="px-2 py-1.5">Document</th>
                          <th className="px-2 py-1.5">Period</th>
                          <th className="px-2 py-1.5 text-right">Base</th>
                          <th className="px-2 py-1.5 text-right">Rate</th>
                          <th className="px-2 py-1.5 text-right">Days</th>
                          <th className="px-2 py-1.5 text-right">Interest</th>
                          <th className="px-2 py-1.5">Journal</th>
                          <th className="px-2 py-1.5">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {historyAccruals.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="p-4 text-center text-slate-500">
                              No interest has been accrued on this loan.
                            </td>
                          </tr>
                        ) : (
                          historyAccruals.map((row) => (
                            <tr key={row.id}>
                              <td className="px-2 py-1.5 font-mono text-[10px] font-bold">{row.accrualNumber}</td>
                              <td className="px-2 py-1.5">
                                {row.fromDateAD} → {row.toDateAD}
                                <div className="text-[10px] text-slate-500">{row.toDateBS}</div>
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.principalBase)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{Number(row.annualRate).toFixed(2)}%</td>
                              <td className="px-2 py-1.5 text-right font-mono">{row.days}</td>
                              <td className="px-2 py-1.5 text-right font-mono font-bold">{money(row.interestAmount)}</td>
                              <td className="px-2 py-1.5 font-mono text-[10px]">
                                {row.journalNo}
                                {row.status === 'REVERSED' ? ' · reversed' : ''}
                              </td>
                              <td className="px-2 py-1.5">
                                {row.status === 'REVERSED' ? (
                                  <span
                                    className="inline-flex rounded-full border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                                    title={row.reversalReason || ''}
                                  >
                                    REVERSED
                                  </span>
                                ) : canPost ? (
                                  <button
                                    type="button"
                                    onClick={() => void reverseAccrual(row)}
                                    className="cursor-pointer rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                                    title={`Reverse ${row.accrualNumber}`}
                                  >
                                    Reverse
                                  </button>
                                ) : (
                                  'POSTED'
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section>
                  <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                    Receipts and repayments
                  </h4>
                  <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                    <table className="w-full min-w-[760px] text-left text-[11px]">
                      <thead className="bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-[#12161f] dark:text-slate-400">
                        <tr>
                          <th className="px-2 py-1.5">Date</th>
                          <th className="px-2 py-1.5">Document</th>
                          <th className="px-2 py-1.5">Type</th>
                          <th className="px-2 py-1.5 text-right">Principal</th>
                          <th className="px-2 py-1.5 text-right">Interest</th>
                          <th className="px-2 py-1.5 text-right">TDS</th>
                          <th className="px-2 py-1.5 text-right">Cash</th>
                          <th className="px-2 py-1.5">Journal</th>
                          <th className="px-2 py-1.5">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {historyRows.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="p-4 text-center text-slate-500">
                              No receipts or repayments have been posted for this loan.
                            </td>
                          </tr>
                        ) : (
                          historyRows.map((row) => (
                            <tr key={row.id}>
                              <td className="px-2 py-1.5">{row.txnDateAD}</td>
                              <td className="px-2 py-1.5 font-mono text-[10px]">{row.txnNumber}</td>
                              <td className="px-2 py-1.5">{row.txnType}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.principalAmount)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.interestAmount)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.tdsAmount)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{money(row.cashAmount)}</td>
                              <td className="px-2 py-1.5 font-mono text-[10px]">
                                {row.journalNo}
                                {row.status === 'REVERSED' ? ' · reversed' : ''}
                              </td>
                              <td className="px-2 py-1.5">
                                {row.status === 'REVERSED' ? (
                                  <span
                                    className="inline-flex rounded-full border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                                    title={row.reversalReason || ''}
                                  >
                                    REVERSED
                                  </span>
                                ) : canPost ? (
                                  <button
                                    type="button"
                                    onClick={() => void reverseTransaction(row)}
                                    className="cursor-pointer rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                                    title={`Reverse ${row.txnNumber}`}
                                  >
                                    Reverse
                                  </button>
                                ) : (
                                  'POSTED'
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}
          </ModalPanel>
        </div>
      ) : null}

      {accrualModal && accrualLoan && selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={`Accrue interest — ${accrualLoan.loanNumber}`}
            onClose={() => setAccrualModal(false)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">Accrue lender interest</h3>
                <p className="text-[10px] text-slate-500">
                  {accrualLoan.loanNumber} · {selected.name} · outstanding{' '}
                  {money(accrualLoan.outstandingPrincipal)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAccrualModal(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={submitAccrual} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>From *</label>
                  <input
                    type="date"
                    value={accrualForm.fromAD}
                    onChange={(event) =>
                      setAccrualForm({ ...accrualForm, fromAD: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>To *</label>
                  <input
                    type="date"
                    value={accrualForm.toAD}
                    onChange={(event) =>
                      setAccrualForm({ ...accrualForm, toAD: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                Posted as Dr Interest Expense — Borrowings (6700) and Cr Interest Payable — Lender
                (2370). A later repayment clears the accrued payable before charging new interest
                expense.
              </p>
              {accrualLoan.interestAccrued > 0 ? (
                <p className="text-[11px] text-slate-500">
                  Already accrued: {money(accrualLoan.interestAccrued)} · last period ended{' '}
                  {accrualLoan.lastAccrualDateAD || '—'}
                </p>
              ) : null}
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setAccrualModal(false)}
                  className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAccrual}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingAccrual ? 'Posting…' : 'Post Accrual'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      ) : null}

      {loanModal && selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={editingLoan ? 'Edit Loan' : 'Add Loan'}
            onClose={() => setLoanModal(false)}
            className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">{editingLoan ? 'Edit Loan' : 'Add Loan'}</h3>
                <p className="text-[10px] text-slate-500">Lender: {selected.name}</p>
              </div>
              <button
                type="button"
                onClick={() => setLoanModal(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={submitLoan} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Branch *</label>
                  <select
                    value={loanForm.branchId}
                    disabled={Boolean(editingLoan)}
                    onChange={(event) => setLoanForm({ ...loanForm, branchId: event.target.value })}
                    className={`${inputClass} disabled:opacity-60`}
                  >
                    <option value="">Choose branch</option>
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.code} · {branch.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Principal *</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={loanForm.principal}
                    onChange={(event) => setLoanForm({ ...loanForm, principal: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Interest rate (%)</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.0001"
                    value={loanForm.interestRate}
                    onChange={(event) =>
                      setLoanForm({ ...loanForm, interestRate: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Start date *</label>
                  <input
                    type="date"
                    value={loanForm.startDateAD}
                    onChange={(event) => setLoanForm({ ...loanForm, startDateAD: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Maturity date</label>
                  <input
                    type="date"
                    value={loanForm.maturityDateAD}
                    onChange={(event) =>
                      setLoanForm({ ...loanForm, maturityDateAD: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Repayment frequency</label>
                  <select
                    value={loanForm.repaymentFrequency}
                    onChange={(event) =>
                      setLoanForm({
                        ...loanForm,
                        repaymentFrequency: event.target.value as LoanRepaymentFrequency,
                      })
                    }
                    className={inputClass}
                  >
                    {Object.entries(FREQUENCY_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Installment amount</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={loanForm.installmentAmount}
                    onChange={(event) =>
                      setLoanForm({ ...loanForm, installmentAmount: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Security</label>
                  <select
                    value={loanForm.securityType}
                    onChange={(event) =>
                      setLoanForm({
                        ...loanForm,
                        securityType: event.target.value as 'UNSECURED' | 'SECURED',
                      })
                    }
                    className={inputClass}
                  >
                    <option value="UNSECURED">Unsecured</option>
                    <option value="SECURED">Secured</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Status</label>
                  <select
                    value={loanForm.status}
                    onChange={(event) =>
                      setLoanForm({ ...loanForm, status: event.target.value as LoanStatus })
                    }
                    className={inputClass}
                  >
                    <option value="OPEN">Open</option>
                    <option value="CLOSED">Closed</option>
                    <option value="CANCELLED">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Agreement reference</label>
                  <input
                    value={loanForm.agreementReference}
                    onChange={(event) =>
                      setLoanForm({ ...loanForm, agreementReference: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
                <label className="flex cursor-pointer items-center gap-2 text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={loanForm.tdsApplicable}
                    onChange={(event) =>
                      setLoanForm({
                        ...loanForm,
                        tdsApplicable: event.target.checked,
                        tdsExemptionReason: event.target.checked
                          ? ''
                          : loanForm.tdsExemptionReason,
                        tdsExemptionReference: event.target.checked
                          ? ''
                          : loanForm.tdsExemptionReference,
                      })
                    }
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                  />
                  TDS applicable on lender interest (15% default)
                </label>
                {!loanForm.tdsApplicable ? (
                  <div className="mt-2 space-y-2">
                    <div>
                      <label className={labelClass}>Exemption reason *</label>
                      <select
                        value={loanForm.tdsExemptionReason}
                        onChange={(event) =>
                          setLoanForm({
                            ...loanForm,
                            tdsExemptionReason: event.target.value as '' | TdsExemptionReason,
                          })
                        }
                        className={inputClass}
                      >
                        <option value="">Choose reason</option>
                        {Object.entries(TDS_REASON_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>
                        Evidence / reference
                        {loanForm.tdsExemptionReason &&
                        TDS_REFERENCE_REQUIRED[loanForm.tdsExemptionReason]
                          ? ' *'
                          : ''}
                      </label>
                      <input
                        value={loanForm.tdsExemptionReference}
                        onChange={(event) =>
                          setLoanForm({ ...loanForm, tdsExemptionReference: event.target.value })
                        }
                        placeholder="Certificate, agreement clause or notification"
                        className={inputClass}
                      />
                    </div>
                    <p className="text-[10px] text-slate-500">
                      Every zero-TDS repayment with interest will require this reason. NO_INTEREST
                      still posts without a reference when no interest is paid.
                    </p>
                  </div>
                ) : null}
              </div>
              <div>
                <label className={labelClass}>Notes</label>
                <textarea
                  value={loanForm.notes}
                  onChange={(event) => setLoanForm({ ...loanForm, notes: event.target.value })}
                  rows={2}
                  className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setLoanModal(false)}
                  className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingLoan}
                  className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingLoan ? 'Saving…' : editingLoan ? 'Save Changes' : 'Register Loan'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      ) : null}
    </div>
  );
};

export default LendersManagement;
