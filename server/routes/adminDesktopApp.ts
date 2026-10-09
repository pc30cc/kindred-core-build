/**
 * SUPER ADMIN → DESKTOP APP (WINDOWS).
 *
 * Mounted under adminRouter, which already gates `/api/admin/*` behind
 * `requirePlatformAdmin`, so nothing here re-implements authentication.
 *
 * The settings row is the product: where the desktop app looks for updates,
 * which channel it follows, the minimum version still supported, and its
 * runtime tuning. The desktop app itself reads the public projection of this
 * row from GET /api/platform/desktop-app (server/routes/desktopAppPublic.ts),
 * whose cache is dropped on every save here.
 *
 * Each edition has its own row and its own ads and announcements (migration
 * 257, server/services/editionSettings.ts): every read and write here is the
 * running edition's, and answers 503 while the edition cannot be told.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import {
  invalidateDesktopAppSettingsCache,
  normalize,
  DESKTOP_APP_BOUNDS,
  desktopAppDefaults,
  desktopDefaultFeedUrl,
  desktopInsertDefaults,
  desktopSettingsForEdition,
} from '../services/desktopApp/settings.js';
import { getPlatformEdition } from '../services/platformRegion.js';
import { readEditionSettingsRow, respondEditionUnavailable, saveEditionSettingsRow } from '../services/editionSettings.js';
import { invalidateDesktopAppPublicCache } from './desktopAppPublic.js';
import {
  CAMPAIGN_LOCALES,
  CAMPAIGN_SEVERITIES,
  DESKTOP_PLACEMENTS,
  invalidateCampaignCache,
  targetsPlatform,
} from '../services/desktopApp/campaigns.js';
import {
  addBroadcast,
  listBroadcasts,
  removeBroadcast,
  summary,
  DESKTOP_PLATFORMS,
  type DesktopPlatform,
} from '../services/desktopApp/live.js';

export const adminDesktopAppRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

const HTTPS_URL = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^https:\/\//i.test(v), 'https required')
  .transform((v) => (v === '' ? null : v))
  .nullable();

/** `1.2.3` or `1.2.3-beta.1`; an empty string clears the value. */
const VERSION = z
  .string()
  .trim()
  .max(40)
  .refine((v) => v === '' || /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v), 'semver required')
  .transform((v) => (v === '' ? null : v))
  .nullable();

const boundedInt = (key: keyof typeof DESKTOP_APP_BOUNDS) =>
  z.coerce.number().int().min(DESKTOP_APP_BOUNDS[key].min).max(DESKTOP_APP_BOUNDS[key].max);

export const desktopAppSettingsSchema = z.object({
  update_feed_url: HTTPS_URL.optional(),
  update_channel: z.enum(['stable', 'beta']).optional(),
  latest_version: VERSION.optional(),
  minimum_supported_version: VERSION.optional(),
  download_url: HTTPS_URL.optional(),
  release_notes: z.string().trim().max(4000).nullable().optional(),
  auto_update_enabled: z.boolean().optional(),
  update_check_interval_minutes: boundedInt('update_check_interval_minutes').optional(),

  realtime_enabled: z.boolean().optional(),
  poll_interval_seconds: boundedInt('poll_interval_seconds').optional(),
  poll_interval_realtime_seconds: boundedInt('poll_interval_realtime_seconds').optional(),
  calls_enabled: z.boolean().optional(),
  storage_settings_visible: z.boolean().optional(),
  contacts_enabled: z.boolean().optional(),
  visitors_enabled: z.boolean().optional(),
  analytics_enabled: z.boolean().optional(),
  call_center_enabled: z.boolean().optional(),
});

