/**
 * Admin controller — HTTP orchestration for the admin domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { pgPool, hydrateOperationalData, setDataVersion, getDataVersion, sseClients, users, getPgConnected, setCompanyProfile, companyProfile, logAuditEvent, branches, setBranches, withReplaced, withAppended, validateRole, hashPassword, setUsers, assetRegister, transactionLogs, inventoryStock, inMemoryBsCalendarYears, withTransaction, buildBsDayRecordsForYear, setInMemoryBsCalendarYears, generateInMemoryBsDayRecords, inMemoryBsDayRecords, setDocNumberConfigs, docNumberConfigs, fiscalYears, setFiscalYears, withSorted, verifySuperAdminCredentials, getUserFromReq, findBsDayRecordForAdDate, NEPALI_MONTHS_EN_SERVER, NEPALI_MONTHS_NP_SERVER, DAYS_OF_WEEK_EN_SERVER, DAYS_OF_WEEK_NP_SERVER, setInMemoryBsDayRecords, broadcastChange } from '../app';
import { Branch, Asset, DocumentNumberConfig, CompanyProfile, FiscalYear, User } from '../../../client/src/types';
import { calculateFixedAssetValues } from '../../../client/src/utils/depreciation';
import {
  DEMO_DATA_TABLES,
  demoDataDeleteSql,
  COMPANY_PROFILE_SELECT_SQL,
  COMPANY_PROFILE_UPSERT_SQL,
  companyProfileUpsertParams,
  COMPANY_PROFILE_UPSERT_NO_STAMP_SQL,
  companyProfileUpsertNoStampParams,
  BRANCH_SELECT_SQL,
  BRANCH_UPSERT_SQL,
  branchUpsertParams,
  BRANCH_UPDATE_SQL,
  branchUpdateParams,
  BRANCH_DELETE_SQL,
  USER_SELECT_SQL,
  USER_EXISTS_SQL,
  USER_UPSERT_SQL,
  userUpsertParams,
  USER_UPDATE_SQL,
  userUpdateParams,
  USER_DELETE_SQL,
  USER_RESET_PASSWORD_SQL,
  ASSET_RECALC_SELECT_SQL,
  ASSET_RECALC_UPDATE_SQL,
  LIVE_STOCK_RECALC_SQL,
  BS_CALENDAR_YEARS_SELECT_SQL,
  BS_CALENDAR_YEAR_UPSERT_SQL,
  BS_CALENDAR_YEAR_SET_START_SQL,
  BS_DAY_RECORDS_DELETE_BY_YEARS_SQL,
  BS_DAY_RECORD_UPSERT_SQL,
  BS_DAY_RECORD_UPSERT_WITH_FY_SQL,
  bsDayRecordParams,
  buildBsDayRecordsQuery,
  COLUMN_EXISTS_SQL,
  FISCAL_YEAR_LINK_TARGETS,
  buildFiscalYearLinkRepairSql,
  DOC_NUMBER_CONFIGS_SELECT_SQL,
  DOC_NUMBER_CONFIG_BY_ID_SQL,
  DOC_NUMBER_CONFIG_UPDATE_SQL,
  DOC_NUMBER_CONFIG_UPSERT_SQL,
  docNumberConfigUpsertParams,
  DOC_NUMBER_CONFIG_INCREMENT_SQL,
  FY_LIST_SQL,
  FY_OVERLAP_CHECK_SQL,
  FY_INSERT_SQL,
  fiscalYearInsertParams,
  FY_SET_CURRENT_CLEAR_SQL,
  FY_SET_CURRENT_SQL,
  FY_UPDATE_SQL,
  FY_CLOSE_SQL,
  FY_END_DATE_SQL,
  FY_REOPEN_SQL,
  FY_FIND_FOR_INIT_SQL,
  FY_NEXT_AFTER_SQL,
  FY_FIND_FOR_DELETE_SQL,
  FY_DELETE_SQL,
  FY_OPENING_STOCK_COUNTS_SQL,
  FY_OPENING_STOCK_INIT_SQL,
  fiscalYearOpeningStockInitParams,
  FY_REFERENCE_TABLES,
  fiscalYearReferenceCountSql,
} from '../models/admin.repo';
/** Forwarded from admin.routes.ts (post_clearDemoData). */
export async function post_clearDemoData(req: any, res: Response): Promise<any> {
try {
    const removed: Record<string, number> = {};
    for (const table of DEMO_DATA_TABLES) {
      const result = await pgPool.query(demoDataDeleteSql(table));
      removed[table] = result.rowCount || 0;
    }

    // Re-hydrate the runtime caches so memory matches the database again.
    const client = await pgPool.connect();
    try {
      await hydrateOperationalData(client);
    } finally {
      client.release();
    }

    setDataVersion(getDataVersion() + 1);
    sseClients.forEach((client) => {
      try {
        client.write(`data: ${JSON.stringify({ type: 'DEMO_DATA_CLEARED', dataVersion: getDataVersion(), timestamp: new Date().toISOString() })}\n\n`);
      } catch (_e) {}
    });

    const totalRemoved = Object.values(removed).reduce((a, b) => a + b, 0);
    return res.json({
      message: `Demo data only removed (${totalRemoved} rows where is_demo = TRUE). Real data, users, and branches are intact.`,
      removedRows: removed,
      totalRemoved,
      userCount: users.length,
      superAdminCount: users.filter((u) => u.role === 'SUPER_ADMIN').length,
    });
  } catch (err: any) {
    console.error('Error clearing demo data:', err);
    res.status(500).json({ message: 'Failed to clear demo data: ' + (err?.message || err) });
    return;
  }

}

/** Forwarded from admin.routes.ts (get_companyProfile). */
export async function get_companyProfile(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const r = await pgPool.query(COMPANY_PROFILE_SELECT_SQL);
      if (r.rows.length > 0) {
        setCompanyProfile(r.rows[0]);
        res.json(r.rows[0]);
        return;
      }
    } catch (err) {
      console.error('Error fetching company profile from DB:', err);
    }
  }
  res.json(companyProfile);

}

