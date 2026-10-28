# WTY-8 — docs, counts and the round-close gates

Status: `[ ]` not started · Round 9
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

- [ ] The README, handoff and session notes describe the shipped behaviour, not
      the plan; no doc still calls the old directory live.
- [ ] The docs-count gate inside `npm test` passes at the new real count (run
      `npx tsx scripts/docsTestCounts.ts <realCount>` once, after the full suite
      reports it); no hand-edited mismatch remains.
- [ ] Full `npm test` green against PostgreSQL; `npx tsc --noEmit` clean.
- [ ] `check:no-inline-sql`, `check:no-raw-dialogs`, build and
      `check:bundle-budget` pass.
- [ ] Every WTY note records its commit hash and the CI run the user asked for;
      the round is archived and `worklist/README.md` points at the close note.

## Out of scope

New features discovered during the gate run; record them in
[../parked.md](../parked.md) with a trigger instead of widening this round.
