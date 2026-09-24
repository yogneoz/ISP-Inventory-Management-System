/**
 * Unit tests for the admin repo query builders (node:test).
 * Verifies SQL text and param ordering without a live database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_DATA_TABLES,
  demoDataDeleteSql,
  COMPANY_PROFILE_SELECT_SQL,
  COMPANY_PROFILE_UPSERT_SQL,
  companyProfileUpsertParams,
  COMPANY_PROFILE_UPSERT_NO_STAMP_SQL,
  companyProfileUpsertNoStampParams,
  BRANCH_SELECT_SQL,
  BRANCH_UPSERT_SQL,
  branchUpsertParams,
  BRANCH_UPDATE_SQL,
  branchUpdateParams,
  BRANCH_DELETE_SQL,
  USER_SELECT_SQL,
  USER_UPSERT_SQL,
  userUpsertParams,
  USER_UPDATE_SQL,
  userUpdateParams,
  USER_RESET_PASSWORD_SQL,
  ASSET_RECALC_SELECT_SQL,
  ASSET_RECALC_UPDATE_SQL,
  LIVE_STOCK_RECALC_SQL,
  BS_CALENDAR_YEARS_SELECT_SQL,
  BS_CALENDAR_YEAR_UPSERT_SQL,
  BS_CALENDAR_YEAR_SET_START_SQL,
  BS_DAY_RECORDS_DELETE_BY_YEARS_SQL,
  BS_DAY_RECORD_UPSERT_SQL,
  BS_DAY_RECORD_UPSERT_WITH_FY_SQL,
  bsDayRecordParams,
  buildBsDayRecordsQuery,
  COLUMN_EXISTS_SQL,
  FISCAL_YEAR_LINK_TARGETS,
  buildFiscalYearLinkRepairSql,
  DOC_NUMBER_CONFIGS_SELECT_SQL,
  DOC_NUMBER_CONFIG_BY_ID_SQL,
  DOC_NUMBER_CONFIG_UPDATE_SQL,
  DOC_NUMBER_CONFIG_UPSERT_SQL,
  docNumberConfigUpsertParams,
  DOC_NUMBER_CONFIG_INCREMENT_SQL,
  DOC_NUMBER_CONFIG_CLAIM_SQL,
  FY_LIST_SQL,
  FY_OVERLAP_CHECK_SQL,
  FY_INSERT_SQL,
  fiscalYearInsertParams,
  FY_SET_CURRENT_CLEAR_SQL,
  FY_SET_CURRENT_SQL,
  FY_UPDATE_SQL,
  FY_CLOSE_SQL,
  FY_END_DATE_SQL,
  FY_REOPEN_SQL,
  FY_FIND_FOR_INIT_SQL,
  FY_NEXT_AFTER_SQL,
  FY_FIND_FOR_DELETE_SQL,
  FY_DELETE_SQL,
  FY_OPENING_STOCK_COUNTS_SQL,
  FY_OPENING_STOCK_INIT_SQL,
  fiscalYearOpeningStockInitParams,
  FY_REFERENCE_TABLES,
  fiscalYearReferenceCountSql,
} from '../server/src/models/admin.repo';
import type { CompanyProfile, FiscalYear } from '../client/src/types';

/** Max placeholder index used by a SQL string, e.g. $7 → 7. */
function maxPlaceholder(sql: string): number {
  const matches = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return matches.length ? Math.max(...matches) : 0;
}

describe('demo data cleanup', () => {
  test('clears every operational table by the is_demo flag only', () => {
    assert.equal(DEMO_DATA_TABLES.length, 17);
    assert.ok(DEMO_DATA_TABLES.includes('serial_log'));
    // Users, branches and company profile are never demo-cleared.
    assert.ok(!(DEMO_DATA_TABLES as readonly string[]).includes('users'));
    assert.ok(!(DEMO_DATA_TABLES as readonly string[]).includes('branches'));
    assert.ok(!(DEMO_DATA_TABLES as readonly string[]).includes('company_profile'));
  });

  test('demoDataDeleteSql scopes the delete to is_demo rows', () => {
    assert.equal(demoDataDeleteSql('products'), 'DELETE FROM products WHERE is_demo = TRUE');
  });
});

