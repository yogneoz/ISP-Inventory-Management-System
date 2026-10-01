/**
 * Database boot module extracted from app.ts (backlog item #6 — app.ts
 * extraction). Owns the PostgreSQL schema sync (executes scripts/schema.sql —
 * the single schema source of truth, duplication audit phase 2), initial
 * seeding, the operational cache load list (CACHE_LOADS), boot-time
 * hydration, and the serial-log backfill.
 *
 * Shared-state interactions are injected via BootStateDeps so this module
 * never imports app.ts (no cycles).
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pgPool, realPoolInstance, setIsPgConnected } from '../../db';
import { setPgConnected as setPgConnectedFlag } from '../state/runtimeState';
import { hydrateBsCalendarFromDb } from '../config/bsCalendar';
import {
INITIAL_COMPANY_PROFILE,
INITIAL_DOCUMENT_NUMBER_CONFIGS,
INITIAL_MASTER_UOM,
INITIAL_MASTER_LOCATIONS,
INITIAL_MASTER_BRANCHES,
INITIAL_MASTER_FISCAL_YEARS,
INITIAL_MASTER_SUPPLIERS,
EXAMPLE_USER_PASSWORD,
INITIAL_EXAMPLE_USERS,
} from '../config/seedData';
import { DEFAULT_PERMISSIONS_MATRIX } from '../../../client/src/utils/permissionMatrixData';
import { hashPassword } from '../middleware/auth';

import {
companyProfile, docNumberConfigs, users, suppliers, uomList, locationRecords,
branches, fiscalYears, products, categories, inventoryStock, assetRegister,
purchaseOrders, purchaseInvoices, shipments, stockOperations, auditTrail,
transactionLogs, customerMasterRecords, customerDeviceRecords, vendorPayments,
serialLogs, permissionMatrix, getPgConnected,
setCompanyProfile, setDocNumberConfigs, setUsers, setSuppliers, setUomList,
setLocationRecords, setBranches, setFiscalYears, setProducts, setCategories,
setInventoryStock, setAssetRegister, setPurchaseOrders, setPurchaseInvoices,
setShipments, setStockOperations, setAuditTrail, setTransactionLogs,
setCustomerMasterRecords, setCustomerDeviceRecords, setVendorPayments,
setSerialLogs, setPermissionMatrix, CACHE_LOADS, hydrateOperationalData,
refreshOperationalCache,
} from '../state/runtimeState';


/**
 * Resolve scripts/schema.sql from the repo root. Tries, in order:
 *   1. process.cwd()/scripts/schema.sql  — `npm run dev` / `npm test` / CI
 *      always run from the repo root.
 *   2. module-relative walk up          — bundled `dist/server.cjs` (esbuild
 *      keeps this module's __dirname-style location) or any other cwd.
 * Cached after the first successful read; throws a clear error if the file
 * cannot be located.
 */
let schemaSqlCache: string | null = null;
function loadSchemaSql(): string {
  if (schemaSqlCache) return schemaSqlCache;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'scripts/schema.sql'),
    ...Array.from({ length: 6 }, (_, i) => path.resolve(moduleDir, '../'.repeat(i), 'scripts/schema.sql')),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      schemaSqlCache = readFileSync(candidate, 'utf8');
      return schemaSqlCache;
    }
  }
  throw new Error(`scripts/schema.sql not found — looked in:\n  ${candidates.join('\n  ')}`);
}

export async function syncDatabaseAndIndexes() {
  if (!realPoolInstance) {
    setPgConnectedFlag(false);
    setIsPgConnected(false);
    throw new Error('PostgreSQL connection is not configured. Set DATABASE_URL or POSTGRES_HOST.');
  }

  try {
    const client = await pgPool.connect();
    if (!client) {
      setPgConnectedFlag(false);
      setIsPgConnected(false);
      throw new Error('PostgreSQL connection could not be established.');
    }
    console.log('PostgreSQL Pool connected successfully. Syncing database schema from scripts/schema.sql (single source of truth)...');

    // Single source of truth: execute scripts/schema.sql verbatim. This file
    // no longer maintains a second inline schema (duplication audit, phase 2).
    // The static drift guard (tests/schemaSource.parity.test.ts) plus the CI
    // "apply schema.sql to a fresh database" step keep the two in lockstep.
    await client.query(loadSchemaSql());

    setPgConnectedFlag(true);
    setIsPgConnected(true);
    await seedInitialPostgresData(client);
    await hydrateOperationalData(client);
    await backfillSerialLog(client);
    await loadPermissionMatrixFromDb(client);
    await hydrateBsCalendarFromDb(client);

    client.release();
    console.log('✅ Database schema synced from scripts/schema.sql; seeds, caches and permission matrix loaded.');
  } catch (err: any) {
    setPgConnectedFlag(false);
    setIsPgConnected(false);
    throw new Error(`PostgreSQL startup failed: ${err?.message || err}`);
  }
}

