/**
 * GET /api/bootstrap must answer an UNUSABLE fiscal-year master honestly.
 *
 * The regression this pins: the handler resolved a fiscal year and then read
 * `selectedFiscalYear.id` unguarded, so whenever the fiscal-year master was
 * empty (or held no year flagged current) it threw a TypeError into its own
 * catch block — which retold it as
 *
 *     503 { message: 'PostgreSQL became unavailable while loading application data.' }
 *
 * The database was up the whole time. An operator following that message
 * restarts PostgreSQL, checks DSNs and reads connection logs for a fault that
 * is really "no fiscal year is flagged as current", which is fixed in the
 * Fiscal Year Closing Wizard (the screen that actually owns the fiscal-year
 * master — an earlier message named "Fiscal Year Management", a label the nav
 * has never shown). Two different problems deserve two different answers, and
 * the answer must never blame a subsystem that is healthy.
 *
 * PROVES, over real HTTP against a real PostgreSQL, in FOUR database states
 * this test controls:
 *   1. schema-only (fiscal_years empty)      -> 409, "No fiscal year is configured"
 *                                               and an explicit id -> 400 "does not exist"
 *   2. rows present, none flagged current    -> 409, "No fiscal year is flagged as current"
 *   3. one row flagged current               -> 200, the normal payload (the fix must not
 *                                               just trade one failure for another)
 *   4. an explicit non-current year          -> 200, still reporting which year is current
 * Every non-200 body is asserted to be free of the database-outage claim.
 *
 * Isolation: the whole test runs against a throwaway database
 * (`inventory_bootstrap_fy_test`) created from scripts/schema.sql and dropped
 * afterwards — the application database is never touched, and the fiscal-year
 * master it inspects is its own. DATABASE_URL is repointed at the throwaway
 * BEFORE the server modules are imported (dynamic import), which is the only
 * way to bind the module-level pool to it (see tests/requirePostgresGate.test.ts
 * for the same technique in the opposite direction).
 *
 * The empty-tables part matters: this database has the schema and nothing else,
 * so a green 200 here also proves the payload does not depend on seeded rows.
 * Skipped (not failed) when no PostgreSQL is reachable, like the repo's other
 * integration suites — EXCEPT when CREATE DATABASE fails on a reachable server,
 * which FAILS, because that would silently drop the only proof of this
 * behaviour.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { INITIAL_MASTER_FISCAL_YEARS } from '../server/src/config/seedData';

dotenv.config();

const ROOT = path.resolve('.');
const TEST_DB = 'inventory_bootstrap_fy_test';
/** The claim the handler used to make, and must never make here again. */
const DB_OUTAGE_CLAIM = /PostgreSQL (is unavailable|became unavailable)/;

const SUPER_USER = {
  id: 'fy-honesty-super', email: 'fy-honesty@example.com', name: 'FY Honesty',
  role: 'SUPER_ADMIN', branchId: 'WH001',
  allowedBranchIds: ['WH001'], canSwitchUser: false,
} as any;

