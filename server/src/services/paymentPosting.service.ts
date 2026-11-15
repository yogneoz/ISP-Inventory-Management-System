/**
 * Ledger postings for the two payment documents: customer receipts and vendor
 * payments.
 *
 * They run on the caller's transaction client, exactly like invoice posting, so
 * the payment row, its invoice balance, its subledger settlement, its audit row
 * and its journal commit or roll back together. No journal is written by a
 * second call afterwards, which is why the payment routes are the single place
 * a cash movement enters the ledger.
 *
 * Account choice comes from the chart's posting defaults:
 *   - customer receipt: debit the till/bank and credit AR control (customer
 *     subledger) for the amount received;
 *   - vendor payment:   debit AP control (supplier subledger) and credit the
 *     till/bank.
 *
 * Cash vs bank reuses the document's existing `paymentMethod` convention: CASH
 * is the only method that settles through the till, and every other method
 * (cheque, transfer, card, online) settles through the bank. That is the same
 * split the CR/BR and CP/BP document numbering already uses, so there is no
 * second payment-method map to keep in sync.
 *
 * A missing posting default refuses the payment and names the role; it is never
 * silently skipped. A reversal posts a linked contra journal, leaving the
 * original rows in place for the audit trail.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNT_BY_ID_SQL,
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  WALLET_ACCOUNT_BY_PROVIDER_SQL,
  type PostingRole,
} from '../models/accounting.repo';
import {
  postJournalLegs,
  type AccountingClient,
  type JournalLeg,
} from './accounting.service';
import { reverseSourceJournal } from './invoicePosting.service';

interface PostingAccount {
  id: string;
  code: string;
  name: string;
  isControl: boolean;
  subledgerType: string;
  /** `D` or `C`: the permanent side the leg engine posts against. */
  accountNormalBalance: string;
  accountKind?: string | null;
  isActive?: boolean;
}

type PaymentAccountRole = Extract<
  PostingRole,
  'AR_CONTROL' | 'AP_CONTROL' | 'CASH' | 'BANK' | 'PAYMENT_FEE_EXPENSE'
>;

interface PaymentDocument {
  id: string;
  paymentNumber: string;
  branchId: string;
  paymentDateAD: string;
  amount: number | string;
  paymentMethod?: string | null;
  /** The selected till/bank ledger; NULL keeps the posting default. */
  settlementAccountId?: string | null;
  providerCode?: string | null;
  bankName?: string | null;
  chequeNumber?: string | null;
}

export interface CustomerReceiptDocument extends PaymentDocument {
  customerId?: string | null;
  customerName?: string | null;
}

export interface VendorPaymentDocument extends PaymentDocument {
  supplierId?: string | null;
  supplierName?: string | null;
}

export interface PaymentReversalInput {
  paymentId: string;
  reason: string;
  actor?: string | null;
}

/** CASH is the till; ONLINE is provider clearing; every other method is bank. */
function cashOrBankRole(paymentMethod: string | null | undefined): 'CASH' | 'BANK' {
  return String(paymentMethod || 'CASH').trim().toUpperCase() === 'CASH' ? 'CASH' : 'BANK';
}

function customerSettlementRole(
  paymentMethod: string | null | undefined
): 'CASH' | 'BANK' | 'WALLET' {
  const method = String(paymentMethod || 'CASH').trim().toUpperCase();
  if (method === 'CASH') return 'CASH';
  if (method === 'ONLINE') return 'WALLET';
  return 'BANK';
}

async function loadPaymentDefaults(
  client: AccountingClient,
  roles: readonly PaymentAccountRole[],
  label: string
): Promise<Record<string, PostingAccount>> {
  const rows = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [roles])).rows;
  const byRole: Record<string, PostingAccount> = {};
  for (const row of rows) {
    if (row.postingRole) byRole[row.postingRole] = row;
  }
  const missing = roles.filter((role) => !byRole[role]);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `Accounting is not configured for ${label}: no active account has the ${missing.join(
        ', '
      )} posting default. Set it in Accounting → Posting defaults, then record the payment again.`
    );
  }
  return byRole;
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve the payment's chosen ledger. The method still decides whether the
 * settlement is CASH or BANK; the chosen account only narrows WHICH till or
 * bank account receives/pays the money. An inactive or wrong-kind account is
 * refused rather than silently replaced by the default.
 */
async function loadSettlementAccount(
  client: AccountingClient,
  accountId: string,
  expectedKind: 'CASH' | 'BANK' | 'WALLET',
  label: string,
  providerCode?: string | null
): Promise<PostingAccount & { providerCode?: string | null }> {
  const account = (await client.query(ACCOUNT_BY_ID_SQL, [accountId])).rows[0];
  if (!account) {
    throw new ApiError(400, `The selected settlement ledger for ${label} no longer exists. Choose another account.`);
  }
  if (account.isActive === false) {
    throw new ApiError(400, `The selected settlement ledger ${account.code} is inactive. Choose another account.`);
  }
  if (account.accountKind !== expectedKind) {
    throw new ApiError(
      400,
      `The selected settlement ledger ${account.code} is ${account.accountKind || 'not a cash/bank ledger'}, but this ${label} must settle through a ${expectedKind} ledger.`
    );
  }
  if (expectedKind === 'WALLET' && String(account.providerCode || '').toUpperCase() !== providerCode) {
    throw new ApiError(
      400,
      `The selected wallet ledger ${account.code} belongs to ${account.providerCode || 'no provider'}, not ${providerCode}.`
    );
  }
  return account as PostingAccount & { providerCode?: string | null };
}

