/**
 * SUPER ADMIN → macOS APP.
 *
 * Mounted under adminRouter, which already gates `/api/admin/*` behind
 * `requirePlatformAdmin`; each handler still checks, as the Windows router
 * does, so the router is safe wherever it is mounted.
 *
 *   GET /api/admin/macos-app/settings → { settings }
 *   PUT /api/admin/macos-app/settings   partial patch → { success, settings }
 *
 * The Mac app reads the public projection of this row from
 * GET /api/platform/macos-app, whose cache is dropped on every save here.
 * Ads, announcements, live usage and broadcasts are shared with the Windows
 * app under /api/admin/desktop-app, targeted per platform.
 *
 * Each edition has its own row (migration 257, server/services/
 * editionSettings.ts): both routes read and write the running edition's, and
 * answer 503 while the edition cannot be told.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import {
  invalidateMacosAppSettingsCache,
  normalizeMacos,
  MACOS_APP_BOUNDS,
  MACOS_MAX_BLOCKED_VERSIONS,
  VERSION_RE,
  macosAppDefaults,
  macosDefaultAppcastUrl,
  macosInsertDefaults,
  macosSettingsForEdition,
} from '../services/desktopApp/macosSettings.js';
import { getPlatformEdition } from '../services/platformRegion.js';
import { readEditionSettingsRow, respondEditionUnavailable, saveEditionSettingsRow } from '../services/editionSettings.js';
import { invalidateMacosAppPublicCache } from './desktopAppPublic.js';
import { invalidInput } from './adminDesktopApp.js';

export const adminMacosAppRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

/** An https:// address; an empty string clears the value. */
const HTTPS_URL = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^https:\/\/[^\s]+$/i.test(v), 'must be an https:// address')
  .transform((v) => (v === '' ? null : v))
  .nullable();

/** `1.2.3` or `1.2.3-beta.1`; an empty string clears the value. */
const VERSION = z
  .string()
  .trim()
  .max(40)
  .refine((v) => v === '' || VERSION_RE.test(v), 'must be a version like 1.4.0')
  .transform((v) => (v === '' ? null : v))
  .nullable();

const boundedInt = (key: keyof typeof MACOS_APP_BOUNDS) =>
  z.coerce.number().int().min(MACOS_APP_BOUNDS[key].min).max(MACOS_APP_BOUNDS[key].max);

const messageText = z.preprocess(
  (v) => (v == null ? undefined : v),
  z.string().trim().max(600).optional(),
);

export const macosAppSettingsSchema = z
  .object({
    appcast_url: HTTPS_URL,
    update_channel: z.enum(['stable', 'beta']),
    latest_version: VERSION,
    minimum_supported_version: VERSION,
    blocked_versions: z
      .array(z.string().trim().regex(VERSION_RE, 'must be a version like 1.4.0'))
      .max(MACOS_MAX_BLOCKED_VERSIONS)
      .transform((list) => [...new Set(list)]),
    download_url: HTTPS_URL,
    release_notes: z.string().trim().max(4000).nullable().transform((v) => (v ? v : null)),
    auto_update_enabled: z.boolean(),
    auto_download_enabled: z.boolean(),
    update_check_interval_minutes: boundedInt('update_check_interval_minutes'),

    realtime_enabled: z.boolean(),
    poll_interval_seconds: boundedInt('poll_interval_seconds'),
    poll_interval_realtime_seconds: boundedInt('poll_interval_realtime_seconds'),

    calls_enabled: z.boolean(),
    video_calls_enabled: z.boolean(),
    email_enabled: z.boolean(),
    visitors_enabled: z.boolean(),
    call_center_enabled: z.boolean(),
    colleagues_enabled: z.boolean(),
    contacts_enabled: z.boolean(),
    voice_notes_enabled: z.boolean(),
    attachments_enabled: z.boolean(),
    web_analytics_enabled: z.boolean(),
    storage_settings_visible: z.boolean(),

    menu_bar_extra_enabled: z.boolean(),
    launch_at_login_enabled: z.boolean(),
    dock_badge_enabled: z.boolean(),
    notifications_enabled: z.boolean(),

    default_language: z.enum(['system', 'fa', 'en', 'tr']),
    default_appearance: z.enum(['system', 'light', 'dark']),
    default_close_to_menu_bar: z.boolean(),
    default_launch_at_login: z.boolean(),

    maintenance_enabled: z.boolean(),
    maintenance_message: z
      .object({ fa: messageText, en: messageText, tr: messageText })
      .transform((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v))),
    maintenance_until: z
      .string()
      .trim()
      .refine((v) => v === '' || !Number.isNaN(Date.parse(v)), 'must be a date')
      .transform((v) => (v === '' ? null : new Date(v).toISOString()))
      .nullable(),

    support_url: HTTPS_URL,
    status_page_url: HTTPS_URL,
    privacy_url: HTTPS_URL,
    terms_url: HTTPS_URL,
  })
  .partial()
  // Relations between fields, checked when both sides are in the patch.
  .refine(
    (s) => !(s.maintenance_enabled && s.maintenance_message && Object.keys(s.maintenance_message).length === 0),
    { message: 'write the maintenance notice in at least one language', path: ['maintenance_message'] },
  );

adminMacosAppRouter.get('/settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const config = serverConfigOf(req);
    const edition = await getPlatformEdition(config);
    const row = await readEditionSettingsRow(config, 'macos_app_settings', edition);
    const settings = row ? macosSettingsForEdition(normalizeMacos(row), edition) : { ...macosAppDefaults(edition) };
    return res.json({ settings });
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminMacosAppRouter.put('/settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = macosAppSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(invalidInput(parsed.error));

  const config = serverConfigOf(req);
  const payload: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  try {
    // Never written into a guessed edition: unknown answers 503.
    const edition = await getPlatformEdition(config);
    // The appcast is the updater's only lifeline: clearing it restores the default feed.
    if (payload.appcast_url === null) payload.appcast_url = macosDefaultAppcastUrl(edition);
    const existing = await readEditionSettingsRow(config, 'macos_app_settings', edition);
    // Maintenance switched on (in this patch or already) needs something to say.
    const merged = normalizeMacos({ ...(existing ?? {}), ...payload });
    if (merged.maintenance_enabled && Object.keys(merged.maintenance_message).length === 0) {
      return res.status(400).json({
        error: 'Invalid input — maintenance_message: write the maintenance notice in at least one language',
        issues: [{ path: 'maintenance_message', message: 'write the maintenance notice in at least one language' }],
      });
    }
    const { data, error } = await saveEditionSettingsRow(
      config, 'macos_app_settings', edition, existing, payload, macosInsertDefaults(edition),
    );
    if (error) return res.status(500).json({ error: error.message });
    invalidateMacosAppSettingsCache();
    invalidateMacosAppPublicCache();
    return res.json({ success: true, settings: macosSettingsForEdition(normalizeMacos(data as Record<string, unknown>), edition) });
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});
