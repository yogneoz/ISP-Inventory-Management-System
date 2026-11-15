/**
 * Lender and loan SQL.
 *
 * A lender's financial position is not stored here: it is the posted
 * `gl_subledger_entries` rows attributed to the lender under the LOAN_PAYABLE
 * control account. This repository owns the identity, agreement and statement
 * reads; posting remains in the accounting service.
 */

export const LENDER_COLUMNS = `l.id,
  l.code,
  l.name,
  l.lender_type AS "lenderType",
  l.pan_number AS "panNumber",
  l.registration_number AS "registrationNumber",
  l.phone,
  l.address,
  l.notes,
  l.default_cash_account_id AS "defaultCashAccountId",
  l.default_interest_account_id AS "defaultInterestAccountId",
  l.default_tds_account_id AS "defaultTdsAccountId",
  l.default_loan_account_id AS "defaultLoanAccountId",
  l.is_active AS active,
  l.created_at AS "createdAt",
  l.updated_at AS "updatedAt"`;

export const LENDER_LIST_SQL = `SELECT ${LENDER_COLUMNS},
  book.id AS "bookId",
  book.code AS "bookCode",
  (SELECT COUNT(*)::int FROM loans ln
    WHERE ln.lender_id = l.id AND ($2::varchar IS NULL OR ln.branch_id = $2)) AS "loanCount",
  (SELECT COALESCE(SUM(ln.principal), 0)::numeric
     FROM loans ln
    WHERE ln.lender_id = l.id AND ln.status = 'OPEN'
      AND ($2::varchar IS NULL OR ln.branch_id = $2)) AS "openPrincipal",
  (SELECT COALESCE(SUM(se.credit - se.debit), 0)::numeric
     FROM gl_subledger_entries se
     JOIN gl_journals j ON j.id = se.journal_id AND j.status = 'POSTED'
     JOIN gl_accounts a ON a.id = se.account_id AND a.posting_role = 'LOAN_PAYABLE'
    WHERE se.party_id = l.id
      AND ($2::varchar IS NULL OR se.branch_id = $2)) AS "bookBalance"
FROM lenders l
LEFT JOIN gl_subledgers book
  ON book.party_id = l.id AND book.subledger_type = 'LENDER'
WHERE ($1::varchar IS NULL OR l.code ILIKE $1 OR l.name ILIKE $1)
ORDER BY l.code ASC`;

export const LENDER_BY_ID_SQL = `SELECT ${LENDER_COLUMNS},
  book.id AS "bookId",
  book.code AS "bookCode",
  (SELECT COUNT(*)::int FROM loans ln
    WHERE ln.lender_id = l.id AND ($2::varchar IS NULL OR ln.branch_id = $2)) AS "loanCount",
  (SELECT COALESCE(SUM(ln.principal), 0)::numeric
     FROM loans ln
    WHERE ln.lender_id = l.id AND ln.status = 'OPEN'
      AND ($2::varchar IS NULL OR ln.branch_id = $2)) AS "openPrincipal",
  (SELECT COALESCE(SUM(se.credit - se.debit), 0)::numeric
     FROM gl_subledger_entries se
     JOIN gl_journals j ON j.id = se.journal_id AND j.status = 'POSTED'
     JOIN gl_accounts a ON a.id = se.account_id AND a.posting_role = 'LOAN_PAYABLE'
    WHERE se.party_id = l.id
      AND ($2::varchar IS NULL OR se.branch_id = $2)) AS "bookBalance"
FROM lenders l
LEFT JOIN gl_subledgers book
  ON book.party_id = l.id AND book.subledger_type = 'LENDER'
WHERE l.id = $1`;

export const LENDER_BY_CODE_SQL = `SELECT id, code, name FROM lenders WHERE code = $1`;

export const LENDER_INSERT_SQL = `INSERT INTO lenders (
  id, code, name, lender_type, pan_number, registration_number, phone, address, notes,
  default_cash_account_id, default_interest_account_id, default_tds_account_id,
  default_loan_account_id, is_active
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
RETURNING id`;

