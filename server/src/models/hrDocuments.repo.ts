/**
 * SQL for the employee document vault.
 *
 * The bytes live in this same PostgreSQL database so the document and its
 * metadata commit or roll back together, and there is no second storage system
 * to back up or secure. `storage_key` is a generated id, never derived from the
 * employee or the uploaded name, so addressing a blob cannot leak personal data.
 */

export const HR_DOCUMENT_TYPES = [
  'CITIZENSHIP',
  'PAN_CARD',
  'PASSPORT',
  'DRIVING_LICENSE',
  'QUALIFICATION',
  'CONTRACT',
  'APPOINTMENT_LETTER',
  'BANK_DETAILS',
  'MEDICAL',
  'OTHER',
] as const;
export type HrDocumentType = (typeof HR_DOCUMENT_TYPES)[number];

/** Every ceiling here is repeated in the schema CHECK and the upload handler. */
export const HR_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
export const HR_DOCUMENT_MAX_PER_EMPLOYEE = 20;

export const HR_DOCUMENT_ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/** Metadata projection: the content column is never selected for a list. */
export const HR_DOCUMENT_META_COLUMNS = `id,
  employee_id AS "employeeId",
  doc_type AS "docType",
  original_name AS "originalName",
  mime_type AS "mimeType",
  byte_size AS "byteSize",
  expires_on_ad AS "expiresOnAD",
  notes,
  uploaded_by AS "uploadedBy",
  created_at AS "createdAt"`;

/** Employee ownership and branch for the scope check, without PII columns. */
export const HR_DOCUMENT_EMPLOYEE_SCOPE_SQL = `SELECT
  id,
  employee_code AS "employeeCode",
  name,
  branch_id AS "branchId",
  user_id AS "userId"
FROM employees
WHERE id = $1
LIMIT 1`;

export const HR_DOCUMENTS_BY_EMPLOYEE_SQL = `SELECT ${HR_DOCUMENT_META_COLUMNS}
FROM hr_employee_documents
WHERE employee_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 100`;

export const HR_DOCUMENT_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM hr_employee_documents
WHERE employee_id = $1`;

export const HR_DOCUMENT_CONTENT_SQL = `SELECT
  original_name AS "originalName",
  mime_type AS "mimeType",
  byte_size AS "byteSize",
  content
FROM hr_employee_documents
WHERE id = $1 AND employee_id = $2
LIMIT 1`;

export const HR_DOCUMENT_INSERT_SQL = `INSERT INTO hr_employee_documents (
  id, employee_id, doc_type, original_name, mime_type, byte_size,
  storage_key, expires_on_ad, notes, content, is_demo, uploaded_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, $11)
RETURNING ${HR_DOCUMENT_META_COLUMNS}`;

export const HR_DOCUMENT_DELETE_SQL = `DELETE FROM hr_employee_documents
WHERE id = $1 AND employee_id = $2
RETURNING id`;
