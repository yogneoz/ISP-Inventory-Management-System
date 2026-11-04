# Accounting module review — Swastik TB, plan vs implementation

_Status: proposal, 2026-11-03. No runtime code is changed by this note._

## 1. What the attached Swastik trial balance contains

`Trial Balance..xlsx` is a single-sheet print export for I ZONE PVT. LTD., FY 2083-84
(01/04/2083–32/03/2084), generated 03/11/2026.

| Fact | Value |
| --- | --- |
| Ledger accounts (leaf rows) | 1,867 |
| Sub-groups | 33 |
| Top-level groups | 18 |
| Columns | Opening Dr/Cr, Period Dr/Cr, Closing Dr/Cr |
| Hierarchy | Group → Sub Group → Ledger (code + name) |
| Subtotals | per Sub Group, per Group, plus a grand Total |
| Period total | Dr 102,282,661.13 = Cr 102,282,661.13 |
| Opening total | Dr 154,994,660.48 vs Cr 158,800,993.76 — **Cr excess 3,806,333.28** |
| Closing total | Dr 175,311,294.90 vs Cr 179,117,628.18 — **same Cr excess 3,806,333.28** |

The period movement balances, but the exported opening and closing columns do not.
That is worth investigating in the existing books before any migration: it may be a
missing opening/retained-earnings line, a suspense ledger, or an export artifact.
Our trial balance flags exactly this instead of printing an unbalanced “Total”.

The 18 top-level groups are Capital; Cash & Bank; Current Assets; Direct
Expenditure; Direct Income; Duties & Taxes; Fixed Assets; Other Expenditure; Other
Liabilities; Rent Payable; Reserve & Surplus; Secured Loans; Security Deposit;
Security Deposit-Customer; Stock in Hand; Sundry Creditors; Sundry Debtors;
Unsecured Loans. Several carry abnormal signs in this export (Stock in Hand closes
credit 9,668,723; Sundry Debtors close credit-heavy), which is another reason to
treat the file as data to reconcile, not a template to copy blindly.

## 2. What our module produces today

| Capability | Status |
| --- | --- |
| Trial balance, opening/period/closing Dr-Cr per account | Yes — `GET /api/accounting/statements/trial-balance`, Trial Balance register |
| Group/sub-group subtotals like the Swastik export | **Partial** — one account-group level; the flat register does not render section/subtotal rows |
| Profit & loss from posted journals | Yes — nested statement group → account group → accounts |
| Balance sheet from posted journals | Yes — assets/liabilities/equity, current earnings, inter-branch |
| Cash flow statement | **No** — a cash book and daily cash close exist, but neither is a cash-flow statement |
| AR/AP aging + control tie-out | Yes |
| Chart of accounts read | Yes — Chart & Defaults register |
| Chart of accounts Add/Edit | **API only** — `POST /api/accounting/groups`, `POST /api/accounting/accounts`, `PATCH /api/accounting/accounts/:id`; no client UI |
| Chart of accounts Delete | **No** — accounts are deactivated, groups cannot be edited/deleted |
| PDF/print of statements and documents | Yes |
| Branch and consolidated reporting | Yes (branch-scoped or `ALL`) |
| Budgets, bank reconciliation, recurring journals, multi-currency | No |

So: the trial balance is the same *statement shape* (six amount columns, balanced
check, posted ledger) but not yet the same *report shape* (two-level groups and
subtotal rows), and cash flow is genuinely absent.

## 3. First plan vs implemented plan

The original plan note is not stored in this repository; only its later references
in `SESSION_NOTES.md` and the mission trail survive. The “~86 tables” draft the
user remembers therefore cannot be quoted line-for-line here. What can be compared
is the intended full-ERP shape against what actually shipped:

| Area | First-plan intent (as remembered) | Implemented today |
| --- | --- | --- |
| Data model | ~86 tables; ledger tables per domain | **53 tables total**, 11 accounting tables: chart, accounts, bill terms, periods, journals, lines, subledger, daily cash close, employees, payroll runs/lines |
| Ledger | separate AR/AP/inventory/asset/payroll ledgers | one generic `gl_journals` + `gl_journal_lines` + `gl_subledger_entries`; every domain posts through the same helper |
| Chart of accounts | full CoA, hierarchy, maintenance | 38 seeded codes covering posting roles; one flat group level; read-only screen |
| Journals | vouchers, recurring, reversals, period locks | source-keyed journals, linked reversals, period open/close, opening balances, year-end close |
| AR/AP | subledgers, balances, aging | yes, control accounts + party subledger + aging |
| Cash | cash book, close, cash flow | cash book + daily close; no cash-flow statement |
| Fixed assets | register, depreciation, disposal | all posted through chart roles; register screens exist |
| Payroll | employee master, runs, TDS/SSF | posted through the same subledger; API only, no screens |
| Statements | TB, BS, P&L, cash flow, PDF | TB/BS/P&L and PDF; cash flow missing |
| Budgets / bank rec / multi-currency | part of the large draft | absent |
| Tests | route-level proof | 1,887 tests green, including posting/statement/aging/close routes |

