/**
 * WTY-2 warranty query builders — pure, no database.
 *
 * The registers are three statements (page, filtered count, all-status KPI
 * summary) that must agree on their WHERE clause. If they drift, the footer and
 * the cards describe different populations and the screen lies about how much
 * warranty is expiring. These tests pin the shared builder, the status clause,
 * the branch-scope forms, the "ALL"/empty-scope sentinels and the page clamps.
 *
 * PROVES:
 *   1. Every filter combination lands in the WHERE clause with bound params
 *      (never interpolated text) and the summary ignores only the status filter.
 *   2. A branch scope is `= ANY($n)` (multi) or `FALSE` (empty) — never "no
 *      branch predicate", which would return the country.
 *   3. Page/pageSize are clamped and page 1 has no OFFSET.
 *   4. The write builders keep the one-current-row invariant in their text.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWarrantyCountQuery,
  buildWarrantyPageQuery,
  buildWarrantySummaryQuery,
  validCoverageDates,
  WARRANTY_INSERT_SQL,
  WARRANTY_SUPERSEDE_BY_DEVICE_SQL,
  WARRANTY_SUPERSEDE_BY_ID_SQL,
  WARRANTY_SUPERSEDE_BY_SOURCE_SQL,
  WARRANTY_SUPERSEDE_CURRENT_SQL,
  warrantyInsertParams,
  type WarrantyQueryOptions,
} from '../server/src/models/warranty.repo';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
/** The WHERE clause only — the SELECT list carries CURRENT_DATE in its state column. */
const whereOf = (sql: string) => normalize(sql).split(/ WHERE /)[1] || '';

