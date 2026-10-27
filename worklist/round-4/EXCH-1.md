# EXCH-1 — the exchange picker searches the paged device read

Status: `[ ]` not started · Created 2026-10-27 · Estimate 0.5–1 day
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

- [ ] **1. Search on the server.** `exchangeDevicesStore` fetches
  `/api/customer-devices/page` with the header branch, the typed term and a
  stable page size; a debounced query replaces the client-side filter.
- [ ] **2. Keep the picker's contract.** The selected row is still the
  `CustomerDeviceRecord` the server returned (the exchange submit needs its
  serial/product/branch); the refusal path, retry, loading and error states and
  the SSE/refresh invalidation stay as they are.
- [ ] **3. Delete the legacy read from this surface.** No screen calls
  `api.getCustomerDevices`; the bare endpoint stays only for an older bundle
  and `/api/bootstrap/local?key=customerDevices`.
- [ ] **4. Gates.** `tsc`, the exchange/store suites, the device-page contract
  test, full `npm test`, guards, build and bundle budget.

## Acceptance

- [ ] A device outside the newest 2,000 rows is findable and exchangeable from
  the picker.
- [ ] No client screen holds or filters the whole device array.
- [ ] The picker still refuses a replacement that is not an IN_STOCK unit of the
  same branch and product, and still reports refusals to the audit endpoint.
- [ ] Refresh/retry/error behaviour and branch scoping are unchanged.

## Risks

| Risk | Mitigation |
|---|---|
| A debounced picker issues a request per keystroke | Reuse the shared debounce pattern; keep the previous page while the next loads |
| The exchange submit assumes the old array's fields | The paged endpoint returns the same row shape (`CDR_SELECT_COLUMNS`) |
| A branch scope is lost while typing | The store keeps the branch scope key and discards superseded responses, as today |
