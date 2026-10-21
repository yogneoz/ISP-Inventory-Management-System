/**
 * Device-exchange concurrency (real PostgreSQL, HTTP layer).
 *
 * PROVES that two operators exchanging DIFFERENT units for the SAME replacement
 * serial at the same moment cannot both win. post_exchange gates the replacement
 * twice — a pre-flight before any mirror write and a locked re-check
 * (SERIAL_GATE_LOCK_SQL ... FOR UPDATE) inside the exchange transaction — so the
 * register row serializes the two requests: exactly one returns 201, the other is
 * refused 400 naming the status the winner left behind (CUSTOMER_ASSIGNED).
 *
 * The assertions pin the INVARIANT, not the interleaving: whichever request wins,
 * exactly one succeeds. They also pin the consequences the gate exists for —
 * one customer-device row for the replacement serial (carrying the register's
 * PON/MAC, so a one-field payload is still complete), the register holding it as
 * CUSTOMER_ASSIGNED, and the loser's own old record untouched (still RENTAL) so a
 * refused exchange leaves no half-applied customer state.
 *
 * Fixtures use an "exc-" id prefix and "EXC-" serials, removed in after().
 * Skips without a reachable PostgreSQL (the CI service container provides one).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  createApp,
  registerAllRoutes,
  customerDeviceRecords,
  setCustomerDeviceRecords,
} from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';

dotenv.config();

let probePool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    probePool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await probePool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  probePool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const SUPER_USER = {
  id: 'exc-super', email: 'exc-super@example.com', name: 'EXC Test',
  role: 'SUPER_ADMIN', branchId: 'exc-branch',
  allowedBranchIds: ['exc-branch'], canSwitchUser: false,
} as any;

describe('device exchange concurrency: one replacement serial, one winner', () => {
  let pool = probePool!;
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(SUPER_USER);
  let origCdr: any[] = [];

  before(async () => {
    origCdr = [...customerDeviceRecords];
    if (!dbReachable) return;

    // Clear leftovers from aborted runs, then seed idempotently.
    await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'EXC-%'");
    await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'exc-%' OR device_serial LIKE 'EXC-%'");
    await pool.query("DELETE FROM branches WHERE id = 'exc-branch'");

    await pool.query(
      "INSERT INTO branches (id, code, name, location) VALUES ('exc-branch', 'EXCBR', 'EXC Test Branch', 'T')"
    );
    // Two customers, two different old units: the contested resource is the
    // REPLACEMENT serial, not the record.
    await pool.query(
      `INSERT INTO customer_device_records (id, customer_name, customer_code, branch_id, product_name, device_serial, pon_serial, status, notes)
       VALUES ('exc-cdr-a', 'Customer A', 'EXCA', 'exc-branch', 'EXC Product', 'EXC-OLD-A', 'EXCPON-A', 'RENTAL', 'exc fixture'),
              ('exc-cdr-b', 'Customer B', 'EXCB', 'exc-branch', 'EXC Product', 'EXC-OLD-B', 'EXCPON-B', 'RENTAL', 'exc fixture'),
              ('exc-cdr-c', 'Customer C', 'EXCC', 'exc-branch', 'EXC Product', 'EXC-OLD-C', 'EXCPON-C', 'RENTAL', 'exc fixture')`
    );
    // The IN_STOCK units the exchanges will name. EXC-NEW is contested by the
    // first test; EXC-LOCKED is taken by a competing writer in the second.
    await pool.query(
      `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_name, branch_id, status, source_type)
       VALUES ('exc-sl-new', 'EXC-NEW', 'EXC-PON', 'DE:AD:BE:EF:00:01', 'EXC Product', 'exc-branch', 'IN_STOCK', 'PURCHASE'),
              ('exc-sl-locked', 'EXC-LOCKED', 'EXC-PON-L', NULL, 'EXC Product', 'exc-branch', 'IN_STOCK', 'PURCHASE')`
    );

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
    setCustomerDeviceRecords(origCdr as any);
    if (dbReachable) {
      await pool.query("DELETE FROM serial_log WHERE device_serial LIKE 'EXC-%'");
      await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'exc-%' OR device_serial LIKE 'EXC-%'");
      await pool.query("DELETE FROM branches WHERE id = 'exc-branch'");
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

  const exchange = (oldDeviceId: string, deviceSerial = 'EXC-NEW', ponSerial = 'EXC-PON') => call('POST', '/api/customer-devices/exchange', {
    oldDeviceId,
    exchangeReason: 'concurrency test',
    oldDeviceAction: 'KEEP',
    newProductName: 'EXC Product',
    newDeviceSerial: deviceSerial,
    // PON is sent (and must match the register); MAC is deliberately omitted to
    // prove the server hydrates it from the winning register row.
    newPonSerial: ponSerial,
    notes: '',
    branchId: 'exc-branch',
  });

  test('two simultaneous exchanges for one replacement serial yield exactly one 201', { skip: skipNoDb }, async () => {
    const [a, b] = await Promise.all([exchange('exc-cdr-a'), exchange('exc-cdr-b')]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.equal(statuses.filter((s) => s === 201).length, 1, `expected exactly one winner, got ${JSON.stringify(statuses)}`);

    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    assert.equal(winner.json?.newRecord?.deviceSerial, 'EXC-NEW');
    // Which guard catches the loser depends on the interleaving, and both are
    // correct: the register gate (the unit is no longer IN_STOCK) when the two
    // transactions overlap, or the duplicate check (a customer record already
    // names the serial) when the loser arrives after the winner committed.
    assert.ok([400, 409].includes(loser.status), `loser must be refused, got ${loser.status}`);
    assert.match(
      String(loser.json?.message),
      /CUSTOMER_ASSIGNED \(not IN_STOCK\)|already registered to another device/,
      'the refusal must say why the unit is unavailable'
    );

    // Exactly one customer-device row for the replacement, hydrated from the
    // register (PON sent, MAC pulled from the register row).
    const cdr = await pool.query(
      "SELECT device_serial, pon_serial, mac_address FROM customer_device_records WHERE device_serial = 'EXC-NEW'"
    );
    assert.equal(cdr.rowCount, 1, 'the contested serial must end up on exactly one customer record');
    assert.equal(cdr.rows[0].pon_serial, 'EXC-PON');
    assert.equal(cdr.rows[0].mac_address, 'DE:AD:BE:EF:00:01', 'blank MAC must be hydrated from the register');

    // The register holds the unit, so a third attempt is refused for the same
    // reason (not because the row vanished).
    const sl = await pool.query("SELECT status FROM serial_log WHERE device_serial = 'EXC-NEW'");
    assert.equal(sl.rows[0]?.status, 'CUSTOMER_ASSIGNED');

    // The loser's own old unit was rolled back: exactly one EXCHANGED record.
    const olds = await pool.query(
      "SELECT id, status FROM customer_device_records WHERE id IN ('exc-cdr-a', 'exc-cdr-b') ORDER BY id"
    );
    const exchanged = olds.rows.filter((r) => r.status === 'EXCHANGED');
    assert.equal(exchanged.length, 1, 'only the winner may close its old record');
    assert.equal(olds.rows.find((r) => r.status === 'RENTAL')?.status, 'RENTAL');
    assert.equal(
      winner.json?.oldRecord?.id,
      exchanged[0]?.id,
      'the winner response must be the record that actually closed'
    );
  });

  test('the exchange lookup is readable by the exchange audience, not only serial editors', () => {
    // The dialogs resolve a replacement serial before submitting. If they used
    // the edit-modal lookup they would 403 for FIELD_TECHNICIAN / BRANCH_MANAGER
    // (no 'edit-device-serials' permission) and fall back to "not in the
    // register", which is the wording this whole path exists to remove.
    const routes = fs.readFileSync(path.resolve('server/src/routes/inventory.routes.ts'), 'utf8');
    assert.ok(
      routes.includes(
        "app.get('/api/customer-devices/exchange/lookup', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'FIELD_TECHNICIAN', 'BRANCH_MANAGER')"
      ),
      'the exchange lookup must carry the exchange role list'
    );
    assert.ok(
      routes.includes('get_exchangeLookup(req as any, res as any)'),
      'the route must use the exchange handler, which masks a foreign-branch holder'
    );
    const text = fs.readFileSync(path.resolve('client/src/services/api/inventory.ts'), 'utf8');
    assert.ok(
      text.includes('/api/customer-devices/exchange/lookup?'),
      'the client helper must call that route, not the edit-modal lookup'
    );
    assert.ok(
      /if \(branchId\) search\.append\('branchId', branchId\)/.test(text),
      'branch-bound roles must send branchId or the branch-scoped read guard answers 403'
    );
    // The edit-modal lookup keeps its tighter permission.
    assert.ok(
      routes.includes("app.get('/api/inventory/serials/lookup', requirePermission('edit-device-serials')"),
      'the serial edit lookup must stay behind edit-device-serials'
    );
  });

  test('a competing writer that holds the row mid-request cannot be raced past', { skip: skipNoDb }, async () => {
    // Someone else is already taking EXC-LOCKED (an assignment, a sale, a
    // second exchange) and has not committed yet. The exchange blocks on the
    // register row, and once that transaction commits the request is refused
    // rather than writing a customer record for a unit that is no longer stock.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("UPDATE serial_log SET status = 'CUSTOMER_ASSIGNED' WHERE device_serial = 'EXC-LOCKED'");

      const pending = exchange('exc-cdr-c', 'EXC-LOCKED', 'EXC-PON-L');
      // Give the request time to reach the gate while the row is still locked;
      // if it arrives after the commit the same refusal follows, so the outcome
      // asserted below does not depend on this delay.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await holder.query('COMMIT');

      const { status, json } = await pending;
      assert.equal(status, 400, 'a unit taken mid-request must be refused, not written');
      assert.match(String(json?.message), /CUSTOMER_ASSIGNED \(not IN_STOCK\)/);

      const cdr = await pool.query("SELECT 1 FROM customer_device_records WHERE device_serial = 'EXC-LOCKED'");
      assert.equal(cdr.rowCount, 0, 'no customer record may name a unit the register did not hand over');
      const oldRow = await pool.query("SELECT status FROM customer_device_records WHERE id = 'exc-cdr-c'");
      assert.equal(oldRow.rows[0]?.status, 'RENTAL', 'the refused exchange must leave the old record open');
    } finally {
      holder.release();
    }
  });
});
