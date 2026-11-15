/**
 * Human-readable catalogue of the automated posting rules.
 *
 * The debit/credit shape is fixed by the posting services; account selection is
 * never fixed here. Each line names posting roles, and the screen resolves them
 * against the live `posting-defaults` payload, so a remapped ledger shows up
 * immediately and a missing role is visible before a document is refused.
 */
export type PostingRuleGroup =
  | 'SALES'
  | 'PURCHASES'
  | 'INVENTORY'
  | 'PAYROLL'
  | 'ASSETS';

export type PostingRuleSide = 'DEBIT' | 'CREDIT';

export interface PostingRuleLine {
  side: PostingRuleSide;
  label: string;
  /** One of these roles supplies the account; a one-of line needs one mapped. */
  roles: string[];
  /** Shown when the line only exists for part of the document. */
  condition?: string;
  /** A missing role does not block the whole rule (e.g. gain vs loss). */
  optional?: boolean;
  /** At least one of `roles` must be mapped instead of every role. */
  oneOf?: boolean;
}

export interface PostingRule {
  id: string;
  group: PostingRuleGroup;
  name: string;
  description: string;
  source: string;
  lines: PostingRuleLine[];
  note?: string;
}

export interface PostingRuleGroupMeta {
  id: PostingRuleGroup;
  label: string;
  description: string;
}

export const POSTING_RULE_GROUPS: readonly PostingRuleGroupMeta[] = [
  {
    id: 'SALES',
    label: 'Sales & receivables',
    description: 'Customer invoices, returns and money received.',
  },
  {
    id: 'PURCHASES',
    label: 'Purchases & payables',
    description: 'Supplier bills, returns and money paid.',
  },
  {
    id: 'INVENTORY',
    label: 'Inventory & transfers',
    description: 'Stock value, CPE deployment and inter-branch custody.',
  },
  {
    id: 'PAYROLL',
    label: 'Payroll',
    description: 'Salary cost, statutory deductions and payment.',
  },
  {
    id: 'ASSETS',
    label: 'Fixed assets',
    description: 'Capitalisation, depreciation and disposal.',
  },
];

