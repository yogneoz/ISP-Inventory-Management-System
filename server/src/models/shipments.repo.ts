/**
 * Repository for the shipments domain — every SQL string and param-list
 * builder for inter-branch transfers lives here, following the same pattern
 * as ./procurement.repo.ts.
 *
 * shipments.controller.ts keeps only HTTP concerns (request shaping, cache
 * updates, audit logging, response bodies); query text and column lists are
 * defined once in this layer.
 */

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const SHIPMENT_SELECT_COLUMNS =
  'id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS", estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAD", received_date_bs AS "receivedDateBS", has_discrepancy AS "hasDiscrepancy"';

/**
 * List/page scope for the shipment register, the receive lanes and the FY
 * closing wizard. No options keeps the register's original all-rows query.
 *
 * Branch scope is expressed as an explicit allowed list when the caller is
 * branch-bound (`branchScope`), so the SQL — not a post-read JS filter — is
 * what keeps a branch account inside its own branches. `branchId` is the
 * header/global selection (either end of the transfer).
 */
export interface ShipmentListOptions {
  /** A single branch id or 'ALL'; ignored when `branchScope` is present. */
  branchId?: unknown;
  /** Explicit allowed-branch list resolved from the authenticated user. */
  branchScope?: string[];
  dateFromAD?: unknown;
  dateToAD?: unknown;
  /** One status, a comma list, or an array; 'ALL'/'' is ignored. */
  status?: unknown;
  /** Register direction relative to the scoped branch (CREATED = source end). */
  direction?: unknown;
  /** Free text over tracking code, branch names and item lines. */
  search?: unknown;
  /** Restrict to these destination branches (warehouse receiving lane). */
  destinationBranchIds?: unknown;
  /** Only rows still in flight (not RECEIVED/DELIVERED/CANCELLED). */
  pendingOnly?: boolean;
  /** When set, orders by (created_at, id) so a page boundary is stable. */
  pageSize?: number;
  offset?: number;
  /** Legacy-array row cap. Ignored when pageSize is set. */
  limit?: number;
}

/** Escapes a LIKE/ILIKE term so '%' and '_' match themselves. */
export function escapeShipmentSearch(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** REST-safe status list: uppercase ids, 'ALL' dropped, duplicates removed. */
export function normalizeShipmentStatuses(status: unknown): string[] {
  const raw = Array.isArray(status)
    ? status
    : typeof status === 'string'
    ? status.split(',')
    : [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = String(entry || '').trim().toUpperCase();
    if (!value || value === 'ALL') continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function buildShipmentWhere(opts: ShipmentListOptions): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (Array.isArray(opts.branchScope)) {
    if (opts.branchScope.length === 0) {
      // An account with no branch scope sees nothing; keep the SQL valid so
      // the caller still gets an empty result instead of an unfiltered read.
      conds.push('FALSE');
    } else {
      params.push(opts.branchScope);
      conds.push(`(source_branch_id = ANY($${params.length}) OR destination_branch_id = ANY($${params.length}))`);
    }
  } else if (typeof opts.branchId === 'string' && opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conds.push(`(source_branch_id = $${params.length} OR destination_branch_id = $${params.length})`);
  }
  if (typeof opts.dateFromAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateFromAD)) {
    params.push(opts.dateFromAD);
    conds.push(`dispatch_date_ad >= $${params.length}::date`);
  }
  if (typeof opts.dateToAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateToAD)) {
    params.push(opts.dateToAD);
    conds.push(`dispatch_date_ad <= $${params.length}::date`);
  }
  const statuses = normalizeShipmentStatuses(opts.status);
  if (statuses.length > 0) {
    params.push(statuses);
    conds.push(`status = ANY($${params.length})`);
  }
  if (opts.pendingOnly) {
    conds.push(`status NOT IN ('RECEIVED', 'DELIVERED', 'CANCELLED')`);
  }
  if (Array.isArray(opts.destinationBranchIds) && opts.destinationBranchIds.length > 0) {
    params.push(opts.destinationBranchIds);
    conds.push(`destination_branch_id = ANY($${params.length})`);
  }
  const direction = typeof opts.direction === 'string' ? opts.direction.trim().toUpperCase() : '';
  if (direction === 'CREATED' || direction === 'RECEIVED') {
    const requested =
      !Array.isArray(opts.branchScope) && typeof opts.branchId === 'string' && opts.branchId && opts.branchId !== 'ALL'
        ? opts.branchId
        : Array.isArray(opts.branchScope) && opts.branchScope.length === 1
        ? opts.branchScope[0]
        : '';
    const column = direction === 'CREATED' ? 'source_branch_id' : 'destination_branch_id';
    if (requested) {
      params.push(requested);
      conds.push(`${column} = $${params.length}`);
    } else {
      conds.push(`${column} IS NOT NULL`);
    }
  }
  const term = typeof opts.search === 'string' ? opts.search.trim() : '';
  if (term) {
    params.push(`%${escapeShipmentSearch(term)}%`);
    conds.push(
      `(tracking_code ILIKE $${params.length} ESCAPE '\\'` +
        ` OR COALESCE(source_branch_name, '') ILIKE $${params.length} ESCAPE '\\'` +
        ` OR COALESCE(destination_branch_name, '') ILIKE $${params.length} ESCAPE '\\'` +
        ` OR COALESCE(items::text, '') ILIKE $${params.length} ESCAPE '\\')`
    );
  }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
}

