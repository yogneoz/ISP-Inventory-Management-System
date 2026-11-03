/**
 * Default chart of accounts seeded on a fresh database.
 *
 * These are the minimum accounts a working ledger needs: one posting default
 * per role an operational document uses (sales/purchase invoices today,
 * payroll and inter-branch transfers in later slices), plus a usable statement
 * mapping. They are ordinary editable data — `ensureDefaultChart` inserts them
 * idempotently by code, so changing a name or retiring an account in the UI is
 * never undone by the next boot.
 *
 * Codes are intentionally stable and human-readable: the reconciliation
 * screens and VAT reports expose them, and a trial balance grouped by code is
 * far easier to audit than random ids.
 */
import type {
  AccountType,
  NormalBalance,
  PostingRole,
  StatementGroup,
  SubledgerType,
} from '../models/accounting.repo';

export interface DefaultChartGroup {
  code: string;
  name: string;
  accountType: AccountType;
  statementGroup: StatementGroup;
  normalBalance: NormalBalance;
  sortOrder: number;
}

export interface DefaultChartAccount {
  code: string;
  name: string;
  groupCode: string;
  description: string;
  isControl: boolean;
  subledgerType: SubledgerType;
  postingRole: PostingRole | null;
}

export const DEFAULT_CHART_GROUPS: readonly DefaultChartGroup[] = [
  {
    code: '1000',
    name: 'Current Assets',
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
    sortOrder: 10,
  },
  {
    code: '1500',
    name: 'Non-current Assets',
    accountType: 'ASSET',
    statementGroup: 'NON_CURRENT_ASSET',
    normalBalance: 'DEBIT',
    sortOrder: 20,
  },
  {
    code: '2000',
    name: 'Current Liabilities',
    accountType: 'LIABILITY',
    statementGroup: 'CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
    sortOrder: 30,
  },
  {
    code: '2500',
    name: 'Non-current Liabilities',
    accountType: 'LIABILITY',
    statementGroup: 'NON_CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
    sortOrder: 40,
  },
  {
    code: '3000',
    name: 'Equity',
    accountType: 'EQUITY',
    statementGroup: 'EQUITY',
    normalBalance: 'CREDIT',
    sortOrder: 50,
  },
  {
    code: '4000',
    name: 'Revenue',
    accountType: 'INCOME',
    statementGroup: 'REVENUE',
    normalBalance: 'CREDIT',
    sortOrder: 60,
  },
  {
    code: '5000',
    name: 'Cost of Sales',
    accountType: 'EXPENSE',
    statementGroup: 'COST_OF_SALES',
    normalBalance: 'DEBIT',
    sortOrder: 70,
  },
  {
    code: '6000',
    name: 'Operating Expenses',
    accountType: 'EXPENSE',
    statementGroup: 'OPERATING_EXPENSE',
    normalBalance: 'DEBIT',
    sortOrder: 80,
  },
  // Disposal gains and losses sit outside trading operations, so they need
  // their own statement groups rather than inflating operating expense/income.
  {
    code: '4500',
    name: 'Other Income',
    accountType: 'INCOME',
    statementGroup: 'OTHER_INCOME',
    normalBalance: 'CREDIT',
    sortOrder: 65,
  },
  {
    code: '6500',
    name: 'Other Expenses',
    accountType: 'EXPENSE',
    statementGroup: 'OTHER_EXPENSE',
    normalBalance: 'DEBIT',
    sortOrder: 85,
  },
];

