/**
 * Fiscal-year opening-stock / vendor-opening-balance routes extracted from
 * app.ts (backlog item #6 — app.ts extraction). Registered last inside
 * registerAllRoutes; they were the only endpoints still living in app.ts.
 */
import type express from 'express';
import { pgPool } from '../../db';
import { requireRole, getUserFromReq } from '../middleware/index';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from './fiscal.auditAccess';

export function registerLeftoverFiscalRoutes(expressApp: express.Express) {
// ========== FISCAL-YEAR OPENING STOCK — REGISTER VIEW & MANUAL ADJUSTMENT ==========

// View the full opening-stock register for a fiscal year: every product × branch row
// (including zero-quantity rows) joined with product/branch names and the current live
// stock as a reference, plus summary stats.
expressApp.get(
  '/api/fiscal-years/:id/opening-stock',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const fyRes = await pgPool.query(
        `SELECT id, code,
                start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                is_current AS "isCurrent", is_closed AS "isClosed"
         FROM fiscal_years WHERE id = $1`,
        [id]
      );
      const fy = fyRes.rows[0];
      if (!fy) return res.status(404).json({ message: 'Fiscal year not found.' });

      const rowsRes = await pgPool.query(
        `SELECT 'opening-' || o.fiscal_year_id || '-' || o.product_id || '-' || o.branch_id AS id,
                o.product_id AS "productId",
                COALESCE(p.name, 'Deleted product') AS "productName",
                COALESCE(p.sku, '-') AS "productSku",
                o.branch_id AS "branchId",
                COALESCE(b.name, 'Deleted branch') AS "branchName",
                o.quantity_on_hand AS "quantityOnHand",
                o.damaged_qty AS "damagedQty",
                o.unit_cost::float AS "unitCost",
                o.source_type AS "sourceType",
                o.source_reference AS "sourceReference",
                o.posted_at::text AS "postedAt",
                o.posted_by AS "postedBy",
                COALESCE(s.quantity_on_hand, 0) AS "liveQty",
                COALESCE(s.damaged_qty, 0) AS "liveDamagedQty"
         FROM fiscal_year_opening_stock o
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN branches b ON b.id = o.branch_id
         LEFT JOIN inventory_stock s ON s.product_id = o.product_id AND s.branch_id = o.branch_id
         WHERE o.fiscal_year_id = $1
         ORDER BY p.name ASC, b.name ASC`,
        [id]
      );

      const rows = rowsRes.rows;
      const stats = {
        totalRows: rows.length,
        manualAdjustments: rows.filter((r: any) => r.sourceType === 'MANUAL_ADJUSTMENT').length,
        zeroQtyRows: rows.filter((r: any) => Number(r.quantityOnHand) === 0).length,
        totalUnits: rows.reduce((sum: number, r: any) => sum + Number(r.quantityOnHand), 0),
        totalValue: rows.reduce((sum: number, r: any) => sum + Number(r.quantityOnHand) * Number(r.unitCost), 0),
      };

      return res.json({ fiscalYear: fy, rows, stats });
    } catch (error: any) {
      console.error('Error fetching fiscal-year opening stock register:', error);
      return res.status(500).json({ message: `Unable to load fiscal-year opening stock: ${error.message}` });
    }
  }
);

