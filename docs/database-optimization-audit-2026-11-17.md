# Database optimisation audit — 2026-11-17

Audit of the database layer: what is already optimised, what is not, and a
verdict on each of the five optimisations an outside reviewer suggested. Two are
applied (partition pre-creation, high-churn maintenance), two are declined with
the measurement that declines them, and one is a deployment decision that is the
operator's. Every verdict in §1 was re-verified against the tree and the live
database on 2026-11-17; a claim that needs a production-scale number is marked
unmeasured rather than asserted.

**Scope of evidence.** `scripts/schema.sql` (the single baseline schema), the
boot/migration runner, the repository SQL, and the live development database
(PostgreSQL 18.6, 29 monthly children + 1 `DEFAULT` per ledger parent, `DEFAULT`
empty).

---

## 1. Verdict on the five supplied suggestions

One verdict per suggestion, in the requested vocabulary, each with the file/line,
catalog fact or plan that proves the current state. Commands and their actual
output are repeated in §1.1 so the claim can be re-run, not taken on trust.

| # | Suggestion | Verdict | Evidence (verified live this turn) | Decline reason / decision only you can make |
|---|---|---|---|---|
| 1 | Shared operational caches + write-invalidation (SCALE-4) | **DECLINED** | No post-write cache reload exists to move: `middleware/stateVersion.ts:4` — "The old `cacheRefreshHook` is gone"; the only hydration is boot-time (`state/runtimeState.ts:166`, `hydrateOperationalData`, 11 reference tables). The one genuinely worker-local piece — the bootstrap payload version — is **applied**: `state/bootstrapVersion.ts` (`isp:state:version`, INCR on write, GET before the ETag). | The premise ("N workers re-run full-table cache reloads on every mutating request") is false in this tree, so a Redis cache bus would add a second invalidation mechanism plus Redis latency on every write, to prevent nothing. **Residual named, not fixed:** a master-data edit updates only the editing worker's binding (`admin.controller.ts:188,252,329,1060`; `masterdata.controller.ts:487`), so a second worker serves the old `branches`/`products` until restart — that is a staleness decision (shared reads vs. pub/sub invalidation), not this suggestion. |
| 2 | PgBouncer (transaction mode) + read-replica routing | **NEEDS-USER-DECISION** | `PG_POOL_MAX` defaults to 40 (`server/db.ts:102`) × `instances: 'max'` (`ecosystem.config.js:12`) → up to 320 sessions; live `max_connections = 100`. No PgBouncer configuration anywhere in the tree. The replica seam exists but serves exactly one query (`controllers/reports.controller.ts:94`). `statement_timeout` is a libpq startup parameter (`server/db.ts:108`). | Only you can decide whether this deployment gets PgBouncer and/or a replica — both are infrastructure, not a code change. Prerequisites are named: `statement_timeout` moves to `ALTER ROLE … SET` before transaction pooling, and the statement/aging reads move onto `reportingPool` before a replica is worth standing up. |
| 3 | Pre-create journal partitions + archive closed years | **APPLIED** (pre-creation applied; archiving open) | `server/src/boot/journalPartitions.ts`, called from `boot/dbBoot.ts`; `npm run check:partitions` (`scripts/check_partitions.ts`) imports the same module. Live: 29 monthly children + 1 `DEFAULT` per parent (`pg_inherits`), `DEFAULT` = `0 journal / 0 line` rows, CLI exit 0. A month whose attach PostgreSQL refuses is recorded in `failed[]` and the loop continues. | Archiving is **not** implemented and is a retention decision only you can make: the ledger is still the audit trail even though `fiscal_year_balances` holds the closed-year snapshot, and in this schema a detach needs the matching `gl_journal_lines` child handled first (inherited FK). Reopen when a year passes the 84-month retention window and detach+archive has been rehearsed on a restored copy. |
| 4 | High-churn maintenance: BRIN + autovacuum/fillfactor | **APPLIED** | BRIN: `idx_audit_timestamp_brin` on `audit_logs(timestamp_ad)` and `idx_txn_timestamp_brin` on `transaction_logs(timestamp_ad)`, `amname = brin`, 24 kB each (migration `0031_log_timestamp_brin`, recorded in `schema_migrations`). Reloptions live on both tables: `fillfactor=80, autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.05` on `inventory_stock` and `document_sequence_daily` (`0030_hot_table_storage`). The timestamp B-trees stay: measured, ~25× slower pages without them (§4). | Nothing declined. Recorded limits instead: the planner does not choose the BRIN at 4.8 MB, `pages_per_range` stays at the default 128, and on `inventory_stock` the dominant `quantity_on_hand` update cannot be HOT because `idx_stock_reorder` covers that column. |
| 5 | Trim `search_text`, tune GIN (`fastupdate`, pending list) | **DECLINED** | Live: 13 GIN indexes, 7,152 kB total, largest `idx_customer_devices_global_trgm` at 6,152 kB; six document tables carry a generated `search_text` (`information_schema.columns`, `is_generated = ALWAYS`) indexed as `search_text gin_trgm_ops`; **no** GIN index has any `reloptions`, i.e. `fastupdate` is already PostgreSQL's default `on` and the pending list its default 4 MB. (The note counts six + four; the live split is six `search_text` + seven expression indexes.) | The suggestion is conditional on write latency rising, and nothing measures that here. `fastupdate` is already on, so there is nothing to set; field extraction is a query-shape change across six tables, not a knob, and would need its own before/after. Monitoring trigger recorded in §5. |

