/**
 * VOL-4b — customer devices leave the bootstrap; the register pages.
 *
 * PROVES:
 *  1. SOURCE (no DB): `/api/bootstrap` no longer serializes `customerDevices`,
 *     the fan-out no longer reads the table, and App holds no device array.
 *  2. SOURCE: the search WHERE and `idx_customer_devices_global_trgm` are the
 *     SAME expression, so a debounced register search cannot silently fall
 *     back to a sequential scan of the national device table.
 *  3. HTTP (real app + real PostgreSQL): the register pages, a device outside
 *     page 1 is reachable by search, and the page size is capped.
 *  4. HTTP: branch scope is a server decision — omitting `branchId` is a 403
 *     for a branch role, forging another branch is a 403, and a multi-branch
 *     account reads the branches it names.
 *  5. HTTP: the overview counts every status under the search filters (not
 *     just the page on screen), and the warranty union filters by the exact
 *     computed state at all four boundary days.
 *  6. HTTP: `all=1` reports truncation at the cap instead of silently
 *     exporting one page.
 *  7. HTTP: `GET /api/bootstrap/local?key=customerDevices` still answers for
 *     an older client, and the legacy bare-array read stays bounded.
 *
 * Fixtures are prefixed `v4b-` and removed in after(); nothing is read from
 * the demo seed. Skips without a reachable PostgreSQL.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import {
  CDR_SEARCH_TEXT_SQL,
  CUSTOMER_DEVICE_EXPORT_MAX,
} from '../server/src/models/inventory.repo';
import { getWarrantyInfo } from '../client/src/utils/warranty';
import { ensureReferenceData } from './fixtures/referenceData';

dotenv.config();

const ROOT = path.resolve('.');

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

const BRANCH_A = 'V4BBR';
const BRANCH_B = 'V4BBR2';
const BRANCH_W = 'V4BBRW';
const BRANCH_E = 'V4BBRE';
const CODE_PREFIX = 'V4B-';

const SUPER_USER = {
  id: 'v4b-super', email: 'v4b-super@example.com', name: 'V4B Super',
  role: 'SUPER_ADMIN', branchId: BRANCH_A, allowedBranchIds: [BRANCH_A, BRANCH_B, BRANCH_W, BRANCH_E],
  canSwitchUser: false,
} as any;

/** Scoped to branch A only: omission must never widen it to the country. */
const BRANCH_USER = {
  id: 'v4b-branch', email: 'v4b-branch@example.com', name: 'V4B Branch',
  role: 'BRANCH_MANAGER', branchId: BRANCH_A, allowedBranchIds: [BRANCH_A],
  canSwitchUser: false,
} as any;

/** Two branches: omitting the parameter must mean both of THEM. */
const MULTI_USER = {
  id: 'v4b-multi', email: 'v4b-multi@example.com', name: 'V4B Multi',
  role: 'BRANCH_MANAGER', branchId: BRANCH_A, allowedBranchIds: [BRANCH_A, BRANCH_B],
  canSwitchUser: false,
} as any;

/** Six device rows in A (newest last in the fixture list), two in B. */
const DEVICE_ROWS = [
  { id: 'v4b-d01', serial: 'V4B-SN-001', status: 'RENTAL', branch: BRANCH_A, name: 'V4B Alpha 01', minutesAgo: 6 },
  { id: 'v4b-d02', serial: 'V4B-SN-002', status: 'ACTIVE', branch: BRANCH_A, name: 'V4B Alpha 02', minutesAgo: 5 },
  { id: 'v4b-d03', serial: 'V4B-SN-003', status: 'ACTIVE', branch: BRANCH_A, name: 'V4B Alpha 03', minutesAgo: 4 },
  { id: 'v4b-d04', serial: 'V4B-SN-004', status: 'ACTIVE', branch: BRANCH_A, name: 'V4B Alpha 04', minutesAgo: 3 },
  { id: 'v4b-d05', serial: 'V4B-SN-005', status: 'RENTAL', branch: BRANCH_A, name: 'V4B Alpha 05', minutesAgo: 2 },
  { id: 'v4b-d06', serial: 'V4B-SN-006', status: 'ACTIVE', branch: BRANCH_A, name: 'V4B Alpha 06', minutesAgo: 1 },
  { id: 'v4b-b01', serial: 'V4B-SN-B01', status: 'ACTIVE', branch: BRANCH_B, name: 'V4B Beta 01', minutesAgo: 2 },
  { id: 'v4b-b02', serial: 'V4B-SN-B02', status: 'RENTAL', branch: BRANCH_B, name: 'V4B Beta 02', minutesAgo: 1 },
];

