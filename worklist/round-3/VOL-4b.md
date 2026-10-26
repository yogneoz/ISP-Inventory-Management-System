# VOL-4b — customer devices leave the bootstrap; the register pages

Status: `[x]` done · Created 2026-10-26 · Estimate 3–5 days
Round: [Round 3](README.md) · Order: 4 · Depends on VOL-4a

## Problem

`customer_device_records` is the last customer-scale table shipped whole on
every login. One row per rented/deployed CPE (and one per exchange), so it
grows with the customer base: 12k rows at the modelled 1×, 120k+ nationally.

- `fetchOperationalData` selects every device row for the scope with no cap,
  and `GET /api/bootstrap` serialises the whole array.
- The register ([CustomersManagement](../../client/src/features/sales/CustomersManagement.tsx))
  already self-fetches `GET /api/customer-devices`, but that endpoint returns a
  bare array and the screen paginates the filtered copy in the browser — so the
  server still transfers every match on each search keystroke.
- Seven other surfaces hold the same array for one lookup or count:
  the customer directory's assigned-hardware column and "tracked serials" KPI,
  the warranty directory, the export screen, the stock-operation exchange /
  assign panels (legacy fallbacks), the create-shipment form (legacy serial
  fallback), the shell prop, and the clear-demo record total.
- The search (`buildCustomerDeviceListQuery`) ORs six `LOWER(col) LIKE`
  predicates. The trigram index the global search added
  (`idx_customer_devices_global_trgm`) covers a concatenation of those columns,
  so the register's search never used it.

## Scope

`customer_device_records` only. The CPE write paths (create, status change,
exchange, deploy-from-stock, serial mirror) are untouched: they already run in
transactions and update `customer_records.assigned_devices_count`.

## Steps

- [x] **1. Paged reads in one place.** `GET /api/customer-devices/page` returns
      `{ data, page, pageSize, totalItems }` with branch, status, text,
      product and issued-date filters; `pageSize` capped at 200 and the order
      stable (`created_at DESC, id DESC`). `GET /api/customer-devices/overview`
      returns exact per-status counts plus the total under the same filters.
      `GET /api/customer-devices` keeps its bare-array contract for an older
      bundle, now bounded and scoped.
- [x] **2. Scope is a server decision.** The route guard keeps its rule; the
      controller also resolves the session's allowed branches and applies
      `branch_id = ANY(...)` in SQL, exactly like VOL-3/VOL-4a. The client sends
      the shell's active branch through `getActiveBranchId()`.
- [x] **3. Index the search and the page.** Reuse the existing
      `idx_customer_devices_global_trgm` expression verbatim as
      `CDR_SEARCH_TEXT_SQL`, and add a `(branch_id, created_at DESC, id DESC)`
      btree for the stable page.
- [x] **4. Remove from bootstrap.** No `customerDevices` in
      `GET /api/bootstrap`, no `fetchTable(...customerDevices)` in the fan-out.
      `BOOTSTRAP_TABLES.customerDevices` stays so an older client's
      `/api/bootstrap/local?key=customerDevices` still answers (honest `503`
      when the live read fails). App keeps the `customerDevices`
      register-refresh counter; it no longer holds the array.
- [x] **5. Register.** `CustomersManagement` pages through
      `/api/customer-devices/page` (server filters + pagination), takes its KPI
      counts from `/overview`, and refreshes on `sseRefreshKey`.
- [x] **6. Warranty.** The warranty directory needs CPE rows *and* fixed
      assets with a warranty status derived from the commissioned date, so it
      gets its own paged read: `GET /api/customer-devices/warranty` unions both
      tables in SQL, filters by computed warranty state, category, branch, text
      and commissioned dates, and returns per-state counts. No client-side
      whole-table scan remains.
- [x] **7. Export.** The serialized-device export reads the paged endpoint for
      its preview and asks for `all=1` (bounded, truncation reported) only when
      the operator exports.
- [x] **8. Every other consumer.** The customer directory computes
      `assignedDevicesCount` in SQL on its paged customer row (one indexed
      correlated subquery per page row) and fetches only an expanded customer's
      bounded serials; the stock-operation panels and the shipment form drop
      their legacy array fallbacks in favour of the serial register + server
      lookup; the shell's unused prop and the clear-demo array prop go away,
      with the latter reading the overview count.
- [x] **9. Gates and measurement.** `tsc`, targeted suites, full `npm test`,
      convention guards, build, bundle budget; a 1×/10× measurement of the
      removed payload, the paged register read and the warranty counts.

## Acceptance

- [x] `/api/bootstrap` has no `customerDevices` key and the fan-out does not
      read the table.
- [x] No client screen holds or filters the whole device table.
- [x] The register's page, filters and total come from the server; a device
      outside page 1 is reachable.
