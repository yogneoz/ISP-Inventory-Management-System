# Architecture backlog — D (secrets), C (hydration), A (root component), B (JSONB items)

_2026-10-21 · baseline commit `0c44704` · **D1–D4, C1–C3, A1, A2, A6, A3, A4a, B1 and B2 are decided/implemented (2026-10-22 … 2026-10-25)**; C4 was parked on 2026-10-25 (its acceptance already holds — one `bootstrap/local` call site); A4b (the route element factory) and A5 are not started. B1 measured the item-search cost; B2 shipped the combined trigram projection, and B3/B4 stay parked. **D4 (2026-10-25) deferred A5**: measured root cost is not user-visible (see the A5 table), so A4b stays blocked until a real-browser profile or a maintainability decision reopens it._

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
5. Do not start a slice whose gate is unticked (`A4b` after `A5`, `B4` after `B1`+`B3`).

## Verdict

| Set | Kind | Verdict | Start |
|---|---|---|---|
| **D** | Defect + deployment constraint | Silent session invalidation on every restart; a second process could never verify tokens | **Now** |
| **C** | Accrued debt, half-fixed already | Slice failures are swallowed and slices are not scope-guarded | After D |
| **A** | Structural refactor | Root is 3,044 lines / 39 `useState` (was 3,194 / 49); every visited tab re-rendered on any root state change (closed by A1); A6 renders the real route tree, A3 moved session/scope state into contexts and A4a turned the tab tree into one typed table | Incremental, A4b after A5 |
| **B** | Data-model change | Seven `items JSONB` columns; B1 measured eight `items::text LIKE` scans at 4k–120k rows. They grew with row count, four exceeded 1 s at 10×, and an item-only trigram index could not serve the ORed header predicates. B2 replaced all eight with one generated `search_text` projection per searched table plus a trigram GIN | B2 shipped; B3/B4 parked |

## Status

