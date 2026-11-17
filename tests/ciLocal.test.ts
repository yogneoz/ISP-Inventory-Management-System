/**
 * Worklist A8 — local CI truth.
 *
 * `npm run ci:local` exists so a change can be validated without a GitHub
 * token, but a runner whose steps drift from the workflow is worse than none:
 * it reports a green the workflow would not give. These tests pin the invariants
 * that can be checked without running the jobs:
 *
 *   1. it lists exactly the workflow's four jobs;
 *   2. every command it would run is still a command in `.github/workflows/ci.yml`;
 *   3. job selection is strict — an unknown name fails instead of silently
 *      running everything or nothing;
 *   4. a run where every job is skipped is an error, not a green.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const WORKFLOW = readFileSync('.github/workflows/ci.yml', 'utf8');

function listOutput(): string {
  const run = spawnSync(process.execPath, ['scripts/ci_local.mjs', '--list'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function commands(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('  $ '))
    .map((line) => line.slice(4).replace(/\s+\[opt-in\]$/, '').trim());
}

describe('local CI runner (A8)', () => {
  test('lists exactly the workflow jobs', () => {
    const output = listOutput();
    const jobLines = output.split('\n').filter((line) => /\(workflow: [a-z-]+\)/.test(line));
    assert.deepEqual(
      jobLines.map((line) => line.split(' ')[0]),
      ['static-checks', 'partition-window', 'build-and-boot-timing', 'test-suite']
    );
    for (const job of jobLines) {
      const workflowJob = job.match(/\(workflow: ([a-z-]+)\)/)?.[1];
      assert.ok(workflowJob, `job line names its workflow job: ${job}`);
    }
  });

  test('every command it runs is a command in ci.yml', () => {
    const listed = commands(listOutput());
    assert.ok(listed.length >= 10, `expected the four jobs' commands, got ${listed.length}`);
    const missing = listed.filter((command) => !WORKFLOW.includes(command));
    assert.deepEqual(missing, [], `commands missing from ci.yml: ${missing.join(' | ')}`);
  });

  test('every workflow job the runner covers exists in ci.yml', () => {
    const output = listOutput();
    for (const job of ['static-checks', 'partition-window', 'build-and-boot-timing', 'test-suite']) {
      assert.match(WORKFLOW, new RegExp(`\\n  ${job}:`), `ci.yml declares the ${job} job`);
      assert.match(output, new RegExp(`^${job} \\(workflow: ${job}\\)`, 'm'));
    }
  });

  test('the runner does not leak NODE_ENV from .env into the steps', () => {
    // `vite build` with NODE_ENV=development emits the React development bundle
    // (measured 420.5 kB startup vs 324.1 kB production). CI has no .env, so the
    // local runner must not supply one.
    const run = spawnSync(
      process.execPath,
      ['-e', "import('./scripts/ci_local.mjs').then((m) => console.log(JSON.stringify(Object.keys(m.BASE_ENV))))"],
      { encoding: 'utf8' }
    );
    assert.equal(run.status, 0, run.stderr);
    const keys = JSON.parse(run.stdout.trim());
    assert.ok(!keys.includes('NODE_ENV'), 'BASE_ENV must not carry NODE_ENV');
  });

  test('an unknown job name is refused, not ignored', () => {
    const run = spawnSync(process.execPath, ['scripts/ci_local.mjs', '--only', 'static-check'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown job "static-check"/);
  });

  test('skipping every job is an error, not a pass', () => {
    const run = spawnSync(process.execPath, ['scripts/ci_local.mjs', '--skip', 'static-checks,partition-window,build-and-boot-timing,test-suite'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /nothing to run/);
  });
});