/** Forwarded from admin.routes.ts (put_companyProfile). */
export async function put_companyProfile(req: any, res: Response): Promise<any> {
try {
    setCompanyProfile({ ...companyProfile, ...req.body });
    if (!companyProfile.id) companyProfile.id = 'COMP-001';

    if (getPgConnected()) {
      await pgPool.query(COMPANY_PROFILE_UPSERT_SQL, companyProfileUpsertParams(companyProfile as CompanyProfile));
    }
    logAuditEvent(req, 'UPDATE_COMPANY_PROFILE', 'MASTER_DATA', `Updated Company Master Details: ${companyProfile.name}`);
    setDataVersion(getDataVersion() + 1);
    res.json(companyProfile);
  } catch (err: any) {
    console.error('Error updating company profile:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (get_branches). */
export async function get_branches(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const r = await pgPool.query(BRANCH_SELECT_SQL);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error querying branches from DB:', err);
    }
  }
  res.json(branches);

}

/** Forwarded from admin.routes.ts (post_branches). */
export async function post_branches(req: any, res: Response): Promise<any> {
try {
    const newBranch: Branch = {
      id: req.body.id || `br-${Date.now()}`,
      code: req.body.code || `BR-${Math.floor(100 + Math.random() * 900)}`,
      name: req.body.name || 'New Branch',
      location: req.body.location || 'Nepal',
      phone: req.body.phone || '',
      isHeadquarters: Boolean(req.body.isHeadquarters),
      active: req.body.active !== false,
      allowProcurement: req.body.allowProcurement !== false,
      allowWarehouseTransfer: req.body.allowWarehouseTransfer !== false,
    };
    const idx = branches.findIndex((b) => b.id === newBranch.id);
    setBranches(idx >= 0 ? withReplaced(branches, idx, newBranch) : withAppended(branches, newBranch));

    if (getPgConnected()) {
      await pgPool.query(BRANCH_UPSERT_SQL, branchUpsertParams(newBranch as Branch));
    }
    logAuditEvent(req, 'CREATE_BRANCH', 'MASTER_DATA', `Created new branch ${newBranch.name} (${newBranch.code || newBranch.id})`);
    res.status(201).json(newBranch);
  } catch (err: any) {
    console.error('Error creating branch:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (put_Id). */
export async function put_Id(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = branches.findIndex((b) => b.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Branch not found' });
    setBranches(withReplaced(branches, idx, { ...branches[idx], ...req.body }));
    const b = branches[idx];

    if (getPgConnected()) {
      await pgPool.query(BRANCH_UPDATE_SQL, branchUpdateParams({ ...branches[idx], ...req.body, id }));
    }
    logAuditEvent(req, 'UPDATE_BRANCH', 'MASTER_DATA', `Updated branch details for ${b.name} (${b.id})`);
    res.json(b);
  } catch (err: any) {
    console.error('Error updating branch:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (delete_Id). */
export async function delete_Id(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const br = branches.find((b) => b.id === id);
    setBranches(branches.filter((b) => b.id !== id));

    if (getPgConnected()) {
      await pgPool.query(BRANCH_DELETE_SQL, [id]);
    }
    logAuditEvent(req, 'DELETE_BRANCH', 'MASTER_DATA', `Deleted branch ${br?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting branch:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (get_users). */
export async function get_users(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const r = await pgPool.query(USER_SELECT_SQL);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching users from DB:', err);
    }
  }
  const safeUsers = users.map(({ password: _, ...u }) => u);
  res.json(safeUsers);

}

/** Forwarded from admin.routes.ts (post_users). */
export async function post_users(req: any, res: Response): Promise<any> {
try {
    const role = validateRole(req.body.role);
    const newUser = {
      id: req.body.id || `usr-${Date.now()}`,
      ...req.body,
      role,
      password: hashPassword(String(req.body.password || 'password@123')),
    };
    const idx = users.findIndex((u) => u.id === newUser.id || u.email === newUser.email);
    setUsers(idx >= 0 ? withReplaced(users, idx, newUser) : withAppended(users, newUser));

    if (getPgConnected()) {
      await pgPool.query(USER_UPSERT_SQL, userUpsertParams(newUser as User));
    }
    logAuditEvent(req, 'CREATE_USER', 'AUTH', `Created new user account ${newUser.name} (${newUser.email}) - Role: ${newUser.role}`);
    const { password: _, ...userWithoutPass } = newUser;
    res.status(201).json(userWithoutPass);
  } catch (err: any) {
    console.error('Error creating user:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (put_Id2). */
export async function put_Id2(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    let idx = users.findIndex((u) => u.id === id);

    if (idx === -1 && getPgConnected()) {
      const r = await pgPool.query(USER_EXISTS_SQL, [id]);
      if (r.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    }

    const existingRole = (users[idx] || {}).role || 'FRONT_DESK';
    const role = req.body.role !== undefined ? validateRole(req.body.role) : existingRole;
    const updatedUser = {
      ...(users[idx] || {}),
      ...req.body,
      role,
      id,
    };
    if (req.body.password) updatedUser.password = hashPassword(String(req.body.password));
    if (idx !== -1) setUsers(withReplaced(users, idx, updatedUser));

    if (getPgConnected()) {
      await pgPool.query(USER_UPDATE_SQL, userUpdateParams(updatedUser as User, req.body.password ? updatedUser.password : null));
    }
    logAuditEvent(req, 'UPDATE_USER', 'AUTH', `Updated user account ${updatedUser.name} (${updatedUser.email})`);
    const { password: _, ...userWithoutPass } = updatedUser;
    res.json(userWithoutPass);
  } catch (err: any) {
    console.error('Error updating user:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (delete_Id2). */
export async function delete_Id2(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = users.findIndex((u) => u.id === id);
    let deletedEmail = '';
    let deletedName = '';

    if (idx !== -1) {
      deletedEmail = users[idx].email;
      deletedName = users[idx].name;
      setUsers(users.filter((_, i) => i !== idx));
    }

    if (getPgConnected()) {
      const r = await pgPool.query(USER_DELETE_SQL, [id]);
      if (r.rows.length > 0) {
        deletedEmail = r.rows[0].email;
        deletedName = r.rows[0].name;
      }
    }
    logAuditEvent(req, 'DELETE_USER', 'AUTH', `Deleted user account ${deletedName || id} (${deletedEmail || id})`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting user:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (post_resetPassword). */
export async function post_resetPassword(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const userIdx = users.findIndex((u) => u.id === id);

    if (!newPassword || newPassword.trim().length < 3) {
      res.status(400).json({ message: 'New password must be at least 3 characters long.' });
      return;
    }

    if (userIdx !== -1) {
      users[userIdx].password = hashPassword(newPassword.trim());
    }

    let targetEmail = users[userIdx]?.email || id;
    let targetName = users[userIdx]?.name || id;

    if (getPgConnected()) {
      const r = await pgPool.query(USER_RESET_PASSWORD_SQL, [hashPassword(newPassword.trim()), id]);
      if (r.rows.length > 0) {
        targetEmail = r.rows[0].email;
        targetName = r.rows[0].name;
      }
    }
    logAuditEvent(req, 'RESET_USER_PASSWORD', 'AUTH', `Password reset for user account ${targetName} (${targetEmail})`);

    const userWithoutPass = userIdx !== -1 ? (({ password, ...rest }) => rest)(users[userIdx]) : { id, email: targetEmail, name: targetName };
    res.json({
      success: true,
      message: `Password for ${targetName} (${targetEmail}) has been successfully updated.`,
      user: userWithoutPass,
    });
  } catch (err: any) {
    console.error('Error resetting user password:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (post_fixedAssets). */
export async function post_fixedAssets(req: any, res: Response): Promise<any> {
try {
    const asOfDateAD = new Date().toISOString().slice(0, 10);
    let assetsToUpdate = assetRegister;
    if (getPgConnected()) {
      const result = await pgPool.query(ASSET_RECALC_SELECT_SQL);
      assetsToUpdate = result.rows as Asset[];
    }

    for (const asset of assetsToUpdate) {
      const values = calculateFixedAssetValues({ ...asset, asOfDateAD });
      asset.accumulatedDepreciation = values.accumulatedDepreciation;
      asset.netBookValue = values.netBookValue;
      if (getPgConnected()) {
        await pgPool.query(ASSET_RECALC_UPDATE_SQL, [values.accumulatedDepreciation, values.netBookValue, asset.id]);
      }
    }
    logAuditEvent(req, 'RECALCULATE_FIXED_ASSETS', 'SYSTEM', `Recalculated ${assetsToUpdate.length} fixed asset record(s) as of ${asOfDateAD}.`);
    res.json({ updated: assetsToUpdate.length, message: `Recalculated ${assetsToUpdate.length} fixed asset record(s) as of ${asOfDateAD}.` });
  } catch (error: any) {
    console.error('Error recalculating fixed assets:', error);
    res.status(500).json({ message: `Unable to recalculate fixed assets: ${error.message}` });
  }

}

/** Forwarded from admin.routes.ts (post_liveStock). */
export async function post_liveStock(req: any, res: Response): Promise<any> {
try {
    const latestByStock = new Map<string, { quantityAfter: number; timestampAD: string }>();
    transactionLogs
      .filter((log) => log.changeType !== 'DAMAGE')
      .forEach((log) => {
        const key = `${log.productId}:${log.branchId}`;
        const previous = latestByStock.get(key);
        if (!previous || String(log.timestampAD) > previous.timestampAD) {
          latestByStock.set(key, { quantityAfter: Number(log.quantityAfter) || 0, timestampAD: String(log.timestampAD) });
        }
      });

    let updated = 0;
    if (getPgConnected()) {
      const result = await pgPool.query(LIVE_STOCK_RECALC_SQL);
      updated = result.rowCount || 0;
    } else {
      inventoryStock.forEach((stock) => {
        const latest = latestByStock.get(`${stock.productId}:${stock.branchId}`);
        if (latest) {
          stock.quantityOnHand = Math.max(0, latest.quantityAfter);
          stock.lastUpdated = new Date().toISOString();
          updated += 1;
        }
      });
    }
    logAuditEvent(req, 'RECALCULATE_LIVE_STOCK', 'SYSTEM', `Recalculated ${updated} live stock balance(s) from the latest non-damage transaction.`);
    res.json({ updated, message: `Recalculated ${updated} live stock balance(s) from transaction history.` });
  } catch (error: any) {
    console.error('Error recalculating live stock:', error);
    res.status(500).json({ message: `Unable to recalculate live stock: ${error.message}` });
  }

}

/** Forwarded from admin.routes.ts (post_bsDayRecords). */
export async function post_bsDayRecords(req: any, res: Response): Promise<any> {
try {
    let pgSynced = false;
    let regeneratedRecords = 0;
    let sourceYears = inMemoryBsCalendarYears;

    if (getPgConnected()) {
      const cfgRes = await pgPool.query(BS_CALENDAR_YEARS_SELECT_SQL);
      if (cfgRes.rows.length > 0) sourceYears = cfgRes.rows;

      await withTransaction(async (client) => {
        // Delete stale rows for every configured year, then rebuild from config.
        const yearList = sourceYears.map((y: any) => Number(y.yearBS));
        await client.query(BS_DAY_RECORDS_DELETE_BY_YEARS_SQL, [yearList]);

        let count = 0;
        for (const y of sourceYears) {
          const yearBS = Number(y.yearBS);
          const daysInMonths = Array.isArray(y.daysInMonths) && y.daysInMonths.length === 12
            ? y.daysInMonths
            : y.daysInMonths;
          const records = buildBsDayRecordsForYear(yearBS, daysInMonths, String(y.startAD));
          for (const rec of records) {
            await client.query(BS_DAY_RECORD_UPSERT_WITH_FY_SQL, bsDayRecordParams(rec));
          }
          count += records.length;
        }
        regeneratedRecords = count;
      });
      pgSynced = true;
    }

    // Refresh the in-memory fallback cache with the same config.
    const memMap = new Map<number, { yearBS: number; daysInMonths: number[]; startAD: string }>();
    for (const m of inMemoryBsCalendarYears) memMap.set(m.yearBS, m);
    setInMemoryBsCalendarYears(Array.from(memMap.values()).sort((a, b) => a.yearBS - b.yearBS));
    generateInMemoryBsDayRecords();
    if (regeneratedRecords === 0) {
      regeneratedRecords = inMemoryBsDayRecords.length;
    }

    logAuditEvent(req, 'RECALCULATE_BS_DAY_RECORDS', 'SYSTEM', `Regenerated ${regeneratedRecords} BS day-by-day lookup record(s) from configured calendar years.`);
    res.json({
      success: true,
      pgSynced,
      years: sourceYears.length,
      regeneratedRecords,
      message: pgSynced
        ? `Rebuilt ${regeneratedRecords} BS day-by-day lookup record(s) across ${sourceYears.length} configured year(s) from the calendar configuration.`
        : `Rebuilt ${regeneratedRecords} BS day-by-day lookup record(s) in the in-memory calendar only — PostgreSQL was unreachable.`,
    });
  } catch (error: any) {
    console.error('Error rebuilding BS day records:', error);
    res.status(500).json({ message: `Unable to rebuild BS day records: ${error.message}` });
  }

}

/** Forwarded from admin.routes.ts (post_fiscalYearLinks). */
export async function post_fiscalYearLinks(req: any, res: Response): Promise<any> {
try {
    if (!getPgConnected()) {
      res.status(503).json({ message: 'PostgreSQL is required for fiscal-year link repair.' });
      return;
    }

    const results: Record<string, number> = {};
    let totalFixed = 0;

    await withTransaction(async (client) => {
      for (const entry of FISCAL_YEAR_LINK_TARGETS) {
        // Only attempt when the column exists (older schemas may not have it).
        const colCheck = await client.query(COLUMN_EXISTS_SQL, [entry.table, entry.column]);
        if (colCheck.rowCount === 0) {
          results[entry.table] = 0;
          continue;
        }

        const result = await client.query(buildFiscalYearLinkRepairSql(entry));
        results[entry.table] = result.rowCount || 0;
        totalFixed += results[entry.table];
      }
    });

    logAuditEvent(
      req,
      'REPAIR_FISCAL_YEAR_LINKS',
      'FISCAL_YEAR',
      `Repaired fiscal-year links: ${totalFixed} row(s) re-linked across ${Object.values(results).filter((n) => n > 0).length} table(s).`
    );
    res.json({
      success: true,
      totalFixed,
      perTable: results,
      message: `Repaired ${totalFixed} fiscal-year link(s) across the database.`,
    });
  } catch (error: any) {
    console.error('Error repairing fiscal-year links:', error);
    res.status(500).json({ message: `Unable to repair fiscal-year links: ${error.message}` });
  }

}

/** Forwarded from admin.routes.ts (get_documentNumberConfigs). */
export async function get_documentNumberConfigs(req: any, res: Response): Promise<any> {
try {
    const result = await pgPool.query(DOC_NUMBER_CONFIGS_SELECT_SQL);
    if (result.rows.length > 0) {
      setDocNumberConfigs(result.rows);
      res.json(result.rows);
      return;
    }
  } catch (e: any) {
    if (e?.code !== 'ECONNREFUSED' && !e?.message?.includes('ECONNREFUSED')) {
      console.warn('PostgreSQL document_number_configs read notice:', e.message);
    }
  }
  res.json(docNumberConfigs);

}

/** Forwarded from admin.routes.ts (put_Id3). */
export async function put_Id3(req: any, res: Response): Promise<any> {
const { id } = req.params;
  const cfg = req.body;
  try {
    await pgPool.query(DOC_NUMBER_CONFIG_UPDATE_SQL, [cfg.prefix || '', cfg.suffix || '', cfg.minDigits || 4, cfg.startingNumber || 1, cfg.nextNumber || 1, cfg.resetEveryFiscalYear !== false, cfg.notes || '', id]);
  } catch (e: any) {
    console.warn('PostgreSQL update document_number_configs notice:', e.message);
  }

  const idx = docNumberConfigs.findIndex((c) => c.id === id);
  if (idx !== -1) {
    docNumberConfigs[idx] = { ...docNumberConfigs[idx], ...cfg };
  } else {
    docNumberConfigs.push(cfg);
  }
  res.json(docNumberConfigs.find((c) => c.id === id) || cfg);

}

/** Forwarded from admin.routes.ts (put_documentNumberConfigs). */
export async function put_documentNumberConfigs(req: any, res: Response): Promise<any> {
const configs: DocumentNumberConfig[] = req.body;
  if (Array.isArray(configs)) {
    for (const cfg of configs) {
      try {
        await pgPool.query(DOC_NUMBER_CONFIG_UPSERT_SQL, docNumberConfigUpsertParams(cfg));
      } catch (e: any) {
        console.warn(`PostgreSQL bulk update document_number_configs notice for ${cfg.id}:`, e.message);
      }
    }
    setDocNumberConfigs(configs);
  }
  res.json(docNumberConfigs);

}

/** Forwarded from admin.routes.ts (post_generateNext). */
export async function post_generateNext(req: any, res: Response): Promise<any> {
const { docTypeId, autoIncrement } = req.body;
  let config = docNumberConfigs.find((c) => c.id === docTypeId);

  try {
    const dbRes = await pgPool.query(DOC_NUMBER_CONFIG_BY_ID_SQL, [docTypeId]);
    if (dbRes.rows.length > 0) {
      config = dbRes.rows[0];
    }
  } catch (e: any) {
    console.warn('PostgreSQL read document_number_config notice:', e.message);
  }

  if (!config) {
    const fallbackSeq = Math.floor(1000 + Math.random() * 9000);
    res.json({ documentNumber: `${docTypeId || 'DOC'}-2081-${fallbackSeq}`, seqNum: fallbackSeq });
    return;
  }

  const seqNum = config.nextNumber;
  const paddedNum = String(seqNum).padStart(config.minDigits || 4, '0');
  const formattedDocNum = `${config.prefix || ''}${paddedNum}${config.suffix || ''}`;

  if (autoIncrement !== false) {
    const nextSeq = seqNum + 1;
    try {
      await pgPool.query(DOC_NUMBER_CONFIG_INCREMENT_SQL, [nextSeq, docTypeId]);
    } catch (e: any) {
      console.warn('PostgreSQL increment document_number_config notice:', e.message);
    }
    const idx = docNumberConfigs.findIndex((c) => c.id === docTypeId);
    if (idx !== -1) docNumberConfigs[idx].nextNumber = nextSeq;
  }

  res.json({ documentNumber: formattedDocNum, seqNum });

}

/** Forwarded from admin.routes.ts (post_resetCounter). */
export async function post_resetCounter(req: any, res: Response): Promise<any> {
const { docTypeId, newStartNumber } = req.body;
  const idx = docNumberConfigs.findIndex((c) => c.id === docTypeId);
  const startNum = newStartNumber !== undefined ? Number(newStartNumber) : (idx !== -1 ? docNumberConfigs[idx].startingNumber : 1);

  try {
    await pgPool.query(DOC_NUMBER_CONFIG_INCREMENT_SQL, [startNum, docTypeId]);
  } catch (e: any) {
    console.warn('PostgreSQL reset counter document_number_config notice:', e.message);
  }

  if (idx !== -1) {
    docNumberConfigs[idx].nextNumber = startNum;
  }

  res.json({ status: 'ok', docTypeId, nextNumber: startNum });

}

/** Forwarded from admin.routes.ts (get_fiscalYears). */
export async function get_fiscalYears(req: any, res: Response): Promise<any> {
try {
    const result = await pgPool.query(FY_LIST_SQL);
    if (result.rows.length > 0) {
      res.json(result.rows);
      return;
    }
  } catch (e: any) {
    if (e?.code !== 'ECONNREFUSED' && !e?.message?.includes('ECONNREFUSED')) {
      console.warn('PostgreSQL fiscal_years read notice:', e.message);
    }
  }
  res.json(fiscalYears);

}

/** Forwarded from admin.routes.ts (post_fiscalYears). */
export async function post_fiscalYears(req: any, res: Response): Promise<any> {
const { code, startDateAD, endDateAD, startDateBS, endDateBS } = req.body || {};

  if (![code, startDateAD, endDateAD, startDateBS, endDateBS].every((v) => typeof v === 'string' && v.trim())) {
    res.status(400).json({ message: 'Fiscal year code and all BS/AD period dates are required.' });
    return;
  }
  if (Number.isNaN(Date.parse(startDateAD)) || Number.isNaN(Date.parse(endDateAD)) || startDateAD > endDateAD) {
    res.status(400).json({ message: 'Enter a valid AD period with an end date on or after the start date.' });
    return;
  }

  const cleanCode = code.trim();
  try {
    // Prevent overlapping fiscal periods so every AD date belongs to exactly one
    // fiscal year (the assign_fiscal_year_id_from_date trigger relies on this).
    const overlapCheck = await pgPool.query(
      FY_OVERLAP_CHECK_SQL,
      [startDateAD, endDateAD]
    );
    if (overlapCheck.rows[0]) {
      return res.status(409).json({
        message: `The new period overlaps with FY ${overlapCheck.rows[0].code}. Adjust the dates so every day belongs to exactly one fiscal year.`,
      });
    }

    const id = `fy-${crypto.randomUUID()}`;
    const result = await pgPool.query(
      FY_INSERT_SQL,
      fiscalYearInsertParams({ id, code: cleanCode, startDateAD, endDateAD, startDateBS: startDateBS.trim(), endDateBS: endDateBS.trim() })
    );
    const newFiscalYear = result.rows[0];
    setFiscalYears(withSorted(
      withAppended(fiscalYears, newFiscalYear),
      (a, b) => String(b.startDateAD).localeCompare(String(a.startDateAD))
    ));
    logAuditEvent(req, 'CREATE_FISCAL_YEAR', 'FISCAL_YEAR', `Created fiscal year ${newFiscalYear.code}`);
    res.status(201).json(newFiscalYear);
    return;
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ message: 'That fiscal year code already exists.' });
    console.error('Error creating fiscal year:', error);
    res.status(500).json({ message: `Unable to create fiscal year: ${error.message}` });
    return;
  }

}

/** Forwarded from admin.routes.ts (post_setCurrent). */
export async function post_setCurrent(req: any, res: Response): Promise<any> {
const { id } = req.params;
  try {
    // One transaction: clear the old flag first, then set the new one, so the
    // uq_fiscal_years_single_current index can never be violated mid-flight.
    await withTransaction(async (client) => {
      await client.query(FY_SET_CURRENT_CLEAR_SQL);
      const result = await client.query(FY_SET_CURRENT_SQL, [id]);
      if (!result.rowCount) {
        const error: any = new Error('Fiscal year not found.');
        error.statusCode = 404;
        throw error;
      }
    });
  } catch (e: any) {
    if (e?.statusCode) return res.status(e.statusCode).json({ message: e.message });
    console.warn('PostgreSQL set-current fiscal year notice:', e.message);
  }

  fiscalYears.forEach((fy) => {
    fy.isCurrent = fy.id === id;
  });
  res.json(fiscalYears);

}

/** Forwarded from admin.routes.ts (put_Id4). */
export async function put_Id4(req: any, res: Response): Promise<any> {
const { id } = req.params;
  const { code, startDateAD, endDateAD, startDateBS, endDateBS } = req.body || {};
  const values = [code, startDateAD, endDateAD, startDateBS, endDateBS];

  if (!values.every((value) => typeof value === 'string' && value.trim())) {
    res.status(400).json({ message: 'Fiscal year code and all BS/AD period dates are required.' });
    return;
  }
  if (Number.isNaN(Date.parse(startDateAD)) || Number.isNaN(Date.parse(endDateAD)) || startDateAD > endDateAD) {
    res.status(400).json({ message: 'Enter a valid AD period with an end date on or after the start date.' });
    return;
  }

  try {
    const result = await pgPool.query(
      FY_UPDATE_SQL,
      [code.trim(), startDateAD, endDateAD, startDateBS.trim(), endDateBS.trim(), id]
    );
    const fiscalYear = result.rows[0];
    if (!fiscalYear) return res.status(404).json({ message: 'Fiscal year not found.' });

    const index = fiscalYears.findIndex((item) => item.id === id);
    if (index >= 0) setFiscalYears(withReplaced(fiscalYears, index, fiscalYear));
    logAuditEvent(req, 'UPDATE_FISCAL_YEAR', 'FISCAL_YEAR', `Updated fiscal year ${fiscalYear.code}`);
    res.json(fiscalYear);
    return;
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ message: 'That fiscal year code already exists.' });
    console.error('Error updating fiscal year:', error);
    res.status(500).json({ message: `Unable to update fiscal year: ${error.message}` });
    return;
  }

}

/** Forwarded from admin.routes.ts (post_close). */
export async function post_close(req: any, res: Response): Promise<any> {
const { id } = req.params;
  const authCheck = await verifySuperAdminCredentials(req.body?.adminEmail, req.body?.adminPassword);
  if (!authCheck.ok) return res.status(403).json({ message: authCheck.message });
  try {
    const result = await pgPool.query(FY_CLOSE_SQL, [id]);
    const fiscalYear = result.rows[0];
    if (!fiscalYear) {
      const existing = await pgPool.query(FY_END_DATE_SQL, [id]);
      if (!existing.rows[0]) return res.status(404).json({ message: 'Fiscal year not found.' });
      res.status(400).json({ message: `Fiscal year closing is available only after ${existing.rows[0].endDateAD}.` });
      return;
    }

    const index = fiscalYears.findIndex((item) => item.id === id);
    if (index >= 0) setFiscalYears(withReplaced(fiscalYears, index, fiscalYear));
    logAuditEvent(req, 'CLOSE_FISCAL_YEAR', 'FISCAL_YEAR', `Closed and locked fiscal year ${fiscalYear.code} (authorized by ${authCheck.email})`);
    res.json(fiscalYear);
    return;
  } catch (error: any) {
    console.error('Error closing fiscal year:', error);
    res.status(500).json({ message: `Unable to close fiscal year: ${error.message}` });
    return;
  }

}

/** Forwarded from admin.routes.ts (post_reopen). */
export async function post_reopen(req: any, res: Response): Promise<any> {
const { id } = req.params;
  const authCheck = await verifySuperAdminCredentials(req.body?.adminEmail, req.body?.adminPassword);
  if (!authCheck.ok) return res.status(403).json({ message: authCheck.message });
  try {
    const result = await pgPool.query(FY_REOPEN_SQL, [id]);
    const fiscalYear = result.rows[0];
    if (!fiscalYear) return res.status(404).json({ message: 'Fiscal year not found.' });
    const index = fiscalYears.findIndex((item) => item.id === id);
    if (index >= 0) setFiscalYears(withReplaced(fiscalYears, index, fiscalYear));
    logAuditEvent(req, 'REOPEN_FISCAL_YEAR', 'FISCAL_YEAR', `Reopened fiscal year ${fiscalYear.code} (authorized by ${authCheck.email})`);
    res.json(fiscalYear);
    return;
  } catch (error: any) {
    console.error('Error reopening fiscal year:', error);
    res.status(500).json({ message: `Unable to reopen fiscal year: ${error.message}` });
    return;
  }

}

/** Forwarded from admin.routes.ts (post_initializeOpeningStock). */
export async function post_initializeOpeningStock(req: any, res: Response): Promise<any> {
const { id } = req.params;
  try {
    const result = await withTransaction(async (client) => {
      const sourceResult = await client.query(FY_FIND_FOR_INIT_SQL, [id]);
      const sourceFiscalYear = sourceResult.rows[0];
      if (!sourceFiscalYear) {
        const error: any = new Error('Source fiscal year not found.');
        error.statusCode = 404;
        throw error;
      }
      if (!sourceFiscalYear.is_closed) {
        const error: any = new Error('Close and lock the source fiscal year before creating opening stock.');
        error.statusCode = 400;
        throw error;
      }

      const targetResult = await client.query(FY_NEXT_AFTER_SQL, [sourceFiscalYear.end_date_ad]);
      const targetFiscalYear = targetResult.rows[0];
      if (!targetFiscalYear) {
        const error: any = new Error('Create the next fiscal year before initializing its opening stock.');
        error.statusCode = 400;
        throw error;
      }

      // Enterprise rule: rows that were manually adjusted after the original close
      // (source_type = 'MANUAL_ADJUSTMENT') are posted, corrected opening balances and
      // must survive a re-initialization. Only closing-generated rows get refreshed.
      const existingRes = await client.query(FY_OPENING_STOCK_COUNTS_SQL, [targetFiscalYear.id]);
      const manualRowsPreserved = existingRes.rows[0]?.manual || 0;

      const inserted = await client.query(
        FY_OPENING_STOCK_INIT_SQL,
        fiscalYearOpeningStockInitParams(targetFiscalYear.id, sourceFiscalYear.code, getUserFromReq(req).email || 'system')
      );
      return { targetFiscalYear, recordsCreated: inserted.rowCount || 0, manualRowsPreserved };
    });

    logAuditEvent(
      req,
      'INITIALIZE_FISCAL_OPENING_STOCK',
      'FISCAL_YEAR',
      `Initialized ${result.recordsCreated} opening-stock records for ${result.targetFiscalYear.code}${
        result.manualRowsPreserved ? `; ${result.manualRowsPreserved} manual adjustment row(s) preserved` : ''
      }`
    );
    res.json(result);
    return;
  } catch (error: any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.error('Error initializing fiscal-year opening stock:', error);
    res.status(500).json({ message: `Unable to initialize fiscal-year opening stock: ${error.message}` });
    return;
  }

}

/** Forwarded from admin.routes.ts (delete_Id3). */
export async function delete_Id3(req: any, res: Response): Promise<any> {
const { id } = req.params;

  try {
    const result = await withTransaction(async (client) => {
      const fiscalYearResult = await client.query(FY_FIND_FOR_DELETE_SQL, [id]);
      const fiscalYear = fiscalYearResult.rows[0];

      if (!fiscalYear) {
        const error: any = new Error('Fiscal year not found.');
        error.statusCode = 404;
        throw error;
      }

      if (fiscalYear.isCurrent) {
        const error: any = new Error('The active fiscal year cannot be deleted. Set another fiscal year as active first.');
        error.statusCode = 400;
        throw error;
      }

      // Safety guard: a fiscal year that already carries ANY business records
      // (invoices, stock operations, opening balances, audit/transaction logs,
      // device records, etc.) must never be deleted. Only a completely empty
      // period created by mistake can be removed. bs_day_records are excluded:
      // they are auto-generated calendar reference rows (FK ON DELETE SET NULL)
      // that exist for every period, not business records belonging to the FY.
      const tableCounts: Array<{ label: string; count: number }> = [];

      for (const [table, label] of FY_REFERENCE_TABLES) {
        try {
          const countResult = await client.query(fiscalYearReferenceCountSql(table), [id]);
          const count = Number(countResult.rows[0]?.count || 0);
          if (count > 0) tableCounts.push({ label, count });
        } catch (countError: any) {
          // The table may not exist in older deployments — skip it rather than
          // failing the whole deletion check.
          if (countError?.code !== '42P01') throw countError;
        }
      }

      if (tableCounts.length > 0) {
        const summary = tableCounts.map((t) => `${t.label} (${t.count})`).join(', ');
        const error: any = new Error(
          `Fiscal year ${fiscalYear.code} cannot be deleted because it already contains records: ${summary}. Only a fiscal year with no records can be removed.`
        );
        error.statusCode = 400;
        throw error;
      }

      await client.query(FY_DELETE_SQL, [id]);
      return fiscalYear;
    });

    setFiscalYears(fiscalYears.filter((fiscalYear) => fiscalYear.id !== id));
    logAuditEvent(req, 'DELETE_FISCAL_YEAR', 'FISCAL_YEAR', `Deleted fiscal year ${result.code} (no records existed)`);
    res.json({ message: `Fiscal year ${result.code} deleted successfully.`, id });
    return;
  } catch (error: any) {
    if (error?.statusCode) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }
    console.error('Error deleting fiscal year:', error);
    res.status(500).json({ message: `Unable to delete fiscal year: ${error.message}` });
    return;
  }

}

/** Forwarded from admin.routes.ts (get_years). */
export async function get_years(req: any, res: Response): Promise<any> {
try {
    const result = await pgPool.query(BS_CALENDAR_YEARS_SELECT_SQL);
    if (result.rows.length > 0) {
      res.json(result.rows);
      return;
    }
  } catch (_err) {
    // Silently fall back to inMemoryBsCalendarYears if PostgreSQL is unreachable
  }
  res.json(inMemoryBsCalendarYears);

}

/** Forwarded from admin.routes.ts (get_day). */
export async function get_day(req: any, res: Response): Promise<any> {
try {
    const adDate = String(req.query.adDate || '');
    const result = await findBsDayRecordForAdDate(adDate);
    if (result.found) {
      res.json({ found: true, source: result.source, record: result.record });
      return;
    }
    return res.json({
      found: false,
      source: result.source,
      adDate: adDate.split('T')[0] || null,
      message: 'BS date is not available. Please contact your system administrator for BS month seeding.',
    });
  } catch (err: any) {
    console.error('Error looking up BS day record:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from admin.routes.ts (get_days). */
export async function get_days(req: any, res: Response): Promise<any> {
const { yearBS, monthBS, search } = req.query;
  try {
    const { sql: querySql, params } = buildBsDayRecordsQuery(yearBS, monthBS, search);

    const result = await pgPool.query(querySql, params);
    if (result.rows.length > 0) {
      res.json(result.rows);
      return;
    }
  } catch (_err) {
    // Silently fall back to in-memory records below
  }

  // Database query result handling
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

}

/** Forwarded from admin.routes.ts (post_seed). */
export async function post_seed(req: any, res: Response): Promise<any> {
const { yearBS, daysInMonths, customStartAD, onlyIfNew } = req.body;
  if (!yearBS || !Array.isArray(daysInMonths) || daysInMonths.length !== 12) {
    res.status(400).json({ message: 'Must provide yearBS and 12-element daysInMonths array' });
    return;
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
      pgSynced: true,
      message: `BS Year ${yearBS} already exists in database. Skipped overwrite because 'onlyIfNew' was specified.`,
    });
  }

  // PostgreSQL is the authoritative store for the calendar: write there first.
  // The in-memory store below is only a fallback cache for when PostgreSQL is
  // unreachable, so it is refreshed after the database write attempt.
  let pgSynced = false;
  try {
    await pgPool.query(BS_CALENDAR_YEAR_UPSERT_SQL, [yearBS, daysInMonths, startAD]);

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
          BS_DAY_RECORD_UPSERT_SQL,
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
    pgSynced = true;
  } catch (_err) {
    // PostgreSQL is unreachable; continue with the in-memory fallback cache only
  }

  if (existingIdx >= 0) {
    inMemoryBsCalendarYears[existingIdx] = { yearBS, daysInMonths, startAD };
  } else {
    inMemoryBsCalendarYears.push({ yearBS, daysInMonths, startAD });
    inMemoryBsCalendarYears.sort((a, b) => a.yearBS - b.yearBS);
  }
  generateInMemoryBsDayRecords();

  res.json({
    success: true,
    pgSynced,
    message: pgSynced
      ? `Successfully seeded BS Year ${yearBS} and regenerated calendar day-by-day lookup table in PostgreSQL (bs_day_records)!`
      : `Seeded BS Year ${yearBS} in the in-memory calendar only — PostgreSQL was unreachable, so bs_day_records was not updated. Re-run the seed after the database is back.`,
  });

}

/** Forwarded from admin.routes.ts (post_seedBulk). */
export async function post_seedBulk(req: any, res: Response): Promise<any> {
const { years, onlyIfNew } = req.body;
  if (!Array.isArray(years) || years.length === 0) {
    res.status(400).json({ success: false, message: 'Must provide non-empty years array' });
    return;
  }

  let pgSynced = false;
  let seededCount = 0;
  const skippedYears: number[] = [];
  const errors: string[] = [];

  try {
    for (const item of years) {
      const { yearBS, daysInMonths, customStartAD } = item;
      if (!yearBS || !Array.isArray(daysInMonths) || daysInMonths.length !== 12) {
        errors.push(`Year ${yearBS}: invalid payload`);
        continue;
      }

      let startAD = customStartAD;
      if (!startAD) {
        const estADYear = yearBS - 57;
        startAD = `${estADYear}-04-14`;
      }

      const existingIdx = inMemoryBsCalendarYears.findIndex((y) => y.yearBS === yearBS);
      if (onlyIfNew && existingIdx >= 0) {
        skippedYears.push(yearBS);
        continue;
      }

      await pgPool.query(BS_CALENDAR_YEAR_UPSERT_SQL, [yearBS, daysInMonths, startAD]);

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
            BS_DAY_RECORD_UPSERT_SQL,
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

      if (existingIdx >= 0) {
        inMemoryBsCalendarYears[existingIdx] = { yearBS, daysInMonths, startAD };
      } else {
        inMemoryBsCalendarYears.push({ yearBS, daysInMonths, startAD });
      }
      seededCount++;
    }

    inMemoryBsCalendarYears.sort((a, b) => a.yearBS - b.yearBS);
    generateInMemoryBsDayRecords();
    pgSynced = true;
  } catch (_err) {
    // PostgreSQL is unreachable; in-memory fallback only
  }

  res.json({
    success: true,
    pgSynced,
    seededCount,
    skippedYears,
    message: pgSynced
      ? `Successfully seeded ${seededCount} BS year(s) and regenerated calendar day-by-day lookup table in PostgreSQL (bs_day_records)!${skippedYears.length ? ` Skipped ${skippedYears.length} existing year(s): ${skippedYears.join(', ')}` : ''}`
      : `Seeded ${seededCount} BS year(s) in the in-memory calendar only — PostgreSQL was unreachable. Re-run when database is back.${skippedYears.length ? ` Skipped ${skippedYears.length} existing year(s): ${skippedYears.join(', ')}` : ''}`,
  });

}

/** Forwarded from admin.routes.ts (put_YearBS). */
export async function put_YearBS(req: any, res: Response): Promise<any> {
const yearBS = parseInt(req.params.yearBS as string, 10);
  const { daysInMonths, startAD, recalculateNextStartAD = true } = req.body;

  const existingIdx = inMemoryBsCalendarYears.findIndex((y) => y.yearBS === yearBS);
  if (existingIdx < 0) {
    return res.status(404).json({
      success: false,
      message: `BS Year ${yearBS} does not exist. Use the seed endpoint to create it first.`,
    });
  }

  if (daysInMonths !== undefined && (!Array.isArray(daysInMonths) || daysInMonths.length !== 12)) {
    res.status(400).json({ success: false, message: 'daysInMonths must be a 12-element month length array.' });
    return;
  }
  if (daysInMonths !== undefined && daysInMonths.some((d: number) => isNaN(d) || d < 28 || d > 32)) {
    res.status(400).json({ success: false, message: 'Each month day count must be between 28 and 32.' });
    return;
  }
  if (startAD !== undefined && isNaN(new Date(startAD).getTime())) {
    res.status(400).json({ success: false, message: `Invalid startAD value: ${startAD}` });
    return;
  }

  const newConfig: { yearBS: number; daysInMonths: number[]; startAD: string } = {
    yearBS,
    daysInMonths: daysInMonths !== undefined ? daysInMonths : [...inMemoryBsCalendarYears[existingIdx].daysInMonths],
    startAD: startAD !== undefined ? startAD : inMemoryBsCalendarYears[existingIdx].startAD,
  };

  // Compute the end AD date of the edited year with its new config, both the
  // original (before edit) and the updated version. The difference is the
  // delta that must be applied to every subsequent seeded year so intervening
  // real-world dates stay correct even when some BS years are not seeded.
  const totalDaysOf = (days: number[]) => days.reduce((sum: number, d: number) => sum + (d || 30), 0);
  const originalStart = new Date(inMemoryBsCalendarYears[existingIdx].startAD);
  const originalEnd = new Date(originalStart);
  originalEnd.setDate(originalEnd.getDate() + totalDaysOf(inMemoryBsCalendarYears[existingIdx].daysInMonths));

  const newStart = new Date(newConfig.startAD);
  const newEnd = new Date(newStart);
  newEnd.setDate(newEnd.getDate() + totalDaysOf(newConfig.daysInMonths));

  const deltaDays = Math.round((newEnd.getTime() - originalEnd.getTime()) / 86400000);

  // The set of years whose day records must be regenerated. The edited year is
  // always included; every subsequent seeded year is shifted by deltaDays and
  // regenerated when recalculateNextStartAD is true.
  const affectedYears: { yearBS: number; daysInMonths: number[]; startAD: string }[] = [];
  affectedYears.push({ ...newConfig });

  const sortedYears = inMemoryBsCalendarYears
    .map((y) => ({ yearBS: y.yearBS, daysInMonths: [...y.daysInMonths], startAD: y.startAD }))
    .sort((a, b) => a.yearBS - b.yearBS);

  if (recalculateNextStartAD && deltaDays !== 0) {
    const originalMap = new Map<number, { yearBS: number; daysInMonths: number[]; startAD: string }>();
    for (const y of sortedYears) originalMap.set(y.yearBS, y);

    // Shift every seeded year AFTER the edited one by deltaDays. Using the
    // previously seeded start_ad + delta preserves any intentional gaps
    // between non-consecutive seeded years instead of collapsing them.
    for (const y of sortedYears) {
      if (y.yearBS <= yearBS) continue;

      const orig = originalMap.get(y.yearBS)!;
      const shiftedStart = new Date(orig.startAD);
      shiftedStart.setDate(shiftedStart.getDate() + deltaDays);
      const shiftedStartStr = shiftedStart.toISOString().split('T')[0];

      affectedYears.push({ ...y, startAD: shiftedStartStr });
    }
  }
  // When the edit does not change the edited year's total length
  // (deltaDays === 0) no subsequent year's AD mapping changes, so only the
  // edited year's day records are regenerated. When recalculateNextStartAD is
  // false, the caller explicitly opted out of touching later years.

  if (affectedYears.length === 0) {
    res.status(400).json({ success: false, message: `No change requested for BS Year ${yearBS}.` });
    return;
  }

  let pgSynced = false;
  try {
    await pgPool.query('BEGIN');

    // 1. Upsert the edited year's config.
    await pgPool.query(BS_CALENDAR_YEAR_UPSERT_SQL, [newConfig.yearBS, newConfig.daysInMonths, newConfig.startAD]);

    // 2. Rewrite the subsequent years' start_ad when the running calendar
    //    requires it (keeps bs_calendar_years config consistent with the
    //    regenerated day records).
    for (const y of affectedYears) {
      if (y.yearBS === yearBS) continue;
      const dbIdx = inMemoryBsCalendarYears.findIndex((m) => m.yearBS === y.yearBS);
      if (dbIdx < 0) continue;
      const prevConfig = inMemoryBsCalendarYears[dbIdx];
      if (prevConfig.startAD !== y.startAD) {
        await pgPool.query(BS_CALENDAR_YEAR_SET_START_SQL, [y.yearBS, y.startAD]);
      }
    }

    // 3. Delete stale day records for every affected year, then regenerate.
    const affectedNumList = affectedYears.map((y) => y.yearBS);
    await pgPool.query(BS_DAY_RECORDS_DELETE_BY_YEARS_SQL, [affectedNumList]);

    for (const y of affectedYears) {
      const records = buildBsDayRecordsForYear(y.yearBS, y.daysInMonths, y.startAD);
      for (const rec of records) {
        await pgPool.query(BS_DAY_RECORD_UPSERT_SQL, bsDayRecordParams(rec));
      }
    }

    await pgPool.query('COMMIT');
    pgSynced = true;
  } catch (err: any) {
    try { await pgPool.query('ROLLBACK'); } catch (_rb) { /* ignore */ }
    console.error('BS calendar update transaction failed:', err?.message || err);
  }

  // 4. Refresh the in-memory fallback cache with the same config + records.
  const memMap = new Map<number, { yearBS: number; daysInMonths: number[]; startAD: string }>();
  for (const m of inMemoryBsCalendarYears) memMap.set(m.yearBS, m);
  for (const y of affectedYears) {
    memMap.set(y.yearBS, { yearBS: y.yearBS, daysInMonths: y.daysInMonths, startAD: y.startAD });
  }
  setInMemoryBsCalendarYears(Array.from(memMap.values()).sort((a, b) => a.yearBS - b.yearBS));
  generateInMemoryBsDayRecords();

  const regenCount = affectedYears.reduce((sum, y) => {
    return sum + y.daysInMonths.reduce((m, d) => m + d, 0);
  }, 0);

  res.json({
    success: true,
    pgSynced,
    affectedYears: affectedYears.map((y) => y.yearBS),
    regeneratedRecords: regenCount,
    message: pgSynced
      ? `BS Year ${yearBS} updated. Regenerated ${regenCount} day records across BS year(s): ${affectedYears.map((y) => y.yearBS).join(', ')}. Subsequent year start dates were recomputed for calendar continuity.`
      : `BS Year ${yearBS} updated in the in-memory calendar only — PostgreSQL was unreachable, so bs_day_records was not updated. Re-run when database is back.`,
  });

}

/** Forwarded from admin.routes.ts (post_syncRange). */
export async function post_syncRange(req: any, res: Response): Promise<any> {
const { dayRecords } = req.body;
  if (!Array.isArray(dayRecords) || dayRecords.length === 0) {
    res.status(400).json({ success: false, message: 'No day records provided to write to SQL database.' });
    return;
  }

  // PostgreSQL is the authoritative store: write there first, then refresh the
  // in-memory fallback cache with the same records.
  let pgSynced = false;
  try {
    for (const rec of dayRecords) {
      await pgPool.query(BS_DAY_RECORD_UPSERT_SQL, bsDayRecordParams(rec));
    }
    pgSynced = true;
  } catch (_err) {
    // PostgreSQL is unreachable; continue with the in-memory fallback cache only
  }

  const recordMap = new Map<string, any>();
  for (const r of inMemoryBsDayRecords) {
    recordMap.set(r.adDate, r);
  }
  for (const r of dayRecords) {
    recordMap.set(r.adDate, r);
  }
  setInMemoryBsDayRecords(Array.from(recordMap.values()));

  const insertedCount = dayRecords.length;
  res.json({
    success: true,
    pgSynced,
    count: insertedCount,
    message: pgSynced
      ? `Successfully written & updated ${insertedCount} daily conversion records in PostgreSQL bs_day_records table!`
      : `Kept ${insertedCount} daily conversion records in the in-memory calendar only — PostgreSQL was unreachable, so bs_day_records was not updated.`,
  });

}

/** Forwarded from admin.routes.ts (get_companyProfile2). */
export async function get_companyProfile2(req: any, res: Response): Promise<any> {
try {
    if (getPgConnected()) {
      const dbRes = await pgPool.query(COMPANY_PROFILE_SELECT_SQL);
      if (dbRes.rows.length > 0) {
        res.json(dbRes.rows[0]);
        return;
      }
    }
    res.json(companyProfile);
  } catch (err: any) {
    console.error('Error fetching company profile:', err);
    res.json(companyProfile);
  }

}

/** Forwarded from admin.routes.ts (put_companyProfile2). */
export async function put_companyProfile2(req: any, res: Response): Promise<any> {
try {
    const updated = req.body;
    setCompanyProfile({
      ...companyProfile,
      ...updated,
    });

    if (getPgConnected()) {
      await pgPool.query(COMPANY_PROFILE_UPSERT_NO_STAMP_SQL, companyProfileUpsertNoStampParams(companyProfile as CompanyProfile));
    }

    logAuditEvent(
      req,
      'COMPANY_PROFILE_UPDATED',
      'SYSTEM',
      `Updated company profile details for ${companyProfile.name} (PAN: ${companyProfile.panVatNumber})`,
      'WH001'
    );
    broadcastChange({ type: 'COMPANY_PROFILE_UPDATED', entity: 'COMPANY_PROFILE' });

    res.json(companyProfile);
  } catch (err: any) {
    console.error('Error updating company profile:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

