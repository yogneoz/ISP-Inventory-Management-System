/**
 * Manual forecast adjustments.
 *
 * These rows are not journals and never post to the ledger. They are dated,
 * branch-owned planning inputs whose amount is evaluated from a safe formula
 * by the same parser recurring journals use. A CLOSED accounting period refuses
 * new or changed inputs, and the forecast separately excludes any stored row
 * whose date falls in a closed period, so closing a period cannot silently
 * change a forecast that has already been reviewed.
 */
import crypto from 'crypto';
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { bsDateOrThrow } from '../utils/bsDate';
import {
  CASH_FLOW_MANUAL_INPUT_BY_ID_SQL,
  CASH_FLOW_MANUAL_INPUT_DELETE_SQL,
  CASH_FLOW_MANUAL_INPUT_INSERT_SQL,
  CASH_FLOW_MANUAL_INPUT_LIST_SQL,
  CASH_FLOW_MANUAL_INPUT_UPDATE_SQL,
  CASH_FLOW_PERIOD_FOR_DATE_SQL,
} from '../models/cashFlowForecast.repo';
import { evaluateAmountFormula } from './recurringClose.service';
import { isAccountingDate, type AccountingClient } from './accounting.service';

export type CashFlowForecastDirection = 'INFLOW' | 'OUTFLOW';

