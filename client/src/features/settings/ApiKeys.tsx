import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  History,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { Branch, User } from '../../types';
import { api } from '../../services/api';
import type { ApiKeyAuditEntry, ApiKeyRecord } from '../../services/api/admin';
import { isOperationAllowed } from '../../utils/permissions';
import { PageHeader } from '../../components/common/PageHeader';
import { ModalPanel } from '../../components/common/ModalPanel';
import { DEFAULT_GROUPS } from './permissionGroups';

/**
 * API Creator — the screen a Super Admin or Sub Super Admin uses to give a
 * partner application a scoped, expiring, revocable key.
 *
 * The plaintext key is shown exactly once, in the issue/rotate panel; the list
 * only ever shows the prefix, and no response from this screen can recover a
 * lost secret. Scope is an explicit operation list plus a read-only switch: the
 * switch refuses every non-GET server-side before RBAC runs, so a read-only key
 * cannot write even where one operation name guards both verbs.
 */
interface ApiKeysProps {
  currentUser: User | null;
  branches: Branch[];
}

interface CreateForm {
  name: string;
  description: string;
  operations: string[];
  readOnly: boolean;
  branchIds: string[];
  expiresInDays: string;
  rpmLimit: string;
}

const EMPTY_FORM: CreateForm = {
  name: '',
  description: '',
  operations: [],
  readOnly: true,
  branchIds: [],
  expiresInDays: '90',
  rpmLimit: '',
};

