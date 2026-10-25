/**
 * Database boot module extracted from app.ts (backlog item #6 — app.ts
 * extraction). Owns the PostgreSQL schema sync (executes scripts/schema.sql —
 * the single schema source of truth, duplication audit phase 2), initial
 * seeding, the operational cache load list (CACHE_LOADS), boot-time
 * hydration.
 *
 * Shared-state interactions are injected via BootStateDeps so this module
 * never imports app.ts (no cycles).
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { pgPool, realPoolInstance, setIsPgConnected } from '../../db';
import { setPgConnected as setPgConnectedFlag } from '../state/runtimeState';
import { hydrateBsCalendarFromDb } from '../config/bsCalendar';
import { auditBsCalendar } from '../services/bsCalendarIntegrity.service';
import {
INITIAL_COMPANY_PROFILE,
INITIAL_DOCUMENT_NUMBER_CONFIGS,
INITIAL_MASTER_UOM,
INITIAL_MASTER_LOCATIONS,
INITIAL_MASTER_BRANCHES,
INITIAL_MASTER_FISCAL_YEARS,
INITIAL_MASTER_SUPPLIERS,
EXAMPLE_USER_PASSWORD,
INITIAL_EXAMPLE_USERS,
} from '../config/seedData';
import { DEFAULT_PERMISSIONS_MATRIX } from '../../../client/src/utils/permissionMatrixData';
import { hashPassword } from '../middleware/auth';

import {
  setDocNumberConfigs,
  setPermissionMatrix,
  hydrateOperationalData,
} from '../state/runtimeState';


/**
 * This module's own directory, for both runtimes the server is started in:
 *
 *   - ESM sources (`npm run dev` → `tsx server/index.ts`, `tsx --test`) have no
 *     `__dirname`, so the started script's directory is the closest anchor.
 *   - The production bundle (`dist/server.cjs` — `npm start`, pm2, the
 *     Dockerfile) is CommonJS, where `__dirname` is the real value.
 *
 * `import.meta.url` is deliberately NOT read here: esbuild lowers `import.meta`
 * to an EMPTY OBJECT in cjs output, so `fileURLToPath(import.meta.url)` threw
 * `The "path" argument must be of type string` at boot — before the
 * process.cwd() candidate below was ever tried, which made `node
 * dist/server.cjs` (and therefore `pm2 reload`) unable to start at all.
 */
function resolveModuleDir(): string | null {
  if (typeof __dirname === 'string') return __dirname;
  const entry = process.argv[1];
  if (!entry) return null;
  try {
    return path.dirname(path.resolve(entry));
  } catch {
    return null;
  }
}

/**
 * Resolve scripts/schema.sql from the repo root. Tries, in order:
 *   1. process.cwd()/scripts/schema.sql  — `npm run dev` / `npm test` / CI
 *      always run from the repo root.
 *   2. module-relative walk up          — the bundled `dist/server.cjs` (whose
 *      `__dirname` is the dist folder) or any other cwd.
 * Cached after the first successful read; throws a clear error listing every
 * candidate if the file cannot be located.
 */
let schemaSqlCache: string | null = null;
function loadSchemaSql(): string {
  if (schemaSqlCache) return schemaSqlCache;
  const candidates = [path.resolve(process.cwd(), 'scripts/schema.sql')];
  const moduleDir = resolveModuleDir();
  if (moduleDir) {
    for (let i = 0; i < 6; i++) {
      candidates.push(path.resolve(moduleDir, '../'.repeat(i), 'scripts/schema.sql'));
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      schemaSqlCache = readFileSync(candidate, 'utf8');
      return schemaSqlCache;
    }
  }
  throw new Error(`scripts/schema.sql not found — looked in:\n  ${candidates.join('\n  ')}`);
}