export function buildShipmentListSql(opts: ShipmentListOptions = {}): { sql: string; params: unknown[] } {
  const { where, params } = buildShipmentWhere(opts);
  const paged = Number(opts.pageSize) > 0;
  // A stable tiebreaker only when paging: two rows created in the same
  // millisecond must not slide across a page boundary between requests.
  let sql = `SELECT ${SHIPMENT_SELECT_COLUMNS} FROM shipments${where} ORDER BY created_at DESC${paged ? ', id DESC' : ''}`;
  if (paged) {
    params.push(Math.min(500, Math.max(1, Number(opts.pageSize))));
    sql += ` LIMIT $${params.length}`;
    const offset = Math.max(0, Number(opts.offset) || 0);
    if (offset > 0) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
  } else if (Number(opts.limit) > 0) {
    params.push(Math.min(5000, Math.max(1, Number(opts.limit))));
    sql += ` LIMIT $${params.length}`;
  }
  return { sql, params };
}

/** Total rows matching the same filters a page was read with. */
export function buildShipmentCountSql(opts: ShipmentListOptions = {}): { sql: string; params: unknown[] } {
  const { where, params } = buildShipmentWhere(opts);
  return { sql: `SELECT count(*)::int AS count FROM shipments${where}`, params };
}

/** Status histogram for the dashboard/KPI cards and the receive-tab badges. */
export function buildShipmentSummarySql(opts: ShipmentListOptions = {}): { sql: string; params: unknown[] } {
  const { where, params } = buildShipmentWhere(opts);
  return {
    sql: `SELECT status, count(*)::int AS count FROM shipments${where} GROUP BY status`,
    params,
  };
}

/**
 * Mirror (PG-down demo) twin of the SQL filters, so demo mode and PostgreSQL
 * answer the same query identically. Ordering matches buildShipmentListSql.
 */
