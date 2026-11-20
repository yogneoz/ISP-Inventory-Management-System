/**
 * Employee stock custody panel — "My Stock" for the technician and "Equipment
 * held" on an employee profile.
 *
 * The employee id is a prop (self-service knows its own record, the profile
 * dialog knows the person it is editing); everything else — the signed-in role
 * and its permission matrix — is read here rather than plumbed from App, so a
 * new mount point costs one prop.
 *
 * Reads are `employee-stock-view`; the four movements reuse the inventory
 * controls they are, so the action picker only offers what the caller may do.
 * The server re-checks every one of them, and refuses a return or a loss larger
 * than the person actually holds (409) rather than going negative.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, Loader2, PackageSearch, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import type { EmployeeStockHolding, EmployeeStockMovement, EmployeeStockMovementType } from '../../services/api';
import type { Product, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { loadUserSession } from '../../utils/sessionCache';

type Action = 'issue' | 'return' | 'consume' | 'loss';

interface EmployeeStockPanelProps {
  employeeId: string;
  employeeName?: string;
  /** The signed-in account, when the caller already has it (self-service). */
  currentUser?: User | null;
  /** Self-service wording: "your van" instead of the person's name. */
  self?: boolean;
}

const panel =
  'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40';
const errorBox =
  'flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300';
const okBox =
  'rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const inputClass =
  'mt-1 h-9 w-full rounded-lg border border-slate-300 bg-transparent px-2.5 text-xs dark:border-slate-700';
const ghostButton =
  'flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';
const primaryButton =
  'flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white';

const ACTION_LABELS: Record<Action, string> = {
  issue: 'Issue to employee',
  return: 'Return to branch',
  consume: 'Consume on job',
  loss: 'Record loss',
};

const MOVEMENT_LABELS: Record<EmployeeStockMovementType, string> = {
  ISSUE: 'Issued',
  RETURN: 'Returned',
  CONSUME: 'Consumed',
  TRANSFER: 'Transferred',
  LOSS: 'Lost',
};

