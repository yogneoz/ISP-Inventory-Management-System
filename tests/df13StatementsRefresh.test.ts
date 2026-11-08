/**
 * DF-13 — the finance landing screen follows its live tab and avoids hidden
 * reads.
 *
 * The screen is keep-mounted. Its posted-ledger reads must run on first
 * activation, skip while the tab is hidden, and re-run when a register refresh
 * or the Retry action bumps its keys. The source pin covers the fetch shape
 * that keeps an open dashboard current without polling a hidden tab.
 *
 * PROVES (source pin — the screen fetches through ESM API methods and there is
 * no behavioural harness for the full dashboard; see A6):
 *   1. The screen knows whether its keep-mounted tab is visible.
 *   2. The load effect exits while the tab is hidden.
 *   3. Re-activation/Retry/refresh keys are in the effect dependencies.
 *   4. The independent posted-ledger reads are loaded as one batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('DF-13: finance dashboard skips hidden reads and follows activation/refresh', () => {
  const source = fs.readFileSync(
    path.resolve('client/src/features/finance/FinanceDashboard.tsx'),
    'utf8'
  );

  assert.ok(
    source.includes("useTabActive('financial-statements')"),
    'the screen must know whether its keep-mounted tab is visible'
  );
  assert.ok(
    /useEffect\(\(\) => \{\s*\n\s*if \(!isActive\) return;/.test(source),
    'the posted-ledger batch must not run while the tab is hidden'
  );
  assert.ok(
    source.includes("useActivationKey('financial-statements')"),
    're-activation must still trigger the batch'
  );
  assert.match(
    source,
    /activationKey,\s*\n\s*reloadKey,\s*\n\s*refreshToken,/,
    'activation, retry and register-refresh keys must re-run the batch'
  );
  assert.ok(
    source.includes('Promise.allSettled('),
    'the independent posted-ledger reads must be batched'
  );
  for (const call of [
    'api.getProfitAndLoss(',
    'api.getBalanceSheet(',
    'api.getCashFlow(',
    'api.getCashBook(',
    'api.getAging(',
  ]) {
    assert.ok(source.includes(call), `${call} must remain part of the dashboard read`);
  }

  // Branch comparison reuses the same posted-ledger reads per branch, while
  // the drilldowns fetch the exact journal lines behind a KPI/control.
  assert.ok(source.includes('FinanceBranchComparison'), 'the branch-comparison mode must remain wired');
  assert.ok(source.includes("view === 'comparison'"), 'the comparison view must remain selectable');
  assert.ok(source.includes('LedgerDrilldownDialog'), 'KPI/control drill-through must remain wired');
  assert.ok(source.includes('window.print()'), 'the print action must remain available');
  assert.ok(source.includes('exportToCSV('), 'the CSV export action must remain available');

  // The dialog owns the line reads, so pin that surface where it lives.
  const drilldown = fs.readFileSync(
    path.resolve('client/src/components/accounting/LedgerDrilldownDialog.tsx'),
    'utf8'
  );
  assert.ok(
    drilldown.includes('api.getStatementGroupLines('),
    'statement drill-through must read posted group lines'
  );
  assert.ok(
    drilldown.includes('api.getTrialBalanceAccountLines('),
    'account/control drill-through must read posted account lines'
  );
});
