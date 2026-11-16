# Round 12 — Backup/recovery and database availability

Status: `[~]` in progress · Opened 2026-11-16 · Owner: main · OPS-1/2/4/5 and BAK-1/2/3/4 done

Source findings: [docs/audit-2026-11-15.md](../../docs/audit-2026-11-15.md)
**C1** — no backup, restore or disaster-recovery capability; **H1** —
`GET /api/bootstrap` collapses at 50 concurrent users and can flip the whole API
to "database down".

Provenance note: the older 2026-11-04 audit (superseded by the 2026-11-15
report; retained in git history) uses **C1** for a different finding (the
missing client error boundary, since fixed) and **D1** for the first version of
the availability bug. The 2026-11-15
audit is the current evidence; this round is scoped to its C1/H1 and does not
reopen the closed 2026-11-04 items.

## Why this round exists

Both findings share one property: the worst case is not a slow screen, it is
unrecoverable or company-wide. The audit measured:

| Measurement | Value | Source |
|---|---|---|
| `/api/bootstrap`, 10 concurrent | p50 241 ms, p95 349 ms, 155.2 KB/response | audit §3 |
| `/api/bootstrap`, 50 concurrent | p50 2,339 ms, p95 4,208 ms, ~22 rps | audit §3 |
| 50-concurrent cold run | **29 / 120 failures**, then ~60 consecutive `PostgreSQL is not connected` log lines | audit §3 |
| Backup artefacts in the tree | none — one ad-hoc `pg_dump` line in `README.md:531` and two in `UPDATEPROCESS.md:92-125` | audit C1 |
| Operator wipe | `npm run setup:pg` truncates every operational table with no confirmation | `scripts/setup_db.js:65-80` |
| Pool configuration | max 40, acquire timeout 2,000 ms, no `statement_timeout` | `server/db.ts:36-48` |

A single disk failure or one mistaken `npm run setup:pg` destroys the financial
history. A single saturated pool currently turns one caller's timeout into every
caller's 503. Neither is a polish item.

## Programme constraints (2026-11-16 mandate)

The mandate raises the target beyond the audit's 500-user model, so this round
may not optimize only for that model. The envelope is tracked in
[Round 13](../2026-11-16-enterprise-scale-and-public-exposure/README.md):

| Dimension | Mandated target |
|---|---|
| Concurrent sessions | 3,000–10,000+ |
| Branches | 200–500+ |
| Customers | 5M–50M+ |
| Transactional rows | 1B–10B+ |
| `/api/bootstrap` | < 15 KB |
| API processes | N workers, stateless, shared Redis state |

Three consequences for this note:

- **OPS-3 is no longer conditional.** The < 15 KB bootstrap is a hard end state;
  measurement only orders the work. This round lands the first tranche;
  SCALE-2 owns the end state and the keyset pagination that makes it possible.
- **`PG_POOL_MAX=40` is a per-worker default, not the enterprise ceiling.** The
  ceiling is PgBouncer plus shared pools (SCALE-3); raising 40 in every worker
  multiplies connections and is not a scaling strategy.
- **The breaker and the ETag are prerequisites for scale, not alternatives to
  it.** A 10k-session refresh wave is exactly when one timeout must not become a
  global outage, and when a version ETag prevents ~1.5 GB of repeated payload.

The public-exposure mandate (HSTS, strict CORS/CSP, distributed limits, MFA,
network isolation) is Round 13's PUB-1…4; this round supplies the per-request
503 semantics and the bootstrap caching those depend on.

## Mission traceability

Every requirement in the two mission tasks maps to a slice; nothing is left as
"understood".

| Mission requirement | Slice | How it is covered |
|---|---|---|
| C1.1 `scripts/backup.sh`: `pg_dump -Fc`, configurable off-host dir, timestamped names, 30 daily retention, optional gpg/openssl | BAK-1 | 30 dailies + 12 monthlies; `.verified` marker makes it a backup rather than a file; recipient or passphrase-file encryption |
| C1.2 `scripts/restore.sh` into a target database | BAK-2 | refuses a live target without `--yes` + typed confirmation; optional pre-restore safety dump; transactional restore |
| C1.3 `check_restore_drill.mjs` + `npm run check:restore-drill`, scratch DB, row counts, debit = credit, checksum, drop | BAK-3 | parent-only catalogue counts, per-journal balance, deterministic trial-balance checksum, `DROP … WITH (FORCE)` in `finally` |
| C1.4 `setup:pg` requires `--force` + verified backup < 24 h, `--skip-backup-check` for CI | BAK-4 | guard runs before any connection; `--keep-data` is exempt because it does not truncate |
| C1.5 `docs/disaster-recovery-runbook.md`: RPO/RTO, cron/systemd, pgBackRest/WAL-G, restore steps | BAK-5 | RPO 15 min is stated only once WAL archiving is live; dump-only RPO is 24 h |
| H1.1 distinguish pool-acquire/connect timeouts; never flip on one | OPS-1 | category classifier; acquire-phase failures never count toward the breaker |
| H1.2 N-consecutive breaker, auto-recovery, `503` + `Retry-After` per request | OPS-1 | 3 failures / 30 s window, 5 s cooldown, one half-open probe, success closes |
| H1.3a ETag + `If-None-Match` / `304` | OPS-2 | new `stateVersion` decided before the first query; Express's default ETag runs too late |
| H1.3b audit the 155 KB payload and split rare registers | OPS-3 first tranche, SCALE-2 end state | mandate makes < 15 KB mandatory; measurement only orders the work |
| H1.4 `PG_POOL_MAX`, `PG_CONNECT_TIMEOUT_MS`, `statement_timeout` env | OPS-4 | the first two are already wired through `intFromEnv`; only `statement_timeout` is new |
| Verification: `setup:pg` exits non-zero; backup + drill exit 0; `tsc` | BAK-4, BAK-1/3, Gates | exact commands under "Verification"; the drill must also be proven to fail |
| Verification: saturation test leaves the flag true; 50-concurrent probe, 0 "not connected", sub-second `304` | OPS-1, OPS-5 | `tests/dbAvailability.test.ts` + `perf:bootstrap --assert` (304 p95 < 1 s) |

## Scope

**In:** `scripts/backup.sh`, `scripts/restore.sh`,
`scripts/check_restore_drill.mjs`, the `setup:pg` guard, the DR runbook, the DB
failure classifier/circuit breaker, per-request 503 + `Retry-After`, bootstrap
ETag/304, the payload measurement and first split (the < 15 KB end state is
SCALE-2 in Round 13), `statement_timeout` plus the breaker/timeout env knobs,
and a repeatable bootstrap load probe.

**Out (deliberately):** WAL archiving *implementation* (the runbook documents
the configuration; choosing and provisioning pgBackRest/WAL-G is an operational
decision), point-in-time restore automation, off-host transport provisioning,
TLS/at-rest encryption (H3), write-path scaling (H4), error-detail leaks (H5),
FK indexes (H6) — those are owned by Round 13 or a later credential round — and
every Medium/Low item in the audit. The deferred register records where each
went.

## What is true in the tree today

Verified against the working tree on 2026-11-16, not inferred from the audits:

