/**
 * Subledger master — the books that sit behind control ledgers.
 *
 * A control account (AR, AP, salary payable, due to/from head office) holds no
 * party detail of its own: `gl_subledger_entries` does. This screen names that
 * book, binds it to exactly one control ledger and shows the two sides of the
 * reconciliation side by side, so a missing assignment or a drift is visible
 * before a posting fails.
 *
 * The setup-health card is the other half of chart creation: it reports control
 * accounts with no book, posting roles no active ledger holds, and retired
 * ledgers still holding a role. `Seed missing defaults` is the idempotent
 * repair — it never rewrites an existing account.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { StatCard } from '../../components/common/StatCard';
import { ModalPanel } from '../../components/common/ModalPanel';
import { useDialog } from '../../components/common/DialogProvider';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import { getScopedBranches, hasGlobalBranchScope, isOperationAllowed } from '../../utils/permissions';
import type { Branch, User } from '../../types';
import type {
  AccountingAccount,
  AccountingSubledger,
  AccountingSubledgerLedger,
  ChartHealth,
} from '../../services/api/accounting';
import { money } from '../../components/accounting/statementFormat';

interface SubledgersManagementProps {
  branches?: Branch[];
  currentUser?: User | null;
}

interface SubledgerForm {
  code: string;
  name: string;
  mainAccountId: string;
  partyId: string;
  description: string;
  isActive: boolean;
}

const EMPTY_FORM: SubledgerForm = {
  code: '',
  name: '',
  mainAccountId: '',
  partyId: '',
  description: '',
  isActive: true,
};

const codeFromName = (name: string): string =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);

const errorClass =
  'rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white';
const labelClass = 'block text-xs font-semibold text-slate-500 dark:text-slate-400';
const rowAction =
  'inline-flex min-h-[24px] items-center gap-1 rounded-md border border-slate-300 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';

export const SubledgersManagement: React.FC<SubledgersManagementProps> = ({
  branches = [],
  currentUser,
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canManage = isOperationAllowed('gl-subledger-manage', currentUser?.role);
  const activationKey = useActivationKey('subledgers');
  const scopedBranches = useMemo(
    () => getScopedBranches(currentUser, branches),
    [branches, currentUser]
  );
  const canSeeAllBranches = hasGlobalBranchScope(currentUser);
  const [branchId, setBranchId] = useState(() => {
    if (canSeeAllBranches) return 'ALL';
    if (currentUser?.branchId && currentUser.branchId !== 'ALL') return currentUser.branchId;
    return scopedBranches[0]?.id || '';
  });

  const [subledgers, setSubledgers] = useState<AccountingSubledger[]>([]);
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [health, setHealth] = useState<ChartHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateAccountId, setGenerateAccountId] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<AccountingSubledger | null>(null);
  const [form, setForm] = useState<SubledgerForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [ledgerBook, setLedgerBook] = useState<AccountingSubledger | null>(null);
  const [ledger, setLedger] = useState<AccountingSubledgerLedger | null>(null);
  const [ledgerFrom, setLedgerFrom] = useState('');
  const [ledgerTo, setLedgerTo] = useState('');
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [books, chartAccounts, chartHealth] = await Promise.all([
        api.getAccountingSubledgers(true, branchId === 'ALL' ? undefined : branchId),
        api.getAccountingAccounts(true),
        api.getChartHealth(),
      ]);
      setSubledgers(Array.isArray(books) ? books : []);
      setAccounts(Array.isArray(chartAccounts) ? chartAccounts : []);
      setHealth(chartHealth);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The subledger register could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, branchId]);

  useEffect(() => {
    const allowed = canSeeAllBranches
      ? ['ALL', ...scopedBranches.map((branch) => branch.id)]
      : scopedBranches.map((branch) => branch.id);
    if (!allowed.includes(branchId)) setBranchId(allowed[0] || '');
  }, [branchId, canSeeAllBranches, scopedBranches]);

  const controlAccounts = useMemo(
    () => accounts.filter((account) => account.isControl),
    [accounts]
  );
  // Unlimited books: every control account stays selectable, whether it has a
  // general book, party books, or none yet.
  const selectableAccounts = controlAccounts;
  const selectedAccount = controlAccounts.find((account) => account.id === form.mainAccountId);
  const selectedAccountType = selectedAccount?.subledgerType || '';
  const partyBookAccount = useMemo(
    () =>
      controlAccounts.find(
        (account) =>
          account.isActive &&
          ['CUSTOMER', 'SUPPLIER', 'EMPLOYEE'].includes(account.subledgerType)
      ),
    [controlAccounts]
  );
  useEffect(() => {
    if (!generateAccountId || !controlAccounts.some((account) => account.id === generateAccountId)) {
      const salary = controlAccounts.find((account) => account.postingRole === 'SALARY_PAYABLE');
      setGenerateAccountId((salary || partyBookAccount)?.id || '');
    }
  }, [controlAccounts, generateAccountId, partyBookAccount]);
  const generateAccount = controlAccounts.find((account) => account.id === generateAccountId);
  const differences = new Set(
    subledgers
      .filter((book) => Math.abs(Number(book.difference)) >= 0.005)
      .map((book) => book.mainAccountId)
  ).size;
  const unassignedControls = health?.controlAccountsWithoutSubledger.length ?? 0;
  const missingRoles = health?.missingPostingRoles.length ?? 0;
  const retiredRoleAccounts = health?.inactiveAccountsHoldingRole.length ?? 0;
  const healthy = unassignedControls + missingRoles + retiredRoleAccounts === 0;

  const openCreate = () => {
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      mainAccountId: selectableAccounts[0]?.id || '',
    });
    setFormError('');
    setIsModalOpen(true);
  };

  const openEdit = (book: AccountingSubledger) => {
    setEditing(book);
    setForm({
      code: book.code,
      name: book.name,
      mainAccountId: book.mainAccountId,
      partyId: book.partyId || '',
      description: book.description || '',
      isActive: book.isActive,
    });
    setFormError('');
    setIsModalOpen(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setFormError('A subledger name is required.');
      return;
    }
    if (!form.mainAccountId) {
      setFormError('Choose the control ledger this subledger belongs to.');
      return;
    }
    const code = (form.code.trim() || codeFromName(name)).toUpperCase();
    if (!editing && !/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(code)) {
      setFormError('Code must be 1–30 letters, digits, hyphens or underscores.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (editing) {
        await api.updateAccountingSubledger(editing.id, {
          name,
          description: form.description || null,
          isActive: form.isActive,
          ...(form.mainAccountId !== editing.mainAccountId
            ? { mainAccountId: form.mainAccountId }
            : {}),
        });
      } else {
        await api.createAccountingSubledger({
          code,
          name,
          mainAccountId: form.mainAccountId,
          subledgerType: selectedAccount?.subledgerType,
          partyId: form.partyId.trim() || null,
          description: form.description || null,
          isActive: form.isActive,
        });
      }
      setIsModalOpen(false);
      await load();
    } catch (err: any) {
      setFormError(err?.message || 'The subledger could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (book: AccountingSubledger) => {
    const ok = await confirmDialog(
      `Delete subledger ${book.code} ${book.name}? Only a book with no posted rows can be deleted.`,
      { title: 'Delete subledger', confirmLabel: 'Delete' }
    );
    if (!ok) return;
    try {
      await api.deleteAccountingSubledger(book.id);
      await load();
    } catch (err: any) {
      alertDialog(err?.message || 'The subledger could not be deleted.');
    }
  };

  const generatePartyBooks = async () => {
    if (!generateAccount) return;
    const ok = await confirmDialog(
      `Create one subledger book for every active ${generateAccount.subledgerType} in the shared master under ${generateAccount.code} ${generateAccount.name}? Existing rows for those parties will move from the general book into their own book.`,
      { title: 'Generate party subledgers', confirmLabel: 'Generate' }
    );
    if (!ok) return;
    setGenerating(true);
    try {
      const result = await api.generateAccountingSubledgers(generateAccount.id);
      await load();
      alertDialog(
        `Created ${result.created} book(s); ${result.skipped} already existed. ${result.linkedEntries} existing row(s) were linked to their party book.`
      );
    } catch (err: any) {
      alertDialog(err?.message || 'Party subledgers could not be generated.');
    } finally {
      setGenerating(false);
    }
  };

  const seedDefaults = async () => {
    setSeeding(true);
    try {
      const result = await api.seedChartDefaults();
      await load();
      alertDialog(result.message);
    } catch (err: any) {
      alertDialog(err?.message || 'The default chart could not be seeded.');
    } finally {
      setSeeding(false);
    }
  };

  const loadLedger = async (book: AccountingSubledger, from: string, to: string) => {
    setLedgerLoading(true);
    setLedgerError('');
    try {
      setLedger(
        await api.getAccountingSubledgerEntries(book.id, {
          from: from || undefined,
          to: to || undefined,
          branchId: branchId === 'ALL' ? undefined : branchId,
        })
      );
    } catch (err: any) {
      setLedgerError(err?.message || 'The subledger entries could not be read.');
    } finally {
      setLedgerLoading(false);
    }
  };

  const openLedger = (book: AccountingSubledger) => {
    setLedgerBook(book);
    setLedger(null);
    setLedgerError('');
    setLedgerFrom('');
    setLedgerTo('');
    void loadLedger(book, '', '');
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Subledgers"
        description="Control ledgers can own one account-wide book plus unlimited party books — employees under Salary Payable, customers under AR, suppliers under AP — all read in the selected branch."
        icon={<BookOpen className="h-5 w-5 text-indigo-500" />}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {canManage && (
              <button
                type="button"
                onClick={openCreate}
                disabled={loading || selectableAccounts.length === 0}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition hover:bg-indigo-500 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add Subledger
              </button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40 md:grid-cols-3">
        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
          Branch
          <select
            aria-label="Subledger branch"
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
            className={inputClass}
          >
            {canSeeAllBranches && <option value="ALL">All Branches (company level)</option>}
            {scopedBranches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.code} · {branch.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end md:col-span-2">
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
            Balances, row counts and unlinked rows are filtered to{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              {branchId === 'ALL'
                ? 'all branches (company level)'
                : scopedBranches.find((branch) => branch.id === branchId)?.name || branchId || 'no branch'}
            </span>
            . Books stay global masters; the figures follow the branch.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="SUBLEDGER BOOKS" value={String(subledgers.length)} tone="indigo" hint="General + unlimited party books" />
        <StatCard label="CONTROL ACCOUNTS" value={String(controlAccounts.length)} tone="amber" hint="Ledgers owning party detail" />
        <StatCard
          label="TIE-OUT"
          value={differences === 0 ? 'Reconciled' : `${differences} difference(s)`}
          tone={differences === 0 ? 'emerald' : 'rose'}
          hint="GL versus posted subledger rows"
        />
        <StatCard
          label="UNASSIGNED"
          value={String(unassignedControls)}
          tone={unassignedControls === 0 ? 'emerald' : 'rose'}
          hint="Control accounts with no book"
        />
      </div>

      {loadError && (
        <div role="alert" className={errorClass}>
          {loadError}
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <div>
            <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-200">
              {healthy ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              )}
              Chart setup health
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              What a complete posting chart still needs: a book per control account, one active ledger per posting
              role, and no retired ledger holding a role.
            </p>
          </div>
          {canManage && !healthy && (
            <button
              type="button"
              onClick={() => void seedDefaults()}
              disabled={seeding}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {seeding ? 'Seeding…' : 'Seed missing defaults'}
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 px-3 py-3 md:grid-cols-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Control accounts without a subledger ({unassignedControls})
            </p>
            {unassignedControls === 0 ? (
              <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">All control accounts are assigned.</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-[11px] text-rose-600 dark:text-rose-400">
                {health?.controlAccountsWithoutSubledger.map((account) => (
                  <li key={account.accountId} className="font-mono">
                    {account.code} {account.name} · {account.subledgerType}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Posting roles with no active ledger ({missingRoles})
            </p>
            {missingRoles === 0 ? (
              <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">Every posting role is covered.</p>
            ) : (
              <p className="mt-1 font-mono text-[11px] text-amber-600 dark:text-amber-400">
                {health?.missingPostingRoles.join(', ')}
              </p>
            )}
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Retired ledgers holding a role ({retiredRoleAccounts})
            </p>
            {retiredRoleAccounts === 0 ? (
              <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">No retired ledger claims a role.</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                {health?.inactiveAccountsHoldingRole.map((account) => (
                  <li key={account.accountId} className="font-mono">
                    {account.code} {account.name} · {account.postingRole}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {canManage && (
        <section className="flex flex-wrap items-end gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/50 px-3 py-3 dark:border-indigo-500/30 dark:bg-indigo-950/20">
          <div className="min-w-[240px] flex-1">
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Unlimited party subledgers</h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Create one book for every active party in the shared master. Employee books under Salary Payable use the
              same employee id payroll already posts; customer books use the same customer id sales and stock use.
            </p>
          </div>
          <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Control account
            <select
              aria-label="Control account for party subledger generation"
              className={inputClass}
              value={generateAccountId}
              onChange={(event) => setGenerateAccountId(event.target.value)}
            >
              {controlAccounts
                .filter((account) => ['CUSTOMER', 'SUPPLIER', 'EMPLOYEE'].includes(account.subledgerType))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name} ({account.subledgerType})
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void generatePartyBooks()}
            disabled={generating || !generateAccount}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {generating ? 'Generating…' : `Generate ${generateAccount?.subledgerType || 'party'} books`}
          </button>
        </section>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
              <tr>
                <th className="px-2.5 py-2">Code</th>
                <th className="px-2.5 py-2">Subledger</th>
                <th className="px-2.5 py-2">Type</th>
                <th className="px-2.5 py-2">Party</th>
                <th className="px-2.5 py-2">Main ledger</th>
                <th className="px-2.5 py-2 text-right">Rows</th>
                <th className="px-2.5 py-2 text-right">Book / account</th>
                <th className="px-2.5 py-2 text-right">Difference</th>
                <th className="px-2.5 py-2 text-right">Unlinked</th>
                <th className="px-2.5 py-2 text-center">Ledger</th>
                <th className="px-2.5 py-2 text-center">Status</th>
                {canManage && <th className="px-2.5 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
              {subledgers.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 12 : 11} className="px-3 py-6 text-center text-slate-400">
                    {loading ? 'Reading subledgers…' : 'No subledgers are configured yet.'}
                  </td>
                </tr>
              ) : (
                subledgers.map((book) => {
                  const difference = Number(book.difference);
                  return (
                    <tr key={book.id} className="text-slate-800 dark:text-slate-300">
                      <td className="px-2.5 py-1.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">{book.code}</td>
                      <td className="px-2.5 py-1.5 font-bold">{book.name}</td>
                      <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{book.subledgerType}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                        {book.partyId || 'Account-wide'}
                      </td>
                      <td className="px-2.5 py-1.5">
                        <span className="mr-1.5 font-mono text-[10px] text-slate-400">{book.accountCode}</span>
                        {book.accountName}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono">{book.entryCount}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono">
                        {money(book.bookBalance)} / {money(book.subledgerBalance)}
                        <span className="ml-1 text-[10px] text-slate-400">GL {money(book.glBalance)}</span>
                      </td>
                      <td className={`px-2.5 py-1.5 text-right font-mono ${Math.abs(difference) >= 0.005 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                        {money(difference)}
                      </td>
                      <td className={`px-2.5 py-1.5 text-right font-mono ${book.unlinkedCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
                        {book.unlinkedCount}
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <button type="button" className={rowAction} aria-label={`View ledger for ${book.code}`} onClick={() => openLedger(book)}>
                          <Eye className="h-3 w-3" /> Ledger
                        </button>
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <span className={`text-[10px] font-bold ${book.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                          {book.isActive ? 'ACTIVE' : 'INACTIVE'}
                        </span>
                      </td>
                      {canManage && (
                        <td className="px-2.5 py-1.5 text-right">
                          <span className="inline-flex items-center gap-1">
                            <button type="button" className={rowAction} aria-label={`Edit subledger ${book.code}`} onClick={() => openEdit(book)}>
                              <Pencil className="h-3 w-3" /> Edit
                            </button>
                            <button type="button" className={rowAction} aria-label={`Delete subledger ${book.code}`} onClick={() => void remove(book)}>
                              <Trash2 className="h-3 w-3" /> Delete
                            </button>
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {canManage && isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <ModalPanel
            label={editing ? `Edit ${editing.code}` : 'New subledger'}
            onClose={saving ? undefined : () => setIsModalOpen(false)}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
          >
            <form className="space-y-3" onSubmit={(event) => void submit(event)}>
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  {editing ? `Edit ${editing.code}` : 'New subledger'}
                </h2>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  A book belongs to one control ledger. Leave the party blank for the account-wide book, or bind it to a
                  customer, supplier or employee — a control account can carry unlimited party books.
                </p>
              </div>
              {formError && <div className={errorClass}>{formError}</div>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="subledger-code">Code</label>
                  <input
                    id="subledger-code"
                    className={inputClass}
                    value={form.code}
                    onChange={(event) => setForm({ ...form, code: event.target.value })}
                    placeholder="e.g. SL-1100"
                    readOnly={Boolean(editing)}
                    required
                  />
                  {editing && <p className="mt-1 text-[10px] text-slate-400">The code cannot be changed after creation.</p>}
                </div>
                <div>
                  <label className={labelClass} htmlFor="subledger-name">Name</label>
                  <input
                    id="subledger-name"
                    className={inputClass}
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder="e.g. Sundry Debtors"
                    required
                  />
                </div>
              </div>
              <div>
                <label className={labelClass} htmlFor="subledger-account">Main ledger (control account)</label>
                <select
                  id="subledger-account"
                  className={inputClass}
                  value={form.mainAccountId}
                  onChange={(event) => setForm({ ...form, mainAccountId: event.target.value })}
                  required
                >
                  <option value="">Choose a control account…</option>
                  {selectableAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} · {account.name} ({account.subledgerType})
                    </option>
                  ))}
                </select>
                {selectableAccounts.length === 0 && (
                  <p className="mt-1 text-[10px] text-rose-500">
                    No control account exists yet. Mark a ledger as a control account on Chart &amp; Defaults first.
                  </p>
                )}
              </div>
              <div>
                <label className={labelClass} htmlFor="subledger-party">
                  Party id (optional)
                </label>
                <input
                  id="subledger-party"
                  className={inputClass}
                  value={form.partyId}
                  onChange={(event) => setForm({ ...form, partyId: event.target.value })}
                  placeholder={
                    selectedAccountType === 'EMPLOYEE'
                      ? 'Employee master id'
                      : selectedAccountType === 'CUSTOMER'
                        ? 'Customer id (customer_records.customer_id)'
                        : selectedAccountType === 'SUPPLIER'
                          ? 'Supplier master id'
                          : 'Not available for this ledger type'
                  }
                  disabled={Boolean(editing) || !['CUSTOMER', 'SUPPLIER', 'EMPLOYEE'].includes(selectedAccountType)}
                />
                <p className="mt-1 text-[10px] text-slate-400">
                  Blank creates the account-wide book. A party book must use the id from the shared master, so inventory,
                  sales, payroll and accounting all read the same customer, supplier or employee.
                </p>
              </div>
              <div>
                <label className={labelClass} htmlFor="subledger-description">Description (optional)</label>
                <input
                  id="subledger-description"
                  className={inputClass}
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                />
                Active
              </label>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300"
                  onClick={() => setIsModalOpen(false)}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                  disabled={saving}
                >
                  {saving ? 'Saving…' : editing ? 'Save changes' : 'Create subledger'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {ledgerBook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <ModalPanel
            label={`${ledgerBook.code} ledger`}
            onClose={() => setLedgerBook(null)}
            className="max-h-[88vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  {ledgerBook.code} · {ledgerBook.name}
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {ledgerBook.subledgerType} {ledgerBook.partyId ? 'party' : 'account-wide'} book behind{' '}
                  <span className="font-mono">{ledgerBook.accountCode}</span> {ledgerBook.accountName}. Showing{' '}
                  {branchId === 'ALL' ? 'all branches' : branchId}. Rows are read by book id, not by the account.
                </p>
              </div>
              <div className="flex items-end gap-2">
                <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  From
                  <input
                    type="date"
                    className={inputClass}
                    value={ledgerFrom}
                    onChange={(event) => setLedgerFrom(event.target.value)}
                  />
                </label>
                <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  To
                  <input
                    type="date"
                    className={inputClass}
                    value={ledgerTo}
                    onChange={(event) => setLedgerTo(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className={rowAction}
                  onClick={() => void loadLedger(ledgerBook, ledgerFrom, ledgerTo)}
                  disabled={ledgerLoading}
                >
                  {ledgerLoading ? 'Reading…' : 'Apply'}
                </button>
              </div>
            </div>

            {ledgerError && <div className={`mt-2 ${errorClass}`}>{ledgerError}</div>}

            {ledger && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/60">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Debit</p>
                    <p className="font-mono text-sm font-bold">{money(ledger.totals.debit)}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/60">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Credit</p>
                    <p className="font-mono text-sm font-bold">{money(ledger.totals.credit)}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/60">
                    <p className="text-[10px] font-bold uppercase text-slate-500">Balance</p>
                    <p className="font-mono text-sm font-bold">{money(ledger.totals.balance)}</p>
                  </div>
                </div>

                {ledger.unlinkedCount > 0 && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    {ledger.unlinkedCount} row(s) on this control account still carry no book id in this branch.
                  </p>
                )}

                <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-[11px]">
                    <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase text-slate-600 dark:border-slate-800 dark:bg-slate-800/80 dark:text-slate-300">
                      <tr>
                        <th className="px-2 py-1.5">Party</th>
                        <th className="px-2 py-1.5">Name</th>
                        <th className="px-2 py-1.5 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {ledger.parties.length === 0 ? (
                        <tr><td colSpan={3} className="px-2 py-3 text-center text-slate-400">No party movements in this window.</td></tr>
                      ) : (
                        ledger.parties.map((party) => (
                          <tr key={party.partyId || party.partyName} className="text-slate-700 dark:text-slate-300">
                            <td className="px-2 py-1 font-mono">{party.partyId || '—'}</td>
                            <td className="px-2 py-1">{party.partyName || '—'}</td>
                            <td className="px-2 py-1 text-right font-mono">{money(party.balance)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-[11px]">
                    <thead className="sticky top-0 border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase text-slate-600 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300">
                      <tr>
                        <th className="px-2 py-1.5">Date</th>
                        <th className="px-2 py-1.5">Journal</th>
                        <th className="px-2 py-1.5">Party</th>
                        <th className="px-2 py-1.5">Memo</th>
                        <th className="px-2 py-1.5 text-right">Debit</th>
                        <th className="px-2 py-1.5 text-right">Credit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {ledger.entries.length === 0 ? (
                        <tr><td colSpan={6} className="px-2 py-4 text-center text-slate-400">No posted movements in this window.</td></tr>
                      ) : (
                        ledger.entries.map((entry) => (
                          <tr key={entry.id} className="text-slate-700 dark:text-slate-300">
                            <td className="px-2 py-1 font-mono">{entry.entryDateAD}</td>
                            <td className="px-2 py-1 font-mono">{entry.journalNo}</td>
                            <td className="px-2 py-1">{entry.partyName || entry.partyId || '—'}</td>
                            <td className="px-2 py-1 text-slate-500 dark:text-slate-400">{entry.memo || '—'}</td>
                            <td className="px-2 py-1 text-right font-mono">{entry.debit ? money(entry.debit) : '—'}</td>
                            <td className="px-2 py-1 text-right font-mono">{entry.credit ? money(entry.credit) : '—'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default SubledgersManagement;
