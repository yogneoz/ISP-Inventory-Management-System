/**
 * Recurring journals and month-end close checklists.
 *
 * The recurring path is deliberately thin around the existing `postJournal`:
 * formulas are evaluated here, then the normal ledger service enforces balance,
 * active accounts, control/subledger parties, branch access and closed periods.
 * A template can be saved with an unbalanced preview, but it cannot be run until
 * the preview balances.
 */
import crypto from 'crypto';
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNTS_BY_IDS_SQL,
} from '../models/accounting.repo';
import {
  CLOSE_INCOMPLETE_SQL,
  CLOSE_ITEM_BY_ID_SQL,
  CLOSE_ITEM_ENSURE_SQL,
  CLOSE_ITEM_UPDATE_SQL,
  CLOSE_ITEMS_SQL,
  CLOSE_MARK_LOCK_SQL,
  CLOSE_PERIOD_BY_ID_SQL,
  RECURRING_LINE_DELETE_SQL,
  RECURRING_LINE_INSERT_SQL,
  RECURRING_LINES_SQL,
  RECURRING_PERIOD_FOR_DATE_SQL,
  RECURRING_RUN_BY_DATE_SQL,
  RECURRING_RUN_COUNT_SQL,
  RECURRING_RUN_INSERT_SQL,
  RECURRING_TEMPLATE_AFTER_RUN_SQL,
  RECURRING_TEMPLATE_BY_ID_SQL,
  RECURRING_TEMPLATE_DELETE_SQL,
  RECURRING_TEMPLATE_INSERT_SQL,
  RECURRING_TEMPLATE_LIST_SQL,
  RECURRING_TEMPLATE_LOCK_SQL,
  RECURRING_TEMPLATE_UPDATE_SQL,
} from '../models/recurringClose.repo';
import {
  isAccountingDate,
  postJournal,
  setPeriodStatus,
  type AccountingClient,
} from './accounting.service';

export type RecurringFrequency = 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export type RecurringSide = 'DEBIT' | 'CREDIT';
export type CloseTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'NOT_APPLICABLE';

const FREQUENCIES = new Set<RecurringFrequency>(['MONTHLY', 'QUARTERLY', 'YEARLY']);
const SIDES = new Set<RecurringSide>(['DEBIT', 'CREDIT']);
const CLOSE_STATUSES = new Set<CloseTaskStatus>([
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'NOT_APPLICABLE',
]);

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requiredDate(value: unknown, field: string): string {
  const date = text(value, 10);
  if (!isAccountingDate(date)) throw new ApiError(400, `${field} must be a real date (YYYY-MM-DD).`);
  return date;
}

function optionalDate(value: unknown, field: string): string | null {
  const date = text(value, 10);
  if (!date) return null;
  if (!isAccountingDate(date)) throw new ApiError(400, `${field} must be a real date (YYYY-MM-DD).`);
  return date;
}

function templateCode(value: unknown): string {
  const code = text(value, 30).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(code)) {
    throw new ApiError(400, 'Template code must be 1–30 letters, digits, dots, dashes or underscores.');
  }
  return code;
}

function frequencyOf(value: unknown): RecurringFrequency {
  const frequency = text(value, 10).toUpperCase() as RecurringFrequency;
  if (!FREQUENCIES.has(frequency)) {
    throw new ApiError(400, 'Frequency must be MONTHLY, QUARTERLY or YEARLY.');
  }
  return frequency;
}

function sideOf(value: unknown): RecurringSide {
  const side = text(value, 6).toUpperCase() as RecurringSide;
  if (!SIDES.has(side)) throw new ApiError(400, 'Line side must be DEBIT or CREDIT.');
  return side;
}

