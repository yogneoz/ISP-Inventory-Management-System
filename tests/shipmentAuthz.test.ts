/**
 * Shipment authorization fixes — HTTP-layer integration tests on a real
 * Express app wired exactly as production (createApp + registerAllRoutes)
 * against real PostgreSQL. Fixtures use a "aztest-" id prefix, seeded in
 * BOTH the database and the in-memory shipments cache (the handlers read the
 * cache first, exactly as a booted server would). Skips without a reachable
 * PostgreSQL (DATABASE_URL).
 *
 * SECURITY REGRESSION GUARDS (from the 2026-10-10 review):
 *  1. VULN-001 create: an omitted sourceBranchId now defaults to the
 *     CALLER'S OWN BRANCH and is stamped into the shipment, so the stock
 *     deduction always runs — a branch user can no longer create a
 *     source-less "ghost dispatch" and receive it to fabricate stock.
 *  2. VULN-001 receive: a shipment with no source branch cannot be received
 *     (400) — receiving it would credit stock that was never deducted.
 *  3. VULN-002 cancel: POST /api/shipments/:id/cancel is gated by the new
 *     'shipment-cancel' matrix operation (ACCOUNTANT -> 403), and the actor
 *     in the audit note comes from the verified session, never the body
 *     (a spoofed body user must not appear in the trail).
 *  4. VULN-003 overwrite: creating with a client-supplied id/tracking code
 *     that names an existing shipment outside the caller's branch scope is
 *     403; overwriting one inside the caller's scope still works and does
 *     not double-deduct stock.
 *  5. VERIFY-001 ANSWER: HQ-wide non-admin accounts (signed branchId 'ALL')
 *     are NOT over-blocked — the enforceBranchAccess by-id resource lookup
 *     is dead code under Express 4 (route params are never populated in
 *     app.use middleware; verified: req.params === {} there), so the
 *     handler-level destination-affinity check is what actually enforces
 *     scope. This test pins that HQ-wide accounts reach the handler and can
 *     receive (200), so a future "fix" of the dead lookup cannot silently
 *     start rejecting them (the over-block the code review hypothesized).
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
const skipPositive = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

// FD may operate aztest-dst (home) and aztest-mid (allowedBranchIds).
const FD_USER = {
  id: 'authztest-fd', email: 'authztest-fd@example.com', name: 'Authz Test FD',
  role: 'FRONT_DESK', branchId: 'aztest-dst',
  allowedBranchIds: ['aztest-dst', 'aztest-mid'], canSwitchUser: false,
} as any;
// ACCOUNTANT lacks shipment-cancel (creator-parity defaults).
const ACCT_USER = {
  id: 'authztest-acct', email: 'authztest-acct@example.com', name: 'Authz Test Acct',
  role: 'ACCOUNTANT', branchId: 'aztest-dst',
  allowedBranchIds: ['aztest-dst'], canSwitchUser: false,
} as any;
// Non-admin HQ-wide account — VERIFY-001 over-block probe.
const HQ_WIDE_USER = {
  id: 'authztest-hq', email: 'authztest-hq@example.com', name: 'Authz Test HQ',
  role: 'INVENTORY_MANAGER', branchId: 'ALL',
  allowedBranchIds: [], canSwitchUser: false,
} as any;

describe('shipment authorization fixes (VULN-001/2/3, VERIFY-001)', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let bsDate: string | null = null;
  let createdId = '';
  const fdToken = issueAuthToken(FD_USER);
  const acctToken = issueAuthToken(ACCT_USER);
  const hqToken = issueAuthToken(HQ_WIDE_USER);

  before(async () => {
    if (!dbReachable) return;

    // Clear leftovers from aborted runs, then seed idempotently.
    await pool!.query("DELETE FROM shipments WHERE id LIKE 'aztest-%' OR id LIKE 'sh-authztest-%' OR tracking_code LIKE 'ST-AUTHZ-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id LIKE 'aztest-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'aztest-%'");
    await pool!.query("DELETE FROM branches WHERE id LIKE 'aztest-%'");

    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES " +
      "('aztest-src', 'AZSRC', 'Authz Source', 'T'), ('aztest-dst', 'AZDST', 'Authz Destination', 'T'), ('aztest-mid', 'AZMID', 'Authz Mid', 'T')"
    );
    await pool!.query(
      "INSERT INTO products (id, sku, name, category, product_group) VALUES " +
      "('aztest-prod1', 'AZSKU1', 'Authz Test Product 1', 'Test', 'Product Item')"
    );
    await pool!.query(
      "INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, incoming_qty) VALUES " +
      "('stk-aztest-src-aztest-prod1', 'aztest-prod1', 'aztest-src', 5, 0), " +
      "('stk-aztest-dst-aztest-prod1', 'aztest-prod1', 'aztest-dst', 10, 0), " +
      "('stk-aztest-mid-aztest-prod1', 'aztest-prod1', 'aztest-mid', 0, 0)"
    );

    const openItems = JSON.stringify([{ productId: 'aztest-prod1', productName: 'Authz Test Product 1', quantitySent: 2 }]);
    const hqItems = JSON.stringify([{ productId: 'aztest-prod1', productName: 'Authz Test Product 1', quantitySent: 1 }]);
    const nosrcItems = JSON.stringify([{ productId: 'aztest-prod1', productName: 'Authz Test Product 1', quantitySent: 1 }]);
    // An IN_TRANSIT dispatch (cancel + VERIFY-001 targets) and a legacy
    // NULL-source shipment (receive-block target).
    await pool!.query(
      "INSERT INTO shipments (id, tracking_code, type, source_branch_id, source_branch_name, " +
      "destination_branch_id, destination_branch_name, dispatch_date_ad, dispatch_date_bs, status, notes, items) VALUES " +
      "('aztest-open', 'ST-AUTHZ-OPEN', 'INTER_BRANCH', 'aztest-src', 'Authz Source', 'aztest-dst', 'Authz Destination', " +
      "'2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $1), " +
      "('aztest-hqopen', 'ST-AUTHZ-HQ', 'INTER_BRANCH', 'aztest-src', 'Authz Source', 'aztest-dst', 'Authz Destination', " +
      "'2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $3), " +
      "('aztest-nosrc', 'ST-AUTHZ-NOSRC', 'INTER_BRANCH', NULL, 'Authz Source', 'aztest-mid', 'Authz Mid', " +
      "'2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $2), " +
      "('aztest-foreign', 'ST-AUTHZ-FORN', 'INTER_BRANCH', 'aztest-src', 'Authz Source', 'aztest-src', 'Authz Source', " +
      "'2026-09-01', '2083-05-16 BS', 'IN_TRANSIT', '', $1)",
      [openItems, nosrcItems, hqItems]
    );

    // Inject into the in-memory cache too (handlers read the array first).
    const fixture = (id: string, trackingCode: string, src: string | null, dst: string, qty: number) => ({
      id, trackingCode, type: 'INTER_BRANCH',
      sourceBranchId: src, sourceBranchName: 'Authz Branch',
      destinationBranchId: dst, destinationBranchName: 'Authz Branch',
      dispatchDateAD: '2026-09-01', dispatchDateBS: '2083-05-16 BS',
      status: 'IN_TRANSIT', notes: '',
      items: [{ productId: 'aztest-prod1', productName: 'Authz Test Product 1', quantitySent: qty }],
    });
    setShipments([
      ...shipments.filter((s) => !(s.id || '').startsWith('aztest-') && !(s.id || '').startsWith('sh-authztest-')),
      fixture('aztest-open', 'ST-AUTHZ-OPEN', 'aztest-src', 'aztest-dst', 2) as any,
      fixture('aztest-hqopen', 'ST-AUTHZ-HQ', 'aztest-src', 'aztest-dst', 1) as any,
      fixture('aztest-nosrc', 'ST-AUTHZ-NOSRC', null, 'aztest-mid', 1) as any,
      fixture('aztest-foreign', 'ST-AUTHZ-FORN', 'aztest-src', 'aztest-src', 2) as any,
    ] as any);

    // Tests never run dbBoot, so seed the in-memory permission matrix from
    // the same defaults the boot inserts (requirePermissionAny reads it).
    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));

    // The create flow requires a BS day record for its dispatch date.
    const bs = await pool!.query('SELECT ad_date::text AS d FROM bs_day_records ORDER BY ad_date LIMIT 1');
    bsDate = bs.rows[0]?.d || null;

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
    setShipments(shipments.filter((s) => !(s.id || '').startsWith('aztest-') && !(s.id || '').startsWith('sh-authztest-')) as any);
    setPermissionMatrix({});
    if (pool && dbReachable) {
      await pool.query("DELETE FROM shipments WHERE id LIKE 'aztest-%' OR id LIKE 'sh-authztest-%' OR tracking_code LIKE 'ST-AUTHZ-%'");
      await pool.query("DELETE FROM inventory_stock WHERE product_id LIKE 'aztest-%'");
      await pool.query("DELETE FROM products WHERE id LIKE 'aztest-%'");
      await pool.query("DELETE FROM branches WHERE id LIKE 'aztest-%'");
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

  async function stock(productId: string, branchId: string) {
    const r = await pool!.query(
      'SELECT quantity_on_hand AS "quantityOnHand", incoming_qty AS "incomingQty" ' +
      'FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      [productId, branchId]
    );
    return r.rows[0] || { quantityOnHand: 0, incomingQty: 0 };
  }

  test('VULN-001 create: omitted sourceBranchId defaults to the caller\'s branch and deducts it', { skip: skipPositive }, async (t) => {
    if (!bsDate) return t.skip('needs bs_day_records');
    const before_src = await stock('aztest-prod1', 'aztest-dst');
    const before_dst = await stock('aztest-prod1', 'aztest-mid');

    const { status, json } = await post('/api/shipments', {
      type: 'INTER_BRANCH',
      destinationBranchId: 'aztest-mid',   // in FD's scope
      dispatchDateAD: bsDate,
      trackingCode: 'ST-AUTHZ-1',
      // NO sourceBranchId — the pre-fix hole.
      items: [{ productId: 'aztest-prod1', productName: 'Authz Test Product 1', quantitySent: 3 }],
    }, fdToken);

    assert.equal(status, 201, 'create must succeed with an omitted source');
    assert.equal(json.sourceBranchId, 'aztest-dst', 'omitted source must default to the caller\'s own branch, never a foreign one');
    createdId = json.id;

    const after_src = await stock('aztest-prod1', 'aztest-dst');
    const after_dst = await stock('aztest-prod1', 'aztest-mid');
    assert.equal(after_src.quantityOnHand, before_src.quantityOnHand - 3, 'source (caller\'s branch) must be deducted — no ghost dispatch');
    assert.equal(after_dst.incomingQty, before_dst.incomingQty + 3, 'destination incoming must be credited');
  });

  test('VULN-001 receive: receipt credits only a dispatch that actually deducted stock', { skip: skipPositive }, async (t) => {
    if (!bsDate || !createdId) return t.skip('needs the create fixture from the previous test');
    const before_dst = await stock('aztest-prod1', 'aztest-mid');

    const { status, json } = await post(`/api/shipments/${createdId}/receive`, {
      receivedItems: [],
      receivedByNotes: 'authz test receipt',
    }, fdToken);

    assert.equal(status, 200, 'receiving the (now properly deducted) dispatch must succeed');
    assert.equal(json.status, 'RECEIVED');
    const after_dst = await stock('aztest-prod1', 'aztest-mid');
    assert.equal(after_dst.quantityOnHand, before_dst.quantityOnHand + 3, 'destination on-hand must increase by the received qty');
    assert.equal(after_dst.incomingQty, 0, 'destination incoming must be released');
  });

  test('VULN-001 receive: a null-source shipment cannot be received (stock fabrication)', { skip: skipPositive }, async () => {
    const before_dst = await stock('aztest-prod1', 'aztest-mid');
    const { status, json } = await post('/api/shipments/aztest-nosrc/receive', {
      receivedItems: [],
      receivedByNotes: 'should be rejected',
    }, fdToken);
    assert.equal(status, 400, 'receipt of a source-less shipment must be rejected');
    assert.match(String(json?.message || ''), /no source branch/i, 'the rejection must explain the fabricated-stock risk');
    const after_dst = await stock('aztest-prod1', 'aztest-mid');
    assert.equal(after_dst.quantityOnHand, before_dst.quantityOnHand, 'no stock may be credited');
  });

  test('VULN-002 cancel: a role without shipment-cancel is rejected', { skip: skipPositive }, async () => {
    const { status } = await post('/api/shipments/aztest-open/cancel', { reason: 'should be denied' }, acctToken);
    assert.equal(status, 403, 'ACCOUNTANT lacks shipment-cancel in the default matrix');
  });

  test('VULN-002 cancel: allowed role cancels, actor comes from the session not the body', { skip: skipPositive }, async () => {
    const before_src = await stock('aztest-prod1', 'aztest-src');
    const { status, json } = await post('/api/shipments/aztest-open/cancel', {
      reason: 'authz test cancel',
      user: { name: 'SPOOFED-BODY-USER' },   // must never reach the audit note
    }, fdToken);

    assert.equal(status, 200, 'FRONT_DESK has shipment-cancel (creator parity)');
    const notes = String(json?.shipment?.notes || '');
    assert.match(notes, /Authz Test FD/, 'the cancellation note actor must be the session identity');
    assert.ok(!notes.includes('SPOOFED-BODY-USER'), 'a spoofed body user must not reach the audit note');
    const after_src = await stock('aztest-prod1', 'aztest-src');
    assert.equal(after_src.quantityOnHand, before_src.quantityOnHand + 2, 'source stock must be restored on cancel');
  });

  test('VULN-003 overwrite: an id naming a shipment outside the caller\'s scope is rejected', { skip: skipPositive }, async (t) => {
    if (!bsDate) return t.skip('needs bs_day_records');
    const { status, json } = await post('/api/shipments', {
      id: 'aztest-foreign',                 // exists: source+dest are both aztest-src (out of FD's scope)
      type: 'INTER_BRANCH',
      destinationBranchId: 'aztest-mid',
      dispatchDateAD: bsDate,
      trackingCode: 'ST-AUTHZ-6',
      items: [{ productId: 'aztest-prod1', productName: 'Authz Test Product 1', quantitySent: 1 }],
    }, fdToken);
    assert.equal(status, 403, 'overwriting a foreign shipment by id must be forbidden');
    assert.match(String(json?.message || ''), /outside your branch scope/i);
  });

  test('VULN-003 overwrite: in-scope id still updates without double-deducting stock', { skip: skipPositive }, async (t) => {
    if (!bsDate || !createdId) return t.skip('needs the create fixture from the first test');
    const before_src = await stock('aztest-prod1', 'aztest-dst');
    const { status } = await post('/api/shipments', {
      id: createdId,                        // the caller's own shipment (aztest-dst -> aztest-mid)
      type: 'INTER_BRANCH',
      destinationBranchId: 'aztest-mid',
      dispatchDateAD: bsDate,
      trackingCode: 'ST-AUTHZ-1',
      items: [{ productId: 'aztest-prod1', productName: 'Authz Test Product 1', quantitySent: 1 }],
    }, fdToken);
    assert.equal(status, 201, 'updating an in-scope shipment must keep working');
    const after_src = await stock('aztest-prod1', 'aztest-dst');
    assert.equal(after_src.quantityOnHand, before_src.quantityOnHand, 'an update must not deduct the source again');
  });

  test('VERIFY-001: HQ-wide non-admin accounts are NOT over-blocked (by-id lookup is inert)', { skip: skipPositive }, async () => {
    // The review hypothesized that the enforceBranchAccess by-id resource
    // lookup would 403 branchId 'ALL' accounts. Empirically it does not:
    // under Express 4, req.params is {} in app.use middleware, so the lookup
    // never executes and handler-level destination affinity governs. This
    // pins the real behavior — an HQ-wide INVENTORY_MANAGER can receive at
    // any branch — so resurrecting the dead lookup as a live check cannot
    // silently start rejecting these accounts without a test failure.
    const before_dst = await stock('aztest-prod1', 'aztest-dst');
    const { status } = await post('/api/shipments/aztest-hqopen/receive', { receivedItems: [] }, hqToken);
    assert.equal(status, 200, 'HQ-wide accounts must reach the receive handler, not be rejected by middleware');
    const after_dst = await stock('aztest-prod1', 'aztest-dst');
    assert.equal(after_dst.quantityOnHand, before_dst.quantityOnHand + 1, 'the receipt must credit the destination');
  });
});
