-- 0045: the BS half of a work order's scheduled date.
--
-- 0044 stored only the AD date. Every AD business date the ledger and the UI
-- show pairs with its BS string (see server/src/utils/bsDate.ts), so the
-- column is added here and the repo derives the BS value on insert.
ALTER TABLE field_work_orders ADD COLUMN IF NOT EXISTS scheduled_date_bs TEXT;
