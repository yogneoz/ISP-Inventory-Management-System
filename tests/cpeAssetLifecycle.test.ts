/**
 * CPE-3 / D1 — fixed asset follows the CPE lifecycle, on real PostgreSQL.
 *
 * The service is exercised against the same tables the controllers write, in
 * real transactions, so the invariants are the production ones:
 *   1. a collection unassigns the asset and credits stock exactly once, even
 *      when the same collection is replayed through a different route key;
 *   2. an unlinked CPE collection is keyed by its CPE row, so replay through a
 *      different route (and the before/after balances) stays truthful;
 *   3. an exchange keeps the tag and assignment, moves device_serial to the
 *      replacement, and deducts one replacement unit from stock;
 *   4. an exchange with no replacement stock is refused, and the rollback
 *      leaves the asset on its old serial;
 *   5. a forced failure after a collection rolls back the asset, stock and
 *      ledger together;
 *   6. exchange → collect leaves the asset ACTIVE and stock balanced.
 *
 * Fixtures use the "cpa-" prefix and are removed in before/after. The suite
 * skips without a reachable PostgreSQL, like the other real-DB suites.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  collectCpeFixedAsset,
  exchangeCpeFixedAsset,
  exchangeOutLedgerId,
  collectionLedgerId,
  extractCpeAssetTag,
  type LifecycleProduct,
} from '../server/src/services/cpeAssetLifecycle.service';
import { OperationError } from '../server/src/utils/operationError';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

type Product = LifecycleProduct & { id: string };

async function inTransaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedProduct(branchId: string, productId: string, sku: string, name: string): Promise<Product> {
  await pool!.query(
    `INSERT INTO products (id, sku, name, category, product_group, unit, cost_price, selling_price)
     VALUES ($1, $2, $3, 'CPE', 'Fixed Asset', 'Pcs', 100, 150)`,
    [productId, sku, name]
  );
  return { id: productId, sku, name, costPrice: 100 };
}

async function seedStock(branchId: string, productId: string, qty: number): Promise<void> {
  await pool!.query(
    `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand)
     VALUES ($1, $2, $3, $4)`,
    [`cpa-stk-${branchId}-${productId}`, productId, branchId, qty]
  );
}

async function seedAsset(opts: {
  id: string;
  tag: string;
  branchId: string;
  productId: string;
  serial: string;
  notes?: string;
}): Promise<void> {
  await pool!.query(
    `INSERT INTO fixed_assets
       (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs,
        acquisition_cost, net_book_value, status, product_id, assigned_type,
        assigned_customer_id, assigned_customer_name, assignment_date_ad, assignment_date_bs,
        assignment_notes, device_serial)
     VALUES ($1,$2,'CPE Router','IT Equipment',$3,'2026-01-01','2082-09-17',100,100,
             'ASSIGNED_TO_CUSTOMER',$4,'CUSTOMER','cpa-cust','CPA Customer','2026-01-01','2082-09-17',$5,$6)`,
    [opts.id, opts.tag, opts.branchId, opts.productId, opts.notes || 'cpa fixture', opts.serial]
  );
}

async function seedDeployProof(tag: string, productId: string): Promise<void> {
  await pool!.query(
    `INSERT INTO transaction_logs
       (id, transaction_number, product_id, product_name, branch_id, change_type,
        quantity_before, quantity_changed, quantity_after, reference_doc_id, timestamp_bs)
     VALUES ($1,$2,$3,'CPE Router','cpa-b1','STOCK_OUT',1,-1,0,$4,'2082-07-09 BS')`,
    [`cpa-deploy-${tag}`, `DEPLOY-${tag}`, productId, tag]
  );
}

async function seedCdr(opts: {
  id: string;
  serial: string;
  branchId: string;
  notes?: string;
}): Promise<void> {
  await pool!.query(
    `INSERT INTO customer_device_records
       (id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, status, notes)
     VALUES ($1,'CPA Customer','CPA-C',$2,'CPE Router',$3,$4,'RENTAL',$5)`,
    [opts.id, opts.branchId, opts.serial, `PON-${opts.serial}`, opts.notes || 'cpa fixture']
  );
}

async function stockQoh(productId: string, branchId: string): Promise<number> {
  const res = await pool!.query(
    'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
    [productId, branchId]
  );
  return Number(res.rows[0]?.quantity_on_hand ?? 0);
}

async function assetRow(id: string): Promise<any> {
  const res = await pool!.query('SELECT * FROM fixed_assets WHERE id = $1', [id]);
  return res.rows[0];
}

async function ledgerRows(prefix: string): Promise<any[]> {
  const res = await pool!.query('SELECT * FROM transaction_logs WHERE id LIKE $1 ORDER BY id', [`${prefix}%`]);
  return res.rows;
}

describe('CPE fixed-asset lifecycle (CPE-3)', () => {
  before(async () => {
    if (!dbReachable) return;
    await pool!.query("DELETE FROM transaction_logs WHERE id LIKE 'cpa-%' OR reference_doc_id LIKE 'CPA-%' OR reference_doc_id LIKE 'cpa-%'");
    await pool!.query("DELETE FROM fixed_assets WHERE id LIKE 'cpa-%' OR tag_number LIKE 'CPA-%'");
    await pool!.query("DELETE FROM customer_device_records WHERE id LIKE 'cpa-%' OR device_serial LIKE 'CPA-%'");
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'CPA-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE id LIKE 'cpa-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'cpa-%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'cpa-%'");
    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES ('cpa-b1','CPAB1','CPA Branch 1','T'), ('cpa-b2','CPAB2','CPA Branch 2','T'), ('cpa-b3','CPAB3','CPA Branch 3','T')"
    );
  });

  after(async () => {
    if (!dbReachable) return;
    await pool!.query("DELETE FROM transaction_logs WHERE id LIKE 'cpa-%' OR reference_doc_id LIKE 'CPA-%' OR reference_doc_id LIKE 'cpa-%'");
    await pool!.query("DELETE FROM fixed_assets WHERE id LIKE 'cpa-%' OR tag_number LIKE 'CPA-%'");
    await pool!.query("DELETE FROM customer_device_records WHERE id LIKE 'cpa-%' OR device_serial LIKE 'CPA-%'");
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'CPA-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE id LIKE 'cpa-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'cpa-%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'cpa-%'");
    await pool!.end();
  });

  test('extracts the asset tag stamped into CPE notes', () => {
    assert.equal(
      extractCpeAssetTag('[RENTAL CPE ASSET - Tag: FA-ONU002-4011] installed'),
      'FA-ONU002-4011'
    );
    assert.equal(extractCpeAssetTag('no tag here'), '');
  });

  test('collection unassigns the asset and credits stock exactly once', { skip: skipNoDb }, async () => {
    const product = await seedProduct('cpa-b1', 'cpa-p1', 'CPA-SKU-1', 'CPA Router 1');
    await seedStock('cpa-b1', product.id, 0);
    await seedAsset({
      id: 'cpa-a1', tag: 'CPA-T1', branchId: 'cpa-b1', productId: product.id,
      serial: 'CPA-S1', notes: 'cpa deploy',
    });
    await seedDeployProof('CPA-T1', product.id);
    await seedCdr({ id: 'cpa-c1', serial: 'CPA-S1', branchId: 'cpa-b1', notes: '[FIXED ASSET CPE - Tag: CPA-T1]' });

    const first = await inTransaction((client) =>
      collectCpeFixedAsset({
        client,
        cpeId: 'cpa-c1',
        deviceSerial: 'CPA-S1',
        requestNumber: 'CPA-REQ-1',
        todayAD: '2026-10-25',
        branchId: 'cpa-b1',
        products: [product],
        allowUnlinkedRestock: true,
        changeType: 'PULLOUT',
      })
    );
    assert.equal(first.assetCollected, true);
    assert.equal(first.stockCredited, true);
    assert.equal(first.ledger?.quantityBefore, 0);
    assert.equal(first.ledger?.quantityAfter, 1);
    assert.equal(await stockQoh(product.id, 'cpa-b1'), 1);

    const second = await inTransaction((client) =>
      collectCpeFixedAsset({
        client,
        cpeId: 'cpa-c1',
        deviceSerial: 'CPA-S1',
        requestNumber: 'CPA-REQ-2',
        todayAD: '2026-10-25',
        branchId: 'cpa-b1',
        products: [product],
        allowUnlinkedRestock: true,
        changeType: 'PULLOUT',
      })
    );
    assert.equal(second.stockCredited, false);
    assert.equal(second.alreadyCollected, true);
    assert.equal(await stockQoh(product.id, 'cpa-b1'), 1);

    const asset = await assetRow('cpa-a1');
    assert.equal(asset.status, 'ACTIVE');
    assert.equal(asset.device_serial, null);
    assert.equal(asset.assigned_customer_id, null);
    assert.match(String(asset.assignment_notes), /COLLECTED 2026-10-25/);
    assert.equal((await ledgerRows('txn-cpe-collect-cpa-a1')).length, 1);
  });

  test('unlinked collection is keyed by its CPE row, not replayed', { skip: skipNoDb }, async () => {
    const product = await seedProduct('cpa-b2', 'cpa-p2', 'CPA-SKU-2', 'CPA Router 2');
    await seedStock('cpa-b2', product.id, 0);
    await seedCdr({ id: 'cpa-c2', serial: 'CPA-S2', branchId: 'cpa-b2' });

    const run = (requestNumber: string) =>
      inTransaction((client) =>
        collectCpeFixedAsset({
          client,
          cpeId: 'cpa-c2',
          deviceSerial: 'CPA-S2',
          requestNumber,
          todayAD: '2026-10-25',
          branchId: 'cpa-b2',
          fallbackProduct: product,
          products: [product],
          allowUnlinkedRestock: true,
          changeType: 'PULLOUT',
        })
      );

    const first = await run('CPA-REQ-UNLINKED');
    assert.equal(first.stockCredited, true);
    // A different route (the direct status PATCH) carries a different request
    // label but the same CPE row; it must still be a no-op.
    const second = await run('CPE-STATUS-cpa-c2');
    assert.equal(second.stockCredited, false);
    assert.equal(await stockQoh(product.id, 'cpa-b2'), 1);
    assert.equal((await ledgerRows(collectionLedgerId('cpa-c2'))).length, 1);
  });

  test('exchange moves the asset serial and deducts the replacement', { skip: skipNoDb }, async () => {
    const product = await seedProduct('cpa-b3', 'cpa-p3', 'CPA-SKU-3', 'CPA Router 3');
    await seedStock('cpa-b3', product.id, 2);
    await seedAsset({
      id: 'cpa-a3', tag: 'CPA-T3', branchId: 'cpa-b3', productId: product.id,
      serial: 'CPA-OLD3', notes: 'cpa deploy',
    });
    await seedCdr({ id: 'cpa-c3', serial: 'CPA-OLD3', branchId: 'cpa-b3', notes: '[FIXED ASSET CPE - Tag: CPA-T3]' });
    await pool!.query(
      `INSERT INTO serial_log (id, device_serial, pon_serial, product_id, product_name, branch_id, status, source_type)
       VALUES ('cpa-sl-new3','CPA-NEW3','PON-NEW3',$1,'CPA Router 3','cpa-b3','IN_STOCK','PURCHASE')`,
      [product.id]
    );

    const result = await inTransaction((client) =>
      exchangeCpeFixedAsset({
        client,
        cpeId: 'cpa-c3',
        oldSerial: 'CPA-OLD3',
        newSerial: 'CPA-NEW3',
        newCdrId: 'cpa-new-cdr3',
        todayAD: '2026-10-25',
        branchId: 'cpa-b3',
        newProductName: 'CPA Router 3',
        products: [product],
      })
    );
    assert.equal(result.assetMoved, true);
    assert.equal(result.replacementStockDeducted, true);
    assert.equal(result.ledger?.quantityBefore, 2);
    assert.equal(result.ledger?.quantityAfter, 1);
    assert.equal(await stockQoh(product.id, 'cpa-b3'), 1);

    const asset = await assetRow('cpa-a3');
    assert.equal(asset.device_serial, 'CPA-NEW3');
    assert.equal(asset.tag_number, 'CPA-T3');
    assert.equal(asset.status, 'ASSIGNED_TO_CUSTOMER');
    assert.match(String(asset.assignment_notes), /CPA-OLD3 → CPA-NEW3/);
    assert.equal((await ledgerRows(exchangeOutLedgerId('cpa-new-cdr3'))).length, 1);
  });

  test('exchange refuses an empty replacement stock and rolls back the asset move', { skip: skipNoDb }, async () => {
    const product = await seedProduct('cpa-b1', 'cpa-p4', 'CPA-SKU-4', 'CPA Router 4');
    await seedStock('cpa-b1', product.id, 0);
    await seedAsset({
      id: 'cpa-a4', tag: 'CPA-T4', branchId: 'cpa-b1', productId: product.id,
      serial: 'CPA-OLD4', notes: 'cpa deploy',
    });
    await seedCdr({ id: 'cpa-c4', serial: 'CPA-OLD4', branchId: 'cpa-b1', notes: '[FIXED ASSET CPE - Tag: CPA-T4]' });

    await assert.rejects(
      () =>
        inTransaction((client) =>
          exchangeCpeFixedAsset({
            client,
            cpeId: 'cpa-c4',
            oldSerial: 'CPA-OLD4',
            newSerial: 'CPA-NEW4',
            newCdrId: 'cpa-new-cdr4',
            todayAD: '2026-10-25',
            branchId: 'cpa-b1',
            newProductName: 'CPA Router 4',
            products: [product],
          })
        ),
      (err: any) => err instanceof OperationError && err.status === 409
    );

    const asset = await assetRow('cpa-a4');
    assert.equal(asset.device_serial, 'CPA-OLD4', 'a refused exchange must leave the old serial');
    assert.equal(await stockQoh(product.id, 'cpa-b1'), 0);
    assert.equal((await ledgerRows(exchangeOutLedgerId('cpa-new-cdr4'))).length, 0);
  });

  test('a forced failure rolls back the collection completely', { skip: skipNoDb }, async () => {
    const product = await seedProduct('cpa-b2', 'cpa-p5', 'CPA-SKU-5', 'CPA Router 5');
    await seedStock('cpa-b2', product.id, 0);
    await seedAsset({
      id: 'cpa-a5', tag: 'CPA-T5', branchId: 'cpa-b2', productId: product.id,
      serial: 'CPA-S5', notes: 'cpa deploy',
    });
    await seedDeployProof('CPA-T5', product.id);
    await seedCdr({ id: 'cpa-c5', serial: 'CPA-S5', branchId: 'cpa-b2', notes: '[FIXED ASSET CPE - Tag: CPA-T5]' });

    await assert.rejects(
      () =>
        inTransaction(async (client) => {
          await collectCpeFixedAsset({
            client,
            cpeId: 'cpa-c5',
            deviceSerial: 'CPA-S5',
            requestNumber: 'CPA-REQ-FAIL',
            todayAD: '2026-10-25',
            branchId: 'cpa-b2',
            products: [product],
            allowUnlinkedRestock: true,
          });
          throw new Error('forced failure after the collection');
        }),
      /forced failure/
    );

    const asset = await assetRow('cpa-a5');
    assert.equal(asset.status, 'ASSIGNED_TO_CUSTOMER');
    assert.equal(asset.device_serial, 'CPA-S5');
    assert.equal(await stockQoh(product.id, 'cpa-b2'), 0);
    assert.equal((await ledgerRows('txn-cpe-collect-cpa-a5')).length, 0);
  });

  test('exchange then collect leaves the asset ACTIVE and stock balanced', { skip: skipNoDb }, async () => {
    const product = await seedProduct('cpa-b1', 'cpa-p6', 'CPA-SKU-6', 'CPA Router 6');
    await seedStock('cpa-b1', product.id, 2);
    await seedAsset({
      id: 'cpa-a6', tag: 'CPA-T6', branchId: 'cpa-b1', productId: product.id,
      serial: 'CPA-OLD6', notes: 'cpa deploy',
    });
    await seedDeployProof('CPA-T6', product.id);
    await seedCdr({ id: 'cpa-c6', serial: 'CPA-OLD6', branchId: 'cpa-b1', notes: '[FIXED ASSET CPE - Tag: CPA-T6]' });

    await inTransaction((client) =>
      exchangeCpeFixedAsset({
        client,
        cpeId: 'cpa-c6',
        oldSerial: 'CPA-OLD6',
        newSerial: 'CPA-NEW6',
        newCdrId: 'cpa-new-cdr6',
        todayAD: '2026-10-25',
        branchId: 'cpa-b1',
        newProductName: 'CPA Router 6',
        products: [product],
      })
    );
    assert.equal(await stockQoh(product.id, 'cpa-b1'), 1);

    const collected = await inTransaction((client) =>
      collectCpeFixedAsset({
        client,
        cpeId: 'cpa-c6',
        deviceSerial: 'CPA-NEW6',
        requestNumber: 'CPA-REQ-AFTER-EXCHANGE',
        todayAD: '2026-10-25',
        branchId: 'cpa-b1',
        products: [product],
        allowUnlinkedRestock: true,
      })
    );
    assert.equal(collected.assetCollected, true);
    assert.equal(collected.stockCredited, true);
    assert.equal(await stockQoh(product.id, 'cpa-b1'), 2);
    const asset = await assetRow('cpa-a6');
    assert.equal(asset.status, 'ACTIVE');
    assert.equal(asset.device_serial, null);
  });
});
