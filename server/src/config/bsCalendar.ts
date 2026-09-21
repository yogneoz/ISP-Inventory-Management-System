// Bikram Sambat (BS) calendar: built-in year data, in-memory fallback cache,
// day-record generation and AD/BS lookup helpers. Extracted verbatim from the
// former app.ts section of the same name.
import { pgPool } from '../../db';

// Bikram Sambat (BS) Calendar & Day Records Endpoints
export const NEPALI_MONTHS_EN_SERVER = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
];

export const NEPALI_MONTHS_NP_SERVER = [
  'वैशाख', 'जेठ', 'असार', 'श्रावण', 'भाद्र', 'असोज',
  'कार्तिक', 'मंसिर', 'पुस', 'माघ', 'फागुन', 'चैत'
];

export const DAYS_OF_WEEK_EN_SERVER = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

export const DAYS_OF_WEEK_NP_SERVER = [
  'आइतबार', 'सोमबार', 'मंगलबार', 'बुधबार', 'बिहीबार', 'शुक्रबार', 'शनिबार'
];

export const DEFAULT_BS_YEARS_SERVER = [
  { yearBS: 2078, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2021-04-14' },
  { yearBS: 2079, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2022-04-14' },
  { yearBS: 2080, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2023-04-14' },
  { yearBS: 2081, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2024-04-13' },
  { yearBS: 2082, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2025-04-14' },
  { yearBS: 2083, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2026-04-14' },
  { yearBS: 2084, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2027-04-14' },
  { yearBS: 2085, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2028-04-13' },
];

export let inMemoryBsCalendarYears = [...DEFAULT_BS_YEARS_SERVER];
export let inMemoryBsDayRecords: any[] = [];

export function generateInMemoryBsDayRecords() {
  const recordsMap = new Map<string, any>();
  for (const yData of inMemoryBsCalendarYears) {
    let runningDate = new Date(yData.startAD);
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const monthBS = monthIdx + 1;
      const daysInMonth = yData.daysInMonths[monthIdx] || 30;

      for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
        const adDateStr = runningDate.toISOString().split('T')[0];
        const dayOfWeekIndex = runningDate.getUTCDay();

        const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
        const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
        const bsDateStr = `${yData.yearBS}-${padMonth}-${padDay}`;

        let startYear = yData.yearBS;
        if (monthBS < 4) startYear = yData.yearBS - 1;
        const fyCode = `${startYear}-${String(startYear + 1).slice(-2)}`;

        let qtr = 'Q4';
        if (monthBS >= 4 && monthBS <= 6) qtr = 'Q1';
        else if (monthBS >= 7 && monthBS <= 9) qtr = 'Q2';
        else if (monthBS >= 10 && monthBS <= 12) qtr = 'Q3';

        recordsMap.set(adDateStr, {
          adDate: adDateStr,
          bsDate: bsDateStr,
          bsYear: yData.yearBS,
          bsMonth: monthBS,
          bsMonthName: NEPALI_MONTHS_EN_SERVER[monthIdx],
          bsMonthNameNp: NEPALI_MONTHS_NP_SERVER[monthIdx],
          bsDay: dayBS,
          dayOfWeekName: DAYS_OF_WEEK_EN_SERVER[dayOfWeekIndex],
          dayOfWeekNameNp: DAYS_OF_WEEK_NP_SERVER[dayOfWeekIndex],
          fiscalYear: fyCode,
          quarter: qtr,
          isWeekend: dayOfWeekIndex === 6,
        });

        runningDate.setDate(runningDate.getDate() + 1);
      }
    }
  }
  inMemoryBsDayRecords = Array.from(recordsMap.values());
}

// Initial generation of in-memory records
generateInMemoryBsDayRecords();

/**
 * Date-type integrity guard.
 *
 * Detects when a BS (Nepali) date string has been submitted in an AD date
 * field (or vice versa) so calendar mismatches can never reach the database:
 *  - values containing the "BS" suffix are rejected for AD fields
 *  - a 4-digit year >= 2060 (BS years are 2078-2099, AD dates here are 2015-2059)
 *    is treated as a BS date sent in the wrong field
 *  - malformed date strings are rejected
 *
 * Returns a human-readable error message, or null when the value is a valid AD date.
 */
export function detectDateTypeMismatch(raw: unknown, fieldName: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/\bBS\b/i.test(s)) {
    return `Date type mismatch: "${s}" is a BS (Nepali) date but was sent in AD field "${fieldName}". AD fields must contain a Gregorian (AD) date like 2026-08-30. Send the matching BS value only in the corresponding ${fieldName}BS field.`;
  }
  const m = s.split('T')[0].match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    return `Date type mismatch: "${s}" in field "${fieldName}" is not a valid AD date (expected YYYY-MM-DD Gregorian format).`;
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (year >= 2060) {
    return `Date type mismatch: "${s}" looks like a BS (Nepali) date (year ${year}) but was sent in AD field "${fieldName}". Convert it to its Gregorian (AD) equivalent first, e.g. send dateAD=2026-08-30 and dateBS=2083-05-14 BS.`;
  }
  if (year < 2015) {
    return `Date type mismatch: "${s}" in field "${fieldName}" is not a plausible AD date (AD year must be between 2015 and 2059). If it is a BS date, convert it to AD before submitting.`;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return `Date type mismatch: "${s}" in field "${fieldName}" is not a valid AD date (month/day out of range).`;
  }
  return null;
}

/**
 * Resolves the exact BS day record for an AD date. PostgreSQL's bs_day_records
 * table is authoritative; the in-memory cache is only consulted while
 * PostgreSQL is unreachable. Returns found=false when the date has never been
 * seeded (e.g. its BS month array is missing) so callers can block operations.
 */
export async function findBsDayRecordForAdDate(adDateStr: string): Promise<{
  found: boolean;
  record: any | null;
  source: 'postgres' | 'memory';
}> {
  const target = String(adDateStr || '').split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    return { found: false, record: null, source: 'memory' };
  }

  try {
    const result = await pgPool.query(
      `SELECT ad_date::text AS "adDate", bs_date AS "bsDate", bs_year AS "bsYear", bs_month AS "bsMonth",
              bs_month_name AS "bsMonthName", bs_month_name_np AS "bsMonthNameNp", bs_day AS "bsDay",
              day_of_week_name AS "dayOfWeekName", day_of_week_name_np AS "dayOfWeekNameNp",
              fiscal_year AS "fiscalYear", quarter, is_weekend AS "isWeekend"
       FROM bs_day_records
       WHERE ad_date = $1`,
      [target]
    );
    if (result.rows.length > 0) {
      return { found: true, record: result.rows[0], source: 'postgres' };
    }
    // Database reachable but no row exists for this date -> genuinely unseeded
    return { found: false, record: null, source: 'postgres' };
  } catch (_err) {
    // PostgreSQL unreachable -> fall back to the in-memory calendar cache
    const memoryRecord = inMemoryBsDayRecords.find((r) => r.adDate === target) || null;
    return { found: memoryRecord !== null, record: memoryRecord, source: 'memory' };
  }
}

// Refreshes the in-memory BS-calendar fallback cache from PostgreSQL, which is
// the authoritative store for bs_calendar_years / bs_day_records. Called at
// startup so the cache (used only while PostgreSQL is unreachable) starts in
// sync with the database instead of the built-in defaults.
export async function hydrateBsCalendarFromDb(client: any) {
  try {
    const yrRes = await client.query(
      'SELECT year_bs AS "yearBS", days_in_months AS "daysInMonths", start_ad::text AS "startAD" FROM bs_calendar_years ORDER BY year_bs ASC'
    );
    if (yrRes.rows.length > 0) inMemoryBsCalendarYears = yrRes.rows;
    const dayRes = await client.query(
      `SELECT ad_date::text AS "adDate", bs_date AS "bsDate", bs_year AS "bsYear", bs_month AS "bsMonth",
              bs_month_name AS "bsMonthName", bs_month_name_np AS "bsMonthNameNp", bs_day AS "bsDay",
              day_of_week_name AS "dayOfWeekName", day_of_week_name_np AS "dayOfWeekNameNp",
              fiscal_year AS "fiscalYear", quarter, is_weekend AS "isWeekend"
       FROM bs_day_records ORDER BY ad_date ASC`
    );
    if (dayRes.rows.length > 0) inMemoryBsDayRecords = dayRes.rows;
  } catch (e: any) {
    console.warn('BS calendar hydration from PostgreSQL skipped; using built-in calendar:', e?.message || e);
  }
}


// Single-day lookup against bs_day_records. Used by the stock-operations gate
// to verify that a Nepali (BS) date exists for the operation date before any
// stock movement is allowed.



// Bulk (multi-year) seed endpoint - accepts array of { yearBS, daysInMonths, customStartAD? }

/**
 * Builds the AD -> BS day-by-day records for one BS year from its config
 * (start_ad + days_in_months). Mirrors generateInMemoryBsDayRecords() so the
 * same mapping logic is used for PostgreSQL writes and the in-memory cache.
 */
export function buildBsDayRecordsForYear(yearBS: number, daysInMonths: number[], startAD: string): any[] {
  const records: any[] = [];
  let runningDate = new Date(startAD);
  for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
    const monthBS = monthIdx + 1;
    const daysInMonth = daysInMonths[monthIdx] || 30;

    for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
      const adDateStr = runningDate.toISOString().split('T')[0];
      const dayOfWeekIndex = runningDate.getUTCDay();

      const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
      const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
      const bsDateStr = `${yearBS}-${padMonth}-${padDay}`;

      let startYear = yearBS;
      if (monthBS < 4) startYear = yearBS - 1;
      const fyCode = `${startYear}-${String(startYear + 1).slice(-2)}`;

      let qtr = 'Q4';
      if (monthBS >= 4 && monthBS <= 6) qtr = 'Q1';
      else if (monthBS >= 7 && monthBS <= 9) qtr = 'Q2';
      else if (monthBS >= 10 && monthBS <= 12) qtr = 'Q3';

      records.push({
        adDate: adDateStr,
        bsDate: bsDateStr,
        bsYear: yearBS,
        bsMonth: monthBS,
        bsMonthName: NEPALI_MONTHS_EN_SERVER[monthIdx],
        bsMonthNameNp: NEPALI_MONTHS_NP_SERVER[monthIdx],
        bsDay: dayBS,
        dayOfWeekName: DAYS_OF_WEEK_EN_SERVER[dayOfWeekIndex],
        dayOfWeekNameNp: DAYS_OF_WEEK_NP_SERVER[dayOfWeekIndex],
        fiscalYear: fyCode,
        quarter: qtr,
        isWeekend: dayOfWeekIndex === 6,
      });

      runningDate.setDate(runningDate.getDate() + 1);
    }
  }
  return records;
}

/**
 * Updates the month-length configuration and/or the AD start date of an
 * existing BS year, then regenerates that year's day-by-day records in
 * bs_day_records so the derived lookup table always matches the configuration.
 *
 * When `recalculateNextStartAD` is true (default) and the edit changes the
 * edited year's total length (or its start date), every subsequent seeded BS
 * year is shifted by the same delta so AD->BS mappings stay continuous and
 * intentional gaps between non-consecutive seeded years are preserved. All
 * affected years have their day records regenerated.
 *
 * Body: { daysInMonths?: number[12], startAD?: string, recalculateNextStartAD?: boolean }
 */


// Audit Trail & Transaction Logs


// Customer Device & Serial Number Lookup

export function setInMemoryBsCalendarYears(value: any) { inMemoryBsCalendarYears = value as any; }
export function setInMemoryBsDayRecords(value: any) { inMemoryBsDayRecords = value as any; }