/** Parse DATABASE_URL and swap the database for the throwaway one. */
function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe('GET /api/bootstrap: an unusable fiscal-year master is reported honestly', () => {
  let adminPool: pg.Pool | null = null; // connects to 'postgres' for CREATE/DROP
  let dbPool: pg.Pool | null = null; // connects to the throwaway test database
  let dbReachable = false;
  let server: http.Server | null = null;
  let port = 0;
  let token = '';
  /** fy-3 (2082-83) in the app's own master: the row the app seeds as current. */
  let seededCurrentId = '';
  /** fy-4 (2083-84): a real year that is NOT flagged current. */
  let nonCurrentId = '';

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

  /** Writes the fiscal-year master rows dbBoot seeds, with is_current forced off. */
  async function insertFiscalYearMaster(isCurrent: false): Promise<void> {
    for (const fy of INITIAL_MASTER_FISCAL_YEARS) {
      await dbPool!.query(
        `INSERT INTO fiscal_years (
           id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
         ON CONFLICT (id) DO UPDATE SET is_current = EXCLUDED.is_current`,
        [
          fy.id,
          fy.code,
          fy.startDateAD,
          fy.endDateAD,
          fy.startDateBS,
          fy.endDateBS,
          isCurrent && Boolean(fy.isCurrent),
          Boolean(fy.isClosed),
        ]
      );
    }
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

    // scripts/schema.sql and nothing else — the state CI creates, and the state
    // this test deliberately keeps empty of the fiscal-year master.
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

    const seededCurrent = INITIAL_MASTER_FISCAL_YEARS.find((fy) => fy.isCurrent);
    const nonCurrent = INITIAL_MASTER_FISCAL_YEARS.find((fy) => !fy.isCurrent);
    seededCurrentId = seededCurrent?.id || '';
    nonCurrentId = nonCurrent?.id || '';
    assert.ok(seededCurrentId && nonCurrentId, 'the app master must contain a current and a non-current year');

    // Repoint the server at the throwaway BEFORE it is imported: db.ts builds
    // its pool from DATABASE_URL at module load.
    process.env.DATABASE_URL = throwawayUrl;
    const { createApp, registerAllRoutes } = await import('../server/src/app');
    // The app's pool lives in this process and is pointed at the throwaway
    // database; it is closed in after(), and a client still attached to the
    // drop must not surface as an uncaughtException (see dbPool above).
    const serverDb = await import('../server/db');
    serverDb.realPoolInstance?.on?.('error', () => undefined);
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
    if (server) await new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server!.close(() => done());
    });
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

  describe('1. schema-only database (no fiscal-year master at all)', () => {
    test('the payload is refused with 409 — configuration, not a database outage', { skip: !process.env.DATABASE_URL }, async (t) => {
      if (!dbReachable) return t.skip('PostgreSQL not reachable — this proof requires a live server');
      const { status, json, body } = await get('/api/bootstrap');
      assert.equal(status, 409, `expected the honest 409, got ${status}: ${body.slice(0, 300)}`);
      assert.match(json?.message || '', /No fiscal year is configured/);
      assert.equal(json?.noCurrentFiscalYear, true, 'the body must flag the reason for a client to act on');
      assert.doesNotMatch(body, DB_OUTAGE_CLAIM, 'the database is up — it must never be blamed for this');
      assert.doesNotMatch(body, /became unavailable/);
    });

    test('an explicit fiscal-year id that does not exist is a 400, not a 409 or a 503', { skip: !process.env.DATABASE_URL }, async (t) => {
      if (!dbReachable) return t.skip('PostgreSQL not reachable');
      const { status, json, body } = await get('/api/bootstrap?fiscalYearId=fy-does-not-exist');
      assert.equal(status, 400, `expected 400 for a non-existent fiscal year, got ${status}: ${body.slice(0, 300)}`);
      assert.match(json?.message || '', /fy-does-not-exist/);
      assert.equal(json?.fiscalYearNotFound, true);
      assert.doesNotMatch(body, DB_OUTAGE_CLAIM);
    });
  });

  describe('2. fiscal-year master present, none flagged current', () => {
    test('still refused with 409, naming the ACTUAL remedy (flag a year as current)', { skip: !process.env.DATABASE_URL }, async (t) => {
      if (!dbReachable) return t.skip('PostgreSQL not reachable');
      await insertFiscalYearMaster(false);
      const rows = await dbPool!.query('SELECT count(*)::int AS n FROM fiscal_years');
      assert.equal(rows.rows[0].n, INITIAL_MASTER_FISCAL_YEARS.length, 'the master rows must exist for this case');

      const { status, json, body } = await get('/api/bootstrap');
      assert.equal(status, 409, `expected 409, got ${status}: ${body.slice(0, 300)}`);
      assert.match(json?.message || '', /No fiscal year is flagged as current/);
      assert.equal(json?.noCurrentFiscalYear, true);
      assert.match(
        json?.message || '',
        /Fiscal Year Closing Wizard/,
        'the message must name where it is fixed, using the label the sidebar actually shows'
      );
      // The reason the old text was wrong: it named "Fiscal Year Management", a
      // label that exists nowhere in the nav (the tab key with that name renders
      // Document Numbering Setup), so the operator had nowhere to go. Pin the
      // label against the sidebar itself, not against this file's prose.
      const sidebar = fs.readFileSync(
        path.resolve(process.cwd(), 'client', 'src', 'components', 'layout', 'Sidebar.tsx'),
        'utf8'
      );
      assert.match(
        sidebar,
        /label: 'Fiscal Year Closing Wizard'/,
        'the screen this message names must still exist in the sidebar under that label'
      );
      assert.doesNotMatch(
        json?.message || '',
        /Fiscal Year Management/,
        'never send an operator to a screen label the sidebar does not show'
      );
      assert.doesNotMatch(body, DB_OUTAGE_CLAIM, 'this is the exact body that used to claim PostgreSQL was down');
    });
  });

  describe('3. one fiscal year flagged current (the healthy state)', () => {
    test('the payload loads normally — 200 with the current year reported', { skip: !process.env.DATABASE_URL }, async (t) => {
      if (!dbReachable) return t.skip('PostgreSQL not reachable');
      await dbPool!.query('UPDATE fiscal_years SET is_current = TRUE WHERE id = $1', [seededCurrentId]);
      const seeded = INITIAL_MASTER_FISCAL_YEARS.find((fy) => fy.id === seededCurrentId)!;

      const { status, json, body } = await get('/api/bootstrap');
      assert.equal(status, 200, `expected the normal payload, got ${status}: ${body.slice(0, 300)}`);
      assert.equal(json?.financialSummary?.currentFiscalYear, seeded.code);
      assert.equal(json?.fiscalYears?.length, INITIAL_MASTER_FISCAL_YEARS.length);
      assert.ok(Array.isArray(json?.stock), 'the operational slices must be present');
      assert.ok(Array.isArray(json?.shipments));
      assert.ok(Array.isArray(json?.users));
      assert.equal(json?.postgresDatabaseStatus?.isConnected, true);
      // Unscoped-by-branch payloads must still be safe to cache privately.
      assert.match(json?.serverTime || '', /^\d{4}-\d{2}-\d{2}T/, 'serverTime must be an ISO timestamp');
    });
  });

  describe('4. an explicit non-current year', () => {
    test('scopes the payload to that year while still reporting which year is current', { skip: !process.env.DATABASE_URL }, async (t) => {
      if (!dbReachable) return t.skip('PostgreSQL not reachable');
      const current = INITIAL_MASTER_FISCAL_YEARS.find((fy) => fy.id === seededCurrentId)!;
      const other = INITIAL_MASTER_FISCAL_YEARS.find((fy) => fy.id === nonCurrentId)!;

      const { status, json, body } = await get(`/api/bootstrap?fiscalYearId=${other.id}`);
      assert.equal(status, 200, `expected a scoped payload, got ${status}: ${body.slice(0, 300)}`);
      assert.equal(
        json?.financialSummary?.currentFiscalYear,
        current.code,
        'an explicit past-year view must still report which year is current'
      );
      assert.ok(Array.isArray(json?.stock), 'the past-year view serves its opening-stock ledger from fiscal_year_opening_stock');
    });

    test('an explicit id that no longer exists is a 400 even while the master is usable', { skip: !process.env.DATABASE_URL }, async (t) => {
      if (!dbReachable) return t.skip('PostgreSQL not reachable');
      const { status, json, body } = await get('/api/bootstrap?fiscalYearId=fy-deleted-last-week');
      assert.equal(status, 400, `expected 400, got ${status}: ${body.slice(0, 300)}`);
      assert.equal(json?.fiscalYearNotFound, true);
      assert.doesNotMatch(body, DB_OUTAGE_CLAIM);
    });
  });
});
