/**
 * BAK-4 — the destructive `setup:pg` guard.
 *
 * The guard decision is pure and filesystem-based, so most branches run
 * without a database. The final case takes a real BAK-1 backup and asks the
 * guard about its real `.verified` marker, checksum and timestamp.
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
import { evaluateDestructiveGuard } from '../scripts/setup_db.js';

dotenv.config({ quiet: true });

type GuardResult = {
  allowed: boolean;
  reason: string;
  exitCode?: number;
  message: string;
  keepData?: boolean;
  warning?: string;
  backup?: string;
  ageHours?: number;
};

const ROOT = path.resolve('.');
const SETUP = path.join(ROOT, 'scripts', 'setup_db.js');
const BACKUP = path.join(ROOT, 'scripts', 'backup.sh');
const PG_DUMP = process.env.BACKUP_PG_DUMP || 'pg_dump';
const PG_RESTORE = process.env.BACKUP_PG_RESTORE || 'pg_restore';

const toolAvailable = (cmd: string): boolean =>
  spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const skipTools = toolAvailable(PG_DUMP) && toolAvailable(PG_RESTORE) ? false : 'needs pg_dump and pg_restore';
const dbPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number.parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
  max: 1,
  connectionTimeoutMillis: 3000,
});
let dbReachable = false;
try {
  await dbPool.query('SELECT 1');
  dbReachable = true;
} catch {
  dbReachable = false;
} finally {
  await dbPool.end().catch(() => {});
}
const skipNoDb = dbReachable ? false : 'needs a reachable PostgreSQL';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-setup-guard-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NOW = new Date('2026-11-16T12:00:00.000Z');
function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture(
  dir: string,
  when: Date,
  { content = 'verified-backup-bytes', withMarker = true } = {}
): { base: string; dump: string; marker: string; sha: string } {
  const base = path.join(dir, 'inventory_db-20261116T110000Z');
  const dump = `${base}.dump`;
  fs.writeFileSync(dump, content);
  const sha = sha256(dump);
  fs.writeFileSync(
    `${base}.manifest.json`,
    `${JSON.stringify({ format: 'pg_dump-custom', file: path.basename(dump), sha256: sha, table_count: 1 }, null, 2)}\n`
  );
  fs.writeFileSync(`${base}.sha256`, `${sha}  ${path.basename(dump)}\n`);
  if (withMarker) {
    fs.writeFileSync(`${base}.verified`, `verified_at=${when.toISOString()}\nsha256=${sha}\n`);
  }
  return { base, dump, marker: `${base}.verified`, sha };
}

function guard(argv: string[], backupDir: string, env: Record<string, string> = {}): GuardResult {
  return evaluateDestructiveGuard({ argv, backupDir, now: NOW, env }) as GuardResult;
}

function runCli(args: string[], backupDir: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SETUP, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      BACKUP_DIR: backupDir,
      BACKUP_VERIFY_MAX_AGE_HOURS: '24',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

describe('BAK-4 setup:pg destructive guard', () => {
  test('--keep-data is allowed without any backup and says the wipe is skipped', () => {
    const result = guard(['--keep-data'], path.join(tempDir(), 'absent'));
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'keep-data');
    assert.equal(result.keepData, true);
    assert.match(result.message, /skip|no wipe/i);
  });

  test('no --force refuses and prints BACKUP_DIR plus the three commands', () => {
    const dir = tempDir();
    fixture(dir, new Date(NOW.getTime() - 60 * 60 * 1000));
    const result = guard([], dir);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'force-required');
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /BACKUP_DIR/);
    assert.match(result.message, /inventory_db-20261116T110000Z\.dump/);
    assert.match(result.message, /bash scripts\/backup\.sh/);
    assert.match(result.message, /npm run check:restore-drill/);
    assert.match(result.message, /npm run setup:pg -- --force/);
  });

  test('--force without a verified backup names the newest dump and refuses', () => {
    const dir = tempDir();
    fixture(dir, NOW, { withMarker: false });
    const result = guard(['--force'], dir);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'no-verified-backup');
    assert.match(result.message, /inventory_db-20261116T110000Z\.dump/);
    assert.match(result.message, /no \.verified marker/);
    assert.match(result.message, /24 h/);
  });

  test('--force with a fresh verified marker is allowed and records the artifact', () => {
    const dir = tempDir();
    const backup = fixture(dir, new Date(NOW.getTime() - 2 * 60 * 60 * 1000));
    const result = guard(['--force'], dir);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'fresh-backup');
    assert.equal(result.backup, backup.dump);
    assert.ok(result.ageHours !== undefined);
    assert.ok(Math.abs(result.ageHours - 2) < 0.01);
  });

  test('a 25-hour-old verified marker is stale and refused', () => {
    const dir = tempDir();
    fixture(dir, new Date(NOW.getTime() - 25 * 60 * 60 * 1000));
    const result = guard(['--force'], dir);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'stale-backup');
    assert.match(result.message, /25\.0 h/);
    assert.match(result.message, /limit is 24 h/);
  });

  test('a tampered dump no longer matches the recorded SHA-256 and is refused', () => {
    const dir = tempDir();
    const backup = fixture(dir, new Date(NOW.getTime() - 60 * 60 * 1000));
    fs.appendFileSync(backup.dump, 'tampered');
    const result = guard(['--force'], dir);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'checksum-mismatch');
    assert.match(result.message, /SHA-256/);
  });

  test('a verified marker whose dump disappeared is refused', () => {
    const dir = tempDir();
    const backup = fixture(dir, new Date(NOW.getTime() - 60 * 60 * 1000));
    fs.rmSync(backup.dump);
    const result = guard(['--force'], dir);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'missing-dump');
    assert.match(result.message, /no matching \.dump/);
  });

  test('--force --skip-backup-check is allowed with the residual-risk warning', () => {
    const result = guard(['--force', '--skip-backup-check'], path.join(tempDir(), 'absent'));
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'skip-backup-check');
    assert.match(String(result.warning), /Residual risk/);
    assert.match(String(result.warning), /--skip-backup-check/);
  });

  test('BACKUP_VERIFY_MAX_AGE_HOURS is strict and controls the threshold', () => {
    const dir = tempDir();
    fixture(dir, new Date(NOW.getTime() - 2 * 60 * 60 * 1000));
    const stale = guard(['--force'], dir, { BACKUP_VERIFY_MAX_AGE_HOURS: '1' });
    assert.equal(stale.allowed, false);
    assert.equal(stale.reason, 'stale-backup');
    assert.match(stale.message, /limit is 1 h/);

    const invalid = guard(['--force'], dir, { BACKUP_VERIFY_MAX_AGE_HOURS: 'abc' });
    assert.equal(invalid.allowed, false);
    assert.equal(invalid.reason, 'invalid-max-age');
    assert.match(invalid.message, /BACKUP_VERIFY_MAX_AGE_HOURS/);
  });

  test('the real CLI exits 1 before connecting and writes no setup output', () => {
    const dir = tempDir();
    const result = runCli([], dir);
    assert.equal(result.status, 1, result.output);
    assert.doesNotMatch(result.output, /Connected to PostgreSQL/);
    assert.match(result.output, /BACKUP_DIR/);
    assert.match(result.output, /bash scripts\/backup\.sh/);
  });

  test('the npm run setup:pg entry point also refuses before connecting', () => {
    const dir = tempDir();
    const result = spawnSync('npm', ['run', 'setup:pg'], {
      cwd: ROOT,
      env: { ...process.env, BACKUP_DIR: dir, BACKUP_VERIFY_MAX_AGE_HOURS: '24' },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 1, output);
    assert.doesNotMatch(output, /Connected to PostgreSQL/);
    assert.match(output, /BACKUP_DIR/);
    assert.match(output, /bash scripts\/backup\.sh/);
  });

  test('a real BAK-1 backup satisfies the freshness proof', { skip: skipTools || skipNoDb }, () => {
    const dir = tempDir();
    const result = spawnSync('bash', [BACKUP], {
      cwd: ROOT,
      env: {
        ...process.env,
        BACKUP_DIR: dir,
        BACKUP_PG_DUMP: PG_DUMP,
        BACKUP_PG_RESTORE: PG_RESTORE,
        BACKUP_GPG_RECIPIENT: '',
        BACKUP_PASSPHRASE_FILE: '',
        BACKUP_ENCRYPTION_KEY: '',
      },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const guarded = evaluateDestructiveGuard({
      argv: ['--force'],
      backupDir: dir,
      now: new Date(),
      env: { BACKUP_VERIFY_MAX_AGE_HOURS: '24' },
    }) as GuardResult;
    assert.equal(guarded.allowed, true, guarded.message);
    assert.equal(guarded.reason, 'fresh-backup');
    assert.ok(guarded.backup);
    assert.ok(guarded.backup.endsWith('.dump'));
  });
});
