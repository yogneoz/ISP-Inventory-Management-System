# Serial register audit — where serials are really created, and what that breaks

_2026-10-13 · read-only audit of the running app (`localhost:3000`, PostgreSQL 16) plus the code
paths that write `serial_log`. **No code was changed for this document** — it records findings and
the agreed solution so the discussion is reviewable without the chat transcript._

Scope: the serial register (`serial_log`), the customer device register (`customer_device_records`,
"CDR"), product serial-tracking configuration, and every screen that captures a device serial, PON
serial or MAC. The question behind each finding: **is the register a real register, and does every
consumer read it the same way?**

## Verdict — the four questions

| Question | Answer | Evidence |
|---|---|---|
| Does the app have a serial database? | **Yes — derived from documents, now written on purpose.** `serial_log` is the register (one row per serial). Its writers are purchase receipts (Slice 1), the lifecycle flips (§6d) and an **on-demand reconcile** (§6e); boot no longer backfills anything. Nothing registers a serial when it is received, so a unit's row is created by its purchase, not by the receipt. | [schema.sql:713](../scripts/schema.sql#L713), [serialBackfill.service.ts](../server/src/services/serialBackfill.service.ts) |
| Does Assign Fixed Asset validate the serial? | **Client-side only, and incompletely.** The panel validates a (device, PON) pair against its own copy of the register; the server silently skips an unknown serial and proceeds. The panel also pre-fills a random serial, a random PON and a **constant MAC**. | [AssignAssetPanel.tsx:197](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L197), [inventory.controller.ts:799](../server/src/controllers/inventory.controller.ts#L799) |
| Do transfers move register rows? | **Yes — fixed in Slice 3 (2026-10-19):** dispatch/receive/cancel/undo-receipt flip `IN_STOCK → IN_TRANSIT → IN_STOCK` inside their own transactions. | [serial-input-improvements-plan.md §8E](serial-input-improvements-plan.md) |
| Does purchasing a serial-tracked product log into the register? | **Yes — fixed in Slice 1 (2026-10-13).** `POST /api/purchase-invoices` now writes one `serial_log` row per received unit inside its own transaction, so the unit is sellable immediately. (Before Slice 1 the serials lived only in the invoice's `items` JSONB and rows appeared at the next restart.) | [procurement.controller.ts:324](../server/src/controllers/procurement.controller.ts#L324), [serialRegister.service.ts](../server/src/services/serialRegister.service.ts) |
| Are `SERIAL_LOG_INSERT_SQL` / `SERIAL_LOG_UPDATE_SQL` doing that work? | **No — they are dead code.** Both are exported and imported into the inventory controller, but no call site exists anywhere in `server/`. Only tests assert their SQL shape. | [inventory.repo.ts:1160](../server/src/models/inventory.repo.ts#L1160), [#L1198](../server/src/models/inventory.repo.ts#L1198), [inventory.controller.ts:103](../server/src/controllers/inventory.controller.ts#L103) |

## 1. The register is a projection, not a ledger

> **Status 2026-10-25.** The gaps recorded in this section were closed by
> Slices 1–4, SER-1 (§6d) and SER-2 (§6e). The inventory below is the original
> audit, annotated where a path later moved; the delivered behaviour is in §6a–§6e.

`serial_log` looks like a write-through register: one row per serial, unique by
`lower(trim(device_serial))` ([schema.sql:1245](../scripts/schema.sql#L1245)), with a `status` CHECK
covering `IN_STOCK` / `IN_TRANSIT` / `CUSTOMER_ASSIGNED` / `POP_LOCATION_ASSIGNED` / `DAMAGED` /
`RETURNED` / `SOLD` / `RETURNED_TO_VENDOR` / `CONSUMED`.

Every row-creating path in the repository:

| Path | What it does | Live? |
|---|---|---|
| `backfillSerialLog()` — [serialBackfill.service.ts](../server/src/services/serialBackfill.service.ts), reached only by `POST /api/admin/recalculate/serial-register` | Derives rows from PI `items.deviceSerials`, shipment `deviceSerials` / `receivedSerials`, stock-op serials, serial-tracked `fixed_assets`, and CDR rows; merges to one row per serial | **On demand, SUPER_ADMIN** (was boot-only; SER-2, §6e) |
| Serial rename — [serials.service.ts:288](../server/src/services/serials.service.ts#L288) | Inserts a row when a corrected serial has none | Edit screen only |
| Demo seed — [setup_db.js:655](../scripts/setup_db.js#L655) | Seed data | Setup only |
| `SERIAL_LOG_INSERT_SQL` / `SERIAL_LOG_UPDATE_SQL` | No caller (before Slice 1) | **Live** — called by `registerPurchaseSerials` on the PI transaction ([procurement.controller.ts:324](../server/src/controllers/procurement.controller.ts#L324)) |

Every *other* register write is a **flip of a row it assumes already exists**:

- sales claim `IN_STOCK → CUSTOMER_ASSIGNED` ([sales.repo.ts:214](../server/src/models/sales.repo.ts#L214)),
- deploy `IN_STOCK → CUSTOMER_ASSIGNED` / `POP_LOCATION_ASSIGNED` ([inventory.repo.ts:1013](../server/src/models/inventory.repo.ts#L1013)),
- unassign restock back to `IN_STOCK` ([inventory.repo.ts:1023](../server/src/models/inventory.repo.ts#L1023)),
- damage quarantine / restore ([damage.service.ts:167](../server/src/services/damage.service.ts#L167)),
- CDR sync ([inventory.repo.ts:1036](../server/src/models/inventory.repo.ts#L1036)),
- purchase returns ([procurement.repo.ts:819](../server/src/models/procurement.repo.ts#L819)).

**Consequence (as of the original audit).** The register was stale by construction: a unit
purchased in a session had no row until the process restarted, so the sales gate and the deploy
validation rejected a unit that had just been bought. Slice 1 closed this for purchase receipts
(§6a): the invoice transaction writes the row immediately. The reconcile pass (§6e) is now only a
legacy/repair path and no longer a startup side effect.

## 2. Assign Fixed Asset — what is actually enforced

Three different checks, only two of which exist:

1. **Quantity** — client-side against the app's stock cache; the server re-checks under a row lock
   when `deployFromStock` is set ([inventory.controller.ts:752](../server/src/controllers/inventory.controller.ts#L752)).
2. **Serial identity** — the panel matches the typed (device, PON) pair against its serial-log mirror,
   requiring `IN_STOCK`, the same branch and the same product name, with a `customer_device_records`
   fallback ([AssignAssetPanel.tsx:197-227](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L197-L227)).
   This is the *only* place a PON is compared against the register during assignment.
3. **Server-side serial existence** — ~~**absent**~~ **fixed in Slice 2.** `post_assets` used to look
   the serial up and flip it **only if found**, so an unknown serial was accepted silently and the
   asset was deployed anyway. It now resolves the unit through the shared gate first
   ([serialGate.service.ts](../server/src/services/serialGate.service.ts)): unknown, wrong status or
   wrong branch refuses the whole request. (PON/MAC *value* matching on deploy still waits for the
   panel's generated identity to be removed in Slice 4 — see §5 item 5.)

Two further defects in the same panel:

- **Invented identity.** Adding a serialized product pre-fills `SN-ONU24G-<random>`, a random
  `HWTC-…` PON and the **same MAC for every line** — `00:1A:2B:3C:4D:5E`
  ([AssignAssetPanel.tsx:136-138](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L136-L138)).
- **The `kind === 'ASSET'` branch still fabricates and still double-writes.** Deploying an existing
  ledger asset to a customer generates a fresh random serial/PON and fires a second
  `createCustomerDevice` call with no MAC
  ([AssignAssetPanel.tsx:297-302](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L297-L302))
  — the two-register drift that was fixed for the PRODUCT path only.

## 3. Purchasing did not register serials (fixed in Slice 1)

> **Status: fixed.** `post_purchaseInvoices` now validates and registers the bill's units
> transactionally through `planPurchaseSerialEntries` + `registerPurchaseSerials`, and the purchase
> form no longer invents serials or PON values. The findings below are kept as the audit record of
> what the code looked like when the plan was written.


`post_purchaseInvoices` ([procurement.controller.ts:301](../server/src/controllers/procurement.controller.ts#L301))
recomputes totals, upserts the invoice with `items` as JSONB, receives stock per line
(`PI_RECEIVE_STOCK_SQL`) and writes the ledger row — all in one transaction, with no serial write.
Purchase *returns* do flip rows (`RETURNED_TO_VENDOR` / back to `IN_STOCK`), which proves the register
was expected to be populated by then.

What that breaks in practice:

- **Sales hard-block fresh stock.** The claim gate requires an `IN_STOCK` row at the selling branch
  for the product, with a matching PON (and matching MAC when scanned) —
  [sales.controller.ts:189-230](../server/src/controllers/sales.controller.ts#L189-L230). A unit
  bought this session fails with *"not in inventory at &lt;branch&gt;"*. The comment above that gate
  ([#L189](../server/src/controllers/sales.controller.ts#L189)) and the client message
  ([SalesInvoices.tsx:456](../client/src/features/sales/SalesInvoices.tsx#L456)) both claim purchases
  write the register. They do not.
- ~~**Stock operations read a different source.**~~ **Fixed in Slice 2 on both sides.** The client now
  matches the branch's `IN_STOCK` **register** (it fetches `GET /api/serial-log` once and validates
  against it), and the server no longer consults the `customer_device_records` mirror at all: the
  shared gate resolves each serial against `serial_log` under the operation's own lock.
- **Transfers are register-blind.** [shipments.controller.ts](../server/src/controllers/shipments.controller.ts)
  contains no serial handling at all: `IN_TRANSIT` and received serial states exist only because the
  reconcile pass derives them from shipment rows (Slice 3, 2026-10-19, later added the transfer
  flips — see §6c). At the time of this finding, dispatch and receive moved no register row.
- **The purchase form is the least validated serial surface in the app.** It auto-generates
  `SN-<SKU>-<random>` and a random PON whenever quantity changes
  ([PurchaseInvoiceForm.tsx:309](../client/src/features/procurement/PurchaseInvoiceForm.tsx#L309)) and
  submits whatever is present — blanks and duplicates included — because there is no serial
  validation before posting ([#L439](../client/src/features/procurement/PurchaseInvoiceForm.tsx#L439)).
  It also treats `requiresSerialTracking !== false` as serialized without consulting `trackingType`.

Data model notes that matter for the fix:

- Only the device serial is unique in `serial_log` (one index). PON and MAC uniqueness exist **only**
  on CDR — [schema.sql:1238](../scripts/schema.sql#L1238), [#L1239](../scripts/schema.sql#L1239) — so
  a duplicate PON/MAC passed at purchase is accepted by the register and then fails later with a raw
  `500` on the first customer assignment.
- Serial tracking is configured per product: `requires_serial_tracking` + `tracking_type IN
  ('QUANTITY_ONLY','SERIAL_MAC_PON','SERIAL_ONLY')`
  ([schema.sql:134-135](../scripts/schema.sql#L134-L135)).

## 4. Every serial-capture surface today

| Screen | Fields | Where identity comes from |
|---|---|---|
| [PurchaseInvoiceForm.tsx:937](../client/src/features/procurement/PurchaseInvoiceForm.tsx#L937) | Device + PON + MAC | **auto-generated**, unvalidated |
| [CreateShipmentForm.tsx:477](../client/src/features/procurement/CreateShipmentForm.tsx#L477) | Device + PON | auto-generated |
| [SalesInvoices.tsx:922](../client/src/features/sales/SalesInvoices.tsx#L922) | Device + PON + MAC (opt) | register-validated (`serial_log`) |
| [StockOperations.tsx:296](../client/src/features/inventory/StockOperations.tsx#L296) | Device + PON | CDR-validated (`customer_device_records`) |
| [CreatePulloutPanel.tsx:431](../client/src/features/inventory/stockops/CreatePulloutPanel.tsx#L431) | Device + PON | typed |
| [CreateTransferPanel.tsx:436](../client/src/features/inventory/stockops/CreateTransferPanel.tsx#L436) | Device + PON | typed |
| [LabelDamagePanel.tsx:198](../client/src/features/inventory/stockops/LabelDamagePanel.tsx#L198) | Device + PON | typed |
| [ProductSalePanel.tsx:506](../client/src/features/inventory/stockops/ProductSalePanel.tsx#L506) | Device + PON | typed |
| [AssignAssetPanel.tsx:611](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L611) | Device + PON + MAC | pre-filled fakes, register-matched |
| [CustomersManagement.tsx:1573](../client/src/features/sales/CustomersManagement.tsx#L1573) | Device + PON + MAC | 🎲 Auto-Gen buttons |
| [ReceiveVerificationModal.tsx:80](../client/src/components/common/ReceiveVerificationModal.tsx#L80) | pairs | tick-off against dispatch |
| [ReceiveInboundWarehouse.tsx:457](../client/src/features/procurement/ReceiveInboundWarehouse.tsx#L457) | display | read-only |
| [SerialLogRegister.tsx](../client/src/features/inventory/SerialLogRegister.tsx) | dual correction | the only screen with a real lookup |

The only existing lookup ([inventory.routes.ts:100](../server/src/routes/inventory.routes.ts#L100))
resolves a device serial, PON or MAC to its holder across `serial_log`, CDR and `fixed_assets`, but it
requires `edit-device-serials` — SUPER_ADMIN / HEAD_OFFICE_ADMIN / INVENTORY_MANAGER only
([permissionMatrixData.ts:115](../client/src/utils/permissionMatrixData.ts#L115)). Branch users and
front desk cannot use it, so it cannot serve as the autofill source for the forms above.

## 5. Agreed contract

Confirmed decisions:

1. **One writer.** `POST /api/purchase-invoices` upserts exactly one `serial_log` row per received
   unit, inside the same transaction as the stock receive. Blank or duplicate device serials on a
   serial-tracked line return `400` and nothing posts. The backfill is a legacy import / repair
   action only, never the live path — boot no longer calls it (§6e, delivered 2026-10-25).
2. **Pick-only everywhere else.** No other endpoint may create a register row. An unknown serial is
   refused server-side, not merely flagged in the UI.
3. **One branch + status gate.** A serial must resolve to a register row that is `IN_STOCK` at the
   acting branch. Sales already implements this; stock ops, deploy, damage, pullout, issue and
   exchange move onto the same rule instead of reading CDR.
4. **Tracking type decides the fields.** `SERIAL_MAC_PON` → PON **and** MAC mandatory;
   `SERIAL_ONLY` → neither required; `QUANTITY_ONLY` → no serial UI. Once the serial resolves, PON
   and MAC are shown read-only from the register — they are never typed again after purchasing.
5. **No invented identity.** Every random generator and 🎲 Auto-Gen button is removed; assign,
   exchange and CPE forms start empty and pick from the branch's `IN_STOCK` register.

## 6. Five-slice plan

Each slice is independently verifiable and leaves the app consistent.

**Slice 1 — the register becomes real.**
Server: a register upsert (device serial, PON, MAC, product, branch, `IN_STOCK`,
`source_type='PURCHASE'`, `source_id=<invoice>`) called from the PI transaction, replacing the dead
`SERIAL_LOG_INSERT_SQL` / `UPDATE_SQL`. Reject blank and duplicate serials for serial-tracked lines
before any write. Client: remove the auto-generated serial/PON from the purchase form and require
one real serial per unit, PON/MAC per tracking type.
_Acceptance:_ post one serial-tracked invoice; without restarting, the register lists each unit as
`IN_STOCK` at that branch and it can immediately be sold.

**Slice 2 — one gate, enforced server-side.** ✅ **Delivered** — see §6b.
A shared resolve-and-claim helper used by deploy, damage, pullout, issue, stock ops and exchange;
unknown serial, wrong branch or wrong status → typed refusal (`409`/`400` with a readable message),
and PON/MAC collisions stop surfacing as raw `500`s. Client-side checks become UX only, and
`StockOperations` switches from CDR to the register.
_Landed:_ one gate ([serialGate.service.ts](../server/src/services/serialGate.service.ts)) drives
sales, deploy-from-stock and all four serial-validated stock operations; `StockOperations` had already
switched to the register. Resolution and refusal are shared; each lifecycle keeps its own transition
so reversals stay symmetric (the deliberate exception, and why, is in §6b).
_Acceptance:_ a direct API call with an unknown serial is refused and moves no stock; each screen
reports the register's own reason.

**Slice 3 — transfer integrity.**
Dispatch claims `IN_STOCK → IN_TRANSIT` at the source branch; receive lands `IN_TRANSIT → IN_STOCK`
at the destination — both inside the existing transactions, with the in-memory mirror updated so
PG-down demo mode behaves identically.
_Acceptance:_ a warehouse→branch transfer of a serial-tracked unit shows `IN_TRANSIT` at the source
and `IN_STOCK` at the destination, and the unit is unsellable mid-transit.

**Slice 4 — pick-only UX.**
One shared serial input (debounced lookup → autofill → inline "not in this branch's register")
replaces the device+PON+MAC triples in the 13 screens above; the register's picker is scoped to the
acting branch and gated like `GET /api/serial-log` ([inventory.controller.ts:2605](../server/src/controllers/inventory.controller.ts#L2605),
which already supports `branchId` / `status` / `query` via
[buildSerialLogQuery](../server/src/models/inventory.repo.ts#L1129)) so branch roles can use it.
_Acceptance:_ no screen except the purchase form can submit a serial the register has never seen.

**Slice 5 — reconciliation and docs. Delivered 2026-10-25 (§6e).**
Expose the backfill as an explicit maintenance action (the recalculation surface in
[admin.controller.ts](../server/src/controllers/admin.controller.ts) is the natural host), correct the
false "purchase receipts write it" comments, and update the affected docs.
_Acceptance:_ the maintenance action reconciles legacy rows and reports what it inserted/upgraded.

## 6a. Slice 1 — delivered (2026-10-13)

What shipped.

- **One writer, transactional.** `POST /api/purchase-invoices` plans its register entries before any
  write (`planPurchaseSerialEntries`) and then writes them inside the invoice's existing transaction
  via `registerPurchaseSerials` ([serialRegister.service.ts](../server/src/services/serialRegister.service.ts)).
  A refused unit rolls back the whole bill — no invoice, no stock receive, no ledger row.
- **Blank, duplicate and missing identity are refused (`400`, nothing posts).** A serial-tracked line
  must carry exactly one device serial per unit; `SERIAL_MAC_PON` products must also carry PON and
  MAC; device serial / PON / MAC repeats within one bill are refused; a unit already in the register
  is refused (`409`), except a row the vendor had taken back (`RETURNED_TO_VENDOR`), which is
  re-activated in place keeping its id and history.
- **The purchase form no longer invents identity.** The auto-generated `SN-<SKU>-<random>` device
  serial and random PON are gone; a quantity change now seeds empty per-unit rows the operator must
  fill, and the form blocks posting until every slot carries a real device serial (plus PON/MAC for
  `SERIAL_MAC_PON`).
- **The register's own uniqueness matches CDR.** `uq_serial_log_pon_serial` and
  `uq_serial_log_mac_address` (partial, non-empty values only) close the check-then-write race in the
  owner probes; the pre-check in `schema.sql` keeps a database with pre-existing duplicates bootable,
  and `23505` is mapped to a readable `409` instead of a raw `500`.
- **Deletion keeps the register honest.** Deleting a bill removes the register rows that bill created,
  keyed on the bill's own serials — not on `source_type`/`source_id`, which a later sale or deploy
  rewrites. A unit that has since moved makes the deletion `409` rather than orphaning its history.

Acceptance, run through the real HTTP API against the dev server (`localhost:3000`, PostgreSQL 16),
**15/15 checks** — including the headline one: a unit bought in this session is `IN_STOCK` in the
register **without a restart** and sells immediately. Concurrency probe: five simultaneous bills
sharing one PON → exactly one posts, four clean `400`s, zero `500`s, one register row.Still open at the time (Slices 3–5): transfer integrity, the shared pick-only serial input, and demoting the boot backfill to a maintenance action.

## 6c. Slices 3 and 4 — delivered (2026-10-19)

See [serial-input-improvements-plan.md](serial-input-improvements-plan.md) §8 for the full record.

- **Slice 3 (transfer integrity) — done.** `shipments.controller` now moves `serial_log`
  on all four legs inside the existing transactions: dispatch `IN_STOCK → IN_TRANSIT`
  (gate-resolved at the source), receive `IN_TRANSIT → IN_STOCK` at the destination,
  cancel `IN_TRANSIT → IN_STOCK` at the source, undo-receipt `IN_STOCK → IN_TRANSIT`.
  The received serials are recorded per item, so a short receipt leaves the undelivered
  units in transit and cancellable, and dispatch plans its units through the shared gate
  (the server, not only the UI, refuses a serial-tracked line with no device serials).
  The “transfers are register-blind” finding in §3 is therefore **closed**.
- **Slice 4 (pick-only UX) — done.** One shared `DeviceSerialInput` replaces the
  Device + PON (+MAC) triples on sales, shipment create, stock-op pullout / transfer /
  damage / product sale, assign fixed asset, device exchange, customer assignment and
  CPE exchange. It resolves the unit against the branch's register, shows the status
  inline, and fills PON and MAC read-only — then the payload carries only the device
  serial, because the server hydrates the rest
  (`serialGate.service` `hydrateSerialEntries`).
- **Also delivered in the same pass:** MAC canonicalisation (`shared/macAddress.ts`),
  MAC required / PON optional at purchase, aggregate per-product availability checks
  with `400` refusals, and every invented-identity generator removed (10 call sites).
- **Also delivered (2026-10-20):** `post_exchange` now gates the replacement
  against the register (IN_STOCK at the fulfilling branch, locked re-check inside
  the transaction) and hydrates a blank PON/MAC from the row; a refused exchange
  writes no customer-device row.
- **Delivered 2026-10-25 (§6e):** Slice 5 — the boot backfill is now an explicit SUPER_ADMIN
  maintenance action and boot only logs a pointer.

## 6b. Slice 2 — delivered (2026-10-13)

**One gate, one rule.** [serialGate.service.ts](../server/src/services/serialGate.service.ts) now owns
"is this unit real, ours, and available?" for every endpoint that draws a serial out of branch stock.
It plans the units (`planSerialGateEntries`), classifies the first refusal as data
(`findGateViolation` → `UNKNOWN` / `WRONG_STATUS` / `WRONG_BRANCH` / `WRONG_PRODUCT` / `PON_REQUIRED` /
`PON_MISMATCH` / `MAC_MISMATCH` / `DUPLICATE`), phrases it in the caller's terms
(`describeGateViolation`), and refuses with a typed `SerialGateError`. The lock is
`SERIAL_GATE_LOCK_SQL` ([inventory.repo.ts](../server/src/models/inventory.repo.ts)): the register rows
are pinned `FOR UPDATE` inside the caller's own transaction, so the unit cannot change between
"is it ours?" and "consume it".

What changed per endpoint:

| Endpoint | Before | After |
|---|---|---|
| `POST /api/sales-invoices` | Its own lock + rule loop — a second implementation of the same rule | Calls the shared gate; keeps its own claim (`SI_CLAIM_SERIAL_SQL`) because Sales Returns flips it back symmetrically |
| `POST /api/assets` (deploy-from-stock) | Looked the serial up and **silently skipped** the register flip when it was absent | The gate resolves first: unknown, wrong status or wrong branch refuses the whole request |
| `POST /api/stock-operations` (DAMAGE / PULLOUT / STOCK_OUT / CONSUMABLE_ISSUE) | Matched the **in-memory `customer_device_records` mirror**, outside the transaction — a table that no longer carries stock units | The gate resolves against `serial_log` under the operation's own lock; the demo-mode (PG-down) path runs the same rule against the register mirror, so both modes refuse identically |

**What the gate deliberately does *not* do.** It owns resolution and refusal; the lifecycle
transition stays with the module that already owns it (the sales claim, the deploy flip
`SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL`, the damage quarantine) so each keeps a symmetric reversal. The three
paths that move units between pools — pullout, consumable issue, product stock-out — were left
unresolved by Slice 2; SER-1 (§6d) now flips their units and adds the matching reversals.

**Also fixed on the way:** the deploy path wrote the asset into the in-memory register *before* its
transaction, so a now-refused deploy would have left a phantom asset behind. The mirror write moved
after the commit.

Acceptance, run through the real HTTP API against PostgreSQL 16
([tests/serialGateHttp.test.ts](../tests/serialGateHttp.test.ts), 9 checks): an unknown serial is
refused with the register's own reason and moves **no** stock and records **no** operation; a
`CUSTOMER_ASSIGNED` unit is refused by state; a unit held at another branch is refused by branch; a
valid `IN_STOCK` unit at the acting branch posts and the stock drops; and a deploy-from-stock with an
unknown serial is refused instead of silently deploying. The rules themselves are pinned by 16
unit tests ([tests/serialGate.service.test.ts](../tests/serialGate.service.test.ts)) that need no
database, covering the ordering of the checks and the exact refusal wording.

## 6d. SER-1 — operation serial lifecycle (delivered 2026-10-25)

Slice 2 left pullout, consumable issue and product sale validating a serial and
then leaving it `IN_STOCK`, so a unit could be physically gone and still sold or
deployed. Decision D2 maps each operation to a register state with a symmetric
reversal:

| Operation | Issue transition | Reversal |
|---|---|---|
| `PULLOUT` (dispatch) | `IN_STOCK → IN_TRANSIT` at the source | `POST /api/stock-operations/:id/reverse-pullout` → `IN_STOCK` at the source |
| ↳ pullout received | `IN_TRANSIT → IN_STOCK` at the destination warehouse | n/a (the dispatch can no longer be reversed) |
| `CONSUMABLE_ISSUE` | `IN_STOCK → CONSUMED` (new state) | `POST /api/stock-operations/:id/reverse-consumable` → `IN_STOCK` |
| `STOCK_OUT` (product sale) | `IN_STOCK → SOLD` | `POST /api/stock-operations/:id/reverse-stock-out` → `IN_STOCK` |

Every write sets `source_type='STOCK_OP'` and `source_id=<operation id>` and
appends a history entry. A reversal only restores rows still in the issue status
and still attributed to that operation, so a unit that has since been sold,
deployed or transferred is never dragged back into stock. A damaged-stock
pullout line returns to the damaged pool, not to usable stock. The two new
reversal routes use the same permission as the operation they undo
(`branch-pullout-dispatch`, `stock-out`); the consumable reversal keeps
`consumable-issue-reverse`.

**No historical backfill.** An old operation cannot prove whether a unit was
later returned outside the operation, so the migration deliberately leaves
historical rows untouched. Only operations posted after this change carry the
lifecycle; the on-demand reconcile (§6e) converges missing rows but leaves an
operation's own issue status alone.

A received pullout is final: once the dispatch lands at its destination the
reversal is refused (`400`, "already been received"), because the stock and the
unit already belong to the destination branch and crediting the source again
would duplicate them. The UI offers no reversal for a received dispatch; this
check makes the API agree.

Tests: [tests/serialOperationLifecycle.test.ts](../tests/serialOperationLifecycle.test.ts)
(6 pure cases) and the lifecycle HTTP cases in
[tests/serialGateHttp.test.ts](../tests/serialGateHttp.test.ts) — issue, refused
re-issue, both reversals, the wrong reversal endpoint, receive-to-destination,
and a refused reversal after receipt.

## 6e. SER-2 — on-demand reconcile, boot retired (delivered 2026-10-25)

Decision D3 keeps the converge pass but removes the boot call. It used to run on
every start, which hid unregistered legacy units (a restart silently created
their rows) and rewrote transient states nobody asked it to touch.

- **Where it lives now.** [serialBackfill.service.ts](../server/src/services/serialBackfill.service.ts)
exports `backfillSerialLog(db)`, unchanged in rule: merge all five legacy sources,
never downgrade a terminal state, refresh the in-memory register. It returns
`{ converged, inserted, upgraded }` instead of logging.
- **How it runs.** `POST /api/admin/recalculate/serial-register`, SUPER_ADMIN-only
(the route also sits under the global `/admin/` role rule), on the existing
Settings → Data Recalculation & Maintenance surface. The response carries the
counts and an audit event (`BACKFILL_SERIAL_REGISTER`) is written. It answers
`503` when PostgreSQL is unreachable, because the legacy sources are stored
documents — not the in-memory mirror.
- **Boot.** [dbBoot.ts](../server/src/boot/dbBoot.ts) no longer calls or imports it;
it logs where the action lives. Nothing in the boot path inserts register rows.

Tests: [tests/serialRegisterBackfill.test.ts](../tests/serialRegisterBackfill.test.ts)
— source guard for the boot retirement and the SUPER_ADMIN route, plus real-DB
cases for convergence (invoice → `IN_STOCK`/`PURCHASE`, damage op → `DAMAGED`,
customer device → `CUSTOMER_ASSIGNED`), idempotency (no duplicate rows), terminal
preservation (`RETURNED` survives), and HTTP gating (401 / 403 / 200).

## 7. Migration and reconciliation

- **Existing data.** Rows bought before Slice 1 have no register entry until the reconcile pass
  runs. Restarts no longer do it (§6e): a legacy database needs **one** run of
  Settings → Data Recalculation & Maintenance → **Reconcile Serial Register** after upgrading. This
  is deliberate and cheap because the pass is idempotent and never downgrades terminal states.
- **Two tables, one direction.** `serial_log` owns a unit's existence, status and branch; CDR owns
  customer assignment and stays strictly downstream (it is what the flips in §1 target). No CDR row
  may create a register row — today's UPDATE-if-exists semantics
  ([inventory.repo.ts:1036](../server/src/models/inventory.repo.ts#L1036)) are correct and should be
  kept.
- **Demo mode.** The app runs with an in-memory mirror when PG is down; every new write needs its
  mirror twin or the two modes drift (the CDR work already established `upsertCdrMirror` as the
  pattern — [cdrSerialSync.ts:65](../server/src/services/cdrSerialSync.ts#L65)).

## 8. Risks and open items

- **~~Uniqueness asymmetry.~~ Resolved in Slice 1.** `serial_log` now carries the same partial unique
  indexes CDR has — `uq_serial_log_pon_serial` and `uq_serial_log_mac_address`, both on
  `lower(trim(col))` with a `WHERE trim(col) <> ''` predicate ([schema.sql](../scripts/schema.sql)) —
  applied through a guarded `DO $$` block so a legacy database holding duplicates logs a WARNING and
  still boots. Purchase also validates PON/MAC shape before writing: the app probes for an existing
  owner per unit, and the index closes the check-then-write race those probes cannot.
  See "Slice 1 — delivered" below for the measured concurrency result.
- **Shipment dispatch is a second legitimate creation point** only if units can arrive at a branch
  without a vendor bill. The agreed contract says no; if that assumption is wrong, Slice 3 grows a
  quantity-only or admin-register path.
- **Historical rows without serials.** Quantity-tracked legacy stock has no identity to reconcile;
  it stays quantity-tracked until it is re-purchased or registered explicitly.
- **Transfer semantics inside the app** (e.g. `pullout` vs `shipment`) must agree on which documents
  move a register row, or Slice 3 leaves a second blind path.

## 9. Verification status of this document

- Read-only; no project file was modified to produce it. The register was probed live
  (`GET /api/serial-log`: 15 rows served) and the dev database's purchase invoices were compared
  against it (3 demo invoices, all quantity-tracked, none carrying device serials).
- Because no serial-tracked purchase exists in the dev database, the "purchasing does not register"
  finding is proven by exhaustive code search (no `INSERT INTO serial_log` outside the then-boot
  backfill — since moved to the maintenance service — the rename path and the demo seed, plus the
  two dead exported helpers), **not** by reproducing the
  failure end to end. Reproducing it live is the first acceptance test of Slice 1.
- The earlier CPE/device-actions work remains as recorded in
  [cpe-actions-audit.md](cpe-actions-audit.md) and
  [stock-ledger-accuracy-audit.md](stock-ledger-accuracy-audit.md); this document supersedes nothing
  there except the claim that purchase receipts populate the register.
