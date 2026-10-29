/**
 * Setup-list load failures (DF-11).
 *
 * Category, UoM, Locations and Document Numbering caught their fetch failure,
 * logged it and rendered an empty list — indistinguishable from "there are none
 * configured" — and threw away their loading flag, so the empty state flashed
 * before the first response showed. Product Management already rendered its
 * catalog error but kept a second, write-only error flag.
 *
 * PROVES:
 *   1. The shared notice distinguishes loading (spinner, no alert) from a
 *      failed read (alert naming the list, the error and whether cached rows
 *      remain), so neither state can pass for an empty list.
 *   2. Retry re-runs the load, and is disabled/spinning while that retry is in
 *      flight; a successful load clears the caller's error, unmounting it.
 *   3. All four setup lists keep a real loading flag and a rendered error, call
 *      the notice with their own loader, and say "could not be loaded" in the
 *      empty slot instead of implying zero rows.
 *   4. Product Management's catalog error is rendered with Retry and its
 *      write-only category error state is gone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React, { createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { LoadStateNotice } from '../client/src/components/common/LoadStateNotice';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

const render = (props: Partial<React.ComponentProps<typeof LoadStateNotice>> = {}) => {
  let retries = 0;
  const tree = mountTree(
    createElement(LoadStateNotice, {
      subject: 'categories',
      loading: false,
      error: '',
      onRetry: () => {
        retries++;
      },
      ...props,
    })
  );
  return { tree, retries: () => retries };
};

describe('load state notice — loading vs failed vs empty', () => {
  test('an initial load shows a spinner status, never an empty-state alert', () => {
    const { tree } = render({ loading: true });
    try {
      assert.equal(tree.container.querySelectorAll('[role="alert"]').length, 0);
      const status = tree.container.querySelector('[role="status"]');
      assert.ok(status, 'loading must render a status, so the screen is not just empty');
      assert.match(status!.textContent || '', /Loading categories…/);
      assert.ok(status!.querySelector('svg')?.getAttribute('class')?.includes('animate-spin'));
    } finally {
      tree.unmount();
    }
  });

  test('a re-activation refetch does not flash a spinner over rows already shown', () => {
    const { tree } = render({ loading: true, hasCachedRows: true });
    try {
      assert.equal(tree.container.childElementCount, 0);
    } finally {
      tree.unmount();
    }
  });

  test('a failed read says it could not load and that this is not an empty list', () => {
    const { tree } = render({ error: 'HTTP 500: catalog unavailable' });
    try {
      assert.equal(tree.container.querySelectorAll('[role="alert"]').length, 1);
      const text = tree.container.textContent || '';
      assert.match(text, /Could not load categories/);
      assert.match(text, /HTTP 500: catalog unavailable/);
      assert.match(text, /this is not an empty list/);
      assert.doesNotMatch(text, /Showing the last loaded rows/);
    } finally {
      tree.unmount();
    }
  });

  test('a failure with rows from an earlier load labels them as possibly stale', () => {
    const { tree } = render({ error: 'HTTP 500: catalog unavailable', hasCachedRows: true });
    try {
      const text = tree.container.textContent || '';
      assert.match(text, /Showing the last loaded rows/);
      assert.match(text, /they may be out of date/);
      assert.doesNotMatch(text, /this is not an empty list/);
    } finally {
      tree.unmount();
    }
  });

  test('Retry re-runs the load; it is disabled and spinning while retrying', () => {
    const { tree, retries } = render({ error: 'timeout' });
    try {
      const button = tree.container.querySelector('button');
      assert.ok(button, 'the failure must offer a Retry');
      inAct(() => {
        button!.click();
      });
      assert.equal(retries(), 1);

      tree.rerender(
        createElement(LoadStateNotice, {
          subject: 'categories',
          loading: true,
          error: 'timeout',
          onRetry: () => {
            throw new Error('Retry must not fire while a retry is in flight');
          },
        })
      );
      const retry = tree.container.querySelector('button');
      assert.equal(retry?.disabled, true);
      assert.match(retry!.textContent || '', /Retrying…/);
      assert.ok(retry?.querySelector('svg')?.getAttribute('class')?.includes('animate-spin'));
    } finally {
      tree.unmount();
    }
  });

  test('a successful load (no error) renders nothing — the notice clears', () => {
    const { tree } = render();
    try {
      assert.equal(tree.container.childElementCount, 0);
    } finally {
      tree.unmount();
    }
  });

  test('a quiet background read paints nothing while loading but its failure still retries', () => {
    // Shell-level reads (settings, procurement badges) keep the last values on
    // screen; a 31px "Loading…" bar mounting and unmounting while the page
    // settles is the startup flicker this prop exists to remove.
    const { tree } = render({ loading: true, showLoading: false });
    try {
      assert.equal(tree.container.childElementCount, 0, 'no loading bar is painted');
      tree.rerender(
        createElement(LoadStateNotice, {
          subject: 'company settings',
          loading: false,
          showLoading: false,
          error: 'settings unavailable',
          onRetry: () => {},
        })
      );
      const alert = tree.container.querySelector('[role="alert"]');
      assert.ok(alert, 'a real failure is still reported');
      assert.match(alert!.textContent || '', /Could not load company settings/);
      assert.ok(tree.container.querySelector('button'), 'the failure still offers Retry');
    } finally {
      tree.unmount();
    }
  });
});

describe('setup lists — loading/error state is kept and rendered', () => {
  const screens = [
    {
      file: 'client/src/features/inventory/CategoryManagement.tsx',
      subject: 'categories',
      loader: 'loadCategoriesFromDb',
    },
    {
      file: 'client/src/features/inventory/UomManagement.tsx',
      subject: 'units of measure',
      loader: 'loadUoms',
    },
    {
      file: 'client/src/features/settings/LocationsManagement.tsx',
      subject: 'locations',
      loader: 'loadLocations',
    },
    {
      file: 'client/src/features/finance/DocumentNumbering.tsx',
      subject: 'document numbering configurations',
      loader: 'loadDocumentNumberConfigs',
    },
  ];

  for (const screen of screens) {
    test(`${screen.file} renders the notice, keeps loading, and retries its own loader`, () => {
      const source = read(screen.file);
      assert.ok(source.includes('<LoadStateNotice'), 'the screen must render the shared notice');
      assert.ok(source.includes(`subject="${screen.subject}"`), 'the notice must name the list');
      assert.ok(source.includes('error={loadError}'), 'the notice must show the actual fetch error');
      assert.ok(
        source.includes(`onRetry={${screen.loader}}`),
        'Retry must re-run the same load, not reload the page'
      );
      assert.ok(source.includes('setLoadError('), 'the catch must record the failure');
      assert.ok(
        !source.includes('const [, setLoading]'),
        'the loading flag must be read, not discarded, so a spinner can show'
      );
      assert.match(
        source,
        /const \[loading, setLoading\]/,
        'the screen must keep a real loading flag'
      );
      assert.ok(
        source.includes('use Retry above.'),
        'the empty slot must say the list could not be loaded instead of implying zero rows'
      );
    });
  }

  test('Product Management renders its catalog error with Retry and has no write-only error state', () => {
    const source = read('client/src/features/inventory/ProductManagement.tsx');
    assert.ok(source.includes('{catalogLoadError && ('), 'the catalog failure must actually render');
    assert.ok(source.includes('Could not load the product catalog'));
    assert.ok(
      source.includes('onClick={() => setCatalogVersion((version) => version + 1)}'),
      'Retry must re-run the catalog fetch'
    );
    // The category options are derived from the catalog fetch, so a second
    // error flag could only be set and never read (the old dead state).
    assert.doesNotMatch(source, /categoryLoadError/);
    assert.doesNotMatch(source, /setCategoryLoadError/);
  });
});
