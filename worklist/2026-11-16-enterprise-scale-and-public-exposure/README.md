# Round 13 — Enterprise scale envelope and public-internet hardening

Status: `[—]` superseded 2026-11-17 by [Round 15](../2026-11-17-advisory-hardening/README.md) (Part B); its partition/BRIN assumptions are corrected there · Opened 2026-11-16 · Mandate-driven

Source: the 2026-11-16 architectural and deployment mandate, plus audit findings
H3, H4, H5, H6, M4, M5, M8 and L1–L3 in
[docs/audit-2026-11-15.md](../../docs/audit-2026-11-15.md). Round 12
([backup/availability](../2026-11-16-backup-and-db-availability/README.md))
closes C1/H1; Round 14
([API keys](../2026-11-16-api-key-management/README.md)) depends on the shared
state and MFA introduced here.

This round is the architectural envelope, not a re-audit. It records the target
the code must be designed for, the invariants that follow from it, and the
slices that move the current single-process system toward it. Where the
mandate's wording and the tree disagree, the tree's constraint is recorded
below rather than hidden.

## Target envelope

| Dimension | Measured today | Mandated target |
|---|---|---|
| Concurrent sessions | 10–50 in the audit; 500 modelled | **3,000–10,000+** across shifts |
| Branches | 2 in the demo database; 200–500 regional offices/warehouses | **200–500+**, strict isolation + cross-branch rollups |
| Customers | 12k modelled, 120k+ national estimate | **5M–50M+** ISP subscribers |
| Transactional rows | demo scale; 29 `gl_journals` partitions in the audited DB | **1B–10B+** journal lines, stock movements, serial logs, subledger entries |
| `GET /api/bootstrap` | 155.2 KB per response | **< 15 KB** (permissions, active branch metadata, fiscal-year context, light UI config only) |
| API workers | PM2 `instances: 'max'`, `exec_mode: 'cluster'`, with Redis shared state | **N workers × multiple nodes**, stateless behind a load balancer |
| Public exposure | plain HTTP on a LAN, HSTS disabled | **HTTPS-only on a public domain**, HSTS preload, edge protection |

The arithmetic is the argument:

- 10,000 sessions × 155 KB ≈ **1.5 GB per sign-in/refresh wave**. Even 1% of
  sessions refreshing per minute is ~15 MB/s of the same reference payload
  before any screen data.
- 40 connections per worker × 1 worker = 40. Ten thousand sessions at even
  0.1 rps each need ~1,000 concurrent queries; the pool must be shared through
  PgBouncer and sized against `max_connections`, not raised per worker.
- 1B `gl_journal_lines` at ~100 B/row is ~100 GB of heap plus indexes. A
  sequential scan or a partition-wide aggregate per trial balance is not a
  capacity plan.
- 500 branches × 5M customers means the customer master can never ride the
  bootstrap payload, and every list/report needs a branch + date predicate to
  prune.

## Invariants

A slice is not done if it violates one of these. They are the review checklist
for every future change, not just this round.

1. **No process-local request state.** Sessions (`ver`), rate-limit counters,
   token deny-lists, distributed locks and SSE fan-out live in Redis or the
   database. A worker can die without losing a session or a limit.
2. **Bootstrap is principal-scoped, not data-scoped.** It carries who the
   caller is, what they may do, the branches they may switch to, the active
   fiscal year, and UI configuration. No master or ledger array.
3. **Large lists are keyset-paginated.** `WHERE (sort_key, id) < ($cursor)`
   with a stable composite index; `LIMIT/OFFSET` survives only for bounded
   administrative tables. No endpoint can ask for "all customers".
4. **Every large read names its scope.** `branch_id` and
   `fiscal_year_id`/`date_range` are mandatory on the billion-row tables; an
   omitted scope is `400 SCOPE_REQUIRED`, never a full scan. `ALL` is an
   explicit, audited choice with a date floor.
5. **Partition pruning is proven, not assumed.** The plan for every reporting
   query is checked with `EXPLAIN (ANALYZE, BUFFERS)` on a partitioned fixture;
   a plan that touches every partition fails the slice.
6. **Partitioning is provisioned, not just declared.** `gl_journals` and
   `gl_journal_lines` are RANGE-declared, but a fresh install gets only a
   `DEFAULT` partition (`schema.sql:4874-4875`). Monthly children, lookahead
   and retention must be created and monitored.
7. **Index shape follows the access path.** BRIN on append-only time/sequence
   columns, composite B-Tree `(branch_id, fiscal_year_id, <date> DESC, id DESC)`
   for page reads, trigram only where the search is a contains-match. No index
   is added without a measured query.
8. **Writes go to the primary; heavy reads go to a replica.** A replica lag
   guard (default 5 s) decides between replica, primary and `503 Retry-After`;
   ledger reads that must be exact stay on the primary.
9. **PgBouncer transaction mode is a compatibility contract.** No session-level
   `SET`, no temporary tables, no session advisory locks, no prepared
   statements that outlive a transaction. `statement_timeout` is set at the
   role/database level.
10. **Caches are granular, single-flight and invalidated after commit.** No
    synchronous reload of eleven caches in the write path; keys are scoped
    (`branch:{id}:stock_summary`, `fy:{id}:coa`), population is stampede-safe,
    invalidation is published after the transaction commits.
