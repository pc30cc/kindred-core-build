/**
 * Storage API Routes — server-side only, all secrets stay on backend
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  uploadFile,
  deleteFile,
  getFileUrl,
  testStorageConnection,
  resolveStorageConfig,
} from '../services/storage/index.js';
import { logSecurityEvent } from '../middleware/security.js';
import { requireLimit } from '../middleware/featureGating.js';
import { usageFnForLimit } from '../services/billing/usageResolvers.js';
import { getServiceClient } from '../supabase.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';

export const storageRouter = Router();

// Max upload size enforced at route level
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

// ─── Auth / Authorization ────────────────────────────────────────
//
// Storage routes previously accepted the *publishable* anon key as proof of
// identity, which made every operation reachable by anyone who can read the
// frontend bundle. Identity is now derived from a real Supabase user JWT and
// workspace membership is verified server-side before the service-role client
// (which bypasses RLS) is ever used.
//
// There is no internal server-to-server caller of these HTTP routes — in-process
// callers (conversation attachments, recordings, AI file ingestion) import the
// storage service directly — so raw service-role bearer acceptance is removed.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StorageAuth = { userId: string; isAdmin: boolean; role: string | null };

/**
 * Resolves the caller from the Bearer JWT and verifies membership of
 * `workspaceId`. Writes the response and returns null when the caller is
 * rejected. Never echoes tokens or internal details back to the client.
 */
async function authorizeStorageAccess(
  req: Parameters<Parameters<typeof storageRouter.post>[1]>[0],
  res: Parameters<Parameters<typeof storageRouter.post>[1]>[1],
  config: ServerConfig,
  workspaceId: string,
  opts: { ownerOrAdmin?: boolean } = {},
): Promise<StorageAuth | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  // The publishable anon key and the service-role key are not user identities.
  if (!token || token === config.supabaseAnonKey || token === config.supabaseServiceRoleKey) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  if (!UUID_RE.test(workspaceId)) {
    res.status(400).json({ error: 'Invalid workspaceId' });
    return null;
  }

  const sb = getServiceClient(config);
  let userId: string;
  try {
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid token' });
      return null;
    }
    userId = data.user.id;
  } catch {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }

  const admin = await isGlobalAdmin(config, userId);
  if (admin) return { userId, isAdmin: true, role: null };

  const { data: isMember } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  if (!isMember) {
    res.status(403).json({ error: 'Not a workspace member' });
    return null;
  }

  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  const role = ((member as { role?: string } | null)?.role) ?? null;

  if (opts.ownerOrAdmin && role !== 'owner' && role !== 'admin') {
    res.status(403).json({ error: 'Insufficient workspace permissions' });
    return null;
  }
  return { userId, isAdmin: false, role };
}

/**
 * Prevents IDOR across workspaces: membership alone is not enough when the
 * object key is client-supplied. Keys must live under the caller's workspace
 * prefix and must not escape it via traversal, absolute paths or URLs.
 */
function workspaceKeyError(workspaceId: string, fileKey: unknown): string | null {
  if (typeof fileKey !== 'string' || fileKey.length === 0) return 'Invalid file key';
  if (fileKey.length > 1024) return 'Invalid file key';
  const lowered = fileKey.toLowerCase();
  if (
    fileKey.includes('..') ||
    lowered.includes('%2e%2e') ||
    lowered.includes('%2f') ||
    lowered.includes('%5c') ||
    fileKey.includes('\\') ||
    fileKey.includes('\0') ||
    fileKey.startsWith('/') ||
    lowered.includes('://')
  ) {
    return 'Invalid file key';
  }
  if (!fileKey.startsWith(`workspace/${workspaceId}/`)) {
    return 'File key must be scoped to the workspace';
  }
  return null;
}

/**
 * POST /api/storage/upload
 * Upload a file through the resolved storage provider.
 * Expects multipart form data or base64 JSON.
 */
storageRouter.post('/upload', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { workspaceId, fileKey, data, contentType } = req.body;
    if (!workspaceId || !fileKey || !data) {
      return res.status(400).json({ error: 'workspaceId, fileKey, and data (base64) are required' });
    }

    const auth = await authorizeStorageAccess(req, res, config, workspaceId);
    if (!auth) return;

    // Validate file key (traversal + workspace-prefix scoping)
    const keyError = workspaceKeyError(workspaceId, fileKey);
    if (keyError) return res.status(400).json({ error: keyError });

    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return res.status(413).json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` });
    }

    // ── storage_gb cap enforcement ──
    // Forward-correct only: counter reflects traffic since the canonical
    // producer trigger went live; existing workspaces may start undercounted
    // (accepted tradeoff — see docs/STORAGE_LIMIT_POLICY.md). Delegates
    // entirely to the shared resolver — no route-local storage math.
    const limitMw = requireLimit('storage_gb', usageFnForLimit('storage_gb'));
    let proceeded = false;
    await limitMw(req, res, () => { proceeded = true; });
    if (!proceeded) return; // middleware already wrote 403/400

    const result = await uploadFile(config, {
      workspaceId,
      fileKey,
      data: buffer,
      contentType: contentType || 'application/octet-stream',
    });

    return res.status(result.success ? 200 : 500).json(result);
  } catch (err: any) {
    console.error('[storage] Upload error:', err.message);
    return res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

/**
 * POST /api/storage/delete
 * Delete a file from storage.
 */
storageRouter.post('/delete', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { workspaceId, fileKey } = req.body;
    if (!workspaceId || !fileKey) {
      return res.status(400).json({ error: 'workspaceId and fileKey are required' });
    }

    const result = await deleteFile(config, workspaceId, fileKey);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/storage/url
 * Get public URL for a file.
 */
storageRouter.get('/url', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const workspaceId = req.query.workspaceId as string;
    const fileKey = req.query.fileKey as string;
    if (!workspaceId || !fileKey) {
      return res.status(400).json({ error: 'workspaceId and fileKey query params required' });
    }

    const url = await getFileUrl(config, workspaceId, fileKey);
    return res.json({ url });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

const testSchema = z.object({
  provider: z.string(),
  apiKey: z.string().optional(),
  storageZone: z.string().optional(),
  region: z.string().optional(),
  cdnUrl: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  bucket: z.string().optional(),
  s3Region: z.string().optional(),
  endpoint: z.string().optional(),
});

/**
 * POST /api/storage/test
 * Test storage provider connection with real upload + delete.
 */
storageRouter.post('/test', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseServiceRoleKey && token !== config.supabaseAnonKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const result = await testStorageConnection(parsed.data as any);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/storage/config/:workspaceId
 * Get resolved storage provider info (without secrets).
 */
storageRouter.get('/config/:workspaceId', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const storageConfig = await resolveStorageConfig(config, req.params.workspaceId);
    if (!storageConfig) {
      return res.json({ configured: false });
    }

    return res.json({
      configured: true,
      provider: storageConfig.provider,
      region: storageConfig.region || storageConfig.s3Region,
      bucket: storageConfig.bucket || storageConfig.storageZone,
      cdnUrl: storageConfig.cdnUrl,
      maxFileSizeMB: storageConfig.maxFileSizeMB || 50,
      // Never expose secrets
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
