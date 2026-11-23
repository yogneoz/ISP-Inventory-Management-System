/**
 * External subscription portal integration.
 *
 * Ownership boundary: the portal owns subscriptions, this ERP owns receivables,
 * stock and HR. Concretely:
 *
 *   inbound   customer upsert        -> customer_records (+ external_refs)
 *   inbound   subscription period    -> service_invoices + postJournal (AR/VAT/revenue)
 *   inbound   stock consumption      -> guarded inventory_stock decrement
 *   outbound  stock levels, HR       -> integration_outbox -> signed webhook
 *
 * Why service invoices and not sales invoices: `post_salesInvoices` deducts
 * branch stock for every line and refuses the document when stock is absent, so
 * a package sale cannot ride that table. `postServiceInvoiceLedger` posts the AR
 * side without touching inventory.
 *
 * Why an inbox/outbox instead of direct calls: a partner retry must never
 * double-decrement stock or double-bill a service period. Three keys enforce
 * that — `external_refs` for identity, `idempotency_keys` for replay, and the
 * natural unique keys on `service_invoices` and `stock_consumption_events`.
 */
import crypto from 'node:crypto';
import { pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { logAuditEvent } from './audit.service';
import { postServiceInvoiceLedger } from './serviceInvoicePosting.service';
import {
  BRANCH_BY_CODE_SQL,
  BRANCH_BY_ID_SQL,
  CUSTOMER_BY_CODE_SQL,
  CUSTOMER_BY_ID_SQL,
  CUSTOMER_CONTACT_UPDATE_SQL,
  CUSTOMER_INSERT_SQL,
  EXTERNAL_REF_BY_EXTERNAL_SQL,
  EXTERNAL_REF_UPSERT_SQL,
  HR_SNAPSHOT_SQL,
  INBOX_INSERT_SQL,
  OUTBOX_ATTEMPT_INSERT_SQL,
  OUTBOX_BY_ID_SQL,
  OUTBOX_ENQUEUE_SQL,
  OUTBOX_MARK_DELIVERED_SQL,
  OUTBOX_MARK_FAILED_SQL,
  OUTBOX_PENDING_SQL,
  OUTBOX_REPLAY_SQL,
  PARTNER_BY_API_KEY_SQL,
  PARTNER_BY_CODE_SQL,
  PARTNER_DELIVERY_TARGET_SQL,
  PARTNER_INSERT_SQL,
  PARTNER_LIST_SQL,
  PARTNER_UPDATE_SQL,
  PRODUCT_EXISTS_SQL,
  SERVICE_INVOICE_EXISTS_SQL,
  SERVICE_INVOICE_INSERT_SQL,
  SERVICE_INVOICE_LINE_INSERT_SQL,
  SERVICE_INVOICE_NUMBER_SQL,
  STOCK_CONSUME_SQL,
  STOCK_CONSUMPTION_BY_EXTERNAL_SQL,
  STOCK_CONSUMPTION_INSERT_SQL,
  STOCK_LEVEL_SQL,
  STOCK_SNAPSHOT_SQL,
} from '../models/integration.repo';
import { IDEMPOTENCY_INSERT_SQL, IDEMPOTENCY_LOOKUP_SQL } from '../models/mobile.repo';
import { resolveBsDateForLedgerSync } from '../utils/bsDate';

const MAX_DELIVERY_ATTEMPTS = 8;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function required(value: unknown, max: number, field: string): string {
  const parsed = text(value, max);
  if (!parsed) throw new ApiError(400, `${field} is required.`);
  return parsed;
}

function amount(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, `${field} must be a non-negative amount.`);
  }
  return Math.round(parsed * 100) / 100;
}

function isoDate(value: unknown, field: string): string {
  const raw = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ApiError(400, `${field} must be a date in YYYY-MM-DD form.`);
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new ApiError(400, `${field} must be a real calendar date.`);
  }
  return raw;
}

