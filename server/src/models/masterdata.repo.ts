/**
 * Repository for the masterdata domain — every SQL string and param-list
 * builder for UoM, locations, suppliers, products, categories, and customers
 * lives here, following the same pattern as ./bootstrap.repo.ts.
 *
 * masterdata.controller.ts keeps only HTTP concerns (request shaping, cache
 * updates, audit logging, response bodies); query text and column lists are
 * defined once in this layer.
 */

// ---------------------------------------------------------------------------
// Unit of Measure
// ---------------------------------------------------------------------------

export const UOM_SELECT = 'SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC';

export const UOM_UPSERT_SQL = `INSERT INTO uom (id, name, symbol, type, is_base_unit)
 VALUES ($1, $2, $3, $4, $5)
 ON CONFLICT (id) DO UPDATE SET
   name = EXCLUDED.name,
   symbol = EXCLUDED.symbol,
   type = EXCLUDED.type,
   is_base_unit = EXCLUDED.is_base_unit;`;

export function upsertUomParams(u: { id: string; name: string; symbol: string; type: string; isBaseUnit?: boolean }): unknown[] {
  return [u.id, u.name, u.symbol, u.type, u.isBaseUnit];
}

export const UOM_UPDATE_SQL = 'UPDATE uom SET name = $1, symbol = $2, type = $3, is_base_unit = $4 WHERE id = $5;';

export function updateUomParams(u: { name: string; symbol: string; type: string; isBaseUnit?: boolean }, id: string): unknown[] {
  return [u.name, u.symbol, u.type, Boolean(u.isBaseUnit), id];
}

export const UOM_DELETE_SQL = 'DELETE FROM uom WHERE id = $1';

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const LOCATION_SELECT =
  'SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations';

export function buildLocationSelectSql(branchId?: unknown): { sql: string; params: unknown[] } {
  const filter = branchId && branchId !== 'ALL';
  return {
    sql: LOCATION_SELECT + (filter ? ' WHERE branch_id = $1' : '') + ' ORDER BY name ASC',
    params: filter ? [branchId] : [],
  };
}

export const LOCATION_UPSERT_SQL = `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
 ON CONFLICT (id) DO UPDATE SET
   name = EXCLUDED.name,
   type = EXCLUDED.type,
   branch_id = EXCLUDED.branch_id,
   address = EXCLUDED.address,
   coordinates = EXCLUDED.coordinates,
   contact_person = EXCLUDED.contact_person,
   contact_phone = EXCLUDED.contact_phone,
   notes = EXCLUDED.notes,
   active_assets_count = EXCLUDED.active_assets_count;`;

export function locationParams(loc: {
  id: string; name: string; type: string; branchId: string; address?: string;
  coordinates?: unknown; contactPerson?: string; contactPhone?: string; notes?: string; activeAssetsCount?: number;
}): unknown[] {
  return [
    loc.id, loc.name, loc.type, loc.branchId, loc.address,
    JSON.stringify(loc.coordinates), loc.contactPerson, loc.contactPhone, loc.notes, loc.activeAssetsCount,
  ];
}

export const LOCATION_DELETE_SQL = 'DELETE FROM locations WHERE id = $1';

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const SUPPLIER_SELECT =
  'SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC';

export const SUPPLIER_UPSERT_SQL = `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
 ON CONFLICT (id) DO UPDATE SET
   supplier_code = EXCLUDED.supplier_code,
   name = EXCLUDED.name,
   contact_person = EXCLUDED.contact_person,
   phone = EXCLUDED.phone,
   email = EXCLUDED.email,
   address = EXCLUDED.address,
   pan_vat_number = EXCLUDED.pan_vat_number,
   rating = EXCLUDED.rating,
   status = EXCLUDED.status;`;

export function supplierUpsertParams(s: Record<string, any>): unknown[] {
  return [s.id, s.supplierCode, s.name, s.contactPerson, s.phone, s.email, s.address, s.panVatNumber, s.rating, s.status];
}

export const SUPPLIER_UPDATE_SQL = `UPDATE suppliers SET
   supplier_code = $1, name = $2, contact_person = $3, phone = $4, email = $5, address = $6, pan_vat_number = $7, rating = $8, status = $9
 WHERE id = $10;`;

export function supplierUpdateParams(s: Record<string, any>, id: string): unknown[] {
  return [s.supplierCode || '', s.name, s.contactPerson || '', s.phone || '', s.email || '', s.address || '', s.panVatNumber || '', Number(s.rating) || 5.0, s.status || 'ACTIVE', id];
}

export const SUPPLIER_DELETE_SQL = 'DELETE FROM suppliers WHERE id = $1';

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const PRODUCT_SELECT =
  'SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, vendor_warranty_months AS "vendorWarrantyMonths", seller_warranty_months AS "sellerWarrantyMonths", status FROM products ORDER BY created_at DESC';

