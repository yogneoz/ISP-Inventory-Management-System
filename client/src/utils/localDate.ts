/**
 * Today's AD date on the user's LOCAL calendar, as `YYYY-MM-DD`.
 *
 * ISO date strings compare lexicographically, so the result is safe to compare
 * with form and date-field values. `new Date().toISOString().split('T')[0]`
 * must not be used for "today": it is UTC, so between 00:00 and 05:45 Nepal
 * time it still reports yesterday — which made the stock-operation BS-date
 * gate check the wrong day (DF-10).
 */
export function localTodayAD(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
