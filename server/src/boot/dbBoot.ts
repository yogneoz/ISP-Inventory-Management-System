/**
 * Database boot module extracted from app.ts (backlog item #6 — app.ts
 * extraction). Owns the full PostgreSQL schema sync (30 tables, indexes,
 * constraints, fiscal-year triggers), initial seeding, the operational cache
 * load list (CACHE_LOADS), boot-time hydration, and the serial-log backfill.
 *
 * Shared-state interactions are injected via BootStateDeps so this module
 * never imports app.ts (no cycles).
 */
import pg from 'pg';
import { pgPool, realPoolInstance, setIsPgConnected } from '../../db';
import { setPgConnected as setPgConnectedFlag } from '../state/runtimeState';
import { hydrateBsCalendarFromDb } from '../config/bsCalendar';
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
companyProfile, docNumberConfigs, users, suppliers, uomList, locationRecords,
branches, fiscalYears, products, categories, inventoryStock, assetRegister,
purchaseOrders, purchaseInvoices, shipments, stockOperations, auditTrail,
transactionLogs, customerMasterRecords, customerDeviceRecords, vendorPayments,
serialLogs, permissionMatrix, getPgConnected,
setCompanyProfile, setDocNumberConfigs, setUsers, setSuppliers, setUomList,
setLocationRecords, setBranches, setFiscalYears, setProducts, setCategories,
setInventoryStock, setAssetRegister, setPurchaseOrders, setPurchaseInvoices,
setShipments, setStockOperations, setAuditTrail, setTransactionLogs,
setCustomerMasterRecords, setCustomerDeviceRecords, setVendorPayments,
setSerialLogs, setPermissionMatrix, CACHE_LOADS, hydrateOperationalData,
refreshOperationalCache,
} from '../state/runtimeState';


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
    console.log('PostgreSQL Pool connected successfully. Syncing full database schema (30 tables) & creating high-throughput performance indexes...');

    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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
        allow_warehouse_transfer BOOLEAN DEFAULT TRUE,
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
        description TEXT,
        is_special_tracked BOOLEAN NOT NULL DEFAULT FALSE
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

      -- 7. Damage Records (damage lifecycle: identified -> disposed/written-off)
      CREATE TABLE IF NOT EXISTS damage_records (
        id VARCHAR(50) PRIMARY KEY,
        damage_reference VARCHAR(100) UNIQUE NOT NULL,
        product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        quantity_damaged INT NOT NULL CHECK (quantity_damaged > 0),
        unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
        total_cost NUMERIC(15, 2) NOT NULL DEFAULT 0,
        damage_date_ad DATE NOT NULL,
        damage_date_bs VARCHAR(20) NOT NULL,
        damage_reason VARCHAR(100) NOT NULL CHECK (damage_reason IN ('PHYSICAL_DAMAGE', 'TRANSIT_DAMAGE', 'STORAGE_DAMAGE', 'EXPIRED', 'RETURN_DAMAGE', 'QUALITY_DEFECT', 'OTHER')),
        status VARCHAR(30) NOT NULL DEFAULT 'IDENTIFIED' CHECK (status IN ('IDENTIFIED', 'UNDER_REVIEW', 'DISPOSED', 'WRITTEN_OFF', 'RETURNED_TO_SUPPLIER', 'CANCELLED')),
        disposal_date_ad DATE,
        disposal_date_bs VARCHAR(20),
        disposal_method VARCHAR(50) CHECK (disposal_method IN ('SCRAP_DESTRUCTION', 'SALVAGE_E_WASTE', 'VENDOR_RMA', 'INSURANCE_CLAIM', 'WRITE_OFF', 'RETURN_TO_SUPPLIER', 'AUCTION')),
        salvage_value NUMERIC(15, 2) DEFAULT 0,
        gl_account_code VARCHAR(100),
        write_off_loss NUMERIC(15, 2) DEFAULT 0,
        approved_by VARCHAR(150),
        notes TEXT,
        fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(150),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_damage_records_product ON damage_records(product_id);
      CREATE INDEX IF NOT EXISTS idx_damage_records_branch ON damage_records(branch_id);
      CREATE INDEX IF NOT EXISTS idx_damage_records_status ON damage_records(status);
      CREATE INDEX IF NOT EXISTS idx_damage_records_fiscal_year ON damage_records(fiscal_year_id);
      CREATE INDEX IF NOT EXISTS idx_damage_records_demo ON damage_records(id) WHERE is_demo = TRUE;

      -- 8. Fixed Assets
      CREATE TABLE IF NOT EXISTS fixed_assets (
        id VARCHAR(50) PRIMARY KEY,
        tag_number VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        acquisition_date_ad DATE NOT NULL,
        acquisition_date_bs VARCHAR(20) NOT NULL,
        purchase_invoice_date_ad DATE,
        purchase_invoice_date_bs VARCHAR(20),
        capitalization_date_ad DATE,
        placed_in_service_date_ad DATE,
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
        supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier_name VARCHAR(200) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        order_date_ad DATE NOT NULL,
        order_date_bs VARCHAR(20) NOT NULL,
        expected_delivery_date_ad DATE,
        status VARCHAR(30) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'SENT', 'IN_PROGRESS', 'PURCHASED', 'RECEIVED', 'CANCELLED')),
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
        vendor_bill_number VARCHAR(100),
        supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
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
        payment_status VARCHAR(30) DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PARTIAL', 'PAID')),
        payment_method VARCHAR(30) DEFAULT 'CREDIT' CHECK (payment_method IN ('CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE')),
        amount_paid NUMERIC(14, 2) DEFAULT 0.00,
        notes TEXT,
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
        is_closed BOOLEAN DEFAULT FALSE,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE
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

      -- 16b. Serial Log (one row per unique serial, consolidated view)
      CREATE TABLE IF NOT EXISTS serial_log (
        id VARCHAR(50) PRIMARY KEY,
        device_serial VARCHAR(100) NOT NULL,
        pon_serial VARCHAR(100),
        mac_address VARCHAR(100),
        product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255),
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        customer_id VARCHAR(50),
        customer_name VARCHAR(200),
        status VARCHAR(30) NOT NULL DEFAULT 'IN_STOCK',
        source_type VARCHAR(30) NOT NULL DEFAULT 'PURCHASE',
        source_id VARCHAR(50),
        history_json TEXT DEFAULT '[]',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE
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
        postal_code VARCHAR(30),
        phone VARCHAR(100),
        email VARCHAR(100),
        website VARCHAR(100),
        pan_vat_number VARCHAR(100),
        registration_number VARCHAR(100),
        logo_url TEXT,
        logo_preset VARCHAR(50),
        currency_symbol VARCHAR(20),
        currency_code VARCHAR(10) DEFAULT 'NPR',
        currency_locale VARCHAR(20) DEFAULT 'en-IN',
        currency_position VARCHAR(10) DEFAULT 'before',
        currency_decimals INT DEFAULT 2,
        default_tax_rate NUMERIC,
        notes TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 23. Document Numbering Configurations
      CREATE TABLE IF NOT EXISTS document_number_configs (
        id VARCHAR(50) PRIMARY KEY,
        document_type VARCHAR(150) NOT NULL,
        prefix VARCHAR(50) DEFAULT '',
        suffix VARCHAR(50) DEFAULT '',
        min_digits INT DEFAULT 4,
        starting_number INT DEFAULT 1,
        next_number INT DEFAULT 1,
        reset_every_fiscal_year BOOLEAN DEFAULT TRUE,
        notes TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 23b. Daily Document Sequence Counters (per branch, per doc type, per day)
      CREATE TABLE IF NOT EXISTS document_sequence_daily (
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
        doc_type VARCHAR(20) NOT NULL,
        date_ad DATE NOT NULL,
        next_number INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (branch_id, doc_type, date_ad)
      );
      CREATE INDEX IF NOT EXISTS idx_document_sequence_daily_branch ON document_sequence_daily(branch_id);
      CREATE INDEX IF NOT EXISTS idx_document_sequence_daily_date ON document_sequence_daily(date_ad);

      -- SCHEMA MIGRATION SAFE ALTERS
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS vendor_bill_number VARCHAR(100);
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS status_override VARCHAR(30);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) DEFAULT 'CREDIT';
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS items JSONB;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_by_notes TEXT;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_date_ad DATE;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS received_date_bs VARCHAR(20);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS has_discrepancy BOOLEAN DEFAULT FALSE;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS items JSONB;
      -- Currency & locale columns for globally-configurable money formatting.
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS postal_code VARCHAR(30);
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10) DEFAULT 'NPR';
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS currency_locale VARCHAR(20) DEFAULT 'en-IN';
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS currency_position VARCHAR(10) DEFAULT 'before';
      ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS currency_decimals INT DEFAULT 2;
      -- Backfill an existing profile that only had the old symbol column.
      UPDATE company_profile SET
        currency_code = 'NPR',
        currency_locale = 'en-IN',
        currency_position = 'before',
        currency_decimals = 2
        WHERE currency_code IS NULL OR currency_code = '';
      -- Drop the stale hard-coded fiscal-year default (fiscal year is now
      -- derived from the record date at write time).
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_operations' AND column_name = 'fiscal_year' AND column_default IS NOT NULL) THEN
          ALTER TABLE stock_operations ALTER COLUMN fiscal_year DROP DEFAULT;
        END IF;
      END $$;
      ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_module_check;
      ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_module_check CHECK (module IN (
        'AUTH', 'MASTER_DATA', 'PRODUCTS', 'CATEGORIES', 'PROCUREMENT', 'LOGISTICS',
        'STOCK_OPERATIONS', 'FIXED_ASSETS', 'CPE_MANAGEMENT', 'INVENTORY', 'INVENTORY_AUDIT',
        'OPERATIONS', 'BRANCH_OPERATIONS', 'FISCAL_YEAR', 'APPROVAL_WORKFLOW', 'SYSTEM'
      ));
      CREATE TABLE IF NOT EXISTS fiscal_year_opening_stock (
        id VARCHAR(100) PRIMARY KEY,
        fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
        product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        quantity_on_hand INT NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
        damaged_qty INT NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
        unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
        source_type VARCHAR(30) NOT NULL DEFAULT 'FISCAL_CLOSE',
        source_reference VARCHAR(100),
        posted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        posted_by VARCHAR(150),
        UNIQUE (fiscal_year_id, product_id, branch_id)
      );

      -- 24. Fiscal-Year Vendor Opening Balances (Vendor Ledger roll-forward)
      CREATE TABLE IF NOT EXISTS vendor_opening_balances (
        id VARCHAR(100) PRIMARY KEY,
        fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
        supplier_id VARCHAR(50) NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        opening_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
        source_type VARCHAR(30) NOT NULL DEFAULT 'FISCAL_CLOSE',
        source_reference VARCHAR(100),
        posted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        posted_by VARCHAR(150),
        is_demo BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(150),
        UNIQUE (fiscal_year_id, supplier_id, branch_id)
      );

      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS source_type VARCHAR(30) NOT NULL DEFAULT 'FISCAL_CLOSE';
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS source_reference VARCHAR(100);
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS posted_by VARCHAR(150);
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      CREATE INDEX IF NOT EXISTS idx_vendor_opening_fy ON vendor_opening_balances(fiscal_year_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_opening_supplier ON vendor_opening_balances(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_opening_branch ON vendor_opening_balances(branch_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_opening_demo ON vendor_opening_balances(id) WHERE is_demo = TRUE;

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
      CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON purchase_invoices(supplier_id);
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

      -- Exactly one fiscal year may be flagged current (prevents the
      -- ambiguous-default bug where two rows had is_current = TRUE).
      DROP INDEX IF EXISTS uq_fiscal_years_single_current;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_years_single_current ON fiscal_years ((is_current)) WHERE is_current = TRUE;

      -- Fiscal-year/branch scoped bootstrap query support
      CREATE INDEX IF NOT EXISTS idx_po_branch_order_date ON purchase_orders(branch_id, order_date_ad);
      CREATE INDEX IF NOT EXISTS idx_pi_branch_invoice_date ON purchase_invoices(branch_id, invoice_date_ad);
      CREATE INDEX IF NOT EXISTS idx_shipments_dispatch_date ON shipments(dispatch_date_ad);
      CREATE INDEX IF NOT EXISTS idx_assets_acquisition_date ON fixed_assets(acquisition_date_ad);
      CREATE INDEX IF NOT EXISTS idx_devices_issued_date ON customer_device_records(issued_date_ad);
      CREATE INDEX IF NOT EXISTS idx_stock_ops_date ON stock_operations(date_ad);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp_ad DESC);

      -- v3.0 enterprise migration: demo tracking (is_demo), audit columns
      -- (created_by/updated_by/updated_at) and fiscal_year_id FKs tying every
      -- transactional document to the fiscal_years master table.
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_special_tracked BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE fiscal_years ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS purchase_invoice_date_ad DATE;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS purchase_invoice_date_bs VARCHAR(20);
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS capitalization_date_ad DATE;
      ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS placed_in_service_date_ad DATE;
      UPDATE fixed_assets SET purchase_invoice_date_ad = acquisition_date_ad WHERE purchase_invoice_date_ad IS NULL;
      UPDATE fixed_assets SET purchase_invoice_date_bs = acquisition_date_bs WHERE purchase_invoice_date_bs IS NULL;
      UPDATE fixed_assets SET capitalization_date_ad = acquisition_date_ad WHERE capitalization_date_ad IS NULL;
      UPDATE fixed_assets SET placed_in_service_date_ad = acquisition_date_ad WHERE placed_in_service_date_ad IS NULL;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      -- 24. Vendor Payments Sub-ledger
      CREATE TABLE IF NOT EXISTS vendor_payments (
        id VARCHAR(50) PRIMARY KEY,
        payment_number VARCHAR(100) UNIQUE NOT NULL,
        supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier_name VARCHAR(200) NOT NULL,
        branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
        invoice_id VARCHAR(50) REFERENCES purchase_invoices(id) ON DELETE SET NULL,
        invoice_number VARCHAR(100),
        payment_date_ad DATE NOT NULL,
        payment_date_bs VARCHAR(20),
        amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
        payment_method VARCHAR(30) DEFAULT 'CASH' CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER')),
        bank_name VARCHAR(150),
        bank_branch VARCHAR(150),
        account_number VARCHAR(100),
        cheque_number VARCHAR(100),
        cheque_date_ad DATE,
        cheque_date_bs VARCHAR(20),
        transaction_reference VARCHAR(200),
        notes TEXT,
        status VARCHAR(30) DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED', 'VOIDED')),
        reversal_reason TEXT,
        reversed_by VARCHAR(150),
        reversed_at_ad TIMESTAMP WITH TIME ZONE,
        original_payment_id VARCHAR(50) REFERENCES vendor_payments(id) ON DELETE SET NULL,
        fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(150),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_supplier ON vendor_payments(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_branch ON vendor_payments(branch_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_invoice ON vendor_payments(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_date ON vendor_payments(payment_date_ad);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_status ON vendor_payments(status);
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_fiscal_year ON vendor_payments(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_demo ON vendor_payments(id) WHERE is_demo = TRUE;
      -- 29. Permission Matrix (server-side authority for role-based operation gating)
      CREATE TABLE IF NOT EXISTS permission_matrix (
        operation_id VARCHAR(60) NOT NULL,
        role VARCHAR(40) NOT NULL,
        allowed BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (operation_id, role)
      );
      CREATE INDEX IF NOT EXISTS idx_permission_matrix_role ON permission_matrix(role);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE fiscal_year_opening_stock ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE fiscal_year_opening_stock ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE transaction_logs ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE transaction_logs ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE transaction_logs ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      -- stock_operations.type: the disposal write-off flow posts type
      -- 'DISPOSAL' (DamagedStockTracking disposal modal). Existing databases
      -- created before DISPOSAL shipped carry a CHECK without it.
      ALTER TABLE stock_operations DROP CONSTRAINT IF EXISTS stock_operations_type_check;
      ALTER TABLE stock_operations ADD CONSTRAINT stock_operations_type_check CHECK (
        type IN ('PULLOUT', 'DAMAGE', 'DISPOSAL', 'STOCK_OUT', 'MANUAL_ADJUSTMENT', 'CONSUMABLE_ISSUE')
      );
      -- vendor_payments.payment_method: the invoice payment UI offers CREDIT
      -- ("Credit / Adjustment") and forwards it to the vendor sub-ledger.
      ALTER TABLE vendor_payments DROP CONSTRAINT IF EXISTS vendor_payments_payment_method_check;
      ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_payment_method_check CHECK (
        payment_method IN ('CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER')
      );
      -- locations.type: the Locations form offers FIBER_NETWORK_NODE,
      -- CUSTOMER_SITE and BRANCH_OFFICE — keep the DB check in sync.
      ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_type_check;
      ALTER TABLE locations ADD CONSTRAINT locations_type_check CHECK (
        type IN ('POP_SERVER_ROOM', 'FIBER_NETWORK_NODE', 'CUSTOMER_SITE', 'WAREHOUSE', 'BRANCH_OFFICE', 'STORE', 'OFFICE', 'DEPOT')
      );
      -- Allow the extended stock-movement event types used by the operational
      -- modules (Stock Operations, Damage Disposal, Product Stock-Out). Fresh
      -- installs already get the new list from the CREATE TABLE above; this is
      -- a no-op rewrite on databases created before the extended set shipped.
      ALTER TABLE transaction_logs DROP CONSTRAINT IF EXISTS transaction_logs_change_type_check;
      ALTER TABLE transaction_logs ADD CONSTRAINT transaction_logs_change_type_check CHECK (
        change_type IN ('INBOUND_PO', 'PURCHASE_INVOICE', 'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT',
          'DAMAGE', 'DAMAGE_REVERSED', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT',
          'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN',
          'TRANSFER_CANCELLED', 'TRANSFER_RECEIPT_CANCELLED')
      );
      ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE customer_device_records ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE bs_day_records ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      -- is_demo labelling for master tables seeded with example/dummy data
      -- (Nepali/BS calendar tables are real reference data and never carry it)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE branches ADD COLUMN IF NOT EXISTS allow_warehouse_transfer BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE locations ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      -- v3.0 partial indexes: demo-row fast paths and fiscal-year scoping
      CREATE INDEX IF NOT EXISTS idx_suppliers_demo ON suppliers(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_categories_demo ON categories(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_products_demo ON products(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_inventory_stock_demo ON inventory_stock(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_demo ON fixed_assets(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_demo ON purchase_orders(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_purchase_invoices_demo ON purchase_invoices(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_shipments_demo ON shipments(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_stock_operations_demo ON stock_operations(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_audit_logs_demo ON audit_logs(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_transaction_logs_demo ON transaction_logs(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_customer_records_demo ON customer_records(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_customer_device_records_demo ON customer_device_records(id) WHERE is_demo = TRUE;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_device_serial ON customer_device_records ((lower(trim(device_serial)))) WHERE trim(device_serial) <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_pon_serial ON customer_device_records ((lower(trim(pon_serial)))) WHERE trim(pon_serial) <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_mac_address ON customer_device_records ((lower(trim(mac_address)))) WHERE mac_address IS NOT NULL AND trim(mac_address) <> '';
      CREATE INDEX IF NOT EXISTS idx_approval_requests_demo ON approval_requests(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_fiscal_year_id ON fixed_assets(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_purchase_invoice_id ON fixed_assets(purchase_invoice_id) WHERE purchase_invoice_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_invoice_date ON fixed_assets(branch_id, purchase_invoice_date_ad);
      CREATE INDEX IF NOT EXISTS idx_fixed_assets_service_date ON fixed_assets(branch_id, placed_in_service_date_ad);
      CREATE INDEX IF NOT EXISTS idx_fiscal_years_start_date ON fiscal_years(start_date_ad DESC);
      CREATE INDEX IF NOT EXISTS idx_fiscal_years_demo ON fiscal_years(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_fiscal_year_id ON purchase_orders(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_purchase_invoices_fiscal_year_id ON purchase_invoices(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_shipments_fiscal_year_id ON shipments(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_stock_operations_fiscal_year_id ON stock_operations(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audit_logs_fiscal_year_id ON audit_logs(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_transaction_logs_fiscal_year_id ON transaction_logs(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_customer_device_records_fiscal_year_id ON customer_device_records(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_approval_requests_fiscal_year_id ON approval_requests(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_bs_day_records_fiscal_year_id ON bs_day_records(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
      CREATE OR REPLACE FUNCTION assign_fiscal_year_id_from_date()
      RETURNS trigger AS $$
      DECLARE date_value DATE;
      BEGIN
        IF NEW.fiscal_year_id IS NULL THEN
          date_value := (to_jsonb(NEW) ->> TG_ARGV[0])::DATE;
          SELECT id INTO NEW.fiscal_year_id FROM fiscal_years
          WHERE start_date_ad <= date_value AND end_date_ad >= date_value
          ORDER BY start_date_ad DESC LIMIT 1;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE OR REPLACE TRIGGER trg_fixed_assets_fiscal_year BEFORE INSERT OR UPDATE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('acquisition_date_ad');
      CREATE OR REPLACE TRIGGER trg_purchase_orders_fiscal_year BEFORE INSERT OR UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('order_date_ad');
      CREATE OR REPLACE TRIGGER trg_purchase_invoices_fiscal_year BEFORE INSERT OR UPDATE ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('invoice_date_ad');
      CREATE OR REPLACE TRIGGER trg_shipments_fiscal_year BEFORE INSERT OR UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('dispatch_date_ad');
      CREATE OR REPLACE TRIGGER trg_stock_operations_fiscal_year BEFORE INSERT OR UPDATE ON stock_operations FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('date_ad');
      CREATE OR REPLACE TRIGGER trg_audit_logs_fiscal_year BEFORE INSERT OR UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('timestamp_ad');
      CREATE OR REPLACE TRIGGER trg_transaction_logs_fiscal_year BEFORE INSERT OR UPDATE ON transaction_logs FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('timestamp_ad');
      CREATE OR REPLACE TRIGGER trg_customer_devices_fiscal_year BEFORE INSERT OR UPDATE ON customer_device_records FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('issued_date_ad');
      CREATE OR REPLACE TRIGGER trg_approval_requests_fiscal_year BEFORE INSERT OR UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('requested_at_ad');
      CREATE OR REPLACE TRIGGER trg_vendor_payments_fiscal_year BEFORE INSERT OR UPDATE ON vendor_payments FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('payment_date_ad');
      UPDATE fixed_assets SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE acquisition_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE purchase_orders SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE order_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE purchase_invoices SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE invoice_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE shipments SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE dispatch_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE stock_operations SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE customer_device_records SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE issued_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;
      UPDATE vendor_payments SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE payment_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;

      -- Serial Log ALTER TABLE additions
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
      ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_serial_log_demo ON serial_log(id) WHERE is_demo = TRUE;
      CREATE INDEX IF NOT EXISTS idx_serial_log_device_serial ON serial_log((lower(trim(device_serial))));
      CREATE INDEX IF NOT EXISTS idx_serial_log_branch ON serial_log(branch_id) WHERE branch_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_serial_log_status ON serial_log(status);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_serial_log_device_serial ON serial_log ((lower(trim(device_serial)))) WHERE trim(device_serial) <> '';
    `);

    setPgConnectedFlag(true);
    setIsPgConnected(true);
    await seedInitialPostgresData(client);
    await hydrateOperationalData(client);
    await backfillSerialLog(client);
    await loadPermissionMatrixFromDb(client);
    await hydrateBsCalendarFromDb(client);

    client.release();
    console.log('✅ All 30 Database tables and enterprise composite performance indexes synced successfully on PostgreSQL.');
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
        [fy.id, fy.code, fy.startDateAD || '2025-07-16', fy.endDateAD || '2026-07-15', fy.startDateBS || '2082-04-01', fy.endDateBS || '2083-03-31', fy.isCurrent || false, fy.isClosed || false]
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

// Serial-log backfill: converges every legacy serial source (purchase invoices,
// shipments, stock operations, serial-tracked fixed assets, customer devices)
// into ONE row per unique device_serial. Later/priority sources win; terminal
// manual states (DAMAGED, CUSTOMER_ASSIGNED, RETURNED, POP_LOCATION_ASSIGNED)
// are never downgraded by the backfill.
async function backfillSerialLog(client: pg.PoolClient) {
  try {
    const asArray = (v: any): any[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
      return [];
    };
    const keyOf = (s: any) => String(s || '').trim().toLowerCase();
    const isoDate = (d: any) => { const s = String(d || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10); };

    type Cand = {
      deviceSerial: string; ponSerial?: string; macAddress?: string;
      productId?: string; productName?: string; branchId?: string;
      customerId?: string; customerName?: string;
      status: string; sourceType: string; sourceId?: string; dateAD?: string;
    };
    const merged = new Map<string, Cand>();
    const put = (c: Cand, force = false) => {
      const k = keyOf(c.deviceSerial);
      if (!k) return;
      const prev = merged.get(k);
      if (!prev) { merged.set(k, c); return; }
      // DAMAGED always wins; otherwise later (higher-priority) sources win.
      if (c.status === 'DAMAGED' || force || prev.status === 'IN_STOCK' || prev.status === 'IN_TRANSIT') {
        merged.set(k, {
          ...c,
          ponSerial: c.ponSerial || prev.ponSerial,
          macAddress: c.macAddress || prev.macAddress,
          productId: c.productId || prev.productId,
          productName: c.productName || prev.productName,
          branchId: c.branchId || prev.branchId,
        });
      }
    };

    // 1. Purchase invoices → IN_STOCK
    const piRes = await client.query('SELECT id, branch_id, invoice_date_ad, items FROM purchase_invoices');
    for (const inv of piRes.rows) {
      for (const item of asArray(inv.items)) {
        for (const s of asArray(item.deviceSerials)) {
          if (!keyOf(s.deviceSerial)) continue;
          put({
            deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
            productId: item.productId, productName: item.productName || item.sku,
            branchId: inv.branch_id, status: 'IN_STOCK', sourceType: 'PURCHASE',
            sourceId: inv.id, dateAD: isoDate(inv.invoice_date_ad),
          });
        }
      }
    }

    // 2. Shipments → IN_TRANSIT (dispatched) or IN_STOCK (received)
    const shRes = await client.query('SELECT id, status, destination_branch_id, dispatch_date_ad, items FROM shipments');
    for (const sh of shRes.rows) {
      const inTransit = sh.status === 'DISPATCHED' || sh.status === 'IN_TRANSIT';
      for (const item of asArray(sh.items)) {
        const list = sh.status === 'RECEIVED' ? asArray(item.receivedSerials) : asArray(item.deviceSerials);
        for (const s of list) {
          if (!keyOf(s.deviceSerial)) continue;
          put({
            deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
            productId: item.productId, productName: item.productName,
            branchId: sh.destination_branch_id, status: inTransit ? 'IN_TRANSIT' : 'IN_STOCK',
            sourceType: 'SHIPMENT', sourceId: sh.id, dateAD: isoDate(sh.dispatch_date_ad),
          });
        }
      }
    }

    // 3. Stock operations → DAMAGED or IN_STOCK
    const opRes = await client.query('SELECT id, type, branch_id, date_ad, items FROM stock_operations');
    for (const op of opRes.rows) {
      const damaged = op.type === 'DAMAGE' || op.type === 'DISPOSAL';
      for (const item of asArray(op.items)) {
        for (const s of asArray(item.deviceSerials)) {
          if (!keyOf(s.deviceSerial)) continue;
          put({
            deviceSerial: String(s.deviceSerial).trim(), ponSerial: s.ponSerial, macAddress: s.macAddress,
            productId: item.productId, productName: item.productName,
            branchId: op.branch_id, status: damaged ? 'DAMAGED' : 'IN_STOCK',
            sourceType: 'STOCK_OP', sourceId: op.id, dateAD: isoDate(op.date_ad),
          });
        }
      }
    }

    // 4. Serial-tracked fixed assets → POP_LOCATION_ASSIGNED
    const faRes = await client.query(
      `SELECT fa.id, fa.tag_number, fa.name, fa.branch_id, fa.product_id, fa.placed_in_service_date_ad, fa.acquisition_date_ad
       FROM fixed_assets fa LEFT JOIN products p ON p.id = fa.product_id
       WHERE fa.status = 'ACTIVE' AND (p.requires_serial_tracking = TRUE OR p.tracking_type IS DISTINCT FROM 'QUANTITY_ONLY' OR fa.product_id IS NULL)`
    );
    for (const fa of faRes.rows) {
      if (!keyOf(fa.tag_number)) continue;
      put({
        deviceSerial: String(fa.tag_number).trim(), ponSerial: String(fa.tag_number).trim(),
        productId: fa.product_id, productName: fa.name, branchId: fa.branch_id,
        status: 'POP_LOCATION_ASSIGNED', sourceType: 'FIXED_ASSET', sourceId: fa.id,
        dateAD: isoDate(fa.placed_in_service_date_ad || fa.acquisition_date_ad),
      }, true);
    }

    // 5. Customer devices → CUSTOMER_ASSIGNED (highest priority, wins over purchase/stock)
    const cdRes = await client.query(
      'SELECT id, customer_id, customer_name, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad FROM customer_device_records'
    );
    for (const d of cdRes.rows) {
      if (!keyOf(d.device_serial)) continue;
      let st = 'CUSTOMER_ASSIGNED';
      if (d.status === 'ROUTER_COLLECTED' || d.status === 'DISCONNECTED' || d.status === 'IN_STOCK') st = 'IN_STOCK';
      else if (d.status === 'DAMAGED' || d.status === 'DAMAGED_STOCK') st = 'DAMAGED';
      put({
        deviceSerial: String(d.device_serial).trim(), ponSerial: d.pon_serial, macAddress: d.mac_address,
        productName: d.product_name, branchId: d.branch_id,
        customerId: d.customer_id, customerName: d.customer_name,
        status: st, sourceType: 'CUSTOMER_ASSIGN', sourceId: d.id, dateAD: isoDate(d.issued_date_ad),
      }, true);
    }

    if (merged.size === 0) return;

    const existingRes = await client.query('SELECT id, device_serial, status, history_json FROM serial_log');
    const existing = new Map<string, any>();
    for (const r of existingRes.rows) existing.set(keyOf(r.device_serial), r);

    let inserted = 0, updated = 0;
    for (const [, c] of merged) {
      const k = keyOf(c.deviceSerial);
      const row = existing.get(k);
      const entry = { status: c.status, sourceType: c.sourceType, sourceId: c.sourceId || null, dateAD: c.dateAD, notes: 'Auto backfill' };
      if (!row) {
        const id = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await client.query(
          `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id, customer_id, customer_name, status, source_type, source_id, history_json, created_at, updated_at, is_demo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,FALSE) ON CONFLICT DO NOTHING`,
          [id, c.deviceSerial, c.ponSerial || null, c.macAddress || null, c.productId || null, c.productName || null,
            c.branchId || null, c.customerId || null, c.customerName || null, c.status, c.sourceType, c.sourceId || null,
            JSON.stringify([entry]), `${c.dateAD}T00:00:00Z`, new Date().toISOString()]
        );
        inserted++;
      } else if ((row.status === 'IN_STOCK' || row.status === 'IN_TRANSIT') && row.status !== c.status) {
        // Upgrade transient states only — never downgrade manual/terminal states.
        let history: any[] = [];
        try { history = JSON.parse(row.history_json || '[]'); } catch { history = []; }
        history.push(entry);
        await client.query(
          `UPDATE serial_log SET status = $1, customer_id = COALESCE($2, customer_id), customer_name = COALESCE($3, customer_name),
            pon_serial = COALESCE($4, pon_serial), mac_address = COALESCE($5, mac_address),
            product_name = COALESCE($6, product_name), branch_id = COALESCE($7, branch_id),
            source_type = $8, source_id = COALESCE($9, source_id), history_json = $10, updated_at = NOW() WHERE id = $11`,
          [c.status, c.customerId || null, c.customerName || null, c.ponSerial || null, c.macAddress || null,
            c.productName || null, c.branchId || null, c.sourceType, c.sourceId || null, JSON.stringify(history), row.id]
        );
        updated++;
      }
    }

    // Refresh the in-memory register so the API serves converged rows immediately.
    const fresh = await client.query(
      'SELECT id, device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", product_id AS "productId", product_name AS "productName", branch_id AS "branchId", customer_id AS "customerId", customer_name AS "customerName", status, source_type AS "sourceType", source_id AS "sourceId", history_json AS "historyJson", created_at AS "createdAt", updated_at AS "updatedAt" FROM serial_log ORDER BY created_at DESC'
    );
    setSerialLogs(fresh.rows.map((r: any) => {
      let history: any[] = [];
      try { history = typeof r.historyJson === 'string' ? JSON.parse(r.historyJson || '[]') : (r.historyJson || []); } catch { history = []; }
      const { historyJson, ...rest } = r;
      return { ...rest, history };
    }));
    if (inserted > 0 || updated > 0) {
      console.log(`✅ Serial-log backfill converged ${merged.size} unique serials (${inserted} inserted, ${updated} upgraded).`);
    }
  } catch (e: any) {
    console.warn('Serial-log backfill skipped:', e?.message || e);
  }
}