- [x] A branch account cannot read another branch's devices, by omission or by
      a forged `branchId`.
- [x] The warranty directory pages and filters without a whole-table read.
- [x] `GET /api/bootstrap/local?key=customerDevices` still answers for older
      clients.
- [x] The serialized-device export reports truncation instead of silently
      stopping at a page.

## Gates (2026-10-26)

- `npx tsc --noEmit` clean.
- Targeted suites: `customerDevicesOffBootstrap` (13), `inventory.repo` (63),
  `registerRefreshDomains` (44), `masterdata.repo`, `appRouteTree`,
  `appShellRenderCount`, `df12Cleanup`, `closeoutResiduals` — all green.
- Full `npm test`: **1322 tests, 1320 pass, 0 fail, 2 Windows-only skips**;
  docs-count gate green after the README/handoff/notes update.
- `npm run check:no-inline-sql` and `npm run check:no-raw-dialogs` green.
- `npm run build` clean; bundle budget **280.0 kB / 15.7 kB** (320 / 17).

## Measurement (2026-10-26)

A throwaway benchmark (`.tmp-vol4b-bench.ts`, removed after the run) built a
TEMP `customer_device_records`-shaped table — 14 branches, Nepali names,
ward-level addresses, phone, product, SN/PON/MAC and five statuses — with the
real trigram expression index and the new page btree, plus a TEMP fixed-asset
table at one asset per ten devices. It measured the old bootstrap read (every
column, every row), the paged register (branch + serial-fragment search), the
overview count and the warranty page + four counts.

| Volume | Rows | Scope | Old payload (JSON) | Old payload (gzip) | Old read | Page read | Overview | Warranty page + counts |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| 1× | 12,000 | one branch (857) | 0.33 MB | 31 kB | 13 ms | — | — | — |
| 1× | 12,000 | national (all) | **4.68 MB** | **435 kB** | 219 ms | — | — | — |
| 1× | 12,000 | one branch + search | — | — | — | **13.7 ms** | 2.5 ms | 35 ms |
| 10× | 120,000 | one branch (8,571) | 3.36 MB | 314 kB | 117 ms | — | — | — |
| 10× | 120,000 | national (all) | **46.95 MB** | **4.05 MB** | 1,497 ms | — | — | — |
| 10× | 120,000 | one branch + search | — | — | — | **74.6 ms** | 38.7 ms | 128 ms |

The national figures are the ones that mattered: a head-office login used to
materialise **47 MB / 4.05 MB gzipped** of device JSON and hold 120,000 objects
in the browser before first render, on every login. It now reads none of them
until the register/warranty screen opens, and then at most 200 rows. `EXPLAIN`
shows the trigram bitmap scan at both volumes for the serial-fragment search
(2749 candidate rows at 12k, 27,408 at 120k) and the page btree for the
10%-matching name search (1.5 ms / 2.1 ms). The benchmark table is unindexed
for the old path, so the comparison is the finding, not a micro-benchmark.

## Found while implementing

- **The warranty badge could disagree with its own filter.** The SQL rule and
  `getWarrantyInfo` both add 12 months but round month-ends differently
  (PostgreSQL `Feb 28`, JS `Mar 01` for a Feb-29 issued date). The server now
  returns a computed `warrantyState` with each row, and the badge renders that
  state and the server's end date; the boundary test compares both approaches
  across the four days around the threshold.
- **The expanded customer row matched by substring.** Passing the customer code
  as the text query meant `CUS-1` could return `CUS-10`'s devices. The page read
  now takes an exact `customerId` filter (`customer_code = $n OR customer_id =
  $n`), and the directory uses it.
- **A serial edit moves the device register.** `PATCH /api/inventory/serials`
  mirrors `device_serial` into `customer_device_records`, so `SERIALS` now bumps
  the `customerDevices` register counter as well as `serialLog`.

## Risks

| Risk | Mitigation |
|---|---|
| A consumer still reads the array through a prop | Source guard: no `customerDevices=` bootstrap prop, no `.find/.filter/.map` over a devices array in a screen |
| Warranty SQL drifts from `getWarrantyInfo` | The SQL rule and the utility are compared across boundary dates in a test |
| Search falls back to a sequential scan | The WHERE uses the same text as `idx_customer_devices_global_trgm`; `EXPLAIN` in the measurement |
| A branch account loses its legitimate scope | `allowedBranchIds` is included, exactly like the other paged reads |
| Export silently truncates | `all=1` returns a `truncated` flag and the row cap; the screen warns |
| Demo mode drifts from SQL | The mirror applies the same scope, search, status and paging rules |
| The Device Exchange picker still reads the bounded legacy array (2,000 newest rows) | It is no longer the whole table and the screen has its own text filter, but a branch above 2,000 deployed units needs a server-search picker — recorded as a follow-up, not silently widened (which would restore the national payload) |
