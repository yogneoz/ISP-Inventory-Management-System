# SESSION NOTES — for next session

_Date: 2026-09-24 · Branch: main · Tests: 364/364 green_

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

**Remaining caveats (C1–C4 all DONE; only C3 partially mitigated, queued with mirror step 4):**
- C3: mirror-based stock pre-flight races — partially mitigated (ledger fixed in B1);
  full fix is mirror step 4 (`SELECT … FOR UPDATE`).

### Also from the audit — prioritized backlog (beyond the mirror roadmap)
1. Rate limiting: NONE exists; env vars documented but unimplemented (login brute-forceable).
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
