-- 0055 — proof-of-work evidence on a field visit (photo / signature).
--
-- The completion record used to be text and serials only: a technician could
-- close a visit with notes and no proof that anyone was there. This table keeps
-- the attachment itself — a JPEG/PNG/WebP photo or a signature capture — beside
-- the order, with the capture point and time the device reported.
--
-- The rows are content-addressed per order (`sha256`), so a queued capture that
-- is re-sent after a timeout stores once and returns the same row instead of
-- stacking duplicates. Bytes live in the row: the deployment has no object
-- store, and a 2 MiB ceiling keeps a table scan honest. The branch is copied
-- from the order at write time so the evidence read is branch-scoped without a
-- join through the order.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS field_work_order_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID NOT NULL REFERENCES field_work_orders(id) ON DELETE CASCADE,
  branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('PHOTO', 'SIGNATURE')),
  content_type VARCHAR(60) NOT NULL
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INT NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  sha256 CHAR(64) NOT NULL,
  data_base64 TEXT NOT NULL,
  caption VARCHAR(200),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_by VARCHAR(200) NOT NULL,
  latitude NUMERIC(9, 6) CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
  longitude NUMERIC(9, 6) CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
  accuracy_meters NUMERIC(8, 2) CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per distinct capture on an order: a retried queue item is the same
-- photo, not a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_field_work_order_evidence_capture
  ON field_work_order_evidence (work_order_id, sha256);

CREATE INDEX IF NOT EXISTS idx_field_work_order_evidence_order
  ON field_work_order_evidence (work_order_id, created_at DESC);