function paymentMemo(label: string, doc: PaymentDocument): string {
  const parts = [`${label} ${doc.paymentNumber}`, String(doc.paymentMethod || 'CASH').toUpperCase()];
  if (doc.providerCode) parts.push(String(doc.providerCode).toUpperCase());
  if (doc.chequeNumber) parts.push(`cheque ${doc.chequeNumber}`);
  if (doc.bankName) parts.push(doc.bankName);
  return parts.join(' - ');
}

function controlLeg(
  account: PostingAccount,
  increase: boolean,
  amount: number,
  partyId: unknown,
  partyName: unknown,
  memo: string
): JournalLeg {
  return {
    accountId: account.id,
    increase,
    amount,
    memo,
    subledgerType: account.subledgerType,
    partyId: text(partyId),
    partyName: text(partyName),
  };
}

function ordinaryLeg(account: PostingAccount, increase: boolean, amount: number, memo: string): JournalLeg {
  return { accountId: account.id, increase, amount, memo };
}

/**
 * Debit cash/bank, credit AR control (customer subledger). Returns null only for
 * a zero-value receipt, which has no ledger effect.
 */
export async function postCustomerReceiptLedger(
  client: AccountingClient,
  input: { receipt: CustomerReceiptDocument; actor?: string | null }
) {
  const amount = money(input.receipt.amount);
  if (amount <= 0) return null;
  const partyName = text(input.receipt.customerName);
  if (!text(input.receipt.customerId) && !partyName) {
    throw new ApiError(400, 'A customer is required to post a receipt.');
  }

  const settlementRole = customerSettlementRole(input.receipt.paymentMethod);
  const providerCode = text(input.receipt.providerCode)?.toUpperCase() || null;
  if (settlementRole === 'WALLET' && !providerCode) {
    throw new ApiError(400, 'An ONLINE wallet receipt must name its provider (ESEWA, KHALTI or NEPAL_PAY).');
  }
  const settlementAccountId = text(input.receipt.settlementAccountId);
  const defaults = await loadPaymentDefaults(
    client,
    settlementAccountId || settlementRole === 'WALLET' ? ['AR_CONTROL'] : ['AR_CONTROL', settlementRole],
    'customer receipts'
  );
  let settlementAccount: PostingAccount;
  if (settlementAccountId) {
    settlementAccount = await loadSettlementAccount(
      client,
      settlementAccountId,
      settlementRole,
      'customer receipt',
      providerCode
    );
  } else if (settlementRole === 'WALLET') {
    const wallet = (await client.query(WALLET_ACCOUNT_BY_PROVIDER_SQL, [
      providerCode,
      input.receipt.branchId,
    ])).rows[0];
    if (!wallet) {
      throw new ApiError(
        400,
        `No active ${providerCode} wallet clearing ledger exists for this branch. Add one in Chart & Defaults before recording the receipt.`
      );
    }
    settlementAccount = wallet as PostingAccount;
  } else {
    settlementAccount = defaults[settlementRole];
  }
  const memo = paymentMemo('Customer receipt', input.receipt);

  return postJournalLegs(client, {
    journalDateAD: input.receipt.paymentDateAD,
    branchId: input.receipt.branchId,
    memo,
    sourceType: 'CUSTOMER_PAYMENT',
    sourceId: input.receipt.id,
    actor: input.actor || null,
    legs: [
      ordinaryLeg(settlementAccount, true, amount, memo),
      controlLeg(defaults.AR_CONTROL, false, amount, input.receipt.customerId, partyName, memo),
    ],
  });
}

/**
 * Refund an unsettled wallet receipt: debit AR (customer subledger) and credit
 * the provider clearing ledger for the gross. The provider has not paid us yet,
 * so the clearing balance falls back toward zero instead of becoming a bank
 * withdrawal that never happened.
 */
export async function postWalletRefundLedger(
  client: AccountingClient,
  input: { receipt: CustomerReceiptDocument; reason: string; actor?: string | null }
) {
  const amount = money(input.receipt.amount);
  if (amount <= 0) return null;
  const providerCode = text(input.receipt.providerCode)?.toUpperCase() || null;
  const walletAccountId = text(input.receipt.settlementAccountId);
  if (!providerCode || !walletAccountId) {
    throw new ApiError(400, 'The wallet receipt has no provider clearing ledger to refund.');
  }
  const defaults = await loadPaymentDefaults(client, ['AR_CONTROL'], 'wallet refunds');
  const wallet = await loadSettlementAccount(
    client,
    walletAccountId,
    'WALLET',
    'wallet refund',
    providerCode
  );
  const memo = `Wallet refund ${input.receipt.paymentNumber} - ${input.reason}`;
  return postJournalLegs(client, {
    journalDateAD: reversalDateAD(),
    branchId: input.receipt.branchId,
    memo,
    sourceType: 'WALLET_REFUND',
    sourceId: input.receipt.id,
    actor: input.actor || null,
    legs: [
      controlLeg(
        defaults.AR_CONTROL,
        true,
        amount,
        input.receipt.customerId,
        input.receipt.customerName,
        memo
      ),
      ordinaryLeg(wallet, false, amount, memo),
    ],
  });
}

