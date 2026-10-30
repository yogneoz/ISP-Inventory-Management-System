# SESSION NOTES — for next session

_Date: 2026-10-29 · Branch: main · Tests: 1598/1598 green with a DB (all run in CI too; the two unconditional skips are Windows-only real-signal checks that Linux CI runs — no DB-dependent skips since the PG service container landed)_

> **Current state (2026-10-27, DOC-1/CPE-2/B1/B2/CPE-3/SER-1/SER-2/TRIM-1/SUM-1/VOL-1/VOL-2/BUDGET-1/BOOT-1/VOL-3/VOL-4a/VOL-4b/SN-1/ASSET-1/EXCH-1/READ-1/CDR-1/CDR-2).** All DF-01…DF-17
> work, the bootstrap trim follow-up, A3, A4a, CPE-1, CPE-2, B1, B2, CPE-3,
> SER-1, SER-2, TRIM-1, SUM-1, VOL-1, VOL-2, BUDGET-1, Round 3
> (BOOT-1, VOL-3, VOL-4a, VOL-4b) and Round 4's ASSET-1/EXCH-1 are implemented.
> **Round 2 closed on 2026-10-26** ([archive](worklist/done/2026-10-26-round-2.md));
> **Round 3 closed on 2026-10-27** ([archive](worklist/done/2026-10-27-round-3.md)).
> **Round 4 closed on 2026-10-27** ([archive](worklist/done/2026-10-27-round-4.md)):
> ASSET-1 (`3efd446`) took `fixed_assets` off the payload and EXCH-1 (`3d7afe4`)
> moved the Device Exchange picker to the paged device read, both CI green.
> **Round 5 closed on 2026-10-27**
> ([archive](worklist/done/2026-10-27-round-5.md)): READ-1 (`8cdd09b`) deleted
> the orphaned bare-array device read, so no client code can reach the capped
> 2,000-row endpoint; STOCK-1 (`9009f9c`) indexed the stock-array lookups out of
> the stock screens (≈ 746× on the product × branch derivation, totals
> unchanged); and the STOCK-2 gate recorded **NO-GO today, GO-on-evidence**
> (`9fec135`) for a paged `inventory_stock`, with both firing conditions in
> [parked.md](worklist/parked.md).
> **Round 6 closed on 2026-10-27**
> ([archive](worklist/done/2026-10-27-round-6.md)): CDR-1 (`c147d99`, CI run
> 180) retired the legacy bare-array `GET /api/customer-devices` route, its
> handler and its 2,000-row query, replacing the test that pinned the array
> with a 404 assertion and a source guard; the paged/overview/warranty/exchange
> reads are untouched.
> **Round 7 closed on 2026-10-27**
> ([archive](worklist/done/2026-10-27-round-7.md)): CDR-2 (`46fefb6`, CI run
> 184) retired `/api/bootstrap/local?key=customerDevices` — the last legacy
> device read, 431.5 KiB gzip at the 12k model — by moving its mapping to
> `CACHE_ONLY_TABLES` so the operational cache keeps the mirror; the key
> answers 410 Gone.
> **Round 8 closed on 2026-10-28**
> ([archive](worklist/done/2026-10-28-round-8.md)): the bug & loop audit
> ([doc](docs/bug-loop-audit-2026-10-27.md)) fixed the stock-audit count loss
> (AUD-1 `fbcd013`), the permission-matrix publish order (AUD-2 `6df8ed7`) and
> unbounded line quantities in the UI and the API (AUD-3 `053a898`, QTY-1
> `f1c1131`), and the close pass fixed the two hardening items it had recorded
> as unguarded (AUD-4, AUD-5); a newly published `qs` advisory was cleared by
> the lockfile pin `67e7d47`, and the close pass shipped as `7621a20` (CI run
> 193).
> **Authorization audit (2026-10-28)**
> ([doc](docs/authorization-audit-2026-10-28.md)) reviewed all 158 routes and
> fixed eleven gaps: the by-id branch guard had been dead code (Express 4
> resets `req.params` in app-level middleware), return-register lists leaked
> across branches without a filter, and the customer ledger, financial
> statements, vendor ledger, stock rewrites, PO status, customer delete,
> approval cancel, `bootstrap/local` slices and the audit trail itself were
> unguarded, caller-attributed or shipped to every role. Pinned by
> `tests/authorization.audit.test.ts`; `tsc` clean and the suite at
> **1438/1438** (1436 pass, 0 fail, 2 Windows-only skips). Shipped as
> `9942f16` (CI run 195 green). **Branch-scope registry (2026-10-28):** the
> by-id guard's table list is now declarative and checked against
> `scripts/schema.sql` (6-test guard), so a new branch-scoped table fails CI
> unless it is guarded or explicitly exempted; the fiscal opening-stock and
> vendor-opening batch registers now refuse nested rows outside the actor's
> branches (AUTHZ-12/13). **Client scope (2026-10-28):** those two screens build
> their branch pickers, visible rows and save payload from the same scope
> (`getScopedBranches`), pinned by 4 render tests. **Draft seeding
> (2026-10-28):** an opening-stock edit now seeds its untouched fields from the
> row, so a quantity-only edit no longer blanks damaged quantity and cost or
> blocks Save, pinned by 2 render tests. **Product groups as master data
> (2026-10-28):** the product modal's hard-coded group names, category `ALL`
> sentinel, custom-category link and duplicated unit control are gone. A new
> `product_groups` table (the 37th; seeded with the three original groups)
> backs the group select, `products.product_group` references it with a rename
> cascade, and a `product-group-manage` permission owns the new Product Group
> Management tab. Every screen that compared a group name now asks
> [productGroupBehavior.ts](client/src/utils/productGroupBehavior.ts) for the
> behaviour, so renaming or adding a group keeps the selling, issuing and
> depreciation rules. Pinned by 3 new test files; suite at **1468/1468**
> (1466 pass, 0 fail, 2 Windows-only skips). Shipped as `0cc1e8f` (CI run 201
> green); the docs follow-up `57dd45b` passed as run 202. **Round 9 closed on
> 2026-10-29** ([archive](worklist/done/2026-10-29-round-9.md)): warranty
> coverage is now two explicit objects — what a supplier owes us and what we
> promise a customer — stored with the authoritative exact expiry and shown in
> the **Suppliers Warranty** and **Sellers Warranty** registers. Capture runs
> at purchase invoice, fixed asset, issue, sale and exchange, with a per-unit
> "no warranty" switch; the old derived 12-month directory, its
> `/api/customer-devices/warranty` read and its client helper are retired. Demo
> data exercises all three states on both sides. WTY-1…8 are committed
> (`bae0efa`, `f1ebd83`, `cf84fa1`, `870726b`, `752d3e4`, `5abf19e`,
> `7c56a6c`, and the WTY-8 close-out commit); CI was not requested for this
> round. **Boot paint (2026-10-29):** `eff9074` keeps a static splash until the
> saved screen commits, preloads that tab and applies cached bootstrap before
> paint, and a headless-Chrome frame gate now runs in CI after the production
> build — [run 209](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40881397737)
> is green on every step. **UI/UX audit (2026-10-29)**
> ([doc](docs/ui-ux-audit-2026-10-29.md)): UIX-1/2/3 restored mobile
> branch/FY scope, made all four shell overlays labelled modal dialogs with a
> focus trap, and made search results/register rows keyboard-operable; UIX-4/5/6
> then unified the bell/drawer/Clear All alert list, pinned the purchase-bill
> action column at 1067 px with compact dates, and removed the fabricated
> supplier/bill-number defaults. UIX-7/8/9 then widened the rail to 262 px at
> 1067 px and 225 px at 768 px with truncating tooltips, put the password field
> before Forgot Password and made a failed sign-in a live, described alert, and
> exposed the current page with `aria-current` (groups with `aria-expanded`).
> Suite **1591/1591** green. UIX-10/11/12 then closed the last three low
> findings: the dashboard hint wraps with a real gap, the warranty range is one
> labelled group, and the fiscal-year trigger shows an active dot while global
> search restores an unpicked launcher query (a picked one stays applied). No
> audit item remains open. CI [run 212](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40987214829)
> is green on `7634cc1` on every step — typecheck, all 1,591 tests, both
> convention guards, the production build, the startup bundle budget and the
> boot-timing gate; the audit commit `cde6724` had passed everything except the
> entry budget, which `7634cc1` records at 17.1 kB and raises to 18 kB while the
> 320 kB total stays at 291.2 kB. **No round is active.** The payload work
> is finished — the remaining-array measurement found no item to open, and the
> `inventory_stock` trigger is recorded in [2026.md](docs/session-notes/2026.md). The
> notes are split by year (**SN-1**): entries live in
> [docs/session-notes/2026.md](docs/session-notes/2026.md), this file is the
> current-state index. C4 is explicitly parked (one `bootstrap/local` call site
> already; see the architecture backlog §C4). B2 shipped the combined trigram
> search projection, so all eight item searches share one indexed `search_text`
> column per table; B3/B4 stay parked. CPE-3 resolved D1 and made the fixed
> asset, CPE row, serial register and stock move together. SER-1 resolved D2:
> pullout/consumable/sale now issue their units to `IN_TRANSIT`/`CONSUMED`/`SOLD`,
> each with a reversal. SER-2 resolved D3: boot no longer backfills the serial
> register; the pass is an explicit SUPER_ADMIN maintenance action. **D4
> (2026-10-25) defers A5**: measurements do not show user-visible root cost, so
> A5 is not started and A4b stays blocked behind it; reopen A5 only on the
> recorded trigger (D4 in the 2026 notes).
> Older “Remaining …” paragraphs in the 2026 file are chronological notes, not a
> live backlog; where they conflict with this index, the code wins.

## Where the history lives

- [docs/session-notes/README.md](docs/session-notes/README.md) — the folder
  index and the rule for where new entries go.
- [docs/session-notes/2026.md](docs/session-notes/2026.md) — every entry from
  the first session through the Round 8 close, newest first.
- New entries: prepend below the separator in the current year's file. This
  root file stays short (current state + index) and keeps the gated
  `Tests: N/N` claim read by
  [scripts/docsTestCounts.ts](scripts/docsTestCounts.ts).
