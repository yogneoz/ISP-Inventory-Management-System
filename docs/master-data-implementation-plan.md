# Master data & ledger implementation plan

_Status: active, started 2026-11-04._

This note tracks the legacy **General Ledger Master** menu against the screens that
exist in this application, then records the order in which the gaps will be built.
It supersedes the master-data portions of `docs/accounting-module-review.md`; that
note still says chart Add/Edit is API-only, which is no longer true.

## 1. Status legend

| Mark | Meaning |
| --- | --- |
| Done | The component has a working creation screen. |
| Partial | Something exists, but it is not the right master or it is incomplete. |
| Missing | There is no creation screen or backing table. |
| Deferred | Deliberately not being built yet. |

## 2. Component map

| # | Legacy component | Where it is created today | Status | Target home |
| --- | --- | --- | --- | --- |
| 1 | Ledger | Master Data & Setup → Accounting → Chart of Accounts → New Account (`/finance/accounting/chart`) | Done | Chart of Accounts → Ledgers |
| 2 | Sub Ledger | Chart of Accounts → New/Edit Account → Subledger field; rows come from transactions | Partial | Chart of Accounts → Control Accounts |
| 3 | Account Group | Chart of Accounts → New Group, no parent | Done | Chart of Accounts → Groups & Sub-Groups |
| 4 | Account Sub Group | Chart of Accounts → New Group or a group’s Add sub-group action, parent = any group | Done | Chart of Accounts → Groups & Sub-Groups |
| 5 | Product | Master Data & Setup → Products → Product Master Catalog (`/inventory/products`) | Done | Products |
| 6 | Bill Terms | Master Data & Setup → Accounting → Bill Terms (`/finance/accounting/bill-terms`) | Done | Accounting → Bill Terms |
| 7 | Agent / Area | Master Data & Setup → Parties → Sales Agents & Areas (`/sales/agents-areas`) | Done | Parties → Sales Agents & Areas |
| 8 | Godown | Location Management (`/settings/locations`), type `WAREHOUSE`; or Branch Management (`/settings/branches`) | Partial | Organisation → Godowns / Warehouses |
| 9 | Document Class | Master Data & Setup → Accounting → Document Classes & Numbering (`/fiscal/document-numbering`) | Done | Accounting → Document Classes & Numbering |
| 10 | Currency | Company Profile & Setup → Comms & Currency (`/settings/company`) | Partial | Accounting → Currency & Exchange Rates |
| 11 | Cost Center | Master Data & Setup → Accounting → Cost Centers (`/finance/accounting/cost-centers`) | Done | Accounting → Cost Centers |
| 12 | Narration Master | Master Data & Setup → Accounting → Narration Templates (`/finance/accounting/narrations`) | Done | Accounting → Narration Templates |
| 13 | Opening Balance | Vendor screen, stock workflow, GL API only, no customer register | Partial | Finance & Accounting → General Ledger → Opening Balances |
| 14 | Copy Master | None | Missing | Utilities → Copy Masters |

`Category Management`, `Product Group Management` and `UoM Management` are current
masters that the legacy list does not show. They stay under Products.

## 3. Target navigation

```text
Master Data & Setup

  Accounting
    Chart of Accounts
      Ledgers
      Groups & Sub-Groups
      Control Accounts (subledger)
      Posting Defaults
    Bill Terms
    Cost Centers
    Narration Templates
    Document Classes & Numbering
    Currency & Exchange Rates      [only when multi-currency exists]

  Products
    Product Master Catalog
    Category Management
    Product Group Management
    UoM Management

  Parties
    Customer Master Directory
    Suppliers Directory
    Sales Agents & Areas
    Import Customers (CSV)

  Organisation
    Branch Management
    Location Management (POP/GPS)
    Godowns / Warehouses           [only if stock-level godowns are needed]

  Utilities
    Copy Masters                   [low priority]
```

**Opening Balances stays in Finance**, because it posts journals:

```text
Finance & Accounting
  General Ledger
    Journal Entries
    Journal Register
    Posting Defaults
    Opening Balances
    Period Close
```

The canonical Chart of Accounts route remains `/finance/accounting/chart` even
though the sidebar entry now lives under Master Data. Moving the route would break
saved links, tests and permission assumptions for no user benefit.

## 4. Component notes

### 4.1 Ledger

**Today.** `New Account` creates a `gl_accounts` row with code, name, group,
description, subledger type, posting role and a separate `account_kind`
(`CASH`, `BANK`, `OTHER`). The form has a **Cash / bank details** tab for bank
name, branch, account number, account holder and SWIFT/BIC. The chart lists the
kind beside each ledger.

