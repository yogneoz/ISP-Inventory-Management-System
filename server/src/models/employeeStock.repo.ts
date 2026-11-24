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
import { pgPool } from '../../db';
import { withTransaction } from '../db/transactions';

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
         m.transfer_group_id, m.created_at
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
  }
): Promise<EmployeeStockMovementRow> {
  const inserted = await client.query(
    `INSERT INTO employee_stock_movements
       (employee_id, product_id, branch_id, movement_type, quantity, work_order_id, reason, actor,
        counterparty_employee_id, transfer_group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
}

/** ISSUE: branch stock out, employee holding up. */
export async function issueEmployeeStock(input: MovementInput): Promise<EmployeeStockMovementRow> {
  return withTransaction(async (client) => {
    await assertEmployeeInBranch(client, input.employeeId, input.branchId);
    await assertProductExists(client, input.productId);
    if (input.workOrderId) await assertWorkOrderInBranch(client, input.workOrderId, input.branchId);
    await consumeBranchStock(client, input.productId, input.branchId, input.quantity);
    return appendMovement(client, {
      ...input,
      type: 'ISSUE',
      workOrderId: input.workOrderId || null,
      reason: input.reason || null,
    });
  });
}

/** RETURN: employee holding down, branch stock back up. */
export async function returnEmployeeStock(input: MovementInput): Promise<EmployeeStockMovementRow> {
  return withTransaction(async (client) => {
    await assertEmployeeInBranch(client, input.employeeId, input.branchId);
    await assertProductExists(client, input.productId);
    const movement = await appendMovement(client, {
      ...input,
      type: 'RETURN',
      workOrderId: input.workOrderId || null,
      reason: input.reason || null,
    });
    await restoreBranchStock(client, input.productId, input.branchId, input.quantity);
    return movement;
  });
}

/** CONSUME: used on a job; the units leave custody and do not come back. */
export async function consumeEmployeeStock(input: MovementInput): Promise<EmployeeStockMovementRow> {
  return withTransaction(async (client) => {
    await assertEmployeeInBranch(client, input.employeeId, input.branchId);
    await assertProductExists(client, input.productId);
    if (input.workOrderId) await assertWorkOrderInBranch(client, input.workOrderId, input.branchId);
    return appendMovement(client, {
      ...input,
      type: 'CONSUME',
      workOrderId: input.workOrderId || null,
      reason: input.reason || null,
    });
  });
}

/** The shape of a custody transfer's request after validation. */
export interface TransferInput {
  fromEmployeeId: string;
  toEmployeeId: string;
  productId: string;
  quantity: number;
  reason: string;
  actor: string;
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
    return { transferGroupId, from, to };
  });
}

/** LOSS: gone without a return; the reason is required (also by a DB check). */
export async function recordEmployeeStockLoss(input: MovementInput): Promise<EmployeeStockMovementRow> {
  const reason = String(input.reason || '').trim();
  if (!reason) throw new EmployeeStockRefusal('REASON_REQUIRED', 'A loss needs a reason.');
  return withTransaction(async (client) => {
    await assertEmployeeInBranch(client, input.employeeId, input.branchId);
    await assertProductExists(client, input.productId);
    if (input.workOrderId) await assertWorkOrderInBranch(client, input.workOrderId, input.branchId);
    return appendMovement(client, {
      ...input,
      type: 'LOSS',
      workOrderId: input.workOrderId || null,
      reason,
    });
  });
}
