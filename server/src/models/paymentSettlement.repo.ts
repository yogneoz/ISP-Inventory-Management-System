/**
 * ACC-3 wallet settlement and provider reconciliation SQL.
 *
 * Receipts live in `customer_payments` at gross; settlements are allocation
 * rows in `payment_settlements`. The wallet ledger is the source of truth for
 * the clearing balance, while `bank_statement_lines` keeps the provider's
 * imported statement and links a net deposit to the settlement it paid.
 */
export const WALLET_ACCOUNTS_SQL = `SELECT a.id AS "accountId",
  a.code,
  a.name,
  a.provider_code AS "providerCode",
  a.settlement_account_id AS "settlementAccountId",
  a.branch_id AS "branchId",
  b.code AS "branchCode",
  a.is_active AS "isActive"
FROM gl_accounts a
LEFT JOIN branches b ON b.id = a.branch_id
WHERE a.account_kind = 'WALLET'
ORDER BY a.provider_code ASC, a.code ASC`;

export const WALLET_ACCOUNT_BY_ID_SQL = `SELECT a.id AS "accountId",
  a.code,
  a.name,
  a.normal_balance AS "accountNormalBalance",
  a.provider_code AS "providerCode",
  a.settlement_account_id AS "settlementAccountId",
  a.branch_id AS "branchId",
  b.code AS "branchCode",
  a.is_active AS "isActive"
FROM gl_accounts a
LEFT JOIN branches b ON b.id = a.branch_id
WHERE a.id = $1 AND a.account_kind = 'WALLET'`;

export const WALLET_PAYMENT_FOR_SETTLEMENT_SQL = `SELECT cp.id,
  cp.payment_number AS "paymentNumber",
  cp.customer_id AS "customerId",
  cp.customer_name AS "customerName",
  cp.branch_id AS "branchId",
  cp.invoice_id AS "invoiceId",
  cp.payment_date_ad::text AS "paymentDateAD",
  cp.amount::numeric AS amount,
  cp.gross_amount::numeric AS "grossAmount",
  cp.fee_amount::numeric AS "feeAmount",
  cp.net_amount::numeric AS "netAmount",
  cp.payment_method AS "paymentMethod",
  cp.provider_code AS "providerCode",
  cp.provider_transaction_id AS "providerTransactionId",
  cp.settlement_account_id AS "settlementAccountId",
  cp.status
FROM customer_payments cp
WHERE cp.id = $1
FOR UPDATE OF cp`;

export const WALLET_PAYMENT_SETTLED_SQL = `SELECT COALESCE(SUM(gross_amount), 0)::numeric AS "settledGross"
FROM payment_settlements
WHERE customer_payment_id = $1 AND status = 'POSTED'`;

export const PAYMENT_SETTLEMENT_INSERT_SQL = `INSERT INTO payment_settlements (
  id, settlement_number, customer_payment_id, wallet_account_id, bank_account_id,
  settlement_date_ad, settlement_date_bs, gross_amount, fee_amount, net_amount,
  provider_reference, journal_id, status, created_by
) VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8::numeric, $9::numeric, $10::numeric,
  $11, $12, $13, $14)
RETURNING id`;

export const PAYMENT_SETTLEMENT_BY_ID_SQL = `SELECT ps.id,
  ps.settlement_number AS "settlementNumber",
  ps.customer_payment_id AS "customerPaymentId",
  cp.payment_number AS "paymentNumber",
  cp.customer_name AS "customerName",
  cp.provider_code AS "providerCode",
  cp.provider_transaction_id AS "providerTransactionId",
  ps.wallet_account_id AS "walletAccountId",
  wa.code AS "walletAccountCode",
  ps.bank_account_id AS "bankAccountId",
  ba.code AS "bankAccountCode",
  ps.settlement_date_ad::text AS "settlementDateAD",
  ps.gross_amount::numeric AS "grossAmount",
  ps.fee_amount::numeric AS "feeAmount",
  ps.net_amount::numeric AS "netAmount",
  ps.provider_reference AS "providerReference",
  ps.journal_id AS "journalId",
  ps.status,
  ps.created_by AS "createdBy",
  ps.created_at::text AS "createdAt"
FROM payment_settlements ps
JOIN customer_payments cp ON cp.id = ps.customer_payment_id
JOIN gl_accounts wa ON wa.id = ps.wallet_account_id
JOIN gl_accounts ba ON ba.id = ps.bank_account_id
WHERE ps.id = $1`;

