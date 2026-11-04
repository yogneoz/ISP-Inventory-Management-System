/**
 * Boolean request flags.
 *
 * `Boolean(body.active)` is not a parser: the string "false" is truthy, so a
 * client that sends form values rather than JSON booleans would silently
 * re-activate a record it asked to retire. Masters therefore read flags through
 * this helper, which understands the JSON booleans, the numeric form, and the
 * usual on/off words, and falls back to the existing value for anything else.
 */
export function booleanFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'inactive', 'retired'].includes(text)) return false;
  if (['true', '1', 'yes', 'on', 'active'].includes(text)) return true;
  return fallback;
}
