/**
 * Proof-of-work evidence for a field visit — the photo or signature a technician
 * captured on site.
 *
 * The stored `sha256` is computed here, never taken from the request, so the
 * content address is the row's own: a queued capture re-sent after a timeout
 * lands on the unique `(work_order_id, sha256)` and answers with the row that is
 * already stored instead of stacking a second copy.
 *
 * Bytes are kept base64 in the row: this deployment has no object store, and the
 * table's CHECK caps a single capture at 2 MiB so a scan stays bounded. The
 * branch is copied from the order at write time, which is what lets the read be
 * branch-scoped without joining back through `field_work_orders`.
 */
import crypto from 'node:crypto';
import { pgPool } from '../../db';

export interface FieldWorkOrderEvidenceRow {
  id: string;
  work_order_id: string;
  branch_id: string;
  kind: 'PHOTO' | 'SIGNATURE';
  content_type: string;
  byte_size: number;
  sha256: string;
  caption: string | null;
  captured_at: string;
  captured_by: string;
  latitude: string | null;
  longitude: string | null;
  accuracy_meters: string | null;
  created_at: string;
}

export interface EvidenceInput {
  workOrderId: string;
  branchId: string;
  kind: 'PHOTO' | 'SIGNATURE';
  contentType: string;
  dataBase64: string;
  caption: string | null;
  capturedAt: Date;
  capturedBy: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
}

/** The metadata a list returns; the bytes are fetched by content route only. */
const SELECT_COLUMNS = `
  id, work_order_id, branch_id, kind, content_type, byte_size, sha256, caption,
  captured_at, captured_by, latitude, longitude, accuracy_meters, created_at`;

export interface EvidenceWriteResult {
  row: FieldWorkOrderEvidenceRow;
  /** False when this exact capture was already stored (a replayed queue item). */
  inserted: boolean;
  sha256: string;
  /** How many captures the order now holds. */
  count: number;
}

export async function appendFieldWorkOrderEvidence(input: EvidenceInput): Promise<EvidenceWriteResult> {
  const bytes = Buffer.from(input.dataBase64, 'base64');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  const inserted = await pgPool.query(
    `INSERT INTO field_work_order_evidence (
       work_order_id, branch_id, kind, content_type, byte_size, sha256,
       data_base64, caption, captured_at, captured_by, latitude, longitude,
       accuracy_meters
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (work_order_id, sha256) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.workOrderId,
      input.branchId,
      input.kind,
      input.contentType,
      bytes.length,
      sha256,
      input.dataBase64,
      input.caption,
      input.capturedAt.toISOString(),
      input.capturedBy,
      input.latitude,
      input.longitude,
      input.accuracyMeters,
    ]
  );

  const row =
    inserted.rows[0] ||
    (
      await pgPool.query(
        `SELECT ${SELECT_COLUMNS}
           FROM field_work_order_evidence
          WHERE work_order_id = $1 AND sha256 = $2`,
        [input.workOrderId, sha256]
      )
    ).rows[0];
  if (!row) throw new Error('evidence row disappeared after insert');

  const count = (
    await pgPool.query('SELECT COUNT(*)::int AS count FROM field_work_order_evidence WHERE work_order_id = $1', [
      input.workOrderId,
    ])
  ).rows[0].count;

  return { row, inserted: inserted.rows.length > 0, sha256, count };
}

export async function listFieldWorkOrderEvidence(
  workOrderId: string,
  branchIds?: string[] | null
): Promise<FieldWorkOrderEvidenceRow[]> {
  const result = await pgPool.query(
    `SELECT ${SELECT_COLUMNS}
       FROM field_work_order_evidence
      WHERE work_order_id = $1
        AND ($2::text[] IS NULL OR branch_id = ANY($2::text[]))
      ORDER BY created_at ASC, id ASC`,
    [workOrderId, branchIds && branchIds.length ? branchIds : null]
  );
  return result.rows;
}

/** The stored bytes, for the authenticated content route. */
export async function findFieldWorkOrderEvidenceContent(
  evidenceId: string
): Promise<{ content_type: string; data_base64: string; sha256: string } | null> {
  const result = await pgPool.query(
    'SELECT content_type, data_base64, sha256 FROM field_work_order_evidence WHERE id = $1',
    [evidenceId]
  );
  return result.rows[0] || null;
}
