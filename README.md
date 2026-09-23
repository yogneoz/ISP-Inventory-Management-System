# Enterprise ERP & Multi-Branch Inventory Management System

A full-featured enterprise inventory tracking, physical stock audit, and multi-branch resource planning solution built for **React 19, TypeScript, Tailwind CSS** with **Node.js/Express** and **PostgreSQL**. Purpose-built for **ISP / fiber-network operations in Nepal**.

---

## 🌟 Key Features

- **Clean Production Readiness**: Zero hardcoded mock operational data at runtime. Demo data is seeded only by the setup scripts (`is_demo = TRUE`), keeping real rows untouched.
- **Multi-Branch & Multi-Warehouse Operations**: Manage central headquarters alongside satellite branches with independent stock tracking, reorder levels, and inter-branch shipments.
- **Serial Log Register**: One row per physical device serial (Device Serial / PON Serial / MAC Address) with full lifecycle history, converged from purchases, shipments, stock operations and customer assignments. Includes:
  - **Authoritative duplicate prevention** — a serial that exists on another device (checked case-insensitively across `serial_log`, `customer_device_records` and `fixed_assets`) can never be saved.
  - **Dual-panel conflict resolution** — typing a conflicting serial expands the edit modal side-by-side so both devices can be corrected in one pass (full A↔B swaps supported, applied atomically park-then-apply on the server).
  - **Cross-table cascade** — a correction propagates to every table holding the serial (customer devices, purchase invoices, shipments, stock operations).
- **Physical Stock Count & Reconciliation Audit**:
  - Perform stock counting across branches with variance calculation (shortage/excess).
  - Financial impact calculation, discrepancy reasoning, and automated stock adjustment posting.
  - CSV export for physical audit records.
- **Fiscal Year Closing & Lock Wizard**:
  - 5-step guided wizard for year-end inventory valuation, fixed asset depreciation posting, trial balance roll-forward, and IRD period locking.
  - Super Admin re-authentication and downloadable official IRD Audit Closing Certificate.
- **Role-Based Access Control (RBAC)**: 9 roles × 42 operations permission matrix, editable in-app and persisted server-side in the `permission_matrix` table (with client-side caching).
- **Vendor Ledger & Payments**: Vendor payments sub-ledger with bank/cheque details, partial payments, payment reversal, and a full vendor ledger report with running balances.
- **Stock Movement Ledger & Transaction Logs**: Complete audit trail for stock receipts, dispatches, issues, transfers, damage pullouts, and manual adjustments.
- **Consumable & Fixed Asset Management**:
  - Consumable Stock Out & Issue logging with work order and technician tagging.
  - Consumables Issue Register: searchable ledger of consumable issues with branch/status filters, expandable line items, CSV export, and safeguarded reversal (mandatory reason, stock returned, audit-logged).
  - Fixed Asset Register with depreciation schedules (Straight Line, Declining Balance, Written Down Value) and automated Income Tax Act rates.
  - ERP-style asset dates: supplier invoice date, capitalization date, and placed-in-service date. Depreciation starts from the placed-in-service date and is persisted in PostgreSQL.
- **Serial, MAC, PON & Customer Device Tracking**:
  - Assign ONUs/routers to customers with PON serial number, MAC address, and warranty tracking.
  - Multi-tier approval workflows for device returns, disconnection refunds, and restock.
- **Purchase Orders, Invoices & Shipments**: Draft, approve, and receive purchase orders with suppliers, manage VAT purchase invoices, and track inter-branch shipments.
- **Nepali Fiscal Calendar Support**: Native support for BS calendar conversion (AD/BS), Bikram Sambat months, and Nepali fiscal year reporting (2078–2085 BS seeded).
- **Financial Statements & Tax Registers**: Income statement, balance sheet, trial balance, VAT purchase register, and depreciation schedules.
- **Real-Time Multi-User Sync**: Server-Sent Events (SSE) broadcast every mutation to all connected clients, which re-sync through a single atomic bootstrap endpoint.
- **Automated PostgreSQL Setup**: Built-in automated shell and Node.js setup scripts (`npm run setup:pg`) that can install, configure PostgreSQL, migrate all **30 relational database tables**, and optionally seed a linked demo dataset.

