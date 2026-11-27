/**
 * Per-file duration reporter — the input the shard plan is built from.
 *
 * `--test-shard` splits by file COUNT, so a shard that happens to hold the
 * database-heavy suites runs twice as long as its neighbour and the workflow
 * waits for the slowest one. Balancing needs real numbers, and the only honest
 * source is a real run: this reporter takes the duration node:test already
 * measures for each file's root suite and writes one table.
 *
 * Loaded only when the runner sets TEST_DURATIONS_PATH, so a normal `npm test`
 * is unchanged. Writes nothing to the stream it is handed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default async function* durationReporter(source) {
  const byFile = new Map();
  for await (const event of source) {
    const data = event?.data ?? {};
    const absolute = typeof data.file === 'string' ? data.file.split(String.fromCharCode(92)).join('/') : '';
    // node:test hands back absolute paths; the plan and the guard compare
    // repo-relative ones.
    const file = absolute.startsWith(root + '/') ? absolute.slice(root.length + 1) : absolute;
    const ms = Number(data?.details?.duration_ms);
    if (!file || !Number.isFinite(ms)) continue;
    // A file's root suite is the widest span; its tests are nested inside it,
    // so the maximum per file is that file's wall time.
    if (ms > (byFile.get(file) ?? 0)) byFile.set(file, ms);
  }

  const out = process.env.TEST_DURATIONS_PATH;
  if (!out) return;
  const files = [...byFile.entries()]
    .map(([file, durationMs]) => ({ file, durationMs: Math.round(durationMs) }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  fs.writeFileSync(out, JSON.stringify({ files }, null, 2) + '\n');
}
