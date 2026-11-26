/**
 * Per-employee stock custody repository — the ledger behind the My Stock panel
 * and the employee profile's Equipment section.
 *
 * `employee_stock_movements` is append-only and is the truth; the holdings row
 * is a projection rebuilt from those movements inside the same transaction, so
 * the two cannot drift. Every write also touches `inventory_stock` when the
 * units enter or leave branch stock (issue takes them out, return puts them
 * back), which is why each of them runs through `withTransaction`.
 *
 * Branch scope is a WHERE clause, not a post-filter: a caller that may see one
 * branch never reads another's rows.
 */
import crypto from 'node:crypto';
import { businessDateAD } from '../../../shared/businessDate';
import { pgPool } from '../../db';
import { withTransaction } from '../db/transactions';
import {
  custodySerials,
  issueCustodySerialsInDb,
  releaseCustodySerialsInDb,
  transferCustodySerialsInDb,
} from '../services/serialCustody.service';
import { installHeldAssetAtCustomer, type InstallHeldAssetResult } from '../services/custodyInstall.service';
import { AR_INSERT_SQL, arInsertParams } from './misc.repo';
import type { ApprovalRequest } from '../../../client/src/types';

export type EmployeeStockMovementType =
  | 'ISSUE'
  | 'RETURN'
  | 'CONSUME'
  | 'LOSS'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN';

export interface EmployeeStockHoldingRow {
  employee_id: string;
  employee_code: string;
  employee_name: string;
  product_id: string;
  product_code: string;
  product_name: string;
  branch_id: string;
  branch_name: string;
  quantity: number;
  updated_at: string;
}

export interface EmployeeStockMovementRow {
  id: string;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  product_id: string;
  product_code: string;
  product_name: string;
  branch_id: string;
  branch_name: string;
  movement_type: EmployeeStockMovementType;
  quantity: number;
  work_order_id: string | null;
  work_order_no: string | null;
  reason: string | null;
  actor: string;
  /** The other person in a custody transfer; null for every other movement. */
  counterparty_employee_id: string | null;
  counterparty_name: string | null;
  transfer_group_id: string | null;
  /** The stock operation that issued these units, when one did. */
  custody_group_id: string | null;
  created_at: string;
}

/**
 * A refusal the controller can turn into a precise status: a branch with too
 * little stock or a person who never had the units is a 409, an unknown
 * employee or product is a 400.
 */
export type EmployeeStockRefusalCode =
  | 'INSUFFICIENT_BRANCH_STOCK'
  | 'INSUFFICIENT_HOLDING'
  | 'UNKNOWN_EMPLOYEE'
  | 'UNKNOWN_PRODUCT'
  | 'UNKNOWN_WORK_ORDER'
  | 'REASON_REQUIRED'
  | 'SAME_EMPLOYEE'
  | 'CROSS_BRANCH_TRANSFER';

export class EmployeeStockRefusal extends Error {
  readonly code: EmployeeStockRefusalCode;
  constructor(code: EmployeeStockRefusalCode, message: string) {
    super(message);
    this.name = 'EmployeeStockRefusal';
    this.code = code;
  }
}

const HOLDING_SELECT = `
  SELECT h.employee_id, e.employee_code, e.name AS employee_name,
         h.product_id, p.sku AS product_code, p.name AS product_name,
         h.branch_id, b.name AS branch_name, h.quantity, h.updated_at
    FROM employee_stock_holdings h
    JOIN employees e ON e.id = h.employee_id
    JOIN products p ON p.id = h.product_id
    JOIN branches b ON b.id = h.branch_id`;

const MOVEMENT_SELECT = `
  SELECT m.id, m.employee_id, e.employee_code, e.name AS employee_name,
         m.product_id, p.sku AS product_code, p.name AS product_name,
         m.branch_id, b.name AS branch_name, m.movement_type, m.quantity,
         m.work_order_id, w.work_order_no, m.reason, m.actor,
         m.counterparty_employee_id, ce.name AS counterparty_name,
         m.transfer_group_id, m.custody_group_id, m.created_at
    FROM employee_stock_movements m
    JOIN employees e ON e.id = m.employee_id
    JOIN products p ON p.id = m.product_id
    JOIN branches b ON b.id = m.branch_id
    LEFT JOIN field_work_orders w ON w.id = m.work_order_id
    LEFT JOIN employees ce ON ce.id = m.counterparty_employee_id`;

export interface EmployeeStockQuery {
  branchIds?: string[] | null;
  employeeId?: string;
  productId?: string;
}

