/**
 * Bank reconciliation service.
 *
 * The book side is always the posted ledger: opening = signed balance before
 * the period, movement = posted debits less credits inside it. The statement
 * side is imported text (CSV or OFX) with a signed amount (positive = deposit,
 * negative = withdrawal). Matching attaches one statement line to one posted
 * bank-book line only when both signed amounts agree. The service never edits
 * the ledger; it only records the match and the period session.
 */
import crypto from 'crypto';
import { ApiError } from '../errors/ApiError';
import { isAccountingDate, type AccountingClient } from './accounting.service';
import { roundMoney } from '../utils/money';
import { bsDateOrThrow } from '../utils/bsDate';
import {
  BANK_ACCOUNTS_SQL,
  BANK_ACCOUNT_BY_ID_SQL,
  BANK_BOOK_ENTRIES_SQL,
  BANK_BOOK_MOVEMENT_SQL,
  BANK_BOOK_OPENING_SQL,
  BANK_DEFAULT_WINDOW_SQL,
  BANK_IMPORT_INSERT_SQL,
  BANK_JOURNAL_LINE_FOR_UPDATE_SQL,
  BANK_JOURNAL_LINE_MATCH_CONFLICT_SQL,
  BANK_LOCKED_SESSION_FOR_DATES_SQL,
  BANK_SESSION_BY_ACCOUNT_PERIOD_FOR_UPDATE_SQL,
  BANK_SESSION_BY_ACCOUNT_PERIOD_SQL,
  BANK_SESSION_BY_ID_FOR_UPDATE_SQL,
  BANK_SESSION_BY_ID_SQL,
  BANK_SESSION_INSERT_SQL,
  BANK_SESSION_LOCK_SQL,
  BANK_SESSION_OVERLAP_SQL,
  BANK_SESSION_REOPEN_SQL,
  BANK_SESSION_UPDATE_SQL,
  BANK_STATEMENT_LINE_FOR_UPDATE_SQL,
  BANK_STATEMENT_LINES_SQL,
  BANK_STATEMENT_MATCH_UPDATE_SQL,
  BANK_STATEMENT_SUMMARY_SQL,
  BANK_STATEMENT_UNMATCH_UPDATE_SQL,
  type BankAccountRow,
  type BankBookEntryRow,
  type BankReconciliationSessionRow,
  type BankStatementLineRow,
} from '../models/bankReconciliation.repo';

export const MAX_BANK_IMPORT_BYTES = 2_000_000;
export const MAX_BANK_IMPORT_ROWS = 5_000;
export const MAX_BANK_RECONCILIATION_DAYS = 400;

export interface BankReconciliationQuery {
  accountId?: unknown;
  from?: unknown;
  to?: unknown;
}

export interface BankAccountOption {
  accountId: string;
  code: string;
  name: string;
  bankName: string | null;
  bankBranch: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  isActive: boolean;
}

export interface BankBookEntry {
  journalLineId: string;
  journalId: string;
  journalNo: string;
  journalDateAD: string;
  sourceType: string;
  sourceId: string | null;
  journalMemo: string | null;
  memo: string | null;
  debit: number;
  credit: number;
  /** Positive when the ledger was debited (money in). */
  amount: number;
  branchId: string;
  branchCode: string;
  branchName: string;
  matchedStatementLineId: string | null;
}

export interface BankStatementLine {
  id: string;
  statementDate: string;
  statementDateBS: string;
  description: string;
  reference: string | null;
  /** Positive = deposit, negative = withdrawal. */
  amount: number;
  importBatchId: string;
  importSource: 'CSV' | 'OFX';
  matchedJournalLineId: string | null;
  matchedAt: string | null;
  matchedBy: string | null;
  matchedJournalNo: string | null;
  matchedJournalDate: string | null;
  matchedBranchId: string | null;
  matchedBranchCode: string | null;
  matchedBranchName: string | null;
  suggestedJournalLineId: string | null;
}

