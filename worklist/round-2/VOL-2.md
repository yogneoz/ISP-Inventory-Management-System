# VOL-2 — take `salesInvoices` off the bootstrap

Status: `[x]` shipped (`0808470`) · Created 2026-10-26 ·
Finished 2026-10-26 · Client + server
Round: [Round 2](README.md) · Order: 3 · Depends on [VOL-1](VOL-1.md)

## Problem

The bootstrap loaded every sales invoice for the fiscal year/branch, with every
`items` line, for two consumers. At national volume (12k customers at 1×, 120k
at 10×, Nepal-wide) that is the whole invoice ledger on every login and full
refresh.

| Consumer | Old use | Delivered read |
|---|---|---|
| [ReturnsRegister](../../client/src/features/sales/ReturnsRegister.tsx) | `<select>` over every invoice, and `find` for the selected reference | `SearchPicker` over `GET /api/sales-invoices` — number or customer name, 20-result page |
| [SalesInvoices](../../client/src/features/sales/SalesInvoices.tsx) | fallback array when the paged fetch failed | that screen's own error + Retry; no full-array path |

`GET /api/sales-invoices` already supported `page`, `pageSize`, `query`,
`branchId`, `status` and an AD date range and returns the full row including
`items`; no new query was needed.

## Delivered

### Server

- `salesInvoices` left `fetchOperationalData` and the `/api/bootstrap`
  response. The payload no longer names the key.
- [columnMappings.ts](../../server/src/models/columnMappings.ts) keeps the
  mapping **only** so `CACHE_LOADS` can keep the operational cache hydrated
  (demo mode's invoice list, the duplicate-number pre-check, the post-write
  mirror refresh). Its comment now says so, matching `transactionLogs`.
- `/api/bootstrap/local?key=salesInvoices` still answers through the mapping
  for an older client, but no client domain asks for it.

### Client

- **Returns create form** — the sales kind renders the shared
  [SearchPicker](../../client/src/components/common/SearchPicker.tsx):
  `api.getSalesInvoices({ branchId, query, page: 1, pageSize: 20 })`, search by
  invoice number or customer name, rows show number / customer / date / total.
  Picking a row runs the same `applyInvoice` path as before: lines copied,
  product name/SKU/unit resolved, quantity capped at invoiced − already
  returned, serial requirement kept. Clearing the field clears the prefill.
  `refreshToken={sseRefreshKey}` re-runs an open search when `SALES` bumps.
- **Purchase kind is untouched** — its `<select>` still reads the
  `purchaseInvoices` slice at all four render sites.
- **SalesInvoices** — the `invoices` prop and the `let list = invoices`
  fallback are gone. `pageRows = siRows`, `totalItems = siTotalItems`, and a
  failed page keeps the rows already on screen with the existing
  `RegisterLoadError` + Retry.
- **App** — no `salesInvoices` state, bootstrap hydration, `SALES` slice key,
  or prop. `registerRefresh.salesInvoices` stays and still wires both screens.
- [BootstrapState](../../client/src/types/index.ts) and
  [bootstrapSlices](../../client/src/services/bootstrapSlices.ts) no longer
  declare a `salesInvoices` slice or label.

## Payload measurement

Measured 2026-10-26 with `.tmp-vol2-payload.ts` (throwaway; rows built in the
real bootstrap projection with two-to-four-line `items`, serialized and
gzipped as one array at the B1 benchmark's documented invoice counts):

| Volume model | Rows | Raw JSON removed | Gzip removed |
|---|---:|---:|---:|
| 1× (12k customers, 12k invoices/year) | 12,000 | 11.14 MB | 0.36 MB |
| 10× (120k customers, 120k invoices/year) | 120,000 | 111.57 MB | 3.57 MB |

Row cost: **929 B raw / 29.9 B gzip**. The array is gone, so the cost no longer
scales with the invoice ledger; the remaining bootstrap is unchanged in shape.

## Tests

Full suite: **1254 tests, 1252 pass, 0 fail, 2 Windows-only skips**.

- [returnsInvoicePicker.test.ts](../../tests/returnsInvoicePicker.test.ts) —
  source contract (bootstrap repo/controller, App state and props,
  BootstrapState, the returns form and the sales register) plus HTTP: seed eight
  invoices, prove the oldest is outside page 1, find it by number and by
  customer with its `items`, keep the legacy array shape, prove the bootstrap
  omits the key, and `401` without a token.
- [registerRefreshDomains.test.ts](../../tests/registerRefreshDomains.test.ts) —
  `ReturnsRegister`'s server surface now includes `getSalesInvoices`; the picker
  re-search token is pinned, and the screen may not take an invoice array.
- `appRouteTree`, `bootstrapSlices`, `bootstrapTrim` and the feature-screen
  pins stay green after the fixture/prop removal.

## Gates

- [x] `npx tsc --noEmit` clean.
- [x] Full `npm test`: **1254 tests, 1252 pass, 0 fail, 2 Windows-only
      skips**; the docs-count gate matched 1254.
- [x] `npm run build` clean; `check:bundle-budget` **313.2 kB** startup /
      **15.6 kB** entry (320 / 16).
- [x] `check:no-inline-sql` and `check:no-raw-dialogs` green.
- [x] Commit `0808470`; the hash is recorded in the round tracker.

## Acceptance

- [x] `/api/bootstrap` no longer contains `salesInvoices`.
- [x] A return can be created against an invoice outside the first page, found
      by number or customer; the prefill path is unchanged.
- [x] The Sales register still pages, filters and recovers from a failed fetch.
- [x] A sales SSE event refreshes the register and re-runs an open picker.
- [x] Payload before/after recorded; bundle budget checked.
- [x] Docs updated; commit `0808470`.

## Risks

| Risk | Mitigation |
|---|---|
| The picker cannot find an old invoice | Search is server-side on the invoice number; the HTTP test proves one outside page 1 |
| Line prefill differs from the old in-memory path | `applyInvoice` is the old mapping, reused verbatim; the row carries `items` |
| Purchase returns are affected | The purchase select and slice are untouched at all four sites |
| The Sales register loses its degraded mode | Rows already on screen stay; error + Retry is pinned |
| A hidden prop remains | Source-contract test over bootstrap, App and both screens |
