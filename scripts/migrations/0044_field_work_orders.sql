-- Field capture — technician work orders for installation, service and
-- disconnection visits.
--
-- One row is a visit the office can schedule and a technician can close out
-- from the field. The row carries the subscriber it is against, the connection
-- and equipment details captured on site, and the completion record; it is not
-- partitioned because a work order is edited over its life (schedule, assign,
-- complete) and the table grows with subscriber churn, not with ledger volume —
-- the same reasoning as `hr_lifecycle_checklists`.
--
-- `status` moves OPEN -> ASSIGNED -> COMPLETED, or to CANCELLED from either open
-- state. The completion check makes `completed_at` and `COMPLETED` inseparable,
-- so a half-completed row cannot be written by any path.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS field_work_order_no_seq;

CREATE TABLE IF NOT EXISTS field_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_no VARCHAR(40) NOT NULL UNIQUE,
  branch_id VARCHAR(40) NOT NULL REFERENCES branches(id),
  customer_id VARCHAR(40) NOT NULL REFERENCES customer_records(id),
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('INSTALL', 'SERVICE', 'DISCONNECT')),
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED')),
  technician_id VARCHAR(40) REFERENCES employees(id),
  technician_name VARCHAR(200),
  scheduled_date_ad DATE NOT NULL,
  ont_serial VARCHAR(64),
  router_serial VARCHAR(64),
  ip_address VARCHAR(64),
  plan_name VARCHAR(120),
  notes VARCHAR(1000) NOT NULL DEFAULT '',
  completion_notes VARCHAR(1000),
  completed_at TIMESTAMPTZ,
  created_by VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT field_work_orders_completion_state
    CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CONSTRAINT field_work_orders_assigned_needs_technician
    CHECK (status <> 'ASSIGNED' OR technician_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_field_work_orders_branch_date
  ON field_work_orders (branch_id, scheduled_date_ad DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_work_orders_status
  ON field_work_orders (status, scheduled_date_ad);

COMMIT;
