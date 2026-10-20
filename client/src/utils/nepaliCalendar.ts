/**
 * Bikram Sambat (BS) <-> Anno Domini (AD) Date Conversion Utility for Inventory
 * Powered by Reference Table Calendar Data & Full Day-by-Day Database Generator
 */
import bsCalendarYearsSource from '../../../shared/bsCalendarYears.json';

export interface BSYearData {
  yearBS: number;
  daysInMonths: number[]; // 12 numbers for [Baisakh..Chaitra]
  startAD: string; // ISO date string YYYY-MM-DD for Baisakh 1
  /** Where startAD came from: 'patro' = read off the published patro (or the
   *  bundled reference data), 'estimated' = derived at seed time from the
   *  previous year's end + 1, or the year-57 approximation. */
  startAdSource?: 'patro' | 'estimated';
  /** True while the bundled patro data does not verify this year's array, so
   *  every screen can warn instead of treating an entry as the calendar. */
  isProvisional?: boolean;
}

/**
 * What a screen shows where a BS date should be but the calendar has no day
 * record for it. The server writes the same literal (server/src/utils/bsDate.ts
 * BS_NOT_SEEDED) into BS columns it cannot derive, so an unseeded day is visible
 * in the UI, in exports and in the stored row instead of hiding behind a
 * fictitious date. tests/bsDateMarker.test.ts pins the two literals together.
 */
export const BS_NOT_SEEDED = 'BS not seeded';

export interface BSDayRecord {
  adDate: string; // YYYY-MM-DD AD
  bsDate: string; // YYYY-MM-DD BS
  bsYear: number;
  bsMonth: number;
  bsMonthName: string;
  bsMonthNameNp: string;
  bsDay: number;
  dayOfWeekName: string; // 'Sunday', 'Monday', ...
  dayOfWeekNameNp: string; // 'आइतबार', 'सोमबार', ...
  fiscalYear: string; // e.g. '2081-82', '2082-83'
  quarter: string; // 'Q1', 'Q2', 'Q3', 'Q4'
  isWeekend: boolean; // True for Saturday in Nepal
}

export interface CalendarBounds {
  minAD: string;
  maxAD: string;
  minBS: string;
  maxBS: string;
  totalDaysMapped: number;
  mappedYearsCount: number;
  mappedYears: number[];
}

export const NEPALI_MONTHS_EN = [
  'Baisakh',
  'Jestha',
  'Ashadh',
  'Shrawan',
  'Bhadra',
  'Ashwin',
  'Kartik',
  'Mangsir',
  'Poush',
  'Magh',
  'Falgun',
  'Chaitra',
];

export const NEPALI_MONTHS_NP = [
  'वैशाख',
  'जेठ',
  'असार',
  'श्रावण',
  'भाद्र',
  'असोज',
  'कार्तिक',
  'मंसिर',
  'पुस',
  'माघ',
  'फागुन',
  'चैत',
];

export const DAYS_OF_WEEK_EN = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export const DAYS_OF_WEEK_NP = [
  'आइतबार',
  'सोमबार',
  'मंगलबार',
  'बुधबार',
  'बिहीबार',
  'शुक्रबार',
  'शनिबार',
];

// Default built-in BS Calendar Lookup Engine (2078 BS to 2085 BS), read from the
// repo's ONE copy of the calendar data: shared/bsCalendarYears.json — the same
// file the server config (server/src/config/bsCalendar.ts) and the database
// seeder (scripts/setup_db.js) load, and the same one the UI seed presets derive
// from. This used to be four hand-maintained copies, and three of the eight
// seeded years had drifted from the published patro (BS 2080, 2084 and 2085
// labelled mid-year AD dates with the wrong Nepali day). Month lengths differ
// year to year: neighbouring years never share an array, they only tile.
const INITIAL_BS_CALENDAR_DATA: Record<number, BSYearData> = Object.fromEntries(
  bsCalendarYearsSource.years.map((y) => [
    y.yearBS,
    { yearBS: y.yearBS, daysInMonths: y.daysInMonths, startAD: y.startAD },
  ])
);

/**
 * In-memory BS calendar lookup.
 *
 * The AUTHORITATIVE data lives in the `bs_calendar_years` / `bs_day_records`
 * PostgreSQL tables: App.tsx seeds this store from GET /api/bs-calendar/years
 * on every load, the BS Calendar Utility writes go to the server first, and
 * the bundled INITIAL_BS_CALENDAR_DATA covers the very first paint.
 *
 * Browser storage is deliberately NOT used here — a per-browser mirror could
 * silently disagree with the database (seeds made on another machine) and
 * would vanish when the user clears cookies/history. Clearing either now
 * costs nothing: the server re-seeds this store on the next load.
 */
let calendarStore: Record<number, BSYearData> | null = null;

/**
 * Bumped every time the store changes, so derived artifacts (the generated
 * day-by-day database) can be memoized without any caller having to know a
 * re-seed happened.
 */
let calendarStoreRevision = 0;

/**
 * Returns a snapshot of the calendar (bundled defaults until the server seed
 * lands, then the server-seeded data).
 */
export function getBsCalendarData(): Record<number, BSYearData> {
  return { ...(calendarStore ?? INITIAL_BS_CALENDAR_DATA) };
}

/**
 * The bundled (patro-verified) month array for one BS year, or null when that
 * year is not in shared/bsCalendarYears.json.
 *
 * The "+ Seed <year> BS" presets read this instead of carrying their own
 * literals, so a button can never offer a month array the seeder does not have
 * (and a year the patro data does not cover has no button at all rather than a
 * guessed 30-day-per-month row).
 */
export function getBundledBsYearMonths(yearBS: number): number[] | null {
  const year = INITIAL_BS_CALENDAR_DATA[yearBS];
  return year ? [...year.daysInMonths] : null;
}

/**
 * The years the "+ Seed <year> BS" preset row offers: the four most recent
 * years the bundled patro data covers, newest first. Derived from the data, so
 * the row can never name a year the seeder has no verified array for.
 */
export function getSeedPresetYears(): number[] {
  return Object.keys(INITIAL_BS_CALENDAR_DATA)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, 4);
}