```
[x] D1  prod fail-fast on missing AUTH_TOKEN_SECRET        (2026-10-21)
[x] D2  reject placeholder / short secrets in production   (2026-10-21)
[x] D3  document the single-instance constraint            (2026-10-22)
[x] C1  per-slice status (idle / loading / ready / error) (2026-10-22)
[x] C2  scope-guard and version-check deferred slices      (2026-10-22)
[x] C3  hydration tests                                     (2026-10-22)
[—] C4  one hydration entry point       (parked 2026-10-25 — one call site)
[x] A1  memoize kept-mounted screens                     (2026-10-23)
[x] A2  move shell-only UI state out of the data tree    (2026-10-23)
[x] A6  client test harness                          (2026-10-25)
[x] A3  session + scope contexts                     (2026-10-25)
[~] A4  AppRoutes + route registry   (A4a landed 2026-10-25; A4b element factory not started, waits for A5)
[ ] A5  data store for operational arrays            (deferred by D4, 2026-10-25 — not started)
[x] B1  measure item-search cost                            (2026-10-25)
[x] B2  combined trigram search projection                  (2026-10-25)
[ ] B3  read-only item projection tables             (parked — see B1)
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

### C4 — One hydration entry point (optional) — PARKED 2026-10-25

| | |
|---|---|
| **Why** | Full bootstrap and slices have parallel code paths that can drift (this is the note's real complaint). |
| **Change** | Both go through the C1 module; App only calls `hydrate(scope)` and `refresh(domains)`. |
| **Done when** | No call site fetches `/api/bootstrap/local` by hand; the source guard is updated to the new shape. |
| **Rough effort / risk** | 2 days · medium · **only after C1–C3 are green** |
| **Parked 2026-10-25** | Assessed against the code: the URL is built in exactly one place ([bootstrap.ts](../client/src/services/api/bootstrap.ts#L28)), App has one full-bootstrap path plus one slice path through it, and the C1 reducer/gate (`bootstrapSlices.ts`) already owns status. The “two paths that can drift” no longer exist; the remaining proposal is a literal `hydrate()`/`refresh()` rename in a 3,100-line root — no behaviour, real regression risk. Reopen only if a second caller appears or a screen bypasses the slice gate; both are currently caught by `registerRefreshDomains.test.ts` and `bootstrapTrim.test.ts`. |

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
| **A4a 2026-10-25** | [appRoutes.tsx](../client/src/routes/appRoutes.tsx) defines `AppRoute`, `screenRoute` and the `AppRoutes` renderer; [tabPermissions.ts](../client/src/routes/tabPermissions.ts) is now the one RBAC/admin table and `isTabAccessible`. App declares a 67-entry `screenRoutes` table and renders `<AppRoutes>`; its inline `KeepMounted` blocks and local permission tables are gone. Pinned by [appRouteRegistry.test.ts](../tests/appRouteRegistry.test.ts) (5 tests) and still covered by the A6 route-tree test. **A4b (not started) — remaining for A4:** the element construction is still in App (a table entry needs its props/handlers), because a typed deps contract for ~100 values is A5's store work. A4b waits for A5; do not start it before A5 exists. A5 itself has not started. |

### A5 — Data store for operational arrays (last)

| | |
|---|---|
| **Why** | The 23 operational arrays are what is left of the root's bulk (35 `useState`, 67 routes); a store is only worth it once the shell and routes are out. |
| **Change** | Zustand/Jotai (or a `useBootstrapData` hook) owns the arrays; screens subscribe to the slices they use. |
| **Done when** | The root holds no operational arrays; selective subscription is demonstrated by a re-render test. |
| **Rough effort / risk** | 1 week · high · **do not start before A3/A4/A6** |
| **D4 — 2026-10-25** | **Deferred (no-go for now).** A1 memoisation already reuses the element object for unchanged screens and the SSE path replaces only the affected slices, so unrelated mounted screens do not re-render. Measured with the A6 harness and a Profiler (4 tabs mounted, 120 stock rows): targeted STOCK update ~298 ms total / 129 ms max, full refresh ~381 ms total in jsdom — dominated by the list screens that genuinely consume the data, which any store would also re-render. The root’s own per-render work (67 elements, 11 props each, memo compare) is **2.1 ms** in a Node micro-benchmark, and the route table has **zero** derived-per-render props. The route table does thread 756 prop passings (144 distinct, 236 handlers) — real maintainability debt, but not measured jank. **Revisit when** a real-browser profile shows root commits above the 16 ms frame budget, or A4b’s typed deps contract becomes the priority. A4b stays blocked meanwhile. **Browser confirmation (2026-10-25):** on the production build, with 6 tabs mounted, a real stock-row update drove only the four targeted STOCK slice fetches (no full bootstrap), produced zero long tasks and left the frame cadence unchanged. |
| **VOL-2 — 2026-10-26** | **The second payload win, not the store.** The fiscal year's `salesInvoices` array left the bootstrap after the Returns form moved to a server-side invoice picker and the Sales register dropped its full-array fallback. The removed array costs **0.36 MB gzip at the modelled 1× (12k invoices/year)** and **3.57 MB at 10× (120k/year)**. A5 is still about ownership/selective subscription and stays deferred on the D4 trigger; this was a read-path removal only. |
| **VOL-1 — 2026-10-26** | **The volume work, not the store.** `transactionLogs` left the bootstrap and its three consumers read `GET /api/transaction-logs` directly; the removed array costs 4.2 MB gzip at the modelled 1× and 42 MB at 10×. A5 is about ownership/selective subscription, not payload, and remains deferred on the D4 trigger. The ledger still merges its bounded window client-side until `stock_operations` itself leaves the bootstrap — that is a read-path item, not a reason to start A5. |

---

## B — JSONB line items

Seven tables carry `items JSONB` in [schema.sql](../scripts/schema.sql): purchase orders, purchase
invoices, shipments, stock operations, sales invoices, purchase returns, sales returns. Documents are
read whole, and only two queries reach inside items
([procurement.repo.ts:713](../server/src/models/procurement.repo.ts#L713),
[sales.repo.ts:422](../server/src/models/sales.repo.ts#L422)) for returns reconciliation. B1 measured
the cost as search: eight `items::text` substring scans (five register `LOWER…LIKE` predicates and
three serial-rename `ILIKE` pre-selects) across
[procurement.repo.ts](../server/src/models/procurement.repo.ts) (3),
[serials.service.ts](../server/src/services/serials.service.ts) (3),
[inventory.repo.ts](../server/src/models/inventory.repo.ts) (1) and
[sales.repo.ts](../server/src/models/sales.repo.ts) (1). B2 replaced all eight with one generated
`search_text` projection per searched table (§B2); no query scans `items::text` any more.

### B1 — Measure before changing anything

| | |
|---|---|
| **Why** | No baseline exists, so "JSONB is slow" is currently an opinion. |
| **Change** | `EXPLAIN (ANALYZE, BUFFERS)` each of the eight scans on a scratch database at 1× and ~10× current row counts; record p50/p95 and plan shape here. |
| **Done when** | Numbers and query plans are recorded in this file, and B2/B3/B4 have a stated threshold that would trigger them. |
| **Done 2026-10-25** | Measured on a scratch database: four scans exceed **1 s** at 10×, the 1× stock-operation search already takes **~0.30 s**, and all eight scale with row count. **B2 was a GO** on a combined trigram expression (not `items::text` alone) and shipped later the same day; **B3/B4 are parked**. Details below. |
| **Rough effort / risk** | Half a day · none |

#### Dataset and method (2026-10-25)

The live development database is too small to time: 1 purchase order, 3 purchase invoices,
0 shipments, 8 stock operations, 2 sales invoices and 1 row in each return register. The
baseline below is therefore a **modelled first operating year** for the intended 12k-customer
ISP, not production data. It was seeded into scratch database `inventory_bench_b1` after
applying [scripts/schema.sql](../scripts/schema.sql) unchanged as the application role on
**PostgreSQL 18.6 (Windows)**; each row carries a realistic four-object `items` array with
product id/name/SKU, quantity, unit cost, device serial, PON and MAC.

| Table | 1× rows | 10× rows |
|---|---:|---:|
| `purchase_orders` | 4,000 | 40,000 |
| `purchase_invoices` | 4,000 | 40,000 |
| `shipments` | 6,000 | 60,000 |
| `stock_operations` | 12,000 | 120,000 |
| `sales_invoices` | 12,000 | 120,000 |
| `purchase_returns` | 600 | 6,000 |
| `sales_returns` | 900 | 9,000 |

The 10× state is nine `INSERT … SELECT` copies per table with fresh ids/document numbers and
rewritten serial/PON/MAC prefixes, followed by `ANALYZE`. The measured statements were produced
by the real builders (`buildPurchaseOrderAggregateQuery`, `buildPurchaseInvoiceAggregateQuery`,
`buildPurchaseReturnCountQuery`, `buildStockOperationCountQuery`, `buildSalesReturnCountQuery`)
plus the verbatim three-identifier serial-cascade `SELECT` from
[serials.service.ts:321](../server/src/services/serials.service.ts#L321). Search term:
`SN-B1-000042` (one matching row; the serial statement also searches the matching PON and MAC).
Each statement ran once to warm the cache, then **7 recorded runs** with
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; p50/p95 are the plan's `Execution Time`, not
Node/client wall time.

#### Scan results (filtered count / pre-select)

| Scan | Table | 1× p50 / p95 (ms) | 10× p50 / p95 (ms) | Plan shape at 1× → 10× |
|---|---|---:|---:|---|
| PO register | `purchase_orders` | 49.4 / 55.6 | 521.0 / 576.2 | Aggregate → Bitmap Heap Scan (branch index) → **Seq Scan** |
| PI register | `purchase_invoices` | 54.9 / 55.2 | 489.0 / 720.1 | Aggregate → Bitmap Heap Scan (branch index) → same |
| Purchase-return register | `purchase_returns` | 8.3 / 8.5 | 70.0 / 80.8 | Aggregate → Bitmap Heap Scan (branch index) → same |
| Stock-operation register | `stock_operations` | 302.5 / 472.1 | 1,249.3 / 1,366.0 | Aggregate → **Seq Scan** → Gather → Parallel Seq Scan |
| Sales-return register | `sales_returns` | 12.3 / 12.5 | 110.3 / 131.1 | Aggregate → Bitmap Heap Scan (branch index) → same |
| Serial rename: PI | `purchase_invoices` | 249.8 / 291.1 | 2,510.2 / 2,698.4 | **Seq Scan** → same |
| Serial rename: shipments | `shipments` | 387.5 / 412.9 | 4,093.2 / 4,109.4 | **Seq Scan** → same |
| Serial rename: stock operations | `stock_operations` | 759.1 / 821.5 | 2,879.4 / 3,207.5 | **Seq Scan** → Gather → Parallel Seq Scan |

The five register scans also run a 25-row page query with the same `WHERE` plus
`ORDER BY created_at DESC LIMIT 25`. Its p50 tracked the scan (PO 44.7 → 516.3 ms,
PI 48.3 → 457.5 ms, PR 6.6 → 74.2 ms, SO 293.2 → 1,218.1 ms, SR 9.5 → 125.4 ms). A register
request executes that `WHERE` roughly three times (aggregate KPI, status counts, page), so the
**10× stock-operation screen is ~3.7 s of database scan before rendering**; the 1× version is
still ~0.9 s.

Representative 10× plans (run 2):

```
Aggregate > Gather > Partial Aggregate > Parallel Seq Scan on stock_operations
  Filter: ((branch_id = 'BR01' OR destination_warehouse_id = 'BR01') AND (… lower(items::text) LIKE …))
  Rows Removed by Filter: 40000
  Execution Time: 1501.116 ms