const stamp = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export const EmployeeStockPanel: React.FC<EmployeeStockPanelProps> = ({ employeeId, employeeName, currentUser, self }) => {
  const user = useMemo<User | null>(() => currentUser || loadUserSession().currentUser, [currentUser]);

  const canView = isOperationAllowed('employee-stock-view', user?.role);
  const allowedActions = useMemo(() => {
    const actions: Action[] = [];
    if (isOperationAllowed('stock-out', user?.role)) actions.push('issue', 'loss');
    if (isOperationAllowed('consumable-issue-reverse', user?.role)) actions.push('return', 'consume');
    return actions;
  }, [user?.role]);

  const [holdings, setHoldings] = useState<EmployeeStockHolding[]>([]);
  const [movements, setMovements] = useState<EmployeeStockMovement[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [action, setAction] = useState<Action>('issue');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [rows, log] = await Promise.all([
        api.getEmployeeStockHoldings({ employeeId }),
        api.getEmployeeStockMovements(employeeId, 20),
      ]);
      setHoldings(rows);
      setMovements(log);
    } catch (err: any) {
      setError(err?.message || 'Could not read the custody ledger.');
    } finally {
      setLoading(false);
    }
  }, [canView, employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (allowedActions.length === 0) return;
    let cancelled = false;
    api.getProducts()
      .then((rows) => {
        if (!cancelled) setProducts(Array.isArray(rows) ? rows : rows?.data || []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [allowedActions.length]);

  useEffect(() => {
    if (allowedActions.length > 0 && !allowedActions.includes(action)) setAction(allowedActions[0]);
  }, [allowedActions, action]);

  const totalUnits = holdings.reduce((sum, row) => sum + Number(row.quantity || 0), 0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const qty = Number(quantity);
    if (!productId) {
      setError('Pick a product first.');
      return;
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Quantity must be a whole number of at least 1.');
      return;
    }
    if (action === 'loss' && !reason.trim()) {
      setError('A loss needs a reason.');
      return;
    }
    setBusy(true);
    try {
      const movement = await api.recordEmployeeStockMovement(action, {
        employeeId,
        productId,
        quantity: qty,
        reason: action === 'loss' ? reason.trim() : undefined,
      });
      setNotice(`${ACTION_LABELS[action]} — ${movement.quantity} × ${movement.product_name}.`);
      setQuantity('1');
      setReason('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'That movement was refused.');
    } finally {
      setBusy(false);
    }
  };

  if (!canView) return null;

  return (
    <div className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            <PackageSearch className="h-4 w-4 text-indigo-500" />
            {self ? 'My stock' : 'Equipment held'}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {self
              ? 'Units issued to you. Return them, or record what a job consumed.'
              : `Units issued to ${employeeName || 'this employee'} and not yet returned, consumed or written off.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-slate-200 px-2.5 py-1 text-[10px] font-semibold text-slate-500 dark:border-slate-700 dark:text-slate-400">
            {holdings.length} item{holdings.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
          </span>
          <button type="button" className={ghostButton} onClick={() => void load()} disabled={loading || busy}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className={`mt-3 ${errorBox}`}>
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && <div className={`mt-3 ${okBox}`}>{notice}</div>}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left dark:border-slate-800">
              <th className="py-1.5 pr-2 font-semibold text-slate-500">Product</th>
              <th className="py-1.5 pr-2 font-semibold text-slate-500">Branch</th>
              <th className="py-1.5 pr-2 text-right font-semibold text-slate-500">Held</th>
              <th className="py-1.5 pl-2 font-semibold text-slate-500">Updated</th>
            </tr>
          </thead>
          <tbody>
            {loading && holdings.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-center text-slate-400">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            ) : holdings.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-center text-slate-400">
                  {self ? 'You are not holding any equipment.' : 'No equipment is issued to this employee.'}
                </td>
              </tr>
            ) : (
              holdings.map((row) => (
                <tr key={`${row.employee_id}-${row.product_id}-${row.branch_id}`} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-1.5 pr-2">
                    <div className="font-medium text-slate-700 dark:text-slate-200">{row.product_name}</div>
                    <div className="text-[10px] text-slate-400">{row.product_code}</div>
                  </td>
                  <td className="py-1.5 pr-2 text-slate-500 dark:text-slate-400">{row.branch_name}</td>
                  <td className="py-1.5 pr-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                    {row.quantity}
                  </td>
                  <td className="py-1.5 pl-2 text-[10px] text-slate-400">{stamp(row.updated_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {allowedActions.length > 0 && (
        <form onSubmit={submit} className="mt-4 grid grid-cols-1 gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[2fr_1fr_2fr_auto] dark:border-slate-800">
          <div>
            <label className={labelClass} htmlFor={`stock-product-${employeeId}`}>
              Product
            </label>
            <select
              id={`stock-product-${employeeId}`}
              className={inputClass}
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              disabled={busy}
            >
              <option value="">Select a product…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({product.sku})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor={`stock-qty-${employeeId}`}>
              Quantity
            </label>
            <input
              id={`stock-qty-${employeeId}`}
              type="number"
              min={1}
              step={1}
              className={inputClass}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`stock-action-${employeeId}`}>
              Movement
            </label>
            <select
              id={`stock-action-${employeeId}`}
              className={inputClass}
              value={action}
              onChange={(event) => setAction(event.target.value as Action)}
              disabled={busy}
            >
              {allowedActions.map((value) => (
                <option key={value} value={value}>
                  {ACTION_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          {action === 'loss' && (
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor={`stock-reason-${employeeId}`}>
                Reason for the loss
              </label>
              <input
                id={`stock-reason-${employeeId}`}
                type="text"
                className={inputClass}
                value={reason}
                placeholder="What happened to the units?"
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
              />
            </div>
          )}
          <div className="flex items-end gap-2">
            <button type="submit" className={primaryButton} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : action === 'issue' ? (
                <ArrowDownToLine className="h-3.5 w-3.5" />
              ) : action === 'loss' ? (
                <Trash2 className="h-3.5 w-3.5" />
              ) : (
                <ArrowUpFromLine className="h-3.5 w-3.5" />
              )}
              Save
            </button>
          </div>
        </form>
      )}

      {movements.length > 0 && (
        <div className="mt-4">
          <div className={labelClass}>Recent movements</div>
          <ul className="mt-1 divide-y divide-slate-100 text-[11px] dark:divide-slate-800/60">
            {movements.slice(0, 8).map((movement) => (
              <li key={movement.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {MOVEMENT_LABELS[movement.movement_type]} {movement.quantity} × {movement.product_name}
                  {movement.work_order_no ? <span className="text-slate-400"> · {movement.work_order_no}</span> : null}
                  {movement.reason ? <span className="text-slate-400"> · {movement.reason}</span> : null}
                </span>
                <span className="text-slate-400">
                  {stamp(movement.created_at)} · {movement.actor}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default EmployeeStockPanel;