function requestHash(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

/**
 * The partner behind the presented API key. A key that is not bound to a
 * registered partner is refused: possession of a valid key alone is not an
 * integration.
 */
export async function resolvePartner(req: any): Promise<any> {
  const keyId = req?.apiKey?.id;
  if (!keyId) {
    throw new ApiError(401, 'A partner API key is required for this endpoint.', { code: 'PARTNER_KEY_REQUIRED' });
  }
  const partner = (await pgPool.query(PARTNER_BY_API_KEY_SQL, [keyId])).rows[0];
  if (!partner) {
    throw new ApiError(
      403,
      'This API key is not bound to a registered integration partner.',
      { code: 'PARTNER_NOT_REGISTERED' }
    );
  }
  if (String(partner.status) !== 'ACTIVE') {
    throw new ApiError(403, 'This integration partner is suspended.', { code: 'PARTNER_SUSPENDED' });
  }
  return partner;
}

/**
 * The branch scope of the presented API key, or `null` for a company-wide key.
 *
 * The key row carries the SQL shape (`branch_ids`); the synthetic principal
 * carries the camelCase copy. Accept either so a mapper change cannot widen the
 * scope. `createApiKey` refuses 'ALL', so an empty list is company-wide, not a
 * list that permits nothing.
 */
export function keyBranchScope(key: any): Set<string> | null {
  const ids: string[] = Array.isArray(key?.branch_ids)
    ? key.branch_ids
    : Array.isArray(key?.branchIds)
      ? key.branchIds
      : [];
  return ids.length ? new Set(ids.map(String)) : null;
}

/**
 * The key's branch scope applies to the branch a write LANDS in, not only to a
 * branch named in the body. A subscription with no `branchId` inherits the
 * linked customer's branch, so a body-only check left a key scoped to one
 * branch free to invoice into another by sending the customer's external id.
 */
export function assertKeyBranchAllowed(scope: Set<string> | null, branchId: string): void {
  if (!scope) return;
  if (!scope.has(String(branchId))) {
    throw new ApiError(403, 'This API key is not scoped for the requested branch.', {
      code: 'PARTNER_BRANCH_SCOPE',
    });
  }
}

/**
 * Replay the first response for a repeated idempotency key.
 *
 * This is a response cache, not the write guard: each ingest is independently
 * idempotent on its natural key, so two concurrent first attempts cannot
 * double-write even if both miss here.
 */
export async function replayIfSeen(
  scope: string,
  key: string,
  payload: unknown
): Promise<{ replayed: boolean; body?: any }> {
  if (!key) return { replayed: false };
  const prior = (await pgPool.query(IDEMPOTENCY_LOOKUP_SQL, [scope, key])).rows[0];
  if (!prior || !prior.response_body) return { replayed: false };
  if (String(prior.request_hash) !== requestHash(payload)) {
    throw new ApiError(
      409,
      'This idempotency key was already used for a different request body.',
      { code: 'IDEMPOTENCY_KEY_REUSED' }
    );
  }
  return { replayed: true, body: prior.response_body };
}

export async function rememberResponse(
  scope: string,
  key: string,
  payload: unknown,
  status: number,
  body: unknown
): Promise<void> {
  if (!key) return;
  await pgPool.query(IDEMPOTENCY_INSERT_SQL, [
    scope,
    key,
    requestHash(payload),
    status,
    JSON.stringify(body),
  ]);
}

function customerDto(row: any, created: boolean) {
  return {
    customerId: row.id,
    customerCode: row.customer_id,
    name: row.customer_name,
    contactNumber: row.contact_number,
    branchId: row.branch_id,
    email: row.email,
    address: row.address,
    created,
  };
}

/**
 * Portal customer -> `customer_records`, bridged by `external_refs`.
 *
 * A name the portal sends is used ONLY when the record is first created. A local
 * operator's correction survives a later sync, because the portal is not
 * authoritative for the ERP's display name; the contact fields it does own are
 * updated when supplied.
 */
export async function upsertCustomer(
  partner: any,
  body: any,
  actor: string,
  keyScope: Set<string> | null
): Promise<{ status: number; body: any }> {
  const externalId = required(body?.externalId, 160, 'externalId');
  const name = required(body?.name, 200, 'name');
  const contact = required(body?.contactNumber, 50, 'contactNumber');
  const branchCode = required(body?.branchCode, 20, 'branchCode');
  const branch = (await pgPool.query(BRANCH_BY_CODE_SQL, [branchCode])).rows[0];
  if (!branch) throw new ApiError(400, `Unknown branch code "${branchCode}".`);
  assertKeyBranchAllowed(keyScope, branch.id);

  const ref = (
    await pgPool.query(EXTERNAL_REF_BY_EXTERNAL_SQL, [partner.id, 'CUSTOMER', externalId])
  ).rows[0];
  if (ref) {
    // The ref can point at a customer filed in another branch — linked while
    // the key's scope allowed it, or before the scope was narrowed. The body's
    // branchCode is in scope but irrelevant: the UPDATE lands on the ref's row,
    // so the guard is on that row's branch.
    const linked = (await pgPool.query(CUSTOMER_BY_ID_SQL, [ref.internal_id])).rows[0];
    if (linked) assertKeyBranchAllowed(keyScope, linked.branch_id);
    const updated = (
      await pgPool.query(CUSTOMER_CONTACT_UPDATE_SQL, [
        ref.internal_id,
        contact,
        text(body?.email, 150) || null,
        text(body?.address, 500) || null,
        actor,
      ])
    ).rows[0];
    if (updated) return { status: 200, body: customerDto(updated, false) };
  }

  // A customer the ERP already has under the portal's own code is linked, not
  // duplicated: the local row keeps its identity and gets a ref row.
  const existingCode = (await pgPool.query(CUSTOMER_BY_CODE_SQL, [externalId])).rows[0];
  if (existingCode) {
    // Linking is a write through this key even though it lands in external_refs:
    // refuse a customer outside the scope instead of handing the portal a
    // success it cannot subsequently bill.
    assertKeyBranchAllowed(keyScope, existingCode.branch_id);
    await pgPool.query(EXTERNAL_REF_UPSERT_SQL, [
      partner.id,
      'CUSTOMER',
      externalId,
      existingCode.id,
    ]);
    const row = (await pgPool.query(CUSTOMER_BY_ID_SQL, [existingCode.id])).rows[0];
    return { status: 200, body: customerDto(row, false) };
  }

  const id = `cust-${crypto.randomUUID()}`;
  const inserted = (
    await pgPool.query(CUSTOMER_INSERT_SQL, [
      id,
      externalId,
      name,
      text(body?.username, 100) || null,
      contact,
      branch.id,
      text(body?.address, 500) || null,
      text(body?.email, 150) || null,
      actor,
    ])
  ).rows[0];
  await pgPool.query(EXTERNAL_REF_UPSERT_SQL, [partner.id, 'CUSTOMER', externalId, inserted.id]);
  await logAuditEvent(
    { user: { email: actor } } as any,
    'PARTNER_CUSTOMER_CREATED',
    'MASTER_DATA',
    `Partner ${partner.code} created customer ${inserted.customer_id} (${inserted.customer_name})`,
    String(branch.id)
  );
  return { status: 201, body: customerDto(inserted, true) };
}

/**
 * One subscription period -> one service invoice -> one AR journal.
 *
 * Idempotent on (partner, external subscription id, service_from). The invoice
 * and its journal are written in one transaction: a document without its ledger
 * entry never exists.
 */
export async function ingestSubscription(
  partner: any,
  body: any,
  actor: string,
  keyScope: Set<string> | null
): Promise<{ status: number; body: any }> {
  const externalSubscriptionId = required(
    body?.externalSubscriptionId,
    160,
    'externalSubscriptionId'
  );
  const customerExternalId = required(body?.customerExternalId, 160, 'customerExternalId');
  const planName = required(body?.planName, 150, 'planName');
  const durationDays = Math.trunc(Number(body?.durationDays));
  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    throw new ApiError(400, 'durationDays must be a positive whole number of days.');
  }
  const serviceFrom = isoDate(body?.serviceFromAD, 'serviceFromAD');
  const serviceTo = isoDate(body?.serviceToAD, 'serviceToAD');
  if (serviceTo < serviceFrom) {
    throw new ApiError(400, 'serviceToAD must not be before serviceFromAD.');
  }
  const subtotal = amount(body?.subtotal, 'subtotal');
  const taxAmount = amount(body?.taxAmount ?? 0, 'taxAmount');
  const total = Math.round((subtotal + taxAmount) * 100) / 100;
  if (total <= 0) throw new ApiError(400, 'A service invoice must carry a positive total.');

  const ref = (
    await pgPool.query(EXTERNAL_REF_BY_EXTERNAL_SQL, [
      partner.id,
      'CUSTOMER',
      customerExternalId,
    ])
  ).rows[0];
  if (!ref) {
    throw new ApiError(
      404,
      `Customer ${customerExternalId} has not been synced to this ERP yet; send it to /api/partner/v1/customers first.`,
      { code: 'CUSTOMER_NOT_LINKED' }
    );
  }
  const customer = (await pgPool.query(CUSTOMER_BY_ID_SQL, [ref.internal_id])).rows[0];
  if (!customer) throw new ApiError(404, 'The linked customer no longer exists.');

  const branchId = text(body?.branchId, 50) || String(customer.branch_id);
  const branch = (await pgPool.query(BRANCH_BY_ID_SQL, [branchId])).rows[0];
  if (!branch) throw new ApiError(400, `Unknown branch "${branchId}".`);
  // Checked on the RESOLVED branch: when the body names no branch the invoice
  // is billed in the linked customer's branch, which the body-only guard in
  // the controller never sees.
  assertKeyBranchAllowed(keyScope, branch.id);

  const existing = (
    await pgPool.query(SERVICE_INVOICE_EXISTS_SQL, [
      partner.id,
      externalSubscriptionId,
      serviceFrom,
    ])
  ).rows[0];
  if (existing) {
    return {
      status: 200,
      body: {
        invoiceId: existing.id,
        invoiceNumber: existing.invoice_number,
        created: false,
        periodFrom: serviceFrom,
      },
    };
  }

  const invoiceDate = isoDate(body?.invoiceDateAD, 'invoiceDateAD');
  const id = `sinv-${crypto.randomUUID()}`;
  const seq = Number((await pgPool.query(SERVICE_INVOICE_NUMBER_SQL, [])).rows[0].value);
  const invoiceNumber = `SINV-${String(seq).padStart(6, '0')}`;
  // The document date is a business date, so it carries its BS half; a date the
  // seeded calendar cannot express is refused rather than stored half-paired.
  const invoiceDateBs = resolveBsDateForLedgerSync(invoiceDate);

  const saved = await withTransaction(async (client) => {
    const posted = await postServiceInvoiceLedger(client, {
      invoice: {
        id,
        invoiceNumber,
        branchId: branch.id,
        invoiceDateAD: invoiceDate,
        customerId: customer.id,
        customerName: customer.customer_name,
        subtotal,
        taxAmount,
        total,
      },
      actor,
    });
    const invoice = (
      await client.query(SERVICE_INVOICE_INSERT_SQL, [
        id,
        invoiceNumber,
        customer.id,
        customer.customer_name,
        branch.id,
        partner.id,
        externalSubscriptionId,
        planName,
        durationDays,
        serviceFrom,
        serviceTo,
        invoiceDate,
        subtotal,
        taxAmount,
        total,
        posted?.id ?? null,
        text(body?.notes, 500) || null,
        actor,
        invoiceDateBs,
      ])
    ).rows[0];
    await client.query(SERVICE_INVOICE_LINE_INSERT_SQL, [
      `sinvl-${crypto.randomUUID()}`,
      id,
      1,
      `${planName} — ${durationDays} day(s)`,
      1,
      subtotal,
      subtotal > 0 ? Math.round((taxAmount / subtotal) * 10000) / 100 : 0,
      subtotal,
    ]);
    await client.query(OUTBOX_ENQUEUE_SQL, [
      partner.id,
      'subscription.invoice.created',
      'SERVICE_INVOICE',
      invoice.id,
      JSON.stringify({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        externalSubscriptionId,
        customerExternalId,
        total,
        journalId: invoice.journal_id,
      }),
    ]);
    await logAuditEvent(
      { user: { email: actor } } as any,
      'PARTNER_SERVICE_INVOICE_POSTED',
      'ACCOUNTING',
      `Partner ${partner.code} billed ${customer.customer_name} ${invoiceNumber} for ${planName} (${serviceFrom}–${serviceTo}), total ${total}`,
      String(branch.id),
      client
    );
    return invoice;
  });

  return {
    status: 201,
    body: {
      invoiceId: saved.id,
      invoiceNumber: saved.invoice_number,
      total: Number(saved.total),
      journalId: saved.journal_id,
      created: true,
      periodFrom: serviceFrom,
      periodTo: serviceTo,
    },
  };
}

