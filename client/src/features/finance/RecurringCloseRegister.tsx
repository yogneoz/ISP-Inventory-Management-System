/**
 * Recurring journals and month-end close — one Finance register, two views.
 *
 * The template tab is a scheduling surface, not a second journal form: saving a
 * template never posts, and "Run due" calls the normal balanced-journal path
 * only when the preview is balanced and the period is open. The close tab reads
 * and writes the persisted per-period checklist; the period-close call carries
 * the same override reason the API requires when required tasks are open.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { btnGhost, btnPrimary, inputClass, labelClass } from '../../components/common/styleConstants';
import { api, getActiveBranchId } from '../../services/api';
import type { AccountingAccount } from '../../services/api/accounting';
import type {
  AccountingPeriod,
  CloseChecklist,
  CloseTaskStatus,
  RecurringFrequency,
  RecurringLineInput,
  RecurringPreview,
  RecurringRunResult,
  RecurringTemplate,
} from '../../services/api/recurringClose';
import type { Branch, User } from '../../types';
import { localTodayAD } from '../../utils/localDate';
import { formatMoney } from '../../utils/nprFormat';
import { getScopedBranches, isOperationAllowed } from '../../utils/permissions';

type Tab = 'templates' | 'close';
type FormLine = {
  key: string;
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amountFormula: string;
  memo: string;
  partyId: string;
  partyName: string;
};

type TemplateForm = {
  id: string | null;
  code: string;
  name: string;
  description: string;
  branchId: string;
  frequency: RecurringFrequency;
  startDateAD: string;
  endDateAD: string;
  active: boolean;
  lines: FormLine[];
};

let formLineSequence = 0;
function blankLine(side: 'DEBIT' | 'CREDIT' = 'DEBIT'): FormLine {
  formLineSequence += 1;
  return {
    key: `recurring-line-${formLineSequence}`,
    accountId: '',
    side,
    amountFormula: '',
    memo: '',
    partyId: '',
    partyName: '',
  };
}

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const noticeBox =
  'flex items-start gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300';
const warningBox =
  'flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200';
const cellInput =
  'w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-[#0f1218] dark:text-white';

const CLOSE_STATUSES: CloseTaskStatus[] = ['PENDING', 'IN_PROGRESS', 'DONE', 'NOT_APPLICABLE'];

export interface RecurringCloseRegisterProps {
  branches: Branch[];
  currentUser?: User | null;
}

export const RecurringCloseRegister: React.FC<RecurringCloseRegisterProps> = ({
  branches,
  currentUser,
}) => {
  const activationKey = useActivationKey('recurring-close');
  const canPost = isOperationAllowed('gl-post', currentUser?.role);
  const canClose = isOperationAllowed('gl-close', currentUser?.role);
  const scopedBranches = useMemo(
    () => getScopedBranches(currentUser, branches).filter((branch) => branch.active),
    [branches, currentUser]
  );
  const initialBranch = () => {
    const active = getActiveBranchId();
    if (active && active !== 'ALL' && scopedBranches.some((branch) => branch.id === active)) {
      return active;
    }
    return scopedBranches.find((branch) => branch.id !== 'ALL')?.id || '';
  };

  const [tab, setTab] = useState<Tab>('templates');
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState('');
  const [checklist, setChecklist] = useState<CloseChecklist | null>(null);
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [preview, setPreview] = useState<RecurringPreview | null>(null);
  const [runResult, setRunResult] = useState<RecurringRunResult | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await api.getRecurringTemplates());
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Recurring templates could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts((await api.getAccountingAccounts()).filter((account) => account.isActive));
    } catch (err: any) {
      setError(err?.message || 'The ledger picker could not be loaded.');
    }
  }, []);

  const loadPeriods = useCallback(async () => {
    try {
      const rows = await api.getAccountingPeriods();
      setPeriods(rows);
      setSelectedPeriodId((current) =>
        current && rows.some((period) => period.id === current)
          ? current
          : rows.find((period) => period.status === 'OPEN')?.id || rows[0]?.id || ''
      );
    } catch (err: any) {
      setError(err?.message || 'Accounting periods could not be loaded.');
    }
  }, []);

  const loadChecklist = useCallback(async (periodId: string) => {
    if (!periodId) {
      setChecklist(null);
      return;
    }
    setChecklistLoading(true);
    try {
      setChecklist(await api.getCloseChecklist(periodId));
      setError('');
    } catch (err: any) {
      setError(err?.message || 'The close checklist could not be loaded.');
      setChecklist(null);
    } finally {
      setChecklistLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
    void loadAccounts();
    // activationKey makes a reactivated tab refetch; it is intentionally not a
    // data argument, so the rule cannot be satisfied by an unrelated state key.
  }, [activationKey, loadAccounts, loadTemplates]);

  useEffect(() => {
    if (tab === 'close') void loadPeriods();
  }, [tab, activationKey, loadPeriods]);

  useEffect(() => {
    if (tab === 'close') void loadChecklist(selectedPeriodId);
  }, [tab, selectedPeriodId, loadChecklist]);

  const selectedPeriod = periods.find((period) => period.id === selectedPeriodId) || null;

  function startNew() {
    const start = localTodayAD();
    setForm({
      id: null,
      code: '',
      name: '',
      description: '',
      branchId: initialBranch(),
      frequency: 'MONTHLY',
      startDateAD: start,
      endDateAD: '',
      active: true,
      lines: [blankLine('DEBIT'), blankLine('CREDIT')],
    });
    setPreview(null);
    setRunResult(null);
    setError('');
    setNotice('');
  }

  async function editTemplate(id: string) {
    setError('');
    setPreview(null);
    try {
      const detail = await api.getRecurringTemplate(id);
      setForm({
        id: detail.id,
        code: detail.code,
        name: detail.name,
        description: detail.description || '',
        branchId: detail.branchId,
        frequency: detail.frequency,
        startDateAD: detail.startDateAD,
        endDateAD: detail.endDateAD || '',
        active: detail.active,
        lines: (detail.lines || []).map((line) => ({
          key: line.id || `recurring-line-${line.lineNo}`,
          accountId: line.accountId,
          side: line.side,
          amountFormula: line.amountFormula,
          memo: line.memo || '',
          partyId: line.partyId || '',
          partyName: line.partyName || '',
        })),
      });
    } catch (err: any) {
      setError(err?.message || 'The recurring template could not be opened.');
    }
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setForm((current) =>
      current
        ? { ...current, lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) }
        : current
    );
    setPreview(null);
  }

  function updateForm(patch: Partial<TemplateForm>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setPreview(null);
  }

  function payloadLines(): RecurringLineInput[] {
    return (form?.lines || []).map((line) => ({
      accountId: line.accountId,
      side: line.side,
      amountFormula: line.amountFormula,
      memo: line.memo || null,
      partyId: line.partyId || null,
      partyName: line.partyName || null,
    }));
  }

  async function saveTemplate() {
    if (!form) return;
    if (!form.name.trim()) {
      setError('Template name is required.');
      return;
    }
    if (!form.branchId) {
      setError('Choose a branch for the template.');
      return;
    }
    if (form.lines.length < 2 || form.lines.some((line) => !line.accountId || !line.amountFormula.trim())) {
      setError('The template needs at least two lines, each with an account and amount formula.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const input = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        frequency: form.frequency,
        startDateAD: form.startDateAD,
        endDateAD: form.endDateAD || null,
        active: form.active,
        lines: payloadLines(),
      };
      const saved = form.id
        ? await api.updateRecurringTemplate(form.id, input)
        : await api.createRecurringTemplate({ ...input, code: form.code.trim().toUpperCase(), branchId: form.branchId });
      setForm({ ...form, id: saved.id, code: saved.code });
      setNotice(form.id ? 'Template saved.' : 'Template created. Preview it before the first run.');
      await loadTemplates();
    } catch (err: any) {
      setError(err?.message || 'The recurring template could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function previewTemplate() {
    if (!form?.id) {
      setError('Save the template first, then preview it.');
      return;
    }
    setError('');
    try {
      setPreview(await api.previewRecurringTemplate(form.id));
    } catch (err: any) {
      setError(err?.message || 'The template preview failed.');
    }
  }

  async function runDue(template: RecurringTemplate) {
    setError('');
    setNotice('');
    try {
      const result = await api.runRecurringTemplate(template.id);
      setRunResult(result);
      if (result.status === 'GENERATED') {
        setNotice(`Posted ${result.journal?.journalNo || 'journal'} for ${result.runDate}.`);
      } else if (result.status === 'ALREADY_GENERATED') {
        setNotice(`Already generated for ${result.runDate}: ${result.journal?.journalNo || 'existing journal'}.`);
      } else {
        setNotice(`Skipped ${result.runDate}: ${result.reason === 'PERIOD_CLOSED' ? 'the period is closed.' : result.reason || 'not runnable.'}`);
      }
      await loadTemplates();
    } catch (err: any) {
      setError(err?.message || 'The recurring journal could not be generated.');
    }
  }

  async function toggleTemplate(template: RecurringTemplate) {
    setError('');
    try {
      await api.updateRecurringTemplate(template.id, { active: !template.active });
      setNotice(template.active ? 'Template paused.' : 'Template resumed.');
      await loadTemplates();
    } catch (err: any) {
      setError(err?.message || 'The template status could not be changed.');
    }
  }

  async function removeTemplate(template: RecurringTemplate) {
    if (!window.confirm(`Delete recurring template ${template.code}?`)) return;
    setError('');
    try {
      await api.deleteRecurringTemplate(template.id);
      if (form?.id === template.id) setForm(null);
      setNotice('Template deleted.');
      await loadTemplates();
    } catch (err: any) {
      setError(err?.message || 'The template could not be deleted.');
    }
  }

  function patchTask(id: string, patch: Partial<CloseChecklist['tasks'][number]>) {
    setChecklist((current) =>
      current
        ? { ...current, tasks: current.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)) }
        : current
    );
  }

  async function saveTask(task: CloseChecklist['tasks'][number]) {
    if (!selectedPeriodId) return;
    setError('');
    try {
      await api.updateCloseChecklistItem(selectedPeriodId, task.id, {
        status: task.status,
        owner: task.owner || null,
        note: task.note || null,
        evidenceUrl: task.evidenceUrl || null,
      });
      setNotice(`${task.title} saved.`);
      await loadChecklist(selectedPeriodId);
    } catch (err: any) {
      setError(err?.message || 'The checklist task could not be saved.');
    }
  }

  async function closePeriod() {
    if (!selectedPeriodId || !checklist) return;
    if (checklist.summary.requiredIncomplete > 0 && !overrideReason.trim()) {
      setError('Required tasks are open. Complete them or enter an override reason before closing.');
      return;
    }
    setError('');
    try {
      const result = await api.closeAccountingPeriod(
        selectedPeriodId,
        checklist.summary.requiredIncomplete > 0 ? overrideReason.trim() : undefined
      );
      setNotice(
        result.overridden
          ? `Period ${result.periodKey} closed with an audited override.`
          : `Period ${result.periodKey} closed.`
      );
      setOverrideReason('');
      await loadPeriods();
      await loadChecklist(selectedPeriodId);
    } catch (err: any) {
      setError(err?.message || 'The period could not be closed.');
    }
  }

  async function reopenPeriod() {
    if (!selectedPeriodId) return;
    setError('');
    try {
      const result = await api.reopenAccountingPeriod(selectedPeriodId);
      setNotice(`Period ${result.periodKey} reopened.`);
      await loadPeriods();
      await loadChecklist(selectedPeriodId);
    } catch (err: any) {
      setError(err?.message || 'The period could not be reopened.');
    }
  }

  const selectedAccount = (accountId: string) => accounts.find((account) => account.id === accountId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recurring & Close"
        description="Generate repetitive vouchers from balanced templates and close each period against an auditable checklist."
        icon={<CalendarClock size={20} />}
      />

      <div className="flex flex-wrap gap-2">
        <button
          className={tab === 'templates' ? btnPrimary : btnGhost}
          onClick={() => setTab('templates')}
        >
          Recurring journals
        </button>
        <button className={tab === 'close' ? btnPrimary : btnGhost} onClick={() => setTab('close')}>
          Month-end close
        </button>
      </div>

      {error && <div className={errorBox}><AlertTriangle size={15} /><span>{error}</span></div>}
      {notice && <div className={noticeBox}><CheckCircle2 size={15} /><span>{notice}</span></div>}

      {tab === 'templates' ? (
        <>
          <div className={panel}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Recurring journal templates</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Formulas are previewed and posted through the normal balanced-journal path. A template is branch-owned; branch users only see their own.
                </p>
              </div>
              <div className="flex gap-2">
                <button className={btnGhost} onClick={() => void loadTemplates()} aria-label="Refresh recurring templates">
                  <RefreshCw size={14} /> Refresh
                </button>
                {canPost && (
                  <button className={btnPrimary} onClick={startNew}>
                    <Plus size={14} /> New template
                  </button>
                )}
              </div>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-xs text-slate-500"><Loader2 className="animate-spin" size={15} /> Loading templates…</div>
            ) : templates.length === 0 ? (
              <p className="py-6 text-xs text-slate-500 dark:text-slate-400">No recurring templates yet. Create one for rent, salaries, depreciation or amortisation.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="px-2 py-2">Template</th>
                      <th className="px-2 py-2">Branch</th>
                      <th className="px-2 py-2">Frequency</th>
                      <th className="px-2 py-2">Next run</th>
                      <th className="px-2 py-2">Last run</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((template) => (
                      <tr key={template.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                        <td className="px-2 py-2">
                          <div className="font-semibold text-slate-800 dark:text-slate-100">{template.code}</div>
                          <div className="text-slate-500 dark:text-slate-400">{template.name}</div>
                        </td>
                        <td className="px-2 py-2 text-slate-600 dark:text-slate-300">{template.branchCode}</td>
                        <td className="px-2 py-2 text-slate-600 dark:text-slate-300">{template.frequency}</td>
                        <td className="px-2 py-2 font-mono text-[11px] text-slate-700 dark:text-slate-300">{template.nextRunDate}</td>
                        <td className="px-2 py-2 font-mono text-[11px] text-slate-500 dark:text-slate-400">{template.lastRunDate || '—'}</td>
                        <td className="px-2 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${template.active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
                            {template.active ? 'Active' : 'Paused'}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex justify-end gap-1.5">
                            {canPost && (
                              <>
                                <button className={btnGhost} onClick={() => void runDue(template)} title="Generate the next due journal">
                                  <Play size={13} /> Run due
                                </button>
                                <button className={btnGhost} onClick={() => void toggleTemplate(template)}>
                                  {template.active ? <Pause size={13} /> : <Play size={13} />}
                                  {template.active ? 'Pause' : 'Resume'}
                                </button>
                              </>
                            )}
                            <button className={btnGhost} onClick={() => void editTemplate(template.id)}>
                              Edit
                            </button>
                            {canPost && template.runCount === 0 && (
                              <button className={btnGhost} onClick={() => void removeTemplate(template)} title="Delete an unused template">
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {runResult && (
            <div className={runResult.status === 'SKIPPED' ? warningBox : noticeBox}>
              <ClipboardCheck size={15} />
              <span>
                {runResult.status === 'GENERATED' && `Generated ${runResult.journal?.journalNo || 'journal'} for ${runResult.runDate}. Next due ${runResult.nextRunDate}.`}
                {runResult.status === 'ALREADY_GENERATED' && `This due date was already generated: ${runResult.journal?.journalNo || 'existing journal'}.`}
                {runResult.status === 'SKIPPED' && `Skipped ${runResult.runDate}: ${runResult.reason === 'PERIOD_CLOSED' ? 'the accounting period is closed.' : runResult.reason || 'not runnable.'}`}
              </span>
            </div>
          )}

          {form && (
            <div className={panel}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {form.id ? `Edit ${form.code}` : 'New recurring template'}
                </h3>
                <button className={btnGhost} onClick={() => setForm(null)} aria-label="Close template form">
                  <X size={14} />
                </button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
                <label className={labelClass}>
                  Code
                  <input className={inputClass} value={form.code} disabled={Boolean(form.id)} onChange={(event) => updateForm({ code: event.target.value.toUpperCase() })} placeholder="RENT" />
                </label>
                <label className={labelClass}>
                  Name
                  <input className={inputClass} value={form.name} onChange={(event) => updateForm({ name: event.target.value })} placeholder="Monthly office rent" />
                </label>
                <label className={labelClass}>
                  Branch
                  <select className={inputClass} value={form.branchId} disabled={Boolean(form.id)} onChange={(event) => updateForm({ branchId: event.target.value })}>
                    <option value="">Choose branch</option>
                    {scopedBranches.filter((branch) => branch.id !== 'ALL').map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  Frequency
                  <select className={inputClass} value={form.frequency} onChange={(event) => updateForm({ frequency: event.target.value as RecurringFrequency })}>
                    <option value="MONTHLY">Monthly</option>
                    <option value="QUARTERLY">Quarterly</option>
                    <option value="YEARLY">Yearly</option>
                  </select>
                </label>
                <label className={labelClass}>
                  Start date (AD)
                  <input type="date" className={inputClass} value={form.startDateAD} onChange={(event) => updateForm({ startDateAD: event.target.value })} />
                </label>
                <label className={labelClass}>
                  End date (AD)
                  <input type="date" className={inputClass} value={form.endDateAD} onChange={(event) => updateForm({ endDateAD: event.target.value })} />
                </label>
                <label className={labelClass}>
                  Description
                  <input className={inputClass} value={form.description} onChange={(event) => updateForm({ description: event.target.value })} placeholder="Optional note for the voucher" />
                </label>
                <label className="flex items-center gap-2 pt-5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <input type="checkbox" checked={form.active} onChange={(event) => updateForm({ active: event.target.checked })} />
                  Active
                </label>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="px-1 py-2">Account</th>
                      <th className="px-1 py-2">Side</th>
                      <th className="px-1 py-2">Amount formula</th>
                      <th className="px-1 py-2">Memo</th>
                      <th className="px-1 py-2">Party (control accounts)</th>
                      <th className="px-1 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((line) => {
                      const account = selectedAccount(line.accountId);
                      return (
                        <tr key={line.key} className="border-b border-slate-100 align-top last:border-0 dark:border-slate-800/60">
                          <td className="min-w-[220px] px-1 py-1.5">
                            <select className={cellInput} value={line.accountId} onChange={(event) => updateLine(line.key, { accountId: event.target.value })}>
                              <option value="">Choose account</option>
                              {accounts.map((item) => (
                                <option key={item.id} value={item.id}>{item.code} · {item.name}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-1 py-1.5">
                            <select className={cellInput} value={line.side} onChange={(event) => updateLine(line.key, { side: event.target.value as 'DEBIT' | 'CREDIT' })}>
                              <option value="DEBIT">Debit</option>
                              <option value="CREDIT">Credit</option>
                            </select>
                          </td>
                          <td className="min-w-[150px] px-1 py-1.5">
                            <input className={cellInput} value={line.amountFormula} onChange={(event) => updateLine(line.key, { amountFormula: event.target.value })} placeholder="12000 or 5000*1.13" aria-label={`Amount formula line ${line.key}`} />
                          </td>
                          <td className="min-w-[160px] px-1 py-1.5">
                            <input className={cellInput} value={line.memo} onChange={(event) => updateLine(line.key, { memo: event.target.value })} placeholder="Line memo" />
                          </td>
                          <td className="min-w-[180px] px-1 py-1.5">
                            {account?.isControl ? (
                              <div className="grid grid-cols-2 gap-1">
                                <input className={cellInput} value={line.partyId} onChange={(event) => updateLine(line.key, { partyId: event.target.value })} placeholder="Party ID" />
                                <input className={cellInput} value={line.partyName} onChange={(event) => updateLine(line.key, { partyName: event.target.value })} placeholder="Party name" />
                              </div>
                            ) : (
                              <span className="text-[11px] text-slate-400">Not a control account</span>
                            )}
                          </td>
                          <td className="px-1 py-1.5">
                            {form.lines.length > 2 && (
                              <button className={btnGhost} onClick={() => updateForm({ lines: form.lines.filter((item) => item.key !== line.key) })} aria-label={`Remove line ${line.key}`}>
                                <Trash2 size={13} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button className={btnGhost} onClick={() => updateForm({ lines: [...form.lines, blankLine(form.lines.length % 2 === 0 ? 'DEBIT' : 'CREDIT')] })}>
                  <Plus size={14} /> Add line
                </button>
                <button className={btnGhost} onClick={() => void previewTemplate()} disabled={!form.id}>
                  <ClipboardCheck size={14} /> Preview
                </button>
                <button className={btnPrimary} onClick={() => void saveTemplate()} disabled={saving || !canPost}>
                  {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />} Save template
                </button>
              </div>

              {preview && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-950/30">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-slate-800 dark:text-slate-100">Preview · {preview.runDate}</strong>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${preview.balanced ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'}`}>
                      {preview.balanced ? 'Balanced' : 'Not balanced'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-slate-600 dark:text-slate-300">
                    <span>Debit <b>{formatMoney(preview.totalDebit)}</b></span>
                    <span>Credit <b>{formatMoney(preview.totalCredit)}</b></span>
                    <span>Difference <b>{formatMoney(preview.difference)}</b></span>
                  </div>
                  {preview.skipReason && (
                    <p className="mt-2 text-amber-700 dark:text-amber-300">
                      {preview.skipReason === 'PERIOD_CLOSED'
                        ? 'The period is closed; the run will be skipped until it is reopened.'
                        : preview.skipReason === 'PERIOD_MISSING'
                          ? 'No accounting period contains the run date.'
                          : preview.skipReason === 'UNBALANCED'
                            ? 'Balance the template before running it.'
                            : `Not runnable: ${preview.skipReason.toLowerCase()}.`}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className={panel}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Month-end close checklist</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Required tasks gate the period close. A close with open required tasks needs an explicit, audited reason.
                </p>
              </div>
              <label className={`${labelClass} min-w-[260px]`}>
                Accounting period
                <select className={inputClass} value={selectedPeriodId} onChange={(event) => setSelectedPeriodId(event.target.value)}>
                  <option value="">Choose period</option>
                  {periods.map((period) => (
                    <option key={period.id} value={period.id}>{period.periodKey} · {period.fiscalYearCode} · {period.status}</option>
                  ))}
                </select>
              </label>
            </div>
            {selectedPeriod && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span>Period {selectedPeriod.periodKey}</span>
                <span>·</span>
                <span>{selectedPeriod.startDateAD} → {selectedPeriod.endDateAD}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${selectedPeriod.status === 'CLOSED' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'}`}>
                  {selectedPeriod.status}
                </span>
              </div>
            )}
            {checklist && (
              <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Done</div>
                  <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">{checklist.summary.done}/{checklist.summary.total}</div>
                </div>
                <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Required open</div>
                  <div className={`text-lg font-semibold ${checklist.summary.requiredIncomplete ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>{checklist.summary.requiredIncomplete}</div>
                </div>
                <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">In progress</div>
                  <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">{checklist.summary.inProgress}</div>
                </div>
                <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Close gate</div>
                  <div className={`text-sm font-semibold ${checklist.summary.canClose ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>{checklist.summary.canClose ? 'Ready' : 'Incomplete'}</div>
                </div>
              </div>
            )}
          </div>

          {checklistLoading ? (
            <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="animate-spin" size={15} /> Loading checklist…</div>
          ) : checklist ? (
            <div className={panel}>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="px-2 py-2">#</th>
                      <th className="px-2 py-2">Task</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2">Owner</th>
                      <th className="px-2 py-2">Note</th>
                      <th className="px-2 py-2">Evidence</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {checklist.tasks.map((task, index) => (
                      <tr key={task.id} className="border-b border-slate-100 align-top last:border-0 dark:border-slate-800/60">
                        <td className="px-2 py-2 font-mono text-[11px] text-slate-500">{index + 1}</td>
                        <td className="px-2 py-2">
                          <div className="font-medium text-slate-800 dark:text-slate-100">{task.title}</div>
                          <div className="text-[10px] text-slate-500">{task.taskCode}{task.required ? ' · required' : ' · optional'}</div>
                        </td>
                        <td className="px-2 py-2">
                          <select className={cellInput} value={task.status} disabled={!canClose} onChange={(event) => patchTask(task.id, { status: event.target.value as CloseTaskStatus })}>
                            {CLOSE_STATUSES.map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}
                          </select>
                        </td>
                        <td className="min-w-[120px] px-2 py-2">
                          <input className={cellInput} value={task.owner || ''} disabled={!canClose} onChange={(event) => patchTask(task.id, { owner: event.target.value })} placeholder="Owner" />
                        </td>
                        <td className="min-w-[180px] px-2 py-2">
                          <input className={cellInput} value={task.note || ''} disabled={!canClose} onChange={(event) => patchTask(task.id, { note: event.target.value })} placeholder="What was checked" />
                        </td>
                        <td className="min-w-[180px] px-2 py-2">
                          <input className={cellInput} value={task.evidenceUrl || ''} disabled={!canClose} onChange={(event) => patchTask(task.id, { evidenceUrl: event.target.value })} placeholder="https://… or /path" />
                        </td>
                        <td className="px-2 py-2">
                          {canClose && (
                            <button className={btnGhost} onClick={() => void saveTask(task)} aria-label={`Save ${task.title}`}>
                              <Save size={13} /> Save
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-slate-200 pt-3 dark:border-slate-800">
                <div className="max-w-xl text-xs text-slate-500 dark:text-slate-400">
                  {selectedPeriod?.status === 'CLOSED'
                    ? 'This period is closed. Reopen it only when a correction is required.'
                    : checklist.summary.requiredIncomplete > 0
                      ? `${checklist.summary.requiredIncomplete} required task${checklist.summary.requiredIncomplete === 1 ? '' : 's'} still open. Closing now requires an override reason.`
                      : 'All required tasks are complete. The period can be closed.'}
                  {selectedPeriod?.status === 'OPEN' && checklist.summary.requiredIncomplete > 0 && (
                    <input className={`${inputClass} mt-2`} value={overrideReason} disabled={!canClose} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Override reason (audited)" />
                  )}
                </div>
                <div className="flex gap-2">
                  {selectedPeriod?.status === 'OPEN' ? (
                    <button className={btnPrimary} onClick={() => void closePeriod()} disabled={!canClose}>
                      <CheckCircle2 size={14} /> Close period
                    </button>
                  ) : (
                    <button className={btnGhost} onClick={() => void reopenPeriod()} disabled={!canClose}>
                      <RefreshCw size={14} /> Reopen period
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">Choose an accounting period to see its checklist.</p>
          )}
        </>
      )}
    </div>
  );
};
