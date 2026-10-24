import React, { useEffect, useRef, useState } from 'react';
import { normalizeMacAddress } from '../../../../shared/macAddress';
import { isSerialLookupNotFound, serialStatusLabel } from '../../utils/serialRefusal';
import { CheckCircle2, AlertTriangle, Loader2, XCircle } from 'lucide-react';

/**
 * The one-field device-serial input (serial-input plan, Slice D).
 *
 * Every operation except the purchase bill captures exactly ONE value — the
 * Device Serial. Typing (or scanning) it resolves the unit against the serial
 * register and fills PON and MAC read-only, because the register — not the
 * operator's memory — is the authority for a unit's identity. The server
 * applies the same hydration (serialGate.service `hydrateSerialEntries`), so a
 * payload carrying only the device serial is complete on arrival.
 *
 * Resolution order:
 *   1. `register` — rows the screen already holds (serial_log); synchronous.
 *   2. `lookup` — a branch-scoped fetch for screens without a register copy.
 * A unit that resolves is reported with its status and branch so the operator
 * sees WHY a refusal happened before submitting.
 */

export interface SerialResolvable {
  deviceSerial: string;
  ponSerial?: string | null;
  macAddress?: string | null;
  productId?: string | null;
  productName?: string | null;
  branchId?: string | null;
  status?: string | null;
}

export interface DeviceSerialValue {
  deviceSerial: string;
  ponSerial?: string;
  macAddress?: string;
}

/**
 * `lookup-failed` is deliberately not `not-found`: a 500/503/dropped lookup
 * means the register could not be asked, and telling the operator the unit does
 * not exist sends them to re-scan and re-type a serial that may be perfectly
 * valid (DF-15). It is the only state with a Retry.
 */
export type DeviceSerialState =
  | 'idle'
  | 'checking'
  | 'ok'
  | 'not-found'
  | 'lookup-failed'
  | 'not-in-stock'
  | 'other-branch'
  | 'other-product';

const serialKey = (value: unknown) => String(value ?? '').trim().toUpperCase();

/** The register row a device serial names, or undefined. Shared with panels. */
export function findRegisterRow(
  rows: readonly SerialResolvable[] | undefined,
  deviceSerial: string
): SerialResolvable | undefined {
  const key = serialKey(deviceSerial);
  if (!key) return undefined;
  return (rows || []).find((row) => serialKey(row.deviceSerial) === key);
}

export interface DeviceSerialLookupContext {
  deviceSerial: string;
  branchId?: string;
  productId?: string;
  productName?: string;
}

/**
 * Classifies a resolved register row against the operation's expectation.
 * Pure, so the panels and this component agree on what "usable here" means.
 */
export function classifyRegisterRow(
  row: SerialResolvable | undefined,
  ctx: DeviceSerialLookupContext
): DeviceSerialState {
  if (!row) return 'not-found';
  const status = String(row.status || '').toUpperCase();
  if (status && status !== 'IN_STOCK') return 'not-in-stock';
  if (ctx.branchId && row.branchId && String(row.branchId) !== String(ctx.branchId)) return 'other-branch';
  if (ctx.productId && row.productId && String(row.productId) !== String(ctx.productId)) return 'other-product';
  if (
    !ctx.productId &&
    ctx.productName &&
    row.productName &&
    String(row.productName).trim().toLowerCase() !== String(ctx.productName).trim().toLowerCase()
  ) {
    return 'other-product';
  }
  return 'ok';
}

interface DeviceSerialInputProps {
  id?: string;
  value?: DeviceSerialValue;
  onChange: (next: DeviceSerialValue) => void;
  /** Register rows the screen already holds (serial_log). */
  register?: readonly SerialResolvable[];
  /** Async fallback for screens without a register copy. */
  lookup?: (deviceSerial: string) => Promise<SerialResolvable | null>;
  branchId?: string;
  productId?: string;
  productName?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Called after Enter (resolved or not) — used for focus chaining. */
  onEnter?: () => void;
  className?: string;
  placeholder?: string;
}

const STATE_TEXT: Record<Exclude<DeviceSerialState, 'idle'>, string> = {
  checking: 'Checking register…',
  ok: 'IN_STOCK — PON & MAC filled from the register',
  'not-found': 'Not in the serial register for this branch',
  'lookup-failed': 'Could not check the register',
  'not-in-stock': 'Not IN_STOCK',
  'other-branch': 'Held at a different branch',
  'other-product': 'Belongs to a different product',
};

/** Typing pause before the register is asked about a hand-typed serial. */
const RESOLVE_DEBOUNCE_MS = 400;

/**
 * Refusal text for a resolved-but-unusable unit. The status is the fact the
 * operator needs ("CUSTOMER ASSIGNED" vs "DAMAGED"), so it is not collapsed back
 * into the generic "not IN_STOCK" wording.
 */
function describeInlineState(
  state: Exclude<DeviceSerialState, 'idle' | 'checking' | 'ok'>,
  resolved: { status: string; branchId: string } | null
): string {
  switch (state) {
    case 'not-in-stock': {
      const label = serialStatusLabel(resolved?.status);
      return label === 'UNKNOWN' ? STATE_TEXT['not-in-stock'] : `${label} — not IN_STOCK`;
    }
    case 'other-branch':
      return resolved?.branchId ? `Held at branch ${resolved.branchId}` : STATE_TEXT['other-branch'];
    default:
      return STATE_TEXT[state];
  }
}

