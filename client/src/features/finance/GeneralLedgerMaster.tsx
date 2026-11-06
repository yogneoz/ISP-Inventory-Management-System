/**
 * General Ledger Master — the full ledger-account creation screen.
 *
 * The chart register is the reporting view; this is the classic master form
 * behind it. The core fields (code, name, group, control account, posting role,
 * cash/bank details) are the same ones the posting services use. The remaining
 * legacy fields — short name, category, customer type, bill-wise adjustment,
 * area, agent, class, credit terms, tax/institution type, guarantee, deposit,
 * currency and interest — are stored in `gl_accounts.master_profile` and shown
 * here as account-level defaults. They never override the ledger or the
 * customer/employee master at posting time.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { BookOpenCheck, ChevronLeft, ChevronRight, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useDialog } from '../../components/common/DialogProvider';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import type { User } from '../../types';
import type {
  AccountingAccount,
  AccountingGroup,
  AccountKind,
  AccountType,
} from '../../services/api/accounting';
import {
  ACCOUNT_KIND_OPTIONS,
  ACCOUNT_TYPE_OPTIONS,
  POSTING_ROLE_OPTIONS,
  SUBLEDGER_TYPE_OPTIONS,
} from '../../components/accounting/ChartMaintenanceDialogs';
import {
  groupAncestors,
  groupDescendantIds,
  hierarchyGroupOptions,
} from '../../components/accounting/chartHierarchy';

type TabKey = 'ACCOUNT' | 'OTHER' | 'CREDIT' | 'BANK';

interface LedgerForm {
  code: string;
  name: string;
  description: string;
  groupTopId: string;
  groupSubId: string;
  postingRole: string;
  accountKind: AccountKind;
  isControl: boolean;
  subledgerType: string;
  isActive: boolean;
  shortName: string;
  category: string;
  customerType: string;
  billWiseAdjustment: boolean;
  cashBook: boolean;
  area: string;
  agent: string;
  accountClass: string;
  creditLimit: string;
  overLimitAllowed: boolean;
  creditDays: string;
  overDaysAllowed: boolean;
  taxType: string;
  institutionType: string;
  bankGuarantee: string;
  cashDeposit: string;
  currency: string;
  interestRate: string;
  bankName: string;
  bankBranch: string;
  accountNumber: string;
  accountHolder: string;
  swiftCode: string;
}

const EMPTY_FORM: LedgerForm = {
  code: '',
  name: '',
  description: '',
  groupTopId: '',
  groupSubId: '',
  postingRole: '',
  accountKind: 'OTHER',
  isControl: false,
  subledgerType: 'NONE',
  isActive: true,
  shortName: '',
  category: 'Other',
  customerType: 'NONE',
  billWiseAdjustment: false,
  cashBook: false,
  area: '',
  agent: '',
  accountClass: '',
  creditLimit: '',
  overLimitAllowed: false,
  creditDays: '',
  overDaysAllowed: false,
  taxType: 'NONE',
  institutionType: 'PARTNERSHIP',
  bankGuarantee: '',
  cashDeposit: '',
  currency: 'NPR',
  interestRate: '',
  bankName: '',
  bankBranch: '',
  accountNumber: '',
  accountHolder: '',
  swiftCode: '',
};

const input =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white';
const label = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400';
const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorClass =
  'rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';

/** Legacy GL-master ledger categories. */
export const LEDGER_CATEGORY_OPTIONS = ['Both', 'Customer', 'Vendor', 'Other', 'Contact'] as const;

const textProfile = (account: AccountingAccount | null, key: string): string => {
  const value = account?.masterProfile?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};
const boolProfile = (account: AccountingAccount | null, key: string): boolean =>
  account?.masterProfile?.[key] === true;