11. **Balances are pre-aggregated.** Trial balance and stock-on-hand read a
    summary row, not the ledger. `fiscal_year_balances` already exists; the
    missing piece is a maintained `branch_stock_balances`.
12. **The public edge is the only ingress.** HTTPS-only with HSTS preload,
    exact proxy hops, strict CORS/CSP, no unauthenticated metadata, distributed
    rate limits, admin MFA, setup lockout, and PostgreSQL/Redis/metrics bound
    to private interfaces.

## What is true in the tree today

| Area | Today | Gap |
|---|---|---|
| Process model | `ecosystem.config.js`: `instances: 'max'`, `exec_mode: 'cluster'`; a clustered production boot requires Redis | **SCALE-1 done** |
| Rate limits | `server/src/middleware/authRateLimit.ts` — Redis sorted-set windows shared by every worker (local fallback only for one worker) | **SCALE-1 done** |
| SSE | `server/src/realtime/sse.ts` — local client handles plus `isp:sse:changes` pub/sub fan-out | **SCALE-1 done** |
| Session revocation | `ver` checked against `session:ver:<userId>` in Redis, with one DB fallback (`sessionVersion.ts`) | **SCALE-1 done** |
| Bootstrap | 24,772 B raw / 2,489 B gzip on demo data; 146,574 B raw / 10,421 B gzip with 500 branches. The login payload is the identity/permission shell + branch/FY context; master/ledger arrays hydrate as deferred slices | **SCALE-2 done** |
| Paging | Signed composite-key cursors (`server/src/utils/keysetCursor.ts`) on customers, sales invoices, stock operations, serial log, journals, subledger entries and audit logs; `page` remains a clamped compatibility alias | **SCALE-2 done** |
| Partitioning | `gl_journals` + `gl_journal_lines` declared RANGE by `journal_date_ad`; fresh install only `DEFAULT`; `gl_subledger_entries`, `stock_operations`, `serial_log`, `sales_invoices` unpartitioned | SCALE-3 |
| Read path | `REPORT_DATABASE_URL` + `reportingPool` already exist (`server/db.ts`); reporting coverage is partial | SCALE-3 |
| PgBouncer | not configured; the pool uses `connectionTimeoutMillis` and session-level statements | SCALE-3 |
| Caches | 11 `CACHE_LOADS` hydrate per worker **at boot only** — OPS-2 deleted the post-write reload, so a write costs one version bump, not eleven table reads; the bootstrap ETag's version counter is shared through Redis since 2026-11-17 | SCALE-4 (remaining: pre-aggregated balances) |
| Balances | `fiscal_year_balances` exists (`schema.sql:2168+`); no branch stock balance table | SCALE-4 |
| Transport | `server/src/app.ts:236-249` disables HSTS and clears `upgrade-insecure-requests`; no TLS proxy in the repo | PUB-1 |
| Headers/CORS | Helmet CSP in production/test; no `ALLOWED_ORIGINS`, no explicit CORS policy | PUB-2 |
| Public surface | `/api/db/status` returns host, port, database, user and, on failure, the driver message (`server/src/controllers/misc.controller.ts:54-82`) | PUB-3 |
| MFA | none; `SUPER_ADMIN` / `HEAD_OFFICE_ADMIN` sign in with a password only | PUB-3 |
| Setup | `SETUP_TOKEN` flow exists; the route is not removed after the first Super Admin | PUB-3 |
| Containers | `Dockerfile` has no `USER`, no `HEALTHCHECK`, runs as root (audit L1) | PUB-4 |

## Work slices

### SCALE-1 — Shared state and horizontal workers

Priority: P0 · Status: `[x]`

- [x] Add a Redis client (`redis`, not `ioredis`, unless the team prefers it)
      behind `REDIS_URL` / `REDIS_TLS_URL`; one connection for commands and one
      for pub/sub per worker. Fail modes are explicit per use:
      auth/API-key limits **fail closed** (`503`), non-security read caches
      **fail open** with an alert. (`server/src/state/sharedStore.ts`; API-key
      limits arrive with APIK-3 and use the same store.)
- [x] Move the auth rate limiter (`authRateLimit.ts` + `utils/rateLimiter.ts`)
      to a Redis sliding window (sorted set or Lua) with the same bucket keys
      and budgets; the manual release endpoint clears the Redis keys.
- [x] Move session `ver`/revocation to Redis: `session:ver:<userId>` written
      from the DB on login/role change/password reset/deactivation, checked by
      `authenticateUser` and `sessionStillValid`; a Redis miss falls back to
      the DB once and repopulates. A revoked account is invalid on every
      worker immediately. (`sessionVersion.ts`.)
- [x] Move distributed locks to `SET key value NX PX` with a fencing token.
      Keep the DB row locks for document numbers and ledger writes; only
      process-wide jobs (demo clear, retention, cache rebuild) need Redis.
      (`sharedLock.ts`; boot schema/seed is the first leader-elected job.)
- [x] SSE fan-out: `broadcastChange` publishes to a Redis channel; each worker
      subscribes and writes to its own clients. Keep the per-client `dataVersion`
      contract and the reconnect resync path. (`isp:sse:changes`.)
- [x] Leader election for boot-time/periodic jobs (partition provisioning,
      WAL/backup checks, cache warm) so N workers do not run them N times.
      (`withStartupLeadership` wraps the boot schema/seed; periodic jobs do
      not exist in this tree yet and use the same utility when added.)
