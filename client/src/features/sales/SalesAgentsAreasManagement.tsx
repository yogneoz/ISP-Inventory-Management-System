/**
 * Sales Agents & Areas — the party-side sales dimension masters.
 * Areas are branch-owned or global territories; agents own an area and carry
 * an optional commission rate. Customers default to both, and posted invoices
 * snapshot them so later master edits cannot rewrite history.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Edit2, MapPinned, Plus, Trash2, UserRound, Users, X } from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { ModalPanel } from '../../components/common/ModalPanel';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import { isOperationAllowed } from '../../utils/permissions';
import type { Area, Branch, SalesAgent, User } from '../../types';

interface SalesAgentsAreasManagementProps {
  branches?: Branch[];
  currentUser?: User | null;
}

type Tab = 'AREAS' | 'AGENTS';

interface AreaForm {
  code: string;
  name: string;
  parentId: string;
  branchId: string;
  active: boolean;
}

interface AgentForm {
  code: string;
  name: string;
  phone: string;
  email: string;
  areaId: string;
  commissionRate: string;
  active: boolean;
}

const EMPTY_AREA: AreaForm = { code: '', name: '', parentId: '', branchId: '', active: true };
const EMPTY_AGENT: AgentForm = {
  code: '', name: '', phone: '', email: '', areaId: '', commissionRate: '0', active: true,
};

const codeFromName = (name: string): string =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

export const SalesAgentsAreasManagement: React.FC<SalesAgentsAreasManagementProps> = ({
  branches = [],
  currentUser,
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canManage = isOperationAllowed('customers-manage', currentUser?.role);
  const activationKey = useActivationKey('sales-agents-areas');

  const [tab, setTab] = useState<Tab>('AREAS');
  const [areas, setAreas] = useState<Area[]>([]);
  const [agents, setAgents] = useState<SalesAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<Tab | null>(null);
  const [editingArea, setEditingArea] = useState<Area | null>(null);
  const [editingAgent, setEditingAgent] = useState<SalesAgent | null>(null);
  const [areaForm, setAreaForm] = useState<AreaForm>(EMPTY_AREA);
  const [agentForm, setAgentForm] = useState<AgentForm>(EMPTY_AGENT);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [areaRows, agentRows] = await Promise.all([api.getAreas(true), api.getSalesAgents(true)]);
      setAreas(Array.isArray(areaRows) ? areaRows : []);
      setAgents(Array.isArray(agentRows) ? agentRows : []);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The sales-area and agent lists could not be read.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);

  const branchLabel = (id?: string | null) =>
    id ? branches.find((branch) => branch.id === id)?.name || id : 'All branches';

  const filteredAreas = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return areas;
    return areas.filter((area) =>
      `${area.code} ${area.name} ${area.parentName || ''} ${branchLabel(area.branchId)}`
        .toLowerCase()
        .includes(needle)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areas, search, branches]);

  const filteredAgents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) =>
      `${agent.code} ${agent.name} ${agent.phone || ''} ${agent.email || ''} ${agent.areaName || ''}`
        .toLowerCase()
        .includes(needle)
    );
  }, [agents, search]);

  const closeModal = () => {
    setModal(null);
    setEditingArea(null);
    setEditingAgent(null);
    setAreaForm(EMPTY_AREA);
    setAgentForm(EMPTY_AGENT);
  };

  const openAreaCreate = () => {
    setEditingArea(null);
    setAreaForm(EMPTY_AREA);
    setModal('AREAS');
  };

  const openAreaEdit = (area: Area) => {
    setEditingArea(area);
    setAreaForm({
      code: area.code,
      name: area.name,
      parentId: area.parentId || '',
      branchId: area.branchId || '',
      active: area.active,
    });
    setModal('AREAS');
  };

  const openAgentCreate = () => {
    setEditingAgent(null);
    setAgentForm(EMPTY_AGENT);
    setModal('AGENTS');
  };

  const openAgentEdit = (agent: SalesAgent) => {
    setEditingAgent(agent);
    setAgentForm({
      code: agent.code,
      name: agent.name,
      phone: agent.phone || '',
      email: agent.email || '',
      areaId: agent.areaId || '',
      commissionRate: String(agent.commissionRate ?? 0),
      active: agent.active,
    });
    setModal('AGENTS');
  };

  const saveArea = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = areaForm.name.trim();
    const code = (areaForm.code.trim() || codeFromName(name)).toUpperCase();
    if (!name || !code) {
      alertDialog('An area name and code are required.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code,
        name,
        parentId: areaForm.parentId || null,
        branchId: areaForm.branchId || null,
        active: areaForm.active,
      };
      if (editingArea) await api.updateArea(editingArea.id, payload);
      else await api.createArea(payload);
      closeModal();
      await load();
    } catch (err: any) {
      alertDialog(`Failed to save area: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = agentForm.name.trim();
    const code = (agentForm.code.trim() || codeFromName(name)).toUpperCase();
    if (!name || !code) {
      alertDialog('A sales-agent name and code are required.');
      return;
    }
    const commission = Number(agentForm.commissionRate);
    if (!Number.isFinite(commission) || commission < 0 || commission > 100) {
      alertDialog('Commission rate must be between 0 and 100.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code,
        name,
        phone: agentForm.phone.trim() || null,
        email: agentForm.email.trim() || null,
        areaId: agentForm.areaId || null,
        commissionRate: commission,
        active: agentForm.active,
      };
      if (editingAgent) await api.updateSalesAgent(editingAgent.id, payload);
      else await api.createSalesAgent(payload);
      closeModal();
      await load();
    } catch (err: any) {
      alertDialog(`Failed to save sales agent: ${err?.message || 'Database error'}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteArea = async (area: Area) => {
    if (!(await confirmDialog(`Delete area '${area.name}'? Used areas must be retired instead.`))) return;
    try {
      await api.deleteArea(area.id);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to delete area: ${err?.message || 'Database error'}`);
    }
  };

  const deleteAgent = async (agent: SalesAgent) => {
    if (!(await confirmDialog(`Delete sales agent '${agent.name}'? Used agents must be retired instead.`))) return;
    try {
      await api.deleteSalesAgent(agent.id);
      await load();
    } catch (err: any) {
      alertDialog(`Failed to delete sales agent: ${err?.message || 'Database error'}`);
    }
  };

  const parentOptions = areas.filter(
    (area) =>
      area.id !== editingArea?.id &&
      area.active &&
      (areaForm.branchId ? area.branchId === areaForm.branchId : !area.branchId)
  );

  return (
    <div className="flex h-[calc(100vh-6.5rem)] flex-col space-y-4 overflow-hidden">
      <PageHeader
        title="Sales Agents & Areas"
        description={
          loadError && areas.length === 0 && agents.length === 0
            ? 'Sales masters unavailable — retry below'
            : `${areas.length} areas · ${agents.length} agents · customer defaults and invoice snapshots`
        }
        icon={<MapPinned className="h-5 w-5 text-indigo-500" />}
        actions={
          canManage ? (
            <button
              onClick={tab === 'AREAS' ? openAreaCreate : openAgentCreate}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" />
              <span>{tab === 'AREAS' ? 'Add Area' : 'Add Sales Agent'}</span>
            </button>
          ) : null
        }
      />

      <div className="flex items-center gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => { setTab('AREAS'); setSearch(''); }}
          className={`rounded-xl px-3 py-1.5 font-bold ${tab === 'AREAS' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400'}`}
        >
          <MapPinned className="mr-1 inline h-3.5 w-3.5" /> Areas ({areas.length})
        </button>
        <button
          type="button"
          onClick={() => { setTab('AGENTS'); setSearch(''); }}
          className={`rounded-xl px-3 py-1.5 font-bold ${tab === 'AGENTS' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400'}`}
        >
          <Users className="mr-1 inline h-3.5 w-3.5" /> Sales Agents ({agents.length})
        </button>
      </div>

      <FilterCard
        searchPlaceholder={tab === 'AREAS' ? 'Search area code, name, branch…' : 'Search agent code, name, area…'}
        searchValue={search}
        onSearchApply={setSearch}
        hasActiveFilters={Boolean(search)}
        onClearAll={() => setSearch('')}
      />

      <LoadStateNotice
        subject="sales areas and agents"
        loading={loading}
        error={loadError}
        hasCachedRows={areas.length > 0 || agents.length > 0}
        onRetry={load}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-[#0f1218]">
        <div className="relative min-h-0 flex-1 overflow-auto">
          {tab === 'AREAS' ? (
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
                <tr>
                  <th className="px-2.5 py-1.5">Code</th>
                  <th className="px-2.5 py-1.5">Area</th>
                  <th className="px-2.5 py-1.5">Parent</th>
                  <th className="px-2.5 py-1.5">Branch</th>
                  <th className="px-2.5 py-1.5 text-center">Status</th>
                  <th className="px-2.5 py-1.5 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filteredAreas.length === 0 ? (
                  <tr><td colSpan={6} className="p-6 text-center text-slate-500">{loading ? 'Loading areas…' : areas.length === 0 ? 'No areas are configured.' : 'No areas match this search.'}</td></tr>
                ) : filteredAreas.map((area) => (
                  <tr key={area.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">{area.code}</td>
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white"><MapPinned className="mr-1 inline h-3.5 w-3.5 text-indigo-500" />{area.name}</td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">{area.parentName || '—'}</td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400"><Building2 className="mr-1 inline h-3 w-3 text-slate-400" />{branchLabel(area.branchId)}</td>
                    <td className="px-2.5 py-1.5 text-center"><StatusPill active={area.active} /></td>
                    <td className="px-2.5 py-1.5"><RowActions canManage={canManage} onEdit={() => openAreaEdit(area)} onDelete={() => deleteArea(area)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100 text-[10px] font-bold tracking-wider text-slate-700 dark:border-slate-800 dark:bg-[#12161f] dark:text-slate-400">
                <tr>
                  <th className="px-2.5 py-1.5">Code</th>
                  <th className="px-2.5 py-1.5">Sales Agent</th>
                  <th className="px-2.5 py-1.5">Area</th>
                  <th className="px-2.5 py-1.5">Contact</th>
                  <th className="px-2.5 py-1.5 text-right">Commission</th>
                  <th className="px-2.5 py-1.5 text-center">Status</th>
                  <th className="px-2.5 py-1.5 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filteredAgents.length === 0 ? (
                  <tr><td colSpan={7} className="p-6 text-center text-slate-500">{loading ? 'Loading sales agents…' : agents.length === 0 ? 'No sales agents are configured.' : 'No agents match this search.'}</td></tr>
                ) : filteredAgents.map((agent) => (
                  <tr key={agent.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">{agent.code}</td>
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white"><UserRound className="mr-1 inline h-3.5 w-3.5 text-indigo-500" />{agent.name}</td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">{agent.areaName || '—'}</td>
                    <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400">{[agent.phone, agent.email].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-2.5 py-1.5 text-right font-mono">{Number(agent.commissionRate).toFixed(2)}%</td>
                    <td className="px-2.5 py-1.5 text-center"><StatusPill active={agent.active} /></td>
                    <td className="px-2.5 py-1.5"><RowActions canManage={canManage} onEdit={() => openAgentEdit(agent)} onDelete={() => deleteAgent(agent)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <ModalPanel
            label={modal === 'AREAS' ? (editingArea ? 'Edit Area' : 'Add Area') : (editingAgent ? 'Edit Sales Agent' : 'Add Sales Agent')}
            onClose={closeModal}
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold">{modal === 'AREAS' ? (editingArea ? 'Edit Area' : 'Add Area') : (editingAgent ? 'Edit Sales Agent' : 'Add Sales Agent')}</h3>
              <button onClick={closeModal} className="cursor-pointer rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
            {modal === 'AREAS' ? (
              <form onSubmit={saveArea} className="space-y-4 text-xs">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Code *"><input value={areaForm.code} onChange={(e) => setAreaForm({ ...areaForm, code: e.target.value.toUpperCase() })} placeholder="KATHMANDU" className={inputClass} /></Field>
                  <Field label="Name *"><input required value={areaForm.name} onChange={(e) => setAreaForm({ ...areaForm, name: e.target.value })} placeholder="Kathmandu Valley" className={inputClass} /></Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Parent Area"><select value={areaForm.parentId} onChange={(e) => setAreaForm({ ...areaForm, parentId: e.target.value })} className={inputClass}><option value="">No parent</option>{parentOptions.map((area) => <option key={area.id} value={area.id}>{area.code} — {area.name}</option>)}</select></Field>
                  <Field label="Branch"><select value={areaForm.branchId} onChange={(e) => setAreaForm({ ...areaForm, branchId: e.target.value })} className={inputClass}><option value="">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></Field>
                </div>
                <ActiveCheck checked={areaForm.active} onChange={(active) => setAreaForm({ ...areaForm, active })} label="Active — offer this area to new customers and invoices" />
                <FormActions saving={saving} onCancel={closeModal} label={editingArea ? 'Save Changes' : 'Add Area'} />
              </form>
            ) : (
              <form onSubmit={saveAgent} className="space-y-4 text-xs">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Code *"><input value={agentForm.code} onChange={(e) => setAgentForm({ ...agentForm, code: e.target.value.toUpperCase() })} placeholder="AGENT_01" className={inputClass} /></Field>
                  <Field label="Name *"><input required value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} placeholder="Aarav Sharma" className={inputClass} /></Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Phone"><input value={agentForm.phone} onChange={(e) => setAgentForm({ ...agentForm, phone: e.target.value })} placeholder="98…" className={inputClass} /></Field>
                  <Field label="Email"><input type="email" value={agentForm.email} onChange={(e) => setAgentForm({ ...agentForm, email: e.target.value })} placeholder="agent@example.com" className={inputClass} /></Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Area"><select value={agentForm.areaId} onChange={(e) => setAgentForm({ ...agentForm, areaId: e.target.value })} className={inputClass}><option value="">No area</option>{areas.filter((area) => area.active).map((area) => <option key={area.id} value={area.id}>{area.code} — {area.name}</option>)}</select></Field>
                  <Field label="Commission Rate (%)"><input type="number" min="0" max="100" step="0.01" value={agentForm.commissionRate} onChange={(e) => setAgentForm({ ...agentForm, commissionRate: e.target.value })} className={inputClass} /></Field>
                </div>
                <ActiveCheck checked={agentForm.active} onChange={(active) => setAgentForm({ ...agentForm, active })} label="Active — offer this agent to new customers and invoices" />
                <FormActions saving={saving} onCancel={closeModal} label={editingAgent ? 'Save Changes' : 'Add Sales Agent'} />
              </form>
            )}
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

const inputClass =
  'h-9 w-full rounded-lg border border-slate-300 bg-transparent px-3 dark:border-slate-700';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div><label className="mb-1 block font-semibold">{label}</label>{children}</div>
);

const ActiveCheck: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600" /><span className="font-semibold">{label}</span></label>
);

const StatusPill: React.FC<{ active: boolean }> = ({ active }) => (
  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${active ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300' : 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>{active ? 'Active' : 'Retired'}</span>
);

const RowActions: React.FC<{ canManage: boolean; onEdit: () => void; onDelete: () => void }> = ({ canManage, onEdit, onDelete }) =>
  canManage ? (
    <div className="flex items-center justify-center gap-1">
      <button onClick={onEdit} className="cursor-pointer rounded-lg p-1 text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40" aria-label="Edit"><Edit2 className="h-3.5 w-3.5" /></button>
      <button onClick={onDelete} className="cursor-pointer rounded-lg p-1 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40" aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
    </div>
  ) : <span className="block text-center text-slate-400">—</span>;

const FormActions: React.FC<{ saving: boolean; onCancel: () => void; label: string }> = ({ saving, onCancel, label }) => (
  <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
    <button type="button" onClick={onCancel} className="cursor-pointer rounded-xl border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
    <button type="submit" disabled={saving} className="cursor-pointer rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60">{saving ? 'Saving…' : label}</button>
  </div>
);

export default SalesAgentsAreasManagement;