# Round 11 — Cash receipts, voucher classes and non-trade funding

Status: `[—]` superseded 2026-11-17 by [Round 15](../2026-11-17-advisory-hardening/README.md) (Part B) · Opened 2026-11-14 · Owner: main

Goal: make every way money enters the business auditable and correct, not just
the customer-invoice path. The round covers partial customer receipts, the
difference between a receipt document and a manual journal, the numbering of
cash/bank vouchers, and owner/third-party money that is a loan rather than
sales.

## Why this round exists

The 2026-11-14 audit found that the Cash & Bank Entry screen looks like the
legacy cash/bank voucher but posts a general-ledger journal:

- it derives `CASH_RECEIPT` / `CASH_PAYMENT` / `CASH_BANK` from the line
  amounts, not from the selected voucher type;
- it does not create a `customer_payments` or `vendor_payments` document;
- it cannot allocate a receipt to an invoice, so the customer ledger can show a
  credit while the invoice remains open;
- manual cash/bank journals use `RV` / `PV` / `CB` with a fiscal-year and
  global sequence, bypassing Document Classes & Numbering;
- the register has no class for non-customer/non-vendor money at all.

The customer receipt path is already the correct lane for AR settlement. The
work is to make it safe for partial receipts and to add a separate, correct
lane for non-trade funding.

## Decisions

1. **Customer receipts and vendor payments stay dedicated documents.** They
   allocate to an invoice/bill, update the party subledger and produce
   `CR` / `BR` / `CP` / `BP` numbers. Journal Entry is not the universal entry
   screen.
2. **Cash & Bank Entry is for direct cash/bank movements.** It uses explicit
   receipt/payment/contra classes; it must not silently create an unallocated
   AR/AP credit.
3. **One receipt may cover several invoices.** The correct long-term shape is
   a receipt header plus allocation rows; a single `invoice_id` is only the
   compatibility path.
4. **Overpayment is not silently posted to an invoice.** The receipt is capped
   at the open invoice balance, or the excess is explicitly an unapplied
   customer advance. The invoice's `amount_paid` never exceeds its total.
5. **Loans are liabilities, not trade payables.** A lender is not a supplier;
   owner capital is not a loan. The chart needs a Loan Payable control account,
   a lender master and a lender subledger.
6. **Posted history is append-only.** Corrections are reversals and
   reclassification journals, never edits or renumbering.

## Work slices

### REC-1 — Partial receipt guard and invoice lock

Priority: P0 · Status: `[x]`

- [x] Lock the invoice row while a receipt is applied (`FOR UPDATE`).
- [x] Refuse a receipt on a cancelled/non-posted invoice.
- [x] Refuse a receipt larger than the invoice's remaining balance; name the
      excess and point at an unapplied advance.
- [x] Show “Remaining” in the Record Payment dialog and cap the amount.
- [x] Add a focused API test for the overpayment refusal; the existing receipt
      test covers the exact-payment case. Partial payment has no separate test
      yet.
- [x] Add a concurrency test where two receipts race the same balance, and
      two reversals race the same receipt; the receipt update is also
      conditional on the open balance so a lost lock cannot over-allocate.

Acceptance: 360 invoice → 100 receipt = `PARTIAL`, paid 100, balance 260;
260 receipt = `PAID`, balance 0; 400 receipt is refused before any row or
journal is written; a cancelled invoice cannot receive money.

### REC-2 — Receipt allocations and receive-from-ledger

Priority: P1 · Status: `[x]`

- [x] Add `customer_payment_allocations(payment_id, invoice_id, amount)`.
- [x] Allow one receipt to allocate across several invoices; unallocated
      remainder is an explicit customer advance.
- [x] Reverse allocations with the receipt; never edit the original receipt.
- [x] Add a **Receive Payment** action to Customer Ledger, with an open-invoice
      list and an allocation preview.
- [x] Backfill existing single-invoice payments into allocation rows.

Acceptance: a 500 receipt can settle 300 + 200 across two invoices; a 100
receipt against a 360 invoice leaves 260; a reversal restores every allocated
invoice and the ledger; an unapplied receipt appears as an advance, not as a
fake invoice payment.

### CASH-1 — Explicit cash/bank classes and numbers

Priority: P1 · Status: `[x]`

- [x] Replace the ambiguous “Cash / Bank Voucher” default with explicit
      Receipt, Payment and Contra kinds.
- [x] Derive the document class from the kind and the selected custody ledger:
      `CR` cash receipt, `BR` bank/wallet receipt, `CP` cash payment,
      `BP` bank/wallet payment, `CT` contra.
- [x] Send the class to `postJournal`; a supplied class is issued through
      `issueNextDocNumber`, not the fiscal-year global journal sequence.
- [x] Make the server infer the same class for API callers that omit
      `documentType`; remove the old `RV` / `PV` / `CB` fallback for manual
      sources.
- [x] Refuse AR/AP control lines in Cash & Bank Entry or route them to the
      receipt/payment document; do not allow a naked unallocated AR/AP credit.
