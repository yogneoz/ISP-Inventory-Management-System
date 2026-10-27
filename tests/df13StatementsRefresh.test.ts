/**
 * DF-13 — Financial Statements follows the live financial summary.
 *
 * The screen's per-branch matrix used to be fetched only on tab activation and
 * was preferred over the `financialSummary` prop in `figuresFor`. DF-05 keeps
 * that prop fresh on every domain that moves it, so the old map shadowed the
 * live value and the statements stayed at activation-time numbers.
 *
 * PROVES (source pin — the screen's fetch lives behind an ESM API import and
 * there is no behavioural harness for it; see A6):
 *   1. The batch effect re-runs when `financialSummary` changes, so an open
 *      Statements tab follows a sale/payment/purchase posted elsewhere.
 *   2. The read is skipped while the keep-mounted tab is hidden; the next
 *      activation re-runs it, so a hidden tab cannot issue a batch for every
 *      stock edit nobody is looking at.
 *   3. The memoized statement/comparison tables depend on `financialSummary`
 *      as well, so the fallback path (a failed batch, or a branch missing from
 *      the map) repaints from the live prop instead of a stale closure.
 *   4. The activation/Retry triggers are still wired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('DF-13: statements batch follows the live summary and skips hidden reads', () => {
  const source = fs.readFileSync(
    path.resolve('client/src/features/finance/FinancialStatements.tsx'),
    'utf8'
  );

  assert.ok(
    source.includes("useTabActive('financial-statements')"),
    'the screen must know whether its keep-mounted tab is visible'
  );
  assert.ok(
    /useEffect\(\(\) => \{\s*\n\s*if \(!isActive\) return;/.test(source),
    'the batch must not run while the tab is hidden'
  );
  assert.ok(
    source.includes('activationKey, summariesRetryKey, financialSummary])'),
    'the batch effect must re-run on a refreshed financialSummary and keep the activation/retry triggers'
  );
  assert.ok(
    source.includes('assetTotalsByBranch, priorAssetTotalsByBranch, activeBranches, financialSummary])'),
    'the statement table memo must depend on the live summary and the server asset totals'
  );
  assert.match(
    source,
    /summaryMap, assetTotalsByBranch, priorAssetTotalsByBranch, financialSummary\]\)/,
    'the branch comparison memo must depend on the live summary and the server asset totals'
  );
  assert.ok(
    source.includes('getFinancialSummaries('),
    'the batch read must remain the screen\'s only fetch'
  );
  assert.ok(
    source.includes("useActivationKey('financial-statements')"),
    're-activation must still trigger the batch'
  );
});
