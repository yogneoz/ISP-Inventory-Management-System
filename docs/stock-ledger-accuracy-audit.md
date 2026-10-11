# Stock Movement Ledger — Calculation & Accuracy Audit

_Date: 2026-10-11 · Gates: `tsc --noEmit` clean · 679/679 tests green · docs-count gate green · `npm run build` green_

Scope: every operation that moves inventory was traced from HTTP handler → SQL/mirror
mutation → `transaction_logs` row → the client Stock Movement Ledger matrix, and fixed
where the arithmetic or the ledger row was wrong.

## Defects found and fixed

### 1. Customer-device assignment double-deducted stock and wrote no ledger row
([inventory.controller.ts](../server/src/controllers/inventory.controller.ts), [inventory.repo.ts](../server/src/models/inventory.repo.ts))

Assigning a customer device (CDR) consumed a unit twice when the same deployment had
already consumed it through the fixed-asset deploy-from-stock path, and the assignment
never wrote a movement-ledger row at all. Now:

- `CDR_ASSET_DEPLOY_PROOF_SQL` proves the unit was already consumed by the asset deploy
  (`serial_log` attribution + the deterministic `txn-asset-<assetId>` ledger row); when it
  matches, no second deduction happens.
- Assignments that do consume a unit write a real `STOCK_OUT` ledger row with
  `before + changed = after` taken from the guarded UPDATE's `RETURNING` balance.
- Releases credit stock through `CDR_ASSIGNMENT_STOCK_RETURN_SQL` (upsert + `RETURNING`)
  and write the compensating positive row.

### 2. DISPOSAL wrote no stock movement; MANUAL_ADJUSTMENT never applied stock
([inventory.controller.ts](../server/src/controllers/inventory.controller.ts))

`post_stockOperations` treated DISPOSAL and MANUAL_ADJUSTMENT as log-only: DISPOSAL
recorded a ledger row but never touched the damaged pool, and a negative manual
adjustment never deducted QOH. Now both are first-class stock-consuming operations:

- **DISPOSAL** draws from the **damaged pool** (`STOCK_RELEASE_DAMAGED_SQL`, guarded on
  `damaged_qty`) — quantity_on_hand never held those units. Its ledger row carries the
  damaged-pool before/after.
- **MANUAL_ADJUSTMENT** applies its signed quantity: negative consumes QOH (guarded),
  positive credits QOH via upsert (materialising the branch row when needed). Zero-delta
  adjustments write no ledger row (no movement happened).
- The lock-and-re-verify pass (`STOCK_LOCK_FOR_UPDATE_SQL`) now covers both types, and the
  serial-register checks are scoped to types that actually draw serialized units.

### 3. Pullout-bin receipt credited nothing in demo mode and wrote no ledger row
([inventory.controller.ts](../server/src/controllers/inventory.controller.ts))

`POST /api/stock-operations/:id/receive` credited destination warehouse stock only on the
PG path; without PG the status flipped but stock silently vanished. Both paths now:

- credit the destination warehouse (upsert for missing rows),
- lock the destination rows in the PG transaction and write `TRANSFER_IN` ledger rows with
  the true before/after,
- mirror the same rows into `transactionLogs` in demo mode (deduped by id).

### 4. Inter-branch transfers moved stock without any ledger rows
([shipments.controller.ts](../server/src/controllers/shipments.controller.ts), [shipments.repo.ts](../server/src/models/shipments.repo.ts))

Dispatch, receipt, cancellation and receipt-undo all mutated `inventory_stock` but wrote
zero movement-ledger rows, and three of the four never updated the in-memory mirror at
all (demo mode kept stale stock forever). Now every leg writes its ledger row with
balances read from the row **locked in the same transaction**
(`SHIPMENT_STOCK_LOCK_SQL`):

| Leg | change_type | Direction |
|---|---|---|
| Dispatch (create INTER_BRANCH) | `TRANSFER_OUT` | source QOH −qtySent |
| Receive | `TRANSFER_IN` | destination QOH +receivedQty |
| Cancel | `TRANSFER_CANCELLED` | source QOH +qtySent (restore) |
| Undo receipt | `TRANSFER_RECEIPT_CANCELLED` | destination QOH −receivedQty |

All four also mirror stock and ledger rows in memory, so demo mode reconciles. The
`change_type` union in [client types](../client/src/types/index.ts) gained `TRANSFER_OUT`
/ `TRANSFER_IN` (already allowed by the schema CHECK).

