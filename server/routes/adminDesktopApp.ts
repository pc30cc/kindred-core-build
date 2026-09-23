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
  DESKTOP_APP_DEFAULTS,
  DESKTOP_APP_BOUNDS,
} from '../services/desktopApp/settings.js';
import { invalidateDesktopAppPublicCache } from './desktopAppPublic.js';

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
});

async function readRow(config: ServerConfig) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('desktop_app_settings')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown> | null;
}

adminDesktopAppRouter.get('/settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const row = await readRow(serverConfigOf(req));
    const settings = row ? normalize(row) : { ...DESKTOP_APP_DEFAULTS };
    return res.json({ settings });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminDesktopAppRouter.put('/settings', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = desktopAppSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues.map((i) => i.path.join('.')) });
  }
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const payload: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  // The feed URL is the updater's only lifeline: clearing it restores the
  // default release feed rather than leaving the app nowhere to look.
  if (payload.update_feed_url === null) payload.update_feed_url = DESKTOP_APP_DEFAULTS.update_feed_url;
  try {
    const existing = await readRow(config);
    const query = existing
      ? sb.from('desktop_app_settings').update(payload).eq('id', existing.id as string).select('*').single()
      : sb.from('desktop_app_settings').insert(payload).select('*').single();
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    invalidateDesktopAppSettingsCache();
    invalidateDesktopAppPublicCache();
    const settings = normalize(data as Record<string, unknown>);
    return res.json({ success: true, settings });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
