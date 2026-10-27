# CDR-1 — retire the legacy bare-array device route

Status: `[x]` done (2026-10-27) · `c147d99` · CI run 180 success · Created 2026-10-27 · Estimate 0.5–1 h
Round: [Round 6](README.md) · Order: 1 · Depends on READ-1 (done)

## Problem

`GET /api/customer-devices` is the bounded (2,000 newest rows) bare-array read
left behind when VOL-4b paginated the register. EXCH-1 moved its last screen —
the Device Exchange picker — to `GET /api/customer-devices/page`, and READ-1
deleted the client wrapper, its `api` entry and the harness stub, with a guard
that fails if any of them returns. The server route stayed on purpose: an older
deployed bundle might still call it, and deleting a live endpoint is a
deployment decision.

It is now unreachable from this bundle and it is the one endpoint that answers a
device request with an array instead of a page. That is the trap READ-1 closed on
the client, still open on the server: a future consumer that asks for "all
devices" gets a 2,000-row answer that looks complete. It also keeps a test that
asserts the array *does* answer, so a stale read still looks supported.

## The deployment fact, recorded

The condition READ-1 attached was "once no older deployed bundle can be calling
it". The client and the server are built and served from one deploy
(`npm run build` → `dist/`, served by the same process), so the only remaining
caller is a browser tab holding a cached pre-EXCH-1 bundle while the server has
already been updated. Such a tab loses the Device Exchange picker's array read
with a 404; every current screen is unaffected, and a reload gets the paged
read. This item accepts that, because the repo cannot prove the deployment fact
and the alternative is leaving a whole-table read alive indefinitely for a tab
that is already running code nobody supports.

Boundary kept deliberately: `GET /api/bootstrap/local?key=customerDevices`
still answers an older bundle, and the same `BOOTSTRAP_TABLES` mapping feeds the
operational cache, so retiring that needs the cache mapping separated from the
slice mapping. It is recorded below as a follow-up, not folded in.

## Steps

- [x] **1. Remove the route.** `app.get('/api/customer-devices', ...)` and its
  `get_customerDevices` import are gone from
  [inventory.routes.ts](../../server/src/routes/inventory.routes.ts). The
  `/customer-devices` branch-guard prefix, the `/customer-devices/:id` resource
  check and every `/page`, `/overview`, `/warranty`, `/exchange` route stay.
- [x] **2. Remove the handler and the SQL it was the only user of.**
  `get_customerDevices` in
  [inventory.controller.ts](../../server/src/controllers/inventory.controller.ts),
  plus the stale "Forwarded from inventory.routes.ts" comment; the two unused
  builder imports go with it. In
  [inventory.repo.ts](../../server/src/models/inventory.repo.ts),
  `buildCustomerDeviceLegacyListQuery` and its positional wrapper
  `buildCustomerDeviceListQuery` are deleted, and the shared-WHERE comment no
  longer claims a legacy reader. `buildCustomerDeviceWhere`, the mirror filter
  and every paged builder stay: the page, export, overview and warranty reads
  all use them.
- [x] **3. Replace the coverage.** The HTTP test that asserted the array
  "still answers, bounded and scoped" becomes a 404 assertion (scoped request,
  super and branch tokens), and a source guard fails if the route, the handler
  or the legacy builder is restored. The repo-suite test for the positional
  wrapper is deleted with the wrapper.
- [x] **4. Current-state docs.** The README endpoint table, the handoff route
  table and its EXCH-1 paragraph, and the data-fetching audit's Device Exchange
  row no longer describe the route as live.
- [x] **5. Gates.** `tsc`, the device/inventory/exchange suites and both
  convention guards pass (numbers below); the full suite is the ship gate.

## Verification (2026-10-27)

- `npx tsc --noEmit` clean.
- `tests/customerDevicesOffBootstrap.test.ts` + `tests/inventory.repo.test.ts`:
  **76 tests, 76 pass, 0 fail, 0 skipped** against a reachable PostgreSQL. Both
  new checks ran: the source guard (route, handler and legacy builder all
  absent) and the HTTP test — `GET /api/customer-devices?branchId=…` answers
  **404** for the super and the branch token, while `/page` still answers 200
  with the 6 fixture rows.
- `tests/exchangeDevices.test.ts` + `tests/exchange.concurrency.test.ts`:
  **21 tests, 21 pass, 0 fail** — the client guard, the exchange lookup route
  and the request-shape assertions are untouched.
- `check:no-inline-sql`: 16 controller files clean; `check:no-raw-dialogs`:
  161 client files clean.
- No client source changed, so the bundle is unchanged and the bundle-budget
  gate is not required.
- Full `npm test` before the commit: **1354 tests, 321 suites, 1352 pass, 0
  fail, 2 Windows-only skips** in 342.6 s, docs-count gate green at 1354, both
  convention guards green — the whole chain exited 0.

## Shipped

`c147d99` (2026-10-27), pushed to `main`; CI run 180 finished green in 355 s
(40492383983) with every step passing — fresh-install proof and schema parity,
`tsc`, the full 1354-test suite, both convention guards, build, bundle budget
and `npm audit`.

## Acceptance

- No route matches `GET /api/customer-devices`; a scoped request answers 404,
  and a restored registration fails the guard.
- `GET /api/customer-devices/page`, `/overview`, `/warranty`, the exchange
  routes, the branch guard and the status patch behave exactly as before; their
  existing tests pass unchanged.
- No code references `get_customerDevices` (singular),
  `buildCustomerDeviceLegacyListQuery` or `buildCustomerDeviceListQuery`; a
  repo-wide grep finds none outside this note.
- The current-state docs stop claiming the route is kept for an older bundle.

## Follow-up recorded, not done

`GET /api/bootstrap/local?key=customerDevices` still serves the whole table for
an older bundle (unbounded — `fetchBootstrapSlice` applies no limit for this
key). It is now the only legacy whole-table device read. Retiring it means
splitting the operational-cache load from the slice mapping, so it is a separate
item with its own verification, not a rider on this one.

## Out of scope

The paged reads, the exchange lifecycle, the serial register and any client
code. This item deletes a server path nothing in this bundle calls.
