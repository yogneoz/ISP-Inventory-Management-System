/**
 * Route module: audit
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
import {
  requireRole,
  requireAuth,
  logAuditEvent,
  sanitizeUser,
  findUserByIdOrEmail,
  migrateUserPasswordIfNeeded,
  getUserFromReq,
} from '../lib/auth';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  createSession,
  destroySession,
  destroyUserSessions,
  extractBearerToken,
  getTodayBsStamp,
  normalizeRole,
  MIN_PASSWORD_LENGTH,
  getSession,
} from '../lib/authUtils';
import {
  broadcastChange,
  dataVersion,
  setDataVersion,
  bumpDataVersion,
  addSseClient,
  removeSseClient,
  forEachSseClient,
} from '../lib/sync';
import { getGenAIClient } from '../lib/ai';
import type {
  User,
  Supplier,
  Branch,
  Product,
  CompanyProfile,
  InventoryStock,
  Asset,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  StockOperation,
  FiscalYear,
  AuditLog,
  TransactionLog,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  Category,
  UnitOfMeasure,
  LocationRecord,
} from '../../src/types';

const router = Router();

router.get('/api/audit-trail', async (req, res) => {
  const { branchId, limit } = req.query;
  if (isPgConnected) {
    try {
      let sql = `SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs`;
      const params: any[] = [];
      if (branchId && branchId !== 'ALL') {
        sql += ` WHERE branch_id = $1`;
        params.push(branchId);
      }
      sql += ` ORDER BY timestamp_ad DESC`;
      if (limit) {
        params.push(Number(limit));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching audit trail from DB:', err);
    }
  }
  let list = store.auditTrail;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((a) => a.branchId === branchId);
  }
  res.json(list);
});

router.get('/api/transaction-logs', async (req, res) => {
  const { branchId, productId, limit } = req.query;
  if (isPgConnected) {
    try {
      let sql = `SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs`;
      const params: any[] = [];
      const conds: string[] = [];

      if (branchId && branchId !== 'ALL') {
        params.push(branchId);
        conds.push(`branch_id = $${params.length}`);
      }
      if (productId && productId !== 'ALL') {
        params.push(productId);
        conds.push(`product_id = $${params.length}`);
      }
      if (conds.length > 0) {
        sql += ` WHERE ` + conds.join(' AND ');
      }
      sql += ` ORDER BY timestamp_ad DESC`;
      if (limit) {
        params.push(Number(limit));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching transaction logs from DB:', err);
    }
  }
  let list = store.transactionLogs;
  if (branchId && branchId !== 'ALL') {
    list = list.filter((t) => t.branchId === branchId);
  }
  if (productId && productId !== 'ALL') {
    list = list.filter((t) => t.productId === productId);
  }
  res.json(list);
});

// Customer Device & Serial Number Lookup

export default router;