describe('company profile params', () => {
  const profile: CompanyProfile = {
    id: 'COMP-001',
    name: 'Himalayan Fiber',
    address: 'Kathmandu',
  };

  test('fills 22 columns with documented defaults', () => {
    assert.deepEqual(companyProfileUpsertParams(profile), [
      'COMP-001', 'Himalayan Fiber', '', '', 'Kathmandu', '', '', '', '', '', '',
      '', '', '', 'telecom', 'NPR', 'NPR', 'en-IN', 'before', 2, 13, '',
    ]);
  });

  test('keeps provided values through the upsert', () => {
    const params = companyProfileUpsertParams({
      ...profile,
      legalName: 'Himalayan Fiber Pvt. Ltd.',
      currencyCode: 'USD',
      currencyDecimals: 0,
      defaultTaxRate: 0,
    });
    assert.equal(params[2], 'Himalayan Fiber Pvt. Ltd.');
    assert.equal(params[16], 'USD');
    assert.equal(params[19], 0);
    assert.equal(params[20], 0);
  });

  test('id defaults to COMP-001 when missing', () => {
    assert.equal(companyProfileUpsertParams({ name: 'x', address: 'y' } as CompanyProfile)[0], 'COMP-001');
  });

  test('no-stamp variant uses the Nepal default and 13% tax fallback', () => {
    const params = companyProfileUpsertNoStampParams({ name: 'x', address: 'y' } as CompanyProfile);
    assert.equal(params.length, 22);
    assert.equal(params[6], 'Nepal');
    assert.equal(params[20], 13);
    // Verbatim quirk from the original handler: this variant used `||`, so a
    // legitimate 0% tax rate falls back to 13 (unlike the stamp variant's `??`).
    assert.equal(companyProfileUpsertNoStampParams({ ...profile, defaultTaxRate: 0 } as CompanyProfile)[20], 13);
  });

  test('both upsert variants write 22 binds and update every column on conflict', () => {
    assert.equal(maxPlaceholder(COMPANY_PROFILE_UPSERT_SQL), 22);
    assert.equal(maxPlaceholder(COMPANY_PROFILE_UPSERT_NO_STAMP_SQL), 22);
    assert.match(COMPANY_PROFILE_UPSERT_SQL, /updated_at = CURRENT_TIMESTAMP;$/);
    assert.doesNotMatch(COMPANY_PROFILE_UPSERT_NO_STAMP_SQL, /updated_at = CURRENT_TIMESTAMP;$/);
  });

  test('select pins the singleton row with LIMIT 1', () => {
    assert.match(COMPANY_PROFILE_SELECT_SQL, / FROM company_profile LIMIT 1$/);
    assert.ok(COMPANY_PROFILE_SELECT_SQL.includes('"panVatNumber"'));
  });
});

describe('branch params', () => {
  const branch = {
    id: 'br-1', code: 'BR-01', name: 'Pokhara', location: 'Pokhara', phone: '061-1',
    isHeadquarters: false, active: true, allowProcurement: false, allowWarehouseTransfer: true,
  };

  test('branchUpsertParams passes all nine columns through', () => {
    assert.deepEqual(branchUpsertParams(branch), [
      'br-1', 'BR-01', 'Pokhara', 'Pokhara', '061-1', false, true, false, true,
    ]);
  });

  test('branchUpdateParams coerces flags with the documented defaults', () => {
    assert.deepEqual(
      branchUpdateParams({ id: 'br-2', code: 'C', name: 'N', location: 'L' }),
      ['C', 'N', 'L', '', false, true, true, true, 'br-2']
    );
  });

  test('upsert SQL syncs every column on conflict', () => {
    assert.equal(maxPlaceholder(BRANCH_UPSERT_SQL), 9);
    for (const col of ['code', 'name', 'location', 'phone', 'is_headquarters', 'active', 'allow_procurement', 'allow_warehouse_transfer']) {
      assert.ok(BRANCH_UPSERT_SQL.includes(`${col} = EXCLUDED.${col}`), `missing conflict update for ${col}`);
    }
  });

  test('update SQL takes 9 binds with id last; delete is id-scoped', () => {
    assert.equal(maxPlaceholder(BRANCH_UPDATE_SQL), 9);
    assert.match(BRANCH_UPDATE_SQL, /WHERE id = \$9;$/);
    assert.equal(BRANCH_DELETE_SQL, 'DELETE FROM branches WHERE id = $1');
    assert.match(BRANCH_SELECT_SQL, / FROM branches ORDER BY name ASC$/);
  });
});