describe('warranty query builders', () => {
  test('base page query reads only current VENDOR rows, soonest expiry first', () => {
    const { sql, params } = buildWarrantyPageQuery({ coverageType: 'VENDOR' }, 1, 15);
    const flat = normalize(sql);
    assert.deepEqual(params, ['VENDOR']);
    assert.match(flat, /w\.is_current = TRUE/);
    assert.match(flat, /w\.coverage_type = \$1/);
    assert.match(flat, /ORDER BY w\.end_date_ad ASC, w\.id ASC/);
    assert.match(flat, /LIMIT 15 OFFSET 0/);
    assert.doesNotMatch(whereOf(sql), /w\.branch_id/);
  });

  test('branch scope binds an array; an empty scope is FALSE, not "all branches"', () => {
    const multi = buildWarrantyPageQuery(
      { coverageType: 'SELLER', branchScope: ['BRH01', 'WH001'] },
      1,
      10
    );
    assert.deepEqual(multi.params, ['SELLER', ['BRH01', 'WH001']]);
    assert.match(normalize(multi.sql), /w\.branch_id = ANY\(\$2\)/);

    const empty = buildWarrantyPageQuery({ coverageType: 'SELLER', branchScope: [] }, 1, 10);
    assert.deepEqual(empty.params, ['SELLER']);
    assert.match(normalize(empty.sql), /AND FALSE/);
  });

  test('an explicit branchId is bound; the ALL sentinel is not a branches predicate', () => {
    const one = buildWarrantyPageQuery({ coverageType: 'VENDOR', branchId: 'BRH01' }, 1, 10);
    assert.deepEqual(one.params, ['VENDOR', 'BRH01']);
    assert.match(normalize(one.sql), /w\.branch_id = \$2/);

    const all = buildWarrantyPageQuery({ coverageType: 'VENDOR', branchId: 'ALL' }, 1, 10);
    assert.deepEqual(all.params, ['VENDOR']);
    assert.doesNotMatch(whereOf(all.sql), /w\.branch_id/);
  });

  test('search is lowercased and bound across product, serial, party, document and branch', () => {
    const { sql, params } = buildWarrantyPageQuery(
      { coverageType: 'VENDOR', query: '  Router-9 ' },
      1,
      10
    );
    assert.deepEqual(params, ['VENDOR', '%router-9%']);
    const flat = normalize(sql);
    for (const column of ['w.product_name', 'w.serial_number', 'w.party_name', 'w.source_number', 'b.name']) {
      assert.ok(flat.includes(column), `search must cover ${column}`);
    }
    assert.match(flat, /LIKE \$2/);
  });

  test('category and date bounds are normalised; junk is ignored rather than widening', () => {
    const { sql, params } = buildWarrantyPageQuery(
      {
        coverageType: 'VENDOR',
        category: 'cpe',
        startFrom: '2026-01-01',
        startTo: '2026-12-31',
      },
      1,
      10
    );
    assert.deepEqual(params, ['VENDOR', 'CPE', '2026-01-01', '2026-12-31']);
    const flat = normalize(sql);
    assert.match(flat, /w\.item_category = \$2/);
    assert.match(flat, /w\.start_date_ad >= \$3/);
    assert.match(flat, /w\.start_date_ad <= \$4/);

    const junk = buildWarrantyPageQuery(
      { coverageType: 'VENDOR', category: 'ALL', startFrom: '01/01/2026', startTo: 'yesterday' },
      1,
      10
    );
    assert.deepEqual(junk.params, ['VENDOR']);
    assert.doesNotMatch(whereOf(junk.sql), /item_category|start_date_ad >=/);
  });

  test('status is a predicate on the computed state and an unknown status is ignored', () => {
    const valid = buildWarrantyPageQuery({ coverageType: 'VENDOR', status: 'valid' }, 1, 10);
    assert.match(normalize(valid.sql), /end_date_ad > CURRENT_DATE \+ 30/);
    const expiring = buildWarrantyPageQuery({ coverageType: 'VENDOR', status: 'EXPIRING_SOON' }, 1, 10);
    assert.match(normalize(expiring.sql), />= CURRENT_DATE AND w\.end_date_ad <= CURRENT_DATE \+ 30/);
    const expired = buildWarrantyPageQuery({ coverageType: 'VENDOR', status: 'EXPIRED' }, 1, 10);
    assert.match(normalize(expired.sql), /end_date_ad < CURRENT_DATE/);
    const junk = buildWarrantyPageQuery({ coverageType: 'VENDOR', status: 'SOONISH' }, 1, 10);
    assert.deepEqual(junk.params, ['VENDOR']);
    assert.doesNotMatch(whereOf(junk.sql), /end_date_ad (?:[<>]=?|) ?CURRENT_DATE|CURRENT_DATE \+ 30/);
  });

  test('page and pageSize are clamped and page 1 has no offset', () => {
    const first = buildWarrantyPageQuery({ coverageType: 'VENDOR' }, 1, 20);
    assert.match(normalize(first.sql), /LIMIT 20 OFFSET 0/);
    const second = buildWarrantyPageQuery({ coverageType: 'VENDOR' }, 3, 20);
    assert.match(normalize(second.sql), /LIMIT 20 OFFSET 40/);
    const huge = buildWarrantyPageQuery({ coverageType: 'VENDOR' }, 1, 99_999);
    assert.match(normalize(huge.sql), /LIMIT 500/);
    const zero = buildWarrantyPageQuery({ coverageType: 'VENDOR' }, 0, 0);
    assert.match(normalize(zero.sql), /LIMIT 25 OFFSET 0/);
  });

  test('count and summary share the WHERE clause; only the page adds status/order/limit', () => {
    const opts: WarrantyQueryOptions = { coverageType: 'VENDOR', branchScope: ['BRH01'], query: 'wrt', status: 'EXPIRED' };
    const page = buildWarrantyPageQuery(opts, 1, 10);
    const count = buildWarrantyCountQuery(opts);
    const summary = buildWarrantySummaryQuery(opts);

    for (const sql of [count.sql, summary.sql]) {
      const flat = normalize(sql);
      assert.match(flat, /w\.coverage_type = \$1/);
      assert.match(flat, /w\.branch_id = ANY\(\$2\)/);
      assert.match(flat, /LIKE \$3/);
      assert.doesNotMatch(flat, /ORDER BY|LIMIT/);
    }
    // The status filter narrows the page and the footer count...
    assert.match(whereOf(page.sql), /end_date_ad < CURRENT_DATE/);
    assert.match(whereOf(count.sql), /end_date_ad < CURRENT_DATE/);
    // ...but not the KPI summary, whose WHERE clause stays status-free.
    assert.doesNotMatch(whereOf(summary.sql), /end_date_ad (?:[<>]=?|) ?CURRENT_DATE|CURRENT_DATE \+ 30/);
    assert.match(normalize(summary.sql), /COUNT\(\*\) FILTER \(WHERE .* AS valid/);
    assert.deepEqual(summary.params, count.params);
  });

  test('the write builders keep one current row per unit and statement guards', () => {
    assert.match(normalize(WARRANTY_SUPERSEDE_CURRENT_SQL), /WHERE coverage_type = \$1 AND serial_number = \$2 AND is_current = TRUE/);
    assert.match(normalize(WARRANTY_SUPERSEDE_BY_ID_SQL), /WHERE id = \$1 AND is_current = TRUE/);
    assert.match(normalize(WARRANTY_SUPERSEDE_BY_SOURCE_SQL), /coverage_type = \$1 AND source_type = \$2 AND source_id = \$3 AND is_current = TRUE/);
    assert.match(normalize(WARRANTY_SUPERSEDE_BY_DEVICE_SQL), /coverage_type = 'SELLER' AND device_record_id = \$1 AND is_current = TRUE/);
    assert.match(normalize(WARRANTY_INSERT_SQL), /is_current, is_demo/);
    assert.match(normalize(WARRANTY_INSERT_SQL), /TRUE, \$20/);
    // A correction retires the row it replaced: the by-id update is the only
    // place the replaced period can stop being current.
    assert.doesNotMatch(normalize(WARRANTY_SUPERSEDE_BY_ID_SQL), /start_date_ad|end_date_ad/);
  });

  test('insert params keep the column order and coerce absent optional fields', () => {
    const params = warrantyInsertParams({
      id: 'wrt-cov-1',
      coverageType: 'SELLER',
      itemCategory: 'CPE',
      productName: 'Router',
      serialNumber: 'wrt-1',
      sourceType: 'SALE',
      startDateAD: '2026-01-01',
      endDateAD: '2027-01-01',
      startBasis: 'SALE_DATE',
    });
    assert.equal(params.length, 22);
    assert.equal(params[0], 'wrt-cov-1');
    assert.equal(params[1], 'SELLER');
    assert.equal(params[2], 'CPE');
    assert.equal(params[4], 'Router');
    assert.equal(params[14], '2026-01-01');
    assert.equal(params[15], '2027-01-01');
    assert.equal(params[16], null);
    assert.equal(params[17], 'SALE_DATE');
    assert.equal(params[19], false);
    assert.equal(params[20], null);
    assert.equal(params[21], null);
  });

  test('validCoverageDates accepts only ordered real YYYY-MM-DD values', () => {
    assert.equal(validCoverageDates('2026-01-01', '2027-01-01'), true);
    assert.equal(validCoverageDates('2026-01-01', '2026-01-01'), true);
    assert.equal(validCoverageDates('2027-01-01', '2026-01-01'), false);
    assert.equal(validCoverageDates('01/01/2026', '2027-01-01'), false);
    assert.equal(validCoverageDates('', '2027-01-01'), false);
    assert.equal(validCoverageDates(undefined, '2027-01-01'), false);
  });
});
