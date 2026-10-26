# VOL-4a — customers leave the bootstrap; the pickers own their search

Status: `[x]` done (2026-10-26) · Created 2026-10-26 · Estimate 2–3 days
Round: [Round 3](README.md) · Order: 3 · Depends on VOL-3

## Problem

`customer_records` is the largest master table in the product and the one that
grows the fastest with the business: the demo set models 12k customers at 1× and
the national target is 120k+ across every ward of Nepal. It is still shipped
whole on every login:

- `fetchOperationalData` selects every customer row for the scope, with no cap,
  and `GET /api/bootstrap` serialises the whole array.
- Every screen that needs **one** customer holds all of them: the sale form
  resolves its selected customer with `customers.find(...)`, the stock-out panel
  defaults to `customers[0]` and resolves the picked one the same way, the asset
  assignment panel falls back to a `find`, and the demo-clear screen only wants a
  count.
- The pickers already search the server (`api.searchCustomers` →
  `GET /api/customers?query=…&pageSize=20`), so the array is pure legacy weight
  on the paths that do not need it.

Two problems that only surface at national volume sit behind that:

1. **The search is not index-backed.** `buildCustomerListWhere` ORs six
   `LOWER(col) LIKE '%term%'` predicates over `customer_records`, and the only
   indexes on the table are `customer_id`, `branch_id`, `contact_number` and the
   demo partial. Every debounced keystroke is a sequential scan of the whole
   directory — fine at 12k, not at 120k with a dozen branches typing at once.
2. **The picker never names a branch — and the guard refuses it.** The route
   guard (`enforceBranchAccess`) already answers **403** to a branch-scoped
   `/api/customers` GET that does not name one of the account's branches; only
   `SUPER_ADMIN`/`HEAD_OFFICE_ADMIN` may omit it. But `api.searchCustomers`
   never sent a branch, so for every branch user the shared picker has been
   showing "Could not search the customer directory" — a pre-existing bug that
   VOL-4a makes total, because the picker becomes the only way to choose a
   customer. The controller, meanwhile, trusts the query string and applies no
   scope of its own.

## Scope

Customers only. `customerDevices` stays on the bootstrap until VOL-4b, and the
pickers keep the shared `SearchPicker`/`CustomerPicker` mechanics — this item
changes *where the rows come from*, not how the controls behave.

## Steps

