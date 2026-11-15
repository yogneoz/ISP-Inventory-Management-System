import React, { useState } from 'react';
import { ModalPanel } from '../common/ModalPanel';
import { btnGhost, btnPrimary, inputClass, labelClass } from '../common/styleConstants';
import type {
  AccountingAccount,
  AccountingGroup,
  AccountKind,
  AccountType,
} from '../../services/api/accounting';
import {
  groupDescendantIds,
  hierarchyGroupOptions,
  statementPresentation,
} from './chartHierarchy';

/**
 * Chart maintenance dialogs.
 *
 * The chart is report structure, so the forms expose exactly what may change:
 * a group's label and order (never its code/type/statement mapping), and an
 * account's name/description/group/posting role. The Advanced tab carries the
 * legacy GL-master profile fields on the same account record. The server
 * enforces the rest — a posted account can move only within the same accounting
 * nature, and an account with posted lines cannot be deleted at all.
 */

export const SUBLEDGER_TYPE_OPTIONS = [
  'NONE',
  'CUSTOMER',
  'SUPPLIER',
  'EMPLOYEE',
  'LENDER',
  'INVENTORY',
  'FIXED_ASSET',
  'BANK',
  'CASH',
  'TAX',
  'INTER_BRANCH',
] as const;

export const POSTING_ROLE_OPTIONS = [
  'AR_CONTROL',
  'AP_CONTROL',
  'CASH',
  'BANK',
  'INVENTORY',
  'SALES',
  'COGS',
  'TAX_OUTPUT',
  'TAX_INPUT',
  'RETAINED_EARNINGS',
  'SALARY_PAYABLE',
  'INTER_BRANCH_CLEARING',
  'STOCK_EXPENSE',
  'CPE_ASSET',
  'DUE_FROM_HO',
  'DUE_TO_HO',
  'FIXED_ASSET',
  'ACCUMULATED_DEPRECIATION',
  'DEPRECIATION_EXPENSE',
  'GAIN_ON_DISPOSAL',
  'LOSS_ON_DISPOSAL',
  'SALARY_EXPENSE',
  'PAYMENT_FEE_EXPENSE',
  'TDS_PAYABLE',
  'SSF_PAYABLE',
  'EMPLOYEE_ADVANCE',
  'EMPLOYEE_LOAN',
  'LOAN_PAYABLE',
] as const;

export const ACCOUNT_TYPE_OPTIONS: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
export const ACCOUNT_KIND_OPTIONS: Array<{ value: AccountKind; label: string }> = [
  { value: 'OTHER', label: 'Other ledger' },
  { value: 'CASH', label: 'Cash / till' },
  { value: 'BANK', label: 'Bank account' },
  { value: 'WALLET', label: 'Wallet / PSP clearing' },
];

export const WALLET_PROVIDER_OPTIONS = [
  { value: 'ESEWA', label: 'eSewa' },
  { value: 'KHALTI', label: 'Khalti' },
  { value: 'NEPAL_PAY', label: 'Nepal Pay' },
] as const;

export const STATEMENT_GROUPS_BY_TYPE: Record<AccountType, string[]> = {
  ASSET: ['CURRENT_ASSET', 'NON_CURRENT_ASSET'],
  LIABILITY: ['CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY'],
  EQUITY: ['EQUITY'],
  INCOME: ['REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'],
};

/** Legacy GL-master ledger categories, kept on `gl_accounts.master_profile`. */
export const LEDGER_CATEGORY_OPTIONS = ['Both', 'Customer', 'Vendor', 'Other', 'Contact'] as const;

export interface AdvancedProfileForm {
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
}

const EMPTY_ADVANCED: AdvancedProfileForm = {
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
};

const profileText = (profile: Record<string, unknown> | undefined, key: string): string => {
  const value = profile?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};

const profileBool = (profile: Record<string, unknown> | undefined, key: string): boolean =>
  profile?.[key] === true;

