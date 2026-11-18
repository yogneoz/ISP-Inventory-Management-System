# Worklist

Working tracker for the current and future batches. Created 2026-10-26.

## Why this exists

`SESSION_NOTES.md` is the chronological decision log (4,500+ lines). Task
checklists, step order and acceptance details do not belong there: they grow
the file and go stale. This folder holds the working plan; SESSION_NOTES keeps
one short entry per completed item and a link here.

The permanent record stays where a reader expects it: the code and schema,
[architecture-backlog.md](../docs/architecture-backlog.md), the per-domain
audits under `docs/`, [handoff.md](../handoff.md) and SESSION_NOTES. This folder
is the plan, not a second source of truth.

## Layout

- [parked.md](parked.md) — decisions we are not acting on, with the trigger to
  reopen each one.
- [done/](done/README.md) — completed rounds, kept for reference. Never delete.
- **Round 15 is active** — advisory hardening from the 2026-11-17 database audit
  and the Sign-In investigation. Rounds 11, 13 and 14 were terminated as active
  plans on 2026-11-17 and carried into Round 15 as Parts B and C, so one plan is
  active and nothing was dropped. Plan and slice list:
  [2026-11-17-advisory-hardening/README.md](2026-11-17-advisory-hardening/README.md).
- **Round 11 — superseded 2026-11-17** (Round 15 Part B) — cash receipts, voucher classes and non-trade
  funding. Plan and slice list:
  [2026-11-14-cash-receipts-and-funding/README.md](2026-11-14-cash-receipts-and-funding/README.md).
- **Round 12 is complete** — backup/recovery and database availability from
  the 2026-11-15 readiness audit (C1, H1). **OPS-1, OPS-2, OPS-3, OPS-4,
  OPS-5, BAK-1, BAK-2, BAK-3, BAK-4 and BAK-5 are done (2026-11-16)** with
  `tests/dbAvailability.test.ts`, `tests/bootstrapEtag.test.ts`,
  `tests/bootstrapPayloadMeasure.test.ts`, `tests/ops4Config.test.ts`, the
  baseline probe, `tests/backupScript.test.ts`, `tests/restoreScript.test.ts`,
  `tests/restoreDrill.test.ts`, `tests/setupGuard.test.ts` and
  `tests/disasterRecoveryRunbook.test.ts`. OPS-3 cut the measured bootstrap
  gzip from **157,569 B to 6,198 B (−96.1%)**; SCALE-2 then took the shell to
  **2,489 B** on demo data and **10,421 B with 500 branches**. Plan and slice list:
  [2026-11-16-backup-and-db-availability/README.md](2026-11-16-backup-and-db-availability/README.md).