- [x] Switch `ecosystem.config.js` to `instances: 'max'`, `exec_mode: 'cluster'`;
      update the README "single process only" section with what moved and what
      still must be shared before a multi-node deploy.
- [x] Graceful shutdown must drain SSE clients and the Redis subscriber before
      the pool closes (`server/src/boot/lifecycle.ts`).

Acceptance: two workers behind a local proxy — a write on worker A produces the
SSE invalidation on a client connected to worker B; a login rate limit consumed
on A is enforced on B; killing A leaves every session valid on B; `instances:
'max'` boots with no "port in use" and no duplicate-periodic-job log.

**Evidence (2026-11-16).** `tests/sharedState.test.ts` exercises two independent
workers over one shared store: an IP budget consumed on A is refused on B; the
shared release clears it for both; a session fingerprint written by A rejects
the old token on B; the lock is refused on B and its fencing token advances; a
write on A reaches a client attached to B; and the boot leader job runs once
while the follower skips it. `tests/singleInstance.guard.test.ts` pins cluster
config, the Redis boot requirement, the README fail modes, and the absence of
the old fork/single-process premise. A real Redis daemon is not installed on
this runner, so the shared contract is tested with `MemorySharedStore('redis')`;
the Redis backend uses the same sorted-set/Lua and pub/sub surface. `npx tsc
--noEmit` is 0. Full suite: **2,504 tests, 2,502 pass, 2 Windows-only skips, 0
fail**; docs gate 2,504.

### SCALE-2 — Bootstrap < 15 KB and keyset pagination

Priority: P0 · Status: `[x]` complete 2026-11-16; the two absent endpoints and
the intentionally unconverted targeted/movement reads are stated limitations below

- [x] Inventory every bootstrap key, its consumer, and its bytes. The end state
      keeps only: the caller's identity and effective permissions, the branches
      they may switch to, the active/current fiscal-year context, company
      profile, app settings, user preferences, feature flags and
      `dataVersion`/ETag.
- [x] Remove every master/ledger array (`stock`, `products`, `suppliers`,
      `categories`, `productGroups`, `uom`, `locations`, `damageRecords`,
      `purchaseReturns`, `salesReturns`, `approvalRequests`, `auditLogs`, and
      any remaining one) from the full payload. Each moves to its existing
      paged endpoint or `/api/bootstrap/local?key=` slice; first paint must not
      gain a blocking request.
- [x] Target: **< 15 KB gzip**, measured by `scripts/measure_bootstrap_payload.mjs`
      on a seeded large fixture. Record the before/after table in this note.
- [x] Introduce a cursor contract for the billion-row tables:
      `GET …?cursor=<opaque>&limit=<n>` → `{ items, nextCursor, hasMore }`,
      ordered by the table's stable composite key (`created_at DESC, id DESC`
      or `journal_date_ad DESC, id DESC`). Opaque cursor = base64 of the last
      sort key + id, signed or validated against the table's shape.
- [x] Apply it to `customers`, `sales_invoices`, `gl_journal_lines`,
      `stock_operations`, `serial_log`, `gl_subledger_entries`, `audit_logs`
      and the new `api_key_audit_logs`. Keep `page`/`pageSize` as a bounded
      compatibility alias (max offset 10,000) only where a screen still needs
      page numbers.
- [x] Mandatory scope: reject a list/report on a large table without
      `branch_id` and a date/FY predicate (`400 SCOPE_REQUIRED`). `ALL` is
      allowed only for a global role and must carry a date floor.
- [x] Client: the customer directory, sales invoices, consumables/stock
      operations, serial log, posted vouchers, subledger book ledger and audit
      register load the first page with `limit` and append through
      `nextCursor`; the shared footer ends at `hasMore=false` and shows a
      visible `SCOPE_REQUIRED` state. CSV/PDF exports keep the existing capped
      `all=1` server-side window.
- [x] Synthetic fixture (`scripts/seed_scale_fixture.mjs`, scratch DB only):
      5M customers, 1M invoices, 10M journal lines, 5M stock operations, 500
      branches. Use it for the payload and plan measurements; never point it at
      a real database.

Acceptance: bootstrap < 15 KB on the fixture; a keyset page of 50 customers
returns in the same time at 5M rows as at 12k; `EXPLAIN` on each list query
shows the composite index and, for ledger tables, one partition; a request
without scope gets `400`, not a scan.

**Evidence (2026-11-16).** `GET /api/bootstrap` now serializes only the shell:
branches, fiscal years, financial summary, users (permission-gated), company
profile, permissions matrix, settings/preferences, status, `serverTime` and
`dataVersion`/ETag. `fetchBootstrapFirstPaint` reads only branches, users and
the company profile; products, stock, suppliers, categories, product groups,
UoM, locations, approvals and damage records are deferred through the existing
`GET /api/bootstrap/local?key=` endpoint, and App hydrates them after the full
payload. `measure_bootstrap_payload.mjs` against the live app:

| Measurement | Raw | Gzip |
|---|---:|---:|
| OPS-3 end state (demo DB) | 59,977 B | 6,198 B |
| SCALE-2 (demo DB) | 24,772 B | **2,489 B** |
| SCALE-2, 500 branches (494 temporary fixture rows + 6 real, cleaned up) | 146,574 B | **10,421 B** |

