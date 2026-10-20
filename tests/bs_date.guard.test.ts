/**
 * C4 regression guard: BS (Nepali calendar) dates must come from the calendar —
 * bs_day_records on the server (via server/src/utils/bsDate.ts) and the synced
 * mirror in the browser (client/src/utils/nepaliCalendar.ts) — never from a
 * hardcoded string literal. A hardcoded date is wrong for every day except one,
 * and it silently corrupts ledger/audit display dates when calendar seeding
 * changes.
 *
 * BOTH trees are scanned now, each for the failure mode it actually has:
 *   - server/src (.ts) — QUOTED 'YYYY-MM-DD BS' literals, which is how the old
 *     BS_DATE_FALLBACK = '2083-04-16 BS' dated ledgers and audit rows.
 *   - client/src (.ts AND .tsx) — the client twin of the same mistake: a screen
 *     or utility that fills a BS field with a fixed date instead of converting
 *     (it was `formattedBSShort: '2083-04-16 BS'` in the calendar utility, which
 *     also reached STORED BS columns through CustomersManagement).
 *
 * Allowlists, per tree, root-relative:
 *   - server/src/utils/bsDate.ts      — the sanctioned single-source marker
 *                                       constant (BS_NOT_SEEDED) and its docs
 *   - server/src/config/seedData.ts   — legitimate fiscal-year seed rows
 *                                       (stored historical calendar data,
 *                                       not display fallbacks)
 *   - client/src                      — EMPTY ON PURPOSE. The fabricated date
 *                                       lived in client/src/utils/nepaliCalendar.ts,
 *                                       so an allowlist there would have hidden
 *                                       exactly the regression this guard exists
 *                                       for; every client-side BS date goes
 *                                       through formatBSDate / formatDualDate /
 *                                       the BS not seeded marker instead.
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

/** Server files allowed to contain quoted BS date literals — paths relative to
 *  server/src, POSIX-normalized (absolute inputs are relativized first). */
const SERVER_ALLOWLIST = new Set([
  'utils/bsDate.ts',
  'config/seedData.ts',
]);

/** Client files allowed to contain quoted BS date literals. Deliberately EMPTY:
 *  the fabricated fallback that reached stored BS columns lived in
 *  client/src/utils/nepaliCalendar.ts, so exempting any client file would exempt
 *  the one that regressed. */
const CLIENT_ALLOWLIST = new Set<string>();

/** Pure detection core: scan a list of {file, source} pairs for violations.
 *  Absolute paths under `root` are relativized (POSIX separators) before
 *  allowlist matching, so callers may pass absolute or relative paths. */
function scanQuotedBsDates(
  sources: Array<{ file: string; source: string }>,
  root: string | undefined,
  allowlist: Set<string>
): HardcodedBsDateViolation[] {
  const violations: HardcodedBsDateViolation[] = [];
  for (const { file, source } of sources) {
    let normalized = file.split(path.sep).join('/');
    if (root) {
      const rootPrefix = root.split(path.sep).join('/').replace(/\/$/, '') + '/';
      if (normalized.startsWith(rootPrefix)) {
        normalized = normalized.slice(rootPrefix.length);
      }
    }
    if (allowlist.has(normalized)) continue;
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

/** Server tree: server/src/utils/bsDate.ts and config/seedData.ts are exempt. */
export function findHardcodedBsDates(
  sources: Array<{ file: string; source: string }>,
  serverRoot?: string
): HardcodedBsDateViolation[] {
  return scanQuotedBsDates(sources, serverRoot, SERVER_ALLOWLIST);
}

/** Client tree: no exemptions — a literal here is always a fabricated date. */
export function findHardcodedClientBsDates(
  sources: Array<{ file: string; source: string }>,
  clientRoot?: string
): HardcodedBsDateViolation[] {
  return scanQuotedBsDates(sources, clientRoot, CLIENT_ALLOWLIST);
}

/** Recursively collect files with any of the given extensions (absolute paths). */
function collectSourceFiles(dir: string, extensions: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, extensions, out);
    else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const SERVER_SRC = path.resolve(process.cwd(), 'server', 'src');
const CLIENT_SRC = path.resolve(process.cwd(), 'client', 'src');

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
    const files = collectSourceFiles(SERVER_SRC, ['.ts']);
    assert.ok(files.length >= 20, `expected to scan a real tree, got ${files.length} files`);
    const sources = files.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
    const violations = findHardcodedBsDates(sources, SERVER_SRC);
    assert.deepEqual(
      violations,
      [],
      `Hardcoded BS date literals found — resolve them from bs_day_records via
server/src/utils/bsDate.ts (resolveBsDateForLedger / todayBs / BS_NOT_SEEDED):
${violations.map((v) => `  ${v.file}:${v.line} → ${v.snippet}`).join('\n')}`
    );
  });
});

