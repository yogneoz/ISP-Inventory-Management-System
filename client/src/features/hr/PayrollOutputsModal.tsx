/**
 * Payroll outputs for a posted/paid run.
 *
 * The payslip and register are projections of the immutable run-line
 * snapshots; this modal only presents what the server returns. Printing uses a
 * dedicated document window so the app shell is never printed behind a narrow
 * table, and copying uses plain text for email or a bank file hand-off.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Download, FileText, Printer, Users, X } from 'lucide-react';
import { ModalPanel } from '../../components/common/ModalPanel';
import { api } from '../../services/api';
import type {
  HrPayrollOutputView,
  HrPayrollPayslip,
  HrPayrollPayslipsResponse,
  HrPayrollRegisterResponse,
  HrPayrollRegisterRow,
} from '../../services/api';

interface PayrollOutputsModalProps {
  runId: string;
  initialView: HrPayrollOutputView;
  branchName: string;
  canDownloadBankFile: boolean;
  onClose: () => void;
}

const money = (value: number | string): string =>
  Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] || character;
  });

const bankLabel = (row: HrPayrollRegisterRow | HrPayrollPayslip): string => {
  if (row.bankStatus === 'MISSING') return 'Missing bank details';
  if (row.detailsRestricted) return 'Restricted';
  return [row.bankName, row.bankAccount].filter(Boolean).join(' · ') || '—';
};

function printDocument(title: string, body: string): boolean {
  const printWindow = window.open('', '_blank', 'width=1040,height=760');
  if (!printWindow) return false;
  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { margin: 14mm; }
    body { color: #111827; font-family: Arial, sans-serif; font-size: 11px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 18px 0 6px; }
    p { margin: 2px 0; }
    .muted { color: #64748b; }
    .head { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; }
    th, td { border-bottom: 1px solid #cbd5e1; padding: 5px 6px; text-align: left; }
    th { background: #f1f5f9; font-size: 10px; text-transform: uppercase; }
    .right { text-align: right; }
    .strong { font-weight: 700; }
    .total td { border-top: 2px solid #111827; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .card { border: 1px solid #cbd5e1; padding: 10px; }
    .net { background: #f8fafc; border: 1px solid #94a3b8; padding: 10px; margin-top: 10px; }
    @media print { .noprint { display: none; } }
  </style>
</head>
<body>${body}</body>
</html>`);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 150);
  return true;
}

function registerHtml(data: HrPayrollRegisterResponse, branchName: string): string {
  const rows = data.rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.employeeName)}<br /><span class="muted">${escapeHtml(row.employeeCode)}</span></td>
        <td>${escapeHtml(bankLabel(row))}</td>
        <td class="right">${money(row.gross)}</td>
        <td class="right">${money(row.incentive)}</td>
        <td class="right">${money(row.arrears)}</td>
        <td class="right">${money(row.tds)}</td>
        <td class="right">${money(row.ssf)}</td>
        <td class="right">${money(row.advance)}</td>
        <td class="right">${money(row.loan)}</td>
        <td class="right strong">${money(row.net)}</td>
      </tr>`
    )
    .join('');
  return `<div class="head">
    <h1>Payroll Register</h1>
    <p>${escapeHtml(data.runNo)} · ${escapeHtml(data.periodKey)} · ${escapeHtml(branchName)}</p>
    <p class="muted">Run date ${escapeHtml(data.runDateAD)}${data.fiscalYearCode ? ` · FY ${escapeHtml(data.fiscalYearCode)}` : ''} · Status ${escapeHtml(data.status)}</p>
  </div>
  <table>
    <thead><tr><th>Employee</th><th>Bank / transfer</th><th class="right">Gross</th><th class="right">Incentive</th><th class="right">Arrears</th><th class="right">TDS</th><th class="right">SSF</th><th class="right">Advance</th><th class="right">Loan</th><th class="right">Net pay</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="total"><td colspan="2">Totals · ${data.totals.employees} employees</td><td class="right">${money(data.totals.gross)}</td><td class="right">${money(data.totals.incentive)}</td><td class="right">${money(data.totals.arrears)}</td><td class="right">${money(data.totals.tds)}</td><td class="right">${money(data.totals.ssf)}</td><td class="right">${money(data.totals.advance)}</td><td class="right">${money(data.totals.loan)}</td><td class="right">${money(data.totals.net)}</td></tr></tfoot>
  </table>
  <h2>Statutory breakdown</h2>
  <p>Employee SSF ${money(data.statutory.employeeSsf)} · Employer SSF ${money(data.statutory.employerSsf)} · TDS ${money(data.statutory.tds)}</p>
  <p>Deductions ${money(data.totals.deductions)} · Employer cost ${money(data.totals.employerCost)}</p>
  <p class="muted">${data.journal ? `Posting journal ${escapeHtml(data.journal.journalNo)} · debit ${money(data.journal.totalDebit)} · credit ${money(data.journal.totalCredit)}` : 'No posting journal is linked to this run.'}</p>
  <p class="muted">${data.reconciliation.matchesRun && data.reconciliation.matchesJournal ? 'Register reconciles to the run and posting journal.' : 'Register reconciliation needs review.'}</p>`;
}

function payslipHtml(payslip: HrPayrollPayslip, branchName: string): string {
  return `<div class="head">
    <h1>Payslip</h1>
    <p>${escapeHtml(payslip.runNo)} · ${escapeHtml(payslip.periodKey)} · ${escapeHtml(branchName)}</p>
    <p class="muted">Run date ${escapeHtml(payslip.runDateAD)}${payslip.fiscalYearCode ? ` · FY ${escapeHtml(payslip.fiscalYearCode)}` : ''} · Status ${escapeHtml(payslip.status)}</p>
  </div>
  <div class="grid">
    <div class="card">
      <p class="strong">${escapeHtml(payslip.employeeName)}</p>
      <p>${escapeHtml(payslip.employeeCode)}</p>
      <p>${escapeHtml(payslip.department || '—')} · ${escapeHtml(payslip.designation || '—')}</p>
      <p>PAN ${escapeHtml(payslip.panNumber || '—')} · SSF ${escapeHtml(payslip.ssfNumber || '—')}</p>
      <p>Bank ${escapeHtml(bankLabel(payslip))}</p>
    </div>
    <div class="card">
      <p><span class="muted">Basic salary</span> <span class="right">${money(payslip.basicAmount)}</span></p>
      <p><span class="muted">Allowances</span> <span class="right">${money(payslip.allowances)}</span></p>
      <p><span class="muted">Overtime</span> <span class="right">${money(payslip.overtimeAmount)}</span></p>
      <p><span class="muted">Incentive</span> <span class="right">${money(payslip.incentive)}</span></p>
      <p><span class="muted">Arrears</span> <span class="right">${money(payslip.arrears)}</span></p>
      <p><span class="muted">LOP deduction</span> <span class="right">(${money(payslip.lopDeduction)})</span></p>
      <p><span class="muted">Gross</span> <span class="right strong">${money(payslip.gross)}</span></p>
    </div>
  </div>
  <table>
    <thead><tr><th>Deduction</th><th class="right">Amount</th></tr></thead>
    <tbody>
      <tr><td>Employee SSF</td><td class="right">${money(payslip.ssf)}</td></tr>
      <tr><td>TDS</td><td class="right">${money(payslip.tds)}</td></tr>
      <tr><td>Advance recovery</td><td class="right">${money(payslip.advance)}</td></tr>
      <tr><td>Loan recovery</td><td class="right">${money(payslip.loan)}</td></tr>
      <tr class="total"><td>Net pay</td><td class="right">${money(payslip.net)}</td></tr>
    </tbody>
  </table>
  <div class="net"><span class="muted">Employer SSF (cost only)</span> <span class="strong right">${money(payslip.employerSsf)}</span> · <span class="muted">Employer cost</span> <span class="strong right">${money(payslip.employerCost)}</span></div>
  ${payslip.detailsRestricted ? '<p class="muted">PAN, SSF and bank details are restricted for this account.</p>' : ''}`;
}

function registerText(data: HrPayrollRegisterResponse, branchName: string): string {
  const lines = [
    `Payroll Register · ${data.runNo} · ${data.periodKey} · ${branchName}`,
    'Employee\tCode\tBank / transfer\tGross\tIncentive\tArrears\tTDS\tSSF\tAdvance\tLoan\tNet',
    ...data.rows.map((row) =>
      [
        row.employeeName,
        row.employeeCode,
        bankLabel(row),
        money(row.gross),
        money(row.incentive),
        money(row.arrears),
        money(row.tds),
        money(row.ssf),
        money(row.advance),
        money(row.loan),
        money(row.net),
      ].join('\t')
    ),
    `Totals\t${data.totals.employees}\t\t${money(data.totals.gross)}\t${money(data.totals.incentive)}\t${money(data.totals.arrears)}\t${money(data.totals.tds)}\t${money(data.totals.ssf)}\t${money(data.totals.advance)}\t${money(data.totals.loan)}\t${money(data.totals.net)}`,
    `Statutory\tEmployee SSF ${money(data.statutory.employeeSsf)}\tEmployer SSF ${money(data.statutory.employerSsf)}\tTDS ${money(data.statutory.tds)}`,
  ];
  return lines.join('\n');
}

function payslipText(payslip: HrPayrollPayslip, branchName: string): string {
  return [
    `Payslip · ${payslip.runNo} · ${payslip.periodKey} · ${branchName}`,
    `${payslip.employeeName} (${payslip.employeeCode})`,
    `Gross\t${money(payslip.gross)}`,
    `Basic\t${money(payslip.basicAmount)}`,
    `Allowances\t${money(payslip.allowances)}`,
    `Overtime\t${money(payslip.overtimeAmount)}`,
    `Incentive\t${money(payslip.incentive)}`,
    `Arrears\t${money(payslip.arrears)}`,
    `LOP deduction\t${money(payslip.lopDeduction)}`,
    `Employee SSF\t${money(payslip.ssf)}`,
    `TDS\t${money(payslip.tds)}`,
    `Advance\t${money(payslip.advance)}`,
    `Loan\t${money(payslip.loan)}`,
    `Net pay\t${money(payslip.net)}`,
    `Employer SSF\t${money(payslip.employerSsf)}`,
  ].join('\n');
}

export const PayrollOutputsModal: React.FC<PayrollOutputsModalProps> = ({
  runId,
  initialView,
  branchName,
  canDownloadBankFile,
  onClose,
}) => {
  const [view, setView] = useState<HrPayrollOutputView>(initialView);
  const [payslips, setPayslips] = useState<HrPayrollPayslipsResponse | null>(null);
  const [register, setRegister] = useState<HrPayrollRegisterResponse | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bankFileBusy, setBankFileBusy] = useState(false);
  const [bankFileNotice, setBankFileNotice] = useState<{
    kind: 'ok' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([api.getHrPayrollPayslips(runId), api.getHrPayrollRegister(runId)])
      .then(([payslipResponse, registerResponse]) => {
        if (!active) return;
        setPayslips(payslipResponse);
        setRegister(registerResponse);
        setSelectedEmployeeId((current) =>
          current && payslipResponse.payslips.some((row) => row.employeeId === current)
            ? current
            : payslipResponse.payslips[0]?.employeeId || ''
        );
      })
      .catch((err: any) => {
        if (active) setError(err?.message || 'Payroll outputs could not be read.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [runId]);

  const run = register || payslips;
  const selectedPayslip = useMemo(
    () => payslips?.payslips.find((row) => row.employeeId === selectedEmployeeId) || null,
    [payslips, selectedEmployeeId]
  );
  const activeBranch = run?.branchName || branchName;

  const handlePrint = () => {
    if (!run) return;
    const printed =
      view === 'REGISTER'
        ? printDocument('Payroll Register', registerHtml(register!, activeBranch))
        : selectedPayslip
          ? printDocument('Payslip', payslipHtml(selectedPayslip, activeBranch))
          : false;
    if (!printed) setNotice('Allow pop-ups to print this payroll output.');
  };

  const handleCopy = async () => {
    if (!run) return;
    try {
      const text =
        view === 'REGISTER'
          ? registerText(register!, activeBranch)
          : selectedPayslip
            ? payslipText(selectedPayslip, activeBranch)
            : '';
      await navigator.clipboard.writeText(text);
      setNotice(view === 'REGISTER' ? 'Register copied.' : 'Payslip copied.');
    } catch {
      setNotice('Copy failed. Select the table text and copy it manually.');
    }
  };

  const handleBankFile = async () => {
    if (!register || !register.rows.length || bankFileBusy) return;
    setBankFileBusy(true);
    setBankFileNotice(null);
    try {
      const filename = await api.downloadHrPayrollBankFile(runId);
      setBankFileNotice({ kind: 'ok', text: `${filename} downloaded.` });
    } catch (err: any) {
      setBankFileNotice({
        kind: 'error',
        text: err?.message || 'The bank file could not be downloaded.',
      });
    } finally {
      setBankFileBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <ModalPanel
        label="Payroll outputs"
        onClose={onClose}
        className="max-h-[92vh] w-full max-w-6xl overflow-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
      >
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold">Payroll outputs</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {run ? `${run.runNo} · ${run.periodKey} · ${activeBranch}` : 'Loading posted run…'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
              {(
                [
                  { value: 'REGISTER', label: 'Register', icon: Users },
                  { value: 'PAYSLIPS', label: 'Payslips', icon: FileText },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => setView(tab.value)}
                    aria-pressed={view === tab.value}
                    className={`flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                      view === tab.value
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="h-3 w-3" /> {tab.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!run}
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={!run}
              className="flex cursor-pointer items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              <Printer className="h-3 w-3" /> Print
            </button>
            {canDownloadBankFile &&
              register &&
              register.rows.length > 0 &&
              register.rows.every((row) => !row.detailsRestricted) && (
                <button
                  type="button"
                  onClick={() => void handleBankFile()}
                  disabled={bankFileBusy}
                  title="Download the bank transfer CSV for this run"
                  className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Download className="h-3 w-3" />
                  {bankFileBusy ? 'Preparing…' : 'Bank file'}
                </button>
              )}
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
              aria-label="Close payroll outputs"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {notice && (
          <div className="mb-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-[11px] text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300">
            {notice}
          </div>
        )}
        {bankFileNotice && (
          <div
            role={bankFileNotice.kind === 'error' ? 'alert' : 'status'}
            className={`mb-2 rounded-lg border px-3 py-1.5 text-[11px] ${
              bankFileNotice.kind === 'error'
                ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'
            }`}
          >
            {bankFileNotice.text}
          </div>
        )}
        {loading && <div className="py-10 text-center text-[11px] text-slate-500">Loading posted outputs…</div>}
        {error && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            {error}
          </div>
        )}

        {!loading && !error && view === 'REGISTER' && register && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                { label: 'Gross', value: register.totals.gross },
                { label: 'Employee SSF', value: register.statutory.employeeSsf },
                { label: 'Employer SSF', value: register.statutory.employerSsf },
                { label: 'TDS', value: register.statutory.tds },
                { label: 'Net pay', value: register.totals.net },
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
                </div>
              ))}
            </div>
            <div className="mt-2 max-h-[52vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full min-w-[1180px] text-left text-[11px]">
                <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/80">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">Employee</th>
                    <th className="px-2 py-1.5 font-semibold">Bank / transfer</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Gross</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Incentive</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Arrears</th>
                    <th className="px-2 py-1.5 text-right font-semibold">TDS</th>
                    <th className="px-2 py-1.5 text-right font-semibold">SSF</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Advance</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Loan</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Net pay</th>
                  </tr>
                </thead>
                <tbody>
                  {register.rows.map((row) => (
                    <tr key={row.employeeId} className="border-t border-slate-100 dark:border-slate-800/70">
                      <td className="px-2 py-1.5">
                        <div className="font-semibold text-slate-700 dark:text-slate-200">
                          {row.employeeName}
                        </div>
                        <div className="font-mono text-[10px] text-slate-500">{row.employeeCode}</div>
                      </td>
                      <td className="px-2 py-1.5 text-slate-500">{bankLabel(row)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.gross)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.incentive)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.arrears)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.tds)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.ssf)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.advance)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{money(row.loan)}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(row.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-500 dark:border-slate-800 dark:bg-slate-900/40">
              <span>
                {register.journal
                  ? `Journal ${register.journal.journalNo} · debit ${money(register.journal.totalDebit)} · credit ${money(register.journal.totalCredit)}`
                  : 'No posting journal linked.'}
              </span>
              <span
                className={
                  register.reconciliation.matchesRun && register.reconciliation.matchesJournal
                    ? 'font-semibold text-emerald-600 dark:text-emerald-300'
                    : 'font-semibold text-amber-600 dark:text-amber-300'
                }
              >
                {register.reconciliation.matchesRun && register.reconciliation.matchesJournal
                  ? 'Reconciles to run and journal'
                  : 'Reconciliation needs review'}
              </span>
            </div>
          </>
        )}

        {!loading && !error && view === 'PAYSLIPS' && payslips && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="max-h-[62vh] overflow-auto rounded-lg border border-slate-200 p-1 dark:border-slate-800">
              {payslips.payslips.map((payslip) => (
                <button
                  key={payslip.employeeId}
                  type="button"
                  onClick={() => setSelectedEmployeeId(payslip.employeeId)}
                  className={`mb-1 w-full cursor-pointer rounded-lg px-2 py-1.5 text-left last:mb-0 ${
                    payslip.employeeId === selectedEmployeeId
                      ? 'bg-indigo-50 text-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-200'
                      : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="text-[11px] font-semibold">{payslip.employeeName}</div>
                  <div className="font-mono text-[10px] text-slate-500">
                    {payslip.employeeCode} · {money(payslip.net)}
                  </div>
                </button>
              ))}
            </div>
            {selectedPayslip ? (
              <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 pb-2 dark:border-slate-800">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Employee
                    </div>
                    <div className="text-sm font-bold">{selectedPayslip.employeeName}</div>
                    <div className="text-[11px] text-slate-500">
                      {selectedPayslip.employeeCode} · {selectedPayslip.department || '—'} ·{' '}
                      {selectedPayslip.designation || '—'}
                    </div>
                    <div className="mt-1 text-[10px] text-slate-500">
                      PAN {selectedPayslip.panNumber || '—'} · SSF {selectedPayslip.ssfNumber || '—'} ·
                      Bank {bankLabel(selectedPayslip)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Net pay
                    </div>
                    <div className="font-mono text-lg font-bold">{money(selectedPayslip.net)}</div>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    { label: 'Basic', value: selectedPayslip.basicAmount },
                    { label: 'Allowances', value: selectedPayslip.allowances },
                    { label: 'Overtime', value: selectedPayslip.overtimeAmount },
                    { label: 'Incentive', value: selectedPayslip.incentive },
                    { label: 'Arrears', value: selectedPayslip.arrears },
                    { label: 'LOP', value: selectedPayslip.lopDeduction },
                    { label: 'Gross', value: selectedPayslip.gross },
                    { label: 'Employee SSF', value: selectedPayslip.ssf },
                    { label: 'TDS', value: selectedPayslip.tds },
                    { label: 'Employer SSF', value: selectedPayslip.employerSsf },
                  ].map((card) => (
                    <div
                      key={card.label}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900/40"
                    >
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {card.label}
                      </div>
                      <div className="font-mono text-xs font-semibold">{money(card.value)}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] dark:border-slate-800">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Deductions
                    </div>
                    <div className="flex justify-between"><span>Employee SSF</span><span className="font-mono">{money(selectedPayslip.ssf)}</span></div>
                    <div className="flex justify-between"><span>TDS</span><span className="font-mono">{money(selectedPayslip.tds)}</span></div>
                    <div className="flex justify-between"><span>Advance</span><span className="font-mono">{money(selectedPayslip.advance)}</span></div>
                    <div className="flex justify-between"><span>Loan</span><span className="font-mono">{money(selectedPayslip.loan)}</span></div>
                    <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold dark:border-slate-800"><span>Total</span><span className="font-mono">{money(selectedPayslip.totalDeductions)}</span></div>
                  </div>
                  <div className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] dark:border-slate-800">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Run
                    </div>
                    <div className="flex justify-between"><span>Period</span><span>{selectedPayslip.periodKey}</span></div>
                    <div className="flex justify-between"><span>Run date</span><span>{selectedPayslip.runDateAD}</span></div>
                    <div className="flex justify-between"><span>Fiscal year</span><span>{selectedPayslip.fiscalYearCode || '—'}</span></div>
                    <div className="flex justify-between"><span>Payment method</span><span>{selectedPayslip.paymentMethod || '—'}</span></div>
                    <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold dark:border-slate-800"><span>Employer cost</span><span className="font-mono">{money(selectedPayslip.employerCost)}</span></div>
                  </div>
                </div>
                {selectedPayslip.detailsRestricted && (
                  <p className="mt-2 text-[10px] text-slate-500">
                    PAN, SSF and bank details are restricted for this account.
                  </p>
                )}
              </div>
            ) : (
              <div className="py-10 text-center text-[11px] text-slate-500">
                This run has no payslip rows.
              </div>
            )}
          </div>
        )}
      </ModalPanel>
    </div>
  );
};

export default PayrollOutputsModal;
