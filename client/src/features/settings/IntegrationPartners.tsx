import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDownToLine,
  Boxes,
  CheckCircle2,
  Loader2,
  Pencil,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  Users,
} from 'lucide-react';
import type { User } from '../../types';
import { api } from '../../services/api';
import type {
  IntegrationOutboxRecord,
  IntegrationPartnerRecord,
  IntegrationPartnerStatus,
} from '../../services/api/admin';
import { isOperationAllowed } from '../../utils/permissions';
import { PageHeader } from '../../components/common/PageHeader';
import { ModalPanel } from '../../components/common/ModalPanel';

/**
 * Integration Partners — the subscription portal's row in this ERP and the
 * delivery queue that pushes events to it.
 *
 * The portal owns subscriptions; this ERP owns receivables, stock and HR, so
 * this screen never creates a customer or an invoice. It answers three
 * operational questions:
 *
 *   1. which partner is registered, with which key, and is it active?
 *   2. what is queued for it, and where is each event in its delivery life
 *      (PENDING → DELIVERED, or FAILED with a backoff, or DEAD after the budget)?
 *   3. can I get an event unstuck (replay), drain now, or push the stock/HR
 *      snapshot the portal asked for?
 *
 * Field names come straight from `docs/contracts/partner-v1.md`; the parity
 * guard fails the build if the document and the code drift apart.
 */
interface IntegrationPartnersProps {
  currentUser: User | null;
}

interface PartnerForm {
  code: string;
  name: string;
  apiKeyId: string;
  contractVersion: string;
  allowedEvents: string;
  webhookUrl: string;
}

const EMPTY_FORM: PartnerForm = {
  code: '',
  name: '',
  apiKeyId: '',
  contractVersion: 'v1',
  allowedEvents: '',
  webhookUrl: '',
};

const statusStyles: Record<IntegrationPartnerStatus, string> = {
  ACTIVE:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  SUSPENDED:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
};

