# Round 15 — Advisory hardening (measured gaps from the 2026-11-17 audit)

Status: `[~]` in progress · Opened 2026-11-17 · Owner: main

Source: the 2026-11-17 database-optimisation audit
([doc](../../docs/database-optimization-audit-2026-11-17.md)) and the Sign-In
investigation. Both produced measurements, not opinions, and the measurements
exposed gaps that no open note owned. This round is that list.

## Why this round exists

The audit closed five outside suggestions and the sign-in report closed as a
browser-session condition. Closing them surfaced the following, each with a
fact that proves it today:

| Fact | Consequence |
|---|---|
| `provisionJournalPartitions` has two callers — `boot/dbBoot.ts:164` and the CLI | A process that stays up past the 3-month lookahead loses its monthly partitions and posting falls back to DDL inside a user's transaction — the defect the slice removed, reintroduced by elapsed time |
| `check:partitions` appears **0** times in `.github/workflows/ci.yml` | A dirty `DEFAULT` (unprunable rows that also block attaching that month) is silent until someone reads a boot log |
| `state/runtimeState.ts` reference arrays are updated only in the editing worker | Under `instances: 'max'` a branch/product rename is stale on every other worker until restart — wrong data, not slow data |
| An applied migration's checksum covers its comments | Rewording `0030`'s prose stopped the boot; the repair needed a hand-written verifier |
| The code detects rows in `DEFAULT`; nothing can move them | An invariant detector with no repair path |
| `scripts/verify_fresh_install.mjs` compares no `reloptions` | Divergent `fillfactor`/autovacuum/`pages_per_range` between fresh installs and booted installs would pass CI |
| Only `gl_journals`/`gl_journal_lines` are partitioned | The two log tables grow fastest, cannot be detached for retention, and `audit_logs` has no append-only trigger |
| `check:bundle-budget` fails at 324.1 kB vs 322 kB, before this work | `build-and-boot-timing` cannot go green; a permanently red gate teaches everyone to ignore CI |
| The 5M/10M-line fixture was never run | Trial-balance latency, BRIN selection and `pages_per_range` are unmeasured claims in an evidence-backed document |
| A click on a `visibilityState: hidden` page produces no DOM event | Browser checks can report a silent no-op and cost an afternoon |

## Supersession — comparison with the open notes (2026-11-17)

Before this round the tracker held three notes that were not closed:

| Open note | What it owns | Verdict |
|---|---|---|
| [Round 11 — cash receipts and funding](../2026-11-14-cash-receipts-and-funding/README.md) `[~]` | Partial customer receipts, voucher classes, non-trade funding (loans vs sales) | **Not superseded in content.** Product/domain work this round does not touch. Carried as Part B and still tracked here. |
| [Round 13 — enterprise scale and public exposure](../2026-11-16-enterprise-scale-and-public-exposure/README.md) `[~]` | Partition conversions of four growth tables, replica URLs, PgBouncer audit, pre-aggregated stock, TLS/CORS/CSP/MFA, reverse proxy, HSTS, `TRUST_PROXY` | **Partially superseded.** Its partition/BRIN assumptions are corrected by measurement: its "BRIN on `created_at`, `journal_date_ad`, `entry_date_ad`" line is declined in the audit (§4) because those reads are partition- or page-bounded, and A1/A2/A4/A7 below replace its provisioning assumptions. The public-exposure half is untouched by this round and carries as Part B. |
| [Round 14 — API keys and governance](../2026-11-16-api-key-management/README.md) `[ ]` | Scoped, expiring, revocable machine credentials | **Not superseded.** Blocked on Round 13's Redis state and MFA. Carried as Part C. |

**Conclusion.** This round is superior *for the database, CI and operational
layer*: it is measurement-backed, it closes defects in what the previous slice
shipped, and it names failure modes the open notes do not. It is **not** a
replacement for the product work in Rounds 11 and 14, nor for Round 13's public
surface.

Those three notes are therefore **terminated as active plans** — status `[—]`,
superseded by this round — and their live slices are carried here as Parts B and
C, by reference so the detail stays in one place. Nothing is dropped and one
plan is active.

## Part A — advisory slices (this round)

Each slice names the evidence and what "done" means. Tick a box only after
running it.

### A1 — Keep the partition window ahead of the calendar while the process is up `[x]`

Evidence: two callers only; 1-behind/3-ahead window. Boot-only provisioning is
correct for a process that restarts monthly and wrong for one that does not.

