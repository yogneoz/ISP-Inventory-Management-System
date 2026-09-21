# Project Handoff Document — Inventory Management System

> **Full project analysis, architecture, database relationships, and developer guide.**  
> Updated: 2026-09-20 | Version: 1.2

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
11. [Serial Log Register & Dual-Panel Serial Editing](#11-serial-log-register--dual-panel-serial-editing)
12. [Utility Modules](#12-utility-modules)
13. [Configuration & Environment](#13-configuration--environment)
14. [Deployment](#14-deployment)
15. [Known Patterns & Design Decisions](#15-known-patterns--design-decisions)
16. [Quick Reference for New Developers](#16-quick-reference-for-new-developers)

---

## 1. Project Overview

**Inventory Management System** is a full-stack, multi-branch inventory management and enterprise resource planning system built specifically for **ISP/Fiber operations in Nepal**. It supports:

- Multi-branch inventory tracking with inter-branch stock transfers
- Purchase order → Invoice → Goods Receipt workflow
- Serial Log Register: one row per physical device (Device Serial / PON Serial / MAC) with lifecycle history, duplicate prevention, dual-panel conflict resolution, and cross-table cascade corrections
- Fixed asset register with depreciation (Straight Line, Declining Balance, WDV)
- Customer device (ONU/Router) tracking with PON serial, MAC address
- Physical stock audit & reconciliation with variance reports
- Nepali Bikram Sambat (BS) ↔ AD (Gregorian) dual-calendar system
- Fiscal year management with year-end closing wizard
- Document Numbering Setup page for dynamic voucher prefixes/sequences
- VAT purchase register, financial statements, vendor payments sub-ledger & vendor ledger
- 5-step fiscal year closing wizard with IRD audit certificate
- Demo data seeding (`is_demo` flag system) vs. real production data
- Real-time SSE-based multi-user synchronization

---

## 2. Tech Stack

| Layer | Technology | Version |
|---|---|---|
| **Frontend** | React 19 + TypeScript | React 19, TS 5.8 |
| **Styling** | Tailwind CSS 4 | 4.1.x |
| **UI Icons** | Lucide React | 0.5x |
| **Animations** | Motion (Framer) | 12.x |
| **Build Tool** | Vite 6 | 6.x |
| **Backend** | Node.js + Express | Express 4.21 |
| **Database** | PostgreSQL | 14+ (via `pg` 8.x) |
| **Language** | TypeScript (Full Stack) | 5.8 |
| **Dev Runtime** | tsx | 4.x |
| **Bundler (server)** | esbuild | 0.25 |
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
│              Express Server (server/index.ts)         │            │
│  ┌────────────────────────────────────────────────────┤            │
│  │ Middleware Pipeline (in order):                    │            │
│  │  1. authenticateUser  (JWT token → req.user)      │            │
│  │  2. Public route bypass                           │            │
│  │  3. requireAuth        (401 if no session)        │            │
│  │  4. requirePostgres    (503 if DB down)           │            │
│  │  5. enforceFiscalYearWriteAccess (423 on closed)  │            │
│  │  6. enforceOperationalPermissions (403 role gate) │            │
│  │  7. enforceBranchAccess    (403 branch scope)     │            │
│  │  8. requirePermission(opId) (per-route operation  │            │
│  │     gate against the permission_matrix table)     │            │
│  └────────────────────────────────────────────────────┤            │
│  ┌──────────────────────────────────────────────────┐ │            │
│  │ API Route Handlers (~130 route registrations)    │ │            │
│  │  - /api/bootstrap (atomic 1-roundtrip sync)      │ │            │
│  │  - /api/auth/*    (login, setup, profile switch) │ │            │
│  │  - /api/products, /api/stock, /api/assets, etc. │ │            │
│  │  - /api/serial-log, /api/inventory/serials/*     │ │            │
│  │  - /api/sync/stream (SSE real-time broadcast)    │ │            │
│  └──────────────────────────────────────────────────┘ │            │
│                          │                             │            │
│  ┌───────────────────────▼─────────────────────────┐  │            │
│  │ PostgreSQL Connection Pool (server/db.ts)       │  │            │
│  │  DATE columns parsed as plain 'YYYY-MM-DD'      │  │            │
│  └─────────────────────────────────────────────────┘  │            │
└───────────────────────────────────────────────────────────────────┘
```

**Key architectural decisions:**
- **Single bootstrap endpoint** (`GET /api/bootstrap`) returns ALL data in one roundtrip, filtered by `branchId` and `fiscalYearId` query params.
- **In-memory runtime caches** are hydrated from PostgreSQL on startup (via the single `CACHE_LOADS` list in `server/src/app.ts`) and fully re-read from PostgreSQL after every successful mutating API call (an automatic hook re-reads all cache tables before the write response is sent). The arrays are declared `readonly` so the typechecker rejects any hand-maintained mirror mutation — PostgreSQL is the only place writes land, and caches are always re-derived from it.
- **SSE (Server-Sent Events)** for real-time sync: all connected clients get a `broadcastChange()` notification on any mutation, triggering a re-fetch.
- **Server-side permission matrix**: the authoritative matrix lives in the `permission_matrix` table (seeded from the same defaults as the client at startup); clients cache it via the bootstrap payload.

---

## 4. Directory Structure & File Map

The project follows a layered `client/` + `server/` architecture (Express app
instantiation in `server/src/app.ts`, network bootstrap in `server/index.ts`,
thin route registration → controllers → services, structured `ApiError`
handling through a central error middleware).

```
ISP-Inventory-Management-System/
├── client/                            # Frontend (Vite root)
│   ├── index.html                     # SPA entry (vite root is client/)
│   └── src/
│       ├── components/                # Shared, reusable UI elements
│       ├── contexts/                  # React context providers
│       ├── features/                  # Feature modules (inventory, procurement, ...)
│       ├── services/                  # API client (api.ts)
│       ├── types/                     # Shared data structures (vocabulary of the system)
│       └── utils/                     # Frontend helpers (permissions, depreciation, ...)
│
├── server/
│   ├── index.ts                       # Network bootstrap: createApp → registerAllRoutes →
│   │                                  #   syncDatabaseAndIndexes → listen → vite/static serving
│   ├── db.ts                          # PostgreSQL pool (DATE override, DATABASE_URL)
│   └── src/
│       ├── app.ts                     # App composition (~3,300 lines): createApp(), shared
│       │                              #   runtime state + accessors, CACHE_LOADS + refresh,
│       │                              #   serial cascade, SSE, syncDatabaseAndIndexes,
│       │                              #   registerAllRoutes() + terminal error handler
│       ├── config/                    # Seed/config data
│       │   ├── bsCalendar.ts          # BS calendar constants, fallback cache, helpers
│       │   └── seedData.ts            # Company profile, doc numbering, master data, demo users
│       ├── controllers/               # HTTP orchestration (route → controller → service);
│       │                              #   every route forwards to a controller fn whose
│       │                              #   rejection flows to the central error handler
│       │   ├── auth.controller.ts
│       │   ├── inventory.controller.ts / procurement.controller.ts / admin.controller.ts /
│       │   ├── masterdata.controller.ts / shipments.controller.ts / misc.controller.ts /
│       │   └── reports.controller.ts / sync.controller.ts / permissions.controller.ts /
│       │       bootstrap.controller.ts
│       ├── errors/                    # Structured error handling
│       │   ├── ApiError.ts            # throw new ApiError(status, message)
│       │   └── errorHandler.ts        # Central middleware converting ApiError → JSON
│       ├── middleware/                # Middleware chain
│       │   ├── auth.ts                # scrypt hashing, HMAC tokens, session helpers
│       │   └── index.ts               # auth, PG gate, fiscal lock, RBAC, matrix perms, branch scope
│       ├── models/                    # Schema blueprints / data access
│       │   ├── bootstrap.repo.ts      # Bootstrap fetches + serial history parsing
│       │   └── columnMappings.ts      # Per-table column mappings (single source)
│       ├── routes/                    # Endpoint layout — every route is a thin forwarder
│       │   ├── auth.routes.ts / bootstrap.routes.ts / inventory.routes.ts / procurement.routes.ts /
│       │   ├── shipments.routes.ts / masterdata.routes.ts / admin.routes.ts /
│       │   └── reports.routes.ts / sync.routes.ts / permissions.routes.ts / misc.routes.ts
│       ├── services/                  # Core business logic — unit-tested (100 tests)
│       │   ├── damage.service.ts
│       │   ├── serialEditCapture.service.ts
│       │   └── serials.service.ts
│       └── utils/                     # Shared server helpers
│           └── copyHelpers.ts         # withPrepended/withAppended/withReplaced/withSorted
│
├── server.ts                          # Root shim → re-exports server/src/app
│                                      #   (legacy entry compatibility)
└── tests/                             # Unit tests (node:test) for services
│
├── src/
│   ├── App.tsx                        # Root React component (~2,200 lines)
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
│   │   └── index.ts                   # All TypeScript interfaces (~780 lines)
│   │       ├── CompanyProfile, User, UserRole, Supplier, Branch
│   │       ├── Product, Category, UnitOfMeasure
│   │       ├── InventoryStock, DamageRecord
│   │       ├── Asset (Fixed Asset), POLineItem, PurchaseOrder
│   │       ├── PurchaseInvoiceItem, PurchaseInvoice
│   │       ├── Shipment, ShipmentItem
│   │       ├── StockOperation, PulloutItem, SaleItem, ConsumableIssueItem
│   │       ├── CustomerDeviceRecord, CustomerRecord, SerialLogEntry
│   │       ├── SerialLookupResult, SerialEditPayload
│   │       ├── ApprovalRequest, FiscalYear
│   │       ├── AuditLog, TransactionLog, FinancialSummary
│   │       ├── LocationRecord, DocumentNumberConfig
│   │       └── BootstrapState (full sync payload type)
│   │
│   ├── services/
│   │   └── api.ts                     # Frontend API client (~1,150 lines)
│   │       ├── fetchJson()            # Core HTTP helper with auth headers
│   │       ├── subscribeToSyncStream() # SSE connection manager
│   │       ├── api.getBootstrapState() # Single atomic data fetch
│   │       ├── api.login()            # Auth endpoints
│   │       ├── api.getSerialLog() / createSerialLogEntry()
│   │       ├── api.updateDeviceSerials()      # Single serial correction
│   │       ├── api.lookupSerial()             # Live conflict lookup while typing
│   │       ├── api.updateDeviceSerialsDual()  # Two-device dual correction / swap
│   │       └── ... all other CRUD methods
│   │
│   ├── utils/
│   │   ├── nepaliCalendar.ts          # BS ↔ AD calendar conversion engine
│   │   │   ├── adToBS() / bsToAD()
│   │   │   └── BS year data: 2078–2085
│   │   ├── depreciation.ts            # Fixed asset depreciation calculator
│   │   │   └── Supports: STRAIGHT_LINE, REDUCING_BALANCE, DECLINING_BALANCE, WRITTEN_DOWN_VALUE
│   │   ├── documentNumbering.ts       # Auto document number generation (22 doc types)
│   │   ├── permissionMatrixData.ts    # APP_ROLES (9) + INVENTORY_OPERATIONS (41) + DEFAULT_PERMISSIONS_MATRIX
│   │   ├── permissions.ts             # RBAC engine
│   │   │   ├── isOperationAllowed()   # checks server matrix → localStorage → defaults
│   │   │   ├── canUserSeeAllBranches() / getAllowedBranchIds()
│   │   │   └── setServerMatrix() / savePermissionsMatrix()
│   │   ├── sessionCache.ts            # Client-side session persistence
│   │   │   └── saveRecentBootstrapCache() (instant 0ms UI load)
│   │   ├── warranty.ts                # getWarrantyInfo() → VALID / EXPIRING_SOON / EXPIRED
│   │   ├── nprFormat.ts               # Multi-currency formatting (configurable code/locale/position)
│   │   ├── companyProfile.ts          # Company profile helpers
│   │   ├── exportUtils.ts             # CSV/Excel export helpers
│   │   └── logoImage.ts               # Default logo image constants
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx             # Top bar: profile switch, notifications, date mode, search
│   │   │   └── Sidebar.tsx            # Left navigation rail with 25+ menu items
│   │   │
│   │   └── common/
│   │       ├── LoginModal.tsx          # Super Admin first-launch setup & login
│   │       ├── ProfileSwitchModal.tsx  # Impersonate/switch user profiles
│   │       ├── NotificationCenter.tsx  # Audit event feed
│   │       ├── GlobalSearchModal.tsx   # Ctrl+K global search
│   │       ├── BarcodeScannerModal.tsx # Alt+B barcode scanner
│   │       ├── DatabaseSetupBanner.tsx # DB connection status banner
│   │       ├── ClearDemoDataView.tsx   # Admin: delete is_demo=TRUE rows
│   │       ├── TablePagination.tsx     # Reusable pagination component
│   │       ├── DialogProvider.tsx      # App-wide dialog primitives
│   │       ├── DocumentLetterhead.tsx  # Printable letterhead for documents
│   │       ├── FiscalYearSelect.tsx    # Reusable fiscal-year dropdown
│   │       └── HelpDocumentation.tsx   # In-app help center
│   │
│   └── features/
│       ├── dashboard/
│       │   └── Dashboard.tsx           # KPI cards, charts, recent activity
│       │
│       ├── inventory/
│       │   ├── ProductManagement.tsx    # Product catalog CRUD
│       │   ├── BranchStockTracking.tsx  # Per-branch stock levels
│       │   ├── ReorderStockTracking.tsx # Low stock alerts & reorder
│       │   ├── DamagedStockTracking.tsx # Damage records lifecycle
│       │   ├── StockOperations.tsx      # Stock out, pullout, consumable issue, manual adjust
│       │   ├── StockMovementLedger.tsx  # Full transaction history log
│       │   ├── SerialLogRegister.tsx    # Per-device serial register with dual-panel editing
│       │   ├── StockValuation.tsx       # Inventory value reports
│       │   ├── PhysicalStockAudit.tsx   # Physical count & variance reconciliation
│       │   ├── CategoryManagement.tsx   # Product category CRUD
│       │   ├── UomManagement.tsx        # Unit of Measure CRUD
│       │   ├── WarrantyProducts.tsx     # Device warranty tracking
│       │   ├── ImportStock.tsx          # CSV import of stock data
│       │   ├── ExportStock.tsx          # CSV/Excel export of stock
│       │   └── ProductSearchBar.tsx     # Reusable product search component
│       │
│       ├── procurement/
│       │   ├── SuppliersManagement.tsx  # Supplier directory CRUD
│       │   ├── PurchaseOrders.tsx       # PO creation with line items
│       │   ├── PurchaseInvoices.tsx     # Supplier invoices with device serials
│       │   ├── ReceiveInboundWarehouse.tsx # Goods receipt with serial verification
│       │   └── Shipments.tsx            # Inter-branch shipments
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
│       │   ├── VendorLedger.tsx             # Vendor ledger & payments report
│       │   ├── VendorOpeningBalances.tsx    # Vendor opening balance management
│       │   ├── DocumentNumbering.tsx        # Document Numbering Setup (voucher prefixes/sequences)
│       │   ├── NepaliFiscalManagement.tsx   # BS fiscal year settings
│       │   ├── FiscalYearClosingWizard.tsx  # 5-step year-end closing wizard + FY periods table
│       │   ├── OpeningStockManager.tsx      # Opening stock balances per fiscal year
│       │   ├── BsCalendarUtility.tsx        # BS calendar seeding & lookup
│       │   └── AuditTrailReports.tsx        # Audit log reports & CSV export
│       │
│       └── settings/
│           ├── BranchesManagement.tsx        # Branch CRUD
│           ├── CompanySetupManagement.tsx    # Company profile (logo, PAN, address)
│           ├── UsersManagement.tsx           # User CRUD with role assignment
│           ├── PermissionManagement.tsx      # Permissions matrix editor (persisted to PostgreSQL)
│           ├── ApprovalWorkflowCenter.tsx    # Multi-tier approval workflow
│           ├── LocationsManagement.tsx       # Physical locations CRUD
│           └── DataRecalculationMaintenance.tsx # Admin: recalculate stock, assets, calendar, FY links
│
├── scripts/
│   ├── schema.sql                     # Full PostgreSQL schema (30 tables, idempotent)
│   ├── setup_db.js                    # Node.js database setup & seed runner
│   ├── setup_postgres.sh              # Shell: auto-install & configure PostgreSQL
│   ├── demo_dataset.js                # Demo data seeder (is_demo=TRUE, all-IN_STOCK serials)
│   ├── integrity_check.mjs            # Database integrity verification
│   └── reset_fresh_demo.mjs           # Full reset & re-seed script (preserves BS calendar)
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

### 5.1 Tables Overview (30 tables)

| # | Table | Purpose | Key Columns |
|---|---|---|---|
| 1 | `branches` | Branch/warehouse master | id (PK), code (UNIQUE), name, is_headquarters, is_demo |
| 2 | `users` | User accounts | id (PK), email (UNIQUE), password, role, branch_id (FK→branches) |
| 3 | `fiscal_years` | Fiscal year periods | id (PK), code (UNIQUE), start_date_ad, end_date_ad, is_current, is_closed |
| 4 | `suppliers` | Supplier directory | id (PK), name, pan_vat_number |
| 5 | `categories` | Product categories | id (PK), name (UNIQUE), code (UNIQUE), is_special_tracked |
| 6 | `products` | Product catalog | id (PK), sku (UNIQUE), product_group, requires_serial_tracking, depreciation_method, depreciation_rate |
| 7 | `inventory_stock` | Per-branch stock levels | id (PK), product_id (FK→products), branch_id (FK→branches), quantity_on_hand |
| 8 | `damage_records` | Damage lifecycle tracking | id (PK), product_id (FK→products), branch_id (FK→branches), status, fiscal_year_id (FK→fiscal_years) |
| 9 | `fixed_assets` | Fixed asset register | id (PK), tag_number (UNIQUE), product_id (FK→products), branch_id (FK→branches), depreciation_method |
| 10 | `purchase_orders` | Purchase orders | id (PK), po_number (UNIQUE), branch_id (FK→branches), items (JSONB), fiscal_year_id (FK→fiscal_years) |
| 11 | `purchase_invoices` | Supplier invoices | id (PK), invoice_number (UNIQUE), branch_id (FK→branches), items (JSONB), fiscal_year_id (FK→fiscal_years) |
| 12 | `vendor_payments` | Vendor payments sub-ledger | id (PK), payment_number (UNIQUE), supplier_id (FK→suppliers), invoice_id (FK→purchase_invoices), amount, status (POSTED/REVERSED/VOIDED), fiscal_year_id |
| 13 | `vendor_opening_balances` | Vendor opening balances per FY | id (PK), supplier_id (FK→suppliers), fiscal_year_id, amount |
| 14 | `shipments` | Inter-branch transfers | id (PK), tracking_code (UNIQUE), source_branch_id, destination_branch_id, items (JSONB) |
| 15 | `stock_operations` | Stock movements | id (PK), reference_number (UNIQUE), branch_id (FK→branches), product_id (FK→products), type, items (JSONB) |
| 16 | `fiscal_year_opening_stock` | Year opening balances | id (PK), fiscal_year_id, product_id, branch_id |
| 17 | `audit_logs` | Complete audit trail | id (PK), user_email, module, action, branch_id, fiscal_year_id |
| 18 | `transaction_logs` | Stock change log | id (PK), product_id, branch_id, change_type, quantity_before/changed/after |
| 19 | `customer_records` | Customer directory | id (PK), customer_id (UNIQUE), branch_id (FK→branches) |
| 20 | `customer_device_records` | CPE/device assignments | id (PK), customer_id, branch_id (FK→branches), device_serial, pon_serial, mac_address, status |
| 21 | `serial_log` | One row per physical device serial | id (PK), device_serial (UNIQUE, case-insensitive), pon_serial, mac_address, product_id, branch_id, customer_id, status, source_type, history (JSONB) |
| 22 | `approval_requests` | Multi-tier approvals | id (PK), request_number (UNIQUE), type, branch_id, status |
| 23 | `bs_calendar_years` | BS year metadata | year_bs (PK), days_in_months (INT[]), start_ad |
| 24 | `bs_day_records` | Day-by-day BS↔AD map | ad_date (PK), bs_date, fiscal_year_id (FK→fiscal_years) |
| 25 | `uom` | Units of measure | id (PK), name (UNIQUE), symbol, type |
| 26 | `locations` | Physical locations | id (PK), branch_id (FK→branches), type |
| 27 | `company_profile` | Company master data | id (PK), name, pan_vat_number, currency_code/position/decimals, default_tax_rate |
| 28 | `document_number_configs` | Auto-numbering rules | id (PK), document_type, prefix, next_number, reset_every_fiscal_year |
| 29 | `document_sequence_daily` | Per-branch daily doc sequences | (branch_id, doc_type, date_ad) PK, next_number |
| 30 | `permission_matrix` | RBAC authority (operation × role) | (operation_id, role) PK, allowed |

### 5.2 Serial Log Uniqueness

The `serial_log` register enforces uniqueness with case-insensitive unique indexes on `lower(device_serial)`, `lower(pon_serial)` and `lower(mac_address)`. The same case-insensitive rule is applied at application level across `serial_log`, `customer_device_records` and `fixed_assets.tag_number` before any serial correction is saved (see section 11).

### 5.3 Key Foreign Key Relationships

```
branches.id ←─ users, inventory_stock, fixed_assets, purchase_orders,
               purchase_invoices, shipments (source/destination),
               stock_operations, customer_records, customer_device_records,
               approval_requests, locations, audit_logs

products.id ←─ inventory_stock (CASCADE), fixed_assets (SET NULL),
               stock_operations (SET NULL), transaction_logs (SET NULL),
               damage_records (CASCADE), serial_log (SET NULL)

fiscal_years.id ←─ purchase_orders, purchase_invoices, shipments,
                   stock_operations, customer_device_records, approval_requests,
                   damage_records, audit_logs, transaction_logs,
                   fiscal_year_opening_stock, bs_day_records, vendor_payments

suppliers.id ←─ vendor_payments.supplier_id, vendor_opening_balances.supplier_id

customer_id (application-level link: customer_records ↔ customer_device_records ↔ serial_log)
```

### 5.4 The `is_demo` Flag System

Every operational table has an `is_demo BOOLEAN NOT NULL DEFAULT FALSE` column:
- `npm run setup:pg` seeds demo data with `is_demo = TRUE`
- The **Clear Demo Data** admin action (`POST /api/admin/clear-demo-data`) only deletes rows where `is_demo = TRUE`
- Real production data (`is_demo = FALSE`) is never touched by demo cleanup

### 5.5 JSONB Document Columns

These tables store line items as JSONB arrays rather than normalized child tables:

| Table | JSONB Column | Structure |
|---|---|---|
| `purchase_orders` | `items` | `[{id, productId, productName, sku, quantity, unitPrice, taxRate, subtotal, taxAmount, total}]` |
| `purchase_invoices` | `items` | Same as PO + `deviceSerials: [{deviceSerial, ponSerial, macAddress}]` |
| `shipments` | `items` | `[{id, productId, productName, sku, quantitySent, quantityReceived, deviceSerials}]` |
| `stock_operations` | `items` | Mixed: PulloutItem[] or ConsumableIssueItem[] or SaleItem[] |
| `serial_log` | `history_json` | `[{status, sourceType, sourceId?, dateAD, ...}]` — append-only lifecycle events |

---

## 6. API Endpoints Reference

The server registers ~130 routes. The most important ones:

### 6.1 Public Endpoints (No Auth Required)

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/db/status` | PostgreSQL connection status + table count |
| `GET` | `/api/auth/setup-status` | First-launch detection (has Super Admin?) |
| `POST` | `/api/auth/setup-superadmin` | Create initial Super Admin account |
| `POST` | `/api/auth/forgot-password` | Password reset request (logged; reset performed by an admin in User Management) |
| `POST` | `/api/auth/login` | Email + password → signed token |

### 6.2 Authenticated Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/auth/me` | Get current user |
| `POST` | `/api/auth/switch-profile` | Switch to another user profile (canSwitchUser=true) |
| `PUT` | `/api/auth/profile` | Update own profile |
| `GET` | `/api/bootstrap` | **Full atomic data sync** (1 roundtrip) |
| `GET` | `/api/sync/stream` | SSE real-time event stream |
| `GET` | `/api/sync/version` | Current data version |

### 6.3 Master Data CRUD

| Endpoint | Methods |
|---|---|
| `/api/branches` | GET, POST, PUT/DELETE `:id` |
| `/api/suppliers` | GET, POST, PUT/DELETE `:id` |
| `/api/users` | GET, POST, PUT/DELETE `:id`, POST `:id/reset-password` |
| `/api/products` | GET, POST, PUT/DELETE `:id` |
| `/api/categories` | GET, POST, PUT/DELETE `:id` |
| `/api/uom` | GET, POST, PUT/DELETE `:id` |
| `/api/locations` | GET, POST, PUT/DELETE `:id` |
| `/api/company-profile` | GET, PUT |
| `/api/document-number-configs` | GET, PUT |

### 6.4 Operational Endpoints

| Endpoint | Methods | Purpose |
|---|---|---|
| `/api/stock` | GET, PATCH `:id` | Branch-scoped stock levels / reorder levels |
| `/api/assets` | GET, POST, PUT/DELETE `:id` | Fixed asset register |
| `/api/purchase-orders` | GET, POST, PUT/DELETE `:id`, PATCH `:id/status` | PO workflow |
| `/api/purchase-invoices` | GET, POST, DELETE `:id` | Invoices |
| `/api/purchase-invoices/:id/payment` | POST | Record partial payment |
| `/api/purchase-invoices/:id/payments` | GET | Payment history (vendor_payments sub-ledger) |
| `/api/purchase-invoices/:id/reverse-payments` | POST | Reverse all posted payments of a fully paid invoice |
| `/api/vendor-payments` | GET, POST | Vendor payments sub-ledger |
| `/api/vendor-payments/:id/reverse` | POST | Reverse a posted payment |
| `/api/vendors/:supplierId/ledger` | GET | Vendor ledger report (running balance) |
| `/api/shipments` | GET, POST | Inter-branch transfers |
| `/api/shipments/:id/receive` | POST | Receive + verify incoming shipment |
| `/api/shipments/:id/cancel-receive` | POST | Cancel received shipment |
| `/api/stock-operations` | GET, POST | Stock out, pullout, damage, consumable issue |
| `/api/customer-devices` | GET, POST, PUT `:id` | CPE device tracking |
| `/api/customers` | GET, POST, PUT/DELETE `:id` | Customer directory |
| `/api/damage-records` | GET, POST, PUT `:id` | Damage lifecycle |
| `/api/approval-requests` | GET, POST, `:id/process`, `:id/cancel` | Approval workflow |
| `/api/serial-log` | GET, POST | Serial register read (role-guarded, branch-scoped) & manual entry |

### 6.5 Serial Correction Endpoints (permission: `edit-device-serials`)

| Method | Endpoint | Purpose |
|---|---|---|
| `PATCH` | `/api/inventory/serials` | Correct one device's serials; validates duplicates across `serial_log`, `customer_device_records`, `fixed_assets.tag_number` (case-insensitive); cascades the rename to every table holding the serial (customer devices, purchase invoice JSONB, shipment JSONB, stock-op JSONB) in one transaction; returns **409** with conflict details |
| `GET` | `/api/inventory/serials/lookup?value=...&exclude=...` | Live lookup while typing — resolves a serial/PON/MAC (case-insensitive) to the device holding it, with source table; `exclude` skips the edited device's own old values |
| `POST` | `/api/inventory/serials/dual` | Apply **two** corrections in one call (used by the dual-panel editor). Validates the combined final state (full A↔B swaps pass), then park-both-then-applies so unique indexes can never collide mid-sequence |

### 6.6 Fiscal Year Endpoints

| Endpoint | Methods | Purpose |
|---|---|---|
| `/api/fiscal-years` | GET, POST, PUT/DELETE `:id` | Fiscal year CRUD |
| `/api/fiscal-years/:id/set-current` | POST | Set as active fiscal year |
| `/api/fiscal-years/:id/close` | POST | **5-step closing wizard** |
| `/api/fiscal-years/:id/reopen` | POST | Reopen closed year |
| `/api/fiscal-years/:id/initialize-opening-stock` | POST | Generate opening balances from a closed year |
| `/api/fiscal-years/:id/opening-stock` | GET, POST | View / batch-adjust opening balances (open years only) |
| `/api/bs-calendar/years` | GET, POST, DELETE `:year` | BS calendar year data |

### 6.7 Admin Endpoints

| Endpoint | Methods | Purpose |
|---|---|---|
| `/api/admin/clear-demo-data` | POST | Delete is_demo=TRUE rows |
| `/api/admin/recalculate/fixed-assets` | POST | Recompute depreciation values (SUPER_ADMIN) |
| `/api/admin/recalculate/live-stock` | POST | Recompute stock from transaction history (SUPER_ADMIN) |
| `/api/admin/recalculate/bs-day-records` | POST | Rebuild BS calendar day records (SUPER_ADMIN) |
| `/api/admin/repair/fiscal-year-links` | POST | Re-link missing fiscal_year_id references (SUPER_ADMIN) |
| `/api/permissions` | GET, PUT | Read / persist the permission matrix (PostgreSQL-backed) |

### 6.8 Request Headers

| Header | Purpose |
|---|---|
| `Authorization: Bearer <token>` | Signed auth token |
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
- **Token**: Custom HMAC-signed JWT-like token (not a JWT library), **8-hour TTL** (`AUTH_TOKEN_TTL_SECONDS = 8 * 60 * 60`)
- **Signing secret**: `AUTH_TOKEN_SECRET` env var; a persistent secret is generated and stored on first boot if not provided (a warning is logged because the ephemeral secret invalidates sessions across restarts)
- **Plaintext fallback**: Legacy plaintext passwords are auto-upgraded to scrypt on successful login

### 7.2 Authorization Chain

Every `/api/*` request passes through this middleware chain in order:

1. **`authenticateUser`** — Extracts token from `Authorization: Bearer <token>`, decodes → `req.user`
2. **`requireAuth`** — Rejects 401 if `req.user` is missing (except public routes)
3. **`requirePostgres`** — Returns 503 if PostgreSQL is unavailable (except `/api/db/status`)
4. **`enforceFiscalYearWriteAccess`** — Returns 423 if mutating a closed fiscal year (only SUPER_ADMIN and INVENTORY_MANAGER can)
5. **`enforceOperationalPermissions`** — Maps URL path prefixes to allowed roles, returns 403 if mismatch
6. **`enforceBranchAccess`** — Ensures the user is authorized for the branch they're accessing/creating
7. **`requirePermission(operationId)`** — Per-route operation gate checked against the server-side permission matrix (e.g. `edit-device-serials` on all serial-correction routes)

---

## 8. Role-Based Access Control (RBAC)

### 8.1 Roles (9 defined in database constraint)

| Role | Description | Branch Access |
|---|---|---|
| `SUPER_ADMIN` | Full system access, all branches | ALL |
| `HEAD_OFFICE_ADMIN` | HQ admin, branch management | ALL |
| `INVENTORY_MANAGER` | Inventory, products, stock, assets | ALL |
| `BRANCH_MANAGER` | Branch-scoped operations | Single branch |
| `FRONT_DESK` | Customer-facing operations, stock out | Single branch |
| `ACCOUNTANT` | Financials, invoices, payments | Single branch |
| `PROCUREMENT_OFFICER` | POs, invoices, receiving | Single branch |
| `FIELD_TECHNICIAN` | Field operations | Single branch |
| `AUDITOR` | Read-only audit access | Single branch |

### 8.2 Permissions Matrix (41 operations × 9 roles)

Defined in `src/utils/permissionMatrixData.ts` (`INVENTORY_OPERATIONS`, `APP_ROLES`, `DEFAULT_PERMISSIONS_MATRIX`). Key groups:

- **Procurement**: `po-create`, `po-receive`, `inv-create`, `inv-pay`, `po-delete`, `inv-delete`, `branch-procurement-control`
- **Warehouse**: `shipment-create`, `wh-receive-pullouts`, `wh-restrict-transfer`, `shipment-history`
- **Branch Ops**: `branch-transfer-create`, `branch-transfer-receive`, `branch-transfer-cancel-receive`, `branch-transfer-request-cancel`, `branch-pullout-dispatch`, `branch-damage-mark`, `stock-disposal-writeoff`, `branch-asset-assign`, `stock-out`
- **Inventory**: `prod-view`, `prod-edit`, `uom-manage`, `edit-device-serials`, `category-manage`, `stock-import-export`, `opening-stock-view`, `opening-stock-edit`
- **Financials**: `assets-manage`, `fin-statements`, `vat-register`, `stock-valuation`
- **Master/Settings**: `suppliers-manage`, plus admin operations (`admin-users`, `admin-branches`, `admin-audit`, `admin-fiscal`, `auth-switch-user`, `workflow-approval`)

**Storage (three layers, in precedence order):**
1. **PostgreSQL `permission_matrix` table** — authoritative, seeded at server startup, editable via the Permission Management UI (`PUT /api/permissions`)
2. **Server matrix delivered via bootstrap** — cached client-side via `setServerMatrix()`
3. **localStorage (`inventory_permissions_matrix`)** — offline fallback / last-saved local edit

`isOperationAllowed()` resolves in that order, so server-side changes take effect on all clients after the next bootstrap.

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
│   ├── stockOperations, damageRecords, serialLog
│   ├── customerDevices, customers, approvalRequests
│   ├── fiscalYears, auditLogs, transactionLogs
│   ├── suppliers, users, categories, locations
│   └── companyProfile, financialSummary, postgresStatus
└── Action handlers (all call api.* then refreshAllData())
```

### 9.2 Data Flow Pattern

```
1. User action (button click)
2. Handler calls api.createXxx(data) → HTTP request to server
3. Server writes to PostgreSQL; after the write commits, an automatic hook re-reads all cache tables from PostgreSQL (`refreshOperationalCache`) before the response is sent — there is no hand-maintained mirror
4. Server calls broadcastChange() → SSE to all clients
5. Client SSE listener calls refreshAllData()
6. refreshAllData() calls api.getBootstrapState(branchId, fiscalYearId)
7. Server returns filtered data → client updates all useState
8. UI re-renders with fresh data
```

**Key optimization**: `saveRecentBootstrapCache()` / `loadRecentBootstrapCache()` stores the last bootstrap in `localStorage` for instant 0ms load on revisit (then refreshes in background).

### 9.3 Tab-Based Navigation

The `Sidebar` component defines `NAV_TABS` — navigation entries organized into groups (visibility filtered per role/permissions):
- Dashboard
- **Inventory**: Serial Log Register, Products, Stock, Reorder, Damage, Stock Operations, Ledger, Audit, Valuation, Import/Export, Categories, UOM, Warranty
- **Procurement**: Suppliers, POs, Invoices, Inbound Receiving, Shipments
- **Sales**: Customer Directory, Customer Devices, Import Customers
- **Finance**: Fixed Assets, Financial Statements, VAT Register, Depreciation, Vendor Ledger, Vendor Opening Balances, Fiscal Years, Document Numbering, BS Calendar, Audit Trail, Opening Stock
- **Settings/Admin**: Branches, Users, Permissions, Approvals, Company Setup, Locations, Data Recalculation, Clear Demo Data

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
    ↓ Approve → PO (APPROVED) → Send (SENT)
    ↓ Create Purchase Invoice
Invoice (UNPAID) ──→ Auto-provisions device serials as IN_STOCK in serial_log
    ↓ Record Payment (partial/full) — vendor_payments sub-ledger
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
Step 2: Fixed Asset Depreciation Posting
Step 3: Trial Balance Roll-Forward
Step 4: Fiscal Year Close (is_closed = TRUE, Super Admin re-auth required)
Step 5: IRD Audit Certificate download
```

### 10.6 Customer Device (CPE) Management

```
Purchase Invoice with deviceSerials → creates IN_STOCK serial_log records
    ↓ Assign device to customer → CUSTOMER_ASSIGNED (customer_device_records row created)
    ↓ Customer disconnects / returns
Device status: DISCONNECTED / RETURNED / REFUND
    ↓ Approval workflow for status changes
Approved → stock re-stocked if restock_qty_on_approval
```

---

## 11. Serial Log Register & Dual-Panel Serial Editing

The Serial Log Register (`src/features/inventory/SerialLogRegister.tsx`) is the single source of truth for physical device identity. Each row tracks **Device Serial**, **PON Serial** and **MAC Address** with status (`IN_STOCK`, `IN_TRANSIT`, `CUSTOMER_ASSIGNED`, `POP_LOCATION_ASSIGNED`, `DAMAGED`, `RETURNED`), branch/customer assignment, and an append-only history.

### 11.1 Edit Modal with Live Conflict Detection

- While typing in any of the three serial fields, a **debounced lookup** (`GET /api/inventory/serials/lookup`) checks the value against all devices in the database (case-insensitive), not just the branch-scoped register.
- If the typed value belongs to **another device**, the modal **expands to two side-by-side panels**: the edited device (left) and the conflicting device (right, prefilled, tagged with its source: REGISTER / CUSTOMER DEVICE / FIXED ASSET).
- A **⇄ Swap** button exchanges the two devices' serial triples in one click.
- Save stays disabled until every conflict is resolved; server 409 responses surface inline as the final gate.

### 11.2 Server-Side Guarantees (`handleUpdateSerials` + dual endpoint)

1. **Pre-transaction duplicate check** — every new value is compared case-insensitively against `serial_log` (all three columns), `customer_device_records` (all three columns) and `fixed_assets.tag_number`; rows belonging to the device being edited (matched by any of its old identifiers) are excluded. Conflicts return **409** naming the field, value and conflicting device.
2. **Cascade rename in one transaction** — the correction propagates to `customer_device_records` (matched by id or any old identifier) and to the JSONB `items` of `purchase_invoices`, `shipments` and `stock_operations` (pre-selected with `ILIKE` across all three old values). All matchers are case-insensitive.
3. **Dual save (swap-safe)** — `POST /api/inventory/serials/dual` validates the combined final state (no value shared between the two devices; full swaps pass), then **parks both devices on temporary unique serials before applying final values**, so no unique index can collide mid-sequence regardless of collision shape.
4. **In-transaction race protection** — the `serial_log` sync re-checks all three fields inside the transaction and rejects with the field name if a concurrent write introduced a clash.

---

## 12. Utility Modules

### 12.1 `utils/nepaliCalendar.ts`

- `adToBS(adDate)` / `bsToAD(bsDate)` — dual-calendar conversion
- Built-in data for BS years 2078–2085, extendable via BS Calendar Utility admin screen
- Server-side: `bs_day_records` table provides the authoritative day-by-day mapping (rebuildable via admin recalculation)

### 12.2 `utils/depreciation.ts`

```typescript
calculateFixedAssetValues({
  acquisitionCost, acquisitionDateAD, asOfDateAD,
  depreciationMethod,  // STRAIGHT_LINE | REDUCING_BALANCE | DECLINING_BALANCE | WRITTEN_DOWN_VALUE
  depreciationRatePercent,
})
→ { acquisitionCost, annualDepreciation, accumulatedDepreciation, netBookValue }
```

- **Straight Line**: `AccDep = Cost × Rate × MonthsElapsed / (100 × 12)`
- **Reducing/Declining/WDV**: `AccDep = Cost × (1 - (1 - Rate/100)^YearsElapsed)`

### 12.3 `utils/documentNumbering.ts`

- Format: `{DOC_TYPE}-{BRANCH_CODE}-{YYYYMMDD}{NNNN}` issued atomically from `document_sequence_daily` (one row per branch/doc-type/day, resets naturally each day)
- 22 document types configured: PO, PI, GRN, DN, INV, QUO, CN, ST, SA, DC, CPI, EXC, WC, FAA, FAR, JV, PV, RV, CP, CR, BP, BR

### 12.4 `utils/permissions.ts` + `permissionMatrixData.ts`

- `DEFAULT_PERMISSIONS_MATRIX` — 41 operation keys × 9 roles
- `isOperationAllowed(opId, userRole, ...)` — server matrix → localStorage → defaults
- `canUserSeeAllBranches(user)` — SUPER_ADMIN, INVENTORY_MANAGER, HEAD_OFFICE_ADMIN
- `getAllowedBranchIds(user, branches)` — resolves accessible branch list
- `setServerMatrix(matrix)` — caches the bootstrap-delivered matrix

### 12.5 `utils/warranty.ts`

- `getWarrantyInfo(issuedDateAD, customMonths = 12)` → `{ status: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED', daysRemaining, label }`

### 12.6 `utils/nprFormat.ts`

- Multi-currency formatting: configurable code, locale, position (before/after), decimal places
- `CURRENCY_PRESETS` for common currencies; default NPR

### 12.7 `utils/sessionCache.ts`

- `saveUserSession(user, rootUser, token)` — persists auth state to localStorage
- `saveRecentBootstrapCache(data)` — caches full bootstrap state for instant UI load
- Keys: `inventory_user_session`, `inventory_bootstrap_cache`

---

## 13. Configuration & Environment

### 13.1 Environment Variables (`.env`)

```env
# Server
PORT=3000
NODE_ENV=development
AUTH_TOKEN_SECRET=<auto-generated & persisted if not set>

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

### 13.2 Vite Configuration

- Tailwind CSS 4 via `@tailwindcss/vite` plugin
- Path alias: `@` → project root
- Manual chunks: `vendor-react`, `vendor-icons`, `vendor-motion`, `common-components`, `feature-*`
- HMR can be disabled via `DISABLE_HMR=true`

### 13.3 Build Pipeline

```bash
npm run dev               # Development: tsx watch server/index.ts (Vite dev server + Express)
npm run build             # Production: vite build + esbuild bundle server/index.ts → dist/server.cjs
npm run start             # Production: node dist/server.cjs
npm run lint              # TypeScript check (tsc --noEmit)
npm run setup:pg          # Database setup & migration (Node)
npm run setup:postgres    # Database setup (shell installer)
npm run integrity:check   # Database integrity verification
node scripts/reset_fresh_demo.mjs   # Full reset & reseed
```

---

## 14. Deployment

### 14.1 Docker (Multi-Stage)

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

### 14.2 PM2 (Process Manager)

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'inventory-erp',
    script: 'dist/server.cjs',
    instances: 1,  // Single instance (PostgreSQL connection pool)
    env: { NODE_ENV: 'production', PORT: 3000 }
  }]
};
```

### 14.3 Database Setup Options

```bash
# Option 1: Node setup engine (schema + master + demo data)
npm run setup:pg

# Option 2: Shell script (can auto-install PostgreSQL; Linux/macOS/Windows Git Bash)
npm run setup:postgres

# Option 3: Manual (existing PostgreSQL)
psql -U <user> -d inventory_db -f scripts/schema.sql
```

---

## 15. Known Patterns & Design Decisions

### 15.1 The Bootstrap Pattern

The entire application state is loaded in **one HTTP call** (`GET /api/bootstrap`). This endpoint:
- Accepts `branchId` and `fiscalYearId` query parameters
- Runs 20+ parallel PostgreSQL queries via `Promise.all()`
- Returns all entity arrays + computed financial summary
- Supports branch and fiscal year scoping at the SQL level (not post-filter in JS)

### 15.2 Write-Then-Refresh Pattern

Every mutation writes to **PostgreSQL only** (the single source of truth). After the write commits, an automatic Express hook re-reads every cache table from PostgreSQL (`refreshOperationalCache` over the single `CACHE_LOADS` list) **before** the response is sent, so the caller's next read always sees committed state.

The server's in-memory arrays are pure read caches: they are declared `readonly` so the TypeScript compiler rejects any code that mutates them in place (all updates go through pure copy helpers like `withPrepended`/`withReplaced` and are immediately reconciled by the refresh fan-out). This removes the old dual-write drift problem: the cache can never permanently diverge from the database.

### 15.3 Fiscal Year Data Scoping

When viewing historical fiscal years:
- The bootstrap endpoint fetches from `fiscal_year_opening_stock` instead of current `inventory_stock`
- Stock, transactions, and audit logs are filtered by the fiscal year's AD date range
- Fixed assets are NOT filtered by fiscal year (they persist across years)

### 15.4 Date Handling

- **AD (Gregorian) dates** are the source of truth — stored as `DATE` in PostgreSQL, parsed as plain `'YYYY-MM-DD'` strings (not JS Date objects)
- **BS (Bikram Sambat) dates** are derived from `bs_day_records` table or client-side calendar engine
- Server-side `pg.types.setTypeParser(1082, value => value)` keeps DATE columns as strings
- Both dates appear on most transactional records (`_date_ad` and `_date_bs` columns)

### 15.5 Real-Time Sync

- Server uses **SSE (Server-Sent Events)** at `/api/sync/stream`
- On any mutation, `broadcastChange()` sends an event to all connected SSE clients
- Client debounces (250ms) and triggers `refreshAllData()` on any change
- This enables **real-time multi-user collaboration** without WebSocket complexity

### 15.6 Case-Insensitive Serial Identity

Serial uniqueness is enforced case-insensitively everywhere — DB unique indexes use `lower(...)`, and all application-level duplicate checks, cascade renames and lookups compare `lower(trim(value))`. A device serial, PON or MAC differing only in case is treated as the same identifier.

### 15.7 ID Generation

- Most IDs use `Date.now()`-based patterns: `prod-1694000000000`
- Document numbers are issued from `document_sequence_daily` as `{DOC_TYPE}-{BRANCH}-{YYYYMMDD}{NNNN}` (atomic, per-branch, daily)
- Serial-log rows use stable ids derived from the device serial for idempotent seeding

---

## 16. Quick Reference for New Developers

### Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file
cp .env.example .env

# 3. Setup database (installs schema + master data + demo dataset)
npm run setup:pg

# 4. Start development
npm run dev
# → Opens at http://localhost:3000
```

### First Launch

1. Navigate to `http://localhost:3000`
2. The **LoginModal** detects no users exist → shows Super Admin setup form
3. Create your first Super Admin account (a real account, `is_demo = FALSE`)
4. Demo data (if seeded) can be cleared anytime from Settings

### Demo Accounts

All demo users share password: `Demo@123`

| Email | Role | Branch |
|---|---|---|
| `superadmin@example.com` | SUPER_ADMIN | WH001 (Head Office) |
| `branch1@example.com` | BRANCH_MANAGER | WH001 |
| `branch2@example.com` | BRANCH_MANAGER | BRH01 |
| `inventory1@example.com` | INVENTORY_MANAGER | WH001 |
| `accountant1@example.com` | ACCOUNTANT | WH001 |
| `frontdesk1@example.com` | FRONT_DESK | BRH01 |

### Key Files to Read First

| Order | File | Why |
|---|---|---|
| 1 | `src/types/index.ts` | All data structures — the vocabulary of the system |
| 2 | `scripts/schema.sql` | Full database schema (30 tables) — the data model |
| 3 | `server/src/app.ts` (top section) | Shared state, config wiring, middleware chain |
| 4 | `server/src/models/bootstrap.repo.ts` + `server/src/routes/bootstrap.routes.ts` | The core data-loading mechanism |
| 5 | `src/services/api.ts` | Frontend API client — every backend interaction |
| 6 | `src/utils/permissions.ts` + `permissionMatrixData.ts` | How RBAC is resolved |

### Common Development Tasks

| Task | Files to Modify |
|---|---|
| Add new API endpoint | The matching `server/src/routes/<domain>.routes.ts` (+ `server/src/controllers/` for orchestration) + `client/src/services/api.ts` |
| Add new UI page | `client/src/features/<module>/<Page>.tsx` + register in `App.tsx` + add to `Sidebar.tsx` |
| Add new database table | `scripts/schema.sql` (CREATE TABLE) + `server/src/models/` + route/service wiring + `scripts/setup_db.js` if seeded |
| Add new permission operation | `client/src/utils/permissionMatrixData.ts` (operation + defaults) + `server/src/app.ts` (matrix seed) + `requirePermission` on routes |
| Add new document type | `server/src/config/seedData.ts` (INITIAL_DOCUMENT_NUMBER_CONFIGS) + `scripts/setup_db.js` + `client/src/utils/documentNumbering.ts` |
| Change serial behavior | `server/src/app.ts` (`handleUpdateSerials`, lookup/dual endpoints) + `client/src/features/inventory/SerialLogRegister.tsx` |

---

*End of Handoff Document*
