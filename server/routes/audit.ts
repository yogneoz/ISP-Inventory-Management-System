/**
 * Route module: audit
 */
import { Router } from 'express';
import * as store from '../store';

import { readPgOrStore, num } from '../lib/pgReads';

const router = Router();

router.get('/api/audit-trail', async (req, res) => {
  const { branchId, module, limit } = req.query as any;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const lim = Math.min(Number(limit) || 200, 1000);
  const params: any[] = [];
  let where: string[] = [];
  if (bf) { params.push(bf); where.push(`branch_id = $${params.length}`); }
  if (module && module !== 'ALL') { params.push(String(module)); where.push(`module = $${params.length}`); }
  const safeSql =
    `SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details,
            timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId"
     FROM audit_logs` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ` ORDER BY timestamp_ad DESC LIMIT ${lim}`;
  let rows = await readPgOrStore<any>({
    label: 'audit.list',
    sql: safeSql,
    params,
    fallback: () => {
      let list = [...store.auditTrail];
      if (bf) list = list.filter((a) => a.branchId === bf);
      if (module && module !== 'ALL') list = list.filter((a) => a.module === module);
      return list.slice(0, lim);
    },
  });
  res.json(rows);
});

router.get('/api/transaction-logs', async (req, res) => {
  const { branchId, limit } = req.query as any;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const lim = Math.min(Number(limit) || 300, 2000);
  const params: any[] = [];
  let where: string[] = [];
  if (bf) { params.push(bf); where.push(`branch_id = $${params.length}`); }
  const safeSql =
    `SELECT id, transaction_number AS "transactionNumber", product_id AS "productId",
            product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId",
            change_type AS "changeType", quantity_before AS "quantityBefore",
            quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter",
            unit_cost AS "unitCost", reference_doc_id AS "referenceDocId",
            timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS"
     FROM transaction_logs` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ` ORDER BY timestamp_ad DESC LIMIT ${lim}`;
  const rows = await readPgOrStore<any>({
    label: 'txn.list',
    sql: safeSql,
    params,
    fallback: () => {
      let list = [...store.transactionLogs];
      if (bf) list = list.filter((x) => x.branchId === bf);
      return list.slice(0, lim);
    },
    map: (r) => ({
      ...r,
      quantityBefore: num(r.quantityBefore),
      quantityChanged: num(r.quantityChanged),
      quantityAfter: num(r.quantityAfter),
      unitCost: num(r.unitCost),
    }),
  });
  res.json(rows);
});

// Customer Device & Serial Number Lookup

export default router;