- **Round 13 — superseded 2026-11-17** (Round 15 Part B) — the enterprise-scale envelope
  (3,000–10,000+ sessions, 200–500+ branches, 5M–50M customers, 1B–10B rows)
  and public-internet hardening, from the 2026-11-16 mandate. **SCALE-1 is
  done (2026-11-16)**: Redis-backed limits, session fingerprints, locks/leader
  election and SSE fan-out, with pm2 in cluster mode. **SCALE-2 is done
  (2026-11-16)** for the bootstrap shell, keyset cursors and scope guards, and
  every register in the original set, both return registers, the pullout/damage/
  log stock panels and the customer ledger's invoice picker now load/append
  through `nextCursor` with a visible `SCOPE_REQUIRED` state. **The SCALE-2 operational-register follow-up is done
  (2026-11-17)**: fixed assets, warranty coverage, shipments, purchase orders
  and purchase invoices now use the same signed cursor contract. The
  serial-focused audit lookup, the audit stock-movement report window and the
  CustomerLedger statement body remain intentionally unconverted. Next:
  [2026-11-16-enterprise-scale-and-public-exposure/README.md](2026-11-16-enterprise-scale-and-public-exposure/README.md).
  **The first SCALE-3 slice is done (2026-11-17):** monthly journal partitions are
  provisioned at boot with `npm run check:partitions` as the read-only gate,
  `inventory_stock` and `document_sequence_daily` carry HOT-friendly storage
  parameters (migration `0030`), and the bootstrap payload version is shared
  through Redis. **The first partition conversion landed (2026-11-17):**
  migration `0034` turns `gl_subledger_entries` into monthly RANGE partitions by
  `entry_date_ad` with a DEFAULT child and an append-only guard on every child,
  provisioned from the posting path's existing month call; a one-month read now
  prunes to a single child. **`stock_operations` followed (2026-11-17):**
  migration `0035` partitions the operational register by `date_ad` and keeps
  `reference_number` globally unique through `document_identity_registry`, the
  generalised form of `gl_journals_registry` (one table, one trigger, a reused
  reference still refused and a backdate refused). **`serial_log` followed
  (2026-11-18):** migration `0036` partitions the register by `created_at` and
  the registry now carries several keys per document (`key_role` + per-key
  `ci`/`optional` specs), so its three case-insensitive keys keep their exact
  semantics — a held key still skips an insert-if-absent row, a rename onto a
  held key still raises `23505`, and the date cannot move. **`sales_invoices`
  closed the programme (2026-11-18):** migration `0039` partitions the sales
  register by `invoice_date_ad`, and its three inbound foreign keys now point at
  the registry (the `gl_journals_registry` pattern) because a partitioned table
  cannot satisfy an FK on `(id)` alone. All four partition conversions are done,
  and so is the page-read/BRIN index pass (`0040`: `(branch_id, <date> DESC, id
  DESC)` composites for the three registers, `(entry_date_ad DESC, id DESC)` for
  the book ledger, BRIN on the five append-only dates — measured 33×/47×/~800× on
  the branch page, stock page and book ledger at fixture volume). The remaining
  SCALE-3 work is replica routing, PgBouncer and the pre-aggregated read models. The database audit — what already exists, what each remaining
  suggestion would cost, and the trigger that reopens it — is
  [docs/database-optimization-audit-2026-11-17.md](../docs/database-optimization-audit-2026-11-17.md).
  It still owns the partition conversions, read/write split, queued writes and the TLS/CORS/CSP/MFA
  surface.
- **Round 14 — superseded 2026-11-17** (Round 15 Part C) — module-scoped API keys with an
  Administration & Governance UI, audit and revocation:
  [2026-11-16-api-key-management/README.md](2026-11-16-api-key-management/README.md).
  It is blocked on Round 13's Redis state (rate limits, revocation) and MFA.

Round 10 (the accounting core) closed on 2026-11-12 —
[plan](2026-11-12-accounting-core/README.md). Round 9 (the two-sided warranty
registers) closed on 2026-10-29 —
[close note](done/2026-10-29-round-9.md), per-slice notes in
[done/2026-10-29-round-9/](done/2026-10-29-round-9/README.md). Round 8 (the
bug & loop audit) closed on 2026-10-28
([note](done/2026-10-28-round-8.md)).

## Status vocabulary

| Mark | Meaning |
|---|---|
| `[ ]` | not started |
| `[~]` | in progress |
| `[x]` | done (acceptance checked, gates run) |
| `[—]` | parked or deliberately not doing |

A note is done only when its acceptance checklist is ticked, the gates below
have passed, and the commit hash is recorded in the note.

## Working rules

1. One slice per note; one commit per slice, with the ID in the subject
   (`SUM-1: ...`).
2. Update the note as work happens. Tick an acceptance line only after running
   it, not when the code is written.
3. Permanent docs win. Update the code, `docs/` and SESSION_NOTES in the same
   commit; this folder only points at them.
4. Gates before done: `npx tsc --noEmit`, the item's tests, the full `npm test`
   at round close, `check:no-inline-sql`, `check:no-raw-dialogs`, and
   `check:bundle-budget` when client code changed.
5. Do not reopen a parked item without its recorded trigger. Add new evidence
   to [parked.md](parked.md) first.
6. Keep SESSION_NOTES to a short outcome plus a link. If the detail matters,
   it belongs here.

## Session notes (SN-1, done 2026-10-27)

