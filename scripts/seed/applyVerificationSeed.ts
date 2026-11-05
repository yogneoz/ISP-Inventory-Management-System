// ============================================================================
// Writes the verification dataset into PostgreSQL.
//
// Used by `npm run seed:verify` (scripts/seed_verification_data.ts) and by
// `npm run setup:pg` (scripts/setup_db.js). The wipe deletes every operational
// table but PRESERVES the Nepali BS calendar (bs_calendar_years,
// bs_day_records) exactly as the brief asks; fiscal_years is deleted with a
// plain DELETE so the calendar's fiscal_year_id is SET NULL instead of the
// rows being truncated by CASCADE, then re-linked to the two seeded years.
// ============================================================================
import crypto from 'node:crypto';
import type { VerificationDataset } from './verificationDataset';

/** Bcrypt-compatible-with-the-server scrypt format: scrypt$<salt>$<hex>. */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export const DEMO_PASSWORD = 'Demo@123';

const PRESERVED_TABLES = new Set(['bs_calendar_years', 'bs_day_records', 'fiscal_years']);

/** Removes every operational row, keeping the BS calendar tables untouched. */
export async function wipeOperationalData(client: any): Promise<string[]> {
  const tables = (
    await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
    )
  ).rows.map((r: any) => r.table_name as string);
  const wipeTables = tables.filter((t: string) => !PRESERVED_TABLES.has(t));
  if (wipeTables.length > 0) {
    await client.query(`TRUNCATE TABLE ${wipeTables.join(', ')} RESTART IDENTITY CASCADE`);
  }
  if (tables.includes('fiscal_years')) {
    await client.query('DELETE FROM fiscal_years');
  }
  return wipeTables;
}

/** Applies the (idempotent) schema; safe on an empty database. */
export async function applySchema(client: any): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const schemaPath = path.join(process.cwd(), 'scripts', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await client.query(sql);
}

/** Inserts rows with explicit column lists (no dynamic SQL identifiers). */
async function insertRows(client: any, table: string, columns: string[], rows: any[]): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  for (const row of rows) {
    await client.query(sql, columns.map((c) => row[c] ?? null));
  }
}

