/**
 * SUPER ADMIN → MOBILE APP (iOS).
 *
 * Mounted under adminRouter, which already gates `/api/admin/*` behind
 * `requirePlatformAdmin`, so nothing here re-implements authentication.
 *
 * The routes are deliberately thin: the settings row is the product, and the
 * readiness verdicts are computed (never stored), so a value an operator
 * changes is reflected in the checklist on the very next read instead of
 * drifting behind a cached score.
 *
 * `/generated-config` returns exactly what `scripts/ios/write-runtime-config.mjs`
 * will write into the Xcode project, so an operator can see the Info.plist,
 * entitlements and build settings BEFORE syncing rather than after a failed
 * archive.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { isPushConfigured } from '../services/push/fcm.js';
import {
  loadMobileAppSettings,
  invalidateMobileAppSettingsCache,
  normalize,
  MOBILE_APP_DEFAULTS,
} from '../services/mobileApp/settings.js';
import { evaluateReadiness, summarize } from '../services/mobileApp/readiness.js';
import { inspectNativeProject } from '../services/mobileApp/project.js';
import { buildGeneratedConfig } from '../services/mobileApp/generatedConfig.js';

export const adminMobileAppRouter = Router();

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

const settingsSchema = z.object({
  app_name: z.string().trim().min(1).max(60).optional(),
  display_name: z.string().trim().min(1).max(30).optional(),
  bundle_id: z.string().trim().min(3).max(155).regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/).optional(),
  apple_team_id: z.string().trim().max(20).nullable().optional(),
  apple_team_name: z.string().trim().max(120).nullable().optional(),
  apple_app_id: z.string().trim().max(30).nullable().optional(),
  app_sku: z.string().trim().max(120).nullable().optional(),
  primary_language: z.string().trim().min(2).max(10).optional(),

  marketing_version: z.string().trim().max(20).regex(/^\d+(\.\d+){0,2}$/).optional(),
  build_number: z.coerce.number().int().min(1).max(2_000_000_000).optional(),
  minimum_os_version: z.string().trim().max(10).regex(/^\d+(\.\d+)?$/).optional(),
  device_family: z.enum(['iphone', 'universal']).optional(),
  orientations: z.array(z.enum(['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'])).max(4).optional(),
  requires_full_screen: z.boolean().optional(),
  supports_dark_mode: z.boolean().optional(),
  url_scheme: z.string().trim().max(60).regex(/^[a-z][a-z0-9+.-]*$/i).nullable().optional(),
  associated_domains: z.array(z.string().trim().max(255)).max(20).optional(),
  build_configuration: z.string().trim().max(40).optional(),
  automatic_signing: z.boolean().optional(),
  provisioning_profile: z.string().trim().max(200).nullable().optional(),

  cap_push_notifications: z.boolean().optional(),
  cap_background_remote_notifications: z.boolean().optional(),
  cap_background_fetch: z.boolean().optional(),
  cap_associated_domains: z.boolean().optional(),
  cap_app_groups: z.boolean().optional(),
  app_group_id: z.string().trim().max(160).nullable().optional(),
  cap_keychain_sharing: z.boolean().optional(),
  cap_sign_in_with_apple: z.boolean().optional(),
  cap_camera: z.boolean().optional(),
  cap_microphone: z.boolean().optional(),
  cap_photo_library: z.boolean().optional(),
  cap_location: z.boolean().optional(),
  cap_face_id: z.boolean().optional(),

  usage_camera: z.string().trim().max(500).optional(),
  usage_microphone: z.string().trim().max(500).optional(),
  usage_photo_library: z.string().trim().max(500).optional(),
  usage_photo_library_add: z.string().trim().max(500).nullable().optional(),
  usage_location: z.string().trim().max(500).nullable().optional(),
  usage_face_id: z.string().trim().max(500).nullable().optional(),
  usage_tracking: z.string().trim().max(500).nullable().optional(),

  att_enabled: z.boolean().optional(),
  collects_data: z.boolean().optional(),
  uses_idfa: z.boolean().optional(),
  third_party_sdks: z.array(z.string().trim().max(120)).max(50).optional(),
  privacy_manifest: z.record(z.unknown()).optional(),
  data_collection: z.record(z.unknown()).optional(),

  privacy_policy_url: HTTPS_URL.optional(),
  terms_url: HTTPS_URL.optional(),
  support_url: HTTPS_URL.optional(),
  marketing_url: HTTPS_URL.optional(),
  copyright: z.string().trim().max(200).nullable().optional(),
  primary_category: z.string().trim().max(60).optional(),
  secondary_category: z.string().trim().max(60).nullable().optional(),
  age_rating: z.enum(['4+', '9+', '12+', '17+']).optional(),
  contains_third_party_content: z.boolean().optional(),

  ads_enabled: z.boolean().optional(),
  ads_banner: z.record(z.unknown()).optional(),
  ads_fullscreen: z.record(z.unknown()).optional(),
  ads_min_interval_minutes: z.coerce.number().int().min(0).max(10_080).optional(),
  ads_max_per_day: z.coerce.number().int().min(0).max(20).optional(),
  ads_start_after_launches: z.coerce.number().int().min(0).max(50).optional(),
  ads_external_link_acknowledged: z.boolean().optional(),

  review_contact_name: z.string().trim().max(120).nullable().optional(),
  review_contact_email: z.string().trim().max(200).nullable().optional(),
  review_contact_phone: z.string().trim().max(40).nullable().optional(),
  review_notes: z.string().trim().max(4000).nullable().optional(),
  demo_account_required: z.boolean().optional(),
  demo_account_username: z.string().trim().max(200).nullable().optional(),
  demo_account_notes: z.string().trim().max(2000).nullable().optional(),
  account_deletion_supported: z.boolean().optional(),
  account_deletion_url: HTTPS_URL.optional(),

  uses_encryption: z.boolean().optional(),
  encryption_exempt: z.boolean().optional(),
  encryption_notes: z.string().trim().max(2000).nullable().optional(),

  release_type: z.enum(['manual', 'automatic', 'scheduled']).optional(),
  phased_release: z.boolean().optional(),
  testflight_group: z.string().trim().max(120).nullable().optional(),
  release_notes: z.string().trim().max(4000).nullable().optional(),
});

async function readRow(config: ServerConfig) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('mobile_app_settings')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown> | null;
}

/**
 * The readiness verdicts for the CURRENT settings. Computed on every read so
 * a change an operator just saved cannot be masked by a stale score.
 */
