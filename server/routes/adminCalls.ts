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
import { downloadFile, downloadFileRange } from '../services/storage/index.js';
import {
  mintPlaybackToken,
  type PlaybackDisposition,
} from '../services/calls/recordingPlaybackToken.js';
import {
  resolveEffectiveRecordingRetentionDays,
  computeRetentionExpiresAt,
} from '../services/recordings/recordingRetention.js';
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
import {
  probeLiveKitProvisioning,
  getLiveKitReadinessState,
  invalidateLiveKitReadinessCache,
} from '../services/calls/providers/livekitProvider.js';
import { CallProviderNotReadyError } from '../services/calls/providers/types.js';
import { CALL_PROVIDER_CLASSIFICATION } from '../services/calls/providers/types.js';
import { getPlatformCallbackCounts } from '../services/calls/callbacks.js';
import {
  getWidgetAssetName,
  getManifestDiagnostics,
} from '../services/widget/manifest.js';
import { resolveCallProvider } from '../services/calls/providerResolver.js';

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
  // Pass 1 — real LiveKit readiness backed by the live probe (cached 30s)
  // so the admin UI shows the truth, not just config presence.
  let livekitReadiness: Awaited<ReturnType<typeof getLiveKitReadinessState>> | null = null;
  try {
    livekitReadiness = await getLiveKitReadinessState(config);
    // Override the lightweight readiness flag with the real result so the
    // admin UI cannot show a green dot for an SFU that's actually down.
    readiness['livekit'] = livekitReadiness.ready;
  } catch { /* fail-open: keep config-based flag */ }
  res.json({
    control_plane: cp,
    network,
    readiness,
    livekit_readiness: livekitReadiness,
    classification: CALL_PROVIDER_CLASSIFICATION,
  });
});

/**
 * Phase 8D+ — Platform-wide callback analytics summary (last 30 days, all
 * workspaces). Used by Voice & Video Center → Callbacks tab summary cards.
 */
adminCallsRouter.get('/callbacks/summary', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const counts = await getPlatformCallbackCounts(config);
    const open = counts.requested + counts.scheduled + counts.in_progress;
    const total = open + counts.completed + counts.cancelled;
    const completion_rate = total > 0 ? counts.completed / total : 0;
    res.json({ counts, open, total, completion_rate });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'failed' });
  }
});

/**
 * Phase 8E — Upcoming scheduled callbacks across the platform.
 * Returns visitor-chosen scheduled callbacks (scheduled_for not null) that
 * are still open. Used by Voice & Video Center → Callbacks tab.
 */
adminCallsRouter.get('/callbacks/upcoming', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('callback_requests')
      .select('id, workspace_id, channel, status, contact_phone, contact_email, notes, scheduled_for, requested_at')
      .not('scheduled_for', 'is', null)
      .in('status', ['requested', 'scheduled', 'in_progress'])
      .gte('scheduled_for', new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(50);
    const items = data ?? [];
    const scheduled_count = items.length;
    res.json({ items, scheduled_count });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'failed' });
  }
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
    // Pass 1 — kill the cached real-readiness state so the next admin probe
    // reflects the freshly-saved credentials immediately.
    invalidateLiveKitReadinessCache();
    res.json({ livekit: toLiveKitPublicView(merged) });
  } catch (err: any) {
    // Surface zod issues so the UI can show the offending field.
    const detail = err?.issues
      ? err.issues.map((i: any) => `${(i.path || []).join('.')}: ${i.message}`).join('; ')
      : err?.message || 'update_failed';
    res.status(400).json({ error: detail });
  }
});

/**
 * LiveKit live provisioning probe — uses the currently saved config to create
 * and immediately delete a tiny disposable room. This verifies not just API
 * reachability, but also allocator/node availability (the same path the real
 * call flow depends on).
 */