- [x] **1. Scoped reads, one place each.** The route guard keeps its rule (a
      branch role must name a branch it owns; forging one is a `403`), and the
      controller now also resolves the session's allowed branches and applies
      them in SQL (`branch_id = ANY(...)`) as defense-in-depth, with the demo
      mirror matching. On the client, `searchCustomers` sends the shell's
      active branch (`setActiveBranchContext` mirrors `ScopeContext`, falling
      back to the account's own branch), so a branch-role picker works instead
      of 403-ing.
- [x] **2. Index the search.** One GIN trigram index over the same six searchable
      columns concatenated and lower-cased (the pattern `products`,
      `fixed_assets`, `customer_device_records` and `shipments` already use),
      and the WHERE clause rewritten to that expression so the planner can use
      it. Plus a `(branch_id, customer_name, customer_id)` btree for the stable
      name-ordered page.
- [x] **3. Remove from bootstrap.** No `customers` in `GET /api/bootstrap`, no
      `fetchTable(...customers)` in the fan-out. `BOOTSTRAP_TABLES.customers`
      stays so an older client's `/api/bootstrap/local?key=customers` still
      answers and the operational cache keeps the demo mirror hydrated; a failed
      live read answers an honest `503`, not an empty ledger.
- [x] **4. Selected-record ownership.** `SalesInvoices` and `ProductSalePanel`
      keep the `CustomerRecord` the picker returned and use it for the label and
      the submit payload. No screen resolves a customer out of a full array.
- [x] **5. No default customer.** The stock-out panel currently pre-selects
      `customers[0]` — an arbitrary first row that would silently bill the wrong
      person if the operator does not touch the field. It starts empty and
      requires a pick, matching the sales form.
- [x] **6. Count without the array.** `ClearDemoDataView` reads its customer
      count from the paged aggregate (`page=1&pageSize=1` → `totalItems`), and
      the unused `customers` prop on `AssetDeployments` goes away.
- [x] **7. Gates and measurement.** `tsc`, targeted suites, full `npm test`,
      convention guards, build, bundle budget; a 1×/10× measurement of the
      removed payload and of the scoped search.

## Measurement (2026-10-26)

A throwaway benchmark (`.tmp-vol4a-bench.ts`, removed after the run) built a
TEMP `customer_records`-shaped table with a Nepali name, ward-level address,
phone, username and email per row — 20 first names × 20 surnames, 14 branches,
1-in-11 inactive — then read it three ways: the way the old bootstrap fan-out
did (every row, every column, optionally branch-scoped), the way a picker
keystroke does before/after the trigram index, and the count-only read the
demo-clear card uses.

| Volume | Rows | Scope | Old payload (JSON) | Old payload (gzip) | Old read | Picker (no index) | Picker (trigram) | Count-only |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| 1× | 12,000 | one branch (857) | 0.24 MB | 20 kB | 8 ms | 46 ms | **5 ms** | 11 ms |
| 1× | 12,000 | national (all) | **3.34 MB** | **284 kB** | 71 ms | — | — | — |
| 10× | 120,000 | one branch (8,571) | 2.41 MB | 192 kB | 87 ms | 406 ms | **32 ms** | 99 ms |
| 10× | 120,000 | national (all) | **33.72 MB** | **2.84 MB** | 653 ms | — | — | — |

`EXPLAIN` confirms the plan the index is there for at both volumes:
`Bitmap Index Scan on …trgm` → `Bitmap Heap Scan` → `Sort` (name, code) →
`Limit`. Without it the same 20-row read is a sequential scan plus a sort of
every match: **13× slower at 120k** (406 ms → 32 ms), and it is paid on every
debounced keystroke.

The national figures are the ones that mattered: a head-office login used to
materialise **33.7 MB / 2.84 MB gzipped** of customer JSON and hold 120,000
objects in the browser before the first render, on every login. It now reads
none of them until someone types in a picker, and then at most 20.

## Found while implementing

The picker had been broken for branch roles (see Problem 2): omitting
`branchId` is a 403, not "all my branches". That is now pinned by
`tests/customersOffBootstrap.test.ts` — an unscoped branch read is refused, an
owned branch is honoured, a forged one is refused, and a multi-branch account
reads each branch it names.

## Acceptance

- [x] `/api/bootstrap` has no `customers` key and the fan-out does not read the
      table.
- [x] No client screen holds or searches the whole directory; every customer
      choice goes through the paged search.
- [x] A customer outside page 1 is selectable from a picker.
- [x] A branch account cannot read another branch's customers, by omission or by
      a forged `branchId`.
- [x] The search uses the trigram index (`EXPLAIN` shows a bitmap index scan) at
      12k and 120k rows.
- [x] The stock-out panel cannot be submitted without an explicit customer.
- [x] `GET /api/bootstrap/local?key=customers` still answers for older clients.

## Gates (2026-10-26)

- `npx tsc --noEmit` clean.
- 72 targeted tests pass (`customersOffBootstrap`, `customerPicker`,
  `directoryPickers`, `masterdata.repo`, `bootstrapSlices`, `bootstrapTrim`).
- Full `npm test`: **1299 tests, 1297 pass, 0 fail, 2 Windows-only skips**;
  docs-count gate green after the README/handoff/notes update.
- `npm run check:no-inline-sql` and `npm run check:no-raw-dialogs` green.
- `npm run build` clean; bundle budget **279.9 kB / 15.8 kB** (320 / 17).

**Landed** as `d2c017f` and pushed to `main`; CI run
[40331014556](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40331014556)
(`typecheck-and-test`) green in 363 s. The note and run record landed in
`0a133b3` ([run 40332106964](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40332106964), 372 s).

## Risks

| Risk | Mitigation |
|---|---|
| A screen reads more of the directory than the grep shows | A source guard asserts no `.find/.filter/.map` over a `customers` array prop and no `customers=` bootstrap prop |
| Concatenated search matches across a field boundary | Same expression the other registers use; the term is still a substring of one record's text |
| Trigram index is ignored by the planner | `EXPLAIN` in the measurement proves the bitmap scan at both volumes |
| A branch account loses legitimate cross-branch search | `allowedBranchIds` is included in the scope, exactly like the movement ledger |
| Demo mode drifts from SQL | The mirror applies the same scope/search/paging rules; tested |
| A branch user's picker 403s instead of searching | `searchCustomers` now names the active branch; `getActiveBranchId` falls back to the account branch when the shell is still on `ALL` |
| A picker with no explicit branch for a global user reads nationally | Intended: a global scope means every branch, and the search is index-backed and capped at 20 |
