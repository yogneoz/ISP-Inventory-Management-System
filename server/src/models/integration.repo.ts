/**
 * External partner integration (`/api/partner/v1/*`) — all SQL.
 *
 * The ownership boundary this module encodes: the subscription portal owns
 * subscriptions, this ERP owns receivables, stock and HR. Nothing here writes a
 * ledger row; the service posts through `postJournal` and the invoicing path,
 * exactly as the web UI does.
 *
 * Three mechanisms keep a retried or duplicated partner call harmless:
 *   1. `external_refs` maps (partner, entity, external id) to one internal row,
 *      so a re-sync updates instead of duplicating;
 *   2. `idempotency_keys` replays the first response for a repeated key;
 *   3. `stock_consumption_events` is unique on (partner, external id), so the
 *      same consumption cannot decrement stock twice.
 */

export const PARTNER_BY_API_KEY_SQL = `
  SELECT id, code, name, contract_version, status, allowed_events
    FROM integration_partners
   WHERE api_key_id = $1`;

export const PARTNER_BY_CODE_SQL = `
  SELECT id, code, name, contract_version, status, allowed_events, api_key_id
    FROM integration_partners
   WHERE code = $1`;

/** The admin routes address a partner by the `id` the list returns. */
export const PARTNER_BY_ID_SQL = `
  SELECT id, code, name, contract_version, status, allowed_events, api_key_id
    FROM integration_partners
   WHERE id = $1`;

export const PARTNER_INSERT_SQL = `
  INSERT INTO integration_partners (id, code, name, contract_version, api_key_id, allowed_events, created_by)
  VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
  RETURNING id, code, name, contract_version, allowed_events`;

export const PARTNER_LIST_SQL = `
  SELECT p.id, p.code, p.name, p.contract_version, p.status, p.allowed_events,
         p.api_key_id, p.created_at,
         (SELECT COUNT(*)::int FROM integration_outbox o
           WHERE o.partner_id = p.id AND o.status IN ('PENDING', 'FAILED')) AS pending_events,
         (SELECT COUNT(*)::int FROM integration_outbox o
           WHERE o.partner_id = p.id AND o.status = 'DEAD') AS dead_events
    FROM integration_partners p
   ORDER BY p.created_at DESC`;

export const EXTERNAL_REF_BY_EXTERNAL_SQL = `
  SELECT internal_id
    FROM external_refs
   WHERE partner_id = $1 AND entity = $2 AND external_id = $3`;

export const EXTERNAL_REF_UPSERT_SQL = `
  INSERT INTO external_refs (partner_id, entity, external_id, internal_id)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (partner_id, entity, external_id) DO UPDATE
     SET updated_at = now()
  RETURNING internal_id`;

export const CUSTOMER_BY_ID_SQL = `
  SELECT id, customer_id, customer_name, contact_number, branch_id, email, address
    FROM customer_records
   WHERE id = $1`;

export const CUSTOMER_BY_CODE_SQL = `
  SELECT id, customer_id, customer_name
    FROM customer_records
   WHERE customer_id = $1`;

export const CUSTOMER_INSERT_SQL = `
  INSERT INTO customer_records (
    id, customer_id, customer_name, username, contact_number, branch_id,
    address, email, status, created_by, updated_by
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9, $9)
  RETURNING id, customer_id, customer_name, contact_number, branch_id, email, address`;

/**
 * A portal rename must not overwrite a name an operator corrected here. Only
 * the contact fields the portal is authoritative for are updated, and only when
 * they are supplied.
 */
export const CUSTOMER_CONTACT_UPDATE_SQL = `
  UPDATE customer_records
     SET contact_number = COALESCE($2, contact_number),
         email = COALESCE($3, email),
         address = COALESCE($4, address),
         updated_by = $5,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = $1
  RETURNING id, customer_id, customer_name, contact_number, branch_id, email, address`;

export const SERVICE_INVOICE_NUMBER_SQL = `
  SELECT nextval('service_invoice_number_seq')::int AS value`;

export const SERVICE_INVOICE_EXISTS_SQL = `
  SELECT id, invoice_number
    FROM service_invoices
   WHERE partner_id = $1
     AND external_subscription_id = $2
     AND service_from_ad = $3::date`;

export const SERVICE_INVOICE_INSERT_SQL = `
  INSERT INTO service_invoices (
    id, invoice_number, customer_id, customer_name, branch_id, partner_id,
    external_subscription_id, plan_name, duration_days, service_from_ad,
    service_to_ad, invoice_date_ad, subtotal, tax_amount, total, status,
    journal_id, notes, created_by, posted_at, invoice_date_bs
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12::date,
          $13, $14, $15, 'POSTED', $16, $17, $18, now(), $19)
  RETURNING id, invoice_number, total, journal_id`;

export const SERVICE_INVOICE_LINE_INSERT_SQL = `
  INSERT INTO service_invoice_lines (
    id, invoice_id, line_no, description, quantity, unit_price, tax_rate, amount
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING id`;

export const OUTBOX_ENQUEUE_SQL = `
  INSERT INTO integration_outbox (partner_id, event, entity, entity_id, payload)
  VALUES ($1, $2, $3, $4, $5::jsonb)
  RETURNING id, event, created_at`;

export const OUTBOX_PENDING_SQL = `
  SELECT o.id, o.partner_id, o.event, o.entity, o.entity_id, o.payload, o.attempts,
         p.code AS partner_code, p.contract_version
    FROM integration_outbox o
    JOIN integration_partners p ON p.id = o.partner_id
   WHERE o.status IN ('PENDING', 'FAILED')
     AND o.next_attempt_at <= now()
     AND p.status = 'ACTIVE'
   ORDER BY o.created_at
   LIMIT $1`;

