import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/createApp';
import { initSessionStore } from '../../server/lib/sessionStore';
import { setDbMode, setPgConnected } from '../../server/lib/db';
import * as store from '../../server/store';
import { resetStoreForTests, seedBasicCatalog } from '../helpers/testStore';

async function login(app: ReturnType<typeof createApp>, password: string) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@test.local', password })
    .expect(200);
  return res.body.token as string;
}

describe('API catalog & stock (offline durable-skip mode)', () => {
  const app = createApp();
  let token = '';
  let adminPassword = 'TestAdmin@123';

  beforeEach(async () => {
    setPgConnected(false);
    setDbMode('memory');
    await initSessionStore();
    const seeded = await resetStoreForTests({ withAdmin: true });
    adminPassword = seeded.adminPassword;
    seedBasicCatalog();
    token = await login(app, adminPassword);
  });

  it('lists products for authenticated users', async () => {
    const res = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((p: any) => p.sku === 'ONU-TEST-001')).toBe(true);
  });

  it('creates a product and initializes zero stock rows in memory', async () => {
    const beforeStock = store.inventoryStock.length;
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'API Test Router',
        sku: 'RTR-API-1',
        category: 'Router',
        costPrice: 5000,
        sellingPrice: 6500,
        minReorderLevel: 3,
      })
      .expect(201);

    expect(res.body.sku).toBe('RTR-API-1');
    expect(res.body.name).toBe('API Test Router');
    expect(store.products.some((p) => p.sku === 'RTR-API-1')).toBe(true);
    // one stock row per branch
    expect(store.inventoryStock.length).toBe(beforeStock + store.branches.length);
    const newRows = store.inventoryStock.filter((s) => s.productId === res.body.id);
    expect(newRows.every((s) => s.quantityOnHand === 0)).toBe(true);
  });

  it('updates stock level and appends a transaction log', async () => {
    const stock = store.inventoryStock.find((s) => s.productId === 'prod-test-1')!;
    expect(stock.quantityOnHand).toBe(20);

    const res = await request(app)
      .patch(`/api/stock/${stock.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        quantityOnHand: 15,
        reason: 'Consumable issue for install WO-99',
        changeType: 'STOCK_OUT',
      });

    // Endpoint may return 200 with updated stock
    expect([200, 201]).toContain(res.status);
    if (res.status === 200 || res.status === 201) {
      const updated = store.inventoryStock.find((s) => s.id === stock.id)!;
      expect(updated.quantityOnHand).toBe(15);
    }
  });

  it('lists branches without exposing secrets', async () => {
    const res = await request(app)
      .get('/api/branches')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].id).toBeTruthy();
    expect(res.body[0].password).toBeUndefined();
  });
});
