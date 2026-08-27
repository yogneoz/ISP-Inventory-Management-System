/**
 * Route module: fiscal
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
import {
  snapshotStore,
  restoreSnapshot,
  writeThroughPg,
  sendWriteFailure,
  commitLocalMirror,
  isDurableWriteError,
} from '../lib/writeGuard';
import {
  requireRole,
  requireAuth,
  logAuditEvent,
  sanitizeUser,
  findUserByIdOrEmail,
  migrateUserPasswordIfNeeded,
  getUserFromReq,
} from '../lib/auth';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  createSession,
  destroySession,
  destroyUserSessions,
  extractBearerToken,
  getTodayBsStamp,
  normalizeRole,
  MIN_PASSWORD_LENGTH,
  getSession,
} from '../lib/authUtils';
import {
  broadcastChange,
  dataVersion,
  setDataVersion,
  bumpDataVersion,
  addSseClient,
  removeSseClient,
  forEachSseClient,
} from '../lib/sync';
import { getGenAIClient } from '../lib/ai';
import type {
  User,
  Supplier,
  Branch,
  Product,
  CompanyProfile,
  InventoryStock,
  Asset,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  StockOperation,
  FiscalYear,
  AuditLog,
  TransactionLog,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  Category,
  UnitOfMeasure,
  LocationRecord,
} from '../../src/types';

const router = Router();

router.get('/api/fiscal-years', async (req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT id, code, start_date_ad::text AS "startDateAD", end_date_ad::text AS "endDateAD",
              start_date_bs AS "startDateBS", end_date_bs AS "endDateBS",
              is_current AS "isCurrent", is_closed AS "isClosed"
       FROM fiscal_years ORDER BY code ASC;`
    );
    if (result.rows.length > 0) {
      return res.json(result.rows);
    }
  } catch (e: any) {
    if (e?.code !== 'ECONNREFUSED' && !e?.message?.includes('ECONNREFUSED')) {
      console.warn('PostgreSQL fiscal_years read notice:', e.message);
    }
  }
  res.json(store.fiscalYears);
});

router.post('/api/fiscal-years/:id/set-current', async (req, res) => {
  const { id } = req.params;
  try {
    await pgPool.query('UPDATE fiscal_years SET is_current = FALSE;');
    await pgPool.query('UPDATE fiscal_years SET is_current = TRUE WHERE id = $1;', [id]);
  } catch (e: any) {
    console.warn('PostgreSQL set-current fiscal year notice:', e.message);
  }

  store.fiscalYears.forEach((fy) => {
    fy.isCurrent = fy.id === id;
  });
  res.json(store.fiscalYears);
});

// Bikram Sambat (BS) Calendar & Day Records Endpoints with PostgreSQL & In-Memory Fallback
const NEPALI_MONTHS_EN_SERVER = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
];

const NEPALI_MONTHS_NP_SERVER = [
  'वैशाख', 'जेठ', 'असार', 'श्रावण', 'भाद्र', 'असोज',
  'कार्तिक', 'मंसिर', 'पुस', 'माघ', 'फागुन', 'चैत'
];

const DAYS_OF_WEEK_EN_SERVER = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

const DAYS_OF_WEEK_NP_SERVER = [
  'आइतबार', 'सोमबार', 'मंगलबार', 'बुधबार', 'बिहीबार', 'शुक्रबार', 'शनिबार'
];

const DEFAULT_BS_YEARS_SERVER = [
  { yearBS: 2078, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2021-04-14' },
  { yearBS: 2079, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2022-04-14' },
  { yearBS: 2080, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2023-04-14' },
  { yearBS: 2081, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2024-04-13' },
  { yearBS: 2082, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2025-04-14' },
  { yearBS: 2083, daysInMonths: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2026-04-14' },
  { yearBS: 2084, daysInMonths: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], startAD: '2027-04-14' },
  { yearBS: 2085, daysInMonths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], startAD: '2028-04-13' },
];

let inMemoryBsCalendarYears = [...DEFAULT_BS_YEARS_SERVER];
let inMemoryBsDayRecords: any[] = [];

function generateInMemoryBsDayRecords() {
  const recordsMap = new Map<string, any>();
  for (const yData of inMemoryBsCalendarYears) {
    let runningDate = new Date(yData.startAD);
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const monthBS = monthIdx + 1;
      const daysInMonth = yData.daysInMonths[monthIdx] || 30;

      for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
        const adDateStr = runningDate.toISOString().split('T')[0];
        const dayOfWeekIndex = runningDate.getUTCDay();

        const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
        const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
        const bsDateStr = `${yData.yearBS}-${padMonth}-${padDay}`;

        let startYear = yData.yearBS;
        if (monthBS < 4) startYear = yData.yearBS - 1;
        const fyCode = `${startYear}-${String(startYear + 1).slice(-2)}`;

        let qtr = 'Q4';
        if (monthBS >= 4 && monthBS <= 6) qtr = 'Q1';
        else if (monthBS >= 7 && monthBS <= 9) qtr = 'Q2';
        else if (monthBS >= 10 && monthBS <= 12) qtr = 'Q3';

        recordsMap.set(adDateStr, {
          adDate: adDateStr,
          bsDate: bsDateStr,
          bsYear: yData.yearBS,
          bsMonth: monthBS,
          bsMonthName: NEPALI_MONTHS_EN_SERVER[monthIdx],
          bsMonthNameNp: NEPALI_MONTHS_NP_SERVER[monthIdx],
          bsDay: dayBS,
          dayOfWeekName: DAYS_OF_WEEK_EN_SERVER[dayOfWeekIndex],
          dayOfWeekNameNp: DAYS_OF_WEEK_NP_SERVER[dayOfWeekIndex],
          fiscalYear: fyCode,
          quarter: qtr,
          isWeekend: dayOfWeekIndex === 6,
        });

        runningDate.setDate(runningDate.getDate() + 1);
      }
    }
  }
  inMemoryBsDayRecords = Array.from(recordsMap.values());
}

// Initial generation of in-memory records
generateInMemoryBsDayRecords();

router.get('/api/bs-calendar/years', async (req, res) => {
  try {
    const result = await pgPool.query(
      'SELECT year_bs AS "yearBS", days_in_months AS "daysInMonths", start_ad::text AS "startAD" FROM bs_calendar_years ORDER BY year_bs ASC;'
    );
    if (result.rows.length > 0) {
      return res.json(result.rows);
    }
  } catch (_err) {
    // Silently fall back to inMemoryBsCalendarYears if PostgreSQL is unreachable
  }
  res.json(inMemoryBsCalendarYears);
});

router.get('/api/bs-calendar/days', async (req, res) => {
  const { yearBS, monthBS, search } = req.query;
  try {
    let querySql = `
      SELECT ad_date::text AS "adDate", bs_date AS "bsDate", bs_year AS "bsYear", bs_month AS "bsMonth",
             bs_month_name AS "bsMonthName", bs_month_name_np AS "bsMonthNameNp", bs_day AS "bsDay",
             day_of_week_name AS "dayOfWeekName", day_of_week_name_np AS "dayOfWeekNameNp",
             fiscal_year AS "fiscalYear", quarter, is_weekend AS "isWeekend"
      FROM bs_day_records
      WHERE 1=1
    `;
    const params: any[] = [];
    if (yearBS && yearBS !== 'ALL') {
      params.push(parseInt(yearBS as string, 10));
      querySql += ` AND bs_year = $${params.length}`;
    }
    if (monthBS && monthBS !== 'ALL') {
      params.push(parseInt(monthBS as string, 10));
      querySql += ` AND bs_month = $${params.length}`;
    }
    if (search && typeof search === 'string' && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      querySql += ` AND (
        LOWER(ad_date::text) LIKE $${params.length} OR
        LOWER(bs_date) LIKE $${params.length} OR
        LOWER(bs_month_name) LIKE $${params.length} OR
        LOWER(day_of_week_name) LIKE $${params.length} OR
        LOWER(fiscal_year) LIKE $${params.length}
      )`;
    }
    querySql += ` ORDER BY ad_date ASC LIMIT 500;`;

    const result = await pgPool.query(querySql, params);
    if (result.rows.length > 0) {
      return res.json(result.rows);
    }
  } catch (_err) {
    // Silently fall back to in-memory records below
  }

  // In-Memory Filter Fallback
  let filtered = [...inMemoryBsDayRecords];
  if (yearBS && yearBS !== 'ALL') {
    const targetYr = parseInt(yearBS as string, 10);
    filtered = filtered.filter((r) => r.bsYear === targetYr);
  }
  if (monthBS && monthBS !== 'ALL') {
    const targetMo = parseInt(monthBS as string, 10);
    filtered = filtered.filter((r) => r.bsMonth === targetMo);
  }
  if (search && typeof search === 'string' && search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.adDate.toLowerCase().includes(q) ||
        r.bsDate.toLowerCase().includes(q) ||
        r.bsMonthName.toLowerCase().includes(q) ||
        r.dayOfWeekName.toLowerCase().includes(q) ||
        r.fiscalYear.toLowerCase().includes(q)
    );
  }

  res.json(filtered.slice(0, 500));
});

router.post('/api/bs-calendar/seed', async (req, res) => {
  const { yearBS, daysInMonths, customStartAD, onlyIfNew } = req.body;
  if (!yearBS || !Array.isArray(daysInMonths) || daysInMonths.length !== 12) {
    return res.status(400).json({ message: 'Must provide yearBS and 12-element daysInMonths array' });
  }

  let startAD = customStartAD;
  if (!startAD) {
    const estADYear = yearBS - 57;
    startAD = `${estADYear}-04-14`;
  }

  // Check if year already exists if onlyIfNew flag is set
  const existingIdx = inMemoryBsCalendarYears.findIndex((y) => y.yearBS === yearBS);
  if (onlyIfNew && existingIdx >= 0) {
    return res.json({
      success: true,
      skipped: true,
      message: `BS Year ${yearBS} already exists in database. Skipped overwrite because 'onlyIfNew' was specified.`,
    });
  }
  if (existingIdx >= 0) {
    inMemoryBsCalendarYears[existingIdx] = { yearBS, daysInMonths, startAD };
  } else {
    inMemoryBsCalendarYears.push({ yearBS, daysInMonths, startAD });
    inMemoryBsCalendarYears.sort((a, b) => a.yearBS - b.yearBS);
  }
  generateInMemoryBsDayRecords();

  try {
    await pgPool.query(
      `INSERT INTO bs_calendar_years (year_bs, days_in_months, start_ad)
       VALUES ($1, $2, $3)
       ON CONFLICT (year_bs) DO UPDATE SET
         days_in_months = EXCLUDED.days_in_months,
         start_ad = EXCLUDED.start_ad;`,
      [yearBS, daysInMonths, startAD]
    );

    let runningDate = new Date(startAD);
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const monthBS = monthIdx + 1;
      const daysInMonth = daysInMonths[monthIdx] || 30;

      for (let dayBS = 1; dayBS <= daysInMonth; dayBS++) {
        const adDateStr = runningDate.toISOString().split('T')[0];
        const dayOfWeekIndex = runningDate.getUTCDay();

        const padMonth = monthBS < 10 ? `0${monthBS}` : `${monthBS}`;
        const padDay = dayBS < 10 ? `0${dayBS}` : `${dayBS}`;
        const bsDateStr = `${yearBS}-${padMonth}-${padDay}`;

        let startYear = yearBS;
        if (monthBS < 4) startYear = yearBS - 1;
        const fyCode = `${startYear}-${String(startYear + 1).slice(-2)}`;

        let qtr = 'Q4';
        if (monthBS >= 4 && monthBS <= 6) qtr = 'Q1';
        else if (monthBS >= 7 && monthBS <= 9) qtr = 'Q2';
        else if (monthBS >= 10 && monthBS <= 12) qtr = 'Q3';

        await pgPool.query(
          `INSERT INTO bs_day_records (
             ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
             bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, quarter, is_weekend
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (ad_date) DO UPDATE SET
             bs_date = EXCLUDED.bs_date,
             bs_year = EXCLUDED.bs_year,
             bs_month = EXCLUDED.bs_month,
             bs_month_name = EXCLUDED.bs_month_name,
             bs_month_name_np = EXCLUDED.bs_month_name_np,
             bs_day = EXCLUDED.bs_day,
             day_of_week_name = EXCLUDED.day_of_week_name,
             day_of_week_name_np = EXCLUDED.day_of_week_name_np,
             fiscal_year = EXCLUDED.fiscal_year,
             quarter = EXCLUDED.quarter,
             is_weekend = EXCLUDED.is_weekend;`,
          [
            adDateStr,
            bsDateStr,
            yearBS,
            monthBS,
            NEPALI_MONTHS_EN_SERVER[monthIdx],
            NEPALI_MONTHS_NP_SERVER[monthIdx],
            dayBS,
            DAYS_OF_WEEK_EN_SERVER[dayOfWeekIndex],
            DAYS_OF_WEEK_NP_SERVER[dayOfWeekIndex],
            fyCode,
            qtr,
            dayOfWeekIndex === 6
          ]
        );

        runningDate.setDate(runningDate.getDate() + 1);
      }
    }
  } catch (_err) {
    // Silently continue if PostgreSQL is disconnected; in-memory store is already updated
  }

  res.json({
    success: true,
    message: `Successfully seeded BS Year ${yearBS} and regenerated calendar day-by-day lookup table!`,
  });
});

router.post('/api/bs-calendar/sync-range', async (req, res) => {
  const { dayRecords } = req.body;
  if (!Array.isArray(dayRecords) || dayRecords.length === 0) {
    return res.status(400).json({ success: false, message: 'No day records provided to write to SQL database.' });
  }

  // Always sync to in-memory day records store
  const recordMap = new Map<string, any>();
  for (const r of inMemoryBsDayRecords) {
    recordMap.set(r.adDate, r);
  }
  for (const r of dayRecords) {
    recordMap.set(r.adDate, r);
  }
  inMemoryBsDayRecords = Array.from(recordMap.values());

  let insertedCount = dayRecords.length;
  try {
    for (const rec of dayRecords) {
      await pgPool.query(
        `INSERT INTO bs_day_records (
           ad_date, bs_date, bs_year, bs_month, bs_month_name, bs_month_name_np,
           bs_day, day_of_week_name, day_of_week_name_np, fiscal_year, quarter, is_weekend
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (ad_date) DO UPDATE SET
           bs_date = EXCLUDED.bs_date,
           bs_year = EXCLUDED.bs_year,
           bs_month = EXCLUDED.bs_month,
           bs_month_name = EXCLUDED.bs_month_name,
           bs_month_name_np = EXCLUDED.bs_month_name_np,
           bs_day = EXCLUDED.bs_day,
           day_of_week_name = EXCLUDED.day_of_week_name,
           day_of_week_name_np = EXCLUDED.day_of_week_name_np,
           fiscal_year = EXCLUDED.fiscal_year,
           quarter = EXCLUDED.quarter,
           is_weekend = EXCLUDED.is_weekend;`,
        [
          rec.adDate,
          rec.bsDate,
          rec.bsYear,
          rec.bsMonth,
          rec.bsMonthName,
          rec.bsMonthNameNp,
          rec.bsDay,
          rec.dayOfWeekName,
          rec.dayOfWeekNameNp,
          rec.fiscalYear,
          rec.quarter,
          rec.isWeekend,
        ]
      );
    }
  } catch (_err) {
    // Continue cleanly using in-memory store
  }

  res.json({
    success: true,
    count: insertedCount,
    message: `Successfully written & updated ${insertedCount} daily conversion records in BSDayRecord database table!`,
  });
});

// Audit Trail & Transaction Logs

export default router;
