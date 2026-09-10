import React from 'react';
import { NEPALI_MONTHS_EN, getBSMonthGrid } from '../utils/nepaliCalendar';

interface NepaliCalendarGridProps {
  yearBS: number;
  monthBS: number;
  /** AD ISO date (YYYY-MM-DD) to ring as "today". */
  todayAD: string;
  /** AD ISO date currently selected. */
  selectedAD?: string;
  /** Inclusive lower bound (AD ISO). */
  minAD?: string;
  /** Inclusive upper bound (AD ISO). */
  maxAD?: string;
  minYearBS: number;
  maxYearBS: number;
  onPick: (adISODate: string) => void;
  onMonthChange: (yearBS: number, monthBS: number) => void;}

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * Presentational Bikram Sambat (BS) month grid built from the seeded
 * bs_calendar_years / bs_day_records data (the app's single calendar source
 * of truth — no third-party date data).
 *
 * Each in-month cell maps to the canonical AD ISO date. Cells are disabled
 * when the date has no exact bs_day_records mapping (the same gate the
 * server enforces) or falls outside the supplied min/max AD bounds.
 * Picking a day calls onPick with the canonical AD date, preserving the
 * value in/out contract (always AD ISO).
 */
export function NepaliCalendarGrid({
  yearBS,
  monthBS,
  todayAD,
  selectedAD = '',
  minAD,
  maxAD,
  minYearBS,
  maxYearBS,
  onPick,
  onMonthChange,}: NepaliCalendarGridProps) {
  const cells = getBSMonthGrid(yearBS, monthBS, { todayAD, selectedAD, minAD, maxAD });
  const monthName = NEPALI_MONTHS_EN[monthBS - 1] || 'Baisakh';
  const canPrev = yearBS > minYearBS || monthBS > 1;
  const canNext = yearBS < maxYearBS || monthBS < 12;

  const navCls = `flex h-6 w-6 items-center justify-center rounded-md border text-xs disabled:cursor-not-allowed disabled:opacity-40 border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800`;

  if (!cells) {
    return (
      <div className={`p-4 text-xs text-slate-500 dark:text-slate-400`}>
        No BS calendar seeded for {monthName} {yearBS}.
      </div>
    );
  }

  return (
    <div className="w-[268px] select-none">
      <div className="mb-1.5 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!canPrev}
          onClick={() => (monthBS > 1 ? onMonthChange(yearBS, monthBS - 1) : onMonthChange(yearBS - 1, 12))}
          className={navCls}
        >
          ‹
        </button>
        <div className={`text-xs font-bold text-slate-700 dark:text-slate-200`}>
          {monthName} {yearBS} BS
        </div>
        <button
          type="button"
          aria-label="Next month"
          disabled={!canNext}
          onClick={() => (monthBS < 12 ? onMonthChange(yearBS, monthBS + 1) : onMonthChange(yearBS + 1, 1))}
          className={navCls}
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAY_LETTERS.map((w, i) => (
          <div
            key={`${w}-${i}`}
            className={`flex h-5 items-center justify-center text-[9px] font-bold uppercase text-slate-400 dark:text-slate-500`}
          >
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell, i) => {
          if (cell.day === null) return <div key={`pad-${i}`} className="h-7" />;
          const disabled = !cell.isSeeded || cell.outOfRange;
          const cellCls = `h-7 rounded-md text-xs transition-colors ${
            cell.isSelected
              ? 'bg-indigo-600 font-bold text-white'
              : disabled
                ? `cursor-not-allowed text-slate-300 dark:text-slate-600`
                : `text-slate-700 hover:bg-indigo-50 dark:text-slate-200 dark:hover:bg-indigo-900/40`
          } ${cell.isToday && !cell.isSelected ? 'font-semibold ring-1 ring-inset ring-indigo-500' : ''}`;
          return (
            <button
              key={cell.day}
              type="button"
              disabled={disabled}
              onClick={() => cell.adDate && onPick(cell.adDate)}
              aria-label={`${monthName} ${cell.day} ${yearBS}${cell.adDate ? ` (${cell.adDate} AD)` : ''}`}
              title={
                cell.adDate
                  ? cell.outOfRange
                    ? `${cell.adDate} AD — outside allowed range`
                    : cell.isSeeded
                      ? `${cell.adDate} AD`
                      : 'No exact BS calendar mapping'
                  : 'No exact BS calendar mapping'
              }
              className={cellCls}
            >
              {cell.day}
            </button>
          );
        })}
      </div>

      <div className={`mt-1.5 border-t pt-1.5 text-[9px] leading-snug border-slate-100 text-slate-400 dark:border-slate-800 dark:text-slate-500`}>
        Faded days are outside the mapped BS calendar or the allowed range.
      </div>
    </div>
  );
}

export default NepaliCalendarGrid;