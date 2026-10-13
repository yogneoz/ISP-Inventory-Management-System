# Customer Device Serials — "Actions" button audit

_2026-10-13 · verified live on the running app (`localhost:3000`, PostgreSQL 16) plus the
code paths and their pinned tests._

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
| **Exchange** (old unit *RESTOCK*) | old row → `EXCHANGED`, replacement row → `RENTAL` under the same customer | **+1 `quantity_on_hand`** at the fulfilling branch; the old serial flips back to `IN_STOCK` | ✅ works |
| **Exchange** (old unit *DAMAGE*) | old row → `EXCHANGED`, replacement row → `RENTAL` | **+1 `damaged_qty`** (RMA bucket); `quantity_on_hand` untouched; old serial flips to `DAMAGED` | ✅ works |
| **Exchange** (old unit *DISPOSED*) | as above | none — correct: scrapped units are not stock | ✅ works |
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

## Residual gaps (found, not fixed)

- **The replacement unit's stock is not validated or deducted.** An exchange is booked as a 1-for-1
  swap at the fulfilling branch (old unit back, new unit out), so `quantity_on_hand` is unchanged —
  correct when the replacement comes from that same branch's pool, wrong when the replacement
  serial was `IN_STOCK` at *another* branch (that branch keeps counting a unit it no longer holds,
  and no transfer is posted). Nothing requires the replacement serial to exist in `serial_log` at
  all; an unknown serial gets a customer row but **no register row** (observed with SN-ONU002-0009
  and SN-ONU002-0010), because the serial flip is deliberately UPDATE-if-exists.
- **MAC collisions still surface as a raw 500.** The serial and PON probes return a friendly 409;
  the MAC index is only enforced by the database (`CDR_DUPLICATE_CHECK_SQL` does not cover MAC).
  Reachable only by genuinely entering a MAC another row already owns.
- **`PATCH /api/customer-devices/:id/status` has no role guard.** It can restock a unit and flip a
  serial, while the sibling `POST /api/customer-devices/exchange` carries
  `requireRole(SUPER_ADMIN, HEAD_OFFICE_ADMIN, FIELD_TECHNICIAN, BRANCH_MANAGER)` and the create
  route carries `requirePermission('customers-manage')`
  ([inventory.routes.ts](../server/src/routes/inventory.routes.ts)). Any authenticated user can
  drive a collect/refund restock through the status patch.
- **`DISCONNECTED` / `RETURNED` are unreachable states** on the register: the disconnect workflow
  writes `ROUTER_COLLECTED` (the only collected status the live CHECK constraint allows), so those
  two whitelist entries are dead vocabulary that the UI still offers as filters.
- **CPE-side lifecycle actions do not move the fixed-asset ledger.** After the disconnect round trip
  the fixed asset that deployed the unit (`FA-ONU002-4011`) is still `ASSIGNED_TO_CUSTOMER` naming
  the collected serial, and after an exchange the asset still names the unit that left
  (`FA-ONU002-1397` → `SN-ONU002-0004` while the customer now holds `SN-ONU002-0010`). The
  asset-side unassign path closes the CPE row and restocks (see
  [unassignRestock.service.ts](../server/src/services/unassignRestock.service.ts)), so the two
  reversal routes overlap without covering each other.
- **Two routes can credit the same return twice.** The approval restock writes a `PULLOUT` row keyed
  on the request number, while the asset-unassign guard looks for a restock row keyed on the asset
  tag — so reversing the same collection through *both* screens would add stock twice. Not reachable
  in a single flow, but nothing deduplicates the pair.

## Where the fixes live

- [server/src/controllers/inventory.controller.ts](../server/src/controllers/inventory.controller.ts)
  — `post_assets` (transactional register write), `registerCustomerDeviceRow`, `post_exchange`
  (disposition stock + serial sync + 409 duplicate probe).
- [server/src/models/inventory.repo.ts](../server/src/models/inventory.repo.ts) —
  `CDR_SERIAL_ROW_SQL`, `CDR_REDEPLOY_BY_SERIAL_SQL`, `cdrRedeployParams`,
  `CDR_ASSIGNMENT_DAMAGED_RETURN_SQL`, `SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL` (customer attribution),
  `SERIAL_LOG_RESTORE_ON_UNASSIGN_SQL` (clears it).
- [server/src/services/cdrSerialSync.ts](../server/src/services/cdrSerialSync.ts) — `upsertCdrMirror`,
  `isActiveCdrStatus`.
- [client/src/utils/registerRefreshDomains.ts](../client/src/utils/registerRefreshDomains.ts) and
  [client/src/App.tsx](../client/src/App.tsx) — the register refresh wiring.
- Tests: `tests/cdrSerialSync.test.ts`, `tests/inventory.repo.test.ts`,
  `tests/registerRefreshDomains.test.ts`, `tests/unassignRestock.service.test.ts`.
