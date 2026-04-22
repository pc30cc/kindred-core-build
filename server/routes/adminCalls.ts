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
import { ALL_CALL_PERMISSIONS, invalidatePermissionCache } from '../services/calls/permissions.js';
import { getServiceClient } from '../supabase.js';
import {
  getCallNetworkBundle,
  saveRtcEndpoints,
  invalidateRtcCache,
} from '../services/calls/rtcResolver.js';
import { resolveCallProviderOrder, getCallProvider } from '../services/calls/providerResolver.js';
import {
  loadAgoraConfig,
  saveAgoraConfig,
  toPublicView,
} from '../services/calls/agoraConfig.js';
import {
  loadLiveKitConfig,
  saveLiveKitConfig,
  toPublicView as toLiveKitPublicView,
} from '../services/calls/livekitConfig.js';
import { CALL_PROVIDER_CLASSIFICATION } from '../services/calls/providers/types.js';

export const adminCallsRouter = Router();

const PROVIDERS: CallProviderId[] = ['livekit', 'jitsi', 'janus', 'agora_cloud', 'disabled'];

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
  res.json({
    control_plane: cp,
    network,
    readiness,
    classification: CALL_PROVIDER_CLASSIFICATION,
  });
});

const cpUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  primary_provider: z.enum(['livekit', 'jitsi', 'janus', 'agora_cloud', 'disabled']).optional(),
  secondary_provider: z.enum(['livekit', 'jitsi', 'janus', 'agora_cloud', 'disabled']).optional(),
  fallback_policy: z.enum(['lenient', 'strict']).optional(),
  max_participants: z.number().int().min(1).max(100).optional(),
  default_audio_bitrate_kbps: z.number().int().min(8).max(256).optional(),
  default_video_bitrate_kbps: z.number().int().min(64).max(8000).optional(),
  default_video_profile: z.string().max(64).optional(),
  recording_default_enabled: z.boolean().optional(),
  recording_default_type: z.enum(['composite', 'individual', 'audio_only']).optional(),
  retention_default_days: z.number().int().min(0).max(3650).optional(),
  verification_required_for_visitor_calls: z.boolean().optional(),
  // Phase 8C — global channel gates
  voice_calls_enabled_global: z.boolean().optional(),
  video_calls_enabled_global: z.boolean().optional(),
  call_recording_enabled_global: z.boolean().optional(),
  call_queue_enabled_global: z.boolean().optional(),
  visitor_initiated_audio_enabled_global: z.boolean().optional(),
  visitor_initiated_video_enabled_global: z.boolean().optional(),
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

// ────────────────────────────────────────────────────────────────────────
// Agora (external / cloud) provider config — read returns secret-presence
// flags only. Writes accept full secrets; passing null/undefined preserves
// existing values, passing empty string clears them.
// ────────────────────────────────────────────────────────────────────────
adminCallsRouter.get('/agora', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const cfg = await loadAgoraConfig(config, true);
  res.json({ agora: toPublicView(cfg) });
});

const agoraSchema = z.object({
  enabled: z.boolean().optional(),
  app_id: z.string().max(128).nullable().optional(),
  app_certificate: z.string().max(256).nullable().optional(),
  token_secret: z.string().max(512).nullable().optional(),
  region: z.string().max(64).nullable().optional(),
  webhook_url: z.string().url().nullable().optional(),
  recording_config: z
    .object({
      enabled: z.boolean().optional(),
      storage_vendor: z.string().max(64).nullable().optional(),
      storage_bucket: z.string().max(256).nullable().optional(),
    })
    .partial()
    .optional(),
});

adminCallsRouter.put('/agora', async (req, res) => {
  try {
    const body = agoraSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    // Only persist secret fields when the caller actually included them
    // (presence-based, not value-based, so an empty string explicitly clears).
    const patch: Record<string, unknown> = { ...body };
    if (!('app_certificate' in body)) delete patch.app_certificate;
    if (!('token_secret' in body)) delete patch.token_secret;
    const merged = await saveAgoraConfig(config, patch as any);
    res.json({ agora: toPublicView(merged) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'update_failed' });
  }
});

