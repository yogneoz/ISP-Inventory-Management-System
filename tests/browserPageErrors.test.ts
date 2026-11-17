/**
 * Worklist A10 (dev-server follow-up) — the browser gate must be as trustworthy
 * against a Vite dev server as against the production bundle.
 *
 * The suppression is the risky part of that, so it is pinned here: exactly one
 * message from exactly one script is ignored, and an application exception that
 * happens to use the same words stays fatal.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  HMR_TOOLING_MESSAGE,
  describeIgnoredDevTooling,
  isViteHmrToolingError,
  partitionPageErrors,
} from '../scripts/browserPageErrors.mjs';

const VITE_STACK = `Error: WebSocket closed without opened.
    at WebSocket.<anonymous> (http://localhost:3000/@vite/client:454:22)`;

describe('browser page-error classification (A10 dev server)', () => {
  test('the Vite HMR client closing mid-handshake is dev tooling', () => {
    assert.equal(isViteHmrToolingError(VITE_STACK), true);
  });

  test('the same words from application code stay fatal', () => {
    const appError = `Error: ${HMR_TOOLING_MESSAGE}
    at connect (http://localhost:3000/src/services/realtime.ts:44:11)`;
    assert.equal(isViteHmrToolingError(appError), false);
  });

  test('a different Vite client error stays fatal', () => {
    const otherVite = `Error: Failed to fetch dynamically imported module
    at http://localhost:3000/@vite/client:900:3`;
    assert.equal(isViteHmrToolingError(otherVite), false);
  });

  test('an app exception that merely mentions @vite/client stays fatal', () => {
    const mixed = `TypeError: cannot read properties of undefined
    at handler (http://localhost:3000/@vite/client-adjacent.ts:2:3)`;
    assert.equal(isViteHmrToolingError(mixed), false);
  });

  test('the partition keeps every fatal error and counts the ignored ones', () => {
    const { fatal, devTooling } = partitionPageErrors([
      VITE_STACK,
      'Error: boom\n    at App (http://localhost:3000/src/App.tsx:10:5)',
      VITE_STACK,
    ]);
    assert.equal(devTooling.length, 2);
    assert.equal(fatal.length, 1);
    assert.match(fatal[0], /boom/);
  });

  test('nothing ignored produces no log line; something ignored names the source and the cost', () => {
    assert.equal(describeIgnoredDevTooling([]), null);
    const line = describeIgnoredDevTooling([VITE_STACK]) ?? '';
    assert.match(line, /ignored 1 Vite HMR tooling error/);
    assert.match(line, /\/@vite\/client/);
    assert.match(line, /every application exception is still fatal/);
  });

  test('the gate consults the classifier and can inject a real app exception', () => {
    const check = fs.readFileSync('scripts/check_boot_timing.mjs', 'utf8');
    assert.match(check, /from '\.\/browserPageErrors\.mjs'/);
    assert.match(check, /partitionPageErrors\(pageErrors\)/);
    assert.match(check, /fatalPageErrors\.length/);
    assert.match(check, /--inject-exception/);
    assert.match(check, /deliberate app exception injected by --inject-exception/);
  });
});
