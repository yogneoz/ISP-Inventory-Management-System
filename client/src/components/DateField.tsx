import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  convertADToBS,
  getBsCalendarData,
  tryConvertADToBS,
} from '../utils/nepaliCalendar';
import NepaliCalendarGrid from './NepaliCalendarGrid';

export type DateMode = 'BS' | 'AD';

interface DateFieldProps {
  /**
   * Canonical value — ALWAYS an AD ISO date (YYYY-MM-DD).
   * The database stores AD dates in *_ad columns, so app state keeps the AD
   * date as the single source of truth. In BS mode the Nepali picker converts
   * the chosen BS day to its mapped AD date before calling onChange, which
   * makes BS/AD column mismatches impossible at the source.
   */
  value: string;
  /** Called with the converted AD ISO date (YYYY-MM-DD). */
  onChange: (adISODate: string) => void;
  /** Display mode: 'BS' = Nepali (Bikram Sambat) picker, 'AD' = native AD picker. */
  mode?: DateMode;
  /** Base label text; the component appends the active calendar (BS/AD) automatically. */
  label?: string;
  required?: boolean;
  /** Inclusive lower bound (AD ISO YYYY-MM-DD). */
  min?: string;
  /** Inclusive upper bound (AD ISO YYYY-MM-DD). */
  max?: string;
  disabled?: boolean;
  id?: string;
  /** Extra classes for the control (e.g. red border for cross-field validation). */
  controlClassName?: string;
  /** Tighter padding for filter toolbars. */
  compact?: boolean;}

function normalizeAD(v: string | null | undefined): string {
  if (!v) return '';
  const s = String(v).split('T')[0].trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * Dynamic date field shared across the app.
 *
 * - AD mode: native <input type="date"> (AD only) + BS equivalent hint.
 * - BS mode: a Nepali month-grid calendar popover driven by the seeded BS
 *   calendar database (bs_calendar_years / bs_day_records synced from
 *   PostgreSQL), plus the exact AD equivalent so the user can always verify
 *   which calendar the value belongs to. Values that fall outside the seeded
 *   range (legacy AD entries) fall back to the native AD input.
 *
 * The value in/out is always the AD ISO date — Nepali (BS) values are only
 * ever used for display/conversion, never stored in AD fields.
 */
export function DateField({
  value,
  onChange,
  mode = 'BS',
  label,
  required,
  min,
  max,
  disabled,
  id,
  controlClassName = '',
  compact,}: DateFieldProps) {
  const adValue = normalizeAD(value);

  // BS calendar data (localStorage mirror of the seeded bs_calendar_years DB table).
  const bsData = useMemo(() => getBsCalendarData(), []);
  const bsYears = useMemo(
    () =>
      Object.keys(bsData)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b),
    [bsData]
  );

  // Derive the BS triple from the canonical AD value (null => empty or out of seeded range).
  const derivedBS = useMemo(() => {
    if (!adValue) return null;
    try {
      const bs = convertADToBS(adValue);
      return bsData[bs.yearBS] ? bs : null;
    } catch {
      return null;
    }
  }, [adValue, bsData]);

  // Popover calendar state (BS mode).
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [viewYear, setViewYear] = useState<number | null>(null);
  const [viewMonth, setViewMonth] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // "Today" AD date for the calendar's ring marker (stable per mount).
  const todayAD = useMemo(() => new Date().toISOString().split('T')[0], []);

  // Open the Nepali calendar on the current value's month, falling back to
  // today's BS month, then to the first seeded month.
  const openPopover = () => {
    if (derivedBS) {
      setViewYear(derivedBS.yearBS);
      setViewMonth(derivedBS.monthBS);
    } else {
      const t = tryConvertADToBS(todayAD);
      if (t && bsData[t.yearBS]) {
        setViewYear(t.yearBS);
        setViewMonth(t.monthBS);
      } else {
        setViewYear(bsYears.length > 0 ? bsYears[0] : null);
        setViewMonth(1);
      }
    }
    setPopoverOpen(true);
  };

  // Close the calendar on outside click or Escape.
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setPopoverOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popoverOpen]);

  // Close the calendar if the parent clears the value.
  useEffect(() => {
    if (!adValue) setPopoverOpen(false);
  }, [adValue]);

  // BS equivalent hint (AD mode); empty when the date is outside the seeded range.
  const bsHint = useMemo(() => {
    if (!adValue) return '';
    try {
      return convertADToBS(adValue).formattedBSShort;
    } catch {
      return '';
    }
  }, [adValue]);

  const pad = compact ? 'px-2' : 'px-3 py-2';
  const baseCls = `w-full rounded-xl border text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 ${pad} ${compact ? 'h-9' : ''} bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100`;
  const showNepaliPicker = mode === 'BS' && bsYears.length > 0 && (Boolean(derivedBS) || !adValue);

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={id}
          className={`block font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1 ${
            compact ? 'text-[10px]' : 'text-[11px]'
          }`}
        >
          {label} ({mode})
          {required && ' *'}
        </label>
      )}

      {showNepaliPicker ? (
        <div ref={wrapperRef} className="relative">
          <div className="relative">
            <input
              id={id}
              readOnly
              required={required}
              disabled={disabled}
              aria-label="BS date (click to open the Nepali calendar)"
              className={`${baseCls} cursor-pointer pr-9`}
              value={derivedBS ? derivedBS.formattedBSShort : ''}
              placeholder="Select BS date"
              onClick={() => !disabled && openPopover()}
            />
            <button
              type="button"
              tabIndex={-1}
              disabled={disabled}
              aria-label="Open Nepali calendar"
              onClick={() => openPopover()}
              className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-lg p-1 text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg
                className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </button>
          </div>

          {popoverOpen && viewYear !== null && viewMonth !== null && (
            <div className={`absolute left-0 top-full z-30 mt-1 rounded-xl border p-2 shadow-xl border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900`}>
              <NepaliCalendarGrid
                yearBS={viewYear}
                monthBS={viewMonth}
                todayAD={todayAD}
                selectedAD={adValue}
                minAD={min}
                maxAD={max}
                minYearBS={bsYears[0]}
                maxYearBS={bsYears[bsYears.length - 1]}
                onPick={(adISODate) => {
                  onChange(adISODate);
                  setPopoverOpen(false);
                }}
                onMonthChange={(y, m) => {
                  setViewYear(y);
                  setViewMonth(m);
                }}
              />
            </div>
          )}
        </div>
      ) : (
        <input
          id={id}
          type="date"
          className={baseCls}
          value={adValue}
          min={min}
          max={max}
          required={required}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      )}

      {adValue && (
        <div className="mt-1 text-[10px] font-mono text-slate-500 dark:text-slate-400">
          {mode === 'BS' ? `= ${adValue} AD${bsHint ? ` | ${bsHint}` : ''}` : bsHint ? `Nepali: ${bsHint}` : ''}
        </div>
      )}
      {!showNepaliPicker && mode === 'BS' && adValue && !bsHint && (
        <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
          Outside the seeded BS calendar range — AD entry is used directly.
        </div>
      )}
    </div>
  );
}

export default DateField;

