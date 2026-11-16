/**
 * BAK-2 — verified PostgreSQL restore.
 *
 * These invoke the real `bash scripts/restore.sh` and use disposable scratch
 * databases created/dropped by the test. They cover the acceptance path and
 * the destructive guards: a plain restore, live-database refusal before any
 * connection, non-empty refusal/--force, a corrupted artifact with no partial
 * restore, --list, --dry-run and an encrypted round-trip.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const ROOT = path.resolve('.');
const RESTORE = path.join(ROOT, 'scripts', 'restore.sh');
const BACKUP = path.join(ROOT, 'scripts', 'backup.sh');
const PG_DUMP = process.env.BACKUP_PG_DUMP || 'pg_dump';
const PG_RESTORE = process.env.BACKUP_PG_RESTORE || 'pg_restore';
const hasTool = (cmd: string): boolean =>
  spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const skipTools = hasTool(PG_DUMP) && hasTool(PG_RESTORE)
  ? false
  : 'needs pg_dump and pg_restore on PATH';
const skipGpg = hasTool('gpg') ? false : 'needs gpg for the encrypted restore test';

const baseUrl = process.env.DATABASE_URL || '';
function adminUrl(): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    url.pathname = '/postgres';
    return url.toString();
  } catch {
    return undefined;
  }
}
function targetUrl(name: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

const adminPool = new pg.Pool({
  connectionString: adminUrl(),
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number.parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: 'postgres',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
  max: 1,
  connectionTimeoutMillis: 3000,
});

let liveDb = '';
let liveTableCount = 0;
let dbReachable = false;
let artifact = '';
let manifest: any = null;
let tempDir = '';
let encryptedDir = '';
let encryptedArtifact = '';
let encryptedPassphrase = '';


try {
  await adminPool.query('SELECT 1');
  liveDb = new URL(baseUrl).pathname.replace(/^\//, '') || process.env.POSTGRES_DB || 'inventory_db';
  dbReachable = true;
} catch {
  dbReachable = false;
}
const skipNoDb = dbReachable ? false : 'needs a reachable PostgreSQL';

before(() => {
  if (skipTools || skipNoDb) return;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-restore-'));
  const result = spawnSync('bash', [BACKUP], {
    cwd: ROOT,
    env: {
      ...process.env,
      BACKUP_DIR: tempDir,
      BACKUP_PG_DUMP: PG_DUMP,
      BACKUP_PG_RESTORE: PG_RESTORE,
      BACKUP_RETENTION_DAYS: '30',
      BACKUP_MONTHLY_KEEP: '12',
      BACKUP_GPG_RECIPIENT: '',
      BACKUP_PASSPHRASE_FILE: '',
      BACKUP_ENCRYPTION_KEY: '',
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`backup fixture failed:\n${result.stdout}\n${result.stderr}`);
  artifact = path.join(
    tempDir,
    fs.readdirSync(tempDir).find((name) => name.endsWith('.dump')) || ''
  );
  manifest = JSON.parse(
    fs.readFileSync(path.join(tempDir, fs.readdirSync(tempDir).find((name) => name.endsWith('.manifest.json')) || ''), 'utf8')
  );
  liveDb = manifest.database || liveDb;
  liveTableCount = manifest.table_count;
});

after(async () => {
  await adminPool.end().catch(() => {});
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (encryptedDir) fs.rmSync(encryptedDir, { recursive: true, force: true });
});

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runRestore(target: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [RESTORE, artifact, '--target', target, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      BACKUP_DIR: tempDir,
      BACKUP_PG_DUMP: PG_DUMP,
      BACKUP_PG_RESTORE: PG_RESTORE,
      BACKUP_PASSPHRASE_FILE: '',
      BACKUP_ENCRYPTION_KEY: '',
      ...env,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function createScratch(): Promise<string> {
  // Random, not just a per-file counter: a stale run or another worker must
  // never be able to drop a name this test is about to query.
  const name = `inventory_bak2_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  return name;
}

async function dropScratch(name: string): Promise<void> {
  // A child pg_restore/verify process can still be closing its socket when
  // the test reaches cleanup; FORCE succeeds once that backend is gone.
  let lastError: unknown = null;
  // Under the full parallel suite another backend can still be exiting while
  // we clean up; FORCE then answers 42501 (permission denied to terminate
  // process) until that backend clears. Give it a bounded longer window.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function tableCount(name: string): Promise<number> {
  const pool = new pg.Pool({
    connectionString: targetUrl(name),
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number.parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: name,
    user: process.env.POSTGRES_USER || 'inventory_user',
    password: process.env.POSTGRES_PASSWORD || 'securepassword',
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  try {
    const result = await pool.query(`
      SELECT count(*)::int AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    `);
    return result.rows[0].n;
  } finally {
    await pool.end().catch(() => {});
  }
}

describe('BAK-2 restore script', () => {
  test('restores a real backup into a scratch database and verifies it', { skip: skipTools || skipNoDb }, async () => {
    const target = await createScratch();
    try {
      const result = runRestore(target, ['--yes']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(manifest.table_count, liveTableCount);
      assert.match(result.stdout, new RegExp(`${manifest.table_count}/${manifest.table_count} tables checked`));
      assert.equal(await tableCount(target), liveTableCount);
      assert.equal(await tableCount(liveDb), liveTableCount, 'the source database must be untouched');
    } finally {
      await dropScratch(target);
    }
  });

  test('refuses the configured live database without --yes, before connecting', { skip: skipTools || skipNoDb }, () => {
    const deadUrl = (() => {
      try {
        const url = new URL(baseUrl);
        url.port = '1';
        return url.toString();
      } catch {
        return baseUrl;
      }
    })();
    const result = runRestore(liveDb, [], { DATABASE_URL: deadUrl });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /without --yes/);
    assert.doesNotMatch(result.stderr, /is not reachable/, 'the refusal must happen before a connection attempt');
  });

  test('refuses a non-empty target without --force, then accepts --force', { skip: skipTools || skipNoDb }, async () => {
    const target = await createScratch();
    try {
      assert.equal(runRestore(target, ['--yes']).status, 0);
      const refused = runRestore(target, ['--yes']);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /non-empty/);
      assert.equal(await tableCount(target), liveTableCount);

      const forced = runRestore(target, ['--yes', '--force']);
      assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
      assert.equal(await tableCount(target), liveTableCount);
    } finally {
      await dropScratch(target);
    }
  });

  test('a corrupted artifact fails checksum validation and performs no partial restore', { skip: skipTools || skipNoDb }, async () => {
    const target = await createScratch();
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-restore-corrupt-'));
    const originalArtifact = artifact;
    try {
      const base = path.basename(artifact, '.dump');
      const copy = path.join(corruptDir, `${base}.dump`);
      fs.copyFileSync(artifact, copy);
      for (const suffix of ['.manifest.json', '.sha256']) {
        fs.copyFileSync(path.join(tempDir, `${base}${suffix}`), path.join(corruptDir, `${base}${suffix}`));
      }
      const size = fs.statSync(copy).size;
      fs.truncateSync(copy, size - 4096);
      artifact = copy;
      const result = runRestore(target, ['--yes']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /checksum mismatch/);
      assert.equal(await tableCount(target), 0);
    } finally {
      artifact = originalArtifact;
      await dropScratch(target);
      fs.rmSync(corruptDir, { recursive: true, force: true });
    }
  });

  test('--list prints the archive TOC without a target database', { skip: skipTools }, () => {
    const result = spawnSync('bash', [RESTORE, artifact, '--list'], {
      cwd: ROOT,
      env: { ...process.env, BACKUP_DIR: tempDir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Archive created at/);
    assert.match(result.stdout, /dbname:/);
  });

  test('--dry-run prints the plan without creating the target', { skip: skipTools }, async () => {
    const target = `inventory_bak2_dry_${process.pid}`;
    const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [target]);
    assert.equal(exists.rowCount, 0, 'the dry-run target must not already exist');
    const result = runRestore(target, ['--dry-run']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Restore plan/);
    assert.equal((await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [target])).rowCount, 0);
  });

  test('decrypts a passphrase-encrypted backup to a 0600 temp file and verifies it', { skip: skipTools || skipNoDb || skipGpg }, async () => {
    encryptedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-restore-enc-'));
    encryptedPassphrase = path.join(encryptedDir, 'passphrase');
    fs.writeFileSync(encryptedPassphrase, 'restore-test-passphrase\n', { mode: 0o600 });

    // Encrypt the already-verified fixture instead of taking a new dump here:
    // the full suite runs DB-writing tests in parallel, so a fresh dump and its
    // manifest could observe different live moments. BAK-1 owns backup
    // encryption; this test owns restoring what backup.sh writes.
    const base = path.basename(artifact, '.dump');
    encryptedArtifact = path.join(encryptedDir, `${base}.dump.gpg`);
    const encrypt = spawnSync(
      'gpg',
      [
        '--batch', '--yes', '--symmetric', '--cipher-algo', 'AES256',
        '--passphrase-file', encryptedPassphrase, '--output', encryptedArtifact, artifact,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(encrypt.status, 0, encrypt.stderr);
    assert.equal(manifest.plaintext_sha256, sha256(artifact), 'fixture manifest must describe the plaintext dump');
    const encryptedManifest = JSON.parse(JSON.stringify(manifest));
    encryptedManifest.file = path.basename(encryptedArtifact);
    encryptedManifest.byte_size = fs.statSync(encryptedArtifact).size;
    encryptedManifest.sha256 = sha256(encryptedArtifact);
    encryptedManifest.encryption = { mode: 'gpg-passphrase' };
    fs.writeFileSync(path.join(encryptedDir, `${base}.manifest.json`), `${JSON.stringify(encryptedManifest, null, 2)}\n`);
    fs.writeFileSync(
      path.join(encryptedDir, `${base}.sha256`),
      `${encryptedManifest.sha256}  ${path.basename(encryptedArtifact)}\n`
    );

    const target = await createScratch();
    try {
      const result = spawnSync('bash', [RESTORE, encryptedArtifact, '--target', target, '--yes'], {
        cwd: ROOT,
        env: {
          ...process.env,
          BACKUP_DIR: encryptedDir,
          BACKUP_PG_DUMP: PG_DUMP,
          BACKUP_PG_RESTORE: PG_RESTORE,
          BACKUP_PASSPHRASE_FILE: encryptedPassphrase,
        },
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(await tableCount(target), liveTableCount);
      assert.deepEqual(
        fs.readdirSync(encryptedDir).filter((name) => name.startsWith('.restore.')),
        [],
        'the plaintext temp archive must be removed on exit'
      );
    } finally {
      await dropScratch(target);
    }
  });
});
