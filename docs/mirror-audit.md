# In-Memory Mirror Audit — `server/src/app.ts`

**Scope:** every module-level business-state array/object in `app.ts`, who
reads it while PostgreSQL is connected, and whether it is load-bearing,
cache-only, or vestigial. Produced as the audit phase of the mirror-retirement
roadmap (improvement #4). Findings verified against the code at commit
`9ae25d5`, 2026-09-24.

---

## How the mirrors work today

- **Declaration:** 22 `export let` business arrays + 5 metadata mirrors
  (companyProfile, docNumberConfigs, permissionMatrix, bs-calendar) in app.ts,
  all typed `readonly` and mutated only through `setX(withReplaced/...())`
  copy helpers.
- **Hydration:** one mechanism — the `CACHE_LOADS` table (app.ts ~line 2434)
  lists each mirror with its SQL; `hydrateOperationalData` runs it at boot
  and `refreshOperationalCache` re-runs it after every committed write.
- **Dual role:** while PG is connected the mirrors are a *read cache* for
  fast request handling and a *write mirror* so the next bootstrap is
  consistent; when PG is down they are the *only* store (demo mode).
- **Enforcement gap:** nothing forbids a controller from mutating a mirror
  without touching PG, or from trusting a stale mirror row in a guard —
  which is exactly the dual-write/dual-read bug class this audit maps.

## Verdict summary

| Class | Mirrors | Meaning |
|---|---|---|
| **A. Vestigial / near-dead** | `vendorOpeningBalances` | No reader anywhere outside app.ts. Delete now. |
| **B. Read cache only** | `uomList`, `locationRecords`, `categories`, `products`, `branches`, `fiscalYears`, `companyProfile`, `docNumberConfigs`, `permissionMatrix`, `users`, `suppliers` | Serves GET endpoints / lookups; PG path re-fetches or upserts through SQL on every write. Low-risk retirement once GETs hit PG. |
| **C. Load-bearing guards** | `inventoryStock`, `stockOperations`, `products` (validation), `customerDeviceRecords`, `serialLogs`, `damageRecords` | Read for *pre-flight validation* (stock availability, serial clash) inside request handling. Retiring these requires moving guards into SQL (some already are). Highest risk. |
| **D. Ledger mirrors** | `transactionLogs`, `auditTrail`, `approvalRequests`, `purchaseOrders`, `purchaseInvoices`, `shipments`, `vendorPayments`, `customerMasterRecords`, `assetRegister` | Appended after writes for UI freshness; authoritative reads already go to PG in most GET paths. |

Not mirrors (correctly in-memory): `sseClients` (connection handles),
`activeUser` (session id only; authentication reads PG), `dataVersion`
(counter), `inFlightRequests` client-side.

---

## Mirror-by-mirror findings

### 1. `vendorOpeningBalances` — VESTIGIAL (delete)

- **Readers outside app.ts:** **0** across controllers/routes/services.
- Set by `CACHE_LOADS` at boot/refresh, counted in a boot log line, never
  read by any endpoint. The vendor-opening-balance feature reads PG directly
  (`/api/fiscal-years/:id/vendor-opening-balances`).
- **Action:** delete the mirror, its `CACHE_LOADS` entry, setter, and boot
  log mention. Zero behavior change.

### 2. `serialLogs` — near-vestigial (already trimmed; 3 narrow uses)

- Post-bootstrap-trim, remaining PG-connected uses:
  1. `findInMemorySerialClash` pre-check before serial rename (app.ts 1317)
  2. `applyInMemorySerialRename` mirror update (app.ts 1324)
  3. `quarantineInMemorySerials` / restore in damage create/reverse
     (inventory.controller 903, 1061) + serial-log PATCH lookup (1829)
- All have SQL equivalents already running in the same request (the rename
  flow re-verifies clashes inside the transaction; `lookupSerial` endpoint
  is PG-backed).
- **Action:** medium-term, drop uses 1–4 and keep the PG checks; the mirror
  then only serves PG-down demo mode.

### 3. `inventoryStock` — load-bearing guard mirror (highest risk)

- ~44 refs. **PG-connected request paths read it for decisions:**
  - stock availability pre-flight in stock-operation create (711–712),
    bulk reorder (361–392), PATCH stock (117, 289–294), reconcile (425, 504)
  - `validateReversalAvailability` + reversal ledger `quantityBefore`
    computation (969, 984) — the reversal correctness depends on the
    mirror matching PG
  - vendor-payment / invoice-receive stock updates (procurement.controller)
- The stock-mutation SQL guards (`damaged_qty >= $1`, batched reversal
  `damaged_qty >= d.qty`) already enforce correctness in PG; the mirror
  adds *friendlier pre-flight errors* but is also the source of
  false-available races (two rapid issues both pass pre-flight).
- **Action:** replace pre-flight reads with a `SELECT ... FOR UPDATE` inside
  the write transaction (pattern exists in `post_receive`), then demote the
  mirror to PG-down fallback only.

### 4. `stockOperations` — mostly-fresh mirror

- Reads: GET list (689–692, no PG re-read!), find-by-id for
  receive/reverse flows (886, 946, 1102, 1225). `get_stockOperations`
  paged path reads PG, but the legacy GET and receive/reverse flows
  still read the mirror.
- **Action:** point find-by-id reads at PG (`STOCK_FIND_BY_ID_SQL` exists),
  keep mirror for demo mode.

### 5. `products` — dual-use

- Validation in stock-op create (711: `requiresSerialTracking` checks) and
  PATCH flows; GET endpoints serve it directly. Product data changes rarely;
  staleness risk low but serial-tracking checks on a stale row could
  mis-require serials after a config change until next refresh.
- **Action:** fold product flags into the PG pre-flight query when #3 is
  done; until then accept the risk (refresh-on-write keeps it fresh).

### 6. `customerDeviceRecords` — guard mirror

- ~19 refs; serial-clash pre-checks in device exchange / dual-edit flows
  read it, and `post_exchange`/rename flows fall back to it *before* PG
  (`customerRecord = customerDeviceRecords.find(...)` then PG re-query).
  Mutations update both PG and mirror.
- **Action:** invert to PG-first (the PG query already exists right after
  the mirror read) — small, safe change.

### 7. `damageRecords` — append-mirror

- Read by damaged-stock tracking GET (serves mirror when PG connected?) —
  primarily appended after damage create / cancelled after reverse to keep
  bootstrap fresh. Bootstrap embeds it; no guard decisions ride on it.
- **Action:** class D; retire when bootstrap slice served from PG.

### 8. `transactionLogs` / `auditTrail` — append-mirrors

- `get_transactionLogs` already reads PG when connected (misc.controller
  89–100) — mirror only feeds the legacy response fallback and bootstrap.
  `auditTrail` is read by `get_auditTrail` (misc 80) — verify PG path there
  too; `auth.controller` 304 prepends password-reset events.
- **Action:** audit-trail GET → PG-first, then mirrors are demo-mode-only.

### 9. `approvalRequests` — mixed

- GET serves mirror (misc.controller); write flows update PG + mirror.
  Low volume, low risk.
- **Action:** GET → PG first.

### 10. `purchaseOrders` / `purchaseInvoices` / `shipments` / `vendorPayments`

- Registers already read PG via paged endpoints (recent work). Remaining
  mirror reads: bootstrap assembly (still ships these arrays), PI's
  pending-PO dropdown, movement ledger join data, dashboard KPIs. Writes
  mirror-append after PG commit — safe direction.
- **Action:** retire consumer-by-consumer per the bootstrap trim roadmap
  (already documented in bootstrap.controller). The mirrors die when the
  last bootstrap consumer moves to PG fetches.

### 11. Master-data mirrors (`branches`, `suppliers`, `users`, `categories`, `uomList`, `locationRecords`, `customerMasterRecords`)

- Served directly by their GET endpoints (e.g. `res.json(uomList)` —
  masterdata.controller 31) even while PG connected; writes upsert PG then
  update mirror. `branches` is also read by `issueNextDocNumber` (code
  lookup) on nearly every write — hot path, and staleness here would
  mis-prefix document numbers until refresh.
- **Action:** GET endpoints → PG SELECT (cheap, indexed). Keep `branches`
  mirror last of this class (hot-path lookup) or make issueNextDocNumber
  fetch the branch row by id from PG (one indexed PK lookup, fine).

### 12. `fiscalYears` — hot-path metadata

- Read for FY resolution on writes (`getFiscalYearIdForDate`) and every
  bootstrap. Writes are rare; refresh-on-write keeps it fresh.
- **Action:** keep as cache long-term (it is a legit reference cache), or
  PG-lookup with 60s TTL if strictness demanded.

### 13. `docNumberConfigs` — hot-path config

- Read by `issueNextDocNumber` for prefix resolution on every document
  creation. Counter increment itself is PG (`UPDATE ... next_number`).
- **Action:** legit config cache; keep, but ensure admin edits refresh it
  synchronously (they do — setDocNumberConfigs after upsert).

### 14. `permissionMatrix` — intentional cache

- Read per-request by `enforceOperationalPermissions` (middleware 216).
  PG re-read per request would add a query to every operation; refreshed
  synchronously after saves. This is the model citizen of caches.
- **Action:** keep permanently as cache (document why).

### 15. `companyProfile` — bootstrap + currency config

- Serves bootstrap slice + currency config; updated via PG upsert + mirror.
  Single row; staleness risk trivial.
- **Action:** class B; low priority.

### 16. BS calendar mirrors (`inMemoryBsCalendarYears`, `inMemoryBsDayRecords`) — separate module, separate verdict

- `findBsDayRecordForAdDate` (used in every stock-op create/reverse) checks
  the in-memory day records first, PG second (hydration on failure at
  bsCalendar.ts 173–181). Day-record writes go to PG then regenerate memory.
- **Action:** this is a legitimate read-through cache with PG fallback;
  keep. Consider removing the seed-defaults fallback for production.

---

## Recommended retirement order

1. **Now (zero risk):** delete `vendorOpeningBalances` (finding 1).
2. **Small batch (low risk):** PG-first GETs for uom, locations, categories,
   approvalRequests, auditTrail (findings 9, 8, 11).
3. **Medium:** invert `customerDeviceRecords` mirror-first reads (finding 6);
   point `stockOperations` find-by-id at PG (finding 4).
4. **Hard (needs SQL guard design):** stock pre-flight into transactions
   (finding 3) with `SELECT ... FOR UPDATE`; then `serialLogs` narrow uses
   (finding 2).
5. **Consumer-driven:** PO/PI/shipments/vendorPayments mirrors die as the
   last bootstrap consumers move to PG fetches (finding 10) — tracked in
   the bootstrap trim list in bootstrap.controller.ts.
6. **Keep forever (documented caches):** `permissionMatrix`,
   `docNumberConfigs`, `fiscalYears`, BS calendar (findings 12–14, 16).

## Risks discovered during audit

- **Reversal correctness rides the mirror today:** `buildReversalLedgerWithStock`
  computes `quantityBefore` from `inventoryStock`; if the mirror is stale
  (write from another process), the ledger shows wrong before/after values.
  The PG update itself is guarded, so stock stays correct — but the ledger
  audit trail can be wrong. Fix belongs with step 4.
- **Pre-flight races:** mirror-based availability checks allow two
  concurrent issues of the same last unit to both pass pre-flight; the
  SQL guards then reject one — error surface is uglier than a pre-flight
  400, but no data corruption.
- **`get_stockOperations` legacy path** serves the mirror even when PG is
  up (line 689–692) — an inconsistency with the paged path; flagged for
  step 3.