export const POSTING_RULES: readonly PostingRule[] = [
  {
    id: 'sales-invoice',
    group: 'SALES',
    name: 'Sales invoice',
    description:
      'Raises the customer receivable and recognises revenue, output VAT and the cost of the stock issued.',
    source: 'Sales invoice posting',
    lines: [
      {
        side: 'DEBIT',
        label: 'Customer receivable',
        roles: ['AR_CONTROL'],
        condition: 'Invoice total',
      },
      {
        side: 'CREDIT',
        label: 'Sales revenue',
        roles: ['SALES'],
        condition: 'Total less VAT',
      },
      {
        side: 'CREDIT',
        label: 'Output VAT payable',
        roles: ['TAX_OUTPUT'],
        condition: 'VAT greater than zero',
      },
      {
        side: 'DEBIT',
        label: 'Cost of goods sold',
        roles: ['COGS'],
        condition: 'Stock cost greater than zero',
      },
      {
        side: 'CREDIT',
        label: 'Inventory relieved',
        roles: ['INVENTORY'],
        condition: 'Stock cost greater than zero',
      },
    ],
    note:
      'The AR line writes a customer subledger row. COGS and inventory use the weighted-average cost recorded by the stock movement, never a product master guess.',
  },
  {
    id: 'sales-return',
    group: 'SALES',
    name: 'Sales return',
    description:
      'Reverses the original sale and restores sellable stock at the exact issue cost.',
    source: 'Sales return posting',
    lines: [
      { side: 'DEBIT', label: 'Sales revenue reversed', roles: ['SALES'] },
      {
        side: 'DEBIT',
        label: 'Output VAT reversed',
        roles: ['TAX_OUTPUT'],
        condition: 'VAT greater than zero',
      },
      {
        side: 'CREDIT',
        label: 'Customer credit',
        roles: ['AR_CONTROL'],
        condition: 'Return total',
      },
      {
        side: 'DEBIT',
        label: 'Inventory restored',
        roles: ['INVENTORY'],
        condition: 'Restockable goods',
      },
      {
        side: 'CREDIT',
        label: 'Cost of goods sold reversed',
        roles: ['COGS'],
        condition: 'Restockable goods',
      },
    ],
    note:
      'A damaged return that is not put back into sellable stock posts the revenue and receivable sides only.',
  },
  {
    id: 'customer-receipt',
    group: 'SALES',
    name: 'Customer receipt',
    description:
      'Records money received against a customer and clears the receivable in the customer book.',
    source: 'Customer receipt posting',
    lines: [
      {
        side: 'DEBIT',
        label: 'Till, bank or wallet clearing',
        roles: ['CASH', 'BANK'],
        condition: 'CASH uses the till; ONLINE uses provider clearing; every other method uses the bank',
        oneOf: true,
      },
      {
        side: 'CREDIT',
        label: 'Customer receivable cleared',
        roles: ['AR_CONTROL'],
      },
    ],
    note:
      'ONLINE receipts resolve the provider wallet clearing ledger directly by provider and branch. Refunds and chargebacks reverse or expense the movement instead of rewriting the original receipt.',
  },
  {
    id: 'purchase-invoice',
    group: 'PURCHASES',
    name: 'Purchase invoice',
    description:
      'Brings the supplier bill into inventory, input VAT and the supplier payable.',
    source: 'Purchase invoice posting',
    lines: [
      {
        side: 'DEBIT',
        label: 'Inventory received',
        roles: ['INVENTORY'],
        condition: 'Bill total less VAT',
      },
      {
        side: 'DEBIT',
        label: 'Input VAT recoverable',
        roles: ['TAX_INPUT'],
        condition: 'VAT greater than zero',
      },
      {
        side: 'CREDIT',
        label: 'Supplier payable',
        roles: ['AP_CONTROL'],
        condition: 'Bill total',
      },
    ],
    note:
      'The AP line writes a supplier subledger row. A missing INVENTORY, TAX_INPUT or AP_CONTROL role refuses the bill rather than posting an incomplete journal.',
  },
  {
    id: 'purchase-return',
    group: 'PURCHASES',
    name: 'Purchase return',
    description:
      'Reduces the supplier payable and takes the returned goods and input VAT out of the books.',
    source: 'Purchase return posting',
    lines: [
      { side: 'DEBIT', label: 'Supplier payable reduced', roles: ['AP_CONTROL'] },
      {
        side: 'CREDIT',
        label: 'Inventory returned',
        roles: ['INVENTORY'],
        condition: 'Return total less VAT',
      },
      {
        side: 'CREDIT',
        label: 'Input VAT reversed',
        roles: ['TAX_INPUT'],
        condition: 'VAT greater than zero',
      },
    ],
    note:
      'The return is mirrored against the payable, not booked as new expense, so the supplier statement and the control account stay aligned.',
  },
  {
    id: 'vendor-payment',
    group: 'PURCHASES',
    name: 'Vendor payment',
    description: 'Clears a supplier payable through the selected till or bank.',
    source: 'Vendor payment posting',
    lines: [
      { side: 'DEBIT', label: 'Supplier payable cleared', roles: ['AP_CONTROL'] },
      {
        side: 'CREDIT',
        label: 'Till or bank',
        roles: ['CASH', 'BANK'],
        condition: 'CASH uses the till; every other method uses the bank',
        oneOf: true,
      },
    ],
    note:
      'The selected settlement account must be active and of the right CASH/BANK kind. The payment is refused rather than silently falling back to another ledger.',
  },
  {
    id: 'stock-increase',
    group: 'INVENTORY',
    name: 'Stock increase',
    description:
      'Adds value for found stock, an exchange restock or a positive adjustment.',
    source: 'Stock value posting',
    lines: [
      { side: 'DEBIT', label: 'Inventory increased', roles: ['INVENTORY'] },
      { side: 'CREDIT', label: 'Stock expense reversed', roles: ['STOCK_EXPENSE'] },
    ],
    note:
      'The value uses the stock row moving weighted average. Stock quantity and ledger value move in the same transaction.',
  },
  {
    id: 'stock-decrease',
    group: 'INVENTORY',
    name: 'Stock decrease',
    description:
      'Removes value for damage, shrinkage, a pullout or a negative adjustment.',
    source: 'Stock value posting',
    lines: [
      { side: 'DEBIT', label: 'Stock expense', roles: ['STOCK_EXPENSE'] },
      { side: 'CREDIT', label: 'Inventory reduced', roles: ['INVENTORY'] },
    ],
    note:
      'A missing INVENTORY or STOCK_EXPENSE role refuses the stock document. The operation is never left with a quantity movement and no ledger effect.',
  },
  {
    id: 'transfer-dispatch',
    group: 'INVENTORY',
    name: 'Inter-branch dispatch',
    description:
      'The sending branch releases inventory and records a receivable from head office.',
    source: 'Transfer dispatch posting',
    lines: [
      {
        side: 'DEBIT',
        label: 'Due from head office',
        roles: ['DUE_FROM_HO'],
      },
      { side: 'CREDIT', label: 'Inventory released', roles: ['INVENTORY'] },
    ],
    note:
      'The DUE_FROM_HO line carries an INTER_BRANCH subledger row for the destination branch, so each branch closes on its own.',
  },
  {
    id: 'transfer-receipt',
    group: 'INVENTORY',
    name: 'Inter-branch receipt',
    description:
      'The receiving branch takes on inventory at the dispatch cost and records a payable to head office.',
    source: 'Transfer receipt posting',
    lines: [
      { side: 'DEBIT', label: 'Inventory received', roles: ['INVENTORY'] },
      { side: 'CREDIT', label: 'Due to head office', roles: ['DUE_TO_HO'] },
    ],
    note:
      'The receipt uses the issue cost stamped by dispatch, not the destination branch average, so the two legs cannot value the same goods differently.',
  },
  {
    id: 'cpe-issue',
    group: 'INVENTORY',
    name: 'CPE issue / release',
    description:
      'Moves customer-premises equipment between branch stock and deployed assets.',
    source: 'CPE asset posting',
    lines: [
      {
        side: 'DEBIT',
        label: 'Deployed CPE asset on issue',
        roles: ['CPE_ASSET'],
        condition: 'Issue',
      },
      {
        side: 'CREDIT',
        label: 'Inventory released on issue',
        roles: ['INVENTORY'],
        condition: 'Issue',
      },
      {
        side: 'DEBIT',
        label: 'Inventory returned on release',
        roles: ['INVENTORY'],
        condition: 'Release',
      },
      {
        side: 'CREDIT',
        label: 'CPE asset released',
        roles: ['CPE_ASSET'],
        condition: 'Release',
      },
    ],
    note:
      'The release reverses the recorded issue cost, so the asset register and inventory control never carry duplicate value.',
  },
  {
    id: 'payroll-run',
    group: 'PAYROLL',
    name: 'Payroll run',
    description:
      'Books the salary cost and every statutory or employee deduction for a posted run.',
    source: 'Payroll run posting',
    lines: [
      {
        side: 'DEBIT',
        label: 'Salary expense (gross + employer SSF)',
        roles: ['SALARY_EXPENSE'],
      },
      { side: 'CREDIT', label: 'Net salary payable', roles: ['SALARY_PAYABLE'] },
      { side: 'CREDIT', label: 'TDS withheld', roles: ['TDS_PAYABLE'] },
      {
        side: 'CREDIT',
        label: 'SSF withheld and employer share',
        roles: ['SSF_PAYABLE'],
      },
      {
        side: 'CREDIT',
        label: 'Employee advances recovered',
        roles: ['EMPLOYEE_ADVANCE'],
        condition: 'Advance greater than zero',
      },
      {
        side: 'CREDIT',
        label: 'Employee loans recovered',
        roles: ['EMPLOYEE_LOAN'],
        condition: 'Loan greater than zero',
      },
    ],
    note:
      'All deduction and net-pay lines carry the EMPLOYEE subledger party. Salary expense is split by the resolved employee or branch cost centre.',
  },
  {
    id: 'payroll-payment',
    group: 'PAYROLL',
    name: 'Payroll payment',
    description: 'Clears net salary payable from the till or bank.',
    source: 'Payroll payment posting',
    lines: [
      { side: 'DEBIT', label: 'Net salary payable cleared', roles: ['SALARY_PAYABLE'] },
      {
        side: 'CREDIT',
        label: 'Till or bank',
        roles: ['CASH', 'BANK'],
        condition: 'CASH uses the till; every other method uses the bank',
        oneOf: true,
      },
    ],
    note:
      'Paying a run is a separate posting from recognising the payroll cost, so the payable can be reconciled between the two events.',
  },
  {
    id: 'asset-acquisition',
    group: 'ASSETS',
    name: 'Fixed asset acquisition',
    description:
      'Capitalises an asset bought directly, or reclassifies the cost a purchase bill already put into inventory.',
    source: 'Fixed asset acquisition posting',
    lines: [
      { side: 'DEBIT', label: 'Fixed asset at cost', roles: ['FIXED_ASSET'] },
      {
        side: 'CREDIT',
        label: 'Cash, bank or supplier payable',
        roles: ['CASH', 'BANK', 'AP_CONTROL'],
        condition: 'Settlement method',
        oneOf: true,
      },
    ],
    note:
      'A bill-funded asset does not raise the payable twice: the acquisition reclassifies the cost already recorded by the purchase invoice.',
  },
  {
    id: 'asset-depreciation',
    group: 'ASSETS',
    name: 'Depreciation run',
    description:
      'Charges one period of depreciation against the accumulated depreciation contra-asset.',
    source: 'Fixed asset depreciation posting',
    lines: [
      { side: 'DEBIT', label: 'Depreciation expense', roles: ['DEPRECIATION_EXPENSE'] },
      {
        side: 'CREDIT',
        label: 'Accumulated depreciation',
        roles: ['ACCUMULATED_DEPRECIATION'],
      },
    ],
    note:
      'Each asset and period posts once. A duplicate run is refused, and an asset with no posted cost is reported rather than depreciated from zero.',
  },
  {
    id: 'asset-disposal',
    group: 'ASSETS',
    name: 'Fixed asset disposal',
    description:
      'Clears the asset and its accumulated depreciation, brings in proceeds and recognises the result.',
    source: 'Fixed asset disposal posting',
    lines: [
      {
        side: 'DEBIT',
        label: 'Accumulated depreciation cleared',
        roles: ['ACCUMULATED_DEPRECIATION'],
        condition: 'Depreciation previously posted',
      },
      {
        side: 'DEBIT',
        label: 'Cash or bank proceeds',
        roles: ['CASH', 'BANK'],
        condition: 'Proceeds greater than zero',
        oneOf: true,
      },
      {
        side: 'DEBIT',
        label: 'Loss on disposal',
        roles: ['LOSS_ON_DISPOSAL'],
        condition: 'Proceeds below net book value',
        optional: true,
      },
      {
        side: 'CREDIT',
        label: 'Fixed asset cost cleared',
        roles: ['FIXED_ASSET'],
        condition: 'Directly capitalised cost',
        optional: true,
      },
      {
        side: 'CREDIT',
        label: 'Deployed CPE cost cleared',
        roles: ['CPE_ASSET'],
        condition: 'Stock-deployed asset',
        optional: true,
      },
      {
        side: 'CREDIT',
        label: 'Gain on disposal',
        roles: ['GAIN_ON_DISPOSAL'],
        condition: 'Proceeds above net book value',
        optional: true,
      },
    ],
    note:
      'The cost and accumulated depreciation are read from posted journals, not the register cache, so a disposal cannot clear value that was never capitalised.',
  },
];