Done when: a leader-only periodic tick re-runs the same idempotent provisioning
function (never a second copy of the window logic), a second worker skips without
error, a single-worker install still runs it locally, a failing month is logged
and does not kill the timer, and a test pins all four behaviours against a stub
client so it needs no database.

**Done (2026-11-17).** `server/src/boot/journalPartitionKeeper.ts` re-runs
`provisionJournalPartitions` every six hours, takes the shared
`journal-partitions` lock when Redis is present (one worker does the DDL, the
rest return `skipped`), runs locally when it is not, and never throws into the
timer. `dbBoot.ts` arms it once after the boot pass. `tests/journalPartitionKeeper.test.ts`
is 5/5 with no database; replacing the single-worker branch with `skipped` fails
4/5, restoring it passes. Not covered here: nothing calls the keeper in the CLI
path (not needed — the CLI runs its own pass), and the tick interval is untimed
in CI because the test drives the tick directly.

### A2 — Make the dirty-`DEFAULT` alarm exist in CI `[x]`

Done when: a scheduled workflow runs `npm run check:partitions` (read-only) daily
and fails loudly on a gap or a non-empty `DEFAULT`, and the push pipeline runs it
too. One YAML file, no code.

**Done (2026-11-17).** `scripts/partition_alarm.sh` is the alarm and proves
itself on every run: provision (`--apply`), the read-only check must exit 0, then
a deliberately stale window (`--from 2020-01-01`) must exit non-zero **and name
the month** — if that control ever passes, the script itself exits 1, so the
alarm cannot become a silent pass. `.github/workflows/partition-alarm.yml` runs
it daily at 03:23 UTC (off the hour: the GitHub scheduler drops runs it cannot
start promptly) and on `workflow_dispatch`; `ci.yml` gained a `partition-window`
job that runs the same script on every push. No `|| true`, no
`continue-on-error`, no skip path. Measured against the live database: healthy
window **exit 0**; stale window **exit 1** printing
`201912, 202001, 202002, 202003, 202004` as the months with no partition; and
`PARTITION_ALARM_STALE_FROM=2026-11-17` — a window that *is* provisioned, i.e.
the case where a broken alarm would look green — makes the script **exit 1**.
Not provable here: neither workflow has run on GitHub (private repo, no token),
so the YAML itself is reviewed rather than observed.

### A3 — Cross-worker reference-cache staleness `[x]`

Evidence: edits land only in the editing worker's binding.
Done when: a master-data write publishes an invalidation for that cache name on
the existing shared bus and every worker re-runs that `CACHE_LOADS` entry; a test
proves a second worker observes the change without a restart.

**Done (2026-11-17).** `state/cacheWriteHook.ts` is the dependency-free choke
point: the ten reference-cache setters in `runtimeState` announce the write,
`state/cacheInvalidation.ts` publishes `{ name, origin }` on
`isp:cache:invalidated`, and every worker's subscriber re-runs that one
`CACHE_LOADS` entry against PostgreSQL. The writing worker ignores its own
message (its binding is already the current one), a name that is not in
`CACHE_LOADS` is refused rather than guessed, and without Redis there is nothing
to publish while the write still lands. `server/index.ts` wires it right after
the SSE subscriber. `tests/referenceCacheInvalidation.test.ts` is 6/6, using the
in-memory store in Redis mode — the repository's documented convention for the
shared contract, since no Redis daemon is installed here — and proves a write on
worker A reaches worker B's binding with no restart, plus the four guards above
and a source pin that every hydrated reference cache except the hot stock
projection announces. Live: the dev server reloaded this boot path and still
answers `GET /api/health` 200. Not proven here: a real cross-process hop over a
Redis socket, and a browser-visible refresh (the binding is server-side).

### A4 — Comment-insensitive migration checksums, and an immutability guard `[x]`

Done when: the runner hashes SQL with comments stripped (prose edits stop
stopping the boot), a numbered migration whose *statements* changed still fails
the boot, and a test covers both directions.

