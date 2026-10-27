# CDR-2 — retire the customerDevices bootstrap slice

Status: `[~]` implemented (2026-10-27) · awaiting commit · Created 2026-10-27 · Estimate 1–1.5 h
Round: [Round 7](README.md) · Order: 1 · Depends on CDR-1 (done)

## Problem

`GET /api/bootstrap/local?key=customerDevices` is the last legacy device read
and the last path that answers a device request with the whole
`customer_device_records` table. CDR-1 retired the bounded bare-array route and
recorded this slice as its follow-up:

> `GET /api/bootstrap/local?key=customerDevices` still serves the whole table
> for an older bundle (unbounded — `fetchBootstrapSlice` applies no limit for
> this key). It is now the only legacy whole-table device read. Retiring it
> means splitting the operational-cache load from the slice mapping, so it is
> a separate item with its own verification, not a rider on this one.

The slice exists only for a cached pre-VOL-4b bundle. The current client never
asks for it: `DOMAIN_STATE_KEYS` maps no SSE domain to `customerDevices` (the
`SERIALS` entry is deliberately empty, and the registers re-read their paged
endpoints through `registerRefresh` counters).

The blocker is the shared mapping. `BOOTSTRAP_TABLES.customerDevices` drives
two surfaces:

- `fetchBootstrapSlice` — the `/api/bootstrap/local?key=` slice endpoint, and
- the operational cache — `CACHE_LOADS.customer_device_records` in
  `state/runtimeState.ts` builds its refresh query with
  `buildCacheSelectSql(BOOTSTRAP_TABLES.customerDevices)` and keeps
  `customerDeviceRecords` hydrated for the controllers that read the mirror
  (global search, the CPE/CDR flows, `assignedDevicesCount`, approval
  processing, goods-receipt serial checks, the serial-edit capture).

The cache needs the mapping; the slice must lose it. Splitting the mapping is
what lets the whole-table read be retired without dropping the mirror.

## The shape today (2026-10-27)

- The mapping has no `limit` (the register's own 200-row page cap lives in
  `GET /api/customer-devices/page`), so an unscoped request to the slice reads
  every row of the table; a scoped one reads every row of that branch.
- Branch scope is caller-supplied: the `/bootstrap` branch guard does not cover
  `/bootstrap/local`, and the slice's branch filter comes from the query
  string. Measured below: a branch account that omits `branchId` reads rows
  across branches, where the paged route refuses the same request with 403.
- Consumers of the mapping: the slice and the cache, and nothing else. The
  fan-out (`fetchOperationalData`) already stopped reading it in VOL-4b, and
  the current client asks for neither the slice nor the array.

## Measurement (2026-10-27)

Scratch rows inserted through the real table shape and read through the real
mapping (insert + read inside one transaction, rolled back), on the local demo
DB. The demo DB itself holds **0** `customer_device_records` rows, so the slice
volume model is the recorded VOL-4b national model — 1× = 12,000 devices,
10× = 120,000.

| Measure | Value |
|---|---|
| 12,000 rows through the mapping — response JSON | 5,414.2 KiB raw / **431.5 KiB gzip** |
| per row (raw / gzip) | 462.0 B / 36.8 B |
| 1× (12,000 rows) raw / gzip | 5.29 MiB / 431.5 KiB |
| 10× (120,000 rows) raw / gzip — modelled from the measured width | 52.87 MiB / 4.21 MiB |
| Cache query (same 16 columns, no scope) | 12,000 rows, 5,414.1 KiB raw / 431.5 KiB gzip — read server-side into the mirror, so it stays after retirement |
| Branch-account probe | **no `branchId` → 200 with all 12,000 rows across both branches**; own `branchId` → 200, that branch only; foreign `branchId` → 403 |

The 1×/10× figures land within the row-mix difference of the VOL-4b record
(4.68 MB / 435 kB at 1×; 46.95 MB / 4.05 MB at 10×), so the slice never shrank:
it has been serving the removed national array all along, one request per stale
bundle. The scratch rows were inserted and deleted in the same run (leftover
`cdr2-%` rows = 0); the demo DB itself holds 0 device rows. The probe shows the
wider problem with an unbounded legacy read: the branch guard covers
`/bootstrap`, not `/bootstrap/local`, so a branch account that *omits* the
branch filter reads the whole country (the paged route refuses that request
with 403, and a *forged* branch is refused here too — only the omission slips
through). Retirement removes the device case entirely.

## Steps

- [x] **1. Measure.** Scratch rows through the real mapping: slice JSON size at
  1×/10× raw and gzip, the cache query's size, and the branch-account probe
  (numbers above).
- [x] **2. Split the mapping.** Moved the `customer_device_records` config out of
  `BOOTSTRAP_TABLES` into the new `CACHE_ONLY_TABLES` export in
  `columnMappings.ts`; `CACHE_LOADS` builds its query from it.
  `fetchBootstrapSlice` looks only in `BOOTSTRAP_TABLES`, so the key stops
  resolving.
- [x] **3. Retire the slice.** The bootstrap controller answers
  `key=customerDevices` with 410 Gone (message naming the replacement reads,
  `sliceRetired: true`) before the generic slice path, and it is out of the 503
  fallback list.
- [x] **4. Tests.** The device off-bootstrap suite's slice test flips from 200
  to 410 (super and branch tokens); source guards assert the mapping is not in
  `BOOTSTRAP_TABLES`, is in `CACHE_ONLY_TABLES`, that `CACHE_LOADS` hydrates the
  mirror from it, and that the controller answers 410. The CACHE_LOADS parity
  guard covers both mapping objects and pins the split.
- [x] **5. Docs.** README register table, handoff (two spots) and the
  data-fetching audit stop saying the slice still answers an older bundle; the
  audit also carries the re-measured numbers.

## Acceptance

- `GET /api/bootstrap/local?key=customerDevices` answers the retired status —
  never a 200 with rows — for a super token and a branch token alike.
- `CACHE_LOADS` still loads the `customer_device_records` mirror from the
  cache-only mapping; the parity guard fails if the entry moves back into the
  slice surface or loses its load.
- The paged `/page`, `/overview`, `/warranty`, exchange and status-patch reads
  behave exactly as before; their existing tests pass unchanged.
- The current-state docs stop describing the slice as live.

## Verified locally (2026-10-27)

- `npx tsc --noEmit` clean.
- Targeted suites — `customerDevicesOffBootstrap`, `cacheLoads.parity`,
  `bootstrapTrim`, `bootstrapSlices` — **42 tests, 42 pass, 0 fail, 0 skipped**
  against a reachable PostgreSQL. The flipped HTTP test ran: the retired slice
  answers **410** for the super token and the branch token, carries no rows,
  and the paged register still answers; the sources guards and the parity
  assertions pass.
- `check:no-inline-sql` (16 controller files) and `check:no-raw-dialogs`
  (161 client files) green.
- Measurement evidence: the numbers and the probe result in the sections above;
  the scratch rows were deleted after the run (leftover = 0).
- Full `npm test` before the commit: **1354 tests, 321 suites, 1352 pass, 0
  fail, 2 Windows-only skips** in 338.2 s, docs-count gate green at 1354 — the
  whole chain exited 0. The commit and its CI run are recorded here when they
  exist (mark-shipped), and the round close follows.

## Out of scope

The `customers` slice and its own mapping split; client code (the current
client does not call the key); the `/api/bootstrap/local` branch-guard gap,
recorded as an observation — this item removes the device slice rather than
generalising the guard.
