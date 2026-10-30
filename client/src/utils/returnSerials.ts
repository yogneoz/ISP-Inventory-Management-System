/**
 * Return serial slots — the per-unit identity fields both return forms use.
 *
 * A return reverses a document that already named each unit, so the form shows
 * one row per unit (quantity-driven) exactly like the purchase bill, and a
 * scanned device serial is resolved against the original invoice's own serial
 * list. That is what makes the form barcode-reader friendly: no comma-separated
 * blob to type, and a scan fills MAC/PON from the document instead of asking
 * the operator to re-scan three labels per unit.
 */

export interface ReturnSerialSlot {
  deviceSerial: string;
  macAddress: string;
  ponSerial: string;
}

export interface ReturnSerialLineLike {
  productId: string;
  productName?: string;
  quantity: number;
  requiresSerials: boolean;
  deviceSerials: ReturnSerialSlot[];
}

export const emptyReturnSerialSlot = (): ReturnSerialSlot => ({
  deviceSerial: '',
  macAddress: '',
  ponSerial: '',
});

/** Serials compare the way the register compares them. */
export const returnSerialKey = (value: unknown): string =>
  String(value ?? '').trim().toUpperCase();

function toSlot(raw: unknown): ReturnSerialSlot {
  if (typeof raw === 'string') {
    return { ...emptyReturnSerialSlot(), deviceSerial: raw.trim() };
  }
  const value = (raw || {}) as Record<string, unknown>;
  return {
    deviceSerial: String(value.deviceSerial ?? '').trim(),
    macAddress: String(value.macAddress ?? '').trim(),
    ponSerial: String(value.ponSerial ?? '').trim(),
  };
}

/**
 * Resizes the slots to the line's quantity without discarding what was already
 * scanned: raising the quantity adds empty units, lowering it removes the tail.
 * An identity typed into a unit that is no longer being returned must never
 * survive silently.
 */
export function fitReturnSerialSlots(
  slots: ReturnSerialSlot[] | undefined,
  quantity: number
): ReturnSerialSlot[] {
  const count = Math.max(0, Math.trunc(Number(quantity)) || 0);
  const next = (slots || []).slice(0, count).map((slot) => ({ ...slot }));
  while (next.length < count) next.push(emptyReturnSerialSlot());
  return next;
}

/** Every serial the original invoice recorded, one slot per unit. */
export function invoiceSerialUnits(invoiceItems: unknown, productId: string): ReturnSerialSlot[] {
  const line = (Array.isArray(invoiceItems) ? invoiceItems : []).find(
    (item: any) => item?.productId === productId
  );
  if (!line) return [];
  const entries: unknown[] = Array.isArray(line.deviceSerials) ? line.deviceSerials : [];
  return entries.map(toSlot).filter((slot) => slot.deviceSerial);
}

/**
 * The slots a return line starts with: the invoice's units for that product,
 * minus any unit a posted return already took back. When the invoice recorded
 * fewer serials than the returnable quantity (legacy rows), the rest stay empty
 * for the operator to scan.
 */
export function seedReturnSerialSlots(args: {
  invoiceItems: unknown;
  productId: string;
  quantity: number;
  alreadyReturned?: Iterable<string>;
}): ReturnSerialSlot[] {
  const returned = new Set([...(args.alreadyReturned || [])].map(returnSerialKey).filter(Boolean));
  const available = invoiceSerialUnits(args.invoiceItems, args.productId).filter(
    (slot) => !returned.has(returnSerialKey(slot.deviceSerial))
  );
  const count = Math.max(0, Math.trunc(Number(args.quantity)) || 0);
  const seeded: ReturnSerialSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    seeded.push(available[i] ? { ...available[i] } : emptyReturnSerialSlot());
  }
  return seeded;
}

/** The invoice unit a scanned value names, if this invoice recorded it. */
export function findInvoiceSerialUnit(
  units: ReturnSerialSlot[],
  scanned: string
): ReturnSerialSlot | undefined {
  const key = returnSerialKey(scanned);
  if (!key) return undefined;
  return units.find((unit) => returnSerialKey(unit.deviceSerial) === key);
}

/** Index of another slot already carrying this serial (-1 when unique). */
export function duplicateSerialSlotIndex(
  slots: ReturnSerialSlot[],
  deviceSerial: string,
  exceptIndex: number
): number {
  const key = returnSerialKey(deviceSerial);
  if (!key) return -1;
  return slots.findIndex(
    (slot, index) => index !== exceptIndex && returnSerialKey(slot.deviceSerial) === key
  );
}

/**
 * Submit-time problems with the per-unit identity, or null. Serial-tracked
 * lines need one device serial per unit (the MAC/PON come from the invoice or
 * the register — the server hydrates and re-checks them); duplicates across
 * the whole return are refused here so the operator sees it before submitting.
 */
export function returnSerialProblems(lines: ReturnSerialLineLike[]): string | null {
  const seen = new Map<string, string>();
  for (const line of lines) {
    const name = line.productName || line.productId || 'item';
    if (!line.requiresSerials) continue;
    const quantity = Math.abs(Number(line.quantity)) || 0;
    const filled = (line.deviceSerials || []).filter((slot) => returnSerialKey(slot.deviceSerial));
    if (filled.length !== quantity) {
      return `${name} is serial-tracked: ${quantity} device serial(s) required, ${filled.length} scanned.`;
    }
    for (const slot of filled) {
      const key = returnSerialKey(slot.deviceSerial);
      const previous = seen.get(key);
      if (previous) {
        return `Device serial ${slot.deviceSerial.trim()} is used twice (${previous} and ${name}).`;
      }
      seen.set(key, name);
    }
  }
  return null;
}