**Done (2026-11-17).** `migrationChecksum()` hashes `stripSqlComments(sql)`:
line and nested block comments removed, whitespace outside literals collapsed to
one space, while single-quoted strings, quoted identifiers and dollar-quoted
bodies are copied verbatim — so a literal edit still changes the hash, and a
comment inside a function body stays part of it. On a mismatch the runner
accepts a recorded *raw* checksum exactly once and re-records the normalized one,
so existing installs are not locked out; a statement change still throws and the
message now says so. `tests/migrationChecksums.test.ts` is 7/7: 3 pure (scanner,
`--` inside a literal/identifier/dollar body, comment-vs-statement hashes) and 4
against a throwaway database (comment-only edit re-runs with `applied: []` and an
unchanged checksum; statement edit rejects with `changed after it was applied`;
legacy raw value upgraded in place; the comment-stripped ledger convention
upgraded in place; baseline row untouched). The first run failed on the real
gap: removing a comment left its newline behind, so a comment-only edit still
changed the hash — whitespace normalised, re-run green.

**Incident found while proving it (2026-11-17).** The development database could
not boot at all: its ledger mixed two historical conventions (the raw file and
the comment-stripped file), so migration 0002 refused. Measurement over all 31
rows: 28 matched the comment-stripped digest of their file and are now upgraded
by the legacy path; **three did not** — `0003_partition_journals`,
`0014_chart_governance`, `0016_existing_install_backfill` — and their effects
were missing (chart groups 1110/2110 absent, 21 close-checklist rows unfilled),
i.e. they had been recorded without being applied. They were **replayed**, not
checksum-forged: their rows were removed and the runner re-applied exactly those
three, all guarded (`IF v_kind = 'r'`, `ON CONFLICT DO NOTHING`, `NOT EXISTS`),
then a second run reported `applied: []`. Verified after: groups
`1000,1110,2000,2110`, zero missing checklist rows, `schema_migrations` at
`0031_log_timestamp_brin`, and the server booting on port 3000. The removed rows
were `0003_partition_journals 3b948e1a…`, `0014_chart_governance e0b16c7d…` and
`0016_existing_install_backfill fbce5ead…`; the outcome is in
`SESSION_NOTES.md`.

### A5 — Repair path for a dirty `DEFAULT` partition `[x]`

Done when: a script detaches `DEFAULT`, creates the missing months, reinserts the
rows through the parent and reattaches — rehearsed on a throwaway database, with
a test that starts from a dirty `DEFAULT` and ends at a clean one.

**Done (2026-11-17).** `server/src/boot/journalPartitionRepair.ts`, driven by
`npm run repair:partitions [-- --apply]`. Plan mode reports the months and moves
nothing. The repair is one transaction: stage both DEFAULT children in temporary
tables, clear DEFAULT under the schema's own `inventory.allow_ledger_purge`
switch (`SET LOCAL`), create the months with `ensure_journal_month_partition`,
reinsert through the parent, and verify every staged row is readable from the
parent again before COMMIT — a row that did not land aborts the transaction. The
registry-sync triggers are disabled only for the reinsert (their rows already
exist) and re-enabled before COMMIT.

**Deliberate deviation from this note's wording.** Detaching is not possible for
this schema: a line in `gl_journal_lines_default` references its journal row by
the composite key, so `DETACH PARTITION gl_journals_default` fails with
*removing partition … violates foreign key constraint*; detaching the lines child
first only moves the error, and dropping the detached table's FK does not
round-trip through `ATTACH` (both were measured before the design changed). The
staging path reaches the same end state — DEFAULT empty and still attached,
every row in its month, nothing lost — without touching any other month's
membership.

**Proof.** `tests/defaultPartitionRepair.test.ts` is 4/4 against a throwaway
database: the starting state really is a dirty DEFAULT, a plan run moves nothing,
the repair moves the journal **and its line** into `gl_journals_201908` /
`gl_journal_lines_201908` with `DEFAULT` at 0/0, one registry row and both
registry triggers re-enabled, and a second run reports `clean`. Live CLI on a
throwaway `inventory_repair_probe` built from `scripts/schema.sql`: dirty 1
journal / 1 line → plan **exit 0**, nothing moved → `--apply` **exit 0** printing
`DEFAULT after 0 journal / 0 line` with `journals_201908=1` and
`lines_201908=1` → rerun **exit 0** ("nothing to repair"); database dropped.
Not covered: an undated row (the repair refuses and says so) has no test, and the
repair is not wired into boot — it is an operator command, like `--apply`.

### A6 — Storage-parameter drift guard `[x]`

Done when: the fresh-install snapshot includes table `reloptions` and index
storage parameters, and a deliberately divergent `fillfactor` fails the guard.

