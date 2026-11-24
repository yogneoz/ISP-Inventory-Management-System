// ============================================================================
// PostgreSQL setup entry point (`npm run setup:pg`).
//
// Responsibilities, in order:
//   1. Load .env so setup uses the SAME credentials the server uses.
//   2. Ensure PostgreSQL is reachable (falls back to scripts/setup_postgres.sh
//      on Linux/macOS when it is not).
//   3. Clear every operational table while PRESERVING the Nepali BS calendar
//      (bs_calendar_years, bs_day_records). `--keep-data` skips this.
//   4. Apply scripts/schema.sql and record the whole migration ledger, in the
//      SAME transaction as the wipe (scripts/seed/resetSchema.ts), so a reset
//      that stops partway rolls back instead of committing half a database.
//   5. Hand the seeding itself to scripts/seed_verification_data.ts, the ONE
//      dataset definition, so `npm run setup:pg` and `npm run seed:verify`
//      can never seed two different worlds.
//
// The wipe deliberately runs BEFORE the schema pass: schema.sql rewrites CHECK
// constraints with ADD CONSTRAINT, which validates existing rows, so a stale
// row from an older schema would otherwise abort the reset (and the server
// boot, which applies the same file). For the same reason the ledger is
// completed before the seeder runs: a migration whose CHECK predates a seeded
// value (0011 against a LOAN_PAYABLE account) would stop the recorder, and a
// database seeded in that state cannot boot.
// ============================================================================

import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const { Pool } = pg;

const DB_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
};

const IS_MAIN =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

const DEFAULT_BACKUP_VERIFY_MAX_AGE_HOURS = 24;
const DESTRUCTIVE_GUARD_COMMANDS = [
  'bash scripts/backup.sh',
  'npm run check:restore-drill',
  'npm run setup:pg -- --force',
];

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseMarker(text) {
  const marker = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_]+)=(.*)$/.exec(line.trim());
    if (match) marker[match[1]] = match[2];
  }
  return marker;
}

function baseOfName(name) {
  if (name.endsWith('.dump.gpg')) return name.slice(0, -'.dump.gpg'.length);
  if (name.endsWith('.dump')) return name.slice(0, -'.dump'.length);
  if (name.endsWith('.verified')) return name.slice(0, -'.verified'.length);
  return null;
}

function listBackupCandidates(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const bases = new Set();
  for (const name of fs.readdirSync(dir)) {
    const base = baseOfName(name);
    if (base) bases.add(base);
  }
  return [...bases].map((base) => {
    const dump = path.join(dir, `${base}.dump`);
    const encrypted = path.join(dir, `${base}.dump.gpg`);
    const dataPath = fs.existsSync(dump) ? dump : fs.existsSync(encrypted) ? encrypted : null;
    const markerPath = path.join(dir, `${base}.verified`);
    const marker = fs.existsSync(markerPath)
      ? parseMarker(fs.readFileSync(markerPath, 'utf8'))
      : null;
    const verifiedAt = marker?.verified_at ? Date.parse(marker.verified_at) : NaN;
    let mtime = 0;
    try {
      const stampPath = dataPath || markerPath;
      mtime = stampPath ? fs.statSync(stampPath).mtimeMs : 0;
    } catch {
      mtime = 0;
    }
    return { base, dataPath, markerPath, marker, verifiedAt: Number.isFinite(verifiedAt) ? verifiedAt : null, mtime };
  });
}

function formatAge(hours) {
  return `${Math.max(0, hours).toFixed(1)} h`;
}

function newestDescription(candidates, nowMs) {
  if (candidates.length === 0) return 'none';
  const newest = [...candidates].sort((a, b) => {
    const aAt = a.verifiedAt ?? a.mtime;
    const bAt = b.verifiedAt ?? b.mtime;
    return bAt - aAt;
  })[0];
  const at = newest.verifiedAt ?? newest.mtime;
  const label = path.basename(newest.dataPath || newest.markerPath);
  return `${label} (${formatAge((nowMs - at) / 3_600_000)} old${newest.marker ? '' : ', no .verified marker'})`;
}

function refused(reason, dir, candidates, nowMs, detail) {
  const commands = DESTRUCTIVE_GUARD_COMMANDS.map((command, index) => `  ${index + 1}. ${command}`).join('\n');
  return {
    allowed: false,
    reason,
    exitCode: 1,
    message: [
      'BAK-4 destructive guard: refusing to wipe the database.',
      `  BACKUP_DIR: ${dir}`,
      `  newest dump: ${newestDescription(candidates, nowMs)}`,
      `  ${detail}`,
      'Run these commands in order:',
      commands,
    ].join('\n'),
  };
}

