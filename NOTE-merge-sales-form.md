# NOTE — "Product Sale to Customer" form merge (SalesInvoices.tsx)

Status: **DONE** (2026-10-04). See "Verification" at the bottom.

## Task
Bring the "Product Sale to Customer" (Sell-to-Customer) form into a single **"Sell to Customer"** form owned by
`client/src/features/sales/SalesInvoices.tsx`. The merged form sends exactly the payload
`POST /api/sales-invoices` expects, lets the server issue the `INV-…` document number, deducts stock atomically,
and — as of this pass — **refuses to post a serial that is not in inventory**.

Per instruction, the old product-sale block in `StockOperations.tsx` was **kept, not deleted**; it stays until
the merge is approved for removal.

---

## 1. Register-refresh wiring (found by the audit)
`npm test` was red on 3 tests in `tests/registerRefreshDomains.test.ts` plus a `tsc` error at `App.tsx(619)`:

| Problem | Fix |
| --- | --- |
| `registerRefresh` initializer had 4 of 7 `RegisterRefreshKey`s | all 7 keys added |
| 4 `<ReturnsRegister>` render sites missing `sseRefreshKey` | `sseRefreshKey={registerRefresh.returnsRegister}` ×4 |
| `<SalesInvoices>` never self-fetched its paged data | converted to the `PurchaseInvoices` paged pattern: `loadSiPage` → `api.getSalesInvoices({ branchId, query, page, pageSize })`, seq guard, `useEffect(() => { loadSiPage(); }, [loadSiPage, siRefreshKey, sseRefreshKey])`, page snap on filter change, prop fallback on fetch error |
| 2 `<SalesInvoices>` render sites unwired | `sseRefreshKey={registerRefresh.salesInvoices}` ×2 |

---

## 2. The form itself

### Layout (realigned to the Product Sale to Customer table)
- **`ProductSearchBar`** (imported from `../inventory/ProductSearchBar`) replaces the `<select>` picker:
  scan barcode / search SKU / name, Enter picks the exact SKU or barcode match, and stock badges
  (Usable / Damaged / Out of stock) show for the chosen branch.
- **Multi-item**: `addOrIncrementProduct` re-scans the same product into the same line (`qty + 1`, plus one more
  serial slot) and starts a new line for anything else — the exact `handleAddSellItem` behaviour.
- Real `<table>`: Product Name · Branch Stock · Sale Qty · Unit Price (NPR) · Discount (NPR) · Subtotal (NPR) ·
  Action, with an empty-state panel and an **Add Product to Invoice** button.
- **Arrangement below the product bin (in order):**
  1. **Notes** (multi-line `<textarea rows={4}>`, resizable) side by side with the
     **POS-counter bill panel** — compact mono rows (Gross · Discount · Taxable · Non-taxable · VAT) with a
     pinned, oversized **Total** at the bottom;
  2. a separate row of **Payment Method** + **Amount Paid** directly under them;
  3. error banner, then Clear / Post Invoice.
- VAT is computed on the *discounted* net so the preview matches the server's `computeBillTotals`.
- Products are filtered to the `Product Item` group (`saleEligibleProducts`), same as the old form.

