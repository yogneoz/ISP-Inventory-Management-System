/**
 * Employee Ledger — the party-centric view of every EMPLOYEE subledger row.
 *
 * A payroll run writes one EMPLOYEE book per control account, so the generic
 * Subledgers register can only show one control account at a time. This screen
 * reads the dedicated employee endpoint instead: all of that employee's salary
 * payable, TDS, SSF, advance and loan movements in one place, with opening and
 * closing balances per account and a running balance in each account's natural
 * direction.
 *
 * Read-only by design. Posting stays with payroll and the manual journal.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Download,
  RefreshCw,
  Users,
} from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import { PageHeader } from '../../components/common/PageHeader';
import { SearchPicker } from '../../components/common/SearchPicker';
import { KpiStrip } from '../../components/common/KpiStrip';
import { inputClass, labelClass } from '../../components/common/styleConstants';
import { api } from '../../services/api';
import type {
  AccountingEmployee,
  EmployeeLedgerAccount,
  EmployeeLedgerEntry,
  EmployeeLedgerResponse,
} from '../../services/api';
import type { Branch } from '../../types';
import { createLatestOnly } from '../../utils/latestOnly';
import { exportToCSV, type CSVColumn } from '../../utils/exportUtils';
import { formatMoney, formatNumber } from '../../utils/nprFormat';
import { localTodayAD } from '../../utils/localDate';
import { useBootstrapData } from '../../contexts/AppProviders';

interface EmployeeLedgerProps {
  dateMode: 'BS' | 'AD';
  /** Current fiscal-year start; the first load defaults From to this date. */
  fiscalYearStartAD?: string;
  /** An HR directory row can open this report with one employee selected. */
  focusRequest?: { partyId: string; partyLabel?: string; token: number } | null;
}

interface DetailRow {
  entry: EmployeeLedgerEntry;
  balance: number;
}

interface DetailGroup {
  account: EmployeeLedgerAccount;
  rows: DetailRow[];
}

const money = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

const debitNatural = (accountType: string): boolean =>
  accountType === 'ASSET' || accountType === 'EXPENSE';

const humanize = (value: string | null | undefined): string =>
  String(value || '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const entrySource = (entry: EmployeeLedgerEntry): string => {
  if (entry.reversalOfId) return 'Reversal';
  const source = humanize(entry.sourceType);
  return source || 'Journal';
};

/**
 * One CSV row for every opening, movement and closing line, so the exported
 * document is a complete re-print of the screen rather than only the entries.
 */
interface ExportRow {
  accountCode: string;
  accountName: string;
  rowType: string;
  dateAD: string;
  dateBS: string;
  journalNo: string;
  source: string;
  reference: string;
  memo: string;
  debit: number | '';
  credit: number | '';
  balance: number;
}

const EXPORT_COLUMNS: CSVColumn<ExportRow>[] = [
  { key: 'accountCode', label: 'Ledger Code' },
  { key: 'accountName', label: 'Ledger' },
  { key: 'rowType', label: 'Row' },
  { key: 'dateAD', label: 'Date (AD)' },
  { key: 'dateBS', label: 'Date (BS)' },
  { key: 'journalNo', label: 'Journal No' },
  { key: 'source', label: 'Source' },
  { key: 'reference', label: 'Reference' },
  { key: 'memo', label: 'Remarks' },
  { key: 'debit', label: 'Debit (NPR)' },
  { key: 'credit', label: 'Credit (NPR)' },
  { key: 'balance', label: 'Running Balance (NPR)' },
];

