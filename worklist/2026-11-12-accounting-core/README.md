# Round 10 — Accounting as the financial spine of inventory operations

Status: `[~]` planning / approval · Opened 2026-11-12 · Owner: main
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

### R1 — Posted ledgers are append-only (ACC-1, ACC-7)

`gl_journals`, `gl_journal_lines` and `gl_subledger_entries` are immutable once
posted. No runtime code may `UPDATE` or `DELETE` them. A correction is a new,
balanced journal that links to the original through `reversal_of_id`; it carries
its own posting date and its own period, and it is never backdated into the
original period. The original row remains visible for the audit trail.

ACC-1 removes the remaining runtime rewrite paths (party-book reassignment and
the unused `JOURNAL_MARK_REVERSED_SQL`) and adds a source guard that fails when a
new mutation statement appears. ACC-7 adds the database trigger that refuses
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

- [ ] Add a shared party-ledger read over `gl_subledger_entries` + `gl_journals`
      + `gl_journal_lines`, with `party_id`, `subledger_id`, branch and date
      filters.
- [ ] Route the customer ledger through it; keep invoice/payment/return data as
      enrichment, not as the debit/credit source.
- [ ] Route the vendor ledger through it the same way.
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
- [x] Add the ACC-7 database immutability trigger on journals, lines and
      subledger rows, with a test-only maintenance bypass.

Acceptance: for the same customer/supplier, branch and date window, the party
ledger closing balance equals the sum of that party’s subledger entries; the
account-level control tie-out compares the GL control with **all** party books
on the account (not with one party) and its difference is zero.

### ACC-2 — Cash, bank and wallet custody

Priority: P0/P1 · Depends on: ACC-1 for receipt links · Blocks: PSP reconciliation

- [ ] Split the Cash & Bank Book into **Cash Book** and **Bank Book** views.
- [ ] Make daily cash close read only `account_kind = 'CASH'`; add a separate
      bank position read.
- [ ] Add `WALLET` to `account_kind` and custody metadata:
      `provider_code`, `merchant_id`, `settlement_account_id`.
- [ ] Seed one clearing ledger per provider in the default chart.
- [ ] Add branch ownership to custody accounts:
      `gl_accounts.branch_id` nullable; `NULL` = shared.
- [ ] Validate account owner vs journal line branch on posting.
- [ ] Add a per-account Bank Book that shows company balance and branch
      movement separately.
- [ ] Add tests for two banks, a branch-owned bank, a shared bank, and a branch
      cash till.

Acceptance: a branch cashier’s daily close uses only that branch’s cash tills;
a bank book shows the real bank balance per account; a branch filter never
turns a shared bank’s company balance into a fictitious branch balance.

### ACC-3 — Wallet receipts, settlements and PSP reconciliation

Priority: P1 · Depends on: ACC-2

- [ ] Add provider fields to customer payments: provider, provider transaction
      id, gross, fee, net.
- [ ] Add `payment_settlements` (wallet ledger, bank ledger, settlement date,
      gross, fee, net, provider reference, journal id).
- [ ] Post a wallet receipt at gross to the clearing ledger.
- [ ] Post settlement as bank net + fee expense + clearing gross.
- [ ] Add refund/chargeback handling: reverse clearing and AR, or route the
      chargeback to expense with an auditable reason.
- [ ] Add provider statement import and matching. Prefer generalising the
      existing statement-line engine over building a second matcher.
- [ ] Add tests: gross receipt, partial settlement, fee, pending settlement,
      refund, duplicate provider transaction id.
- [ ] Add a reconciliation view per provider account + period.

Acceptance: the provider clearing balance equals unsettled gross receipts minus
settled gross; the bank credit plus fee equals the settlement gross; the
provider statement matches without manual re-keying.

### ACC-4 — Inventory-to-finance coverage

Priority: P0 for the matrix/guard, P1 for missing postings · Depends on: ACC-1

This is the “inventory is part of Finance” slice.

- [ ] Build an explicit operation coverage matrix for every inventory value
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