/**
 * A chargeback is money the provider took back after settlement. It is not a
 * customer refund: debit the processing-fee/chargeback expense and credit the
 * clearing ledger, leaving an auditable reason and provider reference.
 */
export async function postWalletChargebackLedger(
  client: AccountingClient,
  input: { receipt: CustomerReceiptDocument; reason: string; actor?: string | null }
) {
  const amount = money(input.receipt.amount);
  if (amount <= 0) return null;
  const providerCode = text(input.receipt.providerCode)?.toUpperCase() || null;
  const walletAccountId = text(input.receipt.settlementAccountId);
  if (!providerCode || !walletAccountId) {
    throw new ApiError(400, 'The wallet receipt has no provider clearing ledger to charge back.');
  }
  const defaults = await loadPaymentDefaults(client, ['PAYMENT_FEE_EXPENSE'], 'wallet chargebacks');
  const wallet = await loadSettlementAccount(
    client,
    walletAccountId,
    'WALLET',
    'wallet chargeback',
    providerCode
  );
  const memo = `Wallet chargeback ${input.receipt.paymentNumber} - ${input.reason}`;
  return postJournalLegs(client, {
    journalDateAD: reversalDateAD(),
    branchId: input.receipt.branchId,
    memo,
    sourceType: 'WALLET_CHARGEBACK',
    sourceId: input.receipt.id,
    actor: input.actor || null,
    legs: [
      ordinaryLeg(defaults.PAYMENT_FEE_EXPENSE, true, amount, memo),
      ordinaryLeg(wallet, false, amount, memo),
    ],
  });
}

/**
 * Debit AP control (supplier subledger), credit cash/bank. Returns null only for
 * a zero-value payment, which has no ledger effect.
 */
export async function postVendorPaymentLedger(
  client: AccountingClient,
  input: { payment: VendorPaymentDocument; actor?: string | null }
) {
  const amount = money(input.payment.amount);
  if (amount <= 0) return null;
  const partyName = text(input.payment.supplierName);
  if (!text(input.payment.supplierId) && !partyName) {
    throw new ApiError(400, 'A supplier is required to post a vendor payment.');
  }

  const settlementRole = cashOrBankRole(input.payment.paymentMethod);
  const settlementAccountId = text(input.payment.settlementAccountId);
  const defaults = await loadPaymentDefaults(
    client,
    settlementAccountId ? ['AP_CONTROL'] : ['AP_CONTROL', settlementRole],
    'supplier payments'
  );
  const settlementAccount = settlementAccountId
    ? await loadSettlementAccount(client, settlementAccountId, settlementRole, 'supplier payment')
    : defaults[settlementRole];
  const memo = paymentMemo('Vendor payment', input.payment);

  return postJournalLegs(client, {
    journalDateAD: input.payment.paymentDateAD,
    branchId: input.payment.branchId,
    memo,
    sourceType: 'VENDOR_PAYMENT',
    sourceId: input.payment.id,
    actor: input.actor || null,
    legs: [
      controlLeg(defaults.AP_CONTROL, false, amount, input.payment.supplierId, partyName, memo),
      ordinaryLeg(settlementAccount, false, amount, memo),
    ],
  });
}

/** Today's date: the reversal is a new document and belongs in an open period. */
function reversalDateAD(): string {
  return new Date().toISOString().split('T')[0];
}

/** Contra journal for a customer receipt; a legacy receipt with no journal is a no-op. */
export async function reverseCustomerReceiptJournal(
  client: AccountingClient,
  input: PaymentReversalInput
) {
  return reverseSourceJournal(client, {
    sourceType: 'CUSTOMER_PAYMENT',
    reversalSourceType: 'CUSTOMER_PAYMENT_REVERSAL',
    sourceId: input.paymentId,
    dateAD: reversalDateAD(),
    reason: input.reason,
    actor: input.actor || null,
  });
}

/** Contra journal for a vendor payment; a legacy payment with no journal is a no-op. */
export async function reverseVendorPaymentJournal(
  client: AccountingClient,
  input: PaymentReversalInput
) {
  return reverseSourceJournal(client, {
    sourceType: 'VENDOR_PAYMENT',
    reversalSourceType: 'VENDOR_PAYMENT_REVERSAL',
    sourceId: input.paymentId,
    dateAD: reversalDateAD(),
    reason: input.reason,
    actor: input.actor || null,
  });
}