describe('user params', () => {
  const user = {
    id: 'usr-1', email: 'a@b.c', name: 'Alice', role: 'BRANCH_MANAGER' as const,
    password: 'hashed', branchId: 'WH001', allowedBranchIds: ['WH001'] as string[],
    canSwitchUser: true,
  };

  test('fills 8 columns; empty branch becomes null; flag coerced to boolean', () => {
    assert.deepEqual(userUpsertParams(user), [
      'usr-1', 'a@b.c', 'hashed', 'Alice', 'BRANCH_MANAGER', 'WH001', ['WH001'], true,
    ]);
    assert.deepEqual(userUpsertParams({ ...user, branchId: undefined, canSwitchUser: undefined }), [
      'usr-1', 'a@b.c', 'hashed', 'Alice', 'BRANCH_MANAGER', null, ['WH001'], false,
    ]);
  });

  test('upsert conflicts on email; update takes 8 binds with id last', () => {
    assert.match(USER_UPSERT_SQL, /ON CONFLICT \(email\) DO UPDATE SET/);
    assert.equal(maxPlaceholder(USER_UPSERT_SQL), 8);
    assert.equal(maxPlaceholder(USER_UPDATE_SQL), 8);
    assert.match(USER_UPDATE_SQL, /password = COALESCE\(\$7, password\)/);
    assert.match(USER_UPDATE_SQL, /WHERE id = \$8$/);
  });

  test('userUpdateParams binds null when no new password is given', () => {
    assert.deepEqual(
      userUpdateParams({ ...user, password: undefined }, null),
      ['a@b.c', 'Alice', 'BRANCH_MANAGER', 'WH001', ['WH001'], true, null, 'usr-1']
    );
  });

  test('list SQL never exposes password; reset stamps updated_at', () => {
    assert.ok(!USER_SELECT_SQL.includes('password'));
    assert.match(USER_SELECT_SQL, / FROM users ORDER BY created_at ASC$/);
    assert.equal(
      USER_RESET_PASSWORD_SQL,
      'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING email, name'
    );
  });
});

describe('admin recalculation SQL', () => {
  test('asset recalc selects the depreciation inputs and writes only the two value columns', () => {
    assert.match(ASSET_RECALC_SELECT_SQL, / FROM fixed_assets$/);
    for (const alias of ['"tagNumber"', '"acquisitionCost"', '"depreciationMethod"', '"depreciationRatePercent"']) {
      assert.ok(ASSET_RECALC_SELECT_SQL.includes(alias), `missing ${alias}`);
    }
    assert.equal(maxPlaceholder(ASSET_RECALC_UPDATE_SQL), 3);
    assert.match(ASSET_RECALC_UPDATE_SQL, /SET accumulated_depreciation = \$1, net_book_value = \$2/);
  });

  test('live-stock recalc derives balances from the latest non-damage transaction', () => {
    assert.match(LIVE_STOCK_RECALC_SQL, /SELECT DISTINCT ON \(product_id, branch_id\)/);
    assert.match(LIVE_STOCK_RECALC_SQL, /WHERE change_type <> 'DAMAGE'/);
    assert.match(LIVE_STOCK_RECALC_SQL, /GREATEST\(quantity_after, 0\)/);
    assert.match(LIVE_STOCK_RECALC_SQL, /RETURNING s\.id$/);
  });
});