/** Replaces the in-memory calendar snapshot. */
function saveBsCalendarData(data: Record<number, BSYearData>): void {
  calendarStore = { ...data };
  calendarStoreRevision += 1;
}

/**
 * Drops the local snapshot so the next read falls back to the bundled
 * defaults. Used by the "reset to defaults" actions, which then re-read the
 * authoritative rows from the server via refreshCalendarData().
 */
export function resetBsCalendarData(): void {
  calendarStore = null;
  calendarStoreRevision += 1;
}

/**
 * Automatically seeds or updates a year's month length array.
 */
export function seedBSYearCalendar(
  yearBS: number,
  daysInMonths: number[],
  customStartAD?: string,
  provenance?: { startAdSource?: 'patro' | 'estimated'; isProvisional?: boolean }
): Record<number, BSYearData> {
  if (daysInMonths.length !== 12) {
    throw new Error('Month array must contain exactly 12 integers [Baisakh..Chaitra].');
  }

  const currentData = getBsCalendarData();

  let startAD = customStartAD;
  if (!startAD) {
    const prevYear = currentData[yearBS - 1];
    if (prevYear) {
      const prevTotalDays = prevYear.daysInMonths.reduce((a, b) => a + b, 0);
      const prevStartDate = new Date(prevYear.startAD);
      prevStartDate.setDate(prevStartDate.getDate() + prevTotalDays);
      startAD = prevStartDate.toISOString().split('T')[0];
    } else {
      const estADYear = yearBS - 57;
      startAD = `${estADYear}-04-14`;
    }
  }

  const previous = currentData[yearBS];
  const updatedData: Record<number, BSYearData> = {
    ...currentData,
    [yearBS]: {
      yearBS,
      daysInMonths: [...daysInMonths],
      startAD,
      // Provenance is remembered per year: the server sends it for seeded rows,
      // and a caller that supplies none keeps whatever the year already had
      // (rather than silently upgrading a provisional year to "patro").
      startAdSource: provenance?.startAdSource ?? previous?.startAdSource ?? (customStartAD ? 'patro' : 'estimated'),
      isProvisional: provenance?.isProvisional ?? previous?.isProvisional ?? false,
    },
  };

  saveBsCalendarData(updatedData);
  return updatedData;
}

/**
 * The seeded years the bundled patro data does not verify (or whose Baisakh 1
 * was derived). Their dates work, but nothing confirms the month array, so the
 * coverage countdown keeps naming them until the published patro confirms it.
 */
export function getProvisionalYears(): number[] {
  return Object.values(getBsCalendarData())
    .filter((year) => year.isProvisional || year.startAdSource === 'estimated')
    .map((year) => year.yearBS)
    .sort((a, b) => a - b);
}

/**
 * Parses raw seed input text and seeds one or more BS calendar years into the
 * in-memory calendar lookup table.
 *
 * Supported input formats (multiple years can be combined on separate lines):
 *   1. Single year line:   "2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]"
 *   2. Multi-year lines:   "2082: [31, ...]\n2083: [31, ...]\n2084: [31, ...]"
 *   3. JSON object:        '{"2082": [31, ...], "2083": [31, ...]}'
 *   4. CSV rows:           "2082,31,31,32,...\n2083,31,31,32,..."
 *   5. TSV rows:           "2082\t31\t31\t32\t..."
 *
 * Optional comma-delimited "startAD" suffix per year (format "YYYY-MM-DD"):
 *   "2082: [31, ...] @ 2025-04-14"  or JSON  {"2082": {"days": [...], "startAD": "..."}}
 */
