# Round 10 — Accounting as the financial spine of inventory operations

Status: `[x]` complete · Opened 2026-11-12 · Owner: main
Goal: make every inventory operation financially complete, branch-aware and
reconcilable, without turning the general ledger into a stock-quantity ledger.

## Why this round exists

The accounting module already has a sound compact core: one company chart of
accounts, posted journals, party subledgers, bank reconciliation and a group →
sub-group → ledger hierarchy. The gap is not “add a GL”. The gap is that some
inventory-facing reads and documents still behave as if accounting were a
separate reporting module:

- the customer/vendor ledger screens rebuild their balances from operational
  documents instead of reading the posted subledger;
- the daily cash close includes bank accounts, so a physical till count cannot
  tie to it;
- eSewa, Khalti and Nepal Pay are treated as ordinary bank settlements, with no
  wallet clearing balance, fee, or settlement reconciliation;
- branch is an analytical dimension, but custody accounts have no branch
  ownership, so a branch “bank book” is only that branch’s movement through a
  shared bank account;
- there is no single coverage check proving that every inventory value movement
  posts to the ledger in the same transaction.

This round fixes those gaps and makes the integration rule explicit.

## Architecture correction (important)

The user’s intent is right — inventory is not an isolated module — but four
terms need to stay separate:

| Concept | Source of truth | Not the source of |
| --- | --- | --- |
| Stock quantity and availability | Inventory stock ledger (`inventory_stock`, stock operations) | General ledger balance |
| Financial value, debt and obligations | Posted journals + subledgers | Stock quantity |
| Customer and supplier identity | Customer/supplier masters | Chart-of-accounts groups |
| Branch and employee assignment | Organisation master + HR employee master | General ledger |
| Permissions | Auth/RBAC | HR employee record |
| Financial account structure | Chart of accounts (control accounts, posting roles) | Customer/vendor identity |

The correct rule is:

> **Accounting is the financial system of record. Inventory is the quantity
> system of record. Every inventory operation that changes value or creates an
> obligation must post a balanced journal in the same transaction. Inventory
> availability must never be read from the general ledger.**

So “read accounting in every inventory operation” means:

- read the chart’s posting roles and the branch/party context;
- post the financial effect atomically;
- reconcile operational totals to the ledger.

It does **not** mean:

- read the inventory GL account to decide whether stock exists;
- create a GL account per customer or supplier;
- create a separate ledger set per branch;
- let HR or permissions data replace the accounting control account.

Specific corrections to the original explanation:

1. **The chart of accounts does not give us customers/vendors.** It gives the
   control accounts and posting rules. Customer/vendor identities live in their
   masters; they attach to the control account as subledger parties.
2. **HR does not give us branches or permissions.** Branch is an organisation
   master; HR assigns employees to branches; authentication/authorisation grants
   permissions. HR should feed employee and branch assignment into accounting,
   not become the permission system.
3. **Accounting should not be the core source of stock quantities.** It is the
   core source of financial values. Stock availability remains an inventory
   read, reconciled to the inventory control account.
4. **Branch is not a separate set of books.** One company GL with branch as an
   analytical dimension is correct. Separate branch books would duplicate the
   chart and break consolidation.

## Five mandatory accounting rules

These rules are part of the target model. A slice that violates one is not done,
even if its happy-path tests pass.

### R1 — Posted ledgers are append-only (ACC-1, ACC-1b)

`gl_journals`, `gl_journal_lines` and `gl_subledger_entries` are immutable once
posted. No runtime code may `UPDATE` or `DELETE` them. A correction is a new,
balanced journal that links to the original through `reversal_of_id`; it carries
its own posting date and its own period, and it is never backdated into the
original period. The original row remains visible for the audit trail.

ACC-1 removes the remaining runtime rewrite paths (party-book reassignment and
the unused `JOURNAL_MARK_REVERSED_SQL`) and adds a source guard that fails when a
new mutation statement appears. ACC-1b adds the database trigger that refuses
`UPDATE`/`DELETE` on posted rows even for a direct SQL client. Test fixtures
opt in only through a session-local `inventory.allow_ledger_purge=on` startup
option injected by `scripts/run_tests.mjs`; application and dev connections
never receive it. Schema-maintenance blocks set the same flag locally so an
idempotent re-apply can still backfill derived BS dates.

Party books are therefore a **read-time attribution** of posted rows by
`(control account, party)`, not a mutable `subledger_id` pointer that gets moved
when a book is generated. Generating a party book must never rewrite history.