The attached note's `referenceCacheBus` with a per-route invalidation matrix is
therefore not this tree's change: there is no full-table reload on the write path
to remove, and the only version state the payload depends on is already shared.

### 1.1 How each verdict was verified (run this turn)

```
max_connections / server_version                     -> 100 | 18.6
pg_inherits, gl_journals + gl_journal_lines          -> 29 months + 1 DEFAULT each
count(*) gl_journals_default / gl_journal_lines_default -> 0 / 0
pg_am = brin                                         -> idx_audit_timestamp_brin (audit_logs),
                                                        idx_txn_timestamp_brin (transaction_logs)
pg_class.reloptions, hot tables                      -> fillfactor=80, autovacuum_vacuum_scale_factor=0.02,
                                                        autovacuum_analyze_scale_factor=0.05 (both tables)
pg_am = gin                                          -> 13 indexes, 7,152 kB total, 0 with reloptions
information_schema.columns, search_text              -> 6 rows, is_generated = ALWAYS
npm run check:partitions                             -> present 202610..202702, missing none, DEFAULT 0/0, exit 0
grep cacheRefreshHook middleware/stateVersion.ts     -> line 4: "The old cacheRefreshHook is gone"
grep PG_POOL_MAX server/db.ts                        -> line 102: max: intFromEnv('PG_POOL_MAX', 40, ...)
grep instances ecosystem.config.js                   -> line 12: instances: 'max'
```


---

## 2. Where the database layer stands

### Already optimised (do not re-litigate)

- **Range partitioning of both ledger parents.** `gl_journals` and
  `gl_journal_lines` are `PARTITION BY RANGE (journal_date_ad)`, the primary key
  is `(id, journal_date_ad)`, the line→header FK is composite on the same key,
  and external tables keep their FKs through `gl_journals_registry` /
  `gl_journal_line_registry`. Monthly children carry their own indexes (created
  through the parent, so the definition cannot drift).
- **Branch predicates are now enforced for writes.** `npm run
  check:branch-predicates` (`scripts/check_branch_predicates.ts`, 2026-11-18)
  scans every SQL literal under `server/src` and fails CI when a mutation
  (`INSERT`/`UPDATE`/`DELETE`) against a branch-scoped partitioned table names
  neither `branch_id` nor a single-row key (`id`, the domain's natural key, or
  the originating `source_id`). Scope comes from `scripts/schema.sql` — any
  `PARTITION BY RANGE` table with a `branch_id` — so 8 tables are covered today
  and a new one is covered on the day it is added. Three statements in the tree
  are genuinely branch-agnostic: two boot-repair staging `INSERT`s carry a
  recorded exemption with the reason, a third is `source_id`-scoped. Nine tests
  pin both directions; `SELECT`s are deliberately out of scope (the repository
  layer scopes reads through the session, and this is a review checklist, not a
  runtime substitute).