**Done (2026-11-17).** `scripts/schemaSnapshot.mjs` owns the snapshot and the
diff (the guard's decision function) and adds a `storage` category built from
`pg_class.reloptions` for `r`, `p`, `i` and `m` — the parameters
`pg_indexes.indexdef` cannot see, so index `fillfactor` and BRIN
`pages_per_range` are now compared. `verify_fresh_install.mjs` imports the
module instead of keeping a local copy and compares `storage`; a live run reports
`✓ storage: identical (752 entries)` beside tables 131, columns 1,998,
constraints 1,741, indexes 634, triggers 44 and exits 0.
`tests/schemaSnapshot.test.ts` is 5/5: a divergent table `fillfactor=80` and a
divergent BRIN `pages_per_range=32` on an index both fail the diff, identical
snapshots pass regardless of order, and the query plus the `diffCategory('storage', …)`
call are pinned so the category cannot be dropped silently. The divergence is
proven at the decision function; the live guard run proves the category is
populated on both sides, not merely present in the query.

### A7 — Partition the log tables, and guard the audit trail `[x]`

Done when: `audit_logs` and `transaction_logs` are range-partitioned by month
(mirroring the ledger design, with registry tables for external FKs), retention
becomes a detach rather than a delete, and `audit_logs` refuses UPDATE/DELETE
like the ledger does.

**Delivered:** migration `0032_log_table_partitions.sql` (mirrored in
`scripts/schema.sql`) converts both tables to `PARTITION BY RANGE (timestamp_ad)`
with `<table>_YYYYMM` children and a `<table>_default` catch-all, copies the live
CHECK constraints from the old table instead of restating them (an install that
has been through later migrations accepts more values than the original
`CREATE TABLE` did — restating them refused a seeded boot), backfills a NULL
timestamp (the column is now NOT NULL because the partition key is part of the
primary key) and verifies the row count before dropping the legacy table, all in
one transaction. `ensure_log_month_partition(table, ts)` is the single DDL
function; `server/src/boot/logPartitions.ts` adds status, provisioning, dirty
DEFAULT repair (staging + reinsert through the parent, under
`inventory.allow_ledger_purge`), and `ensureLogMonthPartition()` with a
per-process month cache that `audit.service` calls before its INSERT — the
write-path month creation. The keeper now provisions the same window for both
log tables and auto-repairs a dated row that landed in DEFAULT;
`check:partitions` and `repair:partitions` report and fix the same state.
`audit_logs` refuses UPDATE and DELETE through `reject_audit_log_mutation()`,
using the same `SET LOCAL inventory.allow_ledger_purge = 'on'` switch the ledger
purge uses; the guard is attached to the parent **and to every child** (a
parent-level trigger does not fire for DML aimed at a child). Every test cleanup
that deleted audit rows (44 files, 56 statements) now goes through
`tests/support/purgeAuditLogs.ts`. Transaction-log inserts changed
`ON CONFLICT (id)` to `ON CONFLICT DO NOTHING`: the partitioned primary key is
`(id, timestamp_ad)`, so no unique index on `id` alone exists.

**Deliberate deviations.** (1) No `BEFORE INSERT` routing trigger: PostgreSQL
refuses `CREATE TABLE … PARTITION OF` inside the statement that inserts into the
same table (`…because it is being used by active queries in this session`,
measured), so month creation is its own statement on the write path, exactly how
the GL posting path calls `ensure_journal_month_partition`. A write whose month
is not provisioned still succeeds into DEFAULT and the keeper moves it within one
tick. (2) No registry tables: nothing has a foreign key to either log table, so
the external-FK problem the ledger registry solves does not exist here.

**Proven.** `tests/logTablePartitions.test.ts` is 7/7 on throwaway databases:
both tables partitioned with DEFAULT, audit and transaction writes read back
from their month child across two months, an undated insert still succeeds, the
database rejects UPDATE, DELETE and a child-targeted DELETE, the sanctioned purge
still removes rows, and a pre-A7 populated table converts with counts preserved
and a second apply a no-op. Real run on `inventory_a7_final` built from the
pre-A7 `scripts/schema.sql`: schema exit 0; seeded 3 audit / 2 transaction rows;
first apply exit 0; counts 3/2 before and after; rows landed in
`audit_logs_202608/202609` and `transaction_logs_202608/202609`; second apply
exit 0 with counts still 3/2; `ensure_log_month_partition` + insert routed to
`*_202611` with DEFAULT 0/0; UPDATE exit 1, DELETE exit 1, child DELETE exit 1;
sanctioned purge exit 0. The live dev database migrated on boot
(`✅ Schema migrations at 0032_log_table_partitions`) and serves `/api/health`
200.

**Two more things the slice had to settle.** Audit rows mention a branch and a
fiscal year, and both columns were `ON DELETE SET NULL`: deleting a master row
performed a cascading UPDATE that the new guard refuses, so branch deletion
would have failed. The FKs are gone (the trail keeps the id it was written
with); the `transaction_logs` FKs stay, since that table has no guard. And
`scripts/run_tests.mjs` gives every suite connection
`inventory.allow_ledger_purge=on` (the ledger suites need it), so the guard
test sets `off` for its own session — otherwise it would measure the escape
hatch, not the guard. The schema-table count assertions moved 121 → 123 (the
two new DEFAULT children).

**Still unproven.** The keeper's cross-process leadership is only exercised with
the in-memory store (no Redis daemon here), as with A1/A3. Retention as a
detach has a tested primitive but no scheduled job — that stays an operator
decision. Transaction-log writes provision their month through the boot/keeper
window rather than a synchronous call at each of their ~30 call sites; backdated
rows outside the window rely on the keeper's repair tick. TRUNCATE is not
blocked by the row guard; the demo reseed's wipe is the one such path and it is
documented, not guarded.

### A8 — CI truth `[x]`

Done when: `check:bundle-budget` is green by decision (calibrated deliberately
with a comment, or the eager startup trimmed), and `npm run ci:local` runs the
four workflow jobs as one command so a change can be validated without a token.

**Delivered:** `scripts/ci_local.mjs` + `npm run ci:local` runs the workflow's
four jobs — `static-checks` (tsc, no-inline-SQL, no-raw-dialogs, `npm audit
--omit=dev`), `partition-window` (schema + provisioning + the alarm and its
negative control, on a throwaway database it creates and drops),
`build-and-boot-timing` (fresh-install parity, production build, startup bundle
budget) and `test-suite` (`scripts/run_tests.mjs`, i.e. the suite + docs gate).
`--list`, `--only`, `--skip` and `--with-browser` are supported; an unknown job
name or a run with every job skipped exits 2 instead of reporting a green.
`tests/ciLocal.test.ts` is 6/6 and pins the runner to the workflow: every command
it lists must still appear in `.github/workflows/ci.yml`, and it asserts the
runner does not leak `NODE_ENV` from `.env`.

**The bundle budget was failing, and the runner found why.**
`check:bundle-budget` measured startup 324.1 kB against the unchanged 322 kB
gate. `findLazyScreenChunksInStartup` reports no lazy leak; the growth is real
screen weight in App.tsx's eager route table (StockOperations, ProductManagement,
Dashboard, PurchaseOrders). The gate is therefore recalibrated **deliberately**
to 330 kB (5.9 kB, ~1.8 % headroom ≈ one screen) with the measurement and the
reason in the script, and the entry budget stays at 22.25 kB because the shell
itself did not grow. The honest fix — moving those screens to lazy routes — is
Part B work, not a shaved constant here.

