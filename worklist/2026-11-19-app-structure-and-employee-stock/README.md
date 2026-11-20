# App structure and employee stock custody (2026-11-19)

Status: `[ ]` in progress · Opened 2026-11-19 · Owner: main

Two workstreams that touch the same seams, done in small verified steps rather
than one refactor commit. The advisory round is closed
([Round 15](../2026-11-17-advisory-hardening/README.md)); its deferred items stay
there, and the field-capture remainder moved to
[Field capture](../2026-11-19-field-capture/README.md).

## A — Break up `client/src/App.tsx`

App.tsx is ~3,600 lines: 82 lazy declarations, bootstrap state, the SSE/polling
engine, URL/history sync, mutation wrappers and a ~600-line route table. The
order below is lowest-risk first; each step is its own commit with `tsc`, the
route tests and the bundle budget run after it, and a single full suite at the
end.

1. **`[x]` Lazy imports → `client/src/routes/lazyScreens.ts` (2026-11-19).**
   All 82 `React.lazy(...)` declarations moved out; App.tsx imports the names in
   one block. Paths were rewritten to `../features/…` and `../components/…`, the
   dynamic imports (and therefore the chunk split) are unchanged, and the file
   holds no app state so `tests/appRouteTree.test.ts` can still load the tree
   under `node:test`. Verified: `npx tsc --noEmit` 0, `tests/appPaths.test.ts`
   18/18, `tests/appRouteTree.test.ts` 12/12, `npm run build` 0,
   `check:bundle-budget` OK (entry 22.3/22.375 kB, startup 324.5/330 kB,
   84 dynamic chunks).
2. **`[x]` SSE + polling engine → `hooks/useSyncStream.ts` (2026-11-19).**
   `DOMAIN_STATE_KEYS`, the stream lifecycle, burst debouncing, gap polling and
   the cache invalidations moved into the hook, which returns
   `{ registerRefresh, bumpAll }`; App.tsx supplies the scope ref, the server
   version ref, `refreshAllData`, `fetchSlice` and the calendar/logout
   callbacks, and the root's own full refresh calls `bumpAll()`. The source pins
   in `tests/registerRefreshDomains.test.ts` now read the hook, so the wiring
   cannot drift. App.tsx 3,352 lines; verified `tsc` 0, route/SSE tests 75/75,
   build 0, budget OK (325.9/330 kB startup).
3. **`[x]` URL/history sync → `hooks/useAppRouting.ts` (2026-11-19).** Initial
   path resolution, `activeTab`/`recordRoute` state with their refs, the
   push/replace mode ref, `handleSelectTab`/`handleRecordRouteChange`, the
   `popstate` handler, the layout-effect address-bar write and the
   record-closes-on-tab-change effect moved out; App keeps the render plus the
   two redirects (permission guard, preference hydration) that set
   `urlHistoryModeRef` to `replace`. `tests/appPaths.test.ts` now pins the
   address-bar sync and the history write in the hook. App.tsx 3,182 lines.
   Verified `tsc` 0, route/SSE tests 75/75, build 0, budget OK (entry 23.1 /
   23.375 kB, startup 328.4 / 330 kB, 83 dynamic chunks); the entry gate was
   recalibrated with that measurement recorded in `scripts/check_bundle_budget.mjs`.
   Commit `8cfe5f5`.

   **Step 4 attempted and reverted (same day).** The split itself typechecked
   (`tsc` 0) with the table composed from `routes/screenRoutes/{common,
   inventory,salesProcurement,finance,people,settings}.tsx` over a shared props
   bundle, but eight source-level guards across six test files still assert the
   old inline shape (`const screenRoutes: AppRoute[] = [` in App.tsx, 109-entry
   scan, lazy-declaration scan, `screenRoute(` line counting, the
   `./screenPreload` storage-key import, posted-voucher/entry-form pins).
   Repointing each pin needs its own read-and-verify pass, so per the working
   rule the step was reverted rather than forced: `git checkout` of the touched
   files and deletion of the new route modules, leaving the tree clean at
   `8cfe5f5`. Blockers to clear first: 27 test files read App.tsx as the route
   table source, so step 4 needs a shared test helper that reads the shell plus
   the domain builders, and each of those guards re-run before anything else
   moves.

