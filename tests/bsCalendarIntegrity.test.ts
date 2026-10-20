/**
 * BS calendar integrity engine — rules, findings and the apply path.
 *
 * The engine (server/src/services/bsCalendarIntegrity.service.ts) is the ONE
 * implementation behind `npm run audit:bs-dates`, GET/POST
 * /api/bs-calendar/integrity, the Calendar Health panel and the boot check, so
 * these tests drive it against an in-memory fake of the four tables it reads
 * (bs_calendar_years, bs_day_records, the "*_bs" column sweep and fiscal_years)
 * and a SYNTHETIC patro reference — small enough to reason about, and injected
 * through the engine's own `years` option instead of the bundled data.
 *
 * PROVES:
 *   - a year the patro covers but the database does not hold is fixable;
 *   - a year whose array/start drifted from the patro is fixable, and the fix
 *     writes the patro's values (never a value from the caller);
 *   - a year the patro does not cover is flagship-reported and only ever gets
 *     its provenance flags written (never an invented array);
 *   - day rows: missing / mislabelled / stale-derived are each reported and
 *     fixable, and rows outside the patro span are reported only;
 *   - a stored "*_bs" value is fixable from its own AD sibling, and reported as
 *     unrepairable when there is no sibling to derive from;
 *   - fiscal years are realigned to Shrawan 1 boundaries, day links re-derived,
 *     and is_current recomputed;
 *   - applying leaves the audit clean, and the client's finding-kind union
 *     covers every kind the server emits.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyBsCalendarFixes,
  auditBsCalendar,
  buildPatroExpectations,
  parseBsDate,
  shiftDays,
  totalDays,
  type IntegrityClient,
  type PatroYear,
} from '../server/src/services/bsCalendarIntegrity.service';
import {
  BS_CALENDAR_YEARS_SELECT_SQL,
  BS_CALENDAR_YEAR_SET_SOURCE_SQL,
  BS_CALENDAR_YEAR_UPSERT_SQL,
  BS_DAY_RECORD_UPSERT_SQL,
  BS_INTEGRITY_ALL_COLUMNS_SQL,
  BS_INTEGRITY_BS_COLUMNS_SQL,
  BS_INTEGRITY_CURRENT_FY_SELECT_SQL,
  BS_INTEGRITY_CURRENT_FY_SET_SQL,
  BS_INTEGRITY_DAY_RECORDS_SELECT_SQL,
  BS_INTEGRITY_DAY_RELABEL_SQL,
  BS_INTEGRITY_FISCAL_YEARS_SELECT_SQL,
  BS_INTEGRITY_FY_LINK_CLEAR_SQL,
  BS_INTEGRITY_FY_LINK_SET_SQL,
  bsIntegrityAdValueSql,
  bsIntegrityFiscalYearUpdateSql,
  bsIntegritySetBsValueSql,
  bsIntegrityValueRowsSql,
  FY_SET_PROVISIONAL_SQL,
} from '../server/src/models/admin.repo';
import { buildBsDayRecordsForYear } from '../server/src/config/bsCalendar';

/**
 * A tiny two-year patro reference that genuinely TILES the AD calendar: BS 2100
 * runs 2043-04-14 -> 2044-04-13 (366 days, because 2044 is a leap year) and BS
 * 2101 starts 2044-04-14 for another 366 days. The span rule compares
 * consecutive seeded years, so a fixture that did not tile would (correctly)
 * report itself.
 */
const PATRO: PatroYear[] = [
  { yearBS: 2100, daysInMonths: [31, 31, 31, 31, 32, 30, 30, 30, 30, 30, 30, 30], startAD: '2043-04-14' },
  { yearBS: 2101, daysInMonths: [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30], startAD: '2044-04-14' },
];
const PATRO_DAYS = buildBsDayRecordsForYear(2100, PATRO[0].daysInMonths, PATRO[0].startAD).concat(
  buildBsDayRecordsForYear(2101, PATRO[1].daysInMonths, PATRO[1].startAD)
);
const LAST_PATRO_AD = PATRO_DAYS[PATRO_DAYS.length - 1].adDate;

