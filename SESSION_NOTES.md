# SESSION NOTES — for next session

_Date: 2026-10-05 · Branch: main · Tests: 619/619 green with a DB (all run in CI too — no skips since the PG service container landed)_

## ⭐ NEWEST: Sync-architecture improvements #1–#6 implemented (UNCOMMITTED, 2026-10-05)

User: "proceed for all and improvement recommendations from A to Z" (after the
sync audit found gaps G1–G7). Implemented: #1 reconnect gap-fill (CONNECTED
reconciles `dataVersion` vs `serverDataVersionRef` → refreshAllData; 30s
`/api/sync/version` polling via new `getSyncVersion()` while the stream is
down), #2 broadcasts for PERMISSIONS/SETTINGS/DOC_NUMBER_UPDATED (new
`PERMISSIONS`/`SETTINGS` domains in syncDomains + App DOMAIN_STATE_KEYS; new
mirrorSlices/PG slice serving in bootstrap.controller), #3 AUDIT_LOGGED
emitted from logAuditEvent, #4 SseDomainBurst is set-based (multi-domain
bursts → targeted multi-domain plan, unknown still falls back to full),
#5 exponential backoff 1s→30s ±20% jitter + immediate reconnect on
visibilitychange/online + onStatus callback, #6 BroadcastChannel
multi-tab event relay + cross-tab LOGOUT. #7 (structural mirror drift) is
documented as a recommendation in FRONTEND-AUDIT.md §F, not implemented.
Suite moved **618 → 619** (burst tests rewritten for Set semantics, net +1);
docs counts updated. Full verification green: tsc 0, client --noUnusedLocals
0, 619/619 + docs gate, build, bundle budget, no-raw-dialogs, no-inline-sql.

---

## ⭐ NEWEST: Dead-API cleanup + cancel-receive built + returns/sales-invoices wired as paged registers (UNCOMMITTED)

User: “previously you said there are dead api what are they? … Audit it
properly” → full audit, then chose cancel-receive → *implement properly* and
dead APIs → *remove + wire returns paged*. Suite: **583/583 green** (557 at
`f113806` + 11 cancel-receive + 2 guard pins + 13 new returns tests),
docs-count gate green, screen claims now 50 total / 39 table / 11
pinned-elsewhere.

### Phase 1 — cancel-receive built for real (was an always-400 stub)
- `shipments.repo.ts`: `shipmentReceivedQty()` + `SHIPMENT_UNDO_RECEIVE_*_SQL`
  (guarded stock undo: `quantity_on_hand >= qty` or the UPDATE no-ops).
- `shipments.controller.ts` `post_cancelReceive`: 400 unless RECEIVED/
  DISCREPANCY, 404 unknown, `FOR UPDATE` re-check inside the transaction,
  in-memory mirror kept in sync, audit `CANCEL_RECEIVE_TRANSFER`.
- `misc.controller.ts` approval path: a CANCEL_RECEIVE_TRANSFER approval now
  performs the same stock undo (was a silent no-op); route gained
  `requirePermission('branch-transfer-cancel-receive')` (op already in the
  permission matrix); client `cancelReceiveShipment` now posts
  `/cancel-receive` instead of `/cancel` (which rejected RECEIVED).
- Tests: +5 repo unit, +6 HTTP (`tests/shipmentCancelReceive.test.ts`,
  `crtest-` fixtures seeded in DB **and** the in-memory cache, cleaned in
  after(): undo, one-shot guard, 404/401/403, approval-path revert).

### Phase 2 — purchase-returns / sales-returns / sales-invoices wired paged
- Server: `PurchaseReturnQueryOptions` + WHERE/count/paged builders in
  `procurement.repo.ts`; `SalesReturn*` + `SalesInvoice*` builders in
  `sales.repo.ts`; all three GET controllers grew the PO-style paged branch
  (`?page` → `{data,page,pageSize,totalItems}`, bare → legacy array, `all=1`
  → whole filtered set, filters without `page` → filtered array).
