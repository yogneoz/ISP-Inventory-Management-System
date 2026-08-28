# P0 / P1 / P2 status

Last updated with branch work through production-hardening pass.

## P0 — Production blockers

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Real multi-writer domain store (PG source of truth) | **Done (core)** | Durable mode + writeThroughPg + PG-first reads on key lists; full route-by-route cutover still incremental |
| 2 | Real Postgres + Redis prod wiring | **Done (docs + health)** | `docs/PRODUCTION.md`, `/api/health` surfaces mode |
| 3 | Auth session durability multi-instance | **Done** | Redis sessions + SSE pub/sub |
| 4 | Password / secret ops | **Done (policy)** | `STRICT_PASSWORD_POLICY`, stronger validation, rate limits |

## P1 — Correctness & architecture

| # | Item | Status | Notes |
|---|---|---|---|
| 5 | Transactional multi-step ops | **Mostly done** | withTransaction on PO receive, shipment dispatch/receive, bulk stock, approvals |
| 6 | Read path consistency | **Done (key paths)** | `readPgOrStore` for products/categories/stock |
| 7 | Schema migrations framework | **Done** | `scripts/migrations` + `runMigrations()` |
| 8 | God UI components | **Deferred** | Frontend split is large; tracked separately |
| 9 | Dual backend drift (Django) | **Done (documented)** | Experimental only |

## P2 — Quality & product

| # | Item | Status | Notes |
|---|---|---|---|
| 10 | Tests | **Done** | 65+ Vitest unit/API tests |
| 11 | API validation | **Done (critical writes)** | Zod on auth/catalog/stock/PO/shipment/approvals |
| 12 | Observability | **Done (baseline)** | pino + request IDs + access logs |
| 13 | Rate limiting / lockout | **Done** | login + API limiters |
| 14 | SSE scaling | **Done** | Redis pub/sub fan-out |
| 15 | Import/export edge cases | **Open** | Needs dedicated UAT |
| 16 | Nepali fiscal / IRD polish | **Open** | Needs accountant UAT |
| 17 | Docs / branding | **Mostly done** | PRODUCTION.md, CI docs, Django note |
| 18 | CI/CD | **Done (template)** | `docs/github-actions-ci.yml` |
| 19 | Open PR | **Done** | PR #1 |

## Remaining optional work
- Frontend modularization (`StockOperations`, `App.tsx`)
- Testcontainers PG/Redis integration tests
- Full GET surface on `readPgOrStore`
- Fiscal/VAT UAT scripts
- Enable `.github/workflows/ci.yml` with a PAT that has `workflows` scope
