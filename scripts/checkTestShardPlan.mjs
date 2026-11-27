/**
 * Guard: the committed shard plan must be complete and reproducible.
 *
 * Two failures it exists to make loud, both of which would otherwise be silent:
 *
 *   1. a test file in tests/ that the plan does not mention — under the old
 *      `--test-shard` glob a new file was picked up automatically, but a
 *      checked-in plan is a list, and a list can go stale. A file missing here
 *      would simply never run in CI;
 *   2. a plan that is not the allocation `shards:build` produces from the
 *      committed durations — a hand edit, a stale duration table, or a changed
 *      shard count. Regenerating must be a no-op.
 *
 * Runs in the static-checks job, so it fails before any shard starts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAN_FILE,
  allocate,
  coverageErrors,
  listTestFiles,
  readDurations,
} from './testShardPlan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (message) => failures.push(message);

const testFiles = listTestFiles(root);
const plan = JSON.parse(fs.readFileSync(path.join(root, PLAN_FILE), 'utf8'));
const planShards = Array.isArray(plan?.shards) ? plan.shards : [];

// 1. every test file appears in exactly one shard, and nothing else appears.
const appearances = new Map();
for (const shard of planShards) {
  for (const file of Array.isArray(shard?.files) ? shard.files : []) {
    appearances.set(file, (appearances.get(file) ?? 0) + 1);
  }
}
const known = new Set(testFiles);
for (const file of testFiles) {
  const count = appearances.get(file) ?? 0;
  if (count === 0) {
    fail(`${file} is in tests/ but not in ${PLAN_FILE} — it would never run in CI (run \`npm run shards:build\`)`);
  } else if (count > 1) {
    fail(`${file} is assigned to ${count} shards — it would run more than once`);
  }
}
for (const file of appearances.keys()) {
  if (!known.has(file)) fail(`${PLAN_FILE} lists ${file}, which is not a test file any more`);
}

// 2. the plan is the exact allocation the generator would produce now.
const { byFile, errors } = readDurations(root);
const durationProblems = [...errors, ...coverageErrors(testFiles, byFile)];
for (const problem of durationProblems) fail(problem);

if (durationProblems.length === 0) {
  const shardCount = Number(plan?.shardCount);
  if (shardCount !== 6) {
    fail(`${PLAN_FILE} holds ${plan?.shardCount} shards but the CI matrix runs 6 (see .github/workflows/ci.yml)`);
  } else {
    const fresh = allocate(testFiles, byFile, shardCount);
    const stored = planShards.map((shard) => ({
      shard: Number(shard?.shard),
      files: Array.isArray(shard?.files) ? shard.files : [],
      totalMs: Number(shard?.totalMs),
    }));
    if (JSON.stringify(fresh) !== JSON.stringify(stored)) {
      fail(`${PLAN_FILE} is not the allocation rebuilt from scripts/testDurations.json — run \`npm run shards:build\` and commit the result`);
    }
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`✖ ${message}`);
  console.error(`\nshard plan: ${failures.length} failure(s).`);
  process.exit(1);
}

const totals = planShards.map((shard) => Number(shard.totalMs));
const max = Math.max(...totals);
const min = Math.min(...totals);
console.log(
  `shard plan: ${testFiles.length} files across ${planShards.length} shards, ` +
    `${(totals.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s measured, max/min ${(max / min).toFixed(2)}`
);
