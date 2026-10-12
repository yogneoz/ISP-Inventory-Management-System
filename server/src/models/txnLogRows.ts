/**
 * In-memory movement-ledger row builders for DEMO MODE (PostgreSQL down).
 *
 * The PG paths write transaction_logs rows through the param builders in
 * sales.repo.ts / procurement.repo.ts; when the database is unreachable those
 * queries never run, so the finance module's creates/cancels used to leave the
 * movement ledger empty even though stock moved (audit gap: "demo-mode
 * invoice/return creates don't write ledger rows"). These builders produce the
 * SAME row shapes — same change types, sign conventions, and reference docs —
 * as plain TransactionLog objects that get prepended to the in-memory
 * `transactionLogs` mirror, so the register and the stock matrix read
 * consistently with or without the database.
 *
 * The balances here are the TRUE before/after taken from the in-memory
 * inventoryStock mirror as it moves (same contract the PG paths get from the
 * guarded UPDATE ... RETURNING); when no stock row exists they degrade to the
 * changed-value convention the old placeholder rows used.
 */
import type { TransactionLog } from '../../../client/src/types';

/** Random transaction number shared by every builder (TXN-#####). */
function txnNumber(): string {
  return `TXN-${Math.floor(10000 + Math.random() * 90000)}`;
}

export interface DemoTxnBase {
  productId: string;
  productSku?: string;
  productName?: string;
  branchId: string;
  quantityBefore: number;
  quantityChanged: number;
  unitCost: number;
  referenceDocId?: string;
  timestampAD: string;
  timestampBS: string;
}

/** Generic row from a change descriptor; after is derived unless given. */
function row(
  id: string,
  changeType: TransactionLog['changeType'],
  base: DemoTxnBase,
  afterOverride?: number
): TransactionLog {
  const before = Math.max(0, Number(base.quantityBefore) || 0);
  const changed = Number(base.quantityChanged) || 0;
  return {
    id,
    transactionNumber: txnNumber(),
    productId: base.productId,
    productSku: base.productSku || '',
    productName: base.productName || 'Product',
    branchId: base.branchId,
    changeType,
    quantityBefore: before,
    quantityChanged: changed,
    quantityAfter: Number.isFinite(afterOverride) ? Math.max(0, afterOverride as number) : Math.max(0, before + changed),
    unitCost: Number(base.unitCost) || 0,
    referenceDocId: base.referenceDocId,
    timestampAD: base.timestampAD,
    timestampBS: base.timestampBS,
  };
}

/** PURCHASE_INVOICE receive row (+qty). Mirrors piTxnLogParams. */
export function demoPurchaseInvoiceTxn(itemIndex: number, base: DemoTxnBase): TransactionLog {
  return row(`txn-${Date.now()}-${base.productId}-pi-${itemIndex}`, 'PURCHASE_INVOICE', base);
}

/** SALES_INVOICE row (−qty). Mirrors siTxnLogParams. */
export function demoSalesInvoiceTxn(itemIndex: number, base: DemoTxnBase): TransactionLog {
  return row(`txn-${Date.now()}-${base.productId}-si-${itemIndex}`, 'SALES_INVOICE', base);
}

/** SALES_RETURN restock row (+qty). Mirrors srTxnLogParams. */
export function demoSalesReturnTxn(itemIndex: number, base: DemoTxnBase): TransactionLog {
  return row(`txn-${Date.now()}-${base.productId}-sr-${itemIndex}`, 'SALES_RETURN', base);
}

/** SALES_RETURN_CANCELLED compensating row (−qty). Mirrors srCancelTxnLogParams. */
export function demoSalesReturnCancelTxn(itemIndex: number, base: DemoTxnBase): TransactionLog {
  return row(`txn-${Date.now()}-${base.productId}-src-${itemIndex}`, 'SALES_RETURN_CANCELLED', base);
}

/** PURCHASE_RETURN row (−qty). Mirrors prTxnLogParams. */
export function demoPurchaseReturnTxn(itemIndex: number, base: DemoTxnBase): TransactionLog {
  return row(`txn-${Date.now()}-${base.productId}-pr-${itemIndex}`, 'PURCHASE_RETURN', base);
}

/** PURCHASE_RETURN_CANCELLED compensating row (+qty). Mirrors prCancelTxnLogParams. */
export function demoPurchaseReturnCancelTxn(itemIndex: number, base: DemoTxnBase): TransactionLog {
  return row(`txn-${Date.now()}-${base.productId}-prc-${itemIndex}`, 'PURCHASE_RETURN_CANCELLED', base);
}

/**
 * Finds the in-memory stock row for (product, branch), creating an empty one
 * when absent — the same default shape the purchase-invoice demo path uses.
 * Returns the row plus the QOH before any movement in the current pass.
 */
