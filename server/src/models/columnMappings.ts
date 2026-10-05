/**
 * Column mappings for /api/bootstrap AND the server's operational cache
 * (CACHE_LOADS in state/runtimeState.ts) — the SINGLE SOURCE OF TRUTH for
 * which columns are read from each table and how they are aliased to
 * camelCase for the payload.
 *
 * To add a column to the bootstrap payload and the operational cache: add one
 * tuple here. Nothing else changes — the SQL, the Promise.all fan-out, and
 * the response assembly are all generated from these definitions (see
 * ./bootstrap.repo.ts), and runtimeState.ts builds its cache refresh queries
 * from the same configs via buildCacheLoads().
 *
 * Each column is a tuple: [db_column, camelCaseAlias, optionalCast?]
 * e.g. ['start_date_ad', 'startDateAD', '::text'] produces
 *      `start_date_ad::text AS "startDateAD"`
 */
export type ColumnDef = [dbColumn: string, alias: string, cast?: string];

/** Which filters the bootstrap endpoint applies to this table. */
export interface ScopeOptions {
  /** Single branch column, e.g. 'branch_id' */
  branchCol?: string;
  /** OR-pair of branch columns, e.g. ['source_branch_id', 'destination_branch_id'] */
  branchOrCols?: [string, string];
  /** Fiscal-year AD date-range column (start_date_ad / end_date_ad bounds) */
  dateCol?: string;
}

/** Per-table knobs that differ between the bootstrap payload and CACHE_LOADS. */
export interface CacheOptions {
  /** Extra column (db name only) selected by CACHE_LOADS but not bootstrap. */
  cacheOnlyColumns?: string[];
  /** CACHE_LOADS keeps a table's FULL history; bootstrap caps it at this many rows. */
  bootstrapLimitOnly?: number;
  /** CACHE_LOADS applies an extra static WHERE (e.g. fiscal-year scope), bootstrap does not. */
  cacheWhere?: string;
  /** CACHE_LOADS appends this LIMIT (used by company_profile). */
  cacheLimit?: number;
}

export interface TableQueryConfig {
  table: string;
  columns: ColumnDef[];
  scope?: ScopeOptions;
  orderBy?: string;
  limit?: number;
  /** CACHE_LOADS list (state/runtimeState.ts); absent = table is not cached. */
  cache?: CacheOptions;
}

/**
 * All tables read by GET /api/bootstrap, keyed by the payload field name the
 * server.ts handler consumes. Scoped tables are filtered by branch and/or the
 * selected fiscal year's AD date range in SQL (never in JavaScript).
 * Every entry carrying a `cache` block also feeds the operational-cache
 * refresh queries (see buildCacheLoads in state/runtimeState.ts).
 */