| Area | Today | Gap this round closes |
|---|---|---|
| Backup scripts | `scripts/` has 24 files (plus `migrations/` and `seed/`); no `backup.sh`, `restore.sh` or drill | BAK-1…3 |
| Backup guidance | `README.md:531` suggests `pg_dump … > backup_$(date +%Y%m%d).sql`; `UPDATEPROCESS.md:92-125` does a pre-update dump by hand | BAK-5 replaces both with a pointer to the runbook |
| `setup:pg` wipe | `scripts/setup_db.js` truncates every table except `bs_calendar_years` / `bs_day_records`, then deletes `fiscal_years`, **before** any confirmation | BAK-4 |
| Classifier | `server/db.ts:165-177` excludes the pool-acquire message but still matches `/Connection terminated/` and `ETIMEDOUT` unconditionally | OPS-1 |
| Global flag | `server/db.ts:202-204` sets `isPgConnected = false` on the first classified error | OPS-1 |
| Second poisoning path | `server/src/controllers/bootstrap.controller.ts:243-250` catches **any** bootstrap error and calls `setPgConnected(false)` + `setIsPgConnected(false)` | OPS-1 |
| Recovery probe | `requirePostgres` (`server/src/middleware/index.ts:37-53`) calls `ensurePostgresConnection()` on every request while the flag is down — no single-flight, no cooldown, no `Retry-After` | OPS-1 |
| Flag mirrors | `isPgConnected` in `server/db.ts` and `server/src/state/runtimeState.ts:85` are separate; `requirePostgres` checks both | OPS-1 |
| Bootstrap caching | No `etag` setting in `server/src/app.ts`; `res.json()` therefore gets Express's default weak ETag, computed **after** every query and the full serialization. `Cache-Control: private, no-cache` is set explicitly | OPS-2 |
| Version key | `setDataVersion` has exactly two call sites, both in `admin.controller.ts:154,194` (demo-clear). No ordinary write bumps it. The old `cacheRefreshHook` is gone — `tests/cacheLoads.parity.test.ts:77-80` asserts it | OPS-2 |
| Pool knobs | `PG_POOL_MAX` (40) and `PG_CONNECT_TIMEOUT_MS` (2,000) are already wired through `intFromEnv`; `statement_timeout` is nowhere in `server/` | OPS-4 |
| Ledger shape | `gl_journals` / `gl_journal_lines` are RANGE-partitioned by `journal_date_ad`; lines carry `debit` / `credit NUMERIC(14,2)` and the `one_sided` CHECK; headers carry `status POSTED/REVERSED` | BAK-3 SQL below |
| Load probe | `scripts/bench_write_latency.mjs` exists; nothing probes `/api/bootstrap` | OPS-5 |

## Decisions

1. **A dump is not a backup until it has been read back.** Every dump gets a
   sidecar manifest (row counts + GL checksum), a SHA-256, and a
   `.verified` marker written only after `pg_restore --list` succeeds (and,
   for encrypted dumps, after a decrypt round-trip). `setup:pg` trusts the
   marker, not the file mtime.
2. **Encryption is asymmetric-first, but must stay verifiable.** Preferred:
   `BACKUP_GPG_RECIPIENT` (public key only on the database host). A passphrase
   file (`BACKUP_PASSPHRASE_FILE`, mode 0400) is the fallback for `gpg
   --symmetric` or `openssl enc`. A raw passphrase in an environment variable
   is never passed as an argument (it would appear in `ps`); if
   `BACKUP_ENCRYPTION_KEY` is set it is fed on stdin, never argv.
3. **Retention is 30 daily, 12 monthly, and never deletes the newest set.**
   Daily and monthly buckets are computed from the filename timestamp; a dump
   group (`.dump`, `.manifest.json`, `.sha256`, `.verified`, encrypted sibling)
   is deleted as a unit, oldest first, and only when a newer verified dump
   exists.
4. **The destructive path is guarded; `--keep-data` is not.** `setup:pg` demands
   `--force` plus a verified backup younger than 24 h before it will truncate.
   `--keep-data` does not truncate, so it stays exempt and logs that it is.
   `--skip-backup-check` still requires `--force` and prints a loud warning.
5. **A timeout is not a dead server.** Only an established socket that dies, or
   an explicit server refusal/shutdown, counts toward the breaker; a pool-acquire
   timeout, a connect timeout with no client handed out, `57014`, and every
   ordinary SQL error count for nothing.
6. **The breaker is the only writer of the availability flag.** No request
   handler may set it from its own catch block. Three consecutive socket-level
   failures within 30 s open it; one successful query closes it; an open breaker
   probes once after a 5 s cooldown (single-flight), not once per request.
7. **504-class failures are per-request 503s.** Acquire/connect/statement
   timeouts become `503` with `Retry-After`, tagged `DB_BUSY`; an open breaker
   answers `503` `DB_UNAVAILABLE` with the same header. The body never carries
   driver text.
8. **The ETag is a version, not a body hash.** The 304 must be decided before
   `fetchFiscalYears`, `fetchOperationalData`, the financial summary and the
   settings reads. A new `stateVersion` (bumped once per successful non-GET) plus
   the user's session fingerprint (`user.id` + `ver`) plus `branchId` +
   `fiscalYearId` is the ETag input. Express's automatic weak ETag stays as a
   last-resort correctness net, not as the optimization.
9. **The payload split follows measurement, but it is mandatory.** No key
   leaves the bootstrap until a per-key size measurement exists and the key
   already has a paged endpoint or a `/api/bootstrap/local?key=` consumer path;
   first paint must not gain a spinner. The 2026-11-16 mandate makes the split a
   requirement, not an option — measurement orders it, and the < 15 KB end state
   belongs to SCALE-2.

## Work slices

### OPS-5 — Repeatable bootstrap load probe and baseline

Priority: P0 (it proves OPS-1/OPS-2) · Status: `[x]` (2026-11-16)

- [x] `scripts/load_probe_bootstrap.mjs`, modelled on
      `scripts/bench_write_latency.mjs`: sign in once, reuse the token, run
      `--concurrency` (default 50) × `--requests` (default 120) against
      `GET /api/bootstrap`, record status, bytes, p50/p95/p99.
- [x] Second wave sends `If-None-Match` from the first response and reports
      `200` / `304` / `503` counts separately.
- [x] `--assert` mode exits non-zero on any `503`, any `5xx`, or fewer than 90%
      `304`s in the second wave. `--json` writes the measurement for the note.
- [x] Register `perf:bootstrap` in `package.json`; do not wire it into `npm test`
      (it needs a seeded database and a running server).
- [x] Record the baseline in this note (p50/p95, failures, any
      `PostgreSQL is not connected` lines) before touching `server/db.ts`.

Acceptance: the probe reproduces the audit's shape on the audit workstation
(tens of ms at 10 concurrent, seconds at 50), and its output names the server
log file an operator must grep. In `--assert` mode it also fails when the second
wave's `304` p95 is ≥ 1,000 ms — the mission's "sub-second cached 304" gate. The
probe itself must not be the reason a healthy server looks unhealthy: it aborts
after `--timeout-ms` per request.

**Verified 2026-11-16** — `tests/bootstrapProbe.test.ts` (5 tests): a fixture
server proves 200→304 passes, a 503 fails, and a no-304 second wave fails the
90% rule; the pure evaluator pins the 1,000 ms p95 boundary; and a real
`createApp()` + PostgreSQL run proves wave 1 is 200 and wave 2 is 304 with
`--assert` exit 0. No test sleeps; the fixture answers immediately.

**Baseline recorded 2026-11-16** against the real server on this workstation
(seeded dev database, 161,528-byte payload, `.tmp-server.log`):

| concurrency | requests/wave | full p50/p95 ms | 304 p50/p95 ms | 503 | 5xx | `PostgreSQL is not connected` |
|---|---|---|---|---|---|---|
| 10 | 20 | 823.66 / 1,747.26 | 15.92 / 21.07 | 0 | 0 | 0 |
| 50 | 60 | 2,040.49 / 2,123.38 | 30.22 / 41.81 | 0 | 0 | 0 |

Both runs passed the assertions; the second wave stayed under 50 ms p95. The
50-concurrency run is the audit's "seconds" shape. **The pre-OPS-1 baseline was
not captured** — OPS-5 landed after OPS-1/OPS-2, so this table is the current
post-change baseline, and the pre-change `server/db.ts` numbers remain the
audit's, not a fresh measurement.

Commands: `npx tsx --test tests/bootstrapProbe.test.ts` → **5 pass**;
`npm run perf:bootstrap -- --concurrency 50 --requests 60 --assert --json` → exit
0; `npx tsc --noEmit` → exit 0.

