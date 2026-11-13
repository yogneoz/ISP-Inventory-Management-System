-- ============================================================================
-- Inventory & ERP System - Full PostgreSQL Database Schema
-- Version: 3.0 (Enterprise-Ready, Production Hardened)
-- Multi-branch Fiber ISP Operations
--
-- v3.0 changes (fully idempotent - safe to re-apply on an existing database):
--   * is_demo tracking column on every operational table. Dummy data seeded by
--     `npm run setup:pg` is marked is_demo = TRUE and the demo-clear action only
--     ever removes rows where is_demo = TRUE, so real data is never touched.
--   * created_by / updated_by audit columns and updated_at on operational tables
--   * fiscal_year_id foreign key on all transactional tables, tying every
--     document to the fiscal_years master table
--   * bs_day_records.fiscal_year_id FK alongside the fiscal_year code column
--   * Partial indexes for is_demo = TRUE rows and fiscal_year_id scoping
--   * v3.2: serial_log register (17b) - one row per unique device serial with
--     lifecycle history, enforced by uq_serial_log_device_serial. Demo rows are
--     seeded by `npm run setup:pg` (scripts/setup_db.js -> scripts/demo_dataset.js).
--
-- AD (Gregorian) dates remain the source of truth for every date column,
-- BS dates and fiscal years are derived server-side from bs_day_records.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- B2: trigram indexes back the item/header free-text search. pg_trgm is a
-- trusted extension, so the application's database role can install it
-- without superuser rights. See docs/architecture-backlog.md §B2.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ==========================================
-- 0. Schema Migration Ledger
-- ==========================================
-- Boot records the baseline here and applies only numbered files from
-- scripts/migrations/ afterwards. It is infrastructure metadata, not business
-- data, and exists in schema.sql so a fresh reference install and a booted
-- database have the same shape.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    source VARCHAR(20) NOT NULL CHECK (source IN ('BASELINE', 'ADOPTED', 'MIGRATION')),
    applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 1. Branches Table
-- ==========================================
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
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 2. Users Table
-- ==========================================
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(50) PRIMARY KEY,
    email VARCHAR(150) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(150) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('SUPER_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK', 'ACCOUNTANT', 'HEAD_OFFICE_ADMIN', 'HR_SELF_SERVICE', 'HR_MANAGER', 'HR_OFFICER', 'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN', 'AUDITOR')),
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
    allowed_branch_ids TEXT[],
    status VARCHAR(30) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended', 'locked')),
    can_switch_user BOOLEAN DEFAULT FALSE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Existing tenants keep their users table; replace the role whitelist so the
-- two HR roles can be assigned without a manual migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_role_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
  ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
    'SUPER_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK',
    'ACCOUNTANT', 'HEAD_OFFICE_ADMIN', 'HR_SELF_SERVICE', 'HR_MANAGER', 'HR_OFFICER',
    'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN', 'AUDITOR'
  ));
END $$;

