/**
 * People & HR → Performance & Appraisals.
 *
 * One working surface for Phase 4's appraisal cycles, weighted goals and 360
 * feedback. Reads are session-scoped by the API; the screen only forwards the
 * shell's selected branch. The sign-off control appears only on an OPEN cycle
 * and the server independently locks every cycle, goal and feedback write once
 * that sign-off commits, so the UI cannot reopen a closed appraisal period.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Award,
  CalendarRange,
  CheckCircle2,
  MessageSquareQuote,
  Plus,
  RefreshCw,
  Target,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import type {
  EmployeeRecord,
  HrFeedbackRelationship,
  HrGoalRecord,
  HrGoalStatus,
  HrPerformanceFeedbackRecord,
  HrReviewCycleRecord,
  HrReviewCycleStatus,
} from '../../services/api';
import type { Branch, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';

interface PerformanceProps {
  currentUser: User | null;
  branches: Branch[];
  selectedBranchId?: string;
}

interface CycleForm {
  branchId: string;
  name: string;
  periodStartAD: string;
  periodEndAD: string;
  status: Exclude<HrReviewCycleStatus, 'SIGNED_OFF'>;
  instructions: string;
}

interface GoalForm {
  cycleId: string;
  employeeId: string;
  title: string;
  description: string;
  weight: string;
  targetValue: string;
  status: HrGoalStatus;
  managerRating: string;
  finalRating: string;
}

interface FeedbackForm {
  cycleId: string;
  employeeId: string;
  reviewerEmployeeId: string;
  relationship: HrFeedbackRelationship;
  rating: string;
  strengths: string;
  improvements: string;
  comments: string;
}

const CYCLE_STATUSES: Exclude<HrReviewCycleStatus, 'SIGNED_OFF'>[] = ['DRAFT', 'OPEN'];
const GOAL_STATUSES: HrGoalStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const RELATIONSHIPS: HrFeedbackRelationship[] = ['SELF', 'MANAGER', 'PEER', 'REPORT'];

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
  SIGNED_OFF: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
  NOT_STARTED: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  IN_PROGRESS: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  COMPLETED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  CANCELLED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
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
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{labelText}</p>
      <p
        data-testid={testId}
        className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100"
      >
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

const emptyCycleForm = (branchId: string, status: Exclude<HrReviewCycleStatus, 'SIGNED_OFF'> = 'DRAFT'): CycleForm => ({
  branchId,
  name: '',
  periodStartAD: today(),
  periodEndAD: today(),
  status,
  instructions: '',
});

export const Performance: React.FC<PerformanceProps> = ({
  currentUser,
  branches,
  selectedBranchId,
}) => {
  const activationKey = useActivationKey('hr-performance');
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canView =
    isOperationAllowed('hr-employee-view', currentUser?.role) ||
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const canManage =
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const branchScope = selectedBranchId && selectedBranchId !== 'ALL' ? selectedBranchId : undefined;
  const concreteBranches = branches.filter((branch) => branch.id !== 'ALL');
  const defaultBranchId = branchScope || currentUser?.branchId || concreteBranches[0]?.id || '';

  const [cycles, setCycles] = useState<HrReviewCycleRecord[]>([]);
  const [goals, setGoals] = useState<HrGoalRecord[]>([]);
  const [feedback, setFeedback] = useState<HrPerformanceFeedbackRecord[]>([]);
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedCycleId, setSelectedCycleId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const [cycleModalOpen, setCycleModalOpen] = useState(false);
  const [editingCycle, setEditingCycle] = useState<HrReviewCycleRecord | null>(null);
  const [cycleForm, setCycleForm] = useState<CycleForm>(() => emptyCycleForm(defaultBranchId));

  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<HrGoalRecord | null>(null);
  const [goalForm, setGoalForm] = useState<GoalForm>(() => ({
    cycleId: '',
    employeeId: '',
    title: '',
    description: '',
    weight: '100',
    targetValue: '',
    status: 'NOT_STARTED',
    managerRating: '',
    finalRating: '',
  }));

  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [feedbackForm, setFeedbackForm] = useState<FeedbackForm>(() => ({
    cycleId: '',
    employeeId: '',
    reviewerEmployeeId: '',
    relationship: 'MANAGER',
    rating: '4',
    strengths: '',
    improvements: '',
    comments: '',
  }));

  const loadAll = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const [cycleRows, goalRows, feedbackRows, employeeRows] = await Promise.all([
        api.getHrReviewCycles({ branchId: branchScope }),
        api.getHrGoals({ branchId: branchScope }),
        api.getHrPerformanceFeedback({ branchId: branchScope }),
        api.getEmployees({ branchId: branchScope, activeOnly: true, limit: 1000 }),
      ]);
      setCycles(cycleRows);
      setGoals(goalRows);
      setFeedback(feedbackRows);
      setEmployees(employeeRows);
      setSelectedCycleId((current) => {
        if (current && cycleRows.some((row) => row.id === current)) return current;
        return cycleRows[0]?.id || '';
      });
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load performance records.');
    } finally {
      setLoading(false);
    }
  }, [branchScope, canView]);

  useEffect(() => {
    void loadAll();
  }, [activationKey, loadAll]);

  const selectedCycle = cycles.find((cycle) => cycle.id === selectedCycleId) || null;
  const cycleGoals = useMemo(
    () => (selectedCycle ? goals.filter((goal) => goal.cycleId === selectedCycle.id) : []),
    [goals, selectedCycle]
  );
  const cycleFeedback = useMemo(
    () => (selectedCycle ? feedback.filter((row) => row.cycleId === selectedCycle.id) : []),
    [feedback, selectedCycle]
  );
  const openCycles = cycles.filter((cycle) => cycle.status === 'OPEN').length;
  const completedGoals = goals.filter((goal) => goal.status === 'COMPLETED').length;
  const completionPercent = goals.length ? Math.round((completedGoals / goals.length) * 100) : 0;
  const weightedScore = useMemo(() => {
    const rated = cycleGoals.filter((goal) => goal.finalRating !== null);
    const weight = rated.reduce((sum, goal) => sum + goal.weight, 0);
    if (!weight) return null;
    return (
      rated.reduce((sum, goal) => sum + Number(goal.finalRating) * goal.weight, 0) / weight
    ).toFixed(2);
  }, [cycleGoals]);
  const cycleWritable = Boolean(selectedCycle && selectedCycle.status !== 'SIGNED_OFF');
  const feedbackOpen = Boolean(selectedCycle && selectedCycle.status === 'OPEN');

  const openCycleModal = (cycle?: HrReviewCycleRecord) => {
    setEditingCycle(cycle || null);
    setCycleForm(
      cycle
        ? {
            branchId: cycle.branchId,
            name: cycle.name,
            periodStartAD: cycle.periodStartAD,
            periodEndAD: cycle.periodEndAD,
            status: cycle.status === 'OPEN' ? 'OPEN' : 'DRAFT',
            instructions: cycle.instructions || '',
          }
        : emptyCycleForm(defaultBranchId)
    );
    setCycleModalOpen(true);
  };

  const saveCycle = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!cycleForm.branchId || !cycleForm.name.trim()) {
      await alertDialog('Choose a branch and enter a cycle name.');
      return;
    }
    if (cycleForm.periodEndAD < cycleForm.periodStartAD) {
      await alertDialog('The cycle end date cannot be before its start date.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: cycleForm.name.trim(),
        periodStartAD: cycleForm.periodStartAD,
        periodEndAD: cycleForm.periodEndAD,
        status: cycleForm.status,
        instructions: cycleForm.instructions.trim() || null,
      };
      if (editingCycle) {
        await api.updateHrReviewCycle(editingCycle.id, payload);
      } else {
        await api.createHrReviewCycle({ ...payload, branchId: cycleForm.branchId });
      }
      setCycleModalOpen(false);
      await loadAll();
    } catch (err: any) {
      await alertDialog(`Could not save the cycle: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  const signOffCycle = async (cycle: HrReviewCycleRecord) => {
    const confirmed = await confirmDialog(
      `Sign off “${cycle.name}”? Goals and 360 feedback for this cycle become read-only.`,
      { title: 'Sign off appraisal cycle', confirmLabel: 'Sign off' }
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      await api.signOffHrReviewCycle(cycle.id);
      await loadAll();
    } catch (err: any) {
      await alertDialog(`Could not sign off the cycle: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  const openGoalModal = (goal?: HrGoalRecord) => {
    if (!selectedCycle) return;
    setEditingGoal(goal || null);
    setGoalForm({
      cycleId: selectedCycle.id,
      employeeId: goal?.employeeId || '',
      title: goal?.title || '',
      description: goal?.description || '',
      weight: String(goal?.weight ?? 100),
      targetValue: goal?.targetValue || '',
      status: goal?.status || 'NOT_STARTED',
      managerRating: goal?.managerRating == null ? '' : String(goal.managerRating),
      finalRating: goal?.finalRating == null ? '' : String(goal.finalRating),
    });
    setGoalModalOpen(true);
  };

  const saveGoal = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goalForm.cycleId || !goalForm.employeeId || !goalForm.title.trim()) {
      await alertDialog('Choose an employee and enter a goal title.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: goalForm.title.trim(),
        description: goalForm.description.trim() || null,
        weight: Number(goalForm.weight),
        targetValue: goalForm.targetValue.trim() || null,
        status: goalForm.status,
        managerRating: goalForm.managerRating === '' ? null : Number(goalForm.managerRating),
        finalRating: goalForm.finalRating === '' ? null : Number(goalForm.finalRating),
      };
      if (editingGoal) {
        await api.updateHrGoal(editingGoal.id, payload);
      } else {
        await api.createHrGoal({
          ...payload,
          cycleId: goalForm.cycleId,
          employeeId: goalForm.employeeId,
        });
      }
      setGoalModalOpen(false);
      await loadAll();
    } catch (err: any) {
      await alertDialog(`Could not save the goal: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  const openFeedbackModal = () => {
    if (!selectedCycle) return;
    setFeedbackForm({
      cycleId: selectedCycle.id,
      employeeId: '',
      reviewerEmployeeId: '',
      relationship: 'MANAGER',
      rating: '4',
      strengths: '',
      improvements: '',
      comments: '',
    });
    setFeedbackModalOpen(true);
  };

  const saveFeedback = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!feedbackForm.cycleId || !feedbackForm.employeeId || !feedbackForm.reviewerEmployeeId) {
      await alertDialog('Choose the employee and the reviewer.');
      return;
    }
    setSaving(true);
    try {
      await api.createHrPerformanceFeedback({
        cycleId: feedbackForm.cycleId,
        employeeId: feedbackForm.employeeId,
        reviewerEmployeeId: feedbackForm.reviewerEmployeeId,
        relationship: feedbackForm.relationship,
        rating: Number(feedbackForm.rating),
        strengths: feedbackForm.strengths.trim() || null,
        improvements: feedbackForm.improvements.trim() || null,
        comments: feedbackForm.comments.trim() || null,
      });
      setFeedbackModalOpen(false);
      await loadAll();
    } catch (err: any) {
      await alertDialog(`Could not save the feedback: ${err?.message || 'request failed'}`);
    } finally {
      setSaving(false);
    }
  };

  if (!canView) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Performance & Appraisals"
          description="Appraisal cycles, weighted goals and 360 feedback."
          icon={<TrendingUp className="h-5 w-5 text-indigo-500" />}
        />
        <div className={panel} data-testid="performance-no-access">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Performance records are available to accounts with the HR employee-view permission.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Performance & Appraisals"
        description="Branch-scoped review cycles, weighted goals and 360 feedback. Sign-off locks a cycle for good."
        icon={<TrendingUp className="h-5 w-5 text-indigo-500" />}
        actions={
          <>
            <button
              type="button"
              onClick={() => void loadAll()}
              className={secondaryButton}
              disabled={loading}
              data-testid="performance-refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {canManage && (
              <button
                type="button"
                onClick={() => openCycleModal()}
                className={primaryButton}
                data-testid="performance-new-cycle"
              >
                <Plus className="h-3.5 w-3.5" />
                New cycle
              </button>
            )}
          </>
        }
      />

      {loadError && (
        <div
          className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
          data-testid="performance-load-error"
        >
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          labelText="Open cycles"
          value={String(openCycles)}
          hint={`${cycles.length} cycle${cycles.length === 1 ? '' : 's'} in scope`}
          icon={<CalendarRange className="h-4 w-4" />}
          testId="performance-summary-open"
        />
        <SummaryCard
          labelText="Goals"
          value={String(goals.length)}
          hint={`${completedGoals} completed`}
          icon={<Target className="h-4 w-4" />}
          testId="performance-summary-goals"
        />
        <SummaryCard
          labelText="Goal completion"
          value={`${completionPercent}%`}
          hint="Across every cycle in scope"
          icon={<CheckCircle2 className="h-4 w-4" />}
          testId="performance-summary-completion"
        />
        <SummaryCard
          labelText="360 feedback"
          value={String(feedback.length)}
          hint={`${new Set(feedback.map((row) => row.employeeId)).size} employees reviewed`}
          icon={<MessageSquareQuote className="h-4 w-4" />}
          testId="performance-summary-feedback"
        />
      </div>

      <section className={panel} aria-label="Appraisal cycles">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Appraisal cycles</h3>
            <p className="mt-0.5 text-[10px] text-slate-400">
              Select a cycle to work its goals and feedback.
            </p>
          </div>
          <span className="text-[10px] text-slate-400">{cycles.length} total</span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[780px] text-left text-xs">
            <thead>
              <tr className={tableHead}>
                <th className="px-1 py-2 font-semibold">Cycle</th>
                <th className="px-1 py-2 font-semibold">Branch</th>
                <th className="px-1 py-2 font-semibold">Period</th>
                <th className="px-1 py-2 font-semibold">Status</th>
                <th className="px-1 py-2 font-semibold">People</th>
                <th className="px-1 py-2 font-semibold">Feedback</th>
                <th className="px-1 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {cycles.length === 0 ? (
                <EmptyRow
                  colSpan={7}
                  message="No appraisal cycles in this branch scope yet."
                  testId="performance-empty-cycles"
                />
              ) : (
                cycles.map((cycle) => (
                  <tr
                    key={cycle.id}
                    className={`${tableRow} ${
                      selectedCycleId === cycle.id ? 'bg-indigo-50/50 dark:bg-indigo-950/20' : ''
                    }`}
                  >
                    <td className="px-1 py-2">
                      <button
                        type="button"
                        onClick={() => setSelectedCycleId(cycle.id)}
                        className="text-left font-medium text-slate-700 hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-400"
                      >
                        {cycle.name}
                      </button>
                      <p className="text-[10px] text-slate-400">{cycle.cycleNo}</p>
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{cycle.branchName}</td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {cycle.periodStartAD} → {cycle.periodEndAD}
                    </td>
                    <td className="px-1 py-2">
                      <StatusPill status={cycle.status} />
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {cycle.employeeCount} · {cycle.goalCount} goals
                    </td>
                    <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                      {cycle.feedbackCount}
                    </td>
                    <td className="px-1 py-2 text-right">
                      {canManage && cycle.status !== 'SIGNED_OFF' && (
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => openCycleModal(cycle)}
                            className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            Edit
                          </button>
                          {cycle.status === 'OPEN' && (
                            <button
                              type="button"
                              onClick={() => void signOffCycle(cycle)}
                              disabled={saving}
                              className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-60 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                            >
                              Sign off
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedCycle && (
        <div className={`${panel} flex flex-wrap items-start justify-between gap-3`}>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Selected cycle
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
              {selectedCycle.name} · {selectedCycle.branchName}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-400">
              {selectedCycle.periodStartAD} → {selectedCycle.periodEndAD}
              {selectedCycle.signedOffBy ? ` · signed off by ${selectedCycle.signedOffBy}` : ''}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Weighted score
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
              {weightedScore ?? '—'}
            </p>
            <p className="text-[10px] text-slate-400">Final ratings, weighted by goal</p>
          </div>
          {selectedCycle.status === 'SIGNED_OFF' && (
            <div className="w-full rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[11px] text-indigo-700 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-300">
              This cycle is signed off. Goals and feedback are locked and read-only.
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className={panel} aria-label="Goals">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Goals & KPIs</h3>
              <p className="mt-0.5 text-[10px] text-slate-400">Weighted objectives for the selected cycle.</p>
            </div>
            {canManage && selectedCycle && cycleWritable && (
              <button
                type="button"
                onClick={() => openGoalModal()}
                className={secondaryButton}
                data-testid="performance-add-goal"
              >
                <Plus className="h-3.5 w-3.5" /> Add goal
              </button>
            )}
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className={tableHead}>
                  <th className="px-1 py-2 font-semibold">Employee</th>
                  <th className="px-1 py-2 font-semibold">Goal</th>
                  <th className="px-1 py-2 font-semibold">Weight</th>
                  <th className="px-1 py-2 font-semibold">Status</th>
                  <th className="px-1 py-2 font-semibold">Rating</th>
                  <th className="px-1 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {cycleGoals.length === 0 ? (
                  <EmptyRow
                    colSpan={6}
                    message={selectedCycle ? 'No goals set for this cycle.' : 'Select a cycle to see its goals.'}
                    testId="performance-empty-goals"
                  />
                ) : (
                  cycleGoals.map((goal) => (
                    <tr key={goal.id} className={tableRow}>
                      <td className="px-1 py-2">
                        <p className="font-medium text-slate-700 dark:text-slate-200">{goal.employeeName}</p>
                        <p className="text-[10px] text-slate-400">{goal.employeeCode}</p>
                      </td>
                      <td className="px-1 py-2">
                        <p className="text-slate-600 dark:text-slate-300">{goal.title}</p>
                        <p className="text-[10px] text-slate-400">{goal.goalNo}</p>
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">{goal.weight}%</td>
                      <td className="px-1 py-2">
                        <StatusPill status={goal.status} />
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {goal.finalRating ?? goal.managerRating ?? '—'}
                      </td>
                      <td className="px-1 py-2 text-right">
                        {canManage && cycleWritable && (
                          <button
                            type="button"
                            onClick={() => openGoalModal(goal)}
                            className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                          >
                            Edit
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

        <section className={panel} aria-label="360 feedback">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">360 feedback</h3>
              <p className="mt-0.5 text-[10px] text-slate-400">Submitted feedback is immutable.</p>
            </div>
            {canManage && selectedCycle && feedbackOpen && (
              <button
                type="button"
                onClick={openFeedbackModal}
                className={secondaryButton}
                data-testid="performance-add-feedback"
              >
                <MessageSquareQuote className="h-3.5 w-3.5" /> Add feedback
              </button>
            )}
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className={tableHead}>
                  <th className="px-1 py-2 font-semibold">Employee</th>
                  <th className="px-1 py-2 font-semibold">Reviewer</th>
                  <th className="px-1 py-2 font-semibold">Relationship</th>
                  <th className="px-1 py-2 font-semibold">Rating</th>
                </tr>
              </thead>
              <tbody>
                {cycleFeedback.length === 0 ? (
                  <EmptyRow
                    colSpan={4}
                    message={
                      selectedCycle && selectedCycle.status === 'DRAFT'
                        ? 'Open the cycle before collecting 360 feedback.'
                        : 'No 360 feedback submitted for this cycle.'
                    }
                    testId="performance-empty-feedback"
                  />
                ) : (
                  cycleFeedback.map((row) => (
                    <tr key={row.id} className={tableRow}>
                      <td className="px-1 py-2">
                        <p className="font-medium text-slate-700 dark:text-slate-200">{row.employeeName}</p>
                        <p className="text-[10px] text-slate-400">{row.employeeCode}</p>
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {row.reviewerEmployeeName}
                      </td>
                      <td className="px-1 py-2 text-slate-600 dark:text-slate-300">
                        {label(row.relationship)}
                      </td>
                      <td className="px-1 py-2">
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                          <Award className="h-3 w-3" /> {row.rating}/5
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {cycleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={editingCycle ? 'Edit appraisal cycle' : 'New appraisal cycle'}
            onClose={() => setCycleModalOpen(false)}
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">
                  {editingCycle ? 'Edit appraisal cycle' : 'New appraisal cycle'}
                </h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  A cycle belongs to one branch; goals and feedback inherit that branch.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCycleModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={saveCycle} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Branch *</label>
                  <select
                    value={cycleForm.branchId}
                    onChange={(event) => setCycleForm({ ...cycleForm, branchId: event.target.value })}
                    disabled={Boolean(editingCycle)}
                    className={inputClass}
                    required
                  >
                    <option value="">Choose a branch</option>
                    {concreteBranches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Status</label>
                  <select
                    value={cycleForm.status}
                    onChange={(event) =>
                      setCycleForm({
                        ...cycleForm,
                        status: event.target.value as CycleForm['status'],
                      })
                    }
                    className={inputClass}
                  >
                    {CYCLE_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {label(status)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelClass}>Name *</label>
                <input
                  value={cycleForm.name}
                  onChange={(event) => setCycleForm({ ...cycleForm, name: event.target.value })}
                  className={inputClass}
                  maxLength={150}
                  required
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Period start (AD) *</label>
                  <input
                    type="date"
                    value={cycleForm.periodStartAD}
                    onChange={(event) =>
                      setCycleForm({ ...cycleForm, periodStartAD: event.target.value })
                    }
                    className={inputClass}
                    required
                  />
                </div>
                <div>
                  <label className={labelClass}>Period end (AD) *</label>
                  <input
                    type="date"
                    value={cycleForm.periodEndAD}
                    onChange={(event) =>
                      setCycleForm({ ...cycleForm, periodEndAD: event.target.value })
                    }
                    className={inputClass}
                    required
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Instructions</label>
                <textarea
                  value={cycleForm.instructions}
                  onChange={(event) =>
                    setCycleForm({ ...cycleForm, instructions: event.target.value })
                  }
                  className="min-h-20 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={2000}
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button type="button" onClick={() => setCycleModalOpen(false)} className={secondaryButton}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryButton}>
                  {saving ? 'Saving…' : editingCycle ? 'Save changes' : 'Create cycle'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {goalModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={editingGoal ? 'Edit goal' : 'New goal'}
            onClose={() => setGoalModalOpen(false)}
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">{editingGoal ? 'Edit goal' : 'New goal'}</h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  {selectedCycle?.name} · {selectedCycle?.branchName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setGoalModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={saveGoal} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Employee *</label>
                  <select
                    value={goalForm.employeeId}
                    onChange={(event) => setGoalForm({ ...goalForm, employeeId: event.target.value })}
                    disabled={Boolean(editingGoal)}
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
                <div>
                  <label className={labelClass}>Weight (%) *</label>
                  <input
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    value={goalForm.weight}
                    onChange={(event) => setGoalForm({ ...goalForm, weight: event.target.value })}
                    className={inputClass}
                    required
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Goal title *</label>
                <input
                  value={goalForm.title}
                  onChange={(event) => setGoalForm({ ...goalForm, title: event.target.value })}
                  className={inputClass}
                  maxLength={200}
                  required
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Status</label>
                  <select
                    value={goalForm.status}
                    onChange={(event) =>
                      setGoalForm({ ...goalForm, status: event.target.value as HrGoalStatus })
                    }
                    className={inputClass}
                  >
                    {GOAL_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {label(status)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Target</label>
                  <input
                    value={goalForm.targetValue}
                    onChange={(event) => setGoalForm({ ...goalForm, targetValue: event.target.value })}
                    className={inputClass}
                    maxLength={200}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Description</label>
                <textarea
                  value={goalForm.description}
                  onChange={(event) => setGoalForm({ ...goalForm, description: event.target.value })}
                  className="min-h-16 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={1000}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Manager rating (1–5)</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    step="0.01"
                    value={goalForm.managerRating}
                    onChange={(event) =>
                      setGoalForm({ ...goalForm, managerRating: event.target.value })
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Final rating (1–5)</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    step="0.01"
                    value={goalForm.finalRating}
                    onChange={(event) => setGoalForm({ ...goalForm, finalRating: event.target.value })}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button type="button" onClick={() => setGoalModalOpen(false)} className={secondaryButton}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryButton}>
                  {saving ? 'Saving…' : editingGoal ? 'Save changes' : 'Add goal'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {feedbackModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label="New 360 feedback"
            onClose={() => setFeedbackModalOpen(false)}
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">New 360 feedback</h3>
                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  Submitted feedback cannot be edited.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFeedbackModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={saveFeedback} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Employee *</label>
                  <select
                    value={feedbackForm.employeeId}
                    onChange={(event) =>
                      setFeedbackForm({ ...feedbackForm, employeeId: event.target.value })
                    }
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
                <div>
                  <label className={labelClass}>Reviewer *</label>
                  <select
                    value={feedbackForm.reviewerEmployeeId}
                    onChange={(event) =>
                      setFeedbackForm({ ...feedbackForm, reviewerEmployeeId: event.target.value })
                    }
                    className={inputClass}
                    required
                  >
                    <option value="">Choose a reviewer</option>
                    {employees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.employeeCode} · {employee.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Relationship</label>
                  <select
                    value={feedbackForm.relationship}
                    onChange={(event) =>
                      setFeedbackForm({
                        ...feedbackForm,
                        relationship: event.target.value as HrFeedbackRelationship,
                      })
                    }
                    className={inputClass}
                  >
                    {RELATIONSHIPS.map((relationship) => (
                      <option key={relationship} value={relationship}>
                        {label(relationship)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Rating (1–5) *</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    step="1"
                    value={feedbackForm.rating}
                    onChange={(event) => setFeedbackForm({ ...feedbackForm, rating: event.target.value })}
                    className={inputClass}
                    required
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Strengths</label>
                <textarea
                  value={feedbackForm.strengths}
                  onChange={(event) => setFeedbackForm({ ...feedbackForm, strengths: event.target.value })}
                  className="min-h-16 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={1000}
                />
              </div>
              <div>
                <label className={labelClass}>Improvements</label>
                <textarea
                  value={feedbackForm.improvements}
                  onChange={(event) =>
                    setFeedbackForm({ ...feedbackForm, improvements: event.target.value })
                  }
                  className="min-h-16 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={1000}
                />
              </div>
              <div>
                <label className={labelClass}>Comments</label>
                <textarea
                  value={feedbackForm.comments}
                  onChange={(event) => setFeedbackForm({ ...feedbackForm, comments: event.target.value })}
                  className="min-h-16 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-700"
                  maxLength={2000}
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button type="button" onClick={() => setFeedbackModalOpen(false)} className={secondaryButton}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryButton}>
                  {saving ? 'Saving…' : 'Submit feedback'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default Performance;