The 500-branch run is the scaling-sensitive part of the remaining shell
(`branches` was 73.1% of gzip); the fixture rows were deleted immediately after
the measurement and `tests/scale2BootstrapBudget.test.ts` re-measures a
500-branch shell under the 15 KB budget. `tests/scale2Keyset.test.ts` proves the
signed/table-bound cursor rejects tampering, every scoped builder emits the
composite predicate with no `OFFSET`, and a real PostgreSQL consumer page
returns every pre-existing row exactly once while newer and same-timestamp rows
are inserted between pages. `tests/bootstrapTrim.test.ts` asserts the live
payload omits every removed array.

The client registers now use `client/src/hooks/useKeysetPager.ts` and
`client/src/components/common/KeysetLoadMore.tsx`: a filter/branch/date change
resets to the first cursor page, **Load more** appends the next page, duplicate
ids from a retry are dropped, and the footer says "End of register" at
`hasMore=false`. `tests/scale2ClientRegisterPaging.test.ts` walks a pager across
page boundaries while newer and same-timestamp rows are inserted, asserts every
pre-existing row appears exactly once and no newer row leaks into the walk, and
pins the visible `SCOPE_REQUIRED` state. It also guards every converted screen against
reintroducing an offset pager.
`tests/customerPaging.api.test.ts` performs the same page-boundary insert through
the real `GET /api/customers` cursor endpoint and asserts the next page still
returns the original rows with no overlap.

Known limitations, stated explicitly:

- `api_key_audit_logs` does not exist yet (Round 14 owns the table and its
  endpoint). The cursor utility is ready for it, but there is no key to wire or
  test in this tree.
- `gl_journal_lines` has no list endpoint; the journal register reads
  `gl_journals` headers. That header endpoint is keyset-paged; a line-level
  endpoint is not invented here.
- **Converted to cursor/load-more:** Customer Master Directory, Sales Invoices,
  Consumables (stock-operations) Register, Serial Log Register, Posted Vouchers,
  Subledger book ledger and the Activities Log audit register. Sales invoices
  gained explicit From/To date filters so an `ALL`-branch read has a bounded
  scope; the subledger ledger defaults to the active fiscal-year window; audit
  uses the active fiscal-year window and the selected branch.
- **Converted in the SCALE-2 follow-up:** purchase-returns and sales-returns
  (`GET /api/purchase-returns` and `/api/sales-returns` now accept signed
  cursors), the pullout, damage+disposal and all-operation Stock Operations
  panels, and the CustomerLedger receipt picker's open-invoice list. The stock
  panels share the existing `/api/stock-operations` cursor; `type` accepts a
  comma list so DAMAGE and DISPOSAL page together. A customer id is now a valid
  cursor scope for the customer ledger picker, alongside branch and date.
- **Converted in the SCALE-2 operational-register follow-up:** fixed assets (the register, Asset Deployments and
  the date-wise depreciation tab), warranty coverage for both sides, the
  shipment transfer register, purchase orders and purchase invoices. Each
  endpoint accepts a signed `(created_at, id)` cursor, keeps every existing
  branch/date/status/search filter, and requires a branch or a bounded date
  range before serving a cursor page. Their client registers use
  `useKeysetPager` + `KeysetLoadMore`; the depreciation tab no longer claims
  invoice-date ordering, because the cursor contract is `created_at` order.
- **Intentionally unconverted:** the serial-focused audit lookup keeps its
  targeted capped 500-row read (a single-record identity lookup, not a
  register). The audit stock-movement sub-tab still pages `/api/transaction-logs`
  by offset because it is a user-selectable ascending/descending movement
  window with its own export cap, not a register surface. The CustomerLedger
  statement body also remains one computed response (opening balance, running
  balances and tie-out); only its invoice picker is cursor-paged. Master-data
  directories and settings lists that paginate local arrays are not large
  operational registers and remain unchanged.
- `scripts/seed_scale_fixture.mjs` is present with the 5M/1M/10M/5M/500 defaults,
  scratch-database guards and cleanup, but the full fixture was not executed on
  this workstation; the live 500-branch measurement and the direct PostgreSQL
  concurrent-insert test are the evidence recorded here.
- `EXPLAIN`/5M-vs-12k timing and partition pruning belong to SCALE-3's index and
  partition work; no speed claim is made for this slice.

Full suite: **2,546 tests, 2,544 pass, 2 Windows-only skips, 0 fail**;
`npx tsc --noEmit` is 0; the docs-count gate matches 2,546. The new
`tests/scale2RemainingRegisters.api.test.ts` walks each SCALE-2 follow-up read,
and `tests/scale2OperationalRegisters.api.test.ts` walks all five operational
registers across a real insert boundary (newer and same-timestamp rows inserted
after page 1), asserting exactly-once delivery, no newer-row leakage, cursor
termination and both `SCOPE_REQUIRED` / `INVALID_CURSOR` guards. The live payload
statement walk is `tests/customerLedgerCursor.api.test.ts`: the CustomerLedger
body is now a signed `(created_at, id)` read, and its page 2+ responses keep the
whole-statement opening/totals/running balances while rejecting newer and
same-timestamp rows inserted after page 1. Its `all=1` export is an explicit
full-statement read outside the pager: both a zero-page and a paged export build
the same chronological CSV with full-history balances, and a failed export
writes no file and leaves a retry control. The live payload
measurement was taken on a fresh server on port 3200, which was stopped and its
log/pid removed after the run; no scratch database or fixture rows remain
(branches: 6 total, 0 fixture rows).

