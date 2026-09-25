/**
 * Server-side document-number claim extracted from app.ts (backlog item #6 —
 * app.ts extraction). Document Numbering System helper (server-side):
 * resolves the next voucher number from the document_number_configs master
 * (same sequences shown in Fiscal Year Management > Document Numbering
 * Initial Setup). Falls back to the legacy branch-based generator only when
 * the requested doc type has not been configured yet.
 *
 * C2 (race-safe): the sequence claim is a single atomic
 *   UPDATE ... SET next_number = next_number + 1 RETURNING next_number
 * on document_number_configs — two concurrent callers can never observe the
 * same number, and the DB counter is the authority. The returned number is
 * the value the caller consumed, so it is NOT double-incremented in the
 * in-memory mirror. When PostgreSQL is unreachable the function falls back to
 * generateStandardTransactionId (timestamp-based, collision-free enough for
 * the offline/demo mode) instead of the old racy in-memory counter whose
 * persistence was a fire-and-forget write of a computed value.
 */
import { pgPool } from '../../db';
import { docNumberConfigs, getPgConnected } from '../state/runtimeState';
import { generateStandardTransactionId } from '../utils/docNumber';

export async function generateNextDocNumberForServer(docTypeId: string): Promise<string> {
  if (getPgConnected()) {
    try {
      const claimed = await pgPool.query(
        `UPDATE document_number_configs SET
           next_number = document_number_configs.next_number + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING next_number, prefix, suffix, min_digits;`,
        [docTypeId]
      );
      const row = claimed.rows[0];
      if (row) {
        const issuedSeq = Number(row.next_number) - 1; // the number THIS caller consumes
        const paddedNum = String(issuedSeq).padStart(Number(row.min_digits) || 4, '0');
        // Sync the in-memory mirror to the authoritative DB counter so the
        // admin UI shows the true next number even after concurrent claims.
        const idx = docNumberConfigs.findIndex((c) => c.id === docTypeId);
        if (idx !== -1) docNumberConfigs[idx].nextNumber = Number(row.next_number);
        return `${row.prefix || ''}${paddedNum}${row.suffix || ''}`;
      }
      // No row updated: doc type not configured in the DB — fall through.
    } catch (e: any) {
      console.warn('generateNextDocNumberForServer atomic claim failed:', docTypeId, e?.message || e);
    }
  }

  const config = docNumberConfigs.find((c) => c.id === docTypeId);
  if (!config) {
    return generateStandardTransactionId('WH001', docTypeId);
  }
  // Offline/demo mode: legacy branch-based id (timestamp-backed), NOT the
  // racy in-memory counter path that previously allowed duplicates.
  return generateStandardTransactionId('WH001', docTypeId);
}
