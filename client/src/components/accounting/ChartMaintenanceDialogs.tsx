import React, { useState } from 'react';
import { ModalPanel } from '../common/ModalPanel';
import { btnGhost, btnPrimary, inputClass, labelClass } from '../common/styleConstants';
import type {
  AccountingAccount,
  AccountingGroup,
  AccountKind,
  AccountType,
} from '../../services/api/accounting';

/**
 * Chart maintenance dialogs.
 *
 * The chart is report structure, so the forms expose exactly what may change:
 * a group's label and order (never its code/type/statement mapping), and an
 * account's name/description/group/posting role. The server enforces the rest —
 * a used account cannot move groups, and an account with posted lines cannot be
 * deleted at all.
 */

export const SUBLEDGER_TYPE_OPTIONS = [
  'NONE',
  'CUSTOMER',
  'SUPPLIER',
  'EMPLOYEE',
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
  'TDS_PAYABLE',
  'SSF_PAYABLE',
  'EMPLOYEE_ADVANCE',
  'EMPLOYEE_LOAN',
] as const;

export const ACCOUNT_TYPE_OPTIONS: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
export const ACCOUNT_KIND_OPTIONS: Array<{ value: AccountKind; label: string }> = [
  { value: 'OTHER', label: 'Other ledger' },
  { value: 'CASH', label: 'Cash / till' },
  { value: 'BANK', label: 'Bank account' },
];

export const STATEMENT_GROUPS_BY_TYPE: Record<AccountType, string[]> = {
  ASSET: ['CURRENT_ASSET', 'NON_CURRENT_ASSET'],
  LIABILITY: ['CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY'],
  EQUITY: ['EQUITY'],
  INCOME: ['REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'],
};

/** Flattened group options with the parent code shown for a sub-group. */
export function hierarchyGroupOptions(groups: readonly AccountingGroup[]): Array<{
  id: string;
  label: string;
  group: AccountingGroup;
}> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  return groups.map((group) => {
    const parent = group.parentId ? byId.get(group.parentId) : undefined;
    return {
      id: group.id,
      group,
      label: parent
        ? `${parent.code} / ${group.code} · ${group.name}`
        : `${group.code} · ${group.name}`,
    };
  });
}

const overlay = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4';
const panel =
  'w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900';
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
  bankName: string;
  bankBranch: string;
  accountNumber: string;
  accountHolder: string;
  swiftCode: string;
}

export const AccountFormDialog: React.FC<{
  mode: 'create' | 'edit';
  account?: AccountingAccount;
  groups: AccountingGroup[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (values: AccountFormValues) => void;
}> = ({ mode, account, groups, busy, error, onClose, onSubmit }) => {
  const [tab, setTab] = useState<'PROFILE' | 'BANK'>('PROFILE');
  const [code, setCode] = useState(account?.code || '');
  const [name, setName] = useState(account?.name || '');
  const [groupId, setGroupId] = useState(account?.groupId || groups[0]?.id || '');
  const [description, setDescription] = useState(account?.description || '');
  const [subledgerType, setSubledgerType] = useState(account?.subledgerType || 'NONE');
  const [postingRole, setPostingRole] = useState(account?.postingRole || '');
  const [accountKind, setAccountKind] = useState<AccountKind>(
    account?.accountKind || (account?.postingRole === 'CASH' ? 'CASH' : account?.postingRole === 'BANK' ? 'BANK' : 'OTHER')
  );
  const [bankName, setBankName] = useState(account?.bankName || '');
  const [bankBranch, setBankBranch] = useState(account?.bankBranch || '');
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber || '');
  const [accountHolder, setAccountHolder] = useState(account?.accountHolder || '');
  const [swiftCode, setSwiftCode] = useState(account?.swiftCode || '');
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
              subledgerType,
              postingRole,
              accountKind,
              bankName,
              bankBranch,
              accountNumber,
              accountHolder,
              swiftCode,
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
              Cash / bank details{accountKind === 'BANK' ? ' •' : ''}
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
                  Account group
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
                    A group change is refused once the account has posted entries.
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
                  Cash and bank kinds may have many ledgers. Only the one carrying the matching posting role is the default.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="chart-account-subledger">
                    Subledger
                  </label>
                  <select
                    id="chart-account-subledger"
                    className={inputClass}
                    value={subledgerType}
                    onChange={(event) => setSubledgerType(event.target.value)}
                    disabled={mode === 'edit'}
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
          ) : (
            <div className="space-y-3">
              {accountKind !== 'BANK' ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
                  {accountKind === 'CASH'
                    ? 'This is a cash / till ledger. It has no bank details; give it a clear name so the payment picker can distinguish it from other tills.'
                    : 'This ledger is not a cash or bank account. Set Ledger kind to Bank account on the Profile tab to record bank details.'}
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
  groups: AccountingGroup[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (values: GroupFormValues) => void;
}> = ({ mode, group, groups, busy, error, onClose, onSubmit }) => {
  const [parentId, setParentId] = useState(group?.parentId || '');
  const [code, setCode] = useState(group?.code || '');
  const [name, setName] = useState(group?.name || '');
  const [accountType, setAccountType] = useState<AccountType>(group?.accountType || 'ASSET');
  const [statementGroup, setStatementGroup] = useState(group?.statementGroup || 'CURRENT_ASSET');
  const [sortOrder, setSortOrder] = useState(String(group?.sortOrder ?? 0));
  const title = mode === 'create' ? 'New account group' : `Edit ${group?.code || 'group'}`;
  const parentOptions = groups.filter((candidate) => !candidate.parentId && candidate.id !== group?.id);
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
              Groups decide where accounts appear in the trial balance, balance sheet and P&amp;L.
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
                  {candidate.code} · {candidate.name} ({candidate.accountType})
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-slate-400">
              {parentId
                ? 'A sub-group inherits its parent’s type and statement mapping.'
                : 'Choose a top-level group to make this a sub-group.'}
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
          <DialogFooter busy={busy} submitLabel={mode === 'create' ? 'Create group' : 'Save group'} onClose={onClose} />
        </form>
      </ModalPanel>
    </div>
  );
};
