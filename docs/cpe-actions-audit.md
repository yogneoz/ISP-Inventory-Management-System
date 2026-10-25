# Customer Device Serials — "Actions" button audit

_2026-10-13 · verified live on the running app (`localhost:3000`, PostgreSQL 16) plus the
code paths and their pinned tests. Re-checked against the code on 2026-10-25 (DOC-1);
the replacement-validation, status-route authorization, MAC-conflict, dead-vocabulary and
asset-lifecycle defects are now closed, see
[Closed since this audit](#closed-since-this-audit)._


Scope: every action the Customer Device Serials register
([CustomersManagement.tsx](../client/src/features/sales/CustomersManagement.tsx)) offers, and the
two surfaces that create the rows it acts on — "Assign Customer Device" on the register and the
"Assign Fixed Asset" deployment panel. The question for each one: **does it actually work, and does
it leave stock and the two registers agreeing?**

## The register's ground rule

`customer_device_records` holds **at most one row per device serial** — and, independently, one per
PON serial and one per MAC (`uq_customer_device_device_serial`,
`uq_customer_device_pon_serial`, `uq_customer_device_mac_address`,
[scripts/schema.sql](../scripts/schema.sql)). A device's row is therefore **re-used across
lifecycles**: renting → collecting → re-renting updates the same row rather than inserting a new
one. Any code path that inserts unconditionally breaks on the second lifecycle of the same unit.

Both registers also have to agree: every CPE lifecycle mutation flips the unit's `serial_log` row
(see [docs/stock-ledger-accuracy-audit.md](stock-ledger-accuracy-audit.md)) and broadcasts a
`CUSTOMER_DEVICES` domain event so open registers re-fetch without a page reload.

## What each action does — verified

| Action | Effect on the register | Effect on stock | Verdict |
|---|---|---|---|
| **Details** | none (read-only modal) | none | ✅ works |
| **Disconnect Request** | creates an approval request; the row is marked *Disconnect Pending* until an approver acts | none at request time | ✅ works |
| ↳ approval executed | row → `ROUTER_COLLECTED`, `serial_log` → `IN_STOCK` with the customer attribution cleared | **+1 `quantity_on_hand`** at the related branch, with a ledger row | ✅ works |
| ↳ **Cancel Request** | withdraws a pending request; the device stays `RENTAL` and the field is unchanged | none | ✅ works |
| **Exchange** (old unit *RESTOCK*) | old row → `EXCHANGED`, replacement row → `RENTAL` under the same customer | **+1 `quantity_on_hand`** for the returned unit and **−1** for the replacement that leaves the branch (net 0); the old serial flips back to `IN_STOCK` | ✅ works |
| **Exchange** (old unit *DAMAGE*) | old row → `EXCHANGED`, replacement row → `RENTAL` | **+1 `damaged_qty`** (RMA bucket) and **−1 `quantity_on_hand`** for the replacement; `quantity_on_hand` therefore drops by one usable unit; old serial flips to `DAMAGED` | ✅ works |
| **Exchange** (old unit *DISPOSED*) | as above | **−1 `quantity_on_hand`** for the replacement; nothing is added for the scrapped unit | ✅ works |
| **Assign Customer Device** (register header) | inserts/updates the row, flips the serial to `CUSTOMER_ASSIGNED`, and consumes a unit | −1 `quantity_on_hand` (idempotent against an already-consumed deployment) | ✅ works |
| **Assign Fixed Asset → "Record Asset Deployment & Register Asset(s)"** | creates the rental-CPE row **in the same transaction** as the asset, and flips the serial | −1 `quantity_on_hand` | ✅ works (fixed this session) |

### Round trips actually executed in the browser

1. **Unassign round trip** — `Disconnect Request` on SN-ONU002-0004 (RENTAL, Branch 1) → approved in
   the Workflow Approval Center:
   - CDR: same row → `ROUTER_COLLECTED`
   - `serial_log`: `IN_STOCK`, `customer_id`/`customer_name` `NULL`
   - stock: Branch 1 / ONU002 `quantity_on_hand` 0 → **1**
2. **Deploy-from-stock, re-rental** — Assign Fixed Asset (Branch 1, customer CUS-10292,
   SN-ONU002-0004) submitted from the panel: the **same** register row (id `cust-1791623690597`)
   was re-activated to `RENTAL` with the new customer, PON and tag-stamped notes; `serial_log` →
   `CUSTOMER_ASSIGNED`; stock 1 → 0. One `POST /api/assets`, no second request.
3. **Deploy-from-stock, first rental** — same panel at WH001 with SN-ONU002-0001: a **new** row
   (`cdr-asset-…`) was created, the serial flipped to `CUSTOMER_ASSIGNED`, stock 2 → 1 (after the
   earlier deduction).
4. **Exchange, RESTOCK** — SN-ONU002-0004 exchanged for SN-ONU002-0009: old row `EXCHANGED`, old
   serial → `IN_STOCK` at Branch 1, replacement row `RENTAL`, stock 0 → 1.
5. **Exchange, DAMAGE** — SN-ONU002-0009 exchanged for SN-ONU002-0010: old row `EXCHANGED`, old
   serial → `DAMAGED`, Branch 1 `damaged_qty` 0 → 1, `quantity_on_hand` unchanged.
6. **Live refresh** — with the register open, a server-side status change (SUSPENDED on the WH001
   rental) re-rendered the row **without a reload**, confirming the SSE → register refetch wiring
   that the earlier disconnect round trip exposed as broken.

## Defects found and fixed in this session

1. **Deploy-from-stock wrote the register row client-side, in a second request.** The panel called
   `POST /api/assets` and then `POST /api/customer-devices`; a failure or race between them left
   `serial_log` saying `CUSTOMER_ASSIGNED` with no row in the customer directory. The deploy
   endpoint now creates the row inside the same transaction as the stock deduction and the serial
   flip, and the panel no longer makes the second call (it forwards PON serial and MAC instead,
   which only the endpoint can store).
2. **A plain INSERT cannot re-rent a unit.** `uq_customer_device_device_serial` rejected the second
   row for the same serial and rolled the whole deployment back (`500 duplicate key …`). Both the
   deploy and the exchange now write **serial-keyed**: no row → insert, closed row
   (`ROUTER_COLLECTED` / `EXCHANGED` / `REFUND` / `IN_STOCK`) → re-activate in place keeping the row
   id, active row → leave alone (`CDR_SERIAL_ROW_SQL`, `CDR_REDEPLOY_BY_SERIAL_SQL`, and the
   `upsertCdrMirror` twin for demo mode).
3. **Exchange moved no stock at all.** The form promises "Restock to Branch (+1 Stock)" and
   "Quarantined RMA Stock", but the handler never touched `inventory_stock`: restocked units
   vanished from branch inventory and RMA units never reached the damaged pool. Both dispositions
   now credit the right bucket and write a ledger row with the true post-update balance.
4. **The Exchange form pre-filled a random serial and a constant MAC.** Every exchange therefore
   registered a serial the business never received, and the second exchange from the form died with
   `500 duplicate key value violates unique constraint "uq_customer_device_mac_address"` — both
   fields are now empty on open (the 🎲 *Auto-Gen* buttons remain as an explicit opt-in) and
   MAC stays optional. A serial/PON that another device already owns now returns a **409** with a
   readable message before any state is touched.
5. **The customer-device register never re-fetched.** `registerRefresh.customerDevices` existed and
   was bumped, but no consumer received it: an approved disconnect left the row showing its
   pre-approval `RENTAL` badge (and the "N Rental / N Collected" cards their old counts) until a
   full page reload. Both consumers — the register and the customer master directory's per-customer
   device counts — are now wired, and `ASSETS` events (deploy / reversal) refresh the register too,
   since that endpoint writes it.
6. **Multi-unit serialized lines duplicated one physical device.** For a bin line with quantity > 1
   the panel sent the same device serial for every unit and generated fabricated serials for the
   extra CDR rows. Only the first unit of a line now carries the device identity.

## Closed since this audit

- **Replacement validation (fixed 2026-10-20, commit `4595a52`).** `post_exchange` no longer
  trusts the typed replacement serial. It resolves the unit through the shared serial gate at the
  fulfilling branch (`IN_STOCK`, `matchMac: true`, product intentionally not matched so a different
  model can replace one), then repeats the same rule with `FOR UPDATE` inside the transaction. An
  unknown serial, a serial at another branch or a non-`IN_STOCK` serial is refused `400` before any
  customer-device row, stock movement or serial flip is written. A blank PON/MAC is hydrated from
  the register row. Pinned by `tests/mirrorStep3.test.ts` and
  `tests/exchange.concurrency.test.ts`. Do not re-implement this gate in CPE-2/CPE-3.
- **Status PATCH authorization (fixed 2026-10-25, CPE-1).**
  `PATCH /api/customer-devices/:id/status` now carries the shared CPE manager
  audience (`SUPER_ADMIN`, `HEAD_OFFICE_ADMIN`, `BRANCH_MANAGER`,
  `INVENTORY_MANAGER`); `FRONT_DESK` and other authenticated roles get `403`
  before any write. The exchange routes use the same manager base plus
  `FIELD_TECHNICIAN`, so the two audiences cannot drift. The handler also
  re-checks the record's branch because the app-level branch middleware cannot
  see `req.params.id` before routing. Pinned over HTTP by
  `tests/cpeStatusAuthz.test.ts`: 401, 403 (role), 403 (foreign branch), and a
  200 that moves both `customer_device_records` and `serial_log`.
- **MAC conflicts (fixed 2026-10-25, CPE-2).** `CDR_DUPLICATE_CHECK_SQL` now
  covers a non-empty `mac_address` compared by the same 12-hex key as the unique
  index (`A4:C3:F0:B1:D2:E3` and `a4c3f0b1d2e3` collide), and names the matched
  field in the response. Create and exchange both probe before any write and
  return `409` with a readable message instead of reaching
  `uq_customer_device_mac_address` as a 500. The exchange hydrates a blank
  PON/MAC from the register **before** that probe, so a serial-only payload
  cannot bypass the check. Pinned over HTTP against real PostgreSQL by
  `tests/cpeMacConflict.test.ts` (duplicate create, new create, duplicate
  exchange, hydrated duplicate exchange, successful exchange) and in unit tests
  by `tests/cdrDuplicates.test.ts` and `tests/inventory.repo.test.ts`.
- **Fixed asset follows the CPE lifecycle (fixed 2026-10-25, CPE-3).** One service
  ([cpeAssetLifecycle.service.ts](../server/src/services/cpeAssetLifecycle.service.ts))
  now owns the asset rule used by the approval path, the direct status PATCH,
  the asset-unassign screen and the exchange. Collection returns the asset to
  `ACTIVE`, clears every assignment field and `device_serial`, and appends a
  dated collection note; exchange keeps the tag and customer, moves
  `device_serial` to the replacement and records `old → new`. Stock is credited
  once per fixed-asset id (`txn-cpe-collect-<assetId>`), so replaying a
  collection through a second route is a no-op; an unlinked legacy CPE row is
  keyed by its CPE row id (request number as fallback), so the approval path and
  a direct status PATCH agree too. The exchange posts the replacement's
  `STOCK_OUT` (`txn-cpe-exchange-out-<newCdrId>`) in the same transaction as the
  old unit's disposition, and refuses (`409`) when branch stock is empty.
  Pinned on real PostgreSQL by `tests/cpeAssetLifecycle.test.ts` (collect once,
  collect twice, unlinked replay, exchange, empty-stock rollback, forced-failure
  rollback, exchange-then-collect); the exchange concurrency and MAC suites now
  assert the replacement consumption.
- **Dead status vocabulary (fixed 2026-10-25, CPE-2).** A live count found zero
  `customer_device_records` rows in `DISCONNECTED` or `RETURNED`, so both
  values were removed from the write paths: create and status PATCH refuse them
  with a readable `400` (no more `DISCONNECTED` → `ROUTER_COLLECTED`
  normalisation), approval submission/execution refuses a legacy requested
  status before writing, and the UI no longer offers or special-cases them.
  The type union and read path keep the values so any pre-cleanup row remains
  readable; `ROUTER_COLLECTED` is the collected state and `REFUND`/`IN_STOCK`
  the return states.

## Residual gaps (found, not fixed)

None from this audit as of 2026-10-25. The three gaps listed here previously —
the missing replacement-stock decrement, the fixed asset left naming the
collected unit, and the two collection routes that could each credit stock —
are closed by CPE-3 (see above).

## Where the fixes live

- [server/src/controllers/inventory.controller.ts](../server/src/controllers/inventory.controller.ts)
  — `post_assets` (transactional register write), `registerCustomerDeviceRow`, `post_exchange`
  (disposition stock + serial sync + 409 duplicate probe).
- [server/src/models/inventory.repo.ts](../server/src/models/inventory.repo.ts) —
  `CDR_SERIAL_ROW_SQL`, `CDR_REDEPLOY_BY_SERIAL_SQL`, `cdrRedeployParams`,
  `CDR_ASSIGNMENT_DAMAGED_RETURN_SQL`, `SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL` (customer attribution),
  `SERIAL_LOG_RESTORE_ON_UNASSIGN_SQL` (clears it).
- [server/src/services/cpeAssetLifecycle.service.ts](../server/src/services/cpeAssetLifecycle.service.ts)
  — `collectCpeFixedAsset` (asset → `ACTIVE`, one asset-keyed credit, unlinked
  request fallback), `exchangeCpeFixedAsset` (serial move + replacement
  `STOCK_OUT`), `extractCpeAssetTag`, `isDeployedAsset`.
- [server/src/services/cdrSerialSync.ts](../server/src/services/cdrSerialSync.ts) — `upsertCdrMirror`,
  `isActiveCdrStatus`, `isLegacyCdrStatus`.
- [server/src/services/cdrDuplicates.ts](../server/src/services/cdrDuplicates.ts) — `findCdrDuplicate`
  (case/trim-insensitive serial/PON, canonical 12-hex MAC), `cdrDuplicateMessage`,
  `cdrDuplicateFromRow`.
- [client/src/utils/registerRefreshDomains.ts](../client/src/utils/registerRefreshDomains.ts) and
  [client/src/App.tsx](../client/src/App.tsx) — the register refresh wiring.
- Tests: `tests/cdrSerialSync.test.ts`, `tests/cdrDuplicates.test.ts`,
  `tests/cpeMacConflict.test.ts`, `tests/cpeStatusAuthz.test.ts`,
  `tests/cpeAssetLifecycle.test.ts`, `tests/inventory.repo.test.ts`,
  `tests/registerRefreshDomains.test.ts`, `tests/unassignRestock.service.test.ts`.