/** The audit options every case uses: the synthetic patro reference, and a
 *  "today" inside the synthetic fiscal year (the is_current rule is judged
 *  against a day, so a test must not depend on the wall clock). */
const OPTS = { years: PATRO, today: '2043-10-01' };

interface FakeState {
  years: Array<{ yearBS: number; daysInMonths: number[]; startAD: string; startAdSource?: string; isProvisional?: boolean }>;
  days: Array<{ ad: string; bs: string; fiscal_year: string; quarter: string; fiscal_year_id: string | null }>;
  fiscalYears: Array<{
    id: string;
    code: string;
    start_ad: string;
    end_ad: string;
    start_date_bs: string | null;
    end_date_bs: string | null;
    is_current: boolean;
    is_provisional?: boolean;
  }>;
  storedBs: Record<string, { table: string; column: string; id: string; value: string; ad: string | null }>;
  writes: string[];
}

/** Tables/columns the fake exposes to the "*_bs" sweep: one date column with an
 *  AD sibling, and one without (so the unrepairable branch is exercised). */
const BS_COLUMNS = [
  { table_name: 'documents', column_name: 'invoice_date_bs' },
  { table_name: 'notes', column_name: 'noted_date_bs' },
];
const ALL_COLUMNS = [
  { table_name: 'documents', column_name: 'id' },
  { table_name: 'documents', column_name: 'invoice_date_bs' },
  { table_name: 'documents', column_name: 'invoice_date_ad' },
  { table_name: 'notes', column_name: 'id' },
  { table_name: 'notes', column_name: 'noted_date_bs' },
];

