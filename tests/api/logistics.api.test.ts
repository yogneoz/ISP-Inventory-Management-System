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

function stockOnHand(productId: string, branchId: string) {
  return (
    store.inventoryStock.find((s) => s.productId === productId && s.branchId === branchId)
      ?.quantityOnHand || 0
  );
}

function incomingQty(productId: string, branchId: string) {
  return (
    store.inventoryStock.find((s) => s.productId === productId && s.branchId === branchId)
      ?.incomingQty || 0
  );
}

describe('API logistics — inter-branch shipment lifecycle', () => {
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

    // Ensure destination branch has a stock row
    if (!store.inventoryStock.find((s) => s.productId === productId && s.branchId === 'ITH01')) {
      store.inventoryStock.push({
        id: `stk-ith01-${productId}`,
        productId,
        branchId: 'ITH01',
        quantityOnHand: 5,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        lastUpdated: new Date().toISOString(),
      });
    }

    token = await login(app, adminPassword);
  });

  it('dispatches an inter-branch transfer and deducts source stock', async () => {
    const sourceBefore = stockOnHand(productId, 'WH001');
    const destBefore = stockOnHand(productId, 'ITH01');
    const transferQty = 4;

    const res = await request(app)
      .post('/api/shipments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'INTER_BRANCH',
        sourceBranchId: 'WH001',
        destinationBranchId: 'ITH01',
        status: 'IN_TRANSIT',
        items: [
          {
            id: 'line-1',
            productId,
            productName: 'Test Fiber ONU',
            sku: 'ONU-TEST-001',
            quantitySent: transferQty,
          },
        ],
      })
      .expect(201);

    expect(res.body.trackingCode).toBeTruthy();
    expect(res.body.status).toBe('IN_TRANSIT');
    expect(stockOnHand(productId, 'WH001')).toBe(sourceBefore - transferQty);
    expect(incomingQty(productId, 'ITH01')).toBeGreaterThanOrEqual(transferQty);
    // destination on-hand unchanged until receive
    expect(stockOnHand(productId, 'ITH01')).toBe(destBefore);
  });

  it('receives a transfer and is quantity-conserving across branches', async () => {
    const totalBefore = store.inventoryStock
      .filter((s) => s.productId === productId)
      .reduce((sum, s) => sum + (s.quantityOnHand || 0), 0);

    const transferQty = 3;
    const create = await request(app)
      .post('/api/shipments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'INTER_BRANCH',
        sourceBranchId: 'WH001',
        destinationBranchId: 'ITH01',
        status: 'IN_TRANSIT',
        items: [
          {
            id: 'line-1',
            productId,
            productName: 'Test Fiber ONU',
            sku: 'ONU-TEST-001',
            quantitySent: transferQty,
          },
        ],
      })
      .expect(201);

    const shipmentId = create.body.id as string;
    const sourceAfterDispatch = stockOnHand(productId, 'WH001');
    const destAfterDispatch = stockOnHand(productId, 'ITH01');

    const receive = await request(app)
      .post(`/api/shipments/${shipmentId}/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        receivedByNotes: 'All good',
        receivedItems: [{ itemId: 'line-1', quantityReceived: transferQty }],
      })
      .expect(200);

    expect(receive.body.status).toBe('RECEIVED');
    expect(stockOnHand(productId, 'WH001')).toBe(sourceAfterDispatch);
    expect(stockOnHand(productId, 'ITH01')).toBe(destAfterDispatch + transferQty);

    const totalAfter = store.inventoryStock
      .filter((s) => s.productId === productId)
      .reduce((sum, s) => sum + (s.quantityOnHand || 0), 0);
    expect(totalAfter).toBe(totalBefore);
  });

  it('cancels an in-transit transfer and restores source stock', async () => {
    const sourceBefore = stockOnHand(productId, 'WH001');
    const transferQty = 2;

    const create = await request(app)
      .post('/api/shipments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'INTER_BRANCH',
        sourceBranchId: 'WH001',
        destinationBranchId: 'ITH01',
        status: 'IN_TRANSIT',
        items: [
          {
            id: 'line-1',
            productId,
            productName: 'Test Fiber ONU',
            sku: 'ONU-TEST-001',
            quantitySent: transferQty,
          },
        ],
      })
      .expect(201);

    expect(stockOnHand(productId, 'WH001')).toBe(sourceBefore - transferQty);

    const cancel = await request(app)
      .post(`/api/shipments/${create.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Wrong destination' })
      .expect(200);

    const updated = store.shipments.find((s) => s.id === create.body.id);
    expect(updated?.status).toBe('CANCELLED');
    expect(stockOnHand(productId, 'WH001')).toBe(sourceBefore);
  });
});
