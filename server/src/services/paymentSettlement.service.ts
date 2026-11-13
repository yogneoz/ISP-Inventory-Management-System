/**
 * ACC-3 wallet receipts and provider settlements.
 *
 * A wallet receipt is posted at gross to the provider clearing account. This
 * service later records a settlement allocation: bank net + provider fee =
 * clearing gross. The clearing balance is therefore the gross still unsettled,
 * and the provider statement is imported into the same statement store used by
 * bank reconciliation, but matched to the settlement row it paid.
 */
import crypto from 'crypto';
import { ApiError } from '../errors/ApiError';
import { bsDateOrThrow } from '../utils/bsDate';
import { roundMoney } from '../utils/money';
import type { AccountingClient } from './accounting.service';
import { isAccountingDate, postJournal } from './accounting.service';
import { BANK_IMPORT_INSERT_SQL } from '../models/bankReconciliation.repo';
import {
  ACCOUNT_BY_ID_SQL,
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  SETTLEMENT_ACCOUNTS_SQL,
} from '../models/accounting.repo';
import {
  PAYMENT_SETTLEMENT_BY_ID_SQL,
  PAYMENT_SETTLEMENT_INSERT_SQL,
  PROVIDER_SETTLEMENT_CANDIDATES_SQL,
  PROVIDER_SETTLEMENT_FOR_MATCH_SQL,
  PROVIDER_STATEMENT_CONFLICT_SQL,
  PROVIDER_STATEMENT_LINE_FOR_UPDATE_SQL,
  PROVIDER_STATEMENT_LINES_SQL,
  PROVIDER_STATEMENT_MATCH_SQL,
  WALLET_ACCOUNT_BY_ID_SQL,
  WALLET_ACCOUNTS_SQL,
  WALLET_LEDGER_MOVEMENT_SQL,
  WALLET_LEDGER_OPENING_SQL,
  WALLET_OUTSTANDING_SQL,
  WALLET_PAYMENT_FOR_SETTLEMENT_SQL,
  WALLET_PAYMENT_SETTLED_SQL,
  WALLET_PENDING_RECEIPTS_SQL,
  WALLET_RECEIPTS_SQL,
  WALLET_SETTLEMENT_ROWS_SQL,
  WALLET_SETTLEMENTS_SQL,
} from '../models/paymentSettlement.repo';
import {
  bankStatementFingerprint,
  parseBankStatement,
  type BankImportIssue,
} from './bankReconciliation.service';

const MAX_WALLET_PERIOD_DAYS = 400;
const MONEY_TOLERANCE = 0.005;

export interface WalletAccountOption {
  accountId: string;
  code: string;
  name: string;
  providerCode: string | null;
  settlementAccountId: string | null;
  branchId: string | null;
  branchCode: string | null;
  isActive: boolean;
}

export interface WalletPendingReceipt {
  id: string;
  paymentNumber: string;
  customerName: string;
  paymentDateAD: string;
  providerCode: string | null;
  providerTransactionId: string | null;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  settledGross: number;
  outstandingGross: number;
}

export interface WalletSettlementRow {
  id: string;
  settlementNumber: string;
  customerPaymentId: string;
  paymentNumber: string;
  customerName: string;
  bankAccountId: string;
  bankAccountCode: string;
  settlementDateAD: string;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  providerReference: string | null;
  journalId: string;
  status: string;
}

export interface ProviderStatementLine {
  id: string;
  statementDate: string;
  statementDateBS: string;
  description: string;
  reference: string | null;
  amount: number;
  importBatchId: string;
  importSource: 'CSV' | 'OFX';
  matchedSettlementId: string | null;
  matchedAt: string | null;
  matchedBy: string | null;
  matchedSettlementNumber: string | null;
  matchedSettlementNet: number | null;
  suggestedSettlementId: string | null;
}

