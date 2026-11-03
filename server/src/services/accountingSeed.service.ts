/**
 * Default chart-of-accounts seeding.
 *
 * Called once at boot (and by the test reference-data fixture) so a fresh
 * database has the posting defaults every operational document needs. It is
 * deliberately idempotent and additive:
 *   - an existing code is never updated, so a renamed, retired or remapped
 *     account survives every boot;
 *   - `ON CONFLICT DO NOTHING` absorbs concurrent boots and a posting role the
 *     operator already assigned to another account;
 *   - it never deletes or re-enables anything.
 *
 * The seed is separate from the ledger service because it is installation
 * data, not a validation rule: `postJournal` must still fail loudly when one
 * of these defaults is later removed.
 */
import {
  ACCOUNT_GROUP_SEED_INSERT_SQL,
  ACCOUNT_SEED_INSERT_SQL,
  accountGroupSeedParams,
  accountSeedParams,
} from '../models/accounting.repo';
import type { AccountingClient } from './accounting.service';
import { DEFAULT_CHART_ACCOUNTS, DEFAULT_CHART_GROUPS } from '../config/defaultChart';

/** Deterministic ids make a re-run and a concurrent run address the same row. */
function groupId(code: string): string {
  return `glg-default-${code}`;
}

function accountId(code: string): string {
  return `gla-default-${code}`;
}

/** Idempotently insert the default chart. Safe to call inside a transaction. */
export async function ensureDefaultChart(client: AccountingClient): Promise<void> {
  for (const group of DEFAULT_CHART_GROUPS) {
    await client.query(
      ACCOUNT_GROUP_SEED_INSERT_SQL,
      accountGroupSeedParams({
        id: groupId(group.code),
        code: group.code,
        name: group.name,
        accountType: group.accountType,
        statementGroup: group.statementGroup,
        normalBalance: group.normalBalance,
        sortOrder: group.sortOrder,
      })
    );
  }
  for (const account of DEFAULT_CHART_ACCOUNTS) {
    await client.query(
      ACCOUNT_SEED_INSERT_SQL,
      accountSeedParams({
        id: accountId(account.code),
        code: account.code,
        name: account.name,
        description: account.description,
        isControl: account.isControl,
        subledgerType: account.subledgerType,
        postingRole: account.postingRole,
        groupCode: account.groupCode,
      })
    );
  }
}