export interface CashFlowManualInput {
  id: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  expectedDateAD: string;
  expectedDateBS: string;
  direction: CashFlowForecastDirection;
  amountFormula: string;
  amount: number;
  description: string;
  closedPeriod: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CashFlowManualInputDraft {
  branchId?: unknown;
  expectedDateAD?: unknown;
  expectedDateBS?: unknown;
  direction?: unknown;
  amountFormula?: unknown;
  description?: unknown;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requiredDate(value: unknown, field: string): string {
  const date = text(value, 10);
  if (!isAccountingDate(date)) throw new ApiError(400, `${field} must be a real date (YYYY-MM-DD).`);
  return date;
}

export function evaluateCashFlowFormula(raw: unknown): number {
  return evaluateAmountFormula(raw, 'A cash-flow amount formula is required.');
}

function directionOf(value: unknown): CashFlowForecastDirection {
  const direction = text(value, 7).toUpperCase();
  if (direction !== 'INFLOW' && direction !== 'OUTFLOW') {
    throw new ApiError(400, 'Cash-flow direction must be INFLOW or OUTFLOW.');
  }
  return direction;
}

function descriptionOf(value: unknown): string {
  const description = text(value, 300);
  if (!description) throw new ApiError(400, 'A description is required for a manual cash-flow input.');
  return description;
}

function asManualInput(row: any): CashFlowManualInput {
  return {
    id: String(row.id),
    branchId: String(row.branchId),
    branchCode: String(row.branchCode || ''),
    branchName: String(row.branchName || ''),
    expectedDateAD: String(row.expectedDateAD).slice(0, 10),
    expectedDateBS: String(row.expectedDateBS),
    direction: row.direction === 'INFLOW' ? 'INFLOW' : 'OUTFLOW',
    amountFormula: String(row.amountFormula),
    amount: evaluateCashFlowFormula(row.amountFormula),
    description: String(row.description),
    closedPeriod: Boolean(row.closedPeriod),
    createdBy: row.createdBy || null,
    updatedBy: row.updatedBy || null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : '',
  };
}

export async function listCashFlowManualInputs(
  client: AccountingClient,
  branchId: string | null
): Promise<CashFlowManualInput[]> {
  const rows = (await client.query(CASH_FLOW_MANUAL_INPUT_LIST_SQL, [branchId])).rows;
  return rows.map(asManualInput);
}

export async function getCashFlowManualInput(
  client: AccountingClient,
  id: string
): Promise<CashFlowManualInput | null> {
  const row = (await client.query(CASH_FLOW_MANUAL_INPUT_BY_ID_SQL, [id])).rows[0];
  return row ? asManualInput(row) : null;
}

async function assertDateOpen(client: AccountingClient, expectedDateAD: string): Promise<void> {
  const period = (await client.query(CASH_FLOW_PERIOD_FOR_DATE_SQL, [expectedDateAD])).rows[0];
  if (period?.status === 'CLOSED') {
    throw new ApiError(
      409,
      `The accounting period ${period.periodKey} is closed; a manual cash-flow input cannot be placed there.`
    );
  }
}

export async function createCashFlowManualInput(
  client: AccountingClient,
  input: CashFlowManualInputDraft,
  actor: string | null
): Promise<CashFlowManualInput> {
  const branchId = text(input.branchId, 50);
  if (!branchId || branchId === 'ALL') {
    throw new ApiError(400, 'A concrete branch is required for a manual cash-flow input.');
  }
  const expectedDateAD = requiredDate(input.expectedDateAD, 'Expected date');
  await assertDateOpen(client, expectedDateAD);
  const expectedDateBS = await bsDateOrThrow(expectedDateAD, client as any);
  const direction = directionOf(input.direction);
  const amountFormula = text(input.amountFormula, 200);
  evaluateCashFlowFormula(amountFormula);
  const description = descriptionOf(input.description);
  const id = `cfm-${crypto.randomUUID()}`;
  await client.query(CASH_FLOW_MANUAL_INPUT_INSERT_SQL, [
    id,
    branchId,
    expectedDateAD,
    expectedDateBS,
    direction,
    amountFormula,
    description,
    actor,
  ]);
  const created = await getCashFlowManualInput(client, id);
  if (!created) throw new ApiError(500, 'The manual cash-flow input could not be read after saving.');
  return created;
}

export async function updateCashFlowManualInput(
  client: AccountingClient,
  id: string,
  input: CashFlowManualInputDraft,
  actor: string | null
): Promise<CashFlowManualInput> {
  const existing = await getCashFlowManualInput(client, id);
  if (!existing) throw new ApiError(404, 'Manual cash-flow input not found.');
  if (input.branchId !== undefined && text(input.branchId, 50) !== existing.branchId) {
    throw new ApiError(400, 'A manual cash-flow input cannot be moved to another branch.');
  }
  const expectedDateAD =
    input.expectedDateAD === undefined
      ? existing.expectedDateAD
      : requiredDate(input.expectedDateAD, 'Expected date');
  if (expectedDateAD !== existing.expectedDateAD) {
    await assertDateOpen(client, expectedDateAD);
  } else if (existing.closedPeriod) {
    throw new ApiError(
      409,
      'This manual cash-flow input is in a closed accounting period and cannot be changed; move it to an open date or delete it.'
    );
  }
  const expectedDateBS =
    expectedDateAD === existing.expectedDateAD
      ? existing.expectedDateBS
      : await bsDateOrThrow(expectedDateAD, client as any);
  const direction = input.direction === undefined ? existing.direction : directionOf(input.direction);
  const amountFormula =
    input.amountFormula === undefined
      ? existing.amountFormula
      : text(input.amountFormula, 200);
  evaluateCashFlowFormula(amountFormula);
  const description =
    input.description === undefined ? existing.description : descriptionOf(input.description);
  await client.query(CASH_FLOW_MANUAL_INPUT_UPDATE_SQL, [
    id,
    expectedDateAD,
    expectedDateBS,
    direction,
    amountFormula,
    description,
    actor,
  ]);
  const updated = await getCashFlowManualInput(client, id);
  if (!updated) throw new ApiError(500, 'The manual cash-flow input could not be read after saving.');
  return updated;
}

export async function deleteCashFlowManualInput(
  client: AccountingClient,
  id: string
): Promise<{ deleted: true; id: string }> {
  const existing = await getCashFlowManualInput(client, id);
  if (!existing) throw new ApiError(404, 'Manual cash-flow input not found.');
  await client.query(CASH_FLOW_MANUAL_INPUT_DELETE_SQL, [id]);
  return { deleted: true, id };
}

/** Exposed for the forecast so a source summary can use the same money rule. */
export function manualInputAmount(input: CashFlowManualInput): number {
  return roundMoney(input.amount);
}
