# Full-Stack Audit Report — 2026-09-30

## 1. Code health

| Check | Result |
|---|---|
| `server` TypeScript (`tsc --noEmit`) | ✅ clean |
| `client` TypeScript (`tsc --noEmit`) | ✅ clean |
| Client production build (`vite build`) | ✅ builds (only pre-existing >500 kB chunk-size warnings) |
| Full test suite (`NODE_ENV=test npx tsx --test tests/*.test.ts`) | ✅ **470 / 470 pass** |

### Issue found & fixed: no-inline-SQL guard violation
`tests/no_inline_sql.guard.test.ts` was failing (before this audit the suite ran 467/470). The asset-deployment work from commit `310d942` / `711577b` had left **4 inline SQL literals** in `server/src/controllers/inventory.controller.ts` (deploy-time serial-log SELECT/UPDATE, unassign serial restore, CDR notes lookup), violating the project's own repo-layer rule.

**Fix:** added named constants to `server/src/models/inventory.repo.ts`
- `SERIAL_LOG_FIND_IN_STOCK_BY_SERIAL_SQL`
- `SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL`
- `SERIAL_LOG_RESTORE_ON_UNASSIGN_SQL`
- `CDR_NOTES_BY_ID_SQL`

and switched the controller to use them. `scripts/check_no_inline_sql.ts` now reports ✅ "No raw SQL literals in 12 controller file(s)". No behavior change — same statements, same params.

### Test-suite env note
`tests/httpHardening.test.ts` fails **only** when run with `NODE_ENV=development` (set in `.env`): helmet CSP is intentionally disabled for the Vite dev server. It passes under `NODE_ENV=test`, which is the correct posture for the production security posture it asserts. **Recommendation:** prefix CI/test invocations with `NODE_ENV=test` (as above).

## 2. Schema & database integrity

- **Drift guard** (`tests/schema.drift.guard.test.ts`): every live column is declared in `scripts/schema.sql` — ✅ pass (30 tables).
- **Live CHECK-constraint sweep:** every CHECK constraint re-evaluated against all rows — **0 violations** (includes `customer_device_records_status_check`, which correctly allows `ROUTER_COLLECTED` per schema.sql line 530).
- **Referential / data-quality probes:** orphan stock rows 0, orphan serial_log rows 0, orphan customer-device branch refs 0, negative quantity_on_hand 0, duplicate device_serials 0, stale active rental-CPE for a returned asset 0.
- 49 FK constraints present; exactly 1 real (non-demo) user; demo fixed-assets = 3 (the intended demo baseline).

## 3. setup_db.js / setup_postgres.sh review

Reviewed end-to-end. Verdict: **sound, no blocking issues.** Notable strengths:
- `ON_ERROR_STOP=1` on every psql invocation; schema applied idempotently and verified afterward (products.is_demo, categories.is_special_tracked, serial_log presence).
- Wipe step correctly preserves `bs_calendar_years` / `bs_day_records`, and deliberately uses plain `DELETE FROM fiscal_years` (not TRUNCATE) so the FK `ON DELETE SET NULL` nulls `bs_day_records.fiscal_year_id` instead of cascading the calendar away — the comment documents the pitfall correctly.
- `--keep-data` escape hatch, `--force` gate that skips tables holding real (`is_demo = FALSE`) rows, superuser fallback chain (env password → `su postgres` → trust), CREATEDB grant for later re-runs.
- SQL passed via `-c` with double-quote escaping so it survives the `su` boundary.

Minor (non-blocking) observations:
- `CREATE USER ... PASSWORD '${DB_PASS}'` interpolates the password into the SQL string; a password containing a single quote would break/skip (fails safe: warns and asks for manual creation).
- The clear step truncates **all** non-preserved tables — including non-demo ones — when run without `--keep-data`; behavior is documented, but operators should treat a bare re-run as destructive by design.

## 4. Runtime API audit

- `/api/health` → 200; unauthenticated `/api/users` → **401** (auth wall holds).
- Demo login works; token then used to probe 10 representative endpoints (users, branches, products, stock, assets, shipments, stock-operations, serial-log, customer-devices, lookup) — **all 200**.
- Server log (`devserver12.log`) shows no uncaught errors on boot.

## 5. Cleanup performed

**Deleted (tracked, via `git rm`):**
- `scripts/_migrate_pay_numbers.mjs` — one-shot demo-vendor-payment cleanup script (referenced nowhere; would also have failed: it expects a `scripts/.token.txt` that no longer exists)
- `scripts/_test_sales.sql` — ad-hoc test-sales fixture inserts (superseded by the seeded demo dataset)

**Deleted (untracked temp artifacts):**
- `devserver.log`, `devserver2.log` … `devserver11.log`, `devserver-verify.log`, `server/devserver8.log`, `server/devserver11.log` (13 old dev-server logs; `devserver12.log` kept — the live server is writing to it)
- `scripts/.token.txt` (leftover auth token — a credential, correctly removed)
- stray `.tmp-guard-*.ts` files if present (guard-test leftovers)

**Kept (deliberately):**
- `server.ts` root shim — documented re-export for legacy entry points
- `scripts/test_switch_root_token.mjs`, `integrity_check.mjs`, `smoke_test.mjs`, `bench_write_latency.mjs` — wired into `package.json` / useful ops tooling
- `handoff.md`, `SESSION_NOTES.md` — tracked project docs (large; candidates for pruning if you want, but they are documentation, not temp code)

## 6. Follow-ups (optional)

1. Make `npm test` / CI set `NODE_ENV=test` so the helmet test can't false-fail.
2. Consider a docnumber-concurrency style guard test for the two new serial-log SQL constants (pure SQL, currently covered only via service tests).
3. ~~Chunk-splitting for `client`~~ — investigated 2026-09-30: the two >500 kB raw chunks are `vendor-excel` (exceljs, lazy-loaded off the startup path by design) and an artifact of building from `client/` without the root `vite.config.ts` (which sets `root: 'client'`). A proper root build yields a 12 kB gz entry and passes `npm run check:bundle-budget` (275.7 / 320 kB gz). Nothing left to split — always build via `npm run build`.
