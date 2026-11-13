/**
 * Inventory value-movement source registry (ACC-4).
 *
 * Every journal that changes inventory value must declare which document and
 * posting service produced it, how it is reversed, and which dimensions it
 * carries. The registry is the guard the worklist asks for: a new stock
 * mutation that posts a journal under an undeclared source type is refused at
 * the posting boundary, and `tests/inventoryCoverage.api.test.ts` scans the
 * inventory posting services for any source type missing from this table.
 *
 * The matrix deliberately separates the document reversal (void/cancel) from a
 * contra journal. Both leave the original journal intact.
 */

export type InventoryReversalMode = 'CONTRA' | 'DOCUMENT' | 'LIFECYCLE';

export interface InventoryPostingDefinition {
  sourceType: string;
  operation: string;
  postingService: string;
  reversalMode: InventoryReversalMode;
  reversalSourceType: string | null;
  branchDimension: 'DOCUMENT' | 'BRANCH';
  party: 'CUSTOMER' | 'SUPPLIER' | 'BRANCH' | 'EMPLOYEE' | 'NONE';
  costCentre: 'OPTIONAL' | 'NONE';
  financialEffect: string;
  /** Enforce one posted journal per (source_type, source_id) at postJournal. */
  idempotent?: boolean;
}

export const INVENTORY_SOURCE_REGISTRY: readonly InventoryPostingDefinition[] = [
  {
    sourceType: 'PURCHASE_INVOICE',
    operation: 'Purchase invoice',
    postingService: 'invoicePosting',
    reversalMode: 'DOCUMENT',
    reversalSourceType: 'PURCHASE_INVOICE_CANCELLED',
    branchDimension: 'DOCUMENT',
    party: 'SUPPLIER',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Inventory + VAT Input / Cr AP',
  },
  {
    sourceType: 'PURCHASE_RETURN',
    operation: 'Purchase return',
    postingService: 'returnPosting',
    reversalMode: 'DOCUMENT',
    reversalSourceType: 'PURCHASE_RETURN_CANCELLED',
    branchDimension: 'DOCUMENT',
    party: 'SUPPLIER',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr AP / Cr Inventory + VAT Input',
  },
  {
    sourceType: 'SALES_INVOICE',
    operation: 'Sales invoice',
    postingService: 'invoicePosting',
    reversalMode: 'DOCUMENT',
    reversalSourceType: 'SALES_INVOICE_CANCELLED',
    branchDimension: 'DOCUMENT',
    party: 'CUSTOMER',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr AR + COGS / Cr Revenue + VAT Output + Inventory',
  },
  {
    sourceType: 'SALES_RETURN',
    operation: 'Sales return',
    postingService: 'returnPosting',
    reversalMode: 'DOCUMENT',
    reversalSourceType: 'SALES_RETURN_CANCELLED',
    branchDimension: 'DOCUMENT',
    party: 'CUSTOMER',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Revenue + VAT Output + Inventory / Cr AR + COGS',
  },
  {
    sourceType: 'STOCK_OPERATION',
    operation: 'Stock operation, damage, pullout or consumable issue',
    postingService: 'stockPosting',
    reversalMode: 'CONTRA',
    reversalSourceType: 'STOCK_OPERATION_REVERSAL',
    branchDimension: 'DOCUMENT',
    party: 'NONE',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Stock Expense / Cr Inventory (or reverse)',
    idempotent: true,
  },
  {
    sourceType: 'STOCK_OPERATION_RECEIPT',
    operation: 'Pullout receipt at the destination warehouse',
    postingService: 'stockPosting',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: null,
    branchDimension: 'DOCUMENT',
    party: 'NONE',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Inventory — destination / Cr Stock Expense (value received, not earned)',
    idempotent: true,
  },
  {
    sourceType: 'STOCK_ADJUSTMENT',
    operation: 'Direct stock-level correction',
    postingService: 'stockPosting',
    reversalMode: 'CONTRA',
    reversalSourceType: 'STOCK_ADJUSTMENT_REVERSAL',
    branchDimension: 'DOCUMENT',
    party: 'NONE',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Stock Expense / Cr Inventory (or reverse)',
    idempotent: true,
  },
  {
    sourceType: 'STOCK_AUDIT',
    operation: 'Physical stock audit',
    postingService: 'stockPosting',
    reversalMode: 'CONTRA',
    reversalSourceType: 'STOCK_AUDIT_REVERSAL',
    branchDimension: 'DOCUMENT',
    party: 'NONE',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Stock Expense / Cr Inventory (or reverse)',
    idempotent: true,
  },
  {
    sourceType: 'DAMAGE',
    operation: 'Damage write-off',
    postingService: 'damagePosting',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: 'DAMAGE_REVERSED',
    branchDimension: 'DOCUMENT',
    party: 'NONE',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Stock Expense / Cr Inventory',
    idempotent: true,
  },
  {
    sourceType: 'TRANSFER_OUT',
    operation: 'Inter-branch transfer dispatch',
    postingService: 'transferPosting',
    reversalMode: 'CONTRA',
    reversalSourceType: 'TRANSFER_OUT_REVERSAL',
    branchDimension: 'BRANCH',
    party: 'BRANCH',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Due from Head Office / Cr Inventory — source branch',
  },
  {
    sourceType: 'TRANSFER_IN',
    operation: 'Inter-branch transfer receipt',
    postingService: 'transferPosting',
    reversalMode: 'CONTRA',
    reversalSourceType: 'TRANSFER_IN_REVERSAL',
    branchDimension: 'BRANCH',
    party: 'BRANCH',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Inventory — destination branch / Cr Due to Head Office',
  },
  {
    sourceType: 'CPE_ASSET',
    operation: 'CPE deployment, exchange or return',
    postingService: 'cpePosting',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: null,
    branchDimension: 'DOCUMENT',
    party: 'CUSTOMER',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr CPE Asset / Cr Inventory; reverse on return',
  },
  {
    sourceType: 'CPE_DEVICE',
    operation: 'Customer device lifecycle',
    postingService: 'cpePosting',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: null,
    branchDimension: 'DOCUMENT',
    party: 'CUSTOMER',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr CPE Asset / Cr Inventory; reverse on return',
  },
  {
    sourceType: 'CPE_EXCHANGE',
    operation: 'Customer CPE exchange',
    postingService: 'cpePosting',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: null,
    branchDimension: 'DOCUMENT',
    party: 'CUSTOMER',
    costCentre: 'OPTIONAL',
    financialEffect: 'Return the old CPE to inventory and issue the replacement at its cost',
  },
  {
    sourceType: 'FIXED_ASSET_ACQUISITION',
    operation: 'Fixed asset acquisition',
    postingService: 'cpePosting',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: 'FIXED_ASSET_DISPOSAL',
    branchDimension: 'DOCUMENT',
    party: 'NONE',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Fixed Asset / Cr Inventory or AP',
  },
  {
    sourceType: 'FIXED_ASSET_DEPRECIATION',
    operation: 'Fixed asset depreciation',
    postingService: 'cpePosting',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: null,
    branchDimension: 'BRANCH',
    party: 'NONE',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr Depreciation Expense / Cr Accumulated Depreciation',
  },
  {
    sourceType: 'FIXED_ASSET_DISPOSAL',
    operation: 'Fixed asset disposal',
    postingService: 'cpePosting',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: null,
    branchDimension: 'DOCUMENT',
    party: 'NONE',
    costCentre: 'OPTIONAL',
    financialEffect: 'Remove asset cost and accumulated depreciation; gain/loss to disposal',
  },
  {
    sourceType: 'WARRANTY_RECOVERY',
    operation: 'Warranty vendor credit',
    postingService: 'warrantyClaim',
    reversalMode: 'LIFECYCLE',
    reversalSourceType: null,
    branchDimension: 'DOCUMENT',
    party: 'SUPPLIER',
    costCentre: 'OPTIONAL',
    financialEffect: 'Dr AP / Cr Stock Expense or warranty recovery',
  },
] as const;