export const LENDER_UPDATE_SQL = `UPDATE lenders SET
  name = $2,
  lender_type = $3,
  pan_number = $4,
  registration_number = $5,
  phone = $6,
  address = $7,
  notes = $8,
  default_cash_account_id = $9,
  default_interest_account_id = $10,
  default_tds_account_id = $11,
  default_loan_account_id = $12,
  is_active = $13,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const LENDER_DELETE_SQL = `DELETE FROM lenders WHERE id = $1 RETURNING id`;

/** The active Loan Payable control account, if the chart has one. */
export const LOAN_PAYABLE_ACCOUNT_SQL = `SELECT id, code, name, subledger_type AS "subledgerType"
FROM gl_accounts
WHERE posting_role = 'LOAN_PAYABLE' AND is_active = TRUE
ORDER BY code ASC
LIMIT 1`;

export const LOAN_PAYABLE_ACCOUNT_BY_ID_SQL = `SELECT id, code, name, subledger_type AS "subledgerType"
FROM gl_accounts
WHERE id = $1 AND posting_role = 'LOAN_PAYABLE' AND is_control = TRUE AND is_active = TRUE`;

/** Stable lender-interest defaults seeded by migration 0025. */
export const LENDER_INTEREST_ACCOUNT_SQL = `SELECT id, code, name
FROM gl_accounts
WHERE code = '6700' AND is_active = TRUE
LIMIT 1`;

export const LENDER_TDS_ACCOUNT_SQL = `SELECT id, code, name
FROM gl_accounts
WHERE code = '2360' AND is_active = TRUE
LIMIT 1`;

export const LENDER_INTEREST_PAYABLE_ACCOUNT_SQL = `SELECT id, code, name
FROM gl_accounts
WHERE code = '2370' AND is_active = TRUE
LIMIT 1`;

export const LENDER_BOOK_BY_PARTY_SQL = `SELECT id, code, name, main_account_id AS "mainAccountId", is_active AS active
FROM gl_subledgers
WHERE subledger_type = 'LENDER' AND party_id = $1
ORDER BY created_at ASC
LIMIT 1`;

export const LENDER_BOOK_BY_CODE_SQL = `SELECT id FROM gl_subledgers WHERE code = $1`;

export const LENDER_BOOK_INSERT_SQL = `INSERT INTO gl_subledgers (
  id, code, name, subledger_type, main_account_id, party_id, description, is_active, is_demo
) VALUES ($1, $2, $3, 'LENDER', $4, $5, $6, $7, FALSE)
RETURNING id`;

export const LENDER_BOOK_UPDATE_SQL = `UPDATE gl_subledgers SET
  name = $2,
  is_active = $3,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const LENDER_BOOK_ACCOUNT_UPDATE_SQL = `UPDATE gl_subledgers SET
  main_account_id = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const LENDER_BOOK_DELETE_SQL = `DELETE FROM gl_subledgers WHERE id = $1 RETURNING id`;

export const LENDER_LOAN_COUNT_SQL = `SELECT COUNT(*)::int AS count FROM loans WHERE lender_id = $1`;

export const LENDER_OPEN_LOAN_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM loans WHERE lender_id = $1 AND status = 'OPEN'`;

/** Posted rows that still reference this lender through its book or party id. */
export const LENDER_LEDGER_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_subledger_entries
WHERE party_id = $1
   OR subledger_id IN (SELECT id FROM gl_subledgers WHERE party_id = $1)`;

export const LENDER_LEDGER_COUNT_IN_ACCOUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_subledger_entries
WHERE account_id = $2
  AND (party_id = $1
       OR subledger_id IN (SELECT id FROM gl_subledgers WHERE party_id = $1))`;

