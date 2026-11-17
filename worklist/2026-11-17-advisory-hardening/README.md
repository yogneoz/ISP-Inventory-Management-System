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

### A3 — Cross-worker reference-cache staleness `[ ]`

Evidence: edits land only in the editing worker's binding.
Done when: a master-data write publishes an invalidation for that cache name on
the existing shared bus and every worker re-runs that `CACHE_LOADS` entry; a test
proves a second worker observes the change without a restart.

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

### A5 — Repair path for a dirty `DEFAULT` partition `[ ]`

Done when: a script detaches `DEFAULT`, creates the missing months, reinserts the
rows through the parent and reattaches — rehearsed on a throwaway database, with
a test that starts from a dirty `DEFAULT` and ends at a clean one.

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

### A7 — Partition the log tables, and guard the audit trail `[ ]`

Done when: `audit_logs` and `transaction_logs` are range-partitioned by month
(mirroring the ledger design, with registry tables for external FKs), retention
becomes a detach rather than a delete, and `audit_logs` refuses UPDATE/DELETE
like the ledger does.

### A8 — CI truth `[ ]`

Done when: `check:bundle-budget` is green by decision (calibrated deliberately
with a comment, or the eager startup trimmed), and `npm run ci:local` runs the
four workflow jobs as one command so a change can be validated without a token.

### A9 — Pay the scale-measurement debt `[ ]`

Done when: `scripts/seed_scale_fixture.mjs` has been run once on a scratch
database and the audit records trial-balance latency, whether the planner picks
the BRIN, and the `pages_per_range` decision it implies.

### A10 — Fail browser checks when the page cannot receive input `[ ]`

Done when: any browser-driven check asserts `visibilityState`/focus first and
reports "input cannot reach this page" instead of a silent no-op.

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