export interface BankReconciliationSession {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  periodStartBS: string;
  periodEndBS: string;
  openingStatementBalance: number;
  closingStatementBalance: number;
  status: 'OPEN' | 'LOCKED';
  lockedAt: string | null;
  lockedBy: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BankReconciliationWorkspace {
  from: string;
  to: string;
  accounts: BankAccountOption[];
  account: BankAccountOption | null;
  session: BankReconciliationSession | null;
  statement: {
    openingBalance: number;
    closingBalance: number;
    movement: number;
    lineCount: number;
    matchedCount: number;
    unmatchedCount: number;
    unmatchedAmount: number;
  };
  book: {
    openingBalance: number;
    closingBalance: number;
    movement: number;
    lineCount: number;
    entries: BankBookEntry[];
    truncated: boolean;
  };
  /** closing statement balance - book closing balance. */
  difference: number;
  reconciled: boolean;
  lines: BankStatementLine[];
  linesTruncated: boolean;
}

export interface BankImportIssue {
  row: number;
  message: string;
}

export interface ParsedBankStatementRow {
  rowNumber: number;
  statementDate: string;
  description: string;
  reference: string | null;
  amount: number;
}

export interface BankStatementParseResult {
  source: 'CSV' | 'OFX';
  rows: ParsedBankStatementRow[];
  errors: BankImportIssue[];
}

export interface BankImportResult {
  batchId: string;
  parsed: number;
  imported: number;
  duplicates: number;
  errors: BankImportIssue[];
  source: 'CSV' | 'OFX';
}

export interface BankImportInput extends BankReconciliationQuery {
  content?: unknown;
  format?: unknown;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function todayAD(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateValue(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date (YYYY-MM-DD).`);
  }
  return date;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeReference(value: unknown): string {
  return text(value, 150).replace(/\s+/g, ' ').toUpperCase();
}

function parseAmount(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  const value = text(raw, 80);
  if (!value) return NaN;
  const negativeParen = /^\(.*\)$/.test(value);
  const cleaned = value
    .replace(/[^\d.,-]/g, '')
    .replace(/,/g, '');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return NaN;
  return negativeParen ? -Math.abs(parsed) : parsed;
}

function isoDate(year: number, month: number, day: number): string | null {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isAccountingDate(value) ? value : null;
}

/** Accepts ISO, day-first and OFX-style compact dates. */
export function parseStatementDate(raw: unknown): string | null {
  const value = text(raw, 30);
  if (!value) return null;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return isoDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  const yearFirst = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (yearFirst) return isoDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  const dayFirst = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dayFirst) return isoDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  return null;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function detectDelimiter(header: string): string {
  const candidates = [',', ';', '\t'];
  return candidates.reduce((best, candidate) =>
    header.split(candidate).length > header.split(best).length ? candidate : best
  , ',');
}

function firstField(
  row: Record<string, string>,
  aliases: readonly string[]
): string {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function parseCsv(content: string): BankStatementParseResult {
  const lines = content.split(/\r?\n/);
  const headerLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerLineIndex < 0) {
    throw new ApiError(400, 'The import is empty.');
  }
  const delimiter = detectDelimiter(lines[headerLineIndex]);
  const headers = splitDelimitedLine(lines[headerLineIndex], delimiter).map(normalizeHeader);
  const header = new Set(headers);
  const hasDate = headers.some((name) => ['date', 'transactiondate', 'postingdate', 'valuedate', 'txndate'].includes(name));
  const hasDescription = headers.some((name) => ['description', 'narration', 'particulars', 'details', 'memo', 'name'].includes(name));
  const hasAmount = headers.some((name) => ['amount', 'transactionamount'].includes(name));
  const hasDebit = headers.some((name) => ['debit', 'withdrawal', 'withdrawals', 'dr', 'paidout', 'outflow'].includes(name));
  const hasCredit = headers.some((name) => ['credit', 'deposit', 'deposits', 'cr', 'paidin', 'inflow'].includes(name));
  if (!hasDate || !hasDescription || (!hasAmount && !hasDebit && !hasCredit)) {
    throw new ApiError(
      400,
      'CSV import needs date, description and amount (or debit/credit) columns.'
    );
  }

  const rows: ParsedBankStatementRow[] = [];
  const errors: BankImportIssue[] = [];
  for (let index = headerLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const rowNumber = index + 1;
    if (rows.length + errors.length >= MAX_BANK_IMPORT_ROWS) {
      errors.push({ row: rowNumber, message: `Only the first ${MAX_BANK_IMPORT_ROWS} rows are imported.` });
      break;
    }
    const fields = splitDelimitedLine(line, delimiter);
    if (fields.every((field) => !field)) continue;
    const row: Record<string, string> = {};
    headers.forEach((name, fieldIndex) => {
      row[name] = fields[fieldIndex] ?? '';
    });
    const statementDate = parseStatementDate(
      firstField(row, ['date', 'transactiondate', 'postingdate', 'valuedate', 'txndate'])
    );
    if (!statementDate) {
      errors.push({ row: rowNumber, message: 'A valid statement date is required.' });
      continue;
    }
    const description =
      firstField(row, ['description', 'narration', 'particulars', 'details', 'memo', 'name']) ||
      'Bank statement line';
    const reference = firstField(row, ['reference', 'ref', 'referenceno', 'chequeno', 'cheque', 'instrument', 'fitid']);
    const debit = parseAmount(firstField(row, ['debit', 'withdrawal', 'withdrawals', 'dr', 'paidout', 'outflow']));
    const credit = parseAmount(firstField(row, ['credit', 'deposit', 'deposits', 'cr', 'paidin', 'inflow']));
    const amountField = parseAmount(firstField(row, ['amount', 'transactionamount']));
    const type = normalizeHeader(firstField(row, ['type', 'trntype']));
    let amount = NaN;
    if (Number.isFinite(debit) && debit !== 0) {
      amount = -Math.abs(debit);
    } else if (Number.isFinite(credit) && credit !== 0) {
      amount = Math.abs(credit);
    } else if (Number.isFinite(amountField)) {
      amount = amountField;
      if (amount > 0 && /debit|dr|withdraw|payment|outflow/.test(type)) amount = -amount;
      if (amount < 0 && /credit|cr|deposit|receipt|inflow/.test(type)) amount = Math.abs(amount);
    }
    if (!Number.isFinite(amount) || amount === 0) {
      errors.push({ row: rowNumber, message: 'A non-zero amount is required.' });
      continue;
    }
    rows.push({
      rowNumber,
      statementDate,
      description: description.slice(0, 300),
      reference: reference ? reference.slice(0, 150) : null,
      amount: money(amount),
    });
  }
  return { source: 'CSV', rows, errors };
}

function ofxTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)(?=<|$)`, 'i'));
  return match ? match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
}

function parseOfx(content: string): BankStatementParseResult {
  const blocks = [...content.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)];
  if (blocks.length === 0) {
    throw new ApiError(400, 'No OFX transactions were found in the file.');
  }
  const rows: ParsedBankStatementRow[] = [];
  const errors: BankImportIssue[] = [];
  blocks.slice(0, MAX_BANK_IMPORT_ROWS).forEach((match, index) => {
    const rowNumber = index + 1;
    const block = match[1];
    const statementDate = parseStatementDate(ofxTag(block, 'DTPOSTED'));
    const amount = parseAmount(ofxTag(block, 'TRNAMT'));
    if (!statementDate) {
      errors.push({ row: rowNumber, message: 'A valid OFX posting date is required.' });
      return;
    }
    if (!Number.isFinite(amount) || amount === 0) {
      errors.push({ row: rowNumber, message: 'A non-zero OFX amount is required.' });
      return;
    }
    const name = ofxTag(block, 'NAME');
    const memo = ofxTag(block, 'MEMO');
    const description = [name, memo].filter(Boolean).join(' · ') || 'Bank statement line';
    const reference = ofxTag(block, 'FITID') || ofxTag(block, 'CHECKNUM');
    rows.push({
      rowNumber,
      statementDate,
      description: description.slice(0, 300),
      reference: reference ? reference.slice(0, 150) : null,
      amount: money(amount),
    });
  });
  if (blocks.length > MAX_BANK_IMPORT_ROWS) {
    errors.push({
      row: MAX_BANK_IMPORT_ROWS + 1,
      message: `Only the first ${MAX_BANK_IMPORT_ROWS} transactions are imported.`,
    });
  }
  return { source: 'OFX', rows, errors };
}