- **Scope guards instead of scans.** Every large read names a branch, a bounded
  date range or one customer; an unscoped read is `400 SCOPE_REQUIRED`
  (SCALE-2). This is the single biggest reason the billion-row tables are
  survivable: a national table is never read by accident.
- **Keyset pagination** on customers, sales invoices, stock operations, serial
  log, journals, subledger entries, audit logs, both returns registers, fixed
  assets, warranty coverage, shipments, purchase orders and purchase invoices —
  signed, table-bound cursors, no `OFFSET` on a live register.
- **Indexes follow access paths** for the searches that were measured: six
  stored `search_text` projections with trigram GIN (B2 replaced eight
  `items::text LIKE` scans; 265 ms → 15 ms at 120k rows).
- **Aggregates in SQL, not Node.** The financial summary no longer pulls line
  JSON (SUM-1: 824 ms → 357 ms, 27 MiB less payload per refresh), and closed
  years read the immutable `fiscal_year_balances` snapshot instead of rescanning
  the ledger.
- **Availability hardening:** circuit breaker with typed 503s, per-request
  `statement_timeout` (OPS-4), single-flight availability probe, deadlock and
  serialization replay in `withTransaction`, and an ETag that answers a
  conditional bootstrap with no query at all.
- **A read/write split seam already exists** (`REPORT_DATABASE_URL`,
  `reportingPool`), so moving a report to a replica is a one-line change, not a
  refactor.

### The gaps this audit confirmed

1. **Provisioned partitioning was missing** — the worklist invariant "partitioning
   is provisioned, not just declared" was unmet: `ensure_journal_month_partition()`
   ran inside the posting transaction for the month being posted, so a new month
   cost DDL under an `ACCESS EXCLUSIVE` lock in a user's request, and a fresh
   install had no monthly child at all.
2. **No storage tuning on the two hottest tables.** Both are rewritten once per
   document; both ran at fillfactor 100 with the 0.20 vacuum scale factor. (The
   fillfactor half only pays off where the updated column is unindexed — see §3.)
3. **The payload version was process-local** while the deployment is clustered —
   a correctness gap, not only a performance one.
4. **No retention/archival path** for closed years, and no monitoring of the
   `DEFAULT` partitions, which is where a pruning mistake hides.

---

## 3. What was implemented

| Change | Where | Why |
|---|---|---|
| Partition provisioning (current month + 1 behind + 3 ahead, idempotent) | `server/src/boot/journalPartitions.ts`, called from `boot/dbBoot.ts`, wrapped in the existing boot leader election | Every month is created before it is needed; a posting never runs DDL; `DEFAULT` stays empty and is logged when it is not. A month whose attach PostgreSQL refuses (a dirty `DEFAULT` already holds rows in that range) is recorded in `failed[]` with PostgreSQL's own message and the loop continues, so one poisoned month cannot cost the rest of the window. |
| `npm run check:partitions [-- --apply --from YYYY-MM-DD --months-ahead N]` | `scripts/check_partitions.ts` | The worklist's verification command. Read-only by default, exits `1` on a gap or a non-empty `DEFAULT`, and imports the SAME module the boot uses so there is no second copy of the DDL. |
| `fillfactor = 80`, `autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_analyze_scale_factor = 0.05` on `inventory_stock` and `document_sequence_daily` | `scripts/schema.sql` (fresh installs) + `scripts/migrations/0030_hot_table_storage.sql` (existing installs) | Reclaims dead tuples long before the heap and its three indexes bloat (the lever that unambiguously fits tables this size). `fillfactor` is fully effective on `document_sequence_daily`, whose counter is unindexed; on `inventory_stock` the dominant movement UPDATE sets `quantity_on_hand`, which `idx_stock_reorder` covers, so that update cannot be HOT at any fillfactor — there the padding only avoids heap page splits and covers the non-indexed columns. No rewrite: storage parameters apply to new writes. |
| Shared bootstrap payload version (`isp:state:version`, `INCR` on write, `GET` before the validator, local fallback on store failure) | `server/src/state/bootstrapVersion.ts`, `middleware/stateVersion.ts`, `controllers/bootstrap.controller.ts` | A write handled by worker A now invalidates the ETag on worker B. Fail-open: a Redis outage can serve a stale `304` for a moment (the pre-change behaviour) but never fails a request. |

