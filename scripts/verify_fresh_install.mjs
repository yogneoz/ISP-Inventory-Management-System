/**
 * Fresh-install proof (duplication audit, phase 2 follow-up).
 *
 * Proves the fresh-install schema path against a REAL server boot, not just by
 * parsing files (that static part lives in tests/schemaSource.parity.test.ts):
 *
 *   1. Creates two throwaway databases from the same PostgreSQL instance.
 *   2. `reference`  — scripts/schema.sql plus numbered scripts/migrations/*.sql
 *      applied directly, then the documented partition provisioning
 *      (`scripts/check_partitions.ts --apply`), which is what a psql-style
 *      fresh install gets. The monthly ledger children are runtime DDL by
 *      design — their names depend on the calendar — so the reference side must
 *      be provisioned too, or the guard would report them as drift every month
 *      and could never pass. Both sides go through the SAME provisioning module,
 *      so a change in a child's shape still fails here.
 *   3. `boot`       — left EMPTY, then the real server is booted against it
 *      (DATABASE_URL pointed at it), so dbBoot.ts loads and executes
 *      scripts/schema.sql itself, exactly like a production fresh install.
 *      Readiness is confirmed via GET /api/health.
 *   4. Compares the two runtime schemas exhaustively — tables, columns
 *      (exact types, nullability, defaults, identity/generated), constraints,
 *      indexes, storage parameters (`reloptions`: fillfactor, autovacuum, BRIN
 *      pages_per_range), triggers, sequences, views — and exits non-zero with a
 *      diff on any drift.
 *
 * Requires the connecting role to have CREATEDB (scripts/setup_postgres.sh
 * grants it). Both throwaway databases are dropped again in a finally block.
 *
 * Usage:  node scripts/verify_fresh_install.mjs
 * Env:    FRESH_INSTALL_ADMIN_URL (default: DATABASE_URL, then the local
 *         development credentials). PORT_TO_BOOT overrides the port the
 *         throwaway server binds (default 3557).
 */
import pg from 'pg';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { diffRows, renderRows, snapshotSchema as snapshotSchemaRows } from './schemaSnapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_SQL_PATH = path.join(ROOT, 'scripts', 'schema.sql');
const MIGRATIONS_DIR = path.join(ROOT, 'scripts', 'migrations');
const BOOT_PORT = Number(process.env.PORT_TO_BOOT || 3557);
const BOOT_TIMEOUT_MS = 120_000;

const adminBaseUrl =
  process.env.FRESH_INSTALL_ADMIN_URL ||
  process.env.DATABASE_URL ||
  'postgres://inventory_user:securepassword@localhost:5432/inventory_db';

const REFERENCE_DB = 'inventory_fresh_reference';
const BOOT_DB = 'inventory_fresh_boot';

const referenceUrl = setDbName(adminBaseUrl, REFERENCE_DB);
const bootUrl = setDbName(adminBaseUrl, BOOT_DB);
const adminUrl = setDbName(adminBaseUrl, 'postgres');

function setDbName(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function log(msg) {
  console.log(`[fresh-install] ${msg}`);
}

/** Numbered migrations are part of a fresh install, after the baseline. */
function loadMigrationSql() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(admin, dbName) {
  // Terminate lingering backends first (a database owner cannot use
  // DROP ... WITH (FORCE) to terminate backends of other roles in every
  // setup — and the booted server's pool may outlive child.kill() briefly).
  await admin
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    )
    .catch(() => {});
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  }
}

async function recreateDatabase(admin, dbName) {
  await dropDatabase(admin, dbName);
  await admin.query(`CREATE DATABASE "${dbName}"`);
}

// ---------------------------------------------------------------------------
// Schema snapshot: imported from scripts/schemaSnapshot.mjs so the guard’s
// decision logic is testable (worklist A6). `storage` carries reloptions —
// fillfactor, autovacuum and BRIN pages_per_range — which pg_indexes.indexdef
// does not, so index and table storage tuning is now compared too.
// ---------------------------------------------------------------------------

async function snapshotSchema(url) {
  return withClient(url, (client) => snapshotSchemaRows(client));
}

function diffCategory(label, refRows, bootRows, diffs) {
  const { onlyRef, onlyBoot } = diffRows(refRows, bootRows);
  if (onlyRef.length === 0 && onlyBoot.length === 0) {
    log(`  ✓ ${label}: identical (${renderRows(refRows).length} entries)`);
    return;
  }
  diffs.push({ label, onlyRef, onlyBoot });
  log(`  ✗ ${label}: ${onlyRef.length} missing / ${onlyBoot.length} extra`);
  for (const r of onlyRef.slice(0, 10)) log(`      only in reference : ${r}`);
  for (const r of onlyBoot.slice(0, 10)) log(`      only in booted DB: ${r}`);
  if (onlyRef.length > 10 || onlyBoot.length > 10) log("      … (truncated)");
}

// ---------------------------------------------------------------------------
// Server boot
// ---------------------------------------------------------------------------

function resolveTsxCli() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('tsx/cli');
  } catch {
    return path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }
}

function bootServerOnBootDb() {
  const child = spawn(
    process.execPath,
    [resolveTsxCli(), path.join('server', 'index.ts')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: bootUrl,
        PORT: String(BOOT_PORT),
        // Production: skip the Vite middleware dev branch; we only need boot.
        NODE_ENV: 'production',
        // A production boot now requires Redis, so this real boot needs a live
        // server too; CI supplies the service container's URL.
        REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
        // The auth-secret guard (server/src/boot/authSecret.ts) refuses to
        // start production without a usable secret. This probe is about schema
        // and boot, so it gets a throwaway ≥32-character value — never used
        // outside this child process.
        AUTH_TOKEN_SECRET: 'fresh-install-verify-only-secret-0123456789abcdef',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Hide the console window on Windows.
      windowsHide: true,
    }
  );
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) =>
    child.on('exit', (code) => resolve({ code }))
  );
  return { child, getOutput: () => output, exited };
}