export function parseBankStatement(contentRaw: unknown, formatRaw?: unknown): BankStatementParseResult {
  const content = typeof contentRaw === 'string' ? contentRaw : '';
  if (!content.trim()) throw new ApiError(400, 'Choose a CSV or OFX statement to import.');
  if (Buffer.byteLength(content, 'utf8') > MAX_BANK_IMPORT_BYTES) {
    throw new ApiError(413, `A statement may be at most ${MAX_BANK_IMPORT_BYTES} bytes.`);
  }
  const requested = text(formatRaw, 10).toUpperCase();
  const source =
    requested === 'OFX' || requested === 'QFX' || /<OFX|<STMTTRN/i.test(content)
      ? 'OFX'
      : 'CSV';
  return source === 'OFX' ? parseOfx(content) : parseCsv(content);
}

export function bankStatementFingerprint(
  accountId: string,
  row: Pick<ParsedBankStatementRow, 'statementDate' | 'reference' | 'description' | 'amount'>
): string {
  const reference = normalizeReference(row.reference);
  const basis = [
    accountId,
    row.statementDate,
    money(row.amount).toFixed(2),
    reference || row.description.trim().toUpperCase(),
  ].join('|');
  return crypto.createHash('sha256').update(basis).digest('hex');
}

function toAccount(row: BankAccountRow): BankAccountOption {
  return {
    accountId: String(row.accountId),
    code: String(row.code),
    name: String(row.name),
    bankName: row.bankName ? String(row.bankName) : null,
    bankBranch: row.bankBranch ? String(row.bankBranch) : null,
    accountNumber: row.accountNumber ? String(row.accountNumber) : null,
    accountHolder: row.accountHolder ? String(row.accountHolder) : null,
    isActive: Boolean(row.isActive),
  };
}