export const OUTBOX_LIST_SQL = `
  SELECT o.id, o.event, o.entity, o.entity_id, o.status, o.attempts, o.last_error,
         o.created_at, o.delivered_at, o.next_attempt_at, p.code AS partner_code
    FROM integration_outbox o
    JOIN integration_partners p ON p.id = o.partner_id
   WHERE ($1::text IS NULL OR o.status = $1)
   ORDER BY o.created_at DESC
   LIMIT $2`;

export const OUTBOX_MARK_DELIVERED_SQL = `
  UPDATE integration_outbox
     SET status = 'DELIVERED',
         attempts = attempts + 1,
         delivered_at = now(),
         last_error = NULL
   WHERE id = $1`;

/**
 * A failed delivery keeps its attempts and backs off. `DEAD` is terminal: after
 * the configured attempt budget a human replays it from the admin screen rather
 * than the worker looping forever.
 */
export const OUTBOX_MARK_FAILED_SQL = `
  UPDATE integration_outbox
     SET status = CASE WHEN attempts + 1 >= $2 THEN 'DEAD' ELSE 'FAILED' END,
         attempts = attempts + 1,
         next_attempt_at = now() + ($3::int * interval '1 second'),
         last_error = $4
   WHERE id = $1
  RETURNING status, attempts`;

export const OUTBOX_ATTEMPT_INSERT_SQL = `
  INSERT INTO integration_delivery_attempts (
    outbox_id, attempt_no, endpoint, signature, response_status, response_body,
    latency_ms, error_message
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

export const OUTBOX_BY_ID_SQL = `
  SELECT id, partner_id, event, status, attempts
    FROM integration_outbox
   WHERE id = $1`;

export const OUTBOX_REPLAY_SQL = `
  UPDATE integration_outbox
     SET status = 'PENDING',
         attempts = 0,
         next_attempt_at = now(),
         last_error = NULL
   WHERE id = $1 AND status IN ('FAILED', 'DEAD')
  RETURNING id, status`;

export const INBOX_INSERT_SQL = `
  INSERT INTO integration_inbox (partner_id, kind, idempotency_key, payload, verdict, error_code, error_message)
  VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
  RETURNING id`;

/**
 * The guarded decrement. A missing row (or too little stock) returns zero rows;
 * the service records a CONFLICT row for a human instead of silently dropping
 * the portal's consumption.
 */
export const STOCK_CONSUME_SQL = `
  UPDATE inventory_stock
     SET quantity_on_hand = quantity_on_hand - $1,
         last_updated = CURRENT_TIMESTAMP
   WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1
  RETURNING quantity_on_hand, average_cost`;

export const STOCK_LEVEL_SQL = `
  SELECT quantity_on_hand, average_cost
    FROM inventory_stock
   WHERE product_id = $1 AND branch_id = $2`;

export const STOCK_CONSUMPTION_INSERT_SQL = `
  INSERT INTO stock_consumption_events (
    partner_id, external_id, product_id, branch_id, quantity, status,
    conflict_reason, idempotency_key
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (partner_id, external_id) DO NOTHING
  RETURNING id, status`;

export const STOCK_CONSUMPTION_BY_EXTERNAL_SQL = `
  SELECT id, status, conflict_reason, quantity
    FROM stock_consumption_events
   WHERE partner_id = $1 AND external_id = $2`;

export const PRODUCT_EXISTS_SQL = `
  SELECT id, sku, name FROM products WHERE id = $1 OR sku = $1 LIMIT 1`;

/** HR outbound snapshot: identity and org only — no salary, PAN or bank. */
export const HR_SNAPSHOT_SQL = `
  SELECT e.id, e.employee_code, e.name, e.branch_id, b.code AS branch_code,
         b.name AS branch_name, e.department, e.designation,
         e.joining_date_ad, e.separation_date_ad, u.email
    FROM employees e
    JOIN branches b ON b.id = e.branch_id
    LEFT JOIN users u ON u.id = e.user_id
   WHERE ($1::text IS NULL OR e.branch_id = $1)
     AND ($2::text IS NULL OR e.employee_code > $2)
   ORDER BY e.employee_code
   LIMIT $3`;

export const BRANCH_BY_CODE_SQL = `
  SELECT id, code, name FROM branches WHERE UPPER(code) = UPPER($1) LIMIT 1`;

export const BRANCH_BY_ID_SQL = `
  SELECT id, code, name FROM branches WHERE id = $1 LIMIT 1`;

/** The stock snapshot an outbound push carries: per product and branch. */
export const STOCK_SNAPSHOT_SQL = `
  SELECT s.product_id, p.sku, p.name AS product_name, s.branch_id, b.code AS branch_code,
         s.quantity_on_hand, s.average_cost, s.last_updated
    FROM inventory_stock s
    JOIN products p ON p.id = s.product_id
    JOIN branches b ON b.id = s.branch_id
   WHERE ($1::text IS NULL OR s.branch_id = $1)
     AND ($2::text IS NULL OR s.product_id > $2)
   ORDER BY s.product_id
   LIMIT $3`;

export const PARTNER_DELIVERY_TARGET_SQL = `
  SELECT id, code, webhook_url, webhook_secret
    FROM integration_partners
   WHERE id = $1`;

export const PARTNER_UPDATE_SQL = `
  UPDATE integration_partners
     SET name = COALESCE($2, name),
         allowed_events = COALESCE($3::text[], allowed_events),
         webhook_url = COALESCE($4, webhook_url),
         status = COALESCE($5, status),
         updated_at = now()
   WHERE id = $1
  RETURNING id, code, name, status, allowed_events, webhook_url`;