export const LOAN_COLUMNS = `ln.id,
  ln.loan_number AS "loanNumber",
  ln.lender_id AS "lenderId",
  l.code AS "lenderCode",
  l.name AS "lenderName",
  ln.branch_id AS "branchId",
  b.code AS "branchCode",
  b.name AS "branchName",
  ln.principal::numeric AS principal,
  ln.interest_rate::numeric AS "interestRate",
  ln.start_date_ad::text AS "startDateAD",
  ln.start_date_bs AS "startDateBS",
  ln.maturity_date_ad::text AS "maturityDateAD",
  ln.maturity_date_bs AS "maturityDateBS",
  ln.repayment_frequency AS "repaymentFrequency",
  ln.installment_amount::numeric AS "installmentAmount",
  ln.security_type AS "securityType",
  ln.status,
  ln.agreement_reference AS "agreementReference",
  ln.notes,
  ln.created_by AS "createdBy",
  ln.created_at AS "createdAt",
  ln.updated_at AS "updatedAt",
  COALESCE((SELECT SUM(t.principal_amount)
    FROM loan_transactions t
    JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
   WHERE t.loan_id = ln.id AND t.txn_type = 'RECEIPT'), 0)::numeric AS "fundedPrincipal",
  COALESCE((SELECT SUM(t.principal_amount)
    FROM loan_transactions t
    JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
   WHERE t.loan_id = ln.id AND t.txn_type = 'REPAYMENT'), 0)::numeric AS "repaidPrincipal",
  COALESCE((SELECT SUM(t.interest_amount)
    FROM loan_transactions t
    JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
   WHERE t.loan_id = ln.id AND t.txn_type = 'REPAYMENT'), 0)::numeric AS "interestPaid",
  COALESCE((SELECT SUM(t.tds_amount)
    FROM loan_transactions t
    JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
   WHERE t.loan_id = ln.id AND t.txn_type = 'REPAYMENT'), 0)::numeric AS "tdsWithheld",
  (SELECT MAX(t.txn_date_ad)::text
    FROM loan_transactions t
    JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
   WHERE t.loan_id = ln.id) AS "lastTransactionDateAD",
  COALESCE((SELECT SUM(a.interest_amount)
    FROM loan_interest_accruals a
   WHERE a.loan_id = ln.id), 0)::numeric AS "interestAccrued",
  (SELECT MAX(a.to_date_ad)::text
    FROM loan_interest_accruals a
   WHERE a.loan_id = ln.id) AS "lastAccrualDateAD",
  (SELECT COUNT(*)::int FROM loan_installments li WHERE li.loan_id = ln.id) AS "installmentCount",
  (SELECT MIN(li.due_date_ad)::text
    FROM loan_installments li
   WHERE li.loan_id = ln.id
     AND ((li.principal_due - li.principal_paid) + (li.interest_due - li.interest_paid)) > 0.004) AS "nextDueDateAD",
  (SELECT ((li.principal_due - li.principal_paid) + (li.interest_due - li.interest_paid))::numeric
    FROM loan_installments li
   WHERE li.loan_id = ln.id
     AND ((li.principal_due - li.principal_paid) + (li.interest_due - li.interest_paid)) > 0.004
   ORDER BY li.due_date_ad ASC, li.sequence_number ASC
   LIMIT 1) AS "nextDueAmount",
  (SELECT COUNT(*)::int
    FROM loan_installments li
   WHERE li.loan_id = ln.id
     AND li.due_date_ad < CURRENT_DATE
     AND ((li.principal_due - li.principal_paid) + (li.interest_due - li.interest_paid)) > 0.004) AS "overdueInstallments",
  (SELECT COALESCE(SUM(li.principal_due), 0)::numeric
    FROM loan_installments li WHERE li.loan_id = ln.id) AS "scheduledPrincipal",
  (SELECT COALESCE(SUM(li.principal_paid), 0)::numeric
    FROM loan_installments li WHERE li.loan_id = ln.id) AS "scheduledPrincipalPaid",
  (SELECT COALESCE(SUM(li.interest_due), 0)::numeric
    FROM loan_installments li WHERE li.loan_id = ln.id) AS "scheduledInterest",
  (SELECT COALESCE(SUM(li.interest_paid), 0)::numeric
    FROM loan_installments li WHERE li.loan_id = ln.id) AS "scheduledInterestPaid"`;