function toBookEntry(row: BankBookEntryRow): BankBookEntry {
  const debit = money(row.debit);
  const credit = money(row.credit);
  return {
    journalLineId: String(row.journalLineId),
    journalId: String(row.journalId),
    journalNo: String(row.journalNo),
    journalDateAD: String(row.journalDateAD).slice(0, 10),
    sourceType: String(row.sourceType),
    sourceId: row.sourceId ? String(row.sourceId) : null,
    journalMemo: row.journalMemo ? String(row.journalMemo) : null,
    memo: row.memo ? String(row.memo) : null,
    debit,
    credit,
    amount: roundMoney(debit - credit),
    branchId: String(row.branchId),
    branchCode: String(row.branchCode),
    branchName: String(row.branchName),
    matchedStatementLineId: row.matchedStatementLineId ? String(row.matchedStatementLineId) : null,
  };
}

function toSession(row: BankReconciliationSessionRow): BankReconciliationSession {
  return {
    id: String(row.id),
    bankAccountId: String(row.bankAccountId),
    periodStart: String(row.periodStart).slice(0, 10),
    periodEnd: String(row.periodEnd).slice(0, 10),
    periodStartBS: String(row.periodStartBS),
    periodEndBS: String(row.periodEndBS),
    openingStatementBalance: money(row.openingStatementBalance),
    closingStatementBalance: money(row.closingStatementBalance),
    status: row.status === 'LOCKED' ? 'LOCKED' : 'OPEN',
    lockedAt: row.lockedAt ? String(row.lockedAt) : null,
    lockedBy: row.lockedBy ? String(row.lockedBy) : null,
    reopenedAt: row.reopenedAt ? String(row.reopenedAt) : null,
    reopenedBy: row.reopenedBy ? String(row.reopenedBy) : null,
    reopenReason: row.reopenReason ? String(row.reopenReason) : null,
    createdBy: row.createdBy ? String(row.createdBy) : null,
    createdAt: row.createdAt ? String(row.createdAt) : null,
    updatedAt: row.updatedAt ? String(row.updatedAt) : null,
  };
}

async function resolvePeriod(
  client: AccountingClient,
  query: BankReconciliationQuery
): Promise<{ from: string; to: string }> {
  const to = dateValue(query.to, 'The reconciliation period end');
  const rawFrom = text(query.from, 10);
  let from = rawFrom;
  if (!from) {
    const current = (await client.query(BANK_DEFAULT_WINDOW_SQL)).rows[0] as
      | { startDateAD?: string }
      | undefined;
    from = current?.startDateAD ? String(current.startDateAD).slice(0, 10) : `${to.slice(0, 7)}-01`;
  }
  if (!isAccountingDate(from)) {
    throw new ApiError(400, 'The reconciliation period start must be a real date (YYYY-MM-DD).');
  }
  if (from > to) throw new ApiError(400, 'The reconciliation period start must not be after its end.');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_BANK_RECONCILIATION_DAYS) {
    throw new ApiError(400, `A reconciliation period may span at most ${MAX_BANK_RECONCILIATION_DAYS} days.`);
  }
  return { from, to };
}

