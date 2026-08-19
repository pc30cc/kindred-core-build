/**
 * Privacy routes — GDPR export / delete request flow.
 *
 * Auth: first-party session cookie (server/lib/workspaceAuth.ts, operator).
 * Authorization: workspace admin for contact/visitor jobs, self for user jobs.
 * Rate limiting: ad-hoc per-workspace counters (project policy: no shared
 * primitives yet).
 */

import { Router } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { resolveSubject } from '../services/privacy/identity.js';
import { issueReauthToken, consumeReauthToken } from '../services/privacy/reauth.js';
import { writePrivacyAudit } from '../services/privacy/audit.js';
import { readLegacyArtifact, deleteLegacyArtifact } from '../services/privacy/artifactStore.js';
import { resolvePrivacyStoragePolicy } from '../services/privacy/storageResolver.js';
import { downloadWithConfig, deleteWithConfig } from '../services/storage/index.js';
import type { PrivacyAction, PrivacySubjectType } from '../services/privacy/types.js';
import { requireUser as requireSessionUser } from '../lib/workspaceAuth.js';
import { findIdentityById } from '../services/auth/identity.js';
import { verifyPassword } from '../services/auth/password.js';

export const privacyRouter = Router();

// ─── Auth helper ───────────────────────────────────────────────────
async function authUser(req: any, res: any, config: ServerConfig): Promise<{ userId: string; email: string | null } | null> {
  const userId = await requireSessionUser(req, res);
  if (!userId) return null;
  const identity = await findIdentityById(config, userId);
  if (!identity) {
    res.status(401).json({ error: 'Account not found' });
    return null;
  }
  return { userId: identity.id, email: identity.email || null };
}

async function isWorkspaceAdmin(config: ServerConfig, workspaceId: string, userId: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data } = await sb.rpc('get_workspace_role', { _workspace_id: workspaceId, _user_id: userId });
  return data === 'owner' || data === 'admin';
}

// ─── Ad-hoc rate limiter ───────────────────────────────────────────
// Per project policy: no shared rate-limit primitives. We track in-memory
// per-workspace and per-user counters with simple windows.
const rlExport = new Map<string, { count: number; windowStart: number }>();
const rlDelete = new Map<string, { count: number; windowStart: number }>();
const HOUR = 60 * 60_000;

function rateLimit(map: Map<string, { count: number; windowStart: number }>, key: string, max: number): boolean {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > HOUR) {
    map.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// ─── POST /api/privacy/reauth ───────────────────────────────────────
const reauthSchema = z.object({
  password: z.string().min(1).max(255).optional(),
  // For OAuth-only users: a fresh access token from the active session
  // counts as proof when password isn't available. Caller passes the same
  // bearer token; we accept its presence only (already validated above).
  oauth: z.boolean().optional(),
});

privacyRouter.post('/reauth', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const me = await authUser(req, res, config);
  if (!me) return;

  const parsed = reauthSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

  if (parsed.data.password) {
    if (!me.email) return res.status(400).json({ error: 'No email on account' });
    const identity = await findIdentityById(config, me.userId);
    if (!identity?.passwordHash || !(await verifyPassword(identity.passwordHash, parsed.data.password))) {
      return res.status(401).json({ error: 'Invalid password' });
    }
  } else if (!parsed.data.oauth) {
    return res.status(400).json({ error: 'password or oauth=true required' });
  }

  const { token, expiresAt } = issueReauthToken(me.userId);
  await writePrivacyAudit(config, {
    workspaceId: null,
    userId: me.userId,
    action: 'privacy.reauth.issued',
    jobId: null,
  });
  return res.json({ token, expiresAt });
});

// ─── POST /api/privacy/jobs ─────────────────────────────────────────
const createSchema = z.object({
  subject_type: z.enum(['contact', 'visitor', 'user']),
  subject_id: z.string().min(1).max(255),
  action: z.enum(['export', 'delete']),
  workspace_id: z.string().uuid().optional(),
  scope: z.object({ include_notes: z.boolean().optional() }).optional(),
  reauth_token: z.string().optional(),
});

