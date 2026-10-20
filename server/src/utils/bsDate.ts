/**
 * Central resolver for the BS (Nepali calendar) display date used in ledger
 * rows and audit entries. The authoritative source is the seeded
 * bs_day_records table, reached via findBsDayRecordForAdDate (PostgreSQL,
 * falling back to the in-memory calendar cache only while PostgreSQL is
 * unreachable). Previously several handlers hardcoded '2083-04-16 BS' /
 * '2083-04-22 BS' — a wrong, fictitious date whenever "today" fell outside
 * that one day (C4).
 */

import { findBsDayRecordForAdDate, getInMemoryBsDayRecords, getBsCalendarCoverage, type BsCalendarCoverage } from '../config/bsCalendar';

/**
 * What a BS column or screen gets when the calendar has no day record for the
 * date: an explicit marker, never a date.
 *
 * This replaces BS_DATE_FALLBACK = '2083-04-16 BS', which was a real (wrong)
 * date for every day except one — it silently dated ledgers, audit rows and
 * exports to a day that had nothing to do with the operation, and it made an
 * unseeded calendar look seeded. The marker is stored in the same columns (they
 * are VARCHAR(20) and the seeding gap must be visible in exports and reports),
 * and the client shows it verbatim
 * (client/src/utils/nepaliCalendar.ts BS_NOT_SEEDED — pinned together by
 * tests/bsDateMarker.test.ts).
 */
export const BS_NOT_SEEDED = 'BS not seeded';

/** True when a stored/derived BS value is the not-seeded marker rather than a
 *  date. Callers that would otherwise parse the value use this first. */
export function isBsDateMissing(value?: string | null): boolean {
  const cleaned = String(value ?? '').trim();
  return cleaned === '' || cleaned.toLowerCase() === BS_NOT_SEEDED.toLowerCase();
}

/**
 * Resolve the BS display string ("YYYY-MM-DD BS") for an AD date. When no
 * bs_day_records row exists for the date (unseeded calendar) the caller gets
 * BS_NOT_SEEDED: the operator sees that the day is unseeded, instead of a
 * shaped value that looks like a date nobody can verify.
 */
export async function resolveBsDateForLedger(adDate?: string | null): Promise<string> {
  const ad = String(adDate || new Date().toISOString().split('T')[0]).split('T')[0];
  try {
    const day = await findBsDayRecordForAdDate(ad);
    if (day.found && day.record?.bsDate) {
      return `${day.record.bsDate} BS`;
    }
  } catch (_err) {
    // fall through to the marker below
  }
  return BS_NOT_SEEDED;
}

/**
 * Synchronous variant of resolveBsDateForLedger for code paths that cannot
 * await (e.g. the ubiquitous sync logAuditEvent). It answers purely from the
 * in-memory bs_day_records cache that hydrateBsCalendarFromDb refreshes from
 * PostgreSQL at boot and whenever the DB reconnects — same data as the async
 * path, minus the round-trip. When today's row is missing from the cache
 * (unseeded calendar) the caller gets BS_NOT_SEEDED.
 */
export function resolveBsDateForLedgerSync(adDate?: string | null): string {
  const ad = String(adDate || new Date().toISOString().split('T')[0]).split('T')[0];
  const record = getInMemoryBsDayRecords().find((r) => r.adDate === ad);
  return record?.bsDate ? `${record.bsDate} BS` : BS_NOT_SEEDED;
}

/** Today's BS display string, resolved synchronously from the cache. Returns
 *  BS_NOT_SEEDED when today is not a seeded calendar day. */
export function todayBs(): string {
  return resolveBsDateForLedgerSync();
}

/**
 * The screen that can actually fix an unseeded BS date, named the way the
 * sidebar shows it (Administration & Governance group). The previous wording
 * named a menu this app does not have, so an operator following the message
 * could not find the screen.
 */
export const BS_SEEDING_SCREEN_PATH = 'Administration & Governance → BS Calendar Utility (Super Admin)';

