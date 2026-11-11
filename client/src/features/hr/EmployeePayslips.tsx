/**
 * People & HR → My Payslips (employee self-service).
 *
 * Read-only history of the signed-in employee's POSTED/PAID payslips. The
 * server derives the employee from `employees.user_id` and returns immutable
 * run-line snapshots; this screen has no employee picker, no branch picker and
 * no payroll write action. A role without `hr-self-service` is refused before
 * the read is attempted.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, FileText, RefreshCw } from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { api } from '../../services/api';
import type { HrPayrollPayslip } from '../../services/api';
import type { User } from '../../types';
import { formatMoneyPrecise } from '../../utils/nprFormat';
import { isOperationAllowed } from '../../utils/permissions';

interface EmployeePayslipsProps {
  currentUser?: User | null;
}

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const valueClass = 'mt-0.5 text-xs font-medium text-slate-700 dark:text-slate-200';

const show = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : value;

const money = (value: number | string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : formatMoneyPrecise(value);

const statusBadge = (status: string): string =>
  status === 'PAID'
    ? 'inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'inline-flex items-center rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300';

const DetailField: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div>
    <dt className={labelClass}>{label}</dt>
    <dd className={valueClass}>{children}</dd>
  </div>
);

const DetailRow: React.FC<{ label: string; children: React.ReactNode; strong?: boolean }> = ({
  label,
  children,
  strong = false,
}) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="text-[11px] text-slate-500 dark:text-slate-400">{label}</dt>
    <dd
      className={`text-right text-[11px] ${
        strong
          ? 'font-semibold text-slate-800 dark:text-slate-100'
          : 'font-medium text-slate-700 dark:text-slate-200'
      }`}
    >
      {children}
    </dd>
  </div>
);

export const EmployeePayslips: React.FC<EmployeePayslipsProps> = ({ currentUser }) => {
  const allowed = isOperationAllowed('hr-self-service', currentUser?.role);
  const activationKey = useActivationKey('hr-self-payslips');

  const [payslips, setPayslips] = useState<HrPayrollPayslip[]>([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!allowed) {
      setPayslips([]);
      setSelectedRun('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await api.getMyHrPayslips();
      const next = response?.payslips || [];
      setPayslips(next);
      setSelectedRun((current) =>
        current && next.some((row) => row.runNo === current)
          ? current
          : next[0]?.runNo || ''
      );
    } catch (err: any) {
      setError(err?.message || 'Your payslips could not be loaded.');
      setPayslips([]);
      setSelectedRun('');
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    if (!allowed) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, load, activationKey]);

  if (!allowed) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="My Payslips"
          description="Posted and paid payroll for your own employee record."
          icon={<FileText className="h-5 w-5 text-emerald-500" />}
        />
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You do not have permission to view your payslips.</span>
        </div>
      </div>
    );
  }

  const selected = payslips.find((row) => row.runNo === selectedRun) || null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="My Payslips"
        description="Posted and paid payroll for your own employee record, read-only."
        icon={<FileText className="h-5 w-5 text-emerald-500" />}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      {error && (
        <div className={errorBox} role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !payslips.length ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">Loading your payslips…</p>
        </section>
      ) : !payslips.length ? (
        <section className={panel}>
          <p className="px-1 py-6 text-center text-xs text-slate-400">
            No posted or paid payslips are available yet. Payslips appear after HR prepares the run
            and Finance posts it.
          </p>
        </section>
      ) : (
        <>
          <section className={panel}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800">
                    <th className="px-1 py-2 font-semibold">Period</th>
                    <th className="px-1 py-2 font-semibold">Payslip / run</th>
                    <th className="px-1 py-2 font-semibold">Status</th>
                    <th className="px-1 py-2 text-right font-semibold">Gross</th>
                    <th className="px-1 py-2 text-right font-semibold">Net pay</th>
                    <th className="px-1 py-2 text-right font-semibold">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {payslips.map((payslip) => (
                    <tr
                      key={payslip.runNo}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                    >
                      <td className="px-1 py-2.5 font-medium text-slate-700 dark:text-slate-200">
                        {payslip.periodKey}
                      </td>
                      <td className="px-1 py-2.5">
                        <div className="font-medium text-slate-700 dark:text-slate-200">
                          {payslip.runNo}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400">
                          {payslip.runDateAD}
                          {payslip.paidDateAD ? ` · paid ${payslip.paidDateAD}` : ''}
                        </div>
                      </td>
                      <td className="px-1 py-2.5">
                        <span className={statusBadge(payslip.status)}>{payslip.status}</span>
                      </td>
                      <td className="px-1 py-2.5 text-right text-slate-700 dark:text-slate-200">
                        {money(payslip.gross)}
                      </td>
                      <td className="px-1 py-2.5 text-right font-semibold text-slate-800 dark:text-slate-100">
                        {money(payslip.net)}
                      </td>
                      <td className="px-1 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedRun(payslip.runNo)}
                          aria-label={`View details for ${payslip.periodKey}`}
                          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          {selectedRun === payslip.runNo ? 'Viewing' : 'View details'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {selected && (
            <section className={panel}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3 dark:border-slate-800">
                <div>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    Payslip {selected.periodKey}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {selected.employeeName} · {selected.employeeCode} · {selected.runNo}
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    {selected.branchName}
                    {selected.fiscalYearCode ? ` · FY ${selected.fiscalYearCode}` : ''}
                    {selected.paidDateAD ? ` · paid ${selected.paidDateAD}` : ''}
                    {selected.paymentMethod ? ` · ${selected.paymentMethod}` : ''}
                  </p>
                </div>
                <span className={statusBadge(selected.status)}>{selected.status}</span>
              </div>

              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <DetailField label="Employee code">{show(selected.employeeCode)}</DetailField>
                <DetailField label="Department">{show(selected.department)}</DetailField>
                <DetailField label="Designation">{show(selected.designation)}</DetailField>
                <DetailField label="Payable days">{selected.payableDays}</DetailField>
                <DetailField label="LOP days">{selected.lopDays}</DetailField>
                <DetailField label="Overtime hours">{selected.overtimeHours}</DetailField>
                <DetailField label="PAN">{show(selected.panNumber)}</DetailField>
                <DetailField label="SSF">{show(selected.ssfNumber)}</DetailField>
              </dl>

              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <div>
                  <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    Earnings
                  </h3>
                  <dl className="mt-2 space-y-1.5">
                    <DetailRow label="Basic salary">{money(selected.basicAmount)}</DetailRow>
                    <DetailRow label="Allowances">{money(selected.allowances)}</DetailRow>
                    <DetailRow label="Overtime">{money(selected.overtimeAmount)}</DetailRow>
                    <DetailRow label="Incentive">{money(selected.incentive)}</DetailRow>
                    <DetailRow label="Arrears">{money(selected.arrears)}</DetailRow>
                    <DetailRow label="Gross" strong>
                      {money(selected.gross)}
                    </DetailRow>
                  </dl>
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    Deductions
                  </h3>
                  <dl className="mt-2 space-y-1.5">
                    <DetailRow label="LOP deduction">{money(selected.lopDeduction)}</DetailRow>
                    <DetailRow label="TDS">{money(selected.tds)}</DetailRow>
                    <DetailRow label="SSF (employee)">{money(selected.ssf)}</DetailRow>
                    <DetailRow label="Advance recovery">{money(selected.advance)}</DetailRow>
                    <DetailRow label="Loan installment">{money(selected.loan)}</DetailRow>
                    <DetailRow label="Total deductions" strong>
                      {money(selected.totalDeductions)}
                    </DetailRow>
                    <DetailRow label="Net pay" strong>
                      {money(selected.net)}
                    </DetailRow>
                  </dl>
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    Employer & payment
                  </h3>
                  <dl className="mt-2 space-y-1.5">
                    <DetailRow label="Employer SSF">{money(selected.employerSsf)}</DetailRow>
                    <DetailRow label="Employer cost" strong>
                      {money(selected.employerCost)}
                    </DetailRow>
                    <DetailRow label="Bank">{show(selected.bankName)}</DetailRow>
                    <DetailRow label="Bank account">{show(selected.bankAccount)}</DetailRow>
                    <DetailRow label="Run date">{show(selected.runDateAD)}</DetailRow>
                    <DetailRow label="Paid date">{show(selected.paidDateAD)}</DetailRow>
                  </dl>
                </div>
              </div>

              <p className="mt-4 text-[10px] text-slate-400">
                This is the immutable figure set Finance posted for this run. HR/Payroll handles
                corrections; self-service cannot edit a payslip.
              </p>
            </section>
          )}

          <p className="text-[10px] text-slate-400">
            Only payslips for the employee linked to your login are returned. Draft and approved
            runs are excluded until Finance posts them.
          </p>
        </>
      )}
    </div>
  );
};

export default EmployeePayslips;
