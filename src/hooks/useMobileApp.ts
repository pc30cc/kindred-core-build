/**
 * Super Admin → Mobile App data access.
 *
 * One query for the settings row and its readiness verdicts (they are
 * computed server-side on every read, so a save and its new score arrive
 * together and can never disagree), plus mutations that write the settings
 * and acknowledge the manual requirements.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/hooks/useAdmin';

export type CheckStatus = 'pass' | 'fail' | 'manual';
export type CheckSeverity = 'blocker' | 'warning' | 'info';
export type CheckGroup =
  | 'identity'
  | 'build'
  | 'privacy'
  | 'account'
  | 'review'
  | 'store'
  | 'push'
  | 'compliance'
  | 'technical';

export interface ReadinessCheck {
  id: string;
  group: CheckGroup;
  severity: CheckSeverity;
  status: CheckStatus;
  evidence?: string;
  guideline?: string;
}

export interface ReadinessSummary {
  total: number;
  passed: number;
  failed: number;
  manual: number;
  blockers: number;
  score: number;
  submittable: boolean;
}

/** The languages the Android app is written in, Persian first — the one it starts in. */
export const ANDROID_LANGUAGES = ['fa', 'en', 'tr'] as const;
export type AndroidLanguage = (typeof ANDROID_LANGUAGES)[number];
/** Per language; the server refuses a longer maintenance message. */
export const ANDROID_MAINTENANCE_MESSAGE_MAX = 500;

export interface MobileAppSettings {
  app_name: string;
  display_name: string;
  bundle_id: string;
  apple_team_id: string | null;
  apple_team_name: string | null;
  apple_app_id: string | null;
  app_sku: string | null;
  primary_language: string;

  marketing_version: string;
  build_number: number;
  minimum_os_version: string;
  device_family: 'iphone' | 'universal';
  orientations: string[];
  requires_full_screen: boolean;
  supports_dark_mode: boolean;
  url_scheme: string | null;
  associated_domains: string[];
  build_configuration: string;
  automatic_signing: boolean;
  provisioning_profile: string | null;

  cap_push_notifications: boolean;
  cap_background_remote_notifications: boolean;
  cap_background_fetch: boolean;
  cap_associated_domains: boolean;
  cap_app_groups: boolean;
  app_group_id: string | null;
  cap_keychain_sharing: boolean;
  cap_sign_in_with_apple: boolean;
  cap_camera: boolean;
  cap_microphone: boolean;
  cap_photo_library: boolean;
  cap_location: boolean;
  cap_face_id: boolean;

  usage_camera: string;
  usage_microphone: string;
  usage_photo_library: string;
  usage_photo_library_add: string | null;
  usage_location: string | null;
  usage_face_id: string | null;
  usage_tracking: string | null;

  att_enabled: boolean;
  collects_data: boolean;
  uses_idfa: boolean;
  third_party_sdks: string[];
  privacy_manifest: Record<string, unknown>;
  data_collection: Record<string, unknown>;

  privacy_policy_url: string | null;
  terms_url: string | null;
  support_url: string | null;
  marketing_url: string | null;
  copyright: string | null;
  primary_category: string;
  secondary_category: string | null;
  age_rating: string;
  contains_third_party_content: boolean;

  /** First-party in-app promotions. See MobilePromotionsTab for the rules. */
  ads_enabled: boolean;
  ads_banner: Record<string, unknown>;
  ads_fullscreen: Record<string, unknown>;
  ads_min_interval_minutes: number;
  ads_max_per_day: number;
  ads_start_after_launches: number;
  ads_external_link_acknowledged: boolean;

  review_contact_name: string | null;
  review_contact_email: string | null;
  review_contact_phone: string | null;
  review_notes: string | null;
  demo_account_required: boolean;
  demo_account_username: string | null;
  demo_account_notes: string | null;
  account_deletion_supported: boolean;
  account_deletion_url: string | null;

  uses_encryption: boolean;
  encryption_exempt: boolean;
  encryption_notes: string | null;

  release_type: 'manual' | 'automatic' | 'scheduled';
  phased_release: boolean;
  testflight_group: string | null;
  release_notes: string | null;

  /** Android: the Play Console record — nothing reads these at runtime. */
  android_package_name: string;
  android_app_name: string;
  android_play_store_url: string | null;
  android_version_name: string;
  android_version_code: number;
  android_min_sdk: number;
  android_target_sdk: number;
  android_release_track: 'internal' | 'closed' | 'open' | 'production';
  android_rollout_percent: number;
  android_release_notes: Partial<Record<'en' | 'fa' | 'tr', string>>;

