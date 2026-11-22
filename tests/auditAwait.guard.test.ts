/**
 * Unit tests for the awaited-audit guard (scripts/check_audit_await.ts).
 *
 * The guard exists because a bare `logAuditEvent(...)` answers the request
 * before its row is committed: `permissionOverrides.test.ts` lost that race on
 * Linux while passing on a slower host, and 56 write paths in the admin,
 * master-data and inventory controllers had the same shape. These tests pin the
 * detection contract against synthetic sources, assert the live controller tree
 * is clean, and prove the CLI fails on a seeded violation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findUnawaitedAuditCalls,
  maskCommentsAndStrings,
  runAsScript,
} from '../scripts/check_audit_await';

const CONTROLLERS_DIR = path.resolve(process.cwd(), 'server', 'src', 'controllers');

/**
 * Seeded sources live outside the repo: a concurrently running
 * `check:audit-await` would otherwise scan the fixture before it is deleted,
 * the same reason no_inline_sql.guard.test.ts seeds into a temp dir.
 */
function seededFixture(source: string): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-await-guard-'));
  const file = path.join(dir, 'seeded.controller.ts');
  fs.writeFileSync(file, source);
  return {
    file,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('awaited-audit guard', () => {
  describe('findUnawaitedAuditCalls (synthetic sources)', () => {
    test('flags a bare statement call with its line and snippet', () => {
      const src = [
        'export async function h(req: any, res: any) {',
        "  logAuditEvent(req, 'UPDATE_X', 'MASTER_DATA', 'did a thing');",
        '  res.json({ ok: true });',
        '}',
      ].join('\n');
      const v = findUnawaitedAuditCalls(src, 'fake.controller.ts');
      assert.equal(v.length, 1);
      assert.equal(v[0].line, 2);
      assert.equal(v[0].file, 'fake.controller.ts');
      assert.match(v[0].snippet, /^logAuditEvent\(/);
    });

    test('accepts an awaited call, including a multi-line one', () => {
      const src = [
        'export async function h(req: any) {',
        "  await logAuditEvent(req, 'A', 'M', 'x');",
        '  await logAuditEvent(',
        '    req,',
        "    'B',",
        "    'M',",
        "    `multi-line`",
        '  );',
        '}',
      ].join('\n');
      assert.deepEqual(findUnawaitedAuditCalls(src, 'fake.controller.ts'), []);
    });

    test('accepts the call inside a larger expression', () => {
      const src = [
        'const pending = logAuditEvent(req, "A", "M", "x");',
        'await Promise.all([logAuditEvent(req, "B", "M", "y")]);',
        'await withTransaction(async () => { await logAuditEvent(req, "C", "M", "z"); });',
      ].join('\n');
      assert.deepEqual(findUnawaitedAuditCalls(src, 'fake.controller.ts'), []);
    });

    test('flags `return logAuditEvent(...)` — Express answers without awaiting the insert', () => {
      const src = 'export function h(req: any) {\n  return logAuditEvent(req, "A", "M", "x");\n}';
      const v = findUnawaitedAuditCalls(src, 'fake.controller.ts');
      assert.equal(v.length, 1);
      assert.equal(v[0].line, 2);
    });

    test('ignores comments and prose strings that merely mention the helper', () => {
      const src = [
        '// logAuditEvent(req) belongs here, awaited',
        '/* old code was: logAuditEvent(req, "A", "M", "x"); */',
        'const note = "logAuditEvent(req) must be awaited";',
        "const other = 'see logAuditEvent(req, ...)';",
        'res.json({ ok: true });',
      ].join('\n');
      assert.deepEqual(findUnawaitedAuditCalls(src, 'fake.controller.ts'), []);
    });

    test('still sees a call written inside a template interpolation', () => {
      // The interpolation is code, not template text; masking must not hide it.
      const src = 'const label = `value ${(() => { logAuditEvent(req); return 1; })()}`;';
      const v = findUnawaitedAuditCalls(src, 'fake.controller.ts');
      assert.equal(v.length, 1);
      assert.match(v[0].snippet, /logAuditEvent\(req\)/);
    });

    test('maskCommentsAndStrings keeps line numbering intact', () => {
      const src = 'const a = "x"; // logAuditEvent(req)\n/* logAuditEvent(req)\n still comment */\nlogAuditEvent(req);';
      const masked = maskCommentsAndStrings(src);
      assert.equal(masked.split('\n').length, src.split('\n').length);
      assert.equal(masked.includes('logAuditEvent'), true, 'the live call survives masking');
      assert.equal(masked.split('logAuditEvent').length - 1, 1, 'comment mentions are masked away');
    });
  });

  describe('live controllers tree', () => {
    test('every logAuditEvent call in server/src/controllers is awaited', () => {
      assert.equal(fs.existsSync(CONTROLLERS_DIR), true, 'controllers dir must exist');
      const files = fs.readdirSync(CONTROLLERS_DIR).filter((f) => f.endsWith('.ts'));
      assert.ok(files.length >= 10, `expected the full controller set, found ${files.length}`);
      const violations = files.flatMap((f) =>
        findUnawaitedAuditCalls(fs.readFileSync(path.join(CONTROLLERS_DIR, f), 'utf8'), f)
      );
      assert.deepEqual(
        violations,
        [],
        'await logAuditEvent(...) before responding; the insert must commit before the response'
      );
    });

    test('runAsScript exits 0 for the clean controllers directory', () => {
      assert.equal(runAsScript([CONTROLLERS_DIR]), 0);
    });

    test('runAsScript exits 1 when a seeded controller forgets the await', () => {
      const seeded = seededFixture(
        "export async function bad(req: any) {\n  logAuditEvent(req, 'X', 'M', 'x');\n}\n"
      );
      try {
        assert.equal(runAsScript([seeded.file]), 1);
      } finally {
        seeded.cleanup();
      }
    });
  });
});