const deliveryStyles: Record<IntegrationOutboxRecord['status'], string> = {
  PENDING: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  DELIVERED:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  FAILED: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  DEAD: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The server answers every refusal with `{ code, message, retryable, details }`
 * (fetchJson keeps the parsed body on `error.body`). Showing only
 * `error.message` throws away the machine-readable code and whether a retry is
 * worth attempting, which is exactly what an operator needs to decide whether
 * to replay an event or leave it dead.
 */
export function describeApiFailure(err: any): string {
  const body = err?.body || {};
  const message = body.message || err?.message || 'The request failed.';
  const pieces: string[] = [];
  if (body.code) pieces.push(String(body.code));
  const retryable =
    typeof body.retryable === 'boolean' ? (body.retryable ? 'retryable' : 'not retryable') : '';
  if (retryable) pieces.push(retryable);
  if (body.details && Object.keys(body.details).length > 0) {
    pieces.push(JSON.stringify(body.details));
  }
  return pieces.length > 0 ? `${message} (${pieces.join(' · ')})` : message;
}

function parseEvents(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

export const IntegrationPartners: React.FC<IntegrationPartnersProps> = ({ currentUser }) => {
  const canAdminister = isOperationAllowed('admin-api-keys', currentUser?.role);
  const [partners, setPartners] = useState<IntegrationPartnerRecord[]>([]);
  const [outbox, setOutbox] = useState<IntegrationOutboxRecord[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<PartnerForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<IntegrationPartnerRecord | null>(null);
  const [editForm, setEditForm] = useState<PartnerForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [rowActionId, setRowActionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [partnerRows, outboxRows] = await Promise.all([
        api.getIntegrationPartners(),
        api.getIntegrationOutbox({ limit: 200 }),
      ]);
      setPartners(partnerRows);
      setOutbox(outboxRows);
    } catch (err: any) {
      setError(describeApiFailure(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!canAdminister) {
      setBusy(false);
      return;
    }
    void load();
  }, [canAdminister, load]);

  const selected = useMemo(
    () => partners.find((partner) => partner.code === selectedCode) ?? null,
    [partners, selectedCode]
  );

  const partnerOutbox = useMemo(() => {
    if (!selected) return [];
    return outbox.filter((entry) => entry.partner_code === selected.code);
  }, [outbox, selected]);

  const pendingTotal = useMemo(
    () => partners.reduce((sum, partner) => sum + Number(partner.pending_events || 0), 0),
    [partners]
  );

  if (!canAdminister) {
    return (
      <div className="py-16 text-center text-slate-500 dark:text-slate-400">
        <ShieldAlert className="mx-auto h-14 w-14 text-rose-500" />
        <h2 className="font-serif text-xl font-bold mt-3">Access Denied</h2>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed">
          You need the <strong>API Key Management</strong> permission to register an integration
          partner, read its delivery queue, or push a stock/HR snapshot. Contact your Super Admin to
          grant it.
        </p>
      </div>
    );
  }

  const submitCreate = async () => {
    setSaving(true);
    setError('');
    try {
      const created = await api.createIntegrationPartner({
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        apiKeyId: form.apiKeyId.trim() || null,
        contractVersion: form.contractVersion.trim() || 'v1',
        allowedEvents: parseEvents(form.allowedEvents),
        webhookUrl: form.webhookUrl.trim() || null,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setNotice(
        `Registered “${created.code}”. An API key is only accepted once it is bound to this partner.`
      );
      await load();
    } catch (err: any) {
      setError(describeApiFailure(err));
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (partner: IntegrationPartnerRecord) => {
    setEditing(partner);
    setEditForm({
      code: partner.code,
      name: partner.name,
      apiKeyId: partner.api_key_id || '',
      contractVersion: partner.contract_version,
      allowedEvents: (partner.allowed_events || []).join(', '),
      webhookUrl: '',
    });
  };

  const submitEdit = async () => {
    if (!editing) return;
    setSaving(true);
    setError('');
    try {
      await api.updateIntegrationPartner(editing.id, {
        name: editForm.name.trim(),
        allowedEvents: parseEvents(editForm.allowedEvents),
        webhookUrl: editForm.webhookUrl.trim() || null,
      });
      setNotice(`Updated “${editing.code}”.`);
      setEditing(null);
      await load();
    } catch (err: any) {
      setError(describeApiFailure(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (partner: IntegrationPartnerRecord) => {
    setRowActionId(partner.id);
    setError('');
    try {
      const next: IntegrationPartnerStatus = partner.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
      await api.updateIntegrationPartner(partner.id, { status: next });
      setNotice(
        next === 'ACTIVE'
          ? `“${partner.code}” is active; queued events can be delivered again.`
          : `“${partner.code}” is suspended; its ingest routes and deliveries stop.`
      );
      await load();
    } catch (err: any) {
      setError(describeApiFailure(err));
    } finally {
      setRowActionId(null);
    }
  };

  const replayEvent = async (entry: IntegrationOutboxRecord) => {
    setRowActionId(entry.id);
    setError('');
    try {
      await api.replayIntegrationOutbox(entry.id);
      setNotice(`Event ${entry.event} is queued for another delivery attempt.`);
      await load();
    } catch (err: any) {
      setError(describeApiFailure(err));
    } finally {
      setRowActionId(null);
    }
  };

  const drainQueue = async () => {
    setSaving(true);
    setError('');
    try {
      const outcome = await api.deliverIntegrationOutbox(20);
      setNotice(
        `Drained: ${outcome.delivered} delivered, ${outcome.failed} failed, ${outcome.skipped} skipped.`
      );
      await load();
    } catch (err: any) {
      setError(describeApiFailure(err));
    } finally {
      setSaving(false);
    }
  };

  const pushSnapshot = async (partner: IntegrationPartnerRecord, kind: 'stock' | 'hr') => {
    setRowActionId(`${partner.id}:${kind}`);
    setError('');
    try {
      const outcome =
        kind === 'stock'
          ? await api.pushIntegrationStock(partner.id, { limit: 200 })
          : await api.pushIntegrationHr(partner.id, { limit: 200 });
      setNotice(
        `Queued ${outcome.queued} ${kind === 'stock' ? 'stock' : 'HR'} event(s) for ${outcome.partner}.` +
          (outcome.nextCursor ? ` Next cursor: ${outcome.nextCursor}.` : '')
      );
      await load();
    } catch (err: any) {
      setError(describeApiFailure(err));
    } finally {
      setRowActionId(null);
    }
  };

  return (
    <div className="space-y-3">
      <PageHeader
        title="Integration Partners"
        description="The subscription portal posts customers, subscription periods and stock consumptions into this ERP, and receives signed events back. The portal owns subscriptions; this ERP owns receivables, stock and HR."
        icon={<PlugZap className="h-5 w-5 text-teal-600" />}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={load}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-xs transition-colors hover:bg-slate-50 disabled:opacity-60 cursor-pointer dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <RefreshCw className="h-4 w-4" />
              <span>Refresh</span>
            </button>
            <button
              onClick={drainQueue}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-xs transition-colors hover:bg-slate-50 disabled:opacity-60 cursor-pointer dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <ArrowDownToLine className="h-4 w-4" />
              <span>Drain queue</span>
            </button>
            <button
              onClick={() => {
                setForm(EMPTY_FORM);
                setCreateOpen(true);
              }}
              className="flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-1.5 text-xs font-bold text-white shadow-xs transition-colors hover:bg-teal-700 cursor-pointer"
            >
              <PlugZap className="h-4 w-4" />
              <span>Register partner</span>
            </button>
          </div>
        }
      />

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="font-medium">{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="font-medium">{notice}</span>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
            <PlugZap className="h-4 w-4 text-slate-400" />
            <span>
              {partners.length === 0
                ? 'No integration partner registered'
                : `${partners.length} partner${partners.length === 1 ? '' : 's'}`}
            </span>
            {pendingTotal > 0 && (
              <span className="rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
                {pendingTotal} queued
              </span>
            )}
          </div>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            An API key only works after it is bound here, and only for the branches in its scope.
          </span>
        </div>

        {busy && partners.length === 0 && (
          <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            Reading integration partners…
          </p>
        )}

        {!busy && partners.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <PlugZap className="h-8 w-8 text-teal-500" />
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              No partner is bound yet.
            </p>
            <p className="max-w-md text-[11px] text-slate-500 dark:text-slate-400">
              Register the subscription portal, bind the API key it will present, and its ingest
              calls start landing in the receivable, stock and HR paths.
            </p>
          </div>
        )}

        {partners.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="py-2 pr-3 font-bold">Partner</th>
                  <th className="py-2 pr-3 font-bold">Contract</th>
                  <th className="py-2 pr-3 font-bold">Key</th>
                  <th className="py-2 pr-3 font-bold">Queue</th>
                  <th className="py-2 pr-3 font-bold">Status</th>
                  <th className="py-2 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {partners.map((partner) => (
                  <tr
                    key={partner.id}
                    className={`border-b border-slate-50 align-top last:border-0 dark:border-slate-800/60 ${
                      selectedCode === partner.code ? 'bg-slate-50/70 dark:bg-slate-800/40' : ''
                    }`}
                  >
                    <td className="py-2.5 pr-3">
                      <button
                        onClick={() =>
                          setSelectedCode(selectedCode === partner.code ? null : partner.code)
                        }
                        className="text-left font-bold text-slate-800 hover:text-teal-700 cursor-pointer dark:text-slate-100 dark:hover:text-teal-300"
                      >
                        {partner.name}
                      </button>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        {partner.code}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                        since {formatDate(partner.created_at)}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-600 dark:text-slate-300">
                      {partner.contract_version}
                      <div
                        className="mt-0.5 max-w-[220px] truncate text-[10px] text-slate-400 dark:text-slate-500"
                        title={(partner.allowed_events || []).join(', ')}
                      >
                        {(partner.allowed_events || []).length === 0
                          ? 'every event allowed'
                          : (partner.allowed_events || []).join(', ')}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                      {partner.api_key_id ? `${partner.api_key_id.slice(0, 8)}…` : 'unbound'}
                    </td>
                    <td className="py-2.5 pr-3 text-[11px]">
                      <span className="text-slate-700 dark:text-slate-200">
                        {partner.pending_events} pending
                      </span>
                      {partner.dead_events > 0 && (
                        <div className="mt-0.5 font-bold text-rose-600 dark:text-rose-400">
                          {partner.dead_events} dead
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${statusStyles[partner.status]}`}
                      >
                        {partner.status}
                      </span>
                    </td>
                    <td className="py-2.5 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          onClick={() => openEdit(partner)}
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                        <button
                          onClick={() => toggleStatus(partner)}
                          disabled={rowActionId === partner.id}
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          {rowActionId === partner.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3 w-3" />
                          )}
                          {partner.status === 'ACTIVE' ? 'Suspend' : 'Enable'}
                        </button>
                        <button
                          onClick={() => pushSnapshot(partner, 'stock')}
                          disabled={rowActionId === `${partner.id}:stock`}
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          {rowActionId === `${partner.id}:stock` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Boxes className="h-3 w-3" />
                          )}
                          Push stock
                        </button>
                        <button
                          onClick={() => pushSnapshot(partner, 'hr')}
                          disabled={rowActionId === `${partner.id}:hr`}
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          {rowActionId === `${partner.id}:hr` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Users className="h-3 w-3" />
                          )}
                          Push HR
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
              <Send className="h-4 w-4 text-slate-400" />
              <span>Delivery queue — {selected.code}</span>
            </div>
            <span className="text-[10px] text-slate-500 dark:text-slate-400">
              A 2xx marks the event delivered; a failure backs off, and a spent attempt budget is
              DEAD until someone replays it.
            </span>
          </div>

          {partnerOutbox.length === 0 && (
            <p className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
              Nothing has been queued for this partner yet.
            </p>
          )}

          {partnerOutbox.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="py-2 pr-3 font-bold">Event</th>
                    <th className="py-2 pr-3 font-bold">Entity</th>
                    <th className="py-2 pr-3 font-bold">Status</th>
                    <th className="py-2 pr-3 font-bold">Attempts</th>
                    <th className="py-2 pr-3 font-bold">Next attempt</th>
                    <th className="py-2 pr-3 font-bold">Delivered</th>
                    <th className="py-2 text-right font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {partnerOutbox.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-slate-50 align-top last:border-0 dark:border-slate-800/60"
                    >
                      <td className="py-2.5 pr-3">
                        <div className="font-bold text-slate-800 dark:text-slate-100">
                          {entry.event}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                          queued {formatDate(entry.created_at)}
                        </div>
                        {entry.last_error && (
                          <div className="mt-0.5 max-w-[320px] text-[10px] text-rose-600 dark:text-rose-400">
                            {entry.last_error}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-[11px] text-slate-600 dark:text-slate-300">
                        {entry.entity}
                        {entry.entity_id && (
                          <div className="font-mono text-[10px] text-slate-400 dark:text-slate-500">
                            {entry.entity_id}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${deliveryStyles[entry.status]}`}
                        >
                          {entry.status}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-[11px] text-slate-600 dark:text-slate-300">
                        {entry.attempts}
                      </td>
                      <td className="py-2.5 pr-3 text-[11px] text-slate-600 dark:text-slate-300">
                        {entry.status === 'DEAD' ? '—' : formatDate(entry.next_attempt_at)}
                      </td>
                      <td className="py-2.5 pr-3 text-[11px] text-slate-600 dark:text-slate-300">
                        {formatDate(entry.delivered_at)}
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          onClick={() => replayEvent(entry)}
                          disabled={
                            rowActionId === entry.id ||
                            (entry.status !== 'FAILED' && entry.status !== 'DEAD')
                          }
                          title={
                            entry.status === 'FAILED' || entry.status === 'DEAD'
                              ? 'Queue this event for another delivery attempt'
                              : 'Only a failed or dead event can be replayed'
                          }
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          {rowActionId === entry.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3 w-3" />
                          )}
                          Replay
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4">
          <ModalPanel
            label="Register integration partner"
            onClose={() => setCreateOpen(false)}
            className="mt-6 w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h3 className="font-serif text-base font-bold text-slate-900 dark:text-white">
              Register a partner
            </h3>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              The code is the identity the partner sends; the key id must already exist on the API
              Creator screen.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Code
                <input
                  value={form.code}
                  onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
                  placeholder="SUBSPORTAL"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Name
                <input
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Subscription Portal"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                API key id (UUID)
                <input
                  value={form.apiKeyId}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, apiKeyId: event.target.value }))
                  }
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-[11px] font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Contract version
                <input
                  value={form.contractVersion}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, contractVersion: event.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300 sm:col-span-2">
                Webhook URL (where signed events are delivered)
                <input
                  value={form.webhookUrl}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, webhookUrl: event.target.value }))
                  }
                  placeholder="https://portal.example.com/hooks/isp"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300 sm:col-span-2">
                Allowed events (comma separated, blank = every event)
                <input
                  value={form.allowedEvents}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, allowedEvents: event.target.value }))
                  }
                  placeholder="inventory.stock_changed, hr.employee_updated"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setCreateOpen(false)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 dark:border-slate-700 dark:text-slate-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={submitCreate}
                disabled={saving || form.code.trim().length < 2 || form.name.trim().length < 2}
                className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 cursor-pointer"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Register partner
              </button>
            </div>
          </ModalPanel>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4">
          <ModalPanel
            label="Edit integration partner"
            onClose={() => setEditing(null)}
            className="mt-6 w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h3 className="font-serif text-base font-bold text-slate-900 dark:text-white">
              Edit “{editing.code}”
            </h3>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Leaving the webhook URL blank keeps the stored target; enable/disable is its own
              action on the row.
            </p>
            <div className="mt-4 grid gap-3">
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Name
                <input
                  value={editForm.name}
                  onChange={(event) =>
                    setEditForm((prev) => ({ ...prev, name: event.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Webhook URL
                <input
                  value={editForm.webhookUrl}
                  onChange={(event) =>
                    setEditForm((prev) => ({ ...prev, webhookUrl: event.target.value }))
                  }
                  placeholder="leave blank to keep the stored target"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Allowed events (comma separated)
                <input
                  value={editForm.allowedEvents}
                  onChange={(event) =>
                    setEditForm((prev) => ({ ...prev, allowedEvents: event.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 dark:border-slate-700 dark:text-slate-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={submitEdit}
                disabled={saving || editForm.name.trim().length < 2}
                className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 cursor-pointer"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save changes
              </button>
            </div>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default IntegrationPartners;