---

## 📂 Project Architecture & Directory Structure

```
.
├── src/                              # React 19 + TypeScript Frontend
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx            # Header with profile switching, notifications, date mode
│   │   │   └── Sidebar.tsx           # Multi-level rail navigation & submenus
│   │   └── common/                   # LoginModal, GlobalSearchModal, ProfileSwitchModal,
│   │                                 # BarcodeScannerModal, NotificationCenter, TablePagination, ...
│   ├── features/
│   │   ├── dashboard/                # Dashboard KPIs & charts
│   │   ├── inventory/                # Products, stock, SerialLogRegister, audits, imports
│   │   ├── procurement/              # Suppliers, POs, invoices, receiving, shipments
│   │   ├── sales/                    # Customer directory & device assignment
│   │   ├── finance/                  # Assets, financial statements, VAT, fiscal years, vendor ledger
│   │   └── settings/                 # Branches, users, permissions, approvals, maintenance
│   ├── services/
│   │   └── api.ts                    # Typed API client (fetch + SSE subscription)
│   ├── types/
│   │   └── index.ts                  # Shared TypeScript interfaces
│   ├── utils/                        # BS/AD calendar, depreciation, document numbering,
│   │                                 # permissions matrix data, session cache, currency formatting
│   └── App.tsx                       # Root application shell (state, routing, SSE)
│
├── server/
│   ├── db.ts                         # PostgreSQL pool (DATE columns parsed as 'YYYY-MM-DD')
│   ├── index.ts                      # Network bootstrap (app creation, routes, listen)
│   └── src/
│       ├── app.ts                    # App composition, shared runtime state, caches, SSE
│       ├── routes/                   # Thin route forwarders (no business logic)
│       ├── controllers/              # HTTP orchestration only — no SQL text (CI-enforced)
│       ├── services/                 # Core business logic (serial editing, damage lifecycle)
│       ├── models/                   # Repository layer — every SQL string + param builder
│       │   └── *.repo.ts             #   per domain: bootstrap, masterdata, procurement,
│       │                             #   shipments, misc, admin, inventory, auth,
│       │                             #   reports, permissions
│       ├── middleware/               # Auth, PG gate, fiscal lock, RBAC, branch scope
│       ├── errors/                   # ApiError + central error handler
│       ├── config/                   # BS calendar + seed data
│       └── utils/                    # Shared server helpers
│
├── scripts/                          # Database Automation Scripts
│   ├── schema.sql                    # Full PostgreSQL schema — 30 tables, idempotent, safe to re-run
│   ├── setup_db.js                   # Node.js setup: schema + master data + demo dataset + FY backfill
│   ├── setup_postgres.sh             # Shell: auto-install & configure PostgreSQL (Linux/macOS/Windows)
│   ├── demo_dataset.js               # Linked demo dataset (is_demo = TRUE)
│   ├── integrity_check.mjs           # Database integrity verification
│   ├── check_no_inline_sql.ts        # CI guard: fails if controllers contain raw SQL
│   └── reset_fresh_demo.mjs          # Full reset & re-seed while preserving the BS calendar
│
├── server/                           # Backend (Node.js + Express) — index.ts bootstrap,
│                                     #   src/{app,routes,controllers,services,middleware,models,config,errors,utils}
├── client/                           # Frontend (Vite root) — index.html + src/
├── server.ts                         # Root shim re-exporting server/src/app (legacy entry)
├── ecosystem.config.js               # PM2 Process Manager Configuration for Production
├── Dockerfile                        # Production Docker Multi-Stage Build
├── .env.example                      # Environment configuration template
└── package.json                      # Frontend Vite / React & Server Dependencies
```

---

## 🚀 Complete Installation & Setup Guide