export async function applyVerificationSeed(client: any, dataset: VerificationDataset): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};
  const count = (key: string, rows: any[]) => {
    summary[key] = rows.length;
    return rows;
  };

  // ---- masters -----------------------------------------------------------
  await insertRows(client, 'company_profile',
    ['id', 'name', 'legal_name', 'tagline', 'address', 'city', 'country', 'phone', 'email', 'pan_vat_number',
      'currency_symbol', 'currency_code', 'currency_locale', 'currency_position', 'currency_decimals', 'default_tax_rate', 'notes'],
    [dataset.company].map((c) => ({
      id: c.id, name: c.name, legal_name: c.legalName, tagline: c.tagline, address: c.address, city: c.city,
      country: c.country, phone: c.phone, email: c.email, pan_vat_number: c.panVatNumber,
      currency_symbol: c.currencySymbol, currency_code: c.currencyCode, currency_locale: c.currencyLocale,
      currency_position: c.currencyPosition, currency_decimals: c.currencyDecimals,
      default_tax_rate: c.defaultTaxRate, notes: c.notes,
    })));

  await insertRows(client, 'branches',
    ['id', 'code', 'name', 'location', 'phone', 'is_headquarters', 'active', 'allow_procurement', 'allow_warehouse_transfer', 'is_demo'],
    count('branches', dataset.branches).map((b) => ({
      id: b.id, code: b.code, name: b.name, location: b.location, phone: b.phone,
      is_headquarters: b.isHeadquarters, active: b.active, allow_procurement: b.allowProcurement,
      allow_warehouse_transfer: b.allowWarehouseTransfer, is_demo: b.isDemo,
    })));

  await insertRows(client, 'fiscal_years',
    ['id', 'code', 'start_date_ad', 'end_date_ad', 'start_date_bs', 'end_date_bs', 'is_current', 'is_closed', 'is_demo', 'is_provisional'],
    count('fiscalYears', dataset.fiscalYears).map((fy) => ({
      id: fy.id, code: fy.code, start_date_ad: fy.startDateAD, end_date_ad: fy.endDateAD,
      start_date_bs: fy.startDateBS, end_date_bs: fy.endDateBS, is_current: fy.isCurrent,
      is_closed: fy.isClosed, is_demo: fy.isDemo, is_provisional: fy.isProvisional,
    })));

  // The BS calendar survived the wipe; point its days at the two fiscal years.
  await client.query(
    `UPDATE bs_day_records b SET fiscal_year_id = fy.id
       FROM fiscal_years fy
      WHERE b.ad_date >= fy.start_date_ad AND b.ad_date <= fy.end_date_ad`
  );

  await insertRows(client, 'gl_periods',
    ['id', 'fiscal_year_id', 'period_key', 'start_date_ad', 'end_date_ad', 'status'],
    count('periods', dataset.periods).map((p) => ({
      id: p.id, fiscal_year_id: p.fiscalYearId, period_key: p.periodKey,
      start_date_ad: p.startDateAD, end_date_ad: p.endDateAD, status: p.status,
    })));

  await insertRows(client, 'users',
    ['id', 'email', 'password', 'name', 'role', 'branch_id', 'allowed_branch_ids', 'status', 'can_switch_user', 'is_demo'],
    count('users', dataset.users).map((u) => ({
      id: u.id, email: u.email, password: hashPassword(DEMO_PASSWORD), name: u.name, role: u.role,
      branch_id: u.branchId, allowed_branch_ids: u.allowedBranchIds, status: u.status,
      can_switch_user: u.canSwitchUser, is_demo: u.isDemo,
    })));

  await insertRows(client, 'uom',
    ['id', 'name', 'symbol', 'type', 'is_base_unit'],
    count('uoms', dataset.uoms).map((u) => ({ id: u.id, name: u.name, symbol: u.symbol, type: u.type, is_base_unit: u.isBaseUnit })));

  await insertRows(client, 'document_number_configs',
    ['id', 'document_type', 'prefix', 'suffix', 'min_digits', 'starting_number', 'next_number', 'reset_every_fiscal_year', 'notes'],
    count('documentConfigs', dataset.documentConfigs).map((d) => ({
      id: d.id, document_type: d.documentType, prefix: d.prefix, suffix: d.suffix, min_digits: d.minDigits,
      starting_number: d.startingNumber, next_number: d.nextNumber,
      reset_every_fiscal_year: d.resetEveryFiscalYear, notes: d.notes ?? '',
    })));

  const groupIdByCode = new Map<string, string>();
  await insertRows(client, 'gl_account_groups',
    ['id', 'code', 'name', 'account_type', 'statement_group', 'normal_balance', 'sort_order', 'is_active', 'is_demo'],
    count('chartGroups', dataset.chartGroups).map((g) => {
      const id = `glg-${g.code}`;
      groupIdByCode.set(g.code, id);
      return {
        id, code: g.code, name: g.name, account_type: g.accountType, statement_group: g.statementGroup,
        normal_balance: g.normalBalance, sort_order: g.sortOrder, is_active: true, is_demo: true,
      };
    }));

  await insertRows(client, 'gl_accounts',
    ['id', 'code', 'name', 'group_id', 'description', 'is_control', 'subledger_type', 'posting_role', 'is_active', 'is_demo', 'account_kind'],
    count('chartAccounts', dataset.chartAccounts).map((a) => ({
      id: `gla-${a.code}`, code: a.code, name: a.name, group_id: groupIdByCode.get(a.groupCode),
      description: a.description, is_control: a.isControl, subledger_type: a.subledgerType,
      posting_role: a.postingRole, is_active: true, is_demo: true,
      account_kind: a.code === '1010' ? 'CASH' : a.code === '1020' ? 'BANK' : 'OTHER',
    })));

  await insertRows(client, 'gl_subledgers',
    ['id', 'code', 'name', 'subledger_type', 'main_account_id', 'description', 'is_active', 'is_demo'],
    dataset.chartAccounts.filter((a) => a.isControl).map((a) => ({
      id: `gls-${a.code}`, code: `SL-${a.code}`, name: `${a.name} subledger`,
      subledger_type: a.subledgerType, main_account_id: `gla-${a.code}`,
      description: `Subledger book behind the ${a.name} control account.`,
      is_active: true, is_demo: true,
    })));

  await insertRows(client, 'bill_terms',
    ['id', 'code', 'name', 'due_days', 'discount_days', 'discount_percent', 'active', 'is_demo'],
    count('billTerms', dataset.billTerms).map((b) => ({
      id: b.id, code: b.code, name: b.name, due_days: b.dueDays, discount_days: b.discountDays,
      discount_percent: b.discountPercent, active: b.active, is_demo: b.isDemo,
    })));

  await insertRows(client, 'areas',
    ['id', 'code', 'name', 'parent_id', 'branch_id', 'active', 'is_demo'],
    count('areas', dataset.areas).map((a) => ({
      id: a.id, code: a.code, name: a.name, parent_id: a.parentId, branch_id: a.branchId,
      active: a.active, is_demo: a.isDemo,
    })));

  await insertRows(client, 'sales_agents',
    ['id', 'code', 'name', 'phone', 'email', 'area_id', 'commission_rate', 'active', 'is_demo'],
    count('salesAgents', dataset.agents).map((a) => ({
      id: a.id, code: a.code, name: a.name, phone: a.phone, email: a.email, area_id: a.areaId,
      commission_rate: a.commissionRate, active: a.active, is_demo: a.isDemo,
    })));

  await insertRows(client, 'locations',
    ['id', 'name', 'type', 'branch_id', 'address', 'coordinates', 'contact_person', 'contact_phone', 'notes', 'active_assets_count', 'is_demo'],
    count('locations', dataset.locations).map((l) => ({
      id: l.id, name: l.name, type: l.type, branch_id: l.branchId, address: l.address,
      coordinates: JSON.stringify(l.coordinates ?? {}), contact_person: l.contactPerson,
      contact_phone: l.contactPhone, notes: l.notes, active_assets_count: l.activeAssetsCount, is_demo: l.isDemo,
    })));

  await insertRows(client, 'product_groups',
    ['id', 'code', 'name', 'behavior', 'sort_order', 'active', 'is_system', 'is_demo'],
    count('productGroups', dataset.productGroups).map((g) => ({
      id: g.id, code: g.code, name: g.name, behavior: g.behavior, sort_order: g.sortOrder,
      active: g.active, is_system: g.isSystem, is_demo: g.isDemo,
    })));

  await insertRows(client, 'categories',
    ['id', 'name', 'code', 'description', 'is_special_tracked', 'is_demo'],
    count('categories', dataset.categories).map((c) => ({
      id: c.id, name: c.name, code: c.code, description: c.description,
      is_special_tracked: c.isSpecialTracked, is_demo: c.isDemo,
    })));

  await insertRows(client, 'products',
    ['id', 'sku', 'barcode', 'name', 'category', 'product_group', 'unit', 'cost_price', 'selling_price', 'tax_rate',
      'min_reorder_level', 'requires_serial_tracking', 'tracking_type', 'description', 'depreciation_method',
      'depreciation_rate', 'useful_life_years', 'status', 'vendor_warranty_months', 'seller_warranty_months', 'is_demo'],
    count('products', dataset.products).map((p) => ({
      id: p.id, sku: p.sku, barcode: p.barcode, name: p.name, category: p.category, product_group: p.productGroup,
      unit: p.unit, cost_price: p.costPrice, selling_price: p.sellingPrice, tax_rate: p.taxRate,
      min_reorder_level: p.minReorderLevel, requires_serial_tracking: p.requiresSerialTracking,
      tracking_type: p.trackingType, description: p.description, depreciation_method: p.depreciationMethod,
      depreciation_rate: p.depreciationRate, useful_life_years: p.usefulLifeYears, status: p.status,
      vendor_warranty_months: p.vendorWarrantyMonths, seller_warranty_months: p.sellerWarrantyMonths, is_demo: p.isDemo,
    })));

  await insertRows(client, 'customer_records',
    ['id', 'customer_id', 'customer_name', 'username', 'contact_number', 'branch_id', 'address', 'email', 'status',
      'credit_limit', 'assigned_devices_count', 'bill_terms_id', 'area_id', 'agent_id', 'is_demo'],
    count('customers', dataset.customers).map((c) => ({
      id: c.id, customer_id: c.customerId, customer_name: c.customerName, username: c.username,
      contact_number: c.contactNumber, branch_id: c.branchId, address: c.address, email: c.email,
      status: c.status, credit_limit: c.creditLimit, assigned_devices_count: c.assignedDevicesCount,
      bill_terms_id: c.billTermsId, area_id: c.areaId, agent_id: c.agentId, is_demo: c.isDemo,
    })));

  await insertRows(client, 'suppliers',
    ['id', 'supplier_code', 'name', 'contact_person', 'phone', 'email', 'address', 'pan_vat_number', 'rating', 'status', 'bill_terms_id', 'is_demo'],
    count('suppliers', dataset.suppliers).map((s) => ({
      id: s.id, supplier_code: s.supplierCode, name: s.name, contact_person: s.contactPerson, phone: s.phone,
      email: s.email, address: s.address, pan_vat_number: s.panVatNumber, rating: s.rating,
      status: s.status, bill_terms_id: s.billTermsId, is_demo: s.isDemo,
    })));

  await insertRows(client, 'inventory_stock',
    ['id', 'product_id', 'branch_id', 'quantity_on_hand', 'damaged_qty', 'reserved_qty', 'incoming_qty',
      'min_reorder_level', 'average_cost', 'is_demo', 'created_by'],
    count('inventoryStock', dataset.inventoryStock).map((s) => ({
      id: s.id, product_id: s.productId, branch_id: s.branchId, quantity_on_hand: s.quantityOnHand,
      damaged_qty: s.damagedQty, reserved_qty: s.reservedQty, incoming_qty: s.incomingQty,
      min_reorder_level: s.minReorderLevel, average_cost: s.averageCost, is_demo: s.isDemo, created_by: s.createdBy,
    })));

  await insertRows(client, 'fixed_assets',
    ['id', 'tag_number', 'name', 'category', 'branch_id', 'acquisition_date_ad', 'acquisition_date_bs',
      'purchase_invoice_date_ad', 'purchase_invoice_date_bs', 'capitalization_date_ad', 'placed_in_service_date_ad',
      'acquisition_cost', 'depreciation_method', 'depreciation_rate_percent', 'accumulated_depreciation',
      'net_book_value', 'status', 'supplier_name', 'invoice_no', 'product_id', 'fiscal_year_id', 'is_demo', 'created_by'],
    count('fixedAssets', dataset.fixedAssets).map((a) => ({
      id: a.id, tag_number: a.tagNumber, name: a.name, category: a.category, branch_id: a.branchId,
      acquisition_date_ad: a.acquisitionDateAD, acquisition_date_bs: a.acquisitionDateBS,
      purchase_invoice_date_ad: a.purchaseInvoiceDateAD, purchase_invoice_date_bs: a.purchaseInvoiceDateBS,
      capitalization_date_ad: a.capitalizationDateAD, placed_in_service_date_ad: a.placedInServiceDateAD,
      acquisition_cost: a.acquisitionCost, depreciation_method: a.depreciationMethod,
      depreciation_rate_percent: a.depreciationRatePercent, accumulated_depreciation: a.accumulatedDepreciation,
      net_book_value: a.netBookValue, status: a.status, supplier_name: a.supplierName, invoice_no: a.invoiceNo,
      product_id: a.productId, fiscal_year_id: a.fiscalYearId, is_demo: a.isDemo, created_by: a.createdBy,
    })));

  await insertRows(client, 'serial_log',
    ['id', 'device_serial', 'pon_serial', 'mac_address', 'product_id', 'product_name', 'branch_id', 'customer_id',
      'customer_name', 'status', 'source_type', 'source_id', 'history_json', 'fiscal_year_id', 'is_demo', 'created_by'],
    count('serialLogs', dataset.serialLogs).map((s) => ({
      id: s.id, device_serial: s.deviceSerial, pon_serial: s.ponSerial, mac_address: s.macAddress,
      product_id: s.productId, product_name: s.productName, branch_id: s.branchId,
      customer_id: s.customerId, customer_name: s.customerName, status: s.status, source_type: s.sourceType,
      source_id: s.sourceId, history_json: JSON.stringify(s.history ?? []), fiscal_year_id: s.fiscalYearId,
      is_demo: s.isDemo, created_by: s.createdBy,
    })));

  await insertRows(client, 'transaction_logs',
    ['id', 'transaction_number', 'product_id', 'product_sku', 'product_name', 'branch_id', 'change_type',
      'quantity_before', 'quantity_changed', 'quantity_after', 'unit_cost', 'reference_doc_id',
      'timestamp_ad', 'timestamp_bs', 'fiscal_year_id', 'is_demo', 'created_by'],
    count('transactionLogs', dataset.transactionLogs).map((t) => ({
      id: t.id, transaction_number: t.transactionNumber, product_id: t.productId, product_sku: t.productSku,
      product_name: t.productName, branch_id: t.branchId, change_type: t.changeType,
      quantity_before: t.quantityBefore, quantity_changed: t.quantityChanged, quantity_after: t.quantityAfter,
      unit_cost: t.unitCost, reference_doc_id: t.referenceDocId, timestamp_ad: t.timestampAD,
      timestamp_bs: t.timestampBS, fiscal_year_id: t.fiscalYearId, is_demo: t.isDemo, created_by: t.createdBy,
    })));

  await insertRows(client, 'purchase_invoices',
    ['id', 'invoice_number', 'po_reference_id', 'vendor_bill_number', 'supplier_id', 'supplier_name', 'branch_id',
      'invoice_date_ad', 'invoice_date_bs', 'due_date_ad', 'due_date_bs', 'taxable_amount', 'vat_amount',
      'non_taxable_amount', 'grand_total', 'payment_status', 'payment_method', 'amount_paid', 'notes', 'items',
      'fiscal_year_id', 'bill_terms_id', 'is_demo', 'created_by'],
    count('purchaseInvoices', dataset.purchaseInvoices).map((i) => ({
      id: i.id, invoice_number: i.invoiceNumber, po_reference_id: i.poReferenceId, vendor_bill_number: i.vendorBillNumber,
      supplier_id: i.supplierId, supplier_name: i.supplierName, branch_id: i.branchId,
      invoice_date_ad: i.invoiceDateAD, invoice_date_bs: i.invoiceDateBS, due_date_ad: i.dueDateAD,
      due_date_bs: i.dueDateBS, taxable_amount: i.taxableAmount, vat_amount: i.vatAmount,
      non_taxable_amount: i.nonTaxableAmount, grand_total: i.grandTotal, payment_status: i.paymentStatus,
      payment_method: i.paymentMethod, amount_paid: i.amountPaid, notes: i.notes, items: JSON.stringify(i.items),
      fiscal_year_id: i.fiscalYearId, bill_terms_id: i.billTermsId, is_demo: i.isDemo, created_by: i.createdBy,
    })));

  await insertRows(client, 'sales_invoices',
    ['id', 'invoice_number', 'customer_id', 'customer_name', 'branch_id', 'invoice_date_ad', 'invoice_date_bs',
      'due_date_ad', 'due_date_bs', 'taxable_amount', 'vat_amount', 'non_taxable_amount', 'grand_total',
      'payment_status', 'payment_method', 'amount_paid', 'notes', 'items', 'fiscal_year_id', 'status',
      'bill_terms_id', 'area_id', 'area_name', 'agent_id', 'agent_name', 'is_demo', 'created_by'],
    count('salesInvoices', dataset.salesInvoices).map((i) => ({
      id: i.id, invoice_number: i.invoiceNumber, customer_id: i.customerId, customer_name: i.customerName,
      branch_id: i.branchId, invoice_date_ad: i.invoiceDateAD, invoice_date_bs: i.invoiceDateBS,
      due_date_ad: i.dueDateAD, due_date_bs: i.dueDateBS, taxable_amount: i.taxableAmount, vat_amount: i.vatAmount,
      non_taxable_amount: i.nonTaxableAmount, grand_total: i.grandTotal, payment_status: i.paymentStatus,
      payment_method: i.paymentMethod, amount_paid: i.amountPaid, notes: i.notes, items: JSON.stringify(i.items),
      fiscal_year_id: i.fiscalYearId, status: i.status, bill_terms_id: i.billTermsId, area_id: i.areaId,
      area_name: i.areaName, agent_id: i.agentId, agent_name: i.agentName, is_demo: i.isDemo, created_by: i.createdBy,
    })));

  await insertRows(client, 'customer_payments',
    ['id', 'payment_number', 'customer_id', 'customer_name', 'branch_id', 'invoice_id', 'invoice_number',
      'payment_date_ad', 'payment_date_bs', 'amount', 'payment_method', 'notes', 'status', 'fiscal_year_id', 'is_demo', 'created_by'],
    count('customerPayments', dataset.customerPayments).map((p) => ({
      id: p.id, payment_number: p.paymentNumber, customer_id: p.customerId, customer_name: p.customerName,
      branch_id: p.branchId, invoice_id: p.invoiceId, invoice_number: p.invoiceNumber,
      payment_date_ad: p.paymentDateAD, payment_date_bs: p.paymentDateBS, amount: p.amount,
      payment_method: p.paymentMethod, notes: p.notes, status: p.status, fiscal_year_id: p.fiscalYearId,
      is_demo: p.isDemo, created_by: p.createdBy,
    })));

  await insertRows(client, 'vendor_payments',
    ['id', 'payment_number', 'supplier_id', 'supplier_name', 'branch_id', 'invoice_id', 'invoice_number',
      'payment_date_ad', 'payment_date_bs', 'amount', 'payment_method', 'notes', 'status', 'fiscal_year_id', 'is_demo', 'created_by'],
    count('vendorPayments', dataset.vendorPayments).map((p) => ({
      id: p.id, payment_number: p.paymentNumber, supplier_id: p.supplierId, supplier_name: p.supplierName,
      branch_id: p.branchId, invoice_id: p.invoiceId, invoice_number: p.invoiceNumber,
      payment_date_ad: p.paymentDateAD, payment_date_bs: p.paymentDateBS, amount: p.amount,
      payment_method: p.paymentMethod, notes: p.notes, status: p.status, fiscal_year_id: p.fiscalYearId,
      is_demo: p.isDemo, created_by: p.createdBy,
    })));

  // ---- ledger ------------------------------------------------------------
  await insertRows(client, 'gl_journals',
    ['id', 'journal_no', 'journal_date_ad', 'fiscal_year_id', 'period_id', 'branch_id', 'source_type', 'source_id', 'memo', 'status', 'posted_by', 'is_demo'],
    count('journals', dataset.journals).map((j) => ({
      id: j.id, journal_no: j.journalNo, journal_date_ad: j.journalDateAD, fiscal_year_id: j.fiscalYearId,
      period_id: j.periodId, branch_id: j.branchId, source_type: j.sourceType, source_id: j.sourceId,
      memo: j.memo, status: j.status, posted_by: j.postedBy, is_demo: j.isDemo,
    })));

  // line_no is per journal, even though ids are global.
  const lineNumbers = new Map<string, number>();
  const lineRows = dataset.journalLines.map((line) => {
    const next = (lineNumbers.get(line.journalId) || 0) + 1;
    lineNumbers.set(line.journalId, next);
    return {
      id: line.id, journal_id: line.journalId, line_no: next, account_id: `gla-${line.accountCode}`,
      branch_id: line.branchId, debit: line.debit, credit: line.credit, memo: line.memo,
    };
  });
  await insertRows(client, 'gl_journal_lines',
    ['id', 'journal_id', 'line_no', 'account_id', 'branch_id', 'debit', 'credit', 'memo'],
    count('journalLines', lineRows));

  await insertRows(client, 'gl_subledger_entries',
    ['id', 'journal_id', 'journal_line_id', 'account_id', 'subledger_id', 'subledger_type', 'party_id', 'party_name', 'branch_id', 'entry_date_ad', 'debit', 'credit'],
    dataset.subledgerEntries.map((s) => ({
      id: s.id, journal_id: s.journalId, journal_line_id: s.journalLineId, account_id: `gla-${s.accountCode}`,
      subledger_id: `gls-${s.accountCode}`,
      subledger_type: s.subledgerType, party_id: s.partyId, party_name: s.partyName, branch_id: s.branchId,
      entry_date_ad: s.entryDateAD, debit: s.debit, credit: s.credit,
    })));

  return summary;
}

