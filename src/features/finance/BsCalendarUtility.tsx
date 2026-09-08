import React, { useState, useEffect } from 'react';
import { api } from '../../services/api';
import {
  convertADToBS,
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
  Database,
  AlertCircle,
  RotateCcw,
  Layers,
  Search,
  Edit3,
  Sliders,
  PlusCircle,
  Zap,
  X,
  FileCheck2,
  Calendar as CalendarIcon,
} from 'lucide-react';

interface BsCalendarUtilityProps {
  isDarkMode?: boolean;
}

export const BsCalendarUtility: React.FC<BsCalendarUtilityProps> = ({
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
      seedBSYearCalendar(editingYearData.yearBS, editDaysInMonths, editStartAD);
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
          message: `BS Year ${yearBS} already exists in calendar database. Skipped duplicate seeding.`,
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
          ? `${res.message} (Synced to PostgreSQL bs_day_records table)`
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
        message: `BS Year ${yearBS} already exists in calendar database! Skipped duplicate seed.`,
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
          ? `Successfully seeded new BS Year ${yearBS} and synced it to PostgreSQL bs_day_records!`
          : `Seeded new BS Year ${yearBS} in the in-memory calendar only — PostgreSQL was unreachable.`,
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

    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
      setRangeConversionStatus({
        type: 'error',
        message: 'Invalid AD date range specified.',
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
        const estBSYear = current.getUTCFullYear() + 57;
        missingYearsSet.add(estBSYear);
      }
      current.setDate(current.getDate() + 1);
    }

    if (missingYearsSet.size > 0) {
      const missingArr = Array.from(missingYearsSet).sort((a, b) => a - b);
      setRangeConversionStatus({
        type: 'missing_year',
        message: `Missing BS Calendar month array data for BS Year(s): ${missingArr.join(', ')}.`,
        records: [],
        missingYears: missingArr,
      });
      return;
    }

    setRangeConversionStatus({
      type: 'success',
      message: `Conversion completed! Generated ${records.length} daily conversion records from ${rangeStartDateAD} to ${rangeEndDateAD}.`,
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
      setSqlSyncSuccess({
        success: res.success,
        message: res.message,
      });
      await refreshCalendarData();
    } catch (err: any) {
      setSqlSyncSuccess({
        success: false,
        message: `Error syncing to database: ${err.message}`,
      });
    } finally {
      setIsSyncingSql(false);
    }
  };

  const handleResetDefaults = () => {
    if (confirm('Reset BS Calendar back to standard reference values?')) {
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
  const lookedUpDayRecord = lookupBSDayRecord(testDateAD);
  const sortedYears = (Object.values(calendarData) as BSYearData[]).sort((a, b) => a.yearBS - b.yearBS);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <CalendarDays className="h-5 w-5 text-indigo-500" />
            <span>BS Calendar Utility & Date Engine</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Full Day-by-Day Bikram Sambat Calendar Engine, AD ↔ BS Converters, Month Array Seeder & Mapped Database.
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
                Nepali Calendar Engine Status:
              </span>
              <span className={`text-[11px] font-mono px-2 py-0.5 rounded-full border font-bold ${
                isDarkMode ? 'bg-emerald-950 text-emerald-400 border-emerald-500/30' : 'bg-emerald-100 text-emerald-800 border-emerald-200'
              }`}>
                {(bounds.totalDaysMapped ?? 0).toLocaleString()} Days Pre-Mapped
              </span>
            </div>
            <p className={`text-xs font-mono mt-0.5 ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
              AD Range: <span className={`${isDarkMode ? 'text-amber-300' : 'text-amber-600'} font-bold`}>{bounds.minAD}</span> to <span className={`${isDarkMode ? 'text-amber-300' : 'text-amber-600'} font-bold`}>{bounds.maxAD}</span> | BS Range: <span className={`${isDarkMode ? 'text-indigo-300' : 'text-indigo-600'} font-bold`}>{bounds.minBS}</span> to <span className={`${isDarkMode ? 'text-indigo-300' : 'text-indigo-600'} font-bold`}>{bounds.maxBS}</span>
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

      {/* Date Converter Test Card */}
      <div className={`rounded-2xl border p-5 shadow-xl space-y-4 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
      }`}>
        <h3 className={`font-bold text-sm flex items-center gap-2 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
          <CalendarIcon className="h-4 w-4 text-indigo-500" />
          <span>Single AD Date Lookup Tester</span>
        </h3>
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
          <input
            type="date"
            value={testDateAD}
            onChange={(e) => setTestDateAD(e.target.value)}
            className={`px-3 py-2 rounded-xl border text-xs font-mono outline-none focus:border-indigo-500 ${
              isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-300 text-slate-900'
            }`}
          />

          {lookedUpDayRecord ? (
            <div className={`flex-1 p-3 rounded-xl border flex flex-wrap items-center gap-4 text-xs ${
              isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
            }`}>
              <div>
                <span className="text-slate-400 text-[10px] uppercase font-bold block">BS Date</span>
                <span className="font-mono font-bold text-indigo-500 text-sm">{lookedUpDayRecord.bsDate}</span>
              </div>
              <div>
                <span className="text-slate-400 text-[10px] uppercase font-bold block">Nepali Month</span>
                <span className="font-semibold">{lookedUpDayRecord.bsMonthNameNp} ({lookedUpDayRecord.bsMonthName})</span>
              </div>
              <div>
                <span className="text-slate-400 text-[10px] uppercase font-bold block">Fiscal Year</span>
                <span className="font-mono font-bold text-amber-500">FY {lookedUpDayRecord.fiscalYear}</span>
              </div>
              <div>
                <span className="text-slate-400 text-[10px] uppercase font-bold block">Quarter</span>
                <span className="font-bold">{lookedUpDayRecord.quarter}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-amber-500 font-semibold">Date outside pre-mapped BS calendar range.</p>
          )}
        </div>
      </div>

      {/* Month Array Seeder */}
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
                Input 12-month array (e.g. <code className={isDarkMode ? 'text-amber-300 font-mono' : 'text-amber-700 font-mono'}>2082: [31, 31, 32, ...]</code>) to build daily lookup records.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSeedSubmit} className="space-y-3">
          <div>
            <label className={`block text-xs font-semibold mb-1 ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
              Enter BS Year & 12 Month Days Array:
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder="2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]"
                className={`flex-1 rounded-xl border p-3 text-xs font-mono outline-none focus:border-indigo-500 ${
                  isDarkMode
                    ? 'bg-slate-900 border-slate-700 text-amber-300 placeholder-slate-500'
                    : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400'
                }`}
              />
              <div className="flex items-center gap-2">
                <label className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-semibold cursor-pointer ${
                  isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}>
                  <input
                    type="checkbox"
                    checked={seedOnlyIfNew}
                    onChange={(e) => setSeedOnlyIfNew(e.target.checked)}
                    className={`rounded ${isDarkMode ? 'text-indigo-300' : 'text-indigo-600'} h-4 w-4`}
                  />
                  <span>Seed only if new</span>
                </label>

                <button
                  type="submit"
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-md transition-all cursor-pointer whitespace-nowrap"
                >
                  <PlusCircle className="h-4 w-4" />
                  <span>Seed Calendar</span>
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className={`text-[11px] font-bold flex items-center gap-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              <Zap className="h-3 w-3 text-amber-500" />
              <span>Presets:</span>
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

      {/* BS Calendar Years & Month Days Manager */}
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
                Inspect & edit 12-month day count arrays (<code className={isDarkMode ? 'text-amber-300 font-mono' : 'text-amber-700 font-mono'}>[Baisakh..Chaitra]</code>).
              </p>
            </div>
          </div>
        </div>

        {/* Table of Displayed BS Years */}
        <div className={`overflow-x-auto rounded-xl border ${
          isDarkMode ? 'border-slate-800 bg-slate-900/40' : 'border-slate-200 bg-slate-50/50'
        }`}>
          <table className="w-full text-left text-xs font-mono">
            <thead className={`font-bold border-b ${
              isDarkMode ? 'bg-slate-900 text-slate-300 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
            }`}>
              <tr>
                <th className="px-2.5 py-1.5">BS Year</th>
                <th className="px-2.5 py-1.5">Baisakh 1 AD Start</th>
                <th className="px-2.5 py-1.5">Total Days</th>
                <th className="px-2.5 py-1.5">12 Month Days Array [Baisakh → Chaitra]</th>
                <th className="px-2.5 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${
              isDarkMode ? 'divide-slate-800 text-slate-300' : 'divide-slate-200 text-slate-700'
            }`}>
              {sortedYears.map((y) => {
                const totalDays = y.daysInMonths.reduce((a, b) => a + b, 0);
                return (
                  <tr key={y.yearBS} className={`transition-colors ${
                    isDarkMode ? 'hover:bg-slate-800/50' : 'hover:bg-white'
                  }`}>
                    <td className="p-2.5 font-bold text-amber-500 dark:text-amber-400 text-sm whitespace-nowrap">
                      {y.yearBS} BS
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
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-xs transition-all cursor-pointer"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        <span>Edit Array</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit BS Year Modal */}
      {editingYearData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className={`w-full max-w-2xl rounded-2xl border p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto ${
            isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="h-5 w-5 text-indigo-500" />
                <h3 className="text-base font-bold">
                  Update BS Year {editingYearData.yearBS} Month Array
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingYearData(null)}
                className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {editError && (
              <div className="p-3 rounded-xl border text-xs font-medium bg-rose-50 text-rose-800 border-rose-200">
                {editError}
              </div>
            )}

            <form onSubmit={handleSaveYearEdit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold mb-1">BS Year:</label>
                  <input
                    type="text"
                    disabled
                    value={`${editingYearData.yearBS} BS`}
                    className="w-full rounded-xl border p-2.5 text-xs font-mono font-bold bg-slate-100 dark:bg-slate-950 text-slate-700 dark:text-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">Baisakh 1 AD Start Date:</label>
                  <input
                    type="date"
                    required
                    value={editStartAD}
                    onChange={(e) => setEditStartAD(e.target.value)}
                    className="w-full rounded-xl border p-2.5 text-xs font-mono bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold mb-2">12 Months Day Counts [Baisakh → Chaitra]:</label>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {NEPALI_MONTHS_EN.map((mName, idx) => (
                    <div key={mName} className="p-2 rounded-xl border bg-slate-50 dark:bg-slate-950">
                      <label className="block text-[11px] font-semibold truncate">{idx + 1}. {mName}</label>
                      <input
                        type="number"
                        min={28}
                        max={32}
                        value={editDaysInMonths[idx] || 30}
                        onChange={(e) => handleMonthDaysChange(idx, parseInt(e.target.value, 10))}
                        className="w-full rounded-lg border p-1 text-xs font-mono font-bold text-center bg-white dark:bg-slate-900"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setEditingYearData(null)}
                  className="px-4 py-2 rounded-xl border text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingYearEdit}
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold text-xs"
                >
                  {isSavingYearEdit ? 'Saving...' : 'Save Month Array'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
