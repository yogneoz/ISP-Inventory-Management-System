/**
 * Worklist A9 — the scale fixture and the measurement script are the only tools
 * that write millions of rows and reindex a BRIN, so their safety contract is
 * part of the deliverable, not a detail:
 *
 *   1. neither will use DATABASE_URL — a fixture that quietly seeds the
 *      application database is a data-loss bug waiting to happen;
 *   2. both refuse a database whose name does not contain `_scale`;
 *   3. `--dry-run` prints the plan and touches nothing;
 *   4. the fixture refuses to write without `--yes`.
 *
 * These are spawned as real processes because that is how the contract is
 * enforced (process exit codes), and they never connect to a database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SAFE_URL = 'postgres://user:pass@localhost:5432/inventory_scale';
const UNSAFE_URL = 'postgres://user:pass@localhost:5432/inventory_db';

function run(script: string, args: string[], env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: SAFE_URL, SCALE_FIXTURE_DATABASE_URL: undefined, ...env },
  });
}

describe('scale fixture safety (A9)', () => {
  test('the fixture never falls back to DATABASE_URL', () => {
    const result = run('scripts/seed_scale_fixture.mjs', ['--yes'], {});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /SCALE_FIXTURE_DATABASE_URL is required/);
  });

  test('the fixture refuses a database that is not a _scale scratch', () => {
    const result = run('scripts/seed_scale_fixture.mjs', ['--yes', '--dry-run'], {
      SCALE_FIXTURE_DATABASE_URL: UNSAFE_URL,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must contain '_scale'/);
  });

  test('a dry run prints the plan and writes nothing', () => {
    const result = run('scripts/seed_scale_fixture.mjs', ['--dry-run'], {
      SCALE_FIXTURE_DATABASE_URL: SAFE_URL,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SCALE-2 fixture plan/);
    assert.match(result.stdout, /journalLines: 10000000/);
    assert.match(result.stdout, /auditLogs: 2000000/);
    assert.match(result.stdout, /dryRun: true/);
  });

  test('the fixture refuses to write without --yes', () => {
    const result = run('scripts/seed_scale_fixture.mjs', [], { SCALE_FIXTURE_DATABASE_URL: SAFE_URL });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Refusing to write millions of rows without --yes/);
  });

  test('the measurement script has the same two guards', () => {
    const missing = run('scripts/measure_scale.mjs', [], {});
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /SCALE_FIXTURE_DATABASE_URL is required/);

    const unsafe = run('scripts/measure_scale.mjs', [], { SCALE_FIXTURE_DATABASE_URL: UNSAFE_URL });
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /must contain '_scale'/);
  });
});
