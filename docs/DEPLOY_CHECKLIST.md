# Node + PostgreSQL deploy checklist (fail-closed)

Use this when deploying **IZone ERP** with **Express + PostgreSQL only** (no Django).

## Architecture

```
Users → Nginx (TLS) → Node/Express (PM2) → PostgreSQL
                              ↓
                           Redis (sessions + SSE)
```

---

## 1. Provision PostgreSQL

```bash
# Option A — project script (may need sudo)
npm run setup:postgres
npm run setup:pg

# Option B — manual
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres psql <<'SQL'
CREATE USER inventory_user WITH PASSWORD 'CHANGE_ME_STRONG';
CREATE DATABASE inventory_db OWNER inventory_user;
GRANT ALL PRIVILEGES ON DATABASE inventory_db TO inventory_user;
\c inventory_db
GRANT ALL ON SCHEMA public TO inventory_user;
SQL
psql "postgres://inventory_user:CHANGE_ME_STRONG@localhost:5432/inventory_db" -f scripts/schema.sql
```

---

## 2. Environment (production)

Create `.env` on the server (never commit it):

```env
NODE_ENV=production
PORT=3000
TRUST_PROXY=true
LOG_LEVEL=info

DATABASE_URL=postgres://inventory_user:CHANGE_ME_STRONG@127.0.0.1:5432/inventory_db

# Fail closed is DEFAULT in production. Do NOT set ALLOW_DB_FALLBACK=true.
# REQUIRE_POSTGRES=true   # optional explicit force (also default when NODE_ENV=production)
REQUIRE_MIGRATIONS=true

REDIS_URL=redis://127.0.0.1:6379/0

STRICT_PASSWORD_POLICY=true
MIN_PASSWORD_LENGTH=10
SEED_DUMMY_DATA=false
```

| Variable | Production value | Effect |
|---|---|---|
| `NODE_ENV` | `production` | **Requires Postgres** or process exits |
| `ALLOW_DB_FALLBACK` | unset / `false` | No pg-mem / JSON as primary |
| `REQUIRE_POSTGRES` | `true` (or implied) | Same fail-closed behavior in any env |
| `REQUIRE_MIGRATIONS` | `true` | Migration failure aborts boot |
| `REDIS_URL` | set | Shared sessions + SSE across PM2 workers |

---

## 3. Build & start

```bash
npm ci
npm run migrate
npm run build
npm start
# or
pm2 start ecosystem.config.js
```

**Expected boot log:**

```text
✅ Database mode: real PostgreSQL (primary write path).
✅ PostgreSQL primary ready — schema synced, store hydrated from database.
Database: mode=postgres durable=true requirePostgres=true
```

If Postgres is down you should see **process exit code 1**, not a silent demo mode.

---

## 4. Health probes (for Nginx / K8s / systemd)

| Endpoint | Meaning | Expect |
|---|---|---|
| `GET /api/health/live` | Process alive | **200** |
| `GET /api/health/ready` | Postgres ready when required | **200** only if durable PG up; else **503** |
| `GET /api/health` | Full snapshot | **200** + `database.mode=postgres`, `ready=true`; else **503** |

```bash
curl -sS http://127.0.0.1:3000/api/health/live | jq .
curl -sS http://127.0.0.1:3000/api/health/ready | jq .
curl -sS http://127.0.0.1:3000/api/health | jq '{status,ready,database,sessions,sync}'
```

**Pass criteria:**

```json
{
  "status": "ok",
  "ready": true,
  "requirePostgres": true,
  "database": { "mode": "postgres", "durable": true, "ready": true, "ping": "ok" },
  "sessions": { "backend": "redis" }
}
```

---

## 5. Smoke test (after health green)

1. Open app URL → Super Admin login (change password immediately).
2. Create product → Create PO → Receive PO → stock on-hand increases.
3. Inter-branch transfer → receive → quantity conserved.
4. Kill Postgres briefly → `/api/health/ready` → **503**; mutating API should fail (not silently succeed).
5. Restore Postgres → ready returns **200**.

---

## 6. Nginx sketch

```nginx
upstream izone {
  server 127.0.0.1:3000;
  keepalive 32;
}
server {
  listen 443 ssl http2;
  server_name erp.example.com;
  location / {
    proxy_pass http://izone;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
  }
}
```

Readiness for load balancer: poll `/api/health/ready`.

---

## 7. Backups

```bash
pg_dump "$DATABASE_URL" -Fc -f /var/backups/izone-$(date +%F).dump
# retain 7–30 days; test restore quarterly
```

---

## 8. What NOT to do in production

- ❌ Run without `DATABASE_URL` and hope fallbacks are “fine”
- ❌ Set `ALLOW_DB_FALLBACK=true` on a real tenant
- ❌ Scale PM2 `instances > 1` without Redis
- ❌ Commit `.env` or `.data_store.json`
- ❌ Use default passwords after go-live

---

## Dev vs production

| | Development | Production |
|---|---|---|
| Postgres missing | Falls back to pg-mem / memory | **Process exits** |
| `/api/health` | 200 even on fallback | **503** if not durable |
| Goal | Fast UI work offline | **Never serve fake DB as real** |

To force Postgres even while developing:

```bash
REQUIRE_POSTGRES=true npm run dev
```
