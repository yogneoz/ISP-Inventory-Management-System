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
import type { CustodyEmployee, WorkOrderEvidence } from '../../services/api';
import type { User } from '../../types';

type WorkOrder = {
  id: string;
  work_order_no: string;
  branch_id: string;
  customer_id: string;
  customer_name: string | null;
  kind: 'INSTALL' | 'SERVICE' | 'DISCONNECT';
  status: 'OPEN' | 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';
  technician_id: string | null;
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

/** The server's per-capture ceiling; it re-checks and names it on refusal. */
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const stampOf = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/** The browser reads the file the way the phone does: a base64 payload. */
const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^;]+;base64,/, ''));
    reader.readAsDataURL(file);
  });

export const FieldWorkOrders: React.FC<FieldWorkOrdersProps> = ({ selectedBranchId, refreshKey, customers = [] }) => {
  const [rows, setRows] = React.useState<WorkOrder[]>([]);
  const [subscribers, setSubscribers] = React.useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [dialog, setDialog] = React.useState<'create' | 'assign' | 'complete' | null>(null);
  const [active, setActive] = React.useState<WorkOrder | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Proof of work (the visit's photo/signature gallery and upload).
  const [proofFor, setProofFor] = React.useState<WorkOrder | null>(null);
  const [evidence, setEvidence] = React.useState<WorkOrderEvidence[]>([]);
  const [proofLoading, setProofLoading] = React.useState(false);
  const [proofError, setProofError] = React.useState<string | null>(null);
  const [proofNotice, setProofNotice] = React.useState<string | null>(null);
  const [captureKind, setCaptureKind] = React.useState<'PHOTO' | 'SIGNATURE'>('PHOTO');
  const [captureCaption, setCaptureCaption] = React.useState('');
  const [captureFile, setCaptureFile] = React.useState<File | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [preview, setPreview] = React.useState<{ url: string; label: string } | null>(null);
  const [custodyRoster, setCustodyRoster] = React.useState<CustodyEmployee[]>([]);
  const [form, setForm] = React.useState({
    customerId: '',
    kind: 'INSTALL',
    scheduledDateAd: today(),
    technicianId: '',
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

  // The technician is a person in the custody roster, not a typed name: the
  // server stores `technician_id` so work-order stock follows the same employee
  // the My Stock panel and the phone read.
  React.useEffect(() => {
    api.getCustodyEmployees()
      .then((rows) => setCustodyRoster(Array.isArray(rows) ? rows : []))
      .catch(() => setCustodyRoster([]));
  }, []);

  const branchEmployees = React.useMemo(
    () =>
      custodyRoster.filter(
        (person) => !selectedBranchId || selectedBranchId === 'ALL' || person.branch_id === selectedBranchId
      ),
    [custodyRoster, selectedBranchId]
  );
  const selectedTechnicianName = branchEmployees.find((person) => person.id === form.technicianId)?.name || '';

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
      technicianId: row?.technician_id || prev.technicianId,
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

  const loadEvidence = async (workOrderId: string) => {
    setProofLoading(true);
    setProofError(null);
    try {
      const payload = await api.getFieldWorkOrderEvidence(workOrderId);
      setEvidence(Array.isArray(payload?.evidence) ? payload.evidence : []);
    } catch (err: any) {
      setEvidence([]);
      setProofError(err?.message || 'The proof-of-work captures could not be loaded.');
    } finally {
      setProofLoading(false);
    }
  };

  const openProof = (row: WorkOrder) => {
    setProofFor(row);
    setEvidence([]);
    setProofError(null);
    setProofNotice(null);
    setCaptureFile(null);
    setCaptureCaption('');
    setCaptureKind('PHOTO');
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    void loadEvidence(row.id);
  };

  const closeProof = () => {
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setProofFor(null);
  };

  const uploadCapture = async () => {
    if (!proofFor) return;
    setProofError(null);
    setProofNotice(null);
    if (!captureFile) {
      setProofError('Choose an image file to attach first.');
      return;
    }
    if (captureFile.size > MAX_EVIDENCE_BYTES) {
      setProofError(
        `That file is ${formatBytes(captureFile.size)}. One capture is capped at 2 MiB (2,097,152 bytes) — downscale or retake it.`
      );
      return;
    }
    setUploading(true);
    try {
      const dataBase64 = await readFileAsBase64(captureFile);
      const saved = await api.postFieldWorkOrderEvidence(proofFor.id, {
        kind: captureKind,
        contentType: captureFile.type || 'image/png',
        dataBase64,
        caption: captureCaption.trim() || undefined,
      });
      setProofNotice(
        saved.inserted
          ? `Stored a ${formatBytes(saved.byteSize)} ${saved.kind.toLowerCase()} · SHA-256 ${saved.sha256.slice(0, 12)}… · this order now holds ${saved.count} capture${saved.count === 1 ? '' : 's'}.`
          : `Already on file — these exact bytes were stored earlier, so nothing was duplicated. The order still holds ${saved.count} capture${saved.count === 1 ? '' : 's'}.`
      );
      setCaptureFile(null);
      setCaptureCaption('');
      await loadEvidence(proofFor.id);
    } catch (err: any) {
      const message = String(err?.message || '');
      if (err?.status === 413) {
        setProofError('The upload was refused by the request-size limit before it could be checked. One capture is capped at 2 MiB.');
      } else if (/ceiling is/i.test(message)) {
        setProofError(`That capture is too large — ${message}`);
      } else {
        setProofError(message || 'The capture could not be stored.');
      }
    } finally {
      setUploading(false);
    }
  };

  const viewCapture = async (row: WorkOrderEvidence) => {
    if (!proofFor) return;
    setProofError(null);
    try {
      const blob = await api.fetchFieldWorkOrderEvidenceContent(proofFor.id, row.id);
      const url = URL.createObjectURL(blob);
      setPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url, label: `${row.kind === 'PHOTO' ? 'Photo' : 'Signature'} · ${row.sha256.slice(0, 12)}…` };
      });
    } catch (err: any) {
      setProofError(err?.message || 'The stored capture could not be read back.');
    }
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
          technicianId: form.technicianId || undefined,
          technicianName: selectedTechnicianName || undefined,
          ontSerial: form.ontSerial || undefined,
          routerSerial: form.routerSerial || undefined,
          ipAddress: form.ipAddress || undefined,
          planName: form.planName || undefined,
          notes: form.notes,
        });
      } else if (dialog === 'assign' && active) {
        await api.assignFieldWorkOrder(active.id, {
          technicianId: form.technicianId || undefined,
          technicianName: selectedTechnicianName || form.technicianName || undefined,
        });
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
                  <span className="inline-flex gap-2">
                    <button className="text-xs font-medium text-slate-700" onClick={() => openProof(row)}>
                      Proof
                    </button>
                    {['OPEN', 'ASSIGNED'].includes(row.status) && (
                      <>
                        <button className="text-xs font-medium text-sky-700" onClick={() => openDialog('assign', row)}>
                          {row.status === 'ASSIGNED' ? 'Reassign' : 'Assign'}
                        </button>
                        <button className="text-xs font-medium text-emerald-700" onClick={() => openDialog('complete', row)}>Complete</button>
                      </>
                    )}
                  </span>
                  {row.status === 'COMPLETED' && row.completion_notes && (
                    <span className="text-xs text-slate-400" title={row.completion_notes}>Completed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {proofFor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Proof of work">
          <div className="max-h-[90vh] w-full max-w-3xl space-y-4 overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-800">Proof of work</h2>
                <p className="text-sm text-slate-500">
                  {proofFor.work_order_no} · {proofFor.customer_name || proofFor.customer_id}
                </p>
              </div>
              <button className="text-xs font-medium text-slate-500" onClick={closeProof}>Close</button>
            </div>

            {proofError && (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {proofError}
              </div>
            )}
            {proofNotice && (
              <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {proofNotice}
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Captures on this order {evidence.length ? `(${evidence.length})` : ''}
              </p>
              {proofLoading ? (
                <p className="text-sm text-slate-500">Loading captures…</p>
              ) : evidence.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No proof stored yet. A photo or signature captured on site appears here once it is attached.
                </p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-2 py-1 font-semibold">Kind</th>
                      <th className="px-2 py-1 font-semibold">Captured</th>
                      <th className="px-2 py-1 font-semibold">Size</th>
                      <th className="px-2 py-1 font-semibold">SHA-256</th>
                      <th className="px-2 py-1 font-semibold">Caption</th>
                      <th className="px-2 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.map((row) => (
                      <tr key={row.id} className="border-t border-slate-100">
                        <td className="px-2 py-1">{row.kind === 'PHOTO' ? 'Photo' : 'Signature'}</td>
                        <td className="px-2 py-1 text-xs text-slate-500">{stampOf(row.captured_at)}</td>
                        <td className="px-2 py-1 tabular-nums">{formatBytes(row.byte_size)}</td>
                        <td className="px-2 py-1 font-mono text-xs text-slate-500">{row.sha256.slice(0, 12)}…</td>
                        <td className="px-2 py-1 text-xs text-slate-500">{row.caption || '—'}</td>
                        <td className="px-2 py-1 text-right">
                          <button className="text-xs font-medium text-sky-700" onClick={() => void viewCapture(row)}>
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {preview && (
              <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-slate-600">Read back · {preview.label}</p>
                  <button
                    className="text-xs font-medium text-slate-500"
                    onClick={() => {
                      URL.revokeObjectURL(preview.url);
                      setPreview(null);
                    }}
                  >
                    Close preview
                  </button>
                </div>
                <img src={preview.url} alt={preview.label} className="max-h-80 w-auto rounded-lg border border-slate-200" />
              </div>
            )}

            <div className="space-y-2 rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Attach a capture</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-600">Kind</span>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={captureKind}
                    onChange={(event) => setCaptureKind(event.target.value as 'PHOTO' | 'SIGNATURE')}
                  >
                    <option value="PHOTO">Photo</option>
                    <option value="SIGNATURE">Signature</option>
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-600">Image file</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    onChange={(event) => setCaptureFile(event.target.files?.[0] || null)}
                  />
                </label>
              </div>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-600">Caption (optional)</span>
                <input
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={captureCaption}
                  placeholder="What the capture shows"
                  onChange={(event) => setCaptureCaption(event.target.value)}
                />
              </label>
              {captureFile && (
                <p className="text-xs text-slate-500">
                  {captureFile.name} · {formatBytes(captureFile.size)}
                </p>
              )}
              <p className="text-xs text-slate-400">
                One capture is capped at 2 MiB. Re-sending the same file is safe — the server recognises it and stores nothing twice.
              </p>
              <div className="flex justify-end">
                <button
                  className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
                  onClick={() => void uploadCapture()}
                  disabled={uploading}
                >
                  {uploading ? 'Attaching…' : 'Attach capture'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-600">Technician (optional)</span>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={form.technicianId}
                    onChange={(event) => setForm((prev) => ({ ...prev, technicianId: event.target.value }))}
                  >
                    <option value="">Unassigned</option>
                    {branchEmployees.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}{person.employee_code ? ` (${person.employee_code})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {field('Notes', 'notes', { placeholder: 'Work requested / access notes' })}
              </>
            )}

            {dialog === 'assign' && (
              <>
                <p className="text-sm text-slate-500">{active?.work_order_no} · {active?.customer_name || active?.customer_id}</p>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-600">Technician</span>
                  <select
                    required
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={form.technicianId}
                    onChange={(event) => setForm((prev) => ({ ...prev, technicianId: event.target.value }))}
                  >
                    <option value="">Select the technician…</option>
                    {branchEmployees.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}{person.employee_code ? ` (${person.employee_code})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
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
