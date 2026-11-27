/**
 * Runs the test suite with NODE_ENV forced to "test", then runs the
 * docs-count gate against THIS run's real suite size.
 *
 * Why NODE_ENV: the repo's .env sets NODE_ENV=development (needed for the
 * Vite dev server / helmet CSP bypass). dotenvx injects it when `tsx --test`
 * boots, which makes tests/httpHardening.test.ts false-fail because CSP is
 * intentionally disabled in development. Spawning tsx as a child process
 * with an explicit NODE_ENV=test environment keeps the .env file untouched
 * for dev while making `npm test` deterministic in any shell (npm, CI, IDE
 * runners). POSIX `NODE_ENV=test npm test` doesn't work in Windows shells,
 * and cross-env isn't a dependency — hence this runner.
 *
 * Why the docs-count gate lives here: only this runner sees the runner's own
 * summary line ("ℹ tests N") for the SAME run that just passed, so every
 * current-state test-count claim in README / handoff / SESSION_NOTES is
 * checked against a fresh number — no checked-in count file, no lag of one
 * run. The gate itself is scripts/docsTestCounts.ts; its classification
 * rules are unit-tested in tests/docsCounts.guard.test.ts.
 *
 * Why the annotation step lives here: a failing run has to be diagnosable from
 * the GitHub run page without downloading the job log (job logs need an
 * authenticated API request). On the runner — and only there — a non-zero suite
 * exit hands this run's captured output to scripts/ciTestAnnotations.ts, which
 * prints `::error` annotations per failing test plus a job-summary table. The
 * exit status stays the suite's own.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { shardFilesFor } from './testShardPlan.mjs';
const root = path.resolve(__dirname, '..');

// The suite itself loads .env via dotenv; this runner must do the same before
// it can add the test-only ledger-maintenance startup option to DATABASE_URL.
// In CI DATABASE_URL is already in the environment, so config() is a no-op.
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';
const spawnEnv = { ...process.env, NODE_ENV: 'test' };

/**
 * CI runs the suite in isolated matrix runners. Node's --test-shard partitions
 * TEST FILES (not individual subtests), so the docs-count gate cannot run here:
 * it would compare the docs against one shard's share of the suite. The workflow
 * sums every summary file and runs that gate once after all shards finish.
 * Local/unsharded `npm test` keeps the gate in this process.
 */
const shard = (process.env.TEST_SHARD || '').trim();
if (shard) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match || Number(match[1]) > Number(match[2])) {
    console.error(`test runner: invalid TEST_SHARD "${shard}" (expected N/M with 1 <= N <= M)`);
    process.exit(2);
  }
}
// A per-test bound, so one stuck test fails by name instead of holding the
// whole shard open until the job's own timeout cancels it with no annotation
// (that is what happened to shard 5: every other shard finished in four
// minutes while it sat at the 25-minute job limit). No test in the suite is
// anywhere near this long — the slowest full shard is ~4 minutes in total.
//
// `--test-force-exit` was tried for the other half of the same shape (all tests
// done, something still holding the loop open) and removed: it exits as soon as
// the current callbacks finish, which cut the parallel run short — two shards
// went red in a minute with only part of their tests executed.
const suiteArgs = ['tsx', '--test', '--test-timeout=180000'];
// Measurement mode. Node's --test-shard splits by file COUNT, so balancing the
// shards needs real per-file numbers first; scripts/testDurationReporter.mjs
// writes them for exactly this run and nothing else. A normal `npm test` is
// unchanged.
if (process.env.TEST_CONCURRENCY) {
  // Node runs test files in parallel (availableParallelism - 1 by default). On
  // this workstation every file shares one PostgreSQL, and the partition DDL a
  // file takes can exhaust the server's lock table when dozens are in flight
  // ("out of shared memory ... max_locks_per_transaction"), which aborts
  // unrelated suites. A measuring run therefore asks for a smaller number;
  // CI keeps the default because each shard owns its own database.
  const concurrency = Number(process.env.TEST_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`test runner: invalid TEST_CONCURRENCY "${process.env.TEST_CONCURRENCY}"`);
    process.exit(2);
  }
  suiteArgs.push(`--test-concurrency=${concurrency}`);
}
if (process.env.TEST_DURATIONS_PATH) {
  suiteArgs.push('--test-reporter=spec', '--test-reporter-destination=stdout');
  suiteArgs.push(
    `--test-reporter=${pathToFileURL(path.join(root, 'scripts/testDurationReporter.mjs')).href}`,
    '--test-reporter-destination=stdout'
  );
}
if (shard) {
  // The shard's file list comes from the checked-in, duration-balanced plan
  // (scripts/testShardPlan.json) instead of a file-count slice of the glob, so
  // the long database suites are spread across shards. Every test file appears
  // in exactly one shard; `check:shard-plan` fails when a new file is unassigned.
  suiteArgs.push(...shardFilesFor(root, shard));
} else {
  suiteArgs.push('tests/*.test.ts');
}

/**
 * Fixture cleanup deletes the test's own posted journals. The ACC-1b trigger
 * correctly refuses that on an application connection, so the test runner gives
 * only this child process a session-local bypass through the PostgreSQL
 * `options` startup parameter. Production and ordinary dev connections never
 * receive it; tests that need to prove the trigger still connect without it.
 */