-- ==========================================
-- 3. Fiscal Years Table (declared early: many
--    transactional tables hold an FK to it)
-- ==========================================
CREATE TABLE IF NOT EXISTS fiscal_years (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    start_date_ad DATE NOT NULL,
    end_date_ad DATE NOT NULL,
    start_date_bs VARCHAR(20) NOT NULL,
    end_date_bs VARCHAR(20) NOT NULL,
    is_current BOOLEAN DEFAULT FALSE,
    is_closed BOOLEAN DEFAULT FALSE,
    -- TRUE while this row's BS boundary labels were derived from a PROVISIONAL
    -- calendar year (one the published patro does not cover yet, seeded by hand
    -- from the operator's own source) rather than from patro-verified data. The
    -- year stays usable — every screen works, the BS labels are the ones the
    -- stored calendar implies — but the app says out loud that the label is not
    -- yet confirmed. The BS calendar integrity audit clears the flag once the
    -- published patro covers the day and agrees with the stored label.
    is_provisional BOOLEAN NOT NULL DEFAULT FALSE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE
);

-- Exactly one fiscal year may be flagged current (prevents the
-- ambiguous-default bug where two rows had is_current = TRUE).
DROP INDEX IF EXISTS uq_fiscal_years_single_current;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_years_single_current ON fiscal_years ((is_current)) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_fiscal_years_start_date ON fiscal_years(start_date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_fiscal_years_demo ON fiscal_years(id) WHERE is_demo = TRUE;

-- Existing databases pick the provisional flag up on the next boot.
ALTER TABLE fiscal_years ADD COLUMN IF NOT EXISTS is_provisional BOOLEAN NOT NULL DEFAULT FALSE;

-- ==========================================
-- 3b. Bill Terms Table (credit days / early-payment discount)
-- ==========================================
-- A bill term is a reusable credit policy: due_days is counted from the
-- invoice date (0 = due on receipt). Parties and invoices point at it; the
-- invoice stores the resolved due date, so changing a term later never
-- rewrites posted history.
CREATE TABLE IF NOT EXISTS bill_terms (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    due_days INT NOT NULL DEFAULT 0 CHECK (due_days >= 0 AND due_days <= 3650),
    discount_days INT CHECK (discount_days IS NULL OR (discount_days >= 0 AND discount_days <= 3650)),
    discount_percent NUMERIC(5, 2) CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100)),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bill_terms_active ON bill_terms(active);

-- Seed the common terms once. ON CONFLICT keeps an operator's edited row.
INSERT INTO bill_terms (id, code, name, due_days, discount_days, discount_percent, active, is_demo)
VALUES
  ('bt-due-on-receipt', 'DUE_ON_RECEIPT', 'Due on Receipt', 0, NULL, NULL, TRUE, FALSE),
  ('bt-net-7', 'NET_7', 'Net 7 Days', 7, NULL, NULL, TRUE, FALSE),
  ('bt-net-15', 'NET_15', 'Net 15 Days', 15, NULL, NULL, TRUE, FALSE),
  ('bt-net-30', 'NET_30', 'Net 30 Days', 30, NULL, NULL, TRUE, FALSE),
  ('bt-net-45', 'NET_45', 'Net 45 Days', 45, NULL, NULL, TRUE, FALSE),
  ('bt-net-60', 'NET_60', 'Net 60 Days', 60, NULL, NULL, TRUE, FALSE)
ON CONFLICT (id) DO NOTHING;

-- ==========================================
-- 4. Suppliers Table
-- ==========================================
CREATE TABLE IF NOT EXISTS suppliers (
    id VARCHAR(50) PRIMARY KEY,
    supplier_code VARCHAR(50) UNIQUE,
    name VARCHAR(200) NOT NULL,
    contact_person VARCHAR(150),
    phone VARCHAR(50),
    email VARCHAR(150),
    address TEXT,
    pan_vat_number VARCHAR(50),
    bill_terms_id VARCHAR(50) REFERENCES bill_terms(id) ON DELETE SET NULL,
    rating NUMERIC(3, 1) DEFAULT 5.0,
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Existing databases pick the supplier default up on the next boot.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bill_terms_id VARCHAR(50) REFERENCES bill_terms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_bill_terms ON suppliers(bill_terms_id);

-- ==========================================
-- 5. Categories Table
-- ==========================================
CREATE TABLE IF NOT EXISTS categories (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(150) UNIQUE NOT NULL,
    code VARCHAR(30) UNIQUE NOT NULL,
    description TEXT,
    is_special_tracked BOOLEAN NOT NULL DEFAULT FALSE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 5b. Product Groups Table (customer-defined catalog buckets)
-- ==========================================
-- A product group is an operator-named bucket of catalog rows plus ONE fixed
-- behaviour. The behaviour -- not the name -- is what sales eligibility,
-- consumable issuing and depreciation key off, so a business can rename or add
-- groups ("Vehicles", "Network Equipment") without touching any business rule.
-- `is_system` protects the three built-ins from deletion; the supported way to
-- stop offering a group is retiring it (active = FALSE).
CREATE TABLE IF NOT EXISTS product_groups (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) UNIQUE NOT NULL,
    behavior VARCHAR(30) NOT NULL CHECK (behavior IN ('STOCK_ITEM', 'CONSUMABLE', 'FIXED_ASSET')),
    sort_order INT NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- The three groups the application shipped with. Seeded HERE (not in dbBoot) so
-- a fresh install, an upgraded database and every test database agree. The
-- untargeted ON CONFLICT keeps the seed a no-op after an operator renames a
-- group: a renamed row still owns its code, so no built-in is resurrected.
INSERT INTO product_groups (id, code, name, behavior, sort_order, active, is_system)
VALUES
  ('pg-product-item', 'PRODUCT_ITEM', 'Product Item', 'STOCK_ITEM', 10, TRUE, TRUE),
  ('pg-consumable-item', 'CONSUMABLE_ITEM', 'Consumable Item', 'CONSUMABLE', 20, TRUE, TRUE),
  ('pg-fixed-asset', 'FIXED_ASSET', 'Fixed Asset', 'FIXED_ASSET', 30, TRUE, TRUE)
ON CONFLICT DO NOTHING;

-- ==========================================
-- 6. Products Table
-- ==========================================
CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(50) PRIMARY KEY,
    sku VARCHAR(100) UNIQUE NOT NULL,
    barcode VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100) NOT NULL,
    -- The group NAME is stored (not its id) so every existing payload, CSV
    -- export and report keeps reading a human-readable value. The foreign key
    -- makes a rename cascade to every product and refuses deleting a group
    -- that is still in use.
    product_group VARCHAR(50) NOT NULL REFERENCES product_groups(name) ON UPDATE CASCADE ON DELETE RESTRICT,
    unit VARCHAR(30) DEFAULT 'Pcs',
    cost_price NUMERIC(12, 2) DEFAULT 0.00,
    selling_price NUMERIC(12, 2) DEFAULT 0.00,
    tax_rate NUMERIC(5, 2) DEFAULT 13.00,
    min_reorder_level INT DEFAULT 5,
    requires_serial_tracking BOOLEAN DEFAULT FALSE,
    tracking_type VARCHAR(50) DEFAULT 'QUANTITY_ONLY' CHECK (tracking_type IN ('QUANTITY_ONLY', 'SERIAL_MAC_PON', 'SERIAL_ONLY')),
    description TEXT,
    depreciation_method VARCHAR(50),
    depreciation_rate NUMERIC(5, 2),
    useful_life_years INT,
    -- WTY-1: term defaults only. A coverage row snapshots the term and its exact
    -- expiry; changing these never rewrites coverage already captured.
    vendor_warranty_months INT NOT NULL DEFAULT 12 CHECK (vendor_warranty_months BETWEEN 0 AND 120),
    seller_warranty_months INT NOT NULL DEFAULT 12 CHECK (seller_warranty_months BETWEEN 0 AND 120),
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DISCONTINUED')),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 7. Inventory Stock Table
-- ==========================================
CREATE TABLE IF NOT EXISTS inventory_stock (
    id VARCHAR(100) PRIMARY KEY,
    product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    quantity_on_hand INT DEFAULT 0,
    -- Moving weighted-average unit cost used by the GL (COGS/inventory).
    -- Standard/product cost remains the operational price; this column is the
    -- financial valuation the ledger posts against.
    average_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
    damaged_qty INT DEFAULT 0,
    reserved_qty INT DEFAULT 0,
    incoming_qty INT DEFAULT 0,
    min_reorder_level INT DEFAULT 5,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_product_branch UNIQUE (product_id, branch_id)
);

-- ==========================================
-- 7b. Damage Records Table (tracks damage lifecycle: identified -> disposed/written-off)
-- ==========================================
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

-- ==========================================
-- 8. Fixed Assets Table
-- ==========================================
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
    capitalization_date_bs VARCHAR(20),
    placed_in_service_date_ad DATE,
    placed_in_service_date_bs VARCHAR(20),
    acquisition_cost NUMERIC(12, 2) NOT NULL,
    depreciation_method VARCHAR(50) DEFAULT 'STRAIGHT_LINE',
    depreciation_rate_percent NUMERIC(5, 2) DEFAULT 15.00,
    accumulated_depreciation NUMERIC(12, 2) DEFAULT 0.00,
    net_book_value NUMERIC(12, 2) NOT NULL,
    status VARCHAR(30) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISPOSED', 'WRITTEN_OFF', 'MAINTENANCE', 'IN_USE', 'ASSIGNED_TO_CUSTOMER', 'ASSIGNED_TO_LOCATION')),
    supplier_name VARCHAR(200),
    invoice_no VARCHAR(100),
    purchase_invoice_id VARCHAR(50),
    product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
    assigned_type VARCHAR(10),
    assigned_customer_id VARCHAR(50),
    assigned_customer_name VARCHAR(200),
    assigned_location_id VARCHAR(50),
    assigned_location_name VARCHAR(200),
    assigned_employee_id VARCHAR(50),
    assigned_employee_name VARCHAR(200),
    assignment_date_ad DATE,
    assignment_date_bs VARCHAR(20),
    assignment_notes TEXT,
    device_serial VARCHAR(100),
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS capitalization_date_bs VARCHAR(20);
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS placed_in_service_date_bs VARCHAR(20);
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS assigned_employee_id VARCHAR(50);
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS assigned_employee_name VARCHAR(200);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_assigned_employee
  ON fixed_assets(assigned_employee_id);

-- ==========================================
-- 9. Purchase Orders Table (with items JSONB)
-- ==========================================
CREATE TABLE IF NOT EXISTS purchase_orders (
    id VARCHAR(50) PRIMARY KEY,
    po_number VARCHAR(100) UNIQUE NOT NULL,
    supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name VARCHAR(200) NOT NULL,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    order_date_ad DATE NOT NULL,
    order_date_bs VARCHAR(20) NOT NULL,
    expected_delivery_date_ad DATE,
    expected_delivery_date_bs VARCHAR(20),
    status VARCHAR(30) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'SENT', 'IN_PROGRESS', 'PURCHASED', 'RECEIVED', 'CANCELLED')),
    status_override VARCHAR(30),
    subtotal_amount NUMERIC(14, 2) DEFAULT 0.00,
    tax_amount NUMERIC(14, 2) DEFAULT 0.00,
    total_amount NUMERIC(14, 2) DEFAULT 0.00,
    notes TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    -- B2: one lower-cased search projection so a single trigram index serves
    -- the whole `header OR items` predicate (docs/architecture-backlog.md §B2).
    search_text TEXT GENERATED ALWAYS AS (
        lower(
            COALESCE(po_number, '') || ' ' ||
            COALESCE(supplier_name, '') || ' ' ||
            COALESCE(items::text, '')
        )
    ) STORED,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 10. Purchase Invoices Table (with items JSONB)
-- ==========================================
CREATE TABLE IF NOT EXISTS purchase_invoices (
    id VARCHAR(50) PRIMARY KEY,
    invoice_number VARCHAR(100) UNIQUE NOT NULL,
    po_reference_id VARCHAR(50),
    vendor_bill_number VARCHAR(100),
    vendor_bill_date_ad DATE,
    vendor_bill_date_bs VARCHAR(20),
    supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name VARCHAR(200) NOT NULL,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    invoice_date_ad DATE NOT NULL,
    invoice_date_bs VARCHAR(20) NOT NULL,
    bill_terms_id VARCHAR(50) REFERENCES bill_terms(id) ON DELETE SET NULL,
    due_date_ad DATE,
    due_date_bs VARCHAR(20),
    taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    vat_amount NUMERIC(14, 2) DEFAULT 0.00,
    non_taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    grand_total NUMERIC(14, 2) DEFAULT 0.00,
    payment_status VARCHAR(30) DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PARTIAL', 'PAID')),
    payment_method VARCHAR(30) DEFAULT 'CREDIT' CHECK (payment_method IN ('CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER')),
    amount_paid NUMERIC(14, 2) DEFAULT 0.00,
    notes TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    -- B2: invoice #, vendor bill #, supplier and line items in one trigram-
    -- indexed expression (docs/architecture-backlog.md §B2).
    search_text TEXT GENERATED ALWAYS AS (
        lower(
            COALESCE(invoice_number, '') || ' ' ||
            COALESCE(vendor_bill_number, '') || ' ' ||
            COALESCE(supplier_name, '') || ' ' ||
            COALESCE(items::text, '')
        )
    ) STORED,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS vendor_bill_date_ad DATE;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS vendor_bill_date_bs VARCHAR(20);
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS bill_terms_id VARCHAR(50) REFERENCES bill_terms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_bill_terms ON purchase_invoices(bill_terms_id);

-- ==========================================
-- 10b. Vendor Payments Sub-ledger Table
-- ==========================================
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
    payment_method VARCHAR(30) DEFAULT 'CASH' CHECK (payment_method IN ('CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER')),
    bank_name VARCHAR(150),
    bank_branch VARCHAR(150),
    account_number VARCHAR(100),
    cheque_number VARCHAR(100),
    cheque_date_ad DATE,
    cheque_date_bs VARCHAR(20),
    transaction_reference VARCHAR(200),
    settlement_account_id VARCHAR(50),
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
CREATE INDEX IF NOT EXISTS idx_vendor_payments_fiscal_year ON vendor_payments(fiscal_year_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_demo ON vendor_payments(id) WHERE is_demo = TRUE;

-- ==========================================
-- 11. Shipments Table (with all required columns)
-- ==========================================
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
    status VARCHAR(30) DEFAULT 'IN_TRANSIT' CHECK (status IN ('DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'RECEIVED', 'DISCREPANCY', 'CANCELLED')),
    notes TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    -- B2: the serial-rename pre-select searches this projection. Shipments
    -- have no header search today, so only the line items contribute.
    search_text TEXT GENERATED ALWAYS AS (lower(COALESCE(items::text, ''))) STORED,
    received_by_notes TEXT,
    received_date_ad DATE,
    received_date_bs VARCHAR(20),
    has_discrepancy BOOLEAN DEFAULT FALSE,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 12. Stock Operations Table (with items JSONB)
-- ==========================================
CREATE TABLE IF NOT EXISTS stock_operations (
    id VARCHAR(50) PRIMARY KEY,
    reference_number VARCHAR(100) UNIQUE NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('PULLOUT', 'DAMAGE', 'DISPOSAL', 'STOCK_OUT', 'MANUAL_ADJUSTMENT', 'CONSUMABLE_ISSUE')),
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
    fiscal_year VARCHAR(20),
    status VARCHAR(30) DEFAULT 'LOGGED' CHECK (status IN ('LOGGED', 'DISPATCHED', 'RECEIVED', 'CANCELLED')),
    items JSONB DEFAULT '[]'::jsonb,
    -- B2: reference, technician, work order, reason and line items in one
    -- trigram-indexed expression (docs/architecture-backlog.md §B2).
    search_text TEXT GENERATED ALWAYS AS (
        lower(
            COALESCE(reference_number, '') || ' ' ||
            COALESCE(technician_name, '') || ' ' ||
            COALESCE(work_order_ref, '') || ' ' ||
            COALESCE(reason, '') || ' ' ||
            COALESCE(items::text, '')
        )
    ) STORED,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 13. Fiscal-Year Opening Stock Balances
-- ==========================================
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
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    UNIQUE (fiscal_year_id, product_id, branch_id)
);

-- ==========================================
-- 13b. Fiscal-Year Vendor Opening Balances
--      (Vendor Ledger roll-forward: opening
--       account-payable per supplier × branch)
-- ==========================================
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

CREATE INDEX IF NOT EXISTS idx_vendor_opening_fy ON vendor_opening_balances(fiscal_year_id);
CREATE INDEX IF NOT EXISTS idx_vendor_opening_supplier ON vendor_opening_balances(supplier_id);
CREATE INDEX IF NOT EXISTS idx_vendor_opening_branch ON vendor_opening_balances(branch_id);
CREATE INDEX IF NOT EXISTS idx_vendor_opening_demo ON vendor_opening_balances(id) WHERE is_demo = TRUE;

-- ==========================================
-- 14. Audit Trail Table
-- ==========================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(50) PRIMARY KEY,
    user_email VARCHAR(150) NOT NULL,
    user_name VARCHAR(150) NOT NULL,
    action VARCHAR(100) NOT NULL,
    module VARCHAR(50) NOT NULL CHECK (module IN ('AUTH', 'MASTER_DATA', 'PRODUCTS', 'CATEGORIES', 'PROCUREMENT', 'LOGISTICS', 'STOCK_OPERATIONS', 'FIXED_ASSETS', 'CPE_MANAGEMENT', 'INVENTORY', 'INVENTORY_AUDIT', 'OPERATIONS', 'BRANCH_OPERATIONS', 'FISCAL_YEAR', 'APPROVAL_WORKFLOW', 'SYSTEM')),
    details TEXT,
    timestamp_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    timestamp_bs VARCHAR(20),
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE
);

-- ==========================================
-- 15. Transaction Logs Table
-- ==========================================
CREATE TABLE IF NOT EXISTS transaction_logs (
    id VARCHAR(100) PRIMARY KEY,
    transaction_number VARCHAR(100) NOT NULL,
    product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
    product_sku VARCHAR(100),
    product_name VARCHAR(255),
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    change_type VARCHAR(50) NOT NULL CHECK (change_type IN ('INBOUND_PO', 'PURCHASE_INVOICE', 'SALES_INVOICE', 'PURCHASE_RETURN', 'SALES_RETURN', 'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'DAMAGE', 'DAMAGE_REVERSED', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT', 'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN', 'TRANSFER_CANCELLED', 'TRANSFER_RECEIPT_CANCELLED', 'SALES_INVOICE_CANCELLED', 'PURCHASE_INVOICE_CANCELLED', 'PURCHASE_RETURN_CANCELLED', 'SALES_RETURN_CANCELLED')),
    quantity_before INT NOT NULL,
    quantity_changed INT NOT NULL,
    quantity_after INT NOT NULL,
    unit_cost NUMERIC(12, 2) DEFAULT 0.00,
    reference_doc_id VARCHAR(100),
    timestamp_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    timestamp_bs VARCHAR(20),
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150)
);

-- ==========================================
-- 15b. Sales Areas and Agents (Step 5)
-- ==========================================
-- Areas are the geographic/sales territory dimension; agents are the people
-- responsible for a territory. Both are sales masters, not ledger accounts.
-- An area may be global (NULL branch_id) or owned by one branch. Customers
-- default to an area/agent, and a posted invoice snapshots both.
CREATE TABLE IF NOT EXISTS areas (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    parent_id VARCHAR(50) REFERENCES areas(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE RESTRICT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT areas_parent_self CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_areas_parent ON areas(parent_id);
CREATE INDEX IF NOT EXISTS idx_areas_branch ON areas(branch_id);

CREATE TABLE IF NOT EXISTS sales_agents (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(150),
    area_id VARCHAR(50) REFERENCES areas(id) ON DELETE SET NULL,
    commission_rate NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (commission_rate >= 0 AND commission_rate <= 100),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_agents_area ON sales_agents(area_id);

-- ==========================================
-- 16. Customer Records Table
-- ==========================================
CREATE TABLE IF NOT EXISTS customer_records (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) UNIQUE NOT NULL,
    customer_name VARCHAR(200) NOT NULL,
    username VARCHAR(100),
    contact_number VARCHAR(50) NOT NULL,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    address TEXT,
    email VARCHAR(150),
    status VARCHAR(30) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    credit_limit NUMERIC(12, 2) DEFAULT 0.00,
    bill_terms_id VARCHAR(50) REFERENCES bill_terms(id) ON DELETE SET NULL,
    area_id VARCHAR(50) REFERENCES areas(id) ON DELETE SET NULL,
    agent_id VARCHAR(50) REFERENCES sales_agents(id) ON DELETE SET NULL,
    assigned_devices_count INT DEFAULT 0,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS bill_terms_id VARCHAR(50) REFERENCES bill_terms(id) ON DELETE SET NULL;
ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS area_id VARCHAR(50) REFERENCES areas(id) ON DELETE SET NULL;
ALTER TABLE customer_records ADD COLUMN IF NOT EXISTS agent_id VARCHAR(50) REFERENCES sales_agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_customer_records_bill_terms ON customer_records(bill_terms_id);
CREATE INDEX IF NOT EXISTS idx_customer_records_area ON customer_records(area_id);
CREATE INDEX IF NOT EXISTS idx_customer_records_agent ON customer_records(agent_id);

-- ==========================================
-- 10a-1. Sales Invoices Table (with items JSONB)
-- ==========================================
-- Lean sales module (prerequisite for Sales Returns): mirrors
-- purchase_invoices with customer fields instead of supplier fields.
-- Posting a sales invoice DECREMENTS branch stock (guard: quantity_on_hand).
CREATE TABLE IF NOT EXISTS sales_invoices (
    id VARCHAR(50) PRIMARY KEY,
    invoice_number VARCHAR(100) UNIQUE NOT NULL,
    customer_id VARCHAR(50) REFERENCES customer_records(id) ON DELETE SET NULL,
    customer_name VARCHAR(200) NOT NULL,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    invoice_date_ad DATE NOT NULL,
    invoice_date_bs VARCHAR(20) NOT NULL,
    bill_terms_id VARCHAR(50) REFERENCES bill_terms(id) ON DELETE SET NULL,
    due_date_ad DATE,
    due_date_bs VARCHAR(20),
    area_id VARCHAR(50) REFERENCES areas(id) ON DELETE SET NULL,
    area_name VARCHAR(150),
    agent_id VARCHAR(50) REFERENCES sales_agents(id) ON DELETE SET NULL,
    agent_name VARCHAR(150),
    taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    vat_amount NUMERIC(14, 2) DEFAULT 0.00,
    non_taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    grand_total NUMERIC(14, 2) DEFAULT 0.00,
    payment_status VARCHAR(30) DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PARTIAL', 'PAID')),
    -- Document lifecycle (payment_status tracks the money, this tracks the
    -- document): POSTED -> CANCELLED by the void path, which restores stock,
    -- releases the claimed serials and appends a compensating
    -- SALES_INVOICE_CANCELLED ledger row.
    status VARCHAR(30) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'CANCELLED')),
    payment_method VARCHAR(30) DEFAULT 'CREDIT' CHECK (payment_method IN ('CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER')),
    amount_paid NUMERIC(14, 2) DEFAULT 0.00,
    notes TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer ON sales_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_branch ON sales_invoices(branch_id);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS bill_terms_id VARCHAR(50) REFERENCES bill_terms(id) ON DELETE SET NULL;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS area_id VARCHAR(50) REFERENCES areas(id) ON DELETE SET NULL;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS area_name VARCHAR(150);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS agent_id VARCHAR(50) REFERENCES sales_agents(id) ON DELETE SET NULL;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS agent_name VARCHAR(150);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_bill_terms ON sales_invoices(bill_terms_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_area ON sales_invoices(area_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_agent ON sales_invoices(agent_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_date ON sales_invoices(invoice_date_ad);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_demo ON sales_invoices(id) WHERE is_demo = TRUE;

-- ==========================================
-- 10a-2. Purchase Returns Table (Debit Notes, items JSONB)
-- ==========================================
-- Returning goods to a vendor against a purchase invoice. Status lifecycle:
-- DRAFT (editable) -> POSTED (stock deducted + payable reduced) -> CANCELLED.
-- original_invoice_id is SET NULL on invoice delete; supplier snapshot
-- columns preserve history.
CREATE TABLE IF NOT EXISTS purchase_returns (
    id VARCHAR(50) PRIMARY KEY,
    return_number VARCHAR(100) UNIQUE NOT NULL,
    original_invoice_id VARCHAR(50) REFERENCES purchase_invoices(id) ON DELETE SET NULL,
    original_invoice_number VARCHAR(100),
    supplier_id VARCHAR(50) REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name VARCHAR(200) NOT NULL,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    return_date_ad DATE NOT NULL,
    return_date_bs VARCHAR(20) NOT NULL,
    reason VARCHAR(30) NOT NULL DEFAULT 'DEFECTIVE' CHECK (reason IN ('DEFECTIVE', 'WRONG_ITEM', 'SHORT_SUPPLY', 'OTHER')),
    notes TEXT,
    taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    vat_amount NUMERIC(14, 2) DEFAULT 0.00,
    non_taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    grand_total NUMERIC(14, 2) DEFAULT 0.00,
    status VARCHAR(30) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
    items JSONB DEFAULT '[]'::jsonb,
    -- B2: return #, original invoice, supplier and line items in one trigram-
    -- indexed expression (docs/architecture-backlog.md §B2).
    search_text TEXT GENERATED ALWAYS AS (
        lower(
            COALESCE(return_number, '') || ' ' ||
            COALESCE(original_invoice_number, '') || ' ' ||
            COALESCE(supplier_name, '') || ' ' ||
            COALESCE(items::text, '')
        )
    ) STORED,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_purchase_returns_supplier ON purchase_returns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_invoice ON purchase_returns(original_invoice_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_branch ON purchase_returns(branch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_date ON purchase_returns(return_date_ad);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_demo ON purchase_returns(id) WHERE is_demo = TRUE;

-- ==========================================
-- 10a-3. Sales Returns Table (Credit Notes, items JSONB)
-- ==========================================
-- Customer returning goods against a sales invoice. Same lifecycle as
-- purchase_returns: DRAFT -> POSTED (stock restored + receivable reduced).
CREATE TABLE IF NOT EXISTS sales_returns (
    id VARCHAR(50) PRIMARY KEY,
    return_number VARCHAR(100) UNIQUE NOT NULL,
    original_invoice_id VARCHAR(50) REFERENCES sales_invoices(id) ON DELETE SET NULL,
    original_invoice_number VARCHAR(100),
    customer_id VARCHAR(50) REFERENCES customer_records(id) ON DELETE SET NULL,
    customer_name VARCHAR(200) NOT NULL,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    return_date_ad DATE NOT NULL,
    return_date_bs VARCHAR(20) NOT NULL,
    reason VARCHAR(30) NOT NULL DEFAULT 'DEFECTIVE' CHECK (reason IN ('DEFECTIVE', 'WRONG_ITEM', 'OTHER')),
    restockable BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    vat_amount NUMERIC(14, 2) DEFAULT 0.00,
    non_taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    grand_total NUMERIC(14, 2) DEFAULT 0.00,
    status VARCHAR(30) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
    items JSONB DEFAULT '[]'::jsonb,
    -- B2: return #, original invoice, customer and line items in one trigram-
    -- indexed expression (docs/architecture-backlog.md §B2).
    search_text TEXT GENERATED ALWAYS AS (
        lower(
            COALESCE(return_number, '') || ' ' ||
            COALESCE(original_invoice_number, '') || ' ' ||
            COALESCE(customer_name, '') || ' ' ||
            COALESCE(items::text, '')
        )
    ) STORED,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_returns_customer ON sales_returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice ON sales_returns(original_invoice_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_branch ON sales_returns(branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_date ON sales_returns(return_date_ad);
CREATE INDEX IF NOT EXISTS idx_sales_returns_demo ON sales_returns(id) WHERE is_demo = TRUE;

-- ==========================================
-- 16b. Customer Payments Sub-ledger Table
-- ==========================================
-- Mirrors vendor_payments for the sales side: dated customer receipts
-- against sales invoices (CR-… cash receipt / BR-… bank receipt numbering).
-- The Customer Ledger's PAYMENT lines come from these rows, not from
-- sales_invoices.amount_paid.
CREATE TABLE IF NOT EXISTS customer_payments (
    id VARCHAR(50) PRIMARY KEY,
    payment_number VARCHAR(100) UNIQUE NOT NULL,
    customer_id VARCHAR(50) REFERENCES customer_records(id) ON DELETE SET NULL,
    customer_name VARCHAR(200) NOT NULL,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
    invoice_id VARCHAR(50) REFERENCES sales_invoices(id) ON DELETE SET NULL,
    invoice_number VARCHAR(100),
    payment_date_ad DATE NOT NULL,
    payment_date_bs VARCHAR(20),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(30) DEFAULT 'CASH' CHECK (payment_method IN ('CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER')),
    bank_name VARCHAR(150),
    bank_branch VARCHAR(150),
    account_number VARCHAR(100),
    cheque_number VARCHAR(100),
    cheque_date_ad DATE,
    cheque_date_bs VARCHAR(20),
    transaction_reference VARCHAR(200),
    settlement_account_id VARCHAR(50),
    notes TEXT,
    status VARCHAR(30) DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED', 'VOIDED')),
    reversal_reason TEXT,
    reversed_by VARCHAR(150),
    reversed_at_ad TIMESTAMP WITH TIME ZONE,
    original_payment_id VARCHAR(50) REFERENCES customer_payments(id) ON DELETE SET NULL,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_payments_customer ON customer_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_branch ON customer_payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_invoice ON customer_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_date ON customer_payments(payment_date_ad);
CREATE INDEX IF NOT EXISTS idx_customer_payments_status ON customer_payments(status);
CREATE INDEX IF NOT EXISTS idx_customer_payments_fiscal_year ON customer_payments(fiscal_year_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_demo ON customer_payments(id) WHERE is_demo = TRUE;

-- ==========================================
-- 17. Customer Device Records Table
-- ==========================================
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
    status VARCHAR(30) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISCONNECTED', 'RETURNED', 'REFUND', 'EXCHANGED', 'RENTAL', 'ROUTER_COLLECTED','IN_STOCK')),
    issued_date_ad DATE,
    issued_date_bs VARCHAR(20),
    purchase_bill_ref VARCHAR(100),
    notes TEXT,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 17a. Warranty Coverages (WTY-1)
-- ==========================================
-- One row per coverage period. VENDOR rows are what a supplier owes us;
-- SELLER rows are what we give a customer. `end_date_ad` is authoritative and
-- `term_months` keeps the term snapshot that produced it (NULL when an exact
-- date was entered freehand). The partial unique index allows one CURRENT row
-- per type + serial; a reissue/receipt supersedes the old row instead of
-- overwriting history.
CREATE TABLE IF NOT EXISTS warranty_coverages (
    id VARCHAR(60) PRIMARY KEY,
    coverage_type VARCHAR(10) NOT NULL CHECK (coverage_type IN ('VENDOR', 'SELLER')),
    item_category VARCHAR(20) NOT NULL CHECK (item_category IN ('CPE', 'FIXED_ASSET', 'SOLD_PRODUCT')),
    product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
    product_name VARCHAR(255) NOT NULL,
    serial_number VARCHAR(100) NOT NULL,
    asset_id VARCHAR(50) REFERENCES fixed_assets(id) ON DELETE CASCADE,
    device_record_id VARCHAR(50) REFERENCES customer_device_records(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    party_id VARCHAR(50),
    party_name VARCHAR(200),
    source_type VARCHAR(30) NOT NULL,
    source_id VARCHAR(60),
    source_number VARCHAR(120),
    start_date_ad DATE NOT NULL,
    start_date_bs VARCHAR(20),
    end_date_ad DATE NOT NULL,
    end_date_bs VARCHAR(20),
    term_months INT CHECK (term_months IS NULL OR term_months BETWEEN 0 AND 120),
    start_basis VARCHAR(30) NOT NULL DEFAULT 'MANUAL'
      CHECK (start_basis IN ('INVOICE_DATE', 'ACQUISITION_DATE', 'ISSUE_DATE', 'SALE_DATE', 'LEGACY_12_MONTH', 'MANUAL')),
    notes TEXT,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    superseded_at TIMESTAMP WITH TIME ZONE,
    -- Why a row left the active register, and the document that did it.
    -- Returned units keep their row (audit trail + the serial's coverage
    -- history); the registers show them as RETURNED instead of deleting them.
    retired_reason VARCHAR(40),
    retired_ref VARCHAR(120),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (end_date_ad >= start_date_ad)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_current_unit
  ON warranty_coverages (coverage_type, serial_number) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_warranty_type_end
  ON warranty_coverages (coverage_type, is_current, end_date_ad);
CREATE INDEX IF NOT EXISTS idx_warranty_branch_type_end
  ON warranty_coverages (branch_id, coverage_type, is_current, end_date_ad);
CREATE INDEX IF NOT EXISTS idx_warranty_source
  ON warranty_coverages (source_type, source_id);

-- Existing databases: the retirement columns arrived with the returns rework
-- (2026-10-30). A bare table declaration does not add columns to an existing
-- database.
ALTER TABLE warranty_coverages ADD COLUMN IF NOT EXISTS retired_reason VARCHAR(40);
ALTER TABLE warranty_coverages ADD COLUMN IF NOT EXISTS retired_ref VARCHAR(120);

-- ==========================================
-- 17a-1. Warranty Claims / RMA Lifecycle
-- ==========================================
-- A claim is opened against one current coverage period and owns its status
-- history. The partial unique index is the business rule: one unit cannot be
-- in two open claims for the same side of the warranty. REPLACED/REPAIRED/
-- CREDITED remain open until CLOSED, so a second claim cannot be opened while
-- the replacement or vendor credit is still in flight.
CREATE TABLE IF NOT EXISTS warranty_claims (
    id VARCHAR(60) PRIMARY KEY,
    claim_no VARCHAR(50) UNIQUE NOT NULL,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    coverage_id VARCHAR(60) REFERENCES warranty_coverages(id) ON DELETE SET NULL,
    coverage_type VARCHAR(10) NOT NULL CHECK (coverage_type IN ('VENDOR', 'SELLER')),
    customer_id VARCHAR(50),
    customer_name VARCHAR(200),
    serial_number VARCHAR(100) NOT NULL,
    product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
    product_name VARCHAR(255) NOT NULL,
    reported_date_ad DATE NOT NULL,
    reported_date_bs VARCHAR(20),
    symptom TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'REPORTED' CHECK (status IN (
        'REPORTED', 'APPROVED', 'REJECTED', 'SENT_TO_VENDOR',
        'REPLACED', 'REPAIRED', 'CREDITED', 'CLOSED'
    )),
    resolution VARCHAR(20) CHECK (resolution IS NULL OR resolution IN ('REPLACED', 'REPAIRED', 'CREDITED')),
    vendor_id VARCHAR(50),
    vendor_name VARCHAR(200),
    vendor_claim_ref VARCHAR(120),
    expected_credit NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (expected_credit >= 0),
    received_credit NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (received_credit >= 0),
    credit_note_no VARCHAR(120),
    journal_id VARCHAR(60),
    replacement_serial VARCHAR(100),
    rma_reference VARCHAR(120),
    sent_to_vendor_date_ad DATE,
    sent_to_vendor_date_bs VARCHAR(20),
    resolved_date_ad DATE,
    resolved_date_bs VARCHAR(20),
    closed_date_ad DATE,
    closed_date_bs VARCHAR(20),
    notes TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_claim_open_unit
  ON warranty_claims (coverage_type, serial_number)
  WHERE status NOT IN ('CLOSED', 'REJECTED');
CREATE INDEX IF NOT EXISTS idx_warranty_claim_branch_status
  ON warranty_claims (branch_id, status, reported_date_ad);
CREATE INDEX IF NOT EXISTS idx_warranty_claim_serial
  ON warranty_claims ((lower(trim(serial_number))));
CREATE INDEX IF NOT EXISTS idx_warranty_claim_recovery_rma
  ON warranty_claims (branch_id, sent_to_vendor_date_ad)
  WHERE status = 'SENT_TO_VENDOR';
CREATE INDEX IF NOT EXISTS idx_warranty_claim_recovery_credit
  ON warranty_claims (branch_id, coverage_type, expected_credit, received_credit);

CREATE TABLE IF NOT EXISTS warranty_claim_events (
    id VARCHAR(60) PRIMARY KEY,
    claim_id VARCHAR(60) NOT NULL REFERENCES warranty_claims(id) ON DELETE CASCADE,
    from_status VARCHAR(20),
    status VARCHAR(20) NOT NULL CHECK (status IN (
        'REPORTED', 'APPROVED', 'REJECTED', 'SENT_TO_VENDOR',
        'REPLACED', 'REPAIRED', 'CREDITED', 'CLOSED'
    )),
    note TEXT,
    actor VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_warranty_claim_event_claim
  ON warranty_claim_events (claim_id, created_at);

-- ==========================================
-- 17b. Serial Log (one row per unique serial — consolidated register)
-- ==========================================
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
    status VARCHAR(30) NOT NULL DEFAULT 'IN_STOCK' CHECK (status IN ('IN_STOCK', 'IN_TRANSIT', 'CUSTOMER_ASSIGNED', 'POP_LOCATION_ASSIGNED', 'DAMAGED', 'RETURNED', 'SOLD', 'RETURNED_TO_VENDOR', 'CONSUMED')),
    source_type VARCHAR(30) NOT NULL DEFAULT 'PURCHASE',
    source_id VARCHAR(50),
    history_json TEXT DEFAULT '[]',
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 18. Approval Requests Table
-- ==========================================
CREATE TABLE IF NOT EXISTS approval_requests (
    id VARCHAR(50) PRIMARY KEY,
    request_number VARCHAR(100) UNIQUE NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('CUSTOMER_DEVICE_STATUS', 'CANCEL_TRANSFER', 'CANCEL_IN_TRANSIT_TRANSFER', 'CANCEL_RECEIVE_TRANSFER', 'STOCK_AUDIT_RECONCILIATION', 'BULK_STOCK_ADJUSTMENT')),
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
    status VARCHAR(30) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    requested_at_ad TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    requested_at_bs VARCHAR(20),
    audit_data JSONB,
    processed_by_email VARCHAR(150),
    processed_by_name VARCHAR(150),
    processed_by_role VARCHAR(50),
    processed_at_ad TIMESTAMP WITH TIME ZONE,
    processed_at_bs VARCHAR(20),
    rejection_reason TEXT,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 19. BS Calendar Years Table
-- ==========================================
CREATE TABLE IF NOT EXISTS bs_calendar_years (
    year_bs INT PRIMARY KEY,
    days_in_months INT[] NOT NULL,
    start_ad DATE NOT NULL,
    -- Where start_ad came from. 'patro': an operator entered Baisakh 1 from the
    -- published patro / the bundled reference data. 'estimated': derived at
    -- seed time (previous seeded year's end + 1, or the year-57 approximation
    -- when there is nothing to continue from). is_provisional marks any year
    -- whose month array the published patro does not verify yet, so consumers
    -- (coverage warning, integrity audit, seeding result) say so out loud
    -- instead of letting a guess pass as the calendar.
    start_ad_source VARCHAR(20) NOT NULL DEFAULT 'patro',
    is_provisional BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Provisional-year tracking for databases created before the columns existed.
-- Idempotent and data-free: no patro year list is repeated here (the bundled
-- shared/bsCalendarYears.json is the only copy), so a legacy row keeps the
-- 'patro' default until the integrity audit re-classifies it.
ALTER TABLE bs_calendar_years ADD COLUMN IF NOT EXISTS start_ad_source VARCHAR(20) NOT NULL DEFAULT 'patro';
ALTER TABLE bs_calendar_years ADD COLUMN IF NOT EXISTS is_provisional BOOLEAN NOT NULL DEFAULT FALSE;

-- ==========================================
-- 20. BS Day Records Table
-- ==========================================
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
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    quarter VARCHAR(10) NOT NULL,
    is_weekend BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- One row per BS month, derived from the authoritative day records above.
-- Reports group by `quarter` and the Nepali month names without re-deriving
-- either from a screen; `ad_date`/`bs_date` are the first day of the month and
-- `ad_end_date`/`bs_end_date` are its last day. `rebuild_bs_months()` is called
-- after every calendar seed/repair so this cache cannot drift from the days.
CREATE TABLE IF NOT EXISTS bs_months (
    bs_year INT NOT NULL,
    bs_month INT NOT NULL,
    bs_date VARCHAR(20) NOT NULL,
    ad_date DATE NOT NULL,
    ad_end_date DATE NOT NULL,
    bs_end_date VARCHAR(20) NOT NULL,
    bs_month_name VARCHAR(50) NOT NULL,
    bs_month_name_np VARCHAR(50) NOT NULL,
    fiscal_year VARCHAR(20) NOT NULL,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    quarter VARCHAR(10) NOT NULL CHECK (quarter IN ('Q1', 'Q2', 'Q3', 'Q4')),
    PRIMARY KEY (bs_year, bs_month)
);

CREATE OR REPLACE FUNCTION rebuild_bs_months()
RETURNS void AS $$
BEGIN
  DELETE FROM bs_months;
  INSERT INTO bs_months (
    bs_year, bs_month, bs_date, ad_date, ad_end_date, bs_end_date,
    bs_month_name, bs_month_name_np, fiscal_year, fiscal_year_id, quarter
  )
  SELECT
    bs_year, bs_month, MIN(bs_date), MIN(ad_date), MAX(ad_date), MAX(bs_date),
    MIN(bs_month_name), MIN(bs_month_name_np), MIN(fiscal_year),
    MIN(fiscal_year_id), MIN(quarter)
  FROM bs_day_records
  GROUP BY bs_year, bs_month;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 21. UOM (Unit of Measure) Table
-- ==========================================
CREATE TABLE IF NOT EXISTS uom (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    symbol VARCHAR(30) NOT NULL,
    type VARCHAR(50) DEFAULT 'Count',
    is_base_unit BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 22. Locations Table
-- ==========================================
CREATE TABLE IF NOT EXISTS locations (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('POP_SERVER_ROOM', 'FIBER_NETWORK_NODE', 'CUSTOMER_SITE', 'WAREHOUSE', 'BRANCH_OFFICE', 'STORE', 'OFFICE', 'DEPOT')),
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    address TEXT,
    coordinates JSONB,
    contact_person VARCHAR(150),
    contact_phone VARCHAR(50),
    notes TEXT,
    active_assets_count INT DEFAULT 0,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 23. Company Profile Table
-- ==========================================
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
    default_tax_rate NUMERIC(5, 2) DEFAULT 13.00,
    notes TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 24. Document Number Configurations Table
-- ==========================================
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

-- 24b. Daily Document Sequence Counters (per branch, per document type, per day)
-- ==============================================================================
-- Strict per-branch audit numbering. Format produced by the server:
--   {DOC_TYPE}-{BRANCH_CODE}-{YYYYMMDD}{NNNN}
-- e.g. PO-BRC01-202609150001
--
-- One row exists per (branch, doc type, calendar day). The counter resets
-- naturally every day because a new date key starts at 1 — there is no
-- fiscal-year reset and never any reuse across days. The number is issued
-- atomically (INSERT ... ON CONFLICT DO UPDATE ... RETURNING next_number)
-- so concurrent users can never receive duplicates even across server
-- restarts (state is durable here, not in memory).
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

-- ============================================================================
-- 30. Permission Matrix (server-side authority for role-based operation gating)
-- One row per (operation_id, role). Mirrors the server's permission matrix:
-- the server seeds the actual operation/role rows at startup with
-- INSERT ... ON CONFLICT DO NOTHING, so an empty table on a fresh install is
-- correct. Creating the table here keeps setup_db.js's truncate-and-verify
-- flow consistent with the runtime schema.
-- ============================================================================
CREATE TABLE IF NOT EXISTS permission_matrix (
    operation_id VARCHAR(60) NOT NULL,
    role VARCHAR(40) NOT NULL,
    allowed BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (operation_id, role)
);

CREATE INDEX IF NOT EXISTS idx_permission_matrix_role ON permission_matrix(role);

-- Sub Super Admin (stored as HEAD_OFFICE_ADMIN) manages accounts and roles.
-- Applied once, during the upgrade that introduces HR Self Service, so a tenant
-- that later turns it off for that role keeps its own decision.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permission_matrix WHERE role = 'HR_SELF_SERVICE') THEN
    UPDATE permission_matrix SET allowed = true
    WHERE operation_id = 'admin-users' AND role = 'HEAD_OFFICE_ADMIN';
  END IF;
END $$;

-- HR Self Service is the one role that reads its own HR record and nothing else.
-- The row set is derived from an existing role so the new role has an explicit
-- decision for every operation, with only the self-service ones open. Existing
-- tenants therefore gain it without an administrator re-saving the matrix.
INSERT INTO permission_matrix (operation_id, role, allowed)
SELECT DISTINCT operation_id, 'HR_SELF_SERVICE', (operation_id LIKE 'hr-self%')
FROM permission_matrix
WHERE role = 'SUPER_ADMIN'
ON CONFLICT (operation_id, role) DO NOTHING;

-- ============================================================================
-- 30b. Per-user Permission Overrides (plan: docs/permission-overrides-plan.md)
-- An exception layer on TOP of permission_matrix: one row changes one
-- operation for one user, without changing what their role means for anyone
-- else. Resolution order (server/src/services/permissionOverrides.service.ts):
--   SUPER_ADMIN -> allowed; user deny -> denied; user grant -> allowed;
--   otherwise the role's permission_matrix row.
-- `reason` is required by the API (audit requirement). `expires_at` is
-- evaluated on read, so a temporary grant needs no follow-up job; the row is
-- kept for the trail after it expires. ON DELETE CASCADE means removing a user
-- removes their exceptions, never leaving orphan grants.
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_permission_overrides (
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id VARCHAR(60) NOT NULL,
    effect VARCHAR(10) NOT NULL CHECK (effect IN ('grant', 'deny')),
    reason TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_by VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user ON user_permission_overrides(user_id);

-- ============================================================================
-- 30c. Reusable Permission Sets (phase 2 of docs/permission-overrides-plan.md)
-- A named bundle of GRANTS that several users can share. Resolution is:
--   SUPER_ADMIN -> allowed; this user's explicit override -> its effect;
--   any assigned set granting the operation -> allowed; otherwise the role's
--   permission_matrix row. A per-user deny therefore still wins over a set.
-- Sets carry grants only (no deny), so removing a member can never silently
-- change what a role means. Membership cascades with the user, and deleting a
-- set cascades its grants and memberships, so no orphan grant can survive.
-- ============================================================================
CREATE TABLE IF NOT EXISTS permission_sets (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_sets_name_lower ON permission_sets (LOWER(name));

CREATE TABLE IF NOT EXISTS permission_set_grants (
    set_id VARCHAR(50) NOT NULL REFERENCES permission_sets(id) ON DELETE CASCADE,
    operation_id VARCHAR(60) NOT NULL,
    PRIMARY KEY (set_id, operation_id)
);

CREATE TABLE IF NOT EXISTS permission_set_members (
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_id VARCHAR(50) NOT NULL REFERENCES permission_sets(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, set_id)
);

CREATE INDEX IF NOT EXISTS idx_permission_set_members_set ON permission_set_members(set_id);

-- ============================================================================
-- 31. Application Settings (company-wide configuration, key/value)
-- Server-side authority for settings that used to live ONLY in browser
-- localStorage (e.g. the company-wide blind stock-audit toggle), so clearing
-- browser storage can never change how the application behaves. Clients read
-- these from GET /api/bootstrap (appSettings slice) and write them with
-- PUT /api/settings (SUPER_ADMIN only). Unknown keys are rejected by the
-- settings controller, so the table only ever holds whitelisted settings.
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(80) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_by VARCHAR(150),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 32. User Preferences (per-user UI preferences, key/value)
-- Replaces the per-browser localStorage copies of theme / date mode /
-- last active tab, so a preference follows the user to any machine and
-- survives clearing browser history. Scoped to the user row: deleting a user
-- removes their preferences automatically.
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pref_key VARCHAR(80) NOT NULL,
    pref_value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, pref_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);

-- ============================================================================
-- 33. Accounting — chart of accounts, periods, journals and subledgers
--
-- The general ledger is the accounting source of truth. Operational tables
-- (invoices, payments, stock moves) remain their own transaction records; a
-- later slice posts them into these tables inside the same transaction. This
-- slice ships the ledger core only: account groups/accounts with statement
-- mapping and posting defaults, monthly periods with close/reopen, balanced
-- journals with a branch dimension, and generic subledger entries that every
-- control account must reconcile to.
--
-- Money is NUMERIC(14,2); a journal line is exactly one-sided (debit XOR
-- credit), and both the header period and every line carry the branch so a
-- branch P&L/BS can be produced without joining back through payload JSON.
-- ============================================================================
CREATE TABLE IF NOT EXISTS gl_account_groups (
    id VARCHAR(50) PRIMARY KEY,
    -- Optional parent: groups may nest to any depth, and a sub-group carries
    -- the same type and statement mapping as its nearest parent. Accounts
    -- attach to any group but remain the only postable nodes.
    parent_id VARCHAR(50) REFERENCES gl_account_groups(id) ON DELETE RESTRICT,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
    statement_group VARCHAR(30) NOT NULL CHECK (statement_group IN (
        'CURRENT_ASSET', 'NON_CURRENT_ASSET', 'CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY',
        'EQUITY', 'REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE'
    )),
    normal_balance VARCHAR(6) NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gl_account_groups_parent_self CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Existing installs predate the hierarchy; CREATE TABLE IF NOT EXISTS does
-- not add a column to them.
ALTER TABLE gl_account_groups ADD COLUMN IF NOT EXISTS parent_id VARCHAR(50) REFERENCES gl_account_groups(id) ON DELETE RESTRICT;
ALTER TABLE gl_account_groups DROP CONSTRAINT IF EXISTS gl_account_groups_parent_self;
ALTER TABLE gl_account_groups ADD CONSTRAINT gl_account_groups_parent_self CHECK (parent_id IS NULL OR parent_id <> id);
CREATE INDEX IF NOT EXISTS idx_gl_account_groups_parent ON gl_account_groups(parent_id);

CREATE TABLE IF NOT EXISTS gl_accounts (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    group_id VARCHAR(50) NOT NULL REFERENCES gl_account_groups(id) ON DELETE RESTRICT,
    description TEXT,
    -- Legacy GL-master fields (short name, category, credit terms, tax type,
    -- currency, guarantee/deposit notes) that do not change posting behaviour.
    -- They live in one jsonb profile so the master form can carry the full
    -- legacy field set without 15 mostly-unused columns on the ledger table.
    master_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_control BOOLEAN NOT NULL DEFAULT FALSE,
    subledger_type VARCHAR(30) NOT NULL DEFAULT 'NONE' CHECK (subledger_type IN (
        'NONE', 'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'INVENTORY', 'FIXED_ASSET', 'BANK', 'CASH', 'TAX', 'INTER_BRANCH'
    )),
    -- One account per posting purpose (AR control, cash, etc.). NULL means the
    -- account is not a default. The partial unique index below enforces one.
    posting_role VARCHAR(40) CHECK (posting_role IN (
        'AR_CONTROL', 'AP_CONTROL', 'CASH', 'BANK', 'INVENTORY', 'SALES', 'COGS',
        'TAX_OUTPUT', 'TAX_INPUT', 'RETAINED_EARNINGS', 'SALARY_PAYABLE', 'INTER_BRANCH_CLEARING',
        'STOCK_EXPENSE', 'CPE_ASSET', 'DUE_FROM_HO', 'DUE_TO_HO',
        'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'DEPRECIATION_EXPENSE',
        'GAIN_ON_DISPOSAL', 'LOSS_ON_DISPOSAL',
        'SALARY_EXPENSE', 'TDS_PAYABLE', 'SSF_PAYABLE', 'EMPLOYEE_ADVANCE', 'EMPLOYEE_LOAN'
    )),
    -- CASH/BANK classify every till and bank ledger, including the extra ones
    -- that deliberately have no posting role. OTHER is every non-cash ledger.
    account_kind VARCHAR(10) NOT NULL DEFAULT 'OTHER' CHECK (account_kind IN ('CASH', 'BANK', 'OTHER')),
    bank_name VARCHAR(150),
    bank_branch VARCHAR(150),
    account_number VARCHAR(100),
    account_holder VARCHAR(150),
    swift_code VARCHAR(50),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- A control account always names its subledger; an ordinary account never
    -- pretends to have one. Without this, reconciliation could silently compare
    -- a control balance with an empty subledger.
    CONSTRAINT gl_accounts_control_subledger_check CHECK (
        (is_control = FALSE AND subledger_type = 'NONE') OR
        (is_control = TRUE AND subledger_type <> 'NONE')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_accounts_posting_role
    ON gl_accounts(posting_role) WHERE posting_role IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_accounts_group ON gl_accounts(group_id);

-- Existing installs created gl_accounts before the stock-expense role existed;
-- CREATE TABLE IF NOT EXISTS does not alter their inline CHECK constraint.
ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_posting_role_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_posting_role_check CHECK (posting_role IN (
    'AR_CONTROL', 'AP_CONTROL', 'CASH', 'BANK', 'INVENTORY', 'SALES', 'COGS',
    'TAX_OUTPUT', 'TAX_INPUT', 'RETAINED_EARNINGS', 'SALARY_PAYABLE', 'INTER_BRANCH_CLEARING',
    'STOCK_EXPENSE', 'CPE_ASSET', 'DUE_FROM_HO', 'DUE_TO_HO',
    'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'DEPRECIATION_EXPENSE',
    'GAIN_ON_DISPOSAL', 'LOSS_ON_DISPOSAL',
    'SALARY_EXPENSE', 'TDS_PAYABLE', 'SSF_PAYABLE', 'EMPLOYEE_ADVANCE', 'EMPLOYEE_LOAN'
));

-- Existing installs need the new ledger classification and bank metadata. The
-- default cash/bank ledgers are classified from the posting role they already
-- carry; every other account starts as OTHER and can be corrected in the chart.
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS account_kind VARCHAR(10) NOT NULL DEFAULT 'OTHER';
CREATE INDEX IF NOT EXISTS idx_gl_accounts_kind ON gl_accounts(account_kind);
ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_account_kind_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_account_kind_check
    CHECK (account_kind IN ('CASH', 'BANK', 'OTHER'));
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_name VARCHAR(150);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_branch VARCHAR(150);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS account_number VARCHAR(100);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS account_holder VARCHAR(150);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS swift_code VARCHAR(50);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS master_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE gl_accounts SET account_kind = CASE
    WHEN posting_role = 'CASH' THEN 'CASH'
    WHEN posting_role = 'BANK' THEN 'BANK'
    ELSE account_kind
  END
 WHERE posting_role IN ('CASH', 'BANK') AND account_kind = 'OTHER';

-- Subledger master: named books behind a control ledger. A book with no
-- party_id is that account's general book (one per account); a book with a
-- party_id is one party's own book under the same control account (unlimited
-- employees under Salary Payable, customers under AR, suppliers under AP).
-- Posting picks the party's book first, then the general book.
CREATE TABLE IF NOT EXISTS gl_subledgers (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    subledger_type VARCHAR(30) NOT NULL CHECK (subledger_type IN (
        'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'INVENTORY', 'FIXED_ASSET', 'BANK', 'CASH', 'TAX', 'INTER_BRANCH'
    )),
    main_account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    -- NULL is the account-wide book; otherwise the id of the party in the
    -- shared master (customer_records.customer_id, suppliers.id, employees.id).
    party_id VARCHAR(100),
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gl_subledgers_type ON gl_subledgers(subledger_type);

-- Existing installs had one book per control account. Uniqueness now applies
-- per party: exactly one general book, and one book per (account, party).
ALTER TABLE gl_subledgers DROP CONSTRAINT IF EXISTS gl_subledgers_main_account_id_key;
ALTER TABLE gl_subledgers ADD COLUMN IF NOT EXISTS party_id VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_subledgers_general
    ON gl_subledgers(main_account_id) WHERE party_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_subledgers_party
    ON gl_subledgers(main_account_id, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_subledgers_party
    ON gl_subledgers(subledger_type, party_id);

-- Cost centres are an analytical dimension on journal lines, deliberately
-- separate from branch (a location) and from the ledger account. A NULL
-- branch_id makes the centre available to every branch; a set branch_id keeps
-- it inside that branch. Parent rows let the master mirror a department tree.
CREATE TABLE IF NOT EXISTS cost_centers (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    parent_id VARCHAR(50) REFERENCES cost_centers(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE RESTRICT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT cost_centers_parent_self CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_cost_centers_parent ON cost_centers(parent_id);
CREATE INDEX IF NOT EXISTS idx_cost_centers_branch ON cost_centers(branch_id);

-- Narration templates are quick-pick text only. The journal stores the chosen
-- text, never the template id, so editing a template never rewrites history.
CREATE TABLE IF NOT EXISTS narration_templates (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    text TEXT NOT NULL,
    transaction_type VARCHAR(40) NOT NULL DEFAULT 'ALL',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_narration_templates_type ON narration_templates(transaction_type);

-- Payment documents name the till/bank ledger they actually settled through.
-- NULL keeps the posting default for historical rows and older clients.
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS settlement_account_id VARCHAR(50);
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS settlement_account_id VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_settlement_account
  ON vendor_payments(settlement_account_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_settlement_account
  ON customer_payments(settlement_account_id);

-- Both payment tables are created before gl_accounts, so their settlement FK
-- is added here once the ledger table exists. The guard keeps re-running the
-- schema idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_payments_settlement_account_fkey'
  ) THEN
    ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_settlement_account_fkey
      FOREIGN KEY (settlement_account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customer_payments_settlement_account_fkey'
  ) THEN
    ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_settlement_account_fkey
      FOREIGN KEY (settlement_account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gl_periods (
    id VARCHAR(50) PRIMARY KEY,
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
    period_key VARCHAR(7) NOT NULL,
    start_date_ad DATE NOT NULL,
    start_date_bs VARCHAR(20),
    end_date_ad DATE NOT NULL,
    end_date_bs VARCHAR(20),
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    closed_at TIMESTAMP WITH TIME ZONE,
    closed_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gl_periods_date_order CHECK (end_date_ad >= start_date_ad),
    UNIQUE (fiscal_year_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_gl_periods_dates ON gl_periods(start_date_ad, end_date_ad);
ALTER TABLE gl_periods ADD COLUMN IF NOT EXISTS start_date_bs VARCHAR(20);
ALTER TABLE gl_periods ADD COLUMN IF NOT EXISTS end_date_bs VARCHAR(20);

-- Budgets: one header per fiscal year and branch, with a monthly amount per
-- profit-and-loss account. Cost-centre budgeting is deliberately not modelled
-- yet; the variance read is account-level and reconciles to posted journals.
CREATE TABLE IF NOT EXISTS gl_budgets (
    id VARCHAR(50) PRIMARY KEY,
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    locked_at TIMESTAMP WITH TIME ZONE,
    locked_by VARCHAR(150),
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (fiscal_year_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_gl_budgets_scope ON gl_budgets(fiscal_year_id, branch_id);

-- An explicit whole-budget lock sits above the per-period CLOSED status. It
-- stops the save, copy and CSV-import paths without hiding the budget or its
-- variance; unlocking is audited and leaves the stored lines untouched.
ALTER TABLE gl_budgets ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE gl_budgets ADD COLUMN IF NOT EXISTS locked_by VARCHAR(150);

CREATE TABLE IF NOT EXISTS gl_budget_lines (
    id VARCHAR(60) PRIMARY KEY,
    budget_id VARCHAR(50) NOT NULL REFERENCES gl_budgets(id) ON DELETE CASCADE,
    period_key VARCHAR(7) NOT NULL,
    account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (budget_id, period_key, account_id)
);

CREATE INDEX IF NOT EXISTS idx_gl_budget_lines_account ON gl_budget_lines(account_id);

-- Immutable budget history. A row is the prior state of a budget, written
-- before the amount lines change; restore writes another row rather than
-- updating an older one. `lines` is the exact stored line snapshot, including
-- the chart code/name at that point in time. The source says which path made
-- the version (manual save, copy, import, replace, restore or the baseline).
CREATE TABLE IF NOT EXISTS gl_budget_versions (
    id VARCHAR(60) PRIMARY KEY,
    budget_id VARCHAR(50) NOT NULL REFERENCES gl_budgets(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    actor VARCHAR(150),
    source VARCHAR(20) NOT NULL CHECK (source IN (
        'BASELINE', 'SAVE', 'COPY', 'COPY_REPLACE',
        'IMPORT', 'IMPORT_REPLACE', 'RESTORE'
    )),
    source_detail VARCHAR(200),
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (budget_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_gl_budget_versions_budget
    ON gl_budget_versions(budget_id, version_no DESC);

-- Upgrade path for budgets saved before history existed: one immutable
-- baseline snapshot of their current lines. Guarded so every boot/schema
-- application is a no-op once the budget has any version.
INSERT INTO gl_budget_versions (
    id, budget_id, version_no, actor, source, source_detail, lines
)
SELECT 'glbv-baseline-' || b.id,
    b.id,
    1,
    COALESCE(b.updated_by, b.created_by),
    'BASELINE',
    'Existing budget baseline',
    COALESCE(
        jsonb_agg(jsonb_build_object(
            'periodKey', bl.period_key,
            'accountId', bl.account_id,
            'amount', bl.amount,
            'code', a.code,
            'name', a.name,
            'accountType', g.account_type
        ) ORDER BY bl.period_key, a.code)
        FILTER (WHERE bl.id IS NOT NULL),
        '[]'::jsonb
    )
FROM gl_budgets b
LEFT JOIN gl_budget_lines bl ON bl.budget_id = b.id
LEFT JOIN gl_accounts a ON a.id = bl.account_id
LEFT JOIN gl_account_groups g ON g.id = a.group_id
WHERE NOT EXISTS (
    SELECT 1 FROM gl_budget_versions v WHERE v.budget_id = b.id
)
GROUP BY b.id, b.updated_by, b.created_by
ON CONFLICT DO NOTHING;

-- Cost-centre allocation for operating-expense budgets. A profile belongs to
-- one fiscal year + branch. Its DEFAULT rules apply to every expense statement
-- group; an optional group-specific override (for example OPERATING_EXPENSE)
-- replaces the default for that group. Percentages are stored in basis points
-- so a profile can prove it totals exactly 100.00% without floating-point
-- ambiguity. This is a management-allocation setting; it never posts a journal
-- or changes the account-level budget lines.
CREATE TABLE IF NOT EXISTS gl_budget_allocation_profiles (
    id VARCHAR(60) PRIMARY KEY,
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (fiscal_year_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_gl_budget_allocation_profiles_branch
    ON gl_budget_allocation_profiles(branch_id, fiscal_year_id);

CREATE TABLE IF NOT EXISTS gl_budget_allocation_lines (
    id VARCHAR(60) PRIMARY KEY,
    profile_id VARCHAR(60) NOT NULL REFERENCES gl_budget_allocation_profiles(id) ON DELETE CASCADE,
    account_group VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
    cost_center_id VARCHAR(50) NOT NULL REFERENCES cost_centers(id) ON DELETE RESTRICT,
    percentage_bp INTEGER NOT NULL CHECK (percentage_bp >= 0 AND percentage_bp <= 10000),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (btrim(account_group) <> ''),
    UNIQUE (profile_id, account_group, cost_center_id)
);

CREATE INDEX IF NOT EXISTS idx_gl_budget_allocation_lines_profile
    ON gl_budget_allocation_lines(profile_id, account_group);
CREATE INDEX IF NOT EXISTS idx_gl_budget_allocation_lines_cost_center
    ON gl_budget_allocation_lines(cost_center_id);

CREATE SEQUENCE IF NOT EXISTS gl_journal_no_seq AS BIGINT START WITH 1;

-- Journal identity is non-partitioned so every existing foreign key that names
-- only a journal id can keep its current shape while the ledger rows live in
-- monthly partitions. The trigger at the end of this file keeps it in step.
CREATE TABLE IF NOT EXISTS gl_journals_registry (
    id VARCHAR(50) PRIMARY KEY,
    journal_no VARCHAR(50) UNIQUE NOT NULL,
    journal_date_ad DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS gl_journals (
    id VARCHAR(50) NOT NULL,
    journal_no VARCHAR(50) NOT NULL,
    journal_date_ad DATE NOT NULL,
    journal_date_bs VARCHAR(20),
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
    period_id VARCHAR(50) NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    source_type VARCHAR(30) NOT NULL DEFAULT 'MANUAL',
    source_id VARCHAR(100),
    -- Voucher-form metadata. Amounts in gl_journal_lines stay in NPR; the
    -- currency/rate record how a foreign-currency voucher was converted.
    voucher_type VARCHAR(30) NOT NULL DEFAULT 'JOURNAL',
    voucher_class VARCHAR(50),
    reference_no VARCHAR(100),
    reference_date_ad DATE,
    reference_date_bs VARCHAR(20),
    cheque_no VARCHAR(100),
    cheque_date_ad DATE,
    cheque_date_bs VARCHAR(20),
    currency VARCHAR(10) NOT NULL DEFAULT 'NPR',
    exchange_rate NUMERIC(14, 6) NOT NULL DEFAULT 1,
    memo TEXT,
    status VARCHAR(10) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
    reversal_of_id VARCHAR(50) REFERENCES gl_journals_registry(id) ON DELETE SET NULL,
    posted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    posted_by VARCHAR(150),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, journal_date_ad),
    UNIQUE (journal_no, journal_date_ad)
) PARTITION BY RANGE (journal_date_ad);

CREATE INDEX IF NOT EXISTS idx_gl_journals_date ON gl_journals(journal_date_ad);
CREATE INDEX IF NOT EXISTS idx_gl_journals_branch ON gl_journals(branch_id, journal_date_ad);
CREATE INDEX IF NOT EXISTS idx_gl_journals_period ON gl_journals(period_id, journal_date_ad);
CREATE INDEX IF NOT EXISTS idx_gl_journals_source ON gl_journals(source_type, source_id, journal_date_ad);
CREATE INDEX IF NOT EXISTS idx_gl_journals_reversal_of ON gl_journals(reversal_of_id, journal_date_ad);
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS voucher_type VARCHAR(30) NOT NULL DEFAULT 'JOURNAL';
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS voucher_class VARCHAR(50);
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS reference_no VARCHAR(100);
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS reference_date_ad DATE;
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS reference_date_bs VARCHAR(20);
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(100);
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS cheque_date_ad DATE;
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS cheque_date_bs VARCHAR(20);
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS journal_date_bs VARCHAR(20);
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'NPR';
ALTER TABLE gl_journals ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(14, 6) NOT NULL DEFAULT 1;
-- A partitioned unique index must include the partition key. The registry's
-- unique journal_no remains the global identity guard. Stock and vendor
-- openings are replaceable: a re-save reverses the prior register journal and
-- posts the current valuation under the same source id, so they are excluded
-- from the one-per-branch-and-date guard (the service still allows only one
-- active opening per branch).
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_journals_opening_balance
  ON gl_journals(branch_id, journal_date_ad)
  WHERE source_type = 'OPENING_BALANCE'
    AND COALESCE(source_id, '') NOT LIKE 'stock-opening:%'
    AND COALESCE(source_id, '') NOT LIKE 'vendor-opening:%';

CREATE TABLE IF NOT EXISTS gl_journal_line_registry (
    id VARCHAR(60) PRIMARY KEY,
    journal_id VARCHAR(50) NOT NULL REFERENCES gl_journals_registry(id) ON DELETE CASCADE,
    line_no INT NOT NULL,
    journal_date_ad DATE NOT NULL,
    UNIQUE (journal_id, line_no)
);

CREATE TABLE IF NOT EXISTS gl_journal_lines (
    id VARCHAR(60) NOT NULL,
    journal_id VARCHAR(50) NOT NULL,
    journal_date_ad DATE NOT NULL,
    journal_date_bs VARCHAR(20) NOT NULL,
    line_no INT NOT NULL,
    account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    cost_center_id VARCHAR(50) REFERENCES cost_centers(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    memo TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gl_journal_lines_one_sided CHECK (
        debit >= 0 AND credit >= 0 AND
        ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
    ),
    PRIMARY KEY (id, journal_date_ad),
    UNIQUE (journal_id, line_no, journal_date_ad),
    FOREIGN KEY (journal_id, journal_date_ad)
      REFERENCES gl_journals(id, journal_date_ad) ON DELETE CASCADE
) PARTITION BY RANGE (journal_date_ad);

CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_account ON gl_journal_lines(account_id, branch_id, journal_date_ad);
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_journal ON gl_journal_lines(journal_id, journal_date_ad);
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS cost_center_id VARCHAR(50) REFERENCES cost_centers(id) ON DELETE RESTRICT;
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS journal_date_bs VARCHAR(20);
DO $$
BEGIN
  -- Existing installs: inherit the header's already-resolved BS half. The
  -- one-time backfill is allowed through the append-only guard.
  PERFORM set_config('inventory.allow_ledger_purge', 'on', true);
  EXECUTE $backfill$
    UPDATE gl_journal_lines l
       SET journal_date_bs = j.journal_date_bs
      FROM gl_journals j
     WHERE j.id = l.journal_id
       AND l.journal_date_bs IS NULL
  $backfill$;
END $$;
ALTER TABLE gl_journal_lines ALTER COLUMN journal_date_bs SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_cost_center ON gl_journal_lines(cost_center_id);

-- ==========================================
-- 34f. Immutable year-end balance snapshots
-- ==========================================
-- Closing a year zeroes income and expense accounts, so the pre-close result
-- cannot be reconstructed from the ledger afterwards. The close writes this
-- bounded, immutable snapshot in the same transaction: one row per branch and
-- account, with the trial balance through the year end, the closing journal's
-- effect and the resulting balance. Year-end reporting reads these rows rather
-- than rescanning every journal back to the beginning of time.
CREATE TABLE IF NOT EXISTS fiscal_year_balances (
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    account_code VARCHAR(30) NOT NULL,
    account_name VARCHAR(150) NOT NULL,
    account_type VARCHAR(20) NOT NULL,
    pre_close_debit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    pre_close_credit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    pre_close_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    close_debit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    close_credit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    post_close_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    closed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (fiscal_year_id, branch_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_fiscal_year_balances_account
    ON fiscal_year_balances(fiscal_year_id, account_code, branch_id);

CREATE TABLE IF NOT EXISTS gl_subledger_entries (
    id VARCHAR(60) PRIMARY KEY,
    journal_id VARCHAR(50) NOT NULL REFERENCES gl_journals_registry(id) ON DELETE CASCADE,
    journal_line_id VARCHAR(60) NOT NULL REFERENCES gl_journal_line_registry(id) ON DELETE CASCADE,
    account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    -- The book this row belongs to. Declared here for a fresh install; the
    -- ALTER below adopts rows written before the master existed.
    subledger_id VARCHAR(50) REFERENCES gl_subledgers(id) ON DELETE RESTRICT,
    subledger_type VARCHAR(30) NOT NULL CHECK (subledger_type IN (
        'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'INVENTORY', 'FIXED_ASSET', 'BANK', 'CASH', 'TAX', 'INTER_BRANCH'
    )),
    party_id VARCHAR(100),
    party_name VARCHAR(200),
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    entry_date_ad DATE NOT NULL,
    entry_date_bs VARCHAR(20),
    debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gl_subledger_entries_one_sided CHECK (
        debit >= 0 AND credit >= 0 AND
        ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
    )
);

CREATE INDEX IF NOT EXISTS idx_gl_subledger_account_branch ON gl_subledger_entries(account_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_gl_subledger_party ON gl_subledger_entries(subledger_type, party_id);
CREATE INDEX IF NOT EXISTS idx_gl_subledger_journal ON gl_subledger_entries(journal_id);

-- The book each subledger row belongs to. The master names the book; the entry
-- points at it, so a report can read one book directly instead of re-deriving
-- it from the control account and type. The column is nullable only for rows
-- written before the master existed: the backfill below adopts those, and the
-- posting path resolves the book for every new row.
ALTER TABLE gl_subledger_entries
    ADD COLUMN IF NOT EXISTS subledger_id VARCHAR(50) REFERENCES gl_subledgers(id) ON DELETE RESTRICT;
ALTER TABLE gl_subledger_entries ADD COLUMN IF NOT EXISTS entry_date_bs VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_gl_subledger_book ON gl_subledger_entries(subledger_id);

DO $$
BEGIN
  -- Schema maintenance may adopt legacy rows into their general book. This
  -- local flag is the only bypass the append-only trigger accepts; it resets
  -- at the end of this block, so no application session inherits it.
  PERFORM set_config('inventory.allow_ledger_purge', 'on', true);
  UPDATE gl_subledger_entries e
  SET subledger_id = s.id
  FROM gl_subledgers s
  WHERE e.subledger_id IS NULL
    AND s.main_account_id = e.account_id
    AND s.subledger_type = e.subledger_type
    AND s.party_id IS NULL;
  PERFORM set_config('inventory.allow_ledger_purge', 'off', true);
END $$;

-- ============================================================================
-- 34. Daily cash close — one counted close per branch and business day
-- ============================================================================
-- The close is a snapshot of the posted cash/bank lines: opening carries the
-- signed balance before the day, cash-in and cash-out are that day's gross
-- debits and credits, and expected closing is opening + in - out (which is
-- also the cash book's closing and the balance sheet's cash-and-bank total for
-- the same branch and date). The variance is the only entered figure.
-- Reopening keeps the row and its last count for the audit trail; closing it
-- again updates that same row rather than creating a second close.
CREATE TABLE IF NOT EXISTS daily_cash_closes (
    id VARCHAR(50) PRIMARY KEY,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    business_date_ad DATE NOT NULL,
    business_date_bs VARCHAR(20),
    opening_cash NUMERIC(14, 2) NOT NULL DEFAULT 0,
    cash_in NUMERIC(14, 2) NOT NULL DEFAULT 0,
    cash_out NUMERIC(14, 2) NOT NULL DEFAULT 0,
    expected_closing NUMERIC(14, 2) NOT NULL DEFAULT 0,
    counted_closing NUMERIC(14, 2) NOT NULL DEFAULT 0,
    variance NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status VARCHAR(10) NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('CLOSED', 'OPEN')),
    closed_by VARCHAR(150),
    closed_at TIMESTAMP WITH TIME ZONE,
    reopened_by VARCHAR(150),
    reopened_at TIMESTAMP WITH TIME ZONE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT daily_cash_closes_variance_check CHECK (
        variance = counted_closing - expected_closing
    ),
    UNIQUE (branch_id, business_date_ad)
);

CREATE INDEX IF NOT EXISTS idx_daily_cash_closes_date ON daily_cash_closes(business_date_ad, branch_id);
ALTER TABLE daily_cash_closes ADD COLUMN IF NOT EXISTS business_date_bs VARCHAR(20);

-- ============================================================================
-- 34b. Bank reconciliation — imported bank statement lines and the period
-- sessions that lock a bank-account reconciliation. A BANK ledger is the
-- account master (the chart already stores bank name/number/holder); these
-- tables hold statement-side facts for that account. All branches post to the
-- same company bank account and the bank issues one statement, so neither
-- table carries a branch: branch is a posting dimension on journal lines.
-- `amount` is signed from the bank statement perspective: positive = deposit
-- into the bank, negative = withdrawal. The book side remains the posted
-- debit/credit in gl_journal_lines. A statement line can claim at most one
-- posted book line, and fingerprint uniqueness makes re-importing the same
-- statement idempotent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS bank_statement_lines (
    id VARCHAR(60) PRIMARY KEY,
    bank_account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    statement_date DATE NOT NULL,
    statement_date_bs VARCHAR(20) NOT NULL,
    description VARCHAR(300) NOT NULL,
    reference VARCHAR(150),
    amount NUMERIC(14, 2) NOT NULL,
    import_batch_id VARCHAR(60) NOT NULL,
    import_source VARCHAR(10) NOT NULL CHECK (import_source IN ('CSV', 'OFX')),
    fingerprint VARCHAR(64) NOT NULL,
    matched_journal_line_id VARCHAR(60) REFERENCES gl_journal_line_registry(id) ON DELETE RESTRICT,
    matched_at TIMESTAMP WITH TIME ZONE,
    matched_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT bank_statement_lines_amount_check CHECK (amount <> 0),
    UNIQUE (bank_account_id, fingerprint)
);

-- Upgrade the original branch-scoped shape. A statement belongs to the bank
-- account, so retaining branch_id would let the same statement be imported
-- once per branch and split one real bank statement into several sessions.
-- The local install had no statement rows when this correction shipped; an
-- install with rows must review them before applying because the account-level
-- uniqueness and session uniqueness intentionally merge branch duplicates.
DROP INDEX IF EXISTS idx_bank_statement_lines_scope;
ALTER TABLE bank_statement_lines DROP COLUMN IF EXISTS branch_id;

ALTER TABLE bank_statement_lines
    ADD COLUMN IF NOT EXISTS statement_date_bs VARCHAR(20) NOT NULL DEFAULT 'BS not seeded';
ALTER TABLE bank_statement_lines ALTER COLUMN statement_date_bs DROP DEFAULT;
UPDATE bank_statement_lines s SET statement_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE b.ad_date = s.statement_date AND s.statement_date_bs = 'BS not seeded';

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_scope
    ON bank_statement_lines(bank_account_id, statement_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_statement_lines_journal_line
    ON bank_statement_lines(matched_journal_line_id)
    WHERE matched_journal_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_reconciliation_sessions (
    id VARCHAR(60) PRIMARY KEY,
    bank_account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    period_start_bs VARCHAR(20) NOT NULL,
    period_end_bs VARCHAR(20) NOT NULL,
    opening_statement_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
    closing_statement_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'LOCKED')),
    locked_at TIMESTAMP WITH TIME ZONE,
    locked_by VARCHAR(150),
    reopened_at TIMESTAMP WITH TIME ZONE,
    reopened_by VARCHAR(150),
    reopen_reason TEXT,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT bank_reconciliation_sessions_period_check CHECK (period_start <= period_end),
    UNIQUE (bank_account_id, period_start, period_end)
);

-- Existing installs may still have the old branch-aware unique constraint.
-- Drop it before removing the column; the account/period unique constraint is
-- added after the column is gone so re-running this section stays idempotent.
DO $$
DECLARE constraint_name text;
BEGIN
    FOR constraint_name IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'bank_reconciliation_sessions'
          AND con.contype = 'u'
          AND pg_get_constraintdef(con.oid) LIKE '%branch_id%'
    LOOP
        EXECUTE format('ALTER TABLE bank_reconciliation_sessions DROP CONSTRAINT %I', constraint_name);
    END LOOP;
END $$;
DROP INDEX IF EXISTS idx_bank_reconciliation_sessions_scope;
ALTER TABLE bank_reconciliation_sessions DROP COLUMN IF EXISTS branch_id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'bank_reconciliation_sessions_account_period_key'
          AND conrelid = 'bank_reconciliation_sessions'::regclass
    ) THEN
        ALTER TABLE bank_reconciliation_sessions
            ADD CONSTRAINT bank_reconciliation_sessions_account_period_key
            UNIQUE (bank_account_id, period_start, period_end);
    END IF;
END $$;

ALTER TABLE bank_reconciliation_sessions
    ADD COLUMN IF NOT EXISTS period_start_bs VARCHAR(20) NOT NULL DEFAULT 'BS not seeded';
ALTER TABLE bank_reconciliation_sessions
    ADD COLUMN IF NOT EXISTS period_end_bs VARCHAR(20) NOT NULL DEFAULT 'BS not seeded';
ALTER TABLE bank_reconciliation_sessions ALTER COLUMN period_start_bs DROP DEFAULT;
ALTER TABLE bank_reconciliation_sessions ALTER COLUMN period_end_bs DROP DEFAULT;
UPDATE bank_reconciliation_sessions s SET period_start_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE b.ad_date = s.period_start AND s.period_start_bs = 'BS not seeded';
UPDATE bank_reconciliation_sessions s SET period_end_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE b.ad_date = s.period_end AND s.period_end_bs = 'BS not seeded';

CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_sessions_scope
    ON bank_reconciliation_sessions(bank_account_id, period_start, period_end);

-- ============================================================================
-- 34c. Recurring journals — a branch-owned template with formula-driven lines
-- and a durable per-template/per-date run record. The run record is the
-- idempotency key: a second request for the same due date returns the first
-- journal instead of posting again. Generated journals go through the normal
-- balanced-journal service, so closed periods and branch scope behave exactly
-- like a manual voucher.
-- ============================================================================
CREATE TABLE IF NOT EXISTS gl_recurring_templates (
    id VARCHAR(60) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    frequency VARCHAR(10) NOT NULL CHECK (frequency IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
    start_date_ad DATE NOT NULL,
    end_date_ad DATE,
    next_run_date DATE NOT NULL,
    last_run_date DATE,
    last_journal_id VARCHAR(50) REFERENCES gl_journals_registry(id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT gl_recurring_templates_date_order CHECK (
        end_date_ad IS NULL OR end_date_ad >= start_date_ad
    )
);

CREATE INDEX IF NOT EXISTS idx_gl_recurring_templates_due
    ON gl_recurring_templates(active, next_run_date, branch_id);

CREATE TABLE IF NOT EXISTS gl_recurring_template_lines (
    id VARCHAR(60) PRIMARY KEY,
    template_id VARCHAR(60) NOT NULL REFERENCES gl_recurring_templates(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL CHECK (line_no > 0),
    account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    side VARCHAR(6) NOT NULL CHECK (side IN ('DEBIT', 'CREDIT')),
    amount_formula VARCHAR(200) NOT NULL,
    memo VARCHAR(300),
    party_id VARCHAR(100),
    party_name VARCHAR(200),
    cost_center_id VARCHAR(50) REFERENCES cost_centers(id) ON DELETE RESTRICT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (template_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_gl_recurring_template_lines_template
    ON gl_recurring_template_lines(template_id, line_no);

CREATE TABLE IF NOT EXISTS gl_recurring_runs (
    id VARCHAR(60) PRIMARY KEY,
    template_id VARCHAR(60) NOT NULL REFERENCES gl_recurring_templates(id) ON DELETE CASCADE,
    run_date DATE NOT NULL,
    journal_id VARCHAR(50) NOT NULL REFERENCES gl_journals_registry(id) ON DELETE RESTRICT,
    generated_by VARCHAR(150),
    generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (template_id, run_date)
);

CREATE INDEX IF NOT EXISTS idx_gl_recurring_runs_template
    ON gl_recurring_runs(template_id, run_date DESC);

-- ============================================================================
-- 34d. Month-end close checklist — company-wide, ordered tasks per period.
-- The templates are the default checklist every period starts with; each
-- period owns its status/owner/note/evidence rows, so the state survives a
-- refresh and every update can be audited independently. `LOCK_PERIOD` is
-- optional because the close action itself marks it done; the other four are
-- required and gate the close unless an explicit override reason is supplied.
-- ============================================================================
CREATE TABLE IF NOT EXISTS gl_close_task_templates (
    id VARCHAR(60) PRIMARY KEY,
    code VARCHAR(40) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    required BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gl_close_checklist_items (
    id VARCHAR(60) PRIMARY KEY,
    period_id VARCHAR(50) NOT NULL REFERENCES gl_periods(id) ON DELETE CASCADE,
    task_code VARCHAR(40) NOT NULL,
    title VARCHAR(200) NOT NULL,
    required BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'IN_PROGRESS', 'DONE', 'NOT_APPLICABLE')),
    owner VARCHAR(150),
    note TEXT,
    evidence_url VARCHAR(500),
    completed_at TIMESTAMP WITH TIME ZONE,
    completed_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (period_id, task_code)
);

CREATE INDEX IF NOT EXISTS idx_gl_close_checklist_items_period
    ON gl_close_checklist_items(period_id, sort_order, task_code);

-- ============================================================================
-- 34e. Forward cash-flow manual inputs — branch-owned adjustments against a
-- dated forecast. The amount is stored as a safe arithmetic formula (evaluated
-- by the same parser as recurring journals); no amount column can drift from
-- the formula. The BS half is derived from bs_day_records on write, and the
-- forecast excludes a row whose date falls in a CLOSED accounting period.
-- ============================================================================
CREATE TABLE IF NOT EXISTS gl_cash_flow_manual_inputs (
    id VARCHAR(60) PRIMARY KEY,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    expected_date_ad DATE NOT NULL,
    expected_date_bs VARCHAR(20) NOT NULL,
    direction VARCHAR(7) NOT NULL CHECK (direction IN ('INFLOW', 'OUTFLOW')),
    amount_formula VARCHAR(200) NOT NULL,
    description VARCHAR(300) NOT NULL,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gl_cash_flow_manual_inputs_scope
    ON gl_cash_flow_manual_inputs(branch_id, expected_date_ad);

INSERT INTO gl_close_task_templates (id, code, title, description, required, sort_order)
VALUES
    ('glct-bank-reconcile', 'BANK_RECONCILE', 'Reconcile bank statements',
     'Import each bank statement and match it to the company book for the period.', TRUE, 10),
    ('glct-post-depreciation', 'POST_DEPRECIATION', 'Post depreciation',
     'Run the fixed-asset depreciation posting for the period.', TRUE, 20),
    ('glct-review-aging', 'REVIEW_AGING', 'Review AR / AP aging',
     'Review receivables and payables and explain material overdue balances.', TRUE, 30),
    ('glct-accrue-expenses', 'ACCRUE_EXPENSES', 'Accrue expenses',
     'Post known expenses that belong to the period but are not yet invoiced.', TRUE, 40),
    ('glct-lock-period', 'LOCK_PERIOD', 'Lock period',
     'Mark the period locked after the checklist is complete.', FALSE, 50)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- 35. Payroll — employee master, posted runs and their per-employee lines
-- ============================================================================
-- Payroll deliberately stores no salary calculation: the run's amounts are
-- entered or imported. The ledger side is the generic subledger above — every
-- run line writes EMPLOYEE party rows against salary payable, TDS, SSF,
-- advances and loans, so the employee ledger is a read of the same ledger, not
-- a parallel balance table.
CREATE TABLE IF NOT EXISTS employees (
    id VARCHAR(50) PRIMARY KEY,
    employee_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    user_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
    department VARCHAR(120),
    department_id VARCHAR(50),
    designation VARCHAR(120),
    designation_id VARCHAR(50),
    workstation_id VARCHAR(50),
    pan_number VARCHAR(50),
    ssf_number VARCHAR(50),
    bank_account VARCHAR(80),
    bank_name VARCHAR(150),
    employment_type VARCHAR(30),
    joining_date_ad DATE,
    date_of_birth_ad DATE,
    contract_expiry_ad DATE,
    separation_date_ad DATE,
    designation_code VARCHAR(30),
    work_station VARCHAR(150),
    address TEXT,
    personal_contact VARCHAR(30),
    emergency_contact_person VARCHAR(150),
    emergency_contact_number VARCHAR(30),
    internal_email VARCHAR(150),
    personal_email VARCHAR(150),
    father_name VARCHAR(200),
    grandfather_name VARCHAR(200),
    permanent_address TEXT,
    local_address TEXT,
    emergency_contact_address TEXT,
    emergency_contact_relation VARCHAR(80),
    blood_group VARCHAR(10),
    medical_conditions VARCHAR(300),
    medical_details TEXT,
    accident_details TEXT,
    case_details TEXT,
    declaration_date_ad DATE,
    declaration_name VARCHAR(200),
    profile_photo TEXT,
    monthly_salary NUMERIC(12, 2),
    ssf_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_employees_branch ON employees(branch_id, is_active);
CREATE INDEX IF NOT EXISTS idx_employees_name ON employees(lower(name));

-- HR master fields supplied by the business's Employee Master Sheet. Master
-- dates stay AD-only: joining/DOB/contract dates predate the seeded BS span, so
-- requiring a derived BS value would reject valid history.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_name VARCHAR(150);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type VARCHAR(30);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS joining_date_ad DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_birth_ad DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS contract_expiry_ad DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS separation_date_ad DATE;
CREATE INDEX IF NOT EXISTS idx_employees_branch_separation ON employees(branch_id, separation_date_ad);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS designation_code VARCHAR(30);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_station VARCHAR(150);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_contact VARCHAR(30);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact_person VARCHAR(150);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact_number VARCHAR(30);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS internal_email VARCHAR(150);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_email VARCHAR(150);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS monthly_salary NUMERIC(12, 2);
-- Self-service profile photo: a client-resized square JPEG data URL (<= 150 KB),
-- written only by the employee's own PUT and never by the HR master forms.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS profile_photo TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS ssf_eligible BOOLEAN NOT NULL DEFAULT FALSE;
-- F1 Employee Profile scalar answers (the repeating blocks are the four
-- hr_employee_* tables below). Master dates stay AD-only, like the other
-- employee dates; the declaration date is the form's own signature date.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS father_name VARCHAR(200);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS grandfather_name VARCHAR(200);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS permanent_address TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS local_address TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact_address TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact_relation VARCHAR(80);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS blood_group VARCHAR(10);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS medical_conditions VARCHAR(300);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS medical_details TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS accident_details TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS case_details TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS declaration_date_ad DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS declaration_name VARCHAR(200);
-- ESS link: one login account maps to at most one employee. The partial unique
-- index is what makes the link one-to-one; ON DELETE SET NULL keeps the
-- employee record (and payroll history) when a login is removed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_id VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_user_id ON employees(user_id) WHERE user_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_user_id_fkey'
      AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees ADD CONSTRAINT employees_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM employees WHERE monthly_salary < 0) THEN
    ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_monthly_salary_non_negative;
    ALTER TABLE employees ADD CONSTRAINT employees_monthly_salary_non_negative
      CHECK (monthly_salary IS NULL OR monthly_salary >= 0);
  END IF;
END $$;

-- Employee branch-transfer history. Each move is kept as an immutable event so
-- HR can see where a person worked without reading the audit log. Branch names
-- are snapshotted: renaming a branch later must not rewrite history. The branch
-- ids deliberately have no foreign key for the same reason; only the employee
-- cascade removes a row.
CREATE TABLE IF NOT EXISTS hr_employee_branch_transfers (
    id VARCHAR(60) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    from_branch_id VARCHAR(50) NOT NULL,
    from_branch_name VARCHAR(150) NOT NULL,
    to_branch_id VARCHAR(50) NOT NULL,
    to_branch_name VARCHAR(150) NOT NULL,
    transferred_by VARCHAR(150),
    effective_date_ad DATE,
    effective_date_bs VARCHAR(20),
    reason VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'APPROVED',
    approved_by VARCHAR(150),
    approved_at TIMESTAMP WITH TIME ZONE,
    decision_note VARCHAR(500),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE hr_employee_branch_transfers
  ADD COLUMN IF NOT EXISTS effective_date_ad DATE;
ALTER TABLE hr_employee_branch_transfers
  ADD COLUMN IF NOT EXISTS effective_date_bs VARCHAR(20);
ALTER TABLE hr_employee_branch_transfers
  ADD COLUMN IF NOT EXISTS reason VARCHAR(500);
-- Existing rows predate approval and already represent completed moves.
ALTER TABLE hr_employee_branch_transfers
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'APPROVED';
ALTER TABLE hr_employee_branch_transfers
  ADD COLUMN IF NOT EXISTS approved_by VARCHAR(150);
ALTER TABLE hr_employee_branch_transfers
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE hr_employee_branch_transfers
  ADD COLUMN IF NOT EXISTS decision_note VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hr_employee_branch_transfers_status_check'
  ) THEN
    ALTER TABLE hr_employee_branch_transfers
      ADD CONSTRAINT hr_employee_branch_transfers_status_check
      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_hr_employee_branch_transfers_employee
  ON hr_employee_branch_transfers(employee_id, created_at DESC);

-- The organisation catalogue is deliberately label-only: employees keep
-- their text department/designation/work-station values, so renaming or
-- retiring a master never rewrites a historical payroll row.
CREATE TABLE IF NOT EXISTS hr_org_masters (
    id VARCHAR(50) PRIMARY KEY,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('DEPARTMENT', 'DESIGNATION', 'WORK_STATION')),
    name VARCHAR(120) NOT NULL,
    code VARCHAR(30),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hr_org_masters_kind ON hr_org_masters(kind, is_active, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_org_masters_kind_name ON hr_org_masters(kind, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_org_masters_kind_code ON hr_org_masters(kind, lower(code)) WHERE code IS NOT NULL;

-- Employees keep the catalogue text they were saved with (payroll history and
-- printed documents read it), and now also point at the catalogue row itself,
-- so renaming a department/designation/work station keeps its employees
-- attached. `ON DELETE SET NULL`: deleting a master leaves the historical text
-- intact and only drops the link.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id VARCHAR(50)
  REFERENCES hr_org_masters(id) ON DELETE SET NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS designation_id VARCHAR(50)
  REFERENCES hr_org_masters(id) ON DELETE SET NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS workstation_id VARCHAR(50)
  REFERENCES hr_org_masters(id) ON DELETE SET NULL;

-- A fresh install declares the three master links in the CREATE TABLE block
-- above, so the ADD COLUMN statements are no-ops and would not attach their
-- foreign keys. Attach the same constraints explicitly; existing databases
-- already carry them and skip this block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_department_id_fkey'
      AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees ADD CONSTRAINT employees_department_id_fkey
      FOREIGN KEY (department_id) REFERENCES hr_org_masters(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_designation_id_fkey'
      AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees ADD CONSTRAINT employees_designation_id_fkey
      FOREIGN KEY (designation_id) REFERENCES hr_org_masters(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_workstation_id_fkey'
      AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees ADD CONSTRAINT employees_workstation_id_fkey
      FOREIGN KEY (workstation_id) REFERENCES hr_org_masters(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employees_department_master
  ON employees(department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_designation_master
  ON employees(designation_id) WHERE designation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_workstation_master
  ON employees(workstation_id) WHERE workstation_id IS NOT NULL;

-- Backfill existing rows from the text they already store. Only gaps are
-- filled, so re-applying the schema never undoes a newer link (or a rename).
UPDATE employees e
SET department_id = (
  SELECT m.id FROM hr_org_masters m
  WHERE m.kind = 'DEPARTMENT'
    AND lower(btrim(m.name)) = lower(btrim(e.department))
  ORDER BY m.id
  LIMIT 1
)
WHERE e.department_id IS NULL AND e.department IS NOT NULL;

UPDATE employees e
SET designation_id = (
  SELECT m.id FROM hr_org_masters m
  WHERE m.kind = 'DESIGNATION'
    AND (
      lower(btrim(m.name)) = lower(btrim(e.designation))
      OR (
        m.code IS NOT NULL AND e.designation_code IS NOT NULL
        AND lower(btrim(m.code)) = lower(btrim(e.designation_code))
      )
    )
  ORDER BY (lower(btrim(m.name)) = lower(btrim(e.designation))) DESC, m.id
  LIMIT 1
)
WHERE e.designation_id IS NULL AND (e.designation IS NOT NULL OR e.designation_code IS NOT NULL);

UPDATE employees e
SET workstation_id = (
  SELECT m.id FROM hr_org_masters m
  WHERE m.kind = 'WORK_STATION'
    AND lower(btrim(m.name)) = lower(btrim(e.work_station))
  ORDER BY m.id
  LIMIT 1
)
WHERE e.workstation_id IS NULL AND e.work_station IS NOT NULL;

-- The refactored HR organisation model (Corporate Designations, Salary Slabs &
-- Job Descriptions v2). hr_org_masters stays the single catalogue identity;
-- these tables describe it without widening every row with empty columns:
--   * hr_salary_grades     - the G1-G10 band and its three appraisal steps;
--   * hr_designation_profiles - grade, solid/dotted reporting line, scope, JD;
--   * hr_department_profiles  - department head post and mandate;
--   * hr_org_clusters / hr_branch_plan - the 4 regional clusters and the 24
--     branch operating plan. The branch plan is reference data and does NOT
--     create operational branches; `branch_id` maps a plan row to a live
--     branch when one exists.
-- Reporting lines point at designations, never at employees, so a post with no
-- holder remains on the org chart as a vacancy instead of disappearing.
CREATE TABLE IF NOT EXISTS hr_salary_grades (
    grade VARCHAR(5) PRIMARY KEY,
    career_band VARCHAR(40) NOT NULL,
    role_tier TEXT NOT NULL,
    min_salary INTEGER NOT NULL CHECK (min_salary >= 0),
    step1_salary INTEGER NOT NULL,
    step2_salary INTEGER NOT NULL,
    step3_salary INTEGER NOT NULL,
    max_salary INTEGER NOT NULL CHECK (max_salary >= min_salary),
    band_spread NUMERIC(8, 4),
    promotion_rule TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (min_salary <= step1_salary AND step1_salary <= step2_salary
      AND step2_salary <= step3_salary AND step3_salary <= max_salary)
);

CREATE TABLE IF NOT EXISTS hr_designation_profiles (
    master_id VARCHAR(50) PRIMARY KEY REFERENCES hr_org_masters(id) ON DELETE CASCADE,
    department_master_id VARCHAR(50) REFERENCES hr_org_masters(id) ON DELETE SET NULL,
    grade VARCHAR(5) REFERENCES hr_salary_grades(grade) ON DELETE SET NULL,
    reports_to_master_id VARCHAR(50) REFERENCES hr_org_masters(id) ON DELETE SET NULL,
    -- Used when the line leaves the company (Board, Audit Committee) or is dotted.
    reports_to_label VARCHAR(120),
    dotted_line_to VARCHAR(120),
    branch_scope VARCHAR(80),
    system_role VARCHAR(40),
    responsibilities TEXT,
    phase VARCHAR(20),
    role_status VARCHAR(30),
    change_note VARCHAR(400),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE hr_designation_profiles
  ADD COLUMN IF NOT EXISTS department_master_id VARCHAR(50)
  REFERENCES hr_org_masters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hr_designation_profiles_reports_to
  ON hr_designation_profiles(reports_to_master_id) WHERE reports_to_master_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hr_designation_profiles_grade
  ON hr_designation_profiles(grade) WHERE grade IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_department_profiles (
    master_id VARCHAR(50) PRIMARY KEY REFERENCES hr_org_masters(id) ON DELETE CASCADE,
    head_designation_master_id VARCHAR(50) REFERENCES hr_org_masters(id) ON DELETE SET NULL,
    mandate TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_org_clusters (
    id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE,
    hub VARCHAR(80) NOT NULL,
    province VARCHAR(40),
    notes TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_branch_plan (
    code VARCHAR(10) PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE,
    cluster_id VARCHAR(20) NOT NULL REFERENCES hr_org_clusters(id) ON DELETE RESTRICT,
    cluster_hub VARCHAR(80) NOT NULL,
    province VARCHAR(40),
    tier VARCHAR(40) NOT NULL,
    head_designation VARCHAR(80) NOT NULL,
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
    notes TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hr_branch_plan_cluster ON hr_branch_plan(cluster_id, code);

-- Employee document vault. The bytes live in this same database so a document
-- and its metadata commit or roll back together; the size ceiling is enforced
-- here as well as in the upload handler. `storage_key` is a generated id, never
-- derived from the employee or the uploaded name, so it carries no PII.
CREATE TABLE IF NOT EXISTS hr_employee_documents (
    id VARCHAR(60) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    doc_type VARCHAR(40) NOT NULL,
    original_name VARCHAR(200) NOT NULL,
    mime_type VARCHAR(120) NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
    storage_key VARCHAR(80) NOT NULL UNIQUE,
    expires_on_ad DATE,
    notes VARCHAR(500),
    content BYTEA NOT NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    uploaded_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hr_employee_documents_employee
  ON hr_employee_documents(employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_employee_documents_expiry
  ON hr_employee_documents(expires_on_ad) WHERE expires_on_ad IS NOT NULL;

-- F1 Employee Profile repeating blocks. The scalar answers (father/grandfather,
-- permanent/local address, emergency address/relation, blood group, medical,
-- accident/case, declaration) live on employees; these four tables hold the
-- form's repeating sections. Rows cascade with their employee and are scoped
-- through employee_id, so branch custody stays on the employee row and is not
-- duplicated here. sort_order preserves the order the form was filled in; the
-- server assigns it, so two rows can never claim the same position.
CREATE TABLE IF NOT EXISTS hr_employee_family_members (
    id VARCHAR(60) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 1,
    name VARCHAR(200) NOT NULL,
    age INTEGER CHECK (age IS NULL OR (age >= 0 AND age <= 150)),
    occupation VARCHAR(150),
    relation VARCHAR(80),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hr_employee_family_employee
  ON hr_employee_family_members(employee_id, sort_order);

CREATE TABLE IF NOT EXISTS hr_employee_experience (
    id VARCHAR(60) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 1,
    organization VARCHAR(200) NOT NULL,
    from_ad DATE,
    to_ad DATE,
    designation VARCHAR(150),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (from_ad IS NULL OR to_ad IS NULL OR to_ad >= from_ad)
);
CREATE INDEX IF NOT EXISTS idx_hr_employee_experience_employee
  ON hr_employee_experience(employee_id, sort_order);

CREATE TABLE IF NOT EXISTS hr_employee_qualifications (
    id VARCHAR(60) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 1,
    exam_passed VARCHAR(200) NOT NULL,
    board_university VARCHAR(200),
    percentage NUMERIC(5, 2) CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hr_employee_qualifications_employee
  ON hr_employee_qualifications(employee_id, sort_order);

CREATE TABLE IF NOT EXISTS hr_employee_references (
    id VARCHAR(60) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 1,
    name VARCHAR(200) NOT NULL,
    organization VARCHAR(200),
    contact VARCHAR(120),
    relation VARCHAR(80),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hr_employee_references_employee
  ON hr_employee_references(employee_id, sort_order);

-- Phase 4 recruitment. A requisition is branch custody; candidates inherit
-- that branch from their requisition and interviews/offers inherit it from the
-- candidate, so a stale branch claim cannot drift onto a child row. Dates are
-- transactional and therefore keep the AD/BS pair. Resume bytes live with the
-- candidate row (bounded in the schema as well as the upload handler); the
-- columns are all-or-none so a half-uploaded resume cannot look complete.
CREATE TABLE IF NOT EXISTS hr_recruitment_requisitions (
    id VARCHAR(60) PRIMARY KEY,
    requisition_no VARCHAR(50) UNIQUE NOT NULL,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    title VARCHAR(150) NOT NULL,
    department VARCHAR(120),
    designation VARCHAR(120),
    employment_type VARCHAR(30),
    openings INTEGER NOT NULL DEFAULT 1 CHECK (openings >= 1 AND openings <= 999),
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
      CHECK (status IN ('DRAFT', 'OPEN', 'ON_HOLD', 'CLOSED')),
    opened_on_ad DATE,
    opened_on_bs VARCHAR(20),
    closes_on_ad DATE,
    closes_on_bs VARCHAR(20),
    description VARCHAR(2000),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (closes_on_ad IS NULL OR opened_on_ad IS NULL OR closes_on_ad >= opened_on_ad)
);
CREATE INDEX IF NOT EXISTS idx_hr_recruitment_requisitions_branch_status
  ON hr_recruitment_requisitions(branch_id, status, opened_on_ad DESC);
CREATE INDEX IF NOT EXISTS idx_hr_recruitment_requisitions_opened
  ON hr_recruitment_requisitions(opened_on_ad DESC) WHERE opened_on_ad IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_recruitment_candidates (
    id VARCHAR(60) PRIMARY KEY,
    candidate_no VARCHAR(50) UNIQUE NOT NULL,
    requisition_id VARCHAR(60) NOT NULL REFERENCES hr_recruitment_requisitions(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(150),
    phone VARCHAR(30),
    source VARCHAR(80),
    current_employer VARCHAR(150),
    status VARCHAR(20) NOT NULL DEFAULT 'NEW'
      CHECK (status IN ('NEW', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN')),
    notes VARCHAR(1000),
    resume_file_name VARCHAR(200),
    resume_mime_type VARCHAR(120),
    resume_byte_size INTEGER CHECK (resume_byte_size > 0 AND resume_byte_size <= 5242880),
    resume_content BYTEA,
    resume_uploaded_at TIMESTAMP WITH TIME ZONE,
    hired_employee_id VARCHAR(50) UNIQUE REFERENCES employees(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (resume_file_name IS NULL AND resume_mime_type IS NULL AND resume_byte_size IS NULL AND resume_content IS NULL AND resume_uploaded_at IS NULL)
      OR
      (resume_file_name IS NOT NULL AND resume_mime_type IS NOT NULL AND resume_byte_size IS NOT NULL AND resume_content IS NOT NULL AND resume_uploaded_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_hr_recruitment_candidates_branch_status
  ON hr_recruitment_candidates(branch_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_recruitment_candidates_requisition
  ON hr_recruitment_candidates(requisition_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_recruitment_candidates_requisition_email
  ON hr_recruitment_candidates(requisition_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_recruitment_interviews (
    id VARCHAR(60) PRIMARY KEY,
    candidate_id VARCHAR(60) NOT NULL REFERENCES hr_recruitment_candidates(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    round_name VARCHAR(60) NOT NULL,
    scheduled_on_ad DATE NOT NULL,
    scheduled_on_bs VARCHAR(20),
    interviewer VARCHAR(150),
    mode VARCHAR(20) NOT NULL DEFAULT 'VIDEO' CHECK (mode IN ('IN_PERSON', 'PHONE', 'VIDEO')),
    status VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED'
      CHECK (status IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')),
    rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
    notes VARCHAR(1000),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hr_recruitment_interviews_candidate
  ON hr_recruitment_interviews(candidate_id, scheduled_on_ad DESC);
CREATE INDEX IF NOT EXISTS idx_hr_recruitment_interviews_branch_date
  ON hr_recruitment_interviews(branch_id, scheduled_on_ad DESC);

CREATE TABLE IF NOT EXISTS hr_recruitment_offers (
    id VARCHAR(60) PRIMARY KEY,
    offer_no VARCHAR(50) UNIQUE NOT NULL,
    candidate_id VARCHAR(60) UNIQUE NOT NULL REFERENCES hr_recruitment_candidates(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    position_title VARCHAR(150) NOT NULL,
    monthly_salary NUMERIC(12, 2) NOT NULL DEFAULT 0
      CHECK (monthly_salary >= 0 AND monthly_salary <= 100000000),
    start_date_ad DATE NOT NULL,
    start_date_bs VARCHAR(20),
    offered_on_ad DATE NOT NULL,
    offered_on_bs VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
      CHECK (status IN ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN')),
    responded_on_ad DATE,
    notes VARCHAR(1000),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hr_recruitment_offers_branch_status
  ON hr_recruitment_offers(branch_id, status, offered_on_ad DESC);

-- Phase 4 performance. A review cycle is branch custody: goals and 360
-- feedback inherit their branch from the cycle and never take a branch claim
-- from the browser. Sign-off is the lock boundary; the controller refuses
-- every cycle, goal and feedback write once signed_off_at is set.
CREATE TABLE IF NOT EXISTS hr_review_cycles (
    id VARCHAR(60) PRIMARY KEY,
    cycle_no VARCHAR(50) UNIQUE NOT NULL,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    period_start_ad DATE NOT NULL,
    period_start_bs VARCHAR(20),
    period_end_ad DATE NOT NULL,
    period_end_bs VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
      CHECK (status IN ('DRAFT', 'OPEN', 'SIGNED_OFF')),
    instructions VARCHAR(2000),
    signed_off_by VARCHAR(150),
    signed_off_at TIMESTAMP WITH TIME ZONE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (period_end_ad >= period_start_ad)
);
CREATE INDEX IF NOT EXISTS idx_hr_review_cycles_branch_status
  ON hr_review_cycles(branch_id, status, period_start_ad DESC);

CREATE TABLE IF NOT EXISTS hr_goals (
    id VARCHAR(60) PRIMARY KEY,
    goal_no VARCHAR(50) UNIQUE NOT NULL,
    cycle_id VARCHAR(60) NOT NULL REFERENCES hr_review_cycles(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description VARCHAR(1000),
    weight NUMERIC(5, 2) NOT NULL DEFAULT 100
      CHECK (weight > 0 AND weight <= 100),
    target_value VARCHAR(200),
    achievement VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED'
      CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    self_rating NUMERIC(3, 2) CHECK (self_rating IS NULL OR (self_rating >= 1 AND self_rating <= 5)),
    manager_rating NUMERIC(3, 2) CHECK (manager_rating IS NULL OR (manager_rating >= 1 AND manager_rating <= 5)),
    final_rating NUMERIC(3, 2) CHECK (final_rating IS NULL OR (final_rating >= 1 AND final_rating <= 5)),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hr_goals_branch_employee
  ON hr_goals(branch_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_goals_cycle
  ON hr_goals(cycle_id, employee_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_goals_cycle_employee_title
  ON hr_goals(cycle_id, employee_id, lower(title));

CREATE TABLE IF NOT EXISTS hr_review_feedback (
    id VARCHAR(60) PRIMARY KEY,
    cycle_id VARCHAR(60) NOT NULL REFERENCES hr_review_cycles(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    reviewer_employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    relationship VARCHAR(20) NOT NULL
      CHECK (relationship IN ('SELF', 'MANAGER', 'PEER', 'REPORT')),
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    strengths VARCHAR(1000),
    improvements VARCHAR(1000),
    comments VARCHAR(2000),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_by VARCHAR(150),
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (cycle_id, employee_id, reviewer_employee_id),
    CHECK ((relationship = 'SELF' AND employee_id = reviewer_employee_id) OR (relationship <> 'SELF' AND employee_id <> reviewer_employee_id))
);
CREATE INDEX IF NOT EXISTS idx_hr_review_feedback_branch_employee
  ON hr_review_feedback(branch_id, employee_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_review_feedback_cycle
  ON hr_review_feedback(cycle_id, employee_id, submitted_at DESC);

-- Phase 4 onboarding/offboarding. The checklist is branch custody derived
-- from the employee; items never carry a branch claim of their own. Asset and
-- account items point at the real fixed-asset and user records and completing
-- them reconciles that record inside the same transaction. The header is the
-- lock boundary: completed checklists refuse every later write.
CREATE TABLE IF NOT EXISTS hr_lifecycle_checklists (
    id VARCHAR(60) PRIMARY KEY,
    checklist_no VARCHAR(50) UNIQUE NOT NULL,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    checklist_type VARCHAR(20) NOT NULL
      CHECK (checklist_type IN ('ONBOARDING', 'OFFBOARDING')),
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
      CHECK (status IN ('DRAFT', 'OPEN', 'COMPLETED')),
    effective_date_ad DATE NOT NULL,
    effective_date_bs VARCHAR(20),
    notes VARCHAR(2000),
    completed_by VARCHAR(150),
    completed_at TIMESTAMP WITH TIME ZONE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hr_lifecycle_checklists_branch_status
  ON hr_lifecycle_checklists(branch_id, checklist_type, status, effective_date_ad DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_lifecycle_checklists_active_employee
  ON hr_lifecycle_checklists(employee_id, checklist_type)
  WHERE status <> 'COMPLETED';

CREATE TABLE IF NOT EXISTS hr_lifecycle_checklist_items (
    id VARCHAR(60) PRIMARY KEY,
    checklist_id VARCHAR(60) NOT NULL REFERENCES hr_lifecycle_checklists(id) ON DELETE CASCADE,
    category VARCHAR(20) NOT NULL
      CHECK (category IN ('DOCUMENT', 'ASSET', 'ACCOUNT', 'ACCESS', 'OTHER')),
    title VARCHAR(200) NOT NULL,
    description VARCHAR(1000),
    required BOOLEAN NOT NULL DEFAULT TRUE,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
      CHECK (status IN ('PENDING', 'DONE')),
    action VARCHAR(30) NOT NULL DEFAULT 'NONE'
      CHECK (action IN ('NONE', 'ISSUE_ASSET', 'RETURN_ASSET', 'ACTIVATE_ACCOUNT', 'DEACTIVATE_ACCOUNT')),
    asset_id VARCHAR(60) REFERENCES fixed_assets(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    completed_by VARCHAR(150),
    completed_at TIMESTAMP WITH TIME ZONE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK ((category = 'ASSET' AND action IN ('ISSUE_ASSET', 'RETURN_ASSET') AND asset_id IS NOT NULL) OR (category = 'ACCOUNT' AND action IN ('ACTIVATE_ACCOUNT', 'DEACTIVATE_ACCOUNT') AND asset_id IS NULL) OR (category NOT IN ('ASSET', 'ACCOUNT') AND action = 'NONE' AND asset_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_hr_lifecycle_items_checklist
  ON hr_lifecycle_checklist_items(checklist_id, sort_order, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_lifecycle_items_asset
  ON hr_lifecycle_checklist_items(checklist_id, asset_id)
  WHERE asset_id IS NOT NULL;
-- One account reconciliation per checklist. Multiple assets are allowed:
-- each asset is already unique per checklist through ux_hr_lifecycle_items_asset,
-- and an offboarding checklist generates one RETURN_ASSET item per assigned asset.
DROP INDEX IF EXISTS ux_hr_lifecycle_items_action;
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_lifecycle_items_action
  ON hr_lifecycle_checklist_items(checklist_id, action)
  WHERE action IN ('ACTIVATE_ACCOUNT', 'DEACTIVATE_ACCOUNT');

-- Attendance foundation. Shifts and leave types are company-wide catalogues;
-- holidays and attendance rows are branch custody. An attendance row is keyed
-- by employee + date, so a CSV re-import updates the same day instead of
-- creating duplicate punches. The AD date is authoritative; its BS display is
-- stored beside it for the register and payroll extract.
CREATE TABLE IF NOT EXISTS hr_shifts (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) NOT NULL,
    name VARCHAR(120) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    grace_minutes INTEGER NOT NULL DEFAULT 0 CHECK (grace_minutes >= 0 AND grace_minutes <= 240),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_shifts_code ON hr_shifts(lower(code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_shifts_name ON hr_shifts(lower(name));

CREATE TABLE IF NOT EXISTS hr_leave_types (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) NOT NULL,
    name VARCHAR(120) NOT NULL,
    annual_quota_days NUMERIC(5, 1) NOT NULL DEFAULT 0 CHECK (annual_quota_days >= 0 AND annual_quota_days <= 366),
    is_paid BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_leave_types_code ON hr_leave_types(lower(code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_leave_types_name ON hr_leave_types(lower(name));

CREATE TABLE IF NOT EXISTS hr_holidays (
    id VARCHAR(50) PRIMARY KEY,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    holiday_date_ad DATE NOT NULL,
    holiday_date_bs VARCHAR(20),
    name VARCHAR(120) NOT NULL,
    is_paid BOOLEAN NOT NULL DEFAULT TRUE,
    notes VARCHAR(500),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (branch_id, holiday_date_ad)
);
CREATE INDEX IF NOT EXISTS idx_hr_holidays_branch_date
  ON hr_holidays(branch_id, holiday_date_ad DESC);

CREATE TABLE IF NOT EXISTS hr_attendance (
    id VARCHAR(50) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    attendance_date_ad DATE NOT NULL,
    attendance_date_bs VARCHAR(20),
    shift_id VARCHAR(50) REFERENCES hr_shifts(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY', 'HOLIDAY', 'WEEKEND')),
    check_in_time TIME,
    check_out_time TIME,
    overtime_hours NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0 AND overtime_hours <= 24),
    notes VARCHAR(500),
    source VARCHAR(10) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'IMPORT')),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    recorded_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (employee_id, attendance_date_ad)
);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_branch_date
  ON hr_attendance(branch_id, attendance_date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_employee_date
  ON hr_attendance(employee_id, attendance_date_ad DESC);

-- Leave ledger. A balance row is one employee + leave type + calendar year.
-- Usage is DERIVED from APPROVED requests, so rejecting or cancelling a request
-- returns the days without a second write that could drift out of step.
-- Entitlement and adjustment are the only stored numbers.
CREATE TABLE IF NOT EXISTS hr_leave_balances (
    id VARCHAR(50) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    leave_type_id VARCHAR(50) NOT NULL REFERENCES hr_leave_types(id) ON DELETE RESTRICT,
    balance_year INTEGER NOT NULL CHECK (balance_year BETWEEN 2000 AND 2100),
    entitlement_days NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (entitlement_days >= 0 AND entitlement_days <= 366),
    adjustment_days NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (adjustment_days >= -366 AND adjustment_days <= 366),
    notes VARCHAR(500),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (employee_id, leave_type_id, balance_year)
);
CREATE INDEX IF NOT EXISTS idx_hr_leave_balances_branch_year
  ON hr_leave_balances(branch_id, balance_year DESC);
CREATE INDEX IF NOT EXISTS idx_hr_leave_balances_employee_year
  ON hr_leave_balances(employee_id, balance_year DESC);

CREATE TABLE IF NOT EXISTS hr_leave_requests (
    id VARCHAR(50) PRIMARY KEY,
    request_no VARCHAR(50) UNIQUE NOT NULL,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    leave_type_id VARCHAR(50) NOT NULL REFERENCES hr_leave_types(id) ON DELETE RESTRICT,
    start_date_ad DATE NOT NULL,
    end_date_ad DATE NOT NULL,
    start_date_bs VARCHAR(20),
    end_date_bs VARCHAR(20),
    days_count NUMERIC(6, 2) NOT NULL CHECK (days_count > 0 AND days_count <= 366),
    reason VARCHAR(500),
    status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    decided_by VARCHAR(150),
    decided_at TIMESTAMP WITH TIME ZONE,
    decision_note VARCHAR(500),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (end_date_ad >= start_date_ad)
);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_branch_status
  ON hr_leave_requests(branch_id, status, start_date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_employee_dates
  ON hr_leave_requests(employee_id, start_date_ad DESC, end_date_ad DESC);

-- Phase 2 payroll structure. A structure is effective-dated: a newer row
-- supersedes an older one from its effective_from, while history is retained so
-- payroll for an earlier period can resolve the structure in force then. The
-- monthly amounts live in hr_salary_components (BASIC/HRA by default); the
-- header carries the run inputs that are not a monthly amount.
CREATE TABLE IF NOT EXISTS hr_employee_salary (
    id VARCHAR(50) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    effective_from DATE NOT NULL,
    ssf_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    overtime_rate NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (overtime_rate >= 0 AND overtime_rate <= 100000),
    tds_monthly NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tds_monthly >= 0 AND tds_monthly <= 10000000),
    notes VARCHAR(500),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (employee_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_hr_employee_salary_branch_effective
  ON hr_employee_salary(branch_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_hr_employee_salary_employee_effective
  ON hr_employee_salary(employee_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS hr_salary_components (
    id VARCHAR(60) PRIMARY KEY,
    salary_id VARCHAR(50) NOT NULL REFERENCES hr_employee_salary(id) ON DELETE CASCADE,
    component_code VARCHAR(30) NOT NULL,
    component_name VARCHAR(120) NOT NULL,
    kind VARCHAR(24) NOT NULL DEFAULT 'EARNING' CHECK (kind IN ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION')),
    amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0 AND amount <= 100000000),
    is_taxable BOOLEAN NOT NULL DEFAULT TRUE,
    is_ssf_applicable BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (salary_id, component_code)
);
CREATE INDEX IF NOT EXISTS idx_hr_salary_components_salary
  ON hr_salary_components(salary_id, sort_order);

-- Phase 2 statutory deductions. A configuration is versioned by fiscal year:
-- one row per fiscal year holds the SSF rates, and its child slabs hold the
-- progressive monthly TDS bands. Payroll resolves the fiscal year from the
-- as-of date, so a new Finance Act is a new year's configuration rather than
-- an edit that rewrites history.
CREATE TABLE IF NOT EXISTS hr_statutory_configs (
    id VARCHAR(50) PRIMARY KEY,
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
    employee_ssf_percent NUMERIC(5, 2) NOT NULL DEFAULT 11 CHECK (employee_ssf_percent >= 0 AND employee_ssf_percent <= 100),
    employer_ssf_percent NUMERIC(5, 2) NOT NULL DEFAULT 20 CHECK (employer_ssf_percent >= 0 AND employer_ssf_percent <= 100),
    notes VARCHAR(500),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (fiscal_year_id)
);
CREATE INDEX IF NOT EXISTS idx_hr_statutory_configs_year
  ON hr_statutory_configs(fiscal_year_id);

CREATE TABLE IF NOT EXISTS hr_tds_slabs (
    id VARCHAR(60) PRIMARY KEY,
    config_id VARCHAR(50) NOT NULL REFERENCES hr_statutory_configs(id) ON DELETE CASCADE,
    slab_order INTEGER NOT NULL CHECK (slab_order >= 1 AND slab_order <= 20),
    lower_bound NUMERIC(14, 2) NOT NULL CHECK (lower_bound >= 0),
    upper_bound NUMERIC(14, 2) CHECK (upper_bound IS NULL OR upper_bound > lower_bound),
    rate_percent NUMERIC(5, 2) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (config_id, slab_order),
    UNIQUE (config_id, lower_bound)
);
CREATE INDEX IF NOT EXISTS idx_hr_tds_slabs_config
  ON hr_tds_slabs(config_id, slab_order);

-- Real Nepal resident-natural-person values for FY 2083/84, expressed as the
-- monthly bands the payroll run applies: 1% to 83,333.33; 10% to 125,000;
-- 20% to 208,333.33; 27% to 333,333.33; 29% above. SSF is 11% employee / 20%
-- employer. The insert is idempotent and never overwrites an operator's edit.
INSERT INTO hr_statutory_configs (
  id, fiscal_year_id, employee_ssf_percent, employer_ssf_percent, notes, is_demo
)
SELECT 'hr-stat-2083-84', f.id, 11, 20,
       'Nepal FY 2083/84 resident natural person; monthly bands; SSF 11% / 20%.', FALSE
FROM fiscal_years f
WHERE f.code = '2083-84'
ON CONFLICT (fiscal_year_id) DO NOTHING;

INSERT INTO hr_tds_slabs (id, config_id, slab_order, lower_bound, upper_bound, rate_percent)
SELECT v.id, c.id, v.slab_order, v.lower_bound, v.upper_bound, v.rate_percent
FROM (VALUES
  ('hr-tds-2083-84-1', 1, 0.00::numeric, 83333.33::numeric, 1.00::numeric),
  ('hr-tds-2083-84-2', 2, 83333.33::numeric, 125000.00::numeric, 10.00::numeric),
  ('hr-tds-2083-84-3', 3, 125000.00::numeric, 208333.33::numeric, 20.00::numeric),
  ('hr-tds-2083-84-4', 4, 208333.33::numeric, 333333.33::numeric, 27.00::numeric),
  ('hr-tds-2083-84-5', 5, 333333.33::numeric, NULL::numeric, 29.00::numeric)
) AS v(id, slab_order, lower_bound, upper_bound, rate_percent)
JOIN fiscal_years f ON f.code = '2083-84'
JOIN hr_statutory_configs c ON c.fiscal_year_id = f.id
WHERE NOT EXISTS (SELECT 1 FROM hr_tds_slabs s WHERE s.config_id = c.id)
ON CONFLICT (config_id, slab_order) DO NOTHING;

-- Period-scoped payroll inputs that are not part of an effective-dated salary
-- structure: one-off incentives, arrears paid this month, and recoveries. The
-- generated draft copies these into the run line; editing this table later
-- must not rewrite an existing run. Branch ownership is derived from the
-- employee, so a transfer cannot leave a second, stale branch claim here.
CREATE TABLE IF NOT EXISTS hr_payroll_adjustments (
    id VARCHAR(60) PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    period_key VARCHAR(7) NOT NULL,
    incentive_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (incentive_amount >= 0 AND incentive_amount <= 100000000),
    arrears_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (arrears_amount >= 0 AND arrears_amount <= 100000000),
    advance_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (advance_amount >= 0 AND advance_amount <= 100000000),
    loan_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (loan_amount >= 0 AND loan_amount <= 100000000),
    notes VARCHAR(500),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT hr_payroll_adjustments_period_shape CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    UNIQUE (employee_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_adjustments_period
  ON hr_payroll_adjustments(period_key, employee_id);

CREATE TABLE IF NOT EXISTS payroll_runs (
    id VARCHAR(50) PRIMARY KEY,
    run_no VARCHAR(50) UNIQUE NOT NULL,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    period_key VARCHAR(7) NOT NULL,
    run_date_ad DATE NOT NULL,
    run_date_bs VARCHAR(20),
    gross_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tds_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    ssf_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    advance_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    loan_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    incentive_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    arrears_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    net_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status VARCHAR(10) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED', 'PAID')),
    journal_id VARCHAR(50) REFERENCES gl_journals_registry(id) ON DELETE SET NULL,
    paid_journal_id VARCHAR(50) REFERENCES gl_journals_registry(id) ON DELETE SET NULL,
    paid_date_ad DATE,
    paid_date_bs VARCHAR(20),
    payment_method VARCHAR(30),
    posted_by VARCHAR(150),
    prepared_by VARCHAR(150),
    prepared_at TIMESTAMP WITH TIME ZONE,
    approved_by VARCHAR(150),
    approved_at TIMESTAMP WITH TIME ZONE,
    statutory_config_id VARCHAR(50) REFERENCES hr_statutory_configs(id) ON DELETE SET NULL,
    paid_at TIMESTAMP WITH TIME ZONE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payroll_runs_period_shape CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    UNIQUE (branch_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_branch_period ON payroll_runs(branch_id, period_key, run_date_ad);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS run_date_bs VARCHAR(20);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS paid_date_bs VARCHAR(20);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS prepared_by VARCHAR(150);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_by VARCHAR(150);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS statutory_config_id VARCHAR(50) REFERENCES hr_statutory_configs(id) ON DELETE SET NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS incentive_total NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS arrears_total NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_status_check;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_status_check
  CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED', 'PAID'));

CREATE TABLE IF NOT EXISTS payroll_run_lines (
    id VARCHAR(60) PRIMARY KEY,
    run_id VARCHAR(50) NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    employee_code VARCHAR(50) NOT NULL,
    employee_name VARCHAR(200) NOT NULL,
    bank_name VARCHAR(150),
    bank_account VARCHAR(80),
    period_key VARCHAR(7) NOT NULL,
    salary_id VARCHAR(50) REFERENCES hr_employee_salary(id) ON DELETE SET NULL,
    basic_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    payable_days NUMERIC(6, 2) NOT NULL DEFAULT 0,
    lop_days NUMERIC(6, 2) NOT NULL DEFAULT 0,
    lop_deduction NUMERIC(14, 2) NOT NULL DEFAULT 0,
    overtime_hours NUMERIC(8, 2) NOT NULL DEFAULT 0,
    overtime_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    incentive_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    arrears_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    gross_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tds_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    ssf_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    employer_ssf_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    -- The rates the two SSF shares were computed at. A prepared run keeps its
    -- rates even when the statutory configuration is edited afterwards, so the
    -- reporting tie-out can recompute the contribution exactly. Null on rows
    -- written before the columns existed; those fall back to the run's config.
    employee_ssf_percent NUMERIC(5, 2),
    employer_ssf_percent NUMERIC(5, 2),
    advance_deduction NUMERIC(14, 2) NOT NULL DEFAULT 0,
    loan_deduction NUMERIC(14, 2) NOT NULL DEFAULT 0,
    net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payroll_run_lines_amounts_non_negative CHECK (
        gross_amount >= 0 AND tds_amount >= 0 AND ssf_amount >= 0 AND
        advance_deduction >= 0 AND loan_deduction >= 0 AND net_amount >= 0
    ),
    CONSTRAINT payroll_run_lines_net_check CHECK (
        net_amount = gross_amount - tds_amount - ssf_amount - advance_deduction - loan_deduction
    ),
    UNIQUE (employee_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_run ON payroll_run_lines(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_period ON payroll_run_lines(period_key, employee_id);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS salary_id VARCHAR(50) REFERENCES hr_employee_salary(id) ON DELETE SET NULL;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS basic_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS payable_days NUMERIC(6, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS lop_days NUMERIC(6, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS lop_deduction NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC(8, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS overtime_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS incentive_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS arrears_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS employer_ssf_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
-- Rate snapshot for the SSF shares. Nullable on purpose: existing rows predate
-- it and the reporting tie-out falls back to the run's statutory configuration
-- for them, while a new run keeps the rates it was prepared at.
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS employee_ssf_percent NUMERIC(5, 2);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS employer_ssf_percent NUMERIC(5, 2);

-- Bank details are part of the run-line snapshot, not a live employee read:
-- changing an employee's bank account after preparation must not change a
-- posted bank file or payslip. Existing databases get the columns and a
-- one-time backfill from the employee master; fresh databases already have
-- the columns in the CREATE above and no rows to backfill.
DO $$
DECLARE added_columns BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payroll_run_lines' AND column_name = 'bank_name'
  ) THEN
    ALTER TABLE payroll_run_lines ADD COLUMN bank_name VARCHAR(150);
    added_columns := TRUE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payroll_run_lines' AND column_name = 'bank_account'
  ) THEN
    ALTER TABLE payroll_run_lines ADD COLUMN bank_account VARCHAR(80);
    added_columns := TRUE;
  END IF;
  IF added_columns THEN
    UPDATE payroll_run_lines l
    SET bank_name = e.bank_name,
        bank_account = e.bank_account
    FROM employees e
    WHERE e.id = l.employee_id;
  END IF;
END $$;

-- ============================================================================
-- v3.0 MIGRATION for databases created with schema v2.x
-- (No-ops on fresh installs where the columns already exist above.)
-- ============================================================================

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
-- WTY-1 defaults for databases created before the warranty columns existed.
ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_warranty_months INT NOT NULL DEFAULT 12;
ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_warranty_months INT NOT NULL DEFAULT 12;
ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
-- Moving weighted-average cost (accounting). The DO block backfills existing
-- stock from the product cost exactly once, so a legacy database starts the
-- ledger at the same valuation the screens already show. Re-running it is a
-- no-op (the column exists after the first run), so a genuine zero average
-- from a free/received-at-zero purchase is never overwritten on boot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_stock' AND column_name = 'average_cost'
  ) THEN
    ALTER TABLE inventory_stock ADD COLUMN average_cost NUMERIC(14, 4) NOT NULL DEFAULT 0;
    UPDATE inventory_stock s
    SET average_cost = COALESCE(p.cost_price, 0)
    FROM products p
    WHERE p.id = s.product_id AND s.average_cost = 0;
  END IF;
END $$;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
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
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) DEFAULT 'CREDIT';
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS status_override VARCHAR(30);

-- B2: generated search projections for databases created before the trigram
-- search shipped. Fresh installs already declare these columns above, so
-- every statement here is a no-op there. The expression must stay identical
-- to the CREATE TABLE declaration and to the query builders; the trigram
-- indexes below are built on this exact column.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (
    lower(
        COALESCE(po_number, '') || ' ' ||
        COALESCE(supplier_name, '') || ' ' ||
        COALESCE(items::text, '')
    )
) STORED;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (
    lower(
        COALESCE(invoice_number, '') || ' ' ||
        COALESCE(vendor_bill_number, '') || ' ' ||
        COALESCE(supplier_name, '') || ' ' ||
        COALESCE(items::text, '')
    )
) STORED;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (
    lower(COALESCE(items::text, ''))
) STORED;
ALTER TABLE stock_operations ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (
    lower(
        COALESCE(reference_number, '') || ' ' ||
        COALESCE(technician_name, '') || ' ' ||
        COALESCE(work_order_ref, '') || ' ' ||
        COALESCE(reason, '') || ' ' ||
        COALESCE(items::text, '')
    )
) STORED;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (
    lower(
        COALESCE(return_number, '') || ' ' ||
        COALESCE(original_invoice_number, '') || ' ' ||
        COALESCE(supplier_name, '') || ' ' ||
        COALESCE(items::text, '')
    )
) STORED;
ALTER TABLE sales_returns ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (
    lower(
        COALESCE(return_number, '') || ' ' ||
        COALESCE(original_invoice_number, '') || ' ' ||
        COALESCE(customer_name, '') || ' ' ||
        COALESCE(items::text, '')
    )
) STORED;
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
-- Allow the extended stock-movement event types used by the operational
-- modules (Stock Operations, Damage Disposal, Product Stock-Out). Fresh
-- installs already get the new list from the CREATE TABLE above; this is a
-- no-op rewrite on databases created before the extended set shipped.
--
-- NOTE: every rewrite of this CHECK must be a SUPERSET of the values the app
-- can already have written. `ADD CONSTRAINT ... CHECK` validates existing
-- rows, so an intermediate list that is narrower than a later one aborts the
-- whole file on a database that merely holds such a row — taking the server
-- boot with it, because dbBoot.ts executes this file verbatim on startup.
ALTER TABLE transaction_logs DROP CONSTRAINT IF EXISTS transaction_logs_change_type_check;
ALTER TABLE transaction_logs ADD CONSTRAINT transaction_logs_change_type_check CHECK (
  change_type IN ('INBOUND_PO', 'PURCHASE_INVOICE', 'SALES_INVOICE', 'PURCHASE_RETURN', 'SALES_RETURN',
    'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT',
    'DAMAGE', 'DAMAGE_REVERSED', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT',
    'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN',
    'TRANSFER_CANCELLED', 'TRANSFER_RECEIPT_CANCELLED', 'SALES_INVOICE_CANCELLED',
    'PURCHASE_INVOICE_CANCELLED', 'PURCHASE_RETURN_CANCELLED', 'SALES_RETURN_CANCELLED')
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
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS audit_data JSONB;
ALTER TABLE bs_day_records ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;

-- v3.1 MIGRATION: Special Hardware Tracking flag on categories
ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_special_tracked BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================================
-- v3.2 MIGRATION for databases created before the vendor sub-ledger, damage
-- lifecycle and vendor opening balances shipped.
-- (All no-ops on fresh installs - the CREATE TABLE statements above already
-- declare every column. These exist so an older v3.0/v3.1 database that has
-- NEVER applied the full schema.sql (e.g. only the server's inline schema or
-- an older schema.sql) is brought fully in sync before the server hydrates.)
-- ============================================================================
ALTER TABLE damage_records ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE damage_records ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE damage_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE damage_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE damage_records ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS source_type VARCHAR(30) NOT NULL DEFAULT 'FISCAL_CLOSE';
ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS source_reference VARCHAR(100);
ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS posted_by VARCHAR(150);
ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vendor_opening_balances ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_fiscal_year ON vendor_payments(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;

-- ============================================================================
-- v3.3 MIGRATION: Returns module (sales_invoices, purchase_returns,
-- sales_returns) + extended ledger change types.
-- (All no-ops on fresh installs - the CREATE TABLE statements above already
-- declare everything. This rewrites the ledger CHECK so databases created
-- before the returns module accept the new change types.)
-- ============================================================================
ALTER TABLE transaction_logs DROP CONSTRAINT IF EXISTS transaction_logs_change_type_check;
ALTER TABLE transaction_logs ADD CONSTRAINT transaction_logs_change_type_check CHECK (
  change_type IN ('INBOUND_PO', 'PURCHASE_INVOICE', 'SALES_INVOICE', 'PURCHASE_RETURN', 'SALES_RETURN',
    'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT',
    'DAMAGE', 'DAMAGE_REVERSED', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT',
    'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN',
    'TRANSFER_CANCELLED', 'TRANSFER_RECEIPT_CANCELLED', 'SALES_INVOICE_CANCELLED',
    'PURCHASE_INVOICE_CANCELLED', 'PURCHASE_RETURN_CANCELLED', 'SALES_RETURN_CANCELLED')
);


-- ============================================================================
-- v3.4 MIGRATION: sales-invoice cancel/void path
-- (No-op on fresh installs — the sales_invoices CREATE TABLE above already
-- declares `status` with its CHECK.)
-- ============================================================================
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'CANCELLED'));

-- ============================================================================
-- v3.5 MIGRATION: compensating ledger rows for document cancel/delete
-- (PI delete, PR cancel and SR cancel restore stock but until now wrote no
-- reversing ledger row, so the movement ledger overstated those documents'
-- stock effects forever. Rewrites the ledger CHECK to accept the three
-- compensating change types; no-op on fresh installs via the CREATE TABLE
-- list above.)
-- ============================================================================
ALTER TABLE transaction_logs DROP CONSTRAINT IF EXISTS transaction_logs_change_type_check;
ALTER TABLE transaction_logs ADD CONSTRAINT transaction_logs_change_type_check CHECK (
  change_type IN ('INBOUND_PO', 'PURCHASE_INVOICE', 'SALES_INVOICE', 'PURCHASE_RETURN', 'SALES_RETURN',
    'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT',
    'DAMAGE', 'DAMAGE_REVERSED', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT',
    'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN',
    'TRANSFER_CANCELLED', 'TRANSFER_RECEIPT_CANCELLED', 'SALES_INVOICE_CANCELLED',
    'PURCHASE_INVOICE_CANCELLED', 'PURCHASE_RETURN_CANCELLED', 'SALES_RETURN_CANCELLED')
);

-- ============================================================================
-- HIGH-PERFORMANCE INDEXES
-- ============================================================================

-- Branches indexes
CREATE INDEX IF NOT EXISTS idx_branches_code ON branches(code);
CREATE INDEX IF NOT EXISTS idx_branches_active ON branches(active);
CREATE INDEX IF NOT EXISTS idx_branches_demo ON branches(id) WHERE is_demo = TRUE;

-- Users indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_demo ON users(id) WHERE is_demo = TRUE;

-- Suppliers indexes
CREATE INDEX IF NOT EXISTS idx_suppliers_code ON suppliers(supplier_code);
CREATE INDEX IF NOT EXISTS idx_suppliers_pan_vat ON suppliers(pan_vat_number);
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status);
CREATE INDEX IF NOT EXISTS idx_suppliers_demo ON suppliers(id) WHERE is_demo = TRUE;

-- Categories indexes
CREATE INDEX IF NOT EXISTS idx_categories_demo ON categories(id) WHERE is_demo = TRUE;

-- Products indexes
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group);

-- Existing databases: the original schema pinned product_group to the three
-- built-in names with an inline CHECK. Swap it for the foreign key above.
-- Both statements are idempotent, so this runs on every boot without effect on
-- a database that already matches (the inline FK is auto-named
-- products_product_group_fkey, so the DO block skips on a fresh install).
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_group_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_product_group_fkey'
      AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_product_group_fkey
      FOREIGN KEY (product_group) REFERENCES product_groups(name)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_demo ON products(id) WHERE is_demo = TRUE;

-- Inventory Stock indexes
CREATE INDEX IF NOT EXISTS idx_stock_product_branch ON inventory_stock(product_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_branch ON inventory_stock(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_reorder ON inventory_stock(quantity_on_hand, min_reorder_level);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_demo ON inventory_stock(id) WHERE is_demo = TRUE;

-- Fixed Assets indexes
CREATE INDEX IF NOT EXISTS idx_fixed_assets_tag ON fixed_assets(tag_number);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_branch ON fixed_assets(branch_id);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_status ON fixed_assets(status);
CREATE INDEX IF NOT EXISTS idx_assets_acquisition_date ON fixed_assets(acquisition_date_ad);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_fiscal_year_id ON fixed_assets(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fixed_assets_purchase_invoice_id ON fixed_assets(purchase_invoice_id) WHERE purchase_invoice_id IS NOT NULL;

-- ASSET-1: the register's stable page for a branch scope (created_at DESC, id DESC).
CREATE INDEX IF NOT EXISTS idx_fixed_assets_page ON fixed_assets(branch_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_invoice_date ON fixed_assets(branch_id, purchase_invoice_date_ad);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_service_date ON fixed_assets(branch_id, placed_in_service_date_ad);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_demo ON fixed_assets(id) WHERE is_demo = TRUE;

-- Purchase Orders indexes
CREATE INDEX IF NOT EXISTS idx_po_number ON purchase_orders(po_number);
CREATE INDEX IF NOT EXISTS idx_po_branch ON purchase_orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_date ON purchase_orders(order_date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_po_branch_order_date ON purchase_orders(branch_id, order_date_ad);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_fiscal_year_id ON purchase_orders(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_demo ON purchase_orders(id) WHERE is_demo = TRUE;

-- Purchase Invoices indexes
CREATE INDEX IF NOT EXISTS idx_invoices_number ON purchase_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_branch ON purchase_invoices(branch_id);
CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON purchase_invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_status ON purchase_invoices(payment_status);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON purchase_invoices(invoice_date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_pi_branch_invoice_date ON purchase_invoices(branch_id, invoice_date_ad);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_fiscal_year_id ON purchase_invoices(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_demo ON purchase_invoices(id) WHERE is_demo = TRUE;

-- Shipments indexes
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(tracking_code);
CREATE INDEX IF NOT EXISTS idx_shipments_source_dest ON shipments(source_branch_id, destination_branch_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_dispatch_date ON shipments(dispatch_date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_shipments_fiscal_year_id ON shipments(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_demo ON shipments(id) WHERE is_demo = TRUE;

-- Stock Operations indexes
CREATE INDEX IF NOT EXISTS idx_stock_ops_ref ON stock_operations(reference_number);
CREATE INDEX IF NOT EXISTS idx_stock_ops_branch ON stock_operations(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_ops_type ON stock_operations(type);
CREATE INDEX IF NOT EXISTS idx_stock_ops_date ON stock_operations(date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_stock_operations_fiscal_year_id ON stock_operations(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_operations_demo ON stock_operations(id) WHERE is_demo = TRUE;

-- Audit Logs indexes
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp_ad DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_email);
CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module);
CREATE INDEX IF NOT EXISTS idx_audit_branch ON audit_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_fiscal_year_id ON audit_logs(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_demo ON audit_logs(id) WHERE is_demo = TRUE;

-- Transaction Logs indexes
CREATE INDEX IF NOT EXISTS idx_txn_product ON transaction_logs(product_id);
CREATE INDEX IF NOT EXISTS idx_txn_branch ON transaction_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_txn_timestamp ON transaction_logs(timestamp_ad DESC);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transaction_logs(change_type);
CREATE INDEX IF NOT EXISTS idx_transaction_logs_fiscal_year_id ON transaction_logs(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transaction_logs_demo ON transaction_logs(id) WHERE is_demo = TRUE;

-- Audit module enum: every module a caller writes must be listed here, or
-- PostgreSQL rejects the row. This is the ONE vocabulary: the value passed as
-- `logAuditEvent(req, action, module, …)` (and the serial-log upsert path's
-- 'INVENTORY') must appear below, and the client's `AuditLog['module']` union
-- mirrors this list. Divergence is silent by default — the insert is either
-- fire-and-forget (logged only) or, on a transactional caller, rejects the whole
-- action — so `tests/auditModuleVocabulary.guard.test.ts` parses this block and
-- fails when a caller uses a module that is missing.
--
-- Two modules were missing until 2026-10-30: 'SALES' (all eight sales-invoice /
-- return / customer-payment events) and 'PERMISSIONS' (the permission-matrix
-- save), so those audit rows never persisted.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_module_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_module_check CHECK (module IN (
  'AUTH', 'MASTER_DATA', 'PRODUCTS', 'CATEGORIES', 'PROCUREMENT', 'LOGISTICS',
  'STOCK_OPERATIONS', 'FIXED_ASSETS', 'CPE_MANAGEMENT', 'INVENTORY', 'INVENTORY_AUDIT',
  'OPERATIONS', 'BRANCH_OPERATIONS', 'FISCAL_YEAR', 'APPROVAL_WORKFLOW', 'SYSTEM',
  'SALES', 'PERMISSIONS', 'ACCOUNTING'
));

-- Customer Records indexes
CREATE INDEX IF NOT EXISTS idx_customer_records_id ON customer_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_records_branch ON customer_records(branch_id);
CREATE INDEX IF NOT EXISTS idx_customer_records_contact ON customer_records(contact_number);
CREATE INDEX IF NOT EXISTS idx_customer_records_demo ON customer_records(id) WHERE is_demo = TRUE;
-- VOL-4a: the customer directory is the app's largest master table (12k at the
-- modelled 1x, 120k+ nationally) and every picker keystroke runs a contains
-- search across six columns. This trigram index is the ONE expression
-- CUSTOMER_SEARCH_TEXT_SQL in server/src/models/masterdata.repo.ts builds its
-- WHERE from — change either and the search falls back to a sequential scan.
CREATE INDEX IF NOT EXISTS idx_customer_records_search_trgm ON customer_records USING gin (
  (lower(COALESCE(customer_id, '') || ' ' || COALESCE(customer_name, '') || ' ' ||
         COALESCE(username, '') || ' ' || COALESCE(contact_number, '') || ' ' ||
         COALESCE(email, '') || ' ' || COALESCE(address, ''))) gin_trgm_ops
);
-- Stable name-ordered paging within a branch scope (the list's ORDER BY).
CREATE INDEX IF NOT EXISTS idx_customer_records_name ON customer_records(branch_id, customer_name, customer_id);

-- Customer Device Records indexes
CREATE INDEX IF NOT EXISTS idx_customer_devices_serials ON customer_device_records(device_serial, pon_serial, mac_address);
CREATE INDEX IF NOT EXISTS idx_customer_devices_customer ON customer_device_records(customer_id, customer_code);
CREATE INDEX IF NOT EXISTS idx_customer_devices_branch_status ON customer_device_records(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_issued_date ON customer_device_records(issued_date_ad);
-- VOL-4b: the device register pages newest-first inside a branch scope. The
-- composite keeps the stable ORDER BY created_at DESC, id DESC page from
-- sorting the branch's whole table for every keystroke/page turn.
CREATE INDEX IF NOT EXISTS idx_customer_devices_page ON customer_device_records(branch_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_customer_device_records_fiscal_year_id ON customer_device_records(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_device_records_demo ON customer_device_records(id) WHERE is_demo = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_device_serial ON customer_device_records ((lower(trim(device_serial)))) WHERE trim(device_serial) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_pon_serial ON customer_device_records ((lower(trim(pon_serial)))) WHERE trim(pon_serial) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_device_mac_address ON customer_device_records ((lower(trim(mac_address)))) WHERE mac_address IS NOT NULL AND trim(mac_address) <> '';

-- Serial Log indexes (unique device_serial = one row per serial)
CREATE INDEX IF NOT EXISTS idx_serial_log_branch ON serial_log(branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_serial_log_status ON serial_log(status);
CREATE INDEX IF NOT EXISTS idx_serial_log_demo ON serial_log(id) WHERE is_demo = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_serial_log_device_serial ON serial_log ((lower(trim(device_serial)))) WHERE trim(device_serial) <> '';

-- Approval Requests indexes
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status, branch_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_type ON approval_requests(type);
CREATE INDEX IF NOT EXISTS idx_approval_requests_date ON approval_requests(requested_at_ad DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_fiscal_year_id ON approval_requests(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_requests_demo ON approval_requests(id) WHERE is_demo = TRUE;

-- BS Calendar indexes
CREATE INDEX IF NOT EXISTS idx_bs_calendar_year ON bs_calendar_years(year_bs);
CREATE INDEX IF NOT EXISTS idx_bs_day_records_bs_date ON bs_day_records(bs_date);
CREATE INDEX IF NOT EXISTS idx_bs_day_records_bs_year_month ON bs_day_records(bs_year, bs_month);
CREATE INDEX IF NOT EXISTS idx_bs_day_records_fiscal_year ON bs_day_records(fiscal_year);
CREATE INDEX IF NOT EXISTS idx_bs_day_records_fiscal_year_id ON bs_day_records(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;

-- UOM indexes
CREATE INDEX IF NOT EXISTS idx_uom_name ON uom(name);

-- Locations indexes
CREATE INDEX IF NOT EXISTS idx_locations_branch ON locations(branch_id);
CREATE INDEX IF NOT EXISTS idx_locations_type ON locations(type);
CREATE INDEX IF NOT EXISTS idx_locations_demo ON locations(id) WHERE is_demo = TRUE;

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
CREATE OR REPLACE TRIGGER trg_sales_invoices_fiscal_year BEFORE INSERT OR UPDATE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('invoice_date_ad');
CREATE OR REPLACE TRIGGER trg_purchase_returns_fiscal_year BEFORE INSERT OR UPDATE ON purchase_returns FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('return_date_ad');
CREATE OR REPLACE TRIGGER trg_sales_returns_fiscal_year BEFORE INSERT OR UPDATE ON sales_returns FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('return_date_ad');
CREATE OR REPLACE TRIGGER trg_customer_payments_fiscal_year BEFORE INSERT OR UPDATE ON customer_payments FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('payment_date_ad');
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

-- ============================================================================
-- RUNTIME PARITY SECTION (phase-2 duplication cleanup)
-- ============================================================================
-- dbBoot.ts executes THIS FILE as its schema source of truth. The statements
-- below are the dbBoot-only runtime statements (migration ALTERs, legacy index
-- aliases kept so old deployments don't accumulate orphan indexes, and the
-- serial-log legacy helper index) ported verbatim so that "apply schema.sql"
-- and "boot the server" produce byte-identical schemas. The static drift
-- guard (tests/schemaSource.parity.test.ts) fails CI if the two sources
-- diverge again.
-- ============================================================================

-- Legacy index-name aliases: these ran under the old names in dbBoot before
-- the consolidation. Kept as no-ops so upgraded deployments that only ever
-- ran dbBoot do not lose the index coverage (same columns as the canonical
-- indexes above).
CREATE INDEX IF NOT EXISTS idx_stock_prod_branch ON inventory_stock(product_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_assets_tag ON fixed_assets(tag_number);
CREATE INDEX IF NOT EXISTS idx_assets_branch ON fixed_assets(branch_id);
CREATE INDEX IF NOT EXISTS idx_assets_status ON fixed_assets(status);
CREATE INDEX IF NOT EXISTS idx_orders_num ON purchase_orders(po_number);
CREATE INDEX IF NOT EXISTS idx_orders_branch ON purchase_orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_invoices_num ON purchase_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON purchase_invoices(payment_status);
CREATE INDEX IF NOT EXISTS idx_shipments_track ON shipments(tracking_code);
CREATE INDEX IF NOT EXISTS idx_shipments_src_dst ON shipments(source_branch_id, destination_branch_id);

-- B2: one trigram GIN per searched table. The query builders must use
-- `search_text LIKE $n` (lower-cased patterns); an items-only index is not
-- enough because the register predicates also search header columns.
CREATE INDEX IF NOT EXISTS idx_purchase_orders_search_trgm ON purchase_orders USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_search_trgm ON purchase_invoices USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shipments_search_trgm ON shipments USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_stock_operations_search_trgm ON stock_operations USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_search_trgm ON purchase_returns USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sales_returns_search_trgm ON sales_returns USING gin (search_text gin_trgm_ops);

-- TRIM-1: the global quick search is a bounded server read, so the four groups
-- that have no `search_text` projection get one expression trigram index each.
-- globalSearch.repo.ts repeats these exact expressions in its WHERE clauses;
-- keep the two in lockstep or PostgreSQL falls back to a sequential scan.
CREATE INDEX IF NOT EXISTS idx_products_global_trgm ON products USING gin (
  (lower(COALESCE(name, '') || ' ' || COALESCE(sku, '') || ' ' ||
         COALESCE(barcode, '') || ' ' || COALESCE(category, ''))) gin_trgm_ops
);
CREATE INDEX IF NOT EXISTS idx_assets_global_trgm ON fixed_assets USING gin (
  (lower(COALESCE(tag_number, '') || ' ' || COALESCE(name, '') || ' ' ||
         COALESCE(category, '') || ' ' || COALESCE(assigned_customer_name, '') || ' ' ||
         COALESCE(invoice_no, '') || ' ' || COALESCE(supplier_name, ''))) gin_trgm_ops
);
CREATE INDEX IF NOT EXISTS idx_customer_devices_global_trgm ON customer_device_records USING gin (
  (lower(COALESCE(customer_code, '') || ' ' || COALESCE(customer_name, '') || ' ' ||
         COALESCE(product_name, '') || ' ' || COALESCE(device_serial, '') || ' ' ||
         COALESCE(pon_serial, '') || ' ' || COALESCE(mac_address, '') || ' ' ||
         COALESCE(contact_phone, ''))) gin_trgm_ops
);
CREATE INDEX IF NOT EXISTS idx_shipments_global_trgm ON shipments USING gin (
  (lower(COALESCE(tracking_code, '') || ' ' || COALESCE(source_branch_name, '') || ' ' ||
         COALESCE(destination_branch_name, '') || ' ' || COALESCE(status, ''))) gin_trgm_ops
);

CREATE INDEX IF NOT EXISTS idx_customers_id ON customer_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_branch ON customer_records(branch_id);
CREATE INDEX IF NOT EXISTS idx_device_serials ON customer_device_records(device_serial, pon_serial, mac_address);
CREATE INDEX IF NOT EXISTS idx_device_branch ON customer_device_records(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status, branch_id);
CREATE INDEX IF NOT EXISTS idx_approval_type ON approval_requests(type);
CREATE INDEX IF NOT EXISTS idx_bs_days_date ON bs_day_records(bs_date);
CREATE INDEX IF NOT EXISTS idx_bs_days_ym ON bs_day_records(bs_year, bs_month);

-- dbBoot runtime ALTERs that schema.sql did not previously carry.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE fiscal_years ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS allow_warehouse_transfer BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Serial-log backfill support columns (dbBoot runtime additions).
ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL;
ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_serial_log_device_serial ON serial_log((lower(trim(device_serial))));

-- ---------------------------------------------------------------------------
-- serial_log PON/MAC uniqueness (2026-10-13, Slice 1 of the serial-register
-- plan). The register is the mirror-and-verify of customer_device_records,
-- which has enforced unique PON and unique MAC since v3.2
-- (uq_customer_device_pon_serial / uq_customer_device_mac_address). The
-- register never did, and it is now the authority the pick-only screens read
-- PON/MAC from, so the same invariant has to hold here.
--
-- Partial indexes rather than table constraints because both columns are
-- nullable: only non-empty values are governed (a manual row or a
-- QUANTITY_ONLY receive carries neither). The application already refuses
-- every duplicate on both sides — the purchase owner probes and the serial
-- rename clash checks — so this closes the check-then-write race those reads
-- cannot: two invoices posting the same PON concurrently.
--
-- Applied conditionally (same degrade-gracefully pattern as the status
-- hardening below): dbBoot applies this file verbatim at EVERY start, so a
-- legacy database already holding duplicate PON/MAC rows logs a WARNING and
-- keeps booting instead of refusing to start; the app-level checks still
-- refuse every new duplicate. Deduplicate such a database, then restart to
-- apply the index.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM serial_log
    WHERE trim(coalesce(pon_serial, '')) <> ''
    GROUP BY lower(trim(pon_serial)) HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_serial_log_pon_serial
      ON serial_log ((lower(trim(pon_serial)))) WHERE trim(coalesce(pon_serial, '')) <> '';
  ELSE
    RAISE WARNING 'serial_log holds duplicate PON serials - skipping uq_serial_log_pon_serial (deduplicate, then restart to apply it).';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM serial_log
    WHERE trim(coalesce(mac_address, '')) <> ''
    GROUP BY lower(trim(mac_address)) HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_serial_log_mac_address
      ON serial_log ((lower(trim(mac_address)))) WHERE trim(coalesce(mac_address, '')) <> '';
  ELSE
    RAISE WARNING 'serial_log holds duplicate MAC addresses - skipping uq_serial_log_mac_address (deduplicate, then restart to apply it).';
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- serial_log.status vocabulary hardening (2026-10-11): the CDR side already
-- declares its status CHECK; mirror it on the register. The vocabulary is
-- exactly what the server writes today: IN_STOCK / IN_TRANSIT (purchases &
-- shipments), CUSTOMER_ASSIGNED / POP_LOCATION_ASSIGNED (deployments & CDR
-- sync), DAMAGED (quarantine & damaged-exchange disposition), RETURNED
-- (legacy manual rows kept filterable), SOLD (sales-invoice serial flip) and
-- RETURNED_TO_VENDOR (purchase-return serial flip). Applied conditionally
-- (same degrade-gracefully pattern as the BS-date hardening below): a legacy
-- database still holding a stray manual value skips the constraint instead
-- of failing boot.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- SER-1: CONSUMED joins the vocabulary for an issued consumable. Re-create
  -- both historical constraint names so a fresh and an upgraded database
  -- accept every state the lifecycle writes.
  ALTER TABLE serial_log DROP CONSTRAINT IF EXISTS serial_log_status_known;
  ALTER TABLE serial_log DROP CONSTRAINT IF EXISTS serial_log_status_check;
  ALTER TABLE serial_log ADD CONSTRAINT serial_log_status_check
    CHECK (status IN ('IN_STOCK', 'IN_TRANSIT', 'CUSTOMER_ASSIGNED', 'POP_LOCATION_ASSIGNED', 'DAMAGED', 'RETURNED', 'SOLD', 'RETURNED_TO_VENDOR', 'CONSUMED'));
END $$;

-- Legacy shipment/stock-ops date indexes (dbBoot-only before consolidation).
CREATE INDEX IF NOT EXISTS idx_shipments_dispatch_date ON shipments(dispatch_date_ad);
CREATE INDEX IF NOT EXISTS idx_stock_ops_date ON stock_operations(date_ad);

-- company_profile currency backfill for pre-currency-config databases.
UPDATE company_profile SET
  currency_code = 'NPR',
  currency_locale = 'en-IN',
  currency_position = 'before',
  currency_decimals = 2
WHERE currency_code IS NULL OR currency_code = '';

-- stock_operations.fiscal_year: drop the stale hard-coded fiscal-year default
-- (legacy databases only; fresh installs declare no default).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'stock_operations'
               AND column_name = 'fiscal_year'
               AND column_default IS NOT NULL) THEN
    ALTER TABLE stock_operations ALTER COLUMN fiscal_year DROP DEFAULT;
  END IF;
END $$;

-- vendor_payments fiscal-year backfill (ran in dbBoot before consolidation).
UPDATE vendor_payments SET fiscal_year_id = (SELECT id FROM fiscal_years fy WHERE payment_date_ad BETWEEN fy.start_date_ad AND fy.end_date_ad ORDER BY fy.start_date_ad DESC LIMIT 1) WHERE fiscal_year_id IS NULL;


-- ---------------------------------------------------------------------------
-- Mandatory BS-date hardening (2026-10-10): every operation's BS date must be
-- persisted once its event happened -- no NULL, empty, or fallback values.
-- Step 1 backfills NULL/empty BS values from bs_day_records where the AD
-- counterpart day is seeded; step 2 tightens NOT NULL / conditional CHECK
-- constraints ONLY where the column is left clean, so calendars with gaps
-- degrade gracefully instead of breaking writes. Idempotent on every boot.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- The BS backfill updates posted journal/subledger rows in place. It is
  -- schema maintenance, not an accounting correction, so it runs inside the
  -- same local-only bypass as the book-adoption migration above.
  PERFORM set_config('inventory.allow_ledger_purge', 'on', true);

  -- 1. Backfills (bs_day_records.bs_date carries no ' BS' suffix).
  UPDATE vendor_payments p SET payment_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (p.payment_date_bs IS NULL OR p.payment_date_bs = '') AND b.ad_date = p.payment_date_ad;
  UPDATE customer_payments p SET payment_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (p.payment_date_bs IS NULL OR p.payment_date_bs = '') AND b.ad_date = p.payment_date_ad;
  UPDATE vendor_payments p SET cheque_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE p.cheque_date_ad IS NOT NULL AND (p.cheque_date_bs IS NULL OR p.cheque_date_bs = '') AND b.ad_date = p.cheque_date_ad;
  UPDATE customer_payments p SET cheque_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE p.cheque_date_ad IS NOT NULL AND (p.cheque_date_bs IS NULL OR p.cheque_date_bs = '') AND b.ad_date = p.cheque_date_ad;
  UPDATE shipments s SET received_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE s.received_date_bs IS NULL AND s.received_date_ad IS NOT NULL AND b.ad_date = s.received_date_ad;
  UPDATE audit_logs a SET timestamp_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (a.timestamp_bs IS NULL OR a.timestamp_bs = '') AND b.ad_date = a.timestamp_ad::date;
  UPDATE transaction_logs t SET timestamp_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (t.timestamp_bs IS NULL OR t.timestamp_bs = '') AND b.ad_date = t.timestamp_ad::date;
  UPDATE fixed_assets f SET acquisition_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (f.acquisition_date_bs IS NULL OR f.acquisition_date_bs = '') AND b.ad_date = f.acquisition_date_ad;
  UPDATE fixed_assets f SET assignment_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE f.assignment_date_ad IS NOT NULL AND (f.assignment_date_bs IS NULL OR f.assignment_date_bs = '') AND b.ad_date = f.assignment_date_ad;
  UPDATE customer_device_records c SET issued_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE c.issued_date_ad IS NOT NULL AND (c.issued_date_bs IS NULL OR c.issued_date_bs = '') AND b.ad_date = c.issued_date_ad;
  UPDATE stock_operations o SET date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (o.date_bs IS NULL OR o.date_bs = '') AND b.ad_date = o.date_ad;

  -- Finance/accounting dual dates: the GL header, its period, every control
  -- subledger row, the cash close, payroll and the remaining fixed-asset dates
  -- all persist the BS half derived from the operation's own AD date.
  UPDATE gl_periods p SET start_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (p.start_date_bs IS NULL OR p.start_date_bs = '') AND b.ad_date = p.start_date_ad;
  UPDATE gl_periods p SET end_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (p.end_date_bs IS NULL OR p.end_date_bs = '') AND b.ad_date = p.end_date_ad;
  UPDATE gl_journals j SET journal_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (j.journal_date_bs IS NULL OR j.journal_date_bs = '') AND b.ad_date = j.journal_date_ad;
  UPDATE gl_journals j SET reference_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE j.reference_date_ad IS NOT NULL AND (j.reference_date_bs IS NULL OR j.reference_date_bs = '') AND b.ad_date = j.reference_date_ad;
  UPDATE gl_journals j SET cheque_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE j.cheque_date_ad IS NOT NULL AND (j.cheque_date_bs IS NULL OR j.cheque_date_bs = '') AND b.ad_date = j.cheque_date_ad;
  UPDATE gl_subledger_entries e SET entry_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (e.entry_date_bs IS NULL OR e.entry_date_bs = '') AND b.ad_date = e.entry_date_ad;
  UPDATE daily_cash_closes c SET business_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (c.business_date_bs IS NULL OR c.business_date_bs = '') AND b.ad_date = c.business_date_ad;
  UPDATE payroll_runs r SET run_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE (r.run_date_bs IS NULL OR r.run_date_bs = '') AND b.ad_date = r.run_date_ad;
  UPDATE payroll_runs r SET paid_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE r.paid_date_ad IS NOT NULL AND (r.paid_date_bs IS NULL OR r.paid_date_bs = '') AND b.ad_date = r.paid_date_ad;
  UPDATE fixed_assets f SET capitalization_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE f.capitalization_date_ad IS NOT NULL AND (f.capitalization_date_bs IS NULL OR f.capitalization_date_bs = '') AND b.ad_date = f.capitalization_date_ad;
  UPDATE fixed_assets f SET placed_in_service_date_bs = b.bs_date || ' BS'
    FROM bs_day_records b
    WHERE f.placed_in_service_date_ad IS NOT NULL AND (f.placed_in_service_date_bs IS NULL OR f.placed_in_service_date_bs = '') AND b.ad_date = f.placed_in_service_date_ad;

  -- 2. Tighten constraints only where the backfill left the column clean.
  IF NOT EXISTS (SELECT 1 FROM vendor_payments WHERE payment_date_bs IS NULL OR payment_date_bs = '') THEN
    ALTER TABLE vendor_payments ALTER COLUMN payment_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_payments WHERE payment_date_bs IS NULL OR payment_date_bs = '') THEN
    ALTER TABLE customer_payments ALTER COLUMN payment_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_logs WHERE timestamp_bs IS NULL OR timestamp_bs = '') THEN
    ALTER TABLE audit_logs ALTER COLUMN timestamp_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM transaction_logs WHERE timestamp_bs IS NULL OR timestamp_bs = '') THEN
    ALTER TABLE transaction_logs ALTER COLUMN timestamp_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stock_operations WHERE date_bs = '') THEN
    ALTER TABLE stock_operations DROP CONSTRAINT IF EXISTS stock_operations_date_bs_not_empty;
    ALTER TABLE stock_operations ADD CONSTRAINT stock_operations_date_bs_not_empty CHECK (date_bs <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fixed_assets WHERE acquisition_date_bs IS NULL OR acquisition_date_bs = '') THEN
    ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_acquisition_bs_required;
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_acquisition_bs_required CHECK (acquisition_date_bs <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fixed_assets WHERE assignment_date_ad IS NOT NULL AND (assignment_date_bs IS NULL OR assignment_date_bs = '')) THEN
    ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_assignment_bs_required;
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_assignment_bs_required CHECK (assignment_date_ad IS NULL OR (assignment_date_bs IS NOT NULL AND assignment_date_bs <> ''));
  END IF;
  -- Assignment statuses are written by Assign Fixed Asset and the CPE
  -- lifecycle, but the original column CHECK only listed the register's own
  -- values, so a fresh or upgraded database rejected every deployment.
  ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_status_check;
  ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_status_check CHECK (
    status IN ('ACTIVE', 'DISPOSED', 'WRITTEN_OFF', 'MAINTENANCE', 'IN_USE', 'ASSIGNED_TO_CUSTOMER', 'ASSIGNED_TO_LOCATION')
  );
  IF NOT EXISTS (SELECT 1 FROM customer_device_records WHERE issued_date_ad IS NOT NULL AND (issued_date_bs IS NULL OR issued_date_bs = '')) THEN
    ALTER TABLE customer_device_records DROP CONSTRAINT IF EXISTS cdr_issued_bs_required;
    ALTER TABLE customer_device_records ADD CONSTRAINT cdr_issued_bs_required CHECK (issued_date_ad IS NULL OR (issued_date_bs IS NOT NULL AND issued_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shipments WHERE status IN ('RECEIVED', 'DISCREPANCY') AND received_date_bs IS NULL) THEN
    ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_received_bs_required;
    ALTER TABLE shipments ADD CONSTRAINT shipments_received_bs_required CHECK (status NOT IN ('RECEIVED', 'DISCREPANCY') OR (received_date_bs IS NOT NULL AND received_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vendor_payments WHERE cheque_date_ad IS NOT NULL AND (cheque_date_bs IS NULL OR cheque_date_bs = '')) THEN
    ALTER TABLE vendor_payments DROP CONSTRAINT IF EXISTS vendor_payments_cheque_bs_required;
    ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_cheque_bs_required CHECK (cheque_date_ad IS NULL OR (cheque_date_bs IS NOT NULL AND cheque_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_payments WHERE cheque_date_ad IS NOT NULL AND (cheque_date_bs IS NULL OR cheque_date_bs = '')) THEN
    ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_cheque_bs_required;
    ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_cheque_bs_required CHECK (cheque_date_ad IS NULL OR (cheque_date_bs IS NOT NULL AND cheque_date_bs <> ''));
  END IF;

  -- Finance/accounting write-path dual dates. NOT NULL only where existing
  -- history is clean; optional AD dates use a conditional CHECK instead.
  IF NOT EXISTS (SELECT 1 FROM gl_periods WHERE start_date_bs IS NULL OR start_date_bs = '') THEN
    ALTER TABLE gl_periods ALTER COLUMN start_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_periods WHERE end_date_bs IS NULL OR end_date_bs = '') THEN
    ALTER TABLE gl_periods ALTER COLUMN end_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_journals WHERE journal_date_bs IS NULL OR journal_date_bs = '') THEN
    ALTER TABLE gl_journals ALTER COLUMN journal_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_journals WHERE reference_date_ad IS NOT NULL AND (reference_date_bs IS NULL OR reference_date_bs = '')) THEN
    ALTER TABLE gl_journals DROP CONSTRAINT IF EXISTS gl_journals_reference_bs_required;
    ALTER TABLE gl_journals ADD CONSTRAINT gl_journals_reference_bs_required CHECK (reference_date_ad IS NULL OR (reference_date_bs IS NOT NULL AND reference_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_journals WHERE cheque_date_ad IS NOT NULL AND (cheque_date_bs IS NULL OR cheque_date_bs = '')) THEN
    ALTER TABLE gl_journals DROP CONSTRAINT IF EXISTS gl_journals_cheque_bs_required;
    ALTER TABLE gl_journals ADD CONSTRAINT gl_journals_cheque_bs_required CHECK (cheque_date_ad IS NULL OR (cheque_date_bs IS NOT NULL AND cheque_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_subledger_entries WHERE entry_date_bs IS NULL OR entry_date_bs = '') THEN
    ALTER TABLE gl_subledger_entries ALTER COLUMN entry_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM daily_cash_closes WHERE business_date_bs IS NULL OR business_date_bs = '') THEN
    ALTER TABLE daily_cash_closes ALTER COLUMN business_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM payroll_runs WHERE run_date_bs IS NULL OR run_date_bs = '') THEN
    ALTER TABLE payroll_runs ALTER COLUMN run_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM payroll_runs WHERE paid_date_ad IS NOT NULL AND (paid_date_bs IS NULL OR paid_date_bs = '')) THEN
    ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_paid_bs_required;
    ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_paid_bs_required CHECK (paid_date_ad IS NULL OR (paid_date_bs IS NOT NULL AND paid_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fixed_assets WHERE purchase_invoice_date_ad IS NOT NULL AND (purchase_invoice_date_bs IS NULL OR purchase_invoice_date_bs = '')) THEN
    ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_purchase_invoice_bs_required;
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_purchase_invoice_bs_required CHECK (purchase_invoice_date_ad IS NULL OR (purchase_invoice_date_bs IS NOT NULL AND purchase_invoice_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fixed_assets WHERE capitalization_date_ad IS NOT NULL AND (capitalization_date_bs IS NULL OR capitalization_date_bs = '')) THEN
    ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_capitalization_bs_required;
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_capitalization_bs_required CHECK (capitalization_date_ad IS NULL OR (capitalization_date_bs IS NOT NULL AND capitalization_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fixed_assets WHERE placed_in_service_date_ad IS NOT NULL AND (placed_in_service_date_bs IS NULL OR placed_in_service_date_bs = '')) THEN
    ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_placed_in_service_bs_required;
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_placed_in_service_bs_required CHECK (placed_in_service_date_ad IS NULL OR (placed_in_service_date_bs IS NOT NULL AND placed_in_service_date_bs <> ''));
  END IF;

  PERFORM set_config('inventory.allow_ledger_purge', 'off', true);
END $$;

-- ---------------------------------------------------------------------------
-- WTY-1 legacy warranty backfill (idempotent).
--
-- Before this table the app DERIVED one 12-month countdown at read time:
-- CPE from issued_date, fixed assets from acquisition. The backfill preserves
-- that behaviour for existing rows, flagged LEGACY_12_MONTH so the origin is
-- visible and an operator can correct it. Deterministic ids make every re-run a
-- no-op; the NOT EXISTS guard respects a row an operator has already replaced.
-- ---------------------------------------------------------------------------
INSERT INTO warranty_coverages (
  id, coverage_type, item_category, product_id, product_name, serial_number,
  asset_id, branch_id, party_name, source_type, source_id, source_number,
  start_date_ad, start_date_bs, end_date_ad, end_date_bs, term_months, start_basis, is_demo
)
SELECT
  'wc-legacy-asset-' || a.id, 'VENDOR', 'FIXED_ASSET', a.product_id, a.name,
  UPPER(TRIM(a.tag_number)), a.id, a.branch_id, a.supplier_name,
  'FIXED_ASSET', a.id, a.invoice_no,
  a.acquisition_date_ad,
  COALESCE((SELECT b.bs_date || ' BS' FROM bs_day_records b WHERE b.ad_date = a.acquisition_date_ad), 'BS not seeded'),
  (a.acquisition_date_ad + INTERVAL '12 months')::date,
  COALESCE((SELECT b.bs_date || ' BS' FROM bs_day_records b WHERE b.ad_date = (a.acquisition_date_ad + INTERVAL '12 months')::date), 'BS not seeded'),
  12, 'LEGACY_12_MONTH', a.is_demo
FROM fixed_assets a
WHERE a.acquisition_date_ad IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM warranty_coverages w
    WHERE w.coverage_type = 'VENDOR'
      AND w.serial_number = UPPER(TRIM(a.tag_number))
      AND w.is_current = TRUE
  )
ON CONFLICT DO NOTHING;

INSERT INTO warranty_coverages (
  id, coverage_type, item_category, product_id, product_name, serial_number,
  device_record_id, branch_id, party_id, party_name, source_type, source_id,
  source_number, start_date_ad, start_date_bs, end_date_ad, end_date_bs, term_months, start_basis, is_demo
)
SELECT
  'wc-legacy-cdr-' || c.id, 'SELLER',
  CASE WHEN c.status = 'SOLD' THEN 'SOLD_PRODUCT' ELSE 'CPE' END,
  NULL, c.product_name, UPPER(TRIM(c.device_serial)),
  c.id, c.branch_id, c.customer_id, c.customer_name,
  'CUSTOMER_DEVICE', c.id, c.customer_code,
  c.issued_date_ad,
  COALESCE((SELECT b.bs_date || ' BS' FROM bs_day_records b WHERE b.ad_date = c.issued_date_ad), 'BS not seeded'),
  (c.issued_date_ad + INTERVAL '12 months')::date,
  COALESCE((SELECT b.bs_date || ' BS' FROM bs_day_records b WHERE b.ad_date = (c.issued_date_ad + INTERVAL '12 months')::date), 'BS not seeded'),
  12, 'LEGACY_12_MONTH', c.is_demo
FROM customer_device_records c
WHERE c.issued_date_ad IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM warranty_coverages w
    WHERE w.coverage_type = 'SELLER'
      AND w.serial_number = UPPER(TRIM(c.device_serial))
      AND w.is_current = TRUE
  )
ON CONFLICT DO NOTHING;

INSERT INTO warranty_coverages (
  id, coverage_type, item_category, product_id, product_name, serial_number,
  branch_id, party_name, source_type, source_id, source_number,
  start_date_ad, start_date_bs, end_date_ad, end_date_bs, term_months, start_basis, is_demo
)
SELECT
  'wc-legacy-serial-' || s.id, 'VENDOR', 'CPE', s.product_id, COALESCE(s.product_name, ''),
  UPPER(TRIM(s.device_serial)), s.branch_id, pi.supplier_name,
  'PURCHASE_INVOICE', pi.id, pi.invoice_number,
  pi.invoice_date_ad,
  COALESCE((SELECT b.bs_date || ' BS' FROM bs_day_records b WHERE b.ad_date = pi.invoice_date_ad), 'BS not seeded'),
  (pi.invoice_date_ad + INTERVAL '12 months')::date,
  COALESCE((SELECT b.bs_date || ' BS' FROM bs_day_records b WHERE b.ad_date = (pi.invoice_date_ad + INTERVAL '12 months')::date), 'BS not seeded'),
  12, 'LEGACY_12_MONTH', s.is_demo
FROM serial_log s
JOIN purchase_invoices pi ON pi.id = s.source_id
WHERE s.source_type = 'PURCHASE'
  AND s.status <> 'RETURNED_TO_VENDOR'
  AND pi.invoice_date_ad IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM warranty_coverages w
    WHERE w.coverage_type = 'VENDOR'
      AND w.serial_number = UPPER(TRIM(s.device_serial))
      AND w.is_current = TRUE
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Scale fixture: 100k customers for the cheap baseline. The production design
-- target is millions of customers; the recorded 1M run is under docs/performance.
-- These indexes match the actual WHERE/ORDER BY shapes of the paged registers;
-- they do not replace the older branch/date indexes, which still serve reports.
-- ============================================================================

-- Customer directory: national name paging, branch+status paging and the
-- status-only national filter. The older (branch_id, name, id) index remains
-- the best choice when a branch is selected without a status filter.
CREATE INDEX IF NOT EXISTS idx_customer_records_name_all
  ON customer_records (customer_name, customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_records_branch_status_name
  ON customer_records (branch_id, status, customer_name, customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_records_status_name
  ON customer_records (status, customer_name, customer_id);

-- CUSTOMER_DEVICE_COUNT_SQL probes customer_code and customer_id. The existing
-- (customer_id, customer_code) index covers only the second arm; this gives the
-- planner an index for the customer_code arm too.
CREATE INDEX IF NOT EXISTS idx_customer_devices_customer_code
  ON customer_device_records (customer_code);

-- Sales invoice register: the contains-search is ORed over these two columns.
-- Two trigram indexes preserve that OR (a concatenated expression would match
-- across the column boundary and change results).
CREATE INDEX IF NOT EXISTS idx_sales_invoices_number_trgm
  ON sales_invoices USING gin (lower(invoice_number) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer_trgm
  ON sales_invoices USING gin (lower(customer_name) gin_trgm_ops);

-- Newest-first paged registers. A concrete branch uses the composite; a global
-- user uses the created_at-only index instead of sorting the whole table.
CREATE INDEX IF NOT EXISTS idx_sales_invoices_page_all
  ON sales_invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_branch_page
  ON sales_invoices (branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_page_all
  ON purchase_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_branch_page
  ON purchase_orders (branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_page_all
  ON purchase_invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_branch_page
  ON purchase_invoices (branch_id, created_at DESC);

-- Stock operations are read by branch OR destination warehouse. Both leading
-- columns need an index before the created_at page can be served without a sort.
CREATE INDEX IF NOT EXISTS idx_stock_ops_page_all
  ON stock_operations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ops_branch_page
  ON stock_operations (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ops_destination_page
  ON stock_operations (destination_warehouse_id, created_at DESC);

-- Transaction and audit logs are append-only and grow every day. Branch-scoped
-- reads get the composite; the global transaction read keeps its existing
-- timestamp index plus the id tie-breaker in the page order.
CREATE INDEX IF NOT EXISTS idx_txn_branch_time
  ON transaction_logs (branch_id, timestamp_ad DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_branch_timestamp
  ON audit_logs (branch_id, timestamp_ad DESC);

-- ---------------------------------------------------------------------------
-- Procurement / warranty dual-date parity (2026-11-07).
--
-- expected_delivery_date_ad and the warranty coverage span are business dates
-- too, so they persist their BS half like every finance date. Columns and
-- backfill are idempotent; NOT NULL / CHECK apply only where existing history
-- is clean. This block runs after the legacy warranty backfill above, so the
-- rows it inserted are covered by the backfill as well.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_delivery_date_bs VARCHAR(20);
  ALTER TABLE warranty_coverages ADD COLUMN IF NOT EXISTS start_date_bs VARCHAR(20);
  ALTER TABLE warranty_coverages ADD COLUMN IF NOT EXISTS end_date_bs VARCHAR(20);

  UPDATE purchase_orders po
  SET expected_delivery_date_bs = b.bs_date || ' BS'
  FROM bs_day_records b
  WHERE b.ad_date = po.expected_delivery_date_ad
    AND po.expected_delivery_date_ad IS NOT NULL
    AND (po.expected_delivery_date_bs IS NULL OR po.expected_delivery_date_bs = '');

  UPDATE warranty_coverages w
  SET start_date_bs = b.bs_date || ' BS'
  FROM bs_day_records b
  WHERE b.ad_date = w.start_date_ad
    AND (w.start_date_bs IS NULL OR w.start_date_bs = '');

  UPDATE warranty_coverages w
  SET end_date_bs = b.bs_date || ' BS'
  FROM bs_day_records b
  WHERE b.ad_date = w.end_date_ad
    AND (w.end_date_bs IS NULL OR w.end_date_bs = '');

  IF NOT EXISTS (SELECT 1 FROM purchase_orders WHERE expected_delivery_date_ad IS NOT NULL AND (expected_delivery_date_bs IS NULL OR expected_delivery_date_bs = '')) THEN
    ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_expected_delivery_bs_required;
    ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_expected_delivery_bs_required CHECK (expected_delivery_date_ad IS NULL OR (expected_delivery_date_bs IS NOT NULL AND expected_delivery_date_bs <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM warranty_coverages WHERE start_date_bs IS NULL OR start_date_bs = '') THEN
    ALTER TABLE warranty_coverages ALTER COLUMN start_date_bs SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM warranty_coverages WHERE end_date_bs IS NULL OR end_date_bs = '') THEN
    ALTER TABLE warranty_coverages ALTER COLUMN end_date_bs SET NOT NULL;
  END IF;
END $$;

-- ============================================================================
-- ACC-7: posted accounting ledgers are append-only
-- ============================================================================
-- A posted journal, its lines and its party subledger rows are the audit trail.
-- Correcting them in place destroys the evidence a later reader needs, so the
-- database itself refuses UPDATE and DELETE. The supported correction is a new
-- linked reversal journal (gl_journals.reversal_of_id) with its own posting
-- date; the original row remains visible.
--
-- The only bypass is the local GUC `inventory.allow_ledger_purge=on`, used by
-- (a) schema maintenance blocks above and (b) the test runner for fixture
-- cleanup. It is deliberately session/transaction-local: application code never
-- sets it, and the production connection path has no default for it.
CREATE OR REPLACE FUNCTION reject_posted_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('inventory.allow_ledger_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = format(
      '%s is append-only: posted rows cannot be changed with %s. Post a linked reversal journal instead.',
      TG_TABLE_NAME,
      TG_OP
    ),
    HINT = 'To remove test fixtures only, connect with options=-c inventory.allow_ledger_purge=on.';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_gl_journals_append_only
  BEFORE UPDATE OR DELETE ON gl_journals
  FOR EACH ROW EXECUTE FUNCTION reject_posted_ledger_mutation();

CREATE OR REPLACE TRIGGER trg_gl_journal_lines_append_only
  BEFORE UPDATE OR DELETE ON gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION reject_posted_ledger_mutation();

CREATE OR REPLACE TRIGGER trg_gl_subledger_entries_append_only
  BEFORE UPDATE OR DELETE ON gl_subledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_posted_ledger_mutation();

-- The snapshot records what was closed; it is evidence, not a working table.
-- A correction belongs in a linked reversal journal inside a reopened year,
-- then a fresh close, never in an UPDATE of the closed position.
CREATE OR REPLACE FUNCTION reject_fiscal_year_balance_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('inventory.allow_ledger_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = format(
      'fiscal_year_balances is immutable: a closed year cannot be changed with %s.',
      TG_OP
    ),
    HINT = 'Reopen the year, correct the ledger with a linked reversal journal, and close it again.';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_fiscal_year_balances_immutable
  BEFORE UPDATE OR DELETE ON fiscal_year_balances
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_year_balance_mutation();

-- ============================================================================
-- Monthly journal partitions: default catch-all and on-demand month creator
-- ============================================================================
CREATE TABLE IF NOT EXISTS gl_journals_default PARTITION OF gl_journals DEFAULT;
CREATE TABLE IF NOT EXISTS gl_journal_lines_default PARTITION OF gl_journal_lines DEFAULT;

CREATE OR REPLACE FUNCTION ensure_journal_month_partition(p_date DATE)
RETURNS void AS $$
DECLARE
  v_start DATE := date_trunc('month', p_date)::date;
  v_end DATE := (date_trunc('month', p_date) + INTERVAL '1 month')::date;
  v_suffix TEXT := to_char(p_date, 'YYYYMM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_journals FOR VALUES FROM (%L) TO (%L)',
    'gl_journals_' || v_suffix, v_start, v_end
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_journal_lines FOR VALUES FROM (%L) TO (%L)',
    'gl_journal_lines_' || v_suffix, v_start, v_end
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_gl_journal_registry()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO gl_journals_registry (id, journal_no, journal_date_ad)
    VALUES (NEW.id, NEW.journal_no, NEW.journal_date_ad);
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM gl_journals_registry WHERE id = OLD.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_gl_journal_line_registry()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO gl_journal_line_registry (id, journal_id, line_no, journal_date_ad)
    VALUES (NEW.id, NEW.journal_id, NEW.line_no, NEW.journal_date_ad);
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM gl_journal_line_registry WHERE id = OLD.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_gl_journals_registry_sync
  AFTER INSERT OR DELETE ON gl_journals
  FOR EACH ROW EXECUTE FUNCTION sync_gl_journal_registry();

CREATE OR REPLACE TRIGGER trg_gl_journal_lines_registry_sync
  AFTER INSERT OR DELETE ON gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION sync_gl_journal_line_registry();
