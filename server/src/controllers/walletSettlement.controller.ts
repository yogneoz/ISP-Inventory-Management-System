/**
 * ACC-3 wallet settlement and PSP reconciliation HTTP surface.
 *
 * Provider clearing is company-wide like a bank account, so branch-scoped users
 * cannot reconcile it. Reads use `gl-view`; settlement posting, statement import
 * and matching use the existing cash/bank control grant `gl-cash-close`.
 */
import type { Response } from 'express';
import { pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { getUserFromReq } from '../middleware/auth';
import { logAuditEvent } from '../services/audit.service';
import {
  createPaymentSettlement,
  importProviderStatement,
  matchProviderStatementLine,
  readWalletReconciliation,
} from '../services/paymentSettlement.service';
import { resolveBranchScope } from './accounting.controller';

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function requireCompanyScope(req: any, res: Response): boolean {
  const scope = resolveBranchScope(req, res);
  if (!scope) return false;
  if (scope.empty) {
    res.status(403).json({ message: 'Forbidden: this account has no company branch scope.' });
    return false;
  }
  if (scope.branchId) {
    res.status(403).json({
      message: 'Wallet reconciliation is company-wide. Switch to All Branches to reconcile the provider clearing account.',
    });
    return false;
  }
  return true;
}

function periodFor(req: any) {
  const body = req.body || {};
  return {
    from: body.from ?? req.query?.from,
    to: body.to ?? req.query?.to,
  };
}

/** GET /api/accounting/wallet-reconciliation?accountId=&from=&to= */
export async function get_walletReconciliation(req: any, res: Response): Promise<any> {
  if (!requireCompanyScope(req, res)) return;
  return res.json(
    await readWalletReconciliation(pgPool, {
      accountId: req.query?.accountId,
      from: req.query?.from,
      to: req.query?.to,
    })
  );
}

/** POST /api/accounting/wallet-settlements */
export async function post_walletSettlement(req: any, res: Response): Promise<any> {
  if (!requireCompanyScope(req, res)) return;
  const body = req.body || {};
  const period = periodFor(req);
  const settlement = await withTransaction(async (client) => {
    const created = await createPaymentSettlement(client, body, actorOf(req));
    await logAuditEvent(
      req,
      'POST_PAYMENT_SETTLEMENT',
      'ACCOUNTING',
      `Settled ${created.settlementNumber} for wallet receipt ${created.paymentNumber}: gross ${Number(created.grossAmount).toFixed(2)}, fee ${Number(created.feeAmount).toFixed(2)}, net ${Number(created.netAmount).toFixed(2)}.`,
      undefined,
      client
    );
    return created;
  });
  const workspace = await readWalletReconciliation(pgPool, {
    accountId: settlement.walletAccountId,
    from: period.from,
    to: period.to,
  });
  return res.status(201).json({ settlement, workspace });
}

/** POST /api/accounting/wallet-reconciliation/import */
export async function post_walletReconciliationImport(req: any, res: Response): Promise<any> {
  if (!requireCompanyScope(req, res)) return;
  const body = req.body || {};
  const period = periodFor(req);
  const result = await withTransaction(async (client) => {
    const imported = await importProviderStatement(
      client,
      { accountId: body.accountId, content: body.content, format: body.format },
      actorOf(req)
    );
    await logAuditEvent(
      req,
      'IMPORT_PROVIDER_STATEMENT',
      'ACCOUNTING',
      `Imported ${imported.imported} provider statement line(s), ${imported.duplicates} duplicate(s), ${imported.autoMatched} auto-matched.`,
      undefined,
      client
    );
    return imported;
  });
  const workspace = await readWalletReconciliation(pgPool, {
    accountId: body.accountId,
    from: period.from,
    to: period.to,
  });
  return res.json({ ...result, workspace });
}

/** POST /api/accounting/wallet-reconciliation/lines/:id/match */
export async function post_walletReconciliationMatch(req: any, res: Response): Promise<any> {
  if (!requireCompanyScope(req, res)) return;
  const body = req.body || {};
  const period = periodFor(req);
  const matched = await withTransaction(async (client) => {
    const result = await matchProviderStatementLine(client, {
      lineId: req.params?.id,
      settlementId: body.settlementId,
      actor: actorOf(req),
    });
    await logAuditEvent(
      req,
      'MATCH_PROVIDER_STATEMENT_LINE',
      'ACCOUNTING',
      `Matched provider statement line ${result.lineId} to settlement ${result.settlementId} for NPR ${result.amount.toFixed(2)}.`,
      undefined,
      client
    );
    return result;
  });
  const workspace = await readWalletReconciliation(pgPool, {
    accountId: body.accountId,
    from: period.from,
    to: period.to,
  });
  return res.json({ ...matched, workspace });
}
