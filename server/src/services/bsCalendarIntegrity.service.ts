/**
 * BS calendar integrity — ONE engine for every place that checks whether the
 * stored Nepali calendar is the published one.
 *
 * It is deliberately the only implementation of these rules:
 *   - `npm run audit:bs-dates` (scripts/audit_bs_calendar_dates.ts) is a thin
 *     CLI over this module,
 *   - GET  /api/bs-calendar/integrity       reports findings,
 *   - POST /api/bs-calendar/integrity/apply writes the derivable corrections
 *     (the Calendar Health panel in the BS Calendar Utility calls both),
 *   - the boot check logs findings without writing.
 * Four copies of the calendar DATA once drifted apart; four copies of the
 * audit would drift the same way, so the CLI can never disagree with the UI.
 *
 * Rules, in order:
 *   A. bs_calendar_years vs the bundled patro reference
 *      (shared/bsCalendarYears.json via config/bsCalendar):
 *        - a year the patro covers must carry the patro's month array + start;
 *        - a year the patro does not cover is PROVISIONAL: its array is
 *          somebody's entry, so it is flagged (and the coverage warning names
 *          it) instead of passing as verified calendar data;
 *        - a year whose month total does not match the AD gap to the next
 *          seeded year cannot tile the AD calendar.
 *   B. bs_day_records vs the calendar built from that data: missing days,
 *      mislabelled days, stale derived fiscal-year code / quarter, and rows
 *      outside the patro span (legitimate for a seeded future year).
 *   C. every stored "*_bs" value in the schema: a day the patro has, repaired
 *      from the row's own AD sibling where one exists.
 *   D. fiscal_years: BS labels must exist AND match their own AD date, and the
 *      AD range must be Shrawan 1 -> the day before the next Shrawan 1, then
 *      bs_day_records.fiscal_year_id is re-linked and is_current re-derived.
 *
 * Applying NEVER guesses: a finding is fixable only when its correct value is
 * derivable from the patro reference or from the row's own AD date. Anything
 * else is reported with what the operator has to supply.
 */
import { DEFAULT_BS_YEARS_SERVER, buildBsDayRecordsForYear } from '../config/bsCalendar';
import {
  BS_CALENDAR_YEARS_SELECT_SQL,
  BS_CALENDAR_YEAR_UPSERT_SQL,
  BS_CALENDAR_YEAR_SET_SOURCE_SQL,
  BS_DAY_RECORD_UPSERT_SQL,
  BS_INTEGRITY_DAY_RECORDS_SELECT_SQL,
  BS_INTEGRITY_BS_COLUMNS_SQL,
  BS_INTEGRITY_ALL_COLUMNS_SQL,
  BS_INTEGRITY_DAY_RELABEL_SQL,
  BS_INTEGRITY_FISCAL_YEARS_SELECT_SQL,
  BS_INTEGRITY_FY_LINK_CLEAR_SQL,
  BS_INTEGRITY_FY_LINK_SET_SQL,
  BS_INTEGRITY_CURRENT_FY_SELECT_SQL,
  BS_INTEGRITY_CURRENT_FY_SET_SQL,
  bsDayRecordParams,
  bsIntegrityAdValueSql,
  bsIntegrityFiscalYearUpdateSql,
  bsIntegritySetBsValueSql,
  bsIntegrityValueRowsSql,
  FY_SET_PROVISIONAL_SQL,
} from '../models/admin.repo';
import { bsYearsSpannedBy } from '../utils/fiscalYear';

