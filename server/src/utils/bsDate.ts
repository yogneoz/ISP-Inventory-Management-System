/**
 * Central resolver for the BS (Nepali calendar) display date used in ledger
 * rows and audit entries. The authoritative source is the seeded
 * bs_day_records table, reached via findBsDayRecordForAdDate (PostgreSQL,
 * falling back to the in-memory calendar cache only while PostgreSQL is
 * unreachable). Previously several handlers hardcoded '2083-04-16 BS' /
 * '2083-04-22 BS' — a wrong, fictitious date whenever "today" fell outside
 * that one day (C4).
 */

import { findBsDayRecordForAdDate, getInMemoryBsDayRecords } from '../config/bsCalendar';

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

/**
 * Synchronous variant of resolveBsDateForLedger for code paths that cannot
 * await (e.g. the ubiquitous sync logAuditEvent). It answers purely from the
 * in-memory bs_day_records cache that hydrateBsCalendarFromDb refreshes from
 * PostgreSQL at boot and whenever the DB reconnects — same data as the async
 * path, minus the round-trip. When today's row is missing from the cache
 * (unseeded calendar), the shaped fallback is returned.
 */
export function resolveBsDateForLedgerSync(adDate?: string | null): string {
  const ad = String(adDate || new Date().toISOString().split('T')[0]).split('T')[0];
  const record = getInMemoryBsDayRecords().find((r) => r.adDate === ad);
  return record?.bsDate ? `${record.bsDate} BS` : BS_DATE_FALLBACK;
}

/** Today's BS display string, resolved synchronously from the cache. */
export function todayBs(): string {
  return resolveBsDateForLedgerSync();
}
