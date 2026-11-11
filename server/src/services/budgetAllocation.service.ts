/**
 * Branch-scoped cost-centre allocation for operating-expense budgets.
 *
 * The budget lines stay account-level. This service turns a branch's expense
 * budget into department shares without touching the ledger:
 *
 *   - a DEFAULT rule set is the branch fallback;
 *   - an optional rule set for a real expense statement group overrides that
 *     group only;
 *   - each set must total exactly 10,000 basis points (100.00%);
 *   - actuals are POSTED expense lines grouped by their stored cost centre.
 *     Untagged actuals remain an explicit unallocated amount and are never
 *     spread using the budget ratios.
 *
 * The allocation is a management view, not a posting. It does not rewrite
 * budget lines or journal lines.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { isAccountingDate, type AccountingClient } from './accounting.service';
import {
  BUDGET_BRANCH_SQL,
  BUDGET_FISCAL_YEAR_SQL,
  BUDGET_HEADER_BY_SCOPE_LOCK_SQL,
  BUDGET_HEADER_BY_SCOPE_SQL,
  type BudgetBranchRow,
  type BudgetFiscalYearRow,
  type BudgetHeaderRow,
} from '../models/budget.repo';
import {
  ALLOCATION_ACTUALS_SQL,
  ALLOCATION_CENTRES_SQL,
  ALLOCATION_EXPENSE_GROUPS_SQL,
  ALLOCATION_GROUP_BUDGETS_SQL,
  ALLOCATION_PROFILE_BY_SCOPE_LOCK_SQL,
  ALLOCATION_PROFILE_BY_SCOPE_SQL,
  ALLOCATION_PROFILE_INSERT_SQL,
  ALLOCATION_PROFILE_TOUCH_SQL,
  ALLOCATION_RULE_INSERT_SQL,
  ALLOCATION_RULES_BY_PROFILE_SQL,
  ALLOCATION_RULES_DELETE_SQL,
  type BudgetAllocationActualRow,
  type BudgetAllocationCentreRow,
  type BudgetAllocationGroupBudgetRow,
  type BudgetAllocationProfileRow,
  type BudgetAllocationRuleRow,
} from '../models/budgetAllocation.repo';

export const ALLOCATION_DEFAULT_GROUP = 'DEFAULT';
export const ALLOCATION_FULL_PERCENT_BP = 10_000;

const GROUP_LABELS: Record<string, string> = {
  DEFAULT: 'Branch default',
  COST_OF_SALES: 'Cost of sales',
  OPERATING_EXPENSE: 'Operating expenses',
  OTHER_EXPENSE: 'Other expenses',
};

const MAX_RULES = 500;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function percentOf(part: number, base: number): number | null {
  if (!(base > 0)) return null;
  return Math.round((part / base) * 10000) / 100;
}

export function allocationGroupLabel(accountGroup: string): string {
  return (
    GROUP_LABELS[accountGroup] ||
    accountGroup
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

async function loadScope(
  client: AccountingClient,
  fiscalYearIdRaw: unknown,
  branchIdRaw: unknown
): Promise<{ fiscalYear: BudgetFiscalYearRow; branch: BudgetBranchRow }> {
  const fiscalYearId = text(fiscalYearIdRaw, 50);
  if (!fiscalYearId) throw new ApiError(400, 'A fiscal year id is required.');
  const fiscalYear = (await client.query(BUDGET_FISCAL_YEAR_SQL, [fiscalYearId]))
    .rows[0] as BudgetFiscalYearRow | undefined;
  if (!fiscalYear) throw new ApiError(404, 'Fiscal year not found.');

  const branchId = text(branchIdRaw, 50);
  if (!branchId) {
    throw new ApiError(400, 'Choose a branch to view or edit its cost-centre allocation.');
  }
  const branch = (await client.query(BUDGET_BRANCH_SQL, [branchId]))
    .rows[0] as BudgetBranchRow | undefined;
  if (!branch) throw new ApiError(400, `Branch ${branchId} does not exist.`);

  return { fiscalYear, branch };
}

export interface BudgetAllocationRule {
  accountGroup: string;
  costCenterId: string;
  percentage: number;
  percentageBp: number;
  code: string;
  name: string;
  branchId: string | null;
  active: boolean;
}

export interface BudgetAllocationGroup {
  accountGroup: string;
  label: string;
  budget: number;
  hasOverride: boolean;
  /** Explicit group rules, or the inherited DEFAULT rules when no override. */
  rules: BudgetAllocationRule[];
}