/** Reads the seeded database back and reports the figures the brief names. */
export async function verifySeededDatabase(client: any): Promise<{ ok: boolean; report: Record<string, any> }> {
  const balance = async (codes: string[]) =>
    Number(
      (
        await client.query(
          `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS v
             FROM gl_journal_lines l
             JOIN gl_accounts a ON a.id = l.account_id
            WHERE a.code = ANY($1::text[])`,
          [codes]
        )
      ).rows[0].v
    );

  const ar = await balance(['1100']);
  const ap = -(await balance(['2100']));
  const inventory = await balance(['1200']);
  const cashAndBank = (await balance(['1010'])) + (await balance(['1020']));
  const equity = -(await balance(['3010']));
  const fixedAssets = await balance(['1520']);
  const prepaid = await balance(['1400']);

  const perBranch = (
    await client.query(
      `SELECT b.code,
              COALESCE(SUM(l.debit - l.credit), 0) AS difference
         FROM branches b
         LEFT JOIN gl_journal_lines l ON l.branch_id = b.id
        GROUP BY b.code ORDER BY b.code`
    )
  ).rows.map((r: any) => ({ branch: r.code, difference: Number(r.difference) }));

  const stock = (
    await client.query(
      `SELECT s.branch_id, MIN(s.quantity_on_hand) AS min_qty, MAX(s.quantity_on_hand) AS max_qty, COUNT(*)::int AS rows
         FROM inventory_stock s GROUP BY s.branch_id ORDER BY s.branch_id`
    )
  ).rows;

  const counts = (
    await client.query(
      `SELECT (SELECT COUNT(*)::int FROM branches) AS branches,
              (SELECT COUNT(*)::int FROM fiscal_years) AS fiscal_years,
              (SELECT COUNT(*)::int FROM users) AS users,
              (SELECT COUNT(*)::int FROM products) AS products,
              (SELECT COUNT(*)::int FROM customer_records) AS customers,
              (SELECT COUNT(*)::int FROM suppliers) AS vendors,
              (SELECT COUNT(*)::int FROM purchase_invoices) AS purchase_invoices,
              (SELECT COUNT(*)::int FROM sales_invoices) AS sales_invoices,
              (SELECT COUNT(*)::int FROM gl_journals) AS journals,
              (SELECT COUNT(*)::int FROM bs_day_records) AS bs_days`
    )
  ).rows[0];

  const report = { ar, ap, inventory, cashAndBank, equity, fixedAssets, prepaid, perBranch, stock, counts };
  const ok =
    Math.abs(ar - 10_000) < 0.005 &&
    Math.abs(ap - 15_000) < 0.005 &&
    Math.abs(inventory - 20_000) < 0.005 &&
    Math.abs(cashAndBank - 10_000) < 0.005 &&
    Math.abs(equity - 50_000) < 0.005 &&
    Math.abs(fixedAssets - 24_000) < 0.005 &&
    Math.abs(prepaid - 5_000) < 0.005 &&
    perBranch.every((row: any) => Math.abs(row.difference) < 0.005) &&
    stock.every((row: any) => row.min_qty === 5 && row.max_qty === 5) &&
    counts.fiscal_years === 2 &&
    counts.customers === 80 &&
    counts.bs_days > 0;
  return { ok, report };
}
