/**
 * The read scope for a stock-operation register page.
 *
 * The page API refuses an unbounded national read (`SCOPE_REQUIRED`): a branch,
 * a bounded date range or one customer must accompany it. These registers were
 * passing nothing when the operator chose "All branches", so the refusal landed
 * in the panel and the register rendered as empty over rows the demo (and a
 * live install) actually holds.
 *
 * The register is a recent-activity log, so the all-branch view reads the
 * trailing twelve months rather than the whole ledger: that satisfies the guard,
 * keeps the query selective, and leaves the date filters free to narrow it
 * further and the CSV export free to read everything.
 */
export interface StockOperationScope {
  branchId?: string;
  dateFromAD?: string;
  dateToAD?: string;
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export function stockOperationScope(branchFilter: string, today: Date = new Date()): StockOperationScope {
  if (branchFilter && branchFilter !== 'ALL') return { branchId: branchFilter };
  const from = new Date(today.getTime());
  from.setFullYear(from.getFullYear() - 1);
  return { dateFromAD: isoDate(from), dateToAD: isoDate(today) };
}