export interface BudgetAllocationCentre {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  parentId: string | null;
  active: boolean;
}

export interface BudgetAllocationResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  branchName: string;
  profileId: string | null;
  status: 'MISSING' | 'READY';
  locked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  totalExpenseBudget: number;
  /** Every explicit rule, including group overrides. */
  rules: BudgetAllocationRule[];
  /** Expense groups with their effective rules and full-year group budget. */
  groups: BudgetAllocationGroup[];
  /** Active centres usable in this branch; inactive rules appear only in rules. */
  centres: BudgetAllocationCentre[];
}

function toRule(row: BudgetAllocationRuleRow): BudgetAllocationRule {
  return {
    accountGroup: String(row.accountGroup),
    costCenterId: String(row.costCenterId),
    percentage: Math.round((Number(row.percentageBp) || 0) / 100) / 100,
    percentageBp: Number(row.percentageBp) || 0,
    code: String(row.code),
    name: String(row.name),
    branchId: row.branchId ? String(row.branchId) : null,
    active: Boolean(row.active),
  };
}

function groupRuleSet(
  rules: BudgetAllocationRule[],
  accountGroup: string
): BudgetAllocationRule[] {
  return rules.filter((rule) => rule.accountGroup === accountGroup);
}

function buildGroups(
  rules: BudgetAllocationRule[],
  groupRows: { accountGroup: string }[],
  budgetRows: BudgetAllocationGroupBudgetRow[]
): BudgetAllocationGroup[] {
  const budgetByGroup = new Map(
    budgetRows.map((row) => [String(row.accountGroup), money(row.budget)])
  );
  const defaultRules = groupRuleSet(rules, ALLOCATION_DEFAULT_GROUP);
  return groupRows.map((row) => {
    const accountGroup = String(row.accountGroup);
    const explicit = groupRuleSet(rules, accountGroup);
    return {
      accountGroup,
      label: allocationGroupLabel(accountGroup),
      budget: budgetByGroup.get(accountGroup) || 0,
      hasOverride: explicit.length > 0,
      rules: explicit.length > 0 ? explicit : defaultRules,
    };
  });
}

async function readAllocation(
  client: AccountingClient,
  fiscalYear: BudgetFiscalYearRow,
  branch: BudgetBranchRow
): Promise<BudgetAllocationResponse> {
  // The caller may hand us a transaction client. A pg Client serialises its
  // queries and warns when Promise.all interleaves them, so read in sequence.
  const headerResult = await client.query(BUDGET_HEADER_BY_SCOPE_SQL, [
    fiscalYear.id,
    branch.id,
  ]);
  const profileResult = await client.query(ALLOCATION_PROFILE_BY_SCOPE_SQL, [
    fiscalYear.id,
    branch.id,
  ]);
  const groupResult = await client.query(ALLOCATION_EXPENSE_GROUPS_SQL);
  const budgetResult = await client.query(ALLOCATION_GROUP_BUDGETS_SQL, [
    fiscalYear.id,
    branch.id,
    fiscalYear.startDateAD,
    fiscalYear.endDateAD,
  ]);
  const centreResult = await client.query(ALLOCATION_CENTRES_SQL, [branch.id]);

  // The profile id is needed for the rules query, so that one follows the
  // independent reads above.
  const profile = profileResult.rows[0] as BudgetAllocationProfileRow | undefined;
  const rules = profile
    ? ((await client.query(ALLOCATION_RULES_BY_PROFILE_SQL, [profile.id])).rows as BudgetAllocationRuleRow[]).map(toRule)
    : [];
  const groups = buildGroups(
    rules,
    groupResult.rows as { accountGroup: string }[],
    budgetResult.rows as BudgetAllocationGroupBudgetRow[]
  );
  const header = headerResult.rows[0] as BudgetHeaderRow | undefined;
  const centres = (centreResult.rows as BudgetAllocationCentreRow[])
    .filter((row) => row.active)
    .map((row) => ({
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      branchId: row.branchId ? String(row.branchId) : null,
      parentId: row.parentId ? String(row.parentId) : null,
      active: Boolean(row.active),
    }));

  return {
    fiscalYearId: fiscalYear.id,
    fiscalYearCode: fiscalYear.code,
    branchId: branch.id,
    branchName: branch.name,
    profileId: profile ? String(profile.id) : null,
    status: profile ? 'READY' : 'MISSING',
    locked: Boolean(header?.lockedAt),
    lockedBy: header?.lockedBy ? String(header.lockedBy) : null,
    lockedAt: header?.lockedAt ? String(header.lockedAt) : null,
    updatedBy: profile?.updatedBy ? String(profile.updatedBy) : null,
    updatedAt: profile?.updatedAt ? String(profile.updatedAt) : null,
    totalExpenseBudget: roundMoney(
      groups.reduce((sum, group) => sum + group.budget, 0)
    ),
    rules,
    groups,
    centres,
  };
}

