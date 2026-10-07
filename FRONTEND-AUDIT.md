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
| `npx tsc --noEmit --noUnusedLocals` (client/src) | **0** (was 234) |
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

7. ~~**272 unused symbols in `client/src`**~~ — **`--noUnusedLocals` half RESOLVED 2026-10-05.**
   All 234 unused locals/imports removed (dead handlers like `handleWriteToSql`/
   `handleUnassignAsset`/`handleDeleteLocation`, orphaned state pairs, write-only setters switched
   to hole bindings, bulk icon imports) — `npx tsc --noEmit --noUnusedLocals` reports **0** client
   errors. The `--noUnusedParameters` half remains: **36** unused parameters still reported, and
   `tsconfig.json` still deliberately does not enable either flag (its comment says fix types rather
   than silence them), so neither sweep can regress silently yet.
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

## F. Sync-architecture improvements (2026-10-05)

The sync audit found 7 gaps (G1–G7). Improvements #1–#6 are now implemented;
#7 is documented as a recommendation. Full evidence in the sync audit
notes of 2026-10-05; the change map:

| # | Improvement | Where |
| - | ----------- | ----- |
| 1 | Reconnect gap-fill: `CONNECTED` handshake reconciles the server's `dataVersion` against the last version this tab applied — a newer version means mutations happened during the disconnect, so `refreshAllData` runs. While the stream is down, App polls `/api/sync/version` every 30s (via new `getSyncVersion()`) and catches up the same way. | `client/src/App.tsx` SSE effect; `client/src/services/api/sync.ts` |
| 2 | Broadcast previously-unheard mutations: permission-matrix saves (`PERMISSIONS_UPDATED` → PERMISSIONS), app-settings saves (`APP_SETTINGS_UPDATED` → SETTINGS) and document-number config edits (`DOC_NUMBER_UPDATED` → MASTER_DATA) now reach every connected client; `logAuditEvent` additionally emits `AUDIT_LOGGED` so an open Audit Trail refreshes live (#3). New `PERMISSIONS`/`SETTINGS` domains are wired into App's `DOMAIN_STATE_KEYS` (targeted slice re-fetch). | `server/src/syncDomains.ts`, `server/src/controllers/permissions.controller.ts`, `server/src/controllers/settings.controller.ts`, `server/src/controllers/admin.controller.ts`, `server/src/services/audit.service.ts`, `server/src/controllers/bootstrap.controller.ts` (slice serving) |
| 4 | Multi-domain bursts are targeted: `SseDomainBurst` collects domains into a Set and `flush()` resolves a targeted plan covering ALL recognized domains (deduped), instead of collapsing any 2+-domain burst to a full bootstrap. Any unknown/no-domain event still falls back to full — the staleness guarantee is unchanged. | `client/src/utils/registerRefreshDomains.ts` (+ tests in `tests/registerRefreshDomains.test.ts`) |
| 5 | Reconnect reliability: exponential backoff 1s→2s→…capped 30s with ±20% jitter (no retry-herding after a server restart), immediate reconnect on `visibilitychange`/`online`, backoff reset on healthy open, `onStatus(connected)` callback. | `client/src/services/api/sync.ts` |
| 6 | Multi-tab relay: a `BroadcastChannel('inventory-sync')` forwards every received SSE event to sibling tabs (which feed their existing handler) and carries a LOGOUT notice so a sign-out in one tab signs the others out (via `inventory_sync_logout`). | `client/src/services/api/sync.ts`, `client/src/App.tsx` |
| 7 | Mirror-drift structural fix | **IMPLEMENTED 2026-10-05 (same day).** `GET /api/bootstrap` reads the permission matrix live from PG (`PERMISSION_MATRIX_SELECT_SQL` + `rowsToPermissionMatrix` in permissions.repo.ts); `GET /api/bootstrap/local` serves every slice **live from PostgreSQL** — mapped keys through the shared `BOOTSTRAP_TABLES` configs (`fetchBootstrapSlice` in bootstrap.repo.ts, with auditLogs keeping its 200-row payload cap and companyProfile its single row), the permission matrix through its own SELECT, appSettings through the settings repo SELECT. The in-memory mirrors are demoted to operational cache for other controllers plus a last-resort fallback if the live read fails — a manual DB edit, a second server instance or a missed cache refresh can no longer be served stale. |

Verification after the changes: `tsc --noEmit` 0 · client `--noUnusedLocals` 0 ·
619/619 tests (docs gate OK — count moved 618→619: burst tests rewritten for the
Set semantics, net +1) · build/budget/no-raw-dialogs/no-inline-sql all green.

Improvement #7 landed later the same day (see its row above); re-verified:
tsc 0 · client `--noUnusedLocals` 0 · 619/619 + docs gate · build/budget/
no-raw-dialogs/no-inline-sql green · bootstrap.controller's server-side
`--noUnusedLocals` diff vs HEAD shows no NEW unused symbols (12 pre-existing).

## G. Component decomposition audit — StockOperations.tsx (2026-10-06)

User: "Audit client side project and suggest for breaking the component. I
think stock operation has almost 8k line of codes which is definitely very
difficult to maintain." (Actual: 5,966 lines — the largest component in the
app by ~2×; runner-up is App.tsx at 3,018.)

