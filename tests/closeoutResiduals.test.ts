/**
 * Close-out residuals (data-fetching review, 2026-10-24).
 *
 * PROVES:
 *  1. The shared load notice can say what a failed COLUMN read means, not only
 *     what an empty list means (custom cached/empty copy).
 *  2. Both customer screens surface a failed device read with a Retry instead
 *     of silently keeping stale rows (or showing a real-looking zero).
 *  3. The BS calendar health panel guards its integrity read with a
 *     latest-only ticket, and a repair invalidates reads already in flight.
 *  4. The reports batch endpoint computes its pairs with bounded concurrency
 *     rather than serially (the helper itself is covered in
 *     mapWithConcurrency.test.ts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { mountTree } from './harness/mount';
import { LoadStateNotice } from '../client/src/components/common/LoadStateNotice';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

const renderNotice = (props: Partial<React.ComponentProps<typeof LoadStateNotice>>) => {
  const tree = mountTree(
    createElement(LoadStateNotice, {
      subject: 'the assigned hardware counts',
      loading: false,
      error: 'HTTP 500: devices unavailable',
      onRetry: () => undefined,
      ...props,
    })
  );
  return tree;
};

describe('load notice — custom copy for a column read', () => {
  test('says what a missing column means instead of "nothing is shown below"', () => {
    const tree = renderNotice({ emptyNote: ' Assigned device counts may show 0 until this loads.' });
    try {
      const text = tree.container.textContent || '';
      assert.match(text, /Could not load the assigned hardware counts/);
      assert.match(text, /may show 0 until this loads/);
      assert.doesNotMatch(text, /nothing is shown below/i);
    } finally {
      tree.unmount();
    }
  });

  test('says cached numbers may be out of date rather than cached rows', () => {
    const tree = renderNotice({
      hasCachedRows: true,
      cachedNote: ' Assigned device counts may be out of date.',
    });
    try {
      const text = tree.container.textContent || '';
      assert.match(text, /Assigned device counts may be out of date\./);
      assert.doesNotMatch(text, /last loaded rows/);
    } finally {
      tree.unmount();
    }
  });
});

describe('customer device reads — failures are visible and retryable', () => {
  const screens = [
    {
      file: 'client/src/features/sales/CustomersManagement.tsx',
      subject: 'the device register',
    },
    {
      file: 'client/src/features/sales/CustomerMasterDirectory.tsx',
      subject: 'the assigned hardware counts',
    },
  ];

  for (const screen of screens) {
    test(`${screen.file} keeps an error, retries it and renders the notice`, () => {
      const source = read(screen.file);
      assert.ok(source.includes('LoadStateNotice'), 'the failure must be rendered');
      assert.ok(
        source.includes('setDevicesFetchError(err?.message'),
        'a failed read must keep its message'
      );
      assert.ok(source.includes('setDevicesRetryKey((k) => k + 1)'), 'Retry must re-run the read');
      assert.ok(
        source.includes('devicesRetryKey])'),
        'the retry key must be an effect dependency, or Retry does nothing'
      );
      assert.ok(
        source.includes(`subject="${screen.subject}"`),
        'the notice must name what could not be read'
      );
      assert.ok(
        source.includes('setDevicesFetchError(\'\')'),
        'a successful read must clear the failure'
      );
    });
  }
});

describe('BS calendar health — latest read wins', () => {
  test('the integrity read is ticketed and only the newest may paint', () => {
    const source = read('client/src/features/finance/BsCalendarHealthPanel.tsx');
    assert.ok(source.includes('createLatestOnly()'), 'the panel must use the shared guard');
    assert.ok(source.includes('const ticket = auditTicket.begin();'), 'every read takes a ticket');
    assert.ok(
      source.includes('if (!auditTicket.isCurrent(ticket)) return;'),
      'a superseded read must not paint data or raise its error'
    );
    assert.ok(
      source.includes('if (auditTicket.isCurrent(ticket)) setIsLoading(false);'),
      'a superseded read must not settle the spinner'
    );
    assert.ok(
      /auditTicket\.begin\(\);\s*\n\s*setIsLoading\(false\);/.test(source),
      'a repair must invalidate reads already in flight and take the spinner back'
    );
  });
});

describe('review follow-up — retry state reachable from the screen', () => {
  test('a failed batch summary read has its own Retry, not just a tab switch', () => {
    const source = read('client/src/features/finance/FinancialStatements.tsx');
    assert.ok(
      source.includes('setSummariesRetryKey((k) => k + 1)'),
      'the error line must offer a retry'
    );
    assert.ok(
      source.includes('activationKey, summariesRetryKey])'),
      'the retry key must re-run the batch effect'
    );
    assert.ok(
      source.includes('disabled={summariesLoading}'),
      'the retry must be disabled while the batch is already running'
    );
  });

  test('a failed device read does not leave the empty table claiming no matches', () => {
    const source = read('client/src/features/sales/CustomersManagement.tsx');
    assert.ok(
      source.includes('The device register could not be loaded — use Retry above.'),
      'the empty row must name the failed read, not a search result'
    );
    assert.match(
      source,
      /\{devicesFetchError\s*\n\s*\? 'The device register could not be loaded/,
      'the two empty states must be chosen by the read result'
    );
    assert.ok(
      source.includes('disabled={Boolean(devicesFetchError)}'),
      'CSV export must not emit stale rows while the current read is failing'
    );
  });
});

describe('reports batch — bounded parallelism', () => {
  test('pairs are computed through mapWithConcurrency, not a serial loop', () => {
    const source = read('server/src/controllers/reports.controller.ts');
    assert.ok(source.includes('mapWithConcurrency(pairs, SUMMARY_PAIR_CONCURRENCY'), 'the batch must run pairs through the bounded helper');
    assert.ok(source.includes('const SUMMARY_PAIR_CONCURRENCY = 3;'), 'the bound must be explicit');
    assert.ok(
      !/for \(const branchId of branches\) \{\s*\n\s*for \(const fiscalYearId of years\)/.test(source),
      'the serial pair loop must be gone'
    );
  });
});