export function parseAndSeedBSInput(inputStr: string): {
  success: boolean;
  message: string;
  yearBS?: number;
  years?: number[];
} {
  try {
    const trimmed = inputStr.trim();
    if (!trimmed) {
      return { success: false, message: 'No seed input provided.' };
    }

    const yearLines = trimmed.split(/\r?\n/).filter((l) => l.trim());

    // --- Format 1 & 2: Single or multi-year colon lines ---
    const colonLines = yearLines.filter((l) => /^(\d{4})\s*[:=]\s*\[/.test(l.trim()));
    if (colonLines.length > 0) {
      const seededYears: number[] = [];
      const errors: string[] = [];

      for (const rawLine of colonLines) {
        const line = rawLine.trim();
        const colonMatch = line.match(/^(\d{4})\s*[:=]\s*\[([\d\s,]+)\](?:\s*@\s*(\d{4}-\d{2}-\d{2}))?$/);

        if (!colonMatch) {
          errors.push(`Invalid line: "${line}"`);
          continue;
        }

        const yearBS = parseInt(colonMatch[1], 10);
        const arrStr = colonMatch[2];
        const customStartAD = colonMatch[3] || undefined;
        const monthDays = arrStr
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n));

        if (monthDays.length !== 12) {
          errors.push(`Found ${monthDays.length} months instead of 12 for BS year ${yearBS}.`);
          continue;
        }

        seedBSYearCalendar(yearBS, monthDays, customStartAD);
        seededYears.push(yearBS);
      }

      if (seededYears.length === 0) {
        return {
          success: false,
          message: errors.length ? errors.join(' | ') : 'No valid year lines found.',
        };
      }

      const totalDays = seededYears.reduce((sum, y) => {
        const yData = getBsCalendarData()[y];
        return sum + (yData ? yData.daysInMonths.reduce((a, b) => a + b, 0) : 0);
      }, 0);

      return {
        success: true,
        message:
          seededYears.length === 1
            ? `Successfully seeded BS Year ${seededYears[0]} with ${totalDays} total days into database lookup table!`
            : `Successfully batch seeded ${seededYears.length} BS Calendar years (${seededYears.join(', ')}) with ${totalDays} total days!`,
        yearBS: seededYears[0],
        years: seededYears,
      };
    }

    // --- Format 3: JSON object (allows per-year startAD) ---
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const jsonObj = JSON.parse(trimmed);
      const seededYears: number[] = [];
      const errors: string[] = [];

      for (const [key, val] of Object.entries(jsonObj)) {
        const yearBS = parseInt(key, 10);
        if (isNaN(yearBS)) {
          errors.push(`Invalid BS year key "${key}" in JSON object.`);
          continue;
        }

        let days: number[];
        let customStartAD: string | undefined;

        if (Array.isArray(val)) {
          days = (val as any[]).map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
        } else if (val && typeof val === 'object') {
          const v = val as any;
          days = Array.isArray(v.days)
            ? v.days.map((n: any) => parseInt(n, 10)).filter((n: any) => !isNaN(n))
            : [];
          if (v.startAD) customStartAD = String(v.startAD);
        } else {
          days = [];
        }

        if (days.length !== 12) {
          errors.push(`Found ${days.length} months instead of 12 for BS year ${yearBS}.`);
          continue;
        }

        seedBSYearCalendar(yearBS, days, customStartAD);
        seededYears.push(yearBS);
      }

      if (seededYears.length > 0) {
        return {
          success: true,
          message: `Successfully batch seeded ${seededYears.length} BS Calendar year(s) from JSON (${seededYears.join(', ')})!`,
          yearBS: seededYears[0],
          years: seededYears,
        };
      }
      return { success: false, message: errors.length ? errors.join(' | ') : 'No valid JSON years found.' };
    }

    // --- Format 4 & 5: CSV / TSV rows ---
    const rowLines = yearLines.filter((l) => {
      const cells = l.trim().split(/[,\t]/).map((s) => s.trim()).filter((s) => s.length > 0);
      return cells.length >= 13 && !isNaN(parseInt(cells[0], 10));
    });
    if (rowLines.length > 0) {
      const seededYears: number[] = [];
      const errors: string[] = [];

      for (const rawLine of rowLines) {
        const cells = rawLine.trim().split(/[,\t]/).map((s) => s.trim());
        const yearBS = parseInt(cells[0], 10);
        if (isNaN(yearBS)) {
          errors.push(`Invalid BS year in row: "${rawLine.trim()}"`);
          continue;
        }

        const monthDays = cells.slice(1, 13).map((s) => parseInt(s, 10));
        if (monthDays.some((n) => isNaN(n)) || monthDays.length !== 12) {
          errors.push(`Row for BS year ${yearBS} must contain 12 numeric month-day values.`);
          continue;
        }

        const startAD = cells[13] && /^\d{4}-\d{2}-\d{2}$/.test(cells[13]) ? cells[13] : undefined;
        seedBSYearCalendar(yearBS, monthDays, startAD);
        seededYears.push(yearBS);
      }

      if (seededYears.length === 0) {
        return {
          success: false,
          message: errors.length ? errors.join(' | ') : 'No valid CSV/TSV rows found.',
        };
      }

      return {
        success: true,
        message: `Successfully batch seeded ${seededYears.length} BS Calendar year(s) from tabular input (${seededYears.join(', ')})!`,
        yearBS: seededYears[0],
        years: seededYears,
      };
    }

    return {
      success: false,
      message:
        'Invalid format. Use one of:\n' +
        '  Single year:        "2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]"\n' +
        '  Multiple years:     one "2082: [...]" line per year\n' +
        '  Optional AD start:  "2082: [31, ...] @ 2025-04-14"\n' +
        '  JSON:               \'{"2082": [31, ...], "2083": [31, ...]}\'\n' +
        '  CSV/TSV:            "2082,31,31,32,...,30[,2025-04-14]"',
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to parse calendar input: ${err.message || 'Syntax error'}`,
    };
  }
}

/**
 * Extracts the list of (yearBS, daysInMonths, customStartAD) tuples that a seed
 * input string would seed, without mutating any calendar data. Used to preview
 * multi-year batches before seeding.
 */
export function parseBSSeedYears(inputStr: string): {
  years: { yearBS: number; daysInMonths: number[]; startAD?: string }[];
  errors: string[];
} {
  const years: { yearBS: number; daysInMonths: number[]; startAD?: string }[] = [];
  const errors: string[] = [];
  const trimmed = (inputStr || '').trim();
  if (!trimmed) return { years, errors };

  const yearLines = trimmed.split(/\r?\n/).filter((l) => l.trim());

  // Colon lines (single/multi year)
  for (const rawLine of yearLines) {
    const line = rawLine.trim();
    const colonMatch = line.match(/^(\d{4})\s*[:=]\s*\[([\d\s,]+)\](?:\s*@\s*(\d{4}-\d{2}-\d{2}))?$/);
    if (colonMatch) {
      const daysInMonths = colonMatch[2]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
      if (daysInMonths.length === 12) {
        years.push({
          yearBS: parseInt(colonMatch[1], 10),
          daysInMonths,
          startAD: colonMatch[3] || undefined,
        });
      } else {
        errors.push(`Line for BS year ${parseInt(colonMatch[1], 10)} has ${daysInMonths.length} months instead of 12.`);
      }
      continue;
    }

    // Tabular rows
    const cells = line.split(/[,\t]/).map((s) => s.trim()).filter((s) => s !== '');
    if (cells.length >= 13 && !isNaN(parseInt(cells[0], 10))) {
      const yearBS = parseInt(cells[0], 10);
      const daysInMonths = cells.slice(1, 13).map((s) => parseInt(s, 10));
      if (daysInMonths.every((n) => !isNaN(n)) && daysInMonths.length === 12) {
        years.push({
          yearBS,
          daysInMonths,
          startAD: cells[13] && /^\d{4}-\d{2}-\d{2}$/.test(cells[13]) ? cells[13] : undefined,
        });
      } else {
        errors.push(`Row for BS year ${yearBS} must contain 12 numeric month-day values.`);
      }
    }
  }

  // JSON object support
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const jsonObj = JSON.parse(trimmed);
      for (const [key, val] of Object.entries(jsonObj)) {
        const yearBS = parseInt(key, 10);
        if (isNaN(yearBS)) continue;
        let days: number[] = [];
        let startAD: string | undefined;
        if (Array.isArray(val)) {
          days = (val as any[]).map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
        } else if (val && typeof val === 'object') {
          days = Array.isArray((val as any).days)
            ? (val as any).days.map((n: any) => parseInt(n, 10)).filter((n: any) => !isNaN(n))
            : [];
          if ((val as any).startAD) startAD = String((val as any).startAD);
        }
        if (days.length === 12) years.push({ yearBS, daysInMonths: days, startAD });
      }
    } catch {
      // ignore malformed JSON in preview
    }
  }

  return { years, errors };
}

/**
 * Helper to compute Fiscal Year string for a given BS Year & Month (e.g. 2082-83)
 * In Nepal, Shrawan (Month 4) to Chaitra (Month 12) belong to Start Year (e.g., 2082-83).
 * Baisakh (Month 1) to Ashadh (Month 3) belong to previous year's start (e.g., 2081-82).
 */
export function formatNepaliFiscalYearCode(yearBS: number, monthBS: number): string {
  let startYear = yearBS;
  if (monthBS < 4) {
    startYear = yearBS - 1;
  }
  const endYearShort = String(startYear + 1).slice(-2);
  return `${startYear}-${endYearShort}`;
}

/**
 * Computes Fiscal Quarter in Nepal
 * Q1: Shrawan, Bhadra, Ashwin (Months 4, 5, 6)
 * Q2: Kartik, Mangsir, Poush (Months 7, 8, 9)
 * Q3: Magh, Falgun, Chaitra (Months 10, 11, 12)
 * Q4: Baisakh, Jestha, Ashadh (Months 1, 2, 3)
 */
export function getNepaliQuarter(monthBS: number): string {
  if (monthBS >= 4 && monthBS <= 6) return 'Q1';
  if (monthBS >= 7 && monthBS <= 9) return 'Q2';
  if (monthBS >= 10 && monthBS <= 12) return 'Q3';
  return 'Q4';
}

/**
 * One AD date claimed by TWO BS years. Overlaps are DATA errors — a month
 * array or a Baisakh-1 start date is off by a day. The seeded 2078-2085 data has
 * none: BS 2084 was corrected on 2026-10-16 (its array had one day too many in
 * Magh, so 2028-04-13 was claimed as 2084-12-30 AND 2085-01-01).
 *
 * The conversion must stay deterministic if bad data ever comes back, so both
 * sides resolve it the same way: the later BS year wins (the database does too —
 * `bs_day_records.ad_date` is the PRIMARY KEY inserted `ON CONFLICT (ad_date)
 * DO UPDATE` year by year), so the mirror lists one record per AD date like
 * bs_day_records does, and any collision is reported instead of hidden.
 */
export interface CalendarOverlap {
  adDate: string;
  earlierYearBS: number;
  earlierBs: string;
  laterYearBS: number;
  laterBs: string;
}

/**
 * Every AD date claimed by more than one seeded BS year ([] = clean data).
 * Pure: expands the given year data without touching the store, so it can
 * audit a candidate seed before it is applied.
 */
export function findCalendarOverlaps(data: Record<number, BSYearData>): CalendarOverlap[] {
  const claimed = new Map<string, { yearBS: number; bsDate: string }>();
  const overlaps: CalendarOverlap[] = [];
  for (const yData of Object.values(data).sort((a, b) => a.yearBS - b.yearBS)) {
    const runningDate = new Date(yData.startAD);
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const monthBS = monthIdx + 1;
      const daysInMonth = yData.daysInMonths[monthIdx] || 30;
      for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
        const adDate = runningDate.toISOString().split('T')[0];
        const bsDate = `${yData.yearBS}-${monthBS < 10 ? `0${monthBS}` : `${monthBS}`}-${
          dayBS < 10 ? `0${dayBS}` : `${dayBS}`
        }`;
        const existing = claimed.get(adDate);
        if (existing) {
          overlaps.push({
            adDate,
            earlierYearBS: existing.yearBS,
            earlierBs: existing.bsDate,
            laterYearBS: yData.yearBS,
            laterBs: bsDate,
          });
        } else {
          claimed.set(adDate, { yearBS: yData.yearBS, bsDate });
        }
        runningDate.setDate(runningDate.getDate() + 1);
      }
    }
  }
  return overlaps;
}

/**
 * Generates the day-by-day AD → BS lookup for all mapped BS years.
 *
 * ONE record per AD date, always. Every consumer resolves BY AD date
 * (lookupBSDayRecord, hasExactBSDayRecord, ensureBSDayForAD, and the server's
 * bs_day_records primary key), so a list that could hold two records for the
 * same day made the answer depend on array order — and made this mirror claim
 * one more day than the database actually stores. Overlapping years are
 * collapsed to the later year (identical to bs_day_records) and reported once,
 * so the underlying bad month array stays visible instead of silently
 * swallowing a day.
 */
let cachedDayDatabase: BSDayRecord[] = [];
let cachedDayDatabaseRevision = -1;
let warnedOverlapRevision = -1;

export function generateCalendarDatabase(): BSDayRecord[] {
  // Memoized on the store revision: this builds ~2,900 records and is called
  // on every render that shows calendar bounds (the dashboard coverage card,
  // the notification center, and both calendar screens' refresh). The returned
  // array is shared — treat it as read-only.
  if (cachedDayDatabaseRevision === calendarStoreRevision && cachedDayDatabase.length > 0) {
    return cachedDayDatabase;
  }
  const calendarData = getBsCalendarData();
  const sortedYears = Object.values(calendarData).sort((a, b) => a.yearBS - b.yearBS);
  // Keyed by AD date: a repeated day REPLACES its earlier claim, keeping the
  // original (chronological) position in the map.
  const byAdDate = new Map<string, BSDayRecord>();

  for (const yData of sortedYears) {
    const startADDate = new Date(yData.startAD);
    let runningDate = new Date(startADDate);

    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const monthBS = monthIdx + 1;
      const daysInMonth = yData.daysInMonths[monthIdx] || 30;

      for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
        const adDateStr = runningDate.toISOString().split('T')[0];
        const dayOfWeekIndex = runningDate.getUTCDay(); // 0 = Sun, 6 = Sat

        const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
        const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
        const bsDateStr = `${yData.yearBS}-${padMonth}-${padDay}`;

        const fyCode = formatNepaliFiscalYearCode(yData.yearBS, monthBS);
        const qtr = getNepaliQuarter(monthBS);

        byAdDate.set(adDateStr, {
          adDate: adDateStr,
          bsDate: bsDateStr,
          bsYear: yData.yearBS,
          bsMonth: monthBS,
          bsMonthName: NEPALI_MONTHS_EN[monthIdx],
          bsMonthNameNp: NEPALI_MONTHS_NP[monthIdx],
          bsDay: dayBS,
          dayOfWeekName: DAYS_OF_WEEK_EN[dayOfWeekIndex],
          dayOfWeekNameNp: DAYS_OF_WEEK_NP[dayOfWeekIndex],
          fiscalYear: fyCode,
          quarter: qtr,
          isWeekend: dayOfWeekIndex === 6, // Saturday is weekend in Nepal
        });

        // Increment 1 day
        runningDate.setDate(runningDate.getDate() + 1);
      }
    }
  }

  if (warnedOverlapRevision !== calendarStoreRevision) {
    warnedOverlapRevision = calendarStoreRevision;
    const overlaps = findCalendarOverlaps(calendarData);
    if (overlaps.length > 0) {
      const shown = overlaps
        .slice(0, 3)
        .map((o) => `${o.adDate} = ${o.earlierBs} (BS ${o.earlierYearBS}) vs ${o.laterBs} (BS ${o.laterYearBS})`)
        .join('; ');
      console.warn(
        `BS calendar: ${overlaps.length} AD date(s) are claimed by two seeded BS years — ${shown}` +
          `${overlaps.length > 3 ? ' …' : ''}. The later BS year wins (the same rule bs_day_records enforces), ` +
          'so conversions are unambiguous, but fix the overlapping year in BS Calendar Utility — its month '
          + 'array (or Baisakh 1 start date) is one day off.'
      );
    }
  }

  cachedDayDatabase = Array.from(byAdDate.values());
  cachedDayDatabaseRevision = calendarStoreRevision;
  return cachedDayDatabase;
}

/**
 * Retrieves the current bounds of the mapped Nepali Calendar database
 */
let cachedBounds: CalendarBounds | null = null;
let cachedBoundsRevision = -1;

export function getCalendarBounds(): CalendarBounds {
  // Same memo as generateCalendarDatabase: callers include per-render paths
  // (dashboard card, notification bell, both calendar screens), and the bounds
  // only change when the store does.
  if (cachedBounds && cachedBoundsRevision === calendarStoreRevision) return cachedBounds;

  const db = generateCalendarDatabase();
  if (db.length === 0) {
    // Nothing is mapped (empty store), so report the BUNDLED coverage — derived
    // from shared/bsCalendarYears.json rather than restated here. The literals
    // this replaces claimed the range ended at BS 2085-12-31, a day Chaitra 2085
    // does not have (30 days), and would have needed editing again the next time
    // a year is corrected.
    const years = Object.values(INITIAL_BS_CALENDAR_DATA).sort((a, b) => a.yearBS - b.yearBS);
    const first = years[0];
    const last = years[years.length - 1];
    if (first && last) {
      const lastMonthEnd = last.daysInMonths[last.daysInMonths.length - 1];
      const bundledEnd = new Date(`${last.startAD}T00:00:00Z`);
      bundledEnd.setUTCDate(
        bundledEnd.getUTCDate() + last.daysInMonths.reduce((sum, days) => sum + days, 0) - 1
      );
      return {
        minAD: first.startAD,
        maxAD: bundledEnd.toISOString().split('T')[0],
        minBS: `${first.yearBS}-01-01`,
        maxBS: `${last.yearBS}-12-${String(lastMonthEnd).padStart(2, '0')}`,
        totalDaysMapped: 0,
        mappedYearsCount: 0,
        mappedYears: [],
      };
    }
  }

  const minAD = db[0].adDate;
  const maxAD = db[db.length - 1].adDate;
  const minBS = db[0].bsDate;
  const maxBS = db[db.length - 1].bsDate;

  const yearsSet = Array.from(new Set(db.map((r) => r.bsYear))).sort((a, b) => a - b);

  cachedBounds = {
    minAD,
    maxAD,
    minBS,
    maxBS,
    totalDaysMapped: db.length,
    mappedYearsCount: yearsSet.length,
    mappedYears: yearsSet,
  };
  cachedBoundsRevision = calendarStoreRevision;
  return cachedBounds;
}

/**
 * Checks whether an AD date string is within mapped calendar database bounds
 */
export function isDateInBounds(adDateStr: string): {
  inBounds: boolean;
  message?: string;
  bounds: CalendarBounds;
} {
  const bounds = getCalendarBounds();
  if (!adDateStr) return { inBounds: true, bounds };

  const targetDateStr = adDateStr.split('T')[0];

  if (targetDateStr < bounds.minAD || targetDateStr > bounds.maxAD) {
    return {
      inBounds: false,
      message: `Date ${targetDateStr} is outside mapped calendar database bounds (${bounds.minAD} to ${bounds.maxAD} AD | BS ${bounds.minBS} to ${bounds.maxBS}).`,
      bounds,
    };
  }

  return { inBounds: true, bounds };
}

/**
 * Where an administrator actually seeds a missing BS month/year. Named exactly
 * as the sidebar shows it (Administration & Governance group). The messages
 * used to name a menu this app does not have, so an operator following them
 * could not find the screen.
 */
export const BS_SEEDING_MENU_PATH =
  'Administration & Governance → BS Calendar Utility';

/**
 * Coverage-warning thresholds, in days from today to the last seeded AD day.
 * The calendar must ALWAYS be seeded ahead of the dates operations use: once
 * the last mapped day passes, every dated operation refuses (bsDateMissing)
 * until an admin seeds the next BS year, so the warning has to arrive with
 * time to act (~two quarters).
 */
export const BS_COVERAGE_WARNING_DAYS = 180;
export const BS_COVERAGE_CRITICAL_DAYS = 30;

export type BsCoverageStatus = 'UNSEEDED' | 'OK' | 'WARNING' | 'CRITICAL' | 'EXPIRED';

export interface BsCalendarCoverageStatus extends CalendarBounds {
  /** Whole days from `asOf` (today by default) to the last mapped AD day.
   *  Negative once coverage has already ended. */
  daysRemaining: number;
  status: BsCoverageStatus;
  /** Seeded years the published patro data does not verify (Baisakh 1 derived,
   *  or a month array entered by hand). Dates in them work, but the coverage
   *  warning must keep naming them until the patro confirms the array. */
  provisionalYears: number[];
}

/**
 * How far the seeded BS calendar reaches, as of a given day. `status` is the
 * single decision every consumer branches on (dashboard card, notification
 * bell, "is this refusal about coverage or a gap?" checks).
 */
export function getBsCalendarCoverage(asOfAD?: string): BsCalendarCoverageStatus {
  const bounds = getCalendarBounds();
  const provisionalYears = getProvisionalYears();
  const asOf = String(asOfAD || new Date().toISOString()).split('T')[0];
  if (bounds.totalDaysMapped <= 0 || !bounds.maxAD) {
    return { ...bounds, daysRemaining: 0, status: 'UNSEEDED', provisionalYears };
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.floor(
    (Date.parse(`${bounds.maxAD}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS
  );
  if (!Number.isFinite(daysRemaining)) {
    return { ...bounds, daysRemaining: 0, status: 'UNSEEDED', provisionalYears };
  }
  const status: BsCoverageStatus =
    daysRemaining < 0
      ? 'EXPIRED'
      : daysRemaining <= BS_COVERAGE_CRITICAL_DAYS
      ? 'CRITICAL'
      : daysRemaining <= BS_COVERAGE_WARNING_DAYS
      ? 'WARNING'
      : 'OK';
  return { ...bounds, daysRemaining, status, provisionalYears };
}