/** Holdings, branch-scoped and optionally narrowed to one person or product. */
export async function listEmployeeStockHoldings(options: EmployeeStockQuery): Promise<EmployeeStockHoldingRow[]> {
  const result = await pgPool.query(
    `${HOLDING_SELECT}
      WHERE ($1::text[] IS NULL OR h.branch_id = ANY($1::text[]))
        AND ($2::text IS NULL OR h.employee_id = $2)
        AND ($3::text IS NULL OR h.product_id = $3)
      ORDER BY e.name ASC, p.name ASC
      LIMIT 500`,
    [options.branchIds && options.branchIds.length ? options.branchIds : null, options.employeeId || null, options.productId || null]
  );
  return result.rows;
}

/** The movement log for one employee (the profile and My Stock history). */
export async function listEmployeeStockMovements(options: {
  branchIds?: string[] | null;
  employeeId: string;
  limit?: number;
}): Promise<EmployeeStockMovementRow[]> {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const result = await pgPool.query(
    `${MOVEMENT_SELECT}
      WHERE m.employee_id = $1
        AND ($2::text[] IS NULL OR m.branch_id = ANY($2::text[]))
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [options.employeeId, options.branchIds && options.branchIds.length ? options.branchIds : null, limit]
  );
  return result.rows;
}

export interface CustodyEmployeeRow {
  id: string;
  employee_code: string;
  name: string;
  department: string | null;
  branch_id: string;
}

/**
 * The branch roster the custody actions pick a person from.
 *
 * Issuing equipment to someone and transferring it between two people both need
 * a recipient list, and `employee-stock-view` already authorises exactly those
 * screens. Reading it through `/api/employees` instead demanded `hr-employee-view`
 * as well, an HR permission the branch manager who owns custody does not hold, so
 * the holder had no way to name the person the units were for.
 */
export async function listCustodyEmployees(branchIds: string[] | null): Promise<CustodyEmployeeRow[]> {
  const result = await pgPool.query(
    `SELECT id, employee_code, name, department, branch_id
       FROM employees
      WHERE ($1::text[] IS NULL OR branch_id = ANY($1::text[]))
      ORDER BY name ASC
      LIMIT 1000`,
    [branchIds && branchIds.length ? branchIds : null]
  );
  return result.rows;
}

export interface EmployeeStockCustodyProduct {
  product_id: string;
  product_code: string;
  product_name: string;
  quantity: number;
}

export interface EmployeeStockCustody {
  /** Distinct products with a non-zero holding. */
  items: number;
  /** Total units across those holdings. */
  units: number;
  products: EmployeeStockCustodyProduct[];
}

/**
 * The live holdings of one employee — what the offboarding checklist shows and
 * what its completion refuses on.
 *
 * Passing a transaction client reads (and optionally locks) inside the caller's
 * transaction, so the completion check sees exactly the rows a concurrent
 * return would have to touch. There is no stored copy of this summary: the
 * holdings table is the only source, so a cached checklist cannot disagree
 * with the completion read for longer than one request.
 */
export async function readEmployeeStockCustody(
  employeeId: string,
  options: { client?: any; forUpdate?: boolean } = {}
): Promise<EmployeeStockCustody> {
  const runner = options.client || pgPool;
  const result = await runner.query(
    `SELECT h.product_id, p.sku AS product_code, p.name AS product_name, h.quantity
       FROM employee_stock_holdings h
       JOIN products p ON p.id = h.product_id
      WHERE h.employee_id = $1 AND h.quantity > 0
      ORDER BY p.name ASC
      ${options.forUpdate ? 'FOR UPDATE OF h' : ''}`,
    [employeeId]
  );
  const products: EmployeeStockCustodyProduct[] = result.rows.map((row: any) => ({
    product_id: row.product_id,
    product_code: row.product_code,
    product_name: row.product_name,
    quantity: Number(row.quantity),
  }));
  return {
    items: products.length,
    units: products.reduce((sum, row) => sum + row.quantity, 0),
    products,
  };
}

/** The branch an employee belongs to — the default custody branch of a write. */
export async function employeeBranchId(employeeId: string): Promise<string | null> {
  const result = await pgPool.query('SELECT branch_id FROM employees WHERE id = $1', [employeeId]);
  return result.rows[0]?.branch_id || null;
}

/** The same lookup inside the caller's transaction (a transfer locks nothing else). */
async function employeeBranchIdInTransaction(client: any, employeeId: string): Promise<string | null> {
  const result = await client.query('SELECT branch_id FROM employees WHERE id = $1', [employeeId]);
  return result.rows[0]?.branch_id || null;
}

async function assertEmployeeInBranch(client: any, employeeId: string, branchId: string): Promise<void> {
  const result = await client.query('SELECT 1 FROM employees WHERE id = $1 AND branch_id = $2', [employeeId, branchId]);
  if (result.rows.length === 0) {
    throw new EmployeeStockRefusal('UNKNOWN_EMPLOYEE', 'That employee is not in the selected branch.');
  }
}

async function assertProductExists(client: any, productId: string): Promise<void> {
  const result = await client.query('SELECT 1 FROM products WHERE id = $1', [productId]);
  if (result.rows.length === 0) {
    throw new EmployeeStockRefusal('UNKNOWN_PRODUCT', 'That product does not exist.');
  }
}

async function assertWorkOrderInBranch(client: any, workOrderId: string, branchId: string): Promise<void> {
  const result = await client.query('SELECT 1 FROM field_work_orders WHERE id = $1 AND branch_id = $2', [workOrderId, branchId]);
  if (result.rows.length === 0) {
    throw new EmployeeStockRefusal('UNKNOWN_WORK_ORDER', 'That work order is not in the selected branch.');
  }
}

/** Takes units out of branch stock; a shortfall is a refusal, never a negative row. */
async function consumeBranchStock(client: any, productId: string, branchId: string, quantity: number): Promise<void> {
  const result = await client.query(
    `UPDATE inventory_stock
        SET quantity_on_hand = quantity_on_hand - $1,
            last_updated = CURRENT_TIMESTAMP
      WHERE product_id = $2 AND branch_id = $3 AND quantity_on_hand >= $1`,
    [quantity, productId, branchId]
  );
  if (result.rowCount === 0) {
    throw new EmployeeStockRefusal('INSUFFICIENT_BRANCH_STOCK', 'The branch does not hold that many units.');
  }
}

/** Puts units back, creating the stock row when the branch never held any. */
async function restoreBranchStock(client: any, productId: string, branchId: string, quantity: number): Promise<void> {
  await client.query(
    `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (product_id, branch_id) DO UPDATE
       SET quantity_on_hand = inventory_stock.quantity_on_hand + $4,
           last_updated = CURRENT_TIMESTAMP`,
    [`stk-${branchId.toLowerCase()}-${productId}`, productId, branchId, quantity]
  );
}

/**
 * Appends one movement, then rebuilds the projection from the log.
 *
 * The projection is the signed sum of the movements (`ISSUE` adds, the other
 * three subtract), so a holding can never disagree with its history. A negative
 * sum means the person was asked to return/consume/lose units they do not hold:
 * the whole transaction rolls back, stock included.
 */
async function appendMovement(
  client: any,
  input: {
    employeeId: string;
    productId: string;
    branchId: string;
    type: EmployeeStockMovementType;
    quantity: number;
    workOrderId: string | null;
    reason: string | null;
    actor: string;
    counterpartyEmployeeId?: string | null;
    transferGroupId?: string | null;
    custodyGroupId?: string | null;
  }
): Promise<EmployeeStockMovementRow> {
  const inserted = await client.query(
    `INSERT INTO employee_stock_movements
       (employee_id, product_id, branch_id, movement_type, quantity, work_order_id, reason, actor,
        counterparty_employee_id, transfer_group_id, custody_group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.employeeId,
      input.productId,
      input.branchId,
      input.type,
      input.quantity,
      input.workOrderId,
      input.reason,
      input.actor,
      input.counterpartyEmployeeId || null,
      input.transferGroupId || null,
      input.custodyGroupId || null,
    ]
  );

  // ISSUE and TRANSFER_IN add units; everything else (RETURN, CONSUME, LOSS,
  // TRANSFER_OUT) subtracts them.
  const sum = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN movement_type IN ('ISSUE', 'TRANSFER_IN') THEN quantity ELSE -quantity END), 0)::int AS quantity
       FROM employee_stock_movements
      WHERE employee_id = $1 AND product_id = $2 AND branch_id = $3`,
    [input.employeeId, input.productId, input.branchId]
  );
  const projected = Number(sum.rows[0]?.quantity || 0);
  if (projected < 0) {
    throw new EmployeeStockRefusal(
      'INSUFFICIENT_HOLDING',
      input.type === 'RETURN'
        ? 'That employee does not hold that many units to return.'
        : 'That employee does not hold that many units.'
    );
  }

  if (projected === 0) {
    await client.query(
      'DELETE FROM employee_stock_holdings WHERE employee_id = $1 AND product_id = $2 AND branch_id = $3',
      [input.employeeId, input.productId, input.branchId]
    );
  } else {
    await client.query(
      `INSERT INTO employee_stock_holdings (employee_id, product_id, branch_id, quantity, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (employee_id, product_id, branch_id) DO UPDATE
         SET quantity = EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
      [input.employeeId, input.productId, input.branchId, projected]
    );
  }

  const movement = await client.query(`${MOVEMENT_SELECT} WHERE m.id = $1`, [inserted.rows[0].id]);
  return movement.rows[0];
}