**Decision.** A cash or bank account is a ledger, not a separate ledger family.
Each bank account and each cash drawer gets its own `gl_accounts` row. The existing
generic journal stays the only posting path.

**Multiple accounts.** The one-per-role partial unique index still marks the
default CASH and BANK ledgers. Extra tills and bank accounts are ordinary rows
with `posting_role = NULL` and `account_kind = CASH`/`BANK`; they do not compete
for the default. Payment receipts and vendor payments choose the actual
settlement ledger, and the cash book, daily cash close and balance-sheet cash
total all read every active CASH/BANK ledger, not only the default.

**Still separate.** Multi-currency and opening-balance entry are not part of the
ledger creator; they remain later steps/projects.

### 4.2 Sub Ledger

**Today.** A control account chooses a subledger type. Transactions create
`gl_subledger_entries` rows. Customer and supplier identities come from their
masters. There is no standalone subledger creation screen.

**Decision.** Do not add a “Sub Ledger” menu that creates empty rows with no party
behind them. Subledger configuration belongs in `Chart of Accounts → Control
Accounts`; the identities belong in the party masters. A generic subledger master
is only worth adding if agents, departments or projects need their own control
accounts.

### 4.3 Account Group and Account Sub Group

**Today.** Both are `gl_account_groups` rows. A group has an optional parent and
may nest to any depth; a sub-group inherits its nearest parent’s account type,
statement group and normal balance. Ledger accounts attach to any group, but only
accounts receive postings. The chart form has an explicit Add sub-group action and
shows the full code path, and the classic ledger master lists every descendant of
the selected root group.

**Decision.** Keep one self-referencing hierarchy table, not a second “sub-group”
table. Allow arbitrary nesting because the parent selector, cycle guard and
recursive statement builders already work as a tree; the trial balance, P&L,
balance sheet and PDF renderer recurse through it. A group may move only while it
has no accounts and no children, and a move under itself or a descendant is
refused.

### 4.4 Product

**Today.** `Product Master Catalog` creates products. Category, product group and
UoM are separate masters beside it.

**Decision.** Keep as-is. The legacy list only names “Product”; the current split
is richer and should not be collapsed.

### 4.5 Bill Terms

**Today.** Built. `Master Data & Setup → Accounting → Bill Terms` creates, edits,
retires and deletes terms (`code`, `name`, `due_days`, optional discount window and
percentage). Customers and suppliers carry a default term. Sales and purchase
invoice forms prefill that default, calculate the due date on save, and allow an
explicit due-date override. Purchase invoices now store the vendor's bill date in
`vendor_bill_date_ad` / `vendor_bill_date_bs`; `due_date_ad` is a real due date,
not a copy of the bill date. Aging therefore reads the document's actual terms.

**Decision.** A term is master data, not a per-invoice free-text convention. The
invoice stores both the resolved term id and the computed due date so later master
changes cannot rewrite history.

**Model.**

```text
bill_terms
  id, code, name, due_days, discount_days, discount_percent, active, is_demo

customer_records.bill_terms_id
suppliers.bill_terms_id
sales_invoices.bill_terms_id, due_date_ad, due_date_bs
purchase_invoices.bill_terms_id, due_date_ad, due_date_bs
purchase_invoices.vendor_bill_date_ad, vendor_bill_date_bs
```

**Build note.** The shared UTC-safe arithmetic lives in `shared/billTerms.ts`.
Deleting a term still in use is refused with `409`, and inactive terms stay
readable for history but are not offered as new defaults. Tests cover the 0, 7,
15, 30, 45 and 60-day seeds plus invalid dates and the maximum term.

### 4.6 Agent / Area

**Today.** Built as one combined screen (*Sales Agents & Areas*) under
**Master Data & Setup → Parties**. Areas may be global (`branch_id NULL`) or
branch-owned; agents are company-wide and may point at an area the actor can
see. A delete is refused with `409` while customers, invoices, child areas or
agents still reference the row.

**Decision.** These are sales dimensions, not ledger attributes. Do not copy the
legacy ledger’s Area/Agent fields onto every GL account.

**Minimum model.**

```text
areas
  id, code, name, parent_id, branch_id, active

sales_agents
  id, code, name, phone, email, area_id, commission_rate, active

customer_records.area_id, customer_records.agent_id
sales_invoices.area_id, sales_invoices.area_name, agent_id, agent_name
  (snapshot at posting)
```