Evidence:

```
$ npm run check:partitions
Journal partitions — window 202610 .. 202702
  present : 202610, 202611, 202612, 202701, 202702
  missing : (none)
  DEFAULT : 0 journal / 0 line row(s)
```

`tests/journalPartitions.test.ts` proves the window is contiguous, that
provisioning fills exactly the months the status reported missing, that a second
run is a no-op, and that each child's bound covers exactly its own month (so a
row cannot fall through to `DEFAULT`). `tests/sharedState.test.ts` proves a
write on one worker moves the validator another worker computes, that a
single-worker install still invalidates its own ETag, and that a dead store
falls back instead of failing the write. `tests/bootstrapEtag.test.ts` still
passes unchanged (the weak-validator format and the "304 costs no query"
contract are preserved).

---

## 4. Recorded decisions (with the trigger that reopens each)

> **Update 2026-11-18 — the range-read case was measured and applied.** The
> assessment below stands for what it measured (a one-day read that prunes to a
> single month child: the B-tree wins, and that is still true). A six-month range
> read across the append-only tables is a different plan: on the `_scale` fixture
> the planner chooses BRIN on `stock_operations.date_ad` and
> `sales_invoices.created_at`, at 1.8 MB against a 179 MB / 146 MB heap
> (migration `0040_page_read_indexes`). The same measurement found the page-read
> defect worth more than either index: `ORDER BY created_at DESC, id DESC` could
> not be served in index order by `(branch_id, created_at DESC)`, so sales pages
> took 124 ms and stock pages 159 ms against 3.7 / 3.4 ms after adding the `id`
> tie-breaker. Reproduce with `SCALE_FIXTURE_DATABASE_URL=…/inventory_scale node
> scripts/measure_page_read_indexes.mjs`; guarded by
> `tests/pageReadIndexes.test.ts`.

### BRIN on `audit_logs` / `transaction_logs` — APPLIED 2026-11-17, B-Tree kept on measurement

Applied by migration `0031_log_timestamp_brin` (and in `schema.sql` for fresh
installs), `IF NOT EXISTS`, `pages_per_range` left at PostgreSQL's default 128:

```sql
CREATE INDEX IF NOT EXISTS idx_audit_timestamp_brin ON audit_logs USING brin (timestamp_ad);
CREATE INDEX IF NOT EXISTS idx_txn_timestamp_brin ON transaction_logs USING brin (timestamp_ad);
```

`pg_catalog`, after applying:

| table | index | method | column | size |
|---|---|---|---|---|
| `audit_logs` | `idx_audit_timestamp_brin` | `brin` | `timestamp_ad` | 24 kB |
| `transaction_logs` | `idx_txn_timestamp_brin` | `brin` | `timestamp_ad` | 24 kB |

**Date-range queries: same rows, no regression** (`EXPLAIN (ANALYZE, BUFFERS)`, five
runs where timing matters, median shown):

| query | rows | before (no BRIN) | after (BRIN present) |
|---|---|---|---|
| `count(*) FROM audit_logs WHERE timestamp_ad >= current_date - 1` | 7,958 | Seq Scan, 4.907 ms | Seq Scan, 4.691 ms (4.411–5.691) |
| `count(*) FROM transaction_logs WHERE timestamp_ad … Oct 2026` | 8 | Seq Scan, 0.158 ms | Seq Scan, 0.167 ms (0.156–0.243) |
| `… audit_logs ORDER BY timestamp_ad DESC LIMIT 50` | 50 | Index Scan `idx_audit_timestamp`, 0.149 ms | same plan, 0.195 ms (0.145–0.202) |
| `… transaction_logs ORDER BY timestamp_ad DESC, id DESC LIMIT 50` | 50 | Index Scan `idx_txn_timestamp` + incremental sort, 0.252 ms | same plan, 0.294 ms (0.257–0.332) |

The row counts are identical before and after (7,958 and 8), so the new indexes
changed no answer. The two "recent 50" deltas (≈40 µs) sit inside the per-run
spread of the same plan; there is no plan change to explain and no regression.

