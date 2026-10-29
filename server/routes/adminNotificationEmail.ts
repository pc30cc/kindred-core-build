/**
 * SUPER ADMIN → NOTIFICATIONS → EMAIL.
 *
 * Mounted under `adminRouter`, so `requirePlatformAdmin` has already run.
 *
 * What an admin owns here: which operator notification emails exist at all,
 * which provider carries them, when the two scheduled ones go out, and the
 * announcement. What they do not own is any operator's own answer — each
 * type they enable is still a switch the operator can turn off, and that is
 * deliberate: a platform that can mail every operator whatever it likes is
 * not a notification setting, it is a megaphone.
 *
 * The provider is a choice between the platform default and the separate
 * notification provider (`app_runtime_config.notification_email_provider`,
 * saved through the email provider config store from Super Admin →
 * Providers → Email). The dispatcher uses it only when its provider is the
 * one chosen here and it can send; else the default carries these, and this
 * page says so.
 */
import { Router } from 'express';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  invalidateNotificationEmailSettingsCache,
  loadNotificationEmailSettings,
  normalizeNotificationEmailSettings,
  SETTINGS_COLUMNS,
} from '../services/notificationEmail/settings.js';
import { OVERRIDE_PROVIDER_KEY } from '../services/notificationEmail/dispatcher.js';
import { ANNOUNCEMENTS_PER_HOUR } from '../services/notificationEmail/producers.js';
import { NOTIFICATION_EMAILS, NOTIFICATION_EMAIL_TYPES } from '../services/notificationEmail/types.js';
import { readEmailProviderConfig } from '../services/email/providerConfigStore.js';
import { emailProviderReadiness } from '../services/email/providers/index.js';
import { EMAIL_PROVIDER_ADAPTERS } from '../../shared/emailProviders.js';

export const adminNotificationEmailRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

function actorId(req: Request): string | null {
  const auth = (req as unknown as { authUser?: { id?: string }; userId?: string });
  return auth.authUser?.id ?? auth.userId ?? null;
}

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  unread_messages_enabled: z.boolean().optional(),
  transcripts_enabled: z.boolean().optional(),
  paid_invoices_enabled: z.boolean().optional(),
  weekly_summary_enabled: z.boolean().optional(),
  product_updates_enabled: z.boolean().optional(),
  // Null is "use the platform default", which is a real choice and not a
  // missing value. A name is a provider this server has an adapter for.
  provider_override: z.enum(EMAIL_PROVIDER_ADAPTERS).nullable().optional(),
  unread_after_minutes: z.number().int().min(5).max(1440).optional(),
  digest_every_minutes: z.number().int().min(15).max(1440).optional(),
  weekly_summary_dow: z.number().int().min(0).max(6).optional(),
  weekly_summary_hour: z.number().int().min(0).max(23).optional(),
});

/** relation or column missing: a database before migration 289c. */
function before289c(error: { code?: string } | null | undefined): boolean {
  return ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(String(error?.code ?? ''));
}