### R2 — Unapplied receipts, advances and credit notes (ACC-1)

A party subledger must support movements without an open document:

- customer receipt not tied to an invoice → credit AR, debit cash/bank/wallet;
  the credit balance is the customer advance / unapplied receipt;
- vendor payment in advance of a bill → debit AP, credit cash/bank; the debit
  balance is the vendor prepayment;
- sales return / credit note → credit AR (or debit AP for a purchase return)
  without requiring the original invoice to still be open;
- a later allocation applies the advance or credit note against an invoice by
  posting the allocation journal, never by editing the original receipt.

The party statement shows the unapplied row and its running balance. The
control tie-out remains `sum(party subledger) = AR/AP control`; an unapplied
receipt changes the sign of the party balance, not the accounting equation.

### R3 — Nepal tax and withholding lines (ACC-3, ACC-4)

The posting matrix must name the tax account for every taxable event, not fold
it into revenue, expense or the party balance:

| Event | Tax / withholding line |
| --- | --- |
| Taxable sale | Cr VAT Output (13% or the document rate) |
| Taxable purchase | Dr VAT Input |
| Taxable PSP/bank fee | Dr fee expense; Cr VAT Output where the fee is taxable |
| Vendor payment for goods/services subject to TDS | Dr AP gross; Cr TDS Payable; Cr cash/bank net |
| Employee payroll | Cr TDS Payable on salary; Cr SSF Payable (employee + employer); Cr Salary Payable net |
| VAT return / deposit | Dr VAT Output; Cr VAT Input; Cr/Dr VAT Payable or refundable; bank on deposit |
| TDS deposit | Dr TDS Payable; Cr bank |

Every tax line carries a source document, a period and a branch. A tax account
is never a party subledger and never absorbs a customer/supplier balance.

### R4 — Branch-balanced journals and stock transfers (ACC-2, ACC-4)

One company GL, with branch as an analytical dimension. Every journal must be
balanced company-wide **and** every branch-level trial balance must net to zero
for the accounts that branch owns. For an inter-branch stock transfer, post the
explicit destination/source movement:

```text
Dr  Inventory — Destination Branch       value
    Cr  Inventory — Source Branch                 value
```

If goods are in transit, use a named in-transit clearing account instead of
leaving the destination debited before receipt; clear it when the destination
receives. Never post a transfer as a single branchless inventory line, and never
let a shared custody account turn a branch filter into a fictitious branch
balance.

### R5 — Costing method and valuation drift guard (ACC-4)

The inventory costing method is **moving weighted average, per product and per
branch**, stored in `inventory_stock.average_cost` and re-weighted inside the
same locked SQL statement that receives or issues stock. COGS and inventory
relief use the average in force at the moment of issue; the movement row and the
journal use the same unit cost.

A late purchase price, a backdated receipt or a corrected bill must not leave
`inventory_stock` value different from the Inventory GL control. ACC-4 defines
the adjustment path:

1. revalue the affected stock rows at the corrected moving average;
2. post an automatic inventory/COGS adjustment journal for the value delta,
   with the source document and the original receipt date in the memo;
3. keep the adjustment in the current open period (never rewrite a closed one);
4. run the reconciliation `inventory valuation by branch/product = INVENTORY
   control` and fail the close when the difference is not zero.

## Audit findings this round must close

| # | Finding | Evidence | Impact |
| --- | --- | --- | --- |
| F1 | Customer ledger is built from invoices, returns and payments, not `gl_subledger_entries` | `server/src/controllers/sales.controller.ts` customer-ledger handler | Customer statement can differ from AR control; opening/manual journals are invisible |
| F2 | Vendor ledger follows the same operational-document pattern | `server/src/controllers/procurement.controller.ts` vendor-ledger handler | AP statement can differ from AP control |
| F3 | The customer ledger has a silent in-memory fallback when the DB read fails | same handler, catch block | A failed ledger read still returns a plausible but stale ledger |
| F4 | Daily cash close includes `CASH` **and** `BANK` accounts | `CASH_BRANCH_FIGURES_SQL` in `server/src/models/cashClose.repo.ts` | Physical cash variance is wrong by the bank balance |
| F5 | `account_kind` supports only `CASH`, `BANK`, `OTHER` | `scripts/schema.sql`, `server/src/models/accounting.repo.ts` | No wallet/PSP clearing account |
| F6 | Every non-cash method settles through `BANK`; `ONLINE` has no provider or fee | `server/src/services/paymentPosting.service.ts` | eSewa/Khalti/Nepal Pay balances and fees are invisible |
| F7 | Bank reconciliation accepts only `account_kind = 'BANK'` | `server/src/models/bankReconciliation.repo.ts`, panel copy | No PSP statement reconciliation |
| F8 | `gl_accounts` has no branch owner; branch is only on journal lines | `scripts/schema.sql` | Branch bank book is movement, not a bank balance |
| F9 | Group/sub-group hierarchy already exists and works | `gl_account_groups.parent_id`, `ChartView.tsx` | No schema rebuild needed; only default layout and navigation polish |
| F10 | AR/AP control + party subledger already exists | `gl_accounts.is_control`, `gl_subledgers.party_id` | Keep this model; fix the reads, do not replace it with per-customer GL accounts |

