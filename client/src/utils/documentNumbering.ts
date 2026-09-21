import { DocumentNumberConfig } from '../types';
import { api } from '../services/api';

const STORAGE_KEY = 'inventory_document_number_configs';

export const DEFAULT_DOCUMENT_CONFIGS: DocumentNumberConfig[] = [
  // Procurement & Purchasing
  {
    id: 'PO',
    documentType: 'Purchase Order',
    prefix: 'PO-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1001,
    nextNumber: 1001,
    resetEveryFiscalYear: true,
    notes: 'Used for vendor purchase requisitions and official purchase orders.',
  },
  {
    id: 'PI',
    documentType: 'Purchase Invoice / Bill',
    prefix: 'PI-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 5001,
    nextNumber: 5001,
    resetEveryFiscalYear: true,
    notes: 'Used for supplier purchase invoices and tax bills.',
  },
  {
    id: 'GRN',
    documentType: 'Goods Receipt Note (GRN)',
    prefix: 'GRN-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used when warehouse receives inbound stock shipments.',
  },
  {
    id: 'DN',
    documentType: 'Purchase Return & Debit Note',
    prefix: 'DN-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for returning defective goods to vendors and supplier debit notes.',
  },

  // Sales & Distribution
  {
    id: 'INV',
    documentType: 'Sales & POS Invoice',
    prefix: 'INV-2081-',
    suffix: '',
    minDigits: 5,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for POS sales bills and customer sales tax invoices.',
  },
  {
    id: 'QUO',
    documentType: 'Sales Quotation & Proforma Invoice',
    prefix: 'QUO-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for issuing formal price quotes and proforma invoices to clients.',
  },
  {
    id: 'CN',
    documentType: 'Sales Return & Credit Note',
    prefix: 'CN-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for customer product returns and VAT credit note adjustments.',
  },

  // Branch Operations & Inventory Transfers
  {
    id: 'ST',
    documentType: 'Inter-Branch Stock Transfer',
    prefix: 'ST-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 101,
    nextNumber: 101,
    resetEveryFiscalYear: true,
    notes: 'Used for branch-to-branch stock transfers and dispatches.',
  },
  {
    id: 'SA',
    documentType: 'Stock Adjustment & Audit',
    prefix: 'SA-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used during physical stock audits and inventory reconciliations.',
  },
  {
    id: 'DC',
    documentType: 'Damage & Pullout Claim',
    prefix: 'DC-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for damaged stock write-offs and pullout dispatches.',
  },
  {
    id: 'CPI',
    documentType: 'Consumable Product Issue',
    prefix: 'CPI-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for internal material consumption, office supplies, and store use requisitions.',
  },
  {
    id: 'EXC',
    documentType: 'Device Exchange & Replacement',
    prefix: 'EXC-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for customer device trade-ins, replacement swaps, and exchange vouchers.',
  },
  {
    id: 'WC',
    documentType: 'Warranty Service & Repair Slip',
    prefix: 'WC-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for customer repair jobs, device service intake, and warranty claims.',
  },

  // Fixed Asset Management
  {
    id: 'FAA',
    documentType: 'Fixed Asset Assignment & Transfer',
    prefix: 'FAA-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1,
    nextNumber: 1,
    resetEveryFiscalYear: true,
    notes: 'Used for assigning company assets to staff, custody handovers, and department transfers.',
  },
  {
    id: 'FAR',
    documentType: 'Fixed Asset Capitalization & Register',
    prefix: 'FAR-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 101,
    nextNumber: 101,
    resetEveryFiscalYear: true,
    notes: 'Used for logging newly capitalized fixed assets into company asset register.',
  },

  // Finance, Accounting & Vouchers
  {
    id: 'JV',
    documentType: 'Journal Voucher',
    prefix: 'JV-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1001,
    nextNumber: 1001,
    resetEveryFiscalYear: true,
    notes: 'Used for manual general ledger transactions and depreciation entries.',
  },
  {
    id: 'PV',
    documentType: 'Payment Disbursement Voucher',
    prefix: 'PV-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1001,
    nextNumber: 1001,
    resetEveryFiscalYear: true,
    notes: 'Used for supplier bill payments, operational expenses, and bank disbursements.',
  },
  {
    id: 'RV',
    documentType: 'Cash & Bank Receipt Voucher',
    prefix: 'RV-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1001,
    nextNumber: 1001,
    resetEveryFiscalYear: true,
    notes: 'Used for customer payments, advance collections, and bank deposits.',
  },

  // Cash & Bank Payment / Receipt Document Numbering
  {
    id: 'CP',
    documentType: 'Cash Payment',
    prefix: 'CP-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1001,
    nextNumber: 1002,
    resetEveryFiscalYear: true,
    notes: 'Used for cash payment disbursements to suppliers and vendors. (Starts after demo CP-2081-1001.)',
  },
  {
    id: 'CR',
    documentType: 'Cash Receive',
    prefix: 'CR-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1001,
    nextNumber: 1001,
    resetEveryFiscalYear: true,
    notes: 'Used for cash receipts received from customers.',
  },
  {
    id: 'BP',
    documentType: 'Bank Payment',
    prefix: 'BP-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1001,
    nextNumber: 1003,
    resetEveryFiscalYear: true,
    notes: 'Used for bank transfer and cheque payment disbursements to suppliers. (Starts after demo BP-2081-1001/1002.)',
  },
  {
    id: 'BR',
    documentType: 'Bank Receive',
    prefix: 'BR-2081-',
    suffix: '',
    minDigits: 4,
    startingNumber: 1001,
    nextNumber: 1001,
    resetEveryFiscalYear: true,
    notes: 'Used for bank transfer and cheque receipts received from customers.',
  },
];

