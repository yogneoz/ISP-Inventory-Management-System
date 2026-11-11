/**
 * SQL for the F1 Employee Profile.
 *
 * The form's scalar answers live on `employees` (father/grandfather names, the
 * permanent and local addresses, the emergency address/relation, blood group,
 * medical, accident/case and the declaration). Its repeating sections live in
 * four child tables, each cascading with the employee so a deleted employee can
 * never leave an orphaned family or qualification row behind.
 *
 * `sort_order` is assigned by the server from the array position, so the order
 * the officer typed is preserved and two rows can never claim one position.
 * Every SQL string lives in this model (the no-inline-SQL gate); the controller
 * owns validation and the transaction.
 */

/** Bounded collections: a form has a handful of rows, not a database dump. */
export const HR_PROFILE_LIMITS = {
  familyMembers: 20,
  experience: 20,
  qualifications: 20,
  references: 10,
} as const;

/** The blood groups F1 offers; anything else is a typo, not a value. */
export const HR_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type HrBloodGroup = (typeof HR_BLOOD_GROUPS)[number];

/**
 * Employee identity, branch custody and the profile columns in one read. The
 * branch id is what the scope check uses; the caller's own masking decision is
 * made in the controller, never here.
 */
export const HR_PROFILE_EMPLOYEE_SQL = `SELECT
  id,
  employee_code AS "employeeCode",
  name,
  branch_id AS "branchId",
  user_id AS "userId",
  father_name AS "fatherName",
  grandfather_name AS "grandfatherName",
  permanent_address AS "permanentAddress",
  local_address AS "localAddress",
  emergency_contact_address AS "emergencyContactAddress",
  emergency_contact_relation AS "emergencyContactRelation",
  blood_group AS "bloodGroup",
  medical_conditions AS "medicalConditions",
  medical_details AS "medicalDetails",
  accident_details AS "accidentDetails",
  case_details AS "caseDetails",
  declaration_date_ad::text AS "declarationDateAD",
  declaration_name AS "declarationName"
FROM employees
WHERE id = $1
LIMIT 1`;

/**
 * PUT replaces the whole profile: an omitted field is cleared, not kept, so the
 * stored row always matches the form the officer just submitted.
 */
export const HR_PROFILE_UPDATE_SQL = `UPDATE employees SET
  father_name = $2,
  grandfather_name = $3,
  permanent_address = $4,
  local_address = $5,
  emergency_contact_address = $6,
  emergency_contact_relation = $7,
  blood_group = $8,
  medical_conditions = $9,
  medical_details = $10,
  accident_details = $11,
  case_details = $12,
  declaration_date_ad = $13,
  declaration_name = $14,
  updated_by = COALESCE($15, updated_by),
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

/** F1 family details: member name, age, occupation and relation. */
export const HR_FAMILY_BY_EMPLOYEE_SQL = `SELECT
  id,
  sort_order AS "sortOrder",
  name,
  age,
  occupation,
  relation
FROM hr_employee_family_members
WHERE employee_id = $1
ORDER BY sort_order ASC, id ASC`;

export const HR_FAMILY_DELETE_SQL =
  'DELETE FROM hr_employee_family_members WHERE employee_id = $1';

export const HR_FAMILY_INSERT_SQL = `INSERT INTO hr_employee_family_members
  (id, employee_id, sort_order, name, age, occupation, relation, is_demo)
VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`;

/** F1 experience: organisation, period and designation. */
export const HR_EXPERIENCE_BY_EMPLOYEE_SQL = `SELECT
  id,
  sort_order AS "sortOrder",
  organization,
  from_ad::text AS "fromAD",
  to_ad::text AS "toAD",
  designation
FROM hr_employee_experience
WHERE employee_id = $1
ORDER BY sort_order ASC, id ASC`;

export const HR_EXPERIENCE_DELETE_SQL =
  'DELETE FROM hr_employee_experience WHERE employee_id = $1';

export const HR_EXPERIENCE_INSERT_SQL = `INSERT INTO hr_employee_experience
  (id, employee_id, sort_order, organization, from_ad, to_ad, designation, is_demo)
VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`;

/** F1 qualifications: exam passed, board/university and percentage. */
export const HR_QUALIFICATION_BY_EMPLOYEE_SQL = `SELECT
  id,
  sort_order AS "sortOrder",
  exam_passed AS "examPassed",
  board_university AS "boardUniversity",
  percentage::text AS "percentage"
FROM hr_employee_qualifications
WHERE employee_id = $1
ORDER BY sort_order ASC, id ASC`;

export const HR_QUALIFICATION_DELETE_SQL =
  'DELETE FROM hr_employee_qualifications WHERE employee_id = $1';

export const HR_QUALIFICATION_INSERT_SQL = `INSERT INTO hr_employee_qualifications
  (id, employee_id, sort_order, exam_passed, board_university, percentage, is_demo)
VALUES ($1, $2, $3, $4, $5, $6, FALSE)`;

/** F1 official references. */
export const HR_REFERENCE_BY_EMPLOYEE_SQL = `SELECT
  id,
  sort_order AS "sortOrder",
  name,
  organization,
  contact,
  relation
FROM hr_employee_references
WHERE employee_id = $1
ORDER BY sort_order ASC, id ASC`;

export const HR_REFERENCE_DELETE_SQL =
  'DELETE FROM hr_employee_references WHERE employee_id = $1';

export const HR_REFERENCE_INSERT_SQL = `INSERT INTO hr_employee_references
  (id, employee_id, sort_order, name, organization, contact, relation, is_demo)
VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`;