describe('BS calendar SQL', () => {
  const rec = {
    adDate: '2026-04-14',
    bsDate: '2083-01-01',
    bsYear: 2083,
    bsMonth: 1,
    bsMonthName: 'Baishakh',
    bsMonthNameNp: 'बैशाख',
    bsDay: 1,
    dayOfWeekName: 'Tuesday',
    dayOfWeekNameNp: 'मंगलबार',
    fiscalYear: '2083-84',
    quarter: 'Q1',
    isWeekend: false,
  };

  test('bsDayRecordParams emits the 12 shared binds in column order', () => {
    assert.deepEqual(bsDayRecordParams(rec), [
      '2026-04-14', '2083-01-01', 2083, 1, 'Baishakh', 'बैशाख', 1, 'Tuesday', 'मंगलबार', '2083-84', 'Q1', false,
    ]);
  });

  test('plain upsert takes 12 binds; fiscal-year variant resolves fy in SQL', () => {
    assert.equal(maxPlaceholder(BS_DAY_RECORD_UPSERT_SQL), 12);
    assert.equal(maxPlaceholder(BS_DAY_RECORD_UPSERT_WITH_FY_SQL), 12);
    assert.ok(BS_DAY_RECORD_UPSERT_WITH_FY_SQL.includes('SELECT fy.id FROM fiscal_years fy'));
    assert.ok(BS_DAY_RECORD_UPSERT_WITH_FY_SQL.includes('fiscal_year_id = EXCLUDED.fiscal_year_id'));
    assert.ok(!BS_DAY_RECORD_UPSERT_SQL.includes('fiscal_year_id'));
  });

  test('calendar config helpers keep the year key and start date', () => {
    assert.equal(maxPlaceholder(BS_CALENDAR_YEAR_UPSERT_SQL), 3);
    assert.match(BS_CALENDAR_YEAR_UPSERT_SQL, /ON CONFLICT \(year_bs\)/);
    assert.equal(BS_CALENDAR_YEAR_SET_START_SQL, 'UPDATE bs_calendar_years SET start_ad = $2 WHERE year_bs = $1;');
    assert.equal(BS_DAY_RECORDS_DELETE_BY_YEARS_SQL, 'DELETE FROM bs_day_records WHERE bs_year = ANY($1::int[]);');
    assert.match(BS_CALENDAR_YEARS_SELECT_SQL, / ORDER BY year_bs ASC$/);
  });

  test('buildBsDayRecordsQuery filters by year, month and search in that order', () => {
    const { sql, params } = buildBsDayRecordsQuery('2083', 5, 'baish');
    assert.match(sql, / AND bs_year = \$1 AND bs_month = \$2 AND \(\s*LOWER\(ad_date::text\) LIKE \$3/);
    assert.match(sql, / ORDER BY ad_date ASC LIMIT 500;$/);
    assert.deepEqual(params, [2083, 5, '%baish%']);
  });

  test('ALL year/month filters are ignored (search mirrors the original verbatim, so ALL is searched)', () => {
    const { sql, params } = buildBsDayRecordsQuery('ALL', 'ALL', 'ALL');
    assert.ok(!sql.includes(' AND bs_year'));
    assert.ok(!sql.includes(' AND bs_month'));
    assert.match(sql, /LOWER\(ad_date::text\) LIKE \$1/);
    assert.deepEqual(params, ['%all%']);
  });

  test('non-string search values are ignored', () => {
    const { sql, params } = buildBsDayRecordsQuery(undefined, undefined, 42 as unknown as string);
    assert.ok(!sql.includes('LIKE'));
    assert.deepEqual(params, []);
  });
});

describe('fiscal-year link repair', () => {
  test('covers the 12 documented tables with their date columns', () => {
    assert.equal(FISCAL_YEAR_LINK_TARGETS.length, 12);
    assert.ok(FISCAL_YEAR_LINK_TARGETS.every((t) => t.column === 'fiscal_year_id'));
    const bsDay = FISCAL_YEAR_LINK_TARGETS.find((t) => t.table === 'bs_day_records');
    assert.equal(bsDay?.keyColumn, 'ad_date');
    const audit = FISCAL_YEAR_LINK_TARGETS.find((t) => t.table === 'audit_logs');
    assert.equal(audit?.dateType, 'timestamptz');
  });

  test('timestamptz date columns are cast to date; plain dates are used raw', () => {
    const tsSql = buildFiscalYearLinkRepairSql(FISCAL_YEAR_LINK_TARGETS.find((t) => t.table === 'audit_logs')!);
    assert.ok(tsSql.includes('(timestamp_ad)::date'));
    const plainSql = buildFiscalYearLinkRepairSql(FISCAL_YEAR_LINK_TARGETS.find((t) => t.table === 'fixed_assets')!);
    assert.ok(plainSql.includes('acquisition_date_ad'));
    assert.ok(!plainSql.includes('::date)'));
  });

  test('generated SQL re-links rows whose fiscal year does not contain their date', () => {
    const sql = buildFiscalYearLinkRepairSql(FISCAL_YEAR_LINK_TARGETS[0]);
    assert.match(sql, /UPDATE "fixed_assets" t/);
    assert.match(sql, /WHERE t2\.fiscal_year_id IS NULL/);
    assert.match(sql, /AND t\.fiscal_year_id IS DISTINCT FROM m\.fy_id/);
  });

  test('column existence probe is schema-scoped', () => {
    assert.match(COLUMN_EXISTS_SQL, /WHERE table_schema = 'public' AND table_name = \$1 AND column_name = \$2/);
  });
});

describe('document numbering SQL', () => {
  const cfg = {
    id: 'PO', documentType: 'PURCHASE_ORDER', prefix: 'PO-', suffix: '',
    minDigits: 4, startingNumber: 1, nextNumber: 7, resetEveryFiscalYear: true, notes: '',
  };

  test('upsert params default counters to 1/4 and keep the reset flag', () => {
    assert.deepEqual(docNumberConfigUpsertParams(cfg), [
      'PO', 'PURCHASE_ORDER', 'PO-', '', 4, 1, 7, true, '',
    ]);
    assert.deepEqual(docNumberConfigUpsertParams({ ...cfg, prefix: undefined as any, minDigits: undefined as any, nextNumber: undefined as any, resetEveryFiscalYear: undefined as any }), [
      'PO', 'PURCHASE_ORDER', '', '', 4, 1, 1, true, '',
    ]);
  });

  test('select / by-id / update / increment SQL shapes', () => {
    assert.match(DOC_NUMBER_CONFIGS_SELECT_SQL, / FROM document_number_configs ORDER BY id ASC;$/);
    assert.match(DOC_NUMBER_CONFIG_BY_ID_SQL, / WHERE id = \$1;$/);
    assert.equal(maxPlaceholder(DOC_NUMBER_CONFIG_UPDATE_SQL), 8);
    assert.match(DOC_NUMBER_CONFIG_UPDATE_SQL, /WHERE id = \$8;$/);
    assert.equal(
      DOC_NUMBER_CONFIG_INCREMENT_SQL,
      'UPDATE document_number_configs SET next_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;'
    );
    assert.equal(maxPlaceholder(DOC_NUMBER_CONFIG_UPSERT_SQL), 9);
  });

  test('DOC_NUMBER_CONFIG_CLAIM_SQL is an atomic self-incrementing claim returning before/after + format fields', () => {
    // The self-referential increment is the whole point: no computed value
    // is written, so concurrent claims serialize on the row.
    assert.match(DOC_NUMBER_CONFIG_CLAIM_SQL, /next_number = document_number_configs\.next_number \+ 1/);
    assert.match(DOC_NUMBER_CONFIG_CLAIM_SQL, /WHERE id = \$1/);
    assert.match(DOC_NUMBER_CONFIG_CLAIM_SQL, /RETURNING next_number - 1 AS next_number_before/);
    assert.match(DOC_NUMBER_CONFIG_CLAIM_SQL, /next_number AS next_number_after/);
    assert.match(DOC_NUMBER_CONFIG_CLAIM_SQL, /prefix, suffix, min_digits/);
    // Single bind: the doc type id.
    assert.equal(maxPlaceholder(DOC_NUMBER_CONFIG_CLAIM_SQL), 1);
  });
});

describe('fiscal years SQL', () => {
  test('list SQL orders by start_date_ad DESC and exposes isDemo', () => {
    assert.match(FY_LIST_SQL, / FROM fiscal_years ORDER BY start_date_ad DESC;$/);
    assert.ok(FY_LIST_SQL.includes('"isDemo"'));
  });

  test('insert is a non-demo, non-current year and echoes the row back', () => {
    assert.match(FY_INSERT_SQL, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, FALSE, FALSE, FALSE\)/);
    assert.match(FY_INSERT_SQL, /RETURNING/);
    assert.deepEqual(
      fiscalYearInsertParams({ id: 'fy-1', code: '2083-84', startDateAD: '2026-04-14', endDateAD: '2027-04-13', startDateBS: '2083-01-01', endDateBS: '2084-12-30' }),
      ['fy-1', '2083-84', '2026-04-14', '2027-04-13', '2083-01-01', '2084-12-30']
    );
  });

  test('overlap check rejects dates spanning an existing period', () => {
    assert.match(FY_OVERLAP_CHECK_SQL, /WHERE \(\$1::date BETWEEN start_date_ad AND end_date_ad\)/);
    assert.match(FY_OVERLAP_CHECK_SQL, /LIMIT 1;/);
  });

  test('set-current clears the old flag then sets the new one in two statements', () => {
    assert.equal(FY_SET_CURRENT_CLEAR_SQL, 'UPDATE fiscal_years SET is_current = FALSE;');
    assert.equal(FY_SET_CURRENT_SQL, 'UPDATE fiscal_years SET is_current = TRUE WHERE id = $1 RETURNING id;');
  });

  test('update / close / reopen take 6, 1 and 1 binds', () => {
    assert.equal(maxPlaceholder(FY_UPDATE_SQL), 6);
    assert.match(FY_UPDATE_SQL, /WHERE id = \$6/);
    assert.match(FY_CLOSE_SQL, /WHERE id = \$1 AND end_date_ad < CURRENT_DATE/);
    assert.match(FY_REOPEN_SQL, /SET is_closed = FALSE WHERE id = \$1/);
    assert.equal(FY_END_DATE_SQL, 'SELECT end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE id = $1;');
  });

  test('initialization lookups lock rows with FOR UPDATE', () => {
    assert.match(FY_FIND_FOR_INIT_SQL, /WHERE id = \$1 FOR UPDATE;/);
    assert.match(FY_NEXT_AFTER_SQL, /WHERE start_date_ad > \$1 ORDER BY start_date_ad ASC LIMIT 1 FOR UPDATE;/);
    assert.match(FY_FIND_FOR_DELETE_SQL, /WHERE id = \$1 FOR UPDATE;/);
    assert.match(FY_FIND_FOR_INIT_SQL, /is_closed/);
  });

  test('delete is id-scoped', () => {
    assert.equal(FY_DELETE_SQL, 'DELETE FROM fiscal_years WHERE id = $1;');
  });
});

