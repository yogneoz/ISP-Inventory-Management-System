/**
 * Mobile client (PulseHR, `/api/v1/*`) — every statement that surface runs.
 *
 * The mobile API is a facade: it reads and writes the same tables the web UI
 * owns (employees, hr_attendance, hr_leave_requests, field_work_orders,
 * inventory_stock) and reuses the same services. What is mobile-specific lives
 * here: the device binding, the refresh-token store, the geofence row, the
 * attendance proof, the roster, and the sync cursor.
 *
 * Rules these statements rely on:
 *   - the attended employee is always derived from the signed-in account
 *     (`users.id` -> `employees.user_id`), never from a body field;
 *   - a punch is one row per employee per day (`UNIQUE (employee_id,
 *     attendance_date_ad)`), so CLOCK_IN then CLOCK_OUT is an upsert, not two
 *     rows;
 *   - the proof row is keyed by `attendance_id`, so a re-sent punch replaces the
 *     coordinates it had before instead of stacking duplicates;
 *   - `mobile_change_log.seq` is monotonic, so `/sync/pull` is one range scan.
 */

export const MOBILE_EMPLOYEE_BY_USER_SQL = `
  SELECT e.id,
         e.employee_code,
         e.name,
         e.branch_id,
         e.department,
         e.designation,
         e.personal_contact,
         e.personal_email,
         e.emergency_contact_person,
         e.emergency_contact_number,
         e.address,
         e.joining_date_ad,
         b.code AS branch_code,
         b.name AS branch_name,
         g.latitude AS geofence_latitude,
         g.longitude AS geofence_longitude,
         g.radius_meters AS geofence_radius_meters
    FROM users u
    JOIN employees e ON e.user_id = u.id
    JOIN branches b ON b.id = e.branch_id
    LEFT JOIN branch_geofences g ON g.branch_id = e.branch_id
   WHERE u.id = $1
   ORDER BY e.created_at
   LIMIT 1`;

/** One seat: the shift definition plus the day it was rostered on. */
export const MOBILE_ROSTER_SQL = `
  SELECT r.id,
         r.shift_date_ad,
         r.branch_id,
         b.code AS branch_code,
         s.code AS shift_code,
         s.name AS shift_name,
         s.start_time,
         s.end_time,
         s.grace_minutes
    FROM employee_shift_roster r
    JOIN hr_shifts s ON s.id = r.shift_id
    JOIN branches b ON b.id = r.branch_id
   WHERE r.employee_id = $1
     AND r.shift_date_ad BETWEEN $2::date AND $3::date
   ORDER BY r.shift_date_ad, s.start_time`;

export const MOBILE_ANNOUNCEMENTS_SQL = `
  SELECT id, title, summary, category, published_at, is_urgent
    FROM company_announcements
   WHERE published_at <= now()
     AND (branch_id IS NULL OR branch_id = $1)
   ORDER BY published_at DESC, id DESC
   LIMIT 20`;

export const MOBILE_PENDING_LEAVE_COUNT_SQL = `
  SELECT COUNT(*)::int AS pending
    FROM hr_leave_requests
   WHERE employee_id = $1 AND status = 'PENDING'`;

export const MOBILE_PENDING_CLAIM_COUNT_SQL = `
  SELECT COUNT(*)::int AS pending
    FROM hr_expense_claims
   WHERE employee_id = $1 AND status = 'SUBMITTED'`;

/** Today's attendance row, if the employee already punched. */
export const MOBILE_ATTENDANCE_TODAY_SQL = `
  SELECT id, check_in_time, check_out_time, status, source
    FROM hr_attendance
   WHERE employee_id = $1 AND attendance_date_ad = $2::date`;

/**
 * One row per employee per day. The first punch writes the row; a later punch
 * only fills the half that is still null, so a replayed CLOCK_IN cannot move a
 * check-in that already exists.
 */
export const MOBILE_ATTENDANCE_UPSERT_SQL = `
  INSERT INTO hr_attendance (
    id, employee_id, branch_id, attendance_date_ad, attendance_date_bs,
    status, check_in_time, check_out_time, source, recorded_by, updated_by
  )
  VALUES ($1, $2, $3, $4::date, $5, 'PRESENT', $6::time, $7::time, 'MOBILE', $8, $8)
  ON CONFLICT (employee_id, attendance_date_ad) DO UPDATE
     SET check_in_time = COALESCE(hr_attendance.check_in_time, EXCLUDED.check_in_time),
         check_out_time = COALESCE(EXCLUDED.check_out_time, hr_attendance.check_out_time),
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
  RETURNING id, attendance_date_ad, check_in_time, check_out_time, status, source`;

