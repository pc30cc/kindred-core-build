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

export interface MobileAppPayload {
  settings: MobileAppSettings;
  checks: ReadinessCheck[];
  summary: ReadinessSummary;
  environment: {
    pushConfigured: boolean;
    nativeProject: {
      available: boolean;
      googleServicePlist: boolean;
      appIcon1024: boolean;
      privacyManifestFile: boolean;
      entitlementsFile: boolean;
    };
    provisioned: boolean;
  };
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