export function evaluateAmountFormula(
  raw: unknown,
  missingMessage = 'Each recurring line needs an amount formula.'
): number {
  const source = text(raw, 200);
  if (!source) throw new ApiError(400, missingMessage);
  if (!/^[0-9+\-*/().\s]+$/.test(source)) {
    throw new ApiError(400, 'Amount formula may contain only numbers, +, -, *, / and parentheses.');
  }
  let index = 0;
  const skip = () => {
    while (index < source.length && /\s/.test(source[index])) index += 1;
  };
  const parseExpression = (): number => {
    let value = parseTerm();
    for (;;) {
      skip();
      const operator = source[index];
      if (operator !== '+' && operator !== '-') return value;
      index += 1;
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
  };
  const parseTerm = (): number => {
    let value = parseFactor();
    for (;;) {
      skip();
      const operator = source[index];
      if (operator !== '*' && operator !== '/') return value;
      index += 1;
      const right = parseFactor();
      if (operator === '/' && right === 0) throw new ApiError(400, 'Amount formula divides by zero.');
      value = operator === '*' ? value * right : value / right;
    }
  };
  const parseFactor = (): number => {
    skip();
    const sign = source[index] === '-' ? -1 : 1;
    if (source[index] === '-' || source[index] === '+') index += 1;
    skip();
    if (source[index] === '(') {
      index += 1;
      const value = parseExpression();
      skip();
      if (source[index] !== ')') throw new ApiError(400, 'Amount formula has an unclosed parenthesis.');
      index += 1;
      return sign * value;
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(index));
    if (!match) throw new ApiError(400, 'Amount formula is incomplete or invalid.');
    index += match[0].length;
    return sign * Number(match[0]);
  };

  const value = parseExpression();
  skip();
  if (index !== source.length) throw new ApiError(400, 'Amount formula has trailing characters.');
  if (!Number.isFinite(value)) throw new ApiError(400, 'Amount formula did not produce a finite amount.');
  if (value <= 0) throw new ApiError(400, 'Amount formula must produce an amount greater than zero.');
  const rounded = roundMoney(value);
  if (rounded > 99_999_999_999.99) throw new ApiError(400, 'Amount formula exceeds the ledger limit.');
  return rounded;
}

export function evaluateRecurringFormula(raw: unknown): number {
  return evaluateAmountFormula(raw);
}

function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function nextRunDate(date: string, frequency: RecurringFrequency): string {
  return addMonths(date, frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : 12);
}

function evidenceUrl(value: unknown): string | null {
  const url = text(value, 500);
  if (!url) return null;
  if (!/^https?:\/\/\S+$/i.test(url) && !/^\/\S*$/.test(url)) {
    throw new ApiError(400, 'Evidence must be an http(s) link or an absolute in-app path.');
  }
  return url;
}

function dateOrDefault(value: unknown, fallback: string): string {
  const date = text(value, 10);
  return date ? requiredDate(date, 'Run date') : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface RecurringLineDraft {
  accountId: string;
  side: RecurringSide;
  amountFormula: string;
  memo: string | null;
  partyId: string | null;
  partyName: string | null;
  costCenterId: string | null;
}

export interface RecurringTemplateInput {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  branchId?: unknown;
  frequency?: unknown;
  startDateAD?: unknown;
  endDateAD?: unknown;
  nextRunDate?: unknown;
  active?: unknown;
  lines?: unknown;
}

async function accountRows(client: AccountingClient, ids: string[]) {
  if (ids.length === 0) return new Map<string, any>();
  const rows = (await client.query(ACCOUNTS_BY_IDS_SQL, [[...new Set(ids)]])).rows;
  return new Map<string, any>(rows.map((row: any) => [row.id, row]));
}

async function validateLines(
  client: AccountingClient,
  raw: unknown
): Promise<RecurringLineDraft[]> {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new ApiError(400, 'A recurring template needs at least two lines.');
  }
  if (raw.length > 100) throw new ApiError(400, 'A recurring template can hold at most 100 lines.');
  const inputs = raw.map((line) => asObject(line));
  const accountIds = inputs.map((line) => text(line.accountId, 50));
  const accounts = await accountRows(client, accountIds);
  return inputs.map((line, index) => {
    const lineNo = index + 1;
    const accountId = text(line.accountId, 50);
    const account = accounts.get(accountId);
    if (!account) throw new ApiError(400, `Line ${lineNo}: account not found.`);
    if (!account.isActive) {
      throw new ApiError(400, `Line ${lineNo}: account ${account.code} is inactive.`);
    }
    const side = sideOf(line.side);
    const amountFormula = text(line.amountFormula, 200);
    evaluateRecurringFormula(amountFormula);
    const partyId = text(line.partyId, 100) || null;
    const partyName = text(line.partyName, 200) || null;
    if (account.isControl && !partyId && !partyName) {
      throw new ApiError(400, `Line ${lineNo}: a control account must name its subledger party.`);
    }
    if (!account.isControl && (partyId || partyName)) {
      throw new ApiError(400, `Line ${lineNo}: only a control account can carry a party.`);
    }
    return {
      accountId,
      side,
      amountFormula,
      memo: text(line.memo, 300) || null,
      partyId,
      partyName,
      costCenterId: text(line.costCenterId, 50) || null,
    };
  });
}

async function insertLines(
  client: AccountingClient,
  templateId: string,
  lines: RecurringLineDraft[]
): Promise<void> {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await client.query(RECURRING_LINE_INSERT_SQL, [
      `glrl-${crypto.randomUUID()}`,
      templateId,
      index + 1,
      line.accountId,
      line.side,
      line.amountFormula,
      line.memo,
      line.partyId,
      line.partyName,
      line.costCenterId,
    ]);
  }
}

