# Round 9 — the two-sided warranty registers

Dates: 2026-10-28 → 2026-10-29 · Closed 2026-10-29 · Owner: main

## Goal

The warranty directory derives one 12-month countdown from an issue or
acquisition date and calls it both a customer warranty and a vendor warranty.
Neither side is captured: there is no vendor term on a purchase, no seller term
on a device issue, no product default, and the same `WARRANTY_MONTHS = 12`
constant drives both. This round replaces that with two explicit coverage
objects — what a supplier owes us and what we give a customer — captured at the
document that creates each, shown in two separate registers.

The rule from the approved plan: **the exact expiry date is authoritative**, and
each coverage also stores its start date, the term snapshot that produced it and
the start basis. Month-only storage was rejected because it cannot represent a
negotiated end date and recomputes history differently at every month end.

Register names: **Suppliers Warranty** (inbound) and **Sellers Warranty**
(outbound). The old combined "View Warranty Products" screen is retired.

## Items

Work proceeds in this order; each note is the slice's single source of truth.

| # | Item | Scope | Status |
|---|---|---|---|
| 1 | [WTY-1](WTY-1.md) | Shared date arithmetic, `warranty_coverages` schema, product columns, types, demo mirror and legacy backfill | `[x]` `bae0efa` |
| 2 | [WTY-2](WTY-2.md) | Coverage repo/service/controller/routes, branch scope, permissions and the audited edit endpoint | `[x]` `f1ebd83` |
| 3 | [WTY-3](WTY-3.md) | Product vendor/seller warranty defaults in the API and the product form | `[x]` `cf84fa1` |
| 4 | [WTY-4](WTY-4.md) | Vendor coverage capture at purchase invoice and fixed asset; supersede on return/disposal | `[x]` `870726b` |
| 5 | [WTY-5](WTY-5.md) | Seller coverage capture at issue, sale and exchange; supersede on collection/refund | `[x]` `752d3e4` |
| 6 | [WTY-6](WTY-6.md) | Suppliers Warranty and Sellers Warranty screens, navigation, client API and the device badge | `[x]` `5abf19e` |
| 7 | [WTY-7](WTY-7.md) | Demo coverage data, clear-demo order and backfill verification | `[x]` `7c56a6c` |
| 8 | [WTY-8](WTY-8.md) | Docs, table/screen/route/operation counts, full gates and the CI record | `[x]` *(this close)* |

WTY-1 shipped as `bae0efa`, WTY-2 as `f1ebd83` and WTY-3 as `cf84fa1`, each
after its own gates and with every acceptance line ticked — the coverage API's
repo, HTTP, branch-scope, permission and audited-edit claims, and the product
defaults' validation and form round-trip. WTY-4 (`870726b`) captures supplier coverage
from the purchase invoice and the fixed-asset register, and retires it on return
or disposal. WTY-5 is done: every capture surface takes an explicit coverage switch, both
`Assign Fixed Asset` branches write the seller row, and the customer-device read
returns the stored promise. WTY-6 (`5abf19e`) is done: the two registers read the coverage
API, the shared correction dialog supersedes through the audited PATCH, and the
old combined directory (screen, route, nav entry and device endpoint) is gone.
WTY-7 (`7c56a6c`) is done: the demo seed now carries 8 run-date-relative
coverages (all three states on both registers), the clear path removes them
before their parents, and the shipped legacy backfill is proven idempotent
against a live database. WTY-8 closes the round: the docs now state 38 tables /
70 screens / 50 operations, the retired directory is gone from the help and the
handoff, and the full gate chain is green (1567 tests, build, bundle budget at
287.1 kB gz). CI was not run because it was not requested.

**WTY-5 scope was amended 2026-10-29** after an audit of blank-expiry behaviour:
a blank date silently fell back to the product term, so "no warranty for this
unit" could not be expressed, and the `Assign Fixed Asset` rental-CPE form had
no capture at all. The slice now owns the explicit per-unit coverage switch
across every capture surface, both assignment branches, and the stored seller
read. Details and evidence are in
[WTY-5](WTY-5.md#audit-findings-2026-10-29).

The last invented term — the legacy "View Warranty Products" directory — is
gone; both registers render the stored exact expiry.

## Commit policy

This round overrides the single-commit idea in the first draft. The approved
plan spans schema, API, four capture flows and two screens; one commit would
hide which slice broke a gate. Each note ships as its own commit with its ID in
the subject (`WTY-2: ...`), and the note records the hash. A slice may only be
committed after `npx tsc --noEmit` and its own suites pass.

## Gates

Before a slice is marked done:

1. `npx tsc --noEmit` clean.
2. The slice's own suites green against PostgreSQL, plus the existing schema,
   auth and register guards it touches.
3. At round close: full `npm test` and the docs-count gate at the new real
   count.
4. `npm run check:no-inline-sql`, `check:no-raw-dialogs`, build and
   `check:bundle-budget` (client code moves).
5. CI green on the pushed commit, recorded in the note — only when the user
   asks for a CI check. No CI check was requested for this round.

## Boundary

No payload item is reopened. The new registers are self-fetching; no
`warranty_coverages` slice enters the login payload. Claims/RMA stays parked as
the next module until it has its own requirements.
