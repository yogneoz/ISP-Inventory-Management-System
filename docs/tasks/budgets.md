# Budgets and budget-vs-actual — task note

**Status:** Done — branch-wise OPEX cost-centre allocation, department preview, lock/audit and unallocated actuals landed
**Created:** 2026-11-08
**Updated:** 2026-11-10

## Goal

Department/branch budgets per account and period, with a variance panel on the
Finance Dashboard and a budget-vs-actual report that reconciles to posted
journals.

## Current state

- `gl_budgets` (one header per fiscal year + branch), `gl_budget_lines`
  (period key + profit-and-loss account + amount, unique per dimension) and
  `gl_budget_versions` (immutable prior-line snapshots) exist in
  `scripts/schema.sql` and on the live database (87 tables after the bank
  reconciliation tables were added).
- Budgets are account-level and monthly. Cost-centre/department reporting is a
  derived view over the branch allocation profile; it never rewrites budget or
  journal lines.
- Five global active demo cost centres exist for the department structure:
  `CC-01-EXEC` Executive Management, `CC-02-FIN` Finance & Administration,
  `CC-03-OPS` Operations & Network Engineering, `CC-04-COMM` Commercial &
  Business Development and `CC-05-CX` Customer Experience & Support. They are
  `is_demo` journal dimensions. The demo seed tags `5000` and `6400` to
  Operations and `6100` to Finance & Administration; the other expense accounts
  remain untagged on purpose.
- `GET /api/accounting/budgets` returns one branch's lines and editor pick
  lists; `PUT /api/accounting/budgets` replaces open-period lines in one
  transaction and writes an audit row.
- `GET /api/accounting/budgets/variance` returns budget, actual, variance and
  variance percentage per account plus totals. Actuals come from the same
  `gl_journal_lines` joined to `POSTED` `gl_journals` that the P&L reads.
- `GET /api/accounting/budgets/variance/lines` returns the POSTED journal lines
  behind one variance account, using the same fiscal year, branch and window
  scope as the variance row. `amount` is natural-side (expense debit − credit,
  income credit − debit); totals and the `tieOut` are computed before the page
  limit, and `reconciled` is true only when the line actual equals the displayed
  variance actual.
- `GET /api/accounting/budgets/variance/utilisation` groups the same budget and
  POSTED-actual predicates by branch and returns per-branch budget, actual,
  variance, variance percentage and utilisation percentage, plus a card-sum
  tie-out against the variance totals. Department cards remain deferred.
- `GET /api/accounting/budgets/variance/alerts` is the main-dashboard
  overspend feed. It reuses the variance builder, keeps only budgeted expense
  accounts with POSTED actual above budget, and returns over-by/over-percent
  plus utilisation. Totals and the source tie-out cover every matching alert
  before the dashboard's five-row limit; `truncated`/`limit` say when the card
  list is shorter than the total. `gl-view` and branch scope apply.
- `POST /api/accounting/budgets/copy` copies the previous budgeted fiscal year
  for the same branch, mapping periods by ordinal month, reporting the mapping,
  unmapped months and any source account no longer in the P&L chart.
- `POST /api/accounting/budgets/import` accepts `account_code,period_key,amount`
  CSV all-or-nothing and returns every bad row (`row`, `message`); it writes
  nothing when any row is refused. `GET /api/accounting/budgets/export` emits
  that exact column set, so an exported budget round-trips.
- A copy/import is idempotent: when the target already holds the mapped lines,
  it returns `UNCHANGED` without writing. A different existing budget is
  refused unless `replace:true`; then open-period lines are replaced and the
  response says `REPLACED`.
- `POST /api/accounting/budgets/lock` sets or clears an explicit lock on one
  branch/fiscal-year header. The lock records `locked_at`/`locked_by` and is
  audited as `LOCK_GL_BUDGET`/`UNLOCK_GL_BUDGET`. While locked, save, copy,
  import and replace all refuse with 409; reads, drill-downs and CSV export
  remain available.