**B-Tree decision — kept, from measurement.** Removing the B-Tree from each
page-ordered read (`enable_indexscan = off`, `enable_bitmapscan = off`,
`enable_indexonlyscan = off` shows what the planner does without it):

| query | with the B-Tree | B-Tree unavailable |
|---|---|---|
| `audit_logs … ORDER BY timestamp_ad DESC LIMIT 50` | Index Scan, **0.145–0.202 ms** | Seq Scan 8,132 rows + top-N heapsort, **4.884 ms** (~25×) |
| `transaction_logs … ORDER BY timestamp_ad DESC, id DESC LIMIT 50` | Index Scan + incremental sort, **0.257–0.332 ms** | Seq Scan + top-N heapsort |

So both B-Trees stay. BRIN cannot produce ordering, and the audit and transaction
screens page by timestamp; on `transaction_logs` the B-Tree is also the more
precise index for a narrow range — with seq scans disabled the planner picked
`idx_txn_timestamp`, not the BRIN.

**What the measurement says the BRIN does today: nothing yet, deliberately.** The
planner does not choose it at this size — `audit_logs` is 4.8 MB / ~600 pages, so
a sequential scan over 5 summary ranges is genuinely cheaper. Forcing the issue
(`SET enable_seqscan = off`) proves the index is correct and usable: *Bitmap Index
Scan on `idx_audit_timestamp_brin`*, the same 5,876 rows, 4.056 ms. That is the
shape BRIN is bought for — tens of kB and no maintenance, becoming the cheaper
path only once the tables are large. This reverses the earlier "not now" verdict
in this document at the requester's direction (standing maintenance rather than a
measured trigger); the prediction that it would not be chosen at this size was
confirmed, and the reopen trigger is now `pg_relation_size` in the hundreds of MB
for either table.

**Declined, with reasons:**
- **Dropping either timestamp B-Tree** — ~25× on the ordered page (measured above).
- **`pages_per_range = 32`** — measured at scale below: the option changes nothing
  on a month partition, and a partitioned index rejects it on the parent anyway.
- **BRIN on `gl_journal_lines`** — ledger reads go through month partitions whose
  pruning already bounds the scan, and item 4 names only the two log tables.

#### Measured at scale — the fixture was finally run (worklist A9, 2026-11-17)

`scripts/seed_scale_fixture.mjs` was run on a scratch database
(`inventory_scale`, name-guarded) and `scripts/measure_scale.mjs` measured it with
`EXPLAIN (ANALYZE, BUFFERS)`, median of 7 runs:

| table | rows | on disk |
|---|---|---|
| `gl_journal_lines` (80 month children) | 3,000,000 | 1,064 MB |
| `audit_logs` (24 month children) | 2,000,000 | 704 MB |
| `transaction_logs` (24 month children) | 500,000 | 220 MB |
| `gl_journals` | 1,000 | 7.9 MB |

**Trial balance latency — the 100 ms acceptance target is refuted at this size.**
`FISCAL_YEAR_TRIAL_BALANCE_ROWS_SQL` (the statement a close runs) through
2026-12-31: **3,607 ms median** (3,545–4,370), `Aggregate` over 160 scan nodes —
80 `gl_journals` partitions and all 80 `gl_journal_lines` partitions. The
statement bounds the ledger by `j.journal_date_ad`, which prunes the journal
partitions but not the **line** partitions, so every posted line is aggregated.
That is the shape of a correct trial balance, not a regression, and it is an
order of magnitude past the target — the remedy is the pre-aggregated closed-year
snapshot already listed in Part B, not a plan hint.

**Partition pruning — measured, and narrower than assumed.** A one-month window
filtered the way the application filters (`j.journal_date_ad`): **1,161 ms over
80/80 line partitions, i.e. no line pruning.** The same window filtered on
`l.journal_date_ad` prunes to `gl_journal_lines_202001` and runs in **300 ms**.
So the pruning SCALE-3 assumed exists only for a report that filters the lines'
own date; a month-bounded report must use `l.journal_date_ad` to get it.

