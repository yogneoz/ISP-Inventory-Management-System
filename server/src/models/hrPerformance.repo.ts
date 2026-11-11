/**
 * SQL for Phase 4 appraisal cycles, goals and 360 feedback.
 *
 * A cycle carries its branch. Goals and feedback inherit that branch from the
 * cycle, so a child row cannot drift to a second branch claim. The controller
 * intersects every list with the caller's allowed branches and resolves the
 * branch of a write from the cycle, never from the request body.
 *
 * After sign-off the controller refuses every write for the cycle's children.
 * The SQL still keeps the write statements narrow (no client branch selector)
 * so a future route edit cannot widen custody by accident.
 */

export const HR_REVIEW_CYCLE_STATUSES = ['DRAFT', 'OPEN', 'SIGNED_OFF'] as const;
export type HrReviewCycleStatus = (typeof HR_REVIEW_CYCLE_STATUSES)[number];

export const HR_GOAL_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type HrGoalStatus = (typeof HR_GOAL_STATUSES)[number];

export const HR_FEEDBACK_RELATIONSHIPS = ['SELF', 'MANAGER', 'PEER', 'REPORT'] as const;
export type HrFeedbackRelationship = (typeof HR_FEEDBACK_RELATIONSHIPS)[number];

const HR_REVIEW_CYCLE_COLUMNS = `c.id,
  c.cycle_no AS "cycleNo",
  c.branch_id AS "branchId",
  b.name AS "branchName",
  c.name,
  c.period_start_ad::text AS "periodStartAD",
  c.period_start_bs AS "periodStartBS",
  c.period_end_ad::text AS "periodEndAD",
  c.period_end_bs AS "periodEndBS",
  c.status,
  c.instructions,
  c.signed_off_by AS "signedOffBy",
  c.signed_off_at AS "signedOffAt",
  c.is_demo AS "isDemo",
  c.created_by AS "createdBy",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt",
  (SELECT COUNT(*)::int FROM hr_goals g WHERE g.cycle_id = c.id) AS "goalCount",
  (SELECT COUNT(DISTINCT g.employee_id)::int FROM hr_goals g WHERE g.cycle_id = c.id) AS "employeeCount",
  (SELECT COUNT(*)::int FROM hr_review_feedback f WHERE f.cycle_id = c.id) AS "feedbackCount"`;

const HR_REVIEW_CYCLE_FROM = `FROM hr_review_cycles c
LEFT JOIN branches b ON b.id = c.branch_id`;

export const HR_REVIEW_CYCLE_LIST_SQL = `SELECT ${HR_REVIEW_CYCLE_COLUMNS}
${HR_REVIEW_CYCLE_FROM}
WHERE ($1::varchar IS NULL OR c.branch_id = $1)
  AND ($2::varchar[] IS NULL OR c.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR c.status = $3)
ORDER BY c.period_start_ad DESC, c.created_at DESC, c.id DESC
LIMIT 1000`;

export const HR_REVIEW_CYCLE_BY_ID_SQL = `SELECT ${HR_REVIEW_CYCLE_COLUMNS}
${HR_REVIEW_CYCLE_FROM}
WHERE c.id = $1
LIMIT 1`;

export const HR_REVIEW_CYCLE_INSERT_SQL = `INSERT INTO hr_review_cycles (
  id, cycle_no, branch_id, name, period_start_ad, period_start_bs,
  period_end_ad, period_end_bs, status, instructions, is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, $11, $11)
RETURNING id`;

export const HR_REVIEW_CYCLE_UPDATE_SQL = `UPDATE hr_review_cycles SET
  name = $2,
  period_start_ad = $3,
  period_start_bs = $4,
  period_end_ad = $5,
  period_end_bs = $6,
  status = $7,
  instructions = $8,
  updated_by = $9,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status <> 'SIGNED_OFF'
RETURNING id`;

export const HR_REVIEW_CYCLE_SIGN_OFF_SQL = `UPDATE hr_review_cycles SET
  status = 'SIGNED_OFF',
  signed_off_by = $2,
  signed_off_at = CURRENT_TIMESTAMP,
  updated_by = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'OPEN'
RETURNING id`;

