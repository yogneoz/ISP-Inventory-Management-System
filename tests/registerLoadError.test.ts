/**
 * Paged-register load failures (DF-04).
 *
 * PO, PI, SI, Returns and Consumables all render a client-filtered fallback
 * when their page request fails. The fallback is fine, but without a notice the
 * screen looks like a successful, differently-filtered result — and KPI cards
 * or an "export all" built from it state the wrong row set.
 *
 * PROVES:
 *   1. The shared notice names the failed page, the error, and whether cached
 *      rows are on screen.
 *   2. Retry invokes the page fetch again, and is disabled (spinning) while
 *      that retry is in flight.
 *   3. All five registers use the shared notice, clear the error at the start
 *      of the next fetch, and their exports refuse to emit a partial file.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React, { createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { RegisterLoadError } from '../client/src/components/common/RegisterLoadError';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

const renderError = (props: Partial<React.ComponentProps<typeof RegisterLoadError>> = {}) => {
  let retries = 0;
  const tree = mountTree(
    createElement(RegisterLoadError, {
      subject: 'this page of purchase orders',
      message: 'HTTP 500: register unavailable',
      hasCachedRows: false,
      loading: false,
      onRetry: () => {
        retries++;
      },
      ...props,
    })
  );
  return { tree, retries: () => retries };
};

describe('register load error — shared notice', () => {
  test('names the failed page and the error, and says when nothing is cached', () => {
    const { tree } = renderError();
    try {
      assert.equal(tree.container.querySelectorAll('[role="alert"]').length, 1);
      const text = tree.container.textContent || '';
      assert.match(text, /Could not load this page of purchase orders/);
      assert.match(text, /HTTP 500: register unavailable/);
      assert.match(text, /No rows are available to show/);
      assert.doesNotMatch(text, /Showing cached rows/);
    } finally {
      tree.unmount();
    }
  });

  test('labels a fallback as cached rather than letting it pass for this page', () => {
    const { tree } = renderError({ hasCachedRows: true });
    try {
      const text = tree.container.textContent || '';
      assert.match(text, /Showing cached rows instead of this page/);
      assert.match(text, /may be out of date or filtered differently/);
      assert.doesNotMatch(text, /No rows are available to show/);
    } finally {
      tree.unmount();
    }
  });

  test('Retry re-runs the page fetch; it is disabled and spinning during the retry', () => {
    const { tree, retries } = renderError();
    try {
      const button = tree.container.querySelector('button');
      assert.ok(button);
      inAct(() => {
        button!.click();
      });
      assert.equal(retries(), 1, 'Retry must invoke the failed page fetch');

      tree.rerender(
        createElement(RegisterLoadError, {
          subject: 'this page of purchase orders',
          message: 'HTTP 500: register unavailable',
          hasCachedRows: true,
          loading: true,
          onRetry: () => {
            throw new Error('Retry must not fire while a retry is in flight');
          },
        })
      );
      const retry = tree.container.querySelector('button');
      assert.equal(retry?.disabled, true, 'a retry already in flight must disable the button');
      assert.ok(retry?.querySelector('svg')?.getAttribute('class')?.includes('animate-spin'));
      inAct(() => {
        retry!.click();
      });
    } finally {
      tree.unmount();
    }
  });
});

describe('register load error — every paged register wires it in', () => {
  const registers = [
    {
      file: 'client/src/features/procurement/PurchaseOrders.tsx',
      error: 'poLoadError',
      loader: 'loadPoPage',
      pageSubject: 'this page of purchase orders',
    },
    {
      file: 'client/src/features/procurement/PurchaseInvoices.tsx',
      error: 'piLoadError',
      loader: 'loadPiPage',
      pageSubject: 'this page of purchase bills',
    },
    {
      file: 'client/src/features/sales/SalesInvoices.tsx',
      error: 'siLoadError',
      loader: 'loadSiPage',
      pageSubject: 'this page of sales invoices',
    },
    {
      file: 'client/src/features/sales/ReturnsRegister.tsx',
      error: 'retLoadError',
      loader: 'loadRetPage',
      pageSubject: 'this page of returns',
    },
    {
      file: 'client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx',
      error: 'consumableRegisterError',
      loader: 'loadConsumableRegisterPage',
      pageSubject: 'this page of consumable issues',
    },
  ];

  for (const register of registers) {
    test(`${register.file} renders the notice and retries its own fetch`, () => {
      const source = read(register.file);
      assert.ok(
        source.includes('<RegisterLoadError'),
        'the register must render the shared failure notice'
      );
      assert.ok(
        source.includes(`subject="${register.pageSubject}"`),
        'the notice must name the page that failed to load'
      );
      assert.ok(
        source.includes(`message={${register.error}}`),
        'the notice must show the actual fetch error'
      );
      assert.ok(
        source.includes(`onRetry={() => { void ${register.loader}(); }}`),
        'Retry must re-run exactly the page fetch that failed'
      );
      // A stale notice must not survive a successful refetch: each loader
      // clears the error before it starts.
      assert.ok(
        source.includes(`set${register.error[0].toUpperCase()}${register.error.slice(1)}('');`),
        'the loader must clear the error at the start of the next fetch'
      );
    });
  }

  test('exports abort instead of silently emitting the visible page', () => {
    const po = read('client/src/features/procurement/PurchaseOrders.tsx');
    const pi = read('client/src/features/procurement/PurchaseInvoices.tsx');
    const consumables = read('client/src/features/inventory/stockops/ConsumablesRegisterPanel.tsx');

    for (const [name, source, error, dialog] of [
      ['PurchaseOrders', po, 'poLoadError', 'alertDialog'],
      ['PurchaseInvoices', pi, 'piLoadError', 'alertDialog'],
      ['ConsumablesRegisterPanel', consumables, 'consumableRegisterError', 'showToast'],
    ] as const) {
      assert.ok(
        source.includes(`disabled={Boolean(${error})}`),
        `${name}: export must be disabled while the register is in an error state`
      );
      assert.ok(
        !source.includes('// Fall back to the rows already on screen.'),
        `${name}: export must not silently fall back to the visible rows`
      );
      assert.ok(
        source.includes('No file was written.'),
        `${name}: a failed full-register fetch must abort the export with a visible message`
      );
      assert.ok(
        source.includes(`${dialog}(\`Export failed:`),
        `${name}: the abort must be reported through the screen's dialog/toast`
      );
    }
  });
});