export const LOAN_LIST_SQL = `SELECT ${LOAN_COLUMNS}
FROM loans ln
JOIN lenders l ON l.id = ln.lender_id
JOIN branches b ON b.id = ln.branch_id
WHERE ($1::varchar IS NULL OR ln.lender_id = $1)
  AND ($2::varchar IS NULL OR ln.status = $2)
  AND ($3::varchar IS NULL OR ln.branch_id = $3)
ORDER BY ln.start_date_ad DESC, ln.loan_number DESC`;

export const LOAN_BY_ID_SQL = `SELECT ${LOAN_COLUMNS}
FROM loans ln
JOIN lenders l ON l.id = ln.lender_id
JOIN branches b ON b.id = ln.branch_id
WHERE ln.id = $1`;

/** Serialise receipts/repayments against the same loan balance. */
export const LOAN_LOCK_SQL = `SELECT id FROM loans WHERE id = $1 FOR UPDATE`;

export const LOAN_INSERT_SQL = `INSERT INTO loans (
  id, loan_number, lender_id, branch_id, principal, interest_rate,
  start_date_ad, start_date_bs, maturity_date_ad, maturity_date_bs,
  repayment_frequency, installment_amount, security_type, status,
  agreement_reference, notes, created_by
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7::date, $8, $9::date, $10,
  $11, $12, $13, $14, $15, $16, $17
)
RETURNING id`;

export const LOAN_UPDATE_SQL = `UPDATE loans SET
  principal = $2,
  interest_rate = $3,
  start_date_ad = $4::date,
  start_date_bs = $5,
  maturity_date_ad = $6::date,
  maturity_date_bs = $7,
  repayment_frequency = $8,
  installment_amount = $9,
  security_type = $10,
  status = $11,
  agreement_reference = $12,
  notes = $13,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const LOAN_TRANSACTION_COLUMNS = `t.id,
  t.txn_number AS "txnNumber",
  t.loan_id AS "loanId",
  t.lender_id AS "lenderId",
  t.branch_id AS "branchId",
  t.txn_type AS "txnType",
  t.txn_date_ad::text AS "txnDateAD",
  t.txn_date_bs AS "txnDateBS",
  t.principal_amount::numeric AS "principalAmount",
  t.interest_amount::numeric AS "interestAmount",
  t.tds_amount::numeric AS "tdsAmount",
  t.interest_payable_applied::numeric AS "interestPayableApplied",
  t.cash_amount::numeric AS "cashAmount",
  t.cash_account_id AS "cashAccountId",
  t.interest_account_id AS "interestAccountId",
  t.tds_account_id AS "tdsAccountId",
  t.cheque_no AS "chequeNo",
  t.reference_no AS "referenceNo",
  t.notes,
  t.journal_id AS "journalId",
  j.journal_no AS "journalNo",
  j.status AS "journalStatus",
  t.created_by AS "createdBy",
  t.created_at AS "createdAt"`;

export const LOAN_TRANSACTION_LIST_SQL = `SELECT ${LOAN_TRANSACTION_COLUMNS}
FROM loan_transactions t
JOIN gl_journals j ON j.id = t.journal_id
WHERE t.loan_id = $1
ORDER BY t.txn_date_ad ASC, t.created_at ASC, t.id ASC`;

export const LOAN_TRANSACTION_BY_ID_SQL = `SELECT ${LOAN_TRANSACTION_COLUMNS}
FROM loan_transactions t
JOIN gl_journals j ON j.id = t.journal_id
WHERE t.id = $1`;

export const LOAN_TRANSACTION_INSERT_SQL = `INSERT INTO loan_transactions (
  id, txn_number, loan_id, lender_id, branch_id, txn_type, txn_date_ad,
  txn_date_bs, principal_amount, interest_amount, tds_amount, cash_amount,
  cash_account_id, interest_account_id, tds_account_id, cheque_no,
  reference_no, notes, journal_id, created_by, interest_payable_applied
) VALUES (
  $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12,
  $13, $14, $15, $16, $17, $18, $19, $20, $21
)
RETURNING id`;

export const LOAN_TRANSACTION_SUM_SQL = `SELECT
  COALESCE(SUM(t.principal_amount) FILTER (WHERE t.txn_type = 'RECEIPT'), 0)::numeric AS funded,
  COALESCE(SUM(t.principal_amount) FILTER (WHERE t.txn_type = 'REPAYMENT'), 0)::numeric AS repaid,
  COALESCE(SUM(t.interest_amount) FILTER (WHERE t.txn_type = 'REPAYMENT'), 0)::numeric AS interest,
  COALESCE(SUM(t.tds_amount) FILTER (WHERE t.txn_type = 'REPAYMENT'), 0)::numeric AS tds