export function findOrCreateDemoStock(
  stockList: readonly any[],
  append: (rows: readonly any[]) => void,
  productId: string,
  branchId: string
): { stock: any; before: number } {
  let stock = stockList.find((s) => s.productId === productId && s.branchId === branchId);
  if (!stock) {
    stock = {
      id: `stk-${branchId.toLowerCase()}-${productId}`,
      productId,
      branchId,
      quantityOnHand: 0,
      damagedQty: 0,
      reservedQty: 0,
      incomingQty: 0,
      minReorderLevel: 5,
      lastUpdated: new Date().toISOString(),
    };
    append([...stockList, stock]);
  }
  return { stock, before: Number(stock.quantityOnHand) || 0 };
}

// ---------------------------------------------------------------------------
// Movement-ledger balance reconstruction (backfill)
// ---------------------------------------------------------------------------

/**
 * Historical `transaction_logs` rows were written with placeholder balances
 * (quantity_before = 0, quantity_after = |quantity_changed|), so the Stock
 * Movement Ledger rendered a fake "Qty Before" of 0 for every legacy row. The
 * audit once called these "unrecomputable" — they are not: quantity_changed is
 * a faithful signed delta for every row (DAMAGE subtracts quantity_on_hand
 * while growing the damaged pool; DISPOSAL carries the damaged-pool delta;
 * MANUAL_ADJUSTMENT applies its signed quantity verbatim), so the true
 * before/after are recoverable by replaying the deltas per (product, branch)
 * in chronological order.
 *
 * The replay maintains two running balances per key — the usable pool
 * (quantity_on_hand) and the damaged pool — and attributes each row to the
 * pool its change_type moves, so before + changed = after holds *within* the
 * pool the row actually touched. It is idempotent and total: it never reads
 * the stored (placeholder) balances, so replaying an already-correct ledger
 * reproduces the same values, and it never mutates the input rows.
 */

/** Rows the replay consumes: only identity, sign, delta, and pool routing. */
export interface LedgerReplayRow {
  id: string;
  productId: string | null;
  branchId: string | null;
  changeType: string;
  quantityChanged: number;
  timestampAD: string | Date;
}

export interface LedgerBalanceUpdate {
  id: string;
  quantityBefore: number;
  quantityAfter: number;
}

export interface LedgerReplayResult {
  updates: LedgerBalanceUpdate[];
  /** Rows skipped because they carry no product/branch to group under. */
  skipped: number;
  /** (productId:branchId) groups that had at least one row replayed. */
  groups: number;
}

/**
 * change_types whose quantity_changed moves the DAMAGED pool rather than
 * quantity_on_hand. DISPOSAL is the ONLY such type: post_stockOperations
 * writes its before/after from the damaged pool (quantity_on_hand never held
 * those units). DAMAGE rows are negative quantity_on_hand deltas (they
 * consume QOH while growing the damaged pool) and DAMAGE_REVERSED /
 * PHYSICAL_AUDIT_* carry the QOH record's before — all QOH semantics. Every
 * type not listed here is quantity_on_hand. Guarded exhaustively against the
 * schema's transaction_logs_change_type_check list by the
 * 'ledger change_type pool-routing guard' test.
 */
const DAMAGED_POOL_CHANGE_TYPES: ReadonlySet<string> = new Set(['DISPOSAL']);

/**
 * Reconstructs true before/after balances for every row by replaying signed
 * quantity_changed deltas per (product, branch) in chronological order.
 *
 * Ordering is (timestampAD ASC, id ASC) — the same deterministic ordering the
 * live-stock recalculation uses — so a product's newest balance always reflects
 * the latest movement. DAMAGE rows are treated as quantity_on_hand deltas (the
 * stock-operations builder writes a negative quantityChanged for them); only
 * the DISPOSAL/damage-register family routes to the damaged pool.
 *
 * The returned `updates` are keyed by row id for a caller-side upsert (or a
 * single UPDATE ... FROM (VALUES ...) pass). Balances are clamped at 0 so a
 * historical sign inconsistency can never surface as negative stock.
 */
export function replayLedgerBalances(rows: readonly LedgerReplayRow[]): LedgerReplayResult {
  const groups = new Map<string, LedgerReplayRow[]>();
  let skipped = 0;

  for (const row of rows) {
    if (!row.productId || !row.branchId) {
      skipped += 1;
      continue;
    }
    const key = `${row.productId}:${row.branchId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const updates: LedgerBalanceUpdate[] = [];

  for (const bucket of groups.values()) {
    bucket.sort((a, b) => {
      const at = new Date(a.timestampAD).getTime();
      const bt = new Date(b.timestampAD).getTime();
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    let qoh = 0;
    let damaged = 0;

    for (const row of bucket) {
      const changed = Number(row.quantityChanged) || 0;
      const usesDamagedPool = DAMAGED_POOL_CHANGE_TYPES.has(row.changeType);
      const before = usesDamagedPool ? damaged : qoh;
      const after = Math.max(0, before + changed);

      if (usesDamagedPool) damaged = after;
      else qoh = after;

      updates.push({ id: row.id, quantityBefore: before, quantityAfter: after });
    }
  }

  return { updates, skipped, groups: groups.size };
}