const statusStyles: Record<ApiKeyRecord['status'], string> = {
  Active: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  Expiring: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  Expired: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  Revoked: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const ApiKeys: React.FC<ApiKeysProps> = ({ currentUser, branches }) => {
  const canAdminister = isOperationAllowed('admin-api-keys', currentUser?.role);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [secretPanel, setSecretPanel] = useState<{ secret: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmAction, setConfirmAction] = useState<{ kind: 'rotate' | 'revoke'; key: ApiKeyRecord } | null>(null);
  const [graceHours, setGraceHours] = useState('24');
  const [logs, setLogs] = useState<{ key: ApiKeyRecord; entries: ApiKeyAuditEntry[] } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setKeys(await api.getApiKeys());
    } catch (err: any) {
      setError(err?.message || 'Could not read the API keys.');
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

  const branchName = useMemo(() => {
    const map = new Map(branches.map((branch) => [branch.id, branch.name]));
    return (id: string) => map.get(id) || id;
  }, [branches]);

  if (!canAdminister) {
    return (
      <div className="py-16 text-center text-slate-500 dark:text-slate-400">
        <ShieldAlert className="mx-auto h-14 w-14 text-rose-500" />
        <h2 className="font-serif text-xl font-bold mt-3">Access Denied</h2>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed">
          You need the <strong>API Key Management</strong> permission to issue, rotate or revoke partner
          keys. Contact your Super Admin to grant it.
        </p>
      </div>
    );
  }

  const toggleOperation = (id: string) => {
    setForm((prev) => ({
      ...prev,
      operations: prev.operations.includes(id)
        ? prev.operations.filter((operation) => operation !== id)
        : [...prev.operations, id],
    }));
  };

  const toggleGroup = (groupOperations: string[]) => {
    setForm((prev) => {
      const allSelected = groupOperations.every((id) => prev.operations.includes(id));
      return {
        ...prev,
        operations: allSelected
          ? prev.operations.filter((id) => !groupOperations.includes(id))
          : Array.from(new Set([...prev.operations, ...groupOperations])),
      };
    });
  };

  const toggleBranch = (id: string) => {
    setForm((prev) => ({
      ...prev,
      branchIds: prev.branchIds.includes(id)
        ? prev.branchIds.filter((branch) => branch !== id)
        : [...prev.branchIds, id],
    }));
  };

  const submitCreate = async () => {
    setSaving(true);
    setError('');
    try {
      const issued = await api.createApiKey({
        name: form.name,
        description: form.description,
        operations: form.operations,
        readOnly: form.readOnly,
        branchIds: form.branchIds,
        expiresInDays: form.expiresInDays.trim() ? Number(form.expiresInDays) : null,
        rpmLimit: form.rpmLimit.trim() ? Number(form.rpmLimit) : null,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setSecretPanel({ secret: issued.secret, name: issued.key.name });
      setNotice(`Issued “${issued.key.name}”. Copy the key now — it is never shown again.`);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not issue the API key.');
    } finally {
      setSaving(false);
    }
  };

  const runConfirm = async () => {
    if (!confirmAction) return;
    setSaving(true);
    setError('');
    try {
      if (confirmAction.kind === 'rotate') {
        const issued = await api.rotateApiKey(confirmAction.key.id, Number(graceHours) || 0);
        setSecretPanel({ secret: issued.secret, name: issued.key.name });
        setNotice(`Rotated “${issued.key.name}”. The old key expires in ${Number(graceHours) || 0}h.`);
      } else {
        await api.revokeApiKey(confirmAction.key.id);
        setNotice(`Revoked “${confirmAction.key.name}”. Every request with it now fails.`);
      }
      setConfirmAction(null);
      await load();
    } catch (err: any) {
      setError(err?.message || 'The action failed.');
    } finally {
      setSaving(false);
    }
  };

  const openLogs = async (key: ApiKeyRecord) => {
    setError('');
    try {
      setLogs({ key, entries: await api.getApiKeyLogs(key.id) });
    } catch (err: any) {
      setError(err?.message || 'Could not read the key audit trail.');
    }
  };

  const copySecret = async () => {
    if (!secretPanel) return;
    try {
      await navigator.clipboard.writeText(secretPanel.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy failed — select the key text and copy it manually.');
    }
  };

  return (
    <div className="space-y-3">
      <PageHeader
        title="API Creator"
        description="Scoped, expiring, revocable keys for partner applications. A key acts on the operations you grant, never as a Super Admin, and the plaintext is shown once."
        icon={<KeyRound className="h-5 w-5 text-teal-600" />}
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
              onClick={() => {
                setForm(EMPTY_FORM);
                setCreateOpen(true);
              }}
              className="flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-1.5 text-xs font-bold text-white shadow-xs transition-colors hover:bg-teal-700 cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>Issue API key</span>
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
            <ShieldCheck className="h-4 w-4 text-slate-400" />
            <span>{keys.length === 0 ? 'No API keys issued' : `${keys.length} key${keys.length === 1 ? '' : 's'}`}</span>
          </div>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            Only the SHA-256 hash of each secret is stored. Revocation takes effect on the next request.
          </span>
        </div>

        {busy && keys.length === 0 && (
          <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">Reading API keys…</p>
        )}

        {!busy && keys.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <KeyRound className="h-8 w-8 text-teal-500" />
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">No partner has a key yet.</p>
            <p className="max-w-md text-[11px] text-slate-500 dark:text-slate-400">
              Issue one, give the partner only the printed secret, and revoke it here the moment access should end.
            </p>
          </div>
        )}

        {keys.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="py-2 pr-3 font-bold">Key</th>
                  <th className="py-2 pr-3 font-bold">Scope</th>
                  <th className="py-2 pr-3 font-bold">Branches</th>
                  <th className="py-2 pr-3 font-bold">Expires</th>
                  <th className="py-2 pr-3 font-bold">Last used</th>
                  <th className="py-2 pr-3 font-bold">Status</th>
                  <th className="py-2 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className="border-b border-slate-50 align-top last:border-0 dark:border-slate-800/60">
                    <td className="py-2.5 pr-3">
                      <div className="font-bold text-slate-800 dark:text-slate-100">{key.name}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        isp_live_{key.prefix}_…
                      </div>
                      {key.rotatedFrom && (
                        <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">rotated from an earlier key</div>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">
                        {key.readOnly ? 'Read-only' : 'Read & write'}
                      </span>
                      <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                        {key.operations.length} operation{key.operations.length === 1 ? '' : 's'}
                      </div>
                      <div className="mt-0.5 max-w-[240px] truncate text-[10px] text-slate-400 dark:text-slate-500" title={key.operations.join(', ')}>
                        {key.operations.join(', ')}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-600 dark:text-slate-300">
                      {key.branchIds.length === 0 ? 'All branches' : key.branchIds.map(branchName).join(', ')}
                    </td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-600 dark:text-slate-300">{formatDate(key.expiresAt)}</td>
                    <td className="py-2.5 pr-3 text-[11px] text-slate-600 dark:text-slate-300">
                      {formatDate(key.lastUsedAt)}
                      {key.lastUsedIp && <div className="text-[10px] text-slate-400">{key.lastUsedIp}</div>}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${statusStyles[key.status]}`}>
                        {key.status}
                      </span>
                    </td>
                    <td className="py-2.5 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          onClick={() => openLogs(key)}
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <History className="h-3 w-3" /> Log
                        </button>
                        <button
                          onClick={() => {
                            setGraceHours('24');
                            setConfirmAction({ kind: 'rotate', key });
                          }}
                          disabled={!key.isActive}
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <RotateCw className="h-3 w-3" /> Rotate
                        </button>
                        <button
                          onClick={() => setConfirmAction({ kind: 'revoke', key })}
                          disabled={!key.isActive}
                          className="flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-[10px] font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40 cursor-pointer"
                        >
                          <Trash2 className="h-3 w-3" /> Revoke
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

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4">
          <ModalPanel
            label="Issue API key"
            onClose={() => setCreateOpen(false)}
            className="mt-6 w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h3 className="font-serif text-base font-bold text-slate-900 dark:text-white">Issue a partner API key</h3>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              The secret is generated server-side and shown once after you create the key.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Name
                <input
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Partner ledger feed"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Description
                <input
                  value={form.description}
                  onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                  placeholder="Reads the trial balance for reconciliation"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Expires in (days, blank = never)
                <input
                  value={form.expiresInDays}
                  onChange={(event) => setForm((prev) => ({ ...prev, expiresInDays: event.target.value }))}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Requests per minute (blank = unlimited)
                <input
                  value={form.rpmLimit}
                  onChange={(event) => setForm((prev) => ({ ...prev, rpmLimit: event.target.value }))}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
            </div>

            <label className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 p-2.5 text-[11px] dark:border-slate-700">
              <input
                type="checkbox"
                checked={form.readOnly}
                onChange={(event) => setForm((prev) => ({ ...prev, readOnly: event.target.checked }))}
                className="mt-0.5"
              />
              <span className="text-slate-600 dark:text-slate-300">
                <strong className="text-slate-800 dark:text-slate-100">Read-only</strong> — refuse every non-GET request
                before permission checks run. Leave unchecked only when the partner must write.
              </span>
            </label>

            <div className="mt-3">
              <div className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Branches <span className="font-normal text-slate-400">(none selected = all branches)</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {branches.map((branch) => (
                  <button
                    key={branch.id}
                    type="button"
                    onClick={() => toggleBranch(branch.id)}
                    className={`rounded-lg border px-2 py-1 text-[10px] font-bold cursor-pointer ${
                      form.branchIds.includes(branch.id)
                        ? 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300'
                        : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {branch.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 max-h-64 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              <div className="mb-1 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Operations ({form.operations.length} selected)
              </div>
              {DEFAULT_GROUPS.map((group) => (
                <div key={group.id} className="border-t border-slate-100 py-1.5 first:border-0 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.operations.map((operation) => operation.id))}
                    className="text-[10px] font-bold uppercase tracking-wide text-slate-500 hover:text-teal-700 dark:text-slate-400 cursor-pointer"
                  >
                    {group.category}
                  </button>
                  <div className="mt-1 grid gap-1 sm:grid-cols-2">
                    {group.operations.map((operation) => (
                      <label key={operation.id} className="flex items-start gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={form.operations.includes(operation.id)}
                          onChange={() => toggleOperation(operation.id)}
                          className="mt-0.5"
                        />
                        <span>{operation.operationName}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
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
                disabled={saving || form.name.trim().length < 2 || form.operations.length === 0}
                className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 cursor-pointer"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create key
              </button>
            </div>
          </ModalPanel>
        </div>
      )}

      {secretPanel && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4">
          <ModalPanel
            label="Your new API key"
            onClose={() => setSecretPanel(null)}
            className="mt-16 w-full max-w-xl rounded-2xl border border-amber-200 bg-white p-5 shadow-2xl dark:border-amber-900 dark:bg-slate-900"
          >
            <h3 className="flex items-center gap-2 font-serif text-base font-bold text-slate-900 dark:text-white">
              <ShieldAlert className="h-5 w-5 text-amber-500" /> Copy this key now
            </h3>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              “{secretPanel.name}” — this is the only time the secret is shown. The database stores only its hash.
            </p>
            <div className="mt-3 break-all rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
              {secretPanel.secret}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={copySecret}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 dark:border-slate-700 dark:text-slate-200 cursor-pointer"
              >
                {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={() => setSecretPanel(null)}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white dark:bg-slate-100 dark:text-slate-900 cursor-pointer"
              >
                I have copied it
              </button>
            </div>
          </ModalPanel>
        </div>
      )}

      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4">
          <ModalPanel
            label={confirmAction.kind === 'rotate' ? 'Rotate API key' : 'Revoke API key'}
            onClose={() => setConfirmAction(null)}
            className="mt-24 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h3 className="font-serif text-base font-bold text-slate-900 dark:text-white">
              {confirmAction.kind === 'rotate' ? 'Rotate' : 'Revoke'} “{confirmAction.key.name}”?
            </h3>
            {confirmAction.kind === 'rotate' ? (
              <>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  A new secret is issued with the same scope. The current key keeps working during the grace period,
                  then expires.
                </p>
                <label className="mt-3 block text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  Grace period (hours)
                  <input
                    value={graceHours}
                    onChange={(event) => setGraceHours(event.target.value)}
                    inputMode="numeric"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-normal dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </label>
              </>
            ) : (
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Every request with this key fails immediately. This cannot be undone — issue a new key instead.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmAction(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 dark:border-slate-700 dark:text-slate-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={runConfirm}
                disabled={saving}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 cursor-pointer ${
                  confirmAction.kind === 'revoke' ? 'bg-rose-600' : 'bg-teal-600'
                }`}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {confirmAction.kind === 'rotate' ? 'Rotate key' : 'Revoke key'}
              </button>
            </div>
          </ModalPanel>
        </div>
      )}

      {logs && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4">
          <ModalPanel
            label="API key audit trail"
            onClose={() => setLogs(null)}
            className="mt-16 w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h3 className="font-serif text-base font-bold text-slate-900 dark:text-white">
              Audit trail — {logs.key.name}
            </h3>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Creation, rotation and revocation. The log is append-only in the database.
            </p>
            <div className="mt-3 max-h-80 overflow-y-auto">
              {logs.entries.length === 0 && <p className="py-4 text-center text-xs text-slate-500">No entries.</p>}
              {logs.entries.map((entry) => (
                <div key={entry.id} className="border-b border-slate-100 py-2 text-[11px] last:border-0 dark:border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-bold text-slate-800 dark:text-slate-100">{entry.action}</span>
                    <span className="text-slate-500 dark:text-slate-400">{formatDate(entry.created_at)}</span>
                  </div>
                  <div className="text-slate-500 dark:text-slate-400">
                    {entry.actor_email || entry.actor}
                    {entry.ip ? ` · ${entry.ip}` : ''}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setLogs(null)}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white dark:bg-slate-100 dark:text-slate-900 cursor-pointer"
              >
                Close
              </button>
            </div>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default ApiKeys;