adminDesktopAppRouter.get('/settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const config = serverConfigOf(req);
    const edition = await getPlatformEdition(config);
    const row = await readEditionSettingsRow(config, 'desktop_app_settings', edition);
    const settings = row ? desktopSettingsForEdition(normalize(row), edition) : { ...desktopAppDefaults(edition) };
    return res.json({ settings });
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminDesktopAppRouter.put('/settings', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = desktopAppSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(invalidInput(parsed.error));
  }
  const config = serverConfigOf(req);
  const payload: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  try {
    // Never written into a guessed edition: unknown answers 503.
    const edition = await getPlatformEdition(config);
    // The feed URL is the updater's only lifeline: clearing it restores the
    // default release feed rather than leaving the app nowhere to look.
    if (payload.update_feed_url === null) payload.update_feed_url = desktopDefaultFeedUrl(edition);
    const existing = await readEditionSettingsRow(config, 'desktop_app_settings', edition);
    const { data, error } = await saveEditionSettingsRow(
      config, 'desktop_app_settings', edition, existing, payload, desktopInsertDefaults(edition),
    );
    if (error) return res.status(500).json({ error: error.message });
    invalidateDesktopAppSettingsCache();
    invalidateDesktopAppPublicCache();
    const settings = desktopSettingsForEdition(normalize(data as Record<string, unknown>), edition);
    return res.json({ success: true, settings });
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ── Ads & announcements ─────────────────────────────────────────────────

/** Limits shared with the admin form (src/components/admin/desktop/DesktopCampaignsTab.tsx). */
export const CAMPAIGN_LIMITS = { name: 200, title: 200, body: 2000, cta_label: 60 } as const;

/** Optional copy: null and blanks are treated as "not set" rather than rejected. */
const optionalText = (max: number) =>
  z.preprocess((v) => (v == null ? undefined : v), z.string().trim().max(max).optional());

const localeText = z
  .object({
    title: optionalText(CAMPAIGN_LIMITS.title),
    body: optionalText(CAMPAIGN_LIMITS.body),
    cta_label: optionalText(CAMPAIGN_LIMITS.cta_label),
  })
  .partial();

/**
 * A link or image address. A bare domain ("webyar.ai/pricing") gets
 * `https://` in front; anything with another scheme (http:, javascript:)
 * is refused, since the desktop app only opens secure links.
 */
export const OPTIONAL_HTTPS = z
  .preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      const t = v.trim();
      if (t === '' || /^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
      return `https://${t.replace(/^\/+/, '')}`;
    },
    z
      .string()
      .max(2000)
      .refine((v) => v === '' || /^https:\/\/[^\s/?#]+\.[^\s]+$/i.test(v), 'must be an https:// address')
      .transform((v) => (v === '' ? null : v))
      .nullable(),
  );

const WHEN = z
  .string()
  .trim()
  .refine((v) => v === '' || !Number.isNaN(Date.parse(v)), 'must be a date')
  .transform((v) => (v === '' ? null : new Date(v).toISOString()))
  .nullable();

const localeMap = z
  .object(Object.fromEntries(CAMPAIGN_LOCALES.map((l) => [l, localeText.nullish()])) as Record<(typeof CAMPAIGN_LOCALES)[number], z.ZodOptional<z.ZodNullable<typeof localeText>>>)
  .transform((text) => Object.fromEntries(Object.entries(text).filter(([, v]) => v != null)));

export const campaignSchema = z.object({
  kind: z.enum(['ad', 'announcement']),
  name: optionalText(CAMPAIGN_LIMITS.name).transform((v) => v ?? ''),
  placements: z.array(z.enum(DESKTOP_PLACEMENTS)).min(1, 'choose at least one placement'),
  /// Which desktop apps show it; empty means both.
  platforms: z
    .array(z.enum(DESKTOP_PLATFORMS))
    .max(DESKTOP_PLATFORMS.length)
    .default([])
    .transform((list) => [...new Set(list)]),
  target_plans: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  text: localeMap,
  image_url: OPTIONAL_HTTPS.optional(),
  cta_url: OPTIONAL_HTTPS.optional(),
  severity: z.enum(CAMPAIGN_SEVERITIES).default('info'),
  dismissible: z.boolean().default(true),
  priority: z.coerce.number().int().min(-100).max(100).default(0),
  active: z.boolean().default(true),
  starts_at: WHEN.optional(),
  ends_at: WHEN.optional(),
}).refine((c) => !c.starts_at || !c.ends_at || c.ends_at > c.starts_at, {
  message: 'end must be after start',
  path: ['ends_at'],
});

/** The partial schema used by PUT: every field optional, same rules. */
export const campaignPatchSchema = campaignSchema.innerType().partial();

/** 400 body naming each rejected field, e.g. "text.fa.title: too long (max 200)". */
export function invalidInput(error: z.ZodError) {
  const issues = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const detail = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
  return { error: detail ? `Invalid input — ${detail}` : 'Invalid input', issues };
}

/** `?platform=windows|macos` narrows a list to what that app shows; anything else means all. */
function platformQuery(raw: unknown): DesktopPlatform | undefined {
  return (DESKTOP_PLATFORMS as readonly string[]).includes(String(raw)) ? (raw as DesktopPlatform) : undefined;
}

// Each edition's own ads and announcements: listed, created, changed and
// deleted only within the running edition, so a known id of the other
// edition's campaign changes nothing (404 / no-op).

adminDesktopAppRouter.get('/campaigns', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const platform = platformQuery(req.query.platform);
  const config = serverConfigOf(req);
  try {
    const edition = await getPlatformEdition(config);
    const { data, error } = await getServiceClient(config)
      .from('desktop_app_campaigns')
      .select('*')
      .eq('edition', edition)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const rows = (data ?? []) as Array<{ platforms?: string[] | null }>;
    const campaigns = platform ? rows.filter((r) => targetsPlatform(r, platform)) : rows;
    return res.json({ campaigns, placements: DESKTOP_PLACEMENTS, platforms: DESKTOP_PLATFORMS });
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminDesktopAppRouter.post('/campaigns', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(invalidInput(parsed.error));
  }
  const config = serverConfigOf(req);
  try {
    const edition = await getPlatformEdition(config);
    const { data, error } = await getServiceClient(config)
      .from('desktop_app_campaigns')
      .insert({ ...parsed.data, edition })
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    invalidateCampaignCache();
    return res.json({ success: true, campaign: data });
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminDesktopAppRouter.put('/campaigns/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid id' });
  const parsed = campaignPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(invalidInput(parsed.error));
  }
  const config = serverConfigOf(req);
  try {
    const edition = await getPlatformEdition(config);
    const { data, error } = await getServiceClient(config)
      .from('desktop_app_campaigns')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('edition', edition)
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Not found' });
    invalidateCampaignCache();
    return res.json({ success: true, campaign: data });
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminDesktopAppRouter.delete('/campaigns/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid id' });
  const config = serverConfigOf(req);
  try {
    const edition = await getPlatformEdition(config);
    const { error } = await getServiceClient(config)
      .from('desktop_app_campaigns')
      .delete()
      .eq('id', req.params.id)
      .eq('edition', edition);
    if (error) return res.status(500).json({ error: error.message });
    invalidateCampaignCache();
    return res.json({ success: true });
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ── Live usage and broadcasts (memory only, see services/desktopApp/live.ts) ──

adminDesktopAppRouter.get('/live', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const platform = platformQuery(req.query.platform);
  return res.json({ live: summary(platform), broadcasts: listBroadcasts(platform) });
});

const broadcastSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(600).default(''),
  severity: z.enum(CAMPAIGN_SEVERITIES).default('info'),
  url: OPTIONAL_HTTPS.optional(),
  /// Which desktop apps receive it; empty means both.
  platforms: z.array(z.enum(DESKTOP_PLATFORMS)).max(DESKTOP_PLATFORMS.length).default([]),
});

adminDesktopAppRouter.post('/broadcasts', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = broadcastSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(invalidInput(parsed.error));
  }
  const d = parsed.data;
  const b = addBroadcast({
    title: d.title ?? '',
    body: d.body ?? '',
    severity: d.severity ?? 'info',
    url: d.url ?? null,
    platforms: d.platforms ?? [],
    createdBy: actorId,
  });
  return res.json({ success: true, broadcast: b, live: summary(platformQuery(req.query.platform)) });
});

adminDesktopAppRouter.delete('/broadcasts/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  return res.json({ success: removeBroadcast(String(req.params.id)) });
});
