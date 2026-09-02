import React, { useState, useEffect } from 'react';
import { FiscalYear } from '../../types';
import { api } from '../../services/api';
import {
  convertADToBS,
  convertBSToAD,
  getNepaliFiscalYear,
  getBsCalendarData,
  parseAndSeedBSInput,
  seedBSYearCalendar,
  BSYearData,
  BSDayRecord,
  NEPALI_MONTHS_EN,
  NEPALI_MONTHS_NP,
  DAYS_OF_WEEK_EN,
  DAYS_OF_WEEK_NP,
  formatNepaliFiscalYearCode,
  getNepaliQuarter,
  generateCalendarDatabase,
  getCalendarBounds,
  isDateInBounds,
  lookupBSDayRecord,
} from '../../utils/nepaliCalendar';
import {
  CalendarDays,
  CheckCircle2,
  Lock,
  Calendar as CalendarIcon,
  Sparkles,
  Zap,
  PlusCircle,
  Database,
  Check,
  AlertCircle,
  RotateCcw,
  Code,
  Info,
  Layers,
  ShieldCheck,
  ShieldAlert,
  X,
  Search,
  Edit3,
  Sliders,
  Save,
} from 'lucide-react';

interface NepaliFiscalManagementProps {
  fiscalYears: FiscalYear[];
  onSetCurrentFiscalYear: (id: string) => Promise<void>;
  dateMode: 'BS' | 'AD';
  isDarkMode?: boolean;
}

