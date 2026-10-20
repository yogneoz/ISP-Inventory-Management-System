/**
 * Mirror retirement step 3 — PG-first reads (HTTP-layer integration tests).
 *
 * PROVES, on a real Express app wired exactly as production (createApp +
 * registerAllRoutes) against real PostgreSQL, that stale mirror rows can no
 * longer decide responses while PG is up:
 *
 *  1. LEGACY GET /api/stock-operations (no params) is live from PG: a
 *     PG-only op appears, a stale mirror status loses to PG, and a
 *     mirror-only op no longer leaks into the response.
 *  2. RECEIVE pre-check reads PG: PG says RECEIVED -> 409 even though the
 *     mirror still says LOGGED (the old mirror-first read fell through to
 *     the transaction and surfaced a 500).
 *  3. REVERSE guards read PG: PG says CANCELLED -> 400 even though the
 *     mirror still says LOGGED (the old mirror-first read ran a full
 *     second reversal).
 *  4. EXCHANGE reads PG first: the response seeds from the PG row, the mirror
 *     copy of the OLD record is still flipped (dual-write kept), the
 *     replacement must be an IN_STOCK register row at the branch, and a blank
 *     PON/MAC is hydrated from that row.
 *  5. SERIAL RENAME reads PG first: the response record is the PG row, and
 *     the mirror row is still cascaded in place (dual-write kept).
 *
 * Fixtures use an "m3-" id prefix (and "M3" serials), seeded in BOTH the
 * database and the in-memory mirrors, removed in after(). Skips without a
 * reachable PostgreSQL (DATABASE_URL).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  createApp,
  registerAllRoutes,
  stockOperations,
  setStockOperations,
  customerDeviceRecords,
  setCustomerDeviceRecords,
} from '../server/src/app';
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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const SUPER_USER = {
  id: 'm3-super', email: 'm3-super@example.com', name: 'M3 Test',
  role: 'SUPER_ADMIN', branchId: 'm3-branch',
  allowedBranchIds: ['m3-branch'], canSwitchUser: false,
} as any;

describe('mirror step 3: PG-first reads with mirror fallback', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);
  let origOps: any[] = [];
  let origCdr: any[] = [];

  before(async () => {
    origOps = [...stockOperations];
    origCdr = [...customerDeviceRecords];
    if (!dbReachable) return;

    // Clear leftovers from aborted runs, then seed idempotently.
    await pool!.query("DELETE FROM serial_log WHERE device_serial LIKE 'M3%'");
    await pool!.query("DELETE FROM customer_device_records WHERE id LIKE 'm3-%' OR device_serial LIKE 'M3%'");
    await pool!.query("DELETE FROM stock_operations WHERE id LIKE 'm3-%'");
    await pool!.query("DELETE FROM branches WHERE id = 'm3-branch'");

    await pool!.query(
      "INSERT INTO branches (id, code, name, location) VALUES ('m3-branch', 'M3BR', 'M3 Test Branch', 'T')"
    );
    // PG truth: three ops across the statuses the guards care about, plus one
    // op that exists ONLY in PG (the old mirror-first legacy GET hid it).
    await pool!.query(
      `INSERT INTO stock_operations (id, reference_number, type, branch_id, branch_name, reason, date_ad, date_bs, status, items) VALUES
       ('m3-op-list',  'M3-LIST-1', 'DAMAGE',  'm3-branch', 'M3 Test Branch', 'm3 fixture', '2026-09-01', '2083-05-16 BS', 'DISPATCHED', '[]'::jsonb),
       ('m3-op-live',  'M3-LIVE-1', 'PULLOUT', 'm3-branch', 'M3 Test Branch', 'm3 fixture', '2026-09-01', '2083-05-16 BS', 'LOGGED',     '[]'::jsonb),
       ('m3-op-recv',  'M3-RECV-1', 'PULLOUT', 'm3-branch', 'M3 Test Branch', 'm3 fixture', '2026-09-01', '2083-05-16 BS', 'RECEIVED',   '[]'::jsonb),
       ('m3-op-rev',   'M3-REV-1',  'DAMAGE',  'm3-branch', 'M3 Test Branch', 'm3 fixture', '2026-09-01', '2083-05-16 BS', 'CANCELLED',  '[]'::jsonb)`
    );
    await pool!.query(
      `INSERT INTO customer_device_records (id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, status, notes)
       VALUES ('m3-cdr', 'PG Customer', 'M3C', 'm3-branch', 'M3 Product', 'M3-OLD-PG', 'M3PON-OLD', 'RENTAL', 'pg fixture')`
    );
    // The exchange gate draws its replacement from the register, so the fixture
    // must carry a real IN_STOCK row (the old test posted a serial that existed
    // only in the request body). The MAC is deliberately not sent by the test,
    // proving the blank is hydrated from this row.
    await pool!.query(
      `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_name, branch_id, status, source_type) VALUES
       ('m3-sl-new', 'M3-NEW-EX', 'M3PON-EX', 'A4:C3:F0:B1:D2:E3', 'M3 Product', 'm3-branch', 'IN_STOCK', 'PURCHASE'),
       ('m3-sl-assigned', 'M3-AWAY-ASSIGNED', 'M3PON-AWAY', NULL, 'M3 Product', 'm3-branch', 'CUSTOMER_ASSIGNED', 'PURCHASE')`
    );

    // Stale mirror state: every shared id disagrees with PG, and one op
    // exists only in the mirror (must not leak while PG is up).
    const staleOp = (id: string, referenceNumber: string, type: string) => ({
      id, referenceNumber, type, branchId: 'm3-branch', branchName: 'M3 Test Branch',
      status: 'LOGGED', items: [], reason: 'm3 fixture',
      dateAD: '2026-09-01', dateBS: '2083-05-16 BS',
    });
    setStockOperations([
      ...origOps,
      staleOp('m3-op-list', 'M3-LIST-1', 'DAMAGE'),
      staleOp('m3-op-recv', 'M3-RECV-1', 'PULLOUT'),
      staleOp('m3-op-rev', 'M3-REV-1', 'DAMAGE'),
      staleOp('m3-op-ghost', 'M3-GHOST-1', 'DAMAGE'),
    ] as any);
    setCustomerDeviceRecords([
      ...origCdr,
      {
        id: 'm3-cdr', customerId: null, customerName: 'Stale Customer', customerCode: 'M3C',
        branchId: 'm3-branch', productName: 'M3 Product',
        deviceSerial: 'M3-OLD-STALE', ponSerial: 'M3PON-OLD', status: 'RENTAL',
        contactPhone: 'STALE-PHONE', notes: 'stale fixture',
      } as any,
    ] as any);

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
    setStockOperations(origOps as any);
    setCustomerDeviceRecords(origCdr as any);
    if (pool && dbReachable) {
      await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'M3%'");
      await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'm3-%' OR device_serial LIKE 'M3%'");
      await pool.query("DELETE FROM stock_operations WHERE id LIKE 'm3-%'");
      await pool.query("DELETE FROM branches WHERE id = 'm3-branch'");
      await pool.end();
    }
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  test('legacy GET /api/stock-operations serves PG live, not the mirror', { skip: skipNoDb }, async () => {
    const { status, json } = await call('GET', '/api/stock-operations');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json), 'legacy shape must stay a full array');
    const byId = (id: string) => json.find((o: any) => o.id === id);

    // PG-only op: hidden by the old mirror-first read.
    assert.ok(byId('m3-op-live'), 'PG-only operation must be listed');
    // Stale shared id: PG status wins over the mirror's LOGGED.
    assert.equal(byId('m3-op-list')?.status, 'DISPATCHED', 'PG status must win over the stale mirror');
    // Mirror-only op: must not leak while PG is up.
    assert.equal(byId('m3-op-ghost'), undefined, 'mirror-only operation must not leak into a live PG read');
  });

  test('receive pre-check reads PG (409) instead of falling through from the stale mirror', { skip: skipNoDb }, async () => {
    const { status, json } = await call('POST', '/api/stock-operations/m3-op-recv/receive', {});
    assert.equal(status, 409);
    assert.match(String(json?.message), /already been received/);
  });

  test('reverse guards read PG (400 already reversed) instead of re-running a reversal', { skip: skipNoDb }, async () => {
    const { status, json } = await call('POST', '/api/stock-operations/m3-op-rev/reverse', { reason: 'm3 reversal test' });
    assert.equal(status, 400);
    assert.match(String(json?.message), /already been reversed/);
  });

  test('device exchange reads PG first and still flips the mirror copy of the old record', { skip: skipNoDb }, async () => {
    const { status, json } = await call('POST', '/api/customer-devices/exchange', {
      oldDeviceId: 'm3-cdr',
      exchangeReason: 'm3 exchange test',
      oldDeviceAction: 'KEEP',
      newProductName: 'M3 Product',
      newDeviceSerial: 'M3-NEW-EX',
      newPonSerial: 'M3PON-EX',
      notes: '',
    });
    assert.equal(status, 201);
    assert.equal(json?.oldRecord?.customerName, 'PG Customer', 'response must seed from the PG row, not the stale mirror');
    assert.equal(json?.oldRecord?.deviceSerial, 'M3-OLD-PG', 'PG device serial must win over the stale mirror');

    const mirrorOld = customerDeviceRecords.find((c: any) => c.id === 'm3-cdr');
    assert.ok(mirrorOld, 'mirror row must still exist after the exchange');
    assert.equal(mirrorOld.status, 'EXCHANGED', 'mirror copy of the OLD record must still be flipped (dual-write)');

    // The register is the authority for identity: the test sent no MAC, so the
    // replacement row must carry the MAC of the IN_STOCK register row.
    const newRow = await pool!.query(
      'SELECT pon_serial, mac_address FROM customer_device_records WHERE device_serial = $1',
      ['M3-NEW-EX']
    );
    assert.equal(newRow.rows[0]?.pon_serial, 'M3PON-EX');
    assert.equal(newRow.rows[0]?.mac_address, 'A4:C3:F0:B1:D2:E3', 'blank MAC must be hydrated from the register');
  });

  test('device exchange refuses a replacement that is not IN_STOCK at the branch', { skip: skipNoDb }, async () => {
    const { status, json } = await call('POST', '/api/customer-devices/exchange', {
      oldDeviceId: 'm3-cdr',
      exchangeReason: 'm3 gate test',
      oldDeviceAction: 'KEEP',
      newProductName: 'M3 Product',
      newDeviceSerial: 'M3-AWAY-ASSIGNED',
      newPonSerial: 'M3PON-AWAY',
      notes: '',
    });
    assert.equal(status, 400, 'a replacement the register does not hold as IN_STOCK must be refused, not 500/201');
    assert.match(String(json?.message), /CUSTOMER_ASSIGNED \(not IN_STOCK\)/);

    const cdrRows = await pool!.query(
      'SELECT 1 FROM customer_device_records WHERE device_serial = $1',
      ['M3-AWAY-ASSIGNED']
    );
    assert.equal(cdrRows.rowCount, 0, 'a refused exchange must not write a customer-device row');
    const oldRow = await pool!.query('SELECT status FROM customer_device_records WHERE id = $1', ['m3-cdr']);
    assert.equal(oldRow.rows[0]?.status, 'EXCHANGED', 'the earlier successful exchange must stay applied');
  });

  test('serial rename reads PG first and still cascades the mirror row in place', { skip: skipNoDb }, async () => {
    const { status, json } = await call('PATCH', '/api/inventory/serials', {
      id: 'm3-cdr',
      deviceSerial: 'M3REN-1',
      ponSerial: 'M3PON-REN',
    });
    assert.equal(status, 200);
    assert.equal(json?.success, true);
    assert.equal(json?.record?.customerName, 'PG Customer', 'response record must be the PG row, not the stale mirror');

    const pgRow = await pool!.query('SELECT device_serial, pon_serial FROM customer_device_records WHERE id = $1', ['m3-cdr']);
    assert.equal(pgRow.rows[0]?.device_serial, 'M3REN-1', 'PG row must carry the renamed serial');
    assert.equal(pgRow.rows[0]?.pon_serial, 'M3PON-REN', 'PG row must carry the renamed PON');

    const mirrorRec = customerDeviceRecords.find((c: any) => c.id === 'm3-cdr');
    assert.ok(mirrorRec, 'mirror row must still exist after the rename');
    assert.equal(mirrorRec.deviceSerial, 'M3REN-1', 'mirror row must be cascaded in place (dual-write)');
  });
});
