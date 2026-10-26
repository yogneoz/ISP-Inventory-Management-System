# VOL-1 — take `transactionLogs` off the bootstrap

Status: `[ ]` planned · Created 2026-10-26 · Estimate 3–5 days · Client + server
Round: [Round 2](README.md) · Order: 2

## Problem

`transactionLogs` is the bootstrap array that grows with every stock movement.
It is scoped only by fiscal year — **no branch filter** — in
[columnMappings.ts:375](../../server/src/models/columnMappings.ts#L375), and
`fetchTable` applies no cap unless a config asks for one
([bootstrap.repo.ts:75](../../server/src/models/bootstrap.repo.ts#L75)). At
national volume, every login and every full refresh downloads the whole year's
movement history.

Only three screens consume it:

| Consumer | Current use | Right read |
|---|---|---|
| [Dashboard](../../client/src/features/dashboard/Dashboard.tsx#L1137) | `slice(0, 8)` — eight recent rows | recent-activity read, branch-scoped |
| [AuditTrailReports](../../client/src/features/finance/AuditTrailReports.tsx#L68) | client pagination over the whole array; CSV export | server paging + scoped export |
| [StockMovementLedger](../../client/src/features/inventory/StockMovementLedger.tsx#L149) | merges transaction logs with stock operations and damage records, then pages | merged server paging (preferred) or a bounded documented window |

The server endpoint already exists and supports `branchId`, `productId` and
`limit` ([misc.repo.ts:86](../../server/src/models/misc.repo.ts#L86),
`GET /api/transaction-logs` in
[misc.routes.ts:27](../../server/src/routes/misc.routes.ts#L27)), but the client
has no API method for it and it has no page/date range.

## Steps

### Pre-flight

- [ ] List every `transactionLogs` prop route in `App.tsx` (Dashboard, Audit
      Trail, Stock Movement Ledger) and every refresh key that currently bumps
      those screens. Decide the screen-local refresh contract before touching
      the bootstrap.
- [ ] Add `getTransactionLogs({ branchId?, productId?, limit?, page?, pageSize?,
      dateFromAD?, dateToAD? })` to
      [api/inventory.ts](../../client/src/services/api/inventory.ts) and expose
      it on the `api` barrel. Keep the request shape in one place.

### VOL-1a — Dashboard recent activity

- [ ] Replace the `transactionLogs` prop with a screen-local read:
      `getTransactionLogs({ branchId, limit: 8 })`, with loading / error / retry
      states. Branch changes and the existing SSE keys must re-run it.
- [ ] Remove the Dashboard entry's `transactionLogs={...}` from
      [App.tsx](../../client/src/App.tsx) and add a contract test that the
      Dashboard no longer receives the array.
- [ ] Verify the recent list still shows the same eight rows in the same order
      for a seeded fixture.

### VOL-1b — Audit Trail server paging

- [ ] Extend `buildTransactionLogQuery` with `page`/`pageSize` and an optional
      AD date range; return the same envelope as the other paged registers
      (`{ data, page, pageSize, totalItems }`). Keep the legacy array response
      for existing callers without a page param, as `/api/sales-invoices` does.
- [ ] Switch the Stock Transactions table to the paged endpoint (15/page,
      filters preserved), with the same columns and ordering.
- [ ] Decide the CSV export: request `all=1` with a hard cap and a visible
      notice, or export only the current filter as a server-side stream. Do not
      silently export a truncated page.
- [ ] Keep the serial-focus search unchanged; it already reads from the server.

### VOL-1c — Stock Movement Ledger

- [ ] Decide between (a) a server-side merged ledger endpoint that unions
      transaction logs, stock operations and damage records with one ordering
      and one total, or (b) a bounded on-demand window (for example the current
      fiscal year, cap recorded) with an explicit UI notice. Prefer (a); record
      the reason if (b).
- [ ] Implement the chosen read and remove the prop. The bridge logic that
      deduplicates operation logs against transaction logs by `referenceDocId`
      must move to the server or be proven unnecessary; do not page three
      independently sorted lists in the browser and call it merged.
- [ ] Test ordering, deduplication, totals and the empty/error states.

### VOL-1d — Remove the slice

- [ ] Remove `transactionLogs` from `BOOTSTRAP_TABLES`,
      `fetchOperationalData`, the bootstrap response type, App state and every
      remaining prop.
- [ ] Remove it from the SSE slice lists and replace the refresh with the
      screen-local keys chosen in pre-flight.
- [ ] Add a guard test that `/api/bootstrap` does not contain
      `transactionLogs` and that no client file passes the array as a prop.
- [ ] Measure the bootstrap payload before/after at modelled 1× and 10×
      (row count and gzip bytes) and record it here.

### Close

- [ ] Update [architecture-backlog.md](../../docs/architecture-backlog.md) (A5
      note: this is the volume work, not the store) and one short SESSION_NOTES
      entry linking here.
- [ ] Gates: `npx tsc --noEmit`, the new HTTP/repo tests, the A6 route-tree test,
      full `npm test`, `check:no-inline-sql`, `check:no-raw-dialogs`, build and
      `check:bundle-budget`. Record the commit hash.

## Acceptance

- [ ] `/api/bootstrap` no longer contains `transactionLogs`.
- [ ] Dashboard shows the latest eight rows for the selected branch, with a
      retryable error state.
- [ ] Audit Trail pages, filters and exports exactly what it did before; an
      export is either complete or clearly capped.
- [ ] Stock Movement Ledger shows one correctly ordered, deduplicated sequence,
      with totals that match the old merged view for the same scope.
- [ ] SSE stock/serial/sale events still refresh the visible ledger without a
      full bootstrap.
- [ ] Payload before/after recorded at 1× and 10×; no client regression.
- [ ] Docs updated; commit hash recorded.

## Risks

| Risk | Mitigation |
|---|---|
| Merged ledger paging changes ordering or duplicates rows | Extract the current bridge rule into a server query and parity-test it against a seeded fixture |
| CSV export silently truncates | Explicit cap + notice, or a dedicated export path; test the row count |
| A hidden screen still reads the prop | Source-contract test for every `transactionLogs=` site; A6 route tree |
| SSE refresh silently stops updating the ledger | Drive a real event in a test and assert the screen's own read is re-issued |
| Endpoint grows a second unfiltered full read | Keep the legacy branch without a page param only for known callers; add `LIMIT` to it |
