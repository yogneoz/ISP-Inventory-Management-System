# Completed rounds

Finished rounds are moved here and kept for reference. They are not active
work: do not reopen an item here, and do not edit the note except to fix a
broken link or add a later outcome link.

## Naming

`YYYY-MM-DD-round-N.md` — the close date and the round number. The matching
round folder is archived beside it when one exists (for example
`2026-10-25-round-1/` if the round had per-item notes).

## What a completed note contains

- The round's goal and dates.
- Each item: outcome, commit hash, and any gate that was skipped or failed.
- Links to the permanent docs and the SESSION_NOTES section for detail.
- A final line saying whether CI was checked and the result.

## Index

| Round | Closed | Goal | Note |
|---|---|---|---|
| 1 | 2026-10-25 | CPE and serial trust, search scale, bootstrap trim, CLOSE | [2026-10-25-round-1.md](2026-10-25-round-1.md) |
| 2 | 2026-10-26 | National-volume read path: SQL trading totals, bootstrap payload trim, bundle headroom | [2026-10-26-round-2.md](2026-10-26-round-2.md) |
| 3 | 2026-10-27 | Finish the login path: SQL bootstrap summary, shipments/customers/customerDevices off the payload, notes split by year | [2026-10-27-round-3.md](2026-10-27-round-3.md) |
| 4 | 2026-10-27 | The last customer-scale array: fixed assets off the payload, the Device Exchange picker on the paged device read | [2026-10-27-round-4.md](2026-10-27-round-4.md) |
| 5 | 2026-10-27 | Stock-screen scale: the quadratic stock lookups indexed out of the screens, the dead bare-array device read removed, and the paged-stock decision recorded as a conditional NO-GO | [2026-10-27-round-5.md](2026-10-27-round-5.md) |
| 6 | 2026-10-27 | The last legacy device read: the bare-array `GET /api/customer-devices` route, its handler and its 2,000-row query retired, pinned closed by a 404 and a source guard | [2026-10-27-round-6.md](2026-10-27-round-6.md) |
| 7 | 2026-10-27 | The last legacy device read retired: the `customerDevices` bootstrap slice is gone (410 Gone) and its mapping split into `CACHE_ONLY_TABLES` so the operational cache keeps the device mirror | [2026-10-27-round-7.md](2026-10-27-round-7.md) |
