/**
 * Warranty claims / RMA lifecycle — real HTTP + PostgreSQL.
 *
 * Proves the parts a scaffold cannot: the unique open-unit rule, the shared
 * state machine, RMA/replacement/repair stock movements, the vendor-credit
 * journal and its reconciliation, branch custody and permission gates.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase, type ThrowawayDatabase } from './fixtures/throwawayDatabase';
import { warrantyClaimSlaDays } from '../shared/warrantyClaim';
import { warrantyRmaAgeDays, warrantyRmaAgingBucket } from '../shared/warrantyRecovery';

dotenv.config();

const TEST_DB = 'inventory_warranty_claims_test';
const BR_A = 'WCA';
const BR_B = 'WCB';
const TODAY = '2026-11-02';

let dbReachable = false;
if (process.env.DATABASE_URL) {
  const probe = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    dbReachable = true;
  } catch {
    dbReachable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const USERS = {
  super: { id: 'wc-super', email: 'wc-super@example.com', name: 'WC Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  branchA: { id: 'wc-a', email: 'wc-a@example.com', name: 'WC Branch A', role: 'INVENTORY_MANAGER', branchId: BR_A, allowedBranchIds: [BR_A], canSwitchUser: false },
  frontdesk: { id: 'wc-fd', email: 'wc-fd@example.com', name: 'WC Front Desk', role: 'FRONT_DESK', branchId: BR_A, allowedBranchIds: [BR_A], canSwitchUser: false },
  empty: { id: 'wc-empty', email: 'wc-empty@example.com', name: 'WC Empty', role: 'AUDITOR', branchId: '', allowedBranchIds: [], canSwitchUser: false },
} as const;

describe('warranty claims / RMA lifecycle (real HTTP + throwaway PostgreSQL)', { skip: skipNoDb }, () => {
  let throwaway: ThrowawayDatabase | null = null;
  let port = 0;
  let closeServer: (() => Promise<void>) | null = null;
  let tokens = {} as Record<keyof typeof USERS, string>;
  let claimAId = '';
  let claimBId = '';
  let replacementClaimId = '';
  let repairClaimId = '';
  let creditClaimId = '';

  async function request(method: 'GET' | 'POST' | 'PATCH', path: string, token?: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  const get = (path: string, token?: string) => request('GET', path, token);
  const post = (path: string, token: string | undefined, body: unknown) => request('POST', path, token, body);
  const patch = (path: string, token: string | undefined, body: unknown) => request('PATCH', path, token, body);

  async function transition(id: string, status: string, extra: Record<string, unknown> = {}) {
    return patch(`/api/warranty-claims/${id}/status`, tokens.branchA, {
      status,
      dateAD: TODAY,
      ...extra,
    });
  }

  async function createClaim(serialNumber: string, token = tokens.branchA, extra: Record<string, unknown> = {}) {
    return post('/api/warranty-claims', token, {
      coverageType: 'SELLER',
      serialNumber,
      reportedDateAD: TODAY,
      symptom: 'No link light after a power cycle',
      vendorName: 'Acme Recovery Vendor',
      expectedCredit: 800,
      ...extra,
    });
  }

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) return;
    throwaway = await createThrowawayDatabase(base, TEST_DB);
    process.env.DATABASE_URL = throwaway.url;
    const { createApp, registerAllRoutes } = await import('../server/src/app');
    const { realPoolInstance, ensurePostgresConnection } = await import('../server/db');
    realPoolInstance?.on?.('error', () => undefined);
    assert.equal(await ensurePostgresConnection(), true, 'the throwaway database must be reachable');

    const { ensureReferenceData } = await import('./fixtures/referenceData');
    const { issueAuthToken } = await import('../server/src/middleware/auth');
    const { setPermissionMatrix } = await import('../server/src/state/runtimeState');
    const { DEFAULT_PERMISSIONS_MATRIX } = await import('../client/src/utils/permissionMatrixData');

    await ensureReferenceData(throwaway.pool, TODAY);
    for (const branchId of [BR_A, BR_B]) {
      await throwaway.pool.query(
        `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
         VALUES ($1, $1, $1, 'Test', TRUE, TRUE, TRUE, FALSE)`,
        [branchId]
      );
    }

    await throwaway.pool.query(
      `INSERT INTO products
         (id, sku, name, category, product_group, unit, cost_price, selling_price,
          requires_serial_tracking, tracking_type, vendor_warranty_months, seller_warranty_months)
       VALUES ('wc-prod', 'WC-PROD', 'WC Router', 'CPE', 'Product Item', 'Pcs', 100, 150, TRUE, 'SERIAL_ONLY', 12, 12)`
    );
    await throwaway.pool.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost)
       VALUES ('wc-stock-a', 'wc-prod', $1, 3, 100), ('wc-stock-b', 'wc-prod', $2, 1, 100)`,
      [BR_A, BR_B]
    );

    const serials: Array<[string, string, string, string]> = [
      ['wc-serial-a', 'WCS-A', BR_A, 'CUSTOMER_ASSIGNED'],
      ['wc-serial-b', 'WCS-B', BR_B, 'CUSTOMER_ASSIGNED'],
      ['wc-replacement', 'WCR-A', BR_A, 'IN_STOCK'],
      ['wc-repair-unit', 'WCS-REPAIR', BR_A, 'CUSTOMER_ASSIGNED'],
      ['wc-credit-unit', 'WCS-CREDIT', BR_A, 'CUSTOMER_ASSIGNED'],
      ['wc-replace-unit', 'WCS-REPLACE', BR_A, 'CUSTOMER_ASSIGNED'],
    ];
    for (const [id, serial, branchId, status] of serials) {
      await throwaway.pool.query(
        `INSERT INTO serial_log
           (id, device_serial, product_id, product_name, branch_id, customer_id, customer_name, status, source_type)
         VALUES ($1, $2, 'wc-prod', 'WC Router', $3, $4, $5, $6, 'PURCHASE')`,
        [id, serial, branchId, status === 'CUSTOMER_ASSIGNED' ? `cust-${id}` : null, status === 'CUSTOMER_ASSIGNED' ? `Customer ${serial}` : null, status]
      );
    }

    const coverages: Array<[string, string, string, string]> = [
      ['wc-cov-a', 'WCS-A', BR_A, 'Customer A'],
      ['wc-cov-b', 'WCS-B', BR_B, 'Customer B'],
      ['wc-cov-repl', 'WCS-REPAIR', BR_A, 'Customer Repair'],
      ['wc-cov-credit', 'WCS-CREDIT', BR_A, 'Customer Credit'],
    ];
    for (const [id, serial, branchId, customer] of coverages) {
      await throwaway.pool.query(
        `INSERT INTO warranty_coverages
           (id, coverage_type, item_category, product_id, product_name, serial_number, branch_id,
            party_id, party_name, source_type, source_id, start_date_ad, start_date_bs,
            end_date_ad, end_date_bs, term_months, start_basis, is_current)
         VALUES ($1, 'SELLER', 'CPE', 'wc-prod', 'WC Router', $2, $3,
            $4, $5, 'SALES_INVOICE', $6, '2026-01-01', 'BS not seeded',
            '2027-01-01', 'BS not seeded', 12, 'MANUAL', TRUE)`,
        [id, serial, branchId, `cust-${serial}`, customer, id]
      );
    }

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    tokens = Object.fromEntries(
      Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
    ) as Record<keyof typeof USERS, string>;

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    closeServer = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    const a = await createClaim('WCS-A');
    assert.equal(a.status, 201, JSON.stringify(a.json));
    claimAId = a.json.id;
    const b = await createClaim('WCS-B', tokens.super);
    assert.equal(b.status, 201, JSON.stringify(b.json));
    claimBId = b.json.id;

    for (const [serial, field] of [['WCS-REPLACE', 'replacementClaimId'], ['WCS-REPAIR', 'repairClaimId'], ['WCS-CREDIT', 'creditClaimId']] as const) {
      if (serial === 'WCS-REPLACE') {
        // The replacement path starts from the same reported unit as the main
        // claim; use a second coverage/serial so the two flows stay independent.
        await throwaway.pool.query(
          `INSERT INTO warranty_coverages
             (id, coverage_type, item_category, product_id, product_name, serial_number, branch_id,
              party_id, party_name, source_type, source_id, start_date_ad, start_date_bs,
              end_date_ad, end_date_bs, term_months, start_basis, is_current)
           VALUES ('wc-cov-replace', 'SELLER', 'CPE', 'wc-prod', 'WC Router', 'WCS-REPLACE', $1,
              'cust-WCS-REPLACE', 'Customer WCS-REPLACE', 'SALES_INVOICE', 'wc-cov-replace',
              '2026-01-01', 'BS not seeded', '2027-01-01', 'BS not seeded', 12, 'MANUAL', TRUE)`,
          [BR_A]
        );
      }
      const created = await createClaim(serial);
      assert.equal(created.status, 201, JSON.stringify(created.json));
      if (field === 'replacementClaimId') replacementClaimId = created.json.id;
      if (field === 'repairClaimId') repairClaimId = created.json.id;
      if (field === 'creditClaimId') creditClaimId = created.json.id;
    }
  });

  after(async () => {
    if (closeServer) await closeServer();
    try {
      const db = await import('../server/db');
      if (db.realPoolInstance) await db.realPoolInstance.end();
    } catch {
      /* best effort — the drop below forces the issue if this fails */
    }
    if (throwaway) {
      await throwaway.pool.end().catch(() => undefined);
      await dropThrowawayDatabase(throwaway.adminPool, TEST_DB);
    }
  });

  test('one serial cannot have two open claims and every event is recorded', async () => {
    const duplicate = await createClaim('WCS-A');
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /already has an open/i);

    const noCoverage = await createClaim('WCS-NOT-COVERED');
    assert.equal(noCoverage.status, 404, JSON.stringify(noCoverage.json));
    assert.match(noCoverage.json.message, /coverage/i);

    const detail = await get(`/api/warranty-claims/${claimAId}`, tokens.branchA);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal(detail.json.status, 'REPORTED');
    assert.equal(detail.json.open, true);
    assert.equal(detail.json.slaDays, warrantyClaimSlaDays(TODAY));
    assert.equal(detail.json.events.length, 1);
    assert.equal(detail.json.events[0].status, 'REPORTED');

    const invalid = await transition(claimAId, 'REPLACED', { replacementSerial: 'WCR-A' });
    assert.equal(invalid.status, 409, JSON.stringify(invalid.json));
    const closeUnresolved = await transition(claimAId, 'CLOSED');
    assert.equal(closeUnresolved.status, 409, JSON.stringify(closeUnresolved.json));
    assert.match(closeUnresolved.json.message, /cannot move to CLOSED/i);
  });

  test('replacement moves exactly one unit and the old serial to the RMA bucket once', async () => {
    assert.equal((await transition(claimAId, 'APPROVED', { note: 'Bench confirmed a dead port' })).status, 200);
    assert.equal((await transition(claimAId, 'SENT_TO_VENDOR', { rmaReference: 'RMA-42' })).status, 200);
    const rmaSerial = await throwaway!.pool.query("SELECT status FROM serial_log WHERE device_serial = 'WCS-A'");
    assert.equal(rmaSerial.rows[0].status, 'RETURNED_TO_VENDOR');

    assert.equal((await transition(replacementClaimId, 'APPROVED')).status, 200);
    assert.equal((await transition(replacementClaimId, 'SENT_TO_VENDOR', { rmaReference: 'RMA-99' })).status, 200);
    const before = await throwaway!.pool.query("SELECT quantity_on_hand::int AS qty FROM inventory_stock WHERE id = 'wc-stock-a'");
    const replaced = await patch(`/api/warranty-claims/${replacementClaimId}/status`, tokens.branchA, {
      status: 'REPLACED',
      dateAD: '2026-11-03',
      replacementSerial: 'WCR-A',
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    assert.equal(replaced.json.status, 'REPLACED');
    assert.equal(replaced.json.resolution, 'REPLACED');
    assert.equal(replaced.json.replacementSerial, 'WCR-A');

    const after = await throwaway!.pool.query("SELECT quantity_on_hand::int AS qty FROM inventory_stock WHERE id = 'wc-stock-a'");
    assert.equal(after.rows[0].qty, before.rows[0].qty - 1);
    const replacement = await throwaway!.pool.query("SELECT status, customer_name FROM serial_log WHERE device_serial = 'WCR-A'");
    assert.equal(replacement.rows[0].status, 'CUSTOMER_ASSIGNED');
    assert.equal(replacement.rows[0].customer_name, 'Customer WCS-REPLACE');
    const ledger = await throwaway!.pool.query(
      "SELECT quantity_changed::int AS qty, reference_doc_id FROM transaction_logs WHERE id = $1",
      [`txn-warranty-replace-${replacementClaimId}`]
    );
    assert.equal(ledger.rows[0].qty, -1);

    const close = await transition(replacementClaimId, 'CLOSED');
    assert.equal(close.status, 200, JSON.stringify(close.json));
    assert.equal(close.json.status, 'CLOSED');
    assert.equal(close.json.closedDateAD, TODAY);
  });

  test('repair returns one unit to stock and credit posts a reconciled vendor journal', async () => {
    await transition(repairClaimId, 'APPROVED');
    await transition(repairClaimId, 'SENT_TO_VENDOR');
    const repairBefore = await throwaway!.pool.query("SELECT quantity_on_hand::int AS qty FROM inventory_stock WHERE id = 'wc-stock-a'");
    const repaired = await transition(repairClaimId, 'REPAIRED', { note: 'Port replaced by vendor' });
    assert.equal(repaired.status, 200, JSON.stringify(repaired.json));
    assert.equal(repaired.json.status, 'REPAIRED');
    const repairAfter = await throwaway!.pool.query("SELECT quantity_on_hand::int AS qty FROM inventory_stock WHERE id = 'wc-stock-a'");
    assert.equal(repairAfter.rows[0].qty, repairBefore.rows[0].qty + 1);
    const repairedSerial = await throwaway!.pool.query("SELECT status FROM serial_log WHERE device_serial = 'WCS-REPAIR'");
    assert.equal(repairedSerial.rows[0].status, 'IN_STOCK');
    const repairLedger = await throwaway!.pool.query(
      "SELECT quantity_changed::int AS qty FROM transaction_logs WHERE id = $1",
      [`txn-warranty-repair-${repairClaimId}`]
    );
    assert.equal(repairLedger.rows[0].qty, 1);

    await transition(creditClaimId, 'APPROVED');
    await transition(creditClaimId, 'SENT_TO_VENDOR');
    const credited = await transition(creditClaimId, 'CREDITED', {
      receivedCredit: 500,
      creditNoteNo: 'CN-42',
      postCreditJournal: true,
    });
    assert.equal(credited.status, 200, JSON.stringify(credited.json));
    assert.equal(credited.json.status, 'CREDITED');
    assert.equal(credited.json.receivedCredit, 500);
    assert.ok(credited.json.vendorCredit, 'the posted journal must be returned');
    assert.equal(credited.json.vendorCredit.amount, 500);
    assert.equal(credited.json.vendorCredit.reconciled, true);
    assert.match(credited.json.vendorCredit.journalNo, /^MJ-/);

    const journal = await throwaway!.pool.query(
      "SELECT id, source_type, source_id FROM gl_journals WHERE source_type = 'WARRANTY_RECOVERY' AND source_id = $1",
      [creditClaimId]
    );
    assert.equal(journal.rowCount, 1);
    const lines = await throwaway!.pool.query(
      "SELECT COALESCE(SUM(debit),0)::float8 AS debit, COALESCE(SUM(credit),0)::float8 AS credit FROM gl_journal_lines WHERE journal_id = $1",
      [journal.rows[0].id]
    );
    assert.equal(lines.rows[0].debit, 500);
    assert.equal(lines.rows[0].credit, 500);
  });

  test('recovery queue reconciles vendor credit, RMA aging, paging and scope', async () => {
    const full = await get(
      `/api/warranty-claims/recovery?branchId=${BR_A}&coverageType=SELLER&pageSize=10`,
      tokens.branchA
    );
    assert.equal(full.status, 200, JSON.stringify(full.json));
    assert.equal(full.json.totalItems, 4);
    assert.equal(full.json.summary.claims, 4);
    assert.equal(full.json.summary.openClaims, 3);
    assert.equal(full.json.summary.outstandingRmas, 1);
    assert.equal(full.json.summary.expectedCredit, 3200);
    assert.equal(full.json.summary.receivedCredit, 500);
    assert.equal(full.json.summary.postedCredit, 500);
    assert.equal(full.json.summary.shortfall, 2700);
    assert.equal(full.json.summary.shortfallClaims, 4);
    assert.equal(full.json.summary.postingExceptions, 0);
    assert.equal(full.json.summary.reconciled, false);

    const creditRow = full.json.data.find((row: any) => row.id === creditClaimId);
    assert.equal(creditRow?.receivedCredit, 500);
    assert.equal(creditRow?.postedCredit, 500);
    assert.equal(creditRow?.shortfall, 300);
    assert.equal(creditRow?.creditState, 'PARTIAL');
    assert.equal(creditRow?.rmaAgeDays, null, 'resolved claims are not outstanding RMAs');

    const rmaRow = full.json.data.find((row: any) => row.id === claimAId);
    assert.equal(rmaRow?.creditState, 'PENDING');
    assert.equal(rmaRow?.rmaAgeDays, warrantyRmaAgeDays(TODAY));
    assert.equal(rmaRow?.agingBucket, warrantyRmaAgingBucket(warrantyRmaAgeDays(TODAY)));

    const agedBucket = full.json.aging.find(
      (bucket: any) => bucket.bucket === warrantyRmaAgingBucket(warrantyRmaAgeDays(TODAY))
    );
    assert.equal(agedBucket?.claims, 1);
    assert.equal(full.json.vendors[0]?.vendorName, 'Acme Recovery Vendor');
    assert.equal(full.json.vendors[0]?.claims, 4);
    assert.equal(full.json.vendors[0]?.shortfall, 2700);

    const paged = await get(
      `/api/warranty-claims/recovery?branchId=${BR_A}&coverageType=SELLER&page=1&pageSize=2`,
      tokens.branchA
    );
    assert.equal(paged.status, 200, JSON.stringify(paged.json));
    assert.equal(paged.json.data.length, 2);
    assert.equal(paged.json.totalItems, 4);

    const shortfallOnly = await get(
      `/api/warranty-claims/recovery?branchId=${BR_A}&coverageType=SELLER&onlyShortfall=1`,
      tokens.branchA
    );
    assert.equal(shortfallOnly.status, 200, JSON.stringify(shortfallOnly.json));
    assert.equal(shortfallOnly.json.totalItems, 4);

    const outstandingOnly = await get(
      `/api/warranty-claims/recovery?branchId=${BR_A}&coverageType=SELLER&outstandingRma=1`,
      tokens.branchA
    );
    assert.equal(outstandingOnly.status, 200, JSON.stringify(outstandingOnly.json));
    assert.equal(outstandingOnly.json.totalItems, 1);

    const forged = await get(`/api/warranty-claims/recovery?branchId=${BR_B}`, tokens.branchA);
    assert.equal(forged.status, 403, JSON.stringify(forged.json));
    const global = await get(`/api/warranty-claims/recovery?branchId=${BR_B}`, tokens.super);
    assert.equal(global.status, 200, JSON.stringify(global.json));
    assert.equal(global.json.totalItems, 1);
    assert.equal((await get('/api/warranty-claims/recovery')).status, 401);
    assert.equal((await get('/api/warranty-claims/recovery', tokens.frontdesk)).status, 200);
  });

  test('branch scope, permissions and status filters hold', async () => {
    const listA = await get(`/api/warranty-claims?branchId=${BR_A}&coverageType=SELLER`, tokens.branchA);
    assert.equal(listA.status, 200, JSON.stringify(listA.json));
    assert.ok(listA.json.data.every((row: any) => row.branchId === BR_A));
    assert.ok(!listA.json.data.some((row: any) => row.id === claimBId));
    assert.equal(listA.json.counts.total, 4);

    const openOnly = await get(`/api/warranty-claims?branchId=${BR_A}&open=1`, tokens.branchA);
    assert.equal(openOnly.status, 200, JSON.stringify(openOnly.json));
    assert.ok(openOnly.json.data.every((row: any) => row.open));

    const forged = await get(`/api/warranty-claims?branchId=${BR_B}`, tokens.branchA);
    assert.equal(forged.status, 403, JSON.stringify(forged.json));
    const global = await get(`/api/warranty-claims?branchId=${BR_B}`, tokens.super);
    assert.equal(global.status, 200, JSON.stringify(global.json));
    assert.ok(global.json.data.some((row: any) => row.id === claimBId));

    const foreignCreate = await createClaim('WCS-B', tokens.branchA, { coverageType: 'SELLER' });
    // WCS-B has an open claim already; either the branch refusal or the open
    // claim rule is a valid refusal, but it must not create a row.
    assert.ok([403, 409].includes(foreignCreate.status), JSON.stringify(foreignCreate.json));

    assert.equal((await get('/api/warranty-claims')).status, 401);
    assert.equal((await post('/api/warranty-claims', undefined, {})).status, 401);
    assert.equal((await get('/api/warranty-claims', tokens.frontdesk)).status, 200);
    assert.equal((await createClaim('WCS-A', tokens.frontdesk)).status, 403);
    const empty = await get('/api/warranty-claims', tokens.empty);
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.deepEqual(empty.json.data, []);
    assert.equal((await get(`/api/warranty-claims/${claimAId}`, tokens.frontdesk)).status, 200);
  });
});
