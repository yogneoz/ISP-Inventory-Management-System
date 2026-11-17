#!/usr/bin/env node
/**
 * Local CI — the four `.github/workflows/ci.yml` jobs as one command (worklist A8).
 *
 * The repository's only proof that a change is safe lives in GitHub Actions, and
 * reading a run needs a token this machine does not have. That left two bad
 * options: push and hope, or re-type the job steps by hand and forget one. This
 * script is the third option: it runs the same commands, in the same order the
 * workflow implies, against this machine's PostgreSQL, and stops at the first
 * failure with the step that failed named.
 *
 * What it does NOT do: paranoia about drift. `tests/ciLocal.test.ts` asserts
 * that every command listed here still appears in ci.yml, so a workflow step
 * that is added or reworded without this file fails the suite instead of
 * silently diverging.
 *
 * Usage:
 *   npm run ci:local                     # all four jobs (includes the full suite)
 *   npm run ci:local -- --list           # print the jobs and their steps
 *   npm run ci:local -- --only static-checks,build-and-boot-timing
 *   npm run ci:local -- --skip test-suite
 *   npm run ci:local -- --with-browser   # also run the headless-Chrome boot check
 *
 * The boot-timing step needs a browser and a seeded demo account, so it is opt-in
 * here (`--with-browser`); CI runs it on every push. Everything else runs with
 * nothing but Node and PostgreSQL.
 *
 * Databases: the partition job builds its own throwaway database and drops it,
 * so it never touches the dev database named by DATABASE_URL. The build job's
 * fresh-install check does the same. The test job applies the suite to the
 * database in DATABASE_URL, exactly like `npm test`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const ROOT = process.cwd();

/**
 * The environment every step runs in.
 *
 * `.env` carries NODE_ENV=development for the dev server, and this script loads
 * it for DATABASE_URL. Passing that value into `vite build` makes Vite emit the
 * React *development* bundle: measured 420.5 kB startup against 324.1 kB for a
 * production build, with `react-dom.development` in the vendor chunk. CI has no
 * `.env`, so the local runner must not invent one — this is exactly the
 * green-in-CI / red-locally gap A8 exists to close. The build step pins
 * NODE_ENV=production explicitly.
 */
export const BASE_ENV = (() => {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return env;
})();

/** One shell step. `args` are printed verbatim so a failed step is reproducible. */
function step(label, cmd, args = [], env = {}) {
  return { label, cmd, args, env };
}

function npmRun(label, script, extra = []) {
  return step(label, 'npm', ['run', script, ...(extra.length ? ['--', ...extra] : [])]);
}

/**
 * The workflow's four jobs, in dependency order. `partition-window` and
 * `build-and-boot-timing` are independent of each other in CI and run in
 * parallel there; locally they are sequential so one failure stops the run.
 */
export const JOBS = [
  {
    name: 'static-checks',
    workflow: 'static-checks',
    description: 'typecheck plus the repository convention gates (no database needed)',
    steps: [
      step('typecheck', 'npx', ['tsc', '--noEmit']),
      npmRun('no raw SQL in controllers', 'check:no-inline-sql'),
      npmRun('no native dialogs', 'check:no-raw-dialogs'),
      step('production dependency audit', 'npm', ['audit', '--omit=dev']),
    ],
  },
  {
    name: 'partition-window',
    workflow: 'partition-window',
    description: 'schema, partition provisioning, the alarm and its negative control',
    throwawayDatabase: 'inventory_ci_local_partitions',
    steps: [
      step('provision, alarm and negative control', 'bash', ['scripts/partition_alarm.sh']),
    ],
  },
  {
    name: 'build-and-boot-timing',
    workflow: 'build-and-boot-timing',
    description: 'fresh-install parity, production build, startup budget (and optionally boot timing)',
    steps: [
      step('fresh-install proof', 'node', ['scripts/verify_fresh_install.mjs']),
      // Production explicitly: see BASE_ENV — a leaked NODE_ENV=development
      // from .env doubles the React vendor chunk.
      step('build client and server bundles', 'npm', ['run', 'build'], { NODE_ENV: 'production' }),
      npmRun('startup bundle budget', 'check:bundle-budget'),
    ],
    browserStep: {
      label: 'production boot timing (needs a browser and a seeded demo account)',
      cmd: 'npm',
      args: ['run', 'check:boot-timing', '--', '--budget-ms', '12000'],
    },
  },
  {
    name: 'test-suite',
    workflow: 'test-suite',
    description: 'the full suite, the docs-count gate and their shard aggregates',
    steps: [step('full suite', 'node', ['scripts/run_tests.mjs'])],
  },
];

/** Job names, in order, for `--list`. */
export function jobNames() {
  return JOBS.map((job) => job.name);
}