export const WALLET_LEDGER_OPENING_SQL = `SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS opening
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
WHERE l.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad < $2::date`;

export const WALLET_LEDGER_MOVEMENT_SQL = `SELECT COALESCE(SUM(l.debit), 0)::numeric AS receipts,
  COALESCE(SUM(l.credit), 0)::numeric AS payments,
  COALESCE(SUM(l.debit - l.credit), 0)::numeric AS movement,
  COUNT(*)::int AS "lineCount"
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
WHERE l.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad >= $2::date
  AND j.journal_date_ad <= $3::date`;

/** Gross receipts in the period, independent of settlement timing. */
export const WALLET_RECEIPTS_SQL = `SELECT COALESCE(SUM(COALESCE(gross_amount, amount)), 0)::numeric AS "grossReceipts",
  COUNT(*)::int AS "receiptCount"
FROM customer_payments
WHERE settlement_account_id = $1
  AND status = 'POSTED'
  AND payment_date_ad >= $2::date
  AND payment_date_ad <= $3::date`;

/** Settled gross and fees in the period. */
export const WALLET_SETTLEMENTS_SQL = `SELECT COALESCE(SUM(gross_amount), 0)::numeric AS "settledGross",
  COALESCE(SUM(fee_amount), 0)::numeric AS fees,
  COALESCE(SUM(net_amount), 0)::numeric AS net,
  COUNT(*)::int AS "settlementCount"
FROM payment_settlements
WHERE wallet_account_id = $1
  AND status = 'POSTED'
  AND settlement_date_ad >= $2::date
  AND settlement_date_ad <= $3::date`;

/**
 * Outstanding gross through the period end: receipts still POSTED minus every
 * settlement already posted against them. A refunded or charged-back receipt
 * leaves this population, exactly as its clearing credit leaves the ledger.
 */
export const WALLET_OUTSTANDING_SQL = `SELECT COALESCE(SUM(COALESCE(cp.gross_amount, cp.amount) - COALESCE(s.settled, 0)), 0)::numeric AS "unsettledGross"
FROM customer_payments cp
LEFT JOIN (
  SELECT customer_payment_id, SUM(gross_amount) AS settled
  FROM payment_settlements
  WHERE status = 'POSTED'
  GROUP BY customer_payment_id
) s ON s.customer_payment_id = cp.id
WHERE cp.settlement_account_id = $1
  AND cp.status = 'POSTED'
  AND cp.payment_date_ad <= $2::date
  AND COALESCE(cp.gross_amount, cp.amount) > COALESCE(s.settled, 0)`;

export const WALLET_PENDING_RECEIPTS_SQL = `SELECT cp.id,
  cp.payment_number AS "paymentNumber",
  cp.customer_name AS "customerName",
  cp.payment_date_ad::text AS "paymentDateAD",
  cp.provider_code AS "providerCode",
  cp.provider_transaction_id AS "providerTransactionId",
  cp.gross_amount::numeric AS "grossAmount",
  cp.fee_amount::numeric AS "feeAmount",
  cp.net_amount::numeric AS "netAmount",
  COALESCE(s.settled, 0)::numeric AS "settledGross",
  (COALESCE(cp.gross_amount, cp.amount) - COALESCE(s.settled, 0))::numeric AS "outstandingGross"
FROM customer_payments cp
LEFT JOIN (
  SELECT customer_payment_id, SUM(gross_amount) AS settled
  FROM payment_settlements
  WHERE status = 'POSTED'
  GROUP BY customer_payment_id
) s ON s.customer_payment_id = cp.id
WHERE cp.settlement_account_id = $1
  AND cp.status = 'POSTED'
  AND COALESCE(cp.gross_amount, cp.amount) > COALESCE(s.settled, 0)
ORDER BY cp.payment_date_ad ASC, cp.id ASC
LIMIT 500`;

