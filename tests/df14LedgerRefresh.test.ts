/**
 * DF-14 — party ledgers refresh on ledger events.
 *
 * Both ledgers re-ran only when the party changed or the keep-mounted tab was
 * re-activated, and App passed no refresh key. A payment, reversal or return
 * recorded elsewhere (another user's SSE burst, or any local action that calls
 * refreshAllData) updated the bootstrap invoice slices but never the open
 * ledger, so its closing balance stayed at activation-time figures until the
 * operator left and re-entered the tab.
 *
 * PROVES (source pin — the fetch lives behind an ESM API import and there is
 * no behavioural harness for it; see A6):
 *   1. Each ledger takes the register counters App already keeps and includes
 *      them in its fetch effect's dependencies, so a burst re-reads the
 *      selected party in place.
 *   2. App passes the matching counters: procurement invoices to the vendor
 *      ledger, sales invoices plus the shared returns register to the customer
 *      ledger (a credit note moves the receivable too).
 *   3. The read stays skipped while no party is selected — the counter bumps
 *      must not turn an empty picker into a request.
 *   4. Hidden keep-mounted tabs skip the read (DF-13's `useTabActive`
 *      precedent); the next activation re-runs it, so a burst elsewhere cannot
 *      issue a ledger request nobody can see.
 *   5. The DF-08 sequence guard and the activation trigger are still wired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');

/** The JSX element for one screen in App.tsx, from its tag to its `/>`. */
function appElement(appSource: string, tag: string): string {
  const match = appSource.match(new RegExp(`<${tag}\\b[\\s\\S]*?/>`));
  assert.ok(match, `App.tsx no longer renders <${tag}>`);
  return match[0];
}

test('DF-14: the vendor ledger follows procurement register events', () => {
  const source = read('client/src/features/finance/VendorLedger.tsx');

  assert.ok(
    /sseRefreshKey\?: number;/.test(source),
    'the vendor ledger must take the procurement register counter'
  );
  assert.ok(
    source.includes("useTabActive('vendor-ledger')"),
    'the ledger must know whether its keep-mounted tab is visible'
  );
  assert.match(
    source,
    /if \(!isVisible\) return;/,
    'the effect must skip the read while the tab is hidden'
  );
  assert.ok(
    source.includes('[selectedSupplierId, activationKey, sseRefreshKey, isVisible]'),
    'the fetch effect must re-run on a procurement event and keep the party/activation triggers'
  );
  assert.ok(
    source.includes('if (!selectedSupplierId) return;'),
    'an event bump with no supplier selected must not issue a request'
  );
});

test('DF-14: the customer ledger follows sales and return register events', () => {
  const source = read('client/src/features/finance/CustomerLedger.tsx');

  assert.ok(
    /sseRefreshKey\?: number;/.test(source),
    'the customer ledger must take the sales register counter'
  );
  assert.ok(
    /returnsRefreshKey\?: number;/.test(source),
    'a posted/cancelled credit note moves the receivable — the returns counter must be taken too'
  );
  assert.ok(
    source.includes("useTabActive('customer-ledger')"),
    'the ledger must know whether its keep-mounted tab is visible'
  );
  assert.match(
    source,
    /if \(!isVisible\) return;/,
    'the effect must skip the read while the tab is hidden'
  );
  assert.ok(
    source.includes('[selectedCustomerId, activationKey, sseRefreshKey, returnsRefreshKey, isVisible]'),
    'the fetch effect must re-run on sales/return events and keep the party/activation triggers'
  );
  assert.ok(
    source.includes('if (!selectedCustomerId) return;'),
    'an event bump with no customer selected must not issue a request'
  );
});

test('DF-14: App feeds each ledger the counters that actually move it', () => {
  const app = read('client/src/App.tsx');
  const vendor = appElement(app, 'VendorLedger');
  const customer = appElement(app, 'CustomerLedger');

  assert.ok(
    vendor.includes('sseRefreshKey={registerRefresh.purchaseInvoices}'),
    'the vendor ledger must re-read on the procurement invoice/payment counter'
  );
  assert.ok(
    customer.includes('sseRefreshKey={registerRefresh.salesInvoices}'),
    'the customer ledger must re-read on the sales invoice/payment counter'
  );
  assert.ok(
    customer.includes('returnsRefreshKey={registerRefresh.returnsRegister}'),
    'the customer ledger must re-read on the shared returns-register counter'
  );
});

test('DF-14: the ledgers keep their DF-08 sequence guard and latest-only paint', () => {
  for (const file of [
    'client/src/features/finance/VendorLedger.tsx',
    'client/src/features/finance/CustomerLedger.tsx',
  ]) {
    const source = read(file);
    assert.ok(
      source.includes('createLatestOnly()'),
      `${file} lost the sequence guard: a slower previous response must not paint over a newer one`
    );
    assert.match(
      source,
      /if \(!fetchSeq\.isCurrent\(ticket\)\) return;/,
      `${file} must discard a response that is no longer current`
    );
  }
});
