-- 0053 — MyWorkplace v2, Phase 1: the offline push queue's retention table.
--
-- `/api/v1/sync/push` applies a batch of queued actions and answers per item.
-- A refused item keeps its whole payload here: photos, readings, signatures and
-- the idempotency key stay on the server, so the technician's Needs attention
-- inbox can replay it after a coordinator fixes the cause (a serial that is not
-- in the van, a ticket another crew closed). Nothing captured at a customer's
-- premises is thrown away because the server said no.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS mobile_sync_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id VARCHAR(120) NOT NULL,
  action_kind VARCHAR(40) NOT NULL
    CHECK (action_kind IN ('PUNCH', 'CLAIM', 'WORK_ORDER_COMPLETE')),
  employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(160),
  code VARCHAR(60) NOT NULL,
  message VARCHAR(500) NOT NULL,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution VARCHAR(20) CHECK (resolution IN ('REPLAYED', 'DISCARDED')),
  resolved_by VARCHAR(200)
);

-- One row per queued action: a retry updates the reason instead of stacking
-- duplicates, and the app's clientId is scoped to the employee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_sync_rejections_client
  ON mobile_sync_rejections (employee_id, client_id);

CREATE INDEX IF NOT EXISTS idx_mobile_sync_rejections_open
  ON mobile_sync_rejections (employee_id, captured_at DESC)
  WHERE resolved_at IS NULL;
