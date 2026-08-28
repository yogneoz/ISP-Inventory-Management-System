import { DocumentNumberConfig } from '../types';
import { api } from '../services/api';

const STORAGE_KEY = 'izone_document_number_configs';

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

export function formatDocumentNumber(config: DocumentNumberConfig, seqNum?: number): string {
  const numToFormat = seqNum !== undefined ? seqNum : config.nextNumber;
  const paddedNum = String(numToFormat).padStart(config.minDigits || 4, '0');
  return `${config.prefix || ''}${paddedNum}${config.suffix || ''}`;
}

export function generateNextDocumentNumber(docTypeId: string, autoIncrement = false): string {
  const configs = getDocumentNumberConfigs();
  const index = configs.findIndex((c) => c.id === docTypeId);
  if (index === -1) {
    // Fallback if unrecognized type
    const fallbackSeq = Math.floor(1000 + Math.random() * 9000);
    return `${docTypeId}-2081-${fallbackSeq}`;
  }

  const config = configs[index];
  const docNumber = formatDocumentNumber(config);

  if (autoIncrement) {
    configs[index].nextNumber = config.nextNumber + 1;
    saveDocumentNumberConfigs(configs);

    // Call API generate-next asynchronously to ensure server state is also updated
    api.generateNextDocumentNumber(docTypeId, true).catch((_e) => {});
  }

  return docNumber;
}

export function resetDocumentSequence(docTypeId: string, newStartNumber?: number): void {
  const configs = getDocumentNumberConfigs();
  const index = configs.findIndex((c) => c.id === docTypeId);
  if (index !== -1) {
    const startNum = newStartNumber !== undefined ? newStartNumber : configs[index].startingNumber;
    configs[index].nextNumber = startNum;
    saveDocumentNumberConfigs(configs);

    api.resetDocumentSequence(docTypeId, startNum).catch((_e) => {});
  }
}