Round 3 executed the split: entries live by year under
[docs/session-notes/](../docs/session-notes/README.md) (2026 for now), newest
first, and the root [SESSION_NOTES.md](../SESSION_NOTES.md) keeps only the
current state plus the index, so it stays short. New entries prepend to the
current year's file; a completed item adds one short entry there, not a
checklist here.

## Active work

**Completed outside a round — the “Sign In sends no request” report (2026-11-17).** The
symptom was reported twice and never explained; it is now reproduced, instrumented
and closed as a browser-session condition, with no app change. Driving the real
login form in the Local Chromium against a temporary server on port 3200 showed
the failing click producing **no mouse events at all** (no `pointerdown`), with
`document.hasFocus()` false during the click and true straight after — the
coordinate click was consumed activating the window — while
`document.visibilityState` stayed `"hidden"` (the panel was not being rendered).
When the page is live, the identical click yields `pointerdown → … → click →
submit` → `POST /api/auth/login` → 200 → token → authenticated view, pressing
**Enter** in the password field does the same, and a wrong password still
reaches the endpoint and shows the inline 401 error. `LoginModal.tsx` is
unchanged. UIX-8's existing synthetic-`submit` test could not see this class, so
it gained *“clicking the submit button issues the sign-in request, with native
validation satisfied”* (button type/enablement/ownership, `checkValidity()`,
click → handler with the native post cancelled); breaking the button to
`type="button"` fails it, restoring it passes. Detail:
[session note](../SESSION_NOTES.md) (the 2026-11-17 entry at the top).

**Completed outside a round — documentation truth (2026-11-16).** The
superseded 2026-11-04 audit was removed (git history keeps it) and
[docs/README.md](../docs/README.md) now states which documents are current and
which are dated evidence. README's four "57 tables" claims were corrected to
**119**, the count in `scripts/schema.sql`, along with the client/server tree
and the removed `cacheRefreshHook` reference; the current audit's "Express 5"
line was corrected to Express 4. A new `tests/docsTruth.guard.test.ts` pins the
stack to the real `package.json` (Express + Vite; no Next.js), the schema table
count and the `client/src/` tree, so the next drift fails a test instead of a
reader.

**Round 11 — Cash receipts, voucher classes and non-trade funding (opened 2026-11-14).**
The plan is
[2026-11-14-cash-receipts-and-funding/README.md](2026-11-14-cash-receipts-and-funding/README.md).
It keeps customer/vendor receipts as allocated documents, makes Cash & Bank
Entry use explicit register-issued classes, and designs owner/third-party
unsecured loans as a Loan Payable control with a lender subledger instead of
AP or supplier records. REC-1 (partial receipt guard + concurrency), REC-2
(allocations and Receive Payment), CASH-1 (explicit cash/bank classes and AR/AP
refusal), NUM-1 (validated invoice/import overrides, fail-closed numbering and
retired-number registry) and the LENDER control foundation are complete. The
Round 11 carry-over for partial receipts was re-audited on 2026-11-17 under
Round 15 Part B and closed: the Receive Payment list is now filtered in SQL
(`openOnly`, so settled pages cannot hide open invoices), the over-allocation
refusal names the excess and the advance lane, and a partly applied receipt no
longer claims the single-invoice header.
LEND-1's lender master, loan register, statement and the dedicated
receipt/repayment/interest-accrual documents (including interest TDS) are
complete, and 2026-11-17 added the correction path they needed: a posted loan
document is reversed through a linked contra journal (migration `0033`) with
the installment schedule and every loan sum rebuilt from what is still posted.
The remaining scope is the round close gates.