## Target model

### Chart shape

```text
ASSETS
  Current Assets
    Cash & Cash Equivalents
      Cash on Hand — Branch A          CASH, branch-owned
      Cash on Hand — Branch B          CASH, branch-owned
    Bank Accounts
      NIC Asia — Operating             BANK, shared
      Nabil — Collection               BANK, shared
      Rastriya Banijya — Payroll       BANK, shared
      Nepal Investment — Branch B      BANK, branch-owned (optional)
    Payment Provider Clearing
      eSewa Clearing                   WALLET, provider ESEWA
      Khalti Clearing                  WALLET, provider KHALTI
      Nepal Pay Clearing               WALLET, provider NEPAL_PAY
    Trade Receivables
      Accounts Receivable              control, CUSTOMER subledger
    Employee Advances                  control, EMPLOYEE subledger
    Inventory                          control or ordinary, INVENTORY
    Deployed CPE Assets

LIABILITIES
  Current Liabilities
    Trade Payables
      Accounts Payable                 control, SUPPLIER subledger
    Duties & Taxes
      VAT Output
      TDS Payable
      SSF Payable
```

P&L remains a group/sub-group tree:

```text
Revenue
  Internet Service Revenue
  Installation Revenue
  Other Income
Cost of Sales
  Bandwidth Cost
  CPE Cost
Operating Expenses
  Salaries
  Rent
  Electricity
  Payment Processing Fees
```

### Custody account rule

- `CASH` accounts are branch-owned. A till belongs to one branch.
- `BANK` accounts may be shared (`branch_id IS NULL`) or branch-owned.
- `WALLET` accounts may be shared or branch-owned.
- A journal line using an owned account must carry the same `branch_id`.
- A shared account accepts lines from any branch; branch remains an analytical
  dimension, and the account balance is company-wide.
- Bank/PSP reconciliation is per external account + period, never per branch.
  Branch is displayed on the matched lines, not used to split the statement.

### Wallet accounting rule

```text
Customer pays NPR 1,000 through eSewa:
  Dr  eSewa Clearing                  1,000
      Cr  Accounts Receivable                  1,000

eSewa settles NPR 980 to the bank, retaining NPR 20 fee:
  Dr  Bank                              980
  Dr  Payment Processing Fee              20
      Cr  eSewa Clearing                       1,000
```

If settlement is pending, the clearing account carries the balance. That is the
figure reconciled to the provider statement.

## Work slices

Each slice gets its own note when implementation starts. This README is the
round index; it is not a substitute for the slice’s acceptance checklist.

### ACC-1 — Ledger truth: party ledgers read the subledger

Priority: P0 · Depends on: none · Blocks: ACC-4 reporting

**ACC-1b** is this slice's database half (rule R1): the trigger on
`gl_journals`, `gl_journal_lines` and `gl_subledger_entries` that refuses
`UPDATE`/`DELETE` on posted rows for any client, with the session-local
`inventory.allow_ledger_purge` bypass for schema maintenance and test fixtures.
It is tracked under ACC-1 so `ACC-7` keeps its single meaning — the migration,
demo-data and rollout slice.

- [x] Add a shared party-ledger read over `gl_subledger_entries` + `gl_journals`
      + `gl_journal_lines`, with `party_id`, `subledger_id`, branch and date
      filters.
- [x] Route the customer ledger through it; keep invoice/payment/return data as
      enrichment, not as the debit/credit source.
