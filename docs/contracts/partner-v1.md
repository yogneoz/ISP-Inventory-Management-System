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

```json
{ "code": "SHORT_CODE", "message": "human readable", "retryable": true, "details": {} }
```

Ingest failures are `4xx` and safe to retry only when `retryable` is true; a 5xx
is always worth retrying with the same body. Codes the portal must handle:

| Code | Meaning |
| --- | --- |
| `PARTNER_NOT_REGISTERED` | the API key is valid but no `integration_partners` row binds it; the key alone is not enough |
| `PARTNER_BRANCH_SCOPE` | the body names a branch (by `branchId` or `branchCode`) outside this key's branch scope — refused before any write, with an inbox row |
| `CUSTOMER_NOT_LINKED` | the subscription names a customer that was never synced; send it to `/customers` first |
| `IDEMPOTENCY_CONFLICT` | the same key arrived with a different body |

## Authentication and scope

Ingest routes authenticate with an API key (`x-api-key: isp_live_…`), never a
human session. The key must (a) be bound to a partner row, (b) carry the
operation the route needs — `customers-manage` for customers,
`sales-invoice-create` for subscriptions, `stock-out` for consumptions — and
(c) include the branch in its branch scope. A human token on an ingest route is
401 even if it reaches it.

## Documents

A subscription period becomes a **service invoice**, never a sales invoice.
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