### Invoice date: today only
`invDateAD` may be **neither past nor future** — only today. Enforced three ways:
`min={todayAD}` + `max={todayAD}` on the date input (picker has one selectable day), an `onChange` that clamps
any typed/picked value back to `todayAD`, and a `submit()` guard reporting "in the future" / "in the past" with
the allowed date. `todayAD` comes from `localTodayAD()` (user's local calendar, not UTC) and is also the field's
default value.

### Serial verification — device serial + PON serial + MAC address
Per unit, on a serialized line: **Device Serial \*** · **PON Serial \*** · **MAC Address** (one row per unit,
slots auto-resize with qty, Enter walks device → PON → MAC → next unit).

Pre-post validation in `submit()`:
1. one device + PON serial per unit, no blanks;
2. no duplicate device serial / PON / MAC across the invoice;
3. **every serial must exist in inventory** — an `IN_STOCK` `serial_log` row at the chosen branch for that
   product, with a matching PON, and a matching MAC whenever one was scanned.

### Bug fixed along the way: branch could be `ALL`
`branchId` initialised from `selectedBranchId`, which is `'ALL'` in the consolidated header view. That made
`stockFor()` return 0 for every product, printed "must be IN_STOCK at ALL", and would have posted to
`branch_id = 'ALL'`. The form now resolves to a **real** branch (falls back to the first), re-syncs only when the
global selector points at a real branch, and `submit()` refuses `ALL`/unknown branches.

---

## 3. The inventory gate — where the data comes from

**Finding:** `customerDevices` (the Customer Device Directory) is **empty** in this dataset, and
`serial_log` is the real inventory register — it carries `deviceSerial` / `ponSerial` / `macAddress`,
`status = 'IN_STOCK'`, `branchId`, and its row counts match `inventory_stock.quantity_on_hand`
(WH001: ONU001 ×2, ONU002 ×3). So the gate reads `serial_log`.

**Constraint:** `serialLogs` was *deliberately* removed from `/api/bootstrap` (see `bootstrap.controller.ts`,
"Tables trimmed from the bootstrap payload") — it is served only by paged `GET /api/serial-log`. That is why
App's `serialLogs` state is always `[]`, and why the first version of the gate rejected every serial.

Chosen approach (**validate + mark serials sold**):

- **Client pre-check** — `App.refreshAllData` does one narrow fetch,
  `api.getSerialLogs({ branchId, status: 'IN_STOCK' })`, into a **new** `inventorySerials` state (the existing
  `serialLogs` state is left alone — it feeds other screens), passed to the form as `inventorySerials`.
  `getSerialLogs` learned a `status` param so the payload is only sellable rows.
  `SalesInvoices` keeps its pinned api surface of `['getSalesInvoices']` — no screen-level fetch added.
- **Server gate (authoritative)** — `claimInvoiceSerials()` inside `POST /api/sales-invoices`'s transaction:
  `SI_LOCK_SERIAL_SQL` (`SELECT … FOR UPDATE` on `lower(trim(device_serial))`, which has a partial unique index),
  validate status/branch/product/PON/MAC and duplicates, then `SI_CLAIM_SERIAL_SQL` flips
  `IN_STOCK → CUSTOMER_ASSIGNED` and stamps the buyer + invoice number, asserting `rowCount === serials`.
  A miss throws → the transaction rolls back → HTTP 400.

This is symmetric with what already existed: **Sales Returns** flip serials back with `SR_SERIAL_FLIP_SQL`
(`→ IN_STOCK`, history `sourceType: 'SALES_RETURN'`), so the sale now writes the state the return path expects.

---

## Verification
- `npx tsc --noEmit` → **10 errors, all pre-existing**; zero in `SalesInvoices.tsx`, `sales.controller.ts`,
  `sales.repo.ts`, `api/inventory.ts`, or the new `App.tsx` wiring.
- `node scripts/run_tests.mjs` → **583 tests, 583 pass, 0 fail** (was 580/583).
- `npx vite build --mode development` → clean.
- **Browser (superadmin demo login), Create Sales Invoice:**
  - customer picker returns the directory (name / code / phone / address);
  - ProductSearchBar scan → line with branch-stock badge (2 Pcs · Low), scan again → qty 2 and **two** serial rows;
  - discount 100 on a 563 line → Taxable 463 · VAT 60.19 · Net 523.19 (exactly the server's math);
  - bad PON → `PON serial WRONG-PON-9999 (unit #1) does not match inventory: Branch 1 (Head Office) has
    PON-SN-ONU001-0001 recorded against SN-ONU001-0001.`
  - unknown serial → `Device serial NOT-IN-INVENTORY-123 is not in inventory at Branch 1 (Head Office) …`;
  - all six real serials → **confirm dialog** appeared; cancelled (nothing posted).
- **Server gate:** `POST /api/sales-invoices` with a bogus serial → **HTTP 400** with the same message, rolled back.
- **Claim SQL:** run inside `BEGIN; … ROLLBACK;` on the real DB — `SELECT … FOR UPDATE` hit both rows,
  `UPDATE 2`, rows became `CUSTOMER_ASSIGNED | SALES_INVOICE | INV-PROBE` with history appended, and the
  rollback restored them to `IN_STOCK`. **No demo data was changed.**

Note: `npm test` still exits non-zero because its first stage is `tsc --noEmit`, which stops on the 10
pre-existing errors below. Run `node scripts/run_tests.mjs` for the suite itself.

## Pre-existing tsc noise (NOT from this task)
- `App.tsx(1516,1531)` — `ProductManagementProps` doesn't declare the props App passes.
- `App.tsx(1717,1721,1725,1729)` — `CustomerMasterDirectoryProps` mismatch + 4 implicit-any handlers.
- `DocumentNumbering.tsx(58,71)` — `message` on `{}`.
- `ProductManagement.tsx(172,15)` — `getProducts` missing on the api surface.
- `utils/documentNumbering.ts(1,43)` — `Cannot find module './types/index'`.

## Open follow-ups
1. **Delete the old product-sale block in `StockOperations.tsx`** once approved (TAB 7
   `activeTab === 'PRODUCT_SALE'`, `sellCustomerId` / `sellItems` / `handleSubmitSellProductSale`).
   Its own gate still reads the empty `customerDevices`, so it currently rejects every serial.
2. **Device-directory tagging** — the old form advertised "auto-registered as SOLD (Customer Owned)"; the sale
   now claims `serial_log` but does not write a `customerDevices` row. Decide whether that directory should be
   derived or maintained separately.
3. **SSE stream 401 loop** — `client/src/services/api/sync.ts:8` reads the token *once*, outside `connect()`,
   so a subscription opened before a token exists retries forever with `null`. That keeps `sseRefreshKey` from
   ever firing from realtime events.
4. **Clear the 10 pre-existing `tsc` errors** so `npm test` runs its suite instead of stopping at the typecheck.
5. `App.tsx`'s `serialLogs` state is dead (bootstrap never sends it) while 6 render sites still consume it.
