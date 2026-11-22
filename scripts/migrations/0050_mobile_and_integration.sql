-- 0050 — mobile client backend + external partner integration spine.
--
-- Two surfaces get their storage here, and they share one rule: a write that
-- arrives from outside this application is idempotent, keeps its own identity
-- mapping, and lands in a domain table that this ERP owns. Nothing here lets a
-- partner or a phone write a ledger row directly; the services do that through
-- the same postJournal/stock paths the web UI uses.
--
-- Mobile (PulseHR /api/v1):
--   mobile_devices, mobile_refresh_tokens, mobile_fcm_tokens,
--   employee_shift_roster, hr_attendance_proofs, hr_expense_claims,
--   hr_delegations, company_announcements, employee_location_breadcrumbs,
--   mobile_change_log
--   and hr_attendance.source learns MOBILE.
--
-- Integration (/api/partner/v1):
--   integration_partners, external_refs, integration_inbox, integration_outbox,
--   integration_delivery_attempts, service_invoices, service_invoice_lines,
--   stock_consumption_events
--   plus the shared idempotency_keys table both surfaces use.
--
-- service_invoices exists because a subscription is not a stock movement:
-- sales_invoices deducts branch stock for every line (SI_DEDUCT_STOCK_SQL) and
-- refuses the document when the stock is absent, so a package sale cannot ride
-- that table without inventing inventory. These documents post AR + tax +
-- service revenue through postJournal and never touch stock.

BEGIN;

-- ---------------------------------------------------------------------------
-- Mobile client
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mobile_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id VARCHAR(120) NOT NULL UNIQUE,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  model_name VARCHAR(120) NOT NULL DEFAULT '',
  app_version VARCHAR(40) NOT NULL DEFAULT '',
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mobile_devices_employee
  ON mobile_devices (employee_id, bound_at DESC);

