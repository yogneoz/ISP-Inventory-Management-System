/**
 * Field capture — technician work orders.
 *
 * One screen for the whole visit: raise an order against a subscriber, name the
 * technician, and close it out with the connection and equipment details the
 * technician actually sees on site. The server owns the state rules (a completed
 * order cannot be completed twice) and the branch scope; this screen only shows
 * what it is given and refreshes after every write.
 */
import React from 'react';
import { api } from '../../services/api';
import type { User } from '../../types';

type WorkOrder = {
  id: string;
  work_order_no: string;
  branch_id: string;
  customer_id: string;
  customer_name: string | null;
  kind: 'INSTALL' | 'SERVICE' | 'DISCONNECT';
  status: 'OPEN' | 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';
  technician_name: string | null;
  scheduled_date_ad: string;
  ont_serial: string | null;
  router_serial: string | null;
  ip_address: string | null;
  plan_name: string | null;
  notes: string;
  completion_notes: string | null;
  completed_at: string | null;
};

interface FieldWorkOrdersProps {
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  currentUser?: User | null;
  refreshKey?: number;
  customers?: Array<Record<string, any>>;
}

const KIND_LABEL: Record<WorkOrder['kind'], string> = {
  INSTALL: 'Installation',
  SERVICE: 'Service visit',
  DISCONNECT: 'Disconnection',
};

const STATUS_STYLE: Record<WorkOrder['status'], string> = {
  OPEN: 'bg-amber-50 text-amber-700 border-amber-200',
  ASSIGNED: 'bg-sky-50 text-sky-700 border-sky-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CANCELLED: 'bg-slate-100 text-slate-500 border-slate-200',
};

const today = () => new Date().toISOString().slice(0, 10);

