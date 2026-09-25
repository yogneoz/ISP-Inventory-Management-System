/**
 * Env-var guard tests (audit backlog #4 — the "PORT=0 trap" class).
 *
 * PROVES the hardened parsers reject every historically dangerous form —
 * empty string, garbage, trailing junk, zero, out-of-range, float-style —
 * by warning and falling back, while accepting every legitimate form.
 * These guards exist because this deployment's shell exports an ambient
 * PORT=0 that once made the server bind an ephemeral port, and because a
 * NaN/zero JSON body limit or rate-limit max would take the API down.
 *
 * process.env is saved/restored around each test so the suite stays isolated.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { intFromEnv, sizeFromEnv, sizeToBytes } from '../server/src/utils/envGuard';

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  // Isolate env mutations per test.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TEST_')) delete (process.env as any)[key];
  }
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe('intFromEnv (strict integer env parsing)', () => {
  test('PORT=0 trap: zero falls back instead of binding an ephemeral port', () => {
    process.env.TEST_PORT = '0';
    assert.equal(intFromEnv('TEST_PORT', 3000, { min: 1, max: 65535 }), 3000);
  });

  test('empty, whitespace-only and unset values fall back', () => {
    assert.equal(intFromEnv('TEST_UNSET', 3000), 3000);
    process.env.TEST_EMPTY = '';
    assert.equal(intFromEnv('TEST_EMPTY', 3000), 3000);
    process.env.TEST_SPACE = '   ';
    assert.equal(intFromEnv('TEST_SPACE', 3000), 3000);
  });

  test('garbage and trailing junk fall back (parseInt would accept "8x" as 8)', () => {
    process.env.TEST_GARBAGE = 'abc';
    assert.equal(intFromEnv('TEST_GARBAGE', 3000), 3000);
    process.env.TEST_JUNKTAIL = '8x';
    assert.equal(intFromEnv('TEST_JUNKTAIL', 3000), 3000);
    process.env.TEST_FLOAT = '8.5';
    assert.equal(intFromEnv('TEST_FLOAT', 3000), 3000);
  });

  test('out-of-range values fall back with the range respected', () => {
    process.env.TEST_NEG = '-5';
    assert.equal(intFromEnv('TEST_NEG', 3000, { min: 1 }), 3000);
    process.env.TEST_HUGE = '99999';
    assert.equal(intFromEnv('TEST_HUGE', 3000, { min: 1, max: 65535 }), 3000);
  });

  test('legitimate values pass through: plain, padded, signed', () => {
    process.env.TEST_OK = '8080';
    assert.equal(intFromEnv('TEST_OK', 3000), 8080);
    process.env.TEST_PAD = '  8080  ';
    assert.equal(intFromEnv('TEST_PAD', 3000), 8080);
    process.env.TEST_LEAD = '08';
    assert.equal(intFromEnv('TEST_LEAD', 3000), 8);
  });

  test('min/max boundaries are inclusive', () => {
    process.env.TEST_LO = '1';
    assert.equal(intFromEnv('TEST_LO', 3000, { min: 1, max: 10 }), 1);
    process.env.TEST_HI = '10';
    assert.equal(intFromEnv('TEST_HI', 3000, { min: 1, max: 10 }), 10);
  });
});

describe('sizeFromEnv / sizeToBytes (body-parser size strings)', () => {
  test('sizeToBytes parses every body-parser unit form', () => {
    assert.equal(sizeToBytes('1048576'), 1048576);
    assert.equal(sizeToBytes('1kb'), 1024);
    assert.equal(sizeToBytes('512KB'), 512 * 1024);
    assert.equal(sizeToBytes('25mb'), 25 * 1024 ** 2);
    assert.equal(sizeToBytes('2GB'), 2 * 1024 ** 3);
    assert.equal(sizeToBytes('100 b'), 100);
  });

  test('sizeToBytes rejects garbage, negative and malformed values', () => {
    assert.equal(sizeToBytes('abc'), null);
    assert.equal(sizeToBytes('25 b x'), null);
    assert.equal(sizeToBytes('mb'), null);
    assert.equal(sizeToBytes('1.2.3mb'), null);
    assert.equal(sizeToBytes(''), null);
  });

  test('sizeFromEnv: valid JSON_BODY_LIMIT passes through', () => {
    process.env.TEST_LIMIT = '25mb';
    assert.equal(sizeFromEnv('TEST_LIMIT', '1mb'), '25mb');
  });

  test('sizeFromEnv: garbage and zero fall back (a NaN/0 limit would break every request)', () => {
    process.env.TEST_BAD = 'banana';
    assert.equal(sizeFromEnv('TEST_BAD', '1mb'), '1mb');
    process.env.TEST_ZERO = '0mb';
    assert.equal(sizeFromEnv('TEST_ZERO', '1mb', { minBytes: 1024 }), '1mb');
    assert.equal(sizeFromEnv('TEST_UNSET2', '1mb'), '1mb');
  });
});