export interface MovementInput {
  employeeId: string;
  productId: string;
  branchId: string;
  quantity: number;
  workOrderId?: string | null;
  reason?: string | null;
  actor: string;
  /** Device serials this movement carries; serial-tracked products only. */
  serials?: string[];
  /** The customer a consumed unit was installed at (CONSUME only). */
  customerId?: string | null;
  customerName?: string | null;
  /**
   * CONSUME only. true (default): every named serial must be held by this
   * person. false: only the units this person really holds are installed, and a
   * serial that is not in custody is left alone — the phone also records a
   * serial purely as the work order's ONT tag.
   */
  strictSerials?: boolean;
}

/** The day a custody move is stamped with in the register's history. */
function custodyDateAD(): string {
  // The register's dates are business dates (Nepal wall clock), never the UTC
  // day — a late-evening issue must not land on tomorrow's register day.
  return businessDateAD();
}

/**
 * Records which units a movement carried. Written after the register moved, so a
 * lenient release (the phone's completion) never claims a serial it left behind.
 */
async function linkMovementSerials(
  client: any,
  movementId: string | number,
  input: { productId: string; branchId: string },
  serials: readonly string[]
): Promise<void> {
  for (const serial of custodySerials(serials)) {
    await client.query(
      `INSERT INTO employee_stock_movement_serials (movement_id, device_serial, product_id, branch_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (movement_id, device_serial) DO NOTHING`,
      [movementId, serial, input.productId, input.branchId]
    );
  }
}

