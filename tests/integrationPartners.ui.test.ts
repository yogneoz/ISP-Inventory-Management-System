/**
 * Integration Partners console — mounted DOM behaviour.
 *
 * PROVES:
 *  1. The screen loads the partner rows and the delivery queue from the two
 *     documented admin reads and renders them (code, status, queued counts).
 *  2. A refused action surfaces the server's `{ code, message, retryable,
 *     details }` envelope in the banner instead of a generic sentence — an
 *     operator has to be able to tell "not retryable" from "try again".
 *  3. A successful replay re-reads the queue, so the row's status moves from
 *     FAILED to DELIVERED without a manual refresh.
 *
 * The harness is the repo's own: node:test + jsdom + `mountTree` (there is no
 * vitest/jest/testing-library dependency in this project).
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { mountTree } from './harness/mount';
import { IntegrationPartners } from '../client/src/features/settings/IntegrationPartners';

const admin = {
  id: 'u-admin',
  name: 'Admin',
  email: 'admin@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: ['ALL'],
} as any;

interface Call {
  url: string;
  method: string;
  body: any;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function partnerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'partner-1',
    code: 'SUBSPORTAL',
    name: 'Subscription Portal',
    contract_version: 'v1',
    status: 'ACTIVE',
    allowed_events: ['inventory.stock_changed'],
    api_key_id: '11111111-2222-3333-4444-555555555555',
    created_at: '2026-11-20T10:00:00.000Z',
    pending_events: 1,
    dead_events: 0,
    ...overrides,
  };
}

function outboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ob-1',
    event: 'inventory.stock_changed',
    entity: 'PRODUCT',
    entity_id: 'int-test-product',
    status: 'FAILED',
    attempts: 1,
    last_error: 'Partner answered 500.',
    created_at: '2026-11-20T10:00:00.000Z',
    delivered_at: null,
    next_attempt_at: '2026-11-20T10:00:30.000Z',
    partner_code: 'SUBSPORTAL',
    ...overrides,
  };
}

/** Routes by METHOD + path suffix and records every call. */
function installFetch(handler: (call: Call) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = ((input: any, init?: any) => {
    const call: Call = {
      url: String(input),
      method: String(init?.method || 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as any;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickByText(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent || '').trim().includes(label)
  );
  assert.ok(button, `no button labelled "${label}"`);
  await act(async () => {
    button!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Integration Partners console', () => {
  test('loads the partner rows and their delivery queue', async () => {
    installFetch((call) => {
      if (call.url.includes('/api/admin/integration/partners')) {
        return jsonResponse(200, [partnerRow()]);
      }
      if (call.url.includes('/api/admin/integration/outbox')) {
        return jsonResponse(200, [outboxRow()]);
      }
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'unexpected call' });
    });

    const tree = mountTree(createElement(IntegrationPartners, { currentUser: admin }));
    await flush();

    const text = tree.container.textContent || '';
    assert.match(text, /Subscription Portal/, 'the partner name is rendered');
    assert.match(text, /SUBSPORTAL/, 'the partner code is rendered');
    assert.match(text, /1 partner/, 'the partner count is rendered');
    assert.match(text, /1 pending/, 'the queued-event count is rendered');
    assert.match(text, /ACTIVE/, 'the partner status is rendered');

    // Opening the partner shows its queue, including the backoff timestamp.
    await clickByText(tree.container, 'Subscription Portal');
    const opened = tree.container.textContent || '';
    assert.match(opened, /Delivery queue — SUBSPORTAL/);
    assert.match(opened, /inventory\.stock_changed/);
    assert.match(opened, /FAILED/);
    assert.match(opened, /Partner answered 500\./);

    tree.unmount();
  });

  test('a refused action surfaces the code, message and retryability', async () => {
    installFetch((call) => {
      if (call.url.includes('/api/admin/integration/partners') && call.method === 'GET') {
        return jsonResponse(200, [partnerRow()]);
      }
      if (call.url.includes('/api/admin/integration/outbox')) {
        return jsonResponse(200, []);
      }
      if (call.method === 'PATCH') {
        return jsonResponse(409, {
          code: 'PARTNER_IN_USE',
          message: 'This partner still has queued events.',
          retryable: false,
          details: { pending_events: 1 },
        });
      }
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'unexpected call' });
    });

    const tree = mountTree(createElement(IntegrationPartners, { currentUser: admin }));
    await flush();
    await clickByText(tree.container, 'Suspend');

    const text = tree.container.textContent || '';
    assert.match(text, /This partner still has queued events\./, 'the server message is shown');
    assert.match(text, /PARTNER_IN_USE/, 'the machine-readable code is shown');
    assert.match(text, /not retryable/, 'the retryability is shown');
    assert.match(text, /pending_events/, 'the details payload is shown');
    assert.equal(
      calls.some((call) => call.method === 'PATCH'),
      true,
      'the refusal came from the documented PATCH endpoint'
    );

    tree.unmount();
  });

  test('a successful replay re-reads the queue and shows the new status', async () => {
    let outboxReadCount = 0;
    installFetch((call) => {
      if (call.url.includes('/api/admin/integration/partners') && call.method === 'GET') {
        return jsonResponse(200, [partnerRow()]);
      }
      if (call.url.includes('/api/admin/integration/outbox') && call.method === 'GET') {
        outboxReadCount += 1;
        return jsonResponse(
          200,
          [outboxRow({ status: outboxReadCount === 1 ? 'FAILED' : 'DELIVERED', attempts: outboxReadCount === 1 ? 1 : 2, delivered_at: outboxReadCount === 1 ? null : '2026-11-20T10:01:00.000Z' })]
        );
      }
      if (call.url.includes('/replay')) {
        return jsonResponse(200, { id: 'ob-1', status: 'PENDING' });
      }
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'unexpected call' });
    });

    const tree = mountTree(createElement(IntegrationPartners, { currentUser: admin }));
    await flush();
    await clickByText(tree.container, 'Subscription Portal');
    assert.match(tree.container.textContent || '', /FAILED/);

    await clickByText(tree.container, 'Replay');
    const text = tree.container.textContent || '';
    assert.equal(
      calls.some((call) => call.method === 'POST' && call.url.includes('/outbox/ob-1/replay')),
      true,
      'the replay hit the documented endpoint'
    );
    assert.match(text, /Event inventory\.stock_changed is queued/, 'the operator gets a confirmation');
    assert.match(text, /DELIVERED/, 'the row was re-read, not patched in place');
    assert.doesNotMatch(text, /FAILED/, 'the stale status is gone');
    assert.equal(outboxReadCount >= 2, true, 'the queue was re-read after the replay');

    tree.unmount();
  });
});
