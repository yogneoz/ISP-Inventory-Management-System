// ============================================================================
// `npm run check:demo-coverage` — proves the demo dataset reaches every module
// the app exposes.
//
// The seeder's own verification report checks the ledger *figures*. It says
// nothing about whether the dispatch board, the custody register, the warranty
// claims tab or the lending screen have a single row. This script is that other
// half: one catalogue, one row count per table, and a non-zero exit when a
// module the app can open is empty.
//
// Two kinds of emptiness are reported differently:
//   * MISSING — a table the demo dataset is expected to fill. Exit 1.
//   * EMPTY   — a module that is deliberately left empty, with the reason. Not a
//               failure; the reason is printed so nobody "fixes" it by posting a
//               journal and moving a verified figure.
//
// Point it at the same database the seeder wrote:
//   POSTGRES_HOST=172.31.210.209 npm run check:demo-coverage
// ============================================================================
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ quiet: true } as any);

interface Domain {
  name: string;
  tables: Array<[table: string, minimum: number]>;
}

const DOMAINS: Domain[] = [
  {
    name: 'Company, org & periods',
    tables: [
      ['branches', 4], ['company_profile', 1], ['fiscal_years', 2], ['gl_periods', 20],
      ['cost_centers', 5], ['areas', 8], ['locations', 4], ['sales_agents', 4], ['bill_terms', 3],
    ],
  },
  {
    name: 'Users & permissions',
    tables: [
      ['users', 9],       ['permission_matrix', 1], ['permission_sets', 3],
      ['permission_set_grants', 1], ['permission_set_members', 3], ['user_permission_overrides', 2],
    ],
  },
  {
    name: 'Customers & suppliers',
    tables: [
      ['customer_records', 80], ['suppliers', 12], ['vendor_opening_balances', 4],
      ['narration_templates', 5], ['document_number_configs', 27],
    ],
  },
  {
    name: 'Products, stock & assets',
    tables: [
      ['products', 25], ['product_groups', 5], ['categories', 4], ['uom', 5],
      ['inventory_stock', 80], ['branch_stock_balances', 80], ['fixed_assets', 8],
      ['fiscal_year_opening_stock', 80],
    ],
  },
  {
    name: 'Sales & receipts',
    tables: [
      ['sales_invoices', 50], ['serial_log', 50], ['transaction_logs', 50],
      ['customer_payments', 10], ['sales_returns', 1], ['vendor_payments', 5],
      ['payment_settlements', 1], ['sales_invoices_default', 1],
    ],
  },
  {
    name: 'Procurement & shipments',
    tables: [
      ['purchase_invoices', 10], ['purchase_orders', 1], ['purchase_returns', 1], ['shipments', 1],
    ],
  },
  {
    name: 'Inventory operations',
    tables: [
      ['stock_operations', 1], ['damage_records', 1], ['transaction_logs_default', 1],
    ],
  },
  {
    name: 'Field service & proof of work',
    tables: [
      ['field_work_orders', 6], ['field_work_order_evidence', 4], ['customer_device_records', 6],
      ['warranty_coverages', 9], ['warranty_claims', 4], ['warranty_claim_events', 8],
    ],
  },
  {
    name: 'Van custody',
    tables: [['employee_stock_movements', 7], ['employee_stock_holdings', 3]],
  },
  {
    name: 'Accounting & ledger',
    tables: [
      ['gl_accounts', 130], ['gl_account_groups', 10], ['gl_journals', 100], ['gl_journal_lines', 200],
      ['gl_journals_registry', 100], ['gl_journal_line_registry', 200], ['gl_subledgers', 50],
      ['gl_subledger_entries', 50], ['gl_periods', 20], ['gl_close_checklist_items', 100],
      ['gl_close_task_templates', 5], ['gl_budgets', 4], ['gl_budget_lines', 100],
      ['gl_budget_versions', 1], ['gl_budget_allocation_profiles', 1], ['gl_budget_allocation_lines', 10],
      ['gl_party_period_balances', 50], ['gl_period_balances', 100], ['gl_recurring_templates', 2],
      ['gl_recurring_template_lines', 4], ['gl_cash_flow_manual_inputs', 2], ['daily_cash_closes', 4],
      ['approval_requests', 4], ['document_identity_registry', 50],
    ],
  },
  {
    name: 'Bank & borrowing',
    tables: [
      ['bank_statement_lines', 3], ['bank_reconciliation_sessions', 1], ['payment_settlements', 1],
      ['lenders', 2], ['loans', 2], ['loan_installments', 6],
    ],
  },
  {
    name: 'HR records & registers',
    tables: [
      ['employees', 15], ['hr_org_masters', 50], ['hr_org_clusters', 4], ['hr_branch_plan', 20],
      ['hr_department_profiles', 5], ['hr_designation_profiles', 40], ['hr_salary_grades', 5],
      ['hr_statutory_configs', 1], ['hr_leave_types', 3], ['bs_months', 24],
      ['hr_employee_salary', 5], ['hr_salary_components', 5],
      ['hr_employee_documents', 2], ['hr_employee_qualifications', 2], ['hr_employee_experience', 2],
      ['hr_employee_family_members', 2], ['hr_employee_references', 2], ['hr_employee_branch_transfers', 1],
      ['hr_delegations', 1], ['hr_expense_claims', 3],
    ],
  },
  {
    name: 'Attendance, leave & payroll',
    tables: [
      ['hr_attendance', 5], ['hr_attendance_proofs', 3], ['hr_leave_requests', 3], ['hr_leave_balances', 5],
      ['payroll_runs', 1], ['payroll_run_lines', 2], ['hr_payroll_adjustments', 2], ['hr_tds_slabs', 3],
    ],
  },
  {
    name: 'Recruitment & performance',
    tables: [
      ['hr_recruitment_requisitions', 1], ['hr_recruitment_candidates', 2], ['hr_recruitment_interviews', 1],
      ['hr_recruitment_offers', 1], ['hr_review_cycles', 1], ['hr_goals', 4], ['hr_review_feedback', 3],
      ['hr_lifecycle_checklists', 2], ['hr_lifecycle_checklist_items', 7],
    ],
  },
  {
    name: 'Field workforce & presence',
    tables: [
      ['employee_shift_roster', 5], ['employee_location_breadcrumbs', 4], ['branch_geofences', 4],
      ['hr_shifts', 2], ['hr_holidays', 8],
    ],
  },
  {
    name: 'Integration & partner API',
    tables: [['api_keys', 1], ['integration_partners', 1], ['integration_outbox', 2]],
  },
  {
    name: 'Governance & activity',
    tables: [
      ['audit_logs', 1], ['company_announcements', 3], ['bs_calendar_years', 2], ['bs_day_records', 1000],
    ],
  },
];

