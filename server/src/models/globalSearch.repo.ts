/**
 * TRIM-1 — bounded global-search queries.
 *
 * The quick-search modal used to receive whole bootstrap slices and filter them
 * in the browser. That is bounded only by how much data the install happens to
 * have; a nationwide install (12k+ customers, thousands of documents per year)
 * must never ship those arrays to the client for a keystroke.
 *
 * Rules:
 *  - one query per result group, each with a hard LIMIT (the caller passes it);
 *  - branch and fiscal year are SQL predicates, not post-filters;
 *  - every substring predicate is backed by a trigram index:
 *      • documents use the B2 `search_text` projection (already GIN-indexed);
 *      • products / assets / devices / shipments use the expression indexes
 *        added in §TRIM-1 of scripts/schema.sql, and the query repeats that
 *        exact expression so PostgreSQL can use them.
 *  - user wildcards are escaped (`%`, `_`) so a query cannot turn into a scan.
 */
import type {
  GlobalSearchAsset,
  GlobalSearchDevice,
  GlobalSearchInvoice,
  GlobalSearchOrder,
  GlobalSearchProduct,
  GlobalSearchResults,
  GlobalSearchShipment,
} from '../../../client/src/types';

export interface GlobalSearchScope {
  /** `%lowercased-and-escaped%`, ready for LIKE ... ESCAPE '\'. */
  pattern: string;
  /** null = every branch (only SUPER_ADMIN / HEAD_OFFICE_ADMIN reach this). */
  branchId: string | null;
  /** null = no fiscal-year predicate. */
  fiscalYearId: string | null;
  /** Hard cap per group. */
  limit: number;
}