/**
 * Portal stock consumption -> guarded branch-stock decrement.
 *
 * A shortage is a CONFLICT row plus a queued outbound event, never a silent
 * drop and never a negative balance: the guarded UPDATE matches zero rows and
 * the service records why.
 */
export async function ingestConsumption(
  partner: any,
  body: any,
  actor: string
): Promise<{ status: number; body: any }> {
  const externalId = required(body?.externalId, 160, 'externalId');
  const quantity = Math.trunc(Number(body?.quantity));
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new ApiError(400, 'quantity must be a positive whole number.');
  }
  const productKey = required(body?.productId ?? body?.sku, 50, 'productId (or sku)');
  const branchCode = required(body?.branchCode, 20, 'branchCode');

  const prior = (
    await pgPool.query(STOCK_CONSUMPTION_BY_EXTERNAL_SQL, [partner.id, externalId])
  ).rows[0];
  if (prior) {
    return {
      status: 200,
      body: {
        externalId,
        status: prior.status,
        conflictReason: prior.conflict_reason,
        replayed: true,
      },
    };
  }

  const product = (await pgPool.query(PRODUCT_EXISTS_SQL, [productKey])).rows[0];
  if (!product) throw new ApiError(404, `Unknown product "${productKey}".`);
  const branch = (await pgPool.query(BRANCH_BY_CODE_SQL, [branchCode])).rows[0];
  if (!branch) throw new ApiError(400, `Unknown branch code "${branchCode}".`);

  const outcome = await withTransaction(async (client) => {
    const deducted = (
      await client.query(STOCK_CONSUME_SQL, [quantity, product.id, branch.id])
    ).rows[0];
    if (!deducted) {
      const level = (await client.query(STOCK_LEVEL_SQL, [product.id, branch.id])).rows[0];
      const reason = level
        ? `Only ${level.quantity_on_hand} unit(s) on hand at ${branch.code}; ${quantity} requested.`
        : `No stock row for ${product.sku} at ${branch.code}.`;
      const event = (
        await client.query(STOCK_CONSUMPTION_INSERT_SQL, [
          partner.id,
          externalId,
          product.id,
          branch.id,
          quantity,
          'CONFLICT',
          reason,
          text(body?.idempotencyKey, 160),
        ])
      ).rows[0];
      await client.query(OUTBOX_ENQUEUE_SQL, [
        partner.id,
        'inventory.consumption.conflict',
        'STOCK_CONSUMPTION',
        externalId,
        JSON.stringify({ externalId, productId: product.id, sku: product.sku, quantity, reason }),
      ]);
      return { status: 'CONFLICT', conflictReason: reason, eventId: event?.id ?? null };
    }
    const event = (
      await client.query(STOCK_CONSUMPTION_INSERT_SQL, [
        partner.id,
        externalId,
        product.id,
        branch.id,
        quantity,
        'APPLIED',
        null,
        text(body?.idempotencyKey, 160),
      ])
    ).rows[0];
    await client.query(OUTBOX_ENQUEUE_SQL, [
      partner.id,
      'inventory.stock_changed',
      'PRODUCT',
      product.id,
      JSON.stringify({
        productId: product.id,
        sku: product.sku,
        branchCode: branch.code,
        quantityOnHand: Number(deducted.quantity_on_hand),
        reason: 'PARTNER_CONSUMPTION',
      }),
    ]);
    await logAuditEvent(
      { user: { email: actor } } as any,
      'PARTNER_STOCK_CONSUMED',
      'INVENTORY',
      `Partner ${partner.code} consumed ${quantity} × ${product.sku} at ${branch.code} (${externalId}); ${deducted.quantity_on_hand} left`,
      String(branch.id),
      client
    );
    return {
      status: 'APPLIED',
      quantityOnHand: Number(deducted.quantity_on_hand),
      eventId: event?.id ?? null,
    };
  });

  return {
    status: outcome.status === 'APPLIED' ? 201 : 409,
    body: { externalId, ...outcome },
  };
}