FROM loan_transactions t
JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
WHERE t.loan_id = $1`;

export const LOAN_STATUS_UPDATE_SQL = `UPDATE loans
SET status = $2, updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const LOAN_REPAYMENT_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM loan_transactions t
JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
WHERE t.loan_id = $1 AND t.txn_type = 'REPAYMENT'`;

export const LOAN_ACCRUAL_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM loan_interest_accruals WHERE loan_id = $1`;

export const LOAN_INTEREST_PAYABLE_APPLIED_SQL = `SELECT
  COALESCE(SUM(t.interest_payable_applied), 0)::numeric AS applied
FROM loan_transactions t
JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
WHERE t.loan_id = $1 AND t.txn_type = 'REPAYMENT'`;

export const LOAN_INSTALLMENT_COLUMNS = `li.id,
  li.loan_id AS "loanId",
  li.sequence_number AS "sequenceNumber",
  li.due_date_ad::text AS "dueDateAD",
  li.due_date_bs AS "dueDateBS",
  li.principal_due::numeric AS "principalDue",
  li.interest_due::numeric AS "interestDue",
  li.principal_paid::numeric AS "principalPaid",
  li.interest_paid::numeric AS "interestPaid",
  li.tds_paid::numeric AS "tdsPaid"`;

export const LOAN_INSTALLMENT_LIST_SQL = `SELECT ${LOAN_INSTALLMENT_COLUMNS}
FROM loan_installments li
WHERE li.loan_id = $1
ORDER BY li.sequence_number ASC`;

export const LOAN_INSTALLMENT_LOCK_SQL = `SELECT ${LOAN_INSTALLMENT_COLUMNS}
FROM loan_installments li
WHERE li.loan_id = $1
ORDER BY li.sequence_number ASC
FOR UPDATE`;

export const LOAN_INSTALLMENT_DELETE_SQL = `DELETE FROM loan_installments WHERE loan_id = $1`;

export const LOAN_INSTALLMENT_INSERT_SQL = `INSERT INTO loan_installments (
  id, loan_id, sequence_number, due_date_ad, due_date_bs,
  principal_due, interest_due
) VALUES ($1, $2, $3, $4::date, $5, $6, $7)
RETURNING id`;

export const LOAN_INSTALLMENT_UPDATE_SQL = `UPDATE loan_installments SET
  principal_paid = $2,
  interest_paid = $3,
  tds_paid = $4
WHERE id = $1
RETURNING id`;

export const LOAN_ACCRUAL_COLUMNS = `a.id,
  a.accrual_number AS "accrualNumber",
  a.loan_id AS "loanId",
  a.lender_id AS "lenderId",
  a.branch_id AS "branchId",
  a.from_date_ad::text AS "fromDateAD",
  a.from_date_bs AS "fromDateBS",
  a.to_date_ad::text AS "toDateAD",
  a.to_date_bs AS "toDateBS",
  a.principal_base::numeric AS "principalBase",
  a.annual_rate::numeric AS "annualRate",
  a.days,
  a.interest_amount::numeric AS "interestAmount",
  a.journal_id AS "journalId",
  j.journal_no AS "journalNo",
  j.status AS "journalStatus",
  a.created_by AS "createdBy",
  a.created_at AS "createdAt"`;