Next slice: **OPS-4 — statement_timeout and the breaker knobs.**

### OPS-1 — Circuit breaker and per-request 503

Priority: P0 · Status: `[x]` (2026-11-16)

- [x] Replace the boolean `isConnectionLevelFailure` with a classifier that
      returns a category: `pool_acquire_timeout`, `connect_timeout`,
      `statement_timeout`, `query_error`, `server_unreachable`,
      `socket_dropped`. Keep `isConnectionLevelFailure` as a thin wrapper for
      the existing tests/importers until every caller is migrated.
- [x] Rules: no client acquired → never counts. SQLSTATE `08*`, `57P01`,
      `57P02`, `57P03` → `server_unreachable`. `ECONNREFUSED`, `ENOTFOUND`,
      `EAI_AGAIN`, `ECONNRESET`, and `Connection terminated…` **on an acquired
      client** → `socket_dropped`. `57014` → `statement_timeout`. Any other
      SQLSTATE → `query_error`. `ETIMEDOUT` without a client → `connect_timeout`
      (does not count); `ETIMEDOUT` on an acquired client → `socket_dropped`
      (counts, but only as one of N).
- [x] New pure state machine (`server/src/observability/dbBreaker.ts`):
      threshold 3, window 30 s, cooldown 5 s doubling to a 30 s cap, half-open
      single probe, success closes and resets. Export a snapshot for tests.
- [x] `pgPool.query` records failures/successes on the breaker; it no longer
      writes `isPgConnected`. `ensurePostgresConnection` is single-flight and
      only its result closes/opens the breaker.
- [x] Collapse or synchronize the two flag mirrors (`server/db.ts` and
      `runtimeState.ts`) behind one setter so `requirePostgres` cannot read a
      stale copy.
- [x] `requirePostgres`: while open, return `503` + `Retry-After` immediately;
      one probe after cooldown, never one per queued request.
- [x] Remove the blanket `setPgConnected(false)` from
      `bootstrap.controller.ts`; classify, log, and return `503` +
      `Retry-After` only for availability categories, `500` otherwise.
- [x] Tag timeout errors (`DbTimeoutError` / `DbUnavailableError`) and map them
      in the central error handler to `503` + `Retry-After` (`DB_BUSY` /
      `DB_UNAVAILABLE`). No driver text in the body.
- [x] Metrics: breaker opens, half-open probes, acquire timeouts, statement
      timeouts. Do not add a public endpoint.

Acceptance: with `PG_POOL_MAX=1` and one connection held, a query fails with
`503` + `Retry-After` and `getIsPgConnected()` stays `true`; three synthetic
socket failures open the breaker and the next request gets `503` without a
database call; one successful probe closes it. No request path outside the
breaker writes the flag (boot may set the initial state through the single
`setDatabaseConnected` setter).

**Verified 2026-11-16** — `tests/dbAvailability.test.ts` (12 tests) drives the
real stack `createApp() → authenticateUser → requirePostgres → route →
errorHandler`; `tests/customerDirectoryFailure.test.ts` and
`tests/requirePostgresGate.test.ts` were updated to the new payload.

| # | Condition | Observable assertion |
|---|---|---|
| 1 | `PG_POOL_MAX=1`, one connection held, `GET /api/__ops1_query` | `503`, `Retry-After ≥ 1`, `{code:'DB_BUSY'}`, no driver text, `getIsPgConnected() === true`, breaker `closed` |
| 2 | three `socket_dropped` failures, `GET /api/__ops1_ping` | `503`, `Retry-After ≥ 1`, `{code:'DB_UNAVAILABLE'}`, wrapped pool `connect` called **0** times |
| 3 | cooldown elapsed, one probe, `GET /api/__ops1_ping` | `200 {ok:true}`, breaker `closed`, `getIsPgConnected() === true` |

Commands: `npx tsx --test tests/dbAvailability.test.ts
tests/customerDirectoryFailure.test.ts tests/requirePostgresGate.test.ts` →
**21 pass, 0 fail**; `npx tsx --test tests/docsTruth.guard.test.ts
tests/docsCounts.guard.test.ts` → **11 pass**; `npx tsc --noEmit` → exit 0.

OPS-2 followed and is complete; OPS-5 is also complete and **OPS-4 is the next
slice** (both recorded below).

### OPS-2 — Bootstrap ETag and 304 before the queries

Priority: P0 · Status: `[x]` (2026-11-16)

- [x] Add `stateVersion` + `bumpStateVersion()` to `runtimeState.ts`. Bump it
      once per successful non-GET at the same single point that refreshes the
      operational caches (the replacement for the removed `cacheRefreshHook`;
      confirm the exact hook while implementing, and pin it with a test).
      `dataVersion` keeps its current meaning for SSE/sync.
- [x] In `get_bootstrap`, compute
      `W/"<stateVersion>-<sha1(user.id|user.ver|branchId|fiscalYearId)>"`
      **before** the first query. Include `Vary: Authorization,
      Accept-Encoding`. On `If-None-Match` equality return `304` with no body.
- [x] Keep `Cache-Control: private, no-cache`; never make the payload public.
- [x] Client: `client/src/services/api/bootstrap.ts` stores the last
      `{etag, payload}` per scope (in memory; `sessionStorage` optional) and
      sends `If-None-Match`. `fetchJson` needs a way to return "not modified"
      without parsing a body — add a `FetchJsonConfig` sentinel or a dedicated
      `fetchBootstrap` path rather than changing every caller.
- [x] Do not 304 when the effective permission matrix or user preferences
      changed: all writes bump `stateVersion`, and `user.ver` covers role,
      branch scope, switch permission, status and password. Document the one
      remaining hole (an out-of-band SQL edit bypasses the bump; a restart or
      any write revalidates) in the code comment.
- [x] Ensure compression does not interfere: set the ETag before
      `res.json()`, and confirm a 304 is not compressed and carries no body.

Acceptance: first GET → `200` + `ETag`; identical GET with `If-None-Match` →
`304`, empty body, same ETag, and the server log shows no bootstrap query for
that request; a different `branchId`/`fiscalYearId` → `200`; a write followed by
the same GET → `200` with a new ETag.

**Verified 2026-11-16** — `tests/bootstrapEtag.test.ts` (5 tests) drives real
HTTP through `createApp() → authenticateUser → requirePostgres → get_bootstrap`
against PostgreSQL. The 304 test wraps `pgPool.query` for that request only, so
"no bootstrap query" is an asserted count, not a timing inference.

| # | Condition | Observable assertion |
|---|---|---|
| 1 | first `GET /api/bootstrap` | `200`, `ETag` = `W/"<stateVersion>-<sha1(scope)>"`, `Cache-Control: private, no-cache`, `Vary: Authorization, Accept-Encoding` |
| 2 | same GET + matching `If-None-Match` | `304`, empty body, same ETag, no `Content-Encoding`, **0** `pgPool.query` calls |
| 3 | stale/missing validator | `200` with the full body and the current ETag |
| 4 | `?branchId=…` and `?fiscalYearId=…` | `200`, a different ETag for each scope |
| 5 | real `PUT /api/company-profile`, then old ETag | `200`, new ETag, payload's `companyProfile.name` reflects the write |

The single bump point is `server/src/middleware/stateVersion.ts`, mounted once
in `createApp`: a 2xx/3xx non-GET bumps `stateVersion` on response finish; a
failed write does not. The old `cacheRefreshHook` no longer exists, so this
middleware is its replacement. Client caching is per token + branch + fiscal
year in `client/src/services/api/bootstrap.ts`; a 304 returns the cached
payload without body parsing.

Commands: `npx tsx --test tests/bootstrapEtag.test.ts tests/bootstrapTrim.test.ts
tests/bootstrapTrimStep5.test.ts tests/bootstrapFiscalYearHonesty.test.ts
tests/bootstrapSlices.test.ts` → **41 pass, 0 fail**; docs guards → **11 pass**;
`npx tsc --noEmit` → exit 0.

