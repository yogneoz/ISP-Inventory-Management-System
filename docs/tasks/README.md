# Work tracking — new modules

Living notes for the seven initiatives agreed on 2026-11-08, with the seventh
added on 2026-11-11 after the first six closed. Each note keeps its
own checklist, decisions and next action so work survives a context switch.
Update the note, not just the code, when a slice lands. All seven initiatives
are **Done** as of 2026-11-11.

| Initiative | Note | Status | Next action |
| --- | --- | --- | --- |
| HR module (employee master, attendance/leave, payroll) | [hr-module.md](hr-module.md) | **Done** — Phase 4 complete (onboarding/offboarding) | No Phase 4 work remains |
| Budgets and budget-vs-actual | [budgets.md](budgets.md) | **Done** — tables, API, dashboard variance/editor, prior-year copy, CSV import/export, variance drill-to-lines, branch utilisation cards, dashboard overspend alerts, per-budget lock, immutable history with restore, branch-wise OPEX cost-centre allocation with group overrides and an explicit unallocated actual row landed; seeded demo expense lines and branch allocation profiles make the department preview populated; browser-verified against the BR-KTM FY 2083-84 preview with READY · 5 rules and a reconciled zero-variance matrix | No open work remains for this slice |
| Bank reconciliation workspace | [bank-reconciliation.md](bank-reconciliation.md) | **Done** — company-wide bank-account/period statement import with fingerprint dedupe, exact match/unmatch with audit, session balances with lock/reopen reason, unmatched CSV export, and a Bank reconciliation tab inside Cash & Bank Book that combines every branch and attributes each book line to its branch | No open work remains for this slice |
| Recurring journals + month-end close checklist | [recurring-journals-and-close.md](recurring-journals-and-close.md) | **Done** — branch-owned recurring templates with safe formulas, preview and idempotent run; persisted period checklist with required-task close gate, audited override and reopen; register screen at `/finance/accounting/recurring-close` | No open work remains for this slice |
| Cash-flow print/PDF and forward forecast | [cash-flow-forecast.md](cash-flow-forecast.md) | **Done** — print/PDF, weekly AR/AP forecast, recurring journals, unpaid payroll commitments and branch-owned manual inputs with closed-period exclusions | No open work remains for this slice |
| Warranty claims/RMA lifecycle | [warranty-claims.md](warranty-claims.md) | **Done** — two claim/event tables, shared state machine, stock/RMA/repair effects, vendor-credit journal, audited register/detail with filters and SLA, and mounted/API proof | No work remains for this slice |
| Warranty recovery follow-up | [warranty-recovery.md](warranty-recovery.md) | **Done** — derived RMA-aging and vendor-credit shortfall queue with AP posting reconciliation inside the existing warranty registers; focused API/UI proof, guards, live port-3000 route and full suite green | No work remains for this slice |

## Rules

- A note's **Status** is one of `Planned`, `In progress`, `Blocked`, `Done`.
- Every slice ends with its acceptance criteria checked and the verification
  commands recorded in the note.
- Do not store employee personal data, credentials or customer PII in a note.
- Reference files and tests by path, not by copied content.