function initialAdvancedProfile(account?: AccountingAccount): AdvancedProfileForm {
  const profile = account?.masterProfile;
  const category = profileText(profile, 'category');
  return {
    shortName: profileText(profile, 'shortName'),
    category: LEDGER_CATEGORY_OPTIONS.includes(category as (typeof LEDGER_CATEGORY_OPTIONS)[number])
      ? category
      : 'Other',
    customerType: profileText(profile, 'customerType') || 'NONE',
    billWiseAdjustment: profileBool(profile, 'billWiseAdjustment'),
    cashBook: profileBool(profile, 'cashBook'),
    area: profileText(profile, 'area'),
    agent: profileText(profile, 'agent'),
    accountClass: profileText(profile, 'class'),
    creditLimit: profileText(profile, 'creditLimit'),
    overLimitAllowed: profileBool(profile, 'overLimitAllowed'),
    creditDays: profileText(profile, 'creditDays'),
    overDaysAllowed: profileBool(profile, 'overDaysAllowed'),
    taxType: profileText(profile, 'taxType') || 'NONE',
    institutionType: profileText(profile, 'institutionType') || 'PARTNERSHIP',
    bankGuarantee: profileText(profile, 'bankGuarantee'),
    cashDeposit: profileText(profile, 'cashDeposit'),
    currency: profileText(profile, 'currency') || 'NPR',
    interestRate: profileText(profile, 'interestRate'),
  };
}

function buildMasterProfile(
  account: AccountingAccount | undefined,
  advanced: AdvancedProfileForm
): Record<string, unknown> {
  return {
    ...(account?.masterProfile ?? {}),
    shortName: advanced.shortName.trim(),
    category: advanced.category,
    customerType: advanced.customerType,
    billWiseAdjustment: advanced.billWiseAdjustment,
    cashBook: advanced.cashBook,
    area: advanced.area.trim(),
    agent: advanced.agent.trim(),
    class: advanced.accountClass.trim(),
    creditLimit: advanced.creditLimit ? Number(advanced.creditLimit) : 0,
    overLimitAllowed: advanced.overLimitAllowed,
    creditDays: advanced.creditDays ? Number(advanced.creditDays) : 0,
    overDaysAllowed: advanced.overDaysAllowed,
    taxType: advanced.taxType,
    institutionType: advanced.institutionType,
    bankGuarantee: advanced.bankGuarantee.trim(),
    cashDeposit: advanced.cashDeposit.trim(),
    currency: advanced.currency,
    interestRate: advanced.interestRate ? Number(advanced.interestRate) : 0,
  };
}

const overlay = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4';
const panel =
  'max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900';
const errorClass =
  'rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';

function DialogFooter({
  busy,
  submitLabel,
  onClose,
}: {
  busy: boolean;
  submitLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
      <button type="button" className={btnGhost} onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button type="submit" className={btnPrimary} disabled={busy}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </div>
  );
}

export interface AccountFormValues {
  code: string;
  name: string;
  groupId: string;
  description: string;
  subledgerType: string;
  postingRole: string;
  accountKind: AccountKind;
  branchId: string;
  providerCode: string;
  merchantId: string;
  settlementAccountId: string;
  bankName: string;
  bankBranch: string;
  accountNumber: string;
  accountHolder: string;
  swiftCode: string;
  masterProfile: Record<string, unknown>;
}

