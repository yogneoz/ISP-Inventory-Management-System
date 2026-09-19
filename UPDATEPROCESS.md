# Enterprise ERP — Production Update & Maintenance Process Guide

This guide details the standard operating procedures for patching production updates, applying database schema migrations, executing rollbacks, and customizing repository branding/tags when self-hosting.

---

## 📖 Table of Contents
1. [Patching Production Updates (PM2 Host)](#1-patching-production-updates-pm2-host)
2. [Patching Production Updates (Docker Container Host)](#2-patching-production-updates-docker-container-host)
3. [Database Schema Updates & Migrations](#3-database-schema-updates--migrations)
4. [Rollback Procedures (Zero-Downtime)](#4-rollback-procedures-zero-downtime)
5. [Changing Repository Branding & Template Tags](#5-changing-repository-branding--template-tags)

---

## 1. Patching Production Updates (PM2 Host)

When running the application using **PM2** on a Linux server (Ubuntu/Debian), follow these zero-downtime update steps:

### Step 1: Connect to Production Server
```bash
ssh user@your-server-ip
cd /var/www/enterprise-erp
```

### Step 2: Fetch Latest Code Changes
```bash
# Pull the latest commit from your main production branch
git pull origin main
```

### Step 3: Install New Dependencies (if package.json was modified)
```bash
# Install production & build dependencies
npm install --production=false
```

### Step 4: Rebuild Frontend & Server Bundle
```bash
# Compiles Vite static assets and bundles server.ts to dist/server.cjs
npm run build
```

### Step 5: Reload PM2 Cluster (Zero-Downtime)
Instead of `pm2 restart` which briefly drops connections, use `pm2 reload` to reload instances sequentially in cluster mode without dropping active requests:

```bash
# Reload with zero downtime
pm2 reload ecosystem.config.js

# Verify server status and error logs
pm2 status
pm2 logs enterprise-erp --lines 30
```

---

## 2. Patching Production Updates (Docker Container Host)

If you deployed the application using Docker containers:

### Step 1: Pull & Rebuild Container Image
```bash
cd /var/www/enterprise-erp
git pull origin main

# Build the updated production multi-stage image
docker build -t enterprise-erp:latest .
```

### Step 2: Restart the Container
```bash
# Stop current container
docker stop enterprise-erp
docker rm enterprise-erp

# Launch updated container with environment variables
docker run -d \
  --name enterprise-erp \
  --restart always \
  -p 3000:3000 \
  --env-file .env \
  enterprise-erp:latest
```

---

## 3. Database Schema Updates & Migrations

If a patch includes database changes (e.g., adding a new table or column):

1. **Backup Database First (Mandatory)**:
   ```bash
   PGPASSWORD="YourPassword" pg_dump -U inventory_user -h localhost inventory_db > /var/backups/pre_update_$(date +%Y%m%d_%H%M%S).sql
   ```

2. **Apply Incremental SQL Migration File**:
   ```bash
   # Execute target SQL migration script
   PGPASSWORD="YourPassword" psql -h localhost -U inventory_user -d inventory_db -f scripts/migration_v2.sql
   ```

---

## 4. Rollback Procedures (Zero-Downtime)

If a newly deployed code patch introduces unexpected bugs:

### Fast Code Rollback with Git & PM2:
```bash
# 1. Revert to the previous stable git commit
git log --oneline -n 5
git reset --hard HEAD~1

# 2. Rebuild assets
npm run build

# 3. Reload PM2
pm2 reload ecosystem.config.js
```

### Fast Database Rollback:
```bash
# Restore previous database snapshot if schema was altered
PGPASSWORD="YourPassword" psql -h localhost -U inventory_user -d inventory_db < /var/backups/pre_update_backup.sql
```

---

## 5. Changing Repository Branding & Template Tags

When exporting or pushing this repository from AI Studio to your own GitHub organization, follow these steps to replace the default `google-gemini/aistudio-repository-template` tags and naming.

### Step 1: Update `package.json`
Open `package.json` and customize the project metadata:

```json
{
  "name": "inventory-management-system",
  "version": "1.0.0",
  "description": "Enterprise Multi-Branch Inventory Management System",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/your-org/inventory-management-system.git"
  },
  "author": "Your Company Name",
  "license": "MIT"
}
```

### Step 2: Update `metadata.json`
Open `metadata.json` and set your application title and description:

```json
{
  "name": "Inventory Management System",
  "description": "Multi-Branch Inventory Management System, Hardware Serial Tracking, VAT Register & Fiscal Closing",
  "requestFramePermissions": [
    "camera"
  ],
  "majorCapabilities": [
    "MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API"
  ]
}
```

### Step 3: Update GitHub Repository Settings (GitHub Web UI)
After pushing the code to your GitHub organization:

1. **Rename Repository**:
   - Go to your repository on GitHub: `https://github.com/your-username/aistudio-repository-template`
   - Navigate to **Settings -> General**.
   - Under **Repository name**, change `aistudio-repository-template` to `inventory-management-system` and click **Rename**.

2. **Update About & Topics (Tags)**:
   - On your GitHub repository homepage, click the **⚙️ (Gear Icon)** next to the **About** section on the right sidebar.
   - **Description**: Update description to your system name.
   - **Website**: Set your live production domain (e.g., `https://erp.yourdomain.com`).
   - **Topics**: Remove generic template tags and add relevant topic tags:
     - `erp`, `inventory-management`, `react`, `typescript`, `postgresql`, `express`, `nepal-vat`, `bs-calendar`.

3. **Update Remote Git Origin (on local or server)**:
   ```bash
   git remote set-url origin https://github.com/your-username/inventory-management-system.git
   git remote -v
   ```

---

*Generated for Inventory Management System Production Operations*