/**
 * Looks up exact day record from the generated calendar database table.
 */
export function lookupBSDayRecord(adDateStr: string): BSDayRecord {
  const targetDateStr = (adDateStr || new Date().toISOString()).split('T')[0];
  const db = generateCalendarDatabase();

  const record = db.find((r) => r.adDate === targetDateStr);
  if (record) {
    return record;
  }

  // Fallback calculation if exact date is out of bounds
  try {
    const fallbackBS = convertADToBS(targetDateStr);
    const targetDate = new Date(targetDateStr);
    const dayOfWeekIndex = isNaN(targetDate.getTime()) ? 0 : targetDate.getUTCDay();

    return {
      adDate: targetDateStr,
      bsDate: fallbackBS.formattedBSShort.replace(' BS', ''),
      bsYear: fallbackBS.yearBS,
      bsMonth: fallbackBS.monthBS,
      bsMonthName: fallbackBS.monthName,
      bsMonthNameNp: NEPALI_MONTHS_NP[fallbackBS.monthBS - 1] || 'वैशाख',
      bsDay: fallbackBS.dayBS,
      dayOfWeekName: DAYS_OF_WEEK_EN[dayOfWeekIndex],
      dayOfWeekNameNp: DAYS_OF_WEEK_NP[dayOfWeekIndex],
      fiscalYear: formatNepaliFiscalYearCode(fallbackBS.yearBS, fallbackBS.monthBS),
      quarter: getNepaliQuarter(fallbackBS.monthBS),
      isWeekend: dayOfWeekIndex === 6,
    };
  } catch (err: any) {
    const targetDate = new Date(targetDateStr);
    const estBSYear = isNaN(targetDate.getTime()) ? 2083 : targetDate.getUTCFullYear() + 57;
    const dayOfWeekIndex = isNaN(targetDate.getTime()) ? 0 : targetDate.getUTCDay();

    return {
      adDate: targetDateStr,
      bsDate: `${estBSYear}-??-?? [Unseeded BS Year]`,
      bsYear: estBSYear,
      bsMonth: 1,
      bsMonthName: 'Unmapped',
      bsMonthNameNp: 'अवर्गीकृत',
      bsDay: 1,
      dayOfWeekName: DAYS_OF_WEEK_EN[dayOfWeekIndex],
      dayOfWeekNameNp: DAYS_OF_WEEK_NP[dayOfWeekIndex],
      fiscalYear: `${estBSYear}-${String(estBSYear + 1).slice(-2)}`,
      quarter: 'Q1',
      isWeekend: dayOfWeekIndex === 6,
    };
  }
}

