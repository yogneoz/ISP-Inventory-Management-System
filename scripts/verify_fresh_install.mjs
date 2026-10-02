/**
 * Fresh-install proof (duplication audit, phase 2 follow-up).
 *
 * Proves the claim "dbBoot.ts executes scripts/schema.sql as the single
 * schema source of truth" against a REAL server boot, not just by parsing
 * files (that static part lives in tests/schemaSource.parity.test.ts):
 *
 *   1. Creates two throwaway databases from the same PostgreSQL instance.
 *   2. `reference`  — scripts/schema.sql applied directly (what a
 *      `psql -f scripts/schema.sql` fresh install gets).
 *   3. `boot`       — left EMPTY, then the real server is booted against it
 *      (DATABASE_URL pointed at it), so dbBoot.ts loads and executes
 *      scripts/schema.sql itself, exactly like a production fresh install.
 *      Readiness is confirmed via GET /api/health.
 *   4. Compares the two runtime schemas exhaustively — tables, columns
 *      (exact types, nullability, defaults, identity/generated), constraints,
 *      indexes, triggers, sequences, views — and exits non-zero with a diff
 *      on any drift.
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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_SQL_PATH = path.join(ROOT, 'scripts', 'schema.sql');
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
// Schema snapshot: everything structural, normalized and sorted.
// ---------------------------------------------------------------------------

async function snapshotSchema(url) {
  return withClient(url, async (client) => {
    const q = async (sql) => (await client.query(sql)).rows;

    const tables = await q(`
      SELECT c.relname AS table_name, c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
      ORDER BY 1`);

    const columns = await q(`
      SELECT cls.relname AS table_name, attr.attname AS column_name,
             pg_catalog.format_type(attr.atttypid, attr.atttypmod) AS data_type,
             attr.attnotnull AS not_null,
             COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS column_default,
             attr.attidentity AS identity, attr.attgenerated AS generated
      FROM pg_attribute attr
      JOIN pg_class cls ON cls.oid = attr.attrelid
      JOIN pg_namespace n ON n.oid = cls.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = attr.attrelid AND d.adnum = attr.attnum
      WHERE n.nspname = 'public' AND cls.relkind IN ('r', 'p')
        AND attr.attnum > 0 AND NOT attr.attisdropped
      ORDER BY cls.relname, attr.attnum`);

    const constraints = await q(`
      SELECT cls.relname AS table_name, con.conname, con.contype,
             pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY 1, 2`);

    const indexes = await q(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes WHERE schemaname = 'public'
      ORDER BY 1, 2`);

    const triggers = await q(`
      SELECT cls.relname AS table_name, trg.tgname,
             pg_get_triggerdef(trg.oid) AS def
      FROM pg_trigger trg
      JOIN pg_class cls ON cls.oid = trg.tgrelid
      JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE n.nspname = 'public' AND NOT trg.tgisinternal
      ORDER BY 1, 2`);

    const sequences = await q(`
      SELECT sequencename, data_type, start_value, increment_by, min_value,
             max_value, cycle
      FROM pg_sequences WHERE schemaname = 'public'
      ORDER BY 1`);

    const views = await q(`
      SELECT viewname, regexp_replace(definition, '\\s+', ' ', 'g') AS definition
      FROM pg_views WHERE schemaname = 'public'
      ORDER BY 1`);

    return { tables, columns, constraints, indexes, triggers, sequences, views };
  });
}

function renderRows(rows) {
  return rows.map((r) => JSON.stringify(r)).sort();
}

function diffCategory(label, refRows, bootRows, diffs) {
  const ref = renderRows(refRows);
  const boot = renderRows(bootRows);
  const onlyRef = ref.filter((r) => !boot.includes(r));
  const onlyBoot = boot.filter((r) => !ref.includes(r));
  if (onlyRef.length === 0 && onlyBoot.length === 0) {
    log(`  ✓ ${label}: identical (${ref.length} entries)`);
    return;
  }
  diffs.push({ label, onlyRef, onlyBoot });
  log(`  ✗ ${label}: ${onlyRef.length} missing / ${onlyBoot.length} extra`);
  for (const r of onlyRef.slice(0, 10)) log(`      only in reference : ${r}`);
  for (const r of onlyBoot.slice(0, 10)) log(`      only in booted DB: ${r}`);
  if (onlyRef.length > 10 || onlyBoot.length > 10) log('      … (truncated)');
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

  log('applying scripts/schema.sql directly to the reference database…');
  await withClient(referenceUrl, (client) => client.query(schemaSql));

  log(`booting the real server on port ${BOOT_PORT} against the empty "${BOOT_DB}"…`);
  booted = bootServerOnBootDb();
  await waitForHealth(booted.exited, booted.getOutput);
  log('server booted and healthy — dbBoot executed schema.sql itself');

  log('comparing runtime schemas…');
  const ref = await snapshotSchema(referenceUrl);
  const boot = await snapshotSchema(bootUrl);

  const diffs = [];
  diffCategory('tables', ref.tables, boot.tables, diffs);
  diffCategory('columns', ref.columns, boot.columns, diffs);
  diffCategory('constraints', ref.constraints, boot.constraints, diffs);
  diffCategory('indexes', ref.indexes, boot.indexes, diffs);
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
    log('PASS — fresh-install runtime schema is identical to scripts/schema.sql');
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