adminCallsRouter.post('/livekit/test', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const cfg = await loadLiveKitConfig(config, true);
    if (!cfg.enabled) {
      return res.status(400).json({ ok: false, error: 'LiveKit is disabled. Enable it first.' });
    }
    if (!cfg.api_key || !cfg.api_secret) {
      return res
        .status(400)
        .json({ ok: false, error: 'API key and secret are required before testing.' });
    }
    if (!cfg.rtc_url) {
      return res.status(400).json({ ok: false, error: 'RTC URL is required before testing.' });
    }
    const probe = await probeLiveKitProvisioning(config);
    res.json({
      ok: true,
      latency_ms: probe.latencyMs,
      rtc_url: probe.rtcUrl,
      message: 'LiveKit created and deleted a probe room successfully.',
    });
  } catch (err: any) {
    const msg =
      err instanceof CallProviderNotReadyError
        ? err.message
        : err?.message || 'Unknown error contacting LiveKit.';
    res.status(502).json({ ok: false, error: msg });
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

// ─── Recording retention operability (read + legal-hold toggle) ─────
//
// Narrow operability surface for the LIVE recording_retention_days
// system (see docs/CALL_RECORDING_RETENTION.md). Mounted under
// /api/admin/calls/recordings — the existing super-admin auth on
// adminRouter applies. This surface is intentionally read-mostly:
//
//   • GET  /recordings                  → paginated list with computed
//                                         retention status badge.
//   • POST /recordings/:id/legal-hold   → toggles ONLY `legal_hold`.
//                                         Never deletes. Never touches
//                                         retention_expires_at. The
//                                         janitor remains the sole
//                                         deletion path.
//
// Legacy rows (retention_expires_at IS NULL) are labelled
// `legacy_unmanaged` and intentionally left alone — there is NO
// backfill action in this phase. Operators who want to manage them
// can still apply a legal hold; the janitor still ignores NULL.

function retentionStatus(row: any): 'on_hold' | 'expired' | 'expires_at' | 'legacy_unmanaged' {
  if (row?.legal_hold) return 'on_hold';
  if (!row?.retention_expires_at) return 'legacy_unmanaged';
  const exp = new Date(row.retention_expires_at).getTime();
  if (Number.isFinite(exp) && exp <= Date.now()) return 'expired';
  return 'expires_at';
}

adminCallsRouter.get('/recordings', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const Q = z.object({
    workspace_id: z.string().uuid().optional(),
    status: z.enum(['on_hold', 'expired', 'expires_at', 'legacy_unmanaged']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });
  const parsed = Q.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', detail: parsed.error.flatten().fieldErrors });
  const { workspace_id, status, limit, offset } = parsed.data;

  let q = sb
    .from('call_recordings')
    .select(
      'id, call_session_id, provider, recording_type, storage_provider, storage_path, duration_seconds, size_bytes, retention_policy, retention_expires_at, legal_hold, created_at, call_sessions!inner(workspace_id)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (workspace_id) {
    q = q.eq('call_sessions.workspace_id', workspace_id);
  }
  // Server-side status filters that map 1:1 to indexed columns. The
  // `expired` filter relies on the same partial index the janitor uses.
  if (status === 'on_hold') q = q.eq('legal_hold', true);
  if (status === 'legacy_unmanaged') q = q.is('retention_expires_at', null).eq('legal_hold', false);
  if (status === 'expires_at') q = q.not('retention_expires_at', 'is', null).eq('legal_hold', false).gt('retention_expires_at', new Date().toISOString());
  if (status === 'expired') q = q.not('retention_expires_at', 'is', null).eq('legal_hold', false).lte('retention_expires_at', new Date().toISOString());

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const items = (data || []).map((r: any) => ({
    id: r.id,
    call_session_id: r.call_session_id,
    workspace_id: r.call_sessions?.workspace_id ?? null,
    provider: r.provider,
    recording_type: r.recording_type,
    storage_provider: r.storage_provider,
    storage_path: r.storage_path,
    duration_seconds: r.duration_seconds,
    size_bytes: r.size_bytes,
    retention_policy: r.retention_policy,
    retention_expires_at: r.retention_expires_at,
    legal_hold: r.legal_hold,
    created_at: r.created_at,
    status: retentionStatus(r),
  }));
  res.json({ items, total: count ?? items.length, limit, offset });
});

const LegalHoldBody = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

// ─── Bulk legal-hold (super-admin operability) ─────────────────────
//
// Narrow bulk surface that ONLY mutates `legal_hold` on the supplied
// recording ids. It deliberately does not:
//   • delete anything (janitor remains the sole deletion path)
//   • touch retention_expires_at
//   • backfill legacy_unmanaged rows
//   • introduce any second hold mechanism
//
// Semantics:
//   • `enabled` is a SET operation, not a toggle. Sending true sets
//     legal_hold = true on every supplied id whose row exists; sending
//     false sets it to false. Mixed prior states are intentional —
//     bulk callers want a deterministic post-state, not a per-row flip.
//   • Missing ids are reported per-id in `failures`; the call still
//     returns 200 with `succeeded` listing the ids actually updated.
//   • One audit_log row is written per successfully-updated id, using
//     the same action keys as the per-row endpoint so existing audit
//     consumers don't need any change.
const BulkLegalHoldBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  enabled: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

adminCallsRouter.post('/recordings/legal-hold/bulk', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const parsed = BulkLegalHoldBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_body', detail: parsed.error.flatten().fieldErrors });
  }
  // De-dupe while preserving caller order.
  const ids = Array.from(new Set(parsed.data.ids));
  const { enabled, reason } = parsed.data;

  const { data: prior, error: priorErr } = await sb
    .from('call_recordings')
    .select('id, legal_hold, call_sessions!inner(workspace_id)')
    .in('id', ids);
  if (priorErr) return res.status(500).json({ error: priorErr.message });

  const priorById = new Map<string, any>((prior || []).map((r: any) => [r.id, r]));
  const presentIds = ids.filter((id) => priorById.has(id));
  const missingIds = ids.filter((id) => !priorById.has(id));

  const succeeded: string[] = [];
  const failures: Array<{ id: string; error: string }> = missingIds.map((id) => ({
    id,
    error: 'not_found',
  }));

  if (presentIds.length > 0) {
    const { data: updated, error: updErr } = await sb
      .from('call_recordings')
      .update({ legal_hold: enabled })
      .in('id', presentIds)
      .select('id');
    if (updErr) {
      // Treat the bulk as fully failed for the present subset rather
      // than partially-applying an unknown subset.
      for (const id of presentIds) failures.push({ id, error: updErr.message });
    } else {
      const updatedIds = new Set((updated || []).map((r: any) => r.id));
      for (const id of presentIds) {
        if (updatedIds.has(id)) succeeded.push(id);
        else failures.push({ id, error: 'update_skipped' });
      }
      // Best-effort audit log — same action key as per-row endpoint.
      const action = enabled
        ? 'call_recording.legal_hold.enable'
        : 'call_recording.legal_hold.disable';
      const adminId = (req as any).adminUser?.id ?? null;
      const rows = succeeded.map((id) => {
        const p = priorById.get(id);
        const wsId =
          p?.call_sessions?.workspace_id ?? '00000000-0000-0000-0000-000000000000';
        return {
          action,
          entity_type: 'call_recording',
          entity_id: id,
          user_id: adminId,
          workspace_id: wsId,
          old_value: { legal_hold: !!p?.legal_hold } as any,
          new_value: { legal_hold: enabled, reason: reason ?? null, bulk: true } as any,
        };
      });
      if (rows.length > 0) {
        await sb.from('audit_logs').insert(rows as any).then(() => {}, () => {});
      }
    }
  }

  res.json({
    requested: ids.length,
    succeeded,
    failures,
    enabled,
  });
});