- [x] Route the vendor ledger through it the same way.
- [x] Add a tie-out block: the party closing balance, the account-level AR/AP
      control balance, the whole-subledger balance and the difference.
- [x] Include opening-balance journals, manual AR/AP journals, unapplied
      receipts/advances and credit/debit notes.
- [x] Remove the silent in-memory fallback on the DB path; return a real error.
- [x] Remove runtime journal/subledger rewrites and make party-book generation
      a read-time attribution (R1).
- [x] Add a regression test that posts an opening balance, a manual journal, an
      invoice, a receipt and an unapplied advance, then proves the party ledger,
      subledger and control agree.
- [x] Add the ACC-1b database immutability trigger on journals, lines and
      subledger rows, with a test-only maintenance bypass.

Acceptance: for the same customer/supplier, branch and date window, the party
ledger closing balance equals the sum of that party’s subledger entries; the
account-level control tie-out compares the GL control with **all** party books
on the account (not with one party) and its difference is zero.

### ACC-2 — Cash, bank and wallet custody

Priority: P0/P1 · Depends on: ACC-1 for receipt links · Blocks: PSP reconciliation

- [x] Split the Cash & Bank Book into **Cash Book**, **Bank Book**, **Wallet
      Clearing** and **Bank reconciliation** views.
- [x] Make daily cash close read only `account_kind = 'CASH'`; add a separate
      `GET /api/accounting/bank-position` read.
- [x] Add `WALLET` to `account_kind` and custody metadata:
      `provider_code`, `merchant_id`, `settlement_account_id`.
- [x] Seed one clearing ledger per provider in the default chart (`1030` eSewa,
      `1040` Khalti, `1050` Nepal Pay).
- [x] Add branch ownership to custody accounts:
      `gl_accounts.branch_id` nullable; `NULL` = shared.
- [x] Validate account owner vs journal line branch on posting and on account
      create/edit.
- [x] Add a per-account Bank Book that shows company balance and branch
      movement separately.
- [x] Add tests for two banks, a branch-owned bank, a shared bank, and a branch
      cash till (`tests/cashCustody.api.test.ts`, `tests/dailyCashClose.api.test.ts`).

Acceptance: a branch cashier’s daily close uses only that branch’s cash tills;
a bank book shows the real bank balance per account; a branch filter never
turns a shared bank’s company balance into a fictitious branch balance.

### ACC-3 — Wallet receipts, settlements and PSP reconciliation

Priority: P1 · Depends on: ACC-2

- [x] Add provider fields to customer payments: provider, provider transaction
      id, gross, fee, net.
- [x] Add `payment_settlements` (wallet ledger, bank ledger, settlement date,
      gross, fee, net, provider reference, journal id).
- [x] Post a wallet receipt at gross to the clearing ledger.
- [x] Post settlement as bank net + fee expense + clearing gross.
- [x] Add refund/chargeback handling: reverse clearing and AR, or route the
      chargeback to expense with an auditable reason.
- [x] Add provider statement import and matching. Prefer generalising the
      existing statement-line engine over building a second matcher.
- [x] Add tests: gross receipt, partial settlement, fee, pending settlement,
      refund, duplicate provider transaction id.
- [x] Add a reconciliation view per provider account + period.

Acceptance: the provider clearing balance equals unsettled gross receipts minus
settled gross; the bank credit plus fee equals the settlement gross; the
provider statement matches without manual re-keying.

### ACC-4 — Inventory-to-finance coverage

Priority: P0 for the matrix/guard, P1 for missing postings · Depends on: ACC-1

This is the “inventory is part of Finance” slice.