- [ ] Verify each row against the actual controller transaction boundary, not
      just the service name.
- [ ] Add a source-type registry so a new stock mutation cannot ship without a
      declared financial effect.
- [ ] Add a guard/test that fails when an inventory write path has no posting
      service or an unhandled source type.
- [ ] Add idempotency checks on `(source_type, source_id)`.
- [ ] Add missing postings found by the matrix.
- [ ] Add reversal coverage for every posting source.
- [ ] Add a reconciliation report:
      inventory valuation by branch/product vs `INVENTORY` control balance;
      COGS posted vs sales invoice cost; stock expense vs adjustment/damage
      documents.
- [ ] Add a branch/cost-centre default from the employee or branch master, but
      never overwrite a user-selected cost centre silently.

Acceptance: every inventory operation that changes value has a posted journal
in the same transaction, a reversal path, and a reconciliation report. The
coverage guard fails the build if a new operation is added without a declared
financial effect. Valuation is moving weighted average per product/branch, and
the reconciliation `inventory valuation = INVENTORY control` fails the close on
a non-zero difference (R5).

### ACC-5 — Organisation, HR and permissions boundary

Priority: P1 · Depends on: ACC-4

- [ ] Document and enforce the boundary:
      HR owns employee identity, branch assignment and employment status;
      auth/RBAC owns permissions; accounting owns posting roles and control
      accounts.
- [ ] Add branch assignment to custody accounts and employee defaults.
- [ ] Use employee/branch master data for default cost centre and branch, not a
      hard-coded branch.
- [ ] Add segregation-of-duties checks for inventory adjustments, payments and
      period close where the permission model already supports them.
- [ ] Add tests proving an HR change cannot grant a permission and a permission
      change cannot rewrite an employee’s ledger.

Acceptance: an employee’s branch and cost-centre defaults flow into postings;
permissions remain an auth concern; no HR write path can alter posted journals.

### ACC-6 — Chart governance and reporting

Priority: P1/P2 · Depends on: ACC-1, ACC-2

- [ ] Add `Trade Receivables` and `Trade Payables` groups to the default chart;
      keep AR/AP as control ledgers under them.
- [ ] Split Chart & Defaults into clear tabs:
      Ledgers · Groups & Sub-Groups · Control Accounts · Posting Defaults ·
      Reconciliation Health.
- [ ] Keep arbitrary group depth; do not introduce a second sub-group table.
- [ ] Add a chart health report:
      control accounts with no book, posting roles with no active ledger,
      retired ledgers still claiming roles, unlinked subledger rows.
- [ ] Add party statements and control tie-outs to the reporting surface.
- [ ] Add inventory/GL reconciliation and PSP reconciliation to month-end close.

Acceptance: the chart shows the business structure without per-customer GL
accounts; every control account has a book and a visible tie-out; groups and
sub-groups remain one hierarchy.

### ACC-7 — Migration, demo data and rollout

Priority: P2 · Depends on: ACC-1…ACC-6

- [ ] Migrate existing installs without rewriting posted history:
      create new bank/wallet accounts, post reclassification/opening entries,
      keep historical online receipts where they are and disclose the limitation.
- [ ] Backfill party subledger books before switching ledger reads.
- [ ] Update the demo seed with four banks, three wallets, branch tills and
      representative settlement/fee rows.
- [ ] Update README, handoff, SESSION_NOTES and table/screen/route counts.
- [ ] Run the full gate chain at round close.

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
      time. The DB trigger is the remaining ACC-7 item.
- `[x]` ACC-1 verified against PostgreSQL: 38/38 targeted tests pass, including
      the new opening + manual + invoice + receipt + unapplied-advance tie-out.
- `[x]` ACC-7 ledger immutability trigger installed in `scripts/schema.sql`;
      re-applying the schema is idempotent with the trigger present.
- `[~]` ACC-2…ACC-6 are planned but not implemented.
- Next action: start ACC-2 (cash/bank/wallet custody) or ACC-4’s VAT/TDS
  coverage rows, depending on priority.
