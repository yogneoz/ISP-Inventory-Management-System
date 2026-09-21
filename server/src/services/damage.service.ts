/**
 * Damage lifecycle service — pure, unit-testable logic extracted from the
 * DAMAGE branches of server.ts's stock-operation create/reverse endpoints.
 * No HTTP, no global state: DB clients, state arrays and context values are
 * passed in by the caller, so every function here runs under node:test.
 */
import type { DamageRecord, InventoryStock, TransactionLog } from '../../../client/src/types';
import type { SqlClient } from './serials.service';

// ---------------------------------------------------------------------------
// Damage-record row construction (damage_records INSERT + in-memory mirror)
// ---------------------------------------------------------------------------

const KNOWN_DAMAGE_REASONS = [
  'PHYSICAL_DAMAGE',
  'TRANSIT_DAMAGE',
  'STORAGE_DAMAGE',
  'EXPIRED',
  'RETURN_DAMAGE',
  'QUALITY_DEFECT',
  'OTHER',
] as const;

export type KnownDamageReason = (typeof KNOWN_DAMAGE_REASONS)[number];

/**
 * Verbatim from server.ts: maps the free-text operation reason to one of the
 * known damage_reason values by substring match, defaulting to OTHER.
 */
export function resolveDamageReason(topReason: unknown): KnownDamageReason {
  const upper = String(topReason || 'Physical branch inventory inspection & transit damage tag').toUpperCase();
  return (KNOWN_DAMAGE_REASONS.find((r) => upper.includes(r)) || 'OTHER') as KnownDamageReason;
}

/** Minimal shape of a DAMAGE operation (or its request body) used below. */
export interface DamageOperation {
  id: string;
  referenceNumber: string;
  branchId?: string;
  dateAD: string;
  dateBS: string;
  costPerUnit?: number;
  reason?: string;
  inspectorName?: string;
}

/** Minimal shape of one line item on a DAMAGE operation. */
export interface DamageItem {
  productId: string;
  productName?: string;
  quantity: number | string;
  unitCost?: number | string;
  costPerUnit?: number | string;
  sku?: string;
  deviceSerials?: any[];
}

export interface DamageRecordInsert {
  id: string;
  damageReference: string;
  sql: string;
  params: unknown[];
  /** The in-memory mirror row (fiscalYearId = whatever the caller resolved). */
  mirror: Omit<DamageRecord, 'fiscalYearId'> & { fiscalYearId?: string | null };
}

/**
 * Pure builder for one damage_records row (plus its in-memory mirror) for a
 * single damaged item of a DAMAGE operation. `fiscalYearId` is resolved by the
 * caller (it needs the fiscal-year table). The SQL and params are exactly what
 * server.ts executes today.
 */
