/**
 * Admin routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerAdminRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { post_clearDemoData, get_companyProfile, put_companyProfile, get_branches, post_branches, put_Id, delete_Id, get_users, post_users, put_Id2, delete_Id2, post_resetPassword, post_fixedAssets, post_liveStock, post_bsDayRecords, post_fiscalYearLinks, get_documentNumberConfigs, put_Id3, put_documentNumberConfigs, post_generateNext, post_resetCounter, get_fiscalYears, post_fiscalYears, post_setCurrent, put_Id4, post_close, post_reopen, post_initializeOpeningStock, delete_Id3, get_years, get_day, get_days, post_seed, post_seedBulk, put_YearBS, post_syncRange, get_companyProfile2, put_companyProfile2 } from '../controllers/admin.controller';
import {
  assetRegister,
  branches,
  broadcastChange,
  buildBsDayRecordsForYear,
  categories,
  companyProfile,
  docNumberConfigs,
  findBsDayRecordForAdDate,
  fiscalYears,
  generateInMemoryBsDayRecords,
  getDataVersion,
  getPgConnected,
  getUserFromReq,
  hashPassword,
  inMemoryBsCalendarYears,
  inMemoryBsDayRecords,
  inventoryStock,
  logAuditEvent,
  products,
  requirePermission,
  requireRole,
  setBranches,
  setCompanyProfile,
  setDataVersion,
  setDocNumberConfigs,
  setFiscalYears,
  setInMemoryBsCalendarYears,
  setInMemoryBsDayRecords,
  setUsers,
  shipments,
  sseClients,
  suppliers,
  transactionLogs,
  users,
  validateRole,
  verifySuperAdminCredentials,
  withAppended,
  withReplaced,
  withSorted,
  withTransaction,
} from '../app';
import { DAYS_OF_WEEK_EN_SERVER, DAYS_OF_WEEK_NP_SERVER, NEPALI_MONTHS_EN_SERVER, NEPALI_MONTHS_NP_SERVER, hydrateOperationalData, pgPool } from '../app';
import { calculateFixedAssetValues } from '../../../client/src/utils/depreciation';
import type { Asset, Branch, DocumentNumberConfig } from '../../../client/src/types';

export function registerAdminRoutes(app: Express) {
app.post('/api/admin/clear-demo-data', async (req, res, next) => { post_clearDemoData(req as any, res as any).catch(next); });

app.get('/api/company-profile', async (req, res, next) => { get_companyProfile(req as any, res as any).catch(next); });

app.put('/api/company-profile', async (req, res, next) => { put_companyProfile(req as any, res as any).catch(next); });

app.get('/api/branches', async (req, res, next) => { get_branches(req as any, res as any).catch(next); });

app.post('/api/branches', requirePermission('admin-branches'), async (req, res, next) => { post_branches(req as any, res as any).catch(next); });

app.put('/api/branches/:id', requirePermission('admin-branches'), async (req, res, next) => { put_Id(req as any, res as any).catch(next); });

app.delete('/api/branches/:id', requirePermission('admin-branches'), async (req, res, next) => { delete_Id(req as any, res as any).catch(next); });

app.get('/api/users', async (req, res, next) => { get_users(req as any, res as any).catch(next); });

app.post('/api/users', requirePermission('admin-users'), async (req, res, next) => { post_users(req as any, res as any).catch(next); });

app.put('/api/users/:id', requirePermission('admin-users'), async (req, res, next) => { put_Id2(req as any, res as any).catch(next); });

app.delete('/api/users/:id', requirePermission('admin-users'), async (req, res, next) => { delete_Id2(req as any, res as any).catch(next); });

app.post('/api/users/:id/reset-password', async (req, res, next) => { post_resetPassword(req as any, res as any).catch(next); });

app.post('/api/admin/recalculate/fixed-assets', requireRole('SUPER_ADMIN'), async (req, res, next) => { post_fixedAssets(req as any, res as any).catch(next); });

app.post('/api/admin/recalculate/live-stock', requireRole('SUPER_ADMIN'), async (req, res, next) => { post_liveStock(req as any, res as any).catch(next); });

app.post('/api/admin/recalculate/bs-day-records', requireRole('SUPER_ADMIN'), async (req, res, next) => { post_bsDayRecords(req as any, res as any).catch(next); });

app.post('/api/admin/repair/fiscal-year-links', requireRole('SUPER_ADMIN'), async (req, res, next) => { post_fiscalYearLinks(req as any, res as any).catch(next); });

app.get('/api/document-number-configs', async (req, res, next) => { get_documentNumberConfigs(req as any, res as any).catch(next); });

app.put('/api/document-number-configs/:id', async (req, res, next) => { put_Id3(req as any, res as any).catch(next); });

app.put('/api/document-number-configs', async (req, res, next) => { put_documentNumberConfigs(req as any, res as any).catch(next); });

app.post('/api/document-number-configs/generate-next', requirePermission('admin-fiscal'), async (req, res, next) => { post_generateNext(req as any, res as any).catch(next); });

app.post('/api/document-number-configs/reset-counter', requirePermission('admin-fiscal'), async (req, res, next) => { post_resetCounter(req as any, res as any).catch(next); });

app.get('/api/fiscal-years', async (req, res, next) => { get_fiscalYears(req as any, res as any).catch(next); });

app.post('/api/fiscal-years', requireRole('SUPER_ADMIN'), requirePermission('admin-fiscal'), async (req, res, next) => { post_fiscalYears(req as any, res as any).catch(next); });

app.post('/api/fiscal-years/:id/set-current', requireRole('SUPER_ADMIN'), async (req, res, next) => { post_setCurrent(req as any, res as any).catch(next); });

app.put('/api/fiscal-years/:id', requireRole('SUPER_ADMIN'), requirePermission('admin-fiscal'), async (req, res, next) => { put_Id4(req as any, res as any).catch(next); });

app.post('/api/fiscal-years/:id/close', requireRole('SUPER_ADMIN'), async (req, res, next) => { post_close(req as any, res as any).catch(next); });

app.post('/api/fiscal-years/:id/reopen', requireRole('SUPER_ADMIN'), async (req, res, next) => { post_reopen(req as any, res as any).catch(next); });

app.post('/api/fiscal-years/:id/initialize-opening-stock', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER'), async (req, res, next) => { post_initializeOpeningStock(req as any, res as any).catch(next); });

app.delete('/api/fiscal-years/:id', requireRole('SUPER_ADMIN'), requirePermission('admin-fiscal'), async (req, res, next) => { delete_Id3(req as any, res as any).catch(next); });

app.get('/api/bs-calendar/years', async (req, res, next) => { get_years(req as any, res as any).catch(next); });

app.get('/api/bs-calendar/day', async (req, res, next) => { get_day(req as any, res as any).catch(next); });

app.get('/api/bs-calendar/days', async (req, res, next) => { get_days(req as any, res as any).catch(next); });

app.post('/api/bs-calendar/seed', async (req, res, next) => { post_seed(req as any, res as any).catch(next); });

app.post('/api/bs-calendar/seed-bulk', async (req, res, next) => { post_seedBulk(req as any, res as any).catch(next); });

app.put('/api/bs-calendar/years/:yearBS', async (req, res, next) => { put_YearBS(req as any, res as any).catch(next); });

app.post('/api/bs-calendar/sync-range', async (req, res, next) => { post_syncRange(req as any, res as any).catch(next); });

app.get('/api/company-profile', async (req, res, next) => { get_companyProfile2(req as any, res as any).catch(next); });

app.put('/api/company-profile', async (req, res, next) => { put_companyProfile2(req as any, res as any).catch(next); });

}
