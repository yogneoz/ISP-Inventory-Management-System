#!/usr/bin/env node
/**
 * Redis preflight - `npm run check:redis`.
 *
 * A production boot refuses to start without Redis (see
 * `assertSharedStateForWorkers` in `server/src/state/sharedStore.ts`), so an
 * installer needs one command that answers "is the thing I was told to install
 * actually there and usable" before starting pm2 and reading a stack trace.
 *
 * It reads the same `.env` the server reads, with explicit environment
 * variables still winning (process.loadEnvFile does not overwrite them), then:
 *   - refuses a missing REDIS_URL / REDIS_TLS_URL (exit 1, names the variable);
 *   - refuses an unreachable or unauthenticated server (exit 1, redacted URL);
 *   - proves the read/write path, not just the handshake: PING, SET with a TTL,
 *     GET, DEL, and prints the server version and selected database.
 *
 * Credentials never reach stdout: a `user:password@host` authority is redacted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from 'redis';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.REDIS_TLS_URL || process.env.REDIS_URL || '';
const redact = (value) => value.replace(/\/\/[^@]*@/, '//***@');

if (!url) {
  console.error('Redis is not configured: set REDIS_URL (or REDIS_TLS_URL) in .env.');
  console.error('A production boot refuses to start without it - see README "Step 3: Redis (required)".');
  process.exit(1);
}

const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
// node-redis emits 'error' for every failed re-dial; connect()/PING below report
// the same failure with a message, so the emitter must not crash the preflight.
client.on('error', () => {});

try {
  await client.connect();
  const startedAt = process.hrtime.bigint();
  const pong = await client.ping();
  const rttMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const info = await client.info('server');
  const version = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? 'unknown';
  await client.set('isp:preflight', 'ok', { PX: 2000 });
  const echoed = await client.get('isp:preflight');
  await client.del('isp:preflight');
  if (pong !== 'PONG' || echoed !== 'ok') {
    throw new Error(`unexpected replies (PING ${pong}, GET ${echoed})`);
  }
  const db = /\/(\d+)(?:\?|$)/.exec(url)?.[1] ?? '0';
  console.log(
    `OK Redis ${version} at ${redact(url)} - PING ${pong} in ${rttMs.toFixed(1)} ms, ` +
      `read/write round trip ok, db ${db}.`
  );
} catch (err) {
  console.error(`Redis at ${redact(url)} is not usable: ${err?.message || err}`);
  console.error('Start it (systemctl enable --now redis-server on Linux) and re-run `npm run check:redis`.');
  process.exitCode = 1;
} finally {
  // A client whose connect() failed is not open, and node-redis throws
  // ClientClosedError from destroy() on it. That throw would replace the
  // message above with a stack trace on exactly the failure path this
  // preflight exists for, so it is closed only when it is open.
  try {
    if (client.isOpen) client.destroy();
  } catch {
    // Nothing to close.
  }
}
