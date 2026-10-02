/**
 * Env-knob wiring tests (2026-10-02 env cleanup).
 *
 * Three variables used to be documented in `.env.example` and read by
 * nothing. They are now wired; this file proves each one actually reaches
 * the runtime it is supposed to configure:
 *
 *   PG_POOL_MAX            → pg pool `max` (server/db.ts buildPoolConfig)
 *   PG_CONNECT_TIMEOUT_MS  → pool connectionTimeoutMillis
 *   TRUST_PROXY            → express `trust proxy` (createApp), which decides
 *                            whether req.ip honors X-Forwarded-For. req.ip is
 *                            the key for the login rate limiter and the
 *                            per-IP SSE connection cap, so this must only
 *                            turn on when explicitly asked.
 *
 * No database needed: buildPoolConfig() is pure env → config, and createApp()
 * only builds the middleware pipeline.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildPoolConfig } from '../server/db';
import { createApp } from '../server/src/app';

const TOUCHED = ['PG_POOL_MAX', 'PG_CONNECT_TIMEOUT_MS', 'TRUST_PROXY'];
const saved: Record<string, string | undefined> = {};
for (const name of TOUCHED) saved[name] = process.env[name];

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const name of TOUCHED) setEnv(name, saved[name]);
});

describe('PG pool env knobs (server/db.ts buildPoolConfig)', () => {
  test('unset → documented defaults (max 20, connect timeout 2000ms)', () => {
    setEnv('PG_POOL_MAX', undefined);
    setEnv('PG_CONNECT_TIMEOUT_MS', undefined);
    const cfg = buildPoolConfig();
    assert.equal(cfg.max, 20);
    assert.equal(cfg.connectionTimeoutMillis, 2000);
    assert.equal(cfg.idleTimeoutMillis, 30000);
  });

  test('valid values are honoured', () => {
    setEnv('PG_POOL_MAX', '5');
    setEnv('PG_CONNECT_TIMEOUT_MS', '5000');
    const cfg = buildPoolConfig();
    assert.equal(cfg.max, 5);
    assert.equal(cfg.connectionTimeoutMillis, 5000);
  });

  test('garbage, zero and out-of-range values fall back instead of breaking the pool', () => {
    for (const bad of ['', 'abc', '0', '-3', '99x']) {
      setEnv('PG_POOL_MAX', bad);
      setEnv('PG_CONNECT_TIMEOUT_MS', bad);
      const cfg = buildPoolConfig();
      assert.equal(cfg.max, 20, `PG_POOL_MAX=${JSON.stringify(bad)} must fall back to 20`);
      assert.equal(cfg.connectionTimeoutMillis, 2000, `PG_CONNECT_TIMEOUT_MS=${JSON.stringify(bad)} must fall back to 2000`);
    }
  });

  test('values above the safety cap fall back (no accidental 5000-connection pool)', () => {
    setEnv('PG_POOL_MAX', '99999');
    assert.equal(buildPoolConfig().max, 20);
  });
});

describe('TRUST_PROXY (express trust proxy in createApp)', () => {
  test('off by default — client-supplied X-Forwarded-For is never trusted', () => {
    setEnv('TRUST_PROXY', undefined);
    assert.ok(!createApp().get('trust proxy'), 'trust proxy must be off when TRUST_PROXY is unset');
  });

  test('"true" and "1" enable it', () => {
    setEnv('TRUST_PROXY', 'true');
    assert.equal(createApp().get('trust proxy'), true);
    setEnv('TRUST_PROXY', '1');
    assert.equal(createApp().get('trust proxy'), true);
  });

  test('anything else stays off (fail-safe: never trust forwarded headers by accident)', () => {
    for (const bad of ['', 'yes', 'false', '0', 'TRUE ']) {
      setEnv('TRUST_PROXY', bad);
      assert.ok(!createApp().get('trust proxy'), `TRUST_PROXY=${JSON.stringify(bad)} must leave trust proxy off`);
    }
  });
});
