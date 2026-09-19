import { CompanyProfile } from '../types';

/**
 * Compose the single canonical full address for a company profile.
 * Used by document letterheads, the sidebar brand block, exports and any
 * print surface so address rendering is never duplicated or inconsistent.
 */
export function getCompanyAddress(p?: CompanyProfile | null): string {
  if (!p) return '';
  return [p.address, p.city, p.country]
    .map((seg) => (seg || '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Compose a short location line (city + country) for compact surfaces
 * like the sidebar brand block.
 */
export function getCompanyLocation(p?: CompanyProfile | null): string {
  if (!p) return '';
  return [p.city, p.country].map((seg) => (seg || '').trim()).filter(Boolean).join(', ');
}