### G.1 Size map — client/src (49,061 lines across App.tsx + 50 screens)

| File | Lines | Note |
| - | --- | - |
| inventory/StockOperations.tsx | 5,966 | 12 stock tabs in ONE component; see G.2 |
| App.tsx | 3,018 | routing/shell; already 67 KeepMounted sites |
| inventory/PhysicalStockAudit.tsx | 2,552 | next candidate, same pattern |
| procurement/Shipments.tsx | 2,186 | same pattern |
| sales/CustomersManagement.tsx | 1,716 | |
| inventory/ProductManagement.tsx | 1,473 | |
| procurement/PurchaseInvoices.tsx | 1,456 | |
| finance/FiscalYearClosingWizard.tsx | 1,426 | |
| …remaining 43 screens | ≤1,347 | long tail |

### G.2 Why StockOperations.tsx hurts (measured facts)

- ONE exported component with **79 `useState`** hooks, 12 `useEffect`,
  37 handler functions; every tab's state lives in a single component
  instance, so a keystroke in one panel re-renders the entire 6k-line body.
- App.tsx renders **`<StockOperations …>` 11 times** (pullout, damage,
  receive-shipment, create-transfer, assign-asset, consumable-issue,
  consumables-register, stock-out, device-exchange, serial log, stock
  ledger contexts) — 11 full instances of the monolith are mounted by the
  keep-mounted shell, each carrying all 79 hooks even though each surface
  uses one or two tabs.
- 12 conditional panels (`{activeTab === 'X' && (…)}`) of ~2,950 JSX lines:
  RECEIVE_TRANSFER 484 · ASSIGN_ASSET 329 · CREATE_TRANSFER 273 ·
  CONSUMABLES_REGISTER 309 · CONSUMABLE_ISSUE 298 · PRODUCT_SALE 289 ·
  DEVICE_EXCHANGE 383 · DAMAGE_TRACKING 126 · PULLOUT_BINS 69 ·
  CREATE_PULLOUT 35 · LABEL_DAMAGE 275 · LOGS 130.
- Guard-test entanglement: the file is pinned in
  tests/registerRefreshDomains.test.ts in 3 places (surface pin with its
  `pageSize:` register allowance, the consumable-register
  `sseRefreshKey={registerRefresh.consumableRegister}` render-site guard,
  and the single-serial-fetch assertion) — a split must update all three
  deliberately (same friction philosophy as every other pin).
- Props: ~15 per instance from App.tsx (operations, products, branches,
  currentUser, refresh hooks…) — mostly the same set on all 11 sites.

### G.3 Proposed decomposition (mechanical, guard-compatible)

Split BY TAB PANEL into sibling files under `features/inventory/stockops/`,
one folder per concern, keeping `StockOperations.tsx` as a thin host that
only resolves the active tab and passes props:

```
features/inventory/stockops/
  PulloutBinsPanel.tsx          (~70 + shared state slice)
  DamageTrackingPanel.tsx       (~130)
  ReceiveTransferPanel.tsx      (~490)  ← biggest; takes registerRefresh key
  CreateTransferPanel.tsx       (~275)
  AssignAssetPanel.tsx          (~330)
  ConsumableIssuePanel.tsx      (~300)
  ConsumablesRegisterPanel.tsx  (~310)  ← keeps sseRefreshKey wiring
  ProductSalePanel.tsx          (~290)
  DeviceExchangePanel.tsx       (~385)
  LogsPanel.tsx                 (~130)
  CreatePulloutPanel.tsx        (~35)
  LabelDamagePanel.tsx          (~275)
  shared/
    bsCalendarGate.ts           (the BS-date gate hook — reused by 6 panels)
    operationFilters.ts         (op.type/branch filters, isOpInAllowedBranch)
    pulloutFormState.ts         (PulloutItem line state + product search)
    types.ts                    (panel props interfaces)
StockOperations.tsx             (host: tab state + <ActivePanel …> switch, ~400)
```