/** Minimal client shape the engine needs (a pg Pool or PoolClient). */
export interface IntegrityClient {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface PatroYear {
  yearBS: number;
  daysInMonths: number[];
  startAD: string;
}

export interface PatroDay {
  adDate: string;
  bsDate: string;
  bsYear: number;
  bsMonth: number;
  bsDay: number;
  bsMonthName: string;
  bsMonthNameNp: string;
  dayOfWeekName: string;
  dayOfWeekNameNp: string;
  fiscalYear: string;
  quarter: string;
  isWeekend: boolean;
}

/**
 * The patro reference, expanded once per audit: every day the published data
 * covers, both directions, plus the covered year set.
 */
export interface PatroExpectations {
  years: PatroYear[];
  yearsSet: Set<number>;
  byAd: Map<string, PatroDay>;
  adByBs: Map<string, string>;
  validBs: Set<string>;
  minAD: string | null;
  maxAD: string | null;
}

export type BsIntegrityKind =
  | 'year_config_mismatch'
  | 'year_unverified'
  | 'year_span_mismatch'
  | 'day_missing'
  | 'day_label'
  | 'day_derived'
  | 'day_outside_calendar'
  | 'stored_bs_value'
  | 'fiscal_year_boundary'
  | 'fiscal_year_link'
  | 'fiscal_year_current'
  | 'fiscal_year_provisional';

export interface BsIntegrityFinding {
  /** Stable id — the apply endpoint takes these, never client-supplied values. */
  id: string;
  kind: BsIntegrityKind;
  severity: 'error' | 'warning';
  title: string;
  detail: string;
  current?: string | null;
  expected?: string | null;
  /** True only when the correct value is derivable (see the module header). */
  fixable: boolean;
  /** What Fix does, shown on the button; absent when not fixable. */
  fixAction?: string;
  yearBS?: number;
  target?: string;
  targetId?: string;
}

export interface BsIntegritySummary {
  /** Years present in bs_calendar_years. */
  yearsSeeded: number;
  /** Years the bundled patro verifies. */
  yearsCoveredByPatro: number;
  /** Patro-verified years missing from the database (a real gap). */
  yearsMissingFromDb: number[];
  /** Seeded years the patro does not verify (provisional by definition). */
  provisionalYears: number[];
  patroDays: number;
  dayRows: number;
  dayRowsOutsidePatro: number;
  /** "*_bs" values inspected by the stored-date sweep (section C). */
  storedBsValuesChecked: number;
  total: number;
  fixable: number;
  errors: number;
  warnings: number;
}

export interface BsIntegrityReport {
  generatedAt: string;
  summary: BsIntegritySummary;
  findings: BsIntegrityFinding[];
}

export interface BsIntegrityApplyResult {
  applied: Array<{ id: string; kind: BsIntegrityKind; title: string }>;
  skipped: Array<{ id: string; reason: string }>;
  /** The audit re-run after the writes — what is left, not what we hoped. */
  report: BsIntegrityReport;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' shifted by whole days (UTC-safe, no local-time drift). */
export function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

/** Total days in a month array; non-numeric entries count as 30 (as stored). */
export function totalDays(daysInMonths: unknown): number {
  if (!Array.isArray(daysInMonths)) return 0;
  return daysInMonths.reduce((sum, d) => sum + (Number(d) || 0), 0);
}

/**
 * A stored BS date — trailing "BS" suffix optional, zero padding optional —
 * normalized to YYYY-MM-DD; null when the value is not a BS date at all.
 * (The literal form is described here rather than shown: a quoted BS date in
 * server code is what tests/bs_date.guard.test.ts forbids.)
 */
export function parseBsDate(raw: unknown): string | null {
  const match = String(raw ?? '').trim().replace(/\s*BS$/i, '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

/**
 * Expands the bundled patro reference into the day-by-day expectations.
 * `years` is injectable so the tests can drive the engine with synthetic
 * calendars; production callers use the bundled data.
 */
export function buildPatroExpectations(years: PatroYear[] = DEFAULT_BS_YEARS_SERVER): PatroExpectations {
  const byAd = new Map<string, PatroDay>();
  const adByBs = new Map<string, string>();
  const validBs = new Set<string>();
  for (const year of years) {
    const records = buildBsDayRecordsForYear(year.yearBS, year.daysInMonths, year.startAD) as PatroDay[];
    for (const record of records) {
      byAd.set(record.adDate, record);
      validBs.add(record.bsDate);
      adByBs.set(record.bsDate, record.adDate);
    }
  }
  const sortedAd = Array.from(byAd.keys()).sort();
  return {
    years,
    yearsSet: new Set(years.map((y) => y.yearBS)),
    byAd,
    adByBs,
    validBs,
    minAD: sortedAd[0] ?? null,
    maxAD: sortedAd[sortedAd.length - 1] ?? null,
  };
}

interface DbYearRow {
  yearBS: number;
  daysInMonths: number[];
  startAD: string;
  startAdSource?: string | null;
  isProvisional?: boolean | null;
}

/**
 * The audit. Pure rules over injected data: it reads the calendar tables, the
 * day table, every "*_bs" column and the fiscal years, and returns findings in
 * a stable order. Nothing here writes.
 */
/**
 * Audit options. `years` is the patro reference (production: the bundled
 * shared/bsCalendarYears.json data; tests: a synthetic calendar) and `today`
 * is the day the fiscal-year `is_current` rule is judged against (production:
 * the real today). Both are injectable so every rule is testable without a
 * database and without depending on the wall clock.
 */
export interface BsIntegrityOptions {
  years?: PatroYear[];
  today?: string;
}

export async function auditBsCalendar(
  client: IntegrityClient,
  options: BsIntegrityOptions = {}
): Promise<BsIntegrityReport> {
  const patro = buildPatroExpectations(options.years);
  const findings: BsIntegrityFinding[] = [];

  const dbYears: DbYearRow[] = (await client.query(BS_CALENDAR_YEARS_SELECT_SQL)).rows.map((row) => ({
    yearBS: Number(row.yearBS),
    daysInMonths: Array.isArray(row.daysInMonths) ? row.daysInMonths.map(Number) : [],
    startAD: String(row.startAD ?? '').split('T')[0],
    startAdSource: row.startAdSource ?? null,
    isProvisional: row.isProvisional ?? null,
  }));
  const dbYearByBsa = new Map(dbYears.map((y) => [y.yearBS, y]));

  // ---- A. year rows vs the patro reference ---------------------------------
  for (const year of patro.years) {
    const row = dbYearByBsa.get(year.yearBS);
    if (!row) {
      findings.push({
        id: `year:${year.yearBS}:missing`,
        kind: 'year_config_mismatch',
        severity: 'error',
        title: `BS ${year.yearBS} is not seeded`,
        detail: `The patro data covers BS ${year.yearBS} but bs_calendar_years has no row for it, so every date in that year is unavailable.`,
        current: null,
        expected: `${year.startAD} + [${year.daysInMonths.join(', ')}]`,
        fixable: true,
        fixAction: `Seed BS ${year.yearBS} from the patro reference`,
        yearBS: year.yearBS,
        target: 'bs_calendar_years',
      });
      continue;
    }
    const arrayMatches = String(row.daysInMonths) === String(year.daysInMonths);
    const startMatches = row.startAD === year.startAD;
    if (!arrayMatches || !startMatches) {
      findings.push({
        id: `year:${year.yearBS}:config`,
        kind: 'year_config_mismatch',
        severity: 'error',
        title: `BS ${year.yearBS} does not match the published patro`,
        detail:
          `bs_calendar_years holds ${JSON.stringify(row.daysInMonths)} starting ${row.startAD}; the patro data has ` +
          `${JSON.stringify(year.daysInMonths)} starting ${year.startAD}. Every AD date in this year is off by the difference.`,
        current: `${row.startAD} + [${row.daysInMonths.join(', ')}]`,
        expected: `${year.startAD} + [${year.daysInMonths.join(', ')}]`,
        fixable: true,
        fixAction: `Restore BS ${year.yearBS} from the patro reference`,
        yearBS: year.yearBS,
        target: 'bs_calendar_years',
      });
    } else if (row.isProvisional) {
      // Verified against the patro — the provisional flag is simply stale.
      findings.push({
        id: `year:${year.yearBS}:provisional`,
        kind: 'year_unverified',
        severity: 'warning',
        title: `BS ${year.yearBS} is no longer provisional`,
        detail: `The row matches the patro data but is still flagged provisional, so the coverage warning keeps naming a verified year.`,
        current: 'is_provisional = true',
        expected: 'is_provisional = false',
        fixable: true,
        fixAction: `Clear the provisional flag on BS ${year.yearBS}`,
        yearBS: year.yearBS,
        target: 'bs_calendar_years',
      });
    }
  }

  for (const row of dbYears) {
    if (patro.yearsSet.has(row.yearBS)) continue;
    if (!row.isProvisional || row.startAdSource === 'patro') {
      findings.push({
        id: `year:${row.yearBS}:unverified`,
        kind: 'year_unverified',
        severity: 'warning',
        title: `BS ${row.yearBS} is not verified by the published patro`,
        detail:
          `bs_calendar_years holds BS ${row.yearBS} (${row.startAD} + [${row.daysInMonths.join(', ')}]) but the bundled patro ` +
          `data does not cover that year, so nothing confirms the array. Date reads will keep warning until it is confirmed.`,
        current: `start_ad_source = ${row.startAdSource ?? 'patro'}${row.isProvisional ? ', is_provisional = true' : ''}`,
        expected: `start_ad_source = 'estimated', is_provisional = true`,
        fixable: true,
        fixAction: `Mark BS ${row.yearBS} provisional`,
        yearBS: row.yearBS,
        target: 'bs_calendar_years',
      });
    }
  }

  // Month totals must tile the AD calendar: a year's days have to fill the gap
  // to the next seeded year's start exactly, or the two mappings disagree.
  const seededSorted = [...dbYears].sort((a, b) => a.yearBS - b.yearBS);
  for (let i = 0; i < seededSorted.length - 1; i += 1) {
    const year = seededSorted[i];
    const next = seededSorted[i + 1];
    const expectedSpan = Math.round(
      (new Date(`${next.startAD}T00:00:00Z`).getTime() - new Date(`${year.startAD}T00:00:00Z`).getTime()) / DAY_MS
    );
    const actualSpan = totalDays(year.daysInMonths);
    if (expectedSpan === actualSpan || actualSpan === 0) continue;
    const patroYear = patro.years.find((y) => y.yearBS === year.yearBS);
    findings.push({
      id: `year:${year.yearBS}:span`,
      kind: 'year_span_mismatch',
      severity: 'error',
      title: `BS ${year.yearBS} does not fill the AD calendar`,
      detail:
        `BS ${year.yearBS} claims ${actualSpan} days but BS ${next.yearBS} starts ${expectedSpan} days after it, so ` +
        `${Math.abs(expectedSpan - actualSpan)} day(s) belong to both years or to neither.`,
      current: `${actualSpan} days`,
      expected: `${expectedSpan} days`,
      fixable: Boolean(patroYear),
      fixAction: patroYear ? `Restore BS ${year.yearBS} from the patro reference` : undefined,
      yearBS: year.yearBS,
      target: 'bs_calendar_years',
    });
  }

  // ---- B. day records -------------------------------------------------------
  const dayRows: Array<{ ad: string; bs: string; fiscal_year: string; quarter: string; fiscal_year_id: string | null }> =
    (await client.query(BS_INTEGRITY_DAY_RECORDS_SELECT_SQL)).rows.map((row) => ({
      ad: String(row.ad).split('T')[0],
      bs: row.bs,
      fiscal_year: row.fiscal_year,
      quarter: row.quarter,
      fiscal_year_id: row.fiscal_year_id ?? null,
    }));
  const dbDayByAd = new Map(dayRows.map((row) => [row.ad, row]));
  const outsideByYear = new Map<number, number>();

  for (const [adDate, want] of patro.byAd) {
    const row = dbDayByAd.get(adDate);
    if (!row) {
      findings.push({
        id: `day:${adDate}:missing`,
        kind: 'day_missing',
        severity: 'error',
        title: `${adDate} has no day record`,
        detail: `The patro data maps ${adDate} to ${want.bsDate} BS but bs_day_records has no row, so that date cannot be used.`,
        current: null,
        expected: want.bsDate,
        fixable: true,
        fixAction: `Insert the missing day row`,
        target: 'bs_day_records',
        targetId: adDate,
      });
      continue;
    }
    if (row.bs !== want.bsDate) {
      findings.push({
        id: `day:${adDate}:label`,
        kind: 'day_label',
        severity: 'error',
        title: `${adDate} is labelled wrong`,
        detail: `bs_day_records stores ${row.bs} for ${adDate}; the patro data says ${want.bsDate}.`,
        current: row.bs,
        expected: want.bsDate,
        fixable: true,
        fixAction: `Relabel ${adDate} (and its derived fiscal year / quarter)`,
        target: 'bs_day_records',
        targetId: adDate,
      });
    } else if (row.fiscal_year !== want.fiscalYear || row.quarter !== want.quarter) {
      findings.push({
        id: `day:${adDate}:derived`,
        kind: 'day_derived',
        severity: 'error',
        title: `${adDate} has a stale fiscal year / quarter`,
        detail:
          `bs_day_records has fiscal_year ${row.fiscal_year} and quarter ${row.quarter} for ${want.bsDate}; ` +
          `derived from the BS month it must be ${want.fiscalYear} / ${want.quarter}.`,
        current: `${row.fiscal_year} / ${row.quarter}`,
        expected: `${want.fiscalYear} / ${want.quarter}`,
        fixable: true,
        fixAction: `Recompute the derived fields for ${adDate}`,
        target: 'bs_day_records',
        targetId: adDate,
      });
    }
  }

  for (const row of dayRows) {
    if (patro.byAd.has(row.ad)) continue;
    const year = Number(String(row.bs).slice(0, 4)) || 0;
    outsideByYear.set(year, (outsideByYear.get(year) ?? 0) + 1);
  }
  for (const [year, count] of Array.from(outsideByYear.entries()).sort((a, b) => a[0] - b[0])) {
    findings.push({
      id: `day-outside:${year}`,
      kind: 'day_outside_calendar',
      severity: 'warning',
      title: `${count} day row(s) of BS ${year} are outside the patro data`,
      detail:
        `bs_day_records has ${count} row(s) for BS ${year}, which the bundled patro data does not cover. This is expected for a ` +
        `deliberately seeded future year; it is reported so nobody mistakes it for verified calendar data.`,
      current: `${count} rows`,
      expected: null,
      fixable: false,
      yearBS: year,
      target: 'bs_day_records',
    });
  }

  // ---- C. every stored "*_bs" value ----------------------------------------
  const bsCols: Array<{ table_name: string; column_name: string }> = (
    await client.query(BS_INTEGRITY_BS_COLUMNS_SQL)
  ).rows;
  const allCols: Array<{ table_name: string; column_name: string }> = (
    await client.query(BS_INTEGRITY_ALL_COLUMNS_SQL)
  ).rows;
  let storedBsChecked = 0;

  for (const { table_name: table, column_name: column } of bsCols) {
    if (!allCols.some((c) => c.table_name === table && c.column_name === 'id')) continue;
    const rows: Array<{ id: any; value: any }> = (
      await client.query(bsIntegrityValueRowsSql(table, column))
    ).rows;
    storedBsChecked += rows.length;
    const base = column.replace(/_bs$/, '');
    const adSiblings = allCols
      .filter((c) => c.table_name === table && c.column_name !== column)
      .map((c) => c.column_name)
      .filter((c) => c === base || c === `${base}_ad` || c === base.replace(/_date$/, '_date_ad'));
    const adColumn = adSiblings.find((c) => c.endsWith('_ad')) || adSiblings[0] || null;

    for (const row of rows) {
      const iso = parseBsDate(row.value);
      if (iso && patro.validBs.has(iso)) continue;
      const adValue = adColumn
        ? (await client.query(bsIntegrityAdValueSql(table, adColumn), [row.id])).rows[0]?.value
        : null;
      const adIso = adValue ? String(adValue).split('T')[0] : null;
      const derived = adIso ? patro.byAd.get(adIso)?.bsDate : undefined;
      findings.push({
        id: `bsvalue:${table}.${column}:${row.id}`,
        kind: 'stored_bs_value',
        severity: 'error',
        title: `${table}.${column} holds a date the patro does not have`,
        detail: derived
          ? `Row ${row.id} stores ${row.value}; its own AD date ${adIso} is ${derived} BS.`
          : `Row ${row.id} stores ${row.value}, which is not a day the patro has` +
            (adColumn
              ? ` and its AD sibling ${adColumn} (${adIso ?? 'null'}) is outside the patro data.`
              : ' and the table has no AD column to derive from.'),
        current: String(row.value),
        expected: derived ? `${derived} BS` : null,
        fixable: Boolean(derived),
        fixAction: derived ? `Set ${column} from ${adColumn}` : undefined,
        target: `${table}.${column}`,
        targetId: String(row.id),
      });
    }
  }

  // ---- D. fiscal years ------------------------------------------------------
  const fiscalYears: Array<{
    id: string;
    code: string;
    start_ad: string;
    end_ad: string;
    start_date_bs: string | null;
    end_date_bs: string | null;
    is_current: boolean;
    is_provisional: boolean;
  }> = (await client.query(BS_INTEGRITY_FISCAL_YEARS_SELECT_SQL)).rows.map((row) => ({
    id: row.id,
    code: String(row.code),
    start_ad: String(row.start_ad).split('T')[0],
    end_ad: String(row.end_ad).split('T')[0],
    start_date_bs: row.start_date_bs ?? null,
    end_date_bs: row.end_date_bs ?? null,
    is_current: Boolean(row.is_current),
    is_provisional: Boolean(row.is_provisional),
  }));

  for (const fy of fiscalYears) {
    const bsYear = parseBsDate(fy.start_date_bs)?.slice(0, 4) ?? fy.code.slice(0, 4);
    const patroStart = patro.adByBs.get(`${bsYear}-04-01`);
    const nextStart = patro.adByBs.get(`${Number(bsYear) + 1}-04-01`);
    if (!patroStart || !nextStart) {
      findings.push({
        id: `fy:${fy.id}:coverage`,
        kind: 'fiscal_year_boundary',
        severity: 'warning',
        title: `FY ${fy.code} ends past the patro data`,
        detail:
          `FY ${fy.code} runs ${fy.start_ad}..${fy.end_ad} (${fy.start_date_bs}..${fy.end_date_bs}). Its end is the day before ` +
          `Shrawan 1 of BS ${Number(bsYear) + 1}, which the patro data does not cover, so the label cannot be derived yet.`,
        current: `${fy.start_date_bs}..${fy.end_date_bs}`,
        expected: null,
        fixable: false,
        target: 'fiscal_years',
        targetId: fy.id,
      });
      continue;
    }
    const patroEnd = shiftDays(nextStart, -1);
    const wantStartBS = patro.byAd.get(patroStart)!.bsDate;
    const wantEndBS = patro.byAd.get(patroEnd)!.bsDate;
    const fixes: string[] = [];
    if (fy.start_ad !== patroStart) fixes.push(`start AD ${fy.start_ad} -> ${patroStart}`);
    if (fy.end_ad !== patroEnd) fixes.push(`end AD ${fy.end_ad} -> ${patroEnd}`);
    if (parseBsDate(fy.start_date_bs) !== wantStartBS) fixes.push(`start BS ${fy.start_date_bs} -> ${wantStartBS} BS`);
    if (parseBsDate(fy.end_date_bs) !== wantEndBS) fixes.push(`end BS ${fy.end_date_bs} -> ${wantEndBS} BS`);
    if (fixes.length === 0) {
      // The labels agree with the patro, so a "provisional" stamp left over
      // from when they were typed (or from a calendar year that has since been
      // verified) is stale: the year now has verified BS boundaries and should
      // stop telling the operator it does not. This is the closing half of the
      // create-side verdict in post_fiscalYears — seed the missing year, then
      // the audit can promote the fiscal year out of provisional.
      if (fy.is_provisional) {
        findings.push({
          id: `fy:${fy.id}:provisional`,
          kind: 'fiscal_year_provisional',
          severity: 'warning',
          title: `FY ${fy.code} is still flagged provisional`,
          detail:
            `Its BS boundaries now match the patro data exactly (${wantStartBS} BS .. ${wantEndBS} BS), so the provisional flag ` +
            'no longer describes anything. Clearing it does not move any date.',
          current: 'provisional',
          expected: 'verified',
          fixable: true,
          fixAction: `Clear the provisional flag on FY ${fy.code}`,
          target: 'fiscal_years',
          targetId: fy.id,
        });
      }
      continue;
    }
    findings.push({
      id: `fy:${fy.id}:boundary`,
      kind: 'fiscal_year_boundary',
      severity: 'error',
      title: `FY ${fy.code} is not a Nepali fiscal year`,
      detail: `A fiscal year runs Shrawan 1 -> the day before the next Shrawan 1. ${fixes.join('; ')}.`,
      current: `${fy.start_ad}..${fy.end_ad} (${fy.start_date_bs}..${fy.end_date_bs})`,
      expected: `${patroStart}..${patroEnd} (${wantStartBS} BS .. ${wantEndBS} BS)`,
      fixable: true,
      fixAction: `Realign FY ${fy.code} to its Shrawan 1 boundaries`,
      target: 'fiscal_years',
      targetId: fy.id,
    });
  }

  // Stale day-row links: a fiscal_year_id that does not contain the row's date,
  // plus rows a fiscal year DOES contain but that link to nothing. Days outside
  // every fiscal year's range are not a finding at all — the calendar reaches
  // back further than the fiscal-year table does, and there is no year to link
  // them to (the CLI used to re-link those 800+ days into NULL every run).
  const coversDate = (row: { ad: string }, fy: { start_ad: string; end_ad: string }): boolean =>
    row.ad >= fy.start_ad && row.ad <= fy.end_ad;
  const linkedFyById = new Map(fiscalYears.map((fy) => [fy.id, fy]));
  const mislinked = dayRows.filter((row) => {
    if (!row.fiscal_year_id) return false;
    const fy = linkedFyById.get(row.fiscal_year_id);
    if (!fy) return true;
    return !coversDate(row, fy);
  });
  const unlinked = dayRows.filter(
    (row) => !row.fiscal_year_id && fiscalYears.some((fy) => coversDate(row, fy))
  );
  if (mislinked.length > 0 || unlinked.length > 0) {
    findings.push({
      id: 'fylink:bs_day_records',
      kind: 'fiscal_year_link',
      severity: 'warning',
      title: `${mislinked.length + unlinked.length} day row(s) point at the wrong fiscal year`,
      detail:
        `${mislinked.length} row(s) link to a fiscal year that does not contain their AD date and ${unlinked.length} row(s) link to ` +
        `none. Reports scoped by fiscal year silently drop or double-count those days.`,
      current: `${mislinked.length} stale, ${unlinked.length} unlinked`,
      expected: 'every row linked to the fiscal year containing its AD date',
      fixable: true,
      fixAction: 'Re-link day rows to the fiscal year containing their date',
      target: 'bs_day_records',
    });
  }

  const today = options.today ?? new Date().toISOString().split('T')[0];
  const currentFy = fiscalYears.find((fy) => today >= fy.start_ad && today <= fy.end_ad);
  if (currentFy && !currentFy.is_current) {
    findings.push({
      id: 'fycurrent:mismatch',
      kind: 'fiscal_year_current',
      severity: 'warning',
      title: 'The current fiscal year flag is wrong',
      detail: `${today} falls inside FY ${currentFy.code}, which is not flagged current (${fiscalYears.filter((fy) => fy.is_current).map((fy) => fy.code).join(', ') || 'none'} is).`,
      current: fiscalYears.filter((fy) => fy.is_current).map((fy) => fy.code).join(', ') || 'none',
      expected: currentFy.code,
      fixable: true,
      fixAction: `Flag FY ${currentFy.code} as current`,
      target: 'fiscal_years',
      targetId: currentFy.id,
    });
  } else if (!currentFy && fiscalYears.length > 0) {
    findings.push({
      id: 'fycurrent:missing',
      kind: 'fiscal_year_current',
      severity: 'warning',
      title: `No fiscal year contains ${today}`,
      detail: 'Create the fiscal year that covers today (Shrawan 1 boundaries) and mark it current.',
      current: null,
      expected: null,
      fixable: false,
      target: 'fiscal_years',
    });
  }

  const fixable = findings.filter((f) => f.fixable).length;
  const provisionalYears = dbYears
    .filter((y) => y.isProvisional || !patro.yearsSet.has(y.yearBS))
    .map((y) => y.yearBS)
    .sort((a, b) => a - b);
  const yearsMissingFromDb = patro.years.filter((y) => !dbYearByBsa.has(y.yearBS)).map((y) => y.yearBS);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      yearsSeeded: dbYears.length,
      yearsCoveredByPatro: patro.years.length,
      yearsMissingFromDb,
      provisionalYears,
      patroDays: patro.byAd.size,
      dayRows: dayRows.length,
      dayRowsOutsidePatro: dayRows.filter((row) => !patro.byAd.has(row.ad)).length,
      storedBsValuesChecked: storedBsChecked,
      total: findings.length,
      fixable,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
    },
    findings,
  };
}

/**
 * Applies the derivable corrections. Every write goes through the caller's
 * transaction (admin.controller uses withTransaction, the CLI one BEGIN) so a
 * failure leaves the calendar exactly as it was.
 *
 * `ids` selects findings; omitted means every fixable finding. The list is
 * resolved against a FRESH audit, so the payload can only name findings, never
 * supply the values that get written.
 */
export async function applyBsCalendarFixes(
  client: IntegrityClient,
  ids?: string[],
  options: BsIntegrityOptions = {}
): Promise<BsIntegrityApplyResult> {
  const before = await auditBsCalendar(client, options);
  const wanted = ids && ids.length > 0 ? new Set(ids) : null;
  const selected = before.findings.filter((f) => f.fixable && (!wanted || wanted.has(f.id)));
  const skipped: Array<{ id: string; reason: string }> = [];
  if (wanted) {
    for (const id of wanted) {
      const finding = before.findings.find((f) => f.id === id);
      if (!finding) skipped.push({ id, reason: 'finding no longer exists' });
      else if (!finding.fixable) skipped.push({ id, reason: 'not derivable from the patro data — fix it by hand' });
    }
  }

  // Same reference data the audit used: the fix values come from the audit's
  // own expectations, never from the caller.
  const patro = buildPatroExpectations(options.years);
  const applied: BsIntegrityApplyResult['applied'] = [];
  let wantsFyRelink = false;
  let wantsCurrentFix = false;

  for (const finding of selected) {
    switch (finding.kind) {
      case 'year_config_mismatch': {
        const year = patro.years.find((y) => y.yearBS === finding.yearBS);
        if (!year) {
          skipped.push({ id: finding.id, reason: 'the patro data has no array for this year' });
          break;
        }
        await client.query(BS_CALENDAR_YEAR_UPSERT_SQL, [
          year.yearBS,
          year.daysInMonths,
          year.startAD,
          'patro',
          false,
        ]);
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      case 'year_span_mismatch': {
        const year = patro.years.find((y) => y.yearBS === finding.yearBS);
        if (!year) {
          skipped.push({
            id: finding.id,
            reason: 'the patro data has no array for this year — enter the published month lengths by hand',
          });
          break;
        }
        await client.query(BS_CALENDAR_YEAR_UPSERT_SQL, [
          year.yearBS,
          year.daysInMonths,
          year.startAD,
          'patro',
          false,
        ]);
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      case 'year_unverified': {
        // Metadata only: the array stays exactly as the operator entered it.
        const yearBS = finding.yearBS ?? 0;
        const verified = patro.yearsSet.has(yearBS);
        await client.query(BS_CALENDAR_YEAR_SET_SOURCE_SQL, [
          yearBS,
          verified ? 'patro' : 'estimated',
          !verified,
        ]);
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      case 'day_missing': {
        const want = patro.byAd.get(String(finding.targetId));
        if (!want) break;
        await client.query(BS_DAY_RECORD_UPSERT_SQL, bsDayRecordParams(want));
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      case 'day_label':
      case 'day_derived': {
        const want = patro.byAd.get(String(finding.targetId));
        if (!want) break;
        await client.query(BS_INTEGRITY_DAY_RELABEL_SQL, [
          want.adDate,
          want.bsDate,
          want.bsMonth,
          want.bsDay,
          want.bsMonthName,
          want.bsMonthNameNp,
          want.fiscalYear,
          want.quarter,
        ]);
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      case 'stored_bs_value': {
        const [table, column] = String(finding.target).split('.');
        const derived = finding.expected ? parseBsDate(finding.expected) : null;
        if (!table || !column || !derived) break;
        await client.query(bsIntegritySetBsValueSql(table, column), [finding.targetId, `${derived} BS`]);
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      case 'fiscal_year_boundary': {
        // The expected string is produced by the audit itself; the regex reads
        // the AD/BS boundaries back out of it so nothing is re-derived here.
        const parts = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}) \((.*) BS \.\. (.*) BS\)$/.exec(
          String(finding.expected ?? '')
        );
        if (!parts) {
          skipped.push({ id: finding.id, reason: 'no derivable boundary for this fiscal year' });
          break;
        }
        await client.query(bsIntegrityFiscalYearUpdateSql(), [
          finding.targetId,
          parts[1],
          parts[2],
          `${parts[3]} BS`,
          `${parts[4]} BS`,
        ]);
        wantsFyRelink = true;
        // The labels just became calendar-derived; the flag follows them in the
        // same transaction, so the year can't stay "provisional" over verified
        // labels (nor claim verification over a year still missing from patro).
        const spannedYears = bsYearsSpannedBy(`${parts[3]} BS`, `${parts[4]} BS`);
        const allVerified = spannedYears.length > 0 && spannedYears.every((yearBS) => patro.yearsSet.has(yearBS));
        await client.query(FY_SET_PROVISIONAL_SQL, [finding.targetId, !allVerified]);
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      case 'fiscal_year_provisional': {
        await client.query(FY_SET_PROVISIONAL_SQL, [finding.targetId, false]);
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      case 'fiscal_year_link': {
        const cleared = await client.query(BS_INTEGRITY_FY_LINK_CLEAR_SQL);
        const linked = await client.query(BS_INTEGRITY_FY_LINK_SET_SQL);
        applied.push({
          id: finding.id,
          kind: finding.kind,
          title: `${finding.title} (${linked.rowCount ?? 0} linked, ${cleared.rowCount ?? 0} cleared)`,
        });
        break;
      }
      case 'fiscal_year_current': {
        wantsCurrentFix = true;
        applied.push({ id: finding.id, kind: finding.kind, title: finding.title });
        break;
      }
      default:
        skipped.push({ id: finding.id, reason: 'no fix is implemented for this finding' });
    }
  }

  // Boundary moves invalidate the day-row links, and the current-year flag is
  // derived from the boundaries, so both follow the fixes above in the same
  // transaction (never left half-applied).
  if (wantsFyRelink) {
    await client.query(BS_INTEGRITY_FY_LINK_CLEAR_SQL);
    await client.query(BS_INTEGRITY_FY_LINK_SET_SQL);
  }
  if (wantsCurrentFix) {
    const today = options.today ?? new Date().toISOString().split('T')[0];
    const containing = (await client.query(BS_INTEGRITY_CURRENT_FY_SELECT_SQL, [today])).rows[0];
    if (containing) {
      await client.query(BS_INTEGRITY_CURRENT_FY_SET_SQL, [containing.id]);
    } else {
      skipped.push({ id: 'fycurrent:mismatch', reason: `no fiscal year contains ${today}` });
    }
  }

  return { applied, skipped, report: await auditBsCalendar(client, options) };
}

/**
 * Rewrites one year's day records from its stored configuration (the "Rebuild
 * BS Calendar Days" maintenance operation now shares this engine).
 */
export async function rebuildYearDayRecords(client: IntegrityClient, yearBS: number): Promise<number> {
  const rows = (await client.query(BS_CALENDAR_YEARS_SELECT_SQL)).rows as DbYearRow[];
  const year = rows.find((row) => Number(row.yearBS) === yearBS);
  if (!year) return 0;
  const records = buildBsDayRecordsForYear(year.yearBS, year.daysInMonths, year.startAD) as PatroDay[];
  for (const record of records) {
    await client.query(BS_DAY_RECORD_UPSERT_SQL, bsDayRecordParams(record));
  }
  return records.length;
}