adminCallsRouter.post('/recordings/:id/legal-hold', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const parsed = LegalHoldBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten().fieldErrors });

  // Confirm the row exists + grab workspace for the audit log. Using a
  // separate select avoids relying on .update().select() for join data.
  const { data: prior, error: priorErr } = await sb
    .from('call_recordings')
    .select('id, legal_hold, call_sessions!inner(workspace_id)')
    .eq('id', id)
    .maybeSingle();
  if (priorErr) return res.status(500).json({ error: priorErr.message });
  if (!prior) return res.status(404).json({ error: 'not_found' });

  // Toggle ONLY `legal_hold`. retention_expires_at is never touched
  // here — this surface cannot delete or shorten retention.
  const { error: updErr } = await sb
    .from('call_recordings')
    .update({ legal_hold: parsed.data.enabled })
    .eq('id', id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  const wsId = (prior as any)?.call_sessions?.workspace_id ?? '00000000-0000-0000-0000-000000000000';
  await sb.from('audit_logs').insert({
    action: parsed.data.enabled ? 'call_recording.legal_hold.enable' : 'call_recording.legal_hold.disable',
    entity_type: 'call_recording',
    entity_id: id,
    user_id: (req as any).adminUser?.id ?? null,
    workspace_id: wsId,
    old_value: { legal_hold: !!(prior as any).legal_hold } as any,
    new_value: { legal_hold: parsed.data.enabled, reason: parsed.data.reason ?? null } as any,
  } as any).then(() => {}, () => {});

  res.json({ id, legal_hold: parsed.data.enabled });
});