### SCALE-3 — Partitioning, indexes, read/write split, PgBouncer

Priority: P0 · Status: `[~]` — provisioned partitioning, hot-table storage and
the `gl_subledger_entries` partition conversion landed 2026-11-17; the other
three conversions, BRIN/composite index work, replica routing and PgBouncer are
open. Audit:
[docs/database-optimization-audit-2026-11-17.md](../../docs/database-optimization-audit-2026-11-17.md).

- [x] Provision monthly partitions for **both** ledger parents. They are
      already RANGE-declared, but a fresh install only had `DEFAULT`
      (`schema.sql:4874-4875`); `boot/journalPartitions.ts` now creates the
      current month + 1 behind + 3 ahead on every boot (idempotent, leader-only
      through the existing boot lock) and reports how many rows sit in
      `DEFAULT`, and `npm run check:partitions` is the read-only gate that exits
      non-zero on a gap or a dirty `DEFAULT`.
      **Done 2026-11-17** — `tests/journalPartitions.test.ts` (window is
      contiguous; provisioning fills exactly the reported gaps; a second run is
      a no-op; each child's bound covers exactly its month). The
      detach/archive half is **not** done and is recorded as a deliberate
      deferral: a monthly `gl_journals` child is referenced by the inherited FK
      on `gl_journal_lines`, so removal needs a rehearsed detach + archive, not
      a boot job.
- [x] Convert `gl_subledger_entries` to RANGE partitioning by its document
      date (`entry_date_ad`). **Done 2026-11-17** — migration `0034` stages the
      rows, the CHECK/FOREIGN KEY/NOT NULL constraints and the canonical
      indexes, drops the plain table and recreates it partitioned with
      `PRIMARY KEY (id, entry_date_ad)`, then inserts the rows back through the
      parent; a row-count mismatch raises and the runner's transaction leaves
      the legacy table in place. The same month function the posting path
      already called (`ensure_journal_month_partition`, which now also calls
      `ensure_subledger_month_partition`) creates the child, and the
      append-only guard is attached to the parent and every child. Verified on
      the populated development database (231 rows → 231 across 14 month
      children, DEFAULT empty), by `EXPLAIN` pruning a one-month total to a
      single child, by a child-level UPDATE being refused, and by
      `node scripts/verify_fresh_install.mjs` (schema.sql + migrations
      identical to a booted install). Tests in `tests/journalPartitions.test.ts`.
- [ ] Convert `stock_operations`, `serial_log` and `sales_invoices` to the same
      shape. Do it as a shadow table + backfill + swap per table (the 0003/0032
      pattern), never an in-place rewrite of a billion rows. Composite primary
      keys must include the partition key, and each table keeps a globally
      unique business key (`reference_number`, the serial number, the invoice
      number) that a partitioned unique constraint cannot enforce without the
      date — so these three need the `gl_journals_registry` treatment (a small
      unpartitioned registry holding the unique key) before the swap, and the
      `ON CONFLICT` write paths move to that registry. That design is the
      reason this one is separate from the ledger conversion, not a missing
      patch.
- [ ] BRIN indexes on `created_at`, `journal_date_ad`, `entry_date_ad`,
      `operation_date_ad` (append-only, physically ordered); composite B-Tree
      `(branch_id, fiscal_year_id, <date> DESC, id DESC)` for the page reads.
      Drop the indexes the new composites make redundant, after measuring.
      **2026-11-17 assessment:** every current `audit_logs`/`transaction_logs`
      read is branch-scoped and page-ordered, which the existing B-Tree serves;
      a BRIN now would be write cost the planner never chooses. Trigger and the
      measurement query are recorded in the audit (§4).
- [x] Storage tuning for the two high-update tables with no rewrite:
      `inventory_stock` and `document_sequence_daily` now run at
      `fillfactor = 80` with `autovacuum_vacuum_scale_factor = 0.02` and
      `autovacuum_analyze_scale_factor = 0.05` (fresh installs from
      `schema.sql`, existing installs from `scripts/migrations/0030_hot_table_storage.sql`).
      **Done 2026-11-17.**
- [ ] `DATABASE_WRITE_URL` (primary) and `DATABASE_READ_URL` (replica), with
      `REPORT_DATABASE_URL` kept as an alias for compatibility. Separate pools
      with their own `PG_POOL_MAX`; `reportingPool` routes Trial Balance, P&L,
      Balance Sheet, Stock Valuation and Aging. A lag guard
      (`REPLICA_MAX_LAG_MS`, default 5,000) reads `pg_last_wal_replay_lsn()`;
      over the limit, fall back to primary or `503 Retry-After`.
- [ ] PgBouncer transaction-mode audit: remove session `SET`s, temporary
      tables, session advisory locks and `PREPARE`/`DEALLOCATE` from the
      request path. `statement_timeout` via `ALTER ROLE … SET`, not a pool
      `options` startup parameter. Test with `pool_mode=transaction`.
- [ ] Tenant/branch isolation at scale: every repository query already takes
      the session scope; add a CI guard that greps new SQL on the partitioned
      tables for a `branch_id` predicate (the review checklist, not a runtime
      substitute).

Acceptance: `EXPLAIN` prunes to one partition for a one-month trial balance;
provisioning creates 12 months of children idempotently and a second run is a
no-op; a trial balance on 10M lines completes under 100 ms on the fixture; a
replica-configured report is served by `pg_is_in_recovery() = true`; PgBouncer
transaction mode passes the smoke and the concurrency tests.

### SCALE-4 — Redis caching and write-path decoupling

Priority: P1 · Status: `[~]` — the shared-version piece is done; the cache-key
work is obsolete and the balance work is open.

> **Correction (2026-11-17).** The premise of the first three bullets — a
> synchronous post-commit reload of all `CACHE_LOADS` in the write path — no
> longer exists. OPS-2 deleted `cacheRefreshHook`; `middleware/stateVersion.ts`
> only bumps a counter after a successful non-GET, and `hydrateOperationalData`
> runs at boot alone. What WAS still per worker is that counter, which the
> bootstrap ETag is built from: a write on worker A left worker B answering
> `304` for a payload that had changed. That is fixed (below). Adding a cache
> bus with a per-route invalidation matrix would now be a second invalidation
> mechanism with no reload to remove.

- [—] Granular cache keys + single-flight population + an invalidation outbox.
      **Deliberately not doing:** there is no post-write cache reload to
      replace, so there is nothing for the keys, the lock or the outbox to
      coordinate. Reopen only if a cache hydration returns to a request path.
- [x] Share the bootstrap payload version across workers: `state/bootstrapVersion.ts`
      keeps `isp:state:version` in the shared store (`INCR` after a committed
      write, `GET` before the validator is computed), with the local counter as
      the single-worker and fail-open path. A Redis outage can serve a stale
      `304` for a moment — never a failed request.
      **Done 2026-11-17** — `tests/sharedState.test.ts` (a write on A moves B's
      validator; single worker still invalidates itself; a dead store falls
      back), with `tests/bootstrapEtag.test.ts` unchanged and green.
- [ ] Pre-aggregate stock: `branch_stock_balances(branch_id, product_id,
      quantity, value, updated_at)` maintained in the same transaction as the
      stock movement (or by a trigger), with a rebuild command. Stock-on-hand
      and the shell badges read it; the append-only ledger remains the audit
      source.
- [ ] Trial balance reads `fiscal_year_balances` for closed years and the
      summary/delta path for the open year; the P&L and balance sheet reuse the
      same producer. No statement scans the full line table.
- [ ] Write-path measurement: `npm run bench:write` at 10/50 concurrent writes
      must show scaling, not the current 0.7×.

Acceptance: a write's p95 is independent of catalog/document count on the
fixture; ten concurrent writes take no longer than the serial equivalent (≥ 1×
scaling); a cache invalidation is visible on a second worker within 1 s; a
Redis restart leaves reads correct (slower) and writes unaffected.

### PUB-1 — Edge TLS, HSTS and exact proxy hops

Priority: P0 · Status: `[ ]`

- [ ] Ship a reviewed reverse-proxy config (Nginx or Caddy) in `deploy/`:
      port 80 → `301 https://$host$request_uri`; TLS 1.2/1.3 only; a modern
      cipher list; OCSP stapling; HTTP/2; request/body/timeouts sized for the
      app (SSE included).
- [ ] Enable HSTS in `server/src/app.ts` for production:
      `max-age=63072000; includeSubDomains; preload`, and at the edge. Remove
      the `upgrade-insecure-requests` clearing once HTTPS is the only path.
- [ ] `TRUST_PROXY` must be the exact hop count (1 behind one proxy) or the
      precise proxy CIDRs; never `true` on a public listener. Add a boot guard:
      production requires `PUBLIC_ORIGIN` and an explicit `TRUST_PROXY`.
- [ ] Record the real client IP (`req.ip` after trust) in the audit trail, the
      API-key usage row and the rate-limit keys; a forged `X-Forwarded-For`
      from an untrusted source must not change any of them.
- [ ] No cookie auth exists today (Bearer tokens in localStorage); if refresh
      cookies are introduced, enforce `Secure; HttpOnly; SameSite=Strict` (or
      `Lax` + a CSRF token) in one helper.
- [ ] Optional but recommended at the edge: WAF/geo/ASN rules, connection
      limits, slowloris timeouts, and a DDoS provider in front.

Acceptance: `curl -I http://…` → `301` to HTTPS; `curl -I https://…` carries
HSTS; a TLS scan negotiates only 1.2/1.3; two requests through the proxy from
different clients produce different rate-limit buckets and audit IPs; a forged
`X-Forwarded-For` on a direct connection is ignored.

### PUB-2 — CORS, CSP, security headers and cookies

Priority: P0 · Status: `[ ]`

- [ ] `ALLOWED_ORIGINS` (comma-separated exact origins) drives CORS; no `*`,
      no reflected `Origin`, `Vary: Origin`, credentials only for an allowlisted
      origin. A request from an unknown origin gets no CORS headers and the
      browser blocks it; the server does not echo the origin.
- [ ] Helmet: CSP with `default-src 'self'`, no `unsafe-inline`/`unsafe-eval` in
      production, `frame-ancestors 'none'`, `object-src 'none'`,
      `base-uri 'self'`; `X-Frame-Options: DENY`,
      `X-Content-Type-Options: nosniff`,
      `Referrer-Policy: strict-origin-when-cross-origin`,
      `Permissions-Policy` minimal, `X-Powered-By` removed.
- [ ] A header snapshot test pins every value; a production build test asserts
      the CSP has no inline allowance (Vite dev may keep its documented
      exception).
- [ ] If cookies are used: one `setAuthCookie`/`clearAuthCookie` helper with
      the flags above and a CSRF double-submit token for state-changing
      requests; never put a token in a URL or query string.

Acceptance: allowed origin gets `Access-Control-Allow-Origin` exactly; a
disallowed origin gets none; the production header set matches the snapshot;
no `unsafe-inline` in the production CSP.

### PUB-3 — Public surface, distributed limits, MFA, setup lockout

Priority: P0 · Status: `[ ]`

- [ ] `/api/db/status` returns exactly `{ isConnected: boolean }`; host, port,
      database, user, table count and driver text move behind a Super-Admin
      endpoint (or disappear). This is audit H5's public half.
- [ ] No version banner, stack trace, internal hostname or SQL text in any
      response. Route every failure through `ApiError` + the central handler
      with a correlation id (H5's 71 sites).
- [ ] Redis-backed limits on every public route — login, forgot-password,
      setup, SSE ticket exchange, API-key auth, general API — with per-IP,
      per-account/key, and a global safety bucket; exponential backoff and
      account lockout; `429` + `Retry-After` + `X-RateLimit-*`.
- [ ] TOTP MFA for `SUPER_ADMIN` and `HEAD_OFFICE_ADMIN`: enrolment with
      recovery codes, a challenge step at login, an `mfa` claim in the token,
      and a middleware gate for privileged routes. MFA must be enforced before
      the login page is exposed publicly.
- [ ] Setup lockout: once a Super Admin exists, the setup routes return `404`
      at the router level (not a handler check), and the `SETUP_TOKEN` flow
      cannot be re-entered. A test creates the first admin, then asserts `404`
      on every setup path.
- [ ] Public bot defense at the edge: request size caps, per-IP connection
      caps, optional CAPTCHA/proof-of-work on login and signup-like routes.

Acceptance: unauthenticated `/api/db/status` has only the boolean; a second
worker shares the same login budget; setup paths are `404` after first admin;
an admin token without an MFA claim is refused on privileged routes; a
distributed credential-stuffing probe from two IPs hits the account bucket.

### PUB-4 — Network isolation and container hardening

Priority: P0 for the network rules, P1 for the image polish · Status: `[ ]`

- [ ] PostgreSQL and Redis bind only to private interfaces; security groups /
      firewall allow only the app subnet; no public `5432`/`6379`.
- [ ] `sslmode=verify-full` (with the CA) between app and PostgreSQL; Redis
      TLS (`REDIS_TLS_URL`) with auth; credentials in a secret store, never in
      compose/git.
- [ ] `/metrics` and diagnostics bind to a private listener or require
      Super-Admin/mTLS; a public request gets `404`.
- [ ] `Dockerfile`: multi-stage build, non-root `USER`, `HEALTHCHECK` against
      `/api/health`, no build tools in the runtime layer, `npm ci --omit=dev`,
      read-only root filesystem, `tmpfs` for `/tmp`, `--cap-drop ALL`,
      `no-new-privileges` in the compose/k8s sample.
- [ ] `engines.node` pinned; the image tag is digest-pinned in the deploy
      sample.

Acceptance: an external port scan of the host shows only 443 (and 80 for the
redirect); the container runs as a non-root UID, the healthcheck passes, and
the app starts with a read-only rootfs; `/metrics` is unreachable publicly.

## Order of work

> **Availability prerequisite:** Round 12's **OPS-1** (database circuit breaker
> + per-request `503`) is implemented and verified (2026-11-16,
> `tests/dbAvailability.test.ts`). SCALE-1 must preserve that fail-fast path
> when it moves shared state to Redis. Round 12's **OPS-2** (bootstrap ETag and
> 304 before the queries) is also complete (2026-11-16); its OPS-5 baseline
> probe is also complete (2026-11-16), as is OPS-4 (statement timeout and
> breaker knobs, `tests/ops4Config.test.ts`), BAK-1 (verified backups,
> `tests/backupScript.test.ts`), BAK-2 (guarded restore,
> `tests/restoreScript.test.ts`), BAK-3 (the disposable restore drill,
> `tests/restoreDrill.test.ts`), BAK-4 (the destructive `setup:pg` guard,
> `tests/setupGuard.test.ts`) and BAK-5 (the operator disaster-recovery runbook,
> `tests/disasterRecoveryRunbook.test.ts`) and OPS-3 (bootstrap payload
> measurement and first split, `tests/bootstrapPayloadMeasure.test.ts`) are
> complete. Round 12 is closed; **SCALE-1** remains the enterprise-scale next
> step, followed by SCALE-2's < 15 KB end state.

