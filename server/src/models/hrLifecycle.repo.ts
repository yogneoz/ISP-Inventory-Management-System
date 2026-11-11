/**
 * SQL for Phase 4 onboarding/offboarding checklists.
 *
 * The checklist header owns branch custody from its employee. Items live only
 * under that header and carry no branch claim. Asset and account items point at
 * real fixed-asset/user rows; the controller executes the return/issue or
 * account status change in the same transaction as item completion.
 */

export const HR_LIFECYCLE_TYPES = ['ONBOARDING', 'OFFBOARDING'] as const;
export type HrLifecycleType = (typeof HR_LIFECYCLE_TYPES)[number];

export const HR_LIFECYCLE_STATUSES = ['DRAFT', 'OPEN', 'COMPLETED'] as const;
export type HrLifecycleStatus = (typeof HR_LIFECYCLE_STATUSES)[number];

export const HR_LIFECYCLE_CATEGORIES = [
  'DOCUMENT',
  'ASSET',
  'ACCOUNT',
  'ACCESS',
  'OTHER',
] as const;
export type HrLifecycleCategory = (typeof HR_LIFECYCLE_CATEGORIES)[number];

export type HrLifecycleAction =
  | 'NONE'
  | 'ISSUE_ASSET'
  | 'RETURN_ASSET'
  | 'ACTIVATE_ACCOUNT'
  | 'DEACTIVATE_ACCOUNT';

const CHECKLIST_COLUMNS = `c.id,
  c.checklist_no AS "checklistNo",
  c.employee_id AS "employeeId",
  c.branch_id AS "branchId",
  b.name AS "branchName",
  e.employee_code AS "employeeCode",
  e.name AS "employeeName",
  e.department,
  e.designation,
  c.checklist_type AS "checklistType",
  c.status,
  c.effective_date_ad::text AS "effectiveDateAD",
  c.effective_date_bs AS "effectiveDateBS",
  c.notes,
  c.completed_by AS "completedBy",
  c.completed_at AS "completedAt",
  c.is_demo AS "isDemo",
  c.created_by AS "createdBy",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt",
  e.user_id AS "userId",
  u.email AS "accountEmail",
  u.name AS "accountName",
  u.status AS "accountStatus",
  u.role AS "accountRole",
  (SELECT COUNT(*)::int FROM hr_lifecycle_checklist_items i WHERE i.checklist_id = c.id) AS "itemCount",
  (SELECT COUNT(*)::int FROM hr_lifecycle_checklist_items i WHERE i.checklist_id = c.id AND i.status = 'DONE') AS "doneCount",
  (SELECT COUNT(*)::int FROM hr_lifecycle_checklist_items i WHERE i.checklist_id = c.id AND i.required = TRUE AND i.status = 'PENDING') AS "requiredPendingCount",
  (SELECT COUNT(*)::int FROM hr_lifecycle_checklist_items i WHERE i.checklist_id = c.id AND i.category = 'ASSET') AS "assetCount",
  (SELECT COUNT(*)::int FROM hr_lifecycle_checklist_items i WHERE i.checklist_id = c.id AND i.category = 'ASSET' AND i.status = 'PENDING') AS "pendingAssetCount"`;

const CHECKLIST_FROM = `FROM hr_lifecycle_checklists c
JOIN employees e ON e.id = c.employee_id
JOIN branches b ON b.id = c.branch_id
LEFT JOIN users u ON u.id = e.user_id`;

export const HR_LIFECYCLE_LIST_SQL = `SELECT ${CHECKLIST_COLUMNS}
${CHECKLIST_FROM}
WHERE ($1::varchar IS NULL OR c.branch_id = $1)
  AND ($2::varchar[] IS NULL OR c.branch_id = ANY($2::varchar[]))
  AND ($3::varchar IS NULL OR c.checklist_type = $3)
  AND ($4::varchar IS NULL OR c.status = $4)
  AND ($5::varchar IS NULL OR c.employee_id = $5)
ORDER BY c.effective_date_ad DESC, c.created_at DESC, c.id DESC
LIMIT 500`;

export const HR_LIFECYCLE_BY_ID_SQL = `SELECT ${CHECKLIST_COLUMNS}
${CHECKLIST_FROM}
WHERE c.id = $1
LIMIT 1`;

