/**
 * Duration-balanced shard plan — the allocation maths, in one place.
 *
 * Three callers share it so they cannot drift: `buildTestShardPlan.ts` writes
 * the plan, `checkTestShardPlan.ts` recomputes it and fails when the checked-in
 * file disagrees, and `run_tests.mjs` reads the plan to decide which files a
 * shard runs.
 *
 * Rules:
 *   - every tests/*.test.ts file is assigned to exactly one shard; a file with
 *     no measured duration is an error, not a default, so a NEW test file can
 *     never quietly fall out of CI;
 *   - allocation is longest-processing-time-first: files are ordered by
 *     duration (path as the tie-break) and each goes to the lightest shard. On
 *     ties the lowest shard index wins, so the plan is reproducible;
 *   - a shard's files are stored sorted by path, so the file is stable to diff.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DURATIONS_FILE = 'scripts/testDurations.json';
export const PLAN_FILE = 'scripts/testShardPlan.json';

/** Every test file in the repo, as repo-relative POSIX paths. */
export function listTestFiles(root) {
  return fs
    .readdirSync(path.join(root, 'tests'))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => 'tests/' + name);
}

/** The measured duration table, keyed by file. */
export function readDurations(root) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, DURATIONS_FILE), 'utf8'));
  const entries = Array.isArray(raw?.files) ? raw.files : [];
  const byFile = new Map();
  const errors = [];
  for (const entry of entries) {
    const file = String(entry?.file ?? '').split(String.fromCharCode(92)).join('/');
    const durationMs = Number(entry?.durationMs);
    if (!file || !Number.isFinite(durationMs) || durationMs < 0) {
      errors.push('durations: unreadable entry ' + JSON.stringify(entry));
      continue;
    }
    if (byFile.has(file)) {
      errors.push('durations: ' + file + ' is listed more than once');
      continue;
    }
    byFile.set(file, durationMs);
  }
  return { byFile, errors };
}

/** Files with no duration, and durations for files that no longer exist. */
export function coverageErrors(testFiles, byFile) {
  const errors = [];
  const known = new Set(testFiles);
  for (const file of testFiles) {
    if (!byFile.has(file)) {
      errors.push(
        file + ' has no measured duration — rerun `npm run test:durations` ' +
          '(a new test file must never escape the plan)'
      );
    }
  }
  for (const file of byFile.keys()) {
    if (!known.has(file)) {
      errors.push('durations list ' + file + ', which is not a test file any more — rebuild the table');
    }
  }
  return errors;
}

/** Longest-processing-time allocation, deterministic for a given input. */
export function allocate(testFiles, byFile, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shard count must be a positive integer, got ' + shardCount);
  }
  const ordered = [...testFiles].sort((a, b) => {
    const delta = byFile.get(b) - byFile.get(a);
    if (delta !== 0) return delta;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const shards = Array.from({ length: shardCount }, (_, index) => ({
    shard: index + 1,
    files: [],
    totalMs: 0,
  }));
  for (const file of ordered) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.totalMs < target.totalMs) target = shard;
    }
    target.files.push(file);
    target.totalMs += byFile.get(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/** The files a `TEST_SHARD=N/M` run must execute, straight from the plan. */
export function shardFilesFor(root, spec) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(spec ?? '').trim());
  if (!match) throw new Error('invalid TEST_SHARD "' + spec + '" (expected N/M with 1 <= N <= M)');
  const shardNumber = Number(match[1]);
  const shardCount = Number(match[2]);
  if (shardNumber > shardCount) {
    throw new Error('invalid TEST_SHARD "' + spec + '": shard ' + shardNumber + ' of ' + shardCount);
  }
  const plan = JSON.parse(fs.readFileSync(path.join(root, PLAN_FILE), 'utf8'));
  if (Number(plan?.shardCount) !== shardCount) {
    throw new Error(
      'the plan holds ' + plan?.shardCount + ' shards but CI asked for ' + shardCount +
        ' — rebuild it with `npm run shards:build` and update the matrix together'
    );
  }
  const entry = (plan?.shards ?? []).find((shard) => Number(shard?.shard) === shardNumber);
  if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
    throw new Error('the plan has no files for shard ' + shardNumber);
  }
  return entry.files;
}
