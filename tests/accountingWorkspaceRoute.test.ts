/**
 * Accounting Workspace — mounted route test.
 *
 * Mounts the REAL App with its providers and a stubbed api, opens the
 * `/finance/accounting` workspace the way a signed-in accountant would, and
 * proves the screen renders what the accounting endpoints return. It also
 * switches branch and as-of date (the new scope must reach the endpoints) and
 * checks that a role without `gl-view` is refused rather than shown an empty
 * ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '../client/src/types';
import type {
  AccountingAccount,
  AccountingGroup,
  AgingResponse,
  BalanceSheetResponse,
  BankReconciliationResponse,
  CashBookResponse,
  CashFlowForecastBucket,
  CashFlowForecastResponse,
  CashFlowResponse,
  ControlReconciliationResponse,
  ProfitAndLossResponse,
  StatementGroupLinesResponse,
  SettlementAccount,
  StatementQuery,
  TrialBalanceAccountLinesResponse,
  TrialBalanceGroupLinesResponse,
  TrialBalanceResponse,
  WalletReconciliationResponse,
} from '../client/src/services/api/accounting';
import { localTodayAD } from '../client/src/utils/localDate';
import { clearRecentBootstrapCache } from '../client/src/utils/sessionCache';
import { formatNPR } from '../client/src/utils/nprFormat';
import { inAct } from './harness/mount';
import {
  bootstrapFixture,
  installApiStubs,
  installEventSource,
  mountAppRouteTree,
  seedSession,
  setInputValue,
  settle,
  settleUntil,
} from './harness/appRouteTreeProbe';

const accountant = {
  id: 'u-accountant',
  name: 'Asha Accountant',
  email: 'accountant@example.com',
  role: 'ACCOUNTANT',
  branchId: 'ALL',
  isActive: true,
} as unknown as User;

const branchManager = {
  id: 'u-branch-manager',
  name: 'Bikash Branch Manager',
  email: 'manager@example.com',
  role: 'BRANCH_MANAGER',
  branchId: 'WH001',
  isActive: true,
} as unknown as User;

const branchAccountant = {
  ...accountant,
  id: 'u-branch-accountant',
  name: 'Asha Branch Accountant',
  email: 'branch-accountant@example.com',
  branchId: 'WH001',
} as unknown as User;

const BRANCHES = [
  { id: 'ALL', code: 'ALL', name: 'All Branches (Consolidated)', address: '', active: true },
  { id: 'WH001', code: 'WH001', name: 'Warehouse', address: 'Kathmandu', active: true },
  { id: 'BRH01', code: 'BRH01', name: 'Branch 2', address: 'Pokhara', active: true },
];

const bootstrap = {
  ...bootstrapFixture,
  branches: BRANCHES,
  userPreferences: { activeTab: 'accounting', dateMode: 'AD', theme: 'light' },
};

const bootstrapWithTab = (activeTab: string) => ({
  ...bootstrap,
  userPreferences: { ...bootstrap.userPreferences, activeTab },
});

const groups: AccountingGroup[] = [
  {
    id: 'g-ca',
    parentId: null,
    code: 'CA',
    name: 'Current Assets',
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
    sortOrder: 10,
    isActive: true,
    isDemo: false,
  },
  {
    id: 'g-cash',
    parentId: 'g-ca',
    code: 'CASH',
    name: 'Cash & Bank',
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
    sortOrder: 11,
    isActive: true,
    isDemo: false,
  },
  {
    id: 'g-rev',
    parentId: null,
    code: 'REV',
    name: 'Trading Revenue',
    accountType: 'INCOME',
    statementGroup: 'REVENUE',
    normalBalance: 'CREDIT',
    sortOrder: 40,
    isActive: true,
    isDemo: false,
  },
];

const accounts: AccountingAccount[] = [
  {
    id: 'a-ar',
    code: '1100',
    name: 'Accounts Receivable',
    groupId: 'g-ca',
    description: null,
    isControl: true,
    subledgerType: 'CUSTOMER',
    postingRole: 'AR',
    isActive: true,
    isDemo: false,
    groupCode: 'CA',
    groupName: 'Current Assets',
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
  },
  {
    id: 'a-cash',
    code: '1010',
    name: 'Cash in Hand',
    groupId: 'g-ca',
    description: null,
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'CASH',
    isActive: true,
    isDemo: false,
    groupCode: 'CA',
    groupName: 'Current Assets',
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
  },
  {
    id: 'a-rev',
    code: '4000',
    name: 'Sales Revenue',
    groupId: 'g-rev',
    description: null,
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'SALES_REVENUE',
    isActive: true,
    isDemo: false,
    groupCode: 'REV',
    groupName: 'Trading Revenue',
    accountType: 'INCOME',
    statementGroup: 'REVENUE',
    normalBalance: 'CREDIT',
  },
];

function trialBalance(branchId = 'ALL', to = '2026-11-02', receivable = 11300): TrialBalanceResponse {
  return {
    statement: 'TRIAL_BALANCE',
    branchId,
    from: '2026-07-17',
    to,
    sections: [],
    groups: [
      {
        groupId: 'g-ca',
        code: 'CA',
        name: 'Current Assets',
        parentGroupId: null,
        sortOrder: 10,
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: receivable,
        periodCredit: 0,
        closingDebit: receivable,
        closingCredit: 0,
        accounts: [],
        children: [
          {
            groupId: 'g-cash',
            code: 'CASH',
            name: 'Cash & Bank',
            parentGroupId: 'g-ca',
            sortOrder: 11,
            openingDebit: 0,
            openingCredit: 0,
            periodDebit: receivable,
            periodCredit: 0,
            closingDebit: receivable,
            closingCredit: 0,
            accounts: [
              {
                accountId: 'a-ar',
                code: '1100',
                name: 'Accounts Receivable',
                groupCode: 'CASH',
                groupName: 'Cash & Bank',
                accountType: 'ASSET',
                statementGroup: 'CURRENT_ASSET',
                subledgerType: 'CUSTOMER',
                openingBalance: 0,
                openingDebit: 0,
                openingCredit: 0,
                periodDebit: receivable,
                periodCredit: 0,
                closingBalance: receivable,
                closingDebit: receivable,
                closingCredit: 0,
              },
            ],
            children: [],
          },
        ],
      },
    ],
    accounts: [
      {
        accountId: 'a-ar',
        code: '1100',
        name: 'Accounts Receivable',
        groupCode: 'CASH',
        groupName: 'Cash & Bank',
        accountType: 'ASSET',
        statementGroup: 'CURRENT_ASSET',
        subledgerType: 'CUSTOMER',
        openingBalance: 0,
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: receivable,
        periodCredit: 0,
        closingBalance: receivable,
        closingDebit: receivable,
        closingCredit: 0,
      },
    ],
    totals: {
      openingDebit: 0,
      openingCredit: 0,
      periodDebit: receivable,
      periodCredit: 0,
      closingDebit: receivable,
      closingCredit: 0,
    },
    balanced: true,
    controls: [
      {
        accountId: 'a-ar',
        code: '1100',
        name: 'Accounts Receivable',
        subledgerType: 'CUSTOMER',
        glBalance: receivable,
        subledgerBalance: receivable,
        difference: 0,
        status: 'RECONCILED',
      },
    ],
    controlsReconciled: true,
  };
}

const profitAndLoss: ProfitAndLossResponse = {
  statement: 'PROFIT_AND_LOSS',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  sections: [
    {
      statementGroup: 'REVENUE',
      label: 'Revenue',
      amount: 10000,
      groups: [
        {
          groupId: 'g-rev',
          parentGroupId: null,
          groupCode: 'REV',
          groupName: 'Trading Revenue',
          sortOrder: 40,
          amount: 10000,
          accounts: [
            { accountId: 'a-rev', code: '4000', name: 'Sales Revenue', groupCode: 'REV', groupName: 'Trading Revenue', amount: 6000 },
          ],
          children: [
            {
              groupId: 'g-rev-retail',
              parentGroupId: 'g-rev',
              groupCode: 'REV-SUB',
              groupName: 'Retail Revenue',
              sortOrder: 41,
              amount: 4000,
              accounts: [
                { accountId: 'a-rev-retail', code: '4010', name: 'Counter Sales', groupCode: 'REV-SUB', groupName: 'Retail Revenue', amount: 4000 },
              ],
              children: [],
            },
          ],
        },
      ],
    },
  ],
  revenue: 10000,
  otherIncome: 0,
  totalIncome: 10000,
  costOfSales: 4000,
  operatingExpense: 1000,
  otherExpense: 0,
  totalExpenses: 5000,
  grossProfit: 6000,
  netProfit: 5000,
};

const profitGroupLines: StatementGroupLinesResponse = {
  statement: 'PROFIT_AND_LOSS',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  group: {
    groupId: 'g-rev',
    parentGroupId: null,
    groupCode: 'REV',
    groupName: 'Trading Revenue',
    sortOrder: 40,
    accountType: 'INCOME',
    statementGroup: 'REVENUE',
    amount: 10000,
  },
  entries: [
    {
      id: 'jl-rev-1',
      journalId: 'j-rev-1',
      journalNo: 'JV-0001',
      journalDateAD: '2026-10-05',
      sourceType: 'SALES_INVOICE',
      sourceId: 'si-1',
      branchId: 'WH001',
      accountId: 'a-rev',
      accountCode: '4000',
      accountName: 'Sales Revenue',
      lineNo: 2,
      memo: 'Counter sales',
      journalMemo: 'Sales invoice SI-1',
      debit: 0,
      credit: 6000,
      amount: 6000,
    },
    {
      id: 'jl-rev-2',
      journalId: 'j-rev-2',
      journalNo: 'JV-0002',
      journalDateAD: '2026-10-06',
      sourceType: 'MANUAL',
      sourceId: 'mj-2',
      branchId: 'WH001',
      accountId: 'a-rev-retail',
      accountCode: '4010',
      accountName: 'Counter Sales',
      lineNo: 1,
      memo: 'Retail counter',
      journalMemo: null,
      debit: 0,
      credit: 4000,
      amount: 4000,
    },
  ],
  totals: { debit: 0, credit: 10000, amount: 10000, entryCount: 2 },
  truncated: false,
  limit: 500,
};

const balanceGroupLines: StatementGroupLinesResponse = {
  statement: 'BALANCE_SHEET',
  branchId: 'ALL',
  from: null,
  to: '2026-11-02',
  group: {
    groupId: 'g-ca',
    parentGroupId: null,
    groupCode: 'CA',
    groupName: 'Current Assets',
    sortOrder: 10,
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    amount: 50000,
  },
  entries: [
    {
      id: 'jl-ca-1',
      journalId: 'j-ca-1',
      journalNo: 'JV-0100',
      journalDateAD: '2026-07-17',
      sourceType: 'OPENING_BALANCE',
      sourceId: 'ob-1',
      branchId: 'WH001',
      accountId: 'a-ar',
      accountCode: '1100',
      accountName: 'Accounts Receivable',
      lineNo: 1,
      memo: 'Opening balance',
      journalMemo: 'Opening balances',
      debit: 50000,
      credit: 0,
      amount: 50000,
    },
  ],
  totals: { debit: 50000, credit: 0, amount: 50000, entryCount: 1 },
  truncated: false,
  limit: 500,
};

const trialBalanceGroupLines: TrialBalanceGroupLinesResponse = {
  statement: 'TRIAL_BALANCE',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  group: {
    groupId: 'g-ca',
    parentGroupId: null,
    groupCode: 'CA',
    groupName: 'Current Assets',
    sortOrder: 10,
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: 11300,
    periodCredit: 0,
    closingDebit: 11300,
    closingCredit: 0,
  },
  entries: [
    {
      id: 'jl-ar-1',
      journalId: 'j-ar-1',
      journalNo: 'JV-0200',
      journalDateAD: '2026-10-05',
      sourceType: 'SALES_INVOICE',
      sourceId: 'si-1',
      branchId: 'WH001',
      accountId: 'a-ar',
      accountCode: '1100',
      accountName: 'Accounts Receivable',
      lineNo: 1,
      memo: 'Customer invoice',
      journalMemo: 'Sales invoice SI-1',
      debit: 11300,
      credit: 0,
      window: 'PERIOD',
    },
  ],
  totals: {
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: 11300,
    periodCredit: 0,
    closingDebit: 11300,
    closingCredit: 0,
    openingEntryCount: 0,
    periodEntryCount: 1,
    entryCount: 1,
  },
  truncated: false,
  limit: 500,
};

const trialBalanceAccountLines: TrialBalanceAccountLinesResponse = {
  statement: 'TRIAL_BALANCE',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  account: {
    accountId: 'a-ar',
    code: '1100',
    name: 'Accounts Receivable',
    groupCode: 'CASH',
    groupName: 'Cash & Bank',
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    subledgerType: 'CUSTOMER',
    openingBalance: 0,
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: 11300,
    periodCredit: 0,
    closingBalance: 11300,
    closingDebit: 11300,
    closingCredit: 0,
  },
  entries: [
    {
      ...trialBalanceGroupLines.entries[0],
      runningBalance: 11300,
    },
  ],
  totals: trialBalanceGroupLines.totals,
  truncated: false,
  limit: 500,
};

const balanceSheet: BalanceSheetResponse = {
  statement: 'BALANCE_SHEET',
  branchId: 'ALL',
  from: null,
  asOf: '2026-11-02',
  assets: {
    sections: [
      {
        statementGroup: 'CURRENT_ASSET',
        label: 'Current assets',
        amount: 50000,
        groups: [
          {
            groupId: 'g-ca',
            parentGroupId: null,
            groupCode: 'CA',
            groupName: 'Current Assets',
            sortOrder: 10,
            amount: 50000,
            accounts: [],
            children: [],
          },
        ],
      },
    ],
    total: 50000,
  },
  liabilities: { sections: [], total: 10000 },
  equity: { sections: [], postedTotal: 20000, currentEarnings: 20000, total: 40000 },
  totalAssets: 50000,
  cashAndBank: 1300,
  totalLiabilities: 10000,
  totalEquity: 40000,
  totalLiabilitiesAndEquity: 50000,
  difference: 0,
  balanced: true,
  interBranch: { dueFromHeadOffice: 0, dueToHeadOffice: 0 },
};

const cashBook: CashBookResponse = {
  book: 'CASH_BANK',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  accounts: [
    {
      accountId: 'a-cash',
      code: '1010',
      name: 'Cash in Hand',
      postingRole: 'CASH',
      isActive: true,
      opening: 1000,
      receipts: 500,
      payments: 200,
      closing: 1300,
      branchReceipts: 500,
      branchPayments: 200,
      branchMovement: 300,
      entries: [
        {
          journalDateAD: '2026-10-05',
          journalNo: 'JV-0001',
          journalId: 'j-cash-1',
          sourceType: 'CUSTOMER_PAYMENT',
          sourceId: 'cp-1',
          branchId: 'WH001',
          memo: 'Customer receipt',
          debit: 500,
          credit: 0,
          type: 'RECEIPT',
          balance: 1500,
        },
      ],
    },
  ],
  opening: 1000,
  receipts: 500,
  payments: 200,
  closing: 1300,
  branchReceipts: 500,
  branchPayments: 200,
  branchMovement: 300,
};

const bankReconciliation: BankReconciliationResponse = {
  from: '2026-11-01',
  to: '2026-11-02',
  accounts: [
    {
      accountId: 'a-bank',
      code: '1020',
      name: 'Nabil Bank',
      bankName: 'Nabil Bank',
      bankBranch: 'Kathmandu',
      accountNumber: '0123456789',
      accountHolder: 'Smoke Test Networks',
      isActive: true,
    },
  ],
  account: {
    accountId: 'a-bank',
    code: '1020',
    name: 'Nabil Bank',
    bankName: 'Nabil Bank',
    bankBranch: 'Kathmandu',
    accountNumber: '0123456789',
    accountHolder: 'Smoke Test Networks',
    isActive: true,
  },
  session: null,
  statement: {
    openingBalance: 0,
    closingBalance: 5000,
    movement: 5000,
    lineCount: 2,
    matchedCount: 1,
    unmatchedCount: 1,
    unmatchedAmount: 5000,
  },
  book: {
    openingBalance: 0,
    closingBalance: 4800,
    movement: 4800,
    lineCount: 2,
    entries: [
      {
        journalLineId: 'gll-1',
        journalId: 'gj-1',
        journalNo: 'MJ-0001',
        journalDateAD: '2026-11-02',
        sourceType: 'MANUAL',
        sourceId: 'smoke-1',
        journalMemo: 'Customer deposit',
        memo: 'Customer deposit',
        debit: 5000,
        credit: 0,
        amount: 5000,
        branchId: 'WH001',
        branchCode: 'BKRB',
        branchName: 'Bank Reconciliation Branch',
        matchedStatementLineId: null,
      },
      {
        journalLineId: 'gll-2',
        journalId: 'gj-2',
        journalNo: 'MJ-0002',
        journalDateAD: '2026-11-02',
        sourceType: 'MANUAL',
        sourceId: 'smoke-2',
        journalMemo: 'Vendor payment from another branch',
        memo: 'Vendor payment from another branch',
        debit: 0,
        credit: 200,
        amount: -200,
        branchId: 'BRH01',
        branchCode: 'BKRO',
        branchName: 'Bank Reconciliation Other',
        matchedStatementLineId: 'bsl-2',
      },
    ],
    truncated: false,
  },
  difference: 200,
  reconciled: false,
  lines: [
    {
      id: 'bsl-1',
      statementDate: '2026-11-02',
      statementDateBS: '2083-07-17 BS',
      description: 'Customer deposit',
      reference: 'DEP-1',
      amount: 5000,
      importBatchId: 'bksb-1',
      importSource: 'CSV',
      matchedJournalLineId: null,
      matchedAt: null,
      matchedBy: null,
      matchedJournalNo: null,
      matchedJournalDate: null,
      matchedBranchId: null,
      matchedBranchCode: null,
      matchedBranchName: null,
      suggestedJournalLineId: null,
    },
    {
      id: 'bsl-2',
      statementDate: '2026-11-02',
      statementDateBS: '2083-07-17 BS',
      description: 'Vendor payment',
      reference: 'PAY-1',
      amount: -200,
      importBatchId: 'bksb-1',
      importSource: 'CSV',
      matchedJournalLineId: 'gll-2',
      matchedAt: '2026-11-10T09:00:00.000Z',
      matchedBy: 'accountant@example.com',
      matchedJournalNo: 'MJ-0002',
      matchedJournalDate: '2026-11-02',
      matchedBranchId: 'BRH01',
      matchedBranchCode: 'BKRO',
      matchedBranchName: 'Bank Reconciliation Other',
      suggestedJournalLineId: 'gll-2',
    },
  ],
  linesTruncated: false,
};

const walletAccount = {
  accountId: 'a-wallet',
  code: '1030',
  name: 'eSewa Clearing',
  providerCode: 'ESEWA' as const,
  settlementAccountId: 'a-bank',
  branchId: null,
  branchCode: null,
  isActive: true,
};

const walletReconciliation: WalletReconciliationResponse = {
  from: '2026-11-01',
  to: '2026-11-02',
  accounts: [walletAccount],
  account: walletAccount,
  summary: {
    ledgerOpening: 0,
    ledgerReceipts: 1300,
    ledgerSettlements: 1000,
    ledgerClosing: 300,
    grossReceipts: 1300,
    receiptCount: 2,
    settledGross: 1000,
    settlementCount: 1,
    fees: 10,
    netBanked: 990,
    unsettledGross: 300,
    difference: 0,
    reconciled: true,
  },
  pending: [
    {
      id: 'cp-wallet-1',
      paymentNumber: 'CR-WALLET-1',
      customerName: 'Sita Sharma',
      paymentDateAD: '2026-11-02',
      providerCode: 'ESEWA',
      providerTransactionId: 'ESEWA-9911',
      grossAmount: 300,
      feeAmount: 3,
      netAmount: 297,
      settledGross: 0,
      outstandingGross: 300,
    },
  ],
  settlements: [
    {
      id: 'ps-1',
      settlementNumber: 'PS-1',
      customerPaymentId: 'cp-wallet-2',
      paymentNumber: 'CR-WALLET-2',
      customerName: 'Ramesh Thapa',
      bankAccountId: 'a-bank',
      bankAccountCode: '1020',
      settlementDateAD: '2026-11-02',
      grossAmount: 1000,
      feeAmount: 10,
      netAmount: 990,
      providerReference: 'ESEWA-BATCH-1',
      journalId: 'gj-ps-1',
      status: 'POSTED',
    },
  ],
  statement: {
    lineCount: 1,
    matchedCount: 0,
    unmatchedCount: 1,
    unmatchedAmount: 990,
    movement: 990,
  },
  lines: [
    {
      id: 'psl-1',
      statementDate: '2026-11-02',
      statementDateBS: '2083-07-17 BS',
      description: 'eSewa settlement deposit',
      reference: 'ESEWA-BATCH-1',
      amount: 990,
      importBatchId: 'pssb-1',
      importSource: 'CSV',
      matchedSettlementId: null,
      matchedAt: null,
      matchedBy: null,
      matchedSettlementNumber: null,
      matchedSettlementNet: null,
      suggestedSettlementId: 'ps-1',
    },
  ],
  linesTruncated: false,
};

const settlementAccounts: SettlementAccount[] = [
  { id: 'a-wallet', code: '1030', name: 'eSewa Clearing', accountKind: 'WALLET', postingRole: null, providerCode: 'ESEWA' },
  { id: 'a-bank', code: '1020', name: 'Nabil Bank', accountKind: 'BANK', postingRole: 'BANK' },
];

const cashFlow: CashFlowResponse = {
  statement: 'CASH_FLOW',
  method: 'DIRECT',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  openingCash: 1000,
  closingCash: 1200,
  cashBookClosing: 1200,
  netCashFlow: 200,
  classifiedCashFlow: 200,
  difference: 0,
  reconciled: true,
  sections: [
    {
      key: 'OPERATING',
      label: 'Operating activities',
      amount: 500,
      lines: [
        {
          accountId: 'a-rev',
          accountCode: '4000',
          accountName: 'Cash sales',
          groupCode: 'REV',
          groupName: 'Trading Revenue',
          amount: 500,
          journalCount: 2,
        },
      ],
    },
    {
      key: 'INVESTING',
      label: 'Investing activities',
      amount: -300,
      lines: [
        {
          accountId: 'a-fa',
          accountCode: '1500',
          accountName: 'Plant and machinery',
          groupCode: 'NCA',
          groupName: 'Non-current Assets',
          amount: -300,
          journalCount: 1,
        },
      ],
    },
    { key: 'FINANCING', label: 'Financing activities', amount: 0, lines: [] },
  ],
};

const cashFlowForecastBuckets: CashFlowForecastBucket[] = Array.from(
  { length: 13 },
  (_, index) => ({
    key: `W${index + 1}`,
    label: index === 0 ? '03 Nov – 09 Nov' : '10 Nov – 16 Nov',
    fromAD: index === 0 ? '2026-11-03' : '2026-11-10',
    toAD: index === 0 ? '2026-11-09' : '2026-11-16',
    receipts: index === 0 ? 1000 : 0,
    customerCredits: index === 0 ? 100 : 0,
    payments: index === 0 ? 1200 : 0,
    supplierCredits: index === 0 ? 100 : 0,
    recurringInflows: 0,
    recurringOutflows: 0,
    payrollOutflows: 0,
    manualInflows: 0,
    manualOutflows: 0,
    inflows: index === 0 ? 900 : 0,
    outflows: index === 0 ? 1100 : 0,
    netCashFlow: index === 0 ? -200 : 0,
    closingCash: 800,
    belowMinimum: index === 0,
    itemCount: index === 0 ? 5 : 0,
  })
);

const cashFlowForecast: CashFlowForecastResponse = {
  statement: 'CASH_FLOW_FORECAST',
  basis: 'WEEKLY',
  branchId: 'ALL',
  asOf: '2026-11-02',
  weeks: 13,
  minCash: 900,
  openingCash: 1000,
  totalInflows: 900,
  totalOutflows: 1100,
  netCashFlow: -200,
  closingCash: 800,
  minimumClosingCash: 800,
  openingBelowMinimum: false,
  warning: true,
  firstBreach: { bucketKey: 'W1', closingCash: 800 },
  breaches: ['W1'],
  buckets: cashFlowForecastBuckets,
  manualInputs: [],
  items: [
    {
      kind: 'INVOICE',
      source: 'AR',
      direction: 'INFLOW',
      documentId: 'si-1',
      documentNo: 'SI-1',
      partyId: 'c-1',
      partyName: 'Himalayan Traders',
      dueDateAD: '2026-11-05',
      bucketKey: 'W1',
      bucketIndex: 0,
      overdue: false,
      description: 'Customer invoice',
      amount: 1000,
    },
    {
      kind: 'INVOICE',
      source: 'AP',
      direction: 'OUTFLOW',
      documentId: 'pi-1',
      documentNo: 'PI-1',
      partyId: 's-1',
      partyName: 'Everest Supply',
      dueDateAD: '2026-11-06',
      bucketKey: 'W1',
      bucketIndex: 0,
      overdue: false,
      description: 'Supplier bill',
      amount: 1200,
    },
  ],
  ar: {
    grossTotal: 1200,
    unappliedCredit: 100,
    total: 1100,
    controlBalance: 1100,
    difference: 0,
    reconciled: true,
    openItemCount: 3,
    overdueAmount: 100,
  },
  ap: {
    grossTotal: 1200,
    unappliedCredit: 100,
    total: 1100,
    controlBalance: 1100,
    difference: 0,
    reconciled: true,
    openItemCount: 2,
    overdueAmount: 1200,
  },
  sources: {
    recurring: {
      scheduledCount: 0,
      scheduledAmount: 0,
      includedCount: 0,
      includedAmount: 0,
      overdueAmount: 0,
      beyondHorizon: { count: 0, amount: 0 },
      closedPeriodExcluded: { count: 0, amount: 0 },
    },
    payroll: {
      scheduledCount: 0,
      scheduledAmount: 0,
      includedCount: 0,
      includedAmount: 0,
      overdueAmount: 0,
      beyondHorizon: { count: 0, amount: 0 },
      closedPeriodExcluded: { count: 0, amount: 0 },
    },
    manual: {
      scheduledCount: 0,
      scheduledAmount: 0,
      includedCount: 0,
      includedAmount: 0,
      overdueAmount: 0,
      beyondHorizon: { count: 0, amount: 0 },
      closedPeriodExcluded: { count: 0, amount: 0 },
    },
  },
  beyondHorizon: {
    ar: { count: 0, amount: 0 },
    ap: { count: 0, amount: 0 },
    recurring: { count: 0, amount: 0 },
    payroll: { count: 0, amount: 0 },
    manual: { count: 0, amount: 0 },
  },
};

const agingAr: AgingResponse = {
  report: 'AR_AGING',
  type: 'AR',
  asOf: '2026-11-02',
  branchId: null,
  account: {
    accountId: 'a-ar',
    code: '1100',
    name: 'Accounts Receivable',
    postingRole: 'AR_CONTROL',
    subledgerType: 'CUSTOMER',
    isActive: true,
  },
  buckets: [
    { key: 'CURRENT', label: 'Not yet due', minDays: null, maxDays: 0, amount: 0 },
    { key: 'DAYS_1_30', label: '1–30 days', minDays: 1, maxDays: 30, amount: 900 },
    { key: 'DAYS_31_60', label: '31–60 days', minDays: 31, maxDays: 60, amount: 250 },
    { key: 'DAYS_61_90', label: '61–90 days', minDays: 61, maxDays: 90, amount: 0 },
    { key: 'DAYS_90_PLUS', label: '90+ days', minDays: 91, maxDays: null, amount: 0 },
  ],
  parties: [
    {
      partyId: 'CUST-A',
      partyName: 'Ada Customer',
      buckets: { CURRENT: 0, DAYS_1_30: 900, DAYS_31_60: 0, DAYS_61_90: 0, DAYS_90_PLUS: 0 },
      grossTotal: 900,
      unappliedCredit: 0,
      total: 900,
      rows: [
        {
          kind: 'INVOICE',
          documentId: 'si-1',
          documentNo: 'AG-AR-1',
          documentDateAD: '2026-10-20',
          dueDateAD: '2026-10-20',
          termsDays: 0,
          daysPastDue: 13,
          bucket: 'DAYS_1_30',
          branchId: 'WH001',
          journalNo: 'MJ-2083-84-00001',
          sourceType: 'SALES_INVOICE',
          description: 'Sales invoice AG-AR-1',
          originalAmount: 900,
          allocatedAmount: 0,
          amount: 900,
        },
      ],
    },
    {
      partyId: 'CUST-B',
      partyName: 'Bimal Customer',
      buckets: { CURRENT: 0, DAYS_1_30: 0, DAYS_31_60: 250, DAYS_61_90: 0, DAYS_90_PLUS: 0 },
      grossTotal: 250,
      unappliedCredit: 0,
      total: 250,
      rows: [],
    },
    {
      partyId: 'CUST-C',
      partyName: 'Chandra Customer',
      buckets: { CURRENT: 0, DAYS_1_30: 0, DAYS_31_60: 0, DAYS_61_90: 0, DAYS_90_PLUS: 0 },
      grossTotal: 0,
      unappliedCredit: 100,
      total: -100,
      rows: [
        {
          kind: 'CREDIT',
          documentId: 'cp-1',
          documentNo: null,
          documentDateAD: '2026-10-25',
          dueDateAD: null,
          termsDays: null,
          daysPastDue: null,
          bucket: null,
          branchId: 'WH001',
          journalNo: 'MJ-2083-84-00009',
          sourceType: 'CUSTOMER_PAYMENT',
          description: 'Receipt CP-1',
          originalAmount: 100,
          allocatedAmount: 0,
          amount: 100,
        },
      ],
    },
  ],
  totals: {
    CURRENT: 0,
    DAYS_1_30: 900,
    DAYS_31_60: 250,
    DAYS_61_90: 0,
    DAYS_90_PLUS: 0,
    grossTotal: 1150,
    unappliedCredit: 100,
    total: 1050,
    controlBalance: 1050,
    difference: 0,
    reconciled: true,
  },
};

const agingAp: AgingResponse = {
  report: 'AP_AGING',
  type: 'AP',
  asOf: '2026-11-02',
  branchId: null,
  account: {
    accountId: 'a-ap',
    code: '2100',
    name: 'Accounts Payable',
    postingRole: 'AP_CONTROL',
    subledgerType: 'SUPPLIER',
    isActive: true,
  },
  buckets: [
    { key: 'CURRENT', label: 'Not yet due', minDays: null, maxDays: 0, amount: 0 },
    { key: 'DAYS_1_30', label: '1–30 days', minDays: 1, maxDays: 30, amount: 0 },
    { key: 'DAYS_31_60', label: '31–60 days', minDays: 31, maxDays: 60, amount: 0 },
    { key: 'DAYS_61_90', label: '61–90 days', minDays: 61, maxDays: 90, amount: 500 },
    { key: 'DAYS_90_PLUS', label: '90+ days', minDays: 91, maxDays: null, amount: 0 },
  ],
  parties: [
    {
      partyId: 'SUP-A',
      partyName: 'Alpha Supplier',
      buckets: { CURRENT: 0, DAYS_1_30: 0, DAYS_31_60: 0, DAYS_61_90: 500, DAYS_90_PLUS: 0 },
      grossTotal: 500,
      unappliedCredit: 0,
      total: 500,
      rows: [],
    },
    {
      partyId: 'SUP-B',
      partyName: 'Beta Supplier',
      buckets: { CURRENT: 0, DAYS_1_30: 0, DAYS_31_60: 0, DAYS_61_90: 0, DAYS_90_PLUS: 0 },
      grossTotal: 0,
      unappliedCredit: 100,
      total: -100,
      rows: [],
    },
  ],
  totals: {
    CURRENT: 0,
    DAYS_1_30: 0,
    DAYS_31_60: 0,
    DAYS_61_90: 500,
    DAYS_90_PLUS: 0,
    grossTotal: 500,
    unappliedCredit: 100,
    total: 400,
    controlBalance: 400,
    difference: 0,
    reconciled: true,
  },
};

const reconciliation: ControlReconciliationResponse = {
  accountId: 'a-ar',
  accountCode: '1100',
  accountName: 'Accounts Receivable',
  subledgerType: 'CUSTOMER',
  branchId: 'ALL',
  glBalance: 11300,
  subledgerBalance: 11300,
  difference: 0,
  status: 'RECONCILED',
  lineCount: 1,
  entryCount: 1,
  parties: [],
};

function text(container: HTMLElement): string {
  return container.textContent || '';
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent || '').includes(label)
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `button "${label}" must be on screen`);
  return button;
}

function buttonByTextOrNull(container: HTMLElement, label: string): HTMLButtonElement | null {
  return ([...container.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent || '').includes(label)
  ) as HTMLButtonElement | undefined) || null;
}

function clickAria(container: HTMLElement, label: string): void {
  const target = container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
  assert.ok(target, `an element labelled "${label}" must be on screen`);
  inAct(() => target.click());
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  inAct(() => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function accountingStubs(overrides: Record<string, unknown> = {}) {
  return {
    getBootstrapState: async () => bootstrap,
    getMyPermissions: async () => ({ role: 'ACCOUNTANT', operations: ['gl-view'], version: 1 }),
    getAccountingGroups: async () => groups,
    getAccountingAccounts: async () => accounts,
    getChartHealth: async () => ({
      missingPostingRoles: [],
      controlAccountsWithoutSubledger: [],
      inactiveAccountsHoldingRole: [],
      unlinkedSubledgerRows: { count: 0, amount: 0, rows: [] },
      totals: {
        accounts: accounts.length,
        controlAccounts: accounts.filter((account) => account.isControl).length,
        subledgers: 1,
        activeSubledgers: 1,
        unlinkedSubledgerRows: 0,
      },
    }),
    getPostingDefaults: async () => ({
      defaults: {
        AR: {
          accountId: 'a-ar',
          accountCode: '1100',
          accountName: 'Accounts Receivable',
          accountType: 'ASSET',
          statementGroup: 'CURRENT_ASSET',
          isControl: true,
          subledgerType: 'CUSTOMER',
        },
        CASH: {
          accountId: 'a-cash',
          accountCode: '1010',
          accountName: 'Cash in Hand',
          accountType: 'ASSET',
          statementGroup: 'CURRENT_ASSET',
          isControl: false,
          subledgerType: 'NONE',
        },
      },
    }),
    getTrialBalance: async () => trialBalance(),
    getProfitAndLoss: async () => profitAndLoss,
    getBalanceSheet: async () => balanceSheet,
    getCashFlow: async () => cashFlow,
    getCashFlowForecast: async () => cashFlowForecast,
    getStatementGroupLines: async () => profitGroupLines,
    getCashBook: async () => cashBook,
    getBankReconciliation: async () => bankReconciliation,
    getSettlementAccounts: async () => settlementAccounts,
    getWalletReconciliation: async () => walletReconciliation,
    getAging: async () => agingAr,
    getControlReconciliation: async () => reconciliation,
    getAccountingBudgetVarianceUtilisation: async () => budgetUtilisation,
    ...overrides,
  };
}

function mountWorkspace(user: User, tab = 'accounting') {
  // Every test opens a different accounting register; a cached bootstrap from
  // the previous mount would restore ITS saved tab over this one.
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession(tab, user);
  const restoreEventSource = installEventSource();
  return { restoreEventSource };
}
test('trial balance register renders the endpoint figures', async () => {
  const restored = mountWorkspace(accountant);
  const restoreApi = installApiStubs(accountingStubs());
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Accounts Receivable')),
      'the trial balance register must render the endpoint rows'
    );
    assert.equal(window.location.pathname, '/finance/accounting', 'Trial Balance owns the accounting path');
    assert.match(text(tree.container), /Debits = Credits/);
    assert.match(text(tree.container), /CA · Current Assets/, 'the top-level group subtotal must be rendered');
    assert.match(text(tree.container), /CASH · Cash & Bank/, 'the sub-group subtotal must be rendered');
    assert.match(text(tree.container), /sub-group/);
    assert.ok(text(tree.container).includes(formatNPR(11300)), 'the trial balance must show the endpoint total');
    assert.match(text(tree.container), /Control accounts/);
    assert.match(text(tree.container), /Reconciled/);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('trial balance register drills into a group and shows opening and period sections', async () => {
  const calls: any[] = [];
  const restored = mountWorkspace(accountant);
  const restoreApi = installApiStubs(
    accountingStubs({
      getTrialBalanceGroupLines: async (query: any) => {
        calls.push(query);
        return trialBalanceGroupLines;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Accounts Receivable')),
      'the trial balance register must load its group rows'
    );

    clickAria(tree.container, 'Open journal lines for CA Current Assets');
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Opening lines')),
      'opening the group must show both halves of the trial balance'
    );
    assert.match(text(tree.container), /Period lines/, 'the period section must render');
    assert.match(
      text(tree.container),
      /No POSTED lines fall before 2026-07-17/,
      'the opening section must say when it has no lines'
    );
    assert.ok(text(tree.container).includes('JV-0200'), 'the posted period line must render');
    assert.ok(text(tree.container).includes('Customer invoice'), 'the line description must render');
    assert.match(text(tree.container), /Ties to trial balance subtotal/);
    assert.deepEqual(calls[0], {
      groupId: 'g-ca',
      branchId: undefined,
      from: '2026-07-17',
      to: '2026-11-02',
      limit: 500,
    });

    clickAria(tree.container, 'Close journal lines');
    assert.ok(
      await settleUntil(() => !text(tree.container).includes('Customer invoice')),
      'closing the panel must return to the trial balance'
    );
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('trial balance register drills into an account and shows its running balance', async () => {
  const calls: any[] = [];
  const restored = mountWorkspace(accountant);
  const restoreApi = installApiStubs(
    accountingStubs({
      getTrialBalanceAccountLines: async (query: any) => {
        calls.push(query);
        return trialBalanceAccountLines;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Accounts Receivable')),
      'the trial balance register must load its account rows'
    );

    clickAria(tree.container, 'Open journal lines for 1100 Accounts Receivable');
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Running balance (Dr − Cr)')),
      'an account drill-down must show the running-balance column'
    );
    assert.match(text(tree.container), /Opening balance b\/f/, 'period lines must carry the opening balance forward');
    assert.ok(text(tree.container).includes('JV-0200'), 'the posted period line must render');
    assert.ok(text(tree.container).includes('Customer invoice'), 'the line description must render');
    assert.match(text(tree.container), /Ties to trial balance account/);
    assert.deepEqual(calls[0], {
      accountId: 'a-ar',
      branchId: undefined,
      from: '2026-07-17',
      to: '2026-11-02',
      limit: 500,
    });

    clickAria(tree.container, 'Close journal lines');
    assert.ok(
      await settleUntil(() => !text(tree.container).includes('Customer invoice')),
      'closing the panel must return to the trial balance'
    );
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('profit and loss register renders the endpoint figures and drills into a group summary', async () => {
  const drilldownCalls: any[] = [];
  const restored = mountWorkspace(accountant, 'accounting-profit-loss');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-profit-loss'),
      getStatementGroupLines: async (query: any) => {
        drilldownCalls.push(query);
        return profitGroupLines;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Statement of profit or loss')),
      'the profit and loss register must load its statement'
    );
    assert.equal(window.location.pathname, '/finance/accounting/profit-loss');
    assert.ok(text(tree.container).includes(formatNPR(10000)), 'total income must match the endpoint');
    assert.ok(text(tree.container).includes(formatNPR(5000)), 'net profit must match the endpoint');
    assert.match(text(tree.container), /REV · Trading Revenue/, 'the root group and its subtotal must render');
    assert.match(text(tree.container), /↳ REV-SUB · Retail Revenue/, 'the sub-group must render indented under its parent');

    clickAria(tree.container, 'Open journal lines for REV Trading Revenue');
    assert.ok(
      await settleUntil(() => text(tree.container).includes('JV-0001')),
      'opening a group must show the posted journal lines from the endpoint'
    );
    assert.match(text(tree.container), /Counter sales/, 'the line description must render');
    assert.ok(text(tree.container).includes(formatNPR(6000)), 'the line amount must match the endpoint');
    assert.match(text(tree.container), /Ties to statement subtotal/, 'the drill-down total must tie out');
    assert.deepEqual(drilldownCalls[0], {
      statement: 'PROFIT_AND_LOSS',
      groupId: 'g-rev',
      branchId: undefined,
      from: '2026-07-17',
      to: '2026-11-02',
      limit: 500,
    });

    clickAria(tree.container, 'Close journal lines');
    assert.ok(
      await settleUntil(() => !text(tree.container).includes('Counter sales')),
      'closing the panel must return to the statement'
    );
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('balance sheet register renders the endpoint figures and drills into a group summary', async () => {
  const drilldownCalls: any[] = [];
  const restored = mountWorkspace(accountant, 'accounting-balance-sheet');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-balance-sheet'),
      getStatementGroupLines: async (query: any) => {
        drilldownCalls.push(query);
        return balanceGroupLines;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Balance sheet balances')),
      'the balance sheet register must load its statement'
    );
    assert.equal(window.location.pathname, '/finance/accounting/balance-sheet');
    assert.ok(text(tree.container).includes(formatNPR(50000)), 'total assets must match the endpoint');
    assert.ok(text(tree.container).includes(formatNPR(1300)), 'cash and bank must match the endpoint');

    clickAria(tree.container, 'Open journal lines for CA Current Assets');
    assert.ok(
      await settleUntil(() => text(tree.container).includes('JV-0100')),
      'opening an asset group must show the posted journal lines from the endpoint'
    );
    assert.match(text(tree.container), /Opening balance/);
    assert.match(text(tree.container), /Ties to statement subtotal/);
    assert.deepEqual(drilldownCalls[0], {
      statement: 'BALANCE_SHEET',
      groupId: 'g-ca',
      branchId: undefined,
      from: undefined,
      to: '2026-11-02',
      limit: 500,
    });
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('cash and bank book register renders the endpoint figures', async () => {
  const restored = mountWorkspace(accountant, 'accounting-cash-book');
  const restoreApi = installApiStubs(
    accountingStubs({ getBootstrapState: async () => bootstrapWithTab('accounting-cash-book') })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Cash in Hand')),
      'the cash book register must render the account rows'
    );
    assert.equal(window.location.pathname, '/finance/accounting/cash-book');
    assert.ok(text(tree.container).includes('JV-0001'), 'the posted journal must be listed');
    assert.ok(text(tree.container).includes(formatNPR(1300)), 'closing balance must match the endpoint');
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('bank reconciliation view imports the company-wide workspace and exports unmatched lines', async () => {
  const calls: any[] = [];
  const restored = mountWorkspace(accountant, 'accounting-cash-book');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-cash-book'),
      getBankReconciliation: async (query: any) => {
        calls.push(query);
        return bankReconciliation;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Cash in Hand')),
      'the cash book view must load before switching tabs'
    );
    inAct(() => buttonByText(tree.container, 'Bank reconciliation').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Statement lines')),
      'the reconciliation tab must load the statement workspace'
    );
    assert.match(text(tree.container), /Company-wide/);
    assert.match(text(tree.container), /Customer deposit/);
    assert.match(text(tree.container), /Vendor payment/);
    assert.match(text(tree.container), /BKRB/);
    assert.match(text(tree.container), /BKRO/);
    assert.match(text(tree.container), /STATEMENT CLOSING/);
    assert.ok(text(tree.container).includes('Export unmatched CSV'));
    assert.equal(calls[0].branchId, undefined, 'reconciliation must not send a branch filter');
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('provider reconciliation view renders clearing, pending receipts and statement matching', async () => {
  const calls: any[] = [];
  const restored = mountWorkspace(accountant, 'accounting-cash-book');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-cash-book'),
      getWalletReconciliation: async (query: any) => {
        calls.push(query);
        return walletReconciliation;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Cash in Hand')),
      'the cash book view must load before switching tabs'
    );
    inAct(() => buttonByText(tree.container, 'Provider reconciliation').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Receipts awaiting settlement')),
      'the provider reconciliation tab must load the settlement workspace'
    );
    assert.match(text(tree.container), /CLEARING BALANCE/);
    assert.match(text(tree.container), /UNSETTLED GROSS/);
    assert.match(text(tree.container), /Sita Sharma/);
    assert.match(text(tree.container), /CR-WALLET-1/);
    assert.match(text(tree.container), /PS-1/);
    assert.match(text(tree.container), /eSewa settlement deposit/);
    assert.ok(text(tree.container).includes('Match'), 'the suggested statement line must expose its match action');
    assert.equal(calls[0].branchId, undefined, 'provider reconciliation must not send a branch filter');
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('cash flow register renders sections, forecast and sends the period start', async () => {
  const calls: StatementQuery[] = [];
  const forecastCalls: Array<{ branchId?: string; asOf?: string; weeks?: number; minCash?: number }> = [];
  const restored = mountWorkspace(accountant, 'accounting-cash-flow');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-cash-flow'),
      getCashFlow: async (query: StatementQuery = {}) => {
        calls.push(query);
        return cashFlow;
      },
      getCashFlowForecast: async (query: any = {}) => {
        forecastCalls.push(query);
        return cashFlowForecast;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Operating activities')),
      'the cash flow sections must load'
    );
    assert.ok(text(tree.container).includes('Plant and machinery'));
    assert.ok(text(tree.container).includes('Ties to cash book'));
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Forward cash-flow forecast')),
      'the forward forecast panel must load'
    );
    assert.ok(text(tree.container).includes('Minimum cash breached'));
    assert.ok(text(tree.container).includes('Himalayan Traders'));
    assert.ok(text(tree.container).includes('Forecast inputs'));
    assert.ok(text(tree.container).includes('Recurring journals'));
    assert.ok(text(tree.container).includes('Payroll commitments'));
    assert.ok(text(tree.container).includes('No manual forecast inputs in this scope.'));
    assert.equal(forecastCalls[0]?.asOf, localTodayAD());
    assert.equal(forecastCalls[0]?.weeks, 13);
    assert.equal(forecastCalls[0]?.minCash, 0);

    const fromInput = tree.container.querySelector(
      'input[aria-label="Accounting period start"]'
    ) as HTMLInputElement | null;
    assert.ok(fromInput, 'the cash flow register must offer a period start');
    setInputValue(fromInput, '2026-07-01');
    assert.ok(
      await settleUntil(() => calls.some((call) => call.from === '2026-07-01')),
      'the period start must reach the cash flow endpoint'
    );
    assert.equal(window.location.pathname, '/finance/accounting/cash-flow');
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('aging register renders buckets and unmatched credits and switches AR/AP', async () => {
  const calls: Array<{ type?: string; branchId?: string; asOf?: string }> = [];
  const restored = mountWorkspace(accountant, 'accounting-aging');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-aging'),
      getAging: async (query: { type?: string; branchId?: string; asOf?: string } = {}) => {
        calls.push(query);
        return query.type === 'AP' ? agingAp : agingAr;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Ada Customer')),
      'the aging register must render the AR party rows'
    );
    assert.equal(window.location.pathname, '/finance/accounting/aging');
    assert.ok(text(tree.container).includes('AG-AR-1'), 'the open invoice must be listed');
    assert.ok(text(tree.container).includes(formatNPR(900)), 'the 1–30 bucket must match the endpoint');
    assert.match(text(tree.container), /Unapplied credit/);
    assert.ok(text(tree.container).includes(formatNPR(100)), 'the unapplied credit must be visible');
    assert.match(text(tree.container), /Ties to control account/);
    assert.ok(text(tree.container).includes(formatNPR(1050)), 'the net receivable must match the endpoint');

    inAct(() => buttonByText(tree.container, 'Payables (AP)').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Alpha Supplier')),
      'switching to AP must render the payable rows'
    );
    assert.ok(text(tree.container).includes(formatNPR(400)), 'the net payable must match the endpoint');
    assert.match(text(tree.container), /Beta Supplier/);
    assert.ok(
      calls.some((call) => call.type === 'AR') && calls.some((call) => call.type === 'AP'),
      'both aging types must come from the endpoint'
    );
    assert.ok(
      calls.every((call) => call.asOf === localTodayAD() && call.branchId === undefined),
      `the shared branch/as-of scope must reach the aging endpoint: ${JSON.stringify(calls)}`
    );
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('chart and defaults register renders accounts, defaults and reconciliation', async () => {
  const restored = mountWorkspace(accountant, 'accounting-chart');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-chart'),
      // The chart is a management screen: its tab is hidden without the
      // operation its maintenance buttons need.
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage'],
        version: 1,
      }),
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Chart of accounts')),
      'the chart register must load the ledger tab'
    );
    assert.equal(window.location.pathname, '/finance/accounting/chart');
    assert.match(text(tree.container), /Groups & Sub-Groups/);
    assert.match(text(tree.container), /Reconciliation Health/);
    assert.match(text(tree.container), /Sales Revenue/);
    assert.match(text(tree.container), /CUSTOMER/);

    inAct(() => buttonByText(tree.container, 'Posting Defaults').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Posting defaults')),
      'the defaults tab must render the posting-role table'
    );
    inAct(() => buttonByText(tree.container, 'Reconciliation Health').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Setup gaps')),
      'the health tab must render the setup gaps and control tie-out'
    );
    assert.match(text(tree.container), /Reconciled/);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('chart maintenance creates, edits, retires and deletes through the mounted screen', async () => {
  const createdGroups: any[] = [];
  const createdAccounts: any[] = [];
  const updates: Array<{ id: string; body: any }> = [];
  const deletes: string[] = [];
  const groupUpdates: Array<{ id: string; body: any }> = [];
  const groupDeletes: string[] = [];
  const emptyGroup = { ...groups[0], id: 'g-empty', code: 'ZZZ', name: 'Empty Group', sortOrder: 99 };
  const restored = mountWorkspace(accountant, 'accounting-chart');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-chart'),
      getMyPermissions: async () => ({ role: 'ACCOUNTANT', operations: ['gl-view', 'gl-chart-manage'], version: 1 }),
      getAccountingGroups: async () => [...groups, emptyGroup],
      updateAccountingGroup: async (id: string, body: any) => {
        groupUpdates.push({ id, body });
        return { ...emptyGroup, ...body };
      },
      deleteAccountingGroup: async (id: string) => {
        groupDeletes.push(id);
        return { deleted: true, id };
      },
      createAccountingGroup: async (input: any) => {
        createdGroups.push(input);
        return { ...groups[0], ...input, id: 'g-new' };
      },
      createAccountingAccount: async (input: any) => {
        createdAccounts.push(input);
        return { ...accounts[0], ...input, id: 'a-new' };
      },
      updateAccountingAccount: async (id: string, body: any) => {
        updates.push({ id, body });
        return { ...accounts[0], ...body };
      },
      deleteAccountingAccount: async (id: string) => {
        deletes.push(id);
        return { deleted: true, id };
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Chart of accounts')),
      'the chart register must load before it can be maintained'
    );
    inAct(() => buttonByText(tree.container, 'Groups & Sub-Groups').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Groups and sub-groups')),
      'group maintenance lives on the group tab'
    );

    // A sub-group and an empty group must both stay reachable.
    assert.match(text(tree.container), /Cash & Bank/);
    assert.match(text(tree.container), /SUB-GROUP/);
    assert.match(text(tree.container), /No accounts or sub-groups in this group/);
    clickAria(tree.container, 'Edit group ZZZ');
    assert.ok(await settleUntil(() => Boolean(tree.container.querySelector('#chart-group-name'))));
    setInputValue(tree.container.querySelector('#chart-group-name') as HTMLInputElement, 'Reserve Group');
    const emptyGroupDialog = tree.container.querySelector('[role="dialog"]') as HTMLElement;
    inAct(() => buttonByText(emptyGroupDialog, 'Save group').click());
    assert.ok(await settleUntil(() => groupUpdates.length === 1), 'editing an empty group must call the endpoint');
    assert.deepEqual(groupUpdates[0], { id: 'g-empty', body: { parentId: null, name: 'Reserve Group', sortOrder: 99 } });

    clickAria(tree.container, 'Delete group ZZZ');
    assert.ok(await settleUntil(() => Boolean(tree.container.querySelector('[role="dialog"]'))));
    const groupConfirm = tree.container.querySelector('[role="dialog"]') as HTMLElement;
    inAct(() => buttonByText(groupConfirm, 'Delete').click());
    assert.ok(await settleUntil(() => groupDeletes.length === 1), 'deleting an empty group must call the endpoint');
    assert.deepEqual(groupDeletes, ['g-empty']);

    inAct(() => buttonByText(tree.container, 'New group').click());
    assert.ok(await settleUntil(() => Boolean(tree.container.querySelector('#chart-group-code'))));
    setInputValue(tree.container.querySelector('#chart-group-code') as HTMLInputElement, 'FA');
    setInputValue(tree.container.querySelector('#chart-group-name') as HTMLInputElement, 'Fixed Assets');
    setSelectValue(tree.container.querySelector('#chart-group-type') as HTMLSelectElement, 'ASSET');
    setSelectValue(tree.container.querySelector('#chart-group-statement') as HTMLSelectElement, 'NON_CURRENT_ASSET');
    const groupDialog = tree.container.querySelector('[role="dialog"]') as HTMLElement;
    inAct(() => buttonByText(groupDialog, 'Create group').click());
    assert.ok(await settleUntil(() => createdGroups.length === 1), 'creating a group must call the endpoint');
    assert.deepEqual(createdGroups[0], {
      parentId: null,
      code: 'FA',
      name: 'Fixed Assets',
      accountType: 'ASSET',
      statementGroup: 'NON_CURRENT_ASSET',
      sortOrder: 0,
    });

    clickAria(tree.container, 'Add sub-group under CA');
    assert.ok(await settleUntil(() => Boolean(tree.container.querySelector('#chart-group-code'))));
    assert.equal(
      (tree.container.querySelector('#chart-group-parent') as HTMLSelectElement).value,
      'g-ca',
      'the parent must be preselected from the group action'
    );
    setInputValue(tree.container.querySelector('#chart-group-code') as HTMLInputElement, 'FA2');
    setInputValue(tree.container.querySelector('#chart-group-name') as HTMLInputElement, 'Vehicles Sub-group');
    const subGroupDialog = tree.container.querySelector('[role="dialog"]') as HTMLElement;
    inAct(() => buttonByText(subGroupDialog, 'Create sub-group').click());
    assert.ok(await settleUntil(() => createdGroups.length === 2), 'creating a sub-group must call the endpoint');
    assert.equal(createdGroups[1].parentId, 'g-ca');
    assert.equal(createdGroups[1].accountType, 'ASSET');
    assert.equal(createdGroups[1].statementGroup, 'CURRENT_ASSET');

    inAct(() => buttonByText(tree.container, 'Ledgers').click());
    assert.ok(await settleUntil(() => text(tree.container).includes('Chart of accounts')));
    inAct(() => buttonByText(tree.container, 'New account').click());
    assert.ok(await settleUntil(() => Boolean(tree.container.querySelector('#chart-account-code'))));
    assert.ok(
      [...tree.container.querySelectorAll('#chart-account-group option')].some((option) =>
        (option.textContent || '').includes('CA / CASH · Cash & Bank')
      ),
      'the account form must show sub-groups under their parent'
    );
    setInputValue(tree.container.querySelector('#chart-account-code') as HTMLInputElement, '1500');
    setInputValue(tree.container.querySelector('#chart-account-name') as HTMLInputElement, 'Delivery Van');
    setSelectValue(tree.container.querySelector('#chart-account-group') as HTMLSelectElement, 'g-rev');
    setSelectValue(tree.container.querySelector('#chart-account-role') as HTMLSelectElement, 'INTER_BRANCH_CLEARING');
    const accountDialog = tree.container.querySelector('[role="dialog"]') as HTMLElement;
    inAct(() => buttonByText(accountDialog, 'Create account').click());
    assert.ok(await settleUntil(() => createdAccounts.length === 1), 'creating an account must call the endpoint');
    assert.equal(createdAccounts[0].code, '1500');
    assert.equal(createdAccounts[0].name, 'Delivery Van');
    assert.equal(createdAccounts[0].groupId, 'g-rev');
    assert.equal(createdAccounts[0].postingRole, 'INTER_BRANCH_CLEARING');

    clickAria(tree.container, 'Edit account 1100');
    assert.ok(await settleUntil(() => Boolean(tree.container.querySelector('#chart-account-name'))));
    assert.match(
      text(tree.container.querySelector('[role="dialog"]') as HTMLElement),
      /same account type, statement group and normal balance/i,
      'the account form must explain the same-nature move rule'
    );
    setInputValue(tree.container.querySelector('#chart-account-name') as HTMLInputElement, 'Trade Receivables');
    const editDialog = tree.container.querySelector('[role="dialog"]') as HTMLElement;
    inAct(() => buttonByText(editDialog, 'Save account').click());
    assert.ok(await settleUntil(() => updates.length === 1), 'editing an account must call the endpoint');
    assert.equal(updates[0].id, 'a-ar');
    assert.equal(updates[0].body.name, 'Trade Receivables');
    assert.equal(updates[0].body.groupId, 'g-ca');
    assert.equal(updates[0].body.postingRole, 'AR');

    clickAria(tree.container, 'Deactivate account 1100');
    assert.ok(await settleUntil(() => updates.length === 2), 'retiring an account must call the endpoint');
    assert.deepEqual(updates[1], { id: 'a-ar', body: { isActive: false } });

    clickAria(tree.container, 'Delete account 1100');
    assert.ok(await settleUntil(() => Boolean(tree.container.querySelector('[role="dialog"]'))));
    const confirmDialog = tree.container.querySelector('[role="dialog"]') as HTMLElement;
    assert.match(text(confirmDialog), /only allowed for an account with no posting role/i);
    inAct(() => buttonByText(confirmDialog, 'Delete').click());
    assert.ok(await settleUntil(() => deletes.length === 1), 'confirming must delete through the endpoint');
    assert.deepEqual(deletes, ['a-ar']);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('chart register renders when the server omits unlinkedSubledgerRows', async () => {
  const restored = mountWorkspace(accountant, 'accounting-chart');
  let healthCalls = 0;
  const legacyHealth = {
    missingPostingRoles: [],
    controlAccountsWithoutSubledger: [],
    inactiveAccountsHoldingRole: [],
    totals: {
      accounts: accounts.length,
      controlAccounts: accounts.filter((account) => account.isControl).length,
      subledgers: 1,
      activeSubledgers: 1,
    },
  };
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-chart'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage'],
        version: 1,
      }),
      getChartHealth: async () => {
        healthCalls += 1;
        return legacyHealth as any;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Chart of accounts')),
      'the chart register must load even when the health payload is older'
    );
    assert.ok(healthCalls > 0, 'the chart loader must read the chart-health endpoint');
    inAct(() => buttonByText(tree.container, 'Reconciliation Health').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Setup gaps')),
      'the health tab must still render its setup-gap section'
    );
    assert.match(
      text(tree.container),
      /This server did not report unlinked subledger rows\. The rest of the chart is available\./
    );
    assert.match(text(tree.container), /Not reported by this server/);
    assert.doesNotMatch(text(tree.container), /Cannot read properties of undefined/);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('the chart screen is hidden without gl-chart-manage', async () => {
  const auditor = { ...accountant, id: 'u-auditor', role: 'AUDITOR' } as unknown as User;
  const restored = mountWorkspace(auditor, 'accounting-chart');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-chart'),
      getMyPermissions: async () => ({ role: 'AUDITOR', operations: ['gl-view'], version: 1 }),
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => window.location.pathname === '/dashboard'),
      'a reader without gl-chart-manage must be redirected away from the chart screen'
    );
    assert.doesNotMatch(text(tree.container), /Posting defaults/);
    assert.equal(buttonByTextOrNull(tree.container, 'New account'), null);
    assert.equal(tree.container.querySelector('[aria-label="Edit account 1100"]'), null);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('accounting register: switching branch and as-of date refetches the new scope', async () => {
  const calls: StatementQuery[] = [];
  const restored = mountWorkspace(accountant);
  const restoreApi = installApiStubs(
    accountingStubs({
      getTrialBalance: async (query: StatementQuery = {}) => {
        calls.push(query);
        const branch = query.branchId === 'BRH01' ? 'BRH01' : query.branchId || 'ALL';
        const receivable = query.branchId === 'BRH01' && query.to === '2026-10-15' ? 900 : 11300;
        return trialBalance(branch, query.to || '2026-11-02', receivable);
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes(formatNPR(11300))),
      'the initial company-level trial balance must load'
    );

    const select = tree.container.querySelector('select[aria-label="Accounting branch"]') as HTMLSelectElement | null;
    assert.ok(select, 'the register must offer a branch selector');
    const setSelect = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    inAct(() => {
      setSelect.call(select, 'BRH01');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.ok(await settleUntil(() => calls.some((call) => call.branchId === 'BRH01')));

    const dateInput = tree.container.querySelector('input[aria-label="Accounting as of date"]') as HTMLInputElement | null;
    assert.ok(dateInput, 'the register must offer an as-of date');
    const setInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    inAct(() => {
      setInput.call(dateInput, '2026-10-15');
      dateInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      dateInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

    const scoped = await settleUntil(() =>
      calls.some((call) => call.branchId === 'BRH01' && call.to === '2026-10-15')
    );
    assert.ok(scoped, 'the branch and date must reach the statement endpoint');
    assert.ok(
      await settleUntil(() => text(tree.container).includes(formatNPR(900))),
      'the rendered trial balance must follow the newly selected scope'
    );
    assert.equal(window.location.pathname, '/finance/accounting');
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('a role without gl-view is refused on an accounting register, not shown an empty ledger', async () => {
  let accountingReads = 0;
  const restored = mountWorkspace(branchManager, 'accounting-aging');
  const restoreApi = installApiStubs(
    accountingStubs({
      getMyPermissions: async () => ({ role: 'BRANCH_MANAGER', operations: [], version: 1 }),
      getTrialBalance: async () => {
        accountingReads += 1;
        return trialBalance();
      },
      getAging: async () => {
        accountingReads += 1;
        return agingAr;
      },
      getCashBook: async () => {
        accountingReads += 1;
        return cashBook;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    await settle();
    assert.equal(
      await settleUntil(() => window.location.pathname === '/dashboard'),
      true,
      'an unauthorized deep link must be replaced by a screen the role can open'
    );
    assert.equal(accountingReads, 0, 'a refused register must never call the ledger endpoints');
    assert.equal(
      [...tree.container.querySelectorAll('button')].some((button) =>
        (button.textContent || '').includes('AR / AP Aging')
      ),
      false,
      'the refused register must not leave its content on screen'
    );
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

const budgetVariance = {
  fiscalYearId: 'fy-smoke',
  fiscalYearCode: '2083/84',
  branchId: 'WH001',
  from: '2026-07-17',
  to: '2027-07-16',
  rows: [
    {
      accountId: 'a-exp-a',
      code: 'BGT-6100',
      name: 'BGT Budget With No Actual',
      accountType: 'EXPENSE',
      statementGroup: 'OPERATING_EXPENSE',
      budget: 1000,
      actual: 0,
      variance: 1000,
      variancePercent: 100,
    },
    {
      accountId: 'a-exp-b',
      code: 'BGT-6200',
      name: 'BGT Over Budget Expense',
      accountType: 'EXPENSE',
      statementGroup: 'OPERATING_EXPENSE',
      budget: 500,
      actual: 700,
      variance: -200,
      variancePercent: -40,
    },
    {
      accountId: 'a-exp-c',
      code: 'BGT-6300',
      name: 'BGT Exactly On Budget',
      accountType: 'EXPENSE',
      statementGroup: 'OPERATING_EXPENSE',
      budget: 400,
      actual: 400,
      variance: 0,
      variancePercent: 0,
    },
    {
      accountId: 'a-exp-d',
      code: 'BGT-6400',
      name: 'BGT Actual Without Budget',
      accountType: 'EXPENSE',
      statementGroup: 'OPERATING_EXPENSE',
      budget: 0,
      actual: 250,
      variance: -250,
      variancePercent: null,
    },
  ],
  totals: { budget: 1900, actual: 1350, variance: 550, variancePercent: 28.95 },
};

const budgetUtilisation = {
  fiscalYearId: 'fy-smoke',
  fiscalYearCode: '2083/84',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2027-07-16',
  branches: [
    {
      branchId: 'WH001',
      code: 'WH001',
      name: 'Warehouse',
      budget: 1900,
      actual: 1350,
      variance: 550,
      variancePercent: 28.95,
      utilisationPercent: 71.1,
    },
    {
      branchId: 'BRH01',
      code: 'BRH01',
      name: 'Branch 2',
      budget: 500,
      actual: 700,
      variance: -200,
      variancePercent: -40,
      utilisationPercent: 140,
    },
  ],
  totals: budgetVariance.totals,
  tieOut: {
    budget: 1900,
    actual: 1350,
    cardBudget: 1900,
    cardActual: 1350,
    budgetDifference: 0,
    actualDifference: 0,
    reconciled: true,
  },
};

const budgetSetup = {
  fiscalYearId: 'fy-smoke',
  fiscalYearCode: '2083/84',
  branchId: 'WH001',
  branchName: 'Warehouse',
  budgetId: 'bgt-1',
  locked: false,
  lockedBy: null,
  lockedAt: null,
  updatedAt: null,
  periods: [
    { periodKey: '2026-07', startDateAD: '2026-07-01', endDateAD: '2026-07-31', status: 'OPEN' },
    { periodKey: '2026-08', startDateAD: '2026-08-01', endDateAD: '2026-08-31', status: 'OPEN' },
  ],
  accounts: [
    { id: 'a-exp-a', code: 'BGT-6100', name: 'BGT Budget With No Actual', accountType: 'EXPENSE', statementGroup: 'OPERATING_EXPENSE' },
    { id: 'a-exp-b', code: 'BGT-6200', name: 'BGT Over Budget Expense', accountType: 'EXPENSE', statementGroup: 'OPERATING_EXPENSE' },
  ],
  lines: [
    { periodKey: '2026-07', accountId: 'a-exp-a', amount: 1000, code: 'BGT-6100', name: 'BGT Budget With No Actual', accountType: 'EXPENSE' },
  ],
};

const budgetAllocation = {
  fiscalYearId: 'fy-smoke',
  fiscalYearCode: '2083/84',
  branchId: 'WH001',
  branchName: 'Warehouse',
  profileId: 'alloc-1',
  status: 'READY' as const,
  locked: false,
  lockedBy: null,
  lockedAt: null,
  updatedBy: 'budget@example.com',
  updatedAt: null,
  totalExpenseBudget: 1900,
  rules: [
    {
      accountGroup: 'DEFAULT',
      costCenterId: 'cc-ops',
      percentage: 100,
      percentageBp: 10000,
      code: 'CC-01',
      name: 'Operations',
      branchId: null,
      active: true,
    },
  ],
  groups: [
    {
      accountGroup: 'OPERATING_EXPENSE',
      label: 'Operating expenses',
      budget: 1900,
      hasOverride: false,
      rules: [
        {
          accountGroup: 'DEFAULT',
          costCenterId: 'cc-ops',
          percentage: 100,
          percentageBp: 10000,
          code: 'CC-01',
          name: 'Operations',
          branchId: null,
          active: true,
        },
      ],
    },
  ],
  centres: [
    { id: 'cc-ops', code: 'CC-01', name: 'Operations', branchId: null, parentId: null, active: true },
  ],
};

const budgetDepartments = {
  fiscalYearId: 'fy-smoke',
  fiscalYearCode: '2083/84',
  branchId: 'WH001',
  branchName: 'Warehouse',
  profileId: 'alloc-1',
  status: 'READY' as const,
  from: '2026-07-17',
  to: '2027-07-16',
  departments: [
    {
      costCenterId: 'cc-ops',
      code: 'CC-01',
      name: 'Operations',
      budget: 1900,
      actual: 1350,
      variance: 550,
      variancePercent: 28.95,
      utilisationPercent: 71.05,
      lineCount: 2,
      inAllocation: true,
    },
  ],
  groups: [
    { accountGroup: 'OPERATING_EXPENSE', label: 'Operating expenses', budget: 1900, hasOverride: false },
  ],
  totals: {
    expenseBudget: 1900,
    allocatedBudget: 1900,
    expenseActual: 1400,
    taggedActual: 1350,
    unallocatedActual: 50,
  },
  coverage: {
    totalExpenseLines: 3,
    taggedExpenseLines: 2,
    untaggedExpenseLines: 1,
    taggedPercent: 66.67,
  },
  unallocated: { actual: 50, lineCount: 1 },
  tieOut: { budgetDifference: 0, actualDifference: 0, reconciled: true },
};

test('budget vs actual renders the server variance and saves a hand-entered line', async () => {
  const branchAccountant = {
    ...accountant,
    id: 'u-budget-accountant',
    email: 'budget.accountant@example.com',
    branchId: 'WH001',
  } as unknown as User;
  const restored = mountWorkspace(branchAccountant, 'financial-statements');
  let saved: any = null;
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => budgetVariance,
      getAccountingBudget: async () => budgetSetup,
      saveAccountingBudget: async (input: any) => {
        saved = input;
        return {
          ...budgetSetup,
          lines: input.lines.map((line: any) => ({
            ...line,
            code: budgetSetup.accounts.find((account) => account.id === line.accountId)?.code,
            name: budgetSetup.accounts.find((account) => account.id === line.accountId)?.name,
            accountType: 'EXPENSE',
          })),
        };
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Budget vs actual')),
      'the dashboard must offer the budget view'
    );
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('BGT Over Budget Expense')),
      'the budget rows must render'
    );
    assert.match(text(tree.container), /2 of 4/, 'two accounts are over budget');
    assert.ok(text(tree.container).includes(formatNPR(1000)), 'a budget with no actual renders its remaining amount');
    assert.ok(text(tree.container).includes(formatNPR(-200)), 'an overspend renders as a negative variance');
    assert.match(text(tree.container), /—/, 'a zero budget renders no invented variance percentage');

    const accountSelect = tree.container.querySelector('select[aria-label="Budget account"]') as HTMLSelectElement | null;
    const periodSelect = tree.container.querySelector('select[aria-label="Budget period"]') as HTMLSelectElement | null;
    const amountInput = tree.container.querySelector('input[aria-label="Budget amount"]') as HTMLInputElement | null;
    assert.ok(accountSelect && periodSelect && amountInput, 'the editor must expose account, period and amount controls');
    setSelectValue(accountSelect, 'a-exp-b');
    setSelectValue(periodSelect, '2026-08');
    setInputValue(amountInput, '1250');
    inAct(() => buttonByText(tree.container, 'Add line').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes(formatNPR(1250))),
      'the new line must appear in the draft before saving'
    );

    inAct(() => buttonByText(tree.container, 'Save budget').click());
    assert.ok(await settleUntil(() => saved !== null), 'saving must send the budget payload');
    assert.equal(saved.fiscalYearId, 'fy-smoke');
    assert.equal(saved.branchId, 'WH001');
    assert.deepEqual(saved.lines, [
      { periodKey: '2026-07', accountId: 'a-exp-a', amount: 1000 },
      { periodKey: '2026-08', accountId: 'a-exp-b', amount: 1250 },
    ]);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('the allocation card previews departments and saves the branch default', async () => {
  const branchAccountant = {
    ...accountant,
    id: 'u-budget-allocation',
    email: 'budget.allocation@example.com',
    branchId: 'WH001',
  } as unknown as User;
  const restored = mountWorkspace(branchAccountant, 'financial-statements');
  let savedAllocation: any = null;
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => budgetVariance,
      getAccountingBudget: async () => budgetSetup,
      getAccountingBudgetAllocation: async () => budgetAllocation,
      getAccountingBudgetDepartmentVariance: async () => budgetDepartments,
      saveAccountingBudgetAllocation: async (input: any) => {
        savedAllocation = input;
        return budgetAllocation;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget vs actual')));
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Cost-centre allocation')),
      'the allocation card must render'
    );
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Department preview')),
      'the department preview must render'
    );
    assert.match(text(tree.container), /Unallocated actual/);
    assert.match(text(tree.container), /CC-01/);
    assert.match(text(tree.container), /READY · 1 rule/);
    assert.match(text(tree.container), /Reconciled/);
    assert.match(text(tree.container), /Zero variance/);

    inAct(() => buttonByText(tree.container, 'Edit allocation').click());
    const percentage = tree.container.querySelector(
      'input[aria-label="Allocation percentage for CC-01"]'
    ) as HTMLInputElement | null;
    assert.ok(percentage, 'the editor must expose the cost-centre percentage');
    setInputValue(percentage, '100');
    inAct(() => buttonByText(tree.container, 'Save allocation').click());

    assert.ok(await settleUntil(() => savedAllocation !== null), 'save must send the allocation');
    assert.equal(savedAllocation.fiscalYearId, 'fy-smoke');
    assert.equal(savedAllocation.branchId, 'WH001');
    assert.deepEqual(savedAllocation.rules, [
      { accountGroup: 'DEFAULT', costCenterId: 'cc-ops', percentage: 100 },
    ]);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('the budget view copies the previous year and exposes explicit replace', async () => {
  const branchAccountant = {
    ...accountant,
    id: 'u-budget-copy',
    email: 'budget.copy@example.com',
    branchId: 'WH001',
  } as unknown as User;
  const restored = mountWorkspace(branchAccountant, 'financial-statements');
  let copied: any = null;
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => budgetVariance,
      getAccountingBudget: async () => budgetSetup,
      copyAccountingBudget: async (input: any) => {
        copied = input;
        return {
          status: 'COPIED',
          sourceFiscalYearId: 'fy-prev',
          sourceFiscalYearCode: '2082/83',
          targetFiscalYearId: 'fy-smoke',
          targetFiscalYearCode: '2083/84',
          branchId: 'WH001',
          branchName: 'Warehouse',
          sourceLines: 2,
          mappedLines: 2,
          copiedLines: 2,
          skippedAccounts: [
            { accountId: 'a-old', code: 'OLD-1', name: 'Retired expense', reason: 'MISSING_FROM_CHART' },
          ],
          periodMapping: [
            {
              sourcePeriodKey: '2025-07',
              targetPeriodKey: '2026-07',
              sourceStartDateAD: '2025-07-01',
              targetStartDateAD: '2026-07-01',
            },
          ],
          unmappedPeriods: [],
          replacedExisting: false,
          budget: {
            ...budgetSetup,
            lines: [
              { periodKey: '2026-07', accountId: 'a-exp-a', amount: 1200, code: 'BGT-6100', name: 'BGT Budget With No Actual', accountType: 'EXPENSE' },
              { periodKey: '2026-08', accountId: 'a-exp-b', amount: 300, code: 'BGT-6200', name: 'BGT Over Budget Expense', accountType: 'EXPENSE' },
            ],
          },
        };
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget vs actual')));
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(await settleUntil(() => text(tree.container).includes('Copy from previous year')));
    const replace = tree.container.querySelector(
      'input[aria-label="Replace existing budget"]'
    ) as HTMLInputElement | null;
    assert.ok(replace, 'the replace affordance must be visible');
    inAct(() => replace.click());
    inAct(() => buttonByText(tree.container, 'Copy from previous year').click());

    assert.ok(await settleUntil(() => copied !== null), 'copy must send the target year and branch');
    assert.deepEqual(copied, { targetFiscalYearId: 'fy-smoke', branchId: 'WH001', replace: true });
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Copied 2 lines from FY 2082/83')),
      'the result must state what was copied'
    );
    assert.match(text(tree.container), /1 account skipped/);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('the budget variance account row opens its posted actual lines and tie-out', async () => {
  const branchAccountant = {
    ...accountant,
    id: 'u-budget-drill',
    email: 'budget.drill@example.com',
    branchId: 'WH001',
  } as unknown as User;
  const restored = mountWorkspace(branchAccountant, 'financial-statements');
  let drillRequest: any = null;
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => budgetVariance,
      getAccountingBudget: async () => budgetSetup,
      getAccountingBudgetVarianceLines: async (input: any) => {
        drillRequest = input;
        return {
          fiscalYearId: 'fy-smoke',
          fiscalYearCode: '2083/84',
          branchId: 'WH001',
          from: '2026-07-17',
          to: '2027-07-16',
          account: budgetVariance.rows[1],
          entries: [
            {
              id: 'bgt-drill-1',
              journalId: 'j-bgt-drill-1',
              journalNo: 'JV-BGT-1',
              journalDateAD: '2026-08-10',
              sourceType: 'MANUAL',
              sourceId: null,
              branchId: 'WH001',
              accountId: 'a-exp-b',
              accountCode: 'BGT-6200',
              accountName: 'BGT Over Budget Expense',
              lineNo: 1,
              memo: 'BGT over-budget August',
              journalMemo: null,
              debit: 400,
              credit: 0,
              amount: 400,
            },
            {
              id: 'bgt-drill-2',
              journalId: 'j-bgt-drill-2',
              journalNo: 'JV-BGT-2',
              journalDateAD: '2026-09-05',
              sourceType: 'MANUAL',
              sourceId: null,
              branchId: 'WH001',
              accountId: 'a-exp-b',
              accountCode: 'BGT-6200',
              accountName: 'BGT Over Budget Expense',
              lineNo: 1,
              memo: 'BGT over-budget September',
              journalMemo: null,
              debit: 300,
              credit: 0,
              amount: 300,
            },
          ],
          totals: { debit: 700, credit: 0, actual: 700, entryCount: 2 },
          tieOut: {
            budget: 500,
            actual: 700,
            variance: -200,
            variancePercent: -40,
            lineActual: 700,
            difference: 0,
            reconciled: true,
          },
          truncated: false,
          limit: 500,
        };
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget vs actual')));
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(
      await settleUntil(() =>
        tree.container.querySelector(
          'button[aria-label="View posted journal lines for BGT-6200 BGT Over Budget Expense"]'
        ) !== null
      )
    );
    clickAria(
      tree.container,
      'View posted journal lines for BGT-6200 BGT Over Budget Expense'
    );

    assert.ok(await settleUntil(() => text(tree.container).includes('Ties to budget actual')));
    assert.equal(drillRequest.fiscalYearId, 'fy-smoke');
    assert.equal(drillRequest.branchId, 'WH001');
    assert.equal(drillRequest.accountId, 'a-exp-b');
    assert.match(text(tree.container), /JV-BGT-1/);
    assert.match(text(tree.container), /BGT over-budget August/);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('branch utilisation cards show each branch and tie back to the variance total', async () => {
  const restored = mountWorkspace(accountant, 'financial-statements');
  let utilisationRequest: any = null;
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => ({ ...budgetVariance, branchId: 'ALL' }),
      getAccountingBudgetVarianceUtilisation: async (input: any) => {
        utilisationRequest = input;
        return { ...budgetUtilisation, branchId: 'ALL' };
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget vs actual')));
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(await settleUntil(() => text(tree.container).includes('Branch utilisation')));
    assert.equal(utilisationRequest.fiscalYearId, 'fy-smoke');
    assert.equal(utilisationRequest.branchId, 'ALL');
    assert.equal(utilisationRequest.from, '2026-07-17');
    assert.equal(utilisationRequest.to, '2027-07-16');

    assert.ok(
      tree.container.querySelector('article[aria-label="Branch utilisation WH001"]'),
      'the first branch card must render'
    );
    assert.ok(
      tree.container.querySelector('article[aria-label="Branch utilisation BRH01"]'),
      'the second branch card must render'
    );
    assert.match(text(tree.container), /Warehouse/);
    assert.match(text(tree.container), /Branch 2/);
    assert.match(text(tree.container), /71\.1% used/);
    assert.match(text(tree.container), /140\.0% used/);
    assert.match(text(tree.container), /Ties to variance total/);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('the budget view shows every refused CSV row and sends no partial import', async () => {
  const branchAccountant = {
    ...accountant,
    id: 'u-budget-import',
    email: 'budget.import@example.com',
    branchId: 'WH001',
  } as unknown as User;
  const restored = mountWorkspace(branchAccountant, 'financial-statements');
  let imported: any = null;
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => budgetVariance,
      getAccountingBudget: async () => budgetSetup,
      importAccountingBudgetCsv: async (input: any) => {
        imported = input;
        const error: any = new Error('The CSV import was refused. No budget lines were changed.');
        error.status = 400;
        error.body = {
          status: 'REFUSED',
          errors: [
            { row: 2, message: 'Unknown chart account "BGT-9999".' },
            { row: 3, message: 'Period "2099-01" does not belong to fiscal year 2083/84.' },
          ],
        };
        throw error;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget vs actual')));
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(await settleUntil(() => text(tree.container).includes('Import CSV')));
    const fileInput = tree.container.querySelector(
      'input[aria-label="Budget CSV file"]'
    ) as HTMLInputElement | null;
    assert.ok(fileInput, 'the CSV file input must exist');
    const csv = 'account_code,period_key,amount\nBGT-9999,2026-07,100\nBGT-6100,2099-01,200';
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [{ name: 'budget.csv', text: async () => csv }],
    });
    inAct(() => fileInput.dispatchEvent(new window.Event('change', { bubbles: true })));

    assert.ok(await settleUntil(() => imported !== null), 'the selected file contents must be sent');
    assert.equal(imported.fiscalYearId, 'fy-smoke');
    assert.equal(imported.branchId, 'WH001');
    assert.equal(imported.csv, csv);
    assert.equal(imported.replace, false);
    assert.ok(
      await settleUntil(() =>
        tree.container.querySelector('ul[aria-label="Budget CSV errors"]') !== null
      ),
      'the row errors must be rendered'
    );
    const errorList = tree.container.querySelector(
      'ul[aria-label="Budget CSV errors"]'
    ) as HTMLElement;
    assert.match(text(errorList), /Row 2: Unknown chart account/);
    assert.match(text(errorList), /Row 3: Period/);
    assert.match(text(tree.container), /No budget lines were changed/);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('the consolidated budget view is read-only and does not load a branch editor', async () => {
  const restored = mountWorkspace(accountant, 'financial-statements');
  let branchBudgetReads = 0;
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => ({ ...budgetVariance, branchId: 'ALL' }),
      getAccountingBudget: async () => {
        branchBudgetReads += 1;
        return budgetSetup;
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget vs actual')));
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(
      await settleUntil(() => text(tree.container).includes('consolidated read-only view')),
      'the ALL view must explain that editing needs a concrete branch'
    );
    assert.equal(branchBudgetReads, 0, 'the ALL view must not load a branch budget editor');
    assert.equal(
      tree.container.querySelector('select[aria-label="Budget account"]'),
      null,
      'the consolidated view must not offer the editor'
    );
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('the budget view locks and unlocks its editor explicitly', async () => {
  const branchAccountant = {
    ...accountant,
    id: 'u-budget-lock',
    email: 'budget.lock@example.com',
    branchId: 'WH001',
  } as unknown as User;
  const restored = mountWorkspace(branchAccountant, 'financial-statements');
  const lockCalls: any[] = [];
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => budgetVariance,
      getAccountingBudget: async () => budgetSetup,
      setAccountingBudgetLock: async (input: any) => {
        lockCalls.push(input);
        return {
          status: input.locked ? 'LOCKED' : 'UNLOCKED',
          budget: {
            ...budgetSetup,
            locked: input.locked,
            lockedBy: input.locked ? 'Asha Accountant' : null,
            lockedAt: input.locked ? '2026-11-10T10:00:00.000Z' : null,
          },
        };
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget vs actual')));
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(await settleUntil(() => text(tree.container).includes('Save budget')));
    assert.equal(buttonByText(tree.container, 'Save budget').disabled, false);
    assert.equal(buttonByText(tree.container, 'Lock budget').disabled, false);

    inAct(() => buttonByText(tree.container, 'Lock budget').click());
    assert.ok(
      await settleUntil(
        () => lockCalls.length === 1 && text(tree.container).includes('Unlock budget')
      ),
      'locking must persist and switch the action to unlock'
    );
    assert.deepEqual(lockCalls[0], {
      fiscalYearId: 'fy-smoke',
      branchId: 'WH001',
      locked: true,
    });
    assert.match(text(tree.container), /Locked by Asha Accountant/);
    assert.equal(buttonByText(tree.container, 'Save budget').disabled, true);
    assert.equal(buttonByText(tree.container, 'Copy from previous year').disabled, true);
    assert.equal(buttonByText(tree.container, 'Import CSV').disabled, true);
    assert.equal(
      (tree.container.querySelector('input[aria-label="Replace existing budget"]') as HTMLInputElement).disabled,
      true
    );
    assert.equal(
      (tree.container.querySelector('select[aria-label="Budget account"]') as HTMLSelectElement).disabled,
      true
    );
    assert.equal(
      (tree.container.querySelector('input[aria-label="Budget amount"]') as HTMLInputElement).disabled,
      true
    );

    inAct(() => buttonByText(tree.container, 'Unlock budget').click());
    assert.ok(
      await settleUntil(
        () => lockCalls.length === 2 && text(tree.container).includes('Lock budget')
      ),
      'unlocking must restore the editor'
    );
    assert.deepEqual(lockCalls[1], {
      fiscalYearId: 'fy-smoke',
      branchId: 'WH001',
      locked: false,
    });
    assert.equal(buttonByText(tree.container, 'Save budget').disabled, false);
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});

test('the budget history opens a stored version and restores it', async () => {
  const branchAccountant = {
    ...accountant,
    id: 'u-budget-history',
    email: 'budget.history@example.com',
    branchId: 'WH001',
  } as unknown as User;
  const restored = mountWorkspace(branchAccountant, 'financial-statements');
  const history = {
    fiscalYearId: 'fy-smoke',
    fiscalYearCode: '2083/84',
    branchId: 'WH001',
    branchName: 'Warehouse',
    versions: [
      {
        id: 'bgt-v2',
        version: 2,
        actor: 'Asha Accountant',
        createdAt: '2026-11-10T10:00:00.000Z',
        source: 'SAVE',
        sourceDetail: null,
        lineCount: 1,
        totalAmount: 1000,
      },
      {
        id: 'bgt-v1',
        version: 1,
        actor: 'Asha Accountant',
        createdAt: '2026-11-09T10:00:00.000Z',
        source: 'BASELINE',
        sourceDetail: 'Initial budget baseline',
        lineCount: 0,
        totalAmount: 0,
      },
    ],
  };
  const versionDetail = {
    ...history,
    version: {
      ...history.versions[0],
      lines: [
        {
          periodKey: '2026-07',
          accountId: 'a-exp-a',
          amount: 1000,
          code: 'BGT-6100',
          name: 'BGT Budget With No Actual',
          accountType: 'EXPENSE',
        },
      ],
    },
  };
  let historyReads = 0;
  const restoreCalls: any[] = [];
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('financial-statements'),
      getMyPermissions: async () => ({
        role: 'ACCOUNTANT',
        operations: ['gl-view', 'gl-chart-manage', 'fin-statements'],
        version: 1,
      }),
      getAccountingBudgetVariance: async () => budgetVariance,
      getAccountingBudget: async () => budgetSetup,
      getAccountingBudgetHistory: async () => {
        historyReads += 1;
        return history;
      },
      getAccountingBudgetVersion: async () => versionDetail,
      restoreAccountingBudgetVersion: async (input: any) => {
        restoreCalls.push(input);
        return {
          status: 'RESTORED',
          restoredVersion: 2,
          snapshot: {
            ...history.versions[0],
            id: 'bgt-v3',
            version: 3,
            source: 'RESTORE',
            sourceDetail: 'Restored version 2',
          },
          budget: {
            ...budgetSetup,
            lines: [
              {
                periodKey: '2026-07',
                accountId: 'a-exp-a',
                amount: 1000,
                code: 'BGT-6100',
                name: 'BGT Budget With No Actual',
                accountType: 'EXPENSE',
              },
            ],
          },
        };
      },
    })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget vs actual')));
    inAct(() => buttonByText(tree.container, 'Budget vs actual').click());
    assert.ok(await settleUntil(() => text(tree.container).includes('Budget history')));
    inAct(() => buttonByText(tree.container, 'View history').click());

    assert.ok(
      await settleUntil(() => text(tree.container).includes('Manual save')),
      'the version list must render who/when/what produced it'
    );
    assert.equal(historyReads, 1);
    assert.match(text(tree.container), /v2/);
    assert.match(text(tree.container), /Asha Accountant/);
    assert.match(text(tree.container), /Initial budget baseline/);

    clickAria(tree.container, 'View budget version 2');
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Version 2 lines')),
      'the version drill-down must open'
    );
    assert.match(text(tree.container), /BGT Budget With No Actual/);

    clickAria(tree.container, 'Restore budget version 2');
    assert.ok(
      await settleUntil(() => restoreCalls.length === 1),
      'restore must call the history endpoint'
    );
    assert.deepEqual(restoreCalls[0], {
      fiscalYearId: 'fy-smoke',
      branchId: 'WH001',
      versionId: 'bgt-v2',
    });
    assert.ok(
      await settleUntil(() =>
        text(tree.container).includes(
          'Restored version 2. The previous lines were saved as version 3.'
        )
      ),
      'the restore result must explain the new snapshot'
    );
    assert.ok(historyReads >= 2, 'restoring must reload the version list');
  } finally {
    tree.unmount();
    restoreApi();
    restored.restoreEventSource();
  }
});