/**
 * STRICT day-record check (no fallback estimation): true only when the synced
 * calendar has an exact AD -> BS record for this date.
 *
 * This used to test whether the date fell between a configured year's start and
 * start + total days, which is a SPAN test, not a record test: a year whose
 * month lengths were seeded wrong (or a date inside a configured year the day
 * table does not actually expand to) passed the client gate while the server,
 * which reads bs_day_records, refused the same date with a 400. Both sides now
 * ask the same question. Used to gate stock operations that require a valid
 * Nepali date.
 */
export function hasExactBSDayRecord(adDateStr?: string | null): boolean {
  // undefined means "no date supplied — check today" (the long-standing call
  // shape). An EMPTY string is a form field somebody cleared, and must never be
  // silently answered as today: that turned a blank date into a passing gate.
  const targetDateStr =
    adDateStr === undefined ? new Date().toISOString().split('T')[0] : String(adDateStr).split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateStr)) return false;
  return exactAdDateSet().has(targetDateStr);
}

/**
 * The set of AD dates the synced calendar maps to a BS date — the client twin of
 * `SELECT ad_date FROM bs_day_records`. Memoized per calendar revision, like
 * generateCalendarDatabase/getCalendarBounds, because form gates call it on
 * every submit.
 */
let cachedAdDateSet: Set<string> | null = null;
let cachedAdDateSetRevision = -1;
function exactAdDateSet(): Set<string> {
  if (cachedAdDateSet && cachedAdDateSetRevision === calendarStoreRevision) return cachedAdDateSet;
  cachedAdDateSet = new Set(generateCalendarDatabase().map((record) => record.adDate));
  cachedAdDateSetRevision = calendarStoreRevision;
  return cachedAdDateSet;
}

