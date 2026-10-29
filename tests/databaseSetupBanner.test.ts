/**
 * The database notice must never guess.
 *
 * A launch used to render "PostgreSQL Offline" from the initial
 * `isConnected: false` before the first bootstrap response, then swap to a
 * green "database is connected" bar, then remove it — two layout shifts for a
 * healthy database. These tests pin the three states: unknown (nothing),
 * known failure (the setup banner) and connected (nothing, because a loaded
 * app is its own proof).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { inAct, mountTree } from './harness/mount';
import { DatabaseSetupBanner } from '../client/src/components/common/DatabaseSetupBanner';

const TARGET = {
  host: 'db.internal',
  port: 6543,
  database: 'erp_test',
  user: 'erp_user',
  isConnected: false,
  errorDetails: 'connect ECONNREFUSED 10.0.0.5:6543',
};

const has = (root: HTMLElement, selector: string) => root.querySelector(selector) !== null;

describe('database setup banner', () => {
  test('an unknown state renders nothing during first paint', () => {
    const tree = mountTree(
      h(DatabaseSetupBanner, { statusKnown: false, postgresConfig: TARGET })
    );
    try {
      assert.equal(has(tree.container, '#db-setup-notification-banner'), false);
      assert.equal(has(tree.container, '#db-connected-notification-banner'), false);
    } finally {
      tree.unmount();
    }
  });

  test('a known failure shows the target, the server reason and the real setup command', () => {
    const tree = mountTree(
      h(DatabaseSetupBanner, { statusKnown: true, postgresConfig: TARGET })
    );
    try {
      const banner = tree.container.querySelector('#db-setup-notification-banner');
      assert.ok(banner, 'the setup banner must render for a known failure');
      const text = banner.textContent || '';
      assert.match(text, /erp_user@db\.internal:6543\/erp_test/);
      assert.match(text, /connect ECONNREFUSED 10\.0\.0\.5:6543/);

      inAct(() => {
        (tree.container.querySelector('#btn-toggle-db-setup-instructions') as HTMLElement).click();
      });
      const expanded = tree.container.textContent || '';
      assert.match(expanded, /npm run setup:pg/);
      assert.match(expanded, /POSTGRES_HOST="db\.internal"/);
      assert.match(expanded, /POSTGRES_PORT="6543"/);
      assert.match(expanded, /POSTGRES_DB="erp_test"/);
      assert.equal(has(tree.container, '#db-connected-notification-banner'), false);
    } finally {
      tree.unmount();
    }
  });

  test('a connected database renders no success bar', () => {
    const tree = mountTree(
      h(DatabaseSetupBanner, {
        statusKnown: true,
        postgresConfig: { ...TARGET, isConnected: true },
      })
    );
    try {
      assert.equal(has(tree.container, '#db-setup-notification-banner'), false);
      assert.equal(has(tree.container, '#db-connected-notification-banner'), false);
    } finally {
      tree.unmount();
    }
  });
});
