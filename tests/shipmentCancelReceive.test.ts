/**
 * Cancel-received-transfer (POST /api/shipments/:id/cancel-receive) — HTTP-layer
 * integration tests.
 *
 * Regression guard for the flow the dead-API audit found broken end-to-end:
 * the endpoint was an always-400 stub while the Shipments register offered a
 * "Cancel Receive Transfer" button for RECEIVED shipments — so the direct
 * path always failed, and the CANCEL_RECEIVE_TRANSFER approval path silently
 * reported success without touching the shipment. PROVES, on a real Express
 * app wired exactly as production (createApp + registerAllRoutes) against
 * real PostgreSQL:
 *
 *  1. UNDO — a RECEIVED shipment receipt can be cancelled: 200, the
 *     shipment is back IN_TRANSIT, destination stock is reversed (on-hand
 *     down by the received quantity, the in-transit reservation restored),
 *     and the receive bookkeeping (received_date_*, has_discrepancy) is cleared.
 *  2. GUARDS — second undo (already IN_TRANSIT) -> 400, unknown id -> 404,
 *     no token -> 401, a role without branch-transfer-cancel-receive -> 403.
 *  3. APPROVAL — processing a CANCEL_RECEIVE_TRANSFER approval as
 *     SUPER_ADMIN performs the same undo.
 *
 * Fixtures use a "crtest-" id prefix, seeded in BOTH the database and the
 * in-memory shipments cache (tests never run dbBoot, but the handlers read
 * the cache first, exactly as a booted server would). Removed in after().
 * Skips without a reachable PostgreSQL (DATABASE_URL).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes, shipments, setShipments, approvalRequests, setApprovalRequests } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipPositive = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const SUPER_USER = {
  id: 'crtest-super', email: 'crtest-super@example.com', name: 'CR Test Super',
  role: 'SUPER_ADMIN', branchId: 'crtest-src',
  allowedBranchIds: ['crtest-src', 'crtest-dst'], canSwitchUser: false,
} as any;
const FRONT_DESK_USER = {
  id: 'crtest-fd', email: 'crtest-fd@example.com', name: 'CR Test FD',
  role: 'FRONT_DESK', branchId: 'crtest-dst',
  allowedBranchIds: ['crtest-dst'], canSwitchUser: false,
} as any;

const fixtureShipment = (id: string, trackingCode: string, productId: string, productName: string, qty: number) => ({
  id, trackingCode, type: 'INTER_BRANCH',
  sourceBranchId: 'crtest-src', sourceBranchName: 'CR Source',
  destinationBranchId: 'crtest-dst', destinationBranchName: 'CR Destination',
  dispatchDateAD: '2026-09-01', dispatchDateBS: '2083-05-16 BS',
  status: 'RECEIVED', notes: '',
  items: [{ productId, productName, quantitySent: qty, quantityReceived: qty }],
  receivedByNotes: 'test receipt', receivedDateAD: '2026-09-02',
  receivedDateBS: '2083-05-17 BS', hasDiscrepancy: false,
});

describe('cancel-received-transfer (POST /api/shipments/:id/cancel-receive)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const superToken = issueAuthToken(SUPER_USER);
  const fdToken = issueAuthToken(FRONT_DESK_USER);

  before(async () => {
    if (!dbReachable) return;

    // Clear leftovers from aborted runs, then seed idempotently.
    await pool!.query("DELETE FROM approval_requests WHERE target_id LIKE 'crtest-%'");
    await pool!.query("DELETE FROM shipments WHERE id LIKE 'crtest-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id LIKE 'crtest-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'crtest-%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'crtest-%'");

    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES " +
      "('crtest-src', 'CRSRC', 'CR Source', 'T'), ('crtest-dst', 'CRDST', 'CR Destination', 'T')"
    );
    await pool!.query(
      "INSERT INTO products (id, sku, name, category, product_group) VALUES " +
      "('crtest-prod1', 'CRSKU1', 'CR Test Product 1', 'Test', 'Product Item'), " +
      "('crtest-prod2', 'CRSKU2', 'CR Test Product 2', 'Test', 'Product Item')"
    );
    await pool!.query(
      "INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty) VALUES " +
      "('stk-crtest-dst-crtest-prod1', 'crtest-prod1', 'crtest-dst', 10, 0), " +
      "('stk-crtest-dst-crtest-prod2', 'crtest-prod2', 'crtest-dst', 5, 0)"
    );
    const items1 = JSON.stringify([{ productId: 'crtest-prod1', productName: 'CR Test Product 1', quantitySent: 4, quantityReceived: 4 }]);
    const items2 = JSON.stringify([{ productId: 'crtest-prod2', productName: 'CR Test Product 2', quantitySent: 2, quantityReceived: 2 }]);
    await pool!.query(
      "INSERT INTO shipments (id, tracking_code, type, source_branch_id, source_branch_name, " +
      "destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, status, " +
      "notes, items, received_by_notes, received_date_ad, received_date_bs, has_discrepancy) " +
      "VALUES ($1, $2, 'INTER_BRANCH', 'crtest-src', 'CR Source', 'crtest-dst', 'CR Destination', " +
      "'2026-09-01', '2083-05-16 BS', 'RECEIVED', '', $3, 'test receipt', '2026-09-02', " +
      "'2083-05-17 BS', FALSE)",
      ['crtest-sh1', 'ST-CRTEST-1', items1]
    );
    await pool!.query(
      "INSERT INTO shipments (id, tracking_code, type, source_branch_id, source_branch_name, " +
      "destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, status, " +
      "notes, items, received_by_notes, received_date_ad, received_date_bs, has_discrepancy) " +
      "VALUES ($1, $2, 'INTER_BRANCH', 'crtest-src', 'CR Source', 'crtest-dst', 'CR Destination', " +
      "'2026-09-01', '2083-05-16 BS', 'RECEIVED', '', $3, 'test receipt', '2026-09-02', " +
      "'2083-05-17 BS', FALSE)",
      ['crtest-sh2', 'ST-CRTEST-2', items2]
    );

    // Inject into the in-memory cache too (handlers read the shipments array
    // first, exactly as a booted server would after dbBoot hydration).
    const fixtures = [
      fixtureShipment('crtest-sh1', 'ST-CRTEST-1', 'crtest-prod1', 'CR Test Product 1', 4),
      fixtureShipment('crtest-sh2', 'ST-CRTEST-2', 'crtest-prod2', 'CR Test Product 2', 2),
    ];
    setShipments([...shipments.filter((s) => !s.id.startsWith('crtest-')), ...fixtures] as any);

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });
  });

  after(async () => {
    if (close) await close();
    setShipments(shipments.filter((s) => !s.id.startsWith('crtest-')) as any);
    setApprovalRequests(approvalRequests.filter((r) => !(r.targetId || '').startsWith('crtest-')) as any);
    if (pool && dbReachable) {
      await pool.query("DELETE FROM approval_requests WHERE target_id LIKE 'crtest-%'");
      await pool.query("DELETE FROM shipments WHERE id LIKE 'crtest-%'");
      await pool.query("DELETE FROM inventory_stock WHERE product_id LIKE 'crtest-%'");
      await pool.query("DELETE FROM products WHERE id LIKE 'crtest-%'");
      await pool.query("DELETE FROM branches WHERE id LIKE 'crtest-%'");
      await pool.end();
    }
  });

  async function post(path: string, body: unknown, token?: string) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  async function stockRow(productId: string) {
    const r = await pool!.query(
      'SELECT quantity_on_hand AS "quantityOnHand", incoming_qty AS "incomingQty" ' +
      'FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      [productId, 'crtest-dst']
    );
    return r.rows[0];
  }

  async function shipmentRow(id: string) {
    const r = await pool!.query(
      'SELECT status, received_date_ad AS "receivedDateAD", has_discrepancy AS "hasDiscrepancy", notes ' +
      'FROM shipments WHERE id = $1',
      [id]
    );
    return r.rows[0];
  }

  test('undo: RECEIVED shipment back to In-Transit, destination stock reversed', { skip: skipPositive }, async () => {
    const { status, json } = await post('/api/shipments/crtest-sh1/cancel-receive', { user: { name: 'CR Test Super' }, reason: 'audit test' }, superToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.match(String(json?.message), /restored to In-Transit/i);
    assert.equal(json?.shipment?.status, 'IN_TRANSIT');

    const stock = await stockRow('crtest-prod1');
    assert.equal(Number(stock.quantityOnHand), 6, 'received 4 of 10 must come off on-hand');
    assert.equal(Number(stock.incomingQty), 4, 'the in-transit reservation is restored');

    const row = await shipmentRow('crtest-sh1');
    assert.equal(row.status, 'IN_TRANSIT');
    assert.equal(row.receivedDateAD, null, 'receive bookkeeping cleared');
    assert.equal(row.hasDiscrepancy, false);
    assert.match(String(row.notes), /Receipt cancelled by CR Test Super: audit test/);
  });

  test('guard: the undo applies only once — a second call is 400', { skip: skipPositive }, async () => {
    const { status, json } = await post('/api/shipments/crtest-sh1/cancel-receive', { reason: 'again' }, superToken);
    assert.equal(status, 400);
    assert.match(String(json?.message), /only received transfers/i);
    // Stock untouched by the rejected call.
    const stock = await stockRow('crtest-prod1');
    assert.equal(Number(stock.quantityOnHand), 6);
    assert.equal(Number(stock.incomingQty), 4);
  });

  test('guard: unknown id -> 404', { skip: skipPositive }, async () => {
    const { status } = await post('/api/shipments/crtest-nope/cancel-receive', {}, superToken);
    assert.equal(status, 404);
  });

  test('guard: no bearer token -> 401', { skip: skipPositive }, async () => {
    const { status } = await post('/api/shipments/crtest-sh1/cancel-receive', {});
    assert.equal(status, 401);
  });

  test('guard: a role without branch-transfer-cancel-receive -> 403', { skip: skipPositive }, async () => {
    const { status, json } = await post('/api/shipments/crtest-sh2/cancel-receive', {}, fdToken);
    assert.equal(status, 403, JSON.stringify(json));
    // The fixture is untouched by the forbidden call.
    const row = await shipmentRow('crtest-sh2');
    assert.equal(row.status, 'RECEIVED');
  });

  test('approval: processing a CANCEL_RECEIVE_TRANSFER approval performs the undo', { skip: skipPositive }, async () => {
    const created = await post('/api/approval-requests', {
      type: 'CANCEL_RECEIVE_TRANSFER',
      targetId: 'crtest-sh2',
      customerName: 'ST-CRTEST-2',
      deviceSerial: '',
      reason: 'receipt confirmed wrong — approval test',
      branchId: 'crtest-dst',
      branchName: 'CR Destination',
      shipmentData: { shipmentId: 'crtest-sh2', trackingCode: 'ST-CRTEST-2' },
    }, superToken);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const approvalId = created.json?.id;
    assert.ok(approvalId, 'approval request id returned');

    const processed = await post('/api/approval-requests/' + approvalId + '/process', { status: 'APPROVED' }, superToken);
    assert.equal(processed.status, 200, JSON.stringify(processed.json));
    assert.match(String(processed.json?.message), /authorized and executed/i);

    const row = await shipmentRow('crtest-sh2');
    assert.equal(row.status, 'IN_TRANSIT', 'approval path must actually revert the receipt');
    assert.equal(row.receivedDateAD, null);
    assert.match(String(row.notes), /Receipt cancelled via Approval/);

    const stock = await stockRow('crtest-prod2');
    assert.equal(Number(stock.quantityOnHand), 3, 'received 2 of 5 come off on-hand');
    assert.equal(Number(stock.incomingQty), 2, 'reservation restored');
  });
});