export async function syncDatabaseAndIndexes() {
  if (!realPoolInstance) {
    setPgConnectedFlag(false);
    setIsPgConnected(false);
    throw new Error('PostgreSQL connection is not configured. Set DATABASE_URL or POSTGRES_HOST.');
  }

  try {
    const client = await pgPool.connect();
    if (!client) {
      setPgConnectedFlag(false);
      setIsPgConnected(false);
      throw new Error('PostgreSQL connection could not be established.');
    }
    console.log('PostgreSQL Pool connected successfully. Syncing database schema from scripts/schema.sql (single source of truth)...');

    // Single source of truth: execute scripts/schema.sql verbatim. This file
    // no longer maintains a second inline schema (duplication audit, phase 2).
    // The static drift guard (tests/schemaSource.parity.test.ts) plus the CI
    // "apply schema.sql to a fresh database" step keep the two in lockstep.
    await client.query(loadSchemaSql());

    setPgConnectedFlag(true);
    setIsPgConnected(true);
    await seedInitialPostgresData(client);
    await hydrateOperationalData(client);
    // SER-2 / D3: the serial register is no longer converged on boot. A silent
    // pass hid unregistered legacy units and rewrote the register behind the
    // operator's back; it is now an explicit SUPER_ADMIN action.
    console.log('ℹ️  Serial register: boot does not backfill. Reconcile on demand at Administration & Governance → Data Recalculation & Repair → Reconcile Serial Register.');
    await loadPermissionMatrixFromDb(client);
    await hydrateBsCalendarFromDb(client);

    // Read-only calendar integrity check. The API, the CLI and the BS Calendar
    // Utility's Calendar Health panel can repair drift, but a restore from
    // backup or an out-of-band seed must be visible in the boot log instead of
    // surfacing weeks later as a wrong date on a document. Nothing is written
    // here.
    try {
      const integrity = await auditBsCalendar(client);
      if (integrity.summary.total === 0) {
        console.log('✅ BS calendar integrity: the stored calendar matches the patro reference.');
      } else {
        console.warn(
          `⚠️  BS calendar integrity: ${integrity.summary.total} finding(s) (${integrity.summary.fixable} derivable).` +
            ' Run `npm run audit:bs-dates` for the list, or open Administration & Governance → BS Calendar Utility → Calendar Health.'
        );
        for (const finding of integrity.findings.slice(0, 5)) {
          console.warn(`   ${finding.fixable ? '[fixable]' : '[report] '} ${finding.title}`);
        }
        if (integrity.findings.length > 5) {
          console.warn(`   … +${integrity.findings.length - 5} more finding(s)`);
        }
      }
    } catch (err: any) {
      console.warn('BS calendar integrity check skipped:', err?.message || err);
    }

    client.release();
    console.log('✅ Database schema synced from scripts/schema.sql; seeds, caches and permission matrix loaded.');
  } catch (err: any) {
    setPgConnectedFlag(false);
    setIsPgConnected(false);
    throw new Error(`PostgreSQL startup failed: ${err?.message || err}`);
  }
}