### 5. Invoice/return ledger rows carried placeholder balances and cancels were invisible
([sales.repo.ts](../server/src/models/sales.repo.ts), [procurement.repo.ts](../server/src/models/procurement.repo.ts),
[sales.controller.ts](../server/src/controllers/sales.controller.ts), [procurement.controller.ts](../server/src/controllers/procurement.controller.ts))

- **Real before/after.** `PI_/SI_/SR_/PR_TXN_LOG_SQL` hardcoded `quantity_before = 0` and
  `quantity_after = quantity_changed`. All four stock statements (receive, deduct,
  restock, re-deduct) now `RETURNING quantity_on_hand`, and the param builders take the
  true pre-movement balance (`before = after ∓ qty`), so every row satisfies
  `before + changed = after`. Without a balance (legacy call sites) they degrade to the
  old placeholder shape rather than inventing a number.
- **PI delete now reverses the ledger.** Deleting a purchase invoice restored stock but
  left the original `PURCHASE_INVOICE` rows overstating the ledger forever. It now writes
  `PURCHASE_INVOICE_CANCELLED` mirror rows (positive, real balances) inside the same
  transaction.
- **PR cancel / SR cancel likewise.** Cancelling a posted purchase (sales) return
  restores stock but wrote no row; both now write `PURCHASE_RETURN_CANCELLED` /
  `SALES_RETURN_CANCELLED` negative/positive mirrors with real balances.
- **Non-restockable sales returns no longer fake a restock.** The old unconditional
  `+qty` `SALES_RETURN` row claimed units entered sellable stock when they were actually
  routed to the damage register. The QOH ledger row is now written only for restockable
  returns; non-restockable units are carried by the damage-register sub-ledger.
- Schema: three compensating change types added to the `transaction_logs` CHECK via a new
  idempotent v3.5 migration block in [schema.sql](../scripts/schema.sql) (no-op on fresh
  installs).

### 6. Stock-operation ledger rows trusted a stale mirror
([inventory.controller.ts](../server/src/controllers/inventory.controller.ts))

`post_stockOperations` drafted its ledger rows from the in-memory mirror before opening
the transaction, so concurrent writers could produce wrong `quantity_before`/`after`.
Inside the PG transaction, after `SELECT … FOR UPDATE`, every row's before/after is
rebuilt from the **locked DB truth** (`before + changed = after` restored under
concurrency).

### 7. Physical-audit reconciliation wrote no ledger rows in demo mode
([inventory.controller.ts](../server/src/controllers/inventory.controller.ts))

The non-PG branch of `post_reconcileAudit` moved stock to the counted quantity but wrote
no `PHYSICAL_AUDIT_EXCESS/SHORTAGE` rows. It now writes the same rows the PG path
persists, with real before/after, and skips zero-variance lines.

### 8. Client ledger matrix mis-bucketed movement types
([StockMovementLedger.tsx](../client/src/features/inventory/StockMovementLedger.tsx))

The summary matrix classified movements by an allow-list that predated the new change
types: `TRANSFER_OUT/TRANSFER_IN`, `TRANSFER_CANCELLED/TRANSFER_RECEIPT_CANCELLED` and
`PHYSICAL_AUDIT_*` rows fell into **no** bucket (their quantity silently vanished from
Received/Delivered), and DISPOSAL was never bucketed. Classification is now **sign-based**:

- `DISPOSAL` → skipped (damaged-pool write-off, no QOH effect),
- `DAMAGE` → Damaged column (unchanged),
- positive `quantityChanged` → Received,
- negative `quantityChanged` → Delivered.

Every change type the server can now emit lands in a bucket, and
`opening + received − delivered − damaged = closing` reconciles with live stock.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — 679/679 green (7 new tests: true before/after for PI/SI/SR/PR rows, the
  three cancel mirror builders, and the `RETURNING` contracts; existing placeholder-shape
  tests updated to the 14-bind layout).
- Docs-count gate — all current-state test counts match 679.
- `npm run build` — vite + esbuild succeed (pre-existing `import.meta` cjs warning in
  dbBoot unchanged).

## Known remaining gaps (noted, not fixed here)

- Demo-mode (no-PG) invoice/return creates still don't write ledger rows — only the PG
  path does for the finance module. Stock operations and transfers are now demo-complete.
- `unit_cost` on SI/PR rows is the document unit price, not the product cost price; the
  matrix values use `costPrice`, so per-row Movement Value can differ from the matrix's
  valuation basis.
- Legacy pre-fix ledger rows in existing databases keep their placeholder 0/N balances;
  only new rows carry true balances.