**BRIN: the planner does not pick it, and `pages_per_range` is not a lever.**
A one-day range (`2025-06-15`) prunes to `audit_logs_202506`, where the planner
chose `audit_logs_202506_timestamp_ad_idx` (B-Tree, Index Only Scan, 16 buffers,
1.2 ms) — the BRIN was not chosen even with `enable_seqscan = off`. The option
itself was measured by rebuilding all 24 child indexes at 32 / 128 / 256 / 512:

| `pages_per_range` | index (all 24 children) | % of the 346.6 MB log heap | one-day probe | heap blocks |
|---|---|---|---|---|
| 32 | 720 kB | 0.20 % | 0.47 ms | 32 |
| 128 (default) | 720 kB | 0.20 % | 0.51 ms | 32 |
| 256 | 720 kB | 0.20 % | 0.45 ms | 32 |
| 512 | 720 kB | 0.20 % | 0.42 ms | 32 |

A month partition holds ~83k rows / 14 MB, so a BRIN over it is three pages no
matter how the ranges are cut: **the setting is unmeasurable at this size.** It is
also not settable where it would need to be: `ALTER INDEX idx_audit_timestamp_brin
SET (pages_per_range = 64)` fails with `42809 This operation is not supported for
partitioned indexes`, and only the parent definition is inherited by each new
month partition.

**Decision: `pages_per_range` stays at the inherited default 128, no migration.**
Reopen when a single month's log partition reaches the hundreds of MB — at that
point the option becomes measurable *and* the keeper needs a step that re-applies
it to each new child index, because the parent cannot carry it.

#### Operational note — an applied numbered migration is immutable, comments included

Rewording the comments of `0030_hot_table_storage.sql` *after* it had run changed
its SHA-256, and the next boot refused to start:

```
Error: PostgreSQL startup failed: Migration 0030_hot_table_storage changed after it was applied
(recorded a2679ef620ad…, file ee97015a0a90…).
```

The repair used the repo's own tool, not a hand-edited ledger:
`scripts/reconcile_migration_checksums.ts` now carries a verifier for `0030` (both
tables must actually have `fillfactor=80` and `autovacuum_vacuum_scale_factor=0.02`),
and it refreshed the recorded checksum only after that verification passed. Rule
going forward: a numbered migration file is frozen once applied (comments too);
corrections go in a new migration or in `schema.sql`.

### Closed-year archiving — NOT NOW

Detaching a partition is destructive and, in this schema, non-trivial: each
monthly child of `gl_journals` is referenced by the inherited FK on
`gl_journal_lines` (dropping or detaching it needs the matching line child
handled first — the test for the provisioning job hit exactly this). The
retention window is also a business decision (the ledger is the audit trail even
though `fiscal_year_balances` holds the closed-year snapshot). Reopen when a
fiscal year actually passes the retention window (84 months modelled) **and**
the operator has rehearsed detach + archive on a restored copy.

### PgBouncer and replica routing — SCALE-3, infrastructure

> **Update 2026-11-18 — the replica half shipped; PgBouncer remains open.**
> `DATABASE_WRITE_URL` / `DATABASE_READ_URL` now drive two pools and
> `server/src/db/readRouting.ts` guards the read path: a replica-eligible
> reporting read is served by the replica only while pending-WAL lag is within
> `REPLICA_MAX_LAG_MS` (default 5,000 ms) and the request has not written;
> otherwise — lag over the limit, replica unreachable, or a replica error — the
> read is served by the primary and the replica is skipped for
> `REPLICA_COOLDOWN_MS`. Proven against a real streaming standby by
> `scripts/verify_read_routing.ts` (5/5 scenarios, lag measured 1,674 ms >
> 1,500 ms before the fallback). The PgBouncer work below is unchanged and still
> owns transaction pooling.

- The pool ceiling is real: `PG_POOL_MAX=40` × `instances: 'max'`. With a
  default `max_connections` of 100, a handful of workers exhausts the server.
