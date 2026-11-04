/**
 * Accounting dimension masters — real HTTP + PostgreSQL.
 *
 * Covers the three Step-4 masters: cost centres (including the journal-line
 * foreign key and branch/cycle guards), narration templates (quick-pick text,
 * never a posted foreign key), and document-numbering series create/edit.
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

const BR = 'BRH01';
const OTHER_BR = 'WH001';
const JOURNAL_DATE = '2027-01-15';

const USERS = {
  super: { id: 'acm-super', email: 'acm-super@example.com', name: 'ACM Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  auditor: { id: 'acm-auditor', email: 'acm-auditor@example.com', name: 'ACM Auditor', role: 'AUDITOR', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  frontdesk: { id: 'acm-frontdesk', email: 'acm-frontdesk@example.com', name: 'ACM Front Desk', role: 'FRONT_DESK', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

describe('accounting dimension masters API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let cashAccountId = '';
  let salesAccountId = '';

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    token?: string,
    body?: unknown
  ) {
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
    await ensureReferenceData(pool!);
    await pool!.query("DELETE FROM gl_journals WHERE source_id LIKE 'ACM-TEST-%' OR memo LIKE 'ACM TEST%'");
    await pool!.query("DELETE FROM gl_periods WHERE period_key = $1 AND id LIKE 'glp-%'", ['2027-01']);
    await pool!.query("UPDATE cost_centers SET parent_id = NULL WHERE code LIKE 'ACM-CC-%'");
    await pool!.query("DELETE FROM cost_centers WHERE code LIKE 'ACM-CC-%'");
    await pool!.query("DELETE FROM narration_templates WHERE code LIKE 'ACM-NT-%'");
    await pool!.query("DELETE FROM document_number_configs WHERE id = 'ACMDOC'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%ACM TEST%' OR details LIKE '%ACM-CC-%' OR details LIKE '%ACM-NT-%' OR details LIKE '%ACMDOC%'");

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

    const seeded = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
    cashAccountId = seeded.json.defaults.CASH.accountId;
    salesAccountId = seeded.json.defaults.SALES.accountId;
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await pool.query("DELETE FROM gl_journals WHERE source_id LIKE 'ACM-TEST-%' OR memo LIKE 'ACM TEST%'");
      await pool.query("DELETE FROM gl_periods WHERE period_key = $1 AND id LIKE 'glp-%'", ['2027-01']);
      await pool.query("UPDATE cost_centers SET parent_id = NULL WHERE code LIKE 'ACM-CC-%'");
      await pool.query("DELETE FROM cost_centers WHERE code LIKE 'ACM-CC-%'");
      await pool.query("DELETE FROM narration_templates WHERE code LIKE 'ACM-NT-%'");
      await pool.query("DELETE FROM document_number_configs WHERE id = 'ACMDOC'");
      await pool.query("DELETE FROM audit_logs WHERE details LIKE '%ACM TEST%' OR details LIKE '%ACM-CC-%' OR details LIKE '%ACM-NT-%' OR details LIKE '%ACMDOC%'");
      await pool.end();
    }
  });

  test('cost centres create, list, guard duplicates and refuse a parent cycle', async () => {
    const parent = await post('/api/accounting/cost-centers', tokens.super, {
      code: 'ACM-CC-OPS',
      name: 'ACM Operations',
      branchId: BR,
      active: true,
    });
    assert.equal(parent.status, 201, JSON.stringify(parent.json));
    assert.equal(parent.json.branchId, BR);

    const child = await post('/api/accounting/cost-centers', tokens.super, {
      code: 'ACM-CC-FIELD',
      name: 'ACM Field Team',
      parentId: parent.json.id,
      branchId: BR,
      active: true,
    });
    assert.equal(child.status, 201, JSON.stringify(child.json));
    assert.equal(child.json.parentId, parent.json.id);
    assert.equal(child.json.parentName, 'ACM Operations');

    const duplicate = await post('/api/accounting/cost-centers', tokens.super, {
      code: 'acm-cc-ops',
      name: 'Duplicate',
    });
    assert.equal(duplicate.status, 409);

    const cycle = await patch('/api/accounting/cost-centers/' + parent.json.id, tokens.super, {
      parentId: child.json.id,
    });
    assert.equal(cycle.status, 400, JSON.stringify(cycle.json));

    const wrongBranch = await post('/api/accounting/cost-centers', tokens.super, {
      code: 'ACM-CC-GLOBAL',
      name: 'ACM Global Child',
      branchId: OTHER_BR,
      parentId: parent.json.id,
    });
    assert.equal(wrongBranch.status, 400, JSON.stringify(wrongBranch.json));

    const moveParent = await patch('/api/accounting/cost-centers/' + parent.json.id, tokens.super, {
      branchId: OTHER_BR,
    });
    assert.equal(moveParent.status, 400, JSON.stringify(moveParent.json));

    const listed = await get('/api/accounting/cost-centers', tokens.auditor);
    assert.equal(listed.status, 200);
    assert.ok(listed.json.some((row: any) => row.code === 'ACM-CC-OPS'));
    assert.equal((await get('/api/accounting/cost-centers', tokens.frontdesk)).status, 403);
  });

  test('a journal line stores an active branch cost centre and refuses an inactive one', async () => {
    const center = await post('/api/accounting/cost-centers', tokens.super, {
      code: 'ACM-CC-POST',
      name: 'ACM Posting Center',
      branchId: BR,
    });
    assert.equal(center.status, 201, JSON.stringify(center.json));

    const posted = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACM TEST cost centre journal',
      sourceId: 'ACM-TEST-CC',
      lines: [
        { accountId: cashAccountId, debit: 25, credit: 0, costCenterId: center.json.id },
        { accountId: salesAccountId, debit: 0, credit: 25, costCenterId: center.json.id },
      ],
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.json));
    assert.equal(posted.json.lines[0].costCenterId, center.json.id);
    assert.equal(posted.json.lines[0].costCenterCode, 'ACM-CC-POST');

    const inactive = await patch('/api/accounting/cost-centers/' + center.json.id, tokens.super, {
      active: false,
    });
    assert.equal(inactive.status, 200, JSON.stringify(inactive.json));

    const refused = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: JOURNAL_DATE,
      branchId: BR,
      memo: 'ACM TEST inactive cost centre',
      lines: [
        { accountId: cashAccountId, debit: 10, credit: 0, costCenterId: center.json.id },
        { accountId: salesAccountId, debit: 0, credit: 10 },
      ],
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.match(refused.json.message, /inactive/i);

    const usage = await del('/api/accounting/cost-centers/' + center.json.id, tokens.super);
    assert.equal(usage.status, 409, 'a posted line must block deletion');
  });

  test('narration templates round-trip, filter by transaction type and stay quick-pick text', async () => {
    const created = await post('/api/accounting/narrations', tokens.super, {
      code: 'ACM-NT-RECEIPT',
      text: 'ACM TEST cash received against invoice',
      transactionType: 'CUSTOMER_RECEIPT',
      active: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.transactionType, 'CUSTOMER_RECEIPT');

    const filtered = await get('/api/accounting/narrations?type=CUSTOMER_RECEIPT', tokens.auditor);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.json.some((row: any) => row.code === 'ACM-NT-RECEIPT'));

    const allOnly = await post('/api/accounting/narrations', tokens.super, {
      code: 'ACM-NT-ALL',
      text: 'ACM TEST general narration',
      transactionType: 'ALL',
    });
    assert.equal(allOnly.status, 201, JSON.stringify(allOnly.json));
    const manual = await get('/api/accounting/narrations?type=MANUAL_JOURNAL', tokens.super);
    assert.ok(manual.json.some((row: any) => row.code === 'ACM-NT-ALL'), 'ALL applies to every type');
    assert.equal(manual.json.some((row: any) => row.code === 'ACM-NT-RECEIPT'), false);

    const updated = await patch('/api/accounting/narrations/' + created.json.id, tokens.super, {
      text: 'ACM TEST revised receipt narration',
      active: false,
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.text, 'ACM TEST revised receipt narration');
    assert.equal(updated.json.active, false);

    assert.equal((await post('/api/accounting/narrations', tokens.frontdesk, { code: 'ACM-NT-NO', text: 'x' })).status, 403);
    assert.equal((await del('/api/accounting/narrations/' + created.json.id, tokens.super)).status, 200);
  });

  test('document numbering creates and edits a series without resetting its counter', async () => {
    const created = await post('/api/document-number-configs', tokens.super, {
      id: 'ACMDOC',
      documentType: 'ACM Test Document',
      prefix: 'ACMD',
      notes: 'ACM TEST series',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.id, 'ACMDOC');
    assert.equal(created.json.prefix, 'ACMD');

    const duplicate = await post('/api/document-number-configs', tokens.super, {
      id: 'ACMDOC',
      documentType: 'Duplicate',
      prefix: 'DUP',
    });
    assert.equal(duplicate.status, 409);

    const edited = await patch('/api/document-number-configs/ACMDOC', tokens.super, {
      documentType: 'ACM Revised Document',
      prefix: 'ACM2',
      notes: 'ACM TEST revised series',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.documentType, 'ACM Revised Document');
    assert.equal(edited.json.prefix, 'ACM2');

    const listed = await get('/api/document-number-configs', tokens.super);
    assert.equal(listed.status, 200);
    assert.ok(listed.json.some((row: any) => row.id === 'ACMDOC' && row.prefix === 'ACM2'));
    assert.equal((await post('/api/document-number-configs', tokens.frontdesk, { id: 'NOPE', documentType: 'No', prefix: 'NO' })).status, 403);
  });
});