export const BOOTSTRAP_TABLES = {
  branches: {
    table: 'branches',
    cache: { cacheOnlyColumns: ['is_demo'], cacheWhere: 'ORDER BY code' },
    columns: [
      ['id', 'id'],
      ['code', 'code'],
      ['name', 'name'],
      ['location', 'location'],
      ['phone', 'phone'],
      ['is_headquarters', 'isHeadquarters'],
      ['active', 'active'],
      ['allow_procurement', 'allowProcurement'],
      ['allow_warehouse_transfer', 'allowWarehouseTransfer'],
    ],
  },
  products: {
    table: 'products',
    cache: { cacheOnlyColumns: ['is_demo'] },
    columns: [
      ['id', 'id'],
      ['sku', 'sku'],
      ['barcode', 'barcode'],
      ['name', 'name'],
      ['category', 'category'],
      ['product_group', 'productGroup'],
      ['unit', 'unit'],
      ['cost_price', 'costPrice'],
      ['selling_price', 'sellingPrice'],
      ['tax_rate', 'taxRate'],
      ['min_reorder_level', 'minReorderLevel'],
      ['requires_serial_tracking', 'requiresSerialTracking'],
      ['tracking_type', 'trackingType'],
      ['description', 'description'],
      ['status', 'status'],
    ],
  },
  stock: {
    table: 'inventory_stock',
    scope: { branchCol: 'branch_id' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['product_id', 'productId'],
      ['branch_id', 'branchId'],
      ['quantity_on_hand', 'quantityOnHand'],
      ['damaged_qty', 'damagedQty'],
      ['reserved_qty', 'reservedQty'],
      ['incoming_qty', 'incomingQty'],
      ['min_reorder_level', 'minReorderLevel'],
    ],
  },
  assets: {
    table: 'fixed_assets',
    // Fixed assets are long-term assets that persist across all fiscal years —
    // branch-scoped only, never filtered by fiscal year date range.
    scope: { branchCol: 'branch_id' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['tag_number', 'tagNumber'],
      ['name', 'name'],
      ['category', 'category'],
      ['branch_id', 'branchId'],
      ['acquisition_date_ad', 'acquisitionDateAD'],
      ['acquisition_date_bs', 'acquisitionDateBS'],
      ['purchase_invoice_date_ad', 'purchaseInvoiceDateAD'],
      ['purchase_invoice_date_bs', 'purchaseInvoiceDateBS'],
      ['capitalization_date_ad', 'capitalizationDateAD'],
      ['placed_in_service_date_ad', 'placedInServiceDateAD'],
      ['acquisition_cost', 'acquisitionCost'],
      ['depreciation_method', 'depreciationMethod'],
      ['depreciation_rate_percent', 'depreciationRatePercent'],
      ['accumulated_depreciation', 'accumulatedDepreciation'],
      ['net_book_value', 'netBookValue'],
      ['status', 'status'],
      ['supplier_name', 'supplierName'],
      ['invoice_no', 'invoiceNo'],
      ['purchase_invoice_id', 'purchaseInvoiceId'],
      ['assigned_type', 'assignedType'],
      ['assigned_customer_id', 'assignedCustomerId'],
      ['assigned_customer_name', 'assignedCustomerName'],
      ['assigned_location_id', 'assignedLocationId'],
      ['assigned_location_name', 'assignedLocationName'],
      ['assignment_date_ad', 'assignmentDateAD'],
      ['assignment_date_bs', 'assignmentDateBS'],
      ['assignment_notes', 'assignmentNotes'],
      ['device_serial', 'deviceSerial'],
    ],
  },
  customerDevices: {
    table: 'customer_device_records',
    scope: { branchCol: 'branch_id', dateCol: 'issued_date_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['customer_id', 'customerId'],
      ['customer_name', 'customerName'],
      ['customer_code', 'customerCode'],
      ['contact_phone', 'contactPhone'],
      ['installation_address', 'installationAddress'],
      ['branch_id', 'branchId'],
      ['product_name', 'productName'],
      ['device_serial', 'deviceSerial'],
      ['pon_serial', 'ponSerial'],
      ['mac_address', 'macAddress'],
      ['status', 'status'],
      ['issued_date_ad', 'issuedDateAD'],
      ['issued_date_bs', 'issuedDateBS'],
      ['purchase_bill_ref', 'purchaseBillRef'],
      ['notes', 'notes'],
    ],
  },
  customers: {
    table: 'customer_records',
    scope: { branchCol: 'branch_id' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['customer_id', 'customerId'],
      ['customer_name', 'customerName'],
      ['username', 'username'],
      ['contact_number', 'contactNumber'],
      ['branch_id', 'branchId'],
      ['address', 'address'],
      ['email', 'email'],
      ['status', 'status'],
      ['credit_limit', 'creditLimit'],
      ['assigned_devices_count', 'assignedDevicesCount'],
    ],
  },
  purchaseOrders: {
    table: 'purchase_orders',
    scope: { branchCol: 'branch_id', dateCol: 'order_date_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['po_number', 'poNumber'],
      ['supplier_id', 'supplierId'],
      ['supplier_name', 'supplierName'],
      ['branch_id', 'branchId'],
      ['order_date_ad', 'orderDateAD'],
      ['order_date_bs', 'orderDateBS'],
      ['expected_delivery_date_ad', 'expectedDeliveryDateAD'],
      ['status', 'status'],
      ['subtotal_amount', 'subtotalAmount'],
      ['tax_amount', 'taxAmount'],
      ['total_amount', 'totalAmount'],
      ['notes', 'notes'],
      ['items', 'items'],
    ],
  },
  purchaseInvoices: {
    table: 'purchase_invoices',
    scope: { branchCol: 'branch_id', dateCol: 'invoice_date_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['invoice_number', 'invoiceNumber'],
      ['po_reference_id', 'poReferenceId'],
      ['vendor_bill_number', 'vendorBillNumber'],
      ['supplier_id', 'supplierId'],
      ['supplier_name', 'supplierName'],
      ['branch_id', 'branchId'],
      ['invoice_date_ad', 'invoiceDateAD'],
      ['invoice_date_bs', 'invoiceDateBS'],
      ['due_date_ad', 'dueDateAD'],
      ['due_date_bs', 'dueDateBS'],
      ['taxable_amount', 'taxableAmount'],
      ['vat_amount', 'vatAmount'],
      ['non_taxable_amount', 'nonTaxableAmount'],
      ['grand_total', 'grandTotal'],
      ['payment_status', 'paymentStatus'],
      ['amount_paid', 'amountPaid'],
      ['items', 'items'],
    ],
  },
  salesInvoices: {
    table: 'sales_invoices',
    scope: { branchCol: 'branch_id', dateCol: 'invoice_date_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['invoice_number', 'invoiceNumber'],
      ['customer_id', 'customerId'],
      ['customer_name', 'customerName'],
      ['branch_id', 'branchId'],
      ['invoice_date_ad', 'invoiceDateAD'],
      ['invoice_date_bs', 'invoiceDateBS'],
      ['due_date_ad', 'dueDateAD'],
      ['due_date_bs', 'dueDateBS'],
      ['taxable_amount', 'taxableAmount'],
      ['vat_amount', 'vatAmount'],
      ['non_taxable_amount', 'nonTaxableAmount'],
      ['grand_total', 'grandTotal'],
      ['payment_status', 'paymentStatus'],
      ['amount_paid', 'amountPaid'],
      ['status', 'status'],
      ['items', 'items'],
    ],
  },
  purchaseReturns: {
    table: 'purchase_returns',
    scope: { branchCol: 'branch_id', dateCol: 'return_date_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['return_number', 'returnNumber'],
      ['original_invoice_id', 'originalInvoiceId'],
      ['original_invoice_number', 'originalInvoiceNumber'],
      ['supplier_id', 'supplierId'],
      ['supplier_name', 'supplierName'],
      ['branch_id', 'branchId'],
      ['return_date_ad', 'returnDateAD'],
      ['return_date_bs', 'returnDateBS'],
      ['reason', 'reason'],
      ['taxable_amount', 'taxableAmount'],
      ['vat_amount', 'vatAmount'],
      ['non_taxable_amount', 'nonTaxableAmount'],
      ['grand_total', 'grandTotal'],
      ['status', 'status'],
      ['items', 'items'],
    ],
  },
  salesReturns: {
    table: 'sales_returns',
    scope: { branchCol: 'branch_id', dateCol: 'return_date_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['return_number', 'returnNumber'],
      ['original_invoice_id', 'originalInvoiceId'],
      ['original_invoice_number', 'originalInvoiceNumber'],
      ['customer_id', 'customerId'],
      ['customer_name', 'customerName'],
      ['branch_id', 'branchId'],
      ['return_date_ad', 'returnDateAD'],
      ['return_date_bs', 'returnDateBS'],
      ['reason', 'reason'],
      ['restockable', 'restockable'],
      ['taxable_amount', 'taxableAmount'],
      ['vat_amount', 'vatAmount'],
      ['non_taxable_amount', 'nonTaxableAmount'],
      ['grand_total', 'grandTotal'],
      ['status', 'status'],
      ['items', 'items'],
    ],
  },
  shipments: {
    table: 'shipments',
    scope: { branchOrCols: ['source_branch_id', 'destination_branch_id'], dateCol: 'dispatch_date_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['tracking_code', 'trackingCode'],
      ['type', 'type'],
      ['source_branch_id', 'sourceBranchId'],
      ['source_branch_name', 'sourceBranchName'],
      ['destination_branch_id', 'destinationBranchId'],
      ['destination_branch_name', 'destinationBranchName'],
      ['dispatch_date_ad', 'dispatchDateAD'],
      ['dispatch_date_bs', 'dispatchDateBS'],
      ['estimated_arrival_ad', 'estimatedArrivalAD'],
      ['status', 'status'],
      ['notes', 'notes'],
      ['items', 'items'],
      ['received_by_notes', 'receivedByNotes'],
      ['received_date_ad', 'receivedDateAD'],
      ['received_date_bs', 'receivedDateBS'],
      ['has_discrepancy', 'hasDiscrepancy'],
    ],
  },
  stockOperations: {
    table: 'stock_operations',
    scope: { branchCol: 'branch_id', dateCol: 'date_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['reference_number', 'referenceNumber'],
      ['type', 'type'],
      ['technician_name', 'technicianName'],
      ['work_order_ref', 'workOrderRef'],
      ['branch_id', 'branchId'],
      ['branch_name', 'branchName'],
      ['destination_warehouse_id', 'destinationWarehouseId'],
      ['destination_warehouse_name', 'destinationWarehouseName'],
      ['product_id', 'productId'],
      ['quantity_changed', 'quantityChanged'],
      ['cost_per_unit', 'costPerUnit'],
      ['total_value', 'totalValue'],
      ['reason', 'reason'],
      ['inspector_name', 'inspectorName'],
      ['date_ad', 'dateAD'],
      ['date_bs', 'dateBS'],
      ['fiscal_year', 'fiscalYear'],
      ['status', 'status'],
      ['items', 'items'],
    ],
  },
  auditLogs: {
    table: 'audit_logs',
    scope: { dateCol: 'timestamp_ad' },
    orderBy: 'timestamp_ad DESC',
    // CACHE_LOADS keeps the full audit history; bootstrap caps the payload.
    cache: { bootstrapLimitOnly: 200 },
    columns: [
      ['id', 'id'],
      ['user_email', 'userEmail'],
      ['user_name', 'userName'],
      ['action', 'action'],
      ['module', 'module'],
      ['details', 'details'],
      ['timestamp_ad', 'timestampAD'],
      ['timestamp_bs', 'timestampBS'],
      ['branch_id', 'branchId'],
    ],
  },
  transactionLogs: {
    table: 'transaction_logs',
    scope: { dateCol: 'timestamp_ad' },
    orderBy: 'timestamp_ad DESC',
    cache: {},
    columns: [
      ['id', 'id'],
      ['transaction_number', 'transactionNumber'],
      ['product_id', 'productId'],
      ['product_sku', 'productSku'],
      ['product_name', 'productName'],
      ['branch_id', 'branchId'],
      ['change_type', 'changeType'],
      ['quantity_before', 'quantityBefore'],
      ['quantity_changed', 'quantityChanged'],
      ['quantity_after', 'quantityAfter'],
      ['unit_cost', 'unitCost'],
      ['reference_doc_id', 'referenceDocId'],
      ['timestamp_ad', 'timestampAD'],
      ['timestamp_bs', 'timestampBS'],
    ],
  },
  suppliers: {
    table: 'suppliers',
    cache: { cacheOnlyColumns: ['is_demo'], cacheWhere: 'ORDER BY name ASC' },
    columns: [
      ['id', 'id'],
      ['supplier_code', 'supplierCode'],
      ['name', 'name'],
      ['contact_person', 'contactPerson'],
      ['phone', 'phone'],
      ['email', 'email'],
      ['address', 'address'],
      ['pan_vat_number', 'panVatNumber'],
      ['rating', 'rating'],
      ['status', 'status'],
    ],
  },
  users: {
    table: 'users',
    // Password hashes ride along in the users cache: the login endpoint
    // authenticates from this array.
    cache: { cacheOnlyColumns: ['password'], cacheWhere: 'ORDER BY created_at ASC' },
    columns: [
      ['id', 'id'],
      ['email', 'email'],
      ['name', 'name'],
      ['role', 'role'],
      ['branch_id', 'branchId'],
      ['allowed_branch_ids', 'allowedBranchIds'],
      ['can_switch_user', 'canSwitchUser'],
    ],
  },
  approvalRequests: {
    table: 'approval_requests',
    scope: { branchCol: 'branch_id', dateCol: 'requested_at_ad' },
    cache: {},
    columns: [
      ['id', 'id'],
      ['request_number', 'requestNumber'],
      ['type', 'type'],
      ['target_id', 'targetId'],
      ['customer_name', 'customerName'],
      ['customer_code', 'customerCode'],
      ['device_serial', 'deviceSerial'],
      ['pon_serial', 'ponSerial'],
      ['product_name', 'productName'],
      ['current_status', 'currentStatus'],
      ['requested_status', 'requestedStatus'],
      ['requested_by_role', 'requestedByRole'],
      ['requested_by_email', 'requestedByEmail'],
      ['requested_by_name', 'requestedByName'],
      ['branch_id', 'branchId'],
      ['branch_name', 'branchName'],
      ['reason', 'reason'],
      ['restock_qty_on_approval', 'restockQtyOnApproval'],
      ['status', 'status'],
      ['requested_at_ad', 'requestedAtAD'],
      ['requested_at_bs', 'requestedAtBS'],
      ['fiscal_year_id', 'fiscalYearId'],
    ],
  },
  categories: {
    table: 'categories',
    orderBy: 'name ASC',
    cache: { cacheOnlyColumns: ['is_demo'] },
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['code', 'code'],
      ['description', 'description'],
      ['is_special_tracked', 'isSpecialTracked'],
    ],
  },
  uom: {
    table: 'uom',
    orderBy: 'name ASC',
    cache: {},
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['symbol', 'symbol'],
      ['type', 'type'],
      ['is_base_unit', 'isBaseUnit'],
    ],
  },
  locations: {
    table: 'locations',
    scope: { branchCol: 'branch_id' },
    cache: { cacheOnlyColumns: ['is_demo'], cacheWhere: 'ORDER BY name ASC' },
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['type', 'type'],
      ['branch_id', 'branchId'],
      ['address', 'address'],
      ['coordinates', 'coordinates'],
      ['contact_person', 'contactPerson'],
      ['contact_phone', 'contactPhone'],
      ['notes', 'notes'],
      ['active_assets_count', 'activeAssetsCount'],
    ],
  },
  companyProfile: {
    table: 'company_profile',
    limit: 1,
    cache: { cacheLimit: 1 },
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['legal_name', 'legalName'],
      ['tagline', 'tagline'],
      ['address', 'address'],
      ['city', 'city'],
      ['country', 'country'],
      ['postal_code', 'postalCode'],
      ['phone', 'phone'],
      ['email', 'email'],
      ['website', 'website'],
      ['pan_vat_number', 'panVatNumber'],
      ['registration_number', 'registrationNumber'],
      ['logo_url', 'logoUrl'],
      ['logo_preset', 'logoPreset'],
      ['currency_symbol', 'currencySymbol'],
      ['currency_code', 'currencyCode'],
      ['currency_locale', 'currencyLocale'],
      ['currency_position', 'currencyPosition'],
      ['currency_decimals', 'currencyDecimals'],
      ['default_tax_rate', 'defaultTaxRate'],
      ['notes', 'notes'],
    ],
  },
  damageRecords: {
    table: 'damage_records',
    scope: { branchCol: 'branch_id', dateCol: 'damage_date_ad' },
    orderBy: 'damage_date_ad DESC',
    cache: {},
    columns: [
      ['id', 'id'],
      ['damage_reference', 'damageReference'],
      ['product_id', 'productId'],
      ['branch_id', 'branchId'],
      ['quantity_damaged', 'quantityDamaged'],
      ['unit_cost', 'unitCost'],
      ['total_cost', 'totalCost'],
      ['damage_date_ad', 'damageDateAD'],
      ['damage_date_bs', 'damageDateBS'],
      ['damage_reason', 'damageReason'],
      ['status', 'status'],
      ['disposal_date_ad', 'disposalDateAD'],
      ['disposal_date_bs', 'disposalDateBS'],
      ['disposal_method', 'disposalMethod'],
      ['salvage_value', 'salvageValue'],
      ['gl_account_code', 'glAccountCode'],
      ['write_off_loss', 'writeOffLoss'],
      ['approved_by', 'approvedBy'],
      ['notes', 'notes'],
      ['fiscal_year_id', 'fiscalYearId'],
      ['is_demo', 'isDemo'],
      ['created_by', 'createdBy'],
      ['created_at', 'createdAt'],
      ['updated_at', 'updatedAt'],
    ],
  },
  vendorPayments: {
    table: 'vendor_payments',
    scope: { branchCol: 'branch_id', dateCol: 'payment_date_ad' },
    orderBy: 'payment_date_ad DESC, created_at DESC',
    cache: {},
    columns: [
      ['id', 'id'],
      ['payment_number', 'paymentNumber'],
      ['supplier_id', 'supplierId'],
      ['supplier_name', 'supplierName'],
      ['branch_id', 'branchId'],
      ['invoice_id', 'invoiceId'],
      ['invoice_number', 'invoiceNumber'],
      ['payment_date_ad', 'paymentDateAD'],
      ['payment_date_bs', 'paymentDateBS'],
      ['amount', 'amount'],
      ['payment_method', 'paymentMethod'],
      ['bank_name', 'bankName'],
      ['bank_branch', 'bankBranch'],
      ['account_number', 'accountNumber'],
      ['cheque_number', 'chequeNumber'],
      ['cheque_date_ad', 'chequeDateAD'],
      ['cheque_date_bs', 'chequeDateBS'],
      ['transaction_reference', 'transactionReference'],
      ['notes', 'notes'],
      ['status', 'status'],
      ['reversal_reason', 'reversalReason'],
      ['reversed_by', 'reversedBy'],
      ['reversed_at_ad', 'reversedAtAD'],
      ['original_payment_id', 'originalPaymentId'],
      ['fiscal_year_id', 'fiscalYearId'],
      ['is_demo', 'isDemo'],
      ['created_by', 'createdBy'],
      ['created_at', 'createdAt'],
      ['updated_at', 'updatedAt'],
    ],
  },
  serialLogs: {
    table: 'serial_log',
    // Serial log is a persistent register (like fixed assets) — branch-scoped
    // only, never fiscal-year-scoped.
    scope: { branchCol: 'branch_id' },
    orderBy: 'created_at DESC',
    cache: {},
    columns: [
      ['id', 'id'],
      ['device_serial', 'deviceSerial'],
      ['pon_serial', 'ponSerial'],
      ['mac_address', 'macAddress'],
      ['product_id', 'productId'],
      ['product_name', 'productName'],
      ['branch_id', 'branchId'],
      ['customer_id', 'customerId'],
      ['customer_name', 'customerName'],
      ['status', 'status'],
      ['source_type', 'sourceType'],
      ['source_id', 'sourceId'],
      ['history_json', 'historyJson'],
      ['created_at', 'createdAt'],
      ['updated_at', 'updatedAt'],
    ],
  },
  // -----------------------------------------------------------------------------
  // CACHE-ONLY TABLES — read by the operational cache (CACHE_LOADS in
  // state/runtimeState.ts) but NOT fetched by GET /api/bootstrap (which gets
  // fiscal years via fetchFiscalYears's ::text-cast query and never ships the
  // customer-payments sub-ledger wholesale).
  // -----------------------------------------------------------------------------
  fiscalYears: {
    table: 'fiscal_years',
    cache: { cacheWhere: 'ORDER BY start_date_ad DESC' },
    columns: [
      ['id', 'id'],
      ['code', 'code'],
      ['start_date_ad', 'startDateAD', '::text'],
      ['end_date_ad', 'endDateAD', '::text'],
      ['start_date_bs', 'startDateBS'],
      ['end_date_bs', 'endDateBS'],
      ['is_current', 'isCurrent'],
      ['is_closed', 'isClosed'],
      ['is_demo', 'isDemo'],
    ],
  },
  customerPayments: {
    table: 'customer_payments',
    cache: { cacheWhere: 'ORDER BY payment_date_ad DESC, created_at DESC' },
    columns: [
      ['id', 'id'],
      ['payment_number', 'paymentNumber'],
      ['customer_id', 'customerId'],
      ['customer_name', 'customerName'],
      ['branch_id', 'branchId'],
      ['invoice_id', 'invoiceId'],
      ['invoice_number', 'invoiceNumber'],
      ['payment_date_ad', 'paymentDateAD'],
      ['payment_date_bs', 'paymentDateBS'],
      ['amount', 'amount'],
      ['payment_method', 'paymentMethod'],
      ['bank_name', 'bankName'],
      ['bank_branch', 'bankBranch'],
      ['account_number', 'accountNumber'],
      ['cheque_number', 'chequeNumber'],
      ['cheque_date_ad', 'chequeDateAD'],
      ['cheque_date_bs', 'chequeDateBS'],
      ['transaction_reference', 'transactionReference'],
      ['notes', 'notes'],
      ['status', 'status'],
      ['reversal_reason', 'reversalReason'],
      ['reversed_by', 'reversedBy'],
      ['reversed_at_ad', 'reversedAtAD'],
      ['original_payment_id', 'originalPaymentId'],
      ['fiscal_year_id', 'fiscalYearId'],
      ['is_demo', 'isDemo'],
      ['created_by', 'createdBy'],
      ['created_at', 'createdAt'],
      ['updated_at', 'updatedAt'],
    ],
  },
} as const satisfies Record<string, TableQueryConfig>;

/**
 * Build the operational-cache refresh query for one table config (no WHERE
 * scoping: the cache always reads every branch and every fiscal year).
 * Ordering: the per-table cache override wins, otherwise the table's standard
 * orderBy applies (the cache previously ordered these the same way).
 */
export function buildCacheSelectSql(cfg: TableQueryConfig): string {
  const cache = cfg.cache || {};
  const selectList = [
    ...cfg.columns.map(([col, alias, cast]) => `${col}${cast || ''} AS "${alias}"`),
    ...(cache.cacheOnlyColumns || []).map((col) => `${col} AS "${col.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}"`),
  ].join(', ');
  let sql = `SELECT ${selectList} FROM ${cfg.table}`;
  const order = cache.cacheWhere || (cfg.orderBy ? `ORDER BY ${cfg.orderBy}` : '');
  if (order) sql += ` ${order}`;
  if (cache.cacheLimit) sql += ` LIMIT ${cache.cacheLimit}`;
  return sql;
}
