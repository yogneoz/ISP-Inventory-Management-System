/**
 * Repository for the admin domain — every SQL string and param-list builder
 * for demo-data cleanup, company profile, branches, users, admin
 * recalculations (fixed assets, live stock, BS calendar, fiscal-year links),
 * document numbering, fiscal years, and BS-calendar seeding lives here,
 * following the same pattern as ./procurement.repo.ts and ./misc.repo.ts.
 *
 * admin.controller.ts keeps only HTTP concerns (request shaping, cache
 * updates, audit logging, response bodies); query text and column lists are
 * defined once in this layer.
 */
import type { Asset, Branch, CompanyProfile, DocumentNumberConfig, FiscalYear, User } from '../../../client/src/types';

// ---------------------------------------------------------------------------
// Demo-data cleanup
// ---------------------------------------------------------------------------

/**
 * Child/detail tables first so their is_demo rows are counted before parent
 * rows are removed (FK cascades would otherwise hide them).
 */
export const DEMO_DATA_TABLES = [
  'transaction_logs',
  'audit_logs',
  'vendor_payments',
  'stock_operations',
  'approval_requests',
  'customer_device_records',
  'serial_log',
  'purchase_invoices',
  'shipments',
  'inventory_stock',
  'fixed_assets',
  'purchase_orders',
  'customer_records',
  'products',
  'categories',
  'suppliers',
  'fiscal_years',
] as const;

export function demoDataDeleteSql(table: string): string {
  return `DELETE FROM ${table} WHERE is_demo = TRUE`;
}

// ---------------------------------------------------------------------------
// Company profile
// ---------------------------------------------------------------------------

export const COMPANY_PROFILE_SELECT_SQL =
  'SELECT id, name, legal_name AS "legalName", tagline, address, city, country, postal_code AS "postalCode", phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", currency_code AS "currencyCode", currency_locale AS "currencyLocale", currency_position AS "currencyPosition", currency_decimals AS "currencyDecimals", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1';

export const COMPANY_PROFILE_UPSERT_SQL = `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, postal_code, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, currency_code, currency_locale, currency_position, currency_decimals, default_tax_rate, notes, updated_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, CURRENT_TIMESTAMP)
 ON CONFLICT (id) DO UPDATE SET
   name = EXCLUDED.name,
   legal_name = EXCLUDED.legal_name,
   tagline = EXCLUDED.tagline,
   address = EXCLUDED.address,
   city = EXCLUDED.city,
   country = EXCLUDED.country,
   postal_code = EXCLUDED.postal_code,
   phone = EXCLUDED.phone,
   email = EXCLUDED.email,
   website = EXCLUDED.website,
   pan_vat_number = EXCLUDED.pan_vat_number,
   registration_number = EXCLUDED.registration_number,
   logo_url = EXCLUDED.logo_url,
   logo_preset = EXCLUDED.logo_preset,
   currency_symbol = EXCLUDED.currency_symbol,
   currency_code = EXCLUDED.currency_code,
   currency_locale = EXCLUDED.currency_locale,
   currency_position = EXCLUDED.currency_position,
   currency_decimals = EXCLUDED.currency_decimals,
   default_tax_rate = EXCLUDED.default_tax_rate,
   notes = EXCLUDED.notes,
   updated_at = CURRENT_TIMESTAMP;`;

export function companyProfileUpsertParams(p: CompanyProfile): unknown[] {
  return [
    p.id || 'COMP-001',
    p.name,
    p.legalName || '',
    p.tagline || '',
    p.address,
    p.city || '',
    p.country || '',
    p.postalCode || '',
    p.phone || '',
    p.email || '',
    p.website || '',
    p.panVatNumber || '',
    p.registrationNumber || '',
    p.logoUrl || '',
    p.logoPreset || 'telecom',
    p.currencySymbol || 'NPR',
    p.currencyCode || 'NPR',
    p.currencyLocale || 'en-IN',
    p.currencyPosition || 'before',
    p.currencyDecimals ?? 2,
    p.defaultTaxRate ?? 13,
    p.notes || '',
  ];
}

/**
 * Variant used by put_companyProfile2: identical columns but without the
 * updated_at bind (the literal CURRENT_TIMESTAMP appears only in the INSERT
 * column list there) and with 'Nepal' as the country default.
 */
