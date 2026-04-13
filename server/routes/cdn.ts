/**
 * CDN API Routes — purge, test, config resolution
 * All CDN operations run server-side only.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  purgeCDN,
  testCDNConnection,
  resolveCDNConfig,
  getCDNAssetUrl,
  type CDNConfig,
} from '../services/cdn/index.js';

export const cdnRouter = Router();

/**
 * POST /api/cdn/purge
 * Purge CDN cache for specific paths or all.
 */
cdnRouter.post('/purge', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseServiceRoleKey && token !== config.supabaseAnonKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { workspaceId, paths } = req.body;
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required' });
    }

    const result = await purgeCDN(config, workspaceId, paths || []);
    return res.status(result.success ? 200 : 500).json(result);
  } catch (err: any) {
    console.error('[cdn] Purge error:', err.message);
    return res.status(500).json({ success: false, error: 'Purge failed' });
  }
});

/**
 * POST /api/cdn/test
 * Test CDN provider connection with real API call.
 */
const testSchema = z.object({
  provider: z.string(),
  api_key: z.string().optional(),
  api_token: z.string().optional(),
  api_secret: z.string().optional(),
  domain: z.string().optional(),
  zone_id: z.string().optional(),
  pull_zone_id: z.string().optional(),
  hostname: z.string().optional(),
  service_id: z.string().optional(),
  access_key_id: z.string().optional(),
  secret_access_key: z.string().optional(),
  distribution_id: z.string().optional(),
  zone_url: z.string().optional(),
  zone_name: z.string().optional(),
});

cdnRouter.post('/test', async (req, res) => {
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

    const d = parsed.data;
    const cdnConfig: CDNConfig = {
      provider: d.provider,
      apiKey: d.api_key || d.api_token,
      apiToken: d.api_token,
      apiSecret: d.api_secret,
      domain: d.domain,
      zoneId: d.zone_id,
      pullZoneId: d.pull_zone_id,
      hostname: d.hostname,
      serviceId: d.service_id,
      accessKeyId: d.access_key_id,
      secretAccessKey: d.secret_access_key,
      distributionId: d.distribution_id,
      zoneUrl: d.zone_url,
      zoneName: d.zone_name,
    };

    const result = await testCDNConnection(cdnConfig);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, latencyMs: 0, provider: 'unknown', error: err.message });
  }
});

/**
 * GET /api/cdn/config/:workspaceId
 * Get resolved CDN config (without secrets).
 */
cdnRouter.get('/config/:workspaceId', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const cdnConfig = await resolveCDNConfig(config, req.params.workspaceId);
    if (!cdnConfig) {
      return res.json({ configured: false });
    }

    return res.json({
      configured: true,
      provider: cdnConfig.provider,
      domain: cdnConfig.domain || cdnConfig.hostname,
      // Never expose secrets
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cdn/asset-url
 * Get CDN-rewritten URL for an asset path.
 */
cdnRouter.post('/asset-url', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== config.supabaseAnonKey && token !== config.supabaseServiceRoleKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { workspaceId, path } = req.body;
    if (!workspaceId || !path) {
      return res.status(400).json({ error: 'workspaceId and path required' });
    }

    const cdnConfig = await resolveCDNConfig(config, workspaceId);
    if (!cdnConfig) {
      return res.json({ url: path }); // passthrough if no CDN
    }

    const url = getCDNAssetUrl(cdnConfig, path);
    return res.json({ url });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
