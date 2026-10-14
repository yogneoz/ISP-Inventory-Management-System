/**
 * Guard: the server boot path must never read `import.meta`.
 *
 * The production bundle is CommonJS — `npm run build` runs esbuild with
 * `--format=cjs` into `dist/server.cjs`, and `npm start`, pm2's
 * ecosystem.config.js (`script: 'dist/server.cjs'`) and the Dockerfile all
 * start THAT file. esbuild lowers `import.meta` to an empty object in that
 * format, so `fileURLToPath(import.meta.url)` inside dbBoot's schema loader
 * threw
 *
 *   PostgreSQL startup failed: The "path" argument must be of type string or
 *   an instance of URL. Received undefined
 *
 * BEFORE the loader's own `process.cwd()` candidate was ever tried (the
 * module-relative candidates are computed before the search loop runs). That
 * made `node dist/server.cjs` — hence every `pm2 reload` — unable to boot at
 * all, while `npm run dev` (tsx, real ESM) stayed perfectly healthy, which is
 * why the test suite never noticed: it imports the sources, never the bundle.
 *
 * PROVES (source pins, no build and no database needed):
 *   1. No server source references `import.meta`, so esbuild has nothing to
 *      lower into the bundle again.
 *   2. dbBoot resolves its own directory through `__dirname` — the real value
 *      in the CJS bundle — and through the started script under tsx/ESM.
 *   3. loadSchemaSql() still tries `process.cwd()` FIRST and only then walks
 *      up from the module directory (the bundled dist/ layout).
 *   4. The start command is still the CJS bundle this guard's premise rests
 *      on, so the cross-check stays honest if the build ever moves to ESM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const read = (relativePath: string): string => fs.readFileSync(path.resolve(ROOT, relativePath), 'utf8');

/** Every .ts file under a directory, recursively. */
const tsFilesUnder = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.resolve(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
};

/**
 * Real `import.meta` syntax nodes in a file — comments and string literals that
 * merely mention it (this guard's own explanation, for instance) do not count.
 */
const importMetaReferences = (source: string, file: string): number[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
};

describe('server bundle boot — no import.meta in the server boot path', () => {
  test('no server source reads import.meta (esbuild empties it in the cjs bundle)', () => {
    const sources = [...tsFilesUnder('server'), 'server.ts'];
    assert.ok(sources.length > 20, `expected to scan the server tree, only found ${sources.length} files`);

    const offenders = sources
      .map((file) => ({ file, lines: importMetaReferences(read(file), file) }))
      .filter((entry) => entry.lines.length > 0)
      .map((entry) => `${entry.file}:${entry.lines.join(',')}`);
    assert.deepEqual(
      offenders,
      [],
      `these server sources read import.meta, which is an empty object in dist/server.cjs — ` +
        `resolve the path from __dirname / process.argv instead: ${offenders.join(', ')}`
    );
  });

  test('dbBoot resolves its module directory in both runtimes', () => {
    const dbBoot = read('server/src/boot/dbBoot.ts');
    assert.ok(
      /function resolveModuleDir\(\): string \| null/.test(dbBoot),
      'dbBoot.ts must resolve its own directory through resolveModuleDir()'
    );
    assert.ok(
      dbBoot.includes("if (typeof __dirname === 'string') return __dirname;"),
      "the CJS bundle's real directory must come from __dirname (checked before anything else)"
    );
    assert.ok(
      dbBoot.includes('const entry = process.argv[1];'),
      'the ESM (tsx) fallback must anchor on the started script'
    );
  });

  test('loadSchemaSql tries the cwd candidate before the module-relative walk', () => {
    const dbBoot = read('server/src/boot/dbBoot.ts');
    const cwdCandidate = dbBoot.indexOf("path.resolve(process.cwd(), 'scripts/schema.sql')");
    const moduleWalk = dbBoot.indexOf("candidates.push(path.resolve(moduleDir");
    assert.ok(cwdCandidate !== -1, 'the cwd candidate (repo root) must stay first');
    assert.ok(moduleWalk !== -1, 'the module-relative walk-up candidate must stay as the fallback');
    assert.ok(
      cwdCandidate < moduleWalk,
      'the cwd candidate must be evaluated before the module-relative walk — a broken ' +
        'module-dir lookup must never be able to abort the boot again'
    );
    assert.ok(
      dbBoot.indexOf('const moduleDir = resolveModuleDir();') < dbBoot.indexOf('for (const candidate of candidates)'),
      'the module directory must be resolved before the candidate search, not inside it'
    );
  });

  test('the start command is still the CJS bundle this guard assumes', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      main?: string;
    };
    assert.ok(
      pkg.scripts.build.includes('--format=cjs') && pkg.scripts.build.includes('dist/server.cjs'),
      'the build must still emit the CommonJS bundle at dist/server.cjs (import.meta is empty there)'
    );
    assert.ok(
      pkg.scripts.start.includes('dist/server.cjs'),
      'npm start must still run the bundle this guard protects'
    );
    assert.ok(
      read('ecosystem.config.js').includes("script: 'dist/server.cjs'"),
      'pm2 must still start the same bundle'
    );
  });
});