1. **SCALE-1** — without shared state, every later slice is single-node only.
2. **SCALE-2** — bootstrap < 15 KB and keyset pagination; Round 12's OPS-3
   delivered the measurement and first split, this is the end state.
3. **SCALE-3** — partitioning/indexes/replica/PgBouncer. Do the index work
   before the largest partition swaps so the backfill has a supporting path.
4. **PUB-1 → PUB-2 → PUB-3 → PUB-4** — edge first, then headers, then surface
   and identity, then network/container. MFA (PUB-3) gates Round 14's admin UI.
5. **SCALE-4** — cache/write-path decoupling last; it depends on Redis and on
   the read paths above.

## Dependencies and conflicts

- Round 12's OPS-3 stops at the first split; the **< 15 KB** end state is
  SCALE-2. Do not close SCALE-2 by moving one register and calling it done.
- Round 12's OPS-4 keeps `PG_POOL_MAX=40` as a per-worker default; the
  enterprise ceiling is PgBouncer + shared pools (SCALE-3), not a larger
  per-worker pool.
- Round 14 depends on SCALE-1 (Redis for key rate limits/revocation) and PUB-3
  (MFA for the management endpoints). Its schema slice can start in parallel.
- **`0030` is taken** (`0030_hot_table_storage.sql`, 2026-11-17). Audit H6's
  `0030_fk_indexes` and the API-key migration take `0031` onward in the order
  the slices actually land.
