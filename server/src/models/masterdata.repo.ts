/**
 * Repository for the masterdata domain — every SQL string and param-list
 * builder for UoM, locations, suppliers, products, categories, and customers
 * lives here, following the same pattern as ./bootstrap.repo.ts.
 *
 * masterdata.controller.ts keeps only HTTP concerns (request shaping, cache
 * updates, audit logging, response bodies); query text and column lists are
 * defined once in this layer.
 */
import type { QueryResult } from 'pg';

/** Minimal query interface satisfied by the pg Pool (and test doubles). */
export interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<QueryResult<any>>;
}

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

export function updateUomParams(u: { name: string; symbol: string; type: string; isBaseUnit: boolean }, id: string): unknown[] {
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

export const LOCATION_UPDATE_SQL = `UPDATE locations SET
   name = $1, type = $2, branch_id = $3, address = $4, coordinates = $5, contact_person = $6, contact_phone = $7, notes = $8, active_assets_count = $9
 WHERE id = $10;`;

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
  'SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products ORDER BY created_at DESC';

export const PRODUCT_UPSERT_SQL = `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, status)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
 ON CONFLICT (id) DO UPDATE SET
   sku = EXCLUDED.sku,
   name = EXCLUDED.name,
   category = EXCLUDED.category,
   selling_price = EXCLUDED.selling_price;`;

export function productUpsertParams(p: Record<string, any>): unknown[] {
  return [
    p.id, p.sku, p.barcode, p.name, p.category, p.productGroup, p.unit,
    p.costPrice, p.sellingPrice, p.taxRate, p.minReorderLevel,
    p.requiresSerialTracking, p.trackingType, p.description, p.status,
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
   status = $14
 WHERE id = $15;`;

export function productUpdateParams(p: Record<string, any>, id: string): unknown[] {
  return [
    p.sku,
    p.barcode || '',
    p.name,
    p.category,
    p.productGroup || 'Product Item',
    p.unit || 'Pcs',
    Number(p.costPrice) || 0,
    Number(p.sellingPrice) || 0,
    Number(p.taxRate) || 13,
    Number(p.minReorderLevel) || 5,
    Boolean(p.requiresSerialTracking),
    p.trackingType || 'QUANTITY_ONLY',
    p.description || '',
    p.status || 'ACTIVE',
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
// Customers
// ---------------------------------------------------------------------------

export const CUSTOMER_SELECT_COLUMNS =
  'id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount"';

/**
 * Builds the customer list query with optional branch filter and a case-
 * insensitive search across the six searchable columns. Mirrors the inline
 * SQL assembled in the controller verbatim.
 */
export function buildCustomerListQuery(branchId?: unknown, query?: unknown): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];
  let sql = `SELECT ${CUSTOMER_SELECT_COLUMNS} FROM customer_records`;

  if (branchId && branchId !== 'ALL') {
    params.push(branchId);
    conditions.push(`branch_id = $${params.length}`);
  }

  if (query && typeof query === 'string' && query.trim()) {
    params.push(`%${query.trim().toLowerCase()}%`);
    conditions.push(`(LOWER(customer_id) LIKE $${params.length} OR LOWER(customer_name) LIKE $${params.length} OR LOWER(username) LIKE $${params.length} OR LOWER(contact_number) LIKE $${params.length} OR LOWER(email) LIKE $${params.length} OR LOWER(address) LIKE $${params.length})`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY customer_name ASC';
  return { sql, params };
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