privacyRouter.post('/jobs', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const me = await authUser(req, res, config);
  if (!me) return;

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const body = parsed.data;

  // ─── Authorization ────────────────────────────────────────────
  if (body.subject_type === 'user') {
    if (body.subject_id !== me.userId) {
      return res.status(403).json({ error: 'Cannot create user-subject jobs for another user' });
    }
  } else {
    if (!body.workspace_id) return res.status(400).json({ error: 'workspace_id required for contact/visitor jobs' });
    const ok = await isWorkspaceAdmin(config, body.workspace_id, me.userId);
    if (!ok) return res.status(403).json({ error: 'Workspace admin required' });
  }

  // ─── Reauth requirement ───────────────────────────────────────
  // Required for: any delete job, and user-subject self-export.
  const needsReauth = body.action === 'delete' || (body.action === 'export' && body.subject_type === 'user');
  if (needsReauth) {
    if (!consumeReauthToken(me.userId, body.reauth_token)) {
      return res.status(401).json({ error: 'Re-authentication required', code: 'REAUTH_REQUIRED' });
    }
  }

  // ─── Rate limit ──────────────────────────────────────────────
  const wsKey = body.workspace_id || `user:${me.userId}`;
  const ok =
    body.action === 'export'
      ? rateLimit(rlExport, wsKey, 5)
      : rateLimit(rlDelete, wsKey, 2);
  if (!ok) return res.status(429).json({ error: 'Rate limit exceeded for privacy jobs in this workspace' });

  // ─── Self-delete ownership guard (user-subject) ──────────────
  if (body.action === 'delete' && body.subject_type === 'user') {
    const sb = getServiceClient(config);
    const { data: ownedAccounts } = await sb.from('accounts').select('id').eq('owner_id', me.userId).limit(1);
    if (ownedAccounts && ownedAccounts.length > 0) {
      return res.status(409).json({
        error: 'Cannot self-delete while owning an account. Transfer ownership first.',
        code: 'OWNS_ACCOUNT',
      });
    }
  }

  // ─── Resolve identity up front (also persisted by the worker) ─
  const resolved = await resolveSubject(config, body.workspace_id || null, body.subject_type as PrivacySubjectType, body.subject_id);

  // ─── Subject email hash for later anonymized lookup ──────────
  const subjectEmailHash =
    resolved.emails.length > 0
      ? crypto.createHash('sha256').update(resolved.emails[0].toLowerCase()).digest('hex')
      : null;

  // ─── Insert job ──────────────────────────────────────────────
  const sb = getServiceClient(config);
  const { data: job, error } = await sb
    .from('privacy_jobs')
    .insert({
      workspace_id: body.workspace_id || null,
      actor_user_id: me.userId,
      subject_type: body.subject_type,
      subject_id: body.subject_id,
      subject_email_hash: subjectEmailHash,
      resolved_identity: resolved as any,
      action: body.action as PrivacyAction,
      status: 'pending',
      scope: (body.scope as any) || {},
    })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await writePrivacyAudit(config, {
    workspaceId: body.workspace_id || null,
    userId: me.userId,
    action: body.action === 'export' ? 'privacy.export.requested' : 'privacy.delete.requested',
    jobId: job.id,
    metadata: { subject_type: body.subject_type, subject_id: body.subject_id, resolved },
    ip: req.ip,
  });

  return res.status(201).json({ job });
});

// ─── GET /api/privacy/jobs ──────────────────────────────────────────
privacyRouter.get('/jobs', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const me = await authUser(req, res, config);
  if (!me) return;

  const workspaceId = (req.query.workspace_id as string) || null;
  const sb = getServiceClient(config);
  let query = sb.from('privacy_jobs').select('*').order('requested_at', { ascending: false }).limit(100);

  if (workspaceId) {
    const ok = await isWorkspaceAdmin(config, workspaceId, me.userId);
    if (!ok) return res.status(403).json({ error: 'Workspace admin required' });
    query = query.eq('workspace_id', workspaceId);
  } else {
    // No workspace filter — return only this user's user-subject jobs.
    query = query.eq('actor_user_id', me.userId).eq('subject_type', 'user');
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ jobs: data });
});

// ─── GET /api/privacy/jobs/:id ──────────────────────────────────────
privacyRouter.get('/jobs/:id', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const me = await authUser(req, res, config);
  if (!me) return;

  const sb = getServiceClient(config);
  const { data: job, error } = await sb.from('privacy_jobs').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  // Authorization: actor for self-jobs, workspace admin otherwise.
  if (job.subject_type === 'user') {
    if (job.actor_user_id !== me.userId) return res.status(403).json({ error: 'Forbidden' });
  } else if (job.workspace_id) {
    const ok = await isWorkspaceAdmin(config, job.workspace_id, me.userId);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  } else {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Strip download_token_hash from response — it's a secret.
  const { download_token_hash, ...safe } = job as any;
  return res.json({ job: safe });
});

// ─── POST /api/privacy/jobs/:id/cancel ──────────────────────────────
privacyRouter.post('/jobs/:id/cancel', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const me = await authUser(req, res, config);
  if (!me) return;

  const sb = getServiceClient(config);
  const { data: job } = await sb.from('privacy_jobs').select('*').eq('id', req.params.id).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Not found' });

  if (job.subject_type === 'user') {
    if (job.actor_user_id !== me.userId) return res.status(403).json({ error: 'Forbidden' });
  } else if (job.workspace_id) {
    const ok = await isWorkspaceAdmin(config, job.workspace_id, me.userId);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  } else {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (job.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending jobs can be cancelled' });
  }

  const { data: updated, error } = await sb
    .from('privacy_jobs')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  await writePrivacyAudit(config, {
    workspaceId: job.workspace_id,
    userId: me.userId,
    action: 'privacy.job.cancelled',
    jobId: job.id,
  });

  return res.json({ job: updated });
});

