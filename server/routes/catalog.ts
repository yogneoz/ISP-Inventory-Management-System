/**
 * Route module: catalog
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

router.get('/api/products', async (req, res) => {
  if (isPgConnected) {
    try {
      const r = await pgPool.query(
        'SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products ORDER BY created_at DESC'
      );
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching products from DB:', err);
    }
  }
  res.json(store.products);
});

router.post('/api/products', async (req, res) => {
  try {
    const newProd = {
      id: `prod-${Date.now()}`,
      sku: req.body.sku || `SKU-${Date.now()}`,
      barcode: req.body.barcode || '',
      name: req.body.name || 'Untitled Product',
      category: req.body.category || 'General',
      productGroup: req.body.productGroup || 'Product Item',
      unit: req.body.unit || 'Pcs',
      costPrice: Number(req.body.costPrice) || 0,
      sellingPrice: Number(req.body.sellingPrice) || 0,
      taxRate: Number(req.body.taxRate) || 13,
      minReorderLevel: Number(req.body.minReorderLevel) || 5,
      requiresSerialTracking: Boolean(req.body.requiresSerialTracking),
      trackingType: req.body.trackingType || 'QUANTITY_ONLY',
      description: req.body.description || '',
      status: req.body.status || 'ACTIVE',
    };
    store.products.push(newProd);

    // Initialize 0 stock across all branches
    const newStockItems: any[] = [];
    store.branches.forEach((b) => {
      const stkItem = {
        id: `stk-${Date.now()}-${b.id}`,
        productId: newProd.id,
        branchId: b.id,
        quantityOnHand: 0,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: newProd.minReorderLevel,
        lastUpdated: new Date().toISOString(),
      };
      store.inventoryStock.push(stkItem);
      newStockItems.push(stkItem);
    });

    // PostgreSQL database insertion
    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           sku = EXCLUDED.sku,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           selling_price = EXCLUDED.selling_price;`,
        [
          newProd.id,
          newProd.sku,
          newProd.barcode,
          newProd.name,
          newProd.category,
          newProd.productGroup,
          newProd.unit,
          newProd.costPrice,
          newProd.sellingPrice,
          newProd.taxRate,
          newProd.minReorderLevel,
          newProd.requiresSerialTracking,
          newProd.trackingType,
          newProd.description,
          newProd.status,
        ]
      );

      for (const stk of newStockItems) {
        await pgPool.query(
          `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING;`,
          [stk.id, stk.productId, stk.branchId, stk.quantityOnHand, stk.damagedQty, stk.reservedQty, stk.incomingQty, stk.minReorderLevel]
        );
      }
    }

    store.saveDataStore();
    logAuditEvent(req, 'CREATE_PRODUCT', 'PRODUCTS', `Created new product SKU ${newProd.sku} (${newProd.name}) - Price: NPR ${newProd.sellingPrice}`);
    res.status(201).json(newProd);
  } catch (err: any) {
    console.error('Error creating product in database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

router.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = store.products.findIndex((p) => p.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Product not found' });

    const oldProd = { ...store.products[idx] };
    store.products[idx] = { ...store.products[idx], ...req.body };
    const updated = store.products[idx];

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE products SET
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
         WHERE id = $15;`,
        [
          updated.sku,
          updated.barcode || '',
          updated.name,
          updated.category,
          updated.productGroup || 'Product Item',
          updated.unit || 'Pcs',
          Number(updated.costPrice) || 0,
          Number(updated.sellingPrice) || 0,
          Number(updated.taxRate) || 13,
          Number(updated.minReorderLevel) || 5,
          Boolean(updated.requiresSerialTracking),
          updated.trackingType || 'QUANTITY_ONLY',
          updated.description || '',
          updated.status || 'ACTIVE',
          id,
        ]
      );
    }

    store.saveDataStore();
    const changeMsg = oldProd.sku !== updated.sku
      ? `SKU updated from ${oldProd.sku} to ${updated.sku}`
      : `Updated product details for ${updated.name} (${updated.sku})`;

    logAuditEvent(req, 'UPDATE_PRODUCT_SKU', 'PRODUCTS', changeMsg);
    res.json(store.products[idx]);
  } catch (err: any) {
    console.error('Error updating product in database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

router.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const prod = store.products.find((p) => p.id === id);
    { const __filtered = store.products.filter((p) => p.id !== id); store.products.length = 0; store.products.push(...__filtered); }
    { const __filtered = store.inventoryStock.filter((s) => s.productId !== id); store.inventoryStock.length = 0; store.inventoryStock.push(...__filtered); }

    if (isPgConnected) {
      await pgPool.query('DELETE FROM products WHERE id = $1;', [id]);
    }

    store.saveDataStore();
    logAuditEvent(req, 'DELETE_PRODUCT', 'PRODUCTS', `Deleted product ${prod?.name || id} (SKU: ${prod?.sku || 'N/A'})`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting product from database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Categories API
router.get('/api/categories', async (req, res) => {
  if (isPgConnected) {
    try {
      const { rows } = await pgPool.query('SELECT id, name, code, description FROM categories ORDER BY name ASC');
      return res.json(rows);
    } catch (err: any) {
      console.warn('Database note on GET /api/categories:', err?.message || err);
    }
  }
  res.json(store.categories);
});

router.post('/api/categories', async (req, res) => {
  try {
    const newCat: Category = {
      id: req.body.id || `cat-${Date.now()}`,
      name: req.body.name || 'New Category',
      code: req.body.code || `CAT-${Date.now().toString().slice(-4)}`,
      description: req.body.description || '',
    };
    const existingIdx = store.categories.findIndex((c) => c.id === newCat.id || c.name.toLowerCase() === newCat.name.toLowerCase());
    if (existingIdx !== -1) {
      store.categories[existingIdx] = newCat;
    } else {
      store.categories.push(newCat);
    }

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO categories (id, name, code, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           description = EXCLUDED.description;`,
        [newCat.id, newCat.name, newCat.code, newCat.description]
      );
    }

    store.saveDataStore();
    logAuditEvent(req, 'CREATE_CATEGORY', 'CATEGORIES', `Created category ${newCat.name} (${newCat.code})`);
    res.status(201).json(newCat);
  } catch (err: any) {
    console.error('Error creating category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

router.put('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = store.categories.findIndex((c) => c.id === id);
    if (idx !== -1) {
      store.categories[idx] = { ...store.categories[idx], ...req.body };
    }
    const updated = store.categories[idx] || { id, ...req.body };

    if (isPgConnected) {
      await pgPool.query(
        `UPDATE categories SET name = $1, code = $2, description = $3 WHERE id = $4;`,
        [updated.name, updated.code, updated.description, id]
      );
    }

    store.saveDataStore();
    logAuditEvent(req, 'UPDATE_CATEGORY', 'CATEGORIES', `Updated category ${updated.name}`);
    res.json(updated);
  } catch (err: any) {
    console.error('Error updating category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

router.delete('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cat = store.categories.find((c) => c.id === id);
    { const __filtered = store.categories.filter((c) => c.id !== id); store.categories.length = 0; store.categories.push(...__filtered); }

    if (isPgConnected) {
      await pgPool.query('DELETE FROM categories WHERE id = $1;', [id]);
    }

    store.saveDataStore();
    logAuditEvent(req, 'DELETE_CATEGORY', 'CATEGORIES', `Deleted category ${cat?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// Stock

export default router;
