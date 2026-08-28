# Production Hardening Guide (P0 / P1 / P2)

## Architecture (durable mode)

```
Browser ──► Nginx ──► Node (PM2)
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
        PostgreSQL    Redis      (optional Sentry)
        (domain data) (sessions
                       + SSE bus)
```

| Concern | Production setting |
|---|---|
| Domain data | **PostgreSQL only** (`DATABASE_URL`) — memory is a cache |
| Auth sessions | **Redis** (`REDIS_URL`) — required for multi-instance |
| Live SSE | Redis pub/sub on same `REDIS_URL` |
| Process model | `PM2_INSTANCES>=1` only after Redis + Postgres are healthy |
| Secrets | Never commit `.env` / `.data_store.json` |

---

## P0 — Production blockers checklist

### 1. PostgreSQL as multi-writer source of truth
```bash
# Create DB + user, then:
export DATABASE_URL=postgres://inventory_user:STRONG_PASSWORD@127.0.0.1:5432/inventory_db
npm run setup:pg   # or: psql "$DATABASE_URL" -f scripts/schema.sql
npm run migrate    # applies scripts/migrations/*.sql
npm run dev
curl -s localhost:3000/api/health | jq .database
# expect: { "mode": "postgres", "durable": true, "ping": "ok" }
```

- Mutating routes use `writeThroughPg` — failures return **HTTP 503** `DURABLE_WRITE_FAILED` and roll back memory.
- List endpoints prefer SQL via `readPgOrStore` when durable.

### 2. Redis sessions + SSE
```bash
export REDIS_URL=redis://127.0.0.1:6379/0
# health.sessions.backend === "redis"
# health.sync.redisPubSub === true
export PM2_INSTANCES=2   # safe only with Redis
pm2 start ecosystem.config.js
```

### 3. Secrets & password policy
```bash
export STRICT_PASSWORD_POLICY=true
export MIN_PASSWORD_LENGTH=10
export FORCE_PASSWORD_CHANGE_ON_DEFAULT=true
```
- Rotate any seed/demo accounts immediately after first login.
- Prefer a secrets manager; never bake passwords into images.

### 4. Backups
```bash
# Daily logical backup example
pg_dump "$DATABASE_URL" -Fc -f /var/backups/izone-$(date +%F).dump
# Redis (if persistence matters beyond sessions)
redis-cli -u "$REDIS_URL" BGSAVE
```

### 5. Reverse proxy
- Terminate TLS at Nginx/Caddy.
- Set `TRUST_PROXY=true`.
- Forward `Authorization` and `X-Request-Id`.
- Limit body size (app default 25mb).

---

## P1 — Correctness & architecture

| Item | Status in this branch |
|---|---|
| Multi-step stock ops in `withTransaction` | PO receive, shipment dispatch/receive, approvals (key paths) |
| PG-first reads | products, categories, stock lists |
| Zod validation on writes | login, setup SA, products, stock patch, PO, shipment, approvals |
| SQL migrations runner | `scripts/migrations/` + `npm run migrate` |
| Django parallel stack | Documented experimental under `backend_django/` |

---

## P2 — Quality & product

| Item | Status |
|---|---|
| Automated tests | `npm test` (65+) |
| CI template | `docs/github-actions-ci.yml` → copy to `.github/workflows/ci.yml` |
| Rate limiting | login + API (`express-rate-limit`) |
| Structured logs | pino + `x-request-id` |
| SSE multi-instance | Redis pub/sub |
| Observability hooks | log fields ready for Sentry/Datadog shipping |

### Optional: Sentry
```bash
# npm i @sentry/node  (optional)
# SENTRY_DSN=... enable in a thin wrapper around logger if desired
```

---

## Environment reference

```env
NODE_ENV=production
PORT=3000
TRUST_PROXY=true

DATABASE_URL=postgres://inventory_user:...@db:5432/inventory_db
REDIS_URL=redis://redis:6379/0

STRICT_PASSWORD_POLICY=true
MIN_PASSWORD_LENGTH=10
LOGIN_RATE_LIMIT_MAX=20
API_RATE_LIMIT_MAX=600

LOG_LEVEL=info
REQUIRE_MIGRATIONS=false
PM2_INSTANCES=2
SEED_DUMMY_DATA=false
DISABLE_RATE_LIMIT=false
```

---

## Smoke test after deploy

1. `GET /api/health` → postgres + redis  
2. Login as Super Admin → change password  
3. Create product → create PO → receive PO (on-hand increases)  
4. Inter-branch transfer → receive (qty conserved)  
5. Device disconnect approval flow  
6. `npm test` in CI on every PR  
