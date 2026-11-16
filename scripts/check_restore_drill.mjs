#!/usr/bin/env node
/**
 * BAK-3 — disposable restore drill.
 *
 * Picks the newest verified BAK-1 backup (or --backup), creates a scratch
 * database with the source's locale/encoding, restores the archive, then
 * compares the manifest table counts and the posted ledger. The scratch
 * database is dropped in finally and on SIGINT/SIGTERM.
 *
 * Exit codes: 0 pass, 1 check failure, 2 preflight/setup failure.
 *
 *   node scripts/check_restore_drill.mjs [--backup <file>] [--no-manifest]
 *        [--json] [--keep-scratch]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
process.umask(0o077);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));

class DrillError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
const preflight = (message) => new DrillError(message, 2);
const check = (message) => new DrillError(message, 1);

function parseArgs(argv) {
  const out = { json: false, keepScratch: false, noManifest: false, backup: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--keep-scratch') out.keepScratch = true;
    else if (arg === '--no-manifest') out.noManifest = true;
    else if (arg === '--backup') {
      out.backup = argv[++i];
      if (!out.backup) throw preflight('--backup requires a file path');
    } else if (arg === '--help' || arg === '-h') out.help = true;
    else throw preflight(`unknown argument: ${arg}`);
  }
  return out;
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const baseOf = (artifact) =>
  artifact.endsWith('.dump.gpg') ? artifact.slice(0, -'.dump.gpg'.length) : artifact.slice(0, -'.dump'.length);
const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
const quoteLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

function sourceConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number.parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'inventory_db',
    user: process.env.POSTGRES_USER || 'inventory_user',
    password: process.env.POSTGRES_PASSWORD || 'securepassword',
  };
}

function adminConfig() {
  if (process.env.DRILL_ADMIN_URL) return { connectionString: process.env.DRILL_ADMIN_URL };
  return sourceConfig();
}

function targetUrl(name) {
  if (process.env.DATABASE_URL) {
    try {
      const url = new URL(process.env.DATABASE_URL);
      url.pathname = `/${name}`;
      return url.toString();
    } catch {
      throw preflight('DATABASE_URL is not a valid PostgreSQL URL.');
    }
  }
  return '';
}

function targetEnv(name) {
  if (process.env.DATABASE_URL) return { ...process.env };
  return { ...process.env, PGDATABASE: name };
}

function findNewestVerified() {
  const dir = process.env.BACKUP_DIR || path.join(ROOT, 'backups');
  if (!fs.existsSync(dir)) throw preflight(`BACKUP_DIR does not exist: ${dir}`);
  const candidates = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.dump') && !name.endsWith('.dump.gpg')) continue;
    const artifact = path.join(dir, name);
    const base = baseOf(artifact);
    const marker = `${base}.verified`;
    const manifest = `${base}.manifest.json`;
    if (fs.existsSync(marker) && fs.existsSync(manifest)) {
      candidates.push({ artifact, marker, mtime: fs.statSync(marker).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime || b.artifact.localeCompare(a.artifact));
  if (candidates.length === 0) {
    throw preflight(`no verified backup found in ${dir}; run "npm run backup" first.`);
  }
  return candidates[0].artifact;
}

function resolveKey(mode) {
  if (mode === 'gpg-passphrase') {
    const file = process.env.BACKUP_PASSPHRASE_FILE;
    if (!file) throw preflight('encrypted backup requires BACKUP_PASSPHRASE_FILE (or BACKUP_ENCRYPTION_KEY).');
    if (!fs.existsSync(file)) throw preflight(`BACKUP_PASSPHRASE_FILE is not readable: ${file}`);
    return { mode, file };
  }
  if (mode === 'gpg-env') {
    if (!process.env.BACKUP_ENCRYPTION_KEY) {
      throw preflight('encrypted backup requires BACKUP_ENCRYPTION_KEY or BACKUP_PASSPHRASE_FILE.');
    }
    return { mode, key: process.env.BACKUP_ENCRYPTION_KEY };
  }
  if (mode === 'gpg-recipient') return { mode };
  throw preflight(`unsupported encryption mode: ${mode}`);
}

function decryptArtifact(artifact, manifest, tempDir) {
  if (manifest?.encryption?.mode && manifest.encryption.mode !== 'none' && !artifact.endsWith('.dump.gpg')) {
    throw check(`plaintext artifact has manifest encryption mode '${manifest.encryption.mode}'.`);
  }
  let mode = manifest?.encryption?.mode;
  if (!mode) {
    if (!artifact.endsWith('.dump.gpg')) mode = 'none';
    else if (process.env.BACKUP_PASSPHRASE_FILE) mode = 'gpg-passphrase';
    else if (process.env.BACKUP_ENCRYPTION_KEY) mode = 'gpg-env';
    else mode = 'gpg-recipient';
  }
  if (mode === 'none') return artifact;
  if (!artifact.endsWith('.dump.gpg')) throw check(`artifact has encryption mode '${mode}' but is not .dump.gpg.`);

  const gpg = process.env.GPG || 'gpg';
  if (spawnSync(gpg, ['--version'], { encoding: 'utf8' }).status !== 0) {
    throw preflight(`${gpg} not found; install GnuPG to drill an encrypted backup.`);
  }
  const key = resolveKey(mode);
  const plain = path.join(tempDir, 'archive.dump');
  const args = ['--batch', '--yes', '--no-tty', '--decrypt', '--output', plain, artifact];
  let input;
  if (mode === 'gpg-passphrase') args.splice(3, 0, '--passphrase-file', key.file);
  else if (mode === 'gpg-env') {
    args.splice(3, 0, '--passphrase-fd', '0');
    input = key.key;
  }
  const result = spawnSync(gpg, args, { input, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    const hint = mode === 'gpg-recipient'
      ? 'provide the recipient private key (GNUPGHOME) or use a passphrase/env-key backup'
      : `check ${mode === 'gpg-passphrase' ? 'BACKUP_PASSPHRASE_FILE' : 'BACKUP_ENCRYPTION_KEY'}`;
    throw preflight(`could not decrypt ${path.basename(artifact)}: ${hint}.`);
  }
  fs.chmodSync(plain, 0o600);
  if (manifest?.plaintext_sha256 && sha256(plain) !== manifest.plaintext_sha256) {
    throw check(`decrypted archive checksum mismatch: expected ${manifest.plaintext_sha256}, got ${sha256(plain)}.`);
  }
  return plain;
}

async function connect(config, label) {
  const client = new pg.Client({ ...config, connectionTimeoutMillis: 10_000, max: 1 });
  try {
    await client.connect();
    return client;
  } catch (err) {
    await client.end().catch(() => {});
    throw preflight(`${label} is not reachable: ${err.message}`);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/check_restore_drill.mjs [--backup <file>] [--no-manifest] [--json] [--keep-scratch]');
    return 0;
  }

  const artifact = path.resolve(args.backup || findNewestVerified());
  if (!fs.existsSync(artifact)) throw preflight(`backup does not exist: ${artifact}`);
  if (!artifact.endsWith('.dump') && !artifact.endsWith('.dump.gpg')) {
    throw preflight(`backup must end in .dump or .dump.gpg: ${artifact}`);
  }
  const base = baseOf(artifact);
  const manifestPath = `${base}.manifest.json`;
  const checksumPath = `${base}.sha256`;
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = parseJson(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest) throw preflight(`manifest is not valid JSON: ${manifestPath}`);
  } else if (!args.noManifest) {
    throw preflight(`manifest does not exist: ${manifestPath}; pass --no-manifest to compare internal checks only.`);
  }
  if (fs.existsSync(checksumPath)) {
    const recorded = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
    const actual = sha256(artifact);
    if (!recorded || recorded !== actual) {
      throw check(`artifact checksum mismatch: expected ${recorded || '(empty)'}, got ${actual}.`);
    }
  }
  if (manifest?.sha256 && sha256(artifact) !== manifest.sha256) {
    throw check(`manifest SHA-256 does not match the artifact: ${manifest.sha256}.`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-drill-'));
  fs.chmodSync(tempDir, 0o700);
  let archive = artifact;
  let admin;
  let source;
  let target;
  let scratch = '';
  let dropFailed = false;
  let signalCode = 0;
  const started = Date.now();

  const dropScratch = async () => {
    if (!scratch || args.keepScratch) return true;
    // A pg_restore or target client can close its last socket a moment after
    // its process/promise completes. DROP ... WITH (FORCE) reports "permission
    // denied to terminate process" in that window (and can see a short-lived
    // autovacuum worker). Retry before declaring a failed cleanup; a scratch
    // database left behind is worse than a few hundred milliseconds of wait.
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(scratch)} WITH (FORCE)`);
        scratch = '';
        return true;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    dropFailed = true;
    console.error(`[drill] could not drop scratch database: ${lastError?.message || 'unknown error'}`);
    console.error(`[drill] run: DROP DATABASE IF EXISTS ${quoteIdent(scratch)} WITH (FORCE);`);
    return false;
  };

  const onSignal = async (signal, code) => {
    signalCode = code;
    await dropScratch();
    process.exit(code);
  };
  process.once('SIGINT', () => void onSignal('SIGINT', 130));
  process.once('SIGTERM', () => void onSignal('SIGTERM', 143));

  try {
    archive = decryptArtifact(artifact, manifest, tempDir);
    const list = spawnSync(process.env.PG_RESTORE || process.env.BACKUP_PG_RESTORE || 'pg_restore', ['--list', archive], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (list.status !== 0) throw check(`pg_restore --list rejected ${path.basename(artifact)}: ${list.stderr || list.stdout}`);

    admin = await connect(adminConfig(), 'drill admin connection');
    const role = await admin.query('SELECT current_user AS role, rolcreatedb FROM pg_roles WHERE rolname = current_user');
    if (!role.rows[0]?.rolcreatedb) {
      throw preflight(
        `role "${role.rows[0]?.role || 'unknown'}" cannot create databases. ` +
          `Run: ALTER ROLE ${quoteIdent(role.rows[0]?.role || 'inventory_user')} CREATEDB;`
      );
    }

    source = await connect(sourceConfig(), 'source database');
    const sourceDb = (await source.query('SELECT current_database() AS db')).rows[0].db;
    const locale = (
      await source.query(
        `SELECT datcollate, datctype, pg_encoding_to_char(encoding) AS encoding
         FROM pg_database WHERE datname = current_database()`
      )
    ).rows[0];
    if (!locale) throw preflight(`source database ${sourceDb} has no pg_database locale row.`);

    scratch = `inventory_drill_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
    await admin.query(
      `CREATE DATABASE ${quoteIdent(scratch)}
       WITH TEMPLATE template0
       ENCODING ${quoteLiteral(locale.encoding)}
       LC_COLLATE ${quoteLiteral(locale.datcollate)}
       LC_CTYPE ${quoteLiteral(locale.datctype)}`
    );

    const restoreArgs = ['--exit-on-error', '--no-owner', '--no-privileges'];
    const url = targetUrl(scratch);
    if (url) restoreArgs.push('--dbname', url);
    else restoreArgs.push('--dbname', scratch);
    restoreArgs.push(archive);
    const restore = spawnSync(
      process.env.PG_RESTORE || process.env.BACKUP_PG_RESTORE || 'pg_restore',
      restoreArgs,
      { encoding: 'utf8', env: targetEnv(scratch), timeout: 600_000 }
    );
    if (restore.status !== 0) {
      throw check(`pg_restore failed: ${(restore.stderr || restore.stdout || '').trim()}`);
    }

    target = await connect(
      url ? { connectionString: url } : { ...sourceConfig(), database: scratch },
      'restored target'
    );
    const tables = await target.query(`
      SELECT c.relname AS name,
             (xpath('/row/c/text()',
                    query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                                 false, true, '')))[1]::text::bigint AS rows
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY 1
    `);
    const actualTables = new Map(tables.rows.map((row) => [row.name, Number(row.rows)]));
    const problems = [];
    let tableComparison = 'skipped';
    if (manifest) {
      tableComparison = 'matched';
      const expected = new Map(manifest.tables.map((row) => [row.name, Number(row.rows)]));
      for (const [name, rows] of expected) {
        if (!actualTables.has(name)) problems.push(`missing table ${name} (expected ${rows})`);
        else if (actualTables.get(name) !== rows) {
          problems.push(`table ${name}: expected ${rows} rows, found ${actualTables.get(name)}`);
        }
      }
      for (const [name, rows] of actualTables) {
        if (!expected.has(name)) problems.push(`unexpected table ${name} (${rows} rows)`);
      }
    }

    const gl = (
      await target.query(fs.readFileSync(path.join(HERE, 'restore_checks.sql'), 'utf8'))
    ).rows[0];
    const num = (value) => Number(value);
    if (num(gl.debit) !== num(gl.credit)) problems.push(`GL debit ${gl.debit} != credit ${gl.credit}`);
    if (num(gl.net) !== 0) problems.push(`GL net is ${gl.net}, expected 0.00`);
    if (num(gl.imbalance_journals) !== 0) problems.push(`${gl.imbalance_journals} journal(s) do not balance`);
    if (num(gl.posted_imbalance_journals) !== 0) {
      problems.push(`${gl.posted_imbalance_journals} POSTED header(s) have unbalanced lines`);
    }
    if (manifest?.gl) {
      for (const key of ['debit', 'credit']) {
        if (num(gl[key]) !== num(manifest.gl[key])) problems.push(`GL ${key}: expected ${manifest.gl[key]}, found ${gl[key]}`);
      }
      if (num(gl.net) !== num(manifest.gl.net)) problems.push(`GL net: expected ${manifest.gl.net}, found ${gl.net}`);
      if (manifest.gl.checksum && gl.checksum !== manifest.gl.checksum) {
        problems.push(`GL checksum: expected ${manifest.gl.checksum}, found ${gl.checksum}`);
      }
    }

    const payload = {
      status: problems.length === 0 ? 'pass' : 'fail',
      backup: artifact,
      scratch,
      tableComparison,
      tableCount: actualTables.size,
      expectedTableCount: manifest ? manifest.table_count : null,
      gl: {
        debit: gl.debit,
        credit: gl.credit,
        net: gl.net,
        imbalanceJournals: gl.imbalance_journals,
        postedImbalanceJournals: gl.posted_imbalance_journals,
        checksum: gl.checksum,
      },
      problems: problems.slice(0, 10),
      elapsedMs: Date.now() - started,
    };
    if (args.json) console.log(JSON.stringify(payload));
    else {
      console.log(
        `[drill] ${scratch}: ${tableComparison === 'matched' ? `${actualTables.size}/${manifest.table_count} tables` : 'table comparison skipped'}; ` +
          `GL debit=${gl.debit} credit=${gl.credit} net=${gl.net} ` +
          `imbalances=${gl.imbalance_journals} posted-imbalances=${gl.posted_imbalance_journals}`
      );
      for (const problem of payload.problems) console.error(`[drill] MISMATCH: ${problem}`);
      if (problems.length > payload.problems.length) {
        console.error(`[drill] … +${problems.length - payload.problems.length} more mismatch(es)`);
      }
    }
    if (problems.length > 0) process.exitCode = 1;
    return process.exitCode || 0;
  } finally {
    if (target) await target.end().catch(() => {});
    if (source) await source.end().catch(() => {});
    if (admin) {
      if (args.keepScratch && scratch) console.error(`[drill] kept scratch database: ${scratch}`);
      else await dropScratch();
      await admin.end().catch(() => {});
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (dropFailed) process.exitCode = 1;
  }
}

try {
  const code = await run();
  if (process.exitCode === undefined) process.exitCode = code;
} catch (err) {
  const code = err instanceof DrillError ? err.exitCode : 2;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ status: code === 1 ? 'fail' : 'preflight_failed', error: err.message }));
  } else {
    console.error(`[drill:${code === 1 ? 'fail' : 'preflight'}] ${err.message}`);
  }
  process.exitCode = code;
}
