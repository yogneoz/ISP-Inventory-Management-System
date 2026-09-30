/**
 * Runs the test suite with NODE_ENV forced to "test".
 *
 * Why this exists: the repo's .env sets NODE_ENV=development (needed for the
 * Vite dev server / helmet CSP bypass). dotenvx injects it when `tsx --test`
 * boots, which makes tests/httpHardening.test.ts false-fail because CSP is
 * intentionally disabled in development. Spawning tsx as a child process with
 * an explicit NODE_ENV=test environment keeps the .env file untouched for dev
 * while making `npm test` deterministic in any shell (npm, CI, IDE runners).
 * POSIX `NODE_ENV=test npm test` doesn't work on Windows shells, and
 * cross-env isn't a dependency — hence this runner.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

const result = spawnSync(npxCmd, ['tsx', '--test', 'tests/*.test.ts'], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
  shell: isWindows,
  env: {
    ...process.env,
    NODE_ENV: 'test',
  },
});

process.exit(result.status ?? 1);
