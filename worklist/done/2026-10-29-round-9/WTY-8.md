# WTY-8 — docs, counts and the round-close gates

Status: `[x]` 2026-10-29 · Commit `2fbbbfb` · Round 9 close
Order: 8 · Depends on WTY-1…7.

## Why

The repo's docs count tables and the handoff are part of the acceptance surface
for every shipped round. Leaving them for "later" is how the counts drifted
before. This slice also runs the full gate chain once, at the point where all
slices are on main.

## Scope

- `README.md`: new table in the schema list, two new operations, the two screens
  in the register table, the API rows for the three warranty endpoints, and the
  retired endpoint removed. Recount rather than assume: today the README says
  **37 tables / 67 screens / 48 operations**, and this round adds one table, one
  screen pair counted as one register screen, and two permission operations;
  the route-table count is whatever the tables actually list after the change.
- `handoff.md`: current state, the capture points, the two registers, the
  retired screen/endpoint and the next module (claims/RMA).
- `SESSION_NOTES.md`: one short outcome entry linking here, and
  `docs/session-notes/2026.md` for the detailed entry.
- `docs/data-fetching-audit.md`: the registers are self-fetching; no bootstrap
  slice was added and `warranty_coverages` is not in the payload.
- `docs/architecture-backlog.md`: move the warranty item to shipped, record
  claims/RMA as the follow-up trigger.
- `worklist/round-9/*` statuses, commit hashes and CI run; archive the round to
  `worklist/done/2026-10-<close-date>-round-9/` with its README when done.

## Acceptance checklist

- [x] The README, handoff and session notes describe the shipped behaviour, not
      the plan; no doc still calls the old directory live.
- [x] The docs-count gate inside `npm test` passes at the new real count (run
      `npx tsx scripts/docsTestCounts.ts <realCount>` once, after the full suite
      reports it); no hand-edited mismatch remains.
- [x] Full `npm test` green against PostgreSQL; `npx tsc --noEmit` clean.
- [x] `check:no-inline-sql`, `check:no-raw-dialogs`, build and
      `check:bundle-budget` pass.
- [x] Every WTY note records its commit hash and the CI run the user asked for;
      the round is archived and `worklist/README.md` points at the close note.

## Recount result (2026-10-29)

The note's plan-time 37 tables / 67 screens / 48 operations were already stale.
Counted from the code at close: **38 tables** (`scripts/schema.sql`, pinned by
`schema.drift.guard` / `schemaSource.parity`), **70 feature screens**
(`client/src/features/**/*.tsx`, pinned by `registerRefreshDomains`), **50
permission operations** (`DEFAULT_PERMISSIONS_MATRIX`) and **70 route-table
entries**. The README's 70-screen claim was already correct; only its table and
operation counts needed the round's delta.

## What changed

- `README.md`: tables 37→38 (all four mentions, plus the stale “30 relational
tables” line), operations 48→50, a two-sided warranty feature bullet, both
registers in the paged table, the old `/warranty` union removed from the device
register row, and a new three-row warranty endpoint table.
- `handoff.md`: version 1.7 / 2026-10-29, 38-table overview incl.
  `warranty_coverages`, FK relationships, 50-operation matrix with
  `warranty-view` / `warranty-edit`, the two registers in the feature map, the
  old `/warranty` union marked retired, and `utils/warranty.ts` replaced by
  `utils/warrantyCapture.ts`.
- `SESSION_NOTES.md` + `docs/session-notes/2026.md`: the round outcome, the
  exact model and the gate numbers.
- `docs/data-fetching-audit.md`: new §7c records the two self-fetching registers
  and that `warranty_coverages` is not a bootstrap slice.
- `docs/architecture-backlog.md`: product follow-up section — warranty shipped;
  claims/RMA recorded as the next module with its trigger.
- `client/src/components/common/HelpDocumentation.tsx`: the in-app help no
  longer points at the retired screen.
- Deleted the dead `client/src/utils/warranty.ts` (`getWarrantyInfo`) and updated
  the stale 67→70 screen comment in `KeepMounted.tsx`.

## Gate evidence (2026-10-29) — committed as `2fbbbfb`

- `npx tsc --noEmit` — clean.
- Full `npm test` — **1567 tests, 1565 pass, 0 fail, 2 Windows-only skips**;
  docs-count gate green at **1567**.
- `npm run check:no-inline-sql` — clean (17 controllers).
- `npm run check:no-raw-dialogs` — clean (170 client files).
- `npm run build` — success; `npm run check:bundle-budget` — **287.1 kB gz**
  startup of 320 kB across 72 chunks (entry 16.1 of 17 kB).
- CI was **not run**: the user has not asked for a CI check in this pass, and
  the round's earlier slices were not pushed by this close-out.

## Out of scope

New features discovered during the gate run; record them in
[../parked.md](../parked.md) with a trigger instead of widening this round.
