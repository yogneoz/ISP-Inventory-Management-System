/**
 * C4 regression guard: BS (Nepali calendar) display dates must come from
 * bs_day_records (via server/src/utils/bsDate.ts), never from hardcoded
 * string literals. A hardcoded date is wrong for every day except one, and
 * it silently corrupts ledger/audit display dates when calendar seeding
 * changes.
 *
 * Scans every .ts file under server/src for QUOTED 'YYYY-MM-DD BS' literals
 * and fails for any occurrence outside the allowlist:
 *   - server/src/utils/bsDate.ts      — the sanctioned single-source fallback
 *                                       constant (BS_DATE_FALLBACK) and docs
 *   - server/src/config/seedData.ts   — legitimate fiscal-year seed rows
 *                                       (stored historical calendar data,
 *                                       not display fallbacks)
 *
 * Only quoted literals are flagged: prose like the bsCalendar mismatch hint
 * ("...send dateBS=2083-05-14 BS") is educational text, not a value the code
 * stores, and must stay legal. This also future-proofs the guard beyond the
 * original 2083-04-16/22 offenders: ANY fixed BS date literal is the same
 * mistake.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HardcodedBsDateViolation {
  file: string;
  line: number;
  snippet: string;
}

/** Quoted BS date literal: 'YYYY-MM-DD BS' / "..." / `...` as a whole value. */
const QUOTED_BS_DATE = /(['"`])(\d{4}-\d{2}-\d{2}) BS\1/g;

/** Files allowed to contain quoted BS date literals — paths relative to
 *  server/src, POSIX-normalized (absolute inputs are relativized first). */
const ALLOWLIST = new Set([
  'utils/bsDate.ts',
  'config/seedData.ts',
]);

/** Pure detection core: scan a list of {file, source} pairs for violations.
 *  Absolute paths under serverRoot are relativized (POSIX separators) before
 *  allowlist matching, so callers may pass absolute or relative paths. */
export function findHardcodedBsDates(
  sources: Array<{ file: string; source: string }>,
  serverRoot?: string
): HardcodedBsDateViolation[] {
  const violations: HardcodedBsDateViolation[] = [];
  for (const { file, source } of sources) {
    let normalized = file.split(path.sep).join('/');
    if (serverRoot) {
      const rootPrefix = serverRoot.split(path.sep).join('/').replace(/\/$/, '') + '/';
      if (normalized.startsWith(rootPrefix)) {
        normalized = normalized.slice(rootPrefix.length);
      }
    }
    if (ALLOWLIST.has(normalized)) continue;
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      QUOTED_BS_DATE.lastIndex = 0;
      const match = QUOTED_BS_DATE.exec(lines[i]);
      if (match) {
        violations.push({ file: normalized, line: i + 1, snippet: match[0] });
      }
    }
  }
  return violations;
}

/** Recursively collect .ts files under a directory (absolute paths). */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SERVER_SRC = path.resolve(process.cwd(), 'server', 'src');

describe('C4 guard: no hardcoded BS date literals in server code', () => {
  describe('findHardcodedBsDates (pure core)', () => {
    test('flags quoted YYYY-MM-DD BS literals with file and line', () => {
      const violations = findHardcodedBsDates([
        { file: 'server/src/controllers/a.ts', source: "const x = '2083-04-16 BS';" },
        { file: 'server/src/controllers/b.ts', source: 'const y = "2083-04-22 BS";' },
      ]);
      assert.equal(violations.length, 2);
      assert.equal(violations[0].file, 'server/src/controllers/a.ts');
      assert.equal(violations[0].line, 1);
      assert.equal(violations[0].snippet, "'2083-04-16 BS'");
      assert.equal(violations[1].snippet, '"2083-04-22 BS"');
    });

    test('flags the right line in multi-line sources', () => {
      const violations = findHardcodedBsDates([
        { file: 'server/src/controllers/c.ts', source: 'const ok = 1;\nconst bad = `2083-04-28 BS`;\nconst ok2 = 2;' },
      ]);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].line, 2);
    });

    test('ignores dates without the BS suffix and non-date numbers', () => {
      const violations = findHardcodedBsDates([
        { file: 'server/src/controllers/d.ts', source: "const ad = '2083-04-16'; const doc = 'DOC-2083-04-16';" },
      ]);
      assert.equal(violations.length, 0);
    });

    test('ignores unquoted BS date mentions in prose or template text', () => {
      const violations = findHardcodedBsDates([
        { file: 'server/src/config/bsCalendar.ts', source: 'return `...e.g. send dateAD=2026-08-30 and dateBS=2083-05-14 BS.`;' },
        { file: 'server/src/controllers/e.ts', source: '// previously hardcoded 2083-04-16 BS here' },
      ]);
      assert.equal(violations.length, 0);
    });

    test('allowlist skips the sanctioned fallback and seed files', () => {
      const violations = findHardcodedBsDates([
        { file: 'server/src/utils/bsDate.ts', source: "export const BS_DATE_FALLBACK = '2083-04-16 BS';" },
        { file: 'server/src/config/seedData.ts', source: "startDateBS: '2083-04-01 BS', endDateBS: '2083-12-31 BS'," },
        { file: 'server/src/controllers/f.ts', source: "const bad = '2083-04-16 BS';" },
      ], 'server/src');
      assert.equal(violations.length, 1);
      assert.equal(violations[0].file, 'controllers/f.ts');
    });
  });

  test('live tree: server/src contains zero hardcoded BS date literals', () => {
    const files = collectTsFiles(SERVER_SRC);
    assert.ok(files.length >= 20, `expected to scan a real tree, got ${files.length} files`);
    const sources = files.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
    const violations = findHardcodedBsDates(sources, SERVER_SRC);
    assert.deepEqual(
      violations,
      [],
      `Hardcoded BS date literals found — resolve them from bs_day_records via
server/src/utils/bsDate.ts (resolveBsDateForLedger / todayBs / BS_DATE_FALLBACK):
${violations.map((v) => `  ${v.file}:${v.line} → ${v.snippet}`).join('\n')}`
    );
  });
});
