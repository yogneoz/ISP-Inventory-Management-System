/**
 * Server-side document-number helper for the admin numbering screen.
 *
 * The claim is a single atomic
 *   UPDATE ... SET next_number = next_number + 1 RETURNING next_number
 * on document_number_configs. Two concurrent callers can never observe the same
 * number, and the DB counter is the authority.
 *
 * It is fail-closed: an unavailable sequence or an unconfigured document type
 * refuses the allocation instead of falling back to a timestamp/random number.
 */
import { pgPool } from '../../db';
import { ApiError } from '../errors/ApiError';
import { docNumberConfigs, getPgConnected } from '../state/runtimeState';

export async function generateNextDocNumberForServer(docTypeId: string, client?: any): Promise<string> {
  const db = client || (getPgConnected() ? pgPool : null);
  if (!db) {
    throw new ApiError(503, `Document number sequence ${docTypeId} is unavailable; nothing was posted.`);
  }

  let claimed: any;
  try {
    claimed = await db.query(
      `UPDATE document_number_configs SET
         next_number = document_number_configs.next_number + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING next_number, prefix, suffix, min_digits;`,
      [docTypeId]
    );
  } catch (e: any) {
    console.error('generateNextDocNumberForServer atomic claim failed:', docTypeId, e?.message || e);
    throw new ApiError(
      503,
      `Document number sequence ${docTypeId} could not allocate the next legal number; nothing was posted.`
    );
  }

  const row = claimed.rows[0];
  if (!row) {
    throw new ApiError(
      404,
      `Document number sequence ${docTypeId} is not configured; nothing was posted.`
    );
  }
  const issuedSeq = Number(row.next_number) - 1;
  if (!Number.isInteger(issuedSeq) || issuedSeq <= 0) {
    throw new ApiError(
      503,
      `Document number sequence ${docTypeId} returned no legal number; nothing was posted.`
    );
  }
  const paddedNum = String(issuedSeq).padStart(Number(row.min_digits) || 4, '0');
  // Sync the in-memory mirror to the authoritative DB counter so the admin UI
  // shows the true next number even after concurrent claims.
  const idx = docNumberConfigs.findIndex((c) => c.id === docTypeId);
  if (idx !== -1) docNumberConfigs[idx].nextNumber = Number(row.next_number);
  return `${row.prefix || ''}${paddedNum}${row.suffix || ''}`;
}
