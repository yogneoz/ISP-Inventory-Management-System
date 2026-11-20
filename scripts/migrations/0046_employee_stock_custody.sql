-- 0046: per-employee stock custody.
--
-- Stock was tracked per branch and per serial, never per person: a technician's
-- van was invisible, and offboarding could not ask what was still out. These two
-- tables make custody a ledger.
--
-- `employee_stock_movements` is append-only and is the truth. `employee_stock_
-- holdings` is its projection — one row per employee/product/branch, rebuilt in
-- the same transaction as every movement, so a double write or a lost row cannot
-- leave the two disagreeing.
CREATE TABLE IF NOT EXISTS employee_stock_movements (
    id BIGSERIAL PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    movement_type VARCHAR(16) NOT NULL CHECK (movement_type IN ('ISSUE', 'RETURN', 'CONSUME', 'TRANSFER', 'LOSS')),
    quantity INT NOT NULL CHECK (quantity > 0),
    work_order_id UUID REFERENCES field_work_orders(id) ON DELETE SET NULL,
    reason TEXT,
    actor VARCHAR(200) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- A loss writes stock off against a person, so the reason is part of the
    -- row, not an afterthought the screen may omit.
    CONSTRAINT employee_stock_loss_needs_reason
      CHECK (movement_type <> 'LOSS' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_employee_stock_movements_employee
  ON employee_stock_movements (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_stock_movements_product
  ON employee_stock_movements (product_id, branch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS employee_stock_holdings (
    employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (employee_id, product_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_stock_holdings_branch
  ON employee_stock_holdings (branch_id, employee_id);
