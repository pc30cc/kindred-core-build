/**
 * SUPER ADMIN → MOBILE APP (iOS and Android).
 *
 * Mounted under adminRouter, which already gates `/api/admin/*` behind
 * `requirePlatformAdmin`, so nothing here re-implements authentication.
 *
 * The routes are deliberately thin: the settings row is the product, and the
 * readiness verdicts are computed (never stored), so a value an operator
 * changes is reflected in the checklist on the very next read instead of
 * drifting behind a cached score.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { isPushConfigured } from '../services/push/fcm.js';
import { getApnsCredentialProblem, getApnsCredentials } from '../services/push/apns.js';
import {
  invalidateMobileAppSettingsCache,
  normalize,
  MOBILE_APP_DEFAULTS,
  ANDROID_LANGUAGES,
} from '../services/mobileApp/settings.js';
import { evaluateReadiness, summarize } from '../services/mobileApp/readiness.js';
import { inspectNativeProject } from '../services/mobileApp/project.js';
import { firebaseClientFields, firebaseProjectsMatch } from '../services/mobileApp/firebaseClient.js';
import { androidLanguageMaintenanceFields } from '../services/mobileApp/androidMaintenance.js';
import { readShippedAndroidRelease, withShippedVersion } from '../services/mobileApp/androidRelease.js';
import { adminAppReviewRouter } from './adminAppReview.js';

export const adminMobileAppRouter = Router();

// The account Apple's App Review signs in with (migration 248).
adminMobileAppRouter.use('/app-review', adminAppReviewRouter);

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

/** A link an operator can be sent to for help: a page (https), an email or a phone number. */
const SUPPORT_LINK = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^(https:\/\/|mailto:|tel:)\S+$/i.test(v), 'https, mailto: or tel: required')
  .transform((v) => (v === '' ? null : v))
  .nullable();

/** What Settings → About → Website is called in one language: a few words, blank dropped. */
const WEBSITE_LABEL = z.preprocess(
  (v) => (v == null ? undefined : v),
  z.string().trim().max(40).optional(),
);

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

  android_package_name: z.string().trim().min(3).max(150).regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/).optional(),
  android_app_name: z.string().trim().min(1).max(50).optional(),
  android_play_store_url: HTTPS_URL.optional(),
  android_version_name: z.string().trim().max(30).regex(/^\d+(\.\d+){0,3}([-+][0-9A-Za-z.]+)?$/).optional(),
  android_version_code: z.coerce.number().int().min(1).max(2_100_000_000).optional(),
  android_min_sdk: z.coerce.number().int().min(21).max(99).optional(),
  android_target_sdk: z.coerce.number().int().min(21).max(99).optional(),
  android_release_track: z.enum(['internal', 'closed', 'open', 'production']).optional(),
  android_rollout_percent: z.coerce.number().int().min(1).max(100).optional(),
  // Play caps "What's new" at 500 characters per language.
  android_release_notes: z
    .object({ en: z.string().max(500), fa: z.string().max(500), tr: z.string().max(500) })
    .partial()
    .optional(),

  android_app_show_storage: z.boolean().optional(),
  android_app_show_security: z.boolean().optional(),
  android_app_show_notification_settings: z.boolean().optional(),
  android_app_allow_wallpaper_colors: z.boolean().optional(),
  android_app_profile_name_editable: z.boolean().optional(),
  android_app_profile_phone_editable: z.boolean().optional(),
  android_app_profile_photo_editable: z.boolean().optional(),
  android_app_show_visitors: z.boolean().optional(),
  android_app_show_web_analytics: z.boolean().optional(),
  android_app_show_support: z.boolean().optional(),
  ...firebaseClientFields,
  // The language the app opens in, and the maintenance notice — both read
  // by the app before sign-in (GET /api/mobile-app/public-config).
  ...androidLanguageMaintenanceFields,
  ios_app_show_contacts: z.boolean().optional(),
  ios_app_show_visitors: z.boolean().optional(),
  ios_app_show_web_analytics: z.boolean().optional(),
  ios_app_show_ai_queue: z.boolean().optional(),
  ios_app_show_colleagues: z.boolean().optional(),
  ios_app_show_storage: z.boolean().optional(),
  ios_app_show_support: z.boolean().optional(),
  ios_app_support_url: SUPPORT_LINK.optional(),
  ios_app_website_url: HTTPS_URL.optional(),
  ios_default_language: z.enum(ANDROID_LANGUAGES).optional(),
  ios_app_website_label: z
    .object({ fa: WEBSITE_LABEL, en: WEBSITE_LABEL, tr: WEBSITE_LABEL })
    .transform((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v)) as Record<string, string>)
    .optional(),
}).refine(
  (v) => v.android_min_sdk === undefined || v.android_target_sdk === undefined || v.android_min_sdk <= v.android_target_sdk,
  { message: 'minimum SDK above target SDK', path: ['android_min_sdk'] },
).refine(
  // The app id carries the project number: two values from two different
  // projects would start Firebase against one and register with the other.
  (v) => firebaseProjectsMatch(v.android_firebase_app_id, v.android_firebase_sender_id),
  { message: 'app id and project number are from different Firebase projects', path: ['android_firebase_sender_id'] },
);

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
/** The iOS app's push credentials as this server holds them; never the key itself. */
function apnsStatus(): {
  configured: boolean;
  environment: 'production' | 'sandbox' | null;
  /** Set, but unusable: the key in the environment is not a readable .p8 key. */
  problem: 'invalid_key' | null;
} {
  const creds = getApnsCredentials();
  return {
    configured: Boolean(creds),
    environment: creds ? (creds.sandbox ? 'sandbox' : 'production') : null,
    problem: getApnsCredentialProblem(),
  };
}

