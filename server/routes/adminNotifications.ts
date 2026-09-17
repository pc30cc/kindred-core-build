/**
 * SUPER ADMIN → NOTIFICATIONS.
 *
 * Mounted under adminRouter, so `/api/admin/*` is already gated by
 * `requirePlatformAdmin` before any handler here runs.
 *
 * Scope boundary that shapes this whole file: the FCM service account lives
 * in the server environment and is NEVER readable or writable from here. The
 * transport-status endpoint reports whether credentials are present and which
 * Firebase project they point at — nothing more. Everything an admin can edit
 * is POLICY (defaults, APNs semantics, categories, copy), which is why it can
 * safely live in a database row.
 *
 * The test send deliberately targets ONLY the calling admin's own registered
 * devices. An endpoint that could push arbitrary copy to another operator's
 * phone would be a broadcast weapon, not a diagnostic.
 */
import { Router } from 'express';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { getFcmCredentials, isPushConfigured, sendFcmMessage } from '../services/push/fcm.js';
import { listActiveDevices } from '../services/push/devices.js';
import {
  loadPushPlatformSettings,
  invalidatePushPlatformSettingsCache,
  normalizePushSettings,
  renderTemplate,
  PUSH_PLATFORM_DEFAULTS,
} from '../services/push/platformSettings.js';

export const adminNotificationsRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

const HHMM = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const actionSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[A-Z0-9_]+$/),
  titles: z.record(z.string().trim().max(60)),
  foreground: z.boolean(),
  destructive: z.boolean(),
  textInput: z.boolean(),
});

const categorySchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[A-Z0-9_]+$/),
  eventTypes: z.array(z.enum(['new_message', 'internal_note', 'mention'])).min(1),
  // iOS shows at most four actions on an expanded banner.
  actions: z.array(actionSchema).max(4),
});

const templateSchema = z.object({
  title: z.record(z.string().max(120)),
  body: z.record(z.string().max(300)),
  privateTitle: z.record(z.string().max(120)).optional(),
  privateBody: z.record(z.string().max(300)).optional(),
});

const settingsSchema = z.object({
  push_enabled: z.boolean().optional(),

  default_scope: z.enum(['all', 'assigned', 'mentions', 'none']).optional(),
  default_preview: z.boolean().optional(),
  default_internal_notes: z.boolean().optional(),
  default_sound: z.boolean().optional(),
  default_quiet_hours_enabled: z.boolean().optional(),
  default_quiet_hours_start: HHMM.optional(),
  default_quiet_hours_end: HHMM.optional(),
  default_quiet_hours_timezone: z.string().trim().max(100).nullable().optional(),
  mention_bypasses_quiet_hours: z.boolean().optional(),

  apns_priority: z.union([z.literal(1), z.literal(5), z.literal(10)]).optional(),
  apns_ttl_seconds: z.coerce.number().int().min(0).max(2_419_200).optional(),
  interruption_level: z.enum(['passive', 'active', 'time-sensitive', 'critical']).optional(),
  relevance_score: z.coerce.number().min(0).max(1).optional(),
  mutable_content: z.boolean().optional(),
  thread_id_strategy: z.enum(['conversation', 'workspace', 'none']).optional(),
  collapse_enabled: z.boolean().optional(),
  badge_enabled: z.boolean().optional(),
  sound_name: z.string().trim().min(1).max(60).optional(),
  critical_alerts_enabled: z.boolean().optional(),
  critical_alert_volume: z.coerce.number().min(0).max(1).optional(),
  provisional_authorization: z.boolean().optional(),
  android_channel_id: z.string().trim().min(1).max(60).optional(),

  throttle_per_user_per_minute: z.coerce.number().int().min(1).max(600).optional(),
  dispatch_log_retention_days: z.coerce.number().int().min(1).max(365).optional(),

  categories: z.array(categorySchema).max(10).optional(),
  templates: z.record(templateSchema).optional(),
});

async function readRow(config: ServerConfig) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('push_platform_settings')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown> | null;
}

/**
 * Transport health. `projectId` is the only credential-derived value exposed
 * — it is a public Firebase identifier, not a secret, and without it an
 * operator cannot tell a misconfigured project from a missing one.
 */
function transportStatus() {
  const creds = getFcmCredentials();
  return {
    configured: isPushConfigured(),
    projectId: creds?.projectId ?? null,
    // The service-account address confirms WHICH credential is loaded without
    // revealing anything usable: the private key stays in the environment.
    clientEmailMasked: creds?.clientEmail ? maskEmail(creds.clientEmail) : null,
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 3);
  return `${head}${'*'.repeat(Math.max(3, local.length - 3))}@${domain}`;
}

