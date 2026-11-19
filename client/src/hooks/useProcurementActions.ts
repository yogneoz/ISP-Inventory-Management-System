/**
 * procurement mutations, lifted out of App.tsx.
 *
 * Each wrapper is the same call the root made inline: hit the API, then
 * refresh the shell. They live in a hook so the render code only wires
 * the returned handlers to screens.
 */
import React from 'react';
import { api } from '../services/api';
import type { PurchaseInvoice, PurchaseOrder, Shipment, StockOperation } from '../types';
import type { ProcurementActionDeps } from './actionDeps';

export function useProcurementActions({ refreshAllData, currentUser, financialSummary, purchaseInvoices }: ProcurementActionDeps) {
  const handleCreatePO = async (
    po: Omit<
      PurchaseOrder,
      'id' | 'poNumber' | 'subtotalAmount' | 'taxAmount' | 'totalAmount'
    >
  ) => {
    await api.createPurchaseOrder(po);
    refreshAllData();
  };

  const handleUpdatePO = async (poId: string, poData: Partial<PurchaseOrder>) => {
    await api.updatePurchaseOrder(poId, poData);
    refreshAllData();
  };

  const handleUpdatePOStatus = async (poId: string, status: string) => {
    await api.updatePurchaseOrderStatus(poId, status);
    refreshAllData();
  };

  const handleDeletePO = async (poId: string) => {
    await api.deletePurchaseOrder(poId);
    await refreshAllData();
  };

  const handleCreateInvoice = async (
    inv: Omit<PurchaseInvoice, 'id' | 'invoiceNumber'>
  ) => {
    // The server registers every received serial in the serial register inside
    // the invoice's own transaction (serial-register audit, Slice 1). The old
    // client-side loop that wrote "Unassigned Stock" customer-device rows is
    // gone: it was a SECOND writer of the same units, and its rows made stock
    // operations validate against the customer table instead of the register.
    await api.createPurchaseInvoice(inv);
    refreshAllData();
  };

  const handleCreatePurchaseReturn = async (payload: any) => {
    const created = await api.createPurchaseReturn(payload);
    refreshAllData();
    return created;
  };

  const handleCancelPurchaseReturn = async (id: string, reason: string) => {
    await api.cancelPurchaseReturn(id, reason);
    refreshAllData();
  };

  const handleApprovePurchaseReturn = async (id: string) => {
    await api.postPurchaseReturn(id);
    refreshAllData();
  };

  const handleDeleteInvoice = async (invoiceId: string) => {
    await api.deletePurchaseInvoice(invoiceId);
    await refreshAllData();
  };

  const handleRecordPayment = async (
    id: string,
    amount: number,
    paymentMethod?: string,
    details?: {
      bankName?: string;
      bankBranch?: string;
      accountNumber?: string;
      chequeNumber?: string;
      transactionReference?: string;
      settlementAccountId?: string;
      paymentDateAD?: string;
    }
  ) => {
    // One payment document, one atomic write: the server records the payment
    // row, applies it to the invoice and posts the AP/cash journal together.
    // Calling the balance-only /pay endpoint first would make that split
    // non-atomic and post the same cash movement twice.
    const linkedInv = purchaseInvoices.find((inv) => inv.id === id);
    await api.createVendorPayment({
      supplierId: linkedInv?.supplierId,
      supplierName: linkedInv?.supplierName || '',
      invoiceId: id,
      invoiceNumber: linkedInv?.invoiceNumber,
      amount,
      paymentMethod: paymentMethod || 'CASH',
      paymentDateAD: details?.paymentDateAD || new Date().toISOString().split('T')[0],
      bankName: details?.bankName,
      bankBranch: details?.bankBranch,
      accountNumber: details?.accountNumber,
      chequeNumber: details?.chequeNumber,
      transactionReference: details?.transactionReference,
      settlementAccountId: details?.settlementAccountId,
    });
    refreshAllData();
  };

  const handleReversePayment = async (paymentId: string, reason: string) => {
    await api.reverseVendorPayment(paymentId, reason);
    refreshAllData();
  };

  const handleReverseInvoicePayments = async (invoiceId: string, reason: string) => {
    await api.reverseInvoicePayments(invoiceId, reason);
    refreshAllData();
  };

  const handleReceiveShipment = async (
    id: string,
    verificationData?: {
      receivedItems?: {
        itemId: string;
        quantityReceived: number;
        receivedSerials?: { deviceSerial: string; ponSerial?: string }[];
        itemDiscrepancyNotes?: string;
      }[];
      receivedByNotes?: string;
    }
  ) => {
    await api.receiveShipment(id, verificationData);
    refreshAllData();
  };

  const handleCancelReceiveShipment = async (id: string, reason?: string) => {
    await api.cancelReceiveShipment(id, currentUser, reason);
    refreshAllData();
  };

  const handleFindShipment = React.useCallback(
    async (key: string, branchId?: string): Promise<Shipment | null> => {
      try {
        const page = await api.getShipmentPage({
          branchId,
          search: key,
          page: 1,
          pageSize: 25,
        });
        const wanted = key.toLowerCase();
        return (
          (page?.data || []).find((sh) =>
            [sh.trackingCode, sh.id].some(
              (value) => typeof value === 'string' && value.toLowerCase() === wanted
            )
          ) || null
        );
      } catch {
        return null;
      }
    },
    []
  );

  const handleCreateOperation = async (op: Partial<StockOperation>) => {
    await api.createStockOperation(op);
    refreshAllData();
  };

  const handleReceiveOperation = async (id: string) => {
    await api.receiveStockOperation(id);
    refreshAllData();
  };

  const handleReverseStockOperation = async (id: string, reason?: string) => {
    await api.reverseStockOperation(id, reason, currentUser);
    refreshAllData();
  };


  return {
    handleCreatePO,
    handleUpdatePO,
    handleUpdatePOStatus,
    handleDeletePO,
    handleCreateInvoice,
    handleCreatePurchaseReturn,
    handleCancelPurchaseReturn,
    handleApprovePurchaseReturn,
    handleDeleteInvoice,
    handleRecordPayment,
    handleReversePayment,
    handleReverseInvoicePayments,
    handleReceiveShipment,
    handleCancelReceiveShipment,
    handleFindShipment,
    handleCreateOperation,
    handleReceiveOperation,
    handleReverseStockOperation,
  };
}
