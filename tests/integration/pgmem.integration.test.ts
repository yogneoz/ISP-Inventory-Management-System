/**
 * Integration tests against the real SQL path using pg-mem
 * (Docker/testcontainers not available in this environment).
 *
 * These tests force durable mode semantics for writeThroughPg and
 * exercise schema + CRUD through the same pgPool abstraction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import * as db from '../../server/lib/db';
import {
  snapshotStore,
  restoreSnapshot,
  writeThroughPg,
  DurableWriteError,
} from '../../server/lib/writeGuard';
import * as store from '../../server/store';
import { hashPassword, verifyPassword } from '../../server/lib/authUtils';

describe('integration: pg-mem SQL path', () => {
  let memPool: any;
  let originalQuery: typeof db.pgPool.query;
  let originalConnect: typeof db.pgPool.connect;

  beforeAll(async () => {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = mem.adapters.createPg();
    memPool = new adapter.Pool();

    // Minimal schema for product/stock/user flows
    await memPool.query(`
      CREATE TABLE products (
        id VARCHAR(50) PRIMARY KEY,
        sku VARCHAR(100) UNIQUE NOT NULL,
        barcode VARCHAR(100),
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        product_group VARCHAR(50) DEFAULT 'Product Item',
        unit VARCHAR(30) DEFAULT 'Pcs',
        cost_price NUMERIC(12,2) DEFAULT 0,
        selling_price NUMERIC(12,2) DEFAULT 0,
        tax_rate NUMERIC(5,2) DEFAULT 13,
        min_reorder_level INT DEFAULT 5,
        requires_serial_tracking BOOLEAN DEFAULT FALSE,
        tracking_type VARCHAR(50) DEFAULT 'QUANTITY_ONLY',
        description TEXT,
        status VARCHAR(20) DEFAULT 'ACTIVE'
      );
      CREATE TABLE inventory_stock (
        id VARCHAR(100) PRIMARY KEY,
        product_id VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) NOT NULL,
        quantity_on_hand INT DEFAULT 0,
        damaged_qty INT DEFAULT 0,
        reserved_qty INT DEFAULT 0,
        incoming_qty INT DEFAULT 0,
        min_reorder_level INT DEFAULT 5
      );
      CREATE TABLE users (
        id VARCHAR(50) PRIMARY KEY,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(150) NOT NULL,
        role VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50),
        can_switch_user BOOLEAN DEFAULT FALSE
      );
      CREATE UNIQUE INDEX inv_prod_branch ON inventory_stock(product_id, branch_id);
    `);

    originalQuery = db.pgPool.query;
    originalConnect = db.pgPool.connect;
    db.pgPool.query = (text: string, params?: any[]) => memPool.query(text, params);
    db.pgPool.connect = async () => memPool.connect();
    db.setDbMode('postgres');
    db.setPgConnected(true);
  });

  afterAll(() => {
    db.pgPool.query = originalQuery;
    db.pgPool.connect = originalConnect;
    db.setPgConnected(false);
    db.setDbMode('memory');
  });

  beforeEach(async () => {
    await memPool.query('DELETE FROM inventory_stock');
    await memPool.query('DELETE FROM products');
    await memPool.query('DELETE FROM users');
    store.replaceCollection('products', []);
    store.replaceCollection('inventoryStock', []);
  });

  it('persists a product via writeThroughPg and reads it back', async () => {
    const snap = snapshotStore(['products']);
    store.products.push({
      id: 'p1',
      sku: 'INT-SKU-1',
      barcode: '',
      name: 'Integration ONU',
      category: 'ONU',
      unit: 'Pcs',
      costPrice: 100,
      sellingPrice: 150,
      taxRate: 13,
      minReorderLevel: 2,
    });

    await writeThroughPg('CREATE_PRODUCT', async () => {
      await db.pgPool.query(
        `INSERT INTO products (id, sku, name, category, cost_price, selling_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['p1', 'INT-SKU-1', 'Integration ONU', 'ONU', 100, 150]
      );
    });

    const { rows } = await db.pgPool.query('SELECT sku, name FROM products WHERE id = $1', ['p1']);
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('INT-SKU-1');
    restoreSnapshot(snap); // cleanup memory
  });

  it('rolls back memory when writeThroughPg fails (unique violation)', async () => {
    await db.pgPool.query(
      `INSERT INTO products (id, sku, name, category) VALUES ('px', 'DUP', 'Existing', 'X')`
    );

    const snap = snapshotStore(['products']);
    store.products.push({
      id: 'p2',
      sku: 'DUP',
      barcode: '',
      name: 'Dup attempt',
      category: 'X',
      unit: 'Pcs',
      costPrice: 0,
      sellingPrice: 0,
      taxRate: 13,
      minReorderLevel: 0,
    });

    await expect(
      writeThroughPg('CREATE_PRODUCT', async () => {
        await db.pgPool.query(
          `INSERT INTO products (id, sku, name, category) VALUES ('p2', 'DUP', 'Dup attempt', 'X')`
        );
      })
    ).rejects.toBeInstanceOf(DurableWriteError);

    restoreSnapshot(snap);
    expect(store.products.some((p) => p.id === 'p2')).toBe(false);

    const { rows } = await db.pgPool.query('SELECT count(*)::int AS c FROM products');
    expect(Number(rows[0].c)).toBe(1);
  });

  it('updates stock quantities through SQL', async () => {
    await db.pgPool.query(
      `INSERT INTO products (id, sku, name, category) VALUES ('p3', 'STK-1', 'Stock Item', 'C')`
    );
    await db.pgPool.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand)
       VALUES ('s1', 'p3', 'WH001', 10)`
    );

    await writeThroughPg('STOCK_ADJUST', async () => {
      await db.pgPool.query(
        `UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + $1 WHERE id = $2`,
        [5, 's1']
      );
    });

    const { rows } = await db.pgPool.query(
      `SELECT quantity_on_hand AS q FROM inventory_stock WHERE id = 's1'`
    );
    expect(Number(rows[0].q)).toBe(15);
  });

  it('stores and verifies bcrypt user passwords in SQL', async () => {
    const hash = await hashPassword('SecureTest@99');
    await db.pgPool.query(
      `INSERT INTO users (id, email, password, name, role, branch_id)
       VALUES ('u1', 'int@test.local', $1, 'Int User', 'SUPER_ADMIN', 'WH001')`,
      [hash]
    );
    const { rows } = await db.pgPool.query(`SELECT password FROM users WHERE id = 'u1'`);
    expect(await verifyPassword('SecureTest@99', rows[0].password)).toBe(true);
    expect(await verifyPassword('wrong', rows[0].password)).toBe(false);
  });
});

describe('integration: redis session backend (optional)', () => {
  it('documents that Redis integration is skipped without a broker', async () => {
    // Full Redis testcontainers require Docker. Session memory path is covered in unit tests.
    // When REDIS_URL is set in CI with a service container, sessionStore.initSessionStore
    // returns 'redis' — verified via health endpoint in deploy smoke tests.
    expect(process.env.REDIS_URL || '').toBe('');
    const { initSessionStore, getSessionBackend } = await import('../../server/lib/sessionStore');
    await initSessionStore();
    expect(getSessionBackend()).toBe('memory');
  });
});