Running the runner also exposed a real local/CI divergence: `.env` sets
`NODE_ENV=development` for the dev server, and passing it to `vite build` emits
the React **development** bundle (startup 420.5 kB, `react-dom.development` in
`vendor-react`) which no budget can pass — CI has no `.env`, so the workflow
would have been green while a local build was double the size. `ci:local` strips
`NODE_ENV` for every step and pins `NODE_ENV=production` on the build step;
it proves the point by rebuilding to 324.1 kB.

**Proven this turn.** `ci:local --only static-checks,partition-window` exit 0
(the partition job provisioned `inventory_ci_local_partitions` from
`scripts/schema.sql`, reported both log tables' window present with DEFAULT 0/0,
and its stale-window negative control still failed with 202001 named);
`ci:local --only build-and-boot-timing` exit 0 (fresh-install parity, build,
budget 324.1/330 kB); the boot-timing step is opt-in locally because it needs a
browser and a seeded demo account — CI runs it on every push.

**Deviation / unproven.** The browser boot-timing step did not run locally
(`--with-browser` not passed; no seeded demo account was created for it). The
workflow file itself is unchanged, so a step added there without a matching job
here would only be caught by the parity test's curated command list, not by a
general workflow parser.

### A9 — Pay the scale-measurement debt `[x]`

