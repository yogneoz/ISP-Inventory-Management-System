/**
 * Guard: the audit-log module vocabulary means ONE thing everywhere.
 *
 * WHY
 * `audit_logs.module` is constrained by `audit_logs_module_check`, and every
 * `logAuditEvent(req, action, module, …)` call writes straight into it. A module
 * the constraint does not list makes PostgreSQL reject the row, and the default
 * caller path is fire-and-forget: the failure surfaces only as a console line
 * (`audit_logs persist failed: CREATE_SALES_INVOICE … violates check constraint
 * "audit_logs_module_check"`) while the screen reports success. On a
 * transactional caller the same rejection aborts the whole action instead.
 *
 * The lists had drifted independently: the schema was missing 'SALES' (eight
 * sales-invoice / return / customer-payment events) and 'PERMISSIONS' (the
 * permission-matrix save), and the client's `AuditLog['module']` union had
 * drifted from both. Nothing failed, so the loss was invisible.
 *
 * PROVES:
 *   1. Every literal module a caller passes to `logAuditEvent` is accepted by
 *      the constraint — with file:line in the failure when it is not.
 *   2. A caller cannot hide its module behind a variable: only the
 *      approval-request logger (which picks between three listed values) may
 *      do that, so a new indirect call is a deliberate, reviewed exception.
 *   3. The client `AuditLog['module']` union is exactly the constraint's list,
 *      so the UI cannot display or filter on a value the database rejects.
 *   4. The parser handles multi-line calls and quoted commas, so the scan
 *      cannot pass by failing to parse a real call.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const SCHEMA_PATH = path.join(ROOT, 'scripts', 'schema.sql');
const SERVER_SRC = path.join(ROOT, 'server', 'src');
const TYPES_PATH = path.join(ROOT, 'client', 'src', 'types', 'index.ts');

/**
 * The only caller allowed to pass a variable as the module. It picks between
 * OPERATIONS / BRANCH_OPERATIONS / INVENTORY_AUDIT, all of which the constraint
 * lists; any other file must pass a literal so this guard can see it.
 */
const ALLOWED_INDIRECT_MODULE_FILES = new Set(['server/src/controllers/misc.controller.ts']);

/** Modules the schema's audit module constraint accepts. */
function readAllowedModules(): Set<string> {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const block = sql.match(
    /ADD CONSTRAINT audit_logs_module_check CHECK \(module IN \(([\s\S]*?)\)\);/
  );
  assert.ok(block, 'scripts/schema.sql lost the audit_logs_module_check constraint');
  return new Set([...block[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
}

/** Every .ts file under server/src (test fixtures excluded — none live there). */
function serverFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith('.ts')) files.push(full);
    }
  };
  walk(SERVER_SRC);
  return files;
}

/**
 * Split the arguments of the call whose `(` is at `openIndex`. Tracks nesting
 * and quotes so a ternary, a template literal, or a nested call cannot make a
 * module look like an action or vice versa.
 */
function splitCallArgs(text: string, openIndex: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote !== '`') {
        current += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      if (depth === 1) continue; // the call's own paren
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    if (depth >= 1) current += ch;
  }
  return args;
}

interface AuditCall {
  file: string;
  line: number;
  /** The module argument as written, e.g. `'SALES'` or `logModule`. */
  moduleArg: string;
}

/** Every `logAuditEvent(req, …)` caller, resolved to its module argument. */
function collectAuditCalls(): AuditCall[] {
  const calls: AuditCall[] = [];
  for (const file of serverFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    for (const match of text.matchAll(/logAuditEvent\(/g)) {
      const openIndex = match.index! + 'logAuditEvent'.length;
      const args = splitCallArgs(text, openIndex);
      // A definition or a wrapper call (`logAuditEvent(req: any, …)`) is not a
      // caller: every real call's first argument is exactly `req`.
      if (args[0]?.trim() !== 'req') continue;
      calls.push({
        file: relative,
        line: text.slice(0, match.index).split('\n').length,
        moduleArg: (args[2] ?? '').trim(),
      });
    }
  }
  return calls;
}

const QUOTED_MODULE = /^'([A-Z_]+)'$/;

describe('audit module vocabulary — schema, callers and client type agree', () => {
  test('schema.sql lists the modules the app writes', () => {
    const allowed = readAllowedModules();
    assert.ok(allowed.size >= 16, `the allow-list shrank to ${allowed.size} modules`);
    // The two that were missing while callers wrote them.
    assert.ok(allowed.has('SALES'), "schema.sql no longer allows 'SALES'");
    assert.ok(allowed.has('PERMISSIONS'), "schema.sql no longer allows 'PERMISSIONS'");
  });

  test('every module a caller passes is accepted by audit_logs_module_check', () => {
    const allowed = readAllowedModules();
    const unknown = collectAuditCalls()
      .map((call) => ({ ...call, module: QUOTED_MODULE.exec(call.moduleArg)?.[1] }))
      .filter((call) => call.module !== undefined && !allowed.has(call.module));

    assert.deepEqual(
      unknown.map((call) => `${call.file}:${call.line} writes '${call.module}'`),
      [],
      'these audit rows would be rejected by audit_logs_module_check — add the ' +
        'module to scripts/schema.sql (and the client union), or use an allowed one'
    );
  });

  test('only the approval-request logger may pass a variable module', () => {
    const indirect = collectAuditCalls()
      .filter((call) => !QUOTED_MODULE.test(call.moduleArg))
      .map((call) => call.file);

    assert.deepEqual(
      [...new Set(indirect)].sort(),
      [...ALLOWED_INDIRECT_MODULE_FILES].sort(),
      'a caller passes a variable as the audit module: inline the literal, or ' +
        'extend ALLOWED_INDIRECT_MODULE_FILES after checking every value it can hold'
    );
  });

  test("the client AuditLog['module'] union is the constraint's list", () => {
    const allowed = readAllowedModules();
    const types = fs.readFileSync(TYPES_PATH, 'utf8');
    const block = types.match(/export interface AuditLog \{[\s\S]*?\n\}/);
    assert.ok(block, "client/src/types/index.ts lost the AuditLog interface");
    const union = block[0].match(/module:\n([\s\S]*?);/);
    assert.ok(union, "AuditLog.module is no longer a multi-line string union");
    const declared = [...union[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();

    assert.deepEqual(
      declared,
      [...allowed].sort(),
      'AuditLog.module and audit_logs_module_check disagree — the UI would type ' +
        'values the database rejects (or reject values it accepts)'
    );
  });

  test('the call parser survives multi-line calls and quoted commas', () => {
    const source = [
      "logAuditEvent(req, 'CREATE_SALES_INVOICE', 'SALES', `Created invoice, ${n} items`);",
      'logAuditEvent(',
      '  req,',
      "  expectedType === 'PULLOUT' ? 'REVERSE_PULLOUT' : 'REVERSE_STOCK_OUT',",
      "  'STOCK_OPERATIONS',",
      "  `Reversed ${expectedType}, ${n}`",
      ');',
      'export function logAuditEvent(req: any, action: string, module: string) {}',
    ].join('\n');

    const calls: string[] = [];
    for (const match of source.matchAll(/logAuditEvent\(/g)) {
      const args = splitCallArgs(source, match.index! + 'logAuditEvent'.length);
      if (args[0]?.trim() !== 'req') continue;
      calls.push(args[2].trim());
    }

    assert.deepEqual(calls, ["'SALES'", "'STOCK_OPERATIONS'"]);
  });
});
