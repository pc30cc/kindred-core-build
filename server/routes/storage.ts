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

export const storageRouter = Router();

// Max upload size enforced at route level
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * POST /api/storage/upload
 * Upload a file through the resolved storage provider.
 * Expects multipart form data or base64 JSON.
 */
storageRouter.post('/upload', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { workspaceId, fileKey, data, contentType } = req.body;
    if (!workspaceId || !fileKey || !data) {
      return res.status(400).json({ error: 'workspaceId, fileKey, and data (base64) are required' });
    }

    // Validate file key
    if (fileKey.includes('..') || fileKey.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid file key' });
    }

    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return res.status(413).json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` });
    }

    // ── storage_gb cap enforcement (Phase 12, narrow operator-side rollout) ──
    // Forward-correct only: counter reflects traffic since the canonical
    // producer trigger went live. Existing workspaces may start undercounted;
    // see docs/STORAGE_LIMIT_POLICY.md for the accepted tradeoff. We delegate
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