// Manual opening-stock adjustment (batch). Allowed only while the fiscal year is OPEN —
// closed years are period-locked and require Super Admin reopen first. Existing rows are
// updated in place; missing product × branch combinations are created. Every touched row
// is re-stamped as MANUAL_ADJUSTMENT with the authorizing user, and an audit entry
// records old -> new values.
expressApp.put(
  '/api/fiscal-years/:id/opening-stock',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER'),
  async (req, res) => {
    const { id } = req.params;
    const user = getUserFromReq(req);
    const incoming: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];

    try {
      const fyRes = await pgPool.query('SELECT id, code, is_closed AS "isClosed" FROM fiscal_years WHERE id = $1', [id]);
      const fy = fyRes.rows[0];
      if (!fy) return res.status(404).json({ message: 'Fiscal year not found.' });
      if (fy.isClosed) {
        return res.status(403).json({
          message:
            'This fiscal year is closed and period-locked. Reopen it with Super Admin authorization before adjusting opening stock.',
        });
      }
      if (incoming.length === 0) {
        return res.status(400).json({ message: 'No opening-stock rows were provided to adjust.' });
      }

      const [prodRes, branchRes] = await Promise.all([
        pgPool.query('SELECT id, name FROM products'),
        pgPool.query('SELECT id, name FROM branches'),
      ]);
      const productNameById = new Map<string, string>(prodRes.rows.map((r: any) => [r.id, r.name]));
      const branchNameById = new Map<string, string>(branchRes.rows.map((r: any) => [r.id, r.name]));

      // ---- Validate every row BEFORE writing anything (all-or-nothing) ----
      const updates: Array<{
        productId: string;
        branchId: string;
        quantityOnHand: number;
        damagedQty: number;
        unitCost: number;
      }> = [];

      for (const item of incoming) {
        const productId = String(item?.productId || '').trim();
        const branchId = String(item?.branchId || '').trim();
        const quantityOnHand = Number(item?.quantityOnHand);
        const damagedQty = Number(item?.damagedQty ?? 0);
        const unitCost = Number(item?.unitCost ?? 0);
        const label = `${productNameById.get(productId) || productId || 'unknown product'} @ ${
          branchNameById.get(branchId) || branchId || 'unknown branch'
        }`;

        if (!productId || !productNameById.has(productId)) {
          return res.status(400).json({ message: `Invalid product reference in opening-stock adjustment: ${label}` });
        }
        if (!branchId || !branchNameById.has(branchId)) {
          return res.status(400).json({ message: `Invalid branch reference in opening-stock adjustment: ${label}` });
        }
        if (!Number.isInteger(quantityOnHand) || quantityOnHand < 0) {
          return res.status(400).json({ message: `Quantity on hand must be a whole number >= 0 for ${label}.` });
        }
        if (!Number.isInteger(damagedQty) || damagedQty < 0) {
          return res.status(400).json({ message: `Damaged quantity must be a whole number >= 0 for ${label}.` });
        }
        if (damagedQty > quantityOnHand) {
          return res.status(400).json({ message: `Damaged quantity cannot exceed quantity on hand for ${label}.` });
        }
        if (Number.isNaN(unitCost) || unitCost < 0) {
          return res.status(400).json({ message: `Unit cost must be a number >= 0 for ${label}.` });
        }

        updates.push({ productId, branchId, quantityOnHand, damagedQty, unitCost });
      }

      // ---- Apply inside one transaction; capture old values for the audit trail ----
      const result = await withTransaction(async (client) => {
        const changeLog: string[] = [];
        let createdCount = 0;

        for (const u of updates) {
          const beforeRes = await client.query(
            `SELECT quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", unit_cost::float AS "unitCost"
             FROM fiscal_year_opening_stock
             WHERE fiscal_year_id = $1 AND product_id = $2 AND branch_id = $3`,
            [id, u.productId, u.branchId]
          );
          const before = beforeRes.rows[0];

          const afterRes = await client.query(
            `INSERT INTO fiscal_year_opening_stock (
               id, fiscal_year_id, product_id, branch_id, quantity_on_hand, damaged_qty, unit_cost,
               source_type, source_reference, posted_at, posted_by
             )
             VALUES (
               'open-' || $1::text || '-' || $2 || '-' || $3,
               $1, $2, $3, $4, $5, $6,
               'MANUAL_ADJUSTMENT', 'MANUAL_ADJUSTMENT', CURRENT_TIMESTAMP, $7
             )
             ON CONFLICT (fiscal_year_id, product_id, branch_id) DO UPDATE SET
               quantity_on_hand = EXCLUDED.quantity_on_hand,
               damaged_qty = EXCLUDED.damaged_qty,
               unit_cost = EXCLUDED.unit_cost,
               source_type = 'MANUAL_ADJUSTMENT',
               source_reference = 'MANUAL_ADJUSTMENT',
               posted_at = CURRENT_TIMESTAMP,
               posted_by = EXCLUDED.posted_by
             RETURNING id`,
            [id, u.productId, u.branchId, u.quantityOnHand, u.damagedQty, u.unitCost, user.email || 'system']
          );

          if (!afterRes.rowCount) continue;
          if (!before) createdCount++;
          changeLog.push(
            `${before ? 'updated' : 'created'} ${productNameById.get(u.productId)} @ ${branchNameById.get(u.branchId)}: ` +
              `qty ${before ? before.quantityOnHand : '—'} -> ${u.quantityOnHand}, ` +
              `damaged ${before ? before.damagedQty : '—'} -> ${u.damagedQty}, ` +
              `cost NPR ${before ? before.unitCost : '—'} -> NPR ${u.unitCost}`
          );
        }

        return { appliedCount: changeLog.length, createdCount, changeLog };
      });

    if (result.appliedCount > 0) {
      const details =
        `Adjusted ${result.appliedCount} opening-stock row(s) for fiscal year ${fy.code}` +
        (result.createdCount ? ` (${result.createdCount} created)` : '') +
        ` [${result.changeLog.slice(0, 15).join('; ')}${result.changeLog.length > 15 ? ' …' : ''}] ` +
        `(by ${user.email || 'system'})`;
      logAuditEvent(req, 'ADJUST_FISCAL_OPENING_STOCK', 'FISCAL_YEAR', details);
    }

      return res.json({
        applied: result.appliedCount,
        created: result.createdCount,
        message: `${result.appliedCount} opening-stock row(s) saved for fiscal year ${fy.code}.`,
      });
    } catch (error: any) {
      console.error('Error adjusting fiscal-year opening stock:', error);
      return res.status(500).json({ message: `Unable to adjust fiscal-year opening stock: ${error.message}` });
    }
  }
);

// ========== FISCAL-YEAR VENDOR OPENING BALANCES (Vendor Ledger roll-forward) ==========

// View the vendor opening balance register for a fiscal year: every supplier ×
// branch row (including zero rows) with names, source, and audit fields.
expressApp.get(
  '/api/fiscal-years/:id/vendor-opening-balances',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const fyRes = await pgPool.query(
        `SELECT id, code,
                start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                is_current AS "isCurrent", is_closed AS "isClosed"
         FROM fiscal_years WHERE id = $1`,
        [id]
      );
      const fy = fyRes.rows[0];
      if (!fy) return res.status(404).json({ message: 'Fiscal year not found.' });

      const rowsRes = await pgPool.query(
        `SELECT 'vopen-' || o.fiscal_year_id || '-' || o.supplier_id || '-' || o.branch_id AS id,
                o.supplier_id AS "supplierId",
                COALESCE(s.name, 'Deleted supplier') AS "supplierName",
                COALESCE(s.supplier_code, '-') AS "supplierCode",
                o.branch_id AS "branchId",
                COALESCE(b.name, 'Deleted branch') AS "branchName",
                o.opening_balance::float AS "openingBalance",
                o.source_type AS "sourceType",
                o.source_reference AS "sourceReference",
                o.posted_at::text AS "postedAt",
                o.posted_by AS "postedBy"
         FROM vendor_opening_balances o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN branches b ON b.id = o.branch_id
         WHERE o.fiscal_year_id = $1
         ORDER BY s.name ASC, b.name ASC`,
        [id]
      );

      const rows = rowsRes.rows;
      const stats = {
        totalRows: rows.length,
        manualAdjustments: rows.filter((r: any) => r.sourceType === 'MANUAL_ADJUSTMENT').length,
        zeroRows: rows.filter((r: any) => Number(r.openingBalance) === 0).length,
        totalDebitOpening: rows.reduce(
          (sum: number, r: any) => sum + (Number(r.openingBalance) > 0 ? Number(r.openingBalance) : 0),
          0
        ),
        totalCreditOpening: rows.reduce(
          (sum: number, r: any) => sum + (Number(r.openingBalance) < 0 ? Math.abs(Number(r.openingBalance)) : 0),
          0
        ),
      };

      return res.json({ fiscalYear: fy, rows, stats });
    } catch (error: any) {
      console.error('Error fetching vendor opening balances register:', error);
      return res.status(500).json({ message: `Unable to load vendor opening balances: ${error.message}` });
    }
  }
);