export interface WalletReconciliationWorkspace {
  from: string;
  to: string;
  accounts: WalletAccountOption[];
  account: WalletAccountOption | null;
  summary: {
    ledgerOpening: number;
    ledgerReceipts: number;
    ledgerSettlements: number;
    ledgerClosing: number;
    grossReceipts: number;
    receiptCount: number;
    settledGross: number;
    settlementCount: number;
    fees: number;
    netBanked: number;
    unsettledGross: number;
    difference: number;
    reconciled: boolean;
  };
  pending: WalletPendingReceipt[];
  settlements: WalletSettlementRow[];
  statement: {
    lineCount: number;
    matchedCount: number;
    unmatchedCount: number;
    unmatchedAmount: number;
    movement: number;
  };
  lines: ProviderStatementLine[];
  linesTruncated: boolean;
}

export interface WalletQuery {
  accountId?: unknown;
  from?: unknown;
  to?: unknown;
}

export interface CreateSettlementInput {
  customerPaymentId?: unknown;
  bankAccountId?: unknown;
  settlementDateAD?: unknown;
  grossAmount?: unknown;
  feeAmount?: unknown;
  providerReference?: unknown;
}

export interface ProviderMatchInput {
  lineId?: unknown;
  settlementId?: unknown;
  actor?: string | null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function dateValue(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date (YYYY-MM-DD).`);
  }
  return date;
}

function todayAD(): string {
  return new Date().toISOString().slice(0, 10);
}

function requirePeriod(query: WalletQuery): { from: string; to: string } {
  const to = dateValue(query.to || todayAD(), 'The wallet reconciliation period end');
  const fromRaw = text(query.from, 10);
  const from = fromRaw || `${to.slice(0, 7)}-01`;
  if (!isAccountingDate(from)) {
    throw new ApiError(400, 'The wallet reconciliation period start must be a real date (YYYY-MM-DD).');
  }
  if (from > to) throw new ApiError(400, 'The wallet reconciliation period start must not be after its end.');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_WALLET_PERIOD_DAYS) {
    throw new ApiError(400, `A wallet reconciliation period may span at most ${MAX_WALLET_PERIOD_DAYS} days.`);
  }
  return { from, to };
}

function toWalletAccount(row: any): WalletAccountOption {
  return {
    accountId: String(row.accountId),
    code: String(row.code),
    name: String(row.name),
    providerCode: row.providerCode ? String(row.providerCode) : null,
    settlementAccountId: row.settlementAccountId ? String(row.settlementAccountId) : null,
    branchId: row.branchId ? String(row.branchId) : null,
    branchCode: row.branchCode ? String(row.branchCode) : null,
    isActive: row.isActive === true,
  };
}

async function resolveWalletAccount(
  client: AccountingClient,
  accountIdRaw: unknown
): Promise<WalletAccountOption> {
  const accountId = text(accountIdRaw, 50);
  if (!accountId) throw new ApiError(400, 'Choose a wallet clearing ledger.');
  const row = (await client.query(WALLET_ACCOUNT_BY_ID_SQL, [accountId])).rows[0];
  if (!row) throw new ApiError(404, 'Wallet clearing ledger not found.');
  return toWalletAccount(row);
}

function suggestSettlementId(
  line: { amount: number; reference: string | null },
  candidates: Array<{ id: string; netAmount: number; providerReference: string | null }>
): string | null {
  const amountMatches = candidates.filter((candidate) => money(candidate.netAmount) === money(line.amount));
  if (amountMatches.length === 0) return null;
  const reference = text(line.reference, 150).toUpperCase();
  if (reference) {
    const referenceMatches = amountMatches.filter(
      (candidate) => text(candidate.providerReference, 150).toUpperCase() === reference
    );
    if (referenceMatches.length === 1) return referenceMatches[0].id;
    if (referenceMatches.length > 1) return null;
  }
  return amountMatches.length === 1 ? amountMatches[0].id : null;
}

export async function readWalletReconciliation(
  client: AccountingClient,
  query: WalletQuery
): Promise<WalletReconciliationWorkspace> {
  const { from, to } = requirePeriod(query);
  const accounts = ((await client.query(WALLET_ACCOUNTS_SQL)).rows as any[]).map(toWalletAccount);
  const requested = text(query.accountId, 50);
  const selected = requested
    ? accounts.find((account) => account.accountId === requested) || null
    : accounts.find((account) => account.isActive) || accounts[0] || null;
  if (requested && !selected) throw new ApiError(404, 'Wallet clearing ledger not found.');

  if (!selected) {
    return {
      from,
      to,
      accounts,
      account: null,
      summary: {
        ledgerOpening: 0,
        ledgerReceipts: 0,
        ledgerSettlements: 0,
        ledgerClosing: 0,
        grossReceipts: 0,
        receiptCount: 0,
        settledGross: 0,
        settlementCount: 0,
        fees: 0,
        netBanked: 0,
        unsettledGross: 0,
        difference: 0,
        reconciled: true,
      },
      pending: [],
      settlements: [],
      statement: { lineCount: 0, matchedCount: 0, unmatchedCount: 0, unmatchedAmount: 0, movement: 0 },
      lines: [],
      linesTruncated: false,
    };
  }

  const ledgerOpening = money((await client.query(WALLET_LEDGER_OPENING_SQL, [selected.accountId, from])).rows[0]?.opening);
  const movement = (await client.query(WALLET_LEDGER_MOVEMENT_SQL, [selected.accountId, from, to])).rows[0] || {};
  const receipts = (await client.query(WALLET_RECEIPTS_SQL, [selected.accountId, from, to])).rows[0] || {};
  const settlements = (await client.query(WALLET_SETTLEMENTS_SQL, [selected.accountId, from, to])).rows[0] || {};
  const outstanding = (await client.query(WALLET_OUTSTANDING_SQL, [selected.accountId, to])).rows[0] || {};
  const pending = (await client.query(WALLET_PENDING_RECEIPTS_SQL, [selected.accountId])).rows as any[];
  const settlementRows = (await client.query(WALLET_SETTLEMENT_ROWS_SQL, [selected.accountId, from, to])).rows as any[];
  const statementLines = (await client.query(PROVIDER_STATEMENT_LINES_SQL, [selected.accountId, from, to])).rows as any[];
  const candidates = (await client.query(PROVIDER_SETTLEMENT_CANDIDATES_SQL, [selected.accountId, from, to])).rows as any[];

  const ledgerSettlements = money(movement.payments);
  const ledgerClosing = roundMoney(ledgerOpening + money(movement.movement));
  const unsettledGross = money(outstanding.unsettledGross);
  const fees = money(settlements.fees);
  const netBanked = money(settlements.net);
  const summary = {
    ledgerOpening,
    ledgerReceipts: money(movement.receipts),
    ledgerSettlements,
    ledgerClosing,
    grossReceipts: money(receipts.grossReceipts),
    receiptCount: Number(receipts.receiptCount) || 0,
    settledGross: money(settlements.settledGross),
    settlementCount: Number(settlements.settlementCount) || 0,
    fees,
    netBanked,
    unsettledGross,
    difference: roundMoney(ledgerClosing - unsettledGross),
    reconciled: Math.abs(roundMoney(ledgerClosing - unsettledGross)) < MONEY_TOLERANCE,
  };

  let matchedCount = 0;
  let unmatchedAmount = 0;
  let statementMovement = 0;
  const lines: ProviderStatementLine[] = statementLines.map((row) => {
    const amount = money(row.amount);
    const matched = Boolean(row.matchedSettlementId);
    if (matched) matchedCount += 1;
    else unmatchedAmount = roundMoney(unmatchedAmount + amount);
    statementMovement = roundMoney(statementMovement + amount);
    const line = {
      id: String(row.id),
      statementDate: String(row.statementDate).slice(0, 10),
      statementDateBS: String(row.statementDateBS),
      description: String(row.description),
      reference: row.reference ? String(row.reference) : null,
      amount,
      importBatchId: String(row.importBatchId),
      importSource: row.importSource === 'OFX' ? ('OFX' as const) : ('CSV' as const),
      matchedSettlementId: row.matchedSettlementId ? String(row.matchedSettlementId) : null,
      matchedAt: row.matchedAt ? String(row.matchedAt) : null,
      matchedBy: row.matchedBy ? String(row.matchedBy) : null,
      matchedSettlementNumber: row.matchedSettlementNumber ? String(row.matchedSettlementNumber) : null,
      matchedSettlementNet: row.matchedSettlementNet === null ? null : money(row.matchedSettlementNet),
      suggestedSettlementId: null as string | null,
    };
    line.suggestedSettlementId = matched ? null : suggestSettlementId(line, candidates);
    return line;
  });

  return {
    from,
    to,
    accounts,
    account: selected,
    summary,
    pending: pending.map((row) => ({
      id: String(row.id),
      paymentNumber: String(row.paymentNumber),
      customerName: String(row.customerName),
      paymentDateAD: String(row.paymentDateAD).slice(0, 10),
      providerCode: row.providerCode ? String(row.providerCode) : null,
      providerTransactionId: row.providerTransactionId ? String(row.providerTransactionId) : null,
      grossAmount: money(row.grossAmount),
      feeAmount: money(row.feeAmount),
      netAmount: money(row.netAmount),
      settledGross: money(row.settledGross),
      outstandingGross: money(row.outstandingGross),
    })),
    settlements: settlementRows.map((row) => ({
      id: String(row.id),
      settlementNumber: String(row.settlementNumber),
      customerPaymentId: String(row.customerPaymentId),
      paymentNumber: String(row.paymentNumber),
      customerName: String(row.customerName),
      bankAccountId: String(row.bankAccountId),
      bankAccountCode: String(row.bankAccountCode),
      settlementDateAD: String(row.settlementDateAD).slice(0, 10),
      grossAmount: money(row.grossAmount),
      feeAmount: money(row.feeAmount),
      netAmount: money(row.netAmount),
      providerReference: row.providerReference ? String(row.providerReference) : null,
      journalId: String(row.journalId),
      status: String(row.status),
    })),
    statement: {
      lineCount: lines.length,
      matchedCount,
      unmatchedCount: lines.length - matchedCount,
      unmatchedAmount,
      movement: statementMovement,
    },
    lines,
    linesTruncated: statementLines.length >= 1000,
  };
}

export async function createPaymentSettlement(
  client: AccountingClient,
  input: CreateSettlementInput,
  actor: string | null
) {
  const paymentId = text(input.customerPaymentId, 50);
  if (!paymentId) throw new ApiError(400, 'A wallet receipt is required.');
  const bankAccountId = text(input.bankAccountId, 50);
  if (!bankAccountId) throw new ApiError(400, 'Choose the bank account that received the settlement.');
  const settlementDateAD = dateValue(input.settlementDateAD || todayAD(), 'The settlement date');

  const payment = (await client.query(WALLET_PAYMENT_FOR_SETTLEMENT_SQL, [paymentId])).rows[0];
  if (!payment) throw new ApiError(404, 'Wallet receipt not found.');
  if (payment.status !== 'POSTED') throw new ApiError(409, `Receipt ${payment.paymentNumber} is ${String(payment.status).toLowerCase()}.`);
  if (payment.paymentMethod !== 'ONLINE') throw new ApiError(400, 'Only an ONLINE wallet receipt can be settled through a provider.');
  if (!payment.providerCode || !payment.settlementAccountId) {
    throw new ApiError(400, 'This receipt has no provider or wallet clearing ledger.');
  }

  const wallet = await resolveWalletAccount(client, payment.settlementAccountId);
  if (!wallet.isActive) throw new ApiError(400, 'The wallet clearing ledger is inactive.');
  if (wallet.providerCode !== String(payment.providerCode).toUpperCase()) {
    throw new ApiError(400, 'The receipt provider and wallet clearing ledger do not agree.');
  }
  const bank = (await client.query(ACCOUNT_BY_ID_SQL, [bankAccountId])).rows[0];
  if (!bank) throw new ApiError(400, 'The settlement bank account does not exist.');
  if (bank.isActive === false) throw new ApiError(400, 'The settlement bank account is inactive.');
  if (bank.accountKind !== 'BANK') throw new ApiError(400, 'The settlement account must be a BANK ledger.');

  const gross = money(input.grossAmount);
  const fee = money(input.feeAmount);
  if (gross <= 0) throw new ApiError(400, 'Settlement gross must be greater than zero.');
  if (fee < 0) throw new ApiError(400, 'Settlement fee cannot be negative.');
  if (fee > gross) throw new ApiError(400, 'Settlement fee cannot exceed its gross.');
  const net = roundMoney(gross - fee);
  if (net <= 0) throw new ApiError(400, 'Settlement net must be greater than zero.');

  const receiptGross = money(payment.grossAmount ?? payment.amount);
  const alreadySettled = money((await client.query(WALLET_PAYMENT_SETTLED_SQL, [payment.id])).rows[0]?.settledGross);
  if (roundMoney(alreadySettled + gross) > roundMoney(receiptGross) + MONEY_TOLERANCE) {
    throw new ApiError(
      409,
      `Receipt ${payment.paymentNumber} has NPR ${roundMoney(receiptGross - alreadySettled).toFixed(2)} left to settle.`
    );
  }

  const feeAccount = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [['PAYMENT_FEE_EXPENSE']])).rows[0];
  if (!feeAccount) {
    throw new ApiError(
      400,
      'Accounting is not configured for wallet settlements: no active account has the PAYMENT_FEE_EXPENSE posting default. Set it in Accounting → Posting defaults.'
    );
  }

  const settlementId = `ps-${crypto.randomUUID()}`;
  const settlementNumber = `PS-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
  const memo = `Wallet settlement ${settlementNumber} · ${payment.paymentNumber} · ${payment.providerCode}`;
  const lines: any[] = [
    { accountId: bank.id, debit: net, credit: 0, memo },
    { accountId: wallet.accountId, debit: 0, credit: gross, memo },
  ];
  if (fee > 0) {
    lines.splice(1, 0, { accountId: feeAccount.id, debit: fee, credit: 0, memo: `${memo} · provider fee` });
  }
  const journal = await postJournal(client, {
    journalDateAD: settlementDateAD,
    branchId: payment.branchId,
    memo,
    sourceType: 'PAYMENT_SETTLEMENT',
    sourceId: settlementId,
    actor,
    lines,
  });

  await client.query(PAYMENT_SETTLEMENT_INSERT_SQL, [
    settlementId,
    settlementNumber,
    payment.id,
    wallet.accountId,
    bank.id,
    settlementDateAD,
    await bsDateOrThrow(settlementDateAD, client),
    gross,
    fee,
    net,
    text(input.providerReference, 200) || null,
    journal.id,
    'POSTED',
    actor,
  ]);

  return (await client.query(PAYMENT_SETTLEMENT_BY_ID_SQL, [settlementId])).rows[0];
}

export async function importProviderStatement(
  client: AccountingClient,
  input: WalletQuery & { content?: unknown; format?: unknown },
  actor: string | null
) {
  const wallet = await resolveWalletAccount(client, input.accountId);
  const parsed = parseBankStatement(input.content, input.format);
  if (parsed.rows.length === 0) {
    throw new ApiError(400, parsed.errors[0]?.message || 'No provider statement lines were found.');
  }
  const dates = parsed.rows.map((row) => row.statementDate).sort();
  const batchId = `pssb-${crypto.randomUUID()}`;
  let imported = 0;
  let duplicates = 0;
  for (const row of parsed.rows) {
    const result = await client.query(BANK_IMPORT_INSERT_SQL, [
      `psl-${crypto.randomUUID()}`,
      wallet.accountId,
      row.statementDate,
      row.description,
      row.reference,
      row.amount,
      await bsDateOrThrow(row.statementDate, client),
      batchId,
      parsed.source,
      bankStatementFingerprint(wallet.accountId, row),
    ]);
    if (result.rows.length > 0) imported += 1;
    else duplicates += 1;
  }

  const candidates = (await client.query(PROVIDER_SETTLEMENT_CANDIDATES_SQL, [
    wallet.accountId,
    dates[0],
    dates[dates.length - 1],
  ])).rows as any[];
  const lines = (await client.query(PROVIDER_STATEMENT_LINES_SQL, [
    wallet.accountId,
    dates[0],
    dates[dates.length - 1],
  ])).rows as any[];
  let autoMatched = 0;
  for (const row of lines) {
    if (row.matchedSettlementId) continue;
    const line = {
      amount: money(row.amount),
      reference: row.reference ? String(row.reference) : null,
    };
    const settlementId = suggestSettlementId(line, candidates);
    if (!settlementId) continue;
    const updated = await client.query(PROVIDER_STATEMENT_MATCH_SQL, [row.id, settlementId, actor]);
    if (updated.rows.length > 0) {
      autoMatched += 1;
      const index = candidates.findIndex((candidate) => candidate.id === settlementId);
      if (index >= 0) candidates.splice(index, 1);
    }
  }

  return {
    batchId,
    parsed: parsed.rows.length,
    imported,
    duplicates,
    autoMatched,
    errors: parsed.errors as BankImportIssue[],
    source: parsed.source,
  };
}

export async function matchProviderStatementLine(
  client: AccountingClient,
  input: ProviderMatchInput
) {
  const lineId = text(input.lineId, 60);
  const settlementId = text(input.settlementId, 60);
  if (!lineId) throw new ApiError(400, 'A provider statement line is required.');
  if (!settlementId) throw new ApiError(400, 'Choose the settlement this provider line paid.');
  const line = (await client.query(PROVIDER_STATEMENT_LINE_FOR_UPDATE_SQL, [lineId])).rows[0];
  if (!line) throw new ApiError(404, 'Provider statement line not found.');
  if (line.matchedSettlementId && line.matchedSettlementId !== settlementId) {
    throw new ApiError(409, 'That provider statement line is already matched.');
  }
  const settlement = (await client.query(PROVIDER_SETTLEMENT_FOR_MATCH_SQL, [settlementId])).rows[0];
  if (!settlement) throw new ApiError(404, 'Payment settlement not found.');
  if (settlement.status !== 'POSTED') throw new ApiError(409, 'That settlement is not posted.');
  if (settlement.walletAccountId !== line.walletAccountId) {
    throw new ApiError(400, 'That settlement belongs to a different wallet account.');
  }
  if (money(settlement.netAmount) !== money(line.amount)) {
    throw new ApiError(
      400,
      `Provider line net ${money(line.amount).toFixed(2)} does not equal settlement net ${money(settlement.netAmount).toFixed(2)}.`
    );
  }
  const conflict = (await client.query(PROVIDER_STATEMENT_CONFLICT_SQL, [settlementId, lineId])).rows[0];
  if (conflict) throw new ApiError(409, 'That settlement is already matched to another provider line.');

  await client.query(PROVIDER_STATEMENT_MATCH_SQL, [lineId, settlementId, input.actor || null]);
  return { lineId, settlementId, amount: money(settlement.netAmount) };
}
