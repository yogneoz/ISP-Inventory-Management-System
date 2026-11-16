/**
 * SCALE-2 — bootstrap payload budget.
 *
 * The login payload carries only the identity/permission shell, switchable
 * branches, fiscal-year context, company profile, settings and preferences.
 * This test measures a realistic 500-branch shell with the same gzip arithmetic
 * the CLI uses (`scripts/measure_bootstrap_payload.mjs`) and pins the budget at
 * 15 KB gzip. It also guards the full-bootstrap response from reintroducing a
 * master/ledger array.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { measurePayload } from '../scripts/measure_bootstrap_payload.mjs';

const BUDGET_BYTES = 15 * 1024;

function shellPayload() {
  return {
    branches: Array.from({ length: 500 }, (_, i) => ({
      id: `BR-${String(i).padStart(4, '0')}`,
      code: `BR${String(i).padStart(4, '0')}`,
      name: `Branch ${i} — Kathmandu Valley`,
      address: `Ward ${i % 32}, Metropolitan City`,
      phone: `01-${String(4000000 + i)}`,
      isActive: i % 7 !== 0,
      isWarehouse: i % 11 === 0,
      parentBranchId: i % 11 === 0 ? null : 'HO',
    })),
    fiscalYears: Array.from({ length: 8 }, (_, i) => ({
      id: `fy-${2080 + i}`,
      code: `${2080 + i}/${2081 + i}`,
      startDateAD: `${2037 + i}-07-17`,
      endDateAD: `${2038 + i}-07-16`,
      startDateBS: `${2080 + i}-04-01`,
      endDateBS: `${2081 + i}-03-32`,
      isCurrent: i === 5,
      isClosed: i < 5,
      isDemo: false,
      isProvisional: i === 5,
    })),
    financialSummary: {
      totalSales: 12500000,
      totalPurchases: 8400000,
      totalExpenses: 2100000,
      grossProfit: 4100000,
      netProfit: 2000000,
      cashBalance: 3500000,
      bankBalance: 7800000,
      receivables: 1900000,
      payables: 1300000,
      inventoryValue: 6200000,
      fiscalYear: '2085/2086',
      lastUpdated: '2026-11-16T00:00:00.000Z',
    },
    users: [],
    companyProfile: {
      id: 'company-1',
      name: 'National Inventory and Distribution Pvt. Ltd.',
      address: 'Kathmandu, Nepal',
      phone: '01-5555555',
      email: 'accounts@example.com',
      panNumber: '123456789',
      currencyCode: 'NPR',
      currencySymbol: 'NPR',
      currencyLocale: 'en-IN',
      currencyPosition: 'before',
      currencyDecimals: 2,
      defaultTaxRate: 13,
    },
    postgresDatabaseStatus: {
      isConnected: true,
      host: 'localhost',
      port: 5432,
      database: 'inventory_db',
      user: 'inventory_user',
      engine: 'PostgreSQL Server (External/Self-Hosted)',
    },
    dataVersion: 123456,
    serverTime: '2026-11-16T00:00:00.000Z',
    permissionsMatrix: Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [
        `operation-${i}`,
        { SUPER_ADMIN: true, HEAD_OFFICE_ADMIN: i % 2 === 0, BRANCH_MANAGER: i % 3 === 0 },
      ])
    ),
    appSettings: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`setting_${i}`, `value-${i}`])
    ),
    userPreferences: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`preference_${i}`, `value-${i}`])
    ),
  };
}

describe('SCALE-2 bootstrap payload budget', () => {
  test('a realistic 500-branch shell stays under 15 KB gzip', () => {
    const measured = measurePayload(shellPayload());
    assert.ok(
      measured.gzipBytes < BUDGET_BYTES,
      `bootstrap shell is ${measured.gzipBytes} B gzip; budget is ${BUDGET_BYTES} B`
    );
  });

  test('the full-bootstrap response cannot reintroduce master or ledger arrays', () => {
    const controller = fs.readFileSync(
      path.join(path.resolve('.'), 'server/src/controllers/bootstrap.controller.ts'),
      'utf8'
    );
    const payload = controller.slice(
      controller.lastIndexOf('return res.json({'),
      controller.lastIndexOf('} catch')
    );
    for (const key of [
      'products', 'stock', 'suppliers', 'categories', 'productGroups',
      'uom', 'locations', 'approvalRequests', 'damageRecords', 'customers',
      'salesInvoices', 'stockOperations', 'serialLogs', 'auditLogs',
    ]) {
      assert.ok(!new RegExp(`\\b${key}\\s*:`).test(payload), `bootstrap serializes '${key}' again`);
    }
  });

  test('the client defers every removed master array', () => {
    const app = fs.readFileSync(path.join(path.resolve('.'), 'client/src/App.tsx'), 'utf8');
    const start = app.indexOf('DEFERRED_BOOTSTRAP_SLICES = [');
    const end = app.indexOf('];', start);
    const block = app.slice(start, end);
    for (const key of [
      'products', 'stock', 'suppliers', 'categories', 'productGroups',
      'uom', 'locations', 'approvalRequests', 'damageRecords',
    ]) {
      assert.ok(block.includes(`'${key}'`), `deferred hydration is missing '${key}'`);
    }
  });
});