export const EmployeeLedger: React.FC<EmployeeLedgerProps> = ({
  dateMode,
  fiscalYearStartAD,
  focusRequest,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [selectedEmployeeLabel, setSelectedEmployeeLabel] = useState('');
  const [fromAD, setFromAD] = useState(() => fiscalYearStartAD || '');
  const [toAD, setToAD] = useState(() => localTodayAD());
  const [ledger, setLedger] = useState<EmployeeLedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fetchSeq = useRef(createLatestOnly()).current;

  const branchLabel = useMemo(() => {
    const branchId = ledger?.branchId || '';
    const branch = branches.find((row) => row.id === branchId);
    return branch ? `${branch.code} · ${branch.name}` : branchId || '—';
  }, [branches, ledger?.branchId]);

  const fetchLedger = async (employeeId: string, from: string, to: string) => {
    if (!employeeId) {
      setLedger(null);
      return;
    }
    if (from && to && from > to) {
      setError('From date must not be after To date.');
      setLedger(null);
      return;
    }
    const ticket = fetchSeq.begin();
    setLoading(true);
    setError('');
    try {
      const data = await api.getEmployeeLedger(employeeId, {
        from: from || undefined,
        to: to || undefined,
      });
      if (!fetchSeq.isCurrent(ticket)) return;
      setLedger(data);
      setSelectedEmployeeLabel(`${data.employee.name} (${data.employee.employeeCode})`);
    } catch (err: any) {
      if (!fetchSeq.isCurrent(ticket)) return;
      setLedger(null);
      setError(err?.message || 'The employee ledger could not be read.');
    } finally {
      if (fetchSeq.isCurrent(ticket)) setLoading(false);
    }
  };

  const searchEmployees = useCallback(
    (query: string) => api.getAccountingEmployees(undefined, query, 20),
    []
  );

  const activationKey = useActivationKey('employee-ledger');
  const isVisible = useTabActive('employee-ledger');

  useEffect(() => {
    if (!focusRequest?.partyId) return;
    setSelectedEmployeeId(focusRequest.partyId);
    setSelectedEmployeeLabel(focusRequest.partyLabel || focusRequest.partyId);
    setLedger(null);
    setError('');
    void fetchLedger(focusRequest.partyId, fromAD, toAD);
    // The token is the explicit re-focus signal; the current range is captured
    // when the directory click happens, not every time the user edits a date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.token]);

  useEffect(() => {
    if (!isVisible || !selectedEmployeeId) return;
    void fetchLedger(selectedEmployeeId, fromAD, toAD);
    // Date edits apply through the Apply/Refresh action; this effect is the
    // mount/re-activation read for the currently selected employee.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, isVisible]);

  const summaryAccounts = useMemo(() => {
    const accountsWithEntries = new Set((ledger?.entries || []).map((entry) => entry.accountId));
    return (ledger?.accounts || []).filter(
      (account) =>
        accountsWithEntries.has(account.accountId) ||
        account.openingBalance !== 0 ||
        account.debit !== 0 ||
        account.credit !== 0 ||
        account.closingBalance !== 0
    );
  }, [ledger]);

  const detailGroups = useMemo<DetailGroup[]>(() => {
    if (!ledger) return [];
    const byAccount = new Map<string, EmployeeLedgerEntry[]>();
    for (const entry of ledger.entries) {
      const rows = byAccount.get(entry.accountId) || [];
      rows.push(entry);
      byAccount.set(entry.accountId, rows);
    }
    return summaryAccounts
      .map((account) => {
        let running = money(account.presentedOpeningBalance);
        const rows = (byAccount.get(account.accountId) || []).map((entry) => {
          running = money(
            running +
              (debitNatural(account.accountType)
                ? entry.debit - entry.credit
                : entry.credit - entry.debit)
          );
          return { entry, balance: running };
        });
        return { account, rows };
      })
      .filter(
        (group) =>
          group.rows.length > 0 ||
          group.account.presentedOpeningBalance !== 0 ||
          group.account.presentedClosingBalance !== 0
      );
  }, [ledger, summaryAccounts]);

  const openingPayable = useMemo(
    () =>
      money(
        summaryAccounts
          .filter((account) => !debitNatural(account.accountType))
          .reduce((sum, account) => sum + account.presentedOpeningBalance, 0)
      ),
    [summaryAccounts]
  );
  const openingAdvance = useMemo(
    () =>
      money(
        summaryAccounts
          .filter((account) => debitNatural(account.accountType))
          .reduce((sum, account) => sum + account.presentedOpeningBalance, 0)
      ),
    [summaryAccounts]
  );
  const closingPayable = useMemo(
    () =>
      money(
        summaryAccounts
          .filter((account) => !debitNatural(account.accountType))
          .reduce((sum, account) => sum + account.presentedClosingBalance, 0)
      ),
    [summaryAccounts]
  );
  const closingAdvance = useMemo(
    () =>
      money(
        summaryAccounts
          .filter((account) => debitNatural(account.accountType))
          .reduce((sum, account) => sum + account.presentedClosingBalance, 0)
      ),
    [summaryAccounts]
  );

  const hasRows = summaryAccounts.length > 0;

  const handleSelect = (employee: AccountingEmployee | null) => {
    if (!employee) {
      setSelectedEmployeeId('');
      setSelectedEmployeeLabel('');
      setLedger(null);
      setError('');
      return;
    }
    setSelectedEmployeeId(employee.id);
    setSelectedEmployeeLabel(`${employee.name} (${employee.employeeCode})`);
    void fetchLedger(employee.id, fromAD, toAD);
  };

  const handleApply = () => {
    if (!selectedEmployeeId) return;
    void fetchLedger(selectedEmployeeId, fromAD, toAD);
  };

  const handleRefresh = () => {
    if (selectedEmployeeId) void fetchLedger(selectedEmployeeId, fromAD, toAD);
  };

  const handleExport = () => {
    if (!ledger || !hasRows) return;
    const rows: ExportRow[] = [];
    for (const group of detailGroups) {
      rows.push({
        accountCode: group.account.code,
        accountName: group.account.name,
        rowType: 'Opening',
        dateAD: '',
        dateBS: '',
        journalNo: '',
        source: '',
        reference: '',
        memo: 'Balance brought forward',
        debit: '',
        credit: '',
        balance: group.account.presentedOpeningBalance,
      });
      for (const row of group.rows) {
        rows.push({
          accountCode: group.account.code,
          accountName: group.account.name,
          rowType: 'Entry',
          dateAD: row.entry.entryDateAD,
          dateBS: row.entry.entryDateBS || '',
          journalNo: row.entry.journalNo,
          source: entrySource(row.entry),
          reference: row.entry.referenceNo || '',
          memo: row.entry.memo || '',
          debit: row.entry.debit || '',
          credit: row.entry.credit || '',
          balance: row.balance,
        });
      }
      rows.push({
        accountCode: group.account.code,
        accountName: group.account.name,
        rowType: 'Closing',
        dateAD: '',
        dateBS: '',
        journalNo: '',
        source: '',
        reference: '',
        memo: 'Closing balance',
        debit: '',
        credit: '',
        balance: group.account.presentedClosingBalance,
      });
    }
    const employee = ledger.employee;
    exportToCSV({
      filename: `Employee_Ledger_${employee.employeeCode}`,
      data: rows,
      columns: EXPORT_COLUMNS,
      reportTitle: `Employee Ledger — ${employee.name} (${employee.employeeCode})`,
      branchName: branchLabel,
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employee Ledger"
        description="Every posted EMPLOYEE subledger movement — salary payable, TDS, SSF, advances and loans — with opening, period and closing balances per control account. Read-only."
        icon={<Users className="h-5 w-5 text-indigo-500" />}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={!selectedEmployeeId || loading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={!hasRows}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <label className={labelClass} htmlFor="employee-ledger-picker">
            Employee
          </label>
          <SearchPicker<AccountingEmployee>
            inputId="employee-ledger-picker"
            value={
              selectedEmployeeId
                ? { id: selectedEmployeeId, label: selectedEmployeeLabel || selectedEmployeeId }
                : null
            }
            onSelect={handleSelect}
            search={searchEmployees}
            itemKey={(employee) => employee.id}
            itemLabel={(employee) => `${employee.name} (${employee.employeeCode})`}
            placeholder="Search by employee name or code…"
            ariaLabel="Search employees for the ledger"
            labels={{
              hint: 'Type a name or employee code to search the branches you can read.',
              loading: 'Searching employees…',
              empty: 'No employee matches this search.',
              error: 'Could not search the employee master.',
            }}
            renderOption={(employee) => (
              <div className="min-w-0 pr-2">
                <div className="break-words text-xs font-semibold leading-snug text-slate-900 dark:text-white">
                  {employee.name}{' '}
                  <span className="whitespace-nowrap font-mono text-[10px] text-slate-500 dark:text-slate-400">
                    ({employee.employeeCode})
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                  {[employee.department, employee.designation].filter(Boolean).join(' · ') || 'No department or designation'}
                </div>
              </div>
            )}
          />
        </div>
        <div className="lg:col-span-3">
          <label className={labelClass} htmlFor="employee-ledger-from">
            From (AD)
          </label>
          <input
            id="employee-ledger-from"
            type="date"
            className={inputClass}
            value={fromAD}
            onChange={(event) => setFromAD(event.target.value)}
          />
        </div>
        <div className="lg:col-span-3">
          <label className={labelClass} htmlFor="employee-ledger-to">
            To (AD)
          </label>
          <input
            id="employee-ledger-to"
            type="date"
            className={inputClass}
            value={toAD}
            onChange={(event) => setToAD(event.target.value)}
          />
        </div>
        <div className="flex items-end lg:col-span-1">
          <button
            type="button"
            onClick={handleApply}
            disabled={!selectedEmployeeId || loading}
            className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"
        >
          {error}
        </div>
      )}

      {!selectedEmployeeId && !error && (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-12 text-center dark:border-slate-700 dark:bg-slate-900/40">
          <BookOpen className="mx-auto mb-3 h-10 w-10 text-slate-300 dark:text-slate-600" />
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Select an employee to read their ledger
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            The report covers every control account the employee has posted to, not one book at a time.
          </p>
        </div>
      )}

      {ledger && selectedEmployeeId && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  {ledger.employee.name}{' '}
                  <span className="font-mono text-xs font-medium text-slate-500 dark:text-slate-400">
                    ({ledger.employee.employeeCode})
                  </span>
                </h3>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {[ledger.employee.department, ledger.employee.designation].filter(Boolean).join(' · ') ||
                    'No department or designation'}{' '}
                  · {branchLabel} · Local currency (NPR)
                </p>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {ledger.from || 'Beginning'} to {ledger.to || 'latest posted'} ·{' '}
                {ledger.entries.length} posted line{ledger.entries.length === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          <KpiStrip
            items={[
              {
                label: 'Opening payable',
                value: formatMoney(openingPayable),
                tone: 'text-rose-500 dark:text-rose-400',
                hint: `Advance / loan ${formatMoney(openingAdvance)}`,
              },
              {
                label: 'Period debit',
                value: formatMoney(ledger.totals.debit),
                tone: 'text-emerald-500 dark:text-emerald-400',
                hint: 'Payments and recoveries',
              },
              {
                label: 'Period credit',
                value: formatMoney(ledger.totals.credit),
                tone: 'text-rose-500 dark:text-rose-400',
                hint: 'Salary, TDS, SSF, advance and loan charges',
              },
              {
                label: 'Closing payable',
                value: formatMoney(closingPayable),
                tone: 'text-rose-500 dark:text-rose-400',
                hint: `Advance / loan ${formatMoney(closingAdvance)}`,
              },
            ]}
          />

          {ledger.unlinkedCount > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {ledger.unlinkedCount} employee row
                {ledger.unlinkedCount === 1 ? '' : 's'} in this window still carry no subledger book id.
                They are included here by employee party, but the Subledgers register cannot attribute them
                to a named book until that book exists.
              </p>
            </div>
          )}

          {!hasRows ? (
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-12 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
              No posted employee-ledger movements were found for this employee and date range.
            </div>
          ) : (
            <>
              <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
                <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">Summary by ledger</h3>
                  <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    Opening is posted history before the From date; closing includes the selected period.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-xs">
                    <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:bg-slate-800/80 dark:text-slate-300">
                      <tr>
                        <th className="px-3 py-2">Ledger</th>
                        <th className="px-3 py-2">Control role</th>
                        <th className="px-3 py-2 text-right">Opening</th>
                        <th className="px-3 py-2 text-right">Debit</th>
                        <th className="px-3 py-2 text-right">Credit</th>
                        <th className="px-3 py-2 text-right">Closing</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {summaryAccounts.map((account) => (
                        <tr key={account.accountId} className="text-slate-700 dark:text-slate-300">
                          <td className="px-3 py-2">
                            <span className="font-mono text-[11px] text-indigo-600 dark:text-indigo-400">
                              {account.code}
                            </span>{' '}
                            <span className="font-semibold">{account.name}</span>
                          </td>
                          <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                            {humanize(account.postingRole) || account.accountType}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatNumber(account.presentedOpeningBalance)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-700 dark:text-emerald-400">
                            {formatNumber(account.debit)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-rose-700 dark:text-rose-400">
                            {formatNumber(account.credit)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold">
                            {formatNumber(account.presentedClosingBalance)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {detailGroups.map((group) => (
                <section
                  key={group.account.accountId}
                  className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                        <span className="font-mono text-indigo-600 dark:text-indigo-400">
                          {group.account.code}
                        </span>{' '}
                        {group.account.name}
                      </h3>
                      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                        {humanize(group.account.postingRole) || group.account.accountType} ·{' '}
                        {group.rows.length} movement{group.rows.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Closing
                      </p>
                      <p className="font-mono text-sm font-bold text-slate-900 dark:text-white">
                        {formatMoney(group.account.presentedClosingBalance)}
                      </p>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[840px] text-left text-[11px]">
                      <thead className="border-b border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:bg-slate-800/80 dark:text-slate-300">
                        <tr>
                          <th className="px-3 py-2">Date</th>
                          <th className="px-3 py-2">Journal / source</th>
                          <th className="px-3 py-2">Remarks</th>
                          <th className="px-3 py-2 text-right">Debit</th>
                          <th className="px-3 py-2 text-right">Credit</th>
                          <th className="px-3 py-2 text-right">Running balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        <tr className="bg-slate-50/70 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
                          <td className="px-3 py-2" colSpan={3}>
                            <span className="font-semibold">Opening balance</span>
                          </td>
                          <td className="px-3 py-2 text-right text-slate-400">—</td>
                          <td className="px-3 py-2 text-right text-slate-400">—</td>
                          <td className="px-3 py-2 text-right font-mono font-semibold">
                            {formatNumber(group.account.presentedOpeningBalance)}
                          </td>
                        </tr>
                        {group.rows.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                              No movements in this window.
                            </td>
                          </tr>
                        ) : (
                          group.rows.map(({ entry, balance }) => (
                            <tr key={entry.id} className="text-slate-700 dark:text-slate-300">
                              <td className="px-3 py-2 whitespace-nowrap">
                                <span className="font-mono">
                                  {dateMode === 'BS' ? entry.entryDateBS || '—' : entry.entryDateAD}
                                </span>
                                <span className="mt-0.5 block text-[10px] text-slate-400 dark:text-slate-500">
                                  {dateMode === 'BS' ? entry.entryDateAD : entry.entryDateBS || '—'}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">
                                  {entry.journalNo}
                                </span>
                                <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                                  {entrySource(entry)}
                                  {entry.referenceNo ? ` · ${entry.referenceNo}` : ''}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                                {entry.memo || '—'}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-emerald-700 dark:text-emerald-400">
                                {entry.debit ? formatNumber(entry.debit) : '—'}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-rose-700 dark:text-rose-400">
                                {entry.credit ? formatNumber(entry.credit) : '—'}
                              </td>
                              <td className="px-3 py-2 text-right font-mono font-semibold">
                                {formatNumber(balance)}
                              </td>
                            </tr>
                          ))
                        )}
                        <tr className="bg-slate-50/70 text-slate-800 dark:bg-slate-800/40 dark:text-slate-100">
                          <td className="px-3 py-2 font-semibold" colSpan={3}>
                            Closing balance
                          </td>
                          <td className="px-3 py-2 text-right text-slate-400">—</td>
                          <td className="px-3 py-2 text-right text-slate-400">—</td>
                          <td className="px-3 py-2 text-right font-mono font-bold">
                            {formatNumber(group.account.presentedClosingBalance)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
};

export default EmployeeLedger;
