/**
 * Ledger-purge bypass guard (the "a bare `npx tsx --test` poisons the dev
 * database" class).
 *
 * PROVES the detection reads the option the test runner injects and refuses a
 * test file without it — while a spawned server boot, a dev script and a suite
 * that clears its database URL are left alone. A miss costs a run, not a red
 * test: teardown cannot remove its own posted journals, and the next run's
 * fixed-value balance assertions match money it never created.
 *
 * Only the pure helpers are imported — a test file that loaded `server/db.ts`
 * would be refused by the very guard under test when run bare.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTestLedgerPurgeBypass,
  hasLedgerPurgeBypass,
} from '../server/src/db/ledgerPurgeBypass';

const WITH_OPTION = 'postgres://inventory_user:pw@127.0.0.1:5432/inventory_db?options=' +
  '-c%20inventory.allow_ledger_purge%3Don';
const WITH_OPTION_PLUS = 'postgres://inventory_user:pw@127.0.0.1:5432/inventory_db?options=' +
  '-c+inventory.allow_ledger_purge%3Don';
const PLAIN = 'postgres://inventory_user:pw@127.0.0.1:5432/inventory_db';

/** Entry points as the OS reports them: a test file, and the real server. */
const TEST_FILE_ARGV = ['node', 'D:\repo\tests\stockAccounting.api.test.ts'];
const SERVER_ARGV = ['node', 'D:\repo\server\index.ts'];

describe('ledger-purge bypass detection', () => {
  test('reads the startup option the runner injects, in both URL encodings and as a DSN', () => {
    assert.equal(hasLedgerPurgeBypass(WITH_OPTION), true);
    assert.equal(hasLedgerPurgeBypass(WITH_OPTION_PLUS), true);
    // A second option chained behind it, as URL.searchParams writes it — the
    // shape tests/ops4Config.test.ts produced when it appended statement_timeout.
    assert.equal(
      hasLedgerPurgeBypass(
        PLAIN + '?options=-c+inventory.allow_ledger_purge%3Don+-c+statement_timeout%3D1000'
      ),
      true
    );
    assert.equal(
      hasLedgerPurgeBypass("host=127.0.0.1 port=5432 options='-c inventory.allow_ledger_purge=on'"),
      true
    );
  });

  test('a switched-off setting, another option or no option is not a bypass', () => {
    assert.equal(
      hasLedgerPurgeBypass(PLAIN + '?options=-c%20inventory.allow_ledger_purge%3Doff'),
      false
    );
    assert.equal(hasLedgerPurgeBypass(PLAIN + '?options=-c%20statement_timeout%3D5000'), false);
    assert.equal(hasLedgerPurgeBypass(PLAIN), false);
    assert.equal(hasLedgerPurgeBypass(''), false);
    assert.equal(hasLedgerPurgeBypass(undefined), false);
  });

  test('a test file without the option is refused; a spawned boot, a script and a DB-down suite are not', () => {
    // Refused, and the refusal says how to run it properly.
    assert.throws(
      () => assertTestLedgerPurgeBypass({ DATABASE_URL: PLAIN }, TEST_FILE_ARGV),
      /run_tests\.mjs/
    );
    // The runner's own child (option on the URL): allowed.
    assert.doesNotThrow(() =>
      assertTestLedgerPurgeBypass({ DATABASE_URL: WITH_OPTION }, TEST_FILE_ARGV)
    );
    // A boot a suite spawns: entry point is the server, not a test file.
    assert.doesNotThrow(() => assertTestLedgerPurgeBypass({ DATABASE_URL: PLAIN }, SERVER_ARGV));
    // Outside a test file (dev server, CLI script): never checked.
    assert.doesNotThrow(() =>
      assertTestLedgerPurgeBypass({ DATABASE_URL: PLAIN }, ['node', 'server/index.ts'])
    );
    // A suite proving the fail-closed path clears its URL: no pool, no bypass.
    assert.doesNotThrow(() =>
      assertTestLedgerPurgeBypass({ DATABASE_URL: '' }, TEST_FILE_ARGV)
    );
  });
});