function readinessFor(settings: ReturnType<typeof normalize>) {
  const project = inspectNativeProject();
  const apns = apnsStatus();
  const checks = evaluateReadiness({
    settings,
    apnsConfigured: apns.configured,
    apnsKeyInvalid: apns.problem === 'invalid_key',
    apnsSandbox: apns.environment === 'sandbox',
    nativeProjectAvailable: project.available,
    appIconPresent: project.appIcon1024,
    privacyManifestFilePresent: project.privacyManifestFile,
    privacyApiTypes: project.privacyApiTypes,
    privacyDataTypes: project.privacyDataTypes,
    pushEntitlementPresent: project.pushEntitlement,
    backgroundModes: project.backgroundModes,
    // Webyar has no unauthenticated surface in the native shell: the login
    // screen is the first screen, so Apple always needs a demo account.
    requiresLogin: true,
  });
  return { checks, summary: summarize(checks), project, apns };
}

adminMobileAppRouter.get('/settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const config = serverConfigOf(req);
    const row = await readRow(config);
    // The Android version is the one the website hands out: a row that says
    // otherwise is brought up to it, so every reader of the row agrees.
    const shipped = readShippedAndroidRelease();
    if (
      row && shipped &&
      (row.android_version_name !== shipped.versionName || Number(row.android_version_code) !== shipped.versionCode)
    ) {
      await getServiceClient(config)
        .from('mobile_app_settings')
        .update({ android_version_name: shipped.versionName, android_version_code: shipped.versionCode })
        .eq('id', row.id as string);
      invalidateMobileAppSettingsCache();
    }
    const settings = withShippedVersion(row ? normalize(row) : { ...MOBILE_APP_DEFAULTS }, shipped);
    const { checks, summary, project, apns } = readinessFor(settings);
    return res.json({
      settings,
      checks,
      summary,
      environment: {
        // Firebase: the Android app's notifications.
        pushConfigured: isPushConfigured(),
        // APNs: the iOS app's.
        apns,
        nativeProject: project,
        provisioned: Boolean(row),
        androidRelease: shipped,
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
  // The shipped APK decides the Android version; a typed one is ignored.
  const payload = withShippedVersion(
    { ...parsed.data, updated_at: new Date().toISOString() } as typeof parsed.data & {
      updated_at: string;
      android_version_name: string;
      android_version_code: number;
    },
    readShippedAndroidRelease(),
  );
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