/**
 * Mandatory-BS resolver for operation payloads: BS dates are required on
 * every persisted operation, so whenever a payload builder has an AD date
 * but no BS date, it must auto-look-up the BS date from the synced
 * bs_day_records calendar table (client-side mirror of the server's seeded
 * data). Returns the "YYYY-MM-DD BS" string, or null when the calendar has
 * no exact mapping for the date — callers MUST block the operation and show
 * the "contact your system administrator for BS month seeding" message
 * instead of sending an empty, estimated, or hardcoded BS date.
 */
export function ensureBSDayForAD(adDateStr: string | null | undefined): string | null {
  const target = String(adDateStr || '').split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return null;
  if (!hasExactBSDayRecord(target)) return null;
  try {
    return convertADToBS(target).formattedBSShort;
  } catch {
    return null;
  }
}

/**
 * Converts AD Date String (YYYY-MM-DD) to formatted BS String using reference bsCalendarData.
 *
 * Throws when the date falls outside the mapped calendar (an unseeded day is the
 * caller's problem to report — use tryConvertADToBS/formatDualDate to render the
 * not-seeded marker), and returns the marker when the AD value is not a date at
 * all. Only an omitted argument means "today"; an empty string is a cleared field
 * and is NOT silently answered with today's BS date.
 */
