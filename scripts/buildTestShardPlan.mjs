/**
 * Writes scripts/testShardPlan.json from the measured duration table.
 *
 * Usage: `npm run shards:build` (optionally `-- 6` for a different shard count).
 *
 * The plan is a pure function of (test file list, durations, shard count), so
 * regenerating it from the same input rewrites the same bytes — which is what
 * `check:shard-plan` asserts on every push. Files are assigned
 * longest-first to the lightest shard, so the few database-heavy suites land on
 * different shards instead of stacking into whichever sixth they sort into.
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
const shardCount = Number(process.argv[2] ?? 6);
if (!Number.isInteger(shardCount) || shardCount < 1) {
  console.error(`shards:build: shard count must be a positive integer, got "${process.argv[2]}"`);
  process.exit(2);
}

const testFiles = listTestFiles(root);
const { byFile, errors } = readDurations(root);
const problems = [...errors, ...coverageErrors(testFiles, byFile)];
if (problems.length > 0) {
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error('\nshards:build: refusing to write a plan that does not cover every test file.');
  process.exit(1);
}

const shards = allocate(testFiles, byFile, shardCount);
const totalMs = shards.reduce((sum, shard) => sum + shard.totalMs, 0);
const plan = { shardCount, fileCount: testFiles.length, totalMs, shards };
fs.writeFileSync(path.join(root, PLAN_FILE), JSON.stringify(plan, null, 2) + '\n');

for (const shard of shards) {
  console.log(
    `shard ${shard.shard}: ${String(shard.files.length).padStart(3)} file(s)  ` +
      `${(shard.totalMs / 1000).toFixed(1)} s`
  );
}
const totals = shards.map((shard) => shard.totalMs);
const max = Math.max(...totals);
const min = Math.min(...totals);
console.log(
  `plan: ${testFiles.length} files, ${(totalMs / 1000).toFixed(1)} s measured, ` +
    `max/min ${(max / min).toFixed(2)}`
);