// ─── Recording artifact access (super-admin, READ-ONLY) ────────────
//
// Narrow operability surface so super admins can play back or download
// the underlying recording file from the existing Recordings tab without
// exposing provider URLs/credentials or adding any deletion/mutation
// path. Bytes are streamed through the canonical storage abstraction
// (downloadFile → resolveStorageConfig), the same helper the widget
// attachment proxy uses. The retention janitor remains the sole
// deletion path; this route never writes to call_recordings or storage.
//
//   GET /api/admin/calls/recordings/:id/file?disposition=inline|attachment
//
//   • 404 not_found            — no such recording row
//   • 410 missing_storage_path — row exists but has no stored artifact
//   • 404 storage_object_missing — provider could not locate the object
//   • 502 provider_download_failed — generic provider read failure
//   • 200 stream                — raw bytes with derived Content-Type
function guessContentType(row: any): string {
  const path = String(row?.storage_path || '').toLowerCase();
  const ext = path.includes('.') ? path.split('.').pop() || '' : '';
  const byExt: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    opus: 'audio/ogg',
  };
  if (ext && byExt[ext]) return byExt[ext];
  if (row?.recording_type === 'audio_only') return 'audio/mp4';
  if (row?.recording_type === 'composite' || row?.recording_type === 'individual') return 'video/mp4';
  return 'application/octet-stream';
}

function downloadFileName(row: any, ct: string): string {
  const ts = row?.created_at ? new Date(row.created_at).toISOString().replace(/[:.]/g, '-') : 'recording';
  const extFromCt: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
  };
  const ext = extFromCt[ct] || 'bin';
  return `call-recording-${String(row?.id || 'unknown').slice(0, 12)}-${ts}.${ext}`;
}

