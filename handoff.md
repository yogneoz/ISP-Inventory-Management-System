# Project Handoff Document — IZone Enterprise ERP

> **Full project analysis, architecture, database relationships, and developer guide.**  
> Generated: 2026-09-10 | Version: 1.0

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture Overview](#3-architecture-overview)
4. [Directory Structure & File Map](#4-directory-structure--file-map)
5. [Database Schema & Relationships](#5-database-schema--relationships)
6. [API Endpoints Reference](#6-api-endpoints-reference)
7. [Authentication & Authorization](#7-authentication--authorization)
8. [Role-Based Access Control (RBAC)](#8-role-based-access-control-rbac)
9. [Frontend Architecture](#9-frontend-architecture)
10. [Key Business Flows](#10-key-business-flows)
11. [Utility Modules](#11-utility-modules)
12. [Configuration & Environment](#12-configuration--environment)
13. [Deployment](#13-deployment)
14. [Known Patterns & Design Decisions](#14-known-patterns--design-decisions)
15. [Quick Reference for New Developers](#15-quick-reference-for-new-developers)

---

## 1. Project Overview

**IZone Enterprise ERP** is a full-stack, multi-branch inventory management and enterprise resource planning system built specifically for **ISP/Fiber operations in Nepal**. It supports:

- Multi-branch inventory tracking with inter-branch stock transfers
- Purchase order → Invoice → Goods Receipt workflow
- Fixed asset register with depreciation (Straight Line, Declining Balance, WDV)
- Customer device (ONU/Router) tracking with PON serial, MAC address
- Physical stock audit & reconciliation with variance reports
- Nepali Bikram Sambat (BS) ↔ AD (Gregorian) dual-calendar system
- Fiscal year management with year-end closing wizard
- VAT purchase register and financial statements
- 5-step fiscal year closing wizard with IRD audit certificate
- Demo data seeding (is_demo flag system) vs. real production data
- Real-time SSE-based multi-user synchronization

---

## 2. Tech Stack

| Layer | Technology | Version |
|---|---|---|
| **Frontend** | React 19 + TypeScript | React 19.0.1, TS 5.8.2 |
| **Styling** | Tailwind CSS 4 | 4.1.14 |
| **UI Icons** | Lucide React | 0.546.0 |
| **Animations** | Motion (Framer) | 12.23.24 |
| **Build Tool** | Vite 6 | 6.2.3 |
| **Backend** | Node.js + Express | Express 4.21.2 |
| **Database** | PostgreSQL | 14+ (via `pg` 8.23.0) |
| **Language** | TypeScript (Full Stack) | 5.8.2 |
| **Dev Runtime** | tsx | 4.21.0 |
| **Bundler (server)** | esbuild | 0.25.0 |
| **Process Manager** | PM2 (production) | ecosystem.config.js |
| **Containerization** | Docker (multi-stage) | Dockerfile |

**No ORM is used** — all database queries are hand-written SQL via `pg.Pool` for maximum control and transparency.

---

## 3. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                        BROWSER CLIENT                              │
│  React 19 SPA (Vite dev server / static dist in production)       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ App.tsx   │  │ Feature  │  │Common UI │  │ services/api.ts  │  │
│  │ (Router)  │→ │ Views    │→ │Components│→ │ (fetch + SSE)    │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────┬─────────┘  │
│                                                       │            │
│  Session: localStorage (auth token, user, theme,      │            │
│           active tab, date mode, permissions matrix)  │            │
└───────────────────────────────────────────────────────┼────────────┘
                                                        │
                              HTTP (fetch) + SSE (/api/sync/stream)
                                                        │
┌───────────────────────────────────────────────────────┼────────────┐
│                    Express Server (server.ts)          │            │
│  ┌────────────────────────────────────────────────────┤            │
│  │ Middleware Pipeline (in order):                    │            │
│  │  1. authenticateUser  (JWT token → req.user)      │            │
│  │  2. Public route bypass                           │            │
│  │  3. requireAuth        (401 if no session)        │            │
│  │  4. requirePostgres    (503 if DB down)           │            │
│  │  5. enforceFiscalYearWriteAccess (423 on closed)  │            │
│  │  6. enforceOperationalPermissions (403 role gate) │            │
│  │  7. enforceBranchAccess    (403 branch scope)     │            │
│  └────────────────────────────────────────────────────┤            │
│  ┌──────────────────────────────────────────────────┐ │            │
│  │ API Route Handlers                               │ │            │
│  │  - /api/bootstrap (atomic 1-roundtrip sync)      │ │            │
│  │  - /api/auth/*    (login, setup, profile switch) │ │            │
│  │  - /api/products, /api/stock, /api/assets, etc. │ │            │
│  │  - /api/sync/stream (SSE real-time broadcast)    │ │            │
│  └──────────────────────────────────────────────────┘ │            │
│                          │                             │            │
│  ┌───────────────────────▼─────────────────────────┐  │            │
│  │ PostgreSQL Connection Pool (server/db.ts)       │  │            │
│  │  pg.Pool → pg (8.23.0)                         │  │            │
│  │  DATE columns parsed as plain 'YYYY-MM-DD'      │  │            │
│  └─────────────────────────────────────────────────┘  │            │
└───────────────────────────────────────────────────────────────────┘
```

**Key architectural decisions:**
- **Single bootstrap endpoint** (`GET /api/bootstrap`) returns ALL data in one roundtrip, filtered by `branchId` and `fiscalYearId` query params.
- **In-memory runtime mirrors** are hydrated from PostgreSQL on every request (for server-side logic like ID generation) and re-hydrated from DB after mutations.
- **SSE (Server-Sent Events)** for real-time sync: all connected clients get a `broadcastChange()` notification on any mutation, triggering a re-fetch.
- **Dual persistence**: In-memory arrays + PostgreSQL. PostgreSQL is the source of truth; in-memory is a server-request optimization cache.

---

## 4. Directory Structure & File Map

```
ISP-Inventory-Management-System/
├── server.ts                          # Main Express server (~2800+ lines)
│   ├── Auth (login, setup, profile switch, forgot-password)
│   ├── Bootstrap endpoint (1-roundtrip full state sync)
│   ├── All REST CRUD endpoints
│   ├── SSE real-time sync engine
│   ├── Middleware pipeline (auth, RBAC, branch scope, fiscal year write access)
│   └── Fiscal year closing wizard logic
│
├── server/
│   └── db.ts                          # PostgreSQL connection pool setup
│                                     #   - DATE type override (keep as 'YYYY-MM-DD')
│                                     #   - Pool creation from DATABASE_URL env
│                                     #   - Exported: pgPool, realPoolInstance
│
├── src/
│   ├── App.tsx                        # Root React component (~1100 lines)
│   │   ├── All state management (useState hooks)
│   │   ├── All action handlers (CRUD callbacks)
│   │   ├── Tab routing / navigation
│   │   ├── SSE subscription
│   │   ├── Bootstrap data hydration
│   │   ├── Keyboard shortcuts (Alt+B, Alt+S, Alt+D, Alt+H)
│   │   └── Badge calculations (low stock, pending POs, in-transit)
│   │
│   ├── main.tsx                       # ReactDOM.createRoot entry point
│   ├── index.css                      # Tailwind CSS v4 import + custom CSS vars
│   ├── vite-env.d.ts                  # Vite type declarations
│   │
│   ├── types/
│   │   └── index.ts                   # All TypeScript interfaces (~450 lines)
│   │       ├── CompanyProfile, User, UserRole, Supplier, Branch
│   │       ├── Product, Category, UnitOfMeasure
│   │       ├── InventoryStock, DamageRecord
│   │       ├── Asset (Fixed Asset), POLineItem, PurchaseOrder
│   │       ├── PurchaseInvoiceItem, PurchaseInvoice
│   │       ├── Shipment, ShipmentItem
│   │       ├── StockOperation, PulloutItem, SaleItem, ConsumableIssueItem
│   │       ├── CustomerDeviceRecord, CustomerRecord
│   │       ├── ApprovalRequest, FiscalYear
│   │       ├── AuditLog, TransactionLog, FinancialSummary
│   │       ├── LocationRecord, DocumentNumberConfig
│   │       └── BootstrapState (full sync payload type)
│   │
│   ├── services/
│   │   └── api.ts                     # Frontend API client (~900 lines)
│   │       ├── fetchJson()            # Core HTTP helper with auth headers
│   │       ├── subscribeToSyncStream() # SSE connection manager
│   │       ├── api.getBootstrapState() # Single atomic data fetch
│   │       ├── api.login()            # Auth endpoints
│   │       ├── api.createProduct()    # Product CRUD
│   │       ├── api.createStockOperation() # Stock operations
│   │       ├── api.createPurchaseOrder()  # Procurement
│   │       ├── api.receiveShipment()  # Shipment receiving with verification
│   │       ├── api.createAsset()      # Fixed asset management
│   │       ├── api.closeFiscalYear()  # Year-end closing wizard
│   │       └── ... all other CRUD methods
│   │
│   ├── utils/
│   │   ├── nepaliCalendar.ts          # BS ↔ AD calendar conversion engine
│   │   │   ├── seedBSYearCalendar()   # Seeds year data into client-side lookup
│   │   │   ├── adToBS()               # Converts AD date to BS date
│   │   │   ├── bsToAD()               # Converts BS date to AD date
│   │   │   ├── getDaysInMonthBS()     # Days in a BS month
│   │   │   └── BS year data: 2078–2085
│   │   │
│   │   ├── depreciation.ts            # Fixed asset depreciation calculator
│   │   │   ├── calculateFixedAssetValues()
│   │   │   └── Supports: STRAIGHT_LINE, REDUCING_BALANCE, DECLINING_BALANCE, WRITTEN_DOWN_VALUE
│   │   │
│   │   ├── documentNumbering.ts       # Auto document number generation
│   │   │   ├── generateNextDocumentNumber()
│   │   │   └── Configurable: PO, PI, GRN, DN, INV, QUO, CN, ST, SA, DC, CPI, EXC, WC, FAA, FAR, JV, PV, RV
│   │   │
│   │   ├── permissions.ts             # RBAC permissions engine
│   │   │   ├── DEFAULT_PERMISSIONS_MATRIX  # 40+ permission keys × 9 roles
│   │   │   ├── isOperationAllowed()
│   │   │   ├── canUserSeeAllBranches()
│   │   │   ├── getAllowedBranchIds()
│   │   │   └── savePermissionsMatrix() → localStorage
│   │   │
│   │   ├── sessionCache.ts            # Client-side session persistence
│   │   │   ├── saveUserSession() / loadUserSession() / clearUserSession()
│   │   │   └── saveRecentBootstrapCache() / loadRecentBootstrapCache() (instant 0ms UI load)
│   │   │
│   │   ├── warranty.ts               # Warranty status calculator
│   │   │   └── getWarrantyInfo() → VALID / EXPIRING_SOON / EXPIRED
│   │   │
│   │   ├── exportUtils.ts            # CSV/Excel export helpers
│   │   └── logoImage.ts             # Default logo image constants
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx            # Top bar: profile switch, notifications, date mode, search
│   │   │   └── Sidebar.tsx           # Left navigation rail with 25+ menu items
│   │   │
│   │   └── common/
│   │       ├── LoginModal.tsx         # Super Admin first-launch setup & login
│   │       ├── ProfileSwitchModal.tsx # Impersonate/switch user profiles
│   │       ├── NotificationCenter.tsx # Audit event feed
│   │       ├── GlobalSearchModal.tsx  # Ctrl+K global search
│   │       ├── BarcodeScannerModal.tsx # Alt+B barcode scanner
│   │       ├── DatabaseSetupBanner.tsx # DB connection status banner
│   │       ├── ClearDemoDataView.tsx  # Admin: delete is_demo=TRUE rows
│   │       ├── TablePagination.tsx    # Reusable pagination component
│   │       └── HelpDocumentation.tsx  # In-app help center
│   │
│   └── features/
│       ├── dashboard/
│       │   └── Dashboard.tsx          # KPI cards, charts, recent activity
│       │
│       ├── inventory/
│       │   ├── ProductManagement.tsx   # Product catalog CRUD
│       │   ├── BranchStockTracking.tsx # Per-branch stock levels
│       │   ├── ReorderStockTracking.tsx # Low stock alerts & reorder
│       │   ├── DamagedStockTracking.tsx # Damage records lifecycle
│       │   ├── StockOperations.tsx     # Stock out, pullout, consumable issue, manual adjust
│       │   ├── StockMovementLedger.tsx # Full transaction history log
│       │   ├── StockValuation.tsx      # Inventory value reports
│       │   ├── PhysicalStockAudit.tsx  # Physical count & variance reconciliation
│       │   ├── CategoryManagement.tsx  # Product category CRUD
│       │   ├── UomManagement.tsx       # Unit of Measure CRUD
│       │   ├── WarrantyProducts.tsx    # Device warranty tracking
│       │   ├── ImportStock.tsx         # CSV import of stock data
│       │   ├── ExportStock.tsx         # CSV/Excel export of stock
│       │   └── ProductSearchBar.tsx    # Reusable product search component
│       │
│       ├── procurement/
│       │   ├── SuppliersManagement.tsx # Supplier directory CRUD
│       │   ├── PurchaseOrders.tsx      # PO creation with line items
│       │   ├── PurchaseInvoices.tsx    # Supplier invoices with device serials
│       │   ├── ReceiveInboundWarehouse.tsx # Goods receipt with serial verification
│       │   └── Shipments.tsx           # Inter-branch shipments
│       │
│       ├── sales/
│       │   ├── CustomerMasterDirectory.tsx  # Customer directory CRUD
│       │   ├── CustomersManagement.tsx      # Device assignment to customers
│       │   └── ImportCustomers.tsx          # CSV import of customers
│       │
│       ├── finance/
│       │   ├── FixedAssetRegister.tsx       # Fixed assets & depreciation
│       │   ├── FinancialStatements.tsx      # Income statement, balance sheet, trial balance
│       │   ├── VatRegister.tsx              # VAT purchase register
│       │   ├── DepreciationRegister.tsx     # Depreciation schedule reports
│       │   ├── FiscalYearManagement.tsx     # Fiscal year CRUD
│       │   ├── NepaliFiscalManagement.tsx   # BS fiscal year settings
│       │   ├── FiscalYearClosingWizard.tsx  # 5-step year-end closing wizard
│       │   ├── OpeningStockManager.tsx      # Opening stock balances per fiscal year
│       │   ├── BsCalendarUtility.tsx        # BS calendar seeding & lookup
│       │   └── AuditTrailReports.tsx        # Audit log reports & CSV export
│       │
│       └── settings/
│           ├── BranchesManagement.tsx       # Branch CRUD
│           ├── CompanySetupManagement.tsx   # Company profile (logo, PAN, address)
│           ├── UsersManagement.tsx          # User CRUD with role assignment
│           ├── PermissionManagement.tsx     # Permissions matrix editor
│           ├── ApprovalWorkflowCenter.tsx   # Multi-tier approval workflow
│           ├── LocationsManagement.tsx      # Physical locations CRUD
│           └── DataRecalculationMaintenance.tsx # Admin: recalculate stock & assets
│
├── scripts/
│   ├── schema.sql                     # Full PostgreSQL schema (26 tables)
│   ├── setup_db.js                    # Node.js database migration runner
│   ├── setup_postgres.sh              # Shell: auto-install & configure PostgreSQL
│   ├── demo_dataset.js                # Demo data seeder (is_demo=TRUE)
│   ├── integrity_check.mjs            # Database integrity verification
│   └── reset_fresh_demo.mjs           # Full reset & re-seed script
│
├── package.json                       # Project manifest
├── tsconfig.json                      # TypeScript configuration
├── vite.config.ts                     # Vite build config with manual chunks
├── ecosystem.config.js                # PM2 production process manager config
├── Dockerfile                         # Multi-stage Docker build
├── UPDATEPROCESS.md                   # Update/change log
└── USER_MANUAL.md                     # End-user documentation
```

---

## 5. Database Schema & Relationships

### 5.1 Tables Overview (26 tables)

| # | Table | Purpose | Key Columns |
|---|---|---|---|
| 1 | `branches` | Branch/warehouse master | id (PK), code (UNIQUE), name, is_headquarters, is_demo |
| 2 | `users` | User accounts | id (PK), email (UNIQUE), password, role, branch_id (FK→branches) |
| 3 | `fiscal_years` | Fiscal year periods | id (PK), code (UNIQUE), start_date_ad, end_date_ad, is_current, is_closed |
| 4 | `suppliers` | Supplier directory | id (PK), supplier_code (UNIQUE), name, pan_vat_number |
| 5 | `categories` | Product categories | id (PK), name (UNIQUE), code (UNIQUE) |
| 6 | `products` | Product catalog | id (PK), sku (UNIQUE), product_group, depreciation_method, depreciation_rate |
| 7 | `inventory_stock` | Per-branch stock levels | id (PK), product_id (FK→products), branch_id (FK→branches), quantity_on_hand |
| 8 | `damage_records` | Damage lifecycle tracking | id (PK), product_id (FK→products), branch_id (FK→branches), status, fiscal_year_id (FK→fiscal_years) |
| 9 | `fixed_assets` | Fixed asset register | id (PK), tag_number (UNIQUE), product_id (FK→products), branch_id (FK→branches), depreciation_method |
| 10 | `purchase_orders` | Purchase orders | id (PK), po_number (UNIQUE), branch_id (FK→branches), items (JSONB), fiscal_year_id (FK→fiscal_years) |
| 11 | `purchase_invoices` | Supplier invoices | id (PK), invoice_number (UNIQUE), branch_id (FK→branches), items (JSONB), fiscal_year_id (FK→fiscal_years) |
| 11b | `vendor_payments` | Vendor payments sub-ledger | id (PK), payment_number (UNIQUE), supplier_id (FK→suppliers), invoice_id (FK→purchase_invoices), branch_id (FK→branches), amount, payment_method, bank_name, cheque_number, status (POSTED/REVERSED/VOIDED), reversal_reason, fiscal_year_id (FK→fiscal_years) |
| 12 | `shipments` | Inter-branch transfers | id (PK), tracking_code (UNIQUE), source_branch_id (FK→branches), destination_branch_id (FK→branches), items (JSONB) |
| 13 | `stock_operations` | Stock movements | id (PK), reference_number (UNIQUE), branch_id (FK→branches), product_id (FK→products), type, items (JSONB) |
| 14 | `fiscal_year_opening_stock` | Year opening balances | id (PK), fiscal_year_id (FK→fiscal_years), product_id (FK→products), branch_id (FK→branches) |
| 15 | `audit_logs` | Complete audit trail | id (PK), user_email, module, action, branch_id (FK→branches), fiscal_year_id (FK→fiscal_years) |
| 16 | `transaction_logs` | Stock change log | id (PK), product_id (FK→products), branch_id (FK→branches), change_type, quantity_before/changed/after |
| 17 | `customer_records` | Customer directory | id (PK), customer_id (UNIQUE), branch_id (FK→branches) |
| 18 | `customer_device_records` | CPE/device assignments | id (PK), customer_id, branch_id (FK→branches), device_serial, pon_serial, status |
| 19 | `approval_requests` | Multi-tier approvals | id (PK), request_number (UNIQUE), type, branch_id (FK→branches), status |
| 20 | `bs_calendar_years` | BS year metadata | year_bs (PK), days_in_months (INT[]), start_ad |
| 21 | `bs_day_records` | Day-by-day BS↔AD map | ad_date (PK), bs_date, fiscal_year_id (FK→fiscal_years) |
| 22 | `uom` | Units of measure | id (PK), name (UNIQUE), symbol, type |
| 23 | `locations` | Physical locations | id (PK), branch_id (FK→branches), type (POP_SERVER_ROOM, WAREHOUSE, etc.) |
| 24 | `company_profile` | Company master data | id (PK), name, pan_vat_number, logo_url, default_tax_rate |
| 25 | `document_number_configs` | Auto-numbering rules | id (PK), document_type, prefix, next_number, reset_every_fiscal_year |

### 5.2 Entity Relationship Diagram (Text)

```
                          ┌─────────────────┐
                          │  company_profile │ (singleton row)
                          └─────────────────┘

┌──────────────────────┐
│    fiscal_years       │◄──────────────────────────────────────────┐
│ (is_current, is_closed)│                                          │
└──────────┬───────────┘                                            │
           │                                                        │
           │ FK fiscal_year_id                                      │
           ▼                                                        │
┌──────────────────────────────────────────────────────────────┐    │
│                     TRANSACTIONAL TABLES                      │    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  │    │
│  │ purchase_orders  │  │purchase_invoices│  │  shipments    │  │    │
│  │ items: JSONB     │  │ items: JSONB    │  │ items: JSONB  │  │    │
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘  │    │
│           │                    │                    │          │    │
│  ┌────────┴────────────────────┴────────────────────┴───────┐ │    │
│  │              stock_operations (items: JSONB)             │ │    │
│  └──────────────────────────────────────────────────────────┘ │    │
│  ┌──────────────────────┐  ┌───────────────────────────────┐  │    │
│  │  audit_logs           │  │  transaction_logs             │  │    │
│  └──────────────────────┘  └───────────────────────────────┘  │    │
│  ┌──────────────────────┐  ┌───────────────────────────────┐  │    │
│  │  damage_records       │  │  fiscal_year_opening_stock    │  │    │
│  └──────────────────────┘  └───────────────────────────────┘  │    │
│  ┌───────────────────────────────┐                            │    │
│  │   customer_device_records     │                            │    │
│  └───────────────────────────────┘                            │    │
│  ┌───────────────────────────────┐                            │    │
│  │   approval_requests           │                            │    │
│  └───────────────────────────────┘                            │    │
└──────────────────────────────────────────────────────────────┘    │
           │                                                        │
           │ FK branch_id, product_id                               │
           ▼                                                        │
┌──────────────────────────────────────────────────────────────┐    │
│                     MASTER DATA TABLES                        │    │
│  ┌─────────────┐   ┌───────────┐   ┌──────────────────┐      │    │
│  │  branches    │   │ products   │   │  fixed_assets     │      │    │
│  │  (id, code)  │   │ (sku,pk)  │   │  (tag_number UK)  │      │    │
│  └──────┬──────┘   └─────┬─────┘   │  depreciation_    │      │    │
│         │                 │         │  method/rate      │      │    │
│         │                 ▼         └──────────────────┘      │    │
│         │        ┌────────────────┐                            │    │
│         │        │inventory_stock  │ ← UNIQUE(product_id,      │    │
│         │        │(per branch)     │   branch_id)              │    │
│         │        └────────────────┘                            │    │
│         │                                                      │    │
│  ┌──────┴──────────────┐  ┌──────────────┐  ┌──────────────┐  │    │
│  │  customer_records    │  │  suppliers    │  │  categories   │  │    │
│  └─────────────────────┘  └──────────────┘  └──────────────┘  │    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │    │
│  │  locations     │  │  uom          │  │  bs_day_records      │  │    │
│  └──────────────┘  └──────────────┘  │  bs_calendar_years    │  │    │
│                                       └──────────────────────┘  │    │
│  ┌───────────────────────────┐  ┌───────────────────────────┐  │    │
│  │  document_number_configs   │  │  users                     │  │    │
│  └───────────────────────────┘  └───────────────────────────┘  │    │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3 Key Foreign Key Relationships

```
branches.id ←─┐
              ├─ users.branch_id
              ├─ inventory_stock.branch_id
              ├─ fixed_assets.branch_id
              ├─ purchase_orders.branch_id
              ├─ purchase_invoices.branch_id
              ├─ shipments.source_branch_id
              ├─ shipments.destination_branch_id
              ├─ stock_operations.branch_id
              ├─ stock_operations.destination_warehouse_id
              ├─ customer_records.branch_id
              ├─ customer_device_records.branch_id
              ├─ approval_requests.branch_id
              ├─ locations.branch_id
              ├─ audit_logs.branch_id
              └─ bs_day_records.fiscal_year_id (→ fiscal_years)

products.id ←─┐
              ├─ inventory_stock.product_id  (ON DELETE CASCADE)
              ├─ fixed_assets.product_id      (ON DELETE SET NULL)
              ├─ stock_operations.product_id  (ON DELETE SET NULL)
              ├─ transaction_logs.product_id  (ON DELETE SET NULL)
              └─ damage_records.product_id    (ON DELETE CASCADE)

fiscal_years.id ←─┐
                  ├─ purchase_orders.fiscal_year_id
                  ├─ purchase_invoices.fiscal_year_id
                  ├─ shipments.fiscal_year_id
                  ├─ stock_operations.fiscal_year_id
                  ├─ customer_device_records.fiscal_year_id
                  ├─ approval_requests.fiscal_year_id
                  ├─ damage_records.fiscal_year_id
                  ├─ audit_logs.fiscal_year_id
                  ├─ transaction_logs.fiscal_year_id
                  ├─ fiscal_year_opening_stock.fiscal_year_id
                  └─ bs_day_records.fiscal_year_id

customers.customer_id (not a FK, application-level link to customer_device_records)
```

### 5.4 The `is_demo` Flag System

Every operational table has an `is_demo BOOLEAN NOT NULL DEFAULT FALSE` column:
- `npm run setup:pg` seeds demo data with `is_demo = TRUE`
- The **Clear Demo Data** admin action (`POST /api/admin/clear-demo-data`) only deletes rows where `is_demo = TRUE`
- Real production data (`is_demo = FALSE`) is never touched by demo cleanup
- Users, branches, and fiscal years are never deleted during demo cleanup

### 5.5 JSONB Document Columns

These tables store line items as JSONB arrays rather than normalized child tables:

| Table | JSONB Column | Structure |
|---|---|---|
| `purchase_orders` | `items` | `[{id, productId, productName, sku, quantity, unitPrice, taxRate, subtotal, taxAmount, total}]` |
| `purchase_invoices` | `items` | Same as PO + `deviceSerials: [{deviceSerial, ponSerial, macAddress}]` |
| `shipments` | `items` | `[{id, productId, productName, sku, quantitySent, quantityReceived, deviceSerials}]` |
| `stock_operations` | `items` | Mixed: PulloutItem[] or ConsumableIssueItem[] or SaleItem[] |

---

## 6. API Endpoints Reference

### 6.1 Public Endpoints (No Auth Required)

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/db/status` | PostgreSQL connection status + table count |
| `GET` | `/api/auth/setup-status` | First-launch detection (has Super Admin?) |
| `POST` | `/api/auth/setup-superadmin` | Create initial Super Admin account |
| `POST` | `/api/auth/forgot-password` | Password reset request (admin notification) |
| `POST` | `/api/auth/login` | Email + password → JWT token |

### 6.2 Authenticated Endpoints

| Method | Endpoint | Purpose | RBAC |
|---|---|---|---|
| `GET` | `/api/auth/me` | Get current user | Any authenticated |
| `POST` | `/api/auth/switch-profile` | Switch to another user profile | canSwitchUser=true |
| `PUT` | `/api/auth/profile` | Update own profile | Any authenticated |
| `GET` | `/api/bootstrap` | **Full atomic data sync** (1 roundtrip) | Any authenticated |
| `GET` | `/api/sync/stream` | SSE real-time event stream | Any authenticated |
| `GET` | `/api/sync/version` | Current data version | Any authenticated |

### 6.3 Master Data CRUD

| Endpoint | Methods | Scope |
|---|---|---|
| `/api/branches` | GET, POST | Branches master |
| `/api/branches/:id` | PUT, DELETE | |
| `/api/suppliers` | GET, POST | Supplier directory |
| `/api/suppliers/:id` | PUT, DELETE | |
| `/api/users` | GET, POST | User management |
| `/api/users/:id` | PUT, DELETE | |
| `/api/users/:id/reset-password` | POST | Password reset |
| `/api/products` | GET, POST | Product catalog |
| `/api/products/:id` | PUT, DELETE | |
| `/api/categories` | GET, POST | Product categories |
| `/api/categories/:id` | PUT, DELETE | |
| `/api/uom` | GET, POST | Units of measure |
| `/api/uom/:id` | PUT, DELETE | |
| `/api/locations` | GET, POST | Physical locations |
| `/api/locations/:id` | PUT, DELETE | |
| `/api/company-profile` | GET, PUT | Company settings |
| `/api/document-number-configs` | GET, PUT | Auto-numbering rules |

### 6.4 Operational Endpoints

| Endpoint | Methods | Purpose |
|---|---|---|
| `/api/stock` | GET | Branch-scoped stock levels |
| `/api/stock/:id` | PATCH | Update stock level + auto-transaction log |
| `/api/stock/:id/reorder-level` | PATCH | Update reorder threshold |
| `/api/assets` | GET, POST | Fixed asset register |
| `/api/assets/:id` | PUT, DELETE | |
| `/api/purchase-orders` | GET, POST | Purchase order management |
| `/api/purchase-orders/:id` | PUT, DELETE | |
| `/api/purchase-orders/:id/status` | PATCH | Status workflow transitions |
| `/api/purchase-invoices` | GET, POST | Supplier invoice management |
| `/api/purchase-invoices/:id` | DELETE | |
| `/api/purchase-invoices/:id/payment` | POST | Record partial payment |
| `/api/purchase-invoices/:id/payments` | GET | Payment history for one invoice (vendor_payments sub-ledger) |
| `/api/purchase-invoices/:id/reverse-payments` | POST | Reverse ALL posted payments of a fully paid invoice in one audited action (restores it to UNPAID; requires a reason) |
| `/api/vendor-payments` | GET, POST | Vendor payments sub-ledger (bank details, cheque, dated) |
| `/api/vendor-payments/:id/reverse` | POST | Reverse a posted payment (restores invoice balance) |
| `/api/vendors/:supplierId/ledger` | GET | Vendor ledger report (debit/credit/running balance) |
| `/api/shipments` | GET, POST | Inter-branch transfers |
| `/api/shipments/:id/receive` | POST | Receive + verify incoming shipment |
| `/api/shipments/:id/cancel-receive` | POST | Cancel received shipment |
| `/api/stock-operations` | GET, POST | Stock out, pullout, damage, consumable issue |
| `/api/stock-operations/:id/receive` | POST | Receive dispatched stock operation |
| `/api/customer-devices` | GET, POST | CPE device tracking |
| `/api/customer-devices/:id` | PUT | Update device status |
| `/api/customers` | GET, POST | Customer directory |
| `/api/customers/:id` | PUT, DELETE | |
| `/api/damage-records` | GET, POST | Damage lifecycle |
| `/api/damage-records/:id` | PUT | Update damage status |
| `/api/approval-requests` | GET, POST | Approval workflow |
| `/api/approval-requests/:id/process` | POST | Approve/reject request |
| `/api/approval-requests/:id/cancel` | POST | Cancel pending request |

### 6.5 Fiscal Year Endpoints

| Endpoint | Methods | Purpose |
|---|---|---|
| `/api/fiscal-years` | GET, POST | Fiscal year CRUD |
| `/api/fiscal-years/:id` | PUT, DELETE | |
| `/api/fiscal-years/:id/set-current` | POST | Set as active fiscal year |
| `/api/fiscal-years/:id/close` | POST | **5-step closing wizard** |
| `/api/fiscal-years/:id/reopen` | POST | Reopen closed year |
| `/api/fiscal-years/:id/opening-stock` | POST | Initialize opening balances |
| `/api/bs-calendar/years` | GET, POST | BS calendar year data |
| `/api/bs-calendar/years/:year` | DELETE | Delete BS year |

### 6.6 Admin Endpoints

| Endpoint | Methods | Purpose |
|---|---|---|
| `/api/admin/clear-demo-data` | POST | Delete is_demo=TRUE rows |
| `/api/admin/recalculate/fixed-assets` | POST | Recompute depreciation values |
| `/api/admin/recalculate/live-stock` | POST | Recompute stock from transaction history |

### 6.7 Request Headers

| Header | Purpose |
|---|---|
| `Authorization: Bearer <token>` | JWT auth token |
| `x-fiscal-year-id` | Fiscal year view context (filters data in bootstrap) |

---

## 7. Authentication & Authorization

### 7.1 Authentication Flow

```
┌──────────┐      POST /api/auth/login       ┌──────────┐
│  Browser  │ ──────────────────────────────→  │  Server  │
│           │  { email, password }             │          │
│           │ ←────────────────────────────── │          │
│           │  { user, token }                 │          │
│           │                                  │          │
│           │  Token: base64url(payload).      │          │
│           │         hmac-sha256(payload)     │          │
│           │  Payload: {sub, email, role,     │          │
│           │    branchId, allowedBranchIds,   │          │
│           │    canSwitchUser, exp}           │          │
└──────────┘                                  └──────────┘
```

- **Password hashing**: `scrypt` with random 16-byte salt → stored as `scrypt$<salt>$<derived_key_hex>`
- **Token**: Custom HMAC-signed JWT-like token (not standard JWT library), 8-hour TTL
- **Token verification**: HMAC-SHA256 signature validation + expiry check
- **Plaintext fallback**: Legacy passwords stored as plaintext are auto-upgraded to scrypt on successful login

### 7.2 Authorization Chain

Every `/api/*` request passes through this middleware chain in order:

1. **`authenticateUser`** — Extracts token from `Authorization: Bearer <token>`, decodes → `req.user`
2. **`requireAuth`** — Rejects 401 if `req.user` is missing (except public routes)
3. **`requirePostgres`** — Returns 503 if PostgreSQL is unavailable (except `/api/db/status`)
4. **`enforceFiscalYearWriteAccess`** — Returns 423 if mutating a closed fiscal year (only SUPER_ADMIN and INVENTORY_MANAGER can)
5. **`enforceOperationalPermissions`** — Maps URL path prefixes to allowed roles, returns 403 if mismatch
6. **`enforceBranchAccess`** — Ensures the user is authorized for the branch they're accessing/creating

---

## 8. Role-Based Access Control (RBAC)

### 8.1 Roles (9 defined in database constraint)

| Role | Description | Branch Access |
|---|---|---|
| `SUPER_ADMIN` | Full system access, all branches | ALL |
| `HEAD_OFFICE_ADMIN` | HQ admin, branch management | ALL (if allowedBranchIds set) |
| `INVENTORY_MANAGER` | Inventory, products, stock, assets | ALL |
| `BRANCH_MANAGER` | Branch-scoped operations | Single branch |
| `FRONT_DESK` | Customer-facing operations, stock out | Single branch |
| `ACCOUNTANT` | Financials, invoices, payments | Single branch |
| `PROCUREMENT_OFFICER` | POs, invoices, receiving | Single branch |
| `FIELD_TECHNICIAN` | Field operations | Single branch |
| `AUDITOR` | Read-only audit access | Single branch |

### 8.2 Permissions Matrix (40+ permission keys)

Key permission groups:
- **Procurement**: `po-create`, `po-receive`, `inv-create`, `inv-pay`, `po-delete`, `inv-delete`
- **Warehouse**: `shipment-create`, `wh-receive-pullouts`, `wh-restrict-transfer`, `shipment-history`
- **Branch Ops**: `branch-transfer-create`, `branch-transfer-receive`, `branch-pullout-dispatch`, `branch-damage-mark`, `stock-disposal-writeoff`, `stock-out`
- **Inventory**: `prod-view`, `prod-edit`, `uom-manage`, `category-manage`, `stock-import-export`, `opening-stock-view/edit`
- **Financials**: `assets-manage`, `fin-statements`, `vat-register`, `stock-valuation`
- **Admin**: `auth-switch-user`, `workflow-approval`, `admin-users`, `admin-branches`, `admin-audit`, `admin-fiscal`

**Storage**: Permissions matrix is stored in `localStorage` (`izone_permissions_matrix`) and can be customized per-installation via the Permission Management UI.

---

## 9. Frontend Architecture

### 9.1 State Management

**No Redux/Zustand** — all state lives in `App.tsx` via React `useState` hooks:

```
App.tsx (root)
├── Auth state: currentUser, rootUser, token
├── Navigation: activeTab, selectedBranchId, selectedFiscalYearId
├── UI state: isDarkMode, dateMode (BS/AD), searchQuery, modals
├── Data state (all from bootstrap):
│   ├── branches, products, stock, assets
│   ├── purchaseOrders, purchaseInvoices, shipments
│   ├── stockOperations, damageRecords
│   ├── customerDevices, customers, approvalRequests
│   ├── fiscalYears, auditLogs, transactionLogs
│   ├── suppliers, users, categories, locations
│   └── companyProfile, financialSummary, postgresStatus
└── Action handlers (all call api.* then refreshAllData())
```

### 9.2 Data Flow Pattern

```
1. User action (button click)
2. Handler calls api.createXxx(data) → HTTP POST to server
3. Server writes to PostgreSQL + updates in-memory mirror
4. Server calls broadcastChange() → SSE to all clients
5. Client SSE listener calls refreshAllData()
6. refreshAllData() calls api.getBootstrapState(branchId, fiscalYearId)
7. Server returns filtered data → client updates all useState
8. UI re-renders with fresh data
```

**Key optimization**: `saveRecentBootstrapCache()` / `loadRecentBootstrapCache()` stores the last bootstrap in `localStorage` for instant 0ms load on revisit (then refreshes in background).

### 9.3 Tab-Based Navigation

The `Sidebar` component defines `NAV_TABS` — a list of ~25 navigation entries organized into groups:
- Dashboard
- **Inventory**: Products, Stock, Reorder, Damage, Stock Operations, Ledger, Audit, Valuation, Import/Export, Categories, UOM, Warranty
- **Procurement**: Suppliers, POs, Invoices, Inbound Receiving, Shipments
- **Sales**: Customer Directory, Customer Devices, Import Customers
- **Finance**: Fixed Assets, Financial Statements, VAT Register, Depreciation, Fiscal Years, BS Calendar, Audit Trail, Opening Stock
- **Settings**: Branches, Users, Permissions, Approvals, Company Setup, Locations, Data Recalculation, Clear Demo Data

### 9.4 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt + B` | Toggle barcode scanner modal |
| `Alt + S` or `Ctrl + K` | Toggle global search |
| `Alt + D` | Toggle BS/AD date mode |
| `Alt + H` | Open help documentation |

---

## 10. Key Business Flows

### 10.1 Purchase Order → Invoice → Goods Receipt

```
Create PO (DRAFT)
    ↓ Approve
PO (APPROVED)
    ↓ Send to supplier
PO (SENT)
    ↓ Create Purchase Invoice
Invoice (UNPAID) ──→ Auto-provisions device serials as IN_STOCK
    ↓ Record Payment (partial/full)
Invoice (PAID)
    ↓ Create Shipment from PO items
Shipment (IN_TRANSIT)
    ↓ Receive with verification (quantity, serial check)
Shipment (RECEIVED) → Stock levels auto-increment
```

### 10.2 Inter-Branch Transfer

```
Source Branch creates Shipment (type=INTER_BRANCH)
    ↓ Status: DISPATCHED → IN_TRANSIT
Destination Branch receives with verification
    ↓ Stock deducted from source, added to destination
Shipment (RECEIVED)
    → OR if discrepancy: Shipment (DISCREPANCY)
```

### 10.3 Fixed Asset Lifecycle

```
Product created with productGroup='Fixed Asset'
    ↓ Create Purchase Invoice with device serials
    ↓ Create Fixed Asset (tag_number, acquisition_cost, depreciation_method)
    ↓ Depreciation runs from placed_in_service_date_ad
    ↓ Net Book Value = AcquisitionCost - AccumulatedDepreciation
    ↓ Disposal: status → DISPOSED, NBV → 0
```

### 10.4 Physical Stock Audit

```
Start Audit (select branch)
    ↓ Enter physical count per product
    ↓ System calculates: Variance = Physical Count - System Count
    ↓ User provides reason for variance
    ↓ Approve reconciliation
    → SHORTAGE: Stock decremented, transaction logged
    → EXCESS: Stock incremented, transaction logged
    → CSV export of audit record
```

### 10.5 Fiscal Year Closing Wizard (5 Steps)

```
Step 1: Final Inventory Valuation
    ↓ Calculate total inventory value at year-end
Step 2: Fixed Asset Depreciation Posting
    ↓ Run depreciation for all active assets
Step 3: Trial Balance Roll-Forward
    ↓ Generate opening balances for next year
Step 4: Fiscal Year Close
    ↓ Lock the year (is_closed = TRUE)
    ↓ Super Admin authorization required
Step 5: IRD Audit Certificate
    ↓ Download official closing certificate
```

### 10.6 Customer Device (CPE) Management

```
Purchase Invoice with deviceSerials → creates IN_STOCK records
    ↓ Assign device to customer
Device status: ACTIVE (with customer)
    ↓ Customer disconnects / returns
Device status: DISCONNECTED / RETURNED / REFUND
    ↓ Approval workflow for status changes
Device status change approved → stock re-stocked if restock_qty_on_approval
```

---

## 11. Utility Modules

### 11.1 `utils/nepaliCalendar.ts`

- **`seedBSYearCalendar(yearBS, daysInMonths, startAD)`** — Seeds a BS year into the client-side calendar lookup engine
- **`adToBS(adDate)`** — Converts AD date string to BS date string
- **`bsToAD(bsDate)`** — Converts BS date string to AD date string
- Built-in data for BS years 2078–2085, extendable via BS Calendar Utility admin screen
- Server-side: `bs_day_records` table provides the authoritative day-by-day mapping

### 11.2 `utils/depreciation.ts`

```typescript
calculateFixedAssetValues({
  acquisitionCost,
  acquisitionDateAD,
  asOfDateAD,
  depreciationMethod,  // STRAIGHT_LINE | REDUCING_BALANCE | DECLINING_BALANCE | WRITTEN_DOWN_VALUE
  depreciationRatePercent,
  accumulatedDepreciation,
  netBookValue,
})
→ { acquisitionCost, annualDepreciation, accumulatedDepreciation, netBookValue }
```

- **Straight Line**: `AccDep = Cost × Rate × MonthsElapsed / (100 × 12)`
- **Reducing Balance / Declining Balance / WDV**: `AccDep = Cost × (1 - (1 - Rate/100)^YearsElapsed)`

### 11.3 `utils/documentNumbering.ts`

- Generates sequential document numbers with configurable prefix, suffix, min digits
- Format: `{prefix}{zero-padded-number}{suffix}` (e.g., `PO-2081-1001`)
- Supports fiscal-year reset (`resetEveryFiscalYear: true`)
- 18 document types: PO, PI, GRN, DN, INV, QUO, CN, ST, SA, DC, CPI, EXC, WC, FAA, FAR, JV, PV, RV

### 11.4 `utils/permissions.ts`

- `DEFAULT_PERMISSIONS_MATRIX` — 40+ permission keys × 9 roles
- `isOperationAllowed(opId, userRole, allowBranchProcurement)` — Checks if a role can perform an operation
- `canUserSeeAllBranches(user)` — Returns true for SUPER_ADMIN, INVENTORY_MANAGER
- `getAllowedBranchIds(user, branches)` — Resolves accessible branch list
- Persisted in localStorage, editable via Permission Management UI

### 11.5 `utils/warranty.ts`

- `getWarrantyInfo(issuedDateAD, customMonths)` → `{ status: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED', daysRemaining, label }`
- Default warranty: 12 months from issue date

### 11.6 `utils/sessionCache.ts`

- `saveUserSession(user, rootUser, token)` — Persists auth state to localStorage
- `saveRecentBootstrapCache(data)` — Caches full bootstrap state for instant UI load
- Used for `localStorage` keys: `izone_user_session`, `izone_bootstrap_cache`

---

## 12. Configuration & Environment

### 12.1 Environment Variables (`.env`)

```env
# Server
PORT=3000
NODE_ENV=development
AUTH_TOKEN_SECRET=<auto-generated if not set>

# PostgreSQL
DATABASE_URL="postgres://inventory_user:securepassword@localhost:5432/inventory_db"
POSTGRES_HOST="localhost"
POSTGRES_PORT="5432"
POSTGRES_DB="inventory_db"
POSTGRES_USER="inventory_user"
POSTGRES_PASSWORD="securepassword"

# Optional
SEED_DUMMY_DATA=false        # Seed demo data on first launch
DISABLE_HMR=true             # Disable HMR for AI agent editing
```

### 12.2 Vite Configuration

- Tailwind CSS 4 via `@tailwindcss/vite` plugin
- Path alias: `@` → project root
- Manual chunks: `vendor-react`, `vendor-icons`, `vendor-motion`, `common-components`, `feature-*`
- HMR can be disabled via `DISABLE_HMR=true`

### 12.3 Build Pipeline

```bash
npm run dev          # Development: tsx server.ts (Vite dev server + Express)
npm run build        # Production: vite build + esbuild bundle server.ts
npm run start        # Production: node dist/server.cjs
npm run setup:pg     # Database setup & migration
npm run integrity:check  # Database integrity verification
```

---

## 13. Deployment

### 13.1 Docker (Multi-Stage)

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
RUN npm ci && npm run build

# Stage 2: Production
FROM node:20-alpine
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.cjs"]
```

### 13.2 PM2 (Process Manager)

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'izone-erp',
    script: 'dist/server.cjs',
    instances: 1,  // Single instance (PostgreSQL connection pool)
    env: { NODE_ENV: 'production', PORT: 3000 }
  }]
};
```

### 13.3 Database Setup

```bash
# Option 1: Auto-install PostgreSQL
npm run setup:pg

# Option 2: Manual (existing PostgreSQL)
psql -U postgres -f scripts/schema.sql

# Option 3: Shell script (Ubuntu/Debian/macOS)
npm run setup:postgres
```

---

## 14. Known Patterns & Design Decisions

### 14.1 The Bootstrap Pattern

The entire application state is loaded in **one HTTP call** (`GET /api/bootstrap`). This endpoint:
- Accepts `branchId` and `fiscalYearId` query parameters
- Runs 20+ parallel PostgreSQL queries via `Promise.all()`
- Returns all entity arrays + computed financial summary
- Supports branch and fiscal year scoping at the SQL level (not post-filter in JS)

### 14.2 The Dual-Write Pattern

Every mutation writes to both:
1. **PostgreSQL** (persistent storage, source of truth)
2. **In-memory array** (server runtime cache for request processing)

This is a deliberate trade-off: the in-memory cache is rehydrated from PostgreSQL on server startup and after mutations.

### 14.3 Fiscal Year Data Scoping

When viewing historical fiscal years:
- The bootstrap endpoint fetches from `fiscal_year_opening_stock` instead of current `inventory_stock`
- Stock, transactions, and audit logs are filtered by the fiscal year's AD date range
- Fixed assets are NOT filtered by fiscal year (they persist across years)

### 14.4 Date Handling

- **AD (Gregorian) dates** are the source of truth — stored as `DATE` in PostgreSQL, parsed as plain `'YYYY-MM-DD'` strings (not JS Date objects)
- **BS (Bikram Sambat) dates** are derived from `bs_day_records` table or client-side calendar engine
- Server-side `pg.types.setTypeParser(1082, value => value)` keeps DATE columns as strings
- Both dates appear on most transactional records (`_date_ad` and `_date_bs` columns)

### 14.5 Real-Time Sync

- Server uses **SSE (Server-Sent Events)** at `/api/sync/stream`
- On any mutation, `broadcastChange()` sends an event to all connected SSE clients
- Client debounces (250ms) and triggers `refreshAllData()` on any change
- This enables **real-time multi-user collaboration** without WebSocket complexity

### 14.6 ID Generation

- Most IDs use `Date.now()` based pattern: `prod-1694000000000`
- Transaction IDs follow: `{BRANCH_CODE}-{OP_TYPE}-{YYYYMMDD}-{0001}` (daily counter per branch)
- Document numbers are configurable via `document_number_configs` table

---

## 15. Quick Reference for New Developers

### Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file
cp .env.example .env

# 3. Setup database
npm run setup:pg

# 4. Start development
npm run dev
# → Opens at http://localhost:3000
```

### First Launch

1. Navigate to `http://localhost:3000`
2. The **LoginModal** detects no Super Admin exists → shows setup form
3. Create your first Super Admin account
4. (Optional) Seed demo data via Admin → Clear Demo Data screen

### Key Files to Read First

| Order | File | Why |
|---|---|---|
| 1 | `src/types/index.ts` | All data structures — the vocabulary of the system |
| 2 | `server.ts` lines 1–200 | Server setup, middleware chain, initial seed data |
| 3 | `server.ts` bootstrap endpoint | The core data-loading mechanism |
| 4 | `src/services/api.ts` | Frontend API client — every backend interaction |
| 5 | `src/App.tsx` | Root component — all state and action handlers |
| 6 | `scripts/schema.sql` | Full database schema — the data model |

### Common Development Tasks

| Task | Files to Modify |
|---|---|
| Add new API endpoint | `server.ts` (add route) + `src/services/api.ts` (add client method) |
| Add new UI page | `src/features/<module>/<Page>.tsx` + register in `App.tsx` + add to `Sidebar.tsx` |
| Add new database table | `scripts/schema.sql` (CREATE TABLE) + `server.ts` (bootstrap query + CRUD) |
| Add new permission | `src/utils/permissions.ts` (add to matrix) + `server.ts` (middleware rule) |
| Add new document type | `server.ts` (INITIAL_DOCUMENT_NUMBER_CONFIGS) + `src/utils/documentNumbering.ts` |

### Testing Demo Accounts

All demo users share password: `Demo@123`

| Email | Role | Branch |
|---|---|---|
| `superadmin@example.com` | SUPER_ADMIN | WH001 (Head Office) |
| `branch1@example.com` | BRANCH_MANAGER | WH001 |
| `branch2@example.com` | BRANCH_MANAGER | BRH01 |
| `inventory1@example.com` | INVENTORY_MANAGER | WH001 |
| `accountant1@example.com` | ACCOUNTANT | WH001 |
| `frontdesk1@example.com` | FRONT_DESK | BRH01 |

---

*End of Handoff Document*
