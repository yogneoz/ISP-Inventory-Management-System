/**
 * Repo-layer guard: a controller must await its audit write.
 *
 * `logAuditEvent` returns `AuditLog | Promise<AuditLog>` and its insert is only
 * guaranteed to be committed when the caller awaits it. A bare
 * `logAuditEvent(...)` statement answers the HTTP request first, so a reader
 * that arrives straight after the response (the suite, an auditor, the next
 * request) can miss a row the 200 had just claimed. That race was real: it
 * failed `permissionOverrides.test.ts` on Linux while passing on a slower host,
 * and 56 write paths in the admin, master-data and inventory controllers had
 * the same shape. This guard keeps it from coming back silently.
 *
 * The detection core (`findUnawaitedAuditCalls`) is a pure string->violations
 * function so tests/auditAwait.guard.test.ts can exercise it against synthetic
 * sources. The CLI entry (`runAsScript`) scans server/src/controllers and exits
 * non-zero on any violation; `npm run check:audit-await` runs it in CI's
 * static-checks job next to the other convention gates.
 *
 * Detection is lexical (no TS parser dependency). Comments and string literals
 * are masked out first — with template interpolations kept as code — so prose
 * that merely mentions `logAuditEvent` never trips the guard while a call
 * inside an interpolation still does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AuditAwaitViolation {
  file: string;
  line: number;
  snippet: string;
}

/** A call site, wherever it appears. */
const CALL_PATTERN = /(?<![\w$.])logAuditEvent\s*\(/g;

/**
 * Preceding tokens that mean the call is part of a larger expression rather
 * than a statement of its own: `const row = logAuditEvent(...)`,
 * `Promise.all([logAuditEvent(...)])`, `cond => logAuditEvent(...)`.
 *
 * `return` is deliberately NOT on this list: `return logAuditEvent(...)` hands
 * the promise to Express, which answers the request without waiting for it —
 * the very race this guard exists to catch.
 */
const EXPRESSION_CONTEXT = /(?:=|\(|\[|,|=>|\bvoid)$/;

/**
 * Replaces comments and string literals with spaces (newlines preserved) so
 * offsets and line numbers stay exact. Template interpolations (`${...}`) are
 * emitted as code: a call written inside one is still a call.
 */
export function maskCommentsAndStrings(source: string): string {
  const out: string[] = [];
  type State = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';
  let state: State = 'code';
  /** Brace depth inside each open `${ ... }`, innermost last. */
  const interpolationDepths: number[] = [];
  let i = 0;

  const emit = (text: string) => out.push(text);

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line-comment';
        emit('  ');
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block-comment';
        emit('  ');
        i += 2;
        continue;
      }
      if (c === "'") {
        state = 'single';
        emit(' ');
        i += 1;
        continue;
      }
      if (c === '"') {
        state = 'double';
        emit(' ');
        i += 1;
        continue;
      }
      if (c === '`') {
        state = 'template';
        emit(' ');
        i += 1;
        continue;
      }
      if (interpolationDepths.length > 0) {
        const depth = interpolationDepths.pop() as number;
        if (c === '{') {
          interpolationDepths.push(depth + 1);
        } else if (c === '}') {
          if (depth === 0) {
            // Close of `${ ... }` — back inside the template literal.
            state = 'template';
            emit(c);
            i += 1;
            continue;
          }
          interpolationDepths.push(depth - 1);
        }
      }
      emit(c);
      i += 1;
      continue;
    }

    if (state === 'line-comment') {
      if (c === '\n') {
        state = 'code';
        emit('\n');
      } else {
        emit(' ');
      }
      i += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (c === '*' && next === '/') {
        state = 'code';
        emit('  ');
        i += 2;
        continue;
      }
      emit(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }

    // Inside a string literal: an escape consumes the next character, and an
    // escaped newline keeps its line break so numbering stays exact.
    if (c === '\\') {
      emit(source[i + 1] === '\n' ? '\n ' : '  ');
      i += 2;
      continue;
    }
    if (state === 'template' && c === '$' && next === '{') {
      // Interpolation: the expression inside is code again.
      interpolationDepths.push(0);
      state = 'code';
      emit('  ');
      i += 2;
      continue;
    }
    const close = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (c === close) {
      state = 'code';
      emit(' ');
      i += 1;
      continue;
    }
    emit(c === '\n' ? '\n' : ' ');
    i += 1;
  }

  return out.join('');
}

/**
 * Every `logAuditEvent(` in `source` that is not awaited, with its line and the
 * offending snippet. `file` is only echoed back into the violation.
 */
export function findUnawaitedAuditCalls(source: string, file: string): AuditAwaitViolation[] {
  const maskedLines = maskCommentsAndStrings(source).split('\n');
  // The report quotes the REAL line: the masked copy blanks every string
  // argument, and a violation message that hides the action it is about is
  // useless to the person fixing it.
  const originalLines = source.split('\n');
  const violations: AuditAwaitViolation[] = [];

  maskedLines.forEach((line, index) => {
    CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CALL_PATTERN.exec(line)) !== null) {
      const before = line.slice(0, match.index).trimEnd();
      if (/\bawait$/.test(before)) continue;
      if (EXPRESSION_CONTEXT.test(before)) continue;
      violations.push({
        file,
        line: index + 1,
        snippet: (originalLines[index] ?? line).trim(),
      });
    }
  });

  return violations;
}

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
 * CLI entry: scans server/src/controllers (or argv paths) and exits 1 when any
 * audit call is not awaited.
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

  const violations = files.flatMap((file) =>
    findUnawaitedAuditCalls(fs.readFileSync(file, 'utf8'), path.relative(process.cwd(), file))
  );

  if (violations.length > 0) {
    console.error(`✖ repo-layer violation: audit write not awaited in ${violations.length} place(s):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}\n    ${v.snippet}\n`);
    }
    console.error(
      'Await logAuditEvent(...) before responding: the insert must be committed before the response claims the change.'
    );
    return 1;
  }

  console.log(`✅ Every logAuditEvent call is awaited in ${files.length} controller file(s).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check_audit_await.ts')) {
  process.exit(runAsScript());
}
