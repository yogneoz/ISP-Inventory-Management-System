/**
 * DF-07 — the GET dedup key must include the fiscal year.
 *
 * `fetchJson` coalesces concurrent identical GETs by user + branch + URL. The
 * fiscal year travels only in the `x-fiscal-year-id` header, so before the fix
 * a GET issued right after a fiscal-year switch joined the still-in-flight
 * pre-switch request and resolved with the old year's body.
 *
 * PROVES:
 *  1. Ordinary lists still coalesce: simultaneous identical GETs in one fiscal
 *     year issue ONE request and both receive its body (no request-count
 *     regression).
 *  2. A GET issued after a fiscal-year switch starts its own request, sends the
 *     new header, and only ever receives its own body — even when the two
 *     responses settle out of order.
 *  3. The pre-existing identity terms still separate requests (branch, user).
 *  4. Dedup stays in-flight only: once a request settles, the next GET refetches.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// http.ts touches window/CustomEvent only on failures; stub the two APIs it
// uses so the module can load under node:test without a DOM.
(globalThis as any).window = { dispatchEvent: () => true };
(globalThis as any).CustomEvent = class {
  type: string;
  detail: any;
  constructor(type: string, init?: { detail?: any }) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const realFetch = globalThis.fetch;
const { fetchJson, setFiscalYearContext, setUserContext } = await import(
  '../client/src/services/api/http'
);

interface CapturedCall {
  url: string;
  fiscalYear: string;
}

let calls: CapturedCall[] = [];
let respond: Array<(body: unknown) => void> = [];

/** Installs a fetch that records each request and lets the test answer it. */
function installFetch() {
  calls = [];
  respond = [];
  globalThis.fetch = ((input: any, init?: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      fiscalYear: headers['x-fiscal-year-id'] ?? '',
    });
    return new Promise((resolve) => {
      respond.push((body) =>
        resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      );
    });
  }) as any;
}

describe('GET dedup key includes the fiscal year (DF-07)', () => {
  beforeEach(() => {
    setUserContext(null);
    setFiscalYearContext(null);
    installFetch();
  });

  test('simultaneous identical GETs in the same fiscal year still coalesce', async () => {
    setFiscalYearContext('FY-1');
    const first = fetchJson<{ rows: string[] }>('/api/products');
    const second = fetchJson<{ rows: string[] }>('/api/products');

    assert.equal(calls.length, 1, 'an ordinary list request must not be duplicated');
    assert.equal(calls[0].fiscalYear, 'FY-1');

    respond[0]({ rows: ['shared'] });
    assert.deepEqual(await first, { rows: ['shared'] });
    assert.deepEqual(await second, { rows: ['shared'] });
  });

  test('a GET issued after a fiscal-year switch starts its own request', async () => {
    setFiscalYearContext('FY-1');
    const beforeSwitch = fetchJson<{ rows: string[] }>('/api/products?fy-switch');

    // The user flips the fiscal year while the first request is still in
    // flight: URL, user and branch are unchanged, so the FY is the only thing
    // that can keep the two requests apart.
    setFiscalYearContext('FY-2');
    const afterSwitch = fetchJson<{ rows: string[] }>('/api/products?fy-switch');

    assert.equal(calls.length, 2, 'the post-switch GET must not join the pre-switch request');
    assert.equal(calls[0].fiscalYear, 'FY-1', 'each request sends the FY it was created under');
    assert.equal(calls[1].fiscalYear, 'FY-2');

    // Answer out of order: each request must resolve with its own body.
    respond[1]({ rows: ['FY-2'] });
    respond[0]({ rows: ['FY-1'] });
    assert.deepEqual(await afterSwitch, { rows: ['FY-2'] });
    assert.deepEqual(await beforeSwitch, { rows: ['FY-1'] });
  });

  test('branch and user scope still separate otherwise identical GETs', async () => {
    setFiscalYearContext('FY-1');
    setUserContext({ id: 'u1', branchId: 'B1' } as any);
    const one = fetchJson('/api/products?scope');
    setUserContext({ id: 'u1', branchId: 'B2' } as any);
    const two = fetchJson('/api/products?scope');

    assert.equal(calls.length, 2);
    respond[0]({ branch: 'B1' });
    respond[1]({ branch: 'B2' });
    assert.deepEqual(await one, { branch: 'B1' });
    assert.deepEqual(await two, { branch: 'B2' });
  });

  test('the in-flight entry is released once the request settles', async () => {
    setFiscalYearContext('FY-1');
    const first = fetchJson('/api/products?settled');
    respond[0]({ rows: [1] });
    await first;

    const second = fetchJson('/api/products?settled');
    assert.equal(calls.length, 2, 'dedup is in-flight only; a settled GET is not cached');
    respond[1]({ rows: [2] });
    assert.deepEqual(await second, { rows: [2] });
  });
});

process.on('exit', () => {
  globalThis.fetch = realFetch;
});
