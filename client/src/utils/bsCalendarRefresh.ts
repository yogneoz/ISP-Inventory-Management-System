/**
 * App-wide "the BS calendar changed" signal (DF-10).
 *
 * App's SSE handler already re-reads the client calendar mirror when a
 * `BS_CALENDAR` (or `RECALC`, which rebuilds the day records) burst arrives.
 * Screens and gates that read the calendar need to know that happened: before
 * this event, they only re-read on tab activation, so a month seeded in another
 * tab/screen left the stock gate locked until a reload.
 *
 * App broadcasts once per handled burst; consumers either depend on
 * `useBsCalendarRefresh()` (a counter that bumps on every signal) or subscribe
 * directly with `BS_CALENDAR_UPDATED_EVENT`.
 */
import { useEffect, useState } from 'react';

export const BS_CALENDAR_UPDATED_EVENT = 'inventory_bs_calendar_updated';

/** Tells every open screen that the server-side calendar data changed. */
export function broadcastBsCalendarUpdated(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BS_CALENDAR_UPDATED_EVENT));
}

/**
 * A counter that increments whenever App handles a calendar-changing SSE burst.
 * Put it in a fetch/gate effect's dependencies to re-read without a reload.
 */
export function useBsCalendarRefresh(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onUpdated = () => setVersion((v) => v + 1);
    window.addEventListener(BS_CALENDAR_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(BS_CALENDAR_UPDATED_EVENT, onUpdated);
  }, []);
  return version;
}