export const FieldWorkOrders: React.FC<FieldWorkOrdersProps> = ({ selectedBranchId, refreshKey, customers = [] }) => {
  const [rows, setRows] = React.useState<WorkOrder[]>([]);
  const [subscribers, setSubscribers] = React.useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [dialog, setDialog] = React.useState<'create' | 'assign' | 'complete' | null>(null);
  const [active, setActive] = React.useState<WorkOrder | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({
    customerId: '',
    kind: 'INSTALL',
    scheduledDateAd: today(),
    technicianName: '',
    notes: '',
    ontSerial: '',
    routerSerial: '',
    ipAddress: '',
    planName: '',
    completionNotes: '',
  });

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFieldWorkOrders({
        branchId: selectedBranchId && selectedBranchId !== 'ALL' ? selectedBranchId : undefined,
        status: statusFilter || undefined,
      });
      setRows(data);
    } catch (err: any) {
      setError(err?.message || 'Could not load work orders.');
    } finally {
      setLoading(false);
    }
  }, [selectedBranchId, statusFilter]);

  React.useEffect(() => { void load(); }, [load, refreshKey]);

  React.useEffect(() => {
    api.getCustomers({ branchId: selectedBranchId && selectedBranchId !== 'ALL' ? selectedBranchId : undefined })
      .then((data: any) => setSubscribers(Array.isArray(data) ? data : data?.data || []))
      .catch(() => setSubscribers([]));
  }, [selectedBranchId, refreshKey]);

  const counts = React.useMemo(() => ({
    open: rows.filter((row) => row.status === 'OPEN').length,
    assigned: rows.filter((row) => row.status === 'ASSIGNED').length,
    completed: rows.filter((row) => row.status === 'COMPLETED').length,
  }), [rows]);

  const openDialog = (kind: 'create' | 'assign' | 'complete', row?: WorkOrder) => {
    setActive(row || null);
    setForm((prev) => ({
      ...prev,
      customerId: row?.customer_id || prev.customerId,
      technicianName: row?.technician_name || prev.technicianName,
      ontSerial: row?.ont_serial || prev.ontSerial,
      routerSerial: row?.router_serial || prev.routerSerial,
      ipAddress: row?.ip_address || prev.ipAddress,
      planName: row?.plan_name || prev.planName,
      completionNotes: '',
    }));
    setError(null);
    setDialog(kind);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dialog === 'create') {
        await api.createFieldWorkOrder({
          branchId: selectedBranchId !== 'ALL' ? selectedBranchId : undefined,
          customerId: form.customerId,
          kind: form.kind,
          scheduledDateAd: form.scheduledDateAd,
          technicianName: form.technicianName || undefined,
          ontSerial: form.ontSerial || undefined,
          routerSerial: form.routerSerial || undefined,
          ipAddress: form.ipAddress || undefined,
          planName: form.planName || undefined,
          notes: form.notes,
        });
      } else if (dialog === 'assign' && active) {
        await api.assignFieldWorkOrder(active.id, { technicianName: form.technicianName });
      } else if (dialog === 'complete' && active) {
        await api.completeFieldWorkOrder(active.id, {
          completionNotes: form.completionNotes,
          ontSerial: form.ontSerial || undefined,
          routerSerial: form.routerSerial || undefined,
          ipAddress: form.ipAddress || undefined,
          planName: form.planName || undefined,
        });
      }
      setDialog(null);
      await load();
    } catch (err: any) {
      setError(err?.message || 'The work order could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, key: keyof typeof form, options: { placeholder?: string; type?: string } = {}) => (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-600">{label}</span>
      <input
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        type={options.type || 'text'}
        placeholder={options.placeholder}
        value={form[key]}
        onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
      />
    </label>
  );

  return (
    <section className="space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">Field Work Orders</h1>
          <p className="text-sm text-slate-500">Installation, service and disconnection visits for this branch.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="Filter work orders by status"
          >
            <option value="">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="ASSIGNED">Assigned</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
          <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm" onClick={() => void load()}>Refresh</button>
          <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white" onClick={() => openDialog('create')}>
            New work order
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          ['Open', counts.open, 'bg-amber-50 text-amber-700'],
          ['Assigned', counts.assigned, 'bg-sky-50 text-sky-700'],
          ['Completed', counts.completed, 'bg-emerald-50 text-emerald-700'],
        ].map(([label, value, tone]) => (
          <div key={String(label)} className={`rounded-xl border border-slate-200 p-4 ${tone}`}>
            <div className="text-xs uppercase tracking-wide">{label}</div>
            <div className="text-2xl font-semibold">{value as number}</div>
          </div>
        ))}
      </div>

      {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Work order</th>
              <th className="px-3 py-2">Subscriber</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Scheduled</th>
              <th className="px-3 py-2">Technician</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Connection</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td className="px-3 py-6 text-center text-slate-500" colSpan={8}>Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-slate-500" colSpan={8}>No work orders for this branch yet.</td></tr>
            )}
            {!loading && rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono text-xs">{row.work_order_no}</td>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-700">{row.customer_name || row.customer_id}</div>
                  <div className="text-xs text-slate-400">{row.customer_id}</div>
                </td>
                <td className="px-3 py-2">{KIND_LABEL[row.kind]}</td>
                <td className="px-3 py-2">{row.scheduled_date_ad}</td>
                <td className="px-3 py-2">{row.technician_name || <span className="text-slate-400">Unassigned</span>}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {row.ont_serial || row.ip_address
                    ? [row.ont_serial && `ONT ${row.ont_serial}`, row.ip_address, row.plan_name].filter(Boolean).join(' · ')
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {['OPEN', 'ASSIGNED'].includes(row.status) && (
                    <span className="inline-flex gap-2">
                      <button className="text-xs font-medium text-sky-700" onClick={() => openDialog('assign', row)}>
                        {row.status === 'ASSIGNED' ? 'Reassign' : 'Assign'}
                      </button>
                      <button className="text-xs font-medium text-emerald-700" onClick={() => openDialog('complete', row)}>Complete</button>
                    </span>
                  )}
                  {row.status === 'COMPLETED' && row.completion_notes && (
                    <span className="text-xs text-slate-400" title={row.completion_notes}>Completed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">
              {dialog === 'create' ? 'New work order' : dialog === 'assign' ? 'Assign technician' : 'Complete visit'}
            </h2>

            {dialog === 'create' && (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-600">Subscriber</span>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={form.customerId}
                    onChange={(event) => setForm((prev) => ({ ...prev, customerId: event.target.value }))}
                  >
                    <option value="">Select a subscriber…</option>
                    {(customers && customers.length ? customers : subscribers).map((customer) => {
                      const id = String(customer.id ?? customer.customerId ?? customer.customer_id ?? '');
                      const name = String(customer.name ?? customer.customerName ?? customer.customer_name ?? id);
                      return <option key={id} value={id}>{name} ({id})</option>;
                    })}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-600">Visit type</span>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={form.kind}
                    onChange={(event) => setForm((prev) => ({ ...prev, kind: event.target.value }))}
                  >
                    <option value="INSTALL">Installation</option>
                    <option value="SERVICE">Service visit</option>
                    <option value="DISCONNECT">Disconnection</option>
                  </select>
                </label>
                {field('Scheduled date (AD)', 'scheduledDateAd', { type: 'date' })}
                {field('Technician (optional)', 'technicianName', { placeholder: 'Name of the technician' })}
                {field('Notes', 'notes', { placeholder: 'Work requested / access notes' })}
              </>
            )}

            {dialog === 'assign' && (
              <>
                <p className="text-sm text-slate-500">{active?.work_order_no} · {active?.customer_name || active?.customer_id}</p>
                {field('Technician', 'technicianName', { placeholder: 'Name of the technician' })}
              </>
            )}

            {dialog === 'complete' && (
              <>
                <p className="text-sm text-slate-500">{active?.work_order_no} · {active?.customer_name || active?.customer_id}</p>
                {field('Completion notes', 'completionNotes', { placeholder: 'What was done on site' })}
                {field('ONT serial', 'ontSerial', { placeholder: 'e.g. ONT-12345' })}
                {field('Router serial', 'routerSerial', { placeholder: 'Optional' })}
                {field('Assigned IP', 'ipAddress', { placeholder: 'e.g. 10.10.20.31' })}
                {field('Plan', 'planName', { placeholder: 'e.g. 100 Mbps' })}
              </>
            )}

            {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

            <div className="flex justify-end gap-2 pt-2">
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
              <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-60" onClick={() => void submit()} disabled={busy}>
                {busy ? 'Saving…' : dialog === 'complete' ? 'Complete visit' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default FieldWorkOrders;