OPS-5 and OPS-4 followed and are complete (above); BAK-1 followed and is
complete (below); BAK-2 followed and is complete (below); BAK-3 followed and is
complete (below); BAK-4 is complete (below); BAK-5 is complete (below); the
next slice is **OPS-3 — bootstrap payload measurement and first split.**

### OPS-4 — Timeout and breaker configuration

Priority: P1 · Status: `[x]` (2026-11-16)

- [x] `PG_STATEMENT_TIMEOUT_MS` in `buildPoolConfig` via `strictIntFromEnv`
      (default 30,000; `0` = disabled; bounds 1,000–600,000). Applied as the
      pg **startup parameter** (`statement_timeout` in the pool config), so it
      is active before the first query on every session, including the boot
      probe and the reporting pool. (The original plan said `pool.on('connect')`
      + `SET`; the driver's startup parameter is stronger and avoids a query
      queued behind the `SET`.)
- [x] Breaker knobs: `DB_BREAKER_FAILURE_THRESHOLD` (3),
      `DB_BREAKER_COOLDOWN_MS` (5,000), `DB_RETRY_AFTER_SECONDS` (2), all
      strict; `DB_BREAKER_WINDOW_MS` (30,000) and
      `DB_BREAKER_MAX_COOLDOWN_MS` (30,000) are strict too.
- [x] Keep `PG_POOL_MAX=40` and `PG_CONNECT_TIMEOUT_MS=2000` as the per-worker
      defaults; raising the pool is only justified after the probe shows acquire
      queueing, and the enterprise ceiling is PgBouncer + shared pools
      (SCALE-3), not a larger pool in every worker.
- [x] Document every new variable in `.env.example` (and README/handoff where
      the existing pool knobs are described). `tests/envDocs.guard.test.ts`
      fails otherwise; `tests/envWiring.test.ts` covers the new timeout.

Acceptance: `PG_STATEMENT_TIMEOUT_MS=1000` makes `SELECT pg_sleep(5)` fail with
`57014`, that failure does **not** open the breaker, and the next ordinary query
succeeds; unset, `SHOW statement_timeout` reports `30s`.

**Verified 2026-11-16** — `tests/ops4Config.test.ts` (7 tests) uses the real
pool, real HTTP through `createApp()`, and a child-process import for boot
configuration. No test sleeps on a fixed timer; the 5 s statement is cancelled
by PostgreSQL at the configured 1 s.

| # | Condition | Observable assertion |
|---|---|---|
| 1 | `PG_STATEMENT_TIMEOUT_MS=1000`, real `SELECT pg_sleep(5)` | rejects near 1.0 s with `DbBusyError` **503 / `DB_BUSY`**, `Retry-After: 2`, `cause.code='57014'`; next `SELECT 1` succeeds; breaker stays `closed` |
| 2 | the same statement through real HTTP | `503`, `Retry-After: 2`, `{code:'DB_BUSY'}`, generic body with no `pg_sleep`/`57014`/driver text |
| 3 | `DB_BREAKER_FAILURE_THRESHOLD=2`, `DB_BREAKER_COOLDOWN_MS=100` | opens at the second failure, one probe allowed after 100 ms, success closes; `dbRetryAfterSeconds() === 2` |
| 4 | invalid timeout **or** breaker threshold at boot | child import exits non-zero and names `PG_STATEMENT_TIMEOUT_MS` / `DB_BREAKER_FAILURE_THRESHOLD` |
| 5 | unset | a real session's `SHOW statement_timeout` reports `30s` |

Commands: `npx tsx --test tests/ops4Config.test.ts tests/envWiring.test.ts
tests/envDocs.guard.test.ts` → **20 pass, 0 fail**; the full suite and guards
are recorded in the final tally.

Next slice after BAK-5: **OPS-3 — bootstrap payload measurement and first split.**

### BAK-1 — `scripts/backup.sh`

Priority: P0 · Status: `[x]` (2026-11-16)

- [x] `set -euo pipefail`, `umask 077`, a `mkdir`-based lock (no `flock`
      dependency on Git Bash) so overlapping cron runs exit `0` with "already
      running".
