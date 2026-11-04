/**
 * Sales Agents & Areas + customer defaults + invoice snapshots (real HTTP + PG).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { ensureReferenceData } from './fixtures/referenceData';

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

const BR = 'SMBR';
const TODAY = new Date().toISOString().slice(0, 10);
const USERS = {
  super: { id: 'sm-super', email: 'sm-super@example.com', name: 'SM Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  auditor: { id: 'sm-auditor', email: 'sm-auditor@example.com', name: 'SM Auditor', role: 'AUDITOR', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
} as const;
const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

describe('sales areas, agents and invoice snapshots (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let areaId = '';
  let agentId = '';

  async function request(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON is a finding */ }
    return { status: res.status, json };
  }
  const get = (path: string, token?: string) => request('GET', path, token);
  const post = (path: string, token: string | undefined, body: unknown) => request('POST', path, token, body);
  const patch = (path: string, token: string | undefined, body: unknown) => request('PATCH', path, token, body);
  const del = (path: string, token: string | undefined) => request('DELETE', path, token);

  before(async () => {
    await ensureReferenceData(pool!, TODAY);
    await pool!.query("DELETE FROM gl_journals WHERE source_id = 'sm-si-1' OR memo LIKE 'SM TEST%'");
    await pool!.query("DELETE FROM sales_invoices WHERE id = 'sm-si-1'");
    await pool!.query("DELETE FROM customer_records WHERE id = 'sm-customer'");
    await pool!.query("DELETE FROM sales_agents WHERE code LIKE 'SM-AG-%'");
    await pool!.query("DELETE FROM areas WHERE code LIKE 'SM-AR-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id = 'sm-product'");
    await pool!.query("DELETE FROM products WHERE id = 'sm-product'");
    await pool!.query("DELETE FROM branches WHERE id = $1", [BR]);
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%SM TEST%' OR details LIKE '%SM-AR-%' OR details LIKE '%SM-AG-%'");

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'SMB', 'SM Sales Branch', 'Test')`,
      [BR]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ('sm-product', 'SM Router', 'SM-SKU', 'Equipment', 'Product Item', 'Pcs', 80, 100, FALSE, 'QUANTITY_ONLY')`
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ('sm-stock', 'sm-product', $1, 10, 80, 1)`,
      [BR]
    );

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
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
    setPermissionMatrix({});
    if (pool) {
      await pool.query("DELETE FROM gl_journals WHERE source_id = 'sm-si-1' OR memo LIKE 'SM TEST%'");
      await pool.query("DELETE FROM sales_invoices WHERE id = 'sm-si-1'");
      await pool.query("DELETE FROM customer_records WHERE id = 'sm-customer'");
      await pool.query("DELETE FROM sales_agents WHERE code LIKE 'SM-AG-%'");
      await pool.query("DELETE FROM areas WHERE code LIKE 'SM-AR-%'");
      await pool.query("DELETE FROM inventory_stock WHERE product_id = 'sm-product'");
      await pool.query("DELETE FROM products WHERE id = 'sm-product'");
      await pool.query("DELETE FROM branches WHERE id = $1", [BR]);
      await pool.query("DELETE FROM audit_logs WHERE details LIKE '%SM TEST%' OR details LIKE '%SM-AR-%' OR details LIKE '%SM-AG-%'");
      await pool.end();
    }
  });

  test('areas and agents create, edit, list and reject unauthorized writes', async () => {
    const area = await post('/api/sales/areas', tokens.super, {
      code: 'SM-AR-KTM', name: 'SM Kathmandu', branchId: BR, active: true,
    });
    assert.equal(area.status, 201, JSON.stringify(area.json));
    areaId = area.json.id;

    const agent = await post('/api/sales/agents', tokens.super, {
      code: 'SM-AG-01', name: 'SM Agent One', phone: '9800000001', areaId, commissionRate: 2.5, active: true,
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.json));
    agentId = agent.json.id;
    assert.equal(agent.json.areaName, 'SM Kathmandu');
    assert.equal(Number(agent.json.commissionRate), 2.5);

    const edited = await patch('/api/sales/agents/' + agentId, tokens.super, { commissionRate: 3.25 });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(Number(edited.json.commissionRate), 3.25);

    const listedAreas = await get('/api/sales/areas', tokens.super);
    assert.equal(listedAreas.status, 200);
    assert.ok(listedAreas.json.some((row: any) => row.code === 'SM-AR-KTM'));

    // AUDITOR has no customers-manage permission: reads and writes are both refused.
    assert.equal((await get('/api/sales/areas', tokens.auditor)).status, 403);
    assert.equal((await post('/api/sales/agents', tokens.auditor, { code: 'SM-AG-NO', name: 'Nope' })).status, 403);
  });

  test('customer defaults carry area/agent and a sales invoice snapshots both names', async () => {
    const customer = await post('/api/customers', tokens.super, {
      id: 'sm-customer',
      customerId: 'SM-CUST',
      customerName: 'SM Customer',
      username: 'sm.customer',
      contactNumber: '9800000002',
      branchId: BR,
      areaId,
      agentId,
      status: 'ACTIVE',
    });
    assert.equal(customer.status, 201, JSON.stringify(customer.json));
    assert.equal(customer.json.areaId, areaId);
    assert.equal(customer.json.agentId, agentId);

    const badArea = await post('/api/customers', tokens.super, {
      id: 'sm-customer-bad', customerId: 'SM-CUST-BAD', customerName: 'SM Bad', branchId: BR, areaId: 'no-such-area',
    });
    assert.equal(badArea.status, 400, 'an unknown area id must be a 400, not an FK error');
    assert.match(String(badArea.json.message), /sales area/);

    const badAgent = await request('PUT', '/api/customers/sm-customer', tokens.super, { agentId: 'no-such-agent' });
    assert.equal(badAgent.status, 400, 'an unknown agent id must be a 400 on update too');
    assert.match(String(badAgent.json.message), /sales agent/);

    const invoice = await post('/api/sales-invoices', tokens.super, {
      id: 'sm-si-1',
      invoiceNumber: 'SM-SI-1',
      customerId: 'sm-customer',
      customerName: 'SM Customer',
      branchId: BR,
      invoiceDateAD: TODAY,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      areaId,
      agentId,
      items: [{ productId: 'sm-product', productName: 'SM Router', sku: 'SM-SKU', unit: 'Pcs', quantity: 1, unitPrice: 100, discount: 0, taxRate: 13, isTaxExempt: false }],
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.json));
    assert.equal(invoice.json.areaId, areaId);
    assert.equal(invoice.json.areaName, 'SM Kathmandu');
    assert.equal(invoice.json.agentId, agentId);
    assert.equal(invoice.json.agentName, 'SM Agent One');

    const stored = await pool!.query(
      'SELECT area_id, area_name, agent_id, agent_name FROM sales_invoices WHERE id = $1',
      ['sm-si-1']
    );
    assert.deepEqual(stored.rows[0], {
      area_id: areaId, area_name: 'SM Kathmandu', agent_id: agentId, agent_name: 'SM Agent One',
    });

    const used = await del('/api/sales/areas/' + areaId, tokens.super);
    assert.equal(used.status, 409, 'a customer/invoice reference must block area deletion');
  });
});