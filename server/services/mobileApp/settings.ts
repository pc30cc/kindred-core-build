/**
 * NATIVE APP (iOS) PLATFORM SETTINGS.
 *
 * The singleton `mobile_app_settings` row is the one source of truth for the
 * native shell's identity, build, capabilities, privacy strings and App Store
 * metadata. It is read by:
 *   • Super Admin → Mobile App (server/routes/adminMobileApp.ts),
 *   • `npm run ios:runtime-config`, which materialises the generated
 *     Info.plist / entitlements / capacitor values before `cap sync`.
 *
 * Nothing about the WEB build reads this row — a deployment that never ships
 * a native app is unaffected by every value here.
 *
 * Never throws: a missing row or a read failure resolves to DEFAULTS, which
 * reproduce the values that were hardcoded in ios/App/App/Info.plist before
 * this table existed.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

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

  // ─── In-app promotions (iOS) ───
  //
  // First-party only. The platform writes the creative; nothing is fetched
  // from an ad network, no identifier leaves the device and no impression is
  // reported anywhere — which is what keeps this outside App Tracking
  // Transparency entirely (guideline 5.1.2 and the ATT rules) rather than
  // relying on a prompt nobody accepts.
  //
  // WHICH workspaces see a promotion is a plan decision, not a platform one:
  // `mobile_promo_banner` and `mobile_promo_fullscreen` in the capability
  // registry. This row only decides whether the feature exists at all and
  // what it says.
  ads_enabled: boolean;
  /// `{ cta_url, image_url, text: { en|fa|tr: { title, body, cta_label } } }`
  ads_banner: Record<string, unknown>;
  ads_fullscreen: Record<string, unknown>;
  /// Never twice inside this many minutes, and never more than this in a day.
  ads_min_interval_minutes: number;
  ads_max_per_day: number;
  /// Not on a first run. An app that opens onto a full-screen promotion is
  /// both a bad first impression and the sort of thing review pushes back on.
  ads_start_after_launches: number;
  /// A promotion whose button leaves the app for somewhere a subscription can
  /// be bought needs Apple's External Purchase Link Entitlement (3.1.1 and
  /// 3.1.3). Until a human says that is in order, the server serves the
  /// creative without its link rather than trusting the URL.
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

  checklist: Record<string, { done: boolean; at?: string; by?: string }>;
  updated_at?: string | null;
}

export const MOBILE_APP_DEFAULTS: MobileAppSettings = {
  app_name: 'Webyar',
  display_name: 'Webyar',
  bundle_id: 'com.webyar.app',
  apple_team_id: null,
  apple_team_name: null,
  apple_app_id: null,
  app_sku: null,
  primary_language: 'en',

  marketing_version: '1.0.0',
  build_number: 1,
  minimum_os_version: '14.0',
  device_family: 'iphone',
  orientations: ['portrait'],
  requires_full_screen: false,
  supports_dark_mode: true,
  url_scheme: null,
  associated_domains: [],
  build_configuration: 'Release',
  automatic_signing: true,
  provisioning_profile: null,

  cap_push_notifications: true,
  cap_background_remote_notifications: true,
  cap_background_fetch: false,
  cap_associated_domains: false,
  cap_app_groups: false,
  app_group_id: null,
  cap_keychain_sharing: false,
  cap_sign_in_with_apple: false,
  cap_camera: true,
  cap_microphone: true,
  cap_photo_library: true,
  cap_location: false,
  cap_face_id: false,

  usage_camera:
    'Webyar needs camera access so you can capture and send photos or videos in a conversation.',
  usage_microphone:
    'Webyar needs microphone access so you can record and send voice messages to your customers.',
  usage_photo_library:
    'Webyar needs photo library access so you can send images and videos in a conversation.',
  usage_photo_library_add: null,
  usage_location: null,
  usage_face_id: null,
  usage_tracking: null,

  att_enabled: false,
  collects_data: true,
  uses_idfa: false,
  third_party_sdks: ['Firebase Cloud Messaging'],
  privacy_manifest: {},
  data_collection: {},

  privacy_policy_url: null,
  terms_url: null,
  support_url: null,
  marketing_url: null,
  copyright: null,
  primary_category: 'BUSINESS',
  secondary_category: null,
  age_rating: '4+',
  contains_third_party_content: false,

  ads_enabled: false,
  ads_banner: {},
  ads_fullscreen: {},
  ads_min_interval_minutes: 360,
  ads_max_per_day: 3,
  ads_start_after_launches: 2,
  ads_external_link_acknowledged: false,

  review_contact_name: null,
  review_contact_email: null,
  review_contact_phone: null,
  review_notes: null,
  demo_account_required: true,
  demo_account_username: null,
  demo_account_notes: null,
  account_deletion_supported: true,
  account_deletion_url: null,

  uses_encryption: true,
  encryption_exempt: true,
  encryption_notes: null,

  release_type: 'manual',
  phased_release: true,
  testflight_group: null,
  release_notes: null,

  checklist: {},
  updated_at: null,
};

const CACHE_TTL_MS = 30_000;
let cache: { value: MobileAppSettings; ts: number } | null = null;

/** Test/route seam: drop the memoized row after a write. */
export function invalidateMobileAppSettingsCache(): void {
  cache = null;
}

export async function loadMobileAppSettings(config: ServerConfig): Promise<MobileAppSettings> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value;

  let value = MOBILE_APP_DEFAULTS;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('mobile_app_settings')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!error && data) value = normalize(data as Record<string, unknown>);
  } catch {
    // A deployment that has not applied migration 195 yet still boots.
  }
  cache = { value, ts: now };
  return value;
}

/** Fills every missing field from DEFAULTS so callers never see undefined. */
export function normalize(row: Record<string, unknown>): MobileAppSettings {
  const out = { ...MOBILE_APP_DEFAULTS } as Record<string, unknown>;
  for (const key of Object.keys(MOBILE_APP_DEFAULTS) as (keyof MobileAppSettings)[]) {
    const raw = row[key];
    if (raw === undefined || raw === null) continue;
    out[key] = raw;
  }
  out.orientations = Array.isArray(row.orientations)
    ? (row.orientations as string[])
    : MOBILE_APP_DEFAULTS.orientations;
  out.associated_domains = Array.isArray(row.associated_domains)
    ? (row.associated_domains as string[])
    : [];
  out.third_party_sdks = Array.isArray(row.third_party_sdks)
    ? (row.third_party_sdks as string[])
    : MOBILE_APP_DEFAULTS.third_party_sdks;
  out.build_number = Number(row.build_number ?? MOBILE_APP_DEFAULTS.build_number) || 1;
  out.updated_at = (row.updated_at as string | null) ?? null;
  return out as unknown as MobileAppSettings;
}