/** Read the branch's current allocation profile and effective group rules. */
export async function readBudgetAllocation(
  client: AccountingClient,
  fiscalYearId: unknown,
  branchId: unknown
): Promise<BudgetAllocationResponse> {
  const { fiscalYear, branch } = await loadScope(client, fiscalYearId, branchId);
  return readAllocation(client, fiscalYear, branch);
}

export interface BudgetAllocationRuleInput {
  accountGroup?: unknown;
  costCenterId?: unknown;
  percentage?: unknown;
}

export interface BudgetAllocationSaveInput {
  fiscalYearId?: unknown;
  branchId?: unknown;
  rules?: unknown;
}

function parsePercentageBp(value: unknown, label: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, `${label}: a numeric percentage is required.`);
  }
  if (parsed < 0 || parsed > 100) {
    throw new ApiError(400, `${label}: a percentage must be between 0 and 100.`);
  }
  const bp = Math.round(parsed * 100);
  if (Math.abs(parsed * 100 - bp) > 1e-6) {
    throw new ApiError(400, `${label}: use at most two decimal places.`);
  }
  return bp;
}

function assertNoParentChild(
  rules: Array<{ accountGroup: string; costCenterId: string }>,
  centresById: Map<string, BudgetAllocationCentreRow>
): void {
  for (const rule of rules) {
    const selected = new Set(
      rules
        .filter((candidate) => candidate.accountGroup === rule.accountGroup)
        .map((candidate) => candidate.costCenterId)
    );
    let parentId = centresById.get(rule.costCenterId)?.parentId || null;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      if (selected.has(parentId)) {
        const child = centresById.get(rule.costCenterId);
        const parent = centresById.get(parentId);
        throw new ApiError(
          400,
          `${child?.code || rule.costCenterId} cannot be allocated with its parent ${parent?.code || parentId} in the same expense group.`
        );
      }
      parentId = centresById.get(parentId)?.parentId || null;
    }
  }
}

/**
 * Replace one branch's allocation profile. The caller supplies the complete
 * explicit rule set: DEFAULT plus any group overrides. The branch header lock
 * still wins, and a locked profile refuses the whole write.
 */
