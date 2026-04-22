/**
 * Phase 8A — Admin (super-admin) routes for call control plane.
 * Mounted under /api/admin/calls. Auth+role enforced by parent admin router.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  loadCallControlPlane,
  saveCallControlPlane,
  type CallProviderId,
} from '../services/calls/controlPlane.js';
import {
  getCallNetworkBundle,
  saveRtcEndpoints,
  invalidateRtcCache,
} from '../services/calls/rtcResolver.js';
import { resolveCallProviderOrder, getCallProvider } from '../services/calls/providerResolver.js';

export const adminCallsRouter = Router();

const PROVIDERS: CallProviderId[] = ['livekit', 'jitsi', 'janus', 'disabled'];

adminCallsRouter.get('/control-plane', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const cp = await loadCallControlPlane(config, true);
  const network = await getCallNetworkBundle(config);
  // Probe readiness for each provider id (no DB writes).
  const readiness: Record<string, boolean> = {};
  for (const id of PROVIDERS) {
    if (id === 'disabled') continue;
    const p = getCallProvider(id);
    readiness[id] = p ? await p.isReady(config).catch(() => false) : false;
  }
  res.json({ control_plane: cp, network, readiness });
});

const cpUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  primary_provider: z.enum(['livekit', 'jitsi', 'janus', 'disabled']).optional(),
  secondary_provider: z.enum(['livekit', 'jitsi', 'janus', 'disabled']).optional(),
  fallback_policy: z.enum(['lenient', 'strict']).optional(),
  max_participants: z.number().int().min(1).max(100).optional(),
  default_audio_bitrate_kbps: z.number().int().min(8).max(256).optional(),
  default_video_bitrate_kbps: z.number().int().min(64).max(8000).optional(),
  default_video_profile: z.string().max(64).optional(),
  recording_default_enabled: z.boolean().optional(),
  recording_default_type: z.enum(['composite', 'individual', 'audio_only']).optional(),
  retention_default_days: z.number().int().min(0).max(3650).optional(),
  verification_required_for_visitor_calls: z.boolean().optional(),
});

adminCallsRouter.put('/control-plane', async (req, res) => {
  try {
    const body = cpUpdateSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const merged = await saveCallControlPlane(config, body);
    res.json({ control_plane: merged });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'update_failed' });
  }
});

const rtcSchema = z.object({
  rtc_url: z.string().url().nullable().optional(),
  ws_url: z.string().url().nullable().optional(),
  recording_url: z.string().url().nullable().optional(),
  ice_policy: z.enum(['all', 'relay']).optional(),
  region: z.string().max(64).nullable().optional(),
  turn: z.object({
    urls: z.array(z.string().min(1)).max(20),
    username: z.string().nullable().optional(),
    credential: z.string().nullable().optional(),
    credential_type: z.enum(['password', 'oauth']).optional(),
    static_secret_present: z.boolean().optional(),
  }).partial().optional(),
});

adminCallsRouter.put('/rtc-endpoints', async (req, res) => {
  try {
    const body = rtcSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    await saveRtcEndpoints(config, body as any);
    invalidateRtcCache();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'update_failed' });
  }
});

adminCallsRouter.get('/probe/:workspace_id', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const order = await resolveCallProviderOrder(config, req.params.workspace_id);
  res.json({ workspace_id: req.params.workspace_id, provider_order: order });
});