# Frontend audit — `client/src`

Date: 2026-10-04. Scope: the whole frontend (plus the server files it talks to where a finding crossed
the boundary). Commands used: `npx tsc --noEmit`, `npx tsc --noEmit --noUnusedLocals
--noUnusedParameters`, `npm test`, `npm run build`, `npm run check:bundle-budget`,
`npm run check:no-inline-sql`, plus orphan/dead-prop greps.

**Headline: `tsc` went from 10 errors → 0, so `npm run lint` and `npm test` are green end to end
for the first time (600/600, docs-count gate passes).**

---

## A. What the 10 "pre-existing" errors were actually about

They were four independent mistakes, not ten:

| # | Error | Root cause |
| --- | --- | --- |
| 1 | `utils/documentNumbering.ts(1,43)` TS2307 `Cannot find module './types/index'` | Wrong relative path — types live at `client/src/types/index.ts`, so from `utils/` the path is `../types/index`. The file is one import line away from being unusable. |
| 2 | `finance/DocumentNumbering.tsx(58,71)` TS2339 `message` on `{}` | `catch (err)` is `unknown` under `strict`; `err?.message` doesn't typecheck. |
| 3 | `inventory/ProductManagement.tsx(172,15)` TS2339 `getProducts` missing on `api` | The function **exists** (`services/api/inventory.ts:328`) but was never exported from `services/api/index.ts`. The screen was calling an API the barrel doesn't expose — at runtime that would throw `api.getProducts is not a function`. The test pin `ProductManagement → ['getCategories','getProducts']` proves the call is intended. |
| 4–7 | `App.tsx(1534,1549)` TS2322 `products`/`dbCategories` not on `ProductManagementProps` | App passed **dead props**. `ProductManagement` never declared or read them (it fetches its own catalog via `api.getProducts`), so they were silently ignored at runtime. |
| 8–11 | `App.tsx(1735,1739,1743,1747)` TS2322 + four TS7006 implicit-any | Same pattern, worse: App passed `customers`, `customerDevices`, `onAddCustomer`, `onUpdateCustomer`, `onDeleteCustomer` to `CustomerMasterDirectory`, which declares none of them. Because the target props didn't exist, TS also lost contextual typing on the inline handlers → the four `implicitly any` errors. |

## B. What was resolved

1. **`utils/documentNumbering.ts`** — import path `./types/index` → `../types/index`.
2. **`DocumentNumbering.tsx`** — `err?.message || err` → `err instanceof Error ? err.message : err`.
3. **`services/api/index.ts`** — exported `getProducts: inventory.getProducts` (both copies hit
   `/api/products` with identical params; the inventory one owns the catalog).
4. **`App.tsx` ×2** — dropped the dead `products` / `dbCategories` props from `<ProductManagement>`.
5. **`CustomerMasterDirectory`** — replaced the five dead props with a real contract:
   a new optional `onCustomersChanged?: () => void`, invoked at the end of `refreshCustomersFromDb`.
   That helper is called **only** from the create / update / delete paths, so it notifies the app shell
   on mutations and never on filter or page changes. Wired as `onCustomersChanged={refreshAllData}`.

   Why this mattered: the old `onAddCustomer={… await api.createCustomer …; await refreshAllData()}`
   was passed to a component that **never declared the prop**, so it was never invoked. The directory
   refreshed its own rows and everything else (the Sell-to-Customer picker, dashboards) kept serving the
   pre-mutation customer list. Deleting the props alone would have kept that bug alive.
6. **Mis-wired tab (found by the orphan scan)** — `activeTab === 'nepali-fiscal'` rendered
   `<BsCalendarUtility />`, a copy of the `bs-calendar` block. `NepaliFiscalManagement.tsx` (1,255 lines,
   pinned by `tests/registerRefreshDomains.test.ts`, listed in `handoff.md`) was imported **nowhere**, so
   Help Center → *"Unlock / Carry Forward Balances"* opened the wrong screen. Added the lazy import and
   rendered it with `fiscalYears` / `handleSetCurrentFiscalYear` / `dateMode`.