export function filterShipmentsMirror(rows: readonly any[], opts: ShipmentListOptions = {}): any[] {
  const scope = Array.isArray(opts.branchScope) ? new Set(opts.branchScope) : null;
  const branchId = !scope && typeof opts.branchId === 'string' && opts.branchId !== 'ALL' ? opts.branchId : '';
  const from = typeof opts.dateFromAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateFromAD) ? opts.dateFromAD : '';
  const to = typeof opts.dateToAD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateToAD) ? opts.dateToAD : '';
  const statuses = new Set(normalizeShipmentStatuses(opts.status));
  const destinations = Array.isArray(opts.destinationBranchIds) ? new Set(opts.destinationBranchIds) : null;
  const direction = typeof opts.direction === 'string' ? opts.direction.trim().toUpperCase() : '';
  const requested =
    branchId || (Array.isArray(opts.branchScope) && opts.branchScope.length === 1 ? opts.branchScope[0] : '');
  const term = typeof opts.search === 'string' ? opts.search.trim().toLowerCase() : '';

  const filtered = rows.filter((row) => {
    const source = String(row?.sourceBranchId ?? row?.source_branch_id ?? '');
    const destination = String(row?.destinationBranchId ?? row?.destination_branch_id ?? '');
    if (scope) {
      if (scope.size === 0) return false;
      if (!scope.has(source) && !scope.has(destination)) return false;
    } else if (branchId && source !== branchId && destination !== branchId) {
      return false;
    }
    const date = String(row?.dispatchDateAD ?? row?.dispatch_date_ad ?? '').slice(0, 10);
    if (from && date < from) return false;
    if (to && date > to) return false;
    const status = String(row?.status || '').toUpperCase();
    if (statuses.size > 0 && !statuses.has(status)) return false;
    if (opts.pendingOnly && ['RECEIVED', 'DELIVERED', 'CANCELLED'].includes(status)) return false;
    if (destinations && !destinations.has(destination)) return false;
    if (direction === 'CREATED' && (requested ? source !== requested : !source)) return false;
    if (direction === 'RECEIVED' && (requested ? destination !== requested : !destination)) return false;
    if (term) {
      const haystack = [
        row?.trackingCode,
        row?.sourceBranchName,
        row?.destinationBranchName,
        JSON.stringify(row?.items || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });

  return filtered.sort((a, b) => {
    const createdCmp = String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
    if (createdCmp !== 0) return createdCmp;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  });
}

export const SHIPMENT_LIST_SQL = buildShipmentListSql().sql;

// Create-time id/tracking-code collision scope check: returns the branches the
// existing shipment touches so the caller's branch scope can be compared
// before any overwrite (VULN-003).
export const SHIPMENT_FIND_FOR_OVERWRITE_SQL =
  'SELECT id, source_branch_id AS "sourceBranchId", destination_branch_id AS "destinationBranchId" FROM shipments WHERE id = $1 OR tracking_code = $2 LIMIT 1';

/**
 * Full single-shipment lookup (no lock) for receive/cancel/approval
 * pre-checks. PostgreSQL is the only decision source when connected; the
 * mirror is consulted only in PG-down demo mode (bootstrap-trim step 5).
 */
export const SHIPMENT_FIND_ONE_SQL = `SELECT ${SHIPMENT_SELECT_COLUMNS} FROM shipments WHERE id = $1 OR tracking_code = $1 LIMIT 1`;

/**
 * Resolves a shipment from a mixed candidate list (row id, stored tracking
 * code, repacked/upper-cased code) in one query so approval reversal never
 * scans the mirror while PostgreSQL is connected.
 */
export const SHIPMENT_FIND_CANDIDATES_SQL = `SELECT ${SHIPMENT_SELECT_COLUMNS} FROM shipments
 WHERE id = ANY($1::text[]) OR UPPER(tracking_code) = ANY($2::text[])
 LIMIT 1`;

// ---------------------------------------------------------------------------
// Create (dispatch)
// ---------------------------------------------------------------------------

export const SHIPMENT_UPSERT_SQL = `INSERT INTO shipments (
   id, tracking_code, type, source_branch_id, source_branch_name, destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, estimated_arrival_ad, status, notes, items
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
 ON CONFLICT (id) DO UPDATE SET
   status = EXCLUDED.status,
   items = EXCLUDED.items;`;

export function shipmentUpsertParams(sh: Record<string, any>): unknown[] {
  return [
    sh.id,
    sh.trackingCode,
    sh.type || 'INTER_BRANCH',
    sh.sourceBranchId,
    sh.sourceBranchName,
    sh.destinationBranchId,
    sh.destinationBranchName,
    sh.dispatchDateAD,
    sh.dispatchDateBS,
    sh.estimatedArrivalAD || sh.estimatedArrivalAd || null,
    sh.status,
    sh.notes || '',
    JSON.stringify(sh.items),
  ];
}

/**
 * Default quantity shipped per item when neither quantitySent nor quantity is
 * set — preserved verbatim from the controller (`|| 1`).
 */
export function shipmentQtySent(item: Record<string, any>): number {
  return Number(item.quantitySent || item.quantity || 1);
}

/**
 * Locks one product/branch stock row so a transfer can record the TRUE
 * quantity_before / quantity_after in the movement ledger inside the same
 * transaction as the stock mutation (TRANSFER_OUT / TRANSFER_IN /
 * TRANSFER_CANCELLED / TRANSFER_RECEIPT_CANCELLED rows).
 */
export const SHIPMENT_STOCK_LOCK_SQL =
  'SELECT quantity_on_hand AS "quantityOnHand", incoming_qty AS "incomingQty" FROM inventory_stock WHERE product_id = $1 AND branch_id = $2 FOR UPDATE';

/** Deducts shipped quantity from the source branch, guarding on stock level. */
export const SHIPMENT_DEDUCT_SOURCE_SQL = `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`;

/** Reserves incoming stock at the destination branch for a dispatched item. */
export const SHIPMENT_INCOMING_DEST_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
 VALUES ($1, $2, $3, 0, $4)
 ON CONFLICT (product_id, branch_id) DO UPDATE SET
   incoming_qty = inventory_stock.incoming_qty + $4,
   last_updated = CURRENT_TIMESTAMP;`;

export function shipmentIncomingDestParams(destBranchId: string, item: Record<string, any>): unknown[] {
  return [`stk-${destBranchId.toLowerCase()}-${item.productId}`, item.productId, destBranchId, shipmentQtySent(item)];
}

// ---------------------------------------------------------------------------
// Serial register transitions (Slice E of the serial-input plan)
// ---------------------------------------------------------------------------

/**
 * Moves one dispatched unit's register row to its new status/branch and
 * appends the lifecycle history entry. Device serial is the key (the same
 * case/trim key `uq_serial_log_device_serial` enforces), and the optional
 * status predicate makes each leg race-safe: a unit that has since moved
 * updates 0 rows instead of being silently re-stamped.
 */
/**
 * Status-guarded flip: only a row in `$7` moves, so a unit that has since
 * changed state updates 0 rows instead of being silently re-stamped.
 */
export const SERIAL_LOG_TRANSFER_FLIP_SQL = `UPDATE serial_log
 SET status = $1,
     branch_id = COALESCE($2, branch_id),
     history_json = (COALESCE(NULLIF(history_json, ''), '[]')::jsonb || $3::jsonb)::text,
     source_type = $4,
     source_id = $5,
     updated_at = CURRENT_TIMESTAMP
 WHERE lower(trim(device_serial)) = lower(trim($6))
   AND status = $7`;

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

export const SHIPMENT_RECEIVE_UPDATE_SQL =
  'UPDATE shipments SET status = $1, received_by_notes = $2, received_date_ad = CURRENT_DATE, received_date_bs = $3, has_discrepancy = $4, items = $5 WHERE id = $6';

/** Settles incoming stock into on-hand at the destination branch. */
export const SHIPMENT_RECEIVE_STOCK_SQL = `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty)
 VALUES ($1, $2, $3, $4, 0)
 ON CONFLICT (product_id, branch_id) DO UPDATE SET
   incoming_qty = GREATEST(0, inventory_stock.incoming_qty - $4),
   quantity_on_hand = inventory_stock.quantity_on_hand + $4,
   last_updated = CURRENT_TIMESTAMP;`;

export function shipmentReceiveStockParams(destBranchId: string, item: Record<string, any>): unknown[] {
  // quantityReceived = 0 must stay 0 (full-loss receipt); only fall back when
  // the field is nullish or non-numeric.
  const received = item.quantityReceived;
  const qty =
    received !== undefined && received !== null && received !== '' && !Number.isNaN(Number(received))
      ? Number(received)
      : Number(item.quantitySent) || 1;
  return [`stk-${destBranchId.toLowerCase()}-${item.productId}`, item.productId, destBranchId, qty];
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/** Locks the shipment row and reads the fields needed to reverse its stock. */
export const SHIPMENT_FIND_FOR_CANCEL_SQL =
  'SELECT status, source_branch_id AS "sourceBranchId", destination_branch_id AS "destinationBranchId", items, notes FROM shipments WHERE id = $1 OR tracking_code = $1 FOR UPDATE';

export const SHIPMENT_CANCEL_SQL =
  'UPDATE shipments SET status = $1, notes = $2 WHERE id = $3 OR tracking_code = $3';

/** Returns shipped quantity to the source branch on cancellation. */
export const SHIPMENT_CANCEL_RESTORE_SOURCE_SQL =
  'UPDATE inventory_stock SET quantity_on_hand = inventory_stock.quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;';

/** Releases reserved incoming stock at the destination on cancellation. */
export const SHIPMENT_CANCEL_RELEASE_DEST_SQL =
  'UPDATE inventory_stock SET incoming_qty = GREATEST(0, incoming_qty - $1), last_updated = CURRENT_TIMESTAMP WHERE product_id = $2 AND branch_id = $3;';


// ---------------------------------------------------------------------------
// Undo receive (cancel a received transfer → back to In-Transit)
// ---------------------------------------------------------------------------

/** Status-guarded IN_STOCK→IN_TRANSIT flip used by the undo-receive leg. */
export const SERIAL_LOG_UNDO_RECEIVE_FLIP_SQL = SERIAL_LOG_TRANSFER_FLIP_SQL;

/** Param list for SERIAL_LOG_TRANSFER_FLIP_SQL (device serial is the key). */
export function serialLogTransferFlipParams(
  status: string,
  branchId: string | null,
  history: unknown,
  sourceId: string,
  deviceSerial: string,
  fromStatus: string
): unknown[] {
  return [status, branchId, JSON.stringify(history), 'SHIPMENT', sourceId, deviceSerial, fromStatus];
}


/** Quantity settled by the receive for one item line (falls back to sent). */
export function shipmentReceivedQty(item: Record<string, any>): number {
  const received = item.quantityReceived;
  return received !== undefined && received !== null && received !== '' && !Number.isNaN(Number(received))
    ? Number(received)
    : shipmentQtySent(item);
}

/**
 * Reverses the receive settlement at the destination branch: on-hand down by
 * the received quantity and the in-transit reservation restored. Guards on
 * available stock so an undo can never overdraw the destination branch.
 */
export const SHIPMENT_UNDO_RECEIVE_STOCK_SQL = `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - $1, incoming_qty = incoming_qty + $1, last_updated = CURRENT_TIMESTAMP
 WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1;`;

/** Reverts the shipment row to In-Transit and clears the receive bookkeeping. */
export const SHIPMENT_UNDO_RECEIVE_UPDATE_SQL =
  "UPDATE shipments SET status = 'IN_TRANSIT', received_by_notes = NULL, received_date_ad = NULL, received_date_bs = NULL, has_discrepancy = FALSE, notes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 OR tracking_code = $1";