- **The anomaly, root-caused**: `?page=N&query=…` returned a plain ARRAY.
  Cause: the heredoc pipeline that wrote the builders had stripped every `$`
  from `${params.length}` (SQL became `LIKE 1` → `text ~~ integer` error) and
  every `\d` from the AD-date regexes; the controller's `catch` swallowed it
  and fell through to the legacy array, silently defeating paging. Fixed both
  files (restored `$${params.length}` + `\d{4}-\d{2}-\d{2}`), re-probed all
  13 filter/page/all combos live → envelopes everywhere. NOTE for future
  shell writes: this toolchain eats backslashes — build `\` with
  `String.fromCharCode(92)` or use the str_replace tool for code with regexes/
  `$` placeholders.
- Client: `sales.ts` `getSalesInvoices/getPurchaseReturns/getSalesReturns`
  revived with the full paged param set; `ReturnsRegister` LIST tab and
  `SalesInvoices` now self-fetch one server page (seq-guarded `loadRetPage`/
  `loadSiPage`, filter→page-1 snap, prop-array fallback on fetch error,
  internal refresh-key bump after create/cancel/approve/payment).
- SSE wiring: `RegisterRefreshKey` += `returnsRegister`, `salesInvoices`;
  `DOMAIN_REGISTER_KEYS` PROCUREMENT += returnsRegister, SALES += both;
  `bumpAllRegisterRefresh` + App.tsx init + `sseRefreshKey` at all 6 render
  sites (4 ReturnsRegister, 2 SalesInvoices). Guard test updated: REGISTER_KEYS,
  deepEquals, bumpAll records, paged-tripwire (6 screens), surface pins moved
  to PINNED_ELSEWHERE with two new dedicated wiring tests (35/35).

### Phase 3 — dead code removed
- 9 dead routes gone (GET /api/assets, /api/users, /api/audit-trail,
  /api/company-profile, PUT /api/locations/:id, /api/fiscal-years/:id,
  /api/document-number-configs/:id, POST /api/serial-log, PATCH
  /api/customer-devices/:id/serials) + the unreachable duplicate pair in
  admin.routes and the duplicate PATCH + 2nd/3rd GET lookup in
  inventory.routes; 12 orphaned controller handlers deleted (~414 lines:
  get_users, put_Id3/4, get_companyProfile(+2), put_companyProfile2,
  get_assets, get_lookup2/3, post_serialLog, masterdata put_Id2,
  get_auditTrail). `COMPANY_PROFILE_UPSERT_NO_STAMP_SQL` stays — pinned by
  `tests/admin.repo.test.ts` (comment updated, unused import dropped).
- 19 dead client service fns + their barrel entries deleted (getCompanyProfile,
  getCurrentUser, getFiscalYears, updateFiscalYear, getStock, getAssets,
  updateDocumentNumberConfig, getAuditLogs, getTransactionLogs,
  createSerialLogEntry, getCustomers, getApprovalRequests, getBranches,
  getSuppliers, getUsers, getProducts, getVendorPayments, getShipments,
  updateLocation) — each re-verified zero callers first. Smoke-covered GETs
  kept (stock/branches/products/suppliers/customers/fiscal-years/shipments/
  vendor-payments/approval-requests/transaction-logs/doc-number-configs…).

### Phase 4 — tests + docs
- `tests/returns.api.test.ts` (7 HTTP): envelope for ?page on all three,
  REGRESSION pin that query/status/date/branch + page stays an envelope (the
  fall-through bug), legacy arrays without ?page, all=1, out-of-range page,
  401 unauthenticated.
- `tests/returnsPaged.repo.test.ts` (8 unit): `$N`↔param bijection (the
  stripped-`$` class), LIKE/status/date mapping + shape gate, count/list WHERE
  parity, LIMIT/OFFSET clamps.
- README: Paged Register Endpoints table +3 rows (“these seven”), register-
  refresh section now “six registers” + render-site list + tripwire wording;
  handoff: §15.7 six registers, tripwire, audit footnote CLOSED; 11 test-count
  claims 557→583; screen claims 41/9→39/11 (handoff + this file).

## DB-integrity audit + database docs corrected + first-deploy hardening (pushed `f113806`)

User asked for a database-integrity audit, doc corrections, and proof that a
first deployment never fails. Suite: 557/557 green; docs-count gate green.

### Integrity audit
- `npm run integrity:check` → PASS (stock quantities, device identifiers,
  fiscal-year ownership, safeguards all healthy).
- Live `inventory_db` verified: **34 base tables / 595 columns / 223 indexes**
  — matches schema.sql exactly; `tests/schema.drift.guard.test.ts` ran (NOT
  skipped) and passed against the live DB.

### Doc corrections — "30 tables" was wrong (real = 34)
- README + handoff claimed **30 tables in 7 places** (tree comments, step 3,
  §5.1 heading, quick-ref row). All corrected to **34**; handoff §5.1 gained
  the 4 missing rows: sales_invoices, customer_payments, purchase_returns,
  sales_returns (columns verified against schema.sql).
- SESSION_NOTES' "30 tables" mentions are Arc-13 HISTORY (state at that time)
  — deliberately left alone; the docs-count gate exempts historical records.
- Sweep for other stale DB numbers (indexes/columns/constraints) — none found.

### First-deploy hardening — both setup scripts now read `.env`
- README Step 2 tells users to configure `.env`, but NEITHER setup script read
  it: a first deploy with custom creds silently fell back to `securepassword`.
  - `scripts/setup_db.js`: `dotenv.config({quiet:true})` before DB_CONFIG
    (dotenv never overrides real env vars — `POSTGRES_DB=... npm run setup:pg`
    still wins). Remember dotenv v17's banner poisons command substitution —
    ALWAYS `quiet:true`.
  - `scripts/setup_postgres.sh`: new `load_env_file()` — parses simple
    KEY=VALUE lines (strips CR/quotes, skips comments/blank), never overrides
    already-set vars, never `source`s the file (so `$(...)` in .env is NOT
    executed). Regex `^([A-Za-z_][A-Za-z0-9_]*)=(.*)$` — an earlier case-glob
    version broke on single-letter keys → `unbound variable`.
  - README Step 3 gained a "Config source" callout documenting the loader +
    env-var precedence.
- Static verification: `bash -n setup_postgres.sh` OK, `node --check
  setup_db.js` OK; loader probed in bash (CRLF strip, quote strip, pre-set
  env not overridden, `$(touch /tmp/pwned)` NOT executed, single-char keys OK).
- **Real first-deploy proof**: created empty throwaway DB
  `inventory_firstdeploy_test` → `POSTGRES_DB=inventory_firstdeploy_test npm
  run setup:pg` → **exit 0**: schema applied atomically, all seeds succeeded,
  "34 tables" verified, demo rows present. Throwaway DB dropped after.
- `setup_postgres.sh` remains fully idempotent (6-step main: detect/install →
  ensure running → configure_database → run_schema_migration with
  ON_ERROR_STOP=1 + post-verify → test_connection → run_node_seeder), so
  re-running on an existing box is a no-op upgrade path too.

## Duplication audit (phases 1–4) + CI fresh-install proof (pushed `60acf84`…`e8f8de4`, CI green)

Long-running duplication-audit plan executed across four phases plus one CI
hardening step. All pushed to main; client+server `tsc --noEmit` clean,
504/504 tests, bundle budget OK (275.7/320 kB gz startup).

### Phase 1 — shared formatting/nav/styles (`60acf84`)
Consolidated repeated money formatting into `fmtMoney` (nprFormat),
navigation helpers and form styles; exposed the Shipment & Transfer Register.

### Phase 2 — schema.sql becomes the single schema source (`2cbf891`)
`server/src/boot/dbBoot.ts` no longer carries the ~1,000-line inline DDL
template literal — it executes `scripts/schema.sql` via `loadSchemaSql()`
(resolves repo-root file; cwd walk for bundled `dist/server.cjs`). The
former dbBoot-only runtime statements (legacy index aliases, serial-log
ALTERs, currency backfill, fiscal-year default drop, vendor-payment FY
backfill) were ported into schema.sql's "RUNTIME PARITY SECTION".
Guard: `tests/schemaSource.parity.test.ts` (3 tests: no inline DDL in
dbBoot, ported statements present, exactly 36 tables). File-parsing only —
runs everywhere, no DB needed.

### Phase 3 — CACHE_LOADS derived from columnMappings (`2234b5e`)
One table description (`columnMappings.ts`) now feeds both bootstrap and
the operational cache; guard `tests/cacheLoads.parity.test.ts` (3 tests).

### Phase 4 — create-forms extracted out of the register screens (`2b1d54c`)
- `PurchaseOrders.tsx` 1,693 → **995** lines; new `PurchaseOrderForm.tsx`
  (776). `PurchaseInvoices.tsx` 2,712 → **1,452**; new
  `PurchaseInvoiceForm.tsx` (1,320 — includes the PO-link selection +
  checklist modals that used to live in the register's JSX tail).
- Registers keep: paged list, filters, CSV export, VIEW tab, payment /
  products modals, tab-bar. Forms own all form state, totals, submit.
- Contracts: PO form gets `editingPO` (edit entry point keeps its
  IN_PROGRESS/CANCELLED/RECEIVED alert guard, then just `setEditingPO(po)`),
  reports back via `onSaved`/`onCancel`. PI form is create-only: remounts
  fresh per tab switch (no reset needed), `onSaved` (refresh register) +
  `onClose` (navigate back after the 3s success message).
- `OrderFormLine` is declared in PurchaseOrderForm.tsx and **re-export**
  from PurchaseOrders.tsx (App.tsx imports it from there — don't break it).
- Dead code swept while thinning (all were dead at HEAD, surfaced by
  `--noUnusedLocals`): write-only `poLoading`/`piLoading`/`reversalId`/
  `reversalReason`, unused `supplierSearchQuery`, unused `stock` prop on the
  PI form, fully-unreferenced `handleMarkInvoicePaid`, unused
  `useClientPagination`/`useDarkMode` imports in the registers.
- **Pre-existing bug fixed** in the PO-checklist badge: a `` `${isExact ?
  …}` `` interpolation had been mangled into a literal string (badge
  rendered garbage classNames, `isExact`/`isExceed` were dead vars). Now a
  proper emerald/rose/amber conditional with `dark:` variants — worth a
  visual check of *Create Purchase Bill → Link from PO*.
- LESSONS: (1) repo files mix line endings — `PurchaseOrders.tsx` is CRLF,
  `PurchaseInvoices.tsx` is LF; surgery scripts must not assume CRLF
  everywhere. (2) One-off extraction scripts must capture ALL regions
  before deleting any (index invalidation) and delete bottom-up. (3) The
  surgery scripts were one-off and deleted after use — don't re-add them.

### CI fresh-install proof — phase-2 guarantee now enforced on every push (`e8f8de4`)
`scripts/verify_fresh_install.mjs` (+ npm script `verify:fresh-install`,
CI step in `.github/workflows/ci.yml` right after the psql schema-apply):
1. Creates two throwaway DBs (`inventory_fresh_reference` /
   `inventory_fresh_boot`; requires CREATEDB — CI service user and local
   inventory_user both have it).
2. Reference: `scripts/schema.sql` applied directly. Boot: DB left EMPTY,
   then the REAL server (`tsx server/index.ts`, NODE_ENV=production,
   PORT_TO_BOOT=3557) is spawned so **dbBoot executes schema.sql itself**;
   readiness via `GET /api/health`.
3. Diffs both runtime schemas across 7 categories — tables, columns (exact
   format_type/nullability/default/identity), constraints, indexes,
   triggers, sequences, views — and exits 1 with a precise diff on drift.
   Cleanup in finally: kill child → wait exit → `pg_terminate_backend` →
   DROP (plain, then WITH (FORCE) fallback).
- Verified BOTH directions: pass = 34 tables / 595 columns / 362
  constraints / 223 indexes / 14 triggers identical; fail = injected a
  runtime ALTER into dbBoot → caught as "only in booted DB" + exit 1, DBs
  still cleaned up.
- BUGS found while building (both fixed): (a) the server child was spawned
  BEFORE the throwaway DBs were created — fast tsx boots raced and connected
  to a nonexistent DB; spawn only after creation. (b) `DROP ... WITH
  (FORCE)` can't always terminate the dying server's pool backends
  ("permission denied to terminate process") — terminate backends first.
- Editing schema.sql does NOT create drift between the two sides (both get
  the same file) — the script proves *runtime DDL stays out of dbBoot*, not
  that schema.sql matches some external truth.

## Arc 18 — accounting-accuracy wording audit + closing-wizard corrections (pushed `334b22e`)

User asked to scan the app for screens that overstate accounting accuracy (after the
Financial Overview reframe). Findings and fixes:

1. **FiscalYearClosingWizard — WORST OFFENDER, now fixed (code + wording)**:
   Step 3 computed "Total Billed Purchase Invoices" as `inventoryValue × 1.15` (an
   INVENTED revenue figure from an arbitrary 15% markup) and derived "Net Surplus
   Transferred to Retained Earnings" from it. Now: `closingMetrics.totalSalesRevenue`
   added from `financialSummary.totalSalesRevenue` (real posted STOCK_OUT sales);
   Step 3 shows Posted Sales Revenue − COGS − schedule depreciation = "Estimated Net
   Surplus (NOT a retained-earnings transfer)" with an amber no-GL disclaimer.
2. **Wizard's downloadable "IRD Audit Certificate" claimed "OFFICIALLY CLOSED &
   AUDIT LOCKED" and "Approved for IRD Filing"** — a client-side txt cannot approve
   anything. Now: "Fiscal_Closing_Snapshot_FY_*.txt" with "CLOSED IN SYSTEM
   (management lock — not a statutory audit)", unaudited-figures banner, real sales
   line, and "NOT approved for statutory/tax filing — consult a professional
   accountant". Step 6 renamed "Lock Period & Closing Snapshot"; "Compliance Seal"
   wording removed.
3. **HelpDocumentation year-end walkthrough** — synced to the reframed wizard
   (6 steps, no IRD-certificate/trial-balance claims; "Depreciation Schedule Totals"
   instead of "Journal"). No Trial Balance/IRD/Retained-Earnings refs remain in help.
4. **PermissionManagement** — `fin-statements` description now "Financial Overview
   (management view…) — not statutory accounting".
5. **AuditTrailReports** — removed dead accounting code (totalAssets/netEquity
   computed but never rendered).
6. **Confirmed already honest (no change)**: StockValuation ("Potential Gross Profit"
   properly hedged), VatRegister (input tax credit from real invoices).

LESSON (extends Arc 17's rule): the overstatement pattern was **compliance-styled
wording over management data** — fabricated figures (×1.15), statutory certificates,
"retained earnings transfers" that never post. Rule: any financial figure must be
either posted/derived from real records OR explicitly labeled "estimate/management
view"; never claim IRD/statutory/audit approval the system cannot perform.

### DECISION — full accounting ERP / general ledger: DECLINED (2026-09-26, do not re-litigate)
- User explicitly decided NOT to build a general ledger / complete accounting ERP.
  Context: the app is going LIVE ON THE INTERNET, but that does NOT change this —
  do not suggest building a GL, chart of accounts, journal entries, AR/AP ledgers,
  or "real trial balance" in any future session.
- Rationale: statutory correctness (immutable journals, balancing trial balance,
  audit-grade trail) is a second product with permanent legal-risk maintenance
  burden; real accounting software serves the external parties better.
- The BOUNDED alternatives, if ever wanted, are export-oriented only: Tally voucher
  export (accountant imports into real accounting software), VAT return helper
  (format existing input/output tax data for IRD), Accounts Receivable tracking
  (customer ledger + receipts + aging — operational, not statutory). Any of these
  must stay additive and must NOT evolve into posting GL entries.
- The "management view" honesty rule above is the permanent contract for financial
  wording in this app.

Verified: typecheck, build + budget gate, 449/449. Pushed `334b22e`.

## Arc 17 — accordion sidebar + ERP-style Financial Overview + reframe (pushed `318198e` + `cac943e`, CI green)

Two user-facing arcs in one push:

### Sidebar redesign (accordion model)
- Single always-visible column; groups expand INLINE (accordion) — no flyout, no back
  button, no collapse button, no push-mode layout shifting (old `sidebar-push-main`
  CSS + `isSubPanelExpanded` wiring deleted from App.tsx/index.css).
- Menu consolidated 11 → 8 groups (Overview absorbs Serial & Device Tracking; Finance
  absorbs Fixed Assets + Opening Register; Inventory absorbs Import/Export stock; Help
  becomes a footer link). Global search filters items across ALL groups (`/` to focus);
  header has an Expand-all/Collapse-all toggle labeled "EXPAND / COLLAPSE MENU".
- Width: w-72 (288px; 15.5rem ≤1366px); long labels WRAP instead of truncating.

### Financial statements → ERP-style "Financial Overview" (tab id unchanged)
Three iterations landed on the ERP-standard pattern (how SAP/NetSuite/QuickBooks do it):
1. **Statement view** — ONE entity per statement via a "Statement of" dropdown (any
   branch or All-Branches consolidated); columns are PERIODS (current FY | prior FY |
   variance when the "Compare with <prior-FY>" toggle is on). Table width is fixed —
   NEVER grows with branch count. Prior-FY fixed-asset NBV = depreciation schedule
   evaluated at the prior FY's END date (closing position).
2. **Branch Comparison view** — branch-vs-branch analysis lives here: rows = branches
   (grows DOWNWARD), 8 KPI columns, sticky first column, consolidated row pinned,
   per-branch prior-year Total-Assets deltas (▲/▼).
3. **⚠️ REFRAME (decision, `cac943e`)** — the report has NO general ledger behind it:
   equity was a plug (assets − liabilities), no cash/receivables/capital accounts, P&L
   stops at gross surplus. Every FIGURE is real but the statement was not statutory.
   Decision: keep the data, drop the misleading wording. Renamed: menu label
   "Financial Overview"; titles "STATEMENT OF FINANCIAL POSITION" / "TRADING SUMMARY"
   with amber "Management View — not a statutory balance sheet" tagline; "SOURCES OF
   FUNDS", "Net Asset Position (balancing figure — not from a general ledger)",
   "Vendor Payables"; CSV exports `Financial_Overview_Position_*` /
   `Financial_Overview_Trading_Summary_*`. Tab id `financial-statements` and
   permission key `fin-statements` UNCHANGED (no permission-matrix breakage).
   DO NOT re-name these back to "Balance Sheet"/"Net Equity" — if statutory reporting
   is ever needed, build a real GL first (expense journal, receivables, cash,
   capital accounts).

Verified: typecheck, build + budget gate, live production preview both views, 449/449.

## Arc 16 — deep code splitting (pushed `fdfe03c`, CI green — startup payload −96 kB gz, bundler trap documented)

Follow-up to Arc 15's vendor split: the ~358 kB gz startup graph (index.js + static
imports) shrank to **~262 kB gz** (index.js alone: 38 kB → 11.7 kB gz). Two changes:

1. **17 more screens lazy-loaded** in `client/src/App.tsx` (Reorder/Valuation/Ledger/
   Warranty/Category/UoM/Import/Export stock; all finance registers + closing wizard +
   doc numbering + opening stock + vendor ledger/openings; ImportCustomers, Locations,
   ApprovalWorkflowCenter, ClearDemoDataView, DataRecalculationMaintenance) — all with
   the shared `TabLoadingFallback` spinner. Still eager BY DESIGN: Dashboard,
   ProductManagement, StockOperations (11 render sites), PurchaseOrders,
   SerialLogRegister, BranchStockTracking, modals.

2. **⚠️ BUNDLER TRAP — shared modules swallowed into feature chunks** (vite.config.ts):
   Rollup placed the shared `DateField` component INSIDE the FixedAssetRegister chunk,
   so every screen importing DateField (StockOperations, PurchaseOrders, most inventory
   screens) transitively pulled a 40 kB finance screen into its static import graph —
   invisible in source code, visible only by parsing the emitted chunks
   (`grep 'from"./chunk"' dist/assets/*.js`). Fix: file-level `shared-*` chunks for ALL
   `src/components|utils|hooks|contexts` modules. LESSON: after changing manualChunks,
   ALWAYS audit the emitted import graph, not just chunk sizes — a chunk can be small
   while being wrongly wired into everything.

Verification pattern that worked: parse `dist/assets/index-*.js` for
`from"./X"` static imports (the true startup set), then assert each lazy chunk is
absent. Production smoke + 433/433 tests pass.

## Arc 15 — deps modernization + bundle split + CI build/audit gates (backlog #3 + #7 CLOSED, pushed `5318809`, CI green)

Three arcs landed as commits `d9cd443` (exceljs + vendor split + motion removal) and
`5318809` (CI gates).

**Backlog #3 closed — xlsx → exceljs (in `d9cd443`):**
- `xlsx@0.18.5` (Prototype Pollution + ReDoS, no fixed version) REMOVED; replaced with
  `exceljs@4.4.0` behind `client/src/utils/excel.ts` (`readFirstSheetRows` /
  `buildTemplateWorkbook`). The helper preserves xlsx's exact `sheet_to_json(defval:'')`
  contract — empty cells → `''`, numbers as full-precision strings — so the BS calendar
  parser in `BsCalendarUtility.tsx` needed no logic changes, only the I/O layer swapped.
- `tests/excel.helper.test.ts` (4 tests) proves roundtrip + numeric-precision equivalence.
- `npm audit` now **0 vulnerabilities** (was 5 moderate + unfixable xlsx highs); fixes
  via package.json `overrides`: exceljs's transitive `uuid@^11.1.1`, `qs@6.16.0` for
  express/body-parser.

**Vendor bundle split (in `d9cd443`):**
- The 943 kB (272 kB gz) monolithic `vendor` chunk came from two bugs:
  1. `manualChunks` checked `id.includes('react')` BEFORE `lucide-react` — the substring
     'react' swallowed every icon into vendor-react. Fixed with boundary-anchored regexes
     (`/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/.]/`), lucide checked first.
  2. `App.tsx` had zero `React.lazy` — exceljs (940 kB!) rode in the startup vendor chunk
     via statically-imported `BsCalendarUtility`. Now lazy with `<Suspense>` at both
     render sites; exceljs lives in `vendor-excel`, downloaded only on first visit to the
     BS calendar tabs.
- Result: startup payload dropped ~656 kB raw / ~190 kB gz. `vendor-react` 69 kB gz,
  `vendor-icons` 12.7 kB gz (now actually exists), `vendor-excel` 270 kB gz on-demand.

**Dead dependency removed (in `d9cd443`):** `motion` (framer-motion) uninstalled after a
full frontend audit — zero imports/JSX usage in all 87 client source files; animations are
pure CSS (Tailwind transitions; no @keyframes even). No vendor-motion chunk was ever
emitted because Rollup tree-shook it. LESSON: grep before assuming a dependency is used.

**Backlog #7 closed — CI build + audit gates (in `5318809`):**
CI's gate list is now complete:
1. `npx tsc --noEmit` — type errors
2. `npm test` — 619 tests against a real PostgreSQL 16 service container (drift guard,
   concurrency proofs, HTTP positive paths — zero skips)
3. `check:no-inline-sql` — repo-layer convention
4. **NEW** `npm run build` — vite + esbuild production bundles (catches bundling-only
   breakage)
5. **NEW** `npm audit --omit=dev` — non-zero exit on any production-dependency advisory
   (deliberately NOT gating on dev deps; they surface in local audits)

Remaining backlog: #5 (login/branch-scoping HTTP integration tests — partially covered),
Redis event bus (parked by design decision), mirror-retirement steps 3–4.

## Arc 14 — SSE auth + helmet + JSON_BODY_LIMIT (backlog #2 CLOSED, pushed `ab0e130`, CI #36 green)

The whole chain was shipped across commits `2547c35` (feature), `d1d0d3f` + `ab0e130`
(CI fixes), landing run **#36: success**.

What closed backlog #2:
- **SSE auth** (`server/src/middleware/sseAuth.ts`): `/api/sync/stream` AND `/api/sync/version`
  were in app.ts's publicRoutes bypass — free live change feed for anyone. Now `requireSseAuth`
  accepts the standard HMAC token via `Authorization: Bearer` OR `?token=` query param
  (EventSource cannot send headers — the client `client/src/services/api/sync.ts` appends the
  token from localStorage `inventory_auth_token`). 401 BEFORE any SSE handshake (no stream
  headers, no sseClients entry, no keep-alive timer). Token-in-URL tradeoff accepted for the
  trusted-LAN single-server deployment; same 8h credential as every other request.
- **helmet 8.3.0** app-wide in createApp(): CSP, nosniff, X-Frame-Options, COOP/CORP.
  **HSTS disabled + CSP `upgrade-insecure-requests` removed** — DELIBERATE, the app serves
  plain HTTP on the company LAN; HSTS on http:// is ignored/misleading. Re-enable when a
  TLS proxy is added.
- **JSON_BODY_LIMIT enforced** in `express.json({ limit })` (default 1mb; .env.example's
  documented value now actually works). Found via tests: body-parser's 413 was masked as 500
  by errorHandler — fixed by passing through 4xx `status`/`statusCode` on non-ApiError errors.
- **SSE connection cap** (`server/src/middleware/sseRateLimit.ts`): per-IP CONCURRENT streams
  (default 6) via attempt-on-connect + **revoke-on-close** (res 'close'/'finish') — the window
  only ever holds open streams, so it behaves like a true concurrency cap, not a request-rate
  cap (a rate cap would lock out long-lived legitimate sessions). 429+Retry-After; env
  `SSE_MAX_CONNECTIONS_PER_IP` / `SSE_RATE_LIMIT_DISABLED` (documented in .env.example).
  Wired: `/sync/stream` runs `sseConnectionLimit → requireSseAuth` (cap checked before HMAC),
  other `/sync/*` just requireSseAuth.
- **19 new HTTP-layer integration tests** on real Express apps on ephemeral ports
  (`tests/sseAuth.guard.test.ts`, `tests/httpHardening.test.ts`, `tests/sseRateLimit.test.ts`)
  — the repo's first tests that exercise the actual middleware chain, not fake req/res.

### ⚠️ CI lesson from runs #34/#35 (READ BEFORE ADDING POSITIVE-PATH HTTP TESTS)

Requests admitted by the auth/body gates flow through `requirePostgres`, which returns **503
in CI (no PostgreSQL service)**. Any integration test asserting a 200 through the full chain
MUST be `{ skip: !dbReachable && '…' }` where `dbReachable` is a top-of-file `SELECT 1` probe
(see the three test files above for the exact pattern). Rejection paths (401/429/413) run
BEFORE the DB gate and execute in CI — keep those unskipped so CI still guards them.
Verification trick: `mv .env .env.bak && npm test && mv .env.bak .env` reproduces CI locally
(GitHub job logs 403 for unauthenticated curl, so you cannot read them remotely). Local no-DB
result: 407 pass / 12 skipped / 0 fail.

Backlog after this arc:
3. xlsx 0.18.5 unfixable high advisory — DONE (Arc 15, exceljs migration).
4. Numeric env-var guard helper — DONE (commit `629d569`, envGuard.ts).
5. Integration tests for auth/branch-scoping middleware — PARTIALLY covered now: the SSE
   hardening tests exercise requireAuth/requireSseAuth via HTTP; login + branch-scoping
   still untested at HTTP layer. ← NEXT
7. CI never runs vite build / npm audit — DONE (Arc 15, commit `5318809`).

## Arc 13 — schema.sql drift fix + drift guard (DONE, pushed `bc5817c`, CI #32 green)

The user confirmed the live database has **30 tables**. A column-level diff of
`information_schema.columns` against `scripts/schema.sql` found exactly ONE gap:
`purchase_orders.status_override VARCHAR(30)` existed in the live DB only via an
`ALTER TABLE ... ADD COLUMN` at the bottom of schema.sql — the CREATE TABLE block omitted
it, so a FRESH database built from the script alone would silently miss the column.

Fixes (commit `bc5817c`):
- schema.sql: `status_override VARCHAR(30)` declared inside CREATE TABLE purchase_orders
  (right after `status`), matching the live type exactly.
- `server/src/boot/dbBoot.ts`: runtime DDL now also adds the column (idempotent), and the
  stale boot logs "(28 tables)" / "All 29 Database tables" corrected to 30.
- `tests/schema.drift.guard.test.ts` — NEW regression guard, runs in every `npm test`:
  parses every schema.sql CREATE TABLE block and compares against the live DB's
  information_schema (4 assertions: tables↔blocks, live columns ⊆ block, block columns ⊆
  live, 30-table count pinned). READ-ONLY (information_schema only). Failure message names
  the exact missing table.column. Skips without a reachable DB (CI stays green).

Proofs run this arc:
- Column diff post-fix: 30 tables, 486 columns, ZERO drift.
- Fresh-install proof: applied the FULL schema.sql verbatim to throwaway DB
  `inventory_freshinstall_test` (dropped after) — 30 tables + 174 indexes came up with
  ZERO errors, and every column's type/length/nullability matched the live DB exactly.
  (174 vs 125 explicit CREATE INDEX statements = 125 + 30 PKs + 19 UNIQUE-constraint
  indexes PostgreSQL creates automatically. NOT drift.)
- First diff attempt showed ~970 false mismatches — that was psql's CRLF output breaking
  the parser (`tr -d '\r'` fixed it). If a future drift check explodes with nonsense,
  suspect line endings first.

Commits pushed `3dcab7b..bc5817c`, CI run #32 on `bc5817c`: success, all steps green.

## Arc 12 — app.ts extraction (backlog item #6, DONE, pushed `b31446a`)

**Decision first: the app will stay SINGLE-INSTANCE on the company's own server — no further
scale-out work.** The user explicitly cancelled multi-server scaling; the earlier architecture
assessment (Redis pub/sub, multi-instance rate-limit store) is parked, not scheduled.

The 3,386-line app.ts monolith is now a **246-line composition root + facade**. ZERO caller
changes: routes/controllers still `import { … } from '../app'` and get live ESM bindings.

New module map:
- `server/src/state/runtimeState.ts` — ALL shared mutable state as `export let` live bindings
  (users, branches, products, … + isPgConnected/dataVersion via getPgConnected/getDataVersion),
  setters, CACHE_LOADS, hydrateOperationalData, refreshOperationalCache. THE key insight: ESM
  `export let` bindings stay live through re-exports, so `export * from` was NOT needed —
  app.ts explicitly re-exports each name. Only runtimeState may assign the bindings.
- `server/src/boot/dbBoot.ts` (1,246 lines) — schema DDL sync, seedInitialPostgresData,
  loadPermissionMatrixFromDb, backfillSerialLog, exports syncDatabaseAndIndexes.
- `server/src/realtime/sse.ts` — sseClients Set + broadcastChange (Redis pub/sub plugs in here later).
- `server/src/db/transactions.ts` — withTransaction/withConnection.
- `server/src/services/audit.service.ts` — logAuditEvent (imports state/sse/auth directly).
- `server/src/utils/docNumber.ts` — generateStandardTransactionId, issueNextDocNumber,
  normalizeDocTypeCode, padSequence. `server/src/services/serverDocNumber.ts` — C2 atomic claim.
- `server/src/utils/fiscalYear.ts` — toCalendarDate/pickCurrentFiscalYear (pure) + FY code/id
  resolvers taking fiscalYears as param (app.ts binds the live cache).
- `server/src/utils/trading.ts` — computeTradingFromOps (pure).
- `server/src/controllers/permissions.core.ts` — VALID_ROLES, validateRole,
  requireStockOperationPermission.
- `server/src/services/serialEdit.handler.ts` — handleUpdateSerials + runSerialEditCapture
  (NOT in controllers/ — it holds raw SQL; the no-inline-SQL guard scans controllers/ and
  would fail CI).
- `server/src/services/superAdminAuth.service.ts` — verifySuperAdminCredentials.
- `server/src/routes/fiscal.routes.ts` — registerLeftoverFiscalRoutes (opening-stock + vendor-
  opening-balance endpoints). Uses `routes/fiscal.auditAccess.ts` setLogAuditEvent() shim to
  get logAuditEvent without importing app.ts (cycle avoidance).
- `server/src/middleware/cacheRefreshHook.ts` — the res.json-wrapping cache-refresh middleware.
- `models/procurement.repo.ts` — VENDOR_PAYMENT_SELECT moved here (repo = correct home for SQL).
- middleware/index.ts now re-exports getUserFromReq + verifyPassword from './auth'.

Gotchas hit (worth knowing for future extraction work):
- The file tools CANNOT patch-replace a 3.4k-line file (diff too large) — delete + fresh write works.
- `server/src/<subdir>/x.ts` imports db via `../../db` (NOT `../../../db` — that's for server/src files).
- write_file occasionally drops the `instructions` field — retry with it present.
- Boot test: real server on :3210 booted, health OK, login OK, all 29 tables synced, caches
  hydrated (14 products / 28 stock rows / 52 stock ops). Ambient leftover server on :3000 still
  running from an old session (WS port 24678 conflict warning in boot log is harmless).

Remaining app.ts content: PORT parsing, createApp (middleware pipeline), registerAllRoutes,
providerSupplierIdFromName, sharedStateAccessors conformance object, getFiscalYearCode/IdForDate
wrappers. Facade header documents the full module map for new code.

## Full-project audit + calculation fixes (this session, COMMITTED + PUSHED through `bc5817c`)

Landed after the notes below were written. All pushed; CI green through run #32 on `bc5817c`.

### Arc 1 — Mirror retirement steps 1+2 (DONE)
- `vendorOpeningBalances` mirror fully deleted: declaration, setter (+ sharedState.ts
  interface + SharedStateAccessors entry), CACHE_LOADS entry, boot-log mention.
- Step 2 needed NO code: all five GETs (uom, locations, categories, auditTrail,
  approvalRequests) were ALREADY PG-first in masterdata/misc.controller — the audit doc's
  "serves mirror" findings are stale (pre-modularization line refs). Mirror fallbacks
  remaining there are intended PG-down demo mode. docs/mirror-audit.md still says
  otherwise — update it when convenient.

### Arc 3 — C1: server-side recompute of financial aggregates (DONE)
New pure module `server/src/utils/money.ts` (all arithmetic in server JS; DB stores
results via parameterized SQL only). Helpers: `num`, `roundMoney`, `clamp`,
`computeOperationTotalValue(items, resolveUnitCost)`,
`computeLegacyOperationTotalValue(quantityChanged, costPerUnit)`, `computeBillTotals(items,
discountInput?)` → {grossSubtotal, discount, netSubtotal, taxableAmount, nonTaxableAmount,
vatAmount, grandTotal}.

Wired into three write endpoints; client-supplied aggregates are now ignored:
- `post_stockOperations`: totalValue = Σ |qty| × resolved unit cost (chain: item.unitCost →
  item.costPerUnit → req costPerUnit → product.costPrice → 0, matching the movement
  ledger). Legacy single-line shape recomputed too.
- `post_purchaseOrders`: subtotal/tax/total from line primitives (qty × unitPrice,
  taxRate/isTaxExempt); per-line discounts clamped to line gross. No PO-level discount
  exists yet, so no discountInput is passed.
- `post_purchaseInvoices`: newInv.taxableAmount/vatAmount/nonTaxableAmount/grandTotal/
  subtotalAmount recomputed BEFORE both the mirror write and piUpsertParams. Client's
  `totalDiscount` kept (legitimate business input like qty/price) but clamped to [0, gross]
  and allocated across lines proportionally (matches client allocation). Taxability from
  item.taxRate>0 / isTaxExempt; rate defaults to 13% VAT.
- Already-clean paths verified and left alone: computeTradingFromOps (read-path),
  post_reconcileAudit netFinancialImpact, buildDamageRecordInsert.
- 18 new tests in `tests/money.test.ts` → 358/358.

### Arc 11 — login rate limiting (audit backlog #1, DONE)
Audit said "rate limiting: NONE exists; env vars documented but unimplemented". Now
implemented, dependency-free (no new packages):
- `server/src/utils/rateLimiter.ts`: sliding-window `RateLimiter` (per-key buckets,
  hits age out individually, rejected attempts NOT recorded — they never extend a
  block; lazy pruning bounds memory; injectable clock for tests) + `attempt`/`revoke`/
  `reset` + `buildRateLimitKey(scope, req, account?)` (req.ip → socket → 'unknown')
  + `buildAccountRateLimitKey(scope, account)`.
- `server/src/middleware/authRateLimit.ts`: `createAuthRateLimit({scope,
  accountFrom})` with TWO independent buckets: **ip** (counts ALL attempts — stops
  one host spraying accounts) and **account** (GLOBAL across ips, FAILURE-ONLY —
  recorded optimistically, revoked after a non-4xx response via res.json wrap). A
  distributed attack on one account is throttled at scope:account:<email> without
  letting attackers lock the account out (successes clear their own hit) and without
  collateral lockout of other accounts. 429 + Retry-After (seconds) + JSON body;
  fail-open on limiter errors (availability > strictness); env:
  AUTH_RATE_LIMIT_MAX (10) / AUTH_RATE_LIMIT_WINDOW_MS (900000 = 15 min) /
  AUTH_RATE_LIMIT_DISABLED — documented in .env.example.
- Wired: `/api/auth/login` AND `/api/auth/forgot-password` (also abusable) in
  auth.routes.ts. In-memory state resets on restart — single-process OK; multi-
  instance needs the shared store (Redis pub/sub task).
- Tests (+19 → 399/399): limiter core (slide/retry/no-extend/prune/revoke/config
  guards), key builders, middleware (429 on ip exhaustion w/ account rotation,
  global failure-only account bucket, no collateral lockout, fail-open, scope
  isolation). REAL-SERVER smoke (temp script, deleted): booted createApp +
  registerAllRoutes, 5× login → 401 401 401 401 401, 6th → 429 + Retry-After: 60 +
  message, different account same ip → 429.
- Design catch during TDD: first draft keyed the second bucket as scope:ip:account —
  a strict subset of the ip bucket, useless against ip rotation. Global failure-only
  per-account bucket is the OWASP-style fix.

### Arc 10 — real-PG concurrency proof for C3 stock locking (DONE)
`tests/stock.concurrency.test.ts`: replays the EXACT C3 transaction body of
post_stockOperations (BEGIN → STOCK_LOCK_FOR_UPDATE_SQL → re-verify from locked rows →
STOCK_CONSUME_QOH_SQL / STOCK_DAMAGE_APPLY_SQL → COMMIT) against a live PostgreSQL on a
throwaway DB (inventory_stock_concurrency_test; app DB untouched; drops in teardown;
skips without a DB). Four proofs: (1) two parallel stock-outs of the LAST unit →
EXACTLY one 'posted', one 'rejected', final qoh 0; (2) the loser is rejected at the
re-verify step after the winner commits and leaves NO partial state; (3) same for a
parallel DAMAGE race — exactly one unit moves usable→damaged (final qoh 0, damaged 1);
(4) plentiful stock: parallel postings BOTH succeed (locks serialize but never block
legitimate work), final qoh exact. Debug note: test 3 initially failed with
['rejected','rejected'] — test-order state leakage (test 2 had consumed the contested
unit), fixed by resetting the row in the test itself; the lock pattern was never at
fault. +4 tests → 380/380.

### Arc 9 — real-PG concurrency proof for the doc-number claim (DONE)
`tests/docnumber.concurrency.test.ts`: integration test against a LIVE PostgreSQL
proving `DOC_NUMBER_CONFIG_CLAIM_SQL` (the statement post_generateNext and
generateNextDocNumberForServer-style claims rely on) cannot double-issue numbers:
24 parallel claims must return 24 DISTINCT, GAPLESS numbers (exactly 1..24), every
before/after pair consistent (after = before + 1), formatted numbers unique, counter
ends at 25, and two sequential batches never overlap. Isolation: creates throwaway DB
`inventory_concurrency_test` (never touches inventory_db), drops it in teardown; when
no PostgreSQL is reachable the tests SKIP (t.skip), so CI/demo environments stay green.
Run #29-style CI will not exercise it; local dev with .env DATABASE_URL does.
Debug note: the first failing run was a TEST bug — the duplicate-check message called
`befores.sort(...)` in place, mutating the array and desyncing it from completion-
ordered afters (assertion messages must not mutate their operands). A standalone probe
of the raw SQL (24/24 unique, gapless, zero torn pairs) confirmed the atomic claim is
flawless. +2 tests → 376/376.

### Arc 8 — C4 regression guard test (DONE)
`tests/bs_date.guard.test.ts`: pure core `findHardcodedBsDates(sources, serverRoot?)`
scans every .ts under server/src for QUOTED 'YYYY-MM-DD BS' literals and fails for any
outside the allowlist (utils/bsDate.ts = sanctioned BS_DATE_FALLBACK;
config/seedData.ts = fiscal-year seed rows). Broader than the original 2083-04-16/22
offenders: ANY fixed BS date literal is the same bug class, so the regex covers all
YYYY-MM-DD BS values. Only quoted literals count — bsCalendar's educational prose
("send dateBS=2083-05-14 BS") and comments stay legal. Live-tree test walks the real
server/src (relativizes absolute paths before allowlist matching — Windows-safe).
5 unit tests + 1 live-tree test → 374/374.

### Arc 7 — post_generateNext atomic claim (last doc-number race closed, DONE)
`admin.controller.post_generateNext` (Fiscal Year Management > Document Numbering
"Generate Next" button) previously did read-then-increment: mirror-first config read,
then `DOC_NUMBER_CONFIG_INCREMENT_SQL` with a computed value — two concurrent callers
could both read nextNumber=N and both write N+1, issuing the same number twice.
Now, when `autoIncrement !== false`, it FIRST tries `DOC_NUMBER_CONFIG_CLAIM_SQL`
(admin.repo.ts): `UPDATE document_number_configs SET next_number =
next_number + 1 WHERE id = $1 RETURNING next_number - 1 AS next_number_before,
next_number AS next_number_after, prefix, suffix, min_digits` — same C2 pattern as
generateNextDocNumberForServer. Returned before-value is the number this caller
consumes; mirror is synced to the after-value. Falls back to the legacy mirror path
only when the claim fails (DB down) or the doc type has no DB row; read-only preview
(`autoIncrement === false`) never touches the counter. +1 test (SQL shape) → 368/368.

### Arc 6 — C3: row-level locking for stock writes (mirror step 4, DONE)
`inventory.repo.ts` gained `STOCK_LOCK_FOR_UPDATE_SQL` + `stockLockForUpdateParams`:
set-based `SELECT s.product_id, … quantity_on_hand, damaged_qty, reserved_qty FROM
inventory_stock s JOIN unnest(…) targets … ORDER BY s.product_id FOR UPDATE`. Products
deduplicated; ORDER BY gives deterministic lock acquisition (no deadlocks). MUST run
inside the caller's transaction (locks held to commit).

Wired as lock-and-re-verify inside the PG transactions:
- `post_stockOperations`: FIRST statement in the tx for consuming ops (DAMAGE / PULLOUT /
  STOCK_OUT / CONSUMABLE_ISSUE) — locks every (product, branch) row, re-verifies
  qoh (or damaged_qty for `condition === 'DAMAGED_STOCK'` pullouts) from the returned
  DB rows, throws a retry-able "Insufficient … in the database" error if short. The
  mirror pre-flight stays as a fast user-facing check; the tx now guarantees the
  verdict. The guarded UPDATEs (… >= qty) remain as a belt-and-braces backstop.
- `post_reverse`: locks the damaged rows right before STOCK_REVERSE_DAMAGE_BATCH_SQL
  and re-verifies damaged_qty per delta from DB truth (mirror pre-flight
  `validateReversalAvailability` can race a concurrent reversal of the same batch).
  The batched restore's `rowCount !== deltas.length` guard stays as backstop.
- Outcome: concurrent writers now serialize per stock row and the accept/reject
  decision always reflects committed DB state, not a mirror snapshot. All decisions
  still happen inside the existing withTransaction scopes — no new transaction
  boundaries, no extra round-trips beyond one set-based SELECT.
- Tests: +3 (lock SQL shape, dedup/broadcast params, empty-id filtering) → 367/367.

### Arc 5 — C4 extended to ALL remaining hardcoded BS dates (DONE)
The four follow-up sites plus, opportunistically, every other literal in the server:
- `logAuditEvent` (app.ts) is SYNC and called from ~30 places, so it now uses the new
  `todayBs()` — a SYNC resolver answering from the in-memory bs_day_records cache that
  `hydrateBsCalendarFromDb` keeps in sync with PostgreSQL at boot/reconnect. Same data
  as the async path, minus the round-trip. bsCalendar.ts gained a
  `getInMemoryBsDayRecords()` getter (live binding across modules).
- PROFILE_SWITCHED audit row (auth.controller): `todayBs()`.
- Approval-request rows (misc.controller ×4): requestedAtBS, processedAtBS in
  post_process and post_cancel, and the PULLOUT txn on approval — all `todayBs()`.
- issuedDateBS fallbacks (inventory.controller): post_customerDevices CDR upsert and the
  post_exchange replacement-device record — `todayBs()` (was '2083-04-16/28 BS').
- BONUS (same class, cheap because async): post_assets acquisition/purchase-invoice BS
  fallbacks and post_purchaseInvoices invoiceDateBS fallback now derive from the
  actually-stored AD date via `await resolveBsDateForLedger(adDate)` instead of a fixed
  literal — previously a backdated asset got today's BS date regardless.
- Last-resort literals (procurement post_pay, piTxnLogParams) now reference the shared
  `BS_DATE_FALLBACK` constant from utils/bsDate.ts — one source of truth for the
  fallback value; bs_day_records is always tried first on those paths.
- Net effect: **no '2083-04-xx BS' literals remain anywhere in server/src outside
  utils/bsDate.ts** (seedData/bsCalendar own their legitimate seed-calendar data).
- Tests still 364/364 (c1.e2e covers dateBS shape via stock ops).

### Arc 4 — C2 + C4 fixed, C1 verified E2E (DONE)
- **C2 (race-safe doc numbering):** `generateNextDocNumberForServer` (app.ts) is now
  async and claims the sequence atomically via `UPDATE document_number_configs SET
  next_number = next_number + 1 ... RETURNING next_number, prefix, suffix, min_digits`.
  The returned number = claimed seq − 1 (the value THIS caller consumes; no
  double-increment), and the in-memory mirror is synced to the DB counter. Offline/demo
  mode now falls back to `generateStandardTransactionId` (timestamp-based) instead of the
  racy in-memory counter with fire-and-forget persistence. It had NO other callers, so
  the async signature change is safe. Note: admin.controller's `post_generateNext` has a
  similar read-then-increment pattern — it awaits the DB increment, but the read is from
  a mirror-first config; candidate for the same atomic UPDATE later (left as-is).
- **C4 (BS dates):** new `server/src/utils/bsDate.ts` — `resolveBsDateForLedger(adDate?)`
  resolves "YYYY-MM-DD BS" from bs_day_records via `findBsDayRecordForAdDate` (PG →
  in-memory fallback → `BS_DATE_FALLBACK` '2083-04-16 BS' last resort). Wired into
  `patch_Id` (3 rows: damage ledger, damage-record adjustment DB + mirror, manual-
  adjustment ledger) and `post_reconcileAudit` (audit ledger + audit shortage damage
  record) — all hardcoded '2083-04-16/22 BS' strings there are gone.
  REMAINDER (same class, out of the agreed C4 scope, still hardcoded): app.ts:logAuditEvent,
  auth.controller PROFILE_SWITCHED, misc.controller approval-request rows ×4,
  procurement.controller post_pay last-resort fallback (already tries bs_day_records
  first), piTxnLogParams invoiceDateBS fallback, inventory.controller:1404 issuedDateBS
  fallback. All are sync-only display fallbacks except logAuditEvent (sync, called
  everywhere) — converting it needs a wider refactor.
- **C1 verified E2E:** new `tests/c1.e2e.test.ts` (6 tests) calls the REAL controller
  functions with tampered payloads in demo mode (PG down): fake `totalValue: 999999` on
  stock ops, tampered `subtotalAmount/taxAmount/totalAmount` header + per-line
  `subtotal/taxAmount: 999` on POs, `grandTotal: 1` + negative/over-gross `totalDiscount`
  on PIs. Server recomputes correct values in every case (e.g. DAMAGE total = 320 not
  1,000,000; PI net 1044 / taxable 870 / VAT 113.1 / grand 1157.1). Also found+fixed a
  gap while writing these tests: post_purchaseOrders previously spread `...req.body`
  AFTER the computed totals, letting a client header total override the recompute —
  totals now applied after the spread (orderDateAd/orderDateBs normalization preserved).
- Tests: +6 → 364/364.

### Arc 2 — Project audit → calculation-accuracy fixes B1–B5 (DONE, with decisions)
Full audit found 13 verified-correct calc paths, 5 bugs, 4 caveats (C1–C4). All bugs fixed:

- **B1 reversal ledger truth:** `STOCK_REVERSE_DAMAGE_BATCH_SQL` now has
  `RETURNING product_id, quantity_on_hand`; `post_reverse` builds the DAMAGE_REVERSED
  ledger INSIDE the tx from those rows via new pure helper
  `buildReversalLedgerFromRestoredRows` (damage.service.ts): quantityBefore = restored −
  qty, quantityAfter = returned value. Stale mirror no longer feeds the ledger. PG-down
  demo path keeps old `buildReversalLedgerWithStock` behavior.
- **B2 damage-pool ledger sign:** new pure helper `buildDamagePoolLedgerChange(before,
  after)` (damage.service.ts) — pool increase = negative change, decrease = positive,
  no-op = 0. Used by `patch_Id`'s DAMAGE ledger row; invariant before+changed=after now
  holds. Old code wrote `-Math.abs(damDiff)` which inverted decreases and invented
  `-(damagedQty||1)` on no-ops.
- **B3 PI ledger id collisions:** `piTxnLogParams(inv, item, branchId, itemIndex = 0)` —
  ids are now `txn-<ts>-<productId>-<index>`. Call site loops with index. Prevents silent
  ledger-row loss when one invoice repeats a product or two invoices commit in the same ms.
- **B4 audit reconcile stock-wins (DECISION: counted total is authoritative):**
  `post_reconcileAudit` now ALSO subtracts `min(damagedQty, |delta|)` from `damaged_qty`
  in inventory_stock (new `STOCK_RECONCILE_DAMAGED_ADJUST_SQL` +
  `stockReconcileDamagedAdjustParams` in inventory.repo.ts) when it writes the audit
  shortage damage record, and updates the mirror `stk.damagedQty` to match. Register and
  stock no longer double-count a shortage. If info-only semantics ever preferred, revert
  the two added statements.
- **B5 depreciation rewrite (DECISION: annual column = CURRENT-year charge):**
  `client/src/utils/depreciation.ts` rewritten: all methods use whole-month convention;
  declining methods' annual = F(t) − F(t−12mo) of the accumulated function (year 2 of
  40% DB on 100k now shows 24,000, not the constant 40,000); reducing-balance accumulated
  = formula value (authoritative for compounding method — stored value intentionally NOT
  used there); SL accrues linearly by months; accumulated capped at cost, NBV floored at 0;
  degenerate inputs (no cost/rate, as-of < acquisition) keep stored values verbatim.
  13 new tests in `tests/depreciation.test.ts`.
- Tests: +18 (damage-pool ledger, PI id uniqueness, depreciation) → 340/340.

**Remaining caveats: NONE.** C1–C4 all DONE (C1 server-side recompute + E2E-verified;
C2 atomic doc-number claim; C3 row-level locking, this arc; C4 bs_day_records-derived
BS dates everywhere). Residual known-limitations noted elsewhere: post_generateNext
read-then-increment pattern in admin.controller; BS display fallbacks that cannot see
unseeded calendar days use BS_DATE_FALLBACK.

### Also from the audit — prioritized backlog (beyond the mirror roadmap)
1. ~~Rate limiting: NONE exists; env vars documented but unimplemented (login brute-forceable).~~ DONE (Arc 11).
2. ~~SSE endpoint `/api/sync/stream` has NO requireAuth; no helmet/security headers;
   JSON_BODY_LIMIT documented but express.json() at default.~~ DONE (Arc 14: SSE auth via
   header-or-query HMAC token, helmet with LAN-safe config, JSON_BODY_LIMIT enforced with 413
   passthrough, per-IP concurrent-stream cap).
3. xlsx 0.18.5 unfixable high advisory (client-side parsing) — evaluate exceljs.
4. Numeric env-var guard helper (PORT=0 trap class) — do before rate limiting.
5. Integration tests for auth/branch-scoping middleware (zero HTTP-layer tests today).
6. ~~app.ts extraction plan (state → plumbing → schema/boot → serial flows → leftover routes).~~ DONE (Arcs 12–13; note: with the user's single-instance decision, the Redis pub/sub task is PARKED, not pending).
7. CI never runs vite build / npm audit; no ESLint.

## Earlier session (all pushed)

1. **`cd4112f`** — api.ts split into per-domain modules (`client/src/services/api/`:
   http/auth/bootstrap/inventory/procurement/finance/admin/sync + barrel). Zero call-site
   changes — imports of `../services/api` resolve to the folder's index.ts.
2. **`cd4112f` (same commit)** — reversal transaction batching: damage + consumable reversals
   now use set-based unnest UPDATEs + multi-row ledger inserts
   (`STOCK_REVERSE_DAMAGE_BATCH_SQL`, `STOCK_RETURN_QOH_BATCH_SQL`, `DAMAGE_RECORD_CANCEL_BATCH_SQL`,
   `buildTxnMultiRowInsertSql` in inventory.repo.ts). Verified live end-to-end.
3. **`9ae25d5`** — improvement #2: SSE events carry a `domain` tag (`server/src/syncDomains.ts`);
   client refreshes only affected bootstrap slices via `GET /api/bootstrap/local?key=…`;
   unknown domains / mixed bursts fall back to full bootstrap. Mapping pinned by
   `tests/syncDomains.test.ts`.
4. **`1e373fa`** — mirror audit deliverable: `docs/mirror-audit.md` (classification + retirement order).
5. **`7804306`** — PORT validation fix (ambient `PORT=0` in this shell harness made the server
   bind an ephemeral port; non-positive/garbage now falls back to 3000).
6. **`edcc4ea`** — README updated for all of the above.

## ⚠️ Environment quirks for the new session

- **This shell exports `PORT=0`** — any server start reads it; code now guards, but keep in
  mind for other tools. `PORT=3000 npx tsx server/index.ts` no longer required but harmless.
- Dev server may still be running on :3000 from last session (check `netstat -ano | grep :3000`).
  A server started by a previous Freebuff session dies when the session restarts — restart it.
- Login for API smoke tests: `superadmin@example.com` / `Demo@123` (demo users from seed).
  DB: `PGPASSWORD=securepassword psql -h localhost -U inventory_user -d inventory_db`.
- `/tmp` paths don't work for node in this Git Bash — use project-relative temp files.
- ripgrep tool in code_search intermittently fails (rg.exe ENOENT) — fall back to
  `run_terminal_command` grep.

## Remaining improvement tasks (in recommended order)

### 1. Mirror retirement steps 1+2 — DONE, see ⭐ Arc 1 above

### 2. Mirror retirement step 3 (MEDIUM)
- Invert `customerDeviceRecords` mirror-first reads → PG-first in rename/exchange flows
  (the PG query already exists right after the mirror read — trivial inversion).
- Point `stockOperations` find-by-id at PG (`STOCK_FIND_BY_ID_SQL` exists) — also fixes the
  flagged inconsistency: legacy `get_stockOperations` GET (inventory.controller ~689) serves
  the mirror even while PG is up, unlike the paged path.

### 3. Mirror retirement step 4 (HARD — needs design)
- Replace mirror-based stock pre-flight checks with `SELECT … FOR UPDATE` inside the write
  transaction (pattern exists in `post_receive`). NOTE: the reversal-ledger half of this
  is already fixed (B1 above — ledger reads RETURNING rows), what remains is the
  two-concurrent-issues pre-flight race and friendlier error surface.
- Then drop `serialLogs` mirror's 3 narrow uses (clash pre-check app.ts ~1317,
  quarantine/restore in damage flows, serial PATCH lookup ~1829) — PG equivalents already run.

### 4. Redis Pub/Sub event bus — DECLINED (decided 2026-09-26, do not re-litigate)
- Decision: NOT needed for this deployment. Rationale: single Node process
  (`node dist/server.cjs` via PM2) — every SSE client is in that process and
  `broadcastChange()` writes to it directly; Redis Pub/Sub only pays off with multiple
  server instances behind a load balancer. Internal LAN system: tens of clients, not
  thousands. The unused REDIS_URL/SSE_REDIS_CHANNEL placeholders were removed from
  `.env.example`.
- IF multi-instance scaling ever happens, the change is contained: `broadcastChange`
  (server/src/realtime/sse.ts) already funnels every event through one function — swap
  its write loop for publish + subscribe fan-out (`ioredis`), keep the in-memory Set
  for local connections.

### 5. Bootstrap trim continuation (consumer-driven)
- `stockOperations` / `purchaseOrders` / `purchaseInvoices` still ship in bootstrap (see trim
  list comment in bootstrap.controller.ts ~line 122). Consumers to migrate: dashboard KPIs,
  FY-closing wizard, PI pending-PO dropdown, movement ledger. Trim list doc is in README
  "Paged Register Endpoints".

### 6. Smaller follow-ups
- **Env var audit — DONE (2026-10-02).** `.env.example` now documents ONLY
  vars the code reads. Wired `PG_POOL_MAX` + `PG_CONNECT_TIMEOUT_MS` (guarded
  pool sizing via `buildPoolConfig()` in `server/db.ts`) and `TRUST_PROXY`
  (`createApp` → `app.set('trust proxy', …)`, so `req.ip` — the login
  rate-limit and SSE per-IP cap key — honours X-Forwarded-For behind a proxy;
  off unless the value is exactly 1/true). Deleted 11 documented-but-unread
  vars whose features do not exist: REQUIRE_POSTGRES, STRICT_PASSWORD_POLICY,
  MIN_PASSWORD_LENGTH, LOGIN_RATE_LIMIT_MAX, API_RATE_LIMIT_MAX,
  DISABLE_RATE_LIMIT, LOG_LEVEL, APP_URL, REQUIRE_MIGRATIONS, SEED_DUMMY_DATA,
  PM2_INSTANCES. Added the missing `RETURNS_APPROVAL_THRESHOLD_NPR`. Guards:
  `tests/envDocs.guard.test.ts` (documented ⇒ read, known-dead list never
  returns, wired knobs stay documented) + `tests/envWiring.test.ts` (the knobs
  reach the pool and the Express app). NOT scheduled: a global API rate
  limiter and a password-strength policy — deliberately removed, not deferred.
- **Doc-number domain — CLOSED (2026-10-02, accept eventual consistency):** document
  counter changes have no SSE domain mapping (fire-and-forget PG updates in
  issueNextDocNumber) and the client NEVER previews document numbers — the server
  issues them atomically inside the mutation transaction and forms show static
  'DN-…'/'CN-…' placeholders (e.g. ReturnsRegister.tsx ~110). A DOCUMENT_NUMBERING
  domain would therefore have ZERO consumers, so it was not added; the only visible
  effect of a doc-number mutation is the register's own refresh (registers now
  refresh via the SSE wiring below).
- **Registers + SSE — DONE (2026-10-02, extended same day):** all FOUR self-fetching
  paged registers now refresh on matching SSE domain events. App.tsx holds a
  `registerRefresh` counter object bumped inside the existing debounced SSE handler
  (targeted branch maps domains via `DOMAIN_REGISTER_KEYS`; the unknown/mixed
  full-refresh fallback bumps all four). Wiring: Serial Log keeps the existing
  `refreshKey` prop (STOCK, STOCK_OPERATIONS, SERIALS, PROCUREMENT, CUSTOMER_DEVICES,
  ASSETS domains); PurchaseOrders and PurchaseInvoices gained an optional
  `sseRefreshKey` prop in their paged-fetch effect deps (POs: PROCUREMENT + SHIPMENTS;
  PIs: PROCUREMENT); the consumable register inside StockOperations (server-paged
  CONSUMABLE_ISSUE rows via `loadConsumableRegisterPage` — the audit's 4th register,
  previously stale-prone) gained the same optional `sseRefreshKey` prop on all 11
  StockOperations render sites (STOCK_OPERATIONS domain: creation +
  REVERSE_CONSUMABLE_ISSUE / REVERSE_STOCK_DAMAGE). The domain → register mapping
  lives in `client/src/utils/registerRefreshDomains.ts` (standalone, no imports) and
  is pinned by `tests/registerRefreshDomains.test.ts` — including a guard that every
  domain the server can broadcast is either register-mapped or declared no-register.
  Still single-EventSource in App.tsx — no new SSE subscriptions (per-IP stream cap).
- **PROCUREMENT bootstrap slice widened (2026-10-02):** `DOMAIN_STATE_KEYS.PROCUREMENT`
  now also carries `purchaseReturns`, `stock`, `transactionLogs` — previously a
  purchase return (applyPurchaseReturnEffects, procurement.controller.ts ~1184) could
  deduct stock, write PR_TXN_LOG rows and flip serials while the targeted SSE refresh
  re-fetched none of those slices. All purchase-return flows tag module PROCUREMENT
  (~1298/1357/1416), so they stay targeted. (SALES is now mapped too — see the
  SALES SSE domain entry below.)
- **CRLF warnings on new files — DONE (2026-10-02):** `.gitattributes` now
  pins `* text=auto eol=lf` (+ explicit binary list, `*.sh` forced LF). The
  repo already stored every tracked file as LF, so this created ZERO content
  diffs — it only stops the traps: `core.autocrlf=true` had left 135 working
  files CRLF and 4 (schema.sql, setup_db.js, demo_dataset.js,
  procurement.repo.ts) MIXED in one file. Editing a file with a CRLF-emitting
  tool can no longer produce a spurious diff.
- **Strict TypeScript — DONE (2026-10-02):** `"strict": true` in tsconfig.json
  (now a CI gate via `npx tsc --noEmit`). It cost exactly 11 fixes: nullable
  `companyProfile` passed to the CSV printer (`exportUtils` `companyInfo` now
  accepts `null`), optional `UnitOfMeasure.isBaseUnit` (`updateUomParams`
  already coerced with `Boolean()` — the signature just hadn't caught up), the
  `res.json` async override in `cacheRefreshHook` (documented cast: the
  refresh really does settle before the body is flushed), a `never[]` test
  fixture, one nullable `notes`, and `normalizedMacAddress ?? undefined` on
  the two mirror writes. LESSON: widening `oldMacAddress` to `string | undefined`
  cascaded into 6 more errors and was the WRONG fix — the domain type
  (`SerialRenameInput.oldMacAddress: string`, `''` when absent) is the
  invariant, so line 169 now does `customerRecord.macAddress ?? ''` instead of
  letting `undefined` leak in. Fix the type at the source; don't propagate
  the hole.
- **Live SSE verification + full re-verification — PASSED (2026-10-02):**
  browser walkthrough on the running dev server (superadmin, Consumables
  Register tab): POST /api/stock-operations (CONSUMABLE_ISSUE, prod-fcn001
  ×1 on WH001) → 201; within ~1s and with NO manual refresh the consumable
  register re-ran its paged fetch (GET /api/stock-operations?type=
  CONSUMABLE_ISSUE&page=1&pageSize=20 → 200) and showed the new
  CON-WH001-202610020002 row (9→10 records), while the targeted branch
  re-fetched the four STOCK_OPERATIONS bootstrap slices (stockOperations,
  stock, transactionLogs, damageRecords via /api/bootstrap/local?key=…).
  Reversal via POST /api/stock-operations/:id/reverse-consumable → 200
  flipped the row to "Reversed" through the same SSE path; stock qty
  net-zero (190→189→190). Probe rows deleted from PG afterwards; UI back
  to 9 records on remount. Full re-verification green: npm test (tsc
  --noEmit + 522 node:test tests, 0 fail), npm run build, npm run
  check:bundle-budget (startup 278.5 kB gz vs 320 kB budget).
- **Header refresh covers paged registers — DONE (2026-10-02):** the
  header "Refresh realtime stock and logs" button (refreshAllData in
  App.tsx) re-fetched bootstrap slices but never bumped the four
  `registerRefresh` counters, so the self-fetching paged registers
  (Serial Log, Purchase Orders, Purchase Invoices, consumable
  register) stayed stale on manual refresh until the next SSE event
  or remount. Fix: extracted a pure `bumpAllRegisterRefresh(prev)`
  helper into `client/src/utils/registerRefreshDomains.ts` (module
  stays standalone/import-free); `refreshAllData` now calls
  `setRegisterRefresh(bumpAllRegisterRefresh)` before its fetch (so
  registers refresh even if the bootstrap call fails), and the SSE
  unknown/mixed fallback now relies on refreshAllData's bump instead
  of its own inline all-four increment (removed as redundant — the
  fallback's only refresh path IS refreshAllData). Pinned by 4 new
  tests in `tests/registerRefreshDomains.test.ts` (all four keys
  incremented, arbitrary counter values, purity/immutability, exact
  key coverage; suite now 619 tests, 0 fail). Live-verified:
  direct PG insert of a CONSUMABLE_ISSUE row (no SSE broadcast)
  left the consumable register stale at "9 records"; clicking the
  header Refresh button re-ran the register's paged fetch and
  showed "1–10 of 10" with the probe row on top;  probe row deleted afterwards, register back to 9 on the next refresh.
- **SALES SSE domain mapped — DONE (2026-10-02):** `SALES: 'SALES'` added to
  `DOMAIN_BY_MODULE` (server/src/syncDomains.ts) — previously every sales event
  (logAuditEvent broadcasts type=action, entity='SALES') resolved to an unknown
  domain and triggered a full-bootstrap fallback. `DOMAIN_STATE_KEYS.SALES` in
  App.tsx now targets the five slices sales mutations actually touch:
  `salesInvoices` (invoice insert + amount_paid on customer payments),
  `salesReturns` (return create/cancel/approve), `stock` (invoice deduction,
  return restock/re-deduction), `transactionLogs` (SI/SR ledger rows) and
  `damageRecords` (non-restockable returns route units into the damage register
  via SR_DAMAGE_INSERT_SQL). `customers` is deliberately EXCLUDED — sales
  mutations never UPDATE the customers table (payments land in the
  customer_payments sub-ledger, which has no bootstrap slice; the customer
  ledger is a dedicated endpoint). serial_log flips (SR_SERIAL_FLIP_SQL on
  posted/cancelled returns) are covered by the paged-register mapping instead:
  `SALES: ['serialLog']` in `client/src/utils/registerRefreshDomains.ts`
  (serialLogs was trimmed from the bootstrap payload entirely, so it can only
  refresh via the Serial Log register's own paged fetch). SalesInvoices.tsx and
  ReturnsRegister.tsx are pure presentation components fed by App-level state,
  so the slice refresh keeps them live with no extra wiring. Tests: 'SALES'
  added to the AUDIT_MODULES vocabulary + sales resolveDomain cases in
  tests/syncDomains.test.ts; SALES serialLog assertion in
  tests/registerRefreshDomains.test.ts (the guard test would otherwise fail
  once SALES entered DOMAIN_BY_MODULE). Live-verified on the dev server:
  POST /api/sales-invoices (prod-adp001 ×1, WH001) → 201, then exactly five
  targeted GETs /api/bootstrap/local?key=salesInvoices|salesReturns|stock|
  transactionLogs|damageRecords (NO full /api/bootstrap), stock 210→208 in PG;
  probe invoices/txn rows deleted and stock restored afterwards. npm test green
  (526 pass, 0 fail). Note: tsx watch did NOT pick up the server-side
  syncDomains.ts edit — the dev server needed a manual restart before the new
  mapping took effect (client hot-reloaded, server didn't).
- **SSE fallback integration test — DONE (2026-10-02):** the debounced
  SSE handler's burst → refresh-plan decision (accumulate `lastDomain`
  across the 250ms window; mixed or unknown → full bootstrap) was
  extracted from App.tsx into `client/src/utils/registerRefreshDomains.ts`
  as `SseDomainBurst` (`observe(domain?)` + `flush(isKnownDomain)` →
  `{mode:'targeted',domains:[d]}` | `{mode:'full'}`, flush resets the
  window); App.tsx's sync-stream effect now uses it — behavior-identical,
  but the shipping code is the tested code. A new describe block in
  `tests/registerRefreshDomains.test.ts` feeds REAL server events through
  `resolveDomain` → the accumulator → the plan and asserts the fallback
  contract end-to-end: unknown-domain bursts, mixed multi-domain bursts
  (known+known and known+unknown), domain-less events and 3-domain bursts
  all resolve `{mode:'full'}`, and the fallback's action — refreshAllData's
  `setRegisterRefresh(bumpAllRegisterRefresh)` — bumps all four
  `registerRefresh` counters from any starting values. Contrast tests pin
  that single-domain bursts stay targeted and bump ONLY their mapped
  registers (the all-four increment is exclusive to the fallback), that a
  repeated same-domain burst coalesces to one targeted plan, and that
  flush() resets the accumulator so a new debounce window starts clean.
  A source guard reads the real App.tsx and pins the wiring
  (`new SseDomainBurst()`, `burst.observe(event?.domain)`, `burst.flush(`, 
  the `refreshAllDataRef.current()` fallback, and
  `setRegisterRefresh(bumpAllRegisterRefresh)` inside refreshAllData) so
  the extraction can't silently be reverted. Suite now 619 tests, 0 fail
  (tsc --noEmit clean).
- **Paged-tab staleness audit — CLOSED (2026-10-02, nothing to wire):**
  audited the remaining paged/fetching tabs for the four-register
  pattern (self-fetched server-paged data outside the bootstrap
  slices, invisible to the SSE handler). None matched it:
  - **Stock Movement Ledger** (`stock-ledger` →
    StockMovementLedger.tsx, 848 lines): ZERO api calls; the only
    useEffect syncs the branch filter. `useClientPagination` over
    arrays derived from props (transactionLogs, stockOperations,
    damageRecords, stock, shipments, purchaseOrders). Every prop
    slice is refreshed by the domain that mutates it (STOCK →
    stock/damageRecords/transactionLogs; STOCK_OPERATIONS →
    +stockOperations; PROCUREMENT → +purchaseOrders; SHIPMENTS →
    +shipments; SALES → stock/transactionLogs/damageRecords).
    Key detail: the ledger prefers persisted transaction-log rows
    over the stock_operations feed, and STOCK-domain-only
    mutations (manual adjustments, patch_Id) still write a
    transaction_logs row (TXN_INSERT_NOW_SQL, changeType
    MANUAL_ADJUSTMENT, inventory.controller.ts ~278), so the
    ledger's primary feed is refreshed even by STOCK-only
    broadcasts.
  - **Asset Deployments** (`asset-deployments` → AssetDeployments.tsx,
    325 lines): zero api calls, zero effects; client pagination over
    the `assets` prop. ASSETS domain → assets slice (deploy/unassign
    broadcasts module FIXED_ASSETS → ASSETS); RECALC also covers
    assets. Its only mutation (onUnassignAsset → handleUpdateAssetStatus)
    awaits the API then calls refreshAllData.
  - **Damaged Stock Report** (`damage-report`): a StockOperations
    instance (initialType="DAMAGE_REPORT" → DAMAGE_TRACKING tab).
    The damage-log register paginates CLIENT-side over the
    `operations` prop — the code comments it "without any
    server-side window" (StockOperations.tsx ~2197). The ONLY
    self-fetch in StockOperations is loadConsumableRegisterPage
    (CONSUMABLE_ISSUE rows), whose effect deps already include
    sseRefreshKey (~2085), and this render site already passes
    sseRefreshKey={registerRefresh.consumableRegister} (wired in
    the registers arc). STOCK_OPERATIONS domain refreshes the
    stockOperations slice itself.
  - Bonus, **Damaged Stock Matrix** (`damaged-stock` →
    DamagedStockTracking.tsx, 1290 lines): renders from the
    damageRecords/stock props; its only api calls are the BS-calendar
    availability check on mount (not business data) and a
    stock-operation lookup inside the reversal flow (followed by
    window.location.reload). Disposal write-off routes through
    onCreateOperation → handleCreateOperation → refreshAllData.
  Conclusion: the only server-paged fetch in this corner of the app
  (the consumable register shared by the damage-report tab) was
  already wired; these tabs are pure presentation over bootstrap
  slices, so no DOMAIN_REGISTER_KEYS entries or props were needed.
  Mutation-side coverage is via the App-level
  handlers (handleCreateOperation / handleUpdateStockLevel /
  handleUpdateAssetStatus all `await api.*` then refreshAllData),
  with SSE covering every other client.
  Addendum (2026-10-02, follow-up request): a source-guard test in
  tests/registerRefreshDomains.test.ts ("Paged-tab audit guard —
  no self-fetching data loads") now pins this: StockMovementLedger
  and AssetDeployments must keep ZERO api.* calls, and
  DamagedStockTracking's api surface must stay exactly
  {getBsDayRecordByAdDate, getStockOperations, reverseStockOperation,
  createStockOperation} (BS-calendar gate / reversal lookup +
  mutation / disposal write-off — none loads rendered data) with its
  sole useEffect pinned to the mount-only BS check. Any future
  refactor of these tabs to server-paged self-fetch (the
  loadConsumableRegisterPage pattern) fails the suite and forces an
  explicit SSE-wiring decision. Suite now 619 tests, 0 fail.
- **Feature-screen coverage guard + register surface pins — DONE (2026-10-03,
  pushed `68d9234`):** the paged-tab source-guard now covers the whole client.
  (1) The remaining self-fetching registers are pinned in
  tests/registerRefreshDomains.test.ts: PurchaseOrders (`getPurchaseOrders`
  only — mutations are App callbacks), PurchaseInvoices (`getPurchaseInvoices`
  + the three payment-modal calls), SerialLogRegister (`getSerialLogs`,
  `lookupSerial`, both serial-edit mutations — NOTE its wiring prop is
  `refreshKey`, not `sseRefreshKey`), and StockOperations' full 12-method
  allowlist with its assignSerialLogCache fetch pinned as the ONE serial-log
  host fetch — mount-once (`[]` deps, `assignSerialLogLoaded` guarded),
  deliberately NOT sse-wired (bootstrap excludes serialLogs; refresh is by
  remount). Every App.tsx render site must pass its register counter (2 PO,
  2 PI, 1 SerialLogRegister, 11 StockOperations, 4 ReturnsRegister,
  2 SalesInvoices) — a newly added unwired mount fails.
  (2) NEW — all 50 screens under client/src/features are pinned: a
  SCREEN_SURFACE_PINS table (39 screens) + the 11 pinned above; an unpinned
  new screen fails coverage, and each pinned screen must match its exact
  surface. Surfaces use serverCallsIn = `api.*` methods + NAMED
  `services/api` imports, because the audit found FinancialStatements.tsx
  imports getFinancialSummary directly — a bare `api.*` scan misses that,
  so every earlier pin switched to the combined helper.
  (3) Tripwires: raw fetch/axios/EventSource banned in every screen;
  `pageSize:` request keys allowed ONLY in the six wired registers (a seventh
  server-paged fetch = a register missing its sseRefreshKey); the 11
  mount/selection self-fetch screens (ledgers, BS calendars, Category/Uom/
  Locations, doc numbering, FinancialStatements…) stay whole-list and
  unwired BY DESIGN (tab remount refetches them) and may not grow partial
  wiring without a full DOMAIN_REGISTER_KEYS decision. Audit footnote CLOSED:
  SalesInvoices.tsx + ReturnsRegister.tsx now fetch their own server-paged
  rows (getSalesInvoices / getPurchaseReturns + getSalesReturns) and are
  pinned as SSE-wired registers (surface + effect deps + every render site),
  no longer pinned `[]`. Proven by probe in both directions (injected named
  import / `pageSize:` / unpinned new screen / raw fetch → 4 precise
  failures, then reverted). Suite now 619 tests, 0 fail.
- **Docs-count guard — DONE (2026-10-03):** `npm test` now ends with a gate
  (scripts/run_tests.mjs → scripts/docsTestCounts.ts) that parses THIS run's
  real suite size from the runner's own summary line and fails if any
  CURRENT-STATE test-count claim in README/handoff/SESSION_NOTES disagrees.
  It caught two strays on day one (a `433` and a `535` left in older bullets
  after the previous refresh). Historical records ("449/449 tests pass",
  "522 node:test tests", "(3 tests)" per-file counts) are deliberately out of
  scope — only five explicit phrasings claim the current size, and the scope
  contract lives in the script header: add a pattern only if the sentence
  would be wrong after the next commit adds a test. Classification is
  unit-tested plus a live cross-doc consistency check in
  tests/docsCounts.guard.test.ts. Screen tallies quoted in these docs
  (total / table / pinned-elsewhere counts) are pinned the same way by a
  live check in tests/registerRefreshDomains.test.ts, so a screen added or
  reclassified without updating the prose fails too. Suite now 619 tests, 0 fail.

## Key files touched this arc (for context)

- `client/src/services/api/*` (new structure), `client/src/App.tsx` (SSE handler ~line 470,
  DOMAIN_STATE_KEYS map, syncScopeRef)
- `server/src/app.ts` (broadcastChange + resolveDomain import), `server/src/syncDomains.ts`
- `server/src/controllers/bootstrap.controller.ts` (get_bootstrapLocal), routes file
- `server/src/models/inventory.repo.ts` (batched SQL), `inventory.controller.ts` (reversals)
- `docs/mirror-audit.md` — READ THIS FIRST for retirement work (NOTE: its step-2 findings
  and vendorOpeningBalances/classification rows are now stale — update alongside step 3)
- `client/src/utils/depreciation.ts` + `tests/depreciation.test.ts` (B5)
- `client/src/utils/registerRefreshDomains.ts` + `tests/registerRefreshDomains.test.ts`
  (SSE domain → paged-register mapping, extracted for testability)
- `server/src/services/damage.service.ts` (B1/B2 helpers), `server/src/models/procurement.repo.ts` (B3)