export async function saveBudgetAllocation(
  client: AccountingClient,
  input: BudgetAllocationSaveInput,
  actor: string | null
): Promise<BudgetAllocationResponse> {
  const { fiscalYear, branch } = await loadScope(
    client,
    input.fiscalYearId,
    input.branchId
  );

  const header = (await client.query(BUDGET_HEADER_BY_SCOPE_LOCK_SQL, [
    fiscalYear.id,
    branch.id,
  ])).rows[0] as BudgetHeaderRow | undefined;
  if (header?.lockedAt) {
    throw new ApiError(
      409,
      `The FY ${fiscalYear.code} budget for ${branch.name} is locked. Unlock it before changing the cost-centre allocation.`
    );
  }

  if (!Array.isArray(input.rules)) {
    throw new ApiError(400, 'Allocation rules must be an array.');
  }
  if (input.rules.length > MAX_RULES) {
    throw new ApiError(400, `An allocation profile can hold at most ${MAX_RULES} rules.`);
  }

  const groupRows = (await client.query(ALLOCATION_EXPENSE_GROUPS_SQL)).rows as {
    accountGroup: string;
  }[];
  const expenseGroups = new Set(groupRows.map((row) => String(row.accountGroup)));
  const centreRows = (await client.query(ALLOCATION_CENTRES_SQL, [branch.id]))
    .rows as BudgetAllocationCentreRow[];
  const centresById = new Map(centreRows.map((row) => [String(row.id), row]));

  const parsed: Array<{
    accountGroup: string;
    costCenterId: string;
    percentageBp: number;
  }> = [];
  const seen = new Set<string>();

  input.rules.forEach((raw, index) => {
    const label = `Rule ${index + 1}`;
    const rule = raw as BudgetAllocationRuleInput;
    const accountGroup = (text(rule?.accountGroup, 50) || ALLOCATION_DEFAULT_GROUP).toUpperCase();
    if (accountGroup !== ALLOCATION_DEFAULT_GROUP && !expenseGroups.has(accountGroup)) {
      throw new ApiError(
        400,
        `${label}: ${accountGroup} is not an expense statement group in the chart.`
      );
    }
    const costCenterId = text(rule?.costCenterId, 50);
    if (!costCenterId) throw new ApiError(400, `${label}: a cost centre is required.`);
    const centre = centresById.get(costCenterId);
    if (!centre) {
      throw new ApiError(400, `${label}: cost centre ${costCenterId} does not exist in this branch.`);
    }
    if (!centre.active) {
      throw new ApiError(400, `${label}: cost centre ${centre.code} is inactive.`);
    }
    if (centre.branchId && String(centre.branchId) !== branch.id) {
      throw new ApiError(
        400,
        `${label}: cost centre ${centre.code} belongs to another branch.`
      );
    }
    const percentageBp = parsePercentageBp(
      rule?.percentage,
      `${label}: ${centre.code}`
    );
    const key = `${accountGroup}|${costCenterId}`;
    if (seen.has(key)) {
      throw new ApiError(
        400,
        `${label}: cost centre ${centre.code} is listed twice in ${allocationGroupLabel(accountGroup)}.`
      );
    }
    seen.add(key);
    parsed.push({ accountGroup, costCenterId, percentageBp });
  });

  const byGroup = new Map<string, typeof parsed>();
  for (const rule of parsed) {
    const list = byGroup.get(rule.accountGroup) || [];
    list.push(rule);
    byGroup.set(rule.accountGroup, list);
  }
  const defaultRules = byGroup.get(ALLOCATION_DEFAULT_GROUP) || [];
  if (defaultRules.length === 0) {
    throw new ApiError(400, 'The branch default allocation must contain at least one cost centre.');
  }
  for (const [accountGroup, groupRules] of byGroup) {
    const total = groupRules.reduce((sum, rule) => sum + rule.percentageBp, 0);
    if (total !== ALLOCATION_FULL_PERCENT_BP) {
      throw new ApiError(
        400,
        `${allocationGroupLabel(accountGroup)} must total exactly 100%.`
      );
    }
  }
  assertNoParentChild(parsed, centresById);

  const existing = (await client.query(ALLOCATION_PROFILE_BY_SCOPE_LOCK_SQL, [
    fiscalYear.id,
    branch.id,
  ])).rows[0] as BudgetAllocationProfileRow | undefined;
  const profileId = existing?.id || `glbap-${crypto.randomUUID()}`;
  if (existing) {
    await client.query(ALLOCATION_PROFILE_TOUCH_SQL, [profileId, actor]);
  } else {
    await client.query(ALLOCATION_PROFILE_INSERT_SQL, [
      profileId,
      fiscalYear.id,
      branch.id,
      actor,
    ]);
  }

  await client.query(ALLOCATION_RULES_DELETE_SQL, [profileId]);
  for (const rule of parsed) {
    await client.query(ALLOCATION_RULE_INSERT_SQL, [
      `glbal-${crypto.randomUUID()}`,
      profileId,
      rule.accountGroup,
      rule.costCenterId,
      rule.percentageBp,
    ]);
  }

  return readAllocation(client, fiscalYear, branch);
}

export interface BudgetDepartmentRow {
  costCenterId: string;
  code: string;
  name: string;
  budget: number;
  actual: number;
  variance: number;
  variancePercent: number | null;
  utilisationPercent: number | null;
  lineCount: number;
  inAllocation: boolean;
}