4. **`[x]` Route table → `routes/screenRoutes.tsx` (2026-11-20).** The 110-tab
   `screenRoutes` array left App.tsx and now lives in
   `client/src/routes/screenRoutes.tsx`, exported as
   `buildScreenRoutes(props: ScreenRouteProps): AppRoute[]`. App keeps the
   `routeProps` tuple of data and callbacks and calls the builder, so the
   elements are still built from the root's state — but the table itself, every
   `screenRoute(key, element)` entry in render order plus its `enabled` gate,
   is declared in the module. One module rather than the five domain builders
   the line above planned: the guards pin one table per tab, and a boundary per
   domain would have paid the same props plumbing five times.

   **Guards repointed, none loosened.** A new `tests/harness/screenRouteSource.ts`
   names the table module once; the test files that read App.tsx for the table
   now read it through that helper. Assertions about App's own wiring
   (`<AppRoutes … routes={screenRoutes} />`, App not handing a screen a users
   list, `api.getMyPermissions`) still read App.tsx, so each guard keeps its
   subject: the table guards check the same entries, elements, counters and
   props, the App guards check the root still composes and renders them.
   `appRouteRegistry` now proves both halves — the table is declared by its
   module and the root builds its routes through it. Nothing deleted, skipped
   or turned into a tautology.

   **Budget.** The extraction costs ~0.5 kB gz (91 values cross the new module
   boundary) and the startup ceiling is unchanged at 330 kB, so the same change
   moves `UsersManagement` into the lazy graph — the largest settings screen,
   opened from Settings, already sitting next to the lazily loaded
   `permission-management`, `user-permissions` and `api-keys` screens — with its
   `screenPreload` entry. Measured: entry 22.6 kB / 23.375, startup 316.0 kB /
   330 (89 startup chunks, 84 on-demand), 14 kB below the previous startup
   total. No ceiling raised.
5. **`[x]` Mutation wrappers → domain action hooks (2026-11-19).** 42
   wrappers moved out of App.tsx into five hooks plus their dependency type:
   `hooks/actionDeps.ts` (`ActionDeps`: `refreshAllData`, `currentUser`,
   `financialSummary`; `ProcurementActionDeps` adds `purchaseInvoices`),
   `hooks/useInventoryActions.ts` (8 — products, stock levels, reorder levels,
   assets), `hooks/useProcurementActions.ts` (18 — POs, purchase invoices, vendor
   payments, purchase returns, shipments, stock operations),
   `hooks/useSalesActions.ts` (6 — sales invoices, customer payments, sales
   returns), `hooks/useFiscalActions.ts` (7 — fiscal year open/close/reopen,
   opening stock, vendor roll-forward) and `hooks/useWorkflowActions.ts` (3 —
   approval create/process/cancel). Bodies are the identical `api.*` calls plus
   the same refresh; App.tsx destructures them where the handlers used to be and
   only supplies the deps object. Session and navigation wrappers (login,
   logout, profile switch/update, branch select, date mode, app settings, help
   navigation, low-stock PO grouping) stayed in App because they own state the
   shell must keep. `vite.config.ts` gives the six modules one
   `shared-domain-actions` chunk instead of six startup chunks. App.tsx 3,182 →
   2,873 lines (-309). Verified `tsc` 0, build 0, budget OK (entry 22.3 /
   23.375 kB, startup 329.3 / 330 kB, 92 startup chunks, 83 dynamic chunks).
   Full suite: 2,703 tests, 2,684 pass, 17 fail, 2 skipped — the same 17 fail on
   the pre-step-5 tree (verified by stashing this change), so the move added no
   failure; they are pre-existing drift from the field-work-orders migration
   (schema/docs counts, branch-scope registry, BS-date pairing, repo-layer
   scan) plus guards that were already stale before it. No test file was edited
   in this step, so no assertion was loosened.

   **Suite cleanup (2026-11-19).** `env -u PORT npm test` is green: 2,703 tests,
   2,701 pass, 0 fail, 2 Windows-only skips. What the pass fixed, at the root:

   - **Restored the effective-permission resolution.** The step-3 routing
     extraction had deleted `refreshEffectivePermissions`
     (`api.getMyPermissions()` → `applyEffectivePermissions`, the
     `inventory_permissions_updated` listener and `permissionsVersion` bump).
     Per-user permission exceptions had stopped being applied; the block is
     restored verbatim above the theme effect, and its guard is untouched.
   - **Field work orders, fully propagated.** Migration
     `0045_field_work_order_bs.sql` + `schema.sql` add
     `field_work_orders.scheduled_date_bs`; the repo insert pairs it via
     `resolveBsDateForLedgerSync`; `/field-work-orders` is now in
     `BRANCH_SCOPED_RESOURCES`; the schema/docs counts moved to 135 tables
     (schema.sql) and 125 top-level tables (README, four claims).
   - **Stale expectations updated to the real current values** (not loosened):
     route table 109 → 110 entries (two guards), permission matrix 69 → 70
     operations, the sidebar Sales group's Registers list now includes
     `field-work-orders`, and `screenPreload` gained its preloader.
   - **Guards repointed to the code's new owners**, assertions unchanged:
     `DOMAIN_STATE_KEYS`, the CPE/ASSETS invalidation and the `fixedAssets`
     counter now read `hooks/useSyncStream.ts`; lazy declarations are read from
     `routes/lazyScreens.ts` (screen preload + startup-graph classifier,
     normalising `../` specifiers); the saved-tab key is asserted against
     `utils/tabStorage.ts`, which `screenPreload` re-exports as the single
     source.

   The migration was applied to the local dev database (the schema-drift guard
   compares live columns against `schema.sql`). Gates: `tsc` 0, build 0, budget
   OK (entry 22.5 / 23.375 kB, startup 329.6 / 330 kB, 92 startup chunks, 83
   dynamic chunks, `shared-domain-actions` kept). Nothing in step 4 changed.