- `GET /api/accounting/budgets/allocation` returns the branch's profile, active
  candidate centres, expense-group budgets and effective rules, or `MISSING`
  when none is configured. `PUT /api/accounting/budgets/allocation` replaces
  the complete rule set in one transaction, requires an exact 100.00% per
  group, rejects a foreign-branch or parent-plus-child centre, refuses a locked
  budget and audits the save. There is no allocation version table in this
  slice; the budget's existing version history covers the budget lines.
- `GET /api/accounting/budgets/variance/departments` allocates each expense
  group's budget by the effective rules in cents, reports tagged POSTED actuals
  by their stored cost centre, and keeps untagged actuals in an explicit
  unallocated row. Its tie-out proves allocated budget and tagged + unallocated
  actual reconcile to the branch expense totals.
- Every successful line mutation writes an immutable prior-state row to
  `gl_budget_versions` inside the same transaction, before the new lines are
  written: normal save, copy, copy-with-replace, CSV import,
  import-with-replace and restore. A new budget writes an empty baseline
  version; existing budgets are backfilled with their current lines on schema
  upgrade. Rows record version number, actor, timestamp, source and the exact
  lines (period, account, amount and chart code/name). `GET
  /api/accounting/budgets/history` lists versions, `GET
  /api/accounting/budgets/history/:id` returns one version's lines, and `POST
  /api/accounting/budgets/history/:id/restore` restores a version by appending
  a new snapshot rather than rewriting history. History stays readable while a
  budget is locked; restore is `gl-chart-manage`, concrete-branch and 409 when
  locked or when a closed period would change.
- The **Finance Dashboard → Budgets** view (third view beside Overview and
  Branch comparison) shows the variance table, summary cards, a consolidated
  read-only mode and a hand-creatable monthly line editor. Its **Copy from
  previous year**, **Import CSV**, **Export CSV** and **Replace existing
  budget** controls surface the transfer endpoints and render row-level import
  errors inline. Every account row drills into its posted lines and shows a
  budget/actual/line tie-out footer. Branch utilisation cards above the table
  show each branch's posted actual against its budget, with a tie-out badge
  against the variance total. A **Budget history** panel lists versions with
  who/when/source, drills into the stored lines and offers restore to
  `gl-chart-manage` users; restore is disabled while locked and absent for
  read-only users.
- A current-year budget for BR-KTM (4000/6100/6400) is seeded in the live
  database so the screen has real data to compare against posted actuals.

## Branch-wise cost-centre allocation (landed)

The delivered budget is account-level P&L, one header per fiscal year and branch.
The allocation is therefore a **branch-scoped setting**, not a hard-coded
company-wide split.

### Boundary

- Allocate the branch's **expense budget** only. Revenue stays at branch level;
  applying 75% of sales to Operations would be misleading.
- **CAPEX is not in this slice.** `gl_budget_lines` accepts only P&L accounts,
  so fiber/OLT/core-router purchases have no budget line here. The 75% CAPEX
  rationale cannot be measured against the current P&L budget. A capital budget
  needs asset-account lines or a separate CAPEX budget, which is a scope
  expansion.
- Actuals are always POSTED expense lines tagged with `cost_center_id`. They
  must never be allocated by the budget ratio; an untagged actual is reported
  as **Unallocated actual**, not silently spread across departments.
- A branch **DEFAULT** split is the fallback for every expense statement
  group. `COST_OF_SALES`, `OPERATING_EXPENSE` and `OTHER_EXPENSE` may each
  define an override that replaces the default for that group only.
- A missing profile shows **Not configured**, never a fabricated split.

### Setting and data

- `gl_budget_allocation_profiles`: one profile per fiscal year + branch.
- `gl_budget_allocation_lines`: cost centre + percentage in basis points, with
  the profile's lines required to sum to exactly 10,000 (100.00%).
- Only active centres that are global or belong to the branch; no duplicate
  centre; no parent and child both selected; 0–100% per line.
- A profile may be saved before budget lines exist. Writes require
  `gl-chart-manage`; reads use `gl-view`; the setting is concrete-branch only.
- A locked budget blocks profile edits. Each save is audited; no allocation
  version table was added in this slice, because the setting is a management
  view and the budget's own version history already covers line changes.
- The demo seed gives each branch a different 100%-total default split so the
  branch-scoped setting is visible on the seeded data. It inserts a profile only
  when that branch has none, so a live operator's edited profile is never
  overwritten. There is no CAPEX allocation.

### API and UI

- `GET /api/accounting/budgets/allocation` returns the profile, candidate
  centres, total expense budget, and a preview with per-centre budget, tagged
  actual, unallocated actual, coverage, variance and utilisation.
- `PUT /api/accounting/budgets/allocation` validates the exact 100% total,
  branch/centre compatibility, lock state and permission, then audits the save.
- `GET /api/accounting/budgets/variance/departments` returns the department
  rows plus an `unallocatedActual` row and a tie-out to the expense variance
  total. `allocated actual + unallocated actual = total expense actual`.
- Budgets view gains a **Cost-centre allocation** card with **Branch default**
  and expense-group tabs. Each tab has percentage inputs, a live budget amount
  preview, a green/red 100% total, **Distribute equally**, add/remove centre,
  inherit-default and override actions, and Save. A live department preview
  shows tagged actual, variance, utilisation, the unallocated row and a
  cost-centre coverage warning.
- In the consolidated `ALL` view the card explains that allocation is
  branch-specific and asks the user to choose a branch; it does not fabricate a
  company-wide matrix.

### Evidence driving the boundary

- 5 active cost centres, all global and `is_demo`.
- 129 POSTED P&L lines, **0 tagged** with a cost centre.
- Four FY 2083-84 branch budgets: NPR 960,000 expense and NPR 3,000,000 revenue
  each; no asset/CAPEX budget lines.
- Consequently, a department card built today would show allocated budget but
  **NPR 0 tagged actual** until postings are tagged. The unallocated row and
  coverage warning are mandatory for an honest first release.

## Scope

1. **Landed:** `gl_budgets` + `gl_budget_lines` and the monthly distribution.
2. **Landed:** budget maintenance (add/update/remove lines, save) in the Finance
   Dashboard; a closed accounting period keeps its stored line and refuses edits.
3. **Landed:** budget-vs-actual from posted `gl_journal_lines`, with amount and
   percent, and a row-level drill to the posted lines plus a tie-out against the
   displayed actual.
4. **Landed:** prior-year copy, validated CSV import/export, branch
   utilisation cards, main-dashboard budget overspend alerts, an explicit
   per-budget lock and immutable version history with restore.
5. **Landed:** branch-scoped expense cost-centre allocation with group
   overrides, department budget/actual preview and an explicit unallocated
   actual row; see the section above.

## Out of scope

- Forecasting (separate initiative).
- Encumbrance/commitment accounting on purchase orders.
- CAPEX/asset budgeting in this slice. The current budget table is P&L-only; the
  proposed 75% CAPEX justification describes asset purchases that cannot be
  attached to these budget lines.

## Acceptance criteria

- Budget variance ties to the profit-and-loss statement for the same scope and
  window; the API suite asserts the expense and income actual totals match it.
- A closed period still reports actuals but cannot accept budget edits.
- Branch users see only their branch; consolidated users see `ALL`.
- CSV import rejects unknown/inactive/non-P&L accounts, periods outside the
  target fiscal year, non-numeric or negative amounts, and duplicate
  account+period rows; one bad row refuses the whole file. Re-applying the
  same CSV leaves totals unchanged and creates no duplicate lines.
- A copy reports its month mapping and skipped chart accounts, refuses to
  overwrite an existing target unless replace is explicit, and a second
  identical copy leaves totals unchanged.
- Every variance row's drill-down uses the same branch/window scope, returns
  only POSTED lines, and its line total equals the displayed actual; the API
  suite asserts the exact lines and both branch and consolidated scopes.
- Branch utilisation cards use the same fiscal-year, branch and window
  predicates as the variance report. Their budget and actual sums equal the
  variance totals in both branch and consolidated views, and a branch user sees
  only their own branch.
- Overspend alerts include only budgeted expense accounts whose POSTED actual
  is above budget; income above target and unbudgeted spend are not called
  overspending. They use the same fiscal-year/branch/window predicates as the
  variance report, and their totals and source tie-out cover every alert before
  the display limit. A branch user sees only their own branch.
- A locked budget refuses save, copy, import, replace, allocation changes and
  restore with 409, leaves the stored lines untouched, is audited on lock and
  unlock, and unlocks back to normal editing. Reads, drill-downs, history and
  export still work while locked.
- Allocation rules total exactly 100.00% per group; a foreign-branch centre, a
  duplicate centre, an inactive centre and a parent plus child in the same group
  are refused without changing the stored profile. Each accepted save writes
  `SAVE_GL_BUDGET_ALLOCATION`.
- Department budgets use the default everywhere except an explicit group
  override, allocate in cents, and equal the expense budget they replace.
  Tagged actuals stay with their own centre; untagged actuals remain an explicit
  unallocated amount, and the preview ties those two actual amounts back to the
  branch expense total.
- Every successful save/import/copy/replace writes a prior-state version in the
  same transaction; refusals write none. The initial creation has a baseline,
  version numbers stay monotonic through restore, and a restore is audited and
  appends a new version instead of changing an old one.

## Decisions

- **Decided:** monthly distribution, account-level, per fiscal year + branch.
- **Decided and landed:** cost-centre/department reporting via a branch +
  fiscal-year allocation profile. Expense budgets only; revenue and CAPEX
  assets excluded; tagged actuals only, with an explicit unallocated actual row.
  The ledger already carries `cost_center_id`, but 0 posted P&L lines use it in
  the demo data today, so the preview must not imply complete department
  actuals.
- **Decided:** an explicit per-budget lock (`locked_at`/`locked_by`) supplements
  closed periods. Lock/unlock is audited and locked writes refuse as a whole.
- **Decided:** immutable prior-state version history in `gl_budget_versions`.
  Snapshots are written before the new lines inside the mutation transaction;
  restore appends another snapshot. The baseline is the explicit empty prior
  state for a newly created budget; the schema upgrade backfills existing
  budgets with their current lines.

## Next action

The allocation slice is implemented and demonstrated on the seeded demo data.
The seed tags the existing expense lines and creates branch-specific allocation
profiles; an existing database is backfilled without reseeding. No
implementation work remains for this slice.

## Verification (2026-11-10)

- Seed coverage: `tests/verificationSeed.test.ts` **6/6** checks the
  deterministic expense-account tags, all five centres on every branch, and
  four 100%-total allocation profiles with 20 rules.
- Allocation slice: `tests/budgetAllocation.api.test.ts` **8/8** against real
  PostgreSQL/HTTP — missing profile, branch default plus OPERATING_EXPENSE
  override, exact 100%/duplicate/foreign/unknown-group refusal, department
  allocation and unallocated tie-out, permissions and branch scope, lock refusal
  plus unlock resumption, audit rows, and the seeded KTM preview's tagged
  actuals/tie-out. `tests/accountingWorkspaceRoute.test.ts`
  **22/22**, including the new mounted allocation card/preview/save payload test.
  `npx tsc --noEmit` exited 0. Schema drift/parity guards passed at **85**
  tables at that slice (the later bank-reconciliation slice moved the schema
  to 87).
- The broader counts below pre-date the allocation slice. `tests/budgetVariance.api.test.ts` (15 tests): zero actuals, overspend,
  exactly on budget, budget-only, actual-only, income sign, totals, P&L
  tie-out, branch/ALL scope, permissions, validation, closed-period refusal
  and closed-line preservation. New transfer coverage: copy-forward month
  mapping, repeat-copy `UNCHANGED`, refusal without replace, explicit
  `REPLACED`, all-or-nothing CSV row errors, double-import idempotency and
  CSV export round-trip. Drill-down coverage asserts the exact POSTED lines,
  natural-side amounts, branch vs consolidated scope, pre-limit totals and a
  reconciled tie-out. Branch-utilisation coverage asserts exact cards, the
  branch vs consolidated scope, a narrowed window, the card-sum tie-out and
  permission/input refusals. Overspend-alert coverage asserts exact budgeted
  expense rows, exclusion of income and unbudgeted spend, branch vs ALL scope,
  a narrowed window, totals/tie-out before a one-row limit, permissions and
  invalid inputs, and the explicit lock (audit counts, idempotent unlock,
  save/copy/import refusal, permissions, missing/invalid input, no-budget 404
  and unlocked save resumption). History coverage asserts the initial
  baseline, save/copy/copy-replace/import-replace snapshots, source/actor/line
  details, monotonic restore numbering and no snapshot on locked, permission
  or foreign-branch refusal. `tests/accountingWorkspaceRoute.test.ts` (9
  mounted budget tests) opens the account drill-down and checks the posted
  voucher and tie-out footer; the branch-card test checks both cards,
  utilisation percentages and the tie-out label; the allocation test shows the
  department preview and saves the branch default; the lock test checks the
  badge, disabled write controls and unlock restoration; the history test
  opens a version, drills into its lines and restores it. `tests/dashboardBudgetAlerts.test.ts` (1
  mounted dashboard test) renders the alert panel's account rows and totals,
  asserts the request carries the exact fiscal-year/branch/window and limit,
  checks the `Ties to variance total` badge, and opens Budget vs actual. It
  also covers the dashboard figures, editor save, copy/replace, refused-import
  row errors and the ALL view being read-only.
- The budget history panel was also inspected in the running app against the
  seeded KTM FY 2083-84 budget: it opened, listed the baseline, drilled into all
  36 stored lines and exposed the restore control to the manager. The dashboard
  alert panel and budget lock controls remain mounted-DOM-only; they were not
  separately re-inspected in a browser on 2026-11-10.
- Visual scope note: the seeded KTM `2026-07` period starts on 2026-07-01,
  before the FY 2083-84 start (2026-07-17), so the documented wholly-inside
  period rule excludes its NPR 3,30,000 from the full-year variance total while
  the history snapshot retains all 36 stored lines. This is a partial-period
  boundary in the seed, not a history/restore mismatch.
- The CSV sample lives at `docs/budget-import-sample.csv` and uses the exact
  export columns.
- Schema drift/parity guards declare 87 tables after the budget allocation
  and bank reconciliation additions.
- Allocation demo data (2026-11-10): **57** posted demo expense lines across
  accounts `5000`, `6100` and `6400` are tagged on all four branches, through
  both the seed and an idempotent live backfill. The live FY 2083-84 KTM
  preview returns a **NPR 800,000** allocated budget and **NPR 172,800** tagged
  actual — `CC-02-FIN` **1,200**, `CC-03-OPS` **171,600**, the other three
  centres zero — with **0** unallocated and **0/0** budget/actual tie-out.
  The four branch profiles carry 20 rules, each totaling 10,000 bp. Each branch
  keeps its NPR 960,000 full-year expense / NPR 3,000,000 revenue budget and no
  CAPEX lines; the 800,000 is the report's complete-period window. Other
  expense accounts remain explicitly untagged, so the unallocated row stays
  meaningful.
- In-app browser verification (2026-11-10): with the Vite dev server on
  `http://localhost:3000`, the Finance Dashboard → Budget vs actual view was
  scoped to **KTM · Kathmandu (Head Office)** for **FY 2083-84** and the
  **Cost-centre allocation** panel rendered **READY · 5 rules**, **Reconciled**
  and **Zero variance · budget Δ NPR 0 · actual Δ NPR 0**. The department
  preview showed `CC-01-EXEC` 80,000/0, `CC-02-FIN` 1,60,000/1,200,
  `CC-03-OPS` 3,20,000/1,71,600, `CC-04-COMM` 1,20,000/0 and `CC-05-CX`
  1,20,000/0; allocated **8,00,000 / 1,72,800**; unallocated **0**; tagged
  **8 of 8** posted expense lines. Browser console had only Vite/React debug
  messages, every script/API request was 200, and the captured server stdout
  had no error lines. The viewport capture was generated locally and is not
  committed.
- `npm test`: **2,120 tests / 477 suites**, 2,118 pass, 2 Windows-only skips,
  0 fail; docs-count gate matched 2,120. `npm run build` exited 0; bundle gate
  passed at 20.6 kB entry gzip (20.625 kB budget) and 313.8/320 kB startup.
  Boot timing passed at 1,472 ms cold / 426 ms warm (6,000 ms budget).
  `check:no-inline-sql` and `check:no-raw-dialogs` both passed; `git diff
  --check` is clean.