export interface BudgetDepartmentResponse {
  fiscalYearId: string;
  fiscalYearCode: string;
  branchId: string;
  branchName: string;
  profileId: string | null;
  status: 'MISSING' | 'READY';
  from: string;
  to: string;
  departments: BudgetDepartmentRow[];
  groups: Array<{
    accountGroup: string;
    label: string;
    budget: number;
    hasOverride: boolean;
  }>;
  totals: {
    /** Expense budget in the window, before allocation. */
    expenseBudget: number;
    allocatedBudget: number;
    expenseActual: number;
    taggedActual: number;
    unallocatedActual: number;
  };
  coverage: {
    totalExpenseLines: number;
    taggedExpenseLines: number;
    untaggedExpenseLines: number;
    taggedPercent: number | null;
  };
  unallocated: {
    actual: number;
    lineCount: number;
  };
  tieOut: {
    budgetDifference: number;
    actualDifference: number;
    reconciled: boolean;
  };
}

/** Split a whole amount using basis points and return exact two-decimal parts. */
function allocateByBasisPoints(
  total: number,
  rules: Array<{ percentageBp: number }>
): number[] {
  const cents = Math.round(total * 100);
  if (cents === 0 || rules.length === 0) return rules.map(() => 0);
  const raw = rules.map((rule) => cents * rule.percentageBp);
  const floors = raw.map((value) => Math.floor(value / ALLOCATION_FULL_PERCENT_BP));
  const remaining = cents - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({
      index,
      remainder: value % ALLOCATION_FULL_PERCENT_BP,
    }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) {
    floors[order[index % order.length].index] += 1;
  }
  return floors.map((value) => roundMoney(value / 100));
}