function readinessFor(settings: ReturnType<typeof normalize>) {
  const project = inspectNativeProject();
  const checks = evaluateReadiness({
    settings,
    pushConfigured: isPushConfigured(),
    nativeProjectAvailable: project.available,
    googleServicePlistPresent: project.googleServicePlist,
    appIconPresent: project.appIcon1024,
    privacyManifestFilePresent: project.privacyManifestFile,
    // Webyar has no unauthenticated surface in the native shell: the login
    // screen is the first screen, so Apple always needs a demo account.
    requiresLogin: true,
  });
  return { checks, summary: summarize(checks), project };
}

adminMobileAppRouter.get('/settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const row = await readRow(serverConfigOf(req));
    const settings = row ? normalize(row) : { ...MOBILE_APP_DEFAULTS };
    const { checks, summary, project } = readinessFor(settings);
    return res.json({
      settings,
      checks,
      summary,
      environment: {
        pushConfigured: isPushConfigured(),
        nativeProject: project,
        provisioned: Boolean(row),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminMobileAppRouter.put('/settings', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues.map((i) => i.path.join('.')) });
  }
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const payload = { ...parsed.data, updated_at: new Date().toISOString() };
  try {
    const existing = await readRow(config);
    const query = existing
      ? sb.from('mobile_app_settings').update(payload).eq('id', existing.id as string).select('*').single()
      : sb.from('mobile_app_settings').insert(payload).select('*').single();
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    invalidateMobileAppSettingsCache();
    const settings = normalize(data as Record<string, unknown>);
    const { checks, summary } = readinessFor(settings);
    return res.json({ success: true, settings, checks, summary });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

const checklistSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_]+$/),
  done: z.boolean(),
});

/**
 * Acknowledge (or un-acknowledge) a requirement that only a human can verify
 * — screenshots uploaded, age-rating questionnaire answered, tested on a real
 * device. Stored with who and when so the trail survives a handover.
 */
adminMobileAppRouter.post('/checklist', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = checklistSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  try {
    const existing = await readRow(config);
    const current = (existing?.checklist as Record<string, unknown>) ?? {};
    const checklist = {
      ...current,
      [parsed.data.key]: parsed.data.done
        ? { done: true, at: new Date().toISOString(), by: actorId }
        : { done: false },
    };
    const payload = { checklist, updated_at: new Date().toISOString() };
    const query = existing
      ? sb.from('mobile_app_settings').update(payload).eq('id', existing.id as string).select('*').single()
      : sb.from('mobile_app_settings').insert(payload).select('*').single();
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    invalidateMobileAppSettingsCache();
    const settings = normalize(data as Record<string, unknown>);
    const { checks, summary } = readinessFor(settings);
    return res.json({ success: true, settings, checks, summary });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/** Exactly what `npm run ios:sync` will write into the Xcode project. */
adminMobileAppRouter.get('/generated-config', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const settings = await loadMobileAppSettings(serverConfigOf(req));
    return res.json({ config: buildGeneratedConfig(settings) });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
