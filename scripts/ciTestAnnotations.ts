/**
 * Turns a failing test run's reporter output into GitHub Actions annotations
 * and a job-summary table, so a red CI run is diagnosable from the run page
 * (and from an unauthenticated fetch of it) instead of only from the job log —
 * downloading a job log requires an authenticated API request, which is exactly
 * what made the last red build unreadable from a plain `git`/HTTP workflow.
 *
 * Why a parser instead of a reporter: Node ships spec / tap / dot / junit /
 * lcov reporters and NOT a GitHub one (node:test/reporters has no `github`
 * export in Node 24.20 — `--test-reporter=github` tries to import a *package*
 * named `github` and crashes), so the workflow commands are emitted here.
 *
 * Where it runs: scripts/run_tests.mjs calls this on a non-zero suite exit when
 * GITHUB_ACTIONS is set, passing the reporter output it already captured. It
 * never changes the suite's exit status — the runner exits with the child's own
 * code either way.
 *
 * Pure core + thin CLI. parseFailingTests / parseTotals / toAnnotations /
 * toStepSummary are unit-tested against REAL reporter output captured from
 * `npx tsx --test` (tests/ciTestAnnotations.test.ts), so the parser is pinned to
 * what the runner actually prints rather than to a guess about it.
 */

import fs from 'node:fs';

export interface FailingTest {
  /** Workspace-relative path, POSIX separators — what `::error file=` needs. */
  file: string;
  line: number;
  title: string;
  /** Condensed failure reason (first informative lines, stack frames dropped). */
  reason: string;
}

export interface RunTotals {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
}

/** `✖ <title> (<duration>ms)` — the duration is appended by the reporter. */
const DURATION_SUFFIX = / \(\d+(?:\.\d+)?ms\)$/;
/** `test at tests\foo.test.ts:12:3` / `test at tests/foo.test.ts:12:3`. */
const SPEC_LOCATION = /^test at (.+):(\d+):(\d+)\s*$/;
/** `not ok 2 - <title>` (TAP), optionally indented inside a subtest block. */
const TAP_FAIL = /^\s*not ok \d+ - (.*)$/;
const TAP_LOCATION = /^\s*location: '(.+)'\s*$/;
const TAP_TYPE = /^\s*type: '(test|suite)'\s*$/;
const TAP_ERROR_SCALAR = /^\s*error: (.*)$/;
const TAP_ERROR_BLOCK = /^\s*error: \|-?\s*$/;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^['"].*['"]$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * A field from the error object the reporter dumps after the message —
 * `length: 107,`, `code: '42P01',`, `detail: undefined,`, `generatedMessage:
 * true,` … Those are the reporter's bookkeeping, not the finding, and they are
 * what made a first cut of this annotation read as one long comma salad.
 * Error/Assertion headers are exempt: `error: relation "branches" does not
 * exist` IS the message.
 */
function isStructuredDump(trimmed: string): boolean {
  if (/^(?:AssertionError|TypeError|RangeError|SyntaxError|Error|error)\b/.test(trimmed)) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*\s*:\s/.test(trimmed);
}

/** Drops stack frames, object dumps and other noise from a failure's body. */
function condenseReason(lines: string[]): string {
  const useful: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('at ')) continue; // stack frame
    if (trimmed === '{' || trimmed === '}') continue;
    if (isStructuredDump(trimmed)) continue;
    useful.push(stripQuotes(trimmed));
    if (useful.join(' ').length > 300) break;
  }
  return useful.join(' ').slice(0, 400);
}

/** Splits reporter output into lines, tolerating CRLF output. */
function toLines(output: string): string[] {
  return output.split(/\r?\n/);
}

/**
 * Parses the failing tests out of a Node test-runner report. Handles both
 * reporters the runner can produce: `spec` (the default — `✖ failing tests:`
 * followed by `test at <file>:<line>:<col>` blocks) and `tap` (`not ok N - …`
 * with a `location:` field), because run_tests.mjs accepts either.
 *
 * `workspace` only affects how a reported path becomes the annotation's `file`
 * (annotations must be workspace-relative). It defaults to how the runner
 * resolves it — $GITHUB_WORKSPACE, else the working directory — and the unit
 * tests pass it because they parse a capture made on a DIFFERENT machine, whose
 * absolute paths cannot be relativized against this one.
 */
export function parseFailingTests(output: string, workspace: string = workspaceRoot()): FailingTest[] {
  const lines = toLines(output);
  const spec = parseSpecFailures(lines, workspace);
  return spec.length > 0 ? spec : parseTapFailures(lines, workspace);
}