- [x] Config: `BACKUP_DIR` (default `./backups`, must be writable; warns when
      it resolves inside the repository), `BACKUP_RETENTION_DAYS` (30),
      `BACKUP_MONTHLY_KEEP` (12), `BACKUP_GPG_RECIPIENT`,
      `BACKUP_PASSPHRASE_FILE`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_PG_DUMP`,
      `BACKUP_PG_RESTORE`, and the existing `POSTGRES_*` / `DATABASE_URL`.
      Retention values are strict: a non-integer or out-of-range value exits
      non-zero naming the variable.
- [x] Preflight: `pg_dump`/`pg_restore` present and major-version compatible
      with the server; directory writable; free space ≥ 2× the last dump;
      `SELECT 1` works. A missing tool is named exactly, without a stack trace.
- [x] `pg_dump -Fc --no-acl --no-owner -f "$tmp"`, `pg_restore --list` (a dump
      that cannot be listed is not a backup), SHA-256 of the final (ciphertext)
      file, encryption to a temp file then atomic rename, and
      `<name>.manifest.json` with `format`, timestamps, database, tool
      versions, byte size, SHA-256, encryption mode, parent-only table counts
      and the GL block.
- [x] `.verified` only when the dump was listed successfully (and decrypted,
      when the key is available). Recipient-only encryption writes `.sealed`
      instead; `setup:pg` then waits for a drill-verified marker.
- [x] Retention: newest 30 daily buckets plus the newest dump of each of the
      12 most recent months; deletes a group only if a newer `.verified` group
      exists and all four/five sidecars are present. Incomplete groups are
      left alone, never guessed at.
- [x] `trap` removes temp files and the lock on every exit; never echoes a
      password; `--dry-run` prints the plan and resolved paths without
      creating the directory or dumping.

Naming: `<database>-<YYYYMMDD>T<HHMMSS>Z.dump` (UTC), e.g.
`inventory_db-20261116T021500Z.dump`. Encrypted data uses `.dump.gpg`.

Row counts (parents only, so partitions are not double-counted):

```sql
SELECT c.relname,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint AS rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND NOT c.relispartition
ORDER BY 1;
```

Acceptance: one run produces the dump, manifest, checksum and `.verified`; the
manifest's table count matches the live catalogue (119 top-level tables at the
audit's measurement — the gate compares manifest to catalogue, never a
hard-coded number); a second run within the lock window exits cleanly without a
second dump; deleting the key file makes an encrypted run fail **before** it
reports success.

**Verified 2026-11-16** — `tests/backupScript.test.ts` (9 tests) invokes the
real `bash scripts/backup.sh` against the configured database in disposable
directories and reads the resulting files with `pg_restore`/Node.

| # | Condition | Observable assertion |
|---|---|---|
| 1 | one real backup | `.dump`, `.manifest.json`, `.sha256`, `.verified`; manifest has 119 tables (equal to the live catalogue), `format='pg_dump-custom'`, GL debit = credit (396,913.00), `net=0.00`; checksum hashes the dump; `pg_restore --list` exits 0 |
| 2 | lock directory present | second run exits **0**, prints `already running`, and writes no files |
| 3 | missing `pg_dump` | exits non-zero naming `definitely-not-a-pg-dump`; no files |
| 4 | missing `BACKUP_PASSPHRASE_FILE` | exits non-zero naming the variable; no dump/checksum/marker survives |
| 5 | invalid retention | exits non-zero naming `BACKUP_RETENTION_DAYS`; no files |
| 6 | passphrase encryption | only `.dump.gpg` remains; `.verified` exists, manifest mode `gpg-passphrase`, manifest SHA-256 hashes the ciphertext, and a decrypt round-trip is readable by `pg_restore` |
| 7 | recipient-only encryption | `.sealed` exists (no `.verified`), manifest mode `gpg-recipient`, and the recipient key can decrypt a readable archive |
| 8 | retention | oldest complete group removed, newest daily and an incomplete group retained (incomplete is never deleted) |

The real run produced **1,188,659 bytes** and a 119-table manifest; `--dry-run`
printed the resolved paths without creating the directory.

Commands: `npx tsx --test tests/backupScript.test.ts` → **9 pass, 0 fail**;
`npx tsx --test tests/envDocs.guard.test.ts` → **5 pass**; full suite tally is
recorded below. `npm run backup` is the supported entry point.

Next slice after BAK-5: **OPS-3 — bootstrap payload measurement and first split.**

### BAK-2 — `scripts/restore.sh`

Priority: P0 · Status: `[x]` (2026-11-16)

- [x] `restore.sh <dump> --target <db> [--yes] [--force] [--list]`; decrypt to a
      `0600` temp file when needed, delete it on every exit path.
- [x] Refuse without `--yes` when the target equals `POSTGRES_DB`; require the
      operator to type the target name when overwriting a live database;
      refuse a non-empty target unless `--force`.
- [x] Never create or drop a database. Take an optional pre-restore safety dump
      (`--safety-dump`) into `BACKUP_DIR` before overwriting.
- [x] `pg_restore --exit-on-error --no-owner --no-privileges --single-transaction`
      unless `pg_restore --list` shows `CREATE INDEX CONCURRENTLY` (not allowed
      inside the transaction), in which case drop `--single-transaction` and
      keep `--exit-on-error`.
- [x] After restore, run the same assertions as the drill (shared SQL file);
      exit non-zero if any fail, and print the target and the elapsed time.
- [x] `--list` prints the archive table of contents and exits without touching a
      database.

Acceptance: `restore.sh <dump> --target inventory_drill_manual --yes` restores
into an empty scratch database and passes the checks; `--target inventory_db`
without `--yes` refuses before connecting; a corrupt archive exits non-zero
without a partial restore (transactional path).

**Verified 2026-11-16** — `tests/restoreScript.test.ts` (7 tests) creates a
real BAK-1 artifact, creates and drops disposable scratch databases, and runs
the real shell script. The measured artifact was **1,212,199 bytes**, the
manifest held **119** parent tables, GL debit = credit = **398,113.00**, net
**0.00**, and a real restore verified in **6–9 s**.

| # | Condition | Observable assertion |
|---|---|---|
| 1 | restore into an empty scratch DB | exit 0; `119/119 tables checked`; restored table count equals the manifest and source; source untouched |
| 2 | `--target inventory_db` without `--yes`, with a dead-port URL | exit 1 with `without --yes`; never reaches the connection error, so the refusal precedes any connection |
| 3 | restore again into the non-empty target | refused without `--force`; `--force` resets `public` and restores/verifies 119 tables (pg_restore `--clean` cannot drop inherited partitioned constraints in order) |
| 4 | artifact truncated by 4 KB | checksum mismatch, exit 1, target still has **0** tables (no partial restore) |
| 5 | `--list` | prints the archive TOC and exits 0 without a target database |
| 6 | `--dry-run` with a nonexistent target | prints the plan and creates nothing |
| 7 | passphrase-encrypted artifact | decrypts to a `0600` temp file, restores 119 tables, verifies GL, and leaves no `.restore.*` temp file |

A manual recipient-only run (ephemeral GPG key, `.dump.gpg` plus `.sealed`)
restored **119/119** tables with GL debit = credit = **398,913.00**, net **0.00**
in **14 s**, and left no scratch database behind.

Commands: `npx tsx --test tests/restoreScript.test.ts` → **7 pass, 0 fail**;
`npx tsx --test tests/backupScript.test.ts` → **9 pass, 0 fail**;
`npx tsc --noEmit` → exit 0. `npm run backup` creates the artifact; the
restore entry point is `bash scripts/restore.sh`.

Next slice after BAK-5: **OPS-3 — bootstrap payload measurement and first split.**

### BAK-3 — `scripts/check_restore_drill.mjs` + `npm run check:restore-drill`

Priority: P0 · Status: `[x]` (2026-11-16)

- [x] Select the newest verified dump (or `--backup <file>`), refusing an
      encrypted dump whose key is unavailable with a message naming the key
      variable.
- [x] Create `inventory_drill_<UTC>` with `CREATE DATABASE … TEMPLATE template0`
      and the source's `datcollate`/`datctype`/encoding (read from
      `pg_database`) so checksums are comparable. Use `DRILL_ADMIN_URL` when
      set; otherwise the normal connection and a clear preflight error:
      `role "inventory_user" cannot create databases` plus the exact
      `ALTER ROLE … CREATEDB;` remediation.
- [x] Restore with `--exit-on-error --no-owner --no-privileges`.
- [x] Compare every manifest table count with the restored count (same query as
      BAK-1). Report the first N mismatches, not just a count.
- [x] GL assertions:
      `sum(debit) = sum(credit)` over `gl_journal_lines`; zero journals with a
      per-journal imbalance; every `POSTED` header with lines balanced; the
      trial-balance checksum and the net (must be `0.00`) equal to the manifest.
- [x] Drop the scratch database in `finally` (and on `SIGINT`/`SIGTERM`) with
      `DROP DATABASE … WITH (FORCE)`; if the drop fails, exit non-zero and print
      the exact command instead of leaving it silently.
- [x] Exit `0` pass, `1` check failure, `2` preflight/setup failure. `--json`
      for CI, `--keep-scratch` for debugging (never in CI).
- [x] Document `DRILL_ADMIN_URL` in `.env.example`; the normal connection is
      used when it is unset.

Ledger SQL (shared with BAK-2 in `scripts/restore_checks.sql`):

```sql
-- 1. company-wide debits equal credits
SELECT COALESCE(sum(debit), 0) AS debit,
       COALESCE(sum(credit), 0) AS credit
FROM gl_journal_lines;

-- 2. journals that do not balance (expect zero rows)
SELECT journal_id, journal_date_ad, sum(debit) - sum(credit) AS delta
FROM gl_journal_lines
GROUP BY journal_id, journal_date_ad
HAVING sum(debit) <> sum(credit);

-- 3. trial-balance checksum: per-account net, deterministic order
WITH balances AS (
  SELECT account_id, sum(debit - credit)::numeric(16, 2) AS balance
  FROM gl_journal_lines
  GROUP BY account_id
)
SELECT md5(string_agg(account_id || ':' || balance::text,
                      '|' ORDER BY account_id COLLATE "C")) AS checksum,
       COALESCE(sum(balance), 0) AS net
