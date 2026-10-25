/**
 * Serial-register reconcile — SER-2 / decision D3.
 *
 * Converges every legacy serial source (purchase invoices, shipments, stock
 * operations, serial-tracked fixed assets, customer devices) into ONE row per
 * unique device_serial. Later/priority sources win; terminal manual states
 * (DAMAGED, CUSTOMER_ASSIGNED, RETURNED, POP_LOCATION_ASSIGNED) are never
 * downgraded.
 *
 * This used to run on every boot. D3 retired that: a silent boot pass made the
 * register converge behind the operator's back and hid unregistered legacy
 * units. The pass is now an explicit SUPER_ADMIN maintenance action
 * (POST /api/admin/recalculate/serial-register) and stays idempotent, so a
 * legacy database runs it once and a converged one reports 0 / 0.
 */
import { setSerialLogs } from '../state/runtimeState';

/**
 * Minimal query surface: the boot/transaction `pg.PoolClient`, the raw
 * `pg.Pool`, and the app's pooled wrapper all satisfy it, so the service is
 * callable from the maintenance endpoint without owning the connection.
 */
export interface SerialBackfillDb {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface SerialBackfillResult {
  /** Unique serials resolved from the legacy sources. */
  converged: number;
  /** Register rows created by this pass. */
  inserted: number;
  /** Rows whose transient status was upgraded this pass. */
  upgraded: number;
}

export async function backfillSerialLog(db: SerialBackfillDb): Promise<SerialBackfillResult> {
  const asArray = (v: any): any[] => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
  };
  const keyOf = (s: any) => String(s || '').trim().toLowerCase();
  const isoDate = (d: any) => { const s = String(d || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10); };

  type Cand = {
    deviceSerial: string; ponSerial?: string; macAddress?: string;
    productId?: string; productName?: string; branchId?: string;
    customerId?: string; customerName?: string;
    status: string; sourceType: string; sourceId?: string; dateAD?: string;
  };
  const merged = new Map<string, Cand>();
  const put = (c: Cand, force = false) => {
    const k = keyOf(c.deviceSerial);
    if (!k) return;
    const prev = merged.get(k);
    if (!prev) { merged.set(k, c); return; }
    // DAMAGED always wins; otherwise later (higher-priority) sources win.
    if (c.status === 'DAMAGED' || force || prev.status === 'IN_STOCK' || prev.status === 'IN_TRANSIT') {
      merged.set(k, {
        ...c,
        ponSerial: c.ponSerial || prev.ponSerial,
        macAddress: c.macAddress || prev.macAddress,
        productId: c.productId || prev.productId,
        productName: c.productName || prev.productName,
        branchId: c.branchId || prev.branchId,
      });
    }
  };

  // 1. Purchase invoices → IN_STOCK
  const piRes = await db.query('SELECT id, branch_id, invoice_date_ad, items FROM purchase_invoices');
  for (const inv of piRes.rows) {
    for (const item of asArray(inv.items)) {
      for (const s of asArray(item.deviceSerials)) {
        if (!keyOf(s.deviceSerial)) continue;
        put({
          deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
          productId: item.productId, productName: item.productName || item.sku,
          branchId: inv.branch_id, status: 'IN_STOCK', sourceType: 'PURCHASE',
          sourceId: inv.id, dateAD: isoDate(inv.invoice_date_ad),
        });
      }
    }
  }

  // 2. Shipments → IN_TRANSIT (dispatched) or IN_STOCK (received)
  const shRes = await db.query('SELECT id, status, destination_branch_id, dispatch_date_ad, items FROM shipments');
  for (const sh of shRes.rows) {
    const inTransit = sh.status === 'DISPATCHED' || sh.status === 'IN_TRANSIT';
    for (const item of asArray(sh.items)) {
      const list = sh.status === 'RECEIVED' ? asArray(item.receivedSerials) : asArray(item.deviceSerials);
      for (const s of list) {
        if (!keyOf(s.deviceSerial)) continue;
        put({
          deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
          productId: item.productId, productName: item.productName,
          branchId: sh.destination_branch_id, status: inTransit ? 'IN_TRANSIT' : 'IN_STOCK',
          sourceType: 'SHIPMENT', sourceId: sh.id, dateAD: isoDate(sh.dispatch_date_ad),
        });
      }
    }
  }

  // 3. Stock operations → DAMAGED or IN_STOCK
  const opRes = await db.query('SELECT id, type, branch_id, date_ad, items FROM stock_operations');
  for (const op of opRes.rows) {
    const damaged = op.type === 'DAMAGE' || op.type === 'DISPOSAL';
    for (const item of asArray(op.items)) {
      for (const s of asArray(item.deviceSerials)) {
        if (!keyOf(s.deviceSerial)) continue;
        put({
          deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
          productId: item.productId, productName: item.productName,
          branchId: op.branch_id, status: damaged ? 'DAMAGED' : 'IN_STOCK',
          sourceType: 'STOCK_OP', sourceId: op.id, dateAD: isoDate(op.date_ad),
        });
      }
    }
  }

