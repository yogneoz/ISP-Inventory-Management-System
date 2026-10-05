import type { DocumentNumberConfig } from '../types/index';
import { fetchJson } from '../services/api/http';

/**
 * documentNumbering.ts
 * Universal document-numbering helpers for the Freebuff Desktop inventory ERP.
 *
 * Architecture:
 *   - document_number_configs (PostgreSQL)  -> the *config*: prefix, suffix, min digits,
 *     reset rule, notes. Read-only on the client; edited through the Finance >
 *     Document Numbering tab and persisted via PUT /api/document-number-configs.
 *
 *   - document_sequence_daily (PostgreSQL)  -> the *counter*: per branch + doc type +
 *     date_ad, the next number to issue. Maintained by the server only.
 *
 *   - The client NEVER fabricates a sequence. It only:
 *       1. Reads config from the DB (getDocumentNumberConfigs)
 *       2. Formats a *display sample* (formatNumber) using the config's prefix + digits
 *       3. Calls the server to issue the real number (issueDocNumber, done in the
 *          transaction controllers).
 *
 *   Legacy helpers (generateNextDocumentNumber / resetDocumentSequence) were removed
 *   because they fabricated a number client-side, which broke the "server is
 *   authoritative" contract. They are not part of this file.
 */

/** Fetch document-numbering configs straight from the database (server-side). */
export async function getDocumentNumberConfigs(): Promise<DocumentNumberConfig[]> {
  return fetchJson<DocumentNumberConfig[]>('/api/document-number-configs');
}

/**
 * Format a *display sample* of a document number using the configured prefix
 * and digit count. Pure function � no database reads, no sequence reads.
 *
 * Examples:
 *   formatNumber('PO-', 5, 4) -> 'PO-0005'
 *   formatNumber('INV-', 12, 5) -> 'INV-00012'
 *   formatNumber('CN-', 99, 4) -> 'CN-0099'
 */
export function formatNumber(
  prefix: string,
  seqNum: number,
  minDigits: number,
  suffix: string = '',
): string {
  const code = prefix.replace(/\-0*$/, '').replace(/-$/, '');
  const padded = String(seqNum ?? 1).padStart(minDigits, '0');
  return `${code}${padded}${suffix}`;
}

