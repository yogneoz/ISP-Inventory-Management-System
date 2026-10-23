/**
 * D1/D2 — production must refuse to boot on an unusable AUTH_TOKEN_SECRET.
 *
 * `middleware/auth.ts` signs login tokens with `AUTH_TOKEN_SECRET`, falling back
 * to a per-process random secret when the variable is unset. In production that
 * fallback is silent session theft from every restart: pm2 restarts this process
 * at 1 GB, and a second instance could never verify the first's tokens.
 *
 * PROVES:
 *   1. the pure validator rejects missing/blank, template-placeholder and short
 *      secrets in production, and accepts development/test unchanged;
 *   2. the real boot entry (`server/index.ts`) exits 1 BY ITSELF, names
 *      AUTH_TOKEN_SECRET and a generation command, and does so BEFORE the
 *      PostgreSQL phase — so no port ever opens on the ephemeral secret.
 *
 * Determinism: the child gets an explicit EMPTY AUTH_TOKEN_SECRET. dotenv never
 * overrides a key already present in process.env (not even an empty one), so a
 * developer's .env cannot satisfy the guard and make this test lie.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  AUTH_SECRET_MIN_LENGTH,
  AUTH_SECRET_PLACEHOLDERS,
  validateAuthSecret,
} from '../server/src/boot/authSecret';

const ROOT = process.cwd();
/** Nothing listens here; the guard must fire before a connection is attempted. */
const UNREACHABLE_PG_PORT = 1;
const EXIT_TIMEOUT_MS = 60_000;

const tsxCli = (() => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch {
    return path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }
})();

describe('validateAuthSecret (pure)', () => {
  test('development and test keep the ephemeral fallback', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      assert.deepEqual(validateAuthSecret({ NODE_ENV }), { ok: true });
    }
  });

  test('production rejects a missing or blank secret with a way to generate one', () => {
    for (const AUTH_TOKEN_SECRET of [undefined, '', '   ']) {
      const result = validateAuthSecret({ NODE_ENV: 'production', AUTH_TOKEN_SECRET });
      assert.equal(result.ok, false, `expected ${JSON.stringify(AUTH_TOKEN_SECRET)} to be refused`);
      if (result.ok) continue;
      assert.equal(result.issue, 'missing');
      assert.match(result.message, /AUTH_TOKEN_SECRET is required in production/);
      assert.match(result.message, /randomBytes\(32\)/, 'the message must show how to generate a secret');
      assert.match(result.message, /invalidates all sessions/, 'the message must say why it matters');
    }
  });

  test('production rejects every template placeholder, case-insensitively', () => {
    for (const placeholder of AUTH_SECRET_PLACEHOLDERS) {
      const result = validateAuthSecret({ NODE_ENV: 'production', AUTH_TOKEN_SECRET: placeholder });
      assert.equal(result.ok, false, `placeholder "${placeholder}" must be refused`);
      if (!result.ok) assert.equal(result.issue, 'placeholder', placeholder);
    }
    const upper = validateAuthSecret({
      NODE_ENV: 'production',
      AUTH_TOKEN_SECRET: 'REPLACE-WITH-A-LONG-RANDOM-PRODUCTION-SECRET',
    });
    assert.equal(upper.ok, false);
    if (!upper.ok) assert.equal(upper.issue, 'placeholder');
  });

  test('production rejects a short secret without echoing its value', () => {
    const short = 'a'.repeat(AUTH_SECRET_MIN_LENGTH - 1);
    const result = validateAuthSecret({ NODE_ENV: 'production', AUTH_TOKEN_SECRET: short });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issue, 'too-short');
    assert.match(result.message, new RegExp(`${AUTH_SECRET_MIN_LENGTH - 1} characters`));
    assert.ok(!result.message.includes(short), 'the secret itself must never be logged');
  });

  test('production accepts a secret at and above the minimum length', () => {
    assert.deepEqual(
      validateAuthSecret({ NODE_ENV: 'production', AUTH_TOKEN_SECRET: 'x'.repeat(AUTH_SECRET_MIN_LENGTH) }),
      { ok: true }
    );
    // The shape .env.example tells operators to generate.
    assert.deepEqual(
      validateAuthSecret({ NODE_ENV: 'production', AUTH_TOKEN_SECRET: 'a'.repeat(64) }),
      { ok: true }
    );
  });
});

interface BootAttempt {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  ms: number;
}

/** Boot the real entry in production with no usable secret. */
function bootWithoutSecret(): Promise<BootAttempt> {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [tsxCli, path.join('server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Explicit empty value: dotenv does not override existing keys, so a
      // developer's .env secret cannot turn this into a false pass.
      AUTH_TOKEN_SECRET: '',
      DATABASE_URL: `postgres://inventory_user:securepassword@127.0.0.1:${UNREACHABLE_PG_PORT}/inventory_db`,
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: String(UNREACHABLE_PG_PORT),
      PG_CONNECT_TIMEOUT_MS: '1000',
      PORT: '5198',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  return new Promise<BootAttempt>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, ms: Date.now() - startedAt });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('production boot refuses an ephemeral auth secret', () => {
  let boot: BootAttempt;

  before(async () => {
    boot = await bootWithoutSecret();
  });

  test('the process exits by itself with code 1', () => {
    assert.notEqual(
      boot.signal,
      'SIGKILL',
      `the boot process was still alive after ${EXIT_TIMEOUT_MS / 1000}s — a missing secret ` +
        `must stop it, not leave pm2 reporting a healthy instance\n${boot.output.slice(-2000)}`
    );
    assert.equal(
      boot.code,
      1,
      `expected exit code 1, got ${boot.code} (signal ${boot.signal}) after ${boot.ms}ms\n` +
        boot.output.slice(-2000)
    );
  });

  test('the refusal names the variable and how to generate a secret', () => {
    assert.match(boot.output, /FATAL: server failed to start/);
    assert.match(boot.output, /AUTH_TOKEN_SECRET is required in production/);
    assert.match(boot.output, /randomBytes\(32\)/);
  });

  test('the refusal happens before the database is touched', () => {
    assert.doesNotMatch(
      boot.output,
      /PostgreSQL startup failed/,
      'the secret check must run before the database phase — otherwise the deployment ' +
        'wastes a connection attempt and logs the wrong cause'
    );
  });
});
