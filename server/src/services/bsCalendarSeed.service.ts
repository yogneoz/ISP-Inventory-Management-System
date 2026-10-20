/**
 * BS calendar seeding rules — pure, unit-testable (the controller keeps only
 * HTTP concerns, per the repo-layer split).
 *
 * The rule this file exists for: where a NEW BS year's Baisakh 1 comes from, and
 * whether the calendar can vouch for the year at all.
 *
 *  - An operator-supplied start is 'patro' data: they read it off the published
 *    patro.
 *  - Otherwise it is DERIVED as the previous seeded year's end + 1. The old
 *    `${yearBS - 57}-04-14` guess silently misdated an entire year whenever the
 *    preceding BS year was 366 days long, which most of 2078-2085 are.
 *  - A year the bundled patro reference does not cover is PROVISIONAL either
 *    way: its month array is somebody's entry, so the coverage warning keeps
 *    naming it until the published patro confirms the array.
 */
import { DEFAULT_BS_YEARS_SERVER } from '../config/bsCalendar';

export type BsStartSource = 'patro' | 'estimated';

export interface SeedConfig {
  startAD: string;
  startAdSource: BsStartSource;
  isProvisional: boolean;
}

export interface SeedableYear {
  yearBS: number;
  daysInMonths: number[];
  startAD: string;
}

const PATRO_YEARS = new Set<number>(DEFAULT_BS_YEARS_SERVER.map((y) => y.yearBS));

/** True when the bundled patro reference (shared/bsCalendarYears.json) covers
 *  this BS year — the only definition of "verified" the server has. */
export function isPatroYear(yearBS: number): boolean {
  return PATRO_YEARS.has(yearBS);
}

/** The BS years the bundled patro reference verifies. */
export function patroYears(): number[] {
  return Array.from(PATRO_YEARS).sort((a, b) => a - b);
}

/** 'YYYY-MM-DD' shifted by whole days (UTC-safe, no local-time drift). */
export function shiftIsoDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

/** The last day of a seeded year, from its own config. */
export function yearEndAD(year: SeedableYear): string {
  const total = year.daysInMonths.reduce((sum, d) => sum + (Number(d) || 0), 0);
  return shiftIsoDays(year.startAD, Math.max(total, 1) - 1);
}

/**
 * Resolves the start date and provenance for a year being seeded or re-seeded.
 * `seededYears` is the calendar as it currently stands (the in-memory cache or
 * the bs_calendar_years rows) — the previous year is the closest one BELOW this
 * year, so a deliberate gap in coverage is respected rather than assumed away.
 */
export function resolveSeedConfig(
  yearBS: number,
  daysInMonths: number[],
  customStartAD: string | undefined,
  seededYears: SeedableYear[]
): SeedConfig {
  const supplied = typeof customStartAD === 'string' && customStartAD.trim() !== '';
  let startAD = supplied ? String(customStartAD).trim() : '';

  if (!startAD) {
    const previous = seededYears
      .filter((y) => Number(y.yearBS) < yearBS && Array.isArray(y.daysInMonths) && y.startAD)
      .sort((a, b) => Number(b.yearBS) - Number(a.yearBS))[0];
    startAD = previous ? shiftIsoDays(yearEndAD(previous), 1) : `${yearBS - 57}-04-14`;
  }

  // "Provisional" means the calendar cannot vouch for this year: the patro data
  // does not cover it at all, or what is being stored disagrees with the patro
  // for a year it does cover. A DERIVED start is not automatically provisional -
  // when the year is patro-verified and the derivation lands exactly on the
  // patro's Baisakh 1, the value is the published one (the patro tiles), so a
  // correctly seeded year never carries a warning that would confuse an
  // operator into "fixing" a year that is already right.
  const patroYear = DEFAULT_BS_YEARS_SERVER.find((y) => y.yearBS === yearBS);
  const arrayMatchesPatro =
    Boolean(patroYear) && String(patroYear!.daysInMonths) === String(daysInMonths);
  const startAdSource: BsStartSource =
    supplied || (patroYear && patroYear.startAD === startAD) ? 'patro' : 'estimated';
  const isProvisional = !patroYear || !arrayMatchesPatro || patroYear.startAD !== startAD;

  return { startAD, startAdSource, isProvisional };
}

/** Operator-facing note for any year the patro data does not verify. */
export function provisionalSeedNote(yearBS: number, config: SeedConfig): string {
  if (!config.isProvisional) return '';
  const why =
    config.startAdSource === 'estimated'
      ? `Baisakh 1 was derived as ${config.startAD} (previous year's end + 1)`
      : 'the month array was entered by hand';
  return (
    ` BS ${yearBS} is marked PROVISIONAL: ${why}, and the bundled patro data does not verify BS ${yearBS} — ` +
    'every dated operation will keep warning until it is confirmed against the published patro.'
  );
}
