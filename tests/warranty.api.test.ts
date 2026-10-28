/**
 * WTY-2 warranty coverage API — live HTTP against real PostgreSQL.
 *
 * The register is the screen's only source of truth, so these tests drive the
 * real Express app (createApp + registerAllRoutes) and the real coverage table
 * rather than calling the controller functions directly. They exist because a
 * scaffold can look right and still be wrong in four specific ways:
 *
 *   1. SCOPE — a branch account must not read another branch's coverages. The
 *      query string is attacker-controlled, so both the app-level branch guard
 *      and the controller's own scope resolution are exercised (forged
 *      `branchId`, `ALL`, and an account whose scope is empty).
 *   2. PERMISSION — `warranty-view` on both reads, `warranty-edit` on the
 *      correction. A role that holds neither must be refused at the route, and
 *      one that holds view-only must still be refused the write.
 *   3. SUPERSEDE — a correction is a new period, not an overwrite: the replaced
 *      row keeps its dates and stops being current, so the old period stays
 *      auditable. An in-place UPDATE would pass a "the date changed" assertion
 *      and fail this one.
 *   4. AUDIT — the correction and its audit row commit together, and the audit
 *      names the unit plus old → new dates.
 *
 * The mirror (PostgreSQL down) is compared with the SQL path on one fixture so
 * the demo mode cannot quietly answer a different page.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix, setWarrantyCoverages } from '../server/src/state/runtimeState';
import { buildWarrantyMirrorPage } from '../server/src/controllers/warranty.controller';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { ensureReferenceData } from './fixtures/referenceData';
import type { WarrantyCoverageRecord } from '../client/src/types';

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

const WH = 'WH001';
const BR = 'BRH01';

/** AD date `offset` days from today, UTC — the register compares in UTC. */
function dayOffset(offset: number): string {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

const today = dayOffset(0);

/** pg returns DATE as 'YYYY-MM-DD'; tolerate a Date if a parser is ever added. */
const adOf = (value: any): string =>
  typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);

interface Fixture {
  id: string;
  coverageType: 'VENDOR' | 'SELLER';
  serialNumber: string;
  branchId: string;
  startOffset: number;
  endOffset: number;
  isCurrent?: boolean;
}

const FIXTURES: Fixture[] = [
  // VENDOR, warehouse: the one a branch account must never see.
  { id: 'wrt-cov-v-wh', coverageType: 'VENDOR', serialNumber: 'WRT-V-WH', branchId: WH, startOffset: -400, endOffset: 400 },
  // VENDOR, branch: expiring and expired, for the status filter + counts.
  { id: 'wrt-cov-v-exp', coverageType: 'VENDOR', serialNumber: 'WRT-V-EXP', branchId: BR, startOffset: -100, endOffset: 10 },
  { id: 'wrt-cov-v-expd', coverageType: 'VENDOR', serialNumber: 'WRT-V-EXPD', branchId: BR, startOffset: -400, endOffset: -10 },
  // VENDOR history: a superseded row must never appear in the register.
  { id: 'wrt-cov-v-hist', coverageType: 'VENDOR', serialNumber: 'WRT-V-HIST', branchId: WH, startOffset: -800, endOffset: -400, isCurrent: false },
  // SELLER rows prove the two registers share a table but not a page.
  { id: 'wrt-cov-s-wh', coverageType: 'SELLER', serialNumber: 'WRT-S-WH', branchId: WH, startOffset: -200, endOffset: 300 },
  { id: 'wrt-cov-s-brh', coverageType: 'SELLER', serialNumber: 'WRT-S-BRH', branchId: BR, startOffset: -300, endOffset: -5 },
  // Correction targets.
  { id: 'wrt-cov-edit', coverageType: 'VENDOR', serialNumber: 'WRT-E-BRH', branchId: BR, startOffset: -50, endOffset: 100 },
  { id: 'wrt-cov-foreign', coverageType: 'VENDOR', serialNumber: 'WRT-F-WH', branchId: WH, startOffset: -50, endOffset: 100 },
];

