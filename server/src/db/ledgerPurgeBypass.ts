/**
 * Refuses a test file that is missing the ledger-purge startup option.
 *
 * Fixture teardown removes the journals it posted, and the ledger's append-only
 * trigger only permits that on a connection started with the session setting
 * `inventory.allow_ledger_purge=on`. `scripts/run_tests.mjs` is the only thing
 * that puts it on the connection URL, as a libpq startup option
 * (`options=-c inventory.allow_ledger_purge=on`). A bare
 * `npx tsx --test tests/foo.test.ts` does not, so the removal is refused, the
 * posted journals and period balances survive, and the NEXT run fails on
 * balances it did not create — the failure lands one run late, in someone
 * else's suite, on a development database that now holds phantom money.
 *
 * That trade is unacceptable, so the test file stops at import instead:
 * `server/db.ts` is the module every database-touching suite loads, and it
 * calls `assertTestLedgerPurgeBypass` before it builds a pool.
 *
 * Two things keep this from firing where it must not:
 *   - a booting/spawned child inherits `NODE_TEST_CONTEXT` from the test file
 *     that spawned it (the boot-failure suites expect the server's own FATAL
 *     line from it), so the process is only treated as a test file when its
 *     entry point actually is one;
 *   - a suite that clears the URL on purpose (`POSTGRES_PORT` pointing at a
 *     closed port, the fail-closed requirePostgres proof) has no pool through
 *     which a journal could be posted or purged, so it is left alone.
 */
export const LEDGER_PURGE_SETTING = 'inventory.allow_ledger_purge';

/** `inventory.allow_ledger_purge=on`, however the URL spells it. */
const BYPASS_PATTERN = /inventory\.allow_ledger_purge\s*=\s*'?on'?(?=$|[\s&;"'])/i;

/** The runner's children, and nothing they spawn: the entry point is a test file. */
const TEST_FILE_ENTRY = /[\\/]tests[\\/][^\\/]+\.test\.[cm]?[jt]sx?$/;

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not a bypass; the raw text is scanned as-is.
    return value;
  }
}

/**
 * True when this connection string carries the purge setting switched on.
 * Accepts both shapes this repo uses: a URL whose `options` startup parameter
 * holds the setting (node-postgres and libpq both read it), and a key=value
 * DSN. `...=off`, a different option and a URL with no options are all false.
 */
export function hasLedgerPurgeBypass(connection: string | null | undefined): boolean {
  if (!connection) return false;
  // A query string writes a space as `+` (`URL.searchParams` chains options as
  // `...=on+-c+statement_timeout=1000`), so both spellings must read as spaces.
  return BYPASS_PATTERN.test(decodeOnce(connection).replace(/\+/g, ' '));
}

/** True when this process was started on a test file (argv[1]), not on the server. */
export function isTestFileProcess(argv: readonly string[] = process.argv): boolean {
  return TEST_FILE_ENTRY.test(argv[1] ?? '');
}

/**
 * The explanation a test file gets instead of a run that poisons the database,
 * or null when its connection is allowed to purge (or no URL is configured, in
 * which case no pool exists to post or purge a journal through).
 */
export function ledgerPurgeBypassComplaint(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.DATABASE_WRITE_URL ? 'DATABASE_WRITE_URL' : env.DATABASE_URL ? 'DATABASE_URL' : null;
  if (!name) return null;
  if (hasLedgerPurgeBypass(env[name])) return null;

  return [
    'Refusing to run this test file without the ledger-purge bypass.',
    '',
    'Test teardown removes the journals it posted, and the ledger append-only',
    `trigger only permits that on a connection started with ${LEDGER_PURGE_SETTING}=on.`,
    'scripts/run_tests.mjs adds it to the connection URL as a libpq startup option',
    '(options=-c inventory.allow_ledger_purge=on); a bare `npx tsx --test',
    'tests/<file>.test.ts` does not. The removal is then refused, the posted',
    'journals and their period balances survive, and the NEXT run fails on balances',
    'it did not create — a poisoned development database instead of a failed run.',
    '',
    `${name} in this process carries no such startup option.`,
    '',
    'Run the suite through the runner, which injects it:',
    '    node scripts/run_tests.mjs          (npm test runs it after tsc)',
    '',
    'Or give a single file the same startup option yourself. Use & instead of ?',
    'when the URL already carries a query string:',
    '    bash:       DATABASE_URL="<url>?options=-c%20inventory.allow_ledger_purge%3Don" \\',
    '                  npx tsx --test tests/<file>.test.ts',
    '    PowerShell: $env:DATABASE_URL="<url>?options=-c%20inventory.allow_ledger_purge%3Don";',
    '                  npx tsx --test tests/<file>.test.ts',
  ].join('\n');
}

/** Throws for a test file that would run without the purge setting. */
export function assertTestLedgerPurgeBypass(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): void {
  if (!env.NODE_TEST_CONTEXT || !isTestFileProcess(argv)) return;
  const complaint = ledgerPurgeBypassComplaint(env);
  if (complaint) throw new Error(complaint);
}