const BY_SOURCE = new Map(
  INVENTORY_SOURCE_REGISTRY.map((definition) => [definition.sourceType, definition])
);
const REVERSAL_SOURCES = new Set(
  INVENTORY_SOURCE_REGISTRY
    .map((definition) => definition.reversalSourceType)
    .filter((sourceType): sourceType is string => Boolean(sourceType))
);

/** The registry entry for a source type, or undefined when it is not an
 * inventory value movement. */
export function inventoryPostingDefinition(
  sourceType: string | null | undefined
): InventoryPostingDefinition | undefined {
  return BY_SOURCE.get(String(sourceType || '').trim().toUpperCase());
}

/** True for an original or reversal source that changes inventory value. */
export function isInventorySourceType(sourceType: string | null | undefined): boolean {
  const normalized = String(sourceType || '').trim().toUpperCase();
  return BY_SOURCE.has(normalized) || REVERSAL_SOURCES.has(normalized);
}

/**
 * Posting-boundary guard. A stock journal cannot be written under an
 * unregistered source type; the error names the matrix the developer must
 * update instead of silently posting an undeclared financial effect.
 */
export function assertInventoryPostingRegistered(sourceType: string): InventoryPostingDefinition {
  const definition = inventoryPostingDefinition(sourceType);
  if (!definition) {
    throw new Error(
      `Inventory source type ${sourceType || '(blank)'} has no declared financial effect. ` +
        'Add it to server/src/services/inventoryPostingRegistry.ts and cover it in tests/inventoryCoverage.api.test.ts.'
    );
  }
  return definition;
}

/** Every source type the registry declares an inventory effect for. */
export function inventorySourceTypes(): string[] {
  return INVENTORY_SOURCE_REGISTRY.map((definition) => definition.sourceType);
}