  // 4. Serial-tracked fixed assets → POP_LOCATION_ASSIGNED
  const faRes = await db.query(
    `SELECT fa.id, fa.tag_number, fa.name, fa.branch_id, fa.product_id, fa.placed_in_service_date_ad, fa.acquisition_date_ad
     FROM fixed_assets fa LEFT JOIN products p ON p.id = fa.product_id
     WHERE fa.status = 'ACTIVE' AND (p.requires_serial_tracking = TRUE OR p.tracking_type IS DISTINCT FROM 'QUANTITY_ONLY' OR fa.product_id IS NULL)`
  );
  for (const fa of faRes.rows) {
    if (!keyOf(fa.tag_number)) continue;
    put({
      deviceSerial: String(fa.tag_number).trim(), ponSerial: String(fa.tag_number).trim(),
      productId: fa.product_id, productName: fa.name, branchId: fa.branch_id,
      status: 'POP_LOCATION_ASSIGNED', sourceType: 'FIXED_ASSET', sourceId: fa.id,
      dateAD: isoDate(fa.placed_in_service_date_ad || fa.acquisition_date_ad),
    }, true);
  }

  // 5. Customer devices → CUSTOMER_ASSIGNED (highest priority, wins over purchase/stock)
  const cdRes = await db.query(
    'SELECT id, customer_id, customer_name, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad FROM customer_device_records'
  );
  for (const d of cdRes.rows) {
    if (!keyOf(d.device_serial)) continue;
    let st = 'CUSTOMER_ASSIGNED';
    if (d.status === 'ROUTER_COLLECTED' || d.status === 'DISCONNECTED' || d.status === 'IN_STOCK') st = 'IN_STOCK';
    else if (d.status === 'DAMAGED' || d.status === 'DAMAGED_STOCK') st = 'DAMAGED';
    put({
      deviceSerial: String(d.device_serial).trim(), ponSerial: d.pon_serial, macAddress: d.mac_address,
      productName: d.product_name, branchId: d.branch_id,
      customerId: d.customer_id, customerName: d.customer_name,
      status: st, sourceType: 'CUSTOMER_ASSIGN', sourceId: d.id, dateAD: isoDate(d.issued_date_ad),
    }, true);
  }

  if (merged.size === 0) return { converged: 0, inserted: 0, upgraded: 0 };

  const existingRes = await db.query('SELECT id, device_serial, status, history_json FROM serial_log');
  const existing = new Map<string, any>();
  for (const r of existingRes.rows) existing.set(keyOf(r.device_serial), r);

  let inserted = 0, updated = 0;
  for (const [, c] of merged) {
    const k = keyOf(c.deviceSerial);
    const row = existing.get(k);
    const entry = { status: c.status, sourceType: c.sourceType, sourceId: c.sourceId || null, dateAD: c.dateAD, notes: 'Auto backfill' };
    if (!row) {
      const id = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await db.query(
        `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, customer_id, customer_name, status, source_type, source_id, history_json, created_at, updated_at, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,FALSE) ON CONFLICT DO NOTHING`,
        [id, c.deviceSerial, c.ponSerial || null, c.macAddress || null, c.productId || null, c.productName || null,
          c.branchId || null, c.customerId || null, c.customerName || null, c.status, c.sourceType, c.sourceId || null,
          JSON.stringify([entry]), `${c.dateAD}T00:00:00Z`, new Date().toISOString()]
      );
      inserted++;
    } else if ((row.status === 'IN_STOCK' || row.status === 'IN_TRANSIT') && row.status !== c.status) {
      // Upgrade transient states only — never downgrade manual/terminal states.
      let history: any[] = [];
      try { history = JSON.parse(row.history_json || '[]'); } catch { history = []; }
      history.push(entry);
      await db.query(
        `UPDATE serial_log SET status = $1, customer_id = COALESCE($2, customer_id), customer_name = COALESCE($3, customer_name),
          pon_serial = COALESCE($4, pon_serial), mac_address = COALESCE($5, mac_address),
          product_name = COALESCE($6, product_name), branch_id = COALESCE($7, branch_id),
          source_type = $8, source_id = COALESCE($9, source_id), history_json = $10, updated_at = NOW() WHERE id = $11`,
        [c.status, c.customerId || null, c.customerName || null, c.ponSerial || null, c.macAddress || null,
          c.productName || null, c.branchId || null, c.sourceType, c.sourceId || null, JSON.stringify(history), row.id]
      );
      updated++;
    }
  }

  // Refresh the in-memory register so the API serves converged rows immediately.
  const fresh = await db.query(
    'SELECT id, device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", product_id AS "productId", product_name AS "productName", branch_id AS "branchId", customer_id AS "customerId", customer_name AS "customerName", status, source_type AS "sourceType", source_id AS "sourceId", history_json AS "historyJson", created_at AS "createdAt", updated_at AS "updatedAt" FROM serial_log ORDER BY created_at DESC'
  );
  setSerialLogs(fresh.rows.map((r: any) => {
    let history: any[] = [];
    try { history = typeof r.historyJson === 'string' ? JSON.parse(r.historyJson || '[]') : (r.historyJson || []); } catch { history = []; }
    const { historyJson, ...rest } = r;
    return { ...rest, history };
  }));
  return { converged: merged.size, inserted, upgraded: updated };
}