async function resolveAccount(
  client: AccountingClient,
  accountIdRaw: unknown
): Promise<BankAccountOption> {
  const accountId = text(accountIdRaw, 50);
  if (!accountId) throw new ApiError(400, 'Choose a bank ledger.');
  const row = (await client.query(BANK_ACCOUNT_BY_ID_SQL, [accountId])).rows[0] as
    | BankAccountRow
    | undefined;
  if (!row) throw new ApiError(404, 'Bank ledger not found.');
  return toAccount(row);
}

function suggestBookLine(
  line: BankStatementLine,
  entries: BankBookEntry[]
): string | null {
  if (line.matchedJournalLineId) return null;
  const candidates = entries.filter(
    (entry) => !entry.matchedStatementLineId && entry.amount === line.amount
  );
  if (candidates.length === 0) return null;
  const target = Date.parse(`${line.statementDate}T00:00:00Z`);
  const scored = candidates
    .map((entry) => ({
      entry,
      days: Math.abs(Date.parse(`${entry.journalDateAD}T00:00:00Z`) - target) / 86_400_000,
    }))
    .filter((candidate) => candidate.days <= 14)
    .sort((a, b) => a.days - b.days || a.entry.journalLineId.localeCompare(b.entry.journalLineId));
  return scored[0]?.entry.journalLineId || null;
}

export async function readBankReconciliation(
  client: AccountingClient,
  query: BankReconciliationQuery
): Promise<BankReconciliationWorkspace> {
  const { from, to } = await resolvePeriod(client, query);
  const accounts = ((await client.query(BANK_ACCOUNTS_SQL)).rows as BankAccountRow[]).map(toAccount);
  const requestedAccountId = text(query.accountId, 50);
  const selected = requestedAccountId
    ? accounts.find((account) => account.accountId === requestedAccountId) || null
    : accounts.find((account) => account.isActive) || accounts[0] || null;
  if (requestedAccountId && !selected) throw new ApiError(404, 'Bank ledger not found.');

  if (!selected) {
    return {
      from,
      to,
      accounts,
      account: null,
      session: null,
      statement: {
        openingBalance: 0,
        closingBalance: 0,
        movement: 0,
        lineCount: 0,
        matchedCount: 0,
        unmatchedCount: 0,
        unmatchedAmount: 0,
      },
      book: { openingBalance: 0, closingBalance: 0, movement: 0, lineCount: 0, entries: [], truncated: false },
      difference: 0,
      reconciled: true,
      lines: [],
      linesTruncated: false,
    };
  }

  // Keep one client's reads sequential: a checked-out pg Client serialises
  // them anyway, and the ordering makes the workspace internally consistent.
  const openingResult = await client.query(BANK_BOOK_OPENING_SQL, [selected.accountId, from]);
  const movementResult = await client.query(BANK_BOOK_MOVEMENT_SQL, [selected.accountId, from, to]);
  const entriesResult = await client.query(BANK_BOOK_ENTRIES_SQL, [selected.accountId, from, to]);
  const summaryResult = await client.query(BANK_STATEMENT_SUMMARY_SQL, [selected.accountId, from, to]);
  const linesResult = await client.query(BANK_STATEMENT_LINES_SQL, [selected.accountId, from, to]);
  const sessionResult = await client.query(BANK_SESSION_BY_ACCOUNT_PERIOD_SQL, [selected.accountId, from, to]);

  const bookOpening = money((openingResult.rows[0] as any)?.opening);
  const bookMovement = money((movementResult.rows[0] as any)?.movement);
  const bookClosing = roundMoney(bookOpening + bookMovement);
  const entries = (entriesResult.rows as BankBookEntryRow[]).map(toBookEntry);
  const summary = summaryResult.rows[0] as
    | { lineCount: number; matchedCount: number; movement: number; unmatchedAmount: number; unmatchedCount: number }
    | undefined;
  const session = sessionResult.rows[0]
    ? toSession(sessionResult.rows[0] as BankReconciliationSessionRow)
    : null;
  const statementOpening = session ? session.openingStatementBalance : bookOpening;
  const statementClosing = session ? session.closingStatementBalance : bookClosing;
  const statementMovement = money(summary?.movement);
  const lines = (linesResult.rows as BankStatementLineRow[]).map((row) => {
    const line: BankStatementLine = {
      id: String(row.id),
      statementDate: String(row.statementDate).slice(0, 10),
      statementDateBS: String(row.statementDateBS),
      description: String(row.description),
      reference: row.reference ? String(row.reference) : null,
      amount: money(row.amount),
      importBatchId: String(row.importBatchId),
      importSource: row.importSource === 'OFX' ? 'OFX' : 'CSV',
      matchedJournalLineId: row.matchedJournalLineId ? String(row.matchedJournalLineId) : null,
      matchedAt: row.matchedAt ? String(row.matchedAt) : null,
      matchedBy: row.matchedBy ? String(row.matchedBy) : null,
      matchedJournalNo: row.matchedJournalNo ? String(row.matchedJournalNo) : null,
      matchedJournalDate: row.matchedJournalDate ? String(row.matchedJournalDate).slice(0, 10) : null,
      matchedBranchId: row.matchedBranchId ? String(row.matchedBranchId) : null,
      matchedBranchCode: row.matchedBranchCode ? String(row.matchedBranchCode) : null,
      matchedBranchName: row.matchedBranchName ? String(row.matchedBranchName) : null,
      suggestedJournalLineId: null,
    };
    line.suggestedJournalLineId = suggestBookLine(line, entries);
    return line;
  });

  return {
    from,
    to,
    accounts,
    account: selected,
    session,
    statement: {
      openingBalance: statementOpening,
      closingBalance: statementClosing,
      movement: statementMovement,
      lineCount: Number(summary?.lineCount) || 0,
      matchedCount: Number(summary?.matchedCount) || 0,
      unmatchedCount: Number(summary?.unmatchedCount) || 0,
      unmatchedAmount: money(summary?.unmatchedAmount),
    },
    book: {
      openingBalance: bookOpening,
      closingBalance: bookClosing,
      movement: bookMovement,
      lineCount: Number((movementResult.rows[0] as any)?.lineCount) || 0,
      entries,
      truncated: (Number((movementResult.rows[0] as any)?.lineCount) || 0) > entries.length,
    },
    difference: roundMoney(statementClosing - bookClosing),
    reconciled: roundMoney(statementClosing - bookClosing) === 0,
    lines,
    linesTruncated: (Number(summary?.lineCount) || 0) > lines.length,
  };
}

