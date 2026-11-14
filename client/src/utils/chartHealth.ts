import type { ChartHealth } from '../services/api/accounting';

const chartHealthNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const chartHealthArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/**
 * Normalize every chart-health generation into one render-safe shape.
 *
 * ACC-6 added `unlinkedSubledgerRows`; a client can outlive a server that does
 * not return it during a rolling upgrade. The chart screen must render the
 * rest of the health report in that case, and mark only the unlinked section
 * as unavailable. Defaults are deliberately empty/zero, never fabricated
 * findings.
 */
export function normalizeChartHealth(payload: unknown): ChartHealth {
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const unlinkedRaw =
    root.unlinkedSubledgerRows && typeof root.unlinkedSubledgerRows === 'object'
      ? (root.unlinkedSubledgerRows as Record<string, unknown>)
      : null;
  const rows = chartHealthArray<ChartHealth['unlinkedSubledgerRows']['rows'][number]>(unlinkedRaw?.rows);
  const count = unlinkedRaw?.count == null ? rows.length : chartHealthNumber(unlinkedRaw.count);
  const amount =
    unlinkedRaw?.amount == null
      ? rows.reduce((sum, row) => sum + chartHealthNumber(row.debit) - chartHealthNumber(row.credit), 0)
      : chartHealthNumber(unlinkedRaw.amount);
  const totalsRaw =
    root.totals && typeof root.totals === 'object' ? (root.totals as Record<string, unknown>) : {};
  return {
    missingPostingRoles: chartHealthArray<string>(root.missingPostingRoles),
    controlAccountsWithoutSubledger: chartHealthArray<
      ChartHealth['controlAccountsWithoutSubledger'][number]
    >(root.controlAccountsWithoutSubledger),
    inactiveAccountsHoldingRole: chartHealthArray<
      ChartHealth['inactiveAccountsHoldingRole'][number]
    >(root.inactiveAccountsHoldingRole),
    unlinkedSubledgerRows: {
      // Keep a normalized "unavailable" marker when this function is applied
      // again at the render boundary (or by a caller that already normalized).
      available: unlinkedRaw !== null && unlinkedRaw.available !== false,
      count,
      amount,
      rows,
    },
    totals: {
      accounts: chartHealthNumber(totalsRaw.accounts),
      controlAccounts: chartHealthNumber(totalsRaw.controlAccounts),
      subledgers: chartHealthNumber(totalsRaw.subledgers),
      activeSubledgers: chartHealthNumber(totalsRaw.activeSubledgers),
      unlinkedSubledgerRows:
        totalsRaw.unlinkedSubledgerRows == null
          ? count
          : chartHealthNumber(totalsRaw.unlinkedSubledgerRows),
    },
  };
}
