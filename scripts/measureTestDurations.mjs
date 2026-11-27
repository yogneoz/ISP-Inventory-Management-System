/**
 * Measures every test file's wall time into scripts/testDurations.json.
 *
 * A thin cross-platform wrapper (the repo has no `cross-env`, and `VAR=x cmd`
 * is not portable to Windows shells) around the normal runner, so the measured
 * run also runs the docs-count gate and the database hygiene steps exactly like
 * `npm test`. Run it when tests are added, removed or made markedly slower, then
 * `npm run shards:build` and commit both files.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['scripts/run_tests.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    TEST_DURATIONS_PATH: path.join(root, 'scripts/testDurations.json'),
    // Bounded on purpose: this workstation has one PostgreSQL, and the
    // default parallelism lets enough partition DDL run at once to exhaust
    // its lock table, which fails suites that have nothing to do with the
    // shard plan. CI needs no such bound — each shard owns a database.
    TEST_CONCURRENCY: process.env.TEST_CONCURRENCY || '4',
  },
});

child.on('close', (code) => process.exit(code ?? 1));
