# Round 6 — the last legacy device read

Created 2026-10-27 · Status: `[~]` active · One item
Previous round: [2026-10-27-round-5.md](../done/2026-10-27-round-5.md)

## Why this round

Round 5 closed the client side of the device read path: EXCH-1 moved the last
screen (the Device Exchange picker) to `GET /api/customer-devices/page`, and
READ-1 deleted the orphaned `getCustomerDevices` wrapper and its `api` entry,
with a guard that fails if either returns. READ-1 deliberately kept the server
route and recorded why: an older deployed bundle might still call it, and
deleting a live endpoint is a deployment decision.

That reason has expired for the bounded array. The client and the server are
built and served from **one** deploy (`npm run build` emits `dist/`, served by
the same process), so the only caller left is a browser tab holding a cached
pre-EXCH-1 JavaScript bundle against a new server — and that caller has no
current screen in it. Keeping the route means the exact trap READ-1 closed on
the client still exists on the server: the next reader that wants "all
devices" finds an endpoint that returns a page-sized answer that looks
complete. It is also the only remaining test that asserts the array answers,
which makes a stale read look like supported behaviour.

One small item, no migration, no new screen.

## Schedule

| Order | ID | Task | Status | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | [CDR-1](CDR-1.md) | Retire the legacy `GET /api/customer-devices` route, its handler and its SQL | `[x]` done (`c147d99`, CI run 180) | 0.5–1 h | READ-1 (done) |

## Order and stop points

1. **CDR-1** — remove the route, the handler, the 2,000-row query builder and
   the test that pins the array; replace that coverage with a 404 assertion and
   a source guard, and update the current-state docs. Stop: no route matches the
   bare URL, the paged/overview/warranty/exchange reads are untouched, and the
   guards pass. **Done 2026-10-27 (`c147d99`).**

## Gates for this round

- `npx tsc --noEmit`
- Targeted suites: the device register/off-bootstrap suite, the inventory repo
  suite and the exchange suites
- `npm run check:no-inline-sql` and `npm run check:no-raw-dialogs` (the
  controller count may change)
- No client bundle change, so no bundle-budget gate is required; run the full
  `npm test` at ship time

## Out of scope

`GET /api/bootstrap/local?key=customerDevices` still returns the whole table for
an older bundle; the same mapping also feeds the operational cache, so retiring
it needs the cache mapping separated from the slice mapping. It is recorded in
the item note as a follow-up, not folded in here. Also out of scope: the
`/customer-devices` branch-guard prefix and the `/customer-devices/:id` resource
check, which the paged/overview/warranty reads and the status patch still need.
