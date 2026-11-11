# Recurring journals + month-end close checklist — task note

**Status:** Done
**Created:** 2026-11-08
**Completed:** 2026-11-10

## Goal

Templates for repetitive vouchers (rent, salaries, depreciation, amortisation)
and an ordered, auditable month-end close checklist per period.

## Delivered

- `gl_recurring_templates`, `gl_recurring_template_lines`, `gl_recurring_runs`,
  `gl_close_task_templates` and `gl_close_checklist_items` in
  `scripts/schema.sql` section 34c/34d.
- Branch-owned templates with code, name, frequency, start/end, next/last run,
  active flag, line account/side/memo/party and safe arithmetic amount formulas.
  A formula may contain numbers, `+ - * /`, parentheses and unary signs; it is
  evaluated by a bounded parser, never `eval`.
- Preview resolves the run date's accounting period, evaluates every line and
  reports debit, credit, difference, balance and a skip reason.
- Run posts through the existing `postJournal` service, so generated journals
  are balanced and carry `source_type='RECURRING_JOURNAL'`,
  `source_id=<template id>` and the template reference.
- Idempotency is a unique `(template_id, run_date)` row in
  `gl_recurring_runs`; replay returns `ALREADY_GENERATED` and never posts twice.
  A closed period returns `SKIPPED` with `PERIOD_CLOSED` and does not advance the
  schedule; reopening lets the same due date generate.
- The close tab creates the ordered default checklist for the selected period:
  `BANK_RECONCILE`, `POST_DEPRECIATION`, `REVIEW_AGING` and `ACCRUE_EXPENSES`
  are required; `LOCK_PERIOD` is optional and is set DONE/PENDING by close/reopen.
  Each item stores owner, status, note, evidence URL and completion audit fields.
- The existing close route now calls `closePeriodWithChecklist` in the same
  transaction. Required incomplete items refuse the close with 409; an explicit
  `overrideReason` closes and records `CLOSE_ACCOUNTING_PERIOD_OVERRIDE` with the
  reason. Checklist item updates are audited as `UPDATE_CLOSE_CHECKLIST_ITEM`.
- API: `GET/POST/PATCH/DELETE /api/accounting/recurring-templates`,
  `GET .../:id/preview`, `POST .../:id/run`,
  `GET /api/accounting/periods/:id/checklist` and
  `PATCH .../checklist/:itemId`.
- UI: `client/src/features/finance/RecurringCloseRegister.tsx` at
  `/finance/accounting/recurring-close` (Finance → Recurring & Close), with
  template CRUD, preview, run, pause/resume, delete-unused and the close
  checklist/override/reopen flow.

## Acceptance criteria — checked

- [x] Running a template twice for the same date cannot double-post.
- [x] Generated journals are balanced and carry the template as source.
- [x] Closing a period with an incomplete required task is refused or explicitly
      overridden with a reason.
- [x] Checklist state is auditable and survives refresh.

## Out of scope

- A general workflow engine; reuse the existing approval pattern only if it fits.
- Automatic tax calculations.

## Verification

- `npx tsc --noEmit` — clean.
- `npx tsx --test tests/recurringClose.api.test.ts` — **5/5 pass** over real
  HTTP + PostgreSQL. Covers formula preview and balance, one-journal-per-date
  idempotency, source/line balance in the database, branch/role 403s, checklist
  persistence, 409 refusal, audited override, closed-period skip and reopen.
- `npx tsx --test tests/appPaths.test.ts tests/registerRefreshDomains.test.ts
  tests/schemaSource.parity.test.ts tests/schema.drift.guard.test.ts
  tests/docsCounts.guard.test.ts` plus `tests/screenElementMemo.test.ts` and
  `tests/sidebarGrouping.test.ts` — all pass after the new screen's call pin,
  route count (101) and sidebar entry were added.
- Schema applied to the local PostgreSQL; 95 tables (the five recurring/close tables, the later cash-flow manual-input table and the two warranty-claim tables) are
  readable.

## Next action

No open work remains for this slice.
