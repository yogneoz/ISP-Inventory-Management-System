/**
 * `.env.example` ↔ code guard (2026-10-02 project audit).
 *
 * The audit found 14 variables documented in `.env.example` that NO code read
 * (REQUIRE_POSTGRES, TRUST_PROXY, PG_POOL_MAX, STRICT_PASSWORD_POLICY,
 * LOGIN_RATE_LIMIT_MAX, ...): operators could tune knobs that did nothing,
 * while genuinely read knobs (RETURNS_APPROVAL_THRESHOLD_NPR) were
 * undocumented. Three of them (PG_POOL_MAX, PG_CONNECT_TIMEOUT_MS,
 * TRUST_PROXY) are now wired; the other eleven were removed from the
 * template because the features they implied do not exist.
 *
 * This guard pins the invariant so it cannot regress:
 *   1. every variable NAMED in `.env.example` is actually read somewhere in
 *      the source tree (server, client, scripts, vite config),
 *   2. the known-dead list from the audit never comes back,
 *   3. the three wired knobs plus the business threshold stay documented.
 *
 * The reverse direction ("every read var must be documented") is deliberately
 * NOT asserted: tests define throwaway TEST_* vars, and one-off tooling reads
 * that do not belong in the operator-facing template.
 *
 * File-parsing only — no database, runs everywhere.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Variables documented in a .env.example-style file (commented or not). */
export function parseEnvExampleNames(content: string): string[] {
  const names: string[] = [];
  const assignment = /^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)[ \t]*=/gm;
  let m: RegExpExecArray | null;
  while ((m = assignment.exec(content)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Which of `names` are never READ. A name counts as read when it appears as
 * `process.env.<NAME>` / `import.meta.env.<NAME>` or as a quoted string
 * (the envGuard call convention: intFromEnv('NAME', ...)). Word-boundary
 * anchored so `PORT` does not silently pass because `POSTGRES_PORT` exists.
 */
export function findUnreadVars(
  names: string[],
  sources: Array<{ file: string; source: string }>
): string[] {
  const readPatterns = (name: string): RegExp[] => [
    new RegExp(`process\\.env\\??\\.${name}\\b`),
    new RegExp(`env\\??\\.${name}\\b`),
    new RegExp(`['"\`]${name}['"\`]`),
  ];
  return names.filter(
    (name) => !sources.some((s) => readPatterns(name).some((re) => re.test(s.source)))
  );
}

/** Recursively collect files with the given extensions (absolute paths). */
function collectFiles(dir: string, exts: string[], out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, exts, out);
    else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const ROOT = path.resolve(process.cwd());
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

function loadSources(): Array<{ file: string; source: string }> {
  const files = [
    ...collectFiles(path.join(ROOT, 'server'), ['.ts']),
    ...collectFiles(path.join(ROOT, 'client', 'src'), ['.ts', '.tsx']),
    ...collectFiles(path.join(ROOT, 'scripts'), ['.ts', '.mjs', '.js']),
    path.join(ROOT, 'vite.config.ts'),
    path.join(ROOT, 'server.ts'),
  ].filter((f) => fs.existsSync(f));
  return files.map((file) => ({ file: path.relative(ROOT, file), source: fs.readFileSync(file, 'utf8') }));
}

/** Removed from .env.example in the 2026-10-02 cleanup: no reader exists. */
const KNOWN_DEAD_VARS = [
  'REQUIRE_POSTGRES',
  'LOG_LEVEL',
  'APP_URL',
  'REQUIRE_MIGRATIONS',
  'STRICT_PASSWORD_POLICY',
  'MIN_PASSWORD_LENGTH',
  'LOGIN_RATE_LIMIT_MAX',
  'API_RATE_LIMIT_MAX',
  'DISABLE_RATE_LIMIT',
  'SEED_DUMMY_DATA',
  'PM2_INSTANCES',
];

/** Wired by the cleanup and expected to stay documented. */
const MUST_STAY_DOCUMENTED = [
  'PG_POOL_MAX',
  'PG_CONNECT_TIMEOUT_MS',
  'TRUST_PROXY',
  'RETURNS_APPROVAL_THRESHOLD_NPR',
];

describe('.env.example ↔ code guard', () => {
  test('parseEnvExampleNames reads commented and uncommented assignments, ignores prose', () => {
    const sample = [
      'PORT=3000',
      '# PG_POOL_MAX=20',
      '# NOTE on numeric env vars: PORT, JSON_BODY_LIMIT are parsed strictly',
      '# Boolean flags (TRUST_PROXY, AUTH_RATE_LIMIT_DISABLED) accept only 1/true',
      'AUTH_TOKEN_SECRET="x"',
    ].join('\n');
    assert.deepEqual(parseEnvExampleNames(sample), [
      'PORT',
      'PG_POOL_MAX',
      'AUTH_TOKEN_SECRET',
    ]);
  });

  test('findUnreadVars flags names with no reader and accepts real reads', () => {
    const sources = [
      { file: 'a.ts', source: "const p = process.env.PORT;" },
      { file: 'b.ts', source: "const m = intFromEnv('PG_POOL_MAX', 20);" },
      { file: 'c.ts', source: "const v = (import.meta as any).env?.VITE_API_BASE_URL;" },
    ];
    assert.deepEqual(findUnreadVars(['PORT', 'PG_POOL_MAX', 'VITE_API_BASE_URL'], sources), []);
    assert.deepEqual(findUnreadVars(['PORT', 'GHOST_KNOB'], sources), ['GHOST_KNOB']);
    // POSTGRES_PORT existing must not make bare PORT count as read
    assert.deepEqual(findUnreadVars(['PORT'], [{ file: 'x.ts', source: 'process.env.POSTGRES_PORT' }]), ['PORT']);
  });

  test('every variable documented in .env.example is read by the code', () => {
    const names = parseEnvExampleNames(fs.readFileSync(ENV_EXAMPLE, 'utf8'));
    assert.ok(names.length >= 15, `expected a populated .env.example, parsed ${names.length} names`);
    const unread = findUnreadVars(names, loadSources());
    assert.deepEqual(
      unread,
      [],
      `.env.example documents ${unread.length} variable(s) that NOTHING reads: ${unread.join(', ')}. ` +
        `Wire them up or delete the line(s) — a knob nobody reads is worse than no knob.`
    );
  });

  test('the audit\'s known-dead variables never come back', () => {
    const names = parseEnvExampleNames(fs.readFileSync(ENV_EXAMPLE, 'utf8'));
    const resurrected = KNOWN_DEAD_VARS.filter((v) => names.includes(v));
    assert.deepEqual(resurrected, [], `removed as dead in 2026-10-02 cleanup: ${resurrected.join(', ')}`);
  });

  test('the wired knobs and the business threshold stay documented', () => {
    const names = parseEnvExampleNames(fs.readFileSync(ENV_EXAMPLE, 'utf8'));
    const missing = MUST_STAY_DOCUMENTED.filter((v) => !names.includes(v));
    assert.deepEqual(missing, [], `read by the code but missing from .env.example: ${missing.join(', ')}`);
  });
});