Done when: `scripts/seed_scale_fixture.mjs` has been run once on a scratch
database and the audit records trial-balance latency, whether the planner picks
the BRIN, and the `pages_per_range` decision it implies.

**Delivered.** `scripts/seed_scale_fixture.mjs` ran on the scratch
`inventory_scale` database and `scripts/measure_scale.mjs` (new) measured it with
`EXPLAIN (ANALYZE, BUFFERS)`, median of 7 runs; every number is in audit §4 under
"Measured at scale" and §6 was corrected to match.

- **Trial balance: 3,607 ms median** (3,545–4,370) over 3.0M ledger lines / 1,064
  MB, `Aggregate` over 160 scan nodes. The 100 ms acceptance target is refuted at
  this size, not merely unproven.
- **Pruning:** a one-month window filtered on `j.journal_date_ad` scans **80/80**
  line partitions (1,161 ms); the same window on `l.journal_date_ad` prunes to
  `gl_journal_lines_202001` (300 ms). The application's month filter therefore
  gets no line pruning — Part B work, recorded rather than silently "fixed".
- **BRIN:** the planner does not pick it — a one-day range prunes to
  `audit_logs_202506` and uses the B-Tree `…_timestamp_ad_idx` (Index Only Scan,
  16 buffers, 1.2 ms), also with `enable_seqscan = off`.
- **`pages_per_range`: stays at the inherited default 128, no migration.** All 24
  child indexes rebuilt at 32/128/256/512 give the same 720 kB index, the same 32
  heap blocks and 0.42–0.51 ms, because a month partition is ~83k rows / 14 MB.
  `ALTER INDEX … SET` on the parent is refused outright (`42809`, partitioned
  index) and only the parent's definition is inherited by future partitions, so
  any other value would need a keeper step per new child. Reopen trigger: a
  month's log partition in the hundreds of MB, together with that step.

Running the fixture exposed four real defects in it, all fixed here: `ON CONFLICT
(id)` is invalid against a partitioned `gl_journals` (now `ON CONFLICT DO
NOTHING`); a line's `journal_date_ad` must equal its journal's because the FK is
composite (the seed used an unrelated date formula); `--branches 0` divided by
zero in the branch modulo; and A7's append-only guard blocked the teardown, which
now runs inside `SET LOCAL inventory.allow_ledger_purge = 'on'` in one
transaction. The fixture also seeds `audit_logs`/`transaction_logs` across 24
months through `ensure_log_month_partition`, so the BRIN question is measured on
real month partitions instead of a single `DEFAULT` child.

**Deviation / unproven.** The 10M-line seed was stopped after ~30 minutes at ~4k
rows/s (the composite journal FK dominates) and the recorded run is 3.0M lines
with 2.0M audit and 0.5M transaction rows; the scratch database was created by
`scripts/schema.sql` and booted once to seed masters. Latencies are from one
workstation, so absolute numbers will differ on production hardware — the plan
shapes and the pruning result are the transferable part. `transaction_logs` was
seeded but only spot-checked; the BRIN trade-off was measured on `audit_logs`,
whose index A7 created with `IF NOT EXISTS` in the same shape.

New tests: `tests/scaleFixtureGuards.test.ts` (5) — neither script may fall back
to `DATABASE_URL`, both refuse a database whose name lacks `_scale`, `--dry-run`
writes nothing, and the fixture refuses to write without `--yes`.

### A10 — Fail browser checks when the page cannot receive input `[x]`

Done when: any browser-driven check asserts `visibilityState`/focus first and
reports "input cannot reach this page" instead of a silent no-op.

**Delivered.** The repo's one browser-driven check is
`scripts/check_boot_timing.mjs` (headless Edge/Chrome over CDP); it measured
paint order and never touched an input, so a page that rendered but could not
accept input passed. `scripts/inputReadiness.mjs` is now the readiness probe, and
the gate fails on its verdict. Three root causes were fixed, not worked around:

1. **The check never activated its own tab.** A headless tab reports
   `hasFocus() === false` and the first click is consumed activating the window —
   the exact condition the Sign-In investigation spent an afternoon on. The probe
   now calls `Page.bringToFront` and waits up to 2 s for focus; if the page still
   does not hold focus, that is a failure, not a pass.
