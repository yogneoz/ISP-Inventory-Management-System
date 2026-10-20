/**
 * MAC address canonicalisation — ONE implementation, shared by the client
 * bundle and the server (same import pattern as shared/bsCalendarYears.json).
 *
 * Operators scan the MAC from the device barcode, which is printed without
 * separators ("A4C3F0B1D2E3"). The register stores and compares MACs with
 * separators ("A4:C3:F0:B1:D2:E3"), so without this module the same physical
 * device looks like two different values at every duplicate/lookup gate.
 *
 * Rules:
 *  - A value that contains exactly 12 hex digits (after ignoring separators)
 *    is canonicalised to uppercase colon-separated pairs.
 *  - Anything else is returned trimmed and otherwise untouched. A serial or
 *    PON that happens to be scanned into the MAC field must never be mangled.
 */

const HEX_12 = /^[0-9a-f]{12}$/i;

/** Uppercase colon form for a 12-hex-digit MAC, else the trimmed input. */
export function normalizeMacAddress(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  if (!HEX_12.test(hex)) return raw;
  return (hex.toUpperCase().match(/.{2}/g) as string[]).join(':');
}

/**
 * Comparison key for a MAC. A canonicalisable value collapses to its 12 hex
 * digits, so "a4c3f0b1d2e3" and "A4:C3:F0:B1:D2:E3" are the same device.
 * Non-MAC values fall back to a trimmed uppercase string.
 */
export function macKey(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  return HEX_12.test(hex) ? hex.toUpperCase() : raw.toUpperCase();
}

/** True when the value can be canonicalised as a MAC. */
export function isMacAddress(value: unknown): boolean {
  const hex = String(value ?? '').trim().replace(/[^0-9a-fA-F]/g, '');
  return HEX_12.test(hex);
}
