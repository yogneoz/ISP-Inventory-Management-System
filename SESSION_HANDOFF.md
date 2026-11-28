# Handoff — start here in a new chat

Written 2026-11-20 at the close of a long session. This file is a pointer, not a
source of truth: where it disagrees with the code, the code wins. Detail lives in
[SESSION_NOTES.md](SESSION_NOTES.md), [handoff.md](handoff.md) and
[docs/session-notes/2026.md](docs/session-notes/2026.md).

> **Where the code lives (2026-11-27).** `/root/isp-live` in WSL (`Ubuntu-24.04`)
> is the canonical working copy — the dev server, PostgreSQL, the suite and every
> commit run there. `D:\inventory-dev\ISP-Inventory-Management-System` is a
> stale duplicate: do not edit, test or commit in it. Work that landed there had
> to be fetched and copied into the WSL clone by hand, which cost a session.

## Where the work stands

**2026-11-28 — the audit corrections are in the working tree, uncommitted.**
[docs/audit-2026-11-28.md](docs/audit-2026-11-28.md) is the record. Three
critical defects and six high ones are fixed: a transaction's SSE broadcast and
audit-mirror write now happen only after `COMMIT`
(`server/src/db/afterCommit.ts`); the permission matrix/overrides/set-grants
fan out to every worker like the reference caches
(`permissions` cache name in `server/src/state/cacheInvalidation.ts`); a posting
locks its fiscal-year row `FOR SHARE` so a close can no longer land between its
read and its inserts; `bootstrap/local` no longer answers `auditLogs` from an
empty binding; `GET /api/stock` fails closed instead of serving the boot-time
mirror; SSE `dataVersion` strictly increases; `inventory_stock` gained
`CHECK (quantity_on_hand >= 0)` (migration `0063`, applied to the dev database);
a sales invoice deducts its stock in one statement instead of one per line; and
audit ids are UUIDs. Nothing is pushed.

C3 is no longer reasoned-only. `tests/fiscalCloseRace.concurrency.test.ts` runs
the real close (`closeFiscalYear`) against the real posting (`postJournal`) on
genuine pool connections in a throwaway database it owns, parking the posting
inside `postJournal` between its fiscal-year read and its journal write. The close
must block there and loses its own `lock_timeout` (SQLSTATE `55P03`); the year
stays open; the posting commits; the close then lands with that journal in its
snapshot. The reverse order refuses the posting with a `409` naming the closed
year, and the audited Super Admin override still posts. Deleting `FOR SHARE` from
`FISCAL_YEAR_BOUNDS_SQL` turns the test red — that is how the clause stopped being
a comment. The posting path also refuses a closed year by itself now
(`ensureOpenPeriod`), because an outbox flush never passes through the HTTP gate;
the per-request override travels in `server/src/state/fiscalWriteOverride.ts`.

H5 is measured now, not argued. `tests/salesStockDeductionBatch.test.ts` counts
every statement that updates `inventory_stock` while a real 40-line invoice goes
through `POST /api/sales-invoices`: exactly one, and restoring the controller's
per-line loop makes it red (`actual: 40, expected: 1`). The same file measures
both shapes on the development database in rolled-back transactions, nine
alternating repetitions, medians — batch 1.7–2.9 ms / 1 statement versus per-line
23–43 ms / 40 statements, 21–40 ms saved per invoice across four intact runs
(21.1, 24.8, 28.3, 40.2).
Conditions and the gap (row-lock contention is not measured) are in the audit.
The timing is printed, not asserted.

**2026-11-28, same day: Redis is a hard install prerequisite.** A production
start — one worker or many — now refuses to boot without `REDIS_URL` or
`REDIS_TLS_URL`, and an unreachable server is a boot failure with the reason on
stderr; there is no in-memory fallback to disable. Only the dev server and the
unit tests keep the in-process store. Redis 7.0.15 is installed and enabled in
this WSL distro (`systemctl is-active redis-server`), `.env` and `.env.example`
carry `REDIS_URL=redis://127.0.0.1:6379`, and `npm run check:redis` PINGs it,
prints the version and proves a read/write round trip. CI gained a
`redis:7-alpine` service in `build-and-boot-timing` and `test-suite`, the
lifecycle/boot-failure/fresh-install/boot-timing probes pass a Redis URL
(lifecycle boots use db 15 so they share no keyspace with a dev server), and
`tests/singleInstance.guard.test.ts` pins the production refusal. README's
install guide now has **Step 3: Redis (required)** (database became Step 4, the
dev server Step 5, PgBouncer stayed optional as Step 4b) and the false "logs the
in-process fallback" sentence is gone. `npm run verify:redis-invalidation` — the
two-process cross-worker proof — passes against this Redis: a write on worker A is
seen by worker B. C2's own half is `npm run verify:permissions-fanout`: worker A
commits a `grant` override, worker B still denies until the invalidation crosses
Redis, then allows it with `permissionsVersion` 2 → 3 — and the proof fails if the
announcement is removed. It runs as a CI step in `build-and-boot-timing`. The suite is 2,950 tests, green, with
the docs-count gate at 2,950 and the one Redis skip gone.