/** Queue the current stock picture for the partner (paged by product id). */
export async function queueStockSnapshot(
  partner: any,
  branchId: string | null,
  cursor: string | null,
  limit = 200
): Promise<{ queued: number; nextCursor: string | null }> {
  const rows = (
    await pgPool.query(STOCK_SNAPSHOT_SQL, [branchId, cursor, Math.min(500, limit)])
  ).rows;
  for (const row of rows) {
    await pgPool.query(OUTBOX_ENQUEUE_SQL, [
      partner.id,
      'inventory.stock_changed',
      'PRODUCT',
      row.product_id,
      JSON.stringify({
        productId: row.product_id,
        sku: row.sku,
        productName: row.product_name,
        branchCode: row.branch_code,
        quantityOnHand: Number(row.quantity_on_hand),
        averageCost: Number(row.average_cost),
      }),
    ]);
  }
  return { queued: rows.length, nextCursor: rows.length ? String(rows[rows.length - 1].product_id) : null };
}

/**
 * HR outbound with an explicit allowlist: identity and org only. Salary, PAN,
 * bank, date of birth and attendance never leave through this path.
 */
export async function queueHrSnapshot(
  partner: any,
  branchId: string | null,
  cursor: string | null,
  limit = 200
): Promise<{ queued: number; nextCursor: string | null }> {
  const rows = (
    await pgPool.query(HR_SNAPSHOT_SQL, [branchId, cursor, Math.min(500, limit)])
  ).rows;
  for (const row of rows) {
    await pgPool.query(OUTBOX_ENQUEUE_SQL, [
      partner.id,
      'hr.employee_changed',
      'EMPLOYEE',
      row.id,
      JSON.stringify({
        employeeId: row.id,
        employeeCode: row.employee_code,
        name: row.name,
        branchId: row.branch_id,
        branchCode: row.branch_code,
        branchName: row.branch_name,
        department: row.department,
        designation: row.designation,
        joiningDateAD: row.joining_date_ad,
        separationDateAD: row.separation_date_ad,
        email: row.email,
      }),
    ]);
  }
  return { queued: rows.length, nextCursor: rows.length ? String(rows[rows.length - 1].employee_code) : null };
}

