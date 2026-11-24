/**
 * Shift roster (`employee_shift_roster`) — the writer the table never had.
 *
 * Before this, the table was read by the mobile bootstrap and by nothing else,
 * so `shiftWindow` could only ever be `NO_SHIFT` in a real deployment. These
 * statements are the only writer: a seat is one employee on one date in one
 * shift, the branch always comes from the caller's scope, and the BS half is
 * supplied by the service (dual-date pairing).
 */

export const HR_SHIFT_ROSTER_LIST_SQL = `
  SELECT r.id,
         r.employee_id AS "employeeId",
         e.employee_code AS "employeeCode",
         e.name AS "employeeName",
         r.shift_id AS "shiftId",
         s.code AS "shiftCode",
         s.name AS "shiftName",
         s.start_time AS "startTime",
         s.end_time AS "endTime",
         r.branch_id AS "branchId",
         r.shift_date_ad::text AS "shiftDateAD",
         r.shift_date_bs AS "shiftDateBS",
         r.source,
         r.created_at AS "createdAt"
    FROM employee_shift_roster r
    JOIN employees e ON e.id = r.employee_id
    JOIN hr_shifts s ON s.id = r.shift_id
   WHERE r.branch_id = $1
     AND r.shift_date_ad BETWEEN $2::date AND $3::date
   ORDER BY r.shift_date_ad, s.start_time, e.name`;

/** The employee must belong to the branch the roster row is written into. */
export const HR_SHIFT_ROSTER_EMPLOYEE_SQL = `
  SELECT id, name, branch_id AS "branchId"
    FROM employees
   WHERE id = $1`;

export const HR_SHIFT_ROSTER_SHIFT_EXISTS_SQL = `
  SELECT id FROM hr_shifts WHERE id = $1`;

/**
 * One seat per employee/date/shift. A re-submitted week edits the existing row
 * instead of stacking duplicates, and the BS half always follows the AD date.
 */
export const HR_SHIFT_ROSTER_UPSERT_SQL = `
  INSERT INTO employee_shift_roster (
    id, employee_id, shift_id, branch_id, shift_date_ad, shift_date_bs, source
  )
  VALUES ($1, $2, $3, $4, $5::date, $6, 'ROSTER')
  ON CONFLICT (employee_id, shift_date_ad, shift_id) DO UPDATE
     SET branch_id = EXCLUDED.branch_id,
         shift_date_bs = EXCLUDED.shift_date_bs
  RETURNING id, employee_id AS "employeeId", shift_id AS "shiftId",
            branch_id AS "branchId", shift_date_ad::text AS "shiftDateAD",
            shift_date_bs AS "shiftDateBS"`;

/** The branch predicate is part of the delete, not a check before it. */
export const HR_SHIFT_ROSTER_DELETE_SQL = `
  DELETE FROM employee_shift_roster
   WHERE id = $1 AND branch_id = $2
  RETURNING id`;

/** The roster rows a dispatch board needs, for a branch and a date window. */
export const HR_SHIFT_ROSTER_AVAILABILITY_SQL = `
  SELECT r.employee_id AS "employeeId",
         e.name AS "employeeName",
         e.designation,
         s.code AS "shiftCode",
         s.name AS "shiftName",
         s.start_time AS "startTime",
         s.end_time AS "endTime",
         r.shift_date_ad::text AS "shiftDateAD"
    FROM employee_shift_roster r
    JOIN employees e ON e.id = r.employee_id
    JOIN hr_shifts s ON s.id = r.shift_id
   WHERE r.branch_id = $1
     AND r.shift_date_ad = $2::date
   ORDER BY s.start_time, e.name`;
