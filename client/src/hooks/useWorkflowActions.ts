/**
 * workflow mutations, lifted out of App.tsx.
 *
 * Each wrapper is the same call the root made inline: hit the API, then
 * refresh the shell. They live in a hook so the render code only wires
 * the returned handlers to screens.
 */
import { api } from '../services/api';
import type { ApprovalRequest } from '../types';
import type { ActionDeps } from './actionDeps';

export function useWorkflowActions({ refreshAllData, currentUser, financialSummary }: ActionDeps) {
  const handleCreateApprovalRequest = async (
    requestData: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'>
  ) => {
    await api.createApprovalRequest(requestData);
    await refreshAllData();
  };

  const handleProcessApprovalRequest = async (
    id: string,
    status: 'APPROVED' | 'REJECTED',
    rejectionReason?: string
  ) => {
    await api.processApprovalRequest(id, status, currentUser, rejectionReason);
    await refreshAllData();
  };

  const handleCancelApprovalRequest = async (id: string, reason?: string) => {
    await api.cancelApprovalRequest(id, currentUser, reason);
    await refreshAllData();
  };


  return {
    handleCreateApprovalRequest,
    handleProcessApprovalRequest,
    handleCancelApprovalRequest,
  };
}