export const LOAN_ACCRUAL_LIST_SQL = `SELECT ${LOAN_ACCRUAL_COLUMNS}
FROM loan_interest_accruals a
JOIN gl_journals j ON j.id = a.journal_id
WHERE a.loan_id = $1
ORDER BY a.to_date_ad ASC, a.created_at ASC, a.id ASC`;

export const LOAN_ACCRUAL_BY_ID_SQL = `SELECT ${LOAN_ACCRUAL_COLUMNS}
FROM loan_interest_accruals a
JOIN gl_journals j ON j.id = a.journal_id
WHERE a.id = $1`;

export const LOAN_ACCRUAL_SUM_SQL = `SELECT COALESCE(SUM(a.interest_amount), 0)::numeric AS accrued
FROM loan_interest_accruals a
WHERE a.loan_id = $1`;

export const LOAN_ACCRUAL_LAST_SQL = `SELECT MAX(to_date_ad)::text AS last
FROM loan_interest_accruals
WHERE loan_id = $1`;

export const LOAN_ACCRUAL_OVERLAP_SQL = `SELECT id, accrual_number
FROM loan_interest_accruals
WHERE loan_id = $1
  AND from_date_ad <= $3::date
  AND to_date_ad >= $2::date
LIMIT 1`;

export const LOAN_ACCRUAL_INSERT_SQL = `INSERT INTO loan_interest_accruals (
  id, accrual_number, loan_id, lender_id, branch_id,
  from_date_ad, from_date_bs, to_date_ad, to_date_bs,
  principal_base, annual_rate, days, interest_amount, journal_id, created_by
) VALUES (
  $1, $2, $3, $4, $5, $6::date, $7, $8::date, $9,
  $10, $11, $12, $13, $14, $15
)
RETURNING id`;

/** Actual TDS withheld on loan-interest repayments in one lender/date window. */
export const LENDER_TDS_REPORT_SQL = `SELECT
  t.id,
  t.txn_number AS "txnNumber",
  t.txn_date_ad::text AS "dateAD",
  t.txn_date_bs AS "dateBS",
  t.interest_amount::numeric AS "interestAmount",
  t.tds_amount::numeric AS "tdsAmount",
  t.cash_amount::numeric AS "cashAmount",
  ln.loan_number AS "loanNumber",
  j.journal_no AS "journalNo"
FROM loan_transactions t
JOIN gl_journals j ON j.id = t.journal_id AND j.status = 'POSTED'
JOIN loans ln ON ln.id = t.loan_id
WHERE t.lender_id = $1
  AND t.txn_type = 'REPAYMENT'
  AND t.tds_amount > 0
  AND ($2::date IS NULL OR t.txn_date_ad >= $2::date)
  AND ($3::date IS NULL OR t.txn_date_ad <= $3::date)
  AND ($4::varchar IS NULL OR t.branch_id = $4)
ORDER BY t.txn_date_ad ASC, t.txn_number ASC`;

export const LENDER_STATEMENT_OPENING_SQL = `SELECT
  COALESCE(SUM(se.credit - se.debit), 0)::numeric AS opening
FROM gl_subledger_entries se
JOIN gl_journals j ON j.id = se.journal_id AND j.status = 'POSTED'
WHERE se.account_id = $1
  AND (se.party_id = $2 OR ($3::varchar IS NOT NULL AND se.subledger_id = $3))
  AND ($4::varchar IS NULL OR se.branch_id = $4)
  AND ($5::date IS NOT NULL AND se.entry_date_ad < $5::date)`;

