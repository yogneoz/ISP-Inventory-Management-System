/**
 * One refusal, one place.
 *
 * Both exchange dialogs show the server's refusal in their own dialog, so the
 * global mutation-error toast must not repeat it (the toast auto-dismisses while
 * the dialog stays open — the operator reads the sentence twice and trusts the
 * one that vanishes). `fetchJson` now takes `{ silent }` for exactly that case,
 * and `exchangeCustomerDevice` exposes it as `{ silentErrorToast }`.
 *
 * PROVES: a refused mutation still carries its toast payload on the error
 * (callers that render it need the message), but only broadcasts it when the
 * caller did NOT ask for silence — and the default stays broadcasting.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

interface CapturedEvent {
  type: string;
  detail?: any;
}

const events: CapturedEvent[] = [];

// The request pipeline talks to `window` for toasts and 401 expiry; stub the
// two APIs it uses instead of pulling in a DOM.
(globalThis as any).window = {
  dispatchEvent: (event: any) => {
    events.push({ type: event.type, detail: event.detail });
    return true;
  },
};
(globalThis as any).CustomEvent = class {
  type: string;
  detail: any;
  constructor(type: string, init?: { detail?: any }) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const realFetch = globalThis.fetch;
const { fetchJson, API_TOAST_EVENT } = await import('../client/src/services/api/http');
const { exchangeCustomerDevice } = await import('../client/src/services/api/inventory');

const refusedFetch = async () =>
  new Response(JSON.stringify({ message: 'SN-X is CUSTOMER ASSIGNED (not IN_STOCK).' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

const toastCount = () => events.filter((e) => e.type === API_TOAST_EVENT).length;

const payload = {
  oldDeviceId: 'cdr-1',
  exchangeReason: 'test',
  oldDeviceAction: 'RESTOCK' as const,
  newProductName: 'ONU ROUTER',
  newDeviceSerial: 'SN-X',
  newPonSerial: 'PON-X',
  branchId: 'WH001',
};

describe('a refusal rendered in a dialog is not toasted too', () => {
  beforeEach(() => {
    events.length = 0;
    globalThis.fetch = refusedFetch as any;
  });

  test('fetchJson({ silent }) still rejects with the toast payload, but broadcasts nothing', async () => {
    await assert.rejects(
      () => fetchJson('/api/anything', { method: 'POST' }, { silent: true }),
      (error: any) => {
        assert.equal(error.status, 400);
        assert.equal(error.body.message, 'SN-X is CUSTOMER ASSIGNED (not IN_STOCK).');
        assert.equal(error.toast?.message, 'SN-X is CUSTOMER ASSIGNED (not IN_STOCK).');
        return true;
      }
    );
    assert.equal(toastCount(), 0, 'the silent caller owns the message');
  });

  test('fetchJson without the flag broadcasts exactly once (default unchanged)', async () => {
    await assert.rejects(() => fetchJson('/api/anything', { method: 'POST' }));
    assert.equal(toastCount(), 1);
    assert.equal(events[0].detail.status, 400);
  });

  test('exchangeCustomerDevice({ silentErrorToast }) is the dialog path', async () => {
    await assert.rejects(() => exchangeCustomerDevice(payload, { silentErrorToast: true }));
    assert.equal(toastCount(), 0);
  });

  test('exchangeCustomerDevice keeps the toast for callers that do not opt out', async () => {
    await assert.rejects(() => exchangeCustomerDevice(payload));
    assert.equal(toastCount(), 1);
    assert.match(String(events[0].detail.message), /CUSTOMER ASSIGNED/);
  });

  test('a GET is never toasted regardless of the flag', async () => {
    await assert.rejects(() => fetchJson('/api/anything'));
    assert.equal(toastCount(), 0);
  });
});

process.on('exit', () => {
  globalThis.fetch = realFetch;
});
