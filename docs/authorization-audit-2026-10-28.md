# Authorization audit — 2026-10-28

Route-level authorization review of the whole API, run after the Round 8
bug/loop audit. This is an audit record: paths and behaviour were true when
written; where it conflicts with the code, the code wins.

## Scope and method

- Enumerated every registered route by introspecting the built Express app:
  **158 route registrations across the 14 registrars** in
  `server/src/routes/*.ts`, with each full middleware chain, plus the global
  `/api` chain in `server/src/app.ts`.
- Classified each route by authentication, operation gate/role, and branch
  scope. Every route that parsed as unguarded was read in full — the extractor
  cannot see guards inside a multi-line wrapper (e.g. `PUT /api/settings`).
- Cross-checked the API against the client's declared policy
  (`client/src/routes/tabPermissions.ts`,
  `client/src/utils/permissionMatrixData.ts`): the screen a role cannot open
  should not be readable by calling its endpoint directly.
- Read the handlers behind every branch-scoped list and every write that takes
  an `:id`, looking for server-side scope or ownership checks.
- Probed Express's middleware parameter behaviour directly, because
  `enforceBranchAccess` keyed its by-id checks on `req.params?.id` from an
  app-level `app.use`.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| AUTHZ-1 | **High** | The by-id branch guard was dead code | Fixed |
| AUTHZ-2 | High | Sales/purchase return registers leaked every branch | Fixed |
| AUTHZ-3 | Medium | Customer ledger could read another branch's customer | Fixed |
| AUTHZ-4 | Medium | Financial statements had no operation gate | Fixed |
| AUTHZ-5 | Medium | Vendor ledger had no operation gate | Fixed |
| AUTHZ-6 | Medium | Direct stock-level rewrites had no operation gate | Fixed |
| AUTHZ-7 | Medium | Purchase-order status had no operation gate | Fixed |
| AUTHZ-8 | Low-Medium | Customer delete had no operation gate | Fixed |
| AUTHZ-9 | Medium | Approval cancel was open to any user, with a spoofable actor | Fixed |
| AUTHZ-10 | Medium | A branch-scoped bootstrap slice defaulted to every branch | Fixed |
| AUTHZ-11 | Medium | The audit trail was shipped to every signed-in role | Fixed |

Shipped as commit `9942f16`; CI run 195 passed every gate (typecheck, the
full suite against PostgreSQL 16, the no-inline-SQL and no-raw-dialog guards,
the production build, the bundle budget and `npm audit`).

### AUTHZ-1 — the by-id branch guard never ran (High)

`server/src/middleware/index.ts`, `enforceBranchAccess`, guarded record access
with:

```ts
if (getPgConnected() && req.params?.id) { … look up the row, refuse a row
  whose branch columns are outside the account's allowed set … }
```

That middleware is installed with `app.use('/api', enforceBranchAccess)`, and
Express 4 resets `req.params` for middleware layers: a probe against the
installed version shows `req.params === {}` at the middleware and
`{ id: 'abc' }` only inside the route handler. The block therefore never ran —
**every by-id branch check was dead code**, for all twelve tables it listed.
A branch account that knew (or could guess/enumerate) a record id could act on
another branch's stock row, asset, purchase order, invoice, vendor payment,
shipment, stock operation, device, serial-log row, customer, approval request
or location. The shipment suite had already recorded the symptom
(VERIFY-001: "the lookup is dead code under Express 4") without a fix.

**Fixed:** the id is parsed from `req.path` after the matched prefix
(`/sales-invoices/abc/cancel` → `abc`), with known collection segments
(`page`, `overview`, `lookup`, `exchange`, …) skipped so a list read does not
run a record query. Four tables were added to the list — sales invoices, sales
returns, purchase returns and customer payments — so the returns/payment void
paths are covered too. A signed `branchId` of `'ALL'` is the HQ-wide account
shape the shipment handlers already support, and now bypasses the per-branch
check explicitly instead of matching no row. `tests/authorization.audit.test.ts`
covers a cross-branch invoice cancel (403), the same for sales returns,
purchase returns and customer payments, and an HQ-wide account still reaching
the handler (not 403) — the over-block the shipment suite warned about.

### AUTHZ-2 — register lists read every branch when the filter was omitted (High)

`GET /api/sales-invoices`, `/api/sales-returns` and `/api/purchase-returns`
filter by the caller-supplied `branchId` only, and none of the three prefixes
was in `branchScopedReadPaths`. A branch account could call the list without a
`branchId` and page through every branch's invoices/returns; the ids from that
read then fed AUTHZ-1's dead guard.

**Fixed:** the three prefixes joined `branchScopedReadPaths`, so a
non-HQ account must name one of its allowed branches (the registers already
send the active branch). Covered by AUTHZ-2 in the test file.

Verifying this found the first cut over-blocked a record path: the rule was
prefix-wide, so `/customers/:customerId/ledger` demanded a `branchId`, and the
ledger screen sends none when its filter is ALL — a branch user's own customer
would have 403'd. The filter requirement now applies to COLLECTION paths only;
a one-record path is scoped by the id lookup below, and its query branch still
narrows the ledger lines when one is sent. Pinned by the own-customer half of
AUTHZ-3.

