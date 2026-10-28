# Round 9 — the two-sided warranty registers

Dates: 2026-10-28 → open · Owner: main

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
| 4 | [WTY-4](WTY-4.md) | Vendor coverage capture at purchase invoice and fixed asset; supersede on return/disposal | `[ ]` |
| 5 | [WTY-5](WTY-5.md) | Seller coverage capture at issue, sale and exchange; supersede on collection/refund | `[ ]` |
| 6 | [WTY-6](WTY-6.md) | Suppliers Warranty and Sellers Warranty screens, navigation, client API and the device badge | `[ ]` |
| 7 | [WTY-7](WTY-7.md) | Demo coverage data, clear-demo order and backfill verification | `[ ]` |
| 8 | [WTY-8](WTY-8.md) | Docs, table/screen/route/operation counts, full gates and the CI record | `[ ]` |

WTY-1 shipped as `bae0efa`, WTY-2 as `f1ebd83` and WTY-3 as `cf84fa1`, each
after its own gates and with every acceptance line ticked — the coverage API's
repo, HTTP, branch-scope, permission and audited-edit claims, and the product
defaults' validation and form round-trip. WTY-4–8 are untouched.

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
   asks for a CI check.

## Boundary

No payload item is reopened. The new registers are self-fetching; no
`warranty_coverages` slice enters the login payload. Claims/RMA stays parked as
the next module until it has its own requirements.
