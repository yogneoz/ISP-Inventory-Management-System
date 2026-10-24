/**
 * BS-date availability gate shared by the stock-operation screens (DF-10).
 *
 * Stock operations are locked until today's AD date has a seeded Nepali (BS)
 * day record. The gate used to run once per mount on the UTC date, so before
 * 05:45 NPT it checked yesterday, and it never re-checked when an admin seeded
 * the missing month from another tab.
 *
 * The gate now:
 *  - checks `localTodayAD()` (the user's calendar day, not UTC),
 *  - shows `checking` while a (re)check is in flight instead of a stale
 *    `missing` verdict,
 *  - re-runs on tab re-activation (`activationKey`) and whenever App signals a
 *    BS calendar change (`BS_CALENDAR` / `RECALC`), and
 *  - keeps the strict fallback: when the server cannot be read, the compiled
 *    client calendar decides — a server outage must not silently OPEN the gate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { hasExactBSDayRecord } from './nepaliCalendar';
import { localTodayAD } from './localDate';
import { useBsCalendarRefresh } from './bsCalendarRefresh';
import { createLatestOnly } from './latestOnly';

export type BsDateGateStatus = 'checking' | 'available' | 'missing';

/**
 * Resolves one gate check. A failed read falls back to the compiled calendar,
 * so the gate only opens on a known-good client day when the server is down.
 */
export async function resolveBsDateGate(
  todayAD: string,
  readDayRecord: (ad: string) => Promise<{ found?: boolean } | null | undefined>,
  clientHasDay: (ad: string) => boolean = hasExactBSDayRecord
): Promise<BsDateGateStatus> {
  try {
    const res = await readDayRecord(todayAD);
    return res?.found ? 'available' : 'missing';
  } catch {
    return clientHasDay(todayAD) ? 'available' : 'missing';
  }
}

export interface BsDateGate {
  status: BsDateGateStatus;
  /** The local AD date the current/last check was for. */
  checkedFor: string;
  /** Re-runs the check now (the banner's Re-check button). */
  recheck: () => void;
}

export function useBsCalendarGate(activationKey = 0): BsDateGate {
  const calendarVersion = useBsCalendarRefresh();
  const [status, setStatus] = useState<BsDateGateStatus>('checking');
  const [checkedFor, setCheckedFor] = useState<string>(localTodayAD);
  const seq = useRef(createLatestOnly()).current;

  const recheck = useCallback(async () => {
    const ticket = seq.begin();
    const todayAD = localTodayAD();
    setCheckedFor(todayAD);
    setStatus('checking');
    const next = await resolveBsDateGate(todayAD, (ad) => api.getBsDayRecordByAdDate(ad));
    if (!seq.isCurrent(ticket)) return;
    setStatus(next);
  }, [seq]);

  useEffect(() => {
    recheck();
  }, [recheck, activationKey, calendarVersion]);

  return { status, checkedFor, recheck };
}
