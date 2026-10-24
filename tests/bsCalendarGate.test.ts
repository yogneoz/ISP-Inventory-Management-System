/**
 * DF-10 — the BS-date gate must check TODAY on the user's calendar, re-check
 * when the calendar changes, and never present a stale verdict.
 *
 * PROVES:
 *  1. localTodayAD reads the LOCAL day, not the UTC slice: 2026-10-23T18:30Z is
 *     already 2026-10-24 00:15 in Nepal while toISOString() still says the 23rd
 *     (the exact pre-05:45 NPT bug the gate had).
 *  2. The gate's resolution rule: a found day record opens it, a successful
 *     "not found" keeps it locked, and a FAILED read falls back to the strict
 *     compiled calendar (a server outage cannot silently open it).
 *  3. The React hook checks the local date on mount and re-checks when App
 *     broadcasts a BS calendar change — no reload needed.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import { mountTree } from './harness/mount';
import { localTodayAD } from '../client/src/utils/localDate';
import { resolveBsDateGate, useBsCalendarGate } from '../client/src/utils/bsCalendarGate';
import { broadcastBsCalendarUpdated } from '../client/src/utils/bsCalendarRefresh';

// Every test file runs in its own child process, so forcing Nepal time here
// proves the helper reads the local day without touching any other suite.
process.env.TZ = 'Asia/Kathmandu';

const NEPAL_OFFSET_MINUTES = -345;
const JUST_AFTER_LOCAL_MIDNIGHT = '2026-10-23T18:30:00.000Z'; // 2026-10-24 00:15 NPT

describe('localTodayAD (DF-10)', () => {
  test('the environment is Nepal time, so the next assertion is meaningful', () => {
    assert.equal(
      new Date(JUST_AFTER_LOCAL_MIDNIGHT).getTimezoneOffset(),
      NEPAL_OFFSET_MINUTES,
      'this suite needs TZ=Asia/Kathmandu support (set at the top of the file)'
    );
  });

  test('just after local midnight it reports today, not the UTC yesterday', () => {
    const instant = new Date(JUST_AFTER_LOCAL_MIDNIGHT);
    assert.equal(
      instant.toISOString().split('T')[0],
      '2026-10-23',
      'precondition: the UTC slice is still on the 23rd'
    );
    assert.equal(localTodayAD(instant), '2026-10-24');
  });

  test('the local-day boundary is 18:15Z (00:00 NPT)', () => {
    assert.equal(localTodayAD(new Date('2026-10-24T18:14:59.999Z')), '2026-10-24');
    assert.equal(localTodayAD(new Date('2026-10-24T18:15:00.000Z')), '2026-10-25');
  });

  test('pads single-digit months and days', () => {
    assert.equal(localTodayAD(new Date('2026-01-04T06:00:00.000Z')), '2026-01-04');
  });
});

describe('resolveBsDateGate (DF-10)', () => {
  test('a found day record opens the gate', async () => {
    const status = await resolveBsDateGate('2026-10-24', async () => ({ found: true }), () => false);
    assert.equal(status, 'available');
  });

  test('a successful read with no record keeps it locked even if the client calendar has the day', async () => {
    const status = await resolveBsDateGate('2026-10-24', async () => ({ found: false }), () => true);
    assert.equal(status, 'missing', 'the server verdict wins over the compiled fallback');
  });

  test('a failed read falls back to the strict compiled calendar', async () => {
    const failedRead = async () => {
      throw new Error('server down');
    };
    assert.equal(await resolveBsDateGate('2026-10-24', failedRead, () => true), 'available');
    assert.equal(
      await resolveBsDateGate('2026-10-24', failedRead, () => false),
      'missing',
      'a server outage must not silently open the gate'
    );
  });
});

interface GateHandles {
  status?: string;
  checkedFor?: string;
}

function GateProbe({ handles }: { handles: GateHandles }) {
  const gate = useBsCalendarGate();
  handles.status = gate.status;
  handles.checkedFor = gate.checkedFor;
  return h('div', { 'data-status': gate.status, 'data-checked-for': gate.checkedFor });
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('useBsCalendarGate (DF-10)', () => {
  const realFetch = globalThis.fetch;
  let requestedUrls: string[] = [];
  let dayFound = true;

  beforeEach(() => {
    requestedUrls = [];
    dayFound = true;
    globalThis.fetch = ((input: any) => {
      requestedUrls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ found: dayFound }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as any;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  test('checks the local date on mount and re-checks on a calendar event', async () => {
    const handles: GateHandles = {};
    const tree = mountTree(h(GateProbe, { handles }));
    await settle();

    assert.equal(handles.status, 'available');
    assert.equal(handles.checkedFor, localTodayAD());
    assert.ok(requestedUrls.length >= 1, 'the gate must read the day record');
    assert.match(
      requestedUrls[0],
      new RegExp(`adDate=${localTodayAD()}`),
      'the gate must check TODAY on the user calendar, not the UTC slice'
    );

    // Another tab/screen seeds the missing month: App broadcasts, and the gate
    // must re-read without a reload (even while this tab is hidden).
    dayFound = false;
    await act(async () => {
      broadcastBsCalendarUpdated();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();

    assert.equal(handles.status, 'missing');
    assert.equal(requestedUrls.length, 2, 'one re-check per calendar signal');

    tree.unmount();
  });
});