/**
 * The four movements as client-taking cores.
 *
 * The stock-operation form and the phone already own a transaction; opening a
 * second one there would commit half a document. The public functions below
 * wrap these in `withTransaction`, so whichever caller runs, there is exactly
 * one writer: the custody ledger and `inventory_stock` move (or roll back)
 * together.
 */
export async function issueEmployeeStockInTransaction(
  client: any,
  input: MovementInput,
  custodyGroupId: string | null = null
): Promise<EmployeeStockMovementRow> {
  await assertEmployeeInBranch(client, input.employeeId, input.branchId);
  await assertProductExists(client, input.productId);
  if (input.workOrderId) await assertWorkOrderInBranch(client, input.workOrderId, input.branchId);
  await consumeBranchStock(client, input.productId, input.branchId, input.quantity);
  const movement = await appendMovement(client, {
    ...input,
    type: 'ISSUE',
    workOrderId: input.workOrderId || null,
    reason: input.reason || null,
    custodyGroupId,
  });
  // A serialised unit follows the quantity: the register must say the person
  // holds it, or the van and My Stock would disagree about the same device.
  const serials = await issueCustodySerialsInDb(client, {
    employeeId: input.employeeId,
    productId: input.productId,
    branchId: input.branchId,
    serials: input.serials || [],
    sourceType: 'CUSTODY_ISSUE',
    sourceId: `movement:${movement.id}`,
    dateAD: custodyDateAD(),
    note: `Issued to ${input.employeeId}${input.reason ? ` — ${input.reason}` : ''}`,
  });
  await linkMovementSerials(client, movement.id, input, serials);
  return movement;
}

/** ISSUE: branch stock out, employee holding up. */
export async function issueEmployeeStock(input: MovementInput): Promise<EmployeeStockMovementRow> {
  return withTransaction((client) => issueEmployeeStockInTransaction(client, input));
}

export async function returnEmployeeStockInTransaction(
  client: any,
  input: MovementInput,
  custodyGroupId: string | null = null
): Promise<EmployeeStockMovementRow> {
  await assertEmployeeInBranch(client, input.employeeId, input.branchId);
  await assertProductExists(client, input.productId);
  const movement = await appendMovement(client, {
    ...input,
    type: 'RETURN',
    workOrderId: input.workOrderId || null,
    reason: input.reason || null,
    custodyGroupId,
  });
  await restoreBranchStock(client, input.productId, input.branchId, input.quantity);
  // The units are back on the shelf, so the register says IN_STOCK again and the
  // holder is cleared — a returned device must be sellable and deployable.
  const serials = await releaseCustodySerialsInDb(client, {
    employeeId: input.employeeId,
    productId: input.productId,
    branchId: input.branchId,
    serials: input.serials || [],
    status: 'IN_STOCK',
    sourceType: 'CUSTODY_RETURN',
    sourceId: `movement:${movement.id}`,
    dateAD: custodyDateAD(),
    note: `Returned to branch by ${input.employeeId}${input.reason ? ` — ${input.reason}` : ''}`,
    strict: input.strictSerials !== false,
  });
  await linkMovementSerials(client, movement.id, input, serials);
  return movement;
}

/** RETURN: employee holding down, branch stock back up. */
export async function returnEmployeeStock(input: MovementInput): Promise<EmployeeStockMovementRow> {
  return withTransaction((client) => returnEmployeeStockInTransaction(client, input));
}

