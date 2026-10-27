# Bug & loop audit — 2026-10-27

Full-tree bug and cycle sweep, run after Round 7 closed. This is an audit
record: file references and behaviour were true when written; where an entry
conflicts with the code, the code wins.

## Scope and method

The whole application tree (`server/src`, `client/src`, `shared`, `scripts`),
swept for **loop and cycle classes** rather than line-by-line review:

- every timer (`setInterval` / `setTimeout` / `requestAnimationFrame`) and its cleanup;
- every explicit loop (`while`, `for (;;)`) and whether it terminates;
- React effect dependency cycles — a static pass over all 161 client files
  (state-set-in-own-deps, non-memoized function deps, seed-from-live-data),
  with every hit read and verified;
- event-listener add/remove pairs and store subscribe/unsubscribe symmetry;
- circular value imports across the whole source graph (DFS over resolved
  relative imports, `import type` excluded);
- retry/backoff paths (SSE client, version polling, failed-slice retries);
- swallowed errors (`catch {}`), unguarded `JSON.parse`, `parseInt` radix;
- server feedback loops (SSE broadcast → client refresh → broadcast).

Two throwaway analysers were used for the effect-dependency and import-cycle
passes; only their verified conclusions are recorded here. Every candidate
below was confirmed against the code; the dismissed sets are listed so the
sweep is reproducible.

## Findings

### AUD-1 — Physical Stock Audit silently discards in-progress counts (High)

`client/src/features/inventory/PhysicalStockAudit.tsx` keeps the count grid in
`auditRows` state, seeded from an `initialAuditRows` memo:

- `:128` — `stockIndex = useMemo(() => indexStockByProductBranch(stock), [stock])`
- `:292-327` — `initialAuditRows` maps every product to a row with
  `countedQty = bookQty`, `isCounted: true`, deps
  `[products, stockIndex, activeBranchId, pendingAuditRequest]`
- `:329-333` — `useState(initialAuditRows)` plus
  `useEffect(() => { setAuditRows(initialAuditRows); }, [initialAuditRows])`

`stock` is the live bootstrap slice (`App.tsx:2033` passes `stock={stock}`),
and `DOMAIN_STATE_KEYS.STOCK` re-fetches it on **any** stock movement in scope
— sales, purchases, receives, transfers, damage, recalcs, CPE
assignment/exchange. So while an operator is counting, a background stock
update replaces the whole grid: every typed `countedQty`, variance reason and
custom reason is discarded, and the rows come back as
book-quantity-counted (`isCounted: true`), i.e. the screen silently claims
"all matched". There is no dirty/touched guard anywhere in the file
(`handleCountChange` refuses edits when `isTableLocked`, but the reset effect
does not check it), and no test covers the count-grid behaviour — the file's
only test references are a DF-17 source guard and the route-domain wiring map.
The submit payload is
`auditRows` (`:793`), so a submission after a reset reconciles at book value.

Trigger frequency is what makes this High rather than cosmetic: in an
active deployment, stock-domain events arrive from every other operator.

**Suggested fix:** re-seed only on `activeBranchId` / `pendingAuditRequest`
changes; on `products`/`stockIndex` changes merge book quantities into the
existing rows (and append new products) without touching operator-entered
fields — track touched rows by `productId`, or skip the re-seed while any row
is edited.

**Fixed (same day):** the reset effect now keys off a session signature
(`activeBranchId|pendingAuditRequest.id`); a real session change still
full-re-seeds, while a live `products`/`stock` refresh goes through
`mergeCountRows` (`client/src/utils/auditRowMerge.ts`), which keeps
`countedQty` / `isCounted` / `varianceReason` / `customReason` for rows the
operator has touched (`touchedAuditProductsRef`, marked by all five mutating
handlers including Zero-All) and adopts the fresh seed everywhere else —
including new/removed products and the fresh book quantity. The merge returns
the previous array when nothing changed, so a no-op seed cannot churn state.
`tests/auditRowMerge.test.ts` covers the merge (6 cases) plus a source guard
that pins the wiring and the absence of the unconditional reseed.

### AUD-2 — Permission save updates the live matrix before the DB commits (Medium)

`server/src/controllers/permissions.controller.ts:52` calls
`setPermissionMatrix(JSON.parse(JSON.stringify(matrix)))` **inside** the
`withTransaction` callback. Every authz check reads that in-memory matrix per
request. If the caller's COMMIT fails (pool/connection error, later statement
failure), the handler returns 500 while the running server already enforces
the new grants — DB and memory diverge until the next successful save or a
restart. The happy path is fine; the failure path is the bug.

**Suggested fix:** move `setPermissionMatrix` after `await
withTransaction(...)` resolves, so memory only updates on a committed write.

**Fixed (same day):** the replace + publish sequence moved into
`server/src/services/permissionMatrix.service.ts` (`persistPermissionMatrix`),
which runs the DELETE/UPSERTs inside the transaction and publishes the
deep-copied matrix only once it resolves; the controller now supplies
`withTransaction` and `setPermissionMatrix` as its two dependencies. Ordering
a COMMIT failure against a live database is not deterministic, so the runner
and publish hook are injected (the `SerialBackfillDb` pattern) and
`tests/permissionMatrixPublish.test.ts` drives a runner that fails at COMMIT —
asserting nothing is published and the real `permissionMatrix` binding keeps
the previous grants — plus a mid-write failure, the statement order, the
defensive copy, and a source guard that the controller never calls
`setPermissionMatrix` itself.

