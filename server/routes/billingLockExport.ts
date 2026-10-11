// ============================================================================
// SIMPLE BILLING phase 4 — the owner's export of locked data (design §7;
// docs/billing/SIMPLE_BILLING.md: "Locked data can always be exported by the
// owner"). Mounted under /api/billing/account, before billingAccountRouter:
//
//   POST /:ws/locked-export {kinds?}            start one (202 {job}; 409 while one runs)
//   GET  /:ws/locked-export                     the latest job ({job|null})
//   POST /:ws/locked-export/:id/download-token  a single-use download token
//   GET  /locked-export/download?token=         the ZIP
//
// Only the workspace's owner (workspaces.owner_id), on every plan and
// whatever `contact_export` says. The job is built by
// services/billing/locks/exportWorker.ts; its file is kept 7 days and is
// only ever streamed through a token, which works once and for 15 minutes.
// ============================================================================

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import {
  LOCK_EXPORT_KINDS,
  hashLockExportToken,
  publicLockExport,
  readLockExportArtifact,
  type LockExportRow,
} from '../services/billing/locks/exportWorker.js';

export const billingLockExportRouter = Router();

/** How long a download token works. */
const TOKEN_TTL_MS = 15 * 60_000;

const startSchema = z.object({
  kinds: z.array(z.enum(LOCK_EXPORT_KINDS)).min(1).max(LOCK_EXPORT_KINDS.length).optional(),
}).strict();

const missingTable = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (error.code === '42P01' || error.code === 'PGRST205' || /billing_lock_exports/.test(error.message ?? '') && /exist|schema cache/i.test(error.message ?? ''));

/** The workspace's owner, or an answer already sent (403 for anyone else). */
async function ownerOnly(req: Request, res: Response, workspaceId: unknown): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  const { data, error } = await getServiceClient(serverConfigOf(req))
    .from('workspaces')
    .select('owner_id')
    .eq('id', String(workspaceId))
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
    return null;
  }
  if (!data || (data as { owner_id?: string | null }).owner_id !== auth.userId) {
    res.status(403).json({ error: 'FORBIDDEN', reason: 'owner_only' });
    return null;
  }
  return { userId: auth.userId };
}

async function latestJob(req: Request, workspaceId: string): Promise<LockExportRow | null> {
  const { data, error } = await getServiceClient(serverConfigOf(req))
    .from('billing_lock_exports')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { code: (error as { code?: string }).code });
  return (data as LockExportRow | null) ?? null;
}

function failed(res: Response, e: unknown) {
  if (missingTable(e as { code?: string; message?: string })) return res.status(503).json({ error: 'EXPORT_UNAVAILABLE' });
  console.error('[billing-lock-export]', e instanceof Error ? e.message : e);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}

// Declared first: "locked-export" is not a workspace id.
billingLockExportRouter.get('/locked-export/download', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token || token.length > 200) return res.status(400).json({ error: 'TOKEN_REQUIRED' });
  const sb = getServiceClient(serverConfigOf(req));
  const hash = hashLockExportToken(token);
  try {
    // Single use: the token is cleared by the read that accepts it.
    const { data, error } = await sb
      .from('billing_lock_exports')
      .update({ download_token_hash: null })
      .eq('download_token_hash', hash)
      .eq('status', 'completed')
      .gt('updated_at', new Date(Date.now() - TOKEN_TTL_MS).toISOString())
      .select('*');
    if (error) throw error;
    const job = (Array.isArray(data) ? data[0] : null) as LockExportRow | null;
    if (!job) return res.status(403).json({ error: 'INVALID_TOKEN' });
    if (!job.artifact_storage_key || (job.expires_at && Date.parse(job.expires_at) <= Date.now())) {
      return res.status(410).json({ error: 'EXPORT_EXPIRED' });
    }
    const buffer = await readLockExportArtifact(serverConfigOf(req), job);
    if (!buffer) return res.status(410).json({ error: 'EXPORT_MISSING' });
    const day = new Date(job.created_at).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="locked-data-${day}-${job.id.slice(0, 8)}.zip"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buffer);
  } catch (e) {
    return failed(res, e);
  }
});

billingLockExportRouter.post('/:workspaceId/locked-export', async (req, res) => {
  const owner = await ownerOnly(req, res, req.params.workspaceId);
  if (!owner) return;
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const workspaceId = req.params.workspaceId;
  const sb = getServiceClient(serverConfigOf(req));
  try {
    const { data, error } = await sb
      .from('billing_lock_exports')
      .insert({
        workspace_id: workspaceId,
        requested_by: owner.userId,
        status: 'pending',
        kinds: parsed.data.kinds ? [...new Set(parsed.data.kinds)] : [...LOCK_EXPORT_KINDS],
      })
      .select('*')
      .single();
    if (error) {
      // billing_lock_exports_one_live: one pending or running job per workspace.
      if ((error as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'EXPORT_RUNNING', job: publicLockExport(await latestJob(req, workspaceId)) });
      }
      throw Object.assign(new Error(error.message), { code: (error as { code?: string }).code });
    }
    return res.status(202).json({ job: publicLockExport(data as LockExportRow) });
  } catch (e) {
    return failed(res, e);
  }
});

billingLockExportRouter.get('/:workspaceId/locked-export', async (req, res) => {
  const owner = await ownerOnly(req, res, req.params.workspaceId);
  if (!owner) return;
  try {
    return res.json({ job: publicLockExport(await latestJob(req, req.params.workspaceId)) });
  } catch (e) {
    return failed(res, e);
  }
});

billingLockExportRouter.post('/:workspaceId/locked-export/:jobId/download-token', async (req, res) => {
  const owner = await ownerOnly(req, res, req.params.workspaceId);
  if (!owner) return;
  if (!/^[0-9a-f-]{36}$/i.test(req.params.jobId)) return res.status(404).json({ error: 'NOT_FOUND' });
  const sb = getServiceClient(serverConfigOf(req));
  try {
    const { data: row, error } = await sb
      .from('billing_lock_exports')
      .select('*')
      .eq('id', req.params.jobId)
      .eq('workspace_id', req.params.workspaceId)
      .maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { code: (error as { code?: string }).code });
    const job = row as LockExportRow | null;
    if (!job) return res.status(404).json({ error: 'NOT_FOUND' });
    if (job.status !== 'completed' || !job.artifact_storage_key) return res.status(409).json({ error: 'EXPORT_NOT_READY' });
    if (job.expires_at && Date.parse(job.expires_at) <= Date.now()) return res.status(410).json({ error: 'EXPORT_EXPIRED' });

    const token = crypto.randomBytes(32).toString('base64url');
    const { data: saved, error: saveError } = await sb
      .from('billing_lock_exports')
      .update({ download_token_hash: hashLockExportToken(token), updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'completed')
      .select('id');
    if (saveError) throw Object.assign(new Error(saveError.message), { code: (saveError as { code?: string }).code });
    if (!Array.isArray(saved) || !saved.length) return res.status(409).json({ error: 'EXPORT_NOT_READY' });
    return res.json({ token, expiresAt: job.expires_at });
  } catch (e) {
    return failed(res, e);
  }
});