2. **“A control exists” was never checked against the browser's own hit-test.**
   The probe runs `document.elementFromPoint` at the control's centre (the same
   test a real click uses) and names whatever covers it.
3. **A broken control let the check re-pick a healthy neighbour.** Once a target
   is chosen it is pinned (`data-input-readiness-target`) and judged even when it
   becomes disabled, read-only or unfocusable — otherwise a form whose first
   field broke would pass on its second.

The verdict covers all the states named in the audit: hidden document, unfocused
page, no interactive control at all (a loading/disabled shell), a control that is
invisible, covered by an overlay, disabled, read-only, unable to take focus, or
one whose value does not change when `Input.insertText` types through the real
event path. Each problem is prefixed `input cannot reach this page:` and names
the element (`input[type="text"][placeholder="Search customer name, code, ph"].…`)
and the covering element where relevant. `diagnoseInputReadiness()` is pure and
unit-tested for every state; the app is not asked to fake anything.

**Proven both ways** against the production build (`npm run build`, budget 12 s):
- healthy `dist/` on a seeded demo account: **exit 0**, `✔ Input readiness —
  page visible and focused; 11 interactive control(s) in <main>; typed into it
  "input[…Search customer name, code, ph…]" and the value changed.`
- `--inject overlay` **exit 1**: `… is covered by "div#input-readiness-overlay" —
  a click at its centre lands on that element instead, so it cannot receive
  input`.
- `--inject disabled` **exit 1**: `… "input[type="date"].w-full.rounded-lg" is
  disabled, so it refuses input`.
- `--inject readonly` **exit 1**: `… is read-only, so typing cannot change it`.
- `--inject unfocusable` **exit 1**: `… cannot take focus, so keystrokes never
  reach it`.
- `--inject nontyping` **exit 1**: `typing into "…" did not change its value
  (still "") — the input is not accepting text`.
- `--inject shell` **exit 1**: `no interactive control is on screen (main shows:
  "Loading…") — the page is still a loading/disabled shell`.
- `--self-test` **exit 0**: healthy page passes and all six injected faults are
  detected in one run, so the gate's own strictness is itself checked.

`tests/inputReadiness.test.ts` (17) pins the fourteen decision cases (including
"a pinned target that becomes disabled must not be reported as a shell") and the
wiring: the gate imports the probe, folds its problems into the same failure list
that reddens the job, refuses an unknown `--inject` value, and the overlay/shell
injections really paint a full-viewport layer and a loading shell.

**Deviation / unproven.** The dev-server path (`--base-url http://localhost:3000`)
cannot be used for the paint-order assertions at all: Vite's HMR socket throws
`WebSocket closed without opened` on every navigation, which the gate correctly
treats as an uncaught page exception. The readiness phase itself is dev-server
safe; the production build is how CI and this proof run it. `Page.bringToFront`
is what makes focus arrive in headless Edge here; on a runner where focus cannot
be granted the gate fails rather than pretending, which is the intended
behaviour but has not been observed on Linux CI. No app code needed changing —
the real Create Sales Invoice form accepts input. The gate remains outside
`npm test` (it needs a browser and a seeded demo account).

## Part B — carried from Rounds 11 and 13

Authoritative detail stays in those notes; this round owns their scheduling.

- Round 11 remainder: partial customer receipts with allocations, explicit
  voucher classes for direct cash/bank movements, and the non-trade funding lane.
- Round 13 remainder: partition conversions of `gl_subledger_entries`,
  `stock_operations`, `serial_log`; replica/PgBouncer decision (audit §1 row 2);
  pre-aggregated stock and closed-year trial balance; queued writes; and the
  whole public-exposure surface — TLS, CORS, CSP, MFA, reverse proxy, HSTS,
  `TRUST_PROXY`, real client IP in the audit trail.

## Part C — carried from Round 14

API keys: scoped, expiring, revocable credentials enforced by the existing RBAC
and branch/fiscal-year gates, with an administration UI and usage audit. Blocked
on the Redis state and MFA work in Part B.

## Gates

- `npx tsc --noEmit`, the slice's tests, `check:no-inline-sql`,
  `check:no-raw-dialogs`, and `check:bundle-budget` when client code changed.
- Full `npm test` at round close; the docs-count gate must keep passing.
- A numbered migration's **statements** are frozen once applied; comments may
  change (A4 hashes the SQL with comments removed). A statement correction is a
  new migration, or `scripts/reconcile_migration_checksums.ts` with a verifier.

