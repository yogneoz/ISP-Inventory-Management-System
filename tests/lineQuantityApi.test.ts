/**
 * QTY-1 — line quantities are validated at the API, not only in the UI.
 *
 * AUD-3 capped the value the operator can type. This suite pins the API half:
 * every line-item write endpoint refuses a quantity that is not a whole number
 * in its allowed range BEFORE any write, with the refusal text coming from the
 * same shared rule the screens clamp with (`shared/lineQuantity.ts`).
 *
 * WHAT IS PINNED
 *   1. The shared rule itself: whole numbers only, the `[1, 1000]` ceiling,
 *      signed `[-1000, 1000]` for manual adjustments, an open range
 *      (`Infinity` max) for lines already bounded by an existing document or
 *      stock pool, and a message that names the product.
 *   2. Over real HTTP: oversized and fractional payloads are 400 with the
 *      refusal, on sales invoices, purchase orders (create + update), purchase
 *      invoices (direct), sales returns, purchase returns, shipments and stock
 *      operations. The drawing stock operations stay pool-bounded — a disposal
 *      above the ceiling reaches the availability check instead of being
 *      refused, so bulk write-offs of accumulated damage keep working.
 *   3. Source guards: each handler still calls the guard, and each of the four
 *      screens that could otherwise type a refused value clamps at the entry.
 *
 * Every refusal runs before the handler's first database touch, so these tests
 * need no fixtures and no DB — nothing is written on the refusal paths.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import {
  MAX_LINE_QUANTITY,
  clampLineQuantity,
  lineQuantityRefusal,
} from '../shared/lineQuantity';

const root = fileURLToPath(new URL('..', import.meta.url));

const ADMIN = {
  id: 'qty-admin',
  email: 'qty-admin@example.com',
  name: 'QTY Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const PRODUCT = { productId: 'qty-prod', productName: 'QTY Router', quantity: 1, unitPrice: 100 };

describe('shared line-quantity rule (QTY-1)', () => {
  test('the ceiling is the one the screens clamp with', () => {
    assert.equal(MAX_LINE_QUANTITY, 1000);
    // A value the refusal accepts is a value the clamp returns unchanged, so
    // the two halves of the rule cannot drift apart.
    for (const qty of [1, 2, 250, MAX_LINE_QUANTITY]) {
      assert.equal(lineQuantityRefusal(qty), null, `${qty} must be valid`);
      assert.equal(clampLineQuantity(qty), qty, `${qty} must survive the clamp`);
    }
  });

  test('oversized values are refused with the ceiling in the message', () => {
    assert.equal(
      lineQuantityRefusal(5000, { label: 'QTY Router' }),
      `Line quantity for QTY Router must be between 1 and 1000 (received 5000).`
    );
    assert.match(String(lineQuantityRefusal(1001)), /between 1 and 1000 \(received 1001\)/);
    assert.match(String(lineQuantityRefusal('999999999')), /between 1 and 1000/);
  });

  test('non-integers and unreadable values are refused as whole numbers', () => {
    for (const value of [2.5, '2.5', 3.7, Number.NaN, undefined, 'abc', Infinity, -Infinity, {}]) {
      const refusal = lineQuantityRefusal(value);
      assert.ok(refusal, `${String(value)} must be refused`);
      assert.match(refusal, /must be a whole number/, `${String(value)} must name the whole-number rule`);
    }
    // Values `Number()` reads as 0 are refused by the range rule instead —
    // either way they never reach a line.
    for (const value of ['', null, []]) {
      const refusal = lineQuantityRefusal(value);
      assert.match(String(refusal), /between 1 and 1000 \(received 0\)/, `${String(value)} must be refused`);
    }
  });

  test('zero and negatives are outside the unsigned range', () => {
    assert.match(String(lineQuantityRefusal(0)), /between 1 and 1000 \(received 0\)/);
    assert.match(String(lineQuantityRefusal(-3)), /between 1 and 1000 \(received -3\)/);
  });

  test('manual adjustments take a signed range and allow the zero no-op', () => {
    for (const value of [-MAX_LINE_QUANTITY, -1, 0, 1, MAX_LINE_QUANTITY]) {
      assert.equal(lineQuantityRefusal(value, { allowSigned: true }), null, `${value} must be valid when signed`);
    }
    assert.match(String(lineQuantityRefusal(5000, { allowSigned: true })), /between -1000 and 1000 \(received 5000\)/);
    assert.match(String(lineQuantityRefusal(-1001, { allowSigned: true })), /between -1000 and 1000/);
    assert.match(String(lineQuantityRefusal(1.5, { allowSigned: true })), /must be a whole number between -1000 and 1000/);
  });

  test('allowZero opens the bottom of the unsigned range', () => {
    assert.equal(lineQuantityRefusal(0, { allowZero: true }), null);
    assert.match(String(lineQuantityRefusal(0)), /between 1 and 1000/);
  });

  test('an open range keeps document- and pool-bounded lines whole but uncapped', () => {
    const open = { max: Number.POSITIVE_INFINITY };
    for (const value of [1, 5000, 900000]) {
      assert.equal(lineQuantityRefusal(value, open), null, `${value} must be valid with an open range`);
    }
    assert.match(String(lineQuantityRefusal(1.5, open)), /must be a whole number of at least 1/);
    assert.match(String(lineQuantityRefusal(0, open)), /of at least 1 \(received 0\)/);
  });
});

describe('line quantities over HTTP (QTY-1)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);

  before(async () => {
    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () =>
      new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      });
  });

  after(async () => {
    if (close) await close();
  });

  async function call(method: 'POST' | 'PUT', route: string, body: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + route, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  const post = (route: string, body: unknown) => call('POST', route, body);
  const put = (route: string, body: unknown) => call('PUT', route, body);

  test('sales invoice: an oversized line is 400 before anything is written', async () => {
    const { status, json } = await post('/api/sales-invoices', {
      items: [{ ...PRODUCT, quantity: 5000 }],
      invoiceDateAD: '2026-10-27',
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.equal(json.message, 'Line quantity for QTY Router must be between 1 and 1000 (received 5000).');
  });

  test('sales invoice: a fractional line is 400', async () => {
    const { status, json } = await post('/api/sales-invoices', {
      items: [{ ...PRODUCT, quantity: 2.5 }],
      invoiceDateAD: '2026-10-27',
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json.message), /Line quantity for QTY Router must be a whole number between 1 and 1000/);
  });

  test('purchase order create: oversized and fractional lines are 400', async () => {
    const big = await post('/api/purchase-orders', { items: [{ ...PRODUCT, quantity: 1_000_000 }] });
    assert.equal(big.status, 400, JSON.stringify(big.json));
    assert.match(String(big.json.message), /between 1 and 1000 \(received 1000000\)/);

    const fraction = await post('/api/purchase-orders', { items: [{ ...PRODUCT, quantity: 0.5 }] });
    assert.equal(fraction.status, 400, JSON.stringify(fraction.json));
    assert.match(String(fraction.json.message), /must be a whole number between 1 and 1000/);
  });

  test('purchase order update: body lines are validated before the lookup', async () => {
    const { status, json } = await put('/api/purchase-orders/qty-missing', {
      items: [{ ...PRODUCT, quantity: 1500 }],
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json.message), /between 1 and 1000 \(received 1500\)/);
  });

  test('direct purchase invoice: oversized and fractional lines are 400', async () => {
    const big = await post('/api/purchase-invoices', { items: [{ ...PRODUCT, quantity: 5000 }] });
    assert.equal(big.status, 400, JSON.stringify(big.json));
    assert.match(String(big.json.message), /between 1 and 1000 \(received 5000\)/);

    const fraction = await post('/api/purchase-invoices', { items: [{ ...PRODUCT, quantity: 1.5 }] });
    assert.equal(fraction.status, 400, JSON.stringify(fraction.json));
    assert.match(String(fraction.json.message), /must be a whole number between 1 and 1000/);
  });

  test('sales return: whole numbers only, magnitude left to the invoice bound', async () => {
    const { status, json } = await post('/api/sales-returns', {
      items: [{ ...PRODUCT, quantity: 1.5 }],
      originalInvoiceId: 'qty-inv',
      returnDateAD: '2026-10-27',
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json.message), /must be a whole number of at least 1/);
  });

  test('purchase return: whole numbers only', async () => {
    const { status, json } = await post('/api/purchase-returns', {
      items: [{ ...PRODUCT, quantity: 2.25 }],
      originalInvoiceId: 'qty-inv',
      returnDateAD: '2026-10-27',
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json.message), /must be a whole number of at least 1/);
  });

  test('shipment dispatch: oversized and fractional lines are 400', async () => {
    const big = await post('/api/shipments', {
      items: [{ productId: PRODUCT.productId, productName: PRODUCT.productName, quantitySent: 2000 }],
      sourceBranchId: 'WH001',
      destinationBranchId: 'BRH01',
    });
    assert.equal(big.status, 400, JSON.stringify(big.json));
    assert.match(String(big.json.message), /between 1 and 1000 \(received 2000\)/);

    const fraction = await post('/api/shipments', {
      items: [{ productId: PRODUCT.productId, productName: PRODUCT.productName, quantitySent: 2.5 }],
      sourceBranchId: 'WH001',
      destinationBranchId: 'BRH01',
    });
    assert.equal(fraction.status, 400, JSON.stringify(fraction.json));
    assert.match(String(fraction.json.message), /must be a whole number between 1 and 1000/);
  });

  test('stock operation: a fractional damage line is 400 (pool-bounded draw)', async () => {
    const { status, json } = await post('/api/stock-operations', {
      type: 'DAMAGE',
      branchId: 'WH001',
      items: [{ ...PRODUCT, quantity: 3.5 }],
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json.message), /must be a whole number of at least 1/);
  });

  test('stock operation: a manual-adjustment credit keeps the signed ceiling', async () => {
    const { status, json } = await post('/api/stock-operations', {
      type: 'MANUAL_ADJUSTMENT',
      branchId: 'WH001',
      items: [{ ...PRODUCT, quantity: 5000 }],
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(String(json.message), /between -1000 and 1000 \(received 5000\)/);
  });

  test('stock operation: a drawing line stays pool-bounded (disposal above the ceiling reaches the pool check)', async () => {
    const { status, json } = await post('/api/stock-operations', {
      type: 'DISPOSAL',
      branchId: 'WH001',
      items: [{ productId: 'qty-prod', productName: 'QTY Router', quantity: 5000 }],
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.doesNotMatch(String(json.message), /Line quantity/, 'a pool-bounded draw must not be held to the typed-line ceiling');
    assert.match(String(json.message), /Insufficient inventory/);
  });
});

describe('line-quantity wiring (source guards, QTY-1)', () => {
  function handlerBody(source: string, name: string): string {
    const start = source.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `handler ${name} not found`);
    const next = source.indexOf('export async function', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  const sales = fs.readFileSync(path.join(root, 'server/src/controllers/sales.controller.ts'), 'utf8');
  const procurement = fs.readFileSync(path.join(root, 'server/src/controllers/procurement.controller.ts'), 'utf8');
  const shipments = fs.readFileSync(path.join(root, 'server/src/controllers/shipments.controller.ts'), 'utf8');
  const inventory = fs.readFileSync(path.join(root, 'server/src/controllers/inventory.controller.ts'), 'utf8');

  test('every line-item write handler still calls the guard', () => {
    assert.match(handlerBody(sales, 'post_salesInvoices'), /firstLineQuantityRefusal\(items\)/);
    assert.match(handlerBody(sales, 'post_salesReturns'), /firstLineQuantityRefusal\(items, \{ uncapped: true \}\)/);
    assert.match(handlerBody(procurement, 'post_purchaseOrders'), /firstLineQuantityRefusal\(items\)/);
    assert.match(handlerBody(procurement, 'put_Id'), /firstLineQuantityRefusal\(req\.body\.items\)/);
    assert.match(handlerBody(procurement, 'post_purchaseInvoices'), /uncapped: Boolean\(req\.body\.poReferenceId \|\| req\.body\.poId\)/);
    assert.match(handlerBody(procurement, 'post_purchaseReturns'), /firstLineQuantityRefusal\(items, \{ uncapped: true \}\)/);
    assert.match(handlerBody(shipments, 'post_shipments'), /quantityOf: \(item: any\) => shipmentQtySent\(item\)/);
    assert.match(handlerBody(inventory, 'post_stockOperations'), /allowSigned: opType === 'MANUAL_ADJUSTMENT'/);
  });

  test('each screen that can type a quantity clamps at the entry', () => {
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const cases: Array<[string, RegExp]> = [
      ['client/src/features/sales/ReturnsRegister.tsx', /updateLineQuantity\(idx, parseLineQuantity\(e\.target\.value, 0\)\)/],
      ['client/src/features/procurement/PurchaseOrderForm.tsx', /field === 'quantity' \? clampLineQuantity\(value\) : value/],
      ['client/src/features/inventory/stockops/ConsumableIssuePanel.tsx', /updates\.quantity !== undefined\) updated\.quantity = clampLineQuantity\(updates\.quantity\)/],
      ['client/src/features/inventory/DamagedStockTracking.tsx', /parseLineQuantity\(e\.target\.value, 1, disposalStock\.stockItem\.damagedQty \|\| 1\)/],
    ];
    for (const [file, pattern] of cases) {
      assert.match(read(file), pattern, `${file} must clamp at the entry`);
    }
  });
});
