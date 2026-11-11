/**
 * SQL for the Phase 4 recruitment pipeline.
 *
 * A requisition carries its branch. A candidate inherits that branch from its
 * requisition, and an interview or offer inherits it from the candidate, so
 * child rows cannot drift to a second branch claim. The controller intersects
 * every list with the caller's allowed branches and resolves the branch of a
 * write from the parent, never from a client-supplied branch id.
 *
 * A resume is optional until uploaded; the schema's all-or-none CHECK is
 * repeated by the columns kept here. The bytea column is deliberately absent
 * from every list projection, exactly as the employee document vault keeps its
 * content out of metadata reads.
 */

export const HR_RECRUITMENT_REQUISITION_STATUSES = [
  'DRAFT',
  'OPEN',
  'ON_HOLD',
  'CLOSED',
] as const;
export type HrRecruitmentRequisitionStatus = (typeof HR_RECRUITMENT_REQUISITION_STATUSES)[number];

export const HR_RECRUITMENT_CANDIDATE_STATUSES = [
  'NEW',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type HrRecruitmentCandidateStatus = (typeof HR_RECRUITMENT_CANDIDATE_STATUSES)[number];

export const HR_RECRUITMENT_INTERVIEW_STATUSES = [
  'SCHEDULED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type HrRecruitmentInterviewStatus = (typeof HR_RECRUITMENT_INTERVIEW_STATUSES)[number];

export const HR_RECRUITMENT_INTERVIEW_MODES = ['IN_PERSON', 'PHONE', 'VIDEO'] as const;
export type HrRecruitmentInterviewMode = (typeof HR_RECRUITMENT_INTERVIEW_MODES)[number];

export const HR_RECRUITMENT_OFFER_STATUSES = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'WITHDRAWN',
] as const;
export type HrRecruitmentOfferStatus = (typeof HR_RECRUITMENT_OFFER_STATUSES)[number];

/** Resume bytes are bounded in the schema and in the raw upload route. */
export const HR_RECRUITMENT_RESUME_MAX_BYTES = 5 * 1024 * 1024;
export const HR_RECRUITMENT_RESUME_ALLOWED_MIME = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const HR_RECRUITMENT_REQUISITION_COLUMNS = `r.id,
  r.requisition_no AS "requisitionNo",
  r.branch_id AS "branchId",
  COALESCE(b.name, r.branch_id) AS "branchName",
  r.title,
  r.department,
  r.designation,
  r.employment_type AS "employmentType",
  r.openings,
  r.status,
  r.opened_on_ad::text AS "openedOnAD",
  r.opened_on_bs AS "openedOnBS",
  r.closes_on_ad::text AS "closesOnAD",
  r.closes_on_bs AS "closesOnBS",
  r.description,
  (SELECT COUNT(*)::int FROM hr_recruitment_candidates c WHERE c.requisition_id = r.id) AS "candidateCount",
  (SELECT COUNT(*)::int FROM hr_recruitment_candidates c
    WHERE c.requisition_id = r.id AND c.status = 'HIRED') AS "hiredCount",
  r.created_by AS "createdBy",
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt"`;

const HR_RECRUITMENT_REQUISITION_FROM = `FROM hr_recruitment_requisitions r
LEFT JOIN branches b ON b.id = r.branch_id`;

export const HR_RECRUITMENT_REQUISITION_LIST_SQL = `SELECT ${HR_RECRUITMENT_REQUISITION_COLUMNS}
${HR_RECRUITMENT_REQUISITION_FROM}
WHERE ($1::varchar IS NULL OR r.branch_id = $1)
  AND ($2::varchar[] IS NULL OR r.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR r.status = $3)
ORDER BY r.opened_on_ad DESC NULLS LAST, r.created_at DESC, r.id DESC
LIMIT 1000`;

export const HR_RECRUITMENT_REQUISITION_BY_ID_SQL = `SELECT ${HR_RECRUITMENT_REQUISITION_COLUMNS}
${HR_RECRUITMENT_REQUISITION_FROM}
WHERE r.id = $1
LIMIT 1`;

export const HR_RECRUITMENT_REQUISITION_INSERT_SQL = `INSERT INTO hr_recruitment_requisitions (
  id, requisition_no, branch_id, title, department, designation, employment_type,
  openings, status, opened_on_ad, opened_on_bs, closes_on_ad, closes_on_bs,
  description, is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, FALSE, $15, $15)
RETURNING id`;

export const HR_RECRUITMENT_REQUISITION_UPDATE_SQL = `UPDATE hr_recruitment_requisitions SET
  title = $2,
  department = $3,
  designation = $4,
  employment_type = $5,
  openings = $6,
  status = $7,
  opened_on_ad = $8,
  opened_on_bs = $9,
  closes_on_ad = $10,
  closes_on_bs = $11,
  description = $12,
  updated_by = $13,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const HR_RECRUITMENT_CANDIDATE_COLUMNS = `c.id,
  c.candidate_no AS "candidateNo",
  c.requisition_id AS "requisitionId",
  r.requisition_no AS "requisitionNo",
  r.title AS "requisitionTitle",
  c.branch_id AS "branchId",
  COALESCE(b.name, c.branch_id) AS "branchName",
  c.name,
  c.email,
  c.phone,
  c.source,
  c.current_employer AS "currentEmployer",
  c.status,
  c.notes,
  c.resume_file_name AS "resumeFileName",
  c.resume_mime_type AS "resumeMimeType",
  c.resume_byte_size AS "resumeByteSize",
  c.resume_uploaded_at AS "resumeUploadedAt",
  (c.resume_content IS NOT NULL) AS "hasResume",
  c.hired_employee_id AS "hiredEmployeeId",
  e.employee_code AS "hiredEmployeeCode",
  (SELECT COUNT(*)::int FROM hr_recruitment_interviews i WHERE i.candidate_id = c.id) AS "interviewCount",
  (SELECT MAX(i.scheduled_on_ad)::text FROM hr_recruitment_interviews i
    WHERE i.candidate_id = c.id) AS "lastInterviewOnAD",
  o.id AS "offerId",
  o.offer_no AS "offerNo",
  o.status AS "offerStatus",
  o.position_title AS "offerPositionTitle",
  o.monthly_salary::numeric AS "offerMonthlySalary",
  o.start_date_ad::text AS "offerStartDateAD",
  c.created_by AS "createdBy",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt"`;

const HR_RECRUITMENT_CANDIDATE_FROM = `FROM hr_recruitment_candidates c
JOIN hr_recruitment_requisitions r ON r.id = c.requisition_id
LEFT JOIN branches b ON b.id = c.branch_id
LEFT JOIN employees e ON e.id = c.hired_employee_id
LEFT JOIN hr_recruitment_offers o ON o.candidate_id = c.id`;

export const HR_RECRUITMENT_CANDIDATE_LIST_SQL = `SELECT ${HR_RECRUITMENT_CANDIDATE_COLUMNS}
${HR_RECRUITMENT_CANDIDATE_FROM}
WHERE ($1::varchar IS NULL OR c.branch_id = $1)
  AND ($2::varchar[] IS NULL OR c.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR c.requisition_id = $3)
  AND ($4::varchar IS NULL OR c.status = $4)
ORDER BY c.created_at DESC, c.id DESC
LIMIT 2000`;

export const HR_RECRUITMENT_CANDIDATE_BY_ID_SQL = `SELECT ${HR_RECRUITMENT_CANDIDATE_COLUMNS}
${HR_RECRUITMENT_CANDIDATE_FROM}
WHERE c.id = $1
LIMIT 1`;

export const HR_RECRUITMENT_CANDIDATE_INSERT_SQL = `INSERT INTO hr_recruitment_candidates (
  id, candidate_no, requisition_id, branch_id, name, email, phone, source,
  current_employer, status, notes, is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE, $12, $12)
RETURNING id`;

export const HR_RECRUITMENT_CANDIDATE_UPDATE_SQL = `UPDATE hr_recruitment_candidates SET
  name = $2,
  email = $3,
  phone = $4,
  source = $5,
  current_employer = $6,
  status = $7,
  notes = $8,
  updated_by = $9,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

/** The interview workflow advances a new/screening candidate only. */
export const HR_RECRUITMENT_CANDIDATE_MARK_INTERVIEW_SQL = `UPDATE hr_recruitment_candidates SET
  status = 'INTERVIEW',
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status IN ('NEW', 'SCREENING')
RETURNING id`;

/** Creating an offer advances an earlier-stage candidate to OFFER. */
export const HR_RECRUITMENT_CANDIDATE_MARK_OFFER_SQL = `UPDATE hr_recruitment_candidates SET
  status = 'OFFER',
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status IN ('NEW', 'SCREENING', 'INTERVIEW')
RETURNING id`;

/** Hire is the only transition to HIRED, and it is one-shot. */
export const HR_RECRUITMENT_CANDIDATE_HIRE_SQL = `UPDATE hr_recruitment_candidates SET
  status = 'HIRED',
  hired_employee_id = $2,
  updated_by = $3,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND hired_employee_id IS NULL
RETURNING id`;

export const HR_RECRUITMENT_RESUME_UPDATE_SQL = `UPDATE hr_recruitment_candidates SET
  resume_file_name = $2,
  resume_mime_type = $3,
  resume_byte_size = $4,
  resume_content = $5,
  resume_uploaded_at = CURRENT_TIMESTAMP,
  updated_by = $6,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const HR_RECRUITMENT_RESUME_CONTENT_SQL = `SELECT
  resume_file_name AS "fileName",
  resume_mime_type AS "mimeType",
  resume_byte_size AS "byteSize",
  resume_content AS content
FROM hr_recruitment_candidates
WHERE id = $1 AND resume_content IS NOT NULL
LIMIT 1`;

export const HR_RECRUITMENT_INTERVIEW_COLUMNS = `i.id,
  i.candidate_id AS "candidateId",
  c.candidate_no AS "candidateNo",
  c.name AS "candidateName",
  i.branch_id AS "branchId",
  COALESCE(b.name, i.branch_id) AS "branchName",
  i.round_name AS "roundName",
  i.scheduled_on_ad::text AS "scheduledOnAD",
  i.scheduled_on_bs AS "scheduledOnBS",
  i.interviewer,
  i.mode,
  i.status,
  i.rating,
  i.notes,
  i.created_at AS "createdAt",
  i.updated_at AS "updatedAt"`;

const HR_RECRUITMENT_INTERVIEW_FROM = `FROM hr_recruitment_interviews i
JOIN hr_recruitment_candidates c ON c.id = i.candidate_id
LEFT JOIN branches b ON b.id = i.branch_id`;

export const HR_RECRUITMENT_INTERVIEW_LIST_SQL = `SELECT ${HR_RECRUITMENT_INTERVIEW_COLUMNS}
${HR_RECRUITMENT_INTERVIEW_FROM}
WHERE ($1::varchar IS NULL OR i.branch_id = $1)
  AND ($2::varchar[] IS NULL OR i.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR i.candidate_id = $3)
  AND ($4::varchar IS NULL OR i.status = $4)
ORDER BY i.scheduled_on_ad DESC, i.created_at DESC, i.id DESC
LIMIT 2000`;

export const HR_RECRUITMENT_INTERVIEW_BY_ID_SQL = `SELECT ${HR_RECRUITMENT_INTERVIEW_COLUMNS}
${HR_RECRUITMENT_INTERVIEW_FROM}
WHERE i.id = $1
LIMIT 1`;

export const HR_RECRUITMENT_INTERVIEW_INSERT_SQL = `INSERT INTO hr_recruitment_interviews (
  id, candidate_id, branch_id, round_name, scheduled_on_ad, scheduled_on_bs,
  interviewer, mode, status, rating, notes, is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE, $12, $12)
RETURNING id`;

export const HR_RECRUITMENT_INTERVIEW_UPDATE_SQL = `UPDATE hr_recruitment_interviews SET
  round_name = $2,
  scheduled_on_ad = $3,
  scheduled_on_bs = $4,
  interviewer = $5,
  mode = $6,
  status = $7,
  rating = $8,
  notes = $9,
  updated_by = $10,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const HR_RECRUITMENT_OFFER_COLUMNS = `o.id,
  o.offer_no AS "offerNo",
  o.candidate_id AS "candidateId",
  c.candidate_no AS "candidateNo",
  c.name AS "candidateName",
  o.branch_id AS "branchId",
  COALESCE(b.name, o.branch_id) AS "branchName",
  o.position_title AS "positionTitle",
  o.monthly_salary::numeric AS "monthlySalary",
  o.start_date_ad::text AS "startDateAD",
  o.start_date_bs AS "startDateBS",
  o.offered_on_ad::text AS "offeredOnAD",
  o.offered_on_bs AS "offeredOnBS",
  o.status,
  o.responded_on_ad::text AS "respondedOnAD",
  o.notes,
  o.created_at AS "createdAt",
  o.updated_at AS "updatedAt"`;

const HR_RECRUITMENT_OFFER_FROM = `FROM hr_recruitment_offers o
JOIN hr_recruitment_candidates c ON c.id = o.candidate_id
LEFT JOIN branches b ON b.id = o.branch_id`;

export const HR_RECRUITMENT_OFFER_LIST_SQL = `SELECT ${HR_RECRUITMENT_OFFER_COLUMNS}
${HR_RECRUITMENT_OFFER_FROM}
WHERE ($1::varchar IS NULL OR o.branch_id = $1)
  AND ($2::varchar[] IS NULL OR o.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR o.candidate_id = $3)
  AND ($4::varchar IS NULL OR o.status = $4)
ORDER BY o.offered_on_ad DESC, o.created_at DESC, o.id DESC
LIMIT 2000`;

export const HR_RECRUITMENT_OFFER_BY_ID_SQL = `SELECT ${HR_RECRUITMENT_OFFER_COLUMNS}
${HR_RECRUITMENT_OFFER_FROM}
WHERE o.id = $1
LIMIT 1`;

export const HR_RECRUITMENT_OFFER_INSERT_SQL = `INSERT INTO hr_recruitment_offers (
  id, offer_no, candidate_id, branch_id, position_title, monthly_salary,
  start_date_ad, start_date_bs, offered_on_ad, offered_on_bs, status,
  responded_on_ad, notes, is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, FALSE, $14, $14)
RETURNING id`;

export const HR_RECRUITMENT_OFFER_UPDATE_SQL = `UPDATE hr_recruitment_offers SET
  position_title = $2,
  monthly_salary = $3,
  start_date_ad = $4,
  start_date_bs = $5,
  offered_on_ad = $6,
  offered_on_bs = $7,
  status = $8,
  responded_on_ad = $9,
  notes = $10,
  updated_by = $11,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

/**
 * One lockable row for the hire decision. The candidate row is locked; the
 * offer and requisition are read through the same snapshot so the final
 * ACCEPTED check and the employee insert cannot race another hire.
 */
export const HR_RECRUITMENT_HIRE_CONTEXT_SQL = `SELECT
  c.id AS "candidateId",
  c.candidate_no AS "candidateNo",
  c.name,
  c.email,
  c.phone,
  c.branch_id AS "branchId",
  c.status AS "candidateStatus",
  c.hired_employee_id AS "hiredEmployeeId",
  r.title AS "requisitionTitle",
  r.department,
  r.designation,
  r.employment_type AS "employmentType",
  o.id AS "offerId",
  o.status AS "offerStatus",
  o.position_title AS "positionTitle",
  o.monthly_salary::numeric AS "monthlySalary",
  o.start_date_ad::text AS "startDateAD"
FROM hr_recruitment_candidates c
JOIN hr_recruitment_requisitions r ON r.id = c.requisition_id
LEFT JOIN hr_recruitment_offers o ON o.candidate_id = c.id
WHERE c.id = $1
FOR UPDATE OF c`;
