# IZone Enterprise ERP  
### Multi-Branch ISP Inventory, Device Tracking, VAT & Fiscal Management

A full-stack **Node.js + React** enterprise inventory system built for fiber/ISP operators in Nepal.  
It manages multi-branch stock, ONU/router serial tracking, purchase orders, inter-branch transfers, VAT (13%), Bikram Sambat (BS) dates, fixed assets, and fiscal year close.

| | |
|---|---|
| **Backend** | Node.js 20 · Express · TypeScript |
| **Frontend** | React 19 · Vite 6 · Tailwind CSS 4 |
| **Database** | **PostgreSQL 14+** (required in production) |
| **Sessions / SSE** | Redis (recommended for multi-instance) |
| **License** | MIT |

> **Not Django.** The supported production stack is **Express + PostgreSQL**.  
> An experimental Django folder was removed; do not expect a Python API.

---

## Table of contents

1. [Features](#-features)  
2. [Architecture](#-architecture)  
3. [Requirements](#-requirements)  
4. [Quick start](#-quick-start)  
5. [PostgreSQL setup](#-postgresql-setup-required-for-real-data)  
6. [Environment variables](#-environment-variables)  
7. [Production (fail-closed)](#-production-fail-closed-postgres)  
8. [Health probes](#-health-probes)  
9. [Scripts](#-npm-scripts)  
10. [Default login](#-default-login)  
11. [Testing](#-testing)  
12. [Project layout](#-project-layout)  
13. [Documentation](#-documentation)  
14. [Security notes](#-security-notes)  
15. [Troubleshooting](#-troubleshooting)  

---

## Features

- **Multi-branch & warehouse stock** — HQ + satellite branches, reorder levels, valuation  
- **Physical stock audit** — count, variance, financial impact, approval-aware adjustments  
- **Device tracking** — serial / MAC / PON, customer assignment, warranty, exchange workflows  
- **Procurement** — purchase orders, VAT purchase invoices (13%), payments  
- **Logistics** — inter-branch shipments/transfers with receive & cancel  
- **Stock operations** — pullout, damage, consumable issue, stock-out, asset assign  
- **Fixed assets** — register, depreciation (SLM / declining / WDV)  
- **Nepali fiscal calendar** — AD↔BS conversion, FY periods, closing wizard  
- **RBAC** — Super Admin, Inventory Manager, Branch Manager, Front Desk, Accountant  
- **Approvals** — multi-tier device/status/transfer/audit workflows  
- **Audit & stock ledger** — full movement and action trails  
- **Security baseline** — bcrypt passwords, Bearer sessions, Zod validation, rate limits  
- **Durable writes** — Postgres-first; failed DB writes return **503** and roll back memory  

---

## Architecture

```
Browser (React SPA)
    │  same-origin /api/*
    ▼
Express (server.ts → server/)
    ├── Auth (bcrypt + Bearer tokens)
    ├── Domain routes (stock, PO, shipments, …)
    ├── writeThroughPg / readPgOrStore
    ▼
PostgreSQL  ◄── primary source of truth (production)
    │
Redis (optional) ── sessions + multi-instance SSE
```

| Mode | When | Durable? |
|---|---|---|
| **`postgres`** | Real DB reachable | **Yes — use this** |
| **`pg-mem`** | Dev fallback only | No |
| **`memory` + `.data_store.json`** | Offline demo only | File only |

In **`NODE_ENV=production`** the app **does not** silently use pg-mem/JSON.  
It **exits on startup** if PostgreSQL is unreachable (unless `ALLOW_DB_FALLBACK=true`).

---

## Requirements

| Software | Version |
|---|---|
| **Node.js** | 20.x or 22.x LTS |
| **npm** | 10+ |
| **PostgreSQL** | 14+ (15+ recommended) |
| **Redis** | 6+ (recommended for production / PM2 cluster) |
| **Git** | any recent |

---

## Quick start

### 1. Clone & install

```bash
git clone https://github.com/yogneoz/ISP-Inventory-Manamemnt-System.git
cd ISP-Inventory-Manamemnt-System
npm install
cp .env.example .env
```

### 2. Start PostgreSQL and apply schema

```bash
# Install/configure local Postgres (may need sudo) + create DB/user
npm run setup:postgres

# Apply schema / seed helpers
npm run setup:pg
npm run migrate
```

### 3. Configure `.env`

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://inventory_user:securepassword@localhost:5432/inventory_db
# Optional but recommended once DB works:
# REQUIRE_POSTGRES=true
# REDIS_URL=redis://localhost:6379/0
SEED_DUMMY_DATA=false
```

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3000**

### 5. Confirm database mode

```bash
curl -s http://localhost:3000/api/health | jq .database
```

You want:

```json
{ "mode": "postgres", "durable": true, "ready": true, "ping": "ok" }
```

If you see `pg-mem` or `memory`, you are **not** on a real durable database.

---

## PostgreSQL setup (required for real data)

The app **connects** to Postgres; it does **not** embed a Postgres engine in Node.

| Command | Purpose |
|---|---|
| `npm run setup:postgres` | Try to install/start Postgres (apt/yum/brew/docker), create DB + user |
| `npm run setup:pg` | Node setup against the DB (schema helpers) |
| `npm run migrate` | Apply `scripts/migrations/*.sql` |
| `scripts/schema.sql` | Full baseline schema (19 tables) |

### Manual Postgres (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib

sudo -u postgres psql <<'SQL'
CREATE USER inventory_user WITH PASSWORD 'securepassword';
CREATE DATABASE inventory_db OWNER inventory_user;
GRANT ALL PRIVILEGES ON DATABASE inventory_db TO inventory_user;
\c inventory_db
GRANT ALL ON SCHEMA public TO inventory_user;
SQL

PGPASSWORD=securepassword psql -h localhost -U inventory_user -d inventory_db -f scripts/schema.sql
```

### Docker Postgres

```bash
docker run -d --name izone-pg \
  -e POSTGRES_DB=inventory_db \
  -e POSTGRES_USER=inventory_user \
  -e POSTGRES_PASSWORD=securepassword \
  -p 5432:5432 \
  postgres:15-alpine
```

Then set `DATABASE_URL` and run `npm run migrate`.

---

## Environment variables

Full template: **`.env.example`**

### Critical

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string (preferred) |
| `POSTGRES_HOST` / `PORT` / `DB` / `USER` / `PASSWORD` | Alternative to `DATABASE_URL` |
| `NODE_ENV` | `production` → **fail-closed** (Postgres required) |
| `REQUIRE_POSTGRES` | `true` forces Postgres in any environment |
| `ALLOW_DB_FALLBACK` | `true` allows pg-mem/JSON in production (**not recommended**) |
| `REQUIRE_MIGRATIONS` | `true` → migration failure aborts boot |
| `REDIS_URL` | Shared sessions + SSE across PM2 workers |
| `PORT` | HTTP port (default `3000`) |

### Security / ops

| Variable | Description |
|---|---|
| `STRICT_PASSWORD_POLICY` | Require upper/lower/digit/symbol |
| `MIN_PASSWORD_LENGTH` | Default 8 (use 10+ in production) |
| `LOGIN_RATE_LIMIT_MAX` | Login attempts per window |
| `API_RATE_LIMIT_MAX` | General API throttle |
| `TRUST_PROXY` | Set `true` behind Nginx |
| `LOG_LEVEL` | pino level (`info`, `debug`, …) |
| `SEED_DUMMY_DATA` | `true` only for demos |
| `GEMINI_API_KEY` | Optional AI assistant |

---

## Production (fail-closed Postgres)

**Full checklist:** [docs/DEPLOY_CHECKLIST.md](docs/DEPLOY_CHECKLIST.md)  
**Hardening notes:** [docs/PRODUCTION.md](docs/PRODUCTION.md)

### Build & run

```bash
npm ci
npm run migrate
npm run build
npm start
# or
pm2 start ecosystem.config.js
```

### Expected boot log

```text
✅ Database mode: real PostgreSQL (primary write path).
✅ PostgreSQL primary ready — schema synced, store hydrated from database.
Database: mode=postgres durable=true requirePostgres=true
```

If Postgres is down, the process should **exit with code 1** — it must not serve fake storage as production.

### PM2 / Docker defaults

- `ecosystem.config.js` sets `REQUIRE_POSTGRES=true`, `REQUIRE_MIGRATIONS=true`  
- `Dockerfile` same; includes `HEALTHCHECK` on `/api/health/ready`  
- Only raise `PM2_INSTANCES` after `REDIS_URL` is configured  

### Docker run example

```bash
docker build -t izone-erp:latest .
docker run -d --name izone-erp \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgres://inventory_user:SECRET@host.docker.internal:5432/inventory_db \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  -e REQUIRE_POSTGRES=true \
  izone-erp:latest
```

---

## Health probes

| Endpoint | Use | Success |
|---|---|---|
| `GET /api/health/live` | Process liveness | **200** |
| `GET /api/health/ready` | Ready for traffic (Postgres when required) | **200** / **503** |
| `GET /api/health` | Full status JSON | **200** ok / **503** degraded |

```bash
curl -s http://127.0.0.1:3000/api/health | jq '{status,ready,requirePostgres,database,sessions,sync}'
npm run healthcheck
```

**Production pass:**

```json
{
  "status": "ok",
  "ready": true,
  "requirePostgres": true,
  "database": {
    "mode": "postgres",
    "durable": true,
    "ready": true,
    "ping": "ok"
  },
  "sessions": { "backend": "redis" }
}
```

---

## npm scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev server (Express + Vite middleware) on `:3000` |
| `npm run build` | Production Vite build + bundled `dist/server.cjs` |
| `npm start` | Run production server |
| `npm run setup:postgres` | Install/start Postgres & create DB/user (shell) |
| `npm run setup:pg` | DB setup via Node |
| `npm run migrate` | Apply SQL migrations |
| `npm run lint` | TypeScript check (`tsc --noEmit`) |
| `npm test` | Vitest suite (unit + API + integration) |
| `npm run test:watch` | Vitest watch mode |
| `npm run healthcheck` | Probe `/api/health/ready` |
| `npm run clean` | Remove `dist` |

---

## Default login

On **first launch** (empty users), the UI opens **Create Super Admin**.  
Use a strong password (min 8 characters; enable `STRICT_PASSWORD_POLICY` in production).

If seed users already exist in a local data file, change those passwords immediately under **User Management**.

| Field | Notes |
|---|---|
| Auth | bcrypt hashes + Bearer session token (12h sliding) |
| Roles | `SUPER_ADMIN`, `INVENTORY_MANAGER`, `BRANCH_MANAGER`, `FRONT_DESK`, `ACCOUNTANT` |

> Spoofable `x-user-role` headers are **not** trusted. API access requires a valid session token from login.

---

## Testing

```bash
npm test
npm run lint
```

Coverage includes:

- Auth (login/logout, token required, header spoof rejected)  
- Password hashing, roles, BS dates  
- Session store  
- Durable write rollback (`DURABLE_WRITE_FAILED` / 503)  
- Stock movement invariants  
- Catalog, logistics, procurement, approvals APIs  
- Health / require-Postgres policy  
- pg-mem SQL integration path  

Tests force offline-safe backends and an isolated temp data file so they never touch your real DB.

**CI template:** copy [docs/github-actions-ci.yml](docs/github-actions-ci.yml) to `.github/workflows/ci.yml` (see [docs/CI.md](docs/CI.md)).

---

## Project layout

```
.
├── server.ts                 # Entrypoint (boot, Vite/static, listen)
├── server/
│   ├── createApp.ts          # Express app factory (routes, health, limits)
│   ├── store.ts              # In-memory cache + JSON mirror
│   ├── lib/
│   │   ├── db.ts             # Postgres / pg-mem / fail-closed policy
│   │   ├── dbBootstrap.ts    # Schema sync + hydrate from SQL
│   │   ├── migrations.ts     # scripts/migrations runner
│   │   ├── auth.ts           # Session middleware, RBAC, audit
│   │   ├── authUtils.ts      # bcrypt, roles, BS stamps
│   │   ├── sessionStore.ts   # Redis or memory sessions
│   │   ├── writeGuard.ts     # snapshot + durable write / rollback
│   │   ├── pgReads.ts        # Postgres-first list reads
│   │   ├── validate.ts       # Zod schemas
│   │   ├── sync.ts           # SSE (+ Redis pub/sub)
│   │   └── logger.ts         # pino
│   ├── middleware/           # rate limit, request id
│   └── routes/               # domain HTTP modules
├── src/                      # React SPA
│   ├── App.tsx
│   ├── components/
│   ├── services/api.ts       # Bearer token client
│   └── utils/
├── scripts/
│   ├── schema.sql
│   ├── migrations/
│   ├── setup_postgres.sh
│   ├── setup_db.js
│   └── migrate.mjs
├── tests/                    # Vitest unit / API / integration
├── docs/                     # Deploy, production, UAT, CI
├── Dockerfile
├── ecosystem.config.js       # PM2
└── package.json
```

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/DEPLOY_CHECKLIST.md](docs/DEPLOY_CHECKLIST.md) | **Start here for production deploy** |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | Hardening, Redis, backups, smoke tests |
| [docs/CI.md](docs/CI.md) | GitHub Actions enablement |
| [docs/FISCAL_VAT_UAT.md](docs/FISCAL_VAT_UAT.md) | Accountant UAT for VAT / FY close |
| [docs/FRONTEND_MODULARIZATION.md](docs/FRONTEND_MODULARIZATION.md) | UI split notes |
| [docs/ROADMAP_STATUS.md](docs/ROADMAP_STATUS.md) | P0/P1/P2 status |
| [USER_MANUAL.md](USER_MANUAL.md) | End-user operations guide |
| [UPDATEPROCESS.md](UPDATEPROCESS.md) | Patch / rollback procedures |

---

## Security notes

- Passwords are stored as **bcrypt** hashes (legacy plaintext is migrated on login).  
- API authorization uses **Bearer session tokens**, not client-supplied roles.  
- Login and general API routes are **rate-limited**.  
- Zod validates critical write bodies (auth, products, stock, PO, shipments, approvals).  
- Failed durable Postgres writes return **`503` + `DURABLE_WRITE_FAILED`** and roll back in-memory state.  
- Change all default/demo credentials before go-live.  
- Never commit `.env` or `.data_store.json`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `database.mode` is `pg-mem` / `memory` | Install Postgres, set `DATABASE_URL`, restart; use `REQUIRE_POSTGRES=true` |
| App exits immediately in production | Postgres not reachable — check service, firewall, credentials |
| `/api/health/ready` → 503 | DB down or not durable while Postgres is required |
| Login works but data vanishes after restart | You were on fallback storage — switch to real Postgres |
| Multi-instance sessions lost | Set `REDIS_URL`; don’t cluster PM2 without Redis |
| `npm run setup:postgres` fails | Needs sudo/Docker/brew; install Postgres manually instead |

```bash
# Is Postgres accepting connections?
pg_isready -h localhost -p 5432
psql "$DATABASE_URL" -c 'SELECT 1'

# Force fail-closed even in dev
REQUIRE_POSTGRES=true npm run dev
```

---

## Stack summary

**Frontend:** React 19, TypeScript, Vite, Tailwind, Lucide  
**Backend:** Express, bcryptjs, Zod, pino, express-rate-limit  
**Data:** `pg` (PostgreSQL), optional `ioredis`  
**Dev/test:** tsx, Vitest, Supertest, pg-mem (tests/demos only)

---

## License

MIT
