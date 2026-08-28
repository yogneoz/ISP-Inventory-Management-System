import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/createApp';
import { initSessionStore } from '../../server/lib/sessionStore';
import { setDbMode, setPgConnected } from '../../server/lib/db';
import * as store from '../../server/store';
import { resetStoreForTests } from '../helpers/testStore';

/**
 * When durable PG mode is on, a failed writeThroughPg must not leave
 * orphan memory state and must surface HTTP 503.
 *
 * We force durable mode and stub pgPool.query to throw inside the route.
 */
describe('API durable write failure surface', () => {
  const app = createApp();
  let token = '';
  let adminPassword = 'TestAdmin@123';

  beforeEach(async () => {
    await initSessionStore();
    const seeded = await resetStoreForTests({ withAdmin: true });
    adminPassword = seeded.adminPassword;

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: adminPassword })
      .expect(200);
    token = login.body.token;
  });

  afterEach(() => {
    setPgConnected(false);
    setDbMode('memory');
  });

  it('returns 503 and rolls back memory when durable product create fails', async () => {
    // Dynamic import so we can stub the same module instance routes use
    const db = await import('../../server/lib/db');
    const originalQuery = db.pgPool.query.bind(db.pgPool);

    setDbMode('postgres');
    setPgConnected(true);

    db.pgPool.query = async () => {
      throw new Error('simulated unique_violation on products_sku_key');
    };

    const beforeCount = store.products.length;

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Should Not Persist',
        sku: 'FAIL-SKU-1',
        category: 'Test',
        costPrice: 1,
        sellingPrice: 2,
      });

    // Restore stub before assertions that might throw
    db.pgPool.query = originalQuery;
    setPgConnected(false);
    setDbMode('memory');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DURABLE_WRITE_FAILED');
    expect(res.body.durable).toBe(true);
    expect(String(res.body.message || '')).toMatch(/not saved/i);

    // Memory must not keep the failed create
    expect(store.products.length).toBe(beforeCount);
    expect(store.products.some((p) => p.sku === 'FAIL-SKU-1')).toBe(false);
  });
});
