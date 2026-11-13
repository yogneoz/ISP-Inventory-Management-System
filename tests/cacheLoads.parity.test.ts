/**
 * Phase 0B reference-cache guard.
 *
 * PostgreSQL is the transaction store. Boot may hydrate only small reference
 * data; customers, invoices, returns, payments, logs, approvals, devices,
 * assets, POs, shipments and serial history must never be loaded wholesale into
 * memory again. This guard pins the allowlist and the removed refresh path.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const RUNTIME_STATE_PATH = path.join(ROOT, 'server/src/state/runtimeState.ts');
const APP_PATH = path.join(ROOT, 'server/src/app.ts');

const REFERENCE_LOADS = [
  'branches',
  'users',
  'uom',
  'locations',
  'suppliers',
  'fiscalYears',
  'companyProfile',
  'products',
  'categories',
  'product_groups',
  'inventory_stock',
];

const TRANSACTIONAL_LOADS = [
  'fixed_assets',
  'purchase_orders',
  'purchase_invoices',
  'shipments',
  'sales_invoices',
  'purchase_returns',
  'sales_returns',
  'stock_operations',
  'audit_logs',
  'transaction_logs',
  'approval_requests',
  'damage_records',
  'customer_records',
  'customer_device_records',
  'vendor_payments',
  'customer_payments',
  'serial_log',
];

describe('reference-only CACHE_LOADS (Phase 0B)', () => {
  const runtimeState = fs.readFileSync(RUNTIME_STATE_PATH, 'utf8');
  const app = fs.readFileSync(APP_PATH, 'utf8');

  test('every boot load is on the reference allowlist', () => {
    const entries = [...runtimeState.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(entries)].sort(),
      [...REFERENCE_LOADS].sort(),
      'CACHE_LOADS changed — add a bounded repository read instead of a boot mirror for transactional data'
    );
  });

  test('no transactional table is hydrated from PostgreSQL', () => {
    for (const name of TRANSACTIONAL_LOADS) {
      assert.ok(
        !new RegExp(`name:\\s*'${name}'`).test(runtimeState),
        `${name} is back in CACHE_LOADS — it must be read through its repository query`
      );
    }
  });

  test('the write-path refresh hook and runner are gone', () => {
    assert.ok(!runtimeState.includes('refreshOperationalCache'), 'runtimeState still exposes a full refresh');
    assert.ok(!runtimeState.includes('runCacheRefreshPass'), 'runtimeState still has a full refresh pass');
    assert.ok(!app.includes('cacheRefreshHook'), 'app.ts still installs the cache-refresh hook');
    assert.ok(
      !fs.existsSync(path.join(ROOT, 'server/src/middleware/cacheRefreshHook.ts')),
      'cacheRefreshHook.ts still exists'
    );
  });

  test('reference loads still derive from the column mappings', () => {
    assert.match(runtimeState, /buildCacheSelectSql\(BOOTSTRAP_TABLES\./);
    assert.ok(runtimeState.includes('BOOTSTRAP_TABLES.fiscalYears'), 'fiscal years must stay a reference load');
    assert.ok(runtimeState.includes('BOOTSTRAP_TABLES.products'), 'the product catalogue must stay a reference load');
  });
});