export function buildDamageRecordInsert(
  op: DamageOperation,
  item: DamageItem,
  fiscalYearId: string | null,
  /** Caller-supplied fallback (server.ts passes the product's costPrice). */
  fallbackUnitCost?: number
): DamageRecordInsert {
  const qty = Number(item.quantity) || 0;
  const unitCost = Number(item.unitCost ?? item.costPerUnit ?? op.costPerUnit) || fallbackUnitCost || 0;
  const id = `dmr-${op.id}-${item.productId}`;
  const damageReference = `${op.referenceNumber}-${item.productId}`;
  const damageReason = resolveDamageReason(op.reason);
  return {
    id,
    damageReference,
    sql: `INSERT INTO damage_records (
             id, damage_reference, product_id, branch_id, quantity_damaged, unit_cost, total_cost,
             damage_date_ad, damage_date_bs, damage_reason, status, salvage_value, gl_account_code,
             write_off_loss, approved_by, notes, fiscal_year_id, is_demo, created_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'IDENTIFIED', 0, 'GL-5120 (Loss on Inventory Scrap & Write-off)', 0, $11, $12, $13, FALSE, $14)
           ON CONFLICT (id) DO NOTHING`,
    params: [
      id,
      damageReference,
      item.productId,
      op.branchId ?? null,
      qty,
      unitCost,
      qty * unitCost,
      op.dateAD,
      op.dateBS,
      damageReason,
      op.inspectorName || null,
      op.reason || '',
      fiscalYearId,
      op.inspectorName || null,
    ],
    mirror: {
      id,
      damageReference,
      productId: item.productId,
      branchId: op.branchId ?? '',
      quantityDamaged: qty,
      unitCost,
      totalCost: qty * unitCost,
      damageDateAD: op.dateAD,
      damageDateBS: op.dateBS,
      damageReason,
      status: 'IDENTIFIED',
      salvageValue: 0,
      glAccountCode: 'GL-5120 (Loss on Inventory Scrap & Write-off)',
      writeOffLoss: 0,
      approvedBy: op.inspectorName,
      notes: op.reason,
      fiscalYearId: fiscalYearId ?? undefined,
      isDemo: false,
      createdBy: op.inspectorName,
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Serial quarantine / restore (serial_log ↔ damage lifecycle)
// ---------------------------------------------------------------------------

/** History entry appended when a serial is quarantined by a DAMAGE op. */
export function buildQuarantineHistoryEntry(op: DamageOperation) {
  return {
    status: 'DAMAGED',
    sourceType: 'DAMAGE',
    sourceId: op.id,
    dateAD: op.dateAD,
    notes: `Marked damaged via ${op.referenceNumber}`,
  };
}

/**
 * DB-side quarantine: for every serial on the damaged items, mark the
 * serial_log row DAMAGED (only while it is still IN_STOCK). Verbatim port of
 * the inline loop in the stock-operation creation transaction.
 */
export async function quarantineSerialsInDb(
  client: SqlClient,
  items: DamageItem[],
  op: DamageOperation,
  nowIso: string
): Promise<void> {
  for (const item of items) {
    const serialEntries: any[] = Array.isArray(item.deviceSerials) ? item.deviceSerials : [];
    for (const s of serialEntries) {
      const sn = String(s?.deviceSerial || '').trim();
      if (!sn) continue;
      const histRes = await client.query(
        `SELECT history_json FROM serial_log WHERE lower(trim(device_serial)) = lower(trim($1)) AND status = 'IN_STOCK' LIMIT 1`,
        [sn]
      );
      if (!histRes.rowCount) continue;
      let hist: any[] = [];
      try {
        hist =
          typeof histRes.rows[0].history_json === 'string'
            ? JSON.parse(histRes.rows[0].history_json || '[]')
            : histRes.rows[0].history_json || [];
      } catch {
        hist = [];
      }
      hist.push(buildQuarantineHistoryEntry(op));
      await client.query(
        `UPDATE serial_log SET status = 'DAMAGED', source_type = 'DAMAGE', source_id = $1, history_json = $2, updated_at = $3
         WHERE lower(trim(device_serial)) = lower(trim($4)) AND status = 'IN_STOCK'`,
        [op.id, JSON.stringify(hist), nowIso, sn]
      );
    }
  }
}

/**
 * In-memory quarantine mirror: flips matching IN_STOCK serials to DAMAGED and
 * appends the quarantine history entry. Mutates the passed array (same as
 * server.ts does today) and returns the affected serial numbers.
 */
export function quarantineInMemorySerials(
  serialLogs: readonly any[],
  items: DamageItem[],
  op: DamageOperation
): string[] {
  const affected: string[] = [];
  for (const item of items) {
    for (const s of Array.isArray(item.deviceSerials) ? item.deviceSerials : []) {
      const key = String(s?.deviceSerial || '').trim().toLowerCase();
      if (!key) continue;
      const sl = serialLogs.find(
        (e) => String(e.deviceSerial || '').trim().toLowerCase() === key && e.status === 'IN_STOCK'
      );
      if (sl) {
        sl.status = 'DAMAGED';
        sl.sourceType = 'DAMAGE';
        sl.sourceId = op.id;
        sl.history = [...(sl.history || []), buildQuarantineHistoryEntry(op)];
        sl.updatedAt = new Date().toISOString();
        affected.push(key);
      }
    }
  }
  return affected;
}

/**
 * DB-side serial restore used by reversal: restores serials attributed to THIS
 * operation (payload serials when present, else source_id attribution for
 * legacy ops) from DAMAGED back to IN_STOCK. Verbatim port of the two UPDATE
 * branches.
 */
export async function restoreSerialsInDb(
  client: SqlClient,
  itemSerials: any[],
  op: { id: string; referenceNumber: string },
  message: string,
  nowIso: string
): Promise<void> {
  const sns = (Array.isArray(itemSerials) ? itemSerials : [])
    .map((s: any) => String(s?.deviceSerial || '').trim().toLowerCase())
    .filter(Boolean);
  const restoreHistory = JSON.stringify([{ status: 'IN_STOCK', sourceType: 'DAMAGE_REVERSED', sourceId: op.id, dateAD: nowIso.slice(0, 10), notes: message }]);
  if (sns.length > 0) {
    await client.query(
      `UPDATE serial_log SET status = 'IN_STOCK', source_type = 'STOCK_OP', source_id = NULL,
         history_json = (COALESCE(history_json, '[]')::jsonb || $3::jsonb)::text, updated_at = $4
       WHERE lower(trim(device_serial)) = ANY($1::text[]) AND status = 'DAMAGED' AND source_id = $2`,
      [sns, op.id, restoreHistory, nowIso]
    );
  } else {
    await client.query(
      `UPDATE serial_log SET status = 'IN_STOCK', source_type = 'STOCK_OP', source_id = NULL,
         history_json = (COALESCE(history_json, '[]')::jsonb || $2::jsonb)::text, updated_at = $3
       WHERE status = 'DAMAGED' AND source_id = $1`,
      [op.id, restoreHistory, nowIso]
    );
  }
}

/**
 * In-memory restore mirror: flips serials quarantined by THIS op back to
 * IN_STOCK with a DAMAGE_REVERSED history entry. Payload serials win; legacy
 * ops without payload serials restore by source_id attribution.
 */
export function restoreInMemorySerials(
  serialLogs: readonly any[],
  itemSerials: any[],
  op: { id: string; referenceNumber: string },
  message: string,
  reversalDateAD: string
): string[] {
  const restored: string[] = [];
  const attribution = (Array.isArray(itemSerials) ? itemSerials : [])
    .map((s: any) => String(s?.deviceSerial || '').trim().toLowerCase())
    .filter(Boolean);
  for (const sl of serialLogs) {
    const key = String(sl.deviceSerial || '').trim().toLowerCase();
    const isAttributed = attribution.includes(key) || (!attribution.length && sl.sourceId === op.id);
    if (isAttributed && sl.status === 'DAMAGED' && sl.sourceId === op.id) {
      sl.status = 'IN_STOCK';
      sl.sourceType = 'STOCK_OP';
      sl.sourceId = undefined;
      sl.history = [
        ...(sl.history || []),
        { status: 'IN_STOCK', sourceType: 'DAMAGE_REVERSED', sourceId: op.id, dateAD: reversalDateAD, notes: message },
      ];
      sl.updatedAt = new Date().toISOString();
      restored.push(key);
    }
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Reversal: item derivation, validation, ledger
// ---------------------------------------------------------------------------

/**
 * Derive the reversible items of a DAMAGE operation: prefer the items JSONB,
 * falling back to the single-product legacy shape. Verbatim port.
 */
export function deriveDamageItems(op: any): DamageItem[] {
  const items: any[] = Array.isArray(op.items) && op.items.length > 0 ? op.items : op.productId
    ? [{ productId: op.productId, productName: op.productName || '', quantity: Math.abs(Number(op.quantityChanged) || 0), unitCost: op.costPerUnit }]
    : [];
  return items;
}

/**
 * Pre-flight reversal safeguard: every item's damaged quantity must still be
 * present at the operation's branch (guards partial / mismatched reversals).
 * Returns the same 400 message the endpoint returns today, or null when valid.
 */
export function validateReversalAvailability(
  op: { branchId?: string; id: string },
  items: DamageItem[],
  stockRows: readonly Pick<InventoryStock, 'productId' | 'branchId' | 'damagedQty'>[]
): string | null {
  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;
    const stockRecord = stockRows.find(
      (s) => s.productId === item.productId && s.branchId === op.branchId
    );
    const availableDamaged = Number(stockRecord?.damagedQty) || 0;
    if (availableDamaged < qty) {
      return `Cannot reverse ${item.productName || item.productId}: only ${availableDamaged} damaged unit(s) remain at branch ${op.branchId || 'WH001'}. The current damaged stock has changed since this record was created.`;
    }
  }
  return null;
}

/**
 * Pure builder for the DAMAGE_REVERSED ledger entries (one per item).
 * `unitCostFor` lets the caller supply the cost-resolution policy; server.ts
 * passes `item.unitCost ?? item.costPerUnit ?? op.costPerUnit || product.costPrice`.
 */
export function buildReversalLedger(
  op: { id: string; referenceNumber: string; branchId?: string; costPerUnit?: number },
  items: DamageItem[],
  opts: {
    reversalDateAD: string;
    reversalDateBS: string;
    products: Array<{ id: string; sku?: string; name?: string; costPrice?: number }>;
    resolveUnitCost: (item: DamageItem) => number;
  }
): TransactionLog[] {
  const ledger: TransactionLog[] = [];
  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;
    const product = opts.products.find((p) => p.id === item.productId);
    const unitCost = opts.resolveUnitCost(item) || product?.costPrice || 0;
    const quantityBefore = 0; // resolved per-item by the caller when stock is known
    ledger.push({
      id: `txn-${op.id}-rev-${item.productId}`,
      transactionNumber: `${op.referenceNumber}-REV`,
      productId: item.productId,
      productSku: item.sku || product?.sku || '',
      productName: product?.name || item.productName || 'Product',
      branchId: op.branchId,
      changeType: 'DAMAGE_REVERSED',
      quantityBefore,
      quantityChanged: qty,
      quantityAfter: quantityBefore + qty,
      unitCost,
      referenceDocId: op.referenceNumber,
      timestampAD: new Date(`${opts.reversalDateAD}T00:00:00.000Z`).toISOString(),
      timestampBS: opts.reversalDateBS,
    } as TransactionLog);
  }
  return ledger;
}

/**
 * Reversal ledger with quantityBefore resolved from current stock rows —
 * convenience wrapper matching exactly what server.ts computes per item.
 */
export function buildReversalLedgerWithStock(
  op: any,
  items: DamageItem[],
  opts: {
    reversalDateAD: string;
    reversalDateBS: string;
    products: readonly { id: string; sku?: string; name?: string; costPrice?: number }[];
    stockRows: readonly Pick<InventoryStock, 'productId' | 'branchId' | 'quantityOnHand'>[];
  }
): TransactionLog[] {
  const ledger: TransactionLog[] = [];
  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;
    const product = opts.products.find((p) => p.id === item.productId);
    const stockRecord = opts.stockRows.find(
      (s) => s.productId === item.productId && s.branchId === op.branchId
    );
    const unitCost = Number(item.unitCost ?? item.costPerUnit ?? op.costPerUnit) || product?.costPrice || 0;
    const quantityBefore = Number(stockRecord?.quantityOnHand) || 0;
    ledger.push({
      id: `txn-${op.id}-rev-${item.productId}`,
      transactionNumber: `${op.referenceNumber}-REV`,
      productId: item.productId,
      productSku: item.sku || product?.sku || '',
      productName: product?.name || item.productName || 'Product',
      branchId: op.branchId,
      changeType: 'DAMAGE_REVERSED',
      quantityBefore,
      quantityChanged: qty,
      quantityAfter: quantityBefore + qty,
      unitCost,
      referenceDocId: op.referenceNumber,
      timestampAD: new Date(`${opts.reversalDateAD}T00:00:00.000Z`).toISOString(),
      timestampBS: opts.reversalDateBS,
    } as TransactionLog);
  }
  return ledger;
}

/**
 * In-memory reversal mirrors: restores stock quantities, cancels the matching
 * damage_records rows, and returns the updated operation object. Mutates the
 * passed arrays exactly as the endpoint does today.
 */
export function mirrorReversal(
  op: any,
  items: DamageItem[],
  opts: { reason: string; reversedBy: string; reversalDateAD: string; reversalDateBS: string },
  arrays: {
    stockRows: readonly InventoryStock[];
    damageRecords: readonly DamageRecord[];
  }
): { updatedOp: any; stockRows: InventoryStock[]; damageRecords: DamageRecord[] } {
  const updatedOp: any = {
    ...op,
    status: 'CANCELLED',
    reversalReason: opts.reason,
    reversedBy: opts.reversedBy,
    reversedAtAD: opts.reversalDateAD,
    reversedAtBS: opts.reversalDateBS,
  };
  const stockRows = [...arrays.stockRows];
  const damageRecords = [...arrays.damageRecords];
  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;
    const stockIdx = stockRows.findIndex(
      (s) => s.productId === item.productId && s.branchId === op.branchId
    );
    if (stockIdx >= 0) {
      stockRows[stockIdx] = {
        ...stockRows[stockIdx],
        quantityOnHand: (stockRows[stockIdx].quantityOnHand || 0) + qty,
        damagedQty: Math.max(0, (stockRows[stockIdx].damagedQty || 0) - qty),
        lastUpdated: new Date().toISOString(),
      };
    }
    const damageIdx = damageRecords.findIndex(
      (dr) => dr.damageReference === `${op.referenceNumber}-${item.productId}` || dr.id === `dmr-${op.id}-${item.productId}`
    );
    if (damageIdx >= 0) {
      damageRecords[damageIdx] = {
        ...damageRecords[damageIdx],
        status: 'CANCELLED',
        notes: `${damageRecords[damageIdx].notes || ''} | REVERSED (${opts.reason}) by ${opts.reversedBy}`,
      };
    }
  }
  return { updatedOp, stockRows, damageRecords };
}