adminCallsRouter.get('/recordings/:id/file', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });

  const { data: row, error } = await sb
    .from('call_recordings')
    .select('id, storage_path, recording_type, created_at, call_sessions!inner(workspace_id)')
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: 'not_found' });

  const storagePath = (row as any).storage_path as string | null;
  const workspaceId = (row as any)?.call_sessions?.workspace_id as string | undefined;
  if (!storagePath) return res.status(410).json({ error: 'missing_storage_path' });
  if (!workspaceId) return res.status(409).json({ error: 'orphan_session' });

  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const dl = await downloadFileRange(config, workspaceId, storagePath, rangeHeader);
  if (!dl.success || !dl.data) {
    if (dl.status === 416) {
      if (dl.totalSize != null) res.setHeader('Content-Range', `bytes */${dl.totalSize}`);
      return res.status(416).json({ error: 'range_not_satisfiable' });
    }
    const msg = String(dl.error || '').toLowerCase();
    if (dl.status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('no such')) {
      return res.status(404).json({ error: 'storage_object_missing' });
    }
    return res.status(502).json({ error: 'provider_download_failed', detail: dl.error || null });
  }

  const ct = guessContentType(row);
  const wantAttachment = String(req.query.disposition || '').toLowerCase() === 'attachment';
  const fname = downloadFileName(row, ct);

  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `${wantAttachment ? 'attachment' : 'inline'}; filename="${fname.replace(/"/g, '')}"`,
  );
  if (dl.contentLength != null) res.setHeader('Content-Length', String(dl.contentLength));
  // Honor partial-content semantics when the provider acknowledged the range.
  // If the client sent Range but the provider returned full 200, fall through
  // to a normal 200 response so playback still works (read-only fallback).
  if (rangeHeader && dl.status === 206) {
    if (dl.contentRange) res.setHeader('Content-Range', dl.contentRange);
    res.status(206);
  }
  return res.send(dl.data);
});

// ─────────────────────────────────────────────────────────────────────────
// Tokenized native playback (read-only).
//
//   POST /api/admin/calls/recordings/:id/playback-token
//
// Mints a short-lived HMAC token (default 5 min, hard cap 15 min) the admin
// UI can hand to a native <audio>/<video> element as part of a tokenized
// URL on the public streaming route. Bearer-protected super-admin auth is
// still required to MINT — the token itself is just a stateless time-boxed
// grant for the recording id + disposition it was minted with. The token
// never carries provider URLs or credentials; the streaming route still
// fetches bytes through the same canonical storage abstraction.
//
// Retention/legal-hold semantics are unaffected: this surface never writes
// to call_recordings or storage, and the janitor remains the sole deletion
// path.
// ─────────────────────────────────────────────────────────────────────────
adminCallsRouter.post('/recordings/:id/playback-token', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });

  const dispositionRaw = String(
    (req.body && req.body.disposition) || req.query.disposition || 'inline',
  ).toLowerCase();
  const disposition: PlaybackDisposition =
    dispositionRaw === 'attachment' ? 'attachment' : 'inline';

  // Confirm the recording exists before minting so the operator gets a
  // clean 404 here instead of on first Range request.
  const sb = getServiceClient(config);
  const { data: row, error } = await sb
    .from('call_recordings')
    .select('id, storage_path')
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (!(row as any).storage_path) return res.status(410).json({ error: 'missing_storage_path' });

  const minted = mintPlaybackToken(config, { recordingId: id, disposition });
  // Build a path the browser can use directly as <audio src>/<video src>.
  // The route is mounted at /api/calls/recording-playback/:id in server/index.ts.
  const url =
    `/api/calls/recording-playback/${encodeURIComponent(id)}` +
    `?token=${encodeURIComponent(minted.token)}` +
    `&disposition=${minted.disposition}`;
  res.json({
    recording_id: id,
    url,
    token: minted.token,
    disposition: minted.disposition,
    expires_at: minted.expires_at,
    ttl_seconds: minted.ttl_seconds,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Per-recording retention OVERRIDE (super-admin, narrow single-row pass).
//
//   POST /api/admin/calls/recordings/:id/retention-override
//
// Body (one of):
//   { mode: 'exact',         expires_at: <ISO timestamp>,  reason?: string }
//   { mode: 'days_from_now', days:       <integer >= 0>,   reason?: string }
//   { mode: 'unlimited',                                    reason?: string }
//
// Semantics — strict and intentionally minimal:
//   • Mutates ONLY `retention_expires_at` and `retention_policy` on the
//     supplied row. Never touches `legal_hold`. Never deletes.
//   • `mode: 'unlimited'` sets `retention_expires_at = NULL`, matching the
//     existing "never expires" semantics the janitor already understands.
//     `retention_policy` is stamped as `override:unlimited` so the prior
//     plan-derived value (e.g. `30d`) is no longer misleading.
//   • `mode: 'exact' | 'days_from_now'` writes an explicit future or past
//     ISO and stamps `retention_policy = override:exact` / `override:Nd`.
//     The override may shorten OR extend retention; super-admin scope is
//     the only gate.
//   • Legal hold still wins. The janitor query already skips
//     `legal_hold = true` rows, so an expired override on a held row will
//     not delete anything until the hold is released — exactly as today.
//   • Legacy/unmanaged rows (NULL expiry) gain an expiry ONLY through this
//     explicit per-row action. There is no implicit backfill.
//   • Clearing an override is intentionally NOT supported in this pass:
//     the original plan-stamp is not preserved separately, so a silent
//     "restore to inherited" would have to recompute from the workspace's
//     CURRENT plan and could surprise operators. Operators set a new
//     explicit value instead.
//
// The janitor is still the sole deletion path; this route reuses the same
// fields it already reads and introduces no second retention engine.
const RetentionOverrideBody = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('exact'),
    expires_at: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    mode: z.literal('days_from_now'),
    days: z.number().int().min(0).max(3650),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    mode: z.literal('unlimited'),
    reason: z.string().trim().max(500).optional(),
  }),
]);