// ────────────────────────────────────────────────────────────────────────
// LiveKit (self-hosted) config — read returns secret-presence flags only.
// Writes use presence-aware semantics: omit to preserve, "" to clear.
// ────────────────────────────────────────────────────────────────────────
adminCallsRouter.get('/livekit', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const cfg = await loadLiveKitConfig(config, true);
  res.json({ livekit: toLiveKitPublicView(cfg) });
});

const livekitSchema = z.object({
  enabled: z.boolean().optional(),
  api_key: z.string().max(256).nullable().optional(),
  api_secret: z.string().max(512).nullable().optional(),
  rtc_url: z.string().url().nullable().optional(),
  ws_url: z.string().url().nullable().optional(),
  egress_enabled: z.boolean().optional(),
  egress_url: z.string().url().nullable().optional(),
  region: z.string().max(64).nullable().optional(),
  webhook_secret: z.string().max(512).nullable().optional(),
  recording_storage: z
    .object({
      vendor: z.enum(['s3', 's3_compatible']).nullable().optional(),
      bucket: z.string().max(256).nullable().optional(),
      region: z.string().max(64).nullable().optional(),
      endpoint: z.string().url().nullable().optional(),
      force_path_style: z.boolean().optional(),
      access_key: z.string().max(256).nullable().optional(),
      secret_key: z.string().max(512).nullable().optional(),
    })
    .partial()
    .optional(),
});

adminCallsRouter.put('/livekit', async (req, res) => {
  try {
    const body = livekitSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    // Strip absent secret fields so they remain preserved (presence-based).
    const patch: Record<string, unknown> = { ...body };
    if (!('api_key' in body)) delete patch.api_key;
    if (!('api_secret' in body)) delete patch.api_secret;
    if (!('webhook_secret' in body)) delete patch.webhook_secret;
    if (body.recording_storage) {
      const s: Record<string, unknown> = { ...body.recording_storage };
      if (!('access_key' in body.recording_storage)) delete s.access_key;
      if (!('secret_key' in body.recording_storage)) delete s.secret_key;
      patch.recording_storage = s;
    }
    const merged = await saveLiveKitConfig(config, patch as any);
    res.json({ livekit: toLiveKitPublicView(merged) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'update_failed' });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Phase 8C — Platform-default role permissions (workspace_id IS NULL).
// Reads return the full default matrix (4 roles × 8 perms). Writes upsert
// a single (role_slug, permission_key) row.
// ────────────────────────────────────────────────────────────────────────
const ROLES = ['owner', 'admin', 'agent', 'viewer'] as const;

adminCallsRouter.get('/role-permissions', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('role_permissions')
    .select('role_slug, permission_key, granted')
    .is('workspace_id', null);
  if (error) return res.status(500).json({ error: error.message });
  // Build a dense matrix so the UI never has to invent missing rows.
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const r of ROLES) {
    matrix[r] = {};
    for (const p of ALL_CALL_PERMISSIONS) matrix[r][p] = false;
  }
  for (const row of data ?? []) {
    if (matrix[row.role_slug] && (ALL_CALL_PERMISSIONS as string[]).includes(row.permission_key)) {
      matrix[row.role_slug][row.permission_key] = !!row.granted;
    }
  }
  res.json({ matrix, roles: ROLES, permissions: ALL_CALL_PERMISSIONS });
});

const rolePermPatchSchema = z.object({
  role_slug: z.enum(ROLES),
  permission_key: z.enum(ALL_CALL_PERMISSIONS as unknown as [string, ...string[]]),
  granted: z.boolean(),
});

adminCallsRouter.put('/role-permissions', async (req, res) => {
  try {
    const body = rolePermPatchSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    // Upsert by (workspace_id IS NULL, role_slug, permission_key). Because
    // the unique index uses COALESCE on workspace_id, we match the same
    // logic by deleting+inserting in one pass.
    const { error: delErr } = await sb
      .from('role_permissions')
      .delete()
      .is('workspace_id', null)
      .eq('role_slug', body.role_slug)
      .eq('permission_key', body.permission_key);
    if (delErr) return res.status(500).json({ error: delErr.message });
    const { error: insErr } = await sb.from('role_permissions').insert({
      workspace_id: null,
      role_slug: body.role_slug,
      permission_key: body.permission_key,
      granted: body.granted,
    });
    if (insErr) return res.status(500).json({ error: insErr.message });
    invalidatePermissionCache();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'update_failed' });
  }
});