async function loadTemplate(client: AccountingClient, id: string, lock = false) {
  const template = (await client.query(
    lock ? RECURRING_TEMPLATE_LOCK_SQL : RECURRING_TEMPLATE_BY_ID_SQL,
    [id]
  )).rows[0];
  if (!template) throw new ApiError(404, 'Recurring template not found.');
  const lines = (await client.query(RECURRING_LINES_SQL, [id])).rows;
  return { ...template, lines };
}

export async function listRecurringTemplates(
  client: AccountingClient,
  branchId?: string | null
) {
  return (await client.query(RECURRING_TEMPLATE_LIST_SQL, [branchId || null])).rows;
}

export async function getRecurringTemplate(client: AccountingClient, id: string) {
  return loadTemplate(client, id);
}

export async function createRecurringTemplate(
  client: AccountingClient,
  input: RecurringTemplateInput,
  actor: string | null
) {
  const code = templateCode(input.code);
  const name = text(input.name, 150);
  if (!name) throw new ApiError(400, 'Template name is required.');
  const branchId = text(input.branchId, 50);
  if (!branchId) throw new ApiError(400, 'A branch is required for a recurring template.');
  const frequency = frequencyOf(input.frequency);
  const startDateAD = requiredDate(input.startDateAD, 'Start date');
  const endDateAD = optionalDate(input.endDateAD, 'End date');
  if (endDateAD && endDateAD < startDateAD) throw new ApiError(400, 'End date cannot precede start date.');
  const nextDate = input.nextRunDate
    ? requiredDate(input.nextRunDate, 'Next run date')
    : startDateAD;
  if (nextDate < startDateAD) throw new ApiError(400, 'Next run date cannot precede start date.');
  const lines = await validateLines(client, input.lines);
  const id = `glrt-${crypto.randomUUID()}`;
  await client.query(RECURRING_TEMPLATE_INSERT_SQL, [
    id,
    code,
    name,
    text(input.description, 2000) || null,
    branchId,
    frequency,
    startDateAD,
    endDateAD,
    nextDate,
    asBoolean(input.active, true),
    actor,
  ]);
  await insertLines(client, id, lines);
  return loadTemplate(client, id);
}

