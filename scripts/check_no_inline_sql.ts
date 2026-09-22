/**
 * Repo-layer guard: fails when a controller contains raw SQL literals or
 * bypasses the shared database layer.
 *
 * Architecture rules enforced here (branch refactor/psql-only-reads):
 *  1. Every SQL string and param builder lives in server/src/models/*.repo.ts;
 *     controllers keep only HTTP concerns and execute repo-owned constants.
 *  2. Controllers never acquire connections or manage transactions directly —
 *     pgPool.connect() / realPoolInstance.connect() and hand-rolled
 *     BEGIN/COMMIT/ROLLBACK belong in withTransaction/withConnection (app.ts).
 *
 * The detection core (`findInlineSql`, `findConnectionViolations`) is pure
 * string→violations so the unit tests in tests/no_inline_sql.guard.test.ts
 * can exercise it against synthetic sources. The CLI entry (`runAsScript`)
 * scans the real controllers directory and exits non-zero on any violation.
 *
 * SQL detection is lexical (no TS parser dependency): it walks the source
 * character-by-character, tracks template-literal / string / comment state,
 * and flags string-literal bodies that look like SQL. String interpolations
 * (`${...}`) are skipped so suffix concatenation like
 * `SELECT ... FROM t` + whereClause(conds) is attributed to the literal
 * head, while expressions that merely reference repo constants
 * (`someQuery.sql`) are not themselves SQL text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InlineSqlViolation {
  file: string;
  line: number;
  snippet: string;
}

interface RawMatch {
  offset: number;
  text: string;
  quote: '`' | "'" | '"';
}

/**
 * Keyword heads with the SQL structure each requires somewhere in the body.
 * Requiring the structural tail keeps English prose that merely begins with
 * a keyword ("UPDATE your password from the profile page.") from tripping
 * the guard, while every real statement carries the pair.
 */
const SQL_PATTERNS: Array<{ head: string; requires?: string }> = [
  { head: 'SELECT', requires: ' FROM ' },
  { head: 'INSERT', requires: ' INTO ' },
  { head: 'UPDATE', requires: ' SET ' },
  { head: 'DELETE', requires: ' FROM ' },
  { head: 'WITH ', requires: ') AS (' },
  { head: 'CREATE TABLE' },
  { head: 'CREATE INDEX' },
  { head: 'ALTER TABLE' },
];

/** Comments and strings that must not be treated as code content. */
const LINE_COMMENT = '//';
const BLOCK_COMMENT_START = '/*';
const BLOCK_COMMENT_END = '*/';

/**
 * Extracts string/template literal bodies from source, tracking state across
 * the whole file so SQL-looking text inside comments or interpolations does
 * not produce false positives.
 *
 * Template-literal interpolations (`${ ... }`) are skipped wholesale — their
 * nested strings may legitimately mention SQL (e.g. fallback messages) while
 * the static template chunks remain subject to detection.
 */