// Manual vendor opening balance adjustment (batch). Allowed only while the fiscal
// year is OPEN — closed years are period-locked and require Super Admin reopen.
// Every touched row is re-stamped as MANUAL_ADJUSTMENT with the authorizing user.
expressApp.put(
  '/api/fiscal-years/:id/vendor-opening-balances',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'),
  async (req, res) => {
    const { id } = req.params;
    const user = getUserFromReq(req);
    const incoming: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];

    try {
      const fyRes = await pgPool.query('SELECT id, code, is_closed AS "isClosed" FROM fiscal_years WHERE id = $1', [id]);
      const fy = fyRes.rows[0];
      if (!fy) return res.status(404).json({ message: 'Fiscal year not found.' });
      if (fy.isClosed) {
        return res.status(403).json({
          message:
            'This fiscal year is closed and period-locked. Reopen it with Super Admin authorization before adjusting vendor opening balances.',
        });
      }
      if (incoming.length === 0) {
        return res.status(400).json({ message: 'No vendor opening-balance rows were provided to adjust.' });
      }

      const [supRes, branchRes] = await Promise.all([
        pgPool.query('SELECT id, name FROM suppliers'),
        pgPool.query('SELECT id, name FROM branches'),
      ]);
      const supplierNameById = new Map<string, string>(supRes.rows.map((r: any) => [r.id, r.name]));
      const branchNameById = new Map<string, string>(branchRes.rows.map((r: any) => [r.id, r.name]));

      // ---- Validate every row BEFORE writing anything (all-or-nothing) ----
      const updates: Array<{ supplierId: string; branchId: string; openingBalance: number }> = [];

      for (const item of incoming) {
        const supplierId = String(item?.supplierId || '').trim();
        const branchId = String(item?.branchId || '').trim();
        const openingBalance = Number(item?.openingBalance ?? 0);
        const label = `${supplierNameById.get(supplierId) || supplierId || 'unknown supplier'} @ ${
          branchNameById.get(branchId) || branchId || 'unknown branch'
        }`;

        if (!supplierId || !supplierNameById.has(supplierId)) {
          return res.status(400).json({ message: `Invalid supplier reference in vendor opening-balance adjustment: ${label}` });
        }
        if (!branchId || !branchNameById.has(branchId)) {
          return res.status(400).json({ message: `Invalid branch reference in vendor opening-balance adjustment: ${label}` });
        }
        if (Number.isNaN(openingBalance)) {
          return res.status(400).json({ message: `Opening balance must be a number for ${label}.` });
        }

        updates.push({ supplierId, branchId, openingBalance });
      }

      const result = await withTransaction(async (client) => {
        const changeLog: string[] = [];
        let createdCount = 0;

        for (const u of updates) {
          const beforeRes = await client.query(
            `SELECT opening_balance::float AS "openingBalance"
             FROM vendor_opening_balances
             WHERE fiscal_year_id = $1 AND supplier_id = $2 AND branch_id = $3`,
            [id, u.supplierId, u.branchId]
          );
          const before = beforeRes.rows[0];

          const afterRes = await client.query(
            `INSERT INTO vendor_opening_balances (
               id, fiscal_year_id, supplier_id, branch_id, opening_balance,
               source_type, source_reference, posted_at, posted_by
             )
             VALUES (
               'vopen-' || $1::text || '-' || $2 || '-' || $3,
               $1, $2, $3, $4,
               'MANUAL_ADJUSTMENT', 'MANUAL_ADJUSTMENT', CURRENT_TIMESTAMP, $5
             )
             ON CONFLICT (fiscal_year_id, supplier_id, branch_id) DO UPDATE SET
               opening_balance = EXCLUDED.opening_balance,
               source_type = 'MANUAL_ADJUSTMENT',
               source_reference = 'MANUAL_ADJUSTMENT',
               posted_at = CURRENT_TIMESTAMP,
               posted_by = EXCLUDED.posted_by
             RETURNING id`,
            [id, u.supplierId, u.branchId, u.openingBalance, user.email || 'system']
          );

          if (!afterRes.rowCount) continue;
          if (!before) createdCount++;
          const fmt = (v: number) => `NPR ${v.toLocaleString()}`;
          changeLog.push(
            `${before ? 'updated' : 'created'} ${supplierNameById.get(u.supplierId)} @ ${branchNameById.get(u.branchId)}: ` +
              `${before ? fmt(Number(before.openingBalance)) : '—'} -> ${fmt(u.openingBalance)}`
          );
        }

        return { appliedCount: changeLog.length, createdCount, changeLog };
      });

      if (result.appliedCount > 0) {
        const details =
          `Adjusted ${result.appliedCount} vendor opening-balance row(s) for fiscal year ${fy.code}` +
          (result.createdCount ? ` (${result.createdCount} created)` : '') +
          ` [${result.changeLog.slice(0, 15).join('; ')}${result.changeLog.length > 15 ? ' …' : ''}] ` +
          `(by ${user.email || 'system'})`;
        logAuditEvent(req, 'ADJUST_VENDOR_OPENING_BALANCE', 'FISCAL_YEAR', details);
      }

      return res.json({
        applied: result.appliedCount,
        created: result.createdCount,
        message: `${result.appliedCount} vendor opening-balance row(s) saved for fiscal year ${fy.code}.`,
      });
    } catch (error: any) {
      console.error('Error adjusting vendor opening balances:', error);
      return res.status(500).json({ message: `Unable to adjust vendor opening balances: ${error.message}` });
    }
  }
);

