/**
 * SSF payable reconciliation, derived from aggregate rows.
 *
 * The control account has to carry exactly what the posted runs say the fund is
 * owed. That is the reconciliation: `controlBalance` (credits less debits on the
 * SSF payable account, POSTED journals, same period and branch scope) against
 * `payable` (employee + employer SSF captured on the run lines, which is what
 * the journal credited).
 *
 * The configured contribution is a second, weaker comparison. It applies the
 * run's statutory-config rates to each line's basic pay, so it answers "do the
 * rates on file still explain what was paid?". It is deliberately NOT part of
 * the ledger verdict: a configuration edited between preparing and posting a run
 * legitimately leaves the snapshot on the old rates — the product's own rule is
 * that a prepared snapshot survives a rule edit — and the control account is
 * still correct. That case reports `ratesMatch: false` with a `rateNote`, while
 * `matches` stays true because the money is where it should be.
 *
 * `matches` is null when the chart has no SSF_PAYABLE posting default: there is
 * nothing to compare the contributions against.
 *
 * The per-employee rows say WHERE a branch-level difference comes from. They are
 * ordered by absolute difference, and `unattributedControl` carries whatever the
 * account holds that no employee row claims (a control line posted without a
 * party), so the rows plus the remainder always add back to `difference`.
 */
export interface SsfReconciliationInput {
  employeeSsf?: number | string | null;
  employerSsf?: number | string | null;
  configuredEmployeeSsf?: number | string | null;
  configuredEmployerSsf?: number | string | null;
  rateMismatchLines?: number | string | null;
  unconfiguredLines?: number | string | null;
  controlBalance?: number | string | null;
  controlLineCount?: number | string | null;
  controlAccountCode?: string | null;
  controlAccountName?: string | null;
}

export interface SsfEmployeeInput {
  employeeId?: string | null;
  employeeCode?: string | null;
  employeeName?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  lineCount?: number | string | null;
  employeeSsf?: number | string | null;
  employerSsf?: number | string | null;
  configuredEmployeeSsf?: number | string | null;
  configuredEmployerSsf?: number | string | null;
  rateMismatchLines?: number | string | null;
  unconfiguredLines?: number | string | null;
  controlBalance?: number | string | null;
}

export interface SsfEmployeeRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  branchName: string;
  lineCount: number;
  employeeSsf: number;
  employerSsf: number;
  payable: number;
  configuredEmployeeSsf: number;
  configuredEmployerSsf: number;
  configured: number;
  /** Credits less debits on this employee's SSF payable subledger row. */
  controlBalance: number;
  /** Control balance − payable. */
  difference: number;
  rateMismatchLines: number;
  unconfiguredLines: number;
  /** The control account ties to this employee's payable. */
  matches: boolean;
  /** The snapshot still agrees with the run's configured rates. */
  ratesMatch: boolean;
}

export interface SsfReconciliation {
  available: boolean;
  employeeSsf: number;
  employerSsf: number;
  /** What the fund is owed: employee + employer share. */
  payable: number;
  configuredEmployeeSsf: number;
  configuredEmployerSsf: number;
  /** The contribution the run's current configured rates imply. */
  configured: number;
  controlAccount: { code: string; name: string } | null;
  /** Credits less debits on the SSF payable account, or null when unmapped. */
  controlBalance: number | null;
  controlLineCount: number;
  /** Control balance − payable. */
  difference: number | null;
  /** Posted lines whose snapshot disagrees with their run's configured rates. */
  rateMismatchLines: number;
  /** Posted lines that contributed but whose run has no statutory config. */
  unconfiguredLines: number;
  /** Per-employee tie-out, largest absolute difference first. */
  byEmployee: SsfEmployeeRow[];
  /** Control balance no employee row claims; null when the account is unmapped. */
  unattributedControl: number | null;
  /** Does the control account carry exactly the posted payable? */
  matches: boolean | null;
  /** Do the posted snapshots still agree with the run's configured rates? */
  ratesMatch: boolean;
  /** Why the control account does not tie, or null when it does. */
  reason: string | null;
  /** Why the configured comparison differs, or null when it agrees. */
  rateNote: string | null;
}

const TOLERANCE = 0.005;

export function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

