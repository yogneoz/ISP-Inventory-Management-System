/**
 * NFRS-aligned chart of accounts.
 *
 * This is the chart a fresh install seeds and the one the chart screens show.
 * Every account below keeps the standard's own 4-digit code, title, class order
 * and statutory reference verbatim, so a trial balance or a note to the
 * financial statements can be traced straight back to NAS/NFRS and the Nepali
 * statutes (IRD VAT Act 2052, Income Tax Act 2058, SSF Act 2074, Labor Act
 * 2074, Bonus Act 2030, Companies Act 2063, Industrial Enterprises Act 2076).
 * Do not renumber, re-sort or rename these rows: the code IS the reference.
 *
 * Each account also carries a note written for the operator: what belongs in
 * it, and which posting role the application routes there. A note is not the
 * statutory reference — it is the practical guidance the standard does not give.
 *
 * ---------------------------------------------------------------------------
 * INTERNAL CONTROL LEDGERS (9000 – 9050)
 * ---------------------------------------------------------------------------
 * The statutory chart has no line for a few ledgers this application must keep
 * balanced: money due between branches, staff loans, and the wallet clearing
 * accounts a provider settles through. Those are appended AFTER the statutory
 * block, in their own group, and are excluded from NFRS presentation. They are
 * control accounts with subledgers, not report lines, and the seed keeps them
 * last so the statutory order is exactly the PDF's.
 */
import type {
  AccountType,
  NormalBalance,
  PostingRole,
  StatementGroup,
  SubledgerType,
} from '../models/accounting.repo';

export interface NfrsChartGroup {
  code: string;
  name: string;
  accountType: AccountType;
  statementGroup: StatementGroup;
  /** Reporting label for the group. An account's own side is set separately. */
  normalBalance: NormalBalance;
  sortOrder: number;
}

export interface NfrsChartAccount {
  code: string;
  name: string;
  groupCode: string;
  /** The standard's reference, exactly as published (NFRS / statutory). */
  statutoryReference: string;
  /** Practical note for the operator: what belongs here and how it posts. */
  note: string;
  postingRole?: PostingRole;
  /**
   * Pinned side for an account whose nature the group cannot express: a
   * contra-asset or contra-income ledger normally reports with its section, so
   * without this it would inherit the section's side and double the balance.
   */
  normalBalance?: 'DEBIT' | 'CREDIT';
  isControl?: boolean;
  subledgerType?: SubledgerType;
  accountKind?: 'CASH' | 'BANK' | 'WALLET' | 'OTHER';
  providerCode?: 'ESEWA' | 'KHALTI' | 'NEPAL_PAY';
}

/**
 * One group per statement bucket, in class order. Splitting revenue from other
 * income, and cost of sales from operating expense and finance cost/tax, keeps
 * the statement tree correct while the account codes stay in exact order.
 */
export const NFRS_CHART_GROUPS: readonly NfrsChartGroup[] = [
  {
    code: '1000',
    name: 'Non-Current Assets',
    accountType: 'ASSET',
    statementGroup: 'NON_CURRENT_ASSET',
    normalBalance: 'DEBIT',
    sortOrder: 10,
  },
  {
    code: '2000',
    name: 'Current Assets',
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
    sortOrder: 20,
  },
  {
    code: '3000',
    name: 'Equity',
    accountType: 'EQUITY',
    statementGroup: 'EQUITY',
    normalBalance: 'CREDIT',
    sortOrder: 30,
  },
  {
    code: '4000',
    name: 'Non-Current Liabilities',
    accountType: 'LIABILITY',
    statementGroup: 'NON_CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
    sortOrder: 40,
  },
  {
    code: '5000',
    name: 'Current Liabilities',
    accountType: 'LIABILITY',
    statementGroup: 'CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
    sortOrder: 50,
  },
  {
    code: '6000',
    name: 'Revenue from Contracts with Customers',
    accountType: 'INCOME',
    statementGroup: 'REVENUE',
    normalBalance: 'CREDIT',
    sortOrder: 60,
  },
  {
    code: '6100',
    name: 'Other Operating & Finance Income',
    accountType: 'INCOME',
    statementGroup: 'OTHER_INCOME',
    normalBalance: 'CREDIT',
    sortOrder: 62,
  },
  {
    code: '7000',
    name: 'Cost of Sales',
    accountType: 'EXPENSE',
    statementGroup: 'COST_OF_SALES',
    normalBalance: 'DEBIT',
    sortOrder: 70,
  },
  {
    code: '7100',
    name: 'Operating Expenses',
    accountType: 'EXPENSE',
    statementGroup: 'OPERATING_EXPENSE',
    normalBalance: 'DEBIT',
    sortOrder: 75,
  },
  {
    code: '7400',
    name: 'Finance Costs & Income Tax',
    accountType: 'EXPENSE',
    statementGroup: 'OTHER_EXPENSE',
    normalBalance: 'DEBIT',
    sortOrder: 78,
  },
  // Internal control ledgers — never part of the statutory presentation.
  {
    code: '9000',
    name: 'Internal — Due From (control ledgers)',
    accountType: 'ASSET',
    statementGroup: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
    sortOrder: 90,
  },
  {
    code: '9010',
    name: 'Internal — Due To (control ledgers)',
    accountType: 'LIABILITY',
    statementGroup: 'CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
    sortOrder: 91,
  },
];

