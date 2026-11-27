/**
 * Refuses a test file that runs without the ledger-purge startup option.
 *
 * Fixture teardown removes the journals it posted, and the ledger trigger only
 * permits that on a connection started with `inventory.allow_ledger_purge=on`.
 * scripts/run_tests.mjs puts that on the connection URL as a libpq startup
 * option; a bare `npx tsx --test tests/foo.test.ts` does not, so the rows and
 * their period balances survive and the NEXT run fails on money it never made.
 *
 * server/db.ts calls this before it builds a pool — the one module every
 * database-touching suite loads. Two processes must keep running through it: a
 * server boot a suite spawns (its entry point is not a test file, and it has to
 * print its own FATAL line) and a suite that clears its URL to prove the
 * fail-closed path (no pool, so nothing to post or purge). Hence: refuse only
 * for a test-file entry point that has a URL configured.
 */

/** `inventory.allow_ledger_purge=on`, however the connection string spells it. */
const BYPASS_PATTERN = /inventory\.allow_ledger_purge\s*=\s*'?on'?\b/i;

/** argv[1] of a test file: the runner's children, and nothing they spawn. */
const TEST_FILE_ENTRY = /\.test\.[cm]?[jt]sx?$/;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // a malformed escape is not a bypass
  }
}

/** True when the connection string carries the setting switched on. */
export function hasLedgerPurgeBypass(connection: string | null | undefined): boolean {
  if (!connection) return false;
  // A query string writes a space as `+`, so both spellings must read as spaces.
  return BYPASS_PATTERN.test(decoded(connection).replace(/\+/g, ' '));
}

function complaint(env: NodeJS.ProcessEnv): string | null {
  const name = env.DATABASE_WRITE_URL ? 'DATABASE_WRITE_URL' : env.DATABASE_URL ? 'DATABASE_URL' : null;
  if (!name || hasLedgerPurgeBypass(env[name])) return null;

  return [
    'Refusing to run this test file without the ledger-purge bypass.',
    '',
    'Test teardown deletes the journals it posted, but the ledger trigger only',
    'allows that with inventory.allow_ledger_purge=on — which scripts/run_tests.mjs',
    `adds to the URL and a bare \`npx tsx --test\` run does not. ${name} here`,
    'carries no such option, so those rows would survive and the next run would',
    'fail on balances it never created.',
    '',
    'Run it through the runner:  node scripts/run_tests.mjs   (npm test)',
    'Or for one file:            DATABASE_URL="<url>?options=-c%20inventory.allow_ledger_purge%3Don" npx tsx --test tests/<file>.test.ts',
  ].join('\n');
}

/** Throws for a test file that would run without the purge setting. */
export function assertTestLedgerPurgeBypass(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): void {
  if (!TEST_FILE_ENTRY.test(argv[1] ?? '')) return;
  const refusal = complaint(env);
  if (refusal) throw new Error(refusal);
}
