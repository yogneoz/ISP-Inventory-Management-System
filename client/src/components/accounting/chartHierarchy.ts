import type { AccountingGroup } from '../../services/api/accounting';

export interface GroupOption {
  id: string;
  label: string;
  group: AccountingGroup;
  depth: number;
}

const byGroupCode = (left: AccountingGroup, right: AccountingGroup) =>
  left.sortOrder - right.sortOrder || left.code.localeCompare(right.code);

/**
 * The groups from the root down to the requested group. The walk is guarded so
 * a malformed parent link can never trap a form in an infinite loop.
 */
export function groupAncestors(
  groups: readonly AccountingGroup[],
  groupId: string
): AccountingGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const trail: AccountingGroup[] = [];
  const seen = new Set<string>();
  let current = byId.get(groupId);
  while (current && !seen.has(current.id)) {
    trail.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return trail;
}

/** A stable, human-readable code path such as `CA / CASH · Cash & Bank`. */
export function groupPathLabel(
  groups: readonly AccountingGroup[],
  groupId: string
): string {
  const trail = groupAncestors(groups, groupId);
  if (trail.length === 0) return groupId;
  return `${trail.map((group) => group.code).join(' / ')} · ${trail[trail.length - 1].name}`;
}

/** Every group below the supplied group, including deeper descendants. */
export function groupDescendantIds(
  groups: readonly AccountingGroup[],
  groupId: string
): Set<string> {
  const byParent = new Map<string, AccountingGroup[]>();
  for (const group of groups) {
    if (!group.parentId) continue;
    const siblings = byParent.get(group.parentId);
    if (siblings) siblings.push(group);
    else byParent.set(group.parentId, [group]);
  }
  const descendants = new Set<string>();
  const pending = [...(byParent.get(groupId) ?? [])];
  while (pending.length > 0) {
    const group = pending.shift()!;
    if (descendants.has(group.id)) continue;
    descendants.add(group.id);
    pending.push(...(byParent.get(group.id) ?? []));
  }
  return descendants;
}

/**
 * Flatten the tree in display order. A group whose parent is missing is shown
 * as a root rather than disappearing, so a broken parent link stays visible and
 * repairable instead of silently hiding ledger accounts.
 */
export function hierarchyGroupOptions(
  groups: readonly AccountingGroup[]
): GroupOption[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const byParent = new Map<string, AccountingGroup[]>();
  for (const group of groups) {
    const parentKey = group.parentId && byId.has(group.parentId) ? group.parentId : '';
    const siblings = byParent.get(parentKey);
    if (siblings) siblings.push(group);
    else byParent.set(parentKey, [group]);
  }
  for (const siblings of byParent.values()) siblings.sort(byGroupCode);

  const options: GroupOption[] = [];
  const seen = new Set<string>();
  const walk = (parentKey: string, depth: number) => {
    for (const group of byParent.get(parentKey) ?? []) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      options.push({ id: group.id, label: groupPathLabel(groups, group.id), group, depth });
      walk(group.id, depth + 1);
    }
  };
  walk('', 0);

  // A cycle is invalid data, but the form should still show the group so it can
  // be moved or deleted rather than making it unreachable.
  for (const group of groups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    options.push({ id: group.id, label: groupPathLabel(groups, group.id), group, depth: 0 });
  }
  return options;
}

/**
 * Legacy charts call the report buckets Balance Sheet, Trading Account and
 * Profit & Loss. Keep that language visible without adding a second taxonomy:
 * the typed account type and statement group remain the source of truth.
 */
export function statementPresentation(
  accountType: string,
  statementGroup: string
): 'Balance sheet' | 'Trading account' | 'Profit & loss' {
  if (
    ['CURRENT_ASSET', 'NON_CURRENT_ASSET', 'CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY', 'EQUITY'].includes(
      statementGroup
    )
  ) {
    return 'Balance sheet';
  }
  if (statementGroup === 'REVENUE' || statementGroup === 'COST_OF_SALES') {
    return 'Trading account';
  }
  if (statementGroup === 'OTHER_INCOME' || statementGroup === 'OPERATING_EXPENSE' || statementGroup === 'OTHER_EXPENSE') {
    return 'Profit & loss';
  }
  if (accountType === 'ASSET' || accountType === 'LIABILITY' || accountType === 'EQUITY') {
    return 'Balance sheet';
  }
  return accountType === 'INCOME' || accountType === 'EXPENSE' ? 'Profit & loss' : 'Balance sheet';
}
