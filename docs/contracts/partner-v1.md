# Partner contract — `/api/partner/v1/*` (subscription portal)

The portal owns subscriptions. This ERP owns receivables, stock and HR. No number
has two writers.

`scripts/check_contract_parity.ts` reads the block below, diffs it against the
routes registered in `server/src/routes/partner.routes.ts`, and checks every
documented field still exists in the controller/service that produces it.

Editing rule (see `AGENTS.md`): a change to a partner-consumed route, table or
field ships with this file, the fixture in `tests/partnerIntegration.api.test.ts`,
and a contract test, in the same commit.

## Envelope

A failed call answers with an HTTP status and a JSON body carrying **one of these
two key sets** — nothing else:

```json
{ "message": "human readable" }
```

```json
{ "code": "SHORT_CODE", "message": "human readable" }
```

- `message` is always present. It may be reworded at any time, so log or show it
  as it arrives and never match on its text.
- `code` is present only when the refusal has a stable machine-readable reason
  (the table below). A validation refusal has none: today it is
  `400 { "message": "contactNumber is required." }`. `code` is a label, not the
  classifier — the HTTP status is.
- There is no `retryable` and no `details` field on these bodies. Retry is
  decided by status, never by a flag: a `4xx` is a refusal, so fix the body or
  drop the call rather than resending it unchanged. A `5xx` is worth retrying
  unchanged, and `503 { "code": "DB_BUSY" | "DB_UNAVAILABLE", "message": ... }`
  carries `Retry-After` — that (and `429 API_KEY_RATE_LIMIT`) is the only
  back-off signal in the contract.
- A stock shortage is **not** this envelope: it is a successful answer that
  documents the refusal (see "Stock"),
  `409 { "externalId", "status": "CONFLICT", "conflictReason", "eventId" }`.
  A `409` alone therefore does not tell the portal which shape arrived; the
  presence of `status: "CONFLICT"` does.

Codes the portal must handle:

| Code | Status | Meaning |
| --- | --- | --- |
| `PARTNER_KEY_REQUIRED` | 401 | a human session token reached an ingest route; these routes take an API key, never a login |
| `PARTNER_NOT_REGISTERED` | 403 | the API key is valid but no `integration_partners` row binds it; the key alone is not enough |
| `PARTNER_SUSPENDED` | 403 | the partner is disabled; its key ingests nothing until an admin sets `status` back to `ACTIVE` |
| `PARTNER_BRANCH_SCOPE` | 403 | the branch the call would write into is outside this key's branch scope — the `branchId`/`branchCode` in the body, the linked customer's stored branch on a re-sync or a subscription without `branchId`, or the branch of a customer the key would link — refused before any write, with an inbox row |
| `CUSTOMER_NOT_LINKED` | 404 | the subscription names a customer that was never synced; send it to `/customers` first |
| `IDEMPOTENCY_KEY_REUSED` | 409 | the same idempotency key arrived with a different body; the stored response is not replayed |

The key itself is refused by the API-key gate, before any partner logic runs,
with the same two-key body: `API_KEY_INVALID`, `API_KEY_REVOKED`,
`API_KEY_EXPIRED`, `API_KEY_CIDR` (401/403), `API_KEY_RATE_LIMIT` (429, with
`Retry-After`), `API_KEY_READ_ONLY` (403, a write with a read-only key) and
`API_KEY_SCOPE` (403, the key lacks the operation the route needs). If the key
cannot be verified at all the gate fails closed with
`503 { "code": "SHARED_STATE_UNAVAILABLE", "message": ... }`.

## Authentication and scope

Ingest routes authenticate with an API key (`x-api-key: isp_live_…`), never a
human session. The key must (a) be bound to a partner row, (b) carry the
operation the route needs — `customers-manage` for customers,
`sales-invoice-create` for subscriptions, `stock-out` for consumptions — and
(c) include in its branch scope the branch the call writes into. That is the
`branchCode`/`branchId` the body names, and for a subscription that names no
`branchId` the branch of the linked customer. A human token on an ingest route
is 401 even if it reaches it.

## Documents

A subscription's `branchId` is optional: without it the invoice is filed in the
linked customer's branch, so that branch must be in the key's scope exactly as
if the body had named it. A subscription period becomes a **service invoice**,
never a sales invoice.
`sales_invoices` deducts branch stock per line and refuses a document when stock
is short, which is wrong for a service. `service_invoices` posts through the same
`postJournal`: Dr `AR_CONTROL`, Cr `SALES` (revenue), Cr `TAX_OUTPUT` when tax is
present, with the customer's party subledger book ensured. No inventory row is
touched by a subscription.