### 📋 Prerequisites
- **Node.js**: `v20.x` or `v22.x` LTS recommended ([Download Node.js](https://nodejs.org/))
- **npm**: `v10.x+` (comes bundled with Node.js)
- **Git**: Installed and configured
- **PostgreSQL** *(required)*: `v14+` (can be auto-installed via `npm run setup:pg`)

---

### Step 1: Clone the Repository & Install Dependencies

```bash
git clone https://github.com/your-organization/inventory-management-system.git
cd inventory-management-system

npm install
```

---

### Step 2: Configure Environment Variables

Copy `.env.example` to create your local `.env` file:

```bash
cp .env.example .env
```

Review or adjust `.env` parameters as needed:

```env
# Server Port
PORT=3000
NODE_ENV=development

# PostgreSQL Connection Settings (replace with your own credentials)
DATABASE_URL="postgres://inventory_user:<YOUR_DB_PASSWORD>@localhost:5432/inventory_db"
POSTGRES_HOST="localhost"
POSTGRES_PORT="5432"
POSTGRES_DB="inventory_db"
POSTGRES_USER="inventory_user"
POSTGRES_PASSWORD="<YOUR_DB_PASSWORD>"

# Optional: seed demo data on first launch (the setup scripts also seed it)
SEED_DUMMY_DATA=false
```

---

### Step 3: Database Setup & Migration (PostgreSQL)

Run the built-in automatic database setup engine:

```bash
npm run setup:pg
```

**What this script does:**
1. Connects to PostgreSQL (falls back to the shell installer `setup_postgres.sh` on Linux/macOS if unreachable).
2. Applies `scripts/schema.sql` — all **30 tables**, constraints, foreign keys, and indexes (fully idempotent, atomic).
3. Seeds fiscal years, the Bikram Sambat calendar (2078–2085 BS), UOMs, document-numbering configs, company profile, branches, and example user accounts.
4. Seeds the linked demo dataset (products, stock, serial log, fixed assets, purchase orders/invoices, vendor payments) with `is_demo = TRUE`.
5. Backfills `fiscal_year_id` on transactional rows from their AD dates.

The application requires PostgreSQL to be available. It does not use local file storage or an in-memory database fallback.

---

### Step 4: Run Development Server

```bash
npm run dev
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## 🔑 Initial Login Credentials

### Demo Password

All pre-seeded example accounts share the demo password:

| Field | Value |
| :--- | :--- |
| **Password** | `Demo@123` |

> **Security Note**: Demo accounts exist so the app is testable out of the box. Change these passwords or delete the demo users before going live. Your own Super Admin account (created during first-launch setup when no users exist) is a real account, not a demo one.

### 🧪 Seeded Example Accounts

All seeded accounts, branches, locations, suppliers, and operational records are **dummy data** (`is_demo = TRUE`) for testing.

| Email | Role | Branch |
| :--- | :--- | :--- |
| `superadmin@example.com` | SUPER_ADMIN | WH001 (Head Office) |
| `branch1@example.com` | BRANCH_MANAGER | WH001 |
| `branch2@example.com` | BRANCH_MANAGER | BRH01 |
| `inventory1@example.com` | INVENTORY_MANAGER | WH001 |
| `accountant1@example.com` | ACCOUNTANT | WH001 |
| `frontdesk1@example.com` | FRONT_DESK | BRH01 |

---

## 🧹 Managing Demo vs. Clean Operational Data

### Fixed Asset Accounting Dates

Fixed assets are separate from inventory opening stock. The system records:

- **Purchase invoice date**: supplier document date used for invoice/datewise reporting.
- **Capitalization date**: date the purchase is recognized as a fixed asset.
- **Placed-in-service date**: date depreciation begins.
- **Fiscal year**: derived from the asset's accounting period.

The Fixed Asset Register and Depreciation Register calculate from the placed-in-service date and selected fiscal-year reporting date. They do not use Stock Movement Ledger opening quantities.

### Administrative Recalculation & Repair

Super Admins can run separate, audited maintenance operations (**Settings → Data Recalculation & Maintenance**):

1. **Recalculate Fixed Assets** — persists accumulated depreciation and NBV from asset dates, cost, rate, and method.
2. **Recalculate Live Stock** — restores live quantities from the latest reliable stock transaction without rewriting transaction history.
3. **Recalculate BS Day Records** — rebuilds the day-by-day BS calendar mapping.
4. **Repair Fiscal-Year Links** — re-links transactional rows whose `fiscal_year_id` is missing.

Run these after an import correction or database migration, preferably during a controlled maintenance window.

### Resetting a Database for Demo Testing

To recreate the demo database from scratch, drop/recreate `inventory_db`, then run `npm run setup:pg`.

### Default Clean Mode
The application seeds **example master branches only** (Branch 1 `WH001`, Branch 2 `BRH01`) plus fiscal years at minimum, so you can immediately begin importing your real products or entering stock.

### Clearing Demo Data
If demo data was previously loaded or tested, you can clear all demo records at any time (including demo branches, demo users, and all demo operational records):
1. Navigate to **System Settings** → **Maintenance & Data Management**.
2. Click **"Clear Demo Data"**.
3. All mock products, stock balances, test customer devices, invoices, audit records, demo branches, and demo users will be purged.
4. The cleanup persists directly in PostgreSQL, guaranteeing that demo data will not reload on server restarts.

> **Note**: The "Clear Demo Data" action removes all rows where `is_demo = TRUE`. Real business data (rows where `is_demo = FALSE`) is never touched. If you created your own Super Admin account during first-launch setup, it remains because it has `is_demo = FALSE`.

### 🔄 Full Reset to a Fresh Demo State
To wipe **all** records (including users, branches, and locations) while **preserving the Nepali (BS) calendar reference tables**, then reseed the example dataset:

```bash
node scripts/reset_fresh_demo.mjs
```

After running it, restart the server (`npm run dev`) and log in with the demo credentials above (or your own account, if it was preserved).

### 🔍 Database Integrity Check

```bash
npm run integrity:check
```

---

## 🏭 Production Deployment Guide (Ubuntu / Debian VPS)

### 📋 Recommended Server Specifications
- **OS**: Ubuntu 22.04 LTS / 24.04 LTS or Debian 12
- **CPU**: 2 vCPUs minimum (4 vCPUs recommended)
- **RAM**: 4 GB minimum (8 GB recommended)
- **Disk**: 20 GB SSD / NVMe minimum

---

### Step 1: Install Server Packages

```bash
# Update System Packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS & Build Tools
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential git nginx postgresql postgresql-contrib

# Install PM2 Process Manager globally
sudo npm install -g pm2

# Install Certbot for SSL Certificates
sudo apt install -y certbot python3-certbot-nginx
```

---

### Step 2: Configure PostgreSQL Database

```bash
# Switch to postgres user and open PostgreSQL prompt
sudo -u postgres psql
```

Execute SQL commands (replace the password with a strong value of your choice):
```sql
CREATE DATABASE inventory_db;
CREATE USER inventory_user WITH PASSWORD '<YOUR_STRONG_PASSWORD>';
GRANT ALL PRIVILEGES ON DATABASE inventory_db TO inventory_user;
\c inventory_db
GRANT ALL ON SCHEMA public TO inventory_user;
\q
```

Import the database schema:
```bash
cd /var/www/inventory-management-system
PGPASSWORD='<YOUR_STRONG_PASSWORD>' psql -h localhost -U inventory_user -d inventory_db -f scripts/schema.sql
```

---

### Step 3: Production Build

```bash
cd /var/www/inventory-management-system

# Install dependencies (including dev tools for building)
npm install

# Build static Vite bundle and standalone server binary
npm run build
```

This generates:
- `dist/`: Optimized frontend static assets.
- `dist/server.cjs`: Standalone bundled Node.js backend server with embedded source maps.

---

### Step 4: Start & Manage with PM2

```bash
# Start the application using PM2 ecosystem file
pm2 start ecosystem.config.js

# Save PM2 state and configure systemd auto-start on reboot
pm2 save
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp /home/$USER
```

---

### Step 5: Configure Nginx Reverse Proxy & SSL

1. Create Nginx site configuration:
```bash
sudo nano /etc/nginx/sites-available/enterprise-erp
```

2. Add the reverse proxy configuration (replace `erp.yourdomain.com` with your actual domain):
```nginx
server {
    listen 80;
    server_name erp.yourdomain.com;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

3. Enable site and test configuration:
```bash
sudo ln -s /etc/nginx/sites-available/enterprise-erp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

4. Enable free Let's Encrypt SSL:
```bash
sudo certbot --nginx -d erp.yourdomain.com
```

---

### 🐳 Alternative: Docker Deployment

```bash
# Build multi-stage Docker image
docker build -t inventory-erp:latest .

# Run container
docker run -d \
  --name inventory-erp-app \
  --restart always \
  -p 3000:3000 \
  --env-file .env \
  inventory-erp:latest
```

---

## 🛠️ Operational Commands Reference

| Action | Command |
| :--- | :--- |
| **Development Server** | `npm run dev` |
| **Type Check & Lint** | `npm run lint` |
| **Unit Tests** | `npm test` |
| **Repo-Layer Guard (no SQL in controllers)** | `npm run check:no-inline-sql` |
| **Production Build** | `npm run build` |
| **Start Production Server** | `npm start` |
| **Automated DB Setup (Node)** | `npm run setup:pg` |
| **Automated DB Setup (Shell)** | `npm run setup:postgres` |
| **Database Integrity Check** | `npm run integrity:check` |
| **API Smoke Test** *(server must be running)* | `npm run smoke` |
| **Write-Latency Benchmark** *(server must be running)* | `npm run bench:write` |
| **Full Demo Reset** | `node scripts/reset_fresh_demo.mjs` |
| **PM2 Process Status** | `pm2 status` |
| **View Server Logs** | `pm2 logs enterprise-erp` |
| **Restart Application** | `pm2 restart enterprise-erp` |
| **PostgreSQL Backup** | `pg_dump -U inventory_user -h localhost inventory_db > backup_$(date +%Y%m%d).sql` |

---

## 📡 Paged Register Endpoints

Large ledgers are **not** shipped wholesale through `GET /api/bootstrap`. Each
register below is served by its own list endpoint with server-side filtering
and pagination, so the client loads exactly one page of rows at a time.

| Register | Endpoint | Status |
| :--- | :--- | :--- |
| Serial Log Register | `GET /api/serial-log` | **Trimmed from bootstrap** — the register is the endpoint's only consumer, so the table no longer ships in the bootstrap payload at all |
| Consumables Issue Register | `GET /api/stock-operations?type=CONSUMABLE_ISSUE` | Paged endpoint available; the table still ships in bootstrap for other consumers |
| Purchase Orders Register | `GET /api/purchase-orders` | Paged endpoint available; the table still ships in bootstrap for other consumers |
| Purchase Invoices Register | `GET /api/purchase-invoices` | Paged endpoint available; the table still ships in bootstrap for other consumers |

### Request parameters (all optional)

| Parameter | Meaning |
| :--- | :--- |
| `page`, `pageSize` | 1-indexed page and page size (clamped to 1–500). Omit `page` to get the legacy full-array response. |
| `query` | Free-text search — covers document/reference numbers, names, remarks, and the JSONB `items` blob. |
| `branchId` | Branch filter (scoped reads are enforced server-side per role). |
| `status` / `paymentStatus` | Register-specific status filter. |
| `dateFromAD`, `dateToAD` | Inclusive AD date bounds (`YYYY-MM-DD`) on the register's date column. |
| `all=1` | Return **every** filtered row (used by CSV export). |

### Response envelope (paged mode)

```json
{
  "data": [ ...rows for this page... ],
  "page": 1,
  "pageSize": 20,
  "totalItems": 1234,
  "statusCounts": { "IN_STOCK": 7, "DAMAGED": 2 },
  "pendingValue": 141250,
  "receivedValue": 0,
  "sums": { "taxable": 197500, "vat": 25675, "grand": 223175, "unpaid": 147750 }
}
```

- `statusCounts` powers the register's KPI cards; `pendingValue`/`receivedValue`
  (purchase orders) and `sums` (purchase invoices) are SQL aggregates over the
  **full filtered set**, so metrics stay exact even when one page is displayed.
- Omitting `page` returns the legacy plain array — older consumers (dashboard,
  movement ledger, FY closing wizard) keep working unchanged.
- New SQL for these endpoints lives in the repo layer (`server/src/models/*.repo.ts`);
  controllers only assemble the envelope. Filters are validated (date format,
  page clamping) before they reach SQL.

---

## 📄 License

This project is licensed under the MIT License.
