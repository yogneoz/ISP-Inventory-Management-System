# Enterprise ERP & Multi-Branch Inventory Management System

A full-featured enterprise inventory tracking, physical stock audit, and multi-branch resource planning solution built for **React 19, TypeScript, Tailwind CSS** with **Node.js/Express** and **PostgreSQL**.

---

## 🌟 Key Features

- **Clean Production Readiness**: Zero hardcoded mock operational data on first run. Starts with pristine, empty inventory registers while maintaining master branches and fiscal periods.
- **Multi-Branch & Multi-Warehouse Operations**: Manage central headquarters alongside satellite branches with independent stock tracking, reorder levels, and inter-branch shipments.
- **Physical Stock Count & Reconciliation Audit**:
  - Perform stock counting across branches with variance calculation (shortage/excess).
  - Financial impact calculation, discrepancy reasoning, and automated stock adjustment posting.
  - CSV export for physical audit records.
- **Fiscal Year Closing & Lock Wizard**:
  - 5-Step guided wizard for year-end inventory valuation, fixed asset depreciation posting, trial balance roll-forward, and IRD period locking.
  - Super Admin authorization key check and downloadable official IRD Audit Closing Certificate.
- **Role-Based Access Control (RBAC)**: Support for Super Admin, Inventory Manager, Branch Manager, Front Desk, and Accountant roles with permissions matrix.
- **Stock Movement Ledger & Transaction Logs**: Complete audit trail for stock receipts, dispatches, issues, transfers, damage pullouts, and manual adjustments.
- **Consumable & Fixed Asset Management**:
  - Consumable Stock Out & Issue logging with work order and technician tagging.
  - Fixed Asset Register with Depreciation schedules (Straight Line, Declining Balance, Written Down Value) and automated Income Tax Act rates.
  - ERP-style asset dates: supplier invoice date, capitalization date, and placed-in-service date. Depreciation starts from the placed-in-service date and is persisted in PostgreSQL.
- **Serial, MAC, PON & Customer Device Tracking**:
  - Assign ONUs/routers to customers with PON serial number, MAC address, and warranty tracking.
  - Multi-tier approval workflows for device returns, disconnection refunds, and restock.
- **Purchase Orders, Invoices & Shipments**: Draft, approve, and receive purchase orders with suppliers, manage VAT purchase invoices, and track inter-branch shipments.
- **Nepali Fiscal Calendar Support**: Native support for BS calendar conversion (AD/BS), Bikram Sambat months, and Nepali fiscal year reporting.
- **Financial Statements & Tax Registers**: Income statement, balance sheet, trial balance, VAT purchase register, and depreciation schedules.
- **Automated PostgreSQL Setup**: Built-in automated shell and Node.js setup scripts (`npm run setup:pg`) to automatically download, install, configure PostgreSQL, and migrate 25 relational database tables.

---

## 📂 Project Architecture & Directory Structure

```
.
├── src/                          # React 19 + TypeScript Frontend
│   ├── components/               # UI Views and Modals
│   │   ├── Header.tsx            # Header with Profile Switching & Notifications
│   │   ├── Sidebar.tsx           # Multi-level Rail Navigation & Submenus
│   │   ├── LoginModal.tsx        # Super Admin First-Launch Setup & Login
│   │   ├── PhysicalStockAudit.tsx# Physical Stock Count & Reconciliation Audit View
│   │   ├── FiscalYearClosingWizard.tsx # 5-Step Fiscal Closing & Lock Wizard
│   │   ├── StockOperations.tsx   # Stock Out, Consumable Issue, Pullouts & Adjustments
│   │   ├── CustomerDeviceManagement.tsx # ONU / Router Serial & Customer Assignment
│   │   ├── ApprovalWorkflowCenter.tsx   # Multi-tier Device Return & Refund Approvals
│   │   ├── FixedAssetRegister.tsx# Fixed Assets & Depreciation Register
│   │   ├── NepaliFiscalManagement.tsx # BS Fiscal Calendar & Year Settings
│   │   └── ...
│   ├── types/                    # Shared TypeScript Interfaces (index.ts)
│   ├── utils/                    # BS/AD Calendar Utilities & Permissions
│   └── App.tsx                   # Main React Application shell
│
├── scripts/                      # Database Automation Scripts
│   ├── schema.sql                # PostgreSQL Schema with Indexes, FKs & Asset Date Migrations
│   ├── demo_dataset.js           # Linked demo products, stock and fixed assets
│   ├── setup_postgres.sh         # Shell script for auto-downloading & configuring PostgreSQL
│   └── setup_db.js               # Node.js runner for database setup & migration
│
├── server.ts                     # Full-stack Node.js Express server with Vite middleware
├── ecosystem.config.js           # PM2 Process Manager Configuration for Production
├── Dockerfile                    # Production Docker Multi-Stage Build
├── .env.example                  # Environment configuration template
└── package.json                  # Frontend Vite / React & Server Dependencies
```

---

## 🚀 Complete Installation & Setup Guide

