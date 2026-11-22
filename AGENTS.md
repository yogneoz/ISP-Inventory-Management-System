# Project rules for agents

## The mobile-support rule (standing)

Every change to a route, table or field that a mobile client or an external
partner consumes ships **in the same commit** with:

1. **the contract document update** — `docs/contracts/mobile-v1.md` or
   `docs/contracts/partner-v1.md`;
2. **the fixture** — the request/response example the client is coded against;
3. **the contract test** — a test that fails when the shape drifts.

A behaviour change that leaves one of those behind is an incomplete change, not
a follow-up: the phone and the portal are outside this repository, so their
compatibility cannot be fixed later by editing a screen here.

Surfaces this applies to:

- `/api/v1/*` — the PulseHR mobile client (see `server/src/routes/mobile.routes.ts`);
- `/api/partner/v1/*` — the subscription portal and any future partner
  (`server/src/routes/partner.routes.ts`, gated by an API key bound to an
  `integration_partners` row).

## Ownership boundary

The portal owns subscriptions; this ERP owns receivables, stock and HR. Do not
create a second writer for a number either side already owns:

- a subscription period becomes a **service invoice** (`service_invoices` +
  `postJournal`). Never a `sales_invoices` row: that path deducts branch stock
  per line and refuses the document when stock is absent.
- partner stock consumption decrements `inventory_stock` through the guarded
  UPDATE and records a CONFLICT row when there is not enough — it never goes
  negative and never silently drops.
- HR leaves the building only through the outbox allowlist in
  `queueHrSnapshot` (identity and org; no salary, PAN or bank).

## Repo conventions that are enforced by guards

- All SQL lives in `server/src/models/*.repo.ts` (`npm run check:no-inline-sql`).
- Every `logAuditEvent` is awaited (`npm run check:audit-await`).
- Mutations against partitioned tables name a branch or a row key
  (`npm run check:branch-predicates`).
- No `confirm()`/`alert()` in the client (`npm run check:no-raw-dialogs`).
- Every registered `/api/v1/*` and `/api/partner/v1/*` route, and every field its
  doc lists, must still exist (`npm run check:contract-parity`). Add a route
  without a line in `docs/contracts/` and CI fails.
- Migrations are immutable once recorded; mirror every table in `scripts/schema.sql`
  so `npm run verify:fresh-install` stays identical.
- When tests are added, move the docs-count pins (README, handoff.md,
  SESSION_NOTES.md) in the same commit; the gate runs at the end of `npm test`.

## Running things here

- Development database for this workstation lives in WSL
  (`wsl.exe -d Ubuntu-24.04 -u root -- bash -lc 'pg_isready -h 127.0.0.1'`), and
  `localhost` resolves to IPv6 on Windows, so scripts that must reach it from
  Windows rewrite the host to the distro address.
- No JDK or Android SDK is installed: the Kotlin app cannot be compiled here.
  Server-side contract tests prove the wire shape; the app is built in Android
  Studio.