function withLedgerPurgeBypass(connectionString) {
  if (!connectionString) return connectionString;
  try {
    const url = new URL(connectionString);
    const existing = url.searchParams.get('options') || '';
    if (existing.includes('inventory.allow_ledger_purge')) return connectionString;
    url.searchParams.set(
      'options',
      `${existing ? `${existing} ` : ''}-c inventory.allow_ledger_purge=on`
    );
    // URLSearchParams serializes spaces as '+'. node-postgres decodes that,
    // but libpq/psql/pg_dump pass it through literally ("+inventory...") and
    // reject the startup option. Emit %20 so every client reads the same URL.
    const query = url.searchParams.toString().replace(
      /(^|&)options=([^&]*)/,
      (_match, prefix, value) => `${prefix}options=${value.replace(/\+/g, '%20')}`
    );
    url.search = query;
    return url.toString();
  } catch {
    // A non-URL connection string is passed through unchanged; the trigger's
    // failure message explains how to opt a manual cleanup session in.
    return connectionString;
  }
}

spawnEnv.DATABASE_URL = withLedgerPurgeBypass(spawnEnv.DATABASE_URL);

/**
 * Demo-master hygiene. Suites seed the demo branch/fiscal-year master
 * (tests/fixtures/referenceData.ts) because CI's database is schema-only; on a
 * developer database that already owns its master those rows — and the
 * journals, sequence counters and period balances posted against them — used to
 * survive the run. Test files run concurrently, so no single suite can safely
 * remove a row a sibling file may still be using. This process is the only one
 * that sees every suite finish, so it snapshots before the run and removes
 * exactly the demo rows the run created afterwards (scripts/testDbHygiene.ts).
 * Clean-up never changes this run's exit status.
 */
const hygieneSnapshotPath = path.join(os.tmpdir(), `inventory-test-hygiene-${process.pid}.json`);
function runDbHygiene(mode) {
  const step = spawnSync(npxCmd, ['tsx', 'scripts/testDbHygiene.ts', mode, hygieneSnapshotPath], {
    cwd: root,
    shell: isWindows,
    env: spawnEnv,
    stdio: 'inherit',
  });
  if (step.error) console.error(`test-hygiene: ${mode} step could not run:`, step.error.message);
}
runDbHygiene('snapshot');

// Piped stdout so the summary line can be parsed, while the bytes still
// stream straight through to the terminal / CI log unchanged.
const suite = spawn(npxCmd, suiteArgs, {
  cwd: root,
  shell: isWindows,
  env: spawnEnv,
  stdio: ['inherit', 'pipe', 'pipe'],
});

const chunks = [];
const stderrChunks = [];
suite.stdout.on('data', (chunk) => {
  chunks.push(chunk);
  process.stdout.write(chunk);
});
suite.stderr.on('data', (chunk) => {
  stderrChunks.push(chunk);
  process.stderr.write(chunk);
});

suite.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Turns a failing run into GitHub annotations + a job summary. Runs only on
 * GitHub Actions: anywhere else the workflow commands would be terminal noise,
 * and this machine's reporter output already names every failing test.
 *
 * Deliberately never touches the exit status — the caller exits with the
 * suite's own code, so a parser problem can only cost diagnostics, never mask
 * or manufacture a failure.
 */
function annotateFailures(output) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const logPath = path.join(os.tmpdir(), `inventory-test-output-${process.pid}.log`);
  try {
    fs.writeFileSync(logPath, output);
    const result = spawnSync(npxCmd, ['tsx', 'scripts/ciTestAnnotations.ts', logPath], {
      cwd: root,
      shell: isWindows,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) {
      console.error('ci-test-annotations: could not run the annotation step:', result.error.message);
    }
  } catch (err) {
    console.error('ci-test-annotations: could not write this run\'s output:', err?.message || err);
  } finally {
    try {
      fs.unlinkSync(logPath);
    } catch {
      /* best effort: a leftover temp file is harmless */
    }
  }
}

suite.on('close', (code) => {
  if (code !== 0) {
    runDbHygiene('cleanup');
    annotateFailures(Buffer.concat([...chunks, ...stderrChunks]).toString('utf8'));
    process.exit(code ?? 1);
  }

  // The runner's summary: "ℹ tests N" (spec reporter) or "# tests N" (tap).
  const output = Buffer.concat(chunks)
    .toString('utf8')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '');
  const read = (pattern) => {
    const match = output.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const realCount = read(/ℹ tests (\d+)/) ?? read(/# tests (\d+)/);
  if (realCount === null) {
    console.error(
      'docs-count gate: could not read the suite size from the test runner output — refusing to skip the gate.'
    );
    process.exit(1);
  }

  if (shard) {
    const summary = {
      shard,
      tests: realCount,
      pass: read(/ℹ pass (\d+)/) ?? read(/# pass (\d+)/) ?? 0,
      fail: read(/ℹ fail (\d+)/) ?? read(/# fail (\d+)/) ?? 0,
      skipped: read(/ℹ skipped (\d+)/) ?? read(/# skipped (\d+)/) ?? 0,
    };
    const summaryPath = process.env.TEST_SUMMARY_PATH;
    if (!summaryPath) {
      console.error('test runner: TEST_SHARD is set but TEST_SUMMARY_PATH is missing — cannot aggregate the docs gate.');
      process.exit(1);
    }
    fs.writeFileSync(summaryPath, JSON.stringify(summary) + '\n');
    console.log(
      `test shard ${shard}: ${summary.tests} tests (${summary.pass} pass, ${summary.fail} fail, ${summary.skipped} skipped)`
    );
    runDbHygiene('cleanup');
    process.exit(0);
  }

  const gate = spawnSync(npxCmd, ['tsx', 'scripts/docsTestCounts.ts', String(realCount)], {
    cwd: root,
    shell: isWindows,
    env: spawnEnv,
    stdio: 'inherit',
  });
  runDbHygiene('cleanup');
  process.exit(gate.status ?? 1);
});