/**
 * Pure destructive-action decision used by setup:pg and tests. It performs no
 * connection and no filesystem writes. The freshness proof deliberately uses
 * the `.verified` marker timestamp and re-hashes the referenced archive, so a
 * copied marker cannot make an incomplete backup look fresh.
 */
export function evaluateDestructiveGuard({
  argv = process.argv.slice(2),
  backupDir = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'),
  now = new Date(),
  env = process.env,
} = {}) {
  const dir = path.resolve(backupDir);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const candidates = listBackupCandidates(dir);
  const keepData = argv.includes('--keep-data');
  const force = argv.includes('--force');
  const skipBackupCheck = argv.includes('--skip-backup-check');

  if (keepData) {
    return {
      allowed: true,
      reason: 'keep-data',
      keepData: true,
      message: '--keep-data passed: the destructive table wipe will be skipped.',
    };
  }

  if (!force) {
    return refused(
      'force-required',
      dir,
      candidates,
      nowMs,
      'No --force flag was provided. This command truncates every operational table.'
    );
  }

  if (skipBackupCheck) {
    return {
      allowed: true,
      reason: 'skip-backup-check',
      keepData: false,
      message: '',
      warning:
        'BAK-4 warning: --skip-backup-check bypasses the fresh-backup proof. ' +
        'Residual risk: the wipe can permanently destroy data that has no restorable backup. ' +
        'Use it only for CI or a deliberately disposable database.',
    };
  }

  const rawMax = env.BACKUP_VERIFY_MAX_AGE_HOURS;
  const maxAgeHours = rawMax === undefined || rawMax === '' ? DEFAULT_BACKUP_VERIFY_MAX_AGE_HOURS : Number(rawMax);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    return refused(
      'invalid-max-age',
      dir,
      candidates,
      nowMs,
      `Invalid BACKUP_VERIFY_MAX_AGE_HOURS=${rawMax}; expected a positive number of hours.`
    );
  }

  const verified = candidates
    .filter((candidate) => candidate.marker)
    .sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0))[0];
  if (!verified) {
    return refused(
      'no-verified-backup',
      dir,
      candidates,
      nowMs,
      `No verified backup younger than ${maxAgeHours} h (BACKUP_VERIFY_MAX_AGE_HOURS) was found.`
    );
  }
  if (verified.verifiedAt === null) {
    return refused(
      'invalid-marker',
      dir,
      candidates,
      nowMs,
      `The .verified marker for ${verified.base} has no valid verified_at timestamp.`
    );
  }
  if (!verified.dataPath) {
    return refused(
      'missing-dump',
      dir,
      candidates,
      nowMs,
      `The .verified marker references ${verified.base}, but no matching .dump or .dump.gpg exists.`
    );
  }

  let recordedSha = verified.marker.sha256 || '';
  if (!recordedSha) {
    try {
      recordedSha = fs.readFileSync(path.join(dir, `${verified.base}.sha256`), 'utf8').trim().split(/\s+/)[0] || '';
    } catch {
      recordedSha = '';
    }
  }
  if (!recordedSha) {
    return refused(
      'missing-checksum',
      dir,
      candidates,
      nowMs,
      `The newest verified backup (${verified.base}) has no recorded SHA-256.`
    );
  }
  const actualSha = sha256File(verified.dataPath);
  if (actualSha !== recordedSha) {
    return refused(
      'checksum-mismatch',
      dir,
      candidates,
      nowMs,
      `The newest verified backup (${verified.base}) no longer matches its recorded SHA-256.`
    );
  }

  const ageHours = (nowMs - verified.verifiedAt) / 3_600_000;
  if (ageHours > maxAgeHours) {
    return refused(
      'stale-backup',
      dir,
      candidates,
      nowMs,
      `The newest verified backup is ${formatAge(ageHours)} old; the limit is ${maxAgeHours} h.`
    );
  }

  return {
    allowed: true,
    reason: 'fresh-backup',
    keepData: false,
    message: '',
    backup: verified.dataPath,
    ageHours,
  };
}