function parseSpecFailures(lines: string[], workspace: string): FailingTest[] {
  const failures: FailingTest[] = [];
  const summaryStart = lines.findIndex((line) => line.trim() === '✖ failing tests:');
  if (summaryStart === -1) return failures;

  let index = summaryStart + 1;
  while (index < lines.length) {
    const location = lines[index].match(SPEC_LOCATION);
    if (!location) {
      // The summary ends at the first line that is neither a location nor
      // blank; the runner then prints its own counters.
      if (lines[index].trim() === '') {
        index += 1;
        continue;
      }
      break;
    }
    const titleLine = lines[index + 1] ?? '';
    if (!titleLine.trimStart().startsWith('✖ ')) break;

    const body: string[] = [];
    let cursor = index + 2;
    while (cursor < lines.length && !SPEC_LOCATION.test(lines[cursor])) {
      // A line at column 0 that is not blank starts the next section.
      if (lines[cursor].trim() !== '' && !/^\s/.test(lines[cursor])) break;
      body.push(lines[cursor]);
      cursor += 1;
    }

    const rawTitle = titleLine.trim().slice(1).trim(); // strip the marker
    failures.push({
      file: normalizePath(location[1], workspace),
      line: Number(location[2]),
      title: rawTitle.replace(DURATION_SUFFIX, '').trim(),
      reason: condenseReason(body) || 'no reason reported',
    });
    index = cursor;
  }
  return failures;
}

function parseTapFailures(lines: string[], workspace: string): FailingTest[] {
  const failures: FailingTest[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fail = lines[index].match(TAP_FAIL);
    if (!fail) continue;

    // The failure's YAML diagnostics block runs until the closing `...`.
    const block: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === '...') break;
      block.push(lines[cursor]);
    }

    const location = block.map((line) => line.match(TAP_LOCATION)).find(Boolean);
    const type = block.map((line) => line.match(TAP_TYPE)).find(Boolean);
    // Suite entries only aggregate their subtests; the failing subtests are
    // reported individually, so annotating the suite would be a duplicate.
    if (!location || (type && type[1] === 'suite')) {
      index = cursor;
      continue;
    }

    const reasonLines: string[] = [];
    const errorBlockIndex = block.findIndex((line) => TAP_ERROR_BLOCK.test(line));
    if (errorBlockIndex !== -1) {
      for (const line of block.slice(errorBlockIndex + 1)) {
        if (/^\s{6,}\w+:/.test(line)) break; // next structured field
        reasonLines.push(line);
      }
    } else {
      const scalar = block.find((line) => TAP_ERROR_SCALAR.test(line));
      if (scalar) reasonLines.push(stripQuotes(scalar.match(TAP_ERROR_SCALAR)![1]));
    }

    // TAP escapes backslashes inside its quoted scalars.
    const fileAndLine = stripQuotes(location[1]).replace(/\\\\/g, '\\');
    const split = fileAndLine.match(/^(.*):(\d+):(\d+)$/);
    if (!split) {
      index = cursor;
      continue;
    }

    failures.push({
      file: normalizePath(split[1], workspace),
      line: Number(split[2]),
      title: stripQuotes(fail[1]).trim(),
      reason: condenseReason(reasonLines) || 'no reason reported',
    });
    index = cursor;
  }
  return failures;
}

/**
 * Reads the run's totals from either reporter. Returns null when the summary
 * could not be found (an interrupted run prints none) — callers must not invent
 * counts.
 */
