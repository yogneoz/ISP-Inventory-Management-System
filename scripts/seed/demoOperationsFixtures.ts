/**
 * Canonical demo operations fixtures: CPE records, warranties, damage, stock
 * operations, purchase orders, returns and inter-branch shipments.
 *
 * Statuses are deliberately non-posting (draft returns, a transit shipment and
 * stock-operation logs) so these fixtures add visible operational history
 * without changing live stock or the verified ledger.
 */
import type { VerificationDataset } from './verificationDataset';
import { bsOn, insertRows, type Row } from './fixtureUtils';

const SEED = 'seed:verify';

function addMonths(adDate: string, months: number): string {
  const date = new Date(`${adDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

export interface DemoOperationsFixtures {
  customerDevices: Row[];
  warranties: Row[];
  damage: Row[];
  stockOperations: Row[];
  purchaseOrders: Row[];
  purchaseReturns: Row[];
  salesReturns: Row[];
  shipments: Row[];
}

export function buildDemoOperationsFixtures(dataset: VerificationDataset): DemoOperationsFixtures {
  const customerById = new Map(dataset.customers.map((customer: any) => [customer.id, customer]));
  const productById = new Map(dataset.products.map((product: any) => [product.id, product]));
  const branchById = new Map(dataset.branches.map((branch: any) => [branch.id, branch]));

  const soldKtm = dataset.serialLogs
    .filter((serial: any) => serial.branchId === 'BR-KTM' && serial.status === 'SOLD' && serial.customerId)
    .slice(0, 6);

  const customerDevices: Row[] = soldKtm.map((serial: any, index: number) => {
    const customer = customerById.get(serial.customerId) as any;
    return {
      id: `demo-cdr-${index + 1}`,
      customer_id: serial.customerId,
      customer_name: customer?.customerName ?? serial.customerName,
      customer_code: customer?.customerId ?? serial.customerId,
      branch_id: serial.branchId,
      branch_name: branchById.get(serial.branchId)?.name ?? 'Kathmandu (Head Office)',
      device_type: serial.productName,
      product_id: serial.productId,
      product_name: serial.productName,
      device_serial: serial.deviceSerial,
      pon_serial: serial.ponSerial,
      // The verification serials intentionally share one demo MAC; the CPE register
      // enforces unique non-empty MACs, so leave it empty rather than dropping rows.
      mac_address: null,
      issued_date_ad: '2026-08-15',
      issued_date_bs: bsOn('2026-08-15'),
      fiscal_year_id: 'fy-2083',
      purchase_bill_ref: `INV-KTM-DEMO-${String(index + 1).padStart(3, '0')}`,
      installation_address: 'Kathmandu, Bagmati Province',
      status: 'ACTIVE',
      notes: 'Demo CPE installed on the customer service line.',
      is_demo: true,
      created_by: SEED,
    };
  });

  const warranties: Row[] = [];
  let warrantySequence = 1;
  const nextWarrantyId = () => `demo-warranty-${String(warrantySequence++).padStart(3, '0')}`;

  for (const asset of dataset.fixedAssets.slice(0, 4)) {
    const start = String(asset.acquisitionDateAD ?? '2025-08-01').slice(0, 10);
    warranties.push({
      id: nextWarrantyId(),
      coverage_type: 'VENDOR',
      item_category: 'FIXED_ASSET',
      asset_id: asset.id,
      product_id: null,
      device_record_id: null,
      product_name: asset.name,
      serial_number: asset.tagNumber,
      branch_id: asset.branchId,
      party_name: 'Demo Equipment Supplier',
      start_date_ad: start,
      start_date_bs: bsOn(start),
      end_date_ad: addMonths(start, 24),
      end_date_bs: bsOn(addMonths(start, 24)),
      start_basis: 'ACQUISITION_DATE',
      term_months: 24,
      source_type: 'MANUAL',
      source_id: asset.id,
      source_number: asset.tagNumber,
      is_current: true,
      is_demo: true,
      created_by: SEED,
    });
  }

  for (const device of customerDevices.slice(0, 3)) {
    warranties.push({
      id: nextWarrantyId(),
      coverage_type: 'SELLER',
      item_category: 'CPE',
      asset_id: null,
      product_id: device.product_id,
      device_record_id: device.id,
      product_name: device.product_name,
      serial_number: device.device_serial,
      branch_id: device.branch_id,
      party_name: device.customer_name,
      start_date_ad: '2026-08-15',
      start_date_bs: bsOn('2026-08-15'),
      end_date_ad: '2027-08-14',
      end_date_bs: bsOn('2027-08-14'),
      start_basis: 'SALE_DATE',
      term_months: 12,
      source_type: 'SALE',
      source_id: 'demo-cdr',
      source_number: device.purchase_bill_ref,
      is_current: true,
      is_demo: true,
      created_by: SEED,
    });
  }

  for (const device of customerDevices.slice(3, 5)) {
    warranties.push({
      id: nextWarrantyId(),
      coverage_type: 'VENDOR',
      item_category: 'SOLD_PRODUCT',
      asset_id: null,
      product_id: device.product_id,
      device_record_id: null,
      product_name: device.product_name,
      serial_number: device.device_serial,
      branch_id: device.branch_id,
      party_name: 'Kathmandu Vendor 1',
      start_date_ad: '2026-08-15',
      start_date_bs: bsOn('2026-08-15'),
      end_date_ad: '2027-08-14',
      end_date_bs: bsOn('2027-08-14'),
      start_basis: 'INVOICE_DATE',
      term_months: 12,
      source_type: 'PURCHASE',
      source_id: 'pi-ktm-4',
      source_number: 'PI-KTM-202607190004',
      is_current: true,
      is_demo: true,
      created_by: SEED,
    });
  }

  const damageProducts = ['prd-cbl-drop', 'prd-cbl-patch', 'prd-con-fast', 'prd-adp-sc']
    .map((id) => productById.get(id))
    .filter(Boolean) as any[];
  const damageBranches = ['BR-KTM', 'BR-PKR', 'BR-BTL', 'BR-DHN'];
  const damageStatuses = ['IDENTIFIED', 'DISPOSED', 'WRITTEN_OFF', 'IDENTIFIED'] as const;
  const damageDates = ['2026-10-12', '2026-10-18', '2026-10-25', '2026-11-02'];
  const damage: Row[] = damageProducts.map((product, index) => {
    const branchId = damageBranches[index];
    const status = damageStatuses[index];
    return {
      id: `demo-damage-${index + 1}`,
      damage_reference: `DMG-DEMO-${String(index + 1).padStart(3, '0')}`,
      product_id: product.id,
      product_name: product.name,
      branch_id: branchId,
      branch_name: branchById.get(branchId)?.name ?? branchId,
      quantity_damaged: 1,
      unit_cost: product.costPrice ?? 50,
      total_cost: product.costPrice ?? 50,
      damage_date_ad: damageDates[index],
      damage_date_bs: bsOn(damageDates[index]),
      damage_reason: index % 2 === 0 ? 'PHYSICAL_DAMAGE' : 'STORAGE_DAMAGE',
      status,
      gl_account_code: '7050',
      write_off_loss: status === 'IDENTIFIED' ? 0 : (product.costPrice ?? 50),
      disposal_method: status === 'DISPOSED' ? 'SCRAP_DESTRUCTION' : null,
      disposal_date_ad: status === 'DISPOSED' ? '2026-10-20' : null,
      disposal_date_bs: status === 'DISPOSED' ? bsOn('2026-10-20') : null,
      approved_by: status === 'IDENTIFIED' ? null : 'superadmin@example.com',
      notes: 'Demo damage register entry.',
      fiscal_year: '2083-84',
      fiscal_year_id: 'fy-2083',
      is_demo: true,
      created_by: SEED,
    };
  });

  const operationProduct = (sku: string) => productById.get(`prd-${sku}`) as any;
  const pullProduct = operationProduct('onu-100');
  const consumableProduct = operationProduct('con-fast');
  const adjustmentProduct = operationProduct('cbl-drop');
  const disposalProduct = operationProduct('adp-sc');

  const stockOperations: Row[] = [
    {
      id: 'demo-stockop-pullout-1', reference_number: 'SO-DEMO-PULLOUT-001', type: 'PULLOUT',
      technician_name: 'Aarav Sharma', work_order_ref: 'WO-2083-001',
      branch_id: 'BR-KTM', branch_name: 'Kathmandu (Head Office)',
      destination_warehouse_id: 'BR-PKR', destination_warehouse_name: 'Pokhara Branch',
      product_id: pullProduct?.id ?? 'prd-onu-100', quantity_changed: -2,
      cost_per_unit: pullProduct?.costPrice ?? 50, total_value: 100,
      reason: 'Pulled two ONUs for a Pokhara customer installation.',
      date_ad: '2026-10-10', date_bs: bsOn('2026-10-10'), fiscal_year: '2083-84',
      fiscal_year_id: 'fy-2083', status: 'LOGGED',
      items: JSON.stringify([{ productId: pullProduct?.id, productName: pullProduct?.name, quantity: 2, unitCost: pullProduct?.costPrice ?? 50, totalValue: 100 }]),
      is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-stockop-damage-1', reference_number: 'SO-DEMO-DAMAGE-001', type: 'DAMAGE',
      technician_name: 'Nisha Karki', work_order_ref: 'WO-2083-002',
      branch_id: 'BR-KTM', branch_name: 'Kathmandu (Head Office)',
      destination_warehouse_id: null, destination_warehouse_name: null,
      product_id: adjustmentProduct?.id ?? 'prd-cbl-drop', quantity_changed: -1,
      cost_per_unit: adjustmentProduct?.costPrice ?? 50, total_value: 50,
      reason: 'Drop cable damaged while preparing a customer kit.',
      date_ad: '2026-10-12', date_bs: bsOn('2026-10-12'), fiscal_year: '2083-84',
      fiscal_year_id: 'fy-2083', status: 'LOGGED',
      items: JSON.stringify([{ productId: adjustmentProduct?.id, productName: adjustmentProduct?.name, quantity: 1, unitCost: adjustmentProduct?.costPrice ?? 50, totalValue: 50 }]),
      is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-stockop-consumable-1', reference_number: 'SO-DEMO-CONSUMABLE-001', type: 'CONSUMABLE_ISSUE',
      technician_name: 'Bikash Thapa', work_order_ref: 'WO-2083-003',
      branch_id: 'BR-PKR', branch_name: 'Pokhara Branch',
      destination_warehouse_id: null, destination_warehouse_name: null,
      product_id: consumableProduct?.id ?? 'prd-con-fast', quantity_changed: -5,
      cost_per_unit: consumableProduct?.costPrice ?? 50, total_value: 250,
      reason: 'Fast connectors issued to the field installation team.',
      date_ad: '2026-10-15', date_bs: bsOn('2026-10-15'), fiscal_year: '2083-84',
      fiscal_year_id: 'fy-2083', status: 'LOGGED',
      items: JSON.stringify([{ productId: consumableProduct?.id, productName: consumableProduct?.name, quantity: 5, unitCost: consumableProduct?.costPrice ?? 50, totalValue: 250 }]),
      is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-stockop-adjust-1', reference_number: 'SO-DEMO-ADJUST-001', type: 'MANUAL_ADJUSTMENT',
      technician_name: 'Inventory Manager', work_order_ref: 'WO-2083-004',
      branch_id: 'BR-BTL', branch_name: 'Butwal Branch',
      destination_warehouse_id: null, destination_warehouse_name: null,
      product_id: adjustmentProduct?.id ?? 'prd-cbl-drop', quantity_changed: 1,
      cost_per_unit: adjustmentProduct?.costPrice ?? 50, total_value: 50,
      reason: 'Cycle count found one additional drop cable roll.',
      date_ad: '2026-10-22', date_bs: bsOn('2026-10-22'), fiscal_year: '2083-84',
      fiscal_year_id: 'fy-2083', status: 'LOGGED',
      items: JSON.stringify([{ productId: adjustmentProduct?.id, productName: adjustmentProduct?.name, quantity: 1, unitCost: adjustmentProduct?.costPrice ?? 50, totalValue: 50 }]),
      is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-stockop-disposal-1', reference_number: 'SO-DEMO-DISPOSAL-001', type: 'DISPOSAL',
      technician_name: 'Inventory Manager', work_order_ref: 'WO-2083-005',
      branch_id: 'BR-DHN', branch_name: 'Dharan Branch',
      destination_warehouse_id: null, destination_warehouse_name: null,
      product_id: disposalProduct?.id ?? 'prd-adp-sc', quantity_changed: -1,
      cost_per_unit: disposalProduct?.costPrice ?? 50, total_value: 50,
      reason: 'Broken adapter disposed after the branch damage review.',
      date_ad: '2026-10-28', date_bs: bsOn('2026-10-28'), fiscal_year: '2083-84',
      fiscal_year_id: 'fy-2083', status: 'LOGGED',
      items: JSON.stringify([{ productId: disposalProduct?.id, productName: disposalProduct?.name, quantity: 1, unitCost: disposalProduct?.costPrice ?? 50, totalValue: 50 }]),
      is_demo: true, created_by: SEED,
    },
  ];

  const poProduct = productById.get('prd-rtr-100') as any;
  const poItem = (quantity: number) => [{
    productId: poProduct?.id ?? 'prd-rtr-100',
    productName: poProduct?.name ?? 'WiFi Router N300',
    sku: poProduct?.sku ?? 'RTR-100',
    quantity,
    unitPrice: poProduct?.costPrice ?? 50,
    total: quantity * (poProduct?.costPrice ?? 50),
  }];
  const poRows: Row[] = [
    {
      id: 'demo-po-1', po_number: 'PO-2083-DEMO-001', supplier_id: 'V-KTM-1', supplier_name: 'Kathmandu Vendor 1',
      branch_id: 'BR-KTM', branch_name: 'Kathmandu (Head Office)',
      order_date_ad: '2026-08-01', order_date_bs: bsOn('2026-08-01'),
      expected_delivery_date_ad: '2026-08-15', expected_delivery_date_bs: bsOn('2026-08-15'),
      status: 'APPROVED', items: JSON.stringify(poItem(10)), subtotal_amount: 500, tax_amount: 0, total_amount: 500,
      notes: 'Demo router replenishment order.', fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-po-2', po_number: 'PO-2083-DEMO-002', supplier_id: 'V-PKR-1', supplier_name: 'Pokhara Vendor 1',
      branch_id: 'BR-PKR', branch_name: 'Pokhara Branch',
      order_date_ad: '2026-09-05', order_date_bs: bsOn('2026-09-05'),
      expected_delivery_date_ad: '2026-09-20', expected_delivery_date_bs: bsOn('2026-09-20'),
      status: 'DRAFT', items: JSON.stringify(poItem(5)), subtotal_amount: 250, tax_amount: 0, total_amount: 250,
      notes: 'Demo draft order for the Pokhara branch.', fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
    },
  ];

  const purchaseReturnInvoice = dataset.purchaseInvoices.find((invoice: any) => invoice.branchId === 'BR-KTM');
  const purchaseReturns: Row[] = [{
    id: 'demo-purchase-return-1', return_number: 'PRET-2083-DEMO-001',
    original_invoice_id: purchaseReturnInvoice?.id ?? 'pi-ktm-4',
    original_invoice_number: purchaseReturnInvoice?.invoiceNumber ?? 'PI-KTM-202607190004',
    supplier_id: 'V-KTM-1', supplier_name: 'Kathmandu Vendor 1',
    branch_id: 'BR-KTM', branch_name: 'Kathmandu (Head Office)',
    return_date_ad: '2026-09-20', return_date_bs: bsOn('2026-09-20'),
    reason: 'DEFECTIVE', items: JSON.stringify(poItem(1)), taxable_amount: 50, vat_amount: 0, non_taxable_amount: 0, grand_total: 50,
    status: 'DRAFT', notes: 'Demo defective router return awaiting approval.', fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
  }];

  const salesReturnInvoice = dataset.salesInvoices.find((invoice: any) => invoice.branchId === 'BR-KTM' && invoice.customerId);
  const salesReturns: Row[] = [{
    id: 'demo-sales-return-1', return_number: 'SRET-2083-DEMO-001',
    original_invoice_id: salesReturnInvoice?.id ?? 'si-ktm-1',
    original_invoice_number: salesReturnInvoice?.invoiceNumber ?? 'INV-KTM-202509050001',
    customer_id: salesReturnInvoice?.customerId ?? 'CUS-KTM-01', customer_name: salesReturnInvoice?.customerName ?? 'Kathmandu Customer 01',
    branch_id: 'BR-KTM', branch_name: 'Kathmandu (Head Office)',
    return_date_ad: '2026-10-01', return_date_bs: bsOn('2026-10-01'),
    reason: 'DEFECTIVE', items: JSON.stringify(poItem(1)), taxable_amount: 90, vat_amount: 0, non_taxable_amount: 0, grand_total: 90,
    restockable: true, status: 'DRAFT', notes: 'Demo customer return awaiting inspection.', fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
  }];

  const shipmentItem = (quantity: number) => [{
    productId: poProduct?.id ?? 'prd-rtr-100',
    productName: poProduct?.name ?? 'WiFi Router N300',
    sku: poProduct?.sku ?? 'RTR-100',
    quantity,
    unitCost: poProduct?.costPrice ?? 50,
  }];
  const shipments: Row[] = [
    {
      id: 'demo-shipment-1', tracking_code: 'SHP-2083-DEMO-001',
      source_branch_id: 'BR-KTM', source_branch_name: 'Kathmandu (Head Office)',
      destination_branch_id: 'BR-PKR', destination_branch_name: 'Pokhara Branch',
      dispatch_date_ad: '2026-11-10', dispatch_date_bs: bsOn('2026-11-10'),
      received_date_ad: null, received_date_bs: null, status: 'IN_TRANSIT',
      items: JSON.stringify(shipmentItem(2)), notes: 'Demo inter-branch router replenishment.',
      fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-shipment-2', tracking_code: 'SHP-2083-DEMO-002',
      source_branch_id: 'BR-BTL', source_branch_name: 'Butwal Branch',
      destination_branch_id: 'BR-DHN', destination_branch_name: 'Dharan Branch',
      dispatch_date_ad: '2026-10-20', dispatch_date_bs: bsOn('2026-10-20'),
      received_date_ad: '2026-10-22', received_date_bs: bsOn('2026-10-22'), status: 'RECEIVED',
      items: JSON.stringify(shipmentItem(3)), notes: 'Demo completed inter-branch transfer.',
      fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
    },
  ];

  return { customerDevices, warranties, damage, stockOperations, purchaseOrders: poRows, purchaseReturns, salesReturns, shipments };
}

export async function applyDemoOperationsFixtures(client: any, dataset: VerificationDataset): Promise<Record<string, number>> {
  const fixtures = buildDemoOperationsFixtures(dataset);
  const summary: Record<string, number> = {};
  const put = async (key: string, table: string, columns: string[], rows: Row[]) => {
    summary[key] = rows.length;
    await insertRows(client, table, columns, rows);
  };

  await put('demoCustomerDevices', 'customer_device_records',
    ['id', 'customer_id', 'customer_name', 'customer_code', 'branch_id', 'product_name', 'device_serial', 'pon_serial', 'mac_address', 'issued_date_ad', 'issued_date_bs', 'fiscal_year_id', 'purchase_bill_ref', 'installation_address', 'status', 'notes', 'is_demo', 'created_by'], fixtures.customerDevices);
  await put('demoWarranties', 'warranty_coverages',
    ['id', 'coverage_type', 'item_category', 'asset_id', 'product_id', 'device_record_id', 'product_name', 'serial_number', 'branch_id', 'party_name', 'start_date_ad', 'start_date_bs', 'end_date_ad', 'end_date_bs', 'start_basis', 'term_months', 'source_type', 'source_id', 'source_number', 'is_current', 'is_demo', 'created_by'], fixtures.warranties);
  await put('demoDamageRecords', 'damage_records',
    ['id', 'damage_reference', 'product_id', 'branch_id', 'quantity_damaged', 'unit_cost', 'total_cost', 'damage_date_ad', 'damage_date_bs', 'damage_reason', 'status', 'gl_account_code', 'write_off_loss', 'disposal_method', 'disposal_date_ad', 'disposal_date_bs', 'approved_by', 'notes', 'fiscal_year_id', 'is_demo', 'created_by'], fixtures.damage);
  await put('demoStockOperations', 'stock_operations',
    ['id', 'reference_number', 'type', 'technician_name', 'work_order_ref', 'branch_id', 'branch_name', 'destination_warehouse_id', 'destination_warehouse_name', 'product_id', 'quantity_changed', 'cost_per_unit', 'total_value', 'reason', 'date_ad', 'date_bs', 'fiscal_year', 'fiscal_year_id', 'status', 'items', 'is_demo', 'created_by'], fixtures.stockOperations);
  await put('demoPurchaseOrders', 'purchase_orders',
    ['id', 'po_number', 'supplier_id', 'supplier_name', 'branch_id', 'order_date_ad', 'order_date_bs', 'expected_delivery_date_ad', 'expected_delivery_date_bs', 'status', 'items', 'subtotal_amount', 'tax_amount', 'total_amount', 'notes', 'fiscal_year_id', 'is_demo', 'created_by'], fixtures.purchaseOrders);
  await put('demoPurchaseReturns', 'purchase_returns',
    ['id', 'return_number', 'original_invoice_id', 'original_invoice_number', 'supplier_id', 'supplier_name', 'branch_id', 'return_date_ad', 'return_date_bs', 'reason', 'items', 'taxable_amount', 'vat_amount', 'non_taxable_amount', 'grand_total', 'status', 'notes', 'fiscal_year_id', 'is_demo', 'created_by'], fixtures.purchaseReturns);
  await put('demoSalesReturns', 'sales_returns',
    ['id', 'return_number', 'original_invoice_id', 'original_invoice_number', 'customer_id', 'customer_name', 'branch_id', 'return_date_ad', 'return_date_bs', 'reason', 'items', 'taxable_amount', 'vat_amount', 'non_taxable_amount', 'grand_total', 'restockable', 'status', 'notes', 'fiscal_year_id', 'is_demo', 'created_by'], fixtures.salesReturns);
  await put('demoShipments', 'shipments',
    ['id', 'tracking_code', 'source_branch_id', 'source_branch_name', 'destination_branch_id', 'destination_branch_name', 'dispatch_date_ad', 'dispatch_date_bs', 'received_date_ad', 'received_date_bs', 'status', 'items', 'notes', 'fiscal_year_id', 'is_demo', 'created_by'], fixtures.shipments);

  return summary;
}
