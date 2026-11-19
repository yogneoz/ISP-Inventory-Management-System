-- Round 14 Part C — partner API keys (scoped, expiring, revocable credentials).
--
-- A key is presented by another application as `Authorization: Bearer
-- isp_live_<prefix>_<secret>` or `X-API-Key: isp_live_<prefix>_<secret>`.
-- Only sha256(secret) is stored: the plaintext exists once, in the create/rotate
-- response. `key_prefix` is unique and indexed so authentication is one indexed
-- row lookup followed by a constant-time hash comparison — never a table scan
-- over hashes.
--
-- Scope is an explicit operation list (the permission catalogue's ids) plus a
-- `read_only` switch that rejects every non-GET before RBAC runs, because one
-- operation name often guards both a GET and a POST route. `branch_ids` is the
-- complete branch scope for the key; an empty list means company-wide ('ALL').

BEGIN;

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  key_prefix VARCHAR(40) NOT NULL UNIQUE,
  secret_hash CHAR(64) NOT NULL,
  operations TEXT[] NOT NULL,
  read_only BOOLEAN NOT NULL DEFAULT TRUE,
  branch_ids TEXT[] NOT NULL DEFAULT '{}',
  rpm_limit INTEGER CHECK (rpm_limit IS NULL OR (rpm_limit >= 1 AND rpm_limit <= 100000)),
  cidr_allowlist TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  revoked_at TIMESTAMPTZ,
  revoked_by VARCHAR(200),
  created_by VARCHAR(200) NOT NULL,
  created_by_email VARCHAR(200),
  rotated_from UUID REFERENCES api_keys(id),
  last_used_at TIMESTAMPTZ,
  last_used_ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_operations_nonempty CHECK (cardinality(operations) > 0)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys (is_active, expires_at);

CREATE TABLE IF NOT EXISTS api_key_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  api_key_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('CREATE', 'ROTATE', 'REVOKE')),
  actor VARCHAR(200) NOT NULL,
  actor_email VARCHAR(200),
  ip VARCHAR(64),
  user_agent VARCHAR(400),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_key ON api_key_audit_logs (api_key_id, created_at DESC);

-- The usage log is an audit trail, not mutable state: UPDATE and DELETE are
-- refused. The transaction-local purge switch the ledger tests already use is
-- the only escape (it is `on` only inside the guarded test/repair transactions).
CREATE OR REPLACE FUNCTION api_key_audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('inventory.allow_ledger_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'api_key_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_api_key_audit_logs_append_only ON api_key_audit_logs;
CREATE TRIGGER trg_api_key_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON api_key_audit_logs
  FOR EACH ROW EXECUTE FUNCTION api_key_audit_logs_append_only();

COMMIT;