export const HR_LIFECYCLE_LOCK_SQL = `SELECT id, status, employee_id AS "employeeId", branch_id AS "branchId", checklist_type AS "checklistType",
  checklist_no AS "checklistNo", effective_date_ad::text AS "effectiveDateAD", effective_date_bs AS "effectiveDateBS"
FROM hr_lifecycle_checklists
WHERE id = $1
FOR UPDATE`;

export const HR_LIFECYCLE_ACTIVE_BY_EMPLOYEE_SQL = `SELECT id, checklist_no AS "checklistNo"
FROM hr_lifecycle_checklists
WHERE employee_id = $1 AND checklist_type = $2 AND status <> 'COMPLETED'
LIMIT 1`;

export const HR_LIFECYCLE_INSERT_SQL = `INSERT INTO hr_lifecycle_checklists (
  id, checklist_no, employee_id, branch_id, checklist_type, status,
  effective_date_ad, effective_date_bs, notes, is_demo, created_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $10)
RETURNING id`;

export const HR_LIFECYCLE_UPDATE_SQL = `UPDATE hr_lifecycle_checklists SET
  status = $2,
  effective_date_ad = $3,
  effective_date_bs = $4,
  notes = $5,
  updated_by = $6,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status <> 'COMPLETED'
RETURNING id`;

export const HR_LIFECYCLE_COMPLETE_SQL = `UPDATE hr_lifecycle_checklists SET
  status = 'COMPLETED',
  completed_by = $2,
  completed_at = CURRENT_TIMESTAMP,
  updated_by = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'OPEN'
RETURNING id`;

const ITEM_COLUMNS = `i.id,
  i.checklist_id AS "checklistId",
  i.category,
  i.title,
  i.description,
  i.required,
  i.status,
  i.action,
  i.asset_id AS "assetId",
  i.sort_order AS "sortOrder",
  i.completed_by AS "completedBy",
  i.completed_at AS "completedAt",
  i.created_at AS "createdAt",
  i.updated_at AS "updatedAt",
  fa.tag_number AS "assetTagNumber",
  fa.name AS "assetName",
  fa.category AS "assetCategory",
  fa.status AS "assetStatus",
  fa.branch_id AS "assetBranchId",
  fa.assigned_employee_id AS "assetAssignedEmployeeId"`;

const ITEM_FROM = `FROM hr_lifecycle_checklist_items i
LEFT JOIN fixed_assets fa ON fa.id = i.asset_id`;

export const HR_LIFECYCLE_ITEMS_SQL = `SELECT ${ITEM_COLUMNS}
${ITEM_FROM}
WHERE i.checklist_id = $1
ORDER BY i.sort_order ASC, i.created_at ASC, i.id ASC`;

export const HR_LIFECYCLE_ITEM_BY_ID_SQL = `SELECT ${ITEM_COLUMNS},
  c.status AS "checklistStatus",
  c.checklist_type AS "checklistType",
  c.checklist_no AS "checklistNo",
  c.branch_id AS "checklistBranchId",
  c.employee_id AS "checklistEmployeeId",
  e.name AS "employeeName",
  e.user_id AS "userId",
  u.email AS "accountEmail",
  u.status AS "accountStatus",
  u.role AS "accountRole"
${ITEM_FROM}
JOIN hr_lifecycle_checklists c ON c.id = i.checklist_id
JOIN employees e ON e.id = c.employee_id
LEFT JOIN users u ON u.id = e.user_id
WHERE i.id = $1
LIMIT 1`;

export const HR_LIFECYCLE_ITEM_LOCK_SQL = `SELECT i.id, i.status, i.action, i.asset_id AS "assetId", i.title
FROM hr_lifecycle_checklist_items i
WHERE i.id = $1
FOR UPDATE`;

export const HR_LIFECYCLE_PENDING_REQUIRED_SQL = `SELECT COUNT(*)::int AS count
FROM hr_lifecycle_checklist_items
WHERE checklist_id = $1 AND required = TRUE AND status = 'PENDING'`;

