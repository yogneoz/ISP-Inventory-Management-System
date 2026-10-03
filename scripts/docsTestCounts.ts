/**
 * Docs-count gate — run by scripts/run_tests.mjs AFTER the suite passes.
 *
 * Every test-count claim in the project docs that reads as CURRENT STATE
 * ("Tests: N/N" header, "suite now N tests", "N-test suite", the CI-gate
 * lists) must equal the real suite size of the run that just finished.
 * A stale number fails the build instead of silently misleading the next
 * reader (this gate replaced a moment when README, handoff and
 * SESSION_NOTES simultaneously claimed 433, 504, 526, 535, 539 and 548).
 *
 * SCOPE CONTRACT: only the phrasings below claim the current suite size.
 * Historical per-arc records — "449/449 tests pass", "+4 tests -> 380/380",
 * "522 node:test tests", "(3 tests)" per-file counts — are deliberately
 * NOT matched: they document a past run and stay true forever. When adding
 * a pattern, ask: would this sentence be wrong after the next commit adds
 * a test? If yes, it is a current-state claim; if no, leave it out.
 *
 * Usage: tsx scripts/docsTestCounts.ts <realCount>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Docs whose current-state test-count claims are gated. */
export const DOCS_FILES = ['README.md', 'handoff.md', 'SESSION_NOTES.md'] as const;

/** One current-state claim found in a doc. */
export interface CountClaim {
  file: string;
  line: number;
  count: number;
  pattern: string;
}

/**
 * Patterns whose captured number means "the suite, right now". An explicit
 * list — not a generic /\d+ tests/ — so historical records stay legal.
 */
const CURRENT_CLAIM_PATTERNS: { name: string; source: string }[] = [
  { name: 'Tests: N/N header field', source: 'Tests:\\s*(\\d+)\\/(\\d+)' },
  { name: 'suite now N tests', source: '\\b[Ss]uite (?:now|is)\\s+(\\d+)\\s+tests' },
  { name: 'N-test suite', source: '(\\d+)-test suite\\b' },
  { name: 'tree annotation "- N tests;"', source: '—\\s*(\\d+)\\s+tests\\s*;' },
  { name: 'CI gate list "npm test - N tests"', source: 'npm test`\\s*—\\s*(\\d+)\\s+tests' },
];

/** Every current-state test-count claim in `text`, with file:line locations. */
export function findCountClaims(text: string, file = '<text>'): CountClaim[] {
  const claims: CountClaim[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { name, source } of CURRENT_CLAIM_PATTERNS) {
      for (const m of line.matchAll(new RegExp(source, 'g'))) {
        claims.push({ file, line: index + 1, count: Number(m[1]), pattern: name });
        // "Tests: N/N" claims BOTH halves — a split pair is stale too.
        if (m[2] !== undefined) {
          claims.push({
            file,
            line: index + 1,
            count: Number(m[2]),
            pattern: `${name} (2nd half)`,
          });
        }
      }
    }
  });
  return claims;
}

/** All current-state claims across several docs. */
export function collectClaims(docs: { file: string; text: string }[]): CountClaim[] {
  return docs.flatMap(({ file, text }) => findCountClaims(text, file));
}

/** Errors for every claim that disagrees with the real suite size ([] = pass). */
export function checkDocsCounts(
  realCount: number,
  docs: { file: string; text: string }[]
): string[] {
  return collectClaims(docs)
    .filter((claim) => claim.count !== realCount)
    .map(
      (claim) =>
        `${claim.file}:${claim.line} claims ${claim.count} tests but this run executed ` +
        `${realCount} — update the number (or rephrase without a current-suite claim). ` +
        `[${claim.pattern}]`
    );
}

/** CLI entry: tsx scripts/docsTestCounts.ts <realCount> */
if ((process.argv[1] ?? '').endsWith('docsTestCounts.ts')) {
  const realCount = Number(process.argv[2]);
  if (!Number.isInteger(realCount) || realCount <= 0) {
    console.error('usage: tsx scripts/docsTestCounts.ts <realCount>');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const docs = DOCS_FILES.map((file) => ({
    file,
    text: fs.readFileSync(path.join(root, file), 'utf8'),
  }));
  const errors = checkDocsCounts(realCount, docs);
  if (errors.length > 0) {
    console.error(
      `\ndocs-count gate: ${errors.length} stale test-count claim(s) vs the real suite size of ${realCount}:\n`
    );
    for (const error of errors) console.error(`  x ${error}`);
    console.error(
      '\nUpdate each number (SESSION_NOTES header + "suite now" bullets, README CI bullet, handoff tree + gate list).'
    );
    process.exit(1);
  }
  console.log(
    `docs-count gate: ${DOCS_FILES.length} docs scanned - every current-state test count matches ${realCount}.`
  );
}
