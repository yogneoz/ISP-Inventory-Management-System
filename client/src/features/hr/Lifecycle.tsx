/**
 * People & HR → Onboarding & Offboarding.
 *
 * One branch-scoped checklist workspace. Offboarding checklists are generated
 * from the employee's assigned fixed assets and linked user account, so those
 * clearances are real records, not free text. Item completion issues/returns an
 * asset or activates/deactivates the linked account server-side; completing the
 * checklist locks every later write.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  ClipboardList,
  KeyRound,
  PackageCheck,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type {
  EmployeeRecord,
  HrLifecycleCategory,
  HrLifecycleChecklistDetail,
  HrLifecycleChecklistRecord,
  HrLifecycleStatus,
  HrLifecycleType,
} from '../../services/api';
import type { User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';

interface LifecycleProps {
  user: User | null;
  branchId?: string;
}

interface ChecklistForm {
  employeeId: string;
  type: HrLifecycleType;
  effectiveDateAD: string;
  notes: string;
  status: Exclude<HrLifecycleStatus, 'COMPLETED'>;
}

interface ItemForm {
  category: Exclude<HrLifecycleCategory, 'ACCOUNT'>;
  title: string;
  description: string;
  required: boolean;
  assetId: string;
}

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 text-xs text-slate-800 dark:border-slate-700 dark:text-slate-100';
const labelClass = 'mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const primaryButton =
  'flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60';
const secondaryButton =
  'cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60';
const tableHead =
  'border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800';
const tableRow = 'border-b border-slate-100 last:border-0 dark:border-slate-800';

const statusTone: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  OPEN: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  COMPLETED: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  inactive: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  suspended: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  locked: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
};

const label = (value: string): string =>
  value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const today = (): string => new Date().toISOString().slice(0, 10);

const StatusPill: React.FC<{ status: string }> = ({ status }) => (
  <span
    className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
      statusTone[status] || statusTone.DRAFT
    }`}
  >
    {label(status)}
  </span>
);

const SummaryCard: React.FC<{
  labelText: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  testId: string;
}> = ({ labelText, value, hint, icon, testId }) => (
  <div className={`${panel} flex items-start justify-between gap-3`}>
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {labelText}
      </p>
      <p data-testid={testId} className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
        {value}
      </p>
      <p className="mt-0.5 text-[10px] text-slate-400">{hint}</p>
    </div>
    <span className="rounded-xl bg-slate-100 p-2 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
      {icon}
    </span>
  </div>
);

const EmptyRow: React.FC<{ colSpan: number; message: string; testId: string }> = ({
  colSpan,
  message,
  testId,
}) => (
  <tr>
    <td colSpan={colSpan} className="px-2 py-8 text-center text-xs text-slate-400" data-testid={testId}>
      {message}
    </td>
  </tr>
);

const emptyChecklistForm = (employeeId = ''): ChecklistForm => ({
  employeeId,
  type: 'ONBOARDING',
  effectiveDateAD: today(),
  notes: '',
  status: 'DRAFT',
});

const emptyItemForm = (): ItemForm => ({
  category: 'OTHER',
  title: '',
  description: '',
  required: true,
  assetId: '',
});

const actionLabel = (action: string): string => {
  if (action === 'ISSUE_ASSET') return 'Issue asset';
  if (action === 'RETURN_ASSET') return 'Return asset';
  if (action === 'ACTIVATE_ACCOUNT') return 'Activate account';
  if (action === 'DEACTIVATE_ACCOUNT') return 'Deactivate account';
  return 'Checklist';
};

export const Lifecycle: React.FC<LifecycleProps> = ({
  user,
  branchId,
}) => {
  const activationKey = useActivationKey('hr-lifecycle');
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canView =
    isOperationAllowed('hr-employee-view', user?.role) ||
    isOperationAllowed('gl-payroll-manage', user?.role);
  const canManage =
    isOperationAllowed('hr-employee-manage', user?.role) ||
    isOperationAllowed('gl-payroll-manage', user?.role);
  const branchScope = branchId && branchId !== 'ALL' ? branchId : undefined;

  const [checklists, setChecklists] = useState<HrLifecycleChecklistRecord[]>([]);
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [detail, setDetail] = useState<HrLifecycleChecklistDetail | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);

  const [checklistModalOpen, setChecklistModalOpen] = useState(false);
  const [editingChecklist, setEditingChecklist] = useState<HrLifecycleChecklistRecord | null>(null);
  const [checklistForm, setChecklistForm] = useState<ChecklistForm>(() =>
    emptyChecklistForm()
  );

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [itemForm, setItemForm] = useState<ItemForm>(emptyItemForm);

  const loadList = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const [rows, employeeRows] = await Promise.all([
        api.getHrLifecycleChecklists({ branchId: branchScope }),
        api.getEmployees({ branchId: branchScope, limit: 1000 }),
      ]);
      setChecklists(rows);
      setEmployees(employeeRows);
      setSelectedId((current) => {
        if (current && rows.some((row) => row.id === current)) return current;
        return rows[0]?.id || '';
      });
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load lifecycle checklists.');
    } finally {
      setLoading(false);
    }
  }, [branchScope, canView]);

  const loadDetail = useCallback(async () => {
    if (!canView || !selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    try {
      setDetail(await api.getHrLifecycleChecklist(selectedId));
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load the selected checklist.');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [canView, selectedId]);

  useEffect(() => {
    void loadList();
  }, [activationKey, loadList]);

  useEffect(() => {
    void loadDetail();
  }, [activationKey, loadDetail]);

  const refresh = async () => {
    await loadList();
    await loadDetail();
  };

  const openChecklistModal = (checklist?: HrLifecycleChecklistRecord) => {
    setEditingChecklist(checklist || null);
    setChecklistForm(
      checklist
        ? {
            employeeId: checklist.employeeId,
            type: checklist.checklistType,
            effectiveDateAD: checklist.effectiveDateAD,
            notes: checklist.notes || '',
            status: checklist.status === 'OPEN' ? 'OPEN' : 'DRAFT',
          }
        : emptyChecklistForm(employees[0]?.id || '')
    );
    setChecklistModalOpen(true);
  };

  const saveChecklist = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!checklistForm.employeeId) {
      await alertDialog('Choose an employee for the checklist.');
      return;
    }
    setSaving(true);
    try {
      if (editingChecklist) {
        await api.updateHrLifecycleChecklist(editingChecklist.id, {
          status: checklistForm.status,
          effectiveDateAD: checklistForm.effectiveDateAD,
          notes: checklistForm.notes.trim() || null,
        });
        setChecklistModalOpen(false);
        await refresh();
      } else {
        const created = await api.createHrLifecycleChecklist({
          employeeId: checklistForm.employeeId,
          type: checklistForm.type,
          effectiveDateAD: checklistForm.effectiveDateAD,
          notes: checklistForm.notes.trim() || null,
        });
        setChecklistModalOpen(false);
        setSelectedId(created.id);
        await loadList();
      }
    } catch (err: any) {
      await alertDialog(`Could not save the checklist: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  const openChecklist = async (checklist: HrLifecycleChecklistRecord) => {
    setSaving(true);
    try {
      await api.updateHrLifecycleChecklist(checklist.id, { status: 'OPEN' });
      await refresh();
    } catch (err: any) {
      await alertDialog(`Could not open the checklist: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  const completeChecklist = async (checklist: HrLifecycleChecklistRecord) => {
    const confirmed = await confirmDialog(
      `Complete the ${checklist.checklistType.toLowerCase()} checklist for ${checklist.employeeName}? Every item becomes read-only.`,
      { title: 'Complete lifecycle checklist', confirmLabel: 'Complete checklist' }
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      await api.completeHrLifecycleChecklist(checklist.id);
      await refresh();
    } catch (err: any) {
      await alertDialog(`Could not complete the checklist: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  const openItemModal = () => {
    setItemForm(emptyItemForm());
    setItemModalOpen(true);
  };

  const saveItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    if (!itemForm.title.trim()) {
      await alertDialog('Enter an item title.');
      return;
    }
    if (itemForm.category === 'ASSET' && !itemForm.assetId) {
      await alertDialog('Choose a fixed asset for this item.');
      return;
    }
    setSaving(true);
    try {
      await api.addHrLifecycleChecklistItem(detail.id, {
        category: itemForm.category,
        title: itemForm.title.trim(),
        description: itemForm.description.trim() || null,
        required: itemForm.required,
        assetId: itemForm.category === 'ASSET' ? itemForm.assetId : null,
      });
      setItemModalOpen(false);
      await refresh();
    } catch (err: any) {
      await alertDialog(`Could not add the item: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  const completeItem = async (item: HrLifecycleChecklistDetail['items'][number]) => {
    if (!detail) return;
    const target = item.assetTagNumber
      ? `${item.assetTagNumber} — ${item.assetName || 'assigned asset'}`
      : detail.accountEmail || detail.employeeName;
    const actionText =
      item.action === 'ISSUE_ASSET'
        ? `Issue ${target} to ${detail.employeeName}? The asset becomes assigned to this employee.`
        : item.action === 'RETURN_ASSET'
          ? `Mark ${target} returned? The asset becomes active and unassigned.`
          : item.action === 'ACTIVATE_ACCOUNT'
            ? `Activate ${target}? The linked account becomes usable for sign-in.`
            : item.action === 'DEACTIVATE_ACCOUNT'
              ? `Deactivate ${target}? The linked account can no longer sign in.`
              : `Mark “${item.title}” complete?`;
    const confirmed = await confirmDialog(actionText, {
      title: 'Complete checklist item',
      confirmLabel: 'Complete item',
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await api.completeHrLifecycleChecklistItem(detail.id, item.id);
      await refresh();
    } catch (err: any) {
      await alertDialog(`Could not complete the item: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  if (!canView) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Onboarding & Offboarding"
          description="Lifecycle checklists for assets and user accounts."
          icon={<ClipboardList className="h-5 w-5 text-indigo-500" />}
        />
        <div className={panel} data-testid="lifecycle-no-access">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Lifecycle checklists are available to accounts with the HR employee-view or payroll permission.
          </p>
        </div>
      </div>
    );
  }

  const activeChecklists = checklists.filter((row) => row.status !== 'COMPLETED');
  const pendingRequired = checklists.reduce((sum, row) => sum + row.requiredPendingCount, 0);
  const completed = checklists.filter((row) => row.status === 'COMPLETED').length;
  const onboarding = activeChecklists.filter((row) => row.checklistType === 'ONBOARDING').length;
  const offboarding = activeChecklists.filter((row) => row.checklistType === 'OFFBOARDING').length;
  const availableAssets = detail?.availableAssets || [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Onboarding & Offboarding"
        description="Branch-scoped lifecycle checklists tied to fixed assets and user accounts. Completion locks the checklist."
        icon={<ClipboardCheck className="h-5 w-5 text-indigo-500" />}
        actions={
          <>
            <button
              type="button"
              onClick={() => void refresh()}
              className={secondaryButton}
              disabled={loading || detailLoading}
              data-testid="lifecycle-refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {canManage && (
              <button
                type="button"
                onClick={() => openChecklistModal()}
                className={primaryButton}
                data-testid="lifecycle-new"
              >
                <Plus className="h-3.5 w-3.5" />
                New checklist
              </button>
            )}
          </>
        }
      />

      {loadError && (
        <div
          className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
          data-testid="lifecycle-load-error"
        >
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          labelText="Active checklists"
          value={String(activeChecklists.length)}
          hint={`${checklists.length} total in scope`}
          icon={<ClipboardList className="h-4 w-4" />}
          testId="lifecycle-summary-active"
        />
        <SummaryCard
          labelText="Onboarding"
          value={String(onboarding)}
          hint={`${offboarding} offboarding active`}
          icon={<UserPlus className="h-4 w-4" />}
          testId="lifecycle-summary-onboarding"
        />
        <SummaryCard
          labelText="Pending required"
          value={String(pendingRequired)}
          hint={`${completed} checklist${completed === 1 ? '' : 's'} completed`}
          icon={<ClipboardCheck className="h-4 w-4" />}
          testId="lifecycle-summary-pending"
        />
        <SummaryCard
          labelText="Asset clearances"
          value={String(checklists.reduce((sum, row) => sum + row.pendingAssetCount, 0))}
          hint="Pending asset returns or issues"
          icon={<Boxes className="h-4 w-4" />}
          testId="lifecycle-summary-assets"
        />
      </div>

      <section className={panel} aria-label="Lifecycle checklists">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Lifecycle checklists</h3>
            <p className="mt-0.5 text-[10px] text-slate-400">
              Select a checklist to work its asset, account and document items.
            </p>
          </div>
          <span className="text-[10px] text-slate-400">{checklists.length} total</span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead>
              <tr className={tableHead}>
                <th className="px-1 py-2 font-semibold">Checklist</th>
                <th className="px-1 py-2 font-semibold">Employee</th>
                <th className="px-1 py-2 font-semibold">Type</th>
                <th className="px-1 py-2 font-semibold">Effective</th>
                <th className="px-1 py-2 font-semibold">Status</th>
                <th className="px-1 py-2 font-semibold">Progress</th>
                <th className="px-1 py-2 font-semibold">Account</th>
                <th className="px-1 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {checklists.length === 0 ? (
                <EmptyRow
                  colSpan={8}
                  message="No onboarding or offboarding checklists in this branch scope yet."
                  testId="lifecycle-empty-checklists"
                />
              ) : (
                checklists.map((checklist) => (
                  <tr
                    key={checklist.id}
                    className={`${tableRow} ${
                      selectedId === checklist.id ? 'bg-indigo-50/50 dark:bg-indigo-950/20' : ''
                    }`}
                  >
                    <td className="px-1 py-2">
                      <button
                        type="button"
                        onClick={() => setSelectedId(checklist.id)}
                        className="text-left font-medium text-slate-700 hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-400"
                      >
                        {label(checklist.checklistType)} · {checklist.checklistNo}
                      </button>
                      <p className="text-[10px] text-slate-400">{checklist.branchName}</p>
                    </td>
                    <td className="px-1 py-2">
                      <p className="font-medium text-slate-700 dark:text-slate-200">{checklist.employeeName}</p>
                      <p className="text-[10px] text-slate-400">{checklist.employeeCode}</p>
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {label(checklist.checklistType)}
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {checklist.effectiveDateAD}
                    </td>
                    <td className="px-1 py-2">
                      <StatusPill status={checklist.status} />
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {checklist.doneCount}/{checklist.itemCount}
                    </td>
                    <td className="px-1 py-2">
                      {checklist.accountStatus ? (
                        <StatusPill status={checklist.accountStatus} />
                      ) : (
                        <span className="text-[10px] text-slate-400">Not linked</span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedId(checklist.id)}
                        className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {detailLoading ? (
        <div className={`${panel} text-xs text-slate-400`} data-testid="lifecycle-detail-loading">
          Loading checklist…
        </div>
      ) : detail ? (
        <>
          <section className={panel}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Selected checklist
                </p>
                <h3 className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {label(detail.checklistType)} · {detail.employeeName}
                </h3>
                <p className="mt-0.5 text-[10px] text-slate-400">
                  {detail.employeeCode} · {detail.branchName} · effective {detail.effectiveDateAD}
                  {detail.completedBy ? ` · completed by ${detail.completedBy}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={detail.status} />
                {canManage && detail.status === 'DRAFT' && (
                  <button
                    type="button"
                    onClick={() => void openChecklist(detail)}
                    className={secondaryButton}
                    disabled={saving}
                    data-testid="lifecycle-open"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Open checklist
                  </button>
                )}
                {canManage && detail.status === 'OPEN' && (
                  <button
                    type="button"
                    onClick={() => void completeChecklist(detail)}
                    className={secondaryButton}
                    disabled={saving}
                    data-testid="lifecycle-complete"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Complete checklist
                  </button>
                )}
                {canManage && detail.status !== 'COMPLETED' && (
                  <>
                    <button
                      type="button"
                      onClick={() => openItemModal()}
                      className={secondaryButton}
                      data-testid="lifecycle-add-item"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add item
                    </button>
                    <button
                      type="button"
                      onClick={() => openChecklistModal(detail)}
                      className={secondaryButton}
                    >
                      Edit
                    </button>
                  </>
                )}
              </div>
            </div>
            {detail.notes && (
              <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
                {detail.notes}
              </p>
            )}
            {detail.status === 'COMPLETED' && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[11px] text-indigo-700 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-300">
                <ShieldCheck className="h-3.5 w-3.5" />
                This checklist is completed. Items and account/asset actions are locked and read-only.
              </div>
            )}
            {detail.status === 'DRAFT' && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                Open the checklist before completing items.
              </div>
            )}
            {detail.checklistType === 'OFFBOARDING' &&
              detail.custody &&
              detail.custody.units > 0 &&
              detail.status !== 'COMPLETED' && (
                <div
                  className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
                  data-testid="lifecycle-custody-block"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {detail.custody.units} unit{detail.custody.units === 1 ? '' : 's'} across{' '}
                    {detail.custody.items} product{detail.custody.items === 1 ? '' : 's'} are still issued.
                    Completing offboarding is refused until they are returned from My Stock or the
                    employee profile.
                  </span>
                </div>
              )}
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <section className={panel} aria-label="Checklist items">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Checklist items</h3>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    Asset and account actions reconcile the linked record when completed.
                  </p>
                </div>
                <span className="text-[10px] text-slate-400">
                  {detail.doneCount}/{detail.itemCount} done
                </span>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead>
                    <tr className={tableHead}>
                      <th className="px-1 py-2 font-semibold">Item</th>
                      <th className="px-1 py-2 font-semibold">Category</th>
                      <th className="px-1 py-2 font-semibold">Action</th>
                      <th className="px-1 py-2 font-semibold">Status</th>
                      <th className="px-1 py-2 font-semibold" />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.checklistType === 'OFFBOARDING' && detail.custody ? (
                      <tr className={tableRow} data-testid="lifecycle-custody-item">
                        <td className="px-1 py-2">
                          <p className="font-medium text-slate-700 dark:text-slate-200">
                            Return issued stock equipment
                          </p>
                          <p className="text-[10px] text-slate-400">
                            {detail.custody.units === 0
                              ? 'Nothing is issued to this employee.'
                              : detail.custody.products
                                  .map((row) => `${row.product_name} × ${row.quantity}`)
                                  .join(', ')}
                          </p>
                          <p className="text-[10px] text-slate-400">
                            Derived from the custody ledger; return it from My Stock or the employee
                            profile. This item cannot be checked off by hand.
                          </p>
                        </td>
                        <td className="px-1 py-2 text-slate-600 dark:text-slate-300">Other</td>
                        <td className="px-1 py-2 text-slate-600 dark:text-slate-300">Custody ledger</td>
                        <td className="px-1 py-2">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              detail.custody.units === 0
                                ? statusTone.OPEN
                                : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                            }`}
                          >
                            {detail.custody.units === 0 ? (
                              <CheckCircle2 className="h-3 w-3" />
                            ) : (
                              <Circle className="h-3 w-3" />
                            )}
                            {detail.custody.units === 0 ? 'Satisfied' : 'Outstanding'}
                          </span>
                        </td>
                        <td className="px-1 py-2 text-right text-[10px] text-slate-400">
                          {detail.custody.units === 0 ? '' : 'Return in My Stock'}
                        </td>
                      </tr>
                    ) : null}
                    {detail.items.length === 0 ? (
                      <EmptyRow
                        colSpan={5}
                        message="No checklist items yet. Add a document, access, asset or other item."
                        testId="lifecycle-empty-items"
                      />
                    ) : (
                      detail.items.map((item) => (
                        <tr key={item.id} className={tableRow}>
                          <td className="px-1 py-2">
                            <p className="font-medium text-slate-700 dark:text-slate-200">{item.title}</p>
                            {item.assetTagNumber && (
                              <p className="text-[10px] text-slate-400">
                                {item.assetTagNumber} · {item.assetName} · {item.assetStatus}
                              </p>
                            )}
                            {item.description && (
                              <p className="text-[10px] text-slate-400">{item.description}</p>
                            )}
                          </td>
                          <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                            {label(item.category)}
                          </td>
                          <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                            {actionLabel(item.action)}
                          </td>
                          <td className="px-1 py-2">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                item.status === 'DONE'
                                  ? statusTone.OPEN
                                  : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                              }`}
                            >
                              {item.status === 'DONE' ? (
                                <CheckCircle2 className="h-3 w-3" />
                              ) : (
                                <Circle className="h-3 w-3" />
                              )}
                              {label(item.status)}
                            </span>
                          </td>
                          <td className="px-1 py-2 text-right">
                            {canManage && detail.status === 'OPEN' && item.status === 'PENDING' && (
                              <button
                                type="button"
                                onClick={() => void completeItem(item)}
                                className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-60 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                                disabled={saving}
                              >
                                Complete
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="space-y-4">
              <section className={panel} aria-label="Linked user account">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-slate-400" />
                  <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">User account</h3>
                </div>
                {detail.account ? (
                  <div className="mt-3 space-y-1 text-xs">
                    <p className="font-medium text-slate-700 dark:text-slate-200">
                      {detail.account.name || detail.account.email}
                    </p>
                    <p className="text-[10px] text-slate-400">{detail.account.email}</p>
                    <p className="flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                      <StatusPill status={String(detail.account.status || 'unknown')} />
                      {detail.account.role}
                    </p>
                    {detail.account.status === 'active' && detail.checklistType === 'ONBOARDING' && (
                      <p className="pt-1 text-[10px] text-slate-400">
                        Activation is already satisfied for this account.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-[11px] text-slate-400">
                    No user account is linked to this employee. Account activation/deactivation is not generated.
                  </p>
                )}
              </section>

              <section className={panel} aria-label="Asset custody">
                <div className="flex items-center gap-2">
                  <PackageCheck className="h-4 w-4 text-slate-400" />
                  <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Asset custody</h3>
                </div>
                <p className="mt-2 text-[10px] text-slate-400">
                  {detail.assetCount} asset item{detail.assetCount === 1 ? '' : 's'} ·{' '}
                  {detail.pendingAssetCount} pending
                </p>
                {availableAssets.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-[10px] text-slate-500 dark:text-slate-400">
                    {availableAssets.slice(0, 6).map((asset) => (
                      <li key={asset.id} className="truncate">
                        {asset.tagNumber} · {asset.name}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[10px] text-slate-400">
                    {detail.checklistType === 'OFFBOARDING'
                      ? 'No more assigned assets are available to add.'
                      : 'No active, unassigned assets are available to issue.'}
                  </p>
                )}
              </section>
            </div>
          </div>
        </>
      ) : (
        <div className={panel} data-testid="lifecycle-empty-selection">
          <p className="text-xs text-slate-400">Select a checklist to see its items and linked account.</p>
        </div>
      )}

      {checklistModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={editingChecklist ? 'Edit lifecycle checklist' : 'New lifecycle checklist'}
            onClose={() => setChecklistModalOpen(false)}
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">
                  {editingChecklist ? 'Edit lifecycle checklist' : 'New lifecycle checklist'}
                </h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  The checklist inherits the employee's branch. Offboarding generates every assigned asset and the linked account.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setChecklistModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={saveChecklist} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Type *</label>
                  <select
                    value={checklistForm.type}
                    onChange={(event) =>
                      setChecklistForm({ ...checklistForm, type: event.target.value as HrLifecycleType })
                    }
                    disabled={Boolean(editingChecklist)}
                    className={inputClass}
                  >
                    <option value="ONBOARDING">Onboarding</option>
                    <option value="OFFBOARDING">Offboarding</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Effective date *</label>
                  <input
                    type="date"
                    value={checklistForm.effectiveDateAD}
                    onChange={(event) =>
                      setChecklistForm({ ...checklistForm, effectiveDateAD: event.target.value })
                    }
                    className={inputClass}
                    required
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Employee *</label>
                <select
                  value={checklistForm.employeeId}
                  onChange={(event) =>
                    setChecklistForm({ ...checklistForm, employeeId: event.target.value })
                  }
                  disabled={Boolean(editingChecklist)}
                  className={inputClass}
                  required
                >
                  <option value="">Choose an employee</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.employeeCode} · {employee.name}
                    </option>
                  ))}
                </select>
              </div>
              {editingChecklist && (
                <div>
                  <label className={labelClass}>Status</label>
                  <select
                    value={checklistForm.status}
                    onChange={(event) =>
                      setChecklistForm({
                        ...checklistForm,
                        status: event.target.value as Exclude<HrLifecycleStatus, 'COMPLETED'>,
                      })
                    }
                    disabled={editingChecklist.status === 'OPEN'}
                    className={inputClass}
                  >
                    {editingChecklist.status === 'DRAFT' && <option value="DRAFT">Draft</option>}
                    <option value="OPEN">Open</option>
                  </select>
                </div>
              )}
              <div>
                <label className={labelClass}>Notes</label>
                <textarea
                  value={checklistForm.notes}
                  onChange={(event) => setChecklistForm({ ...checklistForm, notes: event.target.value })}
                  className="min-h-20 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={2000}
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button type="button" onClick={() => setChecklistModalOpen(false)} className={secondaryButton}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryButton}>
                  {saving ? 'Saving…' : editingChecklist ? 'Save changes' : 'Create checklist'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {itemModalOpen && detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label="New checklist item"
            onClose={() => setItemModalOpen(false)}
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">New checklist item</h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  {detail.employeeName} · {label(detail.checklistType)}. Account items are generated automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setItemModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={saveItem} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Category</label>
                  <select
                    value={itemForm.category}
                    onChange={(event) => {
                      const category = event.target.value as Exclude<HrLifecycleCategory, 'ACCOUNT'>;
                      setItemForm({ ...itemForm, category, assetId: category === 'ASSET' ? itemForm.assetId : '' });
                    }}
                    className={inputClass}
                  >
                    <option value="OTHER">Other</option>
                    <option value="DOCUMENT">Document</option>
                    <option value="ACCESS">Access</option>
                    <option value="ASSET">Asset</option>
                  </select>
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={itemForm.required}
                      onChange={(event) => setItemForm({ ...itemForm, required: event.target.checked })}
                    />
                    Required before completion
                  </label>
                </div>
              </div>
              <div>
                <label className={labelClass}>Title *</label>
                <input
                  value={itemForm.title}
                  onChange={(event) => setItemForm({ ...itemForm, title: event.target.value })}
                  className={inputClass}
                  maxLength={200}
                  required
                />
              </div>
              {itemForm.category === 'ASSET' && (
                <div>
                  <label className={labelClass}>Fixed asset *</label>
                  <select
                    value={itemForm.assetId}
                    onChange={(event) => setItemForm({ ...itemForm, assetId: event.target.value })}
                    className={inputClass}
                    required
                  >
                    <option value="">Choose an eligible asset</option>
                    {availableAssets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.tagNumber} · {asset.name} ({asset.status})
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[10px] text-slate-400">
                    {detail.checklistType === 'ONBOARDING'
                      ? 'Only active, unassigned assets in this branch can be issued.'
                      : 'Only assets currently assigned to this employee can be returned.'}
                  </p>
                </div>
              )}
              <div>
                <label className={labelClass}>Description</label>
                <textarea
                  value={itemForm.description}
                  onChange={(event) => setItemForm({ ...itemForm, description: event.target.value })}
                  className="min-h-16 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={1000}
                />
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2 text-[10px] text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
                {itemForm.category === 'ASSET'
                  ? detail.checklistType === 'ONBOARDING'
                    ? 'Completing this item assigns the asset to the employee and records the assignment date.'
                    : 'Completing this item returns the asset to active, unassigned custody.'
                  : 'This is a procedural item; completing it records who cleared it and when.'}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button type="button" onClick={() => setItemModalOpen(false)} className={secondaryButton}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryButton}>
                  {saving ? 'Saving…' : 'Add item'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default Lifecycle;