### 📋 Prerequisites
- **Node.js**: `v20.x` or `v22.x` LTS recommended ([Download Node.js](https://nodejs.org/))
- **npm**: `v10.x+` (comes bundled with Node.js)
- **Git**: Installed and configured
- **PostgreSQL** *(required)*: `v14+` or `v15+` (can be auto-installed via `npm run setup:pg`)

---

### Step 1: Clone the Repository & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/your-organization/inventory-management-system.git
cd inventory-management-system

# Install all npm dependencies
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

# Optional: Set to "true" only if you want sample demo data seeded on first launch
SEED_DUMMY_DATA=false
```

---

### Step 3: Database Setup & Migration (PostgreSQL)

You can run the built-in automatic database setup engine:

```bash
npm run setup:pg
```

**What this script does:**
1. Detects your OS (Ubuntu, Debian, CentOS, macOS, Docker) and installs/starts PostgreSQL if not running.
2. Creates the database `inventory_db` and user `inventory_user`.
3. Migrates the relational tables, constraints, foreign keys, indexes, and fixed-asset date columns from `scripts/schema.sql`.
4. Populates Bikram Sambat (BS) calendar reference tables (2078 BS to 2085 BS) and Fiscal Year periods.

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

## 🔑 Initial Super Admin Login Credentials

On first launch, the setup screen lets you create your own Super Admin account. Example pre-seeded administrator:

| Field | Default Value |
| :--- | :--- |
| **Email** | `superadmin@example.com` |
| **Password** | *(set during first-launch setup)* |
| **Role** | `SUPER_ADMIN` |
| **Branch** | Branch 1 (WH001) — Example Location 1 |

> **Security Note**: Change the default password immediately after first login via **User Management** or the profile menu in the header.

### 🧪 Seeded Example (Dummy) Accounts

All seeded accounts, branches, locations, suppliers, and operational records are **dummy data** (`is_demo = TRUE`) for testing. Passwords are assigned during first-launch setup.

| Email | Role | Branch |
| :--- | :--- | :--- |
| `superadmin@example.com` | SUPER_ADMIN | WH001 |
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
- **Fiscal year**: derived from the asset’s accounting period.

The Fixed Asset Register and Depreciation Register calculate from the placed-in-service date and selected fiscal-year reporting date. They do not use Stock Movement Ledger opening quantities. Asset links to products and purchase invoices are retained in PostgreSQL.

### Administrative Recalculation & Repair

Super Admins can open **Administration & Governance → Data Recalculation & Repair** and run separate, audited operations:

1. **Recalculate Fixed Assets** — persists accumulated depreciation and NBV from asset dates, cost, rate, and method.
2. **Rebuild Opening Stock** — creates the next fiscal year’s opening register from a closed year while preserving manual adjustments.
3. **Recalculate Live Stock** — restores live quantities from the latest reliable stock transaction without rewriting transaction history.

Run these after an import correction or database migration, preferably during a controlled maintenance window.

### Resetting a Database for Demo Testing

To recreate the demo database from scratch, drop/recreate `inventory_db`, then run `npm run setup:pg`. The demo fixed asset `ast-car004` is linked to product `prod-car004` and includes purchase, capitalization, and placed-in-service dates.

### Default Clean Mode
The application seeds **example master branches only** (Branch 1 `WH001`, Branch 2 `BRH01`) plus Fiscal Years, so you can immediately begin importing your real products or entering stock.

### Clearing Demo Data
If demo data was previously loaded or tested, you can clear all demo records at any time (including demo branches, demo users, and all demo operational records):
1. Navigate to **System Settings** -> **Maintenance & Data Management**.
2. Click **"Clear Demo Data"**.
3. All mock products, stock balances, test customer devices, invoices, audit records, demo branches, and demo users will be purged.
4. The system persists the cleanup directly in PostgreSQL, guaranteeing that demo data will not reload on server restarts.

> **Note**: The "Clear Demo Data" action removes all rows where `is_demo = TRUE`. Real business data (rows where `is_demo = FALSE`) is never touched. If you created your own Super Admin account during first-launch setup, it will remain because it has `is_demo = FALSE`.

### 🔄 Full Reset to a Fresh Demo State
To wipe **all** records (including users, branches, and locations) while **preserving the Nepali (BS) calendar reference tables**, then reseed the example dataset:

```bash
node scripts/reset_fresh_demo.mjs
```

After running it, restart the server (`npm run dev`) and log in with the credentials you set during first-launch setup.

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
| **Production Build** | `npm run build` |
| **Start Production Server** | `npm start` |
| **Automated DB Setup** | `npm run setup:pg` |
| **PM2 Process Status** | `pm2 status` |
| **View Server Logs** | `pm2 logs enterprise-erp` |
| **Restart Application** | `pm2 restart enterprise-erp` |
| **PostgreSQL Backup** | `pg_dump -U inventory_user -h localhost inventory_db > backup_$(date +%Y%m%d).sql` |

---

## 📄 License

This project is licensed under the MIT License.
