/**
 * PostgreSQL schema sync, indexes, and initial seed.
 */
import fs from 'fs';
import path from 'path';
import * as store from '../store';
import { pgPool, isPgConnected, setPgConnected, setDbMode, getDbMode, initDatabaseConnection, isPostgresRequired, getRealPool, withTransaction } from './db';

export async function syncDatabaseAndIndexes() {
  // Establish backend mode first (real PG preferred). Throws if Postgres required & missing.
  const mode = await initDatabaseConnection();
  const requirePg = isPostgresRequired();

  if (mode === 'memory') {
    if (requirePg) {
      throw new Error('REQUIRE_POSTGRES: no SQL backend available after connection init.');
    }
    console.log('ℹ️  No SQL backend available — using JSON/memory store only.');
    setPgConnected(false);
    return;
  }

  try {
    const client = await pgPool.connect();
    if (!client) {
      if (requirePg) {
        throw new Error('REQUIRE_POSTGRES: could not obtain a PostgreSQL client for schema sync.');
      }
      console.log('ℹ️  Could not obtain SQL client — skipping schema sync.');
      return;
    }
    console.log(
      mode === 'postgres'
        ? 'PostgreSQL primary connected. Syncing schema (19 tables) & indexes...'
        : 'pg-mem backend active. Syncing schema for offline SQL compatibility...'
    );

    // CREATE EXTENSION is Postgres-only; ignore failures on pg-mem
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    } catch (_extErr) {
      // pg-mem and locked-down PG roles may not allow extensions
    }

    await client.query(`

      -- 1. Branches
      CREATE TABLE IF NOT EXISTS branches (
        id VARCHAR(50) PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(150) NOT NULL,
        location VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        is_headquarters BOOLEAN DEFAULT FALSE,
        active BOOLEAN DEFAULT TRUE,
        allow_procurement BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 2. Users
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(50) PRIMARY KEY,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(150) NOT NULL,
        role VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
        allowed_branch_ids TEXT[],
        can_switch_user BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 3. Suppliers
      CREATE TABLE IF NOT EXISTS suppliers (
        id VARCHAR(50) PRIMARY KEY,
        supplier_code VARCHAR(50),
        name VARCHAR(200) NOT NULL,
        contact_person VARCHAR(150),
        phone VARCHAR(50),
        email VARCHAR(150),
        address TEXT,
        pan_vat_number VARCHAR(50),
        rating NUMERIC(3, 1) DEFAULT 5.0,
        status VARCHAR(20) DEFAULT 'ACTIVE',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 4. Categories
      CREATE TABLE IF NOT EXISTS categories (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(150) UNIQUE NOT NULL,
        code VARCHAR(30) UNIQUE NOT NULL,
        description TEXT
      );

      -- 5. Products
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(50) PRIMARY KEY,
        sku VARCHAR(100) UNIQUE NOT NULL,
        barcode VARCHAR(100),
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        product_group VARCHAR(50) DEFAULT 'Product Item',
        unit VARCHAR(30) DEFAULT 'Pcs',
        cost_price NUMERIC(12, 2) DEFAULT 0.00,
        selling_price NUMERIC(12, 2) DEFAULT 0.00,
        tax_rate NUMERIC(5, 2) DEFAULT 13.00,
        min_reorder_level INT DEFAULT 5,
        requires_serial_tracking BOOLEAN DEFAULT FALSE,
        tracking_type VARCHAR(50) DEFAULT 'QUANTITY_ONLY',
        description TEXT,
        depreciation_method VARCHAR(50),
        depreciation_rate NUMERIC(5, 2),
        useful_life_years INT,
        salvage_value_percent NUMERIC(5, 2),
        status VARCHAR(20) DEFAULT 'ACTIVE',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 6. Inventory Stock
      CREATE TABLE IF NOT EXISTS inventory_stock (
        id VARCHAR(100) PRIMARY KEY,
        product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        quantity_on_hand INT DEFAULT 0,
        damaged_qty INT DEFAULT 0,
        reserved_qty INT DEFAULT 0,
        incoming_qty INT DEFAULT 0,
        min_reorder_level INT DEFAULT 5,
        last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_product_branch UNIQUE (product_id, branch_id)
      );

      -- 7. Fixed Assets
      CREATE TABLE IF NOT EXISTS fixed_assets (
        id VARCHAR(50) PRIMARY KEY,
        tag_number VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        acquisition_date_ad DATE NOT NULL,
        acquisition_date_bs VARCHAR(20) NOT NULL,
        acquisition_cost NUMERIC(12, 2) NOT NULL,
        depreciation_method VARCHAR(50) DEFAULT 'STRAIGHT_LINE',
        depreciation_rate_percent NUMERIC(5, 2) DEFAULT 15.00,
        accumulated_depreciation NUMERIC(12, 2) DEFAULT 0.00,
        net_book_value NUMERIC(12, 2) NOT NULL,
        status VARCHAR(30) DEFAULT 'ACTIVE',
        supplier_name VARCHAR(200),
        invoice_no VARCHAR(100),
        purchase_invoice_id VARCHAR(50),
        product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 8. Purchase Orders
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id VARCHAR(50) PRIMARY KEY,
        po_number VARCHAR(100) UNIQUE NOT NULL,
        supplier_name VARCHAR(200) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        order_date_ad DATE NOT NULL,
        order_date_bs VARCHAR(20) NOT NULL,
        expected_delivery_date_ad DATE,
        status VARCHAR(30) DEFAULT 'DRAFT',
        subtotal_amount NUMERIC(14, 2) DEFAULT 0.00,
        tax_amount NUMERIC(14, 2) DEFAULT 0.00,
        total_amount NUMERIC(14, 2) DEFAULT 0.00,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 9. Purchase Invoices
      CREATE TABLE IF NOT EXISTS purchase_invoices (
        id VARCHAR(50) PRIMARY KEY,
        invoice_number VARCHAR(100) UNIQUE NOT NULL,
        po_reference_id VARCHAR(50),
        supplier_name VARCHAR(200) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        invoice_date_ad DATE NOT NULL,
        invoice_date_bs VARCHAR(20) NOT NULL,
        due_date_ad DATE,
        due_date_bs VARCHAR(20),
        taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
        vat_amount NUMERIC(14, 2) DEFAULT 0.00,
        non_taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
        grand_total NUMERIC(14, 2) DEFAULT 0.00,
        payment_status VARCHAR(30) DEFAULT 'UNPAID',
        amount_paid NUMERIC(14, 2) DEFAULT 0.00,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 10. Shipments
      CREATE TABLE IF NOT EXISTS shipments (
        id VARCHAR(50) PRIMARY KEY,
        tracking_code VARCHAR(100) UNIQUE NOT NULL,
        type VARCHAR(50) DEFAULT 'INTER_BRANCH',
        source_branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
        source_branch_name VARCHAR(150),
        destination_branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        destination_branch_name VARCHAR(150),
        dispatch_date_ad DATE NOT NULL,
        dispatch_date_bs VARCHAR(20) NOT NULL,
        estimated_arrival_ad DATE,
        status VARCHAR(30) DEFAULT 'IN_TRANSIT',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 11. Stock Operations
      CREATE TABLE IF NOT EXISTS stock_operations (
        id VARCHAR(50) PRIMARY KEY,
        reference_number VARCHAR(100) UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        technician_name VARCHAR(150),
        work_order_ref VARCHAR(100),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        branch_name VARCHAR(150),
        destination_warehouse_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
        destination_warehouse_name VARCHAR(150),
        product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
        quantity_changed INT DEFAULT 0,
        cost_per_unit NUMERIC(12, 2) DEFAULT 0.00,
        total_value NUMERIC(12, 2) DEFAULT 0.00,
        reason TEXT NOT NULL,
        inspector_name VARCHAR(150),
        date_ad DATE NOT NULL,
        date_bs VARCHAR(20) NOT NULL,
        fiscal_year VARCHAR(20) DEFAULT '2082/83',
        status VARCHAR(30) DEFAULT 'LOGGED',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 12. Fiscal Years
      CREATE TABLE IF NOT EXISTS fiscal_years (
        id VARCHAR(50) PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        start_date_ad DATE NOT NULL,
        end_date_ad DATE NOT NULL,
        start_date_bs VARCHAR(20) NOT NULL,
        end_date_bs VARCHAR(20) NOT NULL,
        is_current BOOLEAN DEFAULT FALSE,
        is_closed BOOLEAN DEFAULT FALSE
      );

      -- 13. Audit Trail
      CREATE TABLE IF NOT EXISTS audit_logs (
        id VARCHAR(50) PRIMARY KEY,
        user_email VARCHAR(150) NOT NULL,
        user_name VARCHAR(150) NOT NULL,
        action VARCHAR(100) NOT NULL,
        module VARCHAR(50) NOT NULL,
        details TEXT,
        timestamp_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        timestamp_bs VARCHAR(20),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL
      );

      -- 14. Transaction Logs
      CREATE TABLE IF NOT EXISTS transaction_logs (
        id VARCHAR(100) PRIMARY KEY,
        transaction_number VARCHAR(100) NOT NULL,
        product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
        product_sku VARCHAR(100),
        product_name VARCHAR(255),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        change_type VARCHAR(50) NOT NULL,
        quantity_before INT NOT NULL,
        quantity_changed INT NOT NULL,
        quantity_after INT NOT NULL,
        unit_cost NUMERIC(12, 2) DEFAULT 0.00,
        reference_doc_id VARCHAR(100),
        timestamp_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        timestamp_bs VARCHAR(20)
      );

      -- 15. Customer Records
      CREATE TABLE IF NOT EXISTS customer_records (
        id VARCHAR(50) PRIMARY KEY,
        customer_id VARCHAR(50) UNIQUE NOT NULL,
        customer_name VARCHAR(200) NOT NULL,
        username VARCHAR(100),
        contact_number VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        address TEXT,
        email VARCHAR(150),
        status VARCHAR(30) DEFAULT 'ACTIVE',
        credit_limit NUMERIC(12, 2) DEFAULT 0.00,
        assigned_devices_count INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 16. Customer Device Records
      CREATE TABLE IF NOT EXISTS customer_device_records (
        id VARCHAR(50) PRIMARY KEY,
        customer_id VARCHAR(50),
        customer_name VARCHAR(200) NOT NULL,
        customer_code VARCHAR(50) NOT NULL,
        contact_phone VARCHAR(50),
        installation_address TEXT,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        product_name VARCHAR(255) NOT NULL,
        device_serial VARCHAR(100) NOT NULL,
        pon_serial VARCHAR(100) NOT NULL,
        mac_address VARCHAR(100),
        status VARCHAR(30) DEFAULT 'ACTIVE',
        issued_date_ad DATE,
        issued_date_bs VARCHAR(20),
        purchase_bill_ref VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 17. Approval Requests
      CREATE TABLE IF NOT EXISTS approval_requests (
        id VARCHAR(50) PRIMARY KEY,
        request_number VARCHAR(100) UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        target_id VARCHAR(50),
        customer_name VARCHAR(200),
        customer_code VARCHAR(50),
        device_serial VARCHAR(100),
        pon_serial VARCHAR(100),
        product_name VARCHAR(255),
        current_status VARCHAR(30),
        requested_status VARCHAR(30),
        requested_by_role VARCHAR(50),
        requested_by_email VARCHAR(150),
        requested_by_name VARCHAR(150),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        branch_name VARCHAR(150),
        reason TEXT NOT NULL,
        restock_qty_on_approval BOOLEAN DEFAULT FALSE,
        status VARCHAR(30) DEFAULT 'PENDING',
        requested_at_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        requested_at_bs VARCHAR(20),
        processed_by_email VARCHAR(150),
        processed_by_name VARCHAR(150),
        processed_by_role VARCHAR(50),
        processed_at_ad TIMESTAMP WITH TIME ZONE,
        processed_at_bs VARCHAR(20),
        rejection_reason TEXT
      );

      -- 18. BS Calendar Years
      CREATE TABLE IF NOT EXISTS bs_calendar_years (
        year_bs INT PRIMARY KEY,
        days_in_months INT[] NOT NULL,
        start_ad DATE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 19. BS Day Records
      CREATE TABLE IF NOT EXISTS bs_day_records (
        ad_date DATE PRIMARY KEY,
        bs_date VARCHAR(20) NOT NULL,
        bs_year INT NOT NULL,
        bs_month INT NOT NULL,
        bs_month_name VARCHAR(50) NOT NULL,
        bs_month_name_np VARCHAR(50) NOT NULL,
        bs_day INT NOT NULL,
        day_of_week_name VARCHAR(30) NOT NULL,
        day_of_week_name_np VARCHAR(30) NOT NULL,
        fiscal_year VARCHAR(20) NOT NULL,
        quarter VARCHAR(10) NOT NULL,
        is_weekend BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 20. UOM (Unit of Measure)
      CREATE TABLE IF NOT EXISTS uom (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        symbol VARCHAR(30) NOT NULL,
        type VARCHAR(50) DEFAULT 'Count',
        is_base_unit BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 21. Locations
      CREATE TABLE IF NOT EXISTS locations (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        type VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        address TEXT,
        coordinates JSONB,
        contact_person VARCHAR(150),
        contact_phone VARCHAR(50),
        notes TEXT,
        active_assets_count INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 22. Company Profile
      CREATE TABLE IF NOT EXISTS company_profile (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        legal_name VARCHAR(255),
        tagline VARCHAR(255),
        address TEXT NOT NULL,
        city VARCHAR(100),
        country VARCHAR(100),
        phone VARCHAR(100),
        email VARCHAR(100),
        website VARCHAR(100),
        pan_vat_number VARCHAR(100),
        registration_number VARCHAR(100),
        logo_url TEXT,
        logo_preset VARCHAR(50),
        currency_symbol VARCHAR(20),
        default_tax_rate NUMERIC,
        notes TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- SCHEMA MIGRATION SAFE ALTERS
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_by_notes TEXT;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_date_ad DATE;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_date_bs VARCHAR(20);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS has_discrepancy BOOLEAN DEFAULT FALSE;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS items JSONB;

      -- HIGH-THROUGHPUT COMPOSITE PERFORMANCE INDEXES --
      CREATE INDEX IF NOT EXISTS idx_branches_code ON branches(code);
      CREATE INDEX IF NOT EXISTS idx_branches_active ON branches(active);

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);

      CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group);

      CREATE INDEX IF NOT EXISTS idx_stock_prod_branch ON inventory_stock(product_id, branch_id);
      CREATE INDEX IF NOT EXISTS idx_stock_branch ON inventory_stock(branch_id);
      CREATE INDEX IF NOT EXISTS idx_stock_reorder ON inventory_stock(quantity_on_hand, min_reorder_level);

      CREATE INDEX IF NOT EXISTS idx_assets_tag ON fixed_assets(tag_number);
      CREATE INDEX IF NOT EXISTS idx_assets_branch ON fixed_assets(branch_id);
      CREATE INDEX IF NOT EXISTS idx_assets_status ON fixed_assets(status);

      CREATE INDEX IF NOT EXISTS idx_orders_num ON purchase_orders(po_number);
      CREATE INDEX IF NOT EXISTS idx_orders_branch ON purchase_orders(branch_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON purchase_orders(status);

      CREATE INDEX IF NOT EXISTS idx_invoices_num ON purchase_invoices(invoice_number);
      CREATE INDEX IF NOT EXISTS idx_invoices_branch ON purchase_invoices(branch_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON purchase_invoices(payment_status);

      CREATE INDEX IF NOT EXISTS idx_shipments_track ON shipments(tracking_code);
      CREATE INDEX IF NOT EXISTS idx_shipments_src_dst ON shipments(source_branch_id, destination_branch_id);
      CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);

      CREATE INDEX IF NOT EXISTS idx_stock_ops_ref ON stock_operations(reference_number);
      CREATE INDEX IF NOT EXISTS idx_stock_ops_branch ON stock_operations(branch_id);
      CREATE INDEX IF NOT EXISTS idx_stock_ops_type ON stock_operations(type);

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp_ad DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_email);
      CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module);
      CREATE INDEX IF NOT EXISTS idx_audit_branch ON audit_logs(branch_id);

      CREATE INDEX IF NOT EXISTS idx_txn_product ON transaction_logs(product_id);
      CREATE INDEX IF NOT EXISTS idx_txn_branch ON transaction_logs(branch_id);
      CREATE INDEX IF NOT EXISTS idx_txn_timestamp ON transaction_logs(timestamp_ad DESC);

      CREATE INDEX IF NOT EXISTS idx_customers_id ON customer_records(customer_id);
      CREATE INDEX IF NOT EXISTS idx_customers_branch ON customer_records(branch_id);

      CREATE INDEX IF NOT EXISTS idx_device_serials ON customer_device_records(device_serial, pon_serial, mac_address);
      CREATE INDEX IF NOT EXISTS idx_device_branch ON customer_device_records(branch_id, status);

      CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status, branch_id);
      CREATE INDEX IF NOT EXISTS idx_approval_type ON approval_requests(type);

      CREATE INDEX IF NOT EXISTS idx_bs_days_date ON bs_day_records(bs_date);
      CREATE INDEX IF NOT EXISTS idx_bs_days_ym ON bs_day_records(bs_year, bs_month);
    
    `);

    if (mode === 'postgres') {
      setPgConnected(true);
      setDbMode('postgres');
    } else {
      setPgConnected(false);
      setDbMode('pg-mem');
    }

    await seedInitialPostgresData(client);
    // Always hydrate operational collections from SQL so memory mirrors PG
    await hydrateStoreFromSql(client);

    if (typeof client.release === 'function') client.release();
    console.log(
      mode === 'postgres'
        ? '✅ PostgreSQL primary ready — schema synced, store hydrated from database.'
        : '✅ pg-mem schema synced (ephemeral).'
    );
  } catch (err: any) {
    const requirePg = isPostgresRequired();
    // Propagate hard failures when Postgres is mandatory
    if (requirePg || (err?.message || '').includes('REQUIRE_POSTGRES')) {
      setPgConnected(false);
      console.error('❌ PostgreSQL required — schema sync failed:', err?.message || err);
      throw err;
    }
    if (getDbMode() === 'postgres') {
      console.error('❌ PostgreSQL primary sync failed:', err?.message || err);
      setPgConnected(false);
      setDbMode('memory');
    } else {
      setPgConnected(false);
      console.log('Database pool note: In-memory store active with instant caching.', err?.message || err);
    }
  }
}