function extractLiteralBodies(source: string): RawMatch[] {
  const matches: RawMatch[] = [];
  let i = 0;
  const stack: Array<"`" | "'" | '"'> = [];

  const isEscaped = (idx: number): boolean => {
    let backslashes = 0;
    let j = idx - 1;
    while (j >= 0 && source[j] === '\\') {
      backslashes++;
      j--;
    }
    return backslashes % 2 === 1;
  };

  // Skips an interpolation whose '$' sits at `start`, returning the index
  // just past the matching '}'. Handles nested strings and templates inside
  // the expression with its own quote stack.
  const skipInterpolation = (start: number): number => {
    let depth = 0;
    let j = start + 1; // positioned at '{'
    const qstack: Array<"`" | "'" | '"'> = [];
    while (j < source.length) {
      const c = source[j];
      if (qstack.length > 0) {
        const q = qstack[qstack.length - 1];
        if (c === q && !isEscaped(j)) qstack.pop();
        else if (q === '`' && c === '$' && source[j + 1] === '{') {
          j = skipInterpolation(j);
          continue;
        }
        j++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return j + 1;
      } else if (c === '`' || c === "'" || c === '"') qstack.push(c as '`' | "'" | '"');
      j++;
    }
    return j; // unterminated — bail out at EOF
  };

  while (i < source.length) {
    // Comments: consume wholesale.
    if (source.startsWith(LINE_COMMENT, i) && stack.length === 0) {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith(BLOCK_COMMENT_START, i) && stack.length === 0) {
      const end = source.indexOf(BLOCK_COMMENT_END, i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    const ch = source[i];

    // Inside a template literal: jump over `${ ... }` without capturing.
    if (stack.length > 0 && stack[stack.length - 1] === '`' && ch === '$' && source[i + 1] === '{') {
      i = skipInterpolation(i);
      continue;
    }

    if (ch === '`' || ch === "'" || ch === '"') {
      if (stack.length > 0 && stack[stack.length - 1] === ch && !isEscaped(i)) {
        // Closing quote — the literal body just ended.
        stack.pop();
        i++;
        continue;
      }
      stack.push(ch as '`' | "'" | '"');
      matches.push({ offset: i, text: '', quote: ch as '`' | "'" | '"' });
      i++;
      continue;
    }

    if (stack.length > 0) {
      matches[matches.length - 1].text += ch;
    }
    i++;
  }

  return matches.filter((m) => m.text.length > 0 && stack.length === 0);
}

/** True when the literal body looks like raw SQL. */
export function looksLikeSql(literalBody: string): boolean {
  const normalized = literalBody.replace(/\s+/g, ' ').trimStart().toUpperCase();
  return SQL_PATTERNS.some(
    (p) => normalized.startsWith(p.head.toUpperCase()) && (!p.requires || normalized.includes(p.requires))
  );
}

/** Line number (1-based) for a character offset. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Connection / transaction bypass detection
// ---------------------------------------------------------------------------

/**
 * Lexical pattern (regex over raw source, comments stripped) matching direct
 * connection acquisition or pool-level transaction control in controllers.
 * These must go through withTransaction/withConnection (app.ts) so rollback
 * and release are handled in one audited place.
 */
const CONNECTION_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /\b(?:pgPool|realPoolInstance|pool)\s*\.\s*connect\s*\(/g, message: 'direct pool connect() — use withTransaction/withConnection (app.ts)' },
  { re: /\b(?:client|conn|connection)\s*\.\s*query\s*\(\s*['"`]\s*(?:BEGIN|COMMIT|ROLLBACK)\b/gi, message: 'hand-rolled transaction control — use withTransaction (app.ts)' },
  { re: /\bpgPool\s*\.\s*query\s*\(\s*['"`]\s*(?:BEGIN|COMMIT|ROLLBACK)\b/gi, message: 'pool-level BEGIN/COMMIT/ROLLBACK spans separate connections and is never atomic — use withTransaction (app.ts)' },
];

/**
 * Strips comments from source so guard patterns never match prose.
 * Reuses the same lexical discipline as extractLiteralBodies (simplified:
 * strings are left intact — the connection patterns only match identifiers
 * and the BEGIN/COMMIT/ROLLBACK keywords, which do not appear in strings
 * outside of real transaction calls in practice).
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source.startsWith(LINE_COMMENT, i)) {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith(BLOCK_COMMENT_START, i)) {
      const end = source.indexOf(BLOCK_COMMENT_END, i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

export interface ConnectionViolation {
  file: string;
  line: number;
  snippet: string;
  rule: string;
}

/**
 * Pure detection core: returns one violation per direct connect() or
 * BEGIN/COMMIT/ROLLBACK call in the given controller source.
 */
export function findConnectionViolations(source: string, fileLabel: string): ConnectionViolation[] {
  const violations: ConnectionViolation[] = [];
  const code = stripComments(source);
  for (const { re, message } of CONNECTION_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      violations.push({
        file: fileLabel,
        line: lineOf(code, m.index),
        snippet: m[0],
        rule: message,
      });
      if (m.index === re.lastIndex) re.lastIndex++; // zero-length guard
    }
  }
  return violations;
}

/**
 * Pure detection core: returns one violation per SQL-looking string literal
 * in the given controller source.
 */
export function findInlineSql(source: string, fileLabel: string): InlineSqlViolation[] {
  const violations: InlineSqlViolation[] = [];
  for (const match of extractLiteralBodies(source)) {
    if (looksLikeSql(match.text)) {
      violations.push({
        file: fileLabel,
        line: lineOf(source, match.offset),
        snippet: match.text.replace(/\s+/g, ' ').trim().slice(0, 80),
      });
    }
  }
  return violations;
}

/** Recursively collects .ts files under dir (skips nothing else). */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * CLI entry: scans server/src/controllers (or argv paths) and exits 1 when
 * any raw SQL literal is found in a controller.
 */
export function runAsScript(argv: string[] = process.argv.slice(2)): number {
  const targets = argv.length
    ? argv
    : [path.resolve(process.cwd(), 'server', 'src', 'controllers')];

  const files: string[] = [];
  for (const target of targets) {
    if (fs.statSync(target).isDirectory()) files.push(...collectTsFiles(target));
    else files.push(target);
  }

  const violations: InlineSqlViolation[] = [];
  const connectionViolations: ConnectionViolation[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    violations.push(...findInlineSql(source, path.relative(process.cwd(), file)));
    connectionViolations.push(...findConnectionViolations(source, path.relative(process.cwd(), file)));
  }

  if (violations.length > 0 || connectionViolations.length > 0) {
    if (violations.length > 0) {
      console.error(`✖ repo-layer violation: raw SQL found in ${violations.length} place(s):\n`);
      for (const v of violations) {
        console.error(`  ${v.file}:${v.line}\n    ${v.snippet}\n`);
      }
    }
    if (connectionViolations.length > 0) {
      console.error(`✖ repo-layer violation: direct connection/transaction control found in ${connectionViolations.length} place(s):\n`);
      for (const v of connectionViolations) {
        console.error(`  ${v.file}:${v.line}\n    ${v.snippet}\n    rule: ${v.rule}\n`);
      }
    }
    console.error('Move SQL strings and param builders into server/src/models/*.repo.ts and use withTransaction/withConnection from app.ts for connections and transactions.');
    return 1;
  }

  console.log(`✅ No raw SQL literals in ${files.length} controller file(s).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check_no_inline_sql.ts')) {
  process.exit(runAsScript());
}
