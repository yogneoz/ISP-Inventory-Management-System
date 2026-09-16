import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../services/api';
import {
  convertADToBS,
  getBsCalendarData,
  parseAndSeedBSInput,
  parseBSSeedYears,
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
  Upload,
  FileSpreadsheet,
  FileDown,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import * as XLSX from 'xlsx';

interface BsCalendarUtilityProps {
}

export const BsCalendarUtility: React.FC<BsCalendarUtilityProps> = ({
}) => {
  const [calendarData, setCalendarData] = useState<Record<number, BSYearData>>({});
  const [dayDatabase, setDayDatabase] = useState<BSDayRecord[]>([]);
  const [seedInput, setSeedInput] = useState<string>(
    '2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]\n2083: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]'
  );
  const [seedOnlyIfNew, setSeedOnlyIfNew] = useState<boolean>(true);
  const [isSeeding, setIsSeeding] = useState<boolean>(false);
  const [seedStatus, setSeedStatus] = useState<{
    type: 'success' | 'error' | null;
    message: string;
  }>({ type: null, message: '' });

  // Multi-year text preview (derived live from the textarea)
  const textPreviewYears = useMemo(() => parseBSSeedYears(seedInput).years, [seedInput]);

  // Excel (.xlsx / .csv) multi-year import preview
  const [excelPreviewYears, setExcelPreviewYears] = useState<
    { yearBS: number; daysInMonths: number[]; startAD?: string }[]
  >([]);
  const [excelFileName, setExcelFileName] = useState<string>('');
  const [excelParseStatus, setExcelParseStatus] = useState<{
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
      // Update the BS year config and regenerate day records in PostgreSQL
      const updateRes = await api.updateBsCalendarYear(editingYearData.yearBS, {
        daysInMonths: editDaysInMonths,
        startAD: editStartAD,
        recalculateNextStartAD: true,
      });

      setSeedStatus({
        type: 'success',
        message: updateRes.message || `Successfully updated BS Year ${editingYearData.yearBS} and regenerated its day records in PostgreSQL!`,
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
    setIsSeeding(true);
    setSeedStatus({ type: null, message: '' });

    try {
      // Multi-year preview: reuse whichever parser applies (colon lines, JSON, CSV/TSV)
      const parsedYears = parseBSSeedYears(seedInput).years;

      if (seedOnlyIfNew) {
        const existing = parsedYears.filter((y) => calendarData[y.yearBS]);
        if (parsedYears.length > 0 && existing.length === parsedYears.length) {
          setSeedStatus({
            type: 'success',
            message: `All ${parsedYears.length} BS year(s) (${parsedYears
              .map((y) => y.yearBS)
              .join(', ')}) already exist in calendar database. Skipped duplicate seeding.`,
          });
          return;
        }
      }

      const res = parseAndSeedBSInput(seedInput);
      if (res.success) {
        let seedPgSynced = true;
        const seeds = parsedYears.length > 0 ? parsedYears : [];

        // Sync all parsed years to PostgreSQL in one batch request
        if (seeds.length > 0) {
          const bulkYears = seeds
            .map((s) => ({
              yearBS: s.yearBS,
              daysInMonths: s.daysInMonths,
              customStartAD: s.startAD || undefined,
            }))
            .filter((s) => Array.isArray(s.daysInMonths) && s.daysInMonths.length === 12);
          if (bulkYears.length > 0) {
            try {
              const bulkRes = await api.seedBsCalendarYearsBulk(bulkYears, seedOnlyIfNew);
              if (bulkRes && bulkRes.pgSynced === false) seedPgSynced = false;
            } catch (err: any) {
              console.warn('PostgreSQL Bulk Seed Warning:', err.message);
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
    } finally {
      setIsSeeding(false);
    }
  };

  // --- Excel / CSV multi-year import ---
  const handleExcelFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, any>>(firstSheet, { defval: '' });

        const headerRow = rows[0] || {};
        const yearKey = Object.keys(headerRow).find((k) => /year/i.test(String(k)));
        const startKey = Object.keys(headerRow).find((k) => /start|ad/i.test(String(k)));
        const monthKeys = Object.keys(headerRow).filter(
          (k) => /month/i.test(String(k)) || /^(1|2|3|4|5|6|7|8|9|10|11|12)$/.test(String(k).trim())
        );

        const parsed: { yearBS: number; daysInMonths: number[]; startAD?: string }[] = [];

        for (const row of rows) {
          let yearBS: number | null = null;
          if (yearKey && row[yearKey] !== '' && row[yearKey] != null) {
            yearBS = parseInt(String(row[yearKey]).split('.')[0], 10);
          } else if (row['BS Year'] != null && row['BS Year'] !== '') {
            yearBS = parseInt(String(row['BS Year']).split('.')[0], 10);
          }
          if (!yearBS || isNaN(yearBS)) continue;

          let days: number[] = [];
          if (monthKeys.length >= 12) {
            days = monthKeys
              .slice(0, 12)
              .map((k) => parseInt(String(row[k]).split('.')[0], 10))
              .map((n) => (isNaN(n) ? 0 : n));
          } else {
            // Fallback: rows laid out as BS Year + 12 numbers
            days = Object.keys(row)
              .map((k) => parseInt(String(row[k]).split('.')[0], 10))
              .filter((n) => !isNaN(n) && n > 0 && n <= 32)
              .slice(0, 12);
          }

          if (days.length === 12 && days.every((n) => !isNaN(n))) {
            let startAD: string | undefined;
            if (startKey && row[startKey]) startAD = String(row[startKey]).split('T')[0];
            else if (row['Start AD'] != null && row['Start AD'] !== '')
              startAD = String(row['Start AD']).split('T')[0];
            parsed.push({ yearBS, daysInMonths: days, startAD });
          }
        }

        setExcelPreviewYears(parsed);
        setExcelFileName(file.name);
        setExcelParseStatus(
          parsed.length > 0
            ? { type: 'success', message: `Parsed ${parsed.length} BS year(s) from "${file.name}".` }
            : {
                type: 'error',
                message: `No valid BS year rows found in "${file.name}". Expected a "BS Year" column plus 12 month columns (Baisakh → Chaitra).`,
              }
        );
      } catch (err: any) {
        setExcelPreviewYears([]);
        setExcelFileName('');
        setExcelParseStatus({
          type: 'error',
          message: `Failed to parse Excel file: ${err.message || 'unknown error'}`,
        });
      } finally {
        // Allow re-selecting the same file
        e.target.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleSeedExcel = async () => {
    if (excelPreviewYears.length === 0) return;
    setIsSeeding(true);
    setSeedStatus({ type: null, message: '' });
    try {
      const freshCalendar = getBsCalendarData();
      if (seedOnlyIfNew) {
        const existing = excelPreviewYears.filter((y) => freshCalendar[y.yearBS]);
        if (existing.length === excelPreviewYears.length) {
          setSeedStatus({
            type: 'success',
            message: `All ${excelPreviewYears.length} BS year(s) from Excel already exist. Skipped duplicate seeding.`,
          });
          return;
        }
      }

      // 1) Seed in-memory / localStorage for every year
      for (const y of excelPreviewYears) {
        if (seedOnlyIfNew && freshCalendar[y.yearBS]) continue;
        seedBSYearCalendar(y.yearBS, y.daysInMonths, y.startAD);
      }

      // 2) Batch-sync to PostgreSQL
      let seedPgSynced = true;
      try {
        const bulkRes = await api.seedBsCalendarYearsBulk(excelPreviewYears, seedOnlyIfNew);
        if (bulkRes && bulkRes.pgSynced === false) seedPgSynced = false;
      } catch (err: any) {
        console.warn('PostgreSQL Excel Seed Warning:', err.message);
        seedPgSynced = false;
      }

      setSeedStatus({
        type: 'success',
        message: seedPgSynced
          ? `Successfully seeded ${excelPreviewYears.length} BS year(s) from Excel (${excelPreviewYears
              .map((y) => y.yearBS)
              .join(', ')}) and synced to PostgreSQL bs_day_records!`
          : `Successfully seeded ${excelPreviewYears.length} BS year(s) from Excel in the in-memory calendar only — PostgreSQL was unreachable.`,
      });
      await refreshCalendarData();
    } finally {
      setIsSeeding(false);
    }
  };

  const handleDownloadExcelTemplate = () => {
    const header = ['BS Year', ...NEPALI_MONTHS_EN, 'Start AD'];
    const sampleRow = [2086, ...([31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] as number[]), '2029-04-14'];
    const ws = XLSX.utils.aoa_to_sheet([header, sampleRow]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'BS Month Arrays');
    XLSX.writeFile(wb, 'bs-calendar-multi-year-template.xlsx');
  };

  const handleClearExcelPreview = () => {
    setExcelPreviewYears([]);
    setExcelFileName('');
    setExcelParseStatus({ type: null, message: '' });
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
        localStorage.removeItem('inventory_bs_calendar_data');
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

  const yearsPagination = useClientPagination(sortedYears, 8, [calendarData]);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <CalendarDays className="h-5 w-5 text-indigo-500" />
            <span>BS Calendar Utility & Date Engine</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Full Day-by-Day Bikram Sambat Calendar Engine, AD ↔ BS Converters, Month Array Seeder & Mapped Database.
          </p>
        </div>

        <button
          onClick={handleResetDefaults}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer w-fit bg-white hover:bg-slate-200 text-slate-700 border-slate-200 shadow-2xs dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700`}
        >
          <RotateCcw className="h-3.5 w-3.5 text-slate-400" />
          <span>Reset Calendar Defaults</span>
        </button>
      </div>

      {/* Database Bounds Limiter Banner */}
      <div className={`rounded-2xl border p-3 shadow-lg flex flex-col sm:flex-row sm:items-center justify-start gap-3 bg-indigo-50/70 border-indigo-200/80 dark:bg-gradient-to-r dark:from-indigo-950/80 dark:via-slate-900 dark:to-slate-900 dark:border-indigo-800/60`}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl border bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/20 dark:text-indigo-300 dark:border-indigo-500/30`}>
            <Database className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-bold text-slate-900 dark:text-white`}>
                Nepali Calendar Engine Status:
              </span>
              <span className={`text-[11px] font-mono px-2 py-0.5 rounded-full border font-bold bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-500/30`}>
                {(bounds.totalDaysMapped ?? 0).toLocaleString()} Days Pre-Mapped
              </span>
            </div>
            <p className={`text-xs font-mono mt-0.5 text-slate-700 dark:text-slate-300`}>
              AD Range: <span className={`text-amber-600 dark:text-amber-300 font-bold`}>{bounds.minAD}</span> to <span className={`text-amber-600 dark:text-amber-300 font-bold`}>{bounds.maxAD}</span> | BS Range: <span className={`text-indigo-600 dark:text-indigo-300 font-bold`}>{bounds.minBS}</span> to <span className={`text-indigo-600 dark:text-indigo-300 font-bold`}>{bounds.maxBS}</span>
            </p>
          </div>
        </div>

        <div className={`flex items-center gap-2 font-mono text-xs px-3 py-2 rounded-xl border text-slate-700 bg-white border-slate-200 shadow-2xs dark:text-slate-400 dark:bg-slate-950/60 dark:border-slate-800`}>
          <Layers className="h-4 w-4 text-indigo-500" />
          <span>{bounds.mappedYearsCount} Mapped BS Years ({bounds.mappedYears.join(', ')})</span>
        </div>
      </div>

      {/* Date Converter Test Card */}
      <div className={`rounded-2xl border p-5 shadow-xl space-y-4 bg-white border-slate-200 shadow-2xs dark:bg-[#0f1218] dark:border-slate-800`}>
        <h3 className={`font-bold text-sm flex items-center gap-2 text-slate-900 dark:text-white`}>
          <CalendarIcon className="h-4 w-4 text-indigo-500" />
          <span>Single AD Date Lookup Tester</span>
        </h3>
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
          <input
            type="date"
            value={testDateAD}
            onChange={(e) => setTestDateAD(e.target.value)}
            className={`px-3 py-2 rounded-xl border text-xs font-mono outline-none focus:border-indigo-500 bg-slate-50 border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white`}
          />

          {lookedUpDayRecord ? (
            <div className={`flex-1 p-3 rounded-xl border flex flex-wrap items-center gap-4 text-xs bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}>
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
      <div className={`rounded-2xl border p-6 shadow-xl space-y-4 bg-white border-slate-200 shadow-2xs dark:bg-[#0f1218] dark:border-indigo-900/50`}>
        <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b pb-3 border-slate-200 dark:border-slate-800`}>
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl border bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-500/20`}>
              <Database className="h-5 w-5" />
            </div>
            <div>
              <h3 className={`font-bold text-base text-slate-900 dark:text-white`}>
                Seed BS Month Array & Expand Day-by-Day Database Table
              </h3>
              <p className={`text-xs text-slate-500 dark:text-slate-400`}>
                Input one or more 12-month arrays (e.g. <code className="text-amber-700 font-mono dark:text-amber-300 dark:font-mono">2082: [31, 31, 32, ...]</code> per line) or import an Excel/CSV file to build daily lookup records for multiple years at once.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSeedSubmit} className="space-y-3">
          <div>
            <label className={`block text-xs font-semibold mb-1 text-slate-700 dark:text-slate-300`}>
              Enter BS Year(s) & 12 Month Days Array (one year per line):
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <textarea
                rows={4}
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder={'2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]\n2083: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30]'}
                className={`flex-1 rounded-xl border p-3 text-xs font-mono outline-none focus:border-indigo-500 resize-y bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-700 dark:text-amber-300 dark:placeholder-slate-500`}
              />
              <div className="flex flex-col items-stretch gap-2 justify-between sm:w-56 shrink-0">
                <label className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-semibold cursor-pointer bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300`}>
                  <input
                    type="checkbox"
                    checked={seedOnlyIfNew}
                    onChange={(e) => setSeedOnlyIfNew(e.target.checked)}
                    className={`rounded text-indigo-600 dark:text-indigo-300 h-4 w-4`}
                  />
                  <span>Seed only if new</span>
                </label>

                <button
                  type="submit"
                  disabled={isSeeding}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-bold text-xs shadow-md transition-all cursor-pointer whitespace-nowrap"
                >
                  {isSeeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlusCircle className="h-4 w-4" />}
                  <span>{isSeeding ? 'Seeding...' : 'Seed Calendar'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Multi-year preview table (live from textarea) */}
          {textPreviewYears.length > 0 && (
            <div className={`rounded-xl border overflow-hidden bg-slate-50/70 border-slate-200 dark:bg-slate-900/50 dark:border-slate-800`}>
              <div className={`flex items-center justify-between px-3 py-2 border-b text-[11px] font-bold text-slate-600 bg-slate-100/70 border-slate-200 dark:text-slate-300 dark:bg-slate-900 dark:border-slate-800`}>
                <span className="flex items-center gap-1.5">
                  <FileCheck2 className="h-3.5 w-3.5 text-emerald-500" />
                  Preview: {textPreviewYears.length} BS year(s) detected — will be seeded
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px] font-mono">
                  <thead className={`text-slate-500 border-b border-slate-200 dark:text-slate-400 dark:border-slate-800`}>
                    <tr>
                      <th className="px-3 py-1.5">BS Year</th>
                      <th className="px-3 py-1.5">Baisakh 1 AD Start</th>
                      <th className="px-3 py-1.5">Total Days</th>
                      <th className="px-3 py-1.5">12 Month Days Array</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y divide-slate-200 text-slate-700 dark:divide-slate-800 dark:text-slate-300`}>
                    {textPreviewYears.map((y) => {
                      const total = y.daysInMonths.reduce((a, b) => a + b, 0);
                      return (
                        <tr key={y.yearBS}>
                          <td className="px-3 py-1.5 font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap">{y.yearBS} BS</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">{y.startAD || `≈ ${y.yearBS - 57}-04-14`}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">{total} days</td>
                          <td className="px-3 py-1.5 text-[10px]">{y.daysInMonths.join(', ')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Excel / CSV multi-year import */}
          <div className={`rounded-xl border p-3 bg-blue-50/50 border-blue-200/70 dark:bg-blue-950/20 dark:border-blue-800/40`}>
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <FileSpreadsheet className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
                <div className="min-w-0">
                  <p className={`text-xs font-bold text-slate-800 dark:text-slate-200`}>
                    Bulk Import Multiple Years from Excel / CSV
                  </p>
                  <p className={`text-[11px] text-slate-500 dark:text-slate-400 truncate`}>
                    Columns: <code className="font-mono">BS Year</code> + 12 month columns (Baisakh → Chaitra) + optional <code className="font-mono">Start AD</code>.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleDownloadExcelTemplate}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold bg-white hover:bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-300 dark:border-slate-700 cursor-pointer"
                >
                  <FileDown className="h-3.5 w-3.5 text-blue-500" />
                  Template
                </button>
                <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold cursor-pointer bg-blue-600 hover:bg-blue-500 text-white border-blue-700`}>
                  <Upload className="h-3.5 w-3.5" />
                  Choose File
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={handleExcelFileSelect}
                  />
                </label>
              </div>
            </div>

            {excelParseStatus.message && (
              <p className={`mt-2 text-[11px] font-medium flex items-center gap-1.5 ${excelParseStatus.type === 'success' ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                {excelParseStatus.type === 'success' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                {excelParseStatus.message}
              </p>
            )}

            {excelPreviewYears.length > 0 && (
              <div className="mt-2">
                <div className="overflow-x-auto rounded-lg border border-blue-200 dark:border-blue-800/60">
                  <table className="w-full text-left text-[11px] font-mono">
                    <thead className={`text-slate-500 border-b bg-blue-100/50 border-blue-200 dark:text-slate-400 dark:bg-blue-950/30 dark:border-blue-800/60`}>
                      <tr>
                        <th className="px-2.5 py-1.5">BS Year</th>
                        <th className="px-2.5 py-1.5">Baisakh 1 AD Start</th>
                        <th className="px-2.5 py-1.5">Total Days</th>
                        <th className="px-2.5 py-1.5">12 Month Days Array</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y divide-blue-100 text-slate-700 dark:divide-blue-900/40 dark:text-slate-300`}>
                      {excelPreviewYears.map((y) => {
                        const total = y.daysInMonths.reduce((a, b) => a + b, 0);
                        return (
                          <tr key={y.yearBS}>
                            <td className="px-2.5 py-1.5 font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap">{y.yearBS} BS</td>
                            <td className="px-2.5 py-1.5 whitespace-nowrap">{y.startAD || `≈ ${y.yearBS - 57}-04-14`}</td>
                            <td className="px-2.5 py-1.5 whitespace-nowrap">{total} days</td>
                            <td className="px-2.5 py-1.5 text-[10px]">{y.daysInMonths.join(', ')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    onClick={handleSeedExcel}
                    disabled={isSeeding}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white cursor-pointer"
                  >
                    {isSeeding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlusCircle className="h-3.5 w-3.5" />}
                    Seed {excelPreviewYears.length} Year(s) from {excelFileName || 'file'}
                  </button>
                  <button
                    type="button"
                    onClick={handleClearExcelPreview}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border bg-white hover:bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-400 dark:border-slate-700 cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className={`text-[11px] font-bold flex items-center gap-1 text-slate-500 dark:text-slate-400`}>
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
                className={`px-2.5 py-1 rounded-lg text-xs font-mono font-semibold border transition-all cursor-pointer bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700`}
              >
                + Seed {y} BS
              </button>
            ))}
          </div>
        </form>

        {seedStatus.message && (
          <div
            className={`p-3 rounded-xl border text-xs font-medium flex items-center gap-2 ${seedStatus.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/60 dark:border-emerald-500/40 dark:text-emerald-300' : 'bg-rose-50 border-rose-200 text-rose-800 dark:bg-rose-950/60 dark:border-rose-500/40 dark:text-rose-300'}`}
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
      <div className={`rounded-2xl border p-5 shadow-xl space-y-4 bg-white border-slate-200 shadow-2xs dark:bg-[#0f1218] dark:border-slate-800`}>
        <div className={`flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b pb-3 border-slate-200 dark:border-slate-800`}>
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl border bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20`}>
              <Sliders className="h-5 w-5" />
            </div>
            <div>
              <h3 className={`font-bold text-base text-slate-900 dark:text-white`}>
                Existing BS Calendar Years & Month Days Array Manager
              </h3>
              <p className={`text-xs text-slate-500 dark:text-slate-400`}>
                Inspect & edit 12-month day count arrays (<code className="text-amber-700 font-mono dark:text-amber-300 dark:font-mono">[Baisakh..Chaitra]</code>).
              </p>
            </div>
          </div>
        </div>

        {/* Table of Displayed BS Years */}
        <div className={`overflow-x-auto rounded-xl border border-slate-200 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-900/40`}>
          <table className="w-full text-left text-xs font-mono">
            <thead className={`font-bold border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800`}>
              <tr>
                <th className="px-2.5 py-1.5">BS Year</th>
                <th className="px-2.5 py-1.5">Baisakh 1 AD Start</th>
                <th className="px-2.5 py-1.5">Total Days</th>
                <th className="px-2.5 py-1.5">12 Month Days Array [Baisakh → Chaitra]</th>
                <th className="px-2.5 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-200 text-slate-700 dark:divide-slate-800 dark:text-slate-300`}>
              {yearsPagination.pagedItems.map((y) => {
                const totalDays = y.daysInMonths.reduce((a, b) => a + b, 0);
                return (
                  <tr key={y.yearBS} className={`transition-colors hover:bg-white dark:hover:bg-slate-800/50`}>
                    <td className="p-2.5 font-bold text-amber-500 dark:text-amber-400 text-sm whitespace-nowrap">
                      {y.yearBS} BS
                    </td>
                    <td className="p-2.5 font-semibold whitespace-nowrap">
                      {y.startAD}
                    </td>
                    <td className="p-2.5 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${totalDays === 365 ? 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800' : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800'}`}>
                        {totalDays} Days
                      </span>
                    </td>
                    <td className="p-2.5">
                      <div className="flex items-center gap-1 flex-wrap">
                        {y.daysInMonths.map((d, idx) => (
                          <span
                            key={idx}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border bg-white border-slate-200 text-slate-800 dark:bg-slate-950 dark:border-slate-800 dark:text-slate-300`}
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
        <TablePagination
          page={yearsPagination.page}
          pageCount={yearsPagination.pageCount}
          totalItems={yearsPagination.totalItems}
          rangeStart={yearsPagination.rangeStart}
          rangeEnd={yearsPagination.rangeEnd}
          pageSize={yearsPagination.pageSize}
          onPageChange={yearsPagination.setPage}
          onPageSizeChange={yearsPagination.setPageSize}
          hidePageSize
        />
      </div>

      {/* Edit BS Year Modal */}
      {editingYearData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className={`w-full max-w-2xl rounded-2xl border p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto bg-white border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}>
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
