/**
 * Ledger postings for stock documents that move units without a purchase.
 *
 * The caller owns the transaction: a stock operation, physical audit, manual
 * adjustment or CPE exchange calls this on the same client that has locked and
 * moved the stock row, so quantity, weighted-average cost, journal and reversal
 * commit or roll back together.
 *
 * Valuation is the stock row's moving weighted average (`inventory_stock.average_cost`),
 * never the product master's standard cost. The client reads the averages after
 * locking the row and passes them in; a positive movement into a row that has
 * no average yet materialises that average here, so the next issue cannot fall
 * back to zero.
 *
 * Every value movement is one inventory side and one stock-expense side. A
 * decrease debits the branch's stock-expense default and credits inventory; an
 * increase (found stock, exchange restock) does the reverse. The posting
 * default is required — a missing `STOCK_EXPENSE` refuses the document instead
 * of silently leaving stock and the ledger apart.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  type PostingRole,
} from '../models/accounting.repo';
import {
  STOCK_AVERAGE_COSTS_SQL,
  STOCK_SET_AVERAGE_COST_IF_ZERO_SQL,
} from '../models/inventory.repo';
import {
  postJournal,
  type AccountingClient,
  type JournalLineInput,
} from './accounting.service';
import { reverseSourceJournal } from './invoicePosting.service';

const STOCK_ROLES = ['INVENTORY', 'STOCK_EXPENSE'] as const satisfies readonly PostingRole[];

interface PostingAccount {
  id: string;
  code: string;
  name: string;
}

/** Read the weighted-average cost of each (product, branch) row under the
 * caller's lock. Rows that do not exist are simply absent; a positive movement
 * may then fall back to the caller's product cost. */
export async function loadStockAverageCosts(
  client: AccountingClient,
  branchId: string,
  productIds: readonly string[]
): Promise<Map<string, number>> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  const costs = new Map<string, number>();
  if (ids.length === 0) return costs;
  const rows = (await client.query(STOCK_AVERAGE_COSTS_SQL, [branchId, ids])).rows;
  for (const row of rows) {
    const cost = Number(row.averageCost);
    if (Number.isFinite(cost)) costs.set(String(row.productId), cost);
  }
  return costs;
}

async function loadStockDefaults(client: AccountingClient): Promise<Record<string, PostingAccount>> {
  const rows = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [STOCK_ROLES])).rows;
  const byRole: Record<string, PostingAccount> = {};
  for (const row of rows) {
    if (row.postingRole) byRole[row.postingRole] = row;
  }
  const missing = STOCK_ROLES.filter((role) => !byRole[role]);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `Accounting is not configured for stock movements: no active account has the ${missing.join(
        ', '
      )} posting default. Set it in Accounting → Posting defaults, then post the stock document again.`
    );
  }
  return byRole;
}

export interface StockValueMovement {
  productId: string;
  /** Signed quantity: positive adds inventory, negative consumes it. */
  quantity: number;
  /** Weighted-average unit cost read under the same transaction lock. */
  unitCost: number;
}

export interface StockValueJournalInput {
  branchId: string;
  journalDateAD: string;
  sourceType: string;
  sourceId: string;
  memo: string;
  movements: readonly StockValueMovement[];
  actor?: string | null;
}

/** Post one journal for a set of signed stock-value movements.
 *
 * Multiple products are netted into one inventory movement and its stock-
 * expense contra line, so a mixed operation (an exchange, a manual adjustment
 * across products) stays a single balanced document. Returns null when the net
 * is zero — a zero-value movement has no ledger effect.
 */
export async function postStockValueJournal(
  client: AccountingClient,
  input: StockValueJournalInput
) {
  const valued = input.movements
    .filter((movement) => Number.isFinite(movement.quantity) && movement.quantity !== 0)
    .map((movement) => ({
      productId: String(movement.productId),
      quantity: Number(movement.quantity),
      unitCost: Math.max(0, Number(movement.unitCost) || 0),
    }))
    .map((movement) => ({
      ...movement,
      value: roundMoney(movement.quantity * movement.unitCost),
    }))
    .filter((movement) => Math.abs(movement.value) >= 0.005);

  if (valued.length === 0) return null;

  // Net the value movement against the one inventory control account. A
  // document can both add and remove units (an exchange restocks the old model
  // and issues the replacement), and gross debit/credit lines for the same
  // account would balance while telling the ledger nothing useful.
  const net = roundMoney(valued.reduce((sum, movement) => sum + movement.value, 0));
  if (Math.abs(net) < 0.005) return null;

  const defaults = await loadStockDefaults(client);
  const memo = String(input.memo || 'Stock movement');
  const lines: JournalLineInput[] = [];
  if (net > 0) {
    lines.push({
      accountId: defaults.INVENTORY.id,
      debit: net,
      credit: 0,
      memo: `${memo} — inventory increase`,
    });
    lines.push({
      accountId: defaults.STOCK_EXPENSE.id,
      debit: 0,
      credit: net,
      memo: `${memo} — stock expense reversed`,
    });
  } else {
    lines.push({
      accountId: defaults.STOCK_EXPENSE.id,
      debit: -net,
      credit: 0,
      memo: `${memo} — stock expense`,
    });
    lines.push({
      accountId: defaults.INVENTORY.id,
      debit: 0,
      credit: -net,
      memo: `${memo} — inventory decrease`,
    });
  }
  if (lines.length < 2) return null;

  const journal = await postJournal(client, {
    journalDateAD: input.journalDateAD,
    branchId: input.branchId,
    memo,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    actor: input.actor || null,
    lines,
  });

  // A positive movement into a row with no average (manual found stock,
  // exchange restock into a fresh row) must leave a usable cost behind.
  const positiveByProduct = new Map<string, number>();
  for (const movement of valued) {
    if (movement.quantity > 0 && movement.unitCost > 0 && !positiveByProduct.has(movement.productId)) {
      positiveByProduct.set(movement.productId, movement.unitCost);
    }
  }
  for (const [productId, unitCost] of positiveByProduct) {
    await client.query(STOCK_SET_AVERAGE_COST_IF_ZERO_SQL, [unitCost, productId, input.branchId]);
  }

  return journal;
}

/** Contra journal for a posted stock operation. A legacy operation with no
 * journal (or a zero-value one) has nothing to reverse, so this is a no-op. */
export async function reverseStockOperationJournal(
  client: AccountingClient,
  input: { operationId: string; dateAD: string; reason: string; actor?: string | null }
) {
  return reverseSourceJournal(client, {
    sourceType: 'STOCK_OPERATION',
    reversalSourceType: 'STOCK_OPERATION_REVERSAL',
    sourceId: input.operationId,
    dateAD: input.dateAD,
    reason: input.reason,
    actor: input.actor || null,
  });
}

/** Contra journal for a physical audit or a manual stock-level adjustment. */
export async function reverseStockAdjustmentJournal(
  client: AccountingClient,
  input: {
    sourceType: 'STOCK_AUDIT' | 'STOCK_ADJUSTMENT';
    sourceId: string;
    dateAD: string;
    reason: string;
    actor?: string | null;
  }
) {
  return reverseSourceJournal(client, {
    sourceType: input.sourceType,
    reversalSourceType: `${input.sourceType}_REVERSAL`,
    sourceId: input.sourceId,
    dateAD: input.dateAD,
    reason: input.reason,
    actor: input.actor || null,
  });
}
