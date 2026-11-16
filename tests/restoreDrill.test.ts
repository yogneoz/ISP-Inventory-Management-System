/**
 * BAK-3 — disposable restore drill, exercised against a real backup and real
 * scratch PostgreSQL databases. No database client or restore command is
 * mocked; every assertion is read from the database or the CLI output.
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
const DRILL = path.join(ROOT, 'scripts', 'check_restore_drill.mjs');
const BACKUP = path.join(ROOT, 'scripts', 'backup.sh');
const PG_DUMP = process.env.BACKUP_PG_DUMP || 'pg_dump';
const PG_RESTORE = process.env.BACKUP_PG_RESTORE || 'pg_restore';
const hasTool = (cmd: string): boolean =>
  spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const skipTools = hasTool(PG_DUMP) && hasTool(PG_RESTORE) ? false : 'needs pg_dump and pg_restore on PATH';
const skipGpg = hasTool('gpg') ? false : 'needs gpg for the encoded-artifact preflight test';

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

let dbReachable = false;
let tempDir = '';
let artifact = '';
let manifest: any = null;
const scratchNames: string[] = [];

try {
  await adminPool.query('SELECT 1');
  dbReachable = true;
} catch {
  dbReachable = false;
}
const skipNoDb = dbReachable ? false : 'needs a reachable PostgreSQL';

before(() => {
  if (skipTools || skipNoDb) return;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-drill-test-'));
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
  artifact = path.join(tempDir, fs.readdirSync(tempDir).find((name) => name.endsWith('.dump')) || '');
  manifest = JSON.parse(
    fs.readFileSync(path.join(tempDir, fs.readdirSync(tempDir).find((name) => name.endsWith('.manifest.json')) || ''), 'utf8')
  );
});

after(async () => {
  for (const name of scratchNames) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  }
  await adminPool.end().catch(() => {});
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runDrill(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('node', [DRILL, ...args], {
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
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* non-JSON failure is checked by the caller */
  }
  if (json?.scratch) scratchNames.push(json.scratch);
  return { status: result.status, stdout, stderr, json };
}

function copyArtifact(dir: string, withManifest = true): string {
  const base = path.basename(artifact, '.dump');
  const copy = path.join(dir, `${base}.dump`);
  fs.copyFileSync(artifact, copy);
  if (withManifest) {
    for (const suffix of ['.manifest.json', '.sha256']) {
      fs.copyFileSync(path.join(tempDir, `${base}${suffix}`), path.join(dir, `${base}${suffix}`));
    }
  }
  return copy;
}

async function exists(name: string): Promise<boolean> {
  const result = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
  return result.rowCount === 1;
}

async function dropScratch(name: string): Promise<void> {
  // The drill name contains an uppercase UTC T/Z; unquoted identifiers fold to
  // lowercase and IF EXISTS would silently make this a no-op. A backend can
  // linger for a moment after the drill closes it, especially under the full
  // suite's parallel load; retry the FORCE drop rather than leaving a scratch
  // database behind (and failing the cleanup assertion).
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

describe('BAK-3 restore drill', () => {
  test('passes a real backup and drops the scratch database', { skip: skipTools || skipNoDb }, async () => {
    const result = runDrill(['--backup', artifact, '--json']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.json.status, 'pass');
    assert.equal(result.json.tableComparison, 'matched');
    assert.equal(result.json.tableCount, manifest.table_count);
    assert.equal(Number(result.json.gl.debit), Number(result.json.gl.credit));
    assert.equal(Number(result.json.gl.postedImbalanceJournals), 0);
    assert.equal(await exists(result.json.scratch), false, 'the scratch database must be dropped before exit');
  });

  test('selects the newest verified backup when --backup is omitted', { skip: skipTools || skipNoDb }, async () => {
    const result = runDrill(['--json']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.json.status, 'pass');
    assert.equal(await exists(result.json.scratch), false);
  });

  test('a truncated artifact fails a check and still drops the scratch database', { skip: skipTools || skipNoDb }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-drill-corrupt-'));
    try {
      const copy = copyArtifact(dir);
      fs.truncateSync(copy, fs.statSync(copy).size - 4096);
      const result = runDrill(['--backup', copy, '--json']);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.json.status, 'fail');
      assert.equal(await exists(result.json.scratch || ''), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--no-manifest runs internal checks and says the comparison was skipped', { skip: skipTools || skipNoDb }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-drill-nomanifest-'));
    try {
      const copy = copyArtifact(dir, false);
      const result = runDrill(['--backup', copy, '--no-manifest', '--json']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.json.status, 'pass');
      assert.equal(result.json.tableComparison, 'skipped');
      assert.equal(await exists(result.json.scratch), false);

      const refused = runDrill(['--backup', copy, '--json']);
      assert.equal(refused.status, 2);
      assert.equal(refused.json.status, 'preflight_failed');
      assert.match(refused.json.error, /manifest does not exist/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an encrypted artifact without its key exits 2 and names the key variable', { skip: skipTools || skipNoDb || skipGpg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isp-drill-encrypted-'));
    try {
      const base = path.basename(artifact, '.dump');
      const encrypted = path.join(dir, `${base}.dump.gpg`);
      const passphrase = path.join(dir, 'passphrase');
      fs.writeFileSync(passphrase, 'drill-test-passphrase\n', { mode: 0o600 });
      const encrypt = spawnSync(
        'gpg',
        ['--batch', '--yes', '--symmetric', '--cipher-algo', 'AES256', '--passphrase-file', passphrase, '--output', encrypted, artifact],
        { encoding: 'utf8' }
      );
      assert.equal(encrypt.status, 0, encrypt.stderr);
      const encryptedManifest = JSON.parse(JSON.stringify(manifest));
      encryptedManifest.file = path.basename(encrypted);
      encryptedManifest.byte_size = fs.statSync(encrypted).size;
      encryptedManifest.sha256 = sha256(encrypted);
      encryptedManifest.encryption = { mode: 'gpg-passphrase' };
      fs.writeFileSync(path.join(dir, `${base}.manifest.json`), `${JSON.stringify(encryptedManifest, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, `${base}.sha256`), `${encryptedManifest.sha256}  ${path.basename(encrypted)}\n`);

      const result = runDrill(['--backup', encrypted, '--json'], {
        BACKUP_PASSPHRASE_FILE: '',
        BACKUP_ENCRYPTION_KEY: '',
      });
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.json.status, 'preflight_failed');
      assert.match(result.json.error, /BACKUP_PASSPHRASE_FILE|BACKUP_ENCRYPTION_KEY/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--keep-scratch leaves the scratch for debugging and can drop it explicitly', { skip: skipTools || skipNoDb }, async () => {
    const result = runDrill(['--backup', artifact, '--json', '--keep-scratch']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.json.status, 'pass');
    assert.equal(await exists(result.json.scratch), true);
    await dropScratch(result.json.scratch);
    assert.equal(await exists(result.json.scratch), false);
  });
});