-- The geofence the phone's punch is checked against. `branches` carries no
-- coordinates, and putting them here keeps branch master data untouched. A
-- branch without a row has no geofence requirement (a head-office desk worker),
-- which the punch service states in its response instead of inventing a radius.
CREATE TABLE IF NOT EXISTS branch_geofences (
  branch_id VARCHAR(50) PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  latitude NUMERIC(10, 6) NOT NULL,
  longitude NUMERIC(10, 6) NOT NULL,
  radius_meters INTEGER NOT NULL DEFAULT 150 CHECK (radius_meters BETWEEN 10 AND 20000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobile_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(120) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mobile_refresh_tokens_user
  ON mobile_refresh_tokens (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS mobile_fcm_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id VARCHAR(120) NOT NULL DEFAULT '',
  fcm_token TEXT NOT NULL UNIQUE,
  platform VARCHAR(20) NOT NULL DEFAULT 'ANDROID',
  topics TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mobile_fcm_tokens_employee
  ON mobile_fcm_tokens (employee_id, is_active);

-- The roster the app shows on the home screen. `hr_shifts` is the shift
-- definition; this is one employee's assignment on one date.
CREATE TABLE IF NOT EXISTS employee_shift_roster (
  id VARCHAR(60) PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id VARCHAR(50) NOT NULL REFERENCES hr_shifts(id) ON DELETE RESTRICT,
  branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  shift_date_ad DATE NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'ROSTER',
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, shift_date_ad, shift_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_shift_roster_date
  ON employee_shift_roster (employee_id, shift_date_ad DESC);

-- GEO proof of a mobile punch. One row per attendance row: the coordinates are
-- what the server evaluated, not what the client claimed it evaluated.
CREATE TABLE IF NOT EXISTS hr_attendance_proofs (
  attendance_id VARCHAR(50) PRIMARY KEY REFERENCES hr_attendance(id) ON DELETE CASCADE,
  latitude NUMERIC(10, 6) NOT NULL,
  longitude NUMERIC(10, 6) NOT NULL,
  distance_meters NUMERIC(10, 2) NOT NULL,
  gps_accuracy_meters NUMERIC(8, 2),
  wifi_bssid VARCHAR(64),
  device_id VARCHAR(120),
  device_time_epoch_ms BIGINT,
  server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  inside_geofence BOOLEAN NOT NULL DEFAULT TRUE,
  integrity_status VARCHAR(20) NOT NULL DEFAULT 'VERIFIED'
    CHECK (integrity_status IN ('VERIFIED', 'SUSPECT', 'REJECTED')),
  risk_score INT NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  integrity_notes VARCHAR(500)
);

CREATE TABLE IF NOT EXISTS hr_expense_claims (
  id VARCHAR(60) PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  category VARCHAR(60) NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'NPR',
  ticket_code VARCHAR(60),
  description VARCHAR(500) NOT NULL DEFAULT '',
  receipt_attached BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'PAID')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by VARCHAR(200),
  decision_note VARCHAR(500),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT hr_expense_claims_decision_state
    CHECK ((status = 'SUBMITTED') = (decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_hr_expense_claims_employee
  ON hr_expense_claims (employee_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS hr_delegations (
  id VARCHAR(60) PRIMARY KEY,
  delegator_employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  delegate_employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  start_date_ad DATE NOT NULL,
  end_date_ad DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hr_delegations_window CHECK (end_date_ad >= start_date_ad),
  CONSTRAINT hr_delegations_not_self CHECK (delegator_employee_id <> delegate_employee_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_delegations_delegator
  ON hr_delegations (delegator_employee_id, end_date_ad DESC);

CREATE TABLE IF NOT EXISTS company_announcements (
  id VARCHAR(60) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  summary VARCHAR(1000) NOT NULL DEFAULT '',
  category VARCHAR(60) NOT NULL DEFAULT 'GENERAL',
  branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_urgent BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_company_announcements_published
  ON company_announcements (published_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS employee_location_breadcrumbs (
  id VARCHAR(80) PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id VARCHAR(120) NOT NULL DEFAULT '',
  route_session_id VARCHAR(80) NOT NULL,
  event_type VARCHAR(20) NOT NULL DEFAULT 'WAYPOINT'
    CHECK (event_type IN ('CHECK_IN', 'WAYPOINT', 'MANUAL_PUSH', 'CHECK_OUT')),
  latitude NUMERIC(10, 6) NOT NULL,
  longitude NUMERIC(10, 6) NOT NULL,
  accuracy_meters NUMERIC(8, 2),
  site_label VARCHAR(120) NOT NULL DEFAULT '',
  distance_from_branch_meters NUMERIC(10, 2),
  is_inside_geofence BOOLEAN NOT NULL DEFAULT FALSE,
  captured_at_epoch_ms BIGINT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_location_breadcrumbs_employee
  ON employee_location_breadcrumbs (employee_id, captured_at DESC);

-- The sync cursor: one append-only row per change the mobile client may need to
-- pull. `seq` is monotonic (BIGSERIAL), so `/sync/pull?updated_since=` is a
-- range scan, not a union over every table's updated_at.
CREATE TABLE IF NOT EXISTS mobile_change_log (
  seq BIGSERIAL PRIMARY KEY,
  entity VARCHAR(40) NOT NULL,
  entity_id VARCHAR(80) NOT NULL,
  operation VARCHAR(10) NOT NULL CHECK (operation IN ('UPSERT', 'DELETE')),
  branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
  employee_id VARCHAR(50) REFERENCES employees(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mobile_change_log_employee
  ON mobile_change_log (employee_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_change_log_branch
  ON mobile_change_log (branch_id, seq DESC);

-- A phone can re-send a queued action after a timeout; the server answers with
-- the first response instead of applying it twice. The scope keeps the mobile
-- and partner surfaces from colliding on a key.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(40) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
  ON idempotency_keys (created_at DESC);

-- hr_attendance.source is a CHECK vocabulary; 'MOBILE' is the phone's punch. A
-- plain ADD COLUMN would not change an existing CHECK, so the constraint is
-- replaced by name and the new predicate is a superset of the old one.
-- Idempotent: a fresh install from schema.sql carries the inline CHECK under
-- the same generated name, and a re-run of this migration must not fail on an
-- already-present constraint. Both paths converge on one named constraint.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'hr_attendance'
      AND con.contype = 'c'
      AND (
        pg_get_constraintdef(con.oid) LIKE '%MANUAL%IMPORT%'
        OR con.conname = 'hr_attendance_source_check'
      )
  LOOP
    EXECUTE format('ALTER TABLE hr_attendance DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  ALTER TABLE hr_attendance
    ADD CONSTRAINT hr_attendance_source_check
    CHECK (source IN ('MANUAL', 'IMPORT', 'MOBILE'));
END
$$;

-- ---------------------------------------------------------------------------
-- External partner integration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_partners (
  id VARCHAR(50) PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  contract_version VARCHAR(20) NOT NULL DEFAULT 'v1',
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  allowed_events TEXT[] NOT NULL DEFAULT '{}',
  -- Where this partner receives event callbacks, and the shared secret its
  -- deliveries are signed with (`X-ISP-Signature: sha256=<hmac>`). A partner
  -- without a URL keeps its events queued; nothing is dropped.
  webhook_url VARCHAR(500),
  webhook_secret VARCHAR(200),
  created_by VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_partners_api_key
  ON integration_partners (api_key_id) WHERE api_key_id IS NOT NULL;

-- The webhook target arrived after the first shape of this table; ADD COLUMN IF
-- NOT EXISTS keeps a re-run idempotent on an install that already has the table.
ALTER TABLE integration_partners ADD COLUMN IF NOT EXISTS webhook_url VARCHAR(500);
ALTER TABLE integration_partners ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(200);

-- The identity bridge. One row per (partner, entity, external id) and per
-- (partner, entity, internal id), so a re-sync cannot create a second copy and a
-- partner cannot claim an internal row that another partner already owns.
CREATE TABLE IF NOT EXISTS external_refs (
  id BIGSERIAL PRIMARY KEY,
  partner_id VARCHAR(50) NOT NULL REFERENCES integration_partners(id) ON DELETE CASCADE,
  entity VARCHAR(40) NOT NULL,
  external_id VARCHAR(160) NOT NULL,
  internal_id VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, entity, external_id),
  UNIQUE (partner_id, entity, internal_id)
);

CREATE TABLE IF NOT EXISTS integration_inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id VARCHAR(50) NOT NULL REFERENCES integration_partners(id) ON DELETE CASCADE,
  kind VARCHAR(40) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL DEFAULT '',
  payload JSONB NOT NULL,
  verdict VARCHAR(20) NOT NULL DEFAULT 'ACCEPTED'
    CHECK (verdict IN ('ACCEPTED', 'REFUSED', 'FAILED')),
  error_code VARCHAR(60),
  error_message VARCHAR(500),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_inbox_partner
  ON integration_inbox (partner_id, received_at DESC);

CREATE TABLE IF NOT EXISTS integration_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id VARCHAR(50) NOT NULL REFERENCES integration_partners(id) ON DELETE CASCADE,
  event VARCHAR(60) NOT NULL,
  entity VARCHAR(40) NOT NULL DEFAULT '',
  entity_id VARCHAR(80) NOT NULL DEFAULT '',
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'DEAD')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_integration_outbox_pending
  ON integration_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS integration_delivery_attempts (
  id BIGSERIAL PRIMARY KEY,
  outbox_id UUID NOT NULL REFERENCES integration_outbox(id) ON DELETE CASCADE,
  attempt_no INT NOT NULL,
  endpoint TEXT,
  signature VARCHAR(200),
  response_status INT,
  response_body VARCHAR(2000),
  latency_ms INT,
  error_message VARCHAR(500),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_delivery_attempts_outbox
  ON integration_delivery_attempts (outbox_id, attempted_at DESC);

-- A service document: the subscription portal's package sale, posted to AR
-- without touching stock. `invoice_number` is unique because this table is not
-- partitioned; when it is, the number moves to document_identity_registry the
-- way sales_invoices did.
-- One series for partner-sourced service documents. A sequence (not a MAX+1)
-- keeps concurrent ingests from minting the same number.
CREATE SEQUENCE IF NOT EXISTS service_invoice_number_seq START WITH 1;

CREATE TABLE IF NOT EXISTS service_invoices (
  id VARCHAR(60) PRIMARY KEY,
  invoice_number VARCHAR(100) NOT NULL UNIQUE,
  customer_id VARCHAR(50) REFERENCES customer_records(id) ON DELETE SET NULL,
  customer_name VARCHAR(200) NOT NULL,
  branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  partner_id VARCHAR(50) REFERENCES integration_partners(id) ON DELETE SET NULL,
  external_subscription_id VARCHAR(160),
  plan_name VARCHAR(150) NOT NULL,
  duration_days INT NOT NULL CHECK (duration_days > 0),
  service_from_ad DATE NOT NULL,
  service_to_ad DATE NOT NULL,
  invoice_date_ad DATE NOT NULL,
  subtotal NUMERIC(14, 2) NOT NULL CHECK (subtotal >= 0),
  tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'POSTED'
    CHECK (status IN ('DRAFT', 'POSTED', 'VOID')),
  journal_id VARCHAR(60),
  notes VARCHAR(500),
  created_by VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ,
  CONSTRAINT service_invoices_period CHECK (service_to_ad >= service_from_ad),
  CONSTRAINT service_invoices_total CHECK (total = subtotal + tax_amount)
);

CREATE INDEX IF NOT EXISTS idx_service_invoices_customer
  ON service_invoices (customer_id, invoice_date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_service_invoices_partner_period
  ON service_invoices (partner_id, external_subscription_id, service_from_ad);

CREATE TABLE IF NOT EXISTS service_invoice_lines (
  id VARCHAR(60) PRIMARY KEY,
  invoice_id VARCHAR(60) NOT NULL REFERENCES service_invoices(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  description VARCHAR(300) NOT NULL,
  quantity NUMERIC(12, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(14, 2) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  UNIQUE (invoice_id, line_no)
);

-- What the portal says it consumed. APPLIED rows already moved branch stock and
-- posted their journal; CONFLICT rows are queued for a human instead of being
-- dropped, because a silent drop is how two systems drift apart.
CREATE TABLE IF NOT EXISTS stock_consumption_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id VARCHAR(50) NOT NULL REFERENCES integration_partners(id) ON DELETE CASCADE,
  external_id VARCHAR(160) NOT NULL,
  product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
  branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  quantity INT NOT NULL CHECK (quantity > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'APPLIED'
    CHECK (status IN ('APPLIED', 'CONFLICT')),
  conflict_reason VARCHAR(300),
  idempotency_key VARCHAR(160) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_consumption_events_status
  ON stock_consumption_events (status, created_at DESC);

-- Optimistic concurrency for the phone's queue: a completion carries the
-- baseVersion it read, so a second device cannot overwrite the first.
ALTER TABLE field_work_orders
  ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1;

COMMIT;