Seq Scan on shipments
  Filter: ((items::text ILIKE '%SN-B1-000042%') OR (items::text ILIKE '%PON-B1-000042%') OR (items::text ILIKE '%AA:BB:CC:00:00:2A%'))
  Rows Removed by Filter: 59999
  Execution Time: 3934.077 ms
```

**Variance.** A second full run on the same data moved most p50s by −39% to +18% (the 1×
stock-operation and serial-PI scans were the largest downward moves) and by up to 2.8× on the
60k-row shipments scan, where the plan changed from a parallel to a serial sequential scan; the
ranking and every result above 1 s stayed the same. Treat the absolute numbers as shape and order of magnitude, not SLAs: this was
a local Windows CPU, not the deployment host, and `shared_buffers` held the whole 1× data set.

#### Reproducible SQL

```sql
-- Five register scans: the shared WHERE is COUNTed here; the page query adds
-- SELECT <columns> FROM <table> … ORDER BY created_at DESC LIMIT 25.
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT COUNT(*)::int FROM purchase_orders
WHERE 1=1 AND branch_id = 'BR01'
  AND (LOWER(po_number) LIKE '%sn-b1-000042%'
    OR LOWER(supplier_name) LIKE '%sn-b1-000042%'
    OR LOWER(items::text) LIKE '%sn-b1-000042%');

