# SESSION NOTES — for next session

_Date: 2026-09-24 · Branch: main · Tests: 399/399 green (6 are real-PG integration, auto-skip without a DB)_

## ⭐ NEWEST: full-project audit + calculation fixes (this session, uncommitted)

Two big arcs landed after the notes below were written. Both are in the working tree,
NOT yet committed.

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
2. SSE endpoint `/api/sync/stream` has NO requireAuth; no helmet/security headers;
   JSON_BODY_LIMIT documented but express.json() at default.
3. xlsx 0.18.5 unfixable high advisory (client-side parsing) — evaluate exceljs.
4. Numeric env-var guard helper (PORT=0 trap class) — do before rate limiting.
5. Integration tests for auth/branch-scoping middleware (zero HTTP-layer tests today).
6. app.ts extraction plan (state → plumbing → schema/boot → serial flows → leftover routes);
   plumbing-first unblocks the Redis pub/sub task.
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

### 4. Redis Pub/Sub event bus (approved design: Redis + in-process fallback)
- User approved: Redis when `REDIS_URL` set, otherwise in-process EventEmitter fallback.
  `.env.example` already has REDIS_URL/SSE_REDIS_CHANNEL/DISABLE_SSE_REDIS placeholders.
- Replace `broadcastChange`'s direct `sseClients` write loop with publish; SSE manager
  subscribes to the channel and fans out. `sseClients` Set is allowed to stay (connection
  handles are the permitted in-memory state).
- npm package `ioredis` NOT yet installed — verify before use.

### 5. Bootstrap trim continuation (consumer-driven)
- `stockOperations` / `purchaseOrders` / `purchaseInvoices` still ship in bootstrap (see trim
  list comment in bootstrap.controller.ts ~line 122). Consumers to migrate: dashboard KPIs,
  FY-closing wizard, PI pending-PO dropdown, movement ledger. Trim list doc is in README
  "Paged Register Endpoints".

### 6. Smaller follow-ups
- **Env var audit:** guard other numeric env vars against the PORT=0 trap
  (PG_POOL_MAX, API_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_MAX, JSON_BODY_LIMIT…).
- **Doc-number domain:** document counter changes have no SSE domain mapping (they're
  fire-and-forget PG updates in issueNextDocNumber) — consider a DOCUMENT_NUMBERING domain
  or accept eventual consistency.
- **Registers + SSE:** paged registers (Serial Log, Consumables, POs, PIs) fetch their own
  pages but don't listen to SSE domain events — wire their refreshKey to bump when the
  matching domain event arrives so background changes show without user action.
- **CRLF warnings** on new files (LF→CRLF) — cosmetic; consider .gitattributes.

## Key files touched this arc (for context)

- `client/src/services/api/*` (new structure), `client/src/App.tsx` (SSE handler ~line 470,
  DOMAIN_STATE_KEYS map, syncScopeRef)
- `server/src/app.ts` (broadcastChange + resolveDomain import), `server/src/syncDomains.ts`
- `server/src/controllers/bootstrap.controller.ts` (get_bootstrapLocal), routes file
- `server/src/models/inventory.repo.ts` (batched SQL), `inventory.controller.ts` (reversals)
- `docs/mirror-audit.md` — READ THIS FIRST for retirement work (NOTE: its step-2 findings
  and vendorOpeningBalances/classification rows are now stale — update alongside step 3)
- `client/src/utils/depreciation.ts` + `tests/depreciation.test.ts` (B5)
- `server/src/services/damage.service.ts` (B1/B2 helpers), `server/src/models/procurement.repo.ts` (B3)
