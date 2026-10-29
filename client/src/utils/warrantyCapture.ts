/**
 * WTY-4: the prefill rule every supplier-warranty capture field shares.
 *
 * The expiry is derived once from the document date and the product's supplier
 * term, then it belongs to the operator: changing the date (or picking another
 * product) must not clobber a typed expiry. The `warrantyTouched` flag on the
 * draft is the whole rule, kept here so the invoice and the asset modal cannot
 * drift apart.
 */
import { defaultWarrantyEnd, isAdDate } from '../../../shared/warrantyTerm';

/** The field a dirty-tracked capture draft carries. */
export interface WarrantyDraft {
  /** Exact expiry; `''` means "no date yet" (e.g. a 0-month term). */
  warrantyEndDateAD?: string;
  /** True once the operator edits the date; prefill must leave it alone. */
  warrantyTouched?: boolean;
}

/**
 * Suggested expiry for a start date + term. A 0/absent/invalid term means the
 * product carries no supplier warranty, so there is no date to suggest.
 */
export function warrantyEndFor(
  startDateAD: string,
  termMonths: number | null | undefined
): string {
  const term = Number(termMonths);
  if (!isAdDate(startDateAD) || !Number.isFinite(term) || term <= 0) return '';
  return defaultWarrantyEnd(startDateAD, Math.trunc(term)) || '';
}

/**
 * Re-derives the expiry for every untouched draft. A line without the field
 * (a quantity-only line) and a touched line are returned unchanged, so
 * re-rendering the form never rewrites the operator's contract date.
 */
export function applyWarrantyPrefill<T extends WarrantyDraft>(
  drafts: T[],
  startDateAD: string,
  termOf: (draft: T) => number | null | undefined
): T[] {
  return drafts.map((draft) => {
    if (draft.warrantyTouched || draft.warrantyEndDateAD === undefined) return draft;
    return { ...draft, warrantyEndDateAD: warrantyEndFor(startDateAD, termOf(draft)) };
  });
}

/**
 * The capture field's validation. Empty is allowed (a 0-term product, or an
 * operator leaving the coverage off); a typed date must be real and on or
 * after the document date. The API applies the same rule.
 */
export function warrantyEndFieldError(
  startDateAD: string,
  endDateAD: string | null | undefined,
  label = 'Suppliers warranty expiry'
): string | null {
  if (!endDateAD) return null;
  if (!isAdDate(endDateAD)) return `${label} must be a real calendar date.`;
  if (!isAdDate(startDateAD)) return `${label} needs a valid purchase date first.`;
  if (endDateAD < startDateAD) return `${label} cannot be before the purchase date.`;
  return null;
}
