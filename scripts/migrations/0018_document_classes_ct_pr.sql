-- NUM-1: the register needs a class for every manual/custody document the
-- system can issue. Fresh installs get these from the seed; existing installs
-- get an idempotent backfill here. Counters remain untouched.

INSERT INTO document_number_configs (
    id, document_type, prefix, suffix, min_digits, starting_number, next_number,
    reset_every_fiscal_year, notes
)
VALUES
    ('CT', 'Contra / Custody Transfer', 'CT-2081-', '', 4, 1, 1, TRUE,
     'Used when cash, bank or wallet custody moves between two company ledgers.'),
    ('PR', 'Payroll Run', 'PR-2081-', '', 4, 1, 1, TRUE,
     'Used for payroll run journals when payroll is moved onto the central register.')
ON CONFLICT (id) DO NOTHING;