// ─── Issue download token ──────────────────────────────────────────
// Operators call this once the job is completed. We mint a single-use,
// short-lived token and store its hash in the job row.
privacyRouter.post('/jobs/:id/download-token', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const me = await authUser(req, res, config);
  if (!me) return;

  const sb = getServiceClient(config);
  const { data: job } = await sb.from('privacy_jobs').select('*').eq('id', req.params.id).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Not found' });

  if (job.subject_type === 'user') {
    if (job.actor_user_id !== me.userId) return res.status(403).json({ error: 'Forbidden' });
  } else if (job.workspace_id) {
    const ok = await isWorkspaceAdmin(config, job.workspace_id, me.userId);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  } else {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (job.action !== 'export' || job.status !== 'completed' || !job.artifact_path) {
    return res.status(409).json({ error: 'Export not ready' });
  }
  if (job.expires_at && new Date(job.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Export expired' });
  }
  if ((job.download_count ?? 0) >= 3) {
    return res.status(429).json({ error: 'Download limit reached' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await sb.from('privacy_jobs').update({ download_token_hash: tokenHash }).eq('id', job.id);

  return res.json({ token, expiresAt: job.expires_at });
});

// ─── GET /api/privacy/exports/:job_id/download ─────────────────────
privacyRouter.get('/exports/:job_id/download', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const token = (req.query.token as string) || '';
  if (!token) return res.status(400).json({ error: 'token required' });

  const sb = getServiceClient(config);
  const { data: job } = await sb.from('privacy_jobs').select('*').eq('id', req.params.job_id).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.action !== 'export' || job.status !== 'completed' || !job.artifact_path) {
    return res.status(409).json({ error: 'Export not ready' });
  }
  if (job.expires_at && new Date(job.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Export expired' });
  }
  if ((job.download_count ?? 0) >= 3) {
    return res.status(429).json({ error: 'Download limit reached' });
  }

  const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
  if (!job.download_token_hash || expectedHash !== job.download_token_hash) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  // Resolve artifact bytes — provider-based for new jobs, legacy local
  // disk for jobs created before the storage-provider refactor.
  let buf: Buffer | null = null;
  if (job.artifact_storage_provider && job.artifact_storage_key) {
    try {
      const policy = await resolvePrivacyStoragePolicy(config, job.workspace_id);
      // If the workspace/platform policy now points at a different
      // provider than the one that stored this artifact, still try to
      // read using a config that matches the recorded provider name —
      // we only have policy.config available, so we attempt with the
      // current resolved config (matches in the common case of an
      // unchanged policy). Provider name mismatch falls through to a
      // 410 below.
      if (policy.provider === job.artifact_storage_provider) {
        const dl = await downloadWithConfig(policy.config, job.artifact_storage_key);
        if (dl.success && dl.data) buf = dl.data;
      }
    } catch {
      // configuration error → fall through to 410
    }
  } else {
    // Legacy on-disk artifact (pre-refactor jobs)
    buf = readLegacyArtifact(job.id);
  }
  if (!buf) return res.status(410).json({ error: 'Artifact missing' });

  // Single-use: invalidate the token immediately + bump count.
  await sb
    .from('privacy_jobs')
    .update({ download_token_hash: null, download_count: (job.download_count ?? 0) + 1 })
    .eq('id', job.id);

  await writePrivacyAudit(config, {
    workspaceId: job.workspace_id,
    userId: job.actor_user_id,
    action: 'privacy.export.downloaded',
    jobId: job.id,
    metadata: { sha256: job.artifact_hash },
    ip: req.ip,
  });

  // Auto-purge after first download — through whichever store actually holds it.
  if (job.artifact_storage_provider && job.artifact_storage_key) {
    try {
      const policy = await resolvePrivacyStoragePolicy(config, job.workspace_id);
      if (policy.provider === job.artifact_storage_provider) {
        await deleteWithConfig(policy.config, job.artifact_storage_key);
      }
    } catch {
      // best-effort delete; TTL sweep will retry later
    }
  } else {
    deleteLegacyArtifact(job.id);
  }
  await sb
    .from('privacy_jobs')
    .update({ artifact_path: null, artifact_storage_key: null })
    .eq('id', job.id);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="privacy-export-${job.id}.zip"`);
  res.setHeader('Content-Length', String(buf.length));
  return res.end(buf);
});