async function tryConnect(retries = 3, delayMs = 1500) {
  const pool = new Pool({ ...DB_CONFIG, connectionTimeoutMillis: 4000 });
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (err) {
      if (attempt === retries) {
        await pool.end().catch(() => {});
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

function runShellInstaller() {
  const scriptPath = path.join(process.cwd(), 'scripts', 'setup_postgres.sh');
  if (!fs.existsSync(scriptPath)) return false;
  try {
    console.log('🔧 Attempting automated shell installer (scripts/setup_postgres.sh)...');
    execSync(`bash "${scriptPath}"`, { stdio: 'inherit', timeout: 600000 });
    return true;
  } catch (err) {
    console.warn('⚠️ Shell installer notice:', err?.message || err);
    return false;
  }
}

// The wipe and the schema pass live in scripts/seed/resetSchema.ts so they run
// inside ONE transaction together with the migration ledger.

function tsxCliPath() {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) {
    throw new Error(
      'tsx is not installed (node_modules/tsx/dist/cli.mjs missing). Run `npm install` first, then `npm run setup:pg`.'
    );
  }
  return tsxCli;
}

function runSchemaReset(keepData) {
  // Wipe + schema.sql + the whole migration ledger, in one transaction, before
  // any row exists. A recorder that stops partway now rolls the wipe and the
  // schema back too, instead of committing a database whose next boot or seed
  // fails on an older migration's CHECK.
  const args = [tsxCliPath(), path.join('scripts', 'record_schema_migrations.ts')];
  if (keepData) args.push('--keep-data');
  execFileSync(process.execPath, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      POSTGRES_HOST: DB_CONFIG.host,
      POSTGRES_PORT: String(DB_CONFIG.port),
      POSTGRES_DB: DB_CONFIG.database,
      POSTGRES_USER: DB_CONFIG.user,
      POSTGRES_PASSWORD: DB_CONFIG.password,
    },
  });
}

function runDatasetSeeder() {
  const args = [tsxCliPath(), path.join('scripts', 'seed_verification_data.ts'), '--keep-data', '--skip-schema'];
  execFileSync(process.execPath, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      POSTGRES_HOST: DB_CONFIG.host,
      POSTGRES_PORT: String(DB_CONFIG.port),
      POSTGRES_DB: DB_CONFIG.database,
      POSTGRES_USER: DB_CONFIG.user,
      POSTGRES_PASSWORD: DB_CONFIG.password,
    },
  });
}

async function runSetup(keepData) {
  let pool;
  try {
    pool = await tryConnect();
    console.log('✅ Connected to PostgreSQL.');
  } catch (err) {
    console.warn('⚠️ Could not connect to PostgreSQL:', err.message);
    runShellInstaller();
    try {
      pool = await tryConnect();
      console.log('✅ Connected to PostgreSQL (after installer attempt).');
    } catch (retryErr) {
      console.error('❌ PostgreSQL is not reachable and the automated installer did not help.');
      console.error('   Start PostgreSQL and re-run: npm run setup:pg');
      console.error('   Connection details:', JSON.stringify({ ...DB_CONFIG, password: '***' }));
      process.exit(1);
    }
  }

  await pool.end().catch(() => {});

  try {
    runSchemaReset(keepData);
  } catch (err) {
    console.error(
      '❌ Schema reset failed; the database was left exactly as it was (the wipe, the schema and the ' +
        'migration ledger are one transaction) and nothing was seeded.'
    );
    console.error('   Re-run with --force to clear the rows that block an older migration:');
    console.error('   npm run setup:pg -- --force --skip-backup-check');
    throw err;
  }

  runDatasetSeeder();
  console.log('🎉 PostgreSQL setup verified and operational!');
}

async function main() {
  const guard = evaluateDestructiveGuard();
  if (!guard.allowed) {
    console.error(guard.message);
    process.exit(1);
    return;
  }
  if (guard.message) console.log(guard.message);
  if (guard.warning) console.warn(guard.warning);
  if (guard.backup) {
    console.log(`✅ BAK-4 fresh verified backup: ${guard.backup} (${guard.ageHours.toFixed(1)} h old).`);
  }

  console.log('------------------------------------------------------------------');
  console.log('🛠️  Automated PostgreSQL Setup Engine');
  console.log(`🎯 Target: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  console.log('------------------------------------------------------------------');

  await runSetup(guard.keepData);
}

if (IS_MAIN) {
  main().catch((err) => {
    console.error('❌ Setup failed:', err);
    process.exit(1);
  });
}
