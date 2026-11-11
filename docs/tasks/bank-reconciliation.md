# Bank reconciliation workspace — task note

**Status:** Done
**Created:** 2026-11-08
**Completed:** 2026-11-10

## Goal

A workspace that matches one bank account's statement to the company bank-book
postings, tracks unmatched items and locks a reconciled statement balance.

## Scope model

A bank account is a company-wide `gl_accounts` row with
`account_kind = 'BANK'`. Each bank account is its own GL ledger; several banks
are several bank ledgers. Branches are **not** separate sets of books: they
share the company chart and post to the same bank account. `branch_id` on
`gl_journal_lines` and `gl_subledger_entries` is an analytic/posting dimension,
not ownership of the bank statement or the reconciliation.

The same distinction applies to control accounts. Accounts Receivable is one
company-wide GL control account; customers are subledgers behind it. A
branch-scoped AR aging is a filtered view of the control account's postings,
not a separate GL account per branch. Bank reconciliation follows the same
rule: the bank account + period is the reconciliation unit, while branch is
shown on each book line that makes up the balance.

## What shipped

- **Persistence.** `scripts/schema.sql` section 34b adds
  `bank_statement_lines` and `bank_reconciliation_sessions`. Neither carries a
  `branch_id`. Statement uniqueness is `(bank_account_id, fingerprint)` and a
  session is unique per `(bank_account_id, period_start, period_end)`.
  Statement lines carry a signed amount (positive = deposit, negative =
  withdrawal), import batch/source, and an optional matched journal line
  (unique when present). The AD statement date and session period dates store
  their BS half beside them, derived server-side with `bsDateOrThrow`; the
  unmatched CSV exports both calendars. Sessions carry the statement
  opening/closing balances, period, lock/reopen metadata and actor.
- **Migration.** The section drops the old `branch_id` columns and the
  branch-aware session uniqueness. The local install had zero statement/session
  rows when this correction shipped. An install with rows must review them
  before applying, because one real account statement can no longer be split
  into one duplicate per branch.
- **Account master.** The existing chart's `gl_accounts` rows with
  `account_kind = 'BANK'` are the bank-account master (name, bank name, branch,
  number, holder). No duplicate `bank_accounts` table was introduced.
- **Import.** `POST /api/accounting/bank-reconciliation/import` accepts CSV or
  OFX/QFX content. CSV understands common date/description/reference/amount
  aliases plus debit/credit columns; OFX reads `STMTTRN` records. Re-importing
  the same account/date/amount/reference creates no duplicate rows. Invalid
  rows are reported without discarding valid rows; imports are capped at 2 MB
  and 5,000 rows. Importing into a locked period returns 409.
- **Matching.** Exact signed amount match against any posted line on the
  selected bank ledger, regardless of the line's branch, with a suggested
  candidate within a 14-day window. Manual match/unmatch is audited and
  refuses a locked period, a line on another account, or a book line already
  claimed by another statement line. The matched branch is returned on the
  statement line and the branch is returned on every book entry.
- **Sessions.** `POST /api/accounting/bank-reconciliation/sessions` saves the
  statement opening/closing balances; overlapping periods are refused for the
  same bank account. Lock freezes match/unmatch and session edits. Reopen
  requires a reason and is separately audited.
  `difference = closing statement balance − book closing balance`; the
  workspace lists the book and statement lines that make it up.
- **UI.** The feature is a second tab inside **Finance → Cash & Bank Book**
  (`/finance/accounting/cash-book`), not a new navigation entry. It renders
  account/period selectors, book/statement/difference/unmatched cards, the
  statement and book tables with match controls and branch columns, period
  balance/lock/reopen controls, CSV/OFX import, and an unmatched-lines CSV
  export (AD and BS date columns). Reconciliation requires the company-wide
  **All Branches** scope; choosing a concrete branch shows guidance instead of
  a branch-filtered workspace.
- **Permissions and scope.** Reads use `gl-view`; imports, matches, unmatch,
  session save, lock and reopen use `gl-cash-close`. All write paths audit via
  `logAuditEvent` in the same transaction. The controller refuses branch-scoped
  users and an explicit concrete-branch request; statement/session rows are no
  longer in `BRANCH_SCOPED_RESOURCES` because they have no branch column.

## Out of scope / limits

- Live bank feeds and automatic journal creation from statement lines.
- The workspace displays at most 1,000 statement lines and 1,000 book entries
  per period and states when the list is truncated; narrow the period for more.
- Branch-level sub-reconciliation (for example a branch manager confirming only
  their own postings) is not a separate ledger control and is not implemented.

## Acceptance verification

- Parser tests (`tests/bankReconciliation.parser.test.ts`) cover CSV aliases,
  debit/credit and type signs, OFX, malformed rows, dates and account-level
  fingerprints.
- Real HTTP + PostgreSQL API tests (`tests/bankReconciliation.api.test.ts`)
  use a dedicated test bank ledger and two branches. They cover one statement
  import, account-level fingerprint dedupe, a company book combining both
  branches, `branchId`/`branchCode`/`branchName` on book lines, same-branch and
  cross-branch match/unmatch, lock refusal, reopen reason, audit rows,
  branch-user 403 on read and write, All-Branches 200, and the absence of
  `branch_id` plus the account/period uniqueness indexes on both tables.
- The AR control test (`tests/accountingAging.api.test.ts`) reads the same AR
  control account for branch A, branch B and company-wide. GL and subledger
  agree at 600/600, 250/250 and 850/850 with zero difference; the chart has one
  AR control account, so each branch is a filtered view, not a separate AR
  ledger.
- Mounted UI test (`tests/accountingWorkspaceRoute.test.ts`) opens the second
  tab in **All Branches**, renders two book rows and a matched statement line
  with `BKRB`/`BKRO` branch metadata, and verifies the company-wide workspace
  and export controls load without a branch query.
- `tests/budgetVariance.api.test.ts` owns a throwaway database, so its
  company-wide `ALL` reads cannot see another parallel suite's journals. It
  passes 15/15 alone; the four-suite proof run is 49/49.
- Full `npm test`: 2,133 tests across 479 suites — 2,131 pass, 2 Windows-only
  skips, 0 fail.
- Live HTTP check: the restarted server answered 200 for the Cash & Bank Book
  route. The reconciliation panel was not visually re-inspected after the
  correction; its mounted DOM test is the UI verification for this slice.

## Next action

No open bank-reconciliation work. Future additions are separate slices (for
example live feeds or statement-to-journal adjustment posting).