7. **SSE token capture** — `services/api/sync.ts` read `inventory_auth_token` **once**, outside
   `connect()`. A subscription opened before a token existed retried every 5 s with `null` forever →
   `GET /api/sync/stream → 401` in a loop, which meant the `sseRefreshKey` wiring could never fire from a
   realtime event. The token is now read inside `connect()` on every attempt.

## C. Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **0 errors** (was 10) |
| `npm test` (tsc → 618 tests → docs gate) | **618 pass / 0 fail**, docs-count gate green |
| `npm run build` | OK |
| `npm run check:bundle-budget` | OK — startup 278.1 kB gz / 320 kB budget |
| `npm run check:no-inline-sql` | OK — no raw SQL literals in 14 controllers |
| `npm run check:no-raw-dialogs` | OK — no native alert/confirm/prompt in 101 client files |
| `console.log` in `client/src` | 0 |

---

## D. Shortlist — remaining findings, prioritized

### P1 — broken behaviour, not yet fixed

1. **`StockOperations` "Product Sale to Customer" gates against the wrong register.**
   `validateSourceBranchStockAndSerials` matches serials against `customerDevices`, which is **empty**
   (0 rows) while `serial_log` holds the real IN_STOCK units. That form currently rejects every serialized
   sale. Kept alive only because you asked to retain it until the merge is approved — deleting it closes
   the issue.
2. ~~**No cancel/delete path for a posted sales invoice.**~~ — **RESOLVED 2026-10-05.**
   `POST /api/sales-invoices/:id/cancel` voids a posted invoice in one transaction: row lock → guards
   (already cancelled / posted customer payments / amountPaid > 0 / live credit notes) → stock restore
   per item (`SI_RESTORE_STOCK_SQL`, rowCount must be 1) → compensating `SALES_INVOICE_CANCELLED`
   ledger rows → release of every claimed serial (`CUSTOMER_ASSIGNED → IN_STOCK`, customer cleared,
   release count must match the claim) → in-memory mirror sync → audit event — all rolled back
   together on any failure. Client: Ban button + Cancelled badge + hidden record-payment in the Sales
   Invoices register. Covered by `tests/salesInvoiceCancel.test.ts` (7 HTTP tests) plus the repo-level
   suite in `tests/returns.repo.test.ts`.

### P2 — correctness / consistency worth doing

3. ~~**101 raw `alert()` call sites** in `client/src`~~ — **RESOLVED 2026-10-05.** All 97 component
   call sites (StockOperations alone: 38) now go through `useDialog()` as `alertDialog(...)`; the lone
   `window.prompt` in `DamagedStockTracking` and the last plain `confirm(...)` bindings in the two
   sales screens were migrated too (`confirmDialog(...)`), `utils/exportUtils` — a non-component
   module — uses the new `utilityAlert()` bridge exported by `DialogProvider`, and the
   `window.alert` monkey-patch was deleted. Enforced by `npm run check:no-raw-dialogs`, wired into CI.
4. ~~**Dead `serialLogs` slice in `App.tsx`**~~ — **RESOLVED 2026-10-04.** All 11
   `serialLogs={serialLogs}` bindings (every `<StockOperations>` instance), the App state, the
   bootstrap setter, the `SerialLogRegister` prop that was documented as "unused, kept for interface
   compatibility", and the `serialLogs.length > 0 ? … : assignSerialLogCache` branch in
   `StockOperations` are gone. The mount-once `assignSerialLogCache` fetch is now the only source —
   which is what the register already was in practice, since bootstrap stopped shipping `serialLogs`.
5. ~~**Duplicate `getProducts`**~~ — **RESOLVED 2026-10-04.** The unreachable copy in
   `services/api/procurement.ts` (identical endpoint/params, never exported through the barrel) was
   deleted along with its copy-pasted "Purchase Invoices" comment header.
6. **`nepali-fiscal` has no sidebar entry.** It is only reachable through Help Center step 4. The screen
   renders correctly now, but discoverability is zero — decide whether it deserves a menu item under
   Administration.

