# P0 / P1 / P2 / remaining status

## P0 — Production blockers — DONE
| Item | Status |
|---|---|
| PG multi-writer + durable writes | Done |
| Postgres/Redis health + runbook | Done (`docs/PRODUCTION.md`) |
| Redis sessions + SSE pub/sub | Done |
| Password policy + rate limits | Done |

## P1 — Correctness & architecture — DONE (core)
| Item | Status |
|---|---|
| withTransaction on multi-step ops | Done (key paths) |
| PG-first reads on list GETs | Done (masters, catalog, stock, logistics, procurement, customers, audit, approvals, fiscal, company) |
| Migrations runner | Done (`npm run migrate`) |
| Frontend modularization | Started (`stockOps/`, `useInventoryData`) — see `docs/FRONTEND_MODULARIZATION.md` |
| Django dual-backend | Documented experimental |

## P2 — Quality & product — DONE (core)
| Item | Status |
|---|---|
| Tests | **90** unit/API/integration |
| Zod validation | Critical writes |
| Observability | pino + request id |
| Rate limiting | Login + API |
| SSE multi-instance | Redis pub/sub |
| Fiscal/VAT UAT pack | `docs/FISCAL_VAT_UAT.md` + smoke tests |
| CI | `.github/workflows/ci.yml` in tree (push may need workflows permission) |
| PR | #1 open |

## Optional follow-ups
- Extract remaining StockOperations panels into separate files
- Live Redis/Testcontainers when Docker is available in CI
- Accountant sign-off on staging using UAT checklist