export async function seedInitialPostgresData(client: any) {
  try {
    for (const b of store.INITIAL_MASTER_BRANCHES) {
      await client.query(
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.code, b.name, b.location, b.phone || '', b.isHeadquarters || false, b.active !== false, b.allowProcurement !== false]
      );
    }
    for (const fy of store.INITIAL_MASTER_FISCAL_YEARS) {
      await client.query(
        `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [fy.id, fy.code, fy.startDateAD || '2025-07-16', fy.endDateAD || '2026-07-15', fy.startDateBS || '2082-04-01', fy.endDateBS || '2083-03-31', fy.isCurrent || false, fy.isClosed || false]
      );
    }
    // Seed Company Profile if empty
    await client.query(
      `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, default_tax_rate, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) ON CONFLICT (id) DO NOTHING`,
      [
        store.INITIAL_COMPANY_PROFILE.id,
        store.INITIAL_COMPANY_PROFILE.name,
        store.INITIAL_COMPANY_PROFILE.legalName,
        store.INITIAL_COMPANY_PROFILE.tagline,
        store.INITIAL_COMPANY_PROFILE.address,
        store.INITIAL_COMPANY_PROFILE.city,
        store.INITIAL_COMPANY_PROFILE.country,
        store.INITIAL_COMPANY_PROFILE.phone,
        store.INITIAL_COMPANY_PROFILE.email,
        store.INITIAL_COMPANY_PROFILE.website,
        store.INITIAL_COMPANY_PROFILE.panVatNumber,
        store.INITIAL_COMPANY_PROFILE.registrationNumber,
        store.INITIAL_COMPANY_PROFILE.logoUrl,
        store.INITIAL_COMPANY_PROFILE.logoPreset,
        store.INITIAL_COMPANY_PROFILE.currencySymbol,
        store.INITIAL_COMPANY_PROFILE.defaultTaxRate,
        store.INITIAL_COMPANY_PROFILE.notes,
      ]
    );

    for (const u of store.INITIAL_MASTER_UOM) {
      await client.query(
        `INSERT INTO uom (id, name, symbol, type, is_base_unit)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [u.id, u.name, u.symbol, u.type, u.isBaseUnit]
      );
    }
    for (const l of store.INITIAL_MASTER_LOCATIONS) {
      await client.query(
        `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [l.id, l.name, l.type, l.branchId, l.address, JSON.stringify(l.coordinates), l.contactPerson, l.contactPhone, l.notes, l.activeAssetsCount]
      );
    }

    if (store.users.length > 0) {
      for (const u of store.users) {
        await client.query(
          `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [u.id, u.email, u.password, u.name, u.role, u.branchId, u.allowedBranchIds || [], u.canSwitchUser || false]
        );
      }
    }

    // Hydrate all master data from PostgreSQL
    const bRes = await client.query('SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches ORDER BY code');
    if (bRes.rows.length > 0) store.replaceCollection('branches', bRes.rows);

    const dbUsersRes = await client.query(
      'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC'
    );
    if (dbUsersRes.rows.length > 0) {
      store.replaceCollection('users', dbUsersRes.rows);
      if (!store.activeUser) store.setActiveUser(store.users[0]);
    }

    const fyRes = await client.query('SELECT id, code, start_date_ad AS "startDateAD", end_date_ad AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed" FROM fiscal_years ORDER BY id');
    if (fyRes.rows.length > 0) store.replaceCollection('fiscalYears', fyRes.rows);

    const uomRes = await client.query('SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC');
    if (uomRes.rows.length > 0) store.replaceCollection('uomList', uomRes.rows);

    const locRes = await client.query('SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations ORDER BY name ASC');
    if (locRes.rows.length > 0) store.replaceCollection('locationRecords', locRes.rows);

    const supDbRes = await client.query('SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC');
    if (supDbRes.rows.length > 0) store.replaceCollection('suppliers', supDbRes.rows);

    const compRes = await client.query('SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1');
    if (compRes.rows.length > 0) store.setCompanyProfile(compRes.rows[0]);

    // Only populate operational sample inventory/orders if SEED_DUMMY_DATA=true is explicitly set
    if (process.env.SEED_DUMMY_DATA !== 'true') {
      console.log('ℹ️ Clean DB mode active (SEED_DUMMY_DATA is not set). Operational tables initialized empty.');
      return;
    }

    for (const s of store.suppliers) {
      const sup = s as any;
      await client.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [sup.id, sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', sup.rating || 5.0, sup.status || 'ACTIVE']
      );
    }
    const categoryList = Array.from(new Set(store.products.map((p) => p.category))).map((cat, idx) => ({
      id: `cat-${idx + 1}`,
      name: cat,
      code: cat.toUpperCase().replace(/\s+/g, '_').slice(0, 10),
      description: `${cat} Inventory Category`,
    }));
    for (const c of categoryList) {
      await client.query(
        `INSERT INTO categories (id, name, code, description)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [c.id, c.name, c.code, c.description]
      );
    }
    for (const p of store.products) {
      const prod = p as any;
      await client.query(
        `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (id) DO NOTHING`,
        [
          prod.id, prod.sku, prod.barcode || '', prod.name, prod.category, prod.productGroup || 'Product Item', prod.unit || 'Pcs',
          prod.costPrice || 0, prod.sellingPrice || 0, prod.taxRate || 13.0, prod.minReorderLevel || 5, prod.requiresSerialTracking || false,
          prod.trackingType || 'QUANTITY_ONLY', prod.description || '', prod.status || 'ACTIVE'
        ]
      );
    }
    for (const st of store.inventoryStock) {
      await client.query(
        `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [st.id, st.productId, st.branchId, st.quantityOnHand || 0, st.damagedQty || 0, st.reservedQty || 0, st.incomingQty || 0, st.minReorderLevel || 5]
      );
    }
    for (const a of store.assetRegister) {
      await client.query(
        `INSERT INTO fixed_assets (id, tag_number, name, category, branch_id, acquisition_date_ad, acquisition_date_bs, acquisition_cost, depreciation_method, depreciation_rate_percent, accumulated_depreciation, net_book_value, status, supplier_name, invoice_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (id) DO NOTHING`,
        [
          a.id, a.tagNumber, a.name, a.category, a.branchId, a.acquisitionDateAD || '2025-01-01', a.acquisitionDateBS || '2081-09-17',
          a.acquisitionCost || 0, a.depreciationMethod || 'STRAIGHT_LINE', a.depreciationRatePercent || 15.0,
          a.accumulatedDepreciation || 0, a.netBookValue || 0, a.status || 'ACTIVE', a.supplierName || '', a.invoiceNo || ''
        ]
      );
    }
    for (const po of store.purchaseOrders) {
      await client.query(
        `INSERT INTO purchase_orders (id, po_number, supplier_name, branch_id, order_date_ad, order_date_bs, expected_delivery_date_ad, status, subtotal_amount, tax_amount, total_amount, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
        [
          po.id, po.poNumber, po.supplierName, po.branchId, po.orderDateAD || '2025-01-01', po.orderDateBS || '2081-09-17',
          po.expectedDeliveryDateAD || '2025-01-10', po.status || 'DRAFT', po.subtotalAmount || 0, po.taxAmount || 0,
          po.totalAmount || 0, po.notes || ''
        ]
      );
    }
    for (const inv of store.purchaseInvoices) {
      await client.query(
        `INSERT INTO purchase_invoices (id, invoice_number, po_reference_id, supplier_name, branch_id, invoice_date_ad, invoice_date_bs, taxable_amount, vat_amount, non_taxable_amount, grand_total, payment_status, amount_paid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (id) DO NOTHING`,
        [
          inv.id, inv.invoiceNumber, inv.poReferenceId || '', inv.supplierName, inv.branchId, inv.invoiceDateAD || '2025-01-01',
          inv.invoiceDateBS || '2081-09-17', inv.taxableAmount || 0, inv.vatAmount || 0, inv.nonTaxableAmount || 0,
          inv.grandTotal || 0, inv.paymentStatus || 'UNPAID', inv.amountPaid || 0
        ]
      );
    }
    for (const cust of store.customerMasterRecords) {
      await client.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
        [
          cust.id, cust.customerId, cust.customerName, cust.username || '', cust.contactNumber || '', cust.branchId,
          cust.address || '', cust.email || '', cust.status || 'ACTIVE', cust.creditLimit || 0, cust.assignedDevicesCount || 0
        ]
      );
    }
    for (const dev of store.customerDeviceRecords) {
      await client.query(
        `INSERT INTO customer_device_records (id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (id) DO NOTHING`,
        [
          dev.id, dev.customerId || '', dev.customerName, dev.customerCode, dev.contactPhone || '', dev.installationAddress || '',
          dev.branchId, dev.productName, dev.deviceSerial, dev.ponSerial, dev.macAddress || '', dev.status || 'ACTIVE',
          dev.issuedDateAD || '2025-01-01', dev.issuedDateBS || '2081-09-17', dev.purchaseBillRef || '', dev.notes || ''
        ]
      );
    }
    for (const app of store.approvalRequests) {
      await client.query(
        `INSERT INTO approval_requests (id, request_number, type, target_id, customer_name, customer_code, device_serial, pon_serial, product_name, current_status, requested_status, requested_by_role, requested_by_email, requested_by_name, branch_id, branch_name, reason, restock_qty_on_approval, status, requested_at_ad, requested_at_bs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) ON CONFLICT (id) DO NOTHING`,
        [
          app.id, app.requestNumber, app.type, app.targetId || '', app.customerName || '', app.customerCode || '',
          app.deviceSerial || '', app.ponSerial || '', app.productName || '', app.currentStatus || '', app.requestedStatus || '',
          app.requestedByRole || '', app.requestedByEmail || '', app.requestedByName || '', app.branchId, app.branchName || '',
          app.reason || '', app.restockQtyOnApproval || false, app.status || 'PENDING', app.requestedAtAD || new Date().toISOString(), app.requestedAtBS || '2081-09-17'
        ]
      );
    }
    console.log('✅ Initial PostgreSQL seed data loaded successfully.');
  } catch (seedErr: any) {
    console.log('PostgreSQL initial seed note:', seedErr?.message || seedErr);
  }
}

/**
 * Load all domain collections from the active SQL backend into the in-memory store.
 * Called after schema sync so route handlers that read from `store.*` see PG data.
 */
export async function hydrateStoreFromSql(client?: any) {
  const c = client || pgPool;
  try {
    const run = (sql: string, params?: any[]) =>
      client && typeof client.query === 'function'
        ? client.query(sql, params)
        : pgPool.query(sql, params);

    // Masters (refresh even if seed already did — keeps a single path)
    try {
      const bRes = await run(
        'SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement", is_warehouse AS "isWarehouse" FROM branches ORDER BY code'
      );
      if (bRes.rows?.length) store.replaceCollection('branches', bRes.rows);
    } catch (_e) {
      const bRes = await run(
        'SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches ORDER BY code'
      );
      if (bRes.rows?.length) store.replaceCollection('branches', bRes.rows);
    }

    const uRes = await run(
      'SELECT id, email, password, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC'
    );
    if (uRes.rows?.length) store.replaceCollection('users', uRes.rows);

    const fyRes = await run(
      'SELECT id, code, start_date_ad AS "startDateAD", end_date_ad AS "endDateAD", start_date_bs AS "startDateBS", end_date_bs AS "endDateBS", is_current AS "isCurrent", is_closed AS "isClosed" FROM fiscal_years ORDER BY id'
    );
    if (fyRes.rows?.length) store.replaceCollection('fiscalYears', fyRes.rows);

    try {
      const uomRes = await run(
        'SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC'
      );
      if (uomRes.rows?.length) store.replaceCollection('uomList', uomRes.rows);
    } catch (_e) {}

    try {
      const locRes = await run(
        'SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations ORDER BY name ASC'
      );
      if (locRes.rows?.length) {
        const rows = locRes.rows.map((r: any) => ({
          ...r,
          coordinates:
            typeof r.coordinates === 'string'
              ? JSON.parse(r.coordinates || 'null')
              : r.coordinates,
        }));
        store.replaceCollection('locationRecords', rows);
      }
    } catch (_e) {}

    const supRes = await run(
      'SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC'
    );
    if (supRes.rows) store.replaceCollection('suppliers', supRes.rows);

    try {
      const compRes = await run(
        'SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1'
      );
      if (compRes.rows?.length) store.setCompanyProfile(compRes.rows[0]);
    } catch (_e) {}

    // Operational
    try {
      const catRes = await run('SELECT id, name, code, description FROM categories ORDER BY name ASC');
      if (catRes.rows) store.replaceCollection('categories', catRes.rows);
    } catch (_e) {}

    try {
      const pRes = await run(
        `SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit,
                cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate",
                min_reorder_level AS "minReorderLevel",
                requires_serial_tracking AS "requiresSerialTracking",
                tracking_type AS "trackingType", description, status,
                depreciation_method AS "depreciationMethod",
                depreciation_rate AS "depreciationRate",
                useful_life_years AS "usefulLifeYears",
                salvage_value_percent AS "salvageValuePercent",
                image_url AS "imageUrl"
         FROM products ORDER BY name ASC`
      );
      if (pRes.rows) {
        store.replaceCollection(
          'products',
          pRes.rows.map((r: any) => ({
            ...r,
            costPrice: Number(r.costPrice) || 0,
            sellingPrice: Number(r.sellingPrice) || 0,
            taxRate: Number(r.taxRate) || 0,
            minReorderLevel: Number(r.minReorderLevel) || 0,
          }))
        );
      }
    } catch (_e) {}

    try {
      const sRes = await run(
        `SELECT id, product_id AS "productId", branch_id AS "branchId",
                quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty",
                reserved_qty AS "reservedQty", incoming_qty AS "incomingQty",
                min_reorder_level AS "minReorderLevel",
                last_updated AS "lastUpdated"
         FROM inventory_stock`
      );
      if (sRes.rows) {
        store.replaceCollection(
          'inventoryStock',
          sRes.rows.map((r: any) => ({
            ...r,
            quantityOnHand: Number(r.quantityOnHand) || 0,
            damagedQty: Number(r.damagedQty) || 0,
            reservedQty: Number(r.reservedQty) || 0,
            incomingQty: Number(r.incomingQty) || 0,
            minReorderLevel: r.minReorderLevel != null ? Number(r.minReorderLevel) : undefined,
            lastUpdated: r.lastUpdated
              ? new Date(r.lastUpdated).toISOString()
              : new Date().toISOString(),
          }))
        );
      }
    } catch (_e) {}

    try {
      const aRes = await run(
        `SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId",
                acquisition_date_ad AS "acquisitionDateAD", acquisition_date_bs AS "acquisitionDateBS",
                acquisition_cost AS "acquisitionCost",
                depreciation_method AS "depreciationMethod",
                depreciation_rate_percent AS "depreciationRatePercent",
                accumulated_depreciation AS "accumulatedDepreciation",
                net_book_value AS "netBookValue", status,
                supplier_name AS "supplierName", invoice_no AS "invoiceNo",
                product_id AS "productId"
         FROM fixed_assets`
      );
      if (aRes.rows) {
        store.replaceCollection(
          'assetRegister',
          aRes.rows.map((r: any) => ({
            ...r,
            acquisitionCost: Number(r.acquisitionCost) || 0,
            depreciationRatePercent: Number(r.depreciationRatePercent) || 0,
            accumulatedDepreciation: Number(r.accumulatedDepreciation) || 0,
            netBookValue: Number(r.netBookValue) || 0,
          }))
        );
      }
    } catch (_e) {}

    const parseJson = (v: any, fallback: any = []) => {
      if (v == null) return fallback;
      if (typeof v === 'object') return v;
      try {
        return JSON.parse(v);
      } catch {
        return fallback;
      }
    };

    try {
      const poRes = await run(
        `SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId",
                order_date_ad AS "orderDateAD", order_date_bs AS "orderDateBS",
                expected_delivery_date_ad AS "expectedDeliveryDateAD", status,
                subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount",
                total_amount AS "totalAmount", notes, items
         FROM purchase_orders ORDER BY created_at DESC NULLS LAST`
      );
      if (poRes.rows) {
        store.replaceCollection(
          'purchaseOrders',
          poRes.rows.map((r: any) => ({
            ...r,
            items: parseJson(r.items, []),
            subtotalAmount: Number(r.subtotalAmount) || 0,
            taxAmount: Number(r.taxAmount) || 0,
            totalAmount: Number(r.totalAmount) || 0,
          }))
        );
      }
    } catch (_e) {}

    try {
      const invRes = await run(
        `SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId",
                supplier_name AS "supplierName", branch_id AS "branchId",
                invoice_date_ad AS "invoiceDateAD", invoice_date_bs AS "invoiceDateBS",
                due_date_ad AS "dueDateAD", due_date_bs AS "dueDateBS",
                taxable_amount AS "taxableAmount", vat_amount AS "vatAmount",
                non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal",
                payment_status AS "paymentStatus", amount_paid AS "amountPaid",
                notes, items
         FROM purchase_invoices ORDER BY created_at DESC NULLS LAST`
      );
      if (invRes.rows) {
        store.replaceCollection(
          'purchaseInvoices',
          invRes.rows.map((r: any) => ({
            ...r,
            items: parseJson(r.items, []),
            taxableAmount: Number(r.taxableAmount) || 0,
            vatAmount: Number(r.vatAmount) || 0,
            nonTaxableAmount: Number(r.nonTaxableAmount) || 0,
            grandTotal: Number(r.grandTotal) || 0,
            amountPaid: Number(r.amountPaid) || 0,
          }))
        );
      }
    } catch (_e) {}

    try {
      const shRes = await run(
        `SELECT id, tracking_code AS "trackingCode", type,
                source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName",
                destination_branch_id AS "destinationBranchId",
                destination_branch_name AS "destinationBranchName",
                dispatch_date_ad AS "dispatchDateAD", dispatch_date_bs AS "dispatchDateBS",
                estimated_arrival_ad AS "estimatedArrivalAD", status, notes, items,
                received_by_notes AS "receivedByNotes",
                received_date_ad AS "receivedDateAD", received_date_bs AS "receivedDateBS",
                has_discrepancy AS "hasDiscrepancy"
         FROM shipments ORDER BY created_at DESC NULLS LAST`
      );
      if (shRes.rows) {
        store.replaceCollection(
          'shipments',
          shRes.rows.map((r: any) => ({ ...r, items: parseJson(r.items, []) }))
        );
      }
    } catch (_e) {}

    try {
      const opRes = await run(
        `SELECT id, reference_number AS "referenceNumber", type,
                technician_name AS "technicianName", work_order_ref AS "workOrderRef",
                branch_id AS "branchId", branch_name AS "branchName",
                destination_warehouse_id AS "destinationWarehouseId",
                destination_warehouse_name AS "destinationWarehouseName",
                product_id AS "productId", product_name AS "productName",
                quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit",
                total_value AS "totalValue", reason, inspector_name AS "inspectorName",
                date_ad AS "dateAD", date_bs AS "dateBS", fiscal_year AS "fiscalYear",
                status, items
         FROM stock_operations ORDER BY created_at DESC NULLS LAST`
      );
      if (opRes.rows) {
        store.replaceCollection(
          'stockOperations',
          opRes.rows.map((r: any) => ({
            ...r,
            items: parseJson(r.items, undefined),
            quantityChanged: Number(r.quantityChanged) || 0,
            costPerUnit: Number(r.costPerUnit) || 0,
            totalValue: Number(r.totalValue) || 0,
          }))
        );
      }
    } catch (_e) {}

    try {
      const cRes = await run(
        `SELECT id, customer_id AS "customerId", customer_name AS "customerName",
                username, contact_number AS "contactNumber", branch_id AS "branchId",
                address, email, status, credit_limit AS "creditLimit",
                assigned_devices_count AS "assignedDevicesCount"
         FROM customer_records ORDER BY customer_name ASC`
      );
      if (cRes.rows) store.replaceCollection('customerMasterRecords', cRes.rows);
    } catch (_e) {}

    try {
      const dRes = await run(
        `SELECT id, customer_id AS "customerId", customer_name AS "customerName",
                customer_code AS "customerCode", contact_phone AS "contactPhone",
                installation_address AS "installationAddress", branch_id AS "branchId",
                product_name AS "productName", device_serial AS "deviceSerial",
                pon_serial AS "ponSerial", mac_address AS "macAddress", status,
                issued_date_ad AS "issuedDateAD", issued_date_bs AS "issuedDateBS",
                purchase_bill_ref AS "purchaseBillRef", notes,
                warranty_months AS "warrantyMonths",
                warranty_end_date_ad AS "warrantyEndDateAD"
         FROM customer_device_records ORDER BY issued_date_ad DESC NULLS LAST`
      );
      if (dRes.rows) store.replaceCollection('customerDeviceRecords', dRes.rows);
    } catch (_e) {}

    try {
      const apRes = await run(
        `SELECT id, request_number AS "requestNumber", type, target_id AS "targetId",
                customer_name AS "customerName", customer_code AS "customerCode",
                device_serial AS "deviceSerial", pon_serial AS "ponSerial",
                product_name AS "productName", current_status AS "currentStatus",
                requested_status AS "requestedStatus",
                requested_by_role AS "requestedByRole",
                requested_by_email AS "requestedByEmail",
                requested_by_name AS "requestedByName",
                branch_id AS "branchId", branch_name AS "branchName", reason,
                restock_qty_on_approval AS "restockQtyOnApproval", status,
                requested_at_ad AS "requestedAtAD", requested_at_bs AS "requestedAtBS",
                processed_by_email AS "processedByEmail",
                processed_by_name AS "processedByName",
                processed_at_ad AS "processedAtAD", processed_at_bs AS "processedAtBS",
                rejection_reason AS "rejectionReason"
         FROM approval_requests ORDER BY requested_at_ad DESC NULLS LAST`
      );
      if (apRes.rows) store.replaceCollection('approvalRequests', apRes.rows);
    } catch (_e) {}

    try {
      const audRes = await run(
        `SELECT id, user_email AS "userEmail", user_name AS "userName", action, module,
                details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS",
                branch_id AS "branchId"
         FROM audit_logs ORDER BY timestamp_ad DESC LIMIT 500`
      );
      if (audRes.rows) store.replaceCollection('auditTrail', audRes.rows);
    } catch (_e) {}

    try {
      const txnRes = await run(
        `SELECT id, transaction_number AS "transactionNumber", product_id AS "productId",
                product_sku AS "productSku", product_name AS "productName",
                branch_id AS "branchId", change_type AS "changeType",
                quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged",
                quantity_after AS "quantityAfter", unit_cost AS "unitCost",
                reference_doc_id AS "referenceDocId",
                timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS"
         FROM transaction_logs ORDER BY timestamp_ad DESC LIMIT 1000`
      );
      if (txnRes.rows) {
        store.replaceCollection(
          'transactionLogs',
          txnRes.rows.map((r: any) => ({
            ...r,
            quantityBefore: Number(r.quantityBefore) || 0,
            quantityChanged: Number(r.quantityChanged) || 0,
            quantityAfter: Number(r.quantityAfter) || 0,
            unitCost: Number(r.unitCost) || 0,
          }))
        );
      }
    } catch (_e) {}

    // Persist a local mirror for faster cold starts / offline continuity
    store.saveDataStore();
    console.log(
      `📦 Store hydrated from SQL — users:${store.users.length} products:${store.products.length} stock:${store.inventoryStock.length} branches:${store.branches.length}`
    );
  } catch (err: any) {
    console.warn('Store hydration warning:', err?.message || err);
  }
}