/** WTY-1 term bounds: 0 = no warranty, 120 = ten years. */
function warrantyMonths(value: unknown, fallback = 12): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 120 ? Math.trunc(numeric) : fallback;
}

export const PRODUCT_UPSERT_SQL = `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, vendor_warranty_months, seller_warranty_months, status)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
 ON CONFLICT (id) DO UPDATE SET
   sku = EXCLUDED.sku,
   name = EXCLUDED.name,
   category = EXCLUDED.category,
   selling_price = EXCLUDED.selling_price,
   vendor_warranty_months = EXCLUDED.vendor_warranty_months,
   seller_warranty_months = EXCLUDED.seller_warranty_months;`;

export function productUpsertParams(p: Record<string, any>): unknown[] {
  return [
    p.id, p.sku, p.barcode, p.name, p.category, p.productGroup, p.unit,
    p.costPrice, p.sellingPrice, p.taxRate, p.minReorderLevel,
    p.requiresSerialTracking, p.trackingType, p.description,
    warrantyMonths(p.vendorWarrantyMonths), warrantyMonths(p.sellerWarrantyMonths), p.status,
  ];
}

export const PRODUCT_UPDATE_SQL = `UPDATE products SET
   sku = $1,
   barcode = $2,
   name = $3,
   category = $4,
   product_group = $5,
   unit = $6,
   cost_price = $7,
   selling_price = $8,
   tax_rate = $9,
   min_reorder_level = $10,
   requires_serial_tracking = $11,
   tracking_type = $12,
   description = $13,
   status = $14,
   vendor_warranty_months = $15,
   seller_warranty_months = $16
 WHERE id = $17;`;

export function productUpdateParams(
  p: Record<string, any>,
  id: string,
  /** Company-configured default (company_profile.default_tax_rate), supplied by the controller. */
  defaultTaxRate = 13
): unknown[] {
  // A supplied taxRate — including 0, which means "VAT exempt" — is kept
  // verbatim; only a missing/NaN/negative value falls back to the configured
  // default. The old `Number(p.taxRate) || 13` silently turned every exempt
  // product back into a 13% one on save.
  const taxRate = Number(p.taxRate);
  const effectiveTaxRate = Number.isFinite(taxRate) && taxRate >= 0 ? taxRate : defaultTaxRate;
  // The controller resolves productGroup against the managed table before this
  // builder runs, so there is deliberately no hard-coded group fallback here:
  // a missing value must fail loudly instead of silently reviving a name the
  // operator may have renamed or retired.
  return [
    p.sku,
    p.barcode || '',
    p.name,
    p.category,
    p.productGroup,
    p.unit || 'Pcs',
    Number(p.costPrice) || 0,
    Number(p.sellingPrice) || 0,
    effectiveTaxRate,
    Number(p.minReorderLevel) || 5,
    Boolean(p.requiresSerialTracking),
    p.trackingType || 'QUANTITY_ONLY',
    p.description || '',
    p.status || 'ACTIVE',
    warrantyMonths(p.vendorWarrantyMonths),
    warrantyMonths(p.sellerWarrantyMonths),
    id,
  ];
}

export const PRODUCT_DELETE_SQL = 'DELETE FROM products WHERE id = $1;';