function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Drain the outbox once. Deliveries are signed with the partner's secret and
 * every attempt (success or failure) is recorded. After the attempt budget the
 * row becomes DEAD and waits for a human replay from the admin screen.
 */
export async function deliverOutbox(
  limit = 20
): Promise<{ delivered: number; failed: number; skipped: number }> {
  const rows = (await pgPool.query(OUTBOX_PENDING_SQL, [limit])).rows;
  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const target = (
      await pgPool.query(PARTNER_DELIVERY_TARGET_SQL, [row.partner_id])
    ).rows[0];
    if (!target?.webhook_url) {
      await pgPool.query(OUTBOX_MARK_FAILED_SQL, [
        row.id,
        MAX_DELIVERY_ATTEMPTS,
        300,
        'No webhook URL is configured for this partner.',
      ]);
      failed += 1;
      continue;
    }
    const body = JSON.stringify({
      id: row.id,
      event: row.event,
      entity: row.entity,
      entityId: row.entity_id,
      contractVersion: row.contract_version,
      payload: row.payload,
      deliveredAt: new Date().toISOString(),
    });
    const signature = sign(String(target.webhook_secret || ''), body);
    const startedAt = Date.now();
    try {
      const response = await fetch(target.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-isp-event': row.event,
          'x-isp-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const responseBody = (await response.text().catch(() => '')).slice(0, 2000);
      await pgPool.query(OUTBOX_ATTEMPT_INSERT_SQL, [
        row.id,
        Number(row.attempts) + 1,
        target.webhook_url,
        signature,
        response.status,
        responseBody,
        Date.now() - startedAt,
        response.ok ? null : `HTTP ${response.status}`,
      ]);
      if (response.ok) {
        await pgPool.query(OUTBOX_MARK_DELIVERED_SQL, [row.id]);
        delivered += 1;
      } else {
        const backoff = Math.min(3600, 30 * 2 ** Number(row.attempts));
        await pgPool.query(OUTBOX_MARK_FAILED_SQL, [
          row.id,
          MAX_DELIVERY_ATTEMPTS,
          backoff,
          `Partner answered ${response.status}.`,
        ]);
        failed += 1;
      }
    } catch (err: any) {
      const backoff = Math.min(3600, 30 * 2 ** Number(row.attempts));
      await pgPool.query(OUTBOX_ATTEMPT_INSERT_SQL, [
        row.id,
        Number(row.attempts) + 1,
        target.webhook_url,
        signature,
        null,
        null,
        Date.now() - startedAt,
        String(err?.message || err).slice(0, 500),
      ]);
      await pgPool.query(OUTBOX_MARK_FAILED_SQL, [
        row.id,
        MAX_DELIVERY_ATTEMPTS,
        backoff,
        String(err?.message || err).slice(0, 500),
      ]);
      failed += 1;
    }
  }
  skipped = rows.length - delivered - failed;
  return { delivered, failed, skipped };
}

