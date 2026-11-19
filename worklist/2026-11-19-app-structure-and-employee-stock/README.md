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
2. **`[ ]` SSE + polling engine → `hooks/useSyncStream.ts`.** Move
   `DOMAIN_STATE_KEYS`, the SSE lifecycle, burst debouncing and the 30 s
   fallback poll; return `{ registerRefresh }`.
3. **`[ ]` URL/history sync → `hooks/useAppRouting.ts`.** `resolveInitialTab`,
   `popstate`, `urlHistoryModeRef`, `NAVIGATE_TAB_EVENT` and the permission
   redirect, returning `{ activeTab, recordRoute, handleSelectTab,
   handleRecordRouteChange }`.
4. **`[ ]` Route table by domain → `routes/routes/*.tsx`.** Split the
   `screenRoutes` array into inventory, sales/procurement, finance, people and
   settings builders over a shared props bundle; App.tsx only spreads them.
5. **`[ ]` Mutation wrappers → domain action hooks.** `useInventoryActions`,
   `useProcurementActions`, `useFiscalActions` over `refreshAllData`, or screens
   call the api directly and trigger the context refresh.
6. **`[ ]` Bootstrap state → context.** `BootstrapDataContext` for products,
   stock, branches, suppliers, purchase orders, slice state and Postgres status,
   so screens stop taking 15 props each. This is last because it touches every
   screen and is the one with real regression surface.

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

**Why this order:** the field work order (done) is where a movement will attach,
and the App.tsx split makes the new screens cheap to add (one route file entry, no
App.tsx edits beyond the domain builder).

## Explicitly not in this note

Public-exposure work (TLS/proxy/MFA), replica/PgBouncer, pre-aggregated stock and
queued writes stay deferred in the Round 15 note with their owner decisions named.
