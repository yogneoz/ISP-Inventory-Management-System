# Serial input & inventory-operations audit — proposed improvements

_Date: 2026-10-19 · Status: **DELIVERED (slices A–F)** — see §9 for what shipped_

This note answers the four requests:

1. Purchase: Device Serial + MAC mandatory, PON field kept but optional.
2. A MAC typed/scanned without separators is formatted to canonical form.
3. Every other operation captures **one** field (Device Serial); PON and MAC are
   resolved from the serial register and shown read-only.
4. Audit which operations really maintain branch quantity/value, and whether
   availability is checked before bins/transfers are created.

It builds on the two existing audits — [serial-register-audit.md](serial-register-audit.md)
(Slices 1–2 delivered; Slices 3–5 open) and
[stock-ledger-accuracy-audit.md](stock-ledger-accuracy-audit.md) — and re-checks
the current code rather than repeating their claims.

---

## 0. Verdict

| Request | Current state | Verdict |
|---|---|---|
| 1. Purchase = Device + MAC mandatory, PON optional | PON **and** MAC were both rejected when blank for `SERIAL_MAC_PON`, client and server | **Delivered** (§8B) |
| 2. Normalize MAC barcodes | No normalizer existed: lookup and uniqueness compared raw text, so `A4C3F0…` and `A4:C3:F0:…` were different devices | **Delivered** (§8A) |
| 3. One Device Serial field everywhere else | 13 screens asked for Device + PON (+MAC); four screens **invented** serials with random generators; the server demanded PON, so a one-field UI could not post | **Delivered** (§8C/§8D) |
| 4. Quantity/value + availability before bins/transfers | Quantity and ledger value are maintained and guarded end-to-end, **but** transfers never moved `serial_log`, shipment dispatch had no server-side serial validation, and the client availability check was per-line | **Delivered** (§8E/§8F) |

---

## 1. Purchase form (request 1)

