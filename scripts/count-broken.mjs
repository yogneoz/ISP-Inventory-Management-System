#!/usr/bin/env node
/**
 * Precisely count broken flattened ternaries per file.
 * A line is "broken" if it's a className template literal with a literal
 * ` ? ` / ` : ` pattern but NO `${}` interpolation — meaning the ternary
 * was flattened into dead text.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');

const files = [
  'src/features/dashboard/Dashboard.tsx',
  'src/components/layout/Sidebar.tsx',
  'src/components/layout/Header.tsx',
  'src/features/finance/AuditTrailReports.tsx',
  'src/features/finance/DepreciationRegister.tsx',
  'src/features/finance/FiscalYearManagement.tsx',
  'src/features/finance/FiscalYearClosingWizard.tsx',
  'src/features/finance/NepaliFiscalManagement.tsx',
  'src/features/finance/OpeningStockManager.tsx',
  'src/features/finance/VatRegister.tsx',
  'src/features/finance/BsCalendarUtility.tsx',
  'src/features/inventory/PhysicalStockAudit.tsx',
  'src/features/inventory/StockOperations.tsx',
  'src/features/inventory/ProductManagement.tsx',
  'src/features/inventory/ProductSearchBar.tsx',
  'src/features/inventory/BranchStockTracking.tsx',
  'src/features/inventory/DamagedStockTracking.tsx',
  'src/features/inventory/ExportStock.tsx',
  'src/features/inventory/ReorderStockTracking.tsx',
  'src/features/inventory/StockMovementLedger.tsx',
  'src/features/inventory/StockValuation.tsx',
  'src/features/inventory/ImportStock.tsx',
  'src/features/procurement/PurchaseOrders.tsx',
  'src/features/procurement/PurchaseInvoices.tsx',
  'src/features/procurement/ReceiveInboundWarehouse.tsx',
  'src/features/procurement/Shipments.tsx',
  'src/features/sales/CustomerMasterDirectory.tsx',
  'src/features/sales/ImportCustomers.tsx',
  'src/features/sales/CustomersManagement.tsx',
  'src/features/settings/ApprovalWorkflowCenter.tsx',
  'src/features/settings/CompanySetupManagement.tsx',
  'src/features/settings/DataRecalculationMaintenance.tsx',
  'src/components/common/HelpDocumentation.tsx',
];

let totalBroken = 0;
let totalFiles = 0;

for (const f of files) {
  const content = readFileSync(join(ROOT, f), 'utf-8');
  const lines = content.split('\n');
  let broken = 0;
  const brokenLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Must be a className template literal (has both ` and className or return)
    const isClassNameLine = line.includes('className') || line.includes('`border-') || line.includes('`bg-');
    if (!isClassNameLine) continue;
    if (!line.includes('`')) continue;

    // Skip if line has ${ — it's a real interpolation
    if (line.includes('${')) continue;

    // Skip if line is a simple variable-only ternary like `... ${var ? ... : ...}`
    // (these were correctly converted already)

    // Check for the literal " ? " pattern that indicates a flattened ternary
    // This catches: 'specialCategoryTab === 'ALL ? bg-indigo-600...
    // Also catches: isExpanded ? bg-rose-50/50...
    // Also catches: editingProduct ? border-slate-200...
    if (/\s\?\s/.test(line) && /\s:\s/.test(line)) {
      broken++;
      brokenLines.push({ lineNo: i + 1, content: line.trim().slice(0, 250) });
    }
  }

  if (broken > 0) {
    totalFiles++;
    totalBroken += broken;
    console.log(`\n${f}: ${broken} broken lines`);
    for (const bl of brokenLines.slice(0, 5)) {
      console.log(`  L${bl.lineNo}: ${bl.content}`);
    }
    if (brokenLines.length > 5) {
      console.log(`  ... and ${brokenLines.length - 5} more`);
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Total broken lines: ${totalBroken} across ${totalFiles} files`);