- [x] Build an explicit operation coverage matrix for every inventory value
      movement:

      | Operation | Financial effect | Posting service | Same transaction | Reversal | Branch | Party | Cost centre |
      | --- | --- | --- | --- | --- | --- | --- | --- |
      | Purchase invoice | Dr Inventory + VAT Input / Cr AP | `invoicePosting` | yes | document void | yes | supplier | optional |
      | Purchase return | Dr AP / Cr Inventory + VAT Input | `returnPosting` | yes | document cancel | yes | supplier | optional |
      | Sales invoice | Dr AR + COGS / Cr Revenue + VAT Output + Inventory | `invoicePosting` | yes | document void | yes | customer | optional |
      | Sales return | Dr Revenue + VAT Output + Inventory / Cr AR + COGS | `returnPosting` | yes | document cancel | yes | customer | optional |
      | Customer receipt (applied or unapplied advance) | Dr Cash/Bank/Wallet / Cr AR | `paymentPosting` | yes | payment reversal | yes | customer | optional |
      | Vendor payment (including prepayment) | Dr AP gross / Cr TDS Payable + Cash/Bank/Wallet net | `paymentPosting` | yes | payment reversal | yes | supplier | optional |
      | Stock adjustment / damage / pullout / consumable / audit | Dr Stock Expense / Cr Inventory (or reverse) | `stockPosting` | yes | stock reversal | yes | none | optional |
      | Inter-branch transfer | Dr Inventory — Destination Branch / Cr Inventory — Source Branch; in-transit clearing when not yet received | `transferPosting` | yes | transfer reversal | yes | branch | optional |
      | Late/backdated purchase price or bill correction | Revalue stock, then Inventory/COGS adjustment journal for the delta | `inventoryRevaluation` | yes | adjustment reversal | yes | supplier | optional |
      | PSP/bank fee (taxable) | Dr Processing Fee; Dr VAT Input where recoverable; Cr Cash/Bank/Wallet | `paymentPosting` | yes | settlement reversal | yes | none | optional |
      | VAT return / deposit | Dr VAT Output / Cr VAT Input; Cr/Dr VAT Payable; Cr bank on deposit | `taxPosting` | yes | tax reversal | yes | none | optional |
      | TDS deposit | Dr TDS Payable / Cr Bank | `taxPosting` | yes | deposit reversal | yes | none | optional |
      | CPE issue / release | Dr CPE asset / Cr Inventory; reverse on return | `cpePosting` | yes | lifecycle reversal | yes | customer | optional |
      | Fixed asset acquisition / disposal / depreciation | Asset cost, accumulated depreciation, gain/loss | `cpePosting` | yes | disposal/depreciation reversal | yes | none | optional |
      | Warranty vendor credit | Dr AP / Cr Stock Expense or warranty recovery | `warrantyClaim` | yes | claim reversal | yes | supplier | optional |
      | Payroll | Dr Salary Expense / Cr TDS Payable + SSF Payable + Salary Payable + advances | `payrollPosting` | yes | payroll reversal | yes | employee | optional |

- [x] Verify each row against the actual controller transaction boundary, not
      just the service name.
- [x] Add a source-type registry so a new stock mutation cannot ship without a
      declared financial effect (`inventoryPostingRegistry.ts`).
- [x] Add a guard/test that fails when an inventory write path has no posting
      service or an unhandled source type.
- [x] Add idempotency checks on `(source_type, source_id)` at the posting
      boundary for stock-mutation sources, with a 409 on replay. Transfer,
      purchase, sale and CPE families keep their existing document-lifecycle
      guards because their source id is not unique per posting.
- [x] Add missing postings found by the matrix: the review found every current
      inventory value path already posts; the gap was the undeclared source
      registry and the stock-operation receipt alias.
- [x] Add reversal coverage for every posting source; the registry names the
      contra/document/lifecycle reversal and the existing stock tests exercise
      the posted contra journals.
- [x] Add a reconciliation report:
      inventory valuation by branch/product vs `INVENTORY` control balance;
      COGS posted vs sales invoice cost; stock expense vs adjustment/damage
      documents. `GET /api/accounting/inventory-reconciliation` is the report,
      and the period close now refuses a non-zero inventory difference unless
      an override reason is recorded.
- [x] Add a branch/cost-centre default from the employee or branch master.
      Closed by ACC-5: the branch master supplies `default_cost_center_id` and
      the employee master supplies an optional override. Payroll resolves
      explicit line → employee → branch; a manual voucher prefills an empty line
      only. An explicit user-selected centre is never replaced, and an invalid
      centre is refused rather than silently defaulted.

Acceptance: every inventory operation that changes value has a posted journal
in the same transaction, a reversal path, and a reconciliation report. The
coverage guard fails the build if a new operation is added without a declared
financial effect. Valuation is moving weighted average per product/branch, and
the reconciliation `inventory valuation = INVENTORY control` fails the close on
a non-zero difference (R5).

### ACC-5 — Organisation, HR and permissions boundary

Priority: P1 · Depends on: ACC-4

- [x] Document and enforce the boundary:
      HR owns employee identity, branch assignment and employment status;
      auth/RBAC owns permissions; accounting owns posting roles and control
      accounts. The contract and its enforcement points are in
      `docs/organisation-boundary.md`; the HTTP suite refuses an HR write from a
      caller without the HR grant and refuses a permission change from rewriting
      the posted ledger.
