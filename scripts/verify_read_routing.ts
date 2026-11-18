/**
 * SCALE-3 — live proof that the read/write split and its lag guard work.
 *
 * The claim behind the guard is about behaviour under real replication, so this
 * script does not simulate it: it provisions a throwaway primary and a real
 * streaming standby of it (`initdb` + `pg_basebackup -R`), wires the standby
 * into the same `createReadRouter` the server uses, and then asks the router to
 * run a read that reports which cluster actually answered it.
 *
 * Why not the application database: starting a standby of it needs a role with
 * the REPLICATION attribute, which the application role does not have, and
 * granting that is an administrator decision about the operator's server. So the
 * demonstration carries its own two clusters in the OS temp directory. The code
 * path under test is identical — the router, the probe SQL and the decision
 * function are the shipped ones; only the connection strings differ.
 *
 * Scenarios (each an observed redirection, not an assertion about config):
 *
 *   1. healthy standby, lag inside the threshold      → read lands on the standby
 *   2. replay paused, WAL written, lag past the limit → read is sent to the primary
 *   3. replay resumed, standby caught up              → read lands on the standby
 *   4. the request has already written                → read is sent to the primary
 *   5. standby stopped                                → read is served by the primary,
 *                                                       with no error to the caller
 *
 * Both clusters are stopped at the end; their data directories are reused on the
 * next run (README_DIR below). Nothing outside those directories is modified.
 *
 * Requirements: PostgreSQL binaries on PATH (initdb, pg_ctl, pg_basebackup),
 * two free ports (default 55433 primary, 55432 standby).
 *
 * Usage:
 *   npx tsx scripts/verify_read_routing.ts [--fresh] [--keep-standby]
 *     --fresh          delete the demo clusters and provision them again
 *     --keep-standby   leave both clusters running for inspection
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createReadRouter, runWithReadContext, markRequestWrote } from '../server/src/db/readRouting';

const fresh = process.argv.includes('--fresh');
const keepStandby = process.argv.includes('--keep-standby');
const primaryPort = Number(process.env.READ_ROUTING_PRIMARY_PORT || 55433);
const standbyPort = Number(process.env.READ_ROUTING_STANDBY_PORT || 55432);
const root = process.env.READ_ROUTING_DIR || path.join(os.tmpdir(), 'inventory-read-routing-demo');
const primaryDir = path.join(root, 'primary');
const standbyDir = path.join(root, 'standby');
const maxLagMs = Number(process.env.REPLICA_MAX_LAG_MS || 1500);
const user = 'postgres';
const database = 'routing_demo';

const primaryUrl = `postgres://${user}@localhost:${primaryPort}/${database}`;
const standbyUrl = `postgres://${user}@localhost:${standbyPort}/${database}`;

function pgBin(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function run(bin: string, args: string[], capture = false): string {
  return execFileSync(pgBin(bin), args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
}

function running(dataDir: string): boolean {
  try {
    run('pg_ctl', ['-D', dataDir, 'status'], true);
    return true;
  } catch {
    return false;
  }
}

function stop(dataDir: string): void {
  if (!running(dataDir)) return;
  try {
    run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
  } catch {
    /* already gone */
  }
}

function provisionPrimary(): void {
  if (fresh && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(primaryDir, 'PG_VERSION'))) {
    console.log(`[read-routing] initdb ${primaryDir}`);
    run('initdb', ['-D', primaryDir, '-U', user, '-A', 'trust', '-E', 'UTF8', '--no-locale']);
  }
  if (!running(primaryDir)) {
    run('pg_ctl', [
      '-D',
      primaryDir,
      '-l',
      path.join(primaryDir, 'primary.log'),
      '-o',
      `-p ${primaryPort} -c wal_level=replica -c max_wal_senders=10 -c listen_addresses=localhost`,
      '-w',
      'start',
    ]);
  }
}

function provisionStandby(): void {
  if (!fs.existsSync(path.join(standbyDir, 'PG_VERSION'))) {
    console.log(`[read-routing] pg_basebackup ${standbyDir} from the demo primary`);
    run('pg_basebackup', [
      '-D',
      standbyDir,
      '-h',
      'localhost',
      '-p',
      String(primaryPort),
      '-U',
      user,
      '-R',
      '-X',
      'stream',
      '-c',
      'fast',
    ]);
  }
  if (!running(standbyDir)) {
    run('pg_ctl', [
      '-D',
      standbyDir,
      '-l',
      path.join(standbyDir, 'standby.log'),
      '-o',
      `-p ${standbyPort} -c listen_addresses=localhost`,
      '-w',
      'start',
    ]);
  }
}