- ~~`statement_timeout` is sent in the **startup packet**~~ — **changed
  2026-11-18.** The pool no longer carries `statement_timeout` or `options`;
  boot applies it to the role (`server/src/db/statementTimeout.ts`), which every
  backend inherits whichever pooler opened it. Verified against PostgreSQL: a
  role setting of `12345ms` is what a **new** connection reports, the second
  call is a no-op, and the prior value is restored afterwards. Residual risk:
  connections open at the moment of the ALTER keep their old value, and a role
  that cannot ALTER ROLE only gets a warning.
- Two boot repair paths (`journalPartitionRepair.ts`, `logPartitions.ts`) used
  `TEMP` tables; both are now `ON COMMIT DROP`, so nothing session-scoped can
  outlive its transaction on a backend the pooler reuses. The ledger purge
  switch was already transaction-scoped (`SET LOCAL` / `set_config(…, true)`),
  and the request path has no session advisory lock, `LISTEN` or `PREPARE`.
- **Blocked, not done:** the `pool_mode=transaction` run itself. PgBouncer is not
  installed on this host and cannot be provisioned here (no chocolatey, winget
  or scoop package; no Docker, WSL or Windows compiler), so the live proof needs
  the operator to install EDB PgBouncer for Windows or place `pgbouncer.exe` on
  PATH. The unit/integration guards that would fail on a regression are in place
  (`tests/pgbouncerReadiness.test.ts`).
- The audit found no session-level `SET`, temporary table or session advisory
  lock in the request path (every advisory lock used is `pg_advisory_xact_lock`,
  which releases at commit and is therefore transaction-scoped — the one
  `set_config(..., true)` in the purge path is also local to its transaction).
  That is the good news for transaction pooling; the untested part is the
  startup parameter and the `pg` driver's per-connection state.
- Replica routing needs breadth before it needs infrastructure:
  `reportingPool` is used by exactly one query today
  (`reports.controller.ts:94`). Move the statement/aging/valuation reads first,
  then a replica is worth standing up.

---

## 5. Monitoring queries for an operator

```sql
-- Is anything sitting in a DEFAULT partition? (pruning is defeated there)
SELECT 'gl_journals' AS parent, count(*) FROM gl_journals_default
UNION ALL SELECT 'gl_journal_lines', count(*) FROM gl_journal_lines_default;

-- GIN footprint (suggestion 5): size and usage of every trigram index.
SELECT relname, indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan
  FROM pg_stat_user_indexes
 WHERE indexrelname LIKE '%trgm%'
 ORDER BY pg_relation_size(indexrelid) DESC;

-- Dead tuples on the two hot tables (should stay near zero now).
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, reloptions
  FROM pg_stat_user_tables
 WHERE relname IN ('inventory_stock', 'document_sequence_daily');

-- Journal children and their bounds.
SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
  FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = 'gl_journals' ORDER BY c.relname;
```

`npm run check:partitions` is the gate for the first one: it exits non-zero on a
gap or a non-empty `DEFAULT`, so a cron/CI entry can watch it without a human
reading the output.

---

## 6. Not measured here (stated limitations)

- **Resolved 2026-11-17 (A9):** the fixture *was* run — 3,000,000 ledger lines,
  2,000,000 audit rows, 500,000 transaction rows, 500,000 customers and 250,000
  invoices — and the trial balance, the partition-pruning plan and the BRIN
  decision are measured in §4. What remains unmeasured is the 10M-line point:
  the full 10M-line seed was stopped after ~30 minutes on this workstation (≈4k
  rows/s through the composite journal FK) and the recorded run is 3M lines.
  "A trial balance completes under 100 ms on 10M lines" is therefore **refuted,
  not merely unproven** — 3M lines already take 3.6 s.
- No PgBouncer instance and no read replica were available, so the
  transaction-mode smoke test and the `pg_is_in_recovery()` routing test are
  still open.
- Partition pruning for a one-month trial balance is now measured (§4): it works
  only when the window filters `gl_journal_lines.journal_date_ad`; the
  application's own month filter on `j.journal_date_ad` scans all 80 line
  partitions. Closing that gap is Part B work, not a measurement.
- The numbers come from one workstation's PostgreSQL, seeded by a script whose
  data distribution is synthetic (monotonic timestamps, 1,000 journals for 3M
  lines). Absolute latencies on production hardware will differ; the plan
  shapes and the pruning behaviour are the transferable findings.
