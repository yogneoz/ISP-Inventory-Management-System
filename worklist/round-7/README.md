# Round 7 — the last legacy device read

Created 2026-10-27 · Status: `[~]` active · One item
Previous round: [2026-10-27-round-6.md](../done/2026-10-27-round-6.md)

## Why this round

Round 6 (CDR-1) retired the bare-array `GET /api/customer-devices` route. Its one
recorded follow-up is
`GET /api/bootstrap/local?key=customerDevices`, now the only path that answers a
device request with the whole table. It exists for a cached pre-VOL-4b bundle:
the current client never asks for it (`DOMAIN_STATE_KEYS` maps no domain to it —
the registers re-read their paged endpoints through their refresh counters).

The blocker recorded at the Round 6 close was the shared mapping.
`BOOTSTRAP_TABLES.customerDevices` feeds two surfaces: `fetchBootstrapSlice`
(the slice endpoint) and the operational cache (`CACHE_LOADS` in
`state/runtimeState.ts`, which keeps the in-memory mirror other controllers
read and write). The cache still needs the mapping; the slice does not. Round 7
splits the mapping — the cache keeps it, the slice surface loses it — and the
endpoint answers the retired key definitively instead of a transient 503.

One small item, no migration, no new screen.

## Schedule

| Order | ID | Task | Status | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | [CDR-2](CDR-2.md) | Retire the `customerDevices` bootstrap slice and split the cache mapping | `[x]` done (`46fefb6`, CI run 184) | 1–1.5 h | CDR-1 (done) |

## Order and stop points

1. **CDR-2** — measure the slice through the real mapping; move the
   `customer_device_records` mapping to a cache-only export; keep CACHE_LOADS
   hydrated from it; answer `key=customerDevices` with 410 Gone; flip the tests
   and update the current-state docs. Stop: the slice key cannot resolve, the
   cache mirror still hydrates, and the paged/overview/warranty reads are
   untouched. **Done 2026-10-27 (`46fefb6`).**

## Gates for this round

- `npx tsc --noEmit`
- Targeted suites: the device off-bootstrap suite, the CACHE_LOADS parity
  suite, the bootstrap trim suite
- `npm run check:no-inline-sql` and `npm run check:no-raw-dialogs`
- No client source change, so no bundle-budget gate; the full `npm test` at
  ship time

## Out of scope

The `customers` slice stays for the same older-bundle reason (its mapping is
shared with the cache the same way); if it is ever retired, it needs the same
split. The paged device reads, the exchange lifecycle and the serial register
are untouched. The `/api/bootstrap/local` branch-guard gap observed while
scoping this item — the slice's branch scope is caller-supplied, and the guard
covers `/bootstrap` only — is recorded in the item note as an observation; this
item removes the device slice rather than generalising the guard. Also not in
this round: the remaining watch items (`damageRecords`, the return registers)
— their measurement already recorded no item.