/**
 * The chart, in exact NFRS order. Class 1 (non-current assets) through class 7
 * (cost of sales and operating expenses), then the internal control ledgers.
 */
export const NFRS_CHART_ACCOUNTS: readonly NfrsChartAccount[] = [
  // -------------------------------------------------------------------------
  // CLASS 1: NON-CURRENT ASSETS (1000 – 1999)
  // -------------------------------------------------------------------------
  {
    code: '1000',
    name: 'Property, Plant, and Equipment (PPE)',
    groupCode: '1000',
    statutoryReference: 'NAS 16',
    note: 'PPE at cost. Directly capitalised fixed assets the register cannot split by class post here (FIXED_ASSET role).',
    postingRole: 'FIXED_ASSET',
  },
  {
    code: '1010',
    name: 'Freehold Land',
    groupCode: '1000',
    statutoryReference: 'NAS 16',
    note: 'Land is never depreciated; keep it out of every depreciation run.',
  },
  {
    code: '1020',
    name: 'Buildings and Civil Structures',
    groupCode: '1000',
    statutoryReference: 'NAS 16',
    note: 'Building shells, civil works and leasehold improvements charged to PPE.',
  },
  {
    code: '1030',
    name: 'Plant, Machinery, and Equipment',
    groupCode: '1000',
    statutoryReference: 'NAS 16',
    note: 'Network plant and equipment, including CPE issued from branch stock (CPE_ASSET role).',
    postingRole: 'CPE_ASSET',
  },
  {
    code: '1040',
    name: 'Vehicles and Transport Equipment',
    groupCode: '1000',
    statutoryReference: 'NAS 16',
    note: 'Motorcycles, vans and field vehicles owned by the company.',
  },
  {
    code: '1050',
    name: 'Furniture, Fixtures, and Office Equipment',
    groupCode: '1000',
    statutoryReference: 'NAS 16',
    note: 'Office furniture, air conditioners, UPS units and similar fixtures.',
  },
  {
    code: '1060',
    name: 'Capital Work-in-Progress (CWIP)',
    groupCode: '1000',
    statutoryReference: 'NAS 16',
    note: 'Costs accumulated on assets not yet placed in service; transfer to the class on capitalisation.',
  },
  {
    code: '1090',
    name: 'Accumulated Depreciation & Impairment – PPE (Contra)',
    groupCode: '1000',
    statutoryReference: 'NAS 16 / NAS 36',
    note: 'Credit-normal contra-asset. The depreciation run increases it; a disposal clears it (ACCUMULATED_DEPRECIATION role).',
    postingRole: 'ACCUMULATED_DEPRECIATION',
  },
  {
    code: '1100',
    name: 'Right-of-Use (ROU) Assets & Investment Property',
    groupCode: '1000',
    statutoryReference: 'NFRS 16 / NAS 40',
    note: 'Headline for leased and investment property; post ROU assets to 1110 and investment property to 1130.',
  },
  {
    code: '1110',
    name: 'Right-of-Use Assets – Leased Properties & Vehicles',
    groupCode: '1000',
    statutoryReference: 'NFRS 16',
    note: 'Leased premises and vehicles recognised at present value of lease payments.',
  },
  {
    code: '1120',
    name: 'Accumulated Depreciation – ROU Assets (Contra)',
    groupCode: '1000',
    statutoryReference: 'NFRS 16',
    normalBalance: 'CREDIT',
    note: 'Credit-normal contra-asset for ROU depreciation; never receives a debit except on derecognition.',
  },
  {
    code: '1130',
    name: 'Investment Property',
    groupCode: '1000',
    statutoryReference: 'NAS 40',
    note: 'Property held for rental or capital appreciation, measured under the policy in the notes.',
  },
  {
    code: '1200',
    name: 'Intangible Assets and Goodwill',
    groupCode: '1000',
    statutoryReference: 'NAS 38 / NFRS 3',
    note: 'Headline for intangibles; post goodwill to 1210 and software/licences to 1220.',
  },
  {
    code: '1210',
    name: 'Goodwill',
    groupCode: '1000',
    statutoryReference: 'NFRS 3 / NAS 36',
    note: 'Only from a business combination; tested for impairment annually, never amortised.',
  },
  {
    code: '1220',
    name: 'Computer Software, Licenses, and Patents',
    groupCode: '1000',
    statutoryReference: 'NAS 38',
    note: 'Billing systems, OSS/BSS licences and capitalised software development.',
  },
  {
    code: '1290',
    name: 'Accumulated Amortization – Intangible Assets (Contra)',
    groupCode: '1000',
    statutoryReference: 'NAS 38',
    normalBalance: 'CREDIT',
    note: 'Credit-normal contra-asset for amortisation of intangibles.',
  },
  {
    code: '1300',
    name: 'Long-Term Financial Assets & Other Non-Current Assets',
    groupCode: '1000',
    statutoryReference: 'NFRS 9 / NAS 12',
    note: 'Headline for long-term investments, deposits and deferred tax assets.',
  },
  {
    code: '1310',
    name: 'Investments in Subsidiaries, Associates & Joint Ventures',
    groupCode: '1000',
    statutoryReference: 'NAS 27 / NAS 28',
    note: 'Equity-method and cost-method holdings; consolidated under NFRS 10.',
  },
  {
    code: '1320',
    name: 'Long-Term Financial Investments (FVOCI / Amortized Cost)',
    groupCode: '1000',
    statutoryReference: 'NFRS 9',
    note: 'Long-dated bonds, units and shares at FVOCI or amortised cost.',
  },
  {
    code: '1330',
    name: 'Long-Term Security Deposits (NEA, Telecom, Rent)',
    groupCode: '1000',
    statutoryReference: 'NFRS 9',
    note: 'Deposits with NEA, telecom carriers and landlords recoverable after one year.',
  },
  {
    code: '1340',
    name: 'Deferred Tax Assets',
    groupCode: '1000',
    statutoryReference: 'NAS 12',
    note: 'Deductible temporary differences and unused tax losses, recognised only when recovery is probable.',
  },

  // -------------------------------------------------------------------------
  // CLASS 2: CURRENT ASSETS (2000 – 2999)
  // -------------------------------------------------------------------------
  {
    code: '2000',
    name: 'Inventories',
    groupCode: '2000',
    statutoryReference: 'NAS 2',
    note: 'Headline for stock; post trading stock to 2030 and consumables to 2010.',
  },
  {
    code: '2010',
    name: 'Raw Materials and Consumables',
    groupCode: '2000',
    statutoryReference: 'NAS 2',
    note: 'Cable, connectors, splitters and other consumables issued to field work.',
  },
  {
    code: '2020',
    name: 'Work-in-Progress (WIP)',
    groupCode: '2000',
    statutoryReference: 'NAS 2',
    note: 'Installation work partly delivered and not yet billable.',
  },
  {
    code: '2030',
    name: 'Finished Goods and Trading Merchandise',
    groupCode: '2000',
    statutoryReference: 'NAS 2',
    note: 'Branch stock held for sale at weighted-average cost; the INVENTORY control (INVENTORY role).',
    postingRole: 'INVENTORY',
  },
  {
    code: '2040',
    name: 'Goods in Transit (Imports / LC Margin)',
    groupCode: '2000',
    statutoryReference: 'NAS 2',
    note: 'Value moving between branches before receipt, and imports cleared but not landed (INTER_BRANCH_CLEARING role).',
    postingRole: 'INTER_BRANCH_CLEARING',
  },
  {
    code: '2090',
    name: 'Allowance for Inventory Obsolescence / Write-Down (Contra)',
    groupCode: '2000',
    statutoryReference: 'NAS 2',
    normalBalance: 'CREDIT',
    note: 'Credit-normal contra-inventory for net-realizable-value write-downs.',
  },
  {
    code: '2100',
    name: 'Trade and Other Receivables',
    groupCode: '2000',
    statutoryReference: 'NFRS 15 / NFRS 9',
    note: 'Headline for receivable balances; customer control sits in 2110.',
  },
  {
    code: '2110',
    name: 'Trade Receivables – Domestic & Export',
    groupCode: '2000',
    statutoryReference: 'NFRS 15 / NFRS 9',
    note: 'Customer control account with the customer subledger; every sales invoice debits it (AR_CONTROL role).',
    postingRole: 'AR_CONTROL',
    isControl: true,
    subledgerType: 'CUSTOMER',
  },
  {
    code: '2120',
    name: 'Allowance for Expected Credit Losses (ECL) (Contra)',
    groupCode: '2000',
    statutoryReference: 'NFRS 9',
    normalBalance: 'CREDIT',
    note: 'Credit-normal contra-receivable; the ECL charge itself is expensed at 7360.',
  },
  {
    code: '2130',
    name: 'Advances to Suppliers and Contractors',
    groupCode: '2000',
    statutoryReference: 'NAS 1',
    note: 'Prepayments to vendors and contractors before goods or services are received.',
  },
  {
    code: '2140',
    name: 'Staff Advances and Prepayments',
    groupCode: '2000',
    statutoryReference: 'NAS 1',
    note: 'Salary advances recovered through payroll; employee control with the employee subledger (EMPLOYEE_ADVANCE role).',
    postingRole: 'EMPLOYEE_ADVANCE',
    isControl: true,
    subledgerType: 'EMPLOYEE',
  },
  {
    code: '2150',
    name: 'Prepaid Expenses (Insurance, Rent, Subscriptions)',
    groupCode: '2000',
    statutoryReference: 'NAS 1',
    note: 'Costs paid before the period they belong to; amortise monthly.',
  },
  {
    code: '2200',
    name: 'Tax Receivables & Statutory Credits (Nepal IRD)',
    groupCode: '2000',
    statutoryReference: 'NAS 12 / Nepal Tax Acts',
    note: 'Headline for IRD credits; VAT input sits in 2210.',
  },
  {
    code: '2210',
    name: 'VAT Receivable / Input VAT Credit',
    groupCode: '2000',
    statutoryReference: 'Nepal IRD VAT Act 2052',
    note: 'Input VAT claimable against output VAT; purchases debit it (TAX_INPUT role).',
    postingRole: 'TAX_INPUT',
  },
  {
    code: '2220',
    name: 'Advance Income Tax Paid (Installments)',
    groupCode: '2000',
    statutoryReference: 'Nepal IRD Income Tax Act 2058 / NAS 12',
    note: 'Quarterly advance tax installments, offset against the year-end tax charge.',
  },
  {
    code: '2230',
    name: 'TDS Receivable (Withheld by Customers)',
    groupCode: '2000',
    statutoryReference: 'Nepal IRD Income Tax Act 2058 / NAS 12',
    note: 'TDS customers withheld from our invoices; claim it on the annual return.',
  },
  {
    code: '2300',
    name: 'Cash and Cash Equivalents',
    groupCode: '2000',
    statutoryReference: 'NAS 7',
    note: 'Headline for cash, bank and short deposits; custody ledgers are 2310–2340.',
  },
  {
    code: '2310',
    name: 'Petty Cash and Cash on Hand (NPR)',
    groupCode: '2000',
    statutoryReference: 'NAS 7',
    note: 'Till and petty cash. A CASH-kind ledger: receipts debit, payments credit (CASH role).',
    postingRole: 'CASH',
    accountKind: 'CASH',
  },
  {
    code: '2320',
    name: 'Bank Current & Call Accounts (NPR)',
    groupCode: '2000',
    statutoryReference: 'NAS 7',
    note: 'Local current accounts. A BANK-kind ledger for every non-cash settlement method (BANK role).',
    postingRole: 'BANK',
    accountKind: 'BANK',
  },
  {
    code: '2330',
    name: 'Foreign Currency Bank Accounts (FCY)',
    groupCode: '2000',
    statutoryReference: 'NAS 7 / NAS 21',
    note: 'FCY accounts; retranslate at closing rate and post the difference to 6120/7440.',
  },
  {
    code: '2340',
    name: 'Short-Term Fixed Deposits (≤ 3 Months Maturity)',
    groupCode: '2000',
    statutoryReference: 'NAS 7',
    note: 'Deposits maturing within three months; interest accrues to 6110.',
  },

  // -------------------------------------------------------------------------
  // CLASS 3: EQUITY (3000 – 3999)
  // -------------------------------------------------------------------------
  {
    code: '3000',
    name: 'Share Capital and Reserves',
    groupCode: '3000',
    statutoryReference: 'NAS 1 / Companies Act 2063',
    note: 'Headline equity section; share capital, reserves and retained earnings sit below.',
  },
  {
    code: '3010',
    name: 'Issued and Paid-Up Ordinary Share Capital',
    groupCode: '3000',
    statutoryReference: 'NAS 1 / NAS 32',
    note: 'Only capital actually issued and paid up; applications pending allotment stay in 3020.',
  },
  {
    code: '3020',
    name: 'Calls in Advance / Share Application Money Pending Allotment',
    groupCode: '3000',
    statutoryReference: 'Companies Act 2063',
    note: 'Money received before allotment; reclassify to 3010/3030 when shares are issued.',
  },
  {
    code: '3030',
    name: 'Share Premium',
    groupCode: '3000',
    statutoryReference: 'NAS 1 / Companies Act 2063',
    note: 'Consideration above par; not available for dividend distribution.',
  },
  {
    code: '3100',
    name: 'Retained Earnings / Accumulated Profit or Loss',
    groupCode: '3000',
    statutoryReference: 'NAS 1',
    note: 'The year-end close moves every P&L balance here (RETAINED_EARNINGS role).',
    postingRole: 'RETAINED_EARNINGS',
  },
  {
    code: '3200',
    name: 'Revaluation Reserve (PPE)',
    groupCode: '3000',
    statutoryReference: 'NAS 16',
    note: 'Surplus on revaluation of PPE; released to retained earnings as the asset is used.',
  },
  {
    code: '3210',
    name: 'Fair Value Reserve (FVOCI Financial Assets)',
    groupCode: '3000',
    statutoryReference: 'NFRS 9',
    note: 'Unrealised fair-value movement on FVOCI holdings, recycled only on derecognition.',
  },
  {
    code: '3220',
    name: 'Actuarial Gain / Loss Reserve (OCI)',
    groupCode: '3000',
    statutoryReference: 'NAS 19',
    note: 'Remeasurements of gratuity and leave obligations; never recycled to profit or loss.',
  },
  {
    code: '3230',
    name: 'Statutory / General Reserves (NRB / Regulatory)',
    groupCode: '3000',
    statutoryReference: 'NAS 1',
    note: 'Reserves required by a regulator or created by shareholder resolution.',
  },
  {
    code: '3300',
    name: 'Non-Controlling Interests (NCI)',
    groupCode: '3000',
    statutoryReference: 'NFRS 10',
    note: 'The minority share of a subsidiary’s net assets in the consolidated statements.',
  },

  // -------------------------------------------------------------------------
  // CLASS 4: NON-CURRENT LIABILITIES (4000 – 4999)
  // -------------------------------------------------------------------------
  {
    code: '4000',
    name: 'Long-Term Borrowings & Lease Liabilities',
    groupCode: '4000',
    statutoryReference: 'NFRS 9 / NFRS 16',
    note: 'Headline for borrowings repayable after one year; the current portion moves to 5130.',
  },
  {
    code: '4010',
    name: 'Long-Term Bank Loans and Term Facilities',
    groupCode: '4000',
    statutoryReference: 'NFRS 9',
    note: 'Lender control with the lender subledger; a loan receipt credits it (LOAN_PAYABLE role).',
    postingRole: 'LOAN_PAYABLE',
    isControl: true,
    subledgerType: 'LENDER',
  },
  {
    code: '4020',
    name: 'Debentures and Bonds Payable',
    groupCode: '4000',
    statutoryReference: 'NFRS 9',
    note: 'Issued debentures and bonds at amortised cost, net of issue costs.',
  },
  {
    code: '4030',
    name: 'Non-Current Lease Liabilities',
    groupCode: '4000',
    statutoryReference: 'NFRS 16',
    note: 'Lease liability beyond twelve months; the current portion is 5140.',
  },
  {
    code: '4100',
    name: 'Long-Term Provisions & Deferred Taxes',
    groupCode: '4000',
    statutoryReference: 'NAS 19 / NAS 37 / NAS 12',
    note: 'Headline for gratuity, long-term provisions and deferred tax liabilities.',
  },
  {
    code: '4110',
    name: 'Employee Gratuity & Accumulated Leave Liability (Non-Current)',
    groupCode: '4000',
    statutoryReference: 'NAS 19 / Labor Act 2074',
    note: 'Actuarial liability for gratuity and accumulated leave; the expense is 7130.',
  },
  {
    code: '4120',
    name: 'Long-Term Provisions (Decommissioning, Warranties)',
    groupCode: '4000',
    statutoryReference: 'NAS 37',
    note: 'Discounted decommissioning and warranty obligations beyond one year.',
  },
  {
    code: '4130',
    name: 'Deferred Tax Liabilities',
    groupCode: '4000',
    statutoryReference: 'NAS 12',
    note: 'Taxable temporary differences, mainly accelerated depreciation.',
  },

  // -------------------------------------------------------------------------
  // CLASS 5: CURRENT LIABILITIES (5000 – 5999)
  // -------------------------------------------------------------------------
  {
    code: '5000',
    name: 'Trade and Other Payables',
    groupCode: '5000',
    statutoryReference: 'NFRS 9 / NAS 1',
    note: 'Headline for payables; the supplier control sits in 5010.',
  },
  {
    code: '5010',
    name: 'Trade Payables – Local and Foreign Suppliers',
    groupCode: '5000',
    statutoryReference: 'NFRS 9',
    note: 'Supplier control with the supplier subledger; every purchase bill credits it (AP_CONTROL role).',
    postingRole: 'AP_CONTROL',
    isControl: true,
    subledgerType: 'SUPPLIER',
  },
  {
    code: '5020',
    name: 'Accrued Expenses and Utility Bills Payable',
    groupCode: '5000',
    statutoryReference: 'NAS 1 / NAS 37',
    note: 'Accrued expenses, including lender interest accrued but not yet paid.',
  },
  {
    code: '5030',
    name: 'Contract Liabilities / Unearned Customer Advances',
    groupCode: '5000',
    statutoryReference: 'NFRS 15',
    note: 'Customer money received before the service period; release it as revenue is earned.',
  },
  {
    code: '5040',
    name: 'Dividends Payable',
    groupCode: '5000',
    statutoryReference: 'NAS 10 / Companies Act 2063',
    note: 'Declared dividends not yet paid; recognise only once the declaration is approved.',
  },
  {
    code: '5100',
    name: 'Short-Term Borrowings & Current Lease Liabilities',
    groupCode: '5000',
    statutoryReference: 'NFRS 9 / NFRS 16',
    note: 'Headline for facilities and lease amounts due within twelve months.',
  },
  {
    code: '5110',
    name: 'Bank Overdraft, Cash Credit (CC) & Working Capital Loans',
    groupCode: '5000',
    statutoryReference: 'NFRS 9',
    note: 'Overdraft and cash-credit balances; never net them against a positive bank balance.',
  },
  {
    code: '5120',
    name: 'Trust Receipt (TR) / Short-Term Import Loans',
    groupCode: '5000',
    statutoryReference: 'NFRS 9',
    note: 'Import financing secured against documents in transit.',
  },
  {
    code: '5130',
    name: 'Current Portion of Long-Term Borrowings',
    groupCode: '5000',
    statutoryReference: 'NAS 1 / NFRS 9',
    note: 'The part of a term loan due within twelve months, reclassified from 4010.',
  },
  {
    code: '5140',
    name: 'Current Lease Liabilities',
    groupCode: '5000',
    statutoryReference: 'NFRS 16',
    note: 'Lease payments due within twelve months.',
  },
  {
    code: '5200',
    name: 'Statutory Taxes, SSF & Employee Payables (Nepal)',
    groupCode: '5000',
    statutoryReference: 'Nepal Tax & Labor Acts',
    note: 'Headline for IRD, SSF and payroll payables; each scheme has its own line.',
  },
  {
    code: '5210',
    name: 'VAT Payable / Output VAT',
    groupCode: '5000',
    statutoryReference: 'Nepal IRD VAT Act 2052',
    note: 'Output VAT collected on sales; a sale credits it (TAX_OUTPUT role). Settle against 2210 monthly.',
    postingRole: 'TAX_OUTPUT',
  },
  {
    code: '5220',
    name: 'TDS Payable – Salary (Social Security Tax & Income Tax)',
    groupCode: '5000',
    statutoryReference: 'Nepal IRD Income Tax Act 2058',
    note: 'Salary TDS withheld, tracked per employee in the employee subledger (TDS_PAYABLE role).',
    postingRole: 'TDS_PAYABLE',
    isControl: true,
    subledgerType: 'EMPLOYEE',
  },
  {
    code: '5230',
    name: 'TDS Payable – Vendors, Rent, Audit & Service Fees',
    groupCode: '5000',
    statutoryReference: 'Nepal IRD Income Tax Act 2058',
    note: 'Withholding on vendor bills, rent, audit and professional fees, including lender interest TDS.',
  },
  {
    code: '5240',
    name: 'Current Corporate Income Tax Provision / Payable',
    groupCode: '5000',
    statutoryReference: 'Nepal IRD NAS 12 / Income Tax Act',
    note: 'The year’s tax charge not yet paid; settle against advance tax in 2220.',
  },
  {
    code: '5250',
    name: 'Social Security Fund (SSF) Payable (31% Total Contribution)',
    groupCode: '5000',
    statutoryReference: 'SSF Nepal Social Security Act 2074',
    note: 'Employee plus employer SSF contribution owed to the fund (SSF_PAYABLE role, employee subledger).',
    postingRole: 'SSF_PAYABLE',
    isControl: true,
    subledgerType: 'EMPLOYEE',
  },
  {
    code: '5260',
    name: 'Provident Fund (EPF) & Citizen Investment Trust (CIT) Payable',
    groupCode: '5000',
    statutoryReference: 'Nepal NAS 19 / Labor Act 2074',
    note: 'Retirement contributions withheld for EPF/CIT, remitted monthly.',
  },
  {
    code: '5270',
    name: 'Salaries and Wages Payable',
    groupCode: '5000',
    statutoryReference: 'NAS 19',
    note: 'Net pay owed after deductions; payroll credits it and payment clears it (SALARY_PAYABLE role).',
    postingRole: 'SALARY_PAYABLE',
    isControl: true,
    subledgerType: 'EMPLOYEE',
  },
  {
    code: '5280',
    name: 'Statutory Staff Bonus Payable (10% Allocation)',
    groupCode: '5000',
    statutoryReference: 'Bonus Act 2030 / NAS 19',
    note: 'Bonus accrued under the Bonus Act and paid within the statutory window.',
  },

  // -------------------------------------------------------------------------
  // CLASS 6: REVENUE AND OTHER INCOME (6000 – 6999)
  // -------------------------------------------------------------------------
  {
    code: '6000',
    name: 'Revenue from Contracts with Customers',
    groupCode: '6000',
    statutoryReference: 'NFRS 15',
    note: 'Headline revenue; recognise over time or at a point in time per the contract.',
  },
  {
    code: '6010',
    name: 'Domestic Sales Revenue – Goods / Products',
    groupCode: '6000',
    statutoryReference: 'NFRS 15',
    note: 'Gross revenue from goods sold. A sales invoice credits it at total less VAT (SALES role).',
    postingRole: 'SALES',
  },
  {
    code: '6020',
    name: 'Export Sales Revenue',
    groupCode: '6000',
    statutoryReference: 'NFRS 15',
    note: 'Zero-rated export sales; keep them separate for VAT returns.',
  },
  {
    code: '6030',
    name: 'Service and Consulting Fee Revenue',
    groupCode: '6000',
    statutoryReference: 'NFRS 15',
    note: 'Installation, subscription and consulting income recognised as the service is delivered.',
  },
  {
    code: '6090',
    name: 'Sales Returns, Rebates, and Trade Discounts (Contra)',
    groupCode: '6000',
    statutoryReference: 'NFRS 15',
    note: 'Debit-normal contra-revenue. A sales return debits it (SALES_RETURNS role) so gross sales stay intact.',
    postingRole: 'SALES_RETURNS',
  },
  {
    code: '6100',
    name: 'Other Operating & Finance Income',
    groupCode: '6100',
    statutoryReference: 'NAS 1 / NFRS 9 / NAS 21',
    note: 'Headline for non-trading income; keep it out of the revenue from contracts line.',
  },
  {
    code: '6110',
    name: 'Interest Income on Bank Deposits and Investments',
    groupCode: '6100',
    statutoryReference: 'NFRS 9',
    note: 'Deposit and investment interest on an effective-interest basis.',
  },
  {
    code: '6120',
    name: 'Foreign Exchange Gain (Realized & Unrealized)',
    groupCode: '6100',
    statutoryReference: 'NAS 21',
    note: 'FX gains on FCY balances and settlements; the loss side is 7440.',
  },
  {
    code: '6130',
    name: 'Gain on Disposal of Property, Plant & Equipment',
    groupCode: '6100',
    statutoryReference: 'NAS 16',
    note: 'Proceeds above net book value on disposal (GAIN_ON_DISPOSAL role).',
    postingRole: 'GAIN_ON_DISPOSAL',
  },
  {
    code: '6140',
    name: 'Scrap Sales and Miscellaneous Operating Income',
    groupCode: '6100',
    statutoryReference: 'NAS 1',
    note: 'Scrap, salvage and small incidental income that is not contract revenue.',
  },

  // -------------------------------------------------------------------------
  // CLASS 7: COST OF SALES AND OPERATING EXPENSES (7000 – 7999)
  // -------------------------------------------------------------------------
  {
    code: '7000',
    name: 'Cost of Sales / Direct Production Costs',
    groupCode: '7000',
    statutoryReference: 'NAS 2',
    note: 'Cost of stock sold at weighted-average cost; a sale debits it (COGS role).',
    postingRole: 'COGS',
  },
  {
    code: '7010',
    name: 'Raw Materials and Merchandise Consumed',
    groupCode: '7000',
    statutoryReference: 'NAS 2',
    note: 'Materials consumed, where a job-cost view is needed instead of a single COGS line.',
  },
  {
    code: '7020',
    name: 'Customs Duty, Freight Inward & Clearing Charges',
    groupCode: '7000',
    statutoryReference: 'NAS 2',
    note: 'Landed cost of imported stock: duty, freight and clearing agent charges.',
  },
  {
    code: '7030',
    name: 'Direct Factory Wages and Subcontracting Costs',
    groupCode: '7000',
    statutoryReference: 'NAS 2 / NAS 19',
    note: 'Direct labour and subcontracting that vary with what is produced or installed.',
  },
  {
    code: '7040',
    name: 'Factory Power, Fuel, and Manufacturing Overheads',
    groupCode: '7000',
    statutoryReference: 'NAS 2',
    note: 'Power, fuel and overhead absorbed into production cost.',
  },
  {
    code: '7050',
    name: 'Inventory Write-Down and Obsolete Stock Expense',
    groupCode: '7000',
    statutoryReference: 'NAS 2',
    note: 'Damage, shrinkage, consumable issues and stock adjustments post here (STOCK_EXPENSE role).',
    postingRole: 'STOCK_EXPENSE',
  },
  {
    code: '7100',
    name: 'Employee Benefits & Statutory Staff Costs',
    groupCode: '7100',
    statutoryReference: 'NAS 19 / Labor & Bonus Acts',
    note: 'Headline for staff cost; salaries, SSF, gratuity, welfare and bonus sit below.',
  },
  {
    code: '7110',
    name: 'Salaries, Basic Pay, and Dearness Allowances',
    groupCode: '7100',
    statutoryReference: 'NAS 19 / Labor Act 2074',
    note: 'Gross wages plus the employer SSF share for a payroll run (SALARY_EXPENSE role).',
    postingRole: 'SALARY_EXPENSE',
  },
  {
    code: '7120',
    name: 'Employer Contribution to Social Security Fund (20% SSF)',
    groupCode: '7100',
    statutoryReference: 'SSF Nepal Social Security Act 2074',
    note: 'The employer’s own SSF share when it is presented separately from gross wages.',
  },
  {
    code: '7130',
    name: 'Gratuity and Leave Encashment Expense',
    groupCode: '7100',
    statutoryReference: 'NAS 19 / Labor Act 2074',
    note: 'Current-service cost and interest on the gratuity/leave liability (4110).',
  },
  {
    code: '7140',
    name: 'Staff Welfare, Medical Insurance & Training',
    groupCode: '7100',
    statutoryReference: 'NAS 19',
    note: 'Canteen, medical cover, uniforms and staff training.',
  },
  {
    code: '7150',
    name: 'Statutory Staff Bonus Expense (10% of Net Profit)',
    groupCode: '7100',
    statutoryReference: 'Bonus Act 2030 / NAS 19',
    note: 'Bonus charge for the year; the unpaid amount is 5280.',
  },
  {
    code: '7200',
    name: 'Depreciation, Amortization & Impairment',
    groupCode: '7100',
    statutoryReference: 'NAS 16 / NFRS 16 / NAS 38',
    note: 'Headline for non-cash charges; each asset class has its own line.',
  },
  {
    code: '7210',
    name: 'Depreciation on Property, Plant, and Equipment',
    groupCode: '7100',
    statutoryReference: 'NAS 16',
    note: 'The register’s depreciation run debits this and increases 1090 (DEPRECIATION_EXPENSE role).',
    postingRole: 'DEPRECIATION_EXPENSE',
  },
  {
    code: '7220',
    name: 'Depreciation on Right-of-Use (ROU) Assets',
    groupCode: '7100',
    statutoryReference: 'NFRS 16',
    note: 'Straight-line depreciation of ROU assets over the lease term.',
  },
  {
    code: '7230',
    name: 'Amortization of Intangible Assets',
    groupCode: '7100',
    statutoryReference: 'NAS 38',
    note: 'Amortisation of software, licences and other finite-life intangibles.',
  },
  {
    code: '7240',
    name: 'Impairment Loss on Non-Financial Assets',
    groupCode: '7100',
    statutoryReference: 'NAS 36',
    note: 'Impairment of PPE/intangibles. Also holds a disposal loss, which the standard chart has no separate line for (LOSS_ON_DISPOSAL role).',
    postingRole: 'LOSS_ON_DISPOSAL',
  },
  {
    code: '7300',
    name: 'Administrative, Selling & General Operating Expenses',
    groupCode: '7100',
    statutoryReference: 'NAS 1',
    note: 'General overhead bucket for expenses with no dedicated line.',
  },
  {
    code: '7310',
    name: 'Short-Term Rent, Rates, and Local Municipality Taxes',
    groupCode: '7100',
    statutoryReference: 'NFRS 16 / NAS 1',
    note: 'Short-term and low-value leases, municipal rates and local taxes.',
  },
  {
    code: '7320',
    name: 'Electricity, Water, Internet, and Communication',
    groupCode: '7100',
    statutoryReference: 'NAS 1',
    note: 'Office utilities and communication costs, excluding network cost of sales.',
  },
  {
    code: '7330',
    name: 'Legal, Statutory Audit, and Professional Consultancy Fees',
    groupCode: '7100',
    statutoryReference: 'NAS 1',
    note: 'Audit, legal and consultancy fees; withhold TDS at 5230 where applicable.',
  },
  {
    code: '7340',
    name: 'Repairs, Maintenance, and Fuel',
    groupCode: '7100',
    statutoryReference: 'NAS 1',
    note: 'Repairs that do not extend an asset’s life, plus vehicle fuel.',
  },
  {
    code: '7350',
    name: 'Advertising, Marketing, and Business Promotion',
    groupCode: '7100',
    statutoryReference: 'NAS 1',
    note: 'Campaigns, branding, dealer incentives and promotional spend.',
  },
  {
    code: '7360',
    name: 'Expected Credit Loss (ECL) / Bad Debt Expense',
    groupCode: '7100',
    statutoryReference: 'NFRS 9',
    note: 'The ECL charge for the period; the allowance itself sits in 2120.',
  },
  {
    code: '7370',
    name: 'Corporate Social Responsibility (CSR) Expense (1% Industrial)',
    groupCode: '7100',
    statutoryReference: 'IEA 2076 Industrial Enterprises Act',
    note: 'The statutory CSR spend; keep the 1% computation in the notes.',
  },
  {
    code: '7400',
    name: 'Finance Costs & Income Tax Expense',
    groupCode: '7400',
    statutoryReference: 'NAS 23 / NFRS 16 / NAS 12',
    note: 'Headline below operating profit: borrowing cost, FX loss and tax.',
  },
  {
    code: '7410',
    name: 'Interest on Bank Loans, Overdrafts, and Debentures',
    groupCode: '7400',
    statutoryReference: 'NFRS 9 / NAS 23',
    note: 'Borrowing interest on an effective-interest basis; the lender module books interest here.',
  },
  {
    code: '7420',
    name: 'Interest Expense on Lease Liabilities',
    groupCode: '7400',
    statutoryReference: 'NFRS 16',
    note: 'Unwinding of the lease liability; separates from depreciation at 7220.',
  },
  {
    code: '7430',
    name: 'Bank Charges, LC Commission, and Guarantee Fees',
    groupCode: '7400',
    statutoryReference: 'NFRS 9',
    note: 'Bank charges, LC commission, guarantee fees and provider settlement fees (PAYMENT_FEE_EXPENSE role).',
    postingRole: 'PAYMENT_FEE_EXPENSE',
  },
  {
    code: '7440',
    name: 'Foreign Exchange Loss (Realized & Unrealized)',
    groupCode: '7400',
    statutoryReference: 'NAS 21',
    note: 'FX losses on FCY balances and settlements; the gain side is 6120.',
  },
  {
    code: '7510',
    name: 'Current Corporate Income Tax Expense',
    groupCode: '7400',
    statutoryReference: 'Nepal IRD NAS 12 / Income Tax Act',
    note: 'Current-year tax charge; the unpaid part is 5240.',
  },
  {
    code: '7520',
    name: 'Deferred Tax Expense / (Benefit)',
    groupCode: '7400',
    statutoryReference: 'NAS 12',
    note: 'Movement in deferred tax assets (1340) and liabilities (4130).',
  },

  // -------------------------------------------------------------------------
  // INTERNAL CONTROL LEDGERS — not part of the NFRS presentation
  // -------------------------------------------------------------------------
  {
    code: '9000',
    name: 'Due from Head Office & Branches (Internal Control)',
    groupCode: '9000',
    statutoryReference: 'Internal control ledger — not a statutory account',
    note: 'Asset side of an inter-branch transfer, per counterparty branch. A dispatch debits it (DUE_FROM_HO role).',
    postingRole: 'DUE_FROM_HO',
    isControl: true,
    subledgerType: 'INTER_BRANCH',
  },
  {
    code: '9010',
    name: 'Due to Head Office & Branches (Internal Control)',
    groupCode: '9010',
    statutoryReference: 'Internal control ledger — not a statutory account',
    note: 'Liability side of an inter-branch transfer, per counterparty branch. A receipt credits it (DUE_TO_HO role).',
    postingRole: 'DUE_TO_HO',
    isControl: true,
    subledgerType: 'INTER_BRANCH',
  },
  {
    code: '9020',
    name: 'Staff Loans (Internal Control)',
    groupCode: '9000',
    statutoryReference: 'Internal control ledger — not a statutory account',
    note: 'Loans to employees recovered through payroll, per employee. NFRS has no separate staff-loan line (EMPLOYEE_LOAN role).',
    postingRole: 'EMPLOYEE_LOAN',
    isControl: true,
    subledgerType: 'EMPLOYEE',
  },
  {
    code: '9030',
    name: 'eSewa Wallet Clearing (Internal Control)',
    groupCode: '9000',
    statutoryReference: 'Internal control ledger — not a statutory account',
    note: 'Gross eSewa receipts awaiting provider settlement; reconciled to the provider statement.',
    accountKind: 'WALLET',
    providerCode: 'ESEWA',
  },
  {
    code: '9040',
    name: 'Khalti Wallet Clearing (Internal Control)',
    groupCode: '9000',
    statutoryReference: 'Internal control ledger — not a statutory account',
    note: 'Gross Khalti receipts awaiting provider settlement; reconciled to the provider statement.',
    accountKind: 'WALLET',
    providerCode: 'KHALTI',
  },
  {
    code: '9050',
    name: 'Nepal Pay Wallet Clearing (Internal Control)',
    groupCode: '9000',
    statutoryReference: 'Internal control ledger — not a statutory account',
    note: 'Gross Nepal Pay receipts awaiting provider settlement; reconciled to the provider statement.',
    accountKind: 'WALLET',
    providerCode: 'NEPAL_PAY',
  },
];
