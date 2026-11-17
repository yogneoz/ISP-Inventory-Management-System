# Documentation

One index so a working session does not have to guess which note is current.
Current-state numbers belong in `README.md`, `handoff.md` and `SESSION_NOTES.md`;
the rest of this folder is dated evidence unless listed under **Current**.

## Current

| Document | What it is |
|---|---|
| [audit-2026-11-15.md](audit-2026-11-15.md) | The readiness audit. The only current audit; it supersedes the 2026-11-04 report. |
| [architecture-backlog.md](architecture-backlog.md) | Open architectural decisions and the reasons they are parked. |
| [database-optimization-audit-2026-11-17.md](database-optimization-audit-2026-11-17.md) | Current database audit: what is optimised, what each remaining suggestion costs, and the trigger that reopens it. |
| [tasks/](tasks/README.md) | The seven initiative notes; all **Done** as of 2026-11-11. |
| [session-notes/](session-notes/README.md) | Chronological decision log, by year. |
| [performance/](performance/) | Measured baselines and phase notes. |
| [organisation-boundary.md](organisation-boundary.md) | The HR/auth/accounting ownership contract; still cited by tests. |
| [accounting-upgrade-rollout.md](accounting-upgrade-rollout.md) | Operator guide for upgrading an existing install, not a historical audit. |
| [disaster-recovery-runbook.md](disaster-recovery-runbook.md) | Current backup, restore, PITR, escalation and rehearsal procedure; includes the explicit not-provisioned gaps. |

## Historical — read as dated evidence, not current state

| Document | Status |
|---|---|
| `audit-2026-11-04.md` | **Removed 2026-11-16.** Superseded by the 2026-11-15 audit; git history retains it. Do not cite its table counts (57) or "Express 5" line as current. |
| [authorization-audit-2026-10-28.md](authorization-audit-2026-10-28.md) | Historical route/permission review; findings implemented, still cited by tests. |
| [bug-loop-audit-2026-10-27.md](bug-loop-audit-2026-10-27.md) | Historical round-8 record. |
| [ui-ux-audit-2026-10-29.md](ui-ux-audit-2026-10-29.md), [-30](ui-ux-audit-2026-10-30.md), [-31 overlays](ui-ux-audit-2026-10-31-overlays.md) | Dated UI sweeps; measurements are tied to those dates. |
| [data-fetching-audit.md](data-fetching-audit.md), [data-fetching-tasklist.md](data-fetching-tasklist.md) | Closed payload work; kept for the "why" behind the trimmed bootstrap. |
| [serial-register-audit.md](serial-register-audit.md), [serial-input-improvements-plan.md](serial-input-improvements-plan.md), [stock-ledger-accuracy-audit.md](stock-ledger-accuracy-audit.md), [cpe-actions-audit.md](cpe-actions-audit.md) | Delivered serial and stock work. |
| [mirror-audit.md](mirror-audit.md) | Historical mirror review. |
| [master-data-implementation-plan.md](master-data-implementation-plan.md) | Delivered; design record. |
| [permission-overrides-plan.md](permission-overrides-plan.md) | Delivered (phases 1–2). |
| [hr-module-plan.md](hr-module-plan.md) | Delivered; see [tasks/hr-module.md](tasks/hr-module.md). |
| [accounting-module-review.md](accounting-module-review.md) | Historical review of the supplied trial balance; its master-data portions are superseded. |

## Rules

- A current-state claim (test count, screen count, table count, stack) belongs in
  `README.md`, `handoff.md` or `SESSION_NOTES.md`, where
  `scripts/docsTestCounts.ts` and `tests/docsTruth.guard.test.ts` can pin it.
- Historical documents are not updated when code changes. If a finding is still
  open, it belongs in `architecture-backlog.md` or `worklist/`, not in a dated
  audit.
- Do not delete a document cited by source comments, tests or session notes
  without updating every reference first: `grep -rn "<filename>"` across the
  repo, including `client/`, `server/`, `tests/` and `scripts/`.