async function waitFor<T>(what: string, check: () => Promise<T | null>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null) return value;
    } catch (error: any) {
      last = String(error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ''}`);

}

async function main() {
  provisionPrimary();

  const adminPool = new pg.Pool({ connectionString: `postgres://${user}@localhost:${primaryPort}/postgres`, max: 1 });
  await waitFor('the demo primary to accept connections', async () => {
    const result = await adminPool.query('SELECT 1 AS ok');
    return result.rows[0].ok === 1 ? true : null;
  });
  const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (!exists.rows.length) await adminPool.query(`CREATE DATABASE ${database}`);
  await adminPool.end();

  provisionStandby();

  const standby = await waitFor('the standby to accept connections', async () => {
    const client = new pg.Client({ connectionString: standbyUrl, connectionTimeoutMillis: 2000 });
    await client.connect();
    try {
      const result = await client.query('SELECT pg_is_in_recovery() AS replica');
      if (result.rows[0].replica) return client;
      await client.end();
      return null;
    } catch {
      await client.end();
      return null;
    }
  });

  const primaryPool = new pg.Pool({ connectionString: primaryUrl, max: 2, connectionTimeoutMillis: 3000 });
  const standbyPool = new pg.Pool({ connectionString: standbyUrl, max: 2, connectionTimeoutMillis: 2000 });

  const router = createReadRouter({
    writePool: primaryPool,
    readPool: standbyPool,
    maxLagMs,
    cooldownMs: 1000,
    probeIntervalMs: 0,
    log: (message) => console.log(`[read-routing] ${message}`),
  });

  const results: Array<{ scenario: string; landedOn: string; expected: string; reason: string; ok: boolean }> = [];

  async function readServedBy(): Promise<{ replica: boolean; reason: string }> {
    const result = await router.query('SELECT pg_is_in_recovery() AS replica');
    return { replica: result.rows[0].replica === true, reason: String(router.status().lastReason) };
  }

  async function record(scenario: string, expected: 'replica' | 'primary') {
    const { replica, reason } = await readServedBy();
    const landedOn = replica ? 'replica' : 'primary';
    const ok = landedOn === expected;
    results.push({ scenario, landedOn, expected, reason, ok });
    console.log(
      `[read-routing] ${ok ? 'OK  ' : 'FAIL'} ${scenario}: served by ${landedOn} (expected ${expected}, reason ${reason})`
    );
  }

  async function waitForCaughtUp() {
    await waitFor('the standby to catch up', async () => {
      const row = await standby.query(
        'SELECT pg_last_wal_receive_lsn() IS NOT DISTINCT FROM pg_last_wal_replay_lsn() AS caught_up'
      );
      return row.rows[0].caught_up ? true : null;
    });
  }

  try {
    await primaryPool.query('CREATE TABLE IF NOT EXISTS routing_probe (id serial primary key, note text)');
    // One committed transaction before the pause gives the standby a replayed
    // commit timestamp to measure from: `pg_last_xact_replay_timestamp()` is
    // NULL on a standby that has never replayed one, and a NULL there means the
    // guard has no lag to read (it treats the standby as current).
    await primaryPool.query(`INSERT INTO routing_probe (note) VALUES ('baseline')`);
    await waitForCaughtUp();
    await waitFor('the standby to record a replay timestamp', async () => {
      const row = await standby.query('SELECT pg_last_xact_replay_timestamp() IS NOT NULL AS seen');
      return row.rows[0].seen ? true : null;
    });

    // 1. Healthy standby inside the threshold.
    await record('healthy standby, lag within threshold', 'replica');

    // 2. Replay paused, real WAL written, lag beyond the threshold.
    await standby.query('SELECT pg_wal_replay_pause()');
    await primaryPool.query(
      `INSERT INTO routing_probe (note) SELECT repeat('x', 200) FROM generate_series(1, 500)`
    );
    const lag = await waitFor('the standby lag to exceed the threshold', async () => {
      const row = await standby.query(
        `SELECT CASE WHEN pg_last_wal_receive_lsn() IS DISTINCT FROM pg_last_wal_replay_lsn()
                      AND pg_last_xact_replay_timestamp() IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 ELSE 0 END AS lag_ms`
      );
      const lagMs = Number(row.rows[0].lag_ms);
      return lagMs > maxLagMs ? lagMs : null;
    });
    console.log(`[read-routing] measured standby lag ${Math.round(Number(lag))} ms > ${maxLagMs} ms threshold`);
    await record('standby lag beyond threshold', 'primary');

    // 3. Replay resumed and caught up.
    await standby.query('SELECT pg_wal_replay_resume()');
    await waitForCaughtUp();
    await record('standby caught up again', 'replica');

    // 4. A request that has already written must not read the standby.
    const wrote = await runWithReadContext(async () => {
      markRequestWrote();
      return readServedBy();
    });
    const writeOk = wrote.replica === false;
    results.push({
      scenario: 'request has already written',
      landedOn: wrote.replica ? 'replica' : 'primary',
      expected: 'primary',
      reason: wrote.reason,
      ok: writeOk,
    });
    console.log(
      `[read-routing] ${writeOk ? 'OK  ' : 'FAIL'} request has already written: served by ${
        wrote.replica ? 'replica' : 'primary'
      } (reason ${wrote.reason})`
    );

    // 5. The standby disappears: the read is served by the primary, without an error.
    await standby.end();
    await standbyPool.end();
    stop(standbyDir);
    router.invalidate();
    await record('standby stopped and unreachable', 'primary');
    const status = router.status();
    console.log(
      `[read-routing] router status: served replica=${status.served.replica} primary=${status.served.primary}, last reason ${status.lastReason}`
    );
  } finally {
    await primaryPool.query('DROP TABLE IF EXISTS routing_probe').catch(() => undefined);
    await primaryPool.end().catch(() => undefined);
    if (!keepStandby) stop(standbyDir);
    if (!keepStandby) stop(primaryDir);
  }

  console.log('\nscenario                                              expected  observed  reason');
  for (const result of results) {
    console.log(
      `${result.scenario.padEnd(52)} ${result.expected.padEnd(9)} ${result.landedOn.padEnd(9)} ${result.reason}`
    );
  }
  const failures = results.filter((result) => !result.ok);
  if (failures.length) {
    console.error(`\nFAILED ${failures.length}/${results.length} scenario(s): the read routing or its guard is not working.`);
    process.exit(1);
  }
  console.log(`\nOK: ${results.length}/${results.length} scenarios routed as intended on a real streaming standby.`);
}

main().catch((error) => {
  console.error('[read-routing] failed:', error?.message || error);
  process.exit(1);
});
