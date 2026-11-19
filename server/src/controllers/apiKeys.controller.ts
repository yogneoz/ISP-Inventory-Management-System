/**
 * API creator API (Round 14 Part C).
 *
 * Orchestration only: every statement lives in models/apiKeys.repo.ts and every
 * decision (hashing, validation, rotation grace) in services/apiKeys.service.ts.
 *
 * The secret is returned exactly once, from create and rotate, in the
 * `secret` field. No other response ever contains it, and no row stores it.
 */
import type { Request, Response } from 'express';
import {
  createApiKey,
  getApiKeyAudit,
  listPublicKeys,
  publicKeyView,
  revokeApiKey,
  rotateApiKey,
} from '../services/apiKeys.service';

function actorOf(req: any) {
  const user = req.user || {};
  return {
    id: String(user.id || user.email || 'unknown'),
    email: String(user.email || ''),
    name: user.name ? String(user.name) : '',
    ip: (req.ip || req.socket?.remoteAddress || null) as string | null,
    userAgent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 400) : null,
  };
}

export async function get_apiKeys(_req: Request, res: Response): Promise<any> {
  res.set('Cache-Control', 'private, no-store');
  res.json(await listPublicKeys());
}

export async function post_apiKeys(req: Request, res: Response): Promise<any> {
  const result = await createApiKey(req.body || {}, actorOf(req));
  if ('error' in result) return res.status(result.status).json({ message: result.error });
  res.set('Cache-Control', 'private, no-store');
  res.status(201).json({
    key: publicKeyView(result.key),
    secret: result.secret,
    warning: 'Copy this API key now. For your security, it will never be shown again.',
  });
}

export async function post_rotateApiKey(req: Request, res: Response): Promise<any> {
  const graceHours = req.body?.graceHours ?? undefined;
  const result = await rotateApiKey(String(req.params.id), actorOf(req), graceHours === undefined ? 24 : Number(graceHours));
  if ('error' in result) return res.status(result.status).json({ message: result.error });
  res.set('Cache-Control', 'private, no-store');
  res.status(200).json({
    key: publicKeyView(result.key),
    secret: result.secret,
    warning: 'Copy this API key now. For your security, it will never be shown again.',
  });
}

export async function delete_apiKey(req: Request, res: Response): Promise<any> {
  const result = await revokeApiKey(String(req.params.id), actorOf(req));
  if ('error' in result) return res.status(result.status).json({ message: result.error });
  res.json({ key: publicKeyView(result.key) });
}

export async function get_apiKeyLogs(req: Request, res: Response): Promise<any> {
  const limit = Number(req.query.limit || 100);
  res.set('Cache-Control', 'private, no-store');
  res.json(await getApiKeyAudit(String(req.params.id), Number.isFinite(limit) ? limit : 100));
}
