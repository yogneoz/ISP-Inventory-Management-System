/**
 * One-time Super Admin setup token (audit finding C1).
 *
 * The endpoint that creates the first Super Admin is necessarily public, so the
 * token is the only thing standing between "the operator installing this" and
 * "anyone who can reach the URL". These tests pin the properties that matter:
 * an operator-supplied token is used verbatim, a generated one is long enough to
 * be unguessable, comparison is exact, and a claim consumes the token.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSetupToken,
  getSetupToken,
  getSetupTokenSource,
  verifySetupToken,
  consumeSetupToken,
  resetSetupTokenForTests,
  setupTokenFromRequest,
  SETUP_TOKEN_MIN_LENGTH,
} from '../server/src/boot/setupToken';

describe('setup token', () => {
  beforeEach(() => {
    resetSetupTokenForTests();
  });

  test('uses an operator-supplied SETUP_TOKEN verbatim', () => {
    const resolved = resolveSetupToken({ SETUP_TOKEN: '  operator-chosen-token-1234  ' });
    assert.equal(resolved.source, 'env');
    assert.equal(getSetupToken(), 'operator-chosen-token-1234');
    assert.equal(getSetupTokenSource(), 'env');
  });

  test('generates a long random token when the environment does not set one', () => {
    const first = resolveSetupToken({});
    assert.equal(first.source, 'generated');
    assert.match(first.token, /^[0-9a-f]{36}$/);
    assert.ok(first.token.length >= SETUP_TOKEN_MIN_LENGTH);
  });

  test('a short SETUP_TOKEN is a boot failure, not a silent fallback', () => {
    assert.throws(() => resolveSetupToken({ SETUP_TOKEN: 'short' }), /at least 16 characters/);
  });

  test('an exact match verifies; anything else does not', () => {
    resolveSetupToken({ SETUP_TOKEN: 'correct-horse-battery-42' });
    assert.equal(verifySetupToken('correct-horse-battery-42'), true);
    assert.equal(verifySetupToken('  correct-horse-battery-42  '), true, 'surrounding whitespace is trimmed');
    assert.equal(verifySetupToken('correct-horse-battery-43'), false);
    assert.equal(verifySetupToken('correct-horse-battery-42x'), false, 'a longer value must not match');
    assert.equal(verifySetupToken(''), false);
    assert.equal(verifySetupToken(undefined), false);
    assert.equal(verifySetupToken(42), false);
  });

  test('a consumed token can never be replayed', () => {
    resolveSetupToken({ SETUP_TOKEN: 'used-once-token-abcdef' });
    assert.equal(verifySetupToken('used-once-token-abcdef'), true);
    consumeSetupToken();
    assert.equal(getSetupToken(), null);
    assert.equal(verifySetupToken('used-once-token-abcdef'), false);
  });

  test('no token is accepted before one is resolved', () => {
    assert.equal(verifySetupToken('anything-at-all'), false);
  });

  test('reads the token from the x-setup-token header or the JSON body', () => {
    assert.equal(setupTokenFromRequest({ headers: { 'x-setup-token': 'header-token' } }), 'header-token');
    assert.equal(setupTokenFromRequest({ headers: {}, body: { setupToken: 'body-token' } }), 'body-token');
    assert.equal(setupTokenFromRequest({ headers: { 'x-setup-token': '  ' }, body: { setupToken: 'body-token' } }), 'body-token');
    assert.equal(setupTokenFromRequest({}), '');
    assert.equal(setupTokenFromRequest({ headers: {}, body: null }), '');
  });
});
