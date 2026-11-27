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

Nothing is in progress. The last plan,
[worklist/2026-11-19-app-structure-and-employee-stock](worklist/2026-11-19-app-structure-and-employee-stock/README.md),
is `[x]` complete (2026-11-20). Last commits on `main` — **6 ahead of
`origin/main`, not pushed**:

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

Next candidate work, none started: the field-capture remainders
([worklist/2026-11-19-field-capture/README.md](worklist/2026-11-19-field-capture/README.md)
— offline capture, proof-of-work attachments, automatic follow-up into
devices/invoices).

## Running it (WSL, `/root/isp-live`)

- `.env` sets `PORT=3000`: `npm run dev` (`tsx watch server/index.ts`) answers
  on `http://127.0.0.1:3000`. Check `ss -ltnp | grep :3000` before starting a
  second one.
- Sign in as `superadmin@example.com` / `Demo@123`; the superadmin employee is
  `demo-emp-001`. A browser tab that shows `401`s on every read is holding a
  token from an earlier server run — sign in again; it is not a code defect.
- Full suite is ~20–25 min. Run it detached and read the log:
  `setsid nohup bash -c 'cd /root/isp-live && node scripts/run_tests.mjs > /tmp/suite.log 2>&1; echo EXIT=$? >> /tmp/suite.log' &`
- `tsx watch` respawns children, so kill the watcher too, and only ever by
  identified PID (`kill <pid>`) — never by name pattern.

## Gates before calling anything done

`npx tsc --noEmit` · `node scripts/run_tests.mjs` (full suite at close) ·
`npm run build` · `npm run check:bundle-budget` when client code moved ·
`check:no-inline-sql`, `check:no-raw-dialogs`, `check:branch-predicates`.

Ceilings are **not** to be raised: entry 23.375 kB, startup 330 kB. Last
measured: entry 22.6, startup 316.2. Nothing may be added that needs the ceiling
moved — pay for it by lazy-loading instead.

Counts that must move together when schema/tests/permissions change:
`tests/schema.drift.guard.test.ts` and `tests/schemaSource.parity.test.ts`
(137 tables), `tests/docsTruth.guard.test.ts` (129 top-level, quoted in
`README.md`), `tests/financeMicroPermissions.test.ts` (71 operations),
`tests/docsCounts.guard.test.ts` (2940 tests, quoted in README, handoff and
SESSION_NOTES), `tests/registerRefreshDomains.test.ts` (`SCREEN_SURFACE_PINS`
for any new screen, 121 screens in the docs).

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
