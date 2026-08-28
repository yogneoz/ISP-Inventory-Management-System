import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  snapshotStore,
  restoreSnapshot,
  writeThroughPg,
  DurableWriteError,
  isDurableWriteError,
  sendWriteFailure,
  runDurableMutation,
} from '../../server/lib/writeGuard';
import * as store from '../../server/store';
import { setDbMode, setPgConnected } from '../../server/lib/db';
import type { Product } from '../../src/types';
import type { Response } from 'express';

function makeProduct(id: string, sku: string): Product {
  return {
    id,
    sku,
    barcode: '',
    name: `Product ${sku}`,
    category: 'Test',
    unit: 'Pcs',
    costPrice: 100,
    sellingPrice: 150,
    taxRate: 13,
    minReorderLevel: 2,
  };
}

function mockRes() {
  const state: { statusCode?: number; body?: any } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: any) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

describe('writeGuard', () => {
  beforeEach(() => {
    store.replaceCollection('products', []);
    store.replaceCollection('inventoryStock', []);
    setPgConnected(false);
    setDbMode('memory');
  });

  afterEach(() => {
    setPgConnected(false);
    setDbMode('memory');
  });

  describe('snapshotStore / restoreSnapshot', () => {
    it('deep-clones collections and restores after mutation', () => {
      store.products.push(makeProduct('p1', 'SKU-1'));
      const snap = snapshotStore(['products']);

      store.products.push(makeProduct('p2', 'SKU-2'));
      store.products[0].name = 'MUTATED';
      expect(store.products).toHaveLength(2);
      expect(store.products[0].name).toBe('MUTATED');

      restoreSnapshot(snap);
      expect(store.products).toHaveLength(1);
      expect(store.products[0].id).toBe('p1');
      expect(store.products[0].name).toBe('Product SKU-1');
    });

    it('no-ops on null/undefined snapshot', () => {
      store.products.push(makeProduct('p1', 'SKU-1'));
      expect(() => restoreSnapshot(null)).not.toThrow();
      expect(() => restoreSnapshot(undefined)).not.toThrow();
      expect(store.products).toHaveLength(1);
    });
  });

  describe('writeThroughPg', () => {
    it('skips SQL work when not on durable Postgres', async () => {
      let called = false;
      const result = await writeThroughPg('TEST_OP', async () => {
        called = true;
      });
      expect(result.wroteToPg).toBe(false);
      expect(called).toBe(false);
    });

    it('runs SQL work and returns wroteToPg=true in durable mode', async () => {
      setDbMode('postgres');
      setPgConnected(true);
      let called = false;
      const result = await writeThroughPg('TEST_OK', async () => {
        called = true;
      });
      expect(result.wroteToPg).toBe(true);
      expect(called).toBe(true);
    });

    it('throws DurableWriteError when durable SQL fails', async () => {
      setDbMode('postgres');
      setPgConnected(true);
      await expect(
        writeThroughPg('CREATE_PRODUCT', async () => {
          throw new Error('duplicate key value violates unique constraint');
        })
      ).rejects.toBeInstanceOf(DurableWriteError);

      try {
        await writeThroughPg('CREATE_PRODUCT', async () => {
          throw new Error('boom');
        });
      } catch (err) {
        expect(isDurableWriteError(err)).toBe(true);
        if (isDurableWriteError(err)) {
          expect(err.operation).toBe('CREATE_PRODUCT');
          expect(err.statusCode).toBe(503);
          expect(err.message).toMatch(/CREATE_PRODUCT/);
          expect(err.message).toMatch(/not saved/i);
          expect(err.causeMessage).toBe('boom');
        }
      }
    });
  });

  describe('runDurableMutation', () => {
    it('restores snapshot when mutator throws', async () => {
      store.products.push(makeProduct('p1', 'SKU-1'));
      await expect(
        runDurableMutation({
          operation: 'TEST',
          collections: ['products'],
          mutate: async () => {
            store.products.push(makeProduct('p2', 'SKU-2'));
            throw new Error('fail');
          },
        })
      ).rejects.toThrow('fail');
      expect(store.products).toHaveLength(1);
      expect(store.products[0].id).toBe('p1');
    });

    it('keeps mutations when mutator succeeds', async () => {
      const result = await runDurableMutation({
        operation: 'TEST',
        collections: ['products'],
        mutate: async () => {
          store.products.push(makeProduct('p1', 'SKU-1'));
          return 'ok';
        },
      });
      expect(result).toBe('ok');
      expect(store.products).toHaveLength(1);
    });
  });

  describe('sendWriteFailure', () => {
    it('returns 503 DURABLE_WRITE_FAILED for DurableWriteError', () => {
      const { res, state } = mockRes();
      sendWriteFailure(res, new DurableWriteError('STOCK_OUT', new Error('fk violation')));
      expect(state.statusCode).toBe(503);
      expect(state.body.code).toBe('DURABLE_WRITE_FAILED');
      expect(state.body.operation).toBe('STOCK_OUT');
      expect(state.body.durable).toBe(true);
      expect(state.body.detail).toMatch(/fk violation/);
    });

    it('returns 503 when isPgConnected even for generic errors', () => {
      setDbMode('postgres');
      setPgConnected(true);
      const { res, state } = mockRes();
      sendWriteFailure(res, new Error('unexpected'), 'UPDATE_STOCK');
      expect(state.statusCode).toBe(503);
      expect(state.body.code).toBe('DURABLE_WRITE_FAILED');
      expect(state.body.operation).toBe('UPDATE_STOCK');
    });

    it('returns 500 WRITE_FAILED when offline', () => {
      setPgConnected(false);
      setDbMode('memory');
      const { res, state } = mockRes();
      sendWriteFailure(res, new Error('nope'), 'CREATE_PRODUCT');
      expect(state.statusCode).toBe(500);
      expect(state.body.code).toBe('WRITE_FAILED');
      expect(state.body.durable).toBe(false);
    });
  });

  describe('durable write + rollback integration pattern', () => {
    it('rolls back memory when writeThroughPg fails after local mutation', async () => {
      setDbMode('postgres');
      setPgConnected(true);

      const snap = snapshotStore(['products', 'inventoryStock']);
      store.products.push(makeProduct('p-new', 'NEW-1'));
      store.inventoryStock.push({
        id: 'stk-1',
        productId: 'p-new',
        branchId: 'WH001',
        quantityOnHand: 10,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        lastUpdated: new Date().toISOString(),
      });

      try {
        await writeThroughPg('CREATE_PRODUCT', async () => {
          throw new Error('connection terminated unexpectedly');
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isDurableWriteError(err)).toBe(true);
        restoreSnapshot(snap);
      }

      expect(store.products).toHaveLength(0);
      expect(store.inventoryStock).toHaveLength(0);
    });
  });
});