**Build note.** Invoice snapshots store the id and the name, so renaming or
reassigning a master later cannot rewrite posted history. The sales form inherits
the selected customer’s defaults and can override them before posting. Commission
reporting is still a separate report.

### 4.7 Godown

**Today.** `locations` supports type `WAREHOUSE`, but stock is keyed by branch:
`inventory_stock` is unique on `(product_id, branch_id)`, and shipments reference
branches as warehouses. Location Management is an asset/POP register, not a stock
bucket.

**Decision.** Use a branch as the godown for now. Build a true godown dimension
only if one branch needs multiple stockrooms.

**True-godown model, if needed.**

```text
godowns
  id, code, name, branch_id, address, active

inventory_stock.godown_id
stock_operations.godown_id
shipments.destination_godown_id
```

This is an inventory project, not a master-data screen. Do not label the existing
Location Management screen as the godown creator until stock actually moves there.

### 4.8 Document Class

**Today.** `document_number_configs` holds document type, prefix, suffix, minimum
digits, starting number and reset policy. **Document Classes & Numbering** now
lives under Master Data → Accounting and can create a new series or edit an
existing series’ label, prefix and notes. The series id and its live counter are
not editable, so creating a class cannot reset issued numbers.

**Decision.** “Document Class” here means a numbering series. The existing table
is the master; a voucher class with custom fields/templates is a different
subsystem and is not being invented. `POST /api/document-number-configs` and
`PATCH /api/document-number-configs/:id` are gated by `admin-fiscal`; the old
bulk PUT remains for existing callers.

### 4.9 Currency

**Today.** `company_profile` holds one base currency code, symbol, locale,
position and decimals. There is no currency table, exchange rate or per-document
currency.

**Decision.** Keep the base currency in Company Profile. Do not add a currency
field to every ledger until multi-currency exists. A real multi-currency project
needs currencies, exchange rates, document currency, FX gain/loss and revaluation.

### 4.10 Cost Center

**Today.** `cost_centers` stores code, name, optional parent, optional branch and
active flag. `gl_journal_lines.cost_center_id` carries the dimension, and the
manual-journal API validates that the centre exists, is active and is either
global or belongs to the journal’s branch. Cost Centers has its own master screen.

**Decision.** Add a separate cost-center dimension.

**Minimum model.**

```text
cost_centers
  id, code, name, parent_id, branch_id, active

gl_journal_lines.cost_center_id
```

**Build note.** Manual journals are the first posting path. Expense/payment forms
and cost-center reports follow in a later slice; a branch is a location and is
never silently treated as a cost center. The screen refuses a circular parent and
blocks deleting a centre used by a posted line or child centre.

### 4.11 Narration Master

**Today.** `narration_templates` stores code, text, transaction type and active
flag, with a master screen under Accounting. The API can filter by type and
returns `ALL` templates for every form. Journal descriptions remain free text.

**Decision.** Low priority. Add templates for consistency, not as an accounting
dimension.

```text
narration_templates
  id, code, text, transaction_type, active
```

The posted journal keeps the chosen text, never the template id. The quick-pick
is not wired into a form yet because the manual-journal screen does not exist and
the payment modals have no memo field; the master and typed read API are ready
for that integration without changing posted history.

### 4.12 Opening Balance

**Today.** Split:

- Vendor opening balances: `Finance → Vendor Opening Balances`.
- Opening stock: fiscal-year opening-stock workflow.
- General ledger: `POST /api/accounting/opening-balances`, API only.
- Customer: no register; the sales ledger uses a period-net opening method.

**Decision.** Build one Opening Balances hub with tabs for GL, Customers, Vendors
and Stock. Every tab posts a balanced opening journal or subledger rows. Do not
allow a one-sided balance edit.

**Build note.** Use the existing `OPENING_BALANCE` journal source type and an
opening-balance equity offset. For customers and vendors, create the control-account
subledger rows so the party ledger and aging work from day one.

### 4.13 Copy Master

**Today.** Missing. The app is single-company and has no copy utility.

**Decision.** Defer. If onboarding multiple companies or fiscal years becomes a
real workflow, add CSV import/export or a “copy from template” utility under
Administration. Do not build a generic copy screen without a clear source and
target.

## 5. Implementation steps