- [x] Add branch assignment to custody accounts and employee defaults.
      Custody ownership was added in ACC-2 (`gl_accounts.branch_id`, `NULL` =
      shared, validated on posting); ACC-5 adds the branch default
      (`branches.default_cost_center_id`) and employee default
      (`employees.default_cost_center_id`) with active/in-branch validation.
- [x] Use employee/branch master data for default cost centre and branch, not a
      hard-coded branch. Payroll takes the branch from the payroll run and each
      salary-expense line resolves explicit → employee → branch; the employee
      branch must still match the run branch. Manual voucher lines expose a
      cost centre and prefill only when the line is still empty.
- [x] Add segregation-of-duties checks for inventory adjustments, payments and
      period close where the permission model already supports them. The model
      has separate permission gates for these operations (and for HR identity),
      not a preparer/approver field; `tests/acc5OrganisationBoundary.api.test.ts`
      proves the finance-only permission cannot write HR identity, while the HR
      grant cannot post journals or close a period.
- [x] Add tests proving an HR change cannot grant a permission and a permission
      change cannot rewrite an employee’s ledger. The suite creates an employee
      login as HR, refuses the HR caller a finance permission grant, refuses a
      branch manager without the HR grant the employee write, and reads the
      posted payroll journal before and after a role/permission change to prove
      the ledger is byte-for-byte unchanged.

Acceptance: an employee’s branch and cost-centre defaults flow into postings;
permissions remain an auth concern; no HR write path can alter posted journals.

Evidence: `tests/acc5OrganisationBoundary.api.test.ts` (3/3, real HTTP +
PostgreSQL) covers the two-branch/two-centre payroll split, explicit line
override, invalid-centre 400, employee-master persistence, branch transfer
clearing a stale default, HR login creation, HR permission-grant refusal,
employee-write refusal, close/payment refusal without the gate, and an unchanged
posted journal after a permission change. `tests/acc5OrganisationDefaults.ui.test.ts`
and `tests/hrEmployeeProfile.ui.test.ts` mount the branch and employee default
selectors, prove branch filtering, and capture the saved payloads. Migration
`scripts/migrations/0013_organisation_defaults.sql`; full-suite and
fresh-install counts are recorded in SESSION_NOTES.

### ACC-6 — Chart governance and reporting

Priority: P1/P2 · Depends on: ACC-1, ACC-2

- [x] Add `Trade Receivables` and `Trade Payables` groups to the default chart;
      keep AR/AP as control ledgers under them. The seed creates groups `1110`
      and `2110` under `1000`/`2000`, and migration
      `0014_chart_governance` moves only the still-default AR/AP accounts under
      them. A chart the operator has already reorganised is left untouched.
- [x] Split Chart & Defaults into clear tabs:
      Ledgers · Groups & Sub-Groups · Control Accounts · Posting Defaults ·
      Reconciliation Health. Each tab is a mounted section of the same register,
      not a second chart read.
- [x] Keep arbitrary group depth; do not introduce a second sub-group table.
      The existing `gl_account_groups.parent_id` hierarchy is used by both the
      seeded trade groups and the group tab; there is no sub-group table.
- [x] Add a chart health report:
      control accounts with no book, posting roles with no active ledger,
      retired ledgers still claiming roles, unlinked subledger rows. The last
      category reports both count/amount and a bounded row sample.
- [x] Add party statements and control tie-outs to the reporting surface. Each
      AR/AP aging row opens that party's posted statement in place, including
      the party, GL-control, all-books and difference figures behind the tie-out.
- [x] Add inventory/GL reconciliation and PSP reconciliation to month-end close.
      `INVENTORY_RECONCILE` remains required from ACC-4; migration
      `0015_reconciliation_close_tasks` adds required `PSP_RECONCILE` for existing
      periods and every new period copied from the template.

Acceptance: the chart shows the business structure without per-customer GL
accounts; every control account has a book and a visible tie-out; groups and
sub-groups remain one hierarchy.

Evidence: `tests/acc6ChartGovernance.api.test.ts` (3/3, real HTTP + throwaway
PostgreSQL) proves the seeded group hierarchy and AR/AP placement, a posted
subledger row that lost its book link appearing in chart health with its amount
and sample row, and both reconciliation tasks on a real period checklist.
`tests/acc6ChartGovernance.ui.test.ts` (2/2, mounted) drives all five chart tabs
and opens a party statement from an aging row with its control tie-out.
`tests/accountingWorkspaceRoute.test.ts` keeps the full chart maintenance flow
(create/edit/delete group and account) green through the new tabs.

