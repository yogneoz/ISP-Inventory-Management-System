# Enterprise ERP — Production Update & Maintenance Process Guide

This guide details the standard operating procedures for patching production updates, applying database schema migrations, executing rollbacks, and customizing repository branding/tags when self-hosting.

---

## 📖 Table of Contents
1. [Patching Production Updates (PM2 Host)](#1-patching-production-updates-pm2-host)
2. [Patching Production Updates (Docker Container Host)](#2-patching-production-updates-docker-container-host)
3. [Database Schema Updates & Migrations](#3-database-schema-updates--migrations)
4. [Rollback Procedures (Zero-Downtime)](#4-rollback-procedures-zero-downtime)
5. [Architecture Convention: Repository Layer & SQL Guard](#5-architecture-convention-repository-layer--sql-guard)

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

## 5. Architecture Convention: Repository Layer & SQL Guard

> Added 2026-09-22 (branch `refactor/psql-only-reads`, PR #5). This is a code-architecture change only: **no schema changes, no new runtime dependencies, and no API contract changes** — existing patch/rollback procedures in sections 1–4 apply unchanged. (The former branding/template-tags section was removed: it described a one-time AI Studio export flow that no longer applies to this repository.)

### What Changed

All SQL was consolidated into a dedicated repository layer. Every SQL string, column list, and param builder now lives in a per-domain file under `server/src/models/*.repo.ts`:

| Repo file | Domain |
|---|---|
| `bootstrap.repo.ts` | Atomic bootstrap data loading, serial history |
| `masterdata.repo.ts` | Products, suppliers, branches, categories, UOMs, locations, customers |
| `procurement.repo.ts` | Purchase orders, purchase invoices, vendor payments, vendor ledger |
| `shipments.repo.ts` | Inter-branch transfers, receiving, cancel/restore |
| `misc.repo.ts` | Audit trail, transaction logs, approval requests |
| `admin.repo.ts` | Maintenance/recalculation, BS calendar, document numbering, company profile |
| `inventory.repo.ts` | Stock, stock operations, damage, fixed assets, CPE devices, serial lookup/log |
| `auth.repo.ts` | Login, super-admin setup, profile switch, password persistence |
| `reports.repo.ts` | Financial-summary report (composable FY/branch WHERE-scope builders) |
| `permissions.repo.ts` | Permission-matrix persistence |

Controllers (`server/src/controllers/*.controller.ts`) now contain **HTTP concerns only** — request validation, session/authorization, cache updates, audit logging, and response shaping. They execute repo-owned constants, e.g. `pgPool.query(REPO_CONSTANT, params)`, but define no SQL text themselves.

### The No-Inline-SQL Guard

The convention is enforced so it cannot regress:

- **CI**: `.github/workflows/ci.yml` runs `npm run check:no-inline-sql` as a dedicated step after `npm test`. A build fails if any controller contains raw SQL.
- **Locally**: run the same check any time:
  ```bash
  npm run check:no-inline-sql
  # ✅ No raw SQL literals in 11 controller file(s).
  ```
- **When it fails**: the output lists `file:line` for each SQL-looking literal. Move the statement (and its param builder) into the matching `server/src/models/<domain>.repo.ts`, import it in the controller, and re-run the check.

The scanner is lexical: it ignores SQL text inside comments and template interpolations, and it does not flag English prose that merely starts with a keyword (it requires SQL structure like `UPDATE … SET` / `DELETE … FROM`).

### Verification Performed

- `npx tsc --noEmit` clean; unit tests grew from 174 to **296** (every repo has a dedicated `tests/<domain>.repo.test.ts` verifying SQL text and param ordering without a live database)
- API smoke test (**15/15**, including live DB constraint probes) re-run against a live server after each domain extraction

### Maintenance Impact

- **New SQL goes in a repo file, not a controller.** Controllers are still the right place for orchestration.
- Query text moved byte-identically from controllers; behavior is unchanged, so no data migration or downtime accompanies this change.
- Docs: architecture details live in `handoff.md` §15.8; developer task routing in §16.

---

*Generated for Inventory Management System Production Operations*