export const MOBILE_ATTENDANCE_PROOF_UPSERT_SQL = `
  INSERT INTO hr_attendance_proofs (
    attendance_id, latitude, longitude, distance_meters, gps_accuracy_meters,
    wifi_bssid, device_id, device_time_epoch_ms, inside_geofence,
    integrity_status, risk_score, integrity_notes
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (attendance_id) DO UPDATE
     SET latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         distance_meters = EXCLUDED.distance_meters,
         gps_accuracy_meters = EXCLUDED.gps_accuracy_meters,
         wifi_bssid = EXCLUDED.wifi_bssid,
         device_id = EXCLUDED.device_id,
         device_time_epoch_ms = EXCLUDED.device_time_epoch_ms,
         inside_geofence = EXCLUDED.inside_geofence,
         integrity_status = EXCLUDED.integrity_status,
         risk_score = EXCLUDED.risk_score,
         integrity_notes = EXCLUDED.integrity_notes,
         server_received_at = now()
  RETURNING attendance_id, integrity_status, risk_score`;

/**
 * A device is bound to the employee that registered it. The `WHERE` on the
 * conflict target is what refuses a second employee binding someone else's
 * device id: the update matches nothing and zero rows come back.
 */
export const MOBILE_DEVICE_BIND_SQL = `
  INSERT INTO mobile_devices (device_id, employee_id, model_name, app_version)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (device_id) DO UPDATE
     SET model_name = EXCLUDED.model_name,
         app_version = EXCLUDED.app_version,
         last_seen_at = now()
   WHERE mobile_devices.employee_id = EXCLUDED.employee_id
  RETURNING device_id, bound_at, employee_id`;

export const MOBILE_DEVICE_OWNER_SQL = `
  SELECT device_id, employee_id, revoked_at
    FROM mobile_devices
   WHERE device_id = $1`;

export const MOBILE_REFRESH_INSERT_SQL = `
  INSERT INTO mobile_refresh_tokens (user_id, device_id, token_hash, expires_at)
  VALUES ($1, $2, $3, $4)
  RETURNING id`;

export const MOBILE_REFRESH_FIND_SQL = `
  SELECT t.id, t.user_id, t.expires_at
    FROM mobile_refresh_tokens t
   WHERE t.token_hash = $1
     AND t.revoked_at IS NULL
     AND t.expires_at > now()`;

export const MOBILE_REFRESH_REVOKE_SQL = `
  UPDATE mobile_refresh_tokens
     SET revoked_at = now()
   WHERE token_hash = $1 AND revoked_at IS NULL`;

export const MOBILE_FCM_UPSERT_SQL = `
  INSERT INTO mobile_fcm_tokens (employee_id, device_id, fcm_token, platform, topics)
  VALUES ($1, $2, $3, $4, $5::text[])
  ON CONFLICT (fcm_token) DO UPDATE
     SET employee_id = EXCLUDED.employee_id,
         device_id = EXCLUDED.device_id,
         platform = EXCLUDED.platform,
         topics = EXCLUDED.topics,
         is_active = TRUE,
         updated_at = now()
  RETURNING id, topics`;

export const MOBILE_CLAIM_INSERT_SQL = `
  INSERT INTO hr_expense_claims (
    id, employee_id, branch_id, category, amount, currency, ticket_code,
    description, receipt_attached
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  RETURNING id, status, submitted_at`;

export const MOBILE_CLAIM_BY_ID_SQL = `
  SELECT id, status, submitted_at, amount, category
    FROM hr_expense_claims
   WHERE id = $1 AND employee_id = $2`;

export const MOBILE_DELEGATION_INSERT_SQL = `
  INSERT INTO hr_delegations (
    id, delegator_employee_id, delegate_employee_id, capabilities,
    start_date_ad, end_date_ad, created_by, start_date_bs, end_date_bs
  )
  VALUES ($1, $2, $3, $4::text[], $5::date, $6::date, $7, $8, $9)
  RETURNING id, start_date_ad, end_date_ad, capabilities`;

export const MOBILE_DELEGATE_EXISTS_SQL = `
  SELECT id, name, branch_id FROM employees WHERE id = $1`;