export async function importBankStatement(
  client: AccountingClient,
  input: BankImportInput,
  actor: string | null
): Promise<BankImportResult> {
  const account = await resolveAccount(client, input.accountId);
  const parsed = parseBankStatement(input.content, input.format);
  if (parsed.rows.length === 0) {
    const first = parsed.errors[0]?.message;
    throw new ApiError(400, first ? `No statement lines could be imported: ${first}` : 'No statement lines were found.');
  }

  const dates = parsed.rows.map((row) => row.statementDate).sort();
  const locked = (await client.query(BANK_LOCKED_SESSION_FOR_DATES_SQL, [
    account.accountId,
    dates[0],
    dates[dates.length - 1],
  ])).rows[0] as { periodStart: string; periodEnd: string } | undefined;
  if (locked) {
    throw new ApiError(
      409,
      `The statement period ${locked.periodStart} to ${locked.periodEnd} is locked. Reopen it before importing.`
    );
  }

  const batchId = `bksb-${crypto.randomUUID()}`;
  const bsByDate = new Map<string, string>();
  let imported = 0;
  let duplicates = 0;
  for (const row of parsed.rows) {
    let statementDateBS = bsByDate.get(row.statementDate);
    if (!statementDateBS) {
      statementDateBS = await bsDateOrThrow(row.statementDate, client);
      bsByDate.set(row.statementDate, statementDateBS);
    }
    const result = await client.query(BANK_IMPORT_INSERT_SQL, [
      `bsl-${crypto.randomUUID()}`,
      account.accountId,
      row.statementDate,
      row.description,
      row.reference,
      row.amount,
      statementDateBS,
      batchId,
      parsed.source,
      bankStatementFingerprint(account.accountId, row),
    ]);
    if (result.rows.length > 0) imported += 1;
    else duplicates += 1;
  }

  // The actor is used by the controller's audit row; keeping it in the input
  // contract documents that an import is always attributed.
  void actor;

  return {
    batchId,
    parsed: parsed.rows.length,
    imported,
    duplicates,
    errors: parsed.errors,
    source: parsed.source,
  };
}

