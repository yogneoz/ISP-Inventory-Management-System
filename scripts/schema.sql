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
    role VARCHAR(50) NOT NULL CHECK (role IN ('SUPER_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK', 'ACCOUNTANT', 'HEAD_OFFICE_ADMIN', 'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN', 'AUDITOR')),
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
    allowed_branch_ids TEXT[],
    status VARCHAR(30) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended', 'locked')),
    can_switch_user BOOLEAN DEFAULT FALSE,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

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
    is_demo BOOLEAN NOT NULL DEFAULT FALSE
);

-- Exactly one fiscal year may be flagged current (prevents the
-- ambiguous-default bug where two rows had is_current = TRUE).
DROP INDEX IF EXISTS uq_fiscal_years_single_current;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_years_single_current ON fiscal_years ((is_current)) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_fiscal_years_start_date ON fiscal_years(start_date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_fiscal_years_demo ON fiscal_years(id) WHERE is_demo = TRUE;

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
    rating NUMERIC(3, 1) DEFAULT 5.0,
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

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
-- 6. Products Table
-- ==========================================
CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(50) PRIMARY KEY,
    sku VARCHAR(100) UNIQUE NOT NULL,
    barcode VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100) NOT NULL,
    product_group VARCHAR(50) NOT NULL CHECK (product_group IN ('Product Item', 'Fixed Asset', 'Consumable Item')),
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
    placed_in_service_date_ad DATE,
    acquisition_cost NUMERIC(12, 2) NOT NULL,
    depreciation_method VARCHAR(50) DEFAULT 'STRAIGHT_LINE',
    depreciation_rate_percent NUMERIC(5, 2) DEFAULT 15.00,
    accumulated_depreciation NUMERIC(12, 2) DEFAULT 0.00,
    net_book_value NUMERIC(12, 2) NOT NULL,
    status VARCHAR(30) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISPOSED', 'WRITTEN_OFF', 'MAINTENANCE')),
    supplier_name VARCHAR(200),
    invoice_no VARCHAR(100),
    purchase_invoice_id VARCHAR(50),
    product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

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
    status VARCHAR(30) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'SENT', 'IN_PROGRESS', 'PURCHASED', 'RECEIVED', 'CANCELLED')),
    subtotal_amount NUMERIC(14, 2) DEFAULT 0.00,
    tax_amount NUMERIC(14, 2) DEFAULT 0.00,
    total_amount NUMERIC(14, 2) DEFAULT 0.00,
    notes TEXT,
    items JSONB DEFAULT '[]'::jsonb,
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
    change_type VARCHAR(50) NOT NULL CHECK (change_type IN ('INBOUND_PO', 'PURCHASE_INVOICE', 'STOCK_ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'DAMAGE', 'DAMAGE_REVERSED', 'DISPOSAL', 'PHYSICAL_AUDIT_EXCESS', 'PHYSICAL_AUDIT_SHORTAGE', 'PULLOUT', 'CONSUMABLE_ISSUE', 'STOCK_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'RETURN', 'TRANSFER_CANCELLED', 'TRANSFER_RECEIPT_CANCELLED')),
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
    assigned_devices_count INT DEFAULT 0,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

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
    status VARCHAR(30) NOT NULL DEFAULT 'IN_STOCK',
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

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
ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS created_by VARCHAR(150);
ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS updated_by VARCHAR(150);
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

-- Audit module enum: 'INVENTORY' is written by the serial-log upsert path
-- (server.ts SERIAL_LOG_UPSERT). Without it the insert is silently rejected
-- and serial-log audit events never reach the database.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_module_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_module_check CHECK (module IN (
  'AUTH', 'MASTER_DATA', 'PRODUCTS', 'CATEGORIES', 'PROCUREMENT', 'LOGISTICS',
  'STOCK_OPERATIONS', 'FIXED_ASSETS', 'CPE_MANAGEMENT', 'INVENTORY', 'INVENTORY_AUDIT',
  'OPERATIONS', 'BRANCH_OPERATIONS', 'FISCAL_YEAR', 'APPROVAL_WORKFLOW', 'SYSTEM'
));

-- Customer Records indexes
CREATE INDEX IF NOT EXISTS idx_customer_records_id ON customer_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_records_branch ON customer_records(branch_id);
CREATE INDEX IF NOT EXISTS idx_customer_records_contact ON customer_records(contact_number);
CREATE INDEX IF NOT EXISTS idx_customer_records_demo ON customer_records(id) WHERE is_demo = TRUE;

-- Customer Device Records indexes
CREATE INDEX IF NOT EXISTS idx_customer_devices_serials ON customer_device_records(device_serial, pon_serial, mac_address);
CREATE INDEX IF NOT EXISTS idx_customer_devices_customer ON customer_device_records(customer_id, customer_code);
CREATE INDEX IF NOT EXISTS idx_customer_devices_branch_status ON customer_device_records(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_issued_date ON customer_device_records(issued_date_ad);
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