### AUD-3 — Unbounded serial-slot padding loops keyed to unclamped quantities (Low-Medium)

Six change-handlers pad an array of serial-slot objects up to a line quantity
with `while (arr.length < qty) push(...)`, and the quantity is never clamped
or capped:

- `client/src/features/sales/SalesInvoices.tsx:261` (`syncSerialSlots`; the
  quantity input at `:787` passes `Number(e.target.value)` straight through)
- `client/src/features/procurement/PurchaseInvoiceForm.tsx:337`
- `client/src/features/procurement/CreateShipmentForm.tsx:142`
- `client/src/features/inventory/stockops/ProductSalePanel.tsx:145`
- `client/src/features/inventory/stockops/CreateTransferPanel.tsx:160`
- `client/src/features/inventory/stockops/CreatePulloutPanel.tsx:173`

The loop always terminates for valid input, but it is bounded only by the
typed number: a nine-digit quantity builds that many slot objects on the
keystroke, freezing the tab (allocating millions of objects). `Math.max(1, …)`
guards the bottom, nothing guards the top.

**Suggested fix:** clamp quantities at the parse site once (a shared helper,
e.g. cap at remaining stock-on-hand or a sane ceiling), so every padding loop
becomes bounded by construction.

### AUD-4 — SSE retry timer is overwritten, not guarded (hardening)

`client/src/services/api/sync.ts` (`scheduleRetry`) assigns
`retryTimeout = setTimeout(connect, delay)` without checking for an existing
pending timer. Today this is **not reachable** as a double connect —
`eventSource.onerror` fires once per failed source (which is closed
immediately) and `reconnectNow` clears the pending timer before connecting —
but one handler change (e.g. handling `onerror` without nulling
`eventSource`, or an extra caller) would allow overlapping connections.
Adding `if (retryTimeout) return;` at the top of `scheduleRetry` makes the
invariant explicit.

### AUD-5 — BS day-range generation has no span cap (hardening)

`client/src/features/finance/NepaliFiscalManagement.tsx:328` iterates every
day between two user-supplied AD dates, converting each one. The default is
one fiscal year (~365 iterations), which is fine; the inputs are not capped,
so a multi-decade span grinds the screen through tens of thousands of
conversions. Not a hang (invalid dates no-op the loop) — worth a span
guidance/limit the next time that screen is touched.

## Verified clean (dismissed candidates, so the sweep is reproducible)

- **Effect dependencies:** the static pass surfaced 40 candidates; 39 were read
  and dismissed as converging or false positives — one-shot clamps
  (`TablePagination.useServerPageClamp`, guarded by `page !== safePage`),
  "select the default when the current value vanished" effects (FY
  selectors, opening balances, wizard), click-outside/Escape handlers,
  string-key scope deps (`exchangeQueryScope` returns a `string`;
  `useShipmentOverview(scope: string)`), derived primitives, and
  `useFilterPageReset` (render-phase reset, documented). AUD-1 is the one
  confirmed loop-adjacent defect.
- **Import cycles:** 28 cycles, **every one through `server/src/app.ts`** —
  the documented controllers→`app`→routes pattern (controllers read
  `sseClients`/`getDataVersion` at request time, not module init). No client
  cycles, no service↔service cycles; `tests/serverBundleBoot.guard.test.ts`
  boots the CJS bundle where the hazard would show.
- **Timers:** only two `setInterval`s exist — SSE keep-alive
  (`server/src/controllers/sync.controller.ts:23`, cleared on `req.close`)
  and the stream-gap version poll (`App.tsx:1248`, cleared on cleanup) — plus
  toast/dismiss timeouts, all cleared or effect-scoped.
- **Explicit loops:** the only `while (true)` is `mapWithConcurrency`'s
  bounded worker pool (terminates when the index passes the list). All other
  `while`s are bounded (`rateLimiter` prune, scope eviction, page cap,
  day-range with valid dates).
- **Swallowed errors:** all empty `catch` blocks reviewed — transaction
  rollback best-effort, session-cache quota, SSE relay, refusal telemetry,
  rollback in `serialEdit`. None hides a mutation failure.
- **Broadcasts:** no feedback loop — mutations broadcast, clients issue GETs
  only; `logAuditEvent` broadcasts twice deliberately (business domain +
  `AUDIT_LOGGED`).
- **Refresh chain:** `refreshOperationalCache` serialises through a promise
  chain with no deadlock or leak; failures are logged and self-heal on the
  next write. A persistently failing slice falls back to a full bootstrap per
  SSE burst (debounced) — event-driven, not a loop.
- **Misc:** no `async forEach`, no `setImmediate`/`nextTick`, no `.splice`
  during iteration, every `addEventListener` has a matching removal,
  `post_exchangeRefusal`'s 204 bypasses the cache hook but prepends the audit
  row in memory itself, and `exchangeDeviceStore`/rate limiters bound their
  own growth.

## Limits

Pattern-based sweep, not a line-by-line proof: business-logic correctness and
SQL semantics stay with the 1366-test suite and the per-domain audits under
`docs/`. No runtime profiling was done; the effect and cycle passes used
static heuristics whose candidates were all manually verified. AUD-1 and
AUD-3 were found by reading, not by a failing test. AUD-1 now has behavioural
coverage in `tests/auditRowMerge.test.ts` and AUD-2 in
`tests/permissionMatrixPublish.test.ts`; AUD-3, AUD-4 and AUD-5 are still
unguarded.
