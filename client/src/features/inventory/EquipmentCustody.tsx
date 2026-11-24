/**
 * Equipment custody — the branch-wide answer to "who holds what".
 *
 * The per-employee panel (`EmployeeStockPanel`) is mounted on one person's
 * profile; this is the register a branch manager works from: every recorded
 * holding in their branches, plus the two movements that move custody between
 * people — issuing units out of branch stock and transferring them from one
 * holder to another.
 *
 * Nothing here talks to the server any other way: holdings and the roster it
 * picks people from come from `employee-stock-view`, and both writes go through
 * the same `/api/employee-stock` routes the panel and the phone use. The server
 * re-checks every branch predicate and refusal, so the screen's job is to show
 * what it answers — including the cross-branch refusal, whose message carries
 * the return-then-issue remedy — instead of a generic failure.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeftRight, ArrowUpFromLine, Loader2, PackageSearch, RefreshCw } from 'lucide-react';
import { api } from '../../services/api';
import type { CustodyEmployee, EmployeeStockHolding } from '../../services/api';
import type { Product, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { loadUserSession } from '../../utils/sessionCache';

interface EquipmentCustodyProps {
  currentUser?: User | null;
  selectedBranchId?: string;
  products?: Product[];
}

interface Refusal {
  code: string | null;
  message: string;
}

const CROSS_BRANCH_HINT =
  'Custody cannot jump between branches in one step. Return the units to the branch that holds them, then issue them from the branch that wants them.';

const panelClass =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const inputClass =
  'mt-1 h-9 w-full rounded-lg border border-slate-300 bg-transparent px-2.5 text-xs dark:border-slate-700';
const primaryButton =
  'flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white';
const ghostButton =
  'flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const okBox =
  'rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300';

const refusalOf = (err: any): Refusal => ({
  code: typeof err?.body?.code === 'string' ? err.body.code : null,
  message: String(err?.message || 'The server refused the request.'),
});

const stampOf = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export const EquipmentCustody: React.FC<EquipmentCustodyProps> = ({
  currentUser,
  selectedBranchId,
  products,
}) => {
  const session = loadUserSession();
  const role = currentUser?.role || session?.currentUser?.role || '';
  const canView = isOperationAllowed('employee-stock-view', role);
  const canMove = isOperationAllowed('stock-out', role);

  const [holdings, setHoldings] = useState<EmployeeStockHolding[]>([]);
  const [roster, setRoster] = useState<CustodyEmployee[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<Refusal | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [notice, setNotice] = useState('');
  const [writeError, setWriteError] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const [issueForm, setIssueForm] = useState({ employeeId: '', productId: '', quantity: '1', reason: '' });
  const [transferForm, setTransferForm] = useState({
    fromEmployeeId: '',
    toEmployeeId: '',
    productId: '',
    quantity: '1',
    reason: '',
  });

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [nextHoldings, nextRoster] = await Promise.all([
        api.getEmployeeStockHoldings({}),
        api.getCustodyEmployees(),
      ]);
      setHoldings(Array.isArray(nextHoldings) ? nextHoldings : []);
      setRoster(Array.isArray(nextRoster) ? nextRoster : []);
    } catch (err) {
      setLoadError(refusalOf(err));
      setHoldings([]);
      setRoster([]);
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const employeeLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of roster) map.set(person.id, `${person.name}${person.employee_code ? ` (${person.employee_code})` : ''}`);
    for (const holding of holdings) {
      if (!map.has(holding.employee_id)) map.set(holding.employee_id, holding.employee_name || holding.employee_id);
    }
    return map;
  }, [roster, holdings]);

  const holders = useMemo(() => new Set(holdings.map((row) => row.employee_id)).size, [holdings]);
  const units = useMemo(() => holdings.reduce((sum, row) => sum + Number(row.quantity || 0), 0), [holdings]);
  const productList = useMemo(() => (Array.isArray(products) ? products : []), [products]);

  const startTransfer = (row: EmployeeStockHolding) => {
    setWriteError(null);
    setNotice('');
    setTransferForm((prev) => ({
      ...prev,
      fromEmployeeId: row.employee_id,
      productId: row.product_id,
      quantity: String(row.quantity),
      toEmployeeId: prev.toEmployeeId === row.employee_id ? '' : prev.toEmployeeId,
    }));
  };

  const submitIssue = async () => {
    setWriteError(null);
    setNotice('');
    if (!issueForm.employeeId || !issueForm.productId) {
      setWriteError({ code: null, message: 'Pick the person receiving the units and the product they are getting.' });
      return;
    }
    const quantity = Number(issueForm.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setWriteError({ code: null, message: 'The quantity must be a whole number of units above zero.' });
      return;
    }
    setBusy(true);
    try {
      await api.recordEmployeeStockMovement('issue', {
        employeeId: issueForm.employeeId,
        productId: issueForm.productId,
        quantity,
        reason: issueForm.reason.trim() || undefined,
      });
      setNotice(
        `Issued ${quantity} unit${quantity === 1 ? '' : 's'} to ${employeeLabel.get(issueForm.employeeId) || issueForm.employeeId}.`
      );
      setIssueForm((prev) => ({ ...prev, productId: '', quantity: '1', reason: '' }));
      await load();
    } catch (err) {
      setWriteError(refusalOf(err));
    } finally {
      setBusy(false);
    }
  };

  const submitTransfer = async () => {
    setWriteError(null);
    setNotice('');
    if (!transferForm.fromEmployeeId || !transferForm.toEmployeeId || !transferForm.productId) {
      setWriteError({ code: null, message: 'Pick who is handing over, who receives, and which product moves.' });
      return;
    }
    if (transferForm.fromEmployeeId === transferForm.toEmployeeId) {
      setWriteError({ code: null, message: 'The holder and the receiver must be two different people.' });
      return;
    }
    if (!transferForm.reason.trim()) {
      setWriteError({ code: null, message: 'A transfer needs a reason — say why custody is moving.' });
      return;
    }
    const quantity = Number(transferForm.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setWriteError({ code: null, message: 'The quantity must be a whole number of units above zero.' });
      return;
    }
    setBusy(true);
    try {
      await api.transferEmployeeStock({
        fromEmployeeId: transferForm.fromEmployeeId,
        toEmployeeId: transferForm.toEmployeeId,
        productId: transferForm.productId,
        quantity,
        reason: transferForm.reason.trim(),
      });
      setNotice(
        `Transferred ${quantity} unit${quantity === 1 ? '' : 's'} from ${
          employeeLabel.get(transferForm.fromEmployeeId) || transferForm.fromEmployeeId
        } to ${employeeLabel.get(transferForm.toEmployeeId) || transferForm.toEmployeeId}.`
      );
      setTransferForm((prev) => ({ ...prev, productId: '', quantity: '1', reason: '' }));
      await load();
    } catch (err) {
      setWriteError(refusalOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (!canView) {
    return (
      <section className="space-y-3">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Equipment custody</h1>
        <div className={errorBox}>
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>Your role cannot read equipment custody. Ask an administrator for the employee stock view.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Equipment custody</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Who holds what across this branch — every issued unit, and the record of it moving between people.
          </p>
        </div>
        <button className={ghostButton} onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className={panelClass}>
          <p className={labelClass}>Holdings</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-800 dark:text-slate-100">{holdings.length}</p>
        </div>
        <div className={panelClass}>
          <p className={labelClass}>People holding equipment</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-800 dark:text-slate-100">{holders}</p>
        </div>
        <div className={panelClass}>
          <p className={labelClass}>Units in the field</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-800 dark:text-slate-100">{units}</p>
        </div>
      </div>

      {notice && <div role="status" className={okBox}>{notice}</div>}
      {loadError && (
        <div role="alert" className={errorBox}>
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>
            {loadError.code ? <span className="mr-1 font-mono">[{loadError.code}]</span> : null}
            {loadError.message}
          </span>
        </div>
      )}
      {writeError && (
        <div role="alert" className={errorBox}>
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>
            {writeError.code ? <span className="mr-1 font-mono">[{writeError.code}]</span> : null}
            {writeError.message}
            {writeError.code === 'CROSS_BRANCH_TRANSFER' && (
              <span className="mt-1 block font-normal">{CROSS_BRANCH_HINT}</span>
            )}
          </span>
        </div>
      )}

      <div className={panelClass}>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Who holds what</p>
        {loading && holdings.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 size={13} className="animate-spin" /> Loading custody…
          </p>
        ) : holdings.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-slate-500">
            <PackageSearch size={14} /> Nobody in this branch holds stock right now.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-2 py-1 font-semibold">Holder</th>
                  <th className="px-2 py-1 font-semibold">Product</th>
                  <th className="px-2 py-1 font-semibold">Branch</th>
                  <th className="px-2 py-1 text-right font-semibold">Qty</th>
                  <th className="px-2 py-1 font-semibold">Last movement</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {holdings.map((row) => (
                  <tr
                    key={`${row.employee_id}-${row.product_id}`}
                    className="border-t border-slate-100 dark:border-slate-800"
                  >
                    <td className="px-2 py-1.5">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{row.employee_name}</span>
                      {row.employee_code && (
                        <span className="ml-1 font-mono text-[10px] text-slate-400">{row.employee_code}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {row.product_name}
                      {row.product_code && (
                        <span className="ml-1 font-mono text-[10px] text-slate-400">{row.product_code}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-slate-500">{row.branch_name || row.branch_id}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{row.quantity}</td>
                    <td className="px-2 py-1.5 text-slate-500">{stampOf(row.updated_at)}</td>
                    <td className="px-2 py-1.5 text-right">
                      {canMove && (
                        <button className="font-semibold text-sky-700" onClick={() => startTransfer(row)}>
                          Transfer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={panelClass}>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <ArrowUpFromLine size={13} /> Issue stock to a person
          </p>
          {!canMove ? (
            <p className="text-xs text-slate-500">Issuing moves stock out of the branch; your role cannot do that.</p>
          ) : (
            <div className="space-y-2">
              <label className="block">
                <span className={labelClass}>To</span>
                <select
                  className={inputClass}
                  value={issueForm.employeeId}
                  onChange={(event) => setIssueForm((prev) => ({ ...prev, employeeId: event.target.value }))}
                >
                  <option value="">Select a person…</option>
                  {roster.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                      {person.employee_code ? ` (${person.employee_code})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>Product</span>
                <select
                  className={inputClass}
                  value={issueForm.productId}
                  onChange={(event) => setIssueForm((prev) => ({ ...prev, productId: event.target.value }))}
                >
                  <option value="">Select a product…</option>
                  {productList.map((product) => (
                    <option key={String(product.id)} value={String(product.id)}>
                      {product.name}
                      {product.sku ? ` (${product.sku})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={labelClass}>Quantity</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={issueForm.quantity}
                    onChange={(event) => setIssueForm((prev) => ({ ...prev, quantity: event.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Reason (optional)</span>
                  <input
                    className={inputClass}
                    value={issueForm.reason}
                    placeholder="e.g. new install kit"
                    onChange={(event) => setIssueForm((prev) => ({ ...prev, reason: event.target.value }))}
                  />
                </label>
              </div>
              <div className="flex justify-end">
                <button className={primaryButton} onClick={() => void submitIssue()} disabled={busy}>
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpFromLine size={13} />}
                  Issue units
                </button>
              </div>
            </div>
          )}
        </div>

        <div className={panelClass}>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <ArrowLeftRight size={13} /> Transfer custody
          </p>
          {!canMove ? (
            <p className="text-xs text-slate-500">Transfers move units between people; your role cannot do that.</p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={labelClass}>From holder</span>
                  <select
                    className={inputClass}
                    value={transferForm.fromEmployeeId}
                    onChange={(event) => setTransferForm((prev) => ({ ...prev, fromEmployeeId: event.target.value }))}
                  >
                    <option value="">Select the holder…</option>
                    {holdings.map((row) => (
                      <option key={`${row.employee_id}-${row.product_id}`} value={row.employee_id}>
                        {row.employee_name} · {row.product_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={labelClass}>To receiver</span>
                  <select
                    className={inputClass}
                    value={transferForm.toEmployeeId}
                    onChange={(event) => setTransferForm((prev) => ({ ...prev, toEmployeeId: event.target.value }))}
                  >
                    <option value="">Select the receiver…</option>
                    {roster.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                        {person.employee_code ? ` (${person.employee_code})` : ''}
                        {person.branch_id !== session?.currentUser?.branchId ? ` · branch ${person.branch_id}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className={labelClass}>Product to move</span>
                <select
                  className={inputClass}
                  value={transferForm.productId}
                  onChange={(event) => setTransferForm((prev) => ({ ...prev, productId: event.target.value }))}
                >
                  <option value="">Select a product…</option>
                  {holdings.map((row) => (
                    <option key={`${row.employee_id}-${row.product_id}`} value={row.product_id}>
                      {row.product_name} · held by {row.employee_name} ({row.quantity})
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={labelClass}>Quantity</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={transferForm.quantity}
                    onChange={(event) => setTransferForm((prev) => ({ ...prev, quantity: event.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Reason</span>
                  <input
                    className={inputClass}
                    value={transferForm.reason}
                    placeholder="Why custody moves"
                    onChange={(event) => setTransferForm((prev) => ({ ...prev, reason: event.target.value }))}
                  />
                </label>
              </div>
              <div className="flex justify-end">
                <button className={primaryButton} onClick={() => void submitTransfer()} disabled={busy}>
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowLeftRight size={13} />}
                  Transfer units
                </button>
              </div>
              <p className="text-[10px] text-slate-400">
                A transfer stays inside one branch. Handing units to someone in another branch is a return to the
                source branch followed by an issue from the receiving one.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

export default EquipmentCustody;
