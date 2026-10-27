# Round 4 — the last customer-scale array

Created 2026-10-27 · Status: `[~]` in progress · Previous round:
[done/2026-10-27-round-3.md](../done/2026-10-27-round-3.md)

## Why this round

Rounds 2–3 took `transactionLogs`, `salesInvoices`, `shipments`, `customers`
and `customerDevices` off the login payload. Two recorded gaps remain:

- **`fixed_assets` still ships whole on every login.** The bootstrap reads it
  branch-scoped with **no cap and no fiscal-year filter** (29 aliased columns)
  into `assets`, and App hands that same array to 19 screens — the dashboard,
  both asset registers, financial statements, the depreciation register and the
  stock-operation panels. Each capitalized unit gets a row (the asset upsert and
  the CPE lifecycle create them) and rows persist for the life of the business,
  so this is the last array that grows with the installed base and the country.
- **The Device Exchange picker still reads a bounded legacy array.** Its store
  asks the bare `/api/customer-devices` endpoint (2,000 newest rows) and filters
  in the browser, so a branch — or a global view — above that cap cannot reach
  older deployed units. The paged endpoint and its trigram index already exist.

See [../parked.md](../parked.md): A5, A4b, B3, B4 and C4 stay parked with their
recorded triggers; none is reopened by this round.

## Schedule

| Order | ID | Task | Status | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | [ASSET-1](ASSET-1.md) | Take `fixed_assets` off the bootstrap (paged reads, server aggregates, panel lookups) | `[x]` done (`3efd446`) | 3–5 days | — |
| 2 | [EXCH-1](EXCH-1.md) | Device Exchange picker searches the paged device read | `[x]` done (`3d7afe4`) | 0.5–1 day | ASSET-1 (shared picker/paging pattern) |

**Total:** about one week. ASSET-1 is the scale item; EXCH-1 is the only
recorded Round 3 follow-up and can land after it without touching the same code.

## Order and stop points

1. **ASSET-1 stage A — server reads.** Share the depreciation rule, add the
   paged/overview/available/lookup reads with their demo mirrors and indexes,
   and prove them with tests. Stop: endpoints answer at 1× and 10×; no client
   behaviour has changed yet.
2. **ASSET-1 stage B — registers.** Move the Fixed Asset Register, Asset
   Deployments and Depreciation Register to server reads. Stop: each register
   pages/filters server-side and a row outside page 1 is reachable.
3. **ASSET-1 stage C — aggregates and panels.** Dashboard, Financial
   Statements, the FY closing wizard and the stock-op panels read the overview
   / available / lookup reads; the App stops holding `assets`.
4. **ASSET-1 stage D — remove the slice.** No `assets` in `/api/bootstrap`,
   no reader in the fan-out, the mapping kept for older bundles, docs and the
   1×/10× measurement recorded.
5. **EXCH-1** — the exchange picker moves to server search; the legacy array
   loses its last consumer.
6. **Round close** — full gates, archive this folder under `done/`, update the
   indexes and the session notes.

Do not remove `assets` from the bootstrap before stages B and C are green:
unlike a new endpoint, that change breaks every one of the 19 consumers at once.

## Gates for this round

- `npx tsc --noEmit`
- Targeted tests per stage, plus the full `npm test` at round close
- `npm run check:no-inline-sql` and `npm run check:no-raw-dialogs`
- `npm run build` and `npm run check:bundle-budget` for any client change
- A recorded 1×/10× measurement: payload removed, page/overview/available
  timings, and the depreciation/statement parity fixture

## Out of scope

A5, A4b, B3, B4 and C4 stay parked. `inventory_stock`, `damageRecords` and the
return arrays are watch items only — measure before opening one.
