# EXCH-1 — the exchange picker searches the paged device read

Status: `[x]` done (2026-10-27) · Created 2026-10-27 · Estimate 0.5–1 day
Round: [Round 4](README.md) · Order: 2 · Depends on ASSET-1

## Problem

The Device Exchange tab is the last consumer of the bounded legacy
`GET /api/customer-devices` array. Its store
([exchangeDeviceCache.ts](../../client/src/services/exchangeDeviceCache.ts))
fetches the bare array — capped at the 2,000 newest rows for the branch — and
the panel filters it in the browser with `exchangeSearchQuery`.

- A branch with more than 2,000 deployed units cannot exchange an older one:
  it simply is not in the array.
- A global (`ALL`) view only ever sees the newest 2,000 rows company-wide.
- The paged read (`/api/customer-devices/page`), its indexed search, exact
  overview counts and branch scoping already exist (VOL-4b); only this consumer
  was left on the legacy shape.

## Steps

- [x] **1. Search on the server.** `exchangeDevicesStore` fetches
  `/api/customer-devices/page` with the header branch, the typed term and a
  50-row page plus the exact matching total; the host owns the term, the read
  is debounced (250 ms) and each term is its own cache scope, released when the
  input moves on.
- [x] **2. Keep the picker's contract.** The selected row is still the
  `CustomerDeviceRecord` the server returned (`CDR_SELECT_COLUMNS`, the same row
  shape as before); the refusal path, retry, loading and error states and the
  SSE/refresh invalidation stay as they are. The previous page of the same
  branch stays on screen while a new term loads; a branch switch or a failed
  read shows nothing.
- [x] **3. Delete the legacy read from this surface.** No screen calls
  `api.getCustomerDevices`; the bare endpoint stays only for an older bundle
  and `/api/bootstrap/local?key=customerDevices`.
- [x] **4. Gates.** `tsc`; the exchange/store suite, the device-page contract
  test, the refusal-audit suite, the refresh-domain guard and the picker-load
  schedule 83/83 pass; full `npm test` 1344 tests (1342 pass, 0 fail, 2
  Windows-only skips), docs-count gate 1344; `no-inline-sql`;
  `no-raw-dialogs`; build; bundle budget 15.7 kB entry / 281.2 kB startup
  (17 / 320 kB).

**Landed** as `3d7afe4` and pushed to `main`; CI run
[40456200247](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40456200247)
(`typecheck-and-test`) green in 373 s — every step from the fresh-install proof
to the bundle-budget and `npm audit` gates passed. The separate watch-list
measurement commit `0391816` was pushed in the same go, so this run is the green
history for both.

## Acceptance

- [x] A device outside the newest 2,000 rows is findable and exchangeable from
  the picker.
- [x] No client screen holds or filters the whole device array.
- [x] The picker still refuses a replacement that is not an IN_STOCK unit of the
  same branch and product, and still reports refusals to the audit endpoint.
- [x] Refresh/retry/error behaviour and branch scoping are unchanged.

## Risks

| Risk | Mitigation |
|---|---|
| A debounced picker issues a request per keystroke | Reuse the shared debounce pattern; keep the previous page while the next loads |
| The exchange submit assumes the old array's fields | The paged endpoint returns the same row shape (`CDR_SELECT_COLUMNS`) |
| A branch scope is lost while typing | The store keeps the branch scope key and discards superseded responses, as today |

## Measurement

One device row serializes to **549 B** (15 columns, `CDR_SELECT_COLUMNS`),
measured on scratch rows inserted and rolled back on the local demo DB. The
legacy picker read carried up to the 2,000-row cap, ≈ **1.05 MiB** per branch,
while the paged read carries 50 rows, ≈ **26.8 KiB** — and, more to the point,
the searched page can return a unit the cap dropped entirely (the store suite
pins a term that finds a row outside page 1 of a 4,700-row matching set).