FROM balances;
```

Acceptance: against a real backup the drill exits `0` and leaves no
`inventory_drill_*` database; against a copy truncated by 4 KB it exits `1`
(the restore or a count check fails) and still drops the scratch database; with
no manifest it refuses unless `--no-manifest`, in which case it runs the
internal checks and says the comparison was skipped.

**Verified 2026-11-16** — `tests/restoreDrill.test.ts` (6 tests) creates one
real BAK-1 artifact in a disposable directory and runs the real CLI against real
scratch databases. No drill logic is mocked; every assertion reads the CLI's
JSON or the live `pg_database` catalogue. The final measured run used a
**1,255,488-byte** BAK-1 artifact, restored **119/119** parent tables, produced
GL debit = credit = **400,113.00**, net **0.00**, checksum
`38f2504abe5ed45d152ea74cc6c597c1`, and completed in **22.5 s** (the same drill
ran in 7–10 s on the earlier empty-cache runs). No per-journal or POSTED-header
imbalance remained.

| # | Condition | Observable assertion |
|---|---|---|
| 1 | real backup via `--backup` | exit 0, `status='pass'`, comparison **matched**, restored table count equals the manifest's **119**, debit = credit, net 0.00, zero imbalances, and `inventory_drill_*` is gone |
| 2 | no `--backup` | the newest `.verified` artifact in `BACKUP_DIR` is selected; exit 0 and no scratch database remains |
| 3 | copy truncated by 4 KB | checksum failure exits **1** as a check failure; the scratch database is dropped (and none was created) |
| 4 | no manifest | without `--no-manifest` exit **2** and tells the operator to pass it; with it, exit 0, `tableComparison='skipped'`, internal GL checks still run, and the scratch is dropped |
| 5 | encrypted artifact, key unset | exit **2** naming `BACKUP_PASSPHRASE_FILE` / `BACKUP_ENCRYPTION_KEY`; no scratch database is created |
| 6 | `--keep-scratch` | exit 0 and the scratch exists for inspection; the test explicitly drops it and observes it disappear, so no debug database is left behind |

The uppercase `T`/`Z` in `inventory_drill_<UTC>` is quoted on both CREATE and
DROP; an unquoted identifier would fold to lowercase and silently miss.

Commands: `npx tsx --test tests/restoreDrill.test.ts` → **6 pass, 0 fail**;
`npx tsx --test tests/restoreScript.test.ts` → **7 pass, 0 fail**;
`npx tsc --noEmit` → exit 0; full `npm test` → **2,466 tests, 2,464 pass,
2 Windows-only skips, 0 fail**, docs-count gate matched 2,466. Entry points:
`npm run check:restore-drill` or `node scripts/check_restore_drill.mjs`.

Next slice after BAK-5: **OPS-3 — bootstrap payload measurement and first split.**

### BAK-4 — `setup:pg` destructive guard

Priority: P0 · Status: `[x]` (2026-11-16)

- [x] Move the guard to the top of `scripts/setup_db.js`, **before**
      `tryConnect()` and before the shell installer, so a refusal never opens a
      connection.
- [x] Extract `evaluateDestructiveGuard({ argv, backupDir, now, env })` and only
      call `runSetup()` when the module is executed directly, so
      `tests/setupGuard.test.ts` can exercise every branch without a database.
- [x] Branches: `--keep-data` → allowed, logs that no wipe happens;
      no `--force` → refuse; `--force` + no verified backup younger than
      `BACKUP_VERIFY_MAX_AGE_HOURS` (24) → refuse;
      `--force --skip-backup-check` → allow with a warning that names the
      residual risk (still requires `--force`).
- [x] Refusal text names the newest dump it found (or "none"), its age, the
      directory, and the exact three commands to run. Exit `1`.
- [x] Re-run the freshness check against the `.verified` marker's timestamp and
      confirm the referenced dump still exists with the recorded SHA-256.
- [x] Keep CI, the shell installer and the UI setup guidance on the new
      `--force`/`--skip-backup-check` contract.

Acceptance: `npm run setup:pg` → exit `1`, no "Connected to PostgreSQL" line,
warning names `BACKUP_DIR` and `bash scripts/backup.sh`; `--force` alone →
exit `1`; `--force` with a fresh verified marker → proceeds; a stale marker
(25 h) → refuses; `--keep-data` → proceeds without a backup.

**Verified 2026-11-16** — `tests/setupGuard.test.ts` (12 tests) imports the
extracted decision function for every branch and runs the real setup CLI and
`npm run setup:pg`; the final case creates a real BAK-1 backup and asks the
guard about its real marker, checksum and timestamp.

| # | Condition | Observable assertion |
|---|---|---|
| 1 | no `--force` | exits **1** before any connection, no `Connected to PostgreSQL`, names `BACKUP_DIR`, the newest dump and the three recovery commands |
| 2 | `--force` with no verified marker | refuses and names the newest unverified dump and its age |
| 3 | `--force` with a fresh verified marker | allowed; records the dump path and about 2 h age |
| 4 | marker 25 h old | refuses as stale; reports **25.0 h** against the **24 h** limit |
| 5 | dump tampered / dump missing | refuses on the recorded **SHA-256** mismatch or missing artifact |
| 6 | `--keep-data` | allowed without a backup and says the wipe is skipped |
| 7 | `--force --skip-backup-check` | allowed with the residual-risk warning; `--force` remains mandatory |
| 8 | `BACKUP_VERIFY_MAX_AGE_HOURS` | a 1 h limit refuses a 2 h backup; a non-numeric value is rejected by name |
| 9 | real BAK-1 artifact | the guard accepts its actual `.verified` timestamp and SHA-256 |
| 10 | real CLI / npm entry point | both refuse before connecting and write no setup output |

Commands: `npx tsx --test tests/setupGuard.test.ts` → **12 pass, 0 fail**;
`npx tsx --test tests/databaseSetupBanner.test.ts` → **3 pass, 0 fail**;
`npx tsx --test tests/envDocs.guard.test.ts` → **5 pass, 0 fail**;
`npx tsc --noEmit` → exit 0; full `npm test` → **2,478 tests, 2,476 pass,
2 Windows-only skips, 0 fail**, docs-count gate 2,478. The CI seed and shell
installer now pass `--force --skip-backup-check` only for disposable databases;
normal setup guidance requires a verified backup first.

Next slice after BAK-5: **OPS-3 — bootstrap payload measurement and first split.**

### BAK-5 — Disaster-recovery runbook

Priority: P0 · Status: `[x]` (2026-11-16)

- [x] `docs/disaster-recovery-runbook.md` covering: assets and blast radius;
      **RPO ≤ 15 min only once WAL archiving is live** (a dump-only install has
      RPO = 24 h — say this explicitly rather than claiming the target);
      **RTO ≤ 2 h**, with the measured drill time recorded as evidence.
- [x] Roles and escalation: who declares an incident, who holds the encryption
      key, who authorizes a restore over production.
- [x] Scheduling: cron (`17 2 * * *`, `flock -n`, log to
      `/var/log/isp-backup.log`) and the equivalent systemd timer
      (`OnCalendar=*-*-* 02:17`, `Persistent=true`, `RandomizedDelaySec=10m`),
      plus a weekly drill timer.
- [x] WAL archiving: pgBackRest stanza (`archive_mode=on`, `wal_level=replica`,
      `archive_command`, `repo1-retention-full`, `repo1-cipher-type`) **or**
      WAL-G (`WALG_S3_PREFIX`, `wal-push`/`wal-fetch`, retention), and the
      `pg_stat_archiver` alert.
- [x] Restore procedures: full logical restore from a dump, restore into a
      scratch database, and PITR (`restore_command` + `recovery_target_time`).
      Preserve the failed cluster by renaming `PGDATA`; never restore over it.
- [x] Verification after any restore: `npm run check:restore-drill` against the
      restored copy is not enough — run the trial-balance read, `npm run
      integrity:check`, and `npm run smoke` against the app, then record the
      timings.
- [x] Monitoring: backup age > 26 h, drill failure, `failed_count` in
      `pg_stat_archiver`, disk > 80%, and a monthly restore rehearsal log
      template.
- [x] Replace the ad-hoc commands in `README.md:531` and
      `UPDATEPROCESS.md:92-125` with a pointer to the runbook (the update
      process keeps its pre-update dump step, now phrased as
      `bash scripts/backup.sh`).

Acceptance: an operator who has never run a restore can follow the document
end-to-end on a scratch host; every command is copy-pasteable; the document
states which parts are not yet provisioned on this deployment.

**Verified 2026-11-16** — `tests/disasterRecoveryRunbook.test.ts` (8 tests) pins
the runbook's RPO/RTO claims, roles, schedules, both WAL options, restore/PITR
procedures, post-restore checks, monitoring thresholds, rehearsal template and
the README/UPDATEPROCESS replacement links. The runbook records the measured
BAK-3 drill: **22.5 s**, **1,255,488-byte** artifact, **119/119** parent tables,
GL debit = credit = **400,113.00**, net **0.00**, checksum
`38f2504abe5ed45d152ea74cc6c597c1`.

| # | Condition | Observable assertion |
|---|---|---|
| 1 | assets and recovery targets | documents inventory, blast radius, dump-only **RPO = 24 h**, **RPO ≤ 15 min only once WAL archiving is live**, **RTO ≤ 2 h**, and the **22.5 s** measured drill |
| 2 | roles and escalation | names IC, Database Operator, Data Owner, Key Custodian and Restore Approver; declaration and two-person production-restore approval are explicit; key is off the database host |
| 3 | schedules | exact `17 2 * * *`, `flock -n`, `/var/log/isp-backup.log`, `OnCalendar=*-*-* 02:17`, `Persistent=true`, `RandomizedDelaySec=10m`, and weekly `isp-drill.timer` |
| 4 | WAL/PITR configuration | both pgBackRest (`archive_mode`, `wal_level`, `repo1-retention-full`, `repo1-cipher-type`) and WAL-G (`WALG_S3_PREFIX`, `wal-push`, `wal-fetch`) plus the `pg_stat_archiver`/`failed_count` alert |
| 5 | restore procedures | full dump restore, scratch restore, PITR with `restore_command`/`recovery_target_time`, `PGDATA` preservation and the rule never to restore over the failed cluster |
| 6 | post-restore verification | `scripts/restore_checks.sql`, `npm run integrity:check` and `npm run smoke` are required; trial-balance/Data Owner sign-off is explicit |
| 7 | monitoring and rehearsal | >26 h backup age, drill exit failure, `failed_count`, >80% disk and the monthly rehearsal log template |
| 8 | docs wiring and honesty | README and docs index link the runbook; UPDATEPROCESS uses `bash scripts/backup.sh` and the guarded restore, with no ad-hoc `pg_dump`/SQL restore; the not-provisioned table is explicit |

Commands: `npx tsx --test tests/disasterRecoveryRunbook.test.ts` → **8 pass,
0 fail**; `npx tsc --noEmit` → exit 0; full `npm test` → **2,486 tests, 2,484
pass, 2 Windows-only skips, 0 fail**, docs-count gate 2,486. The runbook states
plainly that off-host storage, scheduling, encryption keys, WAL archiving,
alert delivery and a production key store are **not provisioned** on this
deployment.

Next slice: **SCALE-1 — shared state and horizontal workers** (Round 13), followed by SCALE-2's < 15 KB end state.

### OPS-3 — Bootstrap payload measurement and first split

Priority: P0 (first tranche of SCALE-2) · Status: `[x]` (2026-11-16)

- [x] `scripts/measure_bootstrap_payload.mjs`: sign in, GET the payload, print
      total bytes and gzip bytes plus a per-key table, and flag keys over 10% of
      the gzip total.
- [x] Record the table in this note. Candidate rare keys, only if measured:
      `damageRecords`, `approvalRequests`, `purchaseReturns`, `salesReturns`
      (each already has a register/slice path). Do **not** move `stock`,
      `products`, `branches`, `financialSummary`, `permissionsMatrix`, settings
      or preferences — they are first-paint state.
- [x] For each moved key: ensure the consumer hydrates through the existing
      `GET /api/bootstrap/local?key=…` path, keep the key in `BOOTSTRAP_TABLES`,
      and make the full-bootstrap apply stop resetting it to `[]` (the real
      hydration risk). Update `tests/bootstrapTrim.test.ts`,
      `tests/registerRefreshDomains.test.ts`, `scripts/smoke_test.mjs` and the
      README endpoint table.
- [x] If a key cannot move without a new endpoint, leave it for SCALE-2 and
      record the reason; this tranche still ships the measurement, the ETag and
      at least one register that already has a paged path.

Acceptance: the measurement table is recorded here; at least one register with
an existing paged path leaves the payload and its screens still hydrate after a
cold load and a targeted refresh; full bootstrap gzip drops by ≥ 15% (the
< 15 KB end state is SCALE-2's acceptance, not this slice's).

**Measured 2026-11-16** against the running server and seeded PostgreSQL, using
`npm run measure:bootstrap` (the script default login is the demo super admin):

| Key | Before gzip | Share | After gzip | Share | Decision |
|---|---:|---:|---:|---:|---|
| **Total** | **157,569 B** | 100% | **6,198 B** | 100% | **−96.1%** |
| `auditLogs` | 150,915 B | 95.8% | 0 | — | **moved** to deferred slice (200-row cap kept in `BOOTSTRAP_TABLES`) |
| `products` | 1,054 B | 0.7% | 1,054 B | 17.0% | first paint — do not move |
| `permissionsMatrix` | 984 B | 0.6% | 984 B | 15.9% | first paint — do not move |
| `approvalRequests` | 880 B | 0.6% | 880 B | 14.2% | left for SCALE-2; no paged endpoint today |
| `stock` | 622 B | 0.4% | 622 B | 10.0% | first paint — do not move |
| `damageRecords` | 583 B | 0.4% | 583 B | 9.4% | left for SCALE-2; below the measured split threshold |
| `suppliers` | 490 B | 0.3% | 490 B | 7.9% | first paint — do not move |
| `users` | 488 B | 0.3% | 488 B | 7.9% | identity — do not move |
| `salesReturns` | 351 B | 0.2% | 0 | — | **moved** to deferred slice; register already pages |
| `purchaseReturns` | 342 B | 0.2% | 0 | — | **moved** to deferred slice; register already pages |
| `companyProfile` | 348 B | 0.2% | 348 B | 5.6% | first paint — do not move |
| `locations` | 340 B | 0.2% | 340 B | 5.5% | first paint — do not move |
| `branches` | 313 B | 0.2% | 313 B | 5.1% | first paint — do not move |
| `categories` | 272 B | 0.2% | 272 B | 4.4% | first paint — do not move |
| `productGroups` | 260 B | 0.2% | 260 B | 4.2% | first paint — do not move |
| `fiscalYears` | 234 B | 0.1% | 234 B | 3.8% | first paint — do not move |
| `uom` | 212 B | 0.1% | 212 B | 3.4% | first paint — do not move |
| `userPreferences` | 175 B | 0.1% | 175 B | 2.8% | first paint — do not move |
| `financialSummary` | 165 B | 0.1% | 165 B | 2.7% | first paint — do not move |
| `postgresDatabaseStatus` | 144 B | 0.1% | 144 B | 2.3% | first paint — do not move |
| `serverTime` | 46 B | 0.0% | 46 B | 0.7% | first paint — do not move |
| `dataVersion` | 33 B | 0.0% | 33 B | 0.5% | ETag contract — do not move |
| `appSettings` | 22 B | 0.0% | 22 B | 0.4% | first paint — do not move |

Raw total: **1,262,992 B → 59,977 B**. `auditLogs` is the measured dominant
key, so it moved with the two paged return registers even though it was not in
the candidate shorthand; leaving it would make the ≥15% acceptance impossible
on this data. The remaining candidate keys (`damageRecords`, `approvalRequests`)
are below the point of a split here or have no paged endpoint, so they stay for
SCALE-2 with the reason in the table.

**Verified 2026-11-16** — `scripts/measure_bootstrap_payload.mjs` (real login
and HTTP), exported `measurePayload` arithmetic guard 3/3, bootstrap trim 7/7,
SSE/register guard 48/48. `GET /api/bootstrap` omits `auditLogs`,
`purchaseReturns` and `salesReturns`; each is still served live by
`GET /api/bootstrap/local?key=…`, all three remain in `BOOTSTRAP_TABLES`, and
`applyBootstrapData` only assigns a deferred key when the slice is present
(no `data.key || []` reset). The Returns Register self-fetches
`/api/purchase-returns` / `/api/sales-returns`; its `returns` prop is hydrated by
the deferred slice for the returnable-quantity calculation. The Activities Log
gets its 200-row deferred slice. Smoke and the README endpoint table were
updated. Full gate: `npx tsc --noEmit` exit 0; `npm test` **2,493 tests,
2,491 pass, 2 Windows-only skips, 0 fail**; docs gate 2,493.

## Order of work

1. **OPS-5 — done 2026-11-16** (baseline and verification above).
2. **OPS-1 — done 2026-11-16** (verification above): the flag no longer flips
   on a timeout, and the breaker owns every request-path transition.
3. **OPS-2 — done 2026-11-16** (verification above): ETag/304 is wired into the
   real bootstrap path with `stateVersion` and the client cache.
4. **OPS-4 — done 2026-11-16** (verification above): statement timeout and
   breaker knobs are strict boot configuration, and the timeout is a pg
   startup parameter on both pools.
5. **BAK-1, BAK-2, BAK-3 and BAK-4 — done 2026-11-16** (verification above):
   verified dump, manifest, checksum, encryption and retention; a guarded
   restore that proves table counts and GL totals; a disposable restore drill
   that always drops its scratch database; and a `setup:pg` guard that refuses
   without `--force` plus a fresh, hash-verified backup.
6. **BAK-5 — done 2026-11-16** (verification above): the operator runbook now
   carries the numbers the drill actually produced and states the unprovisioned
   gaps honestly.
7. **OPS-3 — done 2026-11-16** (verification above): measured the live payload,
   moved the two paged return registers and the dominant audit slice, and cut
   gzip from 157,569 B to 6,198 B (−96.1%). The < 15 KB end state remains
   **SCALE-2** (Round 13).

BAK-1…5 are independent of Round 11. OPS-1/OPS-2 touch `server/db.ts`,
`bootstrap.controller.ts` and the client bootstrap path, so land them in a quiet
window and run the full suite at the end.

## Gates

- `npx tsc --noEmit`
- `node scripts/run_tests.mjs` (full suite at close)
- focused: `tests/dbAvailability.test.ts`, `tests/bootstrapEtag.api.test.ts`,
  `tests/setupGuard.test.ts`, `tests/envWiring.test.ts`,
  `tests/envDocs.guard.test.ts`, `tests/bootstrapTrim.test.ts`
- `npm run check:no-inline-sql`
- `npm run check:no-raw-dialogs` and `npm run build` when client code changed
- `npm run check:bundle-budget` when client code changed
- `npm run check:restore-drill`
- `npm run perf:bootstrap -- --assert` with the server log grep (below)

## Verification (the mission's list, made executable)

```bash
# 1. The wipe refuses without flags, before connecting.
npm run setup:pg; echo "exit=$?"          # exit=1, warning names BACKUP_DIR
                                          # and prints the backup command