## Progress

- 2026-11-17 — round opened; Rounds 11, 13 and 14 terminated as active plans and
  carried as Parts B and C. **A1 done**: keeper module + wiring + 5 tests
  (`npx tsc --noEmit` 0, suite green).
- 2026-11-17 — **A3 and A5 done**: the shared-bus cache invalidation (10 setters
  announce, every worker re-runs its `CACHE_LOADS` entry) and the dirty-`DEFAULT`
  repair (`npm run repair:partitions`, staged and transactional, because detach
  is refused by the line→journal FK). Tests: `tests/referenceCacheInvalidation.test.ts`
  (6) and `tests/defaultPartitionRepair.test.ts` (4).
- 2026-11-17 — **A2, A4 and A6 done**: the daily alarm and its self-test, the
  comment-insensitive checksums with both legacy conventions, and the
  storage-parameter drift guard. New tests: `tests/migrationChecksums.test.ts`
  (7), `tests/schemaSnapshot.test.ts` (5), plus a wiring pin in
  `tests/journalPartitionKeeper.test.ts` (6 total) so A1's arming cannot regress
  unnoticed. The A4 proof uncovered a boot-blocking ledger on the development
  database: 28 rows upgraded by the new legacy path, 3 drifted migrations
  replayed (never checksum-forged), server booting again. Next: A3 (cross-worker
  reference-cache staleness), A5 (the dirty `DEFAULT` repair path), A7 (log-table
  partitions and the audit append-only guard).
- 2026-11-17 — **A7 done**: migration 0032 partitions `audit_logs` and
  `transaction_logs` by month with a DEFAULT child, month creation on the audit
  write path plus the boot/keeper window, an append-only guard on the audit trail
  (parent and every child) behind `inventory.allow_ledger_purge`, and a
  populated-install conversion that stages rows and constraints first so upgrade
  and fresh schemas agree on names. `tests/logTablePartitions.test.ts` (7) plus
  44 test files moved onto `purgeAuditLogs`. Populated pre-A7 database: 3 audit /
  2 transaction rows before and after, both applies exit 0, second a no-op.
- 2026-11-17 — **A8 done**: `npm run ci:local` runs the four workflow jobs
  (static checks, partition window + negative control on a throwaway database,
  fresh-install/build/bundle budget, full suite + docs gate) with strict job
  selection; `tests/ciLocal.test.ts` (6) pins its commands to `ci.yml`. The
  startup budget was red at 324.1 kB and is recalibrated to 330 kB on
  measurement (no lazy leak; eager screen weight), and the runner strips
  `NODE_ENV` so a local build is production, not a development React bundle.
- 2026-11-17 — **A9 done**: the scale fixture ran on a scratch `_scale` database
  and the new `scripts/measure_scale.mjs` measured it with `EXPLAIN (ANALYZE,
  BUFFERS)`: trial balance **3,607 ms** median over 3.0M lines (the 100 ms target
  is refuted, not owed), a one-month window prunes line partitions only when it
  filters `l.journal_date_ad` (1,161 ms over 80/80 vs 300 ms over 1), the planner
  does not pick the BRIN at 2.0M rows, and `pages_per_range` stays at the
  inherited 128 because each child index rebuilds identically at 32/128/256/512
  and the parent refuses the option (`42809`). The fixture itself gained
  `audit_logs`/`transaction_logs` seeding plus four real fixes (partitioned
  `ON CONFLICT`, the composite journal FK date, the zero-branch modulo, and the
  A7 append-only guard on teardown). `tests/scaleFixtureGuards.test.ts` (5).
- 2026-11-17 — **A10 done**: the repo's browser gate (`check:boot-timing`) now
  fails when the settled page cannot receive input. `scripts/inputReadiness.mjs`
  brings the tab to the front and requires visibility and focus, runs the
  browser's own hit-test at the control's centre, and types through
  `Input.insertText` to prove the value actually changes; a pinned target is
  judged even after it breaks, so a form cannot pass on a healthy neighbour.
  Proven on the production build: healthy **exit 0** (`typed into "input[…
  Search customer name, code, ph…]" and the value changed`); `--inject
  overlay|disabled|readonly|unfocusable|nontyping|shell` each **exit 1** naming
  the element and the reason; `--self-test` **exit 0** with all six caught.
  `tests/inputReadiness.test.ts` (17). No app code changed — the real form does
  accept input.
