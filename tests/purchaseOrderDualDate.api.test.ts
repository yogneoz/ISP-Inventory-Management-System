import { purgeAuditLogs } from './support/purgeAuditLogs';
/**
 * Purchase-order dual-date read (2026-11-07).
 *
 * The write path derives `expected_delivery_date_bs` from `bs_day_records`, but
 * a register is only as correct as its read: the PO select used to return
 * `expectedDeliveryDateAD` alone, so every screen and CSV export silently lost
 * the BS half even though the row stored it.
 *
 * This test drives the real Express app against PostgreSQL:
 *   1. create a PO through the API (the same path the form uses);
 *   2. read the row directly to capture the stored AD/BS pair;
 *   3. GET the paged register and prove the response carries BOTH values,
 *      with the BS half exactly the persisted string — not a recomputation;
 *   4. GET the PO print route and prove it renders a real `%PDF-` response.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { ensureReferenceData } from './fixtures/referenceData';

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

const PO_ID = 'podual-read-1';
const PO_NUMBER = 'PODUAL-READ-1';
// Both dates sit in the same month so the reference fixture seeds the exact
// BS day records the server's derivation reads.
const ORDER_AD = '2026-11-05';
const DELIVERY_AD = '2026-11-20';

const ADMIN = {
  id: 'podual-admin',
  email: 'podual-admin@example.com',
  name: 'PODUAL Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

describe('purchase-order dual-date read (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);

  async function cleanup() {
    await pool!.query('DELETE FROM purchase_orders WHERE id = $1', [PO_ID]);
    await purgeAuditLogs(pool!, "DELETE FROM audit_logs WHERE details LIKE '%PODUAL-READ-1%'");
  }

  before(async () => {
    await ensureReferenceData(pool!, ORDER_AD);
    await cleanup();

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
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function call(method: 'GET' | 'POST', route: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + route, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  test('GET returns the stored expectedDeliveryDateBS beside its AD date', async () => {
    const created = await call('POST', '/api/purchase-orders', {
      id: PO_ID,
      poNumber: PO_NUMBER,
      supplierName: 'PODUAL Vendor',
      branchId: 'WH001',
      orderDateAD: ORDER_AD,
      expectedDeliveryDateAD: DELIVERY_AD,
      items: [],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));

    const stored = await pool!.query(
      `SELECT expected_delivery_date_ad::text AS ad,
              expected_delivery_date_bs AS bs
         FROM purchase_orders
        WHERE id = $1`,
      [PO_ID]
    );
    assert.equal(stored.rows.length, 1, 'the PO must be persisted before the read');
    const storedAD = stored.rows[0].ad;
    const storedBS = stored.rows[0].bs;
    assert.equal(storedAD, DELIVERY_AD, 'the AD half is the date the caller chose');
    assert.match(
      String(storedBS),
      /^\d{4}-\d{2}-\d{2} BS$/,
      'the write path must persist a real BS half, not leave it null'
    );

    const read = await call(
      'GET',
      `/api/purchase-orders?branchId=WH001&query=${encodeURIComponent(PO_NUMBER)}&page=1&pageSize=50`
    );
    assert.equal(read.status, 200, JSON.stringify(read.json));
    const rows = Array.isArray(read.json?.data) ? read.json.data : read.json;
    const row = Array.isArray(rows) ? rows.find((entry: any) => entry.id === PO_ID) : null;
    assert.ok(row, 'the paged register read must return the created PO');
    assert.equal(
      String(row.expectedDeliveryDateAD).slice(0, 10),
      storedAD,
      'the read must return the AD half'
    );
    assert.equal(
      row.expectedDeliveryDateBS,
      storedBS,
      'the read must return the persisted BS half, not omit or recompute it'
    );

    const pdfRes = await fetch(
      `http://127.0.0.1:${port}/api/purchase-orders/${encodeURIComponent(PO_ID)}/print`,
      { headers: { authorization: 'Bearer ' + token } }
    );
    const pdf = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(pdfRes.status, 200, pdf.toString('utf8', 0, 300));
    assert.match(pdfRes.headers.get('content-type') || '', /^application\/pdf\b/);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(pdf.length > 5000, 'the PO print route must render a page, not a stub');
  });
});