export const AccountFormDialog: React.FC<{
  mode: 'create' | 'edit';
  account?: AccountingAccount;
  groups: AccountingGroup[];
  accounts: AccountingAccount[];
  branches: Array<{ id: string; code: string; name: string }>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (values: AccountFormValues) => void;
}> = ({ mode, account, groups, accounts, branches, busy, error, onClose, onSubmit }) => {
  const [tab, setTab] = useState<'PROFILE' | 'BANK' | 'ADVANCED'>('PROFILE');
  const [code, setCode] = useState(account?.code || '');
  const [name, setName] = useState(account?.name || '');
  const [groupId, setGroupId] = useState(account?.groupId || groups[0]?.id || '');
  const [description, setDescription] = useState(account?.description || '');
  const [subledgerType, setSubledgerType] = useState(account?.subledgerType || 'NONE');
  // Explicit control-account toggle: the subledger select used to be the only
  // signal, so an operator could create a control account without realising it.
  const [controlAccount, setControlAccount] = useState(Boolean(account?.isControl));
  const [postingRole, setPostingRole] = useState(account?.postingRole || '');
  const [accountKind, setAccountKind] = useState<AccountKind>(
    account?.accountKind || (account?.postingRole === 'CASH' ? 'CASH' : account?.postingRole === 'BANK' ? 'BANK' : 'OTHER')
  );
  const [branchId, setBranchId] = useState(account?.branchId || '');
  const [providerCode, setProviderCode] = useState(account?.providerCode || '');
  const [merchantId, setMerchantId] = useState(account?.merchantId || '');
  const [settlementAccountId, setSettlementAccountId] = useState(
    account?.settlementAccountId || ''
  );
  const [bankName, setBankName] = useState(account?.bankName || '');
  const [bankBranch, setBankBranch] = useState(account?.bankBranch || '');
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber || '');
  const [accountHolder, setAccountHolder] = useState(account?.accountHolder || '');
  const [swiftCode, setSwiftCode] = useState(account?.swiftCode || '');
  const [advanced, setAdvanced] = useState<AdvancedProfileForm>(() => initialAdvancedProfile(account));
  const title = mode === 'create' ? 'New ledger account' : `Edit ${account?.code || 'account'}`;
  const tabClass = (active: boolean) =>
    `rounded-t-lg px-3 py-1.5 text-[11px] font-bold transition ${
      active
        ? 'border border-b-0 border-slate-300 bg-white text-indigo-700 dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-300'
        : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
    }`;

  const chooseKind = (kind: AccountKind) => {
    setAccountKind(kind);
    if (kind === 'CASH' && postingRole && postingRole !== 'CASH') setPostingRole('');
    if (kind === 'BANK' && postingRole && postingRole !== 'BANK') setPostingRole('');
    if (kind === 'OTHER' && (postingRole === 'CASH' || postingRole === 'BANK')) setPostingRole('');
    if (kind !== 'BANK') {
      setBankName('');
      setBankBranch('');
      setAccountNumber('');
      setAccountHolder('');
      setSwiftCode('');
    }
    if (kind !== 'WALLET') {
      setProviderCode('');
      setMerchantId('');
      setSettlementAccountId('');
    }
  };

  const chooseRole = (role: string) => {
    setPostingRole(role);
    if (role === 'CASH') setAccountKind('CASH');
    else if (role === 'BANK') setAccountKind('BANK');
    else if (role && (accountKind === 'CASH' || accountKind === 'BANK')) setAccountKind('OTHER');
  };

  return (
    <div className={overlay}>
      <ModalPanel label={title} onClose={busy ? undefined : onClose} className={panel}>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              code,
              name,
              groupId,
              description,
              subledgerType: controlAccount ? subledgerType : 'NONE',
              postingRole,
              accountKind,
              branchId,
              providerCode,
              merchantId,
              settlementAccountId,
              bankName,
              bankBranch,
              accountNumber,
              accountHolder,
              swiftCode,
              masterProfile: buildMasterProfile(account, advanced),
            });
          }}
        >
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">{title}</h2>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              A control account names its subledger; an ordinary account uses NONE. Cash and bank
              ledgers use their own kind, not the subledger field.
            </p>
          </div>
          {error && <div className={errorClass}>{error}</div>}

          <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
            <button type="button" id="chart-tab-profile" className={tabClass(tab === 'PROFILE')} onClick={() => setTab('PROFILE')}>
              Profile
            </button>
            <button type="button" id="chart-tab-bank" className={tabClass(tab === 'BANK')} onClick={() => setTab('BANK')}>
              Custody details{accountKind === 'BANK' || accountKind === 'WALLET' ? ' •' : ''}
            </button>
            <button type="button" id="chart-tab-advanced" className={tabClass(tab === 'ADVANCED')} onClick={() => setTab('ADVANCED')}>
              Advanced
            </button>
          </div>

          {tab === 'PROFILE' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="chart-account-code">
                    Code
                  </label>
                  <input
                    id="chart-account-code"
                    className={inputClass}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="e.g. 1120"
                    readOnly={mode === 'edit'}
                    required
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-name">
                    Account name
                  </label>
                  <input
                    id="chart-account-name"
                    className={inputClass}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Staff Advance"
                    required
                  />
                </div>
              </div>
              <div>
                <label className={labelClass} htmlFor="chart-account-group">
                  Account group / sub-group
                </label>
                <select
                  id="chart-account-group"
                  className={inputClass}
                  value={groupId}
                  onChange={(event) => setGroupId(event.target.value)}
                  required
                >
                  {hierarchyGroupOptions(groups).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} ({option.group.accountType})
                    </option>
                  ))}
                </select>
                {mode === 'edit' && (
                  <p className="mt-1 text-[10px] text-slate-400">
                    A posted account can move only to a group with the same account type,
                    statement group and normal balance.
                  </p>
                )}
              </div>
              <div>
                <label className={labelClass} htmlFor="chart-account-description">
                  Description (optional)
                </label>
                <input
                  id="chart-account-description"
                  className={inputClass}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="chart-account-kind">
                  Ledger kind
                </label>
                <select
                  id="chart-account-kind"
                  className={inputClass}
                  value={accountKind}
                  onChange={(event) => chooseKind(event.target.value as AccountKind)}
                >
                  {ACCOUNT_KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] text-slate-400">
                  Cash, bank and wallet kinds may have many ledgers. Only the one carrying the matching posting role is the default.
                </p>
              </div>
              <div>
                <label className={labelClass} htmlFor="chart-account-owner">
                  Custody owner
                </label>
                <select
                  id="chart-account-owner"
                  className={inputClass}
                  value={branchId}
                  onChange={(event) => setBranchId(event.target.value)}
                >
                  <option value="">Shared / company-wide</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.code} · {branch.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] text-slate-400">
                  A till normally belongs to one branch. A bank or provider clearing account may stay shared.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      id="chart-account-control"
                      checked={controlAccount}
                      disabled={mode === 'edit'}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setControlAccount(next);
                        if (!next) setSubledgerType('NONE');
                        else if (subledgerType === 'NONE') setSubledgerType('CUSTOMER');
                      }}
                    />
                    Control account (party detail lives in a subledger)
                  </label>
                  <p className="mb-2 text-[10px] text-slate-400">
                    Use one control account for a receivables or payables family and keep individual parties in subledger books. Do not create a ledger per customer or supplier.
                  </p>
                  <label className={labelClass} htmlFor="chart-account-subledger">
                    Subledger
                  </label>
                  <select
                    id="chart-account-subledger"
                    className={inputClass}
                    value={subledgerType}
                    onChange={(event) => setSubledgerType(event.target.value)}
                    disabled={mode === 'edit' || !controlAccount}
                  >
                    {SUBLEDGER_TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  {mode === 'edit' && (
                    <p className="mt-1 text-[10px] text-slate-400">An account's control nature is fixed after creation.</p>
                  )}
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-role">
                    Posting role
                  </label>
                  <select
                    id="chart-account-role"
                    className={inputClass}
                    value={postingRole}
                    onChange={(event) => chooseRole(event.target.value)}
                  >
                    <option value="">No posting role</option>
                    {POSTING_ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ) : tab === 'BANK' ? (
            <div className="space-y-3">
              {accountKind === 'WALLET' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass} htmlFor="chart-wallet-provider">
                      Provider
                    </label>
                    <select
                      id="chart-wallet-provider"
                      className={inputClass}
                      value={providerCode}
                      onChange={(event) => setProviderCode(event.target.value)}
                      required
                    >
                      <option value="">Select provider</option>
                      {WALLET_PROVIDER_OPTIONS.map((provider) => (
                        <option key={provider.value} value={provider.value}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="chart-wallet-merchant">
                      Merchant / terminal id
                    </label>
                    <input
                      id="chart-wallet-merchant"
                      className={inputClass}
                      value={merchantId}
                      onChange={(event) => setMerchantId(event.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="chart-wallet-settlement">
                      Settlement bank account
                    </label>
                    <select
                      id="chart-wallet-settlement"
                      className={inputClass}
                      value={settlementAccountId}
                      onChange={(event) => setSettlementAccountId(event.target.value)}
                    >
                      <option value="">Not set</option>
                      {accounts
                        .filter((row) => row.accountKind === 'BANK' && row.isActive)
                        .map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.code} · {row.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              ) : accountKind !== 'BANK' ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
                  {accountKind === 'CASH'
                    ? 'This is a cash / till ledger. It has no bank details; give it a clear name so the payment picker can distinguish it from other tills.'
                    : 'This ledger is not a cash, bank or wallet account. Set Ledger kind on the Profile tab to record custody details.'}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass} htmlFor="chart-bank-name">
                      Bank name
                    </label>
                    <input id="chart-bank-name" className={inputClass} value={bankName} onChange={(event) => setBankName(event.target.value)} placeholder="e.g. Nepal Investment Bank" />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="chart-bank-branch">
                      Branch
                    </label>
                    <input id="chart-bank-branch" className={inputClass} value={bankBranch} onChange={(event) => setBankBranch(event.target.value)} placeholder="e.g. New Baneshwor" />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="chart-bank-account-number">
                      Account number
                    </label>
                    <input id="chart-bank-account-number" className={inputClass} value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="chart-bank-account-holder">
                      Account holder
                    </label>
                    <input id="chart-bank-account-holder" className={inputClass} value={accountHolder} onChange={(event) => setAccountHolder(event.target.value)} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="chart-bank-swift">
                      SWIFT / BIC (optional)
                    </label>
                    <input id="chart-bank-swift" className={inputClass} value={swiftCode} onChange={(event) => setSwiftCode(event.target.value)} />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Legacy account-level defaults. These stay on the ledger account; the customer,
                supplier and employee masters remain authoritative for actual parties.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="chart-account-short-name">
                    Short name
                  </label>
                  <input
                    id="chart-account-short-name"
                    className={inputClass}
                    value={advanced.shortName}
                    onChange={(event) => setAdvanced({ ...advanced, shortName: event.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-category">
                    Category
                  </label>
                  <select
                    id="chart-account-category"
                    className={inputClass}
                    value={advanced.category}
                    onChange={(event) => setAdvanced({ ...advanced, category: event.target.value })}
                  >
                    {LEDGER_CATEGORY_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-customer-type">
                    Customer type
                  </label>
                  <select
                    id="chart-account-customer-type"
                    className={inputClass}
                    value={advanced.customerType}
                    onChange={(event) => setAdvanced({ ...advanced, customerType: event.target.value })}
                  >
                    {['NONE', 'RETAIL', 'WHOLESALE', 'CORPORATE', 'GOVERNMENT'].map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-tax-type">
                    Tax type
                  </label>
                  <select
                    id="chart-account-tax-type"
                    className={inputClass}
                    value={advanced.taxType}
                    onChange={(event) => setAdvanced({ ...advanced, taxType: event.target.value })}
                  >
                    {['NONE', 'VAT', 'TDS', 'EXEMPT'].map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-institution">
                    Institution type
                  </label>
                  <select
                    id="chart-account-institution"
                    className={inputClass}
                    value={advanced.institutionType}
                    onChange={(event) => setAdvanced({ ...advanced, institutionType: event.target.value })}
                  >
                    {['PARTNERSHIP', 'COMPANY', 'INDIVIDUAL', 'GOVERNMENT', 'NGO'].map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-currency">
                    Currency
                  </label>
                  <select
                    id="chart-account-currency"
                    className={inputClass}
                    value={advanced.currency}
                    onChange={(event) => setAdvanced({ ...advanced, currency: event.target.value })}
                  >
                    {['NPR', 'USD', 'EUR', 'INR'].map((currency) => (
                      <option key={currency} value={currency}>{currency}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-area">
                    Area
                  </label>
                  <input
                    id="chart-account-area"
                    className={inputClass}
                    value={advanced.area}
                    onChange={(event) => setAdvanced({ ...advanced, area: event.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-agent">
                    Agent
                  </label>
                  <input
                    id="chart-account-agent"
                    className={inputClass}
                    value={advanced.agent}
                    onChange={(event) => setAdvanced({ ...advanced, agent: event.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-class">
                    Class
                  </label>
                  <input
                    id="chart-account-class"
                    className={inputClass}
                    value={advanced.accountClass}
                    onChange={(event) => setAdvanced({ ...advanced, accountClass: event.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-bank-guarantee">
                    Bank guarantee
                  </label>
                  <input
                    id="chart-account-bank-guarantee"
                    className={inputClass}
                    value={advanced.bankGuarantee}
                    onChange={(event) => setAdvanced({ ...advanced, bankGuarantee: event.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-cash-deposit">
                    Cash deposit
                  </label>
                  <input
                    id="chart-account-cash-deposit"
                    className={inputClass}
                    value={advanced.cashDeposit}
                    onChange={(event) => setAdvanced({ ...advanced, cashDeposit: event.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-interest-rate">
                    Rate of interest
                  </label>
                  <input
                    id="chart-account-interest-rate"
                    type="number"
                    step="0.001"
                    className={inputClass}
                    value={advanced.interestRate}
                    onChange={(event) => setAdvanced({ ...advanced, interestRate: event.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-credit-limit">
                    Credit limit
                  </label>
                  <input
                    id="chart-account-credit-limit"
                    type="number"
                    step="0.01"
                    min="0"
                    className={inputClass}
                    value={advanced.creditLimit}
                    onChange={(event) => setAdvanced({ ...advanced, creditLimit: event.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="chart-account-credit-days">
                    Credit days
                  </label>
                  <input
                    id="chart-account-credit-days"
                    type="number"
                    min="0"
                    className={inputClass}
                    value={advanced.creditDays}
                    onChange={(event) => setAdvanced({ ...advanced, creditDays: event.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {([
                  ['billWiseAdjustment', 'Bill-wise adjustment'],
                  ['cashBook', 'Cash book'],
                  ['overLimitAllowed', 'Over-limit allowed'],
                  ['overDaysAllowed', 'Over-days allowed'],
                ] as Array<[keyof AdvancedProfileForm, string]>).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      id={`chart-account-${key}`}
                      checked={Boolean(advanced[key])}
                      onChange={(event) => setAdvanced({ ...advanced, [key]: event.target.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <DialogFooter busy={busy} submitLabel={mode === 'create' ? 'Create account' : 'Save account'} onClose={onClose} />
        </form>
      </ModalPanel>
    </div>
  );
};

export interface GroupFormValues {
  parentId: string | null;
  code: string;
  name: string;
  accountType: AccountType;
  statementGroup: string;
  sortOrder: string;
}

export const GroupFormDialog: React.FC<{
  mode: 'create' | 'edit';
  group?: AccountingGroup;
  /** Prefill the parent when the user starts from a group's Add sub-group action. */
  initialParentId?: string;
  groups: AccountingGroup[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (values: GroupFormValues) => void;
}> = ({ mode, group, initialParentId, groups, busy, error, onClose, onSubmit }) => {
  const startingParentId = group?.parentId || initialParentId || '';
  const startingParent = startingParentId
    ? groups.find((candidate) => candidate.id === startingParentId)
    : undefined;
  const [parentId, setParentId] = useState(startingParentId);
  const [code, setCode] = useState(group?.code || '');
  const [name, setName] = useState(group?.name || '');
  const [accountType, setAccountType] = useState<AccountType>(
    group?.accountType || startingParent?.accountType || 'ASSET'
  );
  const [statementGroup, setStatementGroup] = useState(
    group?.statementGroup || startingParent?.statementGroup || 'CURRENT_ASSET'
  );
  const [sortOrder, setSortOrder] = useState(String(group?.sortOrder ?? 0));
  const title = mode === 'create'
    ? parentId ? 'New sub-group' : 'New account group'
    : `Edit ${group?.code || 'group'}`;
  const blockedParents = new Set<string>();
  if (group) {
    blockedParents.add(group.id);
    for (const id of groupDescendantIds(groups, group.id)) blockedParents.add(id);
  }
  const parentOptions = hierarchyGroupOptions(groups).filter(
    (option) => !blockedParents.has(option.id)
  );
  const selectedParent = parentId ? groups.find((candidate) => candidate.id === parentId) : undefined;

  return (
    <div className={overlay}>
      <ModalPanel label={title} onClose={busy ? undefined : onClose} className={panel}>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({ parentId: parentId || null, code, name, accountType, statementGroup, sortOrder });
          }}
        >
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">{title}</h2>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              Groups decide where accounts appear in the trial balance, balance sheet and P&amp;L. A group can sit under any other group; only ledger accounts receive postings.
            </p>
          </div>
          {error && <div className={errorClass}>{error}</div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="chart-group-code">
                Code
              </label>
              <input
                id="chart-group-code"
                className={inputClass}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="e.g. FA"
                readOnly={mode === 'edit'}
                required
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="chart-group-name">
                Group name
              </label>
              <input
                id="chart-group-name"
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Fixed Assets"
                required
              />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="chart-group-parent">
              Parent group
            </label>
            <select
              id="chart-group-parent"
              className={inputClass}
              value={parentId}
              onChange={(event) => {
                const next = event.target.value;
                setParentId(next);
                const parent = next ? groups.find((candidate) => candidate.id === next) : undefined;
                if (parent) {
                  setAccountType(parent.accountType);
                  setStatementGroup(parent.statementGroup);
                }
              }}
            >
              <option value="">None — top-level group</option>
              {parentOptions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label} ({candidate.group.accountType})
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-slate-400">
              {parentId
                ? 'A sub-group inherits the nearest parent’s type and statement mapping at any depth.'
                : 'Choose a parent at any level to make this a sub-group.'}
              {mode === 'edit' && ' Only an empty group (no accounts or sub-groups) can move.'}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="chart-group-type">
                Account type
              </label>
              <select
                id="chart-group-type"
                className={inputClass}
                value={accountType}
                disabled={mode === 'edit' || Boolean(selectedParent)}
                onChange={(event) => {
                  const next = event.target.value as AccountType;
                  setAccountType(next);
                  setStatementGroup(STATEMENT_GROUPS_BY_TYPE[next][0]);
                }}
              >
                {ACCOUNT_TYPE_OPTIONS.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="chart-group-statement">
                Statement group
              </label>
              <select
                id="chart-group-statement"
                className={inputClass}
                value={statementGroup}
                disabled={mode === 'edit' || Boolean(selectedParent)}
                onChange={(event) => setStatementGroup(event.target.value)}
              >
                {STATEMENT_GROUPS_BY_TYPE[accountType].map((statement) => (
                  <option key={statement} value={statement}>
                    {statement}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-slate-400">
                Reports under {statementPresentation(accountType, statementGroup)}.
              </p>
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="chart-group-sort">
              Sort order
            </label>
            <input
              id="chart-group-sort"
              type="number"
              step={1}
              className={inputClass}
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </div>
          <DialogFooter
            busy={busy}
            submitLabel={mode === 'create'
              ? parentId ? 'Create sub-group' : 'Create group'
              : 'Save group'}
            onClose={onClose}
          />
        </form>
      </ModalPanel>
    </div>
  );
};