- [x] **Step 1 — Accounting master-data navigation.**
  Added an `Accounting` section to `Master Data & Setup`, moved
  `accounting-chart` there, and renamed the label from `Chart & Defaults` to
  `Chart of Accounts`. No route or schema change.

  Changed:
  - `client/src/components/layout/Sidebar.tsx`
  - `tests/sidebarGrouping.test.ts`
  - `docs/master-data-implementation-plan.md`

  Verified:
  - `npm run lint`
  - `NODE_ENV=test npx tsx --test tests/sidebarGrouping.test.ts` — 12 pass, 0 fail

- [x] **Step 2 — Bill Terms and due dates.**
  Added the master, party defaults, invoice calculation, the purchase-form fix and
  the due-date tests.

  Changed:
  - `shared/billTerms.ts`
  - `scripts/schema.sql`, `server/src/config/seedData.ts`,
    `server/src/state/runtimeState.ts`
  - `server/src/models/billTerms.repo.ts`,
    `server/src/services/billTerms.service.ts`,
    `server/src/controllers/billTerms.controller.ts`,
    `server/src/routes/accounting.routes.ts`
  - `server/src/models/masterdata.repo.ts`, `server/src/models/sales.repo.ts`,
    `server/src/models/procurement.repo.ts`, `server/src/models/columnMappings.ts`
  - `server/src/controllers/masterdata.controller.ts`,
    `server/src/controllers/sales.controller.ts`,
    `server/src/controllers/procurement.controller.ts`
  - `client/src/features/finance/BillTermsManagement.tsx`,
    `client/src/features/sales/SalesInvoices.tsx`,
    `client/src/features/sales/CustomerMasterDirectory.tsx`,
    `client/src/features/procurement/PurchaseInvoiceForm.tsx`,
    `client/src/features/procurement/PurchaseInvoices.tsx`,
    `client/src/features/procurement/SuppliersManagement.tsx`
  - `client/src/App.tsx`, `client/src/components/layout/Sidebar.tsx`,
    `client/src/routes/appPaths.ts`, `client/src/routes/tabPermissions.ts`,
    `client/src/screenPreload.ts`, `client/src/services/api/accounting.ts`,
    `client/src/services/api/index.ts`, `client/src/types/index.ts`
  - `tests/billTerms.test.ts` and the route/sidebar/schema/master-data guards

  Verified:
  - `npm run lint`
  - `npm run check:no-inline-sql` — 22 controller files, no raw SQL
  - `NODE_ENV=test npx tsx --test tests/billTerms.test.ts` — 5 pass, 0 fail
  - Focused route, sidebar, schema, master-data, invoice and aging suites — pass
  - `npm test` — 1,904 tests; the first run exposed three stale column-order
    assertions in `tests/procurement.repo.test.ts` and
    `tests/returns.repo.test.ts`, which were updated to the new columns. The
    affected suites then passed 64/64.

- [x] **Step 3 — Ledger creator and cash/bank model.**
  Added `account_kind`, bank metadata, multiple cash/bank accounts, payment
  settlement selection and the ledger form tabs. The generic journal is unchanged.

  Changed:
  - `scripts/schema.sql` — `gl_accounts.account_kind` and bank fields;
    `settlement_account_id` on customer/vendor payments; idempotent constraints
    and indexes
  - `server/src/models/accounting.repo.ts` — account kind/bank columns, settlement
    picker query, cash-book queries by kind, trial-balance kind
  - `server/src/models/cashClose.repo.ts` — daily close reads CASH/BANK kind
  - `server/src/services/accounting.service.ts` — kind/role and bank-field
    validation, create/update persistence
  - `server/src/services/accountingStatements.service.ts` — cash+bank total from
    account kind, not only the posting default
  - `server/src/services/accountingCashBook.service.ts` — per-ledger kind and bank
    metadata; every cash/bank ledger appears
  - `server/src/services/paymentPosting.service.ts` — an explicit settlement
    ledger is validated and posted; missing/inactive/wrong-kind accounts refuse
  - `server/src/controllers/accounting.controller.ts`,
    `server/src/routes/accounting.routes.ts` — settlement-accounts read endpoint
    for ledger viewers, receipt writers and payment writers
  - `server/src/controllers/sales.controller.ts`,
    `server/src/controllers/procurement.controller.ts` — persist the selected
    settlement ledger
  - `server/src/models/sales.repo.ts`,
    `server/src/models/procurement.repo.ts`,
    `server/src/models/columnMappings.ts` — payment column and projection updates
  - `client/src/components/accounting/ChartMaintenanceDialogs.tsx` — Profile and
    Cash/bank tabs, kind selector, bank fields
  - `client/src/components/accounting/ChartView.tsx` — kind column and payload
  - `client/src/components/accounting/CashBookView.tsx` — kind and bank identity
  - `client/src/features/sales/SalesInvoices.tsx`,
    `client/src/features/procurement/PurchaseInvoices.tsx` — settlement-ledger
    pickers, defaulting to the matching posting role
  - `client/src/App.tsx`, `client/src/services/api/accounting.ts`,
    `client/src/services/api/index.ts`,
    `client/src/services/api/procurement.ts`, `client/src/types/index.ts`
  - `tests/accounting.api.test.ts`, `tests/paymentCashBook.api.test.ts`,
    `tests/procurement.repo.test.ts`, `tests/returns.repo.test.ts`

  Verified:
  - `npm run lint`
  - `npm run check:no-inline-sql` — 22 controller files, no raw SQL
  - Focused accounting, payment/cash-book, chart-screen, repo and schema-drift
    suites — 34 pass, 0 fail
  - `npm test` — 1,906 tests; the full run passed 1,901 and exposed three stale
    expectations (two API-surface pins and the docs-count gate). After updating
    those, `tests/registerRefreshDomains.test.ts` and
    `tests/docsCounts.guard.test.ts` pass 52/52.