4b. ~~**VAT rate is hard-coded in the client while the DB already has the setting.**~~
   **RESOLVED 2026-10-04.** `company_profile.default_tax_rate` now drives both sides:
   * **Client** — new `utils/taxConfig.ts` (`setDefaultTaxRate` / `getDefaultTaxRate`), fed by App in
     `applyCurrencyConfig()` on every bootstrap (Company Setup edits propagate through
     `refreshAllData` → bootstrap). All 14 hard-coded `13`s were replaced (`SalesInvoices`,
     `ReturnsRegister`, `PurchaseInvoiceForm`, `PurchaseOrderForm`, `ProductManagement`, `ImportStock`)
     **and** every "13%" UI string now renders the configured rate (`VatRegister`, `PurchaseInvoices`,
     `PurchaseOrders`, both forms, the sales/returns bill panels, Help Center). `VatRegister`'s
     `'13%'` filter token became the rate-agnostic `'TAXABLE'`; the two permission-catalog labels
     went rate-agnostic ("View VAT Tax Register") since they are static metadata.
   * **Server** — `utils/money.ts` gained `defaultVatRateFor(profile)` + an optional
     `computeBillTotals(items, discount, defaultVatRate)`; all five call sites (PO, PI, purchase
     return, sales invoice, sales return) pass the company-profile rate, so totals for lines without
     their own `taxRate` follow the configured rate instead of a hard-coded 13.
   * **Bug fixed on the way:** `Number(taxRate) || 13` in product create/update and in
     `ImportStock` silently turned every **0 (VAT-exempt)** value back into 13 — which also broke
     `product.taxRate === 0` → `isTaxExempt` downstream. Zero is now preserved; the fallback applies
     only to missing/invalid input (`tests/masterdata.repo.test.ts` updated from "production quirk"
     to the fixed behaviour, plus new `defaultVatRateFor` / configured-default cases in
     `tests/money.test.ts`).
   Still literal by design: the `TAXABLE_13` enum value (a stored DB contract) and the 13% statutory
   fallbacks used when the profile carries no rate.

### P3 — hygiene, not enforced today

7. **272 unused symbols in `client/src`** under `tsc --noUnusedLocals --noUnusedParameters`
   (top files: `StockOperations` 22, `CustomerMasterDirectory` 16, `ProductManagement` 16,
   `ReceiveInboundWarehouse` 15, `BsCalendarUtility` 15). `tsconfig.json` deliberately does **not** enable
   these flags (its comment says fix types rather than silence them), so this is a cleanup, not a failure.
   A bulk dead-import removal is safe but touches ~100 files — worth its own pass.
8. **Startup bundle is at 86% of budget** (277.2 kB gz of 320 kB). `vendor-excel` (939 kB raw) is already
   lazy-loaded behind `BsCalendarUtility`, which is the right shape — just don't let anything else import it
   eagerly. The `>500 kB` build warnings are on-demand chunks and are not budgeted.

---

## E. Browser-storage audit → server-side migration (2026-10-04)

Question asked: *what keeps state, configuration or settings in browser storage / memory instead of
the server — and what happens if the user clears history and cookies?* Every `localStorage` /
`sessionStorage` / IndexedDB call site was enumerated (48 `localStorage` sites, 1 `sessionStorage`,
0 IndexedDB) and classified.

### E.1 Was dangerous — migrated to PostgreSQL