export const LENDER_STATEMENT_ENTRIES_SQL = `SELECT
  se.id,
  se.journal_id AS "journalId",
  j.journal_no AS "journalNo",
  se.entry_date_ad::text AS "dateAD",
  se.entry_date_bs AS "dateBS",
  COALESCE(line.memo, j.memo, '') AS memo,
  se.debit::numeric AS debit,
  se.credit::numeric AS credit,
  se.branch_id AS "branchId",
  se.party_id AS "partyId",
  se.party_name AS "partyName"
FROM gl_subledger_entries se
JOIN gl_journals j ON j.id = se.journal_id AND j.status = 'POSTED'
LEFT JOIN gl_journal_lines line ON line.id = se.journal_line_id
WHERE se.account_id = $1
  AND (se.party_id = $2 OR ($3::varchar IS NOT NULL AND se.subledger_id = $3))
  AND ($4::varchar IS NULL OR se.branch_id = $4)
  AND ($5::date IS NULL OR se.entry_date_ad >= $5::date)
  AND ($6::date IS NULL OR se.entry_date_ad <= $6::date)
ORDER BY se.entry_date_ad ASC, se.id ASC`;

export const LENDER_CONTROL_GL_BALANCE_SQL = `SELECT
  COALESCE(SUM(line.credit - line.debit), 0)::numeric AS balance
FROM gl_journal_lines line
JOIN gl_journals j
  ON j.id = line.journal_id AND j.journal_date_ad = line.journal_date_ad
WHERE line.account_id = $1
  AND j.status = 'POSTED'
  AND ($2::varchar IS NULL OR line.branch_id = $2)
  AND ($3::date IS NULL OR line.journal_date_ad <= $3::date)`;

export const LENDER_CONTROL_SUBLEDGER_BALANCE_SQL = `SELECT
  COALESCE(SUM(se.credit - se.debit), 0)::numeric AS balance
FROM gl_subledger_entries se
JOIN gl_journals j ON j.id = se.journal_id AND j.status = 'POSTED'
WHERE se.account_id = $1
  AND ($2::varchar IS NULL OR se.branch_id = $2)
  AND ($3::date IS NULL OR se.entry_date_ad <= $3::date)`;

/** Balance of one lender book, or of the party id when the book is missing. */
export const LENDER_PARTY_BALANCE_SQL = `SELECT
  COALESCE(SUM(se.credit - se.debit), 0)::numeric AS balance
FROM gl_subledger_entries se
JOIN gl_journals j ON j.id = se.journal_id AND j.status = 'POSTED'
WHERE se.account_id = $1
  AND (se.party_id = $2 OR ($3::varchar IS NOT NULL AND se.subledger_id = $3))
  AND ($4::varchar IS NULL OR se.branch_id = $4)
  AND ($5::date IS NULL OR se.entry_date_ad <= $5::date)`;

/** Rows on the Loan Payable control that carry no lender party id. */
export const LENDER_UNASSIGNED_BALANCE_SQL = `SELECT
  COALESCE(SUM(se.credit - se.debit), 0)::numeric AS balance
FROM gl_subledger_entries se
JOIN gl_journals j ON j.id = se.journal_id AND j.status = 'POSTED'
WHERE se.account_id = $1
  AND ($2::varchar IS NULL OR se.branch_id = $2)
  AND ($3::date IS NULL OR se.entry_date_ad <= $3::date)
  AND se.party_id IS NULL`;

/** A bound lender option for the journal-entry party picker. */
export const LENDER_PARTY_OPTIONS_SQL = `SELECT id, name, code
FROM lenders
WHERE is_active = TRUE
ORDER BY name ASC`;

export const LENDER_PARTY_BY_ID_SQL = `SELECT id, name FROM lenders WHERE id = $1`;

export const SUBLEDGER_LENDER_CANDIDATES_SQL = `SELECT id,
  name,
  code
FROM lenders
WHERE is_active = TRUE
ORDER BY name ASC`;
