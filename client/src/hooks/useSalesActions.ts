/**
 * sales mutations, lifted out of App.tsx.
 *
 * Each wrapper is the same call the root made inline: hit the API, then
 * refresh the shell. They live in a hook so the render code only wires
 * the returned handlers to screens.
 */
import { api } from '../services/api';
import type { CustomerPayment, SalesInvoice } from '../types';
import type { ActionDeps } from './actionDeps';

export function useSalesActions({ refreshAllData, currentUser, financialSummary }: ActionDeps) {
  const handleCreateSalesInvoice = async (
    inv: Omit<SalesInvoice, 'id' | 'invoiceNumber'>
  ) => {
    await api.createSalesInvoice(inv);
    refreshAllData();
  };

  const handleRecordCustomerPayment = async (
    invoice: SalesInvoice,
    amount: number,
    paymentMethod: string,
    settlementAccountId?: string,
    wallet?: { providerCode: string; providerTransactionId: string; feeAmount: number }
  ) => {
    await api.createCustomerPayment({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      branchId: invoice.branchId,
      amount,
      paymentMethod: paymentMethod as CustomerPayment['paymentMethod'],
      settlementAccountId,
      providerCode: wallet?.providerCode as CustomerPayment['providerCode'],
      providerTransactionId: wallet?.providerTransactionId,
      grossAmount: wallet ? amount : undefined,
      feeAmount: wallet?.feeAmount,
      netAmount: wallet ? amount - wallet.feeAmount : undefined,
      paymentDateAD: new Date().toISOString().split('T')[0],
    });
    refreshAllData();
  };

  const handleCancelSalesInvoice = async (id: string, reason?: string) => {
    await api.cancelSalesInvoice(id, reason);
    refreshAllData();
  };

  const handleCreateSalesReturn = async (payload: any) => {
    const created = await api.createSalesReturn(payload);
    refreshAllData();
    return created;
  };

  const handleCancelSalesReturn = async (id: string, reason: string) => {
    await api.cancelSalesReturn(id, reason);
    refreshAllData();
  };

  const handleApproveSalesReturn = async (id: string) => {
    await api.postSalesReturn(id);
    refreshAllData();
  };


  return {
    handleCreateSalesInvoice,
    handleRecordCustomerPayment,
    handleCancelSalesInvoice,
    handleCreateSalesReturn,
    handleCancelSalesReturn,
    handleApproveSalesReturn,
  };
}