**Where:** [PurchaseInvoiceForm.tsx](../client/src/features/procurement/PurchaseInvoiceForm.tsx)
(validation ~L448–475, UI ~L959–1060) and
[serialRegister.service.ts](../server/src/services/serialRegister.service.ts#L79-L140).

Current rule, enforced twice:

```ts
const strict = requiresPonAndMac(product);   // trackingType === 'SERIAL_MAC_PON'
if (strict && !pon) → "PON serial is required…"
if (strict && !mac) → "MAC address is required…"
```

The form also seeds every unit slot with `{ deviceSerial, ponSerial }` — **no
`macAddress` key at all** — so the MAC input renders empty even though the
validator demands it. That is the direct cause of the "I have to type three
things" experience.

**Proposed rule**

| `trackingType` | Device Serial | MAC | PON |
|---|---|---|---|
| `SERIAL_MAC_PON` | required | **required** | optional (field always visible, saved as `null` when blank) |
| `SERIAL_ONLY` | required | not shown | not shown |
| `QUANTITY_ONLY` | no serial UI | — | — |

Changes:

- Client: `requiresPonAndMac` becomes `requiresMac`; remove the PON-required
  branch; seed slots with all three keys; label the PON input
  "PON Serial # (optional)"; keep Tab/Enter order Device → MAC → PON.
- Server: `planPurchaseSerialEntries` drops the PON-required rejection, keeps
  the MAC-required one for `SERIAL_MAC_PON`, keeps duplicate detection for
  non-empty PON/MAC, and stores `ponSerial: null` when blank (the DB indexes are
  already partial, so blanks stay legal).
- Tests: `tests/serialRegister.service.test.ts` — invert the "no PON" case
  (now accepted), keep "no MAC" rejected, add "PON blank stores null".

**Not changing:** purchase remains the only screen allowed to create a
`serial_log` row (Slice 1 contract).

---

## 2. MAC normalization (request 2)

**Where:** none exists. Comparison sites that today see raw strings:

- [inventory.repo.ts `buildSerialLookupSql`](../server/src/models/inventory.repo.ts#L939-L995) —
  `lower(trim(mac_address)) = lower(trim($1))`
- [serialGate.service.ts `findGateViolation`](../server/src/services/serialGate.service.ts#L198-L235) —
  `String(row.macAddress).trim().toUpperCase() !== entry.macAddress.toUpperCase()`
- [StockOperations.tsx:273](../client/src/features/inventory/StockOperations.tsx#L273) and
  [SalesInvoices.tsx:430](../client/src/features/sales/SalesInvoices.tsx#L430) — client-side
  pair matching, also raw.
- Unique indexes `uq_serial_log_mac_address` / `uq_customer_device_mac_address`
  on `lower(trim(col))` — format-sensitive.

**Proposed normalizer** (one pure implementation, mirrored client/server the
same way BS calendar data is shared):

```
input: "a4c3f0b1d2e3", "A4-C3-F0-B1-D2-E3", "a4c3.f0b1.d2e3", "A4:C3:F0:B1:D2:E3"
rule : strip non-hex separators; if exactly 12 hex digits →
       uppercase, grouped as XX:XX:XX:XX:XX:XX
else : return trimmed input unchanged (never mangle a non-MAC PON/barcode)
```

Applied at four boundaries:

1. **Entry** — purchase MAC field formats on blur/Enter (and scans, which arrive
   as a burst followed by Enter).
2. **Write** — `planPurchaseSerialEntries` stores the canonical value.
3. **Read/compare** — gate and client comparisons canonicalize both sides, so a
   register row bought before this change still matches.
4. **Lookup** — when the query parses as a MAC, also match
   `regexp_replace(lower(trim(mac_address)), '[^0-9a-f]', '', 'g') = $hex`,
   so typing the barcode form finds the colon-form row.

Regression risk is low: values that already parse canonicalize to themselves.

---

## 3. One Device Serial field everywhere else (request 3)

### 3.1 The screens that capture serials today

| # | Screen | Current fields | Identity source | Notes |
|---|---|---|---|---|
| 1 | Purchase invoice | Device + PON + MAC | operator types; register is created here | the only legitimate writer |
| 2 | Sales invoice | Device + PON + MAC | register-validated | server `requirePon: true` |
| 3 | Create shipment / inter-branch transfer | Device + PON | **randomly generated** | [CreateShipmentForm.tsx:90](../client/src/features/procurement/CreateShipmentForm.tsx#L90) |
| 4 | Assign fixed asset (deployment bin) | Device + PON + MAC | **random SN/PON + constant MAC** | [AssignAssetPanel.tsx:124](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L124) |
| 5 | Device exchange | New Device + PON (+MAC) | **random** 🎲 buttons, checked against CDR not register | [DeviceExchangePanel.tsx:192](../client/src/features/inventory/stockops/DeviceExchangePanel.tsx#L192) |
| 6 | Customer device assignment | Device + PON (+MAC) | **random** 🎲 button; hardcoded product list; no register check; POSTs straight to CDR | [CustomersManagement.tsx:428](../client/src/features/sales/CustomersManagement.tsx#L428) |
| 7 | Create pullout | Device + PON | typed | context has `serialRegister` |
| 8 | Label damage | Device + PON | typed | context has `serialRegister` |
| 9 | Product sale (stock op) | Device + PON | typed | context has `serialRegister` |
| 10 | Create transfer (stock op) | Device + PON | typed | context has `serialRegister` |
| 11 | Receive transfer | displays pairs, tick-off | read-only | [ReceiveTransferPanel.tsx:621](../client/src/features/inventory/stockops/ReceiveTransferPanel.tsx#L621) |
| 12 | Receive inbound warehouse | displays pairs | read-only | — |
| 13 | Serial log register | dual correction | lookup (privileged) | the only real lookup today |

### 3.2 Why one field cannot work yet

- **Server demands PON on sales** — [sales.controller.ts:213](../server/src/controllers/sales.controller.ts#L213)
  calls `planSerialGateEntries(..., { requirePon: true })` and the gate rule is
  `requirePon: true`. A device-serial-only payload is refused `400`.
- **Server demands PON on `SERIAL_MAC_PON` stock ops** — `planSerialGateEntries`
  includes `requiresPon(product)` at
  [serialGate.service.ts:175](../server/src/services/serialGate.service.ts#L175).
- **Three panels match the (device, PON) pair**, not the device alone
  ([AssignAssetPanel.tsx:197](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L197),
  [DeviceExchangePanel.tsx:69](../client/src/features/inventory/stockops/DeviceExchangePanel.tsx#L69),
  [CreateShipmentForm.tsx:236](../client/src/features/procurement/CreateShipmentForm.tsx#L236)), so
  an autofilled PON must be treated as read-only truth rather than a second key.
- **The existing lookup endpoint is privileged** —
  `GET /api/inventory/serials/lookup` requires `edit-device-serials`
  ([inventory.routes.ts:63](../server/src/routes/inventory.routes.ts#L63)), which
  branch/front-desk roles do not hold. It cannot be the autofill source.
  `GET /api/serial-log` is the right source: role-gated for all operating roles,
  branch-scoped server-side ([inventory.controller.ts:2689](../server/src/controllers/inventory.controller.ts#L2689)),
  and already supports `branchId`, `status`, `query`.

### 3.3 Proposed contract — device serial is the only key

**Server (authoritative).** After the register rows are locked, fill each
entry's PON/MAC from the locked row when the client sent blank. Then:

- remove `requirePon` from sales and from `planSerialGateEntries`;
- keep `PON_MISMATCH` / `MAC_MISMATCH` only for values the client *did* send
  (defence in depth; the new UI sends none);
- keep UNKNOWN / WRONG_STATUS / WRONG_BRANCH / WRONG_PRODUCT unchanged.

This is a small, testable service change (`hydrateSerialEntries`) plus rule
changes in `serialGate.service.ts`, `sales.controller.ts`,
`inventory.controller.ts`. It means an older client that still sends PON keeps
working, and a phone-scanner client can send only the device serial.

**Client (UX).** One reusable component, `DeviceSerialInput`, used by screens
2–10:

- one text input, autofocus, Enter submits/advances to the next unit;
- on Enter/blur/paste, resolve against:
  - the in-memory `serialRegister` where the screen already has it
    (stock ops panels, Assign Asset, Sales), or
  - `GET /api/serial-log?branchId=…&status=IN_STOCK&query=<serial>` for screens
    without a register prop (Create Shipment, Device Exchange, Customer
    Assignment), debounced and exact-matched on `deviceSerial`;
- fills read-only PON and MAC chips; shows an inline state:
  `✓ IN_STOCK · PON … · MAC …`, `✗ not in this branch`, `✗ already CUSTOMER_ASSIGNED`;
- submits `{ deviceSerial }` only. PON/MAC stay in the payload as display data
  where an existing receipt/return path needs them, but are never typed.
- MAC normalization applies to the resolved value, so the chip is canonical.

**Remove every generator.** `Math.random()` serial/PON/MAC blocks disappear from
CreateShipmentForm (3 sites), AssignAssetPanel (2), DeviceExchangePanel (2),
CustomersManagement (3). No screen may fabricate hardware identity.

**Customer assignment exception.** That modal also lets the operator type a
customer and a product label. It becomes: pick the branch's IN_STOCK unit by
device serial → PON/MAC resolved → product taken from the register row (the
hardcoded ONU/IPTV dropdown is removed). This also closes the current drift
where CDR can name a serial the register never received
(`SERIAL_LOG_SYNC_ON_CDR` is UPDATE-if-exists and silently no-ops).

---

## 4. Inventory quantity/value and availability audit (request 4)

### 4.1 What is genuinely maintained (verified)

| Operation | Quantity | Value / ledger | Server guard |
|---|---|---|---|
| Purchase invoice | `PI_RECEIVE_STOCK_SQL` + `serial_log` rows in one transaction | ledger row with real before/after and cost | transaction rollback on serial refusal |
| Sales invoice | stock deduct + serial claim in one transaction | ledger row, cost from product | `resolveSerialGateInDb` + stock guard |
| Stock operations (damage/pullout/sale/consumable/disposal/manual) | guarded UPDATEs, `FOR UPDATE` re-check under lock | `transaction_logs` with locked before/after | shared serial gate + guarded SQL |
| Inter-branch transfer dispatch | `SHIPMENT_DEDUCT_SOURCE_SQL` **guarded** `quantity_on_hand >= $1` | `TRANSFER_OUT` with locked before/after | row lock + `rowCount` check |
| Transfer receive | `SHIPMENT_RECEIVE_STOCK_SQL` (incoming → on-hand) | `TRANSFER_IN` | row lock |
| Transfer cancel / undo receipt | restore source / debit destination, guarded on undo | `TRANSFER_CANCELLED` / `TRANSFER_RECEIPT_CANCELLED` | row lock + `rowCount` |
| Customer device assignment | consumes stock (double-deduct proof against asset deploy) | `STOCK_OUT` | guarded UPDATE |
| Assignment release | `CDR_ASSIGNMENT_STOCK_RETURN_SQL` | compensating row | — |
| Physical audit reconciliation | count variance → stock | `PHYSICAL_AUDIT_*` | — |

Value is preserved across a transfer: `buildTransferTxn` takes
`item.unitCost ?? product.costPrice`
([shipments.controller.ts:28](../server/src/controllers/shipments.controller.ts#L28)),
so no revaluation happens on dispatch/receive. Ledger rows satisfy
`before + changed = after` from locked balances.

**Valuation caveat.** The transfer line is not required to carry the cost that
was actually paid; the fallback is the *current* product cost price. If a
product's cost price changes between purchase and transfer, historical branch
value reads at the new cost. Low impact for a transfer (both branches use the
same number) but worth fixing by carrying `unitCost` into the shipment line.

### 4.2 Gaps found

**G1 — Transfers never move the serial register (Slice 3, still open).**
[shipments.controller.ts](../server/src/controllers/shipments.controller.ts) has **no**
`serial_log` handling at all. After a dispatch:

- `inventory_stock` at the source drops;
- `serial_log` still says the unit is `IN_STOCK` **at the source branch**;
- at the destination the unit is invisible to the serial register, so it cannot
  be sold/deployed there (register says another branch) even though stock shows
  it on hand.

Consequences: serial search/history is wrong, the destination cannot fulfil a
serial sale, and the lifecycle has no `IN_TRANSIT` record for a real transfer.

Proposed transitions, inside the existing transactions (same shape as sales'
claim and its symmetric reversal):

| Leg | Register transition |
|---|---|
| Dispatch | source row `IN_STOCK → IN_TRANSIT`, branch stays source |
| Receive (full) | `IN_TRANSIT → IN_STOCK`, branch = destination, history entry |
| Receive (partial/discrepancy) | received units land at destination; **undelivered units stay `IN_TRANSIT`** at source so they can still be cancelled/traced |
| Cancel dispatch | `IN_TRANSIT → IN_STOCK`, branch source |
| Undo receipt | destination `IN_STOCK → IN_TRANSIT`, branch source |

Dispatch must also refuse a serial-tracked line whose device-serial count does
not equal `quantitySent`, and resolve each unit through the shared gate at the
source branch — today the **server accepts any items payload**.

**G2 — Serialized bin lines can consume N units with one identity.**
[AssignAssetPanel.tsx:232](../client/src/features/inventory/stockops/AssignAssetPanel.tsx#L232)
loops `item.quantity` times but only `unitIdx === 0` carries the serial; the
rest become quantity-only assets. So 5 units of an ONU can leave stock with one
serial recorded. Fix: a serialized line is quantity 1 (repeat the line for more
units), enforced in the panel and in `post_assets`.

**G3 — Availability is checked per line, not per product.**
`validateSourceBranchStockAndSerials`
([StockOperations.tsx:273](../client/src/features/inventory/StockOperations.tsx#L273)) and the
Assign Asset per-line check compare each line against the **whole** branch
balance. Two lines of the same product, 5 + 5 with 5 in stock, both pass. The
guarded SQL then rejects the second write, but the operator sees
`Database error: Insufficient stock …` (`500`), not a clear `400`. Fix: aggregate
requested quantity per `productId` (+ damaged/usable pool) before validating, in
the client helper, the shipment create path, `post_assets`, and the locked
re-check in `post_stockOperations`; return `400` with available/requested.

**G4 — Customer device assignment bypasses the register.**
[CustomersManagement.tsx:428](../client/src/features/sales/CustomersManagement.tsx#L428) only
checks that Device and PON are non-empty. It can assign a unit that is not
`IN_STOCK`, not at that branch, or not in the register at all; the CDR sync is
UPDATE-if-exists, so the register is not corrected either. Covered by the
one-field picker in §3.3, plus a server-side gate in `post_customerDevices`.

**Checked and not a gap:** disposal (`DISPOSAL`) intentionally draws the damaged
pool, not QOH; damaged pullouts are excluded from the QOH ledger by design;
zero-delta manual adjustments write no ledger row; `post_reverse` and
`post_reverseConsumable` restore both stock and quarantine state.

---

## 5. Proposed delivery slices

Each slice is independently shippable and verifiable.

### Slice A — MAC canonicalization (small)
- New `normalizeMacAddress` in a shared module + client re-export.
- Apply at purchase entry/write, gate comparisons, client pair matches, lookup.
- Tests: 12-hex with/without separators, mixed case, 11/13 digits untouched,
  non-hex untouched, idempotence.

### Slice B — Purchase field policy
- Device + MAC required, PON optional, for `SERIAL_MAC_PON`; `SERIAL_ONLY`
  unchanged.
- Client validation/UI, server `planPurchaseSerialEntries`, tests.
- Acceptance: post one bill with MAC and no PON → `serial_log` row has the MAC
  and `pon_serial = NULL`; blank MAC is refused `400` and nothing posts.

### Slice C — Server hydration + one-field contract
- `hydrateSerialEntries(rows, entries)` fills blank PON/MAC from locked rows.
- Drop `requirePon` from sales and stock-op planning.
- Gate rules keep mismatch checks only for supplied values.
- Tests: device-only sale posts and claims the register row; a wrong PON sent by
  an old client is still refused; stock op with device only posts.

### Slice D — Shared `DeviceSerialInput` + remove generators
- One component/hook; adopt on sales, shipment, transfer, pullout, label damage,
  product sale, assign asset, exchange, customer assignment.
- Delete all random serial/PON/MAC generation (10 call sites).
- Read-only PON/MAC chips; inline register status; MAC formatted.
- Acceptance: on each affected screen, typing only the device serial fills PON
  and MAC, and no screen can submit a serial the register has never seen.

### Slice E — Transfer register integrity
- Dispatch/receive/cancel/undo transitions from §4.2 G1, PG + in-memory mirror.
- Server-side serial planning for dispatch (count = `quantitySent`, gate at
  source) and receive (only dispatched serials, at destination).
- Acceptance: warehouse→branch transfer shows `IN_TRANSIT` at source, then
  `IN_STOCK` at destination; mid-transit the unit is not sellable anywhere;
  cancel returns it to `IN_STOCK` at source; undo receipt returns it to
  `IN_TRANSIT`.

### Slice F — Availability hardening
- Aggregate per-product availability check (client + all server paths), `400`
  responses instead of `500`, serialized bin lines fixed to quantity 1.
- Acceptance: two lines of the same product cannot oversubscribe in the UI or
  by API; assign-asset of 2 serialized units requires 2 lines/serials.

### Slice G — Docs & reconciliation
- Update `serial-register-audit.md` (Slices 3–4 delivered), `handoff.md`,
  test-count docs; expose the legacy serial backfill as a maintenance action.

---

## 6. Files touched (as delivered)

**Shared / server**
- `shared/macAddress.ts` (new) — ONE normalizer imported by both the client
  bundle and the server (the draft planned two mirrored files; sharing the
  module is what keeps the duplicate gate and the UI in agreement)
- `server/src/services/serialRegister.service.ts` — MAC required, PON optional,
  canonical write
- `server/src/services/serialGate.service.ts` — hydration, no blanket PON
  requirement, canonical MAC comparison
- `server/src/utils/operationError.ts` (new) — 400-with-numbers refusals
- `server/src/controllers/sales.controller.ts` — drop `requirePon`
- `server/src/controllers/inventory.controller.ts` — gate rules, aggregate
  checks, `post_assets`, `post_customerDevices` gate
- `server/src/controllers/shipments.controller.ts` + `server/src/models/shipments.repo.ts`
  — register transitions, serial planning, aggregate guard

**Client**
- `client/src/components/common/DeviceSerialInput.tsx` (new)
- `PurchaseInvoiceForm.tsx`, `SalesInvoices.tsx`, `CreateShipmentForm.tsx`
- `StockOperations.tsx` + `stockops/{CreateTransferPanel, CreatePulloutPanel, LabelDamagePanel, ProductSalePanel, AssignAssetPanel, DeviceExchangePanel}.tsx`
- `CustomersManagement.tsx`
- `client/src/types/index.ts` (serial entry type: MAC optional, PON optional)

**Tests**
- New `tests/macAddress.test.ts`
- `tests/serialRegister.service.test.ts` (PON optional, MAC required, canonical MAC)
- `tests/serialGate.service.test.ts` (hydration, no PON requirement, mismatch)
- `tests/shipments.repo.test.ts` (transfer register legs)
- `tests/registerRefreshDomains.test.ts` (new API surface stays wired)

---

## 7. Decisions (answered before implementation)

1. **PON semantics at purchase** — keep the column and store `NULL` when blank.
2. **Partial transfer receipt** — undelivered units stay `IN_TRANSIT` at the
   source, so they remain traceable and cancellable.
3. **Customer assignment product** — taken from the register row; the hardcoded
   ONU/IPTV dropdown is gone.
4. **Scope** — slices A–F implemented in one pass (A–D the four requests, E
   transfer register integrity, F availability hardening); G (docs) closed with
   this revision.

## 8. What shipped (slices A–F)

**A — MAC canonicalisation.** New one shared module
[shared/macAddress.ts](../shared/macAddress.ts) (`normalizeMacAddress`, `macKey`,
`isMacAddress`), imported by the client and the server exactly like
`shared/bsCalendarYears.json`. Applied at purchase entry (blur/Enter), server
write (`planPurchaseSerialEntries`), gate comparisons, sales verification and
lookup-by-MAC. `tests/macAddress.test.ts` pins the separator/case/idempotence
cases.

**B — Purchase field policy.** `requiresPonAndMac` → `requiresMac`. MAC is
required for `SERIAL_MAC_PON`; PON is an optional third field and is stored as
`null` when blank. The form's per-unit slots now seed `macAddress` (they never
had one, which is why the MAC box was demanded but empty), the punch order is
Device → MAC → PON, and the MAC input canonicalises on blur/Enter/submit.

**C — One device key, server-hydrated.** `serialGate.service` gained
`hydrateSerialEntries(entries, rowsByKey)`: after the register rows are locked,
blank PON/MAC are filled from the row before any rule runs. The blanket
`requirePon` was removed from `planSerialGateEntries` and from the sales path, so
a device-serial-only payload is complete. A PON/MAC the caller really did send
is still checked (defence in depth), and MAC comparison is now canonical.

**D — One-field UX.** New
[DeviceSerialInput](../client/src/components/common/DeviceSerialInput.tsx) (with
the shared `findRegisterRow` / `classifyRegisterRow` helpers): one input, Enter
chaining, inline `IN_STOCK · PON … · MAC …` / refusal state. Adopted on sales
invoices, shipment create, stock-op pullout/transfer/damage/product-sale, assign
fixed asset, device exchange (stock ops), customer assignment and CPE
exchange. **Every random serial/PON/MAC generator is gone** (Create Shipment ×3,
Assign Asset ×2, Device Exchange ×2, Customers Management ×3, plus the modal
pre-fills); customer assignment now derives product, PON and MAC from the
register row.

**E — Transfer register integrity.** `shipments.controller` now moves
`serial_log` on all four legs, inside the existing transactions and mirrored in
demo mode: dispatch `IN_STOCK → IN_TRANSIT` (gate-resolved at the source),
receive `IN_TRANSIT → IN_STOCK` at the destination, cancel `IN_TRANSIT →
IN_STOCK` at the source, undo-receipt `IN_STOCK → IN_TRANSIT`. The received
serials are recorded per item, so a partial receipt leaves the undelivered units
in transit. Dispatch plans the units through the shared gate, so the server —
not only the UI — refuses a serial-tracked line with no device serials.

**F — Availability hardening.** Availability is now aggregated PER PRODUCT (and
pool) in the client validator, the shipment create path, `post_assets` and the
locked re-check in `post_stockOperations`; refusals surface as `400` with
available/requested numbers via the new
[OperationError](../server/src/utils/operationError.ts) instead of a generic
`500`. A serialized Assign-Asset line is locked to quantity 1 so N units can no
longer leave stock with one serial. `post_customerDevices` also resolves the
assigned unit through the shared gate (IN_STOCK at the branch), closing the
last screen that could name a serial the register never received.

### Verification

- `npx tsc --noEmit` — clean.
- `NODE_ENV=test npx tsx --test tests/*.test.ts` — **901 tests, 899 pass, 0 fail,
  2 skipped** (the two pre-existing Windows-only real-signal checks).
- Docs-count gate — 3 docs scanned, all current-state counts match 901.

### Closed after the first pass (2026-10-20)

- `post_exchange` no longer trusts the client's replacement serial. The
  replacement must be an `IN_STOCK` register row of the fulfilling branch
  (`serialGate` pre-flight, then the same rule with `FOR UPDATE` inside the
  transaction), a blank PON/MAC is hydrated from that row, and the mirror writes
  are rolled back when PG refuses. The PG-contract test now seeds a real
  register row instead of posting a serial that existed only in the request.
  Covered by `tests/mirrorStep3.test.ts` in both directions: an IN_STOCK
  replacement succeeds and takes the register's MAC, a `CUSTOMER_ASSIGNED` one
  is refused `400` with no customer-device row written.

### Residual / deliberately not changed

- Notification/approval paths that carry serials (`ApprovalWorkflowCenter`
  display, receive-verification checklist) remain display-only.

## 9. Approval

Approved 2026-10-19 and implemented as above. Slices A–F landed together with
their tests; no application code outside the files listed in §6 was touched.
