# VOL-2 — take `salesInvoices` off the bootstrap

Status: `[ ]` planned · Created 2026-10-26 · Estimate 1–2 days · Client + server
Round: [Round 2](README.md) · Order: 3 · Depends on [VOL-1](VOL-1.md)

## Problem

The bootstrap still loads every sales invoice for the fiscal year/branch. The
customer ledger already reads its own scoped endpoint, and the Sales register
already pages from `/api/sales-invoices`. What remains is:

| Consumer | Current use | Right read |
|---|---|---|
| [ReturnsRegister](../../client/src/features/sales/ReturnsRegister.tsx#L449) | `<select>` over every invoice, and `find` for the selected reference | searchable invoice picker over the paged endpoint |
| [SalesInvoices](../../client/src/features/sales/SalesInvoices.tsx#L574) | fallback array when the paged fetch fails | the register's own error/retry state |

`GET /api/sales-invoices` already supports `page`, `pageSize`, `query`,
`branchId`, `status` and an AD date range, returns the full row including
`items`, and searches invoice number and customer name
([sales.repo.ts:42](../../server/src/models/sales.repo.ts#L42)). No new query is
needed.

## Steps

- [ ] **1. Replace the returns invoice dropdown with a searchable picker.**
      Reuse `SearchPicker` (the customer picker is the model). Search by invoice
      number or customer name through `api.getSalesInvoices({ branchId, query,
      page: 1, pageSize: 20 })`; show the invoice number, customer and date.
- [ ] **2. Keep the prefill rule identical.** Selecting an invoice must run the
      same `pickInvoice` path as today: find the invoice, copy its lines into
      the form, resolve product names/SKUs and per-line max quantities, and keep
      the "already returned" checks. The picker returns the full row (including
      `items`), so no second fetch is needed; if the row shape is partial, add a
      single-invoice read rather than widening the page size.
- [ ] **3. Handle the purchase kind.** ReturnsRegister serves both kinds. The
      purchase routes currently pass both arrays but only use
      `purchaseInvoices`; make `salesInvoices` optional/removed for the sales
      kind and leave the purchase slice for a later VOL-3. Do not change
      purchase-return behaviour in this slice.
- [ ] **4. Remove the Sales register fallback.** On a fetch failure,
      [SalesInvoices](../../client/src/features/sales/SalesInvoices.tsx#L574)
      currently filters the prop array. Delete that branch and keep the existing
      error notice + Retry; the fallback is the last consumer of the full array
      there.
- [ ] **5. Remove the slice.** Remove `salesInvoices` from `BOOTSTRAP_TABLES`,
      `fetchOperationalData`, the bootstrap response type, App state and the
      eight `salesInvoices={...}` prop sites. Keep the
      `registerRefresh.salesInvoices` counter — SSE invalidation does not need
      the array.
- [ ] **6. SSE behaviour.** Remove `salesInvoices` from the `SALES` domain's
      slice list; the Sales register and the returns picker must refresh through
      their own counters/activation keys. Drive a sales event in a test and
      assert the screen re-reads.
- [ ] **7. Tests and measurement.** Add an HTTP test that searches for an old
      invoice by number (one outside the first page) and gets it back with its
      lines; a contract test for no `salesInvoices` bootstrap key/prop; the A6
      route-tree test. Measure the bootstrap payload before/after at 1× and 10×
      and record it here.
- [ ] **8. Docs and gates.** Update the architecture backlog (A5/volume note)
      and SESSION_NOTES; run `npx tsc --noEmit`, the new tests, full `npm test`,
      no-inline-SQL/no-raw-dialogs, build and bundle budget. Record the commit.

## Acceptance

- [ ] `/api/bootstrap` no longer contains `salesInvoices`.
- [ ] A return can be created against an invoice outside the first page, found
      by number or customer; lines, max quantities and already-returned checks
      match the old behaviour.
- [ ] The Sales register still pages, filters and recovers from a failed fetch.
- [ ] A sales SSE event refreshes the visible register and returns picker.
- [ ] Payload before/after recorded; no bundle-budget breach.
- [ ] Docs updated; commit hash recorded.

## Risks

| Risk | Mitigation |
|---|---|
| The picker cannot find an old invoice | Search is server-side on the invoice number; test one outside the first page |
| Line prefill differs from the old in-memory path | Reuse `pickInvoice`; parity-test a multi-line invoice with a prior return |
| Purchase returns are affected | Keep the purchase slice and paths untouched; sales kind only |
| The Sales register loses its degraded mode | Error state + Retry already exists; test the failure path |
| A hidden prop remains | Source-contract test over all `salesInvoices=` sites |