export function convertADToBS(adDateStr: string): {
  yearBS: number;
  monthBS: number;
  dayBS: number;
  monthName: string;
  formattedBS: string;
  formattedBSShort: string;
} {
  const targetDateStr =
    adDateStr === undefined
      ? new Date().toISOString().split('T')[0]
      : String(adDateStr).split('T')[0];
  const targetDate = new Date(targetDateStr);

  if (isNaN(targetDate.getTime())) {
    // An AD value that is not a date has no BS counterpart. This used to return
    // Shrawan 16, 2083 — a real (wrong) date for all but one day, which reached
    // screens AND stored BS columns (CustomersManagement stores
    // convertADToBS(issuedDateAD).formattedBSShort on the device row). The
    // marker says "not seeded" instead, which isBsDateMissing() on the server
    // treats as missing rather than as a date. yearBS/monthBS/dayBS are 0 so no
    // caller can mistake the marker for a seeded month.
    return {
      yearBS: 0,
      monthBS: 0,
      dayBS: 0,
      monthName: BS_NOT_SEEDED,
      formattedBS: BS_NOT_SEEDED,
      formattedBSShort: BS_NOT_SEEDED,
    };
  }

  const calendarData = getBsCalendarData();
  const sortedYears = Object.values(calendarData).sort((a, b) => a.yearBS - b.yearBS);

  if (sortedYears.length === 0) {
    throw new Error('No BS Calendar years seeded in database.');
  }

  // Check if targetDate is before min mapped startAD or after max mapped end
  const minStartAD = new Date(sortedYears[0].startAD);
  const maxYearData = sortedYears[sortedYears.length - 1];
  const maxDays = maxYearData.daysInMonths.reduce((a, b) => a + b, 0);
  const maxEndAD = new Date(maxYearData.startAD);
  maxEndAD.setDate(maxEndAD.getDate() + maxDays - 1);

  if (targetDate < minStartAD || targetDate > maxEndAD) {
    const estYearBS = targetDate.getUTCFullYear() + 57;
    throw new Error(
      `BS Calendar month array for year ~${estYearBS} (AD Date: ${targetDateStr}) is missing from database (bs_calendar_years). Please seed the 12-month array first.`
    );
  }

  let selectedYearData = sortedYears[0];

  for (const yData of sortedYears) {
    const baisakh1 = new Date(yData.startAD);
    if (targetDate >= baisakh1) {
      selectedYearData = yData;
    } else {
      break;
    }
  }

  const baisakh1Date = new Date(selectedYearData.startAD);
  const diffTime = targetDate.getTime() - baisakh1Date.getTime();
  let diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  let monthBS = 1;
  let dayBS = 1;

  for (let i = 0; i < 12; i++) {
    const daysInCurrentMonth = selectedYearData.daysInMonths[i] || 30;
    if (diffDays >= daysInCurrentMonth) {
      diffDays -= daysInCurrentMonth;
      monthBS++;
    } else {
      dayBS = diffDays + 1;
      break;
    }
  }

  if (monthBS > 12) {
    monthBS = 12;
    dayBS = selectedYearData.daysInMonths[11] || 30;
  }

  const yearBS = selectedYearData.yearBS;
  const monthName = NEPALI_MONTHS_EN[monthBS - 1] || 'Baisakh';
  const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
  const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;

  return {
    yearBS,
    monthBS,
    dayBS,
    monthName,
    formattedBS: `${dayBS} ${monthName} ${yearBS} BS`,
    formattedBSShort: `${yearBS}-${padMonth}-${padDay} BS`,
  };
}

/**
 * Safe variant of convertADToBS: returns null instead of throwing when the AD
 * date falls outside the seeded BS calendar range. Use this anywhere a BS
 * string must be derived for display/storage without risking a crash.
 */
export function tryConvertADToBS(adDateStr: string): ReturnType<typeof convertADToBS> | null {
  try {
    return convertADToBS(adDateStr);
  } catch {
    return null;
  }
}

/**
 * Converts BS Date (year, month 1-12, day) to AD Date String (YYYY-MM-DD)
 */
export function convertBSToAD(yearBS: number, monthBS: number, dayBS: number): string {
  const calendarData = getBsCalendarData();
  const yearData = calendarData[yearBS];

  if (!yearData) {
    throw new Error(
      `BS Year ${yearBS} month array is missing from calendar database (bs_calendar_years). Please seed the 12-month array for BS ${yearBS} first.`
    );
  }

  const baisakh1 = new Date(yearData.startAD);
  let totalDaysToAdd = 0;

  for (let i = 0; i < monthBS - 1; i++) {
    totalDaysToAdd += yearData.daysInMonths[i] || 30;
  }
  totalDaysToAdd += dayBS - 1;

  const resultAD = new Date(baisakh1);
  resultAD.setDate(resultAD.getDate() + totalDaysToAdd);

  return resultAD.toISOString().split('T')[0];
}

/**
 * A single cell in a BS month grid.
 */
export interface BSGridCell {
  /** Day of the month for in-month cells; null for blank padding cells. */
  day: number | null;
  /** Mapped AD ISO date (YYYY-MM-DD); null for blank or unseeded cells. */
  adDate: string | null;
  /** True when the AD date has an exact bs_day_records mapping (server-gateable). */
  isSeeded: boolean;
  isToday: boolean;
  isSelected: boolean;
  /** True when the AD date falls outside the supplied inclusive min/max bounds. */
  outOfRange: boolean;
}

/**
 * Builds a 6x7 (42-cell) week grid for one BS month from the seeded
 * calendar. Weeks start on Sunday (Nepal convention). Returns null when the
 * year or month is not seeded.
 */
