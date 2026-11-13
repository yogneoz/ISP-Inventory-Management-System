-- ACC-4: inventory valuation is a close control, not only a report.
-- Existing periods receive the task through CLOSE_ITEM_ENSURE_SQL; new
-- periods copy this template. The close service independently refuses a
-- non-zero valuation/control difference unless an override reason is recorded.

INSERT INTO gl_close_task_templates (id, code, title, description, required, sort_order)
VALUES (
  'glct-inventory-reconcile',
  'INVENTORY_RECONCILE',
  'Reconcile inventory valuation',
  'Confirm the stock register valuation equals the INVENTORY control and explain every difference before close.',
  TRUE,
  45
)
ON CONFLICT (code) DO NOTHING;
