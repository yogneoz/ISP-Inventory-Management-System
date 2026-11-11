import { fetchJson } from './http';

export type RecurringFrequency = 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export type RecurringSide = 'DEBIT' | 'CREDIT';
export type CloseTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'NOT_APPLICABLE';

export interface AccountingPeriod {
  id: string;
  fiscalYearId: string;
  fiscalYearCode: string;
  periodKey: string;
  startDateAD: string;
  startDateBS: string | null;
  endDateAD: string;
  endDateBS: string | null;
  status: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  closedBy: string | null;
}

export interface RecurringLine {
  id?: string;
  templateId?: string;
  lineNo?: number;
  accountId: string;
  accountCode?: string;
  accountName?: string;
  isControl?: boolean;
  subledgerType?: string;
  accountActive?: boolean;
  side: RecurringSide;
  amountFormula: string;
  amount?: number;
  debit?: number;
  credit?: number;
  memo: string | null;
  partyId: string | null;
  partyName: string | null;
  costCenterId: string | null;
  costCenterCode?: string | null;
  costCenterName?: string | null;
}

export interface RecurringLineInput {
  accountId: string;
  side: RecurringSide;
  amountFormula: string;
  memo?: string | null;
  partyId?: string | null;
  partyName?: string | null;
  costCenterId?: string | null;
}

export interface RecurringTemplate {
  id: string;
  code: string;
  name: string;
  description: string | null;
  branchId: string;
  branchCode: string;
  branchName: string;
  frequency: RecurringFrequency;
  startDateAD: string;
  endDateAD: string | null;
  nextRunDate: string;
  lastRunDate: string | null;
  lastJournalId: string | null;
  active: boolean;
  lineCount: number;
  runCount: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: RecurringLine[];
}

export interface RecurringTemplateInput {
  code?: string;
  name?: string;
  description?: string | null;
  branchId?: string;
  frequency?: RecurringFrequency;
  startDateAD?: string;
  endDateAD?: string | null;
  nextRunDate?: string;
  active?: boolean;
  lines?: RecurringLineInput[];
}

export interface RecurringPreview {
  template: RecurringTemplate;
  runDate: string;
  period: Pick<AccountingPeriod, 'id' | 'periodKey' | 'status' | 'startDateAD' | 'endDateAD' | 'fiscalYearCode'> | null;
  lines: RecurringLine[];
  totalDebit: number;
  totalCredit: number;
  difference: number;
  balanced: boolean;
  canRun: boolean;
  skipReason: string | null;
}

export interface RecurringRunResult {
  status: 'GENERATED' | 'ALREADY_GENERATED' | 'SKIPPED';
  runDate: string;
  reason?: string;
  journal?: {
    id: string;
    journalNo: string;
    periodId?: string;
    fiscalYearId?: string;
    journalDateAD?: string;
    journalStatus?: string;
  } | null;
  template?: RecurringTemplate;
  nextRunDate?: string;
  period?: Pick<AccountingPeriod, 'id' | 'periodKey' | 'status'> | null;
}

export interface CloseChecklistTask {
  id: string;
  periodId: string;
  taskCode: string;
  title: string;
  required: boolean;
  sortOrder: number;
  status: CloseTaskStatus;
  owner: string | null;
  note: string | null;
  evidenceUrl: string | null;
  completedAt: string | null;
  completedBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloseChecklist {
  period: AccountingPeriod;
  tasks: CloseChecklistTask[];
  summary: {
    total: number;
    done: number;
    pending: number;
    inProgress: number;
    notApplicable: number;
    requiredIncomplete: number;
    canClose: boolean;
  };
}

export interface CloseChecklistUpdate {
  status?: CloseTaskStatus;
  owner?: string | null;
  note?: string | null;
  evidenceUrl?: string | null;
}

export function getAccountingPeriods(fiscalYearId?: string): Promise<AccountingPeriod[]> {
  const suffix = fiscalYearId ? `?fiscalYearId=${encodeURIComponent(fiscalYearId)}` : '';
  return fetchJson(`/api/accounting/periods${suffix}`);
}

export function getRecurringTemplates(branchId?: string): Promise<RecurringTemplate[]> {
  const suffix = branchId && branchId !== 'ALL' ? `?branchId=${encodeURIComponent(branchId)}` : '';
  return fetchJson(`/api/accounting/recurring-templates${suffix}`);
}

export function getRecurringTemplate(id: string): Promise<RecurringTemplate> {
  return fetchJson(`/api/accounting/recurring-templates/${encodeURIComponent(id)}`);
}

export function createRecurringTemplate(input: RecurringTemplateInput): Promise<RecurringTemplate> {
  return fetchJson('/api/accounting/recurring-templates', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateRecurringTemplate(
  id: string,
  input: RecurringTemplateInput
): Promise<RecurringTemplate> {
  return fetchJson(`/api/accounting/recurring-templates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteRecurringTemplate(id: string): Promise<{ deleted: boolean; id: string }> {
  return fetchJson(`/api/accounting/recurring-templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function previewRecurringTemplate(id: string, date?: string): Promise<RecurringPreview> {
  const suffix = date ? `?date=${encodeURIComponent(date)}` : '';
  return fetchJson(`/api/accounting/recurring-templates/${encodeURIComponent(id)}/preview${suffix}`);
}

export function runRecurringTemplate(id: string, date?: string): Promise<RecurringRunResult> {
  return fetchJson(`/api/accounting/recurring-templates/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    body: JSON.stringify(date ? { date } : {}),
  });
}

export function getCloseChecklist(periodId: string): Promise<CloseChecklist> {
  return fetchJson(`/api/accounting/periods/${encodeURIComponent(periodId)}/checklist`);
}

export function updateCloseChecklistItem(
  periodId: string,
  itemId: string,
  input: CloseChecklistUpdate
): Promise<CloseChecklistTask> {
  return fetchJson(
    `/api/accounting/periods/${encodeURIComponent(periodId)}/checklist/${encodeURIComponent(itemId)}`,
    { method: 'PATCH', body: JSON.stringify(input) }
  );
}

export function closeAccountingPeriod(
  periodId: string,
  overrideReason?: string
): Promise<AccountingPeriod & { overridden?: boolean }> {
  return fetchJson(`/api/accounting/periods/${encodeURIComponent(periodId)}/close`, {
    method: 'POST',
    body: JSON.stringify(overrideReason ? { overrideReason } : {}),
  });
}

export function reopenAccountingPeriod(periodId: string): Promise<AccountingPeriod> {
  return fetchJson(`/api/accounting/periods/${encodeURIComponent(periodId)}/reopen`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