- [x] Add a contra test proving two custody ledgers, one balanced journal and
      one `CT` number.

Acceptance: a cash receipt is `CR-…`, a bank receipt is `BR-…`, a cash payment
is `CP-…`, a bank payment is `BP-…`, a custody transfer is `CT-…`; every number
is branch/date/counter and appears in Document Classes & Numbering.

### NUM-1 — One auditable numbering scheme

Priority: P1 · Status: `[x]`

- [x] Manual Journal Entry uses the configured `JV` class.
- [x] Remove or redefine `RV` / `PV` / `CB`; they are not business classes.
- [x] Add `CT` and `PR` to the register.
- [x] Add the remaining stock/warranty classes the system actually issues
      (`DMG`, `PLT`, `SALE`, `CON`, `DSP`; `WC`/`EXC` were already registered).
- [x] Validate explicit invoice/import overrides: correct prefix, matching
      fiscal period (or exact branch/day for the canonical shape), no duplicate,
      and no reuse of a retired number. Customer/vendor payment creates still
      always issue a register number.
- [x] Fail closed when the database sequence is unavailable; the in-memory and
      timestamp/random fallbacks are gone.
- [x] Keep historical numbers as legacy; no posted document was renumbered.

Acceptance: every posted business voucher has exactly one register-issued
number; changing a prefix in Document Classes & Numbering changes the next
number for the operation that owns it; invoice and import creates either issue
from the sequence or accept an override that passes the same prefix/period/
duplicate/retirement checks; a sequence that cannot allocate refuses the
document instead of inventing a number.

### LEND-1 — Owner and third-party unsecured loans

Priority: P1 · Status: `[x]`

- [x] Add a **Lender** master: `id`, `code`, `name`, `lender_type`
      (`OWNER`, `RELATED_PARTY`, `OTHER`), PAN, phone, address, active.
- [x] Add a `LENDER` subledger type and a `LOAN_PAYABLE` posting role.
- [x] Add a liability group **Loans & Borrowings** and a control ledger
      **Loan Payable — Unsecured**, with `subledger_type = LENDER`.
- [x] Add a **Loan Register** per lender: principal, interest rate, start date,
      maturity, security (unsecured), status, repayment schedule.
- [x] Add **Loan Receipt**: `Dr Cash/Bank`, `Cr Loan Payable` (lender).
- [x] Add **Loan Repayment**: `Dr Loan Payable`, `Dr Interest Expense`,
      `Cr Cash/Bank`; withhold TDS on interest where the lender is a person
      and the law requires it.
- [x] Add a lender statement and a control tie-out
      `Loan Payable = sum(lender books)`.
- [x] Distinguish owner capital from a loan: capital is equity, drawings are
      equity, a loan is a liability with a lender and repayment terms.

The master, loan register, receipt/repayment documents and lender statement
are complete. A lender is created with its own `LENDER` book under **2350 Loan
Payable — Unsecured**; Journal Entry offers the lender picker, and the
statement reads the posted book rows with an opening/movement/closing and a
GL-versus-subledger tie-out. A **Loan Receipt** debits cash/bank and credits
the lender book; a **Loan Repayment** debits the book, charges **6700 Interest
Expense — Borrowings**, withholds **2360 TDS Payable — Lender Interest** where
required, and credits cash/bank for the net amount. Both documents post
through the normal journal path and link their voucher to the loan record.

Acceptance: NPR 100,000 from a person is not posted to AP or customer AR; it
credits Loan Payable under that person's lender book, appears in the lender
statement, and a repayment reduces the book without touching trade payables.

### DATA-1 — Correcting a receipt already posted the wrong way

Priority: P0 · Status: `[x]` documented

- [x] Reverse the manual cash/bank journal from Posted Vouchers.
- [x] Record the receipt again through the customer receipt flow.
- [x] Never delete the original journal or edit `amount_paid` by hand.
- [x] For a receipt applied to the wrong invoice, reverse it and re-record it
      against the correct invoice; do not renumber history.

## Loan model detail

Use a separate liability control, not AP:

```text
LIABILITIES
  Current Liabilities
    Loans & Borrowings
      Loan Payable — Unsecured     control, LENDER subledger
        L-001  Ramesh Shrestha    lender book
        L-002  Sita Devi          lender book
```

Owner money:

```text
Owner brings NPR 100,000 of his own money:
  Dr Cash/Bank                 100,000
      Cr Owner Capital                 100,000     (equity, not a loan)

Owner brings NPR 100,000 collected from a third person:
  Dr Cash/Bank                 100,000
      Cr Loan Payable — that person    100,000     (liability, lender book)
```

If the owner borrows personally and then lends to the company, there are two
separate relationships: the third person → owner, and owner → company. The
company records only the second, with the owner as lender. Do not put the third
party's name on the company's book unless the company is the borrower.

Loan repayment:

