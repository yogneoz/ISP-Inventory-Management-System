# SESSION NOTES — for next session

_Date: 2026-11-03 · Branch: main · Tests: 1899/1899 green with a DB (all run in CI too; the two unconditional skips are Windows-only real-signal checks that Linux CI runs — no DB-dependent skips since the PG service container landed)_

> **Trial-balance account drill-down + running balance (2026-11-03).** Individual account rows in the trial balance now open the same posted-line panel as groups, with a running balance. `GET /api/accounting/statements/account-lines?accountId=…` returns every POSTED line on that account through the as-of date, split into opening lines (before `from`) and period lines (`from`..`to`), plus the account's six trial-balance figures and independent totals over every matching line. The six figures use the statement's net-per-account rule, so the footer shows `Ties to trial balance account` or the differences. The running balance is debit-positive (`debit − credit`): opening lines run from zero to the opening balance, and the period section starts with an `Opening balance b/f` row and ends at the closing balance. It is computed before the per-window 500-line page, so a truncated page keeps correct values and the panel says the run continues. An unknown account is 404, `gl-view` and branch scope are re-applied, and a branch account cannot widen to `ALL`. `tests/accountingStatements.api.test.ts` pins the six-figure tie-out, the opening→period running values, a credit balance running negative, the default fiscal window, branch isolation and permissions; the mounted trial-balance test opens an account row and pins the request scope, the running-balance column and the b/f row. Detail:
> [2026.md](docs/session-notes/2026.md#-trial-balance-account-drill-down--running-balance-2026-11-03).
>
> **Trial-balance group drill-down (2026-11-03).** The trial balance's group and sub-group rows are now buttons too. `GET /api/accounting/statements/group-lines?statement=TRIAL_BALANCE` returns the POSTED lines in the group's subtree through the as-of date, split into opening lines (before `from`) and period lines (`from`..`to`). Opening and closing totals are netted per account exactly like the trial-balance columns, while period debit and credit are posted turnover; the panel compares all six figures with the subtotal that opened it and shows `Ties to trial balance subtotal` or the differences. The 500-line page applies per window, so a long opening history cannot hide the period lines. Unknown groups are 404, `gl-view` and branch scope are re-applied, and a branch account cannot widen to `ALL`. `tests/accountingStatements.api.test.ts` pins the opening/period split, the six-figure tie-out, netting of multiple opening lines, subtree inclusion, per-window paging, branch isolation and permissions; the mounted trial-balance test opens the panel and pins the request scope and both sections. Detail:
> [2026.md](docs/session-notes/2026.md#-trial-balance-group-drill-down-2026-11-03).
>
> **Statement group drill-down (2026-11-03).** A group subtotal on the P&L or balance sheet was a dead end: the reader could see the figure but not the POSTED lines that made it. Group headings are now buttons, and `GET /api/accounting/statements/group-lines` returns the lines on the group **and every sub-group** for the same statement mode, branch and window. The response carries each line's natural-side amount plus totals aggregated over every matching line before the 500-line page, so the total does not shrink with `limit`; the panel compares that total with the subtotal it was opened from and shows `Ties to statement subtotal` or the difference. An unknown group is 404, a group from the other statement side is 400, a balance sheet rejects `from`, and branch scope/`gl-view` are re-applied. `tests/accountingStatements.api.test.ts` proves the parent includes its sub-group and ties to the statement figure on both statements, plus branch/window/limit and refusal cases; the mounted P&L and balance-sheet tests open the panel and pin the request scope and tie-out. Detail:
> [2026.md](docs/session-notes/2026.md#-statement-group-drill-down-2026-11-03).
>
> **Nested statements + PDFs (2026-11-03).** The group → sub-group chart now reaches profit and loss and the balance sheet, not just the trial balance. `StatementGroupBlock` carries `groupId`, `parentGroupId`, `children` and a rolled-up `amount`; `sectionize` builds that tree from the chart's group list for all three statements, so a parent subtotal equals its direct accounts plus its children, and the section total is the sum of the same leaves. The printed P&L and balance sheet recurse through those nodes and print each group's subtotal. `tests/accountingStatements.api.test.ts` posts a two-level hierarchy on both sides through the real routes and pins parent/child subtotals, section totals and a still-balanced balance sheet; `tests/accountingWorkspaceRoute.test.ts` pins the indented sub-group row; `tests/pdfPrint.api.test.ts` pins the recursive PDF rows.
>
> **Chart hierarchy + trial-balance subtotals (2026-11-03).** Account groups now have one optional parent (`gl_account_groups.parent_id`), so the chart is group → sub-group → ledger. A sub-group inherits its parent's account type, statement group and normal balance, and a third level is refused; the Chart & Defaults forms let a maintainer choose a parent, show sub-groups under their parent in the account form, and only an empty group (no accounts, no children) may move or be deleted. The trial-balance response carries a `groups` tree where each node holds its direct accounts, its children and a subtotal over both, built from the same posted balances as the flat `accounts` rows; the register renders group and sub-group subtotal rows with their accounts, and the totals still tie to the flat columns. `tests/accounting.api.test.ts` posts real journals and pins the parent/sub-group roll-up, inherited mapping, third-level refusal and structure guards; `tests/accountingWorkspaceRoute.test.ts` mounts the screen and pins the rendered subtotal rows plus create/edit guards.
>
> **Chart maintenance (2026-11-03).** Chart & Defaults is no longer read-only. Under `gl-manage` it now adds groups and accounts, edits a group's label/order and an account's name/description/group/posting role, retires an account (which clears its posting role), and deletes only what has no history: an account with posted lines is refused with 409 and must be deactivated, an account holding a posting role must have it cleared first, and a group with any account — active or retired — is refused. Group code/type/statement mapping and an account's code/control nature are immutable after creation; an account's group can only move before its first posting, so a reorganisation cannot silently reclassify a past statement. Every mutation is audited and routed through `gl-manage`. `DELETE /api/accounting/groups/:id`, `DELETE /api/accounting/accounts/:id` and `PATCH /api/accounting/groups/:id` are new alongside the existing POST/PATCH; the register lists retired accounts (`includeInactive=1`) so they can be reactivated. `tests/accounting.api.test.ts` drives the routes and their refusals; `tests/accountingWorkspaceRoute.test.ts` mounts the real screen and pins create/edit/retire/delete plus the no-`gl-manage` read-only view.
>
> **Accounting registers (2026-11-03).** The Accounting Workspace tabs are now separate registers under Finance & Accounting, each with its own route, sidebar entry and the same `gl-view` gate: Trial Balance (`/finance/accounting`), Profit & Loss (`/finance/accounting/profit-loss`), Balance Sheet (`/balance-sheet`), Cash & Bank Book (`/cash-book`), AR / AP Aging (`/aging`) and Chart & Defaults (`/chart`). The branch/as-of selector and endpoint reads are unchanged; only the shell moved from one tabbed screen to six registers, each with its own activation key and refetch. `tests/accountingWorkspaceRoute.test.ts` mounts every register route and pins its figures, the AR/AP switch, scope refetch and the permission refusal.

> **AR / AP aging (2026-11-02).** The plan's collections view now exists as its own register at `/finance/accounting/aging`, not a tab inside the workspace. `GET /api/accounting/aging?type=AR|AP` reads only posted `gl_subledger_entries` on the chart's `AR_CONTROL` / `AP_CONTROL` account, joins an invoice when the journal has one for its number and due date, applies credits FIFO per party, and buckets the remaining open charges by days past due (current, 1–30, 31–60, 61–90, 90+). Unapplied credits stay visible as their own rows and column, so they cannot silently fall out of a bucket. The response carries the control account's posted balance and the difference; the report's `total` is gross open items less credits and therefore equals that control balance for the same branch and date. `branchId` omitted (or `ALL`) consolidates; a branch account can only read its assigned branches. Purchase invoices store the vendor-bill date in `due_date_ad`, so a value not later than the invoice date is treated as missing and the invoice date is used; no payment terms exist to add today. `tests/accountingAging.api.test.ts` (5 tests) posts real AR/AP journals and pins bucket placement, the as-of cut, consolidated = sum of branches, unmatched credits and the control tie; `tests/accountingWorkspaceRoute.test.ts` mounts the real app and pins the tab's AR/AP figures and scope. Detail:
> [2026.md](docs/session-notes/2026.md#-ar--ap-aging-2026-11-02).

> **Opening balances + year-end close (2026-11-02).** The accounting plan's foundation slices are in. `POST /api/accounting/opening-balances` accepts one branch's balanced trial balance and posts it through `postJournal` into the earliest open monthly period; a per-branch advisory lock plus a partial unique index make a second or concurrent post a 409 with nothing written, and an unbalanced set, a control line with no party or one with the wrong subledger type is refused the same way. `POST /api/fiscal-years/:id/close` now really closes the books: in one transaction it posts each branch's cumulative income/expense residue at the fiscal-year end to the chart's `RETAINED_EARNINGS` default, then marks the year closed, so the trial balance stays balanced and the balance sheet reports the same totals with current earnings at zero. A year-end close already posted is refused even after a real reopen, so a second close cannot double-post. `tests/accountingOpeningClosing.api.test.ts` (5 tests) drives the real routes and pins the refusals. Detail:
> [2026.md](docs/session-notes/2026.md#-opening-balances--year-end-close-2026-11-02).

> **PDF reporting (2026-11-02).** The plan's named PDF deliverable now exists. One server-side `pdfmake` service owns the layout, company header, document number/date block, money/table formatting and the Noto Sans + Noto Sans Devanagari registration; the font files come from the `@fontsource` packages, so a clean install reproduces them, and a missing file throws `PDF font missing: …` at boot instead of silently substituting Roboto. Mixed-script text is split into per-script runs, and a Devanagari invoice test proves a real embedded `NotoSansDevanagari` subset (`FontFile2` + `ToUnicode`), not dropped glyphs. Print routes keep the existing gates and branch scope: sales invoice (`sales-invoice-create`), purchase bill (`inv-create`), the three statements (`gl-view`) and payroll payslip (`gl-view`); a record outside the caller's branch is refused by the registry guard and again in the handler. `tests/pdfPrint.api.test.ts` (7 tests) drives every route over HTTP and pins the refusals. Detail:
> [2026.md](docs/session-notes/2026.md#-pdf-reporting-2026-11-02).

> **Daily cash close (2026-11-02).** The branch cash position now has a counted close. `daily_cash_closes` stores one row per branch and business day (opening, cash in/out, expected closing, counted closing, variance, status) with a database check that variance equals counted − expected and a unique branch+date key. `GET /api/accounting/cash-close` and `/consolidated` derive every figure from posted CASH/BANK journal lines — the same rows the cash book and balance sheet read — and stay inside the caller's branch scope; `POST /api/accounting/cash-close` takes a branch+date lock, recomputes expected closing, refuses an already-closed day, and `/:id/reopen` flips the same row to OPEN while the live view reports no current count. `/finance/cash-close` is registered under `gl-view` and renders today's cash in/out, per-branch closing cash, counted cash, variance and the company total, with `gl-post` gating close/reopen. `tests/dailyCashClose.api.test.ts` drives the real routes and ties expected closing to the cash book and balance sheet; the screen was also exercised live. Detail:
> [2026.md](docs/session-notes/2026.md#-daily-cash-close-2026-11-02).

> **Payroll → ledger (2026-11-02).** Payroll was the last operational domain outside the ledger. The employee master and the posted payroll run now sit on the generic subledger layer, not a parallel balance store: a run debits gross salary expense and credits salary payable, TDS payable, SSF payable, employee advances and employee loans, each control line carrying an EMPLOYEE subledger party, and paying the run debits salary payable per employee against the till/bank. `GET /api/employees/:id/ledger` reads those same subledger rows, so TDS and SSF control accounts reconcile per employee. A closed period, a duplicate branch+period run or an employee already posted for the month is refused before anything is written; the run row, its lines, journal, subledger rows and audit row commit or roll back together. Detail:
> [2026.md](docs/session-notes/2026.md#-payroll--ledger-2026-11-02).

> **Fixed assets → ledger (2026-11-02).** Capitalisation, depreciation and disposal now post through the chart's posting roles, so the register is no longer the last large value holder outside the ledger. A directly capitalised asset debits Fixed Assets at Cost and credits the cash/bank account named by `paymentMethod` (or AP for supplier credit); an asset capitalised from a purchase bill reclassifies the cost the bill already put into inventory, so the payable is never raised twice. `POST /api/fixed-assets/depreciation {branchId, periodKey}` posts each asset's month once (journal keyed `<assetId>:<periodKey>`, cumulative-to-date minus what was already posted), holds a branch+period advisory lock, and refuses a duplicate run with 409; assets with no posted cost are reported instead of silently depreciated. Disposing an asset clears its posted cost and accumulated depreciation, brings in the proceeds and recognises the gain or loss, idempotently for the status change and exactly once for the journal. `tests/fixedAssetAccounting.api.test.ts` drives the real asset, purchase-invoice, depreciation and status routes and ties the balance-sheet fixed-asset figure to cost less accumulated depreciation. Detail:
> [2026.md](docs/session-notes/2026.md#-fixed-assets--ledger-2026-11-02).

> **Accounting workspace on screen (2026-11-02).** The ledger now has a client face: `/finance/accounting` renders the trial balance, P&L, balance sheet and cash/bank book from the existing statement endpoints, with a branch selector and as-of date, plus a readable chart of accounts, posting defaults and control-account reconciliation status. The tab is registered in the tab registry, sidebar and permission matrix under `gl-view`; a role without it is refused in-screen (and redirected by the route guard) instead of seeing an empty ledger. The branch selector offers only the account's scoped branches, matching the server's branch contract. `tests/accountingWorkspaceRoute.test.ts` mounts the real App and pins the endpoint figures, the branch/date refetch and the permission refusal; the workspace was also opened live as the demo accountant against the running PostgreSQL dev server. Detail:
> [2026.md](docs/session-notes/2026.md#-accounting-workspace-on-screen-2026-11-02).

> **Returns, transfers and CPE → ledger (2026-11-02).** Sales and purchase returns now post the mirror of the document they reverse — AR / revenue / output VAT and inventory against COGS at the original issue cost for sales, AP against inventory + input VAT for purchases — and their cancellations post a linked contra journal. Inter-branch dispatch credits the source's inventory against due-from head office and receipt debits the destination's inventory against due-to head office at the stamped issue cost, so each branch balances and the company roll-up nets to zero. CPE deployment and collection move value between inventory and Deployed CPE Assets at the same cost. Missing defaults and closed periods refuse the document; stock, journal, subledger and audit rows commit or roll back together. `tests/returnsTransferCpeAccounting.api.test.ts` drives the real return, shipment and fixed-asset routes and ties inventory control to the branch balance sheet. Detail:
> [2026.md](docs/session-notes/2026.md#-returns-transfers-and-cpe--ledger-2026-11-02).

> **Stock operations → ledger (2026-11-02).** Manual adjustments, damages, pullouts, consumable issues, CPE exchanges and physical-audit counts now post stock value inside their existing transaction. Value is the branch stock row's moving weighted average, never the product's standard cost; a decrease debits the `STOCK_EXPENSE` default and credits inventory, and an increase reverses that. A missing default or a closed period refuses the whole document, so quantity cannot move without its journal. Damage/consumable/pullout reversals post a linked contra journal and leave the original rows for the trail. Direct `PATCH /api/stock/:id` corrections now lock the row and post their signed difference at weighted average; approving a pending physical-audit reconciliation posts the same difference, and a pullout receipt restores the dispatch value at the destination instead of adding units with no journal. `tests/stockAccounting.api.test.ts` drives the real stock routes and ties the inventory account to the branch balance sheet after every movement. Detail:
> [2026.md](docs/session-notes/2026.md#-stock-operations--ledger-2026-11-02).

> **Payments → ledger + cash book (2026-11-02).** Customer receipts and supplier payments now post their own balanced journal inside the existing write transaction: debit cash/bank and credit AR (customer subledger) for receipts; debit AP (supplier subledger) and credit cash/bank for payments. `CASH` settles through the till and every other method through the bank, reusing the document's existing `paymentMethod` convention. The payment row, invoice balance, subledger settlement, audit row and journal commit or roll back together; a missing AR/AP/cash/bank posting default is named and refuses the payment. Reversals post a linked contra journal. `GET /api/accounting/cash-book` derives opening, receipts, payments and closing per branch from the same posted lines, and its closing total equals the balance sheet's cash and bank figure for the branch and date. Detail:
> [2026.md](docs/session-notes/2026.md#-payments--ledger--cash-book-2026-11-02).

> **Statutory statements from the ledger (2026-11-02).** `GET /api/accounting/statements/trial-balance|profit-and-loss|balance-sheet` now read the posted journal lines instead of the operational registers. Trial balance shows opening/turnover/closing with debit = credit and a control-account agreement block as of the same date; P&L is period-based and nested by statement group → account group; the balance sheet closes with current earnings and reports due to/from head office per branch, rolling up to `ALL`. The existing management view is untouched. Detail:
> [2026.md](docs/session-notes/2026.md#-statutory-statements-from-the-ledger-2026-11-02).

> **Invoice → ledger (2026-11-02).** Sales and purchase invoices now post their own balanced journal inside the existing transaction: sales debit AR + COGS and credit revenue + output VAT + inventory at the deducted row's moving weighted-average cost; purchases debit inventory + input VAT and credit AP. The party subledger entries and the create audit row commit with the document. Voiding/deleting posts a linked contra journal, so control balances return to zero without deleting the original rows. A missing posting default, a closed period or a rejected journal rolls the whole document back. A fresh database/boot seeds the default chart; a failed invoice leaves no invoice, stock, journal or audit row. Detail:
> [2026.md](docs/session-notes/2026.md#-invoice--ledger-posting-2026-11-02).

> **URL routing (phase 1 + 2, 2026-11-01).** Every sidebar screen owns a canonical path, and record screens own a child path: sales/purchase invoice details, PO detail/edit, sales/purchase return details, shipment and transfer-receipt manifests, customer-directory details, user create/edit, and fixed-asset create/detail. Legacy `?tab=` links redirect to the path; Back/Forward and refresh restore the open record; the normal permission guard still decides whether the screen may render. Sales/purchase returns, shipment manifests, transfer receipts and customer records each have a mounted deep-link test. Detail:
> [2026.md](docs/session-notes/2026.md#-app-wide-url-routing--phase-2-record-paths-2026-11-01).

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
> 320 kB total stays at 291.2 kB. **Sidebar restructure (2026-10-30):**
> `5761540` regrouped the rail into eight domain groups with Registers/Forms
> sections and a single-open accordion, retiring Branch Operations; seven new
> render tests pin it, and CI [run 214](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/40997098757)
> is green on attempt 2 after the first attempt's headless-Chrome launch flake
> (steps 1–14, including all 1598 tests, had already passed). Detail:
> [2026.md](docs/session-notes/2026.md#-sidebar-restructure-and-green-ci-run-214-2026-10-30).
> **Sales-form consolidation (2026-10-30):** Stock Operations' **Product Sale
> to Customer** is retired (panel, route, tab, menu entry, type and pins);
> **Create Sales Invoice** is the only counter-sale form, now with its own
> in-card header, branch-scoped picker, readable payment labels and per-line
> seller-warranty capture. The register and detail show the promise, and the
> printable invoice + CSV export carry its coverage and AD/BS expiry. Proven by
> the sales-form tests, and CI [run 41012427181](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41012427181)
> is green on attempt 2 for `ed6e32c` (attempt 1 met the known headless-Chrome
> launch flake; typecheck and all 1603 tests had passed). Detail:
> [2026.md](docs/session-notes/2026.md#-sales-form-consolidation-2026-10-30).
> **Boot-timing launch retry (2026-10-30):** a headless-Chrome launch that never
> writes `DevToolsActivePort` — the flake that reddened runs 214 and
> 41012427181 — is now retried up to three times with a fresh browser profile
> before the gate fails; `tests/bootTimingRetry.test.ts` pins the bounded retry
> and its final error. CI [run 41022526555](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41022526555)
> is green on attempt 1 for `2246c20`, so the retry added no wait to a healthy
> launch. The record commit `29aa797` is green on attempt 1 too
> ([run 41025819587](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41025819587)).
> Detail:
> [2026.md](docs/session-notes/2026.md#-boot-timing-launch-retry-2026-10-30).
> **Audit-module vocabulary (2026-10-30):** the `audit_logs.module` constraint
> was missing `SALES` and `PERMISSIONS`, so all eight sales-invoice / return /
> customer-payment events and the permission-matrix save wrote audit rows
> PostgreSQL rejected — console-only on the fire-and-forget path, action-aborting
> on a transactional caller. Both modules are now allowed, the client
> `AuditLog['module']` union is exactly the constraint's list, and
> `tests/auditModuleVocabulary.guard.test.ts` (5 tests) parses the constraint and
> fails when a caller writes a module it does not accept. The local database was
> migrated in place; rows lost to the rejection were never stored. Detail:
> [2026.md](docs/session-notes/2026.md#-audit-module-vocabulary-fix-2026-10-30).
> **Profile-switch caches + per-user permission plan (2026-10-31):** both switch
> paths reset all three session-scoped caches — branch stock, exchange devices
> and assignable fixed assets — and each store's reset `generation` makes a
> mounted host refetch for the new profile. The asset hook no longer retries a
> failed read forever (the regression that wedged the route-tree test for
> 140 s); a failure now waits for an explicit refresh. Multi-branch assignment
> is verified: an assigned secondary branch passes the bootstrap gate, an
> unassigned one is still 403, and a switch keeps a valid secondary selection.
> Individual "extra permissions" are designed in
> [docs/permission-overrides-plan.md](docs/permission-overrides-plan.md); phase 1
> shipped the next day (below). Detail:
> [2026.md](docs/session-notes/2026.md#-self-healing-rail-storage-one-scan-purchase-returns-profile-switch-stock-cache-2026-10-31).
> **Per-user permission overrides — phase 1 (2026-11-01):** the role matrix now
> has an exception layer. `user_permission_overrides` stores one grant or deny
> per (user, operation) with a required reason and optional expiry (the 39th
> table); a single resolver applies Super Admin → user row → role matrix, and
> every enforcement point that used to read `permissionMatrix[op][role]` now
> goes through it — `requirePermissionAny`, the bootstrap audit-log gate, the
> approval-cancel check and the shipment receiving-lane check. `GET
> /api/permissions/me` returns the signed-in user's effective operations;
> `GET`/`PUT /api/users/:id/permission-overrides` are **Super Admin only** and
> replace one user's rows atomically after validating the catalogue, effect,
> non-empty reason, future-only expiry and rejecting unknown keys and Super
> Admin targets. Updates are audited as `UPDATE_USER_PERMISSIONS`, publish to
> the authz map only after COMMIT, and bump `permissionsVersion`. Pinned by 21
> tests; suite **1762/1762** (1760 pass, 0 fail, 2 Windows-only skips). There was
> **no screen yet** in that slice — phase 2 (below) added the `Settings → User
> Permissions` screen and the client effective-set integration (§10–§11 of the
> plan). Detail:
> [2026.md](docs/session-notes/2026.md#-per-user-permission-overrides--phase-1-table-resolver-endpoints-2026-11-01).
> **User Permissions screen + client effective set (2026-11-01):** the
> Super-Admin-only **Settings → User Permissions** screen edits one person's
> grants and denies (tri-state Inherit/Grant/Deny, the role's base answer always
> visible, required reason, optional AD/BS expiry, effective-operation preview,
> differences filter, confirmed clear-all, read-only Super Admin target, branch
> warning). App now reads `/api/permissions/me` on sign-in, profile switch,
> session restore and matrix republish; `isOperationAllowed` prefers that set
> only for the role it was resolved for, and it is cleared at every session
> boundary. Saved exceptions are enforced immediately and reach an open user
> tab live through the `PERMISSIONS` broadcast (matrix slice, then `/me`).
> Pinned by 15
> tests; suite **1762/1762** (1760 pass, 0 fail, 2 Windows-only skips), route
> count 69, screen count 71. Detail:
> [2026.md](docs/session-notes/2026.md#-per-user-permissions--phase-2-the-screen-and-the-client-effective-set-2026-11-01).
> **Reusable permission sets (2026-11-01, phase 2):** `permission_sets`,
> `permission_set_grants` and `permission_set_members` add named grant bundles
> shared by several users. Resolution is now SUPER_ADMIN → explicit user
> override → any assigned set grant → the role matrix; a per-user deny still
> wins. Super-Admin-only `GET/POST/PUT/DELETE /api/permission-sets` and
> `PUT /api/users/:id/permission-sets` replace definitions/memberships
> atomically, re-read and publish the derived user→operation map only after
> COMMIT, audit `CREATE_PERMISSION_SET` / `UPDATE_PERMISSION_SET` /
> `DELETE_PERMISSION_SET` / `ASSIGN_USER_PERMISSION_SETS`, and bump the client
> permission version. The User Permissions screen gained **User exceptions /
> Permission sets** tabs; an “Assigned permission sets” card assigns bundles
> beside the individual exceptions, and the effective preview plus a
> “Granted by a set” badge include set grants. Sets carry grants only and never
> change role or branch scope. Pinned by 17 tests; suite **1762/1762** (1760
> pass, 0 fail, 2 Windows-only skips), route count 69, screen count 71. Detail:
> [2026.md](docs/session-notes/2026.md#-reusable-permission-sets--phase-2-named-grant-bundles-2026-11-01).
> **Search-result panels (2026-10-30):** every directory picker (customer,
> location, sales-invoice) opens a list wider than its field — 320–480 px,
> clamped to the viewport with 8 px gutters and shifted left near the right edge —
> and rows wrap instead of ellipsizing, so name, code, phone, address and the
> invoice's date/total/branch are all visible; the two forms with a bespoke
> supplier dropdown wrap the vendor name the same way. No font shrinking; the
> field's own layout is untouched. `tests/searchPickerPanel.test.ts` (6 tests)
> pins the width policy and the non-truncating rows. Detail:
> [2026.md](docs/session-notes/2026.md#-search-result-panels-show-the-whole-row-2026-10-30).
> **Return serial capture + warranty retirement (2026-10-30):** both returns
> (purchase DN and sales CN) now use the purchase bill's per-unit identity
> pattern instead of one comma-separated box: quantity-sized Device / MAC / PON
> rows, and Enter — a barcode reader's terminator — walks the identity fields
> and then the next unit. The device serial resolves against the original
> invoice's units, so MAC/PON fill in without re-scanning;
> `client/src/utils/returnSerials.ts` owns the slot arithmetic and
> `tests/returnSerials.capture.test.ts` (11 tests) pins it. Server-side,
> `returnSerials.service.ts` refuses a serial that is missing, belongs to
> another product, is not on the original invoice, sits at another branch, or is
> in the wrong state (CUSTOMER_ASSIGNED for a sales return, IN_STOCK for a
> purchase return), hydrates MAC/PON from `serial_log`, and both flips are now
> status-guarded with rowCount checked, so a unit that moved on rolls the
> transaction back instead of being overwritten. Warranty coverage is
> **retained, not deleted**: the returned unit's SELLER (sales return) or VENDOR
> (purchase return) row is retired with `retired_reason` and the note number,
> only for the units actually returned (a partial purchase return no longer
> retires the whole bill), and the registers gain a **Returned (retired)**
> filter that shows the reason and document while the active KPIs stay
> active-only. Detail:
> [2026.md](docs/session-notes/2026.md#-returns-per-unit-serial-capture-2026-10-30).
> **Warranty register CSV export (2026-10-30):** both registers now export
> through the registers' existing `all=1` shape — the unpaged builder is the
> page read with its LIMIT/OFFSET removed, so the file is the filtered
> population, not the visible page; a failed full read aborts instead of writing
> a partial file. Every row carries coverage start and expiry in **AD and BS**,
> the state in the register's wording, the signed days remaining (blank for a
> retired row), the retirement reason with its CN/DN, source, branch and the
> correction note; a BS date the calendar cannot derive shows the app's
> "BS not seeded" marker rather than the AD value. Proven by
> `tests/warrantyExport.test.ts` (12 tests) and the export-query case in
> `tests/warranty.repo.test.ts`. Detail:
> [2026.md](docs/session-notes/2026.md#-warranty-register-csv-export-ad-and-bs-2026-10-30).
> **All-screen UI/UX sweep (2026-10-30):** the previous audit's ~60 uncovered
> screens are covered — all 68 registered routes at 390/1067/1440 px, 204
> readings. Fixed the three systemic causes (PageHeader title/description
> truncation, StatCard KPI-label truncation, 102 labels below the 10 px floor)
> plus the Fiscal Year Closing steps, Consumable Issue's phone grid, the
> Approvals centre's missing `<h2>`/mouse-only KPI filters, permission group
> headers, In-App Help nav, Company Setup presets/preview and dashboard
> branch/product names. The re-run has zero clipped text, overflow, off-screen
> or mouse-only controls and console/HTTP errors. Every click target now meets
> the 24 px floor — `button` gets a px-based min size (a rem floor renders
> 18.7 px at the 78% tier) and link/icon actions use the shared
> `linkButton`/`iconButton` tokens — taking the measured 26/45/60 sub-22 px
> targets to 0/0/0. Only the phone tier's effective 9.36 px text (12 px source)
> is left outside the pass/fail flag. Report
> [docs/ui-ux-audit-2026-10-30.md](docs/ui-ux-audit-2026-10-30.md), pinned by
> `tests/uiUxSweep20261030.test.ts`. CI
> [run 41165375789](https://github.com/yogneoz/ISP-Inventory-Management-System/actions/runs/41165375789)
> is green on `9571d74`; the audit commit's first attempt failed only at
> `npm audit --omit=dev` (a new minimatch advisory via exceljs → archiver →
> glob), cleared by scoping the `minimatch@^11.0.1` override to exceljs.
> Dark mode, axe/contrast, screen readers and non-Chromium browsers remain
> out of scope.
> **Overlay UI/UX sweep (2026-10-31):** modals and drawers are covered — 32
> surfaces (shell search/notifications/scanner/profile, the shared confirm, ten
> record dialogs, both payment dialogs, the warranty editor, six data-gated
> dialogs seeded with dummy fixtures and eight feature dialogs) at
> 390/1067/1440 px, 96 readings. Content is clean at every width; the profile
> picker's clipped `email • branch` line, the truncated audit/product names and
> the clipped 390 px audit table are fixed and pinned by
> `tests/uiUxOverlaySweep20261031.test.ts`. All 33 panels across 18 files now
> share a labelled, focus-trapped `ModalPanel` (UIX-25 to UIX-27, pinned by
> `tests/modalPanel.test.ts`, with `DialogProvider` on the same trap stack). The
> direct-reconcile panel remains unreachable (no control opens it).
> Report [docs/ui-ux-audit-2026-10-31-overlays.md](docs/ui-ux-audit-2026-10-31-overlays.md).
> **No round is active.** The payload work
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