- [x] **Step 4 — Cost Centers, Narration Templates and Document Classes.**
  Added the cost-center journal dimension, the narration-text master and
  create/edit for numbering series. Document Numbering moved under Accounting.

  Changed:
  - `scripts/schema.sql` — `cost_centers`, `narration_templates`,
    `gl_journal_lines.cost_center_id` (inline + idempotent ALTER), indexes
  - `client/src/types/index.ts` — `CostCenter`, `NarrationTemplate`,
    `NarrationTransactionType`
  - `server/src/models/accountingMasters.repo.ts` — cost-centre/narration SQL
  - `server/src/controllers/accountingMasters.controller.ts` — CRUD, code
    uniqueness, branch/parent-cycle guards, usage-blocked delete
  - `server/src/middleware/branchScope.ts` — cost centres are branch-guarded by
    id; the controller also refuses a create/update outside the actor’s branches
  - `server/src/routes/accounting.routes.ts` — cost-centre CRUD and narration
    list/create/edit/delete routes under `gl-view`/`gl-manage`
  - `server/src/services/accounting.service.ts`,
    `server/src/models/accounting.repo.ts` — journal-line cost-centre
    validation, insert and read projection
  - `server/src/state/runtimeState.ts` — PG-less mirrors for both masters
  - `server/src/controllers/admin.controller.ts`,
    `server/src/models/admin.repo.ts`, `server/src/routes/admin.routes.ts` —
    create/edit numbering-series endpoints without resetting the counter
  - `client/src/features/finance/CostCentersManagement.tsx`,
    `client/src/features/finance/NarrationTemplatesManagement.tsx` — new masters
  - `client/src/features/finance/DocumentNumbering.tsx` — new series dialog,
    edit label/prefix/notes, “Document Classes & Numbering” title
  - `client/src/components/layout/Sidebar.tsx`, `client/src/routes/appPaths.ts`,
    `client/src/routes/tabPermissions.ts`, `client/src/screenPreload.ts`,
    `client/src/App.tsx` — two new screens and the numbering move
  - `client/src/services/api/accounting.ts`,
    `client/src/services/api/inventory.ts`, `client/src/services/api/index.ts` —
    typed master and numbering clients
  - `tests/accountingMasters.api.test.ts` plus route/screen/schema/docs guards

  Verified:
  - `npm run lint`
  - `npm run check:no-inline-sql` — 23 controller files, no raw SQL
  - `NODE_ENV=test npx tsx --test tests/accountingMasters.api.test.ts` — 4 pass
  - Accounting + masters + payment/cash-book + admin repo suites — 70 pass,
    0 fail
  - Route, sidebar, screen-surface, docs-count and schema guards — 119 pass,
    0 fail
  - `npm test` — 1,910 tests: 1,908 pass, 0 fail, 2 Windows-only skips