```text
Repay NPR 50,000 principal + NPR 5,000 interest:
  Dr Loan Payable              50,000
  Dr Interest Expense           5,000
      Cr Cash/Bank                     55,000
```

Interest is an expense, not a reduction of the loan principal. TDS on interest
is a separate liability line when applicable. A loan conversion to equity is a
reclassification journal, not a repayment.

Minimum documents for each loan:

- lender identity and PAN;
- loan agreement / promissory note reference;
- principal, disbursement date and custody account;
- interest rate, compounding and payment frequency;
- maturity or repayment-on-demand terms;
- security type: unsecured;
- repayment schedule and TDS treatment;
- approvals and audit trail.

## Order of work

1. REC-1 — stop overpayment and race conditions on the existing receipt path.
2. CASH-1 — make the cash/bank classes and their numbers truthful.
3. REC-2 — allocations and Receive Payment from the ledger.
4. NUM-1 — one numbering scheme for every voucher. *(done)*
5. LEND-1 — lender master, Loan Payable control, receipts and repayments.
   *(only remaining scope)*

## Gates

- `npx tsc --noEmit`
- focused API/repo tests for each slice
- `npm run check:no-inline-sql`
- `npm run check:no-raw-dialogs` when dialogs change
- `npm run build` and `npm run check:bundle-budget` when client code changes
- full `npm test` at round close

## Current status

- REC-1 is complete: receipt allocation locks every invoice deterministically,
  the balance check and conditional update are one race-safe unit, and the
  reversal path locks the payment status before restoring invoices. Two
  concurrent receipts and two concurrent reversals now pass against real HTTP
  and PostgreSQL.
- REC-2 allocation table, multi-invoice receipt, unapplied advance, reversal
  and Receive Payment dialog are complete; the multi-invoice test passes.
- CASH-1 explicit kinds and register-issued classes are complete; the server
  infers manual classes, refuses AR/AP control lines on manual cash/bank
  vouchers, and refuses a contra that leaves custody. The two-custody-ledger
  `CT` test passes.
- NUM-1 is complete: invoice and import-created documents accept validated
  operator overrides, every sequence refuses when it cannot allocate, and the
  legacy `PV`/`RV`/`CB`/in-memory/random paths are gone. `document_number_retirements`,
  migration `0020`, and stock classes migration `0021` are applied.
- LEND-1 foundation: `LENDER` subledger, `LOAN_PAYABLE` role and the control
  account are seeded. **Only the lender master, loan register and lender
  statement/receipt/repayment scope remains open.**

## Verification (2026-11-14)

- `npx tsc --noEmit` passes.
- `tests/paymentCashBook.api.test.ts`: 12 tests, 0 failures, including the new
  two-concurrent-receipts + two-concurrent-reversals test. It proves exactly
  one receipt posts, `amount_paid` stays at the single payment, the losing
  request leaves no header, exactly one contra journal posts, and the invoice
  is restored once.
- Regression proof for REC-1: with the invoice `FOR UPDATE` lock and the
  conditional balance guard temporarily removed, the same test failed with
  both receipts posting `201` (two payment rows, invoice pushed past its
  total). Restoring the lock + guard makes it pass again.
- `tests/invoiceAccounting.api.test.ts`: 7 tests, 0 failures, including valid
  invoice/import overrides, duplicate refusal, wrong-prefix and wrong-period
  refusal, and reuse refusal after cancellation retires a number.
- `tests/documentNumber.service.test.ts`: 7 tests, 0 failures. A failing
  sequence client is refused with `503` and the message says nothing was
  posted (including through `resolveDocumentNumber` for an auto-numbered
  create); the server helper refuses unavailable and unconfigured series;
  prefix/period/canonical branch-day/retirement validation is covered.
- `tests/docnumber.concurrency.test.ts`: 2 tests, 0 failures (24 parallel
  claims produce 24 distinct, gapless numbers).
- Focused returns/statements/inventory/fixed-asset/PDF/authorization/purchase
  warranty suites all pass; PDF was rerun after its filename expectation was
  updated for the new valid document numbers.
- UI guard suite (`registerRefreshDomains`, `df14LedgerRefresh`,
  `directoryPickers`, `voucherScreens`): 58 tests, 0 failures.
- `npm run build`, `npm run check:no-inline-sql` and
  `npm run check:no-raw-dialogs` pass.
- `npm run check:bundle-budget` was deliberately not rerun or chased here; it
  was already over before this round (last recorded: entry ~22.6 kB gzip
  against a 22 kB budget, startup 322.4 kB against 322 kB). It remains a
  pre-existing baseline issue, not part of this turn's scope.
- The Customer Ledger Receive Payment dialog compiles and its API path is
  tested, but it has not been visually inspected in a browser.

Verified on 2026-11-14: `npx tsc --noEmit`, `check:no-inline-sql`, the
accounting, payment and numbering test files, the UI guard suite, and
`npm run build` all pass. The only remaining scope in this round is LEND-1's
lender master, loan register, loan receipt/repayment documents and lender
statement. History was not renumbered.
