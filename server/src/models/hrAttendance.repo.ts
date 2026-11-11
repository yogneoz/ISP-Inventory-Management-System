/**
 * SQL for the Phase 1 attendance foundation.
 *
 * Shifts and leave types are small company-wide catalogues. Holidays and
 * attendance rows carry `branch_id` because they are branch custody: the
 * controller intersects the caller's allowed branches with every read and
 * refuses a write outside them. An attendance row is unique per employee and
 * AD date, which is what makes a CSV re-import an update rather than a
 * duplicate.
 */

export const HR_ATTENDANCE_STATUSES = [
  'PRESENT',
  'ABSENT',
  'LEAVE',
  'HALF_DAY',
  'HOLIDAY',
  'WEEKEND',
] as const;
export type HrAttendanceStatus = (typeof HR_ATTENDANCE_STATUSES)[number];

export const HR_ATTENDANCE_SOURCES = ['MANUAL', 'IMPORT'] as const;
export type HrAttendanceSource = (typeof HR_ATTENDANCE_SOURCES)[number];

export const HR_SHIFT_COLUMNS = `id,
  code,
  name,
  to_char(start_time, 'HH24:MI') AS "startTime",
  to_char(end_time, 'HH24:MI') AS "endTime",
  grace_minutes AS "graceMinutes",
  is_active AS "isActive",
  is_demo AS "isDemo",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export const HR_SHIFT_LIST_SQL = `SELECT ${HR_SHIFT_COLUMNS}
FROM hr_shifts
WHERE ($1::boolean = FALSE OR is_active = TRUE)
ORDER BY LOWER(name) ASC, id ASC
LIMIT 1000`;

export const HR_SHIFT_BY_ID_SQL = `SELECT ${HR_SHIFT_COLUMNS}
FROM hr_shifts
WHERE id = $1
LIMIT 1`;

export const HR_SHIFT_INSERT_SQL = `INSERT INTO hr_shifts (
  id, code, name, start_time, end_time, grace_minutes, is_active, is_demo, created_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8)
RETURNING ${HR_SHIFT_COLUMNS}`;

export const HR_SHIFT_UPDATE_SQL = `UPDATE hr_shifts SET
  code = $2,
  name = $3,
  start_time = $4,
  end_time = $5,
  grace_minutes = $6,
  is_active = $7,
  updated_by = $8,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING ${HR_SHIFT_COLUMNS}`;

export const HR_LEAVE_TYPE_COLUMNS = `id,
  code,
  name,
  annual_quota_days::numeric AS "annualQuotaDays",
  is_paid AS "isPaid",
  is_active AS "isActive",
  is_demo AS "isDemo",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export const HR_LEAVE_TYPE_LIST_SQL = `SELECT ${HR_LEAVE_TYPE_COLUMNS}
FROM hr_leave_types
WHERE ($1::boolean = FALSE OR is_active = TRUE)
ORDER BY LOWER(name) ASC, id ASC
LIMIT 500`;

export const HR_LEAVE_TYPE_BY_ID_SQL = `SELECT ${HR_LEAVE_TYPE_COLUMNS}
FROM hr_leave_types
WHERE id = $1
LIMIT 1`;

export const HR_LEAVE_TYPE_INSERT_SQL = `INSERT INTO hr_leave_types (
  id, code, name, annual_quota_days, is_paid, is_active, is_demo, created_by
) VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)
RETURNING ${HR_LEAVE_TYPE_COLUMNS}`;

export const HR_LEAVE_TYPE_UPDATE_SQL = `UPDATE hr_leave_types SET
  code = $2,
  name = $3,
  annual_quota_days = $4,
  is_paid = $5,
  is_active = $6,
  updated_by = $7,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING ${HR_LEAVE_TYPE_COLUMNS}`;

export const HR_HOLIDAY_COLUMNS = `h.id,
  h.branch_id AS "branchId",
  b.name AS "branchName",
  h.holiday_date_ad::text AS "holidayDateAD",
  h.holiday_date_bs AS "holidayDateBS",
  h.name,
  h.is_paid AS "isPaid",
  h.notes,
  h.is_demo AS "isDemo",
  h.created_at AS "createdAt",
  h.updated_at AS "updatedAt"`;

export const HR_HOLIDAY_LIST_SQL = `SELECT ${HR_HOLIDAY_COLUMNS}
FROM hr_holidays h
JOIN branches b ON b.id = h.branch_id
WHERE ($1::varchar IS NULL OR h.branch_id = $1)
  AND ($2::varchar[] IS NULL OR h.branch_id = ANY($2::varchar[]))
  AND ($3::date IS NULL OR h.holiday_date_ad >= $3)
  AND ($4::date IS NULL OR h.holiday_date_ad <= $4)
ORDER BY h.holiday_date_ad DESC, h.id ASC
LIMIT 1000`;