export async function consumeEmployeeStockInTransaction(
  client: any,
  input: MovementInput,
  custodyGroupId: string | null = null
): Promise<EmployeeStockMovementRow> {
  await assertEmployeeInBranch(client, input.employeeId, input.branchId);
  await assertProductExists(client, input.productId);
  if (input.workOrderId) await assertWorkOrderInBranch(client, input.workOrderId, input.branchId);
  const movement = await appendMovement(client, {
    ...input,
    type: 'CONSUME',
    workOrderId: input.workOrderId || null,
    reason: input.reason || null,
    custodyGroupId,
  });
  // Installation is the one moment a unit gets a customer: it leaves the
  // technician's custody straight into CUSTOMER_ASSIGNED, which is the state the
  // Serial Log Register shows the customer. A job with no customer (internal
  // material) leaves the unit CONSUMED instead. The holder is the guard, so one
  // technician's completion can never install a colleague's device.
  const installedAtCustomer = Boolean(input.customerId || input.customerName);
  const serials = await releaseCustodySerialsInDb(client, {
    employeeId: input.employeeId,
    productId: input.productId,
    branchId: input.branchId,
    serials: input.serials || [],
    status: installedAtCustomer ? 'CUSTOMER_ASSIGNED' : 'CONSUMED',
    customerId: input.customerId || null,
    customerName: input.customerName || null,
    sourceType: input.workOrderId ? 'WORK_ORDER' : 'CUSTODY_CONSUME',
    sourceId: input.workOrderId ? String(input.workOrderId) : `movement:${movement.id}`,
    dateAD: custodyDateAD(),
    note: installedAtCustomer
      ? `Installed at ${input.customerName || input.customerId}${input.workOrderId ? ` on work order ${input.workOrderId}` : ''}`
      : `Consumed by ${input.employeeId}${input.reason ? ` — ${input.reason}` : ''}`,
    strict: input.strictSerials !== false,
  });
  await linkMovementSerials(client, movement.id, input, serials);
  return movement;
}

/** CONSUME: used on a job; the units leave custody and do not come back. */
export async function consumeEmployeeStock(input: MovementInput): Promise<EmployeeStockMovementRow> {
  return withTransaction((client) => consumeEmployeeStockInTransaction(client, input));
}

/** The shape of a custody transfer's request after validation. */
export interface TransferInput {
  fromEmployeeId: string;
  toEmployeeId: string;
  productId: string;
  quantity: number;
  reason: string;
  actor: string;
  /** Device serials being handed over (serial-tracked products only). */
  serials?: string[];
}

/**
 * TRANSFER: custody moves person to person, inside one branch.
 *
 * The rule the parked item was waiting for, stated rather than implied:
 * custody does **not** cross a branch boundary directly. Units that leave one
 * branch's shelf were issued once and belong to that branch's custody; moving
 * them to a colleague in another branch would make the destination's stock a
 * fiction (it never received them) and the source's issue unreconcilable. The
 * books already carry the right path — return to the source branch, then issue
 * from the destination branch — so a cross-branch transfer is refused with that
 * remedy named.
 *
 * Both appends land in one transaction: OUT on the giver (projection down), IN
 * on the receiver (projection up), same `transfer_group_id`, each naming the
 * other person. No `inventory_stock` row is touched, because the units left the
 * shelf at issue time.
 */
export async function transferEmployeeStock(
  input: TransferInput
): Promise<{ transferGroupId: string; from: EmployeeStockMovementRow; to: EmployeeStockMovementRow }> {
  const reason = String(input.reason || '').trim();
  if (!reason) throw new EmployeeStockRefusal('REASON_REQUIRED', 'A custody transfer needs a reason.');
  if (input.fromEmployeeId === input.toEmployeeId) {
    throw new EmployeeStockRefusal('SAME_EMPLOYEE', 'A transfer needs two different employees.');
  }
  return withTransaction(async (client) => {
    const fromBranch = await employeeBranchIdInTransaction(client, input.fromEmployeeId);
    const toBranch = await employeeBranchIdInTransaction(client, input.toEmployeeId);
    if (!fromBranch) throw new EmployeeStockRefusal('UNKNOWN_EMPLOYEE', 'The giving employee does not exist.');
    if (!toBranch) throw new EmployeeStockRefusal('UNKNOWN_EMPLOYEE', 'The receiving employee does not exist.');
    if (fromBranch !== toBranch) {
      throw new EmployeeStockRefusal(
        'CROSS_BRANCH_TRANSFER',
        'Custody does not cross branches directly: return the units to the source branch, then issue them from the destination branch.'
      );
    }
    await assertProductExists(client, input.productId);

    const transferGroupId = crypto.randomUUID();
    const from = await appendMovement(client, {
      employeeId: input.fromEmployeeId,
      productId: input.productId,
      branchId: fromBranch,
      type: 'TRANSFER_OUT',
      quantity: input.quantity,
      workOrderId: null,
      reason,
      actor: input.actor,
      counterpartyEmployeeId: input.toEmployeeId,
      transferGroupId,
    });
    const to = await appendMovement(client, {
      employeeId: input.toEmployeeId,
      productId: input.productId,
      branchId: toBranch,
      type: 'TRANSFER_IN',
      quantity: input.quantity,
      workOrderId: null,
      reason,
      actor: input.actor,
      counterpartyEmployeeId: input.fromEmployeeId,
      transferGroupId,
    });
    // A serialised device handed to a colleague changes holder, not state: it
    // never went back to the shelf, so it stays IN_CUSTODY (same branch).
    const serials = await transferCustodySerialsInDb(client, {
      fromEmployeeId: input.fromEmployeeId,
      toEmployeeId: input.toEmployeeId,
      productId: input.productId,
      branchId: fromBranch,
      serials: input.serials || [],
      sourceType: 'CUSTODY_TRANSFER',
      sourceId: transferGroupId,
      dateAD: custodyDateAD(),
      note: `Custody transferred — ${reason}`,
    });
    await linkMovementSerials(client, from.id, { productId: input.productId, branchId: fromBranch }, serials);
    return { transferGroupId, from, to };
  });
}

