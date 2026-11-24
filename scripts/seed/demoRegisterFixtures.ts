/**
 * Canonical demo register fixtures: warranty claims, bank reconciliation,
 * recurring journal templates, cash-flow inputs and the lending register.
 *
 * These are the registers that had no rows in the demo dataset. Everything here
 * is deliberately **non-posting**:
 *
 *   * warranty claims stop before `CREDITED`/`SENT_TO_VENDOR`, the two states
 *     whose service transitions write a journal or move a serial;
 *   * bank statement lines are imported but unmatched, and the reconciliation
 *     session is left OPEN — matching changes the line, not the ledger;
 *   * recurring templates carry their formulas but have no run, because a run
 *     posts a journal and would move the verified Cash + Bank figure;
 *   * cash-flow manual inputs are forecast rows and never post;
 *   * loans exist as recorded agreements with their schedules but no receipt
 *     transaction, because recording a receipt posts a bank journal.
 *
 * A claim, a template or a loan that posted here would break the seed's own
 * verification gate (AR 10,000 / AP 15,000 / Cash + Bank 10,000), which is the
 * one thing this dataset promises never to do.
 */
import crypto from 'node:crypto';
import type { VerificationDataset } from './verificationDataset';
import { bsOn, insertRows, type Row } from './fixtureUtils';

const SEED = 'seed:verify';

const BANK_ACCOUNT_ID = 'gla-2321'; // Nabil Bank — Operations
const CASH_ACCOUNT_ID = 'gla-2310';
const LOAN_ACCOUNT_ID = 'gla-4010';
const INTEREST_ACCOUNT_ID = 'gla-7300';
const EXPENSE_ACCOUNT_ID = 'gla-7300';
const ACCRUED_ACCOUNT_ID = 'gla-5020';
const DEPRECIATION_ACCOUNT_ID = 'gla-7300';
const ACCUMULATED_DEPRECIATION_ID = 'gla-1090';

export interface DemoRegisterFixtures {
  warrantyClaims: Row[];
  warrantyClaimEvents: Row[];
  bankStatementLines: Row[];
  bankReconciliationSessions: Row[];
  recurringTemplates: Row[];
  recurringTemplateLines: Row[];
  cashFlowInputs: Row[];
  lenders: Row[];
  loans: Row[];
  loanInstallments: Row[];
}