6. **`[x]` Bootstrap state → context.** `BootstrapDataContext` for products,
   stock, branches, suppliers, purchase orders, slice state and Postgres status,
   so screens stop taking 15 props each. This is last because it touches every
   screen and is the one with real regression surface.

   **Layout (2026-11-19).** `BootstrapDataProvider` and `useBootstrapData` live in
   `client/src/contexts/AppProviders.tsx` — the composition module the app and the
   route-tree harness already share, so the startup graph gains no new chunk. The
   provider owns the 22 bootstrap slices, the Postgres reachability status, the
   refused-bootstrap block and the per-slice status table, and its
   `apply(payload)` replaces exactly the keys a payload carried (a full payload
   still never resets a deferred slice). The root keeps the fetch, the slice gate,
   the caches, the SSE wiring, the fiscal-year and product-group hand-off to their
   own contexts, and every side effect that is not plain slice replacement
   (currency, permission matrix, settings, reachability only from a live
   response).

   **Sweep.** All 148 `slice={slice}` attributes left App's JSX and 70 route-table
   components (plus `AppShell`, `VoucherEntryScreen` behind the two voucher
   aliases, and `UsersManagement`) now read `useBootstrapData()` themselves; their
   interfaces no longer declare the slices. `AccountingScreenProps` lost `branches`
   the same way, so the accounting registers read it from the provider too.
   `BootstrapDataProvider` takes an optional `initial` seeding any of its slices,
   which is how the screen tests that used to pass those props now seed the
   provider instead.

   **Guards.** One guard pinned the old threading and was repointed to the new
   owner with its assertion kept: `tests/userPermissions.test.ts` now proves the
   users list reaches `UserPermissions` through `useBootstrapData()`, and that App
   no longer passes `users={users}`. The OPS-3 payload guard already reads the
   provider's `apply`. Nothing deleted, skipped or loosened.

   **Measured.** Entry 21.9 kB / 23.375, startup 330.0 kB / 330 — both inside the
   unchanged ceilings (the sweep itself removed 148 props, which is what paid for
   the provider's `apply` and the three seedable slices). Suite: 2,703 tests
   (2,701 pass, 2 skipped).

   **Not touched, deliberately:** step 4 landed separately (above) — the table
   lives in `routes/screenRoutes.tsx` and the guards read it there. Part B
   started after it: slice 1 (the custody ledger, API, My Stock panel and the
   profile's Equipment section) is recorded under Part B below, and App.tsx was
   not involved — the panel reads its own session state.

Guardrails: no behaviour change in steps 1–4; a new fetch must still be pinned in
`tests/registerRefreshDomains.test.ts`; screen/route counts in the docs move with
the route table (109→110 today, tracked by `docsCounts`).

## B — Per-employee stock custody (Fiber Team)

Today stock is tracked per branch and per serial, not per person. A technician's
van stock is invisible: issuing, consuming, returning and losing equipment on a
job is not a ledger, so offboarding cannot show what the employee still holds.

**Model (to build):**
- `employee_stock_holdings` — `(employee_id, product_id, branch_id, quantity)` with
  a non-negative check, one row per employee/product/branch.
- `employee_stock_movements` — append-only: `ISSUE`, `RETURN`, `CONSUME`,
  `TRANSFER`, `LOSS`, each with quantity, work-order link (optional), actor,
  timestamp and the branch it left/entered. The holding is a projection of the
  movements, rebuilt in the same transaction.
- Issue from branch stock reduces `inventory_stock` and raises the holding;
  consume against a work order writes the usage; return puts it back; loss needs
  an approved reason. Every movement is attributed to the employee, so the
  offboarding checklist can refuse to close while a holding is non-zero.
- API under `/api/employee-stock` gated on the existing inventory operations
  (`stock-out`, `consumable-issue-reverse`) plus a new `employee-stock-view`
  for the profile read; reads branch-scoped, writes audited.
- Screens: a **My Stock** panel for the technician, an **Employee Stock** section
  on the employee profile, and the offboarding checklist gaining a "return
  issued equipment" item that blocks completion while holdings remain.
- Tests: holding projection from movements, cannot go negative, branch/employee
  scope refusals, issue/consume/return round trip, loss refusal without a reason,
  offboarding blocked by a non-zero holding, and the profile read.

**Landed — slice 1, the custody ledger end to end (2026-11-20).** Model, API,
the My Stock panel and the profile's Equipment section are in production shape;
the offboarding item, transfers and loss approval remain (listed below).

- **Model.** `scripts/migrations/0046_employee_stock_custody.sql`, mirrored in
  `scripts/schema.sql` (135 tables now). `employee_stock_movements` is
  append-only — `ISSUE`/`RETURN`/`CONSUME`/`TRANSFER`/`LOSS`, `quantity > 0`, an
  optional work-order link, the actor and the branch, plus a CHECK that a `LOSS`
  carries a non-blank reason. `employee_stock_holdings` is the projection —
  `(employee_id, product_id, branch_id, quantity)`, `quantity >= 0`, one row per
  triple.
- **Repository.** `server/src/models/employeeStock.repo.ts`. Issue takes the
  units out of `inventory_stock` and raises the holding; return puts them back
  (creating the stock row when the branch never held any); consume and loss
  leave custody without returning stock. Every write runs in `withTransaction`,
  appends the movement, then **rebuilds the holding from the movement sum** in
  the same transaction — so the projection can never disagree with the log. A
  shortfall on either side is a refusal (`INSUFFICIENT_BRANCH_STOCK`,
  `INSUFFICIENT_HOLDING`), never a negative row, and a used-up holding drops out
  instead of lingering at zero.
- **API.** `GET /api/employee-stock` (+ `?employeeId=`, `?productId=`),
  `GET /api/employee-stock/movements`, and
  `POST /api/employee-stock/{issue,return,consume,loss}`. Reads are gated on the
  new `employee-stock-view`; writes reuse the inventory controls they already
  are — `stock-out` for issue and loss, `consumable-issue-reverse` for return and
  consume. A branch account is pinned to its own branch (a foreign employee is
  refused, not silently re-scoped); head office may name a branch and otherwise
  defaults to the employee's own. Every response is `private, no-store`.
- **Screens.** `client/src/features/inventory/EmployeeStockPanel.tsx`, mounted
  twice: **My Stock** on People & HR → My Profile and **Equipment held** in the
  employee profile dialog. It reads the signed-in role and its matrix itself
  (`loadUserSession` + `isOperationAllowed`), so neither mount needed a new prop
  through App, and no route/tab was added — App.tsx is untouched by Part B.
  The movement picker only offers actions the caller may perform; the server
  re-checks each one.
- **Guards.** `tests/employeeStock.api.test.ts` — 6/6 over a real Express app and
  real PostgreSQL: the issue/consume/return round trip with branch stock and
  holdings moving together, the projection equalling the signed movement sum,
  refusal (409) on both kinds of shortfall with no write, a loss refused without
  a reason and applied with one, employee/product/quantity validation, and
  permission + branch scope (a read grant cannot write; a branch account reads
  an empty list and cannot write another branch's employee). The permission
  matrix gained `employee-stock-view` (70 → 71 operations, seeded for
  Super Admin, inventory/branch managers, head office, field technicians and
  auditors; the Settings matrix UI lists it), and the schema/docs counts moved
  to 135 tables / 2,709 tests.
- **Measured and seen.** Entry 22.6 kB gz / 23.375, startup 316.2 kB / 330. On
  the dev server: signed in, issued 2 ONU routers to EMP-001 through the API,
  My Profile rendered “My stock — 1 item · 2 units”, the panel’s Return action
  took one back (notice + newest-first movement log), the profile dialog showed
  “Equipment held”, and the holdings list was empty after returning the rest
  while the movements stayed in the log.

**Still open in Part B:**
- **Offboarding block.** The checklist still has no “return issued equipment”
  item and completion does not consult the holdings. Needs a stock item/action
  in `hrLifecycle` (the completion path in one transaction with the ledger read)
  plus its guards; the ledger read is already a single query.
- **Transfer.** `TRANSFER` exists in the movement CHECK but has no endpoint or
  UI: moving custody between branches or people needs its own rule (which branch
  the row leaves and enters) that the note does not state.
- **Loss approval.** A loss records a mandatory reason on the movement. Whether
  it must pass the workflow-approval queue before it writes off, and who may
  approve it, is a policy decision the note does not make.
- **Serial-level custody.** The ledger is quantity-based, matching the note’s
  `(employee_id, product_id, branch_id, quantity)` model; a serial now lives on
  the branch stock row, not with a person.

**Why this order:** the field work order (done) is where a movement will attach,
and the App.tsx split makes the new screens cheap to add (one route file entry, no
App.tsx edits beyond the domain builder).

## Explicitly not in this note

Public-exposure work (TLS/proxy/MFA), replica/PgBouncer, pre-aggregated stock and
queued writes stay deferred in the Round 15 note with their owner decisions named.