const HR_GOAL_COLUMNS = `g.id,
  g.goal_no AS "goalNo",
  g.cycle_id AS "cycleId",
  c.cycle_no AS "cycleNo",
  c.name AS "cycleName",
  c.status AS "cycleStatus",
  g.branch_id AS "branchId",
  b.name AS "branchName",
  g.employee_id AS "employeeId",
  e.employee_code AS "employeeCode",
  e.name AS "employeeName",
  g.title,
  g.description,
  g.weight,
  g.target_value AS "targetValue",
  g.achievement,
  g.status,
  g.self_rating AS "selfRating",
  g.manager_rating AS "managerRating",
  g.final_rating AS "finalRating",
  g.created_by AS "createdBy",
  g.created_at AS "createdAt",
  g.updated_at AS "updatedAt"`;

const HR_GOAL_FROM = `FROM hr_goals g
JOIN hr_review_cycles c ON c.id = g.cycle_id
LEFT JOIN branches b ON b.id = g.branch_id
JOIN employees e ON e.id = g.employee_id`;

export const HR_GOAL_LIST_SQL = `SELECT ${HR_GOAL_COLUMNS}
${HR_GOAL_FROM}
WHERE ($1::varchar IS NULL OR g.branch_id = $1)
  AND ($2::varchar[] IS NULL OR g.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR g.cycle_id = $3)
  AND ($4::varchar IS NULL OR g.employee_id = $4)
  AND ($5::varchar IS NULL OR g.status = $5)
ORDER BY e.name ASC, g.created_at ASC, g.id ASC
LIMIT 2000`;

export const HR_GOAL_BY_ID_SQL = `SELECT ${HR_GOAL_COLUMNS}
${HR_GOAL_FROM}
WHERE g.id = $1
LIMIT 1`;

export const HR_GOAL_INSERT_SQL = `INSERT INTO hr_goals (
  id, goal_no, cycle_id, branch_id, employee_id, title, description, weight,
  target_value, achievement, status, self_rating, manager_rating, final_rating,
  is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, FALSE, $15, $15)
RETURNING id`;

export const HR_GOAL_UPDATE_SQL = `UPDATE hr_goals SET
  title = $2,
  description = $3,
  weight = $4,
  target_value = $5,
  achievement = $6,
  status = $7,
  self_rating = $8,
  manager_rating = $9,
  final_rating = $10,
  updated_by = $11,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

const HR_FEEDBACK_COLUMNS = `f.id,
  f.cycle_id AS "cycleId",
  c.cycle_no AS "cycleNo",
  c.name AS "cycleName",
  c.status AS "cycleStatus",
  f.branch_id AS "branchId",
  b.name AS "branchName",
  f.employee_id AS "employeeId",
  e.employee_code AS "employeeCode",
  e.name AS "employeeName",
  f.reviewer_employee_id AS "reviewerEmployeeId",
  r.employee_code AS "reviewerEmployeeCode",
  r.name AS "reviewerEmployeeName",
  f.relationship,
  f.rating,
  f.strengths,
  f.improvements,
  f.comments,
  f.submitted_by AS "submittedBy",
  f.submitted_at AS "submittedAt"`;

const HR_FEEDBACK_FROM = `FROM hr_review_feedback f
JOIN hr_review_cycles c ON c.id = f.cycle_id
LEFT JOIN branches b ON b.id = f.branch_id
JOIN employees e ON e.id = f.employee_id
JOIN employees r ON r.id = f.reviewer_employee_id`;

export const HR_FEEDBACK_LIST_SQL = `SELECT ${HR_FEEDBACK_COLUMNS}
${HR_FEEDBACK_FROM}
WHERE ($1::varchar IS NULL OR f.branch_id = $1)
  AND ($2::varchar[] IS NULL OR f.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR f.cycle_id = $3)
  AND ($4::varchar IS NULL OR f.employee_id = $4)
  AND ($5::varchar IS NULL OR f.reviewer_employee_id = $5)
ORDER BY e.name ASC, f.submitted_at DESC, f.id DESC
LIMIT 2000`;

export const HR_FEEDBACK_INSERT_SQL = `INSERT INTO hr_review_feedback (
  id, cycle_id, branch_id, employee_id, reviewer_employee_id, relationship,
  rating, strengths, improvements, comments, is_demo, submitted_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, $11)
RETURNING id`;

export const HR_PERFORMANCE_EMPLOYEE_SQL = `SELECT id,
  employee_code AS "employeeCode",
  name,
  branch_id AS "branchId"
FROM employees
WHERE id = $1
LIMIT 1`;