export const WALLET_SETTLEMENT_ROWS_SQL = `SELECT ps.id,
  ps.settlement_number AS "settlementNumber",
  ps.customer_payment_id AS "customerPaymentId",
  cp.payment_number AS "paymentNumber",
  cp.customer_name AS "customerName",
  ps.bank_account_id AS "bankAccountId",
  ba.code AS "bankAccountCode",
  ps.settlement_date_ad::text AS "settlementDateAD",
  ps.gross_amount::numeric AS "grossAmount",
  ps.fee_amount::numeric AS "feeAmount",
  ps.net_amount::numeric AS "netAmount",
  ps.provider_reference AS "providerReference",
  ps.journal_id AS "journalId",
  ps.status
FROM payment_settlements ps
JOIN customer_payments cp ON cp.id = ps.customer_payment_id
JOIN gl_accounts ba ON ba.id = ps.bank_account_id
WHERE ps.wallet_account_id = $1
  AND ps.settlement_date_ad >= $2::date
  AND ps.settlement_date_ad <= $3::date
ORDER BY ps.settlement_date_ad ASC, ps.created_at ASC, ps.id ASC`;

export const PROVIDER_STATEMENT_LINES_SQL = `SELECT s.id,
  s.statement_date::text AS "statementDate",
  s.statement_date_bs AS "statementDateBS",
  s.description,
  s.reference,
  s.amount::numeric AS amount,
  s.import_batch_id AS "importBatchId",
  s.import_source AS "importSource",
  s.matched_settlement_id AS "matchedSettlementId",
  s.matched_at::text AS "matchedAt",
  s.matched_by AS "matchedBy",
  ps.settlement_number AS "matchedSettlementNumber",
  ps.net_amount::numeric AS "matchedSettlementNet"
FROM bank_statement_lines s
LEFT JOIN payment_settlements ps ON ps.id = s.matched_settlement_id
WHERE s.bank_account_id = $1
  AND s.statement_date >= $2::date
  AND s.statement_date <= $3::date
ORDER BY s.statement_date ASC, s.created_at ASC, s.id ASC
LIMIT 1000`;

/** Candidate settlements for a provider statement line (net and reference). */
export const PROVIDER_SETTLEMENT_CANDIDATES_SQL = `SELECT ps.id,
  ps.net_amount::numeric AS "netAmount",
  ps.provider_reference AS "providerReference",
  cp.payment_number AS "paymentNumber",
  cp.provider_transaction_id AS "providerTransactionId"
FROM payment_settlements ps
JOIN customer_payments cp ON cp.id = ps.customer_payment_id
WHERE ps.wallet_account_id = $1
  AND ps.status = 'POSTED'
  AND NOT EXISTS (
    SELECT 1 FROM bank_statement_lines s WHERE s.matched_settlement_id = ps.id
  )
  AND ps.settlement_date_ad >= $2::date
  AND ps.settlement_date_ad <= $3::date
ORDER BY ps.settlement_date_ad ASC, ps.id ASC`;

export const PROVIDER_STATEMENT_LINE_FOR_UPDATE_SQL = `SELECT id,
  bank_account_id AS "walletAccountId",
  statement_date::text AS "statementDate",
  amount::numeric AS amount,
  reference,
  matched_settlement_id AS "matchedSettlementId"
FROM bank_statement_lines
WHERE id = $1
FOR UPDATE`;

export const PROVIDER_SETTLEMENT_FOR_MATCH_SQL = `SELECT id,
  wallet_account_id AS "walletAccountId",
  net_amount::numeric AS "netAmount",
  status
FROM payment_settlements
WHERE id = $1
FOR UPDATE`;

export const PROVIDER_STATEMENT_CONFLICT_SQL = `SELECT id
FROM bank_statement_lines
WHERE matched_settlement_id = $1 AND id <> $2
LIMIT 1`;

export const PROVIDER_STATEMENT_MATCH_SQL = `UPDATE bank_statement_lines SET
  matched_settlement_id = $2,
  matched_at = CURRENT_TIMESTAMP,
  matched_by = $3
WHERE id = $1

RETURNING id`;