adminCallsRouter.post('/recordings/:id/retention-override', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const parsed = RetentionOverrideBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_body', detail: parsed.error.flatten().fieldErrors });
  }

  const { data: prior, error: priorErr } = await sb
    .from('call_recordings')
    .select(
      'id, retention_policy, retention_expires_at, legal_hold, call_sessions!inner(workspace_id)',
    )
    .eq('id', id)
    .maybeSingle();
  if (priorErr) return res.status(500).json({ error: priorErr.message });
  if (!prior) return res.status(404).json({ error: 'not_found' });

  let nextExpiresAt: string | null;
  let nextPolicy: string;
  if (parsed.data.mode === 'unlimited') {
    nextExpiresAt = null;
    nextPolicy = 'override:unlimited';
  } else if (parsed.data.mode === 'exact') {
    nextExpiresAt = new Date(parsed.data.expires_at).toISOString();
    nextPolicy = 'override:exact';
  } else {
    // days_from_now — compute relative to NOW so operators can extend a
    // hold from "this moment" without doing arithmetic in their head.
    const ms = parsed.data.days * 24 * 60 * 60 * 1000;
    nextExpiresAt = new Date(Date.now() + ms).toISOString();
    nextPolicy = `override:${parsed.data.days}d`;
  }

  const { error: updErr } = await sb
    .from('call_recordings')
    .update({
      retention_expires_at: nextExpiresAt,
      retention_policy: nextPolicy,
    })
    .eq('id', id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  const wsId =
    (prior as any)?.call_sessions?.workspace_id ?? '00000000-0000-0000-0000-000000000000';
  await sb
    .from('audit_logs')
    .insert({
      action: 'call_recording.retention.override',
      entity_type: 'call_recording',
      entity_id: id,
      user_id: (req as any).adminUser?.id ?? null,
      workspace_id: wsId,
      old_value: {
        retention_policy: (prior as any).retention_policy ?? null,
        retention_expires_at: (prior as any).retention_expires_at ?? null,
      } as any,
      new_value: {
        mode: parsed.data.mode,
        retention_policy: nextPolicy,
        retention_expires_at: nextExpiresAt,
        reason: parsed.data.reason ?? null,
      } as any,
    } as any)
    .then(
      () => {},
      () => {},
    );

  res.json({
    id,
    retention_policy: nextPolicy,
    retention_expires_at: nextExpiresAt,
    legal_hold: !!(prior as any).legal_hold,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Per-recording retention RESTORE-TO-INHERITED (super-admin, single row).
//
//   POST /api/admin/calls/recordings/:id/retention-restore
//   Body: { reason?: string }
//
// Restore policy (locked):
//   • Eligible ONLY for rows whose current `retention_policy` starts with
//     `override:`. Already-inherited rows (`Nd` / `unlimited`) and legacy
//     unmanaged rows (NULL policy) return 409 — restoring those would
//     either be a no-op pretending to do work or an implicit legacy
//     backfill, both of which this pass forbids.
//   • "Inherited" is defined as: the SAME computation `stampRetention`
//     would perform today for this row's workspace, anchored at the row's
//     own `created_at`. That is the only inherited value the retention
//     model can express — the original creation-time stamp is not
//     preserved separately. The recomputation is explicit and operator-
//     triggered, never silent.
//   • Writes `retention_policy = '<N>d' | 'unlimited'` and
//     `retention_expires_at = created_at + Nd` (NULL for unlimited),
//     matching the live janitor contract exactly.
//   • `legal_hold` is never touched and still wins over expiry.
//   • The janitor remains the sole deletion path.
//   • This route never operates on more than the one row addressed.
const RetentionRestoreBody = z.object({
  reason: z.string().trim().max(500).optional(),
});

adminCallsRouter.post('/recordings/:id/retention-restore', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const parsed = RetentionRestoreBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_body', detail: parsed.error.flatten().fieldErrors });
  }

  const { data: prior, error: priorErr } = await sb
    .from('call_recordings')
    .select(
      'id, retention_policy, retention_expires_at, legal_hold, created_at, call_sessions!inner(workspace_id)',
    )
    .eq('id', id)
    .maybeSingle();
  if (priorErr) return res.status(500).json({ error: priorErr.message });
  if (!prior) return res.status(404).json({ error: 'not_found' });

  const currentPolicy: string | null = (prior as any).retention_policy ?? null;
  if (!currentPolicy || !currentPolicy.startsWith('override:')) {
    return res.status(409).json({
      error: 'not_overridden',
      detail:
        'Only rows currently marked override:* can be restored to inherited retention. ' +
        'Legacy/unmanaged and already-inherited rows are intentionally not touched.',
    });
  }

  const wsId = (prior as any)?.call_sessions?.workspace_id as string | undefined;
  const createdAt = (prior as any)?.created_at as string | undefined;
  if (!wsId || !createdAt) {
    return res.status(500).json({ error: 'row_missing_anchor_fields' });
  }

  const eff = await resolveEffectiveRecordingRetentionDays(config, wsId);
  const nextPolicy = eff.days < 0 ? 'unlimited' : `${eff.days}d`;
  const nextExpiresAt = computeRetentionExpiresAt(createdAt, eff.days);

  const { error: updErr } = await sb
    .from('call_recordings')
    .update({
      retention_expires_at: nextExpiresAt,
      retention_policy: nextPolicy,
    })
    .eq('id', id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  await sb
    .from('audit_logs')
    .insert({
      action: 'call_recording.retention.restore',
      entity_type: 'call_recording',
      entity_id: id,
      user_id: (req as any).adminUser?.id ?? null,
      workspace_id: wsId,
      old_value: {
        retention_policy: currentPolicy,
        retention_expires_at: (prior as any).retention_expires_at ?? null,
      } as any,
      new_value: {
        retention_policy: nextPolicy,
        retention_expires_at: nextExpiresAt,
        inherited_source: eff.source,
        inherited_days: eff.days,
        reason: parsed.data.reason ?? null,
      } as any,
    } as any)
    .then(() => {}, () => {});

  res.json({
    id,
    retention_policy: nextPolicy,
    retention_expires_at: nextExpiresAt,
    legal_hold: !!(prior as any).legal_hold,
    inherited_source: eff.source,
    inherited_days: eff.days,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Per-recording LEGACY ADOPTION (super-admin, single row).
//
//   POST /api/admin/calls/recordings/:id/retention-adopt
//   Body: { reason?: string }
//
// Adoption policy (locked, intentionally narrow):
//   • Eligible ONLY for rows that are currently legacy/unmanaged, defined
//     as `retention_expires_at IS NULL` AND `retention_policy IS NULL`.
//     Already-managed rows (any non-null policy, including `unlimited`
//     and `override:*`) return 409. There is no implicit backfill, no
//     bulk adoption, and no scheduled adoption — every adopted row is
//     the result of one explicit super-admin click.
//   • "Adopted" means the SAME computation `stampRetention` / the
//     restore-to-inherited route would perform today for this row's
//     workspace, anchored at the row's own `created_at`. Reuses the
//     single canonical helper (`resolveEffectiveRecordingRetentionDays`
//     + `computeRetentionExpiresAt`) — no second retention engine.
//   • Writes `retention_policy = '<N>d' | 'unlimited'` and
//     `retention_expires_at = created_at + Nd` (NULL for unlimited),
//     matching the live janitor contract exactly.
//   • `legal_hold` is never touched and still wins over expiry.
//   • If the recomputed expiry already lies in the past, the row simply
//     becomes janitor-eligible on the next sweep — adoption itself
//     never deletes. The janitor remains the sole deletion path.
const RetentionAdoptBody = z.object({
  reason: z.string().trim().max(500).optional(),
});

adminCallsRouter.post('/recordings/:id/retention-adopt', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const parsed = RetentionAdoptBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_body', detail: parsed.error.flatten().fieldErrors });
  }

  const { data: prior, error: priorErr } = await sb
    .from('call_recordings')
    .select(
      'id, retention_policy, retention_expires_at, legal_hold, created_at, call_sessions!inner(workspace_id)',
    )
    .eq('id', id)
    .maybeSingle();
  if (priorErr) return res.status(500).json({ error: priorErr.message });
  if (!prior) return res.status(404).json({ error: 'not_found' });

  const currentPolicy: string | null = (prior as any).retention_policy ?? null;
  const currentExpiry: string | null = (prior as any).retention_expires_at ?? null;
  if (currentPolicy !== null || currentExpiry !== null) {
    return res.status(409).json({
      error: 'not_legacy',
      detail:
        'Only legacy/unmanaged rows (retention_expires_at IS NULL and ' +
        'retention_policy IS NULL) can be adopted. Use retention-override ' +
        'or retention-restore for already-managed rows.',
    });
  }

  const wsId = (prior as any)?.call_sessions?.workspace_id as string | undefined;
  const createdAt = (prior as any)?.created_at as string | undefined;
  if (!wsId || !createdAt) {
    return res.status(500).json({ error: 'row_missing_anchor_fields' });
  }

  const eff = await resolveEffectiveRecordingRetentionDays(config, wsId);
  const nextPolicy = eff.days < 0 ? 'unlimited' : `${eff.days}d`;
  const nextExpiresAt = computeRetentionExpiresAt(createdAt, eff.days);

  const { error: updErr } = await sb
    .from('call_recordings')
    .update({
      retention_expires_at: nextExpiresAt,
      retention_policy: nextPolicy,
    })
    .eq('id', id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  await sb
    .from('audit_logs')
    .insert({
      action: 'call_recording.retention.adopt',
      entity_type: 'call_recording',
      entity_id: id,
      user_id: (req as any).adminUser?.id ?? null,
      workspace_id: wsId,
      old_value: {
        retention_policy: null,
        retention_expires_at: null,
      } as any,
      new_value: {
        retention_policy: nextPolicy,
        retention_expires_at: nextExpiresAt,
        inherited_source: eff.source,
        inherited_days: eff.days,
        reason: parsed.data.reason ?? null,
      } as any,
    } as any)
    .then(() => {}, () => {});

  res.json({
    id,
    retention_policy: nextPolicy,
    retention_expires_at: nextExpiresAt,
    legal_hold: !!(prior as any).legal_hold,
    inherited_source: eff.source,
    inherited_days: eff.days,
    already_expired: nextExpiresAt !== null && new Date(nextExpiresAt).getTime() <= Date.now(),
  });
});