export const HR_LIFECYCLE_NEXT_ORDER_SQL = `SELECT COALESCE(MAX(sort_order), 0) + 10 AS "nextOrder"
FROM hr_lifecycle_checklist_items
WHERE checklist_id = $1`;

export const HR_LIFECYCLE_ITEM_INSERT_SQL = `INSERT INTO hr_lifecycle_checklist_items (
  id, checklist_id, category, title, description, required, status, action,
  asset_id, sort_order, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, FALSE)
RETURNING id`;

export const HR_LIFECYCLE_ITEM_COMPLETE_SQL = `UPDATE hr_lifecycle_checklist_items SET
  status = 'DONE',
  completed_by = $2,
  completed_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'PENDING'
RETURNING id`;

export const HR_LIFECYCLE_EMPLOYEE_SQL = `SELECT e.id,
  e.employee_code AS "employeeCode",
  e.name,
  e.branch_id AS "branchId",
  e.user_id AS "userId",
  u.email AS "accountEmail",
  u.name AS "accountName",
  u.status AS "accountStatus",
  u.role AS "accountRole"
FROM employees e
LEFT JOIN users u ON u.id = e.user_id
WHERE e.id = $1
LIMIT 1`;

export const HR_LIFECYCLE_ASSIGNED_ASSETS_SQL = `SELECT id,
  tag_number AS "tagNumber",
  name,
  category,
  status,
  branch_id AS "branchId",
  assigned_employee_id AS "assignedEmployeeId",
  assigned_employee_name AS "assignedEmployeeName"
FROM fixed_assets
WHERE assigned_employee_id = $1
ORDER BY tag_number ASC, id ASC
LIMIT 500`;

export const HR_LIFECYCLE_AVAILABLE_ASSETS_SQL = `SELECT id,
  tag_number AS "tagNumber",
  name,
  category,
  status,
  branch_id AS "branchId",
  assigned_employee_id AS "assignedEmployeeId"
FROM fixed_assets
WHERE branch_id = $1
  AND status = 'ACTIVE'
  AND assigned_employee_id IS NULL
  AND assigned_type IS NULL
  AND assigned_customer_id IS NULL
  AND assigned_location_id IS NULL
ORDER BY tag_number ASC, id ASC
LIMIT 500`;

export const HR_LIFECYCLE_ASSET_LOCK_SQL = `SELECT id,
  tag_number AS "tagNumber",
  name,
  category,
  status,
  branch_id AS "branchId",
  assigned_type AS "assignedType",
  assigned_customer_id AS "assignedCustomerId",
  assigned_location_id AS "assignedLocationId",
  assigned_employee_id AS "assignedEmployeeId",
  assigned_employee_name AS "assignedEmployeeName"
FROM fixed_assets
WHERE id = $1
FOR UPDATE`;

export const HR_LIFECYCLE_ISSUE_ASSET_SQL = `UPDATE fixed_assets SET
  status = 'IN_USE',
  assigned_type = 'EMPLOYEE',
  assigned_employee_id = $2,
  assigned_employee_name = $3,
  assigned_customer_id = NULL,
  assigned_customer_name = NULL,
  assigned_location_id = NULL,
  assigned_location_name = NULL,
  assignment_date_ad = $4,
  assignment_date_bs = $5,
  assignment_notes = $6,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const HR_LIFECYCLE_RETURN_ASSET_SQL = `UPDATE fixed_assets SET
  status = 'ACTIVE',
  assigned_type = NULL,
  assigned_employee_id = NULL,
  assigned_employee_name = NULL,
  assigned_customer_id = NULL,
  assigned_customer_name = NULL,
  assigned_location_id = NULL,
  assigned_location_name = NULL,
  assignment_date_ad = NULL,
  assignment_date_bs = NULL,
  assignment_notes = CASE
    WHEN assignment_notes IS NULL OR assignment_notes = '' THEN $2
    ELSE assignment_notes || E'\n' || $2
  END,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id`;

export const HR_LIFECYCLE_ACCOUNT_LOCK_SQL = `SELECT id, email, name, role, status
FROM users
WHERE id = $1
FOR UPDATE`;

export const HR_LIFECYCLE_ACCOUNT_STATUS_SQL = `UPDATE users SET
  status = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING id, email, name, role, status`;