export const DeviceSerialInput: React.FC<DeviceSerialInputProps> = ({
  id,
  value,
  onChange,
  register,
  lookup,
  branchId,
  productId,
  productName,
  disabled,
  autoFocus,
  onEnter,
  className,
  placeholder = 'Device Serial #',
}) => {
  const [state, setState] = useState<DeviceSerialState>('idle');
  const [resolved, setResolved] = useState<{ ponSerial: string; macAddress: string; status: string; branchId: string } | null>(null);

  const deviceSerial = value?.deviceSerial || '';
  // Latest typed value, so a slow lookup for an earlier serial cannot land on
  // top of a newer one (the operator types B while A is still in flight).
  const latestSerial = useRef(deviceSerial);
  latestSerial.current = deviceSerial;

  const applyRow = (row: SerialResolvable, fallback: string, expected: DeviceSerialState) => {
    const nextPon = String(row.ponSerial ?? '').trim();
    const nextMac = normalizeMacAddress(row.macAddress);
    setState(expected);
    setResolved({
      ponSerial: nextPon,
      macAddress: nextMac,
      status: String(row.status || ''),
      branchId: String(row.branchId || ''),
    });
    if (deviceSerial !== (row.deviceSerial || fallback) || (value?.ponSerial || '') !== nextPon || (value?.macAddress || '') !== nextMac) {
      onChange({ deviceSerial: row.deviceSerial || fallback, ponSerial: nextPon, macAddress: nextMac });
    }
  };

  const resolve = async () => {
    const typed = deviceSerial.trim();
    if (!typed) {
      setState('idle');
      setResolved(null);
      return;
    }
    const ctx: DeviceSerialLookupContext = { deviceSerial: typed, branchId, productId, productName };
    const local = findRegisterRow(register, typed);
    if (local) {
      applyRow(local, typed, classifyRegisterRow(local, ctx));
      return;
    }
    if (lookup) {
      setState('checking');
      try {
        const row = await lookup(typed);
        if (latestSerial.current.trim() !== typed) return;
        if (row) {
          applyRow(row, typed, classifyRegisterRow(row, ctx));
        } else {
          setState('not-found');
          setResolved(null);
        }
      } catch (err) {
        if (latestSerial.current.trim() !== typed) return;
        // 404 is the register's only definitive "no such unit"; every other
        // rejection is a failure to consult it (DF-15).
        setState(isSerialLookupNotFound(err) ? 'not-found' : 'lookup-failed');
        setResolved(null);
      }
      return;
    }
    setState(register && register.length > 0 ? 'not-found' : 'idle');
    setResolved(null);
  };

  // Resolve while the operator types (request: feedback before they leave the
  // field). A scanner still ends with Enter, which resolves immediately; a hand
  // typed serial resolves after a short pause instead of waiting for a blur the
  // operator may never give it before clicking Submit.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  useEffect(() => {
    if (disabled) return;
    const typed = deviceSerial.trim();
    if (!typed) {
      setState('idle');
      setResolved(null);
      return;
    }
    const timer = setTimeout(() => { void resolveRef.current(); }, RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [deviceSerial, branchId, productId, productName, disabled]);

  const handleChange = (next: string) => {
    setState('idle');
    setResolved(null);
    onChange({ deviceSerial: next, ponSerial: value?.ponSerial || '', macAddress: value?.macAddress || '' });
  };

  const stateColor =
    state === 'ok'
      ? 'text-emerald-600 dark:text-emerald-400'
      : state === 'checking' || state === 'idle'
        ? 'text-slate-400'
        : state === 'lookup-failed'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-rose-600 dark:text-rose-400';

  const pon = resolved?.ponSerial ?? value?.ponSerial ?? '';
  const mac = resolved?.macAddress ?? value?.macAddress ?? '';

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type="text"
          placeholder={placeholder}
          value={deviceSerial}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={resolve}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            void resolve();
            onEnter?.();
          }}
          className="w-full px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-indigo-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
        />
      </div>

      {state === 'checking' && (
        <div className={`mt-0.5 flex items-center gap-1 text-[9.5px] font-semibold ${stateColor}`}>
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{STATE_TEXT.checking}</span>
        </div>
      )}
      {state === 'ok' && (
        <div className={`mt-0.5 flex items-center gap-1 text-[9.5px] font-semibold ${stateColor}`}>
          <CheckCircle2 className="h-3 w-3" />
          <span className="font-mono">
            {pon ? `PON ${pon}` : 'no PON'} · {mac ? `MAC ${mac}` : 'no MAC'}
          </span>
        </div>
      )}
      {state !== 'ok' && state !== 'checking' && state !== 'idle' && (
        <div className={`mt-0.5 flex items-center gap-1 text-[9.5px] font-semibold ${stateColor}`}>
          {state === 'not-found' || state === 'lookup-failed' ? (
            <AlertTriangle className="h-3 w-3" />
          ) : (
            <XCircle className="h-3 w-3" />
          )}
          <span>{describeInlineState(state, resolved)}</span>
          {state === 'lookup-failed' && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void resolve()}
              className="ml-0.5 underline font-bold hover:no-underline disabled:no-underline disabled:opacity-60"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
};
