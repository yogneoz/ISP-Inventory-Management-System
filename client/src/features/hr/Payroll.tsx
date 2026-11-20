/**
 * People & HR → Payroll & Salary.
 *
 * Phase 2's first surface: effective-dated salary structures. A structure is
 * resolved as of a date (the newest revision on or before that date), with an
 * optional history view. Basic and HR allowance default to the documented
 * 60/40 split of a monthly gross; SSF eligibility, the overtime rate and the
 * monthly TDS instruction ride on the same effective-dated header.
 *
 * View-only HR roles read the register. Only employees with the employee-manage
 * grant (or the legacy payroll-master grant) see Add/Edit controls.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  Check,
  CreditCard,
  Edit2,
  FileText,
  Landmark,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { PayrollOutputsModal } from './PayrollOutputsModal';
import { api } from '../../services/api';
import type {
  EmployeeRecord,
  HrSalaryStructureInput,
  HrSalaryStructureRecord,
  HrStatutoryBreakdown,
  HrStatutoryConfigRecord,
  HrPayrollRunRecord,
  HrPayrollRunStatus,
  HrPayrollOutputView,
} from '../../services/api';
import type { Branch, FiscalYear, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { useBootstrapData } from '../../contexts/AppProviders';

interface PayrollProps {
  currentUser: User | null;
  fiscalYears: FiscalYear[];
}

interface SalaryForm {
  employeeId: string;
  effectiveFrom: string;
  monthlyGross: string;
  basicAmount: string;
  hraAmount: string;
  ssfEligible: boolean;
  overtimeRate: string;
  tdsMonthly: string;
  notes: string;
}

interface SlabForm {
  lowerBound: string;
  upperBound: string;
  ratePercent: string;
}

interface StatutoryConfigForm {
  employeeSsfPercent: string;
  employerSsfPercent: string;
  notes: string;
  slabs: SlabForm[];
}

const today = () => new Date().toISOString().slice(0, 10);

const money = (value: number): string =>
  Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const runStatusClass = (status: HrPayrollRunStatus): string => {
  if (status === 'PAID') {
    return 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300';
  }
  if (status === 'POSTED') {
    return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
  }
  if (status === 'APPROVED') {
    return 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300';
  }
  return 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300';
};

const when = (value: string | null): string =>
  value ? new Date(value).toLocaleString('en-GB') : '—';

const emptyForm = (): SalaryForm => ({
  employeeId: '',
  effectiveFrom: today(),
  monthlyGross: '',
  basicAmount: '',
  hraAmount: '',
  ssfEligible: false,
  overtimeRate: '0',
  tdsMonthly: '0',
  notes: '',
});

const splitBasic = (gross: number): { basic: number; hra: number } => {
  const basic = Math.round(gross * 0.6 * 100) / 100;
  return { basic, hra: Math.round((gross - basic) * 100) / 100 };
};

/** FY 2083/84 monthly bands, used as the starting point for a new fiscal year. */
const defaultSlabs = (): SlabForm[] => [
  { lowerBound: '0', upperBound: '83333.33', ratePercent: '1' },
  { lowerBound: '83333.33', upperBound: '125000', ratePercent: '10' },
  { lowerBound: '125000', upperBound: '208333.33', ratePercent: '20' },
  { lowerBound: '208333.33', upperBound: '333333.33', ratePercent: '27' },
  { lowerBound: '333333.33', upperBound: '', ratePercent: '29' },
];

const emptyConfigForm = (): StatutoryConfigForm => ({
  employeeSsfPercent: '11',
  employerSsfPercent: '20',
  notes: '',
  slabs: defaultSlabs(),
});

