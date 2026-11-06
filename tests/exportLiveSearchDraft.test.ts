/**
 * CSV exports must use FilterCard's live search draft.
 *
 * FilterCard owns the keystroke buffer and only calls `onSearchApply` after the
 * debounce (or Enter/Clear). An export handler that reads the applied value
 * alone therefore writes a file for the PREVIOUS search when the operator types
 * and clicks Export before the pause elapses — the defect fixed in ExportStock
 * and CustomersManagement, then in every other register.
 *
 * PROVES:
 *   1. Each register wires `onSearchDraftChange` and its export path reads
 *      `searchDraftRef.current` (a server query override, or a re-run of the
 *      client-side filter with the draft).
 *   2. Every feature screen that renders FilterCard AND exports a CSV is either
 *      in the table or explicitly exempted, so a new register cannot silently
 *      ship the old applied-only export.
 *
 * Source pins only: no DB, no browser. The FilterCard API itself is covered
 * behaviourally by tests/filterCardDebounce.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FEATURES = path.resolve('client/src/features');
const CARD_WIRING = 'onSearchDraftChange={(draft) => { searchDraftRef.current = draft; }}';

interface ExportCase {
  file: string;
  /** The snippet that proves the export (not just the card) consumed the draft. */
  uses: string[];
}

/**
 * Server-paged registers override the request query; client-filtered registers
 * re-run their predicate with the draft at export time.
 */
const EXPORTS: ExportCase[] = [
  {
    file: 'procurement/PurchaseOrders.tsx',
    uses: ['query: (searchDraftRef.current ?? searchQuery).trim() || undefined,'],
  },
  {
    file: 'procurement/PurchaseInvoices.tsx',
    uses: ['query: (searchDraftRef.current ?? searchQuery).trim() || undefined,'],
  },
  {
    file: 'sales/SalesInvoices.tsx',
    uses: ['query: (searchDraftRef.current ?? query).trim() || undefined,'],
  },
  {
    file: 'sales/CustomerMasterDirectory.tsx',
    uses: ['query: (searchDraftRef.current ?? searchQuery).trim() || undefined,'],
  },
  {
    file: 'procurement/ShipmentRegister.tsx',
    uses: ['search: (searchDraftRef.current ?? searchQuery) || undefined,'],
  },
  {
    file: 'inventory/warranty/WarrantyRegister.tsx',
    uses: ['query: (searchDraftRef.current ?? searchQuery) || undefined,'],
  },
  {
    file: 'inventory/stockops/ConsumablesRegisterPanel.tsx',
    uses: ['query: (searchDraftRef.current ?? consumableRegisterQuery).trim() || undefined,'],
  },
  {
    file: 'inventory/AssetDeployments.tsx',
    uses: ['query: (searchDraftRef.current ?? appliedSearch) || undefined,'],
  },
  {
    file: 'inventory/SerialLogRegister.tsx',
    uses: ['query: searchDraftRef.current ?? appliedSearch,'],
  },
  {
    file: 'finance/DepreciationRegister.tsx',
    uses: ['query: (searchDraftRef.current ?? searchQuery) || undefined,'],
  },
  {
    file: 'inventory/StockMovementLedger.tsx',
    uses: [
      'filterProductLedger(searchDraftRef.current ?? searchQuery)',
      'filterLogs(searchDraftRef.current ?? searchQuery)',
    ],
  },
  {
    file: 'inventory/StockValuation.tsx',
    uses: ['filterItemized(searchDraftRef.current ?? searchQuery)'],
  },
  {
    file: 'finance/VatRegister.tsx',
    uses: ['filterInvoices(searchDraftRef.current ?? searchQuery)'],
  },
  {
    file: 'finance/VendorOpeningBalances.tsx',
    uses: ['filterVendorRows(searchDraftRef.current ?? vendorSearch)'],
  },
  {
    file: 'inventory/ReorderStockTracking.tsx',
    uses: ['filterVisibleProducts(searchDraftRef.current ?? localSearch)'],
  },
  {
    file: 'inventory/DamagedStockTracking.tsx',
    uses: ['displayProductsFor(searchDraftRef.current ?? localSearch)'],
  },
];

/**
 * Screens that render FilterCard and export a CSV but deliberately do NOT
 * export the search-filtered table. Each needs a reason here so the exemption
 * is a decision, not an oversight.
 */
const EXEMPT = new Map<string, string>([
  [
    'inventory/PhysicalStockAudit.tsx',
    'exports the complete physical count sheet and company matrix; its search narrows only the on-screen table, never those exports',
  ],
]);

const readFeature = (rel: string) => fs.readFileSync(path.join(FEATURES, rel), 'utf8');

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

const relativeFeature = (abs: string) => path.relative(FEATURES, abs).split(path.sep).join('/');

describe("CSV exports read FilterCard's live search draft", () => {
  test('every FilterCard register export consumes the draft', () => {
    const problems: string[] = [];
    for (const entry of EXPORTS) {
      const src = readFeature(entry.file);
      if (!src.includes('<FilterCard')) {
        problems.push(`${entry.file}: no longer renders <FilterCard>`);
      }
      if (!src.includes(CARD_WIRING)) {
        problems.push(`${entry.file}: FilterCard does not report its draft (onSearchDraftChange missing)`);
      }
      for (const use of entry.uses) {
        if (!src.includes(use)) {
          problems.push(`${entry.file}: export reads only the applied search — missing "${use}"`);
        }
      }
    }
    assert.deepEqual(problems, [], `register exports still bound to the applied search:\n${problems.join('\n')}`);
  });

  test('every feature screen that renders FilterCard and exports CSV is accounted for', () => {
    const covered = new Set(EXPORTS.map((entry) => entry.file));
    const uncovered: string[] = [];
    for (const abs of tsxFiles(FEATURES)) {
      const rel = relativeFeature(abs);
      const src = fs.readFileSync(abs, 'utf8');
      if (!src.includes('<FilterCard') || !src.includes('exportToCSV')) continue;
      if (covered.has(rel) || EXEMPT.has(rel)) continue;
      uncovered.push(rel);
    }
    assert.deepEqual(
      uncovered,
      [],
      `add the screen to EXPORTS (wire onSearchDraftChange and read the draft in its export) or document an exemption:\n${uncovered.join('\n')}`
    );

    for (const entry of EXPORTS) {
      const src = readFeature(entry.file);
      assert.ok(
        src.includes('<FilterCard') && src.includes('exportToCSV'),
        `${entry.file} no longer matches this guard's scope — remove it from EXPORTS`
      );
    }
    for (const [rel, reason] of EXEMPT) {
      const src = readFeature(rel);
      assert.ok(
        src.includes('<FilterCard') && src.includes('exportToCSV'),
        `${rel} exemption is stale (${reason})`
      );
      assert.ok(
        !src.includes(CARD_WIRING),
        `${rel} now reports the draft — move it into EXPORTS with the export line that consumes it`
      );
    }
  });
});