-- Same shape, table-specific header columns:
--   purchase_invoices: invoice_number, COALESCE(vendor_bill_number,''), supplier_name, items
--   purchase_returns:  return_number, original_invoice_number, supplier_name, items
--   sales_returns:     return_number, original_invoice_number, customer_name, items
--   stock_operations:  reference_number, COALESCE(technician_name,''),
--                      COALESCE(work_order_ref,''), reason, items
--                      (plus branch_id = $1 OR destination_warehouse_id = $1)

-- Three serial-rename pre-selects, one per table (purchase_invoices, shipments, stock_operations):
SELECT id, items FROM stock_operations
WHERE items::text ILIKE '%SN-B1-000042%'
   OR items::text ILIKE '%PON-B1-000042%'
   OR items::text ILIKE '%AA:BB:CC:00:00:2A%';
```

#### Decision

**Trigger threshold.** Any user-visible search whose p95 scan exceeds **150 ms at modelled 1×
volume**, or whose 10× plan is a sequential scan over **more than 50k rows**, starts B2. B1 is
over that line today: the 1× stock-operation scan is 302 ms and the three serial scans are
250–759 ms; at 10× four scans exceed 1 s.

- **B2 — GO, shipped 2026-10-25.** `pg_trgm` 1.6 is available and the application role can create
  it. The index must cover the **whole searched expression**, not only `items::text`: the five
  register predicates are `header OR header OR items`, so an unindexed header branch forces a seq
  scan. A scratch spot-check on `stock_operations` at 1× (12k rows) left the 284.6 ms seq scan
  unchanged with a bare `LOWER(items::text)` GIN, then a GIN on
  `lower(coalesce(reference_number,'') || ' ' || … || items::text)` used a Bitmap Index Scan and
  ran the same scan in **5.5 ms**. B2 shipped exactly that combined expression as a generated
  stored column and pointed all eight scans at it; see §B2 for the delivered shape and the
  120k-row measurement.
- **B3 — PARK.** No report or join currently needs item rows; the measured pain is search, and
  B2 addresses it without a second write path. Revisit only when a report needs item-level
  filters/joins.
- **B4 — PARK.** Unchanged: full normalization needs a product decision and B1 does not demand it.

### B2 — Index strategy for item search

| | |
|---|---|
| **Why** | These are substring searches over serialised JSON; the right index depends on B1. |
| **Options** | (a) `pg_trgm` GIN on `items::text` — closest drop-in for the current `LIKE '%q%'`; needs the extension, but B1 proved an items-only index is not used while the same OR contains unindexed header columns. (b) Generated `tsvector` + GIN — no extension, but token semantics change (won't match arbitrary serial fragments). (c) Narrow the search to documented fields (SKU, product name, serial) via a projection. (d) **Chosen by B1:** one `pg_trgm` GIN on the combined search expression (all header columns + `items::text`) per table. |
| **Done when** | The combined-expression index ships in `schema.sql` (single DDL source), the parity test passes, and all eight scans use that exact expression; the 10× stock-operation scan drops from ~1.25 s to a small double-digit millisecond index path (the 1× spot check was 5.5 ms). |
| **B1 decision 2026-10-25** | **GO.** Bare `items::text` is insufficient; use the combined expression. See B1 for numbers and the spot check. |
| **Done 2026-10-25** | `pg_trgm` plus six generated `search_text` columns and six GIN indexes ship in `schema.sql`; existing databases get the columns through `ALTER TABLE … ADD COLUMN IF NOT EXISTS` before the indexes. All eight scans now bind one lower-cased `search_text LIKE $n`; no server query mentions `items::text`. Fresh 12k/120k-row check: at 120k the stock-op count went from **265.2 ms (Seq Scan)** to **15.4 ms (Bitmap Heap Scan)** with the same single result; at 12k both used a Seq Scan (54.7 → 17.9 ms), so the planner switches to the index exactly where B1 measured the pain. |
| **Rough effort / risk** | 1 day · low |

#### Delivered shape (2026-10-25)

The extension is created once at the top of `schema.sql` (`CREATE EXTENSION IF NOT EXISTS pg_trgm`).
Each searched table declares a stored generated column:

```sql
search_text TEXT GENERATED ALWAYS AS (
  lower(COALESCE(header_a, '') || ' ' || COALESCE(header_b, '') || ' ' || COALESCE(items::text, ''))
) STORED
```

| Table | Header columns folded into `search_text` |
|---|---|
| `purchase_orders` | `po_number`, `supplier_name`, `items` |
| `purchase_invoices` | `invoice_number`, `vendor_bill_number`, `supplier_name`, `items` |
| `shipments` | `items` (the serial cascade is its only search) |
| `stock_operations` | `reference_number`, `technician_name`, `work_order_ref`, `reason`, `items` |
| `purchase_returns` | `return_number`, `original_invoice_number`, `supplier_name`, `items` |
| `sales_returns` | `return_number`, `original_invoice_number`, `customer_name`, `items` |

Each table gets `CREATE INDEX … USING gin (search_text gin_trgm_ops)`. `sales_invoices` carries
`items` but has no item-search query, so it is deliberately not included. The runtime parity
section repeats every generated column as `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (a no-op on a
fresh install, required for an existing database) before the `IF NOT EXISTS` indexes run. The eight
call sites are `buildPurchaseOrderWhere`, `buildPurchaseInvoiceWhere`, `buildPurchaseReturnWhere`,
`buildStockOperationWhere`, `buildSalesReturnWhere` and the three-table serial pre-select in
`cascadeRenameJsonbTables`; all of them use the column, and the serial parameters are lower-cased
to match it.

