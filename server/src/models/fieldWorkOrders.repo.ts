/**
 * Field work-order repository — every statement the technician work orders run.
 *
 * All SQL lives here so `check:no-inline-sql` stays green and the controller
 * keeps only validation and scope decisions. Branch scope is a WHERE clause, not
 * a post-filter: a caller that may see one branch never reads another's rows.
 */
import { pgPool } from '../../db';
import { resolveBsDateForLedgerSync } from '../utils/bsDate';

export interface FieldWorkOrderRow {
  id: string;
  work_order_no: string;
  branch_id: string;
  customer_id: string;
  customer_name: string | null;
  kind: string;
  status: string;
  technician_id: string | null;
  technician_name: string | null;
  scheduled_date_ad: string;
  ont_serial: string | null;
  router_serial: string | null;
  ip_address: string | null;
  plan_name: string | null;
  notes: string;
  completion_notes: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  w.id, w.work_order_no, w.branch_id, w.customer_id, c.customer_name,
  w.kind, w.status, w.technician_id, w.technician_name, w.scheduled_date_ad,
  w.ont_serial, w.router_serial, w.ip_address, w.plan_name, w.notes,
  w.completion_notes, w.completed_at, w.created_by, w.created_at, w.updated_at`;

export async function listFieldWorkOrders(options: {
  branchId?: string;
  branchIds?: string[];
  status?: string;
  customerId?: string;
}): Promise<FieldWorkOrderRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.branchId) {
    params.push(options.branchId);
    where.push(`w.branch_id = $${params.length}`);
  } else if (options.branchIds && options.branchIds.length > 0) {
    params.push(options.branchIds);
    where.push(`w.branch_id = ANY($${params.length}::text[])`);
  }
  if (options.status) {
    params.push(options.status);
    where.push(`w.status = $${params.length}`);
  }
  if (options.customerId) {
    params.push(options.customerId);
    where.push(`w.customer_id = $${params.length}`);
  }
  const result = await pgPool.query(
    `SELECT ${SELECT_COLUMNS}
       FROM field_work_orders w
       LEFT JOIN customer_records c ON c.id = w.customer_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY w.scheduled_date_ad DESC, w.created_at DESC
      LIMIT 500`,
    params
  );
  return result.rows;
}

export async function findFieldWorkOrder(id: string): Promise<FieldWorkOrderRow | null> {
  const result = await pgPool.query(
    `SELECT ${SELECT_COLUMNS}
       FROM field_work_orders w
       LEFT JOIN customer_records c ON c.id = w.customer_id
      WHERE w.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function customerInBranch(customerId: string, branchId: string): Promise<boolean> {
  const result = await pgPool.query(
    `SELECT 1 FROM customer_records WHERE id = $1 AND branch_id = $2`,
    [customerId, branchId]
  );
  return result.rows.length > 0;
}

export async function employeeInBranch(employeeId: string, branchId: string): Promise<boolean> {
  const result = await pgPool.query(
    `SELECT 1 FROM employees WHERE id = $1 AND branch_id = $2`,
    [employeeId, branchId]
  );
  return result.rows.length > 0;
}

export async function insertFieldWorkOrder(input: {
  branchId: string;
  customerId: string;
  kind: string;
  scheduledDateAd: string;
  technicianId: string | null;
  technicianName: string | null;
  ontSerial: string | null;
  routerSerial: string | null;
  ipAddress: string | null;
  planName: string | null;
  notes: string;
  createdBy: string;
}): Promise<FieldWorkOrderRow> {
  const result = await pgPool.query(
    `WITH next_no AS (
       SELECT 'WO-' || to_char(now(), 'YYYYMM') || '-' ||
              lpad(nextval('field_work_order_no_seq')::text, 4, '0') AS no
     )
     INSERT INTO field_work_orders (
       work_order_no, branch_id, customer_id, kind, status, technician_id,
       technician_name, scheduled_date_ad, scheduled_date_bs, ont_serial, router_serial, ip_address,
       plan_name, notes, created_by
     )
     SELECT next_no.no, $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14
       FROM next_no
     RETURNING id`,
    [
      input.branchId,
      input.customerId,
      input.kind,
      input.technicianName ? 'ASSIGNED' : 'OPEN',
      input.technicianId,
      input.technicianName,
      input.scheduledDateAd,
      resolveBsDateForLedgerSync(input.scheduledDateAd),
      input.ontSerial,
      input.routerSerial,
      input.ipAddress,
      input.planName,
      input.notes,
      input.createdBy,
    ]
  );
  const row = await findFieldWorkOrder(result.rows[0].id);
  if (!row) throw new Error('field work order disappeared after insert');
  return row;
}

/**
 * Assign (or reassign) a technician. Refused once the order is closed. A plain
 * assignment clears any earlier override: the row must describe the current
 * decision, not a waiver that no longer applies.
 */
export async function assignFieldWorkOrder(
  id: string,
  technicianId: string | null,
  technicianName: string,
  override: { reason: string | null; by: string | null; rules: string[] } | null = null
): Promise<FieldWorkOrderRow | null> {
  const result = await pgPool.query(
    `UPDATE field_work_orders
        SET technician_id = $2, technician_name = $3, status = 'ASSIGNED',
            dispatch_override_reason = $4::varchar,
            dispatch_override_by = $5::varchar,
            dispatch_override_at = CASE WHEN $4::varchar IS NULL THEN NULL ELSE now() END,
            dispatch_override_rules = $6::text[],
            updated_at = now()
      WHERE id = $1 AND status IN ('OPEN', 'ASSIGNED')
      RETURNING id`,
    [id, technicianId, technicianName, override?.reason || null, override?.by || null, override?.rules || []]
  );
  if (!result.rows[0]) return null;
  return findFieldWorkOrder(id);
}

/**
 * What the dispatch rules need to know about one technician on one date: how
 * many open or assigned jobs they already hold that day, and whether the roster
 * gives them a seat at all.
 */
export async function technicianDispatchState(
  technicianId: string,
  dateAD: string
): Promise<{ openJobs: number; rostered: boolean }> {
  const [jobs, roster] = await Promise.all([
    pgPool.query(
      `SELECT COUNT(*)::int AS count
         FROM field_work_orders
        WHERE technician_id = $1 AND scheduled_date_ad = $2::date
          AND status IN ('OPEN', 'ASSIGNED')`,
      [technicianId, dateAD]
    ),
    pgPool.query(
      `SELECT 1 FROM employee_shift_roster
        WHERE employee_id = $1 AND shift_date_ad = $2::date
        LIMIT 1`,
      [technicianId, dateAD]
    ),
  ]);
  return { openJobs: Number(jobs.rows[0]?.count || 0), rostered: roster.rows.length > 0 };
}

/**
 * Complete a visit. The WHERE clause carries the state rule, so two concurrent
 * completions cannot both land: only the first sees a non-completed row.
 */
export interface CompleteWorkOrderInput {
  completionNotes: string;
  ontSerial: string | null;
  routerSerial: string | null;
  ipAddress: string | null;
  planName: string | null;
}

/**
 * The completion UPDATE, runnable inside the caller's transaction.
 *
 * Installing the CPE the technician carried is part of closing the visit, so the
 * web completion opens one transaction, completes through this and installs; a
 * refused install rolls the completion back rather than closing a job whose
 * device never reached the customer.
 */
export async function completeFieldWorkOrderInTransaction(
  client: any,
  id: string,
  input: CompleteWorkOrderInput
): Promise<boolean> {
  const result = await client.query(
    `UPDATE field_work_orders
        SET status = 'COMPLETED', completion_notes = $2,
            ont_serial = COALESCE($3, ont_serial),
            router_serial = COALESCE($4, router_serial),
            ip_address = COALESCE($5, ip_address),
            plan_name = COALESCE($6, plan_name),
            completed_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('OPEN', 'ASSIGNED')
      RETURNING id`,
    [id, input.completionNotes, input.ontSerial, input.routerSerial, input.ipAddress, input.planName]
  );
  return Boolean(result.rows[0]);
}

/**
 * One order locked while its completion installs the unit it delivered. The
 * customer join is part of the read: the install stamps the customer the order
 * names, never one the caller claimed.
 */
export const FWO_INSTALL_LOCK_SQL = `SELECT w.id, w.work_order_no, w.branch_id,
         w.customer_id, c.customer_name AS "customerName",
         w.status, w.technician_id AS "technicianId", w.kind
    FROM field_work_orders w
    LEFT JOIN customer_records c ON c.id = w.customer_id
   WHERE w.id = $1
   FOR UPDATE OF w`;

export async function completeFieldWorkOrder(
  id: string,
  input: CompleteWorkOrderInput
): Promise<FieldWorkOrderRow | null> {
  const result = await pgPool.query(
    `UPDATE field_work_orders
        SET status = 'COMPLETED', completion_notes = $2,
            ont_serial = COALESCE($3, ont_serial),
            router_serial = COALESCE($4, router_serial),
            ip_address = COALESCE($5, ip_address),
            plan_name = COALESCE($6, plan_name),
            completed_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('OPEN', 'ASSIGNED')
      RETURNING id`,
    [id, input.completionNotes, input.ontSerial, input.routerSerial, input.ipAddress, input.planName]
  );
  if (!result.rows[0]) return null;
  return findFieldWorkOrder(id);
}

export async function cancelFieldWorkOrder(id: string): Promise<FieldWorkOrderRow | null> {
  const result = await pgPool.query(
    `UPDATE field_work_orders
        SET status = 'CANCELLED', updated_at = now()
      WHERE id = $1 AND status IN ('OPEN', 'ASSIGNED')
      RETURNING id`,
    [id]
  );
  if (!result.rows[0]) return null;
  return findFieldWorkOrder(id);
}
