# Enterprise ERP & Multi-Branch Inventory Management System

A full-featured enterprise inventory tracking, physical stock audit, and multi-branch resource planning solution built for **React 19, TypeScript, Tailwind CSS** with **Node.js/Express** and **PostgreSQL / Django REST Framework**.

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
- **Serial, MAC, PON & Customer Device Tracking**:
  - Assign ONUs/routers to customers with PON serial number, MAC address, and warranty tracking.
  - Multi-tier approval workflows for device returns, disconnection refunds, and restock.
- **Purchase Orders, Invoices & Shipments**: Draft, approve, and receive purchase orders with suppliers, manage VAT purchase invoices, and track inter-branch shipments.
- **Nepali Fiscal Calendar Support**: Native support for BS calendar conversion (AD/BS), Bikram Sambat months, and Nepali fiscal year reporting.
- **Financial Statements & Tax Registers**: Income statement, balance sheet, trial balance, VAT purchase register, and depreciation schedules.
- **Automated PostgreSQL Setup**: Built-in automated shell and Node.js setup scripts (`npm run setup:pg`) to automatically download, install, configure PostgreSQL, and migrate 19 relational database tables.

---

## 📂 Project Architecture & Directory Structure

```
.
├── src/                          # React 19 + TypeScript Frontend
│   ├── components/               # UI Views and Modals
│   ├── services/api.ts           # REST client (Bearer session tokens)
│   ├── types/                    # Shared TypeScript Interfaces
│   ├── utils/                    # BS/AD Calendar, permissions, session cache
│   └── App.tsx                   # Main React Application shell
│
├── server/                       # Modular Express backend
│   ├── store.ts                  # In-memory domain state + JSON persistence
│   ├── lib/
│   │   ├── auth.ts               # Session middleware, RBAC, audit helper
│   │   ├── authUtils.ts          # bcrypt, BS date stamps, role aliases
│   │   ├── sessionStore.ts       # Redis sessions (memory fallback)
│   │   ├── db.ts                 # PostgreSQL / pg-mem pool + transactions
│   │   ├── dbBootstrap.ts        # Schema sync, indexes, seed
│   │   ├── sync.ts               # SSE live broadcast
│   │   └── ai.ts                 # Gemini client helper
│   └── routes/                   # Domain route modules (auth, stock, POs, …)
│
├── scripts/                      # Database Automation Scripts
│   ├── schema.sql
│   ├── setup_postgres.sh
│   └── setup_db.js
│
├── server.ts                     # Thin entrypoint (Express + Vite middleware)
├── ecosystem.config.js           # PM2 (cluster-ready when REDIS_URL is set)
├── Dockerfile
├── .env.example
└── package.json
```

---

## 🚀 Complete Installation & Setup Guide

### 📋 Prerequisites
- **Node.js**: `v20.x` or `v22.x` LTS recommended ([Download Node.js](https://nodejs.org/))
- **npm**: `v10.x+` (comes bundled with Node.js)
- **Git**: Installed and configured
- **PostgreSQL** *(Optional, recommended for production)*: `v14+` or `v15+` (can be auto-installed via `npm run setup:pg`)

---

### Step 1: Clone the Repository & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/your-organization/izone-enterprise-erp.git
cd izone-enterprise-erp

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

# PostgreSQL Connection Settings
DATABASE_URL="postgres://inventory_user:securepassword@localhost:5432/inventory_db"
POSTGRES_HOST="localhost"
POSTGRES_PORT="5432"
POSTGRES_DB="inventory_db"
POSTGRES_USER="inventory_user"
POSTGRES_PASSWORD="securepassword"

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
3. Migrates all 19 relational tables, constraints, foreign keys, and indexes from `scripts/schema.sql`.
4. Populates Bikram Sambat (BS) calendar reference tables (2078 BS to 2085 BS) and Fiscal Year periods.

*(Note: The system also includes resilient local file storage `.data_store.json`, so the app operates seamlessly even if PostgreSQL is offline or starting up).*

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

On **first launch** (empty user store), the login screen opens a **Create Super Admin** wizard. Choose a strong password (**minimum 8 characters**). Passwords are stored as **bcrypt hashes**; API access requires a **Bearer session token** issued at login (spoofable `x-user-role` headers are no longer trusted).

If a local data store already contains seed users, example accounts may look like:

| Field | Example Value |
| :--- | :--- |
| **Email** | `superadmin@izone.net.np` |
| **Password** | *(the password set for that account — change immediately)* |
| **Role** | `SUPER_ADMIN` |
| **Branch** | Head Office (Urlabari) |

> **Security Note**: Change all default/demo passwords under **User Management**. Session tokens expire after 12 hours of activity (sliding). Set `REDIS_URL` to share sessions across PM2 workers; without Redis the server falls back to in-memory sessions automatically.

---

## 🧹 Managing Demo vs. Clean Operational Data

### Default Clean Mode
By default, the application starts with **0 products, 0 stock records, 0 customer devices, 0 POs, and 0 transaction logs**. Master branches (19 actual telecom branches) and Fiscal Years are preserved so you can immediately begin importing your real products or entering stock.

### Clearing Demo Data
If demo data was previously loaded or tested, you can clear all operational demo records at any time:
1. Navigate to **System Settings** -> **Maintenance & Data Management**.
2. Click **"Clear Demo Data"**.
3. All mock products, stock balances, test customer devices, invoices, and audit records will be purged, leaving your Super Admin accounts, branch structure, and fiscal year configurations intact.
4. The system writes `isDemoDataCleared: true` to `.data_store.json`, guaranteeing that demo data will never reload on server restarts.

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

Execute SQL commands:
```sql
CREATE DATABASE inventory_db;
CREATE USER inventory_user WITH PASSWORD 'YourVeryStrongProductionPassword123!';
GRANT ALL PRIVILEGES ON DATABASE inventory_db TO inventory_user;
\c inventory_db
GRANT ALL ON SCHEMA public TO inventory_user;
\q
```

Import the database schema:
```bash
cd /var/www/izone-enterprise-erp
PGPASSWORD='YourVeryStrongProductionPassword123!' psql -h localhost -U inventory_user -d inventory_db -f scripts/schema.sql
```

---

### Step 3: Production Build

```bash
cd /var/www/izone-enterprise-erp

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
docker build -t izone-erp:latest .

# Run container
docker run -d \
  --name izone-erp-app \
  --restart always \
  -p 3000:3000 \
  --env-file .env \
  izone-erp:latest
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