export function parseTotals(output: string): RunTotals | null {
  const read = (pattern: RegExp): number | null => {
    const match = output.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const tests = read(/^(?:ℹ|#) tests (\d+)$/m);
  const pass = read(/^(?:ℹ|#) pass (\d+)$/m);
  const fail = read(/^(?:ℹ|#) fail (\d+)$/m);
  const skipped = read(/^(?:ℹ|#) skipped (\d+)$/m);
  if (tests === null || pass === null || fail === null) return null;
  return { tests, pass, fail, skipped: skipped ?? 0 };
}

/** Escapes a workflow-command property value (`,` `:` `%` `\r` `\n`). */
function escapeProperty(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

/** Escapes a workflow-command message body (`%` `\r` `\n`). */
function escapeMessage(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Windows or absolute path -> workspace-relative POSIX path for annotations. */
export function normalizePath(filePath: string, workspace: string = workspaceRoot()): string {
  let path = filePath.split('\\').join('/');
  const root = workspace.split('\\').join('/').replace(/\/+$/, '');
  if (root && path.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    path = path.slice(root.length + 1);
  }
  return path.replace(/^\.\//, '');
}

function workspaceRoot(): string {
  return process.env.GITHUB_WORKSPACE || process.cwd();
}

/**
 * A cancelled subtest carries no reason of its own — the hook or sibling that
 * really failed is annotated separately — so it loses every tie.
 */
function annotationPriority(failure: FailingTest): number {
  return /^test did not finish before its parent/.test(failure.reason) ? 1 : 0;
}

/**
 * One `::error` workflow command per failing test, carrying file/line so the
 * annotation lands on the failing assertion in the diff view.
 *
 * `limit` defaults to the runner's documented budget — about 10 error
 * annotations per step, 50 per job — because anything past it is dropped
 * silently by GitHub. Real reasons are annotated before cancelled subtests, and
 * the step summary (toStepSummary) is the complete channel either way: it lists
 * every failure, so a truncated annotation list costs nothing.
 */
export function toAnnotations(failures: FailingTest[], limit = 10): string[] {
  const ordered = [...failures].sort((a, b) => annotationPriority(a) - annotationPriority(b));
  return ordered.slice(0, limit).map((failure) => {
    const properties = [
      `file=${escapeProperty(failure.file)}`,
      `line=${failure.line}`,
      `title=${escapeProperty(failure.title)}`,
    ].join(',');
    return `::error ${properties}::${escapeMessage(failure.reason)}`;
  });
}

/** Markdown job summary: every failure (in reporter order), plus the totals
 *  when available. This is the channel with no annotation cap, so it is the one
 *  that must always be complete. */
export function toStepSummary(
  failures: FailingTest[],
  totals: RunTotals | null,
  maxRows = 100
): string {
  const lines: string[] = [];
  const headline = totals
    ? `${totals.fail} of ${totals.tests} tests failed (${totals.pass} passed, ${totals.skipped} skipped)`
    : `${failures.length} tests failed`;
  lines.push('## ❌ Test failures', '', headline, '');

  if (failures.length === 0) {
    lines.push(
      'The suite exited non-zero but no failing test could be read from the reporter output.',
      'Open the step log for the raw output.'
    );
    return lines.join('\n');
  }

  lines.push('| Test | Location | Reason |', '| --- | --- | --- |');
  for (const failure of failures.slice(0, maxRows)) {
    const title = failure.title.replace(/\|/g, '\\|');
    const reason = failure.reason.replace(/\|/g, '\\|');
    lines.push(`| ${title} | [\`${failure.file}:${failure.line}\`](${failure.file}#L${failure.line}) | ${reason} |`);
  }
  if (failures.length > maxRows) {
    lines.push('', `… ${failures.length - maxRows} more failing tests (see the step log).`);
  }
  return lines.join('\n');
}

/** Appends the summary to the job's step-summary file when the runner set one. */
function writeStepSummary(summary: string, summaryPath = process.env.GITHUB_STEP_SUMMARY): void {
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, summary + '\n');
  } catch (error: any) {
    console.error(`ci-test-annotations: could not write the step summary: ${error?.message || error}`);
  }
}

/**
 * CLI: `tsx scripts/ciTestAnnotations.ts <reporter-output-file>`.
 * Prints the annotations to stdout and appends the summary table to
 * $GITHUB_STEP_SUMMARY. Exit status is always 0 on a readable file: this step
 * reports on a failure, it never becomes one (the runner exits with the suite's
 * own code).
 */
function main(argv: string[]): void {
  const logPath = argv[0];
  if (!logPath) {
    console.error('usage: tsx scripts/ciTestAnnotations.ts <reporter-output-file>');
    process.exit(2);
    return;
  }

  let output: string;
  try {
    output = fs.readFileSync(logPath, 'utf8');
  } catch (error: any) {
    console.error(`ci-test-annotations: could not read ${logPath}: ${error?.message || error}`);
    process.exit(2);
    return;
  }

  const failures = parseFailingTests(output);
  const totals = parseTotals(output);
  for (const annotation of toAnnotations(failures)) console.log(annotation);
  writeStepSummary(toStepSummary(failures, totals));

  const reported = totals ? `the runner reported ${totals.fail} failing test(s)` : 'the runner printed no totals';
  console.log(
    failures.length > 0
      ? `ci-test-annotations: annotated ${failures.length} failure entr${failures.length === 1 ? 'y' : 'ies'} ` +
        `(cancelled subtests and failed suites are annotated too) — ${reported}; the full list is in the job summary.`
      : `ci-test-annotations: no failing test could be parsed from ${logPath} — ${reported}.`
  );
}

// Only run the CLI when invoked directly (the unit tests import the core).
if (process.argv[1] && /ciTestAnnotations\.(ts|js|mjs)$/.test(process.argv[1])) {
  main(process.argv.slice(2));
}
