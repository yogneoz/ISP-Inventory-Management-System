/** Sales territory and agent masters (party data). */
import { fetchJson } from './http';
import type { Area, SalesAgent } from '../../types';

export interface AreaInput {
  code: string;
  name: string;
  parentId?: string | null;
  branchId?: string | null;
  active?: boolean;
}

export async function getAreas(includeInactive = true): Promise<Area[]> {
  return fetchJson(`/api/sales/areas${includeInactive ? '?includeInactive=1' : ''}`);
}

export async function createArea(input: AreaInput): Promise<Area> {
  return fetchJson('/api/sales/areas', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateArea(id: string, input: Partial<AreaInput>): Promise<Area> {
  return fetchJson(`/api/sales/areas/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteArea(id: string): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/sales/areas/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface SalesAgentInput {
  code: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  areaId?: string | null;
  commissionRate?: number;
  active?: boolean;
}

export async function getSalesAgents(includeInactive = true): Promise<SalesAgent[]> {
  return fetchJson(`/api/sales/agents${includeInactive ? '?includeInactive=1' : ''}`);
}

export async function createSalesAgent(input: SalesAgentInput): Promise<SalesAgent> {
  return fetchJson('/api/sales/agents', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateSalesAgent(
  id: string,
  input: Partial<SalesAgentInput>
): Promise<SalesAgent> {
  return fetchJson(`/api/sales/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteSalesAgent(id: string): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/sales/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}