### AUTHZ-3 — customer ledger leaked the customer record (Medium)

`GET /api/customers/:customerId/ledger` scoped the ledger *lines* by the
query's `branchId`, but looked the customer up globally and returned its name
even when the account could not access that customer's branch. The route's
parameter is `:customerId`, not `:id`, which the old (dead) lookup would not
have matched either.

**Fixed:** the revived path-based id lookup covers the route, so the guard
refuses the record with the same 403 every other branch-scoped resource uses,
and the handler independently refuses a customer whose `branchId` is outside
the session's allowed set (404 if it is reached). Legacy rows without a branch
stay readable. Covered by AUTHZ-3.

### AUTHZ-4 — financial statements were readable by every role (Medium)

`GET /api/reports/financial-summary` and `/financial-summaries` had no
permission or role gate. The UI gates the statements tab on `fin-statements`
(Super Admin, Head Office Admin, Accountant, Auditor); a field-technician or
front-desk token could call the endpoint directly and read company or branch
financials.

**Fixed:** both routes require `fin-statements`. Covered by AUTHZ-4 (403 for
FRONT_DESK, reached for ACCOUNTANT).

### AUTHZ-5 — vendor ledger was readable by every role (Medium)

`GET /api/vendors/:id/ledger` exposes payables, payment history and opening
balances for a supplier, with no gate. The UI gates the vendor-ledger tab on
`inv-pay`.

**Fixed:** the route requires `inv-pay`. Covered by AUTHZ-5 (FRONT_DESK 403,
ACCOUNTANT reaches the supplier lookup and gets a real 404).

### AUTHZ-6 — direct stock-level rewrites bypassed the audited flow (Medium)

`PATCH /api/stock/:id` writes `quantityOnHand`, `damagedQty` and reorder levels
straight to `inventory_stock` and the damage ledger; `PATCH
/api/stock/:id/reorder-level` writes the reorder point. Neither route had an
operation gate, and the global write allowlist for `/stock/` includes AUDITOR.
So any authenticated role passing that coarse rule — including a read-only
auditor — could overwrite stock figures outside `POST /api/stock-operations`
(which has its own type-aware permission and serial/pool guards).

