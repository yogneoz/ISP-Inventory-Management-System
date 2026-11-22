/**
 * Partner integration API (`/api/partner/v1/*`) and its administration.
 *
 * The ingest endpoints are the only way an external subscription portal writes
 * into this ERP. Each one:
 *   1. resolves the partner from the presented API key (possession alone is not
 *      an integration — an unbound key is refused);
 *   2. replays the first response for a repeated idempotency key;
 *   3. records every attempt in `integration_inbox`, refused attempts included,
 *      so a partner's complaint can be answered from data rather than memory.
 *
 * The admin endpoints back the Integration Partners screen: register a partner,
 * bind its key, push a stock/HR snapshot, and replay a dead delivery.
 */
import type { Response } from 'express';
import { ApiError } from '../errors/ApiError';
import {
  createPartner,
  deliverOutbox,
  ingestConsumption,
  ingestSubscription,
  listPartners,
  queueHrSnapshot,
  queueStockSnapshot,
  recordInbox,
  replayIfSeen,
  replayOutbox,
  rememberResponse,
  resolvePartner,
  updatePartner,
  upsertCustomer,
} from '../services/integration.service';
import {
  BRANCH_BY_CODE_SQL,
  BRANCH_BY_ID_SQL,
  OUTBOX_LIST_SQL,
  PARTNER_BY_ID_SQL,
} from '../models/integration.repo';
import { pgPool } from '../app';

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function actorOf(req: any): string {
  return String(req.user?.email || req.user?.name || req.apiKey?.name || 'partner-api');
}

function idempotencyKey(req: any): string {
  return text(req.body?.idempotencyKey, 160) || text(req.get?.('x-idempotency-key'), 160);
}

/**
 * The app-level `enforceBranchAccess` inspects `branchId`, but the partner
 * bodies name the branch by `branchCode`. Without this the key's branch scope
 * (the whole point of binding a key to a branch) was advisory: a key scoped to
 * one branch could ingest into any branch by naming its code.
 */
async function assertKeyBranchScope(req: any, body: any): Promise<void> {
  // The key row is the SQL shape (`branch_ids`); the synthetic principal uses
  // the camelCase copy. Accept either so a mapper change cannot open the gate.
  const keyBranchIds: string[] = Array.isArray(req?.apiKey?.branch_ids)
    ? req.apiKey.branch_ids
    : Array.isArray(req?.apiKey?.branchIds)
      ? req.apiKey.branchIds
      : [];
  // An empty list is the key's company-wide scope (`createApiKey` refuses ALL).
  if (keyBranchIds.length === 0) return;
  const candidates = [body?.branchId, body?.branchCode].filter(
    (value: unknown) => typeof value === 'string' && value.trim()
  ) as string[];
  if (candidates.length === 0) return;
  const allowed = new Set(keyBranchIds.map(String));
  for (const value of candidates) {
    if (value === 'ALL') {
      throw new ApiError(403, 'A branch-scoped partner key cannot address ALL branches.', {
        code: 'PARTNER_BRANCH_SCOPE',
      });
    }
    const byId = (await pgPool.query(BRANCH_BY_ID_SQL, [value])).rows[0];
    const branch = byId || (await pgPool.query(BRANCH_BY_CODE_SQL, [value])).rows[0];
    // An unknown branch is the service's own 404/CUSTOMER_NOT_LINKED answer.
    if (!branch) continue;
    if (!allowed.has(String(branch.id))) {
      throw new ApiError(403, 'This API key is not scoped for the requested branch.', {
        code: 'PARTNER_BRANCH_SCOPE',
      });
    }
  }
}

/**
 * One shape for all three ingest routes: replay-or-run, remember the response,
 * and always leave an inbox row behind.
 */
