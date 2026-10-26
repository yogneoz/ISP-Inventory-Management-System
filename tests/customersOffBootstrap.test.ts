/**
 * VOL-4a — customers leave the bootstrap; the directory search is the only read.
 *
 * PROVES:
 *  1. SOURCE (no DB): `/api/bootstrap` no longer serializes `customers`, the
 *     fan-out no longer reads the table, and App holds no customer array —
 *     the old whole-directory prop is gone from every screen.
 *  2. SOURCE: the search WHERE and the schema trigram index are the SAME
 *     expression. If they drift, every picker keystroke silently falls back to
 *     a sequential scan of the national directory.
 *  3. HTTP (real app + real PostgreSQL): a customer OUTSIDE page 1 is still
 *     found by the picker search, while page 1 itself stays small.
 *  4. HTTP: branch scope is a server decision — omitting `branchId` means "my
 *     branches", forging another branch is a 403, and a global role still reads
 *     the whole scope.
 *  5. HTTP: `GET /api/bootstrap/local?key=customers` still answers for an older
 *     client, so the trim is not a breaking change for a cached bundle.
 *
 * Fixtures are prefixed `v4a-` and removed in after(); nothing is read from the
 * demo seed. Skips without a reachable PostgreSQL.
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
import { CUSTOMER_SEARCH_TEXT_SQL } from '../server/src/models/masterdata.repo';
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

const BRANCH_A = 'V4ABR';
const BRANCH_B = 'V4ABR2';
const CODE_PREFIX = 'V4A-';

const SUPER_USER = {
  id: 'v4a-super', email: 'v4a-super@example.com', name: 'V4A Super',
  role: 'SUPER_ADMIN', branchId: BRANCH_A, allowedBranchIds: [BRANCH_A, BRANCH_B],
  canSwitchUser: false,
} as any;

/** Scoped to branch A only: omission must never widen it to the country. */
const BRANCH_USER = {
  id: 'v4a-branch', email: 'v4a-branch@example.com', name: 'V4A Branch',
  role: 'BRANCH_MANAGER', branchId: BRANCH_A, allowedBranchIds: [BRANCH_A],
  canSwitchUser: false,
} as any;

/** Two branches: omitting the parameter must mean both of THEM. */
const MULTI_USER = {
  id: 'v4a-multi', email: 'v4a-multi@example.com', name: 'V4A Multi',
  role: 'BRANCH_MANAGER', branchId: BRANCH_A, allowedBranchIds: [BRANCH_A, BRANCH_B],
  canSwitchUser: false,
} as any;

/** 13 rows in branch A (one sorts last) and 2 in branch B. */
const CUSTOMER_ROWS = [
  ...Array.from({ length: 13 }, (_, i) => ({
    id: `v4a-c${String(i + 1).padStart(2, '0')}`,
    code: `${CODE_PREFIX}${String(i + 1).padStart(3, '0')}`,
    name: `V4A Alpha ${String(i + 1).padStart(2, '0')}`,
    branch: BRANCH_A,
  })),
  {
    id: 'v4a-c99',
    code: `${CODE_PREFIX}ZZZ`,
    name: 'V4A Zulu Landline',
    branch: BRANCH_A,
  },
  { id: 'v4a-b1', code: `${CODE_PREFIX}B01`, name: 'V4A Beta One', branch: BRANCH_B },
  { id: 'v4a-b2', code: `${CODE_PREFIX}B02`, name: 'V4A Beta Two', branch: BRANCH_B },
];

