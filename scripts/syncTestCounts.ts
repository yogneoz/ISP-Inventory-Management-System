/**
 * Rewrites the current-state test-count claims to one number.
 *
 * The docs-count gate (`scripts/docsTestCounts.ts`) fails the run when README,
 * handoff or SESSION_NOTES disagree with the suite's real size, which leaves a
 * manual edit in three files on every change that adds or removes a test. This
 * reuses that gate's own pattern list — not a second, drifting copy — so the
 * sentences it rewrites are exactly the sentences the gate checks. Its tests
 * (`tests/syncTestCounts.guard.test.ts`) pin both halves: the phrases it must
 * touch and the historical ones it must leave alone.
 *
 * Usage: npx tsx scripts/syncTestCounts.ts <count>
 * (`npm run docs:sync-tests -- 2941`). Prints what it changed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOCS_FILES, CURRENT_CLAIM_PATTERNS } from './docsTestCounts';

/** Replace every captured claim number in one line, right-to-left so offsets hold. */
export function rewriteLine(line: string, count: number): { line: string; changed: number } {
  let changed = 0;
  for (const { source } of CURRENT_CLAIM_PATTERNS) {
    const spans: Array<{ start: number; end: number }> = [];
    for (const match of line.matchAll(new RegExp(source, 'g'))) {
      if (match.index === undefined) continue;
      if (match[1] !== undefined) {
        const start = match.index + match[0].indexOf(match[1]);
        spans.push({ start, end: start + match[1].length });
      }
      // "Tests: N/N" claims both halves; the second is the trailing occurrence.
      if (match[2] !== undefined) {
        const offset = match[0].lastIndexOf(match[2]);
        spans.push({ start: match.index + offset, end: match.index + offset + match[2].length });
      }
    }
    spans.sort((a, b) => b.start - a.start);
    for (const span of spans) {
      line = `${line.slice(0, span.start)}${count}${line.slice(span.end)}`;
      changed += 1;
    }
  }
  return { line, changed };
}

/** Rewrite a whole document, keeping its line endings. */
export function syncText(text: string, count: number): { text: string; changed: number } {
  const lines = text.split(/\r?\n/);
  let changed = 0;
  const rewritten = lines.map((line) => {
    const result = rewriteLine(line, count);
    changed += result.changed;
    return result.line;
  });
  return { text: rewritten.join('\n'), changed };
}

function main(): void {
  const root = path.resolve(import.meta.dirname, '..');
  const raw = (process.argv[2] || '').trim();
  const target = Number(raw);

  if (!raw || !Number.isInteger(target) || target <= 0) {
    console.error(`sync-test-counts: expected a positive integer, got "${raw}"`);
    process.exit(2);
  }

  let totalChanged = 0;
  for (const file of DOCS_FILES) {
    const full = path.join(root, file);
    const original = fs.readFileSync(full, 'utf8');
    const { text, changed } = syncText(original, target);
    totalChanged += changed;
    if (changed === 0) {
      console.log(`${file}: no current-state claim found`);
      continue;
    }
    if (text !== original) fs.writeFileSync(full, text);
    console.log(`${file}: ${changed} claim(s) set to ${target}`);
  }

  if (totalChanged === 0) {
    console.error('sync-test-counts: no claim matched — the gate patterns may have changed');
    process.exit(1);
  }
  console.log(`sync-test-counts: ${totalChanged} claim(s) now read ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
