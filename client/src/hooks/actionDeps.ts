/**
 * What a domain action hook needs from the shell.
 *
 * The wrappers used to close over App.tsx directly; this is the seam that
 * replaces that closure. It deliberately stays small: the API surface is
 * imported by the hooks themselves, so only the shell-owned refresh and the
 * identity/summary values a few wrappers stamp onto requests come through.
 */
import type { FinancialSummary, PurchaseInvoice, User } from '../types';

export interface ActionDeps {
  /** Re-read the shell state the mutation changed. */
  refreshAllData: () => void | Promise<void>;
  /** Acting identity for the audit fields the server stamps. */
  currentUser: User | null;
  /** Fiscal year fallback for stock operations created from assets. */
  financialSummary: FinancialSummary | null;
}

/** Procurement additionally needs the loaded invoices a payment settles. */
export interface ProcurementActionDeps extends ActionDeps {
  purchaseInvoices: PurchaseInvoice[];
}
