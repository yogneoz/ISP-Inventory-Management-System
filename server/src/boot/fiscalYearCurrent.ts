/**
 * Boot-time reconcile of the fiscal_years current flag.
 *
 * `INITIAL_MASTER_FISCAL_YEARS` used to be the only thing that decided which
 * year was current, and it hard-coded 2082-83. That was true until 2026-07-16
 * and wrong from 2026-07-17 on: a fresh install, or a database whose seed ran
 * before the rollover, kept the previous year flagged, while every
 * `WHERE is_current = TRUE` reader — purchase defaults, bank reconciliation,
 * the closing wizard, the bootstrap fiscal-year scope — pointed at a year that
 * had already ended. Nothing recomputed it.
 *
 * The decision is a pure function (`resolveCurrentFiscalYearId`) so it can be
 * tested without a database; this module only applies it.
 */
import type { PoolClient } from 'pg';
import { businessDateAD } from '../../../shared/businessDate';
import {
  FISCAL_YEARS_CURRENT_STATE_SQL,
  FY_SET_CURRENT_CLEAR_SQL,
  FY_SET_CURRENT_SQL,
} from '../models/admin.repo';
import { resolveCurrentFiscalYearId } from '../utils/fiscalYear';

export interface CurrentFiscalYearReconcile {
  /** True when this call moved the flag. */
  changed: boolean;
  /** The year now flagged current, when it moved. */
  id?: string;
  /** The business date the decision was made against. */
  todayAD: string;
}

/**
 * Move `is_current` to the open fiscal year that contains `todayAD` when the
 * flag is stale (it sits on a year that has already ended, or nothing is
 * flagged). Leaves a deliberately-future current year alone, and leaves
 * ambiguous data alone rather than guessing.
 */
export async function reconcileCurrentFiscalYear(
  client: PoolClient,
  todayAD: string = businessDateAD()
): Promise<CurrentFiscalYearReconcile> {
  const rows = (await client.query(FISCAL_YEARS_CURRENT_STATE_SQL)).rows;
  const targetId = resolveCurrentFiscalYearId(rows, todayAD);
  if (!targetId) return { changed: false, todayAD };

  // Clear-then-set inside one transaction: the unique partial index on
  // is_current refuses two rows flagged at once, so a single set-based UPDATE
  // could fail depending on row order.
  await client.query('BEGIN');
  try {
    await client.query(FY_SET_CURRENT_CLEAR_SQL);
    const applied = await client.query(FY_SET_CURRENT_SQL, [targetId]);
    if (applied.rowCount !== 1) {
      throw new Error(
        `fiscal-year reconcile: ${targetId} disappeared between the read and the update.`
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  return { changed: true, id: targetId, todayAD };
}