export const NepaliFiscalManagement: React.FC<NepaliFiscalManagementProps> = ({
  fiscalYears,
  onSetCurrentFiscalYear,
  isDarkMode = false,
}) => {
  const [calendarData, setCalendarData] = useState<Record<number, BSYearData>>({});
  const [dayDatabase, setDayDatabase] = useState<BSDayRecord[]>([]);
  const [seedInput, setSeedInput] = useState<string>(
    '2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]'
  );
  const [seedOnlyIfNew, setSeedOnlyIfNew] = useState<boolean>(true);
  const [seedStatus, setSeedStatus] = useState<{
    type: 'success' | 'error' | null;
    message: string;
  }>({ type: null, message: '' });

  const [testDateAD, setTestDateAD] = useState<string>(
    new Date().toISOString().split('T')[0]
  );

  // Targeted Date Range Conversion Tool State
  const [rangeStartDateAD, setRangeStartDateAD] = useState<string>('2025-04-14');
  const [rangeEndDateAD, setRangeEndDateAD] = useState<string>('2026-04-13');
  const [rangeConversionStatus, setRangeConversionStatus] = useState<{
    type: 'idle' | 'converting' | 'success' | 'missing_year' | 'error';
    message: string;
    records: BSDayRecord[];
    missingYears: number[];
  }>({
    type: 'idle',
    message: '',
    records: [],
    missingYears: [],
  });
  const [isSyncingSql, setIsSyncingSql] = useState<boolean>(false);
  const [sqlSyncSuccess, setSqlSyncSuccess] = useState<{ success: boolean; message: string } | null>(null);
  const [rangeSearchQuery, setRangeSearchQuery] = useState<string>('');

  // Existing BS Year Editing & Filtering State
  const [managerFilterMode, setManagerFilterMode] = useState<'recent' | 'all' | 'specific'>('recent');
  const [selectedSpecificYear, setSelectedSpecificYear] = useState<number | null>(null);
  const [yearSearchTerm, setYearSearchTerm] = useState<string>('');

  const [editingYearData, setEditingYearData] = useState<BSYearData | null>(null);
  const [editStartAD, setEditStartAD] = useState<string>('');
  const [editDaysInMonths, setEditDaysInMonths] = useState<number[]>([]);
  const [isSavingYearEdit, setIsSavingYearEdit] = useState<boolean>(false);
  const [editError, setEditError] = useState<string>('');

  const openEditYearModal = (yearData: BSYearData) => {
    setEditingYearData(yearData);
    setEditStartAD(yearData.startAD);
    setEditDaysInMonths([...yearData.daysInMonths]);
    setEditError('');
  };

  const handleMonthDaysChange = (index: number, val: number) => {
    const updated = [...editDaysInMonths];
    updated[index] = val;
    setEditDaysInMonths(updated);
  };

  const handleSaveYearEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingYearData) return;

    if (editDaysInMonths.length !== 12) {
      setEditError('Month array must contain exactly 12 month values.');
      return;
    }

    if (editDaysInMonths.some((d) => isNaN(d) || d < 28 || d > 32)) {
      setEditError('Each month day count must be a valid number between 28 and 32.');
      return;
    }

    if (!editStartAD) {
      setEditError('Please select a valid AD Start Date for Baisakh 1.');
      return;
    }

    setIsSavingYearEdit(true);
    setEditError('');

    try {
      // 1. Local storage & memory update
      seedBSYearCalendar(editingYearData.yearBS, editDaysInMonths, editStartAD);

      // 2. PostgreSQL DB update
      await api.seedBsCalendarYear(editingYearData.yearBS, editDaysInMonths, editStartAD);

      setSeedStatus({
        type: 'success',
        message: `Successfully updated 12-month array and Start AD date for BS Year ${editingYearData.yearBS} in PostgreSQL database!`,
      });

      setEditingYearData(null);
      await refreshCalendarData();
    } catch (err: any) {
      setEditError(`Error saving BS year changes: ${err.message}`);
    } finally {
      setIsSavingYearEdit(false);
    }
  };

  // Load calendar data and generate full database on mount
  useEffect(() => {
    refreshCalendarData();
  }, []);

  const refreshCalendarData = async () => {
    try {
      const dbYears = await api.getBsCalendarYears();
      if (dbYears && dbYears.length > 0) {
        const yearMap: Record<number, BSYearData> = {};
        dbYears.forEach((y) => {
          yearMap[y.yearBS] = {
            yearBS: y.yearBS,
            daysInMonths: y.daysInMonths,
            startAD: y.startAD,
          };
          seedBSYearCalendar(y.yearBS, y.daysInMonths, y.startAD);
        });
        setCalendarData(yearMap);
      } else {
        setCalendarData(getBsCalendarData());
      }

      const dbDays = await api.getBsDayRecords();
      if (dbDays && dbDays.length > 0) {
        setDayDatabase(dbDays);
      } else {
        setDayDatabase(generateCalendarDatabase());
      }
    } catch (e) {
      setCalendarData(getBsCalendarData());
      setDayDatabase(generateCalendarDatabase());
    }
  };

  const handleSeedSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!seedInput.trim()) return;

    const match = seedInput.match(/(\d{4})\s*:\s*\[([\d\s,]+)\]/);
    if (match) {
      const yearBS = parseInt(match[1], 10);
      if (seedOnlyIfNew && calendarData[yearBS]) {
        setSeedStatus({
          type: 'success',
          message: `BS Year ${yearBS} already exists in calendar database. Skipped seeding because 'Seed only if new' is enabled. (Use 'Edit Array' below to modify existing years).`,
        });
        return;
      }
    }

    const res = parseAndSeedBSInput(seedInput);
    if (res.success) {
      let seedPgSynced = true;
      if (match) {
        const yearBS = parseInt(match[1], 10);
        const days = match[2].split(',').map((s) => parseInt(s.trim(), 10));
        if (days.length === 12) {
          try {
            const seedRes = await api.seedBsCalendarYear(yearBS, days, undefined, seedOnlyIfNew);
            if (seedRes && seedRes.pgSynced === false) seedPgSynced = false;
          } catch (err: any) {
            console.warn('PostgreSQL Seed Warning:', err.message);
            seedPgSynced = false;
          }
        }
      }
      setSeedStatus({
        type: 'success',
        message: seedPgSynced
          ? `${res.message} (Synced 365 daily records to PostgreSQL bs_day_records table)`
          : `${res.message} (In-memory only — PostgreSQL unreachable; re-sync when the database is back)`,
      });
      await refreshCalendarData();
    } else {
      setSeedStatus({ type: 'error', message: res.message });
    }
  };

  const handleQuickSeed = async (yearBS: number, monthDays: number[]) => {
    if (seedOnlyIfNew && calendarData[yearBS]) {
      setSeedStatus({
        type: 'success',
        message: `BS Year ${yearBS} already exists in calendar database! Skipped duplicate seed. (Use 'Edit Array' in the table below to modify existing year data).`,
      });
      return;
    }

    try {
      seedBSYearCalendar(yearBS, monthDays);
      let seedPgSynced = true;
      try {
        const seedRes = await api.seedBsCalendarYear(yearBS, monthDays, undefined, seedOnlyIfNew);
        if (seedRes && seedRes.pgSynced === false) seedPgSynced = false;
      } catch (e: any) {
        console.warn('PostgreSQL quick seed notice:', e.message);
        seedPgSynced = false;
      }
      setSeedStatus({
        type: 'success',
        message: seedPgSynced
          ? `Successfully seeded new BS Year ${yearBS} and generated 365 daily records in PostgreSQL bs_day_records table!`
          : `Seeded new BS Year ${yearBS} in the in-memory calendar only — PostgreSQL was unreachable, so bs_day_records was not updated.`,
      });
      await refreshCalendarData();
    } catch (err: any) {
      setSeedStatus({ type: 'error', message: err.message });
    }
  };

  const handleConvertRange = () => {
    setSqlSyncSuccess(null);
    if (!rangeStartDateAD || !rangeEndDateAD) {
      setRangeConversionStatus({
        type: 'error',
        message: 'Please specify both Start Date (AD) and End Date (AD) for conversion.',
        records: [],
        missingYears: [],
      });
      return;
    }

    const start = new Date(rangeStartDateAD);
    const end = new Date(rangeEndDateAD);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      setRangeConversionStatus({
        type: 'error',
        message: 'Invalid date values provided. Please enter valid AD dates.',
        records: [],
        missingYears: [],
      });
      return;
    }

    if (start > end) {
      setRangeConversionStatus({
        type: 'error',
        message: 'Start Date (AD) must be prior to or equal to End Date (AD).',
        records: [],
        missingYears: [],
      });
      return;
    }

    const records: BSDayRecord[] = [];
    const missingYearsSet = new Set<number>();
    const current = new Date(start);

    while (current <= end) {
      const adDateStr = current.toISOString().split('T')[0];
      try {
        const converted = convertADToBS(adDateStr);

        if (!calendarData[converted.yearBS]) {
          missingYearsSet.add(converted.yearBS);
        } else {
          const dayOfWeekIndex = current.getUTCDay();
          const padMonth = converted.monthBS < 10 ? `0${converted.monthBS}` : `${converted.monthBS}`;
          const padDay = converted.dayBS < 10 ? `0${converted.dayBS}` : `${converted.dayBS}`;
          const bsDateStr = `${converted.yearBS}-${padMonth}-${padDay}`;

          const fyCode = formatNepaliFiscalYearCode(converted.yearBS, converted.monthBS);
          const qtr = getNepaliQuarter(converted.monthBS);

          records.push({
            adDate: adDateStr,
            bsDate: bsDateStr,
            bsYear: converted.yearBS,
            bsMonth: converted.monthBS,
            bsMonthName: converted.monthName,
            bsMonthNameNp: NEPALI_MONTHS_NP[converted.monthBS - 1] || 'वैशाख',
            bsDay: converted.dayBS,
            dayOfWeekName: DAYS_OF_WEEK_EN[dayOfWeekIndex],
            dayOfWeekNameNp: DAYS_OF_WEEK_NP[dayOfWeekIndex],
            fiscalYear: fyCode,
            quarter: qtr,
            isWeekend: dayOfWeekIndex === 6,
          });
        }
      } catch (err: any) {
        // Year is missing from bs_calendar_years dataset
        const estBSYear = current.getUTCFullYear() + 57;
        missingYearsSet.add(estBSYear);
      }

      current.setDate(current.getDate() + 1);
    }

    if (missingYearsSet.size > 0) {
      const missingArr = Array.from(missingYearsSet).sort((a, b) => a - b);
      setRangeConversionStatus({
        type: 'missing_year',
        message: `Conversion halted: Missing BS Calendar month array data for BS Year(s): ${missingArr.join(', ')}. Please seed data array for these year(s) to complete conversion.`,
        records: [],
        missingYears: missingArr,
      });
      return;
    }

    setRangeConversionStatus({
      type: 'success',
      message: `Conversion completed successfully! Generated ${records.length} total daily conversion records from ${rangeStartDateAD} to ${rangeEndDateAD}.`,
      records,
      missingYears: [],
    });
  };

  const handleWriteToSql = async () => {
    if (rangeConversionStatus.records.length === 0) return;
    setIsSyncingSql(true);
    setSqlSyncSuccess(null);
    try {
      const res = await api.syncBsDayRange(rangeConversionStatus.records);
      if (res.success) {
        setSqlSyncSuccess({
          success: true,
          message: res.message,
        });
        await refreshCalendarData();
      } else {
        setSqlSyncSuccess({
          success: false,
          message: res.message,
        });
      }
    } catch (err: any) {
      setSqlSyncSuccess({
        success: false,
        message: `Error writing data to PostgreSQL database: ${err.message}`,
      });
    } finally {
      setIsSyncingSql(false);
    }
  };

  const handleCancelConversion = () => {
    setRangeConversionStatus({
      type: 'idle',
      message: '',
      records: [],
      missingYears: [],
    });
    setSqlSyncSuccess(null);
  };

  const handleResetDefaults = () => {
    if (confirm('Reset bsCalendarData to default initial reference tables?')) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('izone_bs_calendar_data');
      }
      refreshCalendarData();
      setSeedStatus({
        type: 'success',
        message: 'Reset bsCalendarData back to default reference values.',
      });
    }
  };

  const bounds = getCalendarBounds();
  const boundsCheck = isDateInBounds(testDateAD);
  const lookedUpDayRecord = lookupBSDayRecord(testDateAD);

  const sortedYears = (Object.values(calendarData) as BSYearData[]).sort((a, b) => a.yearBS - b.yearBS);

  return (
    <div className="space-y-3">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <CalendarDays className="h-5 w-5 text-indigo-500" />
            <span>Nepali Bikram Sambat Calendar & Fiscal Year Management</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Full Day-by-Day PostgreSQL/Lookup Database Engine & Fiscal Year Configuration (<code className={isDarkMode ? 'text-indigo-300 font-mono font-bold' : 'text-indigo-600 font-mono font-bold'}>YYYY-YY</code> format).
          </p>
        </div>

        <button
          onClick={handleResetDefaults}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer w-fit ${
            isDarkMode
              ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
              : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200 shadow-2xs'
          }`}
        >
          <RotateCcw className="h-3.5 w-3.5 text-slate-400" />
          <span>Reset Calendar Defaults</span>
        </button>
      </div>

      {/* Database Bounds Limiter Banner */}
      <div className={`rounded-2xl border p-3 shadow-lg flex flex-col sm:flex-row sm:items-center justify-start gap-3 ${
        isDarkMode
          ? 'bg-gradient-to-r from-indigo-950/80 via-slate-900 to-slate-900 border-indigo-800/60'
          : 'bg-indigo-50/70 border-indigo-200/80'
      }`}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl border ${
            isDarkMode ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-indigo-100 text-indigo-700 border-indigo-200'
          }`}>
            <Database className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                Nepali Calendar Database Bounds:
              </span>
              <span className={`text-[11px] font-mono px-2 py-0.5 rounded-full border font-bold ${
                isDarkMode ? 'bg-emerald-950 text-emerald-400 border-emerald-500/30' : 'bg-emerald-100 text-emerald-800 border-emerald-200'
              }`}>
                {(bounds.totalDaysMapped ?? 0).toLocaleString()} Days Pre-Mapped
              </span>
            </div>
            <p className={`text-xs font-mono mt-0.5 ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
              AD Range: <span className="text-amber-600 dark:text-amber-300 font-bold">{bounds.minAD}</span> to <span className="text-amber-600 dark:text-amber-300 font-bold">{bounds.maxAD}</span> | BS Range: <span className="text-indigo-600 dark:text-indigo-300 font-bold">{bounds.minBS}</span> to <span className="text-indigo-600 dark:text-indigo-300 font-bold">{bounds.maxBS}</span>
            </p>
          </div>
        </div>

        <div className={`flex items-center gap-2 font-mono text-xs px-3 py-2 rounded-xl border ${
          isDarkMode
            ? 'text-slate-400 bg-slate-950/60 border-slate-800'
            : 'text-slate-700 bg-white border-slate-200 shadow-2xs'
        }`}>
          <Layers className="h-4 w-4 text-indigo-500" />
          <span>{bounds.mappedYearsCount} Mapped BS Years ({bounds.mappedYears.join(', ')})</span>
        </div>
      </div>

      {/* Fiscal Year Lock Cards Grid */}
      <div>
        <h3 className={`text-sm font-bold mb-3 flex items-center gap-2 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
          <Lock className="h-4 w-4 text-amber-500" />
          <span>Nepali Fiscal Year Accounting Periods (<code className={isDarkMode ? 'text-amber-300 font-mono' : 'text-amber-700 font-mono'}>YYYY-YY</code> Legitimate Standard)</span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {fiscalYears.map((fy) => (
            <div
              key={fy.id}
              className={`rounded-2xl p-4 border transition-all ${
                fy.isCurrent
                  ? isDarkMode
                    ? 'bg-gradient-to-br from-indigo-950 via-[#0f1218] to-slate-900 text-white border-indigo-500/60 shadow-xl'
                    : 'bg-indigo-50/90 border-indigo-300 text-slate-900 shadow-sm'
                  : isDarkMode
                    ? 'bg-[#0f1218] border-slate-800 text-slate-300 hover:border-slate-700'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300 shadow-2xs'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-xs font-bold font-mono px-2.5 py-0.5 rounded-full border ${
                    fy.isCurrent
                      ? isDarkMode
                        ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/30'
                        : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                      : isDarkMode
                        ? 'bg-slate-900 text-slate-400 border-slate-800'
                        : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  FY {fy.code}
                </span>

                {fy.isCurrent ? (
                  <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-bold">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Active
                  </span>
                ) : (
                  <button
                    onClick={() => onSetCurrentFiscalYear(fy.id)}
                    className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    Set Active
                  </button>
                )}
              </div>

              <div className="space-y-1.5 text-[11px]">
                <div className={`flex justify-between border-b pb-1 ${isDarkMode ? 'border-slate-800/80' : 'border-slate-200'}`}>
                  <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>BS Period:</span>
                  <span className={`font-mono font-semibold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                    {fy.startDateBS} to {fy.endDateBS}
                  </span>
                </div>
                <div className={`flex justify-between border-b pb-1 ${isDarkMode ? 'border-slate-800/80' : 'border-slate-200'}`}>
                  <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>AD Period:</span>
                  <span className={`font-mono font-medium ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                    {fy.startDateAD} to {fy.endDateAD}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>Status:</span>
                  <span className="font-bold flex items-center gap-1">
                    {fy.isClosed ? (
                      <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <Lock className="h-3 w-3" /> Closed
                      </span>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">Open</span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* FEATURE 1: Month Array Seeder & Database Regenerator */}
      <div className={`rounded-2xl border p-6 shadow-xl space-y-4 ${
        isDarkMode ? 'bg-[#0f1218] border-indigo-900/50' : 'bg-white border-slate-200 shadow-2xs'
      }`}>
        <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b pb-3 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl border ${
              isDarkMode ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' : 'bg-indigo-50 text-indigo-600 border-indigo-200'
            }`}>
              <Database className="h-5 w-5" />
            </div>
            <div>
              <h3 className={`font-bold text-base ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                Seed BS Month Array & Expand Day-by-Day Database Table
              </h3>
              <p className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                Input 12-month array (e.g. <code className={isDarkMode ? 'text-amber-300 font-mono' : 'text-amber-700 font-mono'}>2082: [31, 31, 32, ...]</code>) to automatically build full day records.
              </p>
            </div>
          </div>

          <span className={`text-[11px] font-mono px-2.5 py-1 rounded-lg border font-bold ${
            isDarkMode ? 'bg-indigo-950 text-indigo-300 border-indigo-800' : 'bg-indigo-50 text-indigo-700 border-indigo-200'
          }`}>
            {bounds.mappedYearsCount} Years ({bounds.totalDaysMapped} Daily Records)
          </span>
        </div>

        {/* Input Form */}
        <form onSubmit={handleSeedSubmit} className="space-y-3">
          <div>
            <label className={`block text-xs font-semibold mb-1 flex items-center justify-between ${
              isDarkMode ? 'text-slate-300' : 'text-slate-700'
            }`}>
              <span>Enter BS Year & 12 Month Days Array:</span>
              <span className={`text-[11px] ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                Format: <code className={isDarkMode ? 'text-amber-300 font-mono' : 'text-amber-700 font-mono'}>YYYY: [31, 31, 32, ...]</code>
              </span>
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder="2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]"
                className={`flex-1 rounded-xl border p-3 text-xs font-mono focus:border-indigo-500 outline-none ${
                  isDarkMode
                    ? 'bg-slate-900 border-slate-700 text-amber-300 placeholder-slate-500'
                    : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400'
                }`}
              />
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <label className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-semibold cursor-pointer select-none ${
                  isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}>
                  <input
                    type="checkbox"
                    checked={seedOnlyIfNew}
                    onChange={(e) => setSeedOnlyIfNew(e.target.checked)}
                    className="rounded text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                  />
                  <span>Seed only if new (Skip existing)</span>
                </label>

                <button
                  type="submit"
                  className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-md transition-all cursor-pointer whitespace-nowrap"
                >
                  <PlusCircle className="h-4 w-4" />
                  <span>Seed & Regenerate Day Table</span>
                </button>
              </div>
            </div>
          </div>

          {/* Quick Preset Buttons */}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className={`text-[11px] font-bold flex items-center gap-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <Zap className="h-3 w-3 text-amber-500" />
              <span>Quick Seed Presets:</span>
            </span>

            {[2082, 2083, 2084, 2085].map((y) => (
              <button
                key={y}
                type="button"
                onClick={() =>
                  handleQuickSeed(
                    y,
                    y === 2084
                      ? [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30]
                      : y === 2085
                      ? [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31]
                      : [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]
                  )
                }
                className={`px-2.5 py-1 rounded-lg text-xs font-mono font-semibold border transition-all cursor-pointer ${
                  isDarkMode
                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
                }`}
              >
                + Seed {y} BS
              </button>
            ))}
          </div>
        </form>

        {/* Feedback Alert */}
        {seedStatus.message && (
          <div
            className={`p-3 rounded-xl border text-xs font-medium flex items-center gap-2 ${
              seedStatus.type === 'success'
                ? isDarkMode
                  ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : isDarkMode
                  ? 'bg-rose-950/60 border-rose-500/40 text-rose-300'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            {seedStatus.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 text-rose-500 flex-shrink-0" />
            )}
            <span>{seedStatus.message}</span>
          </div>
        )}
      </div>

      {/* FEATURE 1.5: Existing BS Calendar Years & Month Days Array Manager */}
      {(() => {
        const sortedYears = Object.keys(calendarData)
          .map((y) => parseInt(y, 10))
          .sort((a, b) => a - b)
          .map((y) => calendarData[y]);

        const recentYearObj = sortedYears.length > 0 ? sortedYears[sortedYears.length - 1] : null;

        const displayedManagerYears = sortedYears.filter((y) => {
          if (yearSearchTerm.trim()) {
            return y.yearBS.toString().includes(yearSearchTerm.trim());
          }
          if (managerFilterMode === 'recent') {
            return recentYearObj ? y.yearBS === recentYearObj.yearBS : true;
          }
          if (managerFilterMode === 'specific' && selectedSpecificYear) {
            return y.yearBS === selectedSpecificYear;
          }
          return true; // 'all'
        });

        return (
          <div className={`rounded-2xl border p-5 shadow-xl space-y-4 ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
          }`}>
            <div className={`flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b pb-3 ${
              isDarkMode ? 'border-slate-800' : 'border-slate-200'
            }`}>
              <div className="flex items-center gap-2.5">
                <div className={`p-2 rounded-xl border ${
                  isDarkMode ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-amber-50 text-amber-600 border-amber-200'
                }`}>
                  <Sliders className="h-5 w-5" />
                </div>
                <div>
                  <h3 className={`font-bold text-base ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                    Existing BS Calendar Years & Month Days Array Manager
                  </h3>
                  <p className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    Filter and update 12-month day count arrays (<code className={isDarkMode ? 'text-amber-300 font-mono' : 'text-amber-700 font-mono'}>[Baisakh..Chaitra]</code>) and Baisakh 1 AD start dates in PostgreSQL database.
                  </p>
                </div>
              </div>

              {/* FILTER CONTROLS */}
              <div className="flex flex-wrap items-center gap-2">
                <div className={`flex items-center p-1 rounded-xl border ${
                  isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-200'
                }`}>
                  <button
                    type="button"
                    onClick={() => {
                      setManagerFilterMode('recent');
                      setYearSearchTerm('');
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      managerFilterMode === 'recent'
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Recent Year ({recentYearObj?.yearBS || '2082'} BS)
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setManagerFilterMode('all');
                      setYearSearchTerm('');
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      managerFilterMode === 'all'
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All Years ({sortedYears.length})
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setManagerFilterMode('specific');
                      if (!selectedSpecificYear && recentYearObj) {
                        setSelectedSpecificYear(recentYearObj.yearBS);
                      }
                      setYearSearchTerm('');
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      managerFilterMode === 'specific'
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Specific Year
                  </button>
                </div>

                {/* Specific Year Selector Dropdown */}
                {managerFilterMode === 'specific' && (
                  <select
                    value={selectedSpecificYear || (recentYearObj?.yearBS ?? 2082)}
                    onChange={(e) => setSelectedSpecificYear(parseInt(e.target.value, 10))}
                    className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-bold outline-none cursor-pointer ${
                      isDarkMode ? 'bg-slate-900 border-slate-700 text-amber-400' : 'bg-white border-slate-300 text-slate-900'
                    }`}
                  >
                    {sortedYears.map((y) => (
                      <option key={y.yearBS} value={y.yearBS}>
                        BS Year {y.yearBS} ({y.daysInMonths.reduce((a, b) => a + b, 0)} days)
                      </option>
                    ))}
                  </select>
                )}

                {/* Quick Search */}
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
                  <Search className={`absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 ${
                    isDarkMode ? 'text-slate-500' : 'text-slate-400'
                  }`} />
                  <input
                    type="text"
                    placeholder="Search BS year..."
                    value={yearSearchTerm}
                    onChange={(e) => setYearSearchTerm(e.target.value)}
                    className={`pl-8 pr-3 py-1.5 rounded-xl border text-xs font-mono outline-none w-36 ${
                      isDarkMode ? 'bg-slate-900 border-slate-800 text-white focus:border-indigo-500' : 'bg-white border-slate-200 text-slate-900 focus:border-indigo-500'
                    }`}
                  />
                </div>
              </div>
            </div>

            {/* List Table of Displayed BS Years */}
            <div className={`overflow-x-auto rounded-xl border ${
              isDarkMode ? 'border-slate-800 bg-slate-900/40' : 'border-slate-200 bg-slate-50/50'
            }`}>
              <table className="w-full text-left text-xs font-mono">
                <thead className={`font-bold border-b ${
                  isDarkMode ? 'bg-slate-900 text-slate-300 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
                }`}>
                  <tr>
                    <th className="px-2.5 py-1.5">BS Year</th>
                    <th className="px-2.5 py-1.5">Baisakh 1 AD Date</th>
                    <th className="px-2.5 py-1.5">Total Days</th>
                    <th className="px-2.5 py-1.5">12 Month Days Array [Baisakh → Chaitra]</th>
                    <th className="px-2.5 py-1.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${
                  isDarkMode ? 'divide-slate-800 text-slate-300' : 'divide-slate-200 text-slate-700'
                }`}>
                  {displayedManagerYears.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-400">
                        No BS calendar years found matching your search/filter criteria.
                      </td>
                    </tr>
                  ) : (
                    displayedManagerYears.map((y) => {
                      const totalDays = y.daysInMonths.reduce((a, b) => a + b, 0);
                      const isRecent = recentYearObj && y.yearBS === recentYearObj.yearBS;
                      return (
                        <tr key={y.yearBS} className={`transition-colors ${
                          isRecent
                            ? isDarkMode ? 'bg-amber-950/20 hover:bg-amber-950/30' : 'bg-amber-50/60 hover:bg-amber-50'
                            : isDarkMode ? 'hover:bg-slate-800/50' : 'hover:bg-white'
                        }`}>
                          <td className="p-2.5 font-bold text-amber-500 dark:text-amber-400 text-sm whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <span>{y.yearBS} BS</span>
                              {isRecent && (
                                <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-sans font-extrabold border ${
                                  isDarkMode ? 'bg-amber-950 text-amber-300 border-amber-800' : 'bg-amber-100 text-amber-800 border-amber-200'
                                }`}>
                                  Recent
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-2.5 font-semibold whitespace-nowrap">
                            {y.startAD}
                          </td>
                          <td className="p-2.5 whitespace-nowrap">
                            <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                              totalDays === 365
                                ? isDarkMode ? 'bg-indigo-950 text-indigo-300 border-indigo-800' : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                                : isDarkMode ? 'bg-amber-950 text-amber-300 border-amber-800' : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}>
                              {totalDays} Days
                            </span>
                          </td>
                          <td className="p-2.5">
                            <div className="flex items-center gap-1 flex-wrap">
                              {y.daysInMonths.map((d, idx) => (
                                <span
                                  key={idx}
                                  title={`${NEPALI_MONTHS_EN[idx]} (${NEPALI_MONTHS_NP[idx]}): ${d} days`}
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                                    isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-800'
                                  }`}
                                >
                                  <span className="text-slate-400 mr-0.5">{idx + 1}:</span>
                                  <span className="font-bold">{d}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="p-2.5 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => openEditYearModal(y)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-xs transition-all cursor-pointer whitespace-nowrap"
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                              <span>Edit Array</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* EDIT BS YEAR MONTH ARRAY MODAL */}
      {editingYearData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className={`w-full max-w-2xl rounded-2xl border p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto ${
            isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="h-5 w-5 text-indigo-500" />
                <h3 className="text-base font-bold">
                  Update BS Year {editingYearData.yearBS} Month Array & Start Date
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingYearData(null)}
                className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {editError && (
              <div className={`p-3 rounded-xl border text-xs font-medium flex items-center gap-2 ${
                isDarkMode ? 'bg-rose-950/80 border-rose-500/40 text-rose-300' : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}>
                <AlertCircle className="h-4 w-4 text-rose-500 flex-shrink-0" />
                <span>{editError}</span>
              </div>
            )}

            <form onSubmit={handleSaveYearEdit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold mb-1">BS Year:</label>
                  <input
                    type="text"
                    disabled
                    value={`${editingYearData.yearBS} BS`}
                    className={`w-full rounded-xl border p-2.5 text-xs font-mono font-bold ${
                      isDarkMode ? 'bg-slate-950 border-slate-800 text-amber-400' : 'bg-slate-100 border-slate-300 text-slate-700'
                    }`}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold mb-1">
                    Baisakh 1 AD Start Date:
                  </label>
                  <input
                    type="date"
                    required
                    value={editStartAD}
                    onChange={(e) => setEditStartAD(e.target.value)}
                    className={`w-full rounded-xl border p-2.5 text-xs font-mono focus:border-indigo-500 outline-none ${
                      isDarkMode ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                    }`}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold">
                    12 Months Day Counts [Baisakh → Chaitra]:
                  </label>
                  <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-full border ${
                    editDaysInMonths.reduce((a, b) => a + (Number(b) || 0), 0) === 365
                      ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                      : 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                  }`}>
                    Total: {editDaysInMonths.reduce((a, b) => a + (Number(b) || 0), 0)} Days
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                  {NEPALI_MONTHS_EN.map((mName, idx) => (
                    <div
                      key={mName}
                      className={`p-2 rounded-xl border space-y-1 ${
                        isDarkMode ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <label className="block text-[11px] font-semibold truncate">
                        {idx + 1}. {mName} <span className="text-slate-400 font-normal">({NEPALI_MONTHS_NP[idx]})</span>
                      </label>
                      <input
                        type="number"
                        min={28}
                        max={32}
                        required
                        value={editDaysInMonths[idx] ?? 30}
                        onChange={(e) => handleMonthDaysChange(idx, parseInt(e.target.value, 10) || 0)}
                        className={`w-full rounded-lg border p-1.5 text-xs font-mono font-bold text-center outline-none focus:border-indigo-500 ${
                          isDarkMode ? 'bg-slate-900 border-slate-700 text-amber-300' : 'bg-white border-slate-300 text-slate-900'
                        }`}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingYearData(null)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border cursor-pointer ${
                    isDarkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingYearEdit}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-400 text-white font-bold text-xs shadow-md transition-all cursor-pointer"
                >
                  <Save className="h-4 w-4" />
                  <span>{isSavingYearEdit ? 'Saving & Syncing...' : 'Save & Sync to PostgreSQL'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* UNIFIED FEATURE CARD: Nepali Calendar Conversion, Bounds Checker & Day Table Suite */}
      <div className={`rounded-2xl border p-4 sm:p-5 shadow-xl space-y-4 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
      }`}>
        {/* Card Header */}
        <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b pb-3 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-amber-500 flex-shrink-0" />
            <div>
              <h3 className={`font-bold text-sm sm:text-base ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                Nepali Calendar & BS Date Conversion Suite (<code className={isDarkMode ? 'text-amber-300 font-mono text-xs' : 'text-amber-700 font-mono text-xs'}>BSDayRecord</code>)
              </h3>
              <p className={`text-[11px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                Targeted range converter, SQL table sync, single-date lookup with bounds checker, and live day-record table inspector.
              </p>
            </div>
          </div>

          <span className={`text-[10px] font-mono px-2 py-0.5 rounded-md border font-bold self-start sm:self-auto ${
            isDarkMode ? 'bg-amber-950/80 text-amber-300 border-amber-800/80' : 'bg-amber-50 text-amber-800 border-amber-200'
          }`}>
            PostgreSQL Sync Active
          </span>
        </div>

        {/* Compact Date Tools Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
          {/* Tool 1: Targeted Date Range Conversion */}
          <div className={`lg:col-span-7 p-3.5 rounded-xl border space-y-3 ${
            isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
          }`}>
            <div className={`flex items-center gap-1.5 text-xs font-bold ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
              <Zap className="h-3.5 w-3.5 text-amber-500" />
              <span>Targeted Date Range Conversion (AD → BS)</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 items-end">
              <div>
                <label className={`block text-[11px] font-semibold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                  Start Date (AD)
                </label>
                <input
                  type="date"
                  value={rangeStartDateAD}
                  onChange={(e) => setRangeStartDateAD(e.target.value)}
                  className={`w-full rounded-lg border p-2 text-xs font-mono outline-none focus:border-indigo-500 ${
                    isDarkMode
                      ? 'bg-slate-900 border-slate-700 text-slate-200'
                      : 'bg-white border-slate-300 text-slate-800'
                  }`}
                />
              </div>

              <div>
                <label className={`block text-[11px] font-semibold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                  End Date (AD)
                </label>
                <input
                  type="date"
                  value={rangeEndDateAD}
                  onChange={(e) => setRangeEndDateAD(e.target.value)}
                  className={`w-full rounded-lg border p-2 text-xs font-mono outline-none focus:border-indigo-500 ${
                    isDarkMode
                      ? 'bg-slate-900 border-slate-700 text-slate-200'
                      : 'bg-white border-slate-300 text-slate-800'
                  }`}
                />
              </div>

              <div>
                <button
                  type="button"
                  onClick={handleConvertRange}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs shadow-md transition-all cursor-pointer whitespace-nowrap"
                >
                  <Zap className="h-3.5 w-3.5" />
                  <span>Convert Range</span>
                </button>
              </div>
            </div>
          </div>

          {/* Tool 2: Single Date Lookup & Bounds Checker */}
          <div className={`lg:col-span-5 p-3.5 rounded-xl border space-y-2.5 ${
            isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
          }`}>
            <div className="flex items-center justify-between">
              <div className={`flex items-center gap-1.5 text-xs font-bold ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
                <CalendarIcon className="h-3.5 w-3.5 text-indigo-500" />
                <span>Single Date Lookup & Bounds Checker</span>
              </div>
              {boundsCheck.inBounds ? (
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-bold ${
                  isDarkMode
                    ? 'bg-emerald-950 text-emerald-400 border-emerald-800/80'
                    : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                }`}>
                  <ShieldCheck className="h-3 w-3" /> In Bounds
                </span>
              ) : (
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-bold ${
                  isDarkMode
                    ? 'bg-rose-950 text-rose-300 border-rose-800/80'
                    : 'bg-rose-100 text-rose-800 border-rose-200'
                }`}>
                  <ShieldAlert className="h-3 w-3" /> Out of Bounds
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-center">
              <div>
                <label className={`block text-[11px] font-semibold mb-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                  Single AD Date
                </label>
                <input
                  type="date"
                  value={testDateAD}
                  onChange={(e) => setTestDateAD(e.target.value)}
                  className={`w-full rounded-lg border p-2 text-xs font-mono outline-none focus:border-indigo-500 ${
                    isDarkMode
                      ? 'bg-slate-900 border-slate-700 text-slate-200'
                      : 'bg-white border-slate-300 text-slate-800'
                  }`}
                />
              </div>

              <div className={`p-2 rounded-lg border font-mono text-[11px] ${
                isDarkMode
                  ? 'bg-slate-950/80 border-slate-800'
                  : 'bg-white border-slate-200 shadow-2xs'
              }`}>
                <div className={`text-[10px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Calculated BS Result:</div>
                <div className="font-bold text-indigo-600 dark:text-indigo-300 truncate">
                  {lookedUpDayRecord.bsDay} {lookedUpDayRecord.bsMonthName} {lookedUpDayRecord.bsYear} BS
                </div>
                <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                  FY {lookedUpDayRecord.fiscalYear} ({lookedUpDayRecord.quarter})
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status Alerts & Missing Year Handler */}
        {rangeConversionStatus.type === 'missing_year' && (
          <div className={`p-3 rounded-xl border text-xs space-y-2.5 ${
            isDarkMode
              ? 'bg-amber-950/50 border-amber-500/40 text-amber-200'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />
              <span>{rangeConversionStatus.message}</span>
            </div>

            <div className={`p-2.5 rounded-lg border space-y-2 ${
              isDarkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-white border-amber-200'
            }`}>
              <span className={`font-bold block text-[11px] ${isDarkMode ? 'text-slate-300' : 'text-slate-800'}`}>
                Quick Seed Missing BS Year Array(s):
              </span>
              <div className="flex flex-wrap gap-2">
                {rangeConversionStatus.missingYears.map((mYear) => (
                  <button
                    key={mYear}
                    type="button"
                    onClick={async () => {
                      await handleQuickSeed(mYear, [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]);
                      handleConvertRange();
                    }}
                    className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-mono font-bold shadow transition-all cursor-pointer flex items-center gap-1"
                  >
                    <PlusCircle className="h-3 w-3" />
                    <span>Seed Array BS {mYear} & Retry</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {rangeConversionStatus.type === 'error' && (
          <div className={`p-2.5 rounded-xl border text-xs font-medium flex items-center gap-2 ${
            isDarkMode
              ? 'bg-rose-950/60 border-rose-500/40 text-rose-300'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}>
            <AlertCircle className="h-4 w-4 text-rose-500 flex-shrink-0" />
            <span>{rangeConversionStatus.message}</span>
          </div>
        )}

        {rangeConversionStatus.type === 'success' && (
          <div className={`space-y-3 p-3.5 rounded-xl border ${
            isDarkMode
              ? 'bg-emerald-950/20 border-emerald-500/30'
              : 'bg-emerald-50/60 border-emerald-200'
          }`}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className={`flex items-center gap-2 text-xs font-semibold ${
                isDarkMode ? 'text-emerald-300' : 'text-emerald-800'
              }`}>
                <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                <span>{rangeConversionStatus.message}</span>
              </div>

              {/* ACTION BUTTONS: CANCEL & WRITE TO SQL DATABASE */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCancelConversion}
                  className={`inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg font-semibold text-xs border transition-all cursor-pointer whitespace-nowrap ${
                    isDarkMode
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                      : 'bg-white hover:bg-slate-100 text-slate-700 border-slate-300'
                  }`}
                >
                  <X className="h-3.5 w-3.5 text-slate-400" />
                  <span>Cancel Conversion</span>
                </button>

                <button
                  type="button"
                  onClick={handleWriteToSql}
                  disabled={isSyncingSql}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-400 text-white font-bold text-xs shadow-md transition-all cursor-pointer whitespace-nowrap"
                >
                  <Database className="h-3.5 w-3.5" />
                  <span>
                    {isSyncingSql ? 'Writing to SQL Database...' : 'Update & Write Converted Range to SQL Database'}
                  </span>
                </button>
              </div>
            </div>

            {/* Preview Summary Statistics */}
            <div className={`grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono pt-2 border-t ${
              isDarkMode ? 'border-emerald-500/20 text-slate-300' : 'border-emerald-200 text-slate-700'
            }`}>
              <div className={`p-2 rounded-lg border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
              }`}>
                <span className={`text-[10px] block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Total Converted Days</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-bold text-xs sm:text-sm">{rangeConversionStatus.records.length} Days</span>
              </div>
              <div className={`p-2 rounded-lg border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
              }`}>
                <span className={`text-[10px] block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Start BS Date</span>
                <span className="text-indigo-600 dark:text-indigo-300 font-bold">{rangeConversionStatus.records[0]?.bsDate} BS</span>
              </div>
              <div className={`p-2 rounded-lg border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
              }`}>
                <span className={`text-[10px] block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>End BS Date</span>
                <span className="text-indigo-600 dark:text-indigo-300 font-bold">{rangeConversionStatus.records[rangeConversionStatus.records.length - 1]?.bsDate} BS</span>
              </div>
              <div className={`p-2 rounded-lg border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
              }`}>
                <span className={`text-[10px] block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Saturdays / Weekends</span>
                <span className="text-rose-600 dark:text-rose-400 font-bold">{rangeConversionStatus.records.filter(r => r.isWeekend).length} Days</span>
              </div>
            </div>

            {/* SQL Sync Success Result */}
            {sqlSyncSuccess && (
              <div
                className={`p-2.5 rounded-lg border text-xs font-medium flex items-center gap-2 ${
                  sqlSyncSuccess.success
                    ? isDarkMode
                      ? 'bg-emerald-900/50 border-emerald-400/50 text-emerald-200'
                      : 'bg-emerald-100 border-emerald-300 text-emerald-800'
                    : isDarkMode
                      ? 'bg-rose-950/60 border-rose-500/40 text-rose-300'
                      : 'bg-rose-100 border-rose-300 text-rose-800'
                }`}
              >
                {sqlSyncSuccess.success ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-rose-500 flex-shrink-0" />
                )}
                <span>{sqlSyncSuccess.message}</span>
              </div>
            )}

            {/* Spilled-over Day-by-Day Database Table Inspector (BSDayRecord) */}
            <div className={`pt-2.5 border-t space-y-2.5 ${
              isDarkMode ? 'border-emerald-500/20' : 'border-emerald-200'
            }`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className={`flex items-center gap-1.5 text-xs font-bold ${
                  isDarkMode ? 'text-slate-200' : 'text-slate-800'
                }`}>
                  <Database className="h-3.5 w-3.5 text-amber-500" />
                  <span>
                    Converted Day-by-Day Table Records (<code className={isDarkMode ? 'text-amber-300 font-mono text-[11px]' : 'text-amber-700 font-mono text-[11px]'}>BSDayRecord</code>)
                  </span>
                </div>

 <div className="relative w-full md:w-80 lg:w-96 shrink-0 sm:w-56">
                  <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2" />
                  <input
                    type="text"
                    value={rangeSearchQuery}
                    onChange={(e) => setRangeSearchQuery(e.target.value)}
                    placeholder="Search AD/BS Date, Month..."
                    className={`w-full rounded-lg border pl-8 pr-2.5 py-1 text-xs outline-none focus:border-amber-500 font-mono ${
                      isDarkMode
                        ? 'bg-slate-900/90 border-slate-800 text-slate-200 placeholder-slate-500'
                        : 'bg-white border-slate-300 text-slate-800 placeholder-slate-400'
                    }`}
                  />
                </div>
              </div>

              <div className={`overflow-x-auto rounded-xl border max-h-72 overflow-y-auto ${
                isDarkMode ? 'border-slate-800/80 bg-[#0f1218]' : 'border-slate-200 bg-white'
              }`}>
                <table className="w-full text-left text-[11px] font-mono">
                  <thead className={`sticky top-0 z-10 font-bold border-b backdrop-blur-md ${
                    isDarkMode
                      ? 'bg-slate-900/95 text-slate-300 border-slate-800'
                      : 'bg-slate-100 text-slate-700 border-slate-200'
                  }`}>
                    <tr>
                      <th className="p-2">AD Date</th>
                      <th className="p-2">BS Date</th>
                      <th className="p-2">Month Name</th>
                      <th className="p-2">Day of Week</th>
                      <th className="p-2">Fiscal Year</th>
                      <th className="p-2">Quarter</th>
                      <th className="p-2">Day Type</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${
                    isDarkMode ? 'divide-slate-800/80 text-slate-300' : 'divide-slate-200 text-slate-700'
                  }`}>
                    {rangeConversionStatus.records
                      .filter((rec) => {
                        if (!rangeSearchQuery.trim()) return true;
                        const q = (rangeSearchQuery || '').toLowerCase();
                        return (
                          rec.adDate.includes(q) ||
                          rec.bsDate.includes(q) ||
                          (rec?.bsMonthName || '').toLowerCase().includes(q) ||
                          (rec?.dayOfWeekName || '').toLowerCase().includes(q) ||
                          (rec?.fiscalYear || '').toLowerCase().includes(q)
                        );
                      })
                      .map((rec) => (
                        <tr key={rec.adDate} className={`transition-colors ${
                          isDarkMode ? 'hover:bg-slate-900/50' : 'hover:bg-slate-50'
                        }`}>
                          <td className={`p-2 font-semibold ${isDarkMode ? 'text-slate-200' : 'text-slate-900'}`}>{rec.adDate}</td>
                          <td className="p-2 font-bold text-amber-600 dark:text-amber-300">{rec.bsDate} BS</td>
                          <td className={`p-2 ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                            {rec.bsMonthName} ({rec.bsMonthNameNp})
                          </td>
                          <td className={`p-2 ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                            {rec.dayOfWeekName} ({rec.dayOfWeekNameNp})
                          </td>
                          <td className="p-2">
                            <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] border ${
                              isDarkMode
                                ? 'bg-indigo-950 text-indigo-300 border-indigo-800'
                                : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                            }`}>
                              FY {rec.fiscalYear}
                            </span>
                          </td>
                          <td className="p-2">
                            <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] ${
                              isDarkMode ? 'bg-slate-800 text-amber-300' : 'bg-slate-100 text-amber-800'
                            }`}>
                              {rec.quarter}
                            </span>
                          </td>
                          <td className="p-2">
                            {rec.isWeekend ? (
                              <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] border ${
                                isDarkMode
                                  ? 'bg-rose-950 text-rose-300 border-rose-800'
                                  : 'bg-rose-50 text-rose-700 border-rose-200'
                              }`}>
                                Saturday Weekend
                              </span>
                            ) : (
                              <span className="text-slate-500 text-[10px]">Working Day</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