export function getDocumentNumberConfigs(): DocumentNumberConfig[] {
  if (typeof window === 'undefined') return DEFAULT_DOCUMENT_CONFIGS;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Merge with defaults in case new types exist or order changes
        const configMap = new Map<string, DocumentNumberConfig>();
        parsed.forEach((item: DocumentNumberConfig) => {
          if (item && item.id) configMap.set(item.id, item);
        });

        return DEFAULT_DOCUMENT_CONFIGS.map((def) => {
          const found = configMap.get(def.id);
          return found ? { ...def, ...found } : def;
        });
      }
    }
  } catch (_e) {}
  return DEFAULT_DOCUMENT_CONFIGS;
}

export function saveDocumentNumberConfigs(configs: DocumentNumberConfig[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  } catch (e) {
    console.error('Failed to save document numbering config', e);
  }

  // Asynchronously sync to PostgreSQL database
  api.updateDocumentNumberConfigs(configs).catch((err) => {
    console.warn('Background sync document numbering config to DB failed:', err?.message || err);
  });
}

/**
 * Extracts the editable DOCTYPE prefix from a config prefix value.
 *
 * The server emits document numbers as
 *   {PREFIX}-{BRANCH_CODE}-{YYYYMMDD}{NNNN}
 * (e.g. PO-BRC01-202609150001). Only the leading letters/digits of the saved
 * prefix matter for the issued code — legacy values like "PO-2081-" still
 * resolve to "PO". This helper mirrors the server-side logic in
 * `issueNextDocNumber`.
 */
export function getDocTypePrefix(config: DocumentNumberConfig): string {
  const raw = String(config.prefix || '').trim();
  const match = raw.match(/^[A-Za-z0-9]+/);
  return (match ? match[0] : (config.id || 'DOC')).toUpperCase();
}

/**
 * Formats a DOCUMENT NUMBER SAMPLE for display only.
 *
 * Actual document numbers are issued atomically by the server as
 *   {PREFIX}-{BRANCH_CODE}-{YYYYMMDD}{NNNN}
 * (e.g. PO-BRC01-202609150001). This helper only renders what a number would
 * look like using the configured prefix; it never issues or reserves a number.
 */
export function formatDocumentNumber(config: DocumentNumberConfig, seqNum?: number, branchCode = 'BRC01', dateStr = '20260915'): string {
  const code = getDocTypePrefix(config);
  const numToFormat = seqNum !== undefined ? seqNum : (config.nextNumber || 1);
  const paddedNum = String(numToFormat).padStart(config.minDigits || 4, '0');
  return `${code}-${branchCode}-${dateStr}${paddedNum}`;
}

/**
 * @deprecated The server now issues every document number atomically via
 * `issueNextDocNumber` (per-branch, per-day, DB-backed). This client-side
 * generator is intentionally removed. Keep the signature so any legacy call
 * site still compiles, but it no longer increments or persists anything.
 */
export function generateNextDocumentNumber(docTypeId: string, _autoIncrement = false): string {
  const configs = getDocumentNumberConfigs();
  const config = configs.find((c) => c.id === docTypeId);
  if (!config) {
    // Match the server fallback shape as closely as possible.
    return `${docTypeId}-BRC01-${new Date().toISOString().split('T')[0].replace(/-/g, '')}0001`;
  }
  return formatDocumentNumber(config, config.nextNumber || 1);
}

/**
 * @deprecated The server's daily sequence cannot be reset from the client —
 * only the editable prefix is stored in document_number_configs. This helper
 * is kept only for compile-compatibility with legacy callers.
 */
export function resetDocumentSequence(docTypeId: string, _newStartNumber?: number): void {
  const configs = getDocumentNumberConfigs();
  const index = configs.findIndex((c) => c.id === docTypeId);
  if (index !== -1) {
    saveDocumentNumberConfigs(configs);
  }
}