// Close the vendor ledger for a source fiscal year and roll each supplier × branch
// closing balance forward into the next fiscal year's opening balance. The closing
// balance is the net of all invoices (debits) minus posted payments (credits)
// dated within the source fiscal year, plus any persisted opening balance carried
// into that source year. Manual rows on the target year are preserved (not
// overwritten) — matching the opening-stock roll-forward policy.
expressApp.post(
  '/api/fiscal-years/:id/roll-forward-vendor-openings',
  requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER', 'ACCOUNTANT'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const result = await withTransaction(async (client) => {
        const sourceResult = await client.query(
          'SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD", is_closed AS "isClosed" FROM fiscal_years WHERE id = $1 FOR UPDATE;',
          [id]
        );
        const sourceFiscalYear = sourceResult.rows[0];
        if (!sourceFiscalYear) {
          const error: any = new Error('Source fiscal year not found.');
          error.statusCode = 404;
          throw error;
        }
        if (!sourceFiscalYear.isClosed) {
          const error: any = new Error('Close and lock the source fiscal year before rolling forward vendor opening balances.');
          error.statusCode = 400;
          throw error;
        }

        const targetResult = await client.query(
          `SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
                  start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
                  is_current AS "isCurrent", is_closed AS "isClosed"
           FROM fiscal_years WHERE start_date_ad > $1 ORDER BY start_date_ad ASC LIMIT 1 FOR UPDATE;`,
          [sourceFiscalYear.startDateAD]
        );
        const targetFiscalYear = targetResult.rows[0];
        if (!targetFiscalYear) {
          const error: any = new Error('Create the next fiscal year before rolling forward vendor opening balances.');
          error.statusCode = 400;
          throw error;
        }

        const existingRes = await client.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE source_type = 'MANUAL_ADJUSTMENT')::int AS manual
           FROM vendor_opening_balances WHERE fiscal_year_id = $1`,
          [targetFiscalYear.id]
        );
        const manualRowsPreserved = existingRes.rows[0]?.manual || 0;

        const inserted = await client.query(
          `INSERT INTO vendor_opening_balances (
             id, fiscal_year_id, supplier_id, branch_id, opening_balance, source_type, source_reference, posted_by
           )
           WITH ledger AS (
             SELECT
               COALESCE(inv.supplier_id, o.supplier_id) AS supplier_id,
               COALESCE(inv.branch_id, o.branch_id) AS branch_id,
               COALESCE(o.opening_balance, 0)
                 + COALESCE(SUM(inv.grand_total), 0)
                 - COALESCE(
                     (SELECT COALESCE(SUM(p.amount), 0) FROM vendor_payments p
                      WHERE p.supplier_id = COALESCE(inv.supplier_id, o.supplier_id)
                        AND p.branch_id = COALESCE(inv.branch_id, o.branch_id)
                        AND p.status = 'POSTED'
                        AND p.payment_date_ad >= $2::date
                        AND p.payment_date_ad <= $3::date),
                     0
                   ) AS closing_balance
             FROM (
               SELECT DISTINCT supplier_id, branch_id
               FROM (
                 SELECT supplier_id, branch_id FROM purchase_invoices
                 WHERE invoice_date_ad >= $2::date AND invoice_date_ad <= $3::date
                 UNION
                 SELECT supplier_id, branch_id FROM vendor_payments
                 WHERE payment_date_ad >= $2::date AND payment_date_ad <= $3::date
               ) t1
             ) drv
             LEFT JOIN purchase_invoices inv
               ON inv.supplier_id = drv.supplier_id
              AND inv.branch_id = drv.branch_id
              AND inv.invoice_date_ad >= $2::date
              AND inv.invoice_date_ad <= $3::date
             LEFT JOIN vendor_opening_balances o
               ON o.fiscal_year_id = $1
              AND o.supplier_id = drv.supplier_id
              AND o.branch_id = drv.branch_id
             GROUP BY inv.supplier_id, inv.branch_id, o.supplier_id, o.branch_id, o.opening_balance
           )
           SELECT
             'vopen-' || $4 || '-' || ledger.supplier_id || '-' || ledger.branch_id,
             $4,
             ledger.supplier_id,
             ledger.branch_id,
             ROUND(ledger.closing_balance, 2),
             'FISCAL_CLOSE',
             $5,
             $6
           FROM ledger
           WHERE ledger.supplier_id IS NOT NULL AND ledger.branch_id IS NOT NULL
           ON CONFLICT (fiscal_year_id, supplier_id, branch_id) DO UPDATE SET
             opening_balance = EXCLUDED.opening_balance,
             source_type = EXCLUDED.source_type,
             source_reference = EXCLUDED.source_reference,
             posted_at = CURRENT_TIMESTAMP,
             posted_by = EXCLUDED.posted_by
           WHERE vendor_opening_balances.source_type <> 'MANUAL_ADJUSTMENT'
           RETURNING id;`,
          [
            targetFiscalYear.id,
            sourceFiscalYear.startDateAD,
            sourceFiscalYear.endDateAD,
            targetFiscalYear.id,
            sourceFiscalYear.code,
            getUserFromReq(req).email || 'system',
          ]
        );

        return { targetFiscalYear, recordsCreated: inserted.rowCount || 0, manualRowsPreserved };
      });

      logAuditEvent(
        req,
        'ROLLFORWARD_VENDOR_OPENINGS',
        'FISCAL_YEAR',
        `Rolled forward ${result.recordsCreated} vendor opening-balance record(s) into ${result.targetFiscalYear.code}${
          result.manualRowsPreserved ? `; ${result.manualRowsPreserved} manual adjustment row(s) preserved` : ''
        }`
      );
      return res.json(result);
    } catch (error: any) {
      if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
      console.error('Error rolling forward vendor opening balances:', error);
      return res.status(500).json({ message: `Unable to roll forward vendor opening balances: ${error.message}` });
    }
  }
);
}