**Completed outside a round — rail storage healing, purchase-return scan, profile-switch stock cache (2026-10-31).**
The persisted open-group set is now intersected with the groups the current menu
renders: an id for a removed or role-hidden group is ignored and the mount-time
persist rewrites storage without it; an all-stale set falls back to the active
page's group. A purchase return keeps a single **Device Serial** scan field per
unit — MAC and PON are retrieved from the invoice unit and shown read-only, and
are cleared when a corrected serial stops matching; the sales return keeps all
three editable fields. The shared branch-stock cache is reset on both profile
switch paths (it previously survived a switch, refetched the Super Admin's
branches with the Branch 2 manager's token and showed the 403 "Branch stock
could not be refreshed" banner). The store's reset `generation` makes
`useBranchStock` re-register the new user's branches, and a branch-restricted
switch selects its branch in the same batch so the first bootstrap/shipment
read already carries the authorized scope. The other session-scoped caches reset
on both switch paths too: exchange devices and assignable fixed assets now drop
the previous profile's rows, and each store's reset `generation` makes a mounted
host refetch (an unchanged branch or search term would otherwise keep the empty
list). The asset picker also stops retrying a failed read automatically —
watching the store version had turned one outage into a request storm that
wedged the route-tree test. Pinned by `tests/sidebarGrouping.test.ts` (12),
`tests/returnSerials.capture.test.ts` (12), `tests/branchStock.test.ts` (9),
`tests/exchangeDeviceLoadSchedule.test.ts`, `tests/exchangeDevices.test.ts` and
`tests/availableAssetsReset.test.ts` (2); verified live on the profile switch.
Per-user permission overrides are planned in
[docs/permission-overrides-plan.md](../docs/permission-overrides-plan.md). Full
suite 1694. Detail:
[2026 session note](../docs/session-notes/2026.md#-self-healing-rail-storage-one-scan-purchase-returns-profile-switch-stock-cache-2026-10-31).

**Completed outside a round — menu controls + direct reconcile (2026-10-31).**
The fixed header's single Collapse-current / Expand-current switch duplicated a
click the user could already make on the group header, and made bulk work one
group at a time. It is replaced by **Expand all** / **Collapse all** actions,
with each group header toggling only itself (multi-open). Navigation adds the
destination group and never closes the others; both header actions disable when
there is nothing to do. The open-group set persists in
`inventory_sidebar_open_groups`, including the empty set written by Collapse
all, so an expanded or collapsed rail survives a refresh; the navigation effect
is StrictMode-safe and ignores the post-bootstrap permission refresh, which
otherwise reopened the active group over the saved empty set.
`tests/sidebarGrouping.test.ts` was rewritten for the contract
and now covers the expanded-set and empty-set remounts plus the StrictMode /
malformed-storage fallback. Separately, the unreachable "Direct Stock Reconcile (Admin Direct
Override)" panel and its dead state were deleted: the live confirmation already
branched to the direct handler with no pending request, and now names that mode
with a "No approval request" badge and the confirm "Authorize & Update
Balances". Its adjustment table no longer truncates product names. Pinned by
`tests/physicalAuditDirectReconcile.test.ts` (2 tests, including the pending
approval path). Full suite 1687. Detail:
[2026 session note](../docs/session-notes/2026.md#-expand-all--collapse-all-menu-controls--direct-reconcile-cleanup-2026-10-31).

**Completed outside a round — resizable navigation rail (2026-10-31).** The
sidebar's fixed viewport tiers left long menu labels wrapping onto extra lines,
pushing lower items below the fold. The rail now has a visible right-edge
splitter: drag between 240–520 px (pointer capture keeps the drag alive),
ArrowLeft/ArrowRight step 16 px, Home/End jump to the bounds, and double-click
restores the 288 px default. The width persists in
`inventory_sidebar_width_px`, is applied on mount, and is capped at `85vw` so
the workspace never disappears; the mobile drawer stays an overlay under the
same cap. Labels wrap
rather than ellipsize, so the minimum width stays readable and a wider rail
keeps items on one line. The dead CSS width tiers were removed. Pinned by
`tests/sidebarResize.test.ts` (9 tests); full suite 1682. Detail:
[2026 session note](../docs/session-notes/2026.md#-resizable-navigation-rail--drag-keyboard-persisted-2026-10-31).

**Completed outside a round — all-screen UI/UX sweep (2026-10-30).** The
2026-10-29 audit covered 9 screens and left ~60 unknown; this pass drove all 68
registered routes at 390/1067/1440 px (204 readings) with a temporary CDP
sweep. The first pass flagged 19 readings on 8 screens. Three systemic causes
covered most of them: `PageHeader` truncated titles and descriptions
("Damaged Stock Matri…" at 1440), `StatCard` truncated KPI labels
("TOTAL INVENTORY …" at 1067), and 102 labels sat at `text-[9px]` below the
10 px floor. All three are fixed at the shared component (or the whole source,
for the type floor), plus screen-specific fixes: Fiscal Year Closing step
titles, Consumable Issue's three-column phone grid, the Approvals centre's
missing `<h2>` and mouse-only KPI filters, keyboard-operable permission group
headers, In-App Help nav labels, Company Setup presets/preview, and dashboard
branch/product names. The re-run has zero clipped text, overflow, off-screen or
mouse-only controls and console/HTTP errors. A follow-up raised every click
target to the 24 px floor — enforced on `button` in px so the density tiers
cannot shrink it — and moved the text-link/icon-only actions onto the shared
`linkButton`/`iconButton` tokens: the measured 26/45/60 sub-22 px targets are
0/0/0. Only the phone zoom tier's effective 9.36 px text (12 px source) stays
outside the pass/fail flag. Guarded by
`tests/uiUxSweep20261030.test.ts` (4 tests); report
[docs/ui-ux-audit-2026-10-30.md](../docs/ui-ux-audit-2026-10-30.md). Not
covered there: modals, dark mode, axe/contrast, screen readers, print,
Firefox/Safari. Detail:
[2026 session note](../docs/session-notes/2026.md#-all-screen-uiux-sweep--68-screens-three-widths-2026-10-30).
CI [run 41165375789](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41165375789)
is green on `9571d74` across every step; the audit commit's first attempt
died only at `npm audit`, cleared by scoping the `minimatch` override to
exceljs.

**Completed outside a round — overlay UI/UX sweep (2026-10-31).** The screen
sweep above measured the routed screen behind every modal and drawer, never the
overlay. This pass opened 32 overlays through their real triggers — the four
shell overlays, the shared confirm dialog, the ten record dialogs, both payment
dialogs, the warranty editor, six data-gated dialogs seeded with dummy fixtures
and eight feature dialogs — and probed each at 390/1067/1440 px (96 readings),
adding an unreachable-panel check and recording dialog semantics separately.
Content is clean everywhere: no clipped/ellipsized text, overflow,
off-screen or unreachable controls, mouse-only rows, over-wide tables,
console/HTTP errors or sub-22 px targets. The one finding — the profile
picker's `email • branch` line cut 12 px at 1067 and up to 102 px at 390 — is
fixed by wrapping; pinned by `tests/uiUxOverlaySweep20261031.test.ts`. The 12
record/payment dialogs then got the semantic half: a shared `ModalPanel` with
role, aria-modal, a name, a focus trap, Escape and focus restore (UIX-25),
with `DialogProvider` joining the trap stack; pinned by
`tests/modalPanel.test.ts`. The three data-gated surfaces — the four approval
dialogs, receive verification and opening-stock Add Row — were then seeded and
measured: all six were plain divs too, now on the same panel (UIX-26), with
18/18 follow-up readings clean on semantics and content. The last nine feature
panels — damage adjust/dispose/reverse, audit submit/approve/reject/consolidated
and serial correction — were then migrated too (UIX-27); that pass found and
fixed three content losses (truncated product names, truncated damage
references, a clipped audit table at 390), and 96/96 readings are clean on the
reachable surfaces. The unreachable direct-reconcile panel was deleted in the
follow-up above; the live confirmation now covers both approval and direct
override. Report
[docs/ui-ux-audit-2026-10-31-overlays.md](../docs/ui-ux-audit-2026-10-31-overlays.md);
detail:
[2026 session note](../docs/session-notes/2026.md#-overlay-uiux-sweep--modals-and-drawers-three-widths-2026-10-31).

**Completed outside a round — boot-timing launch retry (2026-10-30).** The
GitHub runner intermittently starts headless Chrome without writing
`DevToolsActivePort`, which reddened the boot-timing gate on runs 214 and
41012427181 while every other step passed. The gate now retries the launch up
to three times, tearing down the failed browser and its profile between
attempts, and still fails with the real cause when all attempts are exhausted.
`tests/bootTimingRetry.test.ts` pins the bounded behavior, and CI
[run 41022526555](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41022526555)
is green on `2246c20` (attempt 1, so the retry added no wait to a healthy
launch; the record commit `29aa797` is green on attempt 1 as well,
[run 41025819587](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41025819587)).
Detail:
[2026 session note](../docs/session-notes/2026.md#-boot-timing-launch-retry-2026-10-30).

**Completed outside a round — sales-form consolidation (2026-10-30).** Stock
Operations' Product Sale to Customer was a second counter-sale form that could
only sell quantity-tracked stock; it is retired (panel, route, tab, menu entry,
type and pins) and Create Sales Invoice is the one sale surface, now carrying
the in-card header, branch-scoped picker, readable payment labels and per-line
seller-warranty capture; the print detail and both CSV exports carry its
coverage and AD/BS expiry. Pinned by `tests/salesFormConsolidation.test.ts`,
and CI [run 41012427181](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41012427181)
is green on `ed6e32c` (attempt 2, after the known Chrome-launch flake). Detail:
[2026 session note](../docs/session-notes/2026.md#-sales-form-consolidation-2026-10-30).

**Completed outside a round — production boot-paint gate (2026-10-29).**
`eff9074` keeps the static splash until the saved screen commits, preloads that
tab and applies the cached bootstrap before paint; CI now runs the
headless-Chrome frame check after the production build, with a seeded demo
database and a 12 s budget. [Run 209](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40881397737)
is green on every step (7m18s). Detail and measurements:
[2026 session note](../docs/session-notes/2026.md#-production-boot-paint-and-its-ci-gate-2026-10-29).
No round was opened and the remaining UI/UX pass is not started.

**Completed outside a round — warranty register CSV export (2026-10-30).**
Both registers export their whole filtered population through the registers'
existing `?all=1` shape (same WHERE and order as the page read, without
`LIMIT/OFFSET`), so a CSV can no longer be one page of rows. Each file carries
coverage start and expiry in AD **and** BS, the state in the register's words,
the signed days remaining (blank for a retired row), the retirement reason and
CN/DN, source, branch and notes. Pinned by `tests/warrantyExport.test.ts`
(12 tests) and the export-query case in `tests/warranty.repo.test.ts`. Detail:
[2026 session note](../docs/session-notes/2026.md#-warranty-register-csv-export-ad-and-bs-2026-10-30).

**Round 9 closed on 2026-10-29** — the two-sided warranty build. Every slice
(`WTY-1`…`WTY-8`) shipped with its own note and commit; the compact record is
[done/2026-10-29-round-9.md](done/2026-10-29-round-9.md) and the per-slice
notes are archived in
[done/2026-10-29-round-9/](done/2026-10-29-round-9/README.md). The round now
stores the supplier's promise and the customer's promise as separate coverage
periods with exact expiry dates, captures them at purchase/asset/issue/sale/
exchange, and shows them in the Suppliers Warranty and Sellers Warranty
registers. Claims/RMA is recorded as the next module with its trigger, not open
work. **No round is active.** Round 8 closed on 2026-10-28 — see
[done/2026-10-28-round-8.md](done/2026-10-28-round-8.md): the bug & loop audit
([docs/bug-loop-audit-2026-10-27.md](../docs/bug-loop-audit-2026-10-27.md))
shipped AUD-1 (`fbcd013`, run 188), AUD-2 (`6df8ed7`, run 189) and AUD-3
(`053a898`, run 190), plus its API follow-up QTY-1 (`f1c1131`, green under run
192 after the `qs` pin `67e7d47` unblocked the audit step), and the close pass
fixed the two hardening items the audit had recorded as unguarded (AUD-4,
AUD-5). The close pass shipped as `7621a20` (CI run 193). No audit item is
open. Round 7 closed on 2026-10-27 — see
[done/2026-10-27-round-7.md](done/2026-10-27-round-7.md): its one item,
[CDR-2](done/2026-10-27-round-7/CDR-2.md) (`46fefb6`, CI run 184), retired the
`customerDevices` bootstrap slice — the last legacy device read, left by CDR-1
for an older bundle — and moved its mapping to a cache-only one
(`CACHE_ONLY_TABLES`), so the operational cache keeps the device mirror while
the slice key answers 410 Gone; the measurement also showed a branch account
that omitted `branchId` read the whole country through the slice, where the
paged route refuses it. The recorded boundaries for a future round are the
`customers` slice (it needs the same mapping split) and the
`/api/bootstrap/local` branch-guard observation. Round 6 closed on 2026-10-27 —
see
[done/2026-10-27-round-6.md](done/2026-10-27-round-6.md): its one item,
[CDR-1](done/2026-10-27-round-6/CDR-1.md) (`c147d99`, CI run 180), retired the
legacy bare-array `GET /api/customer-devices` route that READ-1 had left for an
older bundle — the route, handler and 2,000-row query are gone, a 404 and a
source guard pin the retirement, and the paged/overview/warranty/exchange reads
are untouched. Round 5 closed on 2026-10-27 — see
[done/2026-10-27-round-5.md](done/2026-10-27-round-5.md): the orphaned
bare-array device read is gone
([READ-1](done/2026-10-27-round-5/READ-1.md), `8cdd09b`), the stock-array
lookups are indexed out of the screens
([STOCK-1](done/2026-10-27-round-5/STOCK-1.md), `9009f9c`; ≈ 746× on the
product × branch derivation) and the paged-vs-array question is decided rather
than built ([STOCK-2](done/2026-10-27-round-5/STOCK-2.md), `9fec135`). It was
deliberately a small round: the payload work is finished. Round 4 closed the
same day — see
[done/2026-10-27-round-4.md](done/2026-10-27-round-4.md): `fixed_assets` left
the bootstrap ([ASSET-1](done/2026-10-27-round-4/ASSET-1.md), `3efd446`) and the
Device Exchange picker moved to the paged device read
([EXCH-1](done/2026-10-27-round-4/EXCH-1.md), `3d7afe4`). Round 3 closed the day
before ([done/2026-10-27-round-3.md](done/2026-10-27-round-3.md)). Do not open a
parked item without its recorded trigger; add the new evidence to
[parked.md](parked.md) first.

Recorded watch items — **measured 2026-10-27** before Round 5 planning, and
`inventory_stock` was re-measured and decided at the
[STOCK-2](done/2026-10-27-round-5/STOCK-2.md) gate, so none is an open question
any more. `damageRecords` and the two return
registers are the only uncapped arrays left; at the recorded volumes the return
registers are ≈ 203 kB gzip combined at 1× (and both already read paged
endpoints — the arrays are only the degraded fallback), damage is ≤ 653 kB gzip
at 1× even if every stock operation were a damage row, and a branch's stock
array is catalog-sized. **No payload item is justified today.**

`inventory_stock` **NO-GO today, GO-on-evidence** (STOCK-2, 2026-10-27): the
re-measured row width is ≈ 143–164 B raw / 15–27 B gzip, so a global ALL-scope
read is 0.59–1.03 MiB gzip at 2,000 × 20 — straddling the ≈ 1 MiB trigger — and
the deployment's real catalogue and branch count are not recorded anywhere in
this repo (the demo DB holds 14 products / 2 branches). Open the round when
**either** a real login's `stock` slice measures ≥ 1 MiB gzip in the target
deployment, **or** an ALL-scope catalogue well past ~5,000 products makes the
client-side filter the bottleneck again. The migration is ASSET-1-sized: 32
screens plus a new stock overview endpoint, because the shell badge and the
notification center need a company-wide count that no page can answer. Full
numbers and limits in
[docs/session-notes/2026.md](../docs/session-notes/2026.md#-round-5-watch-list-measured--none-of-the-remaining-arrays-earns-an-item-2026-10-27).