/**
 * Modules the demo dataset deliberately leaves empty. Each reason names what a
 * row would have to post, and which verified figure that would move.
 */
const INTENTIONALLY_EMPTY: Array<{ tables: string[]; reason: string }> = [
  {
    tables: ['service_invoices', 'service_invoice_lines'],
    reason: 'Written only by the partner ingest service; a POSTED invoice posts AR and revenue, which would move the verified AR figure. docs/contracts/partner-v1.md and its contract test prove the shape.',
  },
  {
    tables: ['loan_transactions', 'loan_interest_accruals'],
    reason: 'Recording a receipt or accrual posts a bank/interest journal, which would move the verified Cash + Bank figure. The loan agreements and their schedules are seeded instead.',
  },
  {
    tables: ['gl_recurring_runs'],
    reason: 'A run posts the template journal. The templates ship with their formulas; the first run happens in the demo when somebody presses Run.',
  },
  {
    tables: ['mobile_devices', 'mobile_refresh_tokens', 'mobile_fcm_tokens', 'mobile_change_log'],
    reason: 'Created by the mobile client on first sign-in; seeding them would fake a device that never authenticated.',
  },
  {
    tables: ['idempotency_keys', 'read_model_outbox', 'accounting_outbox', 'integration_inbox',
      'integration_delivery_attempts', 'document_sequence_daily', 'fiscal_year_balances',
      'gl_opening_balance_slots', 'external_refs', 'stock_consumption_events'],
    reason: 'Runtime work queues and sequence counters. They are filled by the operation that needs them, not by a dataset.',
  },
  {
    tables: ['customer_payment_allocations'],
    reason: 'Written when a receipt is applied across invoices in the allocation screen. The seeded receipts settle whole invoices through payment_settlements, so the allocation table is empty until someone applies one.',
  },
  {
    tables: ['api_key_audit_logs', 'document_number_retirements', 'mobile_sync_rejections',
      'user_preferences', 'app_settings', 'schema_migrations'],
    reason: 'Audit trails, retired document numbers, rejected sync payloads and per-user UI preferences: each row is evidence of something a person or client did, so seeding one would be a false record.',
  },
];

const DB_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
};

async function main(): Promise<void> {
  const pool = new pg.Pool({ ...DB_CONFIG, connectionTimeoutMillis: 8000 });
  const client = await pool.connect();
  const failures: string[] = [];
  const covered = new Set<string>();
  try {
    const existing = new Set(
      (
        await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
        )
      ).rows.map((row: any) => row.table_name as string)
    );

    console.log(`\nDemo dataset coverage — ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
    for (const domain of DOMAINS) {
      console.log(`\n${domain.name}`);
      for (const [table, minimum] of domain.tables) {
        if (!existing.has(table)) {
          failures.push(`${table}: table does not exist`);
          console.log(`  ✖ ${table.padEnd(34)} missing table`);
          continue;
        }
        covered.add(table);
        const count = Number((await client.query(`SELECT COUNT(*)::int AS c FROM "${table}"`)).rows[0].c);
        const ok = count >= minimum;
        if (!ok) failures.push(`${table}: ${count} row(s), expected at least ${minimum}`);
        console.log(`  ${ok ? '✔' : '✖'} ${table.padEnd(34)} ${String(count).padStart(6)} row(s)${ok ? '' : `  (expected ≥ ${minimum})`}`);
      }
    }

    console.log('\nIntentionally empty (with the reason)');
    for (const entry of INTENTIONALLY_EMPTY) {
      for (const table of entry.tables) covered.add(table);
      console.log(`  · ${entry.tables.join(', ')}`);
      console.log(`      ${entry.reason}`);
    }

    // Nothing may hide: every base table is either covered above or listed as
    // empty-with-a-reason. Partitions are counted through their parent, so they
    // are reported as "partition" rather than as an unclassified gap.
    const unclassified = [...existing].filter((table) => !covered.has(table) && !/_20\d{4}$|_default$/.test(table));
    if (unclassified.length > 0) {
      console.log('\nUnclassified tables (neither seeded nor explained)');
      for (const table of unclassified.sort()) console.log(`  ? ${table}`);
      failures.push(`${unclassified.length} unclassified table(s): ${unclassified.sort().join(', ')}`);
    }

    console.log('');
    if (failures.length > 0) {
      console.error('❌ Demo dataset does not cover every module:');
      for (const failure of failures) console.error(`   • ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log('✅ Every module the app exposes has demo data (or a documented reason to be empty).');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Coverage check failed:', err);
  process.exit(1);
});
