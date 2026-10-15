/**
 * Runs the test suite with NODE_ENV forced to "test", then runs the
 * docs-count gate against THIS run's real suite size.
 *
 * Why NODE_ENV: the repo's .env sets NODE_ENV=development (needed for the
 * Vite dev server / helmet CSP bypass). dotenvx injects it when `tsx --test`
 * boots, which makes tests/httpHardening.test.ts false-fail because CSP is
 * intentionally disabled in development. Spawning tsx as a child process
 * with an explicit NODE_ENV=test environment keeps the .env file untouched
 * for dev while making `npm test` deterministic in any shell (npm, CI, IDE
 * runners). POSIX `NODE_ENV=test npm test` doesn't work in Windows shells,
 * and cross-env isn't a dependency — hence this runner.
 *
 * Why the docs-count gate lives here: only this runner sees the runner's own
 * summary line ("ℹ tests N") for the SAME run that just passed, so every
 * current-state test-count claim in README / handoff / SESSION_NOTES is
 * checked against a fresh number — no checked-in count file, no lag of one
 * run. The gate itself is scripts/docsTestCounts.ts; its classification
 * rules are unit-tested in tests/docsCounts.guard.test.ts.
 *
 * Why the annotation step lives here: a failing run has to be diagnosable from
 * the GitHub run page without downloading the job log (job logs need an
 * authenticated API request). On the runner — and only there — a non-zero suite
 * exit hands this run's captured output to scripts/ciTestAnnotations.ts, which
 * prints `::error` annotations per failing test plus a job-summary table. The
 * exit status stays the suite's own.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';
const spawnEnv = { ...process.env, NODE_ENV: 'test' };

// Piped stdout so the summary line can be parsed, while the bytes still
// stream straight through to the terminal / CI log unchanged.
const suite = spawn(npxCmd, ['tsx', '--test', 'tests/*.test.ts'], {
  cwd: root,
  shell: isWindows,
  env: spawnEnv,
  stdio: ['inherit', 'pipe', 'pipe'],
});

const chunks = [];
const stderrChunks = [];
suite.stdout.on('data', (chunk) => {
  chunks.push(chunk);
  process.stdout.write(chunk);
});
suite.stderr.on('data', (chunk) => {
  stderrChunks.push(chunk);
  process.stderr.write(chunk);
});

suite.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Turns a failing run into GitHub annotations + a job summary. Runs only on
 * GitHub Actions: anywhere else the workflow commands would be terminal noise,
 * and this machine's reporter output already names every failing test.
 *
 * Deliberately never touches the exit status — the caller exits with the
 * suite's own code, so a parser problem can only cost diagnostics, never mask
 * or manufacture a failure.
 */
function annotateFailures(output) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const logPath = path.join(os.tmpdir(), `inventory-test-output-${process.pid}.log`);
  try {
    fs.writeFileSync(logPath, output);
    const result = spawnSync(npxCmd, ['tsx', 'scripts/ciTestAnnotations.ts', logPath], {
      cwd: root,
      shell: isWindows,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) {
      console.error('ci-test-annotations: could not run the annotation step:', result.error.message);
    }
  } catch (err) {
    console.error('ci-test-annotations: could not write this run\'s output:', err?.message || err);
  } finally {
    try {
      fs.unlinkSync(logPath);
    } catch {
      /* best effort: a leftover temp file is harmless */
    }
  }
}

suite.on('close', (code) => {
  if (code !== 0) {
    annotateFailures(Buffer.concat([...chunks, ...stderrChunks]).toString('utf8'));
    process.exit(code ?? 1);
  }

  // The runner's summary: "ℹ tests N" (spec reporter) or "# tests N" (tap).
  const output = Buffer.concat(chunks)
    .toString('utf8')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '');
  const match = output.match(/ℹ tests (\d+)/) ?? output.match(/# tests (\d+)/);
  if (!match) {
    console.error(
      'docs-count gate: could not read the suite size from the test runner output — refusing to skip the gate.'
    );
    process.exit(1);
  }
  const realCount = Number(match[1]);

  const gate = spawnSync(npxCmd, ['tsx', 'scripts/docsTestCounts.ts', String(realCount)], {
    cwd: root,
    shell: isWindows,
    env: spawnEnv,
    stdio: 'inherit',
  });
  process.exit(gate.status ?? 1);
});