  /** Android: in-app switches, read live by the installed app (GET /api/mobile-app/config). */
  android_app_show_storage: boolean;
  android_app_show_security: boolean;
  android_app_show_notification_settings: boolean;
  android_app_allow_wallpaper_colors: boolean;
  android_app_profile_name_editable: boolean;
  android_app_profile_phone_editable: boolean;
  android_app_profile_photo_editable: boolean;
  android_app_show_visitors: boolean;
  android_app_show_web_analytics: boolean;
  android_app_show_support: boolean;
  // Firebase's client identifiers for the Android package (google-services.json).
  android_firebase_app_id: string | null;
  android_firebase_api_key: string | null;
  android_firebase_project_id: string | null;
  android_firebase_sender_id: string | null;
  /**
   * Android: read by the app before sign-in (GET /api/mobile-app/public-config).
   * The language it opens in until the operator picks one, and a maintenance
   * notice that, while on and before `android_maintenance_until`, keeps
   * everyone out of the app. A missing message language falls back to the
   * app's own wording.
   */
  android_default_language: AndroidLanguage;
  android_maintenance_enabled: boolean;
  android_maintenance_message: Partial<Record<AndroidLanguage, string>>;
  android_maintenance_until: string | null;
  ios_app_show_contacts: boolean;
  ios_app_show_visitors: boolean;
  ios_app_show_web_analytics: boolean;
  ios_app_show_ai_queue: boolean;
  ios_app_show_colleagues: boolean;
  ios_app_show_storage: boolean;
  ios_app_show_support: boolean;
  ios_app_support_url: string | null;
  /** Settings → About → Website: its https address, and its name per language (migration 246). */
  ios_app_website_url: string | null;
  ios_app_website_label: Partial<Record<AndroidLanguage, string>>;
  /** The language the iOS app opens in until the operator picks one (migration 247). */
  ios_default_language: AndroidLanguage;

  checklist: Record<string, { done: boolean; at?: string; by?: string }>;
  updated_at?: string | null;
}

export interface MobileAppPayload {
  settings: MobileAppSettings;
  checks: ReadinessCheck[];
  summary: ReadinessSummary;
  environment: {
    /** Firebase credentials: the Android app's notifications. */
    pushConfigured: boolean;
    /** APNs credentials: the iOS app's notifications. */
    apns: { configured: boolean; environment: 'production' | 'sandbox' | null };
    /** The native iOS project (ios/WebyarNative), as shipped with this deployment. */
    nativeProject: {
      available: boolean;
      appIcon1024: boolean;
      privacyManifestFile: boolean;
      pushEntitlement: boolean;
      backgroundModes: string[];
      source: 'checkout' | 'snapshot' | 'none';
    };
    provisioned: boolean;
    /**
     * The APK the website hands out (public/downloads/Webyar-Android.json);
     * when present, the Android version is this one and is not typed.
     */
    androidRelease?: ShippedAndroidRelease | null;
  };
}

export interface ShippedAndroidRelease {
  versionName: string;
  versionCode: number;
  sha256: string;
  sizeBytes: number;
  releasedAt: string | null;
}

export interface GeneratedConfig {
  infoPlist: Record<string, unknown>;
  entitlements: Record<string, unknown>;
  privacyManifest: Record<string, unknown>;
  xcconfig: Record<string, string>;
  commands: string[];
}

const KEY = ['admin', 'mobile-app'] as const;

export function useMobileAppSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => adminFetch<MobileAppPayload>('/api/admin/mobile-app/settings'),
  });
}

export function useSaveMobileAppSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<MobileAppSettings>) =>
      adminFetch<MobileAppPayload & { success: boolean }>('/api/admin/mobile-app/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      // The response already carries the recomputed verdicts — patch the cache
      // instead of refetching so the score never lags a save.
      qc.setQueryData(KEY, (previous: MobileAppPayload | undefined) =>
        previous
          ? { ...previous, settings: data.settings, checks: data.checks, summary: data.summary }
          : previous,
      );
    },
  });
}

export function useAcknowledgeRequirement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; done: boolean }) =>
      adminFetch<MobileAppPayload & { success: boolean }>('/api/admin/mobile-app/checklist', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      qc.setQueryData(KEY, (previous: MobileAppPayload | undefined) =>
        previous
          ? { ...previous, settings: data.settings, checks: data.checks, summary: data.summary }
          : previous,
      );
    },
  });
}

export function useGeneratedConfig(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'generated-config'],
    enabled,
    queryFn: async () => {
      const body = await adminFetch<{ config: GeneratedConfig }>(
        '/api/admin/mobile-app/generated-config',
      );
      return body.config;
    },
  });
}

// ── The account Apple's App Review signs in with (migration 248) ─────────────

export interface AppReviewAccount {
  email: string;
  exists: boolean;
  enabled: boolean;
  user_id: string | null;
  full_name: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  seeded_at: string | null;
}

const APP_REVIEW_KEY = ['admin-mobile-app', 'app-review'] as const;

export function useAppReviewAccount() {
  return useQuery({
    queryKey: APP_REVIEW_KEY,
    queryFn: () => adminFetch<AppReviewAccount>('/api/admin/mobile-app/app-review'),
  });
}

export function useSeedAppReviewAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { password?: string }) =>
      adminFetch<AppReviewAccount>('/api/admin/mobile-app/app-review/seed', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      qc.setQueryData(APP_REVIEW_KEY, data);
      // The seed also fills in the demo username on the App Store record.
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useSetAppReviewEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      adminFetch<AppReviewAccount>('/api/admin/mobile-app/app-review/enabled', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (data) => qc.setQueryData(APP_REVIEW_KEY, data),
  });
}
