/**
 * The post-demo-clear journey, end to end: a database with a schema and no
 * fiscal years must refuse honestly, the screen the refusal names must be able
 * to fix it, and the FIRST year created must become the active one — otherwise
 * the app keeps refusing with "no fiscal year is flagged as current" and the
 * operator has no way forward.
 *
 * This is the state `POST /api/admin/clear-demo-data` leaves behind in
 * production: demo fiscal years are deleted (only demo-flagged rows), so a
 * fresh install ends up with zero years and must be walked into creating its
 * own. Before this rule, `POST /api/fiscal-years` inserted `is_current = FALSE`
 * unconditionally, so creating the year still left every bootstrap refused:
 * the remedy the 409 named did not, by itself, unblock the app.
 *
 * PROVES, against a real PostgreSQL (throwaway database built from
 * scripts/schema.sql, never the application database):
 *   1. schema-only: GET /api/bootstrap -> 409 "No fiscal year is configured"
 *      and the message names the screen that can actually create one
 *   2. POST /api/fiscal-years (the remedy) -> 201 with isCurrent TRUE on the
 *      FIRST year, because no year was active
 *   3. the very next GET /api/bootstrap -> 200, reporting that year as current
 *   4. a SECOND year never steals the flag (an existing choice is respected)
 *   5. an overlapping period is still refused with the overlap message
 *
 * The controller is called directly so the test exercises the real DB path
 * without re-proving the permission middleware (covered elsewhere). Skipped —
 * not failed — when PostgreSQL is unreachable, like the repo's other
 * integration suites.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const ROOT = path.resolve('.');
const TEST_DB = 'inventory_fy_first_creation_test';

const SUPER_USER = {
  id: 'fy-first-super',
  email: 'fy-first@example.com',
  name: 'FY First',
  role: 'SUPER_ADMIN',
  branchId: 'WH001',
  allowedBranchIds: ['WH001'],
  canSwitchUser: false,
} as any;

/** Parse DATABASE_URL and swap the database for the throwaway one. */
function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function fakeRes() {
  const out: any = { statusCode: 200, body: null };
  out.status = (code: number) => {
    out.statusCode = code;
    return out;
  };
  out.json = (payload: any) => {
    out.body = payload;
    return out;
  };
  return out;
}

