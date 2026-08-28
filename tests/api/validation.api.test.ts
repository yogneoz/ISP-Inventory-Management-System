import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/createApp';
import { initSessionStore } from '../../server/lib/sessionStore';
import { setDbMode, setPgConnected } from '../../server/lib/db';
import { resetStoreForTests } from '../helpers/testStore';

describe('API validation errors', () => {
  const app = createApp();
  let token = '';

  beforeEach(async () => {
    setPgConnected(false);
    setDbMode('memory');
    process.env.DISABLE_RATE_LIMIT = 'true';
    await initSessionStore();
    const seeded = await resetStoreForTests({ withAdmin: true });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: seeded.adminPassword })
      .expect(200);
    token = login.body.token;
  });

  it('rejects invalid login body with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'x' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('rejects product create without sku/name', async () => {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ costPrice: 1 })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects empty PO items', async () => {
    const res = await request(app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ supplierName: 'V', branchId: 'WH001', items: [] })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects shipment without items', async () => {
    const res = await request(app)
      .post('/api/shipments')
      .set('Authorization', `Bearer ${token}`)
      .send({ destinationBranchId: 'ITH01', items: [] })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