export const GeneralLedgerMaster: React.FC<{ currentUser?: User | null }> = ({ currentUser }) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canManage = isOperationAllowed('gl-manage', currentUser?.role);
  const [groups, setGroups] = useState<AccountingGroup[]>([]);
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [isNew, setIsNew] = useState(true);
  const [tab, setTab] = useState<TabKey>('ACCOUNT');
  const [form, setForm] = useState<LedgerForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activationKey = useActivationKey('general-ledger');

  const selected = useMemo(
    () => (isNew ? null : accounts.find((account) => account.id === selectedId) || null),
    [accounts, isNew, selectedId]
  );

  const load = async (preferredId?: string) => {
    setLoading(true);
    setError('');
    try {
      const [chartGroups, chartAccounts] = await Promise.all([
        api.getAccountingGroups(),
        api.getAccountingAccounts(true),
      ]);
      setGroups(chartGroups);
      setAccounts(chartAccounts);
      const nextId = preferredId || selectedId || chartAccounts[0]?.id || '';
      setSelectedId(nextId);
      if (!isNew) {
        const account = chartAccounts.find((row) => row.id === nextId);
        if (account) fill(account);
      }
    } catch (err: any) {
      setError(err?.message || 'The ledger master could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);

  function fill(account: AccountingAccount) {
    const ancestry = groupAncestors(groups, account.groupId);
    const topId = ancestry[0]?.id || account.groupId;
    setForm({
      code: account.code,
      name: account.name,
      description: account.description || '',
      groupTopId: topId,
      groupSubId: ancestry.length > 1 ? account.groupId : '',
      postingRole: account.postingRole || '',
      accountKind: account.accountKind || 'OTHER',
      isControl: account.isControl,
      subledgerType: account.subledgerType || 'NONE',
      isActive: account.isActive,
      shortName: textProfile(account, 'shortName'),
      category: LEDGER_CATEGORY_OPTIONS.includes(
        textProfile(account, 'category') as (typeof LEDGER_CATEGORY_OPTIONS)[number]
      )
        ? textProfile(account, 'category')
        : 'Other',
      customerType: textProfile(account, 'customerType') || 'NONE',
      billWiseAdjustment: boolProfile(account, 'billWiseAdjustment'),
      cashBook: boolProfile(account, 'cashBook'),
      area: textProfile(account, 'area'),
      agent: textProfile(account, 'agent'),
      accountClass: textProfile(account, 'class'),
      creditLimit: textProfile(account, 'creditLimit'),
      overLimitAllowed: boolProfile(account, 'overLimitAllowed'),
      creditDays: textProfile(account, 'creditDays'),
      overDaysAllowed: boolProfile(account, 'overDaysAllowed'),
      taxType: textProfile(account, 'taxType') || 'NONE',
      institutionType: textProfile(account, 'institutionType') || 'PARTNERSHIP',
      bankGuarantee: textProfile(account, 'bankGuarantee'),
      cashDeposit: textProfile(account, 'cashDeposit'),
      currency: textProfile(account, 'currency') || 'NPR',
      interestRate: textProfile(account, 'interestRate'),
      bankName: account.bankName || '',
      bankBranch: account.bankBranch || '',
      accountNumber: account.accountNumber || '',
      accountHolder: account.accountHolder || '',
      swiftCode: account.swiftCode || '',
    });
    setError('');
    setNotice('');
  }

  const chooseAccount = (id: string) => {
    const account = accounts.find((row) => row.id === id);
    setSelectedId(id);
    setIsNew(false);
    if (account) fill(account);
  };

  const newAccount = () => {
    setIsNew(true);
    setSelectedId('');
    setForm({
      ...EMPTY_FORM,
      groupTopId: groups.find((group) => !group.parentId)?.id || '',
    });
    setTab('ACCOUNT');
    setError('');
    setNotice('');
  };

  const topGroups = groups.filter((group) => !group.parentId);
  const subGroupOptions = form.groupTopId
    ? hierarchyGroupOptions(groups).filter((option) =>
        groupDescendantIds(groups, form.groupTopId).has(option.id)
      )
    : [];
  const effectiveGroupId = form.groupSubId || form.groupTopId;
  const effectiveGroup = groups.find((group) => group.id === effectiveGroupId);
  const accountType: AccountType | null = effectiveGroup?.accountType || null;

  const chooseTopGroup = (id: string) => {
    const children = hierarchyGroupOptions(groups).filter(
      (option) => option.group.parentId === id
    );
    setForm({
      ...form,
      groupTopId: id,
      groupSubId: children[0]?.id || '',
    });
  };

  const chooseKind = (kind: AccountKind) => {
    setForm({
      ...form,
      accountKind: kind,
      postingRole:
        kind === 'CASH'
          ? 'CASH'
          : kind === 'BANK'
            ? 'BANK'
            : form.postingRole === 'CASH' || form.postingRole === 'BANK'
              ? ''
              : form.postingRole,
    });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return setError('A/c name is required.');
    if (!effectiveGroupId) return setError('Choose a group.');
    if (isNew && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/.test(form.code.trim())) {
      return setError('A/c code must be 1–30 letters, digits, hyphens or underscores.');
    }
    if (isNew && form.isControl && form.subledgerType === 'NONE') {
      return setError('A control account must name a subledger type.');
    }
    const masterProfile = {
      shortName: form.shortName.trim(),
      category: form.category.trim(),
      customerType: form.customerType,
      billWiseAdjustment: form.billWiseAdjustment,
      cashBook: form.cashBook,
      area: form.area.trim(),
      agent: form.agent.trim(),
      class: form.accountClass.trim(),
      creditLimit: form.creditLimit ? Number(form.creditLimit) : 0,
      overLimitAllowed: form.overLimitAllowed,
      creditDays: form.creditDays ? Number(form.creditDays) : 0,
      overDaysAllowed: form.overDaysAllowed,
      taxType: form.taxType,
      institutionType: form.institutionType,
      bankGuarantee: form.bankGuarantee.trim(),
      cashDeposit: form.cashDeposit.trim(),
      currency: form.currency,
      interestRate: form.interestRate ? Number(form.interestRate) : 0,
    };
    const core = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      groupId: effectiveGroupId,
      masterProfile,
      postingRole: form.postingRole || null,
      accountKind: form.accountKind,
      bankName: form.bankName.trim() || null,
      bankBranch: form.bankBranch.trim() || null,
      accountNumber: form.accountNumber.trim() || null,
      accountHolder: form.accountHolder.trim() || null,
      swiftCode: form.swiftCode.trim() || null,
    };
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (selected) {
        await api.updateAccountingAccount(selected.id, {
          ...core,
          isActive: form.isActive,
        });
        setNotice(`Saved ${form.code} · ${form.name}.`);
        await load(selected.id);
      } else {
        const created = await api.createAccountingAccount({
          code: form.code.trim().toUpperCase(),
          ...core,
          subledgerType: form.isControl ? form.subledgerType : 'NONE',
        });
        setIsNew(false);
        setNotice(`Created ${created.code} · ${created.name}.`);
        await load(created.id);
      }
    } catch (err: any) {
      setError(err?.message || 'The ledger account could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    const ok = await confirmDialog(
      `Delete ${selected.code} ${selected.name}? Only an account with no posting role and no posted lines can be deleted.`,
      { title: 'Delete ledger account', confirmLabel: 'Delete' }
    );
    if (!ok) return;
    try {
      await api.deleteAccountingAccount(selected.id);
      const remaining = accounts.filter((account) => account.id !== selected.id);
      setIsNew(true);
      setSelectedId('');
      setForm(EMPTY_FORM);
      setNotice('Ledger account deleted.');
      await load(remaining[0]?.id);
      if (remaining[0]) {
        setIsNew(false);
        chooseAccount(remaining[0].id);
      }
    } catch (err: any) {
      alertDialog(err?.message || 'The account could not be deleted.');
    }
  };

  const sorted = [...accounts].sort((left, right) => left.code.localeCompare(right.code));
  const position = sorted.findIndex((account) => account.id === selectedId);
  const step = (delta: number) => {
    const next = sorted[position + delta];
    if (next) chooseAccount(next.id);
  };

  const tabClass = (active: boolean) =>
    `rounded-t-lg px-3 py-1.5 text-[11px] font-bold transition ${
      active
        ? 'border border-b-0 border-slate-300 bg-white text-indigo-700 dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-300'
        : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
    }`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="General Ledger Master"
        description="Create and maintain every ledger account: group, control/subledger, credit terms, tax, bank and currency defaults."
        icon={<BookOpenCheck className="h-5 w-5 text-indigo-500" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            {canManage && (
              <button
                type="button"
                onClick={newAccount}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                <Plus className="h-4 w-4" /> New A/c
              </button>
            )}
          </div>
        }
      />

      <div className={`${panel} flex flex-wrap items-end gap-3`}>
        <label className={`${label} min-w-[260px] flex-1`}>
          A/c Name / search
          <select
            aria-label="Select ledger account"
            className={input}
            value={isNew ? '' : selectedId}
            onChange={(event) => chooseAccount(event.target.value)}
          >
            <option value="">— New account —</option>
            {sorted.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
                {account.isControl ? ` · ${account.subledgerType}` : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1 pb-1">
          <button
            type="button"
            aria-label="Previous account"
            className="rounded-lg border border-slate-300 p-1.5 text-slate-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300"
            disabled={position <= 0}
            onClick={() => step(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[48px] text-center font-mono text-[11px] text-slate-500">
            {position >= 0 ? `${position + 1}/${sorted.length}` : `new`}
          </span>
          <button
            type="button"
            aria-label="Next account"
            className="rounded-lg border border-slate-300 p-1.5 text-slate-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300"
            disabled={position < 0 || position >= sorted.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        {selected && (
          <div className="pb-1 text-right text-[10px] text-slate-400">
            <p className="font-mono">{selected.groupCode} · {selected.accountType}</p>
            <p>{selected.isActive ? 'ACTIVE' : 'INACTIVE'}</p>
          </div>
        )}
      </div>

      {error && <div className={errorClass}>{error}</div>}
      {notice && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <form className={panel} onSubmit={(event) => void save(event)}>
        <div className="mb-3 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-700">
          {(
            [
              ['ACCOUNT', 'Account Information'],
              ['OTHER', 'Other Information'],
              ['CREDIT', 'Credit & Terms'],
              ['BANK', 'Bank & Currency'],
            ] as Array<[TabKey, string]>
          ).map(([key, title]) => (
            <button key={key} type="button" className={tabClass(tab === key)} onClick={() => setTab(key)}>
              {title}
            </button>
          ))}
        </div>

        {tab === 'ACCOUNT' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div className="md:col-span-2">
                <label className={label} htmlFor="gl-name">A/c Name</label>
                <input id="gl-name" className={input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
              </div>
              <div>
                <label className={label} htmlFor="gl-code">A/c Code</label>
                <input id="gl-code" className={input} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} readOnly={Boolean(selected)} required />
              </div>
              <div>
                <label className={label} htmlFor="gl-short">Short Name</label>
                <input id="gl-short" className={input} value={form.shortName} onChange={(event) => setForm({ ...form, shortName: event.target.value })} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className={label} htmlFor="gl-category">Category</label>
                <select
                  id="gl-category"
                  className={input}
                  value={form.category}
                  onChange={(event) => setForm({ ...form, category: event.target.value })}
                >
                  {LEDGER_CATEGORY_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] text-slate-400">
                  Classifies this ledger as a party, both, contact or other ledger.
                </p>
              </div>
              <div>
                <label className={label} htmlFor="gl-group">Group</label>
                <select id="gl-group" className={input} value={form.groupTopId} onChange={(event) => chooseTopGroup(event.target.value)} required>
                  <option value="">Choose group…</option>
                  {topGroups.map((group) => (
                    <option key={group.id} value={group.id}>{group.code} · {group.name} ({group.accountType})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="gl-subgroup">Sub-Group</label>
                <select id="gl-subgroup" className={input} value={form.groupSubId} onChange={(event) => setForm({ ...form, groupSubId: event.target.value })} disabled={subGroupOptions.length === 0}>
                  <option value="">Directly under group</option>
                  {subGroupOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] text-slate-400">
                  Lists every descendant group; choose the exact ledger parent at any depth.
                </p>
              </div>
              <div>
                <label className={label} htmlFor="gl-type">A/c Type</label>
                <select id="gl-type" className={input} value={accountType || ''} disabled>
                  <option value="">Derived from group</option>
                  {ACCOUNT_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className={label} htmlFor="gl-kind">Cash / Bank</label>
                <select id="gl-kind" className={input} value={form.accountKind} onChange={(event) => chooseKind(event.target.value as AccountKind)}>
                  {ACCOUNT_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="gl-role">Posting role</label>
                <select id="gl-role" className={input} value={form.postingRole} onChange={(event) => setForm({ ...form, postingRole: event.target.value })}>
                  <option value="">No posting role</option>
                  {POSTING_ROLE_OPTIONS.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="gl-customer-type">Customer Type</label>
                <select id="gl-customer-type" className={input} value={form.customerType} onChange={(event) => setForm({ ...form, customerType: event.target.value })}>
                  {['NONE', 'RETAIL', 'WHOLESALE', 'CORPORATE', 'GOVERNMENT'].map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="gl-tax">Tax Type</label>
                <select id="gl-tax" className={input} value={form.taxType} onChange={(event) => setForm({ ...form, taxType: event.target.value })}>
                  {['NONE', 'VAT', 'TDS', 'EXEMPT'].map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <label className="flex items-center gap-2 pt-5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={form.cashBook} onChange={(event) => setForm({ ...form, cashBook: event.target.checked })} />
                Cash Book
              </label>
              <label className="flex items-center gap-2 pt-5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={form.billWiseAdjustment} onChange={(event) => setForm({ ...form, billWiseAdjustment: event.target.checked })} />
                Bill Wise Adjustment
              </label>
              <label className="flex items-center gap-2 pt-5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  disabled={!selected}
                  onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                />
                Active
              </label>
              <div />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className={label} htmlFor="gl-area">Area</label>
                <input id="gl-area" className={input} value={form.area} onChange={(event) => setForm({ ...form, area: event.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="gl-agent">Agent</label>
                <input id="gl-agent" className={input} value={form.agent} onChange={(event) => setForm({ ...form, agent: event.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="gl-class">Class</label>
                <input id="gl-class" className={input} value={form.accountClass} onChange={(event) => setForm({ ...form, accountClass: event.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="gl-currency">Currency</label>
                <select id="gl-currency" className={input} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
                  {['NPR', 'USD', 'EUR', 'INR'].map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={form.isControl}
                  disabled={Boolean(selected)}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setForm({
                      ...form,
                      isControl: next,
                      subledgerType: next
                        ? form.subledgerType === 'NONE' ? 'CUSTOMER' : form.subledgerType
                        : 'NONE',
                    });
                  }}
                />
                Sub Ledger (control account)
              </label>
              <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className={label} htmlFor="gl-subledger-type">Subledger type</label>
                  <select
                    id="gl-subledger-type"
                    className={input}
                    value={form.subledgerType}
                    disabled={!form.isControl}
                    onChange={(event) => setForm({ ...form, subledgerType: event.target.value })}
                  >
                    {SUBLEDGER_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </div>
                <p className="pt-5 text-[10px] text-slate-400">
                  A control account can own one account-wide book plus unlimited party books (for example one employee book per Salary Payable).
                  The control nature is fixed after creation.
                </p>
              </div>
            </div>
          </div>
        )}

        {tab === 'OTHER' && (
          <div className="space-y-3">
            <div>
              <label className={label} htmlFor="gl-description">Description</label>
              <textarea id="gl-description" className={input} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label className={label} htmlFor="gl-institution">Institution Type</label>
                <select id="gl-institution" className={input} value={form.institutionType} onChange={(event) => setForm({ ...form, institutionType: event.target.value })}>
                  {['PARTNERSHIP', 'COMPANY', 'INDIVIDUAL', 'GOVERNMENT', 'NGO'].map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="gl-bg">Bank Guarantee</label>
                <input id="gl-bg" className={input} value={form.bankGuarantee} onChange={(event) => setForm({ ...form, bankGuarantee: event.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="gl-deposit">Cash Deposit</label>
                <input id="gl-deposit" className={input} value={form.cashDeposit} onChange={(event) => setForm({ ...form, cashDeposit: event.target.value })} />
              </div>
            </div>
          </div>
        )}

        {tab === 'CREDIT' && (
          <div className="space-y-3">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Account-level defaults shown on this master. The customer master remains the authority for an actual customer's limit and terms.
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className={label} htmlFor="gl-credit-limit">Credit Limit</label>
                <input id="gl-credit-limit" type="number" step="0.01" min="0" className={input} value={form.creditLimit} onChange={(event) => setForm({ ...form, creditLimit: event.target.value })} />
              </div>
              <label className="flex items-center gap-2 pt-5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={form.overLimitAllowed} onChange={(event) => setForm({ ...form, overLimitAllowed: event.target.checked })} />
                Over Limit allowed
              </label>
              <div>
                <label className={label} htmlFor="gl-credit-days">Credit Days</label>
                <input id="gl-credit-days" type="number" min="0" className={input} value={form.creditDays} onChange={(event) => setForm({ ...form, creditDays: event.target.value })} />
              </div>
              <label className="flex items-center gap-2 pt-5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={form.overDaysAllowed} onChange={(event) => setForm({ ...form, overDaysAllowed: event.target.checked })} />
                Over Days allowed
              </label>
            </div>
          </div>
        )}

        {tab === 'BANK' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label className={label} htmlFor="gl-bank-name">Bank name</label>
                <input id="gl-bank-name" className={input} value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} disabled={form.accountKind !== 'BANK'} />
              </div>
              <div>
                <label className={label} htmlFor="gl-bank-branch">Branch</label>
                <input id="gl-bank-branch" className={input} value={form.bankBranch} onChange={(event) => setForm({ ...form, bankBranch: event.target.value })} disabled={form.accountKind !== 'BANK'} />
              </div>
              <div>
                <label className={label} htmlFor="gl-bank-account">Account number</label>
                <input id="gl-bank-account" className={input} value={form.accountNumber} onChange={(event) => setForm({ ...form, accountNumber: event.target.value })} disabled={form.accountKind !== 'BANK'} />
              </div>
              <div>
                <label className={label} htmlFor="gl-bank-holder">Account holder</label>
                <input id="gl-bank-holder" className={input} value={form.accountHolder} onChange={(event) => setForm({ ...form, accountHolder: event.target.value })} disabled={form.accountKind !== 'BANK'} />
              </div>
              <div>
                <label className={label} htmlFor="gl-bank-swift">SWIFT / BIC</label>
                <input id="gl-bank-swift" className={input} value={form.swiftCode} onChange={(event) => setForm({ ...form, swiftCode: event.target.value })} disabled={form.accountKind !== 'BANK'} />
              </div>
              <div>
                <label className={label} htmlFor="gl-interest">Rate of Interest</label>
                <input id="gl-interest" type="number" step="0.001" className={input} value={form.interestRate} onChange={(event) => setForm({ ...form, interestRate: event.target.value })} />
              </div>
            </div>
            {form.accountKind !== 'BANK' && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Bank details are saved only for a bank ledger. Set Cash / Bank to “Bank account” on Account Information to use them.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div>
            {canManage && selected && (
              <button type="button" onClick={() => void remove()} className="flex items-center gap-1.5 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-400">
                <Trash2 className="h-3.5 w-3.5" /> Delete A/c
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => (selected ? fill(selected) : newAccount())} disabled={saving} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">
              Cancel
            </button>
            {canManage && (
              <button type="submit" disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                <Save className="h-3.5 w-3.5" /> {saving ? 'Saving…' : selected ? 'Save A/c' : 'Create A/c'}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
};

export default GeneralLedgerMaster;
