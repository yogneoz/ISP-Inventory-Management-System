/**
 * LEND-1 client API — lender master, loan register and lender statement.
 *
 * Kept out of the eagerly imported accounting barrel on purpose: only the lazy
 * Lenders screen and the lazy voucher-entry screen use these calls, so their
 * code belongs in a screen chunk rather than the startup graph.
 */
import { fetchJson, getActiveBranchId } from './http';

export type LenderType = 'OWNER' | 'RELATED_PARTY' | 'OTHER';
export type LoanStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';
export type LoanRepaymentFrequency = 'LUMP_SUM' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'ANNUAL';
export type TdsExemptionReason =
  | 'RESIDENT_BANK'
  | 'RESIDENT_FI'
  | 'INTER_COOP'
  | 'NO_INTEREST'
  | 'TREATY'
  | 'EXEMPT_INCOME'
  | 'OTHER';
export type TdsStatus = 'WITHHELD' | 'EXEMPT' | 'UNEXPLAINED' | 'NO_INTEREST';

export interface LenderOption {
  id: string;
  name: string;
  code: string;
}

export interface LenderRecord {
  id: string;
  code: string;
  name: string;
  lenderType: LenderType;
  panNumber: string | null;
  registrationNumber: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  defaultCashAccountId: string | null;
  defaultInterestAccountId: string | null;
  defaultTdsAccountId: string | null;
  defaultLoanAccountId: string | null;
  active: boolean;
  bookId: string | null;
  bookCode: string | null;
  loanCount: number;
  openPrincipal: number;
  bookBalance: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface LenderInput {
  code?: string;
  name: string;
  lenderType: LenderType;
  panNumber?: string | null;
  registrationNumber?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  defaultCashAccountId?: string | null;
  defaultInterestAccountId?: string | null;
  defaultTdsAccountId?: string | null;
  defaultLoanAccountId?: string | null;
  active?: boolean;
}

export interface LoanRecord {
  id: string;
  loanNumber: string;
  lenderId: string;
  lenderCode: string;
  lenderName: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  principal: number;
  interestRate: number;
  startDateAD: string;
  startDateBS: string;
  maturityDateAD: string | null;
  maturityDateBS: string | null;
  repaymentFrequency: LoanRepaymentFrequency;
  installmentAmount: number | null;
  securityType: 'UNSECURED' | 'SECURED';
  status: LoanStatus;
  agreementReference: string | null;
  notes: string | null;
  tdsApplicable: boolean;
  tdsExemptionReason: TdsExemptionReason | null;
  tdsExemptionReference: string | null;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  fundedPrincipal: number;
  repaidPrincipal: number;
  outstandingPrincipal: number;
  interestPaid: number;
  tdsWithheld: number;
  interestAccrued: number;
  lastTransactionDateAD: string | null;
  lastAccrualDateAD: string | null;
  installmentCount: number;
  nextDueDateAD: string | null;
  nextDueAmount: number | null;
  overdueInstallments: number;
  scheduledPrincipal: number;
  scheduledPrincipalPaid: number;
  scheduledInterest: number;
  scheduledInterestPaid: number;
  overdue: boolean;
}

export interface LoanInput {
  lenderId: string;
  branchId: string;
  principal: number;
  interestRate: number;
  startDateAD: string;
  maturityDateAD?: string | null;
  repaymentFrequency: LoanRepaymentFrequency;
  installmentAmount?: number | null;
  securityType: 'UNSECURED' | 'SECURED';
  status: LoanStatus;
  agreementReference?: string | null;
  notes?: string | null;
  tdsApplicable?: boolean;
  tdsExemptionReason?: TdsExemptionReason | null;
  tdsExemptionReference?: string | null;
}

export interface LenderStatementEntry {
  id: string;
  journalId: string;
  journalNo: string;
  dateAD: string;
  dateBS: string | null;
  memo: string;
  debit: number;
  credit: number;
  balance: number;
  branchId: string;
  partyId: string | null;
  partyName: string | null;
}

export interface LoanTransaction {
  id: string;
  txnNumber: string;
  loanId: string;
  lenderId: string;
  branchId: string;
  txnType: 'RECEIPT' | 'REPAYMENT';
  txnDateAD: string;
  txnDateBS: string;
  principalAmount: number;
  interestAmount: number;
  tdsAmount: number;
  interestPayableApplied: number;
  tdsExemptionReason: TdsExemptionReason | null;
  tdsExemptionReference: string | null;
  cashAmount: number;
  cashAccountId: string;
  interestAccountId: string | null;
  tdsAccountId: string | null;
  chequeNo: string | null;
  referenceNo: string | null;
  notes: string | null;
  journalId: string;
  journalNo: string;
  journalStatus: string;
  createdBy?: string | null;
  createdAt?: string;
}

export interface LoanReceiptInput {
  dateAD?: string;
  principal?: number;
  cashAccountId?: string;
  chequeNo?: string | null;
  chequeDateAD?: string | null;
  referenceNo?: string | null;
  notes?: string | null;
}

export interface LoanInstallment {
  id: string;
  loanId: string;
  sequenceNumber: number;
  dueDateAD: string;
  dueDateBS: string;
  principalDue: number;
  interestDue: number;
  principalPaid: number;
  interestPaid: number;
  tdsPaid: number;
  outstanding: number;
  overdue: boolean;
  status: 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';
}

export interface LoanInterestAccrual {
  id: string;
  accrualNumber: string;
  loanId: string;
  lenderId: string;
  branchId: string;
  fromDateAD: string;
  fromDateBS: string;
  toDateAD: string;
  toDateBS: string;
  principalBase: number;
  annualRate: number;
  days: number;
  interestAmount: number;
  journalId: string;
  journalNo: string;
  journalStatus: string;
  createdBy?: string | null;
  createdAt?: string;
}

export interface LoanInterestAccrualInput {
  fromAD?: string;
  toAD?: string;
}

export interface LoanDetail {
  loan: LoanRecord;
  transactions: LoanTransaction[];
  installments: LoanInstallment[];
  accruals: LoanInterestAccrual[];
}

export interface LoanTdsEntry {
  id: string;
  txnNumber: string;
  dateAD: string;
  dateBS: string;
  principalAmount: number;
  interestAmount: number;
  tdsAmount: number;
  cashAmount: number;
  tdsStatus: TdsStatus;
  exemptionReason: TdsExemptionReason | null;
  exemptionReference: string | null;
  loanNumber: string;
  journalNo: string;
}

export interface LenderTdsWorklistEntry {
  id: string;
  txnNumber: string;
  dateAD: string;
  dateBS: string;
  principalAmount: number;
  interestAmount: number;
  tdsAmount: number;
  cashAmount: number;
  loanId: string;
  loanNumber: string;
  lenderId: string;
  lenderCode: string;
  lenderName: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  journalNo: string;
  referenceNo: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface LenderTdsWorklist {
  from: string | null;
  to: string | null;
  branchId: string;
  entries: LenderTdsWorklistEntry[];
  totals: { count: number; principal: number; interest: number; cash: number };
}

export interface LenderTdsEvidenceInput {
  tdsExemptionReason: TdsExemptionReason;
  tdsExemptionReference: string;
}

export interface LoanRepaymentInput {
  dateAD?: string;
  principal?: number;
  interestAmount?: number;
  tdsAmount?: number;
  cashAccountId?: string;
  interestAccountId?: string;
  tdsAccountId?: string;
  tdsExemptionReason?: TdsExemptionReason | null;
  tdsExemptionReference?: string | null;
  chequeNo?: string | null;
  chequeDateAD?: string | null;
  referenceNo?: string | null;
  notes?: string | null;
}

export interface LenderStatement {
  lender: LenderRecord;
  book: { id: string; code: string; name: string } | null;
  control: { accountId: string; accountCode: string; accountName: string } | null;
  from: string | null;
  to: string | null;
  branchId: string;
  openingBalance: number;
  entries: LenderStatementEntry[];
  totals: { debit: number; credit: number; closingBalance: number };
  loans: LoanRecord[];
  tdsEntries: LoanTdsEntry[];
  tdsTotals: {
    principal: number;
    interest: number;
    tds: number;
    cash: number;
    withheldInterest: number;
    withheldTax: number;
    exemptInterest: number;
    unexplainedInterest: number;
    noInterestPrincipal: number;
    withheldCount: number;
    exemptCount: number;
    unexplainedCount: number;
    noInterestCount: number;
    ledgerPrincipal: number;
    ledgerInterest: number;
    ledgerTds: number;
    ledgerCash: number;
    principalDifference: number;
    interestDifference: number;
    tdsDifference: number;
    cashDifference: number;
    reconciled: boolean;
  };
  tieOut: {
    glBalance: number;
    subledgerBalance: number;
    lenderBooksBalance: number;
    unassignedLenderBalance: number;
    difference: number;
    booksDifference: number;
    status: 'RECONCILED' | 'DIFFERENCE';
  };
}

export async function getLenderOptions(): Promise<LenderOption[]> {
  return fetchJson('/api/accounting/lenders/options');
}

export async function getLenders(includeInactive = true, q = ''): Promise<LenderRecord[]> {
  const params = new URLSearchParams();
  if (includeInactive) params.set('includeInactive', '1');
  if (q.trim()) params.set('q', q.trim());
  const suffix = params.toString();
  return fetchJson(`/api/accounting/lenders${suffix ? `?${suffix}` : ''}`);
}

export async function createLender(input: LenderInput): Promise<LenderRecord> {
  return fetchJson('/api/accounting/lenders', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateLender(id: string, input: Partial<LenderInput>): Promise<LenderRecord> {
  return fetchJson(`/api/accounting/lenders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteLender(id: string): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/accounting/lenders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getLoans(
  query: { lenderId?: string; status?: LoanStatus; overdue?: boolean } = {}
): Promise<LoanRecord[]> {
  const params = new URLSearchParams();
  if (query.lenderId) params.set('lenderId', query.lenderId);
  if (query.status) params.set('status', query.status);
  if (query.overdue) params.set('overdue', '1');
  const branchId = getActiveBranchId();
  if (branchId) params.set('branchId', branchId);
  const suffix = params.toString();
  return fetchJson(`/api/accounting/loans${suffix ? `?${suffix}` : ''}`);
}

export async function getLoan(id: string): Promise<LoanDetail> {
  return fetchJson(`/api/accounting/loans/${encodeURIComponent(id)}`);
}

export async function getLoanTransactions(id: string): Promise<LoanTransaction[]> {
  return fetchJson(`/api/accounting/loans/${encodeURIComponent(id)}/transactions`);
}

export async function recordLoanReceipt(
  id: string,
  input: LoanReceiptInput
): Promise<{ transaction: LoanTransaction; loan: LoanRecord }> {
  return fetchJson(`/api/accounting/loans/${encodeURIComponent(id)}/receipts`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function recordLoanRepayment(
  id: string,
  input: LoanRepaymentInput
): Promise<{ transaction: LoanTransaction; loan: LoanRecord }> {
  return fetchJson(`/api/accounting/loans/${encodeURIComponent(id)}/repayments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function recordLoanInterestAccrual(
  id: string,
  input: LoanInterestAccrualInput = {}
): Promise<{ accrual: LoanInterestAccrual; loan: LoanRecord }> {
  return fetchJson(`/api/accounting/loans/${encodeURIComponent(id)}/interest-accruals`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createLoan(input: LoanInput): Promise<LoanRecord> {
  return fetchJson('/api/accounting/loans', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateLoan(id: string, input: Partial<LoanInput>): Promise<LoanRecord> {
  return fetchJson(`/api/accounting/loans/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function getLenderTdsWorklist(
  query: { from?: string; to?: string; branchId?: string } = {}
): Promise<LenderTdsWorklist> {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  const branchId = query.branchId && query.branchId !== 'ALL' ? query.branchId : getActiveBranchId();
  if (branchId) params.set('branchId', branchId);
  const suffix = params.toString();
  return fetchJson(`/api/accounting/lenders/tds-worklist${suffix ? `?${suffix}` : ''}`);
}

export async function recordLenderTdsEvidence(
  id: string,
  input: LenderTdsEvidenceInput
): Promise<{ entry: LoanTransaction & { loanNumber?: string }; tdsStatus: TdsStatus }> {
  return fetchJson(`/api/accounting/lenders/tds-worklist/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function getLenderStatement(
  id: string,
  query: { from?: string; to?: string; branchId?: string } = {}
): Promise<LenderStatement> {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  const branchId = query.branchId && query.branchId !== 'ALL' ? query.branchId : getActiveBranchId();
  if (branchId) params.set('branchId', branchId);
  const suffix = params.toString();
  return fetchJson(
    `/api/accounting/lenders/${encodeURIComponent(id)}/statement${suffix ? `?${suffix}` : ''}`
  );
}