export interface BudgetDepartmentQuery {
  fiscalYearId?: unknown;
  branchId: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * Department-level expense budget against tagged POSTED actuals. The
 * unallocated row is the untagged actual; the tie-out proves the displayed
 * departments plus that row equal the branch's total expense actual.
 */
export async function buildBudgetDepartmentVariance(
  client: AccountingClient,
  query: BudgetDepartmentQuery
): Promise<BudgetDepartmentResponse> {
  const { fiscalYear, branch } = await loadScope(
    client,
    query.fiscalYearId,
    query.branchId
  );
  const rawFrom = text(query.from, 10);
  const rawTo = text(query.to, 10);
  const from = rawFrom || fiscalYear.startDateAD;
  const to = rawTo || fiscalYear.endDateAD;
  if (!isAccountingDate(from)) {
    throw new ApiError(400, 'Department window start must be a real date (YYYY-MM-DD).');
  }
  if (!isAccountingDate(to)) {
    throw new ApiError(400, 'Department window end must be a real date (YYYY-MM-DD).');
  }
  if (from > to) {
    throw new ApiError(400, 'The department window start must not be after its end.');
  }

  // Keep one client's queries sequential; see readAllocation above.
  const profileResult = await client.query(ALLOCATION_PROFILE_BY_SCOPE_SQL, [
    fiscalYear.id,
    branch.id,
  ]);
  const groupResult = await client.query(ALLOCATION_EXPENSE_GROUPS_SQL);
  const budgetResult = await client.query(ALLOCATION_GROUP_BUDGETS_SQL, [
    fiscalYear.id,
    branch.id,
    from,
    to,
  ]);
  const actualResult = await client.query(ALLOCATION_ACTUALS_SQL, [branch.id, from, to]);
  const headerResult = await client.query(BUDGET_HEADER_BY_SCOPE_SQL, [
    fiscalYear.id,
    branch.id,
  ]);
  const profile = profileResult.rows[0] as BudgetAllocationProfileRow | undefined;
  const rules = profile
    ? ((await client.query(ALLOCATION_RULES_BY_PROFILE_SQL, [profile.id]))
        .rows as BudgetAllocationRuleRow[]).map(toRule)
    : [];
  const groupBudgets = budgetResult.rows as BudgetAllocationGroupBudgetRow[];
  const budgetByGroup = new Map(
    groupBudgets.map((row) => [String(row.accountGroup), money(row.budget)])
  );
  const groupRows = groupResult.rows as { accountGroup: string }[];
  const groups = groupRows.map((row) => {
    const accountGroup = String(row.accountGroup);
    const explicit = groupRuleSet(rules, accountGroup);
    return {
      accountGroup,
      label: allocationGroupLabel(accountGroup),
      budget: budgetByGroup.get(accountGroup) || 0,
      hasOverride: explicit.length > 0,
    };
  });
  const defaultRules = groupRuleSet(rules, ALLOCATION_DEFAULT_GROUP);
  const departmentMap = new Map<
    string,
    {
      costCenterId: string;
      code: string;
      name: string;
      budget: number;
      actual: number;
      lineCount: number;
      inAllocation: boolean;
    }
  >();

  const ensureDepartment = (
    costCenterId: string,
    code: string,
    name: string,
    inAllocation: boolean
  ) => {
    const current = departmentMap.get(costCenterId);
    if (current) {
      if (inAllocation) current.inAllocation = true;
      return current;
    }
    const created = {
      costCenterId,
      code,
      name,
      budget: 0,
      actual: 0,
      lineCount: 0,
      inAllocation,
    };
    departmentMap.set(costCenterId, created);
    return created;
  };

  if (profile) {
    for (const group of groupRows) {
      const accountGroup = String(group.accountGroup);
      const explicit = groupRuleSet(rules, accountGroup);
      const effective = explicit.length > 0 ? explicit : defaultRules;
      const groupBudget = budgetByGroup.get(accountGroup) || 0;
      if (groupBudget <= 0 || effective.length === 0) continue;
      const allocations = allocateByBasisPoints(groupBudget, effective);
      effective.forEach((rule, index) => {
        const department = ensureDepartment(
          rule.costCenterId,
          rule.code,
          rule.name,
          true
        );
        department.budget = roundMoney(department.budget + allocations[index]);
      });
    }
  }

  let unallocatedActual = 0;
  let unallocatedLineCount = 0;
  let totalExpenseLines = 0;
  let taggedExpenseLines = 0;
  let expenseActual = 0;
  for (const row of actualResult.rows as BudgetAllocationActualRow[]) {
    const actual = money(row.actual);
    const lineCount = Number(row.lineCount) || 0;
    totalExpenseLines += lineCount;
    expenseActual = roundMoney(expenseActual + actual);
    if (!row.costCenterId) {
      unallocatedActual = roundMoney(unallocatedActual + actual);
      unallocatedLineCount += lineCount;
      continue;
    }
    taggedExpenseLines += lineCount;
    const department = ensureDepartment(
      String(row.costCenterId),
      String(row.costCenterCode || row.costCenterId),
      String(row.costCenterName || row.costCenterId),
      Boolean(
        rules.some((rule) => rule.costCenterId === String(row.costCenterId))
      )
    );
    department.actual = roundMoney(department.actual + actual);
    department.lineCount += lineCount;
  }

  const departments = [...departmentMap.values()]
    .map((department): BudgetDepartmentRow => {
      const variance = roundMoney(department.budget - department.actual);
      return {
        ...department,
        variance,
        variancePercent: percentOf(variance, department.budget),
        utilisationPercent: percentOf(department.actual, department.budget),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const expenseBudget = roundMoney(
    groups.reduce((sum, group) => sum + group.budget, 0)
  );
  const allocatedBudget = roundMoney(
    departments.reduce((sum, department) => sum + department.budget, 0)
  );
  const taggedActual = roundMoney(
    departments.reduce((sum, department) => sum + department.actual, 0)
  );
  const budgetDifference = roundMoney(expenseBudget - allocatedBudget);
  const actualDifference = roundMoney(expenseActual - (taggedActual + unallocatedActual));

  return {
    fiscalYearId: fiscalYear.id,
    fiscalYearCode: fiscalYear.code,
    branchId: branch.id,
    branchName: branch.name,
    profileId: profile ? String(profile.id) : null,
    status: profile ? 'READY' : 'MISSING',
    from,
    to,
    departments,
    groups,
    totals: {
      expenseBudget,
      allocatedBudget,
      expenseActual,
      taggedActual,
      unallocatedActual,
    },
    coverage: {
      totalExpenseLines,
      taggedExpenseLines,
      untaggedExpenseLines: totalExpenseLines - taggedExpenseLines,
      taggedPercent: percentOf(taggedExpenseLines, totalExpenseLines),
    },
    unallocated: {
      actual: unallocatedActual,
      lineCount: unallocatedLineCount,
    },
    tieOut: {
      budgetDifference,
      actualDifference,
      reconciled: budgetDifference === 0 && actualDifference === 0,
    },
  };
}