export async function recordEmployeeStockLossInTransaction(
  client: any,
  input: MovementInput,
  custodyGroupId: string | null = null
): Promise<EmployeeStockMovementRow> {
  const reason = String(input.reason || '').trim();
  if (!reason) throw new EmployeeStockRefusal('REASON_REQUIRED', 'A loss needs a reason.');
  await assertEmployeeInBranch(client, input.employeeId, input.branchId);
  await assertProductExists(client, input.productId);
  if (input.workOrderId) await assertWorkOrderInBranch(client, input.workOrderId, input.branchId);
  const movement = await appendMovement(client, {
    ...input,
    type: 'LOSS',
    workOrderId: input.workOrderId || null,
    reason,
    custodyGroupId,
  });
  // The units are never coming back, so the register says so instead of leaving
  // them looking held by a person who no longer has them.
  const serials = await releaseCustodySerialsInDb(client, {
    employeeId: input.employeeId,
    productId: input.productId,
    branchId: input.branchId,
    serials: input.serials || [],
    status: 'LOST',
    sourceType: 'CUSTODY_LOSS',
    sourceId: `movement:${movement.id}`,
    dateAD: custodyDateAD(),
    note: `Written off from ${input.employeeId}'s custody — ${reason}`,
    strict: input.strictSerials !== false,
  });
  await linkMovementSerials(client, movement.id, input, serials);
  return movement;
}

/** LOSS: gone without a return; the reason is required (also by a DB check). */
export async function recordEmployeeStockLoss(input: MovementInput): Promise<EmployeeStockMovementRow> {
  return withTransaction((client) => recordEmployeeStockLossInTransaction(client, input));
}

/** One person's identity, as a document needs it (name for display, branch for scope). */
export interface CustodyEmployeeIdentity {
  id: string;
  name: string;
  code: string;
  branchId: string;
}