describe('first fiscal year creation unblocks the app (post-demo-clear journey)', () => {
  let adminPool: pg.Pool | null = null; // connects to 'postgres' for CREATE/DROP
  let dbPool: pg.Pool | null = null; // connects to the throwaway database
  let dbReachable = false;
  let server: http.Server | null = null;
  let port = 0;
  let token = '';
  let postFiscalYears: (req: any, res: any) => Promise<any>;

  async function get(urlPath: string): Promise<{ status: number; json: any; body: string }> {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      headers: { authorization: 'Bearer ' + token },
    });
    const body = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* a non-JSON body is itself a finding; the raw text is returned */
    }
    return { status: res.status, json, body };
  }

  async function createYear(period: {
    code: string;
    startDateAD: string;
    endDateAD: string;
    startDateBS: string;
    endDateBS: string;
  }) {
    const res = fakeRes();
    await postFiscalYears({ body: period, headers: {}, user: SUPER_USER }, res);
    return res;
  }

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) return;
    const throwawayUrl = withDbName(base, TEST_DB);
    try {
      adminPool = new pg.Pool({
        connectionString: withDbName(base, 'postgres'),
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      adminPool.on('error', () => undefined);
      await adminPool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
      if (adminPool) await adminPool.end();
      adminPool = null;
      return;
    }

    // A stale throwaway from an earlier run can hold connections; nothing else
    // owns this database, so terminate and recreate it.
    await adminPool
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB]
      )
      .catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await adminPool.query(`CREATE DATABASE ${TEST_DB}`);

    // scripts/schema.sql and nothing else: no fiscal years, no calendar rows —
    // the state a clean install (or a cleared demo) starts from.
    const schemaClient = new pg.Client({ connectionString: throwawayUrl });
    await schemaClient.connect();
    try {
      await schemaClient.query(fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8'));
    } finally {
      await schemaClient.end();
    }

    dbPool = new pg.Pool({ connectionString: throwawayUrl, max: 4, connectionTimeoutMillis: 5000 });
    // Teardown drops this database. An idle client still attached when that
    // happens receives "terminating connection due to administrator command",
    // and pg reports it as an 'error' event on the pool: unhandled, node turns
    // it into an uncaughtException that fails the whole file even though every
    // test passed. These errors are expected here, so they are absorbed; a
    // failing query still rejects normally during the tests.
    dbPool.on('error', () => undefined);

    // Repoint the server at the throwaway BEFORE it is imported: db.ts builds
    // its pool from DATABASE_URL at module load.
    process.env.DATABASE_URL = throwawayUrl;
    const { createApp, registerAllRoutes } = await import('../server/src/app');
    // Establish the precondition the running app always has — a reachable pool —
    // because the guarded pgPool throws "PostgreSQL is not connected" until
    // something pings it (the request middleware normally does). Deliberately
    // NOT the boot sync: syncDatabaseAndIndexes seeds fy-1..fy-4, and this test
    // needs a database with no fiscal years at all.
    const { ensurePostgresConnection, realPoolInstance } = await import('../server/db');
    // The app's pool lives in this process and is pointed at the throwaway
    // database; it is closed in after(), and a client still attached to the
    // drop must not surface as an uncaughtException (see dbPool above).
    realPoolInstance?.on?.('error', () => undefined);
    assert.equal(await ensurePostgresConnection(), true, 'the throwaway database must be reachable');
    ({ post_fiscalYears: postFiscalYears } = await import('../server/src/controllers/admin.controller'));
    // GET /api/bootstrap is authenticated once the database layer is live, so the
    // request needs a real token — a super-admin one, like the operator this
    // journey is about (an unauthenticated call is a 401, not the fiscal-year
    // reason, and asserting the wrong reason would prove nothing).
    const { issueAuthToken } = await import('../server/src/middleware/auth');
    token = issueAuthToken(SUPER_USER);

    const app = createApp();
    registerAllRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server!.address() as any).port;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server!.close(() => done());
      });
    }
    // The server's pool holds a connection to the throwaway: ending it first
    // keeps the DROP from waiting on a backend.
    try {
      const db = await import('../server/db');
      if (db.realPoolInstance) await db.realPoolInstance.end();
    } catch {
      /* best effort — the DROP below forces the issue if this fails */
    }
    if (dbPool) await dbPool.end();
    if (adminPool && dbReachable) {
      // Both pools are closed, so a plain DROP should find no backends. Only a
      // client that raced the shutdown needs terminating; doing it on the
      // common path is what used to kill an idle client mid-teardown.
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      } catch {
        await adminPool
          .query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [TEST_DB]
          )
          .catch(() => undefined);
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => undefined);
      }
    }
    if (adminPool) await adminPool.end();
  });

  test('schema-only database: bootstrap refuses and names the screen that fixes it', { skip: !process.env.DATABASE_URL }, async (t) => {
    if (!dbReachable) return t.skip('PostgreSQL not reachable');
    const empty = await dbPool!.query('SELECT count(*)::int AS n FROM fiscal_years');
    assert.equal(empty.rows[0].n, 0, 'this case must start from a database with no fiscal years at all');
    const { status, json } = await get('/api/bootstrap');
    assert.equal(status, 409, `expected the honest 409, got ${status}`);
    assert.equal(json?.noCurrentFiscalYear, true, 'the body must flag the reason for a client to act on');
    assert.match(json?.message || '', /No fiscal year is configured/);
    assert.match(
      json?.message || '',
      /Fiscal Year Closing Wizard/,
      'the operator must be sent to the screen that owns the fiscal-year form'
    );
  });

  test('the FIRST year created becomes current, and the next bootstrap loads', { skip: !process.env.DATABASE_URL }, async (t) => {
    if (!dbReachable) return t.skip('PostgreSQL not reachable');
    // The Nepali fiscal year runs Shrawan 1 -> Ashadh end, so this period is
    // 2084-04-01 BS .. 2085-03-31 BS (Ashadh 2085 has 31 days).
    const created = await createYear({
      code: '2084-85',
      startDateAD: '2027-07-17',
      endDateAD: '2028-07-15',
      startDateBS: '2084-04-01 BS',
      endDateBS: '2085-03-31 BS',
    });
    assert.equal(created.statusCode, 201, `expected 201, got ${created.statusCode}: ${JSON.stringify(created.body)}`);
    assert.equal(created.body.code, '2084-85');
    assert.equal(
      created.body.isCurrent,
      true,
      'with no year active, the year just created IS the active year — otherwise the remedy leaves the app refused'
    );

    // The whole point: the remedy the 409 named now makes the app load.
    const bootstrap = await get('/api/bootstrap');
    assert.equal(bootstrap.status, 200, `bootstrap must load after the fix: ${bootstrap.body.slice(0, 300)}`);
    assert.equal(bootstrap.json?.financialSummary?.currentFiscalYear, '2084-85');
  });

  test('a SECOND year never steals the active flag', { skip: !process.env.DATABASE_URL }, async (t) => {
    if (!dbReachable) return t.skip('PostgreSQL not reachable');
    const created = await createYear({
      code: '2085-86',
      startDateAD: '2028-07-16',
      endDateAD: '2029-07-15',
      startDateBS: '2085-04-01 BS',
      endDateBS: '2086-03-31 BS',
    });
    assert.equal(created.statusCode, 201, `expected 201, got ${created.statusCode}: ${JSON.stringify(created.body)}`);
    assert.equal(created.body.isCurrent, false, 'an existing active year is a decision, not an accident to override');

    const rows = await dbPool!.query('SELECT code FROM fiscal_years WHERE is_current = TRUE ORDER BY code');
    assert.deepEqual(rows.rows.map((r: any) => r.code), ['2084-85'], 'exactly one year stays active');
  });

  test('an overlapping period is still refused, naming the year it would overlap', { skip: !process.env.DATABASE_URL }, async (t) => {
    if (!dbReachable) return t.skip('PostgreSQL not reachable');
    const res = await createYear({
      code: '2084-85-B',
      startDateAD: '2028-01-01',
      endDateAD: '2028-12-31',
      startDateBS: '2084-09-17 BS',
      endDateBS: '2085-08-16 BS',
    });
    assert.equal(res.statusCode, 409, 'an overlapping period must not create a second owner for the same days');
    assert.match(res.body.message || '', /overlaps with FY/);
  });
});