/** `endIso` minus 12 calendar months, the inverse of the server's +12 rule. */
function issueDateFor(endIso: string): string {
  const end = new Date(`${endIso}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() - 12);
  return end.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('VOL-4b — customer devices off the bootstrap', () => {
  test('source: the bootstrap fan-out does not read customer_device_records and the payload has no key', () => {
    const repo = fs.readFileSync(path.join(ROOT, 'server/src/models/bootstrap.repo.ts'), 'utf8');
    assert.ok(
      !/BOOTSTRAP_TABLES\.customerDevices\b/.test(repo),
      'the bootstrap fan-out reads customer_device_records again — the register must stay on /api/customer-devices/page'
    );

    const controller = fs.readFileSync(
      path.join(ROOT, 'server/src/controllers/bootstrap.controller.ts'),
      'utf8'
    );
    const payload = controller.slice(
      controller.lastIndexOf('return res.json({'),
      controller.lastIndexOf('} catch')
    );
    assert.ok(
      !/customerDevices:\s*(data\.|pg|await|\[)/.test(payload),
      'the bootstrap response serializes customerDevices again — a national device table would ride every login'
    );

    // The legacy local slice must stay mapped for a cached older bundle.
    assert.match(
      controller,
      /'customerDevices'\]\.includes\(key\)|customerDevices'[^\n]*BOOTSTRAP_TABLES|BOOTSTRAP_TABLES\.customerDevices/,
      'GET /api/bootstrap/local must still answer key=customerDevices for an older client'
    );
  });

  test('source: App holds no device array and passes none to a screen', () => {
    const app = fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8');
    assert.ok(
      !/setCustomerDevices\s*\(/.test(app),
      'App still keeps a customerDevices array — the register owns its paged rows'
    );
    assert.ok(
      !/customerDevices=\{\s*customerDevices\s*\}/.test(app),
      'a screen is still handed the whole device table as a prop'
    );
    assert.ok(
      /registerRefresh\.customerDevices/.test(app),
      'the paged device registers must keep their SSE refresh counter'
    );
  });

  test('source: no screen filters the whole device table client-side', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        // The removed shape: a prop/state array of device rows, scanned in the
        // browser for a count, a serial or an assigned-hardware column.
        // Rendering the current page (.map) is the legitimate shape; scanning
        // the array for a count/serial is the removed whole-table shape.
        if (
          /customerDevices\.(find|filter|some)\s*\(/.test(source) ||
          /customerDevicesRows\.(find|filter|some)\s*\(/.test(source)
        ) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'client/src/features'));
    assert.deepEqual(
      offenders,
      [],
      'these screens still scan a whole device array: ' + offenders.join(', ')
    );
  });

  test('source: the search WHERE and the schema trigram index are the same expression', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'scripts/schema.sql'), 'utf8');
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const indexBlock = schema.slice(schema.indexOf('idx_customer_devices_global_trgm'));
    const indexSql = normalize(indexBlock.slice(0, indexBlock.indexOf(');') + 2));
    assert.ok(
      indexSql.includes(normalize(CDR_SEARCH_TEXT_SQL)),
      'idx_customer_devices_global_trgm no longer indexes CDR_SEARCH_TEXT_SQL — rebuild the index and the WHERE together'
    );
    assert.ok(
      /idx_customer_devices_page/.test(schema),
      'the stable page index (branch_id, created_at DESC, id DESC) is missing'
    );
  });

  test('source: every device read in the client goes through the paged API', () => {
    const surfaces = [
      'sales/CustomersManagement.tsx',
      'sales/CustomerMasterDirectory.tsx',
      'inventory/WarrantyProducts.tsx',
      'inventory/ExportStock.tsx',
    ];
    for (const relative of surfaces) {
      const source = fs.readFileSync(path.join(ROOT, 'client/src/features', relative), 'utf8');
      assert.ok(
        /getCustomerDevice(Page|Export|Overview|Warranty)|getCustomerDevices/.test(source),
        `${relative} no longer reads a device register at all — did it fall back to a prop?`
      );
      assert.ok(
        !/customerDevices:/.test(source) || /CustomerDeviceQueryParams/.test(source),
        `${relative} still receives a customerDevices array`
      );
    }
  });

  describe('HTTP against real PostgreSQL', () => {
    let port = 0;
    let close: (() => Promise<void>) | null = null;
    let todayAd = '';
    const superToken = issueAuthToken(SUPER_USER);
    const branchToken = issueAuthToken(BRANCH_USER);
    const multiToken = issueAuthToken(MULTI_USER);

    before(async () => {
      if (!dbReachable || !pool) return;
      await cleanupFixtures();
      for (const [id, code, name] of [
        [BRANCH_A, 'V4BA', 'V4B Test Branch A'],
        [BRANCH_B, 'V4BB', 'V4B Test Branch B'],
        [BRANCH_W, 'V4BW', 'V4B Warranty Branch'],
        [BRANCH_E, 'V4BE', 'V4B Export Branch'],
      ]) {
        await pool.query(
          'INSERT INTO branches (id, code, name, location) VALUES ($1, $2, $3, $4)',
          [id, code, name, 'V4B fixture']
        );
      }

      for (let index = 0; index < DEVICE_ROWS.length; index++) {
        const row = DEVICE_ROWS[index];
        await pool.query(
          `INSERT INTO customer_device_records
             (id, customer_id, customer_name, customer_code, contact_phone, installation_address,
              branch_id, product_name, device_serial, pon_serial, mac_address, status,
              issued_date_ad, issued_date_bs, purchase_bill_ref, created_at)
           VALUES ($1, $2, $3, $4, '9800000000', 'Kathmandu', $5, 'V4B Router', $6, $7, $8, $9,
                   $10, '2083-07-10', 'V4B-BILL', CURRENT_TIMESTAMP - ($11 || ' minutes')::interval)`,
          [
            row.id,
            `${CODE_PREFIX}CUST-${row.id}`,
            row.name,
            `${CODE_PREFIX}${row.id}`,
            row.branch,
            row.serial,
            `PON-${row.serial}`,
            `AA:BB:CC:DD:EE:${String(index + 1).padStart(2, '0')}`,
            row.status,
            row.branch === BRANCH_A ? '2026-08-01' : '2026-08-02',
            String(row.minutesAgo),
          ]
        );
      }

      const todayRow = await pool.query('SELECT CURRENT_DATE::text AS d');
      todayAd = todayRow.rows[0].d as string;

      // Warranty boundary rows: end = today-1, today, today+30, today+31.
      const boundaryEnds = [addDays(todayAd, -1), todayAd, addDays(todayAd, 30), addDays(todayAd, 31)];
      for (let i = 0; i < boundaryEnds.length; i++) {
        const issued = issueDateFor(boundaryEnds[i]);
        await pool.query(
          `INSERT INTO customer_device_records
             (id, customer_id, customer_name, customer_code, contact_phone, installation_address,
              branch_id, product_name, device_serial, pon_serial, mac_address, status,
              issued_date_ad, issued_date_bs, purchase_bill_ref, created_at)
           VALUES ($1, $2, $3, $4, '9800000000', 'Lalitpur', $5, 'V4B Warranty Router', $6, $7, $8, 'RENTAL',
                   $9, '2083-07-10', 'V4B-WBILL', CURRENT_TIMESTAMP - ($10 || ' minutes')::interval)`,
          [
            `v4b-w${i + 1}`,
            `${CODE_PREFIX}WCUST-${i + 1}`,
            `V4B Warranty ${i + 1}`,
            `${CODE_PREFIX}W${i + 1}`,
            BRANCH_W,
            `V4B-W-SN-00${i + 1}`,
            `V4B-W-PON-00${i + 1}`,
            `AA:BB:CC:DD:FF:0${i + 1}`,
            // Two rows share an issue date in August 2025/2026; the serial
            // search below distinguishes them, not the date.
            issued,
            String(10 + i),
          ]
        );
      }

      // Two fixed assets: one valid, one expired, in the warranty branch.
      const validAssetIssue = issueDateFor(boundaryEnds[3]);
      const expiredAssetIssue = issueDateFor(boundaryEnds[0]);
      for (const [suffix, issued, tag] of [
        ['a1', validAssetIssue, 'V4B-TAG-001'],
        ['a2', expiredAssetIssue, 'V4B-TAG-002'],
      ]) {
        await pool.query(
          `INSERT INTO fixed_assets
             (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs,
              acquisition_cost, net_book_value, status, invoice_no)
           VALUES ($1, $2, $3, 'NETWORK_EQUIPMENT', $4, $5, '2083-07-10', 10000, 10000, 'ACTIVE', 'V4B-WBILL')`,
          [`v4b-${suffix}`, tag, `V4B Fixed Asset ${suffix}`, BRANCH_W, issued]
        );
      }

      // 20,001 rows so the export cap can be observed honestly.
      await pool.query(
        `INSERT INTO customer_device_records
           (id, customer_id, customer_name, customer_code, contact_phone, installation_address,
            branch_id, product_name, device_serial, pon_serial, mac_address, status,
            issued_date_ad, issued_date_bs, purchase_bill_ref, created_at)
         SELECT 'v4b-exp-' || n, 'v4b-exp-cust', 'V4B Export ' || n, 'v4b-exp-' || n,
                '9800000000', 'Biratnagar', $1, 'V4B Bulk', 'V4B-EXP-SN-' || n,
                'V4B-EXP-PON-' || n, NULL, 'ACTIVE',
                DATE '2026-08-01', '2083-07-10', 'V4B-BILL',
                CURRENT_TIMESTAMP - (n || ' seconds')::interval
         FROM generate_series(1, $2) AS n`,
        [BRANCH_E, CUSTOMER_DEVICE_EXPORT_MAX + 1]
      );

      await ensureReferenceData(pool);

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
      if (pool && dbReachable) {
        await cleanupFixtures().catch(() => undefined);
        await pool.end();
      }
    });

    async function cleanupFixtures() {
      if (!pool) return;
      await pool.query("DELETE FROM fixed_assets WHERE id LIKE 'v4b-%'");
      await pool.query("DELETE FROM customer_device_records WHERE id LIKE 'v4b-%'");
      await pool.query('DELETE FROM branches WHERE id IN ($1, $2, $3, $4)', [BRANCH_A, BRANCH_B, BRANCH_W, BRANCH_E]);
    }

    async function get(urlPath: string, token = superToken) {
      const res = await fetch('http://127.0.0.1:' + port + urlPath, {
        headers: { authorization: 'Bearer ' + token },
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
      return { status: res.status, json };
    }

    test('GET /api/bootstrap ships no customerDevices, but the local slice still answers', { skip: skipNoDb }, async () => {
      const boot = await get('/api/bootstrap');
      assert.equal(boot.status, 200, JSON.stringify(boot.json));
      assert.ok(!('customerDevices' in boot.json), 'customerDevices must be served by the paged endpoint, not bootstrap');
      assert.ok(Array.isArray(boot.json.branches), 'the rest of the payload must be intact');

      const local = await get('/api/bootstrap/local?key=customerDevices');
      assert.equal(local.status, 200, JSON.stringify(local.json));
      assert.ok(
        Array.isArray(local.json?.customerDevices),
        'an older client bundle still asks for the customerDevices slice; it must keep answering'
      );
      assert.ok(typeof local.json?.dataVersion === 'number', 'slice responses must carry dataVersion');
    });

    test('the register pages newest-first, and a device outside page 1 is reachable', { skip: skipNoDb }, async () => {
      const first = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=V4B&page=1&pageSize=2`);
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(first.json.data.length, 2, 'a page never transfers the branch table');
      assert.equal(first.json.totalItems, 6);
      assert.deepEqual(first.json.data.map((r: any) => r.id), ['v4b-d06', 'v4b-d05']);

      const second = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=V4B&page=2&pageSize=2`);
      assert.equal(second.status, 200, JSON.stringify(second.json));
      assert.deepEqual(second.json.data.map((r: any) => r.id), ['v4b-d04', 'v4b-d03']);

      // What a debounced search does: page 1 of a contains filter.
      const outsidePage1 = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=SN-001&page=1&pageSize=15`);
      assert.equal(outsidePage1.status, 200, JSON.stringify(outsidePage1.json));
      assert.equal(outsidePage1.json.totalItems, 1);
      assert.equal(outsidePage1.json.data[0].deviceSerial, 'V4B-SN-001');

      const capped = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=V4B&pageSize=500`);
      assert.equal(capped.status, 200, JSON.stringify(capped.json));
      assert.equal(capped.json.pageSize, 200, 'pageSize must be capped at 200');
    });

    test('status, product and the search describe the same filtered population as the page', { skip: skipNoDb }, async () => {
      const rentals = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=V4B&status=RENTAL`);
      assert.equal(rentals.status, 200, JSON.stringify(rentals.json));
      assert.equal(rentals.json.totalItems, 2);
      assert.ok(rentals.json.data.every((r: any) => r.status === 'RENTAL'));

      const unknown = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=V4B&status=NOT_A_STATUS`);
      assert.equal(unknown.status, 200, JSON.stringify(unknown.json));
      assert.equal(unknown.json.totalItems, 6, 'an unknown status is ignored, not concatenated into SQL');

      const overview = await get(`/api/customer-devices/overview?branchId=${BRANCH_A}&query=V4B`);
      assert.equal(overview.status, 200, JSON.stringify(overview.json));
      assert.equal(overview.json.total, 6);
      assert.deepEqual(overview.json.counts, { ACTIVE: 4, RENTAL: 2 });

      // The directory's expanded row asks by attribution, not a substring that
      // could also match CUS-10 when it means CUS-1.
      const oneCustomer = await get(
        `/api/customer-devices/page?branchId=${BRANCH_A}&customerId=${CODE_PREFIX}v4b-d01`
      );
      assert.equal(oneCustomer.status, 200, JSON.stringify(oneCustomer.json));
      assert.equal(oneCustomer.json.totalItems, 1);
      assert.equal(oneCustomer.json.data[0].id, 'v4b-d01');
    });

    test('a branch account cannot widen the register by omitting or forging branchId', { skip: skipNoDb }, async () => {
      const unscoped = await get('/api/customer-devices/page?query=V4B&pageSize=50', branchToken);
      assert.equal(unscoped.status, 403, 'an omitted branchId must not mean "the whole country"');
      assert.match(String(unscoped.json?.message || ''), /branch filter/i);

      const forged = await get(`/api/customer-devices/page?branchId=${BRANCH_B}&query=V4B`, branchToken);
      assert.equal(forged.status, 403, JSON.stringify(forged.json));

      const own = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=V4B&pageSize=50`, branchToken);
      assert.equal(own.status, 200, JSON.stringify(own.json));
      assert.equal(own.json.totalItems, 6);
      for (const row of own.json.data) assert.equal(row.branchId, BRANCH_A, 'branch scope leaked a foreign row');
    });

    test('a multi-branch account reads each branch it names, and only those', { skip: skipNoDb }, async () => {
      const a = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=V4B`, multiToken);
      assert.equal(a.status, 200, JSON.stringify(a.json));
      assert.equal(a.json.totalItems, 6);

      const b = await get(`/api/customer-devices/page?branchId=${BRANCH_B}&query=V4B`, multiToken);
      assert.equal(b.status, 200, JSON.stringify(b.json));
      assert.equal(b.json.totalItems, 2);

      const overviewB = await get(`/api/customer-devices/overview?branchId=${BRANCH_B}&query=V4B`, multiToken);
      assert.equal(overviewB.status, 200, JSON.stringify(overviewB.json));
      assert.deepEqual(overviewB.json.counts, { ACTIVE: 1, RENTAL: 1 });
    });

    test('the warranty union filters by the same computed state at all four boundary days', { skip: skipNoDb }, async () => {
      const base = `/api/customer-devices/warranty?branchId=${BRANCH_W}&query=V4B-W&category=CPE&pageSize=50`;
      const all = await get(base);
      assert.equal(all.status, 200, JSON.stringify(all.json));
      assert.equal(all.json.totalItems, 4);
      assert.deepEqual(all.json.counts, { total: 4, valid: 1, expiring: 2, expired: 1 });

      const expectedEnds = [addDays(todayAd, -1), todayAd, addDays(todayAd, 30), addDays(todayAd, 31)];
      const bySerial = new Map(all.json.data.map((row: any) => [row.serialOrTag, row]));
      for (let i = 0; i < expectedEnds.length; i++) {
        const row = bySerial.get(`V4B-W-SN-00${i + 1}`) as any;
        assert.ok(row, `missing warranty fixture row ${i + 1}`);
        assert.equal(row.warrantyEndDateAD, expectedEnds[i], 'the server must return the end date it filtered on');
        // The client utility and the SQL rule must agree at each boundary.
        assert.equal(
          row.warrantyState,
          getWarrantyInfo(row.issuedDateAD, 12).status,
          `warranty SQL and getWarrantyInfo disagree for ${row.serialOrTag}`
        );
      }

      const expired = await get(base + '&warranty=EXPIRED');
      assert.equal(expired.status, 200, JSON.stringify(expired.json));
      assert.deepEqual(expired.json.data.map((r: any) => r.serialOrTag), ['V4B-W-SN-001']);
      assert.equal(expired.json.counts.total, 4, 'the summary describes the population, not the state filter');

      const expiring = await get(base + '&warranty=EXPIRING_SOON');
      assert.equal(expiring.status, 200, JSON.stringify(expiring.json));
      assert.deepEqual(expiring.json.data.map((r: any) => r.serialOrTag).sort(), ['V4B-W-SN-002', 'V4B-W-SN-003']);

      const valid = await get(base + '&warranty=VALID');
      assert.equal(valid.status, 200, JSON.stringify(valid.json));
      assert.deepEqual(valid.json.data.map((r: any) => r.serialOrTag), ['V4B-W-SN-004']);

      const assets = await get(`/api/customer-devices/warranty?branchId=${BRANCH_W}&query=V4B-TAG&category=FIXED_ASSET&pageSize=50`);
      assert.equal(assets.status, 200, JSON.stringify(assets.json));
      assert.equal(assets.json.totalItems, 2);
      assert.equal(assets.json.counts.valid, 1);
      assert.equal(assets.json.counts.expired, 1);
      assert.ok(assets.json.data.every((r: any) => r.type === 'FIXED_ASSET'));
    });

    test('all=1 reports truncation at the cap instead of silently exporting one page', { skip: skipNoDb }, async () => {
      const exported = await get(`/api/customer-devices/page?branchId=${BRANCH_E}&query=V4B-EXP&all=1`);
      assert.equal(exported.status, 200, JSON.stringify(exported.json));
      assert.equal(exported.json.data.length, CUSTOMER_DEVICE_EXPORT_MAX);
      assert.equal(exported.json.truncated, true);
      assert.equal(exported.json.totalItems, CUSTOMER_DEVICE_EXPORT_MAX + 1);

      const small = await get(`/api/customer-devices/page?branchId=${BRANCH_A}&query=V4B&all=1`);
      assert.equal(small.status, 200, JSON.stringify(small.json));
      assert.equal(small.json.data.length, 6);
      assert.equal(small.json.truncated, false, 'a complete export must not claim truncation');
    });

    test('the legacy bare-array read still answers, bounded and scoped', { skip: skipNoDb }, async () => {
      const legacy = await get(`/api/customer-devices?branchId=${BRANCH_A}&query=V4B`);
      assert.equal(legacy.status, 200, JSON.stringify(legacy.json));
      assert.ok(Array.isArray(legacy.json), 'the older bundle expects a bare array');
      assert.equal(legacy.json.length, 6);

      const unscoped = await get('/api/customer-devices?query=V4B', branchToken);
      assert.equal(unscoped.status, 403, 'the legacy read must obey the same branch rule');
    });
  });
});
