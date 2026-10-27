/**
 * EXCH-1 — the exchange picker's read schedule.
 *
 * A branch switch (and the first mount) must read at once: it is a deliberate
 * scope change, and DF-16 fetched on it. Only a typed TERM waits for the
 * debounce, so typing ten characters issues one request and the previous page
 * stays on screen meanwhile.
 *
 * Mounts the real hook over the real singleton with `fetch` stubbed, so the
 * assertions are about requests actually issued, not about source text. The
 * stub stays unresolved until the test releases it, so every state update
 * happens inside act().
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, useState } from 'react';
import { mountTree } from './harness/mount';
import {
  EXCHANGE_DEBOUNCE_MS,
  resetExchangeDevices,
  useExchangeDevices,
} from '../client/src/services/exchangeDeviceCache';

interface Handles {
  setBranch: (branch: string) => void;
  setTerm: (term: string) => void;
}

/** URLs of every request the hook issued, in order. */
const calls: string[] = [];
/** One resolver per in-flight fetch, released inside act(). */
let pending: Array<() => void> = [];
const originalFetch = globalThis.fetch;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const Root = ({ handles }: { handles: Handles }) => {
  const [branch, setBranch] = useState('WH001');
  const [term, setTerm] = useState('');
  handles.setBranch = setBranch;
  handles.setTerm = setTerm;
  const state = useExchangeDevices(branch, term);
  return h('div', null, `rows:${state.rows.length} loading:${String(state.loading)}`);
};

describe('EXCH-1 — the exchange picker read schedule', () => {
  before(() => {
    resetExchangeDevices();
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      await new Promise<void>((resolve) => pending.push(resolve));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'd1', deviceSerial: 'SN-1', status: 'RENTAL' }],
          page: 1,
          pageSize: 50,
          totalItems: 1,
        }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    resetExchangeDevices();
  });

  test('the mount and a branch switch read at once; a typed term is debounced once', async () => {
    calls.length = 0;
    pending = [];
    const handles = {} as Handles;
    const tree = mountTree(h(Root, { handles }));

    // Mount reads at once (no debounce for the first scope).
    assert.equal(calls.length, 1, 'the first mount must read immediately');
    assert.match(calls[0], /branchId=WH001/);
    assert.ok(!calls[0].includes('query='), 'no term is sent at mount');
    await act(async () => {
      pending.splice(0).forEach((resolve) => resolve());
      await sleep(0);
    });

    // A branch switch is a scope change, not typing: it reads at once.
    act(() => handles.setBranch('BRH02'));
    assert.equal(calls.length, 2, 'a branch switch must not wait for the debounce');
    assert.match(calls[1], /branchId=BRH02/);
    await act(async () => {
      pending.splice(0).forEach((resolve) => resolve());
      await sleep(0);
    });

    // Typing does NOT issue a request per keystroke.
    act(() => handles.setTerm('o'));
    act(() => handles.setTerm('on'));
    act(() => handles.setTerm('onu'));
    assert.equal(calls.length, 2, 'keystrokes must be coalesced before they reach the server');

    // One request for the final term, after the pause.
    await act(async () => {
      await sleep(EXCHANGE_DEBOUNCE_MS + 120);
      pending.splice(0).forEach((resolve) => resolve());
      await sleep(0);
    });
    assert.equal(calls.length, 3, 'exactly one request after the pause');
    assert.match(calls[2], /branchId=BRH02/, 'the branch scope survives typing');
    assert.match(calls[2], /query=onu/, 'only the final term is searched');
    assert.match(calls[2], /status=RENTAL%2CACTIVE/, 'the eligibility filter is a server filter');

    tree.unmount();
  });
});