Rules that keep the guards green and the behavior identical:
1. **State moves WITH its panel.** Each panel owns its `useState` cluster;
   the host keeps only `activeTab`, the BS-date gate and the toast. This
   is the main win: 11 host instances × 79 hooks → each panel instance
   carries only its own state, and a keystroke in one panel no longer
   re-renders the other 11 surfaces' JSX.
2. **Server-call surfaces move verbatim.** Each panel keeps exactly the
   `api.*` calls its code makes today; `ConsumablesRegisterPanel` carries
   the `pageSize:` fetch and `sseRefreshKey={registerRefresh.consumableRegister}`
   unchanged, so the paged-tripwire and the render-site guard pass by
   updating only the pin's file path.
3. **The 11 App.tsx render sites do not change.** They keep rendering
   `<StockOperations …>`; the host simply renders one panel instead of
   twelve conditional blocks. Zero App.tsx churn, zero new lazy chunks
   beyond the panel files (they compile into the StockOperations chunk
   graph — `manualChunks` keys on `features/<group>/<file>`, so panels
   land in per-file chunks automatically).
4. **Update the three pins in the same commit** (surface pin: move the
   inventory/StockOperations.tsx entry + add panel entries or teach the
   walk to include stockops/; render-site regex unchanged — the host still
   renders `<StockOperations>`; serial-fetch assertion moves to whichever
   panel hosts it).

### G.4 Expected outcome

- Largest file drops 5,966 → ~490 (ReceiveTransferPanel); host ~400.
- Per-panel state isolation: re-render scope shrinks from the whole
  6k-line component to the active panel (and the host shell).
- Each panel becomes independently testable and the guard pins become
  per-concern instead of monolithic.
- Same recipe then applies to PhysicalStockAudit (2,552) and Shipments
  (2,186), which follow the identical tab-panel shape.

### G.5 Risks / sequencing

- Do it in TWO commits: (a) pure move — cut panels verbatim, panels take
  props, no logic edits; (b) state relocation — move `useState` clusters
  into panels. Verifying 620/620 after each keeps the guard net tight.
- The `getInitialTab()`/`initialType` auto-open-modal behavior spans
  panels (App passes `autoOpenModal` for pullout/damage entries) — keep
  that prop on the host and let it select + forward the initial tab, not
  open modals itself.
- Deferred (this audit is analysis-only): whether the 11 App sites should
  collapse to fewer host instances — that changes tab semantics
  (activeTab is also driven by `initialType`) and deserves its own
  decision.

Verification for this audit: no code changed; file/line facts gathered via
wc/grep on the working tree at HEAD 1915de1 + uncommitted KeepMounted fixes.

### G.6 EXECUTED — commit 1 "pure move" done (2026-10-06, uncommitted)

The split landed as proposed, with one refinement: instead of passing 131
props down to each panel, the host assembles a single
`StockOperationsCtx` value (stockops/StockOperationsContext.ts) and wraps
its JSX in a provider; each panel destructures exactly the members its
verbatim JSX uses — the same explicit-dependency goal with one provider
instead of 12 prop plumbing layers. Facts on disk:

- StockOperations.tsx: 5,966 → 3,063 lines (host keeps ALL state,
  handlers, and every api.* call — including the single mount-once
  `getSerialLogs` cache and the sse-wired consumable-register paged
  fetch, so all three guard pins still live in the host unchanged).
- 12 panels under inventory/stockops/*Panel.tsx (2.6–35.8 kB each), JSX
  moved verbatim; only the `activeTab === 'X' && (` wrapper became the
  host's `switch (activeTab)`. 11 App.tsx render sites untouched.
- Panels make server calls only where the original block did:
  ConsumablesRegisterPanel's export-all `getStockOperations` (all:true,
  user-initiated); everything else is pinned `[]` in
  SCREEN_SURFACE_PINS. No panel pages on the server (paged-tripwire
  unchanged). Screen coverage: 50 → 62 screens, all pinned.
- All gates green after the move: tsc 0, client noUnusedLocals 0,
  620/620 + docs gates, build, bundle-budget (284.3/320 kB gz startup),
  no-raw-dialogs, no-inline-sql.
- Deviations from G.3: host is 3,063 lines, not ~400 — that shrink is
  commit 2 (state relocation), still pending, as are the remaining
  recipe candidates (PhysicalStockAudit, Shipments).
