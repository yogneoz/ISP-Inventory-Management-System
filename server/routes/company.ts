/**
 * Route module: company
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
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

router.get('/api/company-profile', async (req, res) => {
  try {
    if (isPgConnected) {
      const dbRes = await pgPool.query(
        `SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1`
      );
      if (dbRes.rows.length > 0) {
        return res.json(dbRes.rows[0]);
      }
    }
    res.json(store.companyProfile);
  } catch (err: any) {
    console.error('Error fetching company profile:', err);
    res.json(store.companyProfile);
  }
});

router.put('/api/company-profile', async (req, res) => {
  try {
    const updated = req.body;
    store.setCompanyProfile({
      ...store.companyProfile,
      ...updated,
    });

    if (isPgConnected) {
      await pgPool.query(
        `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, default_tax_rate, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           legal_name = EXCLUDED.legal_name,
           tagline = EXCLUDED.tagline,
           address = EXCLUDED.address,
           city = EXCLUDED.city,
           country = EXCLUDED.country,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           website = EXCLUDED.website,
           pan_vat_number = EXCLUDED.pan_vat_number,
           registration_number = EXCLUDED.registration_number,
           logo_url = EXCLUDED.logo_url,
           logo_preset = EXCLUDED.logo_preset,
           currency_symbol = EXCLUDED.currency_symbol,
           default_tax_rate = EXCLUDED.default_tax_rate,
           notes = EXCLUDED.notes`,
        [
          store.companyProfile.id || 'COMP-001',
          store.companyProfile.name,
          store.companyProfile.legalName || '',
          store.companyProfile.tagline || '',
          store.companyProfile.address,
          store.companyProfile.city || '',
          store.companyProfile.country || 'Nepal',
          store.companyProfile.phone || '',
          store.companyProfile.email || '',
          store.companyProfile.website || '',
          store.companyProfile.panVatNumber || '',
          store.companyProfile.registrationNumber || '',
          store.companyProfile.logoUrl || '',
          store.companyProfile.logoPreset || 'telecom',
          store.companyProfile.currencySymbol || 'Rs.',
          store.companyProfile.defaultTaxRate || 13,
          store.companyProfile.notes || '',
        ]
      );
    }

    logAuditEvent(
      req,
      'COMPANY_PROFILE_UPDATED',
      'SYSTEM',
      `Updated company profile details for ${store.companyProfile.name} (PAN: ${store.companyProfile.panVatNumber})`,
      'WH001'
    );

    store.saveDataStore();
    broadcastChange({ type: 'COMPANY_PROFILE_UPDATED', entity: 'COMPANY_PROFILE' });

    res.json(store.companyProfile);
  } catch (err: any) {
    console.error('Error updating company profile:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

// AI Analytics Proxy Endpoint

export default router;