async function seedInitialPostgresData(client: pg.PoolClient) {
  try {
    for (const b of INITIAL_MASTER_BRANCHES) {
      await client.query(
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement, allow_warehouse_transfer, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.code, b.name, b.location, b.phone || '', b.isHeadquarters || false, b.active !== false, b.allowProcurement !== false, b.allowWarehouseTransfer !== false]
      );
    }
    for (const fy of INITIAL_MASTER_FISCAL_YEARS) {
      await client.query(
        `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (id) DO NOTHING`,
        [fy.id, fy.code, fy.startDateAD || '2025-07-16', fy.endDateAD || '2026-07-15', fy.startDateBS || '2082-04-01', fy.endDateBS || '2083-03-31', fy.isCurrent || false, fy.isClosed || false]
      );
    }
    // Seed Company Profile if empty
    await client.query(
      `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, postal_code, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, currency_code, currency_locale, currency_position, currency_decimals, default_tax_rate, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) ON CONFLICT (id) DO NOTHING`,
      [
        INITIAL_COMPANY_PROFILE.id,
        INITIAL_COMPANY_PROFILE.name,
        INITIAL_COMPANY_PROFILE.legalName,
        INITIAL_COMPANY_PROFILE.tagline,
        INITIAL_COMPANY_PROFILE.address,
        INITIAL_COMPANY_PROFILE.city,
        INITIAL_COMPANY_PROFILE.country,
        INITIAL_COMPANY_PROFILE.postalCode || '',
        INITIAL_COMPANY_PROFILE.phone,
        INITIAL_COMPANY_PROFILE.email,
        INITIAL_COMPANY_PROFILE.website,
        INITIAL_COMPANY_PROFILE.panVatNumber,
        INITIAL_COMPANY_PROFILE.registrationNumber,
        INITIAL_COMPANY_PROFILE.logoUrl,
        INITIAL_COMPANY_PROFILE.logoPreset,
        INITIAL_COMPANY_PROFILE.currencySymbol,
        INITIAL_COMPANY_PROFILE.currencyCode || 'NPR',
        INITIAL_COMPANY_PROFILE.currencyLocale || 'en-IN',
        INITIAL_COMPANY_PROFILE.currencyPosition || 'before',
        INITIAL_COMPANY_PROFILE.currencyDecimals ?? 2,
        INITIAL_COMPANY_PROFILE.defaultTaxRate,
        INITIAL_COMPANY_PROFILE.notes,
      ]
    );

    for (const u of INITIAL_MASTER_UOM) {
      await client.query(
        `INSERT INTO uom (id, name, symbol, type, is_base_unit)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
        [u.id, u.name, u.symbol, u.type, u.isBaseUnit]
      );
    }
    for (const l of INITIAL_MASTER_LOCATIONS) {
      await client.query(
        `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE) ON CONFLICT (id) DO NOTHING`,
        [l.id, l.name, l.type, l.branchId, l.address, JSON.stringify(l.coordinates), l.contactPerson, l.contactPhone, l.notes, l.activeAssetsCount]
      );
    }

    for (const s of INITIAL_MASTER_SUPPLIERS) {
      const sup = s as any;
      await client.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE) ON CONFLICT (id) DO NOTHING`,
        [sup.id, sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', sup.rating || 5.0, sup.status || 'ACTIVE']
      );
    }

    // Example/dummy user accounts (is_demo = TRUE) so the app is testable out
    // of the box after a fresh setup. Never overwrite existing accounts.
    for (const eu of INITIAL_EXAMPLE_USERS) {
      const allowedBranchIds = eu.role === 'SUPER_ADMIN' ? INITIAL_MASTER_BRANCHES.map((b) => b.id) : [eu.branchId];
      await client.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (email) DO NOTHING`,
        [eu.id, eu.email, hashPassword(EXAMPLE_USER_PASSWORD), eu.name, eu.role, eu.branchId, allowedBranchIds, eu.canSwitchUser]
      );
    }

for (const cfg of INITIAL_DOCUMENT_NUMBER_CONFIGS) {
      await client.query(
        `INSERT INTO document_number_configs (id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
         [cfg.id, cfg.documentType, cfg.prefix || '', cfg.suffix || '', cfg.minDigits || 4, cfg.startingNumber || 1, cfg.nextNumber || 1, cfg.resetEveryFiscalYear !== false, cfg.notes || '']
       );
     }

     // Seed the server-side permission matrix from the canonical defaults.
     // Idempotent: only insert operations/roles that are missing so a restart
     // never silently reverts matrix customizations made via the API.
     const matrixEntries: Array<[string, string, boolean]> = [];
     for (const [opId, roles] of Object.entries(DEFAULT_PERMISSIONS_MATRIX)) {
       for (const [role, allowed] of Object.entries(roles)) {
         matrixEntries.push([opId, role, allowed]);
       }
     }
     for (const [opId, role, allowed] of matrixEntries) {
       await client.query(
         `INSERT INTO permission_matrix (operation_id, role, allowed) VALUES ($1, $2, $3) ON CONFLICT (operation_id, role) DO NOTHING`,
         [opId, role, allowed]
       );
     }

     // Master data (branches, users, uom, locations, suppliers, fiscal years,
     // company profile) is hydrated by hydrateOperationalData / CACHE_LOADS —
     // called right after this seed function.
    const docCfgRes = await client.query('SELECT id, document_type AS "documentType", prefix, suffix, min_digits AS "minDigits", starting_number AS "startingNumber", next_number AS "nextNumber", reset_every_fiscal_year AS "resetEveryFiscalYear", notes FROM document_number_configs ORDER BY id ASC');
    if (docCfgRes.rows.length > 0) setDocNumberConfigs(docCfgRes.rows);

    console.log('✅ Master data seeded and hydrated. Operational data is always served from PostgreSQL (single source of truth).');
  } catch (seedErr: any) {
    console.log('PostgreSQL initial seed note:', seedErr?.message || seedErr);
  }
}