/**
 * Provision the reference database's journal month partitions with the same
 * module the server boots with (never a second copy of the window logic).
 */
async function provisionReferencePartitions() {
  const child = spawn(
    process.execPath,
    [resolveTsxCli(), path.join('scripts', 'check_partitions.ts'), '--apply'],
    {
      cwd: ROOT,
      // dotenv does not override an explicit DATABASE_URL, so this targets the
      // throwaway reference database and never the developer's own.
      env: { ...process.env, DATABASE_URL: referenceUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== 0) {
    throw new Error(
      `check_partitions --apply failed on the reference database (exit ${code}).\n${output.slice(-2000)}`
    );
  }
  log('reference database provisioned with the same journal partition window');
}

async function waitForHealth(exited, getOutput) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const done = await Promise.race([
      exited.then((e) => e),
      new Promise((r) => setTimeout(() => r(null), 500)),
    ]);
    if (done) {
      throw new Error(
        `Server exited (code ${done.code}) before becoming healthy.\n${getOutput().slice(-4000)}`
      );
    }
    try {
      const res = await fetch(`http://localhost:${BOOT_PORT}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
  }
  throw new Error(
    `Server did not become healthy within ${BOOT_TIMEOUT_MS / 1000}s.\n${getOutput().slice(-4000)}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const schemaSql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
const migrations = loadMigrationSql();
const admin = new pg.Client({ connectionString: adminUrl });
// `booted` is assigned inside the try — the server must only be spawned AFTER
// the throwaway databases exist, otherwise a fast tsx boot connects to a
// database that does not exist yet.
let booted;

try {
  log(`connecting admin user to ${new URL(adminUrl).host}…`);
  await admin.connect();
  await recreateDatabase(admin, REFERENCE_DB);
  await recreateDatabase(admin, BOOT_DB);
  log(`throwaway databases "${REFERENCE_DB}" (psql-style) and "${BOOT_DB}" (server boot) created`);

  log(
    `applying scripts/schema.sql and ${migrations.length} numbered migration(s) directly to the reference database…`
  );
  await withClient(referenceUrl, async (client) => {
    await client.query(schemaSql);
    for (const migration of migrations) await client.query(migration.sql);
  });
  await provisionReferencePartitions();

  log(`booting the real server on port ${BOOT_PORT} against the empty "${BOOT_DB}"…`);
  booted = bootServerOnBootDb();
  await waitForHealth(booted.exited, booted.getOutput);
  log('server booted and healthy — dbBoot verified the baseline and pending migrations');

  // This is a NODE_ENV=production boot, and production refuses to start without
  // Redis; "healthy" alone would also be true of a boot that merely accepted the
  // variable. Require the shared-state module's own line, so a boot that never
  // connected (or one that quietly ran on the in-process store again) fails here
  // instead of passing on an HTTP 200.
  const sharedStateLine = booted
    .getOutput()
    .split('\n')
    .find((line) => line.includes('Shared state connected (Redis)'));
  if (!sharedStateLine) {
    throw new Error(
      'the booted server never logged "Shared state connected (Redis)" — the production boot did not use the ' +
        'Redis URL this harness supplied.\n' +
        booted.getOutput().slice(-4000)
    );
  }
  log(`server booted with shared state: ${sharedStateLine.trim()}`);

  log('comparing runtime schemas…');
  const ref = await snapshotSchema(referenceUrl);
  const boot = await snapshotSchema(bootUrl);

  const diffs = [];
  diffCategory('tables', ref.tables, boot.tables, diffs);
  diffCategory('columns', ref.columns, boot.columns, diffs);
  diffCategory('constraints', ref.constraints, boot.constraints, diffs);
  diffCategory('indexes', ref.indexes, boot.indexes, diffs);
  // A6: pg_indexes.indexdef has no storage parameters, so without this category
  // a fresh install and a booted install could disagree on fillfactor or on
  // BRIN's pages_per_range with the guard still green.
  diffCategory('storage', ref.storage, boot.storage, diffs);
  diffCategory('triggers', ref.triggers, boot.triggers, diffs);
  diffCategory('sequences', ref.sequences, boot.sequences, diffs);
  diffCategory('views', ref.views, boot.views, diffs);

  if (diffs.length > 0) {
    console.error(
      '\n[fresh-install] SCHEMA DRIFT DETECTED — what dbBoot produces on a fresh ' +
        'install does not match scripts/schema.sql.\n' +
        'The server boot (or a runtime migration) is applying DDL that scripts/schema.sql ' +
        'does not declare (or vice versa). Update scripts/schema.sql to match, or remove ' +
        'the runtime DDL.'
    );
    process.exitCode = 1;
  } else {
    log('PASS — fresh-install runtime schema is identical to schema.sql plus numbered migrations');
  }
} catch (err) {
  console.error(`\n[fresh-install] FAILED: ${err?.message || err}`);
  const out = booted ? booted.getOutput() : '';
  if (out) console.error(`--- server output (last 4000 chars) ---\n${out.slice(-4000)}`);
  process.exitCode = 1;
} finally {
  if (booted) {
    booted.child.kill();
    // Give the server a moment to release its pool connections before dropping.
    await Promise.race([booted.exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  try {
    await dropDatabase(admin, REFERENCE_DB);
    await dropDatabase(admin, BOOT_DB);
    log('throwaway databases dropped');
  } catch (cleanupErr) {
    log(`warning: cleanup failed (${cleanupErr?.message || cleanupErr})`);
  }
  await admin.end().catch(() => {});
}