# 2. A real backup, then a restore that asserts the ledger.
BACKUP_DIR=/var/backups/isp bash scripts/backup.sh
ls -l /var/backups/isp | tail            # .dump .manifest.json .sha256 .verified
npm run check:restore-drill; echo "exit=$?"   # exit=0, scratch DB dropped

# 3. No TypeScript regressions.
npx tsc --noEmit

# 4. The concurrency fix, measured rather than asserted.
npm run perf:bootstrap -- --concurrency 50 --requests 120 --assert
grep -c "PostgreSQL is not connected" .tmp-server.log   # must be 0
```

The drill must also be proven to fail: copy the newest dump, truncate it by
4 KB, run `node scripts/check_restore_drill.mjs --backup <copy>`, confirm exit
`1` and no leftover `inventory_drill_*` database. A drill that cannot fail is
not evidence.

## Risks and open questions

- **`inventory_user` probably cannot `CREATEDB`.** The drill needs either that
  grant or a separate `DRILL_ADMIN_URL`. Decide before BAK-3; the runbook must
  say which it is.
- **`pg_dump`/`pg_restore` availability on the Windows dev box.** Git Bash
  ships neither. BAK-1's preflight must name the PostgreSQL `bin` directory and
  the drill is allowed to skip with a clear message locally, but CI/production
  must run it.
- **Partition-aware counts.** Count parents only (`NOT relispartition`); a
  count of `information_schema.tables` would include all 29 partitions and
  never match.
- **ETag staleness.** `stateVersion` is process-local and only bumped by an
  in-process write; a direct SQL edit or a second instance is not covered. That
  matches the documented single-instance constraint, but it must be in the code
  comment. Round 13 SCALE-1 must move `stateVersion` (and `user.ver`) to Redis
  before `instances: 'max'`; until then the 304 path is single-worker only.
- **`user.ver` and permission overrides.** The B1 fingerprint covers role,
  branch scope, switch permission, status and password, not per-user overrides.
  Every override write bumps `stateVersion`, so the API path is safe; confirm
  there is no override write that bypasses the bump.
- **Compression + ETag.** Express's `compression` middleware and a 304 can
  interact badly if the header is set after the body. Set `ETag` and
  `Cache-Control` first, and test a request with `Accept-Encoding: gzip`.
- **Backup target is not verifiably off-host.** The script can only warn. The
  runbook must require a mount check, and monitoring must alert if
  `BACKUP_DIR` falls back to the root filesystem.
- **Encryption without a decryptable key.** Recipient-only encryption is safer
  on the host but cannot be self-verified; `setup:pg` must then refuse until a
  drill has verified it. Do not weaken the guard to avoid that.
- **`Retry-After` semantics.** A saturated pool is a retry-after-seconds
  condition, not a "database down" one. Keep the two codes (`DB_BUSY` vs
  `DB_UNAVAILABLE`) distinct so the UI can say "busy, retrying" instead of
  "database offline".
- **Statement timeout vs reports.** 30 s is an OLTP default; a long report on
  the primary will now be cancelled. Either route reports to
  `REPORT_DATABASE_URL` (already supported) or raise the timeout per
  environment; document the choice rather than silently setting `0`.

## Deferred register (owned elsewhere)

| Audit item | Where it went |
|---|---|
| H2 default password / reset policy / logout | A later credential-policy round; touches admin/auth controllers and the token model |
| H3 TLS, at-rest encryption | Round 13 PUB-1/PUB-2 (edge TLS, HSTS, headers) and PUB-4 (private network, storage); this round's backup encryption is not a substitute |
| H4 write-path cache amplification | Round 13 SCALE-4 (Redis cache + async invalidation); this round only measures the write path |
| H5 error-detail leaks (71 sites, `/api/db/status`) | Round 13 PUB-3 for the public surface, plus the 71-site sweep; this round's 503 bodies stop at the driver-text boundary |
| H6 121 unindexed FK columns | Round 13 SCALE-3 (BRIN/composite indexes + partition conversion), after `EXPLAIN` evidence |
| M1 README table counts | Docs-count guard extension |
| M2 BS-calendar unlinked days | `audit:bs-dates --apply` plus seeder fix |
| M3–M12, L1–L5 | Round 13 covers M4/M5/M8 and L1–L3; the rest remain in audit §4 |

## Definition of done

- [ ] Every BAK/OPS slice above is `[x]` with its acceptance checked by a
      command, not by inspection.
- [ ] `npm run setup:pg` refuses without `--force` and a fresh verified backup,
      and the refusal happens before a connection.
- [ ] `scripts/backup.sh` → `npm run check:restore-drill` exits `0`; a corrupted
      copy exits non-zero and drops the scratch database.
- [ ] The 50-concurrent probe shows zero `503`s from a global flag, zero
      `PostgreSQL is not connected` lines, and sub-second `304`s on the second
      wave; the before/after numbers are recorded here.
- [ ] `npx tsc --noEmit` and the full suite pass; the new tests fail if the
      breaker, the ETag decision or the setup guard is reverted.
- [ ] `docs/disaster-recovery-runbook.md` exists, states RPO/RTO honestly, and
      the ad-hoc commands in README/UPDATEPROCESS point at it.
- [ ] The commit hashes are recorded in this note.
