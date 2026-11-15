-- LEND-1 foundation: a lender is a liability party, not a supplier.
--
-- Adding the LENDER subledger type and LOAN_PAYABLE posting role lets the
-- default chart seed a Loan Payable control with its own party book. The
-- existing manual journal screen can then post:
--   Dr Cash/Bank      Cr Loan Payable — Unsecured (LENDER, lender name)
-- without touching AP or the supplier master. A dedicated lender/loan register
-- is the next slice; this migration only makes the accounts representable.

ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_subledger_type_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_subledger_type_check CHECK (subledger_type IN (
    'NONE', 'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'LENDER', 'INVENTORY', 'FIXED_ASSET', 'BANK', 'CASH', 'TAX', 'INTER_BRANCH'
));

ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_posting_role_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_posting_role_check CHECK (posting_role IN (
    'AR_CONTROL', 'AP_CONTROL', 'CASH', 'BANK', 'INVENTORY', 'SALES', 'COGS',
    'TAX_OUTPUT', 'TAX_INPUT', 'RETAINED_EARNINGS', 'SALARY_PAYABLE', 'INTER_BRANCH_CLEARING',
    'STOCK_EXPENSE', 'CPE_ASSET', 'DUE_FROM_HO', 'DUE_TO_HO',
    'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'DEPRECIATION_EXPENSE',
    'GAIN_ON_DISPOSAL', 'LOSS_ON_DISPOSAL',
    'SALARY_EXPENSE', 'TDS_PAYABLE', 'SSF_PAYABLE', 'EMPLOYEE_ADVANCE', 'EMPLOYEE_LOAN',
    'LOAN_PAYABLE', 'PAYMENT_FEE_EXPENSE'
));

ALTER TABLE gl_subledgers DROP CONSTRAINT IF EXISTS gl_subledgers_subledger_type_check;
ALTER TABLE gl_subledgers ADD CONSTRAINT gl_subledgers_subledger_type_check CHECK (subledger_type IN (
    'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'LENDER', 'INVENTORY', 'FIXED_ASSET', 'BANK', 'CASH', 'TAX', 'INTER_BRANCH'
));

ALTER TABLE gl_subledger_entries DROP CONSTRAINT IF EXISTS gl_subledger_entries_subledger_type_check;
ALTER TABLE gl_subledger_entries ADD CONSTRAINT gl_subledger_entries_subledger_type_check CHECK (subledger_type IN (
    'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'LENDER', 'INVENTORY', 'FIXED_ASSET', 'BANK', 'CASH', 'TAX', 'INTER_BRANCH'
));