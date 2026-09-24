/**
 * Central resolver for the BS (Nepali calendar) display date used in ledger
 * rows and audit entries. The authoritative source is the seeded
 * bs_day_records table, reached via findBsDayRecordForAdDate (PostgreSQL,
 * falling back to the in-memory calendar cache only while PostgreSQL is
 * unreachable). Previously several handlers hardcoded '2083-04-16 BS' /
 * '2083-04-22 BS' — a wrong, fictitious date whenever "today" fell outside
 * that one day (C4).
 */

import { findBsDayRecordForAdDate } from '../config/bsCalendar';

/** Last-resort display value, used only when no day record could be found. */
export const BS_DATE_FALLBACK = '2083-04-16 BS';

/**
 * Resolve the BS display string ("YYYY-MM-DD BS") for an AD date. When no
 * bs_day_records row exists for the date (unseeded calendar) the fallback is
 * returned so legacy display consumers still receive a shaped value instead
 * of undefined.
 */
export async function resolveBsDateForLedger(adDate?: string | null): Promise<string> {
  const ad = String(adDate || new Date().toISOString().split('T')[0]).split('T')[0];
  try {
    const day = await findBsDayRecordForAdDate(ad);
    if (day.found && day.record?.bsDate) {
      return `${day.record.bsDate} BS`;
    }
  } catch (_err) {
    // fall through to the fallback below
  }
  return BS_DATE_FALLBACK;
}
