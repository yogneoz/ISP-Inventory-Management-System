# Architecture backlog — D (secrets), C (hydration), A (root component), B (JSONB items)

_2026-10-21 · baseline commit `0c44704` · **D1–D3, C1–C3, A1, A2, A6, A3 and A4a are implemented (2026-10-22 … 2026-10-25)**; C4, the rest of A4, A5 and B are not started._

This file is the single place for the four architecture notes, split into numbered slices so work can
be taken one item at a time without losing the rest. The two most recent commits
(`216356f`, `0c44704`) are the refused-exchange audit trail and the serial-focused Audit Trail screen —
a different thread, already shipped.

**None of these items is an upgrade.** No dependency, framework or database version changes in D, C, A
or B. D is a defect, C is accrued debt with a contained fix, A is a structural refactor, B is a
data-model bet that should be measured before it is made.

## How to work from this file

1. **One slice per commit**, and put the ID in the subject: `D1: fail production boot without AUTH_TOKEN_SECRET`.
2. Tick the slice's checkbox **and** its row in [Status](#status) in the same commit, so this file never lies.
3. Stop at every [stop point](#execution-order-and-stop-points) and update `SESSION_NOTES.md` +
   `handoff.md`; leave the next slice's ID written down there.
4. If a slice turns out bigger than its "Done when", split it into `X1a`, `X1b` — do not silently widen it.
5. Do not start a slice whose gate is unticked (`A3/A4` after `A6`, `B4` after `B1`+`B3`).

## Verdict

| Set | Kind | Verdict | Start |
|---|---|---|---|
| **D** | Defect + deployment constraint | Silent session invalidation on every restart; a second process could never verify tokens | **Now** |
| **C** | Accrued debt, half-fixed already | Slice failures are swallowed and slices are not scope-guarded | After D |
| **A** | Structural refactor | Root is 3,044 lines / 39 `useState` (was 3,194 / 49); every visited tab re-rendered on any root state change (closed by A1); A6 renders the real route tree, A3 moved session/scope state into contexts and A4a turned the tab tree into one typed table | Incremental, A4b after A5 |
| **B** | Data-model change | Seven `items JSONB` columns; today only two queries reach inside, but eight `items::text LIKE` scans will degrade linearly | Measure first; normalize only on demand |

## Status

```
[x] D1  prod fail-fast on missing AUTH_TOKEN_SECRET        (2026-10-21)
[x] D2  reject placeholder / short secrets in production   (2026-10-21)
[x] D3  document the single-instance constraint            (2026-10-22)
[x] C1  per-slice status (idle / loading / ready / error) (2026-10-22)
[x] C2  scope-guard and version-check deferred slices      (2026-10-22)
[x] C3  hydration tests                                     (2026-10-22)
[ ] C4  one hydration entry point                    (optional)
[x] A1  memoize kept-mounted screens                     (2026-10-23)
[x] A2  move shell-only UI state out of the data tree    (2026-10-23)
[x] A6  client test harness                          (2026-10-25)
[x] A3  session + scope contexts                     (2026-10-25)
[~] A4  AppRoutes + route registry   (A4a landed 2026-10-25; element factory still in App)
[ ] A3  session + scope contexts
[ ] A4  AppRoutes + route registry
[ ] A5  data store for operational arrays            (last)
[ ] B1  measure item-search cost
[ ] B2  index strategy for item search
[ ] B3  read-only item projection tables
[ ] B4  full JSONB normalization                     (product decision)
```

---

## D — Auth secret and single-instance reality

Baseline behaviour, verified: [auth.ts:7](../server/src/middleware/auth.ts#L7) fell back to
`crypto.randomBytes(32)` when `AUTH_TOKEN_SECRET` was unset and only logged a warning
([auth.ts:8](../server/src/middleware/auth.ts#L8)); production booted happily. PM2 runs a single fork
process ([ecosystem.config.js:8](../ecosystem.config.js#L8)) and restarts at 1 GB
([ecosystem.config.js:14](../ecosystem.config.js#L14)), so the impact was **every restart logging every
user out**, with the cross-instance failure latent until a second worker exists.

D1 and D2 now close that: the pure validator lives in
[authSecret.ts](../server/src/boot/authSecret.ts), is called from
[server/index.ts](../server/index.ts) before `startServer()`, and exits through the same
`failBoot` lifecycle path as any other boot failure. Development and test keep the ephemeral fallback
(and its warning) so a fresh clone still runs before any `.env` exists. D3 writes the remaining
single-process reality where a deployer meets it: the PM2 step in the README, repeated in
[handoff.md](../handoff.md) §14.2 and pinned by [singleInstance.guard.test.ts](../tests/singleInstance.guard.test.ts).

### D1 — Fail production boot without a secret

| | |
|---|---|
| **Why** | A deploy that silently discards all sessions is a support incident with no error trail. Fail at boot, where someone sees it. |
| **Where** | Pure validator (e.g. `server/src/boot/authSecret.ts`), called from [server/index.ts](../server/index.ts) before `listen`. Keep the import-time constant in `middleware/auth.ts` as-is. |
| **Change** | If `NODE_ENV === 'production'` and the secret is missing/blank: write an actionable message (what variable, how long, where to set it) and exit non-zero. Non-production keeps today's ephemeral fallback + warning. |
| **Done when** | A production boot with no secret exits non-zero **before** the port opens; with a real secret it boots; the suite (which runs under `NODE_ENV=test`) is untouched; a test in the style of [bootFailureExit.test.ts](../tests/bootFailureExit.test.ts) pins the exit status and the message. |
| **Rough effort / risk** | 1 h · low |
| **Done 2026-10-21** | `validateAuthSecret` + the boot call; [authSecretGuard.test.ts](../tests/authSecretGuard.test.ts) proves exit 1, the message, and that no PostgreSQL phase runs. `bootFailureExit.test.ts` now supplies a valid secret so it still tests the database failure it is about. |

### D2 — Reject placeholder and weak secrets

| | |
|---|---|
| **Why** | `.env.example` ships `AUTH_TOKEN_SECRET="replace-with-a-long-random-production-secret"`. D1 alone would accept it, and so would accept a 4-character secret. |
| **Where** | Same validator as D1. |
| **Change** | In production, refuse the example placeholder and anything shorter than 32 characters (HMAC-SHA256 key guidance); name the offending rule. |
| **Done when** | Placeholder and short values each fail a unit test with a specific message; a 32+ character random value passes; [envDocs.guard.test.ts](../tests/envDocs.guard.test.ts) still verifies `.env.example` documents the variable. |
| **Rough effort / risk** | 30 m · low |
| **Done 2026-10-21** | Placeholder list (case-insensitive) + a 32-character minimum; the too-short message names the length but never echoes the value. `.env.example`, README and handoff now say production refuses to boot without it. |

### D3 — Document the single-instance constraint

| | |
|---|---|
| **Why** | The PM2 comment says sessions, caches and SSE are process-local. That is the real blocker for `instances: 2`, and it is easy to forget when someone "fixes" scaling by bumping the number. |
| **Where** | `README.md` deployment section + `handoff.md`; link this file. |
| **Change** | State: one process; tokens need one shared secret; sessions/caches/SSE are per-process; what must move to shared infrastructure before cluster mode. |
| **Done when** | The constraint and its prerequisites are written where a deployer will look, and `ecosystem.config.js` points at that section. |
| **Rough effort / risk** | 30 m · none |
| **Done 2026-10-22** | README → *Single process only (do not raise `instances`)*: a table of the three process-local concerns (operational caches in `runtimeState.ts`, SSE fan-out in `realtime/sse.ts`, the rate-limit buckets in `authRateLimit.ts`/`sseRateLimit.ts`) with what a second worker breaks, the one `AUTH_TOKEN_SECRET` all workers must share, and the four prerequisites for cluster mode. `ecosystem.config.js` names that section in its `instances: 1` comment; handoff §14.2 repeats it. [singleInstance.guard.test.ts](../tests/singleInstance.guard.test.ts) fails if the config stops being one fork-mode worker, if the README section loses a concern or a prerequisite, or if the pointer breaks. |

---

## C — Bootstrap hydration

Deferred slices are declared at [App.tsx:631](../client/src/App.tsx#L631) and their failures are
swallowed at [App.tsx:640](../client/src/App.tsx#L640) and [App.tsx:980](../client/src/App.tsx#L980).
The full bootstrap already has a sequence guard ([App.tsx:691](../client/src/App.tsx#L691)) plus a
`dataVersion` and 250 ms SSE burst coalescing; the deferred fetches have neither. This is why C is a
contained fix, not a rewrite.

### C1 — Per-slice status

| | |
|---|---|
| **Why** | `.catch(() => null)` makes "still loading", "failed" and "genuinely empty" render identically — a ledger can look empty because one request failed. |
| **Where** | A slice state module (e.g. `client/src/services/bootstrapSlices.ts`) + App's `applyBootstrapData` for full payloads. |
| **Change** | Per key: `{ status: 'idle' \| 'loading' \| 'ready' \| 'error', dataVersion?, error? }`. A failed slice keeps the last good data, marks the key `error`, and surfaces a non-blocking, dismissible notice (reuse the existing banner/toast conventions). |
| **Done when** | A failed slice leaves previous rows visible and shows one notice (not a toast storm); a successful retry clears the error; the three deferred keys and SSE-targeted refreshes share the same state. |
| **Rough effort / risk** | 1 day · low–medium |
| **Done 2026-10-22** | [bootstrapSlices.ts](../client/src/services/bootstrapSlices.ts) is the pure reducer: per-key `idle / loading / ready / error`, the `dataVersion` that produced the rows on screen (kept across failures), the error, and a per-error dismissal. App never applies a failed payload, so the previous rows stay; a full bootstrap marks ready only the keys its payload **carried** (the deferred ledgers are not in it) and a cached snapshot marks nothing. One `fetchBootstrapSlice` serves both the deferred ledgers and the SSE targeted refresh, and [BootstrapSliceNotice.tsx](../client/src/components/common/BootstrapSliceNotice.tsx) renders the aggregated failures as ONE dismissible banner with one Retry (still visible, spinning, while the retry is in flight). Repeating the same error does not un-dismiss the notice; a different reason re-surfaces it. Tests: [bootstrapSlices.test.ts](../tests/bootstrapSlices.test.ts) (10) — transitions, last-good version retention, payload-only readiness, dismissal/re-appearance, immutability, labels, and the wiring of both paths through the shared loader. Scope guards and version monotonicity stay in C2; broader hydration coverage in C3. |

### C2 — Scope-guard and version-check slices

| | |
|---|---|
| **Why** | A slice requested for the old branch/FY can land after the user switches, painting the new view with old rows. |
| **Where** | Same module as C1; call sites in App's `hydrateDeferredSlices` and the SSE targeted path. |
| **Change** | Stamp each request with `branchId|fiscalYearId|seq`; discard a response whose stamp no longer matches. Apply `res.dataVersion` only if it is not older than the last applied version. |
| **Done when** | A unit test proves a stale response is discarded and a newer one applies; switching branch mid-flight never shows the previous branch's rows. |
| **Rough effort / risk** | 4 h · low–medium |
| **Done 2026-10-22** | `SliceRequestGate` in [bootstrapSlices.ts](../client/src/services/bootstrapSlices.ts) stamps every request `key + scope(branch\|FY) + seq`. Before a payload paints, `decide()` returns `apply`, `superseded` (a newer request for that key owns its status), `stale-scope` (the user left that branch/FY) or `older-version` (arrived after newer rows for the same key). Applied versions are per key — a full bootstrap records its version for every key it carried, so a slower targeted request that started before it cannot overwrite newer rows. Discarded requests settle their `loading` flag (`settleSliceDiscarded`) instead of spinning forever or raising the notice; `superseded` leaves the key to its newer sibling. Tests: [bootstrapSlices.test.ts](../tests/bootstrapSlices.test.ts) — 8 gate cases (current view, stale scope with a newer version, supersession, older/equal versions, per-key isolation, bootstrap-version blocking, scope-key mapping, status settlement) plus a wiring pin that the decision runs before `applyBootstrapData` and that the bootstrap records applied versions. Live check: a delayed ALL-branch `stock` response arriving after a switch to BRH01 left the BRH01 rows (15) on screen, not the ALL rows (16). |

### C3 — Hydration tests

| | |
|---|---|
| **Why** | Today's guards are source-text assertions ([bootstrapTrim.test.ts:80](../tests/bootstrapTrim.test.ts#L80)); behaviour is unprotected. |
| **Where** | `tests/` (node:test), driving the slice module as a pure reducer. |
| **Done when** | Status transitions, stale-response discard and version monotonicity are covered by unit tests; the existing source guards still pass. |
| **Rough effort / risk** | 4 h · low |
| **Done 2026-10-22** | [hydrationFlow.test.ts](../tests/hydrationFlow.test.ts) (8 scenarios) drives the C1 reducer and the C2 gate together, in App's order, with responses resolved out of order: a bootstrap followed by a slower older slice payload; a branch switch where the old response arrives both before and after the new view's request; two bursts for one key (superseded); failure → one notice → dismissal → same failure quiet → success clears; a failure from an abandoned view never becoming a notice; per-key version monotonicity including equal versions; a deferred ledger error surviving a full bootstrap that does not carry it; and the discarded-request status settlement (idle / ready / error). The harness mirrors `fetchBootstrapSlice` rather than calling it, so App's ordering stays pinned by the wiring assertions in [bootstrapSlices.test.ts](../tests/bootstrapSlices.test.ts); the module needs no DOM, timers or server. Existing source guards (`bootstrapTrim.test.ts`, `registerRefreshDomains.test.ts`) still pass. |

### C4 — One hydration entry point (optional)

| | |
|---|---|
| **Why** | Full bootstrap and slices have parallel code paths that can drift (this is the note's real complaint). |
| **Change** | Both go through the C1 module; App only calls `hydrate(scope)` and `refresh(domains)`. |
| **Done when** | No call site fetches `/api/bootstrap/local` by hand; the source guard is updated to the new shape. |
| **Rough effort / risk** | 2 days · medium · **only after C1–C3 are green** |

---

## A — The monolithic root

Verified at baseline: [App.tsx](../client/src/App.tsx) is **3,194 lines** (3,294 after C3), with
**49 `useState`** and **18 `useEffect`**; the context in use is DarkMode (plus the keep-mounted
tab contexts). At baseline [KeepMounted.tsx](../client/src/components/common/KeepMounted.tsx) kept
every visited tab mounted without memoizing its children, so **any root state change re-rendered
every screen already opened** — closed by A1 below. A1 added the jsdom + `react-dom` render measurement it needed; A6 (2026-10-25)
turned that into a route-tree smoke test that mounts the real `App` with the `api` object stubbed, so
the KeepMounted contract is now behavioural. Screen-level behaviour with no rendered harness (API
fetch paths, multi-screen wiring) is still pinned at source where a pure function cannot express it.

### A1 — Memoize kept-mounted screens

| | |
|---|---|
| **Why** | Cheapest visible win: stop re-rendering hidden/visited tabs on unrelated root state changes. |
| **Change** | Stabilise the tab elements (memoised screen component or a memoised element map keyed on the props each screen consumes). Measure before/after with React DevTools highlight. |
| **Done when** | Typing in the global search box re-renders the shell only; tab switching and `useActivationKey` behaviour are unchanged. |
| **Rough effort / risk** | 1 day · low · **warning:** memoising screens with unstable array props buys nothing — check prop identity first |
| **Done 2026-10-23** | Done at the container boundary, so App.tsx did not change: [screenElementMemo.ts](../client/src/utils/screenElementMemo.ts) caches one element per tab slot in `KeepMounted` and returns the identical object while the screen's type and shallow-equal props are unchanged, which makes React skip the subtree. Prop identity was checked first: every tab prop is a `useState` value or a handler, and handlers (new identity each render) are replaced by stable proxies that forward to the newest closure — a naive `React.memo` would have bought nothing. Suspense-wrapped lazy tabs memoise the inner screen. **Measured** with jsdom + `react-dom` ([harness](../tests/harness/keepMountedProbe.tsx)): the same probe tree through the pre-A1 container and the new one, 10 keystrokes with four tabs mounted = **40 screen renders before, 10 after**; tab-switch counts identical in both modes; `useActivationKey` still ticks on re-activation. Tests: [screenElementMemo.test.ts](../tests/screenElementMemo.test.ts) (14) + [keepMountedRenderCount.test.ts](../tests/keepMountedRenderCount.test.ts) (9). |

### A2 — Move shell-only UI state out of the data tree

| | |
|---|---|
| **Why** | Global search, modals, sidebar, notifications and dismissed IDs live in the root; every keystroke there touches the whole tree. |
| **Change** | Move shell state into a `AppShell`/`useAppShellState` that sits beside — not above — the tab tree. |
| **Done when** | Shell state changes do not re-render tab screens; keyboard shortcuts and modal behaviour are unchanged. |
| **Rough effort / risk** | 1 day · low |
| **Done 2026-10-23** | [AppShell.tsx](../client/src/components/layout/AppShell.tsx) owns the sidebar, barcode, search, notification and profile-modal flags plus the dismissed-notification ids; [App.tsx](../client/src/App.tsx) hands it the data props, the bootstrap `banners` and the workspace `<main>` as **elements**, so a shell state change re-renders the shell only — React receives the same `children` object and skips the tab tree (where A1 then skips the screens). The badge derivations that read the dismissed ids moved with them. Screens that opened an overlay (Help Documentation's barcode action) ask the shell through [ShellOverlayContext.tsx](../client/src/contexts/ShellOverlayContext.tsx), whose value is memoised on stable setters, instead of receiving a setter as a prop. Keyboard shortcuts moved with the overlays they open. **Measured** with jsdom + `react-dom` ([appShellProbe.tsx](../tests/harness/appShellProbe.tsx)) around the real shell: sidebar toggle, search overlay, notification panel and Alt+B/Alt+H/Ctrl+K leave the workspace at **1 render** (mount) while the DOM reacts; a data change still reaches it (2 renders). Tests: [appShellRenderCount.test.ts](../tests/appShellRenderCount.test.ts) (4). |

### A6 — Client test harness (gate for A3/A4)

| | |
|---|---|
| **Why** | Refactoring a 3,194-line root with only source-text guards is how behaviour gets lost. |
| **Change** | Add vitest + jsdom + @testing-library/react, a mocked `api` module, and one smoke test that renders the route tree and proves tab state survives a switch (the KeepMounted contract). A1 already added the jsdom + `react-dom` render harness ([tests/harness](../tests/harness/mount.tsx)) and a KeepMounted probe; A6 turns that into a route-tree smoke test with a mocked `api` and adds the remaining tooling. |
| **Done when** | `npm test` (or a documented `npm run test:ui`) runs the smoke test in CI; it fails if a screen remounts on tab switch. |
| **Rough effort / risk** | 1 day · low · **must land before A3/A4** |
| **Done 2026-10-25** | [appRouteTreeProbe.tsx](../tests/harness/appRouteTreeProbe.tsx) mounts the real `App` in the `main.tsx` providers under jsdom, seeds a SUPER_ADMIN session and replaces the `api` singleton's mount-time methods with fixtures (no network, no module mocking; a fake `EventSource` covers SSE). [appRouteTree.test.ts](../tests/appRouteTree.test.ts) navigates through `NAVIGATE_TAB_EVENT`, types a draft into Assign Fixed Asset, switches to the Dashboard and back, and asserts the same DOM node with the same value — a remount replaces the node and fails. It runs inside `npm test`'s existing glob, so CI exercises it with no new script. Two node-test-safety fixes came with it: `App.tsx` reads `import.meta.env?.DEV` (the guard Sidebar already used) and [dom.ts](../tests/harness/dom.ts) exposes jsdom's `localStorage`/`sessionStorage` globals. |

### A3 — Session and scope contexts

| | |
|---|---|
| **Change** | `SessionContext` (user, root user, permission matrix, app settings, date mode) and `ScopeContext` (branch, fiscal year, fiscal-year list). Screens keep their props for now; the root stops threading these through callbacks. |
| **Done when** | Both contexts exist and are the only source for those values; no screen reads them from props *and* context; A6 smoke test green. |
| **Rough effort / risk** | 3 days · medium |
| **Done 2026-10-25** | [SessionContext.tsx](../client/src/contexts/SessionContext.tsx) owns the user, root user, RBAC matrix, app settings and date mode; [ScopeContext.tsx](../client/src/contexts/ScopeContext.tsx) owns the branch, fiscal year and fiscal-year list. [App.tsx](../client/src/App.tsx) reads them through `useSession()`/`useScope()` and keeps no state for any of the nine values. [AppProviders.tsx](../client/src/contexts/AppProviders.tsx) is the single provider composition, shared by [main.tsx](../client/src/main.tsx) and the A6 harness so the test cannot miss a provider the browser has. Screens keep their props; [sessionScopeContexts.test.ts](../tests/sessionScopeContexts.test.ts) (5 tests) pins ownership, the shared composition, the no-context-in-features rule and a mounted read/update round trip. A6's route-tree test still passes. |

### A4 — `AppRoutes.tsx` + route registry

| | |
|---|---|
| **Change** | A typed registry (`key`, lazy element, permission) rendered by `AppRoutes` inside `KeepMountedRoot`; the root stops containing the tab markup. |
| **Done when** | Permission-gated tabs, `visible` flags, lazy loading and keep-mounted semantics are identical; the route table is the only place a tab is declared. |
| **Rough effort / risk** | 3 days · medium |
| **A4a 2026-10-25** | [appRoutes.tsx](../client/src/routes/appRoutes.tsx) defines `AppRoute`, `screenRoute` and the `AppRoutes` renderer; [tabPermissions.ts](../client/src/routes/tabPermissions.ts) is now the one RBAC/admin table and `isTabAccessible`. App declares a 67-entry `screenRoutes` table and renders `<AppRoutes>`; its inline `KeepMounted` blocks and local permission tables are gone. Pinned by [appRouteRegistry.test.ts](../tests/appRouteRegistry.test.ts) (5 tests) and still covered by the A6 route-tree test. **Remaining for A4:** the element construction is still in App (a table entry needs its props/handlers), because a typed deps contract for ~100 values is A5's store work; extract it when that contract exists, then tick this slice. |

### A5 — Data store for operational arrays (last)

| | |
|---|---|
| **Why** | The 20+ data arrays are what is left of the root's bulk; a store is only worth it once the shell and routes are out. |
| **Change** | Zustand/Jotai (or a `useBootstrapData` hook) owns the arrays; screens subscribe to the slices they use. |
| **Done when** | The root holds no operational arrays; selective subscription is demonstrated by a re-render test. |
| **Rough effort / risk** | 1 week · high · **do not start before A3/A4/A6** |

---

## B — JSONB line items

Seven tables carry `items JSONB` in [schema.sql](../scripts/schema.sql): purchase orders, purchase
invoices, shipments, stock operations, sales invoices, purchase returns, sales returns. Documents are
read whole, and only two queries reach inside items
([procurement.repo.ts:713](../server/src/models/procurement.repo.ts#L713),
[sales.repo.ts:422](../server/src/models/sales.repo.ts#L422)) for returns reconciliation. The real cost
today is search: eight `LOWER(items::text) LIKE` scans across
[procurement.repo.ts](../server/src/models/procurement.repo.ts) (3),
[serials.service.ts](../server/src/services/serials.service.ts) (3),
[inventory.repo.ts](../server/src/models/inventory.repo.ts) (1) and
[sales.repo.ts](../server/src/models/sales.repo.ts) (1).

### B1 — Measure before changing anything

| | |
|---|---|
| **Why** | No baseline exists, so "JSONB is slow" is currently an opinion. |
| **Change** | `EXPLAIN (ANALYZE, BUFFERS)` each of the eight scans on a scratch database at 1× and ~10× current row counts; record p50/p95 and plan shape here. |
| **Done when** | Numbers and query plans are recorded in this file, and B2/B3/B4 have a stated threshold that would trigger them. |
| **Rough effort / risk** | Half a day · none |

### B2 — Index strategy for item search

| | |
|---|---|
| **Why** | These are substring searches over serialised JSON; the right index depends on B1. |
| **Options** | (a) `pg_trgm` GIN on `items::text` — closest drop-in for the current `LIKE '%q%'`; needs the extension. (b) Generated `tsvector` + GIN — no extension, but token semantics change (won't match arbitrary serial fragments). (c) Narrow the search to documented fields (SKU, product name, serial) via a projection. |
| **Done when** | One option is chosen with the B1 numbers behind it, the index ships in `schema.sql` (single DDL source), the parity test passes, and the eight scans use the chosen path. |
| **Rough effort / risk** | 1 day · low |

### B3 — Read-only item projection tables

| | |
|---|---|
| **Why** | Item-level reporting and auditing without rewriting the document model. |
| **Change** | Add e.g. `purchase_invoice_items` / `sales_invoice_items`, populated in the same transaction as the document write, backfilled by a script; JSONB stays the document of record and export format. |
| **Done when** | Reconciliation (counts and sums per document) proves projection == JSONB for every row; at least one report reads the projection; backfill is idempotent. |
| **Rough effort / risk** | 1 week · medium |

### B4 — Full normalization (only on a product decision)

| | |
|---|---|
| **Why** | Child tables as the source of truth only pay off when item-level joins/writes are a requirement, not a preference. |
| **Phases** | child tables → dual-write → backfill → switch reads → switch writes → keep JSONB read-only. Each phase is its own commit/slice; never skip the parity step. |
| **Done when** | Child tables are authoritative, a parity test compares them to the JSONB projection, and no screen reads items from JSONB for reporting. |
| **Rough effort / risk** | Weeks · high · **parked unless B1/B3 demand it** |

Keep `serial_log.history_json` as JSONB regardless: it is an append-only log, which is what JSONB is
for.

---

## Execution order and stop points

```
D1 → D2 → D3            stop: notes + this checklist
C1 → C2 → C3            stop: notes + this checklist
A1 (done) → A2 (done) → A6 stop: notes + this checklist
A3 → A4                 stop: notes + this checklist
B1 → B2                 stop: notes + this checklist
B3 (only if B1 says so) stop: notes + this checklist
A5 / B4                 only on a deliberate, recorded decision
```

At each stop point: `npx tsc --noEmit`, `npm test`, docs-count gate green, tick the boxes here, and
write the next slice ID into `SESSION_NOTES.md` so the next session does not have to rediscover it.

## Open decisions

| # | Decision | Needed before |
|---|---|---|
| 1 | D: fail-fast only, or also support a generated-and-persisted secret file? (recommendation: fail-fast; a file is a second place to lose) | D1 |
| 2 | C: should a failed slice be operator-visible, or only logged? (recommendation: one dismissible notice, never a toast per slice) | C1 |
| 3 | A: is root re-render cost user-visible yet? If not, A1/A2 are enough for now | A3 |
| 4 | B: does any report need item-level joins, or only search? (search → B2; joins → B3) | B3/B4 |

## Explicitly not doing

- **No big-bang App.tsx extraction.** Screens come out one at a time, behind A6.
- **No wholesale JSONB normalization.** JSONB stays the document of record until B1/B3 justify more.
- **No PM2 cluster mode** until sessions, caches and SSE are shared (see D3).
- **No global state library** before A6; motion is not a reason to add one.
- **No dropping `items` or `history_json`** even after B4; they remain the export/audit format.
