/**
 * The business date, in the time zone the business runs in.
 *
 * Nepal has one zone, UTC+05:45, and no daylight saving. Deriving the business
 * date from the machine clock by formatting now as an ISO string and cutting
 * the date off the front is therefore wrong for five and three-quarter hours
 * every day: between 00:00 and 05:45 Kathmandu time the UTC day has not turned
 * over yet, so the server names YESTERDAY. That wrote reversals, daily closes,
 * cancellations and warranty terms onto the previous AD day (and therefore the
 * previous BS day), and the error only appeared for staff working early in the
 * morning.
 *
 * Every default accounting date goes through this helper. A date that arrives
 * in a request, or a `Date` built from an explicit AD string, is a calendar
 * value and must NOT be routed through the clock at all.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Kathmandu';

const BUSINESS_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The AD calendar date (`YYYY-MM-DD`) that instant `at` falls on in Kathmandu.
 * Defaults to now, which is what every caller wants.
 */
export function businessDateAD(at: Date = new Date()): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('businessDateAD needs a valid Date');
  }
  // formatToParts, not the locale's string form: the parts are stable across
  // ICU data versions, and no locale puts them in an ambiguous order.
  const parts = BUSINESS_DATE_FORMAT.formatToParts(at);
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

const BUSINESS_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * The wall-clock time (`HH:MM`) at instant `at` in Kathmandu. A punch recorded
 * with a UTC-derived time lands 5 h 45 min early, which reads as the wrong shift
 * on the phone and on the attendance register.
 */
export function businessTimeHHMM(at: Date = new Date()): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('businessTimeHHMM needs a valid Date');
  }
  const parts = BUSINESS_TIME_FORMAT.formatToParts(at);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  return `${hour}:${minute}`;
}

/**
 * Calendar-day arithmetic on an AD date: pure YEAR-MONTH-DAY math at UTC
 * midnight, so no clock and no zone can move the result. Weeks, months or days
 * added to the business date must land on a calendar day, not on "now + n ms".
 */
export function addDaysAD(dateAD: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateAD));
  if (!match) throw new TypeError('addDaysAD needs an AD date in YYYY-MM-DD form');
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}