describe('fiscal-year opening stock initialization', () => {
  test('count probe separates manual adjustments from closing rows', () => {
    assert.match(FY_OPENING_STOCK_COUNTS_SQL, /COUNT\(\*\) FILTER \(WHERE source_type = 'MANUAL_ADJUSTMENT'\)::int AS manual/);
    assert.equal(maxPlaceholder(FY_OPENING_STOCK_COUNTS_SQL), 1);
  });

  test('init SQL cross-joins active branches with products and preserves manual rows', () => {
    assert.match(FY_OPENING_STOCK_INIT_SQL, /'open-' \|\| \$1 \|\| '-' \|\| products\.id \|\| '-' \|\| branches\.id/);
    assert.match(FY_OPENING_STOCK_INIT_SQL, /FROM products\s+CROSS JOIN branches/);
    assert.match(FY_OPENING_STOCK_INIT_SQL, /WHERE branches\.active = TRUE/);
    assert.match(FY_OPENING_STOCK_INIT_SQL, /WHERE fiscal_year_opening_stock\.source_type <> 'MANUAL_ADJUSTMENT'/);
    assert.match(FY_OPENING_STOCK_INIT_SQL, /ON CONFLICT \(fiscal_year_id, product_id, branch_id\)/);
  });

  test('init params bind target FY, source code and poster with system fallback', () => {
    assert.deepEqual(fiscalYearOpeningStockInitParams('fy-next', '2083-84', ''), ['fy-next', '2083-84', 'system']);
    assert.deepEqual(fiscalYearOpeningStockInitParams('fy-next', '2083-84', 'a@b.c'), ['fy-next', '2083-84', 'a@b.c']);
  });
});

describe('fiscal-year deletion guard', () => {
  test('counts 13 business-record tables and excludes bs_day_records', () => {
    assert.equal(FY_REFERENCE_TABLES.length, 13);
    assert.ok(!FY_REFERENCE_TABLES.some(([table]) => table === 'bs_day_records'));
    assert.ok(FY_REFERENCE_TABLES.some(([table]) => table === 'vendor_opening_balances'));
  });

  test('count SQL scopes by fiscal_year_id', () => {
    assert.equal(
      fiscalYearReferenceCountSql('purchase_invoices'),
      'SELECT COUNT(*)::int AS count FROM purchase_invoices WHERE fiscal_year_id = $1;'
    );
  });
});