/**
 * Apply `--only` / `--skip`. Unknown names are an error rather than a silent
 * no-op: a typo that quietly ran everything (or nothing) is how a "local CI" run
 * reports a green it never earned.
 */
export function selectJobs({ only = [], skip = [] } = {}) {
  const known = new Set(jobNames());
  for (const name of [...only, ...skip]) {
    if (!known.has(name)) {
      throw new Error(`unknown job ${JSON.stringify(name)} (known: ${jobNames().join(', ')})`);
    }
  }
  let selected = only.length ? JOBS.filter((job) => only.includes(job.name)) : [...JOBS];
  if (skip.length) selected = selected.filter((job) => !skip.includes(job.name));
  if (selected.length === 0) throw new Error('every job was skipped — nothing to run');
  return selected;
}

function parseArgs(argv) {
  const only = [];
  const skip = [];
  let list = false;
  let withBrowser = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') list = true;
    else if (arg === '--with-browser') withBrowser = true;
    else if (arg === '--only' || arg === '--skip') {
      const value = argv[i + 1] ?? '';
      i += 1;
      const names = value.split(',').map((entry) => entry.trim()).filter(Boolean);
      if (!names.length) throw new Error(`${arg} needs a comma-separated job list`);
      (arg === '--only' ? only : skip).push(...names);
    } else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)} — see --help`);
    }
  }
  return { only, skip, list, withBrowser };
}

function runStep(s, env = {}) {
  const started = Date.now();
  const command = [s.cmd, ...s.args].join(' ');
  console.log(`\n$ ${command}`);
  const result = spawnSync(s.cmd, s.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...BASE_ENV, ...env },
    shell: process.platform === 'win32',
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`\n✖ ${s.label} failed (exit ${result.status ?? 'null'}, ${seconds}s)`);
    return false;
  }
  console.log(`✔ ${s.label} (${seconds}s)`);
  return true;
}

function baseDatabaseUrl() {
  return process.env.DATABASE_URL || '';
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/** Create the job's throwaway database from scripts/schema.sql; returns its URL. */
async function createPartitionProbe(url, name) {
  const admin = new pg.Client({ connectionString: withDatabase(url, 'postgres'), connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(async () => {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      );
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    });
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const probeUrl = withDatabase(url, name);
  const client = new pg.Client({ connectionString: probeUrl });
  await client.connect();
  try {
    await client.query(fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8'));
  } finally {
    await client.end();
  }
  return probeUrl;
}

async function dropDatabase(url, name) {
  const admin = new pg.Client({ connectionString: withDatabase(url, 'postgres'), connectionTimeoutMillis: 5000 });
  await admin.connect().catch(() => undefined);
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } catch {
    /* best effort: a leftover probe database is not a CI failure */
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function runJob(job, options) {
  console.log(`\n=== ${job.name} — ${job.description}`);
  let probeUrl = null;
  try {
    if (job.throwawayDatabase) {
      const url = baseDatabaseUrl();
      if (!url) throw new Error('DATABASE_URL is not set — the partition job needs PostgreSQL');
      probeUrl = await createPartitionProbe(url, job.throwawayDatabase);
    }
    const env = probeUrl ? { DATABASE_URL: probeUrl } : {};
    for (const s of job.steps) {
      if (!runStep(s, env)) return false;
    }
    if (job.browserStep) {
      if (options.withBrowser) {
        if (!runStep(job.browserStep)) return false;
      } else {
        console.log(`\n… skipped ${job.browserStep.label} — re-run with --with-browser to include it`);
      }
    }
    return true;
  } finally {
    if (probeUrl) await dropDatabase(baseDatabaseUrl(), job.throwawayDatabase);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const job of JOBS) {
      console.log(`${job.name} (workflow: ${job.workflow}) — ${job.description}`);
      for (const s of job.steps) console.log(`  $ ${[s.cmd, ...s.args].join(' ')}`);
      if (job.browserStep) console.log(`  $ ${[job.browserStep.cmd, ...job.browserStep.args].join(' ')}   [opt-in]`);
    }
    return 0;
  }

  const selected = selectJobs(options);
  const results = [];
  for (const job of selected) {
    const ok = await runJob(job, options);
    results.push({ name: job.name, ok });
    if (!ok) break;
  }

  console.log('\n=== local CI summary');
  for (const result of results) console.log(`${result.ok ? '✔' : '✖'} ${result.name}`);
  for (const job of selected.slice(results.length)) console.log(`- ${job.name} (not run)`);
  const skippedBrowser = selected.some((job) => job.browserStep) && !options.withBrowser;
  if (skippedBrowser) console.log('- boot timing (skipped: --with-browser not passed)');
  if (results.some((result) => !result.ok) || results.length !== selected.length) return 1;
  console.log('\n✔ local CI passed');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`ci:local failed: ${err?.message || err}`);
      process.exit(2);
    });
}