### ACC-7 — Migration, demo data and rollout

Priority: P2 · Depends on: ACC-1…ACC-6

- [x] Migrate existing installs without rewriting posted history: boot seed
      creates missing custody/wallet ledgers, `0016` backfills party books and
      close tasks, and ambiguous historical online receipts stay in place with
      the limitation documented instead of being silently reclassified.
- [x] Backfill party subledger books before switching ledger reads.
- [x] Update the demo seed with four banks, three wallets, branch tills and
      representative settlement/fee rows.
- [x] Update README, handoff, SESSION_NOTES and table/screen/route counts.
- [x] Run the full gate chain at round close.

## Order of work

1. **ACC-1** — ledger truth. This is the smallest change with the largest
   accuracy gain. Do it first.
2. **ACC-2** — separate cash, bank and wallet custody. This prevents the daily
   close from lying and creates the wallet account.
3. **ACC-3** — wallet settlement and PSP reconciliation. This is the new
   external reconciliation surface.
4. **ACC-4** — inventory coverage matrix and guard. This is the architectural
   “inventory is part of Finance” proof.
5. **ACC-5** — HR/branch/permission boundary and defaults.
6. **ACC-6** — chart layout and reporting polish.
7. **ACC-7** — migration and rollout.

ACC-4’s matrix can be drafted in parallel with ACC-1, but its missing-posting
implementation should wait until the ledger reads are correct.

## Non-goals

- No per-customer or per-supplier `gl_accounts` rows.
- No separate chart of accounts per branch.
- No general ledger as the stock-quantity source.
- No parallel posting path outside `postJournal`.
- No rewriting posted history; corrections are reversals or reclassification
  journals.
- No HR-owned permission system.
- No PSP integration that requires storing provider secrets in the client or in
  plain project files.

## Open decisions

1. Which bank accounts are company-wide and which, if any, are branch-owned?
2. Are eSewa/Khalti/Nepal Pay balances cash equivalents for cash-flow purposes,
   or only clearing assets? The answer changes the cash-flow classification, not
   the ledger structure.
3. Do customers need sub-accounts (site/connection) under one customer book?
   Current model is one book per customer; sub-parties would be a separate
   `subparty_id`/`parent_party_id` feature.
4. Which provider statements are available for import (CSV, Excel, API), and do
   they include gross, fee and net separately?
5. Is branch-level bank reconciliation required, or is company-wide per bank
   account sufficient with branch attribution? Current design is company-wide.

## Verification gates

Before a slice is marked done:

1. `npx tsc --noEmit`.
2. The slice’s own API/repo/UI suites against PostgreSQL.
3. Existing accounting, inventory, auth and schema guards touched by the slice.
4. `npm run check:no-inline-sql`.
5. `npm run check:no-raw-dialogs` when client dialogs change.
6. `npm run build` and `npm run check:bundle-budget` when client code changes.
7. Full `npm test` at round close.
8. Update this note and add a short SESSION_NOTES entry with the commit hash.

## Current status

- `[x]` Five mandatory accounting rules added to this note (R1–R5).
- `[x]` ACC-1 implementation: customer and vendor statements now read posted
      `gl_subledger_entries`, expose `OPENING`/`ADJUSTMENT` lines and return an
      account-level control tie-out; the silent customer cache fallback is gone.
- `[x]` R1 application layer: removed the runtime journal-reversal marker and
      subledger party reassignment; party books attribute posted rows at read
      time. The DB trigger is the remaining ACC-1b item.
- `[x]` ACC-1 verified against PostgreSQL: 38/38 targeted tests pass, including
      the new opening + manual + invoice + receipt + unapplied-advance tie-out.
- `[x]` ACC-1b ledger immutability trigger installed in `scripts/schema.sql`;
      re-applying the schema is idempotent with the trigger present.
- `[x]` ACC-2 implementation: migration `0010_cash_bank_wallet_custody`,
      branch-owned/shared custody accounts, `WALLET` provider metadata, cash-only
      daily close, separate bank position, and split cash/bank/wallet books.