export const STOCK_INIT_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (id) DO NOTHING;`;

export function stockInitParams(stk: Record<string, any>): unknown[] {
  return [stk.id, stk.productId, stk.branchId, stk.quantityOnHand, stk.damagedQty, stk.reservedQty, stk.incomingQty, stk.minReorderLevel];
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const CATEGORY_SELECT =
  'SELECT id, name, code, description, is_special_tracked AS "isSpecialTracked" FROM categories ORDER BY name ASC';

export const CATEGORY_UPSERT_SQL = `INSERT INTO categories (id, name, code, description, is_special_tracked)
 VALUES ($1, $2, $3, $4, $5)
 ON CONFLICT (id) DO UPDATE SET
   name = EXCLUDED.name,
   code = EXCLUDED.code,
   description = EXCLUDED.description,
   is_special_tracked = EXCLUDED.is_special_tracked;`;

export function categoryUpsertParams(c: Record<string, any>): unknown[] {
  return [c.id, c.name, c.code, c.description, c.isSpecialTracked];
}

export const CATEGORY_UPDATE_SQL = `UPDATE categories
 SET name = $1,
     code = $2,
     description = $3,
     is_special_tracked = $4
 WHERE id = $5;`;

export function categoryUpdateParams(c: Record<string, any>, id: string): unknown[] {
  return [c.name, c.code, c.description || '', Boolean(c.isSpecialTracked), id];
}

export const CATEGORY_DELETE_SQL = 'DELETE FROM categories WHERE id = $1;';

// ---------------------------------------------------------------------------
// Product groups
// ---------------------------------------------------------------------------

export const PRODUCT_GROUP_SELECT = `SELECT g.id, g.code, g.name, g.behavior,
  g.sort_order AS "sortOrder", g.active, g.is_system AS "isSystem",
  (SELECT COUNT(*)::int FROM products p WHERE p.product_group = g.name) AS "productCount"
 FROM product_groups g ORDER BY g.sort_order ASC, g.name ASC`;

export const PRODUCT_GROUP_UPSERT_SQL = `INSERT INTO product_groups (id, code, name, behavior, sort_order, active, is_system)
 VALUES ($1, $2, $3, $4, $5, $6, $7)
 ON CONFLICT (id) DO UPDATE SET
   code = EXCLUDED.code,
   name = EXCLUDED.name,
   behavior = EXCLUDED.behavior,
   sort_order = EXCLUDED.sort_order,
   active = EXCLUDED.active,
   updated_at = CURRENT_TIMESTAMP;`;

export function productGroupUpsertParams(g: Record<string, any>): unknown[] {
  return [g.id, g.code, g.name, g.behavior, Number(g.sortOrder) || 100, Boolean(g.active), Boolean(g.isSystem)];
}

// A rename updates the referenced name; products.product_group carries a
// FOREIGN KEY ... ON UPDATE CASCADE, so every assigned product follows in the
// same transaction.
export const PRODUCT_GROUP_UPDATE_SQL = `UPDATE product_groups
 SET code = $1,
     name = $2,
     behavior = $3,
     sort_order = $4,
     active = $5,
     updated_at = CURRENT_TIMESTAMP
 WHERE id = $6;`;

export function productGroupUpdateParams(g: Record<string, any>, id: string): unknown[] {
  return [g.code, g.name, g.behavior, Number(g.sortOrder) || 100, Boolean(g.active), id];
}

export const PRODUCT_GROUP_DELETE_SQL = 'DELETE FROM product_groups WHERE id = $1;';

export const PRODUCT_GROUP_BY_NAME_SQL =
  'SELECT id, code, name, behavior, sort_order AS "sortOrder", active, is_system AS "isSystem" FROM product_groups WHERE name = $1';

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const CUSTOMER_SELECT_COLUMNS =
  'id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit"';

/**
 * VOL-4b: the directory's assigned-hardware count, computed from the CPE table
 * instead of the stored counter (which only device creation maintains). The
 * correlated subquery is one indexed lookup per page row, so the national
 * device table never enters the customer read.
 */
export const CUSTOMER_DEVICE_COUNT_SQL =
  '(SELECT COUNT(*)::int FROM customer_device_records d WHERE d.customer_code = customer_records.customer_id OR d.customer_id = customer_records.id)';

export const CUSTOMER_PAGE_SIZE_DEFAULT = 15;
export const CUSTOMER_PAGE_SIZE_MAX = 100;

/** Options shared by the list, aggregate and count queries. */
export interface CustomerListQueryOptions {
  /** A single branch id, or 'ALL'. Ignored when `branchScope` is present. */
  branchId?: unknown;
  /**
   * Explicit allowed-branch list resolved from the authenticated user. A
   * branch account's read is pinned to these, whatever the query string says:
   * the customer directory is national data, so scope is a server decision
   * (VOL-4a), exactly like the movement ledger and the transfer register.
   */
  branchScope?: string[];
  query?: unknown;
  /** 'ACTIVE' | 'INACTIVE'; anything else (including 'ALL') means no filter. */
  status?: unknown;
  page?: unknown;
  pageSize?: unknown;
  /** CSV export path: one envelope with every matching row. */
  all?: boolean;
}

/** Only the two statuses the directory offers are filters; never trust the query string. */
function customerStatus(status: unknown): 'ACTIVE' | 'INACTIVE' | undefined {
  const value = typeof status === 'string' ? status.trim().toUpperCase() : '';
  return value === 'ACTIVE' || value === 'INACTIVE' ? value : undefined;
}

/**
 * The exact expression `idx_customer_records_search_trgm` indexes (schema.sql).
 * Keep the two in lock-step: if this text changes, the index must be rebuilt,
 * or every picker keystroke falls back to a sequential scan of the directory.
 */
export const CUSTOMER_SEARCH_TEXT_SQL =
  "lower(COALESCE(customer_id, '') || ' ' || COALESCE(customer_name, '') || ' ' || " +
  "COALESCE(username, '') || ' ' || COALESCE(contact_number, '') || ' ' || " +
  "COALESCE(email, '') || ' ' || COALESCE(address, ''))";

/**
 * WHERE fragment for the customer directory: branch scope, a case-insensitive
 * search across the six searchable columns, and status. Shared by the paged
 * list and the aggregate query so a KPI can never disagree with the rows it
 * describes.
 */
export function buildCustomerListWhere(opts: CustomerListQueryOptions = {}): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (Array.isArray(opts.branchScope)) {
    if (opts.branchScope.length === 0) {
      // An account with no branch scope sees nothing; keep the SQL valid so the
      // caller still gets an empty result rather than an unfiltered read.
      conditions.push('FALSE');
    } else {
      params.push(opts.branchScope);
      conditions.push(`branch_id = ANY($${params.length})`);
    }
  } else if (opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conditions.push(`branch_id = $${params.length}`);
  }

  if (opts.query && typeof opts.query === 'string' && opts.query.trim()) {
    params.push(`%${opts.query.trim().toLowerCase()}%`);
    conditions.push(`${CUSTOMER_SEARCH_TEXT_SQL} LIKE $${params.length}`);
  }

  const status = customerStatus(opts.status);
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  return { whereSql: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params };
}

/** Clamped paging values, echoed back to the client so its footer can trust them. */
export function normalizeCustomerPaging(page?: unknown, pageSize?: unknown): { page: number; pageSize: number } {
  const requestedSize = Math.floor(Number(pageSize));
  const size = Number.isFinite(requestedSize) && requestedSize > 0
    ? Math.min(CUSTOMER_PAGE_SIZE_MAX, requestedSize)
    : CUSTOMER_PAGE_SIZE_DEFAULT;
  const requestedPage = Math.floor(Number(page));
  return { page: Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1, pageSize: size };
}

/**
 * Paged customer list. `all` skips LIMIT/OFFSET for the CSV export and reports
 * pageSize as 0 here; the caller replaces it with the row count.
 */
export function buildCustomerListQuery(opts: CustomerListQueryOptions = {}): { sql: string; params: unknown[]; page: number; pageSize: number } {
  const { whereSql, params } = buildCustomerListWhere(opts);
  const paging = normalizeCustomerPaging(opts.page, opts.pageSize);
  let sql = `SELECT ${CUSTOMER_SELECT_COLUMNS}, ${CUSTOMER_DEVICE_COUNT_SQL} AS "assignedDevicesCount" FROM customer_records${whereSql} ORDER BY customer_name ASC, customer_id ASC`;
  if (!opts.all) {
    sql += ` LIMIT ${paging.pageSize} OFFSET ${(paging.page - 1) * paging.pageSize}`;
  }
  return { sql, params, page: paging.page, pageSize: opts.all ? 0 : paging.pageSize };
}

/** One aggregate row for the directory KPIs under the same WHERE. */
export function buildCustomerListAggregateQuery(opts: CustomerListQueryOptions = {}): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildCustomerListWhere(opts);
  return {
    sql:
      'SELECT COUNT(*)::int AS count, ' +
      "COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active, " +
      'COALESCE(SUM(credit_limit), 0)::float AS credit ' +
      'FROM customer_records' + whereSql,
    params,
  };
}

export const CUSTOMER_UPSERT_SQL = `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
 ON CONFLICT (id) DO UPDATE SET
   customer_id = EXCLUDED.customer_id,
   customer_name = EXCLUDED.customer_name,
   username = EXCLUDED.username,
   contact_number = EXCLUDED.contact_number,
   branch_id = EXCLUDED.branch_id,
   address = EXCLUDED.address,
   email = EXCLUDED.email,
   status = EXCLUDED.status,
   credit_limit = EXCLUDED.credit_limit;`;

export function customerUpsertParams(c: Record<string, any>): unknown[] {
  return [
    c.id, c.customerId, c.customerName, c.username, c.contactNumber, c.branchId,
    c.address, c.email, c.status, c.creditLimit, c.assignedDevicesCount,
  ];
}

/** Customer master update (PUT): matches by id or customer_id with one value. */
export const CUSTOMER_UPDATE_BY_ID_OR_CODE_SQL = `UPDATE customer_records SET
   customer_id = $1, customer_name = $2, username = $3, contact_number = $4, branch_id = $5, address = $6, email = $7, status = $8, credit_limit = $9
 WHERE id = $10 OR customer_id = $10;`;

export function customerUpdateByIdOrCodeParams(c: Record<string, any>): unknown[] {
  return [
    c.customerId, c.customerName, c.username, c.contactNumber, c.branchId,
    c.address, c.email, c.status, Number(c.creditLimit) || 0,
  ];
}

/** Customer delete matches both id and customer_id with a single parameter. */
export const CUSTOMER_DELETE_BY_ID_OR_CODE_SQL =
  'DELETE FROM customer_records WHERE id = $1 OR customer_id = $1';




