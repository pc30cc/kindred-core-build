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
 * The provider is stored the same way the platform's default transport is,
 * in `app_runtime_config`, under its own key — so a burst of digests cannot
 * cost the platform the sending reputation its password resets depend on.
 */
import { Router } from 'express';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  invalidateNotificationEmailSettingsCache,
  loadNotificationEmailSettings,
  normalizeNotificationEmailSettings,
  SETTINGS_COLUMNS,
} from '../services/notificationEmail/settings.js';
import { OVERRIDE_PROVIDER_KEY, dispatchNotificationEmails } from '../services/notificationEmail/dispatcher.js';
import { queueProductUpdate } from '../services/notificationEmail/producers.js';
import { NOTIFICATION_EMAILS, NOTIFICATION_EMAIL_TYPES } from '../services/notificationEmail/types.js';

export const adminNotificationEmailRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

function actorId(req: Request): string | null {
  const auth = (req as unknown as { authUser?: { id?: string }; userId?: string });
  return auth.authUser?.id ?? auth.userId ?? null;
}

/** The providers `services/email/index.ts` knows how to talk to. */
const PROVIDERS = ['resend', 'sendgrid', 'smtp'] as const;

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  unread_messages_enabled: z.boolean().optional(),
  transcripts_enabled: z.boolean().optional(),
  paid_invoices_enabled: z.boolean().optional(),
  weekly_summary_enabled: z.boolean().optional(),
  product_updates_enabled: z.boolean().optional(),
  // Null is "use the platform default", which is a real choice and not a
  // missing value.
  provider_override: z.enum(PROVIDERS).nullable().optional(),
  unread_after_minutes: z.number().int().min(5).max(1440).optional(),
  digest_every_minutes: z.number().int().min(15).max(1440).optional(),
  weekly_summary_dow: z.number().int().min(0).max(6).optional(),
  weekly_summary_hour: z.number().int().min(0).max(23).optional(),
});

// GET /api/admin/notification-email
adminNotificationEmailRouter.get('/', async (req, res) => {
  try {
    const config = serverConfigOf(req);
    const settings = await loadNotificationEmailSettings(config);
    const sb = getServiceClient(config);

    // Whether the override actually has credentials behind it. An admin who
    // picks a provider and never fills its key would otherwise see a chosen
    // provider and wonder why the mail still goes out the default one.
    const { data: overrideRow } = await sb
      .from('app_runtime_config')
      .select('value')
      .eq('key', OVERRIDE_PROVIDER_KEY)
      .maybeSingle();
    const overrideValue = (overrideRow as { value?: Record<string, unknown> } | null)?.value ?? null;

    return res.json({
      settings,
      providers: PROVIDERS,
      provider_configured: Boolean(overrideValue && Object.keys(overrideValue).length),
      // The catalogue, so the console never hardcodes a list that can drift
      // from the one the server enforces.
      types: NOTIFICATION_EMAIL_TYPES.map((type) => ({
        type,
        slug: NOTIFICATION_EMAILS[type].slug,
        audience: NOTIFICATION_EMAILS[type].audience,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to load settings' });
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
    if (error) return res.status(500).json({ error: error.message });

    invalidateNotificationEmailSettingsCache();
    return res.json({ settings: normalizeNotificationEmailSettings(data) });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to update settings' });
  }
});

/**
 * The announcement.
 *
 * Rate limited hard, because it is the one endpoint here that reaches every
 * operator on the platform at once. Bounded by the platform switch AND by
 * each operator's own preference, like everything else.
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

    // The id is what stops a double-click sending two copies: same title,
    // same body, same hour, same key, and the queue's index refuses the
    // second.
    const announcementId = `${Math.floor(Date.now() / 3_600_000)}:${hash(parsed.data.title + parsed.data.body)}`;
    const queued = await queueProductUpdate(config, { ...parsed.data, announcementId });

    // Straight into a dispatch pass rather than waiting for the ticker: an
    // admin who pressed send is watching.
    const sent = await dispatchNotificationEmails(config);

    return res.json({ queued, dispatched: sent });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to send the announcement' });
  }
});

function hash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