export function getBSMonthGrid(
  yearBS: number,
  monthBS: number,
  opts?: { todayAD?: string; selectedAD?: string; minAD?: string; maxAD?: string }
): BSGridCell[] | null {
  const data = getBsCalendarData();
  const yearData = data[yearBS];
  if (!yearData || !Array.isArray(yearData.daysInMonths) || monthBS < 1 || monthBS > 12) {
    return null;
  }
  const days = Number(yearData.daysInMonths[monthBS - 1]) || 0;
  if (!days) return null;

  const todayAD = (opts?.todayAD || new Date().toISOString()).split('T')[0];
  const selectedAD = opts?.selectedAD ? String(opts.selectedAD).split('T')[0] : '';
  const minAD = opts?.minAD ? String(opts.minAD).split('T')[0] : '';
  const maxAD = opts?.maxAD ? String(opts.maxAD).split('T')[0] : '';

  let firstDow: number;
  try {
    firstDow = new Date(convertBSToAD(yearBS, monthBS, 1)).getUTCDay();
  } catch {
    return null;
  }

  const cells: BSGridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = i - firstDow + 1;
    if (d < 1 || d > days) {
      cells.push({ day: null, adDate: null, isSeeded: false, isToday: false, isSelected: false, outOfRange: false });
      continue;
    }
    let adDate: string | null = null;
    try {
      adDate = convertBSToAD(yearBS, monthBS, d);
    } catch {
      adDate = null;
    }
    cells.push({
      day: d,
      adDate,
      isSeeded: adDate !== null && hasExactBSDayRecord(adDate),
      isToday: adDate !== null && adDate === todayAD,
      isSelected: adDate !== null && adDate === selectedAD,
      outOfRange: adDate !== null && ((minAD !== '' && adDate < minAD) || (maxAD !== '' && adDate > maxAD)),
    });
  }
  return cells;
}

/**
 * Calculates current Fiscal Year code in Nepal based on AD Date (e.g. "2082-83").
 */
export function getNepaliFiscalYear(adDateStr?: string): string {
  const dateStr = adDateStr ? adDateStr.split('T')[0] : new Date().toISOString().split('T')[0];
  const bs = convertADToBS(dateStr);
  return formatNepaliFiscalYearCode(bs.yearBS, bs.monthBS);
}

export function formatDualDate(adDateStr: string, mode: 'BS' | 'AD' = 'BS'): string {
  if (!adDateStr) return '-';
  const adFormatted = adDateStr.split('T')[0];
  // tryConvert, not convert: an unseeded date (past the end of the calendar, or
  // inside a year whose day records are missing) used to THROW here and take the
  // whole screen down. It now renders the explicit marker instead of a
  // fabricated BS date.
  const bsObj = tryConvertADToBS(adFormatted);
  if (!bsObj) {
    return mode === 'BS' ? `${BS_NOT_SEEDED} (${adFormatted})` : `${adFormatted} (${BS_NOT_SEEDED})`;
  }

  if (mode === 'BS') {
    return `${bsObj.formattedBSShort.replace(' BS', '')} (${adFormatted})`;
  }
  return `${adFormatted} (${bsObj.formattedBSShort.replace(' BS', '')})`;
}

/**
 * Standard uniform BS Date formatter in (YYYY-MM-DD) format.
 * Accepts either ISO AD date strings or existing BS strings.
 */
export function formatBSDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  const cleaned = String(dateStr).trim();
  if (!cleaned || cleaned === '-') return '-';

  // The stored not-seeded marker (server-side BS columns, or a row that could
  // not be resolved) is shown as itself — never reformatted into a date shape
  // it does not have.
  if (cleaned.toLowerCase() === BS_NOT_SEEDED.toLowerCase()) return BS_NOT_SEEDED;

  // Already in BS form: 2081-05-12, 2081/05/12 or 2081.05.12, with an optional
  // trailing BS suffix. (Written without a quoted date on purpose — a quoted
  // YYYY-MM-DD BS literal anywhere in client code is what
  // tests/bs_date.guard.test.ts now refuses.)
  const bsMatch = cleaned.match(/^(20[6-9]\d)[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (bsMatch) {
    const yr = bsMatch[1];
    const mo = bsMatch[2].padStart(2, '0');
    const da = bsMatch[3].padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  }

  // Otherwise assume AD date (e.g. ISO string "2026-08-17T..." or "2026-08-17")
  try {
    const adOnly = cleaned.split('T')[0].split(' ')[0];
    const bs = convertADToBS(adOnly);
    const padMonth = bs.monthBS < 10 ? `0${bs.monthBS}` : `${bs.monthBS}`;
    const padDay = bs.dayBS < 10 ? `0${bs.dayBS}` : `${bs.dayBS}`;
    return `${bs.yearBS}-${padMonth}-${padDay}`;
  } catch {
    return cleaned;
  }
}

/**
 * Gets today's BS date string in uniform (YYYY-MM-DD) format.
 */
export function getTodayBS(): string {
  const todayAD = new Date().toISOString().split('T')[0];
  return formatBSDate(todayAD);
}

/**
 * Gets current timestamp in uniform BS (YYYY-MM-DD HH:mm:ss) format.
 */
export function getTodayBSDateTime(): string {
  const now = new Date();
  const todayAD = now.toISOString().split('T')[0];
  const bsDate = formatBSDate(todayAD);
  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const secs = String(now.getSeconds()).padStart(2, '0');
  return `${bsDate} ${hours}:${mins}:${secs}`;
}

/**
 * Generates uniform export report metadata including BS & AD timestamps.
 */
export function getExportMetadata(reportName: string, branchName?: string, generatedBy?: string) {
  const now = new Date();
  const bsDateTime = getTodayBSDateTime();
  const bsDate = getTodayBS();
  const adDateTime = now.toISOString().replace('T', ' ').substring(0, 19);
  const adDate = now.toISOString().split('T')[0];

  return {
    reportName,
    branchName: branchName || 'All Branches',
    generatedBy: generatedBy || 'System User',
    exportedDateBS: bsDate,
    exportedDateTimeBS: bsDateTime,
    exportedDateAD: adDate,
    exportedDateTimeAD: adDateTime,
    filenameSuffix: `_BS_${bsDate}`,
  };
}