export const MOBILE_LEAVE_BY_ID_SQL = `
  SELECT id, request_no, status, employee_id, days_count
    FROM hr_leave_requests
   WHERE id = $1`;

/** The supervisor queue: pending requests in the caller's branch. */
export const MOBILE_LEAVE_QUEUE_SQL = `
  SELECT r.id, r.request_no, r.status, r.start_date_ad, r.end_date_ad, r.days_count,
         r.reason, r.employee_id, e.name AS employee_name, e.employee_code
    FROM hr_leave_requests r
    JOIN employees e ON e.id = r.employee_id
   WHERE r.branch_id = $1 AND r.status = 'PENDING'
   ORDER BY r.created_at
   LIMIT 100`;

/**
 * A breadcrumb batch may be re-sent after a timeout. `id` is the client's own
 * point id, so the conflict clause makes the batch idempotent without a
 * separate key table.
 */
export const MOBILE_BREADCRUMB_INSERT_SQL = `
  INSERT INTO employee_location_breadcrumbs (
    id, employee_id, device_id, route_session_id, event_type, latitude, longitude,
    accuracy_meters, site_label, captured_at_epoch_ms, captured_at, branch_id
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, to_timestamp($10::bigint / 1000.0), $11)
  ON CONFLICT (id) DO NOTHING`;

export const MOBILE_CHANGE_INSERT_SQL = `
  INSERT INTO mobile_change_log (entity, entity_id, operation, branch_id, employee_id, payload)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  RETURNING seq`;

export const MOBILE_CHANGE_PULL_SQL = `
  SELECT seq, entity, entity_id, operation, changed_at, payload
    FROM mobile_change_log
   WHERE seq > $1
     AND (employee_id = $2 OR employee_id IS NULL)
   ORDER BY seq
   LIMIT $3`;

export const MOBILE_WORK_ORDER_SQL = `
  SELECT id, work_order_no, status, branch_id, technician_id, row_version
    FROM field_work_orders
   WHERE id = $1 AND technician_id = $2`;

/**
 * Completion is guarded three ways at once: the technician must own the order,
 * the order must still be open or assigned, and the version must match what the
 * phone read. A stale phone gets zero rows, which the controller turns into 409.
 */
export const MOBILE_WORK_ORDER_COMPLETE_SQL = `
  UPDATE field_work_orders
     SET status = 'COMPLETED',
         completed_at = now(),
         completion_notes = $4,
         ont_serial = COALESCE($5, ont_serial),
         row_version = row_version + 1,
         updated_at = now()
   WHERE id = $1
     AND technician_id = $2
     AND status IN ('OPEN', 'ASSIGNED')
     AND row_version = $3
  RETURNING id, work_order_no, status, row_version`;

export const MOBILE_EMPLOYEE_STOCK_CONSUME_SQL = `
  INSERT INTO employee_stock_movements (
    employee_id, product_id, branch_id, movement_type, quantity, work_order_id, reason, actor
  )
  VALUES ($1, $2, $3, 'CONSUME', $4, $5, $6, $7)
  RETURNING id`;

/** The app's contact card: only the three fields the phone owns. */
export const MOBILE_CONTACT_UPDATE_SQL = `
  UPDATE employees
     SET personal_contact = COALESCE($2, personal_contact),
         emergency_contact_person = COALESCE($3, emergency_contact_person),
         emergency_contact_number = COALESCE($4, emergency_contact_number)
   WHERE id = $1
  RETURNING id, personal_contact, emergency_contact_person, emergency_contact_number`;

/** Shared by the mobile and partner surfaces; the scope keeps keys apart. */
export const IDEMPOTENCY_LOOKUP_SQL = `
  SELECT request_hash, response_status, response_body
    FROM idempotency_keys
   WHERE scope = $1 AND idempotency_key = $2`;

export const IDEMPOTENCY_INSERT_SQL = `
  INSERT INTO idempotency_keys (scope, idempotency_key, request_hash, response_status, response_body)
  VALUES ($1, $2, $3, $4, $5::jsonb)
  ON CONFLICT (scope, idempotency_key) DO NOTHING
  RETURNING id`;

/** Stores the response a replay will return, inside the writing transaction. */
export const IDEMPOTENCY_COMPLETE_SQL = `
  UPDATE idempotency_keys
     SET response_status = $3,
         response_body = $4::jsonb
   WHERE scope = $1 AND idempotency_key = $2`;