adminNotificationsRouter.get('/settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const row = await readRow(serverConfigOf(req));
    const settings = row ? normalizePushSettings(row) : { ...PUSH_PLATFORM_DEFAULTS };
    return res.json({ settings, transport: transportStatus(), provisioned: Boolean(row) });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminNotificationsRouter.put('/settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Invalid input', issues: parsed.error.issues.map((i) => i.path.join('.')) });
  }
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const payload = { ...parsed.data, updated_at: new Date().toISOString() };
  try {
    const existing = await readRow(config);
    const query = existing
      ? sb.from('push_platform_settings').update(payload).eq('id', existing.id as string).select('*').single()
      : sb.from('push_platform_settings').insert(payload).select('*').single();
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    // Dispatch memoizes the policy for 30s — drop it so the next notification
    // already uses what was just saved.
    invalidatePushPlatformSettingsCache();
    return res.json({ success: true, settings: normalizePushSettings(data as Record<string, unknown>) });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/** Device fleet: how many phones can actually receive a notification. */
adminNotificationsRouter.get('/devices', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(serverConfigOf(req));
  try {
    const { data, error } = await sb
      .from('mobile_push_devices')
      .select('platform, enabled, permission_status, app_version, last_seen_at, disabled_reason')
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });
    const rows = (data ?? []) as {
      platform: string;
      enabled: boolean;
      permission_status: string | null;
      app_version: string | null;
      last_seen_at: string;
      disabled_reason: string | null;
    }[];
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const byVersion: Record<string, number> = {};
    for (const row of rows) {
      if (!row.enabled) continue;
      const version = row.app_version ?? 'unknown';
      byVersion[version] = (byVersion[version] ?? 0) + 1;
    }
    return res.json({
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      ios: rows.filter((r) => r.enabled && r.platform === 'ios').length,
      android: rows.filter((r) => r.enabled && r.platform === 'android').length,
      denied: rows.filter((r) => r.permission_status === 'denied').length,
      activeLast7d: rows.filter((r) => r.enabled && Date.parse(r.last_seen_at) >= weekAgo).length,
      byVersion,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

const logQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['all', 'sent', 'failed', 'attempted']).default('all'),
});

/** Delivery diagnostics — the last N dispatches with their outcome. */
adminNotificationsRouter.get('/log', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = logQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid query' });
  const sb = getServiceClient(serverConfigOf(req));
  try {
    let query = sb
      .from('push_dispatch_log')
      .select(
        'id, workspace_id, user_id, conversation_id, notification_type, status, device_count, accepted_count, failed_count, error, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(parsed.data.limit);
    if (parsed.data.status !== 'all') query = query.eq('status', parsed.data.status);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data ?? []) as Record<string, unknown>[];
    const totals = rows.reduce<{ devices: number; accepted: number; failed: number }>(
      (acc, row) => ({
        devices: acc.devices + Number(row.device_count ?? 0),
        accepted: acc.accepted + Number(row.accepted_count ?? 0),
        failed: acc.failed + Number(row.failed_count ?? 0),
      }),
      { devices: 0, accepted: 0, failed: 0 },
    );
    return res.json({ entries: rows, totals });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

const testLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
});

const testSchema = z.object({
  event_type: z.enum(['new_message', 'internal_note', 'mention']).default('new_message'),
  locale: z.string().trim().min(2).max(10).default('en'),
  preview: z.boolean().default(true),
});

/**
 * Sends one real notification through the real transport to the calling
 * admin's OWN devices, rendered with the saved templates. This is the only
 * way to prove the whole chain (credentials → APNs → device) end to end;
 * "configured" says nothing about whether a phone actually rings.
 */
adminNotificationsRouter.post('/test', testLimiter, async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  if (!isPushConfigured()) return res.status(409).json({ error: 'push_not_configured' });

  const config = serverConfigOf(req);
  try {
    const policy = await loadPushPlatformSettings(config);
    const devices = await listActiveDevices(config, [actorId]);
    if (!devices.length) return res.status(409).json({ error: 'no_devices' });

    const { title, body } = renderTemplate(
      policy,
      parsed.data.event_type,
      parsed.data.locale,
      parsed.data.preview,
      { sender: 'Webyar', preview: 'Test notification', count: '0' },
    );

    let accepted = 0;
    const failures: { platform: string; status?: number; error?: string }[] = [];
    for (const device of devices) {
      const outcome = await sendFcmMessage({
        token: device.push_token,
        title: title || 'Webyar',
        body: body || 'Test notification',
        // `type: test` lets the app recognise a diagnostic and skip routing.
        data: { type: 'test' },
        sound: policy.default_sound,
        androidChannelId: policy.android_channel_id,
        apns: {
          priority: policy.apns_priority,
          ttlSeconds: policy.apns_ttl_seconds,
          interruptionLevel: policy.interruption_level,
          relevanceScore: policy.relevance_score,
          soundName: policy.sound_name,
          mutableContent: policy.mutable_content,
        },
      });
      if (outcome.ok) accepted += 1;
      else failures.push({ platform: device.platform, status: outcome.status, error: outcome.error });
    }
    return res.json({ success: accepted > 0, devices: devices.length, accepted, failures });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