describe('C4 guard: no hardcoded BS date literals in client code either', () => {
  describe('findHardcodedClientBsDates (pure core)', () => {
    test('flags the fabricated literal in a screen or in the calendar utility', () => {
      // Both were real: the utility returned this date for an unparseable AD
      // value, and CustomersManagement stored the result as a device row's
      // issuedDateBS. Screens are scanned too (.tsx), not just utilities.
      const violations = findHardcodedClientBsDates(
        [
          { file: 'client/src/features/sales/SomeScreen.tsx', source: "const issuedDateBS = '2083-04-16 BS';" },
          { file: 'client/src/utils/nepaliCalendar.ts', source: "      formattedBSShort: '2083-04-16 BS'," },
        ],
        'client/src'
      );
      assert.deepEqual(
        violations.map((v) => `${v.file}:${v.line} ${v.snippet}`),
        [
          "features/sales/SomeScreen.tsx:1 '2083-04-16 BS'",
          "utils/nepaliCalendar.ts:1 '2083-04-16 BS'",
        ]
      );
    });

    test('the client tree has no escape hatch — the calendar utility is scanned too', () => {
      // CLIENT_ALLOWLIST is empty on purpose: the fallback that regressed lived
      // in exactly this file, so an exemption here would hide the regression the
      // guard exists for.
      const violations = findHardcodedClientBsDates(
        [{ file: 'client/src/utils/nepaliCalendar.ts', source: "return { formattedBSShort: '2083-04-16 BS' };" }],
        'client/src'
      );
      assert.equal(violations.length, 1, 'no client file may be exempt from the rule');
      assert.equal(violations[0].file, 'utils/nepaliCalendar.ts');
    });

    test('both trees are judged by the same pattern, so the two rules cannot drift', () => {
      const source = "const d = '2083-04-16 BS';";
      const server = findHardcodedBsDates([{ file: 'server/src/controllers/a.ts', source }], 'server/src');
      const client = findHardcodedClientBsDates([{ file: 'client/src/features/a.tsx', source }], 'client/src');
      assert.equal(server.length, 1);
      assert.equal(client.length, 1);
      assert.equal(server[0].snippet, client[0].snippet, 'one pattern, both trees');
    });

    test('ignores the legal client forms: the marker, AD dates, unquoted prose', () => {
      const violations = findHardcodedClientBsDates([
        { file: 'client/src/features/a.tsx', source: "const x = BS_NOT_SEEDED; const ad = '2026-10-17';" },
        { file: 'client/src/features/b.tsx', source: '// previously hardcoded 2083-04-16 BS before the marker landed' },
        { file: 'client/src/features/c.tsx', source: "if (cleaned.toLowerCase() === 'bs not seeded') return '-';" },
      ]);
      assert.deepEqual(violations, []);
    });
  });

  test('live tree: client/src (.ts and .tsx) contains zero hardcoded BS date literals', () => {
    const files = collectSourceFiles(CLIENT_SRC, ['.ts', '.tsx']);
    assert.ok(files.length >= 100, `expected to scan a real tree, got ${files.length} files`);
    const sources = files.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
    const violations = findHardcodedClientBsDates(sources, CLIENT_SRC);
    assert.deepEqual(
      violations,
      [],
      `Hardcoded BS date literals found in the client — every BS date must come from
the synced calendar mirror (client/src/utils/nepaliCalendar.ts: getBsCalendarData /
formatBSDate / formatDualDate) or be shown as the BS not seeded marker:
${violations.map((v) => `  ${v.file}:${v.line} → ${v.snippet}`).join('\n')}`
    );
  });
});
