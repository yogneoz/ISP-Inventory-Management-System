/**
 * ACC-4 inventory-to-finance reconciliation.
 *
 * Two independent records must agree:
 *   - `inventory_stock.quantity_on_hand * average_cost` is the register value
 *     per branch and product;
 *   - the posted INVENTORY account is the ledger value per branch.
 *
 * The same report also compares period COGS with the sale/return movement rows
 * that supplied the issue cost, and stock expense with the adjustment/damage
 * movement rows. The inventory tie is the hard close guard; the other two are
 * evidence sections with explicit differences rather than invented values.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
} from '../models/accounting.repo';
import {
  INVENTORY_BRANCHES_SQL,
  INVENTORY_COGS_GL_SQL,
  INVENTORY_COGS_SOURCE_SQL,
  INVENTORY_CONTROL_SQL,
  INVENTORY_STOCK_EXPENSE_GL_SQL,
  INVENTORY_STOCK_EXPENSE_SOURCE_SQL,
  INVENTORY_VALUATION_ROWS_SQL,
} from '../models/inventoryReconciliation.repo';
import { isAccountingDate, type AccountingClient } from './accounting.service';

const MONEY_TOLERANCE = 0.005;

export interface InventoryReconciliationQuery {
  branchId?: string | null;
  from?: unknown;
  to?: unknown;
  asOf?: unknown;
}

interface BranchFigure {
  branchId: string;
  branchCode: string;
  branchName: string;
  valuation: number;
  control: number;
  difference: number;
  reconciled: boolean;
}

interface SourceFigure {
  posted: number;
  sourceAmount: number;
  difference: number;
  reconciled: boolean;
}

function dateValue(value: unknown, label: string): string {
  const date = typeof value === 'string' ? value.trim().slice(0, 10) : '';
  if (!isAccountingDate(date)) throw new ApiError(400, `${label} must be a real date (YYYY-MM-DD).`);
  return date;
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function todayAD(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function amountsByBranch(rows: any[]): Map<string, number> {
  return new Map(rows.map((row) => [String(row.branchId), money(row.amount ?? row.balance)]));
}

function tie(posted: number, sourceAmount: number): SourceFigure {
  const difference = roundMoney(posted - sourceAmount);
  return {
    posted,
    sourceAmount,
    difference,
    reconciled: Math.abs(difference) < MONEY_TOLERANCE,
  };
}

async function loadAccount(
  client: AccountingClient,
  role: 'INVENTORY' | 'COGS' | 'STOCK_EXPENSE'
): Promise<{ id: string; code: string; name: string }> {
  const row = (await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [[role]])).rows[0];
  if (!row) {
    throw new ApiError(
      400,
      `Accounting is not configured for inventory reconciliation: no active account has the ${role} posting default. Set it in Accounting → Posting defaults.`
    );
  }
  return { id: String(row.id), code: String(row.code), name: String(row.name) };
}

export async function readInventoryReconciliation(
  client: AccountingClient,
  query: InventoryReconciliationQuery
) {
  const asOf = dateValue(query.asOf || query.to || todayAD(), 'The inventory reconciliation date');
  const from = dateValue(query.from || monthStart(asOf), 'The inventory reconciliation period start');
  const to = dateValue(query.to || asOf, 'The inventory reconciliation period end');
  if (from > to) throw new ApiError(400, 'The inventory reconciliation period start must not be after its end.');
  const branchId =
    typeof query.branchId === 'string' && query.branchId.trim() && query.branchId !== 'ALL'
      ? query.branchId.trim()
      : null;

  const inventoryAccount = await loadAccount(client, 'INVENTORY');
  const cogsAccount = await loadAccount(client, 'COGS');
  const stockExpenseAccount = await loadAccount(client, 'STOCK_EXPENSE');

  const valuationRows = (await client.query(INVENTORY_VALUATION_ROWS_SQL, [branchId])).rows as any[];
  const controlRows = (await client.query(INVENTORY_CONTROL_SQL, [
    inventoryAccount.id,
    branchId,
    asOf,
  ])).rows as any[];
  const branches = (await client.query(INVENTORY_BRANCHES_SQL, [branchId])).rows as any[];
  const cogsGlRows = (await client.query(INVENTORY_COGS_GL_SQL, [
    cogsAccount.id,
    branchId,
    from,
    to,
  ])).rows as any[];
  const cogsSourceRows = (await client.query(INVENTORY_COGS_SOURCE_SQL, [
    branchId,
    from,
    to,
  ])).rows as any[];
  const expenseGlRows = (await client.query(INVENTORY_STOCK_EXPENSE_GL_SQL, [
    stockExpenseAccount.id,
    branchId,
    from,
    to,
  ])).rows as any[];
  const expenseSourceRows = (await client.query(INVENTORY_STOCK_EXPENSE_SOURCE_SQL, [
    branchId,
    from,
    to,
  ])).rows as any[];

  const valuation = valuationRows.map((row) => ({
    branchId: String(row.branchId),
    branchCode: String(row.branchCode),
    branchName: String(row.branchName),
    productId: String(row.productId),
    sku: String(row.sku || ''),
    productName: String(row.productName),
    quantity: Number(row.quantity) || 0,
    averageCost: money(row.averageCost),
    value: money(row.value),
  }));
  const valuationByBranch = new Map<string, number>();
  for (const row of valuation) {
    valuationByBranch.set(row.branchId, roundMoney((valuationByBranch.get(row.branchId) || 0) + row.value));
  }
  const controlByBranch = new Map(controlRows.map((row) => [String(row.branchId), money(row.balance)]));
  const cogsGl = amountsByBranch(cogsGlRows);
  const cogsSource = amountsByBranch(cogsSourceRows);
  const expenseGl = amountsByBranch(expenseGlRows);
  const expenseSource = amountsByBranch(expenseSourceRows);

  const branchRows: BranchFigure[] = branches
    .map((branch: any) => {
      const id = String(branch.branchId);
      const branchValuation = money(valuationByBranch.get(id));
      const control = money(controlByBranch.get(id));
      const difference = roundMoney(branchValuation - control);
      return {
        branchId: id,
        branchCode: String(branch.branchCode),
        branchName: String(branch.branchName),
        valuation: branchValuation,
        control,
        difference,
        reconciled: Math.abs(difference) < MONEY_TOLERANCE,
      };
    })
    .filter((row) => row.valuation !== 0 || row.control !== 0 || branches.length === 1);

  const totalValuation = money(valuation.reduce((sum, row) => sum + row.value, 0));
  const totalControl = money(controlRows.reduce((sum, row) => sum + money(row.balance), 0));
  const difference = roundMoney(totalValuation - totalControl);
  const totalCogsPosted = money(cogsGlRows.reduce((sum, row) => sum + money(row.amount), 0));
  const totalCogsSource = money(cogsSourceRows.reduce((sum, row) => sum + money(row.amount), 0));
  const totalExpensePosted = money(expenseGlRows.reduce((sum, row) => sum + money(row.amount), 0));
  const totalExpenseSource = money(expenseSourceRows.reduce((sum, row) => sum + money(row.amount), 0));

  return {
    from,
    to,
    asOf,
    branchId,
    accounts: {
      inventory: inventoryAccount,
      cogs: cogsAccount,
      stockExpense: stockExpenseAccount,
    },
    branches: branchRows,
    products: valuation,
    totals: {
      valuation: totalValuation,
      control: totalControl,
      difference,
      reconciled: Math.abs(difference) < MONEY_TOLERANCE,
    },
    cogs: {
      ...tie(totalCogsPosted, totalCogsSource),
      branches: branches.map((branch: any) => {
        const id = String(branch.branchId);
        return {
          branchId: id,
          branchCode: String(branch.branchCode),
          ...tie(money(cogsGl.get(id)), money(cogsSource.get(id))),
        };
      }),
    },
    stockExpense: {
      ...tie(totalExpensePosted, totalExpenseSource),
      branches: branches.map((branch: any) => {
        const id = String(branch.branchId);
        return {
          branchId: id,
          branchCode: String(branch.branchCode),
          ...tie(money(expenseGl.get(id)), money(expenseSource.get(id))),
        };
      }),
    },
  };
}

/**
 * Close guard used by the period close transaction. A non-zero inventory
 * valuation/control difference refuses the close unless the caller supplies
 * the same audited override reason the checklist already supports.
 */
export async function inventoryCloseDifference(
  client: AccountingClient,
  period: { startDateAD: string; endDateAD: string }
): Promise<number> {
  const report = await readInventoryReconciliation(client, {
    asOf: period.endDateAD,
    from: period.startDateAD,
    to: period.endDateAD,
  });
  return report.totals.difference;
}
