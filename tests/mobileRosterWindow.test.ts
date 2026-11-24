/**
 * The mobile bootstrap's roster window is a CALENDAR window.
 *
 * `buildBootstrap` asks for shifts from the business date to 14 days later. It
 * used to compute the end as `new Date(Date.now() + 14 * 86_400_000)`, which is
 * the same day most of the time and the wrong one for 5 h 45 min every local
 * day: the instant 14 days from now is truncated in UTC, while the office's
 * calendar is already on the next day. The clock is frozen at an instant where
 * the two disagree (18:30Z on the 22nd is 00:15 on the 23rd in Kathmandu), so
 * this test fails on the old arithmetic rather than passing by luck.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBootstrap } from '../server/src/services/mobile.service';
import { pgPool } from '../server/src/app';

const USER = { id: 'roster-window-user', role: 'FRONT_DESK', branchId: 'b-window' } as any;
const EMPLOYEE = { id: 'roster-window-emp', branch_id: 'b-window', branch_code: 'WH001' } as any;
const DISAGREEING_INSTANT = Date.parse('2026-11-22T18:30:00.000Z');

describe('mobile bootstrap roster window', () => {
  test('ends 14 calendar days after the business date, not 14 days after "now"', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: DISAGREEING_INSTANT });

    const calls: Array<{ text: string; params: any[] }> = [];
    const originalQuery = pgPool.query;
    // Every read the home screen issues resolves to no rows; the roster call is
    // identified by its three binds (employee, window start, window end).
    (pgPool as any).query = async (text: any, params?: any[]) => {
      calls.push({ text: String(text), params: params || [] });
      return { rows: [], rowCount: 0 };
    };

    let payload: any;
    try {
      payload = await buildBootstrap(USER, EMPLOYEE);
    } finally {
      (pgPool as any).query = originalQuery;
      t.mock.timers.reset();
    }

    assert.equal(payload.shiftWindow, 'NO_SHIFT', 'the empty roster keeps the home screen valid');

    const roster = calls.find((call) => call.params.length === 3 && call.params[0] === EMPLOYEE.id);
    assert.ok(roster, 'the roster query must run with an employee and both window bounds');
    assert.equal(roster!.params[1], '2026-11-23', 'the window starts on the Kathmandu business date');
    assert.equal(roster!.params[2], '2026-12-07', 'and ends 14 calendar days later');

    // What the old implementation produced: the instant 14 × 86 400 000 ms after
    // "now", read back as a UTC date. It is a day short here, which is exactly
    // the bug the calendar arithmetic removes.
    const instantArithmetic = new Date(DISAGREEING_INSTANT + 14 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(instantArithmetic, '2026-12-06');
    assert.notEqual(roster!.params[2], instantArithmetic);
  });
});