export const Payroll: React.FC<PayrollProps> = ({ currentUser, fiscalYears,  }) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const { alert: alertDialog, confirm: confirmDialog } = useDialog();
  const activationKey = useActivationKey('hr-payroll');
  const canManage =
    isOperationAllowed('hr-employee-manage', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const canManageConfig =
    canManage &&
    (currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'HEAD_OFFICE_ADMIN');
  const canPost = isOperationAllowed('gl-payroll-post', currentUser?.role);
  const canReadRuns =
    canManage || isOperationAllowed('gl-view', currentUser?.role);

  const [rows, setRows] = useState<HrSalaryStructureRecord[]>([]);
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [asOfInput, setAsOfInput] = useState(today());
  const [asOf, setAsOf] = useState(today());
  const [showHistory, setShowHistory] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<HrSalaryStructureRecord | null>(null);
  const [form, setForm] = useState<SalaryForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [breakdown, setBreakdown] = useState<HrStatutoryBreakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState('');
  const [breakdownRefreshKey, setBreakdownRefreshKey] = useState(0);
  const [configs, setConfigs] = useState<HrStatutoryConfigRecord[]>([]);
  const [configOpen, setConfigOpen] = useState(false);
  const [configFiscalYearId, setConfigFiscalYearId] = useState('');
  const [configForm, setConfigForm] = useState<StatutoryConfigForm>(emptyConfigForm);
  const [configSaving, setConfigSaving] = useState(false);
  const [runs, setRuns] = useState<HrPayrollRunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');
  const [runBranchId, setRunBranchId] = useState('');
  const [runPeriod, setRunPeriod] = useState(today().slice(0, 7));
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRun, setSelectedRun] = useState<HrPayrollRunRecord | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState('');
  const [runRefreshKey, setRunRefreshKey] = useState(0);
  const [runBusy, setRunBusy] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [outputView, setOutputView] = useState<HrPayrollOutputView | null>(null);

  const loadStructures = async () => {
    setLoading(true);
    try {
      const next = await api.getHrSalaryStructures(showHistory ? {} : { asOf });
      setRows(Array.isArray(next) ? next : []);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'Salary structures could not be read.');
    } finally {
      setLoading(false);
    }
  };

  const loadRuns = async () => {
    if (!canReadRuns) {
      setRuns([]);
      setRunsError('');
      setRunsLoading(false);
      return;
    }
    if (!runBranchId) {
      setRuns([]);
      setRunsError('');
      return;
    }
    setRunsLoading(true);
    try {
      const next = await api.getHrPayrollRuns({ branchId: runBranchId });
      setRuns(Array.isArray(next) ? next : []);
      setRunsError('');
    } catch (err: any) {
      setRunsError(err?.message || 'Payroll runs could not be read.');
    } finally {
      setRunsLoading(false);
    }
  };

  useEffect(() => {
    void loadStructures();
    // Refetch after a tab re-activation and whenever the effective-date view changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, asOf, showHistory]);

  useEffect(() => {
    let cancelled = false;
    api
      .getEmployees({ activeOnly: true, limit: 500 })
      .then((next) => {
        if (!cancelled) setEmployees(Array.isArray(next) ? next : []);
      })
      .catch(() => {
        if (!cancelled) setEmployees([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runBranchOptions = useMemo(() => {
    const options = new Map<string, string>();
    const userBranchId = currentUser?.branchId;
    if (userBranchId && userBranchId !== 'ALL') {
      options.set(
        userBranchId,
        branches.find((branch) => branch.id === userBranchId)?.name || userBranchId
      );
    }
    for (const branch of branches) {
      if (branch.active !== false) options.set(branch.id, branch.name);
    }
    for (const row of rows) {
      if (!options.has(row.branchId)) options.set(row.branchId, row.branchName);
    }
    for (const employee of employees) {
      if (!options.has(employee.branchId)) options.set(employee.branchId, employee.branchId);
    }
    return [...options].map(([id, name]) => ({ id, name }));
  }, [branches, currentUser, employees, rows]);

  useEffect(() => {
    if (runBranchId) return;
    const preferred =
      currentUser?.branchId && currentUser.branchId !== 'ALL'
        ? currentUser.branchId
        : runBranchOptions[0]?.id || '';
    if (preferred) setRunBranchId(preferred);
  }, [currentUser, runBranchId, runBranchOptions]);

  useEffect(() => {
    void loadRuns();
    // Refetch on tab re-activation and whenever the selected branch changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, canReadRuns, runBranchId]);

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunId('');
      setSelectedRun(null);
      return;
    }
    if (!runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (!canReadRuns || !selectedRunId) {
      setSelectedRun(null);
      setRunDetailError('');
      return;
    }
    let cancelled = false;
    setRunDetailLoading(true);
    setRunDetailError('');
    api.getHrPayrollRun(selectedRunId)
      .then((next) => {
        if (!cancelled) setSelectedRun(next);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setSelectedRun(null);
          setRunDetailError(err?.message || 'The payroll run could not be read.');
        }
      })
      .finally(() => {
        if (!cancelled) setRunDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activationKey, canReadRuns, runRefreshKey, selectedRunId]);

  const totals = useMemo(() => {
    const gross = rows.reduce((sum, row) => sum + Number(row.monthlyGross || 0), 0);
    const ssf = rows.filter((row) => row.ssfEligible).length;
    return { gross, ssf };
  }, [rows]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedId('');
      setBreakdown(null);
      setBreakdownError('');
      return;
    }
    if (!rows.some((row) => row.id === selectedId)) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedId) || null,
    [rows, selectedId]
  );
  const statutoryAsOf = selectedRow
    ? showHistory
      ? selectedRow.effectiveFrom
      : asOf
    : asOf;

  useEffect(() => {
    if (!selectedRow) return;
    let cancelled = false;
    setBreakdownLoading(true);
    setBreakdownError('');
    api
      .getHrSalaryStatutory(selectedRow.id, statutoryAsOf)
      .then((next) => {
        if (!cancelled) setBreakdown(next);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setBreakdown(null);
          setBreakdownError(
            err?.message || 'The statutory breakdown could not be calculated.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setBreakdownLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRow, statutoryAsOf, breakdownRefreshKey]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setIsModalOpen(true);
  };

  const openEdit = (row: HrSalaryStructureRecord) => {
    setEditing(row);
    setForm({
      employeeId: row.employeeId,
      effectiveFrom: row.effectiveFrom,
      monthlyGross: String(row.monthlyGross),
      basicAmount: String(row.basicAmount),
      hraAmount: String(row.hraAmount),
      ssfEligible: row.ssfEligible,
      overtimeRate: String(row.overtimeRate),
      tdsMonthly: String(row.tdsMonthly),
      notes: row.notes || '',
    });
    setIsModalOpen(true);
  };

  const applySplit = (grossValue = form.monthlyGross) => {
    const gross = Number(grossValue);
    if (!Number.isFinite(gross) || gross < 0) {
      alertDialog('Enter a valid monthly gross first.');
      return;
    }
    const split = splitBasic(gross);
    setForm((current) => ({
      ...current,
      monthlyGross: String(gross),
      basicAmount: String(split.basic),
      hraAmount: String(split.hra),
    }));
  };

  const handleEmployeeChange = (employeeId: string) => {
    const employee = employees.find((item) => item.id === employeeId);
    const salary = Number(employee?.monthlySalary ?? 0);
    const split = salary > 0 ? splitBasic(salary) : null;
    setForm((current) => ({
      ...current,
      employeeId,
      ssfEligible: employee?.ssfEligible ?? current.ssfEligible,
      monthlyGross: salary > 0 ? String(salary) : current.monthlyGross,
      basicAmount: split ? String(split.basic) : current.basicAmount,
      hraAmount: split ? String(split.hra) : current.hraAmount,
    }));
  };

  const configForYear = (fiscalYearId: string) =>
    configs.find((config) => config.fiscalYearId === fiscalYearId) || null;

  const fillConfigForm = (config: HrStatutoryConfigRecord | null) => {
    if (!config) {
      setConfigForm(emptyConfigForm());
      return;
    }
    setConfigForm({
      employeeSsfPercent: String(config.employeeSsfPercent),
      employerSsfPercent: String(config.employerSsfPercent),
      notes: config.notes || '',
      slabs: config.slabs.map((slab) => ({
        lowerBound: String(slab.lowerBound),
        upperBound: slab.upperBound === null ? '' : String(slab.upperBound),
        ratePercent: String(slab.ratePercent),
      })),
    });
  };

  const openConfigManager = async () => {
    const year = fiscalYears.find((item) => item.isCurrent) || fiscalYears[0];
    if (!year) {
      alertDialog('No fiscal year is configured.');
      return;
    }
    setConfigFiscalYearId(year.id);
    setConfigOpen(true);
    try {
      const next = await api.getHrStatutoryConfigs();
      const list = Array.isArray(next) ? next : [];
      setConfigs(list);
      fillConfigForm(list.find((config) => config.fiscalYearId === year.id) || null);
    } catch (err: any) {
      alertDialog(`Failed to load statutory configuration: ${err?.message || 'Database error'}`);
    }
  };

  const handleConfigYearChange = (fiscalYearId: string) => {
    setConfigFiscalYearId(fiscalYearId);
    fillConfigForm(configForYear(fiscalYearId));
  };

  const updateSlab = (index: number, field: keyof SlabForm, value: string) => {
    setConfigForm((current) => ({
      ...current,
      slabs: current.slabs.map((slab, slabIndex) =>
        slabIndex === index ? { ...slab, [field]: value } : slab
      ),
    }));
  };

  const addSlab = () => {
    setConfigForm((current) => {
      const last = current.slabs[current.slabs.length - 1];
      return {
        ...current,
        slabs: [
          ...current.slabs,
          {
            lowerBound: last?.upperBound || last?.lowerBound || '0',
            upperBound: '',
            ratePercent: '',
          },
        ],
      };
    });
  };

  const removeSlab = (index: number) => {
    setConfigForm((current) => ({
      ...current,
      slabs: current.slabs.filter((_, slabIndex) => slabIndex !== index),
    }));
  };

  const handleConfigSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!configFiscalYearId) {
      alertDialog('Choose a fiscal year.');
      return;
    }
    const existing = configForYear(configFiscalYearId);
    const slabs = configForm.slabs.map((slab) => ({
      lowerBound: Number(slab.lowerBound),
      upperBound: slab.upperBound.trim() === '' ? null : Number(slab.upperBound),
      ratePercent: Number(slab.ratePercent),
    }));
    setConfigSaving(true);
    try {
      const payload = {
        employeeSsfPercent: Number(configForm.employeeSsfPercent),
        employerSsfPercent: Number(configForm.employerSsfPercent),
        notes: configForm.notes.trim() || null,
        slabs,
      };
      if (existing) {
        await api.updateHrStatutoryConfig(existing.id, payload);
      } else {
        await api.createHrStatutoryConfig({ fiscalYearId: configFiscalYearId, ...payload });
      }
      const next = await api.getHrStatutoryConfigs();
      const list = Array.isArray(next) ? next : [];
      setConfigs(list);
      fillConfigForm(list.find((config) => config.fiscalYearId === configFiscalYearId) || null);
      setBreakdownRefreshKey((value) => value + 1);
    } catch (err: any) {
      alertDialog(`Failed to save statutory configuration: ${err?.message || 'Database error'}`);
    } finally {
      setConfigSaving(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.employeeId) {
      alertDialog('Choose an employee.');
      return;
    }
    if (!form.effectiveFrom) {
      alertDialog('An effective date is required.');
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        await api.updateHrSalaryStructure(editing.id, {
          ssfEligible: form.ssfEligible,
          overtimeRate: Number(form.overtimeRate || 0),
          tdsMonthly: Number(form.tdsMonthly || 0),
          notes: form.notes.trim() || null,
        });
      } else {
        const input: HrSalaryStructureInput = {
          employeeId: form.employeeId,
          effectiveFrom: form.effectiveFrom,
          ssfEligible: form.ssfEligible,
          overtimeRate: Number(form.overtimeRate || 0),
          tdsMonthly: Number(form.tdsMonthly || 0),
          notes: form.notes.trim() || null,
        };
        if (form.basicAmount.trim() || form.hraAmount.trim()) {
          input.basicAmount = Number(form.basicAmount || 0);
          input.hraAmount = Number(form.hraAmount || 0);
        } else if (form.monthlyGross.trim()) {
          input.monthlyGross = Number(form.monthlyGross);
        }
        await api.createHrSalaryStructure(input);
      }
      setIsModalOpen(false);
      setEditing(null);
      await loadStructures();
    } catch (err: any) {
      alertDialog(
        `Failed to ${editing ? 'update' : 'create'} the salary structure: ${
          err?.message || 'Database error'
        }`
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCreateDraft = async () => {
    if (!runBranchId) {
      alertDialog('Choose a branch before generating payroll.');
      return;
    }
    if (!runPeriod) {
      alertDialog('Choose a payroll month.');
      return;
    }
    setRunBusy('draft');
    try {
      const created = await api.createHrPayrollRunDraft({
        branchId: runBranchId,
        periodKey: runPeriod,
      });
      await loadRuns();
      setSelectedRunId(created.id);
      setRunRefreshKey((value) => value + 1);
    } catch (err: any) {
      alertDialog(`Could not generate the payroll draft: ${err?.message || 'Database error'}`);
    } finally {
      setRunBusy('');
    }
  };

  const handleRunAction = async (
    run: HrPayrollRunRecord,
    action: 'approve' | 'post' | 'pay' | 'discard'
  ) => {
    const titles = {
      approve: 'Approve this payroll run',
      post: 'Post this payroll run',
      pay: 'Pay this payroll run',
      discard: 'Discard this payroll draft',
    } as const;
    const messages = {
      approve: `Approve ${run.runNo} for ${run.periodKey}? HR cannot change the prepared lines after approval.`,
      post: `Post ${run.runNo} for ${run.periodKey} to the ledger? This cannot be undone without a reversal.`,
      pay: `Pay ${run.runNo} via ${paymentMethod}? This clears salary payable for every employee in the run.`,
      discard: `Discard draft ${run.runNo} for ${run.periodKey}? The generated lines will be removed.`,
    } as const;
    const confirmed = await confirmDialog(messages[action], {
      title: titles[action],
      confirmLabel: action === 'discard' ? 'Discard' : titles[action].split(' ')[0],
    });
    if (!confirmed) return;

    setRunBusy(`${action}:${run.id}`);
    try {
      if (action === 'approve') await api.approveHrPayrollRun(run.id);
      if (action === 'post') await api.postHrPayrollRun(run.id);
      if (action === 'pay') await api.payHrPayrollRun(run.id, { paymentMethod });
      if (action === 'discard') await api.discardHrPayrollRunDraft(run.id);
      if (action === 'discard') {
        setSelectedRunId('');
        setSelectedRun(null);
      }
      await loadRuns();
      setRunRefreshKey((value) => value + 1);
    } catch (err: any) {
      alertDialog(`Payroll action failed: ${err?.message || 'Database error'}`);
    } finally {
      setRunBusy('');
    }
  };

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-4 overflow-hidden">
      <PageHeader
        title="Payroll & Salary"
        description={
          loadError && rows.length === 0
            ? 'Salary structures unavailable — retry below'
            : `${rows.length} effective structure${rows.length === 1 ? '' : 's'} · NPR ${money(
                totals.gross
              )} monthly gross · ${totals.ssf} SSF eligible`
        }
        icon={<Wallet className="h-5 w-5 text-emerald-500" />}
        actions={
          canManage || canManageConfig ? (
            <div className="flex items-center gap-2">
              {canManageConfig && (
                <button
                  onClick={() => void openConfigManager()}
                  className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-all hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Landmark className="h-4 w-4" />
                  <span>Tax & SSF Rules</span>
                </button>
              )}
              {canManage && (
                <button
                  onClick={openCreate}
                  className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500"
                >
                  <Plus className="h-4 w-4" />
                  <span>Add Structure</span>
                </button>
              )}
            </div>
          ) : null
        }
      />

      <LoadStateNotice
        subject="salary structures"
        loading={loading}
        error={loadError}
        hasCachedRows={rows.length > 0}
        onRetry={loadStructures}
      />

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-[#0f1218]">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Effective as of
          </span>
          <input
            type="date"
            value={asOfInput}
            disabled={showHistory}
            onChange={(event) => setAsOfInput(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900 disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          onClick={() => setAsOf(asOfInput || today())}
          disabled={showHistory}
          className="cursor-pointer rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          Apply
        </button>
        <label className="flex items-center gap-2 pb-1 text-xs font-medium text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(event) => setShowHistory(event.target.checked)}
          />
          Show all revisions
        </label>
        <button
          type="button"
          onClick={() => void loadStructures()}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
        <span className="ml-auto text-[11px] text-slate-500">
          {showHistory
            ? 'Every effective-dated revision'
            : `Newest structure effective on or before ${asOf}`}
        </span>
      </div>

      {!canManage && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
          Read-only · salary structures need the HR employee-manage permission.
        </p>
      )}

      <div
        className={`rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-[#0f1218] ${
          canReadRuns ? '' : 'hidden'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200">
              Payroll run workflow
            </h3>
            <p className="text-[11px] text-slate-500">
              Draft → approved → posted → paid · generated from structures, attendance/OT and
              the fiscal year's TDS/SSF rules.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Branch
              </span>
              <select
                value={runBranchId}
                onChange={(event) => {
                  setRunBranchId(event.target.value);
                  setSelectedRunId('');
                  setSelectedRun(null);
                }}
                className="min-w-[150px] rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              >
                {runBranchOptions.length === 0 && <option value="">No branch available</option>}
                {runBranchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Payroll month
              </span>
              <input
                type="month"
                value={runPeriod}
                onChange={(event) => setRunPeriod(event.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            {canManage && (
              <button
                type="button"
                onClick={() => void handleCreateDraft()}
                disabled={Boolean(runBusy) || !runBranchId || !runPeriod}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" />
                {runBusy === 'draft' ? 'Generating…' : 'Generate draft'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void loadRuns()}
              disabled={runsLoading || !runBranchId}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${runsLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {runsError && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            {runsError}
          </div>
        )}

        <div className="max-h-44 overflow-auto">
          <table className="w-full min-w-[860px] text-left text-[11px]">
            <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/80">
              <tr>
                <th className="px-3 py-1.5 font-semibold">Run</th>
                <th className="px-2 py-1.5 font-semibold">Period</th>
                <th className="px-2 py-1.5 font-semibold">Status</th>
                <th className="px-2 py-1.5 text-right font-semibold">Gross</th>
                <th className="px-2 py-1.5 text-right font-semibold">TDS</th>
                <th className="px-2 py-1.5 text-right font-semibold">SSF</th>
                <th className="px-2 py-1.5 text-right font-semibold">Net</th>
                <th className="px-3 py-1.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                  className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50/70 dark:border-slate-800/70 dark:hover:bg-slate-800/30 ${
                    run.id === selectedRunId ? 'bg-indigo-50/60 dark:bg-indigo-950/20' : ''
                  }`}
                >
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-600 dark:text-slate-300">
                    {run.runNo}
                  </td>
                  <td className="px-2 py-1.5 font-mono">{run.periodKey}</td>
                  <td className="px-2 py-1.5">
                    <span
                      className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${runStatusClass(
                        run.status
                      )}`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {money(Number(run.grossTotal || 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {money(Number(run.tdsTotal || 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {money(Number(run.ssfTotal || 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono font-semibold">
                    {money(Number(run.netTotal || 0))}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {canPost && run.status === 'DRAFT' && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRunAction(run, 'approve');
                          }}
                          disabled={Boolean(runBusy)}
                          className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
                        >
                          <Check className="h-3 w-3" /> Approve
                        </button>
                      )}
                      {canPost && run.status === 'APPROVED' && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRunAction(run, 'post');
                          }}
                          disabled={Boolean(runBusy)}
                          className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                        >
                          <Play className="h-3 w-3" /> Post
                        </button>
                      )}
                      {canPost && run.status === 'POSTED' && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRunAction(run, 'pay');
                          }}
                          disabled={Boolean(runBusy)}
                          className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-sky-600 hover:bg-sky-50 disabled:opacity-50 dark:text-sky-300 dark:hover:bg-sky-950/30"
                        >
                          <CreditCard className="h-3 w-3" /> Pay
                        </button>
                      )}
                      {canManage && run.status === 'DRAFT' && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRunAction(run, 'discard');
                          }}
                          disabled={Boolean(runBusy)}
                          className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-300 dark:hover:bg-rose-950/30"
                        >
                          <Trash2 className="h-3 w-3" /> Discard
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!runsLoading && runs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-5 text-center text-xs text-slate-500">
                    No payroll runs for this branch yet. Choose a month and generate a draft.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {selectedRun && (
          <div className="border-t border-slate-200 p-3 dark:border-slate-800">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-bold text-slate-800 dark:text-slate-100">
                    {selectedRun.runNo}
                  </h4>
                  <span
                    className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${runStatusClass(
                      selectedRun.status
                    )}`}
                  >
                    {selectedRun.status}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500">
                  {selectedRun.periodKey} · {selectedRun.runDateAD}
                  {selectedRun.fiscalYearCode ? ` · FY ${selectedRun.fiscalYearCode}` : ''} ·{' '}
                  {selectedRun.lines?.length || 0} employees
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                {(selectedRun.status === 'POSTED' || selectedRun.status === 'PAID') && (
                  <div className="flex items-end gap-1">
                    <button
                      type="button"
                      onClick={() => setOutputView('REGISTER')}
                      className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <FileText className="h-3 w-3" /> Register
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutputView('PAYSLIPS')}
                      className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <FileText className="h-3 w-3" /> Payslips
                    </button>
                  </div>
                )}
                {selectedRun.status === 'POSTED' && canPost && (
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Payment method
                    </span>
                    <select
                      value={paymentMethod}
                      onChange={(event) => setPaymentMethod(event.target.value)}
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] dark:border-slate-700 dark:bg-slate-900"
                    >
                      <option value="CASH">Cash</option>
                      <option value="BANK">Bank</option>
                      <option value="CHEQUE">Cheque</option>
                    </select>
                  </label>
                )}
                <span className="text-[10px] text-slate-500">
                  Prepared: {selectedRun.preparedBy || '—'} {when(selectedRun.preparedAt)}
                </span>
              </div>
            </div>
            {runDetailLoading && <div className="text-[11px] text-slate-500">Loading run detail…</div>}
            {runDetailError && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                {runDetailError}
              </div>
            )}
            <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                { label: 'Gross', value: selectedRun.grossTotal },
                { label: 'TDS', value: selectedRun.tdsTotal },
                { label: 'Employee SSF', value: selectedRun.ssfTotal },
                { label: 'Net', value: selectedRun.netTotal },
                {
                  label: 'Approved by',
                  value: selectedRun.approvedBy || '—',
                  text: true,
                },
              ].map((card) => (
                <div
                  key={card.label}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900/40"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    {card.label}
                  </div>
                  <div
                    className={`truncate text-xs font-semibold text-slate-800 dark:text-slate-100 ${
                      card.text ? '' : 'font-mono'
                    }`}
                    title={String(card.value)}
                  >
                    {card.text ? card.value : money(Number(card.value || 0))}
                  </div>
                </div>
              ))}
            </div>
            <div className="max-h-48 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full min-w-[1180px] text-left text-[11px]">
                <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/80">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">Employee</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Days</th>
                    <th className="px-2 py-1.5 text-right font-semibold">LOP</th>
                    <th className="px-2 py-1.5 text-right font-semibold">OT hrs</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Incentive</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Arrears</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Gross</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Employee SSF</th>
                    <th className="px-2 py-1.5 text-right font-semibold">TDS</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Advance</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Loan</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Employer SSF</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedRun.lines || []).map((line) => (
                    <tr
                      key={line.id}
                      className="border-t border-slate-100 dark:border-slate-800/70"
                    >
                      <td className="px-2 py-1.5">
                        <div className="font-semibold text-slate-700 dark:text-slate-200">
                          {line.employeeName}
                        </div>
                        <div className="font-mono text-[10px] text-slate-500">
                          {line.employeeCode}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {Number(line.payableDays || 0).toFixed(1)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {Number(line.lopDays || 0).toFixed(1)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {Number(line.overtimeHours || 0).toFixed(1)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {money(Number(line.incentive || 0))}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {money(Number(line.arrears || 0))}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {money(Number(line.gross || 0))}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {money(Number(line.ssf || 0))}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {money(Number(line.tds || 0))}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {money(Number(line.advance || 0))}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {money(Number(line.loan || 0))}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-slate-500">
                        {money(Number(line.employerSsf || 0))}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold">
                        {money(Number(line.net || 0))}
                      </td>
                    </tr>
                  ))}
                  {(selectedRun.lines || []).length === 0 && (
                    <tr>
                      <td colSpan={13} className="px-3 py-4 text-center text-slate-500">
                        No line snapshots are stored for this run.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {selectedRow && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-[#0f1218]">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200">
                Statutory breakdown
              </h3>
              <p className="text-[11px] text-slate-500">
                {selectedRow.employeeName} · effective {selectedRow.effectiveFrom} ·{' '}
                {breakdown ? `FY ${breakdown.fiscalYear.code}` : 'resolving fiscal year'} · as of{' '}
                {statutoryAsOf}
              </p>
            </div>
            {breakdownLoading && (
              <span className="text-[11px] text-slate-500">Calculating…</span>
            )}
          </div>
          {breakdownError ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              {breakdownError}
            </div>
          ) : breakdown ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  { label: 'Gross', value: breakdown.monthlyGross, hint: 'monthly earnings' },
                  { label: 'Taxable gross', value: breakdown.taxableGross, hint: 'after employee SSF' },
                  {
                    label: 'Employee SSF',
                    value: breakdown.employeeSsf,
                    hint: `${breakdown.employeeSsfPercent}% of basic`,
                  },
                  {
                    label: 'Employer SSF',
                    value: breakdown.employerSsf,
                    hint: `${breakdown.employerSsfPercent}% of basic`,
                  },
                  {
                    label: 'Monthly TDS',
                    value: breakdown.monthlyTds,
                    hint: breakdown.ssfEligible
                      ? 'included in SSF'
                      : `${breakdown.slabs.length} bands`,
                  },
                  {
                    label: 'Annual TDS',
                    value: breakdown.annualTds,
                    hint: breakdown.ssfEligible ? 'no separate TDS' : 'monthly × 12',
                  },
                ].map((card) => (
                  <div
                    key={card.label}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900/40"
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      {card.label}
                    </div>
                    <div className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {money(card.value)}
                    </div>
                    <div className="text-[10px] text-slate-500">{card.hint}</div>
                  </div>
                ))}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60">
                      <tr>
                        <th className="px-2 py-1.5 font-semibold">Monthly band</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Rate</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Taxable</th>
                        <th className="px-2 py-1.5 text-right font-semibold">TDS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.slabs.map((slab, index) => (
                        <tr
                          key={`${slab.lowerBound}-${index}`}
                          className="border-t border-slate-100 dark:border-slate-800/70"
                        >
                          <td className="px-2 py-1.5 font-mono">
                            {money(slab.lowerBound)} –{' '}
                            {slab.upperBound === null ? 'above' : money(slab.upperBound)}
                          </td>
                          <td className="px-2 py-1.5 text-right">{slab.ratePercent}%</td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {money(slab.taxableAmount)}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(slab.tdsAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Line items
                  </div>
                  <ul className="space-y-0.5 text-[11px]">
                    {breakdown.lineItems.map((item) => (
                      <li key={item.code} className="flex items-center justify-between gap-2">
                        <span className="text-slate-600 dark:text-slate-300">{item.label}</span>
                        <span
                          className={`font-mono ${
                            item.amount < 0
                              ? 'text-rose-600 dark:text-rose-300'
                              : 'text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          {item.amount < 0
                            ? `(${money(Math.abs(item.amount))})`
                            : money(item.amount)}
                        </span>
                      </li>
                    ))}
                    <li className="mt-1 flex items-center justify-between gap-2 border-t border-slate-200 pt-1 font-semibold dark:border-slate-800">
                      <span>Net after statutory</span>
                      <span className="font-mono">{money(breakdown.netAfterStatutory)}</span>
                    </li>
                  </ul>
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-[#0f1218]">
        <table className="w-full min-w-[1100px] text-left text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/80">
            <tr>
              <th className="px-3 py-2 font-semibold">Employee</th>
              <th className="px-2 py-2 font-semibold">Effective</th>
              <th className="px-2 py-2 text-right font-semibold">Basic</th>
              <th className="px-2 py-2 text-right font-semibold">HR allowance</th>
              <th className="px-2 py-2 text-right font-semibold">Gross</th>
              <th className="px-2 py-2 text-right font-semibold">OT rate</th>
              <th className="px-2 py-2 text-right font-semibold">TDS input</th>
              <th className="px-2 py-2 font-semibold">SSF</th>
              <th className="px-2 py-2 font-semibold">Components</th>
              <th className="px-3 py-2 font-semibold">Notes</th>
              <th className="px-2 py-2 font-semibold">Analysis</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => setSelectedId(row.id)}
                aria-selected={row.id === selectedId}
                className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50/70 dark:border-slate-800/70 dark:hover:bg-slate-800/30 ${
                  row.id === selectedId ? 'bg-indigo-50/60 dark:bg-indigo-950/20' : ''
                }`}
              >
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-800 dark:text-slate-100">
                    {row.employeeName}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {row.employeeCode} · {row.branchName}
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                  {row.effectiveFrom}
                </td>
                <td className="px-2 py-2 text-right font-mono">{money(row.basicAmount)}</td>
                <td className="px-2 py-2 text-right font-mono">{money(row.hraAmount)}</td>
                <td className="px-2 py-2 text-right font-mono font-semibold">
                  {money(row.monthlyGross)}
                </td>
                <td className="px-2 py-2 text-right font-mono">{money(row.overtimeRate)}</td>
                <td className="px-2 py-2 text-right font-mono">{money(row.tdsMonthly)}</td>
                <td className="px-2 py-2">
                  <span
                    className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                      row.ssfEligible
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400'
                    }`}
                  >
                    {row.ssfEligible ? 'Eligible' : 'Not eligible'}
                  </span>
                </td>
                <td className="px-2 py-2 text-slate-600 dark:text-slate-300">
                  {row.components.length}
                </td>
                <td className="max-w-[220px] truncate px-3 py-2 text-[11px] text-slate-500" title={row.notes || ''}>
                  {row.notes || '—'}
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedId(row.id);
                      }}
                      className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Calculator className="h-3 w-3" />
                      Breakdown
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openEdit(row);
                        }}
                        className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
                      >
                        <Edit2 className="h-3 w-3" />
                        Edit
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  className="px-4 py-10 text-center text-xs text-slate-500"
                >
                  {employees.length === 0
                    ? 'No active employees yet. Create one in Employee Directory first.'
                    : showHistory
                      ? 'No salary structures have been recorded.'
                      : `No salary structure is effective on or before ${asOf}. Add one, or turn on all revisions.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <ModalPanel
            label={editing ? 'Edit salary structure' : 'Add salary structure'}
            onClose={() => setIsModalOpen(false)}
            className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold">
                  {editing ? 'Edit salary structure' : 'Add salary structure'}
                </h3>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {editing
                    ? 'Amounts belong to this effective-dated revision. Add a new structure with a later date for a raise.'
                    : 'Basic and HR allowance default to the 60/40 split of monthly gross.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Employee
                  </span>
                  <select
                    value={form.employeeId}
                    disabled={Boolean(editing)}
                    onChange={(event) => handleEmployeeChange(event.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 disabled:opacity-60"
                  >
                    <option value="">Select an employee…</option>
                    {employees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.employeeCode} — {employee.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Effective from
                  </span>
                  <input
                    type="date"
                    value={form.effectiveFrom}
                    disabled={Boolean(editing)}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, effectiveFrom: event.target.value }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 disabled:opacity-60"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Monthly gross (NPR)
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.monthlyGross}
                    disabled={Boolean(editing)}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, monthlyGross: event.target.value }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 disabled:opacity-60"
                  />
                  {!editing && (
                    <button
                      type="button"
                      onClick={() => applySplit()}
                      className="mt-0.5 cursor-pointer self-start text-[10px] font-semibold text-indigo-600 hover:underline dark:text-indigo-300"
                    >
                      Use 60/40 split
                    </button>
                  )}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Basic
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.basicAmount}
                    disabled={Boolean(editing)}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, basicAmount: event.target.value }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 disabled:opacity-60"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    HR allowance
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.hraAmount}
                    disabled={Boolean(editing)}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, hraAmount: event.target.value }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 disabled:opacity-60"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Overtime rate / hour
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.overtimeRate}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, overtimeRate: event.target.value }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    TDS / month
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.tdsMonthly}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, tdsMonthly: event.target.value }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                </label>
                <label className="flex items-end gap-2 pb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={form.ssfEligible}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, ssfEligible: event.target.checked }))
                    }
                  />
                  SSF eligible
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Notes
                </span>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={form.notes}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, notes: event.target.value }))
                  }
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                />
              </label>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                >
                  <Calculator className="h-3.5 w-3.5" />
                  {saving ? 'Saving…' : editing ? 'Save changes' : 'Create structure'}
                </button>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}

      {outputView && selectedRun && (
        <PayrollOutputsModal
          runId={selectedRun.id}
          initialView={outputView}
          branchName={
            runBranchOptions.find((branch) => branch.id === selectedRun.branchId)?.name ||
            selectedRun.branchId
          }
          canDownloadBankFile={canManage}
          onClose={() => setOutputView(null)}
        />
      )}

      {configOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <ModalPanel
            label="Statutory rates and TDS slabs"
            onClose={() => setConfigOpen(false)}
            className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold">Statutory rates & TDS slabs</h3>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Company-wide, versioned by fiscal year. Monthly taxable bands; the first starts
                  at 0 and the last is open-ended.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfigOpen(false)}
                className="cursor-pointer rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleConfigSubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Fiscal year
                  </span>
                  <select
                    value={configFiscalYearId}
                    onChange={(event) => handleConfigYearChange(event.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  >
                    {fiscalYears.map((year) => (
                      <option key={year.id} value={year.id}>
                        {year.code}
                        {year.isCurrent ? ' (current)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Employee SSF %
                  </span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={configForm.employeeSsfPercent}
                    onChange={(event) =>
                      setConfigForm((current) => ({
                        ...current,
                        employeeSsfPercent: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Employer SSF %
                  </span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={configForm.employerSsfPercent}
                    onChange={(event) =>
                      setConfigForm((current) => ({
                        ...current,
                        employerSsfPercent: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                </label>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Progressive monthly TDS bands
                  </span>
                  <button
                    type="button"
                    onClick={addSlab}
                    className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <Plus className="h-3 w-3" /> Add band
                  </button>
                </div>
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold">Lower bound</th>
                      <th className="px-2 py-1.5 font-semibold">Upper bound</th>
                      <th className="px-2 py-1.5 font-semibold">Rate %</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {configForm.slabs.map((slab, index) => (
                      <tr key={index} className="border-t border-slate-100 dark:border-slate-800/70">
                        <td className="px-1 py-1">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={slab.lowerBound}
                            onChange={(event) => updateSlab(index, 'lowerBound', event.target.value)}
                            className="w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px] dark:border-slate-700 dark:bg-slate-900"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder={index === configForm.slabs.length - 1 ? 'open-ended' : ''}
                            value={slab.upperBound}
                            onChange={(event) => updateSlab(index, 'upperBound', event.target.value)}
                            className="w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px] dark:border-slate-700 dark:bg-slate-900"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            value={slab.ratePercent}
                            onChange={(event) => updateSlab(index, 'ratePercent', event.target.value)}
                            className="w-full rounded border border-slate-300 bg-white px-1.5 py-1 text-right font-mono text-[11px] dark:border-slate-700 dark:bg-slate-900"
                          />
                        </td>
                        <td className="px-1 py-1 text-right">
                          {configForm.slabs.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeSlab(index)}
                              className="cursor-pointer rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"
                              aria-label={`Remove band ${index + 1}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Notes
                </span>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={configForm.notes}
                  onChange={(event) =>
                    setConfigForm((current) => ({ ...current, notes: event.target.value }))
                  }
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                />
              </label>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">
                  {configForYear(configFiscalYearId)
                    ? 'Saving replaces this fiscal year’s band table.'
                    : 'This fiscal year has no configuration yet.'}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfigOpen(false)}
                    className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={configSaving}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                  >
                    <Landmark className="h-3.5 w-3.5" />
                    {configSaving ? 'Saving…' : 'Save rules'}
                  </button>
                </div>
              </div>
            </form>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default Payroll;
