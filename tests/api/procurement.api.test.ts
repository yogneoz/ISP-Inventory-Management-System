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

describe('API procurement — purchase order create & receive', () => {
  const app = createApp();
  let token = '';
  let adminPassword = 'TestAdmin@123';
  let productId = '';

  beforeEach(async () => {
    setPgConnected(false);
    setDbMode('memory');
    await initSessionStore();
    const seeded = await resetStoreForTests({ withAdmin: true });
    adminPassword = seeded.adminPassword;
    const { product } = seedBasicCatalog();
    productId = product.id;
    token = await login(app, adminPassword);
  });

  it('creates a draft PO and bumps incoming qty', async () => {
    const stock = store.inventoryStock.find(
      (s) => s.productId === productId && s.branchId === 'WH001'
    )!;
    const incomingBefore = stock.incomingQty || 0;

    const res = await request(app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        supplierName: 'Test Fiber Vendor',
        branchId: 'WH001',
        status: 'APPROVED',
        items: [
          {
            id: 'poi-1',
            productId,
            productName: 'Test Fiber ONU',
            sku: 'ONU-TEST-001',
            quantity: 6,
            unitPrice: 2500,
            taxRate: 13,
            subtotal: 15000,
            taxAmount: 1950,
            total: 16950,
          },
        ],
      })
      .expect(201);

    expect(res.body.poNumber).toBeTruthy();
    expect(res.body.totalAmount).toBeGreaterThan(0);
    expect(store.purchaseOrders.some((p) => p.id === res.body.id)).toBe(true);

    const after = store.inventoryStock.find(
      (s) => s.productId === productId && s.branchId === 'WH001'
    )!;
    expect(after.incomingQty || 0).toBe(incomingBefore + 6);
  });

  it('receives a PO and moves incoming into on-hand', async () => {
    const stock = store.inventoryStock.find(
      (s) => s.productId === productId && s.branchId === 'WH001'
    )!;
    const onHandBefore = stock.quantityOnHand;
    const qty = 5;

    const created = await request(app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        supplierName: 'Test Fiber Vendor',
        branchId: 'WH001',
        status: 'APPROVED',
        items: [
          {
            id: 'poi-1',
            productId,
            productName: 'Test Fiber ONU',
            sku: 'ONU-TEST-001',
            quantity: qty,
            unitPrice: 2500,
            taxRate: 13,
            subtotal: 12500,
            taxAmount: 1625,
            total: 14125,
          },
        ],
      })
      .expect(201);

    const incomingAfterCreate =
      store.inventoryStock.find((s) => s.productId === productId && s.branchId === 'WH001')!
        .incomingQty || 0;
    expect(incomingAfterCreate).toBeGreaterThanOrEqual(qty);

    const received = await request(app)
      .post(`/api/purchase-orders/${created.body.id}/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);

    expect(received.body.status).toBe('RECEIVED');
    const after = store.inventoryStock.find(
      (s) => s.productId === productId && s.branchId === 'WH001'
    )!;
    expect(after.quantityOnHand).toBe(onHandBefore + qty);
    expect(after.incomingQty || 0).toBe(incomingAfterCreate - qty);
  });
});