export const COMPANY_PROFILE_UPSERT_NO_STAMP_SQL = `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, postal_code, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, currency_code, currency_locale, currency_position, currency_decimals, default_tax_rate, notes)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
 ON CONFLICT (id) DO UPDATE SET
   name = EXCLUDED.name,
   legal_name = EXCLUDED.legal_name,
   tagline = EXCLUDED.tagline,
   address = EXCLUDED.address,
   city = EXCLUDED.city,
   country = EXCLUDED.country,
   postal_code = EXCLUDED.postal_code,
   phone = EXCLUDED.phone,
   email = EXCLUDED.email,
   website = EXCLUDED.website,
   pan_vat_number = EXCLUDED.pan_vat_number,
   registration_number = EXCLUDED.registration_number,
   logo_url = EXCLUDED.logo_url,
   logo_preset = EXCLUDED.logo_preset,
   currency_symbol = EXCLUDED.currency_symbol,
   currency_code = EXCLUDED.currency_code,
   currency_locale = EXCLUDED.currency_locale,
   currency_position = EXCLUDED.currency_position,
   currency_decimals = EXCLUDED.currency_decimals,
   default_tax_rate = EXCLUDED.default_tax_rate,
   notes = EXCLUDED.notes`;

export function companyProfileUpsertNoStampParams(p: CompanyProfile): unknown[] {
  return [
    p.id || 'COMP-001',
    p.name,
    p.legalName || '',
    p.tagline || '',
    p.address,
    p.city || '',
    p.country || 'Nepal',
    p.postalCode || '',
    p.phone || '',
    p.email || '',
    p.website || '',
    p.panVatNumber || '',
    p.registrationNumber || '',
    p.logoUrl || '',
    p.logoPreset || 'telecom',
    p.currencySymbol || 'NPR',
    p.currencyCode || 'NPR',
    p.currencyLocale || 'en-IN',
    p.currencyPosition || 'before',
    p.currencyDecimals ?? 2,
    p.defaultTaxRate || 13,
    p.notes || '',
  ];
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export const BRANCH_SELECT_SQL =
  'SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement", allow_warehouse_transfer AS "allowWarehouseTransfer" FROM branches ORDER BY name ASC';

export const BRANCH_UPSERT_SQL = `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement, allow_warehouse_transfer)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
 ON CONFLICT (id) DO UPDATE SET
   code = EXCLUDED.code,
   name = EXCLUDED.name,
   location = EXCLUDED.location,
   phone = EXCLUDED.phone,
   is_headquarters = EXCLUDED.is_headquarters,
   active = EXCLUDED.active,
   allow_procurement = EXCLUDED.allow_procurement,
   allow_warehouse_transfer = EXCLUDED.allow_warehouse_transfer;`;

export function branchUpsertParams(b: Branch): unknown[] {
  return [
    b.id,
    b.code,
    b.name,
    b.location,
    b.phone,
    b.isHeadquarters,
    b.active,
    b.allowProcurement,
    b.allowWarehouseTransfer,
  ];
}

export const BRANCH_UPDATE_SQL = `UPDATE branches SET
   code = $1, name = $2, location = $3, phone = $4, is_headquarters = $5, active = $6, allow_procurement = $7, allow_warehouse_transfer = $8
 WHERE id = $9;`;

export function branchUpdateParams(b: Partial<Branch> & Pick<Branch, 'id'>): unknown[] {
  return [
    b.code,
    b.name,
    b.location,
    b.phone || '',
    Boolean(b.isHeadquarters),
    b.active !== false,
    b.allowProcurement !== false,
    b.allowWarehouseTransfer !== false,
    b.id,
  ];
}

export const BRANCH_DELETE_SQL = 'DELETE FROM branches WHERE id = $1';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const USER_SELECT_SQL =
  'SELECT id, email, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC';

export const USER_EXISTS_SQL = 'SELECT * FROM users WHERE id = $1';

export const USER_UPSERT_SQL = `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (email) DO UPDATE SET
   name = EXCLUDED.name,
   role = EXCLUDED.role,
   branch_id = EXCLUDED.branch_id,
   allowed_branch_ids = EXCLUDED.allowed_branch_ids,
   can_switch_user = EXCLUDED.can_switch_user,
   password = EXCLUDED.password;`;

export function userUpsertParams(u: User): unknown[] {
  return [
    u.id,
    u.email,
    u.password,
    u.name,
    u.role,
    u.branchId || null,
    u.allowedBranchIds || null,
    !!u.canSwitchUser,
  ];
}

export const USER_UPDATE_SQL = `UPDATE users SET
   email = $1,
   name = $2,
   role = $3,
   branch_id = $4,
   allowed_branch_ids = $5,
   can_switch_user = $6,
   password = COALESCE($7, password)
 WHERE id = $8`;

export function userUpdateParams(u: Partial<User> & Pick<User, 'id'>, hashedPassword: string | null): unknown[] {
  return [
    u.email,
    u.name,
    u.role,
    u.branchId || null,
    u.allowedBranchIds || null,
    !!u.canSwitchUser,
    hashedPassword,
    u.id,
  ];
}

export const USER_DELETE_SQL = 'DELETE FROM users WHERE id = $1 RETURNING email, name';

export const USER_RESET_PASSWORD_SQL =
  'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING email, name';

// ---------------------------------------------------------------------------
// Admin recalculation — fixed assets
// ---------------------------------------------------------------------------

export const ASSET_RECALC_SELECT_SQL = `SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId",
  acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS",
  purchase_invoice_date_ad AS "purchaseInvoiceDateAD", purchase_invoice_date_bs AS "purchaseInvoiceDateBS",
  capitalization_date_ad AS "capitalizationDateAD", placed_in_service_date_ad AS "placedInServiceDateAD",
        acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod",
        depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation",
        net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo"
 FROM fixed_assets`;

export const ASSET_RECALC_UPDATE_SQL = `UPDATE fixed_assets
 SET accumulated_depreciation = $1, net_book_value = $2, updated_at = CURRENT_TIMESTAMP
 WHERE id = $3`;

// ---------------------------------------------------------------------------
// Admin recalculation — live stock
// ---------------------------------------------------------------------------

export const LIVE_STOCK_RECALC_SQL = `WITH latest AS (
   SELECT DISTINCT ON (product_id, branch_id) product_id, branch_id, GREATEST(quantity_after, 0) AS quantity_after
   FROM transaction_logs
   WHERE change_type <> 'DAMAGE'
   ORDER BY product_id, branch_id, timestamp_ad DESC, id DESC
 )
 UPDATE inventory_stock s
 SET quantity_on_hand = latest.quantity_after, last_updated = CURRENT_TIMESTAMP
 FROM latest
 WHERE s.product_id = latest.product_id AND s.branch_id = latest.branch_id
 RETURNING s.id`;

// ---------------------------------------------------------------------------
// BS calendar — day-record rebuild / seed / sync
// ---------------------------------------------------------------------------

export const BS_CALENDAR_YEARS_SELECT_SQL =
  'SELECT year_bs AS "yearBS", days_in_months AS "daysInMonths", start_ad::text AS "startAD" FROM bs_calendar_years ORDER BY year_bs ASC';

export const BS_CALENDAR_YEAR_UPSERT_SQL = `INSERT INTO bs_calendar_years (year_bs, days_in_months, start_ad)
 VALUES ($1, $2, $3)
 ON CONFLICT (year_bs) DO UPDATE SET
   days_in_months = EXCLUDED.days_in_months,
   start_ad = EXCLUDED.start_ad;`;

export const BS_CALENDAR_YEAR_SET_START_SQL = 'UPDATE bs_calendar_years SET start_ad = $2 WHERE year_bs = $1;';

export const BS_DAY_RECORDS_DELETE_BY_YEARS_SQL = 'DELETE FROM bs_day_records WHERE bs_year = ANY($1::int[]);';

/** Day-record insert without a fiscal_year_id bind (seed / sync-range paths). */
export const BS_DAY_RECORD_UPSERT_SQL = `INSERT INTO bs_day_records (
   ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
   bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, quarter, is_weekend
 )
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
 ON CONFLICT (ad_date) DO UPDATE SET
   bs_date = EXCLUDED.bs_date,
   bs_year = EXCLUDED.bs_year,
   bs_month = EXCLUDED.bs_month,
   bs_month_name = EXCLUDED.bs_month_name,
   bs_month_name_np = EXCLUDED.bs_month_name_np,
   bs_day = EXCLUDED.bs_day,
   day_of_week_name = EXCLUDED.day_of_week_name,
   day_of_week_name_np = EXCLUDED.day_of_week_name_np,
   fiscal_year = EXCLUDED.fiscal_year,
   quarter = EXCLUDED.quarter,
   is_weekend = EXCLUDED.is_weekend;`;

/**
 * Day-record insert used by the recalculation rebuild: resolves the owning
 * fiscal year in SQL (latest matching period wins) instead of binding it.
 */
export const BS_DAY_RECORD_UPSERT_WITH_FY_SQL = `INSERT INTO bs_day_records (
   ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
   bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, quarter, is_weekend, fiscal_year_id
 )
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         (SELECT fy.id FROM fiscal_years fy
          WHERE fy.start_date_ad <= $1::date AND fy.end_date_ad >= $1::date
          ORDER BY fy.start_date_ad DESC LIMIT 1))
 ON CONFLICT (ad_date) DO UPDATE SET
   bs_date = EXCLUDED.bs_date,
   bs_year = EXCLUDED.bs_year,
   bs_month = EXCLUDED.bs_month,
   bs_month_name = EXCLUDED.bs_month_name,
   bs_month_name_np = EXCLUDED.bs_month_name_np,
   bs_day = EXCLUDED.bs_day,
   day_of_week_name = EXCLUDED.day_of_week_name,
   day_of_week_name_np = EXCLUDED.day_of_week_name_np,
   fiscal_year = EXCLUDED.fiscal_year,
   quarter = EXCLUDED.quarter,
   is_weekend = EXCLUDED.is_weekend,
   fiscal_year_id = EXCLUDED.fiscal_year_id;`;

/** Param list shared by both day-record upsert variants (12 binds). */
export function bsDayRecordParams(rec: {
  adDate: string;
  bsDate: string;
  bsYear: number;
  bsMonth: number;
  bsMonthName: string;
  bsMonthNameNp: string;
  bsDay: number;
  dayOfWeekName: string;
  dayOfWeekNameNp: string;
  fiscalYear: string;
  quarter: string;
  isWeekend: boolean;
}): unknown[] {
  return [
    rec.adDate,
    rec.bsDate,
    rec.bsYear,
    rec.bsMonth,
    rec.bsMonthName,
    rec.bsMonthNameNp,
    rec.bsDay,
    rec.dayOfWeekName,
    rec.dayOfWeekNameNp,
    rec.fiscalYear,
    rec.quarter,
    rec.isWeekend,
  ];
}

export const BS_DAY_RECORDS_LIST_SQL = `
      SELECT ad_date::text AS "adDate", bs_date AS "bsDate", bs_year AS "bsYear", bs_month AS "bsMonth",
             bs_month_name AS "bsMonthName", bs_month_name_np AS "bsMonthNameNp", bs_day AS "bsDay",
             day_of_week_name AS "dayOfWeekName", day_of_week_name_np AS "dayOfWeekNameNp",
             fiscal_year AS "fiscalYear", quarter, is_weekend AS "isWeekend"
      FROM bs_day_records
      WHERE 1=1
    `;

/**
 * Builds the BS day-records list query with optional year/month filters and a
 * case-insensitive search across the five searchable columns. Mirrors the
 * inline SQL assembled in the controller verbatim.
 */
export function buildBsDayRecordsQuery(
  yearBS?: unknown,
  monthBS?: unknown,
  search?: unknown
): { sql: string; params: unknown[] } {
  let sql = BS_DAY_RECORDS_LIST_SQL;
  const params: unknown[] = [];
  if (yearBS && yearBS !== 'ALL') {
    params.push(parseInt(String(yearBS), 10));
    sql += ` AND bs_year = $${params.length}`;
  }
  if (monthBS && monthBS !== 'ALL') {
    params.push(parseInt(String(monthBS), 10));
    sql += ` AND bs_month = $${params.length}`;
  }
  if (search && typeof search === 'string' && search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    sql += ` AND (
        LOWER(ad_date::text) LIKE $${params.length} OR
        LOWER(bs_date) LIKE $${params.length} OR
        LOWER(bs_month_name) LIKE $${params.length} OR
        LOWER(day_of_week_name) LIKE $${params.length} OR
        LOWER(fiscal_year) LIKE $${params.length}
      )`;
  }
  sql += ` ORDER BY ad_date ASC LIMIT 500;`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Admin repair — fiscal-year links
// ---------------------------------------------------------------------------

export interface FiscalYearLinkTarget {
  table: string;
  column: string;
  dateColumn: string;
  dateType: 'date' | 'timestamptz' | 'timestamp';
  keyColumn: string;
}

/** Tables whose fiscal_year_id references the recalculation repairs. */
export const FISCAL_YEAR_LINK_TARGETS: readonly FiscalYearLinkTarget[] = [
  { table: 'fixed_assets', column: 'fiscal_year_id', dateColumn: 'acquisition_date_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'damage_records', column: 'fiscal_year_id', dateColumn: 'damage_date_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'purchase_orders', column: 'fiscal_year_id', dateColumn: 'order_date_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'purchase_invoices', column: 'fiscal_year_id', dateColumn: 'invoice_date_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'shipments', column: 'fiscal_year_id', dateColumn: 'dispatch_date_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'stock_operations', column: 'fiscal_year_id', dateColumn: 'date_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'customer_device_records', column: 'fiscal_year_id', dateColumn: 'issued_date_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'approval_requests', column: 'fiscal_year_id', dateColumn: 'requested_at_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'vendor_payments', column: 'fiscal_year_id', dateColumn: 'payment_date_ad', dateType: 'date', keyColumn: 'id' },
  { table: 'audit_logs', column: 'fiscal_year_id', dateColumn: 'timestamp_ad', dateType: 'timestamptz', keyColumn: 'id' },
  { table: 'transaction_logs', column: 'fiscal_year_id', dateColumn: 'timestamp_ad', dateType: 'timestamptz', keyColumn: 'id' },
  { table: 'bs_day_records', column: 'fiscal_year_id', dateColumn: 'ad_date', dateType: 'date', keyColumn: 'ad_date' },
];

export const COLUMN_EXISTS_SQL =
  `SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`;

/**
 * Fix NULL references and stale references in one pass: every row whose
 * current fiscal_year_id does not actually contain its own date is re-linked
 * to the fiscal year that does contain it (latest matching period wins; the
 * schema forbids overlapping periods anyway). Rows whose date is not inside
 * any fiscal period are left untouched.
 */
export function buildFiscalYearLinkRepairSql(entry: FiscalYearLinkTarget): string {
  const tableName = `"${entry.table}"`;
  const keyColumn = entry.keyColumn;
  const dateExpr = entry.dateType === 'date' ? entry.dateColumn : `(${entry.dateColumn})::date`;
  return `WITH wrong AS (
             SELECT t2.${keyColumn} AS row_key
             FROM ${tableName} t2
             WHERE t2.fiscal_year_id IS NULL
                OR NOT EXISTS (
                     SELECT 1 FROM fiscal_years cur
                     WHERE cur.id = t2.fiscal_year_id
                       AND cur.start_date_ad <= ${dateExpr}
                       AND cur.end_date_ad >= ${dateExpr}
                   )
           ),
           matched AS (
             SELECT w.row_key, fy.id AS fy_id
             FROM wrong w
             JOIN ${tableName} t3 ON t3.${keyColumn} = w.row_key
             JOIN fiscal_years fy
               ON fy.start_date_ad <= ${dateExpr} AND fy.end_date_ad >= ${dateExpr}
           )
           UPDATE ${tableName} t
           SET fiscal_year_id = m.fy_id
           FROM matched m
           WHERE t.${keyColumn} = m.row_key
             AND t.fiscal_year_id IS DISTINCT FROM m.fy_id`;
}

// ---------------------------------------------------------------------------
// Document numbering
// ---------------------------------------------------------------------------

export const DOC_NUMBER_CONFIG_SELECT_COLUMNS =
  `id, document_type AS "documentType", prefix, suffix, min_digits AS "minDigits",
              starting_number AS "startingNumber", next_number AS "nextNumber",
              reset_every_fiscal_year AS "resetEveryFiscalYear", notes`;

export const DOC_NUMBER_CONFIGS_SELECT_SQL =
  `SELECT ${DOC_NUMBER_CONFIG_SELECT_COLUMNS}
   FROM document_number_configs ORDER BY id ASC;`;

export const DOC_NUMBER_CONFIG_BY_ID_SQL =
  `SELECT ${DOC_NUMBER_CONFIG_SELECT_COLUMNS}
   FROM document_number_configs WHERE id = $1;`;

/**
 * C2-style atomic sequence claim for post_generateNext: increments the
 * counter and returns BOTH the row it had (next_number_before = the number
 * this caller consumes) and the row's formatting fields in one statement.
 * Two concurrent callers can never receive the same number. The DB counter is
 * the authority; callers only sync the in-memory mirror from the returned
 * next_number (= before + 1).
 */
export const DOC_NUMBER_CONFIG_CLAIM_SQL = `UPDATE document_number_configs
       SET next_number = document_number_configs.next_number + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING next_number - 1 AS next_number_before, next_number AS next_number_after,
                 prefix, suffix, min_digits;`;

export const DOC_NUMBER_CONFIG_UPDATE_SQL = `UPDATE document_number_configs
       SET prefix = $1, suffix = $2, min_digits = $3, starting_number = $4,
           next_number = $5, reset_every_fiscal_year = $6, notes = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8;`;

export const DOC_NUMBER_CONFIG_UPSERT_SQL = `INSERT INTO document_number_configs (id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
             prefix = EXCLUDED.prefix,
             suffix = EXCLUDED.suffix,
             min_digits = EXCLUDED.min_digits,
             starting_number = EXCLUDED.starting_number,
             next_number = EXCLUDED.next_number,
             reset_every_fiscal_year = EXCLUDED.reset_every_fiscal_year,
             notes = EXCLUDED.notes,
             updated_at = CURRENT_TIMESTAMP;`;

export function docNumberConfigUpsertParams(cfg: DocumentNumberConfig): unknown[] {
  return [
    cfg.id,
    cfg.documentType,
    cfg.prefix || '',
    cfg.suffix || '',
    cfg.minDigits || 4,
    cfg.startingNumber || 1,
    cfg.nextNumber || 1,
    cfg.resetEveryFiscalYear !== false,
    cfg.notes || '',
  ];
}

export const DOC_NUMBER_CONFIG_INCREMENT_SQL =
  'UPDATE document_number_configs SET next_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;';

// ---------------------------------------------------------------------------
// Fiscal years
// ---------------------------------------------------------------------------

export const FY_SELECT_COLUMNS =
  `id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
              start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                    is_current AS "isCurrent", is_closed AS "isClosed", is_demo AS "isDemo"`;

export const FY_LIST_SQL = `SELECT ${FY_SELECT_COLUMNS}
             FROM fiscal_years ORDER BY start_date_ad DESC;`;

/** Insert/re-read columns without the is_demo flag (created as is_demo = FALSE). */
export const FY_WRITE_COLUMNS =
  `id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                 start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                 is_current AS "isCurrent", is_closed AS "isClosed"`;

export const FY_OVERLAP_CHECK_SQL = `SELECT code FROM fiscal_years
       WHERE ($1::date BETWEEN start_date_ad AND end_date_ad)
          OR ($2::date BETWEEN start_date_ad AND end_date_ad)
          OR (start_date_ad BETWEEN $1::date AND $2::date)
       LIMIT 1;`;

export const FY_INSERT_SQL = `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE, FALSE)
       RETURNING ${FY_SELECT_COLUMNS};`;

export function fiscalYearInsertParams(fy: {
  id: string;
  code: string;
  startDateAD: string;
  endDateAD: string;
  startDateBS: string;
  endDateBS: string;
}): unknown[] {
  return [fy.id, fy.code, fy.startDateAD, fy.endDateAD, fy.startDateBS, fy.endDateBS];
}

export const FY_SET_CURRENT_CLEAR_SQL = 'UPDATE fiscal_years SET is_current = FALSE;';

export const FY_SET_CURRENT_SQL = 'UPDATE fiscal_years SET is_current = TRUE WHERE id = $1 RETURNING id;';

export const FY_UPDATE_SQL = `UPDATE fiscal_years
       SET code = $1, start_date_ad = $2, end_date_ad = $3, start_date_bs = $4, end_date_bs = $5
       WHERE id = $6
       RETURNING ${FY_WRITE_COLUMNS};`;

export const FY_CLOSE_SQL = `UPDATE fiscal_years
       SET is_closed = TRUE
       WHERE id = $1 AND end_date_ad < CURRENT_DATE
       RETURNING ${FY_WRITE_COLUMNS};`;

export const FY_END_DATE_SQL = 'SELECT end_date_ad::text AS "endDateAD" FROM fiscal_years WHERE id = $1;';

export const FY_REOPEN_SQL = `UPDATE fiscal_years SET is_closed = FALSE WHERE id = $1
       RETURNING ${FY_WRITE_COLUMNS};`;

export const FY_FIND_FOR_INIT_SQL =
  'SELECT id, code, end_date_ad, is_closed FROM fiscal_years WHERE id = $1 FOR UPDATE;';

export const FY_NEXT_AFTER_SQL = `SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                is_current AS "isCurrent", is_closed AS "isClosed"
         FROM fiscal_years WHERE start_date_ad > $1 ORDER BY start_date_ad ASC LIMIT 1 FOR UPDATE;`;

export const FY_FIND_FOR_DELETE_SQL =
  'SELECT id, code, is_current AS "isCurrent", is_closed AS "isClosed" FROM fiscal_years WHERE id = $1 FOR UPDATE;';

export const FY_DELETE_SQL = 'DELETE FROM fiscal_years WHERE id = $1;';

// ---------------------------------------------------------------------------
// Fiscal-year opening stock initialization
// ---------------------------------------------------------------------------

export const FY_OPENING_STOCK_COUNTS_SQL = `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE source_type = 'MANUAL_ADJUSTMENT')::int AS manual
         FROM fiscal_year_opening_stock WHERE fiscal_year_id = $1`;

/**
 * Enterprise rule: rows that were manually adjusted after the original close
 * (source_type = 'MANUAL_ADJUSTMENT') are posted, corrected opening balances
 * and must survive a re-initialization. Only closing-generated rows get
 * refreshed.
 */
export const FY_OPENING_STOCK_INIT_SQL = `INSERT INTO fiscal_year_opening_stock (
           id, fiscal_year_id, product_id, branch_id, quantity_on_hand, damaged_qty, unit_cost, source_type, source_reference, posted_by
         )
         SELECT
           'open-' || $1 || '-' || products.id || '-' || branches.id,
           $1, products.id, branches.id,
           COALESCE(inventory_stock.quantity_on_hand, 0),
           COALESCE(inventory_stock.damaged_qty, 0),
           COALESCE(products.cost_price, 0),
           'FISCAL_CLOSE', $2, $3
         FROM products
         CROSS JOIN branches
         LEFT JOIN inventory_stock
           ON inventory_stock.product_id = products.id
          AND inventory_stock.branch_id = branches.id
         WHERE branches.active = TRUE
         ON CONFLICT (fiscal_year_id, product_id, branch_id) DO UPDATE SET
           quantity_on_hand = EXCLUDED.quantity_on_hand,
           damaged_qty = EXCLUDED.damaged_qty,
           unit_cost = EXCLUDED.unit_cost,
           source_type = EXCLUDED.source_type,
           source_reference = EXCLUDED.source_reference,
           posted_at = CURRENT_TIMESTAMP,
           posted_by = EXCLUDED.posted_by
         WHERE fiscal_year_opening_stock.source_type <> 'MANUAL_ADJUSTMENT'
         RETURNING id;`;

export function fiscalYearOpeningStockInitParams(
  targetFiscalYearId: string,
  sourceFiscalYearCode: string,
  postedBy: string
): unknown[] {
  return [targetFiscalYearId, sourceFiscalYearCode, postedBy || 'system'];
}

// ---------------------------------------------------------------------------
// Fiscal-year deletion safety guard
// ---------------------------------------------------------------------------

/**
 * Safety guard: a fiscal year that already carries ANY business records
 * (invoices, stock operations, opening balances, audit/transaction logs,
 * device records, etc.) must never be deleted. Only a completely empty
 * period created by mistake can be removed. bs_day_records are excluded:
 * they are auto-generated calendar reference rows (FK ON DELETE SET NULL)
 * that exist for every period, not business records belonging to the FY.
 */
export const FY_REFERENCE_TABLES: ReadonlyArray<readonly [table: string, label: string]> = [
  ['purchase_invoices', 'purchase invoices'],
  ['purchase_orders', 'purchase orders'],
  ['shipments', 'shipments'],
  ['stock_operations', 'stock operations'],
  ['damage_records', 'damage records'],
  ['fixed_assets', 'fixed assets'],
  ['vendor_payments', 'vendor payments'],
  ['audit_logs', 'audit logs'],
  ['transaction_logs', 'transaction logs'],
  ['customer_device_records', 'customer device records'],
  ['approval_requests', 'approval requests'],
  ['fiscal_year_opening_stock', 'opening-stock records'],
  ['vendor_opening_balances', 'vendor opening-balance records'],
];

export function fiscalYearReferenceCountSql(table: string): string {
  return `SELECT COUNT(*)::int AS count FROM ${table} WHERE fiscal_year_id = $1;`;
}