// Load the server-side permission matrix into memory from PostgreSQL.
async function loadPermissionMatrixFromDb(client: pg.PoolClient): Promise<void> {
  const result = await client.query('SELECT operation_id, role, allowed FROM permission_matrix');
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const row of result.rows) {
    const opId = row.operation_id as string;
    const role = row.role as string;
    if (!matrix[opId]) matrix[opId] = {};
    matrix[opId][role] = Boolean(row.allowed);
  }
  setPermissionMatrix(matrix);
  console.log(`✅ Server-side permission matrix loaded: ${Object.keys(matrix).length} operations mapped.`);
}

// Serial-log backfill: converges every legacy serial source (purchase invoices,
// shipments, stock operations, serial-tracked fixed assets, customer devices)
// into ONE row per unique device_serial. Later/priority sources win; terminal
// manual states (DAMAGED, CUSTOMER_ASSIGNED, RETURNED, POP_LOCATION_ASSIGNED)
// are never downgraded by the backfill.
async function backfillSerialLog(client: pg.PoolClient) {
  try {
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
    const piRes = await client.query('SELECT id, branch_id, invoice_date_ad, items FROM purchase_invoices');
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
    const shRes = await client.query('SELECT id, status, destination_branch_id, dispatch_date_ad, items FROM shipments');
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
    const opRes = await client.query('SELECT id, type, branch_id, date_ad, items FROM stock_operations');
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
    const faRes = await client.query(
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
    const cdRes = await client.query(
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

    if (merged.size === 0) return;

    const existingRes = await client.query('SELECT id, device_serial, status, history_json FROM serial_log');
    const existing = new Map<string, any>();
    for (const r of existingRes.rows) existing.set(keyOf(r.device_serial), r);

    let inserted = 0, updated = 0;
    for (const [, c] of merged) {
      const k = keyOf(c.deviceSerial);
      const row = existing.get(k);
      const entry = { status: c.status, sourceType: c.sourceType, sourceId: c.sourceId || null, dateAD: c.dateAD, notes: 'Auto backfill' };
      if (!row) {
        const id = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await client.query(
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
        await client.query(
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
    const fresh = await client.query(
      'SELECT id, device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", product_id AS "productId", product_name AS "productName", branch_id AS "branchId", customer_id AS "customerId", customer_name AS "customerName", status, source_type AS "sourceType", source_id AS "sourceId", history_json AS "historyJson", created_at AS "createdAt", updated_at AS "updatedAt" FROM serial_log ORDER BY created_at DESC'
    );
    setSerialLogs(fresh.rows.map((r: any) => {
      let history: any[] = [];
      try { history = typeof r.historyJson === 'string' ? JSON.parse(r.historyJson || '[]') : (r.historyJson || []); } catch { history = []; }
      const { historyJson, ...rest } = r;
      return { ...rest, history };
    }));
    if (inserted > 0 || updated > 0) {
      console.log(`✅ Serial-log backfill converged ${merged.size} unique serials (${inserted} inserted, ${updated} upgraded).`);
    }
  } catch (e: any) {
    console.warn('Serial-log backfill skipped:', e?.message || e);
  }
}
