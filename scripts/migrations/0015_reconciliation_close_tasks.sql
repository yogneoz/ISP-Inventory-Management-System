-- ACC-6: provider settlement is a month-end close control alongside the
-- existing inventory/GL reconciliation task. The provider reconciliation tab
-- supplies the evidence; the close checklist makes the review explicit.
-- Existing periods receive the task through CLOSE_ITEM_ENSURE_SQL; new periods
-- copy this template.

INSERT INTO gl_close_task_templates (id, code, title, description, required, sort_order)
VALUES (
  'glct-psp-reconcile',
  'PSP_RECONCILE',
  'Reconcile provider settlements',
  'Match eSewa, Khalti and Nepal Pay settlements to the wallet clearing ledger and explain every unresolved receipt or statement line before close.',
  TRUE,
  46
)
ON CONFLICT (code) DO NOTHING;
