# BUDGET-1 — startup bundle headroom decision

Status: `[—]` hold · Created 2026-10-26 · Estimate 0.5 day · Client only
Round: [Round 2](README.md) · Order: 4

## Problem

The startup budget is nearly exhausted:

```
entry:         15.7 kB gz (budget 16 kB)
startup total: 312.8 kB gz (budget 320 kB)
75 chunks in the startup graph, 34 on-demand
```

A small client change can now fail a legitimate build, and the natural reaction
— raising the number — would erase the guard. The graph itself is deliberate:
Dashboard, ProductManagement, StockOperations and PurchaseOrders are eager on
purpose ([App.tsx:64](../../client/src/App.tsx#L64)); do not “fix” that without
measuring.

## When to do this

Only when the first client-side change in this round (VOL-1 or VOL-2) fails the
budget, or when `check:bundle-budget` reports less than ~8 kB of total headroom
after that change. Do not raise the budget speculatively.

## Steps

- [ ] Build at the commit where the budget fails; run
      `npm run check:bundle-budget` and record the entry and total sizes.
- [ ] Identify the largest **startup** contributors (the script's chunk list;
      on-demand chunks do not count). Check whether a new module pulled an
      existing feature chunk into the static graph, rather than assuming the
      feature itself grew.
- [ ] Choose one, with a one-line rationale recorded in the note:
      - **Trim:** move one eager screen behind `React.lazy` if its startup weight
        justifies the first-visit delay (measure; StockOperations has 11 render
        sites and is probably not the one).
      - **Split:** move a shared helper out of a feature chunk if it is the only
        reason that chunk is eager.
      - **Raise:** increase `BUDGETS` deliberately (for example entry 18 kB,
        total 340 kB) and update the comment with the date, measured values and
        why the growth is legitimate. Never raise it to make an accidental
        eager import pass.
- [ ] Re-run the build + budget and record the new headroom.
- [ ] Update the budget comment and, if the decision changes the plan, the
      architecture backlog's A-note.
- [ ] Gates: `npx tsc --noEmit`, full `npm test`, build, budget. Record the
      commit.

## Acceptance

- [ ] The budget passes with at least ~8 kB of total headroom, or the eager
      regression is removed.
- [ ] The decision and its measurement are recorded in the note and the script
      comment.
- [ ] No screen's first-visit behaviour changes without being named in the
      decision.

## Risks

| Risk | Mitigation |
|---|---|
| Raising the budget hides future regressions | Raise only with measured values and a dated rationale; keep the entry/total split |
| Lazy-loading the wrong screen hurts first use | Measure the screen's startup weight and render sites before choosing |
| A shared helper keeps a chunk eager | Check the static import chain before blaming the feature |