function fingerprint(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

export function buildDemoRegisterFixtures(dataset: VerificationDataset): DemoRegisterFixtures {
  const customer = dataset.customers.find((row: any) => row.branchId === 'BR-KTM') as any;

  const warrantyClaims: Row[] = [
    {
      id: 'demo-claim-001',
      claim_no: 'WC-DEMO-0001',
      branch_id: 'BR-KTM',
      coverage_id: 'demo-warranty-001',
      coverage_type: 'VENDOR',
      customer_id: null,
      customer_name: null,
      serial_number: 'FA-KTM-001',
      product_id: null,
      product_name: 'Office Furniture & Equipment',
      reported_date_ad: '2026-11-10',
      reported_date_bs: bsOn('2026-11-10'),
      symptom: 'Two drawer runners are binding; the supplier has not inspected it yet.',
      status: 'REPORTED',
      vendor_name: 'Demo Equipment Supplier',
      expected_credit: 0,
      received_credit: 0,
      notes: 'Reported to the vendor on the same day the branch logged the defect.',
      is_demo: true,
      created_by: SEED,
    },
    {
      id: 'demo-claim-002',
      claim_no: 'WC-DEMO-0002',
      branch_id: 'BR-KTM',
      coverage_id: 'demo-warranty-005',
      coverage_type: 'SELLER',
      customer_id: customer?.id ?? null,
      customer_name: customer?.customerName ?? 'Kathmandu Customer 01',
      serial_number: 'SN-ONU-100-KTM-06',
      product_id: 'prd-onu-100',
      product_name: 'ONU Router 1-Port GPON',
      reported_date_ad: '2026-11-12',
      reported_date_bs: bsOn('2026-11-12'),
      symptom: 'PON LED never leaves red; the customer swapped patch cords already.',
      status: 'APPROVED',
      resolution: null,
      expected_credit: 0,
      received_credit: 0,
      notes: 'Approved for an on-site replacement visit.',
      is_demo: true,
      created_by: SEED,
      updated_by: SEED,
    },
    {
      id: 'demo-claim-003',
      claim_no: 'WC-DEMO-0003',
      branch_id: 'BR-KTM',
      coverage_id: 'demo-warranty-008',
      coverage_type: 'VENDOR',
      serial_number: 'SN-ONU-200-KTM-07',
      product_id: 'prd-onu-200',
      product_name: 'ONU Router Dual-Band GPON',
      reported_date_ad: '2026-11-05',
      reported_date_bs: bsOn('2026-11-05'),
      symptom: 'Wi-Fi radios drop the 5 GHz band after ten minutes of load.',
      status: 'REPLACED',
      resolution: 'REPLACED',
      vendor_name: 'Kathmandu Vendor 1',
      vendor_claim_ref: 'KT-VND-RMA-2083-014',
      rma_reference: 'RMA-2083-014',
      replacement_serial: 'SN-ONU-200-KTM-99',
      expected_credit: 0,
      received_credit: 0,
      resolved_date_ad: '2026-11-16',
      resolved_date_bs: bsOn('2026-11-16'),
      notes: 'Vendor accepted the unit and shipped a replacement.',
      is_demo: true,
      created_by: SEED,
      updated_by: SEED,
    },
    {
      id: 'demo-claim-004',
      claim_no: 'WC-DEMO-0004',
      branch_id: 'BR-KTM',
      coverage_id: 'demo-warranty-009',
      coverage_type: 'VENDOR',
      serial_number: 'SN-ONU-300-KTM-06',
      product_id: 'prd-onu-300',
      product_name: 'ONU Router XPON AC1200',
      reported_date_ad: '2026-10-20',
      reported_date_bs: bsOn('2026-10-20'),
      symptom: 'Unit reboots under sustained throughput; suspected adapter fault.',
      status: 'CLOSED',
      resolution: null,
      vendor_name: 'Kathmandu Vendor 1',
      expected_credit: 0,
      received_credit: 0,
      closed_date_ad: '2026-10-30',
      closed_date_bs: bsOn('2026-10-30'),
      notes: 'Adapter replaced from stock; no vendor credit needed.',
      is_demo: true,
      created_by: SEED,
      updated_by: SEED,
    },
  ];

  const claimEvent = (input: {
    id: string;
    claimId: string;
    from: string | null;
    to: string;
    note: string;
    at: string;
  }): Row => ({
    id: input.id,
    claim_id: input.claimId,
    from_status: input.from,
    status: input.to,
    note: input.note,
    actor: SEED,
    created_at: input.at,
  });

  const warrantyClaimEvents: Row[] = [
    claimEvent({ id: 'demo-claim-event-001', claimId: 'demo-claim-001', from: null, to: 'REPORTED', note: 'Defect logged at the branch counter.', at: '2026-11-10T06:00:00Z' }),
    claimEvent({ id: 'demo-claim-event-002', claimId: 'demo-claim-002', from: null, to: 'REPORTED', note: 'Customer reported no service after the pole work.', at: '2026-11-12T05:20:00Z' }),
    claimEvent({ id: 'demo-claim-event-003', claimId: 'demo-claim-002', from: 'REPORTED', to: 'APPROVED', note: 'Approved: within the seller warranty window.', at: '2026-11-12T09:10:00Z' }),
    claimEvent({ id: 'demo-claim-event-004', claimId: 'demo-claim-003', from: null, to: 'REPORTED', note: 'Vendor claim opened from the RMA queue.', at: '2026-11-05T04:40:00Z' }),
    claimEvent({ id: 'demo-claim-event-005', claimId: 'demo-claim-003', from: 'REPORTED', to: 'APPROVED', note: 'Vendor accepted the fault description.', at: '2026-11-07T06:00:00Z' }),
    claimEvent({ id: 'demo-claim-event-006', claimId: 'demo-claim-003', from: 'APPROVED', to: 'REPLACED', note: 'Replacement unit received and handed to the customer.', at: '2026-11-16T08:30:00Z' }),
    claimEvent({ id: 'demo-claim-event-007', claimId: 'demo-claim-004', from: null, to: 'REPORTED', note: 'Unit returned by the customer.', at: '2026-10-20T07:00:00Z' }),
    claimEvent({ id: 'demo-claim-event-008', claimId: 'demo-claim-004', from: 'REPORTED', to: 'CLOSED', note: 'Adapter swapped; the unit tested clean over 24 hours.', at: '2026-10-30T09:15:00Z' }),
  ];

  const statementLine = (input: {
    id: string;
    date: string;
    description: string;
    reference: string;
    amount: number;
  }): Row => ({
    id: input.id,
    bank_account_id: BANK_ACCOUNT_ID,
    statement_date: input.date,
    statement_date_bs: bsOn(input.date),
    description: input.description,
    reference: input.reference,
    amount: input.amount,
    import_batch_id: 'demo-bank-import-2083-08',
    import_source: 'CSV',
    fingerprint: fingerprint(input.id),
  });

  const bankStatementLines: Row[] = [
    statementLine({ id: 'demo-bank-line-001', date: '2026-11-05', description: 'NEA electricity payment', reference: 'NEA-2083-1105', amount: -18_500 }),
    statementLine({ id: 'demo-bank-line-002', date: '2026-11-08', description: 'Customer deposit — CUS-KTM-04', reference: 'DEP-2083-1108', amount: 12_400 }),
    statementLine({ id: 'demo-bank-line-003', date: '2026-11-14', description: 'Bank charges', reference: 'CHG-2083-1114', amount: -350 }),
  ];

  const bankReconciliationSessions: Row[] = [
    {
      id: 'demo-bank-session-001',
      bank_account_id: BANK_ACCOUNT_ID,
      period_start: '2026-11-01',
      period_end: '2026-11-30',
      period_start_bs: bsOn('2026-11-01'),
      period_end_bs: bsOn('2026-11-30'),
      opening_statement_balance: 0,
      closing_statement_balance: -6_450,
      status: 'OPEN',
      created_by: SEED,
    },
  ];

  const recurringTemplates: Row[] = [
    {
      id: 'demo-recurring-rent',
      code: 'RC-RENT',
      name: 'Monthly office rent accrual',
      description: 'Accrues the Kathmandu office rent on the first of every month.',
      branch_id: 'BR-KTM',
      frequency: 'MONTHLY',
      start_date_ad: '2026-07-01',
      end_date_ad: null,
      next_run_date: '2026-12-01',
      active: true,
      created_by: SEED,
      updated_by: SEED,
    },
    {
      id: 'demo-recurring-depreciation',
      code: 'RC-DEPR',
      name: 'Quarterly equipment depreciation',
      description: 'Depreciates the branch equipment by a fixed quarterly charge.',
      branch_id: 'BR-KTM',
      frequency: 'QUARTERLY',
      start_date_ad: '2026-07-01',
      end_date_ad: null,
      next_run_date: '2027-01-01',
      active: true,
      created_by: SEED,
      updated_by: SEED,
    },
  ];

  const recurringTemplateLines: Row[] = [
    { id: 'demo-recurring-rent-l1', template_id: 'demo-recurring-rent', line_no: 1, account_id: EXPENSE_ACCOUNT_ID, side: 'DEBIT', amount_formula: '5000', memo: 'Office rent — Kathmandu', cost_center_id: 'cc-demo-fin' },
    { id: 'demo-recurring-rent-l2', template_id: 'demo-recurring-rent', line_no: 2, account_id: ACCRUED_ACCOUNT_ID, side: 'CREDIT', amount_formula: '5000', memo: 'Rent payable to the landlord' },
    { id: 'demo-recurring-depreciation-l1', template_id: 'demo-recurring-depreciation', line_no: 1, account_id: DEPRECIATION_ACCOUNT_ID, side: 'DEBIT', amount_formula: '1500 + 500', memo: 'Depreciation charge', cost_center_id: 'cc-demo-ops' },
    { id: 'demo-recurring-depreciation-l2', template_id: 'demo-recurring-depreciation', line_no: 2, account_id: ACCUMULATED_DEPRECIATION_ID, side: 'CREDIT', amount_formula: '1500 + 500', memo: 'Accumulated depreciation' },
  ];

  const cashFlowInputs: Row[] = [
    {
      id: 'demo-cashflow-001',
      branch_id: 'BR-KTM',
      expected_date_ad: '2026-12-05',
      expected_date_bs: bsOn('2026-12-05'),
      direction: 'INFLOW',
      amount_formula: '45000',
      description: 'Expected NEA deposit refund for the fibre route shift',
      created_by: SEED,
      updated_by: SEED,
    },
    {
      id: 'demo-cashflow-002',
      branch_id: 'BR-KTM',
      expected_date_ad: '2026-12-20',
      expected_date_bs: bsOn('2026-12-20'),
      direction: 'OUTFLOW',
      amount_formula: '18500 + 3500',
      description: 'Annual ISP licence renewal and bank charges',
      created_by: SEED,
      updated_by: SEED,
    },
  ];

  const lenders: Row[] = [
    {
      id: 'demo-lender-bank',
      code: 'LND-NABIL',
      name: 'Nabil Bank — Term Facility',
      lender_type: 'OTHER',
      pan_number: '601234567',
      registration_number: 'NRB-B-021',
      phone: '9801000101',
      address: 'Durbar Marg, Kathmandu',
      notes: 'Working-capital term loan used for the Pokhara expansion.',
      default_cash_account_id: BANK_ACCOUNT_ID,
      default_interest_account_id: INTEREST_ACCOUNT_ID,
      default_tds_account_id: null,
      default_loan_account_id: LOAN_ACCOUNT_ID,
      is_active: true,
    },
    {
      id: 'demo-lender-owner',
      code: 'LND-OWNER',
      name: 'Promoter — interest-free advance',
      lender_type: 'OWNER',
      phone: '9801000102',
      address: 'Kathmandu',
      notes: 'Interest-free promoter advance; no TDS applies to a nil interest loan.',
      default_cash_account_id: CASH_ACCOUNT_ID,
      default_interest_account_id: null,
      default_tds_account_id: null,
      default_loan_account_id: LOAN_ACCOUNT_ID,
      is_active: true,
    },
  ];

  const loans: Row[] = [
    {
      id: 'demo-loan-term-01',
      loan_number: 'LN-DEMO-0001',
      lender_id: 'demo-lender-bank',
      branch_id: 'BR-KTM',
      principal: 500_000,
      interest_rate: 9.5,
      start_date_ad: '2026-08-01',
      start_date_bs: bsOn('2026-08-01'),
      maturity_date_ad: '2027-07-31',
      maturity_date_bs: bsOn('2027-07-31'),
      repayment_frequency: 'MONTHLY',
      installment_amount: 45_000,
      security_type: 'SECURED',
      status: 'OPEN',
      agreement_reference: 'NABIL/TL/2083/0114',
      notes: 'Six-month drawdown schedule; the proceeds are recorded when the receipt is booked.',
      tds_applicable: true,
      created_by: SEED,
    },
    {
      id: 'demo-loan-owner-01',
      loan_number: 'LN-DEMO-0002',
      lender_id: 'demo-lender-owner',
      branch_id: 'BR-KTM',
      principal: 200_000,
      interest_rate: 0,
      start_date_ad: '2026-07-20',
      start_date_bs: bsOn('2026-07-20'),
      maturity_date_ad: null,
      maturity_date_bs: null,
      repayment_frequency: 'LUMP_SUM',
      installment_amount: null,
      security_type: 'UNSECURED',
      status: 'OPEN',
      agreement_reference: 'PROMOTER/ADV/2083/02',
      notes: 'Interest-free; TDS does not apply.',
      tds_applicable: false,
      tds_exemption_reason: 'NO_INTEREST',
      created_by: SEED,
    },
  ];

  const loanInstallments: Row[] = [
    '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01',
  ].map((dueDate, index) => ({
    id: `demo-loan-installment-${String(index + 1).padStart(2, '0')}`,
    loan_id: 'demo-loan-term-01',
    sequence_number: index + 1,
    due_date_ad: dueDate,
    due_date_bs: bsOn(dueDate),
    principal_due: 40_000,
    interest_due: 5_000,
    principal_paid: 0,
    interest_paid: 0,
    tds_paid: 0,
  }));

  return {
    warrantyClaims,
    warrantyClaimEvents,
    bankStatementLines,
    bankReconciliationSessions,
    recurringTemplates,
    recurringTemplateLines,
    cashFlowInputs,
    lenders,
    loans,
    loanInstallments,
  };
}

export async function applyDemoRegisterFixtures(
  client: any,
  dataset: VerificationDataset
): Promise<Record<string, number>> {
  const fixtures = buildDemoRegisterFixtures(dataset);
  const summary: Record<string, number> = {};
  const put = async (key: string, table: string, columns: string[], rows: Row[]) => {
    summary[key] = rows.length;
    await insertRows(client, table, columns, rows);
  };

  await put('demoWarrantyClaims', 'warranty_claims',
    ['id', 'claim_no', 'branch_id', 'coverage_id', 'coverage_type', 'customer_id', 'customer_name',
      'serial_number', 'product_id', 'product_name', 'reported_date_ad', 'reported_date_bs', 'symptom',
      'status', 'resolution', 'vendor_name', 'vendor_claim_ref', 'rma_reference', 'replacement_serial',
      'expected_credit', 'received_credit', 'resolved_date_ad', 'resolved_date_bs', 'closed_date_ad',
      'closed_date_bs', 'notes', 'is_demo', 'created_by', 'updated_by'],
    fixtures.warrantyClaims);
  await put('demoWarrantyClaimEvents', 'warranty_claim_events',
    ['id', 'claim_id', 'from_status', 'status', 'note', 'actor', 'created_at'],
    fixtures.warrantyClaimEvents);
  await put('demoBankStatementLines', 'bank_statement_lines',
    ['id', 'bank_account_id', 'statement_date', 'statement_date_bs', 'description', 'reference', 'amount',
      'import_batch_id', 'import_source', 'fingerprint'],
    fixtures.bankStatementLines);
  await put('demoBankReconciliationSessions', 'bank_reconciliation_sessions',
    ['id', 'bank_account_id', 'period_start', 'period_end', 'period_start_bs', 'period_end_bs',
      'opening_statement_balance', 'closing_statement_balance', 'status', 'created_by'],
    fixtures.bankReconciliationSessions);
  await put('demoRecurringTemplates', 'gl_recurring_templates',
    ['id', 'code', 'name', 'description', 'branch_id', 'frequency', 'start_date_ad', 'end_date_ad',
      'next_run_date', 'active', 'created_by', 'updated_by'],
    fixtures.recurringTemplates);
  await put('demoRecurringTemplateLines', 'gl_recurring_template_lines',
    ['id', 'template_id', 'line_no', 'account_id', 'side', 'amount_formula', 'memo', 'cost_center_id'],
    fixtures.recurringTemplateLines);
  await put('demoCashFlowInputs', 'gl_cash_flow_manual_inputs',
    ['id', 'branch_id', 'expected_date_ad', 'expected_date_bs', 'direction', 'amount_formula', 'description',
      'created_by', 'updated_by'],
    fixtures.cashFlowInputs);
  await put('demoLenders', 'lenders',
    ['id', 'code', 'name', 'lender_type', 'pan_number', 'registration_number', 'phone', 'address', 'notes',
      'default_cash_account_id', 'default_interest_account_id', 'default_tds_account_id',
      'default_loan_account_id', 'is_active'],
    fixtures.lenders);
  await put('demoLoans', 'loans',
    ['id', 'loan_number', 'lender_id', 'branch_id', 'principal', 'interest_rate', 'start_date_ad',
      'start_date_bs', 'maturity_date_ad', 'maturity_date_bs', 'repayment_frequency', 'installment_amount',
      'security_type', 'status', 'agreement_reference', 'notes', 'tds_applicable', 'tds_exemption_reason',
      'created_by'],
    fixtures.loans);
  await put('demoLoanInstallments', 'loan_installments',
    ['id', 'loan_id', 'sequence_number', 'due_date_ad', 'due_date_bs', 'principal_due', 'interest_due',
      'principal_paid', 'interest_paid', 'tds_paid'],
    fixtures.loanInstallments);

  return summary;
}