function mirrorRow(f: Fixture): WarrantyCoverageRecord {
  return {
    id: f.id,
    coverageType: f.coverageType,
    itemCategory: 'CPE',
    productId: null,
    productName: `WRT Fixture ${f.serialNumber}`,
    serialNumber: f.serialNumber,
    assetId: null,
    deviceRecordId: null,
    branchId: f.branchId,
    partyId: null,
    partyName: 'WRT Party',
    sourceType: 'PURCHASE',
    sourceId: `src-${f.id}`,
    sourceNumber: `DOC-${f.id}`,
    startDateAD: dayOffset(f.startOffset),
    endDateAD: dayOffset(f.endOffset),
    termMonths: 12,
    startBasis: 'MANUAL',
    notes: 'wrt fixture',
    isCurrent: f.isCurrent !== false,
    supersededAt: f.isCurrent === false ? new Date().toISOString() : null,
    isDemo: true,
  };
}

const USERS = {
  super: { id: 'wrt-super', email: 'wrt-super@example.com', name: 'WRT Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  branch: { id: 'wrt-br', email: 'wrt-branch@example.com', name: 'WRT Branch', role: 'INVENTORY_MANAGER', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  noView: { id: 'wrt-acct', email: 'wrt-acct@example.com', name: 'WRT Acct', role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  noEdit: { id: 'wrt-fd', email: 'wrt-fd@example.com', name: 'WRT Front Desk', role: 'FRONT_DESK', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  empty: { id: 'wrt-aud', email: 'wrt-aud@example.com', name: 'WRT Auditor', role: 'AUDITOR', branchId: '', allowedBranchIds: [], canSwitchUser: false },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

describe('warranty coverage API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;

  before(async () => {
    await ensureReferenceData(pool!);
    // Corrections create generated `wc-…` ids, so cleanup keys on the fixture
    // SERIAL prefix as well — otherwise a rerun collides with the
    // one-current-row-per-unit index.
    await pool!.query("DELETE FROM warranty_coverages WHERE id LIKE 'wrt-cov-%' OR serial_number LIKE 'WRT-%'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%WRT-%'");

    for (const f of FIXTURES) {
      await pool!.query(
        `INSERT INTO warranty_coverages
          (id, coverage_type, item_category, product_name, serial_number, branch_id,
           party_name, source_type, source_id, source_number,
           start_date_ad, end_date_ad, term_months, start_basis, notes, is_current, is_demo)
         VALUES ($1, $2, 'CPE', $3, $4, $5, 'WRT Party', 'PURCHASE', $6, $7, $8, $9, 12, 'MANUAL', 'wrt fixture', $10, TRUE)`,
        [
          f.id,
          f.coverageType,
          `WRT Fixture ${f.serialNumber}`,
          f.serialNumber,
          f.branchId,
          `src-${f.id}`,
          `DOC-${f.id}`,
          dayOffset(f.startOffset),
          dayOffset(f.endOffset),
          f.isCurrent !== false,
        ]
      );
    }

    // Demo mirror seeds the same fixture so the parity test compares like data.
    setWarrantyCoverages(FIXTURES.map(mirrorRow));

    // Synthetic matrix: ACCOUNTANT loses the read, FRONT_DESK keeps view but
    // not edit. Both are defaults-adjacent so the gate (not the role) answers.
    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    matrix['warranty-view'] = { ...matrix['warranty-view'], ACCOUNTANT: false };
    matrix['warranty-edit'] = { ...matrix['warranty-edit'], FRONT_DESK: false };
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
    setWarrantyCoverages([]);
    setPermissionMatrix({});
    if (pool) {
      await pool.query("DELETE FROM warranty_coverages WHERE id LIKE 'wrt-cov-%' OR serial_number LIKE 'WRT-%'");
      await pool.query("DELETE FROM audit_logs WHERE details LIKE '%WRT-%'");
      await pool.end();
    }
  });

  async function request(method: 'GET' | 'PATCH', path: string, token?: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  const get = (path: string, token?: string) => request('GET', path, token);
  const patch = (path: string, token: string | undefined, body: unknown) => request('PATCH', path, token, body);

  test('unauthenticated reads and writes are 401', async () => {
    assert.equal((await get('/api/warranties/vendor')).status, 401);
    assert.equal((await get('/api/warranties/seller')).status, 401);
    assert.equal((await patch('/api/warranties/wrt-cov-edit', undefined, { startDateAD: today, endDateAD: today })).status, 401);
  });

  test('each register answers only its own coverage type, current rows only', async () => {
    const vendor = await get('/api/warranties/vendor?branchId=' + WH + '&query=WRT-&pageSize=200', tokens.super);
    assert.equal(vendor.status, 200);
    const vendorSerials = vendor.json.data.map((row: any) => row.serialNumber);
    assert.ok(vendorSerials.includes('WRT-V-WH'), 'the WH vendor row must be listed');
    assert.ok(!vendorSerials.includes('WRT-V-HIST'), 'a superseded row must not be listed as current');
    assert.ok(!vendorSerials.includes('WRT-S-WH'), 'a seller coverage must not appear in the supplier register');
    assert.ok(vendor.json.data.every((row: any) => row.coverageType === 'VENDOR' && row.branchId === WH));
    assert.equal(vendor.json.data.length, 2, 'two current WH vendor fixtures');
    const ends = vendor.json.data.map((row: any) => row.endDateAD);
    assert.deepEqual(ends, [...ends].sort(), 'rows are soonest-expiry first');

    const seller = await get('/api/warranties/seller?branchId=' + WH + '&query=WRT-&pageSize=200', tokens.super);
    assert.equal(seller.status, 200);
    assert.deepEqual(seller.json.data.map((row: any) => row.serialNumber), ['WRT-S-WH']);
    assert.equal(seller.json.data[0].coverageType, 'SELLER');
  });

  test('a branch account reads its own branch only and cannot forge another', async () => {
    const own = await get('/api/warranties/vendor?query=WRT-&pageSize=200', tokens.branch);
    assert.equal(own.status, 200);
    assert.ok(own.json.data.length > 0);
    assert.ok(
      own.json.data.every((row: any) => row.branchId === BR),
      'every row in a branch account page must belong to that branch'
    );
    assert.ok(!own.json.data.some((row: any) => row.serialNumber === 'WRT-V-WH'));

    const forged = await get('/api/warranties/vendor?branchId=' + WH + '&query=WRT-', tokens.branch);
    assert.equal(forged.status, 403, 'a branch account requesting another branch must be refused');

    const all = await get('/api/warranties/vendor?branchId=ALL&query=WRT-', tokens.branch);
    assert.equal(all.status, 403, 'a branch account cannot widen to ALL');
  });

  test('an account with no branch scope gets an empty page, never the whole country', async () => {
    const { status, json } = await get('/api/warranties/vendor?query=WRT-', tokens.empty);
    assert.equal(status, 200);
    assert.deepEqual(json.data, []);
    assert.equal(json.totalItems, 0);
    assert.deepEqual(json.counts, { total: 0, valid: 0, expiring: 0, expired: 0 });
  });

  test('super admin may use ALL and sees both branches', async () => {
    const { status, json } = await get('/api/warranties/vendor?branchId=ALL&query=WRT-V-&pageSize=200', tokens.super);
    assert.equal(status, 200);
    const branches = new Set(json.data.map((row: any) => row.branchId));
    assert.deepEqual([...branches].sort(), [BR, WH].sort());
  });

  test('warranty-view gates both reads; view-only cannot correct', async () => {
    assert.equal((await get('/api/warranties/vendor?query=WRT-', tokens.noView)).status, 403);
    assert.equal((await get('/api/warranties/seller?query=WRT-', tokens.noView)).status, 403);

    assert.equal((await get('/api/warranties/vendor?query=WRT-&branchId=' + BR, tokens.noEdit)).status, 200);
    const refused = await patch('/api/warranties/wrt-cov-edit', tokens.noEdit, {
      startDateAD: dayOffset(-50),
      endDateAD: dayOffset(200),
    });
    assert.equal(refused.status, 403, 'warranty-edit must gate the correction');
  });

  test('status filter narrows the page while the KPI summary keeps every status', async () => {
    const all = await get('/api/warranties/vendor?branchId=' + BR + '&query=WRT-&pageSize=200', tokens.super);
    assert.equal(all.status, 200);
    assert.equal(all.json.counts.total, 3, 'three current BR vendor fixtures (expiring, expired, correction target)');

    const expired = await get('/api/warranties/vendor?branchId=' + BR + '&query=WRT-&status=EXPIRED&pageSize=200', tokens.super);
    assert.equal(expired.status, 200);
    assert.deepEqual(expired.json.data.map((row: any) => row.serialNumber), ['WRT-V-EXPD']);
    assert.ok(expired.json.data.every((row: any) => row.warrantyState === 'EXPIRED'));
    assert.equal(expired.json.totalItems, 1);
    assert.equal(expired.json.counts.total, 3, 'the cards describe the filtered population, not the status slice');
    assert.equal(expired.json.counts.expired, 1);
    assert.equal(expired.json.counts.expiring, 1);
  });

  test('page and pageSize are clamped by the server', async () => {
    const huge = await get('/api/warranties/vendor?branchId=' + BR + '&pageSize=1000', tokens.super);
    assert.equal(huge.status, 200);
    assert.equal(huge.json.pageSize, 200);

    const zero = await get('/api/warranties/vendor?branchId=' + BR + '&page=0', tokens.super);
    assert.equal(zero.status, 200);
    assert.equal(zero.json.page, 1);
  });

  test('the demo mirror answers the same page, order and counts as the SQL path', async () => {
    const http = await get('/api/warranties/vendor?branchId=' + BR + '&query=WRT-V-&pageSize=200', tokens.super);
    assert.equal(http.status, 200);
    const mirror = buildWarrantyMirrorPage(
      { coverageType: 'VENDOR', branchId: BR, query: 'WRT-V-' },
      1,
      200
    );
    assert.deepEqual(
      mirror.data.map((row) => row.id),
      http.json.data.map((row: any) => row.id),
      'the PG-less path must return the same rows in the same order'
    );
    assert.equal(mirror.totalItems, http.json.totalItems);
    assert.deepEqual(
      {
        total: mirror.counts.total,
        valid: mirror.counts.valid,
        expiring: mirror.counts.expiring,
        expired: mirror.counts.expired,
      },
      http.json.counts
    );
    assert.ok(!mirror.data.some((row) => row.serialNumber === 'WRT-V-HIST'), 'mirror also hides superseded rows');
  });

  test('a correction supersedes the prior row, keeps it, and audits old → new', async () => {
    const before = await pool!.query("SELECT * FROM warranty_coverages WHERE id = 'wrt-cov-edit'");
    const original = before.rows[0];
    assert.equal(adOf(original.end_date_ad), dayOffset(100));

    const correctedEnd = dayOffset(220);
    const res = await patch('/api/warranties/wrt-cov-edit', tokens.branch, {
      startDateAD: dayOffset(-50),
      endDateAD: correctedEnd,
      termMonths: 9,
      notes: 'Supplier contract amended (WRT)',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.notEqual(res.json.id, 'wrt-cov-edit', 'a correction is a new row, not the old one edited');
    assert.equal(res.json.serialNumber, 'WRT-E-BRH');
    assert.equal(res.json.startDateAD, dayOffset(-50));
    assert.equal(res.json.endDateAD, correctedEnd);
    assert.equal(res.json.termMonths, 9);
    assert.equal(res.json.startBasis, 'MANUAL');
    assert.equal(res.json.warrantyState, 'VALID');

    // The replaced period is retired, not rewritten.
    const old = await pool!.query("SELECT * FROM warranty_coverages WHERE id = 'wrt-cov-edit'");
    assert.equal(old.rows[0].is_current, false);
    assert.ok(old.rows[0].superseded_at);
    assert.equal(adOf(old.rows[0].end_date_ad), dayOffset(100), 'history keeps its own expiry');
    assert.equal(old.rows[0].term_months, 12, 'history keeps its own term');

    // Exactly one current row survives, and it carries the corrected dates.
    const current = await pool!.query(
      "SELECT * FROM warranty_coverages WHERE coverage_type = 'VENDOR' AND serial_number = 'WRT-E-BRH' AND is_current = TRUE"
    );
    assert.equal(current.rowCount, 1);
    assert.equal(adOf(current.rows[0].end_date_ad), correctedEnd);
    assert.equal(current.rows[0].notes, 'Supplier contract amended (WRT)');
    assert.equal(current.rows[0].updated_by, 'wrt-branch@example.com');

    // The audit row commits with the correction.
    const audit = await pool!.query(
      "SELECT * FROM audit_logs WHERE action = 'UPDATE_WARRANTY_COVERAGE' AND details LIKE '%WRT-E-BRH%' ORDER BY timestamp_ad DESC LIMIT 1"
    );
    assert.equal(audit.rowCount, 1, 'the correction must be audited');
    assert.match(audit.rows[0].details, new RegExp(dayOffset(100) + '.*' + correctedEnd));
    assert.equal(audit.rows[0].user_email, 'wrt-branch@example.com');

    // The register now shows the correction and only one row for the unit.
    const listed = await get('/api/warranties/vendor?query=WRT-E-BRH&pageSize=50', tokens.branch);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data.length, 1);
    assert.equal(listed.json.data[0].id, res.json.id);
    assert.equal(listed.json.data[0].endDateAD, correctedEnd);
  });

  test('a second correction stacks another period and still leaves one current row', async () => {
    const listed = await get('/api/warranties/vendor?query=WRT-E-BRH&pageSize=50', tokens.branch);
    const currentId = listed.json.data[0].id;
    const res = await patch('/api/warranties/' + currentId, tokens.branch, {
      startDateAD: dayOffset(-50),
      endDateAD: dayOffset(240),
      termMonths: 8,
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const rows = await pool!.query(
      "SELECT is_current FROM warranty_coverages WHERE coverage_type = 'VENDOR' AND serial_number = 'WRT-E-BRH'"
    );
    assert.equal(rows.rowCount, 3, 'two superseded periods plus the current one');
    assert.equal(rows.rows.filter((row) => row.is_current).length, 1);
  });

  test('the correction refuses invalid input and leaves the stored row untouched', async () => {
    const listed = await get('/api/warranties/vendor?query=WRT-E-BRH&pageSize=50', tokens.branch);
    const id = listed.json.data[0].id;
    const storedEnd = listed.json.data[0].endDateAD;

    const cases: Array<[string, unknown, RegExp]> = [
      ['reversed', { startDateAD: dayOffset(10), endDateAD: dayOffset(1) }, /on or after|real date/i],
      ['missing end', { startDateAD: dayOffset(1) }, /required/i],
      ['impossible day', { startDateAD: dayOffset(1), endDateAD: '2026-02-31' }, /on or after|real date/i],
      ['term above the ceiling', { startDateAD: dayOffset(1), endDateAD: dayOffset(30), termMonths: 121 }, /between 0 and 120/],
    ];
    for (const [label, body, message] of cases) {
      const res = await patch('/api/warranties/' + id, tokens.branch, body);
      assert.equal(res.status, 400, `${label} must be a 400`);
      assert.match(res.json.message, message, `${label} message`);
    }

    const missing = await patch('/api/warranties/wrt-cov-does-not-exist', tokens.branch, {
      startDateAD: dayOffset(1),
      endDateAD: dayOffset(2),
    });
    assert.equal(missing.status, 404);

    const foreign = await patch('/api/warranties/wrt-cov-foreign', tokens.branch, {
      startDateAD: dayOffset(1),
      endDateAD: dayOffset(2),
    });
    assert.equal(foreign.status, 403, 'a branch account cannot correct another branch custody');

    const still = await get('/api/warranties/vendor?query=WRT-E-BRH&pageSize=50', tokens.branch);
    assert.equal(still.json.data[0].id, id);
    assert.equal(still.json.data[0].endDateAD, storedEnd, 'a rejected correction must not move the stored expiry');
  });
});