async function seedInitialPostgresData(client: pg.PoolClient) {
  try {
    for (const b of INITIAL_MASTER_BRANCHES) {
      await client.query(
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement, allow_warehouse_transfer, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.code, b.name, b.location, b.phone || '', b.isHeadquarters || false, b.active !== false, b.allowProcurement !== false, b.allowWarehouseTransfer !== false]
      );
    }
    for (const fy of INITIAL_MASTER_FISCAL_YEARS) {
      await client.query(
        `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (id) DO NOTHING`,
        // The fallbacks are a last resort for a master row that omits a field;
        // they mirror fy-3 (2082-83 = Shrawan 1 2082 .. Ashadh 32 2083) from
        // INITIAL_MASTER_FISCAL_YEARS so they never reintroduce a boundary that
        // is not a patro date (2025-07-16 is Ashadh 32, not Shrawan 1).
        [fy.id, fy.code, fy.startDateAD || '2025-07-17', fy.endDateAD || '2026-07-16', fy.startDateBS || '2082-04-01', fy.endDateBS || '2083-03-32', fy.isCurrent || false, fy.isClosed || false]
      );
    }
    // Seed Company Profile if empty
    await client.query(
      `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, postal_code, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, currency_code, currency_locale, currency_position, currency_decimals, default_tax_rate, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) ON CONFLICT (id) DO NOTHING`,
      [
        INITIAL_COMPANY_PROFILE.id,
        INITIAL_COMPANY_PROFILE.name,
        INITIAL_COMPANY_PROFILE.legalName,
        INITIAL_COMPANY_PROFILE.tagline,
        INITIAL_COMPANY_PROFILE.address,
        INITIAL_COMPANY_PROFILE.city,
        INITIAL_COMPANY_PROFILE.country,
        INITIAL_COMPANY_PROFILE.postalCode || '',
        INITIAL_COMPANY_PROFILE.phone,
        INITIAL_COMPANY_PROFILE.email,
        INITIAL_COMPANY_PROFILE.website,
        INITIAL_COMPANY_PROFILE.panVatNumber,
        INITIAL_COMPANY_PROFILE.registrationNumber,
        INITIAL_COMPANY_PROFILE.logoUrl,
        INITIAL_COMPANY_PROFILE.logoPreset,
        INITIAL_COMPANY_PROFILE.currencySymbol,
        INITIAL_COMPANY_PROFILE.currencyCode || 'NPR',
        INITIAL_COMPANY_PROFILE.currencyLocale || 'en-IN',
        INITIAL_COMPANY_PROFILE.currencyPosition || 'before',
        INITIAL_COMPANY_PROFILE.currencyDecimals ?? 2,
        INITIAL_COMPANY_PROFILE.defaultTaxRate,
        INITIAL_COMPANY_PROFILE.notes,
      ]
    );

    for (const u of INITIAL_MASTER_UOM) {
      await client.query(
        `INSERT INTO uom (id, name, symbol, type, is_base_unit)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
        [u.id, u.name, u.symbol, u.type, u.isBaseUnit]
      );
    }
    for (const l of INITIAL_MASTER_LOCATIONS) {
      await client.query(
        `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE) ON CONFLICT (id) DO NOTHING`,
        [l.id, l.name, l.type, l.branchId, l.address, JSON.stringify(l.coordinates), l.contactPerson, l.contactPhone, l.notes, l.activeAssetsCount]
      );
    }

    for (const s of INITIAL_MASTER_SUPPLIERS) {
      const sup = s as any;
      await client.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE) ON CONFLICT (id) DO NOTHING`,
        [sup.id, sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', sup.rating || 5.0, sup.status || 'ACTIVE']
      );
    }

    // Example/dummy user accounts (is_demo = TRUE) so the app is testable out
    // of the box after a fresh setup. Never overwrite existing accounts.
    for (const eu of INITIAL_EXAMPLE_USERS) {
      const allowedBranchIds = eu.role === 'SUPER_ADMIN' ? INITIAL_MASTER_BRANCHES.map((b) => b.id) : [eu.branchId];
      await client.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (email) DO NOTHING`,
        [eu.id, eu.email, hashPassword(EXAMPLE_USER_PASSWORD), eu.name, eu.role, eu.branchId, allowedBranchIds, eu.canSwitchUser]
      );
    }

for (const cfg of INITIAL_DOCUMENT_NUMBER_CONFIGS) {
      await client.query(
        `INSERT INTO document_number_configs (id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
         [cfg.id, cfg.documentType, cfg.prefix || '', cfg.suffix || '', cfg.minDigits || 4, cfg.startingNumber || 1, cfg.nextNumber || 1, cfg.resetEveryFiscalYear !== false, cfg.notes || '']
       );
     }

     // Seed the server-side permission matrix from the canonical defaults.
     // Idempotent: only insert operations/roles that are missing so a restart
     // never silently reverts matrix customizations made via the API.
     const matrixEntries: Array<[string, string, boolean]> = [];
     for (const [opId, roles] of Object.entries(DEFAULT_PERMISSIONS_MATRIX)) {
       for (const [role, allowed] of Object.entries(roles)) {
         matrixEntries.push([opId, role, allowed]);
       }
     }
     for (const [opId, role, allowed] of matrixEntries) {
       await client.query(
         `INSERT INTO permission_matrix (operation_id, role, allowed) VALUES ($1, $2, $3) ON CONFLICT (operation_id, role) DO NOTHING`,
         [opId, role, allowed]
       );
     }

     // Master data (branches, users, uom, locations, suppliers, fiscal years,
     // company profile) is hydrated by hydrateOperationalData / CACHE_LOADS —
     // called right after this seed function.
    const docCfgRes = await client.query('SELECT id, document_type AS "documentType", prefix, suffix, min_digits AS "minDigits", starting_number AS "startingNumber", next_number AS "nextNumber", reset_every_fiscal_year AS "resetEveryFiscalYear", notes FROM document_number_configs ORDER BY id ASC');
    if (docCfgRes.rows.length > 0) setDocNumberConfigs(docCfgRes.rows);

    console.log('✅ Master data seeded and hydrated. Operational data is always served from PostgreSQL (single source of truth).');
  } catch (seedErr: any) {
    console.log('PostgreSQL initial seed note:', seedErr?.message || seedErr);
  }
}

// Load the server-side permission matrix into memory from PostgreSQL.
async function loadPermissionMatrixFromDb(client: pg.PoolClient): Promise<void> {
  const result = await client.query('SELECT operation_id, role, allowed FROM permission_matrix');
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const row of result.rows) {
    const opId = row.operation_id as string;
    const role = row.role as string;
    if (!matrix[opId]) matrix[opId] = {};
    matrix[opId][role] = Boolean(row.allowed);
  }
  setPermissionMatrix(matrix);
  console.log(`✅ Server-side permission matrix loaded: ${Object.keys(matrix).length} operations mapped.`);
}