export interface BankMatchInput {
  lineId: unknown;
  journalLineId: unknown;
  actor: string | null;
}

export async function matchBankStatementLine(
  client: AccountingClient,
  input: BankMatchInput
): Promise<{ lineId: string; journalLineId: string; journalNo: string; amount: number }> {
  const lineId = text(input.lineId, 60);
  const journalLineId = text(input.journalLineId, 60);
  if (!lineId) throw new ApiError(400, 'A statement line is required.');
  if (!journalLineId) throw new ApiError(400, 'Choose a posted bank-book line to match.');

  const line = (await client.query(BANK_STATEMENT_LINE_FOR_UPDATE_SQL, [lineId]))
    .rows[0] as
    | { id: string; bankAccountId: string; statementDate: string; amount: number; matchedJournalLineId: string | null }
    | undefined;
  if (!line) throw new ApiError(404, 'Statement line not found.');

  const locked = (await client.query(BANK_LOCKED_SESSION_FOR_DATES_SQL, [
    line.bankAccountId,
    String(line.statementDate).slice(0, 10),
    String(line.statementDate).slice(0, 10),
  ])).rows[0] as { periodStart: string; periodEnd: string } | undefined;
  if (locked) {
    throw new ApiError(409, `The statement period ${locked.periodStart} to ${locked.periodEnd} is locked. Reopen it before matching.`);
  }
  if (line.matchedJournalLineId && line.matchedJournalLineId !== journalLineId) {
    throw new ApiError(409, 'That statement line is already matched. Unmatch it first.');
  }

  const book = (await client.query(BANK_JOURNAL_LINE_FOR_UPDATE_SQL, [
    journalLineId,
    line.bankAccountId,
  ])).rows[0] as
    | { journalLineId: string; journalNo: string; debit: number; credit: number; journalDateAD: string }
    | undefined;
  if (!book) throw new ApiError(400, 'The selected line is not a posted line on this bank ledger.');
  const bookAmount = roundMoney(money(book.debit) - money(book.credit));
  const statementAmount = money(line.amount);
  if (bookAmount !== statementAmount) {
    throw new ApiError(
      400,
      `Amounts do not agree: statement ${statementAmount.toFixed(2)}, bank book ${bookAmount.toFixed(2)}.`
    );
  }
  const conflict = (await client.query(BANK_JOURNAL_LINE_MATCH_CONFLICT_SQL, [journalLineId, line.id])).rows[0];
  if (conflict) throw new ApiError(409, 'That bank-book line is already matched to another statement line.');

  await client.query(BANK_STATEMENT_MATCH_UPDATE_SQL, [line.id, journalLineId, input.actor]);
  return {
    lineId: String(line.id),
    journalLineId: String(book.journalLineId),
    journalNo: String(book.journalNo),
    amount: statementAmount,
  };
}

export interface BankUnmatchInput {
  lineId: unknown;
  actor: string | null;
}

export async function unmatchBankStatementLine(
  client: AccountingClient,
  input: BankUnmatchInput
): Promise<{ lineId: string; previousJournalLineId: string; amount: number }> {
  const lineId = text(input.lineId, 60);
  if (!lineId) throw new ApiError(400, 'A statement line is required.');
  const line = (await client.query(BANK_STATEMENT_LINE_FOR_UPDATE_SQL, [lineId]))
    .rows[0] as
    | { id: string; bankAccountId: string; statementDate: string; amount: number; matchedJournalLineId: string | null }
    | undefined;
  if (!line) throw new ApiError(404, 'Statement line not found.');
  if (!line.matchedJournalLineId) throw new ApiError(400, 'That statement line is not matched.');
  const locked = (await client.query(BANK_LOCKED_SESSION_FOR_DATES_SQL, [
    line.bankAccountId,
    String(line.statementDate).slice(0, 10),
    String(line.statementDate).slice(0, 10),
  ])).rows[0] as { periodStart: string; periodEnd: string } | undefined;
  if (locked) {
    throw new ApiError(409, `The statement period ${locked.periodStart} to ${locked.periodEnd} is locked. Reopen it before unmatching.`);
  }
  await client.query(BANK_STATEMENT_UNMATCH_UPDATE_SQL, [line.id]);
  void input.actor;
  return {
    lineId: String(line.id),
    previousJournalLineId: String(line.matchedJournalLineId),
    amount: money(line.amount),
  };
}