## Idempotency and natural keys

- `idempotencyKey` replays the stored response (`replayed: true`, 200).
- Independently of keys, `(partner, externalSubscriptionId, serviceFromAD)` is
  unique: resending the same period returns the invoice that already covers it
  with `created: false`.
- Stock consumption is keyed by `externalId`: a resend is answered from the
  stored event and does not decrement twice.

## Stock

A consumption is a guarded decrement of `inventory_stock` for the partner's
branch. When there is not enough, the request is refused with 409 and
`status: "CONFLICT"` plus `conflictReason`; the quantity never goes negative and
nothing is deducted. Applied and refused attempts both leave an
`integration_inbox` row, and applied ones queue an outbox event for the portal.

## Outbox delivery

Events are signed with HMAC-SHA256 over the raw body, header
`x-isp-signature: sha256=<hex>`, plus `x-isp-event` and
`x-isp-delivery-attempt`. A non-2xx response is retried with exponential backoff
(`next_attempt_at`); after the configured attempts the row is `DEAD` and can be
replayed by an admin. Delivery is drained on demand by
`POST /api/admin/integration/deliver` — this process runs no background timer,
so an operator (or an external scheduler calling that endpoint) drives it.
Suspended partners receive nothing, and a partner with no `webhook_url` keeps
its rows queued (each drain records a failed attempt, so they eventually reach
`DEAD` instead of being dropped).

## Routes

```contract
POST /api/partner/v1/customers | req: externalId, name, contactNumber, branchCode, email, idempotencyKey | res: created, customerCode, contactNumber, replayed
POST /api/partner/v1/subscriptions | req: externalSubscriptionId, customerExternalId, planName, durationDays, serviceFromAD, serviceToAD, subtotal, taxAmount, invoiceDateAD, branchId, idempotencyKey | res: invoiceId, invoiceNumber, created, total, journalId, periodFrom, replayed
POST /api/partner/v1/stock/consumptions | req: externalId, sku, branchCode, quantity, idempotencyKey | res: status, quantityOnHand, conflictReason, replayed
GET /api/admin/integration/partners | res: id, code, name, contract_version, status, api_key_id, allowed_events, created_at, pending_events, dead_events
POST /api/admin/integration/partners | req: code, name, apiKeyId, contractVersion, allowedEvents, webhookUrl | res: id, code, name, contract_version, allowed_events
PATCH /api/admin/integration/partners/:id | req: name, allowedEvents, webhookUrl, status | res: id, code, name, status, allowed_events, webhook_url
GET /api/admin/integration/outbox | req: status, limit | res: id, event, entity, entity_id, partner_code, status, attempts, last_error, created_at, delivered_at, next_attempt_at
POST /api/admin/integration/outbox/:id/replay | res: id, status
POST /api/admin/integration/deliver | req: limit | res: delivered, failed, skipped
POST /api/admin/integration/partners/:id/push/stock | req: branchId, cursor, limit | res: partner, queued, nextCursor
POST /api/admin/integration/partners/:id/push/hr | req: branchId, cursor, limit | res: partner, queued, nextCursor
```

`branchId` is optional on `POST /subscriptions`: omit it and the invoice is
filed in the linked customer's branch, which must still be inside the key's
branch scope (otherwise `403 PARTNER_BRANCH_SCOPE`, before any write).

The same rule applies to `POST /customers`. `branchCode` is required and must be
in scope, but on a re-sync the row that would be updated is the one the existing
link points at: if that customer is filed in another branch, the call is refused
with `PARTNER_BRANCH_SCOPE` and the contact is left untouched. Linking a customer
already in the ERP under the portal's code is refused the same way when that
customer sits outside the key's branches.

`POST /partners/:id/push/{stock,hr}` addresses the partner by the `id` the list
returns, and `cursor` is the `nextCursor` of the previous push: pass it back to
continue, or `null` when nothing is left.

The deliver response reports `delivered`, `failed` and `skipped`; a row that is
due is always attempted, so a partner with no `webhook_url` counts as `failed`
(the attempt budget then runs out and the row turns `DEAD`) rather than being
silently skipped, and `skipped` stays `0` unless a future rule leaves a due row
untouched.

The admin bodies are validated by `createPartner`/`updatePartner`. A field left
out of a PATCH keeps its stored value (`webhookUrl` blank means "keep the current
target"), and `status` is the enable/disable switch: a SUSPENDED partner accepts
no ingest and receives no deliveries.

The HR push is allowlisted on purpose: identity and org data only (name, code,
designation, department, branch, join date, status). Salary, PAN and bank details
never leave this ERP through the partner channel.