/**
 * Why a dated operation was refused. The two coverage cases need OPPOSITE
 * instructions from the gap case: a gap is repairable by re-seeding/rebuilding
 * the existing months, while a date past the end of the calendar means the next
 * BS year has never been seeded and every dated operation keeps failing until
 * somebody seeds it.
 */
export type BsDateFailureReason =
  | 'DAY_NOT_SEEDED'
  | 'BEFORE_CALENDAR_COVERAGE'
  | 'AFTER_CALENDAR_COVERAGE';

/** Classifies an AD date against the seeded calendar span. Pure, so the
 *  message text and the reason are unit-testable without a database. */
export function classifyBsDateFailure(adDate: string, coverage: BsCalendarCoverage): BsDateFailureReason {
  if (!adDate) return 'DAY_NOT_SEEDED';
  if (coverage.maxAD && adDate > coverage.maxAD) return 'AFTER_CALENDAR_COVERAGE';
  if (coverage.minAD && adDate < coverage.minAD) return 'BEFORE_CALENDAR_COVERAGE';
  return 'DAY_NOT_SEEDED';
}

/** Builds the operator-facing 400 message: what failed, the exact coverage
 *  span, and the screen that fixes it. */
export function bsDateFailureMessage(
  adDate: string,
  reason: BsDateFailureReason,
  coverage: BsCalendarCoverage
): string {
  const span = coverage.minAD && coverage.maxAD
    ? `The seeded BS calendar currently covers ${coverage.minBS ?? '?'} to ${coverage.maxBS ?? '?'} BS (AD ${coverage.minAD} to ${coverage.maxAD}).`
    : 'No BS calendar days are seeded yet.';
  if (reason === 'AFTER_CALENDAR_COVERAGE') {
    return `BS date is not available for ${adDate}: it is past the end of the seeded BS calendar. ${span} Seed the next BS year from ${BS_SEEDING_SCREEN_PATH}.`;
  }
  if (reason === 'BEFORE_CALENDAR_COVERAGE') {
    return `BS date is not available for ${adDate}: it is before the start of the seeded BS calendar. ${span} Seed the earlier BS year from ${BS_SEEDING_SCREEN_PATH}.`;
  }
  if (!adDate) {
    return `BS date is not available for the requested date. ${span} Seed the missing BS month from ${BS_SEEDING_SCREEN_PATH}.`;
  }
  return `BS date is not available for ${adDate}: that date is inside the seeded range but has no BS day record. ${span} Re-seed or rebuild the BS month arrays from ${BS_SEEDING_SCREEN_PATH}.`;
}

/**
 * Mandatory-BS resolver for persisted operation dates: derives the BS date
 * for the operation's OWN AD date from bs_day_records and, when that
 * calendar day is unseeded, sends a 400 (bsDateMissing) and returns null.
 * Persisted rows must never carry an empty, estimated, or fallback BS date;
 * client-supplied BS values cannot override the derived one (same rule the
 * dispatch/receipt date gates already follow).
 *
 * The 400 carries machine-readable context so the UI can route the operator to
 * the seeding screen instead of only printing instructions:
 *   bsDateReason    — DAY_NOT_SEEDED | BEFORE_CALENDAR_COVERAGE | AFTER_CALENDAR_COVERAGE
 *   calendarCoverage — the covered AD/BS span at the moment of refusal
 */
export async function bsDateOr400(res: any, adDate: unknown): Promise<string | null> {
  const ad = String(adDate || '').split('T')[0];
  try {
    if (ad) {
      const day = await findBsDayRecordForAdDate(ad);
      if (day.found && day.record?.bsDate) return `${day.record.bsDate} BS`;
    }
  } catch (_err) {
    // handled by the 400 below
  }
  const coverage = await getBsCalendarCoverage();
  const reason = classifyBsDateFailure(ad, coverage);
  res.status(400).json({
    message: bsDateFailureMessage(ad, reason, coverage),
    bsDateMissing: true,
    bsDateReason: reason,
    adDate: ad || null,
    calendarCoverage: coverage,
  });
  return null;
}