export interface BankSessionInput extends BankReconciliationQuery {
  openingStatementBalance?: unknown;
  closingStatementBalance?: unknown;
  actor: string | null;
}

async function readSessionById(
  client: AccountingClient,
  id: string
): Promise<BankReconciliationSession> {
  const row = (await client.query(BANK_SESSION_BY_ID_SQL, [id])).rows[0] as
    | BankReconciliationSessionRow
    | undefined;
  if (!row) throw new ApiError(404, 'Bank reconciliation session not found.');
  return toSession(row);
}

export async function saveBankReconciliationSession(
  client: AccountingClient,
  input: BankSessionInput
): Promise<BankReconciliationSession> {
  const account = await resolveAccount(client, input.accountId);
  const from = dateValue(input.from, 'The reconciliation period start');
  const to = dateValue(input.to, 'The reconciliation period end');
  if (from > to) throw new ApiError(400, 'The reconciliation period start must not be after its end.');
  const opening = money(input.openingStatementBalance);
  const closing = money(input.closingStatementBalance);
  if (Math.abs(opening) > 1e14 || Math.abs(closing) > 1e14) {
    throw new ApiError(400, 'Statement balances are outside the supported range.');
  }
  const periodStartBS = await bsDateOrThrow(from, client);
  const periodEndBS = await bsDateOrThrow(to, client);

  const existing = (await client.query(BANK_SESSION_BY_ACCOUNT_PERIOD_FOR_UPDATE_SQL, [
    account.accountId,
    from,
    to,
  ])).rows[0] as BankReconciliationSessionRow | undefined;
  if (existing?.status === 'LOCKED') {
    throw new ApiError(409, 'The reconciliation period is locked. Reopen it before changing the statement balances.');
  }
  const overlap = (await client.query(BANK_SESSION_OVERLAP_SQL, [
    account.accountId,
    from,
    to,
    existing?.id || null,
  ])).rows[0];
  if (overlap) throw new ApiError(409, 'Another reconciliation session overlaps this period.');

  let id: string;
  if (existing) {
    id = String(existing.id);
    await client.query(BANK_SESSION_UPDATE_SQL, [id, opening, closing]);
  } else {
    id = `bkr-${crypto.randomUUID()}`;
    await client.query(BANK_SESSION_INSERT_SQL, [
      id,
      account.accountId,
      from,
      to,
      periodStartBS,
      periodEndBS,
      opening,
      closing,
      input.actor,
    ]);
  }
  return readSessionById(client, id);
}

export async function lockBankReconciliationSession(
  client: AccountingClient,
  input: { sessionId: unknown; actor: string | null }
): Promise<{ session: BankReconciliationSession; changed: boolean }> {
  const sessionId = text(input.sessionId, 60);
  if (!sessionId) throw new ApiError(400, 'A reconciliation session is required.');
  const row = (await client.query(BANK_SESSION_BY_ID_FOR_UPDATE_SQL, [sessionId])).rows[0] as
    | BankReconciliationSessionRow
    | undefined;
  if (!row) throw new ApiError(404, 'Reconciliation session not found.');
  if (row.status === 'LOCKED') {
    return { session: toSession(row), changed: false };
  }
  await client.query(BANK_SESSION_LOCK_SQL, [sessionId, input.actor]);
  return { session: await readSessionById(client, sessionId), changed: true };
}

export async function reopenBankReconciliationSession(
  client: AccountingClient,
  input: { sessionId: unknown; reason: unknown; actor: string | null }
): Promise<{ session: BankReconciliationSession; reason: string }> {
  const sessionId = text(input.sessionId, 60);
  if (!sessionId) throw new ApiError(400, 'A reconciliation session is required.');
  const reason = text(input.reason, 500);
  if (reason.length < 3) throw new ApiError(400, 'A reopen reason of at least 3 characters is required.');
  const row = (await client.query(BANK_SESSION_BY_ID_FOR_UPDATE_SQL, [sessionId])).rows[0] as
    | BankReconciliationSessionRow
    | undefined;
  if (!row) throw new ApiError(404, 'Reconciliation session not found.');
  if (row.status !== 'LOCKED') throw new ApiError(409, 'That reconciliation period is not locked.');
  await client.query(BANK_SESSION_REOPEN_SQL, [sessionId, input.actor, reason]);
  return { session: await readSessionById(client, sessionId), reason };
}
