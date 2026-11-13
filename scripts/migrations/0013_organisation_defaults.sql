-- ACC-5: employee and branch master cost-centre defaults.
-- The posting resolver reads the employee default first, then the branch
-- default; an explicit document/line cost centre is never overwritten.

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS default_cost_center_id VARCHAR(50);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS default_cost_center_id VARCHAR(50);

-- Added separately because ADD COLUMN IF NOT EXISTS skips the whole clause
-- (including the foreign key) once the column is present. A fresh schema.sql
-- install also declares these columns, so the migration must attach the
-- constraint explicitly and only once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'branches_default_cost_center_id_fkey'
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_default_cost_center_id_fkey
      FOREIGN KEY (default_cost_center_id) REFERENCES cost_centers(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_default_cost_center_id_fkey'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_default_cost_center_id_fkey
      FOREIGN KEY (default_cost_center_id) REFERENCES cost_centers(id) ON DELETE RESTRICT;
  END IF;
END $$;