async function ingest(
  req: any,
  res: Response,
  kind: string,
  work: (partner: any, actor: string) => Promise<{ status: number; body: any }>
): Promise<any> {
  const partner = await resolvePartner(req);
  const key = idempotencyKey(req);
  const scope = `partner.${kind}`;
  const replay = await replayIfSeen(scope, key, req.body);
  if (replay.replayed) {
    // A replay is still an attempt: the inbox records it, marked as such, so a
    // partner can see the duplicate arrived and was answered from the stored
    // response rather than applied twice.
    await recordInbox(partner, kind, key, req.body, 'ACCEPTED', {
      message: 'idempotent replay: answered from the stored response',
    });
    return res.status(200).json({ ...replay.body, replayed: true });
  }
  try {
    await assertKeyBranchScope(req, req.body);
    const outcome = await work(partner, actorOf(req));
    await rememberResponse(scope, key, req.body, outcome.status, outcome.body);
    await recordInbox(partner, kind, key, req.body, 'ACCEPTED');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(outcome.status).json(outcome.body);
  } catch (err: any) {
    await recordInbox(partner, kind, key, req.body, err instanceof ApiError ? 'REFUSED' : 'FAILED', {
      code: err?.code,
      message: String(err?.message || err),
    });
    throw err;
  }
}

/** POST /api/partner/v1/customers */
export async function post_partnerCustomer(req: any, res: Response): Promise<any> {
  return ingest(req, res, 'CUSTOMER', (partner, actor) => upsertCustomer(partner, req.body, actor));
}

/** POST /api/partner/v1/subscriptions */
export async function post_partnerSubscription(req: any, res: Response): Promise<any> {
  return ingest(req, res, 'SUBSCRIPTION', (partner, actor) =>
    ingestSubscription(partner, req.body, actor)
  );
}

/** POST /api/partner/v1/stock/consumptions */
export async function post_partnerConsumption(req: any, res: Response): Promise<any> {
  return ingest(req, res, 'STOCK_CONSUMPTION', (partner, actor) =>
    ingestConsumption(partner, req.body, actor)
  );
}

/** GET /api/admin/integration/partners */
export async function get_integrationPartners(req: any, res: Response): Promise<any> {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await listPartners());
}

/** POST /api/admin/integration/partners */
export async function post_integrationPartner(req: any, res: Response): Promise<any> {
  const partner = await createPartner(req.body || {}, actorOf(req));
  return res.status(201).json(partner);
}

/** PATCH /api/admin/integration/partners/:id */
export async function patch_integrationPartner(req: any, res: Response): Promise<any> {
  return res.json(await updatePartner(String(req.params?.id || ''), req.body || {}));
}

/** GET /api/admin/integration/outbox?status=&limit= */
export async function get_integrationOutbox(req: any, res: Response): Promise<any> {
  const status = text(req.query?.status, 20).toUpperCase() || null;
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query?.limit) || 50)));
  const rows = (await pgPool.query(OUTBOX_LIST_SQL, [status, limit])).rows;
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(rows);
}

/** POST /api/admin/integration/outbox/:id/replay */
export async function post_integrationOutboxReplay(req: any, res: Response): Promise<any> {
  return res.json(await replayOutbox(String(req.params?.id || '')));
}

/** POST /api/admin/integration/deliver — drain the outbox now. */
export async function post_integrationDeliver(req: any, res: Response): Promise<any> {
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.body?.limit) || 20)));
  return res.json(await deliverOutbox(limit));
}

async function partnerForAdmin(id: string): Promise<any> {
  // The admin path is `:id` — the value the partners list returns and the value
  // PATCH uses. Looking it up by code here 404'd every push from the screen.
  const row = (await pgPool.query(PARTNER_BY_ID_SQL, [id])).rows[0];
  if (!row) throw new ApiError(404, 'Integration partner not found.');
  return row;
}

/** POST /api/admin/integration/partners/:id/push/stock */
export async function post_integrationPushStock(req: any, res: Response): Promise<any> {
  const partner = await partnerForAdmin(String(req.params?.id || ''));
  const outcome = await queueStockSnapshot(
    partner,
    text(req.body?.branchId, 50) || null,
    text(req.body?.cursor, 50) || null,
    Math.trunc(Number(req.body?.limit) || 200)
  );
  return res.status(201).json({ partner: partner.code, ...outcome });
}

/** POST /api/admin/integration/partners/:id/push/hr */
export async function post_integrationPushHr(req: any, res: Response): Promise<any> {
  const partner = await partnerForAdmin(String(req.params?.id || ''));
  const outcome = await queueHrSnapshot(
    partner,
    text(req.body?.branchId, 50) || null,
    text(req.body?.cursor, 50) || null,
    Math.trunc(Number(req.body?.limit) || 200)
  );
  return res.status(201).json({ partner: partner.code, ...outcome });
}