// GET /api/admin/notification-email
adminNotificationEmailRouter.get('/', async (req, res) => {
  try {
    const config = serverConfigOf(req);
    const settings = await loadNotificationEmailSettings(config);

    // The separate provider as the store reads it (secrets decrypted here,
    // never sent): its name, and whether it can send. An admin who picks a
    // provider and never sets it up would otherwise see a chosen provider and
    // wonder why the mail still goes out the default one.
    const stored = await readEmailProviderConfig(config, OVERRIDE_PROVIDER_KEY).catch(() => null);
    const notificationProvider = {
      provider_name: stored?.provider_name ?? null,
      configured: emailProviderReadiness(stored) === 'configured',
    };

    const { data: announcements, error: announcementsError } = await getServiceClient(config)
      .from('notification_email_announcements')
      .select('id, title, status, recipients_queued, created_at, finished_at')
      .order('created_at', { ascending: false })
      .limit(5);

    return res.json({
      settings,
      providers: EMAIL_PROVIDER_ADAPTERS,
      notification_provider: notificationProvider,
      // The choice made here really carries the mail: the stored provider is
      // the one chosen, and it can send.
      provider_configured: Boolean(
        settings.provider_override
        && notificationProvider.configured
        && notificationProvider.provider_name === settings.provider_override,
      ),
      announcements: announcementsError ? [] : announcements ?? [],
      announcements_per_hour: ANNOUNCEMENTS_PER_HOUR,
      // The catalogue, so the console never hardcodes a list that can drift
      // from the one the server enforces.
      types: NOTIFICATION_EMAIL_TYPES.map((type) => ({
        type,
        slug: NOTIFICATION_EMAILS[type].slug,
        audience: NOTIFICATION_EMAILS[type].audience,
      })),
    });
  } catch (err: unknown) {
    console.error('[notification-email] settings read failed', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PATCH /api/admin/notification-email
adminNotificationEmailRouter.patch('/', async (req, res) => {
  try {
    const config = serverConfigOf(req);
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }
    if (!Object.keys(parsed.data).length) {
      return res.status(400).json({ error: 'Nothing to change' });
    }

    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('notification_email_settings')
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString(),
        updated_by: actorId(req),
      })
      .eq('id', true)
      .select(SETTINGS_COLUMNS)
      .maybeSingle();
    if (error) {
      console.error('[notification-email] settings write failed', { message: error.message });
      return res.status(500).json({ error: 'Failed to update settings' });
    }

    invalidateNotificationEmailSettingsCache();
    return res.json({ settings: normalizeNotificationEmailSettings(data) });
  } catch (err: unknown) {
    console.error('[notification-email] settings write failed', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * The announcement.
 *
 * Rate limited hard, because it is the one endpoint here that reaches every
 * operator on the platform. The request only writes the announcement down:
 * the notification ticker queues it to the operators a page at a time, at
 * most ANNOUNCEMENTS_PER_HOUR an hour (producers.ts, fanOutAnnouncements),
 * bounded by the platform switch AND by each operator's own preference,
 * like everything else. Its body is plain text: what an admin types is
 * shown as typed, never as HTML.
 */
const announceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

const announceSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(8000),
});

// POST /api/admin/notification-email/announce
adminNotificationEmailRouter.post('/announce', announceLimiter, async (req, res) => {
  try {
    const config = serverConfigOf(req);
    const parsed = announceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    const settings = await loadNotificationEmailSettings(config);
    if (!settings.enabled || !settings.product_updates_enabled) {
      return res.status(409).json({ error: 'product_updates_disabled' });
    }

    // Spelled out: without strictNullChecks zod infers both fields as
    // optional, though the schema requires them.
    const { title, body } = parsed.data as { title: string; body: string };
    // The key is what stops a double-click sending two: same title, same
    // body, same hour, one announcement.
    const dedupeKey = `${Math.floor(Date.now() / 3_600_000)}:${createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 32)}`;

    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('notification_email_announcements')
      .insert({ title, body, dedupe_key: dedupeKey, created_by: actorId(req) })
      .select('id, title, status, recipients_queued, created_at, finished_at')
      .single();
    if (error) {
      if (String(error.code) === '23505') {
        const { data: existing } = await sb
          .from('notification_email_announcements')
          .select('id, title, status, recipients_queued, created_at, finished_at')
          .eq('dedupe_key', dedupeKey)
          .maybeSingle();
        return res.json({ queued: true, duplicate: true, announcement: existing, per_hour: ANNOUNCEMENTS_PER_HOUR });
      }
      if (before289c(error)) return res.status(503).json({ error: 'announcements_unavailable' });
      console.error('[notification-email] announcement not saved', { message: error.message });
      return res.status(500).json({ error: 'Failed to send the announcement' });
    }

    return res.json({ queued: true, announcement: data, per_hour: ANNOUNCEMENTS_PER_HOUR });
  } catch (err: unknown) {
    console.error('[notification-email] announcement not saved', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to send the announcement' });
  }
});