**Fixed:** the quantity/damage rewrite requires `opening-stock-edit`
(Super Admin, Inventory Manager, Head Office Admin — the same role set as
`branch-damage-mark`, which gates the Damaged Stock edit button, and the same
roles the Dashboard quick-adjust button is shown to); the reorder level
requires `prod-edit`, which is exactly what `ReorderStockTracking` checks
before it offers the edit. Covered by AUTHZ-6 (AUDITOR 403, Inventory Manager
reaches the handler's 404).

### AUTHZ-7 — purchase-order status was open to any role (Medium)

`PATCH /api/purchase-orders/:id/status` moved a PO through its lifecycle with
no permission or role check; the branch check was AUTHZ-1's dead lookup.
Any authenticated account in the branch could approve/send/receive a PO by id.

**Fixed:** the route requires `po-create` or `po-receive`. Covered by AUTHZ-7
(AUDITOR 403, Procurement Officer not 403).

### AUTHZ-8 — customer deletion was open to any role (Low-Medium)

`DELETE /api/customers/:id` removed the customer row with no operation gate
(the create/update routes both require `customers-manage`). An auditor — whose
matrix has no customer write — could delete a customer.

**Fixed:** the route requires `customers-manage`. Covered by AUTHZ-8.

### AUTHZ-9 — approval cancel was open, and the audit actor was caller-supplied (Medium)

`POST /api/approval-requests/:id/cancel` checked only that the request was
PENDING. Any authenticated user in the branch could cancel anyone's request,
and the handler copied `req.body.user` into `processedByEmail/Name/Role`, so
the cancellation could be attributed to a person who never did it.

**Fixed:** cancellation now requires `workflow-approval-cancel` (Super Admin
bypasses the matrix), matching what the Approval Workflow screen enforces —
being the requester does not grant it, since Branch Manager and Front Desk can
never hold that operation. The processed-by fields come from `req.user` only;
the body `user` object is ignored. Covered by AUTHZ-9, including a requester
who is still refused and a spoofed body actor that must not appear.

### AUTHZ-10 — branch-scoped bootstrap slices defaulted to all branches (Medium)

`GET /api/bootstrap/local?key=…` took `branchId` from the query and applied no
branch rule. A branch account that omitted the parameter read every branch's
rows for a branch-scoped key — the same shape Round 7 measured on the retired
`customerDevices` slice (431.5 KiB gzip across branches). The full `/bootstrap`
has always required the caller's own branch; the slice did not.

**Fixed:** for a non-HQ account, a slice whose mapping is branch-scoped (or the
computed `financialSummary`) defaults to the caller's own branch when no filter
is supplied. Company-wide keys (products, suppliers, settings, permissions,
fiscal years, branches) keep their global read. Covered by AUTHZ-10: a branch
account omitting `branchId` receives its own customer, not the other branch's.

### AUTHZ-11 — the audit trail shipped to every role (Medium)

`GET /api/bootstrap` included `auditLogs` — up to 200 rows carrying user
emails, names, actions and details — in every signed-in account's payload, and
`/api/bootstrap/local?key=auditLogs` served the same rows on demand from the
cache mirror. The Activities Log screen is gated on `admin-audit` (Super Admin,
Head Office Admin, Inventory Manager, Accountant, Auditor), so a field
technician or front-desk token could read the company's audit history without
the screen that is supposed to gate it.

**Fixed:** `canReadAuditLogs` checks `admin-audit` (Super Admin bypasses the
matrix) and the full payload and the local slice both return `[]` for an
ungranted role. Empty rather than 403 on purpose: the client's targeted
domain refresh treats a failed slice as a reason to fall back to a full
bootstrap, so a 403 would re-download the whole payload on every audit event
from a role that cannot display it. Covered by AUTHZ-11.

## Related policy alignments

- `DELETE /api/purchase-invoices/:id` allowed ACCOUNTANT and PROCUREMENT_OFFICER,
  while the client's `inv-delete` matrix row is Super Admin / Head Office Admin
  only. The role list was tightened to those two.
- `PATCH /api/assets/:id/status` allows Super Admin, Head Office Admin,
  Inventory Manager and Accountant, while `assets-manage` also includes Branch
  Manager. That is an over-restriction (a branch manager is refused an action
  the screen offers), not a privilege gap; recorded here, not changed.
- `POST /api/approval-requests` remains open to any authenticated user by
  design: raising an approval request is the workflow's entry point.

## Verified clean

- **Authentication coverage:** every `/api` route is behind the global
  `authenticateUser` + `requireAuth` gate except the explicit public set
  (`/auth/setup-status`, `/auth/setup-superadmin`, `/auth/forgot-password`,
  `/auth/login`, `/db/status`, `/health`) and `/sync/*`, which uses the
  SSE-capable auth (query token accepted because EventSource cannot send
  headers) plus a per-IP connection cap. Tokens are HMAC-SHA256 verified with a
  timing-safe compare and an 8-hour expiry; production refuses to boot without
  `AUTH_TOKEN_SECRET`.
- **Administrative writes:** company profile, users, branches, document-number
  configs and BS-calendar mutations are role-gated by
  `enforceOperationalPermissions` (Super Admin, or Super/Head Office Admin as
  appropriate); `PUT /api/settings` is `requireRole('SUPER_ADMIN')`;
  `/api/admin/*` is Super Admin only; the permission matrix is readable by
  Super/Head Office Admin and writable by Super Admin only.
- **Server-side branch scope in handlers:** fixed assets
  (`resolveFixedAssetScope`), serial log, transaction logs, global search and
  the shipment handlers resolve the session's allowed branches themselves and
  apply them in SQL; the paged shipment/customer/device reads refuse a foreign
  filter.
- **Read fences:** `/bootstrap` refuses a branch account that omits, mixes or
  asks for `ALL` branches; sales/purchase/customer registers that were not
  fixed above already required a branch filter.
- **Operation matrix:** the stock-operation endpoint maps its type to the
  matching matrix operation; reverses and returns carry their own operations;
  shipment cancellation/receipt use their own operations and creator parity.

### Follow-up (2026-10-28) — the by-id table is now schema-checked

The by-id list moved out of the middleware into
`server/src/middleware/branchScope.ts`, together with the collection prefixes
and the segment list, and `tests/branchScopeRegistry.test.ts` parses
`scripts/schema.sql`: every table that declares a branch column must be named
in the registry or exempted with a written reason, so a new branch-scoped table
now fails CI until someone decides how it is guarded. Building that list found
two more gaps: `PUT /api/fiscal-years/:id/opening-stock` and
`.../vendor-opening-balances` take branch ids inside nested `rows`, which the
app-level guard's top-level body check cannot see, and their GETs rendered
every branch's grid. Both registers now filter reads and refuse nested rows
outside the actor's allowed branches (`allowedBranchScope`), with AUTHZ-12/13
in the suite pinning the refusal and the HQ-wide path.

## Limits

Pattern-and-path review with targeted handler reading, not a penetration test.
The by-id table is a schema-checked registry now (see the follow-up), so an
exemption is always explicit rather than silent. Branch checks only run while
PostgreSQL is connected — the demo (PG-down) mode serves the in-memory mirror
and has no tenant boundary to enforce. No attempt was made to bypass the HMAC
token or the login rate limiter; those were verified by reading, not attacked.
`tests/authorization.audit.test.ts` (16 tests) needs a reachable PostgreSQL and
skips without one, matching the suite's DB convention. The receive-lane suite's
route-gate fixture was moved into the actor's own branch so the revived id
lookup cannot pre-empt the permission message that suite pins.