export async function updateRecurringTemplate(
  client: AccountingClient,
  id: string,
  input: RecurringTemplateInput,
  actor: string | null
) {
  const current = await loadTemplate(client, id, true);
  if (input.code !== undefined && templateCode(input.code) !== current.code) {
    throw new ApiError(400, 'Template code cannot be changed.');
  }
  if (input.branchId !== undefined && text(input.branchId, 50) !== current.branchId) {
    throw new ApiError(400, 'Template branch cannot be changed.');
  }
  const name = input.name === undefined ? current.name : text(input.name, 150);
  if (!name) throw new ApiError(400, 'Template name is required.');
  const frequency = input.frequency === undefined ? current.frequency : frequencyOf(input.frequency);
  const startDateAD =
    input.startDateAD === undefined
      ? current.startDateAD
      : requiredDate(input.startDateAD, 'Start date');
  const endDateAD =
    input.endDateAD === undefined
      ? current.endDateAD
      : optionalDate(input.endDateAD, 'End date');
  if (endDateAD && endDateAD < startDateAD) throw new ApiError(400, 'End date cannot precede start date.');
  let nextDate = current.nextRunDate;
  if (nextDate < startDateAD) nextDate = startDateAD;
  if (input.nextRunDate !== undefined) {
    nextDate = requiredDate(input.nextRunDate, 'Next run date');
    if (nextDate < startDateAD) throw new ApiError(400, 'Next run date cannot precede start date.');
  }
  const lines = input.lines === undefined ? null : await validateLines(client, input.lines);
  await client.query(RECURRING_TEMPLATE_UPDATE_SQL, [
    id,
    name,
    input.description === undefined ? current.description : text(input.description, 2000) || null,
    frequency,
    startDateAD,
    endDateAD,
    nextDate,
    asBoolean(input.active, current.active),
    actor,
  ]);
  if (lines) {
    await client.query(RECURRING_LINE_DELETE_SQL, [id]);
    await insertLines(client, id, lines);
  }
  return loadTemplate(client, id);
}

export async function deleteRecurringTemplate(client: AccountingClient, id: string) {
  await loadTemplate(client, id, true);
  const runs = Number((await client.query(RECURRING_RUN_COUNT_SQL, [id])).rows[0]?.count || 0);
  if (runs > 0) {
    throw new ApiError(409, 'This template has generated journals. Pause it instead of deleting it.');
  }
  await client.query(RECURRING_TEMPLATE_DELETE_SQL, [id]);
  return { deleted: true, id };
}

function evaluateLines(template: any) {
  return template.lines.map((line: any) => {
    if (!line.accountActive) {
      throw new ApiError(400, `Line ${line.lineNo}: account ${line.accountCode} is inactive.`);
    }
    if (line.isControl && !line.partyId && !line.partyName) {
      throw new ApiError(400, `Line ${line.lineNo}: a control account must name its subledger party.`);
    }
    if (!line.isControl && (line.partyId || line.partyName)) {
      throw new ApiError(400, `Line ${line.lineNo}: only a control account can carry a party.`);
    }
    const amount = evaluateRecurringFormula(line.amountFormula);
    return { ...line, amount, debit: line.side === 'DEBIT' ? amount : 0, credit: line.side === 'CREDIT' ? amount : 0 };
  });
}

function previewMath(lines: any[]) {
  const totalDebit = roundMoney(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0));
  const totalCredit = roundMoney(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
  return {
    totalDebit,
    totalCredit,
    difference: roundMoney(totalDebit - totalCredit),
    balanced: totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.005,
  };
}

async function periodForDate(client: AccountingClient, date: string) {
  return (await client.query(RECURRING_PERIOD_FOR_DATE_SQL, [date])).rows[0] || null;
}

export async function previewRecurringTemplate(
  client: AccountingClient,
  id: string,
  requestedDate?: unknown
) {
  const template = await loadTemplate(client, id);
  const runDate = dateOrDefault(requestedDate, template.nextRunDate);
  const lines = evaluateLines(template);
  const math = previewMath(lines);
  const period = await periodForDate(client, runDate);
  let skipReason: string | null = null;
  if (!template.active) skipReason = 'INACTIVE';
  else if (template.endDateAD && runDate > template.endDateAD) skipReason = 'ENDED';
  else if (!period) skipReason = 'PERIOD_MISSING';
  else if (period.status === 'CLOSED') skipReason = 'PERIOD_CLOSED';
  else if (!math.balanced) skipReason = 'UNBALANCED';
  return {
    template,
    runDate,
    period,
    lines,
    ...math,
    canRun: skipReason === null,
    skipReason,
  };
}