export async function listPartners(): Promise<any[]> {
  return (await pgPool.query(PARTNER_LIST_SQL, [])).rows;
}

export async function createPartner(body: any, actor: string): Promise<any> {
  const code = required(body?.code, 40, 'code').toUpperCase();
  const name = required(body?.name, 150, 'name');
  const apiKeyId = text(body?.apiKeyId, 40) || null;
  const events = Array.isArray(body?.allowedEvents)
    ? body.allowedEvents.map((event: unknown) => text(event, 60)).filter(Boolean)
    : [];
  const id = `partner-${crypto.randomUUID()}`;
  const row = (
    await pgPool.query(PARTNER_INSERT_SQL, [
      id,
      code,
      name,
      text(body?.contractVersion, 20) || 'v1',
      apiKeyId,
      events,
      actor,
    ])
  ).rows[0];
  await pgPool.query(PARTNER_UPDATE_SQL, [
    row.id,
    null,
    null,
    text(body?.webhookUrl, 500) || null,
    null,
  ]);
  return row;
}

export async function updatePartner(id: string, body: any): Promise<any> {
  const events = Array.isArray(body?.allowedEvents)
    ? body.allowedEvents.map((event: unknown) => text(event, 60)).filter(Boolean)
    : null;
  const row = (
    await pgPool.query(PARTNER_UPDATE_SQL, [
      id,
      text(body?.name, 150) || null,
      events,
      text(body?.webhookUrl, 500) || null,
      text(body?.status, 20) || null,
    ])
  ).rows[0];
  if (!row) throw new ApiError(404, 'Integration partner not found.');
  return row;
}

export async function replayOutbox(id: string): Promise<any> {
  const row = (await pgPool.query(OUTBOX_REPLAY_SQL, [id])).rows[0];
  if (!row) {
    const existing = (await pgPool.query(OUTBOX_BY_ID_SQL, [id])).rows[0];
    if (!existing) throw new ApiError(404, 'Outbox event not found.');
    throw new ApiError(409, `This event is ${existing.status}; only a failed or dead event can be replayed.`);
  }
  return row;
}

export async function recordInbox(
  partner: any,
  kind: string,
  key: string,
  payload: unknown,
  verdict: 'ACCEPTED' | 'REFUSED' | 'FAILED',
  error?: { code?: string; message?: string }
): Promise<void> {
  await pgPool.query(INBOX_INSERT_SQL, [
    partner.id,
    kind,
    key,
    JSON.stringify(payload ?? {}),
    verdict,
    error?.code ?? null,
    error?.message?.slice(0, 500) ?? null,
  ]);
}

export async function partnerByCode(code: string): Promise<any> {
  return (await pgPool.query(PARTNER_BY_CODE_SQL, [code])).rows[0];
}
