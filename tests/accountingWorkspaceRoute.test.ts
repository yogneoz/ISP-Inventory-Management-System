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
  CashBookResponse,
  CashFlowResponse,
  ControlReconciliationResponse,
  ProfitAndLossResponse,
  StatementGroupLinesResponse,
  StatementQuery,
  TrialBalanceAccountLinesResponse,
  TrialBalanceGroupLinesResponse,
  TrialBalanceResponse,
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
};

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
    getStatementGroupLines: async () => profitGroupLines,
    getCashBook: async () => cashBook,
    getAging: async () => agingAr,
    getControlReconciliation: async () => reconciliation,
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

test('cash flow register renders sections and sends the period start', async () => {
  const calls: StatementQuery[] = [];
  const restored = mountWorkspace(accountant, 'accounting-cash-flow');
  const restoreApi = installApiStubs(
    accountingStubs({
      getBootstrapState: async () => bootstrapWithTab('accounting-cash-flow'),
      getCashFlow: async (query: StatementQuery = {}) => {
        calls.push(query);
        return cashFlow;
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
    accountingStubs({ getBootstrapState: async () => bootstrapWithTab('accounting-chart') })
  );
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => text(tree.container).includes('Posting defaults')),
      'the chart register must load posting defaults'
    );
    assert.equal(window.location.pathname, '/finance/accounting/chart');
    assert.match(text(tree.container), /Chart of accounts/);
    assert.match(text(tree.container), /Sales Revenue/);
    assert.match(text(tree.container), /CUSTOMER/);
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
      getMyPermissions: async () => ({ role: 'ACCOUNTANT', operations: ['gl-view', 'gl-manage'], version: 1 }),
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
      await settleUntil(() => text(tree.container).includes('Posting defaults')),
      'the chart register must load before it can be maintained'
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

test('chart maintenance is hidden without gl-manage', async () => {
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
      await settleUntil(() => text(tree.container).includes('Posting defaults')),
      'an auditor must still read the chart'
    );
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
