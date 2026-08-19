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
import { authorizeWorkspaceAccess, requirePlatformAdmin } from '../lib/workspaceAuth.js';

export const storageRouter = Router();

// Max upload size enforced at route level
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

// ─── Auth / Authorization ────────────────────────────────────────
//
// Identity is derived from the first-party session cookie
// (server/lib/workspaceAuth.ts) and workspace membership is verified
// server-side before the service-role client (which bypasses RLS) is ever
// used.
//
// There is no internal server-to-server caller of these HTTP routes — in-process
// callers (conversation attachments, recordings, AI file ingestion) import the
// storage service directly.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StorageAuth = { userId: string; isAdmin: boolean; role: string | null };

/**
 * Resolves the caller from the session cookie and verifies membership of
 * `workspaceId`. Writes the response and returns null when the caller is
 * rejected. Never echoes tokens or internal details back to the client.
 */
async function authorizeStorageAccess(
  req: Parameters<Parameters<typeof storageRouter.post>[1]>[0],
  res: Parameters<Parameters<typeof storageRouter.post>[1]>[1],
  _config: ServerConfig,
  workspaceId: string,
  opts: { ownerOrAdmin?: boolean } = {},
): Promise<StorageAuth | null> {
  if (!UUID_RE.test(workspaceId)) {
    res.status(400).json({ error: 'Invalid workspaceId' });
    return null;
  }
  return authorizeWorkspaceAccess(req, res, workspaceId, { manage: opts.ownerOrAdmin });
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
    const { workspaceId, fileKey } = req.body;
    if (!workspaceId || !fileKey) {
      return res.status(400).json({ error: 'workspaceId and fileKey are required' });
    }

    // Destructive: require owner/admin (or global admin).
    const auth = await authorizeStorageAccess(req, res, config, workspaceId, { ownerOrAdmin: true });
    if (!auth) return;

    const keyError = workspaceKeyError(workspaceId, fileKey);
    if (keyError) return res.status(400).json({ error: keyError });

    const result = await deleteFile(config, workspaceId, fileKey);
    return res.json(result);
  } catch (err: any) {
    console.error('[storage] Delete error:', err?.message);
    return res.status(500).json({ success: false, error: 'Delete failed' });
  }
});

/**
 * GET /api/storage/url
 * Get public URL for a file.
 */
storageRouter.get('/url', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = req.query.workspaceId as string;
    const fileKey = req.query.fileKey as string;
    if (!workspaceId || !fileKey) {
      return res.status(400).json({ error: 'workspaceId and fileKey query params required' });
    }

    const auth = await authorizeStorageAccess(req, res, config, workspaceId);
    if (!auth) return;

    const keyError = workspaceKeyError(workspaceId, fileKey);
    if (keyError) return res.status(400).json({ error: keyError });

    const url = await getFileUrl(config, workspaceId, fileKey);
    return res.json({ url });
  } catch (err: any) {
    console.error('[storage] URL error:', err?.message);
    return res.status(500).json({ error: 'Failed to resolve file URL' });
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
    // Accepts raw provider credentials and performs outbound requests —
    // platform-admin only. No workspace context, so membership does not apply.
    const adminId = await requirePlatformAdmin(req, res);
    if (!adminId) return;

    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const result = await testStorageConnection(parsed.data as any);
    return res.json(result);
  } catch (err: any) {
    console.error('[storage] Test error:', err?.message);
    return res.status(500).json({ success: false, error: 'Storage test failed' });
  }
});

/**
 * GET /api/storage/config/:workspaceId
 * Get resolved storage provider info (without secrets).
 */
storageRouter.get('/config/:workspaceId', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    // Exposes provider/bucket/CDN infrastructure metadata — owner/admin only.
    const auth = await authorizeStorageAccess(req, res, config, req.params.workspaceId, {
      ownerOrAdmin: true,
    });
    if (!auth) return;

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
    console.error('[storage] Config error:', err?.message);
    return res.status(500).json({ error: 'Failed to resolve storage config' });
  }
});