function makeFake(state: FakeState): IntegrityClient {
  return {
    async query(sql: string, params: any[] = []) {
      state.writes.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
      if (sql === BS_CALENDAR_YEARS_SELECT_SQL) return { rows: state.years };
      if (sql === BS_INTEGRITY_DAY_RECORDS_SELECT_SQL) return { rows: state.days };
      if (sql === BS_INTEGRITY_BS_COLUMNS_SQL) return { rows: BS_COLUMNS };
      if (sql === BS_INTEGRITY_ALL_COLUMNS_SQL) return { rows: ALL_COLUMNS };
      if (sql === BS_INTEGRITY_FISCAL_YEARS_SELECT_SQL) return { rows: state.fiscalYears };
      if (sql === bsIntegrityValueRowsSql('documents', 'invoice_date_bs')) {
        return { rows: Object.values(state.storedBs).filter((r) => r.table === 'documents').map((r) => ({ id: r.id, value: r.value })) };
      }
      if (sql === bsIntegrityValueRowsSql('notes', 'noted_date_bs')) {
        return { rows: Object.values(state.storedBs).filter((r) => r.table === 'notes').map((r) => ({ id: r.id, value: r.value })) };
      }
      if (sql === bsIntegrityAdValueSql('documents', 'invoice_date_ad')) {
        const row = state.storedBs[`documents:${params[0]}`];
        return { rows: row ? [{ value: row.ad }] : [] };
      }
      if (sql === BS_CALENDAR_YEAR_UPSERT_SQL) {
        const [yearBS, daysInMonths, startAD, startAdSource, isProvisional] = params;
        const existing = state.years.find((y) => y.yearBS === Number(yearBS));
        const next = { yearBS: Number(yearBS), daysInMonths, startAD, startAdSource, isProvisional };
        if (existing) Object.assign(existing, next);
        else state.years.push(next);
        return { rows: [], rowCount: 1 };
      }
      if (sql === BS_CALENDAR_YEAR_SET_SOURCE_SQL) {
        const [yearBS, source, provisional] = params;
        const row = state.years.find((y) => y.yearBS === Number(yearBS));
        if (row) {
          row.startAdSource = source;
          row.isProvisional = provisional;
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql === BS_INTEGRITY_DAY_RELABEL_SQL) {
        const [ad, bsDate, , , , , fiscalYear, quarter] = params;
        const row = state.days.find((d) => d.ad === ad);
        if (row) {
          row.bs = bsDate;
          row.fiscal_year = fiscalYear;
          row.quarter = quarter;
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql === BS_DAY_RECORD_UPSERT_SQL) {
        const [adDate, bsDate, , , , , , , , fYear, quarter] = params;
        state.days.push({ ad: adDate, bs: bsDate, fiscal_year: fYear, quarter, fiscal_year_id: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql === bsIntegritySetBsValueSql('documents', 'invoice_date_bs')) {
        const stored = state.storedBs[`documents:${params[0]}`];
        if (stored) stored.value = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (sql === bsIntegrityFiscalYearUpdateSql()) {
        const [id, startAD, endAD, startBS, endBS] = params;
        const row = state.fiscalYears.find((fy) => fy.id === id);
        if (row) {
          row.start_ad = startAD ?? row.start_ad;
          row.end_ad = endAD ?? row.end_ad;
          row.start_date_bs = startBS ?? row.start_date_bs;
          row.end_date_bs = endBS ?? row.end_date_bs;
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql === FY_SET_PROVISIONAL_SQL) {
        const row = state.fiscalYears.find((fy) => fy.id === params[0]);
        if (row) row.is_provisional = Boolean(params[1]);
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (sql === BS_INTEGRITY_FY_LINK_CLEAR_SQL) {
        let cleared = 0;
        for (const day of state.days) {
          const fy = state.fiscalYears.find((f) => f.id === day.fiscal_year_id);
          if (fy && (day.ad < fy.start_ad || day.ad > fy.end_ad)) {
            day.fiscal_year_id = null;
            cleared += 1;
          }
        }
        return { rows: [], rowCount: cleared };
      }
      if (sql === BS_INTEGRITY_FY_LINK_SET_SQL) {
        let linked = 0;
        for (const day of state.days) {
          if (day.fiscal_year_id) continue;
          const fy = state.fiscalYears.find((f) => day.ad >= f.start_ad && day.ad <= f.end_ad);
          if (fy) {
            day.fiscal_year_id = fy.id;
            linked += 1;
          }
        }
        return { rows: [], rowCount: linked };
      }
      if (sql === BS_INTEGRITY_CURRENT_FY_SELECT_SQL) {
        const today = params[0];
        const row = state.fiscalYears.find((fy) => today >= fy.start_ad && today <= fy.end_ad);
        return { rows: row ? [{ id: row.id, code: row.code }] : [] };
      }
      if (sql === BS_INTEGRITY_CURRENT_FY_SET_SQL) {
        for (const fy of state.fiscalYears) fy.is_current = fy.id === params[0];
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fake has no handler for: ${sql.slice(0, 60)}`);
    },
  };
}

/** A healthy state: both years match the patro, day rows correct, one FY. */
function healthyState(): FakeState {
  const state: FakeState = {
    years: PATRO.map((y) => ({
      yearBS: y.yearBS,
      daysInMonths: [...y.daysInMonths],
      startAD: y.startAD,
      startAdSource: 'patro',
      isProvisional: false,
    })),
    // Links are computed below from the fiscal year's real boundaries: a day
    // outside every fiscal year has no link, and that is NOT a finding.
    days: PATRO_DAYS.map((record) => ({
      ad: record.adDate,
      bs: record.bsDate,
      fiscal_year: record.fiscalYear,
      quarter: record.quarter,
      fiscal_year_id: null as string | null,
    })),
    fiscalYears: [
      {
        id: 'fy-1',
        code: '2100-01',
        start_ad: '2043-07-17',
        end_ad: '2044-07-15',
        start_date_bs: '2100-04-01 BS',
        end_date_bs: '2101-03-31 BS',
        is_current: true,
      },
    ],
    storedBs: {
      'documents:d1': { table: 'documents', column: 'invoice_date_bs', id: 'd1', value: '2100-04-01 BS', ad: '2043-04-14' },
      'notes:n1': { table: 'notes', column: 'noted_date_bs', id: 'n1', value: '2100-04-01 BS', ad: null },
    },
    writes: [],
  };
  // The healthy fiscal year above must agree with the synthetic patro: Shrawan 1
  // 2100 -> the day before Shrawan 1 2101.
  const patro = buildPatroExpectations(PATRO);
  const fyStart = patro.adByBs.get('2100-04-01')!;
  const fyEnd = shiftDays(patro.adByBs.get('2101-04-01')!, -1);
  state.fiscalYears[0].start_ad = fyStart;
  state.fiscalYears[0].end_ad = fyEnd;
  state.fiscalYears[0].start_date_bs = `${patro.byAd.get(fyStart)!.bsDate} BS`;
  state.fiscalYears[0].end_date_bs = `${patro.byAd.get(fyEnd)!.bsDate} BS`;
  for (const day of state.days) {
    if (day.ad >= fyStart && day.ad <= fyEnd) day.fiscal_year_id = 'fy-1';
  }
  return state;
}

describe('BS calendar integrity — pure helpers', () => {
  test('the patro reference expands both directions and reports its span', () => {
    const patro = buildPatroExpectations(PATRO);
    assert.equal(patro.yearsSet.size, 2);
    assert.equal(patro.byAd.size, 366 + 366);
    assert.equal(patro.validBs.size, 366 + 366);
    assert.equal(patro.minAD, '2043-04-14');
    assert.equal(patro.maxAD, LAST_PATRO_AD);
    // Shrawan 1 (month 4) is four month-lengths in, not the year start.
    assert.equal(patro.adByBs.get('2100-04-01'), '2043-07-16');
    // The two years must TILE: Baisakh 1 of 2101 is the day after the last day
    // of BS 2100 (Chaitra 30), with no gap and no overlap.
    const lastDayOf2100 = patro.adByBs.get('2100-12-30')!;
    assert.equal(patro.adByBs.get('2101-01-01'), shiftDays(lastDayOf2100, 1));
  });

  test('parseBsDate accepts the stored shapes and rejects prose', () => {
    assert.equal(parseBsDate('2082-04-01 BS'), '2082-04-01');
    assert.equal(parseBsDate(' 2082-4-1 '), '2082-04-01');
    assert.equal(parseBsDate('BS not seeded'), null);
    assert.equal(parseBsDate(''), null);
    assert.equal(parseBsDate(null), null);
  });

  test('shiftDays / totalDays are UTC-safe and defensive', () => {
    assert.equal(shiftDays('2044-04-13', 1), '2044-04-14');
    assert.equal(shiftDays('2044-03-01', -1), '2044-02-29'); // leap year
    assert.equal(totalDays([31, 31, 30]), 92);
    assert.equal(totalDays(['31' as any, 31]), 62);
    assert.equal(totalDays(undefined), 0);
  });
});

describe('BS calendar integrity — findings', () => {
  test('a healthy calendar has no findings', async () => {
    const report = await auditBsCalendar(makeFake(healthyState()), OPTS);
    assert.deepEqual(report.findings, [], `unexpected findings: ${report.findings.map((f) => f.title).join('; ')}`);
    assert.equal(report.summary.fixable, 0);
    assert.equal(report.summary.dayRows, 366 + 366);
    assert.equal(report.summary.dayRowsOutsidePatro, 0);
    assert.equal(report.summary.storedBsValuesChecked, 2);
  });

  test('a patro year missing from the database is fixable', async () => {
    const state = healthyState();
    state.years = state.years.filter((y) => y.yearBS !== 2101);
    state.days = state.days.filter((d) => !d.bs.startsWith('2101-'));
    const report = await auditBsCalendar(makeFake(state), OPTS);
    const finding = report.findings.find((f) => f.kind === 'year_config_mismatch');
    assert.ok(finding, 'the missing year must be reported');
    assert.equal(finding!.fixable, true);
    assert.deepEqual(report.summary.yearsMissingFromDb, [2101]);
    // Every day of the missing year is missing too — reported, not silently dropped.
    assert.equal(report.findings.filter((f) => f.kind === 'day_missing').length, 366);
  });

  test('a drifted year is fixable and the fix writes the patro array', async () => {
    const state = healthyState();
    state.years[0].daysInMonths = [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
    const fake = makeFake(state);
    const report = await auditBsCalendar(fake, OPTS);
    const finding = report.findings.find((f) => f.kind === 'year_config_mismatch' && f.yearBS === 2100)!;
    assert.equal(finding.fixable, true);
    assert.ok(finding.detail.includes('patro'));

    const applied = await applyBsCalendarFixes(fake, undefined, OPTS);
    assert.ok(applied.applied.some((a) => a.id === finding.id));
    assert.deepEqual(state.years[0].daysInMonths, PATRO[0].daysInMonths);
    assert.equal(state.years[0].startAdSource, 'patro');
  });

  test('a year the patro does not cover is reported and only gets flagged', async () => {
    const state = healthyState();
    state.years.push({
      yearBS: 2102,
      daysInMonths: [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      startAD: '2045-04-14',
      startAdSource: 'patro',
      isProvisional: false,
    });
    const fake = makeFake(state);
    const report = await auditBsCalendar(fake, OPTS);
    const finding = report.findings.find((f) => f.kind === 'year_unverified' && f.yearBS === 2102)!;
    assert.equal(finding.fixable, true, 'the provenance flag is derivable even when the array is not');
    assert.deepEqual(report.summary.provisionalYears, [2102]);

    await applyBsCalendarFixes(fake, undefined, OPTS);
    const year = state.years.find((y) => y.yearBS === 2102)!;
    assert.equal(year.startAdSource, 'estimated');
    assert.equal(year.isProvisional, true);
    // The month array is NEVER rewritten for an unverified year.
    assert.deepEqual(year.daysInMonths, [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]);
  });

  test('day rows: mislabelled + stale derived fields + rows outside the patro', async () => {
    const state = healthyState();
    const mislabelled = state.days[10];
    mislabelled.bs = '2100-02-11'; // the patro says 2100-01-11
    mislabelled.fiscal_year = '2099-00';
    mislabelled.quarter = 'Q4';
    state.days.push({ ad: '2045-06-01', bs: '2102-02-19', fiscal_year: '2101-02', quarter: 'Q4', fiscal_year_id: null });

    const report = await auditBsCalendar(makeFake(state), OPTS);
    const label = report.findings.find((f) => f.kind === 'day_label')!;
    assert.equal(label.targetId, mislabelled.ad);
    assert.equal(label.expected, PATRO_DAYS[10].bsDate);
    const outside = report.findings.find((f) => f.kind === 'day_outside_calendar')!;
    assert.equal(outside.fixable, false, 'a deliberately seeded future day is never rewritten');
    assert.equal(report.summary.dayRowsOutsidePatro, 1);

    const fake = makeFake(state);
    await applyBsCalendarFixes(fake, undefined, OPTS);
    const fixed = state.days.find((d) => d.ad === mislabelled.ad)!;
    assert.equal(fixed.bs, PATRO_DAYS[10].bsDate);
    assert.equal(fixed.fiscal_year, PATRO_DAYS[10].fiscalYear);
    assert.equal(fixed.quarter, PATRO_DAYS[10].quarter);
  });

  test('a stored BS value is fixed from its AD sibling, or reported when it has none', async () => {
    const state = healthyState();
    state.storedBs['documents:d1'].value = '2100-13-01 BS'; // impossible month
    state.storedBs['notes:n1'].value = '2100-13-01 BS'; // no AD sibling to derive from

    const fake = makeFake(state);
    const report = await auditBsCalendar(fake, OPTS);
    const findings = report.findings.filter((f) => f.kind === 'stored_bs_value');
    assert.equal(findings.length, 2);
    const derivable = findings.find((f) => f.targetId === 'd1')!;
    const orphan = findings.find((f) => f.targetId === 'n1')!;
    assert.equal(derivable.fixable, true);
    assert.equal(orphan.fixable, false, 'a value with no AD sibling must never be guessed');

    await applyBsCalendarFixes(fake, undefined, OPTS);
    assert.equal(state.storedBs['documents:d1'].value, `${PATRO_DAYS[0].bsDate} BS`);
    assert.equal(state.storedBs['notes:n1'].value, '2100-13-01 BS', 'the unrepairable value is left as it is');
  });

  test('fiscal years: boundaries realigned, day links re-derived, is_current fixed', async () => {
    const state = healthyState();
    const fy = state.fiscalYears[0];
    fy.start_ad = shiftDays(fy.start_ad, -1); // one day early, as the seeder used to write
    fy.end_ad = shiftDays(fy.end_ad, -1);
    fy.is_current = false;
    state.days[0].fiscal_year_id = 'fy-1';
    state.days[1].fiscal_year_id = null;

    const fake = makeFake(state);
    const report = await auditBsCalendar(fake, OPTS);
    const boundary = report.findings.find((f) => f.kind === 'fiscal_year_boundary')!;
    const link = report.findings.find((f) => f.kind === 'fiscal_year_link')!;
    const current = report.findings.find((f) => f.kind === 'fiscal_year_current')!;
    assert.equal(boundary.fixable, true);
    assert.equal(link.fixable, true);
    assert.equal(current.fixable, true);
    assert.ok(current.expected);

    const applied = await applyBsCalendarFixes(fake, undefined, OPTS);
    assert.ok(applied.applied.length >= 3);
    const patro = buildPatroExpectations(PATRO);
    const wantStart = patro.adByBs.get('2100-04-01')!;
    const wantEnd = shiftDays(patro.adByBs.get('2101-04-01')!, -1);
    assert.equal(state.fiscalYears[0].start_ad, wantStart);
    assert.equal(state.fiscalYears[0].end_ad, wantEnd);
    assert.equal(state.fiscalYears[0].start_date_bs, `${patro.byAd.get(wantStart)!.bsDate} BS`);
    assert.equal(state.fiscalYears[0].end_date_bs, `${patro.byAd.get(wantEnd)!.bsDate} BS`);
    assert.equal(state.fiscalYears[0].is_current, true);
    assert.ok(
      state.days.filter((d) => d.ad >= wantStart && d.ad <= wantEnd).every((d) => d.fiscal_year_id === 'fy-1'),
      'every day row inside the fiscal year is re-linked'
    );
    assert.ok(
      state.days.filter((d) => d.ad < wantStart).every((d) => d.fiscal_year_id === null),
      'days outside every fiscal year keep no link'
    );
  });

  test('a provisional fiscal year whose labels match the patro is promoted by the audit', async () => {
    const state = healthyState();
    state.fiscalYears[0].is_provisional = true;
    const fake = makeFake(state);

    const before = await auditBsCalendar(fake, OPTS);
    const finding = before.findings.find((f) => f.kind === 'fiscal_year_provisional');
    assert.ok(finding, 'a provisional flag over verified labels is reported');
    assert.equal(finding!.fixable, true);
    const labelsBefore = `${state.fiscalYears[0].start_date_bs}..${state.fiscalYears[0].end_date_bs}`;

    await applyBsCalendarFixes(fake, [finding!.id], OPTS);
    assert.equal(state.fiscalYears[0].is_provisional, false, 'the stale flag is cleared');
    assert.equal(
      `${state.fiscalYears[0].start_date_bs}..${state.fiscalYears[0].end_date_bs}`,
      labelsBefore,
      'clearing the flag never moves a date'
    );
    const after = await auditBsCalendar(fake, OPTS);
    assert.equal(after.findings.filter((f) => f.kind === 'fiscal_year_provisional').length, 0);
  });

  test('a fiscal year ending past the patro data is reported, never guessed', async () => {
    const state = healthyState();
    state.fiscalYears[0].code = '2101-02';
    state.fiscalYears[0].start_date_bs = '2101-04-01 BS';
    state.fiscalYears[0].start_ad = '2044-04-14';
    state.fiscalYears[0].end_ad = '2045-04-13';
    state.fiscalYears[0].end_date_bs = '2102-12-31 BS';

    const report = await auditBsCalendar(makeFake(state), OPTS);
    const finding = report.findings.find((f) => f.kind === 'fiscal_year_boundary')!;
    assert.equal(finding.fixable, false);
    assert.ok(finding.detail.includes('does not cover'));
  });

  test('applying with explicit ids never writes a finding the caller did not name', async () => {
    const state = healthyState();
    state.years[0].daysInMonths = [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
    state.storedBs['documents:d1'].value = '2100-13-01 BS';
    const fake = makeFake(state);
    const before = await auditBsCalendar(fake, OPTS);
    const yearFinding = before.findings.find((f) => f.kind === 'year_config_mismatch')!;

    const result = await applyBsCalendarFixes(fake, [yearFinding.id], OPTS);
    assert.deepEqual(
      result.applied.map((a) => a.id),
      [yearFinding.id]
    );
    assert.equal(state.storedBs['documents:d1'].value, '2100-13-01 BS', 'the unnamed finding is untouched');
    const after = await auditBsCalendar(fake, OPTS);
    assert.ok(after.findings.some((f) => f.id === result.skipped.find((s) => s.id)?.id || f.kind === 'stored_bs_value'));
  });
});

describe('BS calendar integrity — client/server contract', () => {
  test('the client finding-kind union covers every kind the server emits', () => {
    const serverSource = fs.readFileSync(
      path.resolve('server/src/services/bsCalendarIntegrity.service.ts'),
      'utf8'
    );
    const emitted = new Set(
      [...serverSource.matchAll(/kind: '([a-z_]+)'/g)].map((match) => match[1])
    );
    assert.ok(emitted.size >= 8, `expected the engine to emit several kinds, found ${emitted.size}`);

    const clientTypes = fs.readFileSync(path.resolve('client/src/types/index.ts'), 'utf8');
    const union = /export type BsIntegrityKind =([\s\S]*?);/.exec(clientTypes)?.[1] ?? '';
    const declared = new Set([...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));

    const missing = [...emitted].filter((kind) => !declared.has(kind));
    assert.deepEqual(missing, [], `the Calendar Health panel cannot render these kinds: ${missing.join(', ')}`);
    const stale = [...declared].filter((kind) => !emitted.has(kind));
    assert.deepEqual(stale, [], `the client declares kinds the engine never emits: ${stale.join(', ')}`);
  });

  test('the panel never invents a value: only fixable findings are selectable', () => {
    const panel = fs.readFileSync(
      path.resolve('client/src/features/finance/BsCalendarHealthPanel.tsx'),
      'utf8'
    );
    assert.ok(panel.includes('finding.fixable && canManage'), 'Fix must be gated on the finding being derivable');
    assert.ok(panel.includes('applyBsCalendarIntegrity'), 'the panel must apply through the audited endpoint');
    // The panel shows the server's own expectation, never a locally computed one.
    assert.ok(panel.includes('finding.expected'));
  });
});