Before that, nothing was in progress. Newest plan note:
[worklist/2026-11-20-subscription-billing](worklist/2026-11-20-subscription-billing/README.md)
— opened 2026-11-20, no code yet. Before it,
[worklist/2026-11-19-app-structure-and-employee-stock](worklist/2026-11-19-app-structure-and-employee-stock/README.md)
is `[x]` complete (2026-11-20); the work since then is in
[SESSION_NOTES.md](SESSION_NOTES.md), through 2026-11-27. Last commits on
`main` — **none pushed**:

- `54ffec2` — this page names the WSL clone as the canonical working copy
- `a20328d` — ledger-purge refusal keyed on the test-file entry point
- `1309c46` — a bare `npx tsx --test` refused instead of poisoning the dev DB
- `5c89415` — the retry-metrics suite waits for the listen callback

Delivered in that note: the six App.tsx splits (lazy screens, `useSyncStream`,
`useAppRouting`, `screenRoutes`, five domain action hooks, `BootstrapDataProvider`)
and both employee-stock custody slices. Offboarding's "return issued equipment"
item is **derived from live holdings**, never stored, and completion re-reads the
holdings inside its own transaction (`FOR UPDATE OF h`) and refuses `409
EMPLOYEE_STOCK_HELD`.

Open, deliberately: **CUST-TRANSFER**, **CUST-LOSS** (approval queue/approver) and
**CUST-SERIAL** are in [worklist/parked.md](worklist/parked.md) with a reopen
trigger each. Do not build one without the policy — that was the explicit
instruction when the note was closed. Everything else parked there and in the
Round 15 note still stands.

Next candidate work: the field-capture remainders
([worklist/2026-11-19-field-capture/README.md](worklist/2026-11-19-field-capture/README.md)
— offline capture and the automatic follow-up into devices/invoices; the
proof-of-work gallery shipped 2026-11-24), or the subscription-billing plan
above.

## Running it (WSL, `/root/isp-live`)

- `.env` sets `PORT=3000`: `npm run dev` (`tsx watch server/index.ts`) answers
  on `http://127.0.0.1:3000`. Check `ss -ltnp | grep :3000` before starting a
  second one.
- Sign in as `superadmin@example.com` / `Demo@123`; the superadmin employee is
  `demo-emp-001`. A browser tab that shows `401`s on every read is holding a
  token from an earlier server run — sign in again; it is not a code defect.
- Redis is required by any production boot and is installed here:
  `systemctl start redis-server` if `systemctl is-active redis-server` says
  inactive, then `npm run check:redis` (PING, version, read/write round trip).
  The dev server picks it up from `.env`; without the variable it runs on the
  in-process store and says so only by the absence of the boot line
  `Shared state connected (Redis)`.
- Full suite is ~20–25 min. Run it detached and read the log:
  `setsid nohup bash -c 'cd /root/isp-live && node scripts/run_tests.mjs > /tmp/suite.log 2>&1; echo EXIT=$? >> /tmp/suite.log' &`
- `tsx watch` respawns children, so kill the watcher too, and only ever by
  identified PID (`kill <pid>`) — never by name pattern.

## Gates before calling anything done

`npx tsc --noEmit` · `node scripts/run_tests.mjs` (full suite at close) ·
`npm run build` · `npm run check:bundle-budget` when client code moved ·
`check:no-inline-sql`, `check:no-raw-dialogs`, `check:branch-predicates`,
`check:shard-plan`, and `npm run check:redis` before any production deploy.

Ceilings are **not** to be raised: entry 23.375 kB, startup 330 kB. Last
measured (2026-11-27): entry 23.3 kB, startup 324.5 kB. Nothing may be added
that needs the ceiling moved — pay for it by lazy-loading instead.

Counts that must move together when schema/tests/permissions change:
`tests/schema.drift.guard.test.ts` and `tests/schemaSource.parity.test.ts`
(schema.sql against the live database), `tests/docsTruth.guard.test.ts`
(153 top-level tables, quoted in `README.md`),
`tests/financeMicroPermissions.test.ts` (72 operations),
`tests/docsCounts.guard.test.ts` (2950 tests, quoted in README, handoff and
SESSION_NOTES), `tests/registerRefreshDomains.test.ts` (`SCREEN_SURFACE_PINS`
for any new screen — 124 feature screens: 113 in the table, 11 pinned
elsewhere).

## Working rules this session learned the hard way

- No guard or test deleted, skipped, weakened or made tautological. If a guard
  pinned the old owner of code that moved, repoint it to the new owner and keep
  the assertion — never loosen it.
- A source-level guard that pins a shape in `App.tsx` reads the file directly;
  after the route-table move they read `client/src/routes/screenRoutes.tsx`
  through `tests/harness/screenRouteSource.ts`. Change the owner, not the guard.
- Don't invent policy for open questions. Park it with a trigger, say so, and
  keep going.
- Prove behaviour, don't describe it: real HTTP + PostgreSQL tests for API work,
  and drive the dev app end to end before claiming a UI flow works.
- Commit per slice, push to `origin/main`, leave the tree clean and level.

## Demo-DB side effects from the last verification pass

`demo-emp-003`'s offboarding is `COMPLETED` and `pkr.manager@example.com` is
deactivated; `demo-emp-001`'s holdings net to zero with movement history kept.
That is expected state from proving the offboarding guard, not corruption.