export const HR_HOLIDAY_BY_ID_SQL = `SELECT ${HR_HOLIDAY_COLUMNS}
FROM hr_holidays h
JOIN branches b ON b.id = h.branch_id
WHERE h.id = $1
LIMIT 1`;

export const HR_HOLIDAY_INSERT_SQL = `INSERT INTO hr_holidays (
  id, branch_id, holiday_date_ad, holiday_date_bs, name, is_paid, notes,
  is_demo, created_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8)
RETURNING id`;

export const HR_HOLIDAY_DELETE_SQL = `DELETE FROM hr_holidays
WHERE id = $1
RETURNING id`;

export const HR_ATTENDANCE_COLUMNS = `a.id,
  a.employee_id AS "employeeId",
  e.employee_code AS "employeeCode",
  e.name AS "employeeName",
  a.branch_id AS "branchId",
  a.attendance_date_ad::text AS "attendanceDateAD",
  a.attendance_date_bs AS "attendanceDateBS",
  a.shift_id AS "shiftId",
  s.code AS "shiftCode",
  s.name AS "shiftName",
  a.status,
  to_char(a.check_in_time, 'HH24:MI') AS "checkInTime",
  to_char(a.check_out_time, 'HH24:MI') AS "checkOutTime",
  a.overtime_hours::numeric AS "overtimeHours",
  a.notes,
  a.source,
  a.recorded_by AS "recordedBy",
  a.created_at AS "createdAt",
  a.updated_at AS "updatedAt"`;

export const HR_ATTENDANCE_LIST_SQL = `SELECT ${HR_ATTENDANCE_COLUMNS}
FROM hr_attendance a
JOIN employees e ON e.id = a.employee_id
LEFT JOIN hr_shifts s ON s.id = a.shift_id
WHERE ($1::varchar IS NULL OR a.branch_id = $1)
  AND ($2::varchar[] IS NULL OR a.branch_id = ANY($2::varchar[]))
  AND ($3::date IS NULL OR a.attendance_date_ad >= $3)
  AND ($4::date IS NULL OR a.attendance_date_ad <= $4)
  AND ($5::varchar IS NULL OR a.employee_id = $5)
  AND ($6::varchar IS NULL OR a.status = $6)
ORDER BY a.attendance_date_ad DESC, e.employee_code ASC, a.id ASC
LIMIT 2000`;

export const HR_ATTENDANCE_BY_ID_SQL = `SELECT ${HR_ATTENDANCE_COLUMNS}
FROM hr_attendance a
JOIN employees e ON e.id = a.employee_id
LEFT JOIN hr_shifts s ON s.id = a.shift_id
WHERE a.id = $1
LIMIT 1`;

/** The employee whose branch owns the attendance day, without PII columns. */
export const HR_ATTENDANCE_EMPLOYEE_BY_ID_SQL = `SELECT
  id,
  employee_code AS "employeeCode",
  name,
  branch_id AS "branchId",
  is_active AS "isActive"
FROM employees
WHERE id = $1
LIMIT 1`;

/** Batch lookup for the CSV importer; codes are normalized to upper case. */
export const HR_ATTENDANCE_EMPLOYEES_BY_CODES_SQL = `SELECT
  id,
  employee_code AS "employeeCode",
  name,
  branch_id AS "branchId",
  is_active AS "isActive"
FROM employees
WHERE employee_code = ANY($1::varchar[])
ORDER BY employee_code ASC`;

/** Existing employee+date keys, so the importer can report CREATE vs UPDATE. */
export const HR_ATTENDANCE_EXISTING_SQL = `SELECT
  employee_id AS "employeeId",
  attendance_date_ad::text AS "attendanceDateAD"
FROM hr_attendance
WHERE employee_id = ANY($1::varchar[])
  AND attendance_date_ad = ANY($2::date[])`;

export const HR_ATTENDANCE_UPSERT_SQL = `INSERT INTO hr_attendance (
  id, employee_id, branch_id, attendance_date_ad, attendance_date_bs, shift_id,
  status, check_in_time, check_out_time, overtime_hours, notes, source,
  is_demo, recorded_by, updated_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE, $13, $14)
ON CONFLICT (employee_id, attendance_date_ad) DO UPDATE SET
  branch_id = EXCLUDED.branch_id,
  attendance_date_bs = EXCLUDED.attendance_date_bs,
  shift_id = EXCLUDED.shift_id,
  status = EXCLUDED.status,
  check_in_time = EXCLUDED.check_in_time,
  check_out_time = EXCLUDED.check_out_time,
  overtime_hours = EXCLUDED.overtime_hours,
  notes = EXCLUDED.notes,
  source = EXCLUDED.source,
  updated_by = EXCLUDED.updated_by,
  updated_at = CURRENT_TIMESTAMP
RETURNING id`;

export const HR_ATTENDANCE_DELETE_SQL = `DELETE FROM hr_attendance
WHERE id = $1
RETURNING id`;
