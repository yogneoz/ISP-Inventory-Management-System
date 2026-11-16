/**
 * BAK-1 — verified PostgreSQL backups.
 *
 * These run the real `bash scripts/backup.sh` against the configured live
 * database in disposable directories. They cover the acceptance path, not a
 * mock: a custom dump + manifest + checksum + `.verified`, manifest counts
 * against the live catalogue, the mkdir lock, dry-run, strict config failure,
 * encrypted round-trips (passphrase and recipient-only), and retention.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const ROOT = path.resolve('.');
const SCRIPT = path.join(ROOT, 'scripts', 'backup.sh');
const PG_DUMP = process.env.BACKUP_PG_DUMP || 'pg_dump';
const PG_RESTORE = process.env.BACKUP_PG_RESTORE || 'pg_restore';

const toolAvailable = (cmd: string): boolean =>
  spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const skipTools = toolAvailable(PG_DUMP) && toolAvailable(PG_RESTORE)
  ? false
  : 'needs pg_dump and pg_restore on PATH';
const skipGpg = toolAvailable('gpg') ? false : 'needs gpg for the encryption tests';

let dbName = '';
let liveTableCount = 0;
let dbReachable = false;
try {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number.parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'inventory_db',
    user: process.env.POSTGRES_USER || 'inventory_user',
    password: process.env.POSTGRES_PASSWORD || 'securepassword',
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  const info = await pool.query('SELECT current_database() AS db');
  dbName = info.rows[0].db;
  const count = await pool.query(`
    SELECT count(*)::int AS n
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
  `);
  liveTableCount = count.rows[0].n;
  await pool.end();
  dbReachable = true;
} catch {
  dbReachable = false;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-bak-'));
  dirs.push(dir);
  return dir;
}

type Run = { status: number | null; stdout: string; stderr: string };
function runBackup(dir: string, env: Record<string, string> = {}, args: string[] = []): Run {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    BACKUP_DIR: dir,
    BACKUP_PG_DUMP: PG_DUMP,
    BACKUP_PG_RESTORE: PG_RESTORE,
    BACKUP_RETENTION_DAYS: '30',
    BACKUP_MONTHLY_KEEP: '12',
    BACKUP_GPG_RECIPIENT: '',
    BACKUP_PASSPHRASE_FILE: '',
    BACKUP_ENCRYPTION_KEY: '',
    ...env,
  };
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    env: base,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function files(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => !name.startsWith('.'));
}

function one(dir: string, suffix: string): string {
  const matches = files(dir).filter((name) => name.endsWith(suffix));
  assert.equal(matches.length, 1, `expected exactly one ${suffix} in ${files(dir).join(', ')}`);
  return path.join(dir, matches[0]);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readManifest(dir: string): any {
  return JSON.parse(fs.readFileSync(one(dir, '.manifest.json'), 'utf8'));
}

function fakeGroup(dir: string, date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const base = path.join(dir, `inventory_db-${stamp}`);
  fs.writeFileSync(`${base}.dump`, '');
  fs.writeFileSync(`${base}.manifest.json`, '{}\n');
  fs.writeFileSync(`${base}.sha256`, '');
  fs.writeFileSync(`${base}.verified`, 'fake\n');
  return base;
}

describe('BAK-1 backup script', () => {
  test('one run produces dump, manifest, checksum and verified marker', { skip: skipTools || skipNoDb }, () => {
    const dir = tempDir();
    const result = runBackup(dir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const dump = one(dir, '.dump');
    const manifest = readManifest(dir);
    const checksum = fs.readFileSync(one(dir, '.sha256'), 'utf8').trim().split(/\s+/)[0];
    const marker = fs.readFileSync(one(dir, '.verified'), 'utf8');

    assert.match(path.basename(dump), new RegExp(`^${dbName}-\\d{8}T\\d{6}Z\\.dump$`));
    assert.equal(checksum, sha256(dump), 'the .sha256 must hash the dump');
    assert.equal(manifest.format, 'pg_dump-custom');
    assert.equal(manifest.database, dbName);
    assert.equal(manifest.table_count, liveTableCount);
    assert.equal(manifest.tables.length, liveTableCount);
    assert.equal(manifest.byte_size, fs.statSync(dump).size);
    assert.equal(manifest.sha256, checksum);
    assert.equal(manifest.plaintext_sha256, checksum);
    assert.equal(manifest.encryption.mode, 'none');
    assert.equal(manifest.gl.imbalance_journals, 0);
    assert.equal(manifest.gl.debit, manifest.gl.credit);
    assert.match(marker, /^verified_at=/);
    assert.doesNotMatch(marker, /sealed_at/);

    const list = spawnSync(PG_RESTORE, ['--list', dump], { encoding: 'utf8' });
    assert.equal(list.status, 0, 'the produced dump must be readable by pg_restore');
  });

  test('a second run in the lock window exits 0 without a second dump', { skip: skipTools || skipNoDb }, () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, '.lock'));
    const result = runBackup(dir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /already running/);
    assert.deepEqual(files(dir), [], 'a locked run must not write a dump or sidecars');
  });

  test('a missing pg_dump fails with the exact command name', () => {
    const dir = tempDir();
    const result = runBackup(dir, { BACKUP_PG_DUMP: 'definitely-not-a-pg-dump' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /definitely-not-a-pg-dump not found/);
    assert.deepEqual(files(dir), [], 'a missing tool must fail before any backup file is written');
  });

  test('--dry-run prints the resolved plan without creating the directory', { skip: skipTools }, () => {
    const dir = path.join(tempDir(), 'not-created');
    const result = runBackup(dir, {}, ['--dry-run']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Backup plan/);
    assert.match(result.stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.existsSync(dir), false, 'dry-run must not create BACKUP_DIR');
  });

  test('a missing passphrase file fails before any backup is reported', { skip: skipTools || skipNoDb || skipGpg }, () => {
    const dir = tempDir();
    const missing = path.join(dir, 'missing-passphrase');
    const result = runBackup(dir, { BACKUP_PASSPHRASE_FILE: missing });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BACKUP_PASSPHRASE_FILE/);
    assert.deepEqual(files(dir), [], 'no dump, checksum or marker may survive a rejected encryption config');
  });

  test('strict retention knobs reject invalid values by name', () => {
    const dir = tempDir();
    const result = runBackup(dir, { BACKUP_RETENTION_DAYS: 'abc' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BACKUP_RETENTION_DAYS/);
    assert.deepEqual(files(dir), [], 'invalid config must fail before writing a backup');
  });

  test('passphrase encryption round-trips and remains .verified', { skip: skipTools || skipNoDb || skipGpg }, () => {
    const dir = tempDir();
    const key = path.join(dir, 'passphrase');
    fs.writeFileSync(key, 'bak1-test-passphrase\n', { mode: 0o600 });
    const result = runBackup(dir, { BACKUP_PASSPHRASE_FILE: key });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    assert.equal(files(dir).some((name) => name.endsWith('.dump')), false, 'plaintext must not remain');
    const encrypted = one(dir, '.dump.gpg');
    const manifest = readManifest(dir);
    assert.equal(manifest.encryption.mode, 'gpg-passphrase');
    assert.equal(manifest.sha256, sha256(encrypted));
    assert.ok(fs.existsSync(one(dir, '.verified')));
    assert.equal(files(dir).some((name) => name.endsWith('.sealed')), false);

    const decrypted = path.join(dir, 'decrypted.dump');
    const decrypt = spawnSync(
      'gpg',
      ['--batch', '--yes', '--passphrase-file', key, '--output', decrypted, '--decrypt', encrypted],
      { encoding: 'utf8' }
    );
    assert.equal(decrypt.status, 0, decrypt.stderr);
    const list = spawnSync(PG_RESTORE, ['--list', decrypted], { encoding: 'utf8' });
    assert.equal(list.status, 0, 'the encrypted dump must decrypt to a readable archive');
  });

  test('recipient-only encryption writes .sealed, not .verified', { skip: skipTools || skipNoDb || skipGpg }, () => {
    const dir = tempDir();
    const gnupg = path.join(dir, 'gnupg');
    fs.mkdirSync(gnupg, { mode: 0o700 });
    // gpg here is an MSYS binary; a Windows C:\ path in GNUPGHOME is
    // interpreted as a relative path. Convert it to /c/... for the child.
    const gnupgPosix = spawnSync('cygpath', ['-u', gnupg], { encoding: 'utf8' }).stdout?.trim() || gnupg;
    const env = { ...process.env, GNUPGHOME: gnupgPosix };
    const keygen = spawnSync(
      'gpg',
      [
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
        '--quick-generate-key',
        'BAK Test <bak@example.test>',
        'default',
        'default',
        'never',
      ],
      { env, encoding: 'utf8' }
    );
    assert.equal(keygen.status, 0, keygen.stderr);

    const result = runBackup(dir, {
      GNUPGHOME: gnupgPosix,
      BACKUP_GPG_RECIPIENT: 'bak@example.test',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(files(dir).some((name) => name.endsWith('.verified')), false);
    assert.ok(fs.existsSync(one(dir, '.sealed')));
    assert.equal(readManifest(dir).encryption.mode, 'gpg-recipient');

    const decrypted = path.join(dir, 'recipient.dump');
    const decrypt = spawnSync('gpg', ['--batch', '--yes', '--decrypt', '--output', decrypted, one(dir, '.dump.gpg')], {
      env,
      encoding: 'utf8',
    });
    assert.equal(decrypt.status, 0, decrypt.stderr);
    assert.equal(spawnSync(PG_RESTORE, ['--list', decrypted], { encoding: 'utf8' }).status, 0);
  });

  test('retention deletes only complete groups older than the newest verified set', { skip: skipTools || skipNoDb }, () => {
    const dir = tempDir();
    const now = Date.now();
    const old = fakeGroup(dir, new Date(now - 4 * 86_400_000));
    const yesterday = fakeGroup(dir, new Date(now - 1 * 86_400_000));
    // A group with a missing sidecar is never deleted.
    const incomplete = fakeGroup(dir, new Date(now - 3 * 86_400_000));
    fs.rmSync(`${incomplete}.sha256`);

    const result = runBackup(dir, {
      BACKUP_RETENTION_DAYS: '2',
      BACKUP_MONTHLY_KEEP: '1',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(`${old}.manifest.json`), false, 'old complete group should be pruned');
    assert.equal(fs.existsSync(`${yesterday}.manifest.json`), true, 'newest daily bucket should remain');
    assert.equal(fs.existsSync(`${incomplete}.manifest.json`), true, 'incomplete group must never be pruned');
    assert.equal(files(dir).filter((name) => name.endsWith('.manifest.json')).length, 3);
  });
});