/** Escapes LIKE metacharacters and lower-cases, so the pattern matches the indexes. */
export function globalSearchPattern(query: string): string {
  const escaped = query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/**
 * Products: the expression below is identical to
 * `idx_products_global_trgm` in scripts/schema.sql. `stockQty` is summed
 * server-side so the modal does not need the stock slice.
 */
export const PRODUCT_SEARCH_SQL = `SELECT p.id, p.name, p.sku, p.barcode, p.category, p.unit,
       p.selling_price AS "sellingPrice", p.min_reorder_level AS "minReorderLevel",
       COALESCE(st.qty, 0)::int AS "stockQty"
  FROM products p
  LEFT JOIN (
    SELECT product_id, SUM(quantity_on_hand)::int AS qty
      FROM inventory_stock
     WHERE ($2::text IS NULL OR branch_id = $2)
     GROUP BY product_id
  ) st ON st.product_id = p.id
 WHERE lower(COALESCE(p.name, '') || ' ' || COALESCE(p.sku, '') || ' ' ||
             COALESCE(p.barcode, '') || ' ' || COALESCE(p.category, '')) LIKE $1 ESCAPE '\\'
 ORDER BY (lower(p.name) = $3) DESC, p.name ASC
 LIMIT $4`;

export const PURCHASE_ORDER_SEARCH_SQL = `SELECT id, po_number AS "poNumber", supplier_name AS "supplierName",
       status, total_amount AS "totalAmount", order_date_bs AS "orderDateBS"
  FROM purchase_orders
 WHERE search_text LIKE $1 ESCAPE '\\'
   AND ($2::text IS NULL OR branch_id = $2)
   AND ($3::text IS NULL OR fiscal_year_id = $3 OR fiscal_year_id IS NULL)
 ORDER BY order_date_ad DESC
 LIMIT $4`;

export const PURCHASE_INVOICE_SEARCH_SQL = `SELECT id, invoice_number AS "invoiceNumber", vendor_bill_number AS "vendorBillNumber",
       supplier_name AS "supplierName", grand_total AS "grandTotal", payment_status AS "paymentStatus"
  FROM purchase_invoices
 WHERE search_text LIKE $1 ESCAPE '\\'
   AND ($2::text IS NULL OR branch_id = $2)
   AND ($3::text IS NULL OR fiscal_year_id = $3 OR fiscal_year_id IS NULL)
 ORDER BY invoice_date_ad DESC
 LIMIT $4`;

/** Matches `idx_shipments_global_trgm`; a shipment is visible from either end. */
export const SHIPMENT_SEARCH_SQL = `SELECT id, tracking_code AS "trackingCode",
       source_branch_name AS "sourceBranchName",
       destination_branch_name AS "destinationBranchName",
       status, COALESCE(jsonb_array_length(items), 0)::int AS "itemCount"
  FROM shipments
 WHERE lower(COALESCE(tracking_code, '') || ' ' || COALESCE(source_branch_name, '') || ' ' ||
             COALESCE(destination_branch_name, '') || ' ' || COALESCE(status, '')) LIKE $1 ESCAPE '\\'
   AND ($2::text IS NULL OR source_branch_id = $2 OR destination_branch_id = $2)
   AND ($3::text IS NULL OR fiscal_year_id = $3 OR fiscal_year_id IS NULL)
 ORDER BY dispatch_date_ad DESC
 LIMIT $4`;

/** Matches `idx_assets_global_trgm`. */
export const ASSET_SEARCH_SQL = `SELECT id, tag_number AS "tagNumber", name, category,
       acquisition_cost AS "acquisitionCost", status
  FROM fixed_assets
 WHERE lower(COALESCE(tag_number, '') || ' ' || COALESCE(name, '') || ' ' ||
             COALESCE(category, '') || ' ' || COALESCE(assigned_customer_name, '') || ' ' ||
             COALESCE(invoice_no, '') || ' ' || COALESCE(supplier_name, '')) LIKE $1 ESCAPE '\\'
   AND ($2::text IS NULL OR branch_id = $2)
   AND ($3::text IS NULL OR fiscal_year_id = $3 OR fiscal_year_id IS NULL)
 ORDER BY tag_number ASC
 LIMIT $4`;

/** Matches `idx_customer_devices_global_trgm` — the group that grows with every installation. */
export const DEVICE_SEARCH_SQL = `SELECT id, customer_code AS "customerCode", customer_name AS "customerName",
       product_name AS "productName", device_serial AS "deviceSerial", status
  FROM customer_device_records
 WHERE lower(COALESCE(customer_code, '') || ' ' || COALESCE(customer_name, '') || ' ' ||
             COALESCE(product_name, '') || ' ' || COALESCE(device_serial, '') || ' ' ||
             COALESCE(pon_serial, '') || ' ' || COALESCE(mac_address, '') || ' ' ||
             COALESCE(contact_phone, '')) LIKE $1 ESCAPE '\\'
   AND ($2::text IS NULL OR branch_id = $2)
   AND ($3::text IS NULL OR fiscal_year_id = $3 OR fiscal_year_id IS NULL)
 ORDER BY customer_name ASC
 LIMIT $4`;

export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

/**
 * Runs the six bounded reads. They are independent, so they go out together;
 * each is LIMIT-capped and index-backed, keeping the work per keystroke flat as
 * the data grows.
 */
export async function searchGlobalInDb(
  db: Queryable,
  scope: GlobalSearchScope
): Promise<GlobalSearchResults> {
  const common = [scope.pattern, scope.branchId, scope.fiscalYearId, scope.limit];
  const productParams = [scope.pattern, scope.branchId, scope.pattern.slice(1, -1), scope.limit];

  const [products, orders, invoices, shipments, assets, devices] = await Promise.all([
    db.query(PRODUCT_SEARCH_SQL, productParams),
    db.query(PURCHASE_ORDER_SEARCH_SQL, common),
    db.query(PURCHASE_INVOICE_SEARCH_SQL, common),
    db.query(SHIPMENT_SEARCH_SQL, common),
    db.query(ASSET_SEARCH_SQL, common),
    db.query(DEVICE_SEARCH_SQL, common),
  ]);

  return {
    products: products.rows as GlobalSearchProduct[],
    purchaseOrders: orders.rows as GlobalSearchOrder[],
    invoices: invoices.rows as GlobalSearchInvoice[],
    shipments: shipments.rows as GlobalSearchShipment[],
    assets: assets.rows as GlobalSearchAsset[],
    customerDevices: devices.rows as GlobalSearchDevice[],
  };
}
