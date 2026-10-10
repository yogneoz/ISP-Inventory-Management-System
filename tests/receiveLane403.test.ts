/**
 * Receive-lane 403 tests — HTTP-layer integration tests on a real Express app
 * wired exactly as production (createApp + registerAllRoutes) against real
 * PostgreSQL. Fixtures use a "rlt-" id prefix (unique per file: node --test
 * runs files in parallel, so a shared prefix lets one file's DELETE wipe
 * another's fixtures). Skips without a reachable PostgreSQL (DATABASE_URL).
 *
 * WHY THIS FILE EXISTS (2026-10-10 receive-lane review):
 * The four-register audience contract was previously pinned only at SOURCE
 * level (tests/registerAudienceContract.test.ts asserts the strings in the
 * route files). These tests prove the same contract over real HTTP, and they
 * exposed a genuine hole while being written:
 *
 *   HOLE: POST /api/stock-operations/:id/receive had NO server-side permission
 *   check — not a route gate, not a handler check. PulloutBinsPanel hides the
 *   Receive button unless the role holds 'wh-receive-pullouts', so every role
 *   that saw the button had the op... but any authenticated role WITHOUT it
 *   (ACCOUNTANT, FIELD_TECHNICIAN, AUDITOR — all false in the default matrix)
 *   could call the endpoint directly and credit warehouse stock. Fixed by
 *   adding requirePermission('wh-receive-pullouts') to the route, matching the
 *   client gate exactly. Test 3 is the regression pin.
 *
 * WHAT IS PINNED (two enforcement layers + auth):
 *   1. 401 — neither receive endpoint is reachable without a bearer token.
 *   2. ROUTE layer — a role holding NEITHER lane operation is 403 on
 *      POST /api/shipments/:id/receive (requirePermissionAny), with no state
 *      change (shipment still IN_TRANSIT, destination stock untouched).
 *   3. ROUTE layer (regression) — same for the stock-operations receive.
 *   4./7. POSITIVE — a role holding the lane's operation passes the gate and
 *      the receipt really settles stock (warehouse lane and branch lane).
 *   5./6. HANDLER layer — the shipment handler re-checks the lane implied by
 *      the DESTINATION (warehouse destination -> 'wh-receive-pullouts',
 *      branch destination -> 'branch-transfer-receive'), so holding the route's
 *      OR-op is not enough: a Permission Management toggle stays authoritative
 *      per destination lane. A synthetic matrix (WH on, transfer off, and the
 *      inverse) makes the two layers distinguishable — the defaults give both
 *      ops identical role sets, which would hide which layer rejected.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes, shipments, setShipments } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

// ACCOUNTANT holds neither lane op -> must be stopped at the route.
const ACCT_USER = {
  id: 'rlt-acct', email: 'rlt-acct@example.com', name: 'RLT Acct',
  role: 'ACCOUNTANT', branchId: 'WH001',
  allowedBranchIds: ['WH001'], canSwitchUser: false,
} as any;
// Synthetic matrix below gives PROCUREMENT_OFFICER the warehouse lane only,
// FRONT_DESK the branch-transfer lane only. Both are HQ-wide (branchId 'ALL')
// so the handler's destination-affinity check passes and the LANE check is
// what answers.
const PO_USER = {
  id: 'rlt-po', email: 'rlt-po@example.com', name: 'RLT PO',
  role: 'PROCUREMENT_OFFICER', branchId: 'ALL',
  allowedBranchIds: [], canSwitchUser: false,
} as any;
const FD_USER = {
  id: 'rlt-fd', email: 'rlt-fd@example.com', name: 'RLT FD',
  role: 'FRONT_DESK', branchId: 'ALL',
  allowedBranchIds: [], canSwitchUser: false,
} as any;
// INVENTORY_MANAGER keeps the default wh-receive-pullouts=true (pullout bin).
const IM_USER = {
  id: 'rlt-im', email: 'rlt-im@example.com', name: 'RLT IM',
  role: 'INVENTORY_MANAGER', branchId: 'ALL',
  allowedBranchIds: [], canSwitchUser: false,
} as any;

describe('receive lane 403s (route gate + handler lane gate)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const acctToken = issueAuthToken(ACCT_USER);
  const poToken = issueAuthToken(PO_USER);
  const fdToken = issueAuthToken(FD_USER);
  const imToken = issueAuthToken(IM_USER);

  const PRODUCT = 'rlt-prod';
  // Destinations are the REAL demo branches, because the handler resolves the
  // destination lane through the branch record (is_headquarters / code / name)
  // and WH001 is additionally the literal warehouse id. A private fixture
  // branch would be invisible to the in-memory `branches` cache (tests never
  // run dbBoot) and every destination would silently classify as a branch.
  const WH = 'WH001';   // head office -> warehouse lane
  const BR = 'BRH01';   // plain branch -> transfer lane
  const shipItem = JSON.stringify([{ productId: PRODUCT, productName: 'RLT Product', quantitySent: 2 }]);
  const opItem = JSON.stringify([{ productId: PRODUCT, quantity: 3 }]);

  before(async () => {
    if (!dbReachable) return;

    // Clear leftovers from aborted runs, then seed idempotently.
    await pool!.query("DELETE FROM stock_operations WHERE id LIKE 'rlt-%'");
    await pool!.query("DELETE FROM shipments WHERE id LIKE 'rlt-%' OR tracking_code LIKE 'ST-RLT-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id = 'rlt-prod'");
    await pool!.query("DELETE FROM products WHERE id = 'rlt-prod'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'rlt-%'");

    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES " +
      "('rlt-src', 'RLTS', 'RLT Source', 'T') " +
      "ON CONFLICT (id) DO NOTHING"
    );
    await pool!.query(
      "INSERT INTO products (id, sku, name, category, product_group) VALUES " +
      "('rlt-prod', 'RLTSKU', 'RLT Product', 'Test', 'Product Item')"
    );
    await pool!.query(
      "INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty) VALUES " +
      "('stk-wh001-rlt-prod', 'rlt-prod', 'WH001', 0, 4), " +
      "('stk-brh01-rlt-prod', 'rlt-prod', 'BRH01', 0, 4) " +
      "ON CONFLICT (product_id, branch_id) DO UPDATE SET quantity_on_hand = 0, incoming_qty = 4"
    );

    // Five IN_TRANSIT shipments: one per positive/negative lane case, plus one
    // for the route-level (neither-op) rejection.
    await pool!.query(
      "INSERT INTO shipments (id, tracking_code, type, source_branch_id, source_branch_name, " +
      "destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, status, notes, items) VALUES " +
      "('rlt-wh-po', 'ST-RLT-WHPO', 'INTER_BRANCH', 'rlt-src', 'RLT Source', 'WH001', 'Branch 1 (Head Office)', '2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $1), " +
      "('rlt-br-po', 'ST-RLT-BRPO', 'INTER_BRANCH', 'rlt-src', 'RLT Source', 'BRH01', 'Branch 2', '2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $1), " +
      "('rlt-wh-fd', 'ST-RLT-WHFD', 'INTER_BRANCH', 'rlt-src', 'RLT Source', 'WH001', 'Branch 1 (Head Office)', '2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $1), " +
      "('rlt-br-fd', 'ST-RLT-BRFD', 'INTER_BRANCH', 'rlt-src', 'RLT Source', 'BRH01', 'Branch 2', '2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $1), " +
      "('rlt-route-acct', 'ST-RLT-ACCT', 'INTER_BRANCH', 'rlt-src', 'RLT Source', 'BRH01', 'Branch 2', '2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $1)",
      [shipItem]
    );

    // Two pullout bins awaiting receipt at the warehouse.
    await pool!.query(
      "INSERT INTO stock_operations (id, reference_number, type, branch_id, branch_name, " +
      "destination_warehouse_id, destination_warehouse_name, product_id, quantity_changed, reason, date_ad, date_bs, status, items) VALUES " +
      "('rlt-op-acct', 'RLT-OP-ACCT', 'PULLOUT', 'rlt-src', 'RLT Source', 'WH001', 'Branch 1 (Head Office)', 'rlt-prod', 3, 'rlt receive-lane fixture', '2026-09-01', '2083-05-16 BS', 'DISPATCHED', $1::jsonb), " +
      "('rlt-op-im', 'RLT-OP-IM', 'PULLOUT', 'rlt-src', 'RLT Source', 'WH001', 'Branch 1 (Head Office)', 'rlt-prod', 3, 'rlt receive-lane fixture', '2026-09-01', '2083-05-16 BS', 'DISPATCHED', $1::jsonb)",
      [opItem]
    );

    // The shipment handler reads the in-memory array first — seed it too.
    const fixture = (id: string, trackingCode: string, dest: string, destName: string) => ({
      id, trackingCode, type: 'INTER_BRANCH',
      sourceBranchId: 'rlt-src', sourceBranchName: 'RLT Source',
      destinationBranchId: dest, destinationBranchName: destName,
      dispatchDateAD: '2026-09-01', dispatchDateBS: '2083-05-16 BS',
      status: 'IN_TRANSIT', notes: '',
      items: [{ productId: PRODUCT, productName: 'RLT Product', quantitySent: 2 }],
    });
    setShipments([
      ...shipments.filter((s) => !(s.id || '').startsWith('rlt-')),
      fixture('rlt-wh-po', 'ST-RLT-WHPO', WH, 'Branch 1 (Head Office)') as any,
      fixture('rlt-br-po', 'ST-RLT-BRPO', BR, 'Branch 2') as any,
      fixture('rlt-wh-fd', 'ST-RLT-WHFD', WH, 'Branch 1 (Head Office)') as any,
      fixture('rlt-br-fd', 'ST-RLT-BRFD', BR, 'Branch 2') as any,
      fixture('rlt-route-acct', 'ST-RLT-ACCT', BR, 'Branch 2') as any,
    ] as any);

    // Synthetic lane matrix so the route layer (OR of the two ops) and the
    // handler layer (the destination's own op) can be told apart:
    //   PROCUREMENT_OFFICER -> warehouse lane only
    //   FRONT_DESK          -> branch-transfer lane only
    //   ACCOUNTANT          -> neither
    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    matrix['wh-receive-pullouts'] = { ...matrix['wh-receive-pullouts'], ACCOUNTANT: false, PROCUREMENT_OFFICER: true, FRONT_DESK: false };
    matrix['branch-transfer-receive'] = { ...matrix['branch-transfer-receive'], ACCOUNTANT: false, PROCUREMENT_OFFICER: false, FRONT_DESK: true };
    setPermissionMatrix(matrix);

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
    setShipments(shipments.filter((s) => !(s.id || '').startsWith('rlt-')) as any);
    setPermissionMatrix({});
    if (pool && dbReachable) {
      await pool.query("DELETE FROM stock_operations WHERE id LIKE 'rlt-%'");
      await pool.query("DELETE FROM shipments WHERE id LIKE 'rlt-%' OR tracking_code LIKE 'ST-RLT-%'");
      await pool.query("DELETE FROM inventory_stock WHERE product_id = 'rlt-prod'");
      await pool.query("DELETE FROM products WHERE id = 'rlt-prod'");
      await pool.query("DELETE FROM branches WHERE id LIKE 'rlt-%'");
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

  async function stock(branchId: string) {
    // branchId is a real demo branch (WH001 / BRH01); rows are keyed by the
    // rlt-prod fixture product so parallel test files are untouched.
    const r = await pool!.query(
      'SELECT quantity_on_hand AS "quantityOnHand", incoming_qty AS "incomingQty" ' +
      'FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      [PRODUCT, branchId]
    );
    return r.rows[0] || { quantityOnHand: 0, incomingQty: 0 };
  }

  async function shipStatus(id: string) {
    const r = await pool!.query('SELECT status FROM shipments WHERE id = $1', [id]);
    return r.rows[0]?.status || null;
  }

  async function opStatus(id: string) {
    const r = await pool!.query('SELECT status FROM stock_operations WHERE id = $1', [id]);
    return r.rows[0]?.status || null;
  }

  test('401: neither receive endpoint accepts an unauthenticated call', { skip: skipNoDb }, async () => {
    const ship = await post('/api/shipments/rlt-route-acct/receive', { receivedItems: [] });
    assert.equal(ship.status, 401, 'shipment receive must require a bearer token');
    const op = await post('/api/stock-operations/rlt-op-acct/receive', {});
    assert.equal(op.status, 401, 'stock-operation receive must require a bearer token');
  });

  test('ROUTE gate: a role with neither lane operation is 403 on shipment receive, with no state change', { skip: skipNoDb }, async () => {
    const before_stock = await stock(BR);
    const { status, json } = await post('/api/shipments/rlt-route-acct/receive', { receivedItems: [] }, acctToken);
    assert.equal(status, 403, 'ACCOUNTANT holds neither wh-receive-pullouts nor branch-transfer-receive');
    assert.match(String(json?.message || ''), /not permitted for operation/i, 'the 403 must name the missing operation');
    assert.equal(await shipStatus('rlt-route-acct'), 'IN_TRANSIT', 'a rejected receipt must not flip the shipment');
    const after_stock = await stock(BR);
    assert.deepEqual(after_stock, before_stock, 'a rejected receipt must not credit destination stock');
  });

  test('ROUTE gate (REGRESSION): stock-operation receive is gated by wh-receive-pullouts', { skip: skipNoDb }, async () => {
    // Before the fix this endpoint had no permission check at all: the client
    // hid the button, the server accepted the call from any authenticated role.
    const before_stock = await stock(WH);
    const { status, json } = await post('/api/stock-operations/rlt-op-acct/receive', {}, acctToken);
    assert.equal(status, 403, 'ACCOUNTANT lacks wh-receive-pullouts, so the pullout receipt must be forbidden');
    assert.match(String(json?.message || ''), /not permitted for operation 'wh-receive-pullouts'/i);
    assert.equal(await opStatus('rlt-op-acct'), 'DISPATCHED', 'a rejected receipt must not settle the pullout bin');
    const after_stock = await stock(WH);
    assert.deepEqual(after_stock, before_stock, 'a rejected receipt must not credit warehouse stock');
  });

  test('POSITIVE (warehouse lane): wh-receive-pullouts holder receives the shipment and stock settles', { skip: skipNoDb }, async () => {
    const before_stock = await stock(WH);
    const { status, json } = await post('/api/shipments/rlt-wh-po/receive', { receivedItems: [] }, poToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.status, 'RECEIVED');
    assert.equal(await shipStatus('rlt-wh-po'), 'RECEIVED');
    const after_stock = await stock(WH);
    assert.equal(after_stock.quantityOnHand, before_stock.quantityOnHand + 2, 'destination on-hand must grow by the received qty');
    assert.equal(after_stock.incomingQty, before_stock.incomingQty - 2, 'the incoming credit must be released');
  });

  test('HANDLER lane gate: the warehouse-lane holder is 403 on a branch-lane destination', { skip: skipNoDb }, async () => {
    const before_stock = await stock(BR);
    const { status, json } = await post('/api/shipments/rlt-br-po/receive', { receivedItems: [] }, poToken);
    assert.equal(status, 403, 'the route OR-gate passes, so the handler must reject on the destination lane');
    assert.match(String(json?.message || ''), /branch-transfer-receive.*receiving lane/i, 'the 403 must name the destination lane operation');
    assert.equal(await shipStatus('rlt-br-po'), 'IN_TRANSIT', 'a lane-rejected receipt must not flip the shipment');
    const after_stock = await stock(BR);
    assert.deepEqual(after_stock, before_stock, 'a lane-rejected receipt must not credit stock');
  });

  test('HANDLER lane gate: the branch-transfer holder is 403 on a warehouse destination', { skip: skipNoDb }, async () => {
    const before_stock = await stock(WH);
    const { status, json } = await post('/api/shipments/rlt-wh-fd/receive', { receivedItems: [] }, fdToken);
    assert.equal(status, 403, 'warehouse destinations require wh-receive-pullouts even when the route gate passes');
    assert.match(String(json?.message || ''), /wh-receive-pullouts.*receiving lane/i);
    assert.equal(await shipStatus('rlt-wh-fd'), 'IN_TRANSIT', 'a lane-rejected receipt must not flip the shipment');
    const after_stock = await stock(WH);
    assert.deepEqual(after_stock, before_stock, 'a lane-rejected receipt must not credit stock');
  });

  test('POSITIVE (branch lane): branch-transfer holder receives at the destination branch', { skip: skipNoDb }, async () => {
    const before_stock = await stock(BR);
    const { status, json } = await post('/api/shipments/rlt-br-fd/receive', { receivedItems: [] }, fdToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.status, 'RECEIVED');
    assert.equal(await shipStatus('rlt-br-fd'), 'RECEIVED');
    const after_stock = await stock(BR);
    assert.equal(after_stock.quantityOnHand, before_stock.quantityOnHand + 2, 'destination on-hand must grow by the received qty');
    assert.equal(after_stock.incomingQty, before_stock.incomingQty - 2, 'the incoming credit must be released');
  });

  test('POSITIVE (pullout bin): wh-receive-pullouts holder receives the stock operation', { skip: skipNoDb }, async () => {
    const before_stock = await stock(WH);
    const { status, json } = await post('/api/stock-operations/rlt-op-im/receive', {}, imToken);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(await opStatus('rlt-op-im'), 'RECEIVED', 'the receipt must settle in PostgreSQL');
    const after_stock = await stock(WH);
    assert.equal(after_stock.quantityOnHand, before_stock.quantityOnHand + 3, 'warehouse on-hand must grow by the bin quantity');
  });
});