The upgrade path was exercised on a database built from the pre-B2 `HEAD` schema and seeded with
12k stock operations: applying the new schema created all six columns/indexes, preserved the same
single search result, re-applied as a clean no-op, and the count used a Bitmap Heap Scan (9.5 ms).
That first apply took **~4.7 s** at 12k rows; adding a stored generated column rewrites each table
once, so the first boot after this upgrade is a one-time maintenance cost that grows with volume.

### B3 — Read-only item projection tables

| | |
|---|---|
| **Why** | Item-level reporting and auditing without rewriting the document model. |
| **Change** | Add e.g. `purchase_invoice_items` / `sales_invoice_items`, populated in the same transaction as the document write, backfilled by a script; JSONB stays the document of record and export format. |
| **B1 decision 2026-10-25** | **PARK.** No current report or join needs item rows; search is the measured cost and B2 covers it. Revisit when an item-level report is actually required, or when the SUM-1 trading aggregate's DB CPU becomes the constraint (a single-table `stock_operation_items` projection or write-time totals is the narrow fallback). |
| **SUM-1 2026-10-26** | The financial-summary slice was the last place moving raw item JSON: it selected every `STOCK_OUT` line for the year/branch and parsed them in Node on seven refresh domains. It now aggregates revenue/COGS in SQL with `jsonb_to_recordset` and returns two numbers. At 120k operations: **357 ms** vs the old 824 ms (wall + Node parse), and 27.4 MiB of line JSON removed. B3 stays parked; a **single-table** `stock_operation_items` projection (or write-time totals) is the narrow fallback only if the aggregate's DB CPU becomes the constraint. |
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
A1 (done) → A2 (done) → A6 (done)   stop: notes + this checklist
A3 (done) → A4a (done)              stop: notes + this checklist
B1 (done) → B2 (done)               stop: notes + this checklist
B3 (parked by B1)                   do not start without an item-level report
A5 → A4b, then B4                   only on a deliberate, recorded decision
```

At each stop point: `npx tsc --noEmit`, `npm test`, docs-count gate green, tick the boxes here, and
write the next slice ID into `SESSION_NOTES.md` so the next session does not have to rediscover it.

## Open decisions

| # | Decision | Needed before |
|---|---|---|
| 1 | D: fail-fast only, or also support a generated-and-persisted secret file? (recommendation: fail-fast; a file is a second place to lose) | D1 |
| 2 | C: should a failed slice be operator-visible, or only logged? (recommendation: one dismissible notice, never a toast per slice) | C1 |
| 3 | A: is root re-render cost user-visible yet? If not, A1/A2 are enough for now | A3 |
| 4 | B: does any report need item-level joins, or only search? **Resolved by B1 (2026-10-25): search only → B2 shipped; B3 parked.** | B3/B4 |

## Explicitly not doing

- **No big-bang App.tsx extraction.** Screens come out one at a time, behind A6.
- **No wholesale JSONB normalization.** B2 now indexes search; JSONB stays the document of record until B3/B4 justify more.
- **No PM2 cluster mode** until sessions, caches and SSE are shared (see D3).
- **No global state library** before A6; motion is not a reason to add one.
- **No dropping `items` or `history_json`** even after B4; they remain the export/audit format.