describe('VOL-4a — customers off the bootstrap', () => {
  test('source: the bootstrap fan-out does not read customer_records and the payload has no customers key', () => {
    const repo = fs.readFileSync(path.join(ROOT, 'server/src/models/bootstrap.repo.ts'), 'utf8');
    assert.ok(
      !/BOOTSTRAP_TABLES\.customers\b/.test(repo),
      'the bootstrap fan-out reads customer_records again — the pickers must stay on GET /api/customers'
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
      !/customers:\s*data\.customers/.test(payload),
      'the bootstrap response serializes customers again — the national directory would ride every login'
    );
  });

  test('source: App holds no customer directory array and passes none to a screen', () => {
    const app = fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8');
    assert.ok(
      !/setCustomers\s*\(/.test(app),
      'App still keeps a customers array — no state should mirror the directory'
    );
    assert.ok(
      !/customers=\{\s*customers\s*\}/.test(app),
      'a screen is still handed the whole customer directory as a prop'
    );
  });

  test('source: no screen resolves a customer out of a client-side array', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        // A whole-directory consumer: indexing the first row, or scanning it.
        if (/customers\[0\]/.test(source) || /customers\.(find|filter|map|some)\s*\(/.test(source)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'client/src/features'));
    assert.deepEqual(
      offenders,
      [],
      'these screens still read a customers array: ' + offenders.join(', ')
    );
  });

  test('source: the picker request names the shell branch', () => {
    const api = fs.readFileSync(path.join(ROOT, 'client/src/services/api/inventory.ts'), 'utf8');
    const search = api.slice(api.indexOf('export async function searchCustomers'));
    assert.ok(
      /branchId:\s*getActiveBranchId\(\)/.test(search),
      'searchCustomers must send the active branch — /api/customers refuses an unscoped branch-role read with a 403, which a picker renders as an empty directory'
    );
  });

  test('source: the search WHERE and the schema trigram index are the same expression', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'scripts/schema.sql'), 'utf8');
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const indexBlock = schema.slice(schema.indexOf('idx_customer_records_search_trgm'));
    const indexSql = normalize(indexBlock.slice(0, indexBlock.indexOf(');') + 2));
    assert.ok(
      indexSql.includes(normalize(CUSTOMER_SEARCH_TEXT_SQL)),
      'idx_customer_records_search_trgm no longer indexes CUSTOMER_SEARCH_TEXT_SQL — rebuild the index and the WHERE together'
    );
    assert.ok(
      /idx_customer_records_name/.test(schema),
      'the stable name-ordered page index (branch_id, customer_name, customer_id) is missing'
    );
  });

  describe('HTTP against real PostgreSQL', () => {
    let port = 0;
    let close: (() => Promise<void>) | null = null;
    const superToken = issueAuthToken(SUPER_USER);
    const branchToken = issueAuthToken(BRANCH_USER);
    const multiToken = issueAuthToken(MULTI_USER);

    before(async () => {
      if (!dbReachable || !pool) return;
      await cleanupFixtures();
      for (const [id, code, name] of [
        [BRANCH_A, 'V4AA', 'V4A Test Branch A'],
        [BRANCH_B, 'V4AB', 'V4A Test Branch B'],
      ]) {
        await pool.query(
          'INSERT INTO branches (id, code, name, location) VALUES ($1, $2, $3, $4)',
          [id, code, name, 'V4A fixture']
        );
      }
      for (const row of CUSTOMER_ROWS) {
        await pool.query(
          `INSERT INTO customer_records
             (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', 0, 0)`,
          [
            row.id,
            row.code,
            row.name,
            row.code.toLowerCase(),
            '9800000000',
            row.branch,
            'Kathmandu',
            `${row.code.toLowerCase()}@example.com`,
          ]
        );
      }
      // The full bootstrap refuses without a fiscal year + branch master.
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
      await pool.query('DELETE FROM customer_records WHERE id LIKE $1', ['v4a-%']);
      await pool.query('DELETE FROM branches WHERE id IN ($1, $2)', [BRANCH_A, BRANCH_B]);
    }

    async function get(urlPath: string, token = superToken) {
      const res = await fetch('http://127.0.0.1:' + port + urlPath, {
        headers: { authorization: 'Bearer ' + token },
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
      return { status: res.status, json };
    }

    test('GET /api/bootstrap ships no customers, but the local slice still answers', { skip: skipNoDb }, async () => {
      const boot = await get('/api/bootstrap');
      assert.equal(boot.status, 200, JSON.stringify(boot.json));
      assert.ok(!('customers' in boot.json), 'customers must be served by GET /api/customers, not bootstrap');
      assert.ok(Array.isArray(boot.json.branches), 'the rest of the payload must be intact');

      const local = await get('/api/bootstrap/local?key=customers');
      assert.equal(local.status, 200, JSON.stringify(local.json));
      assert.ok(
        Array.isArray(local.json?.customers),
        'an older client bundle still asks for the customers slice; it must keep answering'
      );
      assert.ok(typeof local.json?.dataVersion === 'number', 'slice responses must carry dataVersion');
    });

    test('a customer outside page 1 is still found by the picker search', { skip: skipNoDb }, async () => {
      const page = await get('/api/customers?query=V4A&page=1&pageSize=5');
      assert.equal(page.status, 200, JSON.stringify(page.json));
      assert.equal(page.json.data.length, 5, 'a picker page stays small');
      assert.ok(
        !page.json.data.some((r: any) => r.customerId === `${CODE_PREFIX}ZZZ`),
        'the fixture must actually live outside page 1 for this test to mean anything'
      );

      // What the picker does: a bounded contains search, not a directory read.
      const picked = await get('/api/customers?query=' + encodeURIComponent(`${CODE_PREFIX}ZZZ`) + '&page=1&pageSize=20');
      assert.equal(picked.status, 200, JSON.stringify(picked.json));
      assert.equal(picked.json.data.length, 1);
      assert.equal(picked.json.data[0].customerId, `${CODE_PREFIX}ZZZ`);
      assert.equal(picked.json.data[0].customerName, 'V4A Zulu Landline');
      assert.equal(picked.json.totalItems, 1, 'the aggregate must describe the search, not the directory');
    });

    test('a branch account cannot widen the search by omitting branchId', { skip: skipNoDb }, async () => {
      const unscoped = await get('/api/customers?query=V4A&pageSize=50', branchToken);
      assert.equal(unscoped.status, 403, 'an omitted branchId must not mean "the whole country"');
      assert.match(String(unscoped.json?.message || ''), /branch filter/i);

      const scoped = await get('/api/customers?query=V4A&branchId=' + BRANCH_A + '&pageSize=50', branchToken);
      assert.equal(scoped.status, 200, JSON.stringify(scoped.json));
      assert.equal(scoped.json.totalItems, 14, 'branch A has 13 + Zulu fixtures');
      for (const row of scoped.json.data) assert.equal(row.branchId, BRANCH_A, 'branch scope leaked a foreign row');
    });

    test('naming another branch is a 403, naming its own branch is fine', { skip: skipNoDb }, async () => {
      const forged = await get('/api/customers?query=V4A&branchId=' + BRANCH_B, branchToken);
      assert.equal(forged.status, 403, JSON.stringify(forged.json));

      const own = await get('/api/customers?query=V4A&branchId=' + BRANCH_A, branchToken);
      assert.equal(own.status, 200, JSON.stringify(own.json));
      assert.equal(own.json.totalItems, 14);
    });

    test('a multi-branch account reads each branch it names, and only those', { skip: skipNoDb }, async () => {
      const a = await get('/api/customers?query=V4A&branchId=' + BRANCH_A, multiToken);
      assert.equal(a.status, 200, JSON.stringify(a.json));
      assert.equal(a.json.totalItems, 14);

      const b = await get('/api/customers?query=V4A&branchId=' + BRANCH_B, multiToken);
      assert.equal(b.status, 200, JSON.stringify(b.json));
      assert.equal(b.json.totalItems, 2);
    });

    test('a global admin reads every branch, or one when it asks', { skip: skipNoDb }, async () => {
      const a = await get('/api/customers?query=V4A&branchId=' + BRANCH_A);
      assert.equal(a.status, 200);
      assert.equal(a.json.totalItems, 14);

      const b = await get('/api/customers?query=V4A&branchId=' + BRANCH_B);
      assert.equal(b.status, 200);
      assert.equal(b.json.totalItems, 2);

      const all = await get('/api/customers?query=V4A&pageSize=50');
      assert.equal(all.status, 200);
      assert.equal(all.json.totalItems, 16, 'a global role without a branch filter reads the whole scope');

      // The count-only read the demo-clear screen uses.
      const count = await get('/api/customers?page=1&pageSize=1');
      assert.equal(count.status, 200);
      assert.ok(Number.isInteger(count.json.totalItems) && count.json.totalItems >= 16);
    });
  });
});