function count(value: unknown): number {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function buildSsfEmployeeRows(rows: readonly SsfEmployeeInput[] | null | undefined): SsfEmployeeRow[] {
  const mapped = (rows || []).map((row) => {
    const employeeSsf = money(row.employeeSsf);
    const employerSsf = money(row.employerSsf);
    const configuredEmployeeSsf = money(row.configuredEmployeeSsf);
    const configuredEmployerSsf = money(row.configuredEmployerSsf);
    const payable = money(employeeSsf + employerSsf);
    const controlBalance = money(row.controlBalance);
    const difference = money(controlBalance - payable);
    const rateMismatchLines = count(row.rateMismatchLines);
    const unconfiguredLines = count(row.unconfiguredLines);
    return {
      employeeId: text(row.employeeId),
      employeeCode: text(row.employeeCode),
      employeeName: text(row.employeeName) || text(row.employeeCode) || text(row.employeeId),
      branchId: text(row.branchId),
      branchName: text(row.branchName) || text(row.branchId),
      lineCount: count(row.lineCount),
      employeeSsf,
      employerSsf,
      payable,
      configuredEmployeeSsf,
      configuredEmployerSsf,
      configured: money(configuredEmployeeSsf + configuredEmployerSsf),
      controlBalance,
      difference,
      rateMismatchLines,
      unconfiguredLines,
      matches: Math.abs(difference) < TOLERANCE,
      ratesMatch: rateMismatchLines === 0 && unconfiguredLines === 0,
    };
  });
  // Largest gap first, then code, so the list is stable and leads with the rows
  // that explain a branch-level difference.
  return mapped.sort(
    (a, b) =>
      Math.abs(b.difference) - Math.abs(a.difference) ||
      a.employeeCode.localeCompare(b.employeeCode) ||
      a.employeeId.localeCompare(b.employeeId)
  );
}

export function buildSsfReconciliation(
  row: SsfReconciliationInput | null | undefined,
  employees?: readonly SsfEmployeeInput[] | null
): SsfReconciliation {
  const source = row || {};
  const employeeSsf = money(source.employeeSsf);
  const employerSsf = money(source.employerSsf);
  const payable = money(employeeSsf + employerSsf);
  const configuredEmployeeSsf = money(source.configuredEmployeeSsf);
  const configuredEmployerSsf = money(source.configuredEmployerSsf);
  const configured = money(configuredEmployeeSsf + configuredEmployerSsf);
  const rateMismatchLines = count(source.rateMismatchLines);
  const unconfiguredLines = count(source.unconfiguredLines);
  const code = String(source.controlAccountCode || '').trim();
  const controlAccount = code
    ? { code, name: String(source.controlAccountName || code) }
    : null;
  const controlBalance = controlAccount ? money(source.controlBalance) : null;
  const difference = controlBalance === null ? null : money(controlBalance - payable);
  const byEmployee = buildSsfEmployeeRows(employees);
  const attributed = money(byEmployee.reduce((sum, employee) => sum + employee.controlBalance, 0));
  const unattributedControl =
    controlBalance === null ? null : money(controlBalance - attributed);

  const ledgerMatches =
    controlAccount !== null && difference !== null && Math.abs(difference) < TOLERANCE;
  const ratesMatch = rateMismatchLines === 0 && unconfiguredLines === 0;

  let reason: string | null = null;
  if (!controlAccount) {
    reason =
      'The chart has no SSF_PAYABLE posting default, so the posted contributions cannot be tied to a control account.';
  } else if (!ledgerMatches) {
    reason = `The SSF payable control account differs from the posted contributions by ${Number(
      difference
    ).toFixed(2)}.`;
  }

  let rateNote: string | null = null;
  if (rateMismatchLines > 0) {
    rateNote = `${rateMismatchLines} posted payroll line${
      rateMismatchLines === 1 ? '' : 's'
    } differ${rateMismatchLines === 1 ? 's' : ''} from the run's current configured SSF rates. The configuration may have been edited after the run was prepared; the posted snapshot still governs what the fund is owed.`;
  } else if (unconfiguredLines > 0) {
    rateNote = `${unconfiguredLines} contributing payroll line${
      unconfiguredLines === 1 ? '' : 's'
    } cannot be verified against a configured rate because the run has no statutory configuration.`;
  }

  return {
    available: true,
    employeeSsf,
    employerSsf,
    payable,
    configuredEmployeeSsf,
    configuredEmployerSsf,
    configured,
    controlAccount,
    controlBalance,
    controlLineCount: count(source.controlLineCount),
    difference,
    rateMismatchLines,
    unconfiguredLines,
    byEmployee,
    unattributedControl,
    matches: controlAccount === null ? null : ledgerMatches,
    ratesMatch,
    reason,
    rateNote,
  };
}