| Browser key (old) | Why it was dangerous | Server replacement |
| --- | --- | --- |
| `inventory_permissions_matrix` — read `utils/permissions.ts:66`, written `:88` | A copy of the **RBAC matrix** living in the browser: editable from devtools, silently stale after another admin saved, and gone (or worse, resurrected stale) on a cleared browser. `PermissionManagement` also wrote it **before** the `PUT /api/permissions` resolved and never rolled back on failure, so the UI could show grants the server had rejected. | Already authoritative in `permission_matrix` + `requirePermission`; the client fallback is **deleted**. `getPermissionsMatrix()` now returns only the in-memory cache filled by `applyServerMatrix()` (bootstrap payload or a *confirmed* PUT) — no storage read, no storage write. On a failed save the editor re-pulls the server matrix. App start-up also purges the stale key from browsers. |
| `inventory_company_wide_blind_count` (`PhysicalStockAudit`) | A **company-wide** audit flag stored **per browser**: toggled on one machine, other users kept counting sighted; cleared history, and the blind-count control silently changed behaviour. | New `app_settings` table (`setting_key` PK) → bootstrap slice `appSettings`, written via `PUT /api/settings` (SUPER_ADMIN only). App owns the state, the screen takes `companyWideBlindCount` / `onCompanyWideBlindCountChange` props (screen stays at **zero** api calls, pin unchanged) and a rejected write reverts the mirror. |
| `inventory_date_mode` (`App.tsx`) | User preference stored per browser — lost on cleared history, never followed the user to another machine. | `user_preferences` table → bootstrap slice `userPreferences`, patched via `PUT /api/preferences`. |
| `inventory_theme` (`DarkModeContext`) | Same, for the theme. | Same table/endpoint; `applyServerTheme()` applies the server value, App persists on change. |
| `inventory_active_tab` (`App.tsx`) | Same, for the last open tab (and a saved tab id could outlive a renamed tab — now validated against `NAV_TABS` on the server value too). | Same table/endpoint, validated as `^[a-z0-9-]{1,64}$`. |
| `inventory_bs_calendar_data` (`nepaliCalendar.ts`, cleared by two screens) | A per-browser mirror of the **`bs_calendar_years` DB table** — could disagree with the database (seeds made on another machine) and vanished with browser history. | Removed entirely: `nepaliCalendar.ts` now keeps an in-memory snapshot that App seeds from `GET /api/bs-calendar/years` on every load; "reset to defaults" drops the snapshot and re-reads the server. |

### E.2 Deliberately still in the browser (and safe if cleared)

| What | Why it is legitimate |
| --- | --- |
| `inventory_auth_token`, `inventory_auth_user`, `inventory_root_user`, `inventory_session_logged_out` | The session credential itself. It *must* live client-side to authenticate requests; the server re-validates every call (`requireAuth` + HMAC token). Cleared ⇒ clean re-login, nothing lost. |
| `inventory_bootstrap_v3:*` (`sessionCache.ts`, 2-minute TTL, `dataVersion` guard, scoped per user+branch+FY) | A **cache**, not a source of truth — clearing it only costs a re-fetch of `/api/bootstrap`. |
| `inventory_theme` / `inventory_date_mode` / `inventory_active_tab` *mirrors* | First-paint mirrors only, so the first frame doesn't flash the wrong theme/tab. Server values overwrite them on load; losing them loses nothing. |
| `HelpDocumentation` `storageOk` probe, `sessionStorage.clear()` on logout | Diagnostics / hygiene, no state. |

### E.3 New server surface

| Piece | File |
| --- | --- |
| `app_settings`, `user_preferences` tables (+ `idx_user_preferences_user`) | `scripts/schema.sql` §31–32 (34 → **36 tables**; guards and docs updated) |
| SQL + whitelists + payload validation (`companyWideBlindCount`; `theme` / `dateMode` / `activeTab`) | `server/src/models/settings.repo.ts` |
| `GET/PUT /api/settings`, `PUT /api/preferences` (PATCH semantics — a partial write can't wipe other prefs) | `server/src/controllers/settings.controller.ts`, `server/src/routes/settings.routes.ts` |
| `appSettings` + `userPreferences` on every bootstrap | `server/src/controllers/bootstrap.controller.ts` |
| `api.getSettings` / `api.saveAppSettings` / `api.savePreferences` | `client/src/services/api/settings.ts` (+ barrel) |
| Unit tests for the whitelists/validation/row mapping (17 tests) | `tests/settings.repo.test.ts` |

Live-verified against the running app: `PUT /api/preferences` patch keeps the other keys,
`{theme:'neon'}` → **400**, `{isAdmin:'true'}` → **400**, super-admin `PUT /api/settings` → **200**,
bootstrap returns both slices, then the smoke-test rows were deleted (both tables left empty).

### E.4 Client behaviour notes

* Preferences are hydrated **once** (first bootstrap wins), and every write is gated on that
  hydration, so a default rendered during start-up can never clobber the saved value.
* Writes are de-duplicated against the last server-confirmed value and retried on the next change
  after a failure.
* Permission grants are now enforced *only* by the server matrix; `isOperationAllowed` falls back to
  the compiled `DEFAULT_PERMISSIONS_MATRIX` solely for the first paint before bootstrap lands.