export async function runRecurringTemplate(
  client: AccountingClient,
  id: string,
  requestedDate: unknown,
  actor: string | null
) {
  const template = await loadTemplate(client, id, true);
  const runDate = dateOrDefault(requestedDate, template.nextRunDate);
  const existing = (await client.query(RECURRING_RUN_BY_DATE_SQL, [id, runDate])).rows[0];
  if (existing) {
    return {
      status: 'ALREADY_GENERATED' as const,
      runDate,
      journal: {
        id: existing.journalId,
        journalNo: existing.journalNo,
        journalDateAD: existing.journalDateAD,
        journalStatus: existing.journalStatus,
      },
      template,
      nextRunDate: template.nextRunDate,
    };
  }
  if (!template.active) throw new ApiError(409, 'This recurring template is paused.');
  if (runDate !== template.nextRunDate) {
    throw new ApiError(409, `The next due date is ${template.nextRunDate}; ${runDate} is not due yet.`);
  }
  if (template.endDateAD && runDate > template.endDateAD) {
    throw new ApiError(409, 'This recurring template has ended.');
  }
  const period = await periodForDate(client, runDate);
  if (!period) {
    throw new ApiError(400, `No accounting period contains ${runDate}. Create the fiscal period first.`);
  }
  const lines = evaluateLines(template);
  const math = previewMath(lines);
  if (!math.balanced) {
    throw new ApiError(
      400,
      `Recurring template is not balanced: debits ${math.totalDebit.toFixed(2)} ≠ credits ${math.totalCredit.toFixed(2)}.`
    );
  }
  if (period.status === 'CLOSED') {
    return {
      status: 'SKIPPED' as const,
      reason: 'PERIOD_CLOSED',
      runDate,
      period,
      template,
      nextRunDate: template.nextRunDate,
    };
  }
  const journal = await postJournal(client, {
    journalDateAD: runDate,
    branchId: template.branchId,
    sourceType: 'RECURRING_JOURNAL',
    sourceId: template.id,
    voucherType: 'JOURNAL',
    referenceNo: template.code,
    memo: `${template.code} · ${template.name} · ${runDate}`,
    actor,
    lines: lines.map((line: any) => ({
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      costCenterId: line.costCenterId,
      memo: line.memo,
      subledgerType: line.isControl ? line.subledgerType : 'NONE',
      partyId: line.partyId,
      partyName: line.partyName,
    })),
  });
  await client.query(RECURRING_RUN_INSERT_SQL, [
    `glrr-${crypto.randomUUID()}`,
    id,
    runDate,
    journal.id,
    actor,
  ]);
  const nextDate = nextRunDate(runDate, template.frequency);
  await client.query(RECURRING_TEMPLATE_AFTER_RUN_SQL, [
    id,
    nextDate,
    runDate,
    journal.id,
    true,
    actor,
  ]);
  const refreshed = await loadTemplate(client, id);
  return {
    status: 'GENERATED' as const,
    runDate,
    journal,
    template: refreshed,
    nextRunDate: refreshed.nextRunDate,
  };
}

export async function ensureCloseChecklist(client: AccountingClient, periodId: string) {
  const period = (await client.query(CLOSE_PERIOD_BY_ID_SQL, [periodId])).rows[0];
  if (!period) throw new ApiError(404, 'Accounting period not found.');
  await client.query(CLOSE_ITEM_ENSURE_SQL, [periodId]);
  const tasks = (await client.query(CLOSE_ITEMS_SQL, [periodId])).rows;
  return { period, tasks };
}

function checklistSummary(tasks: any[]) {
  const done = tasks.filter((task) => task.status === 'DONE').length;
  const requiredIncomplete = tasks.filter(
    (task) => task.required && task.status !== 'DONE'
  ).length;
  return {
    total: tasks.length,
    done,
    pending: tasks.filter((task) => task.status === 'PENDING').length,
    inProgress: tasks.filter((task) => task.status === 'IN_PROGRESS').length,
    notApplicable: tasks.filter((task) => task.status === 'NOT_APPLICABLE').length,
    requiredIncomplete,
    canClose: tasks.length > 0 && requiredIncomplete === 0,
  };
}

