/**
 * Default chart of accounts seeded on a fresh database.
 *
 * The data lives in `nfrsChart.ts` and is the NFRS-aligned statutory chart:
 * exact 4-digit codes, exact class order, the standard's statutory reference
 * and an operator note per account. This module only adapts that data to the
 * shape the seed and the chart screens consume, so there is exactly one place
 * to correct a code, a name, a reference or a note.
 *
 * `ensureDefaultChart` inserts these idempotently by code: changing a name or
 * retiring an account in the UI is never undone by the next boot.
 *
 * Codes are stable and human-readable: reconciliation screens and the VAT and
 * NFRS reports expose them, and a trial balance grouped by code is far easier to
 * audit than random ids.
 */
import {
  NORMAL_BALANCE_BY_POSTING_ROLE,
  normalBalanceForAccountType,
} from '../models/accounting.repo';
import type {
  AccountType,
  NormalBalance,
  PostingRole,
  StatementGroup,
  SubledgerType,
} from '../models/accounting.repo';
import { NFRS_CHART_ACCOUNTS, NFRS_CHART_GROUPS } from './nfrsChart';

export interface DefaultChartGroup {
  code: string;
  name: string;
  accountType: AccountType;
  statementGroup: StatementGroup;
  normalBalance: NormalBalance;
  sortOrder: number;
  /** Optional parent code; groups stay one arbitrary-depth hierarchy. */
  parentCode?: string;
}

export interface DefaultChartAccount {
  code: string;
  name: string;
  groupCode: string;
  /** The operator note: what belongs here and how it posts. */
  description: string;
  /** The standard's own reference (NFRS / statutory), kept verbatim. */
  statutoryReference: string;
  isControl: boolean;
  subledgerType: SubledgerType;
  postingRole: PostingRole | null;
  /** Pinned side for a contra account the group alone would mis-state. */
  normalBalance?: 'DEBIT' | 'CREDIT';
  /** WALLET names its custody kind explicitly; role defaults cover CASH/BANK. */
  accountKind?: 'CASH' | 'BANK' | 'WALLET' | 'OTHER';
  providerCode?: 'ESEWA' | 'KHALTI' | 'NEPAL_PAY';
}

/**
 * The permanent side a seeded account carries.
 *
 * Order matters: an explicit pin wins (a contra ledger reports with its section
 * but belongs on the other side), then the posting role (a posting service
 * always increases the natural side of the role), and only then the reporting
 * group, which is a section and not a side.
 */
export function defaultAccountSide(account: DefaultChartAccount): 'D' | 'C' {
  if (account.normalBalance) return account.normalBalance === 'CREDIT' ? 'C' : 'D';
  if (account.postingRole) {
    const side = NORMAL_BALANCE_BY_POSTING_ROLE[account.postingRole];
    if (side) return side;
  }
  const group = DEFAULT_CHART_GROUPS.find((entry) => entry.code === account.groupCode);
  return normalBalanceForAccountType(group?.accountType || 'ASSET');
}

export const DEFAULT_CHART_GROUPS: readonly DefaultChartGroup[] = NFRS_CHART_GROUPS.map(
  (group) => ({
    code: group.code,
    name: group.name,
    accountType: group.accountType,
    statementGroup: group.statementGroup,
    normalBalance: group.normalBalance,
    sortOrder: group.sortOrder,
  })
);

export const DEFAULT_CHART_ACCOUNTS: readonly DefaultChartAccount[] = NFRS_CHART_ACCOUNTS.map(
  (account) => ({
    code: account.code,
    name: account.name,
    groupCode: account.groupCode,
    description: account.note,
    statutoryReference: account.statutoryReference,
    isControl: account.isControl === true,
    subledgerType: account.subledgerType || 'NONE',
    postingRole: account.postingRole ?? null,
    normalBalance: account.normalBalance,
    accountKind: account.accountKind,
    providerCode: account.providerCode,
  })
);

/**
 * One default subledger book per default control account. Deriving it from the
 * chart keeps the two seeds in lockstep: adding a control account adds its
 * book, and the code/name pair stays human-readable (`SL-2110`).
 */
export const DEFAULT_CHART_SUBLEDGERS = DEFAULT_CHART_ACCOUNTS.filter(
  (account) => account.isControl
).map((account) => ({
  code: `SL-${account.code}`,
  name: `${account.name} subledger`,
  subledgerType: account.subledgerType,
  accountCode: account.code,
  description: `Subledger book behind the ${account.name} control account.`,
}));