- `[x]` ACC-2 verified against PostgreSQL: 5/5 custody tests plus 6/6 updated
      daily cash-close tests over real HTTP, including a shared bank that keeps
      its company balance under either branch filter and a cross-branch posting
      refusal. Full suite and fresh-install evidence are in SESSION_NOTES.
- `[x]` ACC-3 implementation: migration `0011_wallet_receipts_and_settlements`,
      provider receipt fields, `payment_settlements`, gross wallet receipt,
      net-bank-plus-fee settlement, refund/chargeback, provider statement
      import/matching and a company-wide provider reconciliation view.
- `[x]` ACC-3 verified against PostgreSQL: `tests/walletSettlement.api.test.ts`
      covers gross receipt, duplicate provider id, partial and full settlement,
      provider auto-match, wrong-match refusal, refund, chargeback and branch
      refusal over real HTTP. Full suite and fresh-install evidence are in
      SESSION_NOTES.
- `[x]` ACC-4 implementation: source registry, posting-boundary idempotency,
      branch/product inventory reconciliation, COGS and stock-expense tie-outs,
      and a required `INVENTORY_RECONCILE` close task plus a hard close guard.
- `[x]` ACC-4 verified against PostgreSQL: `tests/inventoryCoverage.api.test.ts`
      drives purchase, sale, stock correction, replay refusal and close-override
      through real HTTP; the existing stock/invoice suites cover each posting
      and reversal. Full suite and fresh-install evidence are in SESSION_NOTES.
- `[x]` ACC-4's deferred branch/cost-centre default is closed by ACC-5. The
      branch and employee masters now supply defaults, payroll splits salary
      expense by resolved centre, and an explicit line centre is preserved.
- `[x]` ACC-5 implementation: migration `0013_organisation_defaults`, branch and
      employee default cost centres, payroll/line resolution, manual-voucher
      per-line centre with defaulting, and the boundary contract in
      `docs/organisation-boundary.md`.
- `[x]` ACC-5 verified against PostgreSQL: `tests/acc5OrganisationBoundary.api.test.ts`
      (3/3) plus the mounted branch/employee UI tests; the existing permission,
      payroll, inventory and ledger-immutability suites remain green.
- No ACC-5 acceptance criterion remains open. A dedicated preparer/approver
  workflow for adjustments, payments and close is intentionally not claimed:
  the current model separates those duties with distinct permission grants, and
  ACC-5 verifies those gates rather than inventing an approval field.
- `[x]` ACC-6 implementation: migrations `0014_chart_governance` and
      `0015_reconciliation_close_tasks`, trade-receivable/payable groups, the
      five-tab chart register, chart health including unlinked rows, party
      statements from aging, and PSP reconciliation at close.
- `[x]` ACC-6 verified against PostgreSQL: `tests/acc6ChartGovernance.api.test.ts`
      (3/3), `tests/acc6ChartGovernance.ui.test.ts` (2/2), the full mounted
      accounting workspace (24/24) and the recurring-close suite. Full suite and
      fresh-install evidence are in SESSION_NOTES.
- No ACC-6 acceptance criterion remains open.
- `[x]` ACC-7 implementation: migration `0016_existing_install_backfill`
      backfills one deterministic party book per posted control-account party and
      the full required close checklist on every existing period, and adds the
      fee constraint migration `0011` missed. Boot seeding creates any missing
      wallet clearing ledger; trade groups stay under their roots, while an
      operator-reorganised AR/AP account is preserved. Historical online
      receipts are left in their posted custody ledger with the limitation in
      `docs/accounting-upgrade-rollout.md`; no ambiguous reclassification is
      posted automatically.
- `[x]` Demo seed expanded deterministically: four banks, three wallet ledgers,
      four branch tills, party books, one unlinked subledger row, one balanced
      employee-advance control difference, one eSewa settlement with a fee, and
      the seven-task checklist on every demo period. The published AR/AP/
      inventory/cash/equity targets are unchanged.
- `[x]` ACC-7 verified against PostgreSQL: `tests/acc7Upgrade.api.test.ts`
      upgrades a schema from commit `1e9bbeb`, preserves operator chart moves,
      backfills books/tasks, replays with zero applied migrations and unchanged
      data, and matches a fresh install's schema signature.
      `tests/acc7DemoSeed.api.test.ts` proves the expanded demo surface and a
      no-op repeat seed. Rollout is linked from the README. Full gate chain and
      fresh-install evidence are in SESSION_NOTES.
- No ACC-7 acceptance criterion remains open. The round is complete.
