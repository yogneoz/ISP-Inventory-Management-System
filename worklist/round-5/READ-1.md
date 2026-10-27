# READ-1 — delete the orphaned bare-array device read

Status: `[x]` done (2026-10-27) · `8cdd09b` · CI run 174 success · Created 2026-10-27 · Estimate 0.5–1 h
Round: [Round 5](README.md) · Order: 1 · Depends on —

## Problem

EXCH-1 moved the Device Exchange picker to `GET /api/customer-devices/page`
and, in doing so, removed the last consumer of the bounded bare-array read.
What is left behind is dead:

- `getCustomerDevices` in
  [services/api/inventory.ts](../../client/src/services/api/inventory.ts#L423)
  — a wrapper around `GET /api/customer-devices`, capped server-side at the
  2,000 newest rows.
- Its entry in the `api` surface,
  [services/api/index.ts](../../client/src/services/api/index.ts#L172).
- A stub for it in
  [tests/harness/appRouteTreeProbe.tsx](../../tests/harness/appRouteTreeProbe.tsx#L121),
  which now documents a method the app does not have.

A dead reader of a bounded array is a live trap: the next screen that wants
"all devices" will find it, call it, and silently get a page-sized answer that
looks complete — the exact failure EXCH-1 was opened to fix. The paged,
export, overview, warranty and lookup reads all remain; nothing this round
removes is part of the register's working path.

## Steps

- [x] **1. Remove the client dead path.** Delete the `getCustomerDevices`
  wrapper and its `api` index entry. Keep `customerDeviceQueryString` — the
  overview, warranty, page and export reads all use it.
- [x] **2. Drop the stale harness stub** so the fake `api` mirrors the real
  surface.
- [x] **3. Pin it.** Extend the existing "no client screen calls the legacy
  bare-array read" guard in
  [tests/exchangeDevices.test.ts](../../tests/exchangeDevices.test.ts) so it
  also fails if the wrapper or the `api` entry is restored, not only if a screen
  calls it. Also tightened the device-register source guard in
  [customerDevicesOffBootstrap.test.ts](../../tests/customerDevicesOffBootstrap.test.ts)
  so a register must read a *paged* device read (the bare name is no longer an
  accepted alternative).
- [x] **4. Decide the server route: keep it.** `GET /api/customer-devices`
  stays. It is now unreachable from this bundle, but it is still the endpoint an
  older deployed client can call, and deleting a live route is a deployment
  decision, not a cleanup: this item removed the client's dead limb only. If a
  future round confirms no older bundle is in use, removing the route (and its
  2,000-row cap query) is its own small item.
- [x] **5. Gates.** `tsc` clean; exchange/store + device-register + route-tree
  suites 32/32; full `npm test` **1345 tests, 1343 pass, 0 fail, 2 Windows-only
  skips** (320 suites, 352 s) with the docs-count gate green at 1345;
  `check:no-inline-sql` (16 controllers); `check:no-raw-dialogs` (160 client
  files); production build clean; bundle budget unchanged at 15.7 kB entry /
  281.2 kB startup of 17/320.

## Acceptance

- No client module exports or maps a bare-array device read; the guard fails if
  one returns. **Checked** — the API-surface test and the source walk both pass,
  and a repo-wide grep finds the name only inside those guards.
- Every screen that reads devices still reads page/export/overview/warranty —
  unchanged behaviour. **Checked** — no screen source changed; the register and
  route-tree suites pass untouched.
- The server `GET /api/customer-devices` route is either kept with a recorded
  reason or removed with its test coverage updated — the note says which.
  **Kept, with the reason in step 4.**

## Shipped

`8cdd09b` (2026-10-27), pushed to `main`; CI run 174 finished green in 376 s
(40469380167) with every step passing — fresh-install proof and schema parity,
`tsc`, the full 1345-test suite, both convention guards, build, bundle budget
and `npm audit`.

## Out of scope

The other legacy arrays (`/api/shipments` for the closing wizard, `/api/stock`)
are intentional and have live consumers; this item removes one dead client
path, not a general endpoint purge.