export const DEFAULT_CHART_ACCOUNTS: readonly DefaultChartAccount[] = [
  {
    code: '1010',
    name: 'Cash on Hand',
    groupCode: '1000',
    description: 'Till and petty cash.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'CASH',
  },
  {
    code: '1020',
    name: 'Bank Account',
    groupCode: '1000',
    description: 'Operating bank account.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'BANK',
  },
  {
    code: '1100',
    name: 'Accounts Receivable',
    groupCode: '1000',
    description: 'Amounts due from customers, reconciled to the customer subledger.',
    isControl: true,
    subledgerType: 'CUSTOMER',
    postingRole: 'AR_CONTROL',
  },
  {
    code: '1200',
    name: 'Inventory',
    groupCode: '1000',
    description: 'Stock at weighted-average cost.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'INVENTORY',
  },
  {
    code: '1510',
    name: 'Deployed CPE Assets',
    groupCode: '1500',
    description: 'Customer-premises equipment issued from branch stock, at its issue cost.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'CPE_ASSET',
  },
  {
    code: '1520',
    name: 'Fixed Assets at Cost',
    groupCode: '1500',
    description: 'Capitalised plant, equipment and vehicles acquired outside branch stock.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'FIXED_ASSET',
  },
  {
    code: '1525',
    name: 'Accumulated Depreciation',
    groupCode: '1500',
    description:
      'Contra-asset: depreciation charged against capitalised assets. Carries a credit balance.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'ACCUMULATED_DEPRECIATION',
  },
  {
    code: '1300',
    name: 'VAT Input (Recoverable)',
    groupCode: '1000',
    description: 'Input VAT claimable against output VAT.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'TAX_INPUT',
  },
  // Inter-branch custody accounts. They are ordinary control accounts (a
  // branch must name the counterparty branch on every line), and they carry
  // the two posting defaults the transfer posting uses. The balance sheet
  // reports both as due to/from head office, so a branch's statement has a
  // defined home for that balance instead of an unexplained asset/liability.
  {
    code: '1610',
    name: 'Due from Head Office',
    groupCode: '1000',
    description: 'Inter-branch receivable from head office, cleared when the transfer settles.',
    isControl: true,
    subledgerType: 'INTER_BRANCH',
    postingRole: 'DUE_FROM_HO',
  },
  {
    code: '1620',
    name: 'Employee Advances',
    groupCode: '1000',
    description:
      'Salary advances paid to employees, recovered through payroll deductions (employee subledger).',
    isControl: true,
    subledgerType: 'EMPLOYEE',
    postingRole: 'EMPLOYEE_ADVANCE',
  },
  {
    code: '1630',
    name: 'Employee Loans',
    groupCode: '1000',
    description:
      'Loans extended to employees, recovered through payroll deductions (employee subledger).',
    isControl: true,
    subledgerType: 'EMPLOYEE',
    postingRole: 'EMPLOYEE_LOAN',
  },
  {
    code: '2100',
    name: 'Accounts Payable',
    groupCode: '2000',
    description: 'Amounts due to suppliers, reconciled to the supplier subledger.',
    isControl: true,
    subledgerType: 'SUPPLIER',
    postingRole: 'AP_CONTROL',
  },
  {
    code: '2200',
    name: 'VAT Output Payable',
    groupCode: '2000',
    description: 'Output VAT collected on sales.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'TAX_OUTPUT',
  },
  {
    code: '2310',
    name: 'Due to Head Office',
    groupCode: '2000',
    description: 'Inter-branch payable to head office, cleared when the transfer settles.',
    isControl: true,
    subledgerType: 'INTER_BRANCH',
    postingRole: 'DUE_TO_HO',
  },
  {
    code: '2320',
    name: 'Salary Payable',
    groupCode: '2000',
    description:
      'Net salary owed to employees after TDS, SSF and advance/loan recoveries (employee subledger).',
    isControl: true,
    subledgerType: 'EMPLOYEE',
    postingRole: 'SALARY_PAYABLE',
  },
  {
    code: '2330',
    name: 'TDS Payable',
    groupCode: '2000',
    description:
      'Tax deducted at source on salaries, owed to the tax authority and tracked per employee.',
    isControl: true,
    subledgerType: 'EMPLOYEE',
    postingRole: 'TDS_PAYABLE',
  },
  {
    code: '2340',
    name: 'SSF Payable',
    groupCode: '2000',
    description:
      'Social Security Fund contribution withheld from salaries, tracked per employee.',
    isControl: true,
    subledgerType: 'EMPLOYEE',
    postingRole: 'SSF_PAYABLE',
  },
  {
    code: '3000',
    name: 'Retained Earnings',
    groupCode: '3000',
    description: 'Accumulated results carried into equity.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'RETAINED_EARNINGS',
  },
  {
    code: '4000',
    name: 'Sales Revenue',
    groupCode: '4000',
    description: 'Revenue from goods sold.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'SALES',
  },
  {
    code: '4200',
    name: 'Gain on Asset Disposal',
    groupCode: '4500',
    description: 'Proceeds above the net book value of a disposed fixed asset.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'GAIN_ON_DISPOSAL',
  },
  {
    code: '5000',
    name: 'Cost of Goods Sold',
    groupCode: '5000',
    description: 'Weighted-average cost of goods sold.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'COGS',
  },
  {
    code: '6300',
    name: 'Depreciation Expense',
    groupCode: '6000',
    description: 'Periodic depreciation charge on capitalised fixed assets.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'DEPRECIATION_EXPENSE',
  },
  {
    code: '6400',
    name: 'Salaries & Wages',
    groupCode: '6000',
    description: 'Gross salaries and wages for a posted payroll run.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'SALARY_EXPENSE',
  },
  {
    code: '6500',
    name: 'Loss on Asset Disposal',
    groupCode: '6500',
    description: 'Net book value above the proceeds of a disposed fixed asset.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'LOSS_ON_DISPOSAL',
  },
  {
    code: '6100',
    name: 'General Operating Expense',
    groupCode: '6000',
    description: 'Default expense account for manual entries.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: null,
  },
  {
    code: '6200',
    name: 'Inventory Shrinkage & Stock Expense',
    groupCode: '6000',
    description:
      'Cost of stock lost to damage, consumables, pullouts and adjustments; credited when an adjustment adds stock.',
    isControl: false,
    subledgerType: 'NONE',
    postingRole: 'STOCK_EXPENSE',
  },
];