- `gl_journal_lines` is already RANGE-declared; do not write a migration that
  "adds partitioning" without first checking whether the target install has
  monthly children or only `DEFAULT`.

## Gates

- `npx tsc --noEmit`, `node scripts/run_tests.mjs`
- `npm run check:no-inline-sql`, `npm run check:no-raw-dialogs`
- `npm run build`, `npm run check:bundle-budget`, `npm run check:boot-timing`
- `node scripts/verify_fresh_install.mjs` after every schema/partition change
- `npm run integrity:check`
- Two-worker smoke (login, SSE across workers, shared rate limit, graceful kill)
- `EXPLAIN (ANALYZE, BUFFERS)` evidence for every changed large query
- Replica-routing test with `pg_is_in_recovery()`
- PgBouncer transaction-mode smoke
- TLS/header scan and external port scan

## Verification commands (shape)

```bash
# Shared state
redis-cli -u "$REDIS_URL" ping
pm2 start ecosystem.config.js && pm2 ls          # instances: max, cluster
node scripts/two_worker_probe.mjs                # SSE A→B, shared limit, kill A

# Payload and paging
node scripts/measure_bootstrap_payload.mjs       # < 15 KB gzip on the fixture
node scripts/seed_scale_fixture.mjs --customers 5000000 --lines 10000000
npm run perf:bootstrap -- --concurrency 3000 --requests 6000

# Partitioning / plans
node scripts/check_partitions.mjs                # children, DEFAULT empty, lookahead
psql "$DATABASE_READ_URL" -c "select pg_is_in_recovery()"
psql "$DATABASE_URL" -c "explain (analyze, buffers) <one-month trial balance>"

# Public edge
curl -sI http://erp.example.com | head -1         # 301
curl -sI https://erp.example.com | grep -i strict-transport-security
nmap -Pn -p- erp.example.com                      # 443 (+80 redirect) only
```

