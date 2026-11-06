import React, { useMemo, useState } from 'react';
import { Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { StatCard } from '../common/StatCard';
import { useDialog } from '../common/DialogProvider';
import { api } from '../../services/api';
import type {
  AccountingAccount,
  AccountingGroup,
  ControlReconciliationResponse,
  PostingDefault,
} from '../../services/api/accounting';
import { StatusPill } from './StatementPrimitives';
import { money } from './statementFormat';
import {
  AccountFormDialog,
  GroupFormDialog,
  type AccountFormValues,
  type GroupFormValues,
} from './ChartMaintenanceDialogs';

export interface ChartState {
  groups: AccountingGroup[];
  accounts: AccountingAccount[];
  defaults: Record<string, PostingDefault>;
  reconciliations: ControlReconciliationResponse[];
  reconciliationErrors: Record<string, string>;
}

const rowAction =
  'inline-flex min-h-[24px] items-center gap-1 rounded-md border border-slate-300 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';
const dangerAction =
  'inline-flex min-h-[24px] items-center gap-1 rounded-md border border-rose-300 px-1.5 py-0.5 text-[10px] font-bold text-rose-600 transition hover:bg-rose-50 disabled:opacity-40 dark:border-rose-500/40 dark:text-rose-400 dark:hover:bg-rose-950/30';
const toolbarPrimary =
  'inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50';
const toolbarGhost =
  'inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800';

export const ChartView: React.FC<{
  state: ChartState;
  branchId: string;
  loading: boolean;
  /** `gl-manage`: without it the chart stays readable but has no action buttons. */
  canManage: boolean;
  /** Re-read the chart after a successful mutation. */
  onChanged: () => void;
}> = ({ state, branchId, loading, canManage, onChanged }) => {
  const { confirm: confirmDialog } = useDialog();
  const [accountDialog, setAccountDialog] = useState<{ mode: 'create' | 'edit'; account?: AccountingAccount } | null>(null);
  const [groupDialog, setGroupDialog] = useState<{
    mode: 'create' | 'edit';
    group?: AccountingGroup;
    initialParentId?: string;
  } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [actionError, setActionError] = useState('');

  const accountsByGroup = useMemo(() => {
    const groups = new Map<string, AccountingAccount[]>();
    for (const account of state.accounts) {
      const key = account.groupCode;
      const list = groups.get(key);
      if (list) list.push(account);
      else groups.set(key, [account]);
    }
    return groups;
  }, [state.accounts]);

  const groupsByParent = useMemo(() => {
    const byParent = new Map<string, AccountingGroup[]>();
    for (const group of state.groups) {
      const key = group.parentId || '';
      const list = byParent.get(key);
      if (list) list.push(group);
      else byParent.set(key, [group]);
    }
    for (const list of byParent.values()) {
      list.sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code));
    }
    return byParent;
  }, [state.groups]);
  const rootGroups = groupsByParent.get('') ?? [];

  const defaultRoles = useMemo(
    () => Object.entries(state.defaults).sort(([left], [right]) => left.localeCompare(right)),
    [state.defaults]
  );

  const submitAccount = async (values: AccountFormValues) => {
    setDialogBusy(true);
    setDialogError('');
    try {
      if (accountDialog?.mode === 'edit' && accountDialog.account) {
        await api.updateAccountingAccount(accountDialog.account.id, {
          name: values.name,
          groupId: values.groupId,
          description: values.description,
          postingRole: values.postingRole || null,
          accountKind: values.accountKind,
          bankName: values.bankName || null,
          bankBranch: values.bankBranch || null,
          accountNumber: values.accountNumber || null,
          accountHolder: values.accountHolder || null,
          swiftCode: values.swiftCode || null,
        });
      } else {
        await api.createAccountingAccount({
          code: values.code,
          name: values.name,
          groupId: values.groupId,
          description: values.description,
          subledgerType: values.subledgerType,
          postingRole: values.postingRole || null,
          accountKind: values.accountKind,
          bankName: values.bankName || null,
          bankBranch: values.bankBranch || null,
          accountNumber: values.accountNumber || null,
          accountHolder: values.accountHolder || null,
          swiftCode: values.swiftCode || null,
        });
      }
      setAccountDialog(null);
      onChanged();
    } catch (err: any) {
      setDialogError(err?.message || 'The account could not be saved.');
    } finally {
      setDialogBusy(false);
    }
  };

  const submitGroup = async (values: GroupFormValues) => {
    setDialogBusy(true);
    setDialogError('');
    try {
      if (groupDialog?.mode === 'edit' && groupDialog.group) {
        await api.updateAccountingGroup(groupDialog.group.id, {
          parentId: values.parentId,
          name: values.name,
          sortOrder: Number(values.sortOrder),
        });
      } else {
        await api.createAccountingGroup({
          parentId: values.parentId,
          code: values.code,
          name: values.name,
          accountType: values.accountType,
          statementGroup: values.statementGroup,
          sortOrder: Number(values.sortOrder),
        });
      }
      setGroupDialog(null);
      onChanged();
    } catch (err: any) {
      setDialogError(err?.message || 'The account group could not be saved.');
    } finally {
      setDialogBusy(false);
    }
  };

  const toggleAccount = async (account: AccountingAccount) => {
    setActionError('');
    try {
      await api.updateAccountingAccount(account.id, { isActive: !account.isActive });
      onChanged();
    } catch (err: any) {
      setActionError(err?.message || 'The account could not be updated.');
    }
  };

  const removeAccount = async (account: AccountingAccount) => {
    const ok = await confirmDialog(
      `Delete ${account.code} ${account.name}? This is only allowed for an account with no posting role and no posted entries.`,
      { title: 'Delete ledger account', confirmLabel: 'Delete' }
    );
    if (!ok) return;
    setActionError('');
    try {
      await api.deleteAccountingAccount(account.id);
      onChanged();
    } catch (err: any) {
      setActionError(err?.message || 'The account could not be deleted.');
    }
  };

  const removeGroup = async (group: AccountingGroup) => {
    const ok = await confirmDialog(
      `Delete account group ${group.code} ${group.name}? Only an empty group can be deleted.`,
      { title: 'Delete account group', confirmLabel: 'Delete' }
    );
    if (!ok) return;
    setActionError('');
    try {
      await api.deleteAccountingGroup(group.id);
      onChanged();
    } catch (err: any) {
      setActionError(err?.message || 'The account group could not be deleted.');
    }
  };

  const renderGroup = (group: AccountingGroup, depth: number): React.ReactNode => {
    const accounts = accountsByGroup.get(group.code) ?? [];
    const children = groupsByParent.get(group.id) ?? [];
    // Empty groups stay visible for a maintainer so a new group can be edited
    // or deleted before any account is attached.
    if (accounts.length === 0 && children.length === 0 && !canManage) return null;
    return (
      <React.Fragment key={group.id}>
        <tr className={depth === 0 ? 'bg-slate-100 dark:bg-slate-800/60' : 'bg-slate-50 dark:bg-slate-800/40'}>
          <td colSpan={canManage ? 9 : 8} className="px-2.5 py-1.5">
            <div
              className="flex flex-wrap items-center justify-between gap-2"
              style={{ paddingLeft: depth * 16 }}
            >
              <span className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                {depth > 0 && <span className="text-slate-400">↳</span>}
                <span>
                  {group.code} · {group.name} ({group.accountType})
                </span>
                {group.parentId && (
                  <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                    SUB-GROUP
                  </span>
                )}
              </span>
              {canManage && (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    className={rowAction}
                    aria-label={`Add sub-group under ${group.code}`}
                    disabled={dialogBusy}
                    onClick={() => {
                      setDialogError('');
                      setGroupDialog({ mode: 'create', initialParentId: group.id });
                    }}
                  >
                    <Plus className="h-3 w-3" /> Sub-group
                  </button>
                  <button
                    type="button"
                    className={rowAction}
                    aria-label={`Edit group ${group.code}`}
                    disabled={dialogBusy}
                    onClick={() => {
                      setDialogError('');
                      setGroupDialog({ mode: 'edit', group });
                    }}
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  <button
                    type="button"
                    className={dangerAction}
                    aria-label={`Delete group ${group.code}`}
                    disabled={dialogBusy}
                    onClick={() => void removeGroup(group)}
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                </span>
              )}
            </div>
          </td>
        </tr>
        {accounts.length === 0 && children.length === 0 && (
          <tr>
            <td colSpan={canManage ? 9 : 8} className="px-3 py-2 text-[11px] italic text-slate-400">
              No accounts or sub-groups in this group.
            </td>
          </tr>
        )}
        {accounts.map((account) => (
          <tr key={account.id} className="text-slate-800 dark:text-slate-300">
            <td className="px-2.5 py-1.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-400">{account.code}</td>
            <td className="px-2.5 py-1.5 font-bold" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
              {account.name}
            </td>
            <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{account.accountType}</td>
            <td className="px-2.5 py-1.5">
              {account.accountKind && account.accountKind !== 'OTHER' ? (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                  {account.accountKind}
                </span>
              ) : (
                <span className="text-slate-400">—</span>
              )}
            </td>
            <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{account.statementGroup}</td>
            <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">
              {account.isControl ? account.subledgerType : '—'}
            </td>
            <td className="px-2.5 py-1.5">
              {account.postingRole ? (
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-mono text-[10px] font-bold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                  {account.postingRole}
                </span>
              ) : (
                <span className="text-slate-400">—</span>
              )}
            </td>
            <td className="px-2.5 py-1.5 text-center">
              <span className={`text-[10px] font-bold ${account.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                {account.isActive ? 'ACTIVE' : 'INACTIVE'}
              </span>
            </td>
            {canManage && (
              <td className="px-2.5 py-1.5 text-right">
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    className={rowAction}
                    aria-label={`Edit account ${account.code}`}
                    disabled={dialogBusy}
                    onClick={() => {
                      setDialogError('');
                      setAccountDialog({ mode: 'edit', account });
                    }}
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  <button
                    type="button"
                    className={rowAction}
                    aria-label={`${account.isActive ? 'Deactivate' : 'Activate'} account ${account.code}`}
                    disabled={dialogBusy}
                    onClick={() => void toggleAccount(account)}
                  >
                    <Power className="h-3 w-3" /> {account.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    type="button"
                    className={dangerAction}
                    aria-label={`Delete account ${account.code}`}
                    disabled={dialogBusy}
                    onClick={() => void removeAccount(account)}
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                </span>
              </td>
            )}
          </tr>
        ))}
        {children.map((child) => renderGroup(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="space-y-4">
      {actionError && (
        <div
          role="alert"
          className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
        >
          {actionError}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="ACCOUNT GROUPS" value={String(state.groups.length)} tone="indigo" hint="Top-level and sub-groups" />
        <StatCard label="LEDGER ACCOUNTS" value={String(state.accounts.length)} tone="emerald" hint="Active and retired entries" />
        <StatCard label="POSTING DEFAULTS" value={String(defaultRoles.length)} tone="amber" hint="Roles the posting services rely on" />
        <StatCard
          label="CONTROL ACCOUNTS"
          value={String(state.accounts.filter((account) => account.isControl).length)}
          tone="rose"
          hint="Party and branch subledgers"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <div>
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Chart of accounts</h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Groups can nest to any depth; only ledger accounts receive postings. A posting role marks the account the posting services use by default.
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={toolbarGhost}
                disabled={loading || dialogBusy}
                onClick={() => {
                  setDialogError('');
                  setGroupDialog({ mode: 'create' });
                }}
              >
                <Plus className="h-3 w-3" /> New group
              </button>
              <button
                type="button"
                className={toolbarPrimary}
                disabled={loading || dialogBusy || state.groups.length === 0}
                onClick={() => {
                  setDialogError('');
                  setAccountDialog({ mode: 'create' });
                }}
              >
                <Plus className="h-3 w-3" /> New account
              </button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
              <tr>
                <th className="px-2.5 py-1.5">Code</th>
                <th className="px-2.5 py-1.5">Account</th>
                <th className="px-2.5 py-1.5">Type</th>
                <th className="px-2.5 py-1.5">Kind</th>
                <th className="px-2.5 py-1.5">Statement group</th>
                <th className="px-2.5 py-1.5">Control</th>
                <th className="px-2.5 py-1.5">Posting role</th>
                <th className="px-2.5 py-1.5 text-center">Status</th>
                {canManage && <th className="px-2.5 py-1.5 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
              {state.accounts.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 9 : 8} className="px-3 py-6 text-center text-slate-400">
                    No ledger accounts are configured.
                  </td>
                </tr>
              ) : (
                rootGroups.map((group) => renderGroup(group, 0))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
          <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Posting defaults</h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              The account each posting role resolves to. A missing role makes the posting service refuse the document.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                <tr>
                  <th className="px-2.5 py-1.5">Role</th>
                  <th className="px-2.5 py-1.5">Account</th>
                  <th className="px-2.5 py-1.5">Type</th>
                  <th className="px-2.5 py-1.5">Control</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
                {defaultRoles.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-slate-400">
                      No posting defaults are configured.
                    </td>
                  </tr>
                ) : (
                  defaultRoles.map(([role, account]) => (
                    <tr key={role} className="text-slate-800 dark:text-slate-300">
                      <td className="px-2.5 py-1.5 font-mono text-[11px] font-bold text-indigo-600 dark:text-indigo-400">{role}</td>
                      <td className="px-2.5 py-1.5">
                        <span className="mr-2 font-mono text-[10px] text-slate-400">{account.accountCode}</span>
                        {account.accountName}
                      </td>
                      <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{account.accountType}</td>
                      <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">
                        {account.isControl ? account.subledgerType : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <div>
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Control-account reconciliation</h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Branch scope: {branchId === 'ALL' ? 'all branches' : branchId}.
              </p>
            </div>
            {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-slate-400" />}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300">
                <tr>
                  <th className="px-2.5 py-1.5">Account</th>
                  <th className="px-2.5 py-1.5">Subledger</th>
                  <th className="px-2.5 py-1.5 text-right">GL / subledger</th>
                  <th className="px-2.5 py-1.5 text-right">Difference</th>
                  <th className="px-2.5 py-1.5 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium dark:divide-slate-800/60">
                {state.reconciliations.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-slate-400">
                      No control account is configured.
                    </td>
                  </tr>
                ) : (
                  state.reconciliations.map((reconciliation) => {
                    const error = state.reconciliationErrors[reconciliation.accountId];
                    return (
                      <tr key={reconciliation.accountId} className="text-slate-800 dark:text-slate-300">
                        <td className="px-2.5 py-1.5 font-bold">
                          <span className="mr-2 font-mono text-[10px] text-slate-400">{reconciliation.accountCode}</span>
                          {reconciliation.accountName}
                        </td>
                        <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{reconciliation.subledgerType}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono">
                          {money(reconciliation.glBalance)} / {money(reconciliation.subledgerBalance)}
                        </td>
                        <td className={`px-2.5 py-1.5 text-right font-mono ${Math.abs(reconciliation.difference) >= 0.005 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                          {money(reconciliation.difference)}
                        </td>
                        <td className="px-2.5 py-1.5 text-center">
                          {error ? (
                            <span className="text-[10px] font-bold text-rose-600 dark:text-rose-400">FAILED</span>
                          ) : (
                            <StatusPill
                              ok={reconciliation.status === 'RECONCILED'}
                              okLabel="Reconciled"
                              badLabel="Difference"
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {canManage && accountDialog && (
        <AccountFormDialog
          mode={accountDialog.mode}
          account={accountDialog.account}
          groups={state.groups}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => {
            if (dialogBusy) return;
            setAccountDialog(null);
            setDialogError('');
          }}
          onSubmit={(values) => void submitAccount(values)}
        />
      )}
      {canManage && groupDialog && (
        <GroupFormDialog
          mode={groupDialog.mode}
          group={groupDialog.group}
          initialParentId={groupDialog.initialParentId}
          groups={state.groups}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => {
            if (dialogBusy) return;
            setGroupDialog(null);
            setDialogError('');
          }}
          onSubmit={(values) => void submitGroup(values)}
        />
      )}
    </div>
  );
};