export async function getCloseChecklist(client: AccountingClient, periodId: string) {
  const { period, tasks } = await ensureCloseChecklist(client, periodId);
  return { period, tasks, summary: checklistSummary(tasks) };
}

export async function updateCloseChecklistItem(
  client: AccountingClient,
  periodId: string,
  itemId: string,
  input: Record<string, unknown>,
  actor: string | null
) {
  await ensureCloseChecklist(client, periodId);
  const item = (await client.query(CLOSE_ITEM_BY_ID_SQL, [periodId, itemId])).rows[0];
  if (!item) throw new ApiError(404, 'Close checklist task not found.');
  const status =
    input.status === undefined ? item.status : String(input.status || '').toUpperCase();
  if (!CLOSE_STATUSES.has(status as CloseTaskStatus)) {
    throw new ApiError(400, 'Status must be PENDING, IN_PROGRESS, DONE or NOT_APPLICABLE.');
  }
  const owner =
    input.owner === undefined ? item.owner : text(input.owner, 150) || null;
  const note = input.note === undefined ? item.note : text(input.note, 2000) || null;
  const evidence =
    input.evidenceUrl === undefined ? item.evidenceUrl : evidenceUrl(input.evidenceUrl);
  await client.query(CLOSE_ITEM_UPDATE_SQL, [
    periodId,
    itemId,
    status,
    owner,
    note,
    evidence,
    actor,
  ]);
  return (await client.query(CLOSE_ITEM_BY_ID_SQL, [periodId, itemId])).rows[0];
}

async function markLockTask(
  client: AccountingClient,
  periodId: string,
  status: 'DONE' | 'PENDING',
  actor: string | null
) {
  await client.query(CLOSE_MARK_LOCK_SQL, [periodId, status, actor]);
}

export async function closePeriodWithChecklist(
  client: AccountingClient,
  periodId: string,
  actor: string | null,
  overrideReason?: unknown
) {
  const { period, tasks } = await ensureCloseChecklist(client, periodId);
  const incomplete = (await client.query(CLOSE_INCOMPLETE_SQL, [periodId])).rows;
  if (period.status === 'CLOSED') {
    await markLockTask(client, periodId, 'DONE', actor);
    return {
      period: (await client.query(CLOSE_PERIOD_BY_ID_SQL, [periodId])).rows[0],
      overridden: false,
      incompleteRequired: incomplete,
      summary: checklistSummary(tasks),
    };
  }
  const reason = text(overrideReason, 500);
  if (incomplete.length > 0 && !reason) {
    const titles = incomplete.map((task: any) => task.title).join('; ');
    throw new ApiError(
      409,
      `Required close tasks are incomplete: ${titles}. Complete them or provide an override reason.`
    );
  }
  await setPeriodStatus(client, periodId, 'CLOSED', actor);
  await markLockTask(client, periodId, 'DONE', actor);
  const closing = (await client.query(CLOSE_PERIOD_BY_ID_SQL, [periodId])).rows[0];
  const refreshed = (await client.query(CLOSE_ITEMS_SQL, [periodId])).rows;
  return {
    period: closing,
    overridden: incomplete.length > 0,
    overrideReason: reason || null,
    incompleteRequired: incomplete,
    summary: checklistSummary(refreshed),
  };
}

export async function reopenPeriodWithChecklist(
  client: AccountingClient,
  periodId: string,
  actor: string | null
) {
  const { period } = await ensureCloseChecklist(client, periodId);
  if (period.status === 'OPEN') return { period, changed: false };
  await setPeriodStatus(client, periodId, 'OPEN', actor);
  await markLockTask(client, periodId, 'PENDING', actor);
  return {
    period: (await client.query(CLOSE_PERIOD_BY_ID_SQL, [periodId])).rows[0],
    changed: true,
  };
}