export async function findCustodyEmployee(employeeId: string): Promise<CustodyEmployeeIdentity | null> {
  const result = await pgPool.query(
    'SELECT id, name, employee_code, branch_id FROM employees WHERE id = $1 LIMIT 1',
    [employeeId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    code: String(row.employee_code || ''),
    branchId: String(row.branch_id),
  };
}

/**
 * A custody stock audit: counted units replace the projection.
 *
 * A shortfall writes a LOSS — the units are gone, and the mandatory reason is
 * the only place the story is told. A surplus writes an ISSUE, because units
 * found in a technician's hands came off the branch shelf and never left the
 * book, so the shelf owes them. Both go through `appendMovement`, which rebuilds
 * the projection from the log; a line counted equal to the holding writes
 * nothing at all.
 */
export interface CustodyAuditLine {
  productId: string;
  countedQuantity: number;
}

export async function auditEmployeeStock(input: {
  employeeId: string;
  branchId: string;
  items: CustodyAuditLine[];
  reason: string;
  actor: string;
}): Promise<{ movements: EmployeeStockMovementRow[] }> {
  const reason = String(input.reason || '').trim();
  if (!reason) throw new EmployeeStockRefusal('REASON_REQUIRED', 'A stock audit needs a reason.');
  return withTransaction(async (client) => {
    await assertEmployeeInBranch(client, input.employeeId, input.branchId);
    const movements: EmployeeStockMovementRow[] = [];
    for (const item of input.items) {
      await assertProductExists(client, item.productId);
      const heldRow = (
        await client.query(
          `SELECT COALESCE(SUM(CASE WHEN movement_type IN ('ISSUE', 'TRANSFER_IN') THEN quantity ELSE -quantity END), 0)::int AS quantity
             FROM employee_stock_movements
            WHERE employee_id = $1 AND product_id = $2 AND branch_id = $3`,
          [input.employeeId, item.productId, input.branchId]
        )
      ).rows[0];
      const delta = Math.trunc(item.countedQuantity) - Number(heldRow?.quantity || 0);
      if (delta === 0) continue;
      const auditReason = `Stock audit: ${reason}`;
      if (delta > 0) {
        await consumeBranchStock(client, item.productId, input.branchId, delta);
        movements.push(
          await appendMovement(client, {
            employeeId: input.employeeId,
            productId: item.productId,
            branchId: input.branchId,
            type: 'ISSUE',
            quantity: delta,
            workOrderId: null,
            reason: auditReason,
            actor: input.actor,
          })
        );
      } else {
        movements.push(
          await appendMovement(client, {
            employeeId: input.employeeId,
            productId: item.productId,
            branchId: input.branchId,
            type: 'LOSS',
            quantity: -delta,
            workOrderId: null,
            reason: auditReason,
            actor: input.actor,
          })
        );
      }
    }
    return { movements };
  });
}

export interface CustodyTieOutRow {
  employeeId: string;
  employeeName: string;
  productId: string;
  productName: string;
  branchId: string;
  issued: number;
  returned: number;
  consumed: number;
  lost: number;
  transferredIn: number;
  transferredOut: number;
  movementSum: number;
  held: number;
  drift: number;
  branchOnHand: number;
}

export interface CustodyTieOut {
  rows: CustodyTieOutRow[];
  totals: { held: number; movementSum: number; drift: number };
}

/**
 * The reconciliation the ledger exists for: each person/product holding must
 * equal the signed movement sum, and the branch shelf is shown beside it, so a
 * document that moved one book and not the other is visible instead of silent.
 */
export async function custodyTieOut(options: EmployeeStockQuery): Promise<CustodyTieOut> {
  const result = await pgPool.query(
    `SELECT m.employee_id, e.name AS employee_name, m.product_id, p.name AS product_name, m.branch_id,
            COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'ISSUE'), 0)::int AS issued,
            COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'RETURN'), 0)::int AS returned,
            COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'CONSUME'), 0)::int AS consumed,
            COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'LOSS'), 0)::int AS lost,
            COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'TRANSFER_IN'), 0)::int AS transferred_in,
            COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'TRANSFER_OUT'), 0)::int AS transferred_out,
            COALESCE(SUM(CASE WHEN m.movement_type IN ('ISSUE', 'TRANSFER_IN') THEN m.quantity ELSE -m.quantity END), 0)::int AS movement_sum,
            COALESCE(h.quantity, 0)::int AS held,
            COALESCE(s.quantity_on_hand, 0)::int AS branch_on_hand
       FROM employee_stock_movements m
       JOIN employees e ON e.id = m.employee_id
       JOIN products p ON p.id = m.product_id
       LEFT JOIN employee_stock_holdings h
         ON h.employee_id = m.employee_id AND h.product_id = m.product_id AND h.branch_id = m.branch_id
       LEFT JOIN inventory_stock s ON s.product_id = m.product_id AND s.branch_id = m.branch_id
      WHERE ($1::text[] IS NULL OR m.branch_id = ANY($1::text[]))
        AND ($2::text IS NULL OR m.employee_id = $2)
        AND ($3::text IS NULL OR m.product_id = $3)
      GROUP BY m.employee_id, e.name, m.product_id, p.name, m.branch_id, h.quantity, s.quantity_on_hand
      ORDER BY e.name, p.name`,
    [
      options.branchIds && options.branchIds.length > 0 ? options.branchIds : null,
      options.employeeId || null,
      options.productId || null,
    ]
  );
  const rows: CustodyTieOutRow[] = result.rows.map((row: any) => {
    const movementSum = Number(row.movement_sum || 0);
    const held = Number(row.held || 0);
    return {
      employeeId: String(row.employee_id),
      employeeName: String(row.employee_name),
      productId: String(row.product_id),
      productName: String(row.product_name),
      branchId: String(row.branch_id),
      issued: Number(row.issued || 0),
      returned: Number(row.returned || 0),
      consumed: Number(row.consumed || 0),
      lost: Number(row.lost || 0),
      transferredIn: Number(row.transferred_in || 0),
      transferredOut: Number(row.transferred_out || 0),
      movementSum,
      held,
      drift: held - movementSum,
      branchOnHand: Number(row.branch_on_hand || 0),
    };
  });
  const totals = rows.reduce(
    (acc, row) => ({
      held: acc.held + row.held,
      movementSum: acc.movementSum + row.movementSum,
      drift: acc.drift + row.drift,
    }),
    { held: 0, movementSum: 0, drift: 0 }
  );
  return { rows, totals };
}

// ---------------------------------------------------------------------------
// Assets in custody (a serialised unit, owned by its fixed_assets row)
// ---------------------------------------------------------------------------

export interface CustodyAssetRow {
  assetId: string;
  tagNumber: string;
  name: string;
  category: string | null;
  productId: string | null;
  deviceSerial: string | null;
  branchId: string;
  status: string;
  assignedEmployeeId: string;
  assignedEmployeeName: string | null;
  workOrderId: string | null;
  workOrderNo: string | null;
  customerId: string | null;
  customerName: string | null;
  scheduledDateAD: string | null;
  notes: string | null;
}

/**
 * The units a person holds as whole assets — the other half of My Stock.
 *
 * A serialised unit with an asset row is owned by that row (it carries the cost,
 * the depreciation and the tag); the quantity custody ledger owns consumables.
 * The two are never both true for one unit, so this read and the holdings read
 * cannot double-count. The customer comes from the work order the unit was
 * dispatched for: that is what the technician needs to see ("this ONU is for
 * customer X on visit WO-1042"), and it is the visit the install will stamp.
 */
export async function listEmployeeCustodyAssets(options: EmployeeStockQuery): Promise<CustodyAssetRow[]> {
  const result = await pgPool.query(
    `SELECT fa.id AS "assetId", fa.tag_number AS "tagNumber", fa.name, fa.category,
            fa.product_id AS "productId", fa.device_serial AS "deviceSerial",
            fa.branch_id AS "branchId", fa.status,
            fa.assigned_employee_id AS "assignedEmployeeId",
            fa.assigned_employee_name AS "assignedEmployeeName",
            fa.assigned_work_order_id AS "workOrderId",
            w.work_order_no AS "workOrderNo",
            w.customer_id AS "customerId",
            c.customer_name AS "customerName",
            to_char(w.scheduled_date_ad, 'YYYY-MM-DD') AS "scheduledDateAD",
            fa.assignment_notes AS "notes"
       FROM fixed_assets fa
       LEFT JOIN field_work_orders w ON w.id::text = fa.assigned_work_order_id
       LEFT JOIN customer_records c ON c.id = w.customer_id
      WHERE fa.assigned_employee_id IS NOT NULL
        AND fa.status = 'IN_USE'
        AND ($1::text[] IS NULL OR fa.branch_id = ANY($1::text[]))
        AND ($2::text IS NULL OR fa.assigned_employee_id = $2)
      ORDER BY c.customer_name NULLS LAST, fa.tag_number ASC
      LIMIT 500`,
    [options.branchIds && options.branchIds.length ? options.branchIds : null, options.employeeId || null]
  );
  return result.rows;
}

/** Installs one held unit at the work order's customer, in its own transaction. */
export async function installEmployeeCustodyAsset(input: {
  assetId: string;
  employeeId: string;
  workOrderId: string;
  dateAD: string;
  dateBS?: string;
  actor?: string | null;
}): Promise<InstallHeldAssetResult> {
  return withTransaction((client) =>
    installHeldAssetAtCustomer({ client, ...input })
  );
}

/**
 * A holder's loss report — a request, never a write-off.
 *
 * The technician who dropped an ONU may say so; only a manager holds
 * `custody-writeoff` and only the approval execution writes the LOSS movement.
 * The row carries the product, quantity and serials so the approver executes
 * exactly what was reported, not a fresh guess from the screen.
 */
export async function reportEmployeeStockLoss(input: {
  employeeId: string;
  branchId: string;
  branchName?: string | null;
  productId: string;
  productName?: string | null;
  quantity: number;
  serials?: string[];
  reason: string;
  actor: { email?: string | null; name?: string | null; role?: string | null };
}): Promise<{ request: ApprovalRequest; requestNumber: string }> {
  const reason = String(input.reason || '').trim();
  if (!reason) throw new EmployeeStockRefusal('REASON_REQUIRED', 'A loss report needs a reason.');
  const id = `apr-custody-${crypto.randomUUID()}`;
  const requestNumber = `APR-CUL-${Date.now().toString(36).toUpperCase()}`;
  const request = {
    id,
    requestNumber,
    type: 'CUSTODY_LOSS',
    targetId: input.employeeId,
    customerName: input.branchName || '',
    deviceSerial: (input.serials || []).join(','),
    productName: input.productName || '',
    currentStatus: 'IN_CUSTODY',
    requestedStatus: 'LOST',
    requestedByRole: input.actor.role || '',
    requestedByEmail: input.actor.email || '',
    requestedByName: input.actor.name || '',
    branchId: input.branchId,
    branchName: input.branchName || '',
    reason,
    restockQtyOnApproval: false,
    status: 'PENDING',
    requestedAtAD: new Date().toISOString(),
    requestedAtBS: null,
    auditData: {
      employeeId: input.employeeId,
      productId: input.productId,
      quantity: input.quantity,
      serials: input.serials || [],
    },
  } as unknown as ApprovalRequest;
  await withTransaction(async (client) => {
    await client.query(AR_INSERT_SQL, arInsertParams(request));
  });
  return { request, requestNumber };
}