The compact model is not a shortcut that lost correctness: it removed the
per-domain ledger tables the large draft implied, while keeping immutable
journals, a balanced trial balance, subledger tie-outs and one posting path. That
is the part a maintainer should keep.

The real gaps are narrower and product-shaped:

1. The chart is not maintainable from the client (Add/Edit missing; no Delete).
2. The chart is one level deep, so Swastik-style group/sub-group reporting and
   subtotal rows cannot be reproduced.
3. There is no cash-flow statement.
4. Navigation still presents accounting as a flat “Statements & ledgers” list
   mixed with operational finance, while payroll, closing and fiscal setup live
   elsewhere.

## 4. Recommendation

**Do not rebuild the schema around 86 tables.** Keep the generic ledger and add
the missing accounting shell. The product should be:

> inventory-first operations, with a first-class accounting module behind them —
> not a general accounting package whose inventory happens to be a submodule.

That matches how the data already flows (operational documents are the source,
journals are the record, statements are reads) and keeps the permanent compliance
surface small. If the goal changes to selling a general accounting package, that
is a separate product decision and should be taken explicitly.

The old 2026-09-26 decision (“no accounting ERP — do not re-litigate”) is
superseded by the later approved accounting slices; the current module is a
bounded GL, not the declined full ERP.

## 5. Proposed sidebar shape (Finance & Accounting)

Keep the existing data-driven sidebar; no new “accounting base component” is
needed. Regroup the finance children and move the accounting-relevant fiscal
screens in:

- **Statements** — Trial Balance, Profit & Loss, Balance Sheet, Cash Flow (new)
- **Registers** — Cash & Bank Book, AR / AP Aging, Daily Cash Close, Customer
  Ledger, Vendor Ledger
- **Maintenance** — Chart & Defaults, Opening Balances, Periods, Fiscal Year
  Closing (moved from Admin)
- **Assets & Payroll** — Fixed Asset Register, Depreciation Schedule, Payroll
- **Tax** — VAT Register
- **Management** — Financial Overview (kept, still labeled a management view)

Inventory, procurement and sales stay their own domains. This is a navigation
change, not an architecture inversion.

## 6. Phased plan

### P1 — Chart of accounts write surface (highest value, smallest schema change)

- Client UI in Chart & Defaults: add group, add account, edit name/description/
  posting role/active, deactivate, delete.
- Server: `DELETE /api/accounting/accounts/:id` and `DELETE/PATCH` for groups.
  Refuse delete when the account has journal lines, subledger entries or is a
  posting role; deactivate instead. Refuse group delete while it has accounts.
- Validation: unique code, unique posting role, control ↔ subledger consistency,
  account type/statement group compatibility.
- Audit every mutation; `gl-manage` gate.
- Tests: create/edit/deactivate/delete refusals, posting-role uniqueness, audit
  rows, client mounted form.
- Acceptance: a user can add a Swastik-style ledger under a group, rename it,
  retire it, and the trial balance/P&L/BS immediately reflect the chart.

### P2 — Group hierarchy + report layout

- Add `parent_id` to `gl_account_groups` (self-reference; roots keep the statement
  group/account type, children inherit).
- Trial balance response: nested group blocks with subtotals; render group and
  sub-group total rows like the Swastik export; keep the flat account list for
  exports.
- Chart UI: tree with add-subgroup.
- Acceptance: a two-level chart prints Group → Sub Group → Ledger with subtotals;
  totals still tie to debits = credits and control accounts.

### P3 — Cash-flow statement

- Add `cash_flow_category` (OPERATING / INVESTING / FINANCING / NONE) to accounts
  with sensible defaults from statement group; fall back to counterpart-account
  classification for legacy postings.
- `GET /api/accounting/statements/cash-flow` (direct method from cash/bank lines),
  register screen and PDF/print.
- Acceptance: cash flow’s net change equals closing cash − opening cash for the
  same branch/date; investing/financing lines trace to their journals.

### P4 — Navigation restructure

- Regroup the sidebar as in §5; move Fiscal Year Closing/Opening Balances into
  Maintenance; add Cash Flow and Payroll entries only when their screens exist.
- Keep route keys stable; this is labels/sections, not a data migration.

### P5 — Optional ERP features (only on an explicit product decision)

Budgets, bank reconciliation, recurring journals, multi-currency, tax filing.
Each adds real maintenance and legal-risk surface; none is required for the
current inventory business to close its books.

## 7. Non-goals for this plan

- No 86-table rewrite and no per-domain ledger tables.
- No parallel posting path: every write still goes through `postJournal`.
- No client-side computation of statement figures.
- No payroll screens in the same pass as chart CRUD.

## 8. Open decisions

1. Is the target an inventory-first business system with a strong accounting
   module (recommended), or a sellable general accounting package?
2. Does the Swastik chart need to be importable, or only reproducible manually?
3. Cash flow: direct method from cash lines (recommended for this ledger), or
   indirect from net profit + working-capital movement?
4. Should the flat “Financial Overview” management screen survive alongside the
   statutory statement registers, or be folded into Statements?