## Risks and open questions

- **Redis becomes a hard dependency.** Decide HA (Sentinel/Cluster/managed),
  persistence, and the fail-open/fail-closed policy per feature before
  SCALE-1. A single Redis is a new outage domain.
- **Partition conversion is the highest-risk migration in the project.** The
  four unpartitioned tables need shadow-table backfills with dual-write or a
  maintenance window; rehearse on a restored production copy, not the demo DB.
- **`DEFAULT` partitions hide mistakes.** A row that lands in `DEFAULT` avoids
  an error but defeats pruning; monitor `DEFAULT` row counts and alert on any
  growth.
- **Replica lag vs ledger truth.** A trial balance read from a lagging replica
  can disagree with a just-posted journal. Decide per endpoint: exact reads stay
  on the primary; analytical reads may be lagged and must say so.
- **PgBouncer breaks session assumptions.** Any `SET`, temp table or prepared
  statement that survives a transaction will fail in production, not in dev.
  The audit is part of SCALE-3, not an afterthought.
- **< 15 KB may conflict with offline-tolerant screens.** Each removed key needs
  a real loading state; a first paint that blocks on five slices is worse than
  a 40 KB payload. Measure Time-to-Interactive, not just bytes.
- **HSTS preload is effectively irreversible.** Enable it only after HTTPS is
  verified on every subdomain; a preload mistake locks users out for the
  max-age.
- **MFA rollout can lock out administrators.** Ship recovery codes and a
  break-glass procedure before enforcing; test the lost-device path.
- **CSP can break the Vite build.** The production CSP differs from dev by
  design; pin both with tests so a dev-only allowance cannot ship.
- **`TRUST_PROXY=true` is a vulnerability, not a convenience.** Express trusts
  the leftmost `X-Forwarded-For`; with a public listener that lets a client
  choose its own IP for rate limits and audit.

## Definition of done

- [ ] Two or more workers run in cluster mode with shared sessions, limits,
      locks and SSE; killing a worker loses no session.
- [ ] Bootstrap measures < 15 KB on the 5M-customer fixture; every large list
      is keyset-paginated and scope-required.
- [ ] The ledger and the four growth tables have provisioned partitions,
      measured plans, BRIN + composite indexes, and a retention/archival job.
- [ ] Reporting runs on the replica with a lag guard; the primary serves writes.
- [ ] PgBouncer transaction mode passes the smoke and concurrency tests.
- [ ] The public edge enforces HTTPS/HSTS, exact proxy hops, strict CORS/CSP,
      distributed limits, MFA for admins, setup `404`, and no unauthenticated
      metadata.
- [ ] PostgreSQL/Redis/metrics are unreachable from the public internet; the
      container runs non-root with a healthcheck.
- [ ] The before/after measurements are recorded here and the commit hashes are
      listed.