- [x] **Step 5 — Sales Agents and Areas.**
  Added the area and sales-agent masters, customer defaults for both, and the
  posted-invoice snapshot (id + name) so later master edits cannot rewrite
  history. One combined screen, *Sales Agents & Areas*, sits under
  **Master Data & Setup → Parties** with Areas and Sales Agents tabs.

  Changed:
  - `scripts/schema.sql` — `areas`, `sales_agents`;
    `customer_records.area_id`/`agent_id` and
    `sales_invoices.area_id`/`area_name`/`agent_id`/`agent_name` (inline +
    idempotent ALTERs), indexes
  - `client/src/types/index.ts` — `Area`, `SalesAgent`; customer defaults and
    invoice snapshot fields
  - `server/src/models/salesMasters.repo.ts` — area/agent SQL, usage counts,
    lookup used by the invoice snapshot
  - `server/src/controllers/salesMasters.controller.ts` — CRUD, code
    uniqueness, parent-cycle and branch guards, usage-blocked deletes
  - `server/src/routes/sales.routes.ts` — `/api/sales/areas` and
    `/api/sales/agents` CRUD under `customers-manage`
  - `server/src/middleware/branchScope.ts` — branch-owned areas are guarded by
    `areas.branch_id`; sales agents are company-wide
  - `server/src/models/masterdata.repo.ts`,
    `server/src/controllers/masterdata.controller.ts` — customer area/agent
    defaults persist through write and update; an unknown id is a 400 naming the
    field instead of a raw FK error
  - `server/src/models/sales.repo.ts`,
    `server/src/controllers/sales.controller.ts` — resolve the area/agent and
    snapshot both ids and names when the invoice is created
  - `server/src/state/runtimeState.ts` — PG-less mirrors for both masters
  - `client/src/features/sales/SalesAgentsAreasManagement.tsx` — new combined
    master screen
  - `client/src/features/sales/CustomerMasterDirectory.tsx` — area and agent
    selectors in the customer form
  - `client/src/features/sales/SalesInvoices.tsx` — inherit the selected
    customer’s area/agent and send them with the invoice
  - `client/src/components/layout/Sidebar.tsx`, `client/src/routes/appPaths.ts`,
    `client/src/routes/tabPermissions.ts`, `client/src/screenPreload.ts`,
    `client/src/App.tsx` — the new screen under Parties
  - `client/src/services/api/salesMasters.ts`,
    `client/src/services/api/index.ts` — typed area/agent clients
  - `tests/salesMasters.api.test.ts` plus route/screen/schema/docs guards

  Verified:
  - `npm run lint`
  - `npm run check:no-inline-sql` — 24 controller files, no raw SQL
  - `NODE_ENV=test npx tsx --test tests/salesMasters.api.test.ts` — 2 pass
  - Repo param-count, route, sidebar, screen-surface and schema guards — green
  - `npm test` — 1,913 tests: 1,911 pass, 0 fail, 2 Windows-only skips

- [ ] **Step 6 — Godowns.**
  Conditional on multiple stockrooms per branch. Otherwise keep branch-as-godown.

- [ ] **Step 7 — Opening Balances hub.**
  Move earlier if existing books must be onboarded before the other steps.

- [ ] **Step 8 — Currency/FX and Copy Master.**
  Separate projects, not menu items.

## 6. Cross-cutting rules

1. **One ledger.** Cash, bank, AR, AP and inventory all post through the same
   `gl_journals` / `gl_journal_lines` model.
2. **Master data is not a transaction.** Opening balances and stock initialization
   post journals; they are not free-form balance fields.
3. **Do not duplicate party attributes on ledgers.** Credit limits, credit days,
   areas and agents belong to the party or sales document.
4. **Do not fake a dimension with a branch.** Cost centers, areas and godowns are
   distinct from branches.
5. **Keep routes stable.** Move sidebar entries, not URLs, unless a route is
   genuinely wrong.
6. **No dead links.** Add a navigation entry only when its screen exists.
7. **Permissions.** Accounting masters use `gl-view` to read and `gl-manage` to
   write. The cash/bank settlement picker is the one read exception: it accepts
   `gl-view`, `sales-invoice-create` or `inv-pay` so a receipt/payment writer can
   choose an account without receiving the full chart. Opening balances use
   `gl-post`. Document numbering stays under `admin-fiscal` until it is
   deliberately moved.

## 7. Open decisions

| Decision | Recommendation |
| --- | --- |
| Godown: branch-as-godown or true dimension? | Branch-as-godown until a branch needs multiple stockrooms. |
| Currency: base only or multi-currency? | Base only until foreign-currency accounts or transactions exist. |
| Document Class: numbering series or voucher class? | Start with numbering series; only build voucher classes with a real use case. |
| Copy Master: build or defer? | Defer; the app is single-company. |
| Opening Balances: before or after ledger creator? | Before, if existing books